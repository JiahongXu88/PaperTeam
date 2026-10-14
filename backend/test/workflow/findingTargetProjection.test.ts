/**
 * M14.1b P1 集成：真实 review.run（单元模式）→ revision.plan：Reviewer 给出的 quote 被
 * 投影为被审快照中的唯一 targetQuote（含 file / 章节 span id），歧义 / 无锚点保持
 * unresolved（不猜）。下游 revision.apply 的 targetQuote 消费由 M14.1a 测试覆盖。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

import { createExistingPaperDefinition } from "../../src/workflow/definitions.js";
import type { StageRunContext } from "../../src/workflow/types.js";
import type { RevisionPlan } from "../../src/review/revisionPlan.js";
import { startTestStack, scriptedIdeaRuntime } from "../helpers/testStack.js";
import { chapterBody } from "../review/logicalSpan.test.js";

const CHAPTERS = 3;
const CHAPTER_CHARS = 9_500;
const chapters = Array.from({ length: CHAPTERS }, (_, index) => {
  const content = `\\section{Chapter ${index + 1}}\n` + chapterBody(CHAPTER_CHARS, `ch${index + 1}`);
  return { file: `sections/ch${index + 1}.tex`, content };
});

describe("M14.1b P1 review.run → revision.plan targetQuote 投影", () => {
  it("唯一 quote 投影为快照原文 + 章节 span；跨章重复句歧义、无锚点意见保持 unresolved", async () => {
    const scripted = scriptedIdeaRuntime();
    let unitCalls = 0;
    const runtime = {
      ...scripted.runtime,
      runAgent: async (input: Parameters<typeof scripted.runtime.runAgent>[0]) => {
        const now = new Date().toISOString();
        const scope = input.contextScope ?? "";
        if (scope === "review/academic/unit") {
          unitCalls += 1;
          const prompt = input.task;
          const heading = /章节：「(.+?)」/.exec(prompt)?.[1] ?? "unknown";
          const unitTag = /第 (\d+)\/(\d+) 单元/.exec(prompt)?.[1] ?? "?";
          const body = prompt.slice(prompt.indexOf("完整无截断）=====") + "完整无截断）=====".length);
          // 从本单元原文逐字摘出一句（第 3 个段落），模拟真实 Reviewer 的 quote
          const sentence = body.split("\n\n").map((part) => part.trim()).filter((part) => part.startsWith("Paragraph"))[2] ?? "";
          const unique = sentence.slice(0, 60);
          const issues = heading === "Chapter 2" && unitTag === "1"
            ? [
                { category: "academic", severity: "major", section: heading, description: "论证薄弱", quote: unique, suggestedAction: "补充论证", blocking: false },
                // 每段都出现的共享片段 → 歧义
                { category: "academic", severity: "major", section: heading, description: "表述重复", quote: "analysis of the proposed method with citation", blocking: false },
                // 无任何锚点
                { category: "academic", severity: "major", section: heading, description: "整章结构需要重排", blocking: false },
              ]
            : [];
          return {
            taskId: `unit-${unitCalls}`, agentId: "reviewer", status: "completed" as const, createdAt: now, updatedAt: now,
            output: JSON.stringify({ summary: `unit ${heading} ok`, issues, academicScore: 90, riskScore: 10 }),
            events: [],
          };
        }
        if (scope === "review/academic/consistency") {
          return { taskId: "cross", agentId: "reviewer", status: "completed" as const, createdAt: now, updatedAt: now, output: JSON.stringify({ summary: "cross ok", issues: [] }), events: [] };
        }
        throw new Error(`未预期的 runtime scope：${scope || "(none)"}`);
      },
    };
    const stack = await startTestStack(runtime);
    try {
      const projectId = (await stack.store.create("Finding projection fixture", { language: "en" })).id;
      const services = stack.stack.workflowServices;
      const manuscriptDir = stack.store.manuscriptDir(projectId);
      await mkdir(join(manuscriptDir, "sections"), { recursive: true });
      await writeFile(join(manuscriptDir, "main.tex"), `\\documentclass{article}\n\\begin{document}\n${chapters.map((chapter) => `\\input{${chapter.file.replace(/\.tex$/, "")}}`).join("\n")}\n\\end{document}\n`);
      for (const chapter of chapters) await writeFile(join(manuscriptDir, chapter.file), chapter.content);
      await writeFile(join(manuscriptDir, "references.bib"), "@article{ref1,title={R1},year={2020}}");
      await services.revisions.commit(projectId, "baseline");
      const definition = createExistingPaperDefinition(services);
      const run = async (stageId: string) => {
        const stage = definition.stages.find((candidate) => candidate.id === stageId)!;
        if (!("execute" in stage)) throw new Error("wrong stage");
        const ctx = {
          projectId, runId: `fp-${stageId}`, attempt: 1, signal: new AbortController().signal,
          state: { workflowKind: "existing_paper_improvement", stageResults: {}, stageHistory: [], completedStages: [], inputs: {}, request: {} },
          emitProgress: async () => {}, emitDomain: async () => {}, log: () => {},
        } as unknown as StageRunContext;
        return stage.execute(ctx);
      };
      await run("review.run");
      expect(unitCalls).toBeGreaterThanOrEqual(CHAPTERS * 2);
      const summary = JSON.parse(await readFile(join(stack.store.reviewsDir(projectId), "review-summary-r1.json"), "utf8")) as { issues: Array<Record<string, unknown>> };
      const withQuote = summary.issues.filter((entry) => typeof entry["quote"] === "string");
      expect(withQuote).toHaveLength(2);
      // review.run 已把单元来源（file / 章节 span）附在 finding 上
      expect(withQuote[0]).toMatchObject({ file: "sections/ch2.tex", logicalSection: "section:Chapter 2" });

      await run("revision.plan");
      const plan = JSON.parse(await readFile(join(stack.store.reviewsDir(projectId), "revision-plan-r1.json"), "utf8")) as RevisionPlan;
      const findings = plan.items.filter((item) => item.kind === "review_finding" && item.status === "planned");
      expect(findings).toHaveLength(3);
      const resolved = findings.find((item) => item.problem === "论证薄弱")!;
      expect(resolved.targetProjection).toMatchObject({ status: "resolved", basis: "issue_quote", file: "sections/ch2.tex", scope: "section" });
      expect(resolved.logicalSection).toBe("section:Chapter 2");
      // targetQuote 是快照原文切片：必须在被审快照的 ch2 中恰好出现一次
      const ch2 = await readFile(join(services.revisions.snapshotDir(projectId, 1), "sections/ch2.tex"), "utf8");
      expect(ch2.split(resolved.targetQuote!).length - 1).toBe(1);
      const ambiguous = findings.find((item) => item.problem === "表述重复")!;
      expect(ambiguous.targetQuote).toBeUndefined();
      expect(ambiguous.targetProjection).toMatchObject({ status: "unresolved", reason: "ANCHOR_AMBIGUOUS" });
      const noAnchor = findings.find((item) => item.problem === "整章结构需要重排")!;
      expect(noAnchor.targetQuote).toBeUndefined();
      expect(noAnchor.targetProjection).toMatchObject({ status: "unresolved", reason: "NO_ANCHOR" });
    } finally {
      await stack.cleanup();
    }
  }, 60_000);
});
