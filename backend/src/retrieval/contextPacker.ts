/**
 * ContextBudgetPacker（M6.4）：RetrievedChunk[] + token budget → 打包上下文。
 *
 * 目标不是「topK 全塞」，而是在预算内选择最有价值的上下文：
 * - 预算：estimateTextTokens（与 chunk 切分同一估算口径）；
 * - 邻近冗余：同 source 同 section 且 ordinal 相邻（|Δ| ≤ 1）的 chunk 只保留
 *   排名最高者（overlap 使相邻 chunk 大量重复文本）；
 * - 来源多样性：未显式限定 source 时，单一 source 最多占已入选 chunk 的
 *   MAX_SOURCE_SHARE（预算用不完时才允许超额——相关性优先于形式多样）；
 * - 引用标记：每段前缀 [SRC:… CHUNK:… SECTION:… PAGE:…]（M6.5 Evidence
 *   回溯的锚点；M6.4 不做 verification）。
 *
 * 全部规则确定性（同输入恒同输出），策略可测试。
 */

import { estimateTextTokens } from "../runtime/pi/contextBudget.js";
import type { PackedRetrievalContext, RetrievedChunk } from "./types.js";

/** 单一 source 在打包结果中的最大占比（未限定 source 时） */
const MAX_SOURCE_SHARE = 0.5;
/** 多样性上限下的最少保留数（小结果集不被上限掐死） */
const MIN_PER_SOURCE = 2;

/** 引用标记（Agent 输出 → M6.5 回溯的稳定锚点） */
export function chunkCitationMarker(chunk: RetrievedChunk["chunk"]): string {
  const parts = [`SRC:${chunk.sourceId}`, `CHUNK:${chunk.chunkId}`, `SECTION:${chunk.sectionTitle}`];
  if (chunk.pageStart !== undefined) {
    parts.push(
      chunk.pageEnd !== undefined && chunk.pageEnd !== chunk.pageStart
        ? `PAGE:${chunk.pageStart}-${chunk.pageEnd}`
        : `PAGE:${chunk.pageStart}`,
    );
  }
  return `[${parts.join(" ")}]`;
}

export interface PackOptions {
  budgetTokens: number;
  /** 查询显式限定了 source（filter.sourceIds）时关闭来源多样性约束 */
  sourceScoped: boolean;
}

export const DEFAULT_PACK_BUDGET_TOKENS = 6000;

export function packRetrievalContext(
  results: RetrievedChunk[],
  options: PackOptions,
): PackedRetrievalContext {
  const budget = Math.max(1, options.budgetTokens);
  const included: RetrievedChunk[] = [];
  const perSource = new Map<string, number>();
  const includedOrdinals = new Map<string, number[]>(); // sourceId:sectionId → ordinals
  let usedTokens = 0;
  let excludedBudget = 0;
  let excludedAdjacent = 0;
  let excludedDiversity = 0;

  for (const result of results) {
    const { chunk } = result;
    const key = `${chunk.sourceId}:${chunk.sectionId}`;
    const neighbors = includedOrdinals.get(key) ?? [];
    if (neighbors.some((ordinal) => Math.abs(ordinal - chunk.ordinal) <= 1)) {
      excludedAdjacent += 1;
      continue;
    }
    const sourceCount = perSource.get(chunk.sourceId) ?? 0;
    if (
      !options.sourceScoped &&
      included.length >= MIN_PER_SOURCE &&
      sourceCount >= MIN_PER_SOURCE &&
      sourceCount + 1 > Math.ceil(included.length * MAX_SOURCE_SHARE) + 1
    ) {
      excludedDiversity += 1;
      continue;
    }
    const tokens = estimateTextTokens(chunk.text) + estimateTextTokens(chunkCitationMarker(chunk)) + 2;
    if (usedTokens + tokens > budget) {
      excludedBudget += 1;
      continue;
    }
    included.push(result);
    perSource.set(chunk.sourceId, sourceCount + 1);
    includedOrdinals.set(key, [...neighbors, chunk.ordinal]);
    usedTokens += tokens;
  }

  const text = included
    .map((result) => `${chunkCitationMarker(result.chunk)}\n${result.chunk.text}`)
    .join("\n\n");

  return {
    text,
    included,
    usedTokens,
    budgetTokens: budget,
    excluded: { budget: excludedBudget, adjacent: excludedAdjacent, diversity: excludedDiversity },
  };
}
