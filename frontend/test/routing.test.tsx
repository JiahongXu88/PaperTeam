import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";

import { AppRoutes } from "../src/router/index.js";
import type { ProjectView } from "../src/types/api.js";
import { renderWithProviders } from "./helpers.js";

/** 路由（M4.1 + 生命周期 2026-09）：/ 重定向、真实路由、Settings 二级、404、Brand 主页入口 */

vi.mock("../src/api/projects.js", () => ({
  listProjects: vi.fn(async () => [] as ProjectView[]),
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

vi.mock("../src/api/settings.js", () => ({
  getModelSettings: vi.fn(async () => ({
    apiKeyConfigured: true,
    apiKeySource: "environment",
    configurationSource: "environment",
    envOverride: true,
    runtimePhase: "healthy",
    runtimeVersion: "0.84.4",
    modelPhase: "configured",
    modelDetail: "ok",
    detail: "ok",
  })),
  getModelOptions: vi.fn(async () => ({ providers: [] })),
  saveModelSettings: vi.fn(),
  clearModelApiKey: vi.fn(),
  testModelConnection: vi.fn(),
}));

function renderAt(route: string) {
  return renderWithProviders(<AppRoutes />, { route });
}

describe("routing", () => {
  it("/ 重定向到 /projects（渲染项目列表）", async () => {
    renderAt("/");
    expect(await screen.findByRole("heading", { name: "论文项目" })).toBeInTheDocument();
  });

  it("/projects 渲染项目列表页", async () => {
    renderAt("/projects");
    expect(await screen.findByRole("heading", { name: "论文项目" })).toBeInTheDocument();
  });

  it("/projects/new 渲染创建页", async () => {
    renderAt("/projects/new");
    expect(await screen.findByRole("heading", { name: "新建项目" })).toBeInTheDocument();
  });

  it("未知路径渲染 404", async () => {
    renderAt("/no-such-page");
    expect(await screen.findByText(/404/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回论文项目" })).toHaveAttribute("href", "/projects");
  });

  it("布局：顶栏渲染品牌与 Runtime 徽标（Pi schema）", async () => {
    renderAt("/projects");
    expect(await screen.findByText("PaperTeam")).toBeInTheDocument();
    const chip = await screen.findByTestId("runtime-chip");
    expect(chip).toHaveTextContent("Pi Runtime 0.84.4");
    expect(chip).toHaveTextContent("模型已配置");
  });

  it("Brand：PaperTeam 是返回论文项目的主页入口；不再出现 Research Workbench", async () => {
    renderAt("/skills");
    const brand = await screen.findByTestId("brand-home");
    expect(brand).toHaveAttribute("href", "/projects");
    expect(brand).toHaveAttribute("aria-label", "PaperTeam，返回论文项目");
    expect(screen.queryByText("Research Workbench")).toBeNull();
  });

  it("/settings 重定向到 /settings/model；Settings 二级导航可用", async () => {
    renderAt("/settings");
    expect(await screen.findByRole("heading", { name: "模型设置" })).toBeInTheDocument();
    const subnav = screen.getByTestId("settings-subnav");
    expect(subnav).toHaveTextContent("模型设置");
    expect(subnav).toHaveTextContent("项目管理");
  });

  it("/settings/projects 渲染项目管理页（已归档项目）", async () => {
    renderAt("/settings/projects");
    expect(await screen.findByRole("heading", { name: "项目管理" })).toBeInTheDocument();
    expect(await screen.findByText("暂无已归档项目。")).toBeInTheDocument();
  });
});
