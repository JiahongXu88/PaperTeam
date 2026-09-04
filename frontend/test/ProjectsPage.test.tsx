import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ProjectsPage } from "../src/pages/ProjectsPage.js";
import { ApiError } from "../src/api/client.js";
import type { ProjectView } from "../src/types/api.js";
import { renderWithProviders } from "./helpers.js";

/** ProjectsPage（M4.2）：加载 / 数据 / 空态 / 错误重试 */

vi.mock("../src/api/projects.js", () => ({
  listProjects: vi.fn(),
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

  it("成功：渲染项目卡片的真实字段（标题 / 模式 / 状态 / 领域）", async () => {
    vi.mocked(listProjects).mockResolvedValue(projects);
    renderWithProviders(<ProjectsPage />, { route: "/projects" });

    expect(await screen.findByText("检索增强生成综述")).toBeInTheDocument();
    expect(screen.getByText("多模态跟踪改进")).toBeInTheDocument();
    expect(screen.getByText("Idea → Paper")).toBeInTheDocument();
    expect(screen.getByText("已有论文改进")).toBeInTheDocument();
    expect(screen.getByText("已创建")).toBeInTheDocument();
    expect(screen.getByText("已生成")).toBeInTheDocument();
    expect(screen.getByText(/信息检索/)).toBeInTheDocument();
    // 卡片链接指向 workspace
    expect(screen.getAllByTestId("project-card")[0]).toHaveAttribute(
      "href",
      "/projects/p-first0000001",
    );
  });

  it("空态：无项目时显示引导与创建入口", async () => {
    vi.mocked(listProjects).mockResolvedValue([]);
    renderWithProviders(<ProjectsPage />, { route: "/projects" });

    expect(await screen.findByText("还没有论文项目")).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "创建第一个项目" })).toHaveAttribute(
      "href",
      "/projects/new",
    );
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
    expect(await screen.findByText("检索增强生成综述")).toBeInTheDocument();
  });

  it("页头：提供 New Project 入口", async () => {
    vi.mocked(listProjects).mockResolvedValue(projects);
    renderWithProviders(<ProjectsPage />, { route: "/projects" });
    await waitFor(() => expect(screen.getByText("My Papers")).toBeInTheDocument());
    expect(screen.getByRole("link", { name: /New Project/ })).toHaveAttribute("href", "/projects/new");
  });
});
