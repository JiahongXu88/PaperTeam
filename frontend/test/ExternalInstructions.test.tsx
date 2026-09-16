import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ExternalInstructionsPanel } from "../src/components/project/ExternalInstructionsPanel.js";
import { RevisionPlanPanel } from "../src/components/project/RevisionPlanPanel.js";
import type {
  ExternalInstructionView,
  RevisionPlanView,
} from "../src/types/api.js";
import { renderWithProviders } from "./helpers.js";

/**
 * M5.7 外部修改意见 + 修订计划展示：
 * - 表单：来源 / Reviewer 标识 / 涉及章节 / 意见原文 → 添加到修改计划
 * - 状态徽章（已处理 / 未处理 / 冲突）与冲突依据展示
 * - RevisionPlan：来源与优先级（MUST · Reviewer 2）、原文折叠、conflict 关联
 */

vi.mock("../src/api/externalInstructions.js", () => ({
  listExternalInstructions: vi.fn(),
  addExternalInstruction: vi.fn(),
  deleteExternalInstruction: vi.fn(),
  getRevisionPlan: vi.fn(),
}));

const api = vi.mocked(await import("../src/api/externalInstructions.js"));

const NOW = "2026-09-16T12:00:00.000Z";

function instructionView(overrides: Partial<ExternalInstructionView> = {}): ExternalInstructionView {
  return {
    instructionId: "x-abc123",
    source: "journal_reviewer",
    reviewerLabel: "Reviewer 2",
    text: "请补充高密度场景的失效原因分析。",
    status: "pending",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("ExternalInstructionsPanel（M5.7）", () => {
  it("添加意见：来源 / 标识 / 章节 / 原文 → addExternalInstruction 收到完整 payload", async () => {
    api.listExternalInstructions.mockResolvedValue({
      instructions: [],
      sectionOptions: ["sections/introduction.tex", "sections/experiments.tex"],
    });
    api.addExternalInstruction.mockResolvedValue(instructionView());
    const user = userEvent.setup();
    renderWithProviders(<ExternalInstructionsPanel projectId="p-1" />, {
      route: "/projects/p-1?tab=review",
    });

    await screen.findByTestId("external-instructions-panel");
    await user.selectOptions(screen.getByTestId("external-source-select"), "advisor");
    await user.type(screen.getByTestId("external-reviewer-label"), "Reviewer 2");
    await user.selectOptions(screen.getByTestId("external-section-select"), "sections/experiments.tex");
    await user.type(
      screen.getByTestId("external-text-input"),
      "1. 请补充与 ByteTrack 的对比。\n2. 第 3.7 节需要弱化显著性表述。",
    );
    fireEvent.click(screen.getByTestId("add-external-instruction"));

    await waitFor(() => expect(api.addExternalInstruction).toHaveBeenCalledTimes(1));
    expect(api.addExternalInstruction).toHaveBeenCalledWith("p-1", {
      source: "advisor",
      reviewerLabel: "Reviewer 2",
      section: "sections/experiments.tex",
      text: "1. 请补充与 ByteTrack 的对比。\n2. 第 3.7 节需要弱化显著性表述。",
    });
  });

  it("conflict 意见：状态徽章 + 依据 + 可选建议；删除走确认", async () => {
    const conflicting = instructionView({
      status: "conflict",
      conflictBasis: "Table 10：baseline IDS = 24，本文 IDS = 35",
      statusNote: "该意见与稿件实验事实 / Evidence 冲突：系统未篡改事实，保留原结果并报告冲突",
    });
    api.listExternalInstructions.mockResolvedValue({
      instructions: [conflicting],
      sectionOptions: [],
    });
    api.deleteExternalInstruction.mockResolvedValue([]);
    renderWithProviders(<ExternalInstructionsPanel projectId="p-1" />, {
      route: "/projects/p-1?tab=review",
    });

    expect(await screen.findByTestId("external-instruction-x-abc123")).toBeInTheDocument();
    expect(screen.getByTestId("external-status-x-abc123")).toHaveTextContent("与事实 / Evidence 冲突");
    expect(screen.getByTestId("external-conflict-x-abc123")).toHaveTextContent("baseline IDS = 24");
    expect(screen.getByTestId("external-conflict-x-abc123")).toHaveTextContent("需要补充新的实验 Evidence");
    // 原文逐字保存
    expect(screen.getByText("请补充高密度场景的失效原因分析。")).toBeInTheDocument();
    // 必须处理徽章
    expect(screen.getByText("必须处理")).toBeInTheDocument();

    fireEvent.click(screen.getByTestId("external-remove-x-abc123"));
    fireEvent.click(screen.getByTestId("external-remove-confirm-x-abc123"));
    await waitFor(() => expect(api.deleteExternalInstruction).toHaveBeenCalledWith("p-1", "x-abc123"));
  });

  it("handled / unresolved / partially_handled 状态徽章如实展示", async () => {
    api.listExternalInstructions.mockResolvedValue({
      instructions: [
        instructionView({ instructionId: "x-done", status: "handled", reviewerLabel: undefined }),
        instructionView({ instructionId: "x-part", status: "partially_handled", text: "B", reviewerLabel: undefined }),
        instructionView({ instructionId: "x-open", status: "unresolved", text: "C", reviewerLabel: undefined }),
      ],
      sectionOptions: [],
    });
    renderWithProviders(<ExternalInstructionsPanel projectId="p-1" />, {
      route: "/projects/p-1?tab=review",
    });
    expect(await screen.findByTestId("external-status-x-done")).toHaveTextContent("已处理");
    expect(screen.getByTestId("external-status-x-part")).toHaveTextContent("部分处理");
    expect(screen.getByTestId("external-status-x-open")).toHaveTextContent("未处理");
  });

  it("空意见为空态（行为与未加入功能前一致的提示）", async () => {
    api.listExternalInstructions.mockResolvedValue({ instructions: [], sectionOptions: [] });
    renderWithProviders(<ExternalInstructionsPanel projectId="p-1" />, {
      route: "/projects/p-1?tab=review",
    });
    expect(await screen.findByText(/暂无外部修改意见/)).toBeInTheDocument();
  });
});

describe("RevisionPlanPanel（M5.7）", () => {
  const plan: RevisionPlanView = {
    schemaVersion: 1,
    planId: "plan-r2-rev2",
    projectId: "p-1",
    sourceRevision: 2,
    reviewRound: 2,
    createdAt: NOW,
    summary: { critical: 1, major: 1, blocking: 0, minorRecorded: 0, planned: 3, skipped: 1, external: 2 },
    items: [
      {
        id: "external:x-abc123",
        kind: "external_instruction",
        priority: "mandatory",
        section: "(global)",
        problem: "外部修改意见（期刊外审专家 · Reviewer 2）：请补充高密度场景失效原因",
        instruction: "意见原文…",
        expectedOutcome: "在事实约束内落实",
        status: "planned",
        source: "external",
        reviewerLabel: "Reviewer 2",
        sourceText: "Reviewer 2:\n1. 请补充高密度场景的失效原因分析。",
        instructionId: "x-abc123",
      },
      {
        id: "f-deadbeef",
        kind: "review_finding",
        priority: "high",
        section: "sections/experiments.tex",
        problem: "解释检测召回下降原因",
        instruction: "针对问题修改",
        expectedOutcome: "复审不再出现",
        status: "planned",
      },
      {
        id: "external:x-conf",
        kind: "external_instruction",
        priority: "mandatory",
        section: "sections/experiments.tex",
        problem: "外部修改意见（编辑）：说明低照度优势",
        instruction: "意见原文…",
        expectedOutcome: "冲突时如实报告",
        status: "skipped",
        note: "与稿件实验事实 / Evidence 冲突，不自动执行：Table 10 IDS 24 vs 35",
        source: "external",
        reviewerLabel: "编辑",
        sourceText: "请说明低照度优势。",
        instructionId: "x-conf",
      },
    ],
  };

  it("展示来源与优先级（MUST · Reviewer 2）；外部条目原文折叠可展开", async () => {
    api.getRevisionPlan.mockResolvedValue({ round: 2, plan });
    api.listExternalInstructions.mockResolvedValue({ instructions: [], sectionOptions: [] });
    const user = userEvent.setup();
    renderWithProviders(<RevisionPlanPanel projectId="p-1" />, {
      route: "/projects/p-1?tab=review",
    });
    const panel = await screen.findByTestId("revision-plan-panel");
    expect(withinPanel(panel, "MUST")).toBeTruthy();
    expect(withinPanel(panel, "Reviewer 2")).toBeTruthy();
    expect(withinPanel(panel, "内部审稿 / 确定性规则")).toBeTruthy();
    // 外部条目原文折叠展开
    const summary = panel.querySelectorAll("details summary");
    expect(summary.length).toBe(2);
    await user.click(summary[0]!);
    expect(panel.textContent).toContain("请补充高密度场景的失效原因分析。");
  });

  it("conflict 状态从意见存储按 instructionId 关联展示", async () => {
    api.getRevisionPlan.mockResolvedValue({ round: 2, plan });
    api.listExternalInstructions.mockResolvedValue({
      instructions: [
        instructionView({ instructionId: "x-conf", status: "conflict", conflictBasis: "Table 10：IDS 24 vs 35" }),
      ],
      sectionOptions: [],
    });
    renderWithProviders(<RevisionPlanPanel projectId="p-1" />, {
      route: "/projects/p-1?tab=review",
    });
    const panel = await screen.findByTestId("revision-plan-panel");
    expect(panel.textContent).toContain("与事实冲突");
    expect(panel.textContent).toContain("IDS 24 vs 35");
  });

  it("无计划时不渲染（不占位）", async () => {
    api.getRevisionPlan.mockResolvedValue({ round: null, plan: null });
    api.listExternalInstructions.mockResolvedValue({ instructions: [], sectionOptions: [] });
    const { container } = renderWithProviders(<RevisionPlanPanel projectId="p-1" />, {
      route: "/projects/p-1?tab=review",
    });
    await waitFor(() => expect(api.getRevisionPlan).toHaveBeenCalled());
    expect(container.querySelector('[data-testid="revision-plan-panel"]')).toBeNull();
  });
});

function withinPanel(panel: HTMLElement, text: string): boolean {
  return [...panel.querySelectorAll("*")].some((node) => node.textContent === text);
}
