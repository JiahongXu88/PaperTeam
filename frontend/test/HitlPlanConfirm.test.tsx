import { beforeEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { HitlPanel } from "../src/components/project/HitlPanel.js";
import { readPlanConfirmItems, summarizePlanConfirm } from "../src/components/project/planConfirmView.js";
import type { WorkflowRunView } from "../src/types/api.js";
import { renderWithProviders } from "./helpers.js";

/**
 * M14.9.1 C0：改进计划确认（hitl.plan_confirm）的 actionType / 处置透明度。
 *
 * 失败形态（M14.9 §7.5 真实返修）：Planner 把一条写了具体改法的条目标为
 * author_decision_required，计划确认面板只显示「章节 → 动作 → 优先级」，作者批准后才发现
 * 该条从未派发。本组用例锁定：每条显示 actionType 与处置；未派发条目批准前集中汇总，
 * 必须勾选「已知悉」才能批准（批准不改变动作类型）；>25 条折叠 / 筛选 / 键盘操作；
 * 「已知悉」刷新后保留、计划被重做后失效；对应外部意见的闭环状态按 instructionId 关联。
 */

vi.mock("../src/api/runs.js", () => ({
  listProjectRuns: vi.fn(),
  cancelWorkflowRun: vi.fn(),
  createWorkflowRun: vi.fn(),
  resumeWorkflowRun: vi.fn(),
}));

vi.mock("../src/api/externalInstructions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api/externalInstructions.js")>()),
  listExternalInstructions: vi.fn(async () => ({
    instructions: [
      { instructionId: "x-open", source: "journal_reviewer", text: "核对 165.2 与 165.4", status: "pending", statusNote: "AUTHOR_DECISION_REQUIRED: …", createdAt: "2026-10-18T00:00:00.000Z", updatedAt: "2026-10-18T00:00:00.000Z" },
      { instructionId: "x-done", source: "journal_reviewer", text: "删除修订痕迹", status: "handled", createdAt: "2026-10-18T00:00:00.000Z", updatedAt: "2026-10-18T00:00:00.000Z" },
    ],
    sectionOptions: [],
  })),
}));

const runsApi = await import("../src/api/runs.js");

/** 26 条计划：23 modify + 2 author_decision_required + 1 evidence_only（与 M14.9 第 1 轮同构） */
function planItems(overrides: Array<Record<string, unknown>> = []): Array<Record<string, unknown>> {
  const items: Array<Record<string, unknown>> = Array.from({ length: 23 }, (_, index) => ({
    id: `improvement:${index + 1}`, section: "main.tex", logicalSection: `sec:s${index + 1}`,
    action: `修订第 ${index + 1} 处措辞`, actionType: "modify", rationale: `理由 ${index + 1}`, priority: index % 2 === 0 ? "high" : "medium",
    instructionId: index === 0 ? "x-done" : `x-${index}`, relatedEvidenceIds: [], expectedFactChanges: [],
  }));
  items.push(
    { id: "improvement:24", section: "main.tex", logicalSection: "sec:exp-rdk", action: "第二段推算式 165.2 是否改为与表 rdk 一致的 165.4，由作者确认后执行", actionType: "author_decision_required", rationale: "决策点：作者需核对计时日志", priority: "medium", instructionId: "x-open", relatedEvidenceIds: [], expectedFactChanges: [] },
    { id: "improvement:25", section: "main.tex", logicalSection: "sec:exp-scenes", action: "把「3 至 5 个来源视频」拆为高密度 3 个、低照度 5 个", actionType: "author_decision_required", rationale: "需要核对冻结场景标签", priority: "high", relatedEvidenceIds: [], expectedFactChanges: [{ before: "3 至 5", after: "3" }] },
    { id: "improvement:26", section: "main.tex", logicalSection: "sec:related", action: "为 BoostTrack 描述挂接原文证据", actionType: "evidence_only", rationale: "只建立证据关联", priority: "low", relatedEvidenceIds: ["E001"], expectedFactChanges: [] },
    ...overrides,
  );
  return items;
}

function planRun(items: Array<Record<string, unknown>>): WorkflowRunView {
  return {
    runId: "w-plan00001",
    projectId: "p-plan00001",
    workflowKind: "existing_paper_improvement",
    status: "awaiting_input",
    currentStage: "hitl.plan_confirm",
    createdAt: "2026-10-18T00:00:00.000Z",
    updatedAt: "2026-10-18T00:10:00.000Z",
    startedAt: "2026-10-18T00:00:05.000Z",
    awaiting: { stageId: "hitl.plan_confirm", prompt: "改进计划已生成，请确认后开始逐节改造", options: ["approve", "revise", "cancel"], payload: { feasibilityLevel: "MEDIUM", items, totalItems: items.length } },
    error: null,
    completion: null,
    progress: null,
    completedStages: ["review.run", "plan.improvement"],
  } as WorkflowRunView;
}

beforeEach(() => {
  window.sessionStorage.clear();
  vi.mocked(runsApi.resumeWorkflowRun).mockReset();
});

describe("planConfirmView（处置口径与后端派发过滤一致）", () => {
  it("modify → 将自动执行；author_decision_required / evidence_only / 缺失 → 不派发；声明改动事实但无证据 → 证据缺口", () => {
    const items = readPlanConfirmItems({ items: [...planItems(), { section: "main.tex", action: "无类型条目" }] });
    const summary = summarizePlanConfirm(items, undefined);
    expect(summary.byDisposition).toEqual({ auto_execute: 23, no_change_claimed: 0, author_decision: 2, evidence_only: 1, not_executable: 1 });
    expect(summary.notDispatched).toBe(4);
    expect(items.find((item) => item.id === "improvement:25")!.evidenceGap).toBe(true);
    expect(items.find((item) => item.id === "improvement:26")!.evidenceGap).toBe(false);
  });
});

describe("HitlPanel 计划确认：actionType / 处置可见、未派发项批准前汇总", () => {
  it("每条显示 actionType 与处置；3 条未派发项集中列出，未勾选「已知悉」时不能批准", async () => {
    const user = userEvent.setup();
    vi.mocked(runsApi.resumeWorkflowRun).mockResolvedValue({ ...planRun(planItems()), status: "running", awaiting: null });
    renderWithProviders(<HitlPanel run={planRun(planItems())} />);
    const panel = await screen.findByTestId("hitl-payload-plan");
    expect(screen.getByTestId("hitl-plan-count")).toHaveTextContent("共 26 条计划条目");
    expect(screen.getByTestId("hitl-plan-summary-auto_execute")).toHaveTextContent("将自动执行 23");
    expect(screen.getByTestId("hitl-plan-summary-author_decision")).toHaveTextContent("需要作者决定 · 本轮不执行 2");
    const undispatched = screen.getByTestId("hitl-plan-undispatched");
    expect(undispatched).toHaveTextContent("以下 3 条不会在本轮自动执行");
    expect(undispatched).toHaveTextContent("sec:exp-rdk");
    expect(undispatched).toHaveTextContent("author_decision_required");
    expect(undispatched).toHaveTextContent("决策点：作者需核对计时日志");
    expect(undispatched).toHaveTextContent("evidence_only");
    // 第 1 条（modify）在默认折叠视图中可见：actionType + 处置
    expect(within(panel).getByTestId("hitl-plan-action-type-0")).toHaveTextContent("modify");
    expect(within(panel).getByTestId("hitl-plan-disposition-0")).toHaveTextContent("将自动执行");

    const approve = screen.getByTestId("hitl-approve");
    expect(approve).toBeDisabled();
    await user.click(approve);
    expect(vi.mocked(runsApi.resumeWorkflowRun)).not.toHaveBeenCalled();

    await user.click(screen.getByTestId("hitl-plan-ack"));
    expect(approve).toBeEnabled();
    await user.click(approve);
    // 批准载荷不变（不携带任何「把 author_decision 改成 modify」的旁路）
    await waitFor(() => expect(vi.mocked(runsApi.resumeWorkflowRun)).toHaveBeenCalledWith("w-plan00001", { action: "approve" }));
  });

  it("全部为 modify 时没有额外确认（不改变既有批准路径）", async () => {
    const onlyModify = planItems().filter((item) => item["actionType"] === "modify");
    renderWithProviders(<HitlPanel run={planRun(onlyModify)} />);
    await screen.findByTestId("hitl-payload-plan");
    expect(screen.queryByTestId("hitl-plan-undispatched")).toBeNull();
    expect(screen.getByTestId("hitl-approve")).toBeEnabled();
  });

  it("26 条折叠为 12 条；键盘展开 / 收起；按处置筛选只看不会执行的条目", async () => {
    const user = userEvent.setup();
    renderWithProviders(<HitlPanel run={planRun(planItems())} />);
    const list = await screen.findByTestId("hitl-plan-items");
    expect(within(list).getAllByRole("listitem")).toHaveLength(12);
    const expand = screen.getByTestId("hitl-plan-expand");
    expect(expand).toHaveAttribute("aria-expanded", "false");
    expand.focus();
    await user.keyboard("{Enter}");
    expect(within(screen.getByTestId("hitl-plan-items")).getAllByRole("listitem")).toHaveLength(26);
    expect(screen.getByTestId("hitl-plan-disposition-24")).toHaveTextContent("需要作者决定");
    expect(screen.getByTestId("hitl-plan-evidence-gap-24")).toHaveTextContent("声明改动事实但无关联证据");
    await user.keyboard("{Enter}");
    expect(within(screen.getByTestId("hitl-plan-items")).getAllByRole("listitem")).toHaveLength(12);

    await user.click(screen.getByTestId("hitl-plan-filter-not_dispatched"));
    expect(screen.getByTestId("hitl-plan-filter-not_dispatched")).toHaveAttribute("aria-pressed", "true");
    const filtered = within(screen.getByTestId("hitl-plan-items")).getAllByRole("listitem");
    expect(filtered.map((item) => item.getAttribute("data-disposition"))).toEqual(["author_decision", "author_decision", "evidence_only"]);
  });

  it("「已知悉」刷新后保留；计划被重做（内容变化）后失效", async () => {
    const user = userEvent.setup();
    const first = renderWithProviders(<HitlPanel run={planRun(planItems())} />);
    await user.click(await screen.findByTestId("hitl-plan-ack"));
    expect(screen.getByTestId("hitl-approve")).toBeEnabled();
    first.unmount();

    // 刷新（重新挂载同一 run + 同一计划）
    const reloaded = renderWithProviders(<HitlPanel run={planRun(planItems())} />);
    expect(await screen.findByTestId("hitl-plan-ack")).toBeChecked();
    expect(screen.getByTestId("hitl-approve")).toBeEnabled();
    reloaded.unmount();

    // revise 之后 Planner 重新生成了不同的计划 → 需要重新确认
    renderWithProviders(<HitlPanel run={planRun(planItems([{ section: "main.tex", action: "新增条目", actionType: "author_decision_required", rationale: "新的作者决策" }]))} />);
    expect(await screen.findByTestId("hitl-plan-ack")).not.toBeChecked();
    expect(screen.getByTestId("hitl-approve")).toBeDisabled();
  });

  it("对应外部意见的闭环状态按 instructionId 关联展示（已处理 / 未闭环）", async () => {
    renderWithProviders(<HitlPanel run={planRun(planItems())} />);
    expect(await screen.findByTestId("hitl-plan-instruction-x-done")).toHaveTextContent("意见已处理");
    await userEvent.setup().click(screen.getByTestId("hitl-plan-expand"));
    expect(await screen.findByTestId("hitl-plan-instruction-x-open")).toHaveTextContent("意见未闭环");
  });
});
