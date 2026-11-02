/**
 * M16 收口 · B：人类参考意见的确定性具体性分层（零模型；规则在看 held-out 输出前冻结，见 PROTOCOL）。
 *
 * SPECIFIC（可核对的论文专属批评）满足任一：
 *   (a) 显式定位：Table / Figure / Eq. / Section / Theorem / Lemma / Algorithm / Appendix / Line + 编号；
 *   (b) ≥ 2 个论文专属词：意见中出现、论文正文中也出现、且在全语料其他论文的人类意见里文档频率 ≤ DF_MAX 的词
 *       （长度 ≥ 4 的词、含数字的记号如 GPT-4 / 62.1）。高频审稿词汇（baseline / experiments / novelty …）自动排除。
 * 否则 GENERIC（「novelty limited」「需要更多实验」类）：只作诊断，不作严格正确性真值。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";

import { COCO } from "./lib.mjs";

export const DF_MAX = 0.03;
export const MIN_TERMS = 2;
export const ANCHOR = /\b(?:tables?|tab\.|figures?|figs?\.|eqs?\.|equations?|eqn\.?|sections?|sec\.|§|theorems?|thm\.?|lemmas?|propositions?|prop\.|corollar(?:y|ies)|assumptions?|definitions?|def\.|algorithms?|alg\.|appendi(?:x|ces)|app\.|lines?|ll?\.)\s*\(?\s*[A-Z]?\d/i;

const STOP = new Set("this that with from have been were which their there would could should these those other about into than then them they what when where while also only such more most very much many some does done each both same even over under between because however although paper authors author work method methods model models results result approach proposed propose show shows shown using used based further first second third well make made like provide provides provided".split(/\s+/));

export const tokenize = (s) => (String(s).toLowerCase().match(/[a-z][a-z0-9\-]{3,}|[a-z]*\d[a-z0-9.\-]*/g) ?? []).map((t) => t.replace(/[.\-]+$/, "")).filter((t) => t.length >= 2 && !STOP.has(t));

let corpus = null;
/** 全语料 300 篇：每篇人类意见文本的词集合（用于文档频率） */
export function loadCorpus(humanWeaknesses) {
  if (corpus) return corpus;
  const records = readFileSync(join(COCO, "benchmark_ICLR_2025.jsonl"), "utf8").split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
  const termsByPaper = new Map();
  for (const r of records) {
    const set = new Set();
    for (const o of humanWeaknesses(r)) for (const t of tokenize(o.text)) set.add(t);
    termsByPaper.set(r.id, set);
  }
  const df = new Map();
  for (const set of termsByPaper.values()) for (const t of set) df.set(t, (df.get(t) ?? 0) + 1);
  corpus = { records, termsByPaper, df, n: records.length };
  return corpus;
}

/** 单条意见分层；返回 { label, anchor, terms } —— terms 为命中的论文专属词（审计用） */
export function classifyOpinion(text, paperId, paperText, c) {
  const anchor = ANCHOR.test(text);
  const paper = String(paperText).toLowerCase();
  const own = c.termsByPaper.get(paperId) ?? new Set();
  const terms = [...new Set(tokenize(text))].filter((t) => {
    const otherDf = (c.df.get(t) ?? 0) - (own.has(t) ? 1 : 0);
    return otherDf / (c.n - 1) <= DF_MAX && paper.includes(t);
  });
  return { label: anchor || terms.length >= MIN_TERMS ? "SPECIFIC" : "GENERIC", anchor, terms };
}
