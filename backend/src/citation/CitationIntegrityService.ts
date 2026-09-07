/**
 * Citation Integrity 编排服务。
 *
 * Stage 化流水线（每个 stage 有输入指纹 + 产物持久化 + 可独立重跑）：
 *   extract   引用条目 + 正文 callout（确定性，本文件）
 *   metadata  文献真实性核验（ScholarlyResolver）
 *   semantic  (claim, citation) 语义核验
 *
 * 第 37 篇引用检索失败不会要求重新 parse PDF——文件粒度记录 + 指纹跳过。
 */

import type { AgentRuntime } from "../runtime/types.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { BusinessError } from "../errors.js";
import { fingerprintJson } from "../util/hash.js";
import type { PaperStore, StageRecord } from "../paper/PaperStore.js";
import { ReferenceExtractor, type ExtractionResult } from "../paper/ReferenceExtractor.js";
import type {
  CitationCallout,
  CitationMetadataStatus,
  CitationVerificationRecord,
  ClaimCitationRecord,
  ReferenceEntry,
} from "./integrity.js";
import { deriveClaimSeverity } from "./integrity.js";
import { ScholarlyResolver, type ScholarlyResolverOptions } from "./scholarly.js";
import {
  buildClaimRecords,
  buildEvidence,
  buildJudgePrompt,
  parseJudgeOutput,
  summarizeSemantic,
  type SemanticSummary,
} from "./semanticVerifier.js";

/** semantic stage telemetry（回答「这次语义核验烧了多少 token」） */
export interface SemanticTelemetry {
  modelCalls: number;
  skippedNoMetadata: number;
  skippedNoEvidence: number;
  failed: number;
  approxPromptChars: number;
}

export interface CitationIntegrityOptions {
  projects: ProjectStore;
  store: PaperStore;
  /** semantic judge 用的 Runtime（citation 角色 scope） */
  runtime?: AgentRuntime;
  citationAgentId?: string;
  /** scholarly resolver 注入（测试用 fake providers / fetch） */
  scholarly?: ScholarlyResolverOptions;
  /** metadata 核验上限（rate-limit friendly，默认 40） */
  maxMetadataLookups?: number;
  /** semantic 核验上限（默认 30；token 控制） */
  maxSemanticVerifications?: number;
  now?: () => Date;
  log?: (message: string) => void;
}

export class CitationIntegrityService {
  private readonly projects: ProjectStore;
  private readonly store: PaperStore;
  private readonly resolver: ScholarlyResolver;
  private readonly runtime: AgentRuntime | undefined;
  private readonly citationAgentId: string | undefined;
  private readonly maxLookups: number;
  private readonly maxSemantic: number;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  /** 最近一次 verifyClaims 的 telemetry（模型调用数 / 上下文规模） */
  lastSemanticTelemetry: SemanticTelemetry | undefined;

  constructor(options: CitationIntegrityOptions) {
    this.projects = options.projects;
    this.store = options.store;
    this.resolver = new ScholarlyResolver(options.scholarly);
    this.runtime = options.runtime;
    this.citationAgentId = options.citationAgentId;
    this.maxLookups = options.maxMetadataLookups ?? 40;
    this.maxSemantic = options.maxSemanticVerifications ?? 30;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  /** 共享 resolver（受控学术检索工具复用同一缓存与 telemetry） */
  get scholarlyResolver(): ScholarlyResolver {
    return this.resolver;
  }

  /** 提取 stage：references + callouts 提取并持久化（指纹一致则跳过） */
  async extract(
    projectId: string,
    options: { force?: boolean } = {},
  ): Promise<{ result: ExtractionResult; reused: boolean }> {
    await this.projects.getRequired(projectId);
    const document = await this.store.loadDocument(projectId);
    if (document === null) {
      throw new BusinessError("INVALID_REQUEST", "尚未上传/解析 Final PDF（先上传 PDF 再提取引用）");
    }
    const inputFingerprint = fingerprintJson({
      referencesSectionId: document.referencesSectionId ?? null,
      chunks: document.chunks.map((chunk) => `${chunk.chunkId}:${chunk.text}`),
    });
    const stage = (await this.store.loadStages(projectId))["references"];
    const stageMatches =
      stage?.status === "ok" && stage.inputFingerprint === inputFingerprint && !options.force;
    if (stageMatches) {
      const references = await this.store.loadReferences<ReferenceEntry>(projectId);
      const callouts = await this.store.loadCallouts<CitationCallout>(projectId);
      if (references.length > 0 || callouts.length > 0) {
        return {
          result: { references, callouts, notes: [] },
          reused: true,
        };
      }
    }

    const result = new ReferenceExtractor().extract(document);
    await this.store.saveExtraction(projectId, {
      references: result.references,
      callouts: result.callouts,
      notes: result.notes,
    });
    await this.saveStage(projectId, {
      stage: "references",
      status: "ok",
      inputFingerprint,
      outputSummary: {
        referenceCount: result.references.length,
        calloutCount: result.callouts.length,
      },
      updatedAt: this.now().toISOString(),
    });
    this.log(
      `[citation-integrity] projectId=${projectId} 提取完成：references=${result.references.length} callouts=${result.callouts.length}`,
    );
    return { result, reused: false };
  }

  /** 当前提取摘要（供 API / Quality Gate） */
  async summary(projectId: string): Promise<{
    extracted: boolean;
    references: number;
    callouts: number;
    resolvedRelations: number;
    unresolvedRelations: number;
    invalidRelations: number;
    referencesWithDoi: number;
  }> {
    await this.projects.getRequired(projectId);
    const references = await this.store.loadReferences<{ doi?: string }>(projectId);
    const callouts = await this.store.loadCallouts<{
      references: Array<{ status: string }>;
    }>(projectId);
    let resolved = 0;
    let unresolved = 0;
    let invalid = 0;
    for (const callout of callouts) {
      for (const relation of callout.references ?? []) {
        if (relation.status === "resolved") {
          resolved += 1;
        } else if (relation.status === "unresolved") {
          unresolved += 1;
        } else {
          invalid += 1;
        }
      }
    }
    return {
      extracted: references.length > 0 || callouts.length > 0,
      references: references.length,
      callouts: callouts.length,
      resolvedRelations: resolved,
      unresolvedRelations: unresolved,
      invalidRelations: invalid,
      referencesWithDoi: references.filter((reference) => reference.doi !== undefined).length,
    };
  }

  protected async saveStage(projectId: string, record: StageRecord): Promise<void> {
    await this.store.saveStage(projectId, record);
  }

  // ---- metadata 核验 stage（确定性外部核验，无 LLM） ----

  /**
   * 逐条核验（文件粒度持久化 + 指纹跳过：第 37 条失败不影响前 36 条，
   * 重跑只补缺失/变化条目）。默认上限 maxLookups 条。
   */
  async verifyMetadata(
    projectId: string,
    options: { force?: boolean } = {},
  ): Promise<{
    byStatus: Record<CitationMetadataStatus, number>;
    checked: number;
    reused: number;
    records: CitationVerificationRecord[];
    telemetry: { providerCalls: number; cacheHits: number; retries: number };
  }> {
    await this.projects.getRequired(projectId);
    const references = await this.store.loadReferences<ReferenceEntry>(projectId);
    if (references.length === 0) {
      throw new BusinessError("INVALID_REQUEST", "尚未提取引用（先 POST /citations/extract）");
    }
    const targets = references.slice(0, this.maxLookups);
    const byStatus: Record<CitationMetadataStatus, number> = {
      VERIFIED: 0,
      METADATA_MISMATCH: 0,
      AMBIGUOUS: 0,
      NOT_FOUND: 0,
      UNRESOLVED: 0,
    };
    const records: CitationVerificationRecord[] = [];
    let reused = 0;
    for (const reference of targets) {
      const existing = await this.store.loadRecord<CitationVerificationRecord>(
        projectId,
        "metadata",
        reference.referenceId,
      );
      if (!options.force && existing !== null && existing.fingerprint === reference.fingerprint) {
        byStatus[existing.status] += 1;
        records.push(existing);
        reused += 1;
        continue;
      }
      const record = await this.verifyReference(projectId, reference);
      byStatus[record.status] += 1;
      records.push(record);
    }
    await this.saveStage(projectId, {
      stage: "metadata",
      status: "ok",
      inputFingerprint: fingerprintJson(targets.map((r) => `${r.referenceId}:${r.fingerprint}`)),
      outputSummary: { ...byStatus, checked: targets.length },
      updatedAt: this.now().toISOString(),
    });
    this.log(
      `[citation-integrity] projectId=${projectId} metadata 核验：checked=${targets.length} reused=${reused} verified=${byStatus.VERIFIED} not_found=${byStatus.NOT_FOUND}`,
    );
    return {
      byStatus,
      checked: targets.length,
      reused,
      records,
      telemetry: {
        providerCalls: this.resolver.telemetry.providerCalls,
        cacheHits: this.resolver.telemetry.cacheHits,
        retries: this.resolver.telemetry.retries,
      },
    };
  }

  private async verifyReference(
    projectId: string,
    reference: ReferenceEntry,
  ): Promise<CitationVerificationRecord> {
    const verdict = await this.resolver.resolve({
      ...(reference.title !== undefined ? { title: reference.title } : {}),
      ...(reference.authors !== undefined ? { authors: reference.authors } : {}),
      ...(reference.year !== undefined ? { year: reference.year } : {}),
      ...(reference.doi !== undefined ? { doi: reference.doi } : {}),
      ...(reference.arxivId !== undefined ? { arxivId: reference.arxivId } : {}),
    });
    const notFoundAttempts = verdict.attempts.filter((attempt) => attempt.outcome === "not_found").length;
    const status: CitationMetadataStatus =
      verdict.outcome === "match"
        ? "VERIFIED"
        : verdict.outcome === "mismatch"
          ? "METADATA_MISMATCH"
          : verdict.outcome === "ambiguous"
            ? "AMBIGUOUS"
            : verdict.outcome === "not_found"
              ? "NOT_FOUND"
              : "UNRESOLVED";
    // probable fabrication = 强证据：全部书目库一致 not_found（≥3 且无 error）+ 有可查字段
    const probableFabrication =
      status === "NOT_FOUND" &&
      notFoundAttempts >= 3 &&
      verdict.attempts.every((attempt) => attempt.outcome === "not_found") &&
      (reference.title !== undefined || reference.doi !== undefined);
    const record: CitationVerificationRecord = {
      referenceId: reference.referenceId,
      status,
      probableFabrication,
      ...(verdict.canonical !== undefined
        ? { canonical: verdict.canonical }
        : verdict.candidates !== undefined && verdict.candidates.length > 0
          ? { canonical: verdict.candidates[0] }
          : {}),
      ...(verdict.mismatches !== undefined ? { mismatches: verdict.mismatches } : {}),
      attempts: verdict.attempts.map((attempt) => ({
        provider: attempt.provider as CitationVerificationRecord["attempts"][number]["provider"],
        outcome:
          attempt.outcome === "match"
            ? "match"
            : attempt.outcome === "mismatch"
              ? "mismatch"
              : attempt.outcome === "not_found"
                ? "not_found"
                : attempt.outcome === "ambiguous"
                  ? "ambiguous"
                  : "error",
        ...(attempt.note !== undefined ? { note: attempt.note } : {}),
      })),
      checkedAt: this.now().toISOString(),
      fingerprint: reference.fingerprint,
      ...(verdict.outcome === "unresolved"
        ? { error: verdict.attempts.find((a) => a.outcome === "error")?.note ?? "多源检索未获结论" }
        : {}),
    };
    await this.store.saveRecord(projectId, "metadata", reference.referenceId, record);
    return record;
  }

  /** 全部 metadata 记录（API 用） */
  async listMetadataRecords(projectId: string): Promise<CitationVerificationRecord[]> {
    await this.projects.getRequired(projectId);
    const ids = await this.store.listRecordIds(projectId, "metadata");
    const records: CitationVerificationRecord[] = [];
    for (const id of ids) {
      const record = await this.store.loadRecord<CitationVerificationRecord>(projectId, "metadata", id);
      if (record !== null) {
        records.push(record);
      }
    }
    return records;
  }

  // ---- semantic verification stage（(claim, citation) 单记录） ----

  /**
   * 逐条语义核验。确定性短路优先（真实性未确立 → SKIPPED；无证据 →
   * INSUFFICIENT_EVIDENCE，零模型调用），只有真实证据在手才调用 judge。
   */
  async verifyClaims(
    projectId: string,
    options: { force?: boolean; limit?: number; signal?: AbortSignal } = {},
  ): Promise<{
    summary: SemanticSummary;
    verified: number;
    reused: number;
    records: ClaimCitationRecord[];
    telemetry: SemanticTelemetry;
  }> {
    if (this.runtime === undefined || this.citationAgentId === undefined) {
      throw new BusinessError("INVALID_REQUEST", "semantic 核验需要 Runtime（服务未配置 runtime）");
    }
    await this.projects.getRequired(projectId);
    const [references, callouts, document, metadataRaw] = await Promise.all([
      this.store.loadReferences<ReferenceEntry>(projectId),
      this.store.loadCallouts<CitationCallout>(projectId),
      this.store.loadDocument(projectId),
      this.listMetadataRecords(projectId),
    ]);
    if (references.length === 0) {
      throw new BusinessError("INVALID_REQUEST", "尚未提取引用（先 POST /citations/extract）");
    }
    if (metadataRaw.length === 0) {
      throw new BusinessError(
        "INVALID_REQUEST",
        "尚未执行 metadata 核验（先 POST /citations/verify-metadata——真实性 Gate 先于语义核验）",
      );
    }
    const metadataRecords = new Map(metadataRaw.map((record) => [record.referenceId, record]));
    const sectionTitles = new Map((document?.sections ?? []).map((s) => [s.sectionId, s.title]));
    const pending = buildClaimRecords(
      callouts,
      references,
      metadataRecords,
      sectionTitles,
      this.now().toISOString(),
    );

    const telemetry = {
      modelCalls: 0,
      skippedNoMetadata: 0,
      skippedNoEvidence: 0,
      failed: 0,
      approxPromptChars: 0,
    };
    const limit = options.limit ?? this.maxSemantic;
    let verifiedCount = 0;
    let reused = 0;
    let processed = 0;
    const records: ClaimCitationRecord[] = [];
    for (const claim of pending) {
      const existing = await this.store.loadRecord<ClaimCitationRecord>(
        projectId,
        "claims",
        claim.claimCitationId,
      );
      if (
        !options.force &&
        existing !== null &&
        existing.fingerprint === claim.fingerprint &&
        (existing.status === "verified" || existing.status === "skipped")
      ) {
        // 只有终态成功记录才复用；failed/pending 必须重试（可恢复语义）
        records.push(existing);
        reused += 1;
        continue;
      }
      if (processed >= limit) {
        records.push(claim); // 超出本轮上限：保持 pending（下一轮继续）
        continue;
      }
      processed += 1;
      if (options.signal?.aborted === true) {
        throw new BusinessError("WORKFLOW_CANCELLED", "语义核验已被取消");
      }
      const record = await this.verifyClaim(projectId, claim, metadataRecords, telemetry, options.signal);
      records.push(record);
      if (record.status === "verified" || record.status === "skipped") {
        verifiedCount += 1;
      }
    }

    const summary = summarizeSemantic(metadataRaw, records);
    await this.saveStage(projectId, {
      stage: "semantic",
      status: "ok",
      inputFingerprint: fingerprintJson(pending.map((claim) => `${claim.claimCitationId}:${claim.fingerprint}`)),
      outputSummary: { total: summary.total, ...summary.byVerdict },
      updatedAt: this.now().toISOString(),
    });
    this.lastSemanticTelemetry = telemetry;
    this.log(
      `[citation-integrity] projectId=${projectId} semantic 核验：total=${summary.total} verified=${verifiedCount} skipped=${summary.skipped} modelCalls=${telemetry.modelCalls}`,
    );
    return { summary, verified: verifiedCount, reused, records, telemetry };
  }

  private async verifyClaim(
    projectId: string,
    claim: ClaimCitationRecord,
    metadataRecords: Map<string, CitationVerificationRecord>,
    telemetry: SemanticTelemetry,
    signal?: AbortSignal,
  ): Promise<ClaimCitationRecord> {
    const metadata = metadataRecords.get(claim.referenceId);
    const base: ClaimCitationRecord = { ...claim, evidence: [] };

    // 真实性 Gate：NOT_FOUND / UNRESOLVED / AMBIGUOUS / 无记录 → semantic SKIPPED
    if (
      metadata === undefined ||
      metadata.status === "NOT_FOUND" ||
      metadata.status === "UNRESOLVED" ||
      metadata.status === "AMBIGUOUS"
    ) {
      const reason =
        metadata === undefined
          ? "该文献未经 metadata 核验，语义核验跳过"
          : `文献真实性未确立（${metadata.status}），语义核验跳过——不允许验证不存在的文献`;
      const skipped: ClaimCitationRecord = {
        ...base,
        verdict: "SKIPPED",
        reason,
        status: "skipped",
        severity: deriveSeverityFor(claim, metadata),
        verifiedAt: this.now().toISOString(),
      };
      telemetry.skippedNoMetadata += 1;
      await this.store.saveRecord(projectId, "claims", claim.claimCitationId, skipped);
      return skipped;
    }

    const evidence = buildEvidence(metadata, this.now().toISOString());
    const fabric = metadata.probableFabrication;

    // 无可判证据 → INSUFFICIENT_EVIDENCE（确定性短路，零模型调用）
    if (evidence.length === 0) {
      const record: ClaimCitationRecord = {
        ...base,
        verdict: "INSUFFICIENT_EVIDENCE",
        reason: "canonical record 无摘要等可判证据（abstract 缺失），证据不足以判断",
        evidence: [],
        status: "verified",
        severity: deriveSeverityFor(claim, metadata),
        verifiedAt: this.now().toISOString(),
      };
      telemetry.skippedNoEvidence += 1;
      await this.store.saveRecord(projectId, "claims", claim.claimCitationId, record);
      return record;
    }

    const prompt = buildJudgePrompt({
      claimText: claim.claimText,
      reference: { rawText: "" } as ReferenceEntry,
      canonical: metadata.canonical,
      evidence,
    });
    telemetry.approxPromptChars += prompt.length;
    telemetry.modelCalls += 1;
    try {
      const task = await this.runtime!.runAgent({
        ...(signal !== undefined ? { signal } : {}),
        agentId: this.citationAgentId!,
        projectId,
        contextScope: `citation/semantic/${claim.claimCitationId.toLowerCase()}`,
        task: prompt,
        metadata: { role: "citation" },
      });
      if (task.status !== "completed") {
        throw new Error(task.error ?? "judge 任务未完成");
      }
      const judged = parseJudgeOutput(task.output ?? "", evidence);
      const evidenceWithQuote =
        judged.keyQuote !== undefined
          ? [
              {
                ...evidence[0]!,
                text: `${evidence[0]!.text}\n[judge 关键引文] ${judged.keyQuote}`,
              },
            ]
          : evidence;
      const record: ClaimCitationRecord = {
        ...base,
        verdict: judged.verdict,
        reason: judged.reason,
        evidence: evidenceWithQuote,
        status: "verified",
        severity: deriveClaimSeverity({
          probableFabrication: fabric,
          verdict: judged.verdict,
          priority: claim.priority,
        }),
        model: task.metadata?.["model"] as string | undefined,
        verifiedAt: this.now().toISOString(),
      };
      await this.store.saveRecord(projectId, "claims", claim.claimCitationId, record);
      return record;
    } catch (error) {
      telemetry.failed += 1;
      const record: ClaimCitationRecord = {
        ...base,
        status: "failed",
        verdict: "INSUFFICIENT_EVIDENCE",
        severity: "info",
        error: error instanceof Error ? error.message : String(error),
      };
      await this.store.saveRecord(projectId, "claims", claim.claimCitationId, record);
      return record;
    }
  }

  /** 全部 claim 记录（API 用） */
  async listClaimRecords(projectId: string): Promise<ClaimCitationRecord[]> {
    await this.projects.getRequired(projectId);
    const ids = await this.store.listRecordIds(projectId, "claims");
    const records: ClaimCitationRecord[] = [];
    for (const id of ids) {
      const record = await this.store.loadRecord<ClaimCitationRecord>(projectId, "claims", id);
      if (record !== null) {
        records.push(record);
      }
    }
    return records;
  }

  /** Citation Integrity 总报告（metadata + semantic + Quality Gate 输入） */
  async integrityReport(projectId: string): Promise<{
    metadataByStatus: Record<CitationMetadataStatus, number>;
    semantic: SemanticSummary;
    probableFabrications: string[];
  }> {
    const metadataRecords = await this.listMetadataRecords(projectId);
    const claims = await this.listClaimRecords(projectId);
    const byStatus: Record<CitationMetadataStatus, number> = {
      VERIFIED: 0,
      METADATA_MISMATCH: 0,
      AMBIGUOUS: 0,
      NOT_FOUND: 0,
      UNRESOLVED: 0,
    };
    for (const record of metadataRecords) {
      byStatus[record.status] += 1;
    }
    return {
      metadataByStatus: byStatus,
      semantic: summarizeSemantic(metadataRecords, claims),
      probableFabrications: metadataRecords
        .filter((record) => record.probableFabrication)
        .map((record) => record.referenceId),
    };
  }
}

function deriveSeverityFor(
  claim: ClaimCitationRecord,
  metadata: CitationVerificationRecord | undefined,
): ClaimCitationRecord["severity"] {
  return deriveClaimSeverity({
    probableFabrication: metadata?.probableFabrication ?? false,
    verdict: "SKIPPED",
    priority: claim.priority,
  });
}
