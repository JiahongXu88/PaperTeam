/**
 * M10.1 chunker 消费结构化解析产物测试：
 * - PDF structured 文档（docling 投影）：sections + 页码 provenance + 表格文本进 chunk
 * - CSV structured 文档：行级 [row N] 标记 chunk（tabular kind）
 * - text_only 降级产物 → 不消费，回落既有路径（pymupdf / 纯文本）
 * - xlsx 无产物 → full_text_unavailable（先触发 ingest）
 * - 不注入 documentProvider（老装配）→ 全部行为不变（回归保护）
 */

import { describe, expect, it } from "vitest";

import { SourceChunker } from "../../src/retrieval/SourceChunker.js";
import type { SourceItem } from "../../src/sources/SourceStore.js";
import type { ParsedDocument } from "../../src/ingestion/types.js";
import {
  newRetrievalFixture,
  FakePdfParser,
  fakeExtraction,
  type RetrievalFixture,
} from "../retrieval/fixtures.js";
import { fakeStructuredExtraction } from "./fixtures.js";

function docFrom(extraction: ReturnType<typeof fakeStructuredExtraction>, sourceId: string): ParsedDocument {
  return {
    schemaVersion: 1,
    sourceId,
    fileName: `${sourceId}-paper.pdf`,
    storedFileName: `${sourceId}-paper.pdf`,
    kind: "pdf",
    mimeType: "application/pdf",
    parser: extraction.parser,
    parseMode: extraction.mode,
    status: "ok",
    ...(extraction.pageCount !== undefined ? { pageCount: extraction.pageCount } : {}),
    blocks: extraction.blocks,
    counts: { text: 3, table: 1, figure: 1, formula: 1, structured_record: 0 },
    notes: [],
    contentHash: "hash-does-not-matter-provider-decides",
    parsedAt: "2026-09-29T00:00:00Z",
  };
}

async function addPdf(f: RetrievalFixture): Promise<{ source: SourceItem; path: string }> {
  const { source } = await f.sources.add(f.projectId, {
    fileName: "paper.pdf",
    content: Buffer.from("%PDF-1.4 minimal"),
  });
  return { source, path: await f.sources.filePath(f.projectId, source.sourceId) };
}

describe("M10.1 SourceChunker × 结构化解析产物", () => {
  it("structured PDF 文档优先：section / 页码 / 表格文本进 chunk（kind=docling）", async () => {
    const f = await newRetrievalFixture();
    const extraction = fakeStructuredExtraction();
    const document = docFrom(extraction, "S001");
    const chunker = new SourceChunker({
      documentProvider: async (_projectId, item) => (item.sourceId === "S001" ? document : null),
    });
    const { source, path } = await addPdf(f);
    const result = await chunker.chunkSource(f.projectId, source, path);
    expect(result.outcome.status).toBe("indexed");
    expect(result.outcome.parser).toBe("docling");
    // Introduction 节的 chunk 带页码
    const intro = result.chunks.find((chunk) => chunk.sectionTitle === "Introduction");
    expect(intro).toBeDefined();
    expect(intro!.pageStart).toBe(1);
    // 表格文本可检索（行列投影）
    const tableChunk = result.chunks.find((chunk) => chunk.text.includes("Ours | 82.4"));
    expect(tableChunk).toBeDefined();
    expect(tableChunk!.text).toContain("MOTA");
  });

  it("text_only 降级产物不消费 → 回落 pymupdf 路径（回归保护）", async () => {
    const f = await newRetrievalFixture();
    const extraction = fakeStructuredExtraction();
    const degraded = docFrom({ ...extraction, mode: "text_only", parser: { id: "pymupdf" } }, "S001");
    const pdfExtraction = fakeExtraction({
      pageCount: 2,
      toc: [[1, "Method", 1]],
      blocks: [{ page: 1, text: "pymupdf fallback block about tracking. " + "detail ".repeat(30) }],
    });
    const chunker = new SourceChunker({
      documentProvider: async () => degraded,
      parser: new FakePdfParser({ "S001-paper.pdf": pdfExtraction }),
    });
    const { source, path } = await addPdf(f);
    const result = await chunker.chunkSource(f.projectId, source, path);
    expect(result.outcome.status).toBe("indexed");
    expect(result.outcome.parser).toBe("pymupdf");
  });

  it("failed 文档不消费（回落既有路径）", async () => {
    const f = await newRetrievalFixture();
    const extraction = fakeStructuredExtraction();
    const failed = { ...docFrom(extraction, "S001"), status: "failed" as const };
    const pdfExtraction = fakeExtraction({
      pageCount: 1,
      toc: [],
      blocks: [{ page: 1, text: "fallback content ".repeat(20) }],
    });
    const chunker = new SourceChunker({
      documentProvider: async () => failed,
      parser: new FakePdfParser({ "S001-paper.pdf": pdfExtraction }),
    });
    const { source, path } = await addPdf(f);
    const result = await chunker.chunkSource(f.projectId, source, path);
    expect(result.outcome.parser).toBe("pymupdf");
  });

  it("CSV structured 文档：行级记录 chunk（[row N] 标记 + 表头=值）", async () => {
    const f = await newRetrievalFixture();
    const csvDocument: ParsedDocument = {
      schemaVersion: 1,
      sourceId: "S001",
      fileName: "S001-experiment.csv",
      storedFileName: "S001-experiment.csv",
      kind: "tabular",
      mimeType: "text/csv",
      parser: { id: "csv" },
      parseMode: "structured",
      status: "ok",
      sheets: [{ name: "csv", rowCount: 2, columnCount: 3, headers: ["Method", "MOTA", "IDF1"] }],
      blocks: [
        {
          blockId: "B0001",
          type: "structured_record",
          provenance: { fileName: "S001-experiment.csv", row: 2 },
          cells: [
            { letter: "A", header: "Method", value: "Ours" },
            { letter: "B", header: "MOTA", value: "82.4" },
            { letter: "C", header: "IDF1", value: "79.1" },
          ],
        },
        {
          blockId: "B0002",
          type: "structured_record",
          provenance: { fileName: "S001-experiment.csv", row: 3 },
          cells: [
            { letter: "A", header: "Method", value: "Baseline" },
            { letter: "B", header: "MOTA", value: "78.2" },
          ],
        },
      ],
      counts: { text: 0, table: 0, figure: 0, formula: 0, structured_record: 2 },
      notes: [],
      contentHash: "hash",
      parsedAt: "2026-09-29T00:00:00Z",
    };
    const chunker = new SourceChunker({
      documentProvider: async (_projectId, item) => (item.sourceId === "S001" ? csvDocument : null),
    });
    const { source } = await f.sources.add(f.projectId, {
      fileName: "experiment.csv",
      content: Buffer.from("Method,MOTA,IDF1\nOurs,82.4,79.1\n", "utf8"),
    });
    const path = await f.sources.filePath(f.projectId, source.sourceId);
    const result = await chunker.chunkSource(f.projectId, source, path);
    expect(result.outcome.status).toBe("indexed");
    expect(result.outcome.parser).toBe("tabular");
    const joined = result.chunks.map((chunk) => chunk.text).join("\n");
    expect(joined).toContain("[row 2]");
    expect(joined).toContain("MOTA=82.4");
    expect(joined).toContain("IDF1=79.1");
  });

  it("无结构化产物时 CSV 走既有纯文本路径（回归保护）", async () => {
    const f = await newRetrievalFixture();
    const chunker = new SourceChunker({});
    const { source } = await f.sources.add(f.projectId, {
      fileName: "experiment.csv",
      content: Buffer.from("Method,MOTA\nOurs,82.4\n", "utf8"),
    });
    const path = await f.sources.filePath(f.projectId, source.sourceId);
    const result = await chunker.chunkSource(f.projectId, source, path);
    expect(result.outcome.status).toBe("indexed");
    expect(result.outcome.parser).toBe("text");
  });

  it("xlsx 无产物 → full_text_unavailable（指向 ingest 通道）", async () => {
    const f = await newRetrievalFixture();
    const chunker = new SourceChunker({});
    const { source } = await f.sources.add(f.projectId, {
      fileName: "experiment.xlsx",
      content: Buffer.from("binary xlsx bytes"),
    });
    const path = await f.sources.filePath(f.projectId, source.sourceId);
    const result = await chunker.chunkSource(f.projectId, source, path);
    expect(result.outcome.status).toBe("skipped");
    expect(result.outcome.reason).toBe("full_text_unavailable");
    expect(result.outcome.note).toContain("XLSX");
  });

  it("xlsx 有产物 → tabular chunk（sheet 名作 sectionTitle）", async () => {
    const f = await newRetrievalFixture();
    const xlsxDocument: ParsedDocument = {
      schemaVersion: 1,
      sourceId: "S001",
      fileName: "S001-experiment.xlsx",
      storedFileName: "S001-experiment.xlsx",
      kind: "tabular",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      parser: { id: "xlsx-exceljs" },
      parseMode: "structured",
      status: "ok",
      sheets: [{ name: "Sheet1", rowCount: 1, columnCount: 2, headers: ["Variant", "MOTA"] }],
      blocks: [
        {
          blockId: "B0001",
          type: "structured_record",
          provenance: { fileName: "S001-experiment.xlsx", sheet: "Sheet1", row: 2 },
          cells: [
            { letter: "A", header: "Variant", value: "full" },
            { letter: "B", header: "MOTA", value: "82.4" },
          ],
        },
      ],
      counts: { text: 0, table: 0, figure: 0, formula: 0, structured_record: 1 },
      notes: [],
      contentHash: "hash",
      parsedAt: "2026-09-29T00:00:00Z",
    };
    const chunker = new SourceChunker({
      documentProvider: async () => xlsxDocument,
    });
    const { source } = await f.sources.add(f.projectId, {
      fileName: "experiment.xlsx",
      content: Buffer.from("binary xlsx bytes"),
    });
    const path = await f.sources.filePath(f.projectId, source.sourceId);
    const result = await chunker.chunkSource(f.projectId, source, path);
    expect(result.outcome.status).toBe("indexed");
    expect(result.outcome.parser).toBe("tabular");
    expect(result.chunks[0]!.text).toContain("[Sheet1 row 2]");
    expect(result.chunks[0]!.text).toContain("MOTA=82.4");
  });
});
