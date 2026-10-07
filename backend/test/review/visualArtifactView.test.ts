/**
 * M12 Batch 1 · B2 VisualArtifactView 投影测试（纯函数、无 IO、无 LLM）。
 *
 * 覆盖任务书 §9 列表：LaTeX figure、LaTeX table（tableGrid 有内容）、
 * PDF parsed figure（page/bbox/assetName）、PDF table（headers/rows）、
 * generated、caption missing（不伪造）、label missing、page/bbox missing、
 * deterministic ID stability（同输入两次投影 deep-equal + id 相等）、
 * analysis 附带与缺省；外加拷贝纪律（改 view 不影响权威源）。
 */

import { describe, expect, it } from "vitest";

import { emptyCounts, type ParsedBlock, type ParsedDocument } from "../../src/ingestion/types.js";
import { buildVisualInventory, type VisualInventoryTexFile } from "../../src/manuscript/visualInventory.js";
import {
  fromGeneratedFigure,
  fromParsedBlocks,
  fromVisualInventory,
  type GeneratedFigureLike,
} from "../../src/review/visualArtifactView.js";
import type { FigureAnalysis } from "../../src/vision/types.js";

// ---- LaTeX 夹具（与 B1 测试同构；确定性解析已在 B1 锁死）----

const FILES: VisualInventoryTexFile[] = [
  {
    file: "main.tex",
    content: [
      "\\section{Introduction}",
      "As shown in Figure~\\ref{fig:arch} and Table~\\ref{tab:mota}.",
      "Again \\ref{fig:arch}.",
      "\\begin{figure}[htbp]",
      "  \\includegraphics{figs/overview.pdf}",
      "  \\caption{系统总体架构。}",
      "  \\label{fig:arch}",
      "\\end{figure}",
      "\\begin{table}",
      "  \\caption{跟踪结果。}\\label{tab:mota}",
      "  \\begin{tabular}{lcc}",
      "    Method & MOTA & IDF1 \\\\",
      "    Ours & 82.4 & 79.1 \\\\",
      "  \\end{tabular}",
      "\\end{table}",
      "\\begin{figure}",
      "  \\includegraphics{figs/nocaption.pdf}",
      "\\end{figure}",
      "",
    ].join("\n"),
  },
  {
    file: "sections/experiments.tex",
    content: [
      "\\section{Experiments}",
      "Cross-file \\autoref{tab:mota}.",
      "",
    ].join("\n"),
  },
];

const inventory = buildVisualInventory(FILES);

// ---- PDF 夹具（内联 ParsedDocument，Docling 形状；不启动真实 Docling）----

function makeDoc(blocks: ParsedBlock[], overrides: Partial<ParsedDocument> = {}): ParsedDocument {
  return {
    schemaVersion: 1,
    sourceId: "S001",
    fileName: "paper.pdf",
    storedFileName: "S001-paper.pdf",
    kind: "pdf",
    mimeType: "application/pdf",
    parser: { id: "docling", version: "test" },
    parseMode: "structured",
    status: "ok",
    pageCount: 3,
    blocks,
    counts: emptyCounts(),
    notes: [],
    contentHash: "a".repeat(64),
    parsedAt: "2026-10-07T00:00:00.000Z",
    ...overrides,
  };
}

const PDF_BLOCKS: ParsedBlock[] = [
  {
    blockId: "B0004",
    type: "table",
    provenance: {
      fileName: "S001-paper.pdf",
      page: 2,
      section: "Experiments",
      bbox: { x0: 10, y0: 20, x1: 80, y1: 40 },
    },
    caption: "Table 1: MOT17 results",
    headers: ["Method", "MOTA", "IDF1"],
    rows: [
      ["Ours", "82.4", "79.1"],
      ["Baseline", "78.2", "75.0"],
    ],
    rowCount: 2,
    columnCount: 3,
  },
  {
    blockId: "B0005",
    type: "figure",
    provenance: {
      fileName: "S001-paper.pdf",
      page: 3,
      section: "Experiments",
      bbox: { x0: 5, y0: 5, x1: 50, y1: 50 },
    },
    caption: "Figure 1: Qualitative results",
    assetName: "fig-001.png",
  },
  {
    blockId: "B0006",
    type: "figure",
    provenance: { fileName: "S001-paper.pdf" }, // 无 page / bbox / section / caption / assetName
    visualOutputPresent: true,
  },
  {
    blockId: "B0007",
    type: "text",
    provenance: { fileName: "S001-paper.pdf", page: 1 },
    text: "正文块不进视觉投影",
    textKind: "paragraph",
  },
];

function analysisFor(blockId: string): FigureAnalysis {
  return {
    schemaVersion: 1,
    analysisId: "A0001",
    sourceId: "S001",
    figureBlockId: blockId,
    status: "completed",
    model: "openai/gpt-4o",
    provider: "openai",
    figureType: "chart",
    description: "A line chart.",
    observations: [],
    candidateFacts: [],
    warnings: [],
    confidence: "high",
    imageHash: "b".repeat(64),
    analyzedModelSpec: "openai/gpt-4o",
    outputSchemaVersion: 1,
    sourceContentHash: "a".repeat(64),
    analyzedAt: "2026-10-07T00:00:00.000Z",
    provenance: { fileName: "S001-paper.pdf", assetName: "fig-001.png" },
  };
}

describe("M12 B2 fromVisualInventory（latex_env）", () => {
  const views = fromVisualInventory(inventory);
  const byId = new Map(views.map((view) => [view.id, view]));

  it("LaTeX figure：label/caption/assetRef/linkedSection/referencedBy 反查", () => {
    const figure = byId.get("tex:main.tex:figure-1")!;
    expect(figure).toMatchObject({
      id: "tex:main.tex:figure-1",
      kind: "figure",
      sourceKind: "latex_env",
      label: "fig:arch",
      caption: "系统总体架构。",
      assetRef: "figs/overview.pdf",
      linkedSection: "Introduction",
    });
    // 多处引用（含跨文件）+ 同行重复计数展开为多个位置
    expect(figure.referencedBy).toEqual([
      { file: "main.tex", line: 2 },
      { file: "main.tex", line: 3 },
    ]);
    expect(figure.figureType).toBeUndefined(); // latex 侧缺省，不猜
    expect(figure.analysis).toBeUndefined();
  });

  it("LaTeX table：tableGrid 有内容（headers + rows）；无 tabular 表如实缺省", () => {
    const table = byId.get("tex:main.tex:table-1")!;
    expect(table).toMatchObject({
      id: "tex:main.tex:table-1",
      kind: "table",
      sourceKind: "latex_env",
      label: "tab:mota",
      caption: "跟踪结果。",
    });
    expect(table.tableGrid).toEqual({
      headers: ["Method", "MOTA", "IDF1"],
      rows: [["Ours", "82.4", "79.1"]],
    });
    // 跨文件引用反查
    expect(table.referencedBy).toEqual([
      { file: "main.tex", line: 2 },
      { file: "sections/experiments.tex", line: 2 },
    ]);
  });

  it("caption missing：caption undefined 不伪造 + extraction note；label missing → 无 label、referencedBy 空", () => {
    const noCaption = byId.get("tex:main.tex:figure-2")!;
    expect(noCaption.caption).toBeUndefined();
    expect(noCaption.extraction?.note).toContain("caption 缺失");
    expect(byId.get("tex:main.tex:figure-2")!.label).toBeUndefined();
    expect(noCaption.referencedBy).toEqual([]);
  });

  it("provenanceNote 指回权威源（.tex 文件与环境行号）", () => {
    expect(byId.get("tex:main.tex:figure-1")!.provenanceNote).toBe(
      "权威源：manuscript/main.tex（figure 环境，行 4-8）",
    );
  });
});

describe("M12 B2 fromParsedBlocks（pdf_parsed）", () => {
  it("PDF figure：page/bbox/assetRef/caption 为 parser fact 拷贝", () => {
    const views = fromParsedBlocks("S001", makeDoc(PDF_BLOCKS));
    const figure = views.find((view) => view.id === "pdf:S001:B0005")!;
    expect(figure).toMatchObject({
      id: "pdf:S001:B0005",
      kind: "figure",
      sourceKind: "pdf_parsed",
      caption: "Figure 1: Qualitative results",
      assetRef: "figures/S001/fig-001.png",
      page: 3,
      bbox: { x0: 5, y0: 5, x1: 50, y1: 50 },
      linkedSection: "Experiments",
    });
    expect(figure.referencedBy).toEqual([]); // pdf 侧缺省空数组
    expect(figure.provenanceNote).toContain("sources/parsed/S001.document.json");
    expect(figure.extraction).toBeUndefined(); // caption 与资产齐全 → 无提取说明
  });

  it("PDF table：headers/rows 网格拷贝", () => {
    const views = fromParsedBlocks("S001", makeDoc(PDF_BLOCKS));
    const table = views.find((view) => view.id === "pdf:S001:B0004")!;
    expect(table.kind).toBe("table");
    expect(table.tableGrid).toEqual({
      headers: ["Method", "MOTA", "IDF1"],
      rows: [
        ["Ours", "82.4", "79.1"],
        ["Baseline", "78.2", "75.0"],
      ],
    });
  });

  it("page/bbox missing → 字段缺省不伪造；caption missing → note；文本块不投影", () => {
    const views = fromParsedBlocks("S001", makeDoc(PDF_BLOCKS));
    expect(views).toHaveLength(3); // 2 figure + 1 table；text 块不进投影
    const bare = views.find((view) => view.id === "pdf:S001:B0006")!;
    expect("page" in bare).toBe(false);
    expect("bbox" in bare).toBe(false);
    expect(bare.caption).toBeUndefined();
    expect(bare.assetRef).toBeUndefined();
    expect(bare.extraction?.note).toContain("caption 缺失");
    expect(bare.extraction?.note).toContain("visualOutputPresent");
  });

  it("analysis：提供则透传（figureType 传播）；缺省不附带", () => {
    const withAnalysis = fromParsedBlocks("S001", makeDoc(PDF_BLOCKS), {
      analysisByBlockId: new Map([["B0005", analysisFor("B0005")]]),
    });
    const figure = withAnalysis.find((view) => view.id === "pdf:S001:B0005")!;
    expect(figure.analysis?.analysisId).toBe("A0001");
    expect(figure.figureType).toBe("chart");
    // 未提供分析的块不附带（freshness 判定是调用方职责，投影不猜）
    expect(withAnalysis.find((view) => view.id === "pdf:S001:B0006")!.analysis).toBeUndefined();
    const without = fromParsedBlocks("S001", makeDoc(PDF_BLOCKS));
    expect(without.find((view) => view.id === "pdf:S001:B0005")!.figureType).toBeUndefined();
  });

  it("拷贝纪律：改 view 不影响权威源（tableGrid / bbox 均为拷贝）", () => {
    const doc = makeDoc(PDF_BLOCKS);
    const views = fromParsedBlocks("S001", doc);
    const tableView = views[0]!;
    expect(tableView.kind).toBe("table");
    tableView.tableGrid!.headers[0] = "MUTATED";
    tableView.tableGrid!.rows[0]![0] = "MUTATED";
    expect(doc.blocks[0]).toMatchObject({
      type: "table",
      headers: ["Method", "MOTA", "IDF1"],
    });
    const figureView = fromParsedBlocks("S001", doc).find((view) => view.id === "pdf:S001:B0005")!;
    figureView.bbox!.x0 = 999;
    expect(
      (doc.blocks.find((block) => block.blockId === "B0005") as { provenance: { bbox?: { x0: number } } }).provenance.bbox?.x0,
    ).toBe(5);
  });
});

describe("M12 B2 fromGeneratedFigure（generated）", () => {
  const record: GeneratedFigureLike = {
    figId: "fig-abc123def456",
    kind: "plot",
    caption: "训练曲线。",
    label: "fig:training",
    assetRef: "figs/generated/fig-abc123def456.pdf",
    referencedBy: [{ file: "main.tex", line: 42 }],
    createdAt: "2026-10-07T08:00:00.000Z",
  };

  it("plot → figureType=chart；id/label/assetRef/referencedBy 投影", () => {
    const view = fromGeneratedFigure(record);
    expect(view).toMatchObject({
      id: "gen:fig-abc123def456",
      kind: "figure",
      sourceKind: "generated",
      figureType: "chart",
      caption: "训练曲线。",
      label: "fig:training",
      assetRef: "figs/generated/fig-abc123def456.pdf",
    });
    expect(view.referencedBy).toEqual([{ file: "main.tex", line: 42 }]);
    expect(view.provenanceNote).toContain("figure store manifest");
  });

  it("diagram → figureType=diagram；无 referencedBy → 空数组", () => {
    const view = fromGeneratedFigure({
      figId: "fig-diagram1",
      kind: "diagram",
      caption: "系统结构。",
      assetRef: "figs/generated/fig-diagram1.pdf",
      createdAt: "2026-10-07T08:00:00.000Z",
    });
    expect(view.figureType).toBe("diagram");
    expect(view.referencedBy).toEqual([]);
  });
});

describe("M12 B2 deterministic ID stability", () => {
  it("同输入两次投影 deep-equal 且 id 相等（三个 sourceKind）", () => {
    const doc = makeDoc(PDF_BLOCKS);
    const first = fromParsedBlocks("S001", doc, {
      analysisByBlockId: new Map([["B0005", analysisFor("B0005")]]),
    });
    const second = fromParsedBlocks("S001", doc, {
      analysisByBlockId: new Map([["B0005", analysisFor("B0005")]]),
    });
    expect(second).toEqual(first);
    expect(second.map((view) => view.id)).toEqual(first.map((view) => view.id));

    const texFirst = fromVisualInventory(inventory);
    const texSecond = fromVisualInventory(buildVisualInventory(FILES));
    expect(texSecond).toEqual(texFirst);
    expect(texSecond.map((view) => view.id)).toEqual(texFirst.map((view) => view.id));

    const genFirst = fromGeneratedFigure({
      figId: "fig-x",
      kind: "plot",
      caption: "c",
      assetRef: "a",
      createdAt: "t",
    });
    const genSecond = fromGeneratedFigure({
      figId: "fig-x",
      kind: "plot",
      caption: "c",
      assetRef: "a",
      createdAt: "t",
    });
    expect(genSecond).toEqual(genFirst);
    expect(genSecond.id).toBe(genFirst.id);
  });
});
