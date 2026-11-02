#!/usr/bin/env node
/**
 * M16 收口 · B：区分力基准（CoCoReviewBench ICLR 2025；PROTOCOL 冻结后只跑一轮）。
 *
 *   node scripts/m16-closure/b-benchmark.mjs select            # 零模型：抽 held-out（下载 MD、校验 blob、只输出计数，不打印人类意见）
 *   node scripts/m16-closure/b-benchmark.mjs generate          # held-out：每篇 1 次单次全文审稿（M16 SYSTEM_A 逐字）
 *   node scripts/m16-closure/b-benchmark.mjs judge dev|heldout # 每篇 1 次盲评（四臂条目混合乱序、匿名）
 *   node scripts/m16-closure/b-benchmark.mjs score dev|heldout # 零模型：确定性评分 + 论文级 bootstrap + B 门判定
 *
 * 臂：CORRECT（本篇全文单次审稿）/ MISMATCHED（另一篇的 CORRECT，循环错位）/ G0（M16 冻结通用套话）/
 *     ATTACK（零模型关键词填充模板：通用批评句 + 本篇高频罕见词——测试「简单模式能否刷分」）。
 * 主指标 hybridSpec@10：前 10 条中，经裁判判为同一问题、且条目与该人类意见共享 ≥ 1 个论文专属词的 SPECIFIC 人类意见占比。
 * dev = M16 首轮封存集前 4 篇（已开封，DEV_OPENED，复用其 Afull 输出，零生成调用）。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { GENERIC_CONTROL, bootstrapCi, humanWeaknesses, parseJsonObject } from "../m16-review-validity/lib.mjs";
import { COCO, M15, M16, ROOT, callsUsed, createModel, readJson, sha } from "./lib.mjs";
import { JUDGE_SYSTEM } from "./judge-prompt.mjs";
import { DF_MAX, classifyOpinion, loadCorpus, tokenize } from "./specificity.mjs";

const B = join(ROOT, "B");
const MD_DIR = join(ROOT, "external", "cocoreviewbench-md");
mkdirSync(B, { recursive: true });
mkdirSync(MD_DIR, { recursive: true });
const corpus = loadCorpus(humanWeaknesses);
const recordById = new Map(corpus.records.map((r) => [r.id, r]));
const PER_STRATUM = 8;
const MIN_SPECIFIC = 3;
export const MID = 0.1;

// M16 c-single-pass.mjs SYSTEM_A 逐字（CORRECT 臂生成器；dev 复用其 Afull 输出）
const SYSTEM_A =
  "You are an expert reviewer for a top machine learning conference. Read the paper and list its main weaknesses as a reviewer would. " +
  "Output only one JSON object: {\"weaknesses\": [{\"category\": \"<CODE>\", \"point\": \"<one or two sentences>\"}]} with at most 10 items. " +
  "Use exactly one category code per item from the provided taxonomy.";

const mdPathOf = (record) => join(MD_DIR, record.MD_path.replace(/^benchmark\/MD\//, ""));
const localMd = (record) => {
  for (const p of [mdPathOf(record), join(M16, "external", "cocoreviewbench-md", record.MD_path.replace(/^benchmark\/MD\//, "")), join(COCO, "MD", record.MD_path.replace(/^benchmark\/MD\//, ""))]) if (existsSync(p)) return readFileSync(p, "utf8");
  return null;
};
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));

function labelsFor(record, md) {
  return humanWeaknesses(record).map((o) => ({ ...o, ...classifyOpinion(o.text, record.id, md, corpus) }));
}

/** ATTACK：零模型关键词填充（本篇正文高频、且在其他论文人类意见里罕见的词——正是术语门所检查的词表） */
export function attackItems(paperId, md) {
  const own = corpus.termsByPaper.get(paperId) ?? new Set();
  const tf = new Map();
  for (const t of tokenize(md.replace(/\$\$[\s\S]*?\$\$|\$[^$]*\$|\\[A-Za-z]+|<[^>]+>|!\[[^\]]*\]\([^)]*\)/g, " "))) if (t.length >= 4 && !/^\d/.test(t)) tf.set(t, (tf.get(t) ?? 0) + 1);
  const terms = [...tf.entries()]
    .filter(([t]) => ((corpus.df.get(t) ?? 0) - (own.has(t) ? 1 : 0)) / (corpus.n - 1) <= DF_MAX)
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 6)
    .map(([t]) => t);
  const [t1, t2, t3, t4, t5, t6] = [...terms, ...Array(6).fill(terms[0] ?? "the method")];
  return {
    terms,
    items: [
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
    ],
  };
}

const mode = process.argv[2];
const set = process.argv[3];

if (mode === "select") {
  const tree = new Map(readJson(join(M15, "coco-tree.json")).tree.filter((t) => t.type === "blob").map((t) => [t.path, t]));
  const opened = new Set([
    ...readJson(join(M15, "D2", "selection.json")).selected.map((p) => p.id),
    ...readJson(join(M16, "B", "m1511-exclusion.json")).noteIds,
    ...readJson(join(M16, "B", "sealed-selection.json")).selected.map((p) => p.id),
  ]);
  const excluded = { devOpened: 0, size: 0, opinions: 0, specific: 0 };
  const pool = [];
  for (const r of corpus.records) {
    if (opened.has(r.id)) { excluded.devOpened += 1; continue; }
    const blob = tree.get(r.MD_path);
    if (blob === undefined || blob.size < 15_000 || blob.size > 60_000) { excluded.size += 1; continue; }
    if (humanWeaknesses(r).length < 5) { excluded.opinions += 1; continue; }
    pool.push({ id: r.id, key: sha(`m16-closure-heldout|${r.id}`), stratum: /^Accept/.test(r.decision) ? "accept" : "reject", decision: r.decision, mdPath: r.MD_path, blobSha: blob.sha, mdBytes: blob.size });
  }
  pool.sort((a, b) => a.key.localeCompare(b.key));
  const selected = [];
  for (const stratum of ["accept", "reject"]) {
    for (const c of pool.filter((p) => p.stratum === stratum)) {
      if (selected.filter((s) => s.stratum === stratum).length >= PER_STRATUM) break;
      const file = mdPathOf(recordById.get(c.id));
      if (!existsSync(file)) {
        const res = await fetch(`https://api.github.com/repos/hexuandeng/CoCoReviewBench/git/blobs/${c.blobSha}`, { headers: { Accept: "application/vnd.github.raw+json", "User-Agent": "paperteam-m16-closure", ...(process.env.GITHUB_TOKEN ? { Authorization: `Bearer ${process.env.GITHUB_TOKEN}` } : {}) } });
        if (!res.ok) throw new Error(`${c.id} HTTP ${res.status}`);
        writeFileSync(file, Buffer.from(await res.arrayBuffer()));
      }
      const bytes = readFileSync(file);
      if (createHash("sha1").update(`blob ${bytes.length}\0`).update(bytes).digest("hex") !== c.blobSha) throw new Error(`${c.id} blob sha 不符`);
      const labels = labelsFor(recordById.get(c.id), bytes.toString("utf8"));
      const specific = labels.filter((l) => l.label === "SPECIFIC").length;
      if (specific < MIN_SPECIFIC) { excluded.specific += 1; continue; }
      selected.push({ ...c, mdSha256: createHash("sha256").update(bytes).digest("hex"), humanOpinions: labels.length, specificOpinions: specific, anchoredOpinions: labels.filter((l) => l.anchor).length });
    }
  }
  const out = { schema: "m16-closure-heldout/v1", frozenAt: new Date().toISOString(), rule: `exclude DEV_OPENED; MD 15k-60k bytes; ≥5 weakness opinions; ≥${MIN_SPECIFIC} SPECIFIC; sha256("m16-closure-heldout|id") asc; ${PER_STRATUM}/stratum`, poolSize: pool.length, excluded, selected };
  writeFileSync(join(B, "heldout-selection.json"), `${JSON.stringify(out, null, 2)}\n`);
  console.log(`pool=${pool.length} excluded=${JSON.stringify(excluded)}`);
  for (const s of selected) console.log(s.id, s.stratum, `md=${s.mdBytes}`, `opinions=${s.humanOpinions}`, `specific=${s.specificOpinions}`, `anchored=${s.anchoredOpinions}`);
} else if (mode === "generate") {
  const sel = readJson(join(B, "heldout-selection.json")).selected;
  const outPath = join(B, "heldout-generations.json");
  const results = existsSync(outPath) ? readJson(outPath) : {};
  const taxonomy = readJson(join(COCO, "taxonomy.json")).map((t) => `${t.code}: ${t.gloss}`).join("\n");
  const model = await createModel();
  for (const p of sel) {
    if (results[p.id]?.parsed) continue;
    const md = localMd(recordById.get(p.id));
    const user = `Category taxonomy:\n${taxonomy}\n\nPaper (markdown, full text, ${md.length} characters):\n\n${md}`;
    const attempts = [];
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const { text, usage, durationMs } = await model.complete(`B generate CORRECT ${p.id} try${attempt}`, SYSTEM_A, user, 4000);
        attempts.push({ usage, durationMs, raw: text });
        const parsed = parseJsonObject(text);
        if (!Array.isArray(parsed.weaknesses)) throw new Error("weaknesses 缺失");
        results[p.id] = { inputSha256: sha(SYSTEM_A + user), attempts, parsed };
        break;
      } catch (error) {
        attempts.push({ error: String(error).slice(0, 200) });
        results[p.id] = { attempts, parsed: null };
        if (String(error).includes("[budget]")) break;
      }
    }
    writeFileSync(outPath, `${JSON.stringify(results, null, 1)}\n`);
    console.log(`[generate] ${p.id} ${results[p.id].parsed ? `items=${results[p.id].parsed.weaknesses.length}` : "FAILED"} calls=${callsUsed()}`);
  }
} else if (mode === "judge" || mode === "score") {
  if (!["dev", "heldout"].includes(set)) throw new Error("set: dev | heldout");
  let papers;
  let correct;
  if (set === "dev") {
    const m16sel = readJson(join(M16, "B", "sealed-selection.json")).selected;
    papers = [...m16sel.filter((p) => p.stratum === "accept").slice(0, 2), ...m16sel.filter((p) => p.stratum === "reject").slice(0, 2)];
    const single = readJson(join(M16, "C", "single-pass.json"));
    correct = (id) => single[`${id}|Afull`].parsed.weaknesses.map((w) => w.point);
  } else {
    papers = readJson(join(B, "heldout-selection.json")).selected;
    const gen = readJson(join(B, "heldout-generations.json"));
    correct = (id) => gen[id]?.parsed?.weaknesses.map((w) => w.point) ?? null;
  }
  const order = [...papers].sort((a, b) => sha(`m16-closure-mismatch|${a.id}`).localeCompare(sha(`m16-closure-mismatch|${b.id}`)));
  const mismatchOf = (id) => order[(order.findIndex((p) => p.id === id) + 1) % order.length].id;
  const arms = (p, md) => ({
    CORRECT: correct(p.id)?.slice(0, 10) ?? null,
    MISMATCHED: correct(mismatchOf(p.id))?.slice(0, 10) ?? null,
    G0: GENERIC_CONTROL.slice(0, 10),
    ATTACK: attackItems(p.id, md).items,
  });
  const judgePath = join(B, `judge-${set}.json`);
  const judged = existsSync(judgePath) ? readJson(judgePath) : {};
  if (mode === "judge") {
    const model = await createModel();
    for (const p of papers) {
      if (judged[p.id]?.matches) continue;
      const record = recordById.get(p.id);
      const md = localMd(record);
      const a = arms(p, md);
      if (Object.values(a).some((v) => v === null)) { console.log(`[judge] ${p.id} 缺臂输出，跳过`); continue; }
      const human = humanWeaknesses(record);
      // 匿名混合乱序：条目 id 与臂的映射只写进结果文件
      const pool = Object.entries(a).flatMap(([arm, items]) => items.map((text, i) => ({ arm, rank: i + 1, text })));
      pool.sort((x, y) => sha(`${p.id}|${x.arm}|${x.rank}|blind`).localeCompare(sha(`${p.id}|${y.arm}|${y.rank}|blind`)));
      const items = pool.map((it, i) => ({ id: `I${i + 1}`, ...it }));
      const abstract = clip(md.replace(/^#[^\n]*\n/, "").trim(), 1800);
      const user = `Paper title and opening text (context only):\n${clip(record.title ?? md.split("\n")[0], 300)}\n${abstract}\n\nReference criticisms (human reviewers):\n${human.map((o, i) => `H${i + 1}: ${clip(o.text, 600)}`).join("\n")}\n\nAI review items (shuffled, anonymous):\n${items.map((it) => `${it.id}: ${clip(it.text, 450)}`).join("\n")}`;
      const attempts = [];
      let matches = null;
      for (let attempt = 0; attempt < 2 && matches === null; attempt += 1) {
        try {
          const { text, usage, durationMs } = await model.complete(`B judge ${set} ${p.id} try${attempt}`, JUDGE_SYSTEM, user, 6000);
          attempts.push({ usage, durationMs, raw: text });
          const obj = parseJsonObject(text);
          if (typeof obj.matches !== "object" || obj.matches === null) throw new Error("matches 缺失");
          matches = obj.matches;
        } catch (error) {
          attempts.push({ error: String(error).slice(0, 200) });
          if (String(error).includes("[budget]")) break;
        }
      }
      judged[p.id] = { inputSha256: sha(JUDGE_SYSTEM + user), humanCount: human.length, items: items.map(({ id, arm, rank }) => ({ id, arm, rank })), attempts, matches };
      writeFileSync(judgePath, `${JSON.stringify(judged, null, 1)}\n`);
      console.log(`[judge-${set}] ${p.id} ${matches ? "ok" : "FAILED"} calls=${callsUsed()}`);
    }
  } else {
    const ARMS = ["CORRECT", "MISMATCHED", "G0", "ATTACK"];
    const per = [];
    for (const p of papers) {
      const j = judged[p.id];
      if (!j?.matches) continue;
      const record = recordById.get(p.id);
      const md = localMd(record);
      const labels = labelsFor(record, md);
      const a = arms(p, md);
      const spec = labels.map((l, k) => (l.label === "SPECIFIC" ? k : -1)).filter((k) => k >= 0);
      const row = { id: p.id, stratum: p.stratum, human: labels.length, specific: spec.length, arms: {} };
      for (const arm of ARMS) {
        const judgeHits = new Set();
        const hybridHits = new Set();
        let matchedItems = 0;
        for (const it of j.items.filter((x) => x.arm === arm && x.rank <= 10)) {
          const hs = (j.matches[it.id] ?? []).map((h) => Number(String(h).replace(/\D/g, "")) - 1).filter((k) => k >= 0 && k < labels.length);
          if (hs.length > 0) matchedItems += 1;
          const toks = new Set(tokenize(a[arm][it.rank - 1]));
          for (const k of hs) {
            judgeHits.add(k);
            if (labels[k].label === "SPECIFIC" && labels[k].terms.some((t) => toks.has(t))) hybridHits.add(k);
          }
        }
        const nGen = labels.length - spec.length;
        row.arms[arm] = {
          hybridSpec: hybridHits.size / spec.length,
          judgeSpec: [...judgeHits].filter((k) => labels[k].label === "SPECIFIC").length / spec.length,
          judgeAll: judgeHits.size / labels.length,
          judgeGeneric: nGen > 0 ? [...judgeHits].filter((k) => labels[k].label === "GENERIC").length / nGen : null,
          matchedItemRate: matchedItems / Math.min(10, a[arm].length),
        };
      }
      per.push(row);
    }
    const metrics = ["hybridSpec", "judgeSpec", "judgeAll", "judgeGeneric", "matchedItemRate"];
    const summary = Object.fromEntries(ARMS.map((arm) => [arm, Object.fromEntries(metrics.map((m) => [m, bootstrapCi(per.map((r) => r.arms[arm][m]).filter((v) => v !== null))]))]));
    const contrast = (arm, base, m) => bootstrapCi(per.map((r) => r.arms[arm][m] - r.arms[base][m]));
    const verdictOf = (c) => (c.mean >= MID && c.low > 0 ? "PASS" : c.mean >= MID ? "UNDERPOWERED" : "FAIL");
    const gate = {
      G1_hybrid_correct_vs_mismatched: contrast("CORRECT", "MISMATCHED", "hybridSpec"),
      G2_hybrid_correct_vs_attack: contrast("CORRECT", "ATTACK", "hybridSpec"),
      G3_judgeOnly_correct_vs_generic: contrast("CORRECT", "G0", "judgeSpec"),
    };
    for (const g of Object.values(gate)) g.verdict = verdictOf(g);
    const diagnostics = {
      judgeOnly_correct_vs_mismatched: contrast("CORRECT", "MISMATCHED", "judgeSpec"),
      judgeOnly_correct_vs_attack: contrast("CORRECT", "ATTACK", "judgeSpec"),
      judgeAll_correct_vs_generic: contrast("CORRECT", "G0", "judgeAll"),
      hybrid_correct_vs_generic_byConstruction: contrast("CORRECT", "G0", "hybridSpec"),
    };
    const verdicts = Object.values(gate).map((g) => g.verdict);
    const failedJudges = papers.length - per.length;
    const benchmarkValidity = failedJudges > 0 && set === "heldout" ? "BLOCKED" : verdicts.every((v) => v === "PASS") ? "PASS" : verdicts.includes("FAIL") ? "NOT_DISCRIMINATIVE" : "UNDERPOWERED";
    const out = { schema: "m16-closure-b-score/v1", set, generatedAt: new Date().toISOString(), nPapers: per.length, failedJudges, MID, summary, gate, diagnostics, benchmarkValidity, per };
    writeFileSync(join(B, `score-${set}.json`), `${JSON.stringify(out, null, 1)}\n`);
    const f = (c) => (c.mean === null ? "n/a" : `${(c.mean * 100).toFixed(1)} [${(c.low * 100).toFixed(1)}, ${(c.high * 100).toFixed(1)}]`);
    console.log(`set=${set} n=${per.length} failedJudges=${failedJudges}`);
    for (const arm of ARMS) console.log(arm.padEnd(10), metrics.map((m) => `${m} ${f(summary[arm][m])}`).join(" | "));
    for (const [k, v] of Object.entries(gate)) console.log(k, f(v), v.verdict);
    for (const [k, v] of Object.entries(diagnostics)) console.log("diag", k, f(v));
    console.log("BENCHMARK_VALIDITY =", benchmarkValidity);
  }
} else {
  throw new Error("mode: select | generate | judge <set> | score <set>");
}
