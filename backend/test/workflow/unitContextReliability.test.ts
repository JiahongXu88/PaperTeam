/**
 * M14.9.5.2 Reviewer / Quality Gate 长程可靠性——真实 review.run / quality.gate stage + mock runtime（零模型调用）。
 *
 * 故障模式清单（D:\PaperTeamData\M14_9_5_2_ReviewerReliabilityClosure\failure-modes.json）中先以本文件复现、再修复的缺陷：
 *   F1 覆盖率虚增：同轮 journal 里与当前策略不兼容（CACHE_INCOMPATIBLE）的旧完成记录仍被 computeReviewCoverage 计为
 *      完成——重审失败时 coverage 显示 100%，但该单元的 finding 并不在本轮结果里；
 *   F2 同轮 journal 复用的校验弱于跨轮缓存：shared_session 只比策略，不比请求指纹（模型 / Skill / prompt 变化后进程
 *      恢复仍复用旧审查）；
 *   F3 跨章一致性审查失败只写日志：coverage / Gate / 只读视图都看不到「跨章核对未执行」；
 *   F4 isolated_snapshot 的依赖缺口在作者稿件口径下只进 coverage 汇总，Gate 规则表里不可见。
 * 另覆盖：跨项目 / 跨轮会话隔离、B / C 跨轮缓存互不命中。夹具为合成稿件（不含第三方论文原文 / 数值）。
 */
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { startTestStack, scriptedIdeaRuntime } from "../helpers/testStack.js";
import { createExistingPaperDefinition, createIdeaToPaperDefinition } from "../../src/workflow/definitions.js";
import type { StageRunContext } from "../../src/workflow/types.js";
import type { ReviewSummary } from "../../src/review/ReviewAggregator.js";
import type { ReviewUnitRecord } from "../../src/review/coverageLedger.js";
import type { ReviewUnitContextPolicy } from "../../src/review/reviewContextSnapshot.js";
import { evaluateQualityGate } from "../../src/quality/gates.js";
import { chapterBody } from "../review/logicalSpan.test.js";

const TABLE2 = [
  "\\textbf{表 2 不同收入组患病率}",
  "",
  "\\begin{table}[htbp]\\centering",
  "\\begin{tabular}{lll}",
  "收入 & 患病 & 患病率 \\\\",
  "低 & 120 & 24.0 \\\\",
  "高 & 126 & 25.2 \\\\",
  "\\end{tabular}",
  "\\end{table}",
].join("\n");

const FILES = {
  "sections/methods.tex": `\\section{Methods}\n\n${chapterBody(4_200, "met")}`,
  "sections/results.tex": `\\section{Results}\n\n${TABLE2}\n\n${chapterBody(4_200, "res")}`,
  "sections/analysis.tex": `\\section{Analysis}\n\n以经单因素分析后有统计学意义的收入等变量为自变量（见表2），并参照表 9 的敏感性分析。\n\n${chapterBody(4_200, "ana")}`,
};

const gateOf = (review: ReviewSummary) =>
  evaluateQualityGate({ review, citation: null, evidence: { contradictory: 0 }, feasibility: null } as unknown as Parameters<typeof evaluateQualityGate>[0]);

interface Call { task: string; sessionKey?: string; toolPolicy?: string; scope: string; heading: string; projectId?: string }

interface Knobs {
  model: string;
  /** 返回 true = 该单元调用失败（三次尝试都失败即单元 failed） */
  failUnit: (heading: string) => boolean;
  failCross: boolean;
  abortAfterUnitCalls?: number;
}

async function setup(options: { policy?: ReviewUnitContextPolicy; concurrency?: number; published?: boolean } = {}) {
  const scripted = scriptedIdeaRuntime();
  const calls: Call[] = [];
  const knobs: Knobs = { model: "glm/claude-opus-5-5", failUnit: () => false, failCross: false };
  let abort: AbortController | null = null;
  let unitCallsSinceRun = 0;
  const runtime = {
    ...scripted.runtime,
    describeAgentContext: async () => ({ model: knobs.model, skills: ["academic-review@abc123"] }),
    runAgent: async (input: Parameters<typeof scripted.runtime.runAgent>[0]) => {
      const now = new Date().toISOString();
      const scope = input.contextScope ?? "";
      const heading = /章节：「(.+?)」/.exec(input.task)?.[1] ?? "(cross)";
      calls.push({
        task: input.task, scope, heading,
        ...(input.sessionKey !== undefined ? { sessionKey: input.sessionKey } : {}),
        ...(input.toolPolicy !== undefined ? { toolPolicy: input.toolPolicy } : {}),
        ...(input.projectId !== undefined ? { projectId: input.projectId } : {}),
      });
      if (scope === "review/academic/unit") {
        unitCallsSinceRun += 1;
        if (knobs.abortAfterUnitCalls !== undefined && unitCallsSinceRun > knobs.abortAfterUnitCalls) {
          abort?.abort();
          return { taskId: `c${calls.length}`, agentId: "reviewer", status: "cancelled" as const, createdAt: now, updatedAt: now, events: [], error: "cancelled" };
        }
        if (knobs.failUnit(heading)) {
          return { taskId: `f${calls.length}`, agentId: "reviewer", status: "timed_out" as const, createdAt: now, updatedAt: now, events: [], error: "timed_out injected" };
        }
        return {
          taskId: `u${calls.length}`, agentId: "reviewer", status: "completed" as const, createdAt: now, updatedAt: now, events: [],
          metadata: { model: knobs.model, ...(input.sessionKey !== undefined ? { sessionKey: input.sessionKey } : {}) },
          output: JSON.stringify({
            summary: `unit ${heading}`,
            issues: [{ category: "academic", severity: "minor", section: heading, description: `[${heading}] note`, quote: "Paragraph 1: p1", blocking: false }],
            academicScore: 72, riskScore: 20,
          }),
        };
      }
      if (scope === "review/academic/consistency") {
        if (knobs.failCross) {
          return { taskId: `x${calls.length}`, agentId: "reviewer", status: "failed" as const, createdAt: now, updatedAt: now, events: [], error: "provider 503 injected" };
        }
        return { taskId: `x${calls.length}`, agentId: "reviewer", status: "completed" as const, createdAt: now, updatedAt: now, events: [], output: JSON.stringify({ summary: "ok", issues: [] }) };
      }
      throw new Error(`unexpected scope ${scope}`);
    },
  };
  const stack = await startTestStack(runtime, {
    registerCleanup: () => Promise.resolve(),
    review: { ...(options.policy !== undefined ? { unitContextPolicy: options.policy } : {}), reviewConcurrency: options.concurrency ?? 1 },
  });
  const services = stack.stack.workflowServices;
  const newProject = async () => {
    const projectId = (await stack.store.create("Unit context reliability fixture", { language: "zh" })).id;
    const dir = stack.store.manuscriptDir(projectId);
    await mkdir(join(dir, "sections"), { recursive: true });
    for (const [file, content] of Object.entries(FILES)) await writeFile(join(dir, file), content);
    await writeFile(join(dir, "main.tex"), "\\documentclass{article}\n\\begin{document}\n\\input{sections/methods}\n\\input{sections/results}\n\\input{sections/analysis}\n\\end{document}\n");
    await writeFile(join(dir, "references.bib"), "@article{ref1,title={R1},year={2020}}");
    await services.revisions.commit(projectId, "baseline");
    return projectId;
  };
  const projectId = await newProject();
  const definition = options.published === true ? createIdeaToPaperDefinition(services) : createExistingPaperDefinition(services);
  const stageOf = (id: string) => definition.stages.find((entry) => entry.id === id)! as { execute: (c: StageRunContext) => Promise<unknown> };
  const ctxFor = (pid: string, stageResults: Record<string, unknown> = {}) => {
    abort = new AbortController();
    unitCallsSinceRun = 0;
    return { projectId: pid, runId: `rel-${calls.length}`, attempt: 1, signal: abort.signal,
      state: { workflowKind: options.published === true ? "idea_to_paper" : "existing_paper_improvement", stageResults, stageHistory: [], completedStages: [], inputs: {},
        request: options.published === true ? { reviewPurpose: "published_paper_assessment" } : {} },
      emitProgress: async () => {}, emitDomain: async () => {}, log: () => {} } as unknown as StageRunContext;
  };
  const run = (pid = projectId) => stageOf("review.run").execute(ctxFor(pid));
  const reviewsDir = (pid = projectId) => stack.store.reviewsDir(pid);
  const summary = async (round: number, pid = projectId) => JSON.parse(await readFile(join(reviewsDir(pid), `review-summary-r${round}.json`), "utf8")) as ReviewSummary;
  const journal = async (round: number, pid = projectId) => {
    const roundDir = join(reviewsDir(pid), "review-units", `r${round}`);
    return Promise.all((await readdir(roundDir)).map(async (name) => JSON.parse(await readFile(join(roundDir, name), "utf8")) as ReviewUnitRecord));
  };
  const unitCalls = () => calls.filter((call) => call.scope === "review/academic/unit");
  const projectDir = (pid = projectId) => stack.store.projectDir(pid);
  return { calls, unitCalls, run, summary, journal, services, knobs, projectId, newProject, projectDir };
}

describe("M14.9.5.2 F1：CACHE_INCOMPATIBLE 的旧完成记录不得计入覆盖率", () => {
  it("共享会话中途取消 → 切 isolated_snapshot 重跑、该单元重审全部失败：coverage 不完整、failedUnitIds 含该单元", async () => {
    const h = await setup({});
    h.knobs.abortAfterUnitCalls = 1;
    await expect(h.run()).rejects.toThrow();
    const sharedCompleted = (await h.journal(1)).filter((record) => record.status === "completed").map((record) => record.unitId);
    expect(sharedCompleted).toHaveLength(1);
    const victimHeading = (await h.journal(1)).find((record) => record.status === "completed")!.outcome!.summary.replace(/^unit /, "");
    h.knobs.abortAfterUnitCalls = undefined;
    h.services.review.unitContextPolicy = "isolated_snapshot";
    h.knobs.failUnit = (heading) => heading === victimHeading;
    await h.run();
    const r1 = await h.summary(1);
    expect(r1.coverage?.context?.cacheIncompatibleUnitIds).toEqual(sharedCompleted);
    expect(r1.coverage?.failedUnitIds).toContain(sharedCompleted[0]);
    expect(r1.coverage?.complete).toBe(false);
    expect(r1.coverage!.completedUnits).toBe(r1.coverage!.targetUnits - 1);
    // Gate 据此不得给全文 PASS（academic 规则与 coverage 规则都不通过）
    const gate = gateOf(r1);
    expect(gate.rules.find((rule) => rule.rule === "review_coverage_complete")?.passed).toBe(false);
    expect(gate.rules.find((rule) => rule.rule === "academic_score_threshold")?.passed).toBe(false);
  });
});

describe("M14.9.5.2 F2：同轮 journal 复用与跨轮缓存同等强度的请求校验", () => {
  it("shared_session：中途取消后模型配置改变 → 同轮恢复不复用旧审查（重新调用全部单元）", async () => {
    const h = await setup({});
    h.knobs.abortAfterUnitCalls = 1;
    await expect(h.run()).rejects.toThrow();
    expect((await h.journal(1)).filter((record) => record.status === "completed")).toHaveLength(1);
    h.knobs.abortAfterUnitCalls = undefined;
    h.knobs.model = "glm/other-model";
    const before = h.unitCalls().length;
    await h.run();
    const r1 = await h.summary(1);
    expect(h.unitCalls().length - before).toBe(r1.coverage!.targetUnits);
    expect(r1.coverage?.reusedUnits).toBe(0);
  });

  it("shared_session：模型不变时同轮恢复照常复用（行为不回归）", async () => {
    const h = await setup({});
    h.knobs.abortAfterUnitCalls = 1;
    await expect(h.run()).rejects.toThrow();
    h.knobs.abortAfterUnitCalls = undefined;
    const before = h.unitCalls().length;
    await h.run();
    const r1 = await h.summary(1);
    expect(h.unitCalls().length - before).toBe(r1.coverage!.targetUnits - 1);
    expect(r1.coverage?.reusedUnits).toBe(1);
  });

  it("isolated_snapshot：模型改变 → 快照哈希变化 → 同轮 CACHE_INCOMPATIBLE", async () => {
    const h = await setup({ policy: "isolated_snapshot" });
    h.knobs.abortAfterUnitCalls = 1;
    await expect(h.run()).rejects.toThrow();
    h.knobs.abortAfterUnitCalls = undefined;
    h.knobs.model = "glm/other-model";
    await h.run();
    const r1 = await h.summary(1);
    expect(r1.coverage?.context?.cacheIncompatibleUnitIds).toHaveLength(1);
    expect(r1.coverage?.reusedUnits).toBe(0);
  });

  it("isolated_no_dependencies 与 isolated_snapshot 的完成记录跨轮互不命中（即使无依赖单元 prompt 逐字节相同）", async () => {
    const h = await setup({ policy: "isolated_no_dependencies" });
    await h.run();
    h.services.review.unitContextPolicy = "isolated_snapshot";
    const before = h.unitCalls().length;
    await h.run();
    const r2 = await h.summary(2);
    expect(r2.coverage?.incremental?.cachedUnits).toBe(0);
    expect(h.unitCalls().length - before).toBe(r2.coverage!.targetUnits);
  });
});

describe("M14.9.5.2 F3：跨章一致性审查失败如实呈现为未执行", () => {
  it("shared_session 与 isolated_snapshot：coverage.crossChapter=failed；Gate 规则表出现 NOT_EVALUATED 的跨章核对（informational，不改 pass/fail）", async () => {
    for (const policy of [undefined, "isolated_snapshot"] as const) {
      const h = await setup(policy !== undefined ? { policy } : {});
      h.knobs.failCross = true;
      await h.run();
      const r1 = await h.summary(1);
      expect(r1.coverage?.crossChapter?.status).toBe("failed");
      const gate = gateOf(r1);
      const rule = gate.rules.find((entry) => entry.rule === "review_cross_chapter_reported");
      expect(rule?.passed).toBe(true);
      expect(rule?.detail).toContain("NOT_EVALUATED");
    }
  });

  it("跨章审查成功时记 completed；Gate 规则如实写已执行", async () => {
    const h = await setup({ policy: "isolated_snapshot" });
    await h.run();
    const r1 = await h.summary(1);
    expect(r1.coverage?.crossChapter?.status).toBe("completed");
    const gate = gateOf(r1);
    expect(gate.rules.find((entry) => entry.rule === "review_cross_chapter_reported")?.detail).not.toContain("NOT_EVALUATED");
  });
});

describe("M14.9.5.2 F4：依赖缺口在 Gate 规则表中可见（作者稿件口径）", () => {
  it("isolated_snapshot 有未解析依赖（表 9）：informational 规则逐条列出 NOT_EVALUATED 的跨单元核对；shared_session 标注跨单元可见性不可复现", async () => {
    const c = await setup({ policy: "isolated_snapshot" });
    await c.run();
    const rc = await c.summary(1);
    const gateC = gateOf(rc);
    const ruleC = gateC.rules.find((entry) => entry.rule === "review_unit_context_reported");
    expect(ruleC?.passed).toBe(true);
    expect(ruleC?.detail).toContain("表 9");
    expect(ruleC?.detail).toContain("DEPENDENCY_UNRESOLVED");
    expect(ruleC?.detail).toContain("NOT_EVALUATED");
    const a = await setup({});
    await a.run();
    const gateA = gateOf(await a.summary(1));
    expect(gateA.rules.find((entry) => entry.rule === "review_unit_context_reported")?.detail).toContain("shared_session");
  });
});

describe("M14.9.5.2 会话隔离：跨项目 / 跨轮 / 跨章", () => {
  it("两个内容相同的项目：prompt 逐字节一致，但物理会话 key 全部不同且带各自 projectId；跨章会话同样隔离", async () => {
    const h = await setup({ policy: "isolated_snapshot" });
    await h.run();
    const firstRound = h.unitCalls().map((call) => call.task).sort();
    const second = await h.newProject();
    const before = h.unitCalls().length;
    await h.run(second);
    const secondRound = h.unitCalls().slice(before).map((call) => call.task).sort();
    expect(secondRound).toEqual(firstRound);
    await h.run(); // 第一个项目的第 2 轮（跨轮缓存命中单元不调用；跨章恒为新会话）
    const keys = h.calls.map((call) => call.sessionKey);
    expect(keys.every((key) => key !== undefined)).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
    for (const call of h.calls) expect(call.sessionKey).toContain(`paperteam-${call.projectId}--`);
    expect(h.calls.every((call) => call.toolPolicy === "sealed")).toBe(true);
    const crossCalls = h.calls.filter((call) => call.scope === "review/academic/consistency");
    expect(crossCalls.length).toBe(3);
  });
});

describe("M14.9.5.2 只读口径的依赖来源标注不断言未知来源是 PDF 转写", () => {
  it("没有送审前保真报告 → SOURCE_UNKNOWN（不写「PDF 转写投影」）；有保真报告但无人工 QA → SOURCE_UNVERIFIED（措辞不变）", async () => {
    const h = await setup({ policy: "isolated_snapshot", published: true });
    await h.run();
    const withDeps = h.unitCalls().filter((call) => call.task.includes("--- [D"));
    expect(withDeps.length).toBeGreaterThan(0);
    for (const call of withDeps) {
      expect(call.task).toContain("SOURCE_UNKNOWN（第三方论文输入，来源与转写方式未记录");
      expect(call.task).not.toContain("PDF 转写投影");
    }
    expect((await h.summary(1)).coverage?.context?.sourceVerification).toBe("SOURCE_UNKNOWN");
    const second = await h.newProject();
    await mkdir(join(h.projectDir(second), "artifacts"), { recursive: true });
    await writeFile(join(h.projectDir(second), "artifacts", "input-fidelity-report.json"), JSON.stringify({ schema: "paperteam.input-fidelity.report/v1", status: "REQUIRES_HUMAN_QA" }));
    const before = h.unitCalls().length;
    await h.run(second);
    const projected = h.unitCalls().slice(before).filter((call) => call.task.includes("--- [D"));
    expect(projected.length).toBeGreaterThan(0);
    for (const call of projected) expect(call.task).toContain("SOURCE_UNVERIFIED（PDF 转写投影");
    expect((await h.summary(1, second)).coverage?.context?.sourceVerification).toBe("SOURCE_UNVERIFIED");
  });
});
