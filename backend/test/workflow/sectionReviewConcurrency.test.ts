/**
 * Section Review 并发化专项测试（Fake Runtime 全链路，走真实 orchestrator →
 * reviewSectionsStage → SectionReviewScheduler → mapWithConcurrency 路径）：
 *
 * 1. backpressure：concurrency=3、8 节 → maxActive <= 3（runtime 侧与 telemetry 双口径）
 * 2. 独立会话：每节 contextScope 唯一 → 派生 sessionKey 互不相同
 * 3. deterministic order：完成顺序故意乱序，最终 findings 仍按论文顺序
 * 4. per-section persistence：journal 一节一文件；并发完成无丢失/重复/损坏
 * 5. cancellation：queued 不再 start、active 全部收到 cancel、已完成节保留
 * 6. retry/429：节内重试成功、最终失败节隔离、permit 不泄漏、队列不卡死
 * 7. journal 复用：同一 runId 重放 → 零模型调用
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import type { PdfParser, RawPdfExtraction } from "../../src/paper/PdfParser.js";
import { SectionReviewScheduler } from "../../src/paper/SectionReviewScheduler.js";
import { SECTION_REVIEW_INSTRUCTION } from "../../src/paper/SectionReviewService.js";
import { AgentRunFailedError } from "../../src/errors.js";
import { resolveSessionKey } from "../../src/runtime/sessionKey.js";
import type { AgentRuntime, AgentTask, RunAgentInput } from "../../src/runtime/types.js";
import { startTestStack, type TestStack } from "../helpers/testStack.js";

const SECTION_COUNT = 8;

/** 每节一条 finding（区分章节，校验顺序用） */
function sectionFindingsJson(section: string): string {
  return JSON.stringify({
    findings: [
      {
        category: "academic",
        severity: "major",
        message: `${section} 的审阅发现`,
      },
    ],
  });
}

interface ConcurrencyRuntimeScript {
  /** scope → 首次失败次数（之后成功）；错误消息可注入 429 文本 */
  failFirst?: Map<string, { times: number; message: string }>;
  /** scope → 永远失败 */
  alwaysFail?: Set<string>;
  /** scope → 模拟延迟（毫秒） */
  delayMs?: Map<string, number>;
  /** scope → 挂起直到 signal abort（cancel 测试用） */
  hangScopes?: Set<string>;
}

interface ConcurrencyRuntimeState {
  calls: Array<{ scope: string; sessionKey: string }>;
  /** runAgent 开始未结束的 scope 快照（任意时刻无重复 = 无同会话并发） */
  concurrentScopeSnapshots: string[][];
  maxActive: number;
  active: number;
  completionOrder: string[];
  abortedScopes: string[];
}

/** 可脚本化并发 fake Runtime：跟踪 active/并发快照，signal abort → cancelled 终态 */
function makeConcurrencyRuntime(script: ConcurrencyRuntimeScript): {
  runtime: AgentRuntime;
  state: ConcurrencyRuntimeState;
} {
  const state: ConcurrencyRuntimeState = {
    calls: [],
    concurrentScopeSnapshots: [],
    maxActive: 0,
    active: 0,
    completionOrder: [],
    abortedScopes: [],
  };
  const failedCounts = new Map<string, number>();
  const activeScopes = new Set<string>();

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
      const scope = input.contextScope ?? "";
      const sessionKey = resolveSessionKey(input) ?? "adhoc";
      state.calls.push({ scope, sessionKey });
      state.active += 1;
      activeScopes.add(scope);
      state.maxActive = Math.max(state.maxActive, state.active);
      state.concurrentScopeSnapshots.push([...activeScopes]);
      const settle = (task: AgentTask) => {
        state.active -= 1;
        activeScopes.delete(scope);
        state.completionOrder.push(scope);
        return task;
      };
      const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

      // 挂起模式：唯一出口是 signal abort（协作式取消，与真实 adapter 语义一致）
      if (script.hangScopes?.has(scope)) {
        return await new Promise<AgentTask>((resolve) => {
          const onAbort = () => {
            state.abortedScopes.push(scope);
            const now = new Date().toISOString();
            resolve(
              settle({
                taskId: `t-${state.calls.length}`,
                agentId: input.agentId,
                status: "cancelled",
                createdAt: now,
                updatedAt: now,
                error: "任务已取消（session.abort）",
              }),
            );
          };
          if (input.signal?.aborted) {
            onAbort();
            return;
          }
          input.signal?.addEventListener("abort", onAbort, { once: true });
        });
      }

      const delay = script.delayMs?.get(scope) ?? 0;
      if (delay > 0) {
        await sleep(delay);
      }
      const failSpec = script.failFirst?.get(scope);
      const failedSoFar = failedCounts.get(scope) ?? 0;
      const shouldFail =
        script.alwaysFail?.has(scope) === true ||
        (failSpec !== undefined && failedSoFar < failSpec.times);
      if (shouldFail) {
        failedCounts.set(scope, failedSoFar + 1);
        const message = failSpec?.message ?? "503 provider unavailable";
        // 失败也要走 settle（活跃计数与并发快照必须对称释放）
        const error = new AgentRunFailedError(message);
        state.active -= 1;
        activeScopes.delete(scope);
        state.completionOrder.push(scope);
        throw error;
      }
      const now = new Date().toISOString();
      const output = scope.startsWith("review/section/")
        ? sectionFindingsJson(scope.replace("review/section/", ""))
        : scope.startsWith("citation/semantic/")
          ? JSON.stringify({ verdict: "SUPPORTED", confidence: "high", reason: "一致" })
          : "摘要：本节介绍方法。";
      return settle({
        taskId: `t-${state.calls.length}`,
        agentId: input.agentId,
        status: "completed",
        createdAt: now,
        updatedAt: now,
        output,
      });
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
  return { runtime, state };
}

/** 8 节论文（每节文本 ≥ 80 字符，2 条参考文献） */
const fakeParser: PdfParser = {
  id: "fake",
  async checkAvailability() {
    return { available: true as const, command: "fake", args: [], pythonVersion: "0", pymupdfVersion: "0" };
  },
  async parseFile(): Promise<RawPdfExtraction> {
    const toc: Array<[number, string, number]> = [];
    const blocks: Array<{ page: number; text: string }> = [];
    const titles = ["Introduction", "Related Work", "Method", "Experiments", "Results", "Discussion", "Threats", "Conclusion"];
    for (let index = 0; index < SECTION_COUNT; index += 1) {
      const sectionNo = index + 1;
      toc.push([1, titles[index]!, sectionNo]);
      blocks.push({
        page: sectionNo,
        text: `Section ${sectionNo} (${titles[index]}) content with detail [${(index % 2) + 1}]. ` + `s${sectionNo}`.repeat(90),
      });
    }
    toc.push([1, "References", SECTION_COUNT + 1]);
    blocks.push({ page: SECTION_COUNT + 1, text: "[1] Alpha et al. First Paper. 2020." });
    blocks.push({ page: SECTION_COUNT + 1, text: "[2] Beta et al. Second Paper. 2021." });
    return {
      ok: true,
      parser: { id: "fake", version: "1" },
      pageCount: SECTION_COUNT + 1,
      title: "Concurrency Test Paper",
      abstract: "We test concurrent section review.",
      toc,
      blocks,
      totalChars: 6000,
      notes: [],
    };
  },
};

const cleanups: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const cleanup of cleanups) {
    await cleanup();
  }
});

/** 轮询 run 至终态 */
async function waitForRun(
  stack: TestStack,
  runId: string,
  budgetMs = 30_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + budgetMs;
  for (;;) {
    const run = (await stack.request("GET", `/api/runs/${runId}`)).body["run"] as Record<string, unknown>;
    if (["completed", "failed", "cancelled"].includes(String(run["status"]))) {
      return run;
    }
    if (Date.now() > deadline) {
      throw new Error(`run ${runId} 超时未终态：${String(run["status"])}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

async function importPaper(stack: TestStack): Promise<string> {
  const created = await stack.request("POST", "/api/projects/import-pdf", {
    fileName: "concurrency.pdf",
    contentBase64: Buffer.from("%PDF-1.5\nconcurrency-test").toString("base64"),
    goal: "review_only",
  });
  expect(created.status).toBe(201);
  return (created.body["project"] as Record<string, unknown>)["id"] as string;
}

function sectionIds(): string[] {
  return Array.from({ length: SECTION_COUNT }, (_, index) => `SEC${String(index + 1).padStart(2, "0")}`);
}

/** contextScope 用小写 sectionId（ReviewContextBuilder 规则） */
function sectionScopes(): string[] {
  return sectionIds().map((id) => `review/section/${id.toLowerCase()}`);
}

describe("review.sections 有界并发（backpressure / 会话隔离 / 顺序 / 持久化）", () => {
  it(
    "concurrency=3、8 节乱序完成：maxActive<=3、sessionKey 互异、findings 按论文顺序、journal 一节一文件",
    { timeout: 60_000 },
    async () => {
      const { runtime, state } = makeConcurrencyRuntime({
        // 延迟递减：sec08 最先完成、sec01 最后 → 完成顺序与论文顺序显著不同
        delayMs: new Map(sectionScopes().map((scope, index) => [scope, 80 - index * 9])),
      });
      const stack = await startTestStack(runtime, {
        paperParser: fakeParser,
        review: { reviewConcurrency: 3, sectionRetryBackoffMs: [0, 0] },
        registerCleanup: (cleanup) => cleanups.push(cleanup),
      });
      const projectId = await importPaper(stack);
      const started = await stack.request("POST", `/api/projects/${projectId}/workflows`, {
        kind: "existing_paper_review",
      });
      expect(started.status).toBe(202);
      const runId = started.body["runId"] as string;
      const run = await waitForRun(stack, runId);
      expect(run["status"]).toBe("completed");

      // 1) backpressure：runtime 侧与 stage telemetry 双口径
      expect(state.maxActive).toBeLessThanOrEqual(3);
      expect(state.maxActive).toBe(3);
      const stageResult = (run["stageResults"] as Record<string, Record<string, unknown>>)["review.sections"]!;
      const telemetry = stageResult["concurrencyTelemetry"] as Record<string, unknown>;
      expect(telemetry["maxObservedConcurrency"]).toBe(3);
      expect(telemetry["reviewConcurrency"]).toBe(3);
      expect(telemetry["sectionsCompleted"]).toBe(SECTION_COUNT);
      expect(telemetry["sectionsFailed"]).toBe(0);
      expect(Number(telemetry["reviewSectionsWallMs"])).toBeGreaterThan(0);

      // 2) 完成顺序确实乱序（否则顺序断言没有区分度）
      const completionSections = state.completionOrder
        .filter((scope) => scope.startsWith("review/section/"))
        .map((scope) => scope.replace("review/section/", ""));
      expect(completionSections[0]).not.toBe("sec01");
      // 任意时刻无重复 scope 在途（同会话并发不存在）
      for (const snapshot of state.concurrentScopeSnapshots) {
        expect(new Set(snapshot).size).toBe(snapshot.length);
      }
      // 每节派生 sessionKey 互异（projectId × agentId × contextScope）
      const reviewKeys = state.calls
        .filter((call) => call.scope.startsWith("review/section/"))
        .map((call) => call.sessionKey);
      expect(new Set(reviewKeys).size).toBe(SECTION_COUNT);

      // 3) 最终 findings 按论文顺序（deterministic output ordering）
      const findings = stageResult["findings"] as Array<Record<string, unknown>>;
      expect(findings.map((finding) => finding["sectionId"])).toEqual(sectionIds());
      expect(stageResult["sectionsReviewed"]).toBe(SECTION_COUNT);

      // 4) journal：一节一文件，内容可解析、无重复
      const journalDir = join(stack.root, projectId, "paper", "review-sections", runId);
      const files = (await readdir(journalDir)).sort();
      expect(files).toHaveLength(SECTION_COUNT);
      expect(new Set(files).size).toBe(SECTION_COUNT);
      for (const file of files) {
        const record = JSON.parse(await readFile(join(journalDir, file), "utf8")) as Record<string, unknown>;
        expect(record["status"]).toBe("completed");
        expect(typeof record["fingerprint"]).toBe("string");
      }

      // 5) 聚合报告完整性：无丢失、findingId 唯一、顺序一致
      const report = JSON.parse(
        await readFile(join(stack.root, projectId, "reviews", "existing-review-r1.json"), "utf8"),
      ) as Record<string, unknown>;
      const reportFindings = report["findings"] as Array<Record<string, unknown>>;
      expect(reportFindings).toHaveLength(SECTION_COUNT);
      const ids = reportFindings.map((finding) => finding["findingId"]);
      expect(new Set(ids).size).toBe(SECTION_COUNT);
      expect(reportFindings.map((finding) => finding["sectionId"])).toEqual(sectionIds());
    },
  );
});

describe("review.sections 取消（queued 停止 + active 中断 + 已完成保留）", () => {
  it(
    "3 active 挂起 + 其余 queued：cancel 后 active 全部 abort、queued 不再 start、sec01 结果保留",
    { timeout: 60_000 },
    async () => {
      const hangScopes = new Set(sectionScopes().slice(1));
      const { runtime, state } = makeConcurrencyRuntime({
        hangScopes,
        delayMs: new Map([["review/section/sec01", 30]]),
      });
      const stack = await startTestStack(runtime, {
        paperParser: fakeParser,
        review: { reviewConcurrency: 3, sectionRetryBackoffMs: [0, 0] },
        registerCleanup: (cleanup) => cleanups.push(cleanup),
      });
      const projectId = await importPaper(stack);
      const started = await stack.request("POST", `/api/projects/${projectId}/workflows`, {
        kind: "existing_paper_review",
      });
      const runId = started.body["runId"] as string;

      // 等 sec01 完成（journal 落盘）且 3 个挂起节 active
      const journalFile = join(stack.root, projectId, "paper", "review-sections", runId, "SEC01.json");
      const deadline = Date.now() + 20_000;
      while (Date.now() < deadline) {
        try {
          await readFile(journalFile, "utf8");
          break;
        } catch {
          await new Promise((resolve) => setTimeout(resolve, 10));
        }
      }
      while (state.active < 3 && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(state.active).toBe(3);

      const cancelResponse = await stack.request("POST", `/api/runs/${runId}/cancel`);
      expect(cancelResponse.status).toBe(200);
      const run = await waitForRun(stack, runId);
      expect(run["status"]).toBe("cancelled");
      expect(run["completedStages"]).not.toContain("review.sections");

      // 3 个挂起节全部收到协作式 cancel
      expect(state.abortedScopes).toHaveLength(3);
      // 只 dispatch 了 4 节（首批 3 + sec01 完成后补 1），queued 的 4 节一个都没 start
      const startedSections = state.calls.filter((call) => call.scope.startsWith("review/section/"));
      expect(startedSections).toHaveLength(4);
      // 已完成节的 journal 保留（重启同 runId 恢复时零模型复用）
      const journalDir = join(stack.root, projectId, "paper", "review-sections", runId);
      const files = await readdir(journalDir);
      expect(files).toEqual(["SEC01.json"]);
    },
  );
});

describe("review.sections retry / 429（节内重试、失败隔离、permit 不泄漏）", () => {
  it(
    "sec02 首次 429 后成功；sec04 持续失败 → failedSections 只含 sec04，其余 7 节完成",
    { timeout: 60_000 },
    async () => {
      const { runtime, state } = makeConcurrencyRuntime({
        failFirst: new Map([["review/section/sec02", { times: 1, message: "429 Too Many Requests: rate limit exceeded" }]]),
        alwaysFail: new Set(["review/section/sec04"]),
        delayMs: new Map(sectionScopes().map((scope) => [scope, 10])),
      });
      const stack = await startTestStack(runtime, {
        paperParser: fakeParser,
        review: { reviewConcurrency: 3, sectionRetryBackoffMs: [0, 0] },
        registerCleanup: (cleanup) => cleanups.push(cleanup),
      });
      const projectId = await importPaper(stack);
      const started = await stack.request("POST", `/api/projects/${projectId}/workflows`, {
        kind: "existing_paper_review",
      });
      const runId = started.body["runId"] as string;
      const run = await waitForRun(stack, runId);
      expect(run["status"]).toBe("completed");

      const stageResult = (run["stageResults"] as Record<string, Record<string, unknown>>)["review.sections"]!;
      expect(stageResult["sectionsReviewed"]).toBe(7);
      expect(stageResult["failedSections"]).toEqual(["SEC04"]);
      const telemetry = stageResult["concurrencyTelemetry"] as Record<string, unknown>;
      // sec02 重试 1 次 + sec04 重试 2 次 = 3；429 启发式命中 1 次
      expect(telemetry["sectionsRetried"]).toBe(3);
      expect(telemetry["rateLimitedHint"]).toBe(1);
      expect(telemetry["providerErrors"]).toBe(4);
      // 失败与重试不泄漏 permit：全程 maxActive <= 3，队列没有卡死（8 节全部尝试过）
      expect(state.maxActive).toBeLessThanOrEqual(3);
      const callsPerScope = new Map<string, number>();
      for (const call of state.calls) {
        callsPerScope.set(call.scope, (callsPerScope.get(call.scope) ?? 0) + 1);
      }
      expect(callsPerScope.get("review/section/sec02")).toBe(2);
      expect(callsPerScope.get("review/section/sec04")).toBe(3);

      // 报告如实呈现部分失败（不当成功）
      const report = (await stack.request("GET", `/api/projects/${projectId}/paper-review`)).body["report"] as Record<string, unknown>;
      const review = report["review"] as Record<string, unknown>;
      expect(review["sectionsReviewed"]).toBe(7);
      expect(review["failedSections"]).toBe(1);
    },
  );
});

describe("review.sections journal 复用（同一 runId 重放零模型调用）", () => {
  it(
    "首次跑完 8 节后，同 runId 再跑 scheduler：sectionsReused=8、零新增模型调用、findings 一致",
    { timeout: 60_000 },
    async () => {
      const { runtime, state } = makeConcurrencyRuntime({
        delayMs: new Map(sectionScopes().map((scope) => [scope, 5])),
      });
      const stack = await startTestStack(runtime, {
        paperParser: fakeParser,
        review: { reviewConcurrency: 3, sectionRetryBackoffMs: [0, 0] },
        registerCleanup: (cleanup) => cleanups.push(cleanup),
      });
      const projectId = await importPaper(stack);
      const started = await stack.request("POST", `/api/projects/${projectId}/workflows`, {
        kind: "existing_paper_review",
      });
      const runId = started.body["runId"] as string;
      const run = await waitForRun(stack, runId);
      expect(run["status"]).toBe("completed");
      const firstFindings = ((run["stageResults"] as Record<string, Record<string, unknown>>)["review.sections"]!["findings"]) as unknown[];

      // 同一 runId 重放（模拟 stage 重试 / 崩溃恢复）：jobs 按原 stage 逻辑组装
      const { reviewContext, sectionReview } = stack.stack.workflowServices.paper;
      const store = stack.stack.paperStore;
      const scopes = await reviewContext.listSectionScopes(projectId);
      const callouts = await store.loadCallouts<{ sectionId: string; references: Array<{ referenceId?: string; label: string }> }>(projectId);
      const references = await store.loadReferences<{ referenceId: string; rawText: string }>(projectId);
      const metadataRecords = await stack.stack.workflowServices.paper.citationIntegrity.listMetadataRecords(projectId);
      const statusByReference = new Map(metadataRecords.map((record) => [record.referenceId, record.status]));
      const rawTextByReference = new Map(references.map((entry) => [entry.referenceId, entry.rawText]));
      // 与 stage 完全同构的 jobs（含 charCount 门槛与 metadata status），指纹才能一致
      const jobs = scopes
        .filter((scope) => scope.chunkCount > 0 && scope.charCount >= 80)
        .map((scope) => ({
          sectionId: scope.sectionId,
          contextScope: scope.contextScope,
          citations: callouts
            .filter((callout) => callout.sectionId === scope.sectionId)
            .flatMap((callout) => callout.references)
            .filter((relation) => relation.referenceId !== undefined)
            .map((relation) => ({
              referenceId: relation.referenceId!,
              rawText: rawTextByReference.get(relation.referenceId!) ?? relation.label,
              ...(statusByReference.get(relation.referenceId!) !== undefined
                ? { status: String(statusByReference.get(relation.referenceId!)) }
                : {}),
            })),
        }));
      const callsBefore = state.calls.length;
      const scheduler = new SectionReviewScheduler({
        store,
        reviewContext,
        sectionReview,
        concurrency: 3,
        attempts: 3,
        backoffMs: [0, 0],
        instruction: SECTION_REVIEW_INSTRUCTION,
      });
      const replay = await scheduler.run(jobs, {
        projectId,
        runId,
        signal: new AbortController().signal,
        emitProgress: async () => {},
      });
      expect(state.calls.length).toBe(callsBefore); // 零新增模型调用
      expect(replay.telemetry.sectionsReused).toBe(jobs.length);
      expect(replay.reviewed).toEqual(sectionIds());
      expect(replay.findings).toEqual(firstFindings);
    },
  );
});
