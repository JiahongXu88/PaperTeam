#!/usr/bin/env node
/**
 * M16 收口 · C：单次全文 LLM（S = B 的 CORRECT 输出）vs 生产 LaTeX Reviewer（P = production.mjs live 产物），n = 2，只描述。
 *
 *   node scripts/m16-closure/c-compare.mjs judge   # 每篇 1 次盲评：S 前 10 条 + P 全部 findings 混合匿名乱序（与 B 同一 JUDGE_SYSTEM）
 *   node scripts/m16-closure/c-compare.mjs score   # 零模型：hybridSpec / judgeSpec，P@10（严重度排序前 10）、P@all、S@10；粒度拆分；成本
 *
 * 粒度（PROTOCOL §7 冻结）：带显式定位的意见 → LOCAL；否则类别含 QUAL-EXP / QUAL-CMP / QUAL-STA / SIGN-* / ORIG-* / POL-IMP → WHOLE_PAPER；其余 LOCAL。
 */
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { humanWeaknesses, parseJsonObject } from "../m16-review-validity/lib.mjs";
import { JUDGE_SYSTEM } from "./judge-prompt.mjs";
import { COCO, ROOT, callsUsed, createModel, readJson, sha } from "./lib.mjs";
import { classifyOpinion, loadCorpus, tokenize } from "./specificity.mjs";

const CASES = ["JWtrk7mprJ", "jbfDg4DgAk"];
const corpus = loadCorpus(humanWeaknesses);
const recordById = new Map(corpus.records.map((r) => [r.id, r]));
const gen = readJson(join(ROOT, "B", "heldout-generations.json"));
const mdOf = (id) => readFileSync(join(ROOT, "external", "cocoreviewbench-md", recordById.get(id).MD_path.replace(/^benchmark\/MD\//, "")), "utf8");
const SEVERITY_RANK = { critical: 0, blocking: 0, major: 1, minor: 2, info: 3 };
const runDir = (id) => join(ROOT, "C", "production", `${id}__live__fidelity`);
function productionFindings(id) {
  return readJson(join(runDir(id), "artifacts", "review-summary-r1.json"))
    .issues.map((issue, index) => ({ index, severity: issue.severity, category: issue.category, text: issue.description }))
    .sort((a, b) => (SEVERITY_RANK[a.severity] ?? 4) - (SEVERITY_RANK[b.severity] ?? 4) || a.index - b.index);
}
const WHOLE = /^(QUAL-EXP|QUAL-CMP|QUAL-STA|SIGN-|ORIG-|POL-IMP)/;
const granularity = (label) => (label.anchor ? "LOCAL" : label.category.some((c) => WHOLE.test(c)) ? "WHOLE_PAPER" : "LOCAL");
const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));
const judgePath = join(ROOT, "C", "judge-compare.json");
const judged = existsSync(judgePath) ? readJson(judgePath) : {};
const mode = process.argv[2];

if (mode === "judge") {
  const model = await createModel();
  for (const id of CASES) {
    if (judged[id]?.matches) continue;
    const record = recordById.get(id);
    const md = mdOf(id);
    const human = humanWeaknesses(record);
    const pool = [
      ...gen[id].parsed.weaknesses.slice(0, 10).map((w, i) => ({ arm: "S", rank: i + 1, text: w.point })),
      ...productionFindings(id).map((f, i) => ({ arm: "P", rank: i + 1, text: f.text })),
    ].sort((x, y) => sha(`${id}|${x.arm}|${x.rank}|c-blind`).localeCompare(sha(`${id}|${y.arm}|${y.rank}|c-blind`)));
    const items = pool.map((it, i) => ({ id: `I${i + 1}`, ...it }));
    const user = `Paper title and opening text (context only):\n${clip(record.title ?? md.split("\n")[0], 300)}\n${clip(md.replace(/^#[^\n]*\n/, "").trim(), 1800)}\n\nReference criticisms (human reviewers):\n${human.map((o, i) => `H${i + 1}: ${clip(o.text, 600)}`).join("\n")}\n\nAI review items (shuffled, anonymous):\n${items.map((it) => `${it.id}: ${clip(it.text, 450)}`).join("\n")}`;
    const attempts = [];
    let matches = null;
    for (let attempt = 0; attempt < 2 && matches === null; attempt += 1) {
      try {
        const { text, usage, durationMs } = await model.complete(`C judge ${id} try${attempt}`, JUDGE_SYSTEM, user, 8000);
        attempts.push({ usage, durationMs, raw: text });
        const obj = parseJsonObject(text);
        if (typeof obj.matches !== "object" || obj.matches === null) throw new Error("matches 缺失");
        matches = obj.matches;
      } catch (error) {
        attempts.push({ error: String(error).slice(0, 200) });
        if (String(error).includes("[budget]")) break;
      }
    }
    judged[id] = { inputSha256: sha(JUDGE_SYSTEM + user), humanCount: human.length, items: items.map(({ id: itemId, arm, rank }) => ({ id: itemId, arm, rank })), attempts, matches };
    writeFileSync(judgePath, `${JSON.stringify(judged, null, 1)}\n`);
    console.log(`[c-judge] ${id} items=${items.length} ${matches ? "ok" : "FAILED"} calls=${callsUsed()}`);
  }
} else if (mode === "score") {
  const per = [];
  for (const id of CASES) {
    const j = judged[id];
    if (!j?.matches) continue;
    const record = recordById.get(id);
    const md = mdOf(id);
    const human = humanWeaknesses(record);
    const labels = human.map((o) => ({ ...o, ...classifyOpinion(o.text, id, md, corpus) }));
    labels.forEach((l) => (l.granularity = granularity(l)));
    const texts = { S: gen[id].parsed.weaknesses.slice(0, 10).map((w) => w.point), P: productionFindings(id).map((f) => f.text) };
    const hitsOf = (arm, maxRank) => {
      const judge = new Set();
      const hybrid = new Set();
      let matchedItems = 0;
      const items = j.items.filter((x) => x.arm === arm && x.rank <= maxRank);
      for (const it of items) {
        const hs = (j.matches[it.id] ?? []).map((h) => Number(String(h).replace(/\D/g, "")) - 1).filter((k) => k >= 0 && k < labels.length);
        if (hs.length > 0) matchedItems += 1;
        const toks = new Set(tokenize(texts[arm][it.rank - 1]));
        for (const k of hs) {
          judge.add(k);
          if (labels[k].label === "SPECIFIC" && labels[k].terms.some((t) => toks.has(t))) hybrid.add(k);
        }
      }
      return { judge, hybrid, items: items.length, matchedItems };
    };
    const spec = labels.map((l, k) => k).filter((k) => labels[k].label === "SPECIFIC");
    const rate = (set, pool) => (pool.length ? pool.filter((k) => set.has(k)).length / pool.length : null);
    const arms = { "S@10": hitsOf("S", 10), "P@10": hitsOf("P", 10), "P@all": hitsOf("P", Infinity) };
    const byGran = (g) => spec.filter((k) => labels[k].granularity === g);
    const row = { id, human: labels.length, specific: spec.length, specificWhole: byGran("WHOLE_PAPER").length, specificLocal: byGran("LOCAL").length, arms: {} };
    for (const [name, h] of Object.entries(arms)) {
      row.arms[name] = {
        items: h.items,
        hybridSpec: rate(h.hybrid, spec),
        judgeSpec: rate(h.judge, spec),
        judgeAll: h.judge.size / labels.length,
        matchedItemRate: h.items ? h.matchedItems / h.items : null,
        judgeSpecWhole: rate(h.judge, byGran("WHOLE_PAPER")),
        judgeSpecLocal: rate(h.judge, byGran("LOCAL")),
        judgeAllWhole: rate(h.judge, labels.map((l, k) => k).filter((k) => labels[k].granularity === "WHOLE_PAPER")),
        judgeAllLocal: rate(h.judge, labels.map((l, k) => k).filter((k) => labels[k].granularity === "LOCAL")),
      };
    }
    const S = arms["S@10"].judge;
    const P = arms["P@all"].judge;
    row.missedByP_hitByS = [...S].filter((k) => !P.has(k)).map((k) => ({ h: k + 1, granularity: labels[k].granularity, label: labels[k].label, category: labels[k].category }));
    row.hitByP_missedByS = [...P].filter((k) => !S.has(k)).map((k) => ({ h: k + 1, granularity: labels[k].granularity, label: labels[k].label, category: labels[k].category }));
    const run = readJson(join(runDir(id), "run-result.json"));
    // 用量字段：单次调用 = pi-ai usage（input / output / cacheRead / cost.total）；生产子调用 = 运行时 usage（inputTokens / … / estimatedCost）
    const KEYS = { input: ["input", "inputTokens"], output: ["output", "outputTokens"], cacheRead: ["cacheRead", "cacheReadTokens"] };
    const sum = (arr, key) => arr.reduce((n, c) => n + (KEYS[key].map((k) => c.usage?.[k]).find((v) => typeof v === "number") ?? 0), 0);
    const costOf = (arr) => arr.reduce((n, c) => n + (c.usage?.cost?.total ?? c.usage?.estimatedCost ?? 0), 0);
    const sAttempts = gen[id].attempts.filter((a) => a.usage);
    row.cost = {
      S: { calls: gen[id].attempts.length, input: sum(sAttempts, "input"), output: sum(sAttempts, "output"), cacheRead: sum(sAttempts, "cacheRead"), estimatedCostUsd: costOf(sAttempts), ms: sAttempts.reduce((n, a) => n + a.durationMs, 0) },
      P: { calls: run.callCount, failed: run.failedCalls, input: sum(run.calls, "input"), output: sum(run.calls, "output"), cacheRead: sum(run.calls, "cacheRead"), estimatedCostUsd: costOf(run.calls), ms: run.ms, findings: texts.P.length },
    };
    per.push(row);
  }
  const out = { schema: "m16-closure-c-compare/v1", generatedAt: new Date().toISOString(), note: "n = 2，描述性；不做显著性结论（PROTOCOL §7）", per };
  writeFileSync(join(ROOT, "C", "c-compare.json"), `${JSON.stringify(out, null, 1)}\n`);
  const p = (v) => (v === null ? "  n/a" : `${(v * 100).toFixed(1).padStart(5)}`);
  for (const r of per) {
    console.log(`${r.id} human=${r.human} specific=${r.specific} (whole ${r.specificWhole} / local ${r.specificLocal})`);
    for (const [name, a] of Object.entries(r.arms)) console.log(`  ${name.padEnd(6)} items=${String(a.items).padStart(2)} hybridSpec ${p(a.hybridSpec)} judgeSpec ${p(a.judgeSpec)} judgeAll ${p(a.judgeAll)} matchedItems ${p(a.matchedItemRate)} | spec whole ${p(a.judgeSpecWhole)} local ${p(a.judgeSpecLocal)} | all whole ${p(a.judgeAllWhole)} local ${p(a.judgeAllLocal)}`);
    console.log("  missed by P, hit by S:", JSON.stringify(r.missedByP_hitByS));
    console.log("  hit by P, missed by S:", JSON.stringify(r.hitByP_missedByS));
    console.log("  cost:", JSON.stringify(r.cost));
  }
} else {
  throw new Error("mode: judge | score");
}
