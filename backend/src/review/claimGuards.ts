/**
 * M15.4.2（B4）共享守卫核心：claimCertificate（生产证书器）与 candidateProposer（提案验证器）的
 * 单一事实来源。全部内容自 claimCertificate.ts@1c7713d 逐字提炼（语义不变），目的：
 *  - 消除 M15.4.1 POC 中为保 dist 字节不变而复制的 STOP / OWN 行判别 / QUALIFIER 词表 / 派生列正则 / B2 跨表 / B3 限定词
 *    （两套漂移的可靠性逻辑不可长期并存）；
 *  - 模型候选定位与纯规则绑定走同一权威判断，不出现第二套证书器。
 *
 * 旧路径行为等价性由既有测试套件（claimCertificate / SemanticBinding / CrossTable / candidateProposer）
 * 与 claimGuards.test.ts 的正反例保证。本模块只含纯函数与常量，不含 I/O、不签发任何证书。
 */

import type { LatexTableCell } from "./latexTable.js";
import { contextTokens, type CertificateDocument } from "./claimCertificate.js";

/** 论断/结构语境的停用词（claimCertificate.STOP 逐字迁移） */
export const STOP = new Set([
  "the", "a", "an", "of", "on", "in", "for", "and", "or", "to", "by", "at", "from", "as", "is", "are", "was", "were", "be", "with", "its", "their", "this", "that", "these", "those",
  "method", "methods", "model", "models", "approach", "approaches", "results", "result", "table", "tab", "score", "scores", "performance", "metric", "metrics", "value", "values",
  "achieves", "achieve", "achieved", "obtains", "obtain", "obtained", "reaches", "reach", "reached", "reports", "reported", "shows", "show", "yields", "yield", "gets", "attains",
  "which", "while", "whereas", "also", "both", "all", "each", "respectively", "using", "used", "use", "our", "ours", "we", "proposed", "work", "paper", "new",
  "et", "al", "fig", "figure", "sec", "section", "see", "eq", "i", "e", "g", "vs", "via",
]);

/** 论断侧本文别名（claimCertificate.OWN_ALIASES 逐字迁移）：ours/our/we/proposed… 家族互通 */
export const OWN_ALIASES = /\b(?:ours|our|we|proposed|this work|this paper|the present work)\b|本文|我们|所提|提出的方法/i;
/** 本文方法行判别（claimCertificate.OWN_ROW 逐字迁移） */
export const OWN_ROW = /\b(?:ours|proposed|this work|our method|our approach|our model)\b|本文|我们|所提/i;

/** B3 论断限定词（claimCertificate.QUALIFIER_LEXICON 逐字迁移）：须由表格语境解释 */
export const QUALIFIER_LEXICON = [
  "validation", "val", "dev", "train", "training", "test-dev", "held-out", "zero-shot", "few-shot", "one-shot", "fine-tuned", "finetuned", "pretrained", "pre-trained",
  "post-processing", "postprocessing", "offline", "ensemble", "oracle", "upper", "tta", "test-time", "w/o", "without", "ablation", "ablated", "variant", "single-scale", "multi-scale",
  "small", "large", "base", "tiny", "lite", "ablations", "cross-domain", "occluded", "subset", "split",
  "验证集", "训练集", "消融", "后处理", "零样本",
];

/** B3 复现/公平/原文限定词家族（claimCertificate.QUALIFIER_FAMILIES 逐字迁移）：家族内互通 */
export const QUALIFIER_FAMILIES: string[][] = [
  ["reproduce", "reproduces", "reproduced", "reproducing", "reproduction", "reproductions", "replicate", "replicates", "replicated", "replication", "复现"],
  ["fair"],
  ["original"],
];

/** 论文自制派生列表头（claimCertificate.certifyClaim 内 derivedColumn 正则逐字迁移）：tabulatedDerived 路径 */
export const DERIVED_COLUMN_HEADER = /\b(?:improv\w*|imp\.?|gains?|increases?|delta|rel\.?|relative|changes?)\b|Δ|\\Delta|提升|增益/i;

/** 守卫语境：token 集（canonical 后）+ 纯文本小写（claimCertificate.Context 结构迁移） */
export interface GuardContext {
  tokens: Set<string>;
  plain: string;
}

/** term 是否出现在 context 中（claimCertificate.mentions 逐字迁移：拉丁词元相等；中文子串包含） */
export function mentions(context: GuardContext, term: string): boolean {
  if (hasCjk(term)) return term.length >= 2 && context.plain.includes(term);
  return context.tokens.has(term);
}

function hasCjk(token: string): boolean {
  return /[一-鿿]/.test(token);
}

/** 行是否本文方法行（claimCertificate.rowIsOwn 逐字迁移：OWN_ROW 正则 + ownTerms canonical token 判别） */
export function rowIsOwn(document: CertificateDocument, cell: LatexTableCell): boolean {
  const key = cell.rowKey.join(" ");
  if (OWN_ROW.test(key)) return true;
  const tokens = new Set(contextTokens(key));
  return document.ownTerms.some((term) => tokens.has(term));
}

/**
 * B3 限定词拒绝（claimCertificate.bindTextAtom 内两段循环逐字迁移）：
 * 论断分句写了、绑定单元格语境解释不了的限定词（含复现/公平/原文家族）→ 返回裸限定词列表
 * （调用方自行格式化：生产侧 `UNEXPLAINED_QUALIFIER:${q}`；提案侧并入弃判 detail）。
 */
export function qualifierRejections(segment: GuardContext, explain: GuardContext): string[] {
  const out: string[] = [];
  for (const qualifier of QUALIFIER_LEXICON) {
    if (mentions(segment, qualifier) && !mentions(explain, qualifier)) out.push(qualifier);
  }
  for (const family of QUALIFIER_FAMILIES) {
    const used = family.filter((qualifier) => mentions(segment, qualifier));
    if (used.length > 0 && !family.some((qualifier) => mentions(explain, qualifier))) out.push(used[0]!);
  }
  return [...new Set(out)];
}

/**
 * B2 跨表数值竞争（claimCertificate.bindTextAtom 内 VALUE_APPEARS_IN_OTHER_TABLE 块逐字迁移，
 * 多命中推广由调用方传入完整 hit 表集合）：论断值逐字出现在任何命中表之外的表格体 → 跨表归属不可证。
 * 返回其他表 tableId 列表（≤3）。纯数字检查、正则、命中面判定与生产一致。
 */
export function crossTableValueCompetitors(document: CertificateDocument, hitTables: ReadonlyArray<{ file: string; tableIndex: number }>, claimRaw: string): string[] {
  const needle = claimRaw.replace(/,/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(needle)) return [];
  const pattern = new RegExp(`(?<![\\d.])${needle.replace(/\./g, "\\.")}(?![\\d.])`, "g");
  const hitTableIds = new Set(hitTables
    .map((hit) => document.files.find((file) => file.file === hit.file)?.tables[hit.tableIndex]?.tableId)
    .filter((id): id is string => id !== undefined));
  const otherTableIds = new Set<string>();
  for (const file of document.files) {
    for (const match of file.content.matchAll(pattern)) {
      for (const table of file.tables) {
        if (!hitTableIds.has(table.tableId) && match.index! >= table.start && match.index! < table.end) otherTableIds.add(table.tableId);
      }
    }
  }
  return [...otherTableIds].slice(0, 3);
}
