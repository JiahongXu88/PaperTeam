#!/usr/bin/env node
/**
 * M16 后续 · 零模型开发回放（已开封 12 篇，只作开发 / 回归）：用 md-to-tex v2 重新转写原 MD，把真实生产 finding 放到 v2 文本上做证书核验，
 * 观察「输入表格保真」后哪些 finding 可出证书（来源仍是转写 → 产品状态最多 CERTIFIED_ON_TRANSCRIPT）。
 * finding 引文若在 v2 文本中找不到（表格格式变化）则如实为 QUOTE_NOT_LOCATED。
 *
 *   node scripts/m16-verified-findings/replay-v2.mjs <out.json>
 */
import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

import { markdownToLatexFidelity } from "./md-to-tex-v2.mjs";

const REPO = "D:/Projects/PaperTeam";
const PREV = "D:/PaperTeamData/M16/OriginalQualityGateGoalClosure";
const dist = (p) => pathToFileURL(join(REPO, "backend", "dist", p)).href;
const { verifyFindings } = await import(dist("review/verifiedFindings.js"));
const { findingFingerprint } = await import(dist("review/revisionPlan.js"));
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));
const selection = readJson(join(PREV, "B", "heldout-selection.json")).selected;

const out = [];
for (const paper of selection) {
  const dir = readdirSync(join(PREV, "C", "production")).find((d) => d.startsWith(paper.id));
  const issues = readJson(join(PREV, "C", "production", dir, "artifacts", "quality-gate-r1.json")).reviewSummary?.issues ?? [];
  const md = readFileSync(join(PREV, "external", "cocoreviewbench-md", paper.mdPath.replace(/^benchmark\/MD\//, "")), "utf8");
  const { tex, report } = markdownToLatexFidelity(md, "en");
  const artifact = verifyFindings({ round: 1, sourceRevision: 1, files: [{ file: "main.tex", content: tex }], issues, sourceVerification: "SOURCE_UNVERIFIED", findingFingerprint });
  const hits = artifact.records.filter((r) => r.checks.some((c) => c.outcome === "CONTRADICTED"));
  out.push({ paper: paper.id, notes: report.notes, summary: artifact.summary, hits: hits.map((r) => ({ issueIndex: r.issueIndex, severity: r.severityObserved, status: r.status, statement: r.statement, description: issues[r.issueIndex].description.slice(0, 300) })) });
  console.log(`${paper.id} captions=${report.notes.TABLE_CAPTIONS_ATTACHED ? "attached" : report.notes.TABLE_CAPTIONS_SKIPPED ? "skipped" : "-"} spans=${report.notes.TABLE_SPANS_RESTORED ?? 0} located=${artifact.summary.located}/${artifact.summary.findings} checked=${artifact.summary.checked} transcriptCert=${artifact.summary.certifiedOnTranscript}`);
  for (const h of out.at(-1).hits) console.log(`   #${h.issueIndex} [${h.severity}] ${h.statement.slice(0, 300)}\n      finding: ${h.description.slice(0, 220)}`);
}
writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
