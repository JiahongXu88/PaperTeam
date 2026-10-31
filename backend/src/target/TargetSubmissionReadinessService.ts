/**
 * TargetSubmissionReadinessService（M15.18 Phase E）：目标期刊投稿准备度报告（确定性汇总，零模型）。
 *
 * 只汇总既有工件，不新增任何判断：
 *   ① 官方投稿规范符合度（research/target-guideline-compliance.json；可机检 / 部分可机检 / 本稿不可评价）
 *   ② benchmark 观测描述统计（target-readiness.json + profile；观测带 ≠ 最低录用标准）
 *   ③ 贡献风险（target-contribution-audit.json；claim → 先前工作身份 → quote/全文依据 → 状态）
 *   ④ 修订行动清单（target-audit-revision-plan.json 的确定性分类）
 *   ⑤ 修改前后闭环对账（target-audit-revision-report.json；七态 + 证据门）
 *   ⑥ 局限（独立人类标签 = 0；不输出录用概率 / 质量档位 / Publication Ready）
 *
 * 「投稿准备度」= 可证的规范符合 / 证据支持 / 未解决风险清单；绝不是录用预测。
 */

import type { TargetAuditClosureReport, TargetAuditRevisionPlanView } from "./TargetAuditRevisionService.js";
import type { TargetEvidenceAuditView } from "./TargetEvidenceAuditService.js";
import type { GuidelineComplianceReport, GuidelineField, VenueGuidelineArtifact } from "./guidelineTypes.js";
import type { TargetProfileEnvelope, TargetReadinessArtifact, TargetVerdict } from "./types.js";

export const SUBMISSION_READINESS_SCHEMA_VERSION = 1;

export const SUBMISSION_READINESS_DISCLAIMER =
  "本报告是可追溯的规范符合 / 证据支持 / 未解决风险清单，不是录用预测：不输出录用概率、学术质量档位或「达到某期刊发表水平」判断。" +
  "benchmark 观测带是已发表论文的描述统计，不是最低录用标准；贡献审计是模型 advisory（已做确定性守卫），不构成同行评审结论；" +
  "目标期刊独立人类审稿质量标签 = 0，未做质量校准。";

export type MachineCheckability = "machine_checked" | "partially_machine_checked" | "not_evaluable";

/** 只有部分维度可确定性观测的官方条款（图表格式 / 著录样式 / 结构化摘要等） */
const PARTIAL_FIELDS: ReadonlySet<GuidelineField> = new Set<GuidelineField>([
  "figures.tableThreeLine",
  "figures.resolutionDpi",
  "references.styleAuthorYear",
  "abstract.structuredZh4",
]);

const BENCHMARK_VERDICT_LABELS: Record<TargetVerdict, string> = {
  MEETS_TARGET: "处于观测带内",
  PARTIALLY_MEETS_TARGET: "部分维度处于观测带内",
  BELOW_TARGET: "低于观测带",
  INSUFFICIENT_EVIDENCE: "证据不足（INSUFFICIENT）",
};

export interface SubmissionReadinessReport {
  schemaVersion: typeof SUBMISSION_READINESS_SCHEMA_VERSION;
  projectId: string;
  generatedAt: string;
  venue: { venueId: string; displayName: string } | null;
  manuscriptRevision: number | null;
  official: {
    available: boolean;
    topStatus?: GuidelineComplianceReport["summary"]["topStatus"];
    /** 展示用总体结论（不把「有不可评价条款」的 COMPLIANT 说成全部符合） */
    topStatusLabel?: string;
    evaluatedAt?: string;
    manuscriptRevision?: number | null;
    staleAgainstCurrent?: boolean;
    checks: Array<{
      requirementId: string;
      field: GuidelineField;
      hard: boolean;
      status: GuidelineComplianceReport["checks"][number]["status"];
      checkability: MachineCheckability;
      observed: string;
      expected: string;
      reason?: string;
      officialQuote: string;
      sourceUrl: string;
    }>;
    counts: Record<MachineCheckability, number> & { hardViolations: number };
  };
  benchmark: {
    available: boolean;
    sufficiency: "sufficient" | "insufficient" | "unknown";
    corpusSize?: number;
    profileFresh?: boolean;
    overall?: string;
    dimensions: Array<{ dimension: string; band: string; observed: string; targetRange: string; confidence: string }>;
    note: string;
  };
  contribution: {
    available: boolean;
    stale?: boolean;
    staleReason?: string;
    evaluatedAt?: string;
    items: Array<{
      contributionId: string;
      claimQuote: string;
      anchorVerified: boolean;
      status: string;
      differenceBasis: string;
      priorWork: Array<{ title: string; identity: string; sourceLevel: string; resolvesToPool: boolean; quoteReplayed: boolean }>;
      missingVerification: string;
      uncertainty?: string;
    }>;
    guards?: Record<string, number>;
  };
  actions: {
    available: boolean;
    planId?: string;
    rewriteFromExistingEvidence: ActionEntry[];
    needsTargetedEvidence: ActionEntry[];
    needsRealExperimentOrAuthorDecision: ActionEntry[];
    notActionable: ActionEntry[];
  };
  closure: {
    available: boolean;
    reportId?: string;
    assessedAtRevision?: number | null;
    summary?: Record<string, number>;
    items: Array<{ itemId: string; gap: string; classification: string; closure: string; basis: string; checks?: Record<string, boolean> }>;
  };
  remainingRisks: string[];
  limitations: string[];
  disclaimer: string;
}

interface ActionEntry {
  itemId: string;
  contributionId: string;
  gap: string;
  classification: string;
  decision: "approve" | "reject" | "pending";
  targetFile?: string;
  experimentPlan?: { purpose: string; baselines?: string; datasets?: string; metrics?: string; expectedEvidence?: string };
}

export interface SubmissionReadinessInputs {
  projectId: string;
  now: Date;
  manuscriptRevision: number | null;
  guideline: VenueGuidelineArtifact | null;
  compliance: GuidelineComplianceReport | null;
  profile: TargetProfileEnvelope | null;
  readiness: TargetReadinessArtifact | null;
  benchmarkSufficiency?: "sufficient" | "insufficient";
  benchmarkSize?: number;
  audit: TargetEvidenceAuditView | null;
  plan: TargetAuditRevisionPlanView | null;
  closure: TargetAuditClosureReport | null;
}

function checkabilityOf(check: GuidelineComplianceReport["checks"][number]): MachineCheckability {
  if (check.status === "NOT_EVALUATED") return "not_evaluable";
  return PARTIAL_FIELDS.has(check.field) ? "partially_machine_checked" : "machine_checked";
}

function identityOf(ref: { doi?: string; arxivId?: string; year?: number }): string {
  return [ref.doi !== undefined ? `doi:${ref.doi}` : undefined, ref.arxivId !== undefined ? `arXiv:${ref.arxivId}` : undefined, ref.year !== undefined ? String(ref.year) : undefined]
    .filter((part): part is string => part !== undefined).join(" · ") || "（无可解析身份）";
}

function officialStatusLabel(
  topStatus: GuidelineComplianceReport["summary"]["topStatus"],
  counts: { not_evaluable: number; hardViolations: number },
): string {
  if (topStatus === "HARD_VIOLATION" || counts.hardViolations > 0) return `存在 ${counts.hardViolations} 条硬性违规`;
  if (topStatus === "NOT_EVALUATED_ONLY") return "全部条款本稿不可机检评价（需人工核对）";
  return counts.not_evaluable > 0
    ? `机检范围内未发现硬性违规（另有 ${counts.not_evaluable} 条不可评价，需人工核对）`
    : "机检范围内全部条款符合";
}

/** 纯函数：既有工件 → 报告（同输入同输出，除 generatedAt） */
export function buildSubmissionReadinessReport(input: SubmissionReadinessInputs): SubmissionReadinessReport {
  const checks = (input.compliance?.checks ?? []).map((check) => ({
    requirementId: check.requirementId,
    field: check.field,
    hard: check.hard,
    status: check.status,
    checkability: checkabilityOf(check),
    observed: check.observed,
    expected: check.expected,
    ...(check.reason !== undefined ? { reason: check.reason } : {}),
    officialQuote: check.officialQuote,
    sourceUrl: check.sourceUrl,
  }));
  const counts = {
    machine_checked: checks.filter((check) => check.checkability === "machine_checked").length,
    partially_machine_checked: checks.filter((check) => check.checkability === "partially_machine_checked").length,
    not_evaluable: checks.filter((check) => check.checkability === "not_evaluable").length,
    hardViolations: checks.filter((check) => check.hard && check.status === "VIOLATION").length,
  };
  const sufficiency = input.benchmarkSufficiency ?? "unknown";
  const benchmarkDimensions = (input.readiness?.dimensions ?? []).map((dimension) => ({
    dimension: dimension.dimension,
    // 语料不足时不展示「在带内 / 低于带」，统一 INSUFFICIENT（观测带本身不可靠）
    band: sufficiency === "insufficient" ? BENCHMARK_VERDICT_LABELS.INSUFFICIENT_EVIDENCE : BENCHMARK_VERDICT_LABELS[dimension.verdict],
    observed: dimension.observed,
    targetRange: dimension.targetRange,
    confidence: dimension.confidence,
  }));
  const artifact = input.audit?.artifact;
  const contributionItems = (artifact?.inventory ?? []).map((unit) => {
    const comparison = artifact?.comparisons.find((entry) => entry.contributionId === unit.contributionId);
    return {
      contributionId: unit.contributionId,
      claimQuote: unit.claimQuote,
      anchorVerified: unit.anchorVerified,
      status: comparison?.status ?? "NOT_COMPARED",
      differenceBasis: comparison?.differenceBasis ?? "none",
      priorWork: (comparison?.nearestPriorWorks ?? []).map((ref) => ({
        title: ref.title,
        identity: identityOf(ref),
        sourceLevel: ref.sourceLevel ?? "unlabelled",
        resolvesToPool: ref.resolvesToPool,
        quoteReplayed: ref.priorQuoteVerified === true,
      })),
      missingVerification: comparison?.missingVerification ?? "",
      ...(comparison?.uncertainty !== undefined ? { uncertainty: comparison.uncertainty } : {}),
    };
  });
  const planItems = input.plan?.plan.items ?? [];
  const toAction = (item: (typeof planItems)[number]): ActionEntry => ({
    itemId: item.itemId,
    contributionId: item.contributionId,
    gap: item.gap,
    classification: item.classification,
    decision: item.authorDecision?.decision ?? "pending",
    ...(item.anchor.projection.file !== undefined ? { targetFile: item.anchor.projection.file } : {}),
    ...(item.experimentPlan !== undefined ? { experimentPlan: item.experimentPlan } : {}),
  });
  const closureItems = (input.closure?.items ?? []).map((item) => ({
    itemId: item.itemId,
    gap: planItems.find((entry) => entry.itemId === item.itemId)?.gap ?? "",
    classification: item.classification,
    closure: item.closure,
    basis: item.basis,
    ...(item.checks !== undefined ? { checks: item.checks as unknown as Record<string, boolean> } : {}),
  }));

  const remainingRisks: string[] = [];
  for (const check of checks.filter((entry) => entry.status === "VIOLATION")) {
    remainingRisks.push(`官方条款 ${check.requirementId}${check.hard ? "（硬性）" : ""}未满足：观测 ${check.observed}；要求 ${check.expected}`);
  }
  if (counts.not_evaluable > 0) remainingRisks.push(`${counts.not_evaluable} 条官方条款本稿不可机检评价（需作者人工核对）`);
  for (const item of contributionItems.filter((entry) => entry.status !== "SUPPORTED_DIFFERENCE")) {
    remainingRisks.push(`贡献 ${item.contributionId} 证据状态 ${item.status}${item.missingVerification !== "" ? `：缺 ${item.missingVerification}` : ""}`);
  }
  const closedIds = new Set(closureItems.filter((item) => item.closure === "VALIDATED_FIXED" || item.closure === "ALREADY_SATISFIED").map((item) => item.itemId));
  for (const item of planItems.filter((entry) => !closedIds.has(entry.itemId) && entry.authorDecision?.decision !== "reject")) {
    const closure = closureItems.find((entry) => entry.itemId === item.itemId)?.closure ?? "未复评";
    remainingRisks.push(`审计差距 ${item.itemId}（${item.classification}）仍开放：${closure}——${item.gap.slice(0, 120)}`);
  }
  if (input.audit?.stale === true) remainingRisks.push(`贡献审计相对当前稿已陈旧（${input.audit.staleReason ?? "稿件已变化"}）——风险清单可能过时，建议重新审计`);

  const limitations = [
    "目标期刊独立人类审稿质量标签 = 0：本报告未经期刊级质量校准（M15_TARGET_JOURNAL_QUALITY = INCOMPLETE）。",
    "不输出录用概率、学术质量档位或 Publication Ready 声称；内部 Quality Gate PASS、修订任务成功与可投稿三者互不蕴含。",
    "benchmark 观测带是已发表论文的描述统计，不是最低录用标准；语料不足时保持 INSUFFICIENT。",
    "贡献比较依据的材料等级（全文 / 摘要 / 题录）逐条标注；摘要级比较不能证明实质差异。",
    "需真实实验的差距只给出实验需求包（目的 / 基线 / 数据 / 指标），系统不生成任何实验结果。",
  ];
  if (input.guideline === null) limitations.push("未冻结目标期刊官方指南工件：官方规范区块不可用。");

  return {
    schemaVersion: SUBMISSION_READINESS_SCHEMA_VERSION,
    projectId: input.projectId,
    generatedAt: input.now.toISOString(),
    venue: input.guideline !== null ? { venueId: input.guideline.venueId, displayName: input.guideline.displayName } : null,
    manuscriptRevision: input.manuscriptRevision,
    official: {
      available: input.compliance !== null,
      ...(input.compliance !== null
        ? {
            topStatus: input.compliance.summary.topStatus,
            topStatusLabel: officialStatusLabel(input.compliance.summary.topStatus, counts),
            evaluatedAt: input.compliance.evaluatedAt,
            manuscriptRevision: input.compliance.manuscriptRevision,
            staleAgainstCurrent: input.compliance.manuscriptRevision !== input.manuscriptRevision,
          }
        : {}),
      checks,
      counts,
    },
    benchmark: {
      available: input.readiness !== null,
      sufficiency,
      ...(input.benchmarkSize !== undefined ? { corpusSize: input.benchmarkSize } : {}),
      ...(input.profile !== null ? { profileFresh: input.profile.fresh } : {}),
      ...(input.readiness !== null
        ? { overall: sufficiency === "insufficient" ? BENCHMARK_VERDICT_LABELS.INSUFFICIENT_EVIDENCE : BENCHMARK_VERDICT_LABELS[input.readiness.overall.verdict] }
        : {}),
      dimensions: benchmarkDimensions,
      note: "观测带 = 目标期刊已发表论文的分位描述统计（advisory），不是最低录用标准，也不是官方要求。",
    },
    contribution: {
      available: artifact !== undefined,
      ...(input.audit !== null ? { stale: input.audit.stale, evaluatedAt: input.audit.artifact.evaluatedAt } : {}),
      ...(input.audit?.staleReason !== undefined ? { staleReason: input.audit.staleReason } : {}),
      items: contributionItems,
      ...(artifact !== undefined ? { guards: artifact.guards as unknown as Record<string, number> } : {}),
    },
    actions: {
      available: input.plan !== null,
      ...(input.plan !== null ? { planId: input.plan.plan.planId } : {}),
      rewriteFromExistingEvidence: planItems.filter((item) => item.classification === "REWRITE_ELIGIBLE").map(toAction),
      needsTargetedEvidence: planItems.filter((item) => item.classification === "NEEDS_TARGETED_EVIDENCE" || item.classification === "EVIDENCE_INSUFFICIENT").map(toAction),
      needsRealExperimentOrAuthorDecision: planItems.filter((item) => item.classification === "NEEDS_REAL_EXPERIMENT_OR_AUTHOR_INPUT").map(toAction),
      notActionable: planItems.filter((item) => item.classification === "UNMAPPABLE_TARGET").map(toAction),
    },
    closure: {
      available: input.closure !== null,
      ...(input.closure !== null
        ? { reportId: input.closure.reportId, assessedAtRevision: input.closure.assessedAtRevision, summary: input.closure.summary as unknown as Record<string, number> }
        : {}),
      items: closureItems,
    },
    remainingRisks,
    limitations,
    disclaimer: SUBMISSION_READINESS_DISCLAIMER,
  };
}

const CHECKABILITY_LABELS: Record<MachineCheckability, string> = {
  machine_checked: "可机检",
  partially_machine_checked: "仅部分可机检",
  not_evaluable: "本稿不可评价",
};

const md = (text: string): string => text.replace(/\|/g, "\\|").replace(/\r?\n/g, " ");

/** 可下载 Markdown（确定性渲染） */
export function renderSubmissionReadinessMarkdown(report: SubmissionReadinessReport): string {
  const lines: string[] = [];
  lines.push(`# 目标期刊投稿准备度报告${report.venue !== null ? `：${report.venue.displayName}` : ""}`);
  lines.push("");
  lines.push(`- 项目：${report.projectId} · 稿件修订 r${report.manuscriptRevision ?? "?"} · 生成于 ${report.generatedAt}`);
  lines.push(`- 性质：${report.disclaimer}`);
  lines.push("");
  lines.push("## 1. 官方投稿规范（官方指南工件 → 确定性符合度）");
  if (!report.official.available) {
    lines.push("", "（尚未执行官方规范符合度检查）");
  } else {
    const counts = report.official.counts;
    lines.push("", `总体：${report.official.topStatusLabel ?? report.official.topStatus ?? "—"}；可机检 ${counts.machine_checked} · 仅部分可机检 ${counts.partially_machine_checked} · 本稿不可评价 ${counts.not_evaluable}；硬性违规 ${counts.hardViolations}${report.official.staleAgainstCurrent === true ? `（注意：符合度评估于 r${report.official.manuscriptRevision ?? "?"}，当前稿 r${report.manuscriptRevision ?? "?"}——需重新评估）` : ""}`);
    lines.push("", "| 条款 | 硬性 | 结果 | 机检口径 | 观测 | 要求 | 说明 |", "|---|---|---|---|---|---|---|");
    for (const check of report.official.checks) {
      lines.push(`| ${md(check.requirementId)} | ${check.hard ? "是" : "否"} | ${check.status} | ${CHECKABILITY_LABELS[check.checkability]} | ${md(check.observed)} | ${md(check.expected)} | ${md(check.reason ?? "")} |`);
    }
    lines.push("", "PDF-only 稿件只能观测参考文献；解析失败 ≠ 作者未提供（区间分析跨阈值 → NOT_EVALUATED，不判违规）。");
  }
  lines.push("", "## 2. 目标期刊 benchmark 观测（描述统计，非最低录用标准）");
  if (!report.benchmark.available) {
    lines.push("", "（尚无 benchmark 观测报告）");
  } else {
    lines.push("", `语料：${report.benchmark.corpusSize ?? "?"} 篇（${report.benchmark.sufficiency}）；profile ${report.benchmark.profileFresh === false ? "已陈旧" : "当前"}；总体：${report.benchmark.overall ?? "—"}`);
    lines.push("", "| 维度 | 相对观测带 | 当前稿观测 | 观测带 | 置信 |", "|---|---|---|---|---|");
    for (const dimension of report.benchmark.dimensions) {
      lines.push(`| ${dimension.dimension} | ${dimension.band} | ${md(dimension.observed)} | ${md(dimension.targetRange)} | ${dimension.confidence} |`);
    }
    lines.push("", report.benchmark.note);
  }
  lines.push("", "## 3. 贡献风险（claim → 先前工作身份 → 可回放依据 → 状态）");
  if (!report.contribution.available) {
    lines.push("", "（未执行贡献证据审计 / 实验性功能未启用）");
  } else {
    if (report.contribution.stale === true) lines.push("", `> 审计已陈旧：${report.contribution.staleReason ?? "稿件已变化"}`);
    for (const item of report.contribution.items) {
      lines.push("", `### ${item.contributionId}：${item.status}（差异依据：${item.differenceBasis}${item.anchorVerified ? "；原文锚已核验" : "；原文锚未核验"}）`);
      lines.push(`- 声明原文：「${md(item.claimQuote)}」`);
      for (const ref of item.priorWork) {
        lines.push(`- 先前工作：${md(ref.title)}（${ref.identity}；材料等级 ${ref.sourceLevel}；${ref.resolvesToPool ? "身份可解析" : "身份不可解析"}${ref.quoteReplayed ? "；quote 已回放" : ""}）`);
      }
      if (item.priorWork.length === 0) lines.push("- 先前工作：（无可解析先前工作）");
      if (item.missingVerification !== "") lines.push(`- 缺失验证：${md(item.missingVerification)}`);
      if (item.uncertainty !== undefined) lines.push(`- 不确定性：${md(item.uncertainty)}`);
    }
  }
  lines.push("", "## 4. 修订行动清单");
  if (!report.actions.available) {
    lines.push("", "（尚未生成审计修订计划）");
  } else {
    const section = (title: string, entries: ActionEntry[]): void => {
      lines.push("", `### ${title}（${entries.length}）`);
      if (entries.length === 0) lines.push("- （无）");
      for (const entry of entries) {
        lines.push(`- ${entry.itemId}［${entry.decision === "approve" ? "作者已批准" : entry.decision === "reject" ? "作者不采纳" : "待作者决策"}］${md(entry.gap)}${entry.targetFile !== undefined ? `（目标 ${entry.targetFile}）` : ""}`);
        if (entry.experimentPlan !== undefined) {
          const plan = entry.experimentPlan;
          lines.push(`  - 实验需求包：目的 ${md(plan.purpose)}${plan.baselines !== undefined ? `；基线 ${md(plan.baselines)}` : ""}${plan.datasets !== undefined ? `；数据 ${md(plan.datasets)}` : ""}${plan.metrics !== undefined ? `；指标 ${md(plan.metrics)}` : ""}${plan.expectedEvidence !== undefined ? `；所需证据 ${md(plan.expectedEvidence)}` : ""}`);
        }
      }
    };
    section("可基于现有证据改写", report.actions.rewriteFromExistingEvidence);
    section("需补文献 / 定向证据", report.actions.needsTargetedEvidence);
    section("必须真实实验或作者决策（系统不生成结果）", report.actions.needsRealExperimentOrAuthorDecision);
    section("不可定位到可编辑稿（不猜位置）", report.actions.notActionable);
  }
  lines.push("", "## 5. 修改前后闭环对账（确定性复评）");
  if (!report.closure.available) {
    lines.push("", "（尚未复评）");
  } else {
    lines.push("", `复评 ${report.closure.reportId ?? ""} @ r${report.closure.assessedAtRevision ?? "?"}：${Object.entries(report.closure.summary ?? {}).filter(([key, value]) => key !== "total" && value > 0).map(([key, value]) => `${key} ${value}`).join(" · ")}`);
    lines.push("", "| 条目 | 分类 | 闭环 | 证据门 | 依据 |", "|---|---|---|---|---|");
    for (const item of report.closure.items) {
      const gate = item.checks !== undefined ? Object.entries(item.checks).map(([key, ok]) => `${key}${ok ? "✓" : "✗"}`).join(" ") : "—";
      lines.push(`| ${item.itemId} | ${item.classification} | ${item.closure} | ${gate} | ${md(item.basis.slice(0, 300))} |`);
    }
  }
  lines.push("", "## 6. 仍未解决的风险");
  lines.push("", ...(report.remainingRisks.length > 0 ? report.remainingRisks.map((risk) => `- ${md(risk)}`) : ["- （机器可识别范围内无开放风险——不代表可投稿或可录用）"]));
  lines.push("", "## 7. 局限");
  lines.push("", ...report.limitations.map((limitation) => `- ${limitation}`));
  lines.push("", "后续可选（本报告未提供）：cover letter / highlights / 投稿门户格式包。");
  return `${lines.join("\n")}\n`;
}
