/**
 * M15.12 B1 — PaperMap 批量摘要模式测试：
 * 批次切分（数量/字符双上限）、逐节摘要存储格式不变、批响应缺节/解析失败
 * 的失败语义（可重跑、不阻塞 Map 落盘）、指纹复用与材料更新（cache invalidation）、
 * 跨页 chunk、空章节（零模型调用）。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { PaperStore } from "../../src/paper/PaperStore.js";
import { PaperMapService, partitionBatches } from "../../src/paper/PaperMapService.js";
import type { PaperDocument } from "../../src/paper/types.js";
import type { AgentRuntime, AgentTask, RuntimeHealth } from "../../src/runtime/types.js";

/** 可脚本化批量响应的 Fake Runtime */
class FakeBatchRuntime implements AgentRuntime {
  readonly provider = "pi" as const;
  readonly calls: Array<{ contextScope: string; task: string }> = [];
  /** 批量调用处理器（输入 sectionsBlock → 输出 raw 字符串） */
  batchHandler: ((task: string) => string) | undefined;
  private counter = 0;

  async healthCheck(): Promise<RuntimeHealth> {
    return { ok: true, provider: "pi", status: "healthy", detail: "fake", latencyMs: 1, checkedAt: new Date().toISOString() };
  }

  async runAgent(input: { agentId: string; contextScope?: string; task: string }): Promise<AgentTask> {
    this.counter += 1;
    const scope = input.contextScope ?? "";
    this.calls.push({ contextScope: scope, task: input.task });
    const now = new Date().toISOString();
    const output =
      scope.startsWith("review/summary-batch/") && this.batchHandler !== undefined
        ? this.batchHandler(input.task)
        : `【${scope} 的中文摘要】本节介绍了测试内容的核心要点。`;
    return { taskId: `fake-${this.counter}`, agentId: input.agentId, status: "completed", createdAt: now, updatedAt: now, output };
  }

  async startAgent(input: Parameters<AgentRuntime["startAgent"]>[0]) {
    const task = await this.runAgent(input);
    return { taskId: task.taskId, sessionKey: "fake", events: async function* () {}, cancel: async () => {}, result: async () => task };
  }

  async getTask(): Promise<AgentTask> {
    throw new Error("not implemented");
  }

  async close() {}
}

/** N 节文档（每节 2 chunk，跨页；体积可调以触发字符上限切批） */
function makeDocument(sectionCount: number, charsPerSection: number): PaperDocument {
  const sections = Array.from({ length: sectionCount }, (_, i) => ({
    sectionId: `SEC${String(i + 1).padStart(2, "0")}`,
    title: i === 0 ? "Introduction" : i === sectionCount - 1 ? "Conclusion" : `Section ${i + 1}`,
    level: 1,
    pageStart: i * 2 + 1,
    pageEnd: i * 2 + 2,
    charCount: charsPerSection,
    source: "toc" as const,
  }));
  const chunks = sections.flatMap((section, i) => [
    {
      chunkId: `C${String(i * 2).padStart(4, "0")}`,
      sequence: i * 2,
      pageStart: section.pageStart,
      pageEnd: section.pageStart,
      sectionId: section.sectionId,
      text: `sec${i + 1} part one. ${"a".repeat(Math.max(0, Math.floor(charsPerSection / 2) - 20))}`,
      charCount: 0,
    },
    {
      chunkId: `C${String(i * 2 + 1).padStart(4, "0")}`,
      sequence: i * 2 + 1,
      pageStart: section.pageEnd,
      pageEnd: section.pageEnd,
      sectionId: section.sectionId,
      text: `sec${i + 1} part two crossing pages. ${"b".repeat(Math.max(0, Math.floor(charsPerSection / 2) - 20))}`,
      charCount: 0,
    },
  ]).map((c) => ({ ...c, charCount: c.text.length, sequence: c.sequence + 1 }));
  return {
    schemaVersion: 1,
    projectId: "p-fixture",
    documentId: "paper-1",
    title: "Batched Summary Fixture",
    originalFileName: "fixture.pdf",
    bytes: 12345,
    sha256: "b".repeat(64),
    parse: { parserId: "test", parsedAt: "2026-10-29T00:00:00.000Z", durationMs: 1, pageCount: sectionCount * 2, extractionQuality: "good" },
    pages: [],
    sections,
    chunks,
    abstractSectionId: sections[0]?.sectionId,
    ingestedAt: "2026-10-29T00:00:00.000Z",
  };
}

describe("partitionBatches（纯函数）", () => {
  it("按数量上限切批（8 节/批）", () => {
    const works = Array.from({ length: 20 }, (_, i) => ({ input: "x".repeat(100), id: i }));
    const batches = partitionBatches(works);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(8);
    expect(batches[2]).toHaveLength(4);
  });
  it("按字符上限切批（40k/批）", () => {
    const works = Array.from({ length: 5 }, () => ({ input: "x".repeat(15_000) }));
    const batches = partitionBatches(works);
    expect(batches).toHaveLength(3);
    expect(batches[0]).toHaveLength(2); // 30k ≤ 40k；第 3 节 45k > 40k → 开新批
    expect(batches[1]).toHaveLength(2);
    expect(batches[2]).toHaveLength(1);
  });
  it("空输入 → 无批次", () => {
    expect(partitionBatches([])).toEqual([]);
  });
});

describe("PaperMapService batched 模式", () => {
  let root: string;
  let projects: ProjectStore;
  let store: PaperStore;
  let runtime: FakeBatchRuntime;
  let service: PaperMapService;
  let projectId: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "paperteam-map-batch-"));
    projects = new ProjectStore({ root });
    store = new PaperStore(projects);
    runtime = new FakeBatchRuntime();
    service = new PaperMapService({ projects, store, runtime, reviewerAgentId: "reviewer", concurrency: 2 });
    const project = await projects.create("批量摘要测试");
    projectId = project.id;
    await store.saveIngest(projectId, makeDocument(12, 3000));
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("batched：模型调用 = 批数（远小于节数），摘要逐节存储格式与 per-section 一致", async () => {
    runtime.calls.length = 0;
    runtime.batchHandler = (task) => {
      // 从 prompt 中提取全部 sectionId，逐节返回摘要
      const ids = [...task.matchAll(/【章节 (SEC\d+)】/g)].map((m) => m[1]);
      return JSON.stringify({
        summaries: ids.map((id) => ({ sectionId: id, summary: `${id} 的批量摘要内容。` })),
      });
    };
    const map = await service.ensureMap(projectId, { summaryMode: "batched" });
    // 12 节 × 3000 字符（每节输入含双 chunk）→ 2 批（每批 ≤8 节且 ≤40k 字符）
    const batchCalls = runtime.calls.filter((c) => c.contextScope.startsWith("review/summary-batch/"));
    expect(batchCalls).toHaveLength(2);
    expect(map.sections).toHaveLength(12);
    expect(map.sections.every((s) => s.summary?.status === "ok")).toBe(true);
    expect(map.sections[0]!.summary!.summary).toBe("SEC01 的批量摘要内容。");
    expect(map.sections[0]!.summary!.sourceFingerprint).toBeDefined();
    expect(service.lastTelemetry).toMatchObject({ modelCalls: 2, summariesRefreshed: 12, failures: 0, batches: 2 });
  });

  it("指纹未变 → 二次 ensureMap 零模型调用（缓存复用）", async () => {
    runtime.calls.length = 0;
    const map = await service.ensureMap(projectId, { summaryMode: "batched" });
    expect(runtime.calls).toHaveLength(0);
    expect(map.sections.every((s) => s.summary?.status === "ok")).toBe(true);
  });

  it("材料更新（单节 chunk 变化）→ 仅该节重生成（1 批 1 节）", async () => {
    const document = await store.loadDocument(projectId);
    expect(document).not.toBeNull();
    const mutated = document!;
    const chunk = mutated.chunks.find((c) => c.sectionId === "SEC05");
    expect(chunk).toBeDefined();
    chunk!.text = `${chunk!.text} updated material`;
    await store.saveIngest(projectId, mutated);
    runtime.calls.length = 0;
    runtime.batchHandler = (task) => {
      const ids = [...task.matchAll(/【章节 (SEC\d+)】/g)].map((m) => m[1]);
      return JSON.stringify({
        summaries: ids.map((id) => ({ sectionId: id, summary: `${id} 更新后的批量摘要。` })),
      });
    };
    const map = await service.ensureMap(projectId, { summaryMode: "batched" });
    const batchCalls = runtime.calls.filter((c) => c.contextScope.startsWith("review/summary-batch/"));
    expect(batchCalls).toHaveLength(1);
    expect(map.sections.find((s) => s.sectionId === "SEC05")!.summary!.summary).toBe("SEC05 更新后的批量摘要。");
    // 未变节摘要保持原值（指纹复用，非重生成）
    expect(map.sections.find((s) => s.sectionId === "SEC01")!.summary!.summary).toBe("SEC01 的批量摘要内容。");
  });

  it("批响应缺失某节 → 该节 failed（可重跑），其余节正常，Map 照常落盘", async () => {
    // 构造新项目：4 节 → 1 批，响应缺 SEC02
    const project2 = await projects.create("缺节测试");
    await store.saveIngest(project2.id, makeDocument(4, 1000));
    runtime.calls.length = 0;
    runtime.batchHandler = () =>
      JSON.stringify({ summaries: [{ sectionId: "SEC01", summary: "ok1" }, { sectionId: "SEC03", summary: "ok3" }, { sectionId: "SEC04", summary: "ok4" }] });
    const map = await service.ensureMap(project2.id, { summaryMode: "batched" });
    expect(map.sections.find((s) => s.sectionId === "SEC02")!.summary!.status).toBe("failed");
    expect(map.sections.find((s) => s.sectionId === "SEC01")!.summary!.status).toBe("ok");
    expect(service.lastTelemetry).toMatchObject({ modelCalls: 1, summariesRefreshed: 3, failures: 1 });
    const persisted = await store.loadMap(project2.id);
    expect(persisted?.sections.find((s) => s.sectionId === "SEC02")!.summary?.status).toBe("failed");
  });

  it("批输出整体不可解析 → 整批 failed；下一次 ensureMap 重试成功", async () => {
    const project3 = await projects.create("解析失败测试");
    await store.saveIngest(project3.id, makeDocument(3, 800));
    runtime.calls.length = 0;
    runtime.batchHandler = () => "这不是 JSON (((( ";
    let map = await service.ensureMap(project3.id, { summaryMode: "batched" });
    expect(map.sections.every((s) => s.summary?.status === "failed")).toBe(true);
    expect(service.lastTelemetry).toMatchObject({ modelCalls: 1, failures: 3 });
    // 重跑（失败状态 → needsRefresh）
    runtime.batchHandler = (task) => {
      const ids = [...task.matchAll(/【章节 (SEC\d+)】/g)].map((m) => m[1]);
      return JSON.stringify({ summaries: ids.map((id) => ({ sectionId: id, summary: `${id} retry ok` })) });
    };
    map = await service.ensureMap(project3.id, { summaryMode: "batched" });
    expect(map.sections.every((s) => s.summary?.status === "ok")).toBe(true);
  });

  it("空章节：无文本 → failed（章节无文本），不消耗模型调用", async () => {
    const project4 = await projects.create("空章节测试");
    const doc = makeDocument(2, 500);
    doc.chunks = doc.chunks.filter((c) => c.sectionId === "SEC01");
    await store.saveIngest(project4.id, doc);
    runtime.calls.length = 0;
    const map = await service.ensureMap(project4.id, { summaryMode: "batched" });
    expect(map.sections.find((s) => s.sectionId === "SEC02")!.summary).toMatchObject({ status: "failed", error: "章节无文本" });
    expect(runtime.calls).toHaveLength(1); // 仅 SEC01 一批
    expect(map.sections.find((s) => s.sectionId === "SEC01")!.summary?.status).toBe("ok");
  });

  it("per-section 缺省模式行为不变（每节一调用）", async () => {
    const project5 = await projects.create("缺省模式测试");
    await store.saveIngest(project5.id, makeDocument(5, 500));
    runtime.calls.length = 0;
    runtime.batchHandler = undefined;
    const map = await service.ensureMap(project5.id);
    expect(map.sections.every((s) => s.summary?.status === "ok")).toBe(true);
    expect(runtime.calls.filter((c) => c.contextScope.startsWith("review/summary/"))).toHaveLength(5);
    expect(runtime.calls.some((c) => c.contextScope.startsWith("review/summary-batch/"))).toBe(false);
  });
});
