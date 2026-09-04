import { describe, expect, it, vi } from "vitest";
import { screen } from "@testing-library/react";

import { AppRoutes } from "../src/router/index.js";
import type { ProjectView } from "../src/types/api.js";
import { renderWithProviders } from "./helpers.js";

/** 路由（M4.1）：/ 重定向、四个真实路由、404 */

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

function renderAt(route: string) {
  return renderWithProviders(<AppRoutes />, { route });
}

describe("routing", () => {
  it("/ 重定向到 /projects（渲染项目列表）", async () => {
    renderAt("/");
    expect(await screen.findByText("My Papers")).toBeInTheDocument();
  });

  it("/projects 渲染项目列表页", async () => {
    renderAt("/projects");
    expect(await screen.findByText("My Papers")).toBeInTheDocument();
  });

  it("/projects/new 渲染创建页", async () => {
    renderAt("/projects/new");
    expect(await screen.findByText("New Project")).toBeInTheDocument();
  });

  it("未知路径渲染 404", async () => {
    renderAt("/no-such-page");
    expect(await screen.findByText(/404/)).toBeInTheDocument();
    expect(screen.getByRole("link", { name: "返回项目列表" })).toHaveAttribute("href", "/projects");
  });

  it("布局：顶栏渲染品牌与 Runtime 徽标（Pi schema）", async () => {
    renderAt("/projects");
    expect(await screen.findByText("PaperTeam")).toBeInTheDocument();
    const chip = await screen.findByTestId("runtime-chip");
    expect(chip).toHaveTextContent("Pi 0.84.4");
    expect(chip).toHaveTextContent("模型已配置");
  });
});
