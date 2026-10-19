/**
 * M14.9.3 P0-A：输入保真 / 盲化 / 可评分性联合门（零模型、确定性）。
 *
 * 保留侧（M14.9.1 等价门）之外补齐：
 *   1. 删除侧审计——每个未出现在投影中的源块必须由授权删除解释，且被删文本扣除元数据签名后
 *      不得「像正文」；标题 / 题注永不可删（他文混排除外）。授权删除被排除在清单外从此不再是盲区；
 *   2. 有序覆盖——源块按独立版面阅读顺序在投影中的锚点必须单调（LIS）；同一投影段落只能拼接
 *      源顺序上相邻的正文块（跨越其他正文块的拼接 = 不相邻段落被重排成一个论证链）；
 *   3. 反向可追溯——他文混排内容不得出现在投影中；参考文献条目与编号序列一致；
 *   4. 表格单元位置（文本层逐词坐标独立复原）、公式结构（上下标 / 叠行 / 分段字形）、图占位、
 *      行内上下标、身份残留。
 * 不要求逐字节相同：比较在规范化文本（NFKC、去空白标点）上进行，允许字体映射与空白差异。
 */

import { createHash } from "node:crypto";

import { buildGramIndex, canon, canonWithMap, cjkCount, looksLikeBody, looksLikeNameList, residualBody, LABELED_PROSE_FIELD, METADATA_SIGNATURES, type GramIndex } from "./inputFidelityText.js";
import { checkTable, parseMarkdownTables } from "./inputFidelityTables.js";
import {
  AUTHORIZED_DELETION_KINDS, INPUT_FIDELITY_REPORT_SCHEMA,
  type Box, type DeletionAudit, type DeletionEntry, type FidelityFinding, type FidelityProjectionInput, type FidelityStatus,
  type FormulaCheck, type InputFidelityReport, type SourceBlock, type SourceEvidence,
} from "./inputFidelityTypes.js";

export * from "./inputFidelityTypes.js";

const GRAM = 6;
export const FORMULA_UNVERIFIED_MARKER = "FORMULA_UNVERIFIED";
const FIGURE_MARKER = "FIGURE_CONTENT_NOT_EVALUATED";
/** 文本层把 Symbol 字体的括号分段字形映射成的 Latin-1 字符 / 替换符 / 私用区字形 */
const GARBLED_GLYPHS = /[ìíîïþýÿ�-]/;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");

/** 盲化稿正文中不应出现的投稿元数据形态（基金项目编号、邮箱、收稿 / 修回日期、作者简介标签） */
const METADATA_RESIDUE = /[\w.%+-]+@[\w-]+(\.[\w-]+)*\.[A-Za-z]{2,}|(Foundation|Fund|基金|资助).{0,120}?[(（]\s*[A-Za-z0-9][A-Za-z0-9‐\-\s]{5,}[)）]|收稿日期|修回日期|作者简介|Corresponding author/i;

interface Coverage {
  canonLength: number;
  coveredChars: number;
  anchor: number | null;
  /** 未覆盖原文片段（按源文本偏移还原，用于删除侧审计） */
  uncoveredText: string;
  /** 锚点唯一：最高票偏移明显领先第二候选（摘要与正文重复的句子不会被当作顺序证据） */
  anchorUnique: boolean;
}

const LATIN_WORD = /[A-Za-z][A-Za-z'-]*/g;

/**
 * 拉丁文字为主的源块按词袋覆盖：部分 PDF 的英文文本层逐词定位（两端对齐 / 词序与版面不一致），
 * 字符 n-gram 会因词序把完整保留的文本误判为丢失。锚点仍取 n-gram 投票（不可靠时不参与顺序判定）。
 */
function latinCoverage(text: string, projectionWords: ReadonlyMap<string, number>, gram: Coverage, projectionCanon: string, projectionBigrams?: ReadonlySet<string>): Coverage {
  const words = (text.normalize("NFKC").match(LATIN_WORD) ?? []).map((word) => word.toLowerCase());
  const present = (word: string) => (projectionWords.get(word) ?? 0) > 0 || (word.length >= 4 && projectionCanon.includes(word.replace(/['-]/g, "")));
  let covered = 0;
  let total = 0;
  const missing: string[] = [];
  words.forEach((word, k) => {
    total += word.length;
    // 断词差异（「mul timedia」↔「multimedia」）：与相邻词拼接后存在也算保留
    if (present(word) || (k + 1 < words.length && present(word + words[k + 1]!)) || (k > 0 && present(words[k - 1]! + word))) covered += word.length;
    else missing.push(word);
  });
  let ratio = total === 0 ? 0 : covered / total;
  // 长段英文（摘要等）必须有词序证据：单词袋会被英文题名 / 关键词 / 参考文献里的同词撑高
  if (words.length >= 40 && projectionBigrams !== undefined) {
    let pairs = 0;
    let hit = 0;
    for (let k = 0; k + 1 < words.length; k += 1) {
      pairs += 1;
      if (projectionBigrams.has(`${words[k]} ${words[k + 1]}`) || (k + 2 < words.length && projectionBigrams.has(`${words[k]}${words[k + 1]} ${words[k + 2]}`))) hit += 1;
    }
    ratio = Math.min(ratio, pairs === 0 ? 0 : hit / pairs / 0.9);
  }
  // 大部分未保留时以整块原文作为被删文本（词袋缺词列表没有句读，无法做正文判据）
  return { ...gram, coveredChars: Math.round(ratio * gram.canonLength), uncoveredText: ratio < 0.5 ? text : missing.join(" ") };
}

function isLatinDominant(text: string): boolean {
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  return latin >= 10 && cjkCount(text) < latin * 0.2;
}

/** 源文本在投影规范串中的逐字符覆盖（任一命中 n-gram 覆盖其全部字符）+ 偏移投票锚点 */
function coverage(text: string, projectionCanon: string, index: GramIndex): Coverage {
  const { canon: needle, map } = canonWithMap(text);
  if (needle.length === 0) return { canonLength: 0, coveredChars: 0, anchor: null, uncoveredText: "", anchorUnique: false };
  const mask = new Array<boolean>(needle.length).fill(false);
  let anchor: number | null = null;
  let anchorUnique = false;
  if (needle.length < GRAM) {
    const at = projectionCanon.indexOf(needle);
    if (at >= 0) {
      mask.fill(true);
      anchor = at;
      anchorUnique = projectionCanon.indexOf(needle, at + 1) < 0;
    }
  } else {
    const votes = new Map<number, number>();
    for (let at = 0; at + GRAM <= needle.length; at += 1) {
      const positions = index.get(needle.slice(at, at + GRAM));
      if (positions === undefined) continue;
      for (let k = at; k < at + GRAM; k += 1) mask[k] = true;
      for (const position of positions) votes.set(position - at, (votes.get(position - at) ?? 0) + 1);
    }
    let best = 0;
    for (const [start, count] of votes) {
      if (count > best || (count === best && anchor !== null && start < anchor)) {
        best = count;
        anchor = start;
      }
    }
    // 第二候选：与最高票偏移相距超过块长的偏移的最高票数
    let second = 0;
    for (const [start, count] of votes) if (anchor !== null && Math.abs(start - anchor) > needle.length && count > second) second = count;
    anchorUnique = anchor !== null && best >= 0.5 * (needle.length - GRAM + 1) && second < 0.5 * best;
    if (anchor !== null) anchor = Math.max(0, anchor);
  }
  const runs: string[] = [];
  let start = -1;
  for (let k = 0; k <= needle.length; k += 1) {
    if (k < needle.length && !mask[k]) {
      if (start < 0) start = k;
    } else if (start >= 0) {
      runs.push(text.slice(map[start]!, map[k - 1]! + 1));
      start = -1;
    }
  }
  return { canonLength: needle.length, coveredChars: mask.filter(Boolean).length, anchor, uncoveredText: runs.join(" / "), anchorUnique };
}

function overlapArea(a: Box, b: Box): number {
  const w = Math.min(a[2], b[2]) - Math.max(a[0], b[0]);
  const h = Math.min(a[3], b[3]) - Math.max(a[1], b[1]);
  return w > 0 && h > 0 ? w * h : 0;
}

/** 删除条目是否解释该源块：同页 bbox 覆盖源块 ≥50%，或删除摘录与源块文本互含 */
function deletionExplains(entry: DeletionEntry, block: SourceBlock): boolean {
  if (entry.sourceBlockIds?.includes(block.id) === true) return true;
  if (entry.page !== null && entry.page !== block.page) return false;
  if (entry.bbox !== undefined && entry.bbox !== null) {
    const area = Math.max(1e-6, (block.bbox[2] - block.bbox[0]) * (block.bbox[3] - block.bbox[1]));
    if (overlapArea(entry.bbox, block.bbox) / area >= 0.5) return true;
  }
  if (entry.excerpt === undefined || entry.excerpt.trim() === "") return false;
  const excerpt = canon(entry.excerpt);
  const own = canon(block.text);
  if (own.length === 0 || excerpt.length < 4) return false;
  if (excerpt.includes(own) || own.includes(excerpt)) return true;
  return own.length >= 30 && excerpt.length >= 30 && own.includes(excerpt.slice(0, 30));
}

/** 被删文本是否属于授权元数据（被删文本取自**源**，不信任转写器摘录） */
function auditDeletedText(kind: string, sourceBlock: SourceBlock, removedRaw: string): { ok: boolean; reason: string } {
  // 全角 ASCII（「ＤＯＩ」「Ｓｃｈｏｏｌ」）按 NFKC 归一后再匹配字段签名
  const block = { ...sourceBlock, text: sourceBlock.text.normalize("NFKC") };
  const removed = removedRaw.normalize("NFKC");
  if (!(AUTHORIZED_DELETION_KINDS as readonly string[]).includes(kind)) return { ok: false, reason: `删除种类 ${kind} 不在授权闭集内` };
  if (block.zone === "foreign") return kind === "foreign_article_content" || kind === "layout_continuation_marker" || kind === "running_header"
    ? { ok: true, reason: "同页混排的他文内容（续页标记界定）" }
    : { ok: true, reason: `他文区域（种类 ${kind}）` };
  if (block.role === "heading") return { ok: false, reason: "章节标题不可作为元数据删除" };
  if (block.role === "caption") return { ok: false, reason: "图表题注不可作为元数据删除" };
  if (block.role === "reference") return { ok: false, reason: "参考文献条目不可作为元数据删除" };
  if (kind === "foreign_article_content") return { ok: false, reason: "本文正文区被标为他文内容" };
  // 作者贡献 / 利益冲突 / 致谢：以字段标签开头的整块是该字段本身（删除限于本块，不延续到后续块）
  if ((kind === "author_contribution" || kind === "acknowledgement") && LABELED_PROSE_FIELD.test(block.text)) return { ok: true, reason: "以字段标签开头的作者贡献 / 致谢块" };
  const residual = residualBody(removed);
  if (looksLikeBody(residual)) return { ok: false, reason: `扣除元数据签名后仍有正文 ${cjkCount(residual)} 汉字：${residual.slice(0, 60)}` };
  // 字段签名看整块源文本（被删的可能只是基金编号等片段），正文判据只看被删部分
  const signed = Object.values(METADATA_SIGNATURES).some((pattern) => pattern.test(block.text));
  if (signed || looksLikeNameList(removed) || looksLikeNameList(block.text) || block.zone === "margin" || canon(removed).length <= 6) return { ok: true, reason: signed ? "命中投稿元数据字段签名" : "署名 / 版边 / 极短片段" };
  if (block.page === 1 && block.text.length < 30 && !/[。，；]/.test(block.text) && block.bbox[1] < 130) return { ok: true, reason: "首页版头栏目标识" };
  return { ok: cjkCount(removed) < 10 && canon(removed).length < 24, reason: `无元数据签名的删除片段（${canon(removed).length} 字符）` };
}

/** 最长递增子序列（返回不在 LIS 中的下标集合） */
function outsideLis(values: readonly number[]): Set<number> {
  const tails: number[] = [];
  const tailIndex: number[] = [];
  const parent = new Array<number>(values.length).fill(-1);
  values.forEach((value, index) => {
    let lo = 0;
    let hi = tails.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (tails[mid]! < value) lo = mid + 1;
      else hi = mid;
    }
    tails[lo] = value;
    tailIndex[lo] = index;
    parent[index] = lo > 0 ? tailIndex[lo - 1]! : -1;
  });
  const keep = new Set<number>();
  let at = tails.length > 0 ? tailIndex[tails.length - 1]! : -1;
  while (at >= 0) {
    keep.add(at);
    at = parent[at]!;
  }
  return new Set(values.map((_value, index) => index).filter((index) => !keep.has(index)));
}

/** 投影中的展示公式段（$$…$$ 或带 FORMULA_UNVERIFIED 标记的行） */
function projectedFormulas(text: string): Array<{ offset: number; body: string }> {
  const out: Array<{ offset: number; body: string }> = [];
  for (const match of text.matchAll(/\$\$([\s\S]*?)\$\$/g)) out.push({ offset: match.index!, body: match[1]! });
  return out;
}

function referenceNumbersInProjection(text: string): number[] {
  const heading = [...text.matchAll(/^#{1,6}\s*(参\s*考\s*文\s*献|References?)(?![A-Za-z]).*$/gim)].pop();
  if (heading === undefined) return [];
  const tail = text.slice(heading.index! + heading[0].length);
  const end = tail.search(/^#{1,6}\s/m);
  const section = end >= 0 ? tail.slice(0, end) : tail;
  return [...section.matchAll(/^\s*(?:-\s*)?[[［]\s*(\d{1,3})\s*[\]］]/gm)].map((match) => Number(match[1]));
}

function headingDepth(text: string): number | null {
  const match = /^\s*(\d+(?:\s*[.．]\s*\d+)*)(?![\d.．])/.exec(text);
  return match === null ? null : match[1]!.split(/[.．]/).length;
}

export interface EvaluateInputFidelityOptions {
  /** 人工 QA 已复核并签发的页 / 区域说明（只记录，不改变自动判定） */
  notes?: string[];
}

/** 输入保真联合门：源证据 × 投影 × 删除清单 → 状态 + 可审计明细 */
export function evaluateInputFidelity(source: SourceEvidence, projection: FidelityProjectionInput, _options: EvaluateInputFidelityOptions = {}): InputFidelityReport {
  const findings: FidelityFinding[] = [];
  const add = (finding: FidelityFinding) => findings.push(finding);
  const text = projection.text.replace(/\r\n?/g, "\n");
  const { canon: projectionCanon, map: projectionMap } = canonWithMap(text);
  const index = buildGramIndex(projectionCanon, GRAM);
  const projectionWords = new Map<string, number>();
  const projectionWordList = (text.normalize("NFKC").match(LATIN_WORD) ?? []).map((word) => word.toLowerCase());
  for (const word of projectionWordList) projectionWords.set(word, (projectionWords.get(word) ?? 0) + 1);
  const projectionBigrams = new Set(projectionWordList.slice(1).map((word, k) => `${projectionWordList[k]} ${word}`));
  const coverOf = (blockText: string): Coverage => {
    const gram = coverage(blockText, projectionCanon, index);
    return isLatinDominant(blockText) ? latinCoverage(blockText, projectionWords, gram, projectionCanon, projectionBigrams) : gram;
  };
  const paragraphStarts = [0, ...[...text.matchAll(/\n[ \t]*\n/g)].map((match) => match.index! + match[0].length)];
  const paragraphOf = (canonOffset: number): number => {
    const offset = projectionMap[Math.min(canonOffset, projectionMap.length - 1)] ?? 0;
    let lo = 0;
    let hi = paragraphStarts.length - 1;
    while (lo < hi) {
      const mid = (lo + hi + 1) >> 1;
      if (paragraphStarts[mid]! <= offset) lo = mid;
      else hi = mid - 1;
    }
    return lo;
  };
  const lineAt = (canonOffset: number): string => {
    const offset = projectionMap[Math.min(canonOffset, projectionMap.length - 1)] ?? 0;
    const start = text.lastIndexOf("\n", offset) + 1;
    const end = text.indexOf("\n", offset);
    return text.slice(start, end < 0 ? text.length : end);
  };

  if (source.incompleteContinuations.length > 0) {
    add({ code: "SOURCE_CONTINUATION_MISSING", severity: "hard", detail: source.incompleteContinuations.join("；") });
  }

  // ---- 1. 块级覆盖 + 删除侧审计 ----
  const deletionAudits = new Map<DeletionEntry, DeletionAudit>();
  for (const entry of projection.deletions) {
    const authorizedKind = (AUTHORIZED_DELETION_KINDS as readonly string[]).includes(entry.kind);
    deletionAudits.set(entry, {
      kind: entry.kind, page: entry.page, sourceBlockIds: [], chars: 0, textSha256: entry.textSha256 ?? null,
      excerpt: (entry.excerpt ?? "").slice(0, 80),
      verdict: authorizedKind ? "unanchored" : "unauthorized_kind",
      reason: authorizedKind ? "未定位到任何源块" : `删除种类 ${entry.kind} 不在授权闭集内`,
    });
  }
  const covered = new Map<string, Coverage>();
  let requiredBlocks = 0;
  let coveredBlocks = 0;
  let partialBlocks = 0;
  let lostBlocks = 0;
  let deletedBlocks = 0;
  let requiredCanon = 0;
  let coveredCanon = 0;
  const ownCanon = canon(source.blocks.filter((block) => block.zone !== "foreign").map((block) => block.text).join(""));
  const explainedByDeletion = new Set<string>();
  for (const block of source.blocks) {
    const cov = coverOf(block.text);
    covered.set(block.id, cov);
    if (cov.canonLength === 0) continue;
    if (block.zone === "foreign") {
      // 他文泄漏只认字符 n-gram 的连续命中（词袋会被常见英文词撑高）
      const own = canon(block.text);
      const strict = coverage(block.text, projectionCanon, index);
      if (strict.coveredChars / strict.canonLength >= 0.8 && own.length >= 20 && !ownCanon.includes(own)) {
        // 短片段（续行残片）可能与本文同名文献条目巧合重合：只要求人工核对
        add({ code: "FOREIGN_CONTENT_LEAK", severity: own.length >= 60 && strict.coveredChars / strict.canonLength >= 0.9 ? "hard" : "soft", blockId: block.id, page: block.page, detail: "同页混排的他文内容出现在投影中", excerpt: block.text.slice(0, 80) });
      }
      continue;
    }
    const removedCanon = cov.canonLength - cov.coveredChars;
    const explaining = removedCanon >= 4 ? projection.deletions.filter((entry) => deletionExplains(entry, block)) : [];
    if (block.zone === "margin") {
      if (removedCanon >= 4 && explaining.length === 0) add({ code: "FURNITURE_DELETION_UNRECORDED", severity: "info", blockId: block.id, page: block.page, detail: "版边页眉页脚未出现在投影中且无删除记录", excerpt: block.text.slice(0, 60) });
      for (const entry of explaining) recordDeletion(entry, block, cov.uncoveredText, { ok: true, reason: "版边页眉页脚 / 页码" });
      continue;
    }
    requiredBlocks += 1;
    requiredCanon += cov.canonLength;
    coveredCanon += cov.coveredChars;
    if (removedCanon < 8 || removedCanon / cov.canonLength < 0.05) {
      coveredBlocks += 1;
      continue;
    }
    if (explaining.length > 0) {
      deletedBlocks += 1;
      explainedByDeletion.add(block.id);
      let allAuthorized = true;
      for (const entry of explaining) {
        const verdict = auditDeletedText(entry.kind, block, cov.uncoveredText);
        recordDeletion(entry, block, cov.uncoveredText, verdict);
        if (!verdict.ok) {
          allAuthorized = false;
          add({ code: "ILLEGITIMATE_DELETION", severity: "hard", blockId: block.id, page: block.page, detail: `删除（${entry.kind}）越界：${verdict.reason}`, excerpt: cov.uncoveredText.slice(0, 120) });
        }
      }
      // 覆盖率口径 = 应保留的科研文本：授权删除的元数据不计入分母
      if (allAuthorized) requiredCanon -= removedCanon;
      continue;
    }
    if (block.role === "text" && auditDeletedText("submission_metadata", block, cov.uncoveredText).ok && Object.values(METADATA_SIGNATURES).some((pattern) => pattern.test(block.text.normalize("NFKC")))) {
      deletedBlocks += 1;
      requiredCanon -= removedCanon;
      add({ code: "METADATA_DELETION_UNRECORDED", severity: "info", blockId: block.id, page: block.page, detail: "投稿元数据未出现在投影中，但删除清单无对应记录", excerpt: cov.uncoveredText.slice(0, 80) });
      continue;
    }
    const lostCode = block.role === "heading" ? "HEADING_LOST" : block.role === "caption" ? "CAPTION_LOST" : block.role === "reference" ? "REFERENCE_TEXT_LOST" : "BODY_TEXT_LOST";
    const hard = block.role !== "text" || looksLikeBody(cov.uncoveredText) || removedCanon >= 40;
    if (cov.coveredChars > 0) partialBlocks += 1;
    else lostBlocks += 1;
    add({ code: lostCode, severity: hard ? "hard" : "soft", blockId: block.id, page: block.page, detail: `源块 ${removedCanon}/${cov.canonLength} 规范字符未出现在投影中，且无删除记录`, excerpt: cov.uncoveredText.slice(0, 120) });
  }
  function recordDeletion(entry: DeletionEntry, block: SourceBlock, removed: string, verdict: { ok: boolean; reason: string }) {
    const audit = deletionAudits.get(entry)!;
    if (audit.verdict === "unauthorized_kind") {
      audit.sourceBlockIds.push(block.id);
      return;
    }
    audit.sourceBlockIds.push(block.id);
    audit.chars += canon(removed).length;
    if (audit.verdict !== "illegitimate") {
      audit.verdict = verdict.ok ? "authorized" : "illegitimate";
      audit.reason = verdict.reason;
    }
  }
  for (const audit of deletionAudits.values()) {
    if (audit.verdict === "unauthorized_kind") add({ code: "DELETION_KIND_UNAUTHORIZED", severity: "hard", page: audit.page ?? undefined, detail: audit.reason, excerpt: audit.excerpt });
    else if (audit.verdict === "unanchored" && audit.kind !== "front_matter_figure" && audit.kind !== "front_matter_table" && audit.excerpt.trim() !== "" && canon(audit.excerpt).length >= 8) {
      add({ code: "DELETION_UNANCHORED", severity: "info", page: audit.page ?? undefined, detail: `删除记录（${audit.kind}）对应的文本已在投影中或无法定位源块`, excerpt: audit.excerpt });
    }
  }

  // ---- 2. 有序覆盖 + 段落拼接 ----
  const ordered = source.blocks
    .filter((block) => block.zone === "body" && (block.role === "text" || block.role === "heading"))
    .sort((a, b) => a.order - b.order);
  const placed = ordered
    .map((block) => ({ block, cov: covered.get(block.id)! }))
    // 拉丁文字为主的块按词袋判覆盖，其 n-gram 锚点不可靠（逐词定位的文本层），不作为顺序证据
    .filter((entry) => entry.cov.anchor !== null && entry.cov.anchorUnique && !explainedByDeletion.has(entry.block.id) && !isLatinDominant(entry.block.text) &&
      entry.cov.canonLength >= 12 && entry.cov.coveredChars / entry.cov.canonLength >= 0.9);
  const outOfOrder = outsideLis(placed.map((entry) => entry.cov.anchor!));
  const orderSeverity = source.readingOrderReliable ? "hard" : "soft";
  for (const position of outOfOrder) {
    const { block } = placed[position]!;
    // 独立版面顺序是启发式重建：单块不单调只作为人工 QA 证据（不单独判无效）
    add({ code: "READING_ORDER_ANOMALY", severity: "soft", blockId: block.id, page: block.page, detail: `源阅读顺序第 ${block.order} 块在投影中的位置与前后文不单调${source.readingOrderReliable ? "" : "（源版面顺序不可靠，需人工核对）"}`, excerpt: block.text.slice(0, 60) });
  }
  const rankInOrdered = new Map(ordered.map((block, rank) => [block.id, rank]));
  const byParagraph = new Map<number, Array<{ block: SourceBlock; rank: number }>>();
  for (const { block, cov } of placed) {
    if (block.role !== "text") continue;
    const paragraph = paragraphOf(cov.anchor!);
    const list = byParagraph.get(paragraph) ?? [];
    list.push({ block, rank: rankInOrdered.get(block.id)! });
    byParagraph.set(paragraph, list);
  }
  const placedRank = new Map(placed.map(({ block, cov }) => [rankInOrdered.get(block.id)!, paragraphOf(cov.anchor!)]));
  let splices = 0;
  for (const [paragraph, members] of byParagraph) {
    members.sort((a, b) => a.rank - b.rank);
    for (let k = 1; k < members.length; k += 1) {
      const from = members[k - 1]!.rank;
      const to = members[k]!.rank;
      const between = [...placedRank.entries()].filter(([rank, other]) => rank > from && rank < to && other !== paragraph);
      if (between.length > 0) {
        splices += 1;
        // 跨越 ≥2 个已放置的其他正文块的拼接 = 不相邻段落被拼成一个论证链（版面顺序可靠时判无效）
        add({ code: "PARAGRAPH_SPLICE", severity: between.length >= 2 ? orderSeverity : "soft", blockId: members[k]!.block.id, page: members[k]!.block.page, detail: `投影同一段落拼接了源顺序不相邻的正文块（中间隔着 ${between.length} 个已放置的其他正文块：${between.slice(0, 3).map(([rank]) => ordered[rank]!.id).join("、")}；前块 ${ordered[from]!.id}）`, excerpt: members[k]!.block.text.slice(0, 60) });
      }
    }
  }
  // 标题：必须以 Markdown 标题呈现；数字编号层级与 # 级别一致
  const depthLevel = new Map<number, Set<number>>();
  for (const { block, cov } of placed) {
    if (block.role !== "heading") continue;
    const line = lineAt(cov.anchor!);
    const level = /^(#{1,6})\s/.exec(line)?.[1]!.length;
    if (level === undefined) {
      add({ code: "HEADING_NOT_STRUCTURED", severity: "soft", blockId: block.id, page: block.page, detail: "章节标题在投影中不是 Markdown 标题行（可能与正文粘连）", excerpt: line.slice(0, 60) });
      continue;
    }
    const depth = headingDepth(block.text);
    if (depth !== null) depthLevel.set(depth, (depthLevel.get(depth) ?? new Set()).add(level));
  }
  for (const [depth, levels] of depthLevel) {
    if (levels.size > 1) add({ code: "HEADING_LEVEL_INCONSISTENT", severity: "soft", detail: `编号深度 ${depth} 的标题在投影中使用了 ${[...levels].join("/")} 级` });
  }
  return finish();

  function finish(): InputFidelityReport {
    return assembleReport(source, projection, findings, [...deletionAudits.values()], {
      requiredBlocks, coveredBlocks, partialBlocks, lostBlocks, deletedBlocks, requiredCanon, coveredCanon,
      orderAnomalies: outOfOrder.size, splices, projectionCanon, index, projectionWords, projectionMap,
    });
  }
}

interface CoverageTotals {
  requiredBlocks: number; coveredBlocks: number; partialBlocks: number; lostBlocks: number; deletedBlocks: number;
  requiredCanon: number; coveredCanon: number; orderAnomalies: number; splices: number;
  projectionCanon: string; index: GramIndex; projectionWords: ReadonlyMap<string, number>; projectionMap: readonly number[];
}

function assembleReport(source: SourceEvidence, projection: FidelityProjectionInput, findings: FidelityFinding[], deletions: DeletionAudit[], totals: CoverageTotals): InputFidelityReport {
  const text = projection.text.replace(/\r\n?/g, "\n");
  const add = (finding: FidelityFinding) => findings.push(finding);

  // ---- 3. 表格：文本层逐词坐标独立复原单元格位置 ----
  const projectedTables = parseMarkdownTables(text);
  const used = new Set<number>();
  const tables = source.tables.map((table) => ({ id: table.id, page: table.page, ...checkTable(table.words, projectedTables, used) }));
  for (const table of tables) {
    if (table.status === "MISMATCH") add({ code: "TABLE_MISMATCH", severity: "hard", page: table.page, detail: `${table.id}：${table.codes.join(",")}；${table.detail}` });
    else if (table.status === "UNVERIFIED") add({ code: "TABLE_UNVERIFIED", severity: "soft", page: table.page, detail: `${table.id}：${table.codes.join(",")}；${table.detail}` });
  }

  // ---- 4. 公式结构 ----
  const projected = projectedFormulas(text);
  const usedFormula = new Set<number>();
  const matchedAt = new Map<number, number>();
  let forcedAt: number | null = null;
  // 两遍匹配：先按公式编号，再对无编号公式按文本相似度（避免无编号公式先占用别人的投影公式）
  const formulaOrder = source.formulas.map((formula, k) => ({ formula, k })).sort((a, b) => Number(a.formula.label === null) - Number(b.formula.label === null) || a.k - b.k);
  const checked = new Map<number, FormulaCheck>();
  for (const { formula, k } of formulaOrder) checked.set(k, checkFormula(formula));
  for (const [k, result] of checked) {
    if (result.status !== "MISSING") continue;
    const before = [...checked.entries()].filter(([j, other]) => j < k && other.status !== "MISSING").map(([j]) => matchedAt.get(j) ?? -1);
    const floor = before.length === 0 ? -1 : Math.max(...before);
    const next = projected.findIndex((_entry, index) => index > floor && !usedFormula.has(index));
    if (next >= 0) {
      forcedAt = next;
      checked.set(k, checkFormula(source.formulas[k]!));
      forcedAt = null;
    }
  }
  const formulas: FormulaCheck[] = source.formulas.map((_formula, k) => checked.get(k)!);
  function checkFormula(formula: SourceEvidence["formulas"][number]): FormulaCheck {
    let at = forcedAt ?? -1;
    if (at < 0 && formula.label !== null) {
      // 编号带括号比较：「(5)」不能匹配「(15)」
      const label = `(${formula.label.normalize("NFKC").replace(/\D/g, "")})`;
      const flat = (body: string) => body.normalize("NFKC").replace(/\s+/g, "").replace(/\$+$/, "");
      at = projected.findIndex((entry, k) => !usedFormula.has(k) && flat(entry.body).endsWith(label));
      if (at < 0) {
        const candidates = projected.map((entry, k) => ({ entry, k })).filter(({ entry, k }) => !usedFormula.has(k) && flat(entry.body).includes(label));
        if (candidates.length === 1) at = candidates[0]!.k;
      }
    }
    if (at < 0 && forcedAt === null) {
      const own = canon(formula.text);
      let best = 0;
      projected.forEach((entry, k) => {
        if (usedFormula.has(k)) return;
        const body = canon(entry.body);
        let hits = 0;
        for (let p = 0; p + 3 <= own.length; p += 1) if (body.includes(own.slice(p, p + 3))) hits += 1;
        const score = own.length < 3 ? (body.includes(own) ? 1 : 0) : hits / (own.length - 2);
        if (score > best) {
          best = score;
          at = k;
        }
      });
      if (best < 0.5) at = -1;
    }
    const base = { id: formula.id, page: formula.page, label: formula.label };
    if (at < 0) {
      // 未成为展示公式块：公式文本若仍在正文中（被并入段落），按结构未核验处理；完全找不到才是缺失
      const cov = coverage(formula.text, totals.projectionCanon, totals.index);
      if (cov.canonLength === 0 || cov.coveredChars / cov.canonLength < 0.5) return { ...base, status: "MISSING" as const, detail: "投影中找不到对应的展示公式，公式文本也未出现在正文中" };
      const offset = cov.anchor === null ? -1 : (totals.projectionMap[cov.anchor] ?? -1);
      const nearby = offset < 0 ? "" : text.slice(Math.max(0, offset - 200), offset + 400);
      return nearby.includes(FORMULA_UNVERIFIED_MARKER)
        ? { ...base, status: "UNVERIFIED_MARKED" as const, detail: "公式文本并入正文，已标 FORMULA_UNVERIFIED" }
        : { ...base, status: "STRUCTURE_LOST" as const, detail: "公式未作为展示公式呈现（文本被并入正文段落），且未标记 FORMULA_UNVERIFIED" };
    }
    usedFormula.add(at);
    matchedAt.set(source.formulas.indexOf(formula), at);
    const entry = projected[at]!;
    const body = entry.body;
    const marked = body.includes(FORMULA_UNVERIFIED_MARKER) || text.slice(Math.max(0, entry.offset - 120), entry.offset).includes(FORMULA_UNVERIFIED_MARKER);
    if (GARBLED_GLYPHS.test(body)) {
      return { ...base, status: marked ? "UNVERIFIED_MARKED" as const : "GARBLED" as const, detail: `投影公式含文本层乱码字形${marked ? "（已标 FORMULA_UNVERIFIED）" : "，且未标记 FORMULA_UNVERIFIED"}` };
    }
    const encoded = [...body.matchAll(/([_^])\{([^{}]*)\}/g)].map((match) => `${match[1] === "_" ? "sub" : "sup"}:${canon(match[2]!)}`);
    const expected = formula.scripts.map((script) => `${script.kind}:${canon(script.text)}`).filter((key) => !key.endsWith(":"));
    let cursor = 0;
    const scriptsEncoded = expected.every((key) => {
      const found = encoded.indexOf(key, cursor);
      if (found < 0) return false;
      cursor = found + 1;
      return true;
    });
    // 文本层自身已失真的信号：叠行 / 分段字形 / 位移字形留下的空括号「S( ) x」/ 公式区只有编号
    const content = canon(formula.text.replace(/[（(]\s*\d{1,3}[a-z]?\s*[）)]/g, ""));
    if (content.length < 3) {
      return { ...base, status: "UNVERIFIABLE_SOURCE" as const, detail: "源证据的公式区只有编号 / 无可读文本，无法独立核验投影公式（需人工 QA）" };
    }
    const stacked = formula.stackedLines >= 2 || formula.pieceGlyphs > 0 || /[(（]\s*[)）]/.test(formula.text) || content.length < 3 ||
      /[\ue000-\uf8ff]|[\udb80-\udbff][\udc00-\udfff]/.test(formula.text);
    if (!stacked && scriptsEncoded) return { ...base, status: "VERIFIED" as const, detail: expected.length === 0 ? "无上下标 / 叠行结构，文本一致" : `${expected.length} 处上下标逐一显式编码` };
    const why = stacked ? `源公式文本层无法证明结构（叠行 ${formula.stackedLines}，分段字形 ${formula.pieceGlyphs}，空括号 / 私用区字形 / 仅编号等位移信号），线性化正确性不可核验` : `源公式 ${expected.length} 处上下标未全部显式编码（投影 ${encoded.length} 处）`;
    return { ...base, status: marked ? "UNVERIFIED_MARKED" as const : "STRUCTURE_LOST" as const, detail: marked ? `${why}；已标 FORMULA_UNVERIFIED` : `${why}；未标记 FORMULA_UNVERIFIED 却以普通公式呈现` };
  }
  for (const formula of formulas) {
    if (formula.status === "GARBLED" || formula.status === "STRUCTURE_LOST" || formula.status === "MISSING") {
      add({ code: `FORMULA_${formula.status}`, severity: "hard", page: formula.page, detail: `${formula.id}${formula.label ?? ""}：${formula.detail}` });
    } else if (formula.status === "UNVERIFIED_MARKED" || formula.status === "UNVERIFIABLE_SOURCE") {
      add({ code: "FORMULA_UNVERIFIED", severity: "soft", page: formula.page, detail: `${formula.id}${formula.label ?? ""}：${formula.detail}` });
    }
  }

  // ---- 5. 参考文献条目与编号序列 ----
  let referencesLost = 0;
  for (const reference of source.references) {
    const gram = coverage(reference.text, totals.projectionCanon, totals.index);
    const cov = isLatinDominant(reference.text) ? latinCoverage(reference.text, totals.projectionWords, gram, totals.projectionCanon) : gram;
    if (cov.canonLength > 0 && cov.coveredChars / cov.canonLength < 0.8) {
      referencesLost += 1;
      add({ code: "REFERENCE_LOST", severity: "hard", detail: `参考文献${reference.number !== null ? ` [${reference.number}]` : ""} 在投影中覆盖 ${(cov.coveredChars / cov.canonLength * 100).toFixed(0)}%`, excerpt: reference.text.slice(0, 80) });
    }
  }
  const sourceNumbers = source.references.map((reference) => reference.number).filter((value): value is number => value !== null);
  const projectedNumbers = referenceNumbersInProjection(text);
  let sequenceAnomalies = 0;
  if (sourceNumbers.length > 0) {
    const expected = sourceNumbers.join(",");
    if (projectedNumbers.length === 0) {
      sequenceAnomalies = 1;
      add({ code: "REFERENCE_NUMBERING_LOST", severity: "hard", detail: `源参考文献 ${sourceNumbers.length} 条有编号，投影参考文献节中找不到任何「[n]」编号——正文引用编号无法对应条目` });
    } else if (projectedNumbers.join(",") !== expected) {
      sequenceAnomalies = 1;
      const extra = projectedNumbers.filter((value, k) => projectedNumbers.indexOf(value) !== k || !sourceNumbers.includes(value));
      add({ code: "REFERENCE_SEQUENCE_ANOMALY", severity: "hard", detail: `参考文献编号序列 源 [${sourceNumbers.length} 条：${sourceNumbers.slice(0, 3).join(",")}…${sourceNumbers.slice(-2).join(",")}] / 投影 [${projectedNumbers.length} 条${extra.length > 0 ? `；重复或多出 ${extra.slice(0, 5).join(",")}` : ""}]` });
    }
  }

  // ---- 6. 图占位、行内上下标、身份残留 ----
  const figureMarkers = (text.match(new RegExp(FIGURE_MARKER, "g")) ?? []).length;
  if (figureMarkers < source.figures.length) add({ code: "FIGURE_MARKER_MISSING", severity: "soft", detail: `源图 ${source.figures.length} 个 / 投影占位 ${figureMarkers} 个` });
  let inlineTotal = 0;
  let inlineEncoded = 0;
  const encodedInline = new Set([...text.matchAll(/([_^])\{([^{}]*)\}/g)].map((match) => `${match[1] === "_" ? "sub" : "sup"}:${canon(match[2]!)}`));
  for (const block of source.blocks) {
    if (block.zone !== "body" || block.scripts === undefined) continue;
    const cov = coverage(block.text, totals.projectionCanon, totals.index);
    if (cov.canonLength === 0 || cov.coveredChars / cov.canonLength < 0.6) continue;
    for (const script of block.scripts) {
      if (canon(script.text) === "") continue;
      inlineTotal += 1;
      if (encodedInline.has(`${script.kind}:${canon(script.text)}`)) inlineEncoded += 1;
    }
  }
  if (inlineTotal > inlineEncoded) add({ code: "INLINE_SCRIPT_FLATTENED", severity: "soft", detail: `正文行内上下标 ${inlineTotal} 处中 ${inlineTotal - inlineEncoded} 处未显式编码（「10 6」与 10⁶ 无法区分）` });
  const referencesHeading = text.search(/^#{1,6}\s*(参\s*考\s*文\s*献|References?)(?![A-Za-z]).*$/im);
  const beforeReferences = referencesHeading >= 0 ? text.slice(0, referencesHeading) : text;
  const residues = source.identityTerms.filter((term) => term.trim().length >= 2 && (cjkCount(term) >= 2 || term.length >= 5) && beforeReferences.includes(term));
  if (residues.length > 0) add({ code: "BLINDING_RESIDUE", severity: "soft", detail: `参考文献之前仍可见身份词 ${residues.length} 个（需人工判定是否属学术内容）`, excerpt: residues.slice(0, 5).join("、") });
  // 投稿元数据字段残留（基金编号 / 邮箱 / 收稿日期 / 作者简介）：身份词表覆盖不到的盲化漏删
  const fieldResidue = beforeReferences.split(/\n+/).filter((line) => METADATA_RESIDUE.test(line.normalize("NFKC")));
  if (fieldResidue.length > 0) add({ code: "BLINDING_RESIDUE", severity: "soft", detail: `参考文献之前仍有 ${fieldResidue.length} 行带投稿元数据字段特征（基金编号 / 邮箱 / 收稿日期 / 作者简介）`, excerpt: fieldResidue[0]!.slice(0, 120) });

  // ---- 7. 状态 ----
  const hard = findings.filter((finding) => finding.severity === "hard");
  const soft = findings.filter((finding) => finding.severity === "soft");
  const status: FidelityStatus = source.incompleteContinuations.length > 0
    ? "SOURCE_INCOMPLETE"
    : hard.length > 0 ? "INVALID_INPUT" : soft.length > 0 ? "REQUIRES_HUMAN_QA" : "VALID_FOR_SCORING";
  const codes = (list: FidelityFinding[]) => [...new Set(list.map((finding) => finding.code))].map((code) => `${code}×${list.filter((finding) => finding.code === code).length}`);
  const limitations = [
    ...(source.figures.length > 0 ? [`${FIGURE_MARKER}：${source.figures.length} 个图的图像内容未送审，图形含义未核实`] : []),
    ...(formulas.some((formula) => formula.status !== "VERIFIED") ? [`${FORMULA_UNVERIFIED_MARKER}：${formulas.filter((formula) => formula.status !== "VERIFIED").length}/${formulas.length} 个展示公式结构未核验`] : []),
    ...(tables.some((table) => table.status !== "VERIFIED") ? [`TABLE_UNVERIFIED：${tables.filter((table) => table.status !== "VERIFIED").length}/${tables.length} 个表格单元位置未能独立核验或不一致`] : []),
  ];
  const count = (status: DeletionAudit["verdict"]) => deletions.filter((audit) => audit.verdict === status).length;
  return {
    schema: INPUT_FIDELITY_REPORT_SCHEMA,
    status,
    legacyStatus: status === "VALID_FOR_SCORING" ? "VALID" : "INVALID_INPUT",
    fullPaperQuantitativeScoring: status === "VALID_FOR_SCORING",
    sourceSha256: source.sourceSha256,
    projectionSha256: sha256(text),
    reasons: [...codes(hard), ...codes(soft)],
    limitations,
    findings,
    metrics: {
      requiredBlocks: totals.requiredBlocks, coveredBlocks: totals.coveredBlocks, partialBlocks: totals.partialBlocks,
      lostBlocks: totals.lostBlocks, deletedBlocks: totals.deletedBlocks,
      requiredCanonChars: totals.requiredCanon, coveredCanonChars: totals.coveredCanon,
      coverageRatio: totals.requiredCanon === 0 ? 1 : Number((totals.coveredCanon / totals.requiredCanon).toFixed(5)),
      orderAnomalies: totals.orderAnomalies, paragraphSplices: totals.splices,
      tables: { total: tables.length, verified: tables.filter((t) => t.status === "VERIFIED").length, mismatch: tables.filter((t) => t.status === "MISMATCH").length, unverified: tables.filter((t) => t.status === "UNVERIFIED").length },
      formulas: {
        total: formulas.length, verified: formulas.filter((f) => f.status === "VERIFIED").length,
        unverifiedMarked: formulas.filter((f) => f.status === "UNVERIFIED_MARKED").length, unverifiableSource: formulas.filter((f) => f.status === "UNVERIFIABLE_SOURCE").length, structureLost: formulas.filter((f) => f.status === "STRUCTURE_LOST").length,
        garbled: formulas.filter((f) => f.status === "GARBLED").length, missing: formulas.filter((f) => f.status === "MISSING").length,
      },
      references: { source: source.references.length, lost: referencesLost, sequenceAnomalies },
      figures: { source: source.figures.length, markers: figureMarkers },
      inlineScripts: { total: inlineTotal, encoded: inlineEncoded },
      deletions: { total: deletions.length, authorized: count("authorized"), illegitimate: count("illegitimate"), unanchored: count("unanchored"), unauthorizedKind: count("unauthorized_kind") },
    },
    deletions,
    tables,
    formulas,
  };
}
