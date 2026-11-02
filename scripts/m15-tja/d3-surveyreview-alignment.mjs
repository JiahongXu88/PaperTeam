#!/usr/bin/env node
/**
 * M15 TJA · D3：SurveyReview（v1.1 test）四维质量对齐（协议 §5，冻结后只跑一次）。
 *
 *   node scripts/m15-tja/d3-surveyreview-alignment.mjs select | run | score
 *
 * 参考分：每条测试样本 = 一份真实审稿报告的四维分（{-2,-1,1,2}；0 = 该审稿人未评该维度 → 不计分）。
 * 臂：A = 官方四维评分指南（eval-prompt.json 原文合并为一次调用）；B = 同指南 + 证据纪律（每维须给逐字引文，
 * 无法定位则 INSUFFICIENT_EVIDENCE 不打分）。同模型、同输入（全文前 40,000 字符）。
 */
import { createHash } from "node:crypto";
import { existsSync, readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { join } from "node:path";

import { DATA, bootstrapCi, callsUsed, createModel, parseJsonObject, quoteFound } from "./model-harness.mjs";

const EXT = join(DATA, "external", "surveyreview-6566398");
const OUT = join(DATA, "D3");
mkdirSync(OUT, { recursive: true });
const N = 8;
const INPUT_CHARS = 40_000;
const DIMS = ["Readability", "Criticalness", "Comprehensiveness", "Structure"];
const mode = process.argv[2];
const sha = (s) => createHash("sha256").update(s).digest("hex");

function articles() {
  return { ...JSON.parse(readFileSync(join(EXT, "articles_part1.json"), "utf8")), ...JSON.parse(readFileSync(join(EXT, "articles_part2.json"), "utf8")) };
}
const articleKey = (uid, all) => (uid in all ? uid : uid.replace(/-r\d+$/, "") in all ? uid.replace(/-r\d+$/, "") : null);

function guide() {
  const prompts = JSON.parse(readFileSync(join(EXT, "eval-prompt.json"), "utf8"));
  return DIMS.map((d) => `## ${d}\n${prompts[d].split("### Output Format:")[0].trim()}`).join("\n\n");
}
const SYSTEM_A = "You are a research paper reviewer. Score the manuscript on four dimensions using the official scoring guides. Output only one JSON object: {\"scores\": {\"Readability\": {\"reason\": \"...\", \"score\": -2|-1|1|2}, \"Criticalness\": {...}, \"Comprehensiveness\": {...}, \"Structure\": {...}}}.";
const SYSTEM_B =
  "You are a research paper reviewer. Score the manuscript on four dimensions using the official scoring guides, under an evidence discipline: for each dimension give 1-2 verbatim excerpts (12-200 characters, copied exactly from the manuscript) that support your score; " +
  "if you cannot ground a dimension in the text, set \"score\" to null and \"status\" to \"INSUFFICIENT_EVIDENCE\". Do not invent content. " +
  "Output only one JSON object: {\"scores\": {\"Readability\": {\"reason\": \"...\", \"evidenceQuotes\": [\"...\"], \"score\": -2|-1|1|2|null, \"status\": \"GROUNDED\"|\"INSUFFICIENT_EVIDENCE\"}, \"Criticalness\": {...}, \"Comprehensiveness\": {...}, \"Structure\": {...}}}.";

if (mode === "select") {
  const all = articles();
  const test = JSON.parse(readFileSync(join(EXT, "grouped_testset.json"), "utf8"));
  const candidates = test
    .map((s) => ({ uid: s.uid, source: s.source, title: s.paper_title, key: sha(`tja-d3|${s.uid}`), articleKey: articleKey(s.uid, all), reference: Object.fromEntries(s.result.map((r) => [r.dimension, r.score])) }))
    .filter((s) => s.articleKey !== null && DIMS.filter((d) => (s.reference[d] ?? 0) !== 0).length >= 2)
    .sort((a, b) => a.key.localeCompare(b.key));
  const selected = [];
  const seenArticles = new Set();
  for (const c of candidates) {
    if (seenArticles.has(c.articleKey)) continue; // 同一综述多份审稿报告只取一份（防分组泄漏 / 重复）
    seenArticles.add(c.articleKey);
    selected.push(c);
    if (selected.length === N) break;
  }
  writeFileSync(join(OUT, "selection.json"), `${JSON.stringify({ frozenAt: new Date().toISOString(), test: test.length, candidates: candidates.length, selected }, null, 2)}\n`);
  console.log(`test=${test.length} candidates=${candidates.length} selected=${selected.map((s) => s.uid).join(" ")}`);
} else if (mode === "run") {
  const selection = JSON.parse(readFileSync(join(OUT, "selection.json"), "utf8"));
  const all = articles();
  const model = await createModel();
  const g = guide();
  const resultsPath = join(OUT, "outputs.json");
  const results = existsSync(resultsPath) ? JSON.parse(readFileSync(resultsPath, "utf8")) : {};
  for (const sample of selection.selected) {
    const text = String(all[sample.articleKey]);
    const user = `Official scoring guides:\n\n${g}\n\nManuscript (first ${INPUT_CHARS} characters${text.length > INPUT_CHARS ? `, truncated from ${text.length}` : ""}):\n\n${text.slice(0, INPUT_CHARS)}`;
    for (const [arm, system] of [["A", SYSTEM_A], ["B", SYSTEM_B]]) {
      const key = `${sample.uid}|${arm}`;
      if (results[key]?.parsed !== undefined) continue;
      const attempts = [];
      let parsed;
      for (let attempt = 0; attempt < 2 && parsed === undefined; attempt += 1) {
        try {
          const { text: out, usage, durationMs } = await model.complete(`D3 ${arm} ${sample.uid} try${attempt}`, system, user, 2500);
          attempts.push({ usage, durationMs, chars: out.length });
          const obj = parseJsonObject(out);
          if (typeof obj.scores !== "object" || obj.scores === null) throw new Error("scores 缺失");
          parsed = obj;
        } catch (error) {
          attempts.push({ error: String(error).slice(0, 200) });
          if (String(error).includes("[budget]")) break;
        }
      }
      results[key] = { arm, uid: sample.uid, attempts, ...(parsed !== undefined ? { parsed } : {}) };
      writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
      console.log(`[d3] ${key} ${parsed !== undefined ? "ok" : "FAILED"} calls=${callsUsed()}`);
    }
  }
} else if (mode === "score") {
  const selection = JSON.parse(readFileSync(join(OUT, "selection.json"), "utf8"));
  const results = JSON.parse(readFileSync(join(OUT, "outputs.json"), "utf8"));
  const all = articles();
  const rows = [];
  for (const sample of selection.selected) {
    const text = String(all[sample.articleKey]);
    for (const dim of DIMS) {
      const ref = sample.reference[dim] ?? 0;
      if (ref === 0) continue;
      const row = { uid: sample.uid, dim, ref };
      for (const arm of ["A", "B"]) {
        const entry = results[`${sample.uid}|${arm}`]?.parsed?.scores?.[dim];
        const score = typeof entry?.score === "number" && [-2, -1, 1, 2].includes(entry.score) ? entry.score : null;
        row[arm] = score;
        if (arm === "B") {
          const quotes = Array.isArray(entry?.evidenceQuotes) ? entry.evidenceQuotes : [];
          row.Bquotes = quotes.length;
          row.BquotesLocated = quotes.filter((q) => quoteFound(q, text)).length;
        }
      }
      rows.push(row);
    }
  }
  const metric = (arm) => {
    const scored = rows.filter((r) => r[arm] !== null);
    return {
      scored: scored.length,
      abstained: rows.length - scored.length,
      mae: bootstrapCi(scored.map((r) => Math.abs(r[arm] - r.ref))),
      signAgreement: bootstrapCi(scored.map((r) => (Math.sign(r[arm]) === Math.sign(r.ref) ? 1 : 0))),
      // 参考分 ≤ -1 的维度（审稿人认为有问题）被模型判为负分的比例
      negativeRecall: scored.filter((r) => r.ref < 0).length === 0 ? null : scored.filter((r) => r.ref < 0 && r[arm] < 0).length / scored.filter((r) => r.ref < 0).length,
      meanPredicted: scored.reduce((a, r) => a + r[arm], 0) / Math.max(1, scored.length),
    };
  };
  const summary = {
    samples: selection.selected.length,
    scoredDimensions: rows.length,
    referenceMean: rows.reduce((a, r) => a + r.ref, 0) / Math.max(1, rows.length),
    referenceNegative: rows.filter((r) => r.ref < 0).length,
    A: metric("A"),
    B: metric("B"),
    BquoteLocatedRate: rows.reduce((a, r) => a + (r.BquotesLocated ?? 0), 0) / Math.max(1, rows.reduce((a, r) => a + (r.Bquotes ?? 0), 0)),
  };
  writeFileSync(join(OUT, "metrics.json"), `${JSON.stringify({ summary, rows }, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
} else {
  throw new Error("mode: select | run | score");
}
