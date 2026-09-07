/**
 * 已有论文 File-First 导入（POST /api/projects/import-pdf）测试：
 * 自动标题（PDF 内标题优先 / 文件名兜底）、goal → workflowKind 映射、
 * 解析失败回滚（无半成品项目）。
 */

import { readdir } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PdfParser, RawPdfExtraction } from "../../src/paper/PdfParser.js";
import { startTestStack, scriptedIdeaRuntime, type TestStack } from "../helpers/testStack.js";

/** 可脚本化结果的 fake parser（不跑 Python） */
function fakeParser(extraction: () => RawPdfExtraction): PdfParser {
  return {
    id: "fake",
    async parseFile() {
      return extraction();
    },
    async checkAvailability() {
      return { available: true as const, command: "fake", args: [], pythonVersion: "0", pymupdfVersion: "0" };
    },
  };
}

/** 一篇带目录 / 章节 / References 的小论文 */
function sampleExtraction(overrides: Partial<RawPdfExtraction> = {}): RawPdfExtraction {
  return {
    ok: true,
    parser: { id: "fake", version: "1" },
    pageCount: 4,
    title: "Attention Is All You Need",
    abstract: "We propose a new architecture.",
    toc: [
      [1, "Introduction", 1],
      [1, "Method", 2],
      [1, "References", 3],
    ] as Array<[number, string, number]>,
    blocks: [
      { page: 1, text: "Introduction text about transformers and attention mechanisms. " + "x".repeat(600) },
      { page: 2, text: "Method blocks describing the architecture. " + "y".repeat(600) },
      { page: 3, text: "[1] Vaswani et al. Attention is all you need. 2017." },
      { page: 3, text: "[2] Devlin et al. BERT. 2019." },
    ],
    totalChars: 2000,
    notes: [],
    ...overrides,
  };
}

/** 最小合法 PDF bytes（签名 + 内容；fake parser 不读内容） */
const PDF_BYTES = Buffer.from("%PDF-1.5\nfake content for import test\n");

let stack: TestStack;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  const scripted = scriptedIdeaRuntime();
  stack = await startTestStack(scripted.runtime, {
    paperParser: fakeParser(() => sampleExtraction()),
    registerCleanup: (cleanup) => cleanups.push(cleanup),
  });
});

afterAll(async () => {
  for (const cleanup of cleanups) {
    await cleanup();
  }
});

async function importRequest(body: Record<string, unknown>) {
  return stack.request("POST", "/api/projects/import-pdf", {
    fileName: "MRG-DTM-final.pdf",
    contentBase64: PDF_BYTES.toString("base64"),
    goal: "review_only",
    ...body,
  });
}

describe("POST /api/projects/import-pdf（File First 导入）", () => {
  it("成功导入：PDF 内标题成为项目标题；goal=review_only → existing_paper_review", async () => {
    const { status, body } = await importRequest({});
    expect(status).toBe(201);
    const project = body["project"] as Record<string, unknown>;
    expect(project["title"]).toBe("Attention Is All You Need");
    expect(project["workflowKind"]).toBe("existing_paper_review");
    expect(project["archivedAt"]).toBeUndefined();
    expect(body["titleSource"]).toBe("pdf");
    const document = body["document"] as Record<string, unknown>;
    expect(document["title"]).toBe("Attention Is All You Need");
    expect(document["pageCount"]).toBe(4);
  });

  it("goal=improvement → existing_paper_improvement；可选研究定位字段一并落入", async () => {
    const { status, body } = await importRequest({
      goal: "improvement",
      researchField: "信息检索",
    });
    expect(status).toBe(201);
    const project = body["project"] as Record<string, unknown>;
    expect(project["workflowKind"]).toBe("existing_paper_improvement");
    expect(project["researchField"]).toBe("信息检索");
  });

  it("PDF 无可用标题 → 文件名去扩展名兜底（MRG-DTM-final.pdf → MRG-DTM-final）", async () => {
    const local = await startTestStack(scriptedIdeaRuntime().runtime, {
      paperParser: fakeParser(() => sampleExtraction({ title: "" })),
      registerCleanup: (cleanup) => cleanups.push(cleanup),
    });
    const response = await local.request("POST", "/api/projects/import-pdf", {
      fileName: "MRG-DTM-final.pdf",
      contentBase64: PDF_BYTES.toString("base64"),
    });
    expect(response.status).toBe(201);
    const project = response.body["project"] as Record<string, unknown>;
    expect(project["title"]).toBe("MRG-DTM-final");
    expect(response.body["titleSource"]).toBe("filename");
  });

  it("明显不可用的 PDF 标题（纯数字 / .pdf 结尾 / untitled）→ 文件名兜底", async () => {
    for (const badTitle of ["12345", "paper.pdf", "untitled"]) {
      const local = await startTestStack(scriptedIdeaRuntime().runtime, {
        paperParser: fakeParser(() => sampleExtraction({ title: badTitle })),
        registerCleanup: (cleanup) => cleanups.push(cleanup),
      });
      const response = await local.request("POST", "/api/projects/import-pdf", {
        fileName: "thesis-v2.pdf",
        contentBase64: PDF_BYTES.toString("base64"),
      });
      expect(response.status).toBe(201);
      expect(response.body["titleSource"]).toBe("filename");
      expect((response.body["project"] as Record<string, unknown>)["title"]).toBe("thesis-v2");
    }
  });

  it("解析失败 → 回滚：不留半成品项目（项目列表与磁盘目录均无）", async () => {
    const boom = new Error("pymupdf crashed");
    const local = await startTestStack(scriptedIdeaRuntime().runtime, {
      paperParser: {
        id: "fake-broken",
        async parseFile() {
          throw boom;
        },
        async checkAvailability() {
          return { available: true as const, command: "fake", args: [], pythonVersion: "0", pymupdfVersion: "0" };
        },
      },
      registerCleanup: (cleanup) => cleanups.push(cleanup),
    });
    const before = (await local.request("GET", "/api/projects")).body["projects"] as unknown[];
    const response = await local.request("POST", "/api/projects/import-pdf", {
      fileName: "broken.pdf",
      contentBase64: PDF_BYTES.toString("base64"),
    });
    expect(response.status).toBe(500);
    expect((response.body["error"] as Record<string, unknown>)["code"]).toBe("INTERNAL_ERROR");
    const after = (await local.request("GET", "/api/projects")).body["projects"] as unknown[];
    expect(after.length).toBe(before.length);
    // 磁盘无残留项目目录
    const entries = await readdir(local.root);
    expect(entries.length).toBe(0);
  });

  it("非法输入：非 PDF 扩展名 / 非法 goal → 400", async () => {
    const notPdf = await importRequest({ fileName: "paper.docx" });
    expect(notPdf.status).toBe(400);
    const badGoal = await importRequest({ goal: "rewrite_everything" });
    expect(badGoal.status).toBe(400);
  });
});
