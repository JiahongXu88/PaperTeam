/**
 * Revision Validation 全链路 e2e（M6.7，scripted workflow）：
 * - 干净修订（fail → pass）：revision.validate 通过、无额外 HITL、Final；
 *   validation 产物落盘 + plan 条目 validated + gate revision_items_resolved PASS
 * - [strength:escalate]：修订输出弱表述 → 强表述升级 → Revision Validation
 *   block 级拦截 → hitl.revision_validation（approve / reject / needs_review）
 *   - reject：恢复修订前快照（revision.restore）→ 复审通过 → Final（升级内容消失）
 *   - needs_review：保留修订但 Revision Gate 阻断 Final → 收敛 → Draft
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { WorkflowState } from "../../src/workflow/types.js";
import { scriptedIdeaRuntime, startTestStack, type TestStack } from "../helpers/testStack.js";

vi.setConfig({ testTimeout: 40_000 });

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup;
  }
});

async function newStack(reviewSequence: ("pass" | "fail" | "fail2" | "fail3")[]): Promise<TestStack> {
  const scripted = scriptedIdeaRuntime({ reviewSequence });
  return startTestStack(scripted.runtime, { registerCleanup: (cleanup) => cleanups.push(cleanup) });
}

async function pollRun(stack: TestStack, runId: string, statuses: string[], timeoutMs = 30_000): Promise<WorkflowState> {
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

/** 等待目标 HITL stage；途中出现的 revision_validation 按指定策略处理 */
async function pollHittl(
  stack: TestStack,
  runId: string,
  stageId: string,
  validationDecision: "approve" | "needs_review",
  timeoutMs = 30_000,
): Promise<WorkflowState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await pollRun(stack, runId, ["awaiting_input"], Math.max(1, deadline - Date.now()));
    if (run.awaiting?.stageId === stageId) {
      return run;
    }
    if (run.awaiting?.stageId === "hitl.revision_validation") {
      await stack.request("POST", `/api/runs/${runId}/resume`, { decision: validationDecision });
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 ${stageId} 超时（当前 awaiting ${run.awaiting?.stageId}）`);
    }
  }
}

async function readValidation(stack: TestStack, projectId: string, round: number): Promise<Record<string, unknown>> {
  return JSON.parse(
    await readFile(join(stack.root, projectId, "reviews", `revision-validation-r${round}.json`), "utf8"),
  );
}

describe("Revision Validation 全链路（M6.7）", () => {
  it("干净修订：validation 通过、无修订复核 HITL、Final；条目 validated 且 gate 规则 PASS", async () => {
    const stack = await newStack(["fail", "pass"]);
    const project = await stack.store.create("干净修订", {});
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;

    await approveTwice(stack, runId);
    const finished = await pollRun(stack, runId, ["completed", "failed"]);
    expect(finished.status).toBe("completed");
    expect(finished.completion?.label).toBe("final");
    // 修订复核 stage 执行且产物落盘
    expect(finished.stageHistory.some((record) => record.stageId === "revision.validate" && record.status === "completed")).toBe(true);
    const validation = (await readValidation(stack, project.id, 1)) as {
      ok: boolean;
      blocked: boolean;
      items: { status: string }[];
    };
    expect(validation.ok).toBe(true);
    expect(validation.blocked).toBe(false);
    expect(validation.items.length).toBeGreaterThan(0);
    expect(validation.items.every((item) => item.status === "validated")).toBe(true);
    // gate r2：revision_items_resolved 消费对齐的验证产物并 PASS
    const gate = JSON.parse(await readFile(join(stack.root, project.id, "reviews", "quality-gate-r2.json"), "utf8")) as {
      gate: { rules: { rule: string; passed: boolean }[] };
    };
    const rule = gate.gate.rules.find((entry) => entry.rule === "revision_items_resolved");
    expect(rule).toBeDefined();
    expect(rule?.passed).toBe(true);
    // 全程没有修订复核 HITL（干净路径不骚扰用户）
    expect(finished.stageHistory.some((record) => record.stageId === "hitl.revision_validation")).toBe(false);
    const { events } = await stack.orchestrator.readEvents(runId);
    expect(events.some((event) => event.type === "revision.validated")).toBe(true);
  });

  it("[strength:escalate] + reject：强 claim 弱证据被拦截 → 用户拒绝 → 恢复修订前快照 → 复审通过 → Final（升级内容消失）", async () => {
    const stack = await newStack(["fail", "pass"]);
    const project = await stack.store.create("强度升级拒绝", { researchIdea: "[strength:escalate] 检索增强生成" });
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;

    await approveTwice(stack, runId);
    // 修订输出强升级 → Revision Validation block → 修订复核 HITL（先于复审）
    const validationHitl = await pollRun(stack, runId, ["awaiting_input"]);
    expect(validationHitl.awaiting?.stageId).toBe("hitl.revision_validation");
    const payload = (validationHitl.awaiting?.payload ?? {}) as {
      items: { status: string; reasons: string[] }[];
      claimStrength: { action: string; markers: string[] }[];
    };
    expect(payload.items.some((item) => item.status === "rejected")).toBe(true);
    expect(payload.claimStrength.some((finding) => finding.action === "block")).toBe(true);

    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "reject" });
    const finished = await pollRun(stack, runId, ["completed", "failed"]);
    expect(finished.status).toBe("completed");
    expect(finished.completion?.label).toBe("final");
    // 升级句随 restore 消失（恢复到 sourceRevision 快照后复审通过）
    const introduction = await readFile(
      join(stack.root, project.id, "manuscript", "sections", "introduction.tex"),
      "utf8",
    );
    expect(introduction).not.toContain("显著提升");
    // 恢复产生新的不可变修订（reason=revision.restore），不是改写历史
    const revisions = JSON.parse(await readFile(join(stack.root, project.id, "manuscript", "revisions.json"), "utf8")) as {
      revisions: { reason: string; restoredFrom?: number }[];
    };
    const restore = revisions.revisions.find((record) => record.reason === "revision.restore");
    expect(restore?.restoredFrom).toBeDefined();
  });

  it("[strength:escalate] + needs_review：Revision Gate 阻断 Final → 收敛 → stalled → accept_draft → Draft", async () => {
    const stack = await newStack(["fail", "pass"]);
    const project = await stack.store.create("强度升级待复核", { researchIdea: "[strength:escalate] 检索增强生成" });
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;

    await approveTwice(stack, runId);
    // 两轮都升级 → 两轮 needs_review → Revision Gate 连续失败（失败集合相同）→ CONVERGED → stalled
    const stalled = await pollHittl(stack, runId, "hitl.revision_stalled", "needs_review");
    const gateReasons = (stalled.awaiting?.payload?.["gateReasons"] ?? []) as string[];
    expect(gateReasons.join("\n")).toContain("revision_items_resolved");
    expect(gateReasons.join("\n")).toContain("claim_strength_guard");

    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "accept_draft" });
    const finished = await pollRun(stack, runId, ["completed", "failed"]);
    // needs_review 不阻止 Draft（只阻止 Final）：用户知情接受后 Draft 可产出
    expect(finished.status).toBe("completed");
    expect(finished.completion?.label).toBe("draft");
    // 计划条目停在 needs_review（未人工确认不得 Final）
    const plan = JSON.parse(await readFile(join(stack.root, project.id, "reviews", "revision-plan-r1.json"), "utf8")) as {
      items: { status: string }[];
    };
    expect(plan.items.some((item) => item.status === "needs_review")).toBe(true);
  });
});
