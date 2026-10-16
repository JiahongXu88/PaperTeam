/**
 * M14.2 thesis_from_papers definition 结构测试：
 * - stage 全集与 plan 顺序（front 扫描 → 条件节点 → planSharedTail）；
 * - HITL options 契约；
 * - requiredInputs 防跳过；
 * - 计数器上限 → fail（AUTHOR_DECISION_REQUIRED）；
 * - WorkflowKind 路由（documentType → kind）。
 */

import { describe, expect, it } from "vitest";

import { createThesisFromPapersDefinition, type WorkflowServices } from "../../src/workflow/definitions.js";
import type { WorkflowState } from "../../src/workflow/types.js";
import { workflowKindForDocumentType } from "../../src/project/ProjectStore.js";
import { isThesisKind } from "../../src/workflow/kinds.js";

const services = { review: { maxRevisionRounds: 2 } } as unknown as WorkflowServices;
const definition = createThesisFromPapersDefinition(services);

function stateWith(completed: string[]): WorkflowState {
  const state = {
    schemaVersion: 1 as const,
    runId: "w-test",
    projectId: "p-test",
    workflowKind: "thesis_from_papers" as const,
    status: "running" as const,
    createdAt: "2026-10-15T00:00:00Z",
    updatedAt: "2026-10-15T00:00:00Z",
    completedStages: [...completed],
    stageResults: Object.fromEntries(completed.map((id) => [id, { done: true }])),
    stageHistory: completed.map((stageId) => ({
      stageId,
      attempt: 1,
      status: "completed" as const,
      startedAt: "2026-10-15T00:00:00Z",
      finishedAt: "2026-10-15T00:00:01Z",
      seq: 0,
    })),
    inputs: {},
    eventsSeq: 0,
  };
  return state as unknown as WorkflowState;
}

describe("M14.2 thesis_from_papers definition", () => {
  it("stage id 全集包含规划前段与共享后段（同 id 复用）", () => {
    const ids = definition.stages.map((stage) => stage.id);
    for (const id of [
      "thesis.ingest",
      "thesis.contributions",
      "hitl.scope_and_version",
      "hitl.fact_conflicts",
      "thesis.storyline",
      "hitl.outline_confirm",
      "thesis.evidence_supply",
      "hitl.author_decision",
      "writing.sections",
      "citation.verify",
      "review.run",
      "quality.gate",
      "revision.plan",
      "revision.revise",
      "revision.validate",
      "build.draft",
      "build.final",
    ]) {
      expect(ids).toContain(id);
    }
    expect(definition.kind).toBe("thesis_from_papers");
  });

  it("plan() 线性推进前段（首个未完成 stage）", () => {
    expect(definition.plan(stateWith([]))).toEqual({ kind: "stage", stageId: "thesis.ingest" });
    expect(definition.plan(stateWith(["thesis.ingest"]))).toEqual({ kind: "stage", stageId: "thesis.contributions" });
    expect(definition.plan(stateWith(["thesis.ingest", "thesis.contributions"]))).toEqual({
      kind: "stage",
      stageId: "hitl.scope_and_version",
    });
    const noConflicts = stateWith(["thesis.ingest", "thesis.contributions", "hitl.scope_and_version"]);
    (noConflicts.stageResults as Record<string, Record<string, unknown>>)["hitl.scope_and_version"] = {
      resolved: true,
      conflictsUnresolved: 0,
    };
    expect(definition.plan(noConflicts)).toEqual({ kind: "stage", stageId: "thesis.storyline" });
  });

  it("冲突未裁决（scope 结果计数 > 0）→ 先进 hitl.fact_conflicts；已解决则跳过", () => {
    const base = ["thesis.ingest", "thesis.contributions"];
    const withConflicts = stateWith([...base, "hitl.scope_and_version"]);
    (withConflicts.stageResults as Record<string, Record<string, unknown>>)["hitl.scope_and_version"] = {
      resolved: true,
      conflictsUnresolved: 2,
    };
    expect(definition.plan(withConflicts)).toEqual({ kind: "stage", stageId: "hitl.fact_conflicts" });
    const resolved = stateWith([...base, "hitl.scope_and_version", "hitl.fact_conflicts"]);
    (resolved.stageResults as Record<string, Record<string, unknown>>)["hitl.scope_and_version"] = {
      resolved: true,
      conflictsUnresolved: 2,
    };
    (resolved.stageResults as Record<string, Record<string, unknown>>)["hitl.fact_conflicts"] = { resolved: true };
    expect(definition.plan(resolved)).toEqual({ kind: "stage", stageId: "thesis.storyline" });
  });

  it("缺材料章（evidence_supply 结果）→ hitl.author_decision；无则跳过", () => {
    const base = [
      "thesis.ingest",
      "thesis.contributions",
      "hitl.scope_and_version",
      "thesis.storyline",
      "hitl.outline_confirm",
    ];
    const withScope = stateWith([...base, "thesis.evidence_supply"]);
    (withScope.stageResults as Record<string, Record<string, unknown>>)["hitl.scope_and_version"] = { resolved: true, conflictsUnresolved: 0 };
    (withScope.stageResults as Record<string, Record<string, unknown>>)["thesis.evidence_supply"] = { missingChapters: ["ch04"] };
    expect(definition.plan(withScope)).toEqual({ kind: "stage", stageId: "hitl.author_decision" });
    (withScope.stageResults as Record<string, Record<string, unknown>>)["hitl.author_decision"] = { resolved: true };
    expect(definition.plan(withScope)).toEqual({ kind: "stage", stageId: "writing.sections" });
  });

  it("写作完成后进入共享后段（quality.gate 新鲜度驱动）", () => {
    const state = stateWith([
      "thesis.ingest",
      "thesis.contributions",
      "hitl.scope_and_version",
      "thesis.storyline",
      "hitl.outline_confirm",
      "thesis.evidence_supply",
      "writing.sections",
      "citation.verify",
      "review.run",
    ]);
    (state.stageResults as Record<string, Record<string, unknown>>)["hitl.scope_and_version"] = { resolved: true, conflictsUnresolved: 0 };
    (state.stageResults as Record<string, Record<string, unknown>>)["thesis.evidence_supply"] = { missingChapters: [] };
    // M14.6：正文初稿完成后先生成双语摘要（一次），再进入共享后段
    expect(definition.plan(state)).toEqual({ kind: "stage", stageId: "thesis.abstract" });
    (state.stageResults as Record<string, Record<string, unknown>>)["thesis.abstract"] = { saved: true };
    const decision = definition.plan(state);
    expect(decision).toEqual({ kind: "stage", stageId: "quality.gate" });
  });

  it("HITL options 契约（scope / conflicts / outline / author_decision）", () => {
    const scope = definition.stages.find((stage) => stage.id === "hitl.scope_and_version");
    expect(scope && "hitl" in scope ? scope.hitl.options : null).toEqual([
      "include",
      "exclude",
      "select_version",
      "allow_unpublished",
      "deny_unpublished",
      "confirm_facts",
      "confirm_contribution",
      "reject_contribution",
      "approve",
      "cancel",
    ]);
    const conflicts = definition.stages.find((stage) => stage.id === "hitl.fact_conflicts");
    expect(conflicts && "hitl" in conflicts ? conflicts.hitl.options : null).toEqual([
      "adopt_fact",
      "keep_both",
      "request_material",
      "defer",
      "approve",
      "cancel",
    ]);
    const outline = definition.stages.find((stage) => stage.id === "hitl.outline_confirm");
    expect(outline && "hitl" in outline ? outline.hitl.options : null).toEqual(["approve", "revise", "cancel"]);
    const authorDecision = definition.stages.find((stage) => stage.id === "hitl.author_decision");
    expect(authorDecision && "hitl" in authorDecision ? authorDecision.hitl.options : null).toEqual([
      "write_as_limitation",
      "defer_chapter",
      "attach_experiment_package",
      "supply_research_record",
      "supply_manuscript",
      "confirm_missing",
      "reject_gap",
      "pause",
      "approve",
      "cancel",
    ]);
  });

  it("requiredInputs 防跳过（贡献提取依赖 ingest；大纲确认依赖 storyline）", () => {
    const contributions = definition.stages.find((stage) => stage.id === "thesis.contributions");
    expect(contributions?.requiredInputs).toEqual(["thesis.ingest"]);
    const storyline = definition.stages.find((stage) => stage.id === "thesis.storyline");
    expect(storyline?.requiredInputs).toEqual(["hitl.scope_and_version"]);
    const outlineConfirm = definition.stages.find((stage) => stage.id === "hitl.outline_confirm");
    expect(outlineConfirm?.requiredInputs).toEqual(["thesis.storyline"]);
  });

  it("计数器超限 → fail(AUTHOR_DECISION_REQUIRED)（不无限停留 HITL）", () => {
    const state = stateWith([]);
    (state as unknown as { counters: Record<string, number> }).counters = { "thesis.scope_rounds": 25 };
    const decision = definition.plan(state);
    expect(decision.kind).toBe("fail");
    if (decision.kind === "fail") {
      expect(decision.code).toBe("AUTHOR_DECISION_REQUIRED");
    }
  });

  it("documentType → kind 路由：master/doctoral thesis → thesis_from_papers；显式 kind 优先路径不受影响", () => {
    expect(workflowKindForDocumentType("master_thesis")).toBe("thesis_from_papers");
    expect(workflowKindForDocumentType("doctoral_thesis")).toBe("thesis_from_papers");
    expect(workflowKindForDocumentType("survey")).toBe("topic_survey");
    expect(workflowKindForDocumentType("research_article")).toBe("idea_to_paper");
    expect(workflowKindForDocumentType(undefined)).toBe("idea_to_paper");
    expect(isThesisKind("thesis_from_papers")).toBe(true);
    expect(isThesisKind("topic_survey")).toBe(false);
  });
});
