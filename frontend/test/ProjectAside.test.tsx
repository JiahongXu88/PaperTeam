import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ProjectAside } from "../src/components/project/ProjectAside.js";
import type { ProjectView, RuntimeStatusView } from "../src/types/api.js";
import type { WorkflowRunView } from "../src/types/api.js";
import { renderWithProviders } from "./helpers.js";

/**
 * M9.1 E2E Activation Foundation：idea 项目的「开始生成论文」入口
 * （此前 idea_to_paper run 只能经 API 创建，浏览器建完 idea 项目后无按钮可点）。
 * - idea 项目显示入口；existing 项目不显示
 * - 点击 → createWorkflowRun(kind: idea_to_paper)
 * - 活跃 run 存在 → 入口切换为「查看任务进度」（后端拒绝同项目并发 run）
 * - 模型未配置 → 禁用 + 指引；启动失败 → 错误反馈
 */

vi.mock("../src/api/paper.js", () => ({
  getPaper: vi.fn(async () => ({ document: null })),
  uploadPaperPdf: vi.fn(),
  reparsePaperPdf: vi.fn(),
  listCitations: vi.fn(),
  extractCitations: vi.fn(),
  verifyMetadata: vi.fn(),
  verifyClaims: vi.fn(),
  getCitationIntegrity: vi.fn(),
  getMetadataRecords: vi.fn(),
  getClaimRecords: vi.fn(async () => []),
}));

vi.mock("../src/api/artifacts.js", () => ({
  getPaperReviewReport: vi.fn(async () => null),
  exportReviewReport: vi.fn(),
}));

vi.mock("../src/api/runs.js", () => ({
  listProjectRuns: vi.fn(async () => [] as WorkflowRunView[]),
  createWorkflowRun: vi.fn(),
  cancelWorkflowRun: vi.fn(),
}));

vi.mock("../src/api/runtime.js", () => ({
  getRuntimeStatus: vi.fn(),
}));

const paperApi = vi.mocked(await import("../src/api/paper.js"));
const runsApi = vi.mocked(await import("../src/api/runs.js"));
const runtimeApi = vi.mocked(await import("../src/api/runtime.js"));

const NOW = "2026-09-22T00:00:00.000Z";

function projectView(kind: ProjectView["workflowKind"]): ProjectView {
  return {
    id: "p-idea00000001",
    title: "Idea 项目",
    status: "created",
    workflowKind: kind,
    createdAt: NOW,
    updatedAt: NOW,
  };
}

function runtimeStatus(phase: "configured" | "not_configured"): RuntimeStatusView {
  return {
    backend: { ok: true },
    runtime: { provider: "pi", phase: "healthy", version: "0.84.4", detail: "", latencyMs: 1 },
    model: {
      phase,
      ...(phase === "configured" ? { model: "test-model", providers: ["test"] } : { providers: [] }),
      detail: "",
    },
    agents: { roles: [] },
    sessions: { activeRuns: 0, managedSessions: 0 },
  };
}

function renderAside(
  project: ProjectView,
  options: { modelPhase?: "configured" | "not_configured"; runs?: WorkflowRunView[] } = {},
) {
  // 显式重置跨测试延续的 mockResolvedValue（clearAllMocks 不清 implementation）
  runsApi.listProjectRuns.mockResolvedValue(options.runs ?? []);
  runtimeApi.getRuntimeStatus.mockResolvedValue(runtimeStatus(options.modelPhase ?? "configured"));
  paperApi.getCitationIntegrity.mockResolvedValue(undefined as never);
  return renderWithProviders(
    <ProjectAside project={project} onOpenTab={() => {}} />,
    { route: "/projects/p-idea00000001" },
  );
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("ProjectAside（M9.1 idea_to_paper 启动入口）", () => {
  it("idea 项目显示「开始生成论文」入口", async () => {
    renderAside(projectView("idea_to_paper"));
    expect(await screen.findByTestId("aside-start-paper")).toBeTruthy();
    expect(screen.getByRole("button", { name: /开始生成论文/ })).toBeTruthy();
  });

  it("existing 项目不显示生成论文区块（入口只对 idea 项目开放）", async () => {
    renderAside(projectView("existing_paper_improvement"));
    await screen.findByText("论文信息");
    expect(screen.queryByTestId("aside-start-paper")).toBeNull();
    expect(screen.queryByTestId("aside-start-paper-section")).toBeNull();
  });

  it("点击「开始生成论文」→ createWorkflowRun(projectId, kind: idea_to_paper)", async () => {
    renderAside(projectView("idea_to_paper"));
    const user = userEvent.setup();

    runsApi.createWorkflowRun.mockResolvedValue({
      runId: "w-m91test00001",
      status: "pending",
      workflowKind: "idea_to_paper",
    });
    await user.click(await screen.findByTestId("aside-start-paper"));

    await waitFor(() => expect(runsApi.createWorkflowRun).toHaveBeenCalledTimes(1));
    expect(runsApi.createWorkflowRun).toHaveBeenCalledWith("p-idea00000001", "idea_to_paper", {});
  });

  it("活跃 run 存在 → 入口切换为「查看任务进度」，不再提供启动按钮", async () => {
    renderAside(projectView("idea_to_paper"), {
      runs: [
        {
          runId: "w-active0000001",
          projectId: "p-idea00000001",
          workflowKind: "idea_to_paper",
          status: "running",
          currentStage: "research.idea",
          createdAt: NOW,
          updatedAt: NOW,
        } as WorkflowRunView,
      ],
    });

    expect(await screen.findByRole("button", { name: /查看任务进度/ })).toBeTruthy();
    expect(screen.queryByTestId("aside-start-paper")).toBeNull();
  });

  it("模型未配置 → 启动按钮禁用并给出设置指引", async () => {
    renderAside(projectView("idea_to_paper"), { modelPhase: "not_configured" });

    const button = await screen.findByTestId("aside-start-paper");
    await waitFor(() => expect(screen.getByText(/模型未配置，论文生成暂不可用/)).toBeTruthy());
    expect(button.hasAttribute("disabled")).toBe(true);
  });

  it("启动失败（如后端 409 已有活跃 run）→ 错误如实呈现", async () => {
    renderAside(projectView("idea_to_paper"));
    const user = userEvent.setup();

    const button = await screen.findByTestId("aside-start-paper");
    await waitFor(() => expect(button.hasAttribute("disabled")).toBe(false));
    runsApi.createWorkflowRun.mockRejectedValue(
      new Error("该项目已有进行中的任务") as never,
    );
    await user.click(button);
    expect(await screen.findByText(/启动失败：/)).toBeTruthy();
  });
});
