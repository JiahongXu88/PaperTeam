import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { QualityGatePanel, QualityGateSummaryLink } from "../src/components/project/QualityGatePanel.js";
import type { QualityGateResponseView } from "../src/types/api.js";
import { renderWithProviders } from "./helpers.js";

/**
 * 质量门禁（M4.6）：
 * - 无结果空态（不伪造 0/0 PASS）
 * - FAIL：结论徽标 + 阻止项（可解释：规则名 / 实际值 / 处理入口）+ 规则清单
 * - PASS：克制成功文案 + 同轮审稿上下文
 * - blocker 深链：citation → 引用核验、evidence → 证据（attention 深链）、target → 概览
 * - semanticMode off：citation_semantic_verification_off 渲染为「不参与判定」，绝不显示为失败
 * - stale：过期提示 + 手动重新评估
 * - 轮次切换：Round N gate ↔ Round N review（同轮隔离）
 * - Overview 摘要行（QualityGateSummaryLink）
 */

vi.mock("../src/api/evidence.js", () => ({
  listEvidence: vi.fn(),
  getEvidence: vi.fn(),
  confirmEvidenceVerified: vi.fn(),
  getQualityGate: vi.fn(),
  reevaluateQualityGate: vi.fn(),
}));

import { getQualityGate, reevaluateQualityGate } from "../src/api/evidence.js";

const gateApi = { get: vi.mocked(getQualityGate), reevaluate: vi.mocked(reevaluateQualityGate) };

const RULE = (rule: string, passed: boolean, detail: string) => ({ rule, passed, detail });

const FAIL_RULES = [
  RULE("hallucinated_citations_zero", true, "metadata not_found 引用 0 条"),
  RULE("citation_structure_valid", true, "missing=0 duplicate=0 bad=0"),
  RULE("no_contradictory_evidence", false, "contradictory evidence 1 条"),
  RULE("unsupported_critical_claims_zero", true, "UNSUPPORTED/CONTRADICTED claim 0 条"),
  RULE("blocking_issues_zero", false, "blocking issue 1 条"),
  RULE("open_critical_major_zero", false, "critical=1 major=1"),
  RULE("academic_score_threshold", false, "academicScore=66（要求 ≥ 80）"),
  RULE("style_risk_threshold", false, "styleRisk=68（要求 ≤ 35）"),
  RULE("target_feasibility", true, "feasibility=HIGH"),
];

const PASS_RULES = FAIL_RULES.map((entry) =>
  entry.rule === "academic_score_threshold"
    ? RULE(entry.rule, true, "academicScore=86（要求 ≥ 80）")
    : entry.rule === "style_risk_threshold"
      ? RULE(entry.rule, true, "styleRisk=18（要求 ≤ 35）")
      : entry.passed && entry.rule === "no_contradictory_evidence"
        ? RULE(entry.rule, true, "contradictory evidence 0 条")
        : entry.passed && entry.rule === "blocking_issues_zero"
          ? RULE(entry.rule, true, "blocking issue 0 条")
          : entry.passed && entry.rule === "open_critical_major_zero"
            ? RULE(entry.rule, true, "critical=0 major=0")
            : entry,
);

function gateResponse(overrides: Partial<QualityGateResponseView> = {}): QualityGateResponseView {
  return {
    rounds: [{ round: 1, passed: false, checkedAt: "2026-09-09T12:00:00.000Z", blockerCount: 5 }],
    round: 1,
    gate: {
      passed: false,
      reasons: FAIL_RULES.filter((rule) => !rule.passed).map((rule) => `${rule.rule}: ${rule.detail}`),
      rules: FAIL_RULES,
      thresholds: { academicPassScore: 80, styleRiskMax: 35, requireFeasibility: true },
      checkedAt: "2026-09-09T12:00:00.000Z",
    },
    reviewSummary: {
      generatedAt: "2026-09-09T11:00:00.000Z",
      round: 1,
      counts: { critical: 1, major: 1, minor: 0, blocking: 1 },
      scores: { academicScore: 66, styleRisk: 68 },
      openCritical: 1,
      openMajor: 1,
      unsupportedCriticalClaims: 0,
    },
    latestReviewRound: 1,
    stale: false,
    ...overrides,
  };
}

const onOpenTab = vi.fn();
const renderGate = (workflowKind: "idea_to_paper" | "existing_paper_review" | "existing_paper_improvement" | undefined = "idea_to_paper") =>
  renderWithProviders(<QualityGatePanel projectId="p-gate000001" workflowKind={workflowKind} onOpenTab={onOpenTab} />);

beforeEach(() => {
  gateApi.get.mockReset();
  gateApi.reevaluate.mockReset();
  onOpenTab.mockClear();
});

describe("质量门禁面板", () => {
  it("无结果：空态说明（不显示 0/0 假通过）", async () => {
    gateApi.get.mockResolvedValue(gateResponse({ rounds: [], round: null, gate: null, reviewSummary: null, latestReviewRound: null }));
    renderGate("existing_paper_review");

    const empty = await screen.findByTestId("gate-empty");
    expect(empty).toHaveTextContent("当前还没有质量门禁结果");
    expect(empty).toHaveTextContent("快速 Review 是只读分析，不运行质量门禁");
    expect(screen.queryByTestId("gate-outcome")).not.toBeInTheDocument();
  });

  it("FAIL：结论徽标 + 5 项阻止（可解释：中文规则名 / 实际值 / 阈值）+ Draft/Final 边界文案", async () => {
    gateApi.get.mockResolvedValue(gateResponse());
    renderGate();

    expect(await screen.findByTestId("gate-outcome")).toHaveTextContent("未通过");
    const blockers = screen.getAllByTestId("gate-blocker");
    expect(blockers).toHaveLength(5);
    expect(screen.getByText("5 项阻止论文进入 Final")).toBeVisible();
    // 可解释：实际值与阈值来自后端 detail
    expect(screen.getAllByText("academicScore=66（要求 ≥ 80）").length).toBeGreaterThan(0);
    expect(screen.getAllByText("styleRisk=68（要求 ≤ 35）").length).toBeGreaterThan(0);
    // 阈值行
    expect(screen.getByText(/学术评分 ≥ 80 · 文风风险 ≤ 35/)).toBeVisible();
    // 边界文案：不允许标记为 Final ≠ 不能生成 PDF
    expect(screen.getByText(/质量门禁未通过不影响生成 PDF/)).toBeVisible();
    expect(screen.getAllByText(/无矛盾证据/).length).toBeGreaterThan(0);
    expect(screen.getAllByText(/学术评分达标/).length).toBeGreaterThan(0);
  });

  it("blocker 深链：citation → 引用核验；evidence → 证据 + attention 深链；target → 概览", async () => {
    gateApi.get.mockResolvedValue(gateResponse());
    renderGate();

    await screen.findByTestId("gate-blockers");
    const user = userEvent.setup();

    // no_contradictory_evidence（evidence 类，含矛盾证据 → 需注意筛选）
    await user.click(screen.getByTestId("gate-blocker-goto-evidence"));
    expect(onOpenTab).toHaveBeenCalledWith("evidence", { attention: "1" });

    // review 类规则（blocking_issues / academic score）没有 tab 跳转——通过修订流程处理
    expect(screen.getAllByText(/通过工作流的修订阶段处理审稿问题/).length).toBeGreaterThanOrEqual(1);
  });

  it("target_feasibility 失败 → 跳概览（调整研究目标）", async () => {
    gateApi.get.mockResolvedValue(
      gateResponse({
        gate: {
          passed: false,
          reasons: ["target_feasibility: feasibility=INSUFFICIENT"],
          rules: [RULE("target_feasibility", false, "feasibility=INSUFFICIENT")],
          thresholds: { academicPassScore: 80, styleRiskMax: 35, requireFeasibility: true },
          checkedAt: "2026-09-09T12:00:00.000Z",
        },
      }),
    );
    renderGate();
    await screen.findByTestId("gate-blockers");

    await userEvent.click(screen.getByTestId("gate-blocker-goto-overview"));
    expect(onOpenTab).toHaveBeenCalledWith("overview", undefined);
  });

  it("PASS：克制成功文案 + 同轮审稿上下文（round 配对展示）", async () => {
    gateApi.get.mockResolvedValue(
      gateResponse({
        rounds: [{ round: 2, passed: true, checkedAt: "2026-09-10T12:00:00.000Z", blockerCount: 0 }],
        round: 2,
        gate: {
          passed: true,
          reasons: [],
          rules: PASS_RULES,
          thresholds: { academicPassScore: 80, styleRiskMax: 35, requireFeasibility: true },
          checkedAt: "2026-09-10T12:00:00.000Z",
        },
        reviewSummary: {
          generatedAt: "2026-09-10T11:00:00.000Z",
          round: 2,
          counts: { critical: 0, major: 0, minor: 0, blocking: 0 },
          scores: { academicScore: 86, styleRisk: 18 },
          openCritical: 0,
          openMajor: 0,
          unsupportedCriticalClaims: 0,
        },
        latestReviewRound: 2,
      }),
    );
    renderGate();

    expect(await screen.findByTestId("gate-outcome")).toHaveTextContent("通过");
    expect(screen.getByTestId("gate-passed-note")).toHaveTextContent("当前质量门禁已通过");
    const context = screen.getByTestId("gate-review-context");
    expect(context).toHaveTextContent("第 2 轮");
    expect(context).toHaveTextContent("学术评分 86");
    // PASS 不显示满屏成功统计——无阻止项区块
    expect(screen.queryByTestId("gate-blockers")).not.toBeInTheDocument();
  });

  it("semanticMode=off：语义规则渲染为「不参与判定」，不是失败也不是 0/0 假数据", async () => {
    gateApi.get.mockResolvedValue(
      gateResponse({
        gate: {
          passed: true,
          reasons: [],
          rules: [
            RULE("hallucinated_citations_zero", true, "metadata not_found 引用 0 条"),
            RULE("citation_semantic_verification_off", true, "本轮未开启引用语义核验（语义类规则不参与判定）"),
            RULE("citation_insufficient_evidence_review", true, "INSUFFICIENT_EVIDENCE 3 条（人工复核，不阻断）"),
          ],
          thresholds: { academicPassScore: 80, styleRiskMax: 35, requireFeasibility: true },
          checkedAt: "2026-09-09T12:00:00.000Z",
        },
      }),
    );
    renderGate();
    await screen.findByTestId("gate-rules");

    expect(screen.getByText("引用语义核验未开启")).toBeVisible();
    const offRule = screen.getByTestId("gate-rules").querySelector('[data-rule="citation_semantic_verification_off"]');
    expect(offRule).not.toBeNull();
    expect(offRule!.querySelector(".gate-rule-status")).toHaveTextContent("不参与判定");
    expect(offRule!.querySelector(".gate-rule-status")).not.toHaveTextContent("未通过");
    // INSUFFICIENT_EVIDENCE ≠ 论文错误：不阻断、非 danger
    const insufficient = screen.getByTestId("gate-rules").querySelector('[data-rule="citation_insufficient_evidence_review"]');
    expect(insufficient!.querySelector(".gate-rule-status")).toHaveTextContent("不参与判定");
  });

  it("stale：门禁落后于最新审稿 → 提示 + 手动重新评估（POST 后失效重取）", async () => {
    let call = 0;
    gateApi.get.mockImplementation(async () =>
      gateResponse(call++ === 0 ? { stale: true, latestReviewRound: 2 } : { stale: false, latestReviewRound: 2 }),
    );
    gateApi.reevaluate.mockResolvedValue({ gate: gateResponse().gate!, round: 2 });
    renderGate();

    expect(await screen.findByTestId("gate-stale")).toHaveTextContent("已有更新的第 2 轮审稿");
    await userEvent.click(screen.getByTestId("gate-reevaluate"));
    await waitFor(() => expect(gateApi.reevaluate).toHaveBeenCalledWith("p-gate000001"));
    await waitFor(() => expect(screen.queryByTestId("gate-stale")).not.toBeInTheDocument());
  });

  it("轮次切换：默认最新轮；切换到历史轮读取该轮 gate（同轮 reviewSummary 一起切换）", async () => {
    const round1 = gateResponse();
    const round2 = gateResponse({
      rounds: [
        { round: 2, passed: true, checkedAt: "2026-09-10T12:00:00.000Z", blockerCount: 0 },
        { round: 1, passed: false, checkedAt: "2026-09-09T12:00:00.000Z", blockerCount: 5 },
      ],
      round: 2,
      gate: {
        passed: true,
        reasons: [],
        rules: PASS_RULES,
        thresholds: { academicPassScore: 80, styleRiskMax: 35, requireFeasibility: true },
        checkedAt: "2026-09-10T12:00:00.000Z",
      },
      reviewSummary: {
        generatedAt: "2026-09-10T11:00:00.000Z",
        round: 2,
        counts: { critical: 0, major: 0, minor: 0, blocking: 0 },
        scores: { academicScore: 86, styleRisk: 18 },
        openCritical: 0,
        openMajor: 0,
        unsupportedCriticalClaims: 0,
      },
      latestReviewRound: 2,
    });
    const ALL_ROUNDS = [
      { round: 2, passed: true, checkedAt: "2026-09-10T12:00:00.000Z", blockerCount: 0 },
      { round: 1, passed: false, checkedAt: "2026-09-09T12:00:00.000Z", blockerCount: 5 },
    ];
    gateApi.get.mockImplementation(async (_projectId, round) =>
      round === 1 ? { ...round1, rounds: ALL_ROUNDS } : { ...round2, rounds: ALL_ROUNDS },
    );
    renderGate();

    expect(await screen.findByTestId("gate-outcome")).toHaveTextContent("通过"); // 默认最新 = r2 PASS
    expect(screen.getByTestId("gate-review-context")).toHaveTextContent("第 2 轮");

    await userEvent.selectOptions(screen.getByTestId("gate-round-select"), "1");
    await waitFor(() => expect(gateApi.get).toHaveBeenCalledWith("p-gate000001", 1, expect.anything()));
    await waitFor(() => expect(screen.getByTestId("gate-outcome")).toHaveTextContent("未通过"));
    expect(screen.getByTestId("gate-review-context")).toHaveTextContent("第 1 轮");
    expect(screen.getByText("历史轮次")).toBeVisible();
  });
});

describe("Overview 质量状态摘要（QualityGateSummaryLink）", () => {
  const gotoWorkflow = vi.fn();

  it("尚无 gate → 尚未评估 + 查看入口", async () => {
    gateApi.get.mockResolvedValue(gateResponse({ rounds: [], round: null, gate: null, reviewSummary: null, latestReviewRound: null }));
    renderWithProviders(<QualityGateSummaryLink projectId="p-gate000001" onOpenTab={gotoWorkflow} />);

    const card = await screen.findByTestId("quality-status");
    expect(card).toHaveTextContent("尚未评估");
    await userEvent.click(screen.getByRole("button", { name: "查看" }));
    expect(gotoWorkflow).toHaveBeenCalledWith("workflow");
  });

  it("FAIL → 未通过 · N 个阻止项；stale 追加提示", async () => {
    gateApi.get.mockResolvedValue(gateResponse({ stale: true }));
    renderWithProviders(<QualityGateSummaryLink projectId="p-gate000001" onOpenTab={gotoWorkflow} />);

    const card = await screen.findByTestId("quality-status");
    expect(card).toHaveTextContent("未通过");
    expect(card).toHaveTextContent("第 1 轮 · 5 个阻止项 · 结果可能过期");
  });
});
