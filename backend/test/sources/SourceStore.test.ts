/**
 * SourceStore + PdfAnalyzer 测试（M3.1）：
 * 上传 / 元数据 / 角色 / 删除、项目隔离、PDF 文本层分析、
 * multimodal 扩展点（Agent 不可用时如实报告 capability gap）、
 * 分析失败不破坏项目。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { SourceStore, sanitizeFileName } from "../../src/sources/SourceStore.js";
import {
  AgentMultimodalAnalyzer,
  BuiltinPdfAnalyzer,
} from "../../src/sources/PdfAnalyzer.js";
import type { AgentRuntime, AgentTask, RuntimeHealth } from "../../src/runtime/types.js";
import { AgentRunFailedError } from "../../src/errors.js";

const tempRoots: string[] = [];
afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function newStore(): Promise<{ store: ProjectStore; sources: SourceStore; projectId: string; root: string }> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-src-"));
  tempRoots.push(root);
  const store = new ProjectStore({ root });
  const project = await store.create("文献测试");
  return { store, sources: new SourceStore(store), projectId: project.id, root };
}

/** 手工构造的最小可解析 PDF（未压缩内容流，含 Tj 文本） */
function minimalPdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
  ];
  const parts = ["%PDF-1.4"];
  let offset = parts[0]!.length + 1;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(offset);
    const object = `${index + 1} 0 obj\n${body}\nendobj\n`;
    parts.push(object);
    offset += object.length;
  });
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  parts.push(
    `${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`,
  );
  return Buffer.from(parts.join("\n"), "latin1");
}

describe("sanitizeFileName", () => {
  it("拒绝路径穿越 / 非法扩展名；保留安全名", () => {
    expect(sanitizeFileName("paper.pdf")).toBe("paper.pdf");
    expect(sanitizeFileName("../../evil.tex")).toBeUndefined();
    expect(sanitizeFileName("a/b.pdf")).toBeUndefined();
    expect(sanitizeFileName("evil.exe")).toBeUndefined();
    expect(sanitizeFileName("my paper.pdf")).toBeUndefined(); // 空格非法
  });
});

describe("SourceStore", () => {
  it("添加 / 查询 / 更新角色与 preferred / 删除；原始文件与索引落盘", async () => {
    const { sources, projectId, root } = await newStore();
    const item = await sources.add(projectId, {
      fileName: "survey.pdf",
      content: minimalPdf("Introduction to RAG survey"),
      sourceRole: "evidence",
      metadata: { title: "RAG Survey", year: 2023 },
    });
    expect(item.sourceId).toBe("S001");
    expect(item.status).toBe("pending");
    expect(item.metadata.title).toBe("RAG Survey");

    const stored = await readFile(
      join(root, projectId, "sources", "papers", "S001-survey.pdf"),
    );
    expect(stored.subarray(0, 5).toString("latin1")).toBe("%PDF-");

    const updated = await sources.update(projectId, "S001", {
      sourceRole: "reference",
      preferred: true,
    });
    expect(updated.sourceRole).toBe("reference");
    expect(updated.preferred).toBe(true);

    expect((await sources.list(projectId))).toHaveLength(1);
    await sources.remove(projectId, "S001");
    expect(await sources.list(projectId)).toHaveLength(0);
  });

  it("非法文件名 / 空内容 / 超限拒绝", async () => {
    const { sources, projectId } = await newStore();
    await expect(
      sources.add(projectId, { fileName: "../evil.pdf", content: Buffer.from("x") }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      sources.add(projectId, { fileName: "ok.pdf", content: Buffer.alloc(0) }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      sources.add(projectId, {
        fileName: "ok.pdf",
        content: Buffer.alloc(21 * 1024 * 1024),
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("不同项目文献隔离", async () => {
    const { store, sources } = await newStore();
    const a = await store.create("A");
    const b = await store.create("B");
    await sources.add(a.id, { fileName: "a.pdf", content: minimalPdf("A paper") });
    await sources.add(b.id, { fileName: "b.pdf", content: minimalPdf("B paper") });
    expect((await sources.list(a.id)).map((item) => item.sourceId)).toEqual(["S001"]);
    expect((await sources.list(b.id)).map((item) => item.sourceId)).toEqual(["S001"]);
    const pathA = await sources.filePath(a.id, "S001");
    const pathB = await sources.filePath(b.id, "S001");
    expect(pathA).not.toBe(pathB);
  });

  it("setAnalysis 同步状态与解析产物（分析失败 → failed 但条目保留）", async () => {
    const { sources, projectId, root } = await newStore();
    await sources.add(projectId, { fileName: "bad.pdf", content: Buffer.from("not a pdf") });
    const analyzer = new BuiltinPdfAnalyzer();
    const path = await sources.filePath(projectId, "S001");
    const analysis = await analyzer.analyzeFile(path);
    expect(analysis.status).toBe("failed");

    const updated = await sources.setAnalysis(projectId, "S001", analysis);
    expect(updated.status).toBe("failed");
    // 项目结构未被破坏：条目仍在，解析产物已落盘
    expect(await sources.get(projectId, "S001")).not.toBeNull();
    const parsed = await readFile(join(root, projectId, "sources", "parsed", "S001.json"), "utf8");
    expect(JSON.parse(parsed).status).toBe("failed");
  });
});

describe("BuiltinPdfAnalyzer（确定性文本层）", () => {
  it("从未压缩内容流提取文本、识别页数与章节标题", async () => {
    const { sources, projectId } = await newStore();
    // PDF 字符串中的 \n 转义会被解码为换行（章节标题按行识别）
    const text = "Introduction to RAG survey.\\nRAG improves factuality.\\n1 Introduction\\nReferences";
    await sources.add(projectId, { fileName: "ok.pdf", content: minimalPdf(text) });
    const analyzer = new BuiltinPdfAnalyzer();
    const analysis = await analyzer.analyzeFile(await sources.filePath(projectId, "S001"));

    expect(analysis.status).not.toBe("failed");
    expect(analysis.pageCount).toBe(1);
    expect(analysis.extractedChars).toBeGreaterThan(10);
    expect(analysis.headings).toContain("introduction");
    expect(analysis.textPreview).toContain("RAG");
  });

  it("压缩（FlateDecode）内容流同样可提取", async () => {
    const { deflateSync } = await import("node:zlib");
    const content = deflateSync(Buffer.from("BT /F1 12 Tf (Compressed stream text about method) Tj ET", "latin1"));
    // 构造带 FlateDecode 的最小 PDF
    const objects = [
      "<< /Type /Catalog /Pages 2 0 R >>",
      "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
      `<< /Type /Page /Parent 2 0 R /Contents 4 0 R >>`,
      `<< /Length ${content.length} /Filter /FlateDecode >>\nstream\n__CONTENT__\nendstream`,
    ];
    const parts: string[] = ["%PDF-1.4"];
    objects.forEach((body, index) => {
      const filled = body.replace("__CONTENT__", content.toString("latin1"));
      parts.push(`${index + 1} 0 obj\n${filled}\nendobj\n`);
    });
    parts.push("trailer\n<< /Root 1 0 R >>\n%%EOF\n");
    const buffer = Buffer.from(parts.join("\n"), "latin1");

    const analyzer = new BuiltinPdfAnalyzer();
    const analysis = analyzer.analyzeBuffer(buffer);
    expect(analysis.status).not.toBe("failed");
    expect(analysis.textPreview).toContain("Compressed");
  });

  it("非 PDF 输入 → status=failed（不抛异常）", () => {
    const analyzer = new BuiltinPdfAnalyzer();
    const analysis = analyzer.analyzeBuffer(Buffer.from("hello world"));
    expect(analysis.status).toBe("failed");
    expect(analysis.note).toContain("不是 PDF");
  });
});

describe("AgentMultimodalAnalyzer（扩展点）", () => {
  function runtimeWith(output: string | Error): AgentRuntime {
    return {
      provider: "pi",
      healthCheck: async () => makeHealth(),
      startAgent: async (input) => {
        if (output instanceof Error) {
          throw output;
        }
        const now = new Date().toISOString();
        const task: AgentTask = {
          taskId: "run-mm",
          agentId: input.agentId,
          status: "completed",
          createdAt: now,
          updatedAt: now,
          output,
        };
        return {
          taskId: task.taskId,
          sessionKey: `agent:${input.agentId}:paperteam-fake`,
          events: async function* () {},
          cancel: async () => {},
          result: async () => task,
        };
      },
      runAgent: async (input) => {
        if (output instanceof Error) {
          throw output;
        }
        const now = new Date().toISOString();
        const task: AgentTask = {
          taskId: "run-mm",
          agentId: input.agentId,
          status: "completed",
          createdAt: now,
          updatedAt: now,
          output,
        };
        return task;
      },
      getTask: () => {
        throw new Error("not implemented");
      },
      close: async () => {},
    };
  }

  it("Agent 返回合法 JSON → 产出 styleProfile（Derived Context）", async () => {
    const analyzer = new AgentMultimodalAnalyzer({
      runtime: runtimeWith('{"sectionStructure": ["Introduction", "Method"]}'),
      agentId: "researcher",
    });
    const result = await analyzer.analyzeReferencePaper({
      projectId: "p-x",
      absolutePath: "D:/somewhere/paper.pdf",
    });
    expect(result.status).toBe("ok");
    expect(result.styleProfile?.["sectionStructure"]).toBeDefined();
  });

  it("Agent 不可用 / 输出不可解析 → failed + capability gap 说明（不伪造成功）", async () => {
    const unavailable = new AgentMultimodalAnalyzer({
      runtime: runtimeWith(new AgentRunFailedError("模型未配置")),
      agentId: "researcher",
    });
    const result = await unavailable.analyzeReferencePaper({
      projectId: "p-x",
      absolutePath: "D:/somewhere/paper.pdf",
    });
    expect(result.status).toBe("failed");
    expect(result.note).toContain("multimodal");

    const garbage = new AgentMultimodalAnalyzer({
      runtime: runtimeWith("这不是 JSON"),
      agentId: "researcher",
    });
    const result2 = await garbage.analyzeReferencePaper({
      projectId: "p-x",
      absolutePath: "D:/somewhere/paper.pdf",
    });
    expect(result2.status).toBe("failed");
  });
});

function makeHealth(): RuntimeHealth {
  return {
    ok: true,
    provider: "pi",
    status: "healthy",
    detail: "ok",
    latencyMs: 1,
    checkedAt: new Date().toISOString(),
  };
}
