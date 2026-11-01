/**
 * Fact Preservation Gate e2e（M5.6 第二层，scripted workflow）：
 *   [fact:mutate] 项目的修订输出会替换公式常量（\alpha→\beta）并新增无依据数值
 *   （8.7%→12.4%）→ quality.gate 的 fact_preservation FAIL（Final 被阻止）、
 *   revision.plan 派发 fact_preserve 恢复条目、accept_draft 也被 Draft 拦截
 *   （FACT_PRESERVATION_FAILED：被篡改的实验数据不能冻结为 Draft 产物）。
 *   默认脚本（修订保留既有事实）→ 规则 PASS；Quick Review 不含 quality.gate。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

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

async function newStack(reviewSequence: ("pass" | "fail" | "fail2" | "fail3")[]): Promise<TestStack> {
  const scripted = scriptedIdeaRuntime({ reviewSequence });
  return startTestStack(scripted.runtime, { registerCleanup: (cleanup) => cleanups.push(cleanup) });
}

async function pollRun(stack: TestStack, runId: string, statuses: string[], timeoutMs = 25_000): Promise<WorkflowState> {
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

/**
 * M6.7：修订复核 HITL（hitl.revision_validation）出现时自动 approve（用户明示
 * 接受本轮修订），直到出现目标 stage 的 awaiting_input。既有 M5.6 断言口径不变
 * （用户 approve 后 Revision Gate 规则按用户决策放行，gate 阻止项仍只来自
 * fact / citation preservation）。
 */
async function pollRunApprovingValidation(
  stack: TestStack,
  runId: string,
  stageId: string,
  timeoutMs = 25_000,
): Promise<WorkflowState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await pollRun(stack, runId, ["awaiting_input"], Math.max(1, deadline - Date.now()));
    if (run.awaiting?.stageId === stageId) {
      return run;
    }
    if (run.awaiting?.stageId === "hitl.revision_validation") {
      await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
      continue;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 ${stageId} 超时（当前 awaiting ${run.awaiting?.stageId}）`);
    }
  }
}

interface GateArtifact {
  gate: { passed: boolean; reasons: string[]; rules: { rule: string; passed: boolean; detail: string }[] };
  factPreservation?: {
    ok: boolean;
    changedFacts: unknown[];
    removedFacts: unknown[];
    addedUnsupportedFacts: { reason: string }[];
    directionalChanges: unknown[];
    formulaChanges: unknown[];
    placeholderRegressions: unknown[];
  } | null;
}

async function readGate(stack: TestStack, projectId: string, round: number): Promise<GateArtifact> {
  return JSON.parse(await readFile(join(stack.root, projectId, "reviews", `quality-gate-r${round}.json`), "utf8")) as GateArtifact;
}

describe("Fact Preservation Gate（scripted workflow）", () => {
  it("[fact:mutate]：修订篡改公式与数值 → 候选在写入前被拒（M15.20：文件级目标同一守卫）、正式稿无篡改、gate 不放行", async () => {
    const stack = await newStack(["fail", "pass"]);
    const project = await stack.store.create("事实篡改回归", { researchIdea: "[fact:mutate] 检索增强生成" });
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;

    await approveTwice(stack, runId);
    // M15.20 P0：旧链路是「篡改落盘 → gate 的 fact_preservation 事后检出 → 恢复条目 / Draft 拦截」；
    // 文件级修订目标现在与 span 候选同一候选守卫（授权契约 + 事实 / 引用守卫），篡改在写入前即被拒绝：
    // 正式稿件从未出现被替换的公式常量与无依据数值，拒绝记录 fail-closed 保留，gate 不因此放行。
    const stalled = await pollRunApprovingValidation(stack, runId, "hitl.revision_stalled");
    expect(stalled.awaiting?.stageId).toBe("hitl.revision_stalled");
    const gateReasons = stalled.awaiting?.payload?.["gateReasons"] as string[];
    expect(gateReasons.join("\n")).toContain("patch_validation_publishable");

    const r2 = await readGate(stack, project.id, 2);
    expect(r2.gate.passed).toBe(false);
    // 篡改从未落盘：修订前后事实保持 PASS（没有可检出的漂移）
    expect(r2.factPreservation?.ok).toBe(true);
    const { readdir } = await import("node:fs/promises");
    const sectionsDir = join(stack.root, project.id, "manuscript", "sections");
    for (const name of await readdir(sectionsDir)) {
      const content = await readFile(join(sectionsDir, name), "utf8");
      expect(content).not.toContain("12.4\\%");
      expect(content).not.toContain("修订补充");
    }
    // 拒绝记录：文件级候选在写入前被拒（授权契约 / 事实守卫），fail-closed 留档（rootViolationIds 保留拒绝原因；
    // revision.validate 会按实际落盘 diff 重新归因 fact 字段——候选未落盘，故 fact 字段回到 ok）
    const reviewsDir = join(stack.root, project.id, "reviews");
    const patchFiles = (await readdir(reviewsDir)).filter((name) => /^patch-validation-rev-\d+\.json$/.test(name));
    const records = (await Promise.all(patchFiles.map(async (name) => (JSON.parse(await readFile(join(reviewsDir, name), "utf8")) as { records: Array<{ apply: { status: string }; rootViolationIds?: string[] }> }).records))).flat();
    expect(records.some((record) => record.apply.status === "rejected" && (record.rootViolationIds ?? []).includes("unauthorized_formula_change"))).toBe(true);
    // 用户接受草稿：正式稿无篡改——不存在被冻结的篡改产物
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "accept_draft" });
    await pollRun(stack, runId, ["failed", "completed"]);
    for (const name of await readdir(sectionsDir)) {
      expect(await readFile(join(sectionsDir, name), "utf8")).not.toContain("修订补充");
    }
  });

  it("默认脚本（修订保留既有公式与数值）：fail → pass 照旧 Final，fact_preservation 规则 PASS", async () => {
    const stack = await newStack(["fail", "pass"]);
    const project = await stack.store.create("事实保持通过", { researchIdea: "检索增强生成" });
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;
    await approveTwice(stack, runId);
    const finished = await pollRun(stack, runId, ["completed"]);
    expect(finished.completion?.label).toBe("final");
    const r2 = await readGate(stack, project.id, 2);
    const rule = r2.gate.rules.find((entry) => entry.rule === "fact_preservation");
    expect(rule?.passed).toBe(true);
    expect(rule?.detail).toContain("实验事实保持通过");
    expect(r2.factPreservation?.ok).toBe(true);
    // 手动重评与 stage 同口径：POST /quality-gate 也产出事实保持规则
    const reevaluated = await stack.request("POST", `/api/projects/${project.id}/quality-gate`);
    const rules = (reevaluated.body["gate"] as { rules: { rule: string; passed: boolean }[] }).rules;
    expect(rules.find((rule) => rule.rule === "fact_preservation")?.passed).toBe(true);
  });
});
