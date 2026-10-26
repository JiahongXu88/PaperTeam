/**
 * M15.7 Quality Policy V2 —— 未校准分数阈值（academicScore>=80 / styleRisk<=35）的政策适配层。
 *
 * 预登记：D:\PaperTeamData\M15\M15_7\PRE_REGISTERED_PROTOCOL.md（FROZEN 2026-10-26T15:45:04+08:00，
 * 正文 SHA256 93027ddf…49d606）。本模块是纯函数、确定性、零模型：不重写 evaluateQualityGate，
 * 不平行建立第二判定入口——生产接线（若 Shadow 门槛全绿）只发生在 evaluateProjectQualityGate 内
 * 对本函数的最小调用；Shadow 阶段仅由评测脚本消费。
 *
 * 三臂（协议 §3）：
 *   legacy_v1           输入 gate 原样返回（基线，逐字节不动）；
 *   score_style_advisory（Candidate A）把规则 7 academic_score_threshold / 规则 8 style_risk_threshold
 *                       的 Legacy FAIL 转为 ADVISORY（解释性呈现，不再单独否决）：
 *                         - 分数缺失（NOT_EVALUATED）保持 required 阻断——Advisory 取消的是阈值否决权，
 *                           不是评估存在性要求；
 *                         - 覆盖不完整由规则 8b review_coverage_complete（required）继续阻断；若历史产物
 *                           无 8b 可接力（覆盖驱动的 FAIL 失去唯一守卫），保守保留阻断（COVERAGE_GUARD_RETAINED）；
 *                         - 其余全部规则（科学硬门 / 必需核验 / 有证据 finding）逐条保持；
 *   policy_aware        （Candidate B）A + 场景最小分权：
 *                         - published_paper_assessment：评估完成语义（ASSESSMENT_*）与 Publication READY 分离，
 *                           不把「评估完成」映射为可发表；
 *                         - quick_review / existing_paper_review：阅读意见不是投稿 READY 凭证；
 *                         - existing-paper 返修：Task Success / Publication Readiness 维持 revisionTaskGate
 *                           既有分层，本层不改其语义。
 *
 * 单调性（协议 §3 判定矩阵 NO_CHANGE 行）：本层只能移除阻断原因、不能新增——任何 Legacy PASS
 * 在 Candidate 臂必须仍 PASS（MONOTONICITY_VIOLATION 为内部不变量硬错误信号）。
 */

import type { QualityGateResult, QualityGateRule, QualityGateRuleStatus } from "./gates.js";
import { summarizeGateVerification } from "./gates.js";

export const QUALITY_POLICY_VERSION = "policy-v2";

export type QualityPolicyArm = "legacy_v1" | "score_style_advisory" | "policy_aware";

/** 政策适配的目标规则（协议 §1：仅这两个未校准阈值规则；其余规则不在政策变量内） */
export const POLICY_RULE_IDS = ["academic_score_threshold", "style_risk_threshold"] as const;

/** 旧产物规则无 status 时的推导（与 summarizeGateVerification 同口径） */
const effectiveStatus = (rule: QualityGateRule): QualityGateRuleStatus =>
  rule.status ?? (rule.passed ? "PASS" : "FAIL");

export interface QualityPolicyScores {
  academicScore: number | null;
  styleRisk: number | null;
}

export interface QualityPolicyScenario {
  workflowKind?: string | null;
  reviewPurpose?: string | null;
}

export type QualityPolicyReasonCode =
  | "NO_CHANGE"
  | "SCORE_ONLY_UNBLOCK"
  | "STYLE_ONLY_UNBLOCK"
  | "SCORE_STYLE_UNBLOCK"
  | "REMAIN_BLOCKED"
  | "MONOTONICITY_VIOLATION";

/** 单条规则的臂间差分（含保守保留的守卫） */
export interface QualityPolicyRuleDiff {
  rule: string;
  from: { status: QualityGateRuleStatus; required: boolean; passed: boolean };
  to: { status: QualityGateRuleStatus; required: boolean; passed: boolean };
  /**
   * ADVISORY_CONVERTED        未校准阈值否决 → 解释性呈现；
   * COVERAGE_GUARD_RETAINED   覆盖驱动 FAIL 且无 8b 可接力 → 保守保留阻断；
   * MISSING_SCORE_RETAINED    评分缺失（Legacy 编码为 FAIL + 「缺少 … 评分」detail）→ 显式改写为
   *                           NOT_EVALUATED(required) 继续阻断——Advisory 取消的是阈值否决权，
   *                           不是评估存在性要求（协议 §3 Candidate A）。
   */
  action: "ADVISORY_CONVERTED" | "COVERAGE_GUARD_RETAINED" | "MISSING_SCORE_RETAINED";
  note: string;
}

export interface QualityPolicyOutcome {
  arm: QualityPolicyArm;
  policyVersion: string;
  legacyPassed: boolean;
  candidatePassed: boolean;
  reasonCode: QualityPolicyReasonCode;
  /** Candidate 臂仍阻断的规则（REMAIN_BLOCKED 时非空；Legacy PASS→Candidate FAIL 时为 MONOTONICITY_VIOLATION 证据） */
  remainingBlockers: string[];
  /** 本次被移除阻断的规则（advisory 化且原本为唯一/联合阻断源之一） */
  unblocked: string[];
}

export interface QualityPolicyAssessment {
  /** 只读评估完成语义（与 Publication READY 分离——quick review 不产出投稿就绪结论） */
  completion: "ASSESSMENT_INCOMPLETE" | "ASSESSMENT_COMPLETED_WITH_FINDINGS" | "ASSESSMENT_COMPLETED_CLEAR";
  /** 评估中呈现的 finding 规则（FAIL / ADVISORY 均如实列出，不冒充已证实科学违规） */
  findingRules: string[];
  requiredGaps: string[];
  submissionReadiness: "NOT_ASSESSED_QUICK_REVIEW";
}

export interface QualityPolicyResult {
  arm: QualityPolicyArm;
  policyVersion: string;
  /** 政策臂视角的 gate（legacy 臂 = 输入原对象；Candidate 臂 = 规则 7/8 转换后的重建）。checkedAt/evaluation 保持输入时点值 */
  gate: QualityGateResult;
  outcome: QualityPolicyOutcome;
  ruleDiffs: QualityPolicyRuleDiff[];
  /** 仅 policy_aware + published_paper_assessment 场景产出 */
  assessment?: QualityPolicyAssessment;
  /** 仅 policy_aware + quick_review 场景产出（existing_paper_review 工作流 / quick_review purpose） */
  quickReview?: { readiness: "NOT_A_SUBMISSION_CREDENTIAL"; note: string };
}

/** 规则 7 detail 中覆盖不完整信号的稳定子串（gates.ts:859 的文案前缀；改文案须同步此处测试） */
const COVERAGE_INCOMPLETE_SIGNALS = ["review coverage 不完整", "部分视图分数不得推导全文学术质量"];

/** Legacy 引擎把评分缺失编码为 FAIL + 固定 detail（gates.ts:848/:868）；改文案须同步此处测试 */
const MISSING_SCORE_DETAILS: Record<"academic_score_threshold" | "style_risk_threshold", string> = {
  academic_score_threshold: "缺少 academic 评分",
  style_risk_threshold: "缺少 style 风险评分",
};

const isCoverageIncompleteDetail = (detail: string): boolean =>
  COVERAGE_INCOMPLETE_SIGNALS.some((signal) => detail.includes(signal));

/** 规则 8b（或任何 coverage 守卫规则）是否仍在 Candidate 臂阻断 */
const coverageAlternateBlocker = (rules: readonly QualityGateRule[]): string | null => {
  for (const rule of rules) {
    if (rule.rule !== "review_coverage_complete") continue;
    const status = effectiveStatus(rule);
    if (status === "FAIL" || (status === "NOT_EVALUATED" && rule.required === true)) return rule.rule;
  }
  return null;
};

interface ScoreRuleContext {
  arm: QualityPolicyArm;
  thresholds: QualityGateResult["thresholds"];
  scores?: QualityPolicyScores;
}

const advisoryRule = (
  rule: QualityGateRule,
  score: number | null,
  threshold: number,
  direction: "at_least" | "at_most",
): QualityGateRule => ({
  ...rule,
  passed: true,
  status: "ADVISORY",
  required: false,
  detail: `ADVISORY（UNCALIBRATED）：${rule.detail}——未校准阈值不再单独否决（Legacy 判定 FAIL 保留为历史对照；分数照常计算与可见）`,
  advisory: {
    kind: "UNCALIBRATED_SCORE",
    legacyStatus: "FAIL",
    legacyRequired: rule.required === true,
    legacyDetail: rule.detail,
    score,
    threshold,
    direction,
    calibration: "UNVALIDATED",
    policyVersion: QUALITY_POLICY_VERSION,
  },
});

/** 评分缺失的显式保留：FAIL → NOT_EVALUATED(required)，继续阻断（协议 §3 Candidate A 存在性要求） */
const missingScoreRetained = (
  rule: QualityGateRule,
): { rule: QualityGateRule; diff: QualityPolicyRuleDiff } => {
  const retained: QualityGateRule = {
    ...rule,
    passed: false,
    status: "NOT_EVALUATED",
    required: true,
    detail: `NOT_EVALUATED（必需核验未完成）：${rule.detail}——评分缺失是必需核验缺口，Advisory 化取消的是阈值否决权，不是评估存在性要求`,
  };
  return {
    rule: retained,
    diff: {
      rule: rule.rule,
      from: { status: effectiveStatus(rule), required: rule.required === true, passed: rule.passed },
      to: { status: "NOT_EVALUATED", required: true, passed: false },
      action: "MISSING_SCORE_RETAINED",
      note: "评分缺失保持阻断（协议 §3：null 分数不因 advisory 放行）",
    },
  };
};

/** 规则 7 / 8 的政策转换。返回 null = 该规则不在政策变量内或无需转换（含 NOT_EVALUATED 保持阻断）。 */
const transformScoreStyleRule = (
  rule: QualityGateRule,
  allRules: readonly QualityGateRule[],
  context: ScoreRuleContext,
): { rule: QualityGateRule; diff: QualityPolicyRuleDiff } | null => {
  if (!(POLICY_RULE_IDS as readonly string[]).includes(rule.rule)) return null;
  const status = effectiveStatus(rule);
  if (status !== "FAIL") return null;

  // 评分缺失（Legacy 编码为 FAIL + 固定 detail；或调用方显式给出 null 分数）：
  // 显式改写为 NOT_EVALUATED(required) 继续阻断，不做 advisory 转换。
  const scoreForRule =
    rule.rule === "academic_score_threshold" ? context.scores?.academicScore : context.scores?.styleRisk;
  if (scoreForRule === null || rule.detail.trim() === MISSING_SCORE_DETAILS[rule.rule as keyof typeof MISSING_SCORE_DETAILS]) {
    return missingScoreRetained(rule);
  }

  if (rule.rule === "academic_score_threshold") {
    const threshold = context.thresholds.academicPassScore;
    const score = context.scores?.academicScore ?? null;
    const scoreKnownAtOrAbove = score !== null && score >= threshold;
    // 规则 7 的 FAIL 可能由覆盖不完整驱动（M14.1a P0-2：部分视图分数不得推导全文质量）。
    // Advisory 化的安全前提：覆盖守卫仍有独立阻断者（规则 8b）；否则保守保留阻断。
    const coverageDriven =
      scoreKnownAtOrAbove ||
      (context.scores?.academicScore === undefined && isCoverageIncompleteDetail(rule.detail));
    if (coverageDriven) {
      const alternate = coverageAlternateBlocker(allRules);
      if (alternate === null) {
        return {
          rule, // 原样保留（FAIL / required 阻断）
          diff: {
            rule: rule.rule,
            from: { status, required: rule.required === true, passed: rule.passed },
            to: { status, required: rule.required === true, passed: rule.passed },
            action: "COVERAGE_GUARD_RETAINED",
            note: "覆盖不完整驱动的 academic FAIL 且无 review_coverage_complete 可接力——保守保留阻断（不得借 Advisory 化绕开 M14.1a P0-2 覆盖守卫）",
          },
        };
      }
    }
    return {
      rule: advisoryRule(rule, score, threshold, "at_least"),
      diff: {
        rule: rule.rule,
        from: { status, required: rule.required === true, passed: rule.passed },
        to: { status: "ADVISORY", required: false, passed: true },
        action: "ADVISORY_CONVERTED",
        note: "academicScore 阈值未校准（UNVALIDATED）——转解释性呈现；覆盖守卫（若适用）由 review_coverage_complete(required) 继续",
      },
    };
  }

  // style_risk_threshold：无覆盖耦合，FAIL → ADVISORY
  const threshold = context.thresholds.styleRiskMax;
  const score = context.scores?.styleRisk ?? null;
  return {
    rule: advisoryRule(rule, score, threshold, "at_most"),
    diff: {
      rule: rule.rule,
      from: { status, required: rule.required === true, passed: rule.passed },
      to: { status: "ADVISORY", required: false, passed: true },
      action: "ADVISORY_CONVERTED",
      note: "styleRisk 阈值未校准（UNVALIDATED）——转解释性呈现；风格观察不构成科学否决",
    },
  };
};

/** 与 evaluateQualityGate 尾部完全同口径的重算（gates.ts:1228-1235） */
const recomputeGateFromRules = (gate: QualityGateResult, rules: QualityGateRule[]): QualityGateResult => {
  const reasons = rules.filter((rule) => !rule.passed).map((rule) => `${rule.rule}: ${rule.detail}`);
  return {
    ...gate,
    rules,
    reasons,
    passed: reasons.length === 0,
    verification: summarizeGateVerification(rules),
  };
};

export function applyQualityPolicy(input: {
  gate: QualityGateResult;
  arm: QualityPolicyArm;
  /** 可选机读分数（生产接线 / 回放 harness 从 ReviewSummary 提供；缺省按规则状态与 detail 推断，推断不出的保守保留） */
  scores?: QualityPolicyScores;
  scenario?: QualityPolicyScenario;
}): QualityPolicyResult {
  const { gate, arm } = input;
  const legacyPassed = gate.passed === true;

  if (arm === "legacy_v1") {
    return {
      arm,
      policyVersion: QUALITY_POLICY_VERSION,
      gate,
      outcome: {
        arm,
        policyVersion: QUALITY_POLICY_VERSION,
        legacyPassed,
        candidatePassed: legacyPassed,
        reasonCode: "NO_CHANGE",
        remainingBlockers: gate.rules.filter((rule) => !rule.passed).map((rule) => rule.rule),
        unblocked: [],
      },
      ruleDiffs: [],
    };
  }

  const context: ScoreRuleContext = { arm, thresholds: gate.thresholds, scores: input.scores };
  const ruleDiffs: QualityPolicyRuleDiff[] = [];
  const transformed: QualityGateRule[] = gate.rules.map((rule) => {
    const result = transformScoreStyleRule(rule, gate.rules, context);
    if (result === null) return rule;
    ruleDiffs.push(result.diff);
    return result.rule;
  });

  const candidateGate = recomputeGateFromRules(gate, transformed);
  const candidatePassed = candidateGate.passed;

  const unblocked = ruleDiffs.filter((diff) => diff.action === "ADVISORY_CONVERTED").map((diff) => diff.rule);
  const remainingBlockers = candidateGate.rules.filter((rule) => !rule.passed).map((rule) => rule.rule);

  let reasonCode: QualityPolicyReasonCode;
  if (legacyPassed && !candidatePassed) {
    reasonCode = "MONOTONICITY_VIOLATION";
  } else if (legacyPassed && candidatePassed) {
    reasonCode = "NO_CHANGE";
  } else if (candidatePassed) {
    const scoreUnblocked = unblocked.includes("academic_score_threshold");
    const styleUnblocked = unblocked.includes("style_risk_threshold");
    reasonCode =
      scoreUnblocked && styleUnblocked
        ? "SCORE_STYLE_UNBLOCK"
        : scoreUnblocked
          ? "SCORE_ONLY_UNBLOCK"
          : styleUnblocked
            ? "STYLE_ONLY_UNBLOCK"
            : "NO_CHANGE";
  } else {
    reasonCode = remainingBlockers.length > 0 ? "REMAIN_BLOCKED" : "NO_CHANGE";
  }

  const result: QualityPolicyResult = {
    arm,
    policyVersion: QUALITY_POLICY_VERSION,
    gate: { ...candidateGate, evaluation: gate.evaluation },
    outcome: {
      arm,
      policyVersion: QUALITY_POLICY_VERSION,
      legacyPassed,
      candidatePassed,
      reasonCode,
      remainingBlockers,
      unblocked,
    },
    ruleDiffs,
  };

  if (arm === "policy_aware") {
    const purpose =
      input.scenario?.reviewPurpose ?? gate.evaluation?.reviewPurpose ?? "author_manuscript";
    const workflowKind = input.scenario?.workflowKind ?? gate.evaluation?.workflowKind ?? null;
    if (purpose === "published_paper_assessment") {
      const findingRules = candidateGate.rules
        .filter((rule) => effectiveStatus(rule) === "FAIL" || effectiveStatus(rule) === "ADVISORY")
        .map((rule) => rule.rule);
      const requiredGaps = (candidateGate.verification?.notEvaluated ?? [])
        .filter((entry) => entry.required)
        .map((entry) => entry.rule);
      result.assessment = {
        completion:
          requiredGaps.length > 0
            ? "ASSESSMENT_INCOMPLETE"
            : candidateGate.rules.some((rule) => effectiveStatus(rule) === "FAIL")
              ? "ASSESSMENT_COMPLETED_WITH_FINDINGS"
              : "ASSESSMENT_COMPLETED_CLEAR",
        findingRules,
        requiredGaps,
        submissionReadiness: "NOT_ASSESSED_QUICK_REVIEW",
      };
    }
    if (workflowKind === "existing_paper_review" || purpose === "quick_review") {
      result.quickReview = {
        readiness: "NOT_A_SUBMISSION_CREDENTIAL",
        note: "快速 Review 是阅读意见呈现，不是作者稿件投稿 READY 的凭证（协议 §3 Candidate B）",
      };
    }
  }

  return result;
}
