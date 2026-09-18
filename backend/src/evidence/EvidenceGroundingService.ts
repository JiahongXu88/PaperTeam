/**
 * EvidenceGroundingService：Evidence 生命周期编排（M6.5 核心）。
 *
 * 三段核验管道（对齐 CitationIntegrityService 的流水线形态）：
 *   Stage 1  Quote Verification（确定性，本文件 + quoteVerification.ts）
 *            candidate.quote 必须逐字存在于 chunk 原文（轻量归一化）；
 *            失败 → candidate.mismatch（终态）。禁止 LLM 参与本阶段。
 *   Stage 2  Metadata Verification（确定性外部核验，ScholarlyResolver——
 *            与 sourceImport / citationIntegrity 共享同一实例：缓存 / 限速 /
 *            telemetry 一体）。title/DOI/author/year 与外部学术库比对：
 *            mismatch → candidate.mismatch；not_found / unresolved → 如实
 *            记录但不阻塞（D-0023：NOT_FOUND ≠ 检索失败 ≠ 证据问题；
 *            离线部署 resolver 无 provider 时全链路仍可 grounding）。
 *   Stage 3  Semantic Judge（唯一允许 LLM 的阶段；复用 Citation 角色，
 *            scope citation/evidence/<candidateId>，单任务短生命周期）
 *            只喂 claim + quote + chunk 原文；unsupported → candidate.rejected；
 *            无法判断 → unverifiable（不伪造裁决）。
 *
 * 写路径红线：
 * - EvidenceStore 的 grounded 写入只发生在本服务（append/appendBatch）；
 *   Tool / Workflow / Agent 不持有写入口（工具层只拿到只读投影）；
 * - 候选状态转换只经 EvidenceCandidateStore.markResolved；
 * - judge 的 keyQuote 伪造剥离、INSUFFICIENT 降级等守卫沿用 v4/v5 纪律。
 */

import { AgentRunFailedError, BusinessError, EvidenceValidationError } from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { AgentRuntime } from "../runtime/types.js";
import type { ScholarlyResolver } from "../citation/scholarly.js";
import type { SourceMetadata } from "../sources/SourceStore.js";
import type { SourceChunk } from "../retrieval/types.js";
import { ChunkAccess, CHUNK_ID_PATTERN } from "./chunkAccess.js";
import {
  type EvidenceCandidate,
  type EvidenceJudgeVerdict,
  type EvidenceMetadataOutcome,
} from "./candidates.js";
import type { EvidenceCandidateStore } from "./candidates.js";
import type { EvidenceAppendInput, EvidenceStore } from "./EvidenceStore.js";
import { buildEvidenceJudgePrompt, parseEvidenceJudgeOutput } from "./evidenceJudge.js";
import { MIN_NORMALIZED_QUOTE_LENGTH, normalizeForQuoteMatch, verifyQuoteInChunk } from "./quoteVerification.js";

/** 单轮 groundPending 的默认处理上限（bounding：长尾项目不阻塞 workflow stage） */
export const DEFAULT_GROUND_BATCH_LIMIT = 100;

export interface EvidenceProposalInput {
  sourceId: string;
  chunkId: string;
  claim: string;
  quote: string;
  summary?: string;
  /** 提案方标识（角色名 / 角色名:任务；审计用） */
  proposedBy: string;
}

export interface ProposeResult {
  candidate: EvidenceCandidate;
  /** true = 与既有 pending 候选完全同文（chunkId+claim+quote），复用未重复入队 */
  deduplicated: boolean;
}

export type GroundOutcomeStatus = "verified" | "mismatch" | "rejected" | "unverifiable";

export interface GroundResult {
  candidateId: string;
  status: GroundOutcomeStatus;
  /** 原因码 / 简述（quote_not_found_in_chunk / metadata_mismatch / judge_unsupported / …） */
  reason?: string;
  judgeVerdict?: EvidenceJudgeVerdict;
  /** 转正产生的 EvidenceRecord id（status=verified 时存在） */
  evidenceId?: string;
}

export interface GroundPendingSummary {
  pending: number;
  processed: number;
  verified: number;
  mismatch: number;
  rejected: number;
  unverifiable: number;
  evidenceAppended: number;
  results: GroundResult[];
}

export interface EvidenceGroundingServiceOptions {
  projects: ProjectStore;
  candidates: EvidenceCandidateStore;
  evidence: EvidenceStore;
  chunkAccess: ChunkAccess;
  scholarly: ScholarlyResolver;
  /** Stage 3 judge 用的 Runtime（citation 角色）；缺省 → 候选停在 unverifiable(judge_unavailable) */
  runtime?: AgentRuntime;
  citationAgentId?: string;
  /** 逐 run 执行超时覆盖（judge 任务）；缺省沿用 Runtime 默认 */
  runTimeoutMs?: number;
  log?: (message: string) => void;
}

export class EvidenceGroundingService {
  private readonly projects: ProjectStore;
  private readonly candidates: EvidenceCandidateStore;
  private readonly evidence: EvidenceStore;
  private readonly chunkAccess: ChunkAccess;
  private readonly scholarly: ScholarlyResolver;
  private readonly runtime: AgentRuntime | undefined;
  private readonly citationAgentId: string | undefined;
  private readonly log: (message: string) => void;
  private readonly timeoutOverride: { timeoutMs: number } | Record<string, never>;

  constructor(options: EvidenceGroundingServiceOptions) {
    this.projects = options.projects;
    this.candidates = options.candidates;
    this.evidence = options.evidence;
    this.chunkAccess = options.chunkAccess;
    this.scholarly = options.scholarly;
    this.runtime = options.runtime;
    this.citationAgentId = options.citationAgentId;
    this.log = options.log ?? (() => {});
    this.timeoutOverride = options.runTimeoutMs !== undefined ? { timeoutMs: options.runTimeoutMs } : {};
  }

  // ---- 候选提案（propose_evidence 工具与 Researcher JSON 锚定路径共用） ----

  /**
   * 提交证据候选：确定性校验（chunkId 格式 / chunk 存在 / sourceId 一致 /
   * quote 非空且非空洞）通过后入队（status=pending）。不写 EvidenceStore。
   * 完全同文的 pending 候选直接复用（防工具重试 / JSON 与工具双报）。
   */
  async propose(projectId: string, input: EvidenceProposalInput): Promise<ProposeResult> {
    await this.projects.getRequired(projectId);
    const claim = requireText(input.claim, "claim", 4000);
    const quote = requireText(input.quote, "quote", 2000);
    if (normalizeForQuoteMatch(quote).length < MIN_NORMALIZED_QUOTE_LENGTH) {
      throw new EvidenceValidationError(
        `quote 过短（归一化后不足 ${MIN_NORMALIZED_QUOTE_LENGTH} 字符，无法作为逐字核验锚点）`,
      );
    }
    const proposedBy = requireText(input.proposedBy, "proposedBy", 64);
    if (typeof input.chunkId !== "string" || !CHUNK_ID_PATTERN.test(input.chunkId)) {
      throw new BusinessError(
        "INVALID_CHUNK_ID",
        `chunkId 格式非法（应为 <sourceId>:<sectionId>:<序号>:<hash10>，来自 retrieve_library 的 CHUNK 标记）：${String(input.chunkId).slice(0, 80)}`,
      );
    }
    const sourceIdFromChunk = input.chunkId.split(":")[0] ?? "";
    const sourceId = requireText(input.sourceId, "sourceId", 64);
    if (sourceId !== sourceIdFromChunk) {
      throw new EvidenceValidationError(
        `sourceId（${sourceId}）与 chunkId 前缀（${sourceIdFromChunk}）不一致`,
      );
    }
    // chunk 必须真实存在且可回取（quote 校验的锚点）：无效锚点在提案期拒绝
    await this.chunkAccess.resolve(projectId, input.chunkId);

    const existing = await this.candidates.query(projectId, {
      status: "pending",
      chunkId: input.chunkId,
    });
    const duplicate = existing.find(
      (candidate) => candidate.claim === claim && candidate.quote === quote,
    );
    if (duplicate !== undefined) {
      return { candidate: duplicate, deduplicated: true };
    }
    const candidate = await this.candidates.append(projectId, {
      sourceId,
      chunkId: input.chunkId,
      claim,
      quote,
      ...(typeof input.summary === "string" && input.summary.trim() !== ""
        ? { summary: input.summary.trim().slice(0, 2000) }
        : {}),
      proposedBy,
    });
    this.log(
      `[evidence-grounding] projectId=${projectId} 候选入队 ${candidate.candidateId}（${sourceId} / ${input.chunkId.slice(0, 40)}…）`,
    );
    return { candidate, deduplicated: false };
  }

  // ---- 核验 ----

  /** 核验单个候选（只处理 pending；retry=true 允许重试 unverifiable） */
  async ground(
    projectId: string,
    candidateId: string,
    options: { retry?: boolean; signal?: AbortSignal } = {},
  ): Promise<GroundResult> {
    await this.projects.getRequired(projectId);
    const candidate = await this.candidates.get(projectId, candidateId);
    if (candidate === null) {
      throw new BusinessError("NOT_FOUND", `Evidence 候选 ${candidateId} 不存在`);
    }
    if (candidate.status === "verified") {
      // 已转正：幂等返回（不重复 append）
      return {
        candidateId,
        status: "verified",
        evidenceId: candidate.evidenceId,
        ...(candidate.judgeVerdict !== undefined ? { judgeVerdict: candidate.judgeVerdict } : {}),
      };
    }
    if (candidate.status !== "pending" && !(options.retry === true && candidate.status === "unverifiable")) {
      throw new EvidenceValidationError(
        `候选 ${candidateId} 已是终态 ${candidate.status}（mismatch / rejected 不可重试；unverifiable 可用 retry 重试）`,
      );
    }

    // ---- Stage 1：Quote Verification（确定性） ----
    let chunk: SourceChunk;
    let sourceMeta: SourceMetadata;
    let sourceLine: string;
    try {
      const resolved = await this.chunkAccess.resolve(projectId, candidate.chunkId);
      chunk = resolved.chunk;
      sourceMeta = resolved.source.metadata;
      sourceLine = [
        resolved.source.metadata.title ?? resolved.source.sourceId,
        resolved.source.metadata.year !== undefined ? `（${resolved.source.metadata.year}）` : "",
      ].join("");
    } catch (error) {
      // chunk 缺失 / 来源删除 / id 失效：系统性无法核验（可重建后 retry）
      const reason = error instanceof BusinessError ? error.code.toLowerCase() : "chunk_access_failed";
      return this.markUnverifiable(projectId, candidate, `${reason}:${brief(error)}`);
    }
    const chunkText = chunk.text;
    const quoteCheck = verifyQuoteInChunk(candidate.quote, chunkText);
    if (!quoteCheck.ok) {
      return this.markResolved(projectId, candidate, {
        status: "mismatch",
        statusReason: `quote_not_found_in_chunk（${quoteCheck.reason ?? "unknown"}）`,
      });
    }

    // ---- Stage 2：Metadata Verification（确定性外部核验） ----
    const query = {
      ...(sourceMeta.title !== undefined ? { title: sourceMeta.title } : {}),
      ...(sourceMeta.authors !== undefined && sourceMeta.authors.length > 0
        ? { authors: sourceMeta.authors }
        : {}),
      ...(sourceMeta.year !== undefined ? { year: sourceMeta.year } : {}),
      ...(sourceMeta.doi !== undefined ? { doi: sourceMeta.doi } : {}),
      ...(sourceMeta.arxivId !== undefined ? { arxivId: sourceMeta.arxivId } : {}),
    };
    const verdict = await this.scholarly.resolve(query);
    let metadataOutcome: EvidenceMetadataOutcome;
    switch (verdict.outcome) {
      case "match":
        metadataOutcome = "match";
        break;
      case "mismatch":
        // 外部学术库确认存在该文献，但字段与库内元数据冲突 → 确定性不一致
        return this.markResolved(projectId, candidate, {
          status: "mismatch",
          statusReason: `metadata_mismatch（${(verdict.mismatches ?? []).map((m) => m.field).join("/") || "fields"}）`,
        });
      case "not_found":
        metadataOutcome = "not_found";
        break;
      default:
        metadataOutcome = "unresolved";
        break;
    }

    // ---- Stage 3：Semantic Judge（唯一 LLM 阶段；复用 Citation 角色） ----
    if (this.runtime === undefined || this.citationAgentId === undefined) {
      return this.markUnverifiable(
        projectId,
        candidate,
        "judge_unavailable（Runtime / citation agent 未配置）",
        metadataOutcome,
      );
    }
    const prompt = buildEvidenceJudgePrompt({
      claim: candidate.claim,
      quote: candidate.quote,
      chunkText,
      ...(sourceLine !== "" ? { sourceLine } : {}),
    });
    let judged: ReturnType<typeof parseEvidenceJudgeOutput>;
    try {
      const task = await this.runtime.runAgent({
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...this.timeoutOverride,
        agentId: this.citationAgentId,
        projectId,
        contextScope: `citation/evidence/${candidate.candidateId.toLowerCase()}`,
        task: prompt,
        metadata: { role: "citation" },
      });
      if (task.status !== "completed") {
        return this.markUnverifiable(
          projectId,
          candidate,
          `judge_failed（任务 ${task.status}${task.error !== undefined ? `：${brief(task.error, 120)}` : ""}）`,
          metadataOutcome,
        );
      }
      judged = parseEvidenceJudgeOutput(task.output ?? "", chunkText);
    } catch (error) {
      // judge 任务失败 / 输出非法：系统性失败，可 retry；绝不算证据本身的问题
      const message = error instanceof AgentRunFailedError ? error.message : brief(error);
      return this.markUnverifiable(
        projectId,
        candidate,
        `judge_failed（${message}）`,
        metadataOutcome,
      );
    }
    if (judged.verdict === "unsupported") {
      return this.markResolved(projectId, candidate, {
        status: "rejected",
        statusReason: `judge_unsupported${judged.reason !== "" ? `（${judged.reason}）` : ""}`.slice(0, 500),
        metadataOutcome,
        judgeVerdict: "unsupported",
        judgeReason: judged.reason,
      });
    }
    if (judged.verdict === "insufficient_evidence") {
      return this.markUnverifiable(
        projectId,
        candidate,
        `judge_inconclusive（${judged.reason}）`,
        metadataOutcome,
      );
    }

    // ---- 通过：转正进 EvidenceStore（唯一 grounded 写入口） ----
    const appendInput: EvidenceAppendInput = {
      claim: candidate.claim,
      ...(candidate.summary !== undefined ? { summary: candidate.summary } : {}),
      quote: candidate.quote,
      source: {
        sourceId: candidate.sourceId,
        ...(pickCanonicalField(verdict.canonical?.title, sourceMeta.title) !== undefined
          ? { title: pickCanonicalField(verdict.canonical?.title, sourceMeta.title) }
          : {}),
        ...(pickCanonicalField(verdict.canonical?.authors, sourceMeta.authors) !== undefined
          ? { authors: pickCanonicalField(verdict.canonical?.authors, sourceMeta.authors) }
          : {}),
        ...(pickCanonicalField(verdict.canonical?.year, sourceMeta.year) !== undefined
          ? { year: pickCanonicalField(verdict.canonical?.year, sourceMeta.year) }
          : {}),
        ...(pickCanonicalField(verdict.canonical?.doi, sourceMeta.doi) !== undefined
          ? { doi: pickCanonicalField(verdict.canonical?.doi, sourceMeta.doi) }
          : {}),
        ...(sourceMeta.url !== undefined ? { url: sourceMeta.url } : {}),
      },
      location: {
        ...(chunk.sectionTitle !== "" ? { section: chunk.sectionTitle.slice(0, 100) } : {}),
        ...(chunk.pageStart !== undefined ? { page: chunk.pageStart } : {}),
        chunk: candidate.chunkId,
      },
      verificationStatus: "verified",
      verificationMethod: `evidence-grounding/v1 quote=exact metadata=${metadataOutcome} judge=${judged.verdict}`,
      supportStrength: judged.verdict === "supported" ? "direct" : "partial",
      verificationLevel: "fulltext",
    };
    // 幂等守卫：append 与 markResolved 之间中断会让候选仍为 pending，
    // 重跑时先查是否已有同文 verified 记录（chunk+claim+quote 全等）→ 复用
    const existingRecord = await this.findGroundedRecord(projectId, candidate);
    let evidenceId: string;
    if (existingRecord !== null) {
      evidenceId = existingRecord.id;
    } else {
      const [record] = await this.evidence.appendBatch(projectId, [
        { input: appendInput, createdBy: candidate.proposedBy },
      ]);
      evidenceId = record!.id;
    }
    await this.candidates.markResolved(projectId, candidate.candidateId, {
      status: "verified",
      statusReason: `grounded（judge=${judged.verdict}）`,
      metadataOutcome,
      judgeVerdict: judged.verdict,
      judgeReason: judged.reason,
      evidenceId,
    });
    this.log(
      `[evidence-grounding] projectId=${projectId} ${candidate.candidateId} → verified（${evidenceId}，judge=${judged.verdict}，metadata=${metadataOutcome}）`,
    );
    return {
      candidateId: candidate.candidateId,
      status: "verified",
      evidenceId,
      judgeVerdict: judged.verdict,
    };
  }

  /**
   * 核验全部 pending 候选（workflow stage / 手动触发入口）。
   * 单条候选失败不中断批次（结构性记录为 unverifiable / mismatch / rejected）；
   * 意外异常（IO 等）冒泡由 stage 重试语义处理。
   */
  async groundPending(
    projectId: string,
    options: { limit?: number; signal?: AbortSignal } = {},
  ): Promise<GroundPendingSummary> {
    await this.projects.getRequired(projectId);
    const limit = options.limit ?? DEFAULT_GROUND_BATCH_LIMIT;
    const pending = await this.candidates.query(projectId, { status: "pending" });
    const summary: GroundPendingSummary = {
      pending: pending.length,
      processed: 0,
      verified: 0,
      mismatch: 0,
      rejected: 0,
      unverifiable: 0,
      evidenceAppended: 0,
      results: [],
    };
    for (const candidate of pending.slice(0, limit)) {
      const result = await this.ground(projectId, candidate.candidateId, {
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      summary.processed += 1;
      summary.results.push(result);
      summary[result.status] += 1;
      if (result.evidenceId !== undefined) {
        summary.evidenceAppended += 1;
      }
      if (options.signal?.aborted === true) {
        break;
      }
    }
    this.log(
      `[evidence-grounding] projectId=${projectId} 批次核验完成：pending=${summary.pending} processed=${summary.processed} verified=${summary.verified} mismatch=${summary.mismatch} rejected=${summary.rejected} unverifiable=${summary.unverifiable}`,
    );
    return summary;
  }

  /** 候选队列统计（workflow DoD / API 消费） */
  async candidateStats(
    projectId: string,
  ): Promise<import("./candidates.js").EvidenceCandidateStats> {
    await this.projects.getRequired(projectId);
    return this.candidates.stats(projectId);
  }

  // ---- 内部 ----

  private async findGroundedRecord(
    projectId: string,
    candidate: EvidenceCandidate,
  ): Promise<{ id: string } | null> {
    const records = await this.evidence.query(projectId, {
      sourceId: candidate.sourceId,
      claimContains: candidate.claim,
    });
    return (
      records.find(
        (record) =>
          record.verificationStatus === "verified" &&
          record.location?.chunk === candidate.chunkId &&
          record.quote === candidate.quote,
      ) ?? null
    );
  }

  private async markUnverifiable(
    projectId: string,
    candidate: EvidenceCandidate,
    reason: string,
    metadataOutcome?: EvidenceMetadataOutcome,
  ): Promise<GroundResult> {
    await this.candidates.markResolved(projectId, candidate.candidateId, {
      status: "unverifiable",
      statusReason: reason.slice(0, 500),
      ...(metadataOutcome !== undefined ? { metadataOutcome } : {}),
    });
    this.log(
      `[evidence-grounding] projectId=${projectId} ${candidate.candidateId} → unverifiable（${reason.slice(0, 160)}）`,
    );
    return { candidateId: candidate.candidateId, status: "unverifiable", reason };
  }

  private async markResolved(
    projectId: string,
    candidate: EvidenceCandidate,
    resolution: Parameters<EvidenceCandidateStore["markResolved"]>[2],
  ): Promise<GroundResult> {
    await this.candidates.markResolved(projectId, candidate.candidateId, resolution);
    this.log(
      `[evidence-grounding] projectId=${projectId} ${candidate.candidateId} → ${resolution.status}（${(resolution.statusReason ?? "").slice(0, 120)}）`,
    );
    return {
      candidateId: candidate.candidateId,
      status: resolution.status,
      ...(resolution.statusReason !== undefined ? { reason: resolution.statusReason } : {}),
      ...(resolution.judgeVerdict !== undefined ? { judgeVerdict: resolution.judgeVerdict } : {}),
    };
  }
}

// ---- 辅助 ----

function requireText(value: string | undefined, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new EvidenceValidationError(`字段 ${field} 必须是非空字符串`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new EvidenceValidationError(`字段 ${field} 长度不能超过 ${maxLength}`);
  }
  return trimmed;
}

/** 转正记录优先采用外部核验过的 canonical 字段，缺省回退库内元数据 */
function pickCanonicalField<T>(canonical: T | undefined, fallback: T | undefined): T | undefined {
  if (canonical !== undefined && canonical !== null && canonical !== "") {
    return canonical;
  }
  return fallback !== undefined && fallback !== null && fallback !== "" ? fallback : undefined;
}

function brief(error: unknown, maxLength = 200): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, maxLength);
}
