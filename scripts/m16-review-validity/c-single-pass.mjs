#!/usr/bin/env node
/**
 * M16 · C：单次 LLM 臂（封存集；PROTOCOL §5 冻结后只跑一次，断点续跑不重跑已成功的 case-arm）。
 *
 *   node scripts/m16-review-validity/c-single-pass.mjs run [--set sealed|dev]
 *
 * 臂（同模型、同 taxonomy、Prompt 与 M15 TJA D2 逐字相同，只改输入窗口）：
 *   Atrunc  M15 D2 臂 A 原样：全文前 40,000 字符（复现 D2 条件）
 *   Afull   臂 A Prompt + 全文（INPUT_FIDELITY 假设）
 *   Bfull   M15 D2 臂 B（证据纪律）Prompt + 全文（证据约束是否损害召回）
 * 产物：<ROOT>/C/single-pass.json（原始输出 + usage + 输入哈希）。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { M15, ROOT, callsUsed, createModel, parseJsonObject, readJson } from "./lib.mjs";

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
const TRUNC = 40_000;
const ARMS = [
  ["Atrunc", SYSTEM_A, TRUNC],
  ["Afull", SYSTEM_A, Infinity],
  ["Bfull", SYSTEM_B, Infinity],
];

const sha = (s) => createHash("sha256").update(s).digest("hex");
const taxonomy = readJson(join(M15, "external", "cocoreviewbench-2580687", "taxonomy.json")).map((t) => `${t.code}: ${t.gloss}`).join("\n");
const mdDir = join(ROOT, "external", "cocoreviewbench-md");
const paperText = (mdPath) => readFileSync(join(mdDir, mdPath.replace(/^benchmark\/MD\//, "")), "utf8");

const OUT = join(ROOT, "C");
mkdirSync(OUT, { recursive: true });
if (process.argv[2] !== "run") throw new Error("mode: run");
const selection = readJson(join(ROOT, "B", "sealed-selection.json"));
const resultsPath = join(OUT, "single-pass.json");
const results = existsSync(resultsPath) ? readJson(resultsPath) : {};
const model = await createModel();
for (const paper of selection.selected) {
  const md = paperText(paper.mdPath);
  for (const [arm, system, limit] of ARMS) {
    const key = `${paper.id}|${arm}`;
    if (results[key]?.parsed !== undefined) continue;
    const input = md.slice(0, limit);
    const truncated = md.length > input.length;
    const user = `Category taxonomy:\n${taxonomy}\n\nPaper (markdown, ${truncated ? `first ${TRUNC} characters, truncated from ${md.length}` : `full text, ${md.length} characters`}):\n\n${input}`;
    const attempts = [];
    let parsed;
    for (let attempt = 0; attempt < 2 && parsed === undefined; attempt += 1) {
      try {
        const { text, usage, durationMs } = await model.complete(`C single ${arm} ${paper.id} try${attempt}`, system, user, 4000);
        attempts.push({ usage, durationMs, chars: text.length, raw: text });
        const obj = parseJsonObject(text);
        if (!Array.isArray(obj.weaknesses)) throw new Error("weaknesses 不是数组");
        parsed = obj;
      } catch (error) {
        attempts.push({ error: String(error).slice(0, 200) });
        if (String(error).includes("[budget]")) break;
      }
    }
    results[key] = { arm, paperId: paper.id, model: model.spec, inputChars: input.length, inputSha256: sha(system + user), truncated, attempts, ...(parsed !== undefined ? { parsed } : {}) };
    writeFileSync(resultsPath, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`[single] ${key} ${parsed !== undefined ? `items=${parsed.weaknesses.length}` : "FAILED"} calls=${callsUsed()}`);
  }
}
