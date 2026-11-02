/**
 * M16 后续：实验性整稿综合审查通道（PAPERTEAM_REVIEW_WHOLE_PAPER，缺省 off）——真实 review.run stage + mock runtime（零模型）。
 *  - off：不发起整稿调用，单元 prompt 逐字节不变，coverage 无 wholePaper 字段；
 *  - on：单元 + 跨章之后恰好 1 次调用，输入为被审全文（FULL_TEXT），finding 标 origin=whole_paper_synthesis、
 *    blocking=false、AUTHOR_CHECK_REQUIRED（恒 L2）；正文覆盖率不变（整稿节点不能掩盖未读章节）；
 *  - 超出字符上限：退化为各章摘要并如实标注 GLOBAL_DIGEST；
 *  - 调用失败：如实记 failed，单元结果与覆盖率不受影响。
 * 夹具为合成稿件。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { startTestStack, scriptedIdeaRuntime } from "../helpers/testStack.js";
import { createExistingPaperDefinition } from "../../src/workflow/definitions.js";
import type { StageRunContext } from "../../src/workflow/types.js";
import type { ReviewSummary } from "../../src/review/ReviewAggregator.js";
import { chapterBody } from "../review/logicalSpan.test.js";

const FILES = {
  "sections/methods.tex": `\\section{Methods}\n\n${chapterBody(4_200, "met")}`,
  "sections/results.tex": `\\section{Results}\n\n${chapterBody(4_200, "res")}`,
  "sections/analysis.tex": `\\section{Analysis}\n\n${chapterBody(4_200, "ana")}`,
};

interface Call { task: string; scope: string; toolPolicy?: string }

async function setup(review: { wholePaperSynthesis?: "off" | "on"; wholePaperMaxChars?: number }, failWhole = false) {
  const scripted = scriptedIdeaRuntime();
  const calls: Call[] = [];
  const runtime = {
    ...scripted.runtime,
    describeAgentContext: async () => ({ model: "glm/test", skills: ["academic-review@abc123"] }),
    runAgent: async (input: Parameters<typeof scripted.runtime.runAgent>[0]) => {
      const now = new Date().toISOString();
      const scope = input.contextScope ?? "";
      calls.push({ task: input.task, scope, ...(input.toolPolicy !== undefined ? { toolPolicy: input.toolPolicy } : {}) });
      const done = (output: string) => ({ taskId: `t${calls.length}`, agentId: "reviewer", status: "completed" as const, createdAt: now, updatedAt: now, events: [], metadata: { model: "glm/test" }, output });
      if (scope === "review/academic/unit") {
        const heading = /章节：「(.+?)」/.exec(input.task)?.[1] ?? "?";
        return done(JSON.stringify({ summary: `unit ${heading}`, issues: [{ category: "academic", severity: "minor", section: heading, description: `[${heading}] note`, quote: "Paragraph 1: p1", blocking: false }], academicScore: 72, riskScore: 20 }));
      }
      if (scope === "review/academic/consistency") return done(JSON.stringify({ summary: "ok", issues: [] }));
      if (scope === "review/academic/whole-paper") {
        if (failWhole) return { taskId: `w${calls.length}`, agentId: "reviewer", status: "failed" as const, createdAt: now, updatedAt: now, events: [], error: "provider 503 injected" };
        return done(JSON.stringify({
          summary: "whole",
          issues: [
            { category: "academic", severity: "major", section: "Whole paper", description: "No comparison with the strongest recent baseline for the main claim.", quote: "", blocking: true, verification: "VERIFIED_IN_TEXT" },
            { category: "style", severity: "minor", section: "Results", description: "Typo.", blocking: false },
          ],
        }));
      }
      throw new Error(`unexpected scope ${scope}`);
    },
  };
  const stack = await startTestStack(runtime, { registerCleanup: () => Promise.resolve(), review: { reviewConcurrency: 1, ...review } });
  const services = stack.stack.workflowServices;
  const projectId = (await stack.store.create("Whole paper fixture", { language: "zh" })).id;
  const dir = stack.store.manuscriptDir(projectId);
  await mkdir(join(dir, "sections"), { recursive: true });
  for (const [file, content] of Object.entries(FILES)) await writeFile(join(dir, file), content);
  await writeFile(join(dir, "main.tex"), "\\documentclass{article}\n\\begin{document}\n\\input{sections/methods}\n\\input{sections/results}\n\\input{sections/analysis}\n\\end{document}\n");
  await services.revisions.commit(projectId, "baseline");
  const definition = createExistingPaperDefinition(services);
  const stage = definition.stages.find((entry) => entry.id === "review.run")! as { execute: (c: StageRunContext) => Promise<unknown> };
  const ctx = { projectId, runId: "wp-1", attempt: 1, signal: new AbortController().signal,
    state: { workflowKind: "existing_paper_improvement", stageResults: {}, stageHistory: [], completedStages: [], inputs: {}, request: {} },
    emitProgress: async () => {}, emitDomain: async () => {}, log: () => {} } as unknown as StageRunContext;
  await stage.execute(ctx);
  const summary = JSON.parse(await readFile(join(stack.store.reviewsDir(projectId), "review-summary-r1.json"), "utf8")) as ReviewSummary;
  return { calls, summary };
}

describe("M16 后续：整稿综合审查实验通道", () => {
  it("off（缺省）：无整稿调用、无 wholePaper 记录；on 时单元 prompt 与 off 逐字节相同", async () => {
    const off = await setup({});
    expect(off.calls.filter((call) => call.scope === "review/academic/whole-paper")).toHaveLength(0);
    expect(off.summary.coverage?.wholePaper).toBeUndefined();
    expect(off.summary.issues.some((issue) => issue.origin === "whole_paper_synthesis")).toBe(false);
    const on = await setup({ wholePaperSynthesis: "on" });
    const unitTasks = (calls: Call[]) => calls.filter((call) => call.scope === "review/academic/unit").map((call) => call.task).sort();
    expect(unitTasks(on.calls)).toEqual(unitTasks(off.calls));
    expect(on.summary.coverage?.ratio).toBe(off.summary.coverage?.ratio);
    expect(on.summary.coverage?.targetUnits).toBe(off.summary.coverage?.targetUnits);
  });

  it("on：恰好 1 次 sealed 以外的整稿调用，输入为全文；finding 恒 L2 待核验、不阻断、过滤 style", async () => {
    const on = await setup({ wholePaperSynthesis: "on" });
    const whole = on.calls.filter((call) => call.scope === "review/academic/whole-paper");
    expect(whole).toHaveLength(1);
    for (const marker of ["met", "res", "ana"]) expect(whole[0]!.task).toContain(chapterBody(4_200, marker).slice(0, 200));
    expect(on.summary.coverage?.wholePaper).toMatchObject({ status: "completed", inputMode: "FULL_TEXT", findings: 1 });
    const synth = on.summary.issues.filter((issue) => issue.origin === "whole_paper_synthesis");
    expect(synth).toHaveLength(1);
    expect(synth[0]).toMatchObject({ blocking: false, verification: "AUTHOR_CHECK_REQUIRED", category: "academic" });
  });

  it("全文超出字符上限 → GLOBAL_DIGEST（不冒充通读全文）", async () => {
    const on = await setup({ wholePaperSynthesis: "on", wholePaperMaxChars: 10_000 });
    expect(on.summary.coverage?.wholePaper?.inputMode).toBe("GLOBAL_DIGEST");
    const task = on.calls.find((call) => call.scope === "review/academic/whole-paper")!.task;
    expect(task).toContain("各章摘要");
    expect(task).not.toContain("===== 论文全文 =====");
  });

  it("整稿调用失败 → 如实记 failed，单元结果与覆盖率不变", async () => {
    const failed = await setup({ wholePaperSynthesis: "on" }, true);
    expect(failed.summary.coverage?.wholePaper).toMatchObject({ status: "failed", findings: 0 });
    expect(failed.summary.coverage?.complete).toBe(true);
    expect(failed.summary.issues.some((issue) => issue.origin === "whole_paper_synthesis")).toBe(false);
  });
});
