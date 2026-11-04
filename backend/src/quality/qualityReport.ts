/**
 * M15 长程 B：分层 QualityReport（quality-report/v1）——Quality Gate 结论的唯一决策事实源。
 *
 * 由 evaluateProjectQualityGate（workflow quality.gate 与手动 POST /quality-gate 共用的唯一入口）在规则评估之后
 * 确定性生成并嵌入 gate 产物；legacy `gate.passed` 只从本报告派生（overall.finalizable），UI / API / 导出读同一份。
 * 历史 gate 产物（无本字段）经 deriveLegacyQualityReport 只读投影：缺失信息记为 NOT_EVALUATED，绝不默认合格。
 *
 * 五层职责（不是装饰字段）：
 *   L0 完整性   必需核验是否实际执行、覆盖 / 新鲜度 / 事实与引用保持——缺测不是 PASS
 *   L1 已证实   确定性程序 / 作者登记数据复算 / 元数据核验得出的事实、数字、引用、跨节矛盾——FAIL = 已证实缺陷
 *   L2 AI 评议  模型的学术意见、blocking / critical / major 计数、未校准分数——未经核验，FAIL 呈现为「待核验」，不冒充已证实缺陷
 *   L3 修订闭环 授权范围 / 实际 diff / 编辑契约 / 任务层判定 / 待作者批准的数值修改
 *   L4 外部效度 目标期刊等级——独立标签为 0，固定 UNVALIDATED，永不阻断也永不宣称通过
 *
 * overall 优先级：FAIL > NOT_EVALUATED > NEEDS_VERIFICATION > NEEDS_AUTHOR_DECISION > PASS；
 * finalizable = PASS | NEEDS_AUTHOR_DECISION（与旧 gate.passed 同严格度——L2 待核验与必需未评估仍不可冻结，
 * 唯一有意的语义变化：未校准学术分相对基线回退由硬 FAIL 改为作者裁决项，见 revisionTaskGate academic_non_regression）。
 */
import type { QualityGateResult, QualityGateRule, QualityGateRuleStatus } from "./gates.js";

export const QUALITY_REPORT_SCHEMA_VERSION = "quality-report/v1" as const;

export type QualityLayerId = "L0" | "L1" | "L2" | "L3" | "L4";
export type QualityLayerStatus = "PASS" | "FAIL" | "NOT_EVALUATED" | "NOT_APPLICABLE" | "NEEDS_VERIFICATION" | "NEEDS_AUTHOR_DECISION" | "UNVALIDATED";
export type QualityOverallStatus = "PASS" | "FAIL" | "NOT_EVALUATED" | "NEEDS_VERIFICATION" | "NEEDS_AUTHOR_DECISION";

/** 证据等级：结论凭什么成立（UI 据此区分「事实真的错」「没验证」「模型意见」） */
export type EvidenceGrade =
  | "deterministic"
  | "author_data_recomputed"
  | "metadata_lookup"
  | "verified_evidence"
  | "llm_judgment"
  | "uncalibrated_score"
  | "edit_contract"
  | "author_decision"
  | "unclassified";

export interface QualityReportItem {
  id: string;
  layer: QualityLayerId;
  /** 原始执行状态（规则 status / 任务层 check） */
  sourceStatus: QualityGateRuleStatus | "AUTHOR_DECISION_REQUIRED" | "PENDING" | "SHADOW";
  /** 本层语义下的状态（L2 的 FAIL → NEEDS_VERIFICATION） */
  status: QualityLayerStatus;
  required: boolean;
  evidenceGrade: EvidenceGrade;
  detail: string;
  reasonCode?: string;
}

export interface QualityReportLayer {
  layer: QualityLayerId;
  title: string;
  status: QualityLayerStatus;
  items: QualityReportItem[];
  /** 本层导致不可冻结的条目 */
  blocking: string[];
  /** 本层未评估 / 未启用的条目（非阻断的也列出，不静默） */
  unknowns: string[];
}

export interface QualityReport {
  schemaVersion: typeof QUALITY_REPORT_SCHEMA_VERSION;
  generatedAt: string;
  /** 与 gate.evaluation 同源的版本绑定；legacy 投影时缺失字段为 null */
  binding: {
    reviewedRevision: number | null;
    reviewRound: number | null;
    inputFingerprint: string | null;
    runId: string | null;
    entry: "workflow" | "manual" | "legacy_projection";
    workflowKind: string | null;
    reviewPurpose: string | null;
    /**
     * 本轮审稿使用的发表目标政策（review-policy/v1 摘要，来自同轮 review summary）。缺省 = 旧产物 / 未冻结政策的 run。
     * 只说明「审稿关注点从何而来」；不参与 overall / finalizable 的任何判定。
     */
    reviewPolicy?: {
      policyVersion: string;
      policyHash: string;
      articleType: string;
      targetLabel: string | null;
      tierFactStatus: string;
      journal: string | null;
    };
  };
  layers: Record<QualityLayerId, QualityReportLayer>;
  overall: {
    status: QualityOverallStatus;
    finalizable: boolean;
    reasons: string[];
    unknowns: string[];
    /** 面向用户的一句话结论（不含任何期刊级 / 可投稿宣称） */
    statement: string;
  };
  /** legacy gate.passed 的派生关系（不允许旧布尔覆盖本报告） */
  compat: {
    legacyPassedDerived: boolean;
    /** 规则层原始布尔（派生前）；与 derived 不同时如实记录差异原因 */
    rulePassedBeforeReport: boolean | null;
    difference: string | null;
    meaning: string;
  };
  /** 产品真实性约束（独立标签为 0 时恒为 false / 0；任何 UI / API 不得据此外宣称已校准 / 达到期刊水平） */
  externalValidity: {
    independentHumanLabels: number;
    scoreCalibrated: false;
    targetJournalValidated: false;
    statement: string;
  };
}

interface RuleClass {
  layer: QualityLayerId;
  grade: EvidenceGrade;
}

/** 规则 → 层 / 证据等级（未列出的规则 fail-closed 归 L0 unclassified：FAIL 照常阻断） */
const RULE_CLASSES: Record<string, RuleClass> = {
  // L0 完整性 / 保持 / 结构
  review_coverage_complete: { layer: "L0", grade: "deterministic" },
  review_coverage_complete_not_applicable: { layer: "L0", grade: "deterministic" },
  citation_structure_valid: { layer: "L0", grade: "deterministic" },
  citation_keys_preserved: { layer: "L0", grade: "deterministic" },
  citation_preservation_not_applicable: { layer: "L0", grade: "deterministic" },
  fact_preservation: { layer: "L0", grade: "deterministic" },
  fact_preservation_not_applicable: { layer: "L0", grade: "deterministic" },
  cumulative_fact_preservation: { layer: "L0", grade: "deterministic" },
  cumulative_fact_preservation_not_applicable: { layer: "L0", grade: "deterministic" },
  published_facts_zero_drift: { layer: "L0", grade: "deterministic" },
  inherited_tables_intact: { layer: "L0", grade: "deterministic" },
  workflow_meta_notes_absent: { layer: "L0", grade: "deterministic" },
  thesis_structure_complete: { layer: "L0", grade: "deterministic" },
  thesis_abstract_complete: { layer: "L0", grade: "deterministic" },
  thesis_abstract_snapshot_current: { layer: "L0", grade: "deterministic" },
  thesis_mapping_confirmed: { layer: "L0", grade: "author_decision" },
  thesis_citations_present: { layer: "L0", grade: "deterministic" },
  survey_outline_contract: { layer: "L0", grade: "deterministic" },
  survey_citation_keys_valid: { layer: "L0", grade: "deterministic" },
  citation_semantic_verification_off: { layer: "L0", grade: "deterministic" },
  review_unit_context_reported: { layer: "L0", grade: "deterministic" },
  review_cross_chapter_reported: { layer: "L0", grade: "deterministic" },
  review_whole_paper_reported: { layer: "L0", grade: "deterministic" },
  review_output_contract_reported: { layer: "L0", grade: "deterministic" },
  // L1 已证实（确定性 / 作者数据复算 / 元数据 / 已核验证据）
  cross_section_numeric_consistency: { layer: "L1", grade: "deterministic" },
  review_findings_certified: { layer: "L1", grade: "deterministic" },
  experiment_claims_recomputed: { layer: "L1", grade: "author_data_recomputed" },
  author_experiment_data_reported: { layer: "L1", grade: "author_data_recomputed" },
  hallucinated_citations_zero: { layer: "L1", grade: "metadata_lookup" },
  citation_fabrication_zero: { layer: "L1", grade: "metadata_lookup" },
  citation_metadata_mismatch_critical_zero: { layer: "L1", grade: "metadata_lookup" },
  citation_not_found_obligatory_zero: { layer: "L1", grade: "metadata_lookup" },
  no_contradictory_evidence: { layer: "L1", grade: "verified_evidence" },
  thesis_conflicts_resolved: { layer: "L1", grade: "deterministic" },
  // L2 AI 评议（未经独立核验的模型判断 / 未校准分数 / 启发式）
  blocking_issues_zero: { layer: "L2", grade: "llm_judgment" },
  open_critical_major_zero: { layer: "L2", grade: "llm_judgment" },
  unsupported_critical_claims_zero: { layer: "L2", grade: "llm_judgment" },
  citations_evidence_backed: { layer: "L2", grade: "verified_evidence" },
  citation_unsupported_critical_zero: { layer: "L2", grade: "llm_judgment" },
  citation_insufficient_evidence_review: { layer: "L2", grade: "llm_judgment" },
  claim_strength_guard: { layer: "L2", grade: "llm_judgment" },
  target_feasibility: { layer: "L2", grade: "llm_judgment" },
  academic_score_threshold: { layer: "L2", grade: "uncalibrated_score" },
  style_risk_threshold: { layer: "L2", grade: "uncalibrated_score" },
  transparent_unverified_reported: { layer: "L2", grade: "llm_judgment" },
  templated_phrasing_reported: { layer: "L2", grade: "llm_judgment" },
  // M17.1：默认风格审查覆盖（建议性；风格发现是模型建议，非科学缺陷）
  academic_style_audit_reported: { layer: "L2", grade: "llm_judgment" },
  cross_chapter_consistency_reported: { layer: "L2", grade: "deterministic" },
  survey_writing_metrics: { layer: "L2", grade: "deterministic" },
  survey_synthesis_traceability: { layer: "L2", grade: "deterministic" },
  // L3 修订闭环
  revision_items_resolved: { layer: "L3", grade: "deterministic" },
  patch_validation_publishable: { layer: "L3", grade: "edit_contract" },
  edit_contract: { layer: "L3", grade: "edit_contract" },
};

export function classifyGateRule(rule: string): RuleClass {
  return RULE_CLASSES[rule] ?? { layer: "L0", grade: "unclassified" };
}

const LAYER_TITLES: Record<QualityLayerId, string> = {
  L0: "完整性：必需核验是否执行、覆盖与事实 / 引用保持",
  L1: "已证实缺陷：确定性 / 作者数据复算 / 元数据核验",
  L2: "AI 审稿意见：模型判断与未校准分数（未经独立核验）",
  L3: "修订闭环：授权、编辑契约与任务层判定",
  L4: "外部效度：目标期刊水平（未经独立校准）",
};

function ruleStatus(rule: QualityGateRule): QualityGateRuleStatus {
  // 旧产物 / 外部追加规则无 status：只能按 passed 解释；passed=false 一律视为 FAIL（不猜 NOT_EVALUATED）
  return rule.status ?? (rule.passed ? "PASS" : "FAIL");
}

function itemFromRule(rule: QualityGateRule): QualityReportItem {
  const cls = classifyGateRule(rule.rule);
  const source = ruleStatus(rule);
  let status: QualityLayerStatus;
  switch (source) {
    case "FAIL":
      status = cls.layer === "L2" ? "NEEDS_VERIFICATION" : "FAIL";
      break;
    case "NOT_EVALUATED":
      status = "NOT_EVALUATED";
      break;
    case "NOT_APPLICABLE":
      status = "NOT_APPLICABLE";
      break;
    default:
      status = "PASS";
  }
  return {
    id: rule.rule,
    layer: cls.layer,
    sourceStatus: source,
    status,
    required: rule.required === true || (source === "FAIL" && cls.layer !== "L2"),
    evidenceGrade: cls.grade,
    detail: rule.detail,
    ...(source === "ADVISORY" ? { reasonCode: "UNCALIBRATED_ADVISORY" } : source === "INFO" ? { reasonCode: "INFORMATIONAL" } : {}),
  };
}

function summarizeLayer(layer: QualityLayerId, items: QualityReportItem[]): QualityReportLayer {
  const blocking: string[] = [];
  const unknowns: string[] = [];
  for (const item of items) {
    if (item.status === "FAIL") blocking.push(item.id);
    else if (item.status === "NOT_EVALUATED" && item.required) blocking.push(item.id);
    else if (item.status === "NEEDS_VERIFICATION") blocking.push(item.id);
    if (item.status === "NOT_EVALUATED") unknowns.push(item.id);
  }
  const has = (status: QualityLayerStatus, requiredOnly = false) => items.some((item) => item.status === status && (!requiredOnly || item.required));
  let status: QualityLayerStatus;
  if (layer === "L4") status = "UNVALIDATED";
  else if (has("FAIL")) status = "FAIL";
  else if (has("NOT_EVALUATED", true)) status = "NOT_EVALUATED";
  else if (has("NEEDS_VERIFICATION")) status = "NEEDS_VERIFICATION";
  else if (has("NEEDS_AUTHOR_DECISION")) status = "NEEDS_AUTHOR_DECISION";
  else if (items.length === 0 || items.every((item) => item.status === "NOT_APPLICABLE")) status = "NOT_APPLICABLE";
  else status = "PASS";
  return { layer, title: LAYER_TITLES[layer], status, items, blocking, unknowns };
}

export interface QualityReportContext {
  /** 待作者批准的数值修改请求数（R4）；null = 契约存储不可读（L3 未评估，fail closed） */
  pendingValueChangeRequests?: number | null;
  /** 作者稿件的 claim 级审计模式（shadow = 只产影子账本，不进生产 Gate） */
  claimAuditMode?: "off" | "shadow" | "extended";
  /** 独立人类标签数（当前 0；只有外部校准包回收后才可能 > 0） */
  independentHumanLabels?: number;
  generatedAt?: string;
  entry?: QualityReport["binding"]["entry"];
  /** 同轮 review summary 的发表目标政策摘要（reviewPolicySummary 产物；只读展示） */
  reviewPolicy?: Record<string, unknown> | null;
}

/** review summary 的政策摘要 → binding 字段（字段不全 = 不绑定，不猜） */
function reviewPolicyBinding(summary: Record<string, unknown> | null): NonNullable<QualityReport["binding"]["reviewPolicy"]> | null {
  if (summary === null) return null;
  const policyVersion = summary["policyVersion"];
  const policyHash = summary["policyHash"];
  const articleType = summary["articleType"];
  if (typeof policyVersion !== "string" || typeof policyHash !== "string" || typeof articleType !== "string") return null;
  const target = (summary["target"] ?? null) as Record<string, unknown> | null;
  const journal = (summary["targetJournal"] ?? null) as Record<string, unknown> | null;
  const tierFact = (summary["tierFact"] ?? null) as Record<string, unknown> | null;
  const tier = target !== null && typeof target["tierLabel"] === "string" ? target["tierLabel"] : null;
  const journalName = journal !== null && typeof journal["displayName"] === "string"
    ? journal["displayName"]
    : target !== null && typeof target["customJournalName"] === "string" ? target["customJournalName"] : null;
  const label = [tier, journalName].filter((part): part is string => part !== null).join(" · ");
  return {
    policyVersion,
    policyHash,
    articleType,
    targetLabel: label === "" ? null : label,
    tierFactStatus: tierFact !== null && typeof tierFact["status"] === "string" ? tierFact["status"] : "NOT_SET",
    journal: journalName,
  };
}

/** 规则层结果 → 分层报告（纯函数、确定性：同一 gate 结果 + 同一 context 恒得同一报告，generatedAt 除外） */
export function buildQualityReport(gate: QualityGateResult, context: QualityReportContext = {}): QualityReport {
  const items: QualityReportItem[] = gate.rules.map(itemFromRule);
  if (gate.rules.length === 0) {
    items.push({
      id: "gate_rules_present",
      layer: "L0",
      sourceStatus: "NOT_EVALUATED",
      status: "NOT_EVALUATED",
      required: true,
      evidenceGrade: "deterministic",
      detail: "gate 产物没有任何规则结果：无法证明任何核验已执行",
      reasonCode: "GATE_HAS_NO_RULES",
    });
  }

  // L2：作者稿件 claim 级审计未接入生产（如实标注未启用，不冒充已核验）
  if (context.claimAuditMode !== undefined && context.claimAuditMode !== "extended") {
    items.push({
      id: "claim_level_audit",
      layer: "L2",
      sourceStatus: "SHADOW",
      status: "NOT_EVALUATED",
      required: false,
      evidenceGrade: "llm_judgment",
      detail: context.claimAuditMode === "off"
        ? "论断级审计已关闭：逐条论断的抽取 / 核验未执行"
        : "论断级审计为影子模式（shadow）：作者稿件的逐条论断抽取与跨单元复核只产出影子账本，未进入生产 Gate——这些论断未经核验，不代表没有问题",
      reasonCode: context.claimAuditMode === "off" ? "CLAIM_AUDIT_OFF" : "SHADOW_NOT_IN_PRODUCTION_GATE",
    });
  }

  // L3：任务层判定 + 待作者批准的数值修改
  const task = gate.revisionTask;
  if (task !== undefined) {
    for (const check of task.checks) {
      const advisory = (check as { advisory?: boolean }).advisory === true;
      items.push({
        id: `revision_task.${check.check}`,
        layer: "L3",
        sourceStatus: check.passed ? "PASS" : "FAIL",
        status: advisory ? "NEEDS_AUTHOR_DECISION" : check.passed ? "PASS" : "FAIL",
        required: !advisory,
        evidenceGrade: check.check.startsWith("academic_") ? "uncalibrated_score" : "deterministic",
        detail: check.detail,
        ...(advisory ? { reasonCode: "UNCALIBRATED_SCORE_REGRESSION" } : {}),
      });
    }
    if (task.verdict === "AUTHOR_DECISION_REQUIRED") {
      items.push({
        id: "revision_task.author_decisions",
        layer: "L3",
        sourceStatus: "AUTHOR_DECISION_REQUIRED",
        status: "NEEDS_AUTHOR_DECISION",
        required: false,
        evidenceGrade: "author_decision",
        detail: task.reasons.filter((reason) => !task.checks.some((check) => !check.passed && reason.startsWith(`${check.check}:`))).join("；") || "存在需要作者裁决的条目",
      });
    }
  }
  if (context.pendingValueChangeRequests === null) {
    items.push({
      id: "value_change_requests_pending",
      layer: "L3",
      sourceStatus: "NOT_EVALUATED",
      status: "NOT_EVALUATED",
      required: true,
      evidenceGrade: "edit_contract",
      detail: "编辑契约存储不可读：无法确认是否存在待作者批准的数值修改——不能判定修订闭环",
      reasonCode: "EDIT_CONTRACT_STORE_UNREADABLE",
    });
  } else if ((context.pendingValueChangeRequests ?? 0) > 0) {
    items.push({
      id: "value_change_requests_pending",
      layer: "L3",
      sourceStatus: "PENDING",
      status: "NEEDS_AUTHOR_DECISION",
      required: false,
      evidenceGrade: "author_decision",
      detail: `${context.pendingValueChangeRequests} 项改动作者冻结数值的修订候选已被拒绝、等待作者逐项批准（未批准前稿件中的原数值保持不变）`,
    });
  }

  // L4：目标期刊——独立标签为 0 时固定 UNVALIDATED（设置了发表目标也不改变：目标只决定审稿关注点）
  const labels = context.independentHumanLabels ?? 0;
  const policyBinding = reviewPolicyBinding(context.reviewPolicy ?? null);
  const readiness = gate.targetReadiness as { status?: string; summary?: string } | undefined;
  items.push({
    id: "target_journal_level",
    layer: "L4",
    sourceStatus: "NOT_EVALUATED",
    status: "UNVALIDATED",
    required: false,
    evidenceGrade: "unclassified",
    detail:
      `目标期刊水平未经独立校准（独立人类标签 ${labels}）：系统不判定「达到某期刊要求」或「可投稿」` +
      (policyBinding?.targetLabel != null ? `；用户设定的发表目标「${policyBinding.targetLabel}」只用于决定审稿关注点，不是本层的通过标准` : "") +
      (readiness !== undefined ? `；目标画像观察（advisory）：${String(readiness.summary ?? readiness.status ?? "已生成")}` : ""),
    reasonCode: "NO_INDEPENDENT_CALIBRATION",
  });

  const byLayer = (layer: QualityLayerId) => summarizeLayer(layer, items.filter((item) => item.layer === layer));
  const layers = { L0: byLayer("L0"), L1: byLayer("L1"), L2: byLayer("L2"), L3: byLayer("L3"), L4: byLayer("L4") };

  const statuses = (["L0", "L1", "L2", "L3"] as const).map((layer) => layers[layer].status);
  const overallStatus: QualityOverallStatus = statuses.includes("FAIL")
    ? "FAIL"
    : statuses.includes("NOT_EVALUATED")
      ? "NOT_EVALUATED"
      : statuses.includes("NEEDS_VERIFICATION")
        ? "NEEDS_VERIFICATION"
        : statuses.includes("NEEDS_AUTHOR_DECISION")
          ? "NEEDS_AUTHOR_DECISION"
          : "PASS";
  const finalizable = overallStatus === "PASS" || overallStatus === "NEEDS_AUTHOR_DECISION";
  const reasons = (["L0", "L1", "L2", "L3"] as const).flatMap((layer) =>
    layers[layer].items
      .filter((item) => layers[layer].blocking.includes(item.id) || item.status === "NEEDS_AUTHOR_DECISION")
      .map((item) => `${layer} ${item.id}: ${item.status}`),
  );
  const unknowns = (["L0", "L1", "L2", "L3"] as const).flatMap((layer) => layers[layer].unknowns.map((id) => `${layer} ${id}`));
  const statement: Record<QualityOverallStatus, string> = {
    FAIL: layers.L1.status === "FAIL"
      ? "存在已证实的缺陷（确定性核验 / 作者数据复算 / 元数据核验）——需修正后重新评估"
      : "完整性、修订授权或任务闭环检查未通过——需处理后重新评估",
    NOT_EVALUATED: "必需核验未完成（缺测、缺依赖或陈旧）——不能据此判断稿件是否合格",
    NEEDS_VERIFICATION: "无已证实缺陷，但 AI 审稿提出的阻断级意见尚未核验——这些是模型意见，不是已证实错误",
    NEEDS_AUTHOR_DECISION: "完整性与已证实缺陷检查通过；存在需要作者裁决的条目（不代表可投稿）",
    PASS: "完整性与已证实缺陷检查通过，AI 审稿无未核验的阻断级意见（不代表达到任何期刊水平或可投稿）",
  };
  return {
    schemaVersion: QUALITY_REPORT_SCHEMA_VERSION,
    generatedAt: context.generatedAt ?? new Date().toISOString(),
    binding: {
      reviewedRevision: gate.evaluation?.reviewedRevision ?? null,
      reviewRound: gate.evaluation?.reviewRound ?? null,
      inputFingerprint: gate.evaluation?.inputFingerprint ?? null,
      runId: gate.evaluation?.runId ?? null,
      entry: context.entry ?? gate.evaluation?.entry ?? "legacy_projection",
      workflowKind: gate.evaluation?.workflowKind ?? null,
      reviewPurpose: gate.evaluation?.reviewPurpose ?? null,
      ...(policyBinding !== null ? { reviewPolicy: policyBinding } : {}),
    },
    layers,
    overall: {
      status: overallStatus,
      finalizable,
      reasons,
      unknowns,
      statement: unknowns.length > 0 && finalizable ? `${statement[overallStatus]}；另有 ${unknowns.length} 项未评估（见各层 unknowns）` : statement[overallStatus],
    },
    compat: {
      legacyPassedDerived: finalizable,
      rulePassedBeforeReport: gate.passed,
      difference: gate.passed === finalizable ? null : describeDifference(gate, finalizable),
      meaning: "gate.passed = overall.finalizable（PASS 或仅剩作者裁决项）：完整性与已证实缺陷检查通过且无未核验的 AI 阻断意见；不代表达到期刊水平或可投稿",
    },
    externalValidity: {
      independentHumanLabels: labels,
      scoreCalibrated: false,
      targetJournalValidated: false,
      statement: "分数与目标期刊层未经独立人类标签校准：不得解读为「达到某期刊水平」「可投稿」或「经校准评分」",
    },
  };
}

function describeDifference(gate: QualityGateResult, finalizable: boolean): string {
  const scoreRegression = gate.revisionTask?.checks.some((check) => check.check === "academic_non_regression" && (check as { advisory?: boolean }).advisory === true);
  if (finalizable && scoreRegression === true) return "未校准学术分相对基线回退：旧口径硬 FAIL，现为作者裁决项（分数重复评审 SD 5–12，不能承担硬门）";
  return finalizable ? "规则层布尔为 false，但分层报告无阻断项（请检查规则状态映射）" : "规则层布尔为 true，但分层报告存在阻断项（以分层报告为准）";
}

/**
 * 历史 gate 产物（无 qualityReport）只读投影：同一映射，entry=legacy_projection。规则无 status 时按 passed 归 PASS / FAIL
 * （不推断 NOT_EVALUATED）；缺 evaluation / verification 的旧产物在 L0 追加 NOT_EVALUATED（必需）的
 * LEGACY_ARTIFACT_INCOMPLETE 条目——旧报告不会因缺字段被投影为可冻结。
 */
export function deriveLegacyQualityReport(gate: QualityGateResult): QualityReport {
  const incomplete = gate.verification === undefined || gate.rules.some((rule) => rule.status === undefined);
  const projected: QualityGateResult = incomplete
    ? {
        ...gate,
        rules: [
          ...gate.rules,
          {
            rule: "legacy_artifact_complete",
            passed: false,
            status: "NOT_EVALUATED",
            required: true,
            detail: "历史 gate 产物早于分层报告且缺少核验状态 / 评估绑定字段：无法确认必需核验是否执行——需重新评估",
          },
        ],
      }
    : gate;
  return buildQualityReport(projected, { entry: "legacy_projection", generatedAt: gate.checkedAt });
}

/** 读取方统一入口：新产物用嵌入的报告；旧产物只读投影 */
export function qualityReportOf(gate: QualityGateResult & { qualityReport?: QualityReport }): QualityReport {
  return gate.qualityReport?.schemaVersion === QUALITY_REPORT_SCHEMA_VERSION ? gate.qualityReport : deriveLegacyQualityReport(gate);
}
