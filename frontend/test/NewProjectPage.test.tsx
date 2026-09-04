import { describe, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { NewProjectPage } from "../src/pages/NewProjectPage.js";
import { ProjectPage } from "../src/pages/ProjectPage.js";
import { ApiError } from "../src/api/client.js";
import type { ProjectView } from "../src/types/api.js";
import { renderWithProviders } from "./helpers.js";

/** NewProjectPage（M4.2）：校验 / 提交 / 成功导航 / API 错误 / Existing-Paper 提示 */

vi.mock("../src/api/projects.js", () => ({
  listProjects: vi.fn(async () => []),
  getProject: vi.fn(),
  createProject: vi.fn(),
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

const { createProject, getProject } = await import("../src/api/projects.js");

const created: ProjectView = {
  id: "p-new000000001",
  title: "全新论文项目",
  status: "created",
  createdAt: "2026-09-04T12:00:00.000Z",
  updatedAt: "2026-09-04T12:00:00.000Z",
};

/** 真实路由：/projects/new ↔ /projects/:projectId（验证成功导航后的落地页） */
function renderCreateFlow() {
  return renderWithProviders(
    <Routes>
      <Route path="/projects/new" element={<NewProjectPage />} />
      <Route path="/projects/:projectId" element={<ProjectPage />} />
    </Routes>,
    { route: "/projects/new" },
  );
}

describe("NewProjectPage", () => {
  it("标题为空提交：显示校验错误，不调用 API", async () => {
    vi.mocked(createProject).mockClear();
    const user = userEvent.setup();
    renderCreateFlow();

    await user.click(screen.getByRole("button", { name: "创建项目" }));

    expect(await screen.findByTestId("validation-error")).toHaveTextContent("论文标题不能为空");
    expect(createProject).not.toHaveBeenCalled();
  });

  it("合法提交：payload 裁剪空字段，成功后导航到 /projects/:id", async () => {
    vi.mocked(createProject).mockResolvedValue(created);
    vi.mocked(getProject).mockResolvedValue(created);
    const user = userEvent.setup();
    renderCreateFlow();

    await user.type(screen.getByLabelText(/论文标题/), "  全新论文项目  ");
    await user.type(screen.getByLabelText("研究想法（Research Idea）"), "从想法到论文");
    await user.type(screen.getByLabelText(/研究领域/), "信息检索");
    await user.click(screen.getByRole("button", { name: "创建项目" }));

    await waitFor(() =>
      expect(createProject).toHaveBeenCalledWith({
        title: "全新论文项目",
        workflowKind: "idea_to_paper",
        researchIdea: "从想法到论文",
        researchField: "信息检索",
      }),
    );
    // 成功导航：ProjectPage 渲染出新项目标题（同一 MemoryRouter 内换路由）
    await waitFor(() => expect(screen.getByText("研究定位")).toBeInTheDocument());
    expect(screen.getByText("全新论文项目")).toBeInTheDocument();
  });

  it("API 失败：显示后端错误信息，停留在表单", async () => {
    vi.mocked(createProject).mockRejectedValue(
      new ApiError(400, "INVALID_REQUEST", "字段 researchField 长度不能超过 200 个字符"),
    );
    const user = userEvent.setup();
    renderCreateFlow();

    await user.type(screen.getByLabelText(/论文标题/), "会失败的项目");
    await user.click(screen.getByRole("button", { name: "创建项目" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("创建失败");
    expect(screen.getByText(/researchField/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: "创建项目" })).toBeEnabled();
  });

  it("选择已有论文改进：显示导入说明（Backend 导入 API 已开放）", async () => {
    vi.mocked(createProject).mockClear();
    const user = userEvent.setup();
    renderCreateFlow();

    expect(screen.queryByTestId("import-note")).toBeNull();
    await user.click(screen.getByLabelText(/已有论文改进/));

    expect(screen.getByTestId("import-note")).toHaveTextContent("import");
    expect(screen.getByRole("radio", { name: /已有论文改进/ })).toBeChecked();
  });
});
