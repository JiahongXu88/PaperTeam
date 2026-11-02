/**
 * JournalAssessment（journal-assessment/v1）：论文 × 目标期刊的分块评估（纯函数）。
 *
 * 四块：
 *   A criteria       官方投稿要求逐条（SATISFIED / VIOLATED / NOT_EVALUATED / NOT_APPLICABLE）
 *   B riskFindings   复用分层 QualityReport L0–L3 + 期刊 rubric（模型意见）+ 保真度缺口
 *   C fitEvidence    稿型受理（官方明文）/ 范围（模型意见）/ 近期发表论文参照（POSITIVE_ONLY_REFERENCE）
 *   D summary        五态结论（见 decideVerdict），外部效度恒 EXTERNAL_CALIBRATION_NOT_VALIDATED
 *
 * 与 QualityReport 的唯一关系（契约见 docs/research/M15_TARGET_JOURNAL_ASSESSMENT_ARCHITECTURE.md）：
 * - 只读 QualityReport，从不写 gate、不产生任何 passed 布尔；Finalize / gate.passed 语义零变化；
 * - L0 / L1 / L3 的 FAIL（已证实缺陷 / 修订闭环失败）直接给 BLOCKED_BY_VERIFIED_ISSUE，
 *   模型意见（L2 / rubric）不能把它抵消，也不能把结论升级为 READY；
 * - 不输出录用概率、分数档位或「达到某刊水平」（HISTORICAL_DECISION_PREDICTION 恒 DISABLED）。
 */
import { createHash } from "node:crypto";

import type { QualityReport, QualityReportItem } from "../../quality/qualityReport.js";
import type { TargetRubricArtifact } from "../TargetRubricService.js";
import type { JournalCriterion, EvidenceLevel } from "./criteria.js";
import type { JournalFacts } from "./journalFacts.js";
import type { JournalArticleType, JournalProfile, JournalProfileVerificationStatus } from "./profileTypes.js";

export const JOURNAL_ASSESSMENT_SCHEMA_VERSION = "journal-assessment/v1" as const;

export type JournalAssessmentVerdict =
  | "READY_FOR_AUTHOR_SUBMISSION_REVIEW"
  | "CHANGES_REQUIRED"
  | "BLOCKED_BY_VERIFIED_ISSUE"
  | "INSUFFICIENT_EVIDENCE"
  | "JOURNAL_PROFILE_UNVERIFIED";

export interface RiskFinding {
  findingId: string;
  source: "quality_report" | "journal_rubric" | "fidelity" | "article_type_heuristic";
  category: string;
  title: string;
  evidenceLevel: EvidenceLevel;
  /** 是否影响结论（模型意见恒 false） */
  affectsVerdict: boolean;
  detail: string;
  location: string;
  suggestion: string;
  evidenceQuotes?: string[];
  qualityLayer?: string;
  reasonCode?: string;
}

export interface FitEvidence {
  fitId: string;
  aspect: "article_type" | "scope" | "language" | "recent_publications";
  status: "MATCH" | "VERIFIED_MISMATCH" | "OBSERVED_DIFFERENCE" | "MODEL_OPINION" | "UNASSESSED";
  evidenceLevel: EvidenceLevel;
  detail: string;
  sourceUrl?: string;
  /** 已发表论文只能做正向参照：恒 POSITIVE_ONLY_REFERENCE（不是负例，不是隐含硬阈值） */
  referenceKind?: "POSITIVE_ONLY_REFERENCE";
}

export interface JournalAssessment {
  schemaVersion: typeof JOURNAL_ASSESSMENT_SCHEMA_VERSION;
  assessmentId: string;
  projectId: string;
  generatedAt: string;
  articleType: JournalArticleType;
  manuscript: { revision: number | null; revisionHash: string; fidelity: JournalFacts["fidelity"]; fileCount: number };
  journal: {
    journalId: string | null;
    displayName: string;
    query: { journalId?: string; name?: string; issn?: string };
    profileHash: string | null;
    rulesVersion: string | null;
    verification: { status: JournalProfileVerificationStatus; verifiedAt: string | null; ageDays: number | null; trusted: boolean; note: string };
    sourcePages: Array<{ url: string; role: string; sha256: string }>;
    indexing: JournalProfile["indexing"];
    scope: JournalProfile["scope"] | null;
  };
  criteria: JournalCriterion[];
  riskFindings: RiskFinding[];
  subjectiveEstimates: Array<{ dimension: string; verdict: string; evidenceQuotes: string[]; needsExpertReview: boolean }>;
  fitEvidence: FitEvidence[];
  summary: {
    verdict: JournalAssessmentVerdict;
    statement: string;
    reasons: string[];
    /** 可观察要求达标比率（分母 = 已判定的 hard_deterministic 条目；不含未知与主观项） */
    observableRequirements: { satisfied: number; violated: number; denominator: number; notEvaluated: number; notApplicable: number; authorCheck: number; advisory: number };
    authorChecks: string[];
    unknowns: string[];
  };
  capabilities: {
    SUBMISSION_REQUIREMENTS_CHECKED: "ENABLED" | "NO_PROFILE";
    EVIDENCE_GROUNDED_QUALITY_RISKS: "ENABLED" | "NO_QUALITY_REPORT" | "STALE_QUALITY_REPORT";
    SUBJECTIVE_QUALITY_ESTIMATE: "MODEL_OPINION_UNCALIBRATED" | "NOT_RUN";
    HISTORICAL_DECISION_PREDICTION: "DISABLED_NO_VALIDATED_DATA";
  };
  uncertainty: string[];
  externalValidity: {
    status: "EXTERNAL_CALIBRATION_NOT_VALIDATED";
    independentHumanLabels: 0;
    benchmarkProvenance: string;
    statement: string;
  };
  inputs: {
    qualityReport: { round: number | null; reviewedRevision: number | null; overall: string | null; fresh: boolean } | null;
    rubric: { evaluatedAt: string; model?: string; fresh: boolean; promptVersion: string } | null;
    benchmark: BenchmarkReferenceInput | null;
  };
  runId: string | null;
}

export interface BenchmarkReferenceInput {
  venueMatchesJournal: boolean;
  corpusSize: number;
  sufficiency: string;
  overall?: string;
  dimensions: Array<{ dimension: string; band: string; observed: string }>;
}

export interface BuildAssessmentInput {
  projectId: string;
  now: Date;
  articleType: JournalArticleType;
  query: { journalId?: string; name?: string; issn?: string };
  profile: JournalProfile | null;
  profileHash: string | null;
  trust: JournalAssessment["journal"]["verification"];
  criteria: JournalCriterion[];
  facts: JournalFacts;
  manuscriptRevision: number | null;
  qualityReport: { report: QualityReport; round: number } | null;
  rubric: TargetRubricArtifact | null;
  rubricFresh: boolean;
  benchmark: BenchmarkReferenceInput | null;
  runId?: string | null;
}

export function manuscriptRevisionHash(files: ReadonlyArray<{ path: string; content: string }>): string {
  const hash = createHash("sha256");
  for (const file of files) hash.update(`${file.path}\u0000${file.content}\u0000`);
  return hash.digest("hex");
}

/**
 * M16：模型 rubric 的正向维度判断（STRONG / ADEQUATE）在外部基准上系统性偏正向——
 * SurveyReview 正负平衡新样本（22 个维度）中审稿人判负的维度只有 27% 被模型判负、balanced accuracy 0.64；
 * M15 D3（25 个维度）为 0.55。正向判断因此不能被读成「达到该刊学术要求」（仅展示限定，不影响任何结论）。
 */
export const POSITIVE_RUBRIC_CAVEAT =
  "模型对主观维度给出的正向判断（STRONG / ADEQUATE）不表示达到该刊学术要求：在公开审稿基准上，同类模型的维度打分系统性偏正向（审稿人判为负面的维度只有约 27% 被模型判负，M16 平衡新样本 22 个维度），需作者 / 专家复核。";

export function buildJournalAssessment(input: BuildAssessmentInput): JournalAssessment {
  const revisionHash = manuscriptRevisionHash(input.facts.manuscriptFiles);
  const qr = input.qualityReport;
  const qrFresh = qr !== null && qr.report.binding.reviewedRevision !== null && input.manuscriptRevision !== null && qr.report.binding.reviewedRevision === input.manuscriptRevision;
  const risks: RiskFinding[] = [];

  // ---- B：分层 QualityReport（只读复用）----
  if (qr === null) {
    risks.push({ findingId: "qr:missing", source: "quality_report", category: "quality_report", title: "尚无质量门禁结果", evidenceLevel: "unassessed", affectsVerdict: true, detail: "论证 / 数值一致性 / 引用 / 修订闭环均未评估", location: "—", suggestion: "先运行审稿与质量门禁（工作流或「重新评估」）后再生成期刊评估。" });
  } else {
    if (!qrFresh) {
      risks.push({ findingId: "qr:stale", source: "quality_report", category: "quality_report", title: "质量门禁结果与当前稿件版本不一致", evidenceLevel: "unassessed", affectsVerdict: true, detail: `门禁审查的是修订 ${qr.report.binding.reviewedRevision ?? "未知"}，当前稿件为修订 ${input.manuscriptRevision ?? "未知"}`, location: "—", suggestion: "对当前版本重新运行审稿与质量门禁。" });
    }
    for (const layerId of ["L0", "L1", "L2", "L3"] as const) {
      for (const item of qr.report.layers[layerId].items) {
        if (item.status === "PASS" || item.status === "NOT_APPLICABLE") continue;
        if (item.status === "NOT_EVALUATED" && !item.required) continue;
        risks.push(riskFromQualityItem(item, qrFresh));
      }
    }
  }

  // ---- B：保真度缺口（不假称审阅了图表）----
  if (input.facts.fidelity === "pdf") {
    risks.push({ findingId: "fidelity:pdf", source: "fidelity", category: "figures_tables", title: "PDF-only 稿件：图表与版式未被识别", evidenceLevel: "unassessed", affectsVerdict: false, detail: "只从 PDF 解析了参考文献；图、表、公式与版式类要求未审阅", location: "PDF", suggestion: "导入 LaTeX 源码以检查题目 / 摘要 / 章节类要求；图表质量需作者对照官方要求自检。" });
  } else if (input.facts.fidelity === "latex" && (input.facts.figureCount ?? 0) + (input.facts.tableCount ?? 0) > 0) {
    risks.push({ findingId: "fidelity:figures", source: "fidelity", category: "figures_tables", title: "图表视觉质量未审阅", evidenceLevel: "unassessed", affectsVerdict: false, detail: `检出 ${input.facts.figureCount} 个图环境、${input.facts.tableCount} 个表环境；系统未读取图像像素或编译后版式`, location: "figure / table 环境", suggestion: "分辨率、三线表、图题等版式要求请作者对照期刊要求自检。" });
  }
  if (input.articleType === "research" && input.facts.fidelity === "latex" && (input.facts.figureCount ?? 0) === 0 && (input.facts.tableCount ?? 0) === 0) {
    risks.push({ findingId: "heuristic:no-experiment-artifacts", source: "article_type_heuristic", category: "experimental_evidence", title: "研究论文未检出任何图表", evidenceLevel: "author-check", affectsVerdict: false, detail: "研究论文通常以表格 / 图展示实验结果；稿件中没有任何 figure / table 环境", location: "全文", suggestion: "确认实验结果是否已完整报告；系统不代为生成实验或数据。" });
  }

  // ---- B：期刊 rubric（模型意见，未校准，永不影响结论）----
  const subjective: JournalAssessment["subjectiveEstimates"] = [];
  const rubric = input.rubricFresh ? input.rubric : null;
  if (rubric !== null) {
    for (const dimension of rubric.dimensions) {
      subjective.push({ dimension: dimension.dimension, verdict: dimension.verdict, evidenceQuotes: dimension.evidenceQuotes, needsExpertReview: dimension.needsExpertReview });
      if (dimension.verdict === "WEAK" || dimension.verdict === "INSUFFICIENT_EVIDENCE") {
        risks.push({
          findingId: `rubric:${dimension.dimension}`,
          source: "journal_rubric",
          category: dimension.dimension,
          title: `模型意见：${dimension.dimension} = ${dimension.verdict}`,
          evidenceLevel: dimension.verdict === "WEAK" ? "model-opinion" : "unassessed",
          affectsVerdict: false,
          detail: dimension.gaps.join("；") || "（模型未给出具体缺口）",
          location: dimension.evidenceQuotes.length > 0 ? "见引文" : "未定位",
          suggestion: "模型意见需作者 / 专家复核后才可采纳；不构成已证实缺陷。",
          evidenceQuotes: dimension.evidenceQuotes,
        });
      }
    }
  }

  // ---- C：期刊匹配 ----
  const fit: FitEvidence[] = [];
  const typeCriterion = input.criteria.find((criterion) => criterion.category === "article_type");
  if (typeCriterion !== undefined) {
    fit.push({
      fitId: "fit:article-type",
      aspect: "article_type",
      status: typeCriterion.status === "SATISFIED" ? "MATCH" : typeCriterion.status === "VIOLATED" ? "VERIFIED_MISMATCH" : "UNASSESSED",
      evidenceLevel: typeCriterion.evidenceLevel,
      detail: `${typeCriterion.observed}；${typeCriterion.expected}${typeCriterion.why ? `（${typeCriterion.why}）` : ""}`,
      sourceUrl: typeCriterion.sourceUrl,
    });
  }
  const languageCriterion = input.criteria.find((criterion) => criterion.ruleId.endsWith("language-en"));
  if (languageCriterion !== undefined && languageCriterion.status !== "NOT_APPLICABLE") {
    fit.push({ fitId: "fit:language", aspect: "language", status: languageCriterion.status === "SATISFIED" ? "MATCH" : languageCriterion.status === "VIOLATED" ? "VERIFIED_MISMATCH" : "UNASSESSED", evidenceLevel: languageCriterion.evidenceLevel, detail: languageCriterion.observed, sourceUrl: languageCriterion.sourceUrl });
  }
  if (rubric !== null) {
    fit.push({
      fitId: "fit:scope",
      aspect: "scope",
      status: "MODEL_OPINION",
      evidenceLevel: "model-opinion",
      detail: `模型判断 inScope=${String(rubric.scopeRelevance.inScope)}${rubric.scopeRelevance.columnMatch ? `（栏目：${rubric.scopeRelevance.columnMatch}）` : ""}：${rubric.scopeRelevance.evidence}`,
      ...(input.profile !== null ? { sourceUrl: input.profile.scope.sourceUrl } : {}),
    });
  } else {
    fit.push({ fitId: "fit:scope", aspect: "scope", status: "UNASSESSED", evidenceLevel: "unassessed", detail: "主题范围匹配需要模型意见（本次未运行或已过期）；官方范围陈述见期刊信息", ...(input.profile !== null ? { sourceUrl: input.profile.scope.sourceUrl } : {}) });
  }
  if (input.benchmark !== null && input.benchmark.venueMatchesJournal) {
    fit.push({
      fitId: "fit:recent-publications",
      aspect: "recent_publications",
      status: "OBSERVED_DIFFERENCE",
      evidenceLevel: "unassessed",
      referenceKind: "POSITIVE_ONLY_REFERENCE",
      detail: `近期发表论文参照 ${input.benchmark.corpusSize} 篇（${input.benchmark.sufficiency}）${input.benchmark.overall ? `；观测带对照：${input.benchmark.overall}` : ""}。${input.benchmark.dimensions.map((d) => `${d.dimension}：${clip(d.observed, 60)}（${clip(d.band, 60)}）`).join("；")}。只含已发表（成功）稿件，存在幸存者偏差：观测带不是最低录用标准，也不能当负例。`,
    });
  } else {
    fit.push({ fitId: "fit:recent-publications", aspect: "recent_publications", status: "UNASSESSED", evidenceLevel: "unassessed", referenceKind: "POSITIVE_ONLY_REFERENCE", detail: input.benchmark !== null ? "已有的近期论文参照不是本期刊（venue 不匹配），未使用" : "尚未建立该刊近期代表论文参照（可在「目标参照」中发现并冻结）" });
  }

  // ---- D：结论 ----
  const decision = decideVerdict(input, risks, qrFresh);
  const hard = input.criteria.filter((criterion) => criterion.kind === "hard_deterministic" || criterion.kind === "article_type");
  const satisfied = hard.filter((c) => c.status === "SATISFIED").length;
  const violated = hard.filter((c) => c.status === "VIOLATED").length;
  const observable = {
    satisfied,
    violated,
    denominator: satisfied + violated,
    notEvaluated: hard.filter((c) => c.status === "NOT_EVALUATED").length,
    notApplicable: input.criteria.filter((c) => c.status === "NOT_APPLICABLE").length,
    authorCheck: input.criteria.filter((c) => c.kind === "evidence_based" && c.status !== "NOT_APPLICABLE").length,
    advisory: input.criteria.filter((c) => c.kind === "advisory" && c.status !== "NOT_APPLICABLE").length,
  };
  const authorChecks = input.criteria.filter((c) => c.evidenceLevel === "author-check" && c.status !== "SATISFIED").map((c) => `${c.title}：${c.gap ?? c.why}`);
  const unknowns = input.criteria.filter((c) => c.status === "NOT_EVALUATED" && c.evidenceLevel === "unassessed").map((c) => `${c.title}：${c.gap ?? c.why}`);

  const generatedAt = input.now.toISOString();
  const assessmentId = `ja-${createHash("sha256").update(`${input.projectId}|${generatedAt}|${input.profileHash ?? "none"}|${revisionHash}|${input.articleType}`).digest("hex").slice(0, 12)}`;
  return {
    schemaVersion: JOURNAL_ASSESSMENT_SCHEMA_VERSION,
    assessmentId,
    projectId: input.projectId,
    generatedAt,
    articleType: input.articleType,
    manuscript: { revision: input.manuscriptRevision, revisionHash, fidelity: input.facts.fidelity, fileCount: input.facts.manuscriptFiles.length },
    journal: {
      journalId: input.profile?.journalId ?? null,
      displayName: input.profile !== null ? (input.profile.identity.nameZh ?? input.profile.identity.nameEn ?? input.profile.journalId) : (input.query.name ?? input.query.issn ?? input.query.journalId ?? "（未指定）"),
      query: input.query,
      profileHash: input.profileHash,
      rulesVersion: input.profile?.rulesVersion ?? null,
      verification: input.trust,
      sourcePages: input.profile?.source.pages ?? [],
      indexing: input.profile?.indexing ?? [],
      scope: input.profile?.scope ?? null,
    },
    criteria: input.criteria,
    riskFindings: risks,
    subjectiveEstimates: subjective,
    fitEvidence: fit,
    summary: { verdict: decision.verdict, statement: decision.statement, reasons: decision.reasons, observableRequirements: observable, authorChecks, unknowns },
    capabilities: {
      SUBMISSION_REQUIREMENTS_CHECKED: input.profile !== null ? "ENABLED" : "NO_PROFILE",
      EVIDENCE_GROUNDED_QUALITY_RISKS: qr === null ? "NO_QUALITY_REPORT" : qrFresh ? "ENABLED" : "STALE_QUALITY_REPORT",
      SUBJECTIVE_QUALITY_ESTIMATE: rubric !== null ? "MODEL_OPINION_UNCALIBRATED" : "NOT_RUN",
      HISTORICAL_DECISION_PREDICTION: "DISABLED_NO_VALIDATED_DATA",
    },
    uncertainty: [
      "不预测录用：没有该刊的投稿记录与已确认拒稿负样本，录用概率预测禁用。",
      "已发表论文只作正向参照（幸存者偏差），不是负例，也不是隐含的硬质量阈值。",
      "创新性、价值与贡献等主观维度只有模型意见，未经独立人类校准。",
      ...(subjective.some((d) => d.verdict === "STRONG" || d.verdict === "ADEQUATE") ? [POSITIVE_RUBRIC_CAVEAT] : []),
      ...(input.facts.fidelity !== "latex" ? ["稿件不是 LaTeX 源码：大部分格式类要求无法确定性检查。"] : []),
      ...(input.trust.status === "VERIFIED_SNAPSHOT" ? [`期刊规则来自 ${input.trust.verifiedAt?.slice(0, 10)} 的官方页面快照，不是即时规则；可点「在线复核来源」。`] : []),
    ],
    externalValidity: {
      status: "EXTERNAL_CALIBRATION_NOT_VALIDATED",
      independentHumanLabels: 0,
      benchmarkProvenance: "M15 Target Journal Assessment 外部参考评测（docs/research/M15_TARGET_JOURNAL_ASSESSMENT_ACCEPTANCE.md §5）与 M16 审稿有效性复测（docs/research/M16_REVIEW_VALIDITY_FINAL.md）：只覆盖规则检查器在真实已发表论文上的误报、英文公开评审的意见对齐与维度打分偏差，不构成期刊级质量校准",
      statement: "本评估检查可观察且可核验的投稿要求与已证实缺陷；不代表达到该刊学术标准，也不预测录用。",
    },
    inputs: {
      qualityReport: qr !== null ? { round: qr.round, reviewedRevision: qr.report.binding.reviewedRevision, overall: qr.report.overall.status, fresh: qrFresh } : null,
      rubric: input.rubric !== null ? { evaluatedAt: input.rubric.evaluatedAt, ...(input.rubric.model !== undefined ? { model: input.rubric.model } : {}), fresh: input.rubricFresh, promptVersion: input.rubric.promptVersion } : null,
      benchmark: input.benchmark,
    },
    runId: input.runId ?? null,
  };
}

function riskFromQualityItem(item: QualityReportItem, fresh: boolean): RiskFinding {
  const verifiedGrades = new Set(["deterministic", "author_data_recomputed", "metadata_lookup", "verified_evidence", "edit_contract", "unclassified"]);
  const evidenceLevel: EvidenceLevel =
    item.status === "FAIL" && verifiedGrades.has(item.evidenceGrade)
      ? "verified"
      : item.status === "NEEDS_AUTHOR_DECISION" || item.evidenceGrade === "author_decision"
        ? "author-check"
        : item.status === "NEEDS_VERIFICATION" || item.evidenceGrade === "llm_judgment" || item.evidenceGrade === "uncalibrated_score"
          ? "model-opinion"
          : "unassessed";
  return {
    findingId: `qr:${item.layer}:${item.id}`,
    source: "quality_report",
    category: item.layer,
    qualityLayer: item.layer,
    title: `${item.layer} ${item.id}（${item.status}）`,
    evidenceLevel,
    affectsVerdict: fresh && (evidenceLevel === "verified" || item.status === "NEEDS_VERIFICATION" || (item.status === "NOT_EVALUATED" && item.required)),
    detail: item.detail,
    location: "见质量门禁对应条目",
    suggestion:
      evidenceLevel === "verified"
        ? "已证实问题：必须修复（期刊评估不会被模型意见抵消）。"
        : evidenceLevel === "model-opinion"
          ? "模型提出的问题需核验后决定是否修改。"
          : evidenceLevel === "author-check"
            ? "需要作者裁决（如数值修改逐项批准）。"
            : "该项未评估：补齐输入后重新评估。",
    ...(item.reasonCode !== undefined ? { reasonCode: item.reasonCode } : {}),
  };
}

function decideVerdict(input: BuildAssessmentInput, risks: RiskFinding[], qrFresh: boolean): { verdict: JournalAssessmentVerdict; statement: string; reasons: string[] } {
  const qr = input.qualityReport;
  const verifiedQr = qrFresh ? risks.filter((risk) => risk.source === "quality_report" && risk.evidenceLevel === "verified" && risk.qualityLayer !== "L2") : [];
  if (verifiedQr.length > 0) {
    return { verdict: "BLOCKED_BY_VERIFIED_ISSUE", statement: "质量门禁中存在已证实的缺陷（完整性 / 事实 / 修订闭环），先修复再考虑投稿。", reasons: verifiedQr.map((risk) => risk.title) };
  }
  if (input.profile === null || !input.trust.trusted) {
    return {
      verdict: "JOURNAL_PROFILE_UNVERIFIED",
      statement: input.profile === null ? "该期刊没有经官方来源核实的规则库：不能判断投稿要求是否满足。" : `期刊规则来源未通过验证（${input.trust.status}）：不能把旧规则当作现行官方要求。`,
      reasons: [input.profile === null ? "未找到可信期刊 profile（可提供官方投稿须知链接与规则，经原句回放后使用）" : input.trust.note],
    };
  }
  const blockingViolations = input.criteria.filter((c) => c.status === "VIOLATED" && c.blocking && c.evidenceLevel === "verified");
  if (blockingViolations.length > 0) {
    return { verdict: "BLOCKED_BY_VERIFIED_ISSUE", statement: "稿件违反目标期刊官方明文的必需要求（见 A / C 块逐条依据）。", reasons: blockingViolations.map((c) => `${c.title}：${c.observed}`) };
  }
  const insufficient: string[] = [];
  if (input.facts.fidelity === "none") insufficient.push("没有可观测的稿件内容");
  if (qr === null) insufficient.push("尚无质量门禁结果");
  else if (!qrFresh) insufficient.push("质量门禁结果不对应当前稿件版本");
  else if (qr.report.overall.status === "NOT_EVALUATED") insufficient.push(`质量门禁存在必需未评估项：${qr.report.overall.unknowns.slice(0, 3).join("；") || qr.report.overall.reasons.slice(0, 3).join("；")}`);
  const hardUnknown = input.criteria.filter((c) => c.kind === "hard_deterministic" && c.blocking && c.status === "NOT_EVALUATED");
  if (hardUnknown.length > 0) insufficient.push(`必需的可检查要求未能评估：${hardUnknown.map((c) => c.title).join("、")}`);
  if (input.criteria.some((c) => c.category === "article_type" && c.status === "NOT_EVALUATED")) insufficient.push("稿型是否被受理未写明");
  if (insufficient.length > 0) {
    return { verdict: "INSUFFICIENT_EVIDENCE", statement: "关键输入缺失或无法确定性检查：当前证据不足以给出投稿准备结论。", reasons: insufficient };
  }
  const changes = [
    ...input.criteria.filter((c) => c.status === "VIOLATED").map((c) => `${c.title}：${c.observed}`),
    ...(qr !== null && qr.report.overall.status === "NEEDS_VERIFICATION" ? ["质量门禁中有模型提出、尚待核验的阻断性意见"] : []),
  ];
  if (changes.length > 0) {
    return { verdict: "CHANGES_REQUIRED", statement: "没有已证实的阻断问题，但存在不符合官方要求的条目或待核验意见，建议修改后再自查。", reasons: changes };
  }
  return {
    verdict: "READY_FOR_AUTHOR_SUBMISSION_REVIEW",
    statement: "所有可检查的官方必需要求已检查且无阻断；请作者完成需人工确认的条目后自行决定投稿。这不是录用判断。",
    reasons: ["可检查的必需要求全部满足；已证实缺陷 0"],
  };
}

/** 展示截断（C 块参照摘要只给要点；完整观测带见「目标参照」页） */
function clip(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
