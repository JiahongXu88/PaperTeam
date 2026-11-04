/**
 * M17.1：风格审查调度（覆盖 / 失败 / 预算 / 复用）、受控定点修订（锚定 + 守卫 + 语义复核 + 合并再校验）、
 * Gate 隔离（style major 不误杀；真实 blocking 照常阻断；覆盖未完成 ≠ 已审通过）。中文句子均为人工构造。
 */

import { describe, expect, it } from "vitest";

import type { ReviewIssue } from "../../src/agents/ReviewerService.js";
import { aggregateReviews } from "../../src/review/ReviewAggregator.js";
import { styleAuditSummaryOf, type StyleAuditReport, type StyleFinding } from "../../src/review/academicStyleAudit.js";
import { runAcademicStyleAudit, type StyleAuditUnitInput } from "../../src/review/academicStyleAuditRunner.js";
import { finalizeStyleRevisions, prepareStyleRevisions, styleRewriteCheckItems } from "../../src/review/academicStyleRevision.js";
import { evaluateQualityGate } from "../../src/quality/gates.js";
import { classifyGateRule } from "../../src/quality/qualityReport.js";

const APOLOGY = "本文仅是一次粗浅的尝试，难免存在诸多不足，敬请批评指正。";
const LIMIT = "由于未在夜间场景数据上验证，结论能否推广到低照度条件尚不确定。";

const unit = (index: number, text: string, hash = `h${index}`): StyleAuditUnitInput => ({
  unitId: `sections/c${index}.tex::s${index}`, file: `sections/c${index}.tex`, spanId: `s${index}`, heading: `第${index}章`,
  unitIndex: 1, unitCount: 1, chars: text.length, contentHash: hash, text,
});

const okCall = (findingsFor: (text: string) => unknown[] = () => []) => async ({ unit: u }: { unit: StyleAuditUnitInput }) => ({
  parsed: { findings: findingsFor(u.text) as never, unanchored: [], truncated: 0, unitNote: "" },
  taskId: `t-${u.unitId}`, promptSha256: "p", model: "m",
});

const baseInput = {
  projectId: "p1", round: 1, reviewedRevision: 3, isHeadingOnly: (text: string) => /^\s*\\(?:section|chapter)\{[^}]*\}\s*$/.test(text),
  previous: null, previousRevision: null, admitCall: () => true, concurrency: 2, maxCalls: 50,
};

describe("runAcademicStyleAudit：每个单元一条可追踪记录（#11 / #13 / #14）", () => {
  it("长稿 12 个单元：中文正文全部审查、纯标题 / 英文单元 NOT_APPLICABLE、无重复审查", async () => {
    const calls: string[] = [];
    const units = [
      ...Array.from({ length: 10 }, (_, i) => unit(i + 1, `第${i + 1}章正文：本文在两个公开数据集上评估所提方法，并报告每个设置的结果。`)),
      unit(11, "\\section{实验}"),
      unit(12, "We report results on two public benchmarks and discuss limitations."),
    ];
    const report = await runAcademicStyleAudit({
      ...baseInput, units,
      callAudit: async (input) => { calls.push(input.unit.unitId); return okCall()(input); },
    });
    expect(new Set(calls).size).toBe(calls.length);
    expect(calls).toHaveLength(10);
    expect(report.coverage).toMatchObject({ state: "COMPLETE", eligibleUnits: 10, completedUnits: 10, notApplicableUnits: 2 });
    expect(report.units.filter((u) => u.status === "NOT_APPLICABLE").map((u) => u.reason?.split("（")[0])).toEqual(["HEADING_ONLY", "NON_CHINESE_UNIT"]);
  });

  it("非法 JSON / 超时：重试后仍失败 → FAILED（不是空 findings）；其余单元不受影响 → PARTIAL", async () => {
    let attemptsOnBad = 0;
    const report = await runAcademicStyleAudit({
      ...baseInput,
      units: [unit(1, `${APOLOGY}其余正文。`), unit(2, "第二章正文：方法描述与实验设置。")],
      callAudit: async (input) => {
        if (input.unit.unitId.includes("c2")) { attemptsOnBad += 1; throw new Error("风格审查（u）：缺少 styleFindings 数组"); }
        return okCall()(input);
      },
    });
    expect(attemptsOnBad).toBe(2);
    const bad = report.units.find((u) => u.unitId.includes("c2"))!;
    expect(bad).toMatchObject({ status: "FAILED", attempts: 2 });
    expect(bad.error).toMatch(/styleFindings/);
    expect(report.coverage.state).toBe("PARTIAL");
    expect(styleAuditSummaryOf(report)).toMatchObject({ state: "PARTIAL", reviewedUnits: 1, failedUnits: 1 });
  });

  it("预算 / 调用上限：未执行单元记 SKIPPED_BUDGET 并写明原因", async () => {
    const report = await runAcademicStyleAudit({
      ...baseInput, concurrency: 1, maxCalls: 1,
      units: [unit(1, "第一章正文：方法描述。"), unit(2, "第二章正文：实验设置。")],
      callAudit: okCall(),
    });
    expect(report.units.map((u) => u.status)).toEqual(["COMPLETE", "SKIPPED_BUDGET"]);
    expect(report.units[1]!.reason).toMatch(/调用上限 1/);
    expect(report.coverage.state).toBe("PARTIAL");
  });

  it("诊断开关关闭 = DISABLED（可见，不冒充已审）；英文稿件 = NOT_APPLICABLE", async () => {
    const disabled = await runAcademicStyleAudit({ ...baseInput, units: [unit(1, "第一章正文：方法描述。")], disabledReason: "off", callAudit: okCall() });
    expect(disabled.coverage.state).toBe("DISABLED");
    const en = await runAcademicStyleAudit({ ...baseInput, language: "en", units: [unit(1, "第一章正文：方法描述。")], callAudit: okCall() });
    expect(en.coverage.state).toBe("NOT_APPLICABLE");
  });

  it("跨轮复用：内容未变的单元零调用复用 finding（lineage 记来源轮），改动单元重新审查", async () => {
    const finding = { quote: APOLOGY, styleCategory: "repeated_modesty_apology", reason: "r", necessity: "UNNECESSARY", constraints: [], action: "MINIMAL_REWRITE", rewrite: "" };
    const first = await runAcademicStyleAudit({
      ...baseInput, units: [unit(1, `${APOLOGY}其余正文。`), unit(2, "第二章正文：实验设置。")],
      callAudit: okCall((text) => (text.includes("粗浅") ? [finding] : [])),
    });
    expect(first.findings).toHaveLength(1);
    const calls: string[] = [];
    const second = await runAcademicStyleAudit({
      ...baseInput, round: 2, previous: first,
      units: [unit(1, `${APOLOGY}其余正文。`), unit(2, "第二章正文：实验设置已修改。", "h2-changed")],
      callAudit: async (input) => { calls.push(input.unit.unitId); return okCall()(input); },
    });
    expect(calls).toEqual(["sections/c2.tex::s2"]);
    expect(second.units.map((u) => u.status)).toEqual(["REUSED", "COMPLETE"]);
    expect(second.findings[0]!.lineage).toMatchObject({ round: 2, reusedFromRound: 1 });
    expect(second.coverage).toMatchObject({ state: "COMPLETE", reusedUnits: 1, completedUnits: 1 });
  });
});

const finding = (partial: Partial<StyleFinding>): StyleFinding => ({
  id: "sty-1", unitId: "u", file: "sections/intro.tex", logicalSection: "s1", heading: "引言", originalQuote: APOLOGY,
  styleCategory: "repeated_modesty_apology", candidateReason: "", necessityJudgment: "UNNECESSARY", evidenceConstraints: [],
  suggestedAction: "MINIMAL_REWRITE", proposedRewrite: "", disposition: "AUTO_REWRITE_ELIGIBLE", dispositionReason: "",
  candidateSignals: [], reviewStatus: "REVIEWED", revisionStatus: "NOT_DISPATCHED", lineage: { round: 1, unitFingerprint: "f" },
  ...partial,
});

describe("prepare / finalize：受控定点修订（锚外逐字保持；判断不了就保持原文）", () => {
  const content = `\\section{引言}\n${APOLOGY}车辆跟踪是交通感知的基础任务~\\cite{a2020}。\n${LIMIT}\n`;
  const target = { target: "sections/intro.tex", carrier: "file" as const, content };

  it("合规删除自谦句：语义复核 EQUIVALENT → AUTO_FIXED，锚外逐字不变，引用 / 必要限定保留", () => {
    const prepared = prepareStyleRevisions({ findings: [finding({})], attempted: new Set(), maxAutoRewrites: 5, resolveTarget: () => target });
    expect(prepared.candidates).toHaveLength(1);
    const items = styleRewriteCheckItems(prepared.candidates);
    const result = finalizeStyleRevisions({ projectId: "p", runId: "r", candidates: prepared.candidates, verdicts: new Map([[items[0]!.id, { verdict: "EQUIVALENT", fluency: "FLUENT", reason: "只删样板" }]]) });
    expect(result.items[0]!.status).toBe("AUTO_FIXED");
    expect(result.writes[0]!.after).toBe(content.replace(APOLOGY, ""));
    expect(result.writes[0]!.after).toContain(LIMIT);
    expect(result.writes[0]!.after).toContain("\\cite{a2020}");
  });

  it("语义复核 UNSURE / CHANGED / 不可用 → 保持原文（AUTHOR_DECISION / SEMANTIC_REJECTED），不写入", () => {
    const prepared = prepareStyleRevisions({ findings: [finding({})], attempted: new Set(), maxAutoRewrites: 5, resolveTarget: () => target });
    for (const [verdicts, status] of [
      [new Map([["sty-1", { verdict: "UNSURE" as const, reason: "?" }]]), "AUTHOR_DECISION"],
      [new Map([["sty-1", { verdict: "CHANGED" as const, reason: "丢信息" }]]), "SEMANTIC_REJECTED"],
      [null, "AUTHOR_DECISION"],
    ] as const) {
      const result = finalizeStyleRevisions({ projectId: "p", runId: "r", candidates: prepared.candidates, verdicts, semanticUnavailableReason: "调用失败" });
      expect(result.items[0]!.status).toBe(status);
      expect(result.writes).toHaveLength(0);
    }
  });

  it("锚点丢失 / 不唯一 → ANCHOR_LOST；本 run 已处理 → 不重复派发；超上限 → NOT_DISPATCHED", () => {
    const lost = prepareStyleRevisions({ findings: [finding({})], attempted: new Set(), maxAutoRewrites: 5, resolveTarget: () => ({ ...target, content: "其他内容。" }) });
    expect(lost.settled[0]!.status).toBe("ANCHOR_LOST");
    const dup = prepareStyleRevisions({ findings: [finding({})], attempted: new Set(), maxAutoRewrites: 5, resolveTarget: () => ({ ...target, content: `${APOLOGY}\n${APOLOGY}` }) });
    expect(dup.settled[0]!.detail).toMatch(/出现 2 次/);
    expect(prepareStyleRevisions({ findings: [finding({})], attempted: new Set(["sty-1"]), maxAutoRewrites: 5, resolveTarget: () => target }).candidates).toHaveLength(0);
    const capped = prepareStyleRevisions({ findings: [finding({}), finding({ id: "sty-2" })], attempted: new Set(), maxAutoRewrites: 1, resolveTarget: () => target });
    expect(capped.settled.map((item) => item.status)).toEqual(["NOT_DISPATCHED"]);
  });

  it("KEEP / AUTHOR_DECISION 条目永不派发；落盘前守卫再次拦截越权改写", () => {
    const keep = prepareStyleRevisions({ findings: [finding({ disposition: "KEEP" }), finding({ id: "sty-3", disposition: "AUTHOR_DECISION" })], attempted: new Set(), maxAutoRewrites: 5, resolveTarget: () => target });
    expect(keep.candidates).toHaveLength(0);
    expect(keep.settled).toHaveLength(0);
    const sneaky = prepareStyleRevisions({
      findings: [finding({ originalQuote: LIMIT, styleCategory: "uninformative_hedge", proposedRewrite: "结论可推广到低照度条件。" })],
      attempted: new Set(), maxAutoRewrites: 5, resolveTarget: () => target,
    });
    expect(sneaky.settled[0]!.status).toBe("GUARD_REJECTED");
  });
});

const issue = (partial: Partial<ReviewIssue>): ReviewIssue => ({ category: "academic", severity: "minor", section: "引言", description: "d", blocking: false, ...partial });

describe("Gate 隔离（#12）", () => {
  const gateFor = (issues: ReviewIssue[], styleAudit?: StyleAuditReport) => {
    const review = aggregateReviews([{ mode: "fact", taskId: "t", issues, summary: "" }, { mode: "academic", taskId: "a", issues: [], overallScore: 90, summary: "" }, { mode: "style", taskId: "s", issues: [], riskScore: 10, summary: "" }], 1);
    if (styleAudit !== undefined) review.styleAudit = styleAuditSummaryOf(styleAudit);
    return { review, gate: evaluateQualityGate({ review, citation: null, evidence: { total: 0, verified: 0 } as never, feasibility: null }) };
  };

  it("模型把 style issue 标成 major / critical / blocking：计数钳为 minor（原值留痕），不触发 blocking / critical-major 硬门", () => {
    const { review, gate } = gateFor([issue({ category: "style", severity: "major", blocking: true, description: "套话" }), issue({ category: "style", severity: "critical", description: "自谦" })]);
    expect(review.counts).toMatchObject({ critical: 0, major: 0, blocking: 0, minor: 2 });
    expect(review.issues[0]).toMatchObject({ severity: "minor", blocking: false, modelSeverity: "major", modelBlocking: true, severityPolicy: "style_advisory/v1" });
    expect(gate.rules.find((rule) => rule.rule === "blocking_issues_zero")?.status).toBe("PASS");
    expect(gate.rules.find((rule) => rule.rule === "open_critical_major_zero")?.status).toBe("PASS");
  });

  it("真实科学 blocking / major 照常阻断（fact / academic 不受风格政策影响）", () => {
    const { gate } = gateFor([issue({ category: "fact", severity: "major", blocking: true }), issue({ category: "academic", severity: "critical" })]);
    expect(gate.rules.find((rule) => rule.rule === "blocking_issues_zero")?.status).toBe("FAIL");
    expect(gate.rules.find((rule) => rule.rule === "open_critical_major_zero")?.status).toBe("FAIL");
    expect(gate.passed).toBe(false);
  });

  it("风格审查覆盖：COMPLETE = INFO；PARTIAL / FAILED = NOT_EVALUATED（非必需：不阻止 Final，但不显示为通过）；L2 建议性维度", async () => {
    const complete = await runAcademicStyleAudit({ ...baseInput, units: [unit(1, "第一章正文：方法描述。")], callAudit: okCall() });
    const failed = await runAcademicStyleAudit({ ...baseInput, units: [unit(1, "第一章正文：方法描述。")], callAudit: async () => { throw new Error("timeout"); } });
    const ruleOf = (report: StyleAuditReport) => gateFor([], report).gate.rules.find((rule) => rule.rule === "academic_style_audit_reported")!;
    expect(ruleOf(complete)).toMatchObject({ status: "INFO", passed: true, required: false });
    expect(ruleOf(failed)).toMatchObject({ status: "NOT_EVALUATED", passed: true, required: false });
    expect(ruleOf(failed).detail).toMatch(/未审单元的风格问题未知/);
    // 风格覆盖失败不改变 Gate 判定（与无风格摘要时的 passed / blockers 完全一致）
    expect(gateFor([], failed).gate.passed).toBe(gateFor([]).gate.passed);
    expect(gateFor([], failed).gate.rules.filter((rule) => !rule.passed).map((rule) => rule.rule)).toEqual(gateFor([]).gate.rules.filter((rule) => !rule.passed).map((rule) => rule.rule));
    expect(classifyGateRule("academic_style_audit_reported").layer).toBe("L2");
    // 旧产物无 styleAudit：规则不出现
    expect(gateFor([]).gate.rules.some((rule) => rule.rule === "academic_style_audit_reported")).toBe(false);
  });
});
