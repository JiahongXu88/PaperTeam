/**
 * 项目生命周期 HTTP 测试（2026-09）：归档 / 恢复 / 永久删除 /
 * busy 保护 / scope 过滤 / 标题重命名（PATCH title）。
 */

import { existsSync } from "node:fs";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { startTestStack, scriptedIdeaRuntime, type TestStack } from "../helpers/testStack.js";

let stack: TestStack;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  const scripted = scriptedIdeaRuntime();
  stack = await startTestStack(scripted.runtime, {
    registerCleanup: (cleanup) => cleanups.push(cleanup),
  });
});

afterAll(async () => {
  for (const cleanup of cleanups) {
    await cleanup();
  }
});

async function createProject(title: string): Promise<string> {
  const { status, body } = await stack.request("POST", "/api/projects", { title });
  expect(status).toBe(201);
  return (body["project"] as Record<string, unknown>)["id"] as string;
}

async function waitRunTerminal(
  runId: string,
  options: { cancel?: boolean } = {},
): Promise<Record<string, unknown>> {
  if (options.cancel) {
    await stack.request("POST", `/api/runs/${runId}/cancel`);
  }
  for (let attempt = 0; attempt < 100; attempt += 1) {
    const { body } = await stack.request("GET", `/api/runs/${runId}`);
    const run = body["run"] as Record<string, unknown>;
    if (["completed", "failed", "cancelled"].includes(String(run["status"]))) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  throw new Error("run 未在预期时间内终结");
}

describe("项目归档 / 恢复 / 永久删除（HTTP）", () => {
  it("归档后从默认列表与最近项目消失；scope=archived / all 可见", async () => {
    const id = await createProject("生命周期测试项目");
    const archive = await stack.request("POST", `/api/projects/${id}/archive`);
    expect(archive.status).toBe(200);
    expect((archive.body["project"] as Record<string, unknown>)["archivedAt"]).toBeDefined();

    const active = ((await stack.request("GET", "/api/projects")).body["projects"] as Array<Record<string, unknown>>);
    expect(active.some((p) => p["id"] === id)).toBe(false);

    const archived = (
      (await stack.request("GET", "/api/projects?scope=archived")).body["projects"] as Array<Record<string, unknown>>
    ).filter((p) => p["id"] === id);
    expect(archived.length).toBe(1);

    const all = (
      (await stack.request("GET", "/api/projects?scope=all")).body["projects"] as Array<Record<string, unknown>>
    ).filter((p) => p["id"] === id);
    expect(all.length).toBe(1);

    // scope 非法值 → 400
    expect((await stack.request("GET", "/api/projects?scope=everything")).status).toBe(400);
  });

  it("归档幂等；恢复后重新出现在默认列表且 archivedAt 清除", async () => {
    const id = await createProject("恢复测试项目");
    await stack.request("POST", `/api/projects/${id}/archive`);
    const again = await stack.request("POST", `/api/projects/${id}/archive`);
    expect(again.status).toBe(200);

    const restore = await stack.request("POST", `/api/projects/${id}/restore`);
    expect(restore.status).toBe(200);
    expect((restore.body["project"] as Record<string, unknown>)["archivedAt"]).toBeUndefined();

    const active = ((await stack.request("GET", "/api/projects")).body["projects"] as Array<Record<string, unknown>>);
    expect(active.some((p) => p["id"] === id)).toBe(true);
    const archived = (
      (await stack.request("GET", "/api/projects?scope=archived")).body["projects"] as Array<Record<string, unknown>>
    );
    expect(archived.some((p) => p["id"] === id)).toBe(false);
  });

  it("运行中项目归档 → 409 PROJECT_BUSY（不静默归档、不自动取消）", async () => {
    const hangRuntime = scriptedIdeaRuntime({ hangFirstCall: true });
    const local = await startTestStack(hangRuntime.runtime, {
      registerCleanup: (cleanup) => cleanups.push(cleanup),
    });
    const { body } = await local.request("POST", "/api/projects", { title: "忙碌项目" });
    const projectId = (body["project"] as Record<string, unknown>)["id"] as string;
    const created = await local.request("POST", `/api/projects/${projectId}/workflows`, { kind: "idea_to_paper" });
    expect(created.status).toBe(202);
    const runId = created.body["runId"] as string;

    // 等待 run 真正进入执行（hangFirstCall 挂起第一个 agent 调用）
    await new Promise((resolve) => setTimeout(resolve, 200));
    const archive = await local.request("POST", `/api/projects/${projectId}/archive`);
    expect(archive.status).toBe(409);
    expect((archive.body["error"] as Record<string, unknown>)["code"]).toBe("PROJECT_BUSY");

    // run 未被取消：仍在进行中
    const run = (await local.request("GET", `/api/runs/${runId}`)).body["run"] as Record<string, unknown>;
    expect(["pending", "running"]).toContain(run["status"]);

    hangRuntime.release();
    // 取消并等待收敛（idea_to_paper 后续会进入 HITL；统一取消收敛）
    await local.request("POST", `/api/runs/${runId}/cancel`);
    for (let attempt = 0; attempt < 100; attempt += 1) {
      const run = (await local.request("GET", `/api/runs/${runId}`)).body["run"] as Record<string, unknown>;
      if (["completed", "failed", "cancelled"].includes(String(run["status"]))) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    // 收敛后归档成功
    const retry = await local.request("POST", `/api/projects/${projectId}/archive`);
    expect(retry.status).toBe(200);
  });

  it("永久删除：仅已归档项目（否则 409 PROJECT_NOT_ARCHIVED）；删除后整个工作区消失", async () => {
    const id = await createProject("删除测试项目");
    // 未归档 → 409
    const tooEarly = await stack.request("DELETE", `/api/projects/${id}`);
    expect(tooEarly.status).toBe(409);
    expect((tooEarly.body["error"] as Record<string, unknown>)["code"]).toBe("PROJECT_NOT_ARCHIVED");

    await stack.request("POST", `/api/projects/${id}/archive`);
    const del = await stack.request("DELETE", `/api/projects/${id}`);
    expect(del.status).toBe(200);

    expect((await stack.request("GET", `/api/projects/${id}`)).status).toBe(404);
    // 工作区目录（PDF/parsed/reviews/workflow 等）整体消失
    expect(existsSync(join(stack.root, id))).toBe(false);
    // runs 也一并消失
    const runs = (await stack.request("GET", `/api/runs?projectId=${id}`)).body["runs"] as unknown[];
    expect(runs.length).toBe(0);
    // archived 列表不再包含
    const archived = (
      (await stack.request("GET", "/api/projects?scope=archived")).body["projects"] as Array<Record<string, unknown>>
    );
    expect(archived.some((p) => p["id"] === id)).toBe(false);
  });

  it("归档项目不能启动新 workflow（409）；恢复后可以", async () => {
    const id = await createProject("归档启动测试");
    await stack.request("POST", `/api/projects/${id}/archive`);
    const blocked = await stack.request("POST", `/api/projects/${id}/workflows`, {});
    expect(blocked.status).toBe(409);

    await stack.request("POST", `/api/projects/${id}/restore`);
    const started = await stack.request("POST", `/api/projects/${id}/workflows`, { kind: "idea_to_paper" });
    expect(started.status).toBe(202);
    // 清理：取消 run，避免影响后续用例的 busy 判定
    const runId = started.body["runId"] as string;
    await waitRunTerminal(runId, { cancel: true });
  });

  it("PATCH title 重命名（标题可后改：PDF metadata 可能识别错误）", async () => {
    const id = await createProject("原标题");
    const { status, body } = await stack.request("PATCH", `/api/projects/${id}`, { title: "重命名后的标题" });
    expect(status).toBe(200);
    expect((body["project"] as Record<string, unknown>)["title"]).toBe("重命名后的标题");
    // 空标题不修改
    const kept = await stack.request("PATCH", `/api/projects/${id}`, { title: "  " });
    expect(kept.status).toBe(200);
    expect((kept.body["project"] as Record<string, unknown>)["title"]).toBe("重命名后的标题");
  });
});
