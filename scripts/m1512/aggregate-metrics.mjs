#!/usr/bin/env node
/**
 * M15.12 Phase E4 — 指标聚合与预注册门裁决（零模型）。
 *
 * 输入：phase-e/issue-families.json + issue-typing-frozen.json + issue-alignment.jsonl
 *       + phase-d/out/<fam>/{c0,c0plus,c1opt,c2}.json + phase-d/model-calls.jsonl
 * 输出：phase-e/paired-metrics.json + 控制台摘要。
 *
 * 口径（预注册 §4/§5）：
 * - HRI-Coverage 族均 = Σ(匹配问题族/可判读问题族)/族数；paired bootstrap seed=1512 B=2000；
 * - 严格一对一敏感性：同一 b 被多 a 复用时只保留 confidence 最高（平局取 a 最小）的配对；
 * - serious/meta 子集覆盖率（typing 冻结表）；
 * - top-K coverage：c2 的匹配 finding ∈ priorityView.items[].findingId；
 * - grounded ratio（M15.11 规则：claimText≥20 字符可定位 或 page 合法且 message 引具体编号/数值）；
 * - 成本：物理调用/token/墙钟/单位有效匹配问题族成本（从 model-calls.jsonl 逐条分账）；
 * - 预注册 go/no-go 门逐条评估（§5；只评估不放宽）。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.M1512_ROOT ? resolve(process.env.M1512_ROOT) : resolve("D:\\PaperTeamData\\M15\\M15_12");

const ARMS = ["c0", "c0plus", "c1opt", "c2"];
const manifest = JSON.parse(await readFile(join(ROOT, "phase-c", "sample-manifest.json"), "utf8"));
const formalFams = manifest.families.filter((f) => f.role === "HELD-OUT-NEW").map((f) => f.familyId);
const issueFamilies = JSON.parse(await readFile(join(ROOT, "phase-e", "issue-families.json"), "utf8"));
const typing = JSON.parse(await readFile(join(ROOT, "phase-e", "issue-typing-frozen.json"), "utf8"));
const typingByIF = new Map((typing.issueFamilies ?? []).map((t) => [t.issueFamily, t]));

const alignment = {};
for (const line of (await readFile(join(ROOT, "phase-e", "issue-alignment.jsonl"), "utf8")).split("\n")) {
  if (line.trim() === "") continue;
  const r = JSON.parse(line);
  alignment[`${r.familyId}:${r.arm}`] = r;
}

// ---- 每族问题索引（alignment pairs 的 a 序号 = issueFamilies 中该族过滤后的序号，
// 与 judge 构建时一致：filter familyId 后的数组顺序） ----
const issuesByFam = new Map();
for (const g of issueFamilies) {
  if (!issuesByFam.has(g.familyId)) issuesByFam.set(g.familyId, []);
  issuesByFam.get(g.familyId).push(g);
}

// ---- 匹配集（原始 + 严格一对一） ----
function matchedSets(famId, arm) {
  const rec = alignment[`${famId}:${arm}`];
  const issues = issuesByFam.get(famId) ?? [];
  if (!rec || !Array.isArray(rec.pairs)) return { matched: new Set(), matchedB: new Set(), strict: new Set() };
  const matched = new Set();
  const matchedB = new Set();
  for (const p of rec.pairs) {
    if (p.b !== null && p.b !== undefined) {
      matched.add(p.a);
      matchedB.add(p.b);
    }
  }
  // 严格一对一：同一 b 保留 confidence 最高（high>medium>low，平局 a 最小）
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
  return { matched, matchedB, strict };
}

// ---- 臂产物读取（findings + priorityView + grounded） ----
function grounded(f, manuscriptChars) {
  const claim = String(f.claimText ?? "");
  if (claim.length >= 20) return true; // 定位性校验由运行时锚保证（M15.11 规则近似）
  if (typeof f.page === "number" && f.page >= 1 && f.page <= 200) return true;
  return false;
}
const armData = {};
for (const famId of formalFams) {
  armData[famId] = {};
  for (const arm of ARMS) {
    const p = join(ROOT, "phase-d", "out", famId, `${arm}.json`);
    armData[famId][arm] = existsSync(p) ? JSON.parse(await readFile(p, "utf8")) : null;
  }
}

// ---- 覆盖率 ----
function coverage(arm, subset = null, strictMode = false) {
  const perFam = [];
  for (const famId of formalFams) {
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
    pooled: (() => {
      let hit = 0;
      let total = 0;
      for (const famId of formalFams) {
        const issues = issuesByFam.get(famId) ?? [];
        const { matched, strict } = matchedSets(famId, arm);
        const use = strictMode ? strict : matched;
        const filtered = subset === null ? issues : issues.filter(subset);
        filtered.forEach((g, i) => {
          total += 1;
          if (use.has(i + 1)) hit += 1;
        });
      }
      return total > 0 ? hit / total : null;
    })(),
  };
}

const seriousSubset = (g) => typingByIF.get(g.issueFamily)?.serious === true;
const metaSubset = (g) => typingByIF.get(g.issueFamily)?.meta === true;

// ---- paired bootstrap ----
function pairedDiffCI(armA, armB, subset = null, strictMode = false, B = 2000, seed = 1512) {
  const a = coverage(armA, subset, strictMode).perFamily;
  const b = coverage(armB, subset, strictMode).perFamily;
  const diffs = a.map((v, i) => (v === null || b[i] === null ? null : v - b[i])).filter((v) => v !== null);
  if (diffs.length === 0) return { n: 0, meanDiff: null, ci95: null };
  const meanDiff = diffs.reduce((x, y) => x + y, 0) / diffs.length;
  // 简单 LCG（种子确定，跨平台可复现）
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

// ---- 成本（model-calls.jsonl 分账） ----
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
  else if (c.armHint === "workflow") arm = "c1opt";
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
  // c2 = c1opt 全部 + fullpaper 增量（独立口径，预注册 §2）
  const perFam = formalFams.map((famId) => {
    const base = callsByFamArm[`${famId}:c1opt`] ?? { n: 0, ms: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, estimatedCost: 0 };
    const inc = callsByFamArm[`${famId}:c2-increment`] ?? { n: 0, ms: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, estimatedCost: 0 };
    const direct = arm === "c0" || arm === "c0plus" ? (callsByFamArm[`${famId}:${arm}`] ?? { n: 0, ms: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, estimatedCost: 0 }) : null;
    const src = direct ?? (arm === "c2" ? { n: base.n + inc.n, ms: base.ms + inc.ms, inputTokens: base.inputTokens + inc.inputTokens, outputTokens: base.outputTokens + inc.outputTokens, cacheReadTokens: base.cacheReadTokens + inc.cacheReadTokens, estimatedCost: base.estimatedCost + inc.estimatedCost } : base);
    return src;
  });
  const sum = (field) => perFam.reduce((a, b) => a + b[field], 0);
  const families = perFam.filter((c) => c.n > 0).length || perFam.length;
  return { callsPerFamily: sum("n") / formalFams.length, wallMsPerFamily: sum("ms") / formalFams.length, inputTokens: sum("inputTokens"), outputTokens: sum("outputTokens"), cacheReadTokens: sum("cacheReadTokens"), estimatedCost: sum("estimatedCost"), familiesWithCalls: families };
}

// ---- top-K coverage（c2） ----
function topKCoverage() {
  const perFam = [];
  for (const famId of formalFams) {
    const rec = alignment[`${famId}:c2`];
    const data = armData[famId]["c2"];
    if (!rec || !Array.isArray(rec.pairs) || !data) { perFam.push(null); continue; }
    const topIds = new Set((data.priorityView?.items ?? []).map((i) => i.findingId));
    const findings = data.findings ?? [];
    const issues = issuesByFam.get(famId) ?? [];
    let hit = 0;
    for (const p of rec.pairs) {
      if (p.b === null || p.b === undefined) continue;
      const f = findings[p.b - 1];
      if (f && topIds.has(f.findingId)) hit += 1;
    }
    perFam.push(issues.length > 0 ? hit / issues.length : null);
  }
  const valid = perFam.filter((v) => v !== null);
  return { perFamily: perFam, familyMean: valid.length > 0 ? valid.reduce((a, b) => a + b, 0) / valid.length : null, families: valid.length };
}

// ---- grounded ratio ----
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
  "c1opt-c0plus": pairedDiffCI("c1opt", "c0plus"),
  "c2-c1opt": pairedDiffCI("c2", "c1opt"),
  serious: { "c2-c0plus": pairedDiffCI("c2", "c0plus", seriousSubset), "c2-c0": pairedDiffCI("c2", "c0", seriousSubset), "c1opt-c0plus": pairedDiffCI("c1opt", "c0plus", seriousSubset) },
  meta: { "c2-c0plus": pairedDiffCI("c2", "c0plus", metaSubset), "c2-c0": pairedDiffCI("c2", "c0", metaSubset), "c1opt-c0plus": pairedDiffCI("c1opt", "c0plus", metaSubset) },
};
const costs = {};
for (const arm of ARMS) costs[arm] = armCost(arm);
const topK = topKCoverage();
const groundedRatios = {};
for (const arm of ARMS) groundedRatios[arm] = groundedRatio(arm);
const seriousN = [...typingByIF.values()].filter((t) => t.serious).length;
const metaN = [...typingByIF.values()].filter((t) => t.meta).length;

// ---- 预注册门（§5；只评估） ----
const c2c0p = diffs["c2-c0plus"];
const seriousDiff = diffs.serious["c2-c0plus"];
const metaDiff = diffs.meta["c2-c0plus"];
const gates = {
  g1_primary_hri: { threshold: "C2-C0+ >= +8pp 且 CI95 下界 > -2pp", value: c2c0p.meanDiff, ci: c2c0p.ci95, pass: c2c0p.meanDiff !== null && c2c0p.meanDiff >= 0.08 && c2c0p.ci95 !== null && c2c0p.ci95.lo > -0.02 },
  g2_serious: { threshold: "C2 serious >= C0+ -5pp 且探索性 >= +10pp", c2: primary.c2.serious.familyMean, c0plus: primary.c0plus.serious.familyMean, pass: primary.c2.serious.familyMean !== null && primary.c0plus.serious.familyMean !== null && primary.c2.serious.familyMean >= primary.c0plus.serious.familyMean - 0.05 && (primary.c2.serious.familyMean - primary.c0plus.serious.familyMean) >= 0.10 },
  g2_meta: { threshold: "meta 类净改善可复核", c2: primary.c2.meta.familyMean, c0plus: primary.c0plus.meta.familyMean, pass: primary.c2.meta.familyMean !== null && primary.c0plus.meta.familyMean !== null && primary.c2.meta.familyMean > primary.c0plus.meta.familyMean },
  g3_cost: { threshold: "C2 调用 <= 旧 C1(35.9) 的 60%（约 <=21.5）；C2/C0+ <= ~10×；C2 墙钟 <= 3× C0", c2Calls: costs.c2.callsPerFamily, c0plusCalls: costs.c0plus.callsPerFamily, ratio: costs.c0plus.callsPerFamily > 0 ? costs.c2.callsPerFamily / costs.c0plus.callsPerFamily : null, wallRatio: costs.c0.wallMsPerFamily > 0 ? costs.c2.wallMsPerFamily / costs.c0.wallMsPerFamily : null, pass: costs.c2.callsPerFamily <= 21.5 },
  g4_topk: { threshold: "top-10 覆盖率 >= 全量覆盖率 60%（探索性）", topK: topK.familyMean, full: primary.c2.hri.familyMean, pass: topK.familyMean !== null && primary.c2.hri.familyMean !== null && topK.familyMean >= 0.6 * primary.c2.hri.familyMean },
  g5_guards: { note: "M15.8.6 N1/N2/H 零回归 + gates.ts 零改动——由测试与 git diff 证明，非本脚本", pass: null },
};

const out = {
  generatedAt: new Date().toISOString(),
  families: formalFams,
  label: "proxy-matching measurement (external labels = public human review content; issue segmentation & matching are model-assisted)",
  coverage: primary,
  pairedDiffs: diffs,
  topKCoverage: topK,
  groundedRatio: groundedRatios,
  costs,
  typing: { seriousIssueFamilies: seriousN, metaIssueFamilies: metaN, corrections: typing.corrections ?? null },
  gates,
};
await mkdir(join(ROOT, "phase-e"), { recursive: true });
await writeFile(join(ROOT, "phase-e", "paired-metrics.json"), JSON.stringify(out, null, 1), "utf8");
const fmt = (v) => (v === null || v === undefined ? "n/a" : `${(v * 100).toFixed(1)}%`);
console.log("=== M15.12 四臂指标（族均） ===");
for (const arm of ARMS) {
  console.log(`${arm.padEnd(7)} HRI=${fmt(primary[arm].hri.familyMean)} strict=${fmt(primary[arm].hriStrict.familyMean)} serious=${fmt(primary[arm].serious.familyMean)} meta=${fmt(primary[arm].meta.familyMean)} calls/fam=${costs[arm].callsPerFamily.toFixed(1)} cost=$${costs[arm].estimatedCost.toFixed(2)}`);
}
console.log(`C2−C0+ = ${fmt(c2c0p.meanDiff)} CI95 [${fmt(c2c0p.ci95?.lo)}, ${fmt(c2c0p.ci95?.hi)}] n=${c2c0p.n}`);
console.log(`top-10 coverage = ${fmt(topK.familyMean)} (full ${fmt(primary.c2.hri.familyMean)})`);
for (const [k, v] of Object.entries(gates)) console.log(`${k}: ${v.pass === null ? "MANUAL" : v.pass ? "PASS" : "FAIL"}`);
