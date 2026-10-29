/**
 * M15.13 A2 — sectionReviewMode=batched-small 分节调用分配测试：
 *
 * 1. 缺省（per-section）：所有章节 scope = review/section/<id>，无 batch scope（旧行为零变化）
 * 2. batched-small：大节独占调用、相邻小节合并批（scope review/section-batch/<ids>）；
 *    调用数 < 章节数；stage 结果登记 sectionReviewMode/reviewCalls/batchGroups
 * 3. 批式 finding 的 sectionId 锚校验：批外/缺失 → dropped（解析层单测 + e2e 透传）
 * 4. 批式 journal：批 scope 一单元一文件；同 run 重放零模型调用
 * 5. HTTP 层非法 sectionReviewMode → 400
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PdfParser, RawPdfExtraction } from "../../src/paper/PdfParser.js";
import { parseBatchedSectionFindingsOutput } from "../../src/paper/SectionReviewService.js";
import type { AgentRuntime, AgentTask, RunAgentInput } from "../../src/runtime/types.js";
import { startTestStack, type TestStack } from "../helpers/testStack.js";

interface RecordedCall {
  contextScope: string;
  task: string;
}

/**
 * 批式输出：从 prompt 的【当前章节：SECXX ...】头解析批内章节，逐节回一条 finding
 * （sectionId 锚定），其中 SEC07 故意输出批外 sectionId（SEC99）用于锚校验断言。
 */
function batchedOutputForTask(task: string): string {
  const ids = [...task.matchAll(/【当前章节：(SEC\d+)/g)].map((m) => m[1]!);
  const findings = ids.map((id) => ({
    sectionId: id === "SEC07" ? "SEC99" : id,
    category: "academic",
    severity: "major",
    message: `${id} 的批式审阅发现`,
  }));
  return JSON.stringify({ findings });
}

function makeBatchRuntime(): { runtime: AgentRuntime; calls: RecordedCall[] } {
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
      } else if (scope.startsWith("review/section-batch/")) {
        output = batchedOutputForTask(input.task);
      } else if (scope.startsWith("review/section/")) {
        const section = scope.replace("review/section/", "").toUpperCase();
        output = JSON.stringify({
          findings: [{ category: "academic", severity: "major", message: `${section} 的单节审阅发现` }],
        });
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

/**
 * 8 节论文：SEC01/SEC04 大节（>2000 字符），其余 6 节小节（~500 字符）。
 * 期望分组：[SEC01] / [SEC02+SEC03] / [SEC04] / [SEC05..SEC08]（4 节一批）→ 4 次调用。
 */
const LARGE = 2600;
const SMALL = 500;
const SECTIONS: Array<{ title: string; size: number }> = [
  { title: "Introduction", size: LARGE },
  { title: "Preliminaries", size: SMALL },
  { title: "Definitions", size: SMALL },
  { title: "Method", size: LARGE },
  { title: "Setup", size: SMALL },
  { title: "Ablation", size: SMALL },
  { title: "Broader Impact", size: SMALL },
  { title: "Conclusion", size: SMALL },
];

const fakeParser: PdfParser = {
  id: "fake",
  async checkAvailability() {
    return { available: true as const, command: "fake", args: [], pythonVersion: "0", pymupdfVersion: "0" };
  },
  async parseFile(): Promise<RawPdfExtraction> {
    const toc: Array<[number, string, number]> = [];
    const blocks: Array<{ page: number; text: string }> = [];
    SECTIONS.forEach((section, index) => {
      const page = index + 1;
      toc.push([1, section.title, page]);
      blocks.push({ page, text: `${section.title} content. ` + "z".repeat(section.size) });
    });
    toc.push([1, "References", SECTIONS.length + 1]);
    blocks.push({ page: SECTIONS.length + 1, text: "[1] Alpha et al. First Paper. 2020." });
    blocks.push({ page: SECTIONS.length + 1, text: "[2] Beta et al. Second Paper. 2021." });
    return {
      ok: true,
      parser: { id: "fake", version: "1" },
      pageCount: SECTIONS.length + 1,
      title: "Batched Section Test Paper",
      abstract: "We test batched small-section review.",
      toc,
      blocks,
      totalChars: 3 * LARGE + 6 * SMALL,
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

describe("parseBatchedSectionFindingsOutput（纯函数）", () => {
  const valid = new Set(["SEC02", "SEC03"]);
  it("合法 sectionId（含小写归一）通过；批外/缺失/非法条目 dropped", () => {
    const raw = JSON.stringify({
      findings: [
        { sectionId: "SEC02", category: "academic", severity: "major", message: "A" },
        { sectionId: "sec03", category: "fact", severity: "minor", message: "B" },
        { sectionId: "SEC99", category: "academic", severity: "critical", message: "批外" },
        { category: "academic", severity: "minor", message: "缺 sectionId" },
        { sectionId: "SEC02", category: "bogus", severity: "major", message: "非法类目" },
      ],
    });
    const result = parseBatchedSectionFindingsOutput(raw, valid);
    expect(result.parseFailed).toBe(false);
    expect(result.findings).toHaveLength(2);
    expect(result.findings[0]).toMatchObject({ sectionId: "SEC02" });
    expect(result.findings[1]).toMatchObject({ sectionId: "SEC03" }); // 小写归一
    expect(result.dropped).toBe(3);
  });
  it("整体非 JSON → parseFailed", () => {
    expect(parseBatchedSectionFindingsOutput("not json", valid).parseFailed).toBe(true);
  });
});

describe("sectionReviewMode=batched-small（M15.13 A2）", () => {
  let stack: TestStack;
  let batch: ReturnType<typeof makeBatchRuntime>;
  const cleanups: Array<() => Promise<void>> = [];

  beforeAll(async () => {
    batch = makeBatchRuntime();
    stack = await startTestStack(batch.runtime, {
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

  it("缺省 per-section：全部 review/section/<id> scope，无 batch scope（旧行为零变化）", { timeout: 60_000 }, async () => {
    const projectId = await importPaper("section-mode-default");
    batch.calls.length = 0;
    const started = await stack.request("POST", `/api/projects/${projectId}/workflows`, {
      kind: "existing_paper_review",
      paperMapSummaryMode: "batched",
    });
    expect(started.status).toBe(202);
    const run = await waitRun(stack, started.body["runId"] as string);
    expect(run["status"]).toBe("completed");
    const sectionScopes = batch.calls.filter((c) => c.contextScope.startsWith("review/section/"));
    expect(sectionScopes).toHaveLength(8);
    expect(batch.calls.some((c) => c.contextScope.startsWith("review/section-batch/"))).toBe(false);
    const stage = (run["stageResults"] as Record<string, Record<string, unknown>>)["review.sections"]!;
    expect(stage["sectionReviewMode"]).toBe("per-section");
    expect(stage["batchGroups"]).toBe(0);
    expect(stage["reviewCalls"]).toBe(8);
  });

  it("batched-small：大节独占、小节合并批；调用数 < 章节数；stage 登记分账；journal 批单元落盘", { timeout: 90_000 }, async () => {
    const projectId = await importPaper("section-mode-batched");
    batch.calls.length = 0;
    const started = await stack.request("POST", `/api/projects/${projectId}/workflows`, {
      kind: "existing_paper_review",
      paperMapSummaryMode: "batched",
      sectionReviewMode: "batched-small",
    });
    expect(started.status).toBe(202);
    const run = await waitRun(stack, started.body["runId"] as string);
    expect(run["status"]).toBe("completed");

    const singleScopes = batch.calls.filter((c) => /^review\/section\/sec\d+$/.test(c.contextScope)).map((c) => c.contextScope);
    const batchScopes = batch.calls.filter((c) => c.contextScope.startsWith("review/section-batch/")).map((c) => c.contextScope);
    // 大节独占：SEC01/SEC04；小节两批：[SEC02,SEC03] 与 [SEC05..SEC08]
    expect(singleScopes.sort()).toEqual(["review/section/sec01", "review/section/sec04"]);
    expect(batchScopes.sort()).toEqual([
      "review/section-batch/sec02-sec03",
      "review/section-batch/sec05-sec06-sec07-sec08",
    ]);
    // 8 节 → 4 次调用（含 References 前的 9 节全文，References 页无 TOC 大节文本量不足不审）
    const stage = (run["stageResults"] as Record<string, Record<string, unknown>>)["review.sections"]!;
    expect(stage["sectionReviewMode"]).toBe("batched-small");
    expect(stage["batchGroups"]).toBe(2);
    expect(stage["reviewCalls"]).toBe(4);
    expect(stage["sectionsReviewed"]).toBe(8);

    // 批式 prompt：含多个【当前章节】块 + 批式指令的 sectionId 要求
    const batchCall = batch.calls.find((c) => c.contextScope === "review/section-batch/sec05-sec06-sec07-sec08")!;
    expect(batchCall.task).toContain("【当前章节：SEC05");
    expect(batchCall.task).toContain("【当前章节：SEC08");
    expect(batchCall.task).toContain("问题所属章节 id（必填");

    // 报告 findings：单节 2 条 + 批1 2 条 + 批2 3 条（SEC07 的批外锚被丢）
    const report = JSON.parse(
      await readFile(join(stack.root, projectId, "reviews", "existing-review-r1.json"), "utf8"),
    ) as Record<string, unknown>;
    const findings = report["findings"] as Array<Record<string, unknown>>;
    expect(findings).toHaveLength(7);
    const sec07 = findings.find((f) => f["sectionId"] === "SEC07");
    expect(sec07).toBeUndefined(); // 批外锚被丢
    const sec05 = findings.find((f) => f["sectionId"] === "SEC05");
    expect(sec05).toMatchObject({ source: "section-review", severity: "major" });
    expect(stage["dropped"]).toBe(1);

    // journal：4 个调用单元一文件（batch- 前缀隔离；ASCII 序大写在前）
    const runId = run["runId"] as string;
    const journalNames = (await readdir(join(stack.root, projectId, "paper", "review-sections", runId))).sort();
    expect(journalNames).toEqual([
      "SEC01.json",
      "SEC04.json",
      "batch-sec02-sec03.json",
      "batch-sec05-sec06-sec07-sec08.json",
    ]);
  });

  it("HTTP 层非法 sectionReviewMode → 400", async () => {
    const projectId = await importPaper("section-mode-invalid");
    const bad = await stack.request("POST", `/api/projects/${projectId}/workflows`, {
      kind: "existing_paper_review",
      sectionReviewMode: "turbo",
    });
    expect(bad.status).toBe(400);
  });
});
