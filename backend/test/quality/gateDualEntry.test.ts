/**
 * M14.9.5.4 双入口一致性（真实编排 + scripted Runtime）：同一项目同一轮次，workflow 的 quality.gate stage 与手动
 * POST /quality-gate 必须给出相同的规则集合、执行状态、判定与输入指纹（旧实现手动入口少 cumulative / claim 审计 /
 * evidence coverage 等规则，判定可以不同）。覆盖 Final（PASS）与 Draft（FAIL）两种终态。
 */
import { afterAll, describe, expect, it } from "vitest";

import { scriptedIdeaRuntime, startTestStack, type TestStack } from "../helpers/testStack.js";
import type { WorkflowState } from "../../src/workflow/types.js";
import type { QualityGateResult } from "../../src/quality/gates.js";

const cleanups: Array<() => Promise<void>> = [];
afterAll(async () => { for (const cleanup of cleanups.reverse()) await cleanup(); });

async function pollRun(stack: TestStack, runId: string, statuses: string[], timeoutMs = 40_000): Promise<WorkflowState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = (await stack.request("GET", `/api/runs/${runId}`)).body["run"] as WorkflowState;
    if (statuses.includes(run.status)) return run;
    if (run.status === "awaiting_input" && !statuses.includes("awaiting_input")) {
      // 修订轮次用尽 → 接受 Draft；其余 HITL（大纲 / 计划确认）→ 批准
      const decision = run.awaiting?.stageId === "hitl.revision_overflow" ? "accept_draft" : "approve";
      await stack.request("POST", `/api/runs/${runId}/resume`, { decision });
      await new Promise((resolve) => setTimeout(resolve, 20));
      continue;
    }
    if (Date.now() > deadline) throw new Error(`等待 run 状态 ${statuses.join("|")} 超时（当前 ${run.status}，stage ${run.currentStage}）`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

const shape = (gate: QualityGateResult) =>
  gate.rules.map((rule) => ({ rule: rule.rule, status: rule.status, required: rule.required, passed: rule.passed, detail: rule.detail }));

async function runAndCompare(reviewSequence: ("pass" | "fail" | "fail2" | "fail3")[], expectedLabel: "final" | "draft") {
  const scripted = scriptedIdeaRuntime({ reviewSequence });
  const stack = await startTestStack(scripted.runtime, { registerCleanup: (cleanup) => cleanups.push(cleanup) });
  const project = await stack.store.create(`双入口 ${expectedLabel}`);
  const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
  const runId = created.body["runId"] as string;
  const finished = await pollRun(stack, runId, ["completed", "failed"]);
  expect(finished.status).toBe("completed");
  expect(finished.completion?.label).toBe(expectedLabel);

  const stored = await stack.request("GET", `/api/projects/${project.id}/quality-gate`);
  const workflowGate = stored.body["gate"] as QualityGateResult;
  expect(workflowGate.evaluation?.entry).toBe("workflow");
  expect(workflowGate.evaluation?.runId).toBe(runId);

  const manual = await stack.request("POST", `/api/projects/${project.id}/quality-gate`);
  expect(manual.status).toBe(200);
  const manualGate = manual.body["gate"] as QualityGateResult;
  expect(manual.body["round"]).toBe(stored.body["round"]);
  expect(manualGate.evaluation).toMatchObject({ entry: "manual", runId, workflowKind: workflowGate.evaluation?.workflowKind, contextGaps: [] });
  expect(shape(manualGate)).toEqual(shape(workflowGate));
  expect(manualGate.passed).toBe(workflowGate.passed);
  expect(manualGate.reasons).toEqual(workflowGate.reasons);
  expect(manualGate.verification).toEqual(workflowGate.verification);
  expect(manualGate.evaluation?.inputFingerprint).toBe(workflowGate.evaluation?.inputFingerprint);
  return workflowGate;
}

describe("M14.9.5.4 Quality Gate 双入口一致性", () => {
  it("Final 终态：workflow gate PASS ≡ 手动重评 PASS（规则 / 状态 / 指纹逐项相同）", async () => {
    const gate = await runAndCompare(["pass"], "final");
    expect(gate.passed).toBe(true);
    expect(gate.verification?.requiredComplete).toBe(true);
  }, 60_000);

  it("Draft 终态：workflow gate FAIL ≡ 手动重评 FAIL", async () => {
    const gate = await runAndCompare(["fail", "fail2", "fail3"], "draft");
    expect(gate.passed).toBe(false);
  }, 60_000);
});
