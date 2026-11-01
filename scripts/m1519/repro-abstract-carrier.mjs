#!/usr/bin/env node
/**
 * M15.19 Deviation D1 复现（零模型）：用真实 E1 项目的可编辑稿 + 审计工件，在当前 dist 上重放计划期锚投影，
 * 并检查 reassess 对虚拟摘要目标（outline.abstract）的当前内容可读性。
 *
 * 用法：node scripts/m1519/repro-abstract-carrier.mjs --project-dir <e2e-stack/p-...> [--out <json>]
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : fallback;
};
const PROJECT_DIR = arg("project-dir");
const OUT = arg("out");
if (PROJECT_DIR === undefined) throw new Error("--project-dir 必填");
const dist = (...parts) => pathToFileURL(join(import.meta.dirname, "..", "..", "backend", "dist", ...parts)).href;
const { projectQuoteToManuscript } = await import(dist("target", "TargetAuditRevisionService.js"));

const manuscript = join(PROJECT_DIR, "manuscript");
const files = [];
for (const name of (await readdir(join(manuscript, "sections"))).sort()) {
  files.push({ relativePath: `sections/${name}`, content: await readFile(join(manuscript, "sections", name), "utf8") });
}
const outline = JSON.parse(await readFile(join(manuscript, "outline.json"), "utf8"));
files.push({ relativePath: "abstract", content: outline.abstract ?? "" });
const audit = JSON.parse(await readFile(join(PROJECT_DIR, "research", "target-contribution-audit.json"), "utf8"));
const results = audit.gapPlan
  .filter((gap) => gap.targetQuote !== undefined)
  .map((gap) => {
    const containing = files.filter((file) => projectQuoteToManuscript(gap.targetQuote, [file]).status === "resolved").map((file) => file.relativePath);
    return {
      subGapId: gap.subGapId,
      gapKind: gap.gapKind,
      targetQuote: gap.targetQuote.slice(0, 120),
      containedIn: containing,
      projection: projectQuoteToManuscript(gap.targetQuote, files, "sections/sec01.tex"),
    };
  });
let abstractFileReadable = true;
try {
  await readFile(join(manuscript, "abstract"), "utf8");
} catch {
  abstractFileReadable = false;
}
const summary = { project: PROJECT_DIR, results, reassessReadsAbstractAsFile: { path: "manuscript/abstract", readable: abstractFileReadable } };
console.log(JSON.stringify(summary, null, 1));
if (OUT !== undefined) await writeFile(OUT, JSON.stringify(summary, null, 1), "utf8");
