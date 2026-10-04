/**
 * M11.3（Phase D/E）digest 安全截断 + 产品终态语义测试。
 *
 * - sliceForDigest：绝不切在 \cite{…} 内部（MOT 实录回归：2500 字符硬切落在
 *   \cite{ng 中间 → reviewer 伪影 critical 连续三轮烧修订）；句界回退；显式
 *   截断系统注；预算内零改动；
 * - classifyTerminalStatus：五类终态的确定性判定（§25–§28 语义）；
 * - planSharedTail completion：qualityStatus / qualityStatusMessage 进 summary。
 */

import { describe, expect, it } from "vitest";

import { createTopicSurveyDefinition, sliceForDigest } from "../../src/workflow/definitions.js";
import { classifyTerminalStatus } from "../../src/review/revisionOutcome.js";
import type { WorkflowServices } from "../../src/workflow/definitions.js";
import type { WorkflowState } from "../../src/workflow/types.js";

/** MOT r9–r11 伪影现场：预算点恰好落在 \cite{ng2023traffic 中间 */
const MOT_TRUNCATION_CASE =
  "前文段落。".repeat(400) +
  "不用 ReID 即可全面超过 ReID 跟踪器\\cite{you2024multi}，带 ReID 的 StrongSORT 不适合实时\\cite{ng2023traffic}。BoostTrack 的消融则属混合证据。其三、IoU 失效的应对。其四、端到端身份嵌入。其五、RFS 精确性取舍。";

describe("sliceForDigest（digest 安全截断）", () => {
  it("预算点落在 \\cite 命令内部 → 回退到命令边界，绝不产生悬空 cite", () => {
    const sliced = sliceForDigest(MOT_TRUNCATION_CASE, 2035);
    // 不得出现未闭合 cite（切点在 {you2024multi} 与 {ng2023traffic} 之间的场景）
    const unclosed = /\\cite[a-zA-Z]*\*?(?:\[[^\]]*\])*\{[^}\n]*$/.test(sliced.split("【系统注")[0]!);
    expect(unclosed).toBe(false);
    expect(sliced).toContain("【系统注");
  });

  it("截断带显式系统注（reviewer 不得把视图截断当稿件缺陷）", () => {
    const sliced = sliceForDigest("句子。".repeat(2000), 500);
    expect(sliced.endsWith("截断处不构成稿件缺陷，不要据此报 build/结构问题】")).toBe(true);
  });

  it("预算内零改动（无截断注）", () => {
    const short = "短节内容~\\cite{key}。";
    expect(sliceForDigest(short, 100)).toBe(short);
  });

  it("句界回退：截断落在最后一个句号之后", () => {
    const content = "第一句。第二句。第三句还没有结束也没有标点" + "字".repeat(300);
    const sliced = sliceForDigest(content, 20);
    expect(sliced.startsWith("第一句。")).toBe(true);
    expect(sliced).toContain("【系统注");
  });
});

describe("classifyTerminalStatus（产品终态语义，§25–§28）", () => {
  it("gate 通过 → PASS", () => {
    expect(classifyTerminalStatus({ gatePassed: true, gateReasons: [], convergence: null }).status).toBe("PASS");
  });

  it("守卫类规则失败 → SYSTEM_FAILED（不是质量问题）", () => {
    const result = classifyTerminalStatus({
      gatePassed: false,
      gateReasons: ["fact_preservation: 存在未授权事实改写", "academic_score_threshold: 72 < 80"],
      convergence: null,
    });
    expect(result.status).toBe("SYSTEM_FAILED");
  });

  it("STALLED + author_decision claim > 0 → AUTHOR_DECISION_REQUIRED", () => {
    const result = classifyTerminalStatus({
      gatePassed: false,
      gateReasons: ["academic_score_threshold: 72 < 80"],
      convergence: "STALLED",
      authorDecisionClaims: 2,
    });
    expect(result.status).toBe("AUTHOR_DECISION_REQUIRED");
    expect(result.message).toContain("作者");
  });

  it("STALLED 无 author claim → NO_PROGRESS（不是 System Error）", () => {
    const result = classifyTerminalStatus({
      gatePassed: false,
      gateReasons: ["academic_score_threshold: 72 < 80"],
      convergence: "STALLED",
    });
    expect(result.status).toBe("NO_PROGRESS");
    expect(result.message).toContain("收敛上限");
  });

  it("普通质量缺口（非守卫、非 STALLED）→ QUALITY_NOT_REACHED", () => {
    const result = classifyTerminalStatus({
      gatePassed: false,
      gateReasons: ["academic_score_threshold: 74 < 80", "style_risk_threshold: 50 > 35"],
      convergence: "PROGRESS",
    });
    expect(result.status).toBe("QUALITY_NOT_REACHED");
    expect(result.message).toContain("论文已生成");
  });

  it("survey 契约守卫同样归 SYSTEM_FAILED", () => {
    const result = classifyTerminalStatus({
      gatePassed: false,
      gateReasons: ["survey_citation_keys_valid: 2 个 key 不在白名单"],
      convergence: null,
    });
    expect(result.status).toBe("SYSTEM_FAILED");
  });
});

describe("planSharedTail completion（qualityStatus 进 summary）", () => {
  const services = { review: { maxRevisionRounds: 5 } } as unknown as WorkflowServices;
  const definition = createTopicSurveyDefinition(services);

  function tailState(gateResult: Record<string, unknown>): WorkflowState {
    const results: Record<string, Record<string, unknown>> = {};
    for (const stageId of [
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
      "writing.sections",
    ]) {
      results[stageId] = {};
    }
    results["citation.verify"] = {};
    results["review.run"] = { round: 9 };
    results["quality.gate"] = { passed: false, round: 9, reasons: ["academic_score_threshold: 74 < 80"], outcome: "IMPROVED", ...gateResult };
    results["hitl.revision_stalled"] = { decision: "accept_draft", gateRound: 9 };
    results["build.draft"] = { buildOk: true, draftArtifactId: "art-draft" };
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
      })),
      inputs: {},
      counters: {},
      eventsSeq: 0,
    };
  }

  it("overflow accept_draft → completion(draft) 携带 QUALITY_NOT_REACHED + 用户可读 message", () => {
    const plan = definition.plan(tailState({ convergence: "PROGRESS" }), services);
    expect(plan.kind).toBe("complete");
    if (plan.kind !== "complete") {
      return;
    }
    expect(plan.label).toBe("draft");
    expect(plan.summary["qualityStatus"]).toBe("QUALITY_NOT_REACHED");
    expect(String(plan.summary["qualityStatusMessage"])).toContain("论文已生成");
  });

  it("STALLED + authorDecisionClaims → AUTHOR_DECISION_REQUIRED", () => {
    const plan = definition.plan(
      tailState({ convergence: "STALLED", authorDecisionClaims: 1 }),
      services,
    );
    expect(plan.kind).toBe("complete");
    if (plan.kind !== "complete") {
      return;
    }
    expect(plan.summary["qualityStatus"]).toBe("AUTHOR_DECISION_REQUIRED");
  });
});
