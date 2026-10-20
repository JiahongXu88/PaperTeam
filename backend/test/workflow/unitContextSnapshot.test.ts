/**
 * M14.9.5.1 Reviewer 上下文一致性——真实 review.run stage + mock runtime（零模型调用）。
 *
 * 归因（D:\PaperTeamData\M14_9_5_1_ReviewerContextConsistency\baseline.json）：缺省同一项目的全部长文档单元共用
 * review/academic/unit 会话；某单元能否看到其他单元里的表格，取决于调度顺序以及超时后会话是否被重建
 * （P008 2.2 单元引用的表2：会话延续时检出，超时重建后漏检）。本文件证明 isolated_snapshot 下：
 *   - 单元规范化 prompt / 上下文快照哈希 / 依赖集合与并发度、完成顺序、超时 / 失败重试、取消后恢复无关；
 *   - 每次尝试一个全新 sealed 会话（物理会话不同，送模型的材料逐字节一致）；
 *   - 被引表只改一个数值 → 引用它的单元缓存失效；无关单元合法复用；共享会话记录与隔离快照不互为缓存；
 *   - 依赖原文不计入覆盖率；依赖缺口如实进入 coverage.context / academicScoreBasis；
 *   - 缺省 shared_session 不出现任何新键（会话派生、工具、prompt 不变）。
 * 夹具为合成稿件（不含第三方论文原文 / 数值）。
 */
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { startTestStack, scriptedIdeaRuntime } from "../helpers/testStack.js";
import { createExistingPaperDefinition } from "../../src/workflow/definitions.js";
import type { StageRunContext } from "../../src/workflow/types.js";
import type { ReviewSummary } from "../../src/review/ReviewAggregator.js";
import type { ReviewUnitRecord } from "../../src/review/coverageLedger.js";
import type { ReviewUnitContextPolicy } from "../../src/review/reviewContextSnapshot.js";
import { chapterBody } from "../review/logicalSpan.test.js";

const sha = (text: string) => createHash("sha256").update(text).digest("hex");

const TABLE2 = (high = "126 & 25.2") => [
  "\\textbf{表 2 不同收入组患病率}",
  "",
  "\\begin{table}[htbp]\\centering",
  "\\begin{tabular}{lll}",
  "收入 & 患病 & 患病率 \\\\",
  "低 & 120 & 24.0 \\\\",
  `高 & ${high} \\\\`,
  "\\end{tabular}",
  "\\end{table}",
  "",
  "注：①以人数（患病率/\\%）表示。",
].join("\n");

const FILES = (high?: string) => ({
  "sections/methods.tex": `\\section{Methods}\n\n${chapterBody(4_200, "met")}`,
  "sections/results.tex": `\\section{Results}\n\n${TABLE2(high)}\n\n${chapterBody(4_200, "res")}`,
  "sections/analysis.tex": `\\section{Analysis}\n\n以经单因素分析后有统计学意义的收入等变量为自变量（见表2），并参照表 9 的敏感性分析。\n\n${chapterBody(4_200, "ana")}`,
});

interface Call { task: string; sessionKey?: string; toolPolicy?: string; scope: string; heading: string }

async function setup(options: {
  policy?: ReviewUnitContextPolicy;
  concurrency?: number;
  delay?: (call: Call, index: number) => number;
  fail?: (call: Call, attemptOfHeading: number) => "failed" | "timed_out" | "throw" | null;
  abortAfterUnitCalls?: number;
}) {
  const scripted = scriptedIdeaRuntime();
  const calls: Call[] = [];
  const perHeading = new Map<string, number>();
  let abort: AbortController | null = null;
  let aborted = false;
  const runtime = {
    ...scripted.runtime,
    describeAgentContext: async () => ({ model: "glm/claude-opus-5-5", skills: ["academic-review@abc123"] }),
    runAgent: async (input: Parameters<typeof scripted.runtime.runAgent>[0]) => {
      const now = new Date().toISOString();
      const scope = input.contextScope ?? "";
      const heading = /章节：「(.+?)」/.exec(input.task)?.[1] ?? "(cross)";
      const call: Call = { task: input.task, scope, heading, ...(input.sessionKey !== undefined ? { sessionKey: input.sessionKey } : {}), ...(input.toolPolicy !== undefined ? { toolPolicy: input.toolPolicy } : {}) };
      calls.push(call);
      const ms = options.delay?.(call, calls.length) ?? 0;
      if (ms > 0) await new Promise((resolve) => setTimeout(resolve, ms));
      if (scope === "review/academic/unit") {
        const attempt = (perHeading.get(input.task) ?? 0) + 1;
        perHeading.set(input.task, attempt);
        if (options.abortAfterUnitCalls !== undefined && !aborted && calls.filter((entry) => entry.scope === scope).length > options.abortAfterUnitCalls) {
          aborted = true;
          abort?.abort();
          return { taskId: `c${calls.length}`, agentId: "reviewer", status: "cancelled" as const, createdAt: now, updatedAt: now, events: [], error: "cancelled" };
        }
        const failure = options.fail?.(call, attempt) ?? null;
        if (failure === "throw") throw new Error("provider first-activity watchdog");
        if (failure !== null) {
          return { taskId: `f${calls.length}`, agentId: "reviewer", status: failure, createdAt: now, updatedAt: now, events: [], error: `${failure} injected` };
        }
        return {
          taskId: `u${calls.length}`, agentId: "reviewer", status: "completed" as const, createdAt: now, updatedAt: now, events: [],
          metadata: { model: "glm/claude-opus-5-5", ...(input.sessionKey !== undefined ? { sessionKey: input.sessionKey } : {}) },
          usage: { inputTokens: 10, outputTokens: 5, cacheReadTokens: 0, cacheWriteTokens: 100, totalTokens: 115, assistantTurns: 1 },
          output: JSON.stringify({
            summary: `unit ${heading}`,
            issues: [
              { category: "academic", severity: "minor", section: heading, description: `[${heading}] note`, quote: input.task.includes("见表2") && heading === "Analysis" ? "高 & 126 & 25.2 \\\\" : "Paragraph 1: p1", blocking: false },
            ],
            academicScore: 72, riskScore: 20,
          }),
        };
      }
      if (scope === "review/academic/consistency") {
        return { taskId: `x${calls.length}`, agentId: "reviewer", status: "completed" as const, createdAt: now, updatedAt: now, events: [], output: JSON.stringify({ summary: "ok", issues: [] }) };
      }
      throw new Error(`unexpected scope ${scope}`);
    },
  };
  const stack = await startTestStack(runtime, {
    registerCleanup: () => Promise.resolve(),
    review: { ...(options.policy !== undefined ? { unitContextPolicy: options.policy } : {}), reviewConcurrency: options.concurrency ?? 3 },
  });
  const projectId = (await stack.store.create("Unit context fixture", { language: "zh" })).id;
  const services = stack.stack.workflowServices;
  const dir = stack.store.manuscriptDir(projectId);
  const writeFiles = async (files: Record<string, string>) => {
    await mkdir(join(dir, "sections"), { recursive: true });
    for (const [file, content] of Object.entries(files)) await writeFile(join(dir, file), content);
  };
  await writeFile(join(dir, "main.tex"), "\\documentclass{article}\n\\begin{document}\n\\input{sections/methods}\n\\input{sections/results}\n\\input{sections/analysis}\n\\end{document}\n");
  await writeFiles(FILES());
  await writeFile(join(dir, "references.bib"), "@article{ref1,title={R1},year={2020}}");
  await services.revisions.commit(projectId, "baseline");
  const stage = createExistingPaperDefinition(services).stages.find((entry) => entry.id === "review.run")! as { execute: (c: StageRunContext) => Promise<unknown> };
  const run = async () => {
    abort = new AbortController();
    const ctx = { projectId, runId: `ctx-${calls.length}`, attempt: 1, signal: abort.signal,
      state: { workflowKind: "existing_paper_improvement", stageResults: {}, stageHistory: [], completedStages: [], inputs: {}, request: {} },
      emitProgress: async () => {}, emitDomain: async () => {}, log: () => {} } as unknown as StageRunContext;
    return stage.execute(ctx);
  };
  const reviewsDir = stack.store.reviewsDir(projectId);
  const summary = async (round: number) => JSON.parse(await readFile(join(reviewsDir, `review-summary-r${round}.json`), "utf8")) as ReviewSummary;
  const journal = async (round: number) => {
    const roundDir = join(reviewsDir, "review-units", `r${round}`);
    return Promise.all((await readdir(roundDir)).map(async (name) => JSON.parse(await readFile(join(roundDir, name), "utf8")) as ReviewUnitRecord));
  };
  const unitCalls = () => calls.filter((call) => call.scope === "review/academic/unit");
  return { calls, unitCalls, run, summary, journal, writeFiles, services };
}

/** 每个单元（按 heading + 单元序号）的 prompt 哈希 */
const promptsByUnit = (calls: Call[]) => {
  const out: Record<string, string> = {};
  for (const call of calls) {
    if (call.scope !== "review/academic/unit") continue;
    const key = /章节：「.+?」（文件 .+?；第 \d+\/\d+ 单元）/.exec(call.task)![0];
    out[key] = sha(call.task);
  }
  return out;
};

describe("M14.9.5.1 单元上下文：缺省 shared_session 不变", () => {
  it("不传 sessionKey / toolPolicy；prompt 无上下文条款与依赖块；覆盖率口径不变", async () => {
    const h = await setup({});
    await h.run();
    expect(h.unitCalls().length).toBeGreaterThanOrEqual(3);
    expect(h.calls.every((call) => call.sessionKey === undefined && call.toolPolicy === undefined)).toBe(true);
    expect(h.calls.some((call) => call.task.includes("跨单元依赖") || call.task.includes("本次审查只依据"))).toBe(false);
    const summary = await h.summary(1);
    expect(summary.coverage?.context).toBeUndefined();
    expect(summary.academicScoreBasis?.contextIncompleteUnitIds).toBeUndefined();
  });
});

describe("M14.9.5.1 isolated_snapshot：显式、冻结、可复现的单元输入", () => {
  it("调度无关：并发 1 / 2 / 4 × 随机完成顺序，每单元 prompt 逐字节一致；每次调用独立 sealed 会话", async () => {
    const runs: Array<Record<string, string>> = [];
    const snapshotHashes: Array<Record<string, string>> = [];
    for (const [concurrency, seed] of [[1, 1], [2, 7], [4, 13], [4, 29]] as const) {
      let state = seed;
      const random = () => { state = (state * 1103515245 + 12345) % 2147483648; return state / 2147483648; };
      const h = await setup({ policy: "isolated_snapshot", concurrency, delay: () => Math.floor(random() * 15) });
      await h.run();
      runs.push(promptsByUnit(h.calls));
      snapshotHashes.push(Object.fromEntries((await h.journal(1)).filter((record) => record.contextSnapshot !== undefined)
        .map((record) => [record.unitId, `${record.contextSnapshot!.contextSnapshotHash}|${record.contextSnapshot!.dependencyFingerprint}|${record.contextSnapshot!.dependencies.map((dep) => dep.targetId).join(",")}`])));
      const keys = h.calls.map((call) => call.sessionKey);
      expect(keys.every((key) => key !== undefined)).toBe(true);
      expect(new Set(keys).size).toBe(keys.length);
      expect(h.calls.every((call) => call.toolPolicy === "sealed")).toBe(true);
      const analysis = h.unitCalls().filter((call) => call.heading === "Analysis");
      expect(analysis.length).toBeGreaterThan(0);
      expect(analysis.some((call) => call.task.includes("===== 跨单元依赖") && call.task.includes("高 & 126 & 25.2") && call.task.includes("来源单元「Results」"))).toBe(true);
      expect(h.unitCalls().filter((call) => call.heading === "Results").some((call) => call.task.includes("===== 跨单元依赖"))).toBe(false);
    }
    for (const entry of runs.slice(1)) expect(entry).toEqual(runs[0]);
    for (const entry of snapshotHashes.slice(1)) expect(entry).toEqual(snapshotHashes[0]);
  });

  it("超时与重建：同一单元第 1 次 timed_out、第 2 次 failed（换物理会话）、第 3 次成功——三次 prompt / 快照哈希一致，会话互不相同", async () => {
    const h = await setup({
      policy: "isolated_snapshot",
      fail: (call, attempt) => (call.heading === "Analysis" && call.task.includes("第 1/") ? (attempt === 1 ? "timed_out" : attempt === 2 ? "failed" : null) : null),
    });
    await h.run();
    const analysisFirst = h.unitCalls().filter((call) => call.heading === "Analysis" && call.task.includes("第 1/"));
    expect(analysisFirst).toHaveLength(3);
    expect(new Set(analysisFirst.map((call) => call.task)).size).toBe(1);
    expect(new Set(analysisFirst.map((call) => call.sessionKey)).size).toBe(3);
    const record = (await h.journal(1)).find((entry) => entry.unitId.endsWith("analysis.tex::sec:analysis") || (entry.contextSnapshot?.dependencies.length ?? 0) > 0)!;
    expect(record.status).toBe("completed");
    expect(record.attemptTrace?.map((trace) => trace.status)).toEqual(["failed", "failed", "completed"]);
    expect(new Set(record.attemptTrace!.map((trace) => trace.promptSha256)).size).toBe(1);
    expect(new Set(record.attemptTrace!.map((trace) => trace.contextSnapshotHash)).size).toBe(1);
    expect(new Set(record.attemptTrace!.map((trace) => trace.sessionKey)).size).toBe(3);
    expect(record.attemptTrace![0]!.promptSha256).toBe(sha(analysisFirst[0]!.task));
    expect(record.contextSnapshot!.promptSha256).toBe(record.attemptTrace![0]!.promptSha256);
  });

  it("取消后恢复（journal 落盘 = 跨进程恢复语义）：已完成单元零调用复用，剩余单元 prompt 与不中断运行逐字节一致", async () => {
    const reference = await setup({ policy: "isolated_snapshot", concurrency: 1 });
    await reference.run();
    const expected = promptsByUnit(reference.calls);
    const h = await setup({ policy: "isolated_snapshot", concurrency: 1, abortAfterUnitCalls: 1 });
    await expect(h.run()).rejects.toThrow();
    const beforeResume = h.unitCalls().length;
    const completedBefore = (await h.journal(1)).filter((record) => record.status === "completed").length;
    expect(completedBefore).toBeGreaterThan(0);
    const resumed = await setupResume(h);
    expect(resumed.newUnitCalls).toBe(Object.keys(expected).length - completedBefore);
    const all = promptsByUnit(h.unitCalls());
    expect(Object.keys(all).sort()).toEqual(Object.keys(expected).sort());
    for (const [key, hash] of Object.entries(all)) expect(hash).toBe(expected[key]);
    const summary = await h.summary(1);
    expect(summary.coverage?.complete).toBe(true);
    expect(summary.coverage?.context?.cacheIncompatibleUnitIds).toEqual([]);
  });

  it("缓存：只改被引表一个数值 → 引用它的单元 dependency_changed 重审；无关单元合法复用", async () => {
    const h = await setup({ policy: "isolated_snapshot", concurrency: 1 });
    await h.run();
    const firstCalls = h.unitCalls().length;
    await h.writeFiles({ "sections/results.tex": FILES("126 & 26.2")["sections/results.tex"] });
    await h.run();
    const r2 = await h.summary(2);
    const dispositions = new Map((r2.coverage?.incremental?.dispositions ?? []).map((entry) => [entry.unitId, entry.disposition]));
    const analysisIds = [...dispositions.keys()].filter((id) => id.includes("analysis"));
    const methodsIds = [...dispositions.keys()].filter((id) => id.includes("methods"));
    expect(analysisIds.length).toBeGreaterThan(0);
    const analysisWithDeps = (await h.journal(2)).filter((record) => record.unitId.includes("analysis") && (record.contextSnapshot?.dependencies.length ?? 0) > 0).map((record) => record.unitId);
    expect(analysisWithDeps.length).toBe(1);
    expect(dispositions.get(analysisWithDeps[0]!)).toBe("fresh_invalidated");
    expect(r2.coverage?.incremental?.invalidated.find((entry) => entry.unitId === analysisWithDeps[0])?.reason).toContain("dependency_changed");
    expect(methodsIds.every((id) => dispositions.get(id) === "cached")).toBe(true);
    const secondCalls = h.unitCalls().slice(firstCalls);
    expect(secondCalls.some((call) => call.heading === "Analysis" && call.task.includes("高 & 126 & 26.2"))).toBe(true);
    expect(secondCalls.some((call) => call.heading === "Methods")).toBe(false);
  });

  it("共享会话记录与隔离快照不互为缓存：同轮 journal → CACHE_INCOMPATIBLE 重审；跨轮请求指纹不命中", async () => {
    const shared = await setup({ concurrency: 1, abortAfterUnitCalls: 1 });
    await expect(shared.run()).rejects.toThrow();
    const sharedCompleted = (await shared.journal(1)).filter((record) => record.status === "completed").map((record) => record.unitId);
    expect(sharedCompleted.length).toBeGreaterThan(0);
    shared.services.review.unitContextPolicy = "isolated_snapshot";
    const before = shared.unitCalls().length;
    await shared.run();
    const r1 = await shared.summary(1);
    expect(r1.coverage?.context?.cacheIncompatibleUnitIds.sort()).toEqual([...sharedCompleted].sort());
    expect(shared.unitCalls().slice(before).length).toBe(r1.coverage!.targetUnits);
    // 下一轮仍是隔离快照：跨轮缓存可用（同策略同快照）
    await shared.run();
    expect((await shared.summary(2)).coverage?.incremental?.cachedUnits).toBe(r1.coverage!.targetUnits);
    // 切回共享会话：隔离记录的指纹含 contextPolicy，不命中
    shared.services.review.unitContextPolicy = "shared_session";
    const beforeShared = shared.unitCalls().length;
    await shared.run();
    expect(shared.unitCalls().slice(beforeShared).length).toBe(r1.coverage!.targetUnits);
  });

  it("覆盖率不虚增；依赖缺口（表 9 不存在）如实进入 coverage.context 与 academicScoreBasis；quote 只来自依赖的 finding 被标注", async () => {
    const isolated = await setup({ policy: "isolated_snapshot" });
    await isolated.run();
    const shared = await setup({});
    await shared.run();
    const a = await isolated.summary(1);
    const b = await shared.summary(1);
    expect(a.coverage?.targetChars).toBe(b.coverage?.targetChars);
    expect(a.coverage?.reviewedChars).toBe(a.coverage?.targetChars);
    const context = a.coverage!.context!;
    expect(context.policy).toBe("isolated_snapshot");
    expect(context.sourceVerification).toBe("AUTHOR_SOURCE");
    expect(context.attachedDependencies).toBe(1);
    expect(context.contextIncompleteUnits).toHaveLength(1);
    expect(context.contextIncompleteUnits[0]!.gaps).toMatchObject([{ mention: "表 9", status: "DEPENDENCY_UNRESOLVED" }]);
    expect(a.academicScoreBasis?.contextIncompleteUnitIds).toEqual([context.contextIncompleteUnits[0]!.unitId]);
    expect(context.referenceOnlyQuoteFindings).toBe(1);
    const prompt = isolated.unitCalls().find((call) => call.task.includes("===== 跨单元依赖"))!.task;
    expect(prompt).toContain("- 表 9：DEPENDENCY_UNRESOLVED");
    expect(prompt).toContain("AUTHOR_SOURCE");
    expect(prompt.indexOf("===== 跨单元依赖")).toBeLessThan(prompt.indexOf("===== 单元原文"));
  });

  it("isolated_no_dependencies：无依赖单元的 prompt 与 isolated_snapshot 逐字节相同；有依赖单元只差依赖块与依赖条款", async () => {
    const c = await setup({ policy: "isolated_snapshot", concurrency: 1 });
    await c.run();
    const b = await setup({ policy: "isolated_no_dependencies", concurrency: 1 });
    await b.run();
    const pc = promptsByUnit(c.calls);
    const pb = promptsByUnit(b.calls);
    expect(Object.keys(pb).sort()).toEqual(Object.keys(pc).sort());
    const withDeps = c.unitCalls().filter((call) => call.task.includes("===== 跨单元依赖")).map((call) => /章节：「.+?」（文件 .+?；第 \d+\/\d+ 单元）/.exec(call.task)![0]);
    expect(withDeps).toHaveLength(1);
    for (const key of Object.keys(pc)) {
      if (withDeps.includes(key)) expect(pb[key]).not.toBe(pc[key]);
      else expect(pb[key]).toBe(pc[key]);
    }
    expect(b.calls.some((call) => call.task.includes("跨单元依赖"))).toBe(false);
    const record = (await b.journal(1)).find((entry) => entry.contextSnapshot?.gaps.some((gap) => gap.status === "NOT_ATTACHED_BY_POLICY"));
    expect(record?.contextSnapshot?.contextComplete).toBe(false);
  });
});

/** 同一项目目录上重新执行 stage：journal 从磁盘恢复（与进程重启同一路径；隔离会话 key 带随机段，不依赖内存会话） */
async function setupResume(h: Awaited<ReturnType<typeof setup>>): Promise<{ newUnitCalls: number }> {
  const before = h.unitCalls().length;
  await h.run();
  return { newUnitCalls: h.unitCalls().length - before };
}
