#!/usr/bin/env node
/**
 * M16 收口 · A：输入保真零模型回放（不调用任何模型）。
 *
 *   node scripts/m16-closure/a-fidelity-replay.mjs
 *
 * 1) 适配器层：本地全部 CoCoReview MD（M15 D2 12 篇 + M16 封存 8 篇），旧 md_to_tex.mjs 与新 md-to-tex-fidelity.mjs 输出
 *    分别与源 MD 做 compareFidelity（数学逐字保留、转义残留、正文数字、[n] 引用标记、标题）。
 * 2) Reviewer 输入层：production.mjs --mode dry 保存的 Reviewer 单元 prompt（真实 review.run 链路，scripted runtime）拼接后
 *    同样与源 MD 比较，并取 review-coverage 产物的单元数 / 覆盖率——证明「Reviewer 实际读到的原文」是否保真。
 * 3) M16 首轮生产 live 运行保存的 prompt（旧适配器）作为历史失败证据，同口径比较。
 * 输出：<ROOT>\A\a-fidelity-replay.json
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { M15, M16, ROOT, sha } from "./lib.mjs";
import { LEGACY_ADAPTER, compareFidelity, markdownToLatexFidelity } from "./md-to-tex-fidelity.mjs";

const legacy = await import(pathToFileURL(LEGACY_ADAPTER.path).href);
const legacyConvert = (md) => {
  let seen = false;
  return legacy.markdownToLatex(md.replace(/^# (?=\S)/gm, (m) => (seen ? "## " : ((seen = true), m))), "en");
};
const mdFiles = [
  ...readdirSync(join(M16, "external", "cocoreviewbench-md")).filter((f) => f.endsWith(".md")).map((f) => join(M16, "external", "cocoreviewbench-md", f)),
  ...readdirSync(join(M15, "external", "cocoreviewbench-2580687", "MD")).filter((f) => f.endsWith(".md")).map((f) => join(M15, "external", "cocoreviewbench-2580687", "MD", f)),
];
const brief = (c) => ({
  math: `${c.math.preserved}/${c.math.total}`,
  escapedMathResidue: c.escapedMathResidue,
  numbers: `${c.numbers.preserved}/${c.numbers.total}`,
  citeMarkers: `${c.citeMarkers.preserved}/${c.citeMarkers.total}`,
  headings: `${c.headings.preserved}/${c.headings.total}`,
});
const adapterLevel = mdFiles.map((file) => {
  const md = readFileSync(file, "utf8");
  const { tex, report } = markdownToLatexFidelity(md, "en");
  const old = legacyConvert(md);
  return {
    file: file.split("\\").pop(),
    mdSha256: sha(md),
    legacy: { texSha256: sha(old), ...brief(compareFidelity(md, old)), subsections: (old.match(/\\subsection\*/g) ?? []).length },
    fidelity: { texSha256: sha(tex), ...brief(compareFidelity(md, tex)), subsections: (tex.match(/\\subsection\*/g) ?? []).length, sourceNotes: report.notes, suspectMath: report.math.filter((m) => m.suspects.length > 0).map((m) => ({ suspects: m.suspects, raw: m.raw.slice(0, 120) })) },
  };
});

function reviewerInput(dir) {
  const calls = readdirSync(join(dir, "calls")).filter((f) => f.endsWith(".prompt.txt")).sort();
  const unitTexts = [];
  for (const f of calls) {
    const p = readFileSync(join(dir, "calls", f), "utf8");
    const m = /===== 单元原文[^\n]*=====\n([\s\S]*?)(?:\n=====|$)/.exec(p);
    if (m) unitTexts.push(m[1]);
  }
  const coveragePath = join(dir, "artifacts", "review-coverage-r1.json");
  const coverage = existsSync(coveragePath) ? JSON.parse(readFileSync(coveragePath, "utf8")) : null;
  return { prompts: calls.length, unitPrompts: unitTexts.length, joined: unitTexts.join("\n\n"), coverage };
}
const CASES = [
  { id: "X7eAhXcps1", md: join(M16, "external", "cocoreviewbench-md", "ICLR2025_2406.11929v2.md") },
  { id: "w5h443GIGo", md: join(M16, "external", "cocoreviewbench-md", "ICLR2025_w5h443GIGo.md") },
];
const reviewerLevel = [];
for (const c of CASES) {
  const md = readFileSync(c.md, "utf8");
  for (const [label, dir] of [
    ["m16-live-legacy (historical)", join(M16, "C", "production", c.id)],
    ["dry-legacy", join(ROOT, "A", "production", `${c.id}__dry__legacy`)],
    ["dry-fidelity", join(ROOT, "A", "production", `${c.id}__dry__fidelity`)],
  ]) {
    if (!existsSync(join(dir, "calls"))) continue;
    const r = reviewerInput(dir);
    const cov = r.coverage;
    reviewerLevel.push({
      case: c.id,
      run: label,
      unitPrompts: r.unitPrompts,
      coverage: cov === null ? null : { units: cov.targetUnits, completed: cov.completedUnits, failed: cov.failedUnits, ratio: cov.ratio, reviewedChars: cov.reviewedChars ?? null, targetChars: cov.targetChars ?? null },
      ...brief(compareFidelity(md, r.joined)),
      bodyOnly: brief(compareFidelity(md, r.joined, { bodyOnly: true })),
    });
  }
}
const out = { schema: "m16-closure-a-fidelity-replay/v1", generatedAt: new Date().toISOString(), legacyAdapter: LEGACY_ADAPTER, adapterLevel, reviewerLevel };
writeFileSync(join(ROOT, "A", "a-fidelity-replay.json"), `${JSON.stringify(out, null, 1)}\n`);
for (const a of adapterLevel) console.log(a.file.padEnd(32), "legacy", a.legacy.math, "res", a.legacy.escapedMathResidue, "| fidelity", a.fidelity.math, "res", a.fidelity.escapedMathResidue, "num", a.fidelity.numbers, "cite", a.fidelity.citeMarkers, "head", a.fidelity.headings, "subsec", a.legacy.subsections, "→", a.fidelity.subsections, JSON.stringify(a.fidelity.sourceNotes));
for (const r of reviewerLevel) console.log(r.case, r.run.padEnd(30), "units", r.unitPrompts, "math", r.math, "res", r.escapedMathResidue, "num", r.numbers, "cite", r.citeMarkers, "| body num", r.bodyOnly.numbers, "cite", r.bodyOnly.citeMarkers, "head", r.bodyOnly.headings, "cov", JSON.stringify(r.coverage));
