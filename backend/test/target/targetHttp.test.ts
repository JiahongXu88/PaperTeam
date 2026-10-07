/**
 * M12.1 A5–A8 HTTP 路由测试：target benchmark / profile / readiess 契约
 * （docs/research/M12_BATCH2_TRACK_A_HANDOFF.md §3；前端 api/target.ts 为对照消费方）。
 * 网络发现（discover 真实检索）由 test/target/benchmarkLive.smoke.test.ts 覆盖；
 * 这里只测路由接线契约：null 信封 / 错误码 / 空字段校验。
 */

import { afterAll, describe, expect, it } from "vitest";

import { startTestStack, scriptedIdeaRuntime, type TestStack } from "../helpers/testStack.js";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
});

async function newStack(): Promise<TestStack> {
  const scripted = scriptedIdeaRuntime();
  return startTestStack(scripted.runtime, {
    registerCleanup: (cleanup) => cleanups.push(cleanup),
  });
}

async function createProject(stack: TestStack, withField: boolean): Promise<string> {
  const created = await stack.request("POST", "/api/projects", {
    title: withField ? "目标路由测试（有领域）" : "目标路由测试（无领域）",
    researchIdea: "idea",
    ...(withField ? { researchField: "multi-object tracking" } : {}),
    documentType: "conference_paper",
    targetProfile: "high_level_conference",
    targetVenue: "CVPR",
    workflowKind: "idea_to_paper",
  });
  expect(created.status).toBe(201);
  return (created.body["project"] as { id: string }).id;
}

describe("target 路由契约", () => {
  it("非法项目 404；未冻结 benchmark → {benchmark:null}；profile → {profile:null,fresh:null}；readiness → null", async () => {
    const stack = await newStack();
    const projectId = await createProject(stack, true);

    const missing = await stack.request("GET", "/api/projects/p-nonexistent00/target/benchmark");
    expect(missing.status).toBe(404);

    const benchmark = await stack.request("GET", `/api/projects/${projectId}/target/benchmark`);
    expect(benchmark.status).toBe(200);
    expect(benchmark.body["benchmark"]).toBeNull();

    const profile = await stack.request("GET", `/api/projects/${projectId}/target/profile`);
    expect(profile.status).toBe(200);
    expect(profile.body["profile"]).toBeNull();
    expect(profile.body["fresh"]).toBeNull();

    const readiness = await stack.request("GET", `/api/projects/${projectId}/target/readiness`);
    expect(readiness.status).toBe(200);
    expect(readiness.body["readiness"]).toBeNull();
  });

  it("discover 缺 researchField → 400 INVALID_REQUEST（不触网；repo 口径 INVALID_REQUEST→400）", async () => {
    const stack = await newStack();
    const projectId = await createProject(stack, false);
    const response = await stack.request("POST", `/api/projects/${projectId}/target/benchmark/discover`);
    expect(response.status).toBe(400);
    expect((response.body["error"] as { code: string }).code).toBe("INVALID_REQUEST");
  });

  it("regenerate / evaluate 在 benchmark 未冻结时 → 404", async () => {
    const stack = await newStack();
    const projectId = await createProject(stack, true);
    const regenerate = await stack.request("POST", `/api/projects/${projectId}/target/profile/regenerate`);
    expect(regenerate.status).toBe(404);
    const evaluate = await stack.request("POST", `/api/projects/${projectId}/target/readiness/evaluate`);
    expect(evaluate.status).toBe(404);
  });

  it("targetCount 非法 → 400；benchmark/refresh 未冻结 → 400", async () => {
    const stack = await newStack();
    const projectId = await createProject(stack, true);
    const badCount = await stack.request("POST", `/api/projects/${projectId}/target/benchmark/discover`, {
      targetCount: "twelve",
    });
    expect(badCount.status).toBe(400);
    const refresh = await stack.request("POST", `/api/projects/${projectId}/target/benchmark/refresh`);
    expect(refresh.status).toBe(400);
  });
});
