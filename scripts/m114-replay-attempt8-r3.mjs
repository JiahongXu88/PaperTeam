#!/usr/bin/env node
/**
 * M11.4 Attempt 8 一次性回放（只读，无模型调用）：用 Attempt 8 clean run
 * （p-db07e4273daa / w-e3ff6274abc5）的真实 r3 产物驱动修复后的
 * gate/audit 代码，验证四个确定性修复是否解除任务层 FAIL 的三个驱动因子：
 *   1. numberRuns 区间连字符（c-e965ba5d2331 数据集统计）
 *   2. 全文级 containment 兜底（c-dc50babe7207 消融/λ_smooth 扫描数值）
 *   3. issue 归因非对称 containment + tagIssueRootCauses（MRG-DTM blocking
 *      finding → rootCauseKey → baseline_inherited）
 *   4. 公式 alpha-rename 配对（w_t^k → \omega_t^k 一致重命名，4 项未授权
 *      漂移 → formatChanges）
 * 不修改任何项目数据。
 */
import { readFile, readdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const P = "D:\\Projects\\PaperTeam\\projects\\p-db07e4273daa";
const read = async (f) => JSON.parse(await readFile(join(P, f), "utf8"));

const { computeClaimGapAudit } = await import(distUrl("review", "claimGapAudit.js"));
const { evaluateRevisionTaskGate, classifyFindingOrigins } = await import(distUrl("quality", "revisionTaskGate.js"));
const { evaluateFactPreservation } = await import(distUrl("quality", "factPreservation.js"));
const { locateLatexSections } = await import(distUrl("review", "revisionScope.js"));

// ---- 真实产物 ----
const summaryR3 = await read("reviews/review-summary-r3.json");
const summaryR1 = await read("reviews/review-summary-r1.json");
const grounding = await read("reviews/claim-grounding-r3.json");
const gateR3 = await read("reviews/quality-gate-r3.json");
const patchVal = await read("reviews/patch-validation-rev-3.json");
const instr = await read("reviews/external-instructions.json");
const ledger = (await read("research/fact-authorizations.json")).entries ?? [];

// 冻结基线（rev-1 快照）与当前稿（rev-3）
async function readTex(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    if (entry.isFile() && entry.name.endsWith(".tex")) {
      files.push({ file: entry.name, content: await readFile(join(dir, entry.name), "utf8") });
    }
  }
  return files;
}
const frozenFiles = await readTex(join(P, "manuscript", "revisions", "rev-1"));
const currentFiles = await readTex(join(P, "manuscript", "revisions", "rev-3"));

// ---- 修复 1+2：claimGapAudit 重算 ----
const audit = computeClaimGapAudit({
  projectId: P,
  round: 3,
  baselineRevision: 1,
  unsupportedClaims: grounding.claims.filter((c) => c.verdict === "UNSUPPORTED" || c.verdict === "CONTRADICTED"),
  issues: summaryR3.issues,
  frozenFiles,
  authorEvidence: [],
  generatedAt: new Date().toISOString(),
});
console.log("[replay] claimGapAudit(修复后):", JSON.stringify(audit.counts));
for (const c of audit.claims) {
  console.log("  ", c.claimId.slice(0, 14), (c.applicability + "").padEnd(28), "|", c.claim.slice(0, 44));
}

// ---- 修复 3：issue 归因（blocking finding → excluded / rootCauseKey 语义） ----
console.log("[replay] issueAttribution:");
for (const a of audit.issueAttribution) {
  console.log("  ", a.fingerprint, a.severity, "blocking=" + a.blocking, "→ excluded=" + a.excluded, a.claimId ?? "");
}

// ---- 修复 4：累计事实保持重算（rev-1 → rev-3，真实台账 + 真实证据） ----
const evidenceRecords = (await readFile(join(P, "evidence", "evidence.jsonl"), "utf8"))
  .split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
const evidenceTexts = evidenceRecords.flatMap((record) => [
  record.claim, record.summary ?? "", record.quote ?? "",
]);
// mirror cumulativeFactPreservation.ledgerToImprovementItems / weakeningEntries
const improvementPlanItems = ledger
  .filter((entry) => entry.authorizationKind === undefined)
  .map((entry) => ({
    section: entry.section,
    action: entry.text,
    ...(entry.expectedFactChanges !== undefined && entry.expectedFactChanges.length > 0
      ? { rationale: [entry.text, ...entry.expectedFactChanges.map((c) => `${c.before} → ${c.after}${c.basis !== undefined ? `（依据：${c.basis}）` : ""}`)].join("\n") }
      : {}),
  }));
const weakeningAuthorizations = ledger
  .filter((entry) => entry.authorizationKind !== undefined)
  .map((entry) => ({
    kind: entry.authorizationKind,
    section: entry.section,
    targetSpan: entry.text,
    itemId: entry.itemId,
    ...(entry.claimId !== undefined ? { claimId: entry.claimId } : {}),
    ...(entry.round !== undefined ? { round: entry.round } : {}),
    ...(entry.reason !== undefined ? { reason: entry.reason } : {}),
  }));
const cumulative = evaluateFactPreservation({
  previous: { revision: 1, files: frozenFiles },
  current: { revision: 3, files: currentFiles },
  plan: null,
  improvementPlanItems,
  evidenceTexts,
  weakeningAuthorizations,
});
console.log("[replay] cumulative fact preservation(修复后 rev-1→rev-3): ok =", cumulative.ok);
console.log("  formulaChanges:", cumulative.formulaChanges.length, "| addedUnsupported:", cumulative.addedUnsupportedFacts.length,
  "| notation renames:", cumulative.formatChanges.filter((f) => f.reason === "formula_notation_rename").length,
  "| authorized(放行):", "changes/weakenings 见 summary");
for (const f of cumulative.formulaChanges) console.log("   [formula violation]", f.reason, "|", f.before.slice(0, 50));
for (const f of cumulative.addedUnsupportedFacts.filter((f) => f.reason === "formula_added")) console.log("   [formula added]", f.after.slice(0, 50));
for (const f of cumulative.formatChanges.filter((f) => f.reason === "formula_notation_rename")) {
  console.log("   [notation rename]", f.before.slice(0, 46), "→", f.after.slice(0, 46));
}

// ---- finding 归层 + 任务层判定（守卫规则中的 cumulative 用重算结果替换） ----
const previousMain = frozenFiles.find((f) => f.file === "main.tex")?.content;
const modifiedSections = patchVal.records.flatMap((r) => {
  const span = locateLatexSections("main.tex", previousMain).find((c) => c.logicalSection === r.logicalTarget);
  return [r.logicalTarget, r.file, ...(span ? [span.heading] : [])];
});
const findingOrigins = classifyFindingOrigins(summaryR3.issues, audit, modifiedSections);
console.log("[replay] heavy findings 归层:");
for (const f of findingOrigins) {
  console.log("  ", f.origin.padEnd(20), (f.severity + (f.blocking ? "/blocking" : "")).padEnd(16), "|", f.description.slice(0, 52));
}

const gateRules = gateR3.gate.rules.map((rule) =>
  rule.rule === "cumulative_fact_preservation"
    ? { rule: "cumulative_fact_preservation", passed: cumulative.ok, detail: `[replay 修复后重算] rev-1→rev-3 公式 alpha-rename 配对 ${cumulative.formatChanges.filter((f) => f.reason === "formula_notation_rename").length} 项归 formatChanges` }
    : rule,
);
const taskResult = evaluateRevisionTaskGate({
  gateRules,
  externalInstructions: (instr.instructions ?? instr).map((i) => ({
    instructionId: i.instructionId,
    status: i.status,
    authorDecision: i.status === "conflict" || (i.statusNote ?? "").startsWith("AUTHOR_DECISION_REQUIRED"),
  })),
  claimGapAudit: audit,
  findingOrigins,
  patchSubstanceOk:
    patchVal.summary.passedPatches === patchVal.summary.totalPatches &&
    patchVal.summary.unattributedViolations.length === 0,
  academicScore: summaryR3.scores.academicScore,
  baselineAcademicScore: summaryR1.scores.academicScore,
  policy: { mode: "task_scoped", academicFloor: null, academicFloorStatus: "unavailable", regressionTolerance: 10 },
});

console.log("\n[replay] ==== 任务层判定（修复后重放） ====");
console.log("verdict:", taskResult.verdict, "| success:", taskResult.success);
for (const c of taskResult.checks) console.log("  ", c.passed ? "PASS" : "FAIL", c.check, "|", c.detail.slice(0, 110));
console.log("reasons:", JSON.stringify(taskResult.reasons, null, 1));
console.log("authorDecisions:", JSON.stringify(taskResult.authorDecisions));
console.log("publication:", taskResult.publication.verdict, "| risks:", taskResult.publication.risks.length, "条");
