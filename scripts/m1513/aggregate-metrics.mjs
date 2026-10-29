#!/usr/bin/env node
/**
 * M15.13 Phase E4 — 指标聚合与预注册门裁决（零模型）。
 *
 * 输入：phase-e/issue-families.json + issue-typing-frozen.json + issue-alignment.jsonl
 *       + phase-d/out/<fam>/{c0,c0plus,c1opt,c2}.json + phase-d/model-calls.jsonl
 * 输出：phase-e/paired-metrics.json + 控制台摘要。
 *
 * 口径（预注册 §3；与 M15.12 的差异如实标注）：
 * - HRI-Coverage 族均；paired bootstrap seed=1513 B=2000；
 * - G1a 主门 = 双基线条件（C2−C0>0 ∧ C2−C0+>0 ∧ C2−max(C0,C0+)≥+5pp ∧
 *   对最强基线 CI95 下界>0）——修复 M15.12 只对 C0+ 的选择性引用缺陷；
 * - G1b = C2−C1opt ≥+3pp 且 CI 下界>0（整稿 pass 净增量）；
 * - G2 = serious/meta 对最强基线 point Δ≥0；
 * - G3 = C2 调用 ≤20/族（硬）+ 墙钟 ≤4×C0（目标；超标→LATENCY_RISK 标注）+ p90/max；
 * - G4 = top-10 retention（对同臂全量匹配的分子分母分离）+ serious 占比 + 重复率
 *   + 一对一口径可达上限 min(K,matched)/matched；
 * - 严格一对一敏感性、grounded、成本分账沿袭 M15.12（armHint 新增
 *   workflow-section-batch → c1opt）。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.M1513_ROOT ? resolve(process.env.M1513_ROOT) : resolve("D:\\PaperTeamData\\M15\\M15_13");

const ARMS = ["c0", "c0plus", "c1opt", "c2"];
const manifest = JSON.parse(await readFile(join(ROOT, "phase-c", "sample-manifest.json"), "utf8"));
const formalFams = manifest.families.filter((f) => f.role === "HELD-OUT").map((f) => f.familyId);
const issueFamilies = JSON.parse(await readFile(join(ROOT, "phase-e", "issue-families.json"), "utf8"));
const typing = JSON.parse(await readFile(join(ROOT, "phase-e", "issue-typing-frozen.json"), "utf8"));
const typingByIF = new Map((typing.issueFamilies ?? []).map((t) => [t.issueFamily, t]));

const alignment = {};
for (const line of (await readFile(join(ROOT, "phase-e", "issue-alignment.jsonl"), "utf8")).split("\n")) {
  if (line.trim() === "") continue;
  const r = JSON.parse(line);
  alignment[`${r.familyId}:${r.arm}`] = r;
}

const issuesByFam = new Map();
for (const g of issueFamilies) {
  if (!issuesByFam.has(g.familyId)) issuesByFam.set(g.familyId, []);
  issuesByFam.get(g.familyId).push(g);
}

function matchedSets(famId, arm) {
  const rec = alignment[`${famId}:${arm}`];
  const issues = issuesByFam.get(famId) ?? [];
  if (!rec || !Array.isArray(rec.pairs)) return { matched: new Set(), matchedB: new Set(), strict: new Set(), pairs: [] };
  const matched = new Set();
  const matchedB = new Set();
  for (const p of rec.pairs) {
    if (p.b !== null && p.b !== undefined) {
      matched.add(p.a);
      matchedB.add(p.b);
    }
  }
  const rank = { high: 3, medium: 2, low: 1 };
  const bestForB = new Map();
  for (const p of rec.pairs) {
    if (p.b === null || p.b === undefined) continue;
    const key = p.b;
    const prev = bestForB.get(key);
    if (prev === undefined || (rank[p.confidence ?? "low"] ?? 1) > (rank[prev.confidence ?? "low"] ?? 1) || ((rank[p.confidence ?? "low"] ?? 1) === (rank[prev.confidence ?? "low"] ?? 1) && p.a < prev.a)) {
      bestForB.set(key, p);
    }
  }
  const strict = new Set([...bestForB.values()].map((p) => p.a));
  return { matched, matchedB, strict, pairs: rec.pairs };
}

function grounded(f) {
  const claim = String(f.claimText ?? "");
  if (claim.length >= 20) return true;
  if (typeof f.page === "number" && f.page >= 1 && f.page <= 200) return true;
  return false;
}
const armData = {};
const notEvaluated = [];
for (const famId of formalFams) {
  armData[famId] = {};
  for (const arm of ARMS) {
    const p = join(ROOT, "phase-d", "out", famId, `${arm}.json`);
    armData[famId][arm] = existsSync(p) ? JSON.parse(await readFile(p, "utf8")) : null;
    // 预注册 §4 缺失输出策略：臂级失败（解析/预算）→ 该族该臂 NOT_EVALUATED，
    // 从该臂均值与涉及该臂的配对差中剔除（如实报告，不伪装 0 覆盖）
    const status = armData[famId][arm]?.status;
    const failed =
      armData[famId][arm] === null ||
      (arm === "c0" && status !== "ok") ||
      (arm === "c0plus" && status !== "ok") ||
      (arm === "c1opt" && status !== "ok") ||
      (arm === "c2" && status !== "completed");
    if (failed) {
      notEvaluated.push(`${famId}/${arm} (${status ?? "missing"})`);
      armData[famId][arm] = null;
    }
  }
}

function coverage(arm, subset = null, strictMode = false) {
  const perFam = [];
  for (const famId of formalFams) {
    if (armData[famId][arm] === null) { perFam.push(null); continue; } // NOT_EVALUATED
    const issues = issuesByFam.get(famId) ?? [];
    const { matched, strict } = matchedSets(famId, arm);
    const use = strictMode ? strict : matched;
    const filtered = subset === null ? issues : issues.filter((g) => subset(g));
    if (filtered.length === 0) { perFam.push(null); continue; }
    let hit = 0;
    filtered.forEach((g, i) => {
      if (use.has(i + 1)) hit += 1;
    });
    perFam.push(hit / filtered.length);
  }
  const valid = perFam.filter((v) => v !== null);
  return {
    perFamily: perFam,
    familyMean: valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : null,
    families: valid.length,
  };
}

const seriousSubset = (g) => typingByIF.get(g.issueFamily)?.serious === true;
const metaSubset = (g) => typingByIF.get(g.issueFamily)?.meta === true;

function pairedDiffCI(armA, armB, subset = null, strictMode = false, B = 2000, seed = 1513) {
  const a = coverage(armA, subset, strictMode).perFamily;
  const b = coverage(armB, subset, strictMode).perFamily;
  const diffs = a.map((v, i) => (v === null || b[i] === null ? null : v - b[i])).filter((v) => v !== null);
  if (diffs.length === 0) return { n: 0, meanDiff: null, ci95: null };
  const meanDiff = diffs.reduce((x, y) => x + y, 0) / diffs.length;
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const boots = [];
  for (let i = 0; i < B; i += 1) {
    let sum = 0;
    for (let j = 0; j < diffs.length; j += 1) {
      sum += diffs[Math.floor(rand() * diffs.length)];
    }
    boots.push(sum / diffs.length);
  }
  boots.sort((x, y) => x - y);
  return {
    n: diffs.length,
    meanDiff,
    ci95: { lo: boots[Math.floor(0.025 * B)], hi: boots[Math.floor(0.975 * B)] },
    perFamilyDiffs: diffs,
  };
}

// ---- 成本（model-calls.jsonl 分账；armHint 新增 workflow-section-batch → c1opt） ----
const callsByFamArm = {};
for (const line of (await readFile(join(ROOT, "phase-d", "model-calls.jsonl"), "utf8")).split("\n")) {
  if (line.trim() === "") continue;
  const c = JSON.parse(line);
  const fam = c.familyId;
  if (!fam || !formalFams.includes(fam)) continue;
  let arm = null;
  if (c.armHint === "c0") arm = "c0";
  else if (c.armHint === "c0plus") arm = "c0plus";
  else if (c.armHint === "c2-fullpaper") arm = "c2-increment";
  else if (c.armHint === "workflow" || c.armHint === "workflow-section-batch") arm = "c1opt";
  else if (c.armHint === "judge" || c.armHint === "typing-judge") arm = c.armHint;
  else continue;
  const key = `${fam}:${arm}`;
  callsByFamArm[key] ??= { n: 0, ms: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, estimatedCost: 0 };
  const slot = callsByFamArm[key];
  slot.n += 1;
  slot.ms += c.ms ?? 0;
  const u = c.usage ?? {};
  slot.inputTokens += u.inputTokens ?? 0;
  slot.outputTokens += u.outputTokens ?? 0;
  slot.cacheReadTokens += u.cacheReadTokens ?? 0;
  slot.estimatedCost += u.estimatedCost ?? 0;
}
function armCost(arm) {
  const perFam = formalFams.map((famId) => {
    const zero = { n: 0, ms: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, estimatedCost: 0 };
    const base = callsByFamArm[`${famId}:c1opt`] ?? zero;
    const inc = callsByFamArm[`${famId}:c2-increment`] ?? zero;
    const direct = arm === "c0" || arm === "c0plus" ? (callsByFamArm[`${famId}:${arm}`] ?? zero) : null;
    const src = direct ?? (arm === "c2"
      ? { n: base.n + inc.n, ms: base.ms + inc.ms, inputTokens: base.inputTokens + inc.inputTokens, outputTokens: base.outputTokens + inc.outputTokens, cacheReadTokens: base.cacheReadTokens + inc.cacheReadTokens, estimatedCost: base.estimatedCost + inc.estimatedCost }
      : base);
    return { ...src, familyId: famId };
  });
  const sum = (field) => perFam.reduce((a, b) => a + b[field], 0);
  const sortedCalls = perFam.map((c) => c.n).sort((a, b) => a - b);
  const p90 = sortedCalls.length > 0 ? sortedCalls[Math.floor(0.9 * (sortedCalls.length - 1))] : null;
  return {
    callsPerFamily: sum("n") / formalFams.length,
    callsPerFamilySorted: sortedCalls,
    callsP90: p90,
    callsMax: sortedCalls.at(-1) ?? null,
    wallMsPerFamily: sum("ms") / formalFams.length,
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    cacheReadTokens: sum("cacheReadTokens"),
    estimatedCost: sum("estimatedCost"),
    perFamily: perFam.map(({ familyId, n, ms, estimatedCost }) => ({ familyId, calls: n, wallMs: ms, estimatedCost })),
  };
}

// ---- G4：top-10 诚实分母四件套（c2） ----
function topKValue() {
  const perFamRetention = [];
  let seriousTopN = 0, topN = 0, metaTopN = 0;
  let dupCollapsed = 0, poolSize = 0, itemsN = 0;
  for (const famId of formalFams) {
    const rec = alignment[`${famId}:c2`];
    const data = armData[famId]["c2"];
    const pv = data?.priorityView;
    if (pv) {
      dupCollapsed += pv.dedupCollapsed ?? 0;
      poolSize += pv.poolSize ?? pv.items?.length ?? 0;
      itemsN += pv.items?.length ?? 0;
      seriousTopN += pv.seriousCount ?? 0;
      metaTopN += pv.metaCount ?? 0;
    }
    topN += pv?.items?.length ?? 0;
    if (!rec || !Array.isArray(rec.pairs) || !data) { perFamRetention.push(null); continue; }
    const topIds = new Set((pv?.items ?? []).map((i) => i.findingId));
    const findings = data.findings ?? [];
    let matchedFull = 0;
    let matchedTop = 0;
    for (const p of rec.pairs) {
      if (p.b === null || p.b === undefined) continue;
      matchedFull += 1;
      const f = findings[p.b - 1];
      if (f && topIds.has(f.findingId)) matchedTop += 1;
    }
    perFamRetention.push(matchedFull > 0 ? matchedTop / matchedFull : null);
  }
  const valid = perFamRetention.filter((v) => v !== null);
  const retentionMean = valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : null;
  // 一对一口径可达上限（对照展示）：min(10, matched_full)/matched_full 族均
  const ceilings = [];
  for (const famId of formalFams) {
    const rec = alignment[`${famId}:c2`];
    if (!rec || !Array.isArray(rec.pairs)) continue;
    const matchedFull = rec.pairs.filter((p) => p.b !== null && p.b !== undefined).length;
    if (matchedFull > 0) ceilings.push(Math.min(10, matchedFull) / matchedFull);
  }
  return {
    topKRetentionPerFamily: perFamRetention,
    topKRetentionMean: retentionMean,
    topKFullCoverage: coverage("c2").familyMean,
    top10SeriousShare: topN > 0 ? seriousTopN / topN : null,
    top10MetaShare: topN > 0 ? metaTopN / topN : null,
    dedupCollapsedTotal: dupCollapsed,
    poolSizeTotal: poolSize,
    topItemsTotal: itemsN,
    nearDupRate: poolSize > 0 ? dupCollapsed / (dupCollapsed + poolSize) : null,
    oneToOneCeilingMean: ceilings.length > 0 ? ceilings.reduce((a, b) => a + b, 0) / ceilings.length : null,
  };
}

function groundedRatio(arm) {
  let groundedN = 0;
  let total = 0;
  for (const famId of formalFams) {
    const data = armData[famId][arm];
    for (const f of data?.findings ?? []) {
      total += 1;
      if (grounded(f)) groundedN += 1;
    }
  }
  return total > 0 ? groundedN / total : null;
}

// ---- 汇总 ----
const primary = {};
for (const arm of ARMS) primary[arm] = { hri: coverage(arm), hriStrict: coverage(arm, null, true), serious: coverage(arm, seriousSubset), seriousStrict: coverage(arm, seriousSubset, true), meta: coverage(arm, metaSubset), metaStrict: coverage(arm, metaSubset, true) };
const diffs = {
  "c2-c0plus": pairedDiffCI("c2", "c0plus"),
  "c2-c0plus-strict": pairedDiffCI("c2", "c0plus", null, true),
  "c2-c0": pairedDiffCI("c2", "c0"),
  "c2-c0-strict": pairedDiffCI("c2", "c0", null, true),
  "c1opt-c0plus": pairedDiffCI("c1opt", "c0plus"),
  "c1opt-c0": pairedDiffCI("c1opt", "c0"),
  "c2-c1opt": pairedDiffCI("c2", "c1opt"),
  serious: { "c2-c0plus": pairedDiffCI("c2", "c0plus", seriousSubset), "c2-c0": pairedDiffCI("c2", "c0", seriousSubset), "c2-c1opt": pairedDiffCI("c2", "c1opt", seriousSubset), "c1opt-c0plus": pairedDiffCI("c1opt", "c0plus", seriousSubset) },
  meta: { "c2-c0plus": pairedDiffCI("c2", "c0plus", metaSubset), "c2-c0": pairedDiffCI("c2", "c0", metaSubset), "c2-c1opt": pairedDiffCI("c2", "c1opt", metaSubset), "c1opt-c0plus": pairedDiffCI("c1opt", "c0plus", metaSubset) },
};
const costs = {};
for (const arm of ARMS) costs[arm] = armCost(arm);
const topK = topKValue();
const groundedRatios = {};
for (const arm of ARMS) groundedRatios[arm] = groundedRatio(arm);
const seriousN = [...typingByIF.values()].filter((t) => t.serious).length;
const metaN = [...typingByIF.values()].filter((t) => t.meta).length;

// 单位检出成本（调用/百匹配问题族；合并口径）
const pooledMatched = {};
for (const arm of ARMS) {
  let hit = 0;
  for (const famId of formalFams) {
    const issues = issuesByFam.get(famId) ?? [];
    const { matched } = matchedSets(famId, arm);
    hit += Math.min(matched.size, issues.length);
  }
  pooledMatched[arm] = hit;
}
const callsPerHundredMatched = {};
for (const arm of ARMS) callsPerHundredMatched[arm] = pooledMatched[arm] > 0 ? (costs[arm].callsPerFamily * formalFams.length) / pooledMatched[arm] * 100 : null;

// ---- 预注册门（§3；只评估不放宽） ----
const c2c0p = diffs["c2-c0plus"];
const c2c0 = diffs["c2-c0"];
const c2c1 = diffs["c2-c1opt"];
const hriC0 = primary.c0.hri.familyMean;
const hriC0p = primary.c0plus.hri.familyMean;
const strongest = hriC0 !== null && hriC0p !== null && hriC0 >= hriC0p ? "c0" : "c0plus";
const strongDiff = strongest === "c0" ? c2c0 : c2c0p;
const strongSerious = strongest === "c0" ? diffs.serious["c2-c0"] : diffs.serious["c2-c0plus"];
const strongMeta = strongest === "c0" ? diffs.meta["c2-c0"] : diffs.meta["c2-c0plus"];
const wallRatio = costs.c0.wallMsPerFamily > 0 ? costs.c2.wallMsPerFamily / costs.c0.wallMsPerFamily : null;

const gates = {
  g1a_primary_dual_baseline: {
    threshold: "C2−C0>0 ∧ C2−C0+>0 ∧ C2−max(C0,C0+)≥+5pp ∧ 对最强基线 CI95 下界>0",
    strongestBaseline: strongest,
    c2MinusC0: c2c0.meanDiff,
    c2MinusC0Ci: c2c0.ci95,
    c2MinusC0plus: c2c0p.meanDiff,
    c2MinusC0plusCi: c2c0p.ci95,
    c2MinusStrongest: strongDiff.meanDiff,
    c2MinusStrongestCi: strongDiff.ci95,
    pass:
      c2c0.meanDiff !== null && c2c0.meanDiff > 0 &&
      c2c0p.meanDiff !== null && c2c0p.meanDiff > 0 &&
      strongDiff.meanDiff !== null && strongDiff.meanDiff >= 0.05 &&
      strongDiff.ci95 !== null && strongDiff.ci95.lo > 0,
  },
  g1b_fullpaper_ablation: {
    threshold: "C2−C1opt ≥ +3pp 且 CI95 下界 >0",
    value: c2c1.meanDiff,
    ci: c2c1.ci95,
    pass: c2c1.meanDiff !== null && c2c1.meanDiff >= 0.03 && c2c1.ci95 !== null && c2c1.ci95.lo > 0,
  },
  g2_subsets_no_regression: {
    threshold: "SERIOUS/META 对最强基线 point Δ ≥ 0",
    seriousDelta: strongSerious.meanDiff,
    metaDelta: strongMeta.meanDiff,
    seriousCi: strongSerious.ci95,
    metaCi: strongMeta.ci95,
    pass: strongSerious.meanDiff !== null && strongSerious.meanDiff >= 0 && strongMeta.meanDiff !== null && strongMeta.meanDiff >= 0,
  },
  g3_cost: {
    threshold: "C2 调用 ≤20/族（硬）；墙钟 ≤4×C0（目标，超标→LATENCY_RISK）",
    c2CallsPerFamily: costs.c2.callsPerFamily,
    c2CallsP90: costs.c2.callsP90,
    c2CallsMax: costs.c2.callsMax,
    wallRatioVsC0: wallRatio,
    latencyRisk: wallRatio !== null && wallRatio > 4,
    pass: costs.c2.callsPerFamily <= 20,
  },
  g4_topk_honest_denominators: {
    threshold: "可用性审计（非独立 GO 阻断）：retention/serious share/dup rate/一对一上限",
    retention: topK.topKRetentionMean,
    top10SeriousShare: topK.top10SeriousShare,
    nearDupRate: topK.nearDupRate,
    oneToOneCeilingMean: topK.oneToOneCeilingMean,
    note: "AI-only findings remain UNVERIFIED_AI_ONLY; never auto-labeled FP",
    pass: null,
  },
  g5_guards: { note: "gates.ts/qualityPolicyV2/N1/N2/H 零改动 + 回归全绿——由 git diff 与测试证明，非本脚本", pass: null },
};

const out = {
  generatedAt: new Date().toISOString(),
  families: formalFams,
  notEvaluated,
  label: "proxy-matching measurement (external labels = PeerRead ICLR 2017 public human review content; issue segmentation & matching are model-assisted; venue/year drift vs M15.11/12 disclosed)",
  coverage: primary,
  pairedDiffs: diffs,
  topKValue,
  groundedRatio: groundedRatios,
  costs,
  pooledMatched,
  callsPerHundredMatched,
  typing: { seriousIssueFamilies: seriousN, metaIssueFamilies: metaN, corrections: typing.corrections ?? null },
  gates,
};
await mkdir(join(ROOT, "phase-e"), { recursive: true });
await writeFile(join(ROOT, "phase-e", "paired-metrics.json"), JSON.stringify(out, null, 1), "utf8");
const fmt = (v) => (v === null || v === undefined ? "n/a" : `${(v * 100).toFixed(1)}%`);
console.log("=== M15.13 四臂指标（族均） ===");
for (const arm of ARMS) {
  console.log(`${arm.padEnd(7)} HRI=${fmt(primary[arm].hri.familyMean)} strict=${fmt(primary[arm].hriStrict.familyMean)} serious=${fmt(primary[arm].serious.familyMean)} meta=${fmt(primary[arm].meta.familyMean)} calls/fam=${costs[arm].callsPerFamily.toFixed(1)} p90=${costs[arm].callsP90} max=${costs[arm].callsMax} cost=$${costs[arm].estimatedCost.toFixed(2)}`);
}
console.log(`C2−C0   = ${fmt(c2c0.meanDiff)} CI95 [${fmt(c2c0.ci95?.lo)}, ${fmt(c2c0.ci95?.hi)}] n=${c2c0.n}`);
console.log(`C2−C0+  = ${fmt(c2c0p.meanDiff)} CI95 [${fmt(c2c0p.ci95?.lo)}, ${fmt(c2c0p.ci95?.hi)}] n=${c2c0p.n}`);
console.log(`C2−C1opt= ${fmt(c2c1.meanDiff)} CI95 [${fmt(c2c1.ci95?.lo)}, ${fmt(c2c1.ci95?.hi)}] n=${c2c1.n}`);
console.log(`strongest baseline = ${strongest}; G1a C2−strongest = ${fmt(strongDiff.meanDiff)}`);
console.log(`top-10 retention = ${fmt(topK.topKRetentionMean)} (serious share ${fmt(topK.top10SeriousShare)}, dup rate ${fmt(topK.nearDupRate)}, 1-1 ceiling ${fmt(topK.oneToOneCeilingMean)})`);
console.log(`wall C2/C0 = ${wallRatio === null ? "n/a" : wallRatio.toFixed(1) + "x"}`);
for (const [k, v] of Object.entries(gates)) console.log(`${k}: ${v.pass === null ? "MANUAL" : v.pass ? "PASS" : "FAIL"}`);
