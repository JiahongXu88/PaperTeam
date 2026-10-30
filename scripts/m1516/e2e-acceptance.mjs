#!/usr/bin/env node
/**
 * M15.16 Phase D — 真实用户路径验收驱动（真实 backend + 真实模型 + 真实 HTTP）。
 *
 * 前置：backend 以 PAPERTEAM_TARGET_EVIDENCE_AUDIT_ENABLED=true 启动（脚本只消费 HTTP，
 * 不注入前端/不绕过服务）。产物落 D:\PaperTeamData\M15\M15_16\e2e\（脱敏摘要 + 原始工件引用）。
 *
 * 场景（任务书 Phase D 验收门）：
 *   A. case-R（CJIG 中文 PDF）项目：导入 → CJIG 指南 → PDF-only 合规机检（P0-B）
 *      → 在库 DBNet 全文（role=reference）→ 证据审计（P0-A，真实模型）
 *      → GET 陈旧判定（换稿后 stale=true）
 *   B. CEA 同稿差分：换 CEA 官方指南 → 合规差分（不得复制 CJIG 结论）
 *   C. b1（英文综述稿）survey 项目：证据审计 → 综述语义（不得因缺原创实验而错误阻断）
 *
 * 用法：node scripts/m1516/e2e-acceptance.mjs [--base http://127.0.0.1:3116]
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = "D:\\PaperTeamData\\M15\\M15_16";
const OUT = join(ROOT, "e2e");
const M159_GUIDELINES = "D:\\PaperTeamData\\M15\\M15_9\\phase-c\\guideline-artifacts";
const SAMPLES = "D:\\PaperTeamData\\M15\\M15_15\\phase-b\\samples";
const M1515_PRIORS = "D:\\PaperTeamData\\M15\\M15_15\\phase-c\\priors";

const baseArg = process.argv.includes("--base") ? process.argv[process.argv.indexOf("--base") + 1] : "http://127.0.0.1:3116";
const BASE = baseArg.replace(/\/$/, "");

const log = (...args) => console.log("[e2e]", ...args);

async function api(method, path, body) {
  const response = await fetch(`${BASE}${path}`, {
    method,
    ...(body !== undefined ? { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) } : {}),
  });
  const text = await response.text();
  let parsed = null;
  try { parsed = JSON.parse(text); } catch { parsed = { raw: text.slice(0, 400) }; }
  return { status: response.status, body: parsed };
}

async function uploadJson(method, path, pdfPath, extra = {}) {
  const content = await readFile(pdfPath);
  return api(method, path, {
    fileName: pdfPath.split(/[\\/]/).pop(),
    contentBase64: content.toString("base64"),
    ...extra,
  });
}

const summary = { base: BASE, startedAt: new Date().toISOString(), steps: [] };
const step = (name, data) => { summary.steps.push({ name, at: new Date().toISOString(), ...data }); log(name, JSON.stringify(data).slice(0, 300)); };

// ---------- A. case-R × CJIG ----------
const caseR = join(SAMPLES, "case-R.pdf");
const created = await uploadJson("POST", "/api/projects/import-paper", caseR, {
  format: "pdf",
  title: "M15.16 E2E case-R（CJIG）",
  researchField: "scene text detection",
  documentType: "journal_article",
  targetVenue: "中国图象图形学报",
  workflowKind: "existing_paper_review",
});
if (created.status !== 201) throw new Error(`import case-R failed: ${created.status} ${JSON.stringify(created.body).slice(0, 300)}`);
const projectId = created.body.project.id;
step("A1 import case-R", { projectId, titleSource: created.body.titleSource, documentTitle: created.body.report?.documentTitle ?? null });

const cjig = JSON.parse(await readFile(join(M159_GUIDELINES, "cjig.json"), "utf8"));
const putGuideline = await api("PUT", `/api/projects/${projectId}/target/guideline`, { guideline: cjig });
if (putGuideline.status !== 200) throw new Error(`PUT guideline failed: ${putGuideline.status}`);
step("A2 freeze CJIG guideline", { venueId: putGuideline.body.guideline.venueId, requirements: putGuideline.body.guideline.requirements.length });

const complianceCjig = await api("POST", `/api/projects/${projectId}/target/guideline/compliance`);
if (complianceCjig.status !== 200) throw new Error(`compliance failed: ${complianceCjig.status}`);
const cjigChecks = complianceCjig.body.compliance.checks.map((c) => ({ field: c.field, status: c.status, observed: c.observed.slice(0, 160), reason: c.reason ?? null }));
step("A3 CJIG compliance（PDF-only 机检）", {
  topStatus: complianceCjig.body.compliance.summary.topStatus,
  pass: complianceCjig.body.compliance.summary.passCount,
  notEvaluated: complianceCjig.body.compliance.summary.notEvaluatedCount,
  hardViolations: complianceCjig.body.compliance.summary.hardViolations,
  checks: cjigChecks,
});

// 在库 DBNet 全文（role=reference；合法获取的 arXiv PDF）→ 通道 C verified_fulltext
const dbnet = join(M1515_PRIORS, "arxiv-1911.08947.pdf");
const sourceUp = await uploadJson("POST", `/api/projects/${projectId}/sources`, dbnet, {
  sourceRole: "reference",
  title: "Real-time scene text detection with differentiable binarization",
  year: 2020,
  doi: "10.1609/aaai.v34i07.6812",
});
if (sourceUp.status !== 201 && sourceUp.status !== 200) throw new Error(`source upload failed: ${sourceUp.status}`);
const sourceId = sourceUp.body.source.sourceId;
const rebuild = await api("POST", `/api/projects/${projectId}/retrieval/rebuild`, { sourceId });
step("A4 DBNet 入库（role=reference）+ chunk 重建", { sourceId, rebuild: rebuild.body.outcome ?? rebuild.body });

log("A5 证据审计（真实模型，3+ 次调用；可能需要 1-3 分钟）…");
const auditStarted = Date.now();
const audit = await api("POST", `/api/projects/${projectId}/target/evidence-audit`);
if (audit.status !== 200) throw new Error(`evidence-audit failed: ${audit.status} ${JSON.stringify(audit.body).slice(0, 400)}`);
const a = audit.body.audit;
step("A5 证据审计（case-R × CJIG）", {
  evaluatedAt: a.artifact.evaluatedAt,
  venueId: a.artifact.venueId ?? null,
  poolSize: a.artifact.priorWork.poolSize,
  contentLevels: a.meta.poolBuild.contentLevels,
  refResolved: `${a.meta.poolBuild.refResolved}/${a.meta.poolBuild.referenceEntriesEligible}`,
  libraryUpgraded: a.meta.poolBuild.libraryUpgraded,
  modelCalls: a.meta.telemetry.calls,
  totalMs: a.meta.telemetry.totalMs,
  guards: a.artifact.guards,
  inventory: a.artifact.inventory.map((c) => ({ id: c.contributionId, quote: c.claimQuote.slice(0, 90), anchor: c.anchorVerified, support: c.supportStatus })),
  comparisons: a.artifact.comparisons.map((c) => ({
    id: c.contributionId,
    status: c.status,
    basis: c.differenceBasis,
    priors: c.nearestPriorWorks.map((p) => ({ title: p.title.slice(0, 60), level: p.sourceLevel, resolves: p.resolvesToPool, quoteVerified: p.priorQuoteVerified ?? null })),
  })),
  gapPlan: a.artifact.gapPlan.map((g) => ({ id: g.contributionId, action: g.actionType, status: g.status, gap: g.gap.slice(0, 100) })),
});

const fresh = await api("GET", `/api/projects/${projectId}/target/evidence-audit`);
step("A6 GET 审计（fresh）", { enabled: fresh.body.enabled, stale: fresh.body.audit?.stale ?? null });

// ---------- B. CEA 同稿差分（换官方指南 → 合规差分；不动审计工件） ----------
const cea = JSON.parse(await readFile(join(M159_GUIDELINES, "cea.json"), "utf8"));
await api("PUT", `/api/projects/${projectId}/target/guideline`, { guideline: cea });
const complianceCea = await api("POST", `/api/projects/${projectId}/target/guideline/compliance`);
const ceaChecks = complianceCea.body.compliance.checks.map((c) => ({ field: c.field, status: c.status, observed: c.observed.slice(0, 120), reason: c.reason ?? null }));
step("B1 CEA 同稿差分", {
  venueId: complianceCea.body.compliance.venueId,
  checks: ceaChecks,
  note: "CEA 官方指南无 DOI/近10年条款——差异来自官方明文，非 CJIG 结论复制",
});

// ---------- 换稿 → 陈旧 ----------
const b1 = join(SAMPLES, "b1-original.pdf");
const replaced = await uploadJson("POST", `/api/projects/${projectId}/paper/pdf`, b1);
if (replaced.status !== 201) throw new Error(`paper replace failed: ${replaced.status}`);
const staleView = await api("GET", `/api/projects/${projectId}/target/evidence-audit`);
step("B2 换稿后 GET（stale 语义）", { stale: staleView.body.audit?.stale ?? null, staleReason: staleView.body.audit?.staleReason ?? null });

// ---------- C. b1 × survey 语义 ----------
const createdB = await uploadJson("POST", "/api/projects/import-paper", b1, {
  format: "pdf",
  title: "M15.16 E2E b1（survey 语义）",
  researchField: "multi-object tracking survey",
  documentType: "survey",
  workflowKind: "existing_paper_review",
});
if (createdB.status !== 201) throw new Error(`import b1 failed: ${createdB.status}`);
const projectIdB = createdB.body.project.id;
log("C1 survey 证据审计（真实模型）…");
const auditB = await api("POST", `/api/projects/${projectIdB}/target/evidence-audit`);
if (auditB.status !== 200) throw new Error(`survey audit failed: ${auditB.status} ${JSON.stringify(auditB.body).slice(0, 400)}`);
const ab = auditB.body.audit;
step("C1 b1（survey）证据审计", {
  projectId: projectIdB,
  documentType: ab.artifact.documentType,
  poolSize: ab.artifact.priorWork.poolSize,
  contentLevels: ab.meta.poolBuild.contentLevels,
  modelCalls: ab.meta.telemetry.calls,
  guards: ab.artifact.guards,
  comparisons: ab.artifact.comparisons.map((c) => ({ id: c.contributionId, status: c.status, basis: c.differenceBasis })),
  gapPlan: ab.artifact.gapPlan.map((g) => ({ id: g.contributionId, action: g.actionType, gap: g.gap.slice(0, 120) })),
});

summary.finishedAt = new Date().toISOString();
await mkdir(OUT, { recursive: true });
await writeFile(join(OUT, "acceptance-summary.json"), JSON.stringify(summary, null, 1), "utf8");
// 原始工件指针（项目内 research/ 工件即事实源，不复制大文件）
await writeFile(
  join(OUT, "project-ids.json"),
  JSON.stringify({ caseRProjectId: projectId, b1ProjectId: projectIdB, base: BASE }, null, 1),
  "utf8",
);
log("完成：summary →", join(OUT, "acceptance-summary.json"));
log("项目保留供人工前端复核：", projectId, projectIdB, "（验收后可 DELETE）");
