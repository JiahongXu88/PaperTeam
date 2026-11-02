#!/usr/bin/env node
/**
 * M15 TJA · D2：CoCoReviewBench（ICLR 2025）已知参考类别召回（协议 §4，冻结后只跑一次）。
 *
 *   node scripts/m15-tja/d2-cocoreview-recall.mjs select   # 零模型：抽样 + 人类参考类别 → D2/selection.json
 *   node scripts/m15-tja/d2-cocoreview-recall.mjs run      # 付费：12 篇 × 2 臂（A 单次 / B 证据约束），断点续跑
 *   node scripts/m15-tja/d2-cocoreview-recall.mjs score    # 零模型：类别召回 + bootstrap CI + 引文定位率
 *
 * 数据目录：<DATA>/external/cocoreviewbench-2580687（jsonl / MD / taxonomy.json），不入库。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { DATA, bootstrapCi, callsUsed, createModel, parseJsonObject, quoteFound } from "./model-harness.mjs";

const EXT = join(DATA, "external", "cocoreviewbench-2580687");
const OUT = join(DATA, "D2");
mkdirSync(OUT, { recursive: true });
const N = 12;
const INPUT_CHARS = 40_000;
const mode = process.argv[2];
const sha = (s) => createHash("sha256").update(s).digest("hex");

const SYSTEM_A =
  "You are an expert reviewer for a top machine learning conference. Read the paper and list its main weaknesses as a reviewer would. " +
  "Output only one JSON object: {\"weaknesses\": [{\"category\": \"<CODE>\", \"point\": \"<one or two sentences>\"}]} with at most 10 items. " +
  "Use exactly one category code per item from the provided taxonomy.";
const SYSTEM_B =
  "You are an expert reviewer for a top machine learning conference. Read the paper and list its main weaknesses as a reviewer would, under an evidence discipline: " +
  "every weakness must cite a verbatim excerpt (12-200 characters, copied exactly from the paper text) that shows where the issue is located; " +
  "if a weakness concerns something missing from the paper, quote the closest passage that makes the omission visible; " +
  "if you cannot ground a weakness in the text, set \"evidenceQuote\" to null and \"status\" to \"INSUFFICIENT_EVIDENCE\" instead of guessing. Do not invent content that is not in the paper. " +
  "Output only one JSON object: {\"weaknesses\": [{\"category\": \"<CODE>\", \"point\": \"<one or two sentences>\", \"evidenceQuote\": \"<verbatim>\"|null, \"status\": \"GROUNDED\"|\"INSUFFICIENT_EVIDENCE\"}]} with at most 10 items. " +
  "Use exactly one category code per item from the provided taxonomy.";

function taxonomyText() {
  const taxonomy = JSON.parse(readFileSync(join(EXT, "taxonomy.json"), "utf8"));
  return taxonomy.map((t) => `${t.code}: ${t.gloss}`).join("\n");
}

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
  let opinions = 0;
  record.opinions.forEach((opinion, index) => {
    if (record.conflicts_validation?.[index] === "incorrect" || record.rebuttal_validation?.[index] === "incorrect") return;
    const reviewerParts = opinion.data.filter((d) => /^Reviewer/.test(d.role));
    const isWeakness = reviewerParts.some((d) => d.sentence_ids.some((id) => weaknessIds.has(`${d.role}|${id}`)));
    if (!isWeakness) return;
    opinions += 1;
    for (const c of opinion.category) if (c !== "N/A") categories.add(c);
  });
  return { categories: [...categories].sort(), opinions };
}

if (mode === "select") {
  const tree = JSON.parse(readFileSync(join(DATA, "coco-tree.json"), "utf8")).tree;
  const sizes = new Map(tree.filter((t) => t.type === "blob").map((t) => [t.path, t.size]));
  const records = readFileSync(join(EXT, "benchmark_ICLR_2025.jsonl"), "utf8").split(/\r?\n/).filter((l) => l.trim() !== "").map((l) => JSON.parse(l));
  const candidates = records
    .filter((r) => (sizes.get(r.MD_path) ?? 0) >= 15_000 && (sizes.get(r.MD_path) ?? 0) <= 80_000)
    .map((r) => ({ id: r.id, key: sha(`tja-d2|${r.id}`), mdPath: r.MD_path, mdBytes: sizes.get(r.MD_path), decision: r.decision, title: r.content?.title?.value, ...weaknessCategories(r) }))
    .filter((r) => r.categories.length > 0)
    .sort((a, b) => a.key.localeCompare(b.key));
  const selected = candidates.slice(0, N);
  writeFileSync(join(OUT, "selection.json"), `${JSON.stringify({ frozenAt: new Date().toISOString(), records: records.length, candidates: candidates.length, selected }, null, 2)}\n`);
  console.log(`records=${records.length} candidates=${candidates.length} selected=${selected.map((s) => `${s.id}(${s.categories.length})`).join(" ")}`);
} else if (mode === "run") {
  const selection = JSON.parse(readFileSync(join(OUT, "selection.json"), "utf8"));
  const model = await createModel();
  const taxonomy = taxonomyText();
  const resultsPath = join(OUT, "outputs.json");
  const results = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, "utf8")) : {};
  for (const paper of selection.selected) {
    const md = readFileSync(join(EXT, paper.mdPath.replace(/^benchmark\//, "")), "utf8");
    const input = md.slice(0, INPUT_CHARS);
    for (const [arm, system] of [["A", SYSTEM_A], ["B", SYSTEM_B]]) {
      const key = `${paper.id}|${arm}`;
      if (results[key]?.parsed !== undefined) continue;
      const user = `Category taxonomy:\n${taxonomy}\n\nPaper (markdown, first ${INPUT_CHARS} characters${md.length > INPUT_CHARS ? `, truncated from ${md.length}` : ""}):\n\n${input}`;
      const attempts = [];
      let parsed;
      for (let attempt = 0; attempt < 2 && parsed === undefined; attempt += 1) {
        try {
          const { text, usage, durationMs } = await model.complete(`D2 ${arm} ${paper.id} try${attempt}`, system, user, 3000);
          attempts.push({ usage, durationMs, chars: text.length });
          const obj = parseJsonObject(text);
          if (!Array.isArray(obj.weaknesses)) throw new Error("weaknesses 不是数组");
          parsed = obj;
        } catch (error) {
          attempts.push({ error: String(error).slice(0, 200) });
          if (String(error).includes("[budget]")) break;
        }
      }
      results[key] = { arm, paperId: paper.id, attempts, ...(parsed !== undefined ? { parsed } : {}) };
      writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
      console.log(`[d2] ${key} ${parsed !== undefined ? `items=${parsed.weaknesses.length}` : "FAILED"} calls=${callsUsed()}`);
    }
  }
} else if (mode === "score") {
  const selection = JSON.parse(readFileSync(join(OUT, "selection.json"), "utf8"));
  const results = JSON.parse(readFileSync(join(OUT, "outputs.json"), "utf8"));
  const codes = new Set(JSON.parse(readFileSync(join(EXT, "taxonomy.json"), "utf8")).map((t) => t.code));
  const perPaper = [];
  for (const paper of selection.selected) {
    const md = readFileSync(join(EXT, paper.mdPath.replace(/^benchmark\//, "")), "utf8");
    const row = { id: paper.id, human: paper.categories };
    for (const arm of ["A", "B"]) {
      const out = results[`${paper.id}|${arm}`];
      const items = out?.parsed?.weaknesses ?? null;
      if (items === null) {
        row[arm] = null;
        continue;
      }
      const valid = items.filter((i) => codes.has(i.category));
      const grounded = arm === "B" ? valid.filter((i) => i.status !== "INSUFFICIENT_EVIDENCE" && typeof i.evidenceQuote === "string" && quoteFound(i.evidenceQuote, md)) : valid;
      const recallOf = (list) => paper.categories.filter((c) => new Set(list.map((i) => i.category)).has(c)).length / paper.categories.length;
      row[arm] = {
        items: items.length,
        invalidCategory: items.length - valid.length,
        recall: recallOf(valid),
        ...(arm === "B"
          ? {
              quoteClaimed: valid.filter((i) => typeof i.evidenceQuote === "string" && i.evidenceQuote !== "").length,
              quoteLocated: grounded.length,
              insufficient: valid.filter((i) => i.status === "INSUFFICIENT_EVIDENCE").length,
              recallGroundedOnly: recallOf(grounded),
            }
          : {}),
        tokens: (out.attempts ?? []).reduce((acc, a) => ({ input: acc.input + (a.usage?.input ?? 0), output: acc.output + (a.usage?.output ?? 0) }), { input: 0, output: 0 }),
        durationMs: (out.attempts ?? []).reduce((acc, a) => acc + (a.durationMs ?? 0), 0),
      };
    }
    perPaper.push(row);
  }
  const done = perPaper.filter((r) => r.A !== null && r.B !== null);
  const summary = {
    n: done.length,
    recallA: bootstrapCi(done.map((r) => r.A.recall)),
    recallB: bootstrapCi(done.map((r) => r.B.recall)),
    recallBGroundedOnly: bootstrapCi(done.map((r) => r.B.recallGroundedOnly)),
    diffBminusA: bootstrapCi(done.map((r) => r.B.recall - r.A.recall)),
    quoteLocatedRateB: done.reduce((a, r) => a + r.B.quoteLocated, 0) / Math.max(1, done.reduce((a, r) => a + r.B.items - r.B.invalidCategory, 0)),
    itemsA: done.reduce((a, r) => a + r.A.items, 0),
    itemsB: done.reduce((a, r) => a + r.B.items, 0),
    tokensA: done.reduce((a, r) => ({ input: a.input + r.A.tokens.input, output: a.output + r.A.tokens.output }), { input: 0, output: 0 }),
    tokensB: done.reduce((a, r) => ({ input: a.input + r.B.tokens.input, output: a.output + r.B.tokens.output }), { input: 0, output: 0 }),
    humanCategoriesPerPaper: done.reduce((a, r) => a + r.human.length, 0) / Math.max(1, done.length),
  };
  writeFileSync(join(OUT, "metrics.json"), `${JSON.stringify({ summary, perPaper }, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
} else {
  throw new Error("mode: select | run | score");
}
