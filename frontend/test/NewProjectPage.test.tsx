import { describe, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { NewProjectPage } from "../src/pages/NewProjectPage.js";
import { ProjectPage } from "../src/pages/ProjectPage.js";
import { ApiError } from "../src/api/client.js";
import type { ProjectView } from "../src/types/api.js";
import { renderWithProviders } from "./helpers.js";

/**
 * NewProjectPage（Project Entry UX 2026-09）：
 * - 二选一入口：从研究想法开始 / 导入已有论文
 * - 导入已有论文 = File First：无标题必填，PDF + goal，高级选项默认折叠
 * - 导入成功导航：快速 Review → ?tab=review（模型就绪时自动启动）；系统性改进 → 概览
 */

vi.mock("../src/api/projects.js", () => ({
  listProjects: vi.fn(async () => []),
  getProject: vi.fn(),
  createProject: vi.fn(),
  importProjectPdf: vi.fn(),
}));

vi.mock("../src/api/runs.js", () => ({
  listProjectRuns: vi.fn(async () => []),
  createWorkflowRun: vi.fn(async () => ({ runId: "w-1", status: "pending" })),
}));

vi.mock("../src/api/paper.js", () => ({
  getPaper: vi.fn(async () => ({ document: null })),
  uploadPaperPdf: vi.fn(),
  listCitations: vi.fn(async () => ({
    summary: {
      extracted: false,
      references: 0,
      callouts: 0,
      resolvedRelations: 0,
      unresolvedRelations: 0,
      invalidRelations: 0,
      referencesWithDoi: 0,
    },
    references: [],
  })),
  getCitationIntegrity: vi.fn(async () => ({ report: null })),
  getPaperReviewReport: vi.fn(async () => null),
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

const { createProject, getProject, importProjectPdf } = await import("../src/api/projects.js");
const { createWorkflowRun } = await import("../src/api/runs.js");

const created: ProjectView = {
  id: "p-new000000001",
  title: "全新论文项目",
  status: "created",
  createdAt: "2026-09-04T12:00:00.000Z",
  updatedAt: "2026-09-04T12:00:00.000Z",
};

/** 导入响应里的文档摘要（与 GET /paper 的 document 同形） */
const importedDocument = {
  projectId: "p-new",
  documentId: "paper-1",
  title: "Attention Is All You Need",
  originalFileName: "attention.pdf",
  bytes: 2048,
  sha256: "abc123def456",
  parse: { parserId: "pymupdf", parsedAt: "2026-09-07T00:00:00.000Z", durationMs: 100, pageCount: 15, extractionQuality: "good" as const },
  pageCount: 15,
  sectionCount: 23,
  chunkCount: 27,
  ingestedAt: "2026-09-07T00:00:00.000Z",
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

const pdfFile = new File(["%PDF-1.5 fake"], "MRG-DTM-final.pdf", { type: "application/pdf" });

describe("NewProjectPage", () => {
  it("标题为空提交（研究想法模式）：显示校验错误，不调用 API", async () => {
    vi.mocked(createProject).mockClear();
    const user = userEvent.setup();
    renderCreateFlow();

    await user.click(screen.getByRole("button", { name: "创建项目" }));

    expect(await screen.findByTestId("validation-error")).toHaveTextContent("论文标题不能为空");
    expect(createProject).not.toHaveBeenCalled();
  });

  it("合法提交（从研究想法开始）：payload 裁剪空字段，成功后导航到项目概览", async () => {
    vi.mocked(createProject).mockResolvedValue(created);
    vi.mocked(getProject).mockResolvedValue(created);
    const user = userEvent.setup();
    renderCreateFlow();

    await user.type(screen.getByLabelText(/论文标题/), "  全新论文项目  ");
    await user.type(screen.getByLabelText("研究想法"), "从想法到论文");
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
});

describe("NewProjectPage：导入已有论文（File First）", () => {
  it("切换到导入模式：不出现标题必填字段，高级选项默认折叠", async () => {
    const user = userEvent.setup();
    renderCreateFlow();

    await user.click(screen.getByRole("radio", { name: /导入已有论文/ }));

    expect(screen.getByTestId("existing-import-form")).toBeInTheDocument();
    // Gate G：标题不是前置字段（无任何标题文本输入框）
    expect(screen.queryByRole("textbox", { name: /论文标题/ })).toBeNull();
    // 高级选项默认折叠（研究领域等非必要字段收起）
    const advanced = screen
      .getByText("高级选项（研究领域、目标期刊等，可选）")
      .closest("details") as HTMLDetailsElement;
    expect(advanced.open).toBe(false);
    // 两个 goal 入口，快速 Review 为默认
    expect(screen.getByTestId("goal-review_only")).toHaveClass("selected");
    expect(screen.getByTestId("goal-improvement")).not.toHaveClass("selected");
  });

  it("未选 PDF 直接导入：提示先选择文件，不调用 API", async () => {
    vi.mocked(importProjectPdf).mockClear();
    const user = userEvent.setup();
    renderCreateFlow();

    await user.click(screen.getByRole("radio", { name: /导入已有论文/ }));
    await user.click(screen.getByRole("button", { name: "导入论文" }));

    expect(await screen.findByTestId("validation-error")).toHaveTextContent("请先选择论文 PDF 文件");
    expect(importProjectPdf).not.toHaveBeenCalled();
  });

  it("快速 Review 导入成功：携带 goal，自动启动 Review 并落到 Review 页", async () => {
    const imported: ProjectView = {
      ...created,
      title: "Attention Is All You Need",
      workflowKind: "existing_paper_review",
    };
    vi.mocked(importProjectPdf).mockResolvedValue({ project: imported, document: importedDocument, titleSource: "pdf" });
    vi.mocked(getProject).mockResolvedValue(imported);
    vi.mocked(createWorkflowRun).mockClear();
    const user = userEvent.setup();
    renderCreateFlow();

    await user.click(screen.getByRole("radio", { name: /导入已有论文/ }));
    await user.upload(screen.getByLabelText("选择论文 PDF（.pdf）"), pdfFile);
    await user.click(screen.getByRole("button", { name: "导入论文" }));

    await waitFor(() => expect(importProjectPdf).toHaveBeenCalledTimes(1));
    const payload = vi.mocked(importProjectPdf).mock.calls[0]![0];
    expect(payload.fileName).toBe("MRG-DTM-final.pdf");
    expect(payload.goal).toBe("review_only");
    // 模型已配置 → 自动启动快速 Review
    await waitFor(() =>
      expect(createWorkflowRun).toHaveBeenCalledWith(imported.id, "existing_paper_review"),
    );
    // 落到 Review Tab（工作区出现 Review 面板）
    await waitFor(() =>
      expect(screen.getByTestId("review-panel")).toBeInTheDocument(),
    );
  });

  it("系统性改进导入成功：不自动启动，落到工作区概览（先 Review 基线）", async () => {
    const imported: ProjectView = {
      ...created,
      title: "Attention Is All You Need",
      workflowKind: "existing_paper_improvement",
    };
    vi.mocked(importProjectPdf).mockResolvedValue({ project: imported, document: importedDocument, titleSource: "pdf" });
    vi.mocked(getProject).mockResolvedValue(imported);
    vi.mocked(createWorkflowRun).mockClear();
    const user = userEvent.setup();
    renderCreateFlow();

    await user.click(screen.getByRole("radio", { name: /导入已有论文/ }));
    await user.upload(screen.getByLabelText("选择论文 PDF（.pdf）"), pdfFile);
    await user.click(screen.getByTestId("goal-improvement"));
    await user.click(screen.getByRole("button", { name: "导入论文" }));

    await waitFor(() => expect(importProjectPdf).toHaveBeenCalledWith(expect.objectContaining({ goal: "improvement" })));
    // 系统性改进不自动启动 Review；落到概览并说明第一阶段
    expect(createWorkflowRun).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText("研究定位")).toBeInTheDocument());
    expect(screen.getByText(/第一阶段先完成「Review」建立基线/)).toBeInTheDocument();
  });

  it("导入失败：显示后端错误（如解析失败），停留在表单", async () => {
    vi.mocked(importProjectPdf).mockRejectedValue(
      new ApiError(400, "INVALID_REQUEST", "不是合法 PDF（缺少 %PDF- 文件头）"),
    );
    const user = userEvent.setup();
    renderCreateFlow();

    await user.click(screen.getByRole("radio", { name: /导入已有论文/ }));
    await user.upload(screen.getByLabelText("选择论文 PDF（.pdf）"), pdfFile);
    await user.click(screen.getByRole("button", { name: "导入论文" }));

    expect(await screen.findByRole("alert")).toHaveTextContent("导入失败");
    expect(screen.getByRole("button", { name: "导入论文" })).toBeEnabled();
  });
});
