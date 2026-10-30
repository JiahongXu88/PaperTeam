#!/usr/bin/env node
/**
 * M15.14 Phase E4 — 零模型聚合：TARGET 子集覆盖率（宽松+严格一对一共同主口径）、
 * 配对 bootstrap CI（seed=1514, B=2000）、消融、成本、守卫门汇总、裁决输入。
 *
 * 预注册门（PROTOCOL_FROZEN §5）：
 *   G1a（严格一对一，共同主口径）：A2−maxBase|TARGET ≥ +8pp 且 CI95 下界>0
 *   G1b（宽松，共同主口径）：A2−maxBase|TARGET > 0 且 CI95 下界>0
 *   G2（消融，探索性）：a2np 子族上 A2−A2np|TARGET 宽松点估计 > 0
 *   G3（守卫，读 audit-guards.json）：fabricatedCitations=0 ∧ dualAnchorRatio≥0.70
 *   G4（成本）：A2 调用/族 ≤6 ∧ A2 单位成本（调用/匹配 TARGET 问题）≤ A1
 *   UNDERPOWERED：TARGET 问题族总数 <60 或 含 TARGET 问题的族 <8 → 不作 G1 判定
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.M1514_ROOT ? resolve(process.env.M1514_ROOT) : resolve("D:\\PaperTeamData\\M15\\M15_14");
const ARMS = ["a0", "a1", "a2", "a2np"];
const TARGET_TAXONOMIES = ["novelty_prior_art", "contribution_significance", "related_work", "claim_evidence_gap", "overclaiming"];
const B = 2000;
const SEED = 1514;

const projectsInfo = JSON.parse(await readFile(join(ROOT, "phase-c", "projects.json"), "utf8"));
const formalFams = projectsInfo.families.filter((f) => f.role === "PRIMARY").map((f) => f.familyId);
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
  if (!formalFams.includes(g.familyId)) continue;
  if (!issuesByFam.has(g.familyId)) issuesByFam.set(g.familyId, []);
  issuesByFam.get(g.familyId).push(g);
}

function matchedSets(famId, arm) {
  const rec = alignment[`${famId}:${arm}`];
  if (!rec || !Array.isArray(rec.pairs)) return { matched: new Set(), strict: new Set(), pairs: [] };
  const matched = new Set();
  for (const p of rec.pairs) {
    if (p.b !== null && p.b !== undefined) matched.add(p.a);
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
  return { matched, strict, pairs: rec.pairs };
}

const armData = {};
const notEvaluated = [];
for (const famId of formalFams) {
  armData[famId] = {};
  for (const arm of ARMS) {
    const p = join(ROOT, "phase-d", "out", famId, `${arm}.json`);
    armData[famId][arm] = existsSync(p) ? JSON.parse(await readFile(p, "utf8")) : null;
    if (armData[famId][arm] === null && arm !== "a2np") {
      notEvaluated.push(`${famId}/${arm} (missing)`);
    }
  }
}

function coverage(arm, subset = null, strictMode = false, fams = formalFams) {
  const perFam = [];
  for (const famId of fams) {
    if (armData[famId]?.[arm] === null || armData[famId]?.[arm] === undefined) { perFam.push(null); continue; }
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

const targetSubset = (g) => TARGET_TAXONOMIES.includes(typingByIF.get(g.issueFamily)?.taxonomy ?? "other");
const seriousSubset = (g) => typingByIF.get(g.issueFamily)?.serious === true;
const typed = [...typingByIF.values()];
const targetTotal = typed.filter((t) => TARGET_TAXONOMIES.includes(t.taxonomy ?? "other")).length;
const famsWithTarget = formalFams.filter((famId) => (issuesByFam.get(famId) ?? []).some(targetSubset)).length;
const underpowered = targetTotal < 60 || famsWithTarget < 8;

function pairedDiffCI(covA, covB, B_ = B, seed = SEED) {
  const diffs = covA.perFamily.map((v, i) => (v === null || covB.perFamily[i] === null ? null : v - covB.perFamily[i])).filter((v) => v !== null);
  if (diffs.length === 0) return { n: 0, meanDiff: null, ci95: null, perFamilyDiffs: [] };
  const meanDiff = diffs.reduce((x, y) => x + y, 0) / diffs.length;
  let s = seed;
  const rand = () => {
    s = (s * 1103515245 + 12345) % 2147483648;
    return s / 2147483648;
  };
  const boots = [];
  for (let i = 0; i < B_; i += 1) {
    let sum = 0;
    for (let j = 0; j < diffs.length; j += 1) sum += diffs[Math.floor(rand() * diffs.length)];
    boots.push(sum / diffs.length);
  }
  boots.sort((x, y) => x - y);
  return { n: diffs.length, meanDiff, ci95: { lo: boots[Math.floor(0.025 * B_)], hi: boots[Math.floor(0.975 * B_)] }, perFamilyDiffs: diffs };
}

const metrics = { arms: {}, subsets: {} };
for (const arm of ["a0", "a1", "a2"]) {
  metrics.arms[arm] = {
    targetLoose: coverage(arm, targetSubset, false),
    targetStrict: coverage(arm, targetSubset, true),
    allLoose: coverage(arm, null, false),
    allStrict: coverage(arm, null, true),
    seriousLoose: coverage(arm, seriousSubset, false),
    findingsTotal: formalFams.reduce((acc, f) => acc + (armData[f]?.[arm]?.findings?.length ?? 0), 0),
    groundedRatio: (() => {
      let groundedCount = 0;
      let total = 0;
      for (const f of formalFams) {
        for (const fd of armData[f]?.[arm]?.findings ?? []) {
          total += 1;
          const claim = String(fd.claimText ?? "");
          if (claim.length >= 20 || (typeof fd.page === "number" && fd.page >= 1 && fd.page <= 200) || (fd.sectionId !== undefined && fd.sectionId !== "")) groundedCount += 1;
        }
      }
      return total > 0 ? groundedCount / total : null;
    })(),
  };
}

// 基线 = 按族均值较强者（不挑弱基线）
function maxBase(strictMode) {
  const a0 = metrics.arms.a0[strictMode ? "targetStrict" : "targetLoose"].familyMean;
  const a1 = metrics.arms.a1[strictMode ? "targetStrict" : "targetLoose"].familyMean;
  return a0 !== null && (a1 === null || a0 >= a1) ? "a0" : "a1";
}
const diffs = {};
for (const strictMode of [false, true]) {
  const tag = strictMode ? "Strict" : "Loose";
  const base = maxBase(strictMode);
  diffs[`a2-vs-${base}-${tag}`] = pairedDiffCI(metrics.arms.a2[`target${tag}`], metrics.arms[base][`target${tag}`]);
  diffs[`a2-vs-a0-${tag}`] = pairedDiffCI(metrics.arms.a2[`target${tag}`], metrics.arms.a0[`target${tag}`]);
  diffs[`a2-vs-a1-${tag}`] = pairedDiffCI(metrics.arms.a2[`target${tag}`], metrics.arms.a1[`target${tag}`]);
  // 敏感性：逐族 max 基线（最严苛）
  const perFamMax = metrics.arms.a2[`target${tag}`].perFamily.map((v, i) => {
    const b0 = metrics.arms.a0[`target${tag}`].perFamily[i];
    const b1 = metrics.arms.a1[`target${tag}`].perFamily[i];
    if (v === null) return null;
    const candidates = [b0, b1].filter((x) => x !== null);
    if (candidates.length === 0) return null;
    return v - Math.max(...candidates);
  });
  const validMax = perFamMax.filter((v) => v !== null);
  diffs[`a2-vs-perFamMax-${tag}`] = {
    n: validMax.length,
    meanDiff: validMax.length > 0 ? validMax.reduce((a, b) => a + b, 0) / validMax.length : null,
    perFamilyDiffs: perFamMax,
  };
}

// ---- 消融（a2np 子族） ----
const ablationFams = formalFams.filter((f) => armData[f]?.a2np !== null && armData[f]?.a2np !== undefined);
const ablation = {};
if (ablationFams.length > 0) {
  const a2cov = coverage("a2", targetSubset, false, ablationFams);
  const a2npcov = coverage("a2np", targetSubset, false, ablationFams);
  ablation.families = ablationFams;
  ablation.a2TargetLoose = a2cov.familyMean;
  ablation.a2npTargetLoose = a2npcov.familyMean;
  ablation.diff = pairedDiffCI(a2cov, a2npcov);
}

// ---- 成本 ----
const callsByFamArm = {};
for (const line of (await readFile(join(ROOT, "phase-d", "model-calls.jsonl"), "utf8")).split("\n")) {
  if (line.trim() === "") continue;
  const c = JSON.parse(line);
  const fam = c.familyId;
  if (!fam || !formalFams.includes(fam)) continue;
  const arm = ["a0", "a1-fullpaper", "a2", "a2np", "judge", "typing-judge"].includes(c.armHint) ? c.armHint : null;
  if (arm === null) continue;
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
function armCost(hints) {
  const perFam = formalFams.map((famId) => {
    const zero = { n: 0, ms: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, estimatedCost: 0 };
    const rows = hints.map((h) => callsByFamArm[`${famId}:${h}`] ?? zero);
    return {
      familyId: famId,
      n: rows.reduce((a, b) => a + b.n, 0),
      ms: rows.reduce((a, b) => a + b.ms, 0),
      inputTokens: rows.reduce((a, b) => a + b.inputTokens, 0),
      outputTokens: rows.reduce((a, b) => a + b.outputTokens, 0),
      cacheReadTokens: rows.reduce((a, b) => a + b.cacheReadTokens, 0),
      estimatedCost: rows.reduce((a, b) => a + b.estimatedCost, 0),
    };
  });
  const sum = (field) => perFam.reduce((a, b) => a + b[field], 0);
  const sortedCalls = perFam.map((c) => c.n).sort((a, b) => a - b);
  return {
    callsPerFamily: sum("n") / (formalFams.length || 1),
    callsP90: sortedCalls[Math.floor(0.9 * (sortedCalls.length - 1))] ?? null,
    callsMax: sortedCalls.at(-1) ?? null,
    wallMsPerFamily: sum("ms") / (formalFams.length || 1),
    inputTokens: sum("inputTokens"),
    outputTokens: sum("outputTokens"),
    cacheReadTokens: sum("cacheReadTokens"),
    estimatedCost: sum("estimatedCost"),
    perFamily: perFam.map(({ familyId, n, ms, estimatedCost }) => ({ familyId, calls: n, wallMs: ms, estimatedCost })),
  };
}
const cost = {
  a0: armCost(["a0"]),
  a1: armCost(["a1-fullpaper"]),
  a2: armCost(["a2"]),
  a2np: ablationFams.length > 0 ? armCost(["a2np"]) : null,
  judge: armCost(["judge"]),
  typing: armCost(["typing-judge"]),
};
// 单位有效成本：调用 / 匹配 TARGET 问题数（宽松，族合并）
function matchedTargetCount(arm) {
  let total = 0;
  for (const famId of formalFams) {
    const issues = (issuesByFam.get(famId) ?? []).filter(targetSubset);
    const { matched } = matchedSets(famId, arm);
    let hit = 0;
    issues.forEach((g, i) => { if (matched.has(i + 1)) hit += 1; });
    total += hit;
  }
  return total;
}
const unitCost = {};
for (const arm of ["a0", "a1", "a2"]) {
  const calls = cost[arm].callsPerFamily * formalFams.length;
  const matched = matchedTargetCount(arm);
  unitCost[arm] = { callsTotal: calls, matchedTargetIssues: matched, callsPerMatchedIssue: matched > 0 ? calls / matched : null };
}

// ---- 守卫（读 audit-guards.json 若已生成） ----
const guardsPath = join(ROOT, "phase-e", "audit-guards.json");
const guards = existsSync(guardsPath) ? JSON.parse(await readFile(guardsPath, "utf8")) : { status: "PENDING" };

// ---- 门判定 ----
const strictDiff = diffs[`a2-vs-${maxBase(true)}-Strict`];
const looseDiff = diffs[`a2-vs-${maxBase(false)}-Loose`];
const gates = {
  underpowered,
  targetTotal,
  famsWithTarget,
  G1a: underpowered
    ? { verdict: "NOT_JUDGED_UNDERPOWERED", base: maxBase(true), diff: strictDiff }
    : {
        verdict: strictDiff.meanDiff !== null && strictDiff.meanDiff >= 0.08 && strictDiff.ci95 !== null && strictDiff.ci95.lo > 0 ? "PASS" : "FAIL",
        base: maxBase(true),
        diff: strictDiff,
      },
  G1b: underpowered
    ? { verdict: "NOT_JUDGED_UNDERPOWERED", base: maxBase(false), diff: looseDiff }
    : {
        verdict: looseDiff.meanDiff !== null && looseDiff.meanDiff > 0 && looseDiff.ci95 !== null && looseDiff.ci95.lo > 0 ? "PASS" : "FAIL",
        base: maxBase(false),
        diff: looseDiff,
      },
  G2: { verdict: ablation.diff?.meanDiff !== null && ablation.diff?.meanDiff !== undefined && ablation.diff.meanDiff > 0 ? "PASS" : "FAIL", ablation },
  G3: guards.status === "PENDING" ? { verdict: "PENDING", note: "先运行 audit-guards.mjs" } : guards.gates ?? guards,
  G4: {
    callsOk: cost.a2.callsPerFamily <= 6,
    callsPerFamily: cost.a2.callsPerFamily,
    unitCostOk:
      unitCost.a2.callsPerMatchedIssue !== null && unitCost.a1.callsPerMatchedIssue !== null
        ? unitCost.a2.callsPerMatchedIssue <= unitCost.a1.callsPerMatchedIssue
        : null,
    unitCost,
  },
  G5: { verdict: "MANUAL", note: "git diff 证明 gates.ts/qualityPolicyV2 零改动 + 回归测试全绿（报告收口节）" },
};

const out = {
  generatedAt: new Date().toISOString(),
  formalFamilies: formalFams,
  notEvaluated,
  typingSummary: {
    totalIssueFamilies: typed.length,
    byTaxonomy: typed.reduce((acc, t) => { const k = t.taxonomy ?? "untyped"; acc[k] = (acc[k] ?? 0) + 1; return acc; }, {}),
    targetTaxonomies: TARGET_TAXONOMIES,
    targetTotal,
    famsWithTarget,
    seriousCount: typed.filter((t) => t.serious === true).length,
  },
  coverage: metrics.arms,
  pairedDiffs: diffs,
  ablation,
  cost,
  unitCost,
  gates,
};
await writeFile(join(ROOT, "phase-e", "paired-metrics.json"), JSON.stringify(out, null, 1), "utf8");

// ---- 摘要打印 ----
const pct = (v) => (v === null || v === undefined ? "n/a" : `${(v * 100).toFixed(1)}%`);
const pp = (v) => (v === null || v === undefined ? "n/a" : `${v >= 0 ? "+" : ""}${(v * 100).toFixed(1)}pp`);
console.log("=== M15.14 聚合摘要 ===");
console.log(`TARGET 问题族: ${targetTotal}（${famsWithTarget}/${formalFams.length} 族非零） serious=${out.typingSummary.seriousCount}`);
for (const arm of ["a0", "a1", "a2"]) {
  const m = metrics.arms[arm];
  console.log(`${arm}: TARGET宽松 ${pct(m.targetLoose.familyMean)} 严格 ${pct(m.targetStrict.familyMean)} | 全部宽松 ${pct(m.allLoose.familyMean)} | serious ${pct(m.seriousLoose.familyMean)} | findings ${m.findingsTotal} | grounded ${pct(m.groundedRatio)} | ${cost[arm].callsPerFamily.toFixed(1)} 调用/族 $${cost[arm].estimatedCost.toFixed(2)}`);
}
for (const [k, d] of Object.entries(diffs)) {
  if (d.meanDiff === null || d.meanDiff === undefined) continue;
  const ci = d.ci95 ? ` CI95[${(d.ci95.lo * 100).toFixed(1)},${(d.ci95.hi * 100).toFixed(1)}]` : "";
  console.log(`${k}: ${pp(d.meanDiff)}${ci} (n=${d.n})`);
}
if (ablation.diff) console.log(`消融 a2−a2np: ${pp(ablation.diff.meanDiff)} (n=${ablation.diff.n} 族)`);
console.log(`G1a(严格): ${gates.G1a.verdict} | G1b(宽松): ${gates.G1b.verdict} | G2(消融): ${gates.G2.verdict} | G4(成本): calls=${gates.G4.callsOk} unit=${gates.G4.unitCostOk} | UNDERPOWERED=${underpowered}`);
console.log(`写入 ${join(ROOT, "phase-e", "paired-metrics.json")}`);
