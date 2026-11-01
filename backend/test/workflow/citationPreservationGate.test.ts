/**
 * Citation Preservation Gate 的 scripted workflow 回归（M5.6）：
 * - [cite:drop]：实验章节多带一条只在该节出现的引用（lewis2020retrieval；该节的 finding 是 academic，
 *   计划没有删除依据）；Writer 修订把被修订章节的 \cite 全部删掉 → 复审虽 pass，quality.gate 仍以
 *   citation_keys_preserved FAIL（lewis2020retrieval 无依据消失；引言的 fact finding 允许其论述随证据不足
 *   删除，但 gao2023retrieval 仍在其它章节被引用，不构成丢失）
 *   → Final 被阻止；revision.plan 派发 citation_removed 恢复条目（有章节归属，Writer 可执行）；
 *   Writer 再次删掉 → CONVERGED → stalled HITL → accept_draft → Draft 仍可构建，但 build.draft
 *   明确暴露引用保持失败。全部删光（catastrophic）与历史回归见 citationPreservation.test。
 * - 默认脚本（修订保留 \cite）：fail → pass 照旧 Final，第二轮 gate 的引用保持规则 PASS。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

// 全流程 e2e（真实编排 + 多轮修订）在全量并发下可能超过默认 5s——与兄弟 workflow
// 测试文件同口径放宽（pollRun 自身仍以 20s 逻辑超时兜底）
vi.setConfig({ testTimeout: 20_000 });

import type { WorkflowState } from "../../src/workflow/types.js";
import { scriptedIdeaRuntime, startTestStack, type TestStack } from "../helpers/testStack.js";

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

async function approveTwice(stack: TestStack, runId: string): Promise<void> {
  await pollRun(stack, runId, ["awaiting_input"]);
  await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
  await pollRun(stack, runId, ["awaiting_input"]);
  await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
}

/**
 * M6.7：修订复核 HITL（hitl.revision_validation）出现时自动 approve（用户明示
 * 接受本轮修订——含无依据的引用丢失），直到出现目标 stage 的 awaiting_input。
 * 既有断言口径不变：approve 后 Revision Gate 按用户决策放行，gate 阻止项仍只有
 * citation_keys_preserved。
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
  citationPreservation?: {
    ok: boolean;
    catastrophic: boolean;
    previousCount: number;
    currentCount: number;
    unexpectedRemovedKeys: string[];
    addedKeys: string[];
    unexpectedRemoved: { key: string; files: string[] }[];
  } | null;
}

async function readGate(stack: TestStack, projectId: string, round: number): Promise<GateArtifact> {
  return JSON.parse(await readFile(join(stack.root, projectId, "reviews", `quality-gate-r${round}.json`), "utf8")) as GateArtifact;
}

describe("Citation Preservation Gate（scripted workflow）", () => {
  it("Writer 修订丢失引用：候选在写入前被拒（M15.20：文件级目标同一守卫）→ 正式稿引用完整；复审 pass 也不能 Final", async () => {
    const stack = await newStack(["fail", "pass"]);
    const project = await stack.store.create("引用删光回归", { researchIdea: "[cite:drop] 检索增强生成" });
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;

    await approveTwice(stack, runId);
    // M15.20 P0：旧链路是「删光引用的修订落盘 → gate 的引用保持规则事后检出 → 恢复条目」；文件级修订
    // 目标现与 span 候选同一候选守卫（引用删除即拒绝），删光引用的候选从未落盘，拒绝记录 fail-closed 留档。
    const stalled = await pollRunApprovingValidation(stack, runId, "hitl.revision_stalled");
    expect(stalled.awaiting?.stageId).toBe("hitl.revision_stalled");
    const gateReasons = stalled.awaiting?.payload?.["gateReasons"] as string[];
    expect(gateReasons.join("\n")).toContain("patch_validation_publishable");

    const r1 = await readGate(stack, project.id, 1);
    expect(r1.gate.rules.find((rule) => rule.rule === "citation_keys_preserved")?.passed).toBe(true);
    const r2 = await readGate(stack, project.id, 2);
    expect(r2.gate.passed).toBe(false);
    // 引用删除从未落盘：引用保持规则本身 PASS，阻止项来自被拒候选的 fail-closed 记录
    expect(r2.gate.rules.find((rule) => rule.rule === "citation_keys_preserved")?.passed).toBe(true);
    const experiments = await readFile(join(stack.root, project.id, "manuscript", "sections", "experiments.tex"), "utf8");
    expect(experiments).toContain("lewis2020retrieval");
    const { readdir } = await import("node:fs/promises");
    const reviewsDir = join(stack.root, project.id, "reviews");
    const patchFiles = (await readdir(reviewsDir)).filter((name) => /^patch-validation-rev-\d+\.json$/.test(name));
    const records = (await Promise.all(patchFiles.map(async (name) => (JSON.parse(await readFile(join(reviewsDir, name), "utf8")) as { records: Array<{ apply: { status: string }; rootViolationIds?: string[] }> }).records))).flat();
    expect(records.some((record) => record.apply.status === "rejected" && (record.rootViolationIds ?? []).includes("citation_removed"))).toBe(true);

    // 用户接受草稿：Draft 可构建但不是 Final；终稿引用完整
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "accept_draft" });
    const finished = await pollRun(stack, runId, ["completed", "failed"]);
    expect(finished.stageHistory.some((record) => record.stageId === "build.final")).toBe(false);
    expect(await readFile(join(stack.root, project.id, "manuscript", "sections", "experiments.tex"), "utf8")).toContain("lewis2020retrieval");
  });

  it("默认脚本（修订保留既有 \\cite）：fail → pass 照旧 Final，第二轮 gate 的引用保持规则 PASS", async () => {
    const stack = await newStack(["fail", "pass"]);
    const project = await stack.store.create("引用保持通过", { researchIdea: "检索增强生成" });
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;
    await approveTwice(stack, runId);
    const finished = await pollRun(stack, runId, ["completed"]);
    expect(finished.completion?.label).toBe("final");
    const r2 = await readGate(stack, project.id, 2);
    const rule = r2.gate.rules.find((entry) => entry.rule === "citation_keys_preserved");
    expect(rule?.passed).toBe(true);
    expect(rule?.detail).toContain("无 key 丢失");
    expect(r2.citationPreservation?.ok).toBe(true);
    expect(r2.citationPreservation?.previousCount).toBe(r2.citationPreservation?.currentCount);
    const draft = finished.stageResults["build.draft"] as Record<string, unknown>;
    expect(draft["citationPreservation"]).toBeUndefined();
  });
});
