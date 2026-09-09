import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { WorkflowPanel } from "../src/components/project/WorkflowPanel.js";
import type { WorkflowRunView } from "../src/types/api.js";
import { renderWithProviders } from "./helpers.js";

/**
 * 工作流实时视图（M4.4）：
 * - 运行中：时间线状态、17/33 进度（active / queued / retried / failed）、取消入口
 * - 取消：确认文案 → pending 禁用 → 已取消
 * - 失败 / awaiting_input / 已完成状态各自的可读呈现
 * - 刷新恢复：进度快照来自 GET run 列表（渲染即恢复，无需从打开页面前盯守）
 * - 开发者字段（runId）只在折叠的详细信息里
 */

vi.mock("../src/api/runs.js", () => ({
  listProjectRuns: vi.fn(),
  cancelWorkflowRun: vi.fn(),
  createWorkflowRun: vi.fn(),
  resumeWorkflowRun: vi.fn(),
}));

vi.mock("../src/api/paper.js", () => ({
  exportReviewReport: vi.fn(),
}));

const runsApi = await import("../src/api/runs.js");

function runFixture(overrides: Partial<WorkflowRunView> = {}): WorkflowRunView {
  return {
    runId: "w-flow0001",
    projectId: "p-flow0001",
    workflowKind: "existing_paper_review",
    status: "running",
    currentStage: "review.sections",
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:10:00.000Z",
    startedAt: "2026-09-09T00:00:05.000Z",
    awaiting: null,
    error: null,
    completion: null,
    progress: {
      stageId: "review.sections",
      data: { section: "SEC17", completed: 17, total: 33, started: 20, failed: 0, retried: 1, findings: 42 },
      updatedAt: "2026-09-09T00:09:30.000Z",
    },
    completedStages: ["paper.ensure", "citation.extract", "citation.metadata"],
    stageHistory: [
      { stageId: "paper.ensure", attempt: 1, status: "completed", startedAt: "2026-09-09T00:00:05.000Z", finishedAt: "2026-09-09T00:01:00.000Z" },
      { stageId: "citation.extract", attempt: 1, status: "completed", startedAt: "2026-09-09T00:01:00.000Z", finishedAt: "2026-09-09T00:01:30.000Z" },
      { stageId: "citation.metadata", attempt: 1, status: "completed", startedAt: "2026-09-09T00:01:30.000Z", finishedAt: "2026-09-09T00:03:00.000Z" },
    ],
    ...overrides,
  };
}

function mockRuns(runs: WorkflowRunView[]) {
  vi.mocked(runsApi.listProjectRuns).mockResolvedValue(runs);
}

const noop = () => {};

describe("WorkflowPanel 运行中", () => {
  beforeEach(() => {
    vi.mocked(runsApi.cancelWorkflowRun).mockReset();
  });

  it("时间线状态 + 17/33 进度 + 运行中 / 等待 / 已重试 / 失败 + 取消入口", async () => {
    mockRuns([runFixture()]);
    renderWithProviders(<WorkflowPanel projectId="p-flow0001" onOpenTab={noop} connection="open" />);

    const timeline = await screen.findByTestId("stage-timeline");
    // 已完成 3 个 stage
    expect(timeline.querySelector('[data-stage="paper.ensure"]')?.getAttribute("data-stage-state")).toBe("completed");
    expect(timeline.querySelector('[data-stage="citation.extract"]')?.getAttribute("data-stage-state")).toBe("completed");
    // 当前 stage 运行中；后续 pending
    expect(timeline.querySelector('[data-stage="review.sections"]')?.getAttribute("data-stage-state")).toBe("running");
    expect(timeline.querySelector('[data-stage="review.aggregate"]')?.getAttribute("data-stage-state")).toBe("pending");

    const progress = screen.getByTestId("section-progress");
    expect(progress).toHaveTextContent("17");
    expect(progress).toHaveTextContent("33");
    // active = 20 - 17 - 0 = 3；queued = 33 - 20 = 13
    expect(progress).toHaveTextContent("运行中 3");
    expect(progress).toHaveTextContent("等待 13");
    expect(progress).toHaveTextContent("已重试 1");
    expect(progress).toHaveTextContent("失败 0");
    expect(progress).toHaveTextContent("已记录发现 42");

    // 取消入口 + 实时连接状态
    expect(screen.getByTestId("cancel-run")).toBeEnabled();
    expect(screen.getByTestId("workflow-connection")).toHaveTextContent("实时同步中");
    // runId 是开发者字段：只出现在折叠的「详细信息」里（正文不展示）
    expect(screen.getByTestId("workflow-details").querySelector(".mono")).toHaveTextContent("w-flow0001");
  });

  it("刷新后直接从 GET 状态恢复（不需要从打开页面前盯守）", async () => {
    // 进度快照是 run 列表 DTO 的一部分：重新挂载即恢复（本测试即"刷新"语义）
    mockRuns([runFixture()]);
    renderWithProviders(<WorkflowPanel projectId="p-flow0001" onOpenTab={noop} connection="connecting" />);
    expect(await screen.findByTestId("section-progress")).toHaveTextContent("17");
    expect(screen.getByTestId("workflow-connection")).toHaveTextContent("连接中");
  });

  it("取消：确认文案 → 确认后 pending（不重复发请求）→ 已取消", async () => {
    const user = userEvent.setup();
    mockRuns([runFixture()]);
    let resolveCancel: ((run: WorkflowRunView) => void) | undefined;
    vi.mocked(runsApi.cancelWorkflowRun).mockImplementation(
      () =>
        new Promise<WorkflowRunView>((resolve) => {
          resolveCancel = resolve;
        }),
    );
    renderWithProviders(<WorkflowPanel projectId="p-flow0001" onOpenTab={noop} connection="open" />);

    await user.click(await screen.findByTestId("cancel-run"));
    expect(screen.getByTestId("cancel-confirm")).toHaveTextContent("已完成的阶段与结果会保留");
    await user.click(screen.getByRole("button", { name: "取消任务" }));

    // pending 期间确认按钮转为「处理中…」并禁用（重复点击不会发出更多请求），且只发了一次 cancel
    expect(screen.getByRole("button", { name: "处理中…" })).toBeDisabled();
    expect(vi.mocked(runsApi.cancelWorkflowRun)).toHaveBeenCalledTimes(1);

    await act(async () => {
      // 真实后端语义：cancelled 保留 currentStage（在途 stage 被中断的位置）
      resolveCancel?.(runFixture({ status: "cancelled", progress: null }));
    });
    const cancelledNote = await screen.findByTestId("workflow-cancelled");
    expect(cancelledNote).toHaveTextContent("任务已取消");
    // 中断的 stage 在时间线上显示已取消
    expect(screen.getByTestId("stage-timeline").querySelector('[data-stage="review.sections"]')?.getAttribute("data-stage-state")).toBe("cancelled");
  });
});

describe("WorkflowPanel 终态", () => {
  it("failed：失败阶段 + 稳定文案 + 重试建议 + 折叠技术详情", async () => {
    mockRuns([
      runFixture({
        status: "failed",
        currentStage: "review.sections",
        progress: null,
        error: { code: "AGENT_RUN_FAILED", message: '分章节审阅全部失败（33 节），最近错误：503 {"error":"upstream"}' },
        completedStages: ["paper.ensure", "citation.extract", "citation.metadata"],
      }),
    ]);
    renderWithProviders(<WorkflowPanel projectId="p-flow0001" onOpenTab={noop} connection="closed" />);
    const failed = await screen.findByTestId("workflow-failed");
    expect(failed).toHaveTextContent("任务失败");
    expect(failed).toHaveTextContent("分章节审阅");
    expect(failed).toHaveTextContent("重新开始");
  });

  it("awaiting_input：HITL 决策面板 + 时间线等待确认（M4.5）", async () => {
    mockRuns([
      runFixture({
        workflowKind: "idea_to_paper",
        status: "awaiting_input",
        currentStage: "hitl.feasibility_confirm",
        progress: null,
        awaiting: { stageId: "hitl.feasibility_confirm", prompt: "可行性评估完成，请确认", options: ["approve", "adjust", "cancel"] },
        completedStages: ["research.idea", "research.feasibility"],
      }),
    ]);
    renderWithProviders(<WorkflowPanel projectId="p-flow0001" onOpenTab={noop} connection="open" />);
    const hitl = await screen.findByTestId("hitl-panel");
    expect(hitl).toHaveTextContent("等待你的确认");
    expect(hitl).toHaveTextContent("可行性评估完成，请确认");
    expect(hitl).toHaveTextContent("等待确认可行性");
    expect(screen.getByTestId("hitl-approve")).toBeEnabled();
    const timeline = screen.getByTestId("stage-timeline");
    expect(timeline.querySelector('[data-stage="hitl.feasibility_confirm"]')?.getAttribute("data-stage-state")).toBe("awaiting");
  });

  it("completed：总耗时 + 阶段数 + 结果入口（Review / 引用核验 / 导出）", async () => {
    const user = userEvent.setup();
    mockRuns([
      runFixture({
        status: "completed",
        currentStage: undefined,
        progress: null,
        finishedAt: "2026-09-09T00:20:00.000Z",
        completion: { label: "review" },
        completedStages: ["paper.ensure", "citation.extract", "citation.metadata", "review.sections", "review.aggregate"],
        stageHistory: [
          {
            stageId: "review.sections",
            attempt: 1,
            status: "completed",
            startedAt: "2026-09-09T00:03:00.000Z",
            finishedAt: "2026-09-09T00:19:00.000Z",
            summaryNumbers: { sectionsReviewed: 33, sectionsTotal: 33, findingsTotal: 42 },
            concurrency: { configured: 3, maxObserved: 3 },
          },
        ],
      }),
    ]);
    const onOpenTab = vi.fn();
    renderWithProviders(<WorkflowPanel projectId="p-flow0001" onOpenTab={onOpenTab} connection="closed" />);
    const completed = await screen.findByTestId("workflow-completed");
    expect(completed).toHaveTextContent("任务已完成");
    expect(completed).toHaveTextContent("Review 报告");
    expect(completed).toHaveTextContent("33 / 33 节");
    await user.click(screen.getByTestId("goto-review"));
    expect(onOpenTab).toHaveBeenCalledWith("review");
    expect(screen.getByRole("button", { name: "查看引用核验" })).toBeEnabled();
    expect(screen.getByRole("button", { name: /导出报告/ })).toBeEnabled();
  });

  it("历史运行列表：多条 run 可切换查看", async () => {
    const user = userEvent.setup();
    const latest = runFixture();
    const older = runFixture({
      runId: "w-flow0000",
      status: "completed",
      currentStage: undefined,
      progress: null,
      finishedAt: "2026-09-08T00:20:00.000Z",
      completion: { label: "review" },
      completedStages: ["paper.ensure", "citation.extract", "citation.metadata", "review.sections", "review.aggregate"],
    });
    mockRuns([latest, older]);
    renderWithProviders(<WorkflowPanel projectId="p-flow0001" onOpenTab={noop} connection="open" />);

    await screen.findByTestId("section-progress");
    await user.click(screen.getByTestId("run-history-1"));
    // 切到历史（已完成）run 后显示完成态，不再显示运行中进度块
    expect(await screen.findByTestId("workflow-completed")).toBeInTheDocument();
    expect(screen.queryByTestId("section-progress")).toBeNull();
  });
});
