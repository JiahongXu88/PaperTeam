#!/usr/bin/env node
/**
 * M15 TJA · G5 零模型变异族检验：M15.9 冻结的 CJIG 变异稿 × 新评估器（只读，不写源目录）。
 * 预期（变异登记来自 M15.9 phase-c，本脚本只按项目名映射，不调阈值）：
 *   b1c（合规对照）→ 无参考文献 / 题目 / 摘要类 VIOLATED；f1 题目 22 字 → cjig-title-zh-20 VIOLATED；
 *   f2 关键词 3 个 → cjig-keywords-5-8 VIOLATED；f3 陈旧文献 → cjig-refs-recent-60 VIOLATED；
 *   f4 非结构化摘要 → cjig-abstract-structured VIOLATED；f5 文献 12 条 → cjig-refs-15 VIOLATED。
 * 用法：node scripts/m15-tja/g5-mutation-families.mjs <eval-projects-root> <out.json>
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

const REPO = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..");
const dist = (...p) => pathToFileURL(join(REPO, "backend", "dist", ...p)).href;
const { ProjectStore } = await import(dist("project", "ProjectStore.js"));
const { BUILTIN_JOURNAL_PROFILES } = await import(dist("target", "journal", "profileRegistry.js"));
const { evaluateProfileRules } = await import(dist("target", "journal", "criteria.js"));
const { observeJournalFacts } = await import(dist("target", "journal", "journalFacts.js"));

const [root, out] = process.argv.slice(2);
const ids = JSON.parse(readFileSync(join(root, "m159-project-ids.json"), "utf8"));
const cjig = BUILTIN_JOURNAL_PROFILES.find((p) => p.journalId === "cjig");
const store = new ProjectStore({ root });
const expected = {
  "b1c#cjig": null,
  "b1c-f1-title22#cjig": "cjig-title-zh-20",
  "b1c-f2-kw3#cjig": "cjig-keywords-5-8",
  "b1c-f3-stale-refs#cjig": "cjig-refs-recent-60",
  "b1c-f4-unstructured-abs#cjig": "cjig-abstract-structured",
  "b1c-f5-refs12#cjig": "cjig-refs-15",
};
const now = new Date("2026-11-02T00:00:00Z");
const rows = [];
for (const [name, expectRule] of Object.entries(expected)) {
  const facts = await observeJournalFacts(store, ids[name], { evalYear: 2026 });
  const criteria = evaluateProfileRules(cjig, facts, "survey", null, now);
  const violated = criteria.filter((c) => c.status === "VIOLATED").map((c) => c.ruleId);
  // 合规对照与各变异稿共同的「中图分类号」缺失不属于变异本身（底稿即缺），单列
  const mutationViolations = violated.filter((id) => id !== "cjig-frontmatter-clc");
  rows.push({
    name,
    projectId: ids[name],
    expectRule,
    violated,
    detected: expectRule === null ? mutationViolations.length === 0 : mutationViolations.includes(expectRule),
    extraViolations: mutationViolations.filter((id) => id !== expectRule),
  });
}
const result = { generatedAt: new Date().toISOString(), profile: cjig.rulesVersion, rows, allDetected: rows.every((r) => r.detected), falseExtra: rows.reduce((a, r) => a + r.extraViolations.length, 0) };
writeFileSync(out, `${JSON.stringify(result, null, 2)}\n`);
console.log(JSON.stringify(rows.map((r) => [r.name, r.detected, r.violated.join(",")]), null, 1), "allDetected", result.allDetected, "extra", result.falseExtra);
