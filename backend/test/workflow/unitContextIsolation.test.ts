/**
 * M14.9.5 P1 实验开关 PAPERTEAM_REVIEW_UNIT_ISOLATION（review.unitContextIsolation，缺省关闭）。
 *
 * 归因（D:\PaperTeamData\M14_9_5_QualityGateReliability\severity-attribution.json / NEW-1 call 记录）：同一项目的全部长文档
 * 单元共用 review/academic/unit 会话（sessionKey 只由 projectId + contextScope 派生）——某单元能否「看到」其他单元的
 * 正文与表格，取决于调度顺序以及超时后会话是否被重建；跨单元才能核对的问题（结果节表格 × 方法 / 分析节表述）随之时有时无。
 * 开关打开：每个单元 / 每次尝试独立会话 + 本单元引用、但位于其他单元的表格作为只读参考（确定性、可复现）。
 * 缺省：会话派生与 prompt 逐字节不变。
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { startTestStack, scriptedIdeaRuntime } from "../helpers/testStack.js";
import { createExistingPaperDefinition } from "../../src/workflow/definitions.js";
import type { StageRunContext } from "../../src/workflow/types.js";
import { chapterBody } from "../review/logicalSpan.test.js";

const TABLE = [
  "\\textbf{表 1 两组基本特征}",
  "",
  "\\begin{table}[htbp]\\centering",
  "\\begin{tabular}{lll}",
  "组别 & 例数 & 构成比 \\\\",
  "A & 600 & 50.0 \\\\",
  "\\end{tabular}",
  "\\end{table}",
].join("\n");

async function runOnce(isolation: boolean): Promise<Array<{ task: string; sessionKey?: string }>> {
  const scripted = scriptedIdeaRuntime();
  const inputs: Array<{ task: string; sessionKey?: string }> = [];
  const runtime = {
    ...scripted.runtime,
    runAgent: async (input: Parameters<typeof scripted.runtime.runAgent>[0]) => {
      const now = new Date().toISOString();
      if (input.contextScope === "review/academic/unit") {
        inputs.push({ task: input.task, ...(input.sessionKey !== undefined ? { sessionKey: input.sessionKey } : {}) });
        return { taskId: `u${inputs.length}`, agentId: "reviewer", status: "completed" as const, createdAt: now, updatedAt: now, events: [],
          output: JSON.stringify({ summary: "ok", issues: [], academicScore: 70, riskScore: 10 }) };
      }
      if (input.contextScope === "review/academic/consistency") {
        return { taskId: "cross", agentId: "reviewer", status: "completed" as const, createdAt: now, updatedAt: now, events: [], output: JSON.stringify({ summary: "ok", issues: [] }) };
      }
      throw new Error(`unexpected scope ${input.contextScope ?? ""}`);
    },
  };
  const stack = await startTestStack(runtime, { registerCleanup: () => Promise.resolve(), review: { unitContextIsolation: isolation } });
  const projectId = (await stack.store.create("Unit isolation fixture", { language: "en" })).id;
  const services = stack.stack.workflowServices;
  const dir = stack.store.manuscriptDir(projectId);
  await mkdir(join(dir, "sections"), { recursive: true });
  await writeFile(join(dir, "main.tex"), "\\documentclass{article}\n\\begin{document}\n\\input{sections/ch1}\n\\input{sections/ch2}\n\\end{document}\n");
  await writeFile(join(dir, "sections/ch1.tex"), `\\section{Results}\n${TABLE}\n\n${chapterBody(4_000, "res")}`);
  await writeFile(join(dir, "sections/ch2.tex"), `\\section{Discussion}\nAs shown in 表1, group A has 600 cases.\n\n${chapterBody(4_000, "dis")}`);
  await writeFile(join(dir, "references.bib"), "@article{ref1,title={R1},year={2020}}");
  await services.revisions.commit(projectId, "baseline");
  const stage = createExistingPaperDefinition(services).stages.find((entry) => entry.id === "review.run")!;
  const ctx = { projectId, runId: "iso", attempt: 1, signal: new AbortController().signal,
    state: { workflowKind: "existing_paper_improvement", stageResults: {}, stageHistory: [], completedStages: [], inputs: {}, request: {} },
    emitProgress: async () => {}, emitDomain: async () => {}, log: () => {} } as unknown as StageRunContext;
  await (stage as { execute: (c: StageRunContext) => Promise<unknown> }).execute(ctx);
  return inputs;
}

describe("M14.9.5 单元会话隔离 + 被引表格只读参考（实验开关）", () => {
  it("缺省关闭：单元不传显式 sessionKey（沿用 projectId + scope 派生），prompt 不含被引表格块", async () => {
    const inputs = await runOnce(false);
    expect(inputs.length).toBeGreaterThanOrEqual(2);
    expect(inputs.every((input) => input.sessionKey === undefined)).toBe(true);
    expect(inputs.some((input) => input.task.includes("被引表格"))).toBe(false);
  });

  it("开启：每个单元独立会话；引用了其他单元表格的单元带只读表格原文，表格所在单元不重复附上", async () => {
    const inputs = await runOnce(true);
    const keys = inputs.map((input) => input.sessionKey);
    expect(keys.every((key) => key !== undefined && key.includes("--review/academic/unit/r"))).toBe(true);
    expect(new Set(keys).size).toBe(keys.length);
    const discussion = inputs.filter((input) => input.task.includes("章节：「Discussion」"));
    const results = inputs.filter((input) => input.task.includes("章节：「Results」"));
    expect(discussion.length).toBeGreaterThan(0);
    expect(discussion.some((input) => input.task.includes("被引表格") && input.task.includes("A & 600 & 50.0"))).toBe(true);
    expect(results.some((input) => input.task.includes("被引表格"))).toBe(false);
  });
});
