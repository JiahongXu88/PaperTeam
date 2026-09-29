/**
 * M10.2 VisionAnalysisService 编排测试：
 * - 三链路同型（PDF figure / 上传图片 / Notebook 图片输出——§14/§15）；
 * - capability unavailable → 全部 skipped（§7/§16）；
 * - caption / context 注入分析输入（§8）；
 * - 落盘持久化（§4）与 freshness 缓存（§18）；
 * - 图片变化失效、换模型失效、force 重跑；
 * - ParsedDocument 不被 Vision 结果污染（§3/§4）。
 */

import { join } from "node:path";
import { readFile, writeFile } from "node:fs/promises";
import { afterAll, describe, expect, it } from "vitest";

import { makePng } from "../ingestion/binaryFixtures.js";
import {
  cleanupVisionFixtures,
  newVisionFixture,
  notebookFigureBlock,
  pdfFigureBlock,
  textBlock,
  validVisionOutput,
} from "./fixtures.js";

afterAll(async () => {
  await cleanupVisionFixtures();
});

describe("三条链路（PDF / 上传图片 / Notebook 图片输出）", () => {
  it("PDF figure：caption + 前后文本 context 进入分析输入；provenance 拷贝", async () => {
    const f = await newVisionFixture();
    const { source } = await f.sources.add(f.projectId, {
      fileName: "paper.pdf",
      content: Buffer.from("%PDF- fake"),
    });
    const png = makePng(30, 20);
    await f.seedDocument(source.sourceId, [
      textBlock("B0001", "We further evaluate the sensitivity of threshold on MOT17."),
      pdfFigureBlock(),
      textBlock("B0006", "The curve peaks at the middle of the range."),
    ], { "fig-001.png": png });

    const result = await f.vision.analyze(f.projectId, source.sourceId);
    expect(result.actions).toEqual([{ figureBlockId: "B0005", action: "analyzed" }]);
    expect(result.status.counts).toMatchObject({ total: 1, completed: 1 });

    const call = f.model.calls[0]!;
    expect(call.image?.mimeType).toBe("image/png");
    expect(call.image?.data).toBe(png.toString("base64"));
    expect(call.promptText).toContain("Figure 1: Impact of threshold on MOTA and IDF1.");
    expect(call.promptText).toContain("sensitivity of threshold");
    expect(call.promptText).toContain("curve peaks at the middle");
    expect(call.promptText).toContain("- 定位：page 3");

    const stored = await f.analyses.load(f.projectId, source.sourceId);
    expect(stored?.analyses).toHaveLength(1);
    expect(stored?.analyses[0]).toMatchObject({
      analysisId: "VA-B0005",
      figureBlockId: "B0005",
      status: "completed",
      sourceContentHash: source.contentHash,
    });
  });

  it("上传图片：ImageAssetParser 产物（img-001.png）同链分析", async () => {
    const f = await newVisionFixture();
    const { source } = await f.sources.add(f.projectId, {
      fileName: "plot.png",
      content: makePng(64, 48),
    });
    // 真实 ImageAssetParser 登记（宽高读自上传图片头部：64x48）
    await f.ingestion.ingest(f.projectId, source.sourceId);
    const result = await f.vision.analyze(f.projectId, source.sourceId);
    expect(result.status.counts).toMatchObject({ total: 1, completed: 1 });
    const stored = await f.analyses.load(f.projectId, source.sourceId);
    expect(stored?.analyses[0]?.provenance.assetName).toBe("img-001.png");
    expect(stored?.analyses[0]?.provenance.width).toBe(64);
  });

  it("Notebook 图片输出：cellIndex/outputIndex provenance 拷贝", async () => {
    const f = await newVisionFixture();
    const { source } = await f.sources.add(f.projectId, {
      fileName: "analysis.ipynb",
      content: Buffer.from("{}"),
    });
    await f.seedDocument(source.sourceId, [notebookFigureBlock()], {
      "cell-2-output-0.png": makePng(80, 60),
    });
    const result = await f.vision.analyze(f.projectId, source.sourceId);
    expect(result.status.counts).toMatchObject({ total: 1, completed: 1 });
    const call = f.model.calls[0]!;
    expect(call.promptText).toContain("- 定位：Cell 2 · output 0");
    const stored = await f.analyses.load(f.projectId, source.sourceId);
    expect(stored?.analyses[0]?.provenance).toMatchObject({ cellIndex: 2, outputIndex: 0, cellId: "cell-2" });
  });
});

describe("capability unavailable（§7/§16）", () => {
  it("未配置任何模型 → 全部 figure skipped(model_unavailable)，零模型调用", async () => {
    const f = await newVisionFixture({ modelCandidates: () => ({}) });
    const { source } = await f.sources.add(f.projectId, { fileName: "paper.pdf", content: Buffer.from("%PDF-") });
    await f.seedDocument(source.sourceId, [pdfFigureBlock()], { "fig-001.png": makePng(10, 10) });

    const result = await f.vision.analyze(f.projectId, source.sourceId);
    expect(result.actions).toEqual([{ figureBlockId: "B0005", action: "skipped" }]);
    expect(result.status.counts).toMatchObject({ skipped: 1 });
    expect(result.status.model.available).toBe(false);
    expect(f.model.calls).toHaveLength(0);
    const stored = await f.analyses.load(f.projectId, source.sourceId);
    expect(stored?.analyses[0]).toMatchObject({ status: "skipped", skipReason: "model_unavailable" });
  });

  it("默认模型 text-only 且无 visionModel → skipped（glm-5.3 同型场景）", async () => {
    const f = await newVisionFixture({
      modelCandidates: () => ({ defaultModel: "prov-a/text-only" }),
    });
    f.model.catalogInputs.set("prov-a/text-only", ["text"]);
    const { source } = await f.sources.add(f.projectId, { fileName: "paper.pdf", content: Buffer.from("%PDF-") });
    await f.seedDocument(source.sourceId, [pdfFigureBlock()], { "fig-001.png": makePng(10, 10) });
    const result = await f.vision.analyze(f.projectId, source.sourceId);
    expect(result.status.counts).toMatchObject({ skipped: 1 });
    expect(f.model.calls).toHaveLength(0);
  });

  it("无解析产物 → 400（提示先 ingest）", async () => {
    const f = await newVisionFixture();
    const { source } = await f.sources.add(f.projectId, { fileName: "paper.pdf", content: Buffer.from("%PDF-") });
    await expect(f.vision.analyze(f.projectId, source.sourceId)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });
});

describe("freshness / 缓存（§18）", () => {
  it("重复 analyze：图片 / 模型 / schema 未变 → 复用（零新调用）", async () => {
    const f = await newVisionFixture();
    const { source } = await f.sources.add(f.projectId, { fileName: "paper.pdf", content: Buffer.from("%PDF-") });
    await f.seedDocument(source.sourceId, [pdfFigureBlock()], { "fig-001.png": makePng(10, 10) });
    await f.vision.analyze(f.projectId, source.sourceId);
    expect(f.model.calls).toHaveLength(1);

    const second = await f.vision.analyze(f.projectId, source.sourceId);
    expect(second.actions).toEqual([{ figureBlockId: "B0005", action: "reused" }]);
    expect(f.model.calls).toHaveLength(1); // 没有再次调用
  });

  it("图片字节变化 → 旧分析失效重跑", async () => {
    const f = await newVisionFixture();
    const { source } = await f.sources.add(f.projectId, { fileName: "paper.pdf", content: Buffer.from("%PDF-") });
    await f.seedDocument(source.sourceId, [pdfFigureBlock()], { "fig-001.png": makePng(10, 10) });
    await f.vision.analyze(f.projectId, source.sourceId);

    await writeFile(
      join(f.documents.figuresDir(f.projectId, source.sourceId), "fig-001.png"),
      makePng(12, 12, [30, 30, 200]),
    );
    const second = await f.vision.analyze(f.projectId, source.sourceId);
    expect(second.actions).toEqual([{ figureBlockId: "B0005", action: "analyzed" }]);
    expect(f.model.calls).toHaveLength(2);
  });

  it("换模型 → 旧分析失效重跑（换模型不污染 ParsedDocument）", async () => {
    let candidates: { visionModel?: string } = { visionModel: "prov-a/model-v" };
    const f = await newVisionFixture({ modelCandidates: () => candidates });
    const { source } = await f.sources.add(f.projectId, { fileName: "paper.pdf", content: Buffer.from("%PDF-") });
    await f.seedDocument(source.sourceId, [pdfFigureBlock()], { "fig-001.png": makePng(10, 10) });
    await f.vision.analyze(f.projectId, source.sourceId);
    const before = await readFile(
      join(f.projects.sourcesDir(f.projectId), "parsed", `${source.sourceId}.document.json`),
      "utf8",
    );

    candidates = { visionModel: "prov-b/model-v2" };
    const second = await f.vision.analyze(f.projectId, source.sourceId);
    expect(second.actions).toEqual([{ figureBlockId: "B0005", action: "analyzed" }]);
    expect(f.model.calls).toHaveLength(2);
    const stored = await f.analyses.load(f.projectId, source.sourceId);
    expect(stored?.analyses[0]?.model).toBe("prov-b/model-v2");

    // ParsedDocument 原样（Parser Fact 层零污染）
    const after = await readFile(
      join(f.projects.sourcesDir(f.projectId), "parsed", `${source.sourceId}.document.json`),
      "utf8",
    );
    expect(after).toBe(before);
  });

  it("force=true 忽略缓存强制重跑", async () => {
    const f = await newVisionFixture();
    const { source } = await f.sources.add(f.projectId, { fileName: "paper.pdf", content: Buffer.from("%PDF-") });
    await f.seedDocument(source.sourceId, [pdfFigureBlock()], { "fig-001.png": makePng(10, 10) });
    await f.vision.analyze(f.projectId, source.sourceId);
    const second = await f.vision.analyze(f.projectId, source.sourceId, { force: true });
    expect(second.actions).toEqual([{ figureBlockId: "B0005", action: "analyzed" }]);
    expect(f.model.calls).toHaveLength(2);
  });
});

describe("失败图的收敛（§16/§32：失败不伪装成功）", () => {
  it("单图失败不影响其余图；失败状态如实落盘", async () => {
    const f = await newVisionFixture({
      modelScript: (call) =>
        call.promptText.includes("fig-002") ? { kind: "raw", text: "不是 JSON" } : { kind: "json", output: validVisionOutput() },
    });
    const { source } = await f.sources.add(f.projectId, { fileName: "paper.pdf", content: Buffer.from("%PDF-") });
    await f.seedDocument(
      source.sourceId,
      [pdfFigureBlock(), pdfFigureBlock({ blockId: "B0009", assetName: "fig-002.png", provenance: { fileName: "paper.pdf", page: 4 } })],
      { "fig-001.png": makePng(10, 10), "fig-002.png": makePng(10, 10) },
    );
    const result = await f.vision.analyze(f.projectId, source.sourceId);
    expect(result.status.counts).toMatchObject({ total: 2, completed: 1, failed: 1 });
    const stored = await f.analyses.load(f.projectId, source.sourceId);
    const failed = stored?.analyses.find((entry) => entry.figureBlockId === "B0009");
    expect(failed).toMatchObject({ status: "failed" });
    expect(failed?.error?.code).toBe("INVALID_MODEL_OUTPUT");
  });
});
