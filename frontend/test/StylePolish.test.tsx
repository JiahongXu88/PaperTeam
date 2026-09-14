import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";

import { HitlPanel } from "../src/components/project/HitlPanel.js";
import { StylePolishCardView } from "../src/components/project/PaperPanel.js";
import type { StylePolishView, WorkflowRunView } from "../src/types/api.js";
import { renderWithProviders } from "./helpers.js";

/**
 * M5.4 Style Revision Loop UI：
 * - hitl.style_polish：可勾选的 style 建议（位置 / 问题 / 原因 / 改法 / 严重度）；
 *   apply 携带选中的 finding id；skip 只保留建议；全部取消勾选时不能 apply
 * - 语言润色状态卡：状态 / invariant 结果 / 修订号 / 复审状态
 * - createWorkflowRun：stylePolicy 只随 idea / improvement 发送，Quick Review 不发送
 */

vi.mock("../src/api/runs.js", async () => {
  const actual = await vi.importActual<typeof import("../src/api/runs.js")>("../src/api/runs.js");
  return {
    ...actual,
    listProjectRuns: vi.fn(),
    cancelWorkflowRun: vi.fn(),
    resumeWorkflowRun: vi.fn(),
  };
});
vi.mock("../src/api/client.js", () => ({
  apiClient: { get: vi.fn(), post: vi.fn(async () => ({ runId: "w-1", status: "pending", workflowKind: "idea_to_paper" })) },
  ApiError: class ApiError extends Error {
    constructor(
      public status: number,
      public code: string,
      message: string,
    ) {
      super(message);
    }
  },
}));

const runsApi = await import("../src/api/runs.js");
const { apiClient } = await import("../src/api/client.js");

const FINDING_A = "f-aaaaaaaaaaaa";
const FINDING_B = "f-bbbbbbbbbbbb";

function styleRun(): WorkflowRunView {
  return {
    runId: "w-style0001",
    projectId: "p-style001",
    workflowKind: "existing_paper_improvement",
    status: "awaiting_input",
    currentStage: "hitl.style_polish",
    createdAt: "2026-09-14T00:00:00.000Z",
    updatedAt: "2026-09-14T00:10:00.000Z",
    stylePolicy: "apply_once",
    awaiting: {
      stageId: "hitl.style_polish",
      prompt: "Quality Gate 已通过。当前有语言风格建议（style / minor）。",
      options: ["apply", "skip", "cancel"],
      payload: {
        stylePolicy: "apply_once",
        gateRound: 1,
        reviewRound: 1,
        reviewedRevision: 4,
        findings: [
          { id: FINDING_A, section: "sections/introduction.tex", issue: "「具有重要意义」空泛", reason: "无具体内容支撑", proposedAction: "改为具体结论", severity: "minor" },
          { id: FINDING_B, section: "sections/method.tex", issue: "同段第三次重复「有效」", reason: "同义反复", proposedAction: "保留一处", severity: "minor" },
        ],
        defaultSelectedIds: [FINDING_A, FINDING_B],
        maxRounds: 1,
      },
    },
    error: null,
    completion: null,
    progress: null,
  };
}

describe("HitlPanel：hitl.style_polish（M5.4）", () => {
  it("渲染可勾选的 style 建议（位置 / 问题 / 原因 / 改法），apply 携带选中的 id；取消一条后只发剩余", async () => {
    vi.mocked(runsApi.resumeWorkflowRun).mockResolvedValue({ ...styleRun(), status: "running", awaiting: null });
    renderWithProviders(<HitlPanel run={styleRun()} />);
    const payload = await screen.findByTestId("hitl-payload-style-polish");
    expect(payload).toHaveTextContent("语言风格建议 2 条");
    expect(payload).toHaveTextContent("sections/introduction.tex");
    expect(payload).toHaveTextContent("原因：无具体内容支撑");
    expect(payload).toHaveTextContent("改法：改为具体结论");
    expect(payload).not.toHaveTextContent(/AI 概率|检测/);
    // 严格按 options 渲染：没有 approve / accept_draft
    expect(screen.queryByTestId("hitl-approve")).toBeNull();
    expect(screen.queryByTestId("hitl-accept-draft")).toBeNull();
    const apply = screen.getByTestId("hitl-apply-style");
    expect(apply).toHaveTextContent("应用语言润色（2 条）");
    fireEvent.click(screen.getByTestId(`style-finding-${FINDING_B}`));
    expect(screen.getByTestId("hitl-apply-style")).toHaveTextContent("应用语言润色（1 条）");
    fireEvent.click(screen.getByTestId("hitl-apply-style"));
    await waitFor(() =>
      expect(runsApi.resumeWorkflowRun).toHaveBeenCalledWith("w-style0001", {
        action: "apply",
        payload: { selectedFindingIds: [FINDING_A] },
      }),
    );
  });

  it("全部取消勾选 → apply 禁用；skip 只发 action=skip", async () => {
    vi.mocked(runsApi.resumeWorkflowRun).mockClear();
    vi.mocked(runsApi.resumeWorkflowRun).mockResolvedValue({ ...styleRun(), status: "running", awaiting: null });
    renderWithProviders(<HitlPanel run={styleRun()} />);
    await screen.findByTestId("hitl-payload-style-polish");
    fireEvent.click(screen.getByTestId(`style-finding-${FINDING_A}`));
    fireEvent.click(screen.getByTestId(`style-finding-${FINDING_B}`));
    expect(screen.getByTestId("hitl-apply-style")).toBeDisabled();
    fireEvent.click(screen.getByTestId("hitl-skip-style"));
    await waitFor(() => expect(runsApi.resumeWorkflowRun).toHaveBeenCalledWith("w-style0001", { action: "skip" }));
  });
});

describe("语言润色状态卡（M5.4）", () => {
  const base: StylePolishView = {
    plan: {
      planId: "style-plan-r1-rev4",
      reviewRound: 1,
      sourceRevision: 4,
      items: [{ id: FINDING_A, section: "sections/introduction.tex", problem: "「具有重要意义」空泛", instruction: "改为具体结论", status: "planned", revisionReason: "style_polish" }],
    },
    result: {
      planId: "style-plan-r1-rev4",
      reviewRound: 1,
      sourceRevision: 4,
      status: "applied",
      revision: 5,
      selectedFindingIds: [FINDING_A],
      sections: [{ section: "introduction", itemIds: [FINDING_A], invariantOk: true, violations: [] }],
      completedAt: "2026-09-14T00:20:00.000Z",
    },
    reviewedRevision: 5,
    reReviewed: true,
  };

  it("已应用：状态 / 修订号 4 → 5 / invariant 全通过 / 已复审", () => {
    renderWithProviders(<StylePolishCardView view={base} />);
    expect(screen.getByTestId("style-polish-status")).toHaveTextContent("已应用");
    expect(screen.getByTestId("style-polish-card")).toHaveTextContent("rev 4 → rev 5");
    expect(screen.getByTestId("style-polish-invariant")).toHaveTextContent("全部通过（1 个章节）");
    expect(screen.getByTestId("style-polish-rereview")).toHaveTextContent("已复审");
  });

  it("invariant 失败：原稿保留、列出具体 invariant、无复审", () => {
    renderWithProviders(
      <StylePolishCardView
        view={{
          ...base,
          result: {
            ...base.result!,
            status: "failed",
            revision: undefined,
            sections: [
              {
                section: "introduction",
                itemIds: [FINDING_A],
                invariantOk: false,
                violations: [{ rule: "citation_keys", detail: "citation key 集合变化：缺少 [gao2023survey]" }],
              },
            ],
          },
          reviewedRevision: 4,
          reReviewed: null,
        }}
      />,
    );
    expect(screen.getByTestId("style-polish-status")).toHaveTextContent("未通过 invariant 检查（原稿保留）");
    expect(screen.getByTestId("style-polish-card")).toHaveTextContent("rev 4（未改动）");
    expect(screen.getByTestId("style-polish-violations")).toHaveTextContent("citation_keys");
    expect(screen.getByTestId("style-polish-violations")).toHaveTextContent("gao2023survey");
    expect(screen.getByTestId("style-polish-rereview")).toHaveTextContent("无已应用的润色");
  });

  it("无计划无结果：不渲染", () => {
    const { container } = renderWithProviders(<StylePolishCardView view={{ plan: null, result: null, reviewedRevision: null, reReviewed: null }} />);
    expect(container.querySelector("[data-testid='style-polish-card']")).toBeNull();
  });
});

describe("createWorkflowRun：stylePolicy 发送规则（M5.4）", () => {
  it("improvement 携带 stylePolicy；Quick Review 即使传入也不发送（后端会 400）", async () => {
    vi.mocked(apiClient.post).mockClear();
    await runsApi.createWorkflowRun("p-1", "existing_paper_improvement", { stylePolicy: "apply_once" });
    expect(apiClient.post).toHaveBeenLastCalledWith("/api/projects/p-1/workflows", { kind: "existing_paper_improvement", stylePolicy: "apply_once" });
    await runsApi.createWorkflowRun("p-1", "existing_paper_review", { stylePolicy: "apply_once", citationSemanticMode: "off" });
    expect(apiClient.post).toHaveBeenLastCalledWith("/api/projects/p-1/workflows", { kind: "existing_paper_review", citationSemanticMode: "off" });
    await runsApi.createWorkflowRun("p-1", "idea_to_paper");
    expect(apiClient.post).toHaveBeenLastCalledWith("/api/projects/p-1/workflows", { kind: "idea_to_paper" });
  });
});
