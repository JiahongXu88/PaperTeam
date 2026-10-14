/**
 * M14.1a P0-1 集成：长章节 logicalSpan 局部修订（走真实 revision.apply stage）。
 *
 * 场景基线（cd2b92f 上的缺陷，本文件即其回归）：
 *  - sections/*.tex 是整文件目标 + WriterService 12k 截断：>12k 章节的尾部
 *    从未进入 prompt，而 Writer 输出被整文件覆写（无任何候选级守卫）；
 *  - 嵌套花括号标题 / 同名标题定位缺陷；
 *  - 目标不可解析时整 run fatal；
 *  - .tex 写入非原子。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { startTestStack, scriptedIdeaRuntime } from "../helpers/testStack.js";
import { createExistingPaperDefinition } from "../../src/workflow/definitions.js";
import type { StageRunContext } from "../../src/workflow/types.js";
import { locateLatexSections } from "../../src/review/revisionScope.js";
import { partitionSpanIntoUnits } from "../../src/review/logicalSpan.js";
import { chapterBody } from "../review/logicalSpan.test.js";

const METHOD_HEADING = String.raw`\section{Method}` + "\n";
const METHOD_BODY = chapterBody(30_000);
const METHOD_TEX = METHOD_HEADING + METHOD_BODY;
const INTRO_TEX = String.raw`\section{Introduction}` + "\n" + "Short intro.\n";
/** 唯一末尾锚点：最后一段中部 60 字符（旧 12k 截断下该文本从不进入 prompt） */
const methodSpans = locateLatexSections("sections/method.tex", METHOD_TEX);
const methodUnits = partitionSpanIntoUnits(methodSpans[0]!, 9_000).units;
const lastUnit = methodUnits[methodUnits.length - 1]!;
const TAIL_ANCHOR = lastUnit.content.slice(Math.floor(lastUnit.content.length / 2), Math.floor(lastUnit.content.length / 2) + 60);
const EXPECTED_UNIT_ID = lastUnit.logicalSection;

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

interface Setup {
  stack: Awaited<ReturnType<typeof startTestStack>>;
  project: { id: string };
  services: Awaited<ReturnType<typeof startTestStack>>["stack"]["workflowServices"];
  tasks: string[];
  calls: () => number;
  source: (file?: string) => Promise<string>;
  artifact: () => Promise<{ records: Array<{ logicalTarget: string; overall: string; failedStage?: string; finalStatus?: string; apply?: { status: string }; scope: { violations: string[] } }> } | null>;
  execute: () => Promise<Record<string, unknown>>;
  events: Array<{ type: string; data: unknown; message: string }>;
}

async function setup(proposals: string[], planItems: unknown[]): Promise<Setup> {
  const scripted = scriptedIdeaRuntime();
  let calls = 0;
  const tasks: string[] = [];
  const events: Setup["events"] = [];
  const runtime = {
    ...scripted.runtime,
    runAgent: async (input: Parameters<typeof scripted.runtime.runAgent>[0]) => {
      tasks.push(input.task);
      const now = new Date().toISOString();
      calls += 1;
      return {
        taskId: `long-${calls}`, agentId: "writer", status: "completed" as const, createdAt: now, updatedAt: now,
        output: proposals[Math.min(calls - 1, proposals.length - 1)] ?? "", events: [],
      };
    },
  };
  const stack = await startTestStack(runtime, { registerCleanup: (cleanup) => cleanups.push(cleanup) });
  const project = await stack.store.create("Long chapter revision fixture", { language: "en" });
  const services = stack.stack.workflowServices;
  const manuscriptDir = stack.store.manuscriptDir(project.id);
  await mkdir(join(manuscriptDir, "sections"), { recursive: true });
  // 多文件项目：main.tex \input 引用；method.tex 30k（超过 12k 旧截断与 9k 单元上限）
  await writeFile(join(manuscriptDir, "main.tex"), "\\documentclass{article}\n\\begin{document}\n\\input{sections/intro}\n\\input{sections/method}\n\\end{document}\n");
  await writeFile(join(manuscriptDir, "sections", "intro.tex"), INTRO_TEX);
  await writeFile(join(manuscriptDir, "sections", "method.tex"), METHOD_TEX);
  await writeFile(join(manuscriptDir, "references.bib"), "@article{ref1,title={R1},year={2020}}\n@article{ref2,title={R2},year={2021}}\n@article{ref3,title={R3},year={2022}}\n@article{ref4,title={R4},year={2023}}\n@article{ref5,title={R5},year={2024}}\n@article{ref6,title={R6},year={2025}}\n@article{ref7,title={R7},year={2026}}\n@article{base,title={Base},year={2019}}");
  await services.revisions.commit(project.id, "baseline");
  await writeFile(join(stack.store.researchDir(project.id), "improvement-plan.json"), JSON.stringify({ plan: { items: planItems } }));
  const definition = createExistingPaperDefinition(services);
  const stage = definition.stages.find((s) => s.id === "revision.apply")!;
  const ctx = {
    projectId: project.id, runId: "long-chapter", attempt: 1, signal: new AbortController().signal,
    state: { workflowKind: "existing_paper_improvement", stageResults: {}, stageHistory: [], completedStages: [], inputs: {}, request: {} },
    emitProgress: async () => {},
    emitDomain: async (type: string, data: unknown, message: string) => { events.push({ type, data, message }); },
    log: () => {},
  } as unknown as StageRunContext;
  return {
    stack, project, services, tasks,
    calls: () => calls,
    source: (file = "sections/method.tex") => readFile(join(manuscriptDir, file), "utf8"),
    artifact: async () => services.reviewArtifacts.loadPatchValidation(project.id, await services.revisions.currentRevision(project.id)),
    execute: async () => {
      if (!("execute" in stage)) throw new Error("Wrong stage");
      return stage.execute(ctx) as Promise<Record<string, unknown>>;
    },
    events,
  };
}

describe("M14.1a 长章节 logicalSpan 局部修订（revision.apply）", () => {
  it("30k 章节：末尾锚点修订只改目标单元，章节其余部分与其他文件逐字节保持", async () => {
    // Writer 输出 = 目标单元全文，仅锚点所在句加一个明确词（受控局部修改）
    const revisedUnit = lastUnit.content.replace(TAIL_ANCHOR, `[revised] ${TAIL_ANCHOR}`);
    const run = await setup([revisedUnit], [
      { id: "improvement:1", section: "sections/method.tex", actionType: "modify", priority: "high",
        action: `Revise the sentence containing "${TAIL_ANCHOR}".`, rationale: "Reviewer requests a focused change at the chapter end",
        targetQuote: TAIL_ANCHOR },
    ]);
    const result = await run.execute();
    const after = await run.source();
    // 单元内容按预期替换；单元外内容（含 30k 章节前 27k、intro、main）逐字节一致
    expect(after).toBe(METHOD_TEX.replace(lastUnit.content, revisedUnit));
    expect(after.length).toBe(METHOD_TEX.length + "[revised] ".length);
    expect(await run.source("sections/intro.tex")).toBe(INTRO_TEX);
    // patch lineage 指向编辑单元
    const artifact = await run.artifact();
    const record = artifact?.records.find((entry) => entry.apply?.status === "applied");
    expect(record?.logicalTarget).toBe(EXPECTED_UNIT_ID);
    expect(record?.overall).toBe("pass");
    expect(result).toMatchObject({ changed: true });
  });

  it("Writer prompt 含章节尾部原文（无 12k 截断）且带只读相邻上下文与单元说明", async () => {
    const revisedUnit = lastUnit.content;
    const run = await setup([revisedUnit], [
      { id: "improvement:1", section: "sections/method.tex", actionType: "modify", priority: "high",
        action: `Check the sentence containing "${TAIL_ANCHOR}".`, rationale: "Tail visibility", targetQuote: TAIL_ANCHOR },
    ]);
    await run.execute();
    expect(run.calls()).toBe(1);
    const prompt = run.tasks[0]!;
    // 尾部段落（>12k 偏移处）必须出现在 prompt 中 —— 旧实现在此截断
    expect(prompt).toContain(TAIL_ANCHOR);
    const tailParagraphIndex = METHOD_BODY.lastIndexOf(TAIL_ANCHOR);
    expect(tailParagraphIndex).toBeGreaterThan(12_000);
    expect(prompt).toContain("编辑单元");
    expect(prompt).toContain("相邻上下文");
  });

  it("多 Finding 指向同一单元 → 合并为一个目标一次调用；相邻重叠锚点不静默覆盖", async () => {
    const revisedUnit = lastUnit.content.replace(TAIL_ANCHOR, `[merged] ${TAIL_ANCHOR}`);
    const adjacent = TAIL_ANCHOR.slice(0, 30);
    const run = await setup([revisedUnit], [
      { id: "improvement:1", section: "sections/method.tex", actionType: "modify", priority: "high",
        action: `Fix A near "${adjacent}".`, rationale: "A", targetQuote: adjacent },
      { id: "improvement:2", section: "sections/method.tex", actionType: "modify", priority: "high",
        action: `Fix B at "${TAIL_ANCHOR}".`, rationale: "B", targetQuote: TAIL_ANCHOR },
    ]);
    await run.execute();
    // 两个锚点落在同一单元 → 一个 Writer 调用、一个 applied patch
    expect(run.calls()).toBe(1);
    const artifact = await run.artifact();
    expect(artifact?.records.filter((entry) => entry.apply?.status === "applied")).toHaveLength(1);
    expect(await run.source()).toBe(METHOD_TEX.replace(lastUnit.content, revisedUnit));
  });

  it("同文件不相邻的两个单元 patch 顺序应用：兄弟偏移重定位、互不覆盖、两次都成功", async () => {
    const firstUnit = methodUnits[0]!;
    const headAnchor = firstUnit.content.slice(Math.floor(firstUnit.content.length / 2), Math.floor(firstUnit.content.length / 2) + 60);
    const revisedFirst = firstUnit.content.replace(headAnchor, `[head] ${headAnchor}`);
    const revisedLast = lastUnit.content.replace(TAIL_ANCHOR, `[tail] ${TAIL_ANCHOR}`);
    const run = await setup([revisedFirst, revisedLast], [
      { id: "improvement:1", section: "sections/method.tex", actionType: "modify", priority: "high",
        action: `Revise "${headAnchor}".`, rationale: "Chapter head change", targetQuote: headAnchor },
      { id: "improvement:2", section: "sections/method.tex", actionType: "modify", priority: "high",
        action: `Revise "${TAIL_ANCHOR}".`, rationale: "Chapter tail change", targetQuote: TAIL_ANCHOR },
    ]);
    const result = await run.execute();
    expect(run.calls()).toBe(2);
    // 两个 patch 都应用：首尾单元各自替换，中间单元逐字节保持
    const expected = METHOD_TEX.replace(firstUnit.content, revisedFirst).replace(lastUnit.content, revisedLast);
    expect(await run.source()).toBe(expected);
    const artifact = await run.artifact();
    const applied = artifact?.records.filter((entry) => entry.apply?.status === "applied") ?? [];
    expect(applied.map((entry) => entry.logicalTarget).sort()).toEqual([...[firstUnit.logicalSection, lastUnit.logicalSection]].sort());
    expect(applied.every((entry) => entry.overall === "pass")).toBe(true);
    expect(result).toMatchObject({ changed: true, revisedSections: 2 });
  });

  it("无法可靠定位的意见（无锚点且指向超长文件）→ unresolved：不派发、不标成功、文件不动", async () => {
    const run = await setup(["irrelevant"], [
      { id: "improvement:1", section: "sections/method.tex", actionType: "modify", priority: "high",
        action: "Improve the chapter overall.", rationale: "No anchor, cannot locate" },
    ]);
    const result = await run.execute();
    expect(run.calls()).toBe(0);
    expect(await run.source()).toBe(METHOD_TEX);
    expect(result).toMatchObject({ changed: false, revisedSections: 0 });
    const dispatch = result.findingDispatch as { unresolved: number; matched: number };
    expect(dispatch.unresolved).toBe(1);
    expect(dispatch.matched).toBe(0);
    expect(run.events.some((event) => event.type === "revision.dispatch_unresolved")).toBe(true);
  });

  it("同名标题章节：第二个 Method 的意见定位到 #2 span，不误改第一个", async () => {
    // 单文件 main.tex：两个同名 \section{Method}，修订第二个
    const dualBody = chapterBody(1_500);
    const dualTex = [
      String.raw`\documentclass{article}`, String.raw`\begin{document}`,
      String.raw`\section{Method}`, "First method body.",
      String.raw`\section{Method}`, dualBody,
      String.raw`\end{document}`, "",
    ].join("\n");
    const scripted = scriptedIdeaRuntime();
    let calls = 0;
    const tasks: string[] = [];
    const dualSpans = locateLatexSections("main.tex", dualTex);
    const secondSpan = dualSpans.find((span) => span.logicalSection === "section:Method#2")!;
    const secondProposal = secondSpan.content.replace("Paragraph 2: p2", "Paragraph 2 (revised): p2");
    const runtime = { ...scripted.runtime, runAgent: async (input: Parameters<typeof scripted.runtime.runAgent>[0]) => {
      tasks.push(input.task);
      const now = new Date().toISOString();
      return { taskId: `dual-${++calls}`, agentId: "writer", status: "completed" as const, createdAt: now, updatedAt: now, output: secondProposal, events: [] };
    } };
    const stack = await startTestStack(runtime, { registerCleanup: (cleanup) => cleanups.push(cleanup) });
    const project = await stack.store.create("Duplicate headings fixture", { language: "en" });
    const services = stack.stack.workflowServices;
    const manuscriptDir = stack.store.manuscriptDir(project.id);
    await writeFile(join(manuscriptDir, "main.tex"), dualTex);
    await writeFile(join(manuscriptDir, "references.bib"), "@article{ref1,title={R1},year={2020}}");
    await services.revisions.commit(project.id, "baseline");
    await writeFile(join(stack.store.researchDir(project.id), "improvement-plan.json"), JSON.stringify({ plan: { items: [
      { id: "improvement:1", section: "main.tex", logicalSection: "section:Method#2", actionType: "modify", priority: "high",
        action: `Revise "Paragraph 2: p2 para analysis of the proposed method".`, rationale: "Second occurrence" },
     ] } }));
    const definition = createExistingPaperDefinition(services);
    const stage = definition.stages.find((s) => s.id === "revision.apply")!;
    const ctx = { projectId: project.id, runId: "dual", attempt: 1, signal: new AbortController().signal,
      state: { workflowKind: "existing_paper_improvement", stageResults: {}, stageHistory: [], completedStages: [], inputs: {}, request: {} },
      emitProgress: async () => {}, emitDomain: async () => {}, log: () => {} } as unknown as StageRunContext;
    if (!("execute" in stage)) throw new Error("Wrong stage");
    await stage.execute(ctx);
    // 第二个 Method span（1.5k ≤ 9k 不切单元）按 #2 副本 id 精确派发与解析；
    // 第一个同名 Method span 逐字节保持
    expect(calls).toBe(1);
    expect(tasks[0]).toContain("Method");
    const after = await readFile(join(manuscriptDir, "main.tex"), "utf8");
    expect(after).toBe(dualTex.replace(secondSpan.content, secondProposal));
    expect(after).toContain("First method body.");
  });
});
