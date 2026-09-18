/**
 * 统一导入入口（POST /api/projects/import-paper，M7.0.3）测试：
 * - format=pdf（缺省兼容）：与 import-pdf 同链路（paper ingest + 自动标题）
 * - format=latex：LaTeX 工程 File-First（建项目 → LatexImporter → \title 提取；
 *   校验失败回滚不留半成品）
 * - 旧 POST /api/projects/import-pdf 兼容保留
 * - GET /api/projects/:id/manuscript：当前稿件聚合视图（sourceType / 修订 /
 *   章节数 / 参考文献数 / 构建状态）
 */

import { readdir } from "node:fs/promises";
import { deflateRawSync } from "node:zlib";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { extractLatexTitle } from "../../src/project/ProjectImportService.js";
import type { PdfParser, RawPdfExtraction } from "../../src/paper/PdfParser.js";
import { startTestStack, scriptedIdeaRuntime, type TestStack } from "../helpers/testStack.js";

// ---- 测试物料 ----

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
    ],
    totalChars: 2000,
    notes: [],
    ...overrides,
  };
}

const PDF_BYTES = Buffer.from("%PDF-1.5\nfake content for import test\n");

/** 最小 ZIP 构造（deflate；与 workflow 测试同款） */
function buildZip(entries: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBytes, compressed);
    const centralEntry = Buffer.alloc(46);
    centralEntry.writeUInt32LE(0x02014b50, 0);
    centralEntry.writeUInt16LE(20, 4);
    centralEntry.writeUInt16LE(20, 6);
    centralEntry.writeUInt16LE(8, 10);
    centralEntry.writeUInt32LE(compressed.length, 20);
    centralEntry.writeUInt32LE(entry.data.length, 24);
    centralEntry.writeUInt16LE(nameBytes.length, 28);
    centralEntry.writeUInt32LE(offset, 42);
    central.push(centralEntry, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, end]);
}

const LATEX_MAIN = [
  "\\documentclass[UTF8]{ctexart}",
  "\\title{基于深度学习的多目标跟踪方法研究}",
  "\\begin{document}",
  "\\maketitle",
  "\\input{sections/introduction}",
  "\\bibliography{references}",
  "\\end{document}",
].join("\n");

const LATEX_ARCHIVE = buildZip([
  { name: "main.tex", data: Buffer.from(LATEX_MAIN, "utf8") },
  { name: "sections/introduction.tex", data: Buffer.from("\\section{引言}\n准确率提升 12.4%。", "utf8") },
  {
    name: "references.bib",
    data: Buffer.from(
      "@article{a, title={A Good Paper}, year={2020}}\n@article{b, title={Another}, year={2021}}",
      "utf8",
    ),
  },
]);

const LATEX_ARCHIVE_NO_TITLE = buildZip([
  {
    name: "main.tex",
    data: Buffer.from("\\documentclass{article}\n\\begin{document}\nNo title here.\n\\end{document}", "utf8"),
  },
]);

let stack: TestStack;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  stack = await startTestStack(scriptedIdeaRuntime().runtime, {
    paperParser: fakeParser(() => sampleExtraction()),
    registerCleanup: (cleanup) => cleanups.push(cleanup),
  });
});

afterAll(async () => {
  for (const cleanup of cleanups) {
    await cleanup();
  }
});

// ---- \title 提取（纯函数） ----

describe("extractLatexTitle", () => {
  it("简单 / 嵌套命令 / 转义符号 / 括号内容都正确剥离", () => {
    expect(extractLatexTitle("\\title{Hello World}")).toBe("Hello World");
    expect(extractLatexTitle("\\title{The \\textbf{New} Model}")).toBe("The New Model");
    expect(extractLatexTitle("\\title{A {B} C}")).toBe("A B C");
    expect(extractLatexTitle("\\title{50\\% Faster}")).toBe("50% Faster");
    expect(extractLatexTitle("\\title  {Spaced Out}")).toBe("Spaced Out");
  });

  it("无 \\title / 括号不闭合 / 剥离后为空 → undefined", () => {
    expect(extractLatexTitle("\\documentclass{article}")).toBeUndefined();
    expect(extractLatexTitle("\\title{Unclosed")).toBeUndefined();
    expect(extractLatexTitle("\\title{\\small}")).toBeUndefined();
  });
});

// ---- POST /api/projects/import-paper ----

describe("POST /api/projects/import-paper：format=pdf", () => {
  it("显式 format=pdf：与 import-pdf 同行为（自动标题 + goal 映射）", async () => {
    const { status, body } = await stack.request("POST", "/api/projects/import-paper", {
      format: "pdf",
      fileName: "MRG-DTM-final.pdf",
      contentBase64: PDF_BYTES.toString("base64"),
      goal: "improvement",
    });
    expect(status).toBe(201);
    const project = body["project"] as Record<string, unknown>;
    expect(project["title"]).toBe("Attention Is All You Need");
    expect(project["workflowKind"]).toBe("existing_paper_improvement");
    expect(body["titleSource"]).toBe("pdf");
    expect((body["document"] as Record<string, unknown>)["pageCount"]).toBe(4);
  });

  it("缺省 format（兼容旧请求体）：走 PDF 链路", async () => {
    const { status, body } = await stack.request("POST", "/api/projects/import-paper", {
      fileName: "legacy.pdf",
      contentBase64: PDF_BYTES.toString("base64"),
    });
    expect(status).toBe(201);
    expect(body["titleSource"]).toBe("pdf");
    expect(body["report"]).toBeUndefined();
  });

  it("非法 format / pdf 缺文件字段 → 400", async () => {
    const badFormat = await stack.request("POST", "/api/projects/import-paper", {
      format: "docx",
      fileName: "paper.docx",
      contentBase64: Buffer.from("x").toString("base64"),
    });
    expect(badFormat.status).toBe(400);
    const noFile = await stack.request("POST", "/api/projects/import-paper", {
      format: "pdf",
      contentBase64: PDF_BYTES.toString("base64"),
    });
    expect(noFile.status).toBe(400);
  });
});

describe("POST /api/projects/import-paper：format=latex", () => {
  it("成功导入：\\title 成为项目标题；workflowKind=improvement；report 携带结构", async () => {
    const { status, body } = await stack.request("POST", "/api/projects/import-paper", {
      format: "latex",
      fileName: "my-paper.zip",
      archiveBase64: LATEX_ARCHIVE.toString("base64"),
      researchField: "计算机视觉",
    });
    expect(status).toBe(201);
    const project = body["project"] as Record<string, unknown>;
    expect(project["title"]).toBe("基于深度学习的多目标跟踪方法研究");
    expect(project["workflowKind"]).toBe("existing_paper_improvement");
    expect(project["researchField"]).toBe("计算机视觉");
    expect(body["titleSource"]).toBe("latex");
    expect(body["document"]).toBeUndefined();
    const report = body["report"] as Record<string, unknown>;
    expect(report["entryCount"]).toBe(3);
    const structure = report["structure"] as Record<string, unknown>;
    expect(structure["entryFile"]).toBe("main.tex");
    expect(structure["bibFile"]).toBe("references.bib");
    // manuscript/ 工作树已落盘（用户后续在原稿上修改）
    const projectId = project["id"] as string;
    const entries = await readdir(stack.store.manuscriptDir(projectId));
    expect(entries).toContain("main.tex");
    expect(entries).toContain("references.bib");
  });

  it("入口无 \\title → 归档文件名兜底（my-paper.zip → my-paper）", async () => {
    const { status, body } = await stack.request("POST", "/api/projects/import-paper", {
      format: "latex",
      fileName: "my-paper.zip",
      archiveBase64: LATEX_ARCHIVE_NO_TITLE.toString("base64"),
    });
    expect(status).toBe(201);
    expect(body["titleSource"]).toBe("filename");
    expect((body["project"] as Record<string, unknown>)["title"]).toBe("my-paper");
  });

  it("归档无 .tex → 422 IMPORT_VALIDATION 并回滚（项目列表与磁盘均无残留）", async () => {
    // 独立栈：验证磁盘零残留（共享栈上已有其它测试项目）
    const local = await startTestStack(scriptedIdeaRuntime().runtime, {
      registerCleanup: (cleanup) => cleanups.push(cleanup),
    });
    const evil = buildZip([{ name: "readme.md", data: Buffer.from("no tex inside") }]);
    const before = (await local.request("GET", "/api/projects")).body["projects"] as unknown[];
    const { status, body } = await local.request("POST", "/api/projects/import-paper", {
      format: "latex",
      fileName: "broken.zip",
      archiveBase64: evil.toString("base64"),
    });
    expect(status).toBe(422);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe("IMPORT_VALIDATION");
    const after = (await local.request("GET", "/api/projects")).body["projects"] as unknown[];
    expect(after.length).toBe(before.length);
    const entries = await readdir(local.root);
    expect(entries.length).toBe(0);
  });

  it("latex 只支持系统性改进：goal=review_only → 400", async () => {
    const { status, body } = await stack.request("POST", "/api/projects/import-paper", {
      format: "latex",
      fileName: "my-paper.zip",
      archiveBase64: LATEX_ARCHIVE.toString("base64"),
      goal: "review_only",
    });
    expect(status).toBe(400);
    expect((body["error"] as Record<string, unknown>)["code"]).toBe("INVALID_REQUEST");
  });
});

describe("POST /api/projects/import-pdf（兼容保留）", () => {
  it("旧入口继续可用：201 + 同形响应", async () => {
    const { status, body } = await stack.request("POST", "/api/projects/import-pdf", {
      fileName: "compat.pdf",
      contentBase64: PDF_BYTES.toString("base64"),
      goal: "review_only",
    });
    expect(status).toBe(201);
    expect((body["project"] as Record<string, unknown>)["workflowKind"]).toBe("existing_paper_review");
    expect(body["document"]).toBeDefined();
  });
});

// ---- GET /api/projects/:id/manuscript（当前稿件聚合视图） ----

describe("GET /api/projects/:id/manuscript", () => {
  it("LaTeX 导入项目：sourceType=latex；章节数=tex 文件数；参考文献=bib 条目数", async () => {
    const imported = await stack.request("POST", "/api/projects/import-paper", {
      format: "latex",
      fileName: "overview.zip",
      archiveBase64: LATEX_ARCHIVE.toString("base64"),
    });
    const projectId = (imported.body["project"] as Record<string, unknown>)["id"] as string;

    const { status, body } = await stack.request("GET", `/api/projects/${projectId}/manuscript`);
    expect(status).toBe(200);
    const manuscript = body["overview"] as Record<string, unknown>;
    expect(manuscript["sourceType"]).toBe("latex");
    expect(manuscript["title"]).toBe("基于深度学习的多目标跟踪方法研究");
    expect(manuscript["titleSource"]).toBe("project");
    expect(manuscript["currentRevision"]).toBe(0);
    expect(manuscript["sectionCount"]).toBe(2); // main.tex + sections/introduction.tex
    expect(manuscript["referenceCount"]).toBe(2);
    expect(manuscript["build"]).toBeNull(); // 尚未跑 Build Gate
  });

  it("PDF 导入项目：sourceType=pdf（无 outline → 章节计数为 0，标题来自项目）", async () => {
    const imported = await stack.request("POST", "/api/projects/import-paper", {
      fileName: "overview.pdf",
      contentBase64: PDF_BYTES.toString("base64"),
    });
    const projectId = (imported.body["project"] as Record<string, unknown>)["id"] as string;

    const { status, body } = await stack.request("GET", `/api/projects/${projectId}/manuscript`);
    expect(status).toBe(200);
    const manuscript = body["overview"] as Record<string, unknown>;
    expect(manuscript["sourceType"]).toBe("pdf");
    expect(manuscript["title"]).toBe("Attention Is All You Need");
    expect(manuscript["sectionCount"]).toBe(0);
    expect(manuscript["referenceCount"]).toBe(0);
  });

  it("从想法新建的项目：sourceType=none，计数为 0", async () => {
    const created = await stack.request("POST", "/api/projects", { title: "全新论文" });
    const projectId = (created.body["project"] as Record<string, unknown>)["id"] as string;

    const { status, body } = await stack.request("GET", `/api/projects/${projectId}/manuscript`);
    expect(status).toBe(200);
    const manuscript = body["overview"] as Record<string, unknown>;
    expect(manuscript["sourceType"]).toBe("none");
    expect(manuscript["currentRevision"]).toBe(0);
    expect(manuscript["sectionCount"]).toBe(0);
    expect(manuscript["referenceCount"]).toBe(0);
    expect(manuscript["build"]).toBeNull();
  });

  it("项目不存在 → 404；非 GET 不产生数据（fall-through 404）", async () => {
    const missing = await stack.request("GET", "/api/projects/p-nonexistent00/manuscript");
    expect(missing.status).toBe(404);
    const wrongMethod = await stack.request("PUT", "/api/projects/p-nonexistent00/manuscript", {});
    expect(wrongMethod.status).toBe(404);
  });
});
