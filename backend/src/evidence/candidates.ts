/**
 * EvidenceCandidate：Agent 提出的「潜在证据」候选（M6.5 Evidence Grounding）。
 *
 * 与 EvidenceRecord 的关系（候选-转正分离，红线：Retrieved ≠ Verified）：
 * - Candidate 是待验证队列条目（propose_evidence / Researcher JSON 的
 *   chunk 锚定 evidence 字段产生），**不是** Evidence，不得被下游当事实引用；
 * - 只有 EvidenceGroundingService 的三段核验（quote 逐字校验 → metadata
 *   核验 → Citation 角色语义 judge）全部通过后才 append 进 EvidenceStore；
 * - 状态转换只经 markResolved（由 EvidenceGroundingService 调用），
 *   Tool / Workflow / Agent 不直接改状态。
 *
 * 存储：项目级 evidence/candidates.jsonl（每行一条候选；append 追加写，
 * 状态更新走全量原子重写——与 EvidenceStore 同口径，规模内可接受）。
 */

import { appendFile, mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { EvidenceValidationError } from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { writeFileAtomic } from "../util/atomic.js";

/**
 * 候选终态语义：
 * - pending       待核验（初始态）
 * - verified      三段核验通过，已转正进 EvidenceStore（evidenceId 回填）
 * - mismatch      确定性核验不一致（quote 不在 chunk 原文中 / 来源 metadata
 *                 与外部学术库冲突）——证据本身有问题，终态
 * - rejected      语义 judge 裁决 unsupported（chunk 原文不支撑 claim），终态
 * - unverifiable  系统性无法核验（chunk/来源缺失、resolver 不可用、judge 失败）
 *                 ——不是证据本身的问题，可 retry 重grounding
 */
export type EvidenceCandidateStatus =
  | "pending"
  | "verified"
  | "rejected"
  | "mismatch"
  | "unverifiable";

export const EVIDENCE_CANDIDATE_STATUSES: readonly EvidenceCandidateStatus[] = [
  "pending",
  "verified",
  "rejected",
  "mismatch",
  "unverifiable",
];

/** 语义 judge 裁决（只有这三个；judge 无法判断 → 候选 unverifiable，不伪造裁决） */
export type EvidenceJudgeVerdict = "supported" | "partially_supported" | "unsupported";

/** metadata 通道结果（match/mismatch 定论；其余如实记录不阻塞） */
export type EvidenceMetadataOutcome = "match" | "mismatch" | "not_found" | "unresolved";

export interface EvidenceCandidate {
  candidateId: string;
  projectId: string;
  sourceId: string;
  chunkId: string;
  claim: string;
  /** 逐字引文（quote verification 的锚点；propose 时必须非空） */
  quote: string;
  summary?: string;
  status: EvidenceCandidateStatus;
  /** 提案方（researcher / 工具调用角色；审计用） */
  proposedBy: string;
  /** 终态/更新说明（失败原因 / judge 理由摘要；≤500 字符） */
  statusReason?: string;
  /** metadata 通道结果（grounding 时回填） */
  metadataOutcome?: EvidenceMetadataOutcome;
  /** 语义 judge 裁决与理由（grounding 时回填） */
  judgeVerdict?: EvidenceJudgeVerdict;
  judgeReason?: string;
  /** 转正后的 EvidenceRecord id（status=verified 时必有） */
  evidenceId?: string;
  createdAt: string;
  updatedAt?: string;
}

export interface EvidenceCandidateAppendInput {
  sourceId: string;
  chunkId: string;
  claim: string;
  quote: string;
  summary?: string;
  proposedBy: string;
}

export interface EvidenceCandidateQuery {
  status?: EvidenceCandidateStatus;
  sourceId?: string;
  chunkId?: string;
  claimContains?: string;
}

/** 受控状态转换 payload（唯一合法转换口；调用方：EvidenceGroundingService） */
export interface EvidenceCandidateResolution {
  status: Exclude<EvidenceCandidateStatus, "pending">;
  statusReason?: string;
  metadataOutcome?: EvidenceMetadataOutcome;
  judgeVerdict?: EvidenceJudgeVerdict;
  judgeReason?: string;
  evidenceId?: string;
}

export interface EvidenceCandidateStats {
  total: number;
  byStatus: Record<EvidenceCandidateStatus, number>;
  skippedLines: number;
}

export interface EvidenceCandidateStoreOptions {
  now?: () => Date;
}

export class EvidenceCandidateStore {
  private readonly projects: ProjectStore;
  private readonly now: () => Date;

  constructor(projects: ProjectStore, options: EvidenceCandidateStoreOptions = {}) {
    this.projects = projects;
    this.now = options.now ?? (() => new Date());
  }

  private filePath(projectId: string): string {
    return join(this.projects.evidenceDir(projectId), "candidates.jsonl");
  }

  /** 追加一条候选（自动生成递增 id：EC001…）；字段校验与 EvidenceStore 同风格 */
  async append(
    projectId: string,
    input: EvidenceCandidateAppendInput,
  ): Promise<EvidenceCandidate> {
    const sourceId = requireNonEmpty(input.sourceId, "sourceId", 64);
    const chunkId = requireNonEmpty(input.chunkId, "chunkId", 200);
    const claim = requireNonEmpty(input.claim, "claim", 4000);
    const quote = requireNonEmpty(input.quote, "quote", 2000);
    const proposedBy = requireNonEmpty(input.proposedBy, "proposedBy", 64);
    const { records } = await this.loadAll(projectId);
    const maxExisting = records.reduce((max, item) => {
      const numeric = Number(item.candidateId.replace(/^EC/, ""));
      return Number.isFinite(numeric) ? Math.max(max, numeric) : max;
    }, 0);
    const candidate: EvidenceCandidate = {
      candidateId: `EC${String(maxExisting + 1).padStart(3, "0")}`,
      projectId,
      sourceId,
      chunkId,
      claim,
      quote,
      ...(optionalString(input.summary, 2000) !== undefined
        ? { summary: optionalString(input.summary, 2000) }
        : {}),
      status: "pending",
      proposedBy,
      createdAt: this.now().toISOString(),
    };
    await mkdir(this.projects.evidenceDir(projectId), { recursive: true });
    await appendFile(this.filePath(projectId), JSON.stringify(candidate) + "\n", "utf8");
    return candidate;
  }

  async get(projectId: string, candidateId: string): Promise<EvidenceCandidate | null> {
    const { records } = await this.loadAll(projectId);
    return records.find((candidate) => candidate.candidateId === candidateId) ?? null;
  }

  async list(projectId: string): Promise<EvidenceCandidate[]> {
    const { records } = await this.loadAll(projectId);
    return records;
  }

  async query(projectId: string, filter: EvidenceCandidateQuery): Promise<EvidenceCandidate[]> {
    const { records } = await this.loadAll(projectId);
    return records.filter((candidate) => {
      if (filter.status !== undefined && candidate.status !== filter.status) {
        return false;
      }
      if (filter.sourceId !== undefined && candidate.sourceId !== filter.sourceId) {
        return false;
      }
      if (filter.chunkId !== undefined && candidate.chunkId !== filter.chunkId) {
        return false;
      }
      if (
        filter.claimContains !== undefined &&
        !candidate.claim.toLowerCase().includes(filter.claimContains.toLowerCase())
      ) {
        return false;
      }
      return true;
    });
  }

  async stats(projectId: string): Promise<EvidenceCandidateStats> {
    const { records, skippedLines } = await this.loadAll(projectId);
    const byStatus = Object.fromEntries(
      EVIDENCE_CANDIDATE_STATUSES.map((status) => [status, 0]),
    ) as Record<EvidenceCandidateStatus, number>;
    for (const candidate of records) {
      byStatus[candidate.status] += 1;
    }
    return { total: records.length, byStatus, skippedLines };
  }

  /**
   * 受控状态转换（唯一合法转换口）。终态不可再变；pending → 终态 /
   * unverifiable → 终态（retry）合法；verified 只能由 grounding 在转正时写入。
   */
  async markResolved(
    projectId: string,
    candidateId: string,
    resolution: EvidenceCandidateResolution,
  ): Promise<EvidenceCandidate> {
    const { records } = await this.loadAll(projectId);
    const index = records.findIndex((candidate) => candidate.candidateId === candidateId);
    if (index === -1) {
      throw new EvidenceValidationError(`候选 ${candidateId} 不存在`);
    }
    const current = records[index]!;
    if (current.status !== "pending" && current.status !== "unverifiable") {
      throw new EvidenceValidationError(
        `候选 ${candidateId} 已是终态 ${current.status}，不允许再次转换`,
      );
    }
    if (resolution.status === "verified" && resolution.evidenceId === undefined) {
      throw new EvidenceValidationError("verified 转换必须携带 evidenceId");
    }
    const updated: EvidenceCandidate = {
      ...current,
      status: resolution.status,
      ...(optionalString(resolution.statusReason, 500) !== undefined
        ? { statusReason: optionalString(resolution.statusReason, 500) }
        : {}),
      ...(resolution.metadataOutcome !== undefined
        ? { metadataOutcome: resolution.metadataOutcome }
        : {}),
      ...(resolution.judgeVerdict !== undefined ? { judgeVerdict: resolution.judgeVerdict } : {}),
      ...(optionalString(resolution.judgeReason, 500) !== undefined
        ? { judgeReason: optionalString(resolution.judgeReason, 500) }
        : {}),
      ...(resolution.evidenceId !== undefined ? { evidenceId: resolution.evidenceId } : {}),
      updatedAt: this.now().toISOString(),
    };
    records[index] = updated;
    await mkdir(this.projects.evidenceDir(projectId), { recursive: true });
    const content =
      records.map((record) => JSON.stringify(record)).join("\n") + (records.length > 0 ? "\n" : "");
    await writeFileAtomic(this.filePath(projectId), content);
    return updated;
  }

  // ---- 内部 ----

  private async loadAll(
    projectId: string,
  ): Promise<{ records: EvidenceCandidate[]; skippedLines: number }> {
    let raw: string;
    try {
      raw = await readFile(this.filePath(projectId), "utf8");
    } catch (error) {
      // 与 EvidenceStore 同口径：只有「尚无文件」等于空库，IO 失败冒泡
      if ((error as { code?: string }).code === "ENOENT") {
        return { records: [], skippedLines: 0 };
      }
      throw error;
    }
    const records: EvidenceCandidate[] = [];
    let skippedLines = 0;
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as EvidenceCandidate;
        if (
          typeof parsed === "object" &&
          parsed !== null &&
          typeof parsed.candidateId === "string" &&
          typeof parsed.claim === "string" &&
          EVIDENCE_CANDIDATE_STATUSES.includes(parsed.status)
        ) {
          records.push(parsed);
          continue;
        }
        skippedLines += 1;
      } catch {
        skippedLines += 1;
      }
    }
    return { records, skippedLines };
  }
}

// ---- 校验辅助（与 EvidenceStore 同风格） ----

function requireNonEmpty(value: string | undefined, field: string, maxLength: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new EvidenceValidationError(`候选字段 ${field} 必须是非空字符串`);
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new EvidenceValidationError(`候选字段 ${field} 长度不能超过 ${maxLength}`);
  }
  return trimmed;
}

function optionalString(value: string | undefined, maxLength: number): string | undefined {
  if (typeof value !== "string" || value.trim() === "") {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed.length > maxLength) {
    throw new EvidenceValidationError(`字段长度超过上限 ${maxLength}`);
  }
  return trimmed;
}
