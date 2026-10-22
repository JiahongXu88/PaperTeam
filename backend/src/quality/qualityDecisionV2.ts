/**
 * M15.1：Quality Decision V2 的 schema 与影子结果（shadow only——生产 evaluateQualityGate 的规则、阈值与终态不读它）。
 *
 * 为什么要 V2（M15 校准实验，110/110 只读 run Gate FAIL）：现行 Gate 把四类不同性质的判断压成一个 passed——
 * 科学事实是否被确立、学术相对质量（academicScore≥80，未校准）、表达风格（styleRisk≤35，未校准）、核验是否执行。
 * V2 契约把它们拆成独立轴，并按场景（Decision Policy）给出不同含义；本轮只计算影子结果、落盘对照，M15.4 独立测评后才迁移。
 *
 * 纪律：
 *  - Style Quality 与 Scientific Readiness 解耦：孤立 style 风险不作为出版否决硬门（未经校准）；styleRisk 只作旧版对照；
 *    不得输出 AI 生成概率 / 作者身份推断 / 「知网 AIGC 率」等任何生成来源概率；
 *  - NOT_EVALUATED 不折算为 PASS：未执行的核验进入 verificationCompleteness，不进任何「通过」计数；
 *  - Revision Task Complete 与 Publication Ready 始终分离（revision_task 策略只描述，不改写 gate.revisionTask）。
 */

import type { QualityGateResult } from "./gates.js";
import type { ReviewSummary } from "../review/ReviewAggregator.js";
import type { summarizeClaimAudit } from "../review/claimAudit.js";
import type { summarizeCitationAudit } from "../citation/readOnlyCitationAudit.js";
import type { FindingAuditSummary } from "../review/findingAudit.js";

export const QUALITY_DECISION_V2_SCHEMA = "paperteam.quality-decision-v2/shadow-1";

export type DecisionPolicy = "quick_review" | "revision_task" | "autonomous_improvement";

/** Style V2 契约：可解释的写作问题清单 + 旧版风险分对照；永远 advisory，不是生成来源判断 */
export interface StyleQualityV2 {
  role: "ADVISORY_NOT_A_GATE";
  legacyStyleRisk: number | null;
  legacyThreshold: number;
  findings: { total: number; major: number; minor: number };
  /** 明确声明：不是 AI 检测 / 不是 AIGC 率 */
  provenanceJudgement: "NOT_PRODUCED";
  /** 润色授权：suggest_only 缺省；apply_once 只能由用户显式选择 */
  polishAuthorization: "suggest_only_default";
}

export interface QualityDecisionV2Shadow {
  schema: typeof QUALITY_DECISION_V2_SCHEMA;
  mode: "SHADOW_ONLY";
  policy: DecisionPolicy;
  round: number;
  reviewedRevision: number | null;
  productionGate: { passed: boolean; requiredNotEvaluated: string[]; failedRules: string[]; note: string };
  scientificIntegrity: {
    status: "VERIFIED_CONTRADICTION_PRESENT" | "NO_VERIFIED_CONTRADICTION_IN_AUDITED_CLAIMS" | "NOT_EVALUATED";
    verifiedContradicted: number;
    verifiedSupported: number;
    reviewerSuspected: number;
    pendingAuthorOrExternal: number;
    notEvaluatedClaims: number;
    note: string;
  };
  citationIntegrity: {
    structure: string;
    authenticity: string;
    note: string;
  };
  findingProvenance: {
    criticalMajor: number;
    textLocated: number;
    contextIncomplete: number;
    parseArtifactSuspected: number;
    other: number;
  } | null;
  academicQuality: { legacyScore: number | null; legacyThreshold: number; calibration: "UNVALIDATED"; role: "BASELINE_ONLY_UNTIL_M15_3" };
  styleQuality: StyleQualityV2;
  verificationCompleteness: { complete: boolean; missing: string[] };
  /** 场景解释（不是裁决） */
  policyReading: string;
}

export function computeQualityDecisionV2Shadow(input: {
  policy: DecisionPolicy;
  gate: QualityGateResult;
  review: ReviewSummary;
  claimAudit: ReturnType<typeof summarizeClaimAudit> | null;
  citationAudit: ReturnType<typeof summarizeCitationAudit> | null;
  findingAudit: FindingAuditSummary | null;
}): QualityDecisionV2Shadow {
  const { gate, review, claimAudit, citationAudit, findingAudit } = input;
  const requiredNotEvaluated = gate.rules.filter((rule) => rule.status === "NOT_EVALUATED" && rule.required === true).map((rule) => rule.rule);
  const claimValid = claimAudit !== null && claimAudit.validation !== "STALE" && claimAudit.validation !== "MALFORMED";
  const statusCounts = claimValid ? claimAudit!.claims.byStatus : null;
  const integrityStatus: QualityDecisionV2Shadow["scientificIntegrity"]["status"] = statusCounts === null || claimAudit!.claims.total === 0
    ? "NOT_EVALUATED"
    : statusCounts.VERIFIED_CONTRADICTED > 0
      ? "VERIFIED_CONTRADICTION_PRESENT"
      : "NO_VERIFIED_CONTRADICTION_IN_AUDITED_CLAIMS";
  const missing: string[] = [...requiredNotEvaluated.map((rule) => `production:${rule}`)];
  if (integrityStatus === "NOT_EVALUATED") missing.push("claim_audit");
  if (citationAudit === null || citationAudit.verdict.structure === "NOT_EVALUATED") missing.push("citation_structure");
  if (citationAudit === null || citationAudit.verdict.authenticity === "NOT_EVALUATED") missing.push("citation_authenticity");
  if (review.coverage !== undefined && !review.coverage.complete) missing.push("review_coverage");
  const styleIssues = review.issues.filter((issue) => issue.category === "style");
  const cm = findingAudit?.criticalMajor;
  return {
    schema: QUALITY_DECISION_V2_SCHEMA,
    mode: "SHADOW_ONLY",
    policy: input.policy,
    round: review.round,
    reviewedRevision: typeof review.reviewedRevision === "number" ? review.reviewedRevision : null,
    productionGate: {
      passed: gate.passed,
      requiredNotEvaluated,
      failedRules: gate.rules.filter((rule) => rule.status === "FAIL").map((rule) => rule.rule),
      note: "生产 Gate 原样执行；本影子结果不改变 passed / revisionTask / publicationReadiness",
    },
    scientificIntegrity: {
      status: integrityStatus,
      verifiedContradicted: statusCounts?.VERIFIED_CONTRADICTED ?? 0,
      verifiedSupported: statusCounts?.VERIFIED_SUPPORTED ?? 0,
      reviewerSuspected: statusCounts?.REVIEWER_SUSPECTED ?? 0,
      pendingAuthorOrExternal: (statusCounts?.AUTHOR_CHECK_REQUIRED ?? 0) + (statusCounts?.EXTERNAL_DATA_REQUIRED ?? 0),
      notEvaluatedClaims: statusCounts?.NOT_EVALUATED ?? 0,
      note: "只覆盖账本中逐字定位的论断；「无已核实矛盾」≠ 全部论断已核验（科学论断覆盖 NOT_MEASURABLE）",
    },
    citationIntegrity: {
      structure: citationAudit?.verdict.structure ?? "NOT_EVALUATED",
      authenticity: citationAudit?.verdict.authenticity ?? "NOT_EVALUATED",
      note: "只读引用审计四层（attempted / adequate / matched / external verified）分开报告；未做外部元数据核验时真实性 NOT_EVALUATED",
    },
    findingProvenance: cm === undefined
      ? null
      : {
          criticalMajor: cm.total,
          textLocated: cm.byStatus.TEXT_LOCATED,
          contextIncomplete: cm.byStatus.CONTEXT_INCOMPLETE,
          parseArtifactSuspected: cm.byStatus.PARSE_ARTIFACT_SUSPECTED,
          other: cm.byStatus.QUOTE_NOT_LOCATED + cm.byStatus.NO_QUOTE,
        },
    academicQuality: { legacyScore: review.scores.academicScore, legacyThreshold: gate.thresholds.academicPassScore, calibration: "UNVALIDATED", role: "BASELINE_ONLY_UNTIL_M15_3" },
    styleQuality: {
      role: "ADVISORY_NOT_A_GATE",
      legacyStyleRisk: review.scores.styleRisk,
      legacyThreshold: gate.thresholds.styleRiskMax,
      findings: { total: styleIssues.length, major: styleIssues.filter((issue) => issue.severity !== "minor").length, minor: styleIssues.filter((issue) => issue.severity === "minor").length },
      provenanceJudgement: "NOT_PRODUCED",
      polishAuthorization: "suggest_only_default",
    },
    verificationCompleteness: { complete: missing.length === 0, missing },
    policyReading: input.policy === "quick_review"
      ? "quick_review：只读模拟审稿建议；不执行 Writer / Patch / 作者 HITL；科学轴只认已核实证据，疑点列待核验"
      : input.policy === "revision_task"
        ? "revision_task：指定意见闭环与「未引入新错误」由生产 revisionTask 判定；整篇投稿准备度另行报告，额外问题不进返修计划"
        : "autonomous_improvement：可据已核实问题提出受控修改计划；缺真实实验时须作者决策，不造数据",
  };
}

export function decisionPolicyFor(workflowKind: string | undefined, publishedAssessment: boolean, externalInstructions: boolean): DecisionPolicy {
  if (publishedAssessment || workflowKind === "existing_paper_review") return "quick_review";
  if (externalInstructions) return "revision_task";
  return "autonomous_improvement";
}
