#!/usr/bin/env node
/**
 * M16 · C：SurveyReview 四维评分（D3 反常的全新样本复测；预算剩余 ≥ 8 才跑，PROTOCOL §5.4）。
 *
 *   node scripts/m16-review-validity/c-survey.mjs select   # 零模型：排除 M15 D3 已开 8 篇；按参考分均值正 / 负分层各 4 篇
 *   node scripts/m16-review-validity/c-survey.mjs run      # 付费：每篇 1 次（M15 D3 臂 A Prompt 逐字，全文 ≤ 100,000 字符）
 *   node scripts/m16-review-validity/c-survey.mjs score    # 零模型：balanced accuracy / 负正类召回 / MAE + 常数基线
 *
 * 目的：区分「模型系统性偏宽松」与「M15 D3 抽样 84% 负向造成的口径假象」——在正负平衡的新样本上看模型是否仍几乎不给负分。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { M15, ROOT, bootstrapCi, callsUsed, createModel, parseJsonObject, readJson } from "./lib.mjs";

const EXT = join(M15, "external", "surveyreview-6566398");
const OUT = join(ROOT, "C");
mkdirSync(OUT, { recursive: true });
const DIMS = ["Readability", "Criticalness", "Comprehensiveness", "Structure"];
const INPUT_CHARS = 100_000;
const PER_STRATUM = 4;
const sha = (s) => createHash("sha256").update(s).digest("hex");
const articles = () => ({ ...readJson(join(EXT, "articles_part1.json")), ...readJson(join(EXT, "articles_part2.json")) });
const articleKey = (uid, all) => (uid in all ? uid : uid.replace(/-r\d+$/, "") in all ? uid.replace(/-r\d+$/, "") : null);

// 与 M15 D3 臂 A 逐字相同
const SYSTEM_A = "You are a research paper reviewer. Score the manuscript on four dimensions using the official scoring guides. Output only one JSON object: {\"scores\": {\"Readability\": {\"reason\": \"...\", \"score\": -2|-1|1|2}, \"Criticalness\": {...}, \"Comprehensiveness\": {...}, \"Structure\": {...}}}.";
function guide() {
  const prompts = readJson(join(EXT, "eval-prompt.json"));
  return DIMS.map((d) => `## ${d}\n${prompts[d].split("### Output Format:")[0].trim()}`).join("\n\n");
}

const mode = process.argv[2];
const selPath = join(OUT, "survey-selection.json");
if (mode === "select") {
  const all = articles();
  const opened = readJson(join(M15, "D3", "selection.json")).selected;
  const openedArticles = new Set(opened.map((s) => s.articleKey));
  const test = readJson(join(EXT, "grouped_testset.json"));
  const candidates = test
    .map((s) => ({ uid: s.uid, source: s.source, key: sha(`m16-survey|${s.uid}`), articleKey: articleKey(s.uid, all), reference: Object.fromEntries(s.result.map((r) => [r.dimension, r.score])) }))
    .filter((s) => s.articleKey !== null && !openedArticles.has(s.articleKey) && DIMS.filter((d) => (s.reference[d] ?? 0) !== 0).length >= 2)
    .map((s) => {
      const scored = DIMS.map((d) => s.reference[d] ?? 0).filter((v) => v !== 0);
      return { ...s, refMean: scored.reduce((a, b) => a + b, 0) / scored.length };
    })
    .filter((s) => s.refMean !== 0)
    .sort((a, b) => a.key.localeCompare(b.key));
  const selected = [];
  const seen = new Set();
  for (const stratum of ["positive", "negative"]) {
    let taken = 0;
    for (const c of candidates) {
      if (taken === PER_STRATUM) break;
      if ((stratum === "positive") !== c.refMean > 0 || seen.has(c.articleKey)) continue;
      seen.add(c.articleKey);
      selected.push({ ...c, stratum });
      taken += 1;
    }
  }
  writeFileSync(selPath, `${JSON.stringify({ frozenAt: new Date().toISOString(), excludedOpened: openedArticles.size, candidates: candidates.length, selected }, null, 2)}\n`);
  console.log(`candidates=${candidates.length} selected=${selected.map((s) => `${s.uid}(${s.stratum})`).join(" ")}`);
} else if (mode === "run") {
  const selection = readJson(selPath);
  const all = articles();
  const model = await createModel();
  const g = guide();
  const resultsPath = join(OUT, "survey-outputs.json");
  const results = existsSync(resultsPath) ? readJson(resultsPath) : {};
  for (const sample of selection.selected) {
    if (results[sample.uid]?.parsed !== undefined) continue;
    const text = String(all[sample.articleKey]);
    const user = `Official scoring guides:\n\n${g}\n\nManuscript (${text.length > INPUT_CHARS ? `first ${INPUT_CHARS} characters, truncated from ${text.length}` : `full text, ${text.length} characters`}):\n\n${text.slice(0, INPUT_CHARS)}`;
    const attempts = [];
    let parsed;
    for (let attempt = 0; attempt < 2 && parsed === undefined; attempt += 1) {
      try {
        const { text: out, usage, durationMs } = await model.complete(`C survey ${sample.uid} try${attempt}`, SYSTEM_A, user, 2500);
        attempts.push({ usage, durationMs, raw: out });
        const obj = parseJsonObject(out);
        if (typeof obj.scores !== "object" || obj.scores === null) throw new Error("scores 缺失");
        parsed = obj;
      } catch (error) {
        attempts.push({ error: String(error).slice(0, 200) });
        if (String(error).includes("[budget]")) break;
      }
    }
    results[sample.uid] = { uid: sample.uid, inputSha256: sha(SYSTEM_A + user), truncated: text.length > INPUT_CHARS, attempts, ...(parsed !== undefined ? { parsed } : {}) };
    writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`[survey] ${sample.uid} ${parsed !== undefined ? "ok" : "FAILED"} calls=${callsUsed()}`);
  }
} else if (mode === "score") {
  const selection = readJson(selPath);
  const results = readJson(join(OUT, "survey-outputs.json"));
  const rows = [];
  for (const s of selection.selected) {
    for (const dim of DIMS) {
      const ref = s.reference[dim] ?? 0;
      if (ref === 0) continue;
      const v = results[s.uid]?.parsed?.scores?.[dim]?.score;
      rows.push({ uid: s.uid, stratum: s.stratum, dim, ref, pred: [-2, -1, 1, 2].includes(v) ? v : null });
    }
  }
  const metric = (pred) => {
    const scored = rows.filter((r) => pred(r) !== null);
    const neg = scored.filter((r) => r.ref < 0);
    const pos = scored.filter((r) => r.ref > 0);
    const negRecall = neg.length === 0 ? null : neg.filter((r) => pred(r) < 0).length / neg.length;
    const posRecall = pos.length === 0 ? null : pos.filter((r) => pred(r) > 0).length / pos.length;
    return {
      scored: scored.length, refNegative: neg.length, refPositive: pos.length, negRecall, posRecall,
      balancedAccuracy: negRecall === null || posRecall === null ? null : (negRecall + posRecall) / 2,
      signAgreement: bootstrapCi(scored.map((r) => (Math.sign(pred(r)) === Math.sign(r.ref) ? 1 : 0))),
      mae: bootstrapCi(scored.map((r) => Math.abs(pred(r) - r.ref))),
      meanPredicted: scored.reduce((a, r) => a + pred(r), 0) / Math.max(1, scored.length),
      predictedNegativeShare: scored.filter((r) => pred(r) < 0).length / Math.max(1, scored.length),
    };
  };
  const summary = {
    samples: selection.selected.length,
    rows: rows.length,
    referenceMean: rows.reduce((a, r) => a + r.ref, 0) / Math.max(1, rows.length),
    model: metric((r) => r.pred),
    constantMinus1: metric(() => -1),
    constantPlus1: metric(() => 1),
  };
  writeFileSync(join(OUT, "survey-metrics.json"), `${JSON.stringify({ summary, rows }, null, 2)}\n`);
  console.log(JSON.stringify(summary, null, 2));
} else {
  throw new Error("mode: select | run | score");
}
