import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { MissingMaterialPanel } from "../src/components/project/MissingMaterialPanel.js";
import { renderWithProviders } from "./helpers.js";
import type { MissingMaterialGap, MissingMaterialLedger } from "../src/api/thesisMissingMaterials.js";

vi.mock("../src/api/thesisMissingMaterials.js", () => ({
  getMissingMaterialLedger: vi.fn(),
  submitMissingMaterialDecision: vi.fn(),
}));
const api = await import("../src/api/thesisMissingMaterials.js");

function ledgerOf(gaps: MissingMaterialGap[]): MissingMaterialLedger {
  return { schemaVersion: 1, projectId: "p-test", gaps, updatedAt: "2026-10-16T00:00:00Z" };
}

const plannedGap: MissingMaterialGap = {
  gapId: "gap-planned-1",
  gapType: "planned_chapter_material",
  origin: "deterministic",
  chapterId: "ch-4",
  chapterTitleZh: "第四章 消融实验",
  contributionIds: ["c1"],
  sourceInputIds: ["ri-1"],
  title: "消融实验缺少逐模块对比数据",
  description: "大纲规划的消融实验章节没有对应实验观测。",
  whyInsufficient: "研究输入中没有逐模块消融的指标表",
  supportingEvidence: [],
  requiredMaterials: [
    { kind: "experiment_data", description: "各模块去除后的 HOTA / IDF1 表" },
    { kind: "author_confirmation", description: "确认消融实验是否已实际完成" },
  ],
  canWriteWithoutMaterial: false,
  requiresExperiment: true,
  status: "confirmed_missing",
  createdAt: "2026-10-16T00:00:00Z",
  updatedAt: "2026-10-16T00:00:00Z",
};

const scopeGap: MissingMaterialGap = {
  gapId: "gap-scope-1",
  gapType: "proposed_scope_gap",
  origin: "model_proposal",
  contributionIds: [],
  sourceInputIds: [],
  title: "建议补充跨数据集泛化实验",
  description: "模型认为论文论证需要跨数据集泛化结果。",
  whyInsufficient: "当前材料仅覆盖单一数据集",
  supportingEvidence: [],
  requiredMaterials: [{ kind: "manuscript", description: "泛化实验相关手稿段落" }],
  canWriteWithoutMaterial: true,
  requiresExperiment: true,
  status: "proposed",
  createdAt: "2026-10-16T00:00:00Z",
  updatedAt: "2026-10-16T00:00:00Z",
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(api.getMissingMaterialLedger).mockResolvedValue(ledgerOf([]));
  vi.mocked(api.submitMissingMaterialDecision).mockImplementation(async (_projectId, gapId, decision) => ({
    gap: { ...plannedGap, gapId, decision },
    decisionId: "d-1",
  }));
});

describe("MissingMaterialPanel（研究材料缺口）", () => {
  it("账本为空时显示空态说明与边界声明", async () => {
    renderWithProviders(<MissingMaterialPanel projectId="p-test" />);
    expect(await screen.findByText("尚无材料缺口记录（Planner 确认章节映射并完成证据供给后生成）")).toBeInTheDocument();
    expect(screen.getByText("缺口只有作者决定后才会影响写作；系统不会为缺失材料生成任何实验数值。")).toBeInTheDocument();
    expect(api.getMissingMaterialLedger).toHaveBeenCalledWith("p-test");
  });

  it("渲染已规划章节缺口的字段、所需材料与作者操作按钮", async () => {
    vi.mocked(api.getMissingMaterialLedger).mockResolvedValue(ledgerOf([plannedGap]));
    renderWithProviders(<MissingMaterialPanel projectId="p-test" />);
    const item = within(await screen.findByTestId("missing-material-gap-gap-planned-1"));
    expect(item.getByText("消融实验缺少逐模块对比数据")).toBeInTheDocument();
    expect(item.getByText("已规划章节缺材料")).toBeInTheDocument();
    expect(item.getByText("系统检测")).toBeInTheDocument();
    expect(item.getByText("已确认缺失")).toBeInTheDocument();
    expect(item.getByText("对应章节：第四章 消融实验")).toBeInTheDocument();
    expect(item.getByText("原因：研究输入中没有逐模块消融的指标表")).toBeInTheDocument();
    expect(item.getByText("实验数据")).toBeInTheDocument();
    expect(item.getByText("作者确认")).toBeInTheDocument();
    expect(item.getByText("各模块去除后的 HOTA / IDF1 表")).toBeInTheDocument();
    expect(item.getByText("须等待真实材料")).toBeInTheDocument();
    for (const name of ["补充实验数据", "补充研究记录", "补充研究手稿", "作为研究限制说明", "暂缓该章"]) {
      expect(item.getByRole("button", { name })).toBeEnabled();
    }
    expect(item.queryByRole("button", { name: "确认为缺口" })).not.toBeInTheDocument();
    expect(item.queryByText("上游材料已变化，需重新评估")).not.toBeInTheDocument();
  });

  it("点击「作为研究限制说明」提交 write_as_limitation 并刷新账本", async () => {
    vi.mocked(api.getMissingMaterialLedger).mockResolvedValue(ledgerOf([plannedGap]));
    vi.mocked(api.submitMissingMaterialDecision).mockImplementation(async (_projectId, gapId, decision) => {
      const updated: MissingMaterialGap = { ...plannedGap, gapId, decision, status: "resolved" };
      vi.mocked(api.getMissingMaterialLedger).mockResolvedValue(ledgerOf([updated]));
      return { gap: updated, decisionId: "d-2" };
    });
    renderWithProviders(<MissingMaterialPanel projectId="p-test" />);
    await userEvent.click(await screen.findByRole("button", { name: "作为研究限制说明" }));
    await waitFor(() =>
      expect(api.submitMissingMaterialDecision).toHaveBeenCalledWith("p-test", "gap-planned-1", "write_as_limitation", expect.any(String)),
    );
    // 刷新后状态变为已解决，按钮随之禁用
    expect(await screen.findByText("已解决")).toBeInTheDocument();
    expect(await screen.findByRole("status")).toHaveTextContent("作为研究限制说明");
    expect(api.getMissingMaterialLedger).toHaveBeenCalledTimes(2);
    await waitFor(() => expect(screen.getByRole("button", { name: "作为研究限制说明" })).toBeDisabled());
  });

  it("研究范围建议显示「确认为缺口 / 排除该建议」与模型建议徽章", async () => {
    vi.mocked(api.getMissingMaterialLedger).mockResolvedValue(ledgerOf([scopeGap]));
    renderWithProviders(<MissingMaterialPanel projectId="p-test" />);
    const item = within(await screen.findByTestId("missing-material-gap-gap-scope-1"));
    expect(item.getByText("研究范围建议（待作者确认）")).toBeInTheDocument();
    expect(item.getByText("模型建议")).toBeInTheDocument();
    expect(item.getByText("建议中")).toBeInTheDocument();
    expect(item.getByText("对应章节：—")).toBeInTheDocument();
    expect(item.getByText("可先以理论/限制口径撰写")).toBeInTheDocument();
    expect(item.getByRole("button", { name: "确认为缺口" })).toBeEnabled();
    expect(item.getByRole("button", { name: "排除该建议" })).toBeEnabled();
    expect(item.getByRole("button", { name: "补充研究手稿" })).toBeEnabled();
    expect(item.queryByRole("button", { name: "暂缓该章" })).not.toBeInTheDocument();
    await userEvent.click(item.getByRole("button", { name: "排除该建议" }));
    await waitFor(() =>
      expect(api.submitMissingMaterialDecision).toHaveBeenCalledWith("p-test", "gap-scope-1", "reject", expect.any(String)),
    );
  });

  it("已解决的缺口按钮禁用；stale 的已解决缺口重新可操作并显示提示", async () => {
    const resolved: MissingMaterialGap = { ...plannedGap, gapId: "gap-resolved", status: "resolved", decision: "write_as_limitation" };
    const staleResolved: MissingMaterialGap = {
      ...plannedGap,
      gapId: "gap-stale",
      status: "resolved",
      stale: { since: "2026-10-16T01:00:00Z", reason: "研究输入版本已更新" },
    };
    vi.mocked(api.getMissingMaterialLedger).mockResolvedValue(ledgerOf([resolved, staleResolved]));
    renderWithProviders(<MissingMaterialPanel projectId="p-test" />);
    const resolvedItem = within(await screen.findByTestId("missing-material-gap-gap-resolved"));
    for (const button of resolvedItem.getAllByRole("button")) expect(button).toBeDisabled();
    const staleItem = within(screen.getByTestId("missing-material-gap-gap-stale"));
    expect(staleItem.getByText("上游材料已变化，需重新评估")).toBeInTheDocument();
    for (const button of staleItem.getAllByRole("button")) expect(button).toBeEnabled();
  });
});
