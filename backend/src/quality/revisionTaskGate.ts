/**
 * Revision Task Gate（M11.4 Quality Gate Product Closure，2026-10-07）。
 *
 * 产品语义：Existing Paper Revision 的结果分两层，不再用单一
 * `gate.passed`（≈ publication-grade 全稿验收）掩盖两种不同的成功：
 *
 * 1. Revision Task Success（任务语义：**本轮返修是否正确完成**）
 *    - 全部外审意见闭环（handled / already_satisfied / 真实 Author Decision；
 *      假关闭会被 revision.plan 的 gate 复核降级，见 externalInstructions）
 *    - 确定性守卫全过（Fact / Citation / Evidence / Scope / Build / Patch）
 *    - 修订引入（revision-introduced）违规 = 0
 *    - 修订引入 / 修改区间的 blocking / critical finding = 0
 *    - 学术分相对冻结基线无实质回退（容差吸收评审方差）
 *    - 学术分 ≥ 校准 floor（floor 未校准时呈现不阻断，绝不伪装已校准）
 * 2. Publication Ready（全稿语义：**整篇是否适合作最终投稿候选**）
 *    - Revision Task Success 之上的更严层：whole-paper 质量阈值（含
 *      academicScore 绝对线、style、全稿 findings）+ 基线继承风险已裁决。
 *    - 可以 FAIL 即使任务层 PASS——原稿自带的作者级缺陷（论文表格与公平
 *      消融数据的矛盾等）不因返修任务被单方解决（§14 BASELINE_INHERITED_RISK）。
 *
 * 判定确定性（无 LLM）：全部输入来自既有 gate 规则、claimGapAudit、
 * externalInstructions 状态机与 patch 记录；本模块只做归层与组合。
 *
 * 兼容：非 existing-paper 工作流不经过本层（idea_to_paper / topic_survey
 * 维持原 gate 语义）；旧 run 产物无 revisionTask / publicationReadiness
 * 字段 → 读取方按 legacy（gate.passed 单层）解释。
 */

import type { ClaimGapAudit } from "../review/claimGapAudit.js";
import type { ReviewIssue } from "../agents/ReviewerService.js";
import type { ExternalInstructionStatus } from "../review/externalInstructions.js";
import { findingFingerprint } from "../review/revisionPlan.js";
import { normalizeNumericToken } from "./factPreservation.js";

/** finding 描述中的数值 token（归一化；F23 lineage 用）。词边界守卫：跳过
 * 标识符内嵌数字（BDD100K / E001 / mAP50 中的数字不是数值语义）。 */
function findingNumberTokens(text: string): string[] {
  return [
    ...new Set(
      [...text.matchAll(/(?<![A-Za-z0-9_.])[-−]?\d+(?:\.\d+)?(?![A-Za-z0-9_])/g)]
        .map((m) => normalizeNumericToken(m[0] ?? ""))
        .filter((t) => t !== ""),
    ),
  ];
}

/** 任务层判定（gate.passed 不再是唯一终态） */
export type RevisionTaskVerdict = "PASS" | "FAIL" | "AUTHOR_DECISION_REQUIRED";
/** 投稿就绪层判定（READY 仍由全稿规则 + 任务成功共同决定） */
export type PublicationVerdict = "READY" | "NOT_READY" | "AUTHOR_DECISION_REQUIRED";

/**
 * Option C 策略配置（集中、typed、documented——不散落 magic number）。
 * - mode：task_scoped = 本模块的分层语义；legacy = 关闭分层（回退旧行为，
 *   供回滚与 A/B 对照）。
 * - academicFloor：任务层绝对下限。null = 未校准不启用（诚实缺省）；
 *   provisional = 有 benchmark 佐证但真实 revision family 不足（N=1），
 *   默认仍不启用，由作者显式开启。
 * - regressionTolerance：非回归容差（分）。吸收单样本评审方差（benchmark
 *   实测同锚点 sd 5-12），机械的 candidate ≥ baseline 会被噪声支配。
 */
export interface RevisionTaskPolicy {
  mode: "task_scoped" | "legacy";
  academicFloor: number | null;
  academicFloorStatus: "calibrated" | "provisional" | "unavailable";
  regressionTolerance: number;
}

export const DEFAULT_REVISION_TASK_POLICY: RevisionTaskPolicy = {
  mode: "task_scoped",
  academicFloor: null,
  academicFloorStatus: "unavailable",
  regressionTolerance: 10,
};

/** 任务层消费的确定性守卫规则（gate 规则 id 前缀；全部必须 PASS） */
const TASK_GUARD_RULE_IDS = new Set([
  "hallucinated_citations_zero",
  "citation_structure_valid",
  "no_contradictory_evidence",
  "citation_keys_preserved",
  "citation_preservation_not_applicable",
  "fact_preservation",
  "fact_preservation_not_applicable",
  "cumulative_fact_preservation",
  "cumulative_fact_preservation_not_applicable",
  "citations_evidence_backed",
  "revision_items_resolved",
  "claim_strength_guard",
]);

/** finding / claim 的来源归层（§16：不能继续把 origin 模糊混在一起） */
export type FindingOrigin =
  | "revision_introduced"
  | "baseline_inherited"
  | "modified_existing"
  | "unknown_origin";

export interface FindingOriginEntry {
  fingerprint: string;
  section: string;
  severity: string;
  blocking: boolean;
  origin: FindingOrigin;
  /** 归层依据（机器可读，进产物与报告） */
  basis: string;
  description: string;
}

export interface ExternalInstructionSnapshot {
  instructionId: string;
  status: ExternalInstructionStatus;
  /** conflict / author-decision 的确定性标记（状态机或 statusNote 前缀） */
  authorDecision: boolean;
}

export interface RevisionTaskGateInput {
  /** evaluateQualityGate 的同轮规则结果（任务层消费守卫子集） */
  gateRules: readonly { rule: string; passed: boolean; detail: string }[];
  externalInstructions: readonly ExternalInstructionSnapshot[];
  claimGapAudit: ClaimGapAudit | null;
  /** 已归层的 heavy finding（critical / major / blocking） */
  findingOrigins: readonly FindingOriginEntry[];
  /**
   * patch 产物实质（patches 全过 + 无未归因违规 + 事实/引用保持 + 无 build
   * error；gate 级联前捕获）。null = 本轮无 patch 产物（无 Writer 派发）——
   * 检查不适用（如实记录，不判失败；守卫由 fact/citation 规则承担）。
   */
  patchSubstanceOk: boolean | null;
  academicScore: number | null;
  /** 同 run 冻结基线（r1）的学术分；null = 不可比（无基线评审） */
  baselineAcademicScore: number | null;
  policy: RevisionTaskPolicy;
}

export interface BaselineInheritedRisk {
  description: string;
  origin: FindingOrigin | "grey_zone_claim" | "author_decision_instruction";
  /** 与本轮外审意见直接相关（相关意见未闭环或要求过该区域） */
  reviewerRequired: boolean;
}

export interface RevisionTaskGateResult {
  verdict: RevisionTaskVerdict;
  success: boolean;
  checks: { check: string; passed: boolean; detail: string }[];
  reasons: string[];
  /** author-decision 项计数（意见 / claim 灰区 / unknown-origin finding） */
  authorDecisions: {
    instructions: number;
    greyZoneClaims: number;
    unknownOriginFindings: number;
  };
  publication: {
    verdict: PublicationVerdict;
    reasons: string[];
    risks: BaselineInheritedRisk[];
  };
}

/** instruction 状态 → 任务层闭环语义 */
function instructionClosure(status: ExternalInstructionStatus, authorDecision: boolean): "closed" | "author_decision" | "open" {
  if (status === "handled" || status === "already_satisfied") {
    return "closed";
  }
  if (status === "conflict" || authorDecision) {
    return "author_decision";
  }
  return "open";
}

/**
 * 任务层 + 投稿层判定（纯函数）。publication 层复用调用方的完整 gate 规则
 * 结果（全稿口径），任务层只消费守卫子集 + 归层后的违规/意见状态。
 */
export function evaluateRevisionTaskGate(input: RevisionTaskGateInput): RevisionTaskGateResult {
  if (input.policy.mode === "legacy") {
    // 显式回滚档：分层关闭，verdict 恒等于旧语义（gate.passed 单层）
    return {
      verdict: "FAIL",
      success: false,
      checks: [{ check: "policy_mode", passed: false, detail: "legacy 模式：分层语义关闭（回退 gate.passed 单层判定）" }],
      reasons: ["policy_mode: legacy"],
      authorDecisions: { instructions: 0, greyZoneClaims: 0, unknownOriginFindings: 0 },
      publication: { verdict: "NOT_READY", reasons: ["legacy 模式：不产出分层判定"], risks: [] },
    };
  }

  const checks: { check: string; passed: boolean; detail: string }[] = [];
  const authorReasons: string[] = [];

  // 1. 外审意见闭环（假关闭由 revision.plan 的 gate 复核降级兜底）
  const closed = input.externalInstructions.filter((i) => instructionClosure(i.status, i.authorDecision) === "closed");
  const authorDecisionInstructions = input.externalInstructions.filter(
    (i) => instructionClosure(i.status, i.authorDecision) === "author_decision",
  );
  const openInstructions = input.externalInstructions.filter(
    (i) => instructionClosure(i.status, i.authorDecision) === "open",
  );
  checks.push({
    check: "reviewer_requirements_closed",
    passed: openInstructions.length === 0,
    detail:
      `外审意见闭环 ${closed.length}/${input.externalInstructions.length}` +
      (authorDecisionInstructions.length > 0 ? `；${authorDecisionInstructions.length} 条待作者裁决` : "") +
      (openInstructions.length > 0 ? `；${openInstructions.length} 条未闭环（pending/unresolved/partially_handled）` : ""),
  });
  if (authorDecisionInstructions.length > 0) {
    authorReasons.push(`reviewer_requirements: ${authorDecisionInstructions.length} 条意见需要作者裁决（conflict / author_decision）`);
  }

  // 2. 确定性守卫（Fact / Citation / Evidence / Scope / Build 子集）
  const guardRules = input.gateRules.filter((rule) => TASK_GUARD_RULE_IDS.has(rule.rule));
  const failedGuards = guardRules.filter((rule) => !rule.passed);
  checks.push({
    check: "deterministic_guards",
    passed: failedGuards.length === 0,
    detail:
      failedGuards.length === 0
        ? `确定性守卫 ${guardRules.length} 项全过（fact / citation / evidence / scope / build）`
        : `守卫失败 ${failedGuards.length} 项：${failedGuards.map((rule) => rule.rule).join("、")}`,
  });

  // 2b. patch 产物实质（Scope Guard 的 per-patch 面：proposal-only / span 限定 /
  //     逐 patch 事实与引用核验；gate 级联前的捕获值，不含 gate.passed）
  checks.push({
    check: "patch_substance",
    passed: input.patchSubstanceOk !== false,
    detail:
      input.patchSubstanceOk === null
        ? "本轮无 patch 产物（无 Writer 派发 / 基线轮）——patch 实质检查不适用"
        : input.patchSubstanceOk
          ? "patches 全部通过、无未归因违规、事实/引用保持通过、无 build error"
          : "patch 实质未通过（存在失败 patch / 未归因违规 / 事实或引用保持失败 / build error）",
  });

  // 3. 修订引入 claim = 0（灰区 claim → 作者裁决，不计失败也不静默）
  const revisionIntroduced = input.claimGapAudit?.counts.revisionIntroduced ?? null;
  const greyZoneClaims = input.claimGapAudit?.counts.greyZone ?? 0;
  checks.push({
    check: "revision_introduced_claims_zero",
    passed: revisionIntroduced === null || revisionIntroduced === 0,
    detail:
      revisionIntroduced === null
        ? "无 claimGapAudit 产物（非 existing-paper 或旧轮）——按不可判处理"
        : `修订引入 UNSUPPORTED/CONTRADICTED claim ${revisionIntroduced} 条` +
          (greyZoneClaims > 0 ? `；灰区（转述覆盖 0.4–0.6）${greyZoneClaims} 条转作者裁决` : ""),
  });
  if (greyZoneClaims > 0) {
    authorReasons.push(`claims: ${greyZoneClaims} 条灰区 claim（基线转述覆盖 0.4–0.6）需要作者裁决`);
  }

  // 4. 修订引入 / 修改区间的 blocking / critical finding = 0
  const taskFindings = input.findingOrigins.filter(
    (entry) =>
      (entry.blocking || entry.severity === "critical") &&
      (entry.origin === "revision_introduced" || entry.origin === "modified_existing"),
  );
  const unknownOriginHeavy = input.findingOrigins.filter(
    (entry) => (entry.blocking || entry.severity === "critical") && entry.origin === "unknown_origin",
  );
  checks.push({
    check: "no_revision_blocking_findings",
    passed: taskFindings.length === 0,
    detail:
      taskFindings.length === 0
        ? "修订引入 / 修改区间无 blocking / critical finding" +
          (unknownOriginHeavy.length > 0 ? `（另有 unknown-origin ${unknownOriginHeavy.length} 条转作者裁决）` : "")
        : `修订引入 / 修改区间 blocking / critical finding ${taskFindings.length} 条：${taskFindings.slice(0, 3).map((entry) => entry.description.slice(0, 60)).join("；")}`,
  });
  if (unknownOriginHeavy.length > 0) {
    authorReasons.push(`findings: ${unknownOriginHeavy.length} 条 unknown-origin blocking / critical finding 需要作者裁决`);
  }

  // 5. 学术分相对冻结基线无实质回退（容差吸收单样本评审方差）
  const tolerance = input.policy.regressionTolerance;
  const nonRegressionApplicable =
    input.academicScore !== null && input.baselineAcademicScore !== null;
  const regressed = nonRegressionApplicable
    ? input.academicScore! < input.baselineAcademicScore! - tolerance
    : false;
  checks.push({
    check: "academic_non_regression",
    passed: !regressed,
    detail: !nonRegressionApplicable
      ? "无冻结基线评审分可比（基线轮缺失 / 分数缺失）——非回归检查不适用（如实记录，不判失败）"
      : `academicScore=${input.academicScore} vs 基线 ${input.baselineAcademicScore}（容差 ${tolerance}；回退判定线 ${input.baselineAcademicScore! - tolerance}）`,
  });

  // 6. 校准 floor（未校准 → 呈现不阻断；绝不把拟合值伪装成已校准）
  const floorEnforced = input.policy.academicFloor !== null;
  const floorOk = !floorEnforced || (input.academicScore !== null && input.academicScore >= input.policy.academicFloor!);
  checks.push({
    check: "academic_floor",
    passed: floorOk,
    detail: !floorEnforced
      ? `floor 未启用（${input.policy.academicFloorStatus}）——任务层绝对下限由 benchmark 校准后开启`
      : `academicScore=${input.academicScore}（floor ${input.policy.academicFloor}，${input.policy.academicFloorStatus}）`,
  });

  const hardFailures = checks.filter((check) => !check.passed);
  const verdict: RevisionTaskVerdict =
    hardFailures.length > 0 ? "FAIL" : authorReasons.length > 0 ? "AUTHOR_DECISION_REQUIRED" : "PASS";
  const reasons = [...hardFailures.map((check) => `${check.check}: ${check.detail}`), ...authorReasons];

  // ---- 投稿就绪层（更严：全稿规则 + 任务成功 + 继承风险裁决） ----
  // 调用方在得到本结果后以「全稿 gate 规则 && task success」合成 publicationReady；
  // 这里先给出风险清单与作者裁决口径。
  const risks: BaselineInheritedRisk[] = [];
  for (const entry of input.findingOrigins) {
    if (
      (entry.blocking || entry.severity === "critical" || entry.severity === "major") &&
      (entry.origin === "baseline_inherited" || entry.origin === "unknown_origin")
    ) {
      risks.push({
        description: entry.description,
        origin: entry.origin,
        reviewerRequired: false,
      });
    }
  }
  for (const claim of input.claimGapAudit?.claims ?? []) {
    if (claim.applicability === "grey_zone_author_decision") {
      risks.push({
        description: `灰区 claim（${claim.claim.slice(0, 80)}）`,
        origin: "grey_zone_claim",
        reviewerRequired: false,
      });
    }
  }
  for (const instruction of authorDecisionInstructions) {
    risks.push({
      description: `外审意见待作者裁决（${instruction.instructionId}）`,
      origin: "author_decision_instruction",
      reviewerRequired: true,
    });
  }
  const publicationVerdict: PublicationVerdict =
    verdict === "FAIL" ? "NOT_READY" : verdict === "AUTHOR_DECISION_REQUIRED" ? "AUTHOR_DECISION_REQUIRED" : "READY";

  return {
    verdict,
    success: verdict === "PASS",
    checks,
    reasons,
    authorDecisions: {
      instructions: authorDecisionInstructions.length,
      greyZoneClaims,
      unknownOriginFindings: unknownOriginHeavy.length,
    },
    publication: {
      verdict: publicationVerdict,
      reasons:
        verdict === "PASS"
          ? []
          : verdict === "AUTHOR_DECISION_REQUIRED"
            ? authorReasons
            : hardFailures.map((check) => `${check.check}: ${check.detail}`),
      risks,
    },
  };
}

/**
 * finding 来源归层（§16，确定性）：
 * 1. rootCauseKey / issueAttribution → claimGapAudit 的 claim 适用性；
 * 2. 【M11.4 F23】数值字节级 lineage：finding 引用 ≥2 个数值且全部位于与
 *    冻结基线逐字一致的表格（未被修订修改）→ baseline_inherited（无论章节
 *    是否在修改区间——修改区间的启发式会被"改了同节文字但没动表"的场景
 *    误伤：Run P/Q/R 实证，审稿人对基线表格的三种措辞变体）；
 * 3. finding 章节不在本轮修订修改区间 → baseline_inherited；
 * 4. finding 章节在修改区间 → modified_existing（claim 归层已豁免者除外）；
 * 5. 无章节信息 → unknown_origin（转作者裁决，不二值判罚）。
 */
export function classifyFindingOrigins(
  issues: readonly ReviewIssue[],
  claimGapAudit: ClaimGapAudit | null,
  modifiedSections: readonly string[],
  options: { unchangedTableNumbers?: ReadonlySet<string> } = {},
): FindingOriginEntry[] {
  const claimsById = new Map((claimGapAudit?.claims ?? []).map((claim) => [claim.claimId, claim]));
  const excludedFingerprints = new Set(
    (claimGapAudit?.issueAttribution ?? []).filter((entry) => entry.excluded).map((entry) => entry.fingerprint),
  );
  const modified = modifiedSections.map((name) => name.replace(/\s+/g, "").toLowerCase()).filter((name) => name !== "");
  const sectionModified = (section: string): boolean | null => {
    const normalized = section.replace(/\s+/g, "").toLowerCase();
    if (normalized === "" || normalized === "(unknown)" || normalized === "(global)") {
      return null;
    }
    return modified.some((name) => name === normalized || name.includes(normalized) || normalized.includes(name));
  };

  const entries: FindingOriginEntry[] = [];
  for (const issue of issues) {
    const heavy = issue.severity === "critical" || issue.severity === "major" || issue.blocking;
    if (!heavy) {
      continue;
    }
    const fingerprint = findingFingerprint(issue);
    let origin: FindingOrigin;
    let basis: string;
    const claim = issue.rootCauseKey !== undefined ? claimsById.get(issue.rootCauseKey) : undefined;
    if (claim !== undefined) {
      origin =
        claim.applicability === "revision_introduced"
          ? "revision_introduced"
          : claim.applicability === "grey_zone_author_decision"
            ? "unknown_origin"
            : "baseline_inherited";
      basis = `rootCauseKey → claimGapAudit ${claim.applicability}`;
    } else if (excludedFingerprints.has(fingerprint)) {
      origin = "baseline_inherited";
      basis = "claimGapAudit issueAttribution excluded（原稿既有 / 作者数据覆盖 claim 的伴随 finding）";
    } else if (options.unchangedTableNumbers !== undefined) {
      // F23：数值字节级 lineage（先于章节启发式——字节证据强于章节名匹配）
      const numbers = findingNumberTokens(issue.description);
      if (numbers.length >= 2 && numbers.every((token) => options.unchangedTableNumbers!.has(token))) {
        origin = "baseline_inherited";
        basis = `finding 引用的 ${numbers.length} 个数值全部位于与冻结基线逐字一致的表格（未被修订修改）——基线遗留问题，非修订引入`;
        entries.push({ fingerprint, section: issue.section, severity: issue.severity, blocking: issue.blocking, origin, basis, description: issue.description });
        continue;
      }
      const inModified = sectionModified(issue.section);
      if (inModified === null) {
        origin = "unknown_origin";
        basis = "finding 无章节归属，无法与修订区间比对（转作者裁决）";
      } else if (inModified) {
        origin = "modified_existing";
        basis = "finding 位于本轮修订修改区间（修改区间的问题由修订负责）";
      } else {
        origin = "baseline_inherited";
        basis = "finding 章节未被本轮修订修改——基线既有问题（投稿层风险，不阻塞任务层）";
      }
    } else {
      const inModified = sectionModified(issue.section);
      if (inModified === null) {
        origin = "unknown_origin";
        basis = "finding 无章节归属，无法与修订区间比对（转作者裁决）";
      } else if (inModified) {
        origin = "modified_existing";
        basis = "finding 位于本轮修订修改区间（修改区间的问题由修订负责）";
      } else {
        origin = "baseline_inherited";
        basis = "finding 章节未被本轮修订修改——基线既有问题（投稿层风险，不阻塞任务层）";
      }
    }
    entries.push({
      fingerprint,
      section: issue.section,
      severity: issue.severity,
      blocking: issue.blocking,
      origin,
      basis,
      description: issue.description,
    });
  }
  return entries;
}
