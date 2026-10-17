/**
 * M14.7 — 摘要刷新的 planner 决策测试（plan() 级，确定性）。
 *
 * M14.6 遗留：摘要刷新只在 gate 通过路径执行，Draft 终态保留写作期摘要且无过期标记。
 * M14.7 修正（planSharedTail 规则 0c）：
 *   - 正文在摘要生成之后被修订 → 预算允许时先刷新摘要（Draft 路径同样刷新）；
 *   - 预算耗尽 → 不派发刷新（由 gate 规则 thesis_abstract_snapshot_current 标记 ABSTRACT_STALE）；
 *   - 摘要已新于最近改稿 → 不重复派发（可以证明正文未变化时不重复生成）。
 */
import { describe, expect, it } from "vitest";

import { createThesisFromPapersDefinition, type WorkflowServices } from "../../src/workflow/definitions.js";
import type { WorkflowState } from "../../src/workflow/types.js";

function stateWith(completed: string[]): WorkflowState {
  const state = {
    schemaVersion: 1 as const,
    runId: "w-test",
    projectId: "p-test",
    workflowKind: "thesis_from_papers" as const,
    status: "running" as const,
    createdAt: "2026-10-17T00:00:00Z",
    updatedAt: "2026-10-17T00:00:00Z",
    completedStages: [...completed],
    stageResults: Object.fromEntries(completed.map((id) => [id, { done: true }])),
    stageHistory: completed.map((stageId, index) => ({
      stageId,
      attempt: 1,
      status: "completed" as const,
      startedAt: "2026-10-17T00:00:00Z",
      finishedAt: "2026-10-17T00:00:01Z",
      seq: index,
    })),
    inputs: {},
    eventsSeq: 0,
  };
  return state as unknown as WorkflowState;
}

const FRONT = [
  "thesis.ingest",
  "thesis.contributions",
  "hitl.scope_and_version",
  "thesis.storyline",
  "hitl.outline_confirm",
  "thesis.evidence_supply",
  "writing.sections",
];

/** 带一轮「gate 失败 → 修订接受」的状态（摘要在修订之前生成） */
function revisedAfterAbstract(): WorkflowState {
  const state = stateWith([
    ...FRONT,
    "thesis.abstract",
    "citation.verify",
    "review.run",
    "quality.gate",
    "revision.plan",
    "revision.revise",
    "revision.validate",
  ]);
  const results = state.stageResults as Record<string, Record<string, unknown>>;
  results["hitl.scope_and_version"] = { resolved: true, conflictsUnresolved: 0 };
  results["thesis.evidence_supply"] = { missingChapters: [] };
  results["thesis.abstract"] = { saved: true };
  results["quality.gate"] = { passed: false, round: 1, reasons: ["…"] };
  results["revision.plan"] = { planned: 2, round: 1 };
  results["revision.revise"] = { revisedSections: 2, appliedItems: 2 };
  return state;
}

describe("M14.7 planSharedTail 规则 0c：摘要刷新", () => {
  it("修订发生在摘要之后 + 预算可用 → 先刷新摘要再走尾部复审", () => {
    const services = { review: { maxRevisionRounds: 2 } } as unknown as WorkflowServices;
    const definition = createThesisFromPapersDefinition(services);
    expect(definition.plan(revisedAfterAbstract())).toEqual({ kind: "stage", stageId: "thesis.abstract" });
  });

  it("预算耗尽 → 不派发刷新（gate 规则将如实标记 ABSTRACT_STALE），继续走尾部新鲜度规则", () => {
    const services = {
      review: { maxRevisionRounds: 2 },
      modelBudget: {
        snapshotSync: () => ({
          runId: "w-test",
          calls: 30,
          tokens: 100,
          limits: { maxModelCallsPerRun: 30, maxRunTokensPerRun: 0 },
          exceeded: true,
          exceededReason: "calls",
        }),
      },
    } as unknown as WorkflowServices;
    const definition = createThesisFromPapersDefinition(services);
    // 引用核验过期（修订晚于 citation.verify）→ 规则 1 先行；摘要刷新被跳过
    expect(definition.plan(revisedAfterAbstract())).toEqual({ kind: "stage", stageId: "citation.verify" });
  });

  it("摘要已新于最近改稿 → 不重复派发（正文未变化不重复生成）", () => {
    const services = { review: { maxRevisionRounds: 2 } } as unknown as WorkflowServices;
    const definition = createThesisFromPapersDefinition(services);
    const state = stateWith([
      ...FRONT,
      "thesis.abstract",
      "citation.verify",
      "review.run",
      "quality.gate",
      "revision.plan",
      "revision.revise",
      "revision.validate",
      "thesis.abstract",
      "citation.verify",
      "review.run",
      "quality.gate",
    ]);
    const results = state.stageResults as Record<string, Record<string, unknown>>;
    results["hitl.scope_and_version"] = { resolved: true, conflictsUnresolved: 0 };
    results["thesis.evidence_supply"] = { missingChapters: [] };
    results["thesis.abstract"] = { saved: true };
    results["quality.gate"] = { passed: true, round: 2, reasons: [] };
    // gate 通过且摘要新于改稿 → 直接进入构建，不再刷新摘要
    expect(definition.plan(state)).toEqual({ kind: "stage", stageId: "build.draft" });
  });
});

describe("M14.7 Draft 路径构建失败的有界修复", () => {
  /** stalled 已 accept_draft + 摘要已刷新 + 构建失败（带诊断定位）的状态 */
  function draftBuildFailed(): WorkflowState {
    const state = stateWith([
      ...FRONT,
      "thesis.abstract",
      "citation.verify",
      "review.run",
      "quality.gate",
      "revision.plan",
      "revision.revise",
      "revision.validate",
      "thesis.abstract",
      "citation.verify",
      "review.run",
      "quality.gate",
      "hitl.revision_stalled",
      "build.draft",
    ]);
    const results = state.stageResults as Record<string, Record<string, unknown>>;
    results["hitl.scope_and_version"] = { resolved: true, conflictsUnresolved: 0 };
    results["thesis.evidence_supply"] = { missingChapters: [] };
    results["thesis.abstract"] = { saved: true };
    results["quality.gate"] = { passed: false, round: 1, outcome: "REGRESSION", reasons: ["academic_score_threshold: …"] };
    results["revision.revise"] = { revisedSections: 3, appliedItems: 3 };
    results["hitl.revision_stalled"] = { decision: "accept_draft", gateRound: 1 };
    results["build.draft"] = { buildOk: false, revision: 3, diagnosticFiles: ["sections/method-nmpc-formulation.tex"] };
    return state;
  }

  it("build.draft 失败 + 预算可用 → 先走有界 LaTeX 修复（此前 Draft 路径无修复，M14.7 真实 run 实证）", () => {
    const services = { review: { maxRevisionRounds: 2 } } as unknown as WorkflowServices;
    const definition = createThesisFromPapersDefinition(services);
    expect(definition.plan(draftBuildFailed())).toEqual({ kind: "stage", stageId: "revision.repair_latex" });
  });

  it("预算耗尽 → 不派发修复（模型调用），如实带 buildOk=false 完成（不伪造 Draft）", () => {
    const services = {
      review: { maxRevisionRounds: 2 },
      modelBudget: {
        snapshotSync: () => ({
          runId: "w-test",
          calls: 33,
          tokens: 100,
          limits: { maxModelCallsPerRun: 33, maxRunTokensPerRun: 0 },
          exceeded: true,
          exceededReason: "calls",
        }),
      },
    } as unknown as WorkflowServices;
    const definition = createThesisFromPapersDefinition(services);
    const decision = definition.plan(draftBuildFailed()) as { kind: string; label?: string };
    expect(decision.kind).toBe("complete");
    expect(decision.label).toBe("draft");
  });
});
