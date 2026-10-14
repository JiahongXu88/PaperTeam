/**
 * M14.1a P0-2 集成：长文档 Chapter-Level Review + Coverage Ledger（真实 review.run stage）。
 *
 * 场景基线（cd2b92f 上的缺陷，本文件即其回归）：
 *  - buildManuscriptDigest：files.sections.slice(0, 24) 静默丢弃第 25 个文件起，
 *    每节 3600 / 总 60k 截断——10 章 × 9k（90k）文档约 2/3 正文从未进入
 *    Review，而 gate 照常出全文性分数与 PASS；
 *  - ReviewSummary 无任何覆盖字段；跨章问题无双位置。
 */
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startTestStack, scriptedIdeaRuntime } from "../helpers/testStack.js";
import { createExistingPaperDefinition } from "../../src/workflow/definitions.js";
import type { StageRunContext } from "../../src/workflow/types.js";
import { DEFAULT_QUALITY_THRESHOLDS, evaluateQualityGate } from "../../src/quality/gates.js";
import type { ReviewSummary } from "../../src/review/ReviewAggregator.js";
import type { EvidenceStats } from "../../src/evidence/EvidenceStore.js";
import { chapterBody } from "../review/logicalSpan.test.js";

const CHAPTERS = 10;
const CHAPTER_CHARS = 9_000;

function chapterFile(index: number): { file: string; content: string; tail: string } {
  const content = `\\section{Chapter ${index}}\n` + chapterBody(CHAPTER_CHARS, `ch${index}`);
  // 末尾 40 字符必然落在该章最后一个单元内（单元边界不会切掉章节末尾）
  return { file: `sections/ch${index}.tex`, content, tail: content.slice(-40) };
}
const chapters = Array.from({ length: CHAPTERS }, (_, index) => chapterFile(index + 1));

const cleanEvidence: EvidenceStats = {
  total: 0,
  byStatus: { unverified: 0, verified: 0, plausible: 0, mismatch: 0, unverifiable: 0, not_found: 0 },
  contradictory: 0,
  skippedLines: 0,
};

type UnitDecision = { output: string } | { fail: true } | undefined;

interface Harness {
  stack: Awaited<ReturnType<typeof startTestStack>>;
  projectId: string;
  unitPrompts: string[];
  crossPrompts: string[];
  controller: AbortController;
  restart: () => void;
  runReview: () => Promise<Record<string, unknown>>;
  summary: (round?: number) => Promise<ReviewSummary | null>;
  journalFiles: (round: number) => Promise<string[]>;
}

async function setup(options: {
  /** 按单元 prompt 决定行为；undefined = 默认成功输出；fail = 3 次尝试都失败 */
  decideUnit?: (prompt: string, callIndex: number, hooks: { abort: () => void }) => UnitDecision;
  scores?: { academicScore: number; riskScore: number };
}): Promise<Harness> {
  const scripted = scriptedIdeaRuntime();
  const unitPrompts: string[] = [];
  const crossPrompts: string[] = [];
  const controller = new AbortController();
  let activeSignal = controller.signal;
  const scores = options.scores ?? { academicScore: 90, riskScore: 10 };
  const runtime = {
    ...scripted.runtime,
    runAgent: async (input: Parameters<typeof scripted.runtime.runAgent>[0]) => {
      const now = new Date().toISOString();
      const scope = input.contextScope ?? "";
      if (scope === "review/academic/unit") {
        const prompt = input.task;
        const heading = /章节：「(.+?)（/.exec(prompt)?.[1] ?? "unknown";
        const unitTag = /第 (\d+)\/(\d+) 单元/.exec(prompt)?.[1] ?? "?";
        const decision = options.decideUnit?.(prompt, unitPrompts.length + 1, { abort: () => controller.abort() });
        if (decision === undefined || "output" in decision) {
          unitPrompts.push(prompt);
        } else {
          throw new Error(`injected unit failure (${heading})`);
        }
        return {
          taskId: `unit-${unitPrompts.length}`, agentId: "reviewer", status: "completed" as const, createdAt: now, updatedAt: now,
          output: decision === undefined ? JSON.stringify({
            summary: `unit ${heading} ok`,
            issues: [{
              category: "academic", severity: "minor", section: heading,
              description: `[${heading} unit ${unitTag}] unit-level observation for traceability`, blocking: false,
            }],
            academicScore: scores.academicScore, riskScore: scores.riskScore,
          }) : decision.output,
          events: [],
        };
      }
      if (scope === "review/academic/consistency") {
        crossPrompts.push(input.task);
        return {
          taskId: "cross", agentId: "reviewer", status: "completed" as const, createdAt: now, updatedAt: now,
          output: JSON.stringify({
            summary: "cross ok",
            issues: [{
              category: "academic", severity: "major", section: "Chapter 3",
              relatedSections: ["Chapter 5"],
              description: "Chapter 3 与 Chapter 5 对同一实验的数值表述不一致（待核验）",
              suggestedAction: "核对两处数值，以实验记录为准", blocking: false,
            }],
          }),
          events: [],
        };
      }
      throw new Error(`未预期的 runtime scope：${scope || "(none)"}`);
    },
  };
  const stack = await startTestStack(runtime, { registerCleanup: () => Promise.resolve() });
  const projectId = (await stack.store.create("Long document review fixture", { language: "en" })).id;
  const services = stack.stack.workflowServices;
  const manuscriptDir = stack.store.manuscriptDir(projectId);
  await mkdir(join(manuscriptDir, "sections"), { recursive: true });
  const inputs = chapters.map((chapter) => `\\input{${chapter.file.replace(/\.tex$/, "")}}`).join("\n");
  await writeFile(join(manuscriptDir, "main.tex"), `\\documentclass{article}\n\\begin{document}\n${inputs}\n\\end{document}\n`);
  for (const chapter of chapters) {
    await writeFile(join(manuscriptDir, chapter.file), chapter.content);
  }
  await writeFile(join(manuscriptDir, "references.bib"), "@article{ref1,title={R1},year={2020}}");
  await services.revisions.commit(projectId, "baseline");
  const definition = createExistingPaperDefinition(services);
  const stage = definition.stages.find((s) => s.id === "review.run")!;
  const makeCtx = () => ({
    projectId, runId: `long-review-${Math.random().toString(36).slice(2, 8)}`, attempt: 1, signal: activeSignal,
    state: { workflowKind: "existing_paper_improvement", stageResults: {}, stageHistory: [], completedStages: [], inputs: {}, request: {} },
    emitProgress: async () => {}, emitDomain: async () => {}, log: () => {},
  } as unknown as StageRunContext);
  return {
    stack, projectId, unitPrompts, crossPrompts, controller,
    /** 模拟进程重启：后续 runReview 使用全新（未中止）signal */
    restart: () => {
      activeSignal = new AbortController().signal;
    },
    runReview: async () => {
      if (!("execute" in stage)) throw new Error("Wrong stage");
      return stage.execute(makeCtx()) as Promise<Record<string, unknown>>;
    },
    summary: async (round = 1) => {
      try {
        return JSON.parse(await readFile(join(stack.store.reviewsDir(projectId), `review-summary-r${round}.json`), "utf8")) as ReviewSummary;
      } catch {
        return null;
      }
    },
    journalFiles: async (round: number) => {
      try {
        return await readdir(join(stack.store.reviewsDir(projectId), "review-units", `r${round}`));
      } catch {
        return [];
      }
    },
  };
}

describe("M14.1a 长文档 Chapter-Level Review（review.run 单元模式）", () => {
  it("10 章 90k 文档：每个单元都被调度、章节尾部进入审查、coverage=100%、分数为加权聚合", async () => {
    const h = await setup({});
    await h.runReview();
    expect(h.unitPrompts).toHaveLength(CHAPTERS * 2);
    for (const chapter of chapters) {
      expect(
        h.unitPrompts.some((prompt) => prompt.includes(chapter.tail)),
        `chapter tail of ${chapter.file} must be reviewed`,
      ).toBe(true);
    }
    expect(h.crossPrompts).toHaveLength(1);
    expect(h.crossPrompts[0]!.length).toBeLessThan(30_000);
    const summary = await h.summary(1);
    expect(summary).not.toBeNull();
    expect(summary!.coverage?.mode).toBe("units");
    expect(summary!.coverage?.complete).toBe(true);
    expect(summary!.coverage?.ratio).toBe(1);
    expect(summary!.coverage?.targetUnits).toBe(CHAPTERS * 2);
    expect(summary!.coverage?.targetChars).toBe(chapters.reduce((sum, chapter) => sum + chapter.content.length, 0));
    expect(summary!.scores.academicScore).toBe(90);
    expect(summary!.scores.styleRisk).toBe(10);
    expect(summary!.issues.filter((issue) => issue.description.includes("unit-level observation"))).toHaveLength(CHAPTERS * 2);
    const cross = summary!.issues.find((issue) => issue.description.includes("待核验"));
    expect(cross?.section).toBe("Chapter 3");
    expect(cross?.relatedSections).toEqual(["Chapter 5"]);
    expect(cross?.blocking).toBe(false);
    expect(await h.journalFiles(1)).toHaveLength(CHAPTERS * 2);
    const coverageArtifact = JSON.parse(await readFile(join(h.stack.store.reviewsDir(h.projectId), "review-coverage-r1.json"), "utf8"));
    expect(coverageArtifact.complete).toBe(true);
  });

  it("失败注入：Chapter 10 的单元全部失败 → 覆盖率如实下降，Quality Gate 拒绝冒充全文 PASS", async () => {
    const h = await setup({
      decideUnit: (prompt) => (/^章节：「Chapter 10」/m.test(prompt) ? { fail: true } : undefined),
    });
    await h.runReview();
    const summary = await h.summary(1);
    expect(summary).not.toBeNull();
    const coverage = summary!.coverage!;
    expect(coverage.complete).toBe(false);
    expect(coverage.failedUnits).toBe(2);
    expect(coverage.completedUnits).toBe(CHAPTERS * 2 - 2);
    const expectedRatio = chapters.slice(0, 9).reduce((sum, chapter) => sum + chapter.content.length, 0) /
      chapters.reduce((sum, chapter) => sum + chapter.content.length, 0);
    expect(coverage.ratio).toBeCloseTo(expectedRatio, 8);
    // 分数照常聚合（只反映已覆盖部分），但 Gate 必须拒绝它冒充全文结论
    expect(summary!.scores.academicScore).toBe(90);
    const gate = evaluateQualityGate({
      review: summary!,
      citation: null,
      evidence: cleanEvidence,
      feasibility: null,
    }, DEFAULT_QUALITY_THRESHOLDS);
    const coverageRule = gate.rules.find((rule) => rule.rule === "review_coverage_complete");
    expect(coverageRule?.passed).toBe(false);
    expect(coverageRule?.detail).toContain("未覆盖正文");
    const academicRule = gate.rules.find((rule) => rule.rule === "academic_score_threshold");
    expect(academicRule?.passed).toBe(false);
    expect(academicRule?.detail).toContain("review coverage 不完整");
    expect(gate.passed).toBe(false);
  });

  it("中断恢复：执行中 abort → 已完成单元 journal 落盘；重跑同轮零调用复用且 finding 不丢", async () => {
    const controllerRef: { current: AbortController | null } = { current: null };
    let callsBeforeAbort = 0;
    const h = await setup({
      decideUnit: (prompt, callIndex, hooks) => {
        void prompt;
        // 只在第一次运行的第 6 个单元触发 abort（重启后的重跑不再触发）
        if (callIndex === 6 && callsBeforeAbort === 0) {
          callsBeforeAbort = callIndex;
          hooks.abort();
          return { fail: true };
        }
        return undefined;
      },
    });
    controllerRef.current = h.controller;
    await expect(h.runReview()).rejects.toThrow();
    const journalAfterCrash = await h.journalFiles(1);
    expect(journalAfterCrash.length).toBeGreaterThanOrEqual(2);
    expect(journalAfterCrash.length).toBeLessThan(CHAPTERS * 2);
    // 重跑（进程重启 = 全新 signal；summary 未落盘 → 同一轮 r1）——已完成单元零模型调用复用
    h.restart();
    const reusedCount = journalAfterCrash.length;
    const result = await h.runReview();
    expect(result).toMatchObject({ round: 1 });
    // 首轮实际执行 5 次 + 重跑 15 次（复用 5 个）= 20；复用失效则为 25
    expect(h.unitPrompts.length).toBe(CHAPTERS * 2);
    expect(journalAfterCrash.length).toBe(5);
    const summary = await h.summary(1);
    expect(summary!.coverage?.complete).toBe(true);
    expect(summary!.coverage?.reusedUnits).toBe(reusedCount);
    // 复用单元的 issue（既往成功审查产物）不丢失
    expect(summary!.issues.filter((issue) => issue.description.includes("unit-level observation"))).toHaveLength(CHAPTERS * 2);
    expect(callsBeforeAbort).toBe(6);
  });

  it("短文档兼容：digest 路径不变（三路 review），coverage 以 digest 模式完整记录", async () => {
    const scripted = scriptedIdeaRuntime();
    const seenScopes: string[] = [];
    const runtime = {
      ...scripted.runtime,
      runAgent: async (input: Parameters<typeof scripted.runtime.runAgent>[0]) => {
        if ((input.contextScope ?? "").startsWith("review/")) seenScopes.push(input.contextScope ?? "");
        return scripted.runtime.runAgent(input);
      },
    };
    const stack = await startTestStack(runtime, { registerCleanup: () => Promise.resolve() });
    const projectId = (await stack.store.create("Short doc digest fixture", { language: "en" })).id;
    const services = stack.stack.workflowServices;
    const manuscriptDir = stack.store.manuscriptDir(projectId);
    await writeFile(join(manuscriptDir, "main.tex"), "\\documentclass{article}\n\\begin{document}\n\\section{Intro}\nShort.\n\\section{Method}\nAlso short.\n\\end{document}\n");
    await services.revisions.commit(projectId, "baseline");
    const definition = createExistingPaperDefinition(services);
    const stage = definition.stages.find((s) => s.id === "review.run")!;
    const ctx = { projectId, runId: "short-review", attempt: 1, signal: new AbortController().signal,
      state: { workflowKind: "existing_paper_improvement", stageResults: {}, stageHistory: [], completedStages: [], inputs: {}, request: {} },
      emitProgress: async () => {}, emitDomain: async () => {}, log: () => {} } as unknown as StageRunContext;
    await (stage as { execute: (c: StageRunContext) => Promise<Record<string, unknown>> }).execute(ctx);
    expect(seenScopes.filter((scope) => scope.startsWith("review/fact") || scope.startsWith("review/academic") || scope.startsWith("review/style"))).toHaveLength(3);
    const summary = JSON.parse(await readFile(join(stack.store.reviewsDir(projectId), "review-summary-r1.json"), "utf8")) as ReviewSummary;
    expect(summary?.coverage?.mode).toBe("digest");
    expect(summary?.coverage?.complete).toBe(true);
  });
});
