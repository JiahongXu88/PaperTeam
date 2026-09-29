/**
 * M10.1A 中间结构与持久化测试：ParsedDocumentStore 读写 / 损坏容忍 /
 * SourceStore.remove 连带清理（document.json + figures 资产）。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { newIngestionFixture, fakeStructuredExtraction, stubParser } from "./fixtures.js";
import { INGESTION_LIMITS, isDocumentFresh } from "../../src/ingestion/types.js";

describe("M10.1A ParsedDocument 中间结构", () => {
  it("防御上限常量就位（块 / 表格行 / cell / 文本 / 图 / notes）", () => {
    expect(INGESTION_LIMITS.maxBlocks).toBeGreaterThan(0);
    expect(INGESTION_LIMITS.maxTabularRows).toBeGreaterThan(0);
    expect(INGESTION_LIMITS.maxCellChars).toBeGreaterThan(0);
    expect(INGESTION_LIMITS.maxTableRows).toBeGreaterThan(0);
    expect(INGESTION_LIMITS.maxFigures).toBeGreaterThan(0);
  });

  it("freshness：contentHash 一致才 fresh（无 hash 老条目不可信）", async () => {
    const f = await newIngestionFixture({
      structuredParser: stubParser("docling", () => fakeStructuredExtraction()),
    });
    const source = await f.addFileSource("a.pdf", Buffer.from("%PDF-1.4 x"));
    const document = await f.ingestion.ingest(f.projectId, source.sourceId);
    expect(isDocumentFresh(document, source)).toBe(true);
    expect(isDocumentFresh(document, { ...source, contentHash: "different" })).toBe(false);
    expect(isDocumentFresh(document, { ...source, contentHash: undefined })).toBe(false);
  });

  it("ParsedDocumentStore：保存 → 读回逐字段一致；损坏文件 → null（不炸）", async () => {
    const f = await newIngestionFixture();
    const source = await f.addFileSource("a.csv", "a,b\n1,2\n");
    const document = await f.ingestion.ingest(f.projectId, source.sourceId);
    const reloaded = await f.documents.load(f.projectId, source.sourceId);
    expect(reloaded).toEqual(document);

    const parsedDir = join(f.projects.sourcesDir(f.projectId), "parsed");
    await writeFile(join(parsedDir, `${source.sourceId}.document.json`), "{corrupted", "utf8");
    expect(await f.documents.load(f.projectId, source.sourceId)).toBeNull();
  });

  it("SourceStore.remove 连带清理 document.json 与 figures 资产目录", async () => {
    const f = await newIngestionFixture({
      structuredParser: stubParser("docling", () => fakeStructuredExtraction()),
    });
    const source = await f.addFileSource("a.pdf", Buffer.from("%PDF-1.4 x"));
    await f.ingestion.ingest(f.projectId, source.sourceId);
    // figures 资产目录（docling 产物目标）
    const figuresDir = f.documents.figuresDir(f.projectId, source.sourceId);
    await mkdir(figuresDir, { recursive: true });
    await writeFile(join(figuresDir, "fig-001.png"), "png-bytes", "utf8");

    await f.sources.remove(f.projectId, source.sourceId);
    const parsedDir = join(f.projects.sourcesDir(f.projectId), "parsed");
    await expect(readFile(join(parsedDir, `${source.sourceId}.document.json`))).rejects.toMatchObject({
      code: "ENOENT",
    });
    await expect(readFile(join(figuresDir, "fig-001.png"))).rejects.toMatchObject({ code: "ENOENT" });
  });
});
