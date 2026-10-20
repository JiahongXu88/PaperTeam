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
 *
 * M14.9.5：口径块内置 severity / verification / blocking 三轴 rubric（review/severityRubric）；视图 v2
 * 按可核验性分列科研 finding、给出同根因重复分组与 rubric 一致性提示、标注分数口径（未校准）与输入保真
 * 状态（含哈希绑定的人工 QA 证明）。原始 findings、生产 Gate 计数与判定一概不改写。
 */

import type { QualityGateResult } from "../quality/gates.js";
import type { ReviewIssue } from "../agents/ReviewerService.js";
import type { AcademicScoreBasis, ReviewSummary } from "./ReviewAggregator.js";
import type { InputFidelityReport } from "./inputFidelityTypes.js";
import { canon } from "./inputFidelityText.js";
import { renderPublishedSeverityRubricLines, rubricFlags, type FindingVerification, type RubricFlag } from "./severityRubric.js";
import type { AttestationCheck } from "./inputFidelityAttestation.js";

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
    "- 论文中作者报告的具体数值、样本量与统计量属于「论文自报（PAPER_REPORTED），未经独立核验（NOT_INDEPENDENTLY_VERIFIED）」：不得仅因项目内没有原始数据、证据库没有记录，就把它们报告为实验支撑缺口或虚构数据。",
    "- 稿内可核对的内容仍须严格审查并照常按 critical / major / minor 报告，不因论文已发表而豁免：算术与百分比、分母与合计、表格与正文的数值一致性、统计方向（OR / 系数正负与文字解释）、显著性表述与 P 值、方法与结论的逻辑、引用与论断的对应。",
    ...renderPublishedSeverityRubricLines(),
    "- 只有当缺少原始数据确实使某个具体结论无法评价时，才用 category=evidence_gap、severity=minor、verification=EXTERNAL_DATA_REQUIRED、blocking=false 单独说明「需外部原始数据核验（EXTERNAL_VALIDATION_REQUIRED）」并写明是哪一结论；不要把它写成论文的缺陷。",
    "- 作者 / 单位 / 基金 / 排版模板等投稿元数据不属于科研质量问题，不要报告。",
  ];
}

export type PublishedFindingClass =
  | "SCIENTIFIC_FINDING"
  | "EVIDENCE_LIMITATION"
  | "SUBMISSION_CHECKLIST"
  | "CONVERSION_ARTIFACT"
  /** M14.9.5：表述 / 排版类意见，没有输入保真 provenance 时无法区分论文原貌与 PDF 转写伪影 */
  | "PRESENTATION_SOURCE_UNDETERMINED";

const DATA_UNAVAILABLE = /(未导入|没有导入|尚未导入|未授权|没有获得.*授权|证据库|无法核验(其)?来源|无可核验|没有可核验|没有可核对|缺少可核对|缺少可核验|原始数据|实验数据|调查数据|来源无法核验|EXTERNAL_VALIDATION_REQUIRED|NOT_INDEPENDENTLY_VERIFIED|cannot be verified|no (imported|experimental) data)/i;
/** 稿内可核对的科研问题信号：出现即按科研 finding 计（即使同时提到缺原始数据） */
const INTERNAL_CHECK = /(矛盾|不一致|不符|对不上|算错|计算(有误|错误)|复算.{0,12}(应为|不|错|差)|方向相反|相反|反转|不匹配|自相矛盾|(合计|分母|百分比).{0,8}(错|不|误)|显著性.{0,8}(错|不|误)|P\s*值.{0,8}(错|不|误)|contradict|inconsistent|mismatch)/i;
/** 投稿元数据（只认字段本身；「排版 / 版式 / 格式」不再据词面归投稿清单——见 PRESENTATION） */
const SUBMISSION = /(作者(信息|简介|署名)|单位信息|基金(信息|号)|Word\s*模板|投稿格式|投稿元数据)/;
/** 表述 / 排版类意见的词面信号：论文原貌还是转写伪影，需要输入保真 provenance 才能判定 */
const PRESENTATION = /(排版|版式|页眉|页脚|著录格式|参考文献格式|格式规范|乱码|断词|连字符|空格|上标|下标|标题.{0,8}(连写|连在一起|粘连|嵌在|没有分隔|未分隔))/;
/** 私用区码位（BMP 私用区 + 补充私用区 A/B）：只可能来自 PDF 字体映射，不是论文正文字符 */
const PRIVATE_USE = /[\uE000-\uF8FF]|[\udb80-\udbff][\udc00-\udfff]/;

/** 只读视图的 finding 归类所用的输入保真 provenance（来自送审前的保真报告；缺省 = 无 provenance） */
export interface ConversionProvenance {
  /** 保真门记录的转写疑点摘录（HEADING_NOT_STRUCTURED / PRIVATE_USE_GLYPH / … 的 excerpt） */
  excerpts: string[];
}

/** 保真报告 → 归类 provenance：只取「转写 / 结构」类 finding 的摘录（删除侧、身份残留不算） */
export function conversionProvenanceFromReport(report: Pick<InputFidelityReport, "findings"> | null | undefined): ConversionProvenance | undefined {
  if (report === null || report === undefined) return undefined;
  const codes = /^(HEADING_|PRIVATE_USE_GLYPH|FURNITURE_HEADING_SPLICE|SENTENCE_SPLIT_BY_BLOCK|LINE_BREAK_HYPHEN_RESIDUE|PARAGRAPH_SPLICE|READING_ORDER_ANOMALY|TABLE_|FORMULA_|INLINE_SCRIPT_FLATTENED|REFERENCE_FRAGMENT|REFERENCE_DUPLICATED_TEXT)/;
  return { excerpts: report.findings.filter((finding) => codes.test(finding.code) && (finding.excerpt ?? "").trim() !== "").map((finding) => finding.excerpt!) };
}

function overlapsProvenance(issue: Pick<ReviewIssue, "quote" | "description">, provenance: ConversionProvenance | undefined): boolean {
  if (provenance === undefined || issue.quote === undefined) return false;
  const quote = canon(issue.quote);
  if (quote.length < 8) return false;
  return provenance.excerpts.some((excerpt) => {
    const own = canon(excerpt);
    if (own.length < 8) return false;
    const probe = quote.slice(0, Math.min(16, quote.length));
    return own.includes(probe) || quote.includes(own.slice(0, Math.min(16, own.length)));
  });
}

/**
 * 已发表论文评估视图中的 finding 归类（确定性；原 issue 不改写）。转写伪影只在有可追溯依据时认定：
 * build 类（被审对象是 PaperTeam 生成的投影 LaTeX），或表述类意见的引文含私用区字形 / 落在保真门记录的转写疑点上；
 * 表述 / 排版类意见没有依据时如实标为来源未确定，不按词面归投稿清单。
 */
export function classifyPublishedFinding(issue: Pick<ReviewIssue, "category" | "description"> & Partial<Pick<ReviewIssue, "quote">>, provenance?: ConversionProvenance): PublishedFindingClass {
  if (issue.category === "build") return "CONVERSION_ARTIFACT";
  const text = issue.description ?? "";
  // 私用区字形只说明被引原文含 PDF 字体映射缺失；只有表述类意见（style）才是在指称这类伪影本身——科研 finding 的引文带字形照常计入
  if (issue.category === "style" && (PRIVATE_USE.test(issue.quote ?? "") || PRIVATE_USE.test(text) || overlapsProvenance(issue, provenance))) return "CONVERSION_ARTIFACT";
  if (SUBMISSION.test(text) && issue.category !== "fact" && !DATA_UNAVAILABLE.test(text)) return "SUBMISSION_CHECKLIST";
  if (INTERNAL_CHECK.test(text)) return "SCIENTIFIC_FINDING";
  if ((issue.category === "evidence_gap" || issue.category === "fact") && DATA_UNAVAILABLE.test(text)) return "EVIDENCE_LIMITATION";
  if (issue.category === "style" && PRESENTATION.test(text)) return "PRESENTATION_SOURCE_UNDETERMINED";
  return "SCIENTIFIC_FINDING";
}

/**
 * 同根因重复分组（只读、保守）：同一篇论文的 critical / major 科研 finding 中，共享 ≥2 个「数值锚点」
 * （带小数 / 百分号、≥3 位有效数字的数，如 0.608、27.6%）的归为一组；在全篇 finding 中出现过于普遍的锚点
 * （≥4 条且超过 25%：总样本量、总患病率之类）不参与。只合并显式共享的数值证据——没有数值的同根因表述不会被合并
 * （分组数是重复的保守下界）。
 */
export function groupByNumericAnchors(
  issues: ReadonlyArray<Pick<ReviewIssue, "description"> & Partial<Pick<ReviewIssue, "quote">>>,
  /** 计算锚点普遍度的全篇 finding（缺省 = issues 本身） */
  context: ReadonlyArray<Pick<ReviewIssue, "description"> & Partial<Pick<ReviewIssue, "quote">>> = issues,
): number[][] {
  const anchorsOf = (issue: Pick<ReviewIssue, "description"> & Partial<Pick<ReviewIssue, "quote">>) => new Set(
    [...`${issue.description} ${issue.quote ?? ""}`.normalize("NFKC").matchAll(/(?<![\d.])(\d+\.\d+|\d{2,}(?:\.\d+)?%)(?![\d.])/g)]
      .map((match) => match[1]!.replace(/%$/, ""))
      .filter((value) => value.replace(/\D/g, "").replace(/^0+/, "").length >= 3),
  );
  const anchorSets = issues.map(anchorsOf);
  const frequency = new Map<string, number>();
  for (const set of context.map(anchorsOf)) for (const anchor of set) frequency.set(anchor, (frequency.get(anchor) ?? 0) + 1);
  const limit = Math.max(3, Math.floor(context.length * 0.25));
  const distinctive = anchorSets.map((set) => new Set([...set].filter((anchor) => (frequency.get(anchor) ?? 0) <= limit)));
  const parent = issues.map((_issue, index) => index);
  const find = (index: number): number => (parent[index] === index ? index : (parent[index] = find(parent[index]!)));
  for (let a = 0; a < issues.length; a += 1) {
    for (let b = a + 1; b < issues.length; b += 1) {
      let shared = 0;
      for (const anchor of distinctive[a]!) if (distinctive[b]!.has(anchor)) shared += 1;
      if (shared >= 2) parent[find(b)] = find(a);
    }
  }
  const groups = new Map<number, number[]>();
  issues.forEach((_issue, index) => groups.set(find(index), [...(groups.get(find(index)) ?? []), index]));
  return [...groups.values()];
}

export type RuleApplicability = "APPLICABLE" | "APPLICABLE_RECOUNTED" | "NOT_EVALUATED" | "NOT_APPLICABLE" | "REPORTED_ONLY";

type VerificationCounts = Record<FindingVerification | "UNSPECIFIED", number>;

export interface PublishedInputFidelitySummary {
  /** 送审前保真门状态（未随项目提供报告 = NOT_PROVIDED） */
  status: InputFidelityReport["status"] | "NOT_PROVIDED";
  reasons: string[];
  attestation: AttestationCheck["verdict"] | "ABSENT";
  attestationReasons: string[];
  /** 保真门状态 × 人工 QA 证明后的有效状态（证明只能把 REQUIRES_HUMAN_QA 升为 VALID_FOR_SCORING） */
  effectiveStatus: InputFidelityReport["status"] | "NOT_PROVIDED";
  note: string;
}

export interface PublishedAssessmentView {
  schema: "paperteam.published-assessment/v2";
  reviewPurpose: "published_paper_assessment";
  round: number;
  /** 审稿是否完成（覆盖账本完整）——不是论文质量结论 */
  reviewCompleted: boolean;
  /** 对第三方已发表论文，作者稿件的 Final / 发表门禁不适用（生产 gate 结果仅原样保留供参考） */
  publicationGate: "PUBLICATION_GATE_NOT_APPLICABLE";
  productionGate: { passed: boolean; reasons: string[]; note: string };
  academicScore: { value: number | null; basis: AcademicScoreBasis | null; calibration: "UNVALIDATED"; note: string };
  scientificFindings: {
    total: number; critical: number; major: number; minor: number; blocking: number;
    /** 按可核验性分列（UNSPECIFIED = 模型未声明，旧产物恒为此值） */
    byVerification: VerificationCounts;
    criticalMajorByVerification: VerificationCounts;
    /** critical / major 科研 finding 的保守重复分组数（≤ critical+major；原始计数不变） */
    criticalMajorRootCauseGroups: number;
  };
  /** 需作者说明 / 外部记录才能判定的科研疑点：不计为已证实错误，也不删除 */
  pendingVerification: { total: number; authorCheckRequired: number; externalDataRequired: number; samples: string[] };
  /** finding 与 rubric 的一致性提示（只读：不改 severity / blocking） */
  rubricConsistency: Record<Exclude<RubricFlag, "VERIFICATION_UNSPECIFIED">, number> & { verificationUnspecified: number };
  rootCauseGroups: { method: string; groups: Array<{ findingIndices: number[] }> };
  evidenceLimitations: { total: number; label: "PAPER_REPORTED / NOT_INDEPENDENTLY_VERIFIED"; samples: string[] };
  submissionChecklist: { total: number; note: string };
  conversionArtifacts: { total: number; note: string };
  presentationUndetermined: { total: number; note: string };
  inputFidelity: PublishedInputFidelitySummary;
  ruleApplicability: Array<{ rule: string; productionPassed: boolean; applicability: RuleApplicability; note: string }>;
  notEvaluated: Array<{ item: string; reason: string }>;
  findings: Array<{
    index: number; class: PublishedFindingClass; severity: string; category: string; section: string; blocking: boolean;
    verification: FindingVerification | "UNSPECIFIED"; rubricFlags: RubricFlag[]; rootCauseGroup: number | null; description: string;
  }>;
}

export interface PublishedAssessmentInput {
  gate: QualityGateResult;
  review: ReviewSummary;
  /** citation.verify 是否产出过引用核验报告 */
  citationReportAvailable: boolean;
  /** 项目证据库记录数（0 = 没有任何证据记录，证据类规则只能 NOT_EVALUATED） */
  evidenceRecords: number;
  feasibilityEvaluated: boolean;
  /** M14.9.5：送审前输入保真报告（随项目提供时）与人工 QA 证明的校验结果 */
  inputFidelity?: { report: InputFidelityReport; attestation: AttestationCheck | null } | null;
}

function verificationCounts(issues: readonly ReviewIssue[]): VerificationCounts {
  const counts: VerificationCounts = { VERIFIED_IN_TEXT: 0, AUTHOR_CHECK_REQUIRED: 0, EXTERNAL_DATA_REQUIRED: 0, UNSPECIFIED: 0 };
  for (const issue of issues) counts[issue.verification ?? "UNSPECIFIED"] += 1;
  return counts;
}

function inputFidelitySummary(input: PublishedAssessmentInput["inputFidelity"]): PublishedInputFidelitySummary {
  if (input === undefined || input === null) {
    return {
      status: "NOT_PROVIDED", reasons: [], attestation: "ABSENT", attestationReasons: [], effectiveStatus: "NOT_PROVIDED",
      note: "项目未随附送审前输入保真报告：转写保真未经本视图核验，表述 / 排版类意见的来源只能标为未确定",
    };
  }
  const { report, attestation } = input;
  return {
    status: report.status,
    reasons: report.reasons,
    attestation: attestation?.verdict ?? "ABSENT",
    attestationReasons: attestation?.reasons ?? [],
    effectiveStatus: attestation?.effectiveStatus ?? report.status,
    note: report.status === "REQUIRES_HUMAN_QA" && attestation?.verdict !== "VALID"
      ? "保真门要求人工 QA 而没有有效的哈希绑定 QA 证明：全篇定量评分不可信，结果仅作带范围说明的只读审阅"
      : "有效状态 = 自动保真门判定（REQUIRES_HUMAN_QA 仅可由与源 / 稿哈希绑定且逐项覆盖的人工 QA 证明升级）",
  };
}

/** 生产 Gate 结果 → 只读评估视图（不改 gate 本身；每条规则标明对第三方论文的适用性） */
export function buildPublishedAssessmentView(input: PublishedAssessmentInput): PublishedAssessmentView {
  const { gate, review } = input;
  const provenance = conversionProvenanceFromReport(input.inputFidelity?.report);
  const classified = review.issues.map((issue, index) => ({ issue, index, cls: classifyPublishedFinding(issue, provenance) }));
  const scientific = classified.filter((entry) => entry.cls === "SCIENTIFIC_FINDING");
  const limitations = classified.filter((entry) => entry.cls === "EVIDENCE_LIMITATION").map((entry) => entry.issue);
  const count = (severity: string) => scientific.filter((entry) => entry.issue.severity === severity).length;
  const criticalMajor = scientific.filter((entry) => entry.issue.severity !== "minor");
  const groups = groupByNumericAnchors(criticalMajor.map((entry) => entry.issue), review.issues);
  const groupOf = new Map<number, number>();
  const multiGroups = groups.filter((members) => members.length >= 2);
  multiGroups.forEach((members, groupIndex) => members.forEach((member) => groupOf.set(criticalMajor[member]!.index, groupIndex)));
  const pending = scientific.filter((entry) => entry.issue.verification === "AUTHOR_CHECK_REQUIRED" || entry.issue.verification === "EXTERNAL_DATA_REQUIRED").map((entry) => entry.issue);
  const flagsOf = new Map(classified.map((entry) => [entry.index, entry.cls === "SCIENTIFIC_FINDING" ? rubricFlags(entry.issue) : []]));
  const flagCount = (flag: RubricFlag) => [...flagsOf.values()].filter((flags) => flags.includes(flag)).length;
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
        return { applicability: "APPLICABLE_RECOUNTED", note: "只读视图按科研 finding 重新计数（证据可得性限制 / 投稿清单 / 转写伪影 / 来源未确定的表述意见单列；待核验疑点另列）；生产规则判定原样保留" };
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
  const basis = review.academicScoreBasis ?? null;
  return {
    schema: "paperteam.published-assessment/v2",
    reviewPurpose: "published_paper_assessment",
    round: review.round,
    reviewCompleted: review.coverage?.complete ?? true,
    publicationGate: "PUBLICATION_GATE_NOT_APPLICABLE",
    productionGate: { passed: gate.passed, reasons: gate.reasons, note: "生产 Quality Gate 按作者稿件口径原样执行（规则与阈值未改）；对第三方已发表论文仅供参考，不是发表 / 录用判定" },
    academicScore: {
      value: review.scores.academicScore,
      basis,
      calibration: "UNVALIDATED",
      note: `${basis?.mode === "units_char_weighted" ? "长文档单元分的字符加权聚合（每单元一个总分，无独立维度校准）" : basis !== null ? "整稿 digest 维度评分" : "评分口径未记录（旧产物）"}；未经外部质量金标准校准，不代表期刊等级、质量百分位或录用概率`,
    },
    scientificFindings: {
      total: scientific.length, critical: count("critical"), major: count("major"), minor: count("minor"),
      blocking: scientific.filter((entry) => entry.issue.blocking).length,
      byVerification: verificationCounts(scientific.map((entry) => entry.issue)),
      criticalMajorByVerification: verificationCounts(criticalMajor.map((entry) => entry.issue)),
      criticalMajorRootCauseGroups: groups.length,
    },
    pendingVerification: {
      total: pending.length,
      authorCheckRequired: pending.filter((issue) => issue.verification === "AUTHOR_CHECK_REQUIRED").length,
      externalDataRequired: pending.filter((issue) => issue.verification === "EXTERNAL_DATA_REQUIRED").length,
      samples: pending.slice(0, 5).map((issue) => issue.description.slice(0, 120)),
    },
    rubricConsistency: {
      BLOCKING_WITHOUT_TEXT_VERIFICATION: flagCount("BLOCKING_WITHOUT_TEXT_VERIFICATION"),
      CRITICAL_NOT_TEXT_VERIFIED: flagCount("CRITICAL_NOT_TEXT_VERIFIED"),
      verificationUnspecified: flagCount("VERIFICATION_UNSPECIFIED"),
    },
    rootCauseGroups: {
      method: "critical / major 科研 finding 共享 ≥2 个非高频数值锚点即同组（保守下界：无数值的同根因表述不合并）；原始 findings 与计数不变",
      groups: multiGroups.map((members) => ({ findingIndices: members.map((member) => criticalMajor[member]!.index) })),
    },
    evidenceLimitations: { total: limitations.length, label: "PAPER_REPORTED / NOT_INDEPENDENTLY_VERIFIED", samples: limitations.slice(0, 5).map((issue) => issue.description.slice(0, 120)) },
    submissionChecklist: { total: classified.filter((entry) => entry.cls === "SUBMISSION_CHECKLIST").length, note: "投稿元数据类意见不计入科研 finding" },
    conversionArtifacts: { total: classified.filter((entry) => entry.cls === "CONVERSION_ARTIFACT").length, note: "有可追溯依据（build 类 / 私用区字形 / 保真门记录的转写疑点）的转写伪影，不计入论文科研 finding" },
    presentationUndetermined: { total: classified.filter((entry) => entry.cls === "PRESENTATION_SOURCE_UNDETERMINED").length, note: "表述 / 排版类意见：没有输入保真依据时无法区分论文原貌与转写伪影，单列不计入科研 finding" },
    inputFidelity: inputFidelitySummary(input.inputFidelity),
    ruleApplicability: gate.rules.map((rule) => ({ rule: rule.rule, productionPassed: rule.passed, ...applicability(rule.rule) })),
    notEvaluated: [
      ...(input.citationReportAvailable ? [] : [{ item: "citation_verification", reason: "未执行 citation.verify（引用真实性 / 元数据 / 语义支撑）" }]),
      { item: "experiment_reproduction", reason: "未取得论文原始数据，未做实验复算 / 复现；论文自报数值仅做稿内一致性核查" },
      ...(input.feasibilityEvaluated ? [] : [{ item: "target_feasibility", reason: "未执行可行性评估" }]),
      { item: "build_gate", reason: "只读评估不编译投稿稿件" },
      ...(input.evidenceRecords > 0 ? [] : [{ item: "evidence_grounding", reason: "项目证据库为空" }]),
      { item: "score_calibration", reason: "学术分没有经过外部质量金标准校准（UNVALIDATED）" },
      // M14.9.5.1：单元上下文——共享会话下跨单元依赖是否可见不可复现；隔离快照下的依赖缺口逐条列为未执行的核对
      ...(unitMode && review.coverage?.context === undefined
        ? [{ item: "unit_context_reproducibility", reason: "长文档单元共用一个审稿会话（shared_session）：单元能否看到其他单元的表格取决于调度顺序与超时重建，跨单元核对不可复现" }]
        : []),
      ...(review.coverage?.context?.contextIncompleteUnits ?? []).flatMap((entry) => entry.gaps.map((gap) => ({
        item: `cross_unit_reference:${entry.unitId}:${gap.mention}`,
        reason: `${gap.status}（BLOCKED_BY_CONTEXT）：${gap.reason}；该单元对此对象的跨单元核对未执行`,
      }))),
    ],
    findings: classified.map(({ issue, index, cls }) => ({
      index, class: cls, severity: issue.severity, category: issue.category, section: issue.section, blocking: issue.blocking,
      verification: issue.verification ?? "UNSPECIFIED", rubricFlags: flagsOf.get(index) ?? [], rootCauseGroup: groupOf.get(index) ?? null,
      description: issue.description,
    })),
  };
}
