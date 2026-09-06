/**
 * M4.3.2 Long-document Context 测试：PaperMap 构建/摘要缓存/失败容忍 +
 * ReviewContextBuilder 隔离证明（Method context 不含其他 section 全文）+
 * 会话无关可重建证明（长文档 review 不依赖不断增长的 session）。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { PaperStore } from "../../src/paper/PaperStore.js";
import { PaperMapService } from "../../src/paper/PaperMapService.js";
import { ReviewContextBuilder } from "../../src/paper/ReviewContextBuilder.js";
import type { PaperDocument } from "../../src/paper/types.js";
import type { AgentRuntime, AgentTask, RuntimeHealth } from "../../src/runtime/types.js";

// ---- 可脚本化的 Fake Runtime（默认按 scope 返回摘要文本） ----

class FakeMapRuntime implements AgentRuntime {
  readonly provider = "pi" as const;
  readonly calls: Array<{ contextScope: string; taskChars: number }> = [];
  /** 指定 sectionId 的摘要调用抛错（模拟失败/模型不可用） */
  failSections = new Set<string>();
  private counter = 0;

  async healthCheck(): Promise<RuntimeHealth> {
    return {
      ok: true,
      provider: "pi",
      status: "healthy",
      detail: "fake",
      latencyMs: 1,
      checkedAt: new Date().toISOString(),
    };
  }

  async runAgent(input: {
    agentId: string;
    contextScope?: string;
    task: string;
  }): Promise<AgentTask> {
    this.counter += 1;
    const scope = input.contextScope ?? "";
    this.calls.push({ contextScope: scope, taskChars: input.task.length });
    if (scope.startsWith("review/summary/")) {
      const sectionId = scope.slice("review/summary/".length);
      if (this.failSections.has(sectionId)) {
        throw new Error("fake model unavailable");
      }
    }
    const now = new Date().toISOString();
    return {
      taskId: `fake-${this.counter}`,
      agentId: input.agentId,
      status: "completed",
      createdAt: now,
      updatedAt: now,
      output: `【${scope} 的中文摘要】本节介绍了测试内容的核心要点。`,
    };
  }

  async startAgent(input: Parameters<AgentRuntime["startAgent"]>[0]) {
    const task = await this.runAgent(input);
    return {
      taskId: task.taskId,
      sessionKey: "fake",
      events: async function* () {},
      cancel: async () => {},
      result: async () => task,
    };
  }

  async getTask() {
    throw new Error("not implemented");
  }

  async close() {}
}

// ---- fixture：三 section 文档（每 section 带独特标记句） ----

function markerDocument(): PaperDocument {
  const section = (id: string, title: string, pageStart: number, pageEnd: number) => ({
    sectionId: id,
    title,
    level: 1,
    pageStart,
    pageEnd,
    charCount: 0,
    source: "toc" as const,
  });
  const chunk = (id: string, sequence: number, sectionId: string, page: number, marker: string) => ({
    chunkId: id,
    sequence,
    pageStart: page,
    pageEnd: page,
    sectionId,
    text: `${marker} ${marker.toLowerCase()} repeated body text for budget measurement. ${"lorem ipsum dolor sit amet consectetur adipiscing elit sed do eiusmod tempor. ".repeat(6)}`,
    charCount: 0,
  });
  const chunks = [
    chunk("C0000", 0, "SEC00", 1, "ABSTRACT_UNIQUE_MARKER"),
    chunk("C0001", 1, "SEC01", 1, "INTRO_UNIQUE_MARKER_SENTENCE_ALPHA"),
    chunk("C0002", 2, "SEC01", 2, "INTRO_UNIQUE_MARKER_SENTENCE_BETA"),
    chunk("C0003", 3, "SEC02", 3, "METHOD_UNIQUE_MARKER_SENTENCE_GAMMA"),
    chunk("C0004", 4, "SEC02", 4, "METHOD_UNIQUE_MARKER_SENTENCE_DELTA"),
    chunk("C0005", 5, "SEC03", 5, "CONCLUSION_UNIQUE_MARKER_SENTENCE_OMEGA"),
  ].map((c) => ({ ...c, charCount: c.text.length, sequence: c.sequence + 1 }));
  return {
    schemaVersion: 1,
    projectId: "p-fixture",
    documentId: "paper-1",
    title: "Fixture Paper on Long Documents",
    originalFileName: "fixture.pdf",
    bytes: 12345,
    sha256: "f".repeat(64),
    parse: {
      parserId: "test",
      parsedAt: "2026-09-06T00:00:00.000Z",
      durationMs: 1,
      pageCount: 5,
      extractionQuality: "good",
    },
    pages: Array.from({ length: 5 }, (_, i) => ({
      pageId: `P${String(i + 1).padStart(3, "0")}`,
      pageNumber: i + 1,
      text: `page ${i + 1}`,
      charCount: 9,
    })),
    sections: [
      { ...section("SEC00", "Abstract", 1, 1), charCount: 0 },
      { ...section("SEC01", "Introduction", 1, 2), charCount: 0 },
      { ...section("SEC02", "Method", 3, 4), charCount: 0 },
      { ...section("SEC03", "Conclusion", 5, 5), charCount: 0 },
    ].map((s, i) => ({
      ...s,
      charCount: chunks.filter((c) => c.sectionId === s.sectionId).reduce((n, c) => n + c.charCount, 0) + i,
    })),
    chunks,
    abstractSectionId: "SEC00",
    ingestedAt: "2026-09-06T00:00:00.000Z",
  };
}

describe("M4.3.2 PaperMap + ReviewContextBuilder（长文档 context 隔离）", () => {
  let root: string;
  let projects: ProjectStore;
  let store: PaperStore;
  let runtime: FakeMapRuntime;
  let mapService: PaperMapService;
  let builder: ReviewContextBuilder;
  let projectId: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "paperteam-map-"));
    projects = new ProjectStore({ root });
    store = new PaperStore(projects);
    runtime = new FakeMapRuntime();
    mapService = new PaperMapService({
      projects,
      store,
      runtime,
      reviewerAgentId: "reviewer",
    });
    builder = new ReviewContextBuilder({ projects, store });
    const project = await projects.create("Context 测试");
    projectId = project.id;
    await store.saveIngest(projectId, markerDocument());
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("ensureMap：骨架 + 摘要（每 section 一次模型调用），摘要持久化", async () => {
    const map = await mapService.ensureMap(projectId);
    expect(map.sections).toHaveLength(4);
    expect(map.sourceFingerprint).toBe("f".repeat(64));
    expect(map.sections.every((s) => s.summary?.status === "ok")).toBe(true);
    expect(map.sections[0]!.summary!.summary).toContain("中文摘要");
    expect(runtime.calls).toHaveLength(4);
    expect(mapService.lastTelemetry).toEqual({ modelCalls: 4, summariesRefreshed: 4, failures: 0 });
    // 持久化
    const reloaded = await store.loadMap(projectId);
    expect(reloaded?.sections[1]!.summary?.status).toBe("ok");
  });

  it("指纹未变 → 摘要复用，零额外模型调用（token 控制）", async () => {
    const callsBefore = runtime.calls.length;
    await mapService.ensureMap(projectId);
    expect(runtime.calls.length).toBe(callsBefore);
  });

  it("单 section 摘要失败不阻塞 Map；telemetry 如实计数", async () => {
    const failRoot = await mkdtemp(join(tmpdir(), "paperteam-mapfail-"));
    try {
      const projects2 = new ProjectStore({ root: failRoot });
      const store2 = new PaperStore(projects2);
      const runtime2 = new FakeMapRuntime();
      runtime2.failSections.add("sec02");
      const service2 = new PaperMapService({
        projects: projects2,
        store: store2,
        runtime: runtime2,
        reviewerAgentId: "reviewer",
      });
      const project2 = await projects2.create("失败容忍");
      await store2.saveIngest(project2.id, markerDocument());
      const map = await service2.ensureMap(project2.id);
      expect(map.sections).toHaveLength(4); // Map 骨架完整
      expect(map.sections.find((s) => s.sectionId === "SEC02")!.summary?.status).toBe("failed");
      expect(map.sections.find((s) => s.sectionId === "SEC01")!.summary?.status).toBe("ok");
      expect(service2.lastTelemetry).toEqual({ modelCalls: 4, summariesRefreshed: 3, failures: 1 });
    } finally {
      await rm(failRoot, { recursive: true, force: true });
    }
  });

  it("【核心隔离证明】Method context 不含其他 section 全文，只含其摘要", async () => {
    const context = await builder.buildSectionContext(projectId, "SEC02");
    // 当前 section 全文在
    expect(context.prompt).toContain("METHOD_UNIQUE_MARKER_SENTENCE_GAMMA");
    expect(context.prompt).toContain("METHOD_UNIQUE_MARKER_SENTENCE_DELTA");
    // 其他 section 的全文绝不在
    expect(context.prompt).not.toContain("INTRO_UNIQUE_MARKER_SENTENCE_ALPHA");
    expect(context.prompt).not.toContain("INTRO_UNIQUE_MARKER_SENTENCE_BETA");
    expect(context.prompt).not.toContain("CONCLUSION_UNIQUE_MARKER_SENTENCE_OMEGA");
    // 其他 section 的摘要在（导航）
    expect(context.prompt).toContain("review/summary/sec01 的中文摘要");
    expect(context.prompt).toContain("review/summary/sec03 的中文摘要");
    // 摘要标记了「不含全文」
    expect(context.prompt).toContain("【全文导航（其他章节摘要，不含全文）】");
    // scope 稳定
    expect(context.contextScope).toBe("review/section/sec02");
    // budget：当前 section 只占自身文本；总 context 远小于全文
    const doc = await store.loadDocument(projectId);
    const fullTextChars = doc!.chunks.reduce((n, c) => n + c.charCount, 0);
    expect(context.budget.currentSectionChars).toBeLessThan(fullTextChars);
    const methodChars = doc!.chunks
      .filter((c) => c.sectionId === "SEC02")
      .reduce((n, c) => n + c.charCount, 0);
    expect(context.budget.currentSectionChars).toBeGreaterThanOrEqual(methodChars);
    expect(context.budget.currentSectionChars).toBeLessThanOrEqual(methodChars + 100);
    expect(
      context.budget.paperOverviewChars + context.budget.sectionIndexChars + context.budget.currentSectionChars + context.budget.citationsChars,
    ).toBeLessThanOrEqual(context.budget.totalChars + 200);
  });

  it("【会话无关证明】Runtime Session 全部丢弃后，context 从磁盘事实源重建且结果确定", async () => {
    const first = await builder.buildSectionContext(projectId, "SEC03");
    // 模拟 runtime/session 全部丢弃：全新 builder + 全新 PaperStore（同一磁盘）
    const freshBuilder = new ReviewContextBuilder({ projects, store: new PaperStore(projects) });
    const rebuilt = await freshBuilder.buildSectionContext(projectId, "SEC03");
    expect(rebuilt.prompt).toBe(first.prompt);
    expect(rebuilt.budget).toEqual(first.budget);
    expect(rebuilt.contextScope).toBe("review/section/sec03");
  });

  it("listSectionScopes：每个 section 一个稳定短生命周期 scope", async () => {
    const scopes = await builder.listSectionScopes(projectId);
    expect(scopes.map((s) => s.contextScope)).toEqual([
      "review/section/sec00",
      "review/section/sec01",
      "review/section/sec02",
      "review/section/sec03",
    ]);
    expect(scopes[2]!.chunkCount).toBe(2);
  });

  it("章节不存在 / 未上传 → 结构化错误", async () => {
    await expect(builder.buildSectionContext(projectId, "SEC99")).rejects.toThrow(/章节不存在/);
    const other = await projects.create("空项目");
    await expect(builder.buildSectionContext(other.id, "SEC01")).rejects.toThrow(/尚未上传/);
  });
});
