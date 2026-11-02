#!/usr/bin/env node
/**
 * M16 后续 · 零模型历史回放：对 M16 续期收口 12 篇真实生产运行（冻结工件，只读）的真实 finding 与真实被审 main.tex 执行 verifyFindings，
 * 列出全部证书级矛盾供逐条人工审计（假阳性检查）。这 12 篇已开封：只作开发 / 回归，不是独立验证。
 *
 *   node scripts/m16-verified-findings/replay-historical.mjs <out.json>
 */
import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const REPO = "D:/Projects/PaperTeam";
const BASE = "D:/PaperTeamData/M16/OriginalQualityGateGoalClosure/C/production";
const dist = (p) => pathToFileURL(join(REPO, "backend", "dist", p)).href;
const { verifyFindings } = await import(dist("review/verifiedFindings.js"));
const { findingFingerprint } = await import(dist("review/revisionPlan.js"));
const readJson = (p) => JSON.parse(readFileSync(p, "utf8"));

const out = { generatedAt: new Date().toISOString(), papers: [] };
for (const dir of readdirSync(BASE).sort()) {
  const root = join(BASE, dir);
  const projects = join(root, "projects");
  const project = readdirSync(projects)[0];
  const tex = join(projects, project, "manuscript", "main.tex");
  const gatePath = join(root, "artifacts", "quality-gate-r1.json");
  const auditPath = join(root, "artifacts", "claim-audit-r1.json");
  if (!existsSync(tex) || !existsSync(gatePath)) {
    out.papers.push({ paper: dir, missing: true });
    continue;
  }
  const issues = readJson(gatePath).reviewSummary?.issues ?? [];
  const recordedSource = existsSync(auditPath) ? readJson(auditPath).sourceVerification?.level ?? null : null;
  const files = [{ file: "main.tex", content: readFileSync(tex, "utf8") }];
  // 两个来源口径都跑：记录的真实来源（决定产品状态）+ AUTHOR_SOURCE（只看证书本身会判出什么，用于假阳性审计）
  const asRecorded = verifyFindings({ round: 1, sourceRevision: 1, files, issues, sourceVerification: recordedSource ?? "SOURCE_UNKNOWN", findingFingerprint });
  const contradictions = asRecorded.records.filter((r) => r.checks.some((c) => c.outcome === "CONTRADICTED")).map((r) => ({
    issueIndex: r.issueIndex, status: r.status, severity: r.severityObserved, description: issues[r.issueIndex].description.slice(0, 400), quote: (issues[r.issueIndex].quote ?? "").slice(0, 240), statement: r.statement,
    checks: r.checks.filter((c) => c.outcome === "CONTRADICTED").map((c) => ({ kind: c.kind, raw: c.claim.raw, line: c.claim.line, counterpart: c.counterpart, recompute: c.recompute })),
  }));
  const reasons = {};
  for (const r of asRecorded.records) for (const c of r.checks) if (c.outcome === "NOT_CERTIFIED") for (const reason of c.reasons.slice(0, 1)) { const k = `${c.kind}:${reason.split(":").slice(0, 2).join(":")}`; reasons[k] = (reasons[k] ?? 0) + 1; }
  out.papers.push({
    paper: dir.split("__")[0], recordedSource, summary: asRecorded.summary, contradictions, notCertifiedReasons: reasons,
    dangling: asRecorded.records.filter((r) => r.anchor.danglingReferences.length > 0).map((r) => ({ issueIndex: r.issueIndex, refs: r.anchor.danglingReferences })),
  });
}
writeFileSync(process.argv[2], JSON.stringify(out, null, 1));
for (const p of out.papers) {
  if (p.missing) { console.log(p.paper, "MISSING"); continue; }
  const s = p.summary;
  console.log(`${p.paper} source=${p.recordedSource} findings=${s.findings} located=${s.located} checked=${s.checked} L1=${s.verifiedContradicted} transcript=${s.certifiedOnTranscript} notCert=${s.notCertified} dangling=${s.danglingReferences}`);
  for (const c of p.contradictions) console.log(`   [${c.severity}] #${c.issueIndex} ${c.status}: ${c.statement?.slice(0, 260)}\n      finding: ${c.description.slice(0, 200)}`);
}
