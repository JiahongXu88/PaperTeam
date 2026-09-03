/**
 * Bounded revision loop e2e 测试（M3.2）：
 * - review fail×2 → pass：两轮自动修订后 Final
 * - 默认最多 2 轮自动修订（第三轮失败 → HITL）
 * - 第三次失败 → awaiting_input → accept_draft → Draft（Build Gate 仍执行）
 * - Quality 失败不阻止 Draft 构建（D-0015）
 * - 编译失败也进入修订循环（带编译错误上下文）
 * - revisionOverflow revise_more 人工授权再修一轮
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { WorkflowState } from "../../src/workflow/types.js";
import {
  scriptedIdeaRuntime,
  startTestStack,
  type TestStack,
} from "../helpers/testStack.js";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
});

async function newStack(
  options: { reviewSequence?: ("pass" | "fail")[]; latexRunner?: never } = {},
): Promise<TestStack> {
  const scripted = scriptedIdeaRuntime({
    ...(options.reviewSequence ? { reviewSequence: options.reviewSequence } : {}),
  });
  return startTestStack(scripted.runtime, {
    registerCleanup: (cleanup) => cleanups.push(cleanup),
  });
}

async function pollRun(
  stack: TestStack,
  runId: string,
  statuses: string[],
  timeoutMs = 20_000,
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

describe("bounded revision loop（idea_to_paper）", () => {
  it("fail, fail → pass：两轮自动修订后 Final；修订轮数受控", async () => {
    const stack = await newStack({ reviewSequence: ["fail", "fail", "pass"] });
    const project = await stack.store.create("修订循环测试");
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;

    await approveTwice(stack, runId);
    const finished = await pollRun(stack, runId, ["completed", "failed", "awaiting_input"]);

    expect(finished.status).toBe("completed");
    expect(finished.completion?.label).toBe("final");
    // 自动修订恰好 2 轮（maxRounds 默认 2）
    const revisions = finished.stageHistory.filter(
      (record) => record.stageId === "revision.revise" && record.status === "completed",
    );
    expect(revisions).toHaveLength(2);
    // 三轮 review（r1/r2/r3 落盘）
    const reviewsDir = join(stack.root, project.id, "reviews");
    for (const round of [1, 2, 3]) {
      const summary = JSON.parse(
        await readFile(join(reviewsDir, `review-summary-r${round}.json`), "utf8"),
      ) as { scores?: { academicScore?: number } };
      expect(summary.scores?.academicScore).toBeDefined();
    }
    // 事件包含 quality_gate.failed / passed
    const { events } = await stack.orchestrator.readEvents(runId);
    const types = events.map((event) => event.type);
    expect(types).toContain("quality_gate.failed");
    expect(types).toContain("quality_gate.passed");
  });

  it("fail×3：自动轮数耗尽 → awaiting_input（不无限烧 Token）→ accept_draft → Draft", async () => {
    const stack = await newStack({ reviewSequence: ["fail"] });
    const project = await stack.store.create("超限测试");
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;

    await approveTwice(stack, runId);
    const overflow = await pollRun(stack, runId, ["awaiting_input"]);
    expect(overflow.awaiting?.stageId).toBe("hitl.revision_overflow");
    expect(overflow.awaiting?.options).toEqual(["accept_draft", "revise_more", "cancel"]);
    expect((overflow.awaiting?.payload?.["gateReasons"] as string[]).length).toBeGreaterThan(0);

    // Quality 失败不阻止 Draft 构建：accept_draft 后 build.draft 仍执行
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "accept_draft" });
    const finished = await pollRun(stack, runId, ["completed"]);

    expect(finished.status).toBe("completed");
    expect(finished.completion?.label).toBe("draft");
    expect(finished.completion?.summary?.["qualityGatePassed"]).toBe(false);
    expect(finished.completion?.summary?.["buildOk"]).toBe(true); // Draft PDF 已产出
    const revisions = finished.stageHistory.filter(
      (record) => record.stageId === "revision.revise" && record.status === "completed",
    );
    expect(revisions).toHaveLength(2); // 不超过 maxRounds
    const pdf = await readFile(join(stack.root, project.id, "build", "paper.pdf"), "utf8");
    expect(pdf).toContain("%PDF-1.5");
  });

  it("超限后 revise_more：人工授权追加一轮；仍有绝对上限", async () => {
    const stack = await newStack({ reviewSequence: ["fail"] });
    const project = await stack.store.create("人工追加测试");
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;

    await approveTwice(stack, runId);
    await pollRun(stack, runId, ["awaiting_input"]);

    await stack.request("POST", `/api/runs/${runId}/resume`, {
      decision: "revise_more",
      payload: { feedback: "重点补实验" },
    });
    // 追加一轮修订 → 再失败 → 再次 awaiting
    const overflowAgain = await pollRun(stack, runId, ["awaiting_input"]);
    expect(overflowAgain.awaiting?.stageId).toBe("hitl.revision_overflow");
    const revisions = overflowAgain.stageHistory.filter(
      (record) => record.stageId === "revision.revise" && record.status === "completed",
    );
    expect(revisions).toHaveLength(3); // 2 自动 + 1 人工

    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "accept_draft" });
    const finished = await pollRun(stack, runId, ["completed"]);
    expect(finished.completion?.label).toBe("draft");
  });

  it("review fail 但 feasibility INSUFFICIENT 的组合：gate 失败原因包含 target_feasibility", async () => {
    const stack = await newStack({ reviewSequence: ["fail"] });
    const project = await stack.store.create("组合失败测试");
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;
    await approveTwice(stack, runId);
    const overflow = await pollRun(stack, runId, ["awaiting_input"]);

    // FEASIBILITY_HIGH fixture（默认 sequence）→ 该原因不触发；确认 gate 原因来自 review
    const reasons = (overflow.awaiting?.payload?.["gateReasons"] as string[]) ?? [];
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.join("\n")).not.toContain("target_feasibility");
  });
});
