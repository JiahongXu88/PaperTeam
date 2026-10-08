import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { FiguresPanel } from "../src/components/project/FiguresPanel.js";
import { renderWithProviders } from "./helpers.js";
import type { DatasetCandidateView, FigureView } from "../src/api/figures.js";

/**
 * M12 Batch 3 C4 FiguresPanel：学术图表工作区。
 * - 空态（无数据集 / 无图表）与真实引导文案；
 * - 图表库行渲染（figId / 来源徽章 / 已插入徽章 / 打开 PDF 链接）；
 * - 插入表单：模式/章节选择 → 提交触发真实 insertFigure API；
 * - caption 守卫徽章（violation / unverified）。
 */

vi.mock("../src/api/projects.js", () => ({
  getProject: vi.fn(),
}));

vi.mock("../src/api/figures.js", () => ({
  listFigures: vi.fn(),
  listFigureDatasets: vi.fn(),
  listManuscriptSections: vi.fn(),
  getFigureDataset: vi.fn(),
  validateFigureSpec: vi.fn(),
  generateFigure: vi.fn(),
  insertFigure: vi.fn(),
  generatedFigurePdfUrl: vi.fn(
    (projectId: string, figId: string) => `/api/projects/${projectId}/figures/generated/${figId}.pdf`,
  ),
}));

const projectsApi = await import("../src/api/projects.js");
const figuresApi = await import("../src/api/figures.js");

beforeEach(() => {
  vi.clearAllMocks();
});

const newPaperProject = {
  id: "p-figures0001",
  title: "图表测试",
  workflowKind: "idea_to_paper",
};

const plotFigure: FigureView = {
  figId: "fig-abcdef123456",
  kind: "plot",
  plotType: "line",
  caption: "训练 loss 随 epoch 收敛（0.50 → 0.20）。",
  specHash: "a".repeat(64),
  datasetHash: "b".repeat(64),
  dataOriginClass: "source_parsed",
  sourceId: "S01",
  blockId: "B0001-B0003",
  createdAt: "2026-10-08T00:00:00Z",
  assetPresent: true,
  insertedIn: { file: "sections/results.tex", label: "fig:convergence", revision: 2 },
};

const diagramFigure: FigureView = {
  figId: "fig-112233445566",
  kind: "diagram",
  caption: "方法结构图。",
  specHash: "c".repeat(64),
  dataOriginClass: "diagram",
  createdAt: "2026-10-08T00:00:00Z",
  assetPresent: true,
};

function mockPanelData(options: { datasets?: DatasetCandidateView[]; figures?: FigureView[]; workflowKind?: string } = {}) {
  vi.mocked(projectsApi.getProject).mockResolvedValue({
    ...newPaperProject,
    ...(options.workflowKind !== undefined ? { workflowKind: options.workflowKind } : {}),
  } as never);
  vi.mocked(figuresApi.listFigures).mockResolvedValue(options.figures ?? []);
  vi.mocked(figuresApi.listFigureDatasets).mockResolvedValue(options.datasets ?? []);
  vi.mocked(figuresApi.listManuscriptSections).mockResolvedValue([
    { id: "results", title: "实验", file: "results.tex", exists: true },
    { id: "method", title: "方法", file: "method.tex", exists: false },
  ]);
}

describe("FiguresPanel", () => {
  it("无数据集 → 数据图空态引导 + 图表库空态", async () => {
    mockPanelData();
    renderWithProviders(<FiguresPanel projectId="p-figures0001" />);
    expect(await screen.findByTestId("plot-builder-empty")).toBeTruthy();
    expect(await screen.findByTestId("figure-library-empty")).toBeTruthy();
  });

  it("图表库渲染：figId / 来源徽章 / 已插入徽章 / 打开 PDF 链接（真实 URL）", async () => {
    mockPanelData({ figures: [plotFigure, diagramFigure] });
    renderWithProviders(<FiguresPanel projectId="p-figures0001" />);
    expect(await screen.findAllByTestId("figure-row")).toHaveLength(2);
    expect(screen.getByText("fig-abcdef123456")).toBeTruthy();
    expect(screen.getByText("来源数据")).toBeTruthy();
    expect(screen.getByText("TikZ 方法图")).toBeTruthy();
    const openLink = screen.getByTestId("figure-open-fig-abcdef123456") as HTMLAnchorElement;
    expect(openLink.getAttribute("href")).toBe("/api/projects/p-figures0001/figures/generated/fig-abcdef123456.pdf");
    expect(screen.getByTestId("figure-insert-toggle-fig-abcdef123456")).toBeTruthy();
    // 已插入的图仍可发起 replace
    expect((screen.getByTestId("figure-insert-toggle-fig-abcdef123456") as HTMLButtonElement).disabled).toBe(false);
  });

  it("数据集选择 → 加载载荷 → 生成触发真实 generateFigure", async () => {
    const dataset: DatasetCandidateView = {
      sourceId: "S01",
      blockId: "B0001-B0003",
      kind: "records",
      fileName: "experiment.csv",
      columns: ["epoch", "loss"],
      rowCount: 3,
      datasetHash: "d".repeat(64),
      sourceRole: "evidence",
    };
    mockPanelData({ datasets: [dataset] });
    vi.mocked(figuresApi.getFigureDataset).mockResolvedValue({
      ...dataset,
      inlineDataset: { columns: ["epoch", "loss"], rows: [[1, 0.5], [2, 0.3], [3, 0.2]] },
    });
    vi.mocked(figuresApi.generateFigure).mockResolvedValue({
      record: {
        figId: "fig-newfig111111",
        kind: "plot",
        caption: "c",
        specHash: "e".repeat(64),
        dataOriginClass: "source_parsed",
        createdAt: "2026-10-08T00:00:00Z",
        assetPresent: true,
        assets: { tex: "t", pdf: "p" },
        dataOrigin: { sourceId: "S01", blockId: "B0001-B0003" },
      },
      cached: false,
      captionValidation: { verdict: "pass", issues: [] },
    });

    renderWithProviders(<FiguresPanel projectId="p-figures0001" />);
    const select = await screen.findByTestId("plot-dataset-select");
    await userEvent.selectOptions(select, "S01::B0001-B0003");
    expect(await screen.findByTestId("plot-dataset-meta")).toBeTruthy();
    expect(figuresApi.getFigureDataset).toHaveBeenCalledWith("p-figures0001", "S01", "B0001-B0003");
    await userEvent.click(screen.getByTestId("plot-generate"));
    expect(await vi.waitFor(() => figuresApi.generateFigure)).toHaveBeenCalledTimes(1);
    const [, kind, spec] = vi.mocked(figuresApi.generateFigure).mock.calls[0]!;
    expect(kind).toBe("plot");
    expect((spec as { data: { origin: { sourceId: string; blockId: string }; datasetHash: string } }).data.origin).toEqual({
      sourceId: "S01",
      blockId: "B0001-B0003",
    });
  });

  it("插入表单：章节选择 → 提交触发 insertFigure（append + sectionId）", async () => {
    mockPanelData({ figures: [diagramFigure] });
    vi.mocked(figuresApi.insertFigure).mockResolvedValue({
      record: diagramFigure,
      file: "sections/results.tex",
      label: "fig:method-diagram",
      environment: "\\begin{figure}...\\end{figure}",
      graphicxInjected: true,
      authorConfirmedUnverified: false,
    });

    renderWithProviders(<FiguresPanel projectId="p-figures0001" />);
    await userEvent.click(await screen.findByTestId("figure-insert-toggle-fig-112233445566"));
    const sectionSelect = await screen.findByTestId("insert-section");
    await userEvent.selectOptions(sectionSelect, "results");
    const captionField = await screen.findByTestId("insert-caption");
    await userEvent.clear(captionField);
    await userEvent.type(captionField, "方法结构图（更新）。");
    await userEvent.click(screen.getByTestId("insert-submit"));
    expect(await vi.waitFor(() => figuresApi.insertFigure)).toHaveBeenCalledWith("p-figures0001", {
      figId: "fig-112233445566",
      mode: "append",
      sectionId: "results",
      caption: "方法结构图（更新）。",
    });
    expect(await screen.findByTestId("insert-success")).toBeTruthy();
  });

  it("已有论文项目：插入表单呈 replace 语义 + 边界提示", async () => {
    mockPanelData({ figures: [diagramFigure], workflowKind: "existing_paper_improvement" });
    renderWithProviders(<FiguresPanel projectId="p-figures0001" />);
    await userEvent.click(await screen.findByTestId("figure-insert-toggle-fig-112233445566"));
    const modeSelect = await screen.findByTestId("insert-mode");
    expect((modeSelect as HTMLSelectElement).value).toBe("replace");
    expect(await screen.findByTestId("insert-replace-label")).toBeTruthy();
    // replace 模式：目标文件输入
    expect(await screen.findByTestId("insert-file")).toBeTruthy();
  });
});
