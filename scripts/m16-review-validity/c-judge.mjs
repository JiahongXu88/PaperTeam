#!/usr/bin/env node
/**
 * M16 · C：盲评裁判（AI_JUDGED_AUXILIARY——同模型族 GLM，非人工标签；只做「AI 意见 ↔ 真实人类审稿意见」的同一问题匹配）。
 *
 *   node scripts/m16-review-validity/c-judge.mjs dev          # DEV_OPENED：M15 D2 前 2 篇（臂 A / B 原输出 + G0），校验裁判可用性
 *   node scripts/m16-review-validity/c-judge.mjs sealed       # 封存集：每篇 1 次（Atrunc / Afull / Bfull / G0 匿名乱序）
 *   node scripts/m16-review-validity/c-judge.mjs production   # 封存集生产臂 2 篇：每篇 1 次（生产全部 findings）
 *
 * 盲化：清单以 L1..Lk 匿名、按 sha256(paper|salt) 确定性乱序；条目只给文字（不给类别码 / 严重度 / 臂名）。
 * 人类参考 = CoCoReviewBench 正确性过滤后的弱点原子意见（不完备：AI 条目未匹配 ≠ 错误）。
 */
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { GENERIC_CONTROL, M15, ROOT, callsUsed, createModel, humanWeaknesses, loadCocoRecords, parseJsonObject, productionFindings, readJson } from "./lib.mjs";


const SYSTEM =
  "You are an impartial meta-reviewer auditing AI-generated paper reviews against real human peer-review criticisms of the same paper. " +
  "You get (1) numbered reference criticisms H1..Hn written by human reviewers and (2) several anonymous lists of AI review items with ids like L2-5. " +
  "For EACH AI item, list every reference criticism that raises THE SAME specific issue: the same object in the paper (method component, experiment, claim, dataset, baseline, section, figure, etc.) AND the same concern. " +
  "Same broad topic is not enough: an item such as 'more baselines are needed' matches 'missing comparison with method X' only if the item names X or the same specific gap. " +
  "A generic item can match only a reference that is equally generic about the same aspect. Do not reward length or eloquence. " +
  "Output only one JSON object: {\"matches\": {\"<itemId>\": [\"H3\", ...], ...}} containing every AI item id (empty array when nothing matches).";

const clip = (s, n) => (String(s).length > n ? `${String(s).slice(0, n)}…` : String(s));
const sha = (s) => createHash("sha256").update(s).digest("hex");

function buildUser(human, lists) {
  const h = human.map((o, i) => `H${i + 1}: ${clip(o.text, 600)}`).join("\n");
  const l = lists.map((list) => `List ${list.label}:\n${list.items.map((it, i) => `${list.label}-${i + 1}: ${clip(it, 450)}`).join("\n")}`).join("\n\n");
  return `Reference criticisms (human reviewers):\n${h}\n\nAI review lists:\n\n${l}`;
}

/** 匿名乱序：返回 [{label, arm, items}]，label 与 arm 的映射只存在于输出文件 */
function blind(paperId, armLists, salt) {
  const order = Object.keys(armLists).sort((a, b) => sha(`${paperId}|${salt}|${a}`).localeCompare(sha(`${paperId}|${salt}|${b}`)));
  return order.map((arm, i) => ({ label: `L${i + 1}`, arm, items: armLists[arm] }));
}

async function judge(model, purpose, human, lists, maxTokens) {
  const user = buildUser(human, lists);
  const attempts = [];
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      const { text, usage, durationMs } = await model.complete(`${purpose} try${attempt}`, SYSTEM, user, maxTokens);
      attempts.push({ usage, durationMs, raw: text });
      const obj = parseJsonObject(text);
      if (typeof obj.matches !== "object" || obj.matches === null) throw new Error("matches 缺失");
      return { attempts, matches: obj.matches, inputSha256: sha(SYSTEM + user) };
    } catch (error) {
      attempts.push({ error: String(error).slice(0, 200) });
      if (String(error).includes("[budget]")) break;
    }
  }
  return { attempts, matches: null };
}


const mode = process.argv[2];
const OUT = join(ROOT, "C");
mkdirSync(OUT, { recursive: true });
const outPath = join(OUT, `judge-${mode}.json`);
const results = existsSync(outPath) ? readJson(outPath) : {};
const model = await createModel();

if (mode === "dev") {
  const sel = readJson(join(M15, "D2", "selection.json")).selected.slice(0, 2);
  const outputs = readJson(join(M15, "D2", "outputs.json"));
  const records = loadCocoRecords(sel.map((p) => p.id));
  for (const paper of sel) {
    if (results[paper.id]?.matches) continue;
    const human = humanWeaknesses(records.get(paper.id));
    const armLists = { A: outputs[`${paper.id}|A`].parsed.weaknesses.map((w) => w.point), B: outputs[`${paper.id}|B`].parsed.weaknesses.map((w) => w.point), G0: GENERIC_CONTROL };
    const lists = blind(paper.id, armLists, "dev");
    const r = await judge(model, `judge dev ${paper.id}`, human, lists, 5000);
    results[paper.id] = { humanCount: human.length, lists: lists.map(({ label, arm, items }) => ({ label, arm, n: items.length })), ...r };
    writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`[judge-dev] ${paper.id} ${r.matches ? "ok" : "FAILED"} calls=${callsUsed()}`);
  }
} else if (mode === "sealed") {
  const sel = readJson(join(ROOT, "B", "sealed-selection.json")).selected;
  const single = readJson(join(OUT, "single-pass.json"));
  const records = loadCocoRecords(sel.map((p) => p.id));
  for (const paper of sel) {
    if (results[paper.id]?.matches) continue;
    const human = humanWeaknesses(records.get(paper.id));
    const armLists = { G0: GENERIC_CONTROL };
    for (const arm of ["Atrunc", "Afull", "Bfull"]) {
      const parsed = single[`${paper.id}|${arm}`]?.parsed;
      if (parsed !== undefined) armLists[arm] = parsed.weaknesses.map((w) => w.point);
    }
    const lists = blind(paper.id, armLists, "sealed");
    const r = await judge(model, `judge sealed ${paper.id}`, human, lists, 6000);
    results[paper.id] = { humanCount: human.length, lists: lists.map(({ label, arm, items }) => ({ label, arm, n: items.length })), ...r };
    writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`[judge-sealed] ${paper.id} ${r.matches ? "ok" : "FAILED"} calls=${callsUsed()}`);
  }
} else if (mode === "production") {
  const sel = readJson(join(ROOT, "B", "sealed-selection.json")).selected.filter((p) => p.productionArm);
  const records = loadCocoRecords(sel.map((p) => p.id));
  for (const paper of sel) {
    if (results[paper.id]?.matches) continue;
    if (!existsSync(join(ROOT, "C", "production", paper.id, "artifacts", "review-summary-r1.json"))) {
      console.log(`[judge-production] ${paper.id} 无生产产物，NOT_RUN`);
      continue;
    }
    const human = humanWeaknesses(records.get(paper.id));
    const findings = productionFindings(paper.id);
    const lists = [{ label: "L1", arm: "P", items: findings.map((f) => f.text) }];
    const r = await judge(model, `judge production ${paper.id}`, human, lists, 8000);
    results[paper.id] = { humanCount: human.length, lists: lists.map(({ label, arm, items }) => ({ label, arm, n: items.length })), findingOrder: findings.map((f) => f.index), ...r };
    writeFileSync(outPath, `${JSON.stringify(results, null, 2)}\n`);
    console.log(`[judge-production] ${paper.id} findings=${findings.length} ${r.matches ? "ok" : "FAILED"} calls=${callsUsed()}`);
  }
} else {
  throw new Error("mode: dev | sealed | production");
}
