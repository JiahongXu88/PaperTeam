import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ReviewPanel } from "../src/components/project/ReviewPanel.js";
import type { ManuscriptOverviewView, RuntimeStatusView, WorkflowRunView } from "../src/types/api.js";
import { renderWithProviders } from "./helpers.js";

/**
 * M14.8-MOT 真实验收暴露：LaTeX 工程导入的系统性改进项目没有论文 PDF（导入只写
 * manuscript/，不产生 PaperDocument），ReviewPanel 只显示「前往上传 PDF」——整个
 * 产品里没有任何「开始系统性改进」入口，尽管后端 import.parse 直接校验 main.tex、
 * 不需要 PDF。修复：LaTeX 稿件 + 改进项目在无 PDF 时直接给出改进入口与外部意见面板；
 * PDF 稿件 / 快速 Review 项目的「先上传 PDF」引导保持不变。
 */

vi.mock("../src/api/paper.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api/paper.js")>()),
  getPaper: vi.fn(async () => ({ document: null, sections: [] })),
}));
vi.mock("../src/api/projects.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api/projects.js")>()),
  getManuscriptOverview: vi.fn(),
}));
vi.mock("../src/api/artifacts.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api/artifacts.js")>()),
  getPaperReviewReport: vi.fn(async () => null),
}));
vi.mock("../src/api/runs.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api/runs.js")>()),
  listProjectRuns: vi.fn(async () => [] as WorkflowRunView[]),
  createWorkflowRun: vi.fn(),
}));
vi.mock("../src/api/runtime.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api/runtime.js")>()),
  getRuntimeStatus: vi.fn(),
}));
vi.mock("../src/api/externalInstructions.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api/externalInstructions.js")>()),
  listExternalInstructions: vi.fn(async () => []),
  getRevisionPlan: vi.fn(async () => null),
}));
vi.mock("../src/api/evidence.js", async (importOriginal) => ({
  ...(await importOriginal<typeof import("../src/api/evidence.js")>()),
  getQualityGate: vi.fn(async () => ({ gate: null, reviewSummary: null, round: null })),
}));

const projectsApi = vi.mocked(await import("../src/api/projects.js"));
const runsApi = vi.mocked(await import("../src/api/runs.js"));
const runtimeApi = vi.mocked(await import("../src/api/runtime.js"));

const PROJECT = "p-latex0000001";

function overview(sourceType: ManuscriptOverviewView["sourceType"]): ManuscriptOverviewView {
  return { projectId: PROJECT, title: "LaTeX 稿件", titleSource: "project", sourceType, currentRevision: 0, sectionCount: 10, referenceCount: 42, build: null };
}

function runtimeStatus(phase: "configured" | "not_configured"): RuntimeStatusView {
  return {
    backend: { ok: true },
    runtime: { provider: "pi", phase: "healthy", version: "1.0.1", detail: "", latencyMs: 1 },
    model: { phase, ...(phase === "configured" ? { model: "test-model", providers: ["test"] } : { providers: [] }), detail: "" },
    agents: { roles: [] },
    sessions: { activeRuns: 0, managedSessions: 0 },
  };
}

function renderPanel(sourceType: ManuscriptOverviewView["sourceType"], kind: "existing_paper_improvement" | "existing_paper_review", phase: "configured" | "not_configured" = "configured") {
  projectsApi.getManuscriptOverview.mockResolvedValue(overview(sourceType));
  runtimeApi.getRuntimeStatus.mockResolvedValue(runtimeStatus(phase));
  runsApi.listProjectRuns.mockResolvedValue([]);
  return renderWithProviders(<ReviewPanel projectId={PROJECT} workflowKind={kind} onOpenTab={() => {}} />, { route: `/projects/${PROJECT}` });
}

afterEach(() => {
  vi.clearAllMocks();
});

describe("ReviewPanel：LaTeX 工程导入项目无需 PDF 即可开始系统性改进", () => {
  it("LaTeX 稿件 + 改进项目：显示「开始系统性改进」，点击创建 existing_paper_improvement run", async () => {
    runsApi.createWorkflowRun.mockResolvedValue({ runId: "w-1", status: "queued", workflowKind: "existing_paper_improvement" } as never);
    renderPanel("latex", "existing_paper_improvement");
    const start = await screen.findByTestId("start-improvement");
    expect(screen.getByTestId("latex-improvement-start")).toBeTruthy();
    expect(screen.queryByText("尚未导入论文 PDF")).toBeNull();
    await userEvent.click(start);
    await waitFor(() => expect(runsApi.createWorkflowRun).toHaveBeenCalledTimes(1));
    expect(runsApi.createWorkflowRun.mock.calls[0]?.slice(0, 2)).toEqual([PROJECT, "existing_paper_improvement"]);
    expect(JSON.stringify(runsApi.createWorkflowRun.mock.calls[0])).toContain("suggest_only");
    // 外部审稿意见入口在改进开始前就可用（批量导入 / 逐条录入）
    expect(await screen.findByText(/批量导入 Reviewer/)).toBeTruthy();
  });

  it("模型未配置：入口禁用并给出模型设置指引", async () => {
    renderPanel("latex", "existing_paper_improvement", "not_configured");
    const start = await screen.findByTestId("start-improvement");
    await waitFor(() => expect((start as HTMLButtonElement).disabled).toBe(true));
    expect(screen.getByTestId("review-model-missing")).toBeTruthy();
  });

  it("PDF 稿件（无解析结果）仍是「先上传 PDF」引导，不出现改进入口", async () => {
    renderPanel("pdf", "existing_paper_improvement");
    expect(await screen.findByText("尚未导入论文 PDF")).toBeTruthy();
    expect(screen.queryByTestId("start-improvement")).toBeNull();
  });

  it("快速 Review 项目不受影响：无 PDF 时只引导上传", async () => {
    renderPanel("latex", "existing_paper_review");
    expect(await screen.findByText("尚未导入论文 PDF")).toBeTruthy();
    expect(screen.queryByTestId("start-improvement")).toBeNull();
  });
});
