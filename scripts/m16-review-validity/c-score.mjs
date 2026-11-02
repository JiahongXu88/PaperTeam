#!/usr/bin/env node
/**
 * M16 · C：封存集评分（零模型；PROTOCOL §7 预注册指标，METRICS_SCHEMA.json 对应字段）。
 *
 *   node scripts/m16-review-validity/c-score.mjs
 *
 * 主指标：人类原子弱点意见召回@10（AI 清单前 10 条覆盖的人类意见数 / 该篇人类意见数；裁判 = AI_JUDGED_AUXILIARY）。
 * 预注册比较（论文级配对 bootstrap 95% CI）：
 *   V  裁判区分力：Afull − G0（CI 下界 > 0 才认为原子匹配指标在本样本上有效）
 *   H1 输入保真：Afull − Atrunc
 *   H2 证据纪律：Bfull − Afull
 *   P  生产链路：P − Afull、P − Bfull（n = 2，只描述，不下显著性结论）
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { M15, ROOT, bootstrapCi, humanWeaknesses, loadCocoRecords, productionFindings, quoteFound, readJson } from "./lib.mjs";

const C = join(ROOT, "C");
const sel = readJson(join(ROOT, "B", "sealed-selection.json")).selected;
const single = readJson(join(C, "single-pass.json"));
const judged = readJson(join(C, "judge-sealed.json"));
let judgedP = {};
try {
  judgedP = readJson(join(C, "judge-production.json"));
} catch {
  judgedP = {};
}
const records = loadCocoRecords(sel.map((p) => p.id));
const codes = new Set(readJson(join(M15, "external", "cocoreviewbench-2580687", "taxonomy.json")).map((t) => t.code));
const trivialTop8 = readJson(join(ROOT, "A", "a-replay.json")).d2.metricDiscrimination.topCategories.slice(0, 8).map(([c]) => c);
const md = (p) => readFileSync(join(ROOT, "external", "cocoreviewbench-md", p.mdPath.replace(/^benchmark\/MD\//, "")), "utf8");

/** 某臂在某篇上的覆盖：itemCount 条中前 k 条匹配到的人类意见集合 */
function coverage(matches, label, itemCount, k) {
  const covered = new Set();
  let matchedItems = 0;
  for (let i = 1; i <= Math.min(itemCount, k); i += 1) {
    const hs = (matches[`${label}-${i}`] ?? []).filter((h) => /^H\d+$/.test(h));
    if (hs.length > 0) matchedItems += 1;
    for (const h of hs) covered.add(h);
  }
  return { covered, matchedItems };
}

const perPaper = [];
for (const paper of sel) {
  const human = humanWeaknesses(records.get(paper.id));
  const humanCategories = [...new Set(human.flatMap((h) => h.category))];
  const j = judged[paper.id];
  const row = { id: paper.id, stratum: paper.stratum, productionArm: paper.productionArm, humanOpinions: human.length, arms: {} };
  if (j?.matches) {
    for (const list of j.lists) {
      const at10 = coverage(j.matches, list.label, list.n, 10);
      const all = coverage(j.matches, list.label, list.n, Infinity);
      const arm = { items: list.n, recallAt10: at10.covered.size / human.length, recallAll: all.covered.size / human.length, matchedItemRate: list.n === 0 ? null : all.matchedItems / list.n, covered: [...all.covered] };
      if (list.arm !== "G0") {
        const out = single[`${paper.id}|${list.arm}`];
        const items = out.parsed.weaknesses;
        const predicted = new Set(items.filter((i) => codes.has(i.category)).map((i) => i.category));
        arm.categoryRecall = humanCategories.filter((c) => predicted.has(c)).length / Math.max(1, humanCategories.length);
        arm.tokens = out.attempts.reduce((a, t) => ({ input: a.input + (t.usage?.input ?? 0), output: a.output + (t.usage?.output ?? 0) }), { input: 0, output: 0 });
        arm.calls = out.attempts.filter((t) => t.durationMs !== undefined).length;
        arm.durationMs = out.attempts.reduce((a, t) => a + (t.durationMs ?? 0), 0);
        if (list.arm === "Bfull") {
          const text = md(paper);
          arm.quoteClaimed = items.filter((i) => typeof i.evidenceQuote === "string" && i.evidenceQuote !== "").length;
          arm.quoteLocated = items.filter((i) => typeof i.evidenceQuote === "string" && quoteFound(i.evidenceQuote, text)).length;
          arm.insufficientEvidence = items.filter((i) => i.status === "INSUFFICIENT_EVIDENCE").length;
        }
      }
      row.arms[list.arm] = arm;
    }
    row.trivialTop8CategoryRecall = humanCategories.filter((c) => trivialTop8.includes(c)).length / Math.max(1, humanCategories.length);
  }
  const jp = judgedP[paper.id];
  if (jp?.matches) {
    const findings = productionFindings(paper.id);
    const run = readJson(join(C, "production", paper.id, "run-result.json"));
    const at10 = coverage(jp.matches, "L1", findings.length, 10);
    const all = coverage(jp.matches, "L1", findings.length, Infinity);
    const text = md(paper);
    row.arms.P = {
      items: findings.length,
      severity: findings.reduce((a, f) => ({ ...a, [f.severity]: (a[f.severity] ?? 0) + 1 }), {}),
      category: findings.reduce((a, f) => ({ ...a, [f.category]: (a[f.category] ?? 0) + 1 }), {}),
      recallAt10: at10.covered.size / human.length,
      recallAll: all.covered.size / human.length,
      matchedItemRate: all.matchedItems / Math.max(1, findings.length),
      covered: [...all.covered],
      quoteClaimed: findings.filter((f) => typeof f.quote === "string" && f.quote !== "").length,
      quoteLocated: findings.filter((f) => typeof f.quote === "string" && quoteFound(f.quote, text)).length,
      calls: run.callCount,
      failedCalls: run.failedCalls,
      tokens: run.calls.reduce((a, c) => ({ input: a.input + (c.usage?.inputTokens ?? 0), output: a.output + (c.usage?.outputTokens ?? 0) }), { input: 0, output: 0 }),
      durationMs: run.ms,
    };
    // POST_HOC（DEVIATIONS 05:45Z）：剔除 build 类（md_to_tex 转义数学等适配器伪影）后的前 10 条覆盖——不作结论依据
    const nonBuild = new Set();
    let taken = 0;
    findings.forEach((f, i) => {
      if (f.category === "build" || taken >= 10) return;
      taken += 1;
      for (const h of (jp.matches[`L1-${i + 1}`] ?? []).filter((x) => /^H\d+$/.test(x))) nonBuild.add(h);
    });
    row.arms.P.postHocRecallAt10ExclBuild = nonBuild.size / human.length;
    // 丢失路径取证入口：单次臂覆盖、生产未覆盖的人类意见
    const singleCovered = new Set([...(row.arms.Afull?.covered ?? []), ...(row.arms.Bfull?.covered ?? [])]);
    row.coveredBySingleNotProduction = [...singleCovered].filter((h) => !row.arms.P.covered.includes(h));
    row.coveredByProductionNotSingle = row.arms.P.covered.filter((h) => !singleCovered.has(h));
  }
  perPaper.push(row);
}

const done = perPaper.filter((r) => r.arms.Afull && r.arms.Atrunc && r.arms.Bfull && r.arms.G0);
const paired = (a, b, field = "recallAt10") => bootstrapCi(done.filter((r) => r.arms[a] && r.arms[b]).map((r) => r.arms[a][field] - r.arms[b][field]));
const mean = (arm, field) => bootstrapCi(done.filter((r) => r.arms[arm]?.[field] !== undefined && r.arms[arm][field] !== null).map((r) => r.arms[arm][field]));
const prodRows = perPaper.filter((r) => r.arms.P);
const summary = {
  nPapers: done.length,
  humanOpinionsPerPaper: done.reduce((a, r) => a + r.humanOpinions, 0) / Math.max(1, done.length),
  recallAt10: Object.fromEntries(["G0", "Atrunc", "Afull", "Bfull"].map((a) => [a, mean(a, "recallAt10")])),
  matchedItemRate: Object.fromEntries(["G0", "Atrunc", "Afull", "Bfull"].map((a) => [a, mean(a, "matchedItemRate")])),
  categoryRecall: { Atrunc: mean("Atrunc", "categoryRecall"), Afull: mean("Afull", "categoryRecall"), Bfull: mean("Bfull", "categoryRecall"), trivialTop8: bootstrapCi(done.map((r) => r.trivialTop8CategoryRecall)) },
  V_judgeValidity_AfullMinusG0: paired("Afull", "G0"),
  H1_inputFidelity_AfullMinusAtrunc: paired("Afull", "Atrunc"),
  H2_evidenceDiscipline_BfullMinusAfull: paired("Bfull", "Afull"),
  BfullQuoteLocatedRate: done.reduce((a, r) => a + r.arms.Bfull.quoteLocated, 0) / Math.max(1, done.reduce((a, r) => a + r.arms.Bfull.items, 0)),
  BfullInsufficientEvidence: done.reduce((a, r) => a + r.arms.Bfull.insufficientEvidence, 0),
  cost: Object.fromEntries(["Atrunc", "Afull", "Bfull"].map((a) => [a, {
    calls: done.reduce((s, r) => s + r.arms[a].calls, 0),
    inputTokens: done.reduce((s, r) => s + r.arms[a].tokens.input, 0),
    outputTokens: done.reduce((s, r) => s + r.arms[a].tokens.output, 0),
    durationMs: done.reduce((s, r) => s + r.arms[a].durationMs, 0),
  }])),
  production: prodRows.map((r) => ({
    id: r.id, stratum: r.stratum, humanOpinions: r.humanOpinions,
    P: { ...r.arms.P, covered: undefined }, Afull: { recallAt10: r.arms.Afull?.recallAt10, recallAll: r.arms.Afull?.recallAll }, Bfull: { recallAt10: r.arms.Bfull?.recallAt10, recallAll: r.arms.Bfull?.recallAll },
    coveredBySingleNotProduction: r.coveredBySingleNotProduction, coveredByProductionNotSingle: r.coveredByProductionNotSingle,
  })),
};
writeFileSync(join(C, "sealed-metrics.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), summary, perPaper }, null, 2)}\n`);
console.log(JSON.stringify(summary, null, 2));
