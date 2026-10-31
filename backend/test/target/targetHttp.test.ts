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
  // ---- M15.16 P0-A：证据审计（实验性）路由契约 ----

  it("证据审计 flag off（缺省）：GET → enabled:false；POST → 403 TARGET_EVIDENCE_AUDIT_DISABLED", async () => {
    const stack = await newStack();
    const projectId = await createProject(stack, true);
    const status = await stack.request("GET", `/api/projects/${projectId}/target/evidence-audit`);
    expect(status.status).toBe(200);
    expect(status.body["enabled"]).toBe(false);
    expect(status.body["audit"]).toBeNull();
    const post = await stack.request("POST", `/api/projects/${projectId}/target/evidence-audit`);
    expect(post.status).toBe(403);
    expect((post.body["error"] as { code: string }).code).toBe("TARGET_EVIDENCE_AUDIT_DISABLED");
  });

  it("证据审计 flag on：GET 无工件 → {enabled:true, audit:null}；POST 无解析稿 → 400 fail-closed", async () => {
    const stack = await startTestStack(scriptedIdeaRuntime().runtime, {
      registerCleanup: (cleanup) => cleanups.push(cleanup),
      targetEvidenceAuditEnabled: true,
    });
    const projectId = await createProject(stack, true);
    const status = await stack.request("GET", `/api/projects/${projectId}/target/evidence-audit`);
    expect(status.status).toBe(200);
    expect(status.body["enabled"]).toBe(true);
    expect(status.body["audit"]).toBeNull();
    const post = await stack.request("POST", `/api/projects/${projectId}/target/evidence-audit`);
    expect(post.status).toBe(400);
    expect((post.body["error"] as { code: string }).code).toBe("INVALID_REQUEST");
    // 非法项目 → 404（与 target 组其余路由一致）
    const missing = await stack.request("GET", "/api/projects/p-nonexistent00/target/evidence-audit");
    expect(missing.status).toBe(404);
  });

  // ---- M15.17：审计差距 → 修订计划路由契约 ----

  it("修订计划 flag off：GET → enabled:false；POST/decide/reassess → 403", async () => {
    const stack = await newStack();
    const projectId = await createProject(stack, true);
    const status = await stack.request("GET", `/api/projects/${projectId}/target/evidence-audit/revision-plan`);
    expect(status.status).toBe(200);
    expect(status.body["enabled"]).toBe(false);
    expect(status.body["plan"]).toBeNull();
    expect(status.body["report"]).toBeNull();
    const post = await stack.request("POST", `/api/projects/${projectId}/target/evidence-audit/revision-plan`);
    expect(post.status).toBe(403);
    expect((post.body["error"] as { code: string }).code).toBe("TARGET_EVIDENCE_AUDIT_DISABLED");
    const decide = await stack.request("POST", `/api/projects/${projectId}/target/evidence-audit/revision-plan/decide`, {
      decisions: [{ itemId: "ta-gap-1", decision: "approve" }],
    });
    expect(decide.status).toBe(403);
    const reassess = await stack.request("POST", `/api/projects/${projectId}/target/evidence-audit/revision-plan/reassess`);
    expect(reassess.status).toBe(403);
  });

  it("修订计划 flag on：GET 无计划 → {enabled:true, plan:null}；POST 无审计工件 → 409 fail-closed；decide 非法体 → 400", async () => {
    const stack = await startTestStack(scriptedIdeaRuntime().runtime, {
      registerCleanup: (cleanup) => cleanups.push(cleanup),
      targetEvidenceAuditEnabled: true,
    });
    const projectId = await createProject(stack, true);
    const status = await stack.request("GET", `/api/projects/${projectId}/target/evidence-audit/revision-plan`);
    expect(status.status).toBe(200);
    expect(status.body["enabled"]).toBe(true);
    expect(status.body["plan"]).toBeNull();
    const post = await stack.request("POST", `/api/projects/${projectId}/target/evidence-audit/revision-plan`);
    expect(post.status).toBe(409);
    expect((post.body["error"] as { code: string }).code).toBe("TARGET_AUDIT_PLAN_INVALID_STATE");
    const badDecide = await stack.request("POST", `/api/projects/${projectId}/target/evidence-audit/revision-plan/decide`, {
      decisions: [],
    });
    expect(badDecide.status).toBe(400);
    const badDecide2 = await stack.request("POST", `/api/projects/${projectId}/target/evidence-audit/revision-plan/decide`, {
      decisions: [{ itemId: "x" }],
    });
    expect(badDecide2.status).toBe(400);
  });
  // ---- M15.18：投稿准备度报告路由契约 ----

  it("投稿准备度 flag off：JSON → enabled:false；Markdown 下载 → 403", async () => {
    const stack = await newStack();
    const projectId = await createProject(stack, true);
    const status = await stack.request("GET", `/api/projects/${projectId}/target/submission-readiness`);
    expect(status.status).toBe(200);
    expect(status.body["enabled"]).toBe(false);
    const download = await fetch(`http://127.0.0.1:${stack.port()}/api/projects/${projectId}/target/submission-readiness.md`);
    expect(download.status).toBe(403);
  });

  it("投稿准备度 flag on：无任何工件 → 各区块 available=false；Markdown 附件含免责声明", async () => {
    const stack = await startTestStack(scriptedIdeaRuntime().runtime, {
      registerCleanup: (cleanup) => cleanups.push(cleanup),
      targetEvidenceAuditEnabled: true,
    });
    const projectId = await createProject(stack, true);
    const status = await stack.request("GET", `/api/projects/${projectId}/target/submission-readiness`);
    expect(status.status).toBe(200);
    expect(status.body["enabled"]).toBe(true);
    const report = status.body["report"] as { official: { available: boolean }; contribution: { available: boolean }; closure: { available: boolean }; disclaimer: string };
    expect(report.official.available).toBe(false);
    expect(report.contribution.available).toBe(false);
    expect(report.closure.available).toBe(false);
    expect(report.disclaimer).toContain("不是录用预测");
    const download = await fetch(`http://127.0.0.1:${stack.port()}/api/projects/${projectId}/target/submission-readiness.md`);
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toContain("text/markdown");
    expect(download.headers.get("content-disposition")).toContain("submission-readiness-");
    expect(await download.text()).toContain("独立人类审稿质量标签 = 0");
    const post = await stack.request("POST", `/api/projects/${projectId}/target/submission-readiness`);
    expect(post.status).toBe(405);
  });
});
