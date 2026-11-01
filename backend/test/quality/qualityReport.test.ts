/**
 * M15 长程 B：分层 QualityReport 契约（应阻断 / 应放行成对）。
 *
 * 覆盖：L0 必需未评估不能被 passed=true 掩盖；L1 已证实缺陷 = FAIL；L2 模型阻断意见 = 待核验（不冒充已证实）；
 * 未校准分数回退 = 作者裁决（不是硬 FAIL）；未知规则 fail-closed；旧产物投影不默认合格；
 * 待批准数值修改 / 契约存储不可读；L4 恒 UNVALIDATED 且报告文案不含期刊级宣称。
 */
import { describe, expect, it } from "vitest";

import type { QualityGateResult, QualityGateRule } from "../../src/quality/gates.js";
import { buildQualityReport, deriveLegacyQualityReport, qualityReportOf } from "../../src/quality/qualityReport.js";
import { evaluateRevisionTaskGate, DEFAULT_REVISION_TASK_POLICY } from "../../src/quality/revisionTaskGate.js";

const rule = (id: string, status: QualityGateRule["status"], required = false): QualityGateRule => ({
  rule: id,
  status,
  required,
  passed: status === "FAIL" ? false : status === "NOT_EVALUATED" ? !required : true,
  detail: `${id} ${status}`,
});

function gate(rules: QualityGateRule[], extra: Partial<QualityGateResult> = {}): QualityGateResult {
  return {
    passed: rules.every((entry) => entry.passed),
    reasons: rules.filter((entry) => !entry.passed).map((entry) => entry.rule),
    rules,
    thresholds: { academicScore: 80, styleRisk: 35 } as never,
    checkedAt: "2026-11-01T00:00:00.000Z",
    verification: { requiredComplete: true, notEvaluated: [], notApplicable: [], counts: {} as never },
    evaluation: { entry: "workflow", workflowKind: "existing_paper_improvement", reviewPurpose: "author_manuscript", reviewRound: 2, reviewedRevision: 3, runId: "w-1", inputFingerprint: "f".repeat(64), contextGaps: [] },
    ...extra,
  };
}

const CLEAN = [
  rule("review_coverage_complete", "PASS", true),
  rule("citation_structure_valid", "PASS", true),
  rule("fact_preservation", "PASS", true),
  rule("cross_section_numeric_consistency", "PASS", true),
  rule("hallucinated_citations_zero", "PASS", true),
  rule("blocking_issues_zero", "PASS"),
  rule("open_critical_major_zero", "PASS"),
  rule("academic_score_threshold", "ADVISORY"),
];

describe("overall 状态与可冻结性", () => {
  it("全部通过 → PASS / finalizable；文案不宣称期刊水平或可投稿", () => {
    const report = buildQualityReport(gate(CLEAN), { claimAuditMode: "extended" });
    expect(report.overall).toMatchObject({ status: "PASS", finalizable: true });
    expect(report.overall.statement).toContain("不代表达到任何期刊水平或可投稿");
    expect(report.compat.difference).toBeNull();
  });

  it("L0 必需 NOT_EVALUATED 不能被伪造的 passed=true 掩盖", () => {
    const forged = gate([...CLEAN.slice(1), rule("review_coverage_complete", "NOT_EVALUATED", true)]);
    forged.passed = true;
    const report = buildQualityReport(forged);
    expect(report.layers.L0.status).toBe("NOT_EVALUATED");
    expect(report.overall).toMatchObject({ status: "NOT_EVALUATED", finalizable: false });
    expect(report.compat.difference).not.toBeNull();
  });

  it("L1 已证实缺陷（跨节数值矛盾）→ FAIL，文案为「已证实」", () => {
    const report = buildQualityReport(gate([...CLEAN.filter((entry) => entry.rule !== "cross_section_numeric_consistency"), rule("cross_section_numeric_consistency", "FAIL", true)]));
    expect(report.layers.L1.status).toBe("FAIL");
    expect(report.layers.L1.items.find((item) => item.id === "cross_section_numeric_consistency")?.evidenceGrade).toBe("deterministic");
    expect(report.overall.status).toBe("FAIL");
    expect(report.overall.statement).toContain("已证实");
  });

  it("L2 模型 critical / major 计数 FAIL → NEEDS_VERIFICATION（不冒充已证实缺陷，但仍不可冻结）", () => {
    const report = buildQualityReport(gate([...CLEAN.filter((entry) => entry.rule !== "open_critical_major_zero"), rule("open_critical_major_zero", "FAIL")]));
    expect(report.layers.L1.status).toBe("PASS");
    expect(report.layers.L2.status).toBe("NEEDS_VERIFICATION");
    expect(report.layers.L2.items.find((item) => item.id === "open_critical_major_zero")).toMatchObject({ status: "NEEDS_VERIFICATION", evidenceGrade: "llm_judgment" });
    expect(report.overall).toMatchObject({ status: "NEEDS_VERIFICATION", finalizable: false });
    expect(report.overall.statement).toContain("不是已证实错误");
  });

  it("未分类规则 FAIL → L0 FAIL（fail closed）", () => {
    const report = buildQualityReport(gate([...CLEAN, rule("some_future_rule", "FAIL")]));
    expect(report.layers.L0.items.find((item) => item.id === "some_future_rule")?.evidenceGrade).toBe("unclassified");
    expect(report.overall.status).toBe("FAIL");
  });

  it("非必需未评估 → 可冻结但逐项列出 unknowns（不静默）", () => {
    const report = buildQualityReport(gate([...CLEAN, rule("no_contradictory_evidence", "NOT_EVALUATED")]));
    expect(report.overall.finalizable).toBe(true);
    expect(report.overall.unknowns).toContain("L1 no_contradictory_evidence");
    expect(report.overall.statement).toMatch(/另有 1 项未评估/);
  });

  it("作者稿件 claim 级审计为 shadow → L2 明示未接入生产（NOT_EVALUATED, SHADOW_NOT_IN_PRODUCTION_GATE）", () => {
    const report = buildQualityReport(gate(CLEAN), { claimAuditMode: "shadow" });
    expect(report.layers.L2.items.find((item) => item.id === "claim_level_audit")).toMatchObject({ status: "NOT_EVALUATED", reasonCode: "SHADOW_NOT_IN_PRODUCTION_GATE", required: false });
  });
});

describe("L3 修订闭环", () => {
  const taskInput = (academicScore: number, baseline: number) => evaluateRevisionTaskGate({
    gateRules: CLEAN, externalInstructions: [], claimGapAudit: null, findingOrigins: [], patchSubstanceOk: true,
    academicScore, baselineAcademicScore: baseline, policy: DEFAULT_REVISION_TASK_POLICY,
  });

  it("未校准学术分回退超过容差 → 作者裁决项（旧口径硬 FAIL），报告可冻结且列出原因", () => {
    const task = taskInput(60, 78);
    expect(task.verdict).toBe("AUTHOR_DECISION_REQUIRED");
    const check = task.checks.find((entry) => entry.check === "academic_non_regression");
    expect(check).toMatchObject({ passed: false, advisory: true });
    const report = buildQualityReport(gate(CLEAN, { revisionTask: { verdict: task.verdict, success: task.success, checks: task.checks, reasons: task.reasons, authorDecisions: task.authorDecisions } }));
    expect(report.layers.L3.items.find((item) => item.id === "revision_task.academic_non_regression")).toMatchObject({ status: "NEEDS_AUTHOR_DECISION", reasonCode: "UNCALIBRATED_SCORE_REGRESSION" });
    expect(report.overall).toMatchObject({ status: "NEEDS_AUTHOR_DECISION", finalizable: true });
  });

  it("任务层确定性检查失败（patch 实质失败）→ L3 FAIL", () => {
    const task = evaluateRevisionTaskGate({
      gateRules: CLEAN, externalInstructions: [], claimGapAudit: null, findingOrigins: [], patchSubstanceOk: false,
      academicScore: 80, baselineAcademicScore: 80, policy: DEFAULT_REVISION_TASK_POLICY,
    });
    const report = buildQualityReport(gate(CLEAN, { revisionTask: { verdict: task.verdict, success: task.success, checks: task.checks, reasons: task.reasons, authorDecisions: task.authorDecisions } }));
    expect(report.layers.L3.status).toBe("FAIL");
    expect(report.overall.finalizable).toBe(false);
  });

  it("任务守卫中非必需 NOT_EVALUATED 不再被描述为「全过」", () => {
    const task = evaluateRevisionTaskGate({
      gateRules: [...CLEAN, rule("no_contradictory_evidence", "NOT_EVALUATED")], externalInstructions: [], claimGapAudit: null, findingOrigins: [],
      patchSubstanceOk: true, academicScore: 80, baselineAcademicScore: 80, policy: DEFAULT_REVISION_TASK_POLICY,
    });
    const guard = task.checks.find((entry) => entry.check === "deterministic_guards")!;
    expect(guard.detail).toContain("未评估");
    expect(guard.detail).not.toContain("全过");
  });

  it("待作者批准的数值修改 → NEEDS_AUTHOR_DECISION；契约存储不可读 → L3 NOT_EVALUATED（必需）", () => {
    expect(buildQualityReport(gate(CLEAN), { pendingValueChangeRequests: 2 }).overall.status).toBe("NEEDS_AUTHOR_DECISION");
    const unknown = buildQualityReport(gate(CLEAN), { pendingValueChangeRequests: null });
    expect(unknown.layers.L3.status).toBe("NOT_EVALUATED");
    expect(unknown.overall.finalizable).toBe(false);
  });
});

describe("L4 与历史兼容", () => {
  it("L4 恒 UNVALIDATED；externalValidity 不宣称校准 / 期刊通过", () => {
    const report = buildQualityReport(gate(CLEAN), { independentHumanLabels: 0 });
    expect(report.layers.L4.status).toBe("UNVALIDATED");
    expect(report.externalValidity).toMatchObject({ independentHumanLabels: 0, scoreCalibrated: false, targetJournalValidated: false });
    // 涉及期刊 / 投稿 / 校准的措辞只允许出现在否定声明里
    const negations = [report.externalValidity.statement, report.overall.statement, report.compat.meaning, report.layers.L4.items[0]!.detail];
    for (const sentence of negations) expect(sentence).toMatch(/不(得|代表|判定)/);
    const text = JSON.stringify((["L0", "L1", "L2", "L3"] as const).flatMap((layer) => report.layers[layer].items.map((item) => item.detail)));
    for (const forbidden of ["达到", "投稿", "期刊", "校准"]) expect(text).not.toContain(forbidden);
  });

  it("旧产物（规则无 status）投影：passed=true 的旧报告也不默认可冻结", () => {
    const legacy: QualityGateResult = { passed: true, reasons: [], rules: [{ rule: "hallucinated_citations_zero", passed: true, detail: "ok" }], thresholds: {} as never, checkedAt: "2025-01-01T00:00:00.000Z" };
    const report = deriveLegacyQualityReport(legacy);
    expect(report.binding.entry).toBe("legacy_projection");
    expect(report.layers.L0.items.find((item) => item.id === "legacy_artifact_complete")).toMatchObject({ status: "NOT_EVALUATED", required: true });
    expect(report.overall.finalizable).toBe(false);
    expect(qualityReportOf(legacy).overall.finalizable).toBe(false);
  });

  it("新产物：qualityReportOf 返回嵌入报告（不重算）", () => {
    const current = gate(CLEAN);
    const embedded = buildQualityReport(current, { generatedAt: "2026-11-01T02:00:00.000Z" });
    expect(qualityReportOf({ ...current, qualityReport: embedded })).toBe(embedded);
  });

  it("确定性：同一 gate + context → 同一报告（generatedAt 除外）", () => {
    const a = buildQualityReport(gate(CLEAN), { generatedAt: "x", claimAuditMode: "shadow" });
    const b = buildQualityReport(gate(CLEAN), { generatedAt: "x", claimAuditMode: "shadow" });
    expect(a).toEqual(b);
  });
});
