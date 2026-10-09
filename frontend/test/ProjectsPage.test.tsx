import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ProjectsPage } from "../src/pages/ProjectsPage.js";
import { ApiError } from "../src/api/client.js";
import type { ProjectView } from "../src/types/api.js";
import { renderWithProviders } from "./helpers.js";

/** ProjectsPage（M4.2 + 生命周期 2026-09）：加载 / 数据 / 空态 / 错误重试 / 行菜单 */

vi.mock("../src/api/projects.js", () => ({
  listProjects: vi.fn(),
  archiveProject: vi.fn(),
  renameProject: vi.fn(),
}));

vi.mock("../src/api/runs.js", () => ({
  listProjectRuns: vi.fn(async () => []),
}));

vi.mock("../src/api/runtime.js", () => ({
  getRuntimeStatus: vi.fn(async () => ({
    backend: { ok: true },
    runtime: { provider: "pi", phase: "healthy", version: "0.84.4", detail: "正常", latencyMs: 1 },
    model: { phase: "configured", providers: ["anthropic"], detail: "ok" },
    agents: { roles: [] },
    sessions: { activeRuns: 0, managedSessions: 0 },
  })),
}));

const { listProjects } = await import("../src/api/projects.js");
const { listProjectRuns } = await import("../src/api/runs.js");

const projects: ProjectView[] = [
  {
    id: "p-first0000001",
    title: "检索增强生成综述",
    status: "created",
    workflowKind: "idea_to_paper",
    researchField: "信息检索",
    targetVenue: "SIGIR 2027",
    language: "中文",
    createdAt: "2026-09-01T08:00:00.000Z",
    updatedAt: "2026-09-02T08:00:00.000Z",
  },
  {
    id: "p-second000002",
    title: "多模态跟踪改进",
    status: "generated",
    workflowKind: "existing_paper_improvement",
    createdAt: "2026-08-20T08:00:00.000Z",
    updatedAt: "2026-08-21T08:00:00.000Z",
  },
];

describe("ProjectsPage", () => {
  it("加载中：显示 loading 状态", () => {
    vi.mocked(listProjects).mockImplementation(() => new Promise(() => {}));
    renderWithProviders(<ProjectsPage />, { route: "/projects" });
    expect(screen.getByRole("status")).toBeInTheDocument();
  });

  it("成功：渲染项目行的真实字段（标题 / 模式 / 状态 / 领域）", async () => {
    vi.mocked(listProjects).mockResolvedValue(projects);
    renderWithProviders(<ProjectsPage />, { route: "/projects" });

    expect((await screen.findAllByText("检索增强生成综述")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getAllByText("多模态跟踪改进").length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("想法成文")).toBeInTheDocument();
    expect(screen.getByText("论文改进")).toBeInTheDocument();
    expect(screen.getByText("已创建")).toBeInTheDocument();
    expect(screen.getByText("已生成")).toBeInTheDocument();
    expect(screen.getByText(/信息检索/)).toBeInTheDocument();
  });

  it("Agent 活动：只展示运行 API 返回的工作流记录，没有任务时显示空状态", async () => {
    vi.mocked(listProjects).mockResolvedValue([projects[0]!]);
    vi.mocked(listProjectRuns).mockResolvedValueOnce([{
      runId: "run-actual-1",
      projectId: projects[0]!.id,
      workflowKind: "topic_survey",
      status: "running",
      currentStage: "survey.synthesis",
      createdAt: "2026-09-02T08:00:00.000Z",
      updatedAt: "2026-09-02T08:10:00.000Z",
    }]);
    renderWithProviders(<ProjectsPage />, { route: "/projects" });

    expect(await screen.findByText("综述论文生成")).toBeInTheDocument();
    expect(screen.getByText("当前阶段：跨论文综合")).toBeInTheDocument();
    expect(screen.getAllByText("运行中").length).toBeGreaterThanOrEqual(1);
  });

  it("行内主内容是指向 workspace 的链接；··· 菜单提供 打开 / 重命名 / 归档", async () => {
    vi.mocked(listProjects).mockResolvedValue(projects);
    renderWithProviders(<ProjectsPage />, { route: "/projects" });

    await screen.findAllByText("检索增强生成综述");
    // 主内容 Link 指向 workspace（菜单按钮在 Link 之外）
    expect(screen.getAllByRole("link", { name: /检索增强生成综述/ })[0]).toHaveAttribute(
      "href",
      "/projects/p-first0000001",
    );
    // ··· 菜单动作
    const user = userEvent.setup();
    await user.click(screen.getAllByTestId("project-row-menu")[0]);
    expect(screen.getByRole("menuitem", { name: "打开" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "重命名" })).toBeInTheDocument();
    expect(screen.getByRole("menuitem", { name: "归档项目" })).toBeInTheDocument();
    // 普通列表不提供永久删除
    expect(screen.queryByRole("menuitem", { name: /删除/ })).toBeNull();
  });

  it("归档：调用 archiveProject；运行中项目（409）如实展示后端信息", async () => {
    const { archiveProject } = await import("../src/api/projects.js");
    vi.mocked(listProjects).mockResolvedValue([projects[0]!]);
    vi.mocked(archiveProject).mockRejectedValue(
      new ApiError(409, "PROJECT_BUSY", "当前项目仍有进行中的任务，请先完成或取消任务后再归档。"),
    );
    renderWithProviders(<ProjectsPage />, { route: "/projects" });

    const user = userEvent.setup();
    await screen.findAllByText("检索增强生成综述");
    await user.click(screen.getByTestId("project-row-menu"));
    await user.click(screen.getByRole("menuitem", { name: "归档项目" }));
    // 行内确认后才真正调用归档
    await user.click(await screen.findByRole("button", { name: "归档" }));

    expect(archiveProject).toHaveBeenCalledWith(projects[0]!.id);
    expect(await screen.findByRole("alert")).toHaveTextContent("进行中的任务");
  });

  it("空态：无项目时显示引导与创建入口", async () => {
    vi.mocked(listProjects).mockResolvedValue([]);
    renderWithProviders(<ProjectsPage />, { route: "/projects" });

    expect(await screen.findByText("还没有论文项目")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "开始创建" })).toHaveAttribute("href", "/projects/new");
    expect(screen.getByRole("link", { name: /创建新论文/ })).toHaveAttribute("href", "/projects/new");
    expect(screen.getByText("暂无运行任务")).toBeInTheDocument();
  });

  it("错误：显示错误信息，点击重试后恢复", async () => {
    vi.mocked(listProjects)
      .mockRejectedValueOnce(
        new ApiError(0, "NETWORK_ERROR", "无法连接 PaperTeam Backend（请确认后端已启动）"),
      )
      .mockResolvedValueOnce(projects);
    renderWithProviders(<ProjectsPage />, { route: "/projects" });

    expect(await screen.findByRole("alert")).toHaveTextContent("无法连接");
    await userEvent.setup().click(screen.getByRole("button", { name: "重试" }));
    expect((await screen.findAllByText("检索增强生成综述")).length).toBeGreaterThanOrEqual(1);
  });

  it("首页：提供创建和已有论文导入入口", async () => {
    vi.mocked(listProjects).mockResolvedValue(projects);
    renderWithProviders(<ProjectsPage />, { route: "/projects" });
    await waitFor(() => expect(screen.getByRole("heading", { name: "选择一个开始方式" })).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /创建新论文/ })).toHaveAttribute("href", "/projects/new");
    expect(screen.getByRole("link", { name: /修改已有论文/ })).toHaveAttribute("href", "/projects/new?mode=existing");
  });
});
