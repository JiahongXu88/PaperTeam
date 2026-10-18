/**
 * M14.9.1 C3：单文件 LaTeX 的编译修复限定到诊断所在编辑单元。
 *
 * 失败形态（M14.9 已知边界）：main.tex 含完整骨架、无大纲时，revision.repair_latex 把整文件交给
 * Writer 并要求「只输出正文片段」——正确修复必含骨架而被拒（REPAIR 永远失败）；即便模型返回片段，
 * 整文件覆盖也会毁掉论文。本组用例先复现旧行为，再锁定新行为：只修诊断所在单元、单元外逐字节
 * 不变；越界反例（改数值 / 增删引用 / 改 label / 写导言命令 / 过程说明 / 大段删减 / 导言区错误 /
 * 单元已变）全部拒绝不落盘。
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { BUILD_GATE_RECORD_FILE } from "../../src/quality/gates.js";
import { evaluateScopedLatexRepair, planScopedLatexRepair } from "../../src/review/scopedLatexRepair.js";
import type { RunAgentInput } from "../../src/runtime/types.js";
import { createExistingPaperDefinition } from "../../src/workflow/definitions.js";
import type { StageRunContext } from "../../src/workflow/types.js";
import { scriptedIdeaRuntime, startTestStack } from "../helpers/testStack.js";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

const MAIN = [
  "\\documentclass[UTF8]{ctexart}",
  "\\usepackage{amsmath}",
  "\\title{单文件稿件}",
  "\\begin{document}",
  "\\maketitle",
  "\\begin{abstract}",
  "本文研究一个关联修正问题，在 40 条序列上身份切换由 700 降至 497。",
  "\\end{abstract}",
  "\\section{引言}",
  "\\label{sec:intro}",
  "关联代价的运动项在失联期失真\\cite{Wojke2017DeepSORT}。",
  "\\section{方法}",
  "\\label{sec:method}",
  "代价定义为 $c = \\alpha d^2 + \\beta$，其中阈值取 9.4877\\badcommand。",
  "见第~\\ref{sec:intro} 节。",
  "\\section{结论}",
  "修正使 IDSW 由 121 降至 80。",
  "\\end{document}",
  "",
].join("\n");
const ERROR_LINE = MAIN.split("\n").findIndex((line) => line.includes("\\badcommand")) + 1;
const FIXED_UNIT = "\\section{方法}\n\\label{sec:method}\n代价定义为 $c = \\alpha d^2 + \\beta$，其中阈值取 9.4877。\n见第~\\ref{sec:intro} 节。\n";

const diagnostic = (line: number | null) => ({ file: "main.tex", line, message: "Undefined control sequence.", contextLines: ["l.14 ...\\badcommand"] });

describe("planScopedLatexRepair / evaluateScopedLatexRepair（确定性守卫）", () => {
  it("诊断行 → 所在章节单元；导言区 / 无行号诊断如实标为不可修复", () => {
    const plan = planScopedLatexRepair("main.tex", MAIN, [diagnostic(ERROR_LINE), diagnostic(2), diagnostic(null)]);
    expect(plan.targets.map((target) => target.unit.logicalSection)).toEqual(["sec:method"]);
    expect(plan.targets[0]!.diagnostics[0]!.line).toBe(3); // 单元内相对行号
    expect(plan.unrepairable.map((entry) => entry.reason)).toEqual(["PREAMBLE_OR_OUTSIDE_UNITS", "NO_LINE"]);
  });

  it("合法语法修复：只替换目标单元，单元外逐字节不变", () => {
    const target = planScopedLatexRepair("main.tex", MAIN, [diagnostic(ERROR_LINE)]).targets[0]!;
    const verdict = evaluateScopedLatexRepair({ file: "main.tex", source: MAIN, target, repaired: FIXED_UNIT });
    expect(verdict.violations).toEqual([]);
    expect(verdict.ok).toBe(true);
    expect(verdict.candidate).toBe(MAIN.replace("9.4877\\badcommand", "9.4877"));
    expect(verdict.candidate!.slice(0, target.unit.start)).toBe(MAIN.slice(0, target.unit.start));
  });

  it.each([
    ["改动数值", FIXED_UNIT.replace("9.4877", "9.21"), /FACT_PRESERVATION/],
    ["新增引用", FIXED_UNIT.replace("。\n见", "\\cite{Zhang2022ByteTrack}。\n见"), /CITATION_CHANGED/],
    ["删除 label", FIXED_UNIT.replace("\\label{sec:method}\n", ""), /LABEL_CHANGED/],
    ["写导言命令", `\\usepackage{xcolor}\n${FIXED_UNIT}`, /SKELETON_OR_PREAMBLE_COMMAND/],
    ["返回整篇骨架", MAIN.replace("\\badcommand", ""), /SKELETON_OR_PREAMBLE_COMMAND/],
    ["附带修订说明", `${FIXED_UNIT}\n本次重提交按编辑单元边界只删除了未定义命令，校验失败已解决。\n`, /WRITER_PROCESS_COMMENTARY/],
    ["大段删减", "\\section{方法}\n\\label{sec:method}\n见第~\\ref{sec:intro} 节。\n", /SIZE_DRIFT|FACT_PRESERVATION/],
  ])("越界反例：%s → 拒绝、不产生候选", (_name, repaired, expected) => {
    const target = planScopedLatexRepair("main.tex", MAIN, [diagnostic(ERROR_LINE)]).targets[0]!;
    const verdict = evaluateScopedLatexRepair({ file: "main.tex", source: MAIN, target, repaired });
    expect(verdict.ok).toBe(false);
    expect(verdict.candidate).toBeUndefined();
    expect(verdict.violations.join(" ")).toMatch(expected);
  });

  it("单元原文已变化（过期目标）→ REVISION_TARGET_STALE", () => {
    const target = planScopedLatexRepair("main.tex", MAIN, [diagnostic(ERROR_LINE)]).targets[0]!;
    const verdict = evaluateScopedLatexRepair({ file: "main.tex", source: MAIN.replace("阈值取", "阈值设为"), target, repaired: FIXED_UNIT });
    expect(verdict.violations[0]).toMatch(/REVISION_TARGET_STALE/);
  });
});

describe("revision.repair_latex 单文件稿件（stage 级）", () => {
  async function setup(repairOutput: (input: RunAgentInput) => string) {
    const scripted = scriptedIdeaRuntime();
    const repairPrompts: string[] = [];
    const runtime = {
      ...scripted.runtime,
      runAgent: async (input: RunAgentInput) => {
        if (input.contextScope !== "writing/repair") throw new Error(`unexpected scope ${input.contextScope}`);
        repairPrompts.push(input.task);
        const now = new Date().toISOString();
        return { taskId: `repair-${repairPrompts.length}`, agentId: input.agentId, status: "completed" as const, createdAt: now, updatedAt: now, output: repairOutput(input), events: [] };
      },
    };
    const stack = await startTestStack(runtime, { registerCleanup: (cleanup) => cleanups.push(cleanup) });
    const projectId = (await stack.store.create("Single-file repair fixture", { language: "zh" })).id;
    const services = stack.stack.workflowServices;
    const manuscriptDir = stack.store.manuscriptDir(projectId);
    await mkdir(manuscriptDir, { recursive: true });
    await writeFile(join(manuscriptDir, "main.tex"), MAIN, "utf8");
    await services.revisions.commit(projectId, "baseline");
    await mkdir(stack.store.buildDir(projectId), { recursive: true });
    await writeFile(join(stack.store.buildDir(projectId), BUILD_GATE_RECORD_FILE), JSON.stringify({
      passed: false, reasons: ["compile failed"], checkedAt: new Date().toISOString(), revision: 1,
      compile: { ok: false }, diagnostics: [diagnostic(ERROR_LINE)],
    }), "utf8");
    const stage = createExistingPaperDefinition(services).stages.find((entry) => entry.id === "revision.repair_latex")!;
    const run = async () => {
      if (!("execute" in stage)) throw new Error("wrong stage");
      const ctx = {
        projectId, runId: "w-repair-single", attempt: 1, signal: new AbortController().signal,
        state: { workflowKind: "existing_paper_improvement", stageResults: { "build.draft": { buildOk: false, buildError: "! Undefined control sequence." } }, stageHistory: [], completedStages: [], inputs: {}, request: {} },
        emitProgress: async () => {}, emitDomain: async () => {}, log: () => {},
      } as unknown as StageRunContext;
      return stage.execute(ctx) as Promise<Record<string, unknown>>;
    };
    const read = () => readFile(join(manuscriptDir, "main.tex"), "utf8");
    return { run, read, repairPrompts };
  }

  it("模型只收到诊断所在单元（不是整篇），合法修复只改该单元并提交修订", async () => {
    const { run, read, repairPrompts } = await setup(() => FIXED_UNIT);
    const result = await run();
    expect(repairPrompts).toHaveLength(1);
    expect(repairPrompts[0]).toContain("\\badcommand");
    expect(repairPrompts[0]).not.toContain("\\documentclass");
    expect(repairPrompts[0]).not.toContain("修正使 IDSW 由 121 降至 80");
    expect(await read()).toBe(MAIN.replace("9.4877\\badcommand", "9.4877"));
    expect(result["repairedFiles"]).toEqual(["main.tex"]);
    expect(result["scopedRepairs"]).toMatchObject([{ applied: ["sec:method"], rejected: [] }]);
  });

  it("模型越界（改数值 / 返回整篇骨架）→ 拒绝、稿件逐字节不变", async () => {
    for (const output of [FIXED_UNIT.replace("9.4877", "9.21"), MAIN.replace("\\badcommand", "")]) {
      const { run, read } = await setup(() => output);
      const result = await run();
      expect(await read()).toBe(MAIN);
      expect(result["repairedFiles"]).toEqual([]);
      const scoped = result["scopedRepairs"] as Array<{ rejected: Array<{ violations: string[] }> }>;
      expect(scoped[0]!.rejected[0]!.violations.join(" ")).toMatch(/FACT_PRESERVATION|骨架|SKELETON/);
    }
  });
});
