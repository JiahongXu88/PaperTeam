/**
 * M6.4 retrieve_library 工具测试：直接执行 ToolDefinition（不依赖 Pi Runtime）。
 * 覆盖：schema 输出形状 / 项目绑定（闭包 projectId）/ 不写 EvidenceStore /
 * 失败结构化返回（不抛错）/ 边界标注（retrieved ≠ verified）。
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { afterAll, describe, expect, it } from "vitest";

import { EvidenceStore } from "../../src/evidence/EvidenceStore.js";
import { createRetrieveLibraryTool } from "../../src/retrieval/tools.js";
import { DeterministicEmbeddingProvider } from "../../src/retrieval/embedding.js";
import { cleanupTempRoots, newRetrievalFixture } from "./fixtures.js";

afterAll(async () => {
  await cleanupTempRoots();
});

const DOC = [
  "# Method",
  "",
  "We adopt ByteTrack for multi-object tracking and report MOTA on MOT17.",
  "",
  "# Experiments",
  "",
  "消融实验表明数据关联策略对跟踪精度影响显著。",
].join("\n");

describe("M6.4 retrieve_library 工具（实际断言）", () => {
  it("lexical：结果 + packedContext 标记 + 非 verified 标注 + EvidenceStore 零写入", async () => {
    const f = await newRetrievalFixture();
    const projectId = f.projectId;
    await f.addTextSource("doc.md", DOC, { title: "MOT Paper" });
    const tool = createRetrieveLibraryTool(f.retrieval, projectId);
    const executor = extractExecutor(tool);
    const result = await executor("call-1", { query: "ByteTrack MOT17" });
    expect(result.details["mode"]).toBe("lexical");
    const payload = JSON.parse(result.content[0]!.text) as Record<string, unknown>;
    expect(payload["note"]).toContain("非 verified evidence");
    expect(payload["projectId"]).toBe(projectId);
    const packed = payload["packedContext"] as { text: string };
    expect(packed.text).toContain("[SRC:S001 CHUNK:S001:");
    const results = payload["results"] as Array<{ marker: string; section: string }>;
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.marker).toContain("SRC:S001");
    // 红线：不写 EvidenceStore
    const evidence = new EvidenceStore(f.projects);
    expect(await evidence.list(projectId)).toEqual([]);
    expect(existsSync(join(f.root, projectId, "evidence", "evidence.jsonl"))).toBe(false);
  });

  it("中文查询命中中文 chunk（tokenizer 生效）", async () => {
    const f = await newRetrievalFixture();
    await f.addTextSource("doc.md", DOC);
    const tool = createRetrieveLibraryTool(f.retrieval, f.projectId);
    const executor = extractExecutor(tool);
    const result = await executor("call-1", { query: "数据关联 跟踪精度" });
    const payload = JSON.parse(result.content[0]!.text) as { results: Array<{ section: string }> };
    expect(payload.results.length).toBeGreaterThan(0);
  });

  it("hybrid（provider 注入）走双通道；filter 透传（section）", async () => {
    const f = await newRetrievalFixture({ embedding: new DeterministicEmbeddingProvider() });
    await f.addTextSource("doc.md", DOC);
    const tool = createRetrieveLibraryTool(f.retrieval, f.projectId);
    const executor = extractExecutor(tool);
    const result = await executor("call-1", { query: "ByteTrack tracking", section: "method" });
    const payload = JSON.parse(result.content[0]!.text) as { mode: string; results: Array<{ section: string }> };
    expect(payload.mode).toBe("hybrid");
    expect(payload.results.length).toBeGreaterThan(0);
  });

  it("项目绑定：闭包 projectId 固定（A 项目工具查不到 B 项目内容）", async () => {
    const f = await newRetrievalFixture();
    const b = await f.projects.create("项目 B");
    await f.sources.add(b.id, {
      fileName: "secret.md",
      content: Buffer.from("# Secret\n\nZanzibar confidential project B content.", "utf8"),
    });
    const tool = createRetrieveLibraryTool(f.retrieval, f.projectId);
    const executor = extractExecutor(tool);
    const result = await executor("call-1", { query: "zanzibar confidential" });
    const payload = JSON.parse(result.content[0]!.text) as { results: unknown[] };
    expect(payload.results).toEqual([]);
  });

  it("失败结构化返回（不抛错）：不存在项目 → ok:false + reason", async () => {
    const f = await newRetrievalFixture();
    const tool = createRetrieveLibraryTool(f.retrieval, "ghost-project");
    const executor = extractExecutor(tool);
    const result = await executor("call-1", { query: "x" });
    const payload = JSON.parse(result.content[0]!.text) as { ok: boolean; reason: string };
    expect(payload.ok).toBe(false);
    expect(payload.reason).toBe("PROJECT_NOT_FOUND");
  });

  it("budgetTokens 钳制（非法值回默认）", async () => {
    const f = await newRetrievalFixture();
    await f.addTextSource("doc.md", DOC);
    const tool = createRetrieveLibraryTool(f.retrieval, f.projectId);
    const executor = extractExecutor(tool);
    const result = await executor("call-1", { query: "ByteTrack", budgetTokens: 999999 });
    const payload = JSON.parse(result.content[0]!.text) as { packedContext: { budgetTokens: number } };
    expect(payload.packedContext.budgetTokens).toBe(24000);
  });
});

/** 从 defineTool 产物提取 execute（测试 seam；类型经 unknown 中转） */
type ToolExecute = (
  id: string,
  params: unknown,
) => Promise<{ content: Array<{ type: string; text: string }>; details: Record<string, unknown> }>;
function extractExecutor(tool: unknown): ToolExecute {
  const record = tool as { name?: unknown; execute?: unknown };
  expect(record.name).toBe("retrieve_library");
  expect(typeof record.execute).toBe("function");
  return record.execute as ToolExecute;
}
