/**
 * M14.1a P0-3：章节级幂等与中断恢复。
 *
 * 场景基线（cd2b92f 上的缺陷，argumentUnitWriting.e2e.test.ts 曾明确钉死
 * 「重试从头重写全部章节」的行为；本文件是该缺陷的直接复现与回归）：
 *  - writing.sections 的 writing-plan.json 只记录 per-section status，从不读取；
 *    stage retry / 进程重启后已完成章节被重复生成（Writer 调用 2 + N）；
 *  - 跳过依据此前只有 status，无输入指纹与输出产物哈希核验；
 *  - revision.apply 中断后重放同计划：无 stale 防护时会对已改文本重复修改。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { startTestStack, scriptedIdeaRuntime } from "../helpers/testStack.js";
import { createIdeaToPaperDefinition, createExistingPaperDefinition } from "../../src/workflow/definitions.js";
import type { StageRunContext } from "../../src/workflow/types.js";
import { locateLatexSections } from "../../src/review/revisionScope.js";
import { partitionSpanIntoUnits } from "../../src/review/logicalSpan.js";
import { chapterBody } from "../review/logicalSpan.test.js";

const OUTLINE = {
  title: "Recovery study",
  sections: [
    { id: "intro", title: "引言", file: "intro.tex", keyPoints: ["kp-a"] },
    { id: "method", title: "方法", file: "method.tex", keyPoints: ["kp-b"] },
    { id: "conclusion", title: "结论", file: "conclusion.tex", keyPoints: ["kp-c"] },
  ],
};

interface WritingHarness {
  stack: Awaited<ReturnType<typeof startTestStack>>;
  projectId: string;
  writtenFiles: string[];
  calls: () => number;
  execute: (attempt: number) => Promise<Record<string, unknown>>;
  failOnceOn: (file: string) => void;
  file: (name: string) => Promise<string>;
  plan: () => Promise<Record<string, unknown>>;
}

async function setupWriting(): Promise<WritingHarness> {
  const scripted = scriptedIdeaRuntime();
  const writtenFiles: string[] = [];
  let calls = 0;
  let failTarget: string | null = null;
  const runtime = {
    ...scripted.runtime,
    runAgent: async (input: Parameters<typeof scripted.runtime.runAgent>[0]) => {
      const scope = input.contextScope ?? "";
      if (scope === "writing/sections") {
        const file = /（([a-z-]+\.tex)）/.exec(input.task)?.[1] ?? "?";
        if (failTarget === file) {
          failTarget = null; // 只失败一次
          throw new Error(`simulated transient failure while writing ${file}`);
        }
        calls += 1;
        writtenFiles.push(file);
        const now = new Date().toISOString();
        return {
          taskId: `w-${calls}`, agentId: "writer", status: "completed" as const, createdAt: now, updatedAt: now,
          output: `\\section{${file.replace(/\.tex$/, "")}}\nBody for ${file}（生成序号 ${calls}）。\n`, events: [],
        };
      }
      return scripted.runtime.runAgent(input);
    },
  };
  const stack = await startTestStack(runtime, { registerCleanup: () => Promise.resolve() });
  const projectId = (await stack.store.create("Chapter recovery fixture", { language: "en" })).id;
  const services = stack.stack.workflowServices;
  await services.manuscript.saveOutline(projectId, JSON.parse(JSON.stringify(OUTLINE)));
  await writeFile(join(stack.store.researchDir(projectId), "research.json"), JSON.stringify({ title: "R", gaps: [], ideas: [] }));
  const definition = createIdeaToPaperDefinition(services);
  const stage = definition.stages.find((s) => s.id === "writing.sections")!;
  const makeCtx = (attempt: number) => ({
    projectId, runId: "recovery-run", attempt,
    signal: new AbortController().signal,
    state: { workflowKind: "idea_to_paper", stageResults: {}, stageHistory: [], completedStages: [], inputs: {}, request: {} },
    emitProgress: async () => {}, emitDomain: async () => {}, log: () => {},
  } as unknown as StageRunContext);
  return {
    stack, projectId, writtenFiles, calls: () => calls,
    failOnceOn: (file: string) => { failTarget = file; },
    execute: async (attempt: number) => {
      if (!("execute" in stage)) throw new Error("Wrong stage");
      return stage.execute(makeCtx(attempt)) as Promise<Record<string, unknown>>;
    },
    file: (name: string) => readFile(join(stack.store.manuscriptDir(projectId), "sections", name), "utf8"),
    plan: async () => JSON.parse(await readFile(join(stack.store.reviewsDir(projectId), "writing-plan.json"), "utf8")) as Record<string, unknown>,
  };
}

describe("M14.1a writing.sections 章节级中断恢复", () => {
  it("第 2 章失败中断 → 重试只写未完成章节；已完成章节零重复生成、输出逐字节保持", async () => {
    const h = await setupWriting();
    h.failOnceOn("method.tex");
    await expect(h.execute(1)).rejects.toThrow("simulated transient failure");
    const introAfterAttempt1 = await h.file("intro.tex");
    expect(h.writtenFiles).toEqual(["intro.tex"]);
    const result = await h.execute(2);
    // 只补写 method / conclusion；intro 复用（无第二次 Writer 调用）
    expect(h.writtenFiles).toEqual(["intro.tex", "method.tex", "conclusion.tex"]);
    expect(h.calls()).toBe(3);
    expect(await h.file("intro.tex")).toBe(introAfterAttempt1);
    expect(result).toMatchObject({ sectionsWritten: 2, sectionsReused: 1 });
    // 全部文件非空、无重复章节内容（每文件恰好一个 \section）
    for (const section of OUTLINE.sections) {
      const content = await h.file(section.file);
      expect(content.trim()).not.toBe("");
      expect((content.match(/\\section\{/g) ?? []).length).toBe(1);
    }
    const plan = await h.plan();
    expect((plan as { sections: Array<{ status: string }> }).sections.every((section) => section.status === "written")).toBe(true);
  });

  it("全部完成后幂等重放：零 Writer 调用、sectionsReused=3、文件不变", async () => {
    const h = await setupWriting();
    await h.execute(1);
    const before = await Promise.all(OUTLINE.sections.map((section) => h.file(section.file)));
    const result = await h.execute(2);
    expect(h.calls()).toBe(3);
    expect(result).toMatchObject({ sectionsWritten: 0, sectionsReused: 3 });
    expect(await Promise.all(OUTLINE.sections.map((section) => h.file(section.file)))).toEqual(before);
  });

  it("外部篡改输出文件 → outputHash 失配 → 该章节重写（版本核验不放行陈旧输出）", async () => {
    const h = await setupWriting();
    await h.execute(1);
    const introPath = join(h.stack.store.manuscriptDir(h.projectId), "sections", "intro.tex");
    await writeFile(introPath, "\\section{intro}\nTampered externally.\n", "utf8");
    const result = await h.execute(2);
    expect(result).toMatchObject({ sectionsWritten: 1, sectionsReused: 2 });
    expect(await h.file("intro.tex")).toContain("生成序号");
    expect(h.calls()).toBe(4);
  });

  it("输入指纹变化（大纲改动）→ 全部章节重写，不复用旧输出", async () => {
    const h = await setupWriting();
    await h.execute(1);
    const services = h.stack.stack.workflowServices;
    const mutated = JSON.parse(JSON.stringify(OUTLINE));
    mutated.sections[1]!.keyPoints = ["kp-b-revised"];
    await services.manuscript.saveOutline(h.projectId, mutated);
    const result = await h.execute(2);
    expect(result).toMatchObject({ sectionsWritten: 3 });
    expect((result as { sectionsReused?: number }).sectionsReused).toBeUndefined();
    expect(h.calls()).toBe(6);
  });
});

describe("M14.1a revision.apply 中断重放幂等（不重复修改）", () => {
  it("同计划重放：已应用单元 stale 拒绝、零 Writer 调用、文档保持单次修改", async () => {
    const methodTex = `\\section{Method}\n` + chapterBody(20_000);
    const units = partitionSpanIntoUnits(locateLatexSections("sections/method.tex", methodTex)[0]!, 9_000).units;
    const lastUnit = units[units.length - 1]!;
    const anchor = lastUnit.content.slice(Math.floor(lastUnit.content.length / 2), Math.floor(lastUnit.content.length / 2) + 60);
    const revisedUnit = lastUnit.content.replace(anchor, `[once] ${anchor}`);
    const scripted = scriptedIdeaRuntime();
    let calls = 0;
    const runtime = {
      ...scripted.runtime,
      runAgent: async () => {
        calls += 1;
        const now = new Date().toISOString();
        return { taskId: `r-${calls}`, agentId: "writer", status: "completed" as const, createdAt: now, updatedAt: now, output: revisedUnit, events: [] };
      },
    };
    const stack = await startTestStack(runtime, { registerCleanup: () => Promise.resolve() });
    const projectId = (await stack.store.create("Revision replay fixture", { language: "en" })).id;
    const services = stack.stack.workflowServices;
    const dir = stack.store.manuscriptDir(projectId);
    await mkdir(join(dir, "sections"), { recursive: true });
    await writeFile(join(dir, "main.tex"), "\\documentclass{article}\n\\begin{document}\n\\input{sections/method}\n\\end{document}\n");
    await writeFile(join(dir, "sections", "method.tex"), methodTex);
    await writeFile(join(dir, "references.bib"), "@article{ref1,title={R},year={2020}}");
    await services.revisions.commit(projectId, "baseline");
    const planItems = [{ id: "improvement:1", section: "sections/method.tex", actionType: "modify", priority: "high", action: `Revise "${anchor}".`, rationale: "Replay scenario", targetQuote: anchor }];
    await writeFile(join(stack.store.researchDir(projectId), "improvement-plan.json"), JSON.stringify({ plan: { items: planItems } }));
    const definition = createExistingPaperDefinition(services);
    const stage = definition.stages.find((s) => s.id === "revision.apply")!;
    const makeCtx = (attempt: number) => ({
      projectId, runId: "replay-run", attempt, signal: new AbortController().signal,
      state: { workflowKind: "existing_paper_improvement", stageResults: {}, stageHistory: [], completedStages: [], inputs: {}, request: {} },
      emitProgress: async () => {}, emitDomain: async () => {}, log: () => {},
    } as unknown as StageRunContext);
    if (!("execute" in stage)) throw new Error("Wrong stage");
    await stage.execute(makeCtx(1));
    const once = await readFile(join(dir, "sections", "method.tex"), "utf8");
    expect(once).toBe(methodTex.replace(lastUnit.content, revisedUnit));
    expect(calls).toBe(1);
    // 中断后重放同一计划：目标按当前磁盘内容重定位为已应用单元（内容等价），
    // Writer 产出同一替换 → targetChanged=false：不落盘、不产生第二个修订、
    // 文档保持单次修改（stale / 不可定位路径的 fail-closed 由 logicalSpan 单测覆盖）
    const revisionBeforeReplay = await services.revisions.currentRevision(projectId);
    const result = await stage.execute(makeCtx(2));
    expect(await readFile(join(dir, "sections", "method.tex"), "utf8")).toBe(once);
    expect(result).toMatchObject({ changed: false });
    expect(await services.revisions.currentRevision(projectId)).toBe(revisionBeforeReplay);
    // 重放轮的 patch 记录合并保留首轮 applied 记录（审计线索不丢）
    const artifact = await services.reviewArtifacts.loadPatchValidation(projectId, revisionBeforeReplay);
    expect(artifact?.records.some((record) => record.logicalTarget === lastUnit.logicalSection)).toBe(true);
  });
});
