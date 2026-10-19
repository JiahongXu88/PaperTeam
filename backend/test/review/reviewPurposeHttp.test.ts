/**
 * M14.9.3：POST /api/projects/:id/workflows 的 reviewPurpose 字段。
 * - 缺省不写入 request（作者稿件口径，行为不变）；
 * - published_paper_assessment 只接受 idea_to_paper，并随 run request 持久化；
 * - 已有论文返修 / Quick Review / 非法值 → 400（作者稿件流程不得借只读口径放宽实验事实守卫）。
 */
import { afterAll, describe, expect, it } from "vitest";

import type { WorkflowState } from "../../src/workflow/types.js";
import { scriptedIdeaRuntime, startTestStack, type TestStack } from "../helpers/testStack.js";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

async function newStack(): Promise<TestStack> {
  const scripted = scriptedIdeaRuntime({ reviewSequence: ["pass"] });
  return startTestStack(scripted.runtime, { registerCleanup: (cleanup) => cleanups.push(cleanup) });
}

describe("POST /workflows reviewPurpose", () => {
  it("idea_to_paper 接受 published_paper_assessment 并持久化；缺省不写入；其他工作流与非法值 400", async () => {
    const stack = await newStack();
    const project = await stack.store.create("已发表论文只读评估", { researchIdea: "x" });
    const accepted = await stack.request("POST", `/api/projects/${project.id}/workflows`, { kind: "idea_to_paper", reviewPurpose: "published_paper_assessment" });
    expect(accepted.status).toBe(202);
    const run = (await stack.request("GET", `/api/runs/${accepted.body["runId"] as string}`)).body["run"] as WorkflowState;
    expect(run.request?.["reviewPurpose"]).toBe("published_paper_assessment");
    await stack.request("POST", `/api/runs/${run.runId}/cancel`, {});

    const other = await stack.store.create("缺省", { researchIdea: "y" });
    const plain = await stack.request("POST", `/api/projects/${other.id}/workflows`, { kind: "idea_to_paper" });
    expect(plain.status).toBe(202);
    const plainRun = (await stack.request("GET", `/api/runs/${plain.body["runId"] as string}`)).body["run"] as WorkflowState;
    expect(plainRun.request?.["reviewPurpose"]).toBeUndefined();
    await stack.request("POST", `/api/runs/${plainRun.runId}/cancel`, {});

    const third = await stack.store.create("返修", { researchIdea: "z" });
    for (const kind of ["existing_paper_improvement", "existing_paper_review", "topic_survey"]) {
      const rejected = await stack.request("POST", `/api/projects/${third.id}/workflows`, { kind, reviewPurpose: "published_paper_assessment" });
      expect(rejected.status).toBe(400);
      expect(JSON.stringify(rejected.body)).toContain("reviewPurpose");
    }
    const invalid = await stack.request("POST", `/api/projects/${third.id}/workflows`, { kind: "idea_to_paper", reviewPurpose: "lenient" });
    expect(invalid.status).toBe(400);
  });
});
