import { describe, expect, it, vi } from "vitest";
import { Route, Routes } from "react-router-dom";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ProjectPage } from "../src/pages/ProjectPage.js";
import type { ProjectView } from "../src/types/api.js";
import { renderWithProviders } from "./helpers.js";

/**
 * ProjectPage Tab 导航（UX Polish 2026-09）：
 * - Tab 状态进 URL（?tab=），按初始路径恢复
 * - 无效 / 未开放 tab 回退概览
 * - 一级导航只暴露真实可用模块（工作流等占位不再渲染）
 */

vi.mock("../src/api/projects.js", () => ({
  listProjects: vi.fn(async () => [] as ProjectView[]),
  getProject: vi.fn(),
  createProject: vi.fn(),
  getManuscriptOverview: vi.fn(async () => ({
    projectId: "p-tab00000001",
    title: "Tab 状态项目",
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
}));

vi.mock("../src/api/paper.js", () => ({
  getPaper: vi.fn(async () => ({ document: null })),
  uploadPaperPdf: vi.fn(),
  listCitations: vi.fn(),
  extractCitations: vi.fn(),
  verifyMetadata: vi.fn(),
  verifyClaims: vi.fn(),
  getCitationIntegrity: vi.fn(),
  getMetadataRecords: vi.fn(),
  getClaimRecords: vi.fn(async () => []),
  exportReviewReport: vi.fn(),
}));

// M4.6：证据 / 质量门禁 API（默认空态；需要数据的用例单独覆写）
vi.mock("../src/api/evidence.js", () => ({
  listEvidence: vi.fn(async () => []),
  getEvidence: vi.fn(),
  confirmEvidenceVerified: vi.fn(),
  getQualityGate: vi.fn(async () => ({
    rounds: [],
    round: null,
    gate: null,
    reviewSummary: null,
    latestReviewRound: null,
    stale: false,
  })),
  reevaluateQualityGate: vi.fn(),
}));

// M7.1c：Discovery 面板数据（默认空候选）
vi.mock("../src/api/discovery.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/discovery.js")>();
  return {
    ...actual,
    listCandidates: vi.fn(async () => []),
  };
});

// M8.1：Research Plan（默认无计划空态）
vi.mock("../src/api/researchPlan.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/researchPlan.js")>();
  return {
    ...actual,
    getResearchPlan: vi.fn(async () => null),
  };
});

const { getProject, getManuscriptOverview } = await import("../src/api/projects.js");
const paperApi = await import("../src/api/paper.js");
const listCitations = vi.mocked(paperApi.listCitations);
const getCitationIntegrity = vi.mocked(paperApi.getCitationIntegrity);
const getMetadataRecords = vi.mocked(paperApi.getMetadataRecords);

const project: ProjectView = {
  id: "p-tab00000001",
  title: "Tab 状态项目",
  status: "created",
  workflowKind: "existing_paper_improvement",
  createdAt: "2026-09-06T00:00:00.000Z",
  updatedAt: "2026-09-06T00:00:00.000Z",
};

function renderProjectAt(route: string) {
  vi.mocked(getProject).mockResolvedValue(project);
  // 引用未提取的空态（CitationsPanel 引导视图）
  listCitations.mockResolvedValue({
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
  });
  getCitationIntegrity.mockResolvedValue(undefined as never);
  getMetadataRecords.mockResolvedValue([]);
  // useParams 需要真实路由匹配（?tab= 由 searchParams 提供）
  return renderWithProviders(
    <Routes>
      <Route path="/projects/:projectId" element={<ProjectPage />} />
    </Routes>,
    { route },
  );
}

describe("ProjectPage Tab 导航（UX Polish 2026-09）", () => {
  it("默认渲染概览；一级导航只含真实可用模块", async () => {
    renderProjectAt("/projects/p-tab00000001");

    expect(await screen.findByText("Tab 状态项目")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "概览" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "PDF 与结构" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "引用核验" })).toBeInTheDocument();
    // M4.4：工作流 tab 正式开放（所有项目）；M4.6：证据 tab（所有项目）
    expect(screen.getByRole("tab", { name: "工作流" })).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "证据" })).toBeInTheDocument();
    // 未开放模块不占一级导航
    expect(screen.queryByRole("tab", { name: /审稿/ })).not.toBeInTheDocument();
    expect(screen.queryByText("Soon")).not.toBeInTheDocument();
    // 概览内容在渲染
    expect(screen.getByText("研究定位")).toBeInTheDocument();
  });

  it("?tab=citations 恢复到引用核验", async () => {
    renderProjectAt("/projects/p-tab00000001?tab=citations");

    expect(await screen.findByText("尚未提取引用")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "引用核验" })).toHaveAttribute("aria-selected", "true");
    expect(screen.queryByText("研究定位")).not.toBeInTheDocument();
  });

  it("?tab=pdf 恢复到 PDF 与结构", async () => {
    renderProjectAt("/projects/p-tab00000001?tab=pdf");

    expect(await screen.findByText("上传最终 PDF")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "PDF 与结构" })).toHaveAttribute("aria-selected", "true");
  });

  it("M7.1c：?tab=discovery 进入 Discovery（检索 → 候选审阅）", async () => {
    renderProjectAt("/projects/p-tab00000001?tab=discovery");

    expect(await screen.findByText("研究检索")).toBeInTheDocument();
    expect(screen.getByText("候选文献")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "Discovery" })).toHaveAttribute("aria-selected", "true");
  });

  it("无效 / 未开放 tab 回退概览；?tab=evidence 进入证据工作台", async () => {
    const view = renderProjectAt("/projects/p-tab00000001?tab=evidence");
    expect(await screen.findByText("当前项目还没有可展示的证据")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "证据" })).toHaveAttribute("aria-selected", "true");
    view.unmount();

    renderProjectAt("/projects/p-tab00000001?tab=nonsense");
    await waitFor(() => expect(screen.getByText("研究定位")).toBeInTheDocument());
  });

  it("点击 Tab 切换内容", async () => {
    renderProjectAt("/projects/p-tab00000001");
    const user = userEvent.setup();

    await screen.findByText("研究定位");
    await user.click(screen.getByRole("tab", { name: "引用核验" }));
    expect(await screen.findByText("尚未提取引用")).toBeInTheDocument();
    expect(screen.getByRole("tab", { name: "引用核验" })).toHaveAttribute("aria-selected", "true");

    // 切回概览
    await user.click(screen.getByRole("tab", { name: "概览" }));
    expect(await screen.findByText("研究定位")).toBeInTheDocument();
  });
});

describe("ProjectPage 概览：当前稿件信息卡（M7.0.3）", () => {
  it("渲染 Backend 聚合视图：来源 / 修订 / 章节 / 参考文献 / 构建状态", async () => {
    vi.mocked(getManuscriptOverview).mockResolvedValue({
      projectId: project.id,
      title: "Tab 状态项目",
      titleSource: "project",
      sourceType: "latex",
      currentRevision: 3,
      sectionCount: 6,
      referenceCount: 28,
      build: { passed: true, checkedAt: "2026-09-18T08:00:00.000Z", revision: 2, stale: true },
    });
    renderProjectAt("/projects/p-tab00000001");

    const card = await screen.findByTestId("manuscript-card");
    expect(card).toHaveTextContent("LaTeX 工程导入");
    expect(card).toHaveTextContent("rev 3");
    expect(card).toHaveTextContent("6 节");
    expect(card).toHaveTextContent("28 条");
    expect(screen.getByTestId("manuscript-build")).toHaveTextContent("已过期");
    // 明确「这是正在修改的稿件」并与文献库相区分
    expect(screen.getByTestId("manuscript-title-line")).toHaveTextContent("正在修改的论文稿件");
    expect(screen.getByTestId("manuscript-title-line")).toHaveTextContent("不是稿件本身");
  });

  it("尚无稿件（sourceType=none）：如实展示空态与「查看论文产出」入口", async () => {
    vi.mocked(getManuscriptOverview).mockResolvedValue({
      projectId: project.id,
      title: "Tab 状态项目",
      titleSource: "project",
      sourceType: "none",
      currentRevision: 0,
      sectionCount: 0,
      referenceCount: 0,
      build: null,
    });
    renderProjectAt("/projects/p-tab00000001");

    const card = await screen.findByTestId("manuscript-card");
    expect(card).toHaveTextContent("尚未创建稿件");
    expect(card).toHaveTextContent("尚无修订");
    expect(screen.getByTestId("manuscript-build")).toHaveTextContent("未构建");
    expect(screen.getByTestId("manuscript-goto")).toHaveTextContent("查看论文产出");
  });
});
