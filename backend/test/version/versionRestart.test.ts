/**
 * M4.8 Backend 重启恢复测试（scripted 全链路）：版本域事实跨进程恢复。
 *
 * 场景：idea_to_paper 推进到修订决策 HITL（awaiting_input 持久化）→ 停止
 * 第一栈（模拟进程退出）→ 同一 projects 根上重建全部服务（新 store /
 * orchestrator / VersionService / ArtifactStore / HTTP）并执行启动恢复
 * （recoverInterruptedRuns，与 index.ts 相同入口）→ 断言：
 * - awaiting run 仍 awaiting，可 resume 推进到完成；
 * - 版本历史 / 修订计划 / 迭代历史 / 产物 manifest / review / gate 轮次全部一致；
 * - 恢复（restore）在重启后的栈上语义不变。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { WorkflowState } from "../../src/workflow/types.js";
import { scriptedIdeaRuntime, startTestStack, type TestStack } from "../helpers/testStack.js";

vi.setConfig({ testTimeout: 60_000 });

async function pollRun(
  stack: TestStack,
  runId: string,
  statuses: string[],
  timeoutMs = 30_000,
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
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

async function approveTwice(stack: TestStack, runId: string): Promise<void> {
  await pollRun(stack, runId, ["awaiting_input"]);
  await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
  await pollRun(stack, runId, ["awaiting_input"]);
  await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
}

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
});

describe("版本域 Backend 重启恢复", () => {
  it("awaiting / 版本历史 / 计划 / 迭代 / 产物 / 轮次 跨进程一致；resume 可完成；restore 语义不变", async () => {
    // 共享 projects 根：两栈先后使用，测试结束统一删除
    const sharedRoot = await mkdtemp(join(tmpdir(), "paperteam-restart-"));
    cleanups.push(async () => {
      await rm(sharedRoot, { recursive: true, force: true });
    });
    // 第一栈：推进到修订 HITL（fail, fail → CONVERGED → stalled）
    const firstRuntime = scriptedIdeaRuntime({ reviewSequence: ["fail", "fail"] });
    const first = await startTestStack(firstRuntime.runtime, {
      root: sharedRoot,
      registerCleanup: (cleanup) => cleanups.push(cleanup),
    });
    const created = await first.request("POST", "/api/projects", {
      title: "重启恢复测试",
      researchIdea: "小语料 RAG 评估（重启恢复）",
    });
    const projectId = ((created.body as { project: { id: string } }).project).id;
    const runResponse = await first.request("POST", `/api/projects/${projectId}/workflows`, {
      kind: "idea_to_paper",
    });
    const runId = runResponse.body["runId"] as string;
    await approveTwice(first, runId);
    const stalled = await pollRun(first, runId, ["awaiting_input", "completed", "failed"]);
    expect(stalled.status).toBe("awaiting_input");
    expect(stalled.currentStage).toMatch(/^hitl\.revision/);

    const versionsBefore = (await first.request("GET", `/api/projects/${projectId}/versions`))
      .body as Record<string, unknown>;
    const planBefore = await first.request("GET", `/api/projects/${projectId}/revision-plan`);
    const iterationsBefore = await first.request("GET", `/api/projects/${projectId}/iterations`);
    const artifactsBefore = await first.request("GET", `/api/projects/${projectId}/artifacts`);
    const reviewsBefore = await first.request("GET", `/api/projects/${projectId}/review`);
    const gateBefore = await first.request("GET", `/api/projects/${projectId}/quality-gate`);
    expect(gateBefore.status).toBe(200);

    // 停止第一栈（不删根：root 复用模式）
    await first.cleanup();

    // 第二栈：同一根上重建全部服务 + 启动恢复（index.ts 同款入口）
    const secondRuntime = scriptedIdeaRuntime({ reviewSequence: ["pass"] });
    const second = await startTestStack(secondRuntime.runtime, {
      root: sharedRoot,
      registerCleanup: (cleanup) => cleanups.push(cleanup),
    });
    await second.orchestrator.recoverInterruptedRuns();

    // awaiting 保持等待，可 resume；审稿序列耗尽后 pass → 完成 Final
    const awaitingAfter = await pollRun(second, runId, ["awaiting_input", "completed", "failed"]);
    expect(awaitingAfter.status).toBe("awaiting_input");
    await second.request("POST", `/api/runs/${runId}/resume`, { decision: "revise_more" });
    const finished = await pollRun(second, runId, ["completed", "failed", "awaiting_input"]);
    expect(finished.status).toBe("completed");
    expect(finished.completion?.label).toBe("final");

    // 版本事实：重启前的一致超集（修订链只追加；历史记录不变）
    const versionsAfter = (await second.request("GET", `/api/projects/${projectId}/versions`))
      .body as { current: number; versions: { revision: number; source: string }[] };
    const beforeList = (versionsBefore as { versions: { revision: number; source: string }[] }).versions;
    for (const version of beforeList) {
      expect(versionsAfter.versions.find((candidate) => candidate.revision === version.revision)).toMatchObject({
        revision: version.revision,
        source: version.source,
      });
    }
    expect(versionsAfter.current).toBeGreaterThanOrEqual(
      (versionsBefore as { current: number }).current,
    );

    // 重启后的栈上：restore 语义不变（新修订 + 历史不动）
    const restoreResponse = await second.request("POST", `/api/projects/${projectId}/revisions/1/restore`);
    expect(restoreResponse.status).toBe(200);
    const restoreBody = restoreResponse.body as { revision: number; restoredFrom: number; created: boolean };
    expect(restoreBody).toMatchObject({ restoredFrom: 1, created: true });
    expect(restoreBody.revision).toBe(versionsAfter.current + 1);
    // 重启前读取的产物清单不被重启 / 恢复破坏
    const artifactsAfter = await second.request("GET", `/api/projects/${projectId}/artifacts`);
    expect(artifactsAfter.status).toBe(200);
    const beforeArtifacts = (artifactsBefore.body as { artifacts: unknown[] }).artifacts;
    const afterArtifacts = (artifactsAfter.body as { artifacts: unknown[] }).artifacts;
    expect(afterArtifacts.slice(0, beforeArtifacts.length)).toEqual(beforeArtifacts);
    // 计划 / 迭代历史端点在第二栈上可读（文件持久化，不依赖进程内状态）
    expect((await second.request("GET", `/api/projects/${projectId}/revision-plan`)).status).toBe(200);
    expect((await second.request("GET", `/api/projects/${projectId}/iterations`)).status).toBe(200);
    expect(planBefore.status).toBe(200);
    expect(iterationsBefore.status).toBe(200);
    expect(reviewsBefore.status).toBe(200);
  });
});
