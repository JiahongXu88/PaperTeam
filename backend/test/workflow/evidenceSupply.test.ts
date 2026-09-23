/**
 * M9.7.4 P1-1 Evidence Supply HITL 测试（workflow 级）。
 *
 * 覆盖（任务书 §8-17~19）：
 * 17. pending Candidate 不被自动晋升（research / evidence.ground / HITL 全链路零 promote）
 * 18. 晋升只能来自用户显式动作（HTTP promote 端点）
 * 19. HITL 保持边界：payload 如实呈现候选/证据规模；continue 继续、cancel 终止；
 *     无候选（<3）时零打扰
 */

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

async function pollRun(
  stack: TestStack,
  runId: string,
  statuses: string[],
  timeoutMs = 15_000,
): Promise<WorkflowState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await stack.request("GET", `/api/runs/${runId}`);
    const run = body["run"] as WorkflowState;
    if (statuses.includes(run.status)) {
      return run;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 run 状态 ${statuses.join("|")} 超时（当前 ${run.status}，awaiting=${run.awaiting?.stageId}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** 预置 N 条 pending 候选（模拟 research 阶段 save_candidates 的落库结果） */
async function seedCandidates(stack: TestStack, projectId: string, count: number): Promise<void> {
  for (let i = 0; i < count; i += 1) {
    const { body } = await stack.request("POST", `/api/projects/${projectId}/sources/candidates`, {
      title: `Candidate Paper ${i}`,
      authors: ["Doe, Jane"],
      year: 2023,
      doi: `10.1000/candidate-${i}`,
    });
    expect((body["candidate"] as { status?: string })?.["status"]).toBe("pending_review");
  }
}

describe("hitl.evidence_supply（M9.7.4）", () => {
  it("17+19. 候选 ≥3 → outline 确认后出现 evidence_supply HITL；continue 后候选仍全部 pending（零自动晋升）且写作继续", async () => {
    const scripted = scriptedIdeaRuntime();
    const stack = await startTestStack(scripted.runtime, {
      registerCleanup: (cleanup) => cleanups.push(cleanup),
    });
    const project = await stack.store.create("Evidence Supply E2E", {
      researchIdea: "agent 调研",
    });
    await seedCandidates(stack, project.id, 4);

    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;

    // 第一停：feasibility confirm
    let run = await pollRun(stack, runId, ["awaiting_input", "failed"]);
    expect(run.awaiting?.stageId).toBe("hitl.feasibility_confirm");
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });

    // 第二停：outline confirm
    run = await pollRun(stack, runId, ["awaiting_input", "failed"]);
    expect(run.awaiting?.stageId).toBe("hitl.outline_confirm");
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });

    // 第三停：evidence_supply HITL（候选 4 ≥ 3）
    run = await pollRun(stack, runId, ["awaiting_input", "failed"]);
    expect(run.awaiting?.stageId).toBe("hitl.evidence_supply");
    const payload = (run.awaiting?.payload ?? {}) as Record<string, unknown>;
    expect(payload["pendingCandidates"]).toBe(4);
    expect(typeof payload["verifiedEvidenceSources"]).toBe("number");
    expect(Array.isArray(payload["pendingSample"])).toBe(true);
    expect(String(payload["action"])).toContain("Promote");

    // continue：写作继续
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "continue" });
    run = await pollRun(stack, runId, ["awaiting_input", "failed", "completed"]);
    expect(run.status).not.toBe("failed");
    expect(run.stageResults["hitl.evidence_supply"]).toMatchObject({ decision: "continue" });
    expect(run.completedStages).toContain("writing.sections");

    // 17：全链路零自动晋升——候选仍全部 pending_review
    const list = await stack.request("GET", `/api/projects/${project.id}/sources/candidates?status=pending_review`);
    expect(list.body["candidates"]).toHaveLength(4);
    const all = await stack.request("GET", `/api/projects/${project.id}/sources/candidates`);
    expect(
      (all.body["candidates"] as Array<{ status: string }>).every((c) => c.status === "pending_review"),
    ).toBe(true);
    // 文献库也未被候选污染
    const sources = await stack.request("GET", `/api/projects/${project.id}/sources`);
    expect(sources.body["sources"]).toHaveLength(0);
  });

  it("19b. cancel → run 终止为 cancelled（用户主导，无自动续跑）", async () => {
    const scripted = scriptedIdeaRuntime();
    const stack = await startTestStack(scripted.runtime, {
      registerCleanup: (cleanup) => cleanups.push(cleanup),
    });
    const project = await stack.store.create("Evidence Supply Cancel", {
      researchIdea: "agent 调研",
    });
    await seedCandidates(stack, project.id, 3);

    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;
    let run = await pollRun(stack, runId, ["awaiting_input", "failed"]);
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
    run = await pollRun(stack, runId, ["awaiting_input", "failed"]);
    expect(run.awaiting?.stageId).toBe("hitl.outline_confirm");
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });

    run = await pollRun(stack, runId, ["awaiting_input", "failed"]);
    expect(run.awaiting?.stageId).toBe("hitl.evidence_supply");
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "cancel" });
    run = await pollRun(stack, runId, ["cancelled", "failed"]);
    expect(run.status).toBe("cancelled");
    // 候选不受影响
    const list = await stack.request("GET", `/api/projects/${project.id}/sources/candidates`);
    expect((list.body["candidates"] as Array<{ status: string }>).every((c) => c.status === "pending_review")).toBe(true);
  });

  it("19c. 无候选（<3）→ 不出现 evidence_supply（零打扰；scripted 离线栈不受影响）", async () => {
    const scripted = scriptedIdeaRuntime();
    const stack = await startTestStack(scripted.runtime, {
      registerCleanup: (cleanup) => cleanups.push(cleanup),
    });
    const project = await stack.store.create("No Candidates", { researchIdea: "安静跑通" });
    await seedCandidates(stack, project.id, 2); // 2 < 3

    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;
    let run = await pollRun(stack, runId, ["awaiting_input", "failed"]);
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
    run = await pollRun(stack, runId, ["awaiting_input", "failed"]);
    expect(run.awaiting?.stageId).toBe("hitl.outline_confirm");
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });

    // outline 确认后直接进入写作（无 evidence_supply 停靠）
    run = await pollRun(stack, runId, ["awaiting_input", "failed", "completed"]);
    expect(run.completedStages).not.toContain("hitl.evidence_supply");
  });

  it("18. 用户显式 promote（HTTP）才晋升；晋升幂等且状态翻转为 accepted", async () => {
    const scripted = scriptedIdeaRuntime();
    const stack = await startTestStack(scripted.runtime, {
      registerCleanup: (cleanup) => cleanups.push(cleanup),
    });
    const project = await stack.store.create("Explicit Promote", { researchIdea: "promote 语义" });
    await seedCandidates(stack, project.id, 1);
    const list = await stack.request("GET", `/api/projects/${project.id}/sources/candidates`);
    const candidateId = (list.body["candidates"] as Array<{ candidateId: string }>)[0]!.candidateId;

    const promoted = await stack.request(
      "POST",
      `/api/projects/${project.id}/sources/candidates/${candidateId}/promote`,
      {},
    );
    expect(promoted.status).toBe(200);
    expect((promoted.body["candidate"] as { status?: string })?.["status"]).toBe("accepted");
    expect((promoted.body["source"] as { sourceId?: string })?.["sourceId"]).toMatch(/^S\d+$/);
  });
});
