#!/usr/bin/env node
/**
 * M11.4 Reliability Closure — Attempt 8 clean run 8c（p-85d7749054b9）一次性
 * 回放（只读，无模型调用）：用 8c 的真实产物驱动修复后的 comment closure /
 * 归因 / 任务层 gate 代码，验证三个确定性修复的效果：
 *   F1  fallback 计划条目 actionType=author_decision_required（R1/R3 的
 *       unresolved → 合法 author_decision 闭环）
 *   F2  AUTHOR_DECISION_REQUIRED 标记 sticky（R2 的 not_applicable 聚合不再
 *       抹除作者裁决标记）
 *   F5  claim↔finding 数值指纹归因（主表 claim 的 blocking finding 归因成功）
 * 对照：实际 8c 终态 = FAIL（reviewer_requirements_closed 2/5 +
 * no_revision_blocking_findings 2 条）。
 * 不修改任何项目数据。
 */
import { readFile, readdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const P = "D:\\Projects\\PaperTeam\\projects\\p-85d7749054b9";
const read = async (f) => JSON.parse(await readFile(join(P, f), "utf8"));

const { applyDispatchOutcome } = await import(distUrl("review", "externalInstructions.js"));
const { computeClaimGapAudit, tagIssueRootCauses } = await import(distUrl("review", "claimGapAudit.js"));
const { evaluateRevisionTaskGate, classifyFindingOrigins } = await import(distUrl("quality", "revisionTaskGate.js"));

// ---- 真实产物 ----
const planJson = await read("research/improvement-plan.json");
const summaryR3 = await read("reviews/review-summary-r3.json");
const grounding = await read("reviews/claim-grounding-r3.json");
const gateR3 = await read("reviews/quality-gate-r3.json");
const patchVal = await read("reviews/patch-validation-rev-3.json");
const instrRaw = await read("reviews/external-instructions.json");
const instructions = Array.isArray(instrRaw) ? instrRaw : (instrRaw.instructions ?? []);

console.log(`[replay] 8c 实际终态：verdict=${gateR3.gate?.revisionTask?.verdict}（${(gateR3.gate?.revisionTask?.reasons ?? []).length} 条硬失败）`);

// ---------------------------------------------------------------------------
// F1：fallback 条目 actionType —— 8c 的 R1/R3 条目是机器兜底（rationale 前缀
// 可识别），修复后它们携带 actionType=author_decision_required。
// 模拟 collectRevisionDirectives 对它们的处理（recordUnresolvedPlanOutcome
// 同构：statusNote = "AUTHOR_DECISION_REQUIRED: ..."）。
// ---------------------------------------------------------------------------
const FALLBACK_MARK = "未被模型计划覆盖";
const fallbackItems = (planJson.plan?.items ?? []).filter(
  (item) => typeof item.rationale === "string" && item.rationale.includes(FALLBACK_MARK),
);
console.log(`\n[F1] 机器兜底条目（8c 实证形态）：${fallbackItems.length} 条`);
for (const item of fallbackItems) {
  console.log(`   ${item.instructionId} actionType(修复后)=author_decision_required（实际 8c：${JSON.stringify(item.actionType)}）`);
}

// ---------------------------------------------------------------------------
// F2：R2 的派发聚合回放——先写入 AUTHOR_DECISION_REQUIRED 标记（8c 中 R2 的
// author_decision 计划项），再应用真实的 not_applicable 回报。
// ---------------------------------------------------------------------------
const r2 = instructions.find((i) => i.reviewerLabel === "Reviewer 2");
if (r2 === undefined) {
  throw new Error("Reviewer 2 instruction not found");
}
// 还原 8c 现场前半：collectRevisionDirectives 对 R2 的 author_decision 项
// 写入的标记（实际 8c 随后被 not_applicable 聚合覆盖）
const marked = {
  ...r2,
  status: "unresolved",
  statusNote: "AUTHOR_DECISION_REQUIRED: This plan item requires an author decision.",
};
const { instructions: afterDispatch } = applyDispatchOutcome(
  [marked],
  {
    round: 2,
    revision: 3,
    // 8c 实际 Writer 回报：R2 派发目标（subsec:metrics）报 not_applicable
    outcomes: [{
      instructionId: r2.instructionId,
      outcome: "not_applicable",
      basis: "target not related to comment",
      targetChanged: false,
      target: "main.tex#metrics",
    }],
    unmatched: [],
  },
  new Date().toISOString(),
);
const sticky = afterDispatch[0]?.statusNote?.startsWith("AUTHOR_DECISION_REQUIRED") === true;
console.log(`\n[F2] R2 not_applicable 聚合后保留作者裁决标记：${sticky ? "YES（8c 实际：被覆盖 → plain unresolved）" : "NO"}`);

// ---------------------------------------------------------------------------
// F5：claim↔finding 数值指纹归因（8c 的两条 blocking finding）
// ---------------------------------------------------------------------------
const frozenFiles = [];
for (const entry of await readdir(join(P, "manuscript", "revisions", "rev-1"), { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith(".tex")) {
    frozenFiles.push({ file: entry.name, content: await readFile(join(P, "manuscript", "revisions", "rev-1", entry.name), "utf8") });
  }
}
const unsupportedClaims = grounding.claims.filter((c) => c.verdict === "UNSUPPORTED" || c.verdict === "CONTRADICTED");
const audit = computeClaimGapAudit({
  projectId: P,
  round: 3,
  baselineRevision: 1,
  unsupportedClaims,
  issues: summaryR3.issues,
  frozenFiles,
  authorEvidence: [],
  generatedAt: new Date().toISOString(),
});
console.log(`\n[F5] claimGapAudit（修复后）：excludedBlocking=${audit.counts.issues.excludedBlocking} excludedCritical=${audit.counts.issues.excludedCritical}（8c 实际：0/0）`);
for (const a of audit.issueAttribution.filter((x) => x.excluded && x.blocking)) {
  console.log(`   ${a.fingerprint}（blocking）→ excluded，归因 ${a.claimId}`);
}
const auditExcluded = new Set(audit.issueAttribution.filter((x) => x.excluded).map((x) => x.fingerprint));
const tagged = tagIssueRootCauses(
  summaryR3.issues,
  unsupportedClaims,
  { excludeFingerprints: auditExcluded },
);

// ---------------------------------------------------------------------------
// 任务层 verdict 重算（新 closure + 新归因；patch 实质 / 守卫沿用 8c 实际值）
// ---------------------------------------------------------------------------
const modifiedSections = (patchVal.records ?? [])
  .filter((r) => r.finalStatus === "accepted" || r.overall === "pass")
  .map((r) => r.logicalTarget ?? "");
const findingOrigins = classifyFindingOrigins(tagged.issues, audit, modifiedSections);
const taskBlocking = findingOrigins.filter(
  (e) => (e.blocking || e.severity === "critical") && (e.origin === "revision_introduced" || e.origin === "modified_existing"),
);
console.log(`\n[gate] 修改区间 blocking/critical finding（修复后）：${taskBlocking.length} 条（8c 实际：2）`);
for (const e of taskBlocking) {
  console.log(`   ${e.origin} | ${e.section} | ${e.description.slice(0, 60)}`);
}

// instruction snapshots：Editor/R4 = handled（8c 实际）；R1/R3/R2 = 修复后
// author_decision（F1 fallback + F2 sticky）
const snapshot = instructions.map((i) => {
  if (i.status === "handled") return { instructionId: i.instructionId, status: "handled", authorDecision: false };
  if (i.reviewerLabel === "Reviewer 1" || i.reviewerLabel === "Reviewer 3") {
    return { instructionId: i.instructionId, status: "unresolved", authorDecision: true };
  }
  return { instructionId: i.instructionId, status: "unresolved", authorDecision: sticky };
});
const verdict = evaluateRevisionTaskGate({
  gateRules: (gateR3.gate?.rules ?? []).map((r) => ({ rule: r.rule, passed: r.passed, detail: r.detail })),
  externalInstructions: snapshot,
  claimGapAudit: audit,
  findingOrigins,
  patchSubstanceOk: true,
  academicScore: 76,
  baselineAcademicScore: 72,
  policy: { mode: "task_scoped", academicFloor: null, academicFloorStatus: "unavailable", regressionTolerance: 10 },
});
console.log(`\n[gate] Revision Task verdict（8c 数据 + 修复后代码）：${verdict.verdict}`);
for (const c of verdict.checks) {
  console.log(`   ${c.passed ? "✔" : "✘"} ${c.check}: ${c.detail.slice(0, 100)}`);
}
console.log(`\n[gate] authorDecisions: ${JSON.stringify(verdict.authorDecisions)}`);
console.log(`[gate] 剩余任务层硬失败：${verdict.reasons.length} 条`);
