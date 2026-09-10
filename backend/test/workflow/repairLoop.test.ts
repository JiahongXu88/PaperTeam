/**
 * M4.7 bounded LaTeX repair loop（编译失败 → Writer 最小上下文修复）。
 *
 * 场景（规格 G / H + 可取消）：
 * - G：首轮编译失败（诊断定位到 sections/*.tex）→ 修复 1 次 → 复审 → 重编译通过 → Final
 * - H：持续编译失败 → 修复上限（2 次）后不再修复，转修订预算 → 耗尽 → overflow
 *      accept_draft → Draft（buildOk=false 如实记录，不产 PDF）
 * - 诊断只指向组装根 main.tex → 修复空尝试（不覆盖组装产物，预算照耗 → overflow）
 * - 取消：修复执行中协作式取消生效
 *
 * 编译失败通过注入 CommandRunner 模拟：stdout 携带 TeX 形态的文件栈 + "! Error" + l.N
 * 行号，LatexCompiler 会把它写进 build/compile.log，诊断解析据此定位文件。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { AgentRuntime, RunAgentInput } from "../../src/runtime/types.js";
import type { CommandRunner } from "../../src/latex/LatexCompiler.js";
import type { WorkflowState } from "../../src/workflow/types.js";
import {
  scriptedIdeaRuntime,
  startTestStack,
  type TestStack,
} from "../helpers/testStack.js";

vi.setConfig({ testTimeout: 60_000 });

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
});

/** 前 failFirst 次编译失败（诊断定位 sections/introduction.tex），之后成功 */
function flakyRunner(failFirst: number): CommandRunner {
  let compiles = 0;
  return async (command, args) => {
    if (args.includes("--version")) {
      return { code: 0, stdout: `${command} 1.0`, stderr: "" };
    }
    compiles += 1;
    if (compiles <= failFirst) {
      return {
        code: 1,
        stdout: [
          "(./main.tex (./sections/introduction.tex",
          "! Undefined control sequence.",
          "l.5 \\badcommand",
          "",
        ].join("\n"),
        stderr: "",
      };
    }
    const outputDir = args.find((arg) => arg.startsWith("-output-directory="));
    if (outputDir) {
      const { writeFile } = await import("node:fs/promises");
      await writeFile(join(outputDir.slice("-output-directory=".length), "main.pdf"), "%PDF-1.5");
    }
    return { code: 0, stdout: "compiled", stderr: "" };
  };
}

/** 编译失败且诊断只指向组装根 main.tex（文件栈没有更深的 section 文件） */
function rootOnlyRunner(): CommandRunner {
  return async (command, args) => {
    if (args.includes("--version")) {
      return { code: 0, stdout: `${command} 1.0`, stderr: "" };
    }
    return {
      code: 1,
      stdout: ["(./main.tex", "! Undefined control sequence.", "l.5 \\badcommand", ""].join("\n"),
      stderr: "",
    };
  };
}

/** 首个 writing/repair 模型调用挂起（修复中取消用） */
function hangOnRepairRuntime(base: AgentRuntime): { runtime: AgentRuntime; release: () => void } {
  let releaseHang: (() => void) | undefined;
  let consumed = false;
  const runtime: AgentRuntime = {
    ...base,
    runAgent: (input: RunAgentInput) => {
      if (input.contextScope === "writing/repair" && !consumed) {
        consumed = true;
        return new Promise<void>((resolve) => {
          releaseHang = resolve;
        }).then(() => base.runAgent(input));
      }
      return base.runAgent(input);
    },
  };
  return { runtime, release: () => releaseHang?.() };
}

async function newStack(
  options: { failFirst?: number; hangRepair?: boolean; rootOnly?: boolean } = {},
): Promise<{ stack: TestStack; release: () => void }> {
  const scripted = scriptedIdeaRuntime(); // review 全 pass：聚焦编译-修复链路
  const latexRunner = options.rootOnly === true ? rootOnlyRunner() : flakyRunner(options.failFirst ?? 0);
  let runtime: AgentRuntime = scripted.runtime;
  let release = scripted.release;
  if (options.hangRepair === true) {
    const wrapped = hangOnRepairRuntime(scripted.runtime);
    runtime = wrapped.runtime;
    release = wrapped.release;
  }
  const stack = await startTestStack(runtime, {
    latexRunner,
    registerCleanup: (cleanup) => cleanups.push(cleanup),
  });
  return { stack, release };
}

async function pollRun(
  stack: TestStack,
  runId: string,
  statuses: string[],
  timeoutMs = 50_000,
): Promise<WorkflowState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await stack.request("GET", `/api/runs/${runId}`);
    const run = body["run"] as WorkflowState;
    if (statuses.includes(run.status)) {
      return run;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 run 状态 ${statuses.join("|")} 超时（当前 ${run.status}，stage ${run.currentStage}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function approveTwice(stack: TestStack, runId: string): Promise<void> {
  await pollRun(stack, runId, ["awaiting_input"]);
  await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
  await pollRun(stack, runId, ["awaiting_input"]);
  await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
}

function completions(run: WorkflowState, stageId: string): number {
  return run.stageHistory.filter((record) => record.stageId === stageId && record.status === "completed")
    .length;
}

describe("bounded LaTeX repair loop", () => {
  it("G：编译失败 → 修复 1 次（最小上下文）→ 复审 → 重编译通过 → Final", async () => {
    const { stack } = await newStack({ failFirst: 1 });
    const project = await stack.store.create("修复成功测试");
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;

    await approveTwice(stack, runId);
    const finished = await pollRun(stack, runId, ["completed", "failed"]);

    expect(finished.status).toBe("completed");
    expect(finished.completion?.label).toBe("final");
    // 恰好 1 次修复；修复后复审（2 轮 review）并重编译
    expect(completions(finished, "revision.repair_latex")).toBe(1);
    expect(completions(finished, "review.run")).toBe(2);
    expect(completions(finished, "build.draft")).toBe(2);
    // Writer 修复只动目标文件（诊断定位 introduction.tex）
    const repaired = await readFile(
      join(stack.root, project.id, "manuscript", "sections", "introduction.tex"),
      "utf8",
    );
    expect(repaired).toContain("修复后的表述");
    expect(repaired).not.toContain("\\documentclass"); // 只修语法，不引入文档骨架
    // 产物：修复产生的修订上完成双 Gate
    const pdf = await readFile(join(stack.root, project.id, "build", "paper.pdf"), "utf8");
    expect(pdf).toContain("%PDF-1.5");
    const list = await stack.request("GET", `/api/projects/${project.id}/artifacts`);
    expect(list.body["finalUpToDate"]).toBe(true);
  });

  it("H：持续失败 → 修复上限 2 次（bounded）→ 修订预算耗尽 → overflow accept_draft → Draft（buildOk=false）", async () => {
    const { stack } = await newStack({ failFirst: 999 });
    const project = await stack.store.create("修复耗尽测试");
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;

    await approveTwice(stack, runId);
    const overflow = await pollRun(stack, runId, ["awaiting_input"]);
    expect(overflow.awaiting?.stageId).toBe("hitl.revision_overflow");
    // 修复被界定在 2 次；之后转入带 buildError 的修订（2 轮预算）
    expect(completions(overflow, "revision.repair_latex")).toBe(2);
    expect(completions(overflow, "revision.revise")).toBe(2);
    expect((overflow.awaiting?.payload?.["buildOk"] as boolean) ?? true).toBe(false);
    expect(overflow.awaiting?.payload?.["buildError"]).toBeTruthy();

    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "accept_draft" });
    const finished = await pollRun(stack, runId, ["completed"]);
    expect(finished.completion?.label).toBe("draft");
    expect(finished.completion?.summary?.["buildOk"]).toBe(false); // 如实记录：没有 PDF
    expect(finished.completion?.summary?.["draftArtifactId"]).toBeNull();
    // 修复次数不因 accept_draft 之后再增加
    expect(completions(finished, "revision.repair_latex")).toBe(2);
  });

  it("诊断只指向组装根 main.tex：修复跳过根文件（不覆盖组装产物），预算照耗 → overflow", async () => {
    const { stack } = await newStack({ rootOnly: true });
    const project = await stack.store.create("组装根诊断测试");
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;

    await approveTwice(stack, runId);
    // 修复 stage 对组装根只能「空尝试」：不失败、不覆盖 main.tex，走既有耗尽路径
    const overflow = await pollRun(stack, runId, ["awaiting_input", "failed"]);
    expect(overflow.status).toBe("awaiting_input");
    expect(overflow.awaiting?.stageId).toBe("hitl.revision_overflow");

    const repairs = overflow.stageHistory.filter(
      (record) => record.stageId === "revision.repair_latex" && record.status === "completed",
    );
    expect(repairs).toHaveLength(2); // bounded 预算照常消耗
    for (const record of repairs) {
      expect(record.summary?.["repairedFiles"]).toEqual([]);
      expect(record.summary?.["skippedAssembledRoot"]).toBe(true);
    }
    // 组装根从未被修复输出覆盖（仍是 writeMainTex 的确定性组装形态）
    const mainTex = await readFile(join(stack.root, project.id, "manuscript", "main.tex"), "utf8");
    expect(mainTex).toContain("\\documentclass");
    expect(mainTex).toContain("\\input{sections/introduction}");

    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "accept_draft" });
    const finished = await pollRun(stack, runId, ["completed"]);
    expect(finished.completion?.label).toBe("draft");
    expect(finished.completion?.summary?.["buildOk"]).toBe(false); // 如实：没有 PDF
  });

  it("修复执行中协作式取消：cancel 请求登记后生效，无修复完成记录", async () => {
    const { stack, release } = await newStack({ failFirst: 1, hangRepair: true });
    const project = await stack.store.create("修复取消测试");
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;
    await approveTwice(stack, runId);

    // 等到修复 stage 真正执行（runAgent 已挂起在 writing/repair）
    const deadline = Date.now() + 30_000;
    for (;;) {
      const { body } = await stack.request("GET", `/api/runs/${runId}`);
      const run = body["run"] as WorkflowState;
      if (run.status === "running" && run.currentStage === "revision.repair_latex") {
        break;
      }
      if (Date.now() > deadline) {
        throw new Error(`修复 stage 未开始（当前 ${run.status} / ${run.currentStage}）`);
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }

    const cancelResponse = await stack.request("POST", `/api/runs/${runId}/cancel`, {});
    expect(cancelResponse.status).toBe(200);
    release(); // 释放挂起的修复调用 → 边界处生效
    const cancelled = await pollRun(stack, runId, ["cancelled"]);
    expect(cancelled.status).toBe("cancelled");
    expect(completions(cancelled, "revision.repair_latex")).toBe(0); // 没有留下半个修复
  });
});
