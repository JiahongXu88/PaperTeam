/**
 * M6.4 Retrieval HTTP API 测试：search / rebuild / stats / 权限与项目隔离 /
 * 非法 filter / 删除后失效 / EvidenceStore 零写入 / rebuild 项目范围。
 */

import { join } from "node:path";
import { existsSync } from "node:fs";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { scriptedIdeaRuntime, startTestStack, type TestStack } from "../helpers/testStack.js";

let stack: TestStack;
let cleanup: (() => Promise<void>) | undefined;
afterAll(async () => {
  await cleanup?.();
});

beforeAll(async () => {
  stack = await startTestStack(scriptedIdeaRuntime().runtime, {
    registerCleanup: (c) => {
      cleanup = c;
    },
  });
});

async function createProject(title: string): Promise<string> {
  const response = await stack.request("POST", "/api/projects", { title });
  expect(response.status).toBe(201);
  return (response.body["project"] as { id: string }).id;
}

async function uploadText(projectId: string, fileName: string, content: string): Promise<string> {
  const response = await stack.request("POST", `/api/projects/${projectId}/sources`, {
    fileName,
    contentBase64: Buffer.from(content, "utf8").toString("base64"),
  });
  expect(response.status).toBe(201);
  return (response.body["source"] as { sourceId: string }).sourceId;
}

const DOC = [
  "# Introduction",
  "",
  "We evaluate ByteTrack on MOT17 achieving MOTA 80.1 with strong data association.",
  "",
  "# Method",
  "",
  "The association cost combines motion and appearance cues in two stages.",
].join("\n");

describe("POST /api/projects/:id/retrieval/search", () => {
  it("lexical 检索 + packed context（budgetTokens）", async () => {
    const projectId = await createProject("检索 A");
    await uploadText(projectId, "doc.md", DOC);
    const response = await stack.request("POST", `/api/projects/${projectId}/retrieval/search`, {
      query: "ByteTrack MOT17",
      topK: 3,
      budgetTokens: 4000,
    });
    expect(response.status).toBe(200);
    expect(response.body["mode"]).toBe("lexical");
    const results = response.body["results"] as Array<{ chunk: { chunkId: string; text: string } }>;
    expect(results.length).toBeGreaterThan(0);
    expect(results[0]!.chunk.text).toContain("ByteTrack");
    const packed = response.body["packed"] as { text: string; usedTokens: number };
    expect(packed.text).toContain("[SRC:");
    expect(packed.usedTokens).toBeLessThanOrEqual(4000);
  });

  it("filter（sourceIds / section）与 mode=hybrid 未配置 → 422", async () => {
    const projectId = await createProject("检索 B");
    const sid = await uploadText(projectId, "doc.md", DOC);
    const filtered = await stack.request("POST", `/api/projects/${projectId}/retrieval/search`, {
      query: "association",
      filter: { sourceIds: [sid] },
    });
    expect(filtered.status).toBe(200);
    for (const entry of filtered.body["results"] as Array<{ chunk: { sourceId: string } }>) {
      expect(entry.chunk.sourceId).toBe(sid);
    }
    const sectioned = await stack.request("POST", `/api/projects/${projectId}/retrieval/search`, {
      query: "association",
      filter: { section: "method" },
    });
    expect(sectioned.status).toBe(200);
    for (const entry of sectioned.body["results"] as Array<{ chunk: { sectionTitle: string } }>) {
      expect(entry.chunk.sectionTitle.toLowerCase().startsWith("method")).toBe(true);
    }
    const hybrid = await stack.request("POST", `/api/projects/${projectId}/retrieval/search`, {
      query: "x",
      mode: "hybrid",
    });
    expect(hybrid.status).toBe(422);
    expect((hybrid.body["error"] as { code: string }).code).toBe("EMBEDDING_UNAVAILABLE");
  });

  it("非法 filter → 400 INVALID_RETRIEVAL_FILTER；非法 query → 400", async () => {
    const projectId = await createProject("检索 C");
    await uploadText(projectId, "doc.md", DOC);
    const bad = await stack.request("POST", `/api/projects/${projectId}/retrieval/search`, {
      query: "x",
      filter: { sourceIds: ["nope"] },
    });
    expect(bad.status).toBe(400);
    expect((bad.body["error"] as { code: string }).code).toBe("INVALID_RETRIEVAL_FILTER");
    const noQuery = await stack.request("POST", `/api/projects/${projectId}/retrieval/search`, {});
    expect(noQuery.status).toBe(400);
  });

  it("跨项目隔离：B 项目检索不到 A 项目内容", async () => {
    const a = await createProject("隔离 A");
    const b = await createProject("隔离 B");
    await uploadText(a, "doc.md", DOC);
    await uploadText(b, "doc.md", "# B Only\n\nZanzibar umbrella exclusive project content.");
    const fromB = await stack.request("POST", `/api/projects/${b}/retrieval/search`, {
      query: "ByteTrack MOT17",
    });
    expect(fromB.status).toBe(200);
    expect(fromB.body["results"]).toEqual([]);
    const fromA = await stack.request("POST", `/api/projects/${a}/retrieval/search`, {
      query: "zanzibar",
    });
    expect(fromA.body["results"]).toEqual([]);
  });

  it("不存在的项目 → 404", async () => {
    const response = await stack.request("POST", "/api/projects/ghost-project/retrieval/search", {
      query: "x",
    });
    expect(response.status).toBe(404);
  });
});

describe("POST /api/projects/:id/retrieval/rebuild + GET stats", () => {
  it("整库 rebuild 报告 per-source outcome；stats 如实", async () => {
    const projectId = await createProject("重建");
    await uploadText(projectId, "doc.md", DOC);
    const response = await stack.request("POST", `/api/projects/${projectId}/retrieval/rebuild`, {});
    expect(response.status).toBe(200);
    const sources = response.body["sources"] as Array<{ sourceId: string; status: string; chunkCount: number }>;
    expect(sources.length).toBe(1);
    expect(sources[0]!.status).toBe("indexed");
    expect(response.body["chunks"]).toBeGreaterThan(0);
    const stats = await stack.request("GET", `/api/projects/${projectId}/retrieval/stats`);
    expect(stats.status).toBe(200);
    expect(stats.body["mode"]).toBe("lexical");
    expect(stats.body["sources"]).toMatchObject({ total: 1, indexed: 1, skipped: 0 });
  });

  it("单 source rebuild：metadata-only → 422 SOURCE_NOT_INDEXABLE", async () => {
    const projectId = await createProject("重建单源");
    await uploadText(projectId, "doc.md", DOC);
    const imported = await stack.request("POST", `/api/projects/${projectId}/sources/import/doi`, {
      doi: "10.9999/unknown-doi-xyz",
    });
    // resolver 未配置（测试栈 scholarly providers 空）→ unresolved 记录 + metadata 条目
    expect([200, 201]).toContain(imported.status);
    const list = await stack.request("GET", `/api/projects/${projectId}/sources`);
    const items = list.body["sources"] as Array<{ sourceId: string; fileName?: string }>;
    const metadataOnly = items.find((item) => item.fileName === undefined)!;
    const response = await stack.request("POST", `/api/projects/${projectId}/retrieval/rebuild`, {
      sourceId: metadataOnly.sourceId,
    });
    expect(response.status).toBe(422);
    expect((response.body["error"] as { code: string }).code).toBe("SOURCE_NOT_INDEXABLE");
  });

  it("rebuild 只作用于本项目（其他项目 chunk 文件不受影响）", async () => {
    const a = await createProject("范围 A");
    const b = await createProject("范围 B");
    await uploadText(a, "doc.md", DOC);
    await uploadText(b, "doc.md", "# B\n\n" + "beta content ".repeat(40));
    await stack.request("POST", `/api/projects/${a}/retrieval/rebuild`, {});
    const bFile = join(stack.root, b, "sources", "chunks");
    expect(existsSync(bFile)).toBe(false); // B 未被触碰
  });
});

describe("删除 source → 检索失效（HTTP 全链路）", () => {
  it("DELETE 后 search 不再命中；其他 source 正常", async () => {
    const projectId = await createProject("删除失效");
    const sid = await uploadText(projectId, "doc.md", DOC);
    const sid2 = await uploadText(projectId, "doc2.md", "# Other\n\nkappa lambda surviving content.");
    await stack.request("POST", `/api/projects/${projectId}/retrieval/search`, { query: "ByteTrack" });
    const removed = await stack.request("DELETE", `/api/projects/${projectId}/sources/${sid}`);
    expect(removed.status).toBe(200);
    const ghost = await stack.request("POST", `/api/projects/${projectId}/retrieval/search`, {
      query: "ByteTrack MOT17",
    });
    expect(ghost.body["results"]).toEqual([]);
    const kept = await stack.request("POST", `/api/projects/${projectId}/retrieval/search`, {
      query: "kappa lambda",
    });
    expect((kept.body["results"] as unknown[]).length).toBeGreaterThan(0);
    void sid2;
  });
});

describe("EvidenceStore 零写入（HTTP 链路）", () => {
  it("检索与重建后 evidence 为空", async () => {
    const projectId = await createProject("零 Evidence");
    await uploadText(projectId, "doc.md", DOC);
    await stack.request("POST", `/api/projects/${projectId}/retrieval/search`, { query: "ByteTrack" });
    await stack.request("POST", `/api/projects/${projectId}/retrieval/rebuild`, {});
    const evidence = await stack.request("GET", `/api/projects/${projectId}/evidence`);
    expect(evidence.body["evidence"]).toEqual([]);
    expect(existsSync(join(stack.root, projectId, "evidence", "evidence.jsonl"))).toBe(false);
  });
});
