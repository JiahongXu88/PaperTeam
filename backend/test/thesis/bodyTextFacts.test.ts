/**
 * M14.1c：正文科研事实确定性抽取测试。
 *
 * 覆盖：
 *   - 中文 / 英文指标叙述（准确率、mAP、IoU、延迟…）→ numeric_result 事实；
 *   - 数据集规模（张 / images）→ dataset；方法参数（学习率 / batch size）→ parameter；
 *   - provenance：verbatim quote + blockId + page；quote 可被文本层核验通道复用；
 *   - 图内文本边界：bbox 与 figure 块相交 → key.condition=figure_embedded_text
 *     （不进入正文数值比较）；bbox 缺失不猜；
 *   - 像素内数值（无文本层痕迹）不产生记录（如实缺省）；
 *   - 幂等：同一文档重放 factId 一致；
 *   - 与既有表格抽取并存（extractFacts 聚合入口）。
 */

import { describe, expect, it } from "vitest";

import { extractBodyTextFacts, FIGURE_EMBEDDED_CONDITION } from "../../src/thesis/bodyTextFacts.js";
import type { ParsedBlock, ParsedDocument } from "../../src/ingestion/types.js";
import { cleanupThesisFixtures, newThesisFixture, textBlock, textLayerPage } from "./fixtures.js";

function researchInputOf(inputId = "ri-test000001") {
  return {
    schemaVersion: 1 as const,
    inputId,
    projectId: "p-test",
    inputType: "published_paper" as const,
    title: "测试输入",
    authors: [],
    identifiers: {},
    workId: inputId,
    version: { sourceId: "S001", contentHash: "hash-1", bytes: 100, importedAt: "2026-10-15T00:00:00Z" },
    parse: { status: "full_text" as const, notes: [] },
    scope: { status: "included" as const, updatedAt: "2026-10-15T00:00:00Z" },
    evidenceLinks: { evidenceIds: [] },
    createdAt: "2026-10-15T00:00:00Z",
    updatedAt: "2026-10-15T00:00:00Z",
  };
}

function documentOf(blocks: ParsedBlock[]): ParsedDocument {
  return {
    schemaVersion: 1,
    sourceId: "S001",
    fileName: "x.pdf",
    storedFileName: "S001-x.pdf",
    kind: "pdf",
    mimeType: "application/pdf",
    parser: { id: "test", version: "1" },
    parseMode: "structured",
    status: "ok",
    blocks,
    counts: { text: 0, table: 0, figure: 0, formula: 0, structured_record: 0, code: 0, output: 0 },
    notes: [],
    contentHash: "hash-1",
    parsedAt: "2026-10-15T00:00:00Z",
  };
}

describe("extractBodyTextFacts（确定性正文抽取）", () => {
  it("中文指标叙述：准确率 / mAP / IoU 数值成为事实，带 quote 与页码", () => {
    const doc = documentOf([
      textBlock("B0001", 5, "在 COCO 数据集上，我们的方法准确率为 84.3%，mAP@0.5 达到 56.7。基线的 IoU 为 0.71。"),
    ]);
    const result = extractBodyTextFacts(researchInputOf(), doc, "2026-10-15T00:00:00Z");
    const metrics = result.facts.map((f) => `${f.key.metric}=${f.value.raw}`);
    expect(metrics).toContain("accuracy=84.3%");
    expect(metrics).toContain("map=56.7");
    expect(metrics).toContain("iou=0.71");
    for (const fact of result.facts) {
      expect(fact.kind).toBe("numeric_result");
      expect(fact.extraction.method).toBe("deterministic_body_text");
      expect(fact.verification.status).toBe("extracted");
      expect(fact.provenance.blockId).toBe("B0001");
      expect(fact.provenance.page).toBe(5);
      expect(fact.provenance.quote!.length).toBeGreaterThan(0);
    }
    // 准确率事实的 quote 含指标词所在句
    const accuracy = result.facts.find((f) => f.key.metric === "accuracy")!;
    expect(accuracy.provenance.quote).toContain("准确率");
    // 数据集名称进入 key.dataset（可比性键组成部分；第二句无数据集名 → 缺省）
    expect(accuracy.key.dataset).toBe("coco");
    const iou = result.facts.find((f) => f.key.metric === "iou")!;
    expect(iou.key.dataset).toBeUndefined();
  });

  it("英文叙述：Recall / Precision / FPS 均命中", () => {
    const doc = documentOf([textBlock("B0002", 3, "Our method achieves Recall of 92.5% and Precision: 88.1 on KITTI dataset. The FPS is 45.")]);
    const result = extractBodyTextFacts(researchInputOf(), doc, "2026-10-15T00:00:00Z");
    const metrics = result.facts.map((f) => `${f.key.metric}=${f.value.raw}`);
    expect(metrics).toContain("recall=92.5%");
    expect(metrics).toContain("precision=88.1");
    expect(metrics).toContain("fps=45");
  });

  it("数据集规模与训练参数：dataset / parameter 类型正确", () => {
    const doc = documentOf([
      textBlock("B0003", 2, "训练集包含 118,287 张图像。我们使用学习率 0.001，batch size 为 32。"),
    ]);
    const result = extractBodyTextFacts(researchInputOf(), doc, "2026-10-15T00:00:00Z");
    const kinds = result.facts.map((f) => `${f.kind}:${f.surface}`);
    expect(kinds).toContain("dataset:118,287 张");
    expect(kinds).toContain("parameter:0.001");
    expect(kinds).toContain("parameter:32");
    const dataset = result.facts.find((f) => f.kind === "dataset")!;
    expect(dataset.key.parameter).toBe("dataset_size");
    const lr = result.facts.find((f) => f.key.parameter === "learning_rate")!;
    expect(lr.kind).toBe("parameter");
  });

  it("无指标语境的裸数字（年份 / 章节号）不成为事实", () => {
    const doc = documentOf([textBlock("B0004", 1, "该方法由 Zhang 等人在 2021 年提出，见第 3 章。房间号 409 是实验室。")]);
    const result = extractBodyTextFacts(researchInputOf(), doc, "2026-10-15T00:00:00Z");
    expect(result.facts).toHaveLength(0);
  });

  it("图内文本边界：文本块 bbox 落在 figure 块内 → condition=figure_embedded_text（不计入正文比较）", () => {
    const figureBlock: ParsedBlock = {
      blockId: "B0100",
      type: "figure",
      provenance: { fileName: "x.pdf", page: 7, bbox: { x0: 10, y0: 10, x1: 60, y1: 60 } },
    };
    const inFigure = {
      ...textBlock("B0101", 7, "图中标注：准确率为 71.2"),
      provenance: { fileName: "x.pdf", page: 7, bbox: { x0: 12, y0: 12, x1: 30, y1: 30 } },
    } as ParsedBlock;
    const outsideFigure = {
      ...textBlock("B0102", 7, "正文提到准确率为 71.2"),
      provenance: { fileName: "x.pdf", page: 7, bbox: { x0: 70, y0: 10, x1: 90, y1: 20 } },
    } as ParsedBlock;
    const doc = documentOf([figureBlock, inFigure, outsideFigure]);
    const result = extractBodyTextFacts(researchInputOf(), doc, "2026-10-15T00:00:00Z");
    expect(result.figureEmbeddedCount).toBe(1);
    const embedded = result.facts.find((f) => f.provenance.blockId === "B0101")!;
    expect(embedded.key.condition).toBe(FIGURE_EMBEDDED_CONDITION);
    const normal = result.facts.find((f) => f.provenance.blockId === "B0102")!;
    expect(normal.key.condition).toBeUndefined();
    // 两事实 key 不同（condition 参与 FactKey）→ 确定性对齐不会把它们当作同键比较
    expect(embedded.key).not.toEqual(normal.key);
  });

  it("bbox 缺失（parser 不提供坐标）：不标记图内（宁缺勿错，不猜）", () => {
    const figureBlock: ParsedBlock = { blockId: "B0200", type: "figure", provenance: { fileName: "x.pdf", page: 9 } };
    const text = textBlock("B0201", 9, "准确率为 65.0");
    const result = extractBodyTextFacts(researchInputOf(), documentOf([figureBlock, text]), "2026-10-15T00:00:00Z");
    expect(result.figureEmbeddedCount).toBe(0);
    expect(result.facts[0]!.key.condition).toBeUndefined();
  });

  it("像素内数值：无文本块痕迹 → 不产生任何记录（需要多模态，如实缺省）", () => {
    const figureBlock: ParsedBlock = { blockId: "B0300", type: "figure", provenance: { fileName: "x.pdf", page: 4 } };
    const result = extractBodyTextFacts(researchInputOf(), documentOf([figureBlock]), "2026-10-15T00:00:00Z");
    expect(result.facts).toHaveLength(0);
  });

  it("幂等：同一文档重放 factId 集合一致", () => {
    const doc = documentOf([textBlock("B0001", 5, "准确率为 84.3%，Recall 为 90.1%。")]);
    const a = extractBodyTextFacts(researchInputOf(), doc, "2026-10-15T00:00:00Z");
    const b = extractBodyTextFacts(researchInputOf(), doc, "2026-10-15T00:00:00Z");
    expect(a.facts.map((f) => f.factId).sort()).toEqual(b.facts.map((f) => f.factId).sort());
    expect(a.facts.map((f) => f.factId).sort()).toHaveLength(a.facts.length);
  });

  it("指标词后无可解析数值：不产生事实（计入 skippedCandidates，透明不猜）", () => {
    const doc = documentOf([textBlock("B0005", 6, "准确率为未知量，尚未测得。")]);
    const result = extractBodyTextFacts(researchInputOf(), doc, "2026-10-15T00:00:00Z");
    expect(result.facts).toHaveLength(0);
    expect(result.skippedCandidates).toBeGreaterThan(0);
  });
});

describe("extractFacts 聚合入口（表格 + 正文并存）", () => {
  it("extractFacts 同时产出表格单元格事实与正文事实；正文 quote 经文本层核验通道", async () => {
    const fx = await newThesisFixture();
    try {
      const { tableBlock } = await import("./fixtures.js");
      const a = await fx.importPdf(
        {
          fileName: "body.pdf",
          blocks: [
            tableBlock("B0001", 1, ["Method", "AP"], [["Ours", "82.4"]], "Table 1: Results"),
            textBlock("B0002", 2, "本文方法的准确率为 83.1。"),
          ],
          textLayer: [textLayerPage(1, "Ours 82.4"), textLayerPage(2, "本文方法的准确率为 83.1")],
        },
        "published_paper",
      );
      const extract = await fx.service.extractFacts(fx.projectId, a.inputId);
      expect(extract.bodyText.created).toBeGreaterThan(0);
      const bodyFacts = await fx.service.facts.list(fx.projectId, { researchInputId: a.inputId });
      expect(bodyFacts.some((f) => f.extraction.method === "deterministic_body_text" && f.surface === "83.1")).toBe(true);
      expect(bodyFacts.some((f) => f.kind === "table_cell")).toBe(true);
      // 来源核验（正文 quote 对文档全文）
      const verify = await fx.service.verifyFacts(fx.projectId, a.inputId);
      expect(verify.verified).toBeGreaterThan(0);
    } finally {
      await cleanupThesisFixtures();
    }
  });
});
