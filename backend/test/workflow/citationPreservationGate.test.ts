/**
 * Citation Preservation Gate 的 scripted workflow 回归（M5.6）：
 * - [cite:drop]：实验章节多带一条只在该节出现的引用（lewis2020rag；该节的 finding 是 academic，
 *   计划没有删除依据）；Writer 修订把被修订章节的 \cite 全部删掉 → 复审虽 pass，quality.gate 仍以
 *   citation_keys_preserved FAIL（lewis2020rag 无依据消失；引言的 fact finding 允许其论述随证据不足
 *   删除，但 gao2023survey 仍在其它章节被引用，不构成丢失）
 *   → Final 被阻止；revision.plan 派发 citation_removed 恢复条目（有章节归属，Writer 可执行）；
 *   Writer 再次删掉 → CONVERGED → stalled HITL → accept_draft → Draft 仍可构建，但 build.draft
 *   明确暴露引用保持失败。全部删光（catastrophic）与历史回归见 citationPreservation.test。
 * - 默认脚本（修订保留 \cite）：fail → pass 照旧 Final，第二轮 gate 的引用保持规则 PASS。
 */

import { readFile } from "node:fs/promises";
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
  it("Writer 修订丢失引用：复审 pass 也不能 Final；plan 派发 citation_removed；Draft 路径明确暴露", async () => {
    const stack = await newStack(["fail", "pass"]);
    const project = await stack.store.create("引用删光回归", { researchIdea: "[cite:drop] 检索增强生成" });
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;

    await approveTwice(stack, runId);
    // r1 fail → revise（删光）→ Revision Validation 拦截（引用无依据丢失 → 条目
    // rejected，M6.7：先于 gate 的修订复核 HITL；测试以 approve 放行）→ r2 pass，
    // 但 gate 失败（IMPROVED：失败规则集缩小）→ plan r2 → revise（仍删光）→ 复核
    // 再拦截 → r3 pass → gate 失败且失败集合相同 → CONVERGED → stalled HITL
    const stalled = await pollRunApprovingValidation(stack, runId, "hitl.revision_stalled");
    expect(stalled.awaiting?.stageId).toBe("hitl.revision_stalled");
    expect(stalled.awaiting?.payload?.["outcome"]).toBe("CONVERGED");
    const gateReasons = stalled.awaiting?.payload?.["gateReasons"] as string[];
    expect(gateReasons.join("\n")).toContain("citation_keys_preserved");

    // 第一轮：outline 骨架修订 → 写作修订，引用只增不减 → PASS；
    // 第二轮：写作修订 → 修订后，lewis2020rag（只在实验章节出现）随被修订章节的引用一起消失 → FAIL
    const r1 = await readGate(stack, project.id, 1);
    expect(r1.gate.rules.find((rule) => rule.rule === "citation_keys_preserved")?.passed).toBe(true);
    expect(r1.citationPreservation?.previousCount).toBe(0);
    expect(r1.citationPreservation?.addedKeys).toEqual(["gao2023survey", "lewis2020rag"]);
    const r2 = await readGate(stack, project.id, 2);
    expect(r2.gate.passed).toBe(false);
    expect(r2.gate.reasons).toHaveLength(1); // 复审已 pass：唯一阻止项就是引用保持
    expect(r2.gate.reasons[0]).toContain("citation_keys_preserved");
    expect(r2.citationPreservation?.catastrophic).toBe(false); // 其它章节仍引用 gao2023survey
    expect(r2.citationPreservation?.previousCount).toBeGreaterThan(r2.citationPreservation?.currentCount ?? 0);
    expect(r2.citationPreservation?.currentCount).toBeGreaterThan(0);
    expect(r2.citationPreservation?.unexpectedRemovedKeys).toEqual(["lewis2020rag"]);
    const previousFiles = r2.citationPreservation?.unexpectedRemoved[0]?.files ?? [];
    expect(previousFiles).toEqual(["sections/experiments.tex"]);

    // 第二轮计划：为每个上一修订中引用过的章节派发 citation_removed 恢复条目（有章节归属，可执行）。
    // M6.7 完整生命周期：Writer 仍删光引用 → Revision Validation 机器判 rejected
    // （验证产物留档）→ 用户 approve → 条目落 approved（resolution 记录 user_approved）
    const validation = JSON.parse(
      await readFile(join(stack.root, project.id, "reviews", "revision-validation-r2.json"), "utf8"),
    ) as { items: { kind: string; status: string }[] };
    expect(
      validation.items.filter((item) => item.kind === "citation_removed").every((item) => item.status === "rejected"),
    ).toBe(true);
    const plan = JSON.parse(
      await readFile(join(stack.root, project.id, "reviews", "revision-plan-r2.json"), "utf8"),
    ) as { sourceRevision: number; items: { id: string; kind: string; status: string; section: string; priority: string; resolution?: string }[] };
    expect(plan.sourceRevision).toBe(3); // 第二轮 review 审阅的是修订后的 rev-3；gate 比较的是 rev-2 → rev-3
    const removedItems = plan.items.filter((item) => item.kind === "citation_removed");
    expect(removedItems.length).toBe(previousFiles.length);
    expect(removedItems.every((item) => item.priority === "high")).toBe(true);
    expect(removedItems.map((item) => item.section).sort()).toEqual([...previousFiles].sort());
    expect(removedItems[0]?.id).toBe("citation-removed:lewis2020rag:sections/experiments.tex");
    expect(removedItems.every((item) => item.status === "approved")).toBe(true);
    expect(removedItems.every((item) => (item.resolution ?? "").startsWith("user_approved"))).toBe(true);

    // 用户接受草稿：Draft 仍可构建，但 build.draft 结果与事件明确暴露引用保持失败；没有 Final
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "accept_draft" });
    const finished = await pollRun(stack, runId, ["completed"]);
    expect(finished.completion?.label).toBe("draft");
    expect(finished.completion?.summary?.["qualityGatePassed"]).toBe(false);
    expect((finished.completion?.summary?.["qualityGateReasons"] as string[]).join("\n")).toContain("citation_keys_preserved");
    const draft = finished.stageResults["build.draft"] as Record<string, unknown>;
    expect(draft["buildOk"]).toBe(true);
    expect(draft["citationPreservation"]).toMatchObject({ passed: false, unexpectedRemovedKeys: ["lewis2020rag"] });
    expect(finished.stageHistory.some((record) => record.stageId === "build.final")).toBe(false);
    const { events } = await stack.orchestrator.readEvents(runId);
    const buildEvent = events.find((event) => event.type === "build_gate.passed");
    expect(buildEvent?.message).toContain("引用保持未通过");
    expect((buildEvent?.data?.["citationPreservation"] as { passed: boolean }).passed).toBe(false);
    // 手动重评与 stage 同口径：POST /quality-gate 也产出引用保持规则
    const reevaluated = await stack.request("POST", `/api/projects/${project.id}/quality-gate`);
    const rules = (reevaluated.body["gate"] as { rules: { rule: string; passed: boolean }[] }).rules;
    expect(rules.find((rule) => rule.rule === "citation_keys_preserved")?.passed).toBe(false);
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
