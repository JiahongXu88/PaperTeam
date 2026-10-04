/**
 * Targeted Evidence Grounding（M11.2.3，D-3 §8）。
 *
 * 缺口：claim grounding 的 repairCandidates 只在**已核验证据池**里词面匹配——
 * 「全文在库、证据未采」的源（Case A 的 S016/S024：fulltext resolved 但
 * evidence 0 条）永远进不了候选，claim 只能弱化 / 删除，而正确的第一步是
 * 对在库全文做定向采证（§7 Evidence First：已有 Fulltext 定向 Ground 优先于
 * 任何文字修改）。
 *
 * 本服务做最小闭环（不重跑 Research / Matrix / Synthesis）：
 *   unsupported claim + 目标源（chunked）
 *     → 检索该源 chunks（retrieval 词面，bounded Top-K）
 *     → 逐字 quote 窗口（claim 词面覆盖最大的 chunk 切片）
 *     → EvidenceGroundingService.propose → ground（三段核验：quote 逐字 /
 *       metadata / semantic judge——既有管线，零新判定器）
 *     → verified evidence（claimId → evidenceIds 回绑修订派发 / Writer 上下文）
 *
 * 诚实边界：judge 是既有 LLM 通道；quote 是确定性切片（逐字来自 chunk，不合成）。
 * 检索无候选如实返回 no_candidate（回落弱化 / 删除，不硬配）。
 */

import type { ProjectStore } from "../project/ProjectStore.js";
import type { RetrievalService } from "../retrieval/RetrievalService.js";
import type { EvidenceGroundingService } from "./EvidenceGroundingService.js";
import { tokenizeText } from "../retrieval/tokenize.js";

export interface TargetedGroundingRequest {
  claimId: string;
  claim: string;
  section: string;
  /** 目标源（claim resolution 的 ground_existing_source 判定输出） */
  sourceIds: string[];
}

export type TargetedGroundingStatus =
  | "verified"
  | "no_candidate"
  | "unverified"
  | "failed";

export interface TargetedGroundingOutcome {
  claimId: string;
  status: TargetedGroundingStatus;
  /** verified 的 evidence id（≥1 即 status=verified） */
  evidenceIds: string[];
  /** 每个 chunk 尝试的结果（审计 / 报告） */
  attempts: { sourceId: string; chunkId: string; outcome: string; reason?: string }[];
  reason?: string;
}

export interface TargetedGroundingSummary {
  outcomes: TargetedGroundingOutcome[];
  verifiedClaims: number;
  verifiedEvidence: number;
  /** 语义 judge 不支持（unverifiable / rejected）的 claim 数——回落弱化 / 删除 */
  unsupportedByJudge: number;
}

export interface TargetedGroundingServiceOptions {
  projects: ProjectStore;
  retrieval: RetrievalService;
  evidenceGrounding: EvidenceGroundingService;
  log?: (message: string) => void;
}

/** 每 claim 最多尝试的 chunk 数（成本 bound；第一个 verified 即停） */
export const TARGETED_GROUNDING_CHUNK_LIMIT = 3;
/** 检索候选池（词面 Top-K；chunk 限制在其内选取） */
export const TARGETED_GROUNDING_TOP_K = 6;
/** quote 窗口目标长度（字符；逐字切片，≤2000 由 propose 校验上限兜住） */
const QUOTE_WINDOW_CHARS = 900;

export class TargetedGroundingService {
  private readonly projects: ProjectStore;
  private readonly retrieval: RetrievalService;
  private readonly grounding: EvidenceGroundingService;
  private readonly log: (message: string) => void;

  constructor(options: TargetedGroundingServiceOptions) {
    this.projects = options.projects;
    this.retrieval = options.retrieval;
    this.grounding = options.evidenceGrounding;
    this.log = options.log ?? (() => {});
  }

  /**
   * 批量定向采证（每 claim 独立；单 claim 失败不阻断批次）。
   * 只处理 pending 候选；quote 必须逐字来自 chunk（窗口切片，非合成）。
   */
  async groundClaims(
    projectId: string,
    requests: readonly TargetedGroundingRequest[],
    options: { signal?: AbortSignal } = {},
  ): Promise<TargetedGroundingSummary> {
    await this.projects.getRequired(projectId);
    const outcomes: TargetedGroundingOutcome[] = [];
    for (const request of requests) {
      outcomes.push(await this.groundClaim(projectId, request, options));
    }
    const verified = outcomes.filter((outcome) => outcome.status === "verified");
    return {
      outcomes,
      verifiedClaims: verified.length,
      verifiedEvidence: verified.reduce((total, outcome) => total + outcome.evidenceIds.length, 0),
      unsupportedByJudge: outcomes.filter(
        (outcome) => outcome.status === "unverified" || outcome.status === "failed",
      ).length,
    };
  }

  private async groundClaim(
    projectId: string,
    request: TargetedGroundingRequest,
    options: { signal?: AbortSignal },
  ): Promise<TargetedGroundingOutcome> {
    const outcome: TargetedGroundingOutcome = {
      claimId: request.claimId,
      status: "no_candidate",
      evidenceIds: [],
      attempts: [],
    };
    if (request.sourceIds.length === 0) {
      outcome.reason = "无目标源（claim resolution 未给出 groundable source）";
      return outcome;
    }
    let search;
    try {
      search = await this.retrieval.search(projectId, request.claim, {
        topK: TARGETED_GROUNDING_TOP_K,
        filter: { sourceIds: [...request.sourceIds] },
        mode: "lexical",
      });
    } catch (error) {
      outcome.status = "failed";
      outcome.reason = `检索失败：${error instanceof Error ? error.message : String(error)}`;
      return outcome;
    }
    const chunks = search.results
      .map((result) => result.chunk)
      .filter((chunk) => request.sourceIds.includes(chunk.sourceId))
      .slice(0, TARGETED_GROUNDING_CHUNK_LIMIT);
    if (chunks.length === 0) {
      outcome.reason = `目标源（${request.sourceIds.join("、")}）无词面命中 chunk——回落弱化 / 删除，不硬配`;
      return outcome;
    }
    for (const chunk of chunks) {
      const quote = selectQuoteWindow(request.claim, chunk.text);
      if (quote === null) {
        outcome.attempts.push({
          sourceId: chunk.sourceId,
          chunkId: chunk.chunkId,
          outcome: "skipped",
          reason: "chunk 过短，切不出有效 quote 窗口",
        });
        continue;
      }
      try {
        const proposed = await this.grounding.propose(projectId, {
          sourceId: chunk.sourceId,
          chunkId: chunk.chunkId,
          claim: request.claim,
          quote,
          proposedBy: "targeted-grounding:m1123",
        });
        const grounded = await this.grounding.ground(projectId, proposed.candidate.candidateId, {
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        });
        outcome.attempts.push({
          sourceId: chunk.sourceId,
          chunkId: chunk.chunkId,
          outcome: grounded.status,
          ...(grounded.reason !== undefined ? { reason: grounded.reason } : {}),
        });
        if (grounded.status === "verified" && grounded.evidenceId !== undefined) {
          outcome.evidenceIds.push(grounded.evidenceId);
          outcome.status = "verified";
          this.log(
            `[targeted-grounding] projectId=${projectId} claim=${request.claimId} verified（${grounded.evidenceId} ← ${chunk.sourceId}）`,
          );
          return outcome; // 第一个 verified 即满足 claim 级需求（成本 bound）
        }
      } catch (error) {
        outcome.attempts.push({
          sourceId: chunk.sourceId,
          chunkId: chunk.chunkId,
          outcome: "failed",
          reason: error instanceof Error ? error.message : String(error),
        });
      }
    }
    if (outcome.evidenceIds.length > 0) {
      outcome.status = "verified";
    } else {
      const anyTried = outcome.attempts.some(
        (attempt) => attempt.outcome === "mismatch" || attempt.outcome === "rejected",
      );
      outcome.status = anyTried || outcome.attempts.length > 0 ? "unverified" : "no_candidate";
      outcome.reason =
        outcome.attempts.length > 0
          ? `${outcome.attempts.length} 个 chunk 尝试均未 verified（quote 逐字 / metadata / semantic judge 如实拒绝）——回落弱化 / 删除`
          : outcome.reason;
    }
    return outcome;
  }
}

/**
 * claim 词面覆盖最大的 chunk 逐字切片（确定性）：
 * 以句子边界为粒度滑动窗口，选 claim token 命中数最多的窗口；无句子边界时
 * 退化为 chunk 头部切片。返回值是 chunk.text 的连续子串（propose 的 quote
 * 逐字核验由既有 Stage 1 保证——切片非合成就不会 mismatch）。
 */
export function selectQuoteWindow(claim: string, chunkText: string): string | null {
  const text = chunkText.trim();
  if (text.length < 20) {
    return text.length > 0 ? text : null;
  }
  const claimTerms = new Set(tokenizeText(claim));
  if (claimTerms.size === 0) {
    return text.slice(0, QUOTE_WINDOW_CHARS);
  }
  const sentences = text.split(/(?<=[。！？.!?])\s+/).filter((part) => part.trim() !== "");
  if (sentences.length <= 1) {
    return text.slice(0, QUOTE_WINDOW_CHARS);
  }
  let best = "";
  let bestHits = -1;
  let start = 0;
  while (start < sentences.length) {
    let window = "";
    let index = start;
    while (index < sentences.length && window.length < QUOTE_WINDOW_CHARS) {
      window = window.length === 0 ? sentences[index]! : `${window} ${sentences[index]!}`;
      index += 1;
    }
    const hits = tokenizeText(window).filter((token) => claimTerms.has(token)).length;
    if (hits > bestHits) {
      bestHits = hits;
      best = window;
    }
    if (bestHits === claimTerms.size) {
      break; // 全覆盖窗口已找到
    }
    start += 1;
  }
  return best.slice(0, 2000);
}
