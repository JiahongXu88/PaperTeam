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
import type { SourceChunk } from "../retrieval/types.js";
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
  /** M14.7：实际执行的语义判定调用数（ground() 次数；maxJudgeCalls 预算的消耗计量） */
  judgeCallsUsed: number;
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
/** anchor 回落：单源最多扫描的 chunk 数（成本 bound；S006=67 / S002=124 量级全覆盖） */
const ANCHOR_FALLBACK_CHUNK_SCAN_LIMIT = 400;

/**
 * M15.8.2（D-2 修复）：claim 的跨语言检索锚——数值与拉丁 token 在中→英（或反向）
 * 转述中逐字存活（「65,213 个像素掩码」↔ "comprise 65,213 pixel masks"），而 CJK
 * bigram 词面通道对中文 claim × 英文 chunk 结构性零命中（M15.8.2 P run r7-r9 实证：
 * ground_existing_source 反复派发、grounding 永远 no_candidate、claim 停在
 * UNSUPPORTED 的死循环）。数值锚要求含千分位/小数分隔或 ≥5 位（避免裸年份
 * "2024" 之类的弱锚）；拉丁锚 ≥3 字符。
 */
export function claimAnchorTokens(claim: string): { numbers: string[]; latin: string[] } {
  const numbers: string[] = [];
  // 分隔符只认 ASCII 的 , 与 .（全角 ，是子句分隔，不是数字的一部分）
  for (const match of claim.matchAll(/\d[\d,.]*\d|\d/g)) {
    const raw = match[0];
    const hasSeparator = /[,.]/.test(raw);
    const digits = raw.replace(/[^0-9]/g, "");
    if (hasSeparator || digits.length >= 5) numbers.push(raw);
  }
  const latin: string[] = [];
  for (const match of claim.matchAll(/[A-Za-z][A-Za-z0-9_-]{2,}/g)) {
    latin.push(match[0]);
  }
  return { numbers: [...new Set(numbers)], latin: [...new Set(latin)] };
}

/** 锚的归一化形态（用于 chunk 内包含判定；全角形式已在提取时排除） */
function anchorVariants(anchor: string): string[] {
  const noSeparator = anchor.replace(/[,.]/g, "");
  return [...new Set([anchor, ...(noSeparator !== anchor ? [noSeparator] : [])])];
}

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

  /** Refresh one source through the existing chunk/index pipeline. */
  async prepareSource(projectId: string, sourceId: string) {
    return this.retrieval.rebuildSource(projectId, sourceId);
  }

  /** Bounded per-claim sampling; provider failures stop the batch. */
  async groundClaims(
    projectId: string,
    requests: readonly TargetedGroundingRequest[],
    options: { signal?: AbortSignal; maxJudgeCalls?: number } = {},
  ): Promise<TargetedGroundingSummary> {
    await this.projects.getRequired(projectId);
    const outcomes: TargetedGroundingOutcome[] = [];
    // M14.7：语义判定调用预算（防 6 claim × 3 chunk 的 judge 突发击穿 run 级模型预算；
    // 未尝试的 claim 不产生 outcome——调用方按「未判定」如实处理，不冒充 rejected）
    const judgeCalls = { used: 0 };
    for (const request of requests) {
      options.signal?.throwIfAborted();
      if (options.maxJudgeCalls !== undefined && judgeCalls.used >= options.maxJudgeCalls) break;
      const outcome = await this.groundClaim(projectId, request, options, judgeCalls);
      outcomes.push(outcome);
      if (outcome.attempts.some((attempt) => /judge_failed|judge_unavailable|rate.limit|429/i.test(attempt.reason ?? ""))) break;
    }
    const verified = outcomes.filter((outcome) => outcome.status === "verified");
    return {
      outcomes,
      verifiedClaims: verified.length,
      verifiedEvidence: verified.reduce((total, outcome) => total + outcome.evidenceIds.length, 0),
      unsupportedByJudge: outcomes.filter(
        (outcome) => outcome.status === "unverified" || outcome.status === "failed",
      ).length,
      judgeCallsUsed: judgeCalls.used,
    };
  }

  private async groundClaim(
    projectId: string,
    request: TargetedGroundingRequest,
    options: { signal?: AbortSignal; maxJudgeCalls?: number },
    judgeCalls: { used: number },
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
    let chunks = search.results
      .map((result) => result.chunk)
      .filter((chunk) => request.sourceIds.includes(chunk.sourceId))
      .slice(0, TARGETED_GROUNDING_CHUNK_LIMIT);
    let anchorFallback = false;
    if (chunks.length === 0) {
      // M15.8.2（D-2）：词面零命中 → 数值/拉丁锚确定性回落（中文 claim × 英文
      // chunk 的跨语言通道）。仍无锚命中 → 如实 no_candidate（回落弱化 / 删除）。
      const fallback = await this.anchorFallbackChunks(projectId, request);
      if (fallback !== null) {
        chunks = fallback;
        anchorFallback = true;
        this.log(
          `[targeted-grounding] projectId=${projectId} claim=${request.claimId} 词面零命中 → 锚回落 ${fallback.length} chunk（判定仍走三段核验）`,
        );
      }
    }
    if (chunks.length === 0) {
      outcome.reason = `目标源（${request.sourceIds.join("、")}）无词面命中 chunk——回落弱化 / 删除，不硬配`;
      return outcome;
    }
    for (const chunk of chunks) {
      options.signal?.throwIfAborted();
      const quote = anchorFallback
        ? (selectAnchorWindow(request.claim, chunk.text) ?? selectQuoteWindow(request.claim, chunk.text))
        : selectQuoteWindow(request.claim, chunk.text);
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
        const status = proposed.candidate.status;
        if (
          status !== "rejected" && status !== "mismatch" &&
          options.maxJudgeCalls !== undefined && judgeCalls.used >= options.maxJudgeCalls
        ) {
          // 预算内停止：本 chunk 不做语义判定（如实记 skipped，不冒充 rejected / unverifiable）
          outcome.attempts.push({
            sourceId: chunk.sourceId,
            chunkId: chunk.chunkId,
            outcome: "skipped",
            reason: `judge 调用预算上限（${options.maxJudgeCalls}）已到——本轮停止语义判定`,
          });
          continue;
        }
        const grounded = status === "rejected" || status === "mismatch"
          ? { status, reason: proposed.candidate.statusReason }
          : await (async () => {
              judgeCalls.used += 1;
              return this.grounding.ground(projectId, proposed.candidate.candidateId, {
                retry: status === "unverifiable",
                ...(options.signal !== undefined ? { signal: options.signal } : {}),
              });
            })();
        outcome.attempts.push({
          sourceId: chunk.sourceId,
          chunkId: chunk.chunkId,
          outcome: grounded.status,
          ...(grounded.reason !== undefined ? { reason: grounded.reason } : {}),
        });
        if (/judge_failed|judge_unavailable|rate.limit|429/i.test(grounded.reason ?? "")) {
          outcome.status = "unverified";
          return outcome;
        }
        if (grounded.status === "verified" && "evidenceId" in grounded && grounded.evidenceId !== undefined) {
          outcome.evidenceIds.push(grounded.evidenceId);
          outcome.status = "verified";
          this.log(
            `[targeted-grounding] projectId=${projectId} claim=${request.claimId} verified（${grounded.evidenceId} ← ${chunk.sourceId}）`,
          );
          return outcome; // 第一个 verified 即满足 claim 级需求（成本 bound）
        }
      } catch (error) {
        options.signal?.throwIfAborted();
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

  /**
   * M15.8.2（D-2）：词面零命中时的锚回落候选——目标源 chunks 中包含 claim 数值锚
   * （归一化子串）或拉丁锚（词边界、大小写不敏感）的 chunk。确定性排序：数值命中
   * 优先、拉丁命中数降序、chunkId 字典序稳定；≤ CHUNK_LIMIT。无锚或无命中 → null
   * （调用方保持 no_candidate）。chunk 访问经 RetrievalService.readSourceChunks
   * （feature-detect：缺该方法 = 无回落通道，行为同旧版）。
   */
  private async anchorFallbackChunks(
    projectId: string,
    request: TargetedGroundingRequest,
  ): Promise<SourceChunk[] | null> {
    const reader = (this.retrieval as RetrievalService & {
      readSourceChunks?: (projectId: string, sourceIds: readonly string[]) => Promise<SourceChunk[] | null>;
    }).readSourceChunks;
    if (typeof reader !== "function") {
      return null;
    }
    const anchors = claimAnchorTokens(request.claim);
    if (anchors.numbers.length === 0 && anchors.latin.length === 0) {
      return null;
    }
    let pool: SourceChunk[];
    try {
      const read = await reader.call(this.retrieval, projectId, request.sourceIds);
      if (read === null || read.length === 0) {
        return null;
      }
      pool = read.slice(0, ANCHOR_FALLBACK_CHUNK_SCAN_LIMIT * request.sourceIds.length);
    } catch {
      return null; // 回落通道失败 = 保持词面结论（no_candidate），不升级为 failed
    }
    const numberVariants = anchors.numbers.flatMap(anchorVariants);
    const latinLower = anchors.latin.map((token) => token.toLowerCase());
    const ranked = pool
      .map((chunk) => {
        const text = chunk.text;
        let numberHits = 0;
        for (const variant of numberVariants) {
          if (text.includes(variant)) numberHits += 1;
        }
        const latinHits = latinLower.filter((token) =>
          new RegExp(`(?<![A-Za-z0-9_-])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![A-Za-z0-9_-])`, "i").test(text),
        ).length;
        return { chunk, numberHits, latinHits };
      })
      .filter((hit) => hit.numberHits > 0 || hit.latinHits > 0)
      .sort(
        (a, b) =>
          b.numberHits - a.numberHits ||
          b.latinHits - a.latinHits ||
          (a.chunk.chunkId < b.chunk.chunkId ? -1 : 1),
      )
      .slice(0, TARGETED_GROUNDING_CHUNK_LIMIT)
      .map((hit) => hit.chunk);
    return ranked.length > 0 ? ranked : null;
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
  const starts = [0, ...Array.from(text.matchAll(/(?<=[。！？.!?])\s+/g), (match) => match.index! + match[0].length)];
  let best = text.slice(0, QUOTE_WINDOW_CHARS);
  let bestHits = -1;
  for (const start of starts) {
    const window = text.slice(start, start + QUOTE_WINDOW_CHARS);
    const hits = new Set(tokenizeText(window).filter((token) => claimTerms.has(token))).size;
    if (hits > bestHits) {
      bestHits = hits;
      best = window;
    }
    if (bestHits === claimTerms.size) break;
  }
  return best.slice(0, 2000);
}

/**
 * M15.8.2（D-2）：锚居中的 quote 窗口——词面通道零命中时 selectQuoteWindow 只能退化为
 * chunk 头部切片，锚句可能落在窗外。这里以首个锚（数值优先）出现位置为中心，向两侧
 * 扩到句子边界，目标长度 QUOTE_WINDOW_CHARS（逐字切片，同 selectQuoteWindow 的非合成
 * 约束；无锚命中 → null 交回调用方走旧路径）。
 */
export function selectAnchorWindow(claim: string, chunkText: string): string | null {
  const text = chunkText.trim();
  if (text.length === 0) {
    return null;
  }
  const anchors = claimAnchorTokens(claim);
  const ordered = [
    ...anchors.numbers.flatMap(anchorVariants),
    ...anchors.latin.map((token) => token.toLowerCase()),
  ];
  let anchorIndex = -1;
  for (const anchor of ordered) {
    const at = text.toLowerCase().indexOf(anchor.toLowerCase());
    if (at >= 0 && (anchorIndex === -1 || at < anchorIndex)) {
      anchorIndex = at;
    }
  }
  if (anchorIndex === -1) {
    return null;
  }
  // 从锚位向前找最近的句子边界作窗口起点（保持锚尽量靠前部，留出右侧上下文）
  const before = text.slice(0, anchorIndex);
  const boundary = before.matchAll(/(?<=[。！？.!?])\s+/g);
  let start = 0;
  for (const match of boundary) {
    start = match.index! + match[0].length;
  }
  start = Math.max(0, Math.min(start, Math.max(0, anchorIndex - Math.floor(QUOTE_WINDOW_CHARS / 3))));
  return text.slice(start, start + QUOTE_WINDOW_CHARS).slice(0, 2000);
}
