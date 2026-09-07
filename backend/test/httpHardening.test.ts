/**
 * HTTP 层加固回归：
 * - 上传请求体上限与服务层文件上限联动（50MB PDF 不再被 28MB 体积上限拦下）
 * - base64 字段字符集校验（损坏的 base64 不会被静默解码成乱码文件）
 * - 可选请求体：非法 JSON → 400，而不是当成 {}
 * - 已知子路径 + 错误方法 → 405（带 Allow）
 * - evidence?status= 非法 → 400；不存在的 Skill / Evidence → 404
 * - PDF 解析依赖缺失 → 503 PDF_PARSER_UNAVAILABLE；解析失败 → 422 PDF_PARSE_FAILED
 * - 未知异常 → 500 且响应体不透传内部消息
 */

import { afterEach, describe, expect, it } from "vitest";

import type { PdfParser } from "../src/paper/PdfParser.js";
import { PdfParseFailedError, PdfParserUnavailableError } from "../src/errors.js";
import { startTestStack, scriptedIdeaRuntime, type TestStack } from "./helpers/testStack.js";

const cleanups: Array<() => Promise<void>> = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((cleanup) => cleanup()));
});

async function stackWith(parser?: PdfParser): Promise<TestStack> {
  const stack = await startTestStack(scriptedIdeaRuntime().runtime, {
    ...(parser !== undefined ? { paperParser: parser } : {}),
  });
  cleanups.push(stack.cleanup);
  return stack;
}

function fakeParser(behavior: () => never | Promise<never>): PdfParser {
  return {
    id: "fake",
    async parseFile() {
      return behavior();
    },
    async checkAvailability() {
      return { available: true as const, command: "fake", args: [], pythonVersion: "0", pymupdfVersion: "0" };
    },
  };
}

/** 合法 PDF 文件头 + 填充，编码为 base64 */
function pdfBase64(bytes: number): string {
  const buffer = Buffer.alloc(bytes, 0x20);
  buffer.write("%PDF-1.4\n", 0, "latin1");
  return buffer.toString("base64");
}

describe("HTTP 请求体与字段校验", () => {
  it("import-pdf：30MB PDF 通过体积门槛进入服务层（此前被 28MB 请求体上限拒绝）", { timeout: 60_000 }, async () => {
    const stack = await stackWith(
      fakeParser(() => {
        throw new PdfParseFailedError("测试桩：不解析内容");
      }),
    );
    const response = await stack.request("POST", "/api/projects/import-pdf", {
      fileName: "big.pdf",
      contentBase64: pdfBase64(30 * 1024 * 1024),
      goal: "review_only",
    });
    // 到达了解析器（422），而不是被请求体上限拦成 400
    expect(response.status).toBe(422);
    expect((response.body["error"] as { code: string }).code).toBe("PDF_PARSE_FAILED");
  });

  it("contentBase64 含非法字符 → 400，不会静默解码", async () => {
    const stack = await stackWith();
    const project = await stack.store.create("上传校验");
    const response = await stack.request("POST", `/api/projects/${project.id}/paper/pdf`, {
      fileName: "x.pdf",
      contentBase64: "JVBERi0x!!!not-base64###",
    });
    expect(response.status).toBe(400);
    expect((response.body["error"] as { message: string }).message).toContain("base64");
  });

  it("可选请求体非法 JSON → 400（不当成空参数）", async () => {
    const stack = await stackWith();
    const project = await stack.store.create("可选体");
    const response = await fetch(`http://127.0.0.1:${stack.port()}/api/projects/${project.id}/citations/extract`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: '{"force": tru',
    });
    expect(response.status).toBe(400);
  });

  it("已知子路径 + 错误方法 → 405 且带 Allow", async () => {
    const stack = await stackWith();
    const project = await stack.store.create("方法校验");
    const response = await fetch(`http://127.0.0.1:${stack.port()}/api/projects/${project.id}/citations/extract`);
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("POST");
    const paper = await fetch(`http://127.0.0.1:${stack.port()}/api/projects/${project.id}/paper/reparse`);
    expect(paper.status).toBe(405);
  });

  it("evidence?status=bogus → 400；不存在的 Evidence → 404", async () => {
    const stack = await stackWith();
    const project = await stack.store.create("Evidence 校验");
    const bad = await stack.request("GET", `/api/projects/${project.id}/evidence?status=bogus`);
    expect(bad.status).toBe(400);
    const missing = await stack.request("GET", `/api/projects/${project.id}/evidence/E999`);
    expect(missing.status).toBe(404);
    expect((missing.body["error"] as { code: string }).code).toBe("NOT_FOUND");
  });
});

describe("PDF 解析错误语义", () => {
  it("解析依赖缺失 → 503 PDF_PARSER_UNAVAILABLE（消息含安装指引）", async () => {
    const stack = await stackWith(
      fakeParser(() => {
        throw new PdfParserUnavailableError("请执行 python -m pip install pymupdf");
      }),
    );
    const response = await stack.request("POST", "/api/projects/import-pdf", {
      fileName: "paper.pdf",
      contentBase64: pdfBase64(2048),
      goal: "review_only",
    });
    expect(response.status).toBe(503);
    const error = response.body["error"] as { code: string; message: string };
    expect(error.code).toBe("PDF_PARSER_UNAVAILABLE");
    expect(error.message).toContain("pip install pymupdf");
    // 回滚：不留半成品项目
    expect(await stack.store.listMetadata("all")).toHaveLength(0);
  });

  it("未知异常 → 500，响应体不透传内部消息", async () => {
    const stack = await stackWith(
      fakeParser(() => {
        throw new Error("D:\\secret\\path\\boom.py crashed");
      }),
    );
    const response = await stack.request("POST", "/api/projects/import-pdf", {
      fileName: "paper.pdf",
      contentBase64: pdfBase64(2048),
      goal: "review_only",
    });
    expect(response.status).toBe(500);
    const error = response.body["error"] as { code: string; message: string };
    expect(error.code).toBe("INTERNAL_ERROR");
    expect(error.message).not.toContain("secret");
  });
});
