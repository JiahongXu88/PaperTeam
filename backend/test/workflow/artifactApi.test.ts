/**
 * M4.7 Artifact / Finalize / Build / Revision HTTP API e2e（真实编排 + scripted Runtime）。
 *
 * 覆盖规格场景：
 * - A：双 Gate 通过 → Final（产物列表 / 元数据 / 下载 inline PDF / 404 / traversal 拒绝 / Finalize 幂等）
 * - B：Build PASS + Quality FAIL → Draft；finalize 被 422 拒绝（后端确定性执行，不信任前端）
 * - stale gate：修订后 finalize 409 → 复审 + 重建 → 新 Final；旧 Final 条目不可变
 * - 活跃 run 期间 finalize → 409 PROJECT_BUSY
 * - GET /revisions / /iterations / /build / /build/log 数据源
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { WorkflowState } from "../../src/workflow/types.js";
import {
  scriptedIdeaRuntime,
  startTestStack,
  type TestStack,
} from "../helpers/testStack.js";

vi.setConfig({ testTimeout: 30_000 });

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
});

type ReviewPack = "pass" | "fail" | "fail2" | "fail3";

async function newStack(
  options: { reviewSequence?: ReviewPack[]; hangFirstCall?: boolean } = {},
): Promise<{ stack: TestStack; release: () => void }> {
  const scripted = scriptedIdeaRuntime({
    ...(options.reviewSequence ? { reviewSequence: options.reviewSequence } : {}),
    ...(options.hangFirstCall !== undefined ? { hangFirstCall: options.hangFirstCall } : {}),
  });
  const stack = await startTestStack(scripted.runtime, {
    registerCleanup: (cleanup) => cleanups.push(cleanup),
  });
  return { stack, release: scripted.release };
}

async function pollRun(
  stack: TestStack,
  runId: string,
  statuses: string[],
  timeoutMs = 25_000,
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

interface ArtifactView {
  artifactId: string;
  kind: string;
  revision: number;
}

describe("GET/POST /artifacts /finalize（M4.7 产物闭环）", () => {
  it("A：双 Gate 通过 → Final；列表 / 元数据 / 下载 / 404 / traversal 拒绝；Finalize 幂等", async () => {
    const { stack } = await newStack(); // reviewSequence ["pass"]
    const project = await stack.store.create("产物 API 测试");
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;
    await approveTwice(stack, runId);
    const finished = await pollRun(stack, runId, ["completed"]);
    expect(finished.completion?.label).toBe("final");

    // ---- 列表 + 最新标记 + Final revision 精确性 ----
    const list = await stack.request("GET", `/api/projects/${project.id}/artifacts`);
    expect(list.status).toBe(200);
    const artifacts = list.body["artifacts"] as ArtifactView[];
    const latestFinal = list.body["latestFinal"] as ArtifactView | null;
    const latestDraft = list.body["latestDraft"] as ArtifactView | null;
    expect(latestFinal?.kind).toBe("final");
    expect(latestDraft?.kind).toBe("draft");
    expect(latestFinal?.revision).toBe(list.body["currentRevision"]); // Final 对齐当前修订
    expect(list.body["finalUpToDate"]).toBe(true);
    expect(artifacts.map((item) => item.artifactId)).toContain(latestFinal?.artifactId);

    // ---- 元数据（manifest 解析） ----
    const meta = await stack.request(
      "GET",
      `/api/projects/${project.id}/artifacts/${latestFinal?.artifactId}`,
    );
    expect(meta.status).toBe(200);
    expect((meta.body["artifact"] as ArtifactView).artifactId).toBe(latestFinal?.artifactId);

    // ---- 下载：inline PDF（浏览器原生 viewer） ----
    const download = await fetch(
      `http://127.0.0.1:${stack.port()}/api/projects/${project.id}/artifacts/${latestFinal?.artifactId}/download`,
    );
    expect(download.status).toBe(200);
    expect(download.headers.get("content-type")).toBe("application/pdf");
    expect((download.headers.get("content-disposition") ?? "").startsWith("inline")).toBe(true);
    expect(await download.text()).toContain("%PDF-1.5");
    // ?disposition=attachment 才落盘
    const attachment = await fetch(
      `http://127.0.0.1:${stack.port()}/api/projects/${project.id}/artifacts/${latestFinal?.artifactId}/download?disposition=attachment`,
    );
    expect((attachment.headers.get("content-disposition") ?? "").startsWith("attachment")).toBe(true);
    await attachment.arrayBuffer();

    // ---- 未知 / 非法 artifactId → 404（下载只接受 manifest 中的 id） ----
    const missing = await stack.request("GET", `/api/projects/${project.id}/artifacts/art-final-rev999`);
    expect(missing.status).toBe(404);
    const traversal = await fetch(
      `http://127.0.0.1:${stack.port()}/api/projects/${project.id}/artifacts/art-draft-rev1%2F..%2F..%2F..%2Fetc%2Fpasswd/download`,
    );
    expect(traversal.status).toBe(404); // 路径参数形态不被路由接受（防 path traversal）
    await traversal.text();

    // ---- 完成后 Finalize（无活跃 run）：幂等返回同一产物 ----
    const again = await stack.request("POST", `/api/projects/${project.id}/finalize`, {});
    expect(again.status).toBe(200);
    expect((again.body["final"] as ArtifactView).artifactId).toBe(latestFinal?.artifactId);
  });

  it("B：Build PASS + Quality FAIL → Draft；finalize 422 拒绝；iterations 暴露收敛轨迹", async () => {
    const { stack } = await newStack({ reviewSequence: ["fail", "fail2", "fail3"] });
    const project = await stack.store.create("Draft 语义测试");
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;
    await approveTwice(stack, runId);
    const overflow = await pollRun(stack, runId, ["awaiting_input"]);
    expect(overflow.awaiting?.stageId).toBe("hitl.revision_overflow");
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "accept_draft" });
    const finished = await pollRun(stack, runId, ["completed"]);
    expect(finished.completion?.label).toBe("draft");
    expect(finished.completion?.summary?.["buildOk"]).toBe(true); // Quality 不阻塞 Draft（D-0015）
    expect(typeof finished.completion?.summary?.["draftArtifactId"]).toBe("string");

    // 后端确定性拒绝 Finalize（不信任「前端只在 PASS 时显示按钮」）
    const rejected = await stack.request("POST", `/api/projects/${project.id}/finalize`, {});
    expect(rejected.status).toBe(422);
    expect((rejected.body["error"] as { code: string }).code).toBe("QUALITY_GATE_FAILED");

    // Draft 产物可下载（当前版本可以作为 Draft，但尚未满足 Final 要求）
    const list = await stack.request("GET", `/api/projects/${project.id}/artifacts`);
    expect(list.body["latestFinal"]).toBeNull();
    expect((list.body["latestDraft"] as ArtifactView).kind).toBe("draft");

    // 迭代历史：三轮轨迹 + 修订计划回填
    const iterations = await stack.request("GET", `/api/projects/${project.id}/iterations`);
    const records = iterations.body["iterations"] as {
      gateRound: number;
      outcome: string | null;
      planId?: string;
      revision: number;
    }[];
    expect(records.map((record) => record.outcome)).toEqual([null, "IMPROVED", "IMPROVED"]);
    expect(records.filter((record) => record.gateRound <= 2).every((record) => typeof record.planId === "string")).toBe(
      true,
    );
    expect(records.every((record) => typeof record.revision === "number")).toBe(true);

    // 修订事实
    const revisions = await stack.request("GET", `/api/projects/${project.id}/revisions`);
    expect(revisions.body["current"]).toBeGreaterThanOrEqual(3);
    const reasons = (revisions.body["revisions"] as { reason: string }[]).map((record) => record.reason);
    expect(reasons).toContain("revision.revise");
  });

  it("stale gate：修订后 finalize 409 → 复审 / 重建 → 新 Final；旧 Final 条目不可变", async () => {
    const { stack } = await newStack(); // pass 轨迹 → Final
    const project = await stack.store.create("Stale 恢复测试");
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;
    await approveTwice(stack, runId);
    await pollRun(stack, runId, ["completed"]);
    const initial = await stack.request("GET", `/api/projects/${project.id}/artifacts`);
    const firstFinal = initial.body["latestFinal"] as ArtifactView;
    expect(firstFinal).not.toBeNull();

    // ---- 人工改稿 → 修订前进；gate 结论过期 ----
    const introPath = join(stack.root, project.id, "manuscript", "sections", "introduction.tex");
    await writeFile(introPath, `${await readFile(introPath, "utf8")}\n% manual edit\n`, "utf8");
    const commit = await stack.stack.revisions.commit(project.id, "manual-edit");
    expect(commit.created).toBe(true);

    const stale = await stack.request("POST", `/api/projects/${project.id}/finalize`, {});
    expect(stale.status).toBe(409);
    expect((stale.body["error"] as { code: string }).code).toBe("QUALITY_GATE_STALE");

    // Build 状态卡片数据源：stale 信号
    const buildStatus = await stack.request("GET", `/api/projects/${project.id}/build`);
    expect(buildStatus.body["stale"]).toBe(true);
    expect(buildStatus.body["currentRevision"]).toBe(commit.revision);

    // ---- 恢复链路：复审（固化新修订）→ 重评 gate → 仍因 build 过期被拒 → 重建 → Finalize ----
    await stack.request("POST", `/api/projects/${project.id}/review`, {});
    await stack.request("POST", `/api/projects/${project.id}/quality-gate`, {});
    const buildStale = await stack.request("POST", `/api/projects/${project.id}/finalize`, {});
    expect(buildStale.status).toBe(409);
    expect((buildStale.body["error"] as { code: string }).code).toBe("BUILD_GATE_STALE");

    const rebuild = await stack.request("POST", `/api/projects/${project.id}/build`, {});
    expect(rebuild.status).toBe(200);
    expect(rebuild.body["revision"]).toBe(commit.revision);
    expect(rebuild.body["draftArtifactId"]).toBe(`art-draft-rev${commit.revision}`);
    const fresh = await stack.request("GET", `/api/projects/${project.id}/build`);
    expect(fresh.body["stale"]).toBe(false);

    const finalized = await stack.request("POST", `/api/projects/${project.id}/finalize`, {});
    expect(finalized.status).toBe(200);
    const newFinal = finalized.body["final"] as ArtifactView;
    expect(newFinal.artifactId).toBe(`art-final-rev${commit.revision}`);
    expect(newFinal.revision).toBe(commit.revision);

    // ---- 旧 Final 不可变：条目仍在、可下载；最新指向新修订 ----
    const after = await stack.request("GET", `/api/projects/${project.id}/artifacts`);
    const finalIds = (after.body["artifacts"] as ArtifactView[])
      .filter((item) => item.kind === "final")
      .map((item) => item.artifactId);
    expect(finalIds).toEqual([firstFinal.artifactId, newFinal.artifactId].sort());
    expect((after.body["latestFinal"] as ArtifactView).revision).toBe(commit.revision);
    expect(after.body["finalUpToDate"]).toBe(true);
    const oldPdf = await fetch(
      `http://127.0.0.1:${stack.port()}/api/projects/${project.id}/artifacts/${firstFinal.artifactId}/download`,
    );
    expect(oldPdf.status).toBe(200);
    expect(await oldPdf.text()).toContain("%PDF-1.5");

    // 编译日志端点
    const log = await stack.request("GET", `/api/projects/${project.id}/build/log`);
    expect(log.status).toBe(200);
    expect(typeof log.body["log"]).toBe("string");
  });

  it("活跃 run 期间 finalize → 409 PROJECT_BUSY", async () => {
    const { stack, release } = await newStack({ hangFirstCall: true });
    const project = await stack.store.create("互斥测试");
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;
    await new Promise((resolve) => setTimeout(resolve, 150));

    const busy = await stack.request("POST", `/api/projects/${project.id}/finalize`, {});
    expect(busy.status).toBe(409);
    expect((busy.body["error"] as { code: string }).code).toBe("PROJECT_BUSY");

    release();
    await pollRun(stack, runId, ["awaiting_input"]);
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "cancel" });
    await pollRun(stack, runId, ["cancelled"]);
  });
});
