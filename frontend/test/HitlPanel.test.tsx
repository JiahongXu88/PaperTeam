import { describe, expect, it, vi, beforeEach } from "vitest";
import { act, screen, waitFor, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { HitlPanel } from "../src/components/project/HitlPanel.js";
import { WorkflowPanel } from "../src/components/project/WorkflowPanel.js";
import { ApiError } from "../src/api/client.js";
import type { WorkflowRunView } from "../src/types/api.js";
import { renderWithProviders } from "./helpers.js";

/**
 * HITL 决策面板（M4.5）：
 * - payload 按 stageId 渲染（可行性结论 / 大纲 / 改进计划 / 修订耗尽）
 * - 动作严格来自 awaiting.options（未提供的动作不出现）
 * - approve / adjust / revise 的 payload contract 与后端 definitions.ts 一致
 * - 表单校验（空值不可提交）+ pending 禁用全部动作（防双击重复提交）
 * - 过期请求（409 WORKFLOW_INVALID_STATE）：展示错误并失效 run 列表
 * - cancel 走 decision 通道（POST resume decision=cancel，留档 inputs）
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
const noop = () => {};

function hitlRunFixture(overrides: Partial<WorkflowRunView> = {}): WorkflowRunView {
  return {
    runId: "w-hitl00001",
    projectId: "p-hitl0001",
    workflowKind: "idea_to_paper",
    status: "awaiting_input",
    currentStage: "hitl.feasibility_confirm",
    createdAt: "2026-09-09T00:00:00.000Z",
    updatedAt: "2026-09-09T00:10:00.000Z",
    startedAt: "2026-09-09T00:00:05.000Z",
    awaiting: {
      stageId: "hitl.feasibility_confirm",
      prompt: "调研与可行性评估已完成，请确认研究目标后继续",
      options: ["approve", "adjust", "cancel"],
      payload: {
        level: "MEDIUM",
        reasons: ["研究空白明确", "评估协议贡献清晰"],
        missingRequirements: ["缺少 Baseline 对比实验"],
        requiredExperiments: ["在公开 QA 基准上与 3 个基线对比"],
        recommendations: ["先固定评估协议，再做消融"],
        suggestedTargetAdjustment: ["下调为核心期刊"],
      },
    },
    error: null,
    completion: null,
    progress: null,
    completedStages: ["research.idea", "research.feasibility"],
    ...overrides,
  };
}

function renderHitl(run: WorkflowRunView) {
  return renderWithProviders(<HitlPanel run={run} />);
}

describe("HitlPanel：payload 渲染（统一 shell，按 stageId 差异化）", () => {
  it("可行性节点：等级徽章 + 理由 / 缺口 / 实验 / 建议列表 + 调整建议", async () => {
    renderHitl(hitlRunFixture());
    const panel = await screen.findByTestId("hitl-panel");
    expect(panel).toHaveTextContent("等待你的确认");
    expect(panel).toHaveTextContent("调研与可行性评估已完成");
    expect(screen.getByTestId("hitl-payload-feasibility")).toHaveTextContent("中");
    expect(panel).toHaveTextContent("研究空白明确");
    expect(panel).toHaveTextContent("缺少 Baseline 对比实验");
    expect(panel).toHaveTextContent("在公开 QA 基准上与 3 个基线对比");
    expect(panel).toHaveTextContent("先固定评估协议，再做消融");
  });

  it("大纲节点：标题 + 摘要 + 章节列表；动作只有 继续 / 提出修改意见 / 取消任务", async () => {
    renderHitl(
      hitlRunFixture({
        currentStage: "hitl.outline_confirm",
        awaiting: {
          stageId: "hitl.outline_confirm",
          prompt: "大纲已生成，请确认后开始分节写作",
          options: ["approve", "revise", "cancel"],
          payload: {
            title: "小语料场景下检索增强生成的系统评估",
            abstract: "本文提出一套小语料 RAG 评估协议。",
            sections: [
              { id: "introduction", title: "引言", file: "introduction.tex" },
              { id: "method", title: "评估方法", file: "method.tex" },
            ],
          },
        },
        completedStages: ["research.idea", "research.feasibility", "hitl.feasibility_confirm", "outline.plan"],
      }),
    );
    expect(await screen.findByTestId("hitl-payload-outline")).toHaveTextContent("小语料场景下检索增强生成的系统评估");
    expect(screen.getByTestId("hitl-outline-sections")).toHaveTextContent("引言");
    expect(screen.getByTestId("hitl-outline-sections")).toHaveTextContent("评估方法");
    // 严格按 options 渲染：大纲节点没有 adjust
    expect(screen.getByTestId("hitl-approve")).toBeInTheDocument();
    expect(screen.getByTestId("hitl-revise")).toBeInTheDocument();
    expect(screen.queryByTestId("hitl-adjust")).toBeNull();
    expect(screen.getByTestId("hitl-cancel")).toBeInTheDocument();
  });

  it("改进计划节点：条目 + 优先级；修订耗尽节点：Gate 结论 + 审稿规模", async () => {
    const { unmount } = renderWithProviders(
      <HitlPanel
        run={hitlRunFixture({
          workflowKind: "existing_paper_improvement",
          currentStage: "hitl.plan_confirm",
          awaiting: {
            stageId: "hitl.plan_confirm",
            prompt: "改进计划已生成，请确认后开始逐节改造",
            options: ["approve", "revise", "cancel"],
            payload: {
              feasibilityLevel: "LOW",
              items: [
                { section: "sections/experiments.tex", action: "补充统计显著性检验", priority: "high" },
                { section: "sections/introduction.tex", action: "增加最新基线讨论", priority: "medium" },
              ],
            },
          },
        })}
      />,
    );
    expect(await screen.findByTestId("hitl-payload-plan")).toHaveTextContent("补充统计显著性检验");
    expect(screen.getByTestId("hitl-plan-items")).toHaveTextContent("优先处理");
    unmount();

    renderWithProviders(
      <HitlPanel
        run={hitlRunFixture({
          currentStage: "hitl.revision_overflow",
          awaiting: {
            stageId: "hitl.revision_overflow",
            prompt: "自动修订已达上限，请决策",
            options: ["accept_draft", "revise_more", "cancel"],
            payload: {
              gatePassed: false,
              gateReasons: ["academicScore 66 < 80", "critical 问题 1 项"],
              review: { critical: 1, major: 2, blocking: 1 },
              buildOk: false,
              buildError: null,
            },
          },
        })}
      />,
    );
    const overflow = await screen.findByTestId("hitl-payload-overflow");
    expect(overflow).toHaveTextContent("未通过");
    expect(overflow).toHaveTextContent("严重 1 / 主要 2 / 阻断性 1");
    // overflow 节点动作：接受为草稿 / 再修一轮 / 取消；没有 approve
    expect(screen.getByTestId("hitl-accept-draft")).toBeInTheDocument();
    expect(screen.getByTestId("hitl-revise-more")).toBeInTheDocument();
    expect(screen.queryByTestId("hitl-approve")).toBeNull();
  });

  it("未知 stageId / 无 payload：只显示 prompt，不虚构内容", async () => {
    renderHitl(
      hitlRunFixture({
        awaiting: { stageId: "hitl.unknown_future", prompt: "新的待办节点", options: ["approve"] },
      }),
    );
    const panel = await screen.findByTestId("hitl-panel");
    expect(panel).toHaveTextContent("新的待办节点");
    expect(panel.querySelector(".hitl-payload")).toBeNull();
    expect(screen.getByTestId("hitl-approve")).toBeInTheDocument();
    expect(screen.queryByTestId("hitl-cancel")).toBeNull();
  });
});

describe("HitlPanel：决策提交", () => {
  beforeEach(() => {
    vi.mocked(runsApi.resumeWorkflowRun).mockReset();
  });

  it("approve：POST resume decision=approve；pending 期间全部动作禁用", async () => {
    const user = userEvent.setup();
    let resolveResume: ((run: WorkflowRunView) => void) | undefined;
    vi.mocked(runsApi.resumeWorkflowRun).mockImplementation(
      () =>
        new Promise<WorkflowRunView>((resolve) => {
          resolveResume = resolve;
        }),
    );
    renderHitl(hitlRunFixture());

    await user.click(await screen.findByTestId("hitl-approve"));
    expect(vi.mocked(runsApi.resumeWorkflowRun)).toHaveBeenCalledWith("w-hitl00001", { action: "approve" });
    // pending：approve / adjust / cancel 全部禁用（双击无法发出第二个请求）
    expect(screen.getByTestId("hitl-approve")).toBeDisabled();
    expect(screen.getByTestId("hitl-adjust")).toBeDisabled();
    expect(screen.getByTestId("hitl-cancel")).toBeDisabled();

    await act(async () => {
      resolveResume?.(hitlRunFixture({ status: "running", awaiting: null, currentStage: "outline.plan" }));
    });
    await waitFor(() => expect(vi.mocked(runsApi.resumeWorkflowRun)).toHaveBeenCalledTimes(1));
  });

  it("adjust：表单校验（至少一项）+ payload 只携带填写字段", async () => {
    const user = userEvent.setup();
    vi.mocked(runsApi.resumeWorkflowRun).mockResolvedValue(
      hitlRunFixture({ status: "running", awaiting: null, currentStage: "research.feasibility" }),
    );
    renderHitl(hitlRunFixture());

    await user.click(await screen.findByTestId("hitl-adjust"));
    // 空表单：提交禁用 + 提示
    expect(screen.getByTestId("hitl-adjust-submit")).toBeDisabled();
    expect(screen.getByText("至少填写一项才会提交。")).toBeInTheDocument();
    // 表单里的评估建议来自后端 payload
    expect(screen.getByText(/下调为核心期刊/)).toBeInTheDocument();

    await user.selectOptions(await screen.findByTestId("hitl-target-profile"), "core_journal");
    await user.type(screen.getByTestId("hitl-target-venue"), "  ");
    await user.click(screen.getByTestId("hitl-adjust-submit"));

    // 只带 targetProfile（targetVenue 空白被裁剪）
    expect(vi.mocked(runsApi.resumeWorkflowRun)).toHaveBeenCalledWith("w-hitl00001", {
      action: "adjust",
      payload: { targetProfile: "core_journal" },
    });
  });

  it("revise：非空 feedback 才可提交；空值后端 409 场景由校验前置拦截", async () => {
    const user = userEvent.setup();
    vi.mocked(runsApi.resumeWorkflowRun).mockResolvedValue(
      hitlRunFixture({ status: "running", awaiting: null, currentStage: "outline.plan" }),
    );
    renderHitl(
      hitlRunFixture({
        currentStage: "hitl.outline_confirm",
        awaiting: {
          stageId: "hitl.outline_confirm",
          prompt: "大纲已生成，请确认后开始分节写作",
          options: ["approve", "revise", "cancel"],
        },
      }),
    );

    await user.click(await screen.findByTestId("hitl-revise"));
    expect(screen.getByTestId("hitl-revise-submit")).toBeDisabled();
    // 只有空白的反馈不能提交
    await user.type(screen.getByTestId("hitl-feedback"), "   ");
    expect(screen.getByTestId("hitl-revise-submit")).toBeDisabled();

    await user.clear(screen.getByTestId("hitl-feedback"));
    await user.type(screen.getByTestId("hitl-feedback"), "希望方法章节提前，实验章节增加消融实验。");
    await user.click(screen.getByTestId("hitl-revise-submit"));
    expect(vi.mocked(runsApi.resumeWorkflowRun)).toHaveBeenCalledWith("w-hitl00001", {
      action: "revise",
      payload: { feedback: "希望方法章节提前，实验章节增加消融实验。" },
    });
  });

  it("cancel：确认后走 decision 通道（decision=cancel），不是前端本地改状态", async () => {
    const user = userEvent.setup();
    vi.mocked(runsApi.resumeWorkflowRun).mockResolvedValue(
      hitlRunFixture({ status: "cancelled", awaiting: null, finishedAt: "2026-09-09T00:12:00.000Z" }),
    );
    renderHitl(hitlRunFixture());

    await user.click(await screen.findByTestId("hitl-cancel"));
    const confirm = screen.getByTestId("hitl-cancel-confirm");
    expect(confirm).toHaveTextContent("确定取消整个任务吗");
    await user.click(within(confirm).getByRole("button", { name: "取消任务" }));

    expect(vi.mocked(runsApi.resumeWorkflowRun)).toHaveBeenCalledWith("w-hitl00001", { action: "cancel" });
    // cancel mutation 不走 cancelWorkflowRun API
    expect(vi.mocked(runsApi.cancelWorkflowRun)).not.toHaveBeenCalled();
  });

  it("过期请求（409 WORKFLOW_INVALID_STATE）：展示错误 + 失效 run 列表取权威状态", async () => {
    const user = userEvent.setup();
    vi.mocked(runsApi.resumeWorkflowRun).mockRejectedValue(
      new ApiError(
        409,
        "WORKFLOW_INVALID_STATE",
        "无法对状态为 running 的 WorkflowRun 执行 resume（runId: w-hitl00001）",
      ),
    );

    // 直接渲染 WorkflowPanel（覆盖失效 projectRuns 的真实路径）
    vi.mocked(runsApi.listProjectRuns).mockResolvedValue([hitlRunFixture()]);
    renderWithProviders(<WorkflowPanel projectId="p-hitl0001" onOpenTab={noop} connection="open" />);
    const callsBefore = vi.mocked(runsApi.listProjectRuns).mock.calls.length;
    await user.click(await screen.findByTestId("hitl-approve"));

    const error = await screen.findByTestId("hitl-error");
    expect(error).toHaveTextContent("无法对状态为 running");
    // 收到 409 → invalidateQueries → listProjectRuns 重新拉取权威状态
    await waitFor(() =>
      expect(vi.mocked(runsApi.listProjectRuns).mock.calls.length).toBeGreaterThan(callsBefore),
    );
  });
});

describe("HitlPanel：恢复语义（数据来自 run.awaiting，不依赖内存事件）", () => {
  it("重新挂载（等价刷新）即渲染完整待办：面板不依赖 SSE 事件存活", async () => {
    const { unmount } = renderHitl(hitlRunFixture());
    expect(await screen.findByTestId("hitl-panel")).toBeInTheDocument();
    unmount();

    renderHitl(hitlRunFixture());
    expect(await screen.findByTestId("hitl-panel")).toHaveTextContent("调研与可行性评估已完成");
    expect(screen.getByTestId("hitl-approve")).toBeEnabled();
  });
});
