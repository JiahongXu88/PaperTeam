/**
 * Deterministic Fact Restore（M10.3.1 G1 §8：确定性恢复冻结基线段落）。
 *
 * 累计未授权漂移的默认处置不是无限请求 Writer「请改回来」（M10.3 已证明
 * 模型会把读起来合理的内容当既有事实保留），而是在**可可靠定位**时直接
 * 恢复冻结基线段落。克制边界（任务 §8）：
 * - 只做段落级（空行分隔块）整段替换：定位 = 违规数值锚点（当前稿唯一
 *   含该值的段落）+ 冻结稿同文件最佳相似段落（词面 Jaccard，须有明确
 *   领先幅度；changed 类还要求冻结段落含旧值）；
 * - 不做 diff patch engine / 模糊文本猜测 / LLM restore；
 * - 当前段落含冻结段落所没有的 \\cite（恢复会连带删引用）→ 不恢复；
 * - 任一定位歧义 → 不恢复，保持 gate FAIL + needs_user_confirmation。
 */

import type { FactFinding, FactTexFile } from "./factPreservation.js";
import { normalizeNumericToken } from "./factPreservation.js";
import { tokenizeText } from "../retrieval/tokenize.js";

/** 段落（连续非空行块；保留原文行） */
interface Paragraph {
  /** 起始行号（0 基） */
  startLine: number;
  lines: string[];
}

function splitParagraphs(content: string): Paragraph[] {
  const lines = content.replace(/\r\n/g, "\n").split("\n");
  const paragraphs: Paragraph[] = [];
  let current: string[] = [];
  let start = 0;
  for (const [index, line] of lines.entries()) {
    if (line.trim() === "") {
      if (current.length > 0) {
        paragraphs.push({ startLine: start, lines: current });
        current = [];
      }
      start = index + 1;
    } else {
      if (current.length === 0) {
        start = index;
      }
      current.push(line);
    }
  }
  if (current.length > 0) {
    paragraphs.push({ startLine: start, lines: current });
  }
  return paragraphs;
}

function paragraphText(paragraph: Paragraph): string {
  return paragraph.lines.join("\n");
}

function termSet(text: string): Set<string> {
  return new Set(tokenizeText(text));
}

function jaccard(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  if (a.size === 0 && b.size === 0) {
    return 0;
  }
  let intersection = 0;
  for (const term of a) {
    if (b.has(term)) {
      intersection += 1;
    }
  }
  const union = a.size + b.size - intersection;
  return union === 0 ? 0 : intersection / union;
}

/** 词边界安全的数值包含（段落文本归一后匹配 token；与授权匹配同源思想）。
 * LaTeX 转义（26.1\% 的反斜杠）会切断 token 与 % 的邻接——先剥离反斜杠再匹配 */
function containsNumericToken(text: string, token: string): boolean {
  const normalized = normalizeNumericToken(token);
  if (normalized === "") {
    return false;
  }
  const escaped = normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(?<![\\w.])${escaped}(?![\\w.])`).test(text.replace(/\\/g, "").replace(/,/g, ""));
}

/** 段落中的 \cite keys（恢复守卫：不能连带删引用） */
function citationKeysOf(text: string): Set<string> {
  const keys = new Set<string>();
  for (const match of text.matchAll(/\\(?:cite|citep|citet|citealp|parencite|textcite|autocite)\*?(?:\[[^\]\n]*\])*\{([^{}]*)\}/g)) {
    for (const key of (match[1] ?? "").split(",")) {
      const trimmed = key.trim();
      if (trimmed !== "") {
        keys.add(trimmed);
      }
    }
  }
  return keys;
}

/**
 * 数值锚点（changed → oldValue/newValue 对；added → newValue；removed →
 * oldValue，锚点在冻结稿侧）。
 * M11.4 Reliability Closure（8b 实证：p-e4f0737aa7e4 引言 56.8\% AP 被删除，
 * restorable=false → 唯一修复路径是 Writer 且失败 → run 级 permanent FAIL）：
 * removed 类此前被显式排除。恢复方向 = 冻结稿中含被删值的段落（唯一锚点）
 * → 当前稿最佳相似段落（Jaccard + 领先幅度）→ 整段替换回冻结段落。
 */
function numericAnchors(
  finding: FactFinding,
): { anchor: string; requiresFrozenOld?: string; restoreKind: "changed" | "added" | "removed" } | null {
  const classification = finding.classification;
  if (classification === undefined) {
    return null;
  }
  if (finding.kind === "changed") {
    if (classification.oldValue === undefined || classification.newValue === undefined) {
      return null;
    }
    return { anchor: classification.newValue, requiresFrozenOld: classification.oldValue, restoreKind: "changed" };
  }
  if (finding.kind === "added_unsupported") {
    if (classification.newValue === undefined) {
      return null;
    }
    return { anchor: classification.newValue, restoreKind: "added" };
  }
  if (finding.kind === "removed") {
    if (classification.oldValue === undefined || classification.oldValue.trim() === "") {
      return null;
    }
    return { anchor: classification.oldValue, restoreKind: "removed" };
  }
  return null; // directional / formula / placeholder：不做段落恢复
}

export interface RestorableSpan {
  file: string;
  /** 当前稿中被替换的段落（原文行；写回时逐行替换） */
  currentParagraph: string;
  /** 冻结基线段落（恢复内容） */
  frozenParagraph: string;
  /** 本恢复解决的违规 key（cumulativeViolationKey） */
  resolves: string[];
}

export interface SkippedViolation {
  violationKey: string;
  reason: string;
  detail: string;
}

export interface FactRestorePlan {
  restorable: RestorableSpan[];
  skipped: SkippedViolation[];
}

/** 相似度门槛：低于此值认为冻结段落对不上（宁可 needs_user_confirmation） */
const MIN_SIMILARITY = 0.3;
/** 最佳与次佳相似度差：低于此值认为匹配歧义 */
const MIN_MARGIN = 0.08;

/**
 * 规划确定性恢复（纯函数）。输入违规必须来自 Frozen → Current 的累计校验
 * （violationKey 由调用方附加）。
 */
export function planFactRestore(
  frozenFiles: readonly FactTexFile[],
  currentFiles: readonly FactTexFile[],
  violations: readonly (FactFinding & { violationKey: string })[],
): FactRestorePlan {
  const restorable: RestorableSpan[] = [];
  const skipped: SkippedViolation[] = [];
  const frozenByFile = new Map(frozenFiles.map((file) => [file.file, file.content.replace(/\r\n/g, "\n")]));
  const currentByFile = new Map(currentFiles.map((file) => [file.file, file.content.replace(/\r\n/g, "\n")]));
  // 已被某恢复覆盖的当前段落（同段多违规一次解决；恢复目标段落不再重复替换）
  const claimedParagraphs = new Set<string>();

  for (const finding of violations) {
    const anchors = numericAnchors(finding);
    if (anchors === null) {
      skipped.push({
        violationKey: finding.violationKey,
        reason: "not_value_scoped",
        detail: `${finding.reason}（方向 / 公式 / 占位类违规不做确定性段落恢复）`,
      });
      continue;
    }
    const currentContent = currentByFile.get(finding.file);
    const frozenContent = frozenByFile.get(finding.file);
    if (currentContent === undefined || frozenContent === undefined) {
      skipped.push({
        violationKey: finding.violationKey,
        reason: "file_scope",
        detail: "违规涉及冻结稿中不存在（或当前已删除）的文件，不做文件级恢复",
      });
      continue;
    }
    /**
     * M11.4 Reliability Closure：removed 类违规的确定性恢复（方向与 changed /
     * added 相反——锚点值只存在于冻结稿）。定位 = 冻结稿中唯一含被删值的段落
     * + 当前稿同文件最佳相似段落（词面 Jaccard，须有明确领先幅度）；引用守卫
     * 与其它类一致（当前段落新增的 \cite 不能被恢复连带删除）。任一定位歧义
     * → 不恢复，保持 gate FAIL + needs_user_confirmation。
     */
    if (anchors.restoreKind === "removed") {
      const frozenParagraphs = splitParagraphs(frozenContent);
      const frozenHits = frozenParagraphs.filter((paragraph) =>
        containsNumericToken(paragraphText(paragraph), anchors.anchor),
      );
      if (frozenHits.length === 0) {
        skipped.push({
          violationKey: finding.violationKey,
          reason: "frozen_anchor_not_found",
          detail: `冻结稿中未定位到含被删值 ${anchors.anchor} 的段落`,
        });
        continue;
      }
      if (frozenHits.length > 1) {
        skipped.push({
          violationKey: finding.violationKey,
          reason: "frozen_anchor_ambiguous",
          detail: `冻结稿中 ${frozenHits.length} 个段落含被删值 ${anchors.anchor}，无法唯一归属`,
        });
        continue;
      }
      const frozenParagraphText = paragraphText(frozenHits[0]!);
      const frozenTerms = termSet(frozenParagraphText);
      const currentParagraphs = splitParagraphs(currentContent);
      let best: { paragraph: Paragraph; similarity: number } | null = null;
      let secondBest = 0;
      for (const candidate of currentParagraphs) {
        const candidateText = paragraphText(candidate);
        if (candidateText === frozenParagraphText) {
          continue; // 完全相同：值应存在，不是漂移载体
        }
        if (containsNumericToken(candidateText, anchors.anchor)) {
          continue; // 该段已含此值（重复出现侧）：不是丢失载体
        }
        const similarity = jaccard(frozenTerms, termSet(candidateText));
        if (best === null || similarity > best.similarity) {
          secondBest = best?.similarity ?? secondBest;
          best = { paragraph: candidate, similarity };
        } else if (similarity > secondBest) {
          secondBest = similarity;
        }
      }
      if (best === null || best.similarity < MIN_SIMILARITY || best.similarity - secondBest < MIN_MARGIN) {
        skipped.push({
          violationKey: finding.violationKey,
          reason: "current_match_ambiguous",
          detail: `当前稿中无足够相似且唯一领先的段落（best=${best?.similarity.toFixed(2) ?? "无"} / margin=${best !== null ? (best.similarity - secondBest).toFixed(2) : "无"}；被删值 ${anchors.anchor}）`,
        });
        continue;
      }
      const currentText = paragraphText(best.paragraph);
      const claimKey = `${finding.file}|${best.paragraph.startLine}`;
      if (claimedParagraphs.has(claimKey)) {
        continue;
      }
      const lostCitations = [...citationKeysOf(currentText)].filter(
        (key) => !citationKeysOf(frozenParagraphText).has(key),
      );
      if (lostCitations.length > 0) {
        skipped.push({
          violationKey: finding.violationKey,
          reason: "would_lose_citations",
          detail: `恢复将连带删除当前段落新增引用：${lostCitations.slice(0, 4).join("、")}`,
        });
        continue;
      }
      claimedParagraphs.add(claimKey);
      restorable.push({
        file: finding.file,
        currentParagraph: currentText,
        frozenParagraph: frozenParagraphText,
        resolves: [finding.violationKey],
      });
      continue;
    }
    // 1. 当前段落定位：唯一包含新值锚点的段落
    const currentParagraphs = splitParagraphs(currentContent);
    const anchorHits = currentParagraphs.filter((paragraph) =>
      containsNumericToken(paragraphText(paragraph), anchors.anchor),
    );
    if (anchorHits.length === 0) {
      skipped.push({
        violationKey: finding.violationKey,
        reason: "anchor_not_found",
        detail: `当前稿中未定位到含 ${anchors.anchor} 的段落`,
      });
      continue;
    }
    if (anchorHits.length > 1) {
      skipped.push({
        violationKey: finding.violationKey,
        reason: "anchor_ambiguous",
        detail: `当前稿中 ${anchorHits.length} 个段落含 ${anchors.anchor}，无法唯一归属`,
      });
      continue;
    }
    const currentParagraph = anchorHits[0]!;
    const currentText = paragraphText(currentParagraph);
    const claimKey = `${finding.file}|${currentParagraph.startLine}`;
    if (claimedParagraphs.has(claimKey)) {
      continue; // 该段恢复已规划（其它违规随之解决，不重复登记）
    }
    // 2. 冻结候选段落：同文件最佳相似（changed 类还须含旧值）
    const frozenParagraphs = splitParagraphs(frozenContent);
    const currentTerms = termSet(currentText);
    let best: { paragraph: Paragraph; similarity: number } | null = null;
    let secondBest = 0;
    for (const candidate of frozenParagraphs) {
      const candidateText = paragraphText(candidate);
      if (candidateText === currentText) {
        continue; // 完全相同：不是漂移载体
      }
      if (anchors.requiresFrozenOld !== undefined && !containsNumericToken(candidateText, anchors.requiresFrozenOld)) {
        continue; // changed 违规：冻结段落必须含旧值（恢复方向正确性）
      }
      const similarity = jaccard(currentTerms, termSet(candidateText));
      if (best === null || similarity > best.similarity) {
        secondBest = best?.similarity ?? secondBest;
        best = { paragraph: candidate, similarity };
      } else if (similarity > secondBest) {
        secondBest = similarity;
      }
    }
    if (best === null || best.similarity < MIN_SIMILARITY || best.similarity - secondBest < MIN_MARGIN) {
      skipped.push({
        violationKey: finding.violationKey,
        reason: "frozen_match_ambiguous",
        detail: `冻结稿中无足够相似且唯一领先的段落（best=${best?.similarity.toFixed(2) ?? "无"} / margin=${best !== null ? (best.similarity - secondBest).toFixed(2) : "无"}）`,
      });
      continue;
    }
    // 3. 引用守卫：当前段落新增的 \cite 不能被恢复连带删除
    const frozenText = paragraphText(best.paragraph);
    const lostCitations = [...citationKeysOf(currentText)].filter(
      (key) => !citationKeysOf(frozenText).has(key),
    );
    if (lostCitations.length > 0) {
      skipped.push({
        violationKey: finding.violationKey,
        reason: "would_lose_citations",
        detail: `恢复将连带删除当前段落新增引用：${lostCitations.slice(0, 4).join("、")}`,
      });
      continue;
    }
    claimedParagraphs.add(claimKey);
    restorable.push({
      file: finding.file,
      currentParagraph: currentText,
      frozenParagraph: frozenText,
      resolves: [finding.violationKey],
    });
  }
  return { restorable, skipped };
}

/**
 * 恢复跨段的数值增删清单（恢复 stage 并入 fact_preserve 条目的 factRestore）：
 * 恢复把漂移段替换回冻结段——漂移段里有、冻结段没有的值会被连带删除
 * （pairwise 下一轮按 removal 计），冻结段新加回的值按 addition 计。
 * 这些连带变化是恢复动作本身的确定性结果，须授权，否则恢复后 pairwise 误报。
 */
export function restoreValueDelta(
  currentParagraph: string,
  frozenParagraph: string,
): { restoreValues: string[]; removeValues: string[] } {
  const runs = (text: string): string[] =>
    [...text.replace(/,/g, "").matchAll(/[-−]?[\d.]+/g)]
      .map((match) => normalizeNumericToken(match[0] ?? ""))
      .filter((token) => token !== "" && /\d/.test(token));
  const before = runs(currentParagraph);
  const after = runs(frozenParagraph);
  const counts = new Map<string, number>();
  for (const token of before) {
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  for (const token of after) {
    const count = counts.get(token) ?? 0;
    counts.set(token, count - 1);
  }
  const removeValues: string[] = [];
  const restoreValues: string[] = [];
  for (const [token, count] of counts) {
    if (count > 0) {
      for (let i = 0; i < count; i += 1) {
        removeValues.push(token);
      }
    } else if (count < 0) {
      for (let i = 0; i < -count; i += 1) {
        restoreValues.push(token);
      }
    }
  }
  return { restoreValues, removeValues };
}

/** 应用恢复计划（纯函数：返回被修改的文件内容；未修改文件不入结果） */
export function applyFactRestore(
  currentFiles: readonly FactTexFile[],
  plan: FactRestorePlan,
): FactTexFile[] {
  if (plan.restorable.length === 0) {
    return [];
  }
  const byFile = plan.restorable.reduce<Map<string, string[]>>((map, span) => {
    const list = map.get(span.file) ?? [];
    list.push(span.currentParagraph, span.frozenParagraph);
    map.set(span.file, list);
    return map;
  }, new Map<string, string[]>());
  const changed: FactTexFile[] = [];
  for (const file of currentFiles) {
    const pairs = byFile.get(file.file);
    if (pairs === undefined) {
      continue;
    }
    let content = file.content.replace(/\r\n/g, "\n");
    for (let index = 0; index < pairs.length; index += 2) {
      const currentParagraph = pairs[index]!;
      const frozenParagraph = pairs[index + 1]!;
      if (!content.includes(currentParagraph)) {
        continue; // 段落已不在（并发修改）：跳过，如实留给 gate 复核
      }
      content = content.replace(currentParagraph, frozenParagraph);
    }
    if (content !== file.content.replace(/\r\n/g, "\n")) {
      changed.push({ file: file.file, content: `${content.replace(/\s+$/, "")}\n` });
    }
  }
  return changed;
}
