/**
 * topic_survey Workflow 定义测试（M11.1.4 第一层：definition 纯函数）。
 *
 * 覆盖：
 * 1. stage 注册表顺序 = 设计的 stage graph（Research Plan → HITL → Search →
 *    Selection → Fulltext → Matrix → HITL → Synthesis → Outline → HITL）；
 * 2. plan() 线性推进 + 完成 label=survey（summary 字段来自 stageResults）;
 * 3. HITL 节点的 options 契约（decision 集合）；
 * 4. recommendedSurveyCandidateIds 纯函数（学术形态优先 / 年份降序 / 上限）。
 *
 * plan() 只读 state——用最小 stub services 构造定义，不启动栈。
 */

import { describe, expect, it } from "vitest";

import {
  createTopicSurveyDefinition,
  recommendedSurveyCandidateIds,
} from "../../src/workflow/definitions.js";
import type { WorkflowServices } from "../../src/workflow/definitions.js";
import type { CandidateSource } from "../../src/sources/CandidateStore.js";
import type { WorkflowState } from "../../src/workflow/types.js";

const definition = createTopicSurveyDefinition({} as unknown as WorkflowServices);

function stateWith(completed: string[]): WorkflowState {
  const stageResults: Record<string, Record<string, unknown>> = {};
  for (const stageId of completed) {
    stageResults[stageId] = {};
  }
  return {
    schemaVersion: 1,
    runId: "w-test",
    projectId: "p1",
    workflowKind: "topic_survey",
    status: "running",
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
    completedStages: completed,
    stageResults,
    stageHistory: [],
    inputs: {},
    counters: {},
    eventsSeq: 0,
  };
}

describe("topic_survey definition", () => {
  it("stage 顺序符合设计（plan → hitl → search → selection → fulltext → matrix → hitl → synthesis → outline → hitl）", () => {
    expect(definition.kind).toBe("topic_survey");
    expect(definition.stages.map((stage) => stage.id)).toEqual([
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
    ]);
  });

  it("plan() 从空 state 依次推进每个前置 stage，全部完成后 label=survey 收口", () => {
    const sequence = [
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
    ];
    const state = stateWith([]);
    for (const expected of sequence) {
      const decision = definition.plan(state);
      expect(decision).toEqual({ kind: "stage", stageId: expected });
      state.stageResults[expected] = {};
    }
    const completion = definition.plan(state);
    expect(completion.kind).toBe("complete");
    if (completion.kind === "complete") {
      expect(completion.label).toBe("survey");
      expect(completion.summary).toEqual({
        sections: 0,
        matrixEntries: 0,
        synthesisItems: 0,
        selectedLiterature: 0,
      });
    }
  });

  it("完成 summary 从 stageResults 汇总（sections / matrixEntries / selectedLiterature）", () => {
    const state = stateWith([
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
    ]);
    state.stageResults["survey.outline"]!["sections"] = 9;
    state.stageResults["survey.matrix"]!["entries"] = 21;
    state.stageResults["survey.synthesis"]!["synthesisItems"] = 28;
    state.stageResults["hitl.literature_selection"]!["candidateIds"] = [
      "C001",
      "C002",
      "C003",
    ];
    const completion = definition.plan(state);
    expect(completion).toEqual({
      kind: "complete",
      label: "survey",
      summary: {
        sections: 9,
        matrixEntries: 21,
        synthesisItems: 28,
        selectedLiterature: 3,
      },
    });
  });

  it("HITL 节点 options 契约：plan 批准 / 文献遴选 / 矩阵确认 / 大纲确认", () => {
    const hitl = definition.stages.filter((stage) => "hitl" in stage);
    expect(hitl.map((stage) => stage.id)).toEqual([
      "hitl.research_plan",
      "hitl.literature_selection",
      "hitl.matrix_confirm",
      "hitl.outline_confirm",
    ]);
    const optionsById = new Map(hitl.map((stage) => [stage.id, stage.hitl.options]));
    expect(optionsById.get("hitl.research_plan")).toEqual(["approve", "revise", "cancel"]);
    expect(optionsById.get("hitl.literature_selection")).toEqual(["approve", "cancel"]);
    expect(optionsById.get("hitl.matrix_confirm")).toEqual(["approve", "revise", "cancel"]);
    expect(optionsById.get("hitl.outline_confirm")).toEqual(["approve", "revise", "cancel"]);
  });

  it("执行型 stage 的 requiredInputs 防跳步（search 需计划批准、matrix 需全文准备）", () => {
    const byId = new Map(definition.stages.map((stage) => [stage.id, stage]));
    expect(byId.get("survey.search")!.requiredInputs).toEqual(["hitl.research_plan"]);
    expect(byId.get("survey.fulltext")!.requiredInputs).toEqual(["hitl.literature_selection"]);
    expect(byId.get("survey.matrix")!.requiredInputs).toEqual(["survey.fulltext"]);
    expect(byId.get("survey.synthesis")!.requiredInputs).toEqual(["hitl.matrix_confirm"]);
    expect(byId.get("survey.outline")!.requiredInputs).toEqual(["survey.synthesis"]);
  });
});

describe("recommendedSurveyCandidateIds", () => {
  const candidate = (id: string, fields: Partial<CandidateSource> = {}): CandidateSource =>
    ({
      candidateId: id,
      identity: {
        doi: `10.1000/${id.toLowerCase()}`,
        normalizedTitleFingerprint: `title-${id.toLowerCase()}`,
      },
      origin: "academic_search",
      provider: "openalex",
      status: "pending_review",
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...fields,
    }) as CandidateSource;

  it("学术形态（DOI / arXiv）优先于无身份线索的 Web 候选", () => {
    const web = candidate("C001", {
      origin: "web_search",
      doi: undefined,
      identity: { url: "https://blog.example.org/a", normalizedTitleFingerprint: "blog-a" },
    });
    const paper = candidate("C002", { doi: "10.1234/p2" });
    expect(recommendedSurveyCandidateIds([web, paper])).toEqual(["C002"]);
  });

  it("年份降序、candidateId 升序破平（确定性）", () => {
    const ids = recommendedSurveyCandidateIds([
      candidate("C003", { doi: "10.1/3", year: 2019 }),
      candidate("C001", { doi: "10.1/1", year: 2023 }),
      candidate("C002", { doi: "10.1/2", year: 2023 }),
      candidate("C004", { doi: "10.1/4" }),
    ]);
    expect(ids).toEqual(["C001", "C002", "C003", "C004"]);
  });

  it("上限 25 条（超出截断）；无学术形态时回退全部待审", () => {
    const many = Array.from({ length: 40 }, (_, index) =>
      candidate(`C${String(index + 1).padStart(3, "0")}`, { doi: `10.1/${index}`, year: 2020 + (index % 5) }),
    );
    expect(recommendedSurveyCandidateIds(many)).toHaveLength(25);
    const webOnly = Array.from({ length: 3 }, (_, index) =>
      candidate(`C${String(index + 1).padStart(3, "0")}`, {
        origin: "web_search",
        doi: undefined,
        identity: { url: `https://x.example.org/${index}`, normalizedTitleFingerprint: `web-${index}` },
      }),
    );
    expect(recommendedSurveyCandidateIds(webOnly)).toHaveLength(3);
  });
});
