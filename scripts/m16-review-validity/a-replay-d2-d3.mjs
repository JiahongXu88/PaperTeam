#!/usr/bin/env node
/**
 * M16 · A：M15 TJA D2 / D3 零模型复算 + 口径审计（只读 M15 冻结产物，结果写入 M16 数据目录）。
 *
 *   node scripts/m16-review-validity/a-replay-d2-d3.mjs
 *
 * 复算项：
 *  D2 — 原 score 逻辑逐字重放（复核 65% / 71% / −6pp）；输入截断比例；平凡基线
 *       （不读论文、恒输出训练外记录中最常见的 K 个类别）的类别召回，用于判定「类别级召回」的区分力。
 *  D3 — 原 rows 复算；平凡基线（恒 −1 / 恒 +1）；balanced accuracy（负 / 正两类召回均值）；
 *       参考分负向占比；Comprehensiveness 维度的参考文献是否落在 40,000 字符输入窗口内。
 */
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const M15 = "D:\\PaperTeamData\\M15\\TargetJournalAssessment";
const OUT = "D:\\PaperTeamData\\M16\\AcademicReviewValidity\\A";
mkdirSync(OUT, { recursive: true });
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const INPUT_CHARS = 40_000;

/** 与 M15 model-harness.mjs bootstrapCi 相同的确定性 bootstrap（复算须同 seed） */
function bootstrapCi(values, iterations = 2000, seed = 20261102) {
  if (values.length === 0) return { mean: null, low: null, high: null };
  let state = seed >>> 0;
  const rand = () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 2 ** 32;
  };
  const mean = (arr) => arr.reduce((a, b) => a + b, 0) / arr.length;
  const means = [];
  for (let i = 0; i < iterations; i += 1) means.push(mean(values.map(() => values[Math.floor(rand() * values.length)])));
  means.sort((a, b) => a - b);
  return { mean: mean(values), low: means[Math.floor(0.025 * iterations)], high: means[Math.floor(0.975 * iterations)] };
}

// ---------------- D2 ----------------
const EXT2 = join(M15, "external", "cocoreviewbench-2580687");
const sel2 = readJson(join(M15, "D2", "selection.json"));
const out2 = readJson(join(M15, "D2", "outputs.json"));
const metrics2 = readJson(join(M15, "D2", "metrics.json"));
const codes = new Set(readJson(join(EXT2, "taxonomy.json")).map((t) => t.code));
const selectedIds = new Set(sel2.selected.map((p) => p.id));

// 训练外（未入选）记录的人类弱点类别频率 —— 与原 select 同一抽取口径
function weaknessCategories(record) {
  const weaknessIds = new Set();
  for (const thread of record.reviews) {
    for (const turn of thread) {
      if (!/^Reviewer/.test(turn.role)) continue;
      const value = turn.sentence_ids?.value;
      const parsed = typeof value === "string" ? JSON.parse(value.replace(/'/g, '"')) : value;
      for (const id of parsed?.weaknesses ?? []) weaknessIds.add(`${turn.role}|${id}`);
    }
  }
  const categories = new Set();
  record.opinions.forEach((opinion, index) => {
    if (record.conflicts_validation?.[index] === "incorrect" || record.rebuttal_validation?.[index] === "incorrect") return;
    const reviewerParts = opinion.data.filter((d) => /^Reviewer/.test(d.role));
    if (!reviewerParts.some((d) => d.sentence_ids.some((id) => weaknessIds.has(`${d.role}|${id}`)))) return;
    for (const c of opinion.category) if (c !== "N/A") categories.add(c);
  });
  return [...categories];
}
const records = readFileSync(join(EXT2, "benchmark_ICLR_2025.jsonl"), "utf8").split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
const freq = new Map();
let others = 0;
for (const r of records) {
  if (selectedIds.has(r.id)) continue;
  const cats = weaknessCategories(r);
  if (cats.length === 0) continue;
  others += 1;
  for (const c of cats) freq.set(c, (freq.get(c) ?? 0) + 1);
}
const ranked = [...freq.entries()].sort((a, b) => b[1] - a[1]);

const d2Rows = [];
for (const paper of sel2.selected) {
  const md = readFileSync(join(EXT2, paper.mdPath.replace(/^benchmark\//, "")), "utf8");
  const row = { id: paper.id, decision: paper.decision, mdChars: md.length, truncatedFraction: Math.max(0, 1 - INPUT_CHARS / md.length), human: paper.categories };
  for (const arm of ["A", "B"]) {
    const items = out2[`${paper.id}|${arm}`]?.parsed?.weaknesses ?? [];
    const valid = items.filter((i) => codes.has(i.category));
    const predicted = new Set(valid.map((i) => i.category));
    row[arm] = { items: items.length, distinctCategories: predicted.size, recall: paper.categories.filter((c) => predicted.has(c)).length / paper.categories.length, missed: paper.categories.filter((c) => !predicted.has(c)) };
  }
  for (const k of [5, 8, 10]) {
    const top = new Set(ranked.slice(0, k).map(([c]) => c));
    row[`trivialTop${k}`] = paper.categories.filter((c) => top.has(c)).length / paper.categories.length;
  }
  d2Rows.push(row);
}
const missedCount = (arm) => {
  const m = new Map();
  for (const r of d2Rows) for (const c of r[arm].missed) m.set(c, (m.get(c) ?? 0) + 1);
  return Object.fromEntries([...m.entries()].sort((a, b) => b[1] - a[1]));
};
const d2 = {
  reproduced: {
    recallA: bootstrapCi(d2Rows.map((r) => r.A.recall)),
    recallB: bootstrapCi(d2Rows.map((r) => r.B.recall)),
    diffBminusA: bootstrapCi(d2Rows.map((r) => r.B.recall - r.A.recall)),
  },
  original: { recallA: metrics2.summary.recallA, recallB: metrics2.summary.recallB, diffBminusA: metrics2.summary.diffBminusA },
  inputFidelity: {
    papersTruncated: d2Rows.filter((r) => r.truncatedFraction > 0).length,
    n: d2Rows.length,
    meanTruncatedFraction: d2Rows.reduce((a, r) => a + r.truncatedFraction, 0) / d2Rows.length,
    minChars: Math.min(...d2Rows.map((r) => r.mdChars)),
    maxChars: Math.max(...d2Rows.map((r) => r.mdChars)),
  },
  metricDiscrimination: {
    note: "平凡基线不读论文，恒输出训练外记录最常见的 K 个类别；若其召回 ≥ 模型，则类别级召回无法区分是否真的读懂论文。",
    otherRecords: others,
    topCategories: ranked.slice(0, 10),
    trivialTop5: bootstrapCi(d2Rows.map((r) => r.trivialTop5)),
    trivialTop8: bootstrapCi(d2Rows.map((r) => r.trivialTop8)),
    trivialTop10: bootstrapCi(d2Rows.map((r) => r.trivialTop10)),
    meanDistinctCategoriesA: d2Rows.reduce((a, r) => a + r.A.distinctCategories, 0) / d2Rows.length,
    meanDistinctCategoriesB: d2Rows.reduce((a, r) => a + r.B.distinctCategories, 0) / d2Rows.length,
  },
  missedByArm: { A: missedCount("A"), B: missedCount("B") },
  rows: d2Rows,
};

// ---------------- D3 ----------------
const EXT3 = join(M15, "external", "surveyreview-6566398");
const m3 = readJson(join(M15, "D3", "metrics.json"));
const sel3 = readJson(join(M15, "D3", "selection.json"));
const articles = { ...readJson(join(EXT3, "articles_part1.json")), ...readJson(join(EXT3, "articles_part2.json")) };
const rows3 = m3.rows;
const sign = (x) => Math.sign(x);
function scoreArm(pred) {
  const neg = rows3.filter((r) => r.ref < 0);
  const pos = rows3.filter((r) => r.ref > 0);
  const negRecall = neg.filter((r) => pred(r) < 0).length / Math.max(1, neg.length);
  const posRecall = pos.length === 0 ? null : pos.filter((r) => pred(r) > 0).length / pos.length;
  return {
    signAgreement: bootstrapCi(rows3.map((r) => (sign(pred(r)) === sign(r.ref) ? 1 : 0))),
    mae: bootstrapCi(rows3.map((r) => Math.abs(pred(r) - r.ref))),
    mse: rows3.reduce((a, r) => a + (pred(r) - r.ref) ** 2, 0) / rows3.length,
    negRecall,
    posRecall,
    balancedAccuracy: posRecall === null ? null : (negRecall + posRecall) / 2,
  };
}
// 参考文献位置：最后一个 references 标题的字符偏移是否 < 40,000
const refWindow = sel3.selected.map((s) => {
  const text = String(articles[s.articleKey]);
  const matches = [...text.matchAll(/\n#+\s*\**\s*(references|bibliography|literature cited)\b/gi)];
  const offset = matches.length > 0 ? matches[matches.length - 1].index : -1;
  return { uid: s.uid, chars: text.length, referencesOffset: offset, referencesInsideWindow: offset >= 0 && offset < INPUT_CHARS, truncated: text.length > INPUT_CHARS, comprehensivenessRef: s.reference.Comprehensiveness ?? 0 };
});
// 全测试集参考分分布（与 SurveyReview 论文表 6 对照：-2 4.46% / -1 66.25% / +1 24.73% / +2 4.56%）
const testset = readJson(join(EXT3, "grouped_testset.json"));
const dist = { "-2": 0, "-1": 0, "1": 0, "2": 0 };
for (const s of testset) for (const r of s.result) if (r.score !== 0) dist[String(r.score)] += 1;
const total = Object.values(dist).reduce((a, b) => a + b, 0);
const d3 = {
  original: { A: m3.summary.A.signAgreement, B: m3.summary.B.signAgreement },
  referenceNegativeShare: rows3.filter((r) => r.ref < 0).length / rows3.length,
  testsetDistribution: Object.fromEntries(Object.entries(dist).map(([k, v]) => [k, v / total])),
  arms: {
    A: scoreArm((r) => r.A),
    B: scoreArm((r) => r.B),
    constantMinus1: scoreArm(() => -1),
    constantPlus1: scoreArm(() => 1),
  },
  perDimension: Object.fromEntries(
    ["Readability", "Criticalness", "Comprehensiveness", "Structure"].map((d) => {
      const rs = rows3.filter((r) => r.dim === d);
      return [d, { n: rs.length, refMean: rs.reduce((a, r) => a + r.ref, 0) / Math.max(1, rs.length), aMean: rs.reduce((a, r) => a + r.A, 0) / Math.max(1, rs.length), bMean: rs.reduce((a, r) => a + r.B, 0) / Math.max(1, rs.length) }];
    }),
  ),
  polarityCheck: {
    note: "rubric（eval-prompt.json）：-2 最差 … +2 最好；参考分 0 = 未评估、已在 M15 score 中排除；未发现极性翻转。",
    zeroRowsIncluded: rows3.filter((r) => r.ref === 0).length,
  },
  referenceWindow: refWindow,
};

writeFileSync(join(OUT, "a-replay.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), d2, d3 }, null, 2)}\n`);
const pct = (x) => (x === null ? "n/a" : `${(x * 100).toFixed(1)}%`);
const ci = (c) => `${pct(c.mean)} [${pct(c.low)}, ${pct(c.high)}]`;
console.log(`D2 复算 A ${ci(d2.reproduced.recallA)} / B ${ci(d2.reproduced.recallB)} / B−A ${ci(d2.reproduced.diffBminusA)}`);
console.log(`D2 原始 A ${pct(d2.original.recallA.mean)} / B ${pct(d2.original.recallB.mean)} / B−A ${pct(d2.original.diffBminusA.mean)}`);
console.log(`D2 截断 ${d2.inputFidelity.papersTruncated}/${d2.inputFidelity.n}，平均截掉 ${pct(d2.inputFidelity.meanTruncatedFraction)}`);
console.log(`D2 平凡基线 top5 ${ci(d2.metricDiscrimination.trivialTop5)} top8 ${ci(d2.metricDiscrimination.trivialTop8)} top10 ${ci(d2.metricDiscrimination.trivialTop10)}；模型去重类别数 A ${d2.metricDiscrimination.meanDistinctCategoriesA.toFixed(1)} B ${d2.metricDiscrimination.meanDistinctCategoriesB.toFixed(1)}`);
console.log(`D2 漏检 A ${JSON.stringify(d2.missedByArm.A)}`);
console.log(`D2 漏检 B ${JSON.stringify(d2.missedByArm.B)}`);
for (const [k, v] of Object.entries(d3.arms)) console.log(`D3 ${k}: sign ${ci(v.signAgreement)} MAE ${v.mae.mean.toFixed(2)} MSE ${v.mse.toFixed(2)} negRecall ${pct(v.negRecall)} posRecall ${pct(v.posRecall)} BA ${pct(v.balancedAccuracy)}`);
console.log(`D3 参考负向 ${pct(d3.referenceNegativeShare)}；测试集分布 ${JSON.stringify(d3.testsetDistribution)}`);
console.log(`D3 分维 ${JSON.stringify(d3.perDimension)}`);
console.log(`D3 参考文献窗口 ${JSON.stringify(refWindow)}`);
