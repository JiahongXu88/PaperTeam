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
  importProjectPaper: vi.fn(),
  getManuscriptOverview: vi.fn(async () => ({
    projectId: "p-new000000001",
    title: "全新论文项目",
    titleSource: "project",
    sourceType: "none",
    currentRevision: 0,
    sectionCount: 0,
    referenceCount: 0,
    build: null,
  })),
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

const { createProject, getProject, importProjectPaper } = await import("../src/api/projects.js");
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
    vi.mocked(importProjectPaper).mockClear();
    const user = userEvent.setup();
    renderCreateFlow();

    await user.click(screen.getByRole("radio", { name: /导入已有论文/ }));
    await user.click(screen.getByRole("button", { name: "导入论文" }));

    expect(await screen.findByTestId("validation-error")).toHaveTextContent("请先选择论文 PDF 文件");
    expect(importProjectPaper).not.toHaveBeenCalled();
  });

  it("快速 Review 导入成功：携带 goal，自动启动 Review 并落到 Review 页", async () => {
    const imported: ProjectView = {
      ...created,
      title: "Attention Is All You Need",
      workflowKind: "existing_paper_review",
    };
    vi.mocked(importProjectPaper).mockResolvedValue({ project: imported, document: importedDocument, titleSource: "pdf" });
    vi.mocked(getProject).mockResolvedValue(imported);
    vi.mocked(createWorkflowRun).mockClear();
    const user = userEvent.setup();
    renderCreateFlow();

    await user.click(screen.getByRole("radio", { name: /导入已有论文/ }));
    await user.upload(screen.getByLabelText("选择论文 PDF（.pdf）"), pdfFile);
    await user.click(screen.getByRole("button", { name: "导入论文" }));

    await waitFor(() => expect(importProjectPaper).toHaveBeenCalledTimes(1));
    expect(vi.mocked(importProjectPaper).mock.calls[0]![0]).toMatchObject({
      format: "pdf",
      fileName: "MRG-DTM-final.pdf",
      goal: "review_only",
    });
    // 模型已配置 → 自动启动快速 Review（语义核验缺省关闭，不阻碍快速导入）
    await waitFor(() =>
      expect(createWorkflowRun).toHaveBeenCalledWith(imported.id, "existing_paper_review", {
        citationSemanticMode: "off",
      }),
    );
    // 落到 Review Tab（工作区出现 Review 面板）
    await waitFor(() =>
      expect(screen.getByTestId("review-panel")).toBeInTheDocument(),
    );
  });

  it("导入高级选项：引用语义核验默认关闭，可切换后随自动 Review 一起提交", async () => {
    const imported: ProjectView = {
      ...created,
      title: "Attention Is All You Need",
      workflowKind: "existing_paper_review",
    };
    vi.mocked(importProjectPaper).mockResolvedValue({ project: imported, document: importedDocument, titleSource: "pdf" });
    vi.mocked(getProject).mockResolvedValue(imported);
    vi.mocked(importProjectPaper).mockClear();
    vi.mocked(createWorkflowRun).mockClear();
    const user = userEvent.setup();
    renderCreateFlow();

    await user.click(screen.getByRole("radio", { name: /导入已有论文/ }));
    await user.upload(screen.getByLabelText("选择论文 PDF（.pdf）"), pdfFile);

    // 高级选项默认折叠；展开后语义核验默认「关闭（推荐）」
    const advanced = screen.getByText("高级选项（研究领域、目标期刊等，可选）");
    expect((advanced.closest("details") as HTMLDetailsElement).open).toBe(false);
    await user.click(advanced);
    const modeSelect = screen.getByTestId("import-semantic-mode") as HTMLSelectElement;
    expect(modeSelect.value).toBe("off");
    expect(screen.getByText("仅核验参考文献真实性和元数据，不判断引用内容是否支持正文。")).toBeInTheDocument();

    await user.selectOptions(modeSelect, "contradiction_only");
    await user.click(screen.getByRole("button", { name: "导入论文" }));

    await waitFor(() => expect(importProjectPaper).toHaveBeenCalledTimes(1));
    await waitFor(() =>
      expect(createWorkflowRun).toHaveBeenCalledWith(imported.id, "existing_paper_review", {
        citationSemanticMode: "contradiction_only",
      }),
    );
  });

  it("系统性改进导入成功：不自动启动，落到工作区概览（先 Review 基线）", async () => {
    const imported: ProjectView = {
      ...created,
      title: "Attention Is All You Need",
      workflowKind: "existing_paper_improvement",
    };
    vi.mocked(importProjectPaper).mockResolvedValue({ project: imported, document: importedDocument, titleSource: "pdf" });
    vi.mocked(getProject).mockResolvedValue(imported);
    vi.mocked(createWorkflowRun).mockClear();
    const user = userEvent.setup();
    renderCreateFlow();

    await user.click(screen.getByRole("radio", { name: /导入已有论文/ }));
    await user.upload(screen.getByLabelText("选择论文 PDF（.pdf）"), pdfFile);
    await user.click(screen.getByTestId("goal-improvement"));
    await user.click(screen.getByRole("button", { name: "导入论文" }));

    await waitFor(() => expect(importProjectPaper).toHaveBeenCalledWith(expect.objectContaining({ goal: "improvement" })));
    // 系统性改进不自动启动 Review；落到概览并说明第一阶段
    expect(createWorkflowRun).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText("研究定位")).toBeInTheDocument());
    expect(screen.getByText(/第一阶段先完成「Review」建立基线/)).toBeInTheDocument();
  });

  it("导入失败：显示后端错误（如解析失败），停留在表单", async () => {
    vi.mocked(importProjectPaper).mockRejectedValue(
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

describe("NewProjectPage：导入 LaTeX 工程（M7.0.3 统一入口）", () => {
  const zipFile = new File([new Uint8Array([0x50, 0x4b, 0x03, 0x04])], "my-paper.zip", { type: "application/zip" });

  it("切换到 LaTeX 工程：goal 选项不出现，改为系统性改进说明", async () => {
    const user = userEvent.setup();
    renderCreateFlow();

    await user.click(screen.getByRole("radio", { name: /导入已有论文/ }));
    await user.click(screen.getByTestId("import-format-latex"));

    expect(screen.queryByTestId("goal-review_only")).toBeNull();
    expect(screen.queryByTestId("goal-improvement")).toBeNull();
    // 说明文本（<strong> 分段后仍可按连续片段断言）
    expect(screen.getByText(/先 Review 建立基线/)).toBeInTheDocument();
    expect(screen.getByText(/不会重写整篇论文/)).toBeInTheDocument();
    // 上传区切换为 ZIP 语义
    expect(screen.getByLabelText("选择 LaTeX 工程 ZIP 归档（.zip）")).toBeInTheDocument();
    expect(screen.getByText(/入口 \.tex 需含/)).toBeInTheDocument();
  });

  it("LaTeX 导入成功：format=latex + archiveBase64（无 goal / 无 document），不自动启动 Review", async () => {
    const imported: ProjectView = {
      ...created,
      title: "基于深度学习的多目标跟踪方法研究",
      workflowKind: "existing_paper_improvement",
    };
    vi.mocked(importProjectPaper).mockResolvedValue({ project: imported, titleSource: "latex" });
    vi.mocked(getProject).mockResolvedValue(imported);
    vi.mocked(importProjectPaper).mockClear();
    vi.mocked(createWorkflowRun).mockClear();
    const user = userEvent.setup();
    renderCreateFlow();

    await user.click(screen.getByRole("radio", { name: /导入已有论文/ }));
    await user.click(screen.getByTestId("import-format-latex"));
    await user.upload(screen.getByLabelText("选择 LaTeX 工程 ZIP 归档（.zip）"), zipFile);
    await user.click(screen.getByRole("button", { name: "导入论文" }));

    await waitFor(() => expect(importProjectPaper).toHaveBeenCalledTimes(1));
    expect(vi.mocked(importProjectPaper).mock.calls[0]![0]).toEqual({
      format: "latex",
      fileName: "my-paper.zip",
      archiveBase64: expect.any(String),
    });
    // LaTeX 只走系统性改进：不自动启动快速 Review，落到概览
    expect(createWorkflowRun).not.toHaveBeenCalled();
    await waitFor(() => expect(screen.getByText("研究定位")).toBeInTheDocument());
  });

  it("LaTeX 模式未选文件直接导入：提示先选择归档，不调用 API", async () => {
    vi.mocked(importProjectPaper).mockClear();
    const user = userEvent.setup();
    renderCreateFlow();

    await user.click(screen.getByRole("radio", { name: /导入已有论文/ }));
    await user.click(screen.getByTestId("import-format-latex"));
    await user.click(screen.getByRole("button", { name: "导入论文" }));

    expect(await screen.findByTestId("validation-error")).toHaveTextContent("请先选择 LaTeX 工程 ZIP 归档");
    expect(importProjectPaper).not.toHaveBeenCalled();
  });

  it("validateZipFile：拒绝非 .zip 与空文件（选择后的即时校验）", async () => {
    const { validateZipFile } = await import("../src/utils/file.js");
    expect(validateZipFile(new File(["x"], "paper.pdf", { type: "application/pdf" }))).toBe("只接受 .zip 归档文件");
    expect(validateZipFile(new File([], "empty.zip", { type: "application/zip" }))).toBe("文件为空");
    expect(validateZipFile(zipFile)).toBeNull();
  });
});
