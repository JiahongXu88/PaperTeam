import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { ReviewPanel } from "../src/components/project/ReviewPanel.js";
import { renderWithProviders } from "./helpers.js";
import type { VisualReviewReportView } from "../src/api/visuals.js";

/**
 * M12.2 B5 ReviewPanel 视觉检查区：
 * - 尚未运行 → 明确空态（非空白）
 * - 已运行（deterministic-only）→ 确定性 / Vision 两组严格分栏 + vision 不可用原因
 * - 运行按钮触发真实 API 调用
 */

vi.mock("../src/api/paper.js", () => ({
  getPaper: vi.fn(),
  getPaperReviewReport: vi.fn(async () => null),
  exportReviewReport: vi.fn(),
}));
vi.mock("../src/api/runs.js", () => ({
  listProjectRuns: vi.fn(async () => []),
  createWorkflowRun: vi.fn(),
}));
vi.mock("../src/api/externalInstructions.js", () => ({
  listExternalInstructions: vi.fn(async () => ({ instructions: [], sectionOptions: [] })),
  addExternalInstruction: vi.fn(),
  deleteExternalInstruction: vi.fn(),
  getRevisionPlan: vi.fn(async () => ({ round: null, plan: null })),
}));
vi.mock("../src/api/runtime.js", () => ({
  getRuntimeStatus: vi.fn(async () => ({
    backend: { ok: true },
    runtime: { provider: "pi", phase: "healthy", version: "1.0.1", detail: "ok", latencyMs: 1 },
    model: { phase: "configured", providers: ["zai"], detail: "ok" },
    agents: { roles: [] },
    sessions: { activeRuns: 0, managedSessions: 0 },
  })),
}));
vi.mock("../src/api/visuals.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/api/visuals.js")>();
  return {
    ...actual,
    getVisualReviewReport: vi.fn(),
    runVisualReview: vi.fn(),
  };
});

const visualsApi = await import("../src/api/visuals.js");
const paperApi = await import("../src/api/paper.js");

// ReviewPanel 在 doc === null 时整体不渲染——视觉区测试需要一篇已导入论文
const PAPER_FIXTURE = {
  document: {
    projectId: "p-review0001",
    documentId: "paper-1",
    title: "视觉检查测试论文",
    originalFileName: "paper.pdf",
    bytes: 1000,
    sha256: "abc",
    parse: { parserId: "pymupdf", parsedAt: "2026-10-07T00:00:00Z", durationMs: 10, pageCount: 5, extractionQuality: "good" },
    pageCount: 5,
    sectionCount: 2,
    chunkCount: 5,
    ingestedAt: "2026-10-07T00:00:00Z",
  },
  sections: [
    { sectionId: "SEC01", title: "引言", level: 1, pageStart: 1, pageEnd: 2, charCount: 100, source: "toc" },
    { sectionId: "SEC02", title: "方法", level: 1, pageStart: 3, pageEnd: 4, charCount: 100, source: "toc" },
  ],
};

beforeEach(() => {
  vi.clearAllMocks();
  vi.mocked(paperApi.getPaper).mockResolvedValue(PAPER_FIXTURE as never);
});

function deterministicOnlyReport(): VisualReviewReportView {
  return {
    schemaVersion: 1,
    projectId: "p-review0001",
    runAt: "2026-10-07T00:00:00Z",
    round: 1,
    inputs: { texFiles: ["main.tex"], pdfSourceIds: [], generatedFigureIds: [] },
    artifacts: { total: 3, figures: 2, tables: 1, bySourceKind: { latex_env: 3 } },
    findings: [
      {
        findingId: "vf-001",
        category: "visual",
        severity: "major",
        message: "正文称 MOTA 76.3，但表 1 该行数值为 75.1（上下文绑定：同指标词 + 行标签）",
        claimText: "我们的方法取得 MOTA 76.3",
        status: "open",
        source: "deterministic-visual",
        figureEnvRef: "tex:main.tex:table-1",
        visualConfidence: "high",
        verificationStatus: "verified_deterministic",
        createdAt: "2026-10-07T00:00:00Z",
      },
      {
        findingId: "vf-002",
        category: "visual",
        severity: "minor",
        message: "\\ref{fig:missing} 指向不存在的 label",
        status: "open",
        source: "deterministic-visual",
        figureEnvRef: "tex:main.tex:figure-1",
        visualConfidence: "high",
        verificationStatus: "verified_deterministic",
        createdAt: "2026-10-07T00:00:00Z",
      },
    ],
    checks: [
      { checkId: "table-text-numeric", kind: "deterministic", status: "finding", findingIds: ["vf-001"] },
      { checkId: "label-ref-resolution", kind: "deterministic", status: "finding", findingIds: ["vf-002"] },
      { checkId: "figure-caption-consistency", kind: "vision", status: "skipped", detail: "vision 不可用" },
    ],
    capability: {
      visionAvailable: false,
      reason: "no_vision_model",
      detail: "当前部署模型未声明 image input 能力（确定性-only 模式）",
      skippedChecks: [
        "figure-caption-consistency",
        "figure-claim-consistency",
        "legend-axis-consistency",
        "diagram-method-consistency",
      ],
      skippedFigures: [],
      visionFiguresCompleted: 0,
      visionFiguresFailed: 0,
    },
    notes: ["vision 不可用——四项模型检查未运行（不宣称全部通过）"],
  };
}

describe("ReviewPanel 视觉检查区（M12.2 B5）", () => {
  it("尚未运行 → 明确空态（visual-not-run）+ 运行按钮可用", async () => {
    vi.mocked(visualsApi.getVisualReviewReport).mockResolvedValue(null as never);
    renderWithProviders(
      <ReviewPanel projectId="p-review0001" workflowKind="existing_paper_improvement" onOpenTab={() => {}} />,
    );
    expect(await screen.findByTestId("visual-not-run")).toBeTruthy();
    expect(screen.getByTestId("run-visual-review")).toBeTruthy();
  });

  it("deterministic-only 报告 → 确定性组渲染 findings；vision 组显示不可用原因；两组不混淆", async () => {
    vi.mocked(visualsApi.getVisualReviewReport).mockResolvedValue(deterministicOnlyReport());
    renderWithProviders(
      <ReviewPanel projectId="p-review0001" workflowKind="existing_paper_improvement" onOpenTab={() => {}} />,
    );
    expect(await screen.findByTestId("visual-review-report")).toBeTruthy();
    const deterministicGroup = screen.getByTestId("visual-deterministic-group");
    expect(deterministicGroup.textContent).toContain("确定性视觉检查");
    expect(screen.getAllByTestId("visual-finding-card").length).toBe(2);
    // 图表锚可追溯（finding 卡内渲染 VisualArtifactView id）
    const cards = screen.getAllByTestId("visual-finding-card");
    expect(cards.some((card) => card.textContent?.includes("tex:main.tex:table-1") ?? false)).toBe(true);
    // vision 不可用显式呈现（不得宣称全部检查通过）
    expect(screen.getByTestId("visual-vision-unavailable")).toBeTruthy();
    expect(screen.getByTestId("visual-vision-unavailable").textContent).toContain("no_vision_model");
  });

  it("点击运行 → 调用 runVisualReview API（真实操作链路）", async () => {
    vi.mocked(visualsApi.getVisualReviewReport).mockResolvedValue(null as never);
    vi.mocked(visualsApi.runVisualReview).mockResolvedValue(deterministicOnlyReport());
    renderWithProviders(
      <ReviewPanel projectId="p-review0001" workflowKind="existing_paper_improvement" onOpenTab={() => {}} />,
    );
    await userEvent.click(await screen.findByTestId("run-visual-review"));
    expect(await vi.waitFor(() => visualsApi.runVisualReview)).toHaveBeenCalledWith("p-review0001");
  });
});
