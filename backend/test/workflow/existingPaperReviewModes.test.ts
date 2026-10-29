/**
 * M15.12 — existing_paper_review 运行档位测试（run-request 选项全链路）：
 * 缺省行为零变化（无 review.fullpaper、无 priorityView、per-section 摘要）；
 * paperMapSummaryMode=batched 走批量摘要 scope；
 * globalReviewMode=on 在 review.sections 与 review.aggregate 之间执行全文级 pass，
 * findings 并入同一报告（bySource 分账 + review.fullpaper 概况块）；
 * priorityView=true 输出 top-K 优先视图；
 * HTTP 层非法值 400；同项目二次 run 摘要指纹复用（零摘要调用）。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PdfParser, RawPdfExtraction } from "../../src/paper/PdfParser.js";
import type { AgentRuntime, AgentTask, RunAgentInput } from "../../src/runtime/types.js";
import { startTestStack, type TestStack } from "../helpers/testStack.js";

const SECTION_FINDINGS: Record<string, string> = {
  sec01: JSON.stringify({
    findings: [
      { category: "academic", severity: "major", message: "引言声称的统一性缺少支撑实验" },
      { category: "style", severity: "minor", message: "术语大小写不一致" },
    ],
  }),
  sec02: JSON.stringify({
    findings: [{ category: "academic", severity: "critical", message: "方法缺少消融对照" }],
  }),
  sec03: JSON.stringify({ findings: [] }),
};

const FULLPAPER_EXTRACTION = JSON.stringify({
  research_goal: "统一图结构学习",
  task_definition: "graph classification",
  claimed_contributions: ["跨域泛化"],
  method_modules: [{ name: "GFM", claimed_mechanism: "结构增强", sectionId: "SEC02" }],
  key_claims: [{ claim: "跨域泛化", where: "摘要", sectionId: "SEC01" }],
  evidence_map: [{ claim: "跨域泛化", evidence: "三数据集", sectionId: "SEC03" }],
});

const FULLPAPER_CRITIQUE = JSON.stringify({
  findings: [
    {
      category: "academic",
      severity: "critical",
      sectionId: "SEC01",
      claimText: "enables unified graph structure learning",
      message: "研究目标（通用 GFM）与实验（仅 graph 分类）错位，目标-任务不一致。",
      evidenceGap: "缺少更广任务与数据集",
      confidence: "high",
      suggestion: "收窄声称或扩充实验",
    },
  ],
});

interface RecordedCall {
  contextScope: string;
  task: string;
}

function makeModesRuntime(): { runtime: AgentRuntime; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const runtime: AgentRuntime = {
    provider: "pi",
    healthCheck: async () => ({
      ok: true,
      provider: "pi",
      status: "healthy",
      detail: "ok",
      latencyMs: 1,
      checkedAt: new Date().toISOString(),
    }),
    async runAgent(input: RunAgentInput): Promise<AgentTask> {
      calls.push({ contextScope: input.contextScope ?? "", task: input.task });
      const scope = input.contextScope ?? "";
      let output = "摘要：本节介绍方法。";
      if (scope.startsWith("review/summary-batch/")) {
        const ids = [...input.task.matchAll(/【章节 (SEC\d+)】/g)].map((m) => m[1]!);
        output = JSON.stringify({ summaries: ids.map((id) => ({ sectionId: id, summary: `${id} 批量摘要。` })) });
      } else if (scope.startsWith("review/section/")) {
        const section = scope.replace("review/section/", "");
        output = SECTION_FINDINGS[section] ?? JSON.stringify({ findings: [] });
      } else if (scope === "review/fullpaper/extract") {
        output = FULLPAPER_EXTRACTION;
      } else if (scope === "review/fullpaper/critique") {
        output = FULLPAPER_CRITIQUE;
      }
      const now = new Date().toISOString();
      return { taskId: `task-${calls.length}`, agentId: input.agentId, status: "completed", createdAt: now, updatedAt: now, output };
    },
    async startAgent(input) {
      const task = await runtime.runAgent(input);
      return {
        taskId: task.taskId,
        sessionKey: "agent:test:test",
        events: async function* () {},
        cancel: async () => {},
        result: async () => task,
      };
    },
    getTask: () => {
      throw new Error("not implemented");
    },
    close: async () => {},
  };
  return { runtime, calls };
}

const fakeParser: PdfParser = {
  id: "fake",
  async checkAvailability() {
    return { available: true as const, command: "fake", args: [], pythonVersion: "0", pymupdfVersion: "0" };
  },
  async parseFile(): Promise<RawPdfExtraction> {
    return {
      ok: true,
      parser: { id: "fake", version: "1" },
      pageCount: 4,
      title: "GraphProp Test Paper",
      abstract: "We propose a graph foundation model.",
      toc: [
        [1, "Introduction", 1],
        [1, "Method", 2],
        [1, "References", 3],
      ] as Array<[number, string, number]>,
      blocks: [
        { page: 1, text: "Intro: enables unified graph structure learning [1]. " + "x".repeat(700) },
        { page: 2, text: "Method: structural module [2]. " + "y".repeat(700) },
        { page: 3, text: "[1] Some Author. Some Paper. 2020." },
        { page: 3, text: "[2] Other Author. Other Paper. 2021." },
      ],
      totalChars: 1600,
      notes: [],
    };
  },
};

async function waitRun(stack: TestStack, runId: string): Promise<Record<string, unknown>> {
  let run: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 200; attempt += 1) {
    run = (await stack.request("GET", `/api/runs/${runId}`)).body["run"] as Record<string, unknown>;
    if (["completed", "failed", "cancelled"].includes(String(run["status"]))) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return run;
}

describe("existing_paper_review 运行档位（M15.12）", () => {
  let stack: TestStack;
  let modes: ReturnType<typeof makeModesRuntime>;
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    modes = makeModesRuntime();
    stack = await startTestStack(modes.runtime, {
      paperParser: fakeParser,
      registerCleanup: (cleanup) => cleanups.push(cleanup),
    });
  });

  afterAll(async () => {
    for (const cleanup of cleanups) {
      await cleanup;
    }
  });

  async function importPaper(name: string): Promise<string> {
    const created = await stack.request("POST", "/api/projects/import-pdf", {
      fileName: `${name}.pdf`,
      contentBase64: Buffer.from(`%PDF-1.5\n${name}`).toString("base64"),
      goal: "review_only",
    });
    expect(created.status).toBe(201);
    return (created.body["project"] as Record<string, unknown>)["id"] as string;
  }

  it("缺省：无 review.fullpaper、无 priorityView、per-section 摘要（旧行为零变化）", { timeout: 60_000 }, async () => {
    const projectId = await importPaper("modes-default");
    modes.calls.length = 0;
    const started = await stack.request("POST", `/api/projects/${projectId}/workflows`, {
      kind: "existing_paper_review",
    });
    expect(started.status).toBe(202);
    const run = await waitRun(stack, started.body["runId"] as string);
    expect(run["status"]).toBe("completed");
    expect(run["completedStages"]).toEqual([
      "paper.ensure",
      "citation.extract",
      "citation.metadata",
      "review.sections",
      "review.aggregate",
    ]);
    // per-section 摘要 scope；无批量、无全文 pass
    const scopes = modes.calls.map((c) => c.contextScope);
    expect(scopes.filter((s) => s.startsWith("review/summary/"))).toHaveLength(3);
    expect(scopes.some((s) => s.startsWith("review/summary-batch/"))).toBe(false);
    expect(scopes.some((s) => s.startsWith("review/fullpaper/"))).toBe(false);
    const report = JSON.parse(
      await readFile(join(stack.root, projectId, "reviews", "existing-review-r1.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(report["priorityView"]).toBeUndefined();
    expect(report["review"]).not.toHaveProperty("fullpaper");
    const bySource = (report["review"] as Record<string, unknown>)["bySource"] as Record<string, number>;
    expect(bySource).toEqual({ "section-review": 3 });
    expect((run["completion"] as Record<string, unknown>)["summary"]).toMatchObject({ globalReviewMode: "off" });
  });

  it("paperMapSummaryMode=batched：批量摘要 scope、调用数 < 章节数；同项目二次 run 摘要零调用", { timeout: 90_000 }, async () => {
    const projectId = await importPaper("modes-batched");
    modes.calls.length = 0;
    const started = await stack.request("POST", `/api/projects/${projectId}/workflows`, {
      kind: "existing_paper_review",
      paperMapSummaryMode: "batched",
    });
    expect(started.status).toBe(202);
    const run = await waitRun(stack, started.body["runId"] as string);
    expect(run["status"]).toBe("completed");
    const batchCalls = modes.calls.filter((c) => c.contextScope.startsWith("review/summary-batch/"));
    expect(batchCalls).toHaveLength(1); // 3 节 → 1 批
    const summaryCalls = modes.calls.filter((c) => c.contextScope.startsWith("review/summary/"));
    expect(summaryCalls).toHaveLength(0);
    const ensure = (run["stageResults"] as Record<string, Record<string, unknown>> | undefined)?.["paper.ensure"];
    expect(ensure).toBeDefined();
    expect(ensure!["paperMapSummaryMode"]).toBe("batched");
    expect((ensure!["paperMapTelemetry"] as Record<string, unknown>)["batches"]).toBe(1);
    // 摘要已按节落盘（批量结果拆分存储）
    const report = JSON.parse(
      await readFile(join(stack.root, projectId, "reviews", "existing-review-r1.json"), "utf8"),
    ) as Record<string, unknown>;
    expect((report["paper"] as Record<string, unknown>)["sections"]).toBe(3);
    // 二次 run：指纹复用 → 零摘要调用（新 run 的 round 计数重置，r1 覆写——
    // 文件名口径与既有语义一致，不在本测试另立口径）
    modes.calls.length = 0;
    const second = await stack.request("POST", `/api/projects/${projectId}/workflows`, {
      kind: "existing_paper_review",
      paperMapSummaryMode: "batched",
    });
    const run2 = await waitRun(stack, second.body["runId"] as string);
    expect(run2["status"]).toBe("completed");
    expect(modes.calls.filter((c) => c.contextScope.includes("summary"))).toHaveLength(0);
    const report2 = JSON.parse(
      await readFile(join(stack.root, projectId, "reviews", "existing-review-r1.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(report2["round"]).toBe(1);
  });

  it("globalReviewMode=on + priorityView=true：全文 pass 在 sections 与 aggregate 之间；findings 并入 + priorityView + bySource 分账", { timeout: 90_000 }, async () => {
    const projectId = await importPaper("modes-global");
    modes.calls.length = 0;
    const started = await stack.request("POST", `/api/projects/${projectId}/workflows`, {
      kind: "existing_paper_review",
      paperMapSummaryMode: "batched",
      globalReviewMode: "on",
      priorityView: true,
    });
    expect(started.status).toBe(202);
    const run = await waitRun(stack, started.body["runId"] as string);
    expect(run["status"]).toBe("completed");
    expect(run["completedStages"]).toEqual([
      "paper.ensure",
      "citation.extract",
      "citation.metadata",
      "review.sections",
      "review.fullpaper",
      "review.aggregate",
    ]);
    // 两次全文 pass 调用；critique prompt 含既有分节 findings 摘要
    const fullpaperCalls = modes.calls.filter((c) => c.contextScope.startsWith("review/fullpaper/"));
    expect(fullpaperCalls.map((c) => c.contextScope)).toEqual(["review/fullpaper/extract", "review/fullpaper/critique"]);
    expect(fullpaperCalls[1]!.task).toContain("方法缺少消融对照");
    const report = JSON.parse(
      await readFile(join(stack.root, projectId, "reviews", "existing-review-r1.json"), "utf8"),
    ) as Record<string, unknown>;
    // findings 合并：3 条分节 + 1 条全文
    const findings = report["findings"] as Array<Record<string, unknown>>;
    expect(findings).toHaveLength(4);
    const fullpaperFinding = findings.find((f) => f["source"] === "fullpaper-review");
    expect(fullpaperFinding).toMatchObject({
      severity: "critical",
      sectionId: "SEC01",
      confidence: "high",
      evidenceGap: "缺少更广任务与数据集",
      status: "open",
    });
    const review = report["review"] as Record<string, unknown>;
    expect(review["bySource"]).toEqual({ "section-review": 3, "fullpaper-review": 1 });
    const fullpaperBlock = review["fullpaper"] as Record<string, unknown>;
    expect(fullpaperBlock["findingsTotal"]).toBe(1);
    expect(fullpaperBlock["critiqueParseFailed"]).toBe(false);
    // priorityView：top-K 视图存在；serious/meta 标记正确
    const priorityView = report["priorityView"] as Record<string, unknown>;
    const items = priorityView["items"] as Array<Record<string, unknown>>;
    expect(items).toHaveLength(4);
    expect(items[0]).toMatchObject({ severity: "critical", serious: true });
    expect(items.filter((i) => i["meta"] === true)).toHaveLength(1);
    expect(priorityView["metaCount"]).toBe(1);
    expect((run["completion"] as Record<string, unknown>)["summary"]).toMatchObject({ globalReviewMode: "on" });
  });

  it("HTTP 层非法选项值 → 400（不改写、不静默）", async () => {
    const projectId = await importPaper("modes-invalid");
    const bad1 = await stack.request("POST", `/api/projects/${projectId}/workflows`, {
      kind: "existing_paper_review",
      paperMapSummaryMode: "turbo",
    });
    expect(bad1.status).toBe(400);
    const bad2 = await stack.request("POST", `/api/projects/${projectId}/workflows`, {
      kind: "existing_paper_review",
      globalReviewMode: "maybe",
    });
    expect(bad2.status).toBe(400);
    const bad3 = await stack.request("POST", `/api/projects/${projectId}/workflows`, {
      kind: "existing_paper_review",
      priorityView: "yes",
    });
    expect(bad3.status).toBe(400);
  });
});
