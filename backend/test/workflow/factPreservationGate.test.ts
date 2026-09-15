/**
 * Fact Preservation Gate e2e（M5.6 第二层，scripted workflow）：
 *   [fact:mutate] 项目的修订输出会替换公式常量（\alpha→\beta）并新增无依据数值
 *   （8.7%→12.4%）→ quality.gate 的 fact_preservation FAIL（Final 被阻止）、
 *   revision.plan 派发 fact_preserve 恢复条目、accept_draft 也被 Draft 拦截
 *   （FACT_PRESERVATION_FAILED：被篡改的实验数据不能冻结为 Draft 产物）。
 *   默认脚本（修订保留既有事实）→ 规则 PASS；Quick Review 不含 quality.gate。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { WorkflowState } from "../../src/workflow/types.js";
import { scriptedIdeaRuntime, startTestStack, type TestStack } from "../helpers/testStack.js";

vi.setConfig({ testTimeout: 30_000 });

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
});

async function newStack(reviewSequence: ("pass" | "fail" | "fail2" | "fail3")[]): Promise<TestStack> {
  const scripted = scriptedIdeaRuntime({ reviewSequence });
  return startTestStack(scripted.runtime, { registerCleanup: (cleanup) => cleanups.push(cleanup) });
}

async function pollRun(stack: TestStack, runId: string, statuses: string[], timeoutMs = 25_000): Promise<WorkflowState> {
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

interface GateArtifact {
  gate: { passed: boolean; reasons: string[]; rules: { rule: string; passed: boolean; detail: string }[] };
  factPreservation?: {
    ok: boolean;
    changedFacts: unknown[];
    removedFacts: unknown[];
    addedUnsupportedFacts: { reason: string }[];
    directionalChanges: unknown[];
    formulaChanges: unknown[];
    placeholderRegressions: unknown[];
  } | null;
}

async function readGate(stack: TestStack, projectId: string, round: number): Promise<GateArtifact> {
  return JSON.parse(await readFile(join(stack.root, projectId, "reviews", `quality-gate-r${round}.json`), "utf8")) as GateArtifact;
}

describe("Fact Preservation Gate（scripted workflow）", () => {
  it("[fact:mutate]：修订篡改公式与数值 → gate FAIL、plan 派发 fact_preserve、Draft 被拦截", async () => {
    const stack = await newStack(["fail", "pass"]);
    const project = await stack.store.create("事实篡改回归", { researchIdea: "[fact:mutate] 检索增强生成" });
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;

    await approveTwice(stack, runId);
    // r1 fail → revise（篡改）→ r2 pass 但 gate 失败 → plan r2 派发恢复条目 → revise（仍篡改）
    // → r3 pass → 失败集合相同 → CONVERGED → stalled HITL
    const stalled = await pollRun(stack, runId, ["awaiting_input"]);
    expect(stalled.awaiting?.stageId).toBe("hitl.revision_stalled");
    const gateReasons = stalled.awaiting?.payload?.["gateReasons"] as string[];
    expect(gateReasons.join("\n")).toContain("fact_preservation");

    // r1（骨架 → 写作）：新章节文件不参与新增审查 → PASS
    const r1 = await readGate(stack, project.id, 1);
    const r1Rule = r1.gate.rules.find((rule) => rule.rule === "fact_preservation");
    expect(r1Rule?.passed).toBe(true);
    // r2（写作 → 修订）：公式常量被换 + 无依据数值新增 → FAIL
    const r2 = await readGate(stack, project.id, 2);
    expect(r2.gate.passed).toBe(false);
    expect(r2.gate.reasons.join("\n")).toContain("fact_preservation");
    expect(r2.factPreservation?.ok).toBe(false);
    // 公式常量被替换（\alpha→\beta）：缺失 + 新增都被捕获。
    // 注：mutate 行新增的 8.7%/12.4% 恰好被本场景 Evidence 覆盖（fail finding 的
    // 「Evidence 只支持 8.7%」），按授权模型正确放行——新增检测由单元测试覆盖。
    expect(r2.factPreservation?.formulaChanges.length).toBeGreaterThanOrEqual(1);
    expect(r2.factPreservation?.addedUnsupportedFacts.some((finding) => finding.reason === "formula_added")).toBe(true);

    // 计划派发 fact_preserve 恢复条目（有章节归属，可执行）
    const plan = JSON.parse(
      await readFile(join(stack.root, project.id, "reviews", "revision-plan-r2.json"), "utf8"),
    ) as { items: { id: string; kind: string; status: string; section: string; priority: string }[] };
    const factItems = plan.items.filter((item) => item.kind === "fact_preserve");
    expect(factItems.length).toBeGreaterThanOrEqual(1);
    expect(factItems.every((item) => item.status === "planned" && item.priority === "high")).toBe(true);

    // 用户接受草稿：实验事实被篡改 → Draft 产物被拦截（run failed，FACT_PRESERVATION_FAILED）
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "accept_draft" });
    const finished = await pollRun(stack, runId, ["failed", "completed"]);
    expect(finished.status).toBe("failed");
    const failure = finished.error;
    expect(failure?.code ?? failure?.["code"]).toBe("FACT_PRESERVATION_FAILED");
    expect(String(failure?.message ?? "")).toContain("实验事实保持未通过");
    const { events } = await stack.orchestrator.readEvents(runId);
    const blockedEvent = events.find((event) => event.type === "fact_preservation.blocked_draft");
    expect(blockedEvent).toBeDefined();
    // 没有 Draft / Final 产物冻结
    const { body } = await stack.request("GET", `/api/projects/${project.id}/artifacts`);
    const artifacts = (body["artifacts"] ?? []) as { kind: string }[];
    expect(artifacts.some((artifact) => artifact.kind === "draft" || artifact.kind === "final")).toBe(false);
  });

  it("默认脚本（修订保留既有公式与数值）：fail → pass 照旧 Final，fact_preservation 规则 PASS", async () => {
    const stack = await newStack(["fail", "pass"]);
    const project = await stack.store.create("事实保持通过", { researchIdea: "检索增强生成" });
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;
    await approveTwice(stack, runId);
    const finished = await pollRun(stack, runId, ["completed"]);
    expect(finished.completion?.label).toBe("final");
    const r2 = await readGate(stack, project.id, 2);
    const rule = r2.gate.rules.find((entry) => entry.rule === "fact_preservation");
    expect(rule?.passed).toBe(true);
    expect(rule?.detail).toContain("实验事实保持通过");
    expect(r2.factPreservation?.ok).toBe(true);
    // 手动重评与 stage 同口径：POST /quality-gate 也产出事实保持规则
    const reevaluated = await stack.request("POST", `/api/projects/${project.id}/quality-gate`);
    const rules = (reevaluated.body["gate"] as { rules: { rule: string; passed: boolean }[] }).rules;
    expect(rules.find((rule) => rule.rule === "fact_preservation")?.passed).toBe(true);
  });
});
