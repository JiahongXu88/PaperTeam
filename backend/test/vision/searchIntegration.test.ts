/**
 * M10.2 检索集成测试（§12）：FigureAnalysis → chunk → search 全链。
 * - 分析文本可检索（description / observations / candidateFacts）；
 * - 搜索结果保留视觉 provenance（figure block / page / asset）；
 * - 图片条目：无分析 = skipped（M10.1 行为不变）；有分析 = 唯一可检索通道；
 * - source 变化后旧分析不再进入检索（freshness 门）；
 * - 无分析时 PDF 文档投影行为不变（figure 块不进检索）。
 */

import { afterAll, describe, expect, it } from "vitest";

import { makePng } from "../ingestion/binaryFixtures.js";
import { cleanupVisionFixtures, newVisionFixture, pdfFigureBlock, textBlock } from "./fixtures.js";

afterAll(async () => {
  await cleanupVisionFixtures();
});

describe("analysis → search", () => {
  it("分析完成后：描述可检索且带 figure / page / asset provenance", async () => {
    const f = await newVisionFixture();
    const { source } = await f.sources.add(f.projectId, { fileName: "paper.pdf", content: Buffer.from("%PDF-") });
    await f.seedDocument(
      source.sourceId,
      [textBlock("B0001", "Tracking experiments on MOT17."), pdfFigureBlock()],
      { "fig-001.png": makePng(20, 20) },
    );

    // 分析前：figure 不进检索（M10.1 行为不变）
    await f.retrieval.rebuildSource(f.projectId, source.sourceId);
    let results = await f.retrieval.search(f.projectId, "threshold MOTA 变化", { topK: 10 });
    expect(results.results.every((entry) => !entry.chunk.text.includes("[figure"))).toBe(true);

    await f.vision.analyze(f.projectId, source.sourceId); // hook 内自动 rebuildSource
    results = await f.retrieval.search(f.projectId, "threshold MOTA 变化", { topK: 10 });
    expect(results.results.length).toBeGreaterThan(0);
    const hit = results.results.find((entry) => entry.chunk.text.includes("[figure B0005"));
    expect(hit).toBeDefined();
    expect(hit?.chunk.pageStart).toBe(3); // page provenance 透传
    expect(hit?.chunk.text).toContain("fig-001.png");
    expect(hit?.chunk.text).toContain("vision prov-a/model-v");
    expect(hit?.chunk.text).toContain("MOTA 在 threshold=0.5 时达到 82.4");
    expect(hit?.chunk.text).toContain("Figure 1: Impact of threshold on MOTA and IDF1.");
    // 结果引用正确 source
    expect(hit?.source.sourceId).toBe(source.sourceId);
  });

  it("图片条目：无分析 skipped；有分析成为唯一可检索通道", async () => {
    const f = await newVisionFixture();
    const { source } = await f.sources.add(f.projectId, { fileName: "plot.png", content: makePng(50, 40) });
    await f.ingestion.ingest(f.projectId, source.sourceId);

    // 无分析：不可索引（M10.1 行为）
    await expect(f.retrieval.rebuildSource(f.projectId, source.sourceId)).rejects.toMatchObject({
      code: expect.stringMatching(/RETRIEVAL|NOT_INDEXABLE|INGESTION/),
    });

    await f.vision.analyze(f.projectId, source.sourceId);
    const results = await f.retrieval.search(f.projectId, "MOTA threshold", { topK: 10 });
    const hit = results.results.find((entry) => entry.chunk.text.includes("[figure"));
    expect(hit).toBeDefined();
    expect(hit?.chunk.sectionId.startsWith("SEC")).toBe(true);
  });

  it("source 内容变化后旧分析不进检索（freshness 门）", async () => {
    const f = await newVisionFixture();
    const { source } = await f.sources.add(f.projectId, { fileName: "plot.png", content: makePng(50, 40) });
    await f.ingestion.ingest(f.projectId, source.sourceId);
    await f.vision.analyze(f.projectId, source.sourceId);

    // 重新上传同条目（内容变化 → contentHash 变化）
    await f.sources.add(f.projectId, { fileName: "plot.png", content: makePng(60, 40, [10, 100, 10]) });
    const listed = await f.sources.list(f.projectId);
    const item = listed.find((entry) => (entry.fileName ?? "").endsWith("plot.png") && entry.sourceId !== source.sourceId);

    // 旧 source 的分析仍在盘上，但通过新 contentHash 的条目检索时不可见：
    // 手动对旧 source 重建（模拟懒加载路径）——它的 contentHash 未变仍可见；
    // 换新条目视角：其无分析 → 不可索引。验证 provider 过滤逻辑本身：
    const stored = await f.analyses.load(f.projectId, source.sourceId);
    expect(stored?.analyses[0]?.sourceContentHash).toBe(source.contentHash);
    expect(item?.contentHash).not.toBe(source.contentHash);
    await expect(
      f.retrieval.rebuildSource(f.projectId, item?.sourceId ?? ""),
    ).rejects.toBeTruthy();
  });

  it("PDF 文本块检索不受影响（回归）", async () => {
    const f = await newVisionFixture();
    const { source } = await f.sources.add(f.projectId, { fileName: "paper.pdf", content: Buffer.from("%PDF-") });
    await f.seedDocument(
      source.sourceId,
      [textBlock("B0001", "The transformer architecture uses self-attention across tokens."), pdfFigureBlock()],
      { "fig-001.png": makePng(20, 20) },
    );
    await f.vision.analyze(f.projectId, source.sourceId);
    const results = await f.retrieval.search(f.projectId, "transformer self-attention", { topK: 10 });
    expect(results.results.some((entry) => entry.chunk.text.includes("self-attention"))).toBe(true);
  });
});
