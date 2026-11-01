#!/usr/bin/env node
/**
 * M15.20 P0 — 编辑契约的真实冻结工件只读回放（零模型、零写入源工件）。
 *
 * A. M15.19 E1 摘要真实落盘（rev-1 → rev-2）：以计划条目结构化字段（目标锚 + 禁改）确定性重建审计契约
 *    → validateCandidateEdit / 复评契约证据 / assessRewriteClosure 是否仍判 VALIDATED_FIXED。
 * B. M15.19 E1 sec01 span 候选（rev-2 a0 / a1）：同一越权经 sec01 载体。
 * C. 历史「已接受」span 候选（M15.17 / M15.18 / M15.19 / MOT R5.1 / MOT RevisionRecovery）在系统修订策略
 *    契约下的误拒统计；被拒者逐条归因（计划文本是否点名该值 = 旧口径「文本即授权」放行的改数）。
 *
 * 只读：所有源目录仅 readFile；结果写 --out（缺省 D:\PaperTeamData\M15\M15_20_EditContractP0\replay-e1.json）。
 * 用法：node scripts/m1520/replay-edit-contract.mjs [--data D:\PaperTeamData] [--out <json>]
 */
import { readFile, readdir, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";
import { pathToFileURL } from "node:url";

const arg = (name, fallback) => {
  const index = process.argv.indexOf(`--${name}`);
  return index !== -1 ? process.argv[index + 1] : fallback;
};
const DATA = arg("data", "D:\\PaperTeamData");
const OUT = arg("out", join(DATA, "M15", "M15_20_EditContractP0", "replay-e1.json"));

const dist = (...parts) => pathToFileURL(join(import.meta.dirname, "..", "..", "backend", "dist", ...parts)).href;
const { validateCandidateEdit, systemRevisionPolicyContract, extractValueTokens } = await import(dist("quality", "editContract.js"));
const { buildAuditRewriteContract, assessEditContractForClosure, assessRewriteClosure } = await import(dist("target", "TargetAuditRevisionService.js"));
const { readSnapshotTex } = await import(dist("quality", "citationPreservation.js"));
const { locateFileSpans, partitionSpanIntoUnits, partitionSpanIntoBlockUnits } = await import(dist("review", "logicalSpan.js"));
const { applyRevisionSpan } = await import(dist("review", "revisionScope.js"));

const sha = (text) => createHash("sha256").update(text).digest("hex");
const readJson = async (path) => JSON.parse(await readFile(path, "utf8"));
const tryJson = async (path) => readJson(path).catch(() => null);
const codesOf = (verdict) => [...new Set(verdict.violations.map((violation) => violation.code))].sort();
const sources = [];

// ---------------------------------------------------------------- A. E1 摘要
const E1 = join(DATA, "M15", "M15_19");
const e1Project = join(E1, "e2e-stack", "p-b6a2677fdf05");
const planView = await readJson(join(E1, "e1", "E1-plan-after-D1.json"));
const plan = planView.plan.plan ?? planView.plan;
const item = plan.items.find((entry) => entry.itemId === "ta-sg-34ced22fcb");
const rev1Outline = join(e1Project, "manuscript", "revisions", "rev-1", "outline.json");
const rev2Outline = join(e1Project, "manuscript", "revisions", "rev-2", "outline.json");
const before = (await readJson(rev1Outline)).abstract;
const after = (await readJson(rev2Outline)).abstract;
sources.push(...[join(E1, "e1", "E1-plan-after-D1.json"), rev1Outline, rev2Outline].map((path) => ({ path, sha256: null })));
const contract = buildAuditRewriteContract({
  projectId: "p-b6a2677fdf05",
  plan,
  item,
  baseContent: before,
  approval: { approvalId: "replay-legacy", actor: "author", channel: "replay:legacy-reconstruction", at: "" },
});
const abstractVerdict = validateCandidateEdit({ target: "abstract", baseline: before, candidate: after, contracts: [contract] });
const closureEvidence = assessEditContractForClosure({ contract: undefined, legacyItem: item, plan, projectId: "p-b6a2677fdf05", target: "abstract", before: before.trim(), after: after.trim() });
const instructions = (await readJson(join(E1, "e1", "instructions-after.json")));
const instructionList = Array.isArray(instructions) ? instructions : instructions.instructions;
const instruction = instructionList.find((entry) => entry.instructionId === "x-620aab7c7d");
const replayClosure = assessRewriteClosure({
  item,
  instruction,
  patches: [],
  currentTargetFileHash: sha(after.trim()),
  gateEvidence: () => ({ fact: true, citation: true, round: 3, reviewedRevision: 2 }),
  editContract: closureEvidence,
});
const legacyClosureWithoutContract = assessRewriteClosure({ item, instruction, patches: [], currentTargetFileHash: sha(after.trim()), gateEvidence: () => ({ fact: true, citation: true, round: 3, reviewedRevision: 2 }) });
const legalCandidate = before.replace(/improving\s+the previous best HOTA by 5\.402\/6\.075 points and IDF1 by\s+11\.549\/12\.789 points, respectively/, "improving the previous best HOTA by 5.402/6.075 points and IDF1 by 11.549/12.789 points under the respective detection settings, respectively");
const legalVerdict = validateCandidateEdit({ target: "abstract", baseline: before, candidate: legalCandidate, contracts: [contract] });
const E1_ABSTRACT = {
  contract: { contractId: contract.contractId, hardNumericFreeze: contract.constraints.hardNumericFreeze, protectedValues: contract.constraints.protectedValues, conflicts: contract.conflicts.map((conflict) => conflict.kind) },
  realWrite: { beforeSha256: sha(before.trim()), afterSha256: sha(after.trim()), ok: abstractVerdict.ok, codes: codesOf(abstractVerdict), violations: abstractVerdict.violations.map((violation) => ({ code: violation.code, value: violation.value, sentence: violation.sentence?.slice(0, 120) })) },
  closureReplay: { closure: replayClosure.closure, editContract: replayClosure.editContract?.status, basis: replayClosure.basis.slice(0, 300) },
  closureWithoutContractEvidence: { closure: legacyClosureWithoutContract.closure },
  derivedLegalQualify: { applied: legalCandidate !== before, ok: legalVerdict.ok, codes: codesOf(legalVerdict) },
};

// ---------------------------------------------------------------- 候选回放工具
async function locateUnit(file, content, beforeTargetHash) {
  for (const span of locateFileSpans(file, content)) {
    const pools = [[span], partitionSpanIntoUnits(span).units, partitionSpanIntoBlockUnits(span).units];
    const unit = pools.flat().find((entry) => entry.originalHash === beforeTargetHash);
    if (unit !== undefined) return unit;
  }
  return undefined;
}

async function replayProject(label, projectDir, extraContracts) {
  const revisionsDir = join(projectDir, "manuscript", "revisions");
  const revs = (await readdir(revisionsDir)).filter((name) => /^rev-\d+$/.test(name)).map((name) => Number(name.slice(4))).sort((a, b) => a - b);
  const frozenFiles = await readSnapshotTex(join(revisionsDir, `rev-${revs[0]}`));
  const improvementPlan = await tryJson(join(projectDir, "research", "improvement-plan.json"));
  const planTexts = (improvementPlan?.plan?.items ?? []).map((entry) => `${entry.action ?? ""}\n${entry.rationale ?? ""}`);
  const results = [];
  const candidatesRoot = join(projectDir, "reviews", "patch-candidates");
  for (const revisionDir of (await readdir(candidatesRoot)).sort()) {
    for (const name of (await readdir(join(candidatesRoot, revisionDir))).sort()) {
      const candidate = await readJson(join(candidatesRoot, revisionDir, name));
      const sourceFiles = await readSnapshotTex(join(revisionsDir, `rev-${candidate.sourceRevision}`));
      const sourceFile = sourceFiles?.find((file) => file.file === candidate.file);
      if (sourceFile === undefined) {
        results.push({ patchId: candidate.patchId, verdictThen: candidate.verdict, replay: "source-missing" });
        continue;
      }
      const unit = await locateUnit(candidate.file, sourceFile.content, candidate.beforeTargetHash);
      if (unit === undefined) {
        results.push({ patchId: candidate.patchId, verdictThen: candidate.verdict, replay: "unit-not-located" });
        continue;
      }
      const proposal = candidate.validatedProposal ?? candidate.rawProposal;
      const candidateContent = applyRevisionSpan(sourceFile.content, unit, proposal, { preserveBoundaryWhitespace: (candidate.authorizedQuotes ?? []).length > 0 });
      const frozen = frozenFiles?.find((file) => file.file === candidate.file)?.content;
      const contracts = [
        systemRevisionPolicyContract({ projectId: label, file: candidate.file, carrier: "file", baseContent: sourceFile.content, frozenContent: frozen, stageId: "replay" }),
        ...extraContracts(candidate, sourceFile.content),
      ];
      const verdict = validateCandidateEdit({ target: candidate.file, baseline: sourceFile.content, candidate: candidateContent, contracts });
      const values = verdict.violations.filter((violation) => violation.value !== undefined).map((violation) => violation.value);
      const mentionedByPlanText = values.length > 0 && values.every((value) => planTexts.some((text) => extractValueTokens(text).some((token) => token.norm === value)));
      results.push({
        patchId: candidate.patchId,
        file: candidate.file,
        verdictThen: candidate.verdict,
        contractOk: verdict.ok,
        codes: codesOf(verdict),
        values: [...new Set(values)].slice(0, 12),
        ...(verdict.ok ? {} : { attribution: mentionedByPlanText ? "value_change_authorized_only_by_planner_text" : "unexplained" }),
        detail: verdict.violations.slice(0, 3).map((violation) => violation.detail.slice(0, 160)),
      });
    }
  }
  const accepted = results.filter((entry) => entry.verdictThen === "accepted" && typeof entry.contractOk === "boolean");
  return {
    label,
    candidates: results.length,
    acceptedThen: results.filter((entry) => entry.verdictThen === "accepted").length,
    acceptedReplayed: accepted.length,
    acceptedNowRejected: accepted.filter((entry) => !entry.contractOk).length,
    acceptedNowRejectedByAttribution: Object.fromEntries(
      [...new Set(accepted.filter((entry) => !entry.contractOk).map((entry) => entry.attribution))].map((key) => [key, accepted.filter((entry) => !entry.contractOk && entry.attribution === key).length]),
    ),
    rejectedThen: results.filter((entry) => entry.verdictThen === "rejected").length,
    rejectedThenNowContractRejected: results.filter((entry) => entry.verdictThen === "rejected" && entry.contractOk === false).length,
    unreplayable: results.filter((entry) => typeof entry.replay === "string").length,
    results,
  };
}

// ---------------------------------------------------------------- B. E1 sec01 候选（审计契约 + 系统策略）
const e1Sec01 = await replayProject("M15.19-E1 p-b6a2677fdf05", e1Project, (candidate) =>
  (candidate.planItemIds ?? []).some((id) => id === "improvement:1" || id === "improvement:2") ? [contract] : []);

// ---------------------------------------------------------------- C. 历史已接受候选（系统修订策略）
const projectsToReplay = [
  ["M15.17 p-a8486551421a", join(DATA, "M15", "M15_17", "e2e-stack", "p-a8486551421a")],
  ["M15.18 p-724f527d6766", join(DATA, "M15", "M15_18", "e2e-stack", "p-724f527d6766")],
  ["M15.19-DEV p-724f527d6766", join(DATA, "M15", "M15_19", "dev-stack", "p-724f527d6766")],
  ["MOT R5.1 p-e6770bf79fed", join(DATA, "MOT_PaperTeam_R5_1_Acceptance", "workflow", "projects", "p-e6770bf79fed")],
  ["MOT RevisionRecovery p-e3f03d95a00d", join(DATA, "MOT_PaperTeam_RevisionRecovery", "workflow", "projects", "p-e3f03d95a00d")],
];
const history = [];
for (const [label, dir] of projectsToReplay) {
  try {
    history.push(await replayProject(label, dir, () => []));
  } catch (error) {
    history.push({ label, error: String(error).slice(0, 300) });
  }
}

const summary = {
  generatedAt: new Date().toISOString(),
  modelCalls: 0,
  E1_ABSTRACT: { realWriteRejected: !E1_ABSTRACT.realWrite.ok, codes: E1_ABSTRACT.realWrite.codes, closureReplay: E1_ABSTRACT.closureReplay.closure, closureWithoutContract: E1_ABSTRACT.closureWithoutContractEvidence.closure, derivedLegalQualifyOk: E1_ABSTRACT.derivedLegalQualify.ok },
  E1_SEC01: e1Sec01.results.map((entry) => ({ patchId: entry.patchId, verdictThen: entry.verdictThen, contractOk: entry.contractOk, codes: entry.codes })),
  history: history.map((entry) => ({ label: entry.label, acceptedThen: entry.acceptedThen, acceptedReplayed: entry.acceptedReplayed, acceptedNowRejected: entry.acceptedNowRejected, byAttribution: entry.acceptedNowRejectedByAttribution, rejectedThen: entry.rejectedThen, unreplayable: entry.unreplayable, error: entry.error })),
};
console.log(JSON.stringify(summary, null, 1));
await writeFile(OUT, JSON.stringify({ summary, E1_ABSTRACT, e1Sec01, history }, null, 1), "utf8");
console.log(`written ${OUT}`);
