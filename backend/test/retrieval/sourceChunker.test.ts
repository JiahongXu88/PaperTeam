/**
 * M6.4 SourceChunker 测试：文件 → chunks 的 IO 编排。
 * 覆盖：pymupdf 路径（fake parser：页码 + TOC 章节）/ builtin 文本层回退 /
 * text / markdown / skip 语义（metadata-only、bibtex、image、空文件、解析失败）/
 * 真实 PDF fixture 的确定性。
 */

import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { SourceChunker } from "../../src/retrieval/SourceChunker.js";
import type { SourceItem } from "../../src/sources/SourceStore.js";
import {
  FakePdfParser,
  fakeExtraction,
  minimalPdf,
  newRetrievalFixture,
} from "./fixtures.js";

function textItem(sourceId: string, fileName: string | undefined): SourceItem {
  return {
    sourceId,
    ...(fileName !== undefined ? { fileName: `${sourceId}-${fileName}` } : {}),
    sourceRole: "both",
    origin: "USER_ADDED",
    status: "available",
    preferred: false,
    metadata: {},
    bytes: 100,
    createdAt: "2026-09-17T00:00:00Z",
    updatedAt: "2026-09-17T00:00:00Z",
    ...(fileName !== undefined ? { sourceType: fileName.endsWith(".pdf") ? ("pdf" as const) : fileName.endsWith(".md") ? ("markdown" as const) : ("text" as const) } : { sourceType: "doi" as const }),
  };
}

describe("M6.4 SourceChunker：PDF 结构化路径（fake pymupdf）", () => {
  it("TOC 章节 + 页码 provenance 进入 chunk", async () => {
    const f = await newRetrievalFixture();
    const extraction = fakeExtraction({
      pageCount: 5,
      toc: [
        [1, "Introduction", 1],
        [1, "Method", 2],
        [1, "References", 4],
      ],
      blocks: [
        { page: 1, text: "Intro block about attention mechanisms." },
        { page: 2, text: "Method block about data association." },
        { page: 2, text: "More method detail on ByteTrack." },
        { page: 4, text: "[1] reference entry." },
      ],
    });
    const chunker = new SourceChunker({
      parser: new FakePdfParser({ "S001-paper.pdf": extraction }),
    });
    const { source } = await f.sources.add(f.projectId, {
      fileName: "paper.pdf",
      content: Buffer.from("%PDF-1.4 minimal"),
    });
    const path = await f.sources.filePath(f.projectId, source.sourceId);
    const result = await chunker.chunkSource(f.projectId, source, path);
    expect(result.outcome.status).toBe("indexed");
    expect(result.outcome.parser).toBe("pymupdf");
    expect(result.outcome.chunkCount).toBeGreaterThan(0);
    const methodChunk = result.chunks.find((chunk) => chunk.sectionTitle === "Method");
    expect(methodChunk).toBeDefined();
    expect(methodChunk!.pageStart).toBe(2);
  });

  it("pymupdf 单文件解析失败 → parse_failed（不回退 builtin，如实报告）", async () => {
    const f = await newRetrievalFixture();
    const chunker = new SourceChunker({
      parser: new FakePdfParser({}, { "S001-broken.pdf": "failed" }),
    });
    const { source } = await f.sources.add(f.projectId, {
      fileName: "broken.pdf",
      content: Buffer.from("%PDF-1.4 broken"),
    });
    const path = await f.sources.filePath(f.projectId, source.sourceId);
    const result = await chunker.chunkSource(f.projectId, source, path);
    expect(result.outcome.status).toBe("skipped");
    expect(result.outcome.reason).toBe("parse_failed");
    expect(result.outcome.note).not.toContain("%PDF"); // 全文不进 note
  });

  it("pymupdf 工具链不可用 → builtin 文本层回退（无页码、单节）", async () => {
    const f = await newRetrievalFixture();
    const chunker = new SourceChunker({
      parser: new FakePdfParser({}, { "S001-scan.pdf": "unavailable" }),
    });
    // minimalPdf 的文本层可被 builtin 提取（uncompressed Tj）
    const { source } = await f.sources.add(f.projectId, {
      fileName: "scan.pdf",
      content: minimalPdf(
      "Builtin fallback text about tracking evaluation and multi object association benchmarks. " +
        "This sentence exists to push the extracted text layer above the builtin minimum threshold. " +
        "Association cost design follows the two stage paradigm described in the method section.",
    ),
    });
    const path = await f.sources.filePath(f.projectId, source.sourceId);
    const result = await chunker.chunkSource(f.projectId, source, path);
    expect(result.outcome.status).toBe("indexed");
    expect(result.outcome.parser).toBe("builtin-pdf-text");
    expect(result.chunks[0]!.sectionTitle).toBe("Whole Document");
    expect(result.chunks[0]!.pageStart).toBeUndefined();
  });

  it("无 parser 注入 → 直接 builtin 路径；文本层过薄 → full_text_unavailable", async () => {
    const f = await newRetrievalFixture();
    const chunker = new SourceChunker();
    const { source } = await f.sources.add(f.projectId, {
      fileName: "thin.pdf",
      content: Buffer.from("%PDF-1.4\n%âãÏÓ\n1 0 obj\n<< /Type /Catalog >>\nendobj\ntrailer\n<< /Root 1 0 R >>\n%%EOF"),
    });
    const path = await f.sources.filePath(f.projectId, source.sourceId);
    const result = await chunker.chunkSource(f.projectId, source, path);
    expect(result.outcome.status).toBe("skipped");
    expect(result.outcome.reason).toBe("full_text_unavailable");
  });
});

describe("M6.4 SourceChunker：text / markdown", () => {
  it("markdown 标题 → 章节", async () => {
    const f = await newRetrievalFixture();
    await f.addTextSource(
      "notes.md",
      "# Introduction\n\nAbout MOT17 benchmarks.\n\n# Method\n\nWe use ByteTrack.\n\n## Ablation\n\nAblation details.",
    );
    const chunker = new SourceChunker();
    const items = await f.sources.list(f.projectId);
    const item = items[0]!;
    const path = await f.sources.filePath(f.projectId, item.sourceId);
    const result = await chunker.chunkSource(f.projectId, item, path);
    expect(result.outcome.status).toBe("indexed");
    expect(result.outcome.parser).toBe("markdown");
    const titles = result.chunks.map((chunk) => chunk.sectionTitle);
    expect(titles).toContain("Introduction");
    expect(titles).toContain("Method");
    expect(titles).toContain("Ablation");
  });

  it("plain text → Whole Document 单节；空文件 → empty_content", async () => {
    const f = await newRetrievalFixture();
    await f.addTextSource("a.txt", "Some plain text content about evaluation.");
    await f.addTextSource("empty.txt", "   \n  ");
    const chunker = new SourceChunker();
    const items = await f.sources.list(f.projectId);
    const first = await chunker.chunkSource(
      f.projectId,
      items[0]!,
      await f.sources.filePath(f.projectId, items[0]!.sourceId),
    );
    expect(first.outcome.status).toBe("indexed");
    expect(first.chunks[0]!.sectionTitle).toBe("Whole Document");
    const second = await chunker.chunkSource(
      f.projectId,
      items[1]!,
      await f.sources.filePath(f.projectId, items[1]!.sourceId),
    );
    expect(second.outcome.status).toBe("skipped");
    expect(second.outcome.reason).toBe("empty_content");
  });
});

describe("M6.4 SourceChunker：skip 语义（无全文绝不索引）", () => {
  it("metadata-only（无 fileName）→ full_text_unavailable", async () => {
    const chunker = new SourceChunker();
    const result = await chunker.chunkSource("p1", textItem("S001", undefined), "/nowhere");
    expect(result.outcome.status).toBe("skipped");
    expect(result.outcome.reason).toBe("full_text_unavailable");
    expect(result.chunks).toEqual([]);
  });

  it("bibtex / image → full_text_unavailable", async () => {
    const chunker = new SourceChunker();
    const bib = await chunker.chunkSource(
      "p1",
      { ...textItem("S001", "refs.bib"), sourceType: "bibtex" },
      "/nowhere/refs.bib",
    );
    expect(bib.outcome.reason).toBe("full_text_unavailable");
    const image = await chunker.chunkSource(
      "p1",
      { ...textItem("S002", "fig.png"), sourceType: "image" },
      "/nowhere/fig.png",
    );
    expect(image.outcome.reason).toBe("full_text_unavailable");
  });

  it("abstract 存在但无全文（doi 条目）→ 不索引（不把 abstract 当全文）", async () => {
    const chunker = new SourceChunker();
    const item: SourceItem = {
      ...textItem("S001", undefined),
      sourceType: "doi",
      metadata: { title: "Metadata only paper", abstract: "A long abstract that must never be indexed as full text.".repeat(5) },
    };
    const result = await chunker.chunkSource("p1", item, "/nowhere");
    expect(result.outcome.status).toBe("skipped");
    expect(result.outcome.reason).toBe("full_text_unavailable");
  });
});

describe("M6.4 SourceChunker：真实 PDF fixture（pymupdf，依赖本机 Python）", () => {
  it("attention.pdf → 页码 + 多章节 + 稳定重建", { timeout: 120_000 }, async () => {
    const { PyMuPdfParser } = await import("../../src/paper/PdfParser.js");
    const f = await newRetrievalFixture({ parser: new PyMuPdfParser() });
    const fixturePath = join(import.meta.dirname, "..", "fixtures", "pdf", "attention.pdf");
    const { readFile } = await import("node:fs/promises");
    const { source } = await f.sources.add(f.projectId, {
      fileName: "attention.pdf",
      content: await readFile(fixturePath),
    });
    const path = await f.sources.filePath(f.projectId, source.sourceId);
    const chunker = new SourceChunker({ parser: new PyMuPdfParser() });
    const first = await chunker.chunkSource(f.projectId, source, path);
    expect(first.outcome.status).toBe("indexed");
    expect(first.outcome.chunkCount).toBeGreaterThan(10);
    // 页码真实存在（TOC 路径）
    expect(first.chunks.some((chunk) => chunk.pageStart !== undefined)).toBe(true);
    // 确定性：重跑 chunkId 一致
    const second = await chunker.chunkSource(f.projectId, source, path);
    expect(second.chunks.map((chunk) => chunk.chunkId)).toEqual(first.chunks.map((chunk) => chunk.chunkId));
  });
});
