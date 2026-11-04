#!/usr/bin/env node
/**
 * 发表目标验收 · 零模型逐条分析（PROTOCOL.md §4 的程序化部分；类别与「建议核对 vs 断言」由执行代理人工复核后写入报告）。
 * 输出 ROOT\analysis\findings.json + findings.md：每条 finding 的来源、policyDimension、quote 逐字核对、
 * 原文缺失的候选专名 / 年份 / DOI、目标措辞违规、语言（英文稿中文漂移）。
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ROOT, readJson } from "./lib.mjs";

const norm = (s) => s.replace(/\s+/g, " ").trim();
const sources = [];

// W-B 生产 stage：单元 / 整稿 finding 来自 review-summary
const wDir = join(ROOT, "workflow", "2410.21665v1__live__B");
const researchTex = readFileSync(join(ROOT, "workflow", "probe-2410.21665v1__dry__B", "projects", readdirSync(join(ROOT, "workflow", "probe-2410.21665v1__dry__B", "projects"))[0], "manuscript", "main.tex"), "utf8");
if (existsSync(join(wDir, "artifacts", "review-summary-r1.json"))) {
  const summary = readJson(join(wDir, "artifacts", "review-summary-r1.json"));
  for (const issue of summary.issues ?? []) sources.push({ run: "W-B", arm: "B", path: issue.origin === "whole_paper_synthesis" ? "whole" : issue.origin === "cross_chapter" ? "cross" : "unit", issue, text: researchTex, lang: "en" });
}
const surveyText = existsSync(join(ROOT, "ab", "SV-S0__dry", "calls", "01.prompt.txt"))
  ? readFileSync(join(ROOT, "ab", "SV-S0__dry", "calls", "01.prompt.txt"), "utf8").split("===== 论文全文 =====")[1] ?? ""
  : "";
const abDir = join(ROOT, "ab");
for (const d of existsSync(abDir) ? readdirSync(abDir).filter((x) => x.endsWith("__live") || x.endsWith("__live__retry1")) : []) {
  const r = readJson(join(abDir, d, "result.json"));
  if (r.status !== "completed") continue;
  const survey = r.kind === "survey-whole";
  for (const issue of r.response.issues ?? []) sources.push({ run: r.callId, arm: r.legacy ? "legacy" : r.arm, path: r.kind === "unit" ? "unit" : "whole", issue, text: survey ? surveyText : researchTex, lang: survey ? "zh" : "en" });
}

const TARGET_WORDS = /(达到|未达到|满足|符合)[^。；]{0,8}(分区|一区|二区|三区|四区|Q[1-4]|核心)|录用|接收概率|accept(ance|ed)? (probability|chance)|reach(es)? (the )?(tier|Q[1-4]|CAS)|score threshold|分数线|meets? (the )?(standard|bar) of/i;
const CLAIM_SEARCHED = /(已检索|检索结果显示|we (searched|verified)|has been verified|已核实|已证实|confirmed by (search|literature))/i;

const rows = sources.map((s, i) => {
  const { issue } = s;
  const all = [issue.description, issue.reason, issue.suggestedAction].filter(Boolean).join(" ");
  const quote = issue.quote ?? "";
  const quoteFound = quote === "" ? null : norm(s.text).includes(norm(quote));
  const lower = norm(s.text).toLowerCase();
  // 候选专名：CamelCase / 全大写缩写 / 「X et al.」/ 年份 / DOI —— 原文中不存在者
  const cand = new Set([
    ...(all.match(/\b[A-Z][a-zA-Z]*[A-Z][a-zA-Z0-9-]*\b/g) ?? []),
    ...(all.match(/\b[A-Z]{2,}[0-9-]*\b/g) ?? []),
    ...(all.match(/\b[A-Z][a-z]+ et al\.?/g) ?? []),
    ...(all.match(/\b(19|20)\d{2}\b/g) ?? []),
    ...(all.match(/10\.\d{4,9}\/\S+/g) ?? []),
  ]);
  const absent = [...cand].filter((c) => !lower.includes(c.toLowerCase().replace(/ et al\.?$/, "")));
  const zhChars = (all.match(/[一-鿿]/g) ?? []).length;
  return {
    i: i + 1, run: s.run, arm: s.arm, path: s.path, severity: issue.severity, section: issue.section ?? null,
    policyDimension: issue.policyDimension ?? null, verification: issue.verification ?? null, blocking: issue.blocking ?? null,
    description: issue.description, reason: issue.reason ?? null, suggestedAction: issue.suggestedAction ?? null, quote,
    quoteFound, absentNames: absent, targetWording: TARGET_WORDS.test(all), claimsSearched: CLAIM_SEARCHED.test(all),
    langDrift: s.lang === "en" && zhChars > 10,
  };
});
await mkdir(join(ROOT, "analysis"), { recursive: true });
await writeFile(join(ROOT, "analysis", "findings.json"), JSON.stringify(rows, null, 1), "utf8");
const md = rows.map((r) => `### #${r.i} ${r.run} · ${r.arm} · ${r.path} · ${r.severity} · dim=${r.policyDimension ?? "-"}\n- section: ${r.section}\n- description: ${r.description}\n- suggestedAction: ${r.suggestedAction}\n- quote(${r.quoteFound === null ? "none" : r.quoteFound ? "FOUND" : "NOT_FOUND"}): ${r.quote}\n- absentNames: ${r.absentNames.join(", ") || "-"} · targetWording=${r.targetWording} · claimsSearched=${r.claimsSearched} · langDrift=${r.langDrift}\n`).join("\n");
await writeFile(join(ROOT, "analysis", "findings.md"), md, "utf8");
const by = {};
for (const r of rows) { const k = `${r.run}/${r.path}`; by[k] = by[k] ?? { n: 0, major: 0, quoteNotFound: 0, absentNames: 0, targetWording: 0, claimsSearched: 0, langDrift: 0 }; const b = by[k]; b.n++; if (r.severity === "major") b.major++; if (r.quoteFound === false) b.quoteNotFound++; if (r.absentNames.length) b.absentNames++; if (r.targetWording) b.targetWording++; if (r.claimsSearched) b.claimsSearched++; if (r.langDrift) b.langDrift++; }
console.log(JSON.stringify(by, null, 1));
