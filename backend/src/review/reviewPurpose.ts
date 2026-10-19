/**
 * M14.9.3 P0-B：审稿目的（review purpose）——第三方已发表论文的只读评估语义。
 *
 * 缺省 `author_manuscript`：作者正在创作 / 返修的稿件，Experiment Policy 与 Fact / Citation / Evidence
 * Guard 全部按原口径执行（具体实验数值只能来自已授权实验包，缺数据 = 实验支撑缺口）。本模块对该缺省
 * 路径不做任何改变——prompt、Gate 规则、80 分阈值逐字节不变。
 *
 * `published_paper_assessment`：只读取第三方已发表论文并评价其公开内容。论文作者在文中报告的数值是
 * PAPER_REPORTED / NOT_INDEPENDENTLY_VERIFIED——既不是 PaperTeam 复核过的事实，也不因「本项目没有
 * 原始数据」而自动成为证据缺口 / blocking。稿内可核对的算术、表文一致、统计方向与显著性、引用与逻辑
 * 照常审查，发现的问题不以「已发表」为由豁免。生产 Quality Gate 照常运行且不改规则；本模块另给出
 * 标明 applicability 的只读评估视图（发表门禁对第三方论文不适用，未执行的核验项一律 NOT_EVALUATED）。
 */

import type { QualityGateResult } from "../quality/gates.js";
import type { ReviewIssue } from "../agents/ReviewerService.js";
import type { ReviewSummary } from "./ReviewAggregator.js";

export type ReviewPurpose = "author_manuscript" | "published_paper_assessment";

export const REVIEW_PURPOSES: readonly ReviewPurpose[] = ["author_manuscript", "published_paper_assessment"];

/** run request 中的审稿目的；缺省 / 历史 run = author_manuscript（行为与 M14.9.3 之前一致） */
export function readReviewPurpose(request: Record<string, unknown> | undefined): ReviewPurpose {
  const value = request?.["reviewPurpose"];
  return value === "published_paper_assessment" ? "published_paper_assessment" : "author_manuscript";
}

/** 只读评估口径块：替换作者稿件的 Experiment Policy（三路 digest / 单元 / 跨章审稿共用） */
export function renderPublishedAssessmentPolicyLines(): string[] {
  return [
    "",
    "===== 审稿场景：第三方已发表论文的只读评价（published_paper_assessment）=====",
    "- 本项目只包含这篇论文公开发表的文本；PaperTeam 没有、也不需要导入论文作者的原始实验 / 调查数据。",
    "- 论文中作者报告的具体数值、样本量与统计量属于「论文自报（PAPER_REPORTED），未经独立核验（NOT_INDEPENDENTLY_VERIFIED）」：不得仅因项目内没有原始数据、证据库没有记录，就把它们报告为实验支撑缺口、虚构数据或 blocking 问题。",
    "- 稿内可核对的内容仍须严格审查并照常按 critical / major / minor 报告，不因论文已发表而豁免：算术与百分比、分母与合计、表格与正文的数值一致性、统计方向（OR / 系数正负与文字解释）、显著性表述与 P 值、方法与结论的逻辑、引用与论断的对应。",
    "- 只有当缺少原始数据确实使某个具体结论无法评价时，才用 category=evidence_gap、severity=minor、blocking=false 单独说明「需外部原始数据核验（EXTERNAL_VALIDATION_REQUIRED）」并写明是哪一结论；不要把它写成论文的缺陷。",
    "- 作者 / 单位 / 基金 / 排版模板等投稿元数据不属于科研质量问题，不要报告。",
  ];
}

export type PublishedFindingClass = "SCIENTIFIC_FINDING" | "EVIDENCE_LIMITATION" | "SUBMISSION_CHECKLIST" | "CONVERSION_ARTIFACT";

const DATA_UNAVAILABLE = /(未导入|没有导入|尚未导入|未授权|没有获得.*授权|证据库|无法核验(其)?来源|无可核验|没有可核验|没有可核对|缺少可核对|缺少可核验|原始数据|实验数据|调查数据|来源无法核验|EXTERNAL_VALIDATION_REQUIRED|NOT_INDEPENDENTLY_VERIFIED|cannot be verified|no (imported|experimental) data)/i;
/** 稿内可核对的科研问题信号：出现即按科研 finding 计（即使同时提到缺原始数据） */
const INTERNAL_CHECK = /(矛盾|不一致|不符|对不上|算错|计算(有误|错误)|复算.{0,12}(应为|不|错|差)|方向相反|相反|反转|不匹配|自相矛盾|(合计|分母|百分比).{0,8}(错|不|误)|显著性.{0,8}(错|不|误)|P\s*值.{0,8}(错|不|误)|contradict|inconsistent|mismatch)/i;
const SUBMISSION = /(作者(信息|简介|署名)|单位信息|基金(信息|号)|Word\s*模板|排版|版式|页眉|页脚|投稿格式|著录格式|参考文献格式|格式规范)/;

/** 已发表论文评估视图中的 finding 归类（确定性词面规则；原 issue 不改写） */
export function classifyPublishedFinding(issue: Pick<ReviewIssue, "category" | "description">): PublishedFindingClass {
  if (issue.category === "build") return "CONVERSION_ARTIFACT";
  const text = issue.description ?? "";
  if (SUBMISSION.test(text) && issue.category !== "fact" && !DATA_UNAVAILABLE.test(text)) return "SUBMISSION_CHECKLIST";
  if (INTERNAL_CHECK.test(text)) return "SCIENTIFIC_FINDING";
  if ((issue.category === "evidence_gap" || issue.category === "fact") && DATA_UNAVAILABLE.test(text)) return "EVIDENCE_LIMITATION";
  return "SCIENTIFIC_FINDING";
}

export type RuleApplicability = "APPLICABLE" | "APPLICABLE_RECOUNTED" | "NOT_EVALUATED" | "NOT_APPLICABLE" | "REPORTED_ONLY";

export interface PublishedAssessmentView {
  schema: "paperteam.published-assessment/v1";
  reviewPurpose: "published_paper_assessment";
  round: number;
  /** 审稿是否完成（覆盖账本完整）——不是论文质量结论 */
  reviewCompleted: boolean;
  /** 对第三方已发表论文，作者稿件的 Final / 发表门禁不适用（生产 gate 结果仅原样保留供参考） */
  publicationGate: "PUBLICATION_GATE_NOT_APPLICABLE";
  productionGate: { passed: boolean; reasons: string[]; note: string };
  academicScore: { value: number | null; note: string };
  scientificFindings: { total: number; critical: number; major: number; minor: number; blocking: number };
  evidenceLimitations: { total: number; label: "PAPER_REPORTED / NOT_INDEPENDENTLY_VERIFIED"; samples: string[] };
  submissionChecklist: { total: number; note: string };
  conversionArtifacts: { total: number; note: string };
  ruleApplicability: Array<{ rule: string; productionPassed: boolean; applicability: RuleApplicability; note: string }>;
  notEvaluated: Array<{ item: string; reason: string }>;
  findings: Array<{ class: PublishedFindingClass; severity: string; category: string; section: string; blocking: boolean; description: string }>;
}

export interface PublishedAssessmentInput {
  gate: QualityGateResult;
  review: ReviewSummary;
  /** citation.verify 是否产出过引用核验报告 */
  citationReportAvailable: boolean;
  /** 项目证据库记录数（0 = 没有任何证据记录，证据类规则只能 NOT_EVALUATED） */
  evidenceRecords: number;
  feasibilityEvaluated: boolean;
}

/** 生产 Gate 结果 → 只读评估视图（不改 gate 本身；每条规则标明对第三方论文的适用性） */
export function buildPublishedAssessmentView(input: PublishedAssessmentInput): PublishedAssessmentView {
  const { gate, review } = input;
  const classified = review.issues.map((issue) => ({ issue, cls: classifyPublishedFinding(issue) }));
  const scientific = classified.filter((entry) => entry.cls === "SCIENTIFIC_FINDING").map((entry) => entry.issue);
  const limitations = classified.filter((entry) => entry.cls === "EVIDENCE_LIMITATION").map((entry) => entry.issue);
  const count = (severity: string) => scientific.filter((issue) => issue.severity === severity).length;
  const unitMode = review.coverage?.mode === "units";
  const applicability = (rule: string): { applicability: RuleApplicability; note: string } => {
    switch (rule) {
      case "hallucinated_citations_zero":
      case "citation_structure_valid":
        return input.citationReportAvailable
          ? { applicability: "APPLICABLE", note: "基于已执行的 citation.verify 报告" }
          : { applicability: "NOT_EVALUATED", note: "未执行 citation.verify：计数 0 来自「没有报告」，不代表引用真实性已通过" };
      case "no_contradictory_evidence":
        return input.evidenceRecords > 0
          ? { applicability: "APPLICABLE", note: "基于项目证据库记录" }
          : { applicability: "NOT_EVALUATED", note: "项目证据库为空：没有可比对的证据，0 条矛盾不代表通过" };
      case "unsupported_critical_claims_zero":
        return unitMode
          ? { applicability: "NOT_EVALUATED", note: "单元审稿模式不产出 claims 核验，0 条来自未执行" }
          : { applicability: "APPLICABLE", note: "fact 模式 claims 核验" };
      case "blocking_issues_zero":
      case "open_critical_major_zero":
        return { applicability: "APPLICABLE_RECOUNTED", note: "只读视图按科研 finding 重新计数（证据可得性限制 / 投稿清单 / 转写伪影单列）；生产规则判定原样保留" };
      case "academic_score_threshold":
        return { applicability: "REPORTED_ONLY", note: "80 分是作者稿件进入 Final 的产品门槛，不是期刊录用线；对第三方已发表论文只报告分数，不作发表结论" };
      case "target_feasibility":
        return input.feasibilityEvaluated
          ? { applicability: "APPLICABLE", note: "已执行可行性评估" }
          : { applicability: "NOT_EVALUATED", note: "未执行可行性评估" };
      default:
        if (/not_applicable$|_off$/.test(rule)) return { applicability: "NOT_APPLICABLE", note: "首轮 / 无修订基线 / 未开启：不适用" };
        if (/preserv|revision_|claim_strength|cumulative/.test(rule)) return { applicability: "NOT_APPLICABLE", note: "只读评估不修改论文，修订类规则不适用" };
        return { applicability: "APPLICABLE", note: "" };
    }
  };
  return {
    schema: "paperteam.published-assessment/v1",
    reviewPurpose: "published_paper_assessment",
    round: review.round,
    reviewCompleted: review.coverage?.complete ?? true,
    publicationGate: "PUBLICATION_GATE_NOT_APPLICABLE",
    productionGate: { passed: gate.passed, reasons: gate.reasons, note: "生产 Quality Gate 按作者稿件口径原样执行（规则与阈值未改）；对第三方已发表论文仅供参考，不是发表 / 录用判定" },
    academicScore: { value: review.scores.academicScore, note: "Reviewer 学术分；不经校准，不代表期刊等级或录用概率" },
    scientificFindings: { total: scientific.length, critical: count("critical"), major: count("major"), minor: count("minor"), blocking: scientific.filter((issue) => issue.blocking).length },
    evidenceLimitations: { total: limitations.length, label: "PAPER_REPORTED / NOT_INDEPENDENTLY_VERIFIED", samples: limitations.slice(0, 5).map((issue) => issue.description.slice(0, 120)) },
    submissionChecklist: { total: classified.filter((entry) => entry.cls === "SUBMISSION_CHECKLIST").length, note: "投稿元数据 / 排版类意见不计入科研 finding" },
    conversionArtifacts: { total: classified.filter((entry) => entry.cls === "CONVERSION_ARTIFACT").length, note: "build 类意见多指向 PDF→文本转写伪影，须对照输入保真报告复核，不计入论文科研 finding" },
    ruleApplicability: gate.rules.map((rule) => ({ rule: rule.rule, productionPassed: rule.passed, ...applicability(rule.rule) })),
    notEvaluated: [
      ...(input.citationReportAvailable ? [] : [{ item: "citation_verification", reason: "未执行 citation.verify（引用真实性 / 元数据 / 语义支撑）" }]),
      { item: "experiment_reproduction", reason: "未取得论文原始数据，未做实验复算 / 复现；论文自报数值仅做稿内一致性核查" },
      ...(input.feasibilityEvaluated ? [] : [{ item: "target_feasibility", reason: "未执行可行性评估" }]),
      { item: "build_gate", reason: "只读评估不编译投稿稿件" },
      ...(input.evidenceRecords > 0 ? [] : [{ item: "evidence_grounding", reason: "项目证据库为空" }]),
    ],
    findings: classified.map(({ issue, cls }) => ({ class: cls, severity: issue.severity, category: issue.category, section: issue.section, blocking: issue.blocking, description: issue.description })),
  };
}
