/**
 * M14.1a 阶段 E：三 P0 串联集成——
 * 长文档 Review（P0-2 覆盖账本）→ 尾部 Finding 修订（P0-1 logicalSpan）→
 * 文档变化后 Review 重审（旧 snapshot 不复用）→ 中断恢复（P0-3 journal）。
 */
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startTestStack, scriptedIdeaRuntime } from "../helpers/testStack.js";
import { createExistingPaperDefinition } from "../../src/workflow/definitions.js";
import type { StageRunContext } from "../../src/workflow/types.js";
import type { ReviewSummary } from "../../src/review/ReviewAggregator.js";
import { chapterBody } from "../review/logicalSpan.test.js";

const CHAPTERS = 10;

function chapterFile(index: number): { file: string; content: string; tail: string } {
  const content = `\\section{Chapter ${index}}\n` + chapterBody(9_000, `ch${index}`);
  return { file: `sections/ch${index}.tex`, content, tail: content.slice(-40) };
}
const chapters = Array.from({ length: CHAPTERS }, (_, index) => chapterFile(index + 1));

describe("M14.1a 长文档闭环：review → 修订 → 重审（snapshot 失效）→ journal 恢复", () => {
  it("全链路", async () => {
    const scripted = scriptedIdeaRuntime();
    const unitPrompts: string[] = [];
    const controller = new AbortController();
    let activeSignal = controller.signal;
    let reviewCallCount = 0;
    let revisionCalls = 0;
    const runtime = {
      ...scripted.runtime,
      runAgent: async (input: Parameters<typeof scripted.runtime.runAgent>[0]) => {
        const now = new Date().toISOString();
        const scope = input.contextScope ?? "";
        if (scope === "review/academic/unit") {
          reviewCallCount += 1;
          unitPrompts.push(input.task);
          const heading = /章节：「(.+?)（/.exec(input.task)?.[1] ?? "unknown";
          return {
            taskId: `u-${reviewCallCount}`, agentId: "reviewer", status: "completed" as const, createdAt: now, updatedAt: now,
            output: JSON.stringify({
              summary: "ok",
              issues: [{ category: "academic", severity: "minor", section: heading, description: `[${heading}] observation`, blocking: false }],
              academicScore: 90, riskScore: 10,
            }),
            events: [],
          };
        }
        if (scope === "review/academic/consistency") {
          return {
            taskId: "cross", agentId: "reviewer", status: "completed" as const, createdAt: now, updatedAt: now,
            output: JSON.stringify({ summary: "ok", issues: [] }), events: [],
          };
        }
        if (scope === "writing/revision-proposal") {
          // P0-1：修订提案 = 目标单元全文，仅锚点句加标记（受控局部修改）
          revisionCalls += 1;
          const current = /===== 本章节当前内容 =====\n([\s\S]*?)\n\n===== 针对本章节的问题/.exec(input.task)?.[1] ?? "";
          const anchorMatch = /Revise the sentence containing "(.+?)"/.exec(input.task);
          const anchor = anchorMatch?.[1] ?? "";
          expect(anchor).not.toBe("");
          expect(current.includes(anchor)).toBe(true);
          expect(current.length).toBeLessThanOrEqual(9_000 + 40); // 有界编辑单元，非整章/整文件
          return {
            taskId: `rev-${revisionCalls}`, agentId: "writer", status: "completed" as const, createdAt: now, updatedAt: now,
            output: current.replace(anchor, `[revised] ${anchor}`),
            events: [],
          };
        }
        throw new Error(`未预期的 scope：${scope}`);
      },
    };
    const stack = await startTestStack(runtime, { registerCleanup: () => Promise.resolve() });
    const projectId = (await stack.store.create("M14.1a integration fixture", { language: "en" })).id;
    const services = stack.stack.workflowServices;
    const manuscriptDir = stack.store.manuscriptDir(projectId);
    await mkdir(join(manuscriptDir, "sections"), { recursive: true });
    await writeFile(join(manuscriptDir, "main.tex"), "\\documentclass{article}\n\\begin{document}\n" + chapters.map((c) => `\\input{${c.file.replace(/\.tex$/, "")}}`).join("\n") + "\n\\end{document}\n");
    for (const chapter of chapters) await writeFile(join(manuscriptDir, chapter.file), chapter.content);
    await writeFile(join(manuscriptDir, "references.bib"), "@article{ref1,title={R1},year={2020}}");
    await services.revisions.commit(projectId, "baseline");
    const definition = createExistingPaperDefinition(services);
    const makeCtx = (runId: string) => ({
      projectId, runId, attempt: 1, signal: activeSignal,
      state: { workflowKind: "existing_paper_improvement", stageResults: {}, stageHistory: [], completedStages: [], inputs: {}, request: {} },
      emitProgress: async () => {}, emitDomain: async () => {}, log: () => {},
    } as unknown as StageRunContext);
    const reviewStage = definition.stages.find((s) => s.id === "review.run")!;
    const applyStage = definition.stages.find((s) => s.id === "revision.apply")!;
    const readSummary = async (round: number) =>
      JSON.parse(await readFile(join(stack.store.reviewsDir(projectId), `review-summary-r${round}.json`), "utf8")) as ReviewSummary;

    // 1) P0-2：长文档 review —— 全部 20 个单元调度、coverage 100%
    await (reviewStage as { execute: (c: StageRunContext) => Promise<unknown> }).execute(makeCtx("r1"));
    const round1 = await readSummary(1);
    expect(round1.coverage?.complete).toBe(true);
    expect(round1.coverage?.ratio).toBe(1);
    const snapshot1 = round1.coverage!.snapshotId;
    const reviewedUnitsRound1 = unitPrompts.length;
    expect(reviewedUnitsRound1).toBe(CHAPTERS * 2);
    for (const chapter of chapters) {
      expect(unitPrompts.some((prompt) => prompt.includes(chapter.tail))).toBe(true);
    }

    // 2) P0-1：Chapter 10 尾部锚点的修订 —— 单元级局部 patch，其余逐字节保持
    // 锚点窗口取自最后一段的唯一 token 区（p38/obs 38——含唯一标识，避免与
    // 其他 ref 同号段落的固定句式重复导致 ANCHOR_AMBIGUOUS）
    const tailAnchor = chapters[9]!.content.slice(-110, -50);
    await writeFile(join(stack.store.researchDir(projectId), "improvement-plan.json"), JSON.stringify({ plan: { items: [
      { id: "improvement:1", section: "sections/ch10.tex", actionType: "modify", priority: "high",
        action: `Revise the sentence containing "${tailAnchor}".`, rationale: "Integration revision", targetQuote: tailAnchor },
    ] } }));
    const applyResult = await (applyStage as { execute: (c: StageRunContext) => Promise<unknown> }).execute(makeCtx("r1")) as Record<string, unknown>;
    expect(applyResult).toMatchObject({ changed: true });
    expect(revisionCalls).toBe(1);
    const afterRevision = await readFile(join(manuscriptDir, "sections", "ch10.tex"), "utf8");
    expect(afterRevision).toContain(`[revised] ${tailAnchor}`);
    expect(afterRevision.length).toBe(chapters[9]!.content.length + "[revised] ".length);
    // 其他九章逐字节不变
    for (const chapter of chapters.slice(0, 9)) {
      expect(await readFile(join(manuscriptDir, chapter.file), "utf8")).toBe(chapter.content);
    }

    // 3) P0-2/P0-3：修订后重审 —— snapshot 变化，旧单元结果零复用，全部重审仍 100%
    const journalRound2Before = await readdir(join(stack.store.reviewsDir(projectId), "review-units", "r2")).catch(() => [] as string[]);
    expect(journalRound2Before).toHaveLength(0);
    await (reviewStage as { execute: (c: StageRunContext) => Promise<unknown> }).execute(makeCtx("r2"));
    const round2 = await readSummary(2);
    expect(round2.coverage?.complete).toBe(true);
    expect(round2.coverage?.snapshotId).not.toBe(snapshot1);
    expect(round2.coverage?.reusedUnits).toBe(0);
    expect(unitPrompts.length).toBe(reviewedUnitsRound1 * 2); // 20 + 20：全部重新审查
    // 覆盖账本产物按轮可查
    const coverage2 = JSON.parse(await readFile(join(stack.store.reviewsDir(projectId), "review-coverage-r2.json"), "utf8"));
    expect(coverage2.complete).toBe(true);
    expect(coverage2.mode).toBe("units");

    // 4) P0-3：review 阶段中断恢复——「本轮已完成 6 个单元后崩溃重启」的中断现场：
    // r3 轮 summary 未落盘，journal 里已有 6 个完成记录 → 重试只补审其余单元
    const controller2 = new AbortController();
    activeSignal = controller2.signal; // 全新（未中止）signal = 进程重启
    const r3Journal = join(stack.store.reviewsDir(projectId), "review-units", "r3");
    await mkdir(r3Journal, { recursive: true });
    // 复制 r2 的完成记录到 r3（模拟「本轮已完成 6 个单元后崩溃重启」的中断现场）
    const r2Files = await readdir(join(stack.store.reviewsDir(projectId), "review-units", "r2"));
    for (const name of r2Files.slice(0, 6)) {
      const record = JSON.parse(await readFile(join(stack.store.reviewsDir(projectId), "review-units", "r2", name), "utf8"));
      record.round = 3;
      await writeFile(join(r3Journal, name), JSON.stringify(record, null, 2) + "\n");
    }
    const beforeR3 = unitPrompts.length;
    await (reviewStage as { execute: (c: StageRunContext) => Promise<unknown> }).execute(makeCtx("r3"));
    const round3 = await readSummary(3);
    expect(round3.coverage?.complete).toBe(true);
    expect(round3.coverage?.reusedUnits).toBe(6);
    expect(unitPrompts.length - beforeR3).toBe(CHAPTERS * 2 - 6); // 只补审 14 个单元
  });
});
