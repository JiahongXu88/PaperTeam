/**
 * M10.1 真实 docling smoke：backend/test/fixtures/pdf/attention.pdf 全链
 * （真实 Python + docling + 模型；本机未安装 docling 时整组软跳过——
 * 与 pymupdf live smoke 同口径）。
 *
 * 首次运行会从 HuggingFace 下载布局 / TableFormer 模型（数百 MB，落盘
 * 缓存后不再联网）；国内网络默认走 hf-mirror（HF_ENDPOINT 未显式设置时）。
 */

import { execFileSync } from "node:child_process";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { DoclingParser } from "../../src/ingestion/DoclingParser.js";
import { ParsedDocumentStore } from "../../src/ingestion/ParsedDocumentStore.js";
import { IngestionService } from "../../src/ingestion/IngestionService.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";
import { SourceStore } from "../../src/sources/SourceStore.js";
import { EvidenceStore } from "../../src/evidence/EvidenceStore.js";
import { SourceChunker } from "../../src/retrieval/SourceChunker.js";
import { sectionsFromDocument } from "../../src/ingestion/documentSections.js";

const FIXTURE_PDF = join(import.meta.dirname, "..", "fixtures", "pdf", "attention.pdf");

/** 模块加载期同步探测（describe.skipIf 需要同步值；docling import 首次约 2-5s） */
function probeDoclingInstalled(): boolean {
  if (process.env.PAPERTEAM_DOCLING_SMOKE === "0") {
    return false; // 显式关闭
  }
  for (const candidate of ["python", "python3"]) {
    try {
      execFileSync(candidate, ["-c", "import docling"], {
        stdio: "ignore",
        timeout: 60_000,
        env: { ...process.env, PYTHONIOENCODING: "utf8" },
      });
      return true;
    } catch {
      continue;
    }
  }
  return false;
}

const doclingInstalled = probeDoclingInstalled();

let tmp: string;

beforeAll(async () => {
  if (process.env.HF_ENDPOINT === undefined) {
    process.env.HF_ENDPOINT = "https://hf-mirror.com"; // 国内网络模型下载镜像（显式设置优先）
  }
  tmp = await mkdtemp(join(tmpdir(), "paperteam-docling-smoke-"));
});

afterAll(async () => {
  await rm(tmp, { recursive: true, force: true });
});

describe.skipIf(!doclingInstalled)("M10.1 真实 docling smoke（attention.pdf）", () => {
  it(
    "PDF → docling → 结构化 blocks（正文 / 表格 / 图 / 页码 provenance）",
    { timeout: 900_000 },
    async () => {
      const parser = new DoclingParser({ timeoutMs: 880_000 });
      const figuresDir = join(tmp, "figures");
      const extraction = await parser.parseFile(FIXTURE_PDF, { figuresDir });
      expect(extraction.mode).toBe("structured");
      expect(extraction.pageCount).toBeGreaterThan(10);
      expect(extraction.blocks.length).toBeGreaterThan(50);

      const textBlocks = extraction.blocks.filter((block) => block.type === "text");
      expect(textBlocks.length).toBeGreaterThan(40);
      // 页码 provenance：绝大多数文本块带页码
      const withPage = textBlocks.filter((block) => block.provenance.page !== undefined);
      expect(withPage.length / textBlocks.length).toBeGreaterThan(0.9);

      const tables = extraction.blocks.filter((block) => block.type === "table");
      expect(tables.length).toBeGreaterThanOrEqual(1);
      const firstTable = tables[0]!;
      if (firstTable.type !== "table") {
        throw new Error("expected table");
      }
      expect(firstTable.headers.length).toBeGreaterThan(0);
      expect(firstTable.rows.length).toBeGreaterThan(0);

      const figures = extraction.blocks.filter((block) => block.type === "figure");
      expect(figures.length).toBeGreaterThanOrEqual(1);

      // 章节标题进入 provenance.section（部分块）
      const withSection = extraction.blocks.filter(
        (block) => block.provenance.section !== undefined && block.provenance.section !== "",
      );
      expect(withSection.length).toBeGreaterThan(0);
    },
  );

  it(
    "全链：上传 → ingest → chunker 消费（docling kind + 页码 chunk）",
    { timeout: 900_000 },
    async () => {
      const { readFile } = await import("node:fs/promises");
      const projects = new ProjectStore({ root: join(tmp, "projects") });
      const project = await projects.create("docling smoke");
      const sources = new SourceStore(projects);
      const documents = new ParsedDocumentStore(projects);
      const ingestion = new IngestionService({
        projects,
        sources,
        documents,
        structuredParser: new DoclingParser({ timeoutMs: 880_000 }),
        evidence: new EvidenceStore(projects),
        log: () => {},
      });
      const content = await readFile(FIXTURE_PDF);
      const { source } = await sources.add(project.id, {
        fileName: "attention.pdf",
        content,
        metadata: { title: "Attention Is All You Need" },
      });
      const document = await ingestion.ingest(project.id, source.sourceId);
      expect(document.status).not.toBe("failed");
      expect(document.parseMode).toBe("structured");

      // chunker 经 documentProvider 消费结构化产物
      const chunker = new SourceChunker({
        documentProvider: (projectId, item) => ingestion.getDocument(projectId, item.sourceId),
      });
      const path = await sources.filePath(project.id, source.sourceId);
      const result = await chunker.chunkSource(project.id, source, path);
      expect(result.outcome.status).toBe("indexed");
      expect(result.outcome.parser).toBe("docling");
      expect(result.outcome.chunkCount).toBeGreaterThan(5);
      const withPages = result.chunks.filter((chunk) => chunk.pageStart !== undefined);
      expect(withPages.length).toBeGreaterThan(0);
      // 表格文本进检索
      expect(result.chunks.some((chunk) =>/\|/.test(chunk.text))).toBe(true);

      const sections = sectionsFromDocument(document);
      expect(sections.length).toBeGreaterThan(3);
    },
  );
});
