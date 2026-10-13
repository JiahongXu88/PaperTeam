/**
 * M13 Final Closure（任务 B）：review.run 接线——academicScore 落在复核带内时追加有界独立
 * academic 采样（≤ 2），取中位数进 gate，全部样本落盘；band=0 时行为与旧版完全一致。
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { WorkflowState } from "../../src/workflow/types.js";
import { scriptedIdeaRuntime, startTestStack, type TestStack } from "../helpers/testStack.js";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
});

async function pollRun(stack: TestStack, runId: string, statuses: string[], timeoutMs = 20_000): Promise<WorkflowState> {
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

async function runToFirstGate(band: number, samples: number) {
  // fail3 pack：academic overallScore=78（落在 [75, 85) 带内）
  const scripted = scriptedIdeaRuntime({ reviewSequence: ["fail3"] });
  const stack = await startTestStack(scripted.runtime, {
    review: { maxRevisionRounds: 0, academicConfirmationBand: band, academicConfirmationSamples: samples },
    registerCleanup: (cleanup) => cleanups.push(cleanup),
  });
  const project = await stack.store.create("带内复核测试");
  const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
  const runId = created.body["runId"] as string;
  await pollRun(stack, runId, ["awaiting_input"]);
  await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
  await pollRun(stack, runId, ["awaiting_input"]);
  await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
  const run = await pollRun(stack, runId, ["awaiting_input", "completed", "failed"]);
  const reviewsDir = join(stack.root, project.id, "reviews");
  const summary = JSON.parse(await readFile(join(reviewsDir, "review-summary-r1.json"), "utf8")) as {
    scores: { academicScore: number | null };
    academicConfirmation?: { triggered: boolean; samples: { overallScore: number | null; taskId: string }[]; aggregatedScore: number | null; method: string };
  };
  const academicCalls = scripted.calls.filter((call) => call.contextScope === "review/academic").length;
  const files = await readdir(reviewsDir);
  return { run, summary, academicCalls, files, reviewResult: run.stageResults["review.run"] ?? {} };
}

describe("review.run × academicScore 带内复核", () => {
  it("band=5 / samples=2：分数 78 触发 → 共 3 份独立 academic 采样，中位数进 summary，额外样本落盘", async () => {
    const { summary, academicCalls, files, reviewResult } = await runToFirstGate(5, 2);
    expect(academicCalls).toBe(3);
    expect(summary.academicConfirmation?.triggered).toBe(true);
    expect(summary.academicConfirmation?.method).toBe("median_of_samples");
    expect(summary.academicConfirmation?.samples).toHaveLength(3);
    expect(summary.academicConfirmation?.samples.map((sample) => sample.overallScore)).toEqual([78, 78, 78]);
    // scripted runtime 的 taskId 不保证唯一，这里只断言每份样本都带 taskId 字符串
    expect(summary.academicConfirmation?.samples.every((sample) => typeof sample.taskId === "string")).toBe(true);
    expect(summary.scores.academicScore).toBe(78);
    expect(files).toEqual(expect.arrayContaining(["academic-confirmation-r1-s1.json", "academic-confirmation-r1-s2.json"]));
    expect(reviewResult["academicConfirmation"]).toMatchObject({ primaryScore: 78, aggregatedScore: 78 });
    // 规则 7 明细可解释（gate 产物）
    const gate = reviewResult["round"];
    expect(gate).toBe(1);
  });

  it("band=0：关闭——恰好 1 份 academic 采样，summary 无 academicConfirmation（旧行为）", async () => {
    const { summary, academicCalls, files } = await runToFirstGate(0, 2);
    expect(academicCalls).toBe(1);
    expect(summary.academicConfirmation).toBeUndefined();
    expect(summary.scores.academicScore).toBe(78);
    expect(files.some((file) => file.startsWith("academic-confirmation-"))).toBe(false);
  });
});
