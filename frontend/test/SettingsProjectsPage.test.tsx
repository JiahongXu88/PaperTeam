import { describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ProjectManagementSettingsPage } from "../src/pages/ProjectManagementSettingsPage.js";
import { ApiError } from "../src/api/client.js";
import type { ProjectView } from "../src/types/api.js";
import { renderWithProviders } from "./helpers.js";

/**
 * 设置 → 项目管理（2026-09）：已归档项目列表 / 恢复 / 永久删除确认（输入标题）。
 */

vi.mock("../src/api/projects.js", () => ({
  listProjects: vi.fn(async () => []),
  restoreProject: vi.fn(),
  deleteProject: vi.fn(),
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

const { listProjects, restoreProject, deleteProject } = await import("../src/api/projects.js");

const archived: ProjectView[] = [
  {
    id: "p-arch00000001",
    title: "已归档的旧论文",
    status: "generated",
    workflowKind: "existing_paper_review",
    archivedAt: "2026-09-05T10:00:00.000Z",
    createdAt: "2026-08-01T08:00:00.000Z",
    updatedAt: "2026-09-05T10:00:00.000Z",
  },
];

function renderPage() {
  return renderWithProviders(<ProjectManagementSettingsPage />, { route: "/settings/projects" });
}

describe("设置 → 项目管理（已归档项目）", () => {
  it("空状态：没有归档项目时显示干净空态", async () => {
    vi.mocked(listProjects).mockResolvedValue([]);
    renderPage();

    expect(await screen.findByText("暂无已归档项目。")).toBeInTheDocument();
  });

  it("列表：展示标题 / 类型 / 归档时间 / 更新时间与操作", async () => {
    vi.mocked(listProjects).mockResolvedValue(archived);
    renderPage();

    expect(await screen.findByTestId("archived-projects-table")).toBeInTheDocument();
    expect(screen.getByText("已归档的旧论文")).toBeInTheDocument();
    expect(screen.getByText("论文 Review")).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "恢复" })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "永久删除" })).toBeInTheDocument();
  });

  it("恢复：调用 restoreProject（项目回到论文项目列表）", async () => {
    vi.mocked(listProjects).mockResolvedValue(archived);
    vi.mocked(restoreProject).mockResolvedValue({ ...archived[0]!, archivedAt: undefined });
    renderPage();

    const user = userEvent.setup();
    await screen.findByText("已归档的旧论文");
    await user.click(screen.getByRole("button", { name: "恢复" }));

    await waitFor(() => expect(restoreProject).toHaveBeenCalledWith("p-arch00000001"));
  });

  it("永久删除：必须输入完整项目标题才启用确认按钮；一致后调用 deleteProject", async () => {
    vi.mocked(listProjects).mockResolvedValue(archived);
    vi.mocked(deleteProject).mockResolvedValue(undefined);
    renderPage();

    const user = userEvent.setup();
    await screen.findByText("已归档的旧论文");
    await user.click(screen.getByRole("button", { name: "永久删除" }));

    const confirm = await screen.findByTestId("delete-confirm");
    expect(confirm).toHaveTextContent("永久删除后无法恢复");
    const button = screen.getByTestId("delete-confirm-button");
    expect(button).toBeDisabled();

    // 部分匹配不启用
    await user.type(screen.getByTestId("delete-confirm-input"), "已归档");
    expect(button).toBeDisabled();

    await user.clear(screen.getByTestId("delete-confirm-input"));
    await user.type(screen.getByTestId("delete-confirm-input"), "已归档的旧论文");
    expect(button).toBeEnabled();
    await user.click(button);

    await waitFor(() => expect(deleteProject).toHaveBeenCalledWith("p-arch00000001"));
  });

  it("删除失败（如运行中 409）：如实展示错误", async () => {
    vi.mocked(listProjects).mockResolvedValue(archived);
    vi.mocked(deleteProject).mockRejectedValue(
      new ApiError(409, "PROJECT_BUSY", "当前项目仍有进行中的任务，请先完成或取消任务后再删除。"),
    );
    renderPage();

    const user = userEvent.setup();
    await screen.findByText("已归档的旧论文");
    await user.click(screen.getByRole("button", { name: "永久删除" }));
    await user.type(screen.getByTestId("delete-confirm-input"), "已归档的旧论文");
    await user.click(screen.getByTestId("delete-confirm-button"));

    expect(await screen.findByRole("alert")).toHaveTextContent("进行中的任务");
  });
});
