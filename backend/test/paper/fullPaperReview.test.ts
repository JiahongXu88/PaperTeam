/**
 * M15.12 B2 — FullPaperReviewService 单元测试：
 * 解析器（合法/非法条目/围栏容忍）、sectionId 引用收集、两步调用链
 * （scope/prompt 结构/锚校验/coverage 台账）、抽取失败的确定性回退。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { PaperStore } from "../../src/paper/PaperStore.js";
import {
  FullPaperReviewService,
  parseFullPaperFindingsOutput,
  collectReferencedSectionIds,
} from "../../src/paper/FullPaperReviewService.js";
import { createFinding } from "../../src/review/finding.js";
import type { PaperDocument, PaperMap } from "../../src/paper/types.js";
import type { AgentRuntime, AgentTask, RuntimeHealth } from "../../src/runtime/types.js";

class FakeFullPaperRuntime implements AgentRuntime {
  readonly provider = "pi" as const;
  readonly calls: Array<{ contextScope: string; task: string }> = [];
  /** 按 scope 定制输出（同 scope 每次调用弹出一个；耗尽后回落 outputs） */
  outputs = new Map<string, string>();
  outputsSeq = new Map<string, string[]>();
  /** 指定 scope 的调用直接抛错（取消/超时传播测试） */
  throwOn = new Map<string, Error>();
  private counter = 0;

  async healthCheck(): Promise<RuntimeHealth> {
    return { ok: true, provider: "pi", status: "healthy", detail: "fake", latencyMs: 1, checkedAt: new Date().toISOString() };
  }

  async runAgent(input: { agentId: string; contextScope?: string; task: string }): Promise<AgentTask> {
    this.counter += 1;
    const scope = input.contextScope ?? "";
    this.calls.push({ contextScope: scope, task: input.task });
    const error = this.throwOn.get(scope);
    if (error !== undefined) {
      throw error;
    }
    const now = new Date().toISOString();
    const seq = this.outputsSeq.get(scope);
    const output = seq !== undefined && seq.length > 0 ? seq.shift()! : this.outputs.get(scope) ?? "";
    return {
      taskId: `fake-${this.counter}`,
      agentId: input.agentId,
      status: "completed",
      createdAt: now,
      updatedAt: now,
      output,
    };
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

const EXTRACTION_JSON = JSON.stringify({
  research_goal: "提出统一图结构学习方法",
  task_definition: "graph classification",
  claimed_contributions: ["统一结构表示"],
  method_modules: [{ name: "GFM", claimed_mechanism: "结构增强", sectionId: "SEC02" }],
  key_claims: [{ claim: "跨域泛化", where: "摘要", sectionId: "SEC01" }],
  evidence_map: [{ claim: "跨域泛化", evidence: "三数据集对比", sectionId: "SEC03" }],
});

const CRITIQUE_JSON = JSON.stringify({
  findings: [
    {
      category: "academic",
      severity: "critical",
      sectionId: "SEC01",
      claimText: "enables unified graph structure learning",
      message: "研究目标（通用 GFM）与实验（仅 graph 分类单任务）错位。",
      evidenceGap: "缺少 node/link 级任务与更广数据集",
      confidence: "high",
      suggestion: "扩充实验或收窄声称",
    },
    {
      category: "consistency",
      severity: "major",
      sectionId: "SEC99", // 不存在 → 应被丢弃
      message: "锚到不存在章节的 finding",
    },
    { category: "academic", severity: "minor", message: "缺 sectionId 的 finding" }, // 应被丢弃
  ],
});

function makeDocument(): PaperDocument {
  const section = (id: string, title: string, page: number) => ({
    sectionId: id,
    title,
    level: 1,
    pageStart: page,
    pageEnd: page,
    charCount: 400,
    source: "toc" as const,
  });
  const chunk = (id: string, sequence: number, sectionId: string, text: string) => ({
    chunkId: id,
    sequence,
    pageStart: 1,
    pageEnd: 2,
    sectionId,
    text,
    charCount: text.length,
  });
  const chunks = [
    chunk("C0001", 1, "SEC01", "Introduction: enables unified graph structure learning through augmentation. " + "i".repeat(300)),
    chunk("C0002", 2, "SEC02", "Method: structural GFM module details. " + "m".repeat(300)),
    chunk("C0003", 3, "SEC03", "Experiments: three datasets comparisons. " + "e".repeat(300)),
    chunk("C0004", 4, "SEC04", "Conclusion: we showed broad applicability. " + "c".repeat(300)),
  ];
  return {
    schemaVersion: 1,
    projectId: "p-fixture",
    documentId: "paper-1",
    title: "Full Paper Fixture",
    originalFileName: "fixture.pdf",
    bytes: 999,
    sha256: "c".repeat(64),
    parse: { parserId: "test", parsedAt: "2026-10-29T00:00:00.000Z", durationMs: 1, pageCount: 4, extractionQuality: "good" },
    pages: [],
    sections: [section("SEC01", "Introduction", 1), section("SEC02", "Method", 2), section("SEC03", "Experiments", 3), section("SEC04", "Conclusion", 4)],
    chunks,
    abstractSectionId: "SEC01",
    ingestedAt: "2026-10-29T00:00:00.000Z",
  };
}

function makeMap(): PaperMap {
  return {
    schemaVersion: 1,
    documentTitle: "Full Paper Fixture",
    abstract: "We propose unified graph structure learning.",
    pageCount: 4,
    sections: [
      { sectionId: "SEC01", title: "Introduction", level: 1, pageStart: 1, pageEnd: 1, chunkCount: 1, charCount: 400, summary: { sectionId: "SEC01", status: "ok", summary: "引言提出统一图学习目标。" } },
      { sectionId: "SEC02", title: "Method", level: 1, pageStart: 2, pageEnd: 2, chunkCount: 1, charCount: 400, summary: { sectionId: "SEC02", status: "ok", summary: "方法节描述结构 GFM。" } },
      { sectionId: "SEC03", title: "Experiments", level: 1, pageStart: 3, pageEnd: 3, chunkCount: 1, charCount: 400, summary: { sectionId: "SEC03", status: "ok", summary: "实验节为三数据集对比。" } },
      { sectionId: "SEC04", title: "Conclusion", level: 1, pageStart: 4, pageEnd: 4, chunkCount: 1, charCount: 400, summary: { sectionId: "SEC04", status: "ok", summary: "结论声称广泛适用。" } },
    ],
    generatedAt: "2026-10-29T00:00:00.000Z",
    sourceFingerprint: "c".repeat(64),
  };
}

describe("parseFullPaperFindingsOutput（纯函数）", () => {
  it("合法输出解析（含 confidence/evidenceGap 透传）", () => {
    const result = parseFullPaperFindingsOutput(CRITIQUE_JSON);
    expect(result.parseFailed).toBe(false);
    // 解析层：SEC01 与 SEC99 均有 sectionId（SEC99 的存在性校验在服务层锚校验完成）；
    // 缺 sectionId 的第三条被解析层丢弃
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]).toMatchObject({ category: "academic", severity: "critical", sectionId: "SEC01", confidence: "high" });
    expect(result.dropped).toBe(1);
  });
  it("围栏与前后噪声容忍", () => {
    const raw = "说明文字\n```json\n" + CRITIQUE_JSON + "\n```\n尾注";
    expect(parseFullPaperFindingsOutput(raw).parseFailed).toBe(false);
  });
  it("整体非 JSON → parseFailed", () => {
    expect(parseFullPaperFindingsOutput("not json at all").parseFailed).toBe(true);
  });
  it("非法 category/severity 条目计入 dropped", () => {
    const raw = JSON.stringify({
      findings: [
        { category: "bogus", severity: "critical", sectionId: "SEC01", message: "x" },
        { category: "academic", severity: "fatal", sectionId: "SEC01", message: "x" },
        { category: "academic", severity: "minor", sectionId: "SEC01" },
      ],
    });
    const result = parseFullPaperFindingsOutput(raw);
    expect(result.findings).toHaveLength(0);
    expect(result.dropped).toBe(3);
  });
});

describe("collectReferencedSectionIds（纯函数）", () => {
  it("嵌套结构中收集 SEC id（大写归一 + 去重）", () => {
    const ids = collectReferencedSectionIds({
      method_modules: [{ sectionId: "sec02" }, { sectionId: "SEC02" }],
      key_claims: [{ sectionId: "SEC01" }],
      note: "SEC03 在自由文本中出现，但只有字段值整体为 sec id 才计入",
    });
    expect(ids).toEqual(["SEC02", "SEC01"]);
  });
});

describe("FullPaperReviewService.reviewFullPaper", () => {
  let root: string;
  let projects: ProjectStore;
  let store: PaperStore;
  let runtime: FakeFullPaperRuntime;
  let service: FullPaperReviewService;
  let projectId: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "paperteam-fullpaper-"));
    projects = new ProjectStore({ root });
    store = new PaperStore(projects);
    runtime = new FakeFullPaperRuntime();
    service = new FullPaperReviewService({ store, runtime, reviewerAgentId: "reviewer" });
    const project = await projects.create("全文 pass 测试");
    projectId = project.id;
    await store.saveIngest(projectId, makeDocument());
    await store.saveMap(projectId, makeMap());
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("两步调用：extract→critique；锚校验丢弃非法 sectionId；coverage 台账如实", async () => {
    runtime.calls.length = 0;
    runtime.outputs.set("review/fullpaper/extract", EXTRACTION_JSON);
    runtime.outputs.set("review/fullpaper/critique", CRITIQUE_JSON);
    const sectionFindings = [
      createFinding({
        findingId: "f-run1-sec01-1",
        category: "style",
        severity: "minor",
        message: "术语大小写不一致",
        source: "section-review",
        now: "2026-10-29T00:00:00.000Z",
        sectionId: "SEC01",
      }),
    ];
    const outcome = await service.reviewFullPaper({ projectId, runId: "run1", sectionFindings });
    // 恰好两次调用，scope 正确
    expect(runtime.calls.map((c) => c.contextScope)).toEqual(["review/fullpaper/extract", "review/fullpaper/critique"]);
    // extract prompt 含概览/导航索引/关键节全文
    const extractTask = runtime.calls[0]!.task;
    expect(extractTask).toContain("Full Paper Fixture");
    expect(extractTask).toContain("SEC03");
    expect(extractTask).toContain("Introduction"); // 关键节（标题匹配）
    // critique prompt 含 EXTRACTION + 被引用节全文 + 分节 findings 摘要
    const critiqueTask = runtime.calls[1]!.task;
    expect(critiqueTask).toContain("EXTRACTION");
    expect(critiqueTask).toContain("【SEC02 Method 全文】");
    expect(critiqueTask).toContain("EXISTING SECTION FINDINGS");
    expect(critiqueTask).toContain("术语大小写不一致");
    // findings：1 条合法保留（SEC99 与缺 sectionId 被丢）
    expect(outcome.findings).toHaveLength(1);
    expect(outcome.findings[0]).toMatchObject({
      category: "academic",
      severity: "critical",
      sectionId: "SEC01",
      source: "fullpaper-review",
      status: "open",
      confidence: "high",
      evidenceGap: "缺少 node/link 级任务与更广数据集",
    });
    expect(outcome.findings[0]!.findingId).toBe("f-run1-fullpaper-1");
    expect(outcome.dropped).toBe(2);
    expect(outcome.extractParseFailed).toBe(false);
    expect(outcome.critiqueParseFailed).toBe(false);
    expect(outcome.telemetry).toMatchObject({ calls: 2, failed: 0 });
    // coverage：引用节 = SEC02/SEC01/SEC03（来自 extraction），全部纳入
    expect(outcome.coverage.referencedSections).toBe(3);
    expect(outcome.coverage.referencedTruncated).toBe(false);
    expect(outcome.coverage.indexEntriesIncluded).toBe(4);
    expect(outcome.coverage.findingsDigestTotal).toBe(1);
    // extraction 原文保留（审计）
    expect(outcome.extraction).toMatchObject({ research_goal: "提出统一图结构学习方法" });
  });

  it("抽取解析失败 → 重试 1 次仍失败 → extractParseFailed 如实；critique 仍执行（确定性回退）", async () => {
    runtime.calls.length = 0;
    runtime.outputsSeq.clear();
    runtime.outputs.set("review/fullpaper/extract", "garbage not json");
    runtime.outputs.set("review/fullpaper/critique", JSON.stringify({ findings: [] }));
    const outcome = await service.reviewFullPaper({ projectId, runId: "run2", sectionFindings: [] });
    expect(outcome.extractParseFailed).toBe(true);
    expect(outcome.extractRetried).toBe(true);
    // M15.13 A1：解析失败有界重试 —— extract 调用 2 次（第 2 次附格式提醒）+ critique 1 次
    expect(runtime.calls.map((c) => c.contextScope)).toEqual([
      "review/fullpaper/extract",
      "review/fullpaper/extract",
      "review/fullpaper/critique",
    ]);
    expect(runtime.calls[1]!.task).toContain("上一次输出无法解析为 JSON");
    // 回退：关键节（Introduction/Conclusion 标题匹配）全文进 critique
    const critiqueTask = runtime.calls[2]!.task;
    expect(critiqueTask).toContain("【SEC01 Introduction 全文】");
    expect(critiqueTask).toContain("【SEC04 Conclusion 全文】");
    expect(outcome.coverage.referencedSections).toBeGreaterThanOrEqual(2);
    expect(outcome.findings).toHaveLength(0);
  });

  it("critique 输出不可解析 → 重试 1 次仍失败 → parseFailed 如实、findings 空、不抛异常", async () => {
    runtime.calls.length = 0;
    runtime.outputsSeq.clear();
    runtime.outputs.set("review/fullpaper/extract", EXTRACTION_JSON);
    runtime.outputs.set("review/fullpaper/critique", "((( no json");
    const outcome = await service.reviewFullPaper({ projectId, runId: "run3", sectionFindings: [] });
    expect(outcome.critiqueParseFailed).toBe(true);
    expect(outcome.critiqueRetried).toBe(true);
    expect(outcome.findings).toHaveLength(0);
    expect(outcome.telemetry.calls).toBe(3); // 1 extract + 2 critique（重试是物理调用）
  });

  it("A1 回归：extract 首次非法、重试成功 → extractParseFailed=false + extractRetried=true", async () => {
    runtime.calls.length = 0;
    runtime.outputsSeq.clear();
    runtime.outputs.delete("review/fullpaper/extract");
    runtime.outputs.delete("review/fullpaper/critique");
    runtime.outputsSeq.set("review/fullpaper/extract", ["garbage { broken", EXTRACTION_JSON]);
    runtime.outputsSeq.set("review/fullpaper/critique", [CRITIQUE_JSON]);
    const outcome = await service.reviewFullPaper({ projectId, runId: "run4", sectionFindings: [] });
    expect(outcome.extractParseFailed).toBe(false);
    expect(outcome.extractRetried).toBe(true);
    expect(outcome.critiqueParseFailed).toBe(false);
    expect(outcome.critiqueRetried).toBe(false);
    expect(outcome.telemetry.calls).toBe(3);
    expect(outcome.findings).toHaveLength(1); // CRITIQUE_JSON 中唯一合法条目
    expect(outcome.extraction).toMatchObject({ research_goal: "提出统一图结构学习方法" });
  });

  it("A1 回归：critique 首次截断、重试成功 → findings 完整恢复（M15.12 cand-23 场景）", async () => {
    runtime.calls.length = 0;
    runtime.outputsSeq.clear();
    runtime.outputs.delete("review/fullpaper/extract");
    runtime.outputs.delete("review/fullpaper/critique");
    runtime.outputsSeq.set("review/fullpaper/extract", [EXTRACTION_JSON]);
    runtime.outputsSeq.set("review/fullpaper/critique", ['{"findings": [{"category": "academic", "sev', CRITIQUE_JSON]);
    const outcome = await service.reviewFullPaper({ projectId, runId: "run5", sectionFindings: [] });
    expect(outcome.critiqueParseFailed).toBe(false);
    expect(outcome.critiqueRetried).toBe(true);
    expect(outcome.findings).toHaveLength(1);
    // 重试 prompt 追加最小格式修复指令，其余内容与首次一致（同输入重跑语义）
    expect(runtime.calls[2]!.task).toContain("上一次输出无法解析为 JSON");
    expect(runtime.calls[2]!.task).toContain("EXTRACTION");
  });

  it("A1 回归：telemetry 不跨 run 污染——重跑正常链路回到 calls=2", async () => {
    runtime.calls.length = 0;
    runtime.outputsSeq.clear();
    runtime.outputs.set("review/fullpaper/extract", EXTRACTION_JSON);
    runtime.outputs.set("review/fullpaper/critique", CRITIQUE_JSON);
    const outcome = await service.reviewFullPaper({ projectId, runId: "run6", sectionFindings: [] });
    expect(outcome.telemetry.calls).toBe(2);
    expect(outcome.extractRetried).toBe(false);
    expect(outcome.critiqueRetried).toBe(false);
    expect(runtime.calls.map((c) => c.contextScope)).toEqual(["review/fullpaper/extract", "review/fullpaper/critique"]);
  });

  it("A1 回归：runAgent 抛错（取消/超时）原样上抛，不被重试逻辑吞掉", async () => {
    runtime.calls.length = 0;
    runtime.outputsSeq.clear();
    runtime.throwOn.set("review/fullpaper/critique", new Error("WORKFLOW_CANCELLED: 任务已取消"));
    await expect(
      service.reviewFullPaper({ projectId, runId: "run7", sectionFindings: [] }),
    ).rejects.toThrow("WORKFLOW_CANCELLED");
    expect(runtime.calls.map((c) => c.contextScope)).toEqual([
      "review/fullpaper/extract",
      "review/fullpaper/critique",
    ]);
    runtime.throwOn.clear();
  });
});
