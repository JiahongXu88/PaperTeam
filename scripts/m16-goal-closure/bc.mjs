#!/usr/bin/env node
/**
 * M16 原始目标收口 · B / C：新留出集上的尺子复验（B）与 单次全文 vs 生产 Reviewer 公平对照（C）。PROTOCOL 冻结后各步只跑一轮。
 *
 *   node scripts/m16-goal-closure/bc.mjs generate     # S 臂：每篇 1 次单次全文审稿（M16 SYSTEM_A 逐字，英文输出）
 *   node scripts/m16-goal-closure/bc.mjs judge1       # B：S / MISMATCHED / G0 / ATTACK / PSEUDO 五臂混合匿名，每篇 1 次裁判
 *   node scripts/m16-goal-closure/bc.mjs score-b      # 零模型：B 门（G1–G4）
 *   node scripts/m16-goal-closure/bc.mjs judge2       # C：S + P（生产全部 findings）混合匿名，每篇 1 次裁判
 *   node scripts/m16-goal-closure/bc.mjs score-c      # 零模型：召回 / 定位 / 严重度 / 成本 / 裁判重测一致性 + C 判定
 *   node scripts/m16-goal-closure/bc.mjs verify-pool  # 零模型：导出盲化核验池（未对齐、可定位条目，每篇每臂 ≤ 3）
 *   node scripts/m16-goal-closure/bc.mjs verify-score # 零模型：按核验规格做确定性检查并汇总 credible findings
 *
 * 冻结复用：JUDGE_SYSTEM（m16-closure/judge-prompt.mjs，逐字节）、具体性分层与术语门（m16-closure/specificity.mjs）、
 * GENERIC_CONTROL（m16-review-validity/lib.mjs）、SYSTEM_A（与 m16-closure/b-benchmark.mjs 逐字相同）。
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { GENERIC_CONTROL, bootstrapCi, humanWeaknesses, parseJsonObject } from "../m16-review-validity/lib.mjs";
import { JUDGE_SYSTEM } from "../m16-closure/judge-prompt.mjs";
import { DF_MAX, classifyOpinion, loadCorpus, tokenize, ANCHOR } from "../m16-closure/specificity.mjs";
import { COCO, MD_DIR, ROOT, callsUsed, createModel, readJson, sha } from "./lib.mjs";

const B = join(ROOT, "B");
const C = join(ROOT, "C");
mkdirSync(B, { recursive: true });
mkdirSync(C, { recursive: true });
export const MID = 0.1;
const corpus = loadCorpus(humanWeaknesses);
const recordById = new Map(corpus.records.map((r) => [r.id, r]));
const papers = existsSync(join(B, "heldout-selection.json")) ? readJson(join(B, "heldout-selection.json")).selected : [];
const mdOf = (id) => readFileSync(join(MD_DIR, recordById.get(id).MD_path.replace(/^benchmark\/MD\//, "")), "utf8");
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));
const labelsOf = (id) => humanWeaknesses(recordById.get(id)).map((o) => ({ ...o, ...classifyOpinion(o.text, id, mdOf(id), corpus) }));

const SYSTEM_A =
  "You are an expert reviewer for a top machine learning conference. Read the paper and list its main weaknesses as a reviewer would. " +
  "Output only one JSON object: {\"weaknesses\": [{\"category\": \"<CODE>\", \"point\": \"<one or two sentences>\"}]} with at most 10 items. " +
  "Use exactly one category code per item from the provided taxonomy.";

const genPath = join(C, "single-pass.json");
const gen = existsSync(genPath) ? readJson(genPath) : {};
const S = (id) => gen[id]?.parsed?.weaknesses?.slice(0, 10).map((w) => w.point) ?? null;

/** 本篇正文高频、且在其他论文人类意见中罕见的词（= 术语门所查词表；ATTACK / PSEUDO 共用） */
function rareTerms(id, md, k = 6) {
  const own = corpus.termsByPaper.get(id) ?? new Set();
  const tf = new Map();
  for (const t of tokenize(md.replace(/\$\$[\s\S]*?\$\$|\$[^$]*\$|\\[A-Za-z]+|<[^>]+>|!\[[^\]]*\]\([^)]*\)/g, " "))) if (t.length >= 4 && !/^\d/.test(t)) tf.set(t, (tf.get(t) ?? 0) + 1);
  return [...tf.entries()]
    .filter(([t]) => ((corpus.df.get(t) ?? 0) - (own.has(t) ? 1 : 0)) / (corpus.n - 1) <= DF_MAX)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, k)
    .map(([t]) => t);
}

/** ATTACK：与 m16-closure 同构的零模型关键词填充模板 */
function attackItems(id, md) {
  const terms = rareTerms(id, md);
  const [t1, t2, t3, t4, t5, t6] = [...terms, ...Array(6).fill(terms[0] ?? "the method")];
  return [
    `The experimental evaluation of ${t1} is limited; it should include more datasets and stronger baselines than ${t2}.`,
    `The novelty of ${t1} relative to prior work on ${t3} is limited.`,
    `The description of ${t2} is unclear and the writing around ${t4} could be improved.`,
    `The paper lacks ablation studies justifying the design of ${t1} and ${t5}.`,
    `Implementation details and hyperparameters of ${t1} (e.g., ${t6}) are insufficient for reproducibility.`,
    `The theoretical analysis of ${t3} lacks rigorous justification.`,
    `The computational cost and scalability of ${t1} on ${t2} are not discussed.`,
    `The statistical significance of the reported improvements on ${t4} is not established.`,
    `The related work discussion of ${t3} misses relevant recent methods.`,
    `The limitations of ${t1} for ${t5} are not adequately discussed.`,
  ];
}

/**
 * PSEUDO（新增，PROTOCOL §3）：伪具体意见——取错配论文的真实审稿条目（具体、流畅、但关切属于另一篇），把其中该论文的
 * 罕见词按名次替换为本篇的罕见词；一条也没替换上时在句末补本篇两个罕见词。它能通过术语门、读起来像本篇的具体批评，
 * 但关切本身与本篇无关——检验裁判与术语门是否会被「换了名词的具体意见」骗过。
 */
function pseudoItems(id, md, mismatchId) {
  const mine = rareTerms(id, md);
  const theirs = rareTerms(mismatchId, mdOf(mismatchId));
  return (S(mismatchId) ?? []).map((text) => {
    let out = text;
    let replaced = 0;
    theirs.forEach((term, index) => {
      const target = mine[index] ?? mine[0];
      if (target === undefined) return;
      const pattern = new RegExp(`\\b${term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`, "gi");
      if (pattern.test(out)) { out = out.replace(pattern, target); replaced += 1; }
    });
    return replaced > 0 || mine.length < 2 ? out : `${out.replace(/\.\s*$/, "")} (as seen for ${mine[0]} and ${mine[1]}).`;
  });
}

const order = [...papers].sort((a, b) => sha(`m16-goal-closure-mismatch|${a.id}`).localeCompare(sha(`m16-goal-closure-mismatch|${b.id}`)));
const mismatchOf = (id) => order[(order.findIndex((p) => p.id === id) + 1) % order.length].id;

const SEVERITY_RANK = { critical: 0, blocking: 0, major: 1, minor: 2, info: 3 };
const runDir = (id) => join(C, "production", `${id}__live__fidelity`);
function productionFindings(id) {
  const path = join(runDir(id), "artifacts", "review-summary-r1.json");
  if (!existsSync(path)) return null;
  return readJson(path).issues
    .map((issue, index) => ({ index, severity: issue.severity, category: issue.category, text: issue.description, quote: issue.quote ?? null, verification: issue.verification ?? null, section: issue.section ?? null }))
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 4) - (SEVERITY_RANK[b.severity] ?? 4) || a.index - b.index);
}

async function judgeOnce(model, tag, id, armsMap, maxTokens) {
  const record = recordById.get(id);
  const md = mdOf(id);
  const human = humanWeaknesses(record);
  const pool = Object.entries(armsMap).flatMap(([arm, items]) => items.map((text, i) => ({ arm, rank: i + 1, text })));
  pool.sort((x, y) => sha(`${id}|${x.arm}|${x.rank}|${tag}-blind`).localeCompare(sha(`${id}|${y.arm}|${y.rank}|${tag}-blind`)));
  const items = pool.map((it, i) => ({ id: `I${i + 1}`, ...it }));
  const user = `Paper title and opening text (context only):\n${clip(record.title ?? md.split("\n")[0], 300)}\n${clip(md.replace(/^#[^\n]*\n/, "").trim(), 1800)}\n\nReference criticisms (human reviewers):\n${human.map((o, i) => `H${i + 1}: ${clip(o.text, 600)}`).join("\n")}\n\nAI review items (shuffled, anonymous):\n${items.map((it) => `${it.id}: ${clip(it.text, 450)}`).join("\n")}`;
  const attempts = [];
  let matches = null;
  for (let attempt = 0; attempt < 2 && matches === null; attempt += 1) {
    try {
      const { text, usage, durationMs } = await model.complete(`${tag} ${id} try${attempt}`, JUDGE_SYSTEM, user, maxTokens);
      attempts.push({ usage, durationMs, raw: text });
      const obj = parseJsonObject(text);
      if (typeof obj.matches !== "object" || obj.matches === null) throw new Error("matches 缺失");
      matches = obj.matches;
    } catch (error) {
      attempts.push({ error: String(error).slice(0, 200) });
      if (String(error).includes("[budget]")) break;
    }
  }
  return { inputSha256: sha(JUDGE_SYSTEM + user), humanCount: human.length, items: items.map(({ id: itemId, arm, rank }) => ({ id: itemId, arm, rank })), attempts, matches };
}

/** 一臂在某次裁判中的命中：judge = 裁判判匹配的人类意见；hybrid = 其中 SPECIFIC 且与条目共享 ≥ 1 个论文专属词 */
function armHits(j, labels, arm, texts, maxRank = Infinity) {
  const judge = new Set();
  const hybrid = new Set();
  const itemHybrid = new Map();
  let matchedItems = 0;
  const items = j.items.filter((x) => x.arm === arm && x.rank <= maxRank);
  for (const it of items) {
    const hs = (j.matches[it.id] ?? []).map((h) => Number(String(h).replace(/\D/g, "")) - 1).filter((k) => k >= 0 && k < labels.length);
    if (hs.length > 0) matchedItems += 1;
    const toks = new Set(tokenize(texts[it.rank - 1]));
    const hyb = [];
    for (const k of hs) {
      judge.add(k);
      if (labels[k].label === "SPECIFIC" && labels[k].terms.some((t) => toks.has(t))) { hybrid.add(k); hyb.push(k); }
    }
    itemHybrid.set(it.rank, hyb);
  }
  const spec = labels.map((l, k) => (l.label === "SPECIFIC" ? k : -1)).filter((k) => k >= 0);
  return {
    items: items.length,
    hybridSpec: hybrid.size / spec.length,
    judgeSpec: [...judge].filter((k) => labels[k].label === "SPECIFIC").length / spec.length,
    judgeAll: judge.size / labels.length,
    matchedItemRate: items.length ? matchedItems / items.length : null,
    judgeSet: [...judge],
    hybridSet: [...hybrid],
    itemHybrid: Object.fromEntries(itemHybrid),
  };
}

const f = (c) => (c.mean === null ? "n/a" : `${(c.mean * 100).toFixed(1)} [${(c.low * 100).toFixed(1)}, ${(c.high * 100).toFixed(1)}]`);
const verdictOf = (c) => (c.mean >= MID && c.low > 0 ? "PASS" : c.mean >= MID ? "UNDERPOWERED" : "FAIL");

// ---- 确定性可定位性（C 次要指标；PROTOCOL §7）----
const LOCATOR = /\b(Table|Tab\.|Figure|Fig\.|Eq(?:uation)?\.?|Eqn\.?|Section|Sec\.|Theorem|Thm\.|Lemma|Proposition|Algorithm|Alg\.|Appendix)\s*\(?\s*([A-Z]?\d+(?:\.\d+)*)/gi;
const KIND = (raw) => /^tab/i.test(raw) ? "table" : /^fig/i.test(raw) ? "figure" : /^eq/i.test(raw) ? "equation" : /^sec/i.test(raw) ? "section" : /^(thm|theorem)/i.test(raw) ? "theorem" : /^lemma/i.test(raw) ? "lemma" : /^prop/i.test(raw) ? "proposition" : /^alg/i.test(raw) ? "algorithm" : "appendix";
const norm = (v) => String(v).normalize("NFKC").toLowerCase().replace(/[\s*_`#>|\\{}$]+/g, "");
function locatorExists(kind, num, md) {
  const n = num.replace(/\./g, "\\.");
  const patterns = {
    table: [`\\btable\\s*${n}\\b`, `\\btab\\.\\s*${n}\\b`], figure: [`\\bfig(?:ure|\\.)\\s*${n}\\b`],
    equation: [`\\(${n}\\)`, `\\\\tag\\{${n}\\}`, `\\beq(?:uation|n|\\.)?\\s*\\(?${n}\\)?`], section: [`(^|\\n)#+\\s*${n}\\b`, `\\bsection\\s*${n}\\b`, `(^|\\n)${n}\\s+[A-Z]`],
    theorem: [`\\btheorem\\s*${n}\\b`], lemma: [`\\blemma\\s*${n}\\b`], proposition: [`\\bproposition\\s*${n}\\b`], algorithm: [`\\balgorithm\\s*${n}\\b`], appendix: [`\\bappendix\\s*${n}\\b`, `(^|\\n)#+\\s*${n}\\b`],
  }[kind];
  return patterns.some((p) => new RegExp(p, "i").test(md));
}
/** LOCATED = 引用的定位全都存在，或引文（≥ 12 字符）逐字可在原文找到；DANGLING = 引用了原文没有的定位 / 引文；否则 UNANCHORED */
export function locatability(text, quote, md) {
  const locs = [...String(text).matchAll(LOCATOR)].map((m) => ({ kind: KIND(m[1]), num: m[2] }));
  const missing = locs.filter((l) => !locatorExists(l.kind, l.num, md));
  const quoteStatus = quote === null || quote === undefined || norm(quote).length < 12 ? null : norm(md).includes(norm(quote)) ? "found" : "not_found";
  if (missing.length > 0 || quoteStatus === "not_found") return { status: "DANGLING", missing, quoteStatus };
  if (locs.length > 0 || quoteStatus === "found") return { status: "LOCATED", locators: locs.length, quoteStatus };
  return { status: "UNANCHORED", quoteStatus };
}

const mode = process.argv[2];

if (mode === "generate") {
  const taxonomy = readJson(join(COCO, "taxonomy.json")).map((t) => `${t.code}: ${t.gloss}`).join("\n");
  const model = await createModel();
  for (const p of papers) {
    if (gen[p.id]?.parsed) continue;
    const md = mdOf(p.id);
    const user = `Category taxonomy:\n${taxonomy}\n\nPaper (markdown, full text, ${md.length} characters):\n\n${md}`;
    const attempts = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const { text, usage, durationMs } = await model.complete(`S generate ${p.id} try${attempt}`, SYSTEM_A, user, 4000);
        attempts.push({ usage, durationMs, raw: text });
        const parsed = parseJsonObject(text);
        if (!Array.isArray(parsed.weaknesses)) throw new Error("weaknesses 缺失");
        gen[p.id] = { inputSha256: sha(SYSTEM_A + user), attempts, parsed };
        break;
      } catch (error) {
        attempts.push({ error: String(error).slice(0, 200) });
        gen[p.id] = { attempts, parsed: null };
        if (String(error).includes("[budget]")) break;
      }
    }
    writeFileSync(genPath, `${JSON.stringify(gen, null, 1)}\n`);
    console.log(`[generate] ${p.id} ${gen[p.id].parsed ? `items=${gen[p.id].parsed.weaknesses.length}` : "FAILED"} calls=${callsUsed()}`);
  }
} else if (mode === "judge1" || mode === "judge2") {
  const path = join(mode === "judge1" ? B : C, `${mode}.json`);
  const judged = existsSync(path) ? readJson(path) : {};
  const model = await createModel();
  for (const p of papers) {
    if (judged[p.id]?.matches) continue;
    const md = mdOf(p.id);
    let armsMap;
    if (mode === "judge1") {
      armsMap = { S: S(p.id), MISMATCHED: S(mismatchOf(p.id)), G0: GENERIC_CONTROL.slice(0, 10), ATTACK: attackItems(p.id, md), PSEUDO: pseudoItems(p.id, md, mismatchOf(p.id)) };
    } else {
      const prod = productionFindings(p.id);
      armsMap = { S: S(p.id), P: prod === null ? null : prod.map((x) => x.text) };
    }
    if (Object.values(armsMap).some((v) => v === null)) { console.log(`[${mode}] ${p.id} 缺臂输出，跳过`); continue; }
    judged[p.id] = await judgeOnce(model, mode, p.id, armsMap, mode === "judge1" ? 6000 : 8000);
    judged[p.id].armTexts = armsMap;
    writeFileSync(path, `${JSON.stringify(judged, null, 1)}\n`);
    console.log(`[${mode}] ${p.id} items=${judged[p.id].items.length} ${judged[p.id].matches ? "ok" : "FAILED"} calls=${callsUsed()}`);
  }
} else if (mode === "score-b") {
  const judged = readJson(join(B, "judge1.json"));
  const ARMS = ["S", "MISMATCHED", "G0", "ATTACK", "PSEUDO"];
  const per = [];
  for (const p of papers) {
    const j = judged[p.id];
    if (!j?.matches) continue;
    const labels = labelsOf(p.id);
    const row = { id: p.id, stratum: p.stratum, human: labels.length, specific: labels.filter((l) => l.label === "SPECIFIC").length, arms: {} };
    for (const arm of ARMS) {
      const h = armHits(j, labels, arm, j.armTexts[arm], 10);
      row.arms[arm] = { hybridSpec: h.hybridSpec, judgeSpec: h.judgeSpec, judgeAll: h.judgeAll, matchedItemRate: h.matchedItemRate };
    }
    per.push(row);
  }
  const metrics = ["hybridSpec", "judgeSpec", "judgeAll", "matchedItemRate"];
  const summary = Object.fromEntries(ARMS.map((arm) => [arm, Object.fromEntries(metrics.map((m) => [m, bootstrapCi(per.map((r) => r.arms[arm][m]).filter((v) => v !== null))]))]));
  const contrast = (arm, base, m) => bootstrapCi(per.map((r) => r.arms[arm][m] - r.arms[base][m]));
  const gate = {
    G1_hybrid_S_vs_mismatched: contrast("S", "MISMATCHED", "hybridSpec"),
    G2_hybrid_S_vs_attack: contrast("S", "ATTACK", "hybridSpec"),
    G3_judgeOnly_S_vs_generic: contrast("S", "G0", "judgeSpec"),
    G4_hybrid_S_vs_pseudo: contrast("S", "PSEUDO", "hybridSpec"),
  };
  for (const g of Object.values(gate)) g.verdict = verdictOf(g);
  const diagnostics = {
    judgeOnly_S_vs_pseudo: contrast("S", "PSEUDO", "judgeSpec"),
    judgeOnly_S_vs_attack: contrast("S", "ATTACK", "judgeSpec"),
    judgeOnly_S_vs_mismatched: contrast("S", "MISMATCHED", "judgeSpec"),
    matchedItems_S_vs_pseudo: contrast("S", "PSEUDO", "matchedItemRate"),
  };
  const failedJudges = papers.length - per.length;
  const verdicts = Object.values(gate).map((g) => g.verdict);
  const benchmarkValidity = failedJudges > 0 ? "BLOCKED" : verdicts.every((v) => v === "PASS") ? "PASS" : verdicts.includes("FAIL") ? "NOT_DISCRIMINATIVE" : "UNDERPOWERED";
  writeFileSync(join(B, "score-b.json"), `${JSON.stringify({ schema: "m16-goal-closure-b/v1", generatedAt: new Date().toISOString(), nPapers: per.length, failedJudges, MID, summary, gate, diagnostics, benchmarkValidity, per }, null, 1)}\n`);
  console.log(`n=${per.length} failedJudges=${failedJudges}`);
  for (const arm of ARMS) console.log(arm.padEnd(10), metrics.map((m) => `${m} ${f(summary[arm][m])}`).join(" | "));
  for (const [k, v] of Object.entries(gate)) console.log(k, f(v), v.verdict);
  for (const [k, v] of Object.entries(diagnostics)) console.log("diag", k, f(v));
  console.log("BENCHMARK_VALIDITY =", benchmarkValidity);
} else if (mode === "score-c") {
  const j2 = readJson(join(C, "judge2.json"));
  const j1 = readJson(join(B, "judge1.json"));
  const WHOLE = /^(QUAL-EXP|QUAL-CMP|QUAL-STA|SIGN-|ORIG-|POL-IMP)/;
  const per = [];
  for (const p of papers) {
    const j = j2[p.id];
    if (!j?.matches) continue;
    const labels = labelsOf(p.id);
    labels.forEach((l) => (l.granularity = l.anchor ? "LOCAL" : l.category.some((c) => WHOLE.test(c)) ? "WHOLE_PAPER" : "LOCAL"));
    const md = mdOf(p.id);
    const prod = productionFindings(p.id);
    const sTexts = j.armTexts.S;
    const pTexts = j.armTexts.P;
    const arms = { "S@10": armHits(j, labels, "S", sTexts, 10), "P@10": armHits(j, labels, "P", pTexts, 10), "P@all": armHits(j, labels, "P", pTexts) };
    const retest = armHits(j1[p.id], labels, "S", j1[p.id].armTexts.S, 10);
    const sLoc = sTexts.map((t) => locatability(t, null, md).status);
    const pLoc = prod.map((x) => locatability(x.text, x.quote, md).status);
    const rate = (arr, v) => (arr.length ? arr.filter((x) => x === v).length / arr.length : null);
    const sevCounts = Object.fromEntries(["critical", "major", "minor", "info"].map((s) => [s, prod.filter((x) => x.severity === s).length]));
    const alignedBySeverity = Object.fromEntries(["critical", "major", "minor", "info"].map((s) => [s, prod.filter((x, i) => x.severity === s && (arms["P@all"].itemHybrid[i + 1] ?? []).length > 0).length]));
    const run = readJson(join(runDir(p.id), "run-result.json"));
    const KEYS = { input: ["input", "inputTokens"], output: ["output", "outputTokens"], cacheRead: ["cacheRead", "cacheReadTokens"] };
    const sum = (arr, key) => arr.reduce((n, c) => n + (KEYS[key].map((k) => c.usage?.[k]).find((v) => typeof v === "number") ?? 0), 0);
    const sAttempts = gen[p.id].attempts.filter((a) => a.usage);
    const S_ = arms["S@10"].judgeSet;
    const P_ = new Set(arms["P@all"].judgeSet);
    per.push({
      id: p.id, stratum: p.stratum, human: labels.length, specific: labels.filter((l) => l.label === "SPECIFIC").length,
      arms: Object.fromEntries(Object.entries(arms).map(([k, h]) => [k, { items: h.items, hybridSpec: h.hybridSpec, judgeSpec: h.judgeSpec, judgeAll: h.judgeAll, matchedItemRate: h.matchedItemRate, hybridItems: Object.values(h.itemHybrid).filter((v) => v.length > 0).length }])),
      retest: { judge1_S_hybridSpec: retest.hybridSpec, judge2_S_hybridSpec: arms["S@10"].hybridSpec, judge1_S_judgeSpec: retest.judgeSpec, judge2_S_judgeSpec: arms["S@10"].judgeSpec },
      locatability: { S: { located: rate(sLoc, "LOCATED"), dangling: rate(sLoc, "DANGLING"), unanchored: rate(sLoc, "UNANCHORED") }, P: { located: rate(pLoc, "LOCATED"), dangling: rate(pLoc, "DANGLING"), unanchored: rate(pLoc, "UNANCHORED") } },
      severity: { counts: sevCounts, alignedBySeverity },
      missedByP_hitByS: S_.filter((k) => !P_.has(k)).map((k) => ({ h: k + 1, granularity: labels[k].granularity, label: labels[k].label })),
      hitByP_missedByS: [...P_].filter((k) => !S_.includes(k)).map((k) => ({ h: k + 1, granularity: labels[k].granularity, label: labels[k].label })),
      cost: {
        S: { calls: gen[p.id].attempts.length, input: sum(sAttempts, "input"), output: sum(sAttempts, "output"), ms: sAttempts.reduce((n, a) => n + a.durationMs, 0) },
        P: { calls: run.callCount, failed: run.failedCalls, input: sum(run.calls, "input"), output: sum(run.calls, "output"), cacheRead: sum(run.calls, "cacheRead"), ms: run.ms, findings: prod.length },
      },
    });
  }
  const ci = (fn) => bootstrapCi(per.map(fn));
  const contrasts = {
    primary_hybrid_Pall_minus_S10: ci((r) => r.arms["P@all"].hybridSpec - r.arms["S@10"].hybridSpec),
    hybrid_P10_minus_S10: ci((r) => r.arms["P@10"].hybridSpec - r.arms["S@10"].hybridSpec),
    judgeSpec_Pall_minus_S10: ci((r) => r.arms["P@all"].judgeSpec - r.arms["S@10"].judgeSpec),
    matchedItemRate_Pall_minus_S10: ci((r) => r.arms["P@all"].matchedItemRate - r.arms["S@10"].matchedItemRate),
    dangling_P_minus_S: ci((r) => r.locatability.P.dangling - r.locatability.S.dangling),
    located_P_minus_S: ci((r) => r.locatability.P.located - r.locatability.S.located),
  };
  const retestAbs = ci((r) => Math.abs(r.retest.judge1_S_hybridSpec - r.retest.judge2_S_hybridSpec));
  const arm = (k, m) => ci((r) => r.arms[k][m]);
  const summary = Object.fromEntries(["S@10", "P@10", "P@all"].map((k) => [k, { hybridSpec: arm(k, "hybridSpec"), judgeSpec: arm(k, "judgeSpec"), matchedItemRate: arm(k, "matchedItemRate"), items: arm(k, "items") }]));
  const totals = (key) => per.reduce((n, r) => n + r.cost.P[key], 0);
  const out = { schema: "m16-goal-closure-c/v1", generatedAt: new Date().toISOString(), nPapers: per.length, MID, summary, contrasts, retestAbsHybrid: retestAbs, productionTotals: { calls: totals("calls"), failed: totals("failed"), ms: totals("ms"), findings: totals("findings") }, per };
  writeFileSync(join(C, "score-c.json"), `${JSON.stringify(out, null, 1)}\n`);
  console.log(`n=${per.length}`);
  for (const [k, v] of Object.entries(summary)) console.log(k.padEnd(6), Object.entries(v).map(([m, c]) => `${m} ${m === "items" ? c.mean?.toFixed(1) : f(c)}`).join(" | "));
  for (const [k, v] of Object.entries(contrasts)) console.log(k, f(v));
  console.log("retest |judge1−judge2| S hybridSpec", f(retestAbs));
  console.log("production totals", JSON.stringify(out.productionTotals));
} else if (mode === "verify-pool") {
  // 盲化核验池：每篇每臂按名次（P 按严重度）取前 3 条「未与任何 SPECIFIC 意见混合匹配」且 LOCATED 的条目；混合乱序、去掉臂标签
  const j2 = readJson(join(C, "judge2.json"));
  const pool = [];
  for (const p of papers) {
    const j = j2[p.id];
    if (!j?.matches) continue;
    const labels = labelsOf(p.id);
    const md = mdOf(p.id);
    const prod = productionFindings(p.id);
    for (const [armName, texts, quotes] of [["S", j.armTexts.S, j.armTexts.S.map(() => null)], ["P", j.armTexts.P, prod.map((x) => x.quote)]]) {
      const h = armHits(j, labels, armName, texts);
      const chosen = [];
      texts.forEach((text, i) => {
        if (chosen.length >= 3) return;
        if ((h.itemHybrid[i + 1] ?? []).length > 0) return;
        const loc = locatability(text, quotes[i], md);
        if (loc.status !== "LOCATED") return;
        chosen.push({ paper: p.id, arm: armName, rank: i + 1, text, quote: quotes[i], severity: armName === "P" ? prod[i].severity : null });
      });
      pool.push(...chosen);
    }
  }
  pool.sort((a, b) => sha(`${a.paper}|${a.arm}|${a.rank}|verify`).localeCompare(sha(`${b.paper}|${b.arm}|${b.rank}|verify`)));
  const keyed = pool.map((it, i) => ({ vid: `V${String(i + 1).padStart(3, "0")}`, ...it }));
  writeFileSync(join(C, "verify-pool-key.json"), `${JSON.stringify(keyed, null, 1)}\n`);
  writeFileSync(join(C, "verify-pool-blind.json"), `${JSON.stringify(keyed.map(({ vid, paper, text, quote }) => ({ vid, paper, text, quote })), null, 1)}\n`);
  console.log(`verify pool: ${keyed.length} items（blind file 不含臂 / 名次 / 严重度）`);
} else if (mode === "verify-score") {
  const key = readJson(join(C, "verify-pool-key.json"));
  const specs = readJson(join(C, "verify-specs.json"));
  const results = [];
  for (const it of key) {
    const spec = specs[it.vid];
    const md = mdOf(it.paper);
    let verdict = "UNVERIFIED";
    let detail = spec?.note ?? "无确定性核验规格";
    if (spec !== undefined && spec.check !== undefined) {
      const present = (q) => norm(md).includes(norm(q));
      const c = spec.check;
      if (c.type === "quotes_contradict") {
        // 两段引文都逐字在原文，且各自数值不同（finding 声称二者应一致）
        // DEVIATIONS #6：值可为数值或字面量（如 a_t=0 vs a_t=t、方法全称），数值按数值比较、否则按字符串比较
        const ok = c.quotes.every(present);
        const differ = c.values.length === 2 && (c.values.every((v) => Number.isFinite(Number(v))) ? Number(c.values[0]) !== Number(c.values[1]) : String(c.values[0]) !== String(c.values[1]));
        verdict = ok && differ ? "INDEPENDENTLY_VERIFIED" : ok ? "REFUTED" : "NOT_EVALUATED";
        detail = `quotes ${ok ? "found" : "missing"}; values ${c.values.join(" vs ")}`;
      } else if (c.type === "absence") {
        // finding 声称论文缺少某要素：所有给定模式在全文均不出现 → 成立；任一出现 → 反证
        const hits = c.patterns.filter((p) => new RegExp(p, "i").test(md));
        verdict = hits.length === 0 ? "INDEPENDENTLY_VERIFIED" : "REFUTED";
        detail = hits.length === 0 ? `absent: ${c.patterns.join(" | ")}` : `present: ${hits.join(" | ")}`;
      } else if (c.type === "arithmetic") {
        // 引文逐字存在，且按引文中的数值复算与论文声称值不符（|diff| > tol）
        const ok = c.quotes.every(present);
        const computed = Function(`"use strict"; return (${c.expr});`)();
        const mismatch = Math.abs(computed - Number(c.claimed)) > Number(c.tol ?? 0);
        verdict = !ok ? "NOT_EVALUATED" : mismatch ? "INDEPENDENTLY_VERIFIED" : "REFUTED";
        detail = `computed ${computed} vs claimed ${c.claimed} (tol ${c.tol ?? 0}); quotes ${ok ? "found" : "missing"}`;
      } else if (c.type === "not_evaluated") {
        verdict = "NOT_EVALUATED";
      } else if (c.type === "quote_present_only") {
        // 前提引文存在但结论需领域判断：只记 UNVERIFIED（不升格）
        verdict = c.quotes.every(present) ? "UNVERIFIED" : "REFUTED";
        detail = spec.note ?? "";
      }
    }
    results.push({ ...it, verdict, detail, spec: spec ?? null });
  }
  const byArm = Object.fromEntries(["S", "P"].map((a) => [a, Object.fromEntries(["INDEPENDENTLY_VERIFIED", "REFUTED", "UNVERIFIED", "NOT_EVALUATED"].map((v) => [v, results.filter((r) => r.arm === a && r.verdict === v).length]))]));
  writeFileSync(join(C, "verify-results.json"), `${JSON.stringify({ generatedAt: new Date().toISOString(), byArm, results }, null, 1)}\n`);
  console.log(JSON.stringify(byArm));
} else {
  throw new Error("mode: generate | judge1 | score-b | judge2 | score-c | verify-pool | verify-score");
}
