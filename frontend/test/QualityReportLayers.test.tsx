import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { QualityReportLayers, ValueChangeRequestsPanel } from "../src/components/project/QualityReportLayers.js";
import type { QualityReportView, ValueChangeRequestView } from "../src/types/qualityReport.js";
import { renderWithProviders } from "./helpers.js";

/**
 * M15 长程 B / D：分层质量报告呈现 + 数值修改逐项批准。
 * - L1 已证实缺陷 / L2 AI 意见待核验 / 未评估 三类原因在界面上可区分（证据等级标签）
 * - L4 恒显示「未经独立校准」，外部效度声明可见
 * - 数值修改：未勾选核对不能批准；批准请求携带所见 boundHash；无「全部批准」
 */

vi.mock("../src/api/evidence.js", () => ({
  listValueChangeRequests: vi.fn(),
  decideValueChangeRequests: vi.fn(),
  getQualityGate: vi.fn(),
  reevaluateQualityGate: vi.fn(),
}));

import { decideValueChangeRequests, listValueChangeRequests } from "../src/api/evidence.js";

const item = (id: string, layer: QualityReportView["layers"]["L0"]["layer"], status: QualityReportView["layers"]["L0"]["status"], evidenceGrade: string, required = true) => ({
  id, layer, sourceStatus: status, status, required, evidenceGrade, detail: `${id} detail`,
});

function report(): QualityReportView {
  const layer = (id: "L0" | "L1" | "L2" | "L3" | "L4", status: QualityReportView["layers"]["L0"]["status"], items: ReturnType<typeof item>[]) => ({
    layer: id, title: `${id} title`, status, items, blocking: items.filter((entry) => entry.status !== "PASS").map((entry) => entry.id), unknowns: [],
  });
  return {
    schemaVersion: "quality-report/v1",
    generatedAt: "2026-11-01T00:00:00.000Z",
    binding: { reviewedRevision: 3, reviewRound: 2, inputFingerprint: "f", runId: "w-1", entry: "workflow", workflowKind: "existing_paper_improvement", reviewPurpose: "author_manuscript" },
    layers: {
      L0: layer("L0", "NOT_EVALUATED", [item("review_coverage_complete", "L0", "NOT_EVALUATED", "deterministic")]),
      L1: layer("L1", "FAIL", [item("cross_section_numeric_consistency", "L1", "FAIL", "deterministic")]),
      L2: layer("L2", "NEEDS_VERIFICATION", [item("open_critical_major_zero", "L2", "NEEDS_VERIFICATION", "llm_judgment", false)]),
      L3: layer("L3", "NOT_APPLICABLE", []),
      L4: layer("L4", "UNVALIDATED", [item("target_journal_level", "L4", "UNVALIDATED", "unclassified", false)]),
    },
    overall: { status: "FAIL", finalizable: false, reasons: [], unknowns: [], statement: "存在已证实的缺陷（确定性核验 / 作者数据复算 / 元数据核验）——需修正后重新评估" },
    compat: { legacyPassedDerived: false, rulePassedBeforeReport: false, difference: null, meaning: "" },
    externalValidity: { independentHumanLabels: 0, scoreCalibrated: false, targetJournalValidated: false, statement: "分数与目标期刊层未经独立人类标签校准" },
  };
}

const REQUEST: ValueChangeRequestView = {
  requestId: "vcr-1", target: "sections/results.tex", before: "61.2", after: "61.7",
  context: "Our tracker reaches 61.2 MOTA and 58.4 IDF1.", proposedContext: "Our tracker reaches 61.7 MOTA and 58.4 IDF1.",
  baselineHash: "b", baseRevision: 3, source: { runId: "w-1", stageId: "revision.revise", instructionIds: [], planItemIds: [], violation: "受保护数值 61.2 被替换" },
  createdAt: "2026-11-01T00:00:00.000Z", status: "pending", boundHash: "bound-hash-1",
};

beforeEach(() => {
  vi.mocked(listValueChangeRequests).mockReset();
  vi.mocked(decideValueChangeRequests).mockReset();
});

describe("QualityReportLayers", () => {
  it("三类失败原因可区分：已证实（确定性）/ AI 意见待核验 / 必需核验未完成；L4 未经独立校准", () => {
    renderWithProviders(<QualityReportLayers report={report()} />);
    expect(screen.getByTestId("quality-report-overall").textContent).toContain("已证实缺陷");
    const l1 = screen.getByTestId("quality-layer-L1");
    expect(l1.textContent).toContain("确定性核验");
    expect(l1.textContent).toContain("未通过");
    const l2 = screen.getByTestId("quality-layer-L2");
    expect(l2.textContent).toContain("模型判断（未核验）");
    expect(l2.textContent).toContain("AI 意见待核验");
    expect(screen.getByTestId("quality-layer-L0").textContent).toContain("必需核验未完成");
    expect(screen.getByTestId("quality-layer-L4").getAttribute("data-status")).toBe("UNVALIDATED");
    expect(screen.getByTestId("quality-layer-L4").textContent).toContain("未经独立校准");
    expect(screen.getByTestId("quality-report-external-validity").textContent).toContain("独立人类标签 0");
  });
});

describe("ValueChangeRequestsPanel", () => {
  it("逐项批准：未勾选核对不可批准；批准请求回传所见 boundHash", async () => {
    vi.mocked(listValueChangeRequests).mockResolvedValue([REQUEST]);
    vi.mocked(decideValueChangeRequests).mockResolvedValue([{ ...REQUEST, status: "approved", approvalId: "a" }]);
    renderWithProviders(<ValueChangeRequestsPanel projectId="p-1" />);
    const approve = await screen.findByTestId("value-change-approve");
    expect(screen.getByTestId("value-change-request").textContent).toContain("61.2");
    expect(screen.getByTestId("value-change-request").textContent).toContain("61.7");
    expect(approve).toBeDisabled();
    expect(screen.queryByText(/全部批准/)).toBeNull();
    await userEvent.click(screen.getByTestId("value-change-ack"));
    expect(approve).toBeEnabled();
    await userEvent.click(approve);
    await waitFor(() => expect(decideValueChangeRequests).toHaveBeenCalledWith("p-1", [{ requestId: "vcr-1", decision: "approve", boundHash: "bound-hash-1" }]));
  });

  it("无请求时不渲染", async () => {
    vi.mocked(listValueChangeRequests).mockResolvedValue([]);
    const { container } = renderWithProviders(<ValueChangeRequestsPanel projectId="p-1" />);
    await waitFor(() => expect(listValueChangeRequests).toHaveBeenCalled());
    expect(container.querySelector("[data-testid=value-change-requests]")).toBeNull();
  });
});
