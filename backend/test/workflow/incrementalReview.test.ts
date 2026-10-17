/**
 * M14.8.1-MOT：增量复审（跨轮合法缓存 + 保守依赖失效）——真实 review.run stage。
 *
 * 背景（M14.8-MOT 真实返修）：修订只改 3 节，复审仍重跑全部 35 个单元（unit journal 只在
 * 同轮复用），单 run 100 次预算被复审耗尽。本文件证明：
 *  - 未改动、请求指纹相同（完整 prompt + 模型 + Skill 版本）的单元复用既往审查；
 *  - 改动单元、汇总型章节（引言 / 结论）、\ref 改动单元的单元、模型变化、章节索引变化
 *    全部重新审查（不得继承旧结论）；
 *  - Runtime 无法证明模型一致时禁用复用（等价全量审）；跨章一致性审查恒为新执行；
 *  - coverage 计入合法缓存且来源可追溯，gate 的覆盖规则照常成立。
 */
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startTestStack, scriptedIdeaRuntime } from "../helpers/testStack.js";
import { createExistingPaperDefinition } from "../../src/workflow/definitions.js";
import type { StageRunContext } from "../../src/workflow/types.js";
import type { ReviewSummary } from "../../src/review/ReviewAggregator.js";
import { chapterBody } from "../review/logicalSpan.test.js";
import { planIncrementalInvalidation } from "../../src/review/coverageLedger.js";

const TITLES = ["Introduction", "Related Work", "Method", "Experiments", "Ablation", "Conclusion"];

function chapter(index: number, extra = ""): string {
  const title = TITLES[index - 1]!;
  const ref = index === 5 ? "\nThe ablation revisits Section~\\ref{sec:ch3} and its design.\n" : "";
  return `\\section{${title}}\\label{sec:ch${index}}\n` + chapterBody(4_200, `ch${index}`) + ref + extra;
}

async function setup(options: { describe?: "ok" | "none"; model?: () => string } = {}) {
  const scripted = scriptedIdeaRuntime();
  const unitPrompts: string[] = [];
  let crossCalls = 0;
  const runtime = {
    ...scripted.runtime,
    ...(options.describe === "none" ? {} : {
      describeAgentContext: async () => ({ model: options.model?.() ?? "glm/claude-opus-5-5", skills: ["paper-review@abc123"] }),
    }),
    runAgent: async (input: Parameters<typeof scripted.runtime.runAgent>[0]) => {
      const now = new Date().toISOString();
      const scope = input.contextScope ?? "";
      if (scope === "review/academic/unit") {
        unitPrompts.push(input.task);
        const heading = /章节：「(.+?)」/.exec(input.task)?.[1] ?? "unknown";
        return {
          taskId: `unit-${unitPrompts.length}`, agentId: "reviewer", status: "completed" as const, createdAt: now, updatedAt: now,
          output: JSON.stringify({
            summary: `unit ${heading} ok`,
            issues: [{ category: "academic", severity: "minor", section: heading, description: `[${heading}] observation #${unitPrompts.length}`, blocking: false }],
            academicScore: 70 + (unitPrompts.length % 7), riskScore: 20,
          }),
          events: [],
        };
      }
      if (scope === "review/academic/consistency") {
        crossCalls += 1;
        return { taskId: `cross-${crossCalls}`, agentId: "reviewer", status: "completed" as const, createdAt: now, updatedAt: now,
          output: JSON.stringify({ summary: "cross ok", issues: [] }), events: [] };
      }
      throw new Error(`unexpected scope ${scope}`);
    },
  };
  const stack = await startTestStack(runtime, { registerCleanup: () => Promise.resolve() });
  const projectId = (await stack.store.create("Incremental review fixture", { language: "en" })).id;
  const services = stack.stack.workflowServices;
  const manuscriptDir = stack.store.manuscriptDir(projectId);
  await mkdir(join(manuscriptDir, "sections"), { recursive: true });
  const write = async (index: number, content: string) => writeFile(join(manuscriptDir, `sections/ch${index}.tex`), content);
  await writeFile(join(manuscriptDir, "main.tex"),
    `\\documentclass{article}\n\\begin{document}\n${TITLES.map((_, i) => `\\input{sections/ch${i + 1}}`).join("\n")}\n\\end{document}\n`);
  for (let i = 1; i <= TITLES.length; i += 1) await write(i, chapter(i));
  await writeFile(join(manuscriptDir, "references.bib"), "@article{ref1,title={R1},year={2020}}");
  await services.revisions.commit(projectId, "baseline");
  const stage = createExistingPaperDefinition(services).stages.find((s) => s.id === "review.run")!;
  const runReview = async () => {
    if (!("execute" in stage)) throw new Error("Wrong stage");
    const ctx = {
      projectId, runId: `inc-${Math.random().toString(36).slice(2, 8)}`, attempt: 1, signal: new AbortController().signal,
      state: { workflowKind: "existing_paper_improvement", stageResults: {}, stageHistory: [], completedStages: [], inputs: {}, request: {} },
      emitProgress: async () => {}, emitDomain: async () => {}, log: () => {},
    } as unknown as StageRunContext;
    const before = unitPrompts.length;
    await stage.execute(ctx);
    return unitPrompts.length - before;
  };
  const summary = async (round: number) =>
    JSON.parse(await readFile(join(stack.store.reviewsDir(projectId), `review-summary-r${round}.json`), "utf8")) as ReviewSummary;
  const unitIds = async (round: number, disposition: string) =>
    ((await summary(round)).coverage?.incremental?.dispositions ?? []).filter((entry) => entry.disposition === disposition).map((entry) => entry.unitId);
  return { stack, projectId, write, runReview, summary, unitIds, crossCalls: () => crossCalls, unitPrompts };
}

describe("M14.8.1-MOT 增量复审（跨轮合法缓存 + 保守依赖失效）", () => {
  it("未改动的稿件：第二轮零单元模型调用、全部合法缓存（来源 r1 可追溯）、跨章仍新执行、coverage 完整", async () => {
    const h = await setup();
    const first = await h.runReview();
    expect(first).toBeGreaterThan(0);
    const r1 = await h.summary(1);
    expect(r1.coverage?.incremental?.cachedUnits).toBe(0);
    expect(await h.runReview()).toBe(0);
    const r2 = await h.summary(2);
    expect(r2.coverage?.complete).toBe(true);
    expect(r2.coverage?.incremental?.cachedUnits).toBe(first);
    expect(r2.coverage?.incremental?.freshUnits).toBe(0);
    expect(r2.coverage?.incremental?.dispositions.every((entry) => entry.disposition === "cached" ? entry.sourceRound === 1 : true)).toBe(true);
    expect(h.crossCalls()).toBe(2);
    // 复用 = 同一请求的既往结果：分数与 issues 完整恢复
    expect(r2.scores.academicScore).toBe(r1.scores.academicScore);
    expect(r2.issues.length).toBe(r1.issues.length);
    const journalDir = join(h.stack.store.reviewsDir(h.projectId), "review-units", "r2");
    const record = JSON.parse(await readFile(join(journalDir, (await readdir(journalDir))[0]!), "utf8"));
    expect(record.reusedFrom?.round).toBe(1);
    expect(typeof record.requestFingerprint).toBe("string");
  });

  it("只改「Method」：改动单元、汇总型章节（Introduction / Conclusion）、\\ref 改动章节的单元重审；其余合法缓存", async () => {
    const h = await setup();
    await h.runReview();
    await h.write(3, chapter(3).replace("Paragraph 2: p2 ch3", "Paragraph 2 (revised): p2 ch3"));
    const calls = await h.runReview();
    const r2 = await h.summary(2);
    const changed = r2.coverage!.incremental!.changedUnitIds;
    const invalidated = r2.coverage!.incremental!.invalidated.map((entry) => entry.unitId);
    expect(changed.every((unitId) => unitId.startsWith("sections/ch3.tex"))).toBe(true);
    expect(invalidated.some((unitId) => unitId.startsWith("sections/ch1.tex"))).toBe(true); // Introduction
    expect(invalidated.some((unitId) => unitId.startsWith("sections/ch6.tex"))).toBe(true); // Conclusion
    expect(invalidated.some((unitId) => unitId.startsWith("sections/ch5.tex"))).toBe(true); // \ref{sec:ch3}
    const cached = await h.unitIds(2, "cached");
    expect(cached.some((unitId) => unitId.startsWith("sections/ch2.tex"))).toBe(true);
    expect(cached.some((unitId) => unitId.startsWith("sections/ch4.tex"))).toBe(true);
    expect(cached.some((unitId) => /ch[1356]\.tex/.test(unitId))).toBe(false);
    expect(calls).toBe(changed.length + invalidated.length);
    expect(r2.coverage?.complete).toBe(true);
  });

  it("审稿模型变化：请求指纹失效，全部单元重审", async () => {
    let model = "glm/claude-opus-5-5";
    const h = await setup({ model: () => model });
    const first = await h.runReview();
    model = "glm/glm-5.3";
    expect(await h.runReview()).toBe(first);
    expect((await h.summary(2)).coverage?.incremental?.cachedUnits).toBe(0);
  });

  it("章节标题变化（章节索引进入每个单元 prompt）：全部单元重审，不继承旧结论", async () => {
    const h = await setup();
    const first = await h.runReview();
    await h.write(4, chapter(4).replace("\\section{Experiments}", "\\section{Experimental Results}"));
    expect(await h.runReview()).toBe(first);
    expect((await h.summary(2)).coverage?.incremental?.cachedUnits).toBe(0);
  });

  it("Runtime 无法证明模型 / Skill 一致：禁用跨轮复用（等价全量审）并如实记录", async () => {
    const h = await setup({ describe: "none" });
    const first = await h.runReview();
    expect(await h.runReview()).toBe(first);
    const ledger = (await h.summary(2)).coverage?.incremental;
    expect(ledger?.cachedUnits).toBe(0);
    expect(ledger?.note).toContain("无法证明");
  });
});

describe("planIncrementalInvalidation（纯函数）", () => {
  const unit = (unitId: string, spanId: string, heading: string, text: string, hash = "h") => ({ unitId, spanId, heading, contentHash: hash, text });
  it("无基准 → 全部视为改动（等价全量审）", () => {
    const result = planIncrementalInvalidation({ units: [unit("a", "sec:a", "A", "\\section{A}")], baselineHashes: null });
    expect([...result.changed]).toEqual(["a"]);
  });
  it("无改动 → 不失效任何单元（汇总型章节也可复用）", () => {
    const result = planIncrementalInvalidation({
      units: [unit("f", "frontmatter", "摘要与前置部分", "abstract"), unit("i", "sec:intro", "引言", "\\section{引言}")],
      baselineHashes: new Map([["f", "h"], ["i", "h"]]),
    });
    expect(result.changed.size).toBe(0);
    expect(result.invalidated.size).toBe(0);
  });
  it("任一改动 → 摘要 / 引言 / 讨论子节 / 结论失效；\\ref 指向改动单元 \\label 的单元失效；无关单元不失效", () => {
    const units = [
      unit("front", "frontmatter", "摘要与前置部分", "摘要"),
      unit("intro", "sec:intro", "引言", "\\section{引言}\\label{sec:intro} 见第~\\ref{sec:exp} 节"),
      unit("exp", "sec:exp", "实验结果", "\\section{实验结果}\\label{sec:exp}\\begin{table}\\label{tab:main}\\end{table}", "changed"),
      unit("abl", "sec:abl", "消融实验", "\\section{消融实验}\\label{sec:abl} 表~\\ref{tab:main} 显示"),
      unit("rel", "sec:rel", "相关工作", "\\section{相关工作}\\label{sec:rel} 无引用"),
      unit("disc", "sec:disc", "讨论", "\\section{讨论}\\label{sec:disc}"),
      unit("lim", "subsection:局限", "局限", "\\subsection{局限} 子节"),
      unit("conc", "sec:conclusion", "结论", "\\section{结论}"),
    ];
    const result = planIncrementalInvalidation({ units, baselineHashes: new Map(units.map((u) => [u.unitId, "h"])) });
    expect([...result.changed]).toEqual(["exp"]);
    expect([...result.invalidated.keys()].sort()).toEqual(["abl", "conc", "disc", "front", "intro", "lim"].sort());
    expect(result.invalidated.get("abl")).toContain("ref_dependency");
    expect(result.invalidated.has("rel")).toBe(false);
  });
});
