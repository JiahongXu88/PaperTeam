/**
 * M11.2.3 workflow 层接线测试（D-3/D-4）。
 *
 * 覆盖：
 * 1. planSharedTail 路由：revision.plan 结果含 groundClaims>0 → 先路由
 *    evidence.ground_claims（Evidence First：采证先于 Writer 派发）；本轮已
 *    采证过（groundIdx ≥ planIdx）不重复；
 * 2. 收敛终态：quality.gate 结果 convergence=STALLED → 优先路由
 *    hitl.revision_stalled（不再「还有轮数就继续」）；REGRESSED 不抢跑
 *    （保留守卫违规的确定性修复轮）；
 * 3. Writer prompt 渲染 mustPreserve 前置约束。
 */

import { describe, expect, it } from "vitest";

import {
  createTopicSurveyDefinition,
} from "../../src/workflow/definitions.js";
import type { WorkflowServices } from "../../src/workflow/definitions.js";
import type { WorkflowState } from "../../src/workflow/types.js";
import { buildRevisePrompt } from "../../src/writer/WriterService.js";
import type { RevisionPlanItem } from "../../src/review/revisionPlan.js";

const services = {
  review: { maxRevisionRounds: 5 },
} as unknown as WorkflowServices;
const definition = createTopicSurveyDefinition(services);

const FRONT = [
  "research.plan",
  "hitl.research_plan",
  "survey.search",
  "hitl.literature_selection",
  "survey.fulltext",
  "survey.matrix",
  "hitl.matrix_confirm",
  "survey.synthesis",
  "survey.outline",
  "hitl.outline_confirm",
] as const;

function tailState(
  stageResults: Record<string, Record<string, unknown>>,
  history: { stageId: string; result?: Record<string, unknown> }[] = [],
): WorkflowState {
  const results: Record<string, Record<string, unknown>> = {};
  for (const stageId of FRONT) {
    results[stageId] = {};
  }
  results["writing.sections"] = {};
  results["citation.verify"] = {};
  results["review.run"] = { round: 9 };
  results["quality.gate"] = { passed: false, round: 9, reasons: ["academic_score_threshold: 72 < 80"], outcome: "IMPROVED", ...stageResults["quality.gate"] };
  results["revision.plan"] = { round: 9, planned: 2, ...stageResults["revision.plan"] };
  for (const entry of history) {
    results[entry.stageId] = { ...(results[entry.stageId] ?? {}), ...(entry.result ?? {}) };
  }
  return {
    schemaVersion: 1,
    runId: "w-test",
    projectId: "p1",
    workflowKind: "topic_survey",
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedStages: Object.keys(results),
    stageResults: results,
    stageHistory: Object.keys(results).map((stageId) => ({
      stageId,
      attempt: 1,
      status: "completed" as const,
      startedAt: new Date().toISOString(),
      finishedAt: new Date().toISOString(),
      ...(results[stageId] !== undefined ? { summary: results[stageId] } : {}),
    })),
    inputs: {},
    counters: {},
    eventsSeq: 0,
  };
}

describe("planSharedTail 路由（M11.2.3）", () => {
  it("groundClaims>0 → 先 evidence.ground_claims 再 revise（Evidence First）", () => {
    const state = tailState({ "revision.plan": { groundClaims: 3 } });
    expect(definition.plan(state)).toEqual({ kind: "stage", stageId: "evidence.ground_claims" });
  });

  it("本轮已采证（ground_claims 完成于 plan 之后）→ 不重复，直接 revise", () => {
    const state = tailState({ "revision.plan": { groundClaims: 3 } }, [
      { stageId: "evidence.ground_claims", result: { verifiedClaims: 2 } },
    ]);
    expect(definition.plan(state)).toEqual({ kind: "stage", stageId: "revision.revise" });
  });

  it("groundClaims=0 → 不路由采证（正常路径零改动）", () => {
    const state = tailState({ "revision.plan": { groundClaims: 0 } });
    expect(definition.plan(state)).toEqual({ kind: "stage", stageId: "revision.revise" });
  });

  it("convergence=STALLED → 优先 stalled HITL（轮数预算不再是继续的理由）", () => {
    const state = tailState({
      "revision.plan": { groundClaims: 0 },
      "quality.gate": { convergence: "STALLED", outcome: "IMROVED_ROUND".slice(0, 0) || "IMPROVED" },
    });
    expect(definition.plan(state)).toEqual({ kind: "stage", stageId: "hitl.revision_stalled" });
  });

  it("convergence=REGRESSED → 不抢跑（保留 fact/citation 违规的确定性修复轮）", () => {
    const state = tailState({
      "revision.plan": { groundClaims: 0 },
      "quality.gate": { convergence: "REGRESSED" },
    });
    expect(definition.plan(state)).toEqual({ kind: "stage", stageId: "revision.revise" });
  });
});

describe("Writer mustPreserve 渲染（D-4 §15）", () => {
  it("buildRevisePrompt 渲染「绝对不可变动的数值 / 引用」前置约束", () => {
    const item: RevisionPlanItem = {
      id: "f-abc123def456",
      kind: "review_finding",
      priority: "high",
      section: "sections/introduction.tex",
      problem: "论述缺少证据限定",
      instruction: "为该论断添加归因式限定",
      expectedOutcome: "复审通过",
      status: "planned",
      mustPreserve: {
        values: ["2021", "72%", "3139"],
        citationKeys: ["du2023does", "zhang2024survey"],
      },
    };
    const prompt = buildRevisePrompt({
      section: { id: "introduction", file: "introduction.tex", title: "引言" },
      outline: { sections: [], abstract: "" } as never,
      currentLatex: "\\section{引言}\n现有内容。",
      issues: [
        {
          category: "academic",
          severity: "major",
          section: "sections/introduction.tex",
          description: "论述缺少证据限定",
          blocking: false,
        },
      ],
      evidence: [],
      bibliography: [],
      revisionItems: [item],
    });
    expect(prompt).toContain("绝对不可变动的数值");
    expect(prompt).toContain("2021、72%、3139");
    expect(prompt).toContain("绝对不可移除的引用");
    expect(prompt).toContain("du2023survey".slice(0, 0) || "du2023does");
  });
});
