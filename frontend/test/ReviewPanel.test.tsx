import { describe, expect, it, vi } from "vitest";
import { screen, within } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ReviewPanel } from "../src/components/project/ReviewPanel.js";
import type { ExistingReviewReportView, WorkflowRunView } from "../src/types/api.js";
import type { PaperResponse } from "../src/types/paper.js";
import { renderWithProviders } from "./helpers.js";

/**
 * Review 报告视图（原型驱动重构 2026-09）：
 * - 概要卡：章节进度 + 四级严重度统计块（真实 bySeverity）
 * - 发现列表：真实 ReviewFinding DTO；严重度 / 类别 / 搜索 / 排序都是前端对已加载数据的过滤
 * - 不渲染后端不存在的能力（定位 PDF / 查看原文 / 分享）
 */

vi.mock("../src/api/paper.js", () => ({
  getPaper: vi.fn(),
  getPaperReviewReport: vi.fn(),
  exportReviewReport: vi.fn(),
}));

vi.mock("../src/api/runs.js", () => ({
  listProjectRuns: vi.fn(),
  createWorkflowRun: vi.fn(),
}));

vi.mock("../src/api/runtime.js", () => ({
  getRuntimeStatus: vi.fn(async () => ({
    backend: { ok: true },
    runtime: { provider: "pi", phase: "healthy", version: "0.84.4", detail: "ok", latencyMs: 1 },
    model: { phase: "configured", providers: ["zai"], detail: "ok" },
    agents: { roles: [] },
    sessions: { activeRuns: 0, managedSessions: 0 },
  })),
}));

const paperApi = await import("../src/api/paper.js");
const runsApi = await import("../src/api/runs.js");

const paper: PaperResponse = {
  document: {
    projectId: "p-review0001",
    documentId: "paper-1",
    title: "运动残差门控记忆与轨迹稳定约束的车载多目标跟踪方法",
    originalFileName: "paper.pdf",
    bytes: 3635444,
    sha256: "abc",
    parse: { parserId: "pymupdf", parsedAt: "2026-09-07T04:25:09.001Z", durationMs: 251, pageCount: 26, extractionQuality: "good" },
    pageCount: 26,
    sectionCount: 3,
    chunkCount: 5,
    ingestedAt: "2026-09-07T04:25:09.001Z",
  },
  sections: [
    { sectionId: "SEC01", title: "引言", level: 1, pageStart: 2, pageEnd: 4, charCount: 100, source: "toc" },
    { sectionId: "SEC02", title: "方法", level: 1, pageStart: 4, pageEnd: 9, charCount: 100, source: "toc" },
    { sectionId: "SEC03", title: "实验", level: 1, pageStart: 10, pageEnd: 14, charCount: 100, source: "toc" },
  ],
};

const report: ExistingReviewReportView = {
  schemaVersion: 1,
  kind: "existing_paper_review",
  round: 1,
  generatedAt: "2026-09-07T06:47:46.385Z",
  paper: { title: paper.document!.title!, pageCount: 26, sections: 3 },
  review: {
    sectionsReviewed: 2,
    sectionsTotal: 3,
    skippedSections: 1,
    emptySections: 1,
    failedSections: 0,
    findingsTotal: 3,
    bySeverity: { critical: 0, major: 1, minor: 1, info: 1 },
    byCategory: { academic: 1, consistency: 1, style: 1 },
  },
  citationIntegrity: { probableFabrications: [] },
  findings: [
    {
      findingId: "f-3",
      category: "style",
      severity: "info",
      sectionId: "SEC03",
      page: 12,
      message: "符号 xt 在不同章节含义不一致。",
      suggestion: "在符号表统一定义。",
      status: "open",
      source: "section-review",
    },
    {
      findingId: "f-1",
      category: "academic",
      severity: "major",
      sectionId: "SEC02",
      page: 5,
      claimText: "残差门控机制（Residual Gating）是核心创新点",
      message: "残差门控机制的定义不够清晰，未给出门控函数的具体形式。",
      suggestion: "在方法章节补充门控函数的数学定义。",
      status: "open",
      source: "section-review",
    },
    {
      findingId: "f-2",
      category: "consistency",
      severity: "minor",
      sectionId: "SEC01",
      page: 3,
      message: "作者单位与通信作者邮箱域名不一致。",
      status: "open",
      source: "section-review",
    },
  ],
};

const completedRun: WorkflowRunView = {
  runId: "w-1",
  projectId: "p-review0001",
  workflowKind: "existing_paper_review",
  status: "completed",
  createdAt: "2026-09-07T04:43:30.475Z",
  updatedAt: "2026-09-07T06:47:46.398Z",
};

function renderReview() {
  vi.mocked(paperApi.getPaper).mockResolvedValue(paper);
  vi.mocked(paperApi.getPaperReviewReport).mockResolvedValue(report);
  vi.mocked(runsApi.listProjectRuns).mockResolvedValue([completedRun]);
  return renderWithProviders(<ReviewPanel projectId="p-review0001" onOpenTab={() => {}} />);
}

describe("ReviewPanel 报告视图", () => {
  it("概要：章节进度、严重度统计块与轮次信息来自真实报告字段", async () => {
    renderReview();
    const reportBlock = await screen.findByTestId("review-report");
    expect(within(reportBlock).getByRole("img", { name: "章节完成 2 / 3" })).toBeInTheDocument();
    expect(within(reportBlock).getByText(/已审阅 2 \/ 3 节（1 节只有标题没有正文）/)).toBeInTheDocument();
    expect(within(reportBlock).getByText(/第 1 轮/)).toBeInTheDocument();
    // 四个统计块：严重 0 / 主要 1 / 次要 1 / 提示 1
    const blocks = reportBlock.querySelectorAll(".stat-block");
    expect(blocks).toHaveLength(4);
    expect(blocks[0]).toHaveTextContent("严重0");
    expect(blocks[1]).toHaveTextContent("主要1");
  });

  it("发现列表：默认按论文顺序；卡片含页码 / 严重度 / 类别 / 章节 / 原文 / 建议；不出现假动作", async () => {
    renderReview();
    await screen.findByTestId("review-report");
    const cards = screen.getAllByTestId("finding-card");
    expect(cards.map((card) => card.textContent?.slice(0, 3))).toEqual(["p3次", "p5主", "p12"]);
    const major = cards[1]!;
    expect(major).toHaveClass("finding-major");
    expect(within(major).getByText("主要")).toBeInTheDocument();
    expect(within(major).getByText("学术")).toBeInTheDocument();
    expect(within(major).getByText("方法")).toBeInTheDocument();
    expect(within(major).getByText(/Residual Gating/)).toBeInTheDocument();
    expect(within(major).getByText("建议")).toBeInTheDocument();
    expect(within(major).getByText(/补充门控函数的数学定义/)).toBeInTheDocument();
    // 后端没有 PDF 定位 / 原文查看 / 分享能力：卡片上不渲染这些按钮
    expect(screen.queryByRole("button", { name: /定位到 PDF|查看原文|分享/ })).toBeNull();
  });

  it("严重度筛选 + 搜索 + 排序都在已加载数据上完成", async () => {
    renderReview();
    await screen.findByTestId("review-report");
    const user = userEvent.setup();

    await user.click(screen.getByRole("radio", { name: /^主要/ }));
    expect(screen.getAllByTestId("finding-card")).toHaveLength(1);
    expect(screen.getByText(/当前显示 1 条/)).toBeInTheDocument();

    await user.click(screen.getByRole("radio", { name: /^全部/ }));
    await user.type(screen.getByRole("searchbox", { name: "搜索审阅发现" }), "邮箱");
    expect(screen.getAllByTestId("finding-card")).toHaveLength(1);
    expect(screen.getByText(/邮箱域名不一致/)).toBeInTheDocument();
    await user.clear(screen.getByRole("searchbox", { name: "搜索审阅发现" }));

    await user.selectOptions(screen.getByRole("combobox", { name: "排序" }), "severity");
    const sorted = screen.getAllByTestId("finding-card");
    expect(sorted[0]).toHaveClass("finding-major");
    expect(sorted[2]).toHaveClass("finding-info");

    await user.selectOptions(screen.getByRole("combobox", { name: "按类别筛选" }), "style");
    expect(screen.getAllByTestId("finding-card")).toHaveLength(1);
    expect(screen.getByText("表达")).toBeInTheDocument();
  });

  it("已有报告时提供导出与重新 Review 两个真实动作", async () => {
    renderReview();
    await screen.findByTestId("review-report");
    expect(screen.getByTestId("export-report")).toHaveTextContent("导出报告");
    expect(screen.getByTestId("start-review")).toHaveTextContent("重新 Review");
  });
});
