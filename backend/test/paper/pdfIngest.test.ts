/**
 * M4.3.1 PDF Ingest 测试：真实 PDF（arXiv 1706.03762）全链路 +
 * 校验 / 幂等 / 替换 / 重启持久化 / section-chunk 组装单元测试。
 */

import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { PyMuPdfParser } from "../../src/paper/PdfParser.js";
import { assemblePaper } from "../../src/paper/sectionChunking.js";
import { PaperStore } from "../../src/paper/PaperStore.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";
import { BusinessError } from "../../src/errors.js";
import { startTestStack, type TestStack } from "../helpers/testStack.js";
import { scriptedIdeaRuntime } from "../helpers/testStack.js";

const FIXTURE_PDF = join(import.meta.dirname, "..", "fixtures", "pdf", "attention.pdf");

describe("M4.3.1 PDF 解析（真实 arXiv PDF → pymupdf 工具）", () => {
  it("parseFile：页/块/TOC/标题/摘要提取", { timeout: 60_000 }, async () => {
    const parser = new PyMuPdfParser();
    const extraction = await parser.parseFile(FIXTURE_PDF);
    expect(extraction.ok).toBe(true);
    expect(extraction.parser.id).toBe("pymupdf");
    expect(extraction.pageCount).toBe(15);
    expect(extraction.toc.length).toBeGreaterThanOrEqual(15);
    expect(extraction.blocks.length).toBeGreaterThan(100);
    expect(extraction.title).toBe("Attention Is All You Need");
    expect(extraction.abstract.toLowerCase()).toContain("sequence transduction");
  });

  it("parseFile：文件不存在 / 非 PDF → 结构化业务错误", { timeout: 30_000 }, async () => {
    const parser = new PyMuPdfParser();
    await expect(parser.parseFile(join(tmpdir(), "definitely-missing-x1.pdf"))).rejects.toThrow(
      BusinessError,
    );
  });
});

describe("M4.3.1 section/chunk 组装（确定性，无 Python）", () => {
  it("TOC 模式：sections 来自 outline，chunks 带页码 provenance 且不跨 section", () => {
    const extraction = {
      ok: true as const,
      parser: { id: "test" },
      pageCount: 6,
      title: "Test Paper",
      abstract: "abs",
      toc: [
        [1, "Introduction", 1],
        [1, "Method", 2],
        [2, "Sub Method", 3],
        [1, "References", 5],
      ] as Array<[number, string, number]>,
      blocks: [
        ...Array.from({ length: 10 }, (_, i) => ({ page: 1, text: `intro block ${i} ${"x".repeat(100)}` })),
        ...Array.from({ length: 10 }, (_, i) => ({ page: 2, text: `method block ${i} ${"y".repeat(100)}` })),
        ...Array.from({ length: 8 }, (_, i) => ({ page: 3, text: `sub block ${i} ${"z".repeat(100)}` })),
        ...Array.from({ length: 4 }, (_, i) => ({ page: 5, text: `[${i + 1}] ref entry ${i}` })),
      ],
      totalChars: 3200,
      notes: [],
    };
    const assembled = assemblePaper(extraction);
    expect(assembled.sections.length).toBe(4);
    expect(assembled.sections.map((s) => s.title)).toEqual([
      "Introduction",
      "Method",
      "Sub Method",
      "References",
    ]);
    expect(assembled.referencesSectionId).toBeDefined();
    // chunk provenance 不变量
    const sectionIds = new Set(assembled.sections.map((s) => s.sectionId));
    for (const chunk of assembled.chunks) {
      expect(sectionIds.has(chunk.sectionId)).toBe(true);
      expect(chunk.pageStart).toBeLessThanOrEqual(chunk.pageEnd);
      expect(chunk.charCount).toBeGreaterThan(0);
      expect(chunk.charCount).toBeLessThanOrEqual(2600);
    }
    // intro 块只进 Introduction section
    const introSection = assembled.sections[0]!;
    const introChunks = assembled.chunks.filter((c) => c.sectionId === introSection.sectionId);
    expect(introChunks.length).toBeGreaterThan(0);
    expect(introChunks.every((c) => c.text.includes("intro block"))).toBe(true);
    // 引用条目进入 References section
    const refSection = assembled.sections[3]!;
    const refChunks = assembled.chunks.filter((c) => c.sectionId === refSection.sectionId);
    expect(refChunks.some((c) => c.text.includes("ref entry"))).toBe(true);
  });

  it("无 TOC：标题正则兜底；仍无 → 整档单 section", () => {
    const headingOnly = {
      ok: true as const,
      parser: { id: "test" },
      pageCount: 4,
      title: "",
      abstract: "",
      toc: [],
      blocks: [
        { page: 1, text: "Some intro text" },
        { page: 2, text: "1 Introduction\nWe study…" },
        { page: 3, text: "2 Method\nWe propose…" },
        { page: 4, text: "References\n[1] x" },
      ],
      totalChars: 100,
      notes: [],
    };
    const assembled = assemblePaper(headingOnly);
    expect(assembled.sections.some((s) => s.source === "heading-pattern")).toBe(true);
    expect(assembled.referencesSectionId).toBeDefined();

    const noStructure = {
      ok: true as const,
      parser: { id: "test" },
      pageCount: 2,
      title: "",
      abstract: "",
      toc: [],
      blocks: [
        { page: 1, text: "just some text" },
        { page: 2, text: "more text" },
      ],
      totalChars: 24,
      notes: [],
    };
    const fallback = assemblePaper(noStructure);
    expect(fallback.sections).toHaveLength(1);
    expect(fallback.sections[0]!.source).toBe("whole-document");
    expect(fallback.chunks.length).toBeGreaterThanOrEqual(1);
    // 总字符量过小（< 60）→ poor
    expect(fallback.extractionQuality).toBe("poor");
  });
});

describe("M4.3.1 Ingest 服务 + HTTP（真实 PDF e2e）", () => {
  let stack: TestStack;
  let projects: ProjectStore;
  let projectId: string;
  let pdfBuffer: Buffer;

  beforeAll(async () => {
    const runtime = scriptedIdeaRuntime().runtime;
    stack = await startTestStack(runtime);
    projects = stack.store;
    const project = await projects.create("PDF Review 测试");
    projectId = project.id;
    pdfBuffer = await readFile(FIXTURE_PDF);
  });

  afterAll(async () => {
    await stack.cleanup();
  });

  it("非法输入被拒绝：扩展名 / 签名 / 空内容", async () => {
    await expect(
      stack.stack.paperIngest.ingest(projectId, { fileName: "paper.txt", content: pdfBuffer }),
    ).rejects.toThrow(/\.pdf/);
    await expect(
      stack.stack.paperIngest.ingest(projectId, {
        fileName: "paper.pdf",
        content: Buffer.from("not a pdf at all"),
      }),
    ).rejects.toThrow(/%PDF-/);
    await expect(
      stack.stack.paperIngest.ingest(projectId, { fileName: "paper.pdf", content: Buffer.alloc(0) }),
    ).rejects.toThrow(/空/);
    // 路径穿越被 basename 归一化中和（落盘路径固定，文件名仅作元数据；独立项目避免污染后续用例）
    const traversalProject = await projects.create("路径穿越归一化");
    const normalized = await stack.stack.paperIngest.ingest(traversalProject.id, {
      fileName: "..\\..\\evil\\name.pdf",
      content: pdfBuffer,
    });
    expect(normalized.document.originalFileName).toBe("name.pdf");
  });

  it("PDF → 上传 → 解析 → 落盘 → 重读（模拟 backend restart）", { timeout: 90_000 }, async () => {
    const result = await stack.stack.paperIngest.ingest(projectId, {
      fileName: "attention.pdf",
      content: pdfBuffer,
    });
    expect(result.unchanged).toBe(false);
    const document = result.document;
    expect(document.parse.pageCount).toBe(15);
    expect(document.sections.length).toBeGreaterThanOrEqual(5);
    expect(document.chunks.length).toBeGreaterThanOrEqual(10);
    expect(document.parse.extractionQuality).toBe("good");
    expect(document.referencesSectionId).toBeDefined();

    // 磁盘布局
    const store = new PaperStore(projects);
    expect((await readFile(store.sourcePath(projectId))).equals(pdfBuffer)).toBe(true);

    // 重启模拟：全新 PaperStore 实例从磁盘重建完整文档
    const reloaded = await new PaperStore(projects).loadDocument(projectId);
    expect(reloaded).not.toBeNull();
    expect(reloaded!.parse.pageCount).toBe(15);
    expect(reloaded!.chunks.length).toBe(document.chunks.length);
    expect(reloaded!.sections.length).toBe(document.sections.length);
    expect(reloaded!.sha256).toBe(document.sha256);
    // chunk 均带 page provenance
    for (const chunk of reloaded!.chunks) {
      expect(chunk.pageStart).toBeGreaterThanOrEqual(1);
      expect(chunk.pageEnd).toBeLessThanOrEqual(15);
      expect(chunk.sectionId).toMatch(/^SEC\d+$/);
    }
  });

  it("重复上传同内容 → 幂等 unchanged；不同内容 → 替换并清空派生产物", { timeout: 90_000 }, async () => {
    const again = await stack.stack.paperIngest.ingest(projectId, {
      fileName: "attention.pdf",
      content: pdfBuffer,
    });
    expect(again.unchanged).toBe(true);

    // 追加尾注字节 = 不同的合法 PDF（sha 变化，pymupdf 容忍尾部 append）
    const modified = Buffer.concat([pdfBuffer, Buffer.from("\n% paperteam append\n")]);
    const replaced = await stack.stack.paperIngest.ingest(projectId, {
      fileName: "attention-v2.pdf",
      content: modified,
    });
    expect(replaced.unchanged).toBe(false);
    expect(replaced.document.originalFileName).toBe("attention-v2.pdf");
    expect(replaced.document.sha256).not.toBe(again.document.sha256);
    // 解析 stage 被重置并成功
    const stages = await new PaperStore(projects).loadStages(projectId);
    expect(stages["parse"]?.status).toBe("ok");
    expect(stages["parse"]?.inputFingerprint).toBe(replaced.document.sha256);
  });

  it("HTTP：POST /paper/pdf、GET /paper、GET /paper/chunks?sectionId=", { timeout: 90_000 }, async () => {
    const created = await stack.request("POST", "/api/projects", { title: "HTTP PDF 项目" });
    const httpProjectId = (created.body["project"] as { id: string }).id;

    const missing = await stack.request("GET", `/api/projects/${httpProjectId}/paper`);
    expect(missing.status).toBe(200);
    expect(missing.body["document"]).toBeNull();

    const upload = await stack.request("POST", `/api/projects/${httpProjectId}/paper/pdf`, {
      fileName: "attention.pdf",
      contentBase64: pdfBuffer.toString("base64"),
    });
    expect(upload.status).toBe(201);
    const summary = upload.body["document"] as Record<string, unknown>;
    expect(summary["pageCount"]).toBe(15);
    expect(summary["sectionCount"] as number).toBeGreaterThanOrEqual(5);
    expect(summary["chunkCount"] as number).toBeGreaterThanOrEqual(10);

    const detail = await stack.request("GET", `/api/projects/${httpProjectId}/paper`);
    expect(detail.status).toBe(200);
    expect(Array.isArray(detail.body["sections"])).toBe(true);
    const stages = detail.body["stages"] as Record<string, unknown>;
    expect((stages["parse"] as Record<string, unknown>)["status"]).toBe("ok");

    const firstSectionId = (detail.body["sections"] as Array<{ sectionId: string }>)[0]!.sectionId;
    const chunks = await stack.request(
      "GET",
      `/api/projects/${httpProjectId}/paper/chunks?sectionId=${firstSectionId}`,
    );
    expect(chunks.status).toBe(200);
    const chunkList = chunks.body["chunks"] as Array<Record<string, unknown>>;
    expect(chunkList.length).toBeGreaterThan(0);
    expect(chunkList.every((chunk) => chunk["sectionId"] === firstSectionId)).toBe(true);

    // 篡改签名 → 400
    const bad = await stack.request("POST", `/api/projects/${httpProjectId}/paper/pdf`, {
      fileName: "x.pdf",
      contentBase64: Buffer.from("hello").toString("base64"),
    });
    expect(bad.status).toBe(400);
  });
});
