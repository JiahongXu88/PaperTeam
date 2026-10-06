#!/usr/bin/env node
/**
 * M11.4 一次性回放（只读，无模型调用）：用 Attempt 7 clean run 的真实 r3 产物
 * 驱动新分层 gate，验证任务层判定。不修改任何项目数据。
 */
import { readFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const P = "D:\\Projects\\PaperTeam\\backend\\projects\\p-d12dc28ad850";
const read = async (f) => JSON.parse(await readFile(join(P, f), "utf8"));

const { computeClaimGapAudit } = await import(distUrl("review", "claimGapAudit.js"));
const { evaluateRevisionTaskGate, classifyFindingOrigins } = await import(distUrl("quality", "revisionTaskGate.js"));
const { evaluateQualityGate } = await import(distUrl("quality", "gates.js"));
const { locateLatexSections } = await import(distUrl("review", "revisionScope.js"));

// ---- 真实产物 ----
const summaryR3 = await read("reviews/review-summary-r3.json");
const summaryR1 = await read("reviews/review-summary-r1.json");
const grounding = await read("reviews/claim-grounding-r3.json");
const gateR3 = await read("reviews/quality-gate-r3.json");
const patchVal = await read("reviews/patch-validation-rev-3.json");
const instr = await read("reviews/external-instructions.json");

// 冻结基线（rev-1 快照）
const snapshotDir = join(P, "manuscript", "revisions", "rev-1");
const { readdir } = await import("node:fs/promises");
const frozenFiles = [];
for (const entry of await readdir(snapshotDir, { withFileTypes: true })) {
  if (entry.isFile() && entry.name.endsWith(".tex")) {
    frozenFiles.push({ file: entry.name, content: await readFile(join(snapshotDir, entry.name), "utf8") });
  }
}

// 重算 claimGapAudit（新含灰区带；与 review.run 同参数）
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
console.log("[replay] claimGapAudit(新口径):", JSON.stringify(audit.counts, null, 0));
for (const c of audit.claims) console.log("  ", c.claimId.slice(0, 12), c.applicability.padEnd(28), "|", c.claim.slice(0, 40));

// 修改区间（patch 记录 → logicalTarget + heading）
const previousMain = frozenFiles.find((f) => f.file === "main.tex")?.content;
const modifiedSections = patchVal.records.flatMap((r) => {
  const span = locateLatexSections("main.tex", previousMain).find((c) => c.logicalSection === r.logicalTarget);
  return [r.logicalTarget, r.file, ...(span ? [span.heading] : [])];
});
console.log("[replay] modifiedSections:", JSON.stringify(modifiedSections));

const findingOrigins = classifyFindingOrigins(summaryR3.issues, audit, modifiedSections);
console.log("[replay] heavy findings 归层:");
for (const f of findingOrigins.filter((f) => f.blocking || f.severity === "critical")) {
  console.log("  ", f.origin.padEnd(20), "|", f.section.slice(0, 20).padEnd(20), "|", f.description.slice(0, 50));
}

// gate 规则：用保存的 r3 gate 规则（守卫部分）+ 当前策略
const taskResult = evaluateRevisionTaskGate({
  gateRules: gateR3.gate.rules,
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

console.log("\n[replay] ==== 任务层判定 ====");
console.log("verdict:", taskResult.verdict, "| success:", taskResult.success);
for (const c of taskResult.checks) console.log("  ", c.passed ? "PASS" : "FAIL", c.check, "|", c.detail.slice(0, 110));
console.log("reasons:", JSON.stringify(taskResult.reasons, null, 1));
console.log("authorDecisions:", JSON.stringify(taskResult.authorDecisions));
console.log("publication risks:", taskResult.publication.risks.length, "条；verdict:", taskResult.publication.verdict);
