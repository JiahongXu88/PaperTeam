/**
 * M16 原始目标收口 · A1：多文件 LaTeX 项目的 main.tex 实质正文进入审查（不漏、不重、导言区不进入）。
 *
 * 缺陷基线（8791708）：coverage 计划在有 \input 子文件时只取 files.sections——main.tex 中直接写的摘要 / 引言 /
 * 结论从未成为 Review Unit，而 review-coverage 仍报 ratio=1 / complete=true（假完整）。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startTestStack, scriptedIdeaRuntime } from "../helpers/testStack.js";
import { createExistingPaperDefinition } from "../../src/workflow/definitions.js";
import type { StageRunContext } from "../../src/workflow/types.js";
import type { ReviewSummary } from "../../src/review/ReviewAggregator.js";
import { chapterBody } from "../review/logicalSpan.test.js";

const PREAMBLE_SENTINEL = "PreambleMacroSentinel";
const ABSTRACT_SENTINEL = "Rootabstract sentinel: we report a 7.3 point gain on the KITTI tracking split.";
const INTRO_SENTINEL = "Rootintro sentinel paragraph explaining why occlusion breaks association.";
const CONCLUSION_SENTINEL = "Rootconclusion sentinel: the gain holds across three seeds.";

function child(name: string, chars: number): { file: string; content: string; tail: string } {
  const tail = `Childtail ${name} sentinel.`;
  return { file: `sections/${name}.tex`, content: `\\section{${name}}\n${chapterBody(chars, name)}\n\n${tail}\n`, tail };
}

interface RunOutcome {
  unitPrompts: string[];
  digestPrompts: string[];
  summary: ReviewSummary;
  plan: NonNullable<NonNullable<ReviewSummary["coverage"]>["sources"]>;
}

async function runReview(mainTex: string, children: Array<{ file: string; content: string }>): Promise<RunOutcome> {
  const scripted = scriptedIdeaRuntime();
  const unitPrompts: string[] = [];
  const digestPrompts: string[] = [];
  const runtime = {
    ...scripted.runtime,
    runAgent: async (input: Parameters<typeof scripted.runtime.runAgent>[0]) => {
      const scope = input.contextScope ?? "";
      if (scope === "review/academic/unit") {
        unitPrompts.push(input.task);
        const now = new Date().toISOString();
        return {
          taskId: `u${unitPrompts.length}`, agentId: "reviewer", status: "completed" as const, createdAt: now, updatedAt: now, events: [],
          output: JSON.stringify({ summary: "ok", issues: [], academicScore: 90, riskScore: 10 }),
        };
      }
      if (/^review\/(fact|academic|style)$/.test(scope)) digestPrompts.push(input.task);
      return scripted.runtime.runAgent(input);
    },
  };
  const stack = await startTestStack(runtime, { registerCleanup: () => Promise.resolve() });
  const projectId = (await stack.store.create("Root body coverage fixture", { language: "en" })).id;
  const services = stack.stack.workflowServices;
  const dir = stack.store.manuscriptDir(projectId);
  await mkdir(join(dir, "sections"), { recursive: true });
  await writeFile(join(dir, "main.tex"), mainTex);
  for (const c of children) await writeFile(join(dir, c.file), c.content);
  await writeFile(join(dir, "references.bib"), "@article{ref1,title={R1},year={2020}}");
  await services.revisions.commit(projectId, "baseline");
  const stage = createExistingPaperDefinition(services).stages.find((s) => s.id === "review.run")!;
  if (!("execute" in stage)) throw new Error("Wrong stage");
  await stage.execute({
    projectId, runId: "m16-root", attempt: 1, signal: new AbortController().signal,
    state: { workflowKind: "existing_paper_improvement", stageResults: {}, stageHistory: [], completedStages: [], inputs: {}, request: {} },
    emitProgress: async () => {}, emitDomain: async () => {}, log: () => {},
  } as unknown as StageRunContext);
  const reviews = stack.store.reviewsDir(projectId);
  const summary = JSON.parse(await readFile(join(reviews, "review-summary-r1.json"), "utf8")) as ReviewSummary;
  const plan = summary.coverage?.sources ?? { files: [], units: [] };
  return { unitPrompts, digestPrompts, summary, plan };
}

const count = (prompts: string[], needle: string) => prompts.filter((p) => p.includes(needle)).length;
const longChildren = [child("Method", 5_000), child("Experiments", 5_000)];
const inputsOf = (children: Array<{ file: string }>) => children.map((c) => `\\input{${c.file.replace(/\.tex$/, "")}}`);

function rootWithBody(children: Array<{ file: string }>): string {
  return [
    "\\documentclass{article}", `\\newcommand{\\${PREAMBLE_SENTINEL}}{x}`, "\\title{Fixture}", "\\begin{document}", "\\maketitle",
    "\\begin{abstract}", ABSTRACT_SENTINEL, "\\end{abstract}",
    "\\section{Introduction}", INTRO_SENTINEL, "Occlusion is the dominant failure mode in dense traffic scenes and we study it carefully.",
    ...inputsOf(children),
    "\\section{Conclusion}", CONCLUSION_SENTINEL, "Future work will extend the evaluation to nighttime sequences and more cameras.",
    "\\bibliography{references}", "\\end{document}", "",
  ].join("\n");
}

describe("M16 A1：多文件项目 main.tex 实质正文进入审查", () => {
  it("长文档单元模式：main.tex 摘要 / 引言 / 结论各进入且只进入一个单元；导言区不进入；子文件不重复；覆盖账本含 main.tex", async () => {
    const { unitPrompts, summary, plan } = await runReview(rootWithBody(longChildren), longChildren);
    expect(summary.coverage?.mode).toBe("units");
    for (const s of [ABSTRACT_SENTINEL, INTRO_SENTINEL, CONCLUSION_SENTINEL]) expect(count(unitPrompts, s), s).toBe(1);
    expect(count(unitPrompts, PREAMBLE_SENTINEL)).toBe(0);
    expect(count(unitPrompts, "\\documentclass")).toBe(0);
    for (const c of longChildren) expect(count(unitPrompts, c.tail), c.file).toBe(1);
    expect(plan.files.map((f) => f.file)).toContain("main.tex");
    const rootUnits = plan.units.filter((u) => u.file === "main.tex");
    expect(rootUnits.length).toBe(3); // frontmatter（摘要）+ Introduction + Conclusion
    // 计划单元 = 实际调度单元（无多审 / 漏审），且覆盖率计入 main.tex
    expect(unitPrompts).toHaveLength(plan.units.length);
    expect(summary.coverage?.targetUnits).toBe(plan.units.length);
    expect(summary.coverage?.complete).toBe(true);
  });

  it("纯组装根（只有 \\maketitle 与 \\input）：main.tex 不产生任何单元（不浪费调用）", async () => {
    const mainTex = ["\\documentclass{article}", "\\title{Fixture}", "\\begin{document}", "\\maketitle", ...inputsOf(longChildren), "\\end{document}", ""].join("\n");
    const { unitPrompts, plan } = await runReview(mainTex, longChildren);
    expect(plan.units.filter((u) => u.file === "main.tex")).toHaveLength(0);
    expect(unitPrompts).toHaveLength(plan.units.length);
  });

  it("无标题的根正文（摘要 + 段落 + \\input）：只取 \\begin{document} 之后的正文，导言区不进入", async () => {
    const mainTex = [
      "\\documentclass{article}", `\\newcommand{\\${PREAMBLE_SENTINEL}}{x}`, "\\begin{document}",
      "\\begin{abstract}", ABSTRACT_SENTINEL, "\\end{abstract}", INTRO_SENTINEL,
      ...inputsOf(longChildren), "\\end{document}", "",
    ].join("\n");
    const { unitPrompts, plan } = await runReview(mainTex, longChildren);
    expect(plan.units.filter((u) => u.file === "main.tex")).toHaveLength(1);
    expect(count(unitPrompts, ABSTRACT_SENTINEL)).toBe(1);
    expect(count(unitPrompts, INTRO_SENTINEL)).toBe(1);
    expect(count(unitPrompts, PREAMBLE_SENTINEL)).toBe(0);
  });

  it("短文档 digest 模式：main.tex 正文在 digest 中且覆盖计划如实列出 main.tex 单元", async () => {
    const shortChildren = [child("Method", 1_200), child("Experiments", 1_200)];
    const { unitPrompts, digestPrompts, summary, plan } = await runReview(rootWithBody(shortChildren), shortChildren);
    expect(summary.coverage?.mode).toBe("digest");
    expect(unitPrompts).toHaveLength(0);
    expect(digestPrompts.length).toBeGreaterThan(0);
    for (const s of [ABSTRACT_SENTINEL, INTRO_SENTINEL, CONCLUSION_SENTINEL]) expect(digestPrompts.every((p) => p.includes(s)), s).toBe(true);
    expect(plan.units.filter((u) => u.file === "main.tex").length).toBe(3);
  });
});
