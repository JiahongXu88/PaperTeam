/**
 * Workflow 定义。
 *
 * 两条一级工作流共享后段（D-0010）：
 *
 *   Idea-to-Paper 前段：
 *     research.idea → evidence.ground → research.feasibility → HITL(feasibility: approve/adjust/cancel)
 *     → outline.plan → HITL(outline: approve/revise/cancel)
 *     → HITL(evidence_supply: continue/cancel；M9.7.4 条件出现——待审候选 ≥3，
 *       只提示不自动 promote) → writing.sections
 *   Existing-Paper 前段：
 *     import.parse → import.baseline_build → import.understand → citation.verify
 *     → review.run → assessment.target → plan.improvement → HITL(plan) → revision.apply
 *
 *   共享后段（bounded revision loop，PRD §9.5 / D-0026）：
 *     citation.verify（新鲜时跳过）→ review.run（fact/academic/style 并行，跨 run 轮次递增）
 *     → quality.gate（对齐 review 轮次 + 收敛判定）─ 通过 → build.draft → build.final（Finalize）
 *                                        └ 失败 → revision.plan（确定性派生）→ revision.revise
 *                                             → 回到 citation.verify（≤ maxRounds 轮）
 *                                             不收敛（CONVERGED/REGRESSION/计划空）→ HITL(revision_stalled)
 *                                             超限 → HITL(revision_overflow: accept_draft/revise_more/cancel)
 *                                             └ accept_draft → build.draft → Draft
 *     build 失败（质量问题不阻塞构建）→ revision.repair_latex（≤ 2 次，最小上下文修复）
 *                                    → 耗尽 → 带错误上下文修订或 HITL
 *
 * 修订版本纪律（M4.7）：每个改稿动作（outline.plan / writing.sections /
 * revision.revise / revision.apply / revision.repair_latex / review 快照）都会
 * 经 ManuscriptRevisionStore 提交不可变修订；gate / build / artifact 记录各自
 * 携带对齐的 revision，Finalize 据此拒绝 stale 结论。
 *
 * 流程纪律全部在本文件的确定性 plan/onInput 中；LLM 只产出内容，
 * 其输出必须通过各 Stage 的 DoD 校验。
 */

import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { BusinessError, WorkflowInvalidStateError } from "../errors.js";
import { isExistingPaperKind, isSurveyKind } from "./kinds.js";
import type { GenerationService } from "../generation/GenerationService.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { normalizeManuscriptLanguage } from "../project/language.js";
import type { EvidenceStore, EvidenceRecord } from "../evidence/EvidenceStore.js";
import type { EvidenceGroundingService } from "../evidence/EvidenceGroundingService.js";
import type { TargetedGroundingService } from "../evidence/TargetedGroundingService.js";
import type { ChunkStore } from "../retrieval/ChunkStore.js";
import { EvidenceSelectionService, isFormalEvidence } from "../evidence/EvidenceSelectionService.js";
import type { ResearchCoverageService } from "../agents/researchCoverage.js";
import type { ResearchPlanExecutionService } from "../agents/researchPlanExecution.js";
import { computeEvidenceCitationCoverage } from "../quality/evidenceCitationCoverage.js";
import type { SourceStore } from "../sources/SourceStore.js";
import type { CandidateStore, CandidateSource } from "../sources/CandidateStore.js";
import type { SourceImportService } from "../sources/SourceImportService.js";
import type { ResearchDiscoveryService } from "../search/researchDiscoveryService.js";
import type { IngestionService } from "../ingestion/IngestionService.js";
import type { PlanExecutionAcademicResultSnapshot, PlanExecutionWebResultSnapshot } from "../agents/researchPlanExecution.js";
import type { MatrixService, SurveyEntryPatch } from "../survey/MatrixService.js";
import type { CorpusSnapshotService } from "../survey/CorpusSnapshotService.js";
import type { SynthesisService } from "../survey/SynthesisService.js";
import type { SurveyOutlineService } from "../survey/OutlineService.js";
import {
  SurveyMatrixArtifactStore,
  SurveySynthesisArtifactStore,
} from "../survey/surveyArtifacts.js";
import { fingerprintJson } from "../util/hash.js";
import { buildSurveySectionContext } from "../survey/sectionContext.js";
import {
  evaluateSurveyWriting,
  renderSurveyMetricsLines,
  type SurveyWritingEvaluation,
} from "../survey/writingInvariants.js";
import { normalizeTaxonomy, UNCLASSIFIED_FAMILY, type SurveyTaxonomy } from "../survey/matrixTypes.js";
import type { ManuscriptService } from "../manuscript/ManuscriptService.js";
import type { ManuscriptRevisionStore } from "../manuscript/RevisionStore.js";
import {
  headingsOfContent,
  latexContainsAbstract,
  sectionRefNamesHeading,
} from "../manuscript/latexHeadings.js";
import {
  computeCitationPreservation,
  readSnapshotTex,
  type CitationPreservationSummary,
} from "../quality/citationPreservation.js";
import {
  computeFactPreservation,
  describeFactPreservation,
  projectPairwiseFactRestore,
  type FactFinding,
  type FactTexFile,
} from "../quality/factPreservation.js";
import {
  appendWeakeningAuthorizations,
  computeCumulativeFactPreservation,
  findFrozenBaselineRevision,
  recordImprovementPlanApproval,
  type CumulativeFactValidation,
} from "../quality/cumulativeFactPreservation.js";
import {
  deriveClaimGroundingWeakeningAuthorizations,
  deriveClaimResolutionAuthorizations,
  derivePlanWeakeningAuthorizations,
} from "../review/weakeningAuthorization.js";
import { applyFactRestore, planFactRestore, restoreValueDelta } from "../quality/factRestore.js";
import { computeClaimGapAudit, tagIssueRootCauses, type ClaimGapAudit } from "../review/claimGapAudit.js";
import {
  computeClaimResolutions,
  type ClaimResolutionReport,
} from "../review/claimResolution.js";
import type { LatexCompiler } from "../latex/LatexCompiler.js";
import { diagnosticFiles, type LatexDiagnostic } from "../latex/diagnostics.js";
import {
  reconstructManuscriptFromPaper,
  writeReconstructionReport,
} from "../import/PaperReconstructor.js";
import { buildAssetInventory } from "../import/assetInventory.js";
import { buildRevisionBaseline } from "../review/revisionBaseline.js";
import { writeRevisionResponse } from "../review/revisionResponse.js";
import type { WriterService } from "../writer/WriterService.js";
import type { ResearcherService, ResearchArtifact, BibliographyEntryInput } from "../agents/ResearcherService.js";
import { readResearchArtifact } from "../agents/ResearcherService.js";
import { readPlanChain } from "../agents/researchPlan.js";
import { readFeasibilityReport, type FeasibilityService } from "../agents/FeasibilityService.js";
import type { ReviewerService, ReviewIssue } from "../agents/ReviewerService.js";
import type { CitationService, CitationReport } from "../citation/CitationService.js";
import {
  buildBibliographyFromSources,
  filterByCitedKeys,
  mergeArtifactBibliography,
  renderBibEntry,
  resolveEvidenceCitationKey,
  type CanonicalBibliographyEntry,
} from "../citation/bibliography.js";
import { extractCitationKeys, parseBib } from "../citation/StaticCitationChecker.js";
import type { CitationIntegrityService } from "../citation/CitationIntegrityService.js";
import type { CitationCallout, ReferenceEntry } from "../citation/integrity.js";
import { readSemanticMode } from "../citation/semanticMode.js";
import type { PaperStore } from "../paper/PaperStore.js";
import type { PaperMapService } from "../paper/PaperMapService.js";
import type { ReviewContextBuilder, CitationContextEntry } from "../paper/ReviewContextBuilder.js";
import { disconfirmBuildFindings, repairCitationSyntax } from "../citation/citationSyntax.js";
import { SectionReviewService, SECTION_REVIEW_INSTRUCTION } from "../paper/SectionReviewService.js";
import { SectionReviewScheduler } from "../paper/SectionReviewScheduler.js";
import { readFindings, type FindingCategory, type FindingSeverity } from "../review/finding.js";
import { aggregateReviews, type ReviewSummary } from "../review/ReviewAggregator.js";
import {
  buildClaimRepairDirectives,
  computeClaimGroundingReport,
  isUnsupportedVerdict,
  literatureRefSourceIds,
  normalizeSectionKey,
  type ClaimRepairDirective,
} from "../review/claimGrounding.js";
import type { ReviewArtifactStore } from "../review/reviewArtifacts.js";
import { buildRevisionPlan, dispatchableRevisionItems, type RevisionPlan, type RevisionPlanItem } from "../review/revisionPlan.js";
import { applyRevisionSpan, checkGlobalRevisionScope, hasNewContentAfterDocumentEnd, hasRevisionWorkspaceMutation, locateLatexSections, revisionSourceHash, revisionSpansOverlap, verifyNoopCoverage, type RevisionSpan } from "../review/revisionScope.js";
import { filterEvidenceForProtocol } from "../evidence/protocolScope.js";
import { attributeCitationChangesToPatches, summarizePatchValidation, validationForComment, type PatchValidationRecord } from "../review/patchValidation.js";
import {
  applyRevisionItemTransitions,
  findStuckAppliedItems,
  RevisionProtocolError,
  type RevisionItemTransition,
} from "../review/revisionItemStatus.js";
import {
  evaluateRevisionValidation,
  withUserDecision,
} from "../review/revisionValidation.js";
import {
  applyDispatchOutcome,
  type ExternalDirectiveDispatch,
  type ExternalDispatchResult,
  type ExternalInstruction,
  type ExternalInstructionStore,
  type ExternalOutcomeReport,
  reverifyHandledInstructions,
} from "../review/externalInstructions.js";
import {
  buildStylePolishPlan,
  fingerprintStylePolish,
  isPolishableStyleIssue,
  listStyleFindings,
  readStylePolicy,
  type StylePolishResult,
} from "../review/stylePolicy.js";
import { checkStyleInvariants } from "../review/styleInvariants.js";
import {
  judgeOutcome,
  judgeConvergence,
  classifyTerminalStatus,
  scorecardOf,
  scorecardWithConvergenceMetrics,
  scorecardDelta,
  MAX_AUTO_LATEX_REPAIRS,
} from "../review/revisionOutcome.js";
import type { PaperArtifactStore } from "../artifacts/ArtifactStore.js";
import type { FinalizeService } from "../artifacts/FinalizeService.js";
import {
  evaluateQualityGate,
  runBuildGate,
  runBuildGateForRevision,
  loadBuildGateRecord,
  saveQualityGateReport,
  type QualityGateThresholds,
} from "../quality/gates.js";
import type { Outline } from "../manuscript/ManuscriptService.js";
import { collectLatexFiles, type LatexProjectFiles } from "../manuscript/LatexFiles.js";
import { writeJsonAtomic } from "../util/atomic.js";
import type {
  PlanDecision,
  ResumeInput,
  StageSpec,
  WorkflowDefinition,
  WorkflowState,
} from "./types.js";

export interface WorkflowServices {
  projects: ProjectStore;
  generation: GenerationService;
  researcher: ResearcherService;
  feasibility: FeasibilityService;
  reviewer: ReviewerService;
  evidence: EvidenceStore;
  /** Evidence Grounding 管道（M6.5：evidence.ground stage 消费） */
  evidenceGrounding: EvidenceGroundingService;
  /**
   * 定向证据采证（M11.2.3 D-3：evidence.ground_claims stage 消费——
   * unsupported claim × 在库全文 → verified evidence，不重跑检索管线）。
   */
  targetedGrounding: TargetedGroundingService;
  /** chunk 存储（M11.2.3：resolution context 的源可采证性判定；只读） */
  chunkStore: ChunkStore;
  /**
   * Evidence 使用策略（M6.6 §9/§10：原 workflow 本地 usableEvidence 下沉至此）：
   * 哪些 Evidence 可进入 Writer / Reviewer 正式上下文（verified + 三件套锚点）。
   */
  evidenceSelection: EvidenceSelectionService;
  /**
   * Discovery 候选文献存储（M9.7.4：hitl.evidence_supply 读取待审数量——
   * 只读消费，promote 仍是用户显式动作，本工作流绝不自动晋升）。
   */
  candidates: CandidateStore;
  /**
   * Research Coverage Analyzer（M9.9：hitl.evidence_supply payload 只读消费
   * requirementCoverage 派生视图——预写证据需求的缺口在 HITL 呈现；覆盖
   * 状态仍由 Analyzer 随源数据即时派生，不在 workflow / artifact 上持久化）。
   */
  coverage: ResearchCoverageService;
  /**
   * Research Plan 执行器（M10.3：existing-paper 流程 research.plan / execute
   * stage 消费——批准 + 检索执行 + 结果快照回填；批准仍走 HITL）。
   */
  planExecution: ResearchPlanExecutionService;
  sources: SourceStore;
  /**
   * 文献入库路径编排（M11.1.4：topic_survey 的 survey.fulltext stage 消费——
   * 批量 promote 选中候选 + 批量全文解析；全部走既有幂等语义）。
   */
  sourceImport: SourceImportService;
  /**
   * Research Discovery（M11.1.4：survey.search stage 消费——把执行计划的结果
   * 快照经单一写入口径物化为候选；Search Result ≠ Candidate ≠ Literature 边界
   * 由 Candidate / promote 状态天然保持）。
   */
  discovery: ResearchDiscoveryService;
  /**
   * Document & Data Ingestion（M11.1.4：survey.fulltext stage 在全文挂载后
   * 同步等待结构化解析完成——Matrix 的 fulltext 锚定依赖 chunk 就绪）。
   */
  ingestion: IngestionService;
  /**
   * Survey Matrix（M11.1.4：survey.matrix stage 消费——Literature → per-paper
   * 结构化理解；不复制抽取逻辑，构建 / 增量 / taxonomy 重校验全部在服务内）。
   */
  survey: MatrixService;
  /**
   * Research Corpus Snapshot（M11.3：survey.fulltext 冻结 / resume no-op /
   * 显式 refresh_missing_fulltext——补齐只经此通道，revision+指纹+staleness 传播）。
   */
  corpus: CorpusSnapshotService;
  /**
   * Survey Synthesis（M11.1.4：survey.synthesis stage 消费——Matrix 指纹复用 /
   * 全量重建；grounding 规则零旁路）。
   */
  synthesis: SynthesisService;
  /**
   * Survey Outline（M11.1.4：survey.outline stage 消费——validateSurveyOutline
   * blocking fail-closed + feedback 重规划在服务内）。
   */
  surveyOutline: SurveyOutlineService;
  manuscript: ManuscriptService;
  writer: WriterService;
  citation: CitationService;
  latex: LatexCompiler;
  /** PDF Review Foundation 服务束（existing_paper_review 用） */
  paper: PaperReviewServices;
  /** reviews/ 产物读写（round 编号、最新汇总） */
  reviewArtifacts: ReviewArtifactStore;
  /** 外部修改意见（M5.7：journal reviewer / editor / advisor / user 指令存储与状态） */
  externalInstructions: ExternalInstructionStore;
  /** manuscript 修订提交（M4.7：gate / build / artifact 的对齐基准） */
  revisions: ManuscriptRevisionStore;
  /** Draft / Final 产物存储（M4.7） */
  artifacts: PaperArtifactStore;
  /** Finalize：双 Gate 对齐校验 + Final 冻结（确定性，无 LLM） */
  finalize: FinalizeService;
  stageTimeoutMs: number;
  stageMaxAttempts: number;
  /** bounded loop 与 Quality Gate 阈值 */
  review: {
    maxRevisionRounds: number;
    academicPassScore: number;
    styleRiskMax: number;
    /** 单节审阅节内重试的退避（毫秒；缺省 SECTION_REVIEW_BACKOFF_MS，测试可置 0） */
    sectionRetryBackoffMs?: readonly number[];
    /** section review 有界并发度（PAPERTEAM_REVIEW_CONCURRENCY；活跃模型调用上限） */
    reviewConcurrency: number;
    /** benchmark / 诊断：限制单次审阅的章节数（0 = 不限制） */
    reviewSectionLimit: number;
  };
}

/** PDF Review Foundation：PaperMap / ReviewContext / Citation Integrity / Section Review */
export interface PaperReviewServices {
  store: PaperStore;
  map: PaperMapService;
  reviewContext: ReviewContextBuilder;
  citationIntegrity: CitationIntegrityService;
  sectionReview: SectionReviewService;
}

/** 目标调整 / 大纲与改进计划修订的次数上限（bounded，防无限循环烧 Token） */
const MAX_FEASIBILITY_ADJUSTMENTS = 3;
const MAX_OUTLINE_REVISIONS = 3;
const MAX_PLAN_REVISIONS = 3;
/** 手动追加修订轮数（HITL revise_more）的绝对上限 */
const MAX_MANUAL_REVISION_ROUNDS = 3;
/** 单轮 section review 的章节上限（超出部分如实记录为 skipped） */
const MAX_REVIEW_SECTIONS = 40;
/** 少于此字符数的章节只是标题行 / 编号，没有可审阅的内容 */
const MIN_REVIEW_SECTION_CHARS = 80;
/** 单节审阅的节内重试次数与退避（Provider 503 / 限流常在几秒到几十秒内恢复） */
const SECTION_REVIEW_ATTEMPTS = 3;
const SECTION_REVIEW_BACKOFF_MS = [5_000, 20_000];

const QUALITY_THRESHOLDS = (services: WorkflowServices): QualityGateThresholds => ({
  academicPassScore: services.review.academicPassScore,
  styleRiskMax: services.review.styleRiskMax,
  requireFeasibility: true,
});

// ============================================================
// 共享 stage 工厂
// ============================================================

function citationVerifyStage(services: WorkflowServices): StageSpec {
  return {
    id: "citation.verify",
    description: "Citation 核验（静态一致性 + 公开元数据比对）",
    requiredInputs: [],
    producedOutputs: ["reviews/citation-report.json"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs,
    retryable: ["transient", "timeout"],
    async execute(ctx) {
      const report = await services.citation.verify(ctx.projectId);
      return { ...report.summary };
    },
    async verifyDod(ctx) {
      const report = await services.citation.latestReport(ctx.projectId);
      return report === null ? ["reviews/citation-report.json 不存在"] : [];
    },
  };
}

function reviewRunStage(services: WorkflowServices): StageSpec {
  return reviewRunStageInner(services, {});
}

/**
 * 导入冻结基线（reason=baseline 的最早修订 + 快照文本；M10.3.1 G1/G2 共用）。
 * null = 非导入基线项目 / 快照缺失——累计口径与 claim 适用性审计按中性处理。
 */
async function loadFrozenBaseline(
  services: WorkflowServices,
  projectId: string,
  options: { existingPaper?: boolean } = {},
): Promise<{ revision: number; files: { file: string; content: string }[] } | null> {
  const state = await services.revisions.load(projectId);
  const baseline = findFrozenBaselineRevision(state.revisions, options.existingPaper === true);
  if (baseline === undefined) {
    return null;
  }
  const files = await readSnapshotTex(services.revisions.snapshotDir(projectId, baseline.revision));
  if (files === null || files.length === 0) {
    return null;
  }
  return { revision: baseline.revision, files };
}

/**
 * M10.3.1 G2：existing-paper 流程的 review 附带 task-aware claim 适用性审计
 * （claim-gap-audit-r{round}.json，确定性）。Quality Gate 规则 4/5/6 与
 * revision.plan 据此只对「修订引入」口径计数 / 派发。
 *
 * M11.2 options.survey：综述流程的 review 附带 Survey Review Profile（academic
 * rubric 切换）+ 确定性写作 metrics digest，并落盘 survey-writing-r{round}.json
 * （gate 的 survey 规则与 trace 消费同轮产物）。
 */
function reviewRunStageInner(
  services: WorkflowServices,
  options: { existingPaper?: boolean; survey?: boolean },
): StageSpec {
  return {
    id: "review.run",
    description: "Reviewer 三路并行审稿（fact / academic / style）并确定性聚合",
    requiredInputs: [],
    producedOutputs: ["reviews/review-r*-*.json", "reviews/review-summary-r*.json"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs * 2, // 三路并行，预算放宽
    retryable: ["transient", "timeout", "runtime_unavailable", "contract_violation"],
    async execute(ctx) {
      const digest = await buildManuscriptDigest(services, ctx.projectId);
      // 审稿前固化修订版本：本轮 review 审阅的就是这个不可变修订（幂等提交，
      // 未变化的 manuscript 不产生新修订号）。gate / Finalize 据此对齐。
      const { revision } = await services.revisions.commit(ctx.projectId, "review.snapshot", ctx.runId);
      // M6.6：正式上下文只进 verified formal 池；排除计数随 stage 结果可观测
      const evidenceSelection = await services.evidenceSelection.selectForWriting(ctx.projectId);
      const evidence = evidenceSelection.formal;
      const project = await services.projects.getRequired(ctx.projectId);
      const citationReport = await services.citation.latestReport(ctx.projectId);
      const citationDigest = citationReport
        ? `cited=${citationReport.summary.citedCount} missing=${citationReport.summary.missingKeys} hallucinated=${citationReport.summary.hallucinated} mismatched=${citationReport.summary.mismatched}`
        : undefined;

      // fan-out：三类 review skill 并行（Promise.all；各 mode 独立 contextScope）
      const language = normalizeManuscriptLanguage(project.language);
      // M11.2：综述 review 附带确定性写作评估（metrics digest 进 Reviewer 上下文；
      // 评估产物按轮落盘，供 gate / trace / 报告消费）
      let surveyWriting: SurveyWritingEvaluation | null = null;
      let surveyDigest: string | undefined;
      if (options.survey === true) {
        surveyWriting = await evaluateSurveyWritingForProject(services, ctx.projectId);
        surveyDigest = renderSurveyMetricsLines(surveyWriting).join("\n");
      }
      const results = await services.reviewer.reviewAll({
        projectId: ctx.projectId,
        manuscriptDigest: digest,
        evidence,
        signal: ctx.signal,
        targetProfile: project.targetProfile,
        ...(language !== undefined ? { language } : {}),
        ...(citationDigest !== undefined ? { citationDigest } : {}),
        ...(options.survey === true ? { reviewProfile: "survey" as const } : {}),
        ...(surveyDigest !== undefined ? { surveyDigest } : {}),
      });

      // 轮次来自磁盘上已有汇总的编号（跨 run 递增）：修复了旧实现
      // 「countCompletions + 1」在第二个 run 里与既有文件名撞号的问题
      const round = await services.reviewArtifacts.nextSummaryRound(ctx.projectId);
      const reportPaths: string[] = [];
      for (const result of results) {
        reportPaths.push(await services.reviewer.saveReport(ctx.projectId, round, result));
      }
      const summary = aggregateReviews(results, round, reportPaths);
      summary.reviewedRevision = revision;
      // M9.7.6 Claim Grounding：fact claims 的确定性证据绑定整理（复用 verdict，
      // 无新 LLM 判定）。citation key 解析与 Writer 引用 / coverage gate 同源。
      // M11.2.3：先于 summary 落盘计算——rootCauseKey 标注（D-2 根因口径）要
      // 写进聚合 issues，gate 规则 5/6 据此去重。
      const factClaims = results.find((result) => result.mode === "fact")?.claims ?? [];
      // M11.3（Phase B）：章节引用面投影 → 候选证据来源合法性（§10）
      const sectionCitedSourceIds = await projectOutlineCitedSourceIds(services, ctx.projectId);
      const claimGrounding = computeClaimGroundingReport({
        projectId: ctx.projectId,
        round,
        factClaims,
        formalEvidence: evidence,
        bibEntries: citationReport?.static.bibEntries ?? [],
        ...(Object.keys(sectionCitedSourceIds).length > 0 ? { sectionCitedSourceIds } : {}),
      });
      // M10.3.1 G2：existing-paper 的 claim 适用性审计（pre-existing / 作者数据
      // 覆盖 / 修订引入；机器可读，gate 与 revision.plan 消费）
      let claimGapAudit: ClaimGapAudit | null = null;
      if (options.existingPaper === true) {
        const baseline = await loadFrozenBaseline(services, ctx.projectId, {
            existingPaper: options.existingPaper === true,
          });
        if (baseline !== null) {
          const allEvidence = await services.evidence.list(ctx.projectId);
          claimGapAudit = computeClaimGapAudit({
            projectId: ctx.projectId,
            round,
            baselineRevision: baseline.revision,
            unsupportedClaims: claimGrounding.claims.filter((entry) => isUnsupportedVerdict(entry.verdict)),
            issues: summary.issues,
            frozenFiles: baseline.files,
            authorEvidence: allEvidence.filter((record) => record.verificationLevel === "user_confirmed"),
          });
          await services.reviewArtifacts.saveClaimGapAudit(ctx.projectId, claimGapAudit);
        }
      }
      // M11.2.3（D-2）：fact 路为每条 UNSUPPORTED claim 配套产出 issue——把
      // 该 issue 回填 rootCauseKey=claimId（audit 已归因的指纹除外，防双重排除），
      // gate 规则 5/6 不再把同一根因重复计入 blocking / critical 口径。
      const auditExcludedFingerprints = new Set(
        (claimGapAudit?.issueAttribution ?? [])
          .filter((entry) => entry.excluded)
          .map((entry) => entry.fingerprint),
      );
      const tagged = tagIssueRootCauses(
        summary.issues,
        claimGrounding.claims.filter((entry) => isUnsupportedVerdict(entry.verdict)),
        { excludeFingerprints: auditExcludedFingerprints },
      );
      summary.issues = tagged.issues;
      // M11.3（Phase D）：build 类结构指控与真实文件确定性交叉核验——
      // 指控「截断 / cite 未闭合」而真实文件检测无此问题 = digest 视图伪影
      // （MOT 实录：2500 字符硬切恰好落在 \cite{ng 中间，连续三轮烧修订）。
      // 反证 finding 移出 issues / counts（不阻断、不派发），单独保留透明展示。
      const latexForCheck = await collectLatexFiles(services.projects.manuscriptDir(ctx.projectId));
      const filesForDisconfirmation = latexForCheck.sections.map((section) => ({
        file: section.relativePath,
        content: section.content,
      }));
      const disconfirmed = disconfirmBuildFindings(
        summary.issues,
        filesForDisconfirmation,
        citationReport?.static.bibEntries.map((entry) => entry.key) ?? [],
      );
      if (disconfirmed.disconfirmedCount > 0) {
        const flagged = new Set(
          summary.issues.filter((issue) => disconfirmed.isDisconfirmed(issue)),
        );
        summary.disconfirmedIssues = [...flagged];
        summary.issues = summary.issues.filter((issue) => !flagged.has(issue));
        for (const issue of flagged) {
          if (issue.severity === "critical") {
            summary.counts.critical -= 1;
            summary.openCritical -= 1;
          } else if (issue.severity === "major") {
            summary.counts.major -= 1;
            summary.openMajor -= 1;
          } else if (issue.severity === "minor") {
            summary.counts.minor -= 1;
          }
          if (issue.blocking) {
            summary.counts.blocking -= 1;
          }
        }
        ctx.log(
          `[review] 反证 ${disconfirmed.disconfirmedCount} 条 build finding（真实稿件无对应结构问题，review digest 视图伪影，不计入阻断）`,
        );
      }
      await services.reviewArtifacts.saveSummary(ctx.projectId, round, summary);
      await services.reviewArtifacts.saveClaimGrounding(ctx.projectId, claimGrounding);
      // M11.2：综述写作评估按轮落盘（与 review 同轮配对；gate 消费同轮产物）
      if (surveyWriting !== null) {
        await services.reviewArtifacts.saveSurveyWriting(ctx.projectId, round, surveyWriting);
      }
      return {
        round,
        revision,
        issues: summary.counts.critical + summary.counts.major + summary.counts.minor,
        critical: summary.counts.critical,
        major: summary.counts.major,
        blocking: summary.counts.blocking,
        academicScore: summary.scores.academicScore ?? -1,
        styleRisk: summary.scores.styleRisk ?? -1,
        unsupportedCriticalClaims: summary.unsupportedCriticalClaims,
        // M11.2.3：披露口径拆分 + 根因标注计数（trace / 报告可观测）
        ...(claimGrounding.unsupportedClaims > 0
          ? {
              unsupportedOpaque: claimGrounding.opaqueUnsupportedClaims,
              unsupportedTransparent: claimGrounding.transparentUnsupportedClaims,
              claimRootCausedIssues: tagged.counts,
            }
          : {}),
        ...(claimGapAudit !== null
          ? {
              claimGapAudit: {
                revisionIntroduced: claimGapAudit.counts.revisionIntroduced,
                excludedPreExisting: claimGapAudit.counts.excludedPreExisting,
                excludedAuthorData: claimGapAudit.counts.excludedAuthorData,
              },
            }
          : {}),
        evidenceBoundClaims: claimGrounding.evidenceBoundClaims,
        claimEvidenceBindingRate: claimGrounding.evidenceBindingRate,
        evidenceFormal: evidenceSelection.formal.length,
        evidenceExcluded: evidenceSelection.excluded,
        // M11.2：综述确定性指标摘要（survey-writing-r{round}.json 明细）
        ...(surveyWriting !== null
          ? {
              surveyWriting: {
                blockers: surveyWriting.blockers.length,
                warnings: surveyWriting.warnings.length,
                literatureCoverage: surveyWriting.metrics.literatureCoverage,
                groundedSynthesisUsage: surveyWriting.metrics.groundedSynthesisUsage,
                multiKeyCiteRatio: surveyWriting.metrics.multiKeyCiteRatio,
                listingRuns: surveyWriting.metrics.listingRuns,
                speculativeLeakSignals: surveyWriting.metrics.speculativeLeakSignals,
              },
            }
          : {}),
        // M5.4：可进入语言润色的 style minor finding 数（planner 据此决定是否询问）
        styleMinor: summary.issues.filter(isPolishableStyleIssue).length,
      };
    },
    async verifyDod(ctx) {
      // execute 用 nextSummaryRound 分配轮次（磁盘已有 + 1），此处重算会得到
      // 「下一轮」的编号：改为校验最新汇总存在且携带修订对齐信息
      const summary = await services.reviewArtifacts.latestSummary(ctx.projectId);
      if (summary === null) {
        return ["reviews/review-summary-r*.json 不存在"];
      }
      return typeof summary.reviewedRevision === "number"
        ? []
        : ["最新审稿汇总缺少修订对齐信息（reviewedRevision）"];
    },
  };
}

function qualityGateStage(
  services: WorkflowServices,
  options: { survey?: boolean } = {},
): StageSpec {
  return {
    id: "quality.gate",
    description: "Quality Gate：确定性判定（引用/事实/审稿/目标可行性；survey 含写作契约）",
    requiredInputs: ["review.run"],
    producedOutputs: ["reviews/quality-gate-r*.json"],
    maxAttempts: 1, // 纯确定性判定，重试无意义
    timeoutMs: services.stageTimeoutMs,
    retryable: [],
    async execute(ctx) {
      const review = await latestReviewSummary(services, ctx.projectId);
      if (review === null) {
        throw new BusinessError("STAGE_CONTRACT_VIOLATION", "缺少 review 汇总（先执行 review.run）");
      }
      const citation: CitationReport | null = await services.citation.latestReport(ctx.projectId);
      const evidence = await services.evidence.stats(ctx.projectId);
      const feasibility = (await readFeasibilityReport(services.projects, ctx.projectId))?.report ?? null;
      // M5.6 Citation Preservation：被审阅修订 vs 前一修订（快照事实源；无前序修订 → null 中性）
      const citationPreservation = await computeCitationPreservation(
        services,
        ctx.projectId,
        review.reviewedRevision,
      );
      // M5.6 Fact Preservation：实验事实保持（表格数值 / 正文数字 / 公式 / 方向结论 / 协议 / 占位回归）
      const factPreservation = await computeFactPreservation(
        services,
        ctx.projectId,
        review.reviewedRevision,
      );
      // M10.3.1 G1：累计事实校验（Frozen Baseline → 被审阅修订；授权 = 已批准
      // 改进计划台账 + Evidence。历史未授权漂移跨轮保持 unresolved）
      const cumulativeFactPreservation = await computeCumulativeFactPreservation(
        services,
        ctx.projectId,
        review.reviewedRevision,
        { existingPaper: isExistingPaperKind(ctx.state.workflowKind) },
      );
      // M10.3.1 G2：同轮 claim 适用性审计（existing-paper 流程在 review.run 产出；
      // 旧 / idea 项目无产物 → 规则按原口径）
      const claimGapAudit = await services.reviewArtifacts.loadClaimGapAudit(ctx.projectId, review.round);
      // M6.6 §13：正文引用 ↔ verified evidence 覆盖（可检测；默认不阻断）
      const evidenceRecords = await services.evidence.list(ctx.projectId);
      const evidenceCitationCoverage =
        citation !== null
          ? computeEvidenceCitationCoverage({
              citedKeys: citation.static.citedKeys,
              bibEntries: citation.static.bibEntries,
              evidenceRecords,
            })
          : undefined;
      // M6.7 §10 Revision Gate：修订条目复核结果（对齐被审阅修订才消费；
      // 旧 / 不对齐（如用户恢复历史修订）→ 规则不出现，与 Preservation null 同纪律）
      const latestValidation = await services.reviewArtifacts.latestValidation(ctx.projectId);
      const revisionValidation =
        latestValidation !== null && latestValidation.revision === review.reviewedRevision
          ? latestValidation
          : undefined;
      // M11.2：survey gate 规则输入——优先消费同轮 review 落盘的评估（与 review
      // 快照对齐）；无同轮产物时（旧 run / 手动触发）现场重算
      let surveyWriting: SurveyWritingEvaluation | undefined;
      if (options.survey === true) {
        const stored = await services.reviewArtifacts.loadSurveyWriting(ctx.projectId, review.round);
        surveyWriting = stored ?? (await evaluateSurveyWritingForProject(services, ctx.projectId));
      }
      // M11.2.3（D-2）：同轮 claim grounding（披露口径拆分 + 根因去重的输入）
      const claimGrounding = await services.reviewArtifacts.loadClaimGrounding(ctx.projectId, review.round);
      const gate = evaluateQualityGate(
        {
          review,
          citation,
          evidence,
          feasibility,
          citationPreservation,
          factPreservation,
          cumulativeFactPreservation,
          ...(claimGapAudit !== null ? { claimGapAudit } : {}),
          ...(claimGrounding !== null ? { claimGrounding } : {}),
          ...(evidenceCitationCoverage !== undefined ? { evidenceCitationCoverage } : {}),
          ...(revisionValidation !== undefined ? { revisionValidation } : {}),
          ...(surveyWriting !== undefined ? { surveyWriting } : {}),
        },
        QUALITY_THRESHOLDS(services),
      );
      const patchValidation = typeof review.reviewedRevision === "number"
        ? await services.reviewArtifacts.loadPatchValidation(ctx.projectId, review.reviewedRevision)
        : null;
      if (patchValidation !== null && typeof review.reviewedRevision === "number") {
        const sourceRevision = Math.max(0, review.reviewedRevision - 1);
        const previousTex = await readSnapshotTex(services.revisions.snapshotDir(ctx.projectId, sourceRevision));
        const currentTex = await readSnapshotTex(services.revisions.snapshotDir(ctx.projectId, review.reviewedRevision));
        const facts: FactFinding[] = factPreservation === null ? [] : [
          ...factPreservation.changedFacts, ...factPreservation.removedFacts, ...factPreservation.addedUnsupportedFacts,
          ...factPreservation.directionalChanges, ...factPreservation.formulaChanges, ...factPreservation.placeholderRegressions,
        ];
        const assignedFacts = new Set<FactFinding>();
        for (const record of patchValidation.records) {
          const ownFacts = facts.filter((finding) => finding.file === record.file &&
            (finding.section.toLocaleLowerCase() === record.logicalTarget.toLocaleLowerCase() ||
              finding.section.toLocaleLowerCase().includes(record.logicalTarget.toLocaleLowerCase()) ||
              record.logicalTarget.toLocaleLowerCase().includes(finding.section.toLocaleLowerCase())));
          ownFacts.forEach((finding) => assignedFacts.add(finding));
          record.fact = {
            ok: ownFacts.length === 0,
            findingIds: ownFacts.map((finding) => `fact:${review.reviewedRevision}:${finding.file}:${finding.section}:${finding.kind}`),
            violations: ownFacts.map((finding) => finding.reason),
          };
        }
        const unattributed = facts.filter((finding) => !assignedFacts.has(finding));
        const previousMain = previousTex?.find((file) => file.file === "main.tex")?.content;
        const currentMain = currentTex?.find((file) => file.file === "main.tex")?.content;
        const attribution = previousMain !== undefined && currentMain !== undefined
          ? attributeCitationChangesToPatches({
              before: previousMain,
              after: currentMain,
              patches: patchValidation.records.flatMap((record) => {
                const span = locateLatexSections("main.tex", previousMain).find((candidate) => candidate.logicalSection === record.logicalTarget);
              return span === undefined ? [] : [{ patchId: record.patchId, planItemIds: record.planItemIds, commentIds: record.commentIds, span, addedKeys: record.citation.addedKeys, removedKeys: record.citation.removedKeys }];
              }),
              knownKeys: new Set(citation?.static.bibEntries.map((entry) => entry.key) ?? []),
            })
          : { findings: [], unattributed: [] };
        const unapportionedCitation = attribution.unattributed.filter((finding) =>
          finding.code !== "REMOVED_CITATION_KEY" || (citationPreservation?.unexpectedRemovedKeys.includes(finding.key) ?? true));
        const addedViolations = new Map<string, string[]>();
        for (const finding of attribution.findings) {
          const violation = finding.code === "MISSING_CITATION_KEY" ||
            (finding.code === "REMOVED_CITATION_KEY" && (citationPreservation?.unexpectedRemovedKeys.includes(finding.key) ?? true));
          if (finding.patchId !== undefined && violation) {
            const list = addedViolations.get(finding.patchId) ?? [];
            list.push(finding.code);
            addedViolations.set(finding.patchId, list);
          }
        }
        for (const record of patchValidation.records) {
          const own = attribution.findings.filter((finding) => finding.patchId === record.patchId);
          const violations = addedViolations.get(record.patchId) ?? [];
          record.citation = {
            ok: record.citation.ok && violations.length === 0,
            findingIds: [...new Set([...record.citation.findingIds, ...own.map((finding) => `citation:${review.reviewedRevision}:${finding.code}:${finding.key}`)])],
            addedKeys: [...new Set([...record.citation.addedKeys, ...own.filter((finding) => finding.code === "MISSING_CITATION_KEY" || finding.code === "ADDED_CITATION_KEY").map((finding) => finding.key)])],
            removedKeys: [...new Set([...record.citation.removedKeys, ...own.filter((finding) => finding.code === "REMOVED_CITATION_KEY").map((finding) => finding.key)])],
            violations: [...new Set([...record.citation.violations, ...violations])],
          };
          record.overall = record.scope.ok && record.workspaceIntegrity.ok && record.fact.ok && record.citation.ok && record.evidence.ok && record.apply.ok ? "pass" : "fail";
        }
        patchValidation.summary = summarizePatchValidation(patchValidation.records, [
          ...unattributed.map(() => "UNATTRIBUTED_FACT_VIOLATION"),
          ...unapportionedCitation.map((finding) => finding.code === "AMBIGUOUS_PATCH_ATTRIBUTION" ? finding.code : "UNATTRIBUTED_CITATION_VIOLATION"),
        ]);
        patchValidation.summary.publishable = patchValidation.summary.publishable &&
          (factPreservation?.ok ?? false) && (citationPreservation?.ok ?? false) &&
          gate.passed && readBuildError(ctx.state) === undefined;
        await services.reviewArtifacts.savePatchValidation(ctx.projectId, patchValidation);
        gate.rules.push({
          rule: "patch_validation_publishable",
          passed: patchValidation.summary.publishable,
          detail: `patches=${patchValidation.summary.passedPatches}/${patchValidation.summary.totalPatches}; unattributed=${patchValidation.summary.unattributedViolations.length}`,
        });
        if (!patchValidation.summary.publishable) {
          gate.reasons.push("patch_validation_publishable");
          gate.passed = false;
        }
      }
      // 轮次 = 所消费 review 汇总的轮次（同轮配对，跨 run 不漂移）
      const round = review.round;
      await saveQualityGateReport(services.projects, ctx.projectId, round, gate, review, {
        citationPreservation,
        factPreservation,
        cumulativeFactPreservation,
        ...(claimGrounding !== null ? { claimGrounding } : {}),
        ...(evidenceCitationCoverage !== undefined ? { evidenceCitationCoverage } : {}),
        ...(revisionValidation !== undefined ? { revisionValidation } : {}),
        ...(surveyWriting !== undefined ? { surveyWriting } : {}),
      });
      // 收敛判定（D-0026，确定性无 LLM）：与 iteration-history 上一轮 scorecard
      // 对比得 PASS / IMPROVED / CONVERGED / REGRESSION；逐轮追加记录（按 gateRound 幂等）
      // M11.2.3（D-4）：scorecard 追加 unsupported 口径与 fact / citation 违规数；
      // judgeConvergence 跨轮判 PROGRESS / STALLED / REGRESSED（planSharedTail
      // 消费 stage result，不再让「还有轮数」自动续跑不收敛的循环）
      const scorecard = scorecardWithConvergenceMetrics(
        scorecardOf(gate, review),
        claimGrounding,
        factPreservation,
        citationPreservation,
      );
      const iterations = await services.reviewArtifacts.loadIterations(ctx.projectId);
      const previous = iterations.at(-1)?.scorecard ?? null;
      const outcome = judgeOutcome(scorecard, previous);
      const convergence = judgeConvergence([...iterations.map((record) => record.scorecard), scorecard]);
      const delta = scorecardDelta(scorecard, previous);
      // M11.3（Phase E）：同轮 author_decision_required claim 数——终态语义
      // （AUTHOR_DECISION_REQUIRED vs NO_PROGRESS）在 gate 结果里一次算清，
      // stalled payload 与 completion summary 共用（classifyTerminalStatus）
      const claimResolution = await services.reviewArtifacts.loadClaimResolution(ctx.projectId, review.round);
      const authorDecisionClaims = claimResolution?.counts.author_decision_required ?? 0;
      const terminal = classifyTerminalStatus({
        gatePassed: gate.passed,
        gateReasons: gate.reasons,
        convergence,
        authorDecisionClaims,
      });
      await services.reviewArtifacts.appendIteration(ctx.projectId, {
        revision: typeof review.reviewedRevision === "number" ? review.reviewedRevision : 0,
        reviewRound: review.round,
        gateRound: round,
        outcome,
        completedAt: new Date().toISOString(),
        scorecard,
      });
      await ctx.emitDomain(
        gate.passed ? "quality_gate.passed" : "quality_gate.failed",
        {
          round,
          passed: gate.passed,
          reasons: gate.reasons.slice(0, 8),
          critical: review.counts.critical,
          major: review.counts.major,
          academicScore: review.scores.academicScore,
          styleRisk: review.scores.styleRisk,
          outcome,
          ...(convergence !== null ? { convergence } : {}),
          ...(claimGrounding !== null
            ? {
                unsupportedOpaque: claimGrounding.opaqueUnsupportedClaims,
                unsupportedTransparent: claimGrounding.transparentUnsupportedClaims,
              }
            : {}),
          ...(cumulativeFactPreservation !== null
            ? {
                cumulativeFactViolations: cumulativeFactPreservation.unresolvedViolations.length,
                baselineRevision: cumulativeFactPreservation.baselineRevision,
              }
            : {}),
          ...(claimGapAudit !== null
            ? { revisionIntroducedUnsupported: claimGapAudit.counts.revisionIntroduced }
            : {}),
        },
        gate.passed
          ? "Quality Gate 通过"
          : `Quality Gate 未通过：${gate.reasons.length} 项阻止（${outcome ?? "首轮无对比"}${convergence !== null ? ` / ${convergence}` : ""}）`,
      );
      return {
        passed: gate.passed,
        reasonCount: gate.reasons.length,
        reasons: gate.reasons.slice(0, 8),
        round,
        outcome,
        // M11.2.3：确定性收敛状态与轮次质量差（planSharedTail / stalled payload 消费）
        ...(convergence !== null ? { convergence } : {}),
        // M11.3（Phase E）：产品终态语义（completion summary / stalled payload 共用）
        ...(gate.passed ? {} : { terminalStatus: terminal.status, terminalMessage: terminal.message }),
        ...(authorDecisionClaims > 0 ? { authorDecisionClaims } : {}),
        revisionDelta: delta,
        revision: typeof review.reviewedRevision === "number" ? review.reviewedRevision : 0,
        ...(claimGrounding !== null
          ? {
              unsupportedOpaque: claimGrounding.opaqueUnsupportedClaims,
              unsupportedTransparent: claimGrounding.transparentUnsupportedClaims,
            }
          : {}),
        ...(cumulativeFactPreservation !== null
          ? {
              cumulativeFactViolations: cumulativeFactPreservation.unresolvedViolations.length,
              cumulativeFactOk: cumulativeFactPreservation.ok,
            }
          : {}),
        ...(claimGapAudit !== null
          ? { revisionIntroducedUnsupported: claimGapAudit.counts.revisionIntroduced }
          : {}),
      };
    },
  };
}

// ============================================================
// Revision Plan / LaTeX 修复 / Finalize / 不收敛 HITL（M4.7）
// ============================================================

/**
 * 确定性派生修订计划（reviews/revision-plan-r{round}.json）：
 * external 修改意见（M5.7，mandatory）+ critical/major finding 与引用缺失 → 派发；
 * minor 只记录不修（避免非收敛）；conflict 的外部意见保留条目但不派发。
 * 纯代码，无 LLM——Writer 只是计划的执行者。
 */
function revisionPlanStage(services: WorkflowServices): StageSpec {
  return {
    id: "revision.plan",
    description: "确定性派生修订计划（外部意见 mandatory + critical/major 派发，minor 只记录）",
    requiredInputs: ["quality.gate"],
    producedOutputs: ["reviews/revision-plan-r{round}.json"],
    maxAttempts: 1, // 纯确定性派生，重试无意义
    timeoutMs: 60_000,
    retryable: [],
    async execute(ctx) {
      const summary = await latestReviewSummary(services, ctx.projectId);
      if (summary === null) {
        throw new BusinessError("STAGE_CONTRACT_VIOLATION", "缺少 review 汇总（先执行 review.run）");
      }
      const sourceRevision =
        typeof summary.reviewedRevision === "number"
          ? summary.reviewedRevision
          : await services.revisions.currentRevision(ctx.projectId);
      // gate 阻止项：来自同轮 gate 产物（无章节归属 → 记录不派发）
      const gateRounds = await services.reviewArtifacts.gateRounds(ctx.projectId);
      const gateRound = gateRounds[0];
      const gateArtifact =
        gateRound !== undefined ? await services.reviewArtifacts.loadGate(ctx.projectId, gateRound) : null;
      const gateBlockers = (gateArtifact?.gate.rules ?? [])
        .filter((rule) => !rule.passed)
        .map((rule) => ({ rule: rule.rule, detail: rule.detail }));
      // M5.6：引用保持失败项有明确章节归属（上一修订中的出现位置）→ 派发 Writer 恢复引用，
      // 不再只是无从下手的 gate_blocker
      const preservation = gateArtifact?.citationPreservation ?? null;
      const citationRemoved =
        preservation !== null && !preservation.ok
          ? preservation.unexpectedRemoved.map((entry) => ({ key: entry.key, files: entry.files }))
          : [];
      // M5.6 Fact Preservation：违规事实按文件聚合派发恢复条目（每文件最多 2 条，防计划爆炸）
      // M10.3.1 G1：existing-paper 优先消费累计违规（Frozen → Current——pairwise
      // 干净不等于安全，历史漂移必须重新派发直至恢复或授权）；
      const cumulativeState = gateArtifact?.cumulativeFactPreservation ?? null;
      const factState = gateArtifact?.factPreservation ?? null;
      let factRegressions: {
        file: string;
        detail: string;
        violationKey?: string;
        restoreValues?: string[];
        removeValues?: string[];
        restorable?: boolean;
      }[];
      if (cumulativeState !== null && !cumulativeState.ok) {
        factRegressions = await buildCumulativeFactRegressions(services, ctx.projectId, cumulativeState);
      } else if (factState !== null && !factState.ok) {
        // M11.2.3（D-1）：pairwise 违规同步投影 factRestore 数值清单（survey /
        // idea 项目此前只给 file+detail——「无依据新增」被删除后删除动作自身
        // 无授权，加也拦删也拦的结构性死锁，见 projectPairwiseFactRestore 注释）
        factRegressions = await summarizePairwiseFactRegressions(services, ctx.projectId, factState);
      } else {
        factRegressions = [];
      }
      // M10.3.1 G2：claim-gap-audit 归因排除的 issue（原稿既有 / 作者数据覆盖
      // claim 的伴随 finding）→ 留档 skipped，不派发 Writer
      const claimAudit =
        gateRound !== undefined
          ? await services.reviewArtifacts.loadClaimGapAudit(ctx.projectId, summary.round)
          : null;
      const inapplicableFindings =
        claimAudit !== null
          ? claimAudit.issueAttribution
              .filter((entry) => entry.excluded)
              .map((entry) => ({ fingerprint: entry.fingerprint }))
          : [];
      const buildErrorValue = readBuildError(ctx.state);
      // M5.7 外部修改意见：先以最新 gate 复核 handled（该轮修订触发 Fact
      // Preservation FAIL → 降级 unresolved 重新派发，恢复闭环自愈），再整体入计划
      const externalInstructionList = await services.externalInstructions.load(ctx.projectId);
      const patchFailures = new Map<string, { fact?: boolean; citation?: boolean }>();
      const currentPatchValidation = await services.reviewArtifacts.loadPatchValidation(
        ctx.projectId,
        await services.revisions.currentRevision(ctx.projectId),
      );
      for (const instruction of externalInstructionList) {
        const ownValidation = currentPatchValidation !== null
          ? validationForComment(currentPatchValidation.records, instruction.instructionId)
          : null;
        if (ownValidation !== null) {
          patchFailures.set(instruction.instructionId, {
            fact: ownValidation.fact,
            citation: ownValidation.citation,
          });
          continue;
        }
      }
      const reverified = reverifyHandledInstructions(
        externalInstructionList,
        gateArtifact?.factPreservation ?? null,
        new Date().toISOString(),
        gateArtifact?.citationPreservation ?? null,
        patchFailures,
      );
      if (reverified.changed) {
        await services.externalInstructions.save(ctx.projectId, reverified.instructions);
      }
      // M6.7 §5/§6：citation 类条目的 relatedEvidenceIds —— bib key ↔ verified
      // evidence 关联（与 Writer 引用标注 / Gate 覆盖判定同源 matchBibliographyKey）
      const evidenceLinks = await buildEvidenceLinks(services, ctx.projectId);
      const plan = buildRevisionPlan({
        projectId: ctx.projectId,
        sourceRevision,
        reviewRound: summary.round,
        summary,
        citationMissing: await citationMissingTargets(services, ctx.projectId),
        ...(citationRemoved.length > 0 ? { citationRemoved } : {}),
        ...(factRegressions.length > 0 ? { factRegressions } : {}),
        ...(inapplicableFindings.length > 0 ? { inapplicableFindings } : {}),
        ...(buildErrorValue !== undefined
          ? { buildError: { message: buildErrorValue.slice(0, 500) } }
          : {}),
        ...(gateBlockers.length > 0 ? { gateBlockers } : {}),
        ...(reverified.instructions.length > 0
          ? { externalInstructions: reverified.instructions }
          : {}),
        ...(evidenceLinks.length > 0 ? { evidenceLinks } : {}),
      });
      // M11.2.3（D-4 §15）：planned 条目投影 mustPreserve 约束（事实 / 引用
      // 基线的最小投影——Writer 改前就知道哪些绝不能动，而不是事后被守卫打回）
      await attachMustPreserveConstraints(services, ctx.projectId, plan);
      await services.reviewArtifacts.savePlan(ctx.projectId, plan);
      /**
       * M11.2.1：typed weakening 授权落台账（append-only，幂等去重）。授权链 =
       * Reviewer Finding（needsEvidence / 弱化措辞）+ 同轮 claim grounding 的
       * UNSUPPORTED claim → 计划条目 → 台账。台账使授权跨条目生命周期与跨轮
       * 持续（pairwise gate 消费时条目已 applied/validated；cumulative 口径也
       * 依赖台账解释 Frozen → Current 的合法弱化差异）。
       */
      const weakeningAuthorizations = derivePlanWeakeningAuthorizations(plan, { plannedOnly: true });
      const claimGroundingForAuth = await services.reviewArtifacts.loadClaimGrounding(
        ctx.projectId,
        summary.round,
      );
      weakeningAuthorizations.push(
        ...(claimGroundingForAuth !== null
          ? deriveClaimGroundingWeakeningAuthorizations(claimGroundingForAuth)
          : []),
      );
      const recordedWeakenings = await appendWeakeningAuthorizations(
        services.projects,
        ctx.projectId,
        weakeningAuthorizations,
        { runId: ctx.runId },
      );
      /**
       * M11.2.3（D-1/D-3）：Unsupported Claim Resolution Contract（survey）。
       * Evidence First：每条 unsupported claim 先确定 resolution（已有证据绑定 →
       * 在库全文定向采证 → bounded 补搜索 → 透明披露交作者 / 弱化 / 删除阶梯），
       * ground_existing_source 由 evidence.ground_claims stage 采证后回绑派发；
       * remove_unsupported_detail / remove_claim 铸窄授权（只放行删除方向）。
       */
      let claimResolution: ClaimResolutionReport | null = null;
      if (isSurveyKind(ctx.state.workflowKind) && claimGroundingForAuth !== null) {
        const resolutionContext = await buildClaimResolutionContext(services, ctx.projectId);
        claimResolution = computeClaimResolutions(
          claimGroundingForAuth.claims.filter((entry) => isUnsupportedVerdict(entry.verdict)),
          resolutionContext,
          { projectId: ctx.projectId, round: summary.round },
        );
        await services.reviewArtifacts.saveClaimResolution(ctx.projectId, claimResolution);
        const resolutionAuthorizations = deriveClaimResolutionAuthorizations(
          claimResolution.resolutions,
          summary.round,
        );
        if (resolutionAuthorizations.length > 0) {
          await appendWeakeningAuthorizations(services.projects, ctx.projectId, resolutionAuthorizations, {
            runId: ctx.runId,
          });
        }
      }
      // 回填本轮 iteration 记录的 planId（UI / 审计可从轮次回溯计划）
      const iterations = await services.reviewArtifacts.loadIterations(ctx.projectId);
      const currentIteration = iterations.find((record) => record.gateRound === summary.round);
      if (currentIteration !== undefined && currentIteration.planId !== plan.planId) {
        await services.reviewArtifacts.appendIteration(ctx.projectId, {
          ...currentIteration,
          planId: plan.planId,
        });
      }
      return {
        planId: plan.planId,
        round: summary.round,
        items: plan.items.length,
        planned: plan.summary.planned,
        skipped: plan.summary.skipped,
        ...(plan.summary.external !== undefined ? { external: plan.summary.external } : {}),
        // M11.2.1：本轮落账的 typed weakening 授权（幂等去重后新增数）
        weakeningAuthorizations: weakeningAuthorizations.length,
        ...(recordedWeakenings > 0 ? { weakeningAuthorizationsRecorded: recordedWeakenings } : {}),
        // M11.2.3：resolution contract 概要（groundClaims 驱动 evidence.ground_claims）
        ...(claimResolution !== null
          ? {
              claimResolution: claimResolution.counts,
              groundClaims: claimResolution.counts.ground_existing_source,
              resolutionAuthorizations:
                claimResolution.counts.remove_unsupported_detail + claimResolution.counts.remove_claim,
            }
          : {}),
        // M10.3.1：确定性可恢复的累计违规数（plan() 据此路由 revision.restore_facts）
        ...(factRegressions.length > 0
          ? { restorableFacts: factRegressions.filter((entry) => entry.restorable === true).length }
          : {}),
        ...(inapplicableFindings.length > 0 ? { inapplicableFindings: inapplicableFindings.length } : {}),
      };
    },
    async verifyDod(ctx) {
      const summary = await latestReviewSummary(services, ctx.projectId);
      if (summary === null) {
        return ["缺少 review 汇总"];
      }
      const plan = await services.reviewArtifacts.loadPlan(ctx.projectId, summary.round);
      return plan === null
        ? [`reviews/${services.reviewArtifacts.planFileName(summary.round)} 不存在`]
        : [];
    },
  };
}

/**
 * M11.2.3（D-3 §8）：定向证据采证——对 resolution 判定 ground_existing_source
 * 的 claim，在**已有全文**的源上做 chunk 检索 → 逐字 quote → 三段核验
 * （quote 逐字 / metadata / semantic judge）→ verified evidence 落库。
 * 不重跑 Search / Matrix / Synthesis（零新文献检索）；失败如实回落弱化 /
 * 删除（resolution 阶梯的第 4-7 步），不硬配证据。
 */
function evidenceGroundClaimsStage(services: WorkflowServices): StageSpec {
  return {
    id: "evidence.ground_claims",
    description: "定向证据采证（在库全文 → verified evidence → 回绑 claim 修复派发）",
    requiredInputs: ["revision.plan"],
    producedOutputs: ["evidence/evidence.jsonl（verified 追加）"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs * 2, // 每 claim ≤3 chunk 的语义 judge，预算放宽
    retryable: ["transient", "timeout", "runtime_unavailable"],
    async execute(ctx) {
      const summary = await latestReviewSummary(services, ctx.projectId);
      if (summary === null) {
        throw new BusinessError("STAGE_CONTRACT_VIOLATION", "缺少 review 汇总（先执行 review.run）");
      }
      const resolution = await services.reviewArtifacts.loadClaimResolution(ctx.projectId, summary.round);
      if (resolution === null) {
        return { round: summary.round, requests: 0, verifiedClaims: 0, verifiedEvidence: 0, outcomes: [] };
      }
      const requests = resolution.resolutions
        .filter(
          (entry): entry is typeof entry & { sourceIds: string[] } =>
            entry.action === "ground_existing_source" &&
            entry.sourceIds !== undefined &&
            entry.sourceIds.length > 0,
        )
        .map((entry) => ({
          claimId: entry.claimId,
          claim: entry.claim,
          section: entry.section,
          sourceIds: entry.sourceIds,
        }));
      if (requests.length === 0) {
        return { round: summary.round, requests: 0, verifiedClaims: 0, verifiedEvidence: 0, outcomes: [] };
      }
      const result = await services.targetedGrounding.groundClaims(ctx.projectId, requests, {
        ...(ctx.signal.aborted ? { signal: ctx.signal } : {}),
      });
      await ctx.emitDomain(
        "evidence.ground_claims",
        {
          round: summary.round,
          requests: requests.length,
          verifiedClaims: result.verifiedClaims,
          verifiedEvidence: result.verifiedEvidence,
          unsupportedByJudge: result.unsupportedByJudge,
        },
        `定向采证完成：${result.verifiedClaims}/${requests.length} 条 claim 获得 verified evidence`,
      );
      return {
        round: summary.round,
        requests: requests.length,
        verifiedClaims: result.verifiedClaims,
        verifiedEvidence: result.verifiedEvidence,
        unsupportedByJudge: result.unsupportedByJudge,
        outcomes: result.outcomes.map((outcome) => ({
          claimId: outcome.claimId,
          status: outcome.status,
          evidenceIds: outcome.evidenceIds,
          ...(outcome.reason !== undefined ? { reason: outcome.reason } : {}),
        })),
      };
    },
    async verifyDod(ctx) {
      const summary = await latestReviewSummary(services, ctx.projectId);
      if (summary === null) {
        return ["缺少 review 汇总"];
      }
      const resolution = await services.reviewArtifacts.loadClaimResolution(ctx.projectId, summary.round);
      return resolution === null ? ["缺少 claim-resolution 产物（revision.plan 未产出）"] : [];
    },
  };
}

/**
 * Writer 修复编译错误（bounded repair loop）：每项目自动修复 ≤ MAX_AUTO_LATEX_REPAIRS 次。
 * 上下文刻意最小：只给受影响文件 + 结构化诊断（文件/行号/错误/附近行），
 * 绝不整篇论文 + 整份日志。修复只动语法，不改内容 / 引用。
 * 修复产生新修订 → 先前的 gate/build 结论自然过期，复审后才能 Final。
 */
function revisionRepairStage(services: WorkflowServices): StageSpec {
  return {
    id: "revision.repair_latex",
    description: `Writer 修复编译错误（bounded：≤ ${MAX_AUTO_LATEX_REPAIRS} 次）`,
    requiredInputs: ["build.draft"],
    producedOutputs: ["manuscript/sections/*.tex（语法修复）"],
    maxAttempts: 1,
    timeoutMs: services.stageTimeoutMs,
    retryable: [],
    async execute(ctx) {
      const build = ctx.state.stageResults["build.draft"] ?? {};
      const buildError = readBuildError(ctx.state);
      if (build["buildOk"] === true || buildError === undefined) {
        throw new BusinessError("STAGE_CONTRACT_VIOLATION", "没有可修复的编译错误（planner 误派发）");
      }
      const record = await loadBuildGateRecord(services.projects, ctx.projectId);
      const diagnostics = record?.diagnostics ?? [];
      // 有大纲时根 main.tex 是确定性组装产物：修复它要么必被重组覆盖（无意义），
      // 要么模型返回片段覆盖根文件（破坏组装）。诊断只指向组装根 → 本次修复
      // 记一次空尝试（bounded 预算照耗），走既有耗尽路径（带错误修订 / HITL / Build FAIL）。
      const outline = await services.manuscript.loadOutline(ctx.projectId);
      const files = repairTargetFiles(services, ctx.projectId, diagnostics).filter((file) => {
        const normalized = file.replaceAll("\\", "/").replace(/^\.\//, "");
        return !(outline !== null && normalized === "main.tex");
      });
      if (files.length === 0) {
        if (repairTargetFiles(services, ctx.projectId, diagnostics).length === 0) {
          throw new BusinessError(
            "STAGE_CONTRACT_VIOLATION",
            "编译诊断没有定位到 manuscript 内可修复的 .tex 文件",
          );
        }
        return {
          repairedFiles: [],
          skippedAssembledRoot: true,
          attempt: countCompletions(ctx.state, "revision.repair_latex") + 1,
        };
      }
      const repaired: string[] = [];
      for (const file of files) {
        if (ctx.signal.aborted) {
          throw new BusinessError("WORKFLOW_CANCELLED", "修复已被取消");
        }
        const absolute = safeManuscriptFile(services, ctx.projectId, file);
        if (absolute === null) {
          continue;
        }
        let current: string;
        try {
          current = await readFile(absolute, "utf8");
        } catch {
          continue; // 诊断指向的文件已不存在：跳过
        }
        const result = await services.writer.repairSection({
          projectId: ctx.projectId,
          sectionFile: file,
          currentLatex: current,
          buildError,
          diagnostics: diagnostics.filter((diagnostic) => diagnostic.file === file),
        });
        // 模型调用返回后立即检查取消：已取消的修复结果不落盘（不留半个修复）
        if (ctx.signal.aborted) {
          throw new BusinessError("WORKFLOW_CANCELLED", "修复已被取消");
        }
        await writeFile(absolute, result.latex.trim() + "\n", "utf8");
        repaired.push(file);
        await ctx.emitProgress({ file, repairedCount: repaired.length });
      }
      // 修复即改稿：提交修订（幂等；Writer 输出与原文相同则不产生新修订号）。
      // M9.5：bib 同步在提交前——引用集合变化与正文变化同一修订号
      await syncReferencesBib(services, ctx.projectId);
      const commit = await services.revisions.commit(ctx.projectId, "revision.repair_latex", ctx.runId);
      return {
        repairedFiles: repaired,
        attempt: countCompletions(ctx.state, "revision.repair_latex") + 1,
        revision: commit.revision,
        changed: commit.created,
      };
    },
  };
}

/** 不收敛 HITL：CONVERGED / REGRESSION / 计划无可派发条目 → 交给用户决策 */
function revisionStalledStage(services: WorkflowServices): StageSpec {
  return {
    id: "hitl.revision_stalled",
    description: "修订迭代不收敛（无实质改善 / 退化 / 无可派发条目），等待用户决策",
    requiredInputs: ["quality.gate"],
    producedOutputs: ["用户决策"],
    hitl: {
      prompt:
        "修订迭代不再收敛（连续无实质改善 / 出现退化 / 计划无可派发条目），继续自动修订可能无意义。请决策：接受为 Draft / 人工再修一轮 / 取消",
      options: ["accept_draft", "revise_more", "cancel"],
      payload: async (ctx) => {
        const gate = ctx.state.stageResults["quality.gate"] ?? {};
        const review = ctx.state.stageResults["review.run"] ?? {};
        const plan = ctx.state.stageResults["revision.plan"] ?? {};
        const gateRound = typeof gate["round"] === "number" ? gate["round"] : null;
        // 前后两轮记分卡对比（iteration-history；payload 允许 async 读产物）
        const iterations = await services.reviewArtifacts.loadIterations(ctx.projectId);
        const currentIteration =
          gateRound !== null ? iterations.find((record) => record.gateRound === gateRound) : undefined;
        const previousIteration =
          gateRound !== null ? iterations.filter((record) => record.gateRound < gateRound).at(-1) : undefined;
        const compare = (record: typeof currentIteration) =>
          record === undefined
            ? null
            : {
                round: record.gateRound,
                critical: record.scorecard.critical,
                major: record.scorecard.major,
                blocking: record.scorecard.blocking,
                academicScore: record.scorecard.academicScore,
                failedRuleIds: record.scorecard.failedRuleIds,
                ...(record.scorecard.unsupportedOpaque !== undefined
                  ? { unsupportedOpaque: record.scorecard.unsupportedOpaque }
                  : {}),
                ...(record.scorecard.factViolations !== undefined
                  ? { factViolations: record.scorecard.factViolations }
                  : {}),
                ...(record.scorecard.citationViolations !== undefined
                  ? { citationViolations: record.scorecard.citationViolations }
                  : {}),
              };
        /**
         * M11.2.1：失败归因分类（§14——报告与 artifact 必须区分「正常运行但
         * 质量未达」与「系统 bug / execution failure」）。确定性：剩余 gate
         * 阻止项若全部是质量语义（评分 / open issues / claim 覆盖）=
         * QUALITY_NOT_REACHED；事实 / 引用保持或契约类规则仍在失败 =
         * SYSTEM_FAILED（守卫语义未满足，冻结产物不安全）。
         * M11.2.3（D-4 §17/§18）：新增两个正常终态语义——
         * - NO_PROGRESS：跨轮 judgeConvergence 判 STALLED（连续两轮核心阻断
         *   指标无改善）——不是失败，是 bounded loop 的诚实停止；
         * - AUTHOR_DECISION_REQUIRED：剩余阻止项只有学术评分，且同轮 claim
         *   resolution 存在 author_decision_required（透明自述类 / 作者事实）
         *   ——进一步处置需要作者输入，语言模型改稿无法解决。
         */
        const gateReasons = ((gate["reasons"] as unknown[]) ?? []).map((reason) => String(reason));
        const convergence = typeof gate["convergence"] === "string" ? gate["convergence"] : null;
        let authorDecisionClaims = 0;
        if (convergence === "STALLED") {
          const reviewRound = typeof review["round"] === "number" ? review["round"] : null;
          if (reviewRound !== null) {
            const resolution = await services.reviewArtifacts.loadClaimResolution(ctx.projectId, reviewRound);
            authorDecisionClaims =
              resolution?.counts.author_decision_required ?? 0;
          }
        }
        // M11.3（Phase E）：终态语义统一走 classifyTerminalStatus（与 completion
        // summary / 报告同口径；guard 判定收敛进纯函数）
        const terminal = classifyTerminalStatus({
          gatePassed: false,
          gateReasons,
          convergence:
            convergence === "PROGRESS" || convergence === "STALLED" || convergence === "REGRESSED"
              ? convergence
              : null,
          authorDecisionClaims,
        });
        const failureClass = terminal.status;
        return {
          outcome: typeof gate["outcome"] === "string" ? gate["outcome"] : null,
          ...(convergence !== null ? { convergence } : {}),
          gateRound,
          gateReasons: gate["reasons"] ?? [],
          failureClass,
          ...(terminal.status !== "SYSTEM_FAILED" ? { failureMessage: terminal.message } : {}),
          review: {
            critical: review["critical"] ?? 0,
            major: review["major"] ?? 0,
            blocking: review["blocking"] ?? 0,
          },
          plan: {
            planned: typeof plan["planned"] === "number" ? plan["planned"] : null,
            skipped: typeof plan["skipped"] === "number" ? plan["skipped"] : null,
          },
          scorecard: { current: compare(currentIteration), previous: compare(previousIteration) },
          // M11.2.3（§16）：本轮质量差值（resolved / new regressions）
          ...(gate["revisionDelta"] !== undefined ? { revisionDelta: gate["revisionDelta"] } : {}),
        };
      },
    },
  };
}

/**
 * Finalize：双 Gate 对齐校验后冻结 Final PDF（纯确定性，无 LLM；
 * 校验全部在 FinalizeService 内：gate/build 必须通过且对齐当前修订）。
 */
function buildFinalStage(services: WorkflowServices): StageSpec {
  return {
    id: "build.final",
    description: "Finalize：双 Gate 对齐校验后冻结 Final PDF（确定性）",
    requiredInputs: ["build.draft"],
    producedOutputs: ["artifacts/art-final-rev{revision}.pdf"],
    maxAttempts: 1, // 幂等确定性操作；失败即业务条件不满足（如实上抛）
    timeoutMs: 60_000,
    retryable: [],
    async execute(ctx) {
      const result = await services.finalize.finalize(ctx.projectId, ctx.runId);
      await ctx.emitDomain(
        "final.created",
        {
          artifactId: result.final.artifactId,
          revision: result.revision,
          gateRound: result.gateRound,
          bytes: result.final.file.bytes,
        },
        `Final 产物已冻结（${result.final.artifactId}）`,
      );
      return {
        finalArtifactId: result.final.artifactId,
        draftArtifactId: result.draft.artifactId,
        revision: result.revision,
        gateRound: result.gateRound,
      };
    },
    async verifyDod(ctx) {
      const { final } = await services.artifacts.latest(ctx.projectId);
      if (final === null) {
        return ["artifacts/ 中没有 Final 产物"];
      }
      const revision = await services.revisions.currentRevision(ctx.projectId);
      return final.revision === revision
        ? []
        : [`Final 产物 revision（${final.revision}）≠ 当前修订（${revision}）`];
    },
  };
}

/**
 * M10.3 §15 revision.report：Revision Trace / Author Revision Report
 * （确定性投影，无 LLM）。外部意见逐条状态 + 修订计划条目终态 + 复核结果
 * → build/revision-response.md。不是 Response Letter——本轮没有第二轮
 * 审稿意见时如实呈现已有意见的登记状态，不假装是正式回复函。
 */
function revisionReportStage(services: WorkflowServices): StageSpec {
  return {
    id: "revision.report",
    description: "Revision Trace 报告：指令状态 + 计划条目 + 复核结果确定性投影",
    requiredInputs: [],
    producedOutputs: ["build/revision-response.md"],
    maxAttempts: 1,
    timeoutMs: 60_000,
    retryable: [],
    async execute(ctx) {
      const { final, draft } = await services.artifacts.latest(ctx.projectId);
      const revision = await services.revisions.currentRevision(ctx.projectId);
      const result = await writeRevisionResponse(
        {
          projects: services.projects,
          reviewArtifacts: services.reviewArtifacts,
          externalInstructions: services.externalInstructions,
        },
        ctx.projectId,
        {
          revision,
          finalArtifactId: final?.artifactId ?? null,
          draftArtifactId: draft?.artifactId ?? null,
        },
      );
      await ctx.emitDomain(
        "revision_report.created",
        { path: result.path, instructions: result.instructions },
        `Revision Trace 报告已产出（${result.instructions} 条外部意见 / ${result.planItems + result.improvementItems} 个计划条目）`,
      );
      return {
        reportPath: result.path,
        instructions: result.instructions,
        planItems: result.planItems,
        improvementItems: result.improvementItems,
        revision,
      };
    },
    async verifyDod(ctx) {
      try {
        await readFile(join(services.projects.buildDir(ctx.projectId), "revision-response.md"), "utf8");
        return [];
      } catch {
        return ["build/revision-response.md 不存在"];
      }
    },
  };
}

/**
 * M11.3（Phase D）：manuscript 全部 section 的确定性 citation 语法归一。
 * 修的只是 outcome 唯一明确的结构问题（见 citationSyntax.repairCitationSyntax）；
 * 返回计数供 stage result / 报告消费。写盘发生在修订 commit 之前（同修订号）。
 */
async function normalizeManuscriptCitationSyntax(
  services: WorkflowServices,
  projectId: string,
): Promise<{ fixed: number; unresolved: number; fixes: { kind: string; count: number }[] }> {
  const files = await collectLatexFiles(services.projects.manuscriptDir(projectId));
  const bibliography = await manuscriptBibliography(services, projectId);
  const bibKeys = bibliography.map((entry) => entry.key);
  let fixed = 0;
  const fixCounts = new Map<string, number>();
  const unresolvedIssues: unknown[] = [];
  for (const section of files.sections) {
    const result = repairCitationSyntax(section.content, section.relativePath, bibKeys);
    if (result.repaired) {
      await writeFile(
        join(services.projects.manuscriptDir(projectId), section.relativePath),
        result.content,
        "utf8",
      );
      fixed += result.fixes.reduce((sum, fix) => sum + fix.count, 0);
      for (const fix of result.fixes) {
        fixCounts.set(fix.kind, (fixCounts.get(fix.kind) ?? 0) + fix.count);
      }
    }
    unresolvedIssues.push(...result.unresolved);
  }
  return {
    fixed,
    unresolved: unresolvedIssues.length,
    fixes: [...fixCounts.entries()].map(([kind, count]) => ({ kind, count })),
  };
}

function revisionReviseStage(
  services: WorkflowServices,
  stageId: "revision.revise" | "revision.apply",
): StageSpec {
  return {
    id: stageId,
    description:
      stageId === "revision.apply"
        ? "Writer 按改进计划逐节修订（Existing-Paper）"
        : "Writer 按汇总审稿意见逐节修订（bounded loop）",
    requiredInputs: ["review.run"],
    producedOutputs: ["manuscript/sections/*.tex（修订）"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs * 4,
    // Direct workspace mutation is a deterministic contract violation; never replay Writer.
    retryable: ["transient", "timeout", "runtime_unavailable", "contract_violation"],
    async execute(ctx) {
      const outline = await services.manuscript.loadOutline(ctx.projectId);
      const files = await collectLatexFiles(services.projects.manuscriptDir(ctx.projectId));
      // M10.3：单文件 LaTeX 项目（无 \input / 无大纲）——main.tex 即用户全部
      // 内容，是整文件修订目标（不因「无 sections 目录」拒绝服务）
      const singleFile = outline === null && files.sections.length === 0 && files.mainTex !== null;
      const buildError = readBuildError(ctx.state);
      const evidence = await usableEvidence(services, ctx.projectId);
      // M11.2：综述修订——加载 survey 契约输入（outline / matrix / synthesis /
      // bibliography），为带 refs 的目标节注入结构红线（taxonomy / gap /
      // speculative 语气 / 引用白名单不得在修订中改写）
      const surveyInputs = isSurveyKind(ctx.state.workflowKind)
        ? await loadSurveyWritingInputs(services, ctx.projectId)
        : null;
      // M5.6 真实论文验收暴露的 Writer regression：Existing-Paper 项目没有 research
      // artifact bibliography，修订 prompt 曾写成「无可用文献：不要使用 \cite」，Writer
      // 据此删光了重建稿的全部 \cite。可引用 key 必须以 manuscript/references.bib 为准。
      const bibliography = await manuscriptBibliography(services, ctx.projectId);
      const project = await services.projects.getRequired(ctx.projectId);
      // M9.7.4：修订 prompt / skill 路由同样遵守 project.language
      const revisionLanguage = normalizeManuscriptLanguage(project.language);

      // 修订指令：shared loop 以落盘的确定性修订计划为准（计划缺失时回退执行期派生）；
      // apply 仍用改进计划（映射为 issue）
      const directives =
        stageId === "revision.apply"
          ? await collectRevisionDirectives(services, ctx.projectId, stageId)
          : await collectPlanDirectives(services, ctx.projectId);

      // M5.7 外部修改意见：独立派发通道（最高业务优先级；不占用 issue 通道，
      // 也不改 Quality Gate 口径）。pending / partially_handled / unresolved 派发；
      // handled / conflict 不再自动派发（conflict 保留在意见列表等人工决策）。
      const externalDirectives = await collectExternalDirectives(services, ctx.projectId);
      const sectionScopedExternals = externalDirectives.filter(
        (directive) => directive.section !== undefined,
      );
      const externalOutcomeReports: ExternalOutcomeReport[] = [];
      const patchValidationRecords: PatchValidationRecord[] = [];
      const currentRevision = await services.revisions.currentRevision(ctx.projectId);

      const targets = listRevisionTargets(outline, files, [
        ...directives,
        ...sectionScopedExternals.map((directive) => ({
          match: (target: RevisionTarget) =>
            sectionMatches(directive.section ?? "", target) ? externalScopeIssue() : null,
        })),
      ]);
      if (targets.length === 0) {
        throw new BusinessError("STAGE_CONTRACT_VIOLATION", "没有任何可修订的章节文件");
      }
      const boundedTargets = targets.flatMap((target) => target.logicalSpan !== undefined ? [target.logicalSpan] : []);
      for (let index = 0; index < boundedTargets.length; index += 1) {
        for (let other = index + 1; other < boundedTargets.length; other += 1) {
          if (revisionSpansOverlap(boundedTargets[index]!, boundedTargets[other]!)) {
            throw new BusinessError("STAGE_CONTRACT_VIOLATION", "REVISION_PATCH_OVERLAP");
          }
        }
      }
      // M10.4.4 派发覆盖诊断（确定性、只读）：进入派发的 finding 有多少真正
      // 命中修订目标——unmatched 条目不会进入任何 Writer prompt（永久滞留
      // planned，需复审 / HITL 兜底）；multiTarget = 命中多个目标（M9.7.6
      // 同 id 合并语义，grounded 多目标派发，显式计数不静默）。
      const dispatchTargetCounts = directives.map(
        (directive) => targets.filter((target) => directive.match(target) !== null).length,
      );
      const dispatchMatched = dispatchTargetCounts.filter((count) => count > 0).length;
      const findingDispatch = {
        total: directives.length,
        matched: dispatchMatched,
        unmatched: directives.length - dispatchMatched,
        multiTarget: dispatchTargetCounts.filter((count) => count > 1).length,
      };
      const revised: string[] = [];
      // M6.7：本轮流派发的计划条目（planned → applied 的依据；确定性 diff 补 targetChanged）
      const dispatchedItems: { id: string; targetChanged: boolean }[] = [];
      // 条目关联证据的记录池（§6 修改前依据；formal 快照之外的库内记录也可见）
      const itemEvidence = await services.evidence.list(ctx.projectId);
      const evidenceById = new Map(itemEvidence.map((record) => [record.id, record]));
      // M9.7.6 Claim Grounding：本修订轮消费的 claim grounding 报告（与派发指令
      // 同源 = 最新 review 轮；legacy 项目无该产物 → null → 不注入 Repair Context）
      const revisionSummary = await latestReviewSummary(services, ctx.projectId);
      const claimGrounding =
        revisionSummary !== null
          ? await services.reviewArtifacts.loadClaimGrounding(ctx.projectId, revisionSummary.round)
          : null;
      // M11.2.3（D-3）：定向采证结果（evidence.ground_claims stage 产物）——
      // claim grounding 报告是采证前快照，新 verified evidence 在此回绑派发
      const groundedClaims = collectGroundedClaimEvidence(ctx.state);
      let claimRepairsDispatched = 0;
      for (const [index, target] of targets.entries()) {
        if (ctx.signal.aborted) {
          throw new BusinessError("WORKFLOW_CANCELLED", "修订已被取消");
        }
        const matchedDirectives = directives.filter((directive) => directive.match(target) !== null);
        const issues = matchedDirectives.map((directive) => directive.match(target)) as ReviewIssue[];
        const matchedItems = matchedDirectives
          .map((directive) => directive.item)
          .filter((item): item is RevisionPlanItem => item !== undefined);
        const protocolIds = [...new Set(matchedItems.flatMap((item) => item.protocolRequirement?.protocolId ? [item.protocolRequirement.protocolId] : []))];
        const recordProtocolId = protocolIds.length === 1 ? protocolIds[0] : undefined;
        // M9.7.6：UNSUPPORTED / CONTRADICTED claim 的 evidence-aware Repair
        // Context（复用该轮 claim grounding 报告；候选只含 formal evidence）。
        const claimRepairs: ClaimRepairDirective[] =
          claimGrounding !== null
            ? buildClaimRepairDirectives(
                claimGrounding,
                (claimSection) => sectionMatches(claimSection, target),
                evidenceById,
                bibliography,
              )
            : [];
        mergeGroundedEvidenceIntoRepairs(claimRepairs, groundedClaims, evidenceById, bibliography);
        // M11.2：本目标的 survey 写作上下文（有 refs 的节；framing / abstract 走通用守卫）
        const surveyContext =
          surveyInputs !== null && outline !== null
            ? (() => {
                const section = outline.sections.find((candidate) => candidate.id === target.key);
                if (
                  section === undefined ||
                  ((section.synthesisRefs ?? []).length === 0 &&
                    (section.literatureRefs ?? []).length === 0)
                ) {
                  return undefined;
                }
                return buildSurveySectionContext({
                  section,
                  matrix: surveyInputs.matrix,
                  synthesis: surveyInputs.synthesis,
                  bibliography: surveyInputs.bibliography,
                  evidence: surveyInputs.evidence,
                  titleBySource: surveyInputs.titleBySource,
                  yearBySource: surveyInputs.yearBySource,
                });
              })()
            : undefined;
        // 该目标命中的外部意见：指定章节的按匹配；未指定章节的全篇派发
        const targetExternals = externalDirectives.filter((directive) =>
          directive.section !== undefined
            ? sectionMatches(directive.section, target)
            : target.logicalSpan !== undefined
              ? matchedItems.some((item) => item.instructionId === directive.instructionId)
              : true,
        );
        if (
          issues.length === 0 &&
          buildError === undefined &&
          targetExternals.length === 0 &&
          claimRepairs.length === 0
        ) {
          continue; // 无问题的章节不动（不烧 Token）
        }
        claimRepairsDispatched += claimRepairs.length;
        // 章节人类标题（大纲 id → title；缺大纲时回退 id）：修订 prompt 以标题称呼章节
        const sectionMeta = outline?.sections.find((section) => section.id === target.key);
        const isAbstractTarget = target.key === "abstract";
        // M10.3：单文件项目的 main.tex 目标 = 整文件修订（输出完整文件）
        const isWholeFileTarget = singleFile && target.relativePath === "main.tex" && target.logicalSpan === undefined;
        const targetFilePath = join(services.projects.manuscriptDir(ctx.projectId), target.relativePath);
        const fileBefore = target.logicalSpan !== undefined ? await readFile(targetFilePath, "utf8") : undefined;
        const resolvedSpan = target.logicalSpan !== undefined
          ? locateLatexSections(target.relativePath, fileBefore ?? "").find((span) => span.logicalSection === target.logicalSpan?.logicalSection)
          : undefined;
        if (target.logicalSpan !== undefined && resolvedSpan === undefined) {
          throw new BusinessError("STAGE_CONTRACT_VIOLATION", `Revision target no longer resolves: ${target.logicalSpan.logicalSection}`);
        }
        const requiredProtocols = new Set(matchedItems.flatMap((item) => item.protocolRequirement ? [item.protocolRequirement.protocolId] : []));
        if (requiredProtocols.size > 1) {
          throw new BusinessError("STAGE_CONTRACT_VIOLATION", "REVISION_PROTOCOL_SCOPE_CONFLICT");
        }
        const targetEvidence = requiredProtocols.size === 1
          ? filterEvidenceForProtocol(evidence, { protocolId: [...requiredProtocols][0]! })
          : evidence;
        let result: Awaited<ReturnType<typeof services.writer.reviseSection>> | undefined;
        let writerFailure: unknown;
        try {
          result = await services.writer.reviseSection({
          projectId: ctx.projectId,
          section: {
            id: target.key,
            file: target.relativePath.replaceAll("\\", "/").split("/").pop() ?? target.key,
            title: isAbstractTarget ? "摘要" : (sectionMeta?.title ?? resolvedSpan?.heading ?? target.key),
          },
          outline: outline ?? { title: project.title, sections: [] },
          currentLatex: resolvedSpan?.content ?? target.currentLatex,
          issues,
          evidence: targetEvidence,
          bibliography,
          ...(isWholeFileTarget
            ? {
                wholeFile: true,
                // M10.3.1：模型改用 write/edit 直接改盘时的确定性回退读取路径
                targetFilePath: join(services.projects.manuscriptDir(ctx.projectId), target.relativePath),
              }
            : {}),
          ...(resolvedSpan !== undefined ? { proposalOnly: true } : {}),
          ...(revisionLanguage !== undefined ? { language: revisionLanguage } : {}),
          ...(buildError !== undefined ? { buildError } : {}),
          ...(targetExternals.length > 0 ? { externalDirectives: targetExternals } : {}),
          ...(claimRepairs.length > 0 ? { claimRepairs } : {}),
          ...(surveyContext !== undefined ? { survey: surveyContext } : {}),
          ...(matchedItems.length > 0
            ? {
                revisionItems: matchedItems,
                itemEvidence,
              }
            : {}),
          });
        } catch (error) {
          writerFailure = error;
        }
        if (resolvedSpan !== undefined && fileBefore !== undefined) {
          const beforeHash = revisionSourceHash(fileBefore);
          let afterWriter: string | null = null;
          try { afterWriter = await readFile(targetFilePath, "utf8"); } catch { /* missing / unreadable workspace is a mutation signal */ }
          if (afterWriter === null || hasRevisionWorkspaceMutation(beforeHash, afterWriter)) {
            const failedRecord: PatchValidationRecord = {
              patchId: `patch:${resolvedSpan.originalHash.slice(0, 12)}`,
              revisionId: `rev-${currentRevision + 1}`,
              file: target.relativePath,
              logicalTarget: resolvedSpan.logicalSection,
              planItemIds: matchedItems.map((item) => item.id),
              commentIds: [...new Set([
                ...matchedItems.flatMap((item) => item.instructionId ? [item.instructionId] : []),
                ...targetExternals.map((directive) => directive.instructionId),
              ])],
              evidenceIds: [...new Set(matchedItems.flatMap((item) => item.relatedEvidenceIds ?? []))],
              ...(recordProtocolId !== undefined ? { protocolId: recordProtocolId } : {}),
              beforeFileHash: beforeHash,
              beforeTargetHash: resolvedSpan.originalHash,
              proposedReplacementHash: result?.latex !== undefined ? revisionSourceHash(result.latex.trim()) : "",
              afterFileHash: afterWriter === null ? "unreadable" : revisionSourceHash(afterWriter),
              scope: { ok: false, violations: ["DIRECT_WORKSPACE_MUTATION"] },
              workspaceIntegrity: { ok: false, directMutationDetected: true, recoveryAttempted: true, recoverySucceeded: false },
              fact: { ok: false, findingIds: [], violations: ["NOT_RUN_DIRECT_WORKSPACE_MUTATION"] },
              citation: { ok: false, findingIds: [], addedKeys: [], removedKeys: [], violations: ["NOT_RUN_DIRECT_WORKSPACE_MUTATION"] },
              evidence: { ok: false, violations: ["NOT_RUN_DIRECT_WORKSPACE_MUTATION"] },
              apply: { ok: false, status: "rejected" },
              overall: "fail",
              failedStage: "workspaceIntegrity",
            };
            try {
              await writeFile(targetFilePath, fileBefore, "utf8");
              const restored = await readFile(targetFilePath, "utf8");
              if (revisionSourceHash(restored) !== beforeHash) throw new Error("snapshot hash mismatch");
              failedRecord.afterFileHash = revisionSourceHash(restored);
              failedRecord.workspaceIntegrity.recoverySucceeded = true;
            } catch (error) {
              patchValidationRecords.push(failedRecord);
              await services.reviewArtifacts.savePatchValidation(ctx.projectId, {
                revisionId: failedRecord.revisionId, revision: currentRevision + 1,
                records: patchValidationRecords, summary: summarizePatchValidation(patchValidationRecords),
              });
              throw new BusinessError(
                "REVISION_WORKSPACE_RECOVERY_FAILED",
                `REVISION_WORKSPACE_RECOVERY_FAILED patch:${resolvedSpan.originalHash.slice(0, 12)} target:${resolvedSpan.logicalSection}${error instanceof Error ? ` (${error.message})` : ""}`,
              );
            }
            patchValidationRecords.push(failedRecord);
            await services.reviewArtifacts.savePatchValidation(ctx.projectId, {
              revisionId: failedRecord.revisionId, revision: currentRevision + 1,
              records: patchValidationRecords, summary: summarizePatchValidation(patchValidationRecords),
            });
            throw new BusinessError("DIRECT_WORKSPACE_MUTATION", `DIRECT_WORKSPACE_MUTATION patch:${resolvedSpan.originalHash.slice(0, 12)} target:${resolvedSpan.logicalSection}`);
          }
        }
        if (writerFailure !== undefined) throw writerFailure;
        if (result === undefined) throw new BusinessError("STAGE_CONTRACT_VIOLATION", "REVISION_WRITER_NO_RESULT");
        // M5.7：确定性 diff 补记 targetChanged（"已处理"不采信 Writer 自称）。
        // M9.7.6 P0：一条 finding 的 section 引用可能命中多个修订目标（如
        // 「sections/a.tex（并见 sections/b.tex）」），同 id 只记一次，
        // targetChanged 跨目标 OR——下游 transitions 不再产生重复 id。
        const targetChanged = result.latex.trim() !== target.currentLatex.trim();
        for (const item of matchedItems) {
          const existing = dispatchedItems.find((entry) => entry.id === item.id);
          if (existing === undefined) {
            dispatchedItems.push({ id: item.id, targetChanged });
          } else {
            existing.targetChanged = existing.targetChanged || targetChanged;
          }
        }
        for (const report of result.externalOutcomes ?? []) {
          externalOutcomeReports.push({
            ...report,
            targetChanged,
            target: `${target.relativePath}#${target.logicalSpan?.heading ?? target.key}`,
            planItemIds: matchedItems.map((item) => item.id),
            evidenceIds: [...new Set(matchedItems.flatMap((item) => item.relatedEvidenceIds ?? []))],
            patchIds: target.logicalSpan !== undefined ? [`patch:${target.logicalSpan.originalHash.slice(0, 12)}`] : [],
            verification: target.logicalSpan !== undefined ? { scope: true } : {},
          });
        }
        if (isAbstractTarget) {
          // 摘要修订写回 outline.abstract（独立可写载体）；后续 writeMainTex 重组时生效
          if (outline !== null) {
            outline.abstract = result.latex.trim();
            await services.manuscript.saveOutline(ctx.projectId, outline);
          }
        } else {
          let output = result.latex.trim() + "\n";
          if (resolvedSpan !== undefined && fileBefore !== undefined) {
            const latestFile = await readFile(targetFilePath, "utf8");
            const sha256 = revisionSourceHash;
            // fileBefore is the immutable revision boundary. A scoped Writer may only
            // return a proposal; any disk mutation is rejected and the snapshot restored.
            if (sha256(latestFile) !== sha256(fileBefore)) {
              throw new BusinessError("STAGE_CONTRACT_VIOLATION", "REVISION_BASELINE_STALE");
            }
            const actualBeforeApply = await readFile(targetFilePath, "utf8");
            if (sha256(actualBeforeApply) !== sha256(fileBefore)) {
              throw new BusinessError("STAGE_CONTRACT_VIOLATION", "REVISION_BASELINE_STALE");
            }
            const candidate = applyRevisionSpan(fileBefore, resolvedSpan, result.latex.trim());
            const persistScopeFailure = async (violation: string, rejectedCandidate: string): Promise<void> => {
              const failed: PatchValidationRecord = {
                patchId: `patch:${resolvedSpan.originalHash.slice(0, 12)}`,
                revisionId: `rev-${currentRevision + 1}`,
                file: target.relativePath,
                logicalTarget: resolvedSpan.logicalSection,
                planItemIds: matchedItems.map((item) => item.id),
                commentIds: [...new Set([
                  ...matchedItems.flatMap((item) => item.instructionId ? [item.instructionId] : []),
                  ...targetExternals.map((directive) => directive.instructionId),
                ])],
                evidenceIds: [...new Set(matchedItems.flatMap((item) => item.relatedEvidenceIds ?? []))],
                ...(recordProtocolId !== undefined ? { protocolId: recordProtocolId } : {}),
                beforeFileHash: revisionSourceHash(fileBefore),
                beforeTargetHash: resolvedSpan.originalHash,
                proposedReplacementHash: revisionSourceHash(result.latex.trim()),
                afterFileHash: revisionSourceHash(rejectedCandidate),
                scope: { ok: false, violations: [violation] },
                workspaceIntegrity: { ok: true, directMutationDetected: false, recoveryAttempted: false, recoverySucceeded: true },
                fact: { ok: false, findingIds: [], violations: ["NOT_RUN_SCOPE_REJECTED"] },
                citation: { ok: false, findingIds: [], addedKeys: [], removedKeys: [], violations: ["NOT_RUN_SCOPE_REJECTED"] },
                evidence: { ok: false, violations: ["NOT_RUN_SCOPE_REJECTED"] },
                apply: { ok: false, status: "rejected" },
                overall: "fail",
                failedStage: "scope",
              };
              patchValidationRecords.push(failed);
              await services.reviewArtifacts.savePatchValidation(ctx.projectId, {
                revisionId: failed.revisionId, revision: currentRevision + 1,
                records: patchValidationRecords, summary: summarizePatchValidation(patchValidationRecords),
              });
            };
            const scope = checkGlobalRevisionScope(fileBefore, candidate, [resolvedSpan]);
            if (!scope.allowed) {
              await persistScopeFailure(scope.reason ?? "REVISION_SCOPE_VIOLATION", candidate);
              throw new BusinessError("STAGE_CONTRACT_VIOLATION", `${scope.reason ?? "REVISION_SCOPE_VIOLATION"} patch:${resolvedSpan.originalHash.slice(0, 12)} target:${resolvedSpan.logicalSection}`);
            }
            if (hasNewContentAfterDocumentEnd(fileBefore, candidate)) {
              await persistScopeFailure("REVISION_SOURCE_HYGIENE_VIOLATION", candidate);
              throw new BusinessError("STAGE_CONTRACT_VIOLATION", "REVISION_SOURCE_HYGIENE_VIOLATION");
            }
            output = candidate;
            await writeFile(targetFilePath, output, "utf8");
            const actualFinal = await readFile(targetFilePath, "utf8");
            const finalScope = checkGlobalRevisionScope(fileBefore, actualFinal, [resolvedSpan]);
            if (sha256(actualFinal) !== sha256(output) || !finalScope.allowed) {
              await writeFile(targetFilePath, fileBefore, "utf8");
              await persistScopeFailure("REVISION_FINAL_WORKSPACE_MISMATCH", actualFinal);
              throw new BusinessError("STAGE_CONTRACT_VIOLATION", "REVISION_FINAL_WORKSPACE_MISMATCH");
            }
            const patchRecord: PatchValidationRecord = {
              patchId: `patch:${resolvedSpan.originalHash.slice(0, 12)}`,
              revisionId: `rev-${currentRevision + 1}`,
              file: target.relativePath,
              logicalTarget: resolvedSpan.logicalSection,
              planItemIds: matchedItems.map((item) => item.id),
              commentIds: [...new Set([
                ...matchedItems.flatMap((item) => item.instructionId ? [item.instructionId] : []),
                ...targetExternals.map((directive) => directive.instructionId),
              ])],
              evidenceIds: [...new Set(matchedItems.flatMap((item) => item.relatedEvidenceIds ?? []))],
              ...(recordProtocolId !== undefined ? { protocolId: recordProtocolId } : {}),
              beforeFileHash: revisionSourceHash(fileBefore),
              beforeTargetHash: resolvedSpan.originalHash,
              proposedReplacementHash: revisionSourceHash(result.latex.trim()),
              afterFileHash: revisionSourceHash(actualFinal),
              scope: { ok: true, violations: [] },
              workspaceIntegrity: { ok: true, directMutationDetected: false, recoveryAttempted: false, recoverySucceeded: true },
              fact: { ok: true, findingIds: [], violations: [] },
              citation: (() => {
                const beforeKeys = new Set(extractCitationKeys(resolvedSpan.file, resolvedSpan.content).keys);
                const proposalKeys = new Set(extractCitationKeys(resolvedSpan.file, result.latex).keys);
                const addedKeys = [...proposalKeys].filter((key) => !beforeKeys.has(key));
                const removedKeys = [...beforeKeys].filter((key) => !proposalKeys.has(key));
                const missingKeys = addedKeys.filter((key) => !bibliography.some((entry) => entry.key === key));
                return {
                  ok: missingKeys.length === 0,
                  findingIds: missingKeys.map((key) => `citation:${currentRevision + 1}:MISSING_CITATION_KEY:${key}`),
                  addedKeys,
                  removedKeys,
                  violations: missingKeys.map(() => "MISSING_CITATION_KEY"),
                };
              })(),
              evidence: { ok: true, violations: [] },
              apply: { ok: true, status: "applied" },
              overall: "pass",
            };
            patchValidationRecords.push(patchRecord);
            await services.reviewArtifacts.savePatchValidation(ctx.projectId, {
              revisionId: patchRecord.revisionId, revision: currentRevision + 1,
              records: patchValidationRecords, summary: summarizePatchValidation(patchValidationRecords),
            });
            revised.push(target.key);
            await ctx.emitProgress({ section: target.key, index: index + 1, revisedCount: revised.length });
            continue;
          }
          await writeFile(
            targetFilePath,
            output,
            "utf8",
          );
        }
        revised.push(target.key);
        await ctx.emitProgress({
          section: target.key,
          index: index + 1,
          revisedCount: revised.length,
        });
      }
      if (outline !== null) {
        await services.manuscript.writeMainTex(ctx.projectId, outline, bibliography.length > 0);
        await services.manuscript.rebuildContext(ctx.projectId, {
          evidenceStats: await services.evidence.stats(ctx.projectId),
        });
      }
      // M9.5：修订可能增删 \cite——bib 同步在提交前，引用表与正文同一修订号
      await syncReferencesBib(services, ctx.projectId);
      // M11.3（Phase D）：确定性 citation 语法归一（§20–§24）——只修 outcome
      // 唯一明确的结构问题（空 cite 移除 / 空 key 段清理 / 同命令重复 key 去重 /
      // key 完整命中 bib 的未闭合补右括号）；绝不猜 key（残缺 key 留
      // unresolved，编译诊断 / Quality Gate 报错 → Writer / 作者决策）。
      // 归一发生在提交前：与 Writer 改动落在同一修订号，守卫按同一口径核验。
      const syntaxNormalize = await normalizeManuscriptCitationSyntax(services, ctx.projectId);
      // 一轮修订 = 一个不可变修订号（全部章节写完后统一提交，不逐节切碎）
      const revision = await services.revisions.commit(ctx.projectId, stageId, ctx.runId);
      // M6.7 §5：派发条目 planned → applied（状态机落盘；携带修订号与确定性
      // targetChanged。无计划 / 执行期派生回退（apply 流程）时 dispatchedItems
      // 为空，自然跳过）
      if (dispatchedItems.length > 0) {
        const summary = await latestReviewSummary(services, ctx.projectId);
        const plan = summary !== null ? await services.reviewArtifacts.loadPlan(ctx.projectId, summary.round) : null;
        if (plan !== null) {
          const now = new Date().toISOString();
          const transitions: RevisionItemTransition[] = dispatchedItems
            .filter((entry) => plan.items.some((item) => item.id === entry.id && item.status === "planned"))
            .map((entry) => ({
              id: entry.id,
              to: "applied",
              reason: "dispatched",
              appliedAt: now,
              appliedRevision: revision.revision,
              targetChanged: entry.targetChanged,
            }));
          if (transitions.length > 0) {
            const applied = applyRevisionItemTransitions(plan, transitions, now);
            if (applied.changed) {
              await services.reviewArtifacts.savePlan(ctx.projectId, applied.plan);
            }
          }
        }
      }
      // M5.7：派发结果落回指令状态（确定性聚合：applied+真实变化 → handled 等）
      if (externalDirectives.length > 0) {
        const reportedIds = new Set(externalOutcomeReports.map((report) => report.instructionId));
        const unmatched = sectionScopedExternals
          .filter((directive) => !reportedIds.has(directive.instructionId))
          .map((directive) => directive.instructionId);
        const instructions = await services.externalInstructions.load(ctx.projectId);
        const dispatch: ExternalDispatchResult = {
          round: (await latestReviewSummary(services, ctx.projectId))?.round ?? 0,
          revision: revision.revision,
          outcomes: externalOutcomeReports,
          unmatched,
        };
        const applied = applyDispatchOutcome(instructions, dispatch, new Date().toISOString());
        if (applied.changed) {
          await services.externalInstructions.save(ctx.projectId, applied.instructions);
          const conflicts = applied.instructions.filter(
            (instruction) => instruction.status === "conflict",
          ).length;
          await ctx.emitDomain(
            "external_instructions.updated",
            {
              dispatched: externalOutcomeReports.length,
              unmatched: unmatched.length,
              conflicts,
              revision: revision.revision,
            },
            conflicts > 0
              ? `外部修改意见已派发：${externalOutcomeReports.length} 份报告，其中 ${conflicts} 条与实验事实冲突（保留原结果）`
              : `外部修改意见已派发并更新处理状态（${externalOutcomeReports.length} 份报告）`,
          );
        }
      }
      return {
        revisedSections: revised.length,
        sections: revised,
        revision: revision.revision,
        changed: revision.created,
        findingDispatch,
        ...(claimRepairsDispatched > 0 ? { claimRepairs: claimRepairsDispatched } : {}),
        ...(dispatchedItems.length > 0 ? { appliedItems: dispatchedItems.length } : {}),
        ...(externalDirectives.length > 0
          ? { externalInstructions: externalDirectives.length }
          : {}),
        // M11.3：确定性语法归一结果（透明可观测）
        ...(syntaxNormalize.fixed > 0 || syntaxNormalize.unresolved > 0
          ? { citationSyntax: syntaxNormalize }
          : {}),
      };
    },
    async verifyDod(ctx) {
      const violations: string[] = [];
      const outline = await services.manuscript.loadOutline(ctx.projectId);
      if (outline !== null) {
        const statuses = await services.manuscript.sectionStatuses(ctx.projectId);
        for (const section of outline.sections) {
          const status = statuses.find((candidate) => candidate.id === section.id);
          if (status !== undefined && status.exists && !status.nonEmpty) {
            violations.push(`修订后 sections/${section.file} 内容为空`);
          }
        }
      }
      return violations;
    },
  };
}

/**
 * Revision Validation（M6.7：修订写入后、复审前的条目级复核，纯确定性无 LLM）。
 *
 * Revision ≠ Correct Revision：对 sourceRevision → revision 的实际差异执行四类
 * 检查（Fact / Citation Preservation 复用 M5.6；Claim Strength 与 Evidence
 * Re-validation 为 M6.7 新增），结果归因到计划条目并把 applied 落到
 * validated / rejected / needs_review 终态（状态机保证合法流转）。
 *
 * blocked（rejected / block 级 claim finding）→ planner 进入
 * hitl.revision_validation（用户 approve / reject / needs_review）；
 * needs_review 不阻断循环，但 Quality Gate 的 revision_items_resolved 阻断 Final。
 */
function revisionValidateStage(services: WorkflowServices): StageSpec {
  return {
    id: "revision.validate",
    description:
      "Revision Validation：修订写入后逐条复核（Evidence 再核验 / Fact / Citation / Claim Strength）",
    requiredInputs: [],
    producedOutputs: ["reviews/revision-validation-r{round}.json", "revision-plan 条目终态回写"],
    maxAttempts: 1, // 纯确定性复核，重试无意义
    timeoutMs: 60_000,
    retryable: [],
    async execute(ctx) {
      const summary = await latestReviewSummary(services, ctx.projectId);
      if (summary === null) {
        throw new BusinessError("STAGE_CONTRACT_VIOLATION", "缺少 review 汇总（先执行 review.run）");
      }
      const round = summary.round;
      const plan = await services.reviewArtifacts.loadPlan(ctx.projectId, round);
      const revision = await services.revisions.currentRevision(ctx.projectId);
      const sourceRevision =
        plan?.sourceRevision !== undefined && plan.sourceRevision > 0 && plan.sourceRevision < revision
          ? plan.sourceRevision
          : Math.max(0, revision - 1);
      const previousFiles = await readSnapshotTex(services.revisions.snapshotDir(ctx.projectId, sourceRevision));
      const currentFiles = await readSnapshotTex(services.revisions.snapshotDir(ctx.projectId, revision));
      if (previousFiles === null || currentFiles === null) {
        // 快照缺失：如实失败（修订复核不能凭空跳过；restore 路径同样会走 null 中性规则）
        throw new BusinessError(
          "STAGE_CONTRACT_VIOLATION",
          `修订快照不可读（rev-${sourceRevision} / rev-${revision}），无法执行 Revision Validation`,
        );
      }
      const factPreservation = await computeFactPreservation(services, ctx.projectId, revision);
      const citationPreservation = await computeCitationPreservation(services, ctx.projectId, revision);
      const patchArtifact = await services.reviewArtifacts.loadPatchValidation(ctx.projectId, revision);
      if (patchArtifact !== null) {
        const texFile = (files: typeof previousFiles, file: string) => files.find((entry) => entry.file === file)?.content;
        const patchRecords = patchArtifact.records;
        const factFindings: FactFinding[] = factPreservation === null ? [] : [
          ...factPreservation.changedFacts, ...factPreservation.removedFacts, ...factPreservation.addedUnsupportedFacts,
          ...factPreservation.directionalChanges, ...factPreservation.formulaChanges, ...factPreservation.placeholderRegressions,
        ];
        const factAssigned = new Set<FactFinding>();
        for (const record of patchRecords) {
          const matching = factFindings.filter((finding) => finding.file === record.file &&
            (finding.section.toLocaleLowerCase() === record.logicalTarget.toLocaleLowerCase() ||
              finding.section.toLocaleLowerCase().includes(record.logicalTarget.toLocaleLowerCase()) ||
              record.logicalTarget.toLocaleLowerCase().includes(finding.section.toLocaleLowerCase())));
          for (const finding of matching) factAssigned.add(finding);
          record.fact = {
            ok: matching.length === 0,
            findingIds: matching.map((finding) => `fact:${revision}:${finding.file}:${finding.section}:${finding.kind}`),
            violations: matching.map((finding) => finding.reason),
          };
        }
        const unattributedFact = factFindings.filter((finding) => !factAssigned.has(finding));
        const citationFindings = [] as { patchId?: string; code: string; key: string; commentIds?: string[] }[];
        const previousMain = texFile(previousFiles, "main.tex");
        const currentMain = texFile(currentFiles, "main.tex");
        if (previousMain !== undefined && currentMain !== undefined) {
          const spans = locateLatexSections("main.tex", previousMain);
          const attribution = attributeCitationChangesToPatches({
            before: previousMain,
            after: currentMain,
            patches: patchRecords.map((record) => {
              const span = spans.find((candidate) => candidate.logicalSection === record.logicalTarget);
              return span === undefined ? null : { patchId: record.patchId, planItemIds: record.planItemIds, commentIds: record.commentIds, span, addedKeys: record.citation.addedKeys, removedKeys: record.citation.removedKeys };
            }).filter((entry): entry is NonNullable<typeof entry> => entry !== null),
            knownKeys: new Set((await services.citation.latestReport(ctx.projectId))?.static.bibEntries.map((entry) => entry.key) ?? []),
          });
          for (const finding of attribution.findings) {
            citationFindings.push({ ...(finding.patchId ? { patchId: finding.patchId } : {}), code: finding.code, key: finding.key, ...(finding.commentIds ? { commentIds: finding.commentIds } : {}) });
          }
          for (const record of patchRecords) {
            const own = attribution.findings.filter((finding) => finding.patchId === record.patchId);
            const violations = own.filter((finding) => finding.code === "MISSING_CITATION_KEY" ||
              (finding.code === "REMOVED_CITATION_KEY" && (citationPreservation?.unexpectedRemovedKeys.includes(finding.key) ?? true)));
            record.citation = {
              ok: record.citation.ok && violations.length === 0,
              findingIds: [...new Set([...record.citation.findingIds, ...own.map((finding) => `citation:${revision}:${finding.code}:${finding.key}`)])],
              addedKeys: [...new Set([...record.citation.addedKeys, ...own.filter((finding) => finding.code === "MISSING_CITATION_KEY" || finding.code === "ADDED_CITATION_KEY").map((finding) => finding.key)])],
              removedKeys: [...new Set([...record.citation.removedKeys, ...own.filter((finding) => finding.code === "REMOVED_CITATION_KEY").map((finding) => finding.key)])],
              violations: [...new Set([...record.citation.violations, ...violations.map((finding) => finding.code)])],
            };
          }
        }
        const unattributed = [
          ...unattributedFact.map(() => "UNATTRIBUTED_FACT_VIOLATION"),
          ...citationFindings.filter((finding) => finding.patchId === undefined &&
            (finding.code === "AMBIGUOUS_PATCH_ATTRIBUTION" || finding.code === "ADDED_CITATION_KEY" || finding.code === "MISSING_CITATION_KEY" ||
              (finding.code === "REMOVED_CITATION_KEY" && (citationPreservation?.unexpectedRemovedKeys.includes(finding.key) ?? true))))
            .map((finding) => finding.code === "AMBIGUOUS_PATCH_ATTRIBUTION" ? finding.code : "UNATTRIBUTED_CITATION_VIOLATION"),
        ];
        for (const record of patchRecords) {
          record.overall = record.scope.ok && record.workspaceIntegrity.ok && record.fact.ok && record.citation.ok && record.evidence.ok && record.apply.ok ? "pass" : "fail";
        }
        patchArtifact.summary = summarizePatchValidation(patchRecords, unattributed);
        patchArtifact.summary.publishable = patchArtifact.summary.publishable && (factPreservation?.ok ?? false) && (citationPreservation?.ok ?? false);
        await services.reviewArtifacts.savePatchValidation(ctx.projectId, patchArtifact);
      }
      const evidenceRecords = await services.evidence.list(ctx.projectId);
      // 新增引用的 evidence-backed 判定（与 gate 覆盖同源）
      const citationReport = await services.citation.latestReport(ctx.projectId);
      const evidenceLinks = new Map<string, string[]>();
      if (citationReport !== null) {
        for (const link of await buildEvidenceLinks(services, ctx.projectId)) {
          evidenceLinks.set(link.key, link.evidenceIds);
        }
      }
      const result = evaluateRevisionValidation({
        projectId: ctx.projectId,
        reviewRound: round,
        sourceRevision,
        revision,
        plan,
        previousFiles,
        currentFiles,
        factPreservation,
        citationPreservation,
        evidenceRecords,
        evidenceLinks,
      });
      const finalizedPatchArtifact = await services.reviewArtifacts.loadPatchValidation(ctx.projectId, revision);
      if (finalizedPatchArtifact !== null) {
        for (const record of finalizedPatchArtifact.records) {
          const staleEvidence = record.evidenceIds.filter((id) =>
            result.evidenceRecheck.find((entry) => entry.evidenceId === id)?.stillFormal !== true);
          record.evidence = {
            ok: staleEvidence.length === 0,
            violations: staleEvidence.map((id) => `EVIDENCE_NOT_FORMAL:${id}`),
          };
          record.overall = record.scope.ok && record.workspaceIntegrity.ok && record.fact.ok && record.citation.ok && record.evidence.ok && record.apply.ok ? "pass" : "fail";
        }
        finalizedPatchArtifact.summary = summarizePatchValidation(finalizedPatchArtifact.records, finalizedPatchArtifact.summary.unattributedViolations);
        finalizedPatchArtifact.summary.publishable = finalizedPatchArtifact.summary.publishable && result.ok;
        await services.reviewArtifacts.savePatchValidation(ctx.projectId, finalizedPatchArtifact);
      }
      // 条目终态回写（applied → validated / rejected / needs_review；非法流转 = 编排缺陷，如实抛错）
      if (plan !== null && result.items.length > 0) {
        const transitions: RevisionItemTransition[] = result.items.map((item) => ({
          id: item.id,
          to: item.status,
          reason:
            item.status === "validated"
              ? "validation_passed"
              : item.reasonCodes[0] ?? "validation_passed",
          detail: item.reasons[0]?.slice(0, 240),
        }));
        const applied = applyRevisionItemTransitions(plan, transitions, new Date().toISOString());
        // M9.10 Phase 1：缺失 transition 检测——本轮复核落定后仍停留在 applied 的
        // 条目 = 派发了执行却没走到任何复核终态（编排跳步 / 复核漏判），结构化
        // 拒绝而不是无声悬置（Quality Gate 只消费 validation result，不看计划残留）
        const stuck = findStuckAppliedItems(applied.plan);
        if (stuck.length > 0) {
          throw new RevisionProtocolError(
            "missing_transition",
            stuck.map((item) => ({
              code: "missing_transition" as const,
              id: item.id,
              from: "applied" as const,
              detail: `已派发（rev-${item.appliedRevision ?? "?"}）但未收到任何复核终态`,
            })),
            `修订条目缺失 transition（${stuck.map((item) => `${item.id}（applied 未复核）`).join("；")}）`,
          );
        }
        if (applied.changed) {
          await services.reviewArtifacts.savePlan(ctx.projectId, applied.plan);
        }
      }
      await services.reviewArtifacts.saveValidation(ctx.projectId, result);
      const validated = result.items.filter((item) => item.status === "validated").length;
      const rejected = result.items.filter((item) => item.status === "rejected").length;
      const needsReview = result.items.filter((item) => item.status === "needs_review").length;
      await ctx.emitDomain(
        "revision.validated",
        {
          validationId: result.validationId,
          planId: result.planId,
          revision,
          sourceRevision,
          validated,
          rejected,
          needsReview,
          claimStrengthFindings: result.claimStrength.length,
          blocked: result.blocked,
        },
        result.blocked
          ? `修订复核发现风险：${rejected} 条 rejected / ${result.claimStrength.filter((f) => f.action === "block").length} 处强 claim 弱证据（等待用户决策）`
          : `修订复核通过：${validated} 条 validated${needsReview > 0 ? `（${needsReview} 条 needs_review 待人工确认）` : ""}`,
      );
      return {
        validationId: result.validationId,
        planId: result.planId,
        round,
        revision,
        sourceRevision,
        validated,
        rejected,
        needsReview,
        claimStrengthFindings: result.claimStrength.length,
        uncoveredAddedKeys: result.uncoveredAddedKeys.length,
        blocked: result.blocked,
      };
    },
    async verifyDod(ctx) {
      const summary = await latestReviewSummary(services, ctx.projectId);
      if (summary === null) {
        return ["缺少 review 汇总"];
      }
      const validation = await services.reviewArtifacts.loadValidation(ctx.projectId, summary.round);
      return validation === null
        ? [`reviews/${services.reviewArtifacts.validationFileName(summary.round)} 不存在`]
        : [];
    },
  };
}

/**
 * M6.7 §11 HITL：修订复核发现风险项（事实漂移 / 引用丢失 / 强 claim 弱证据）时，
 * 不自动接受修改。用户三选一：
 * - approve：接受本轮修订（条目 → approved，Revision Gate 规则按用户决策放行并记录）
 * - reject：恢复修订前版本（revision.restore；后续照常复审，旧 Gate 自然 stale）
 * - needs_review：保留修订但标记待人工确认（Revision Gate 阻断 Final）
 */
function revisionValidationDecisionStage(services: WorkflowServices): StageSpec {
  return {
    id: "hitl.revision_validation",
    description: "修订复核发现风险项，等待用户决策（接受 / 恢复修订前版本 / 待人工确认）",
    requiredInputs: [],
    producedOutputs: ["用户决策"],
    hitl: {
      prompt:
        "本轮修订的自动复核发现风险项（实验事实漂移 / 引用无依据丢失 / 强 claim 弱证据）。继续复审前请决策：接受本轮修订（approve）/ 拒绝并恢复修订前版本（reject）/ 保留修订但标记待人工确认（needs_review，Final 将被阻断直至确认）",
      options: ["approve", "reject", "needs_review"],
      payload: async (ctx) => {
        const validation = await services.reviewArtifacts.latestValidation(ctx.projectId);
        if (validation === null) {
          return undefined;
        }
        return {
          validationId: validation.validationId,
          revision: validation.revision,
          sourceRevision: validation.sourceRevision,
          items: validation.items.map((item) => ({
            id: item.id,
            kind: item.kind,
            section: item.section,
            status: item.status,
            category: item.category,
            reasons: item.reasons.slice(0, 3),
          })),
          // M9.10 Phase 4：rejected 条目结构化报告（id + category + reason + evidence）
          rejectedItems: (validation.rejectedItems ?? []).slice(0, 10),
          claimStrength: validation.claimStrength.slice(0, 5),
          evidenceRecheck: validation.evidenceRecheck.filter((entry) => !entry.stillFormal).slice(0, 5),
          citationRemoved: validation.citationDelta.removed.filter((entry) => !entry.authorized).slice(0, 5),
          factPreservationOk: validation.factPreservation?.ok ?? null,
          // M9.10 Phase 3：事实违规的分类分布（A=真实漂移；B/C/D 已归入 formatChanges 不违规）
          factFindings: validation.factPreservation?.ok
            ? []
            : [
                ...(validation.factPreservation?.changedFacts ?? []).slice(0, 3),
                ...(validation.factPreservation?.removedFacts ?? []).slice(0, 3),
                ...(validation.factPreservation?.addedUnsupportedFacts ?? []).slice(0, 3),
              ].map((finding) => ({
                file: finding.file,
                reason: finding.reason,
                category: finding.classification?.category ?? "A",
                type: finding.classification?.type ?? finding.reason,
                severity: finding.classification?.severity ?? "high",
                before: finding.before,
                after: finding.after,
              })),
          formatChanges: validation.factPreservation?.formatChanges.length ?? 0,
        };
      },
    },
  };
}

/**
 * M6.7 HITL 决策：revision_validation。
 * 回答记录 validatedRevision（= 修订复核针对的修订号；下一轮复核不复用旧回答）。
 * reject 通过 ManuscriptRevisionStore.restore 恢复 sourceRevision 快照（历史修订
 * 永不改动，恢复本身也是新的不可变修订）。
 */
async function applyRevisionValidationDecision(
  services: WorkflowServices,
  state: WorkflowState,
  input: ResumeInput,
): Promise<void | "cancel"> {
  const validate = state.stageResults["revision.validate"] ?? {};
  const revision = typeof validate["revision"] === "number" ? validate["revision"] : null;
  if (revision === null) {
    throw new WorkflowInvalidStateError(state.runId, state.status, "缺少 revision.validate 结果（无法定位待决策的修订）");
  }
  const validation = await services.reviewArtifacts.latestValidation(state.projectId);
  if (validation === null || validation.revision !== revision) {
    throw new WorkflowInvalidStateError(state.runId, state.status, "修订复核产物缺失或与当前修订不对齐");
  }
  const markItems = async (to: "approved" | "needs_review", reason: "user_approved" | "user_needs_review") => {
    if (validation.planId === null) {
      return;
    }
    const plan = await services.reviewArtifacts.loadPlan(state.projectId, validation.reviewRound);
    if (plan === null || plan.planId !== validation.planId) {
      return;
    }
    const targets = plan.items.filter(
      // approve / needs_review 只落定未决条目（rejected / needs_review）；
      // validated 是机器复核终态，不接受用户翻转（要推翻应走 reject 恢复快照）
      (item) => item.status === "rejected" || item.status === "needs_review",
    );
    if (targets.length === 0) {
      return;
    }
    const transitions: RevisionItemTransition[] = targets.map((item) => ({
      id: item.id,
      to,
      reason,
      detail: `用户在修订复核 HITL 决策（验证 ${validation.validationId}）`,
    }));
    const applied = applyRevisionItemTransitions(plan, transitions, new Date().toISOString());
    if (applied.changed) {
      await services.reviewArtifacts.savePlan(state.projectId, applied.plan);
    }
  };
  if (input.decision === "cancel") {
    return "cancel";
  }
  if (input.decision === "approve") {
    await services.reviewArtifacts.saveValidation(
      state.projectId,
      withUserDecision(validation, "approve", new Date().toISOString()),
    );
    await markItems("approved", "user_approved");
    state.stageResults["hitl.revision_validation"] = { decision: "approve", validationId: validation.validationId };
    return;
  }
  if (input.decision === "needs_review") {
    await services.reviewArtifacts.saveValidation(
      state.projectId,
      withUserDecision(validation, "needs_review", new Date().toISOString()),
    );
    await markItems("needs_review", "user_needs_review");
    state.stageResults["hitl.revision_validation"] = { decision: "needs_review", validationId: validation.validationId };
    return;
  }
  if (input.decision === "reject") {
    // 恢复修订前版本：restore 提交新的不可变修订（reason=revision.restore，
    // Fact / Citation Preservation 对 restore 修订不可比较——不是 Writer 改稿）
    await services.revisions.restore(state.projectId, validation.sourceRevision);
    await services.reviewArtifacts.saveValidation(
      state.projectId,
      withUserDecision(validation, "reject", new Date().toISOString()),
    );
    state.stageResults["hitl.revision_validation"] = { decision: "reject", validationId: validation.validationId };
    return;
  }
  throw new WorkflowInvalidStateError(
    state.runId,
    state.status,
    `decision 只能是 approve / reject / needs_review / cancel（当前 "${input.decision}"）`,
  );
}


/**
 * M5.4 Style Polish 决策点（HITL；只在 stylePolicy=apply_once 且存在可润色 style
 * minor finding 时出现）。用户在此选择要应用的 finding（缺省全部）或只保留建议。
 * Quick Review（existing_paper_review）永不包含本节点。
 */
function stylePolishDecisionStage(services: WorkflowServices): StageSpec {
  return {
    id: "hitl.style_polish",
    description: "语言润色决策：选择要应用的 style 建议（apply）或只保留建议（skip）",
    requiredInputs: ["quality.gate"],
    producedOutputs: ["用户决策（selectedFindingIds）"],
    hitl: {
      prompt:
        "Quality Gate 已通过。当前有语言风格建议（style / minor）。你选择了「应用语言润色」：请勾选要应用的建议（默认全部）并确认；也可以只保留建议不修改稿件。润色只改表达，不改数字 / 引用 / 公式 / 术语 / 结论；修改后会重新审稿与门禁。",
      options: ["apply", "skip", "cancel"],
      payload: async (ctx) => {
        const summary = await services.reviewArtifacts.latestSummary(ctx.projectId);
        const gate = ctx.state.stageResults["quality.gate"] ?? {};
        const findings = summary === null ? [] : listStyleFindings(summary);
        return {
          stylePolicy: readStylePolicy(ctx.state.request),
          gateRound: typeof gate["round"] === "number" ? gate["round"] : null,
          reviewRound: summary?.round ?? null,
          reviewedRevision: summary?.reviewedRevision ?? null,
          findings,
          defaultSelectedIds: findings.map((finding) => finding.id),
          maxRounds: 1,
        };
      },
    },
  };
}

/**
 * M5.4 Style Polish 执行：Style ReviewFinding → deterministic style plan（只含被选中的
 * style minor）→ Writer（writing/style-polish，style-only）→ Style Invariant Checker
 * → 全部通过才写回并提交新修订；任一章节 invariant 失败则**不覆盖**当前修订，
 * 记录失败与具体 invariant，不自动重试 Writer。
 */
function stylePolishStage(services: WorkflowServices): StageSpec {
  return {
    id: "revision.style_polish",
    description: "语言润色（style-only；invariant 守卫；最多一轮）",
    requiredInputs: ["hitl.style_polish"],
    producedOutputs: ["reviews/style-plan-r{round}.json", "reviews/style-polish-r{round}.json", "manuscript（新修订，仅 invariant 全通过时）"],
    maxAttempts: 1, // 不自动重试 Writer；失败由用户决定是否重试或只看建议
    timeoutMs: services.stageTimeoutMs * 2,
    retryable: [],
    async execute(ctx) {
      const summary = await latestReviewSummary(services, ctx.projectId);
      if (summary === null) {
        throw new BusinessError("STAGE_CONTRACT_VIOLATION", "缺少 review 汇总（先执行 review.run）");
      }
      const marker = ctx.state.stageResults["hitl.style_polish"] ?? {};
      const selectedRaw = marker["selectedFindingIds"];
      const selectedFindingIds = Array.isArray(selectedRaw)
        ? selectedRaw.filter((id): id is string => typeof id === "string")
        : undefined;
      const sourceRevision =
        typeof summary.reviewedRevision === "number"
          ? summary.reviewedRevision
          : await services.revisions.currentRevision(ctx.projectId);
      const plan = buildStylePolishPlan({
        projectId: ctx.projectId,
        sourceRevision,
        reviewRound: summary.round,
        summary,
        ...(selectedFindingIds !== undefined ? { selectedFindingIds } : {}),
      });
      await services.reviewArtifacts.saveStylePlan(ctx.projectId, plan);
      const finish = async (
        status: StylePolishResult["status"],
        sections: StylePolishResult["sections"],
        revision?: number,
      ): Promise<Record<string, unknown>> => {
        const base: Omit<StylePolishResult, "fingerprint"> = {
          schemaVersion: 1,
          planId: plan.planId,
          projectId: ctx.projectId,
          reviewRound: plan.reviewRound,
          sourceRevision,
          status,
          ...(revision !== undefined ? { revision } : {}),
          selectedFindingIds: plan.items.map((item) => item.id),
          sections,
          completedAt: new Date().toISOString(),
        };
        const result: StylePolishResult = { ...base, fingerprint: fingerprintStylePolish(base) };
        await services.reviewArtifacts.saveStylePolishResult(ctx.projectId, result);
        const violations = sections.reduce((sum, section) => sum + section.violations.length, 0);
        await ctx.emitDomain(
          status === "applied" ? "style_polish.applied" : "style_polish.skipped",
          {
            status,
            planId: plan.planId,
            planned: plan.items.length,
            sections: sections.length,
            violations,
            ...(revision !== undefined ? { revision } : {}),
          },
          status === "applied"
            ? `语言润色已应用（修订 ${revision}），将重新审稿与门禁`
            : status === "failed"
              ? `语言润色未通过 invariant 检查（${violations} 项），原稿保留`
              : "没有可应用的语言风格建议",
        );
        return {
          status,
          changed: status === "applied",
          planId: plan.planId,
          round: plan.reviewRound,
          planned: plan.items.length,
          sourceRevision,
          ...(revision !== undefined ? { revision } : {}),
          polishedSections: sections.filter((section) => section.invariantOk).length,
          violations,
        };
      };
      if (plan.items.length === 0) {
        return finish("noop", []);
      }

      const outline = await services.manuscript.loadOutline(ctx.projectId);
      const files = await collectLatexFiles(services.projects.manuscriptDir(ctx.projectId));
      const directives: RevisionDirective[] = plan.items.map((item) => ({
        match: (target: RevisionTarget) => (sectionMatches(item.section, target) ? revisionPlanItemToIssue(item) : null),
      }));
      const targets = listRevisionTargets(outline, files, directives);
      const bibliographyKeys = (
        await manuscriptBibliography(services, ctx.projectId)
      ).map((entry) => entry.key);
      const protectedTerms = await loadGlossaryTerms(services.projects.manuscriptDir(ctx.projectId));
      const project = await services.projects.getRequired(ctx.projectId);

      const outputs: Array<{ target: RevisionTarget; latex: string; itemIds: string[]; report: ReturnType<typeof checkStyleInvariants> }> = [];
      for (const [index, target] of targets.entries()) {
        if (ctx.signal.aborted) {
          throw new BusinessError("WORKFLOW_CANCELLED", "语言润色已被取消");
        }
        const items = plan.items.filter((item) => sectionMatches(item.section, target));
        if (items.length === 0) {
          continue;
        }
        const sectionMeta = outline?.sections.find((section) => section.id === target.key);
        const isAbstractTarget = target.key === "abstract";
        const result = await services.writer.polishSectionStyle({
          projectId: ctx.projectId,
          section: {
            id: target.key,
            file: target.relativePath.replaceAll("\\", "/").split("/").pop() ?? target.key,
            title: isAbstractTarget ? "摘要" : (sectionMeta?.title ?? target.key),
          },
          currentLatex: target.currentLatex,
          items,
          protectedTerms,
          bibliographyKeys,
        });
        const report = checkStyleInvariants(target.currentLatex, result.latex, { protectedTerms });
        outputs.push({ target, latex: result.latex.trim(), itemIds: items.map((item) => item.id), report });
        await ctx.emitProgress({ section: target.key, index: index + 1, invariantOk: report.ok });
      }
      void project;
      const sections: StylePolishResult["sections"] = outputs.map((output) => ({
        section: output.target.key,
        itemIds: output.itemIds,
        invariantOk: output.report.ok,
        violations: output.report.violations.map((violation) => ({ rule: violation.rule, detail: violation.detail })),
      }));
      if (outputs.length === 0 || outputs.every((output) => output.latex === output.target.currentLatex.trim())) {
        // 没有可派发章节，或 Writer 判断无需改动（输出与原文逐字相同）：不提交空修订
        return finish("noop", sections);
      }
      if (outputs.some((output) => !output.report.ok)) {
        // 任一章节 invariant 失败：不覆盖当前修订（all-or-nothing），原稿保留
        return finish("failed", sections);
      }
      for (const output of outputs) {
        if (output.target.key === "abstract") {
          if (outline !== null) {
            outline.abstract = output.latex;
            await services.manuscript.saveOutline(ctx.projectId, outline);
          }
        } else {
          await writeFile(
            join(services.projects.manuscriptDir(ctx.projectId), output.target.relativePath),
            output.latex + "\n",
            "utf8",
          );
        }
      }
      if (outline !== null) {
        await services.manuscript.writeMainTex(ctx.projectId, outline, bibliographyKeys.length > 0);
        await services.manuscript.rebuildContext(ctx.projectId, {
          evidenceStats: await services.evidence.stats(ctx.projectId),
        });
      }
      const revision = await services.revisions.commit(ctx.projectId, "revision.style_polish", ctx.runId);
      return finish("applied", sections, revision.revision);
    },
    async verifyDod(ctx) {
      const result = await services.reviewArtifacts.latestStylePolishResult(ctx.projectId);
      return result === null ? ["reviews/style-polish-r*.json 不存在"] : [];
    },
  };
}

/**
 * M5.4 planner 片段：gate 通过后是否进入语言润色（纯函数，只看 state）。
 * - stylePolicy !== apply_once → 不进入（默认 suggest_only：minor 只是建议）
 * - 本 run 已执行过 revision.style_polish（无论 applied / failed / noop）→ 不再进入（最多一轮）
 * - 无可润色 style minor finding（review.run.styleMinor === 0）→ 不询问
 * - HITL 未回答 / 回答属于旧 gateRound → hitl.style_polish
 * - 回答 apply（同 gateRound）→ revision.style_polish；skip → 不进入
 * - M9.7.4：request.language="en" → 不进入——润色链是 zh 专用设计
 *   （zh skill + 中文 invariant 哨兵词表），en 项目静默跳过比错乱执行诚实；
 *   style findings 照常出现在 review 结果中（用户可见），仅无自动润色入口
 */
function planStylePolish(state: WorkflowState, gateRound: number): PlanDecision | null {
  if (readStylePolicy(state.request) !== "apply_once") {
    return null;
  }
  if (state.request?.["language"] === "en") {
    return null;
  }
  if (countCompletions(state, "revision.style_polish") > 0) {
    return null;
  }
  const review = state.stageResults["review.run"] ?? {};
  const styleMinor = typeof review["styleMinor"] === "number" ? review["styleMinor"] : 0;
  const marker = state.stageResults["hitl.style_polish"] as Record<string, unknown> | undefined;
  const markerRound = marker !== undefined && typeof marker["gateRound"] === "number" ? marker["gateRound"] : -1;
  const decision = marker !== undefined ? readMarkerDecision(state, "hitl.style_polish") : null;
  const answered = decision !== null && markerRound === gateRound;
  if (!answered) {
    return styleMinor > 0 ? { kind: "stage", stageId: "hitl.style_polish" } : null;
  }
  return decision === "apply" ? { kind: "stage", stageId: "revision.style_polish" } : null;
}

/**
 * 项目 canonical bibliography（M9.5）：文献库 SourceItem（authoritative
 * metadata）∪ research artifact bibliography（LLM 引用意图，同身份条目丢弃、
 * 其余确定性重 key）→ assignCitationKeys（冲突 a/b 消解、按 key 排序）。
 * 纯读派生（sources.list + research.json），不落盘、零 LLM。
 */
async function buildCanonicalBibliography(
  services: WorkflowServices,
  projectId: string,
): Promise<CanonicalBibliographyEntry[]> {
  const [items, artifact] = await Promise.all([
    services.sources.list(projectId),
    readResearchArtifact(services.projects, projectId),
  ]);
  return mergeArtifactBibliography(
    buildBibliographyFromSources(items),
    artifact?.bibliography ?? [],
  );
}

/**
 * references.bib 同步（M9.5 §10 生命周期）：按当前 manuscript 实际 \cite 的
 * key 集合从 canonical bibliography 确定性重渲染——只含实际引用文献。
 * 守卫（用户数据红线）：Existing-Paper 项目（PDF / LaTeX 导入，ProjectImport
 * 必写 workflowKind）的 references.bib 是用户或导入事实，任何情况下不改写；
 * 生成式项目（workflowKind 缺省或 idea_to_paper）+ 已有大纲 + canonical
 * 非空 + main.tex 存在才执行。幂等：同输入 byte identical。
 *
 * 调用时机纪律：只在**内容写作阶段提交修订之前**调用（writing.sections /
 * revision.revise / revision.repair_latex）——bib 变化必须与正文变化落在
 * 同一个修订号里，否则会在修订与 review 快照之间制造额外修订号，破坏
 * Citation Preservation 的 rev(n-1)→rev(n) 比较基线（2026-09-22 集成测试
 * 暴露：放在 citation.verify 里导致 rev2→rev3 的引用丢失被跳过）。
 */
async function syncReferencesBib(services: WorkflowServices, projectId: string): Promise<number> {
  const project = await services.projects.getRequired(projectId);
  if (isExistingPaperKind(project.workflowKind)) {
    // M10.3：Existing-Paper 项目的 references.bib 仍是用户/导入事实——既有条目
    // 任何情况下不改写；但修订引入的**新增引用**（正文 \cite 了 bib 中不存在的
    // key）允许追加式合并：仅当 key 存在于 canonical bibliography（promoted
    // 文献 / 检索入库）且有 formal evidence 关联（buildEvidenceLinks 同源）时，
    // 把确定性渲染的条目**追加**到实际解析的 bib 文件末尾。无证据支撑的新 key
    // 不追加 → citation.verify 报 missing → Writer 被要求删除（引用纪律）。
    return appendEvidenceBackedBibEntries(services, projectId);
  }
  const outline = await services.manuscript.loadOutline(projectId);
  if (outline === null) {
    return 0;
  }
  const bibliography = await buildCanonicalBibliography(services, projectId);
  if (bibliography.length === 0) {
    return 0;
  }
  const files = await collectLatexFiles(services.projects.manuscriptDir(projectId));
  if (files.mainTex === null) {
    return 0;
  }
  const cited = new Set<string>();
  for (const file of files.allTex) {
    for (const key of extractCitationKeys(file.relativePath, file.content).keys) {
      cited.add(key);
    }
  }
  return services.manuscript.writeBibliography(projectId, filterByCitedKeys(bibliography, cited));
}

/**
 * M10.3：Existing-Paper bib 追加式合并（append-only，幂等）。
 * 追加目标 = collectLatexFiles 解析出的实际 bib 文件（\bibliography{refs} →
 * refs.bib）；无解析结果时退回 references.bib。返回追加条数（0 = 无变化）。
 */
export async function appendEvidenceBackedBibEntries(
  services: WorkflowServices,
  projectId: string,
): Promise<number> {
  const files = await collectLatexFiles(services.projects.manuscriptDir(projectId));
  if (files.mainTex === null) {
    return 0;
  }
  const bibRelative = files.bibPath ?? "references.bib";
  const manuscriptDir = services.projects.manuscriptDir(projectId);
  let existingContent: string;
  try {
    existingContent = await readFile(join(manuscriptDir, bibRelative), "utf8");
  } catch {
    existingContent = "";
  }
  const existingKeys = new Set(parseBib(existingContent).entries.map((entry) => entry.key));
  const cited = new Set<string>();
  for (const file of files.allTex) {
    for (const key of extractCitationKeys(file.relativePath, file.content).keys) {
      cited.add(key);
    }
  }
  const missingKeys = [...cited].filter((key) => !existingKeys.has(key));
  if (missingKeys.length === 0) {
    return 0;
  }
  const canonical = await buildCanonicalBibliography(services, projectId);
  const canonicalByKey = new Map(canonical.map((entry) => [entry.key, entry]));
  // evidence 关联对 canonical 条目解析（追加的 key 尚不在 bib 文件中——
  // buildEvidenceLinks 的 bib 报告口径覆盖不到它）；匹配链与 Writer 引用
  // 纪律 / gate 覆盖同源（matchBibliographyKey）
  const evidenceRecords = await services.evidence.list(projectId);
  const linkedKeys = new Set<string>();
  for (const record of evidenceRecords) {
    if (!isFormalEvidence(record)) {
      continue;
    }
    const key = EvidenceSelectionService.matchBibliographyKey(record, canonical);
    if (key !== null) {
      linkedKeys.add(key);
    }
  }
  const toAppend = missingKeys
    .filter((key) => canonicalByKey.has(key) && linkedKeys.has(key))
    .sort()
    .map((key) => canonicalByKey.get(key)!)
    .slice(0, 20);
  if (toAppend.length === 0) {
    return 0;
  }
  const rendered = toAppend.map((entry) => renderBibEntry(entry).trim());
  const separator = existingContent === "" ? "" : existingContent.endsWith("\n") ? "" : "\n";
  await writeFile(
    join(manuscriptDir, bibRelative),
    `${existingContent}${separator}${rendered.join("\n\n")}\n`,
    "utf8",
  );
  return toAppend.length;
}

/**
 * 修订 / 润色可引用的参考文献 = canonical bibliography（M9.5 确定性 key）
 * ∪ manuscript/references.bib 现存条目（按 key 去重；Existing-Paper 重建项目
 * 只有后者）。references.bib 是引用 key 的事实源——Writer prompt 的「只允许
 * 引用以下 key」必须覆盖稿件里已有的全部 key，否则会把合法引用当成违规删除
 * （2026-09-14 真实论文验收 B2/A2 暴露）。
 */
async function manuscriptBibliography(
  services: WorkflowServices,
  projectId: string,
): Promise<BibliographyEntryInput[]> {
  const merged = new Map<string, BibliographyEntryInput>(
    (await buildCanonicalBibliography(services, projectId)).map((entry) => [entry.key, entry]),
  );
  try {
    const bib = await readFile(join(services.projects.manuscriptDir(projectId), "references.bib"), "utf8");
    for (const entry of parseBib(bib).entries) {
      if (!merged.has(entry.key)) {
        merged.set(entry.key, {
          key: entry.key,
          title: entry.title ?? entry.key,
          ...(entry.year !== undefined ? { year: entry.year } : {}),
          ...(entry.doi !== undefined ? { doi: entry.doi } : {}),
        });
      }
    }
  } catch {
    // 无 references.bib：只有 canonical bibliography
  }
  return [...merged.values()];
}

/** manuscript/glossary.json（可选）：受保护术语表（["术语", …] 或 {terms: [...]}） */
async function loadGlossaryTerms(manuscriptDir: string): Promise<string[]> {
  try {
    const parsed = JSON.parse(await readFile(join(manuscriptDir, "glossary.json"), "utf8")) as unknown;
    const raw = Array.isArray(parsed)
      ? parsed
      : typeof parsed === "object" && parsed !== null && Array.isArray((parsed as Record<string, unknown>)["terms"])
        ? ((parsed as Record<string, unknown>)["terms"] as unknown[])
        : [];
    return raw.filter((term): term is string => typeof term === "string" && term.trim() !== "").map((term) => term.trim()).slice(0, 200);
  } catch {
    return [];
  }
}

function revisionOverflowStage(): StageSpec {
  return {
    id: "hitl.revision_overflow",
    description: "自动修订轮数耗尽，等待用户决策",
    requiredInputs: ["quality.gate"],
    producedOutputs: ["用户决策"],
    hitl: {
      prompt: "自动修订已达上限，论文仍未通过 Quality Gate。请决策：接受为 Draft / 再修一轮（人工授权）/ 取消",
      options: ["accept_draft", "revise_more", "cancel"],
      payload: async (ctx) => {
        // 从 checkpoint 读取最近 gate / review / build 结果（不访问外部状态）
        const gate = ctx.state.stageResults["quality.gate"] ?? {};
        const review = ctx.state.stageResults["review.run"] ?? {};
        const build = ctx.state.stageResults["build.draft"] ?? {};
        return {
          gatePassed: gate["passed"] === true,
          gateReasons: gate["reasons"] ?? [],
          review: {
            critical: review["critical"] ?? 0,
            major: review["major"] ?? 0,
            blocking: review["blocking"] ?? 0,
          },
          buildOk: build["buildOk"] === true,
          buildError: build["buildError"] ?? null,
        };
      },
    },
  };
}

function buildDraftStage(services: WorkflowServices): StageSpec {
  return {
    id: "build.draft",
    description: "Build Gate：LaTeX 编译产出 PDF（质量语义不阻塞构建；D-0015）",
    requiredInputs: [],
    producedOutputs: ["build/paper.pdf", "build/compile.log", "build/build-gate.json"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs,
    retryable: ["transient", "timeout"],
    async execute(ctx) {
      // 编译前读取当前修订：record.revision 是 Finalize 的新鲜度依据
      const revision = await services.revisions.currentRevision(ctx.projectId);
      const { build, compile, record } = await runBuildGateForRevision(
        services.projects,
        services.latex,
        ctx.projectId,
        revision,
      );
      // M5.6：Draft 不受 Quality Gate 阻塞，但引用保持失败必须在 Draft 路径明确暴露
      // （Final 被阻止的原因不能只藏在 gate 产物里）
      const preservationFailure = await latestCitationPreservationFailure(services, ctx.projectId);
      const preservationView =
        preservationFailure !== null
          ? {
              passed: false,
              unexpectedRemovedKeys: preservationFailure.unexpectedRemovedKeys.slice(0, 8),
              previousCount: preservationFailure.previousCount,
              currentCount: preservationFailure.currentCount,
            }
          : null;
      const preservationNote =
        preservationFailure !== null
          ? `；注意：引用保持未通过（无依据删除 ${preservationFailure.unexpectedRemovedKeys.length} 个 key，Final 被阻止）`
          : "";
      await ctx.emitDomain(
        build.passed ? "build_gate.passed" : "build_gate.failed",
        {
          revision,
          reasons: build.reasons.slice(0, 5),
          tool: compile.tool,
          durationMs: compile.durationMs,
          ...(preservationView !== null ? { citationPreservation: preservationView } : {}),
        },
        build.passed
          ? `Build Gate 通过（PDF 已产出）${preservationNote}`
          : `Build Gate 失败：${build.reasons[0] ?? "编译失败"}${preservationNote}`,
      );
      // Build 通过即冻结 Draft（幂等；质量 Gate 不参与 Draft 判定）——除非实验事实被
      // 无依据篡改（M5.6 Fact Preservation，pair-02 盲评驱动）：与引用保持的「提示不
      // 拦截」不同，实验数据被改写后冻结的 Draft 本身就是不实结果，必须阻止产出。
      let draftArtifactId: string | undefined;
      if (build.passed) {
        const factFailure = await latestFactPreservationFailure(services, ctx.projectId);
        if (factFailure !== null) {
          const factView = {
            passed: false,
            changedFacts: factFailure.changedFacts.length,
            removedFacts: factFailure.removedFacts.length,
            addedUnsupportedFacts: factFailure.addedUnsupportedFacts.length,
            directionalChanges: factFailure.directionalChanges.length,
            formulaChanges: factFailure.formulaChanges.length,
            placeholderRegressions: factFailure.placeholderRegressions.length,
          };
          await ctx.emitDomain(
            "fact_preservation.blocked_draft",
            { revision, ...factView },
            `实验事实保持未通过（改 ${factView.changedFacts} / 删 ${factView.removedFacts} / 方向反转 ${factView.directionalChanges} / 公式 ${factView.formulaChanges} / 占位 ${factView.placeholderRegressions} / 无依据新增 ${factView.addedUnsupportedFacts} 项），Draft 产物已阻止`,
          );
          throw new BusinessError(
            "FACT_PRESERVATION_FAILED",
            `实验事实保持未通过，Draft 产物已阻止（修订 ${factFailure.previousRevision}→${factFailure.currentRevision} 存在未经 RevisionPlan/Evidence 授权的事实改写）；请依据修订计划恢复原值，或以 Evidence 支撑的修正重新走审稿`,
            describeFactPreservation(factFailure),
          );
        }
        const draft = await services.artifacts.ensureDraft(ctx.projectId, revision, record, ctx.runId);
        draftArtifactId = draft.artifactId;
      }
      // M10.3.1 G1：累计未授权漂移不阻断 Draft（用户 accept_draft 决策可产出），
      // 但必须显式可见——Final 被 cumulative_fact_preservation 阻断的事实不能只
      // 藏在 gate 产物里（任务 §7：报告必须明确 unresolved，不能隐藏）
      const cumulativeFailure = await latestCumulativeFailure(services, ctx.projectId);
      if (build.passed && cumulativeFailure !== null) {
        await ctx.emitDomain(
          "fact_preservation.cumulative_unresolved",
          {
            revision,
            baselineRevision: cumulativeFailure.baselineRevision,
            unresolvedViolations: cumulativeFailure.unresolvedViolations.length,
          },
          `注意：冻结基线 rev-${cumulativeFailure.baselineRevision} → rev-${revision} 累计未授权事实漂移 ${cumulativeFailure.unresolvedViolations.length} 项未解决——Draft 按用户决策产出，Final 仍被阻断（明细见 quality-gate 产物）`,
        );
      }
      return {
        buildOk: build.passed,
        revision,
        buildGateReasons: build.reasons.slice(0, 5),
        tool: compile.tool,
        durationMs: compile.durationMs,
        ...(compile.pdfPath !== null ? { pdfPath: "build/paper.pdf" } : {}),
        ...(compile.logPath !== null ? { logPath: "build/compile.log" } : {}),
        ...(compile.error !== undefined ? { buildError: compile.error } : {}),
        diagnosticsCount: record.diagnostics.length,
        diagnosticFiles: diagnosticFiles(record.diagnostics),
        ...(draftArtifactId !== undefined ? { draftArtifactId } : {}),
        ...(cumulativeFailure !== null
          ? {
              cumulativeFactViolations: cumulativeFailure.unresolvedViolations.length,
              cumulativeFactBaselineRevision: cumulativeFailure.baselineRevision,
            }
          : {}),
        ...(preservationView !== null ? { citationPreservation: preservationView } : {}),
      };
    },
  };
}

/** 最新 gate 产物里的引用保持失败明细（通过 / 不可比较 / 无产物 → null） */
async function latestCitationPreservationFailure(
  services: WorkflowServices,
  projectId: string,
): Promise<CitationPreservationSummary | null> {
  const rounds = await services.reviewArtifacts.gateRounds(projectId);
  const latest = rounds[0];
  if (latest === undefined) {
    return null;
  }
  const artifact = await services.reviewArtifacts.loadGate(projectId, latest);
  const preservation = artifact?.citationPreservation ?? null;
  return preservation !== null && !preservation.ok ? preservation : null;
}

/**
 * Fact Preservation 违规按文件聚合（revision.plan 派发用）：每文件取最多 2 条
 * 代表性明细（数值 / 公式 / 方向 / 占位优先级依次），总量 ≤ 8 条防计划爆炸。
 */
function summarizeFactRegressions(
  summary: import("../quality/factPreservation.js").FactPreservationSummary,
): { file: string; detail: string }[] {
  const byFile = new Map<string, string[]>();
  const buckets = [
    ...summary.changedFacts,
    ...summary.removedFacts,
    ...summary.formulaChanges,
    ...summary.directionalChanges,
    ...summary.placeholderRegressions,
    ...summary.addedUnsupportedFacts,
  ];
  for (const finding of buckets) {
    const details = byFile.get(finding.file) ?? [];
    if (details.length < 2) {
      details.push(
        `${finding.reason}：${finding.before}${finding.after !== "" ? ` → ${finding.after}` : "（被删除）"}`.slice(0, 240),
      );
    }
    byFile.set(finding.file, details);
  }
  return [...byFile.entries()].slice(0, 8).flatMap(([file, details]) =>
    details.map((detail) => ({ file, detail })),
  );
}

/**
 * M11.2.3（D-1）：pairwise fact 违规 → factRegressions（含 factRestore 数值
 * 清单）。展示聚合沿用 summarizeFactRegressions 的口径（每文件 ≤2 条、总量
 * ≤8）；数值投影遍历全部违规桶（不受展示上限约束——授权完整性优先）：
 * added → removeValues（当前快照行级）；removed → restoreValues（上一快照
 * 行级）；changed → 双值精确点名（与累计路径同语义）。
 */
async function summarizePairwiseFactRegressions(
  services: WorkflowServices,
  projectId: string,
  factState: import("../quality/factPreservation.js").FactPreservationSummary,
): Promise<
  {
    file: string;
    detail: string;
    restoreValues?: string[];
    removeValues?: string[];
  }[]
> {
  const previousFiles =
    factState.previousRevision !== undefined
      ? await readSnapshotTex(services.revisions.snapshotDir(projectId, factState.previousRevision))
      : null;
  const currentFiles =
    factState.currentRevision !== undefined
      ? await readSnapshotTex(services.revisions.snapshotDir(projectId, factState.currentRevision))
      : null;
  const display = summarizeFactRegressions(factState);
  const detailToFile = new Map(display.map((entry) => [`${entry.file}|${entry.detail}`, entry.file]));
  const regressions: {
    file: string;
    detail: string;
    restoreValues?: string[];
    removeValues?: string[];
  }[] = [];
  for (const [file, detail] of detailToFile) {
    regressions.push({ file, detail });
  }
  // 数值投影：按 finding 全量投影（file + 值集合合并，避免同文件多条目重复授权）
  const buckets: FactFinding[][] = [
    factState.changedFacts,
    factState.removedFacts,
    factState.addedUnsupportedFacts,
  ];
  const valuesByFile = new Map<string, { restoreValues: Set<string>; removeValues: Set<string> }>();
  for (const bucket of buckets) {
    for (const finding of bucket) {
      const files =
        finding.kind === "added_unsupported" ? currentFiles : finding.kind === "removed" ? previousFiles : null;
      const projection = projectPairwiseFactRestore(finding, files ?? []);
      const entry = valuesByFile.get(finding.file) ?? { restoreValues: new Set<string>(), removeValues: new Set<string>() };
      for (const value of projection.restoreValues ?? []) {
        entry.restoreValues.add(value);
      }
      for (const value of projection.removeValues ?? []) {
        entry.removeValues.add(value);
      }
      valuesByFile.set(finding.file, entry);
    }
  }
  for (const regression of regressions) {
    const values = valuesByFile.get(regression.file);
    if (values === undefined) {
      continue;
    }
    if (values.restoreValues.size > 0) {
      regression.restoreValues = [...values.restoreValues].slice(0, 12);
    }
    if (values.removeValues.size > 0) {
      regression.removeValues = [...values.removeValues].slice(0, 12);
    }
  }
  return regressions;
}

/**
 * M11.2.3（D-3）：resolution context 现场构建——源的可 grounding 性
 * （fulltext chunks 在库 / metadata_only）+ 章节引用源投影（outline
 * literatureRefs）+ 词面相关度（claim ↔ 源标题）。targetedSearchBudget
 * 缺省 0：补搜索是运维级 bounded 动作，不作为分类器默认出口（§9）。
 */
async function buildClaimResolutionContext(
  services: WorkflowServices,
  projectId: string,
): Promise<import("../review/claimResolution.js").ClaimResolutionContext> {
  const sources = await services.sources.list(projectId);
  // M11.3（Phase C）：冻结语料基线——快照在时，只有「基线口径 fulltext」的源
  // 可定向采证（matrix 消费过的全文）。快照后漂移到盘的全文文件（老项目在
  // 冻结特性前磁盘已漂移 / 显式 refresh 前的网络恢复）不得改变当前 Run 的
  // Research Basis：它们要进基线只能走显式 refresh → matrix 重建 → 新 revision。
  const corpusSnapshot = await services.corpus.get(projectId).catch(() => null);
  const basisRow = new Map((corpusSnapshot?.sources ?? []).map((row) => [row.sourceId, row]));
  const groundableInBasis = (sourceId: string): boolean => {
    if (corpusSnapshot === null) {
      return true; // 未冻结（首跑 / 老项目）——保持既有行为
    }
    const row = basisRow.get(sourceId);
    if (row === undefined) {
      return false; // 快照后才入库的源不属于冻结基线
    }
    return row.basisDepth === "fulltext" || (row.basisDepth === null && row.hasFulltext);
  };
  const chunkedSourceIds = new Set<string>();
  for (const source of sources) {
    try {
      const chunks = await services.chunkStore.readChunks(projectId, source.sourceId);
      if (chunks !== null && chunks.length > 0 && groundableInBasis(source.sourceId)) {
        chunkedSourceIds.add(source.sourceId);
      }
    } catch {
      // 无 chunk 文件 = 不可定向采证（如实呈现，不抛错阻断计划）
    }
  }
  const groundability = sources.map((source) => ({
    sourceId: source.sourceId,
    ...(source.metadata.title !== undefined && source.metadata.title.trim() !== ""
      ? { title: source.metadata.title }
      : {}),
    hasChunks: chunkedSourceIds.has(source.sourceId),
    metadataOnly: source.status === "metadata_only" || source.status === "pending",
  }));
  // 章节引用源投影：outline literatureRefs（survey 的确定性引用面）。
  // M11.3：键归一化 + entryId（M-{sourceId}）→ sourceId——M11.2.3 的投影因
  // 键形不一致（sections/x.tex vs x.tex）与 entryId 前缀从未真正命中。
  const sectionCitedSourceIds = await projectOutlineCitedSourceIds(services, projectId);
  return { sources: groundability, sectionCitedSourceIds, targetedSearchBudget: 0 };
}

/** M11.3：outline literatureRefs → { 归一化章节键 → sourceIds }（两处消费共用） */
async function projectOutlineCitedSourceIds(
  services: WorkflowServices,
  projectId: string,
): Promise<Record<string, string[]>> {
  const sectionCitedSourceIds: Record<string, string[]> = {};
  try {
    const outline = await services.manuscript.loadOutline(projectId);
    for (const section of outline?.sections ?? []) {
      if (section.literatureRefs !== undefined && section.literatureRefs.length > 0) {
        const sourceIds = literatureRefSourceIds(section.literatureRefs);
        for (const key of [section.file, section.id]) {
          const normalized = key !== undefined ? normalizeSectionKey(key) : "";
          if (normalized !== "" && sourceIds.length > 0) {
            sectionCitedSourceIds[normalized] = sourceIds;
          }
        }
      }
    }
  } catch {
    // 无 outline（非 survey 结构）→ 只用词面相关度通道
  }
  return sectionCitedSourceIds;
}

/**
 * M11.2.3（D-4 §15）：planned 条目的 mustPreserve 投影（最小约束——不是整节
 * 冻结）。数值 = 条目目标章节正文数值 token（≤40，剔除该条目已授权改动的
 * removeValues / restoreValues）；citationKeys = 章节现有 \cite keys（≤30）。
 * 投影只进 Writer prompt（改前约束），Fact / Citation 守卫判定口径不变。
 */
async function attachMustPreserveConstraints(
  services: WorkflowServices,
  projectId: string,
  plan: RevisionPlan,
): Promise<void> {
  const planned = plan.items.filter((item) => item.status === "planned" && item.section !== "(global)");
  if (planned.length === 0) {
    return;
  }
  const revision = await services.revisions.currentRevision(projectId);
  const files = await readSnapshotTex(services.revisions.snapshotDir(projectId, revision));
  if (files === null) {
    return;
  }
  const fileForSection = (sectionRef: string): { file: string; content: string } | null => {
    const ref = sectionRef.trim().replaceAll("\\", "/").toLowerCase();
    for (const file of files) {
      const path = file.file.replaceAll("\\", "/").toLowerCase();
      const stem = (path.split("/").pop() ?? path).replace(/\.tex$/, "");
      if (ref === path || ref === path.split("/").pop() || ref === stem || path.endsWith(ref) || (stem !== "" && ref.includes(stem))) {
        return file;
      }
    }
    return null;
  };
  for (const item of planned) {
    const file = fileForSection(item.section);
    if (file === null) {
      continue;
    }
    const authorized = new Set([
      ...(item.factRestore?.restoreValues ?? []),
      ...(item.factRestore?.removeValues ?? []),
    ]);
    const values = [
      ...new Set(
        (file.content.match(/[-−]?\d+(?:\.\d+)?[%‰]?/g) ?? [])
          .map((token) => token.replace("−", "-"))
          .filter((token) => !authorized.has(token) && token.length >= 2),
      ),
    ].slice(0, 40);
    const citationKeys = [...new Set(file.content.match(/\\cite\{([^}]*)\}/g) ?? [])]
      .flatMap((raw) => raw.slice(6, -1).split(",").map((key) => key.trim()))
      .filter((key) => key !== "")
      .slice(0, 30);
    if (values.length > 0 || citationKeys.length > 0) {
      item.mustPreserve = {
        ...(values.length > 0 ? { values } : {}),
        ...(citationKeys.length > 0 ? { citationKeys } : {}),
      };
    }
  }
}

/** 最新 gate 产物里的实验事实保持失败明细（通过 / 不可比较 / 无产物 → null） */async function latestFactPreservationFailure(
  services: WorkflowServices,
  projectId: string,
): Promise<import("../quality/factPreservation.js").FactPreservationSummary | null> {
  const rounds = await services.reviewArtifacts.gateRounds(projectId);
  const latest = rounds[0];
  if (latest === undefined) {
    return null;
  }
  const artifact = await services.reviewArtifacts.loadGate(projectId, latest);
  const preservation = artifact?.factPreservation ?? null;
  return preservation !== null && !preservation.ok ? preservation : null;
}

/** 最新 gate 产物里的累计事实漂移（通过 / 不可比较 / 无产物 → null） */
async function latestCumulativeFailure(
  services: WorkflowServices,
  projectId: string,
): Promise<CumulativeFactValidation | null> {
  const rounds = await services.reviewArtifacts.gateRounds(projectId);
  const latest = rounds[0];
  if (latest === undefined) {
    return null;
  }
  const artifact = await services.reviewArtifacts.loadGate(projectId, latest);
  const cumulative = artifact?.cumulativeFactPreservation ?? null;
  return cumulative !== null && !cumulative.ok ? cumulative : null;
}

/**
 * 累计违规 → fact_preserve 派发输入（M10.3.1 G1）。对每条违规同时规划
 * 确定性段落恢复（planFactRestore，与 revision.restore_facts 同一确定性
 * 计算）：restorable=true 的违规由 restore stage 直接恢复；数值清单进
 * factRestore（pairwise 授权只放行恢复方向）。
 */
async function buildCumulativeFactRegressions(
  services: WorkflowServices,
  projectId: string,
  cumulative: CumulativeFactValidation,
): Promise<
  {
    file: string;
    detail: string;
    violationKey: string;
    restoreValues?: string[];
    removeValues?: string[];
    restorable?: boolean;
  }[]
> {
  const baseline = await loadFrozenBaseline(services, projectId, { existingPaper: true });
  const currentFiles = await readSnapshotTex(
    services.revisions.snapshotDir(projectId, cumulative.currentRevision),
  );
  let restorableKeys: Set<string> | null = null;
  if (baseline !== null && currentFiles !== null) {
    const restorePlan = planFactRestore(baseline.files, currentFiles, cumulative.unresolvedViolations);
    restorableKeys = new Set(restorePlan.restorable.flatMap((span) => span.resolves));
  }
  const numericPart = (value: string | undefined): string | undefined => {
    if (value === undefined) {
      return undefined;
    }
    const stripped = value.replace(/[^\d.%‰eE+\-−]/g, "").trim();
    return /\d/.test(stripped) ? stripped : undefined;
  };
  return cumulative.unresolvedViolations.map((finding) => ({
    file: finding.file,
    detail: `${finding.reason}：${finding.before}${finding.after !== "" ? ` → ${finding.after}` : "（被删除）"}`,
    violationKey: finding.violationKey,
    ...(finding.kind === "added_unsupported"
      ? numericPart(finding.classification?.newValue) !== undefined
        ? { removeValues: [numericPart(finding.classification?.newValue) ?? ""] }
        : {}
      : numericPart(finding.classification?.oldValue) !== undefined
        ? {
            // changed：恢复 = 改回旧值（restoreValues）且漂移新值被删除（removeValues）
            restoreValues: [numericPart(finding.classification?.oldValue) ?? ""],
            ...(numericPart(finding.classification?.newValue) !== undefined
              ? { removeValues: [numericPart(finding.classification?.newValue) ?? ""] }
              : {}),
          }
        : {}),
    ...(restorableKeys !== null ? { restorable: restorableKeys.has(finding.violationKey) } : {}),
  }));
}

/**
 * Deterministic Fact Restore（M10.3.1 G1 §8）：对累计未授权漂移中可可靠定位
 * 的违规，直接恢复冻结基线段落（无 LLM）。提交 reason=revision.restore_facts
 * 的不可变修订；已解决的 fact_preserve 计划条目回写 validated。恢复失败的
 * 违规保持 planned 条目，由 revision.revise 派发 Writer（兜底）。
 */
function revisionRestoreFactsStage(services: WorkflowServices): StageSpec {
  return {
    id: "revision.restore_facts",
    description: "确定性恢复：累计未授权事实漂移 → 冻结基线段落（无 LLM）",
    requiredInputs: ["quality.gate"],
    producedOutputs: ["manuscript/*.tex（恢复修订）"],
    maxAttempts: 1, // 纯确定性恢复，重试无意义（失败走 Writer 兜底）
    timeoutMs: 60_000,
    retryable: [],
    async execute(ctx) {
      const rounds = await services.reviewArtifacts.gateRounds(ctx.projectId);
      const latest = rounds[0];
      if (latest === undefined) {
        return { restored: 0 };
      }
      const artifact = await services.reviewArtifacts.loadGate(ctx.projectId, latest);
      const cumulative = artifact?.cumulativeFactPreservation ?? null;
      if (cumulative === null || cumulative.ok) {
        return { restored: 0, cumulativeViolations: 0 };
      }
      const baseline = await loadFrozenBaseline(services, ctx.projectId, { existingPaper: true });
      const files = await collectLatexFiles(services.projects.manuscriptDir(ctx.projectId));
      const currentFiles: FactTexFile[] = [
        ...(files.mainTex !== null ? [{ file: files.mainTex.relativePath, content: files.mainTex.content }] : []),
        ...files.sections.map((file) => ({ file: file.relativePath, content: file.content })),
      ];
      if (baseline === null || currentFiles.length === 0) {
        return { restored: 0, cumulativeViolations: cumulative.unresolvedViolations.length, unrestorable: cumulative.unresolvedViolations.length };
      }
      const restorePlan = planFactRestore(baseline.files, currentFiles, cumulative.unresolvedViolations);
      const changedFiles = applyFactRestore(currentFiles, restorePlan);
      const resolvedKeys = new Set(changedFiles.length > 0 ? restorePlan.restorable.flatMap((span) => span.resolves) : []);
      if (changedFiles.length === 0) {
        await ctx.emitDomain(
          "fact_restore.skipped",
          { violations: cumulative.unresolvedViolations.length, skipped: restorePlan.skipped.length },
          `累计事实漂移 ${cumulative.unresolvedViolations.length} 项无可靠定位的恢复点（${restorePlan.skipped.length} 项定位失败）——保持 gate FAIL，交 Writer / 用户处理`,
        );
        return {
          restored: 0,
          cumulativeViolations: cumulative.unresolvedViolations.length,
          unrestorable: cumulative.unresolvedViolations.length,
        };
      }
      for (const file of changedFiles) {
        await writeFile(
          join(services.projects.manuscriptDir(ctx.projectId), file.file),
          file.content,
          "utf8",
        );
      }
      const revision = await services.revisions.commit(ctx.projectId, "revision.restore_facts", ctx.runId);
      // 已恢复违规的 fact_preserve 条目 → validated（确定性终态）；同时把恢复的
      // 连带数值增删并入同文件条目的 factRestore——恢复动作本身删除漂移值 /
      // 加回原值，pairwise 下一轮按 removal / addition 计，须授权（否则恢复被误报）
      const summary = await latestReviewSummary(services, ctx.projectId);
      const plan = summary !== null ? await services.reviewArtifacts.loadPlan(ctx.projectId, summary.round) : null;
      if (plan !== null) {
        const now = new Date().toISOString();
        const restoredFiles = new Set(restorePlan.restorable.map((span) => span.file));
        const deltaByFile = new Map<string, { restoreValues: string[]; removeValues: string[] }>();
        for (const span of restorePlan.restorable) {
          const delta = restoreValueDelta(span.currentParagraph, span.frozenParagraph);
          const merged = deltaByFile.get(span.file) ?? { restoreValues: [], removeValues: [] };
          merged.restoreValues.push(...delta.restoreValues);
          merged.removeValues.push(...delta.removeValues);
          deltaByFile.set(span.file, merged);
        }
        let enriched = plan;
        for (const [file, delta] of deltaByFile) {
          enriched = {
            ...enriched,
            items: enriched.items.map((item) =>
              item.kind === "fact_preserve" && item.section === file
                ? {
                    ...item,
                    factRestore: {
                      restoreValues: [...new Set([...(item.factRestore?.restoreValues ?? []), ...delta.restoreValues])],
                      removeValues: [...new Set([...(item.factRestore?.removeValues ?? []), ...delta.removeValues])],
                    },
                  }
                : item,
            ),
          };
        }
        // planned → applied → validated 两步（状态机合法路径；restore stage 即执行者）
        // M10.4.3：fact-preserve id 为 fact-preserve:{violationKey}:{n}（同 key 多出现
        // 确定性编号）；violationKey 为 16 位 hex 不含冒号，取前缀后第一段即 key——
        // 同时兼容旧计划裸格式与无 key fallback（file 段不会命中 hex key 集合）。
        // 同 key 的全部出现随 key 恢复一并闭环；未真恢复的出现由下一轮 gate 重算暴露。
        const transitions: RevisionItemTransition[] = enriched.items
          .filter(
            (item) =>
              item.kind === "fact_preserve" &&
              item.status === "planned" &&
              item.id.startsWith("fact-preserve:") &&
              resolvedKeys.has(item.id.slice("fact-preserve:".length).split(":")[0] ?? ""),
          )
          .flatMap((item) => [
            {
              id: item.id,
              to: "applied" as const,
              reason: "dispatched" as const,
              appliedAt: now,
              appliedRevision: revision.revision,
              targetChanged: true,
            },
            {
              id: item.id,
              to: "validated" as const,
              reason: "deterministic_restore" as const,
              resolvedAt: now,
              resolution:
                "冻结基线段落已由 revision.restore_facts 确定性恢复（无 LLM；恢复点定位与替换确定性可复核）",
            },
          ]);
        const applied = applyRevisionItemTransitions(enriched, transitions, now);
        if (applied.changed || restoredFiles.size > 0) {
          await services.reviewArtifacts.savePlan(ctx.projectId, applied.plan);
        }
      }
      await ctx.emitDomain(
        "fact_restore.applied",
        {
          revision: revision.revision,
          restoredSpans: restorePlan.restorable.length,
          violations: cumulative.unresolvedViolations.length,
          remaining: cumulative.unresolvedViolations.length - resolvedKeys.size,
          baselineRevision: cumulative.baselineRevision,
        },
        `累计事实漂移：确定性恢复 ${resolvedKeys.size}/${cumulative.unresolvedViolations.length} 项（冻结基线 rev-${cumulative.baselineRevision} 段落；剩余项继续走 Writer / 用户裁决）`,
      );
      return {
        restored: resolvedKeys.size,
        restoredSpans: restorePlan.restorable.length,
        cumulativeViolations: cumulative.unresolvedViolations.length,
        unrestorable: cumulative.unresolvedViolations.length - resolvedKeys.size,
        revision: revision.revision,
        changed: revision.created,
      };
    },
  };
}

// ============================================================
// 共享后段规划器（bounded revision loop）
// ============================================================

/** 修订类 stage 的最新完成位置（revise / apply 任一） */
function lastRevisionIndex(state: WorkflowState): number {
  return Math.max(
    lastCompletionIndex(state, "revision.revise"),
    lastCompletionIndex(state, "revision.apply"),
  );
}

/** 已消耗的修订轮数（自动 + 计划应用） */
function revisionRoundsUsed(state: WorkflowState): number {
  return countCompletions(state, "revision.revise") + countCompletions(state, "revision.apply");
}

/** 修订预算 = 自动轮数 + HITL 手动追加 */
function revisionBudget(state: WorkflowState, services: WorkflowServices): number {
  return services.review.maxRevisionRounds + (state.counters?.["revision.manual_rounds"] ?? 0);
}

/** HITL marker（stageResults 中的 {decision, ...}）的 decision 字段 */
function readMarkerDecision(state: WorkflowState, stageId: string): string | null {
  const value = state.stageResults[stageId];
  if (value === undefined || typeof value !== "object") {
    return null;
  }
  const decision = (value as Record<string, unknown>)["decision"];
  return typeof decision === "string" ? decision : null;
}

/**
 * 共享后段：返回下一个 stage 或完成决策。
 * 前置条件：调用方保证前段已完成。
 *
 * 新鲜度规则（M4.7）：任何改稿动作（revision.revise / apply / repair_latex）
 * 都使先前的 citation / review / gate / build 结论过期，尾部整段重走；
 * gate 通过后的修复同理（修复产生的修订必须复审后才能 Final）。
 */
function planSharedTail(state: WorkflowState, services: WorkflowServices): PlanDecision {
  const has = (id: string) => id in state.stageResults;
  const reviseIdx = lastRevisionIndex(state);
  const repairIdx = lastCompletionIndex(state, "revision.repair_latex");
  // M5.4 语言润色：只有真正产生新修订（changed=true）才算改稿；invariant 失败 /
  // 无条目的润色不写稿，不触发尾部重走
  const polishIdx =
    state.stageResults["revision.style_polish"]?.["changed"] === true
      ? lastCompletionIndex(state, "revision.style_polish")
      : -1;
  // 任何改稿动作（修订 / 编译修复 / 语言润色都写入 manuscript）；
  // M10.3.1：确定性事实恢复（revision.restore_facts）同样写入 manuscript
  const restoreIdx = lastCompletionIndex(state, "revision.restore_facts");
  const contentIdx = Math.max(reviseIdx, repairIdx, polishIdx, restoreIdx);
  const citationIdx = lastCompletionIndex(state, "citation.verify");
  const reviewIdx = lastCompletionIndex(state, "review.run");
  const gateIdx = lastCompletionIndex(state, "quality.gate");
  const buildIdx = lastCompletionIndex(state, "build.draft");
  const planIdx = lastCompletionIndex(state, "revision.plan");
  const finalIdx = lastCompletionIndex(state, "build.final");

  // 0. M6.7 Revision Validation：修订（revise / apply）写入后必须先过条目级复核
  //    （Revision ≠ Correct Revision），再进入尾部重走；复核 blocked 且用户未
  //    决策（回答按 validatedRevision 对齐，下一轮复核不复用旧回答）→ HITL
  const validateIdx = lastCompletionIndex(state, "revision.validate");
  if (reviseIdx > -1 && validateIdx < reviseIdx) {
    return { kind: "stage", stageId: "revision.validate" };
  }
  const validateResult = state.stageResults["revision.validate"] ?? {};
  const validationBlocked = validateResult["blocked"] === true;
  const validationId = typeof validateResult["validationId"] === "string" ? validateResult["validationId"] : "";
  const validationMarker = state.stageResults["hitl.revision_validation"] as
    | Record<string, unknown>
    | undefined;
  // 新鲜度按 validationId（轮次+修订号唯一）：修订未产生新修订号时（Writer 输出
  // 与原文相同，created=false），revision 号会与前一轮撞号，按号判定会误把
  // 新一轮复核当成已回答
  const validationAnswered =
    validationMarker !== undefined && validationMarker["validationId"] === validationId;
  if (validationBlocked && !validationAnswered) {
    return { kind: "stage", stageId: "hitl.revision_validation" };
  }

  // 1. 引用核验须新于最近一次改稿
  if (!has("citation.verify") || citationIdx < contentIdx) {
    return { kind: "stage", stageId: "citation.verify" };
  }
  // 2. review 须新于其消费的 citation
  if (!has("review.run") || reviewIdx < citationIdx) {
    return { kind: "stage", stageId: "review.run" };
  }
  // 3. gate 须新于 review
  if (!has("quality.gate") || gateIdx < reviewIdx) {
    return { kind: "stage", stageId: "quality.gate" };
  }

  const gateResult = state.stageResults["quality.gate"] ?? {};
  const gatePassed = gateResult["passed"] === true;
  const gateRound = typeof gateResult["round"] === "number" ? gateResult["round"] : 0;
  const outcome = typeof gateResult["outcome"] === "string" ? gateResult["outcome"] : null;
  // M11.2.3（D-4）：确定性收敛状态（PROGRESS / STALLED / REGRESSED）——
  // STALLED（连续两轮核心阻断指标无改善）优先于轮数预算：不再自动续跑，
  // 按 NO_PROGRESS 语义进 HITL；REGRESSED（新增 critical / fact / citation
  // 回归）同样先停下（修新回归或人工决策，不「还有轮数就继续」）。
  const convergence =
    typeof gateResult["convergence"] === "string" ? gateResult["convergence"] : null;
  const overflowAnswered = "hitl.revision_overflow" in state.stageResults;
  const roundsLeft = revisionRoundsUsed(state) < revisionBudget(state, services);
  const build = state.stageResults["build.draft"] ?? {};
  const buildOk = build["buildOk"] === true;

  // HITL resume 不产生 stageHistory：stalled 的回答新鲜度以 marker 中的 gateRound
  // 判定（只在「本轮 gate 之后」算已回答；下一轮 gate 失败会重新询问）
  const stalledMarker = state.stageResults["hitl.revision_stalled"] as Record<string, unknown> | undefined;
  const stalledGateRound =
    stalledMarker !== undefined && typeof stalledMarker["gateRound"] === "number"
      ? stalledMarker["gateRound"]
      : -1;
  const stalledDecision = stalledMarker !== undefined ? readMarkerDecision(state, "hitl.revision_stalled") : null;
  const stalledAnswered = stalledDecision !== null && stalledGateRound >= gateRound;

  const completion = (label: "final" | "draft") => {
    // M11.3（Phase E）：产品终态语义（gate 结果带同轮 author_decision 口径；
    // 旧 run 的 gate 结果无该字段 → classifyTerminalStatus 内按 0 处理）
    const terminal = gatePassed
      ? classifyTerminalStatus({ gatePassed, gateReasons: [], convergence: null })
      : classifyTerminalStatus({
          gatePassed,
          gateReasons: (gateResult["reasons"] as unknown[] | undefined)?.map((reason) => String(reason)) ?? [],
          convergence: convergence === "PROGRESS" || convergence === "STALLED" || convergence === "REGRESSED" ? convergence : null,
          authorDecisionClaims:
            typeof gateResult["authorDecisionClaims"] === "number"
              ? (gateResult["authorDecisionClaims"] as number)
              : 0,
        });
    return {
      kind: "complete",
      label,
      summary: {
        buildOk,
        buildGateReasons: build["buildGateReasons"] ?? [],
        qualityGatePassed: gatePassed,
        qualityGateReasons: gateResult["reasons"] ?? [],
        // M11.3：产品终态语义（PASS / QUALITY_NOT_REACHED / NO_PROGRESS /
        // AUTHOR_DECISION_REQUIRED / SYSTEM_FAILED + 用户可读 message）
        qualityStatus: terminal.status,
        qualityStatusMessage: terminal.message,
        // M11.2 §十四：报告层区分「自动修改轮数耗尽 / 不收敛后接受 Draft」与
        // 「双 Gate 通过自然完结」——qualityGatePassed=false 的 Draft 不是异常，
        // 是 bounded loop 的正常终态（PASS / IMPROVED / CONVERGED / REGRESSION）
        ...(outcome !== null && !gatePassed ? { qualityOutcome: outcome } : {}),
        revisionRounds: revisionRoundsUsed(state),
        draftArtifactId: build["draftArtifactId"] ?? null,
        ...(label === "final"
          ? { finalArtifactId: state.stageResults["build.final"]?.["finalArtifactId"] ?? null }
          : {}),
      },
    } satisfies PlanDecision;
  };

  // accept_draft（overflow 或 stalled 的回答）→ 构建 Draft PDF 后完成。
  // M5.4/M5.6：用户显式 apply_once 时，Draft 构建前同样提供一次语言润色（Quality
  // Gate 未通过 ≠ 不能润色表达；润色产生新修订后尾部照旧重走复审 / gate）
  const draftPath = (): PlanDecision => {
    const stylePolishBeforeDraft = planStylePolish(state, gateRound);
    if (stylePolishBeforeDraft !== null) {
      return stylePolishBeforeDraft;
    }
    if (!has("build.draft") || buildIdx < contentIdx) {
      return { kind: "stage", stageId: "build.draft" };
    }
    return completion("draft");
  };

  if (gatePassed) {
    // gate 通过后若有改稿（含编译修复）：结论已过期，回到尾部重新评审
    // （通常已被规则 1 覆盖；显式双保险）
    if (gateIdx < contentIdx) {
      return { kind: "stage", stageId: "citation.verify" };
    }
    // M5.4 Style Polish（用户显式 apply_once；默认 suggest_only 不进入）：gate 通过后、
    // 构建之前最多一轮；产生新修订则尾部整段重走（复审 / gate / build 都不得沿用旧结论）
    const stylePolish = planStylePolish(state, gateRound);
    if (stylePolish !== null) {
      return stylePolish;
    }
    // 构建须新于 gate 与最近改稿
    if (!has("build.draft") || buildIdx < contentIdx || buildIdx < gateIdx) {
      return { kind: "stage", stageId: "build.draft" };
    }
    if (buildOk) {
      // 双 Gate 通过且对齐当前修订 → 确定性 Finalize（一次；重构建后重冻结）
      if (!has("build.final") || finalIdx < buildIdx) {
        return { kind: "stage", stageId: "build.final" };
      }
      return completion("final");
    }
    // 构建失败：bounded 修复（诊断须定位到 manuscript 内文件）
    const repairAttempts = countCompletions(state, "revision.repair_latex");
    const diagnosticFilesValue = Array.isArray(build["diagnosticFiles"]) ? build["diagnosticFiles"] : [];
    if (repairAttempts < MAX_AUTO_LATEX_REPAIRS && diagnosticFilesValue.length > 0) {
      return { kind: "stage", stageId: "revision.repair_latex" };
    }
    // 修复预算耗尽：仍有修订预算 → 带编译错误上下文修订（复审随之重走）
    if (roundsLeft) {
      return { kind: "stage", stageId: "revision.revise" };
    }
    if (!overflowAnswered) {
      return { kind: "stage", stageId: "hitl.revision_overflow" };
    }
    return completion("draft"); // 用户知情接受（无 PDF 产出，buildOk=false 如实记录）
  }

  // ---- Quality Gate 失败：质量语义不阻塞 Draft，但 Final 必须通过 ----
  // 不收敛（连续无实质改善 / 退化）优先于预算判定：预算耗尽时也按「不收敛」
  // 向用户说明（而不是误导性的「轮数用完」）；回答只对本轮 gate 有效
  // M11.2.3：跨轮 STALLED（judgeConvergence：连续两轮核心阻断指标无改善）
  // 并入同一优先级——自动循环是 bounded 的，「还有轮数」不再是不收敛时继续
  // 的理由。REGRESSED 只观测不抢跑：守卫类回归（fact / citation 违规上升）
  // 有确定性修复路径（fact_preserve 派发 / restore_facts），先给一轮修复
  // 机会；若修复不动核心指标，下一轮自然落入 STALLED。
  if (
    (outcome === "CONVERGED" || outcome === "REGRESSION" || convergence === "STALLED") &&
    !stalledAnswered
  ) {
    return { kind: "stage", stageId: "hitl.revision_stalled" };
  }
  if (roundsLeft) {
    // stalled 已回答 accept_draft：用户明确接受当前稿为 Draft——即使本轮计划仍
    // 可派发也不再自动修订（回答只对本轮 gate 有效；下一轮 gate 重新判定）
    if (stalledAnswered && stalledDecision === "accept_draft") {
      return draftPath();
    }
    // 先确保有针对本轮 gate 的确定性计划（计划新鲜 = 晚于本轮 gate 且轮次一致）
    const planResult = state.stageResults["revision.plan"] ?? {};
    const planFresh =
      has("revision.plan") && planIdx > gateIdx && planResult["round"] === gateRound;
    if (!planFresh) {
      return { kind: "stage", stageId: "revision.plan" };
    }
    const planned = typeof planResult["planned"] === "number" ? planResult["planned"] : 0;
    // 计划无可派发条目（仅剩 minor / gate 阻止项）→ 同样按不收敛处理
    if (planned === 0 && !stalledAnswered) {
      return { kind: "stage", stageId: "hitl.revision_stalled" };
    }
    if (planned > 0 || stalledDecision === "revise_more") {
      // M10.3.1 G1：计划含可确定性恢复的累计事实漂移 → 先走无 LLM 恢复
      // （恢复产生新修订 → 尾部重走复审；本轮已恢复过（restoreIdx ≥ planIdx）
      // 则不再重复路由，剩余 planned 条目交 Writer——防止无变化死循环）
      const restorableFacts = typeof planResult["restorableFacts"] === "number"
        ? (planResult["restorableFacts"] as number)
        : 0;
      if (restorableFacts > 0 && restoreIdx < planIdx) {
        return { kind: "stage", stageId: "revision.restore_facts" };
      }
      // M11.2.3（D-3 §7 Evidence First）：计划含「在库全文可定向采证」的
      // unsupported claim → 先采证再派发 Writer（修文字前先补证据；采证不
      // 改稿，不触发尾部重走；本轮已采证过（groundIdx ≥ planIdx）不重复）
      const groundClaims = typeof planResult["groundClaims"] === "number"
        ? (planResult["groundClaims"] as number)
        : 0;
      const groundIdx = lastCompletionIndex(state, "evidence.ground_claims");
      if (groundClaims > 0 && groundIdx < planIdx) {
        return { kind: "stage", stageId: "evidence.ground_claims" };
      }
      return { kind: "stage", stageId: "revision.revise" };
    }
    // stalled 且用户 accept_draft → 构建 Draft 后完成
    return draftPath();
  }
  // 预算耗尽：overflow HITL（本轮 stalled 已 accept_draft 时不重复追问）
  if (!overflowAnswered && !(stalledAnswered && stalledDecision === "accept_draft")) {
    return { kind: "stage", stageId: "hitl.revision_overflow" };
  }
  return draftPath();
}

/**
 * M5.4 HITL 决策：style_polish。apply 可携带 payload.selectedFindingIds（string[]，
 * 缺省全部）；skip 只保留建议。回答记录 gateRound（下一轮 gate 不复用旧回答）。
 */
async function applyStylePolishDecision(
  state: WorkflowState,
  input: ResumeInput,
): Promise<void | "cancel"> {
  const gate = state.stageResults["quality.gate"] ?? {};
  const gateRound = typeof gate["round"] === "number" ? gate["round"] : 0;
  if (input.decision === "cancel") {
    return "cancel";
  }
  if (input.decision === "skip") {
    state.stageResults["hitl.style_polish"] = { decision: "skip", gateRound };
    return;
  }
  if (input.decision === "apply") {
    const raw = input.payload?.["selectedFindingIds"];
    if (raw !== undefined) {
      if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string" || !/^f-[0-9a-f]{12}$/.test(id))) {
        throw new WorkflowInvalidStateError(
          state.runId,
          state.status,
          "payload.selectedFindingIds 必须是 finding id 字符串数组（形如 f-xxxxxxxxxxxx）",
        );
      }
      if (raw.length === 0) {
        throw new WorkflowInvalidStateError(state.runId, state.status, "apply 至少选择一条 style 建议；不修改请选择 skip");
      }
    }
    state.stageResults["hitl.style_polish"] = {
      decision: "apply",
      gateRound,
      ...(raw !== undefined ? { selectedFindingIds: [...(raw as string[])] } : {}),
    };
    return;
  }
  throw new WorkflowInvalidStateError(
    state.runId,
    state.status,
    `decision 只能是 apply / skip / cancel（当前 "${input.decision}"）`,
  );
}

/** 共享 HITL 决策：revision_overflow */
async function applyOverflowDecision(
  state: WorkflowState,
  input: ResumeInput,
): Promise<void | "cancel"> {
  if (input.decision === "accept_draft") {
    state.stageResults["hitl.revision_overflow"] = { decision: "accept_draft" };
    return;
  }
  if (input.decision === "cancel") {
    return "cancel";
  }
  if (input.decision === "revise_more") {
    const manual = state.counters?.["revision.manual_rounds"] ?? 0;
    if (manual >= MAX_MANUAL_REVISION_ROUNDS) {
      throw new WorkflowInvalidStateError(
        state.runId,
        state.status,
        `人工追加修订已达上限（${MAX_MANUAL_REVISION_ROUNDS} 轮），请 accept_draft 或 cancel`,
      );
    }
    state.counters = { ...state.counters, "revision.manual_rounds": manual + 1 };
    return;
  }
  throw new WorkflowInvalidStateError(
    state.runId,
    state.status,
    `decision 只能是 accept_draft / revise_more / cancel（当前 "${input.decision}"）`,
  );
}

/**
 * 共享 HITL 决策：revision_stalled。
 * 回答记录本轮 gateRound（planner 据此判断「本轮已回答」；下一轮 gate 不复用旧回答）。
 */
async function applyStalledDecision(
  state: WorkflowState,
  input: ResumeInput,
): Promise<void | "cancel"> {
  const gate = state.stageResults["quality.gate"] ?? {};
  const gateRound = typeof gate["round"] === "number" ? gate["round"] : 0;
  if (input.decision === "accept_draft") {
    state.stageResults["hitl.revision_stalled"] = { decision: "accept_draft", gateRound };
    return;
  }
  if (input.decision === "cancel") {
    return "cancel";
  }
  if (input.decision === "revise_more") {
    const manual = state.counters?.["revision.manual_rounds"] ?? 0;
    if (manual >= MAX_MANUAL_REVISION_ROUNDS) {
      throw new WorkflowInvalidStateError(
        state.runId,
        state.status,
        `人工追加修订已达上限（${MAX_MANUAL_REVISION_ROUNDS} 轮），请 accept_draft 或 cancel`,
      );
    }
    state.counters = { ...state.counters, "revision.manual_rounds": manual + 1 };
    state.stageResults["hitl.revision_stalled"] = { decision: "revise_more", gateRound };
    return;
  }
  throw new WorkflowInvalidStateError(
    state.runId,
    state.status,
    `decision 只能是 accept_draft / revise_more / cancel（当前 "${input.decision}"）`,
  );
}

// ============================================================
// Idea-to-Paper 定义
// ============================================================

function researchIdeaStage(services: WorkflowServices): StageSpec {
  return {
    id: "research.idea",
    description: "Researcher 领域调研（现状 / Related Work / Gap / 贡献 / Evidence 候选）",
    requiredInputs: [],
    producedOutputs: ["research/research.json", "evidence 候选"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs,
    retryable: ["transient", "timeout", "runtime_unavailable"],
    async execute(ctx) {
      const result = await services.researcher.research({ projectId: ctx.projectId });
      // M9.7.4：待审候选数随 stage 结果暴露（planEvidenceSupply 纯函数消费，
      // 决定是否在写作前呈现 evidence-supply HITL；只读，绝不自动 promote）
      const pendingCandidates = (await services.candidates.list(ctx.projectId, "pending_review")).length;
      return {
        taskId: result.taskId,
        reportPath: result.reportPath,
        evidenceCount: result.evidenceAppended,
        evidenceProposed: result.evidenceProposed,
        bibliographyCount: result.bibliographyCount,
        gaps: result.report.researchGaps.length,
        candidatePending: pendingCandidates,
      };
    },
    async verifyDod(ctx) {
      const violations: string[] = [];
      const artifact = await readResearchArtifact(services.projects, ctx.projectId);
      if (artifact === null) {
        violations.push("research/research.json 不存在或不可解析");
      } else if (artifact.report.researchGaps.length === 0) {
        violations.push("调研结果缺少 researchGaps");
      }
      return violations;
    },
  };
}

/**
 * Evidence Grounding stage（M6.5）：把 research 阶段产生的 chunk 锚定候选
 * 走三段核验（quote 逐字 → metadata → Citation 角色语义 judge），verified
 * 才转正进 EvidenceStore。位置在 research 与 feasibility 之间：feasibility
 * 与后续 Reviewer 消费的 evidence stats 必须已经是核验后的口径。零候选时
 * no-op 通过（scripted / 离线栈无感）；幂等（只处理 pending 候选）。
 */
function evidenceGroundStage(
  services: WorkflowServices,
  requiredInputs: string[] = ["research.idea"],
): StageSpec {
  return {
    id: "evidence.ground",
    description:
      "Evidence Grounding：候选证据三段核验（quote 逐字校验 / metadata 核验 / 语义 judge）后转正进证据库",
    requiredInputs,
    producedOutputs: ["evidence/candidates.jsonl 状态流转", "evidence.jsonl grounded 记录"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs,
    retryable: ["transient", "timeout", "runtime_unavailable"],
    async execute(ctx) {
      const summary = await services.evidenceGrounding.groundPending(ctx.projectId);
      return {
        pending: summary.pending,
        processed: summary.processed,
        verified: summary.verified,
        mismatch: summary.mismatch,
        rejected: summary.rejected,
        unverifiable: summary.unverifiable,
        evidenceAppended: summary.evidenceAppended,
      };
    },
    async verifyDod(ctx) {
      const stats = await services.evidenceGrounding.candidateStats(ctx.projectId);
      // 处置完毕 = 队列中不再有 pending（verified/mismatch/rejected/unverifiable
      // 都是已处置终态；unverifiable 可在后续 run / 手动 retry）
      return stats.byStatus.pending > 0
        ? [`仍有 ${stats.byStatus.pending} 条 pending 证据候选未处置`]
        : [];
    },
  };
}

function feasibilityStage(services: WorkflowServices, id = "research.feasibility"): StageSpec {
  return {
    id,
    description: "Target Feasibility Assessment（HIGH/MEDIUM/LOW/INSUFFICIENT）",
    // 前置：idea 流程为调研结果；existing 流程为论文理解结果
    requiredInputs: [id === "assessment.target" ? "import.understand" : "research.idea"],
    producedOutputs: ["research/feasibility.json"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs,
    retryable: ["transient", "timeout", "runtime_unavailable", "contract_violation"],
    async execute(ctx) {
      const artifact = await requireResearchArtifact(services, ctx.projectId);
      const evidenceStats = await services.evidence.stats(ctx.projectId);
      const result = await services.feasibility.assess({
        projectId: ctx.projectId,
        research: artifact.report,
        evidenceStats,
        ...(id === "assessment.target" ? { assessKind: "existing_paper" as const } : {}),
      });
      return {
        level: result.level,
        reportPath: result.reportPath,
        missingRequirements: result.missingRequirements.length,
        requiredExperiments: result.requiredExperiments.length,
      };
    },
    async verifyDod(ctx) {
      const report = await readFeasibilityReport(services.projects, ctx.projectId);
      if (report === null) {
        return ["research/feasibility.json 不存在或不可解析"];
      }
      return ["HIGH", "MEDIUM", "LOW", "INSUFFICIENT"].includes(report.report.level)
        ? []
        : [`feasibility level 非法：${report.report.level}`];
    },
  };
}

function feasibilityConfirmStage(services: WorkflowServices): StageSpec {
  return {
    id: "hitl.feasibility_confirm",
    description: "等待用户确认研究目标与可行性结论",
    requiredInputs: ["research.feasibility"],
    producedOutputs: ["用户决策"],
    hitl: {
      prompt: "调研与可行性评估已完成，请确认研究目标后继续",
      options: ["approve", "adjust", "cancel"],
      payload: async (ctx) => {
        const report = await readFeasibilityReport(services.projects, ctx.projectId);
        if (report === null) {
          return undefined;
        }
        return {
          level: report.report.level,
          reasons: report.report.reasons.slice(0, 3),
          missingRequirements: report.report.missingRequirements.slice(0, 5),
          requiredExperiments: report.report.requiredExperiments.slice(0, 5),
          recommendations: report.report.recommendations.slice(0, 3),
          ...(report.report.suggestedTargetAdjustment
            ? { suggestedTargetAdjustment: report.report.suggestedTargetAdjustment }
            : {}),
        };
      },
    },
  };
}

function outlinePlanStage(services: WorkflowServices): StageSpec {
  return {
    id: "outline.plan",
    description: "Writer 规划论文大纲（分节结构 + 要点）",
    requiredInputs: ["hitl.feasibility_confirm"],
    producedOutputs: ["manuscript/outline.json", "manuscript/main.tex（骨架）"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs,
    retryable: ["transient", "timeout", "runtime_unavailable", "contract_violation"],
    async execute(ctx) {
      const artifact = await requireResearchArtifact(services, ctx.projectId);
      const project = await services.projects.getRequired(ctx.projectId);
      const language = normalizeManuscriptLanguage(project.language);
      const evidence = await usableEvidence(services, ctx.projectId);
      // M9.5：Writer 可引用 key 与 references.bib 全部来自 canonical bibliography
      // （文献库 authoritative metadata + LLM 引用意图，代码确定性 key）——
      // LLM 自造的 bibliography key 不再进入下游。
      const bibliography = await buildCanonicalBibliography(services, ctx.projectId);
      const feedback = readFeedback(ctx.state.inputs["hitl.outline_confirm"]?.payload);
      const outline = await services.writer.planOutline({
        projectId: ctx.projectId,
        researchDigest: {
          domainOverview: artifact.report.domainOverview,
          researchGaps: artifact.report.researchGaps,
          potentialContributions: artifact.report.potentialContributions,
        },
        evidence,
        bibliography,
        targetProfile: project.targetProfile,
        documentType: project.documentType,
        ...(language !== undefined ? { language } : {}),
        ...(feedback !== undefined ? { feedback } : {}),
      });
      await services.manuscript.saveOutline(ctx.projectId, outline);
      await services.manuscript.writeBibliography(ctx.projectId, bibliography);
      await services.manuscript.writeMainTex(ctx.projectId, outline, bibliography.length > 0);
      // 大纲骨架也是 manuscript 状态：提交修订（后续 gate/build 对齐基准）
      const revision = await services.revisions.commit(ctx.projectId, "outline.plan", ctx.runId);
      return {
        sections: outline.sections.length,
        title: outline.title,
        references: bibliography.length,
        revision: revision.revision,
      };
    },
    async verifyDod(ctx) {
      const violations: string[] = [];
      const outline = await services.manuscript.loadOutline(ctx.projectId);
      if (outline === null) {
        return ["manuscript/outline.json 不存在"];
      }
      try {
        const main = await readFile(services.projects.mainTexPath(ctx.projectId), "utf8");
        for (const section of outline.sections) {
          if (!main.includes(`\\input{sections/${section.file.replace(/\.tex$/, "")}}`)) {
            violations.push(`main.tex 缺少 \\input{sections/${section.file}}`);
          }
        }
      } catch {
        violations.push("manuscript/main.tex 不存在");
      }
      return violations;
    },
  };
}

/** outline 确认 HITL 的共享 payload（M11.1.3 refs 契约可见；idea / survey 共用） */
async function outlineConfirmPayload(
  services: WorkflowServices,
  ctx: { projectId: string },
): Promise<Record<string, unknown> | undefined> {
  const outline = await services.manuscript.loadOutline(ctx.projectId);
  if (outline === null) {
    return undefined;
  }
  return {
    title: outline.title,
    ...(outline.abstract !== undefined ? { abstract: outline.abstract.slice(0, 300) } : {}),
    sections: outline.sections.map((section) => ({
      id: section.id,
      title: section.title,
      file: section.file,
      // M11.1.3：Survey Outline 的 refs 契约可见（修订轮不得无声丢失；
      // 普通论文 outline 无 refs 字段，payload 形状不变）
      ...(section.synthesisRefs !== undefined
        ? { synthesisRefs: section.synthesisRefs }
        : {}),
      ...(section.literatureRefs !== undefined
        ? { literatureRefs: section.literatureRefs }
        : {}),
    })),
  };
}

function outlineConfirmStage(services: WorkflowServices): StageSpec {
  return {
    id: "hitl.outline_confirm",
    description: "等待用户确认大纲",
    requiredInputs: ["outline.plan"],
    producedOutputs: ["用户决策"],
    hitl: {
      prompt: "大纲已生成，请确认后开始分节写作",
      options: ["approve", "revise", "cancel"],
      payload: (ctx) => outlineConfirmPayload(services, ctx),
    },
  };
}

/**
 * M9.7.4 Evidence Supply HITL：写作前把「待审候选文献 vs 已核验证据覆盖」
 * 作为用户决策点呈现——M9.7.3 暴露 coverage 天花板 3/20≈15% 的杠杆在
 * 用户 promote（Research found N candidates / Verified evidence covers M
 * sources），而此前 workflow 对 32 条 pending 候选完全无感知。
 *
 * 边界纪律（不可违反）：
 * - 只提示、不自动晋升：pending → accepted 的 promote 永远是用户显式动作
 *   （D-0033/D-0035 红线，Retrieved ≠ Verified）；
 * - 不是 Quality Gate：证据覆盖低不 FAIL、不阻断 Draft（本 stage 的
 *   continue/cancel 由用户决定，无任何自动否决）；
 * - 每 run 至多询问一次；无候选（scripted / 离线栈）零打扰。
 */
const EVIDENCE_SUPPLY_MIN_PENDING = 3;

function evidenceSupplyStage(
  services: WorkflowServices,
  requiredInputs: string[] = ["hitl.outline_confirm"],
): StageSpec {
  return {
    id: "hitl.evidence_supply",
    description:
      "证据供给提示：待审候选文献 vs 已核验证据覆盖（用户决定先扩充证据或直接继续写作）",
    requiredInputs,
    producedOutputs: ["用户决策（continue / cancel）"],
    hitl: {
      prompt:
        "研究发现了一批待审候选文献，而当前已核验（verified）证据只覆盖少数来源。你可以先在「文献发现」页审阅并 Promote 候选文献（入库并获取全文后，重新运行研究阶段可扩大证据池、提高后续引用的证据覆盖），也可以直接以当前证据继续写作。",
      options: ["continue", "cancel"],
      payload: async (ctx) => {
        const pending = await services.candidates.list(ctx.projectId, "pending_review");
        const formal = (await services.evidenceSelection.selectForWriting(ctx.projectId)).formal;
        const verifiedSources = new Set(
          formal.map((record) => record.source?.sourceId).filter((id): id is string => id !== undefined),
        );
        // M9.9 Phase 1：预写证据需求的覆盖缺口接入 payload（只读派生视图；
        // null = 无 artifact / 无计划（旧项目）→ 整节省略，旧契约兼容。
        // 快照时点 = analyzedAt——用户补给后需重跑研究才见新覆盖，UI 如实标注）。
        const coverage = await services.coverage.get(ctx.projectId);
        const requirementFields =
          coverage === null
            ? {}
            : {
                requirements: coverage.requirementCoverage.map((entry) => ({
                    requirementId: entry.requirementId,
                    topic: entry.topic,
                    claimType: entry.claimType,
                    evidenceType: entry.expectedEvidenceType,
                    coverageStatus: entry.coverage,
                    evidenceCount: entry.evidenceCount,
                    promotedCount: entry.promotedCount,
                    priority: entry.priority,
                    ...(entry.missingReason !== undefined
                      ? { missingReason: entry.missingReason }
                      : {}),
                  })),
                requirementSummary: coverage.overall.requirements,
                requirementCoverageAnalyzedAt: coverage.analyzedAt,
              };
        return {
          pendingCandidates: pending.length,
          verifiedEvidenceRecords: formal.length,
          verifiedEvidenceSources: verifiedSources.size,
          pendingSample: pending.slice(0, 5).map((candidate) => ({
            title: candidate.title ?? "(untitled)",
            ...(candidate.year !== undefined ? { year: candidate.year } : {}),
            ...(candidate.doi !== undefined ? { doi: candidate.doi } : {}),
            ...(candidate.arxivId !== undefined ? { arxivId: candidate.arxivId } : {}),
            origin: candidate.origin,
          })),
          ...requirementFields,
          action:
            "在「文献发现」页 Promote 候选 → 文献库获取全文 → 重跑研究（或本 run 直接 continue 使用现有证据）",
        };
      },
    },
  };
}

/** M9.7.4 planner 片段：是否呈现 evidence-supply HITL（纯函数，只看 state） */
function planEvidenceSupply(state: WorkflowState): PlanDecision | null {
  if ("hitl.evidence_supply" in state.stageResults) {
    return null; // 每 run 至多一次
  }
  const research = state.stageResults["research.idea"] ?? {};
  const pending = typeof research["candidatePending"] === "number" ? research["candidatePending"] : 0;
  return pending >= EVIDENCE_SUPPLY_MIN_PENDING ? { kind: "stage", stageId: "hitl.evidence_supply" } : null;
}

function writingSectionsStage(services: WorkflowServices): StageSpec {
  return {
    id: "writing.sections",
    description: "Writer 逐节写作（section-based）",
    requiredInputs: ["hitl.outline_confirm"],
    producedOutputs: ["manuscript/sections/*.tex", "manuscript/main.tex"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs * 4,
    retryable: ["transient", "timeout", "runtime_unavailable", "contract_violation"],
    async execute(ctx) {
      const outline = await services.manuscript.loadOutline(ctx.projectId);
      if (outline === null) {
        throw new BusinessError("STAGE_CONTRACT_VIOLATION", "缺少大纲（outline.json）");
      }
      await requireResearchArtifact(services, ctx.projectId);
      // M9.7.4：写作语言是 Project Contract（project.language → prompt + skill）
      const language = normalizeManuscriptLanguage(
        (await services.projects.getRequired(ctx.projectId)).language,
      );
      // M6.6：写作 digest 只含 verified formal 池（legacy unverified 不再兜底注入）
      const evidenceSelection = await services.evidenceSelection.selectForWriting(ctx.projectId);
      const evidence = evidenceSelection.formal;
      // M9.5：写作允许引用的 key = canonical bibliography（确定性 key）
      const bibliography = await buildCanonicalBibliography(services, ctx.projectId);

      let bytesTotal = 0;
      const written: string[] = [];
      for (const [index, section] of outline.sections.entries()) {
        if (ctx.signal.aborted) {
          throw new BusinessError("WORKFLOW_CANCELLED", "写作已被取消");
        }
        const result = await services.writer.writeSection({
          projectId: ctx.projectId,
          section,
          outline,
          evidence,
          bibliography,
          ...(language !== undefined ? { language } : {}),
        });
        bytesTotal += await services.manuscript.writeSection(ctx.projectId, section, result.latex);
        written.push(section.id);
        await ctx.emitProgress({
          section: section.id,
          file: section.file,
          index: index + 1,
          total: outline.sections.length,
        });
      }
      for (const record of evidence) {
        await safeMarkUsage(services, ctx.projectId, record.id, ctx.runId);
      }
      await services.manuscript.writeMainTex(ctx.projectId, outline, bibliography.length > 0);
      await services.manuscript.rebuildContext(ctx.projectId, {
        evidenceStats: await services.evidence.stats(ctx.projectId),
      });
      // M9.5：初稿 bib 裁剪为实际引用集合（与正文同一修订号提交）
      await syncReferencesBib(services, ctx.projectId);
      // 初稿完成：提交首个内容修订
      const revision = await services.revisions.commit(ctx.projectId, "writing.sections", ctx.runId);
      return {
        sectionsWritten: written.length,
        sections: written,
        bytesTotal,
        revision: revision.revision,
        evidenceFormal: evidenceSelection.formal.length,
        evidenceExcluded: evidenceSelection.excluded,
      };
    },
    async verifyDod(ctx) {
      const violations: string[] = [];
      const outline = await services.manuscript.loadOutline(ctx.projectId);
      if (outline === null) {
        return ["manuscript/outline.json 不存在"];
      }
      const statuses = await services.manuscript.sectionStatuses(ctx.projectId);
      for (const section of outline.sections) {
        const status = statuses.find((candidate) => candidate.id === section.id);
        if (!status?.exists) {
          violations.push(`sections/${section.file} 不存在`);
        } else if (!status.nonEmpty) {
          violations.push(`sections/${section.file} 内容为空`);
        }
      }
      return violations;
    },
  };
}

export function createIdeaToPaperDefinition(services: WorkflowServices): WorkflowDefinition {
  const stages: readonly StageSpec[] = [
    researchIdeaStage(services),
    evidenceGroundStage(services),
    feasibilityStage(services),
    feasibilityConfirmStage(services),
    outlinePlanStage(services),
    outlineConfirmStage(services),
    evidenceSupplyStage(services),
    writingSectionsStage(services),
    citationVerifyStage(services),
    reviewRunStage(services),
    qualityGateStage(services),
    revisionPlanStage(services),
    evidenceGroundClaimsStage(services),
    revisionRestoreFactsStage(services),
    revisionReviseStage(services, "revision.revise"),
    revisionValidateStage(services),
    revisionValidationDecisionStage(services),
    revisionRepairStage(services),
    revisionOverflowStage(),
    revisionStalledStage(services),
    stylePolishDecisionStage(services),
    stylePolishStage(services),
    buildDraftStage(services),
    buildFinalStage(services),
  ];

  const front = [
    "research.idea",
    "evidence.ground",
    "research.feasibility",
    "hitl.feasibility_confirm",
    "outline.plan",
    "hitl.outline_confirm",
  ];

  return {
    kind: "idea_to_paper",
    description:
      "Idea-to-Paper：调研 → 可行性 → 确认 → 大纲 → 确认 →（证据供给提示，条件出现）→ 分节写作 → 引用核验 → 审稿 → Quality Gate →（bounded 修订 + 修订复核）→ 构建",
    stages,
    plan(state: WorkflowState): PlanDecision {
      for (const stageId of front) {
        if (!(stageId in state.stageResults)) {
          return { kind: "stage", stageId };
        }
      }
      // M9.7.4：待审候选较多时，写作前呈现一次 evidence-supply HITL
      const evidenceSupply = planEvidenceSupply(state);
      if (evidenceSupply !== null) {
        return evidenceSupply;
      }
      if (!("writing.sections" in state.stageResults)) {
        return { kind: "stage", stageId: "writing.sections" };
      }
      return planSharedTail(state, services);
    },
    async onInput(state, stageId, input): Promise<void | "cancel"> {
      switch (stageId) {
        case "hitl.feasibility_confirm":
          return applyFeasibilityDecision(services, state, input);
        case "hitl.outline_confirm":
          return applyOutlineDecision(state, input);
        case "hitl.evidence_supply":
          return applyEvidenceSupplyDecision(state, input);
        case "hitl.revision_overflow":
          return applyOverflowDecision(state, input);
        case "hitl.revision_stalled":
          return applyStalledDecision(state, input);
        case "hitl.revision_validation":
          return applyRevisionValidationDecision(services, state, input);
        case "hitl.style_polish":
          return applyStylePolishDecision(state, input);
        default:
          throw new WorkflowInvalidStateError(state.runId, state.status, `未知的待办节点 ${stageId}`);
      }
    },
  };
}

// ============================================================
// Existing-Paper Improvement 定义
// ============================================================

function importParseStage(services: WorkflowServices): StageSpec {
  return {
    id: "import.parse",
    description: "校验已导入的 LaTeX 项目结构（PDF 导入项目先确定性重建为可修订稿件）",
    requiredInputs: [],
    producedOutputs: ["结构校验结果"],
    maxAttempts: 1,
    timeoutMs: 60_000,
    retryable: [],
    async execute(ctx) {
      const report = await readImportReport(services, ctx.projectId);
      let files = await collectLatexFiles(services.projects.manuscriptDir(ctx.projectId));
      // PDF 导入（goal=improvement）项目：无 LaTeX 输入时从已解析的 PaperDocument
      // 确定性重建 outline / sections / references.bib / 组装根（零 LLM，M4.8）
      let reconstruction: null | { sections: number; references: number; citationsMapped: number; warnings: string[] } = null;
      if (files.mainTex === null) {
        const project = await services.projects.getRequired(ctx.projectId);
        const result = await reconstructManuscriptFromPaper({
          projects: services.projects,
          paper: services.paper.store,
          manuscript: services.manuscript,
          projectId: ctx.projectId,
          projectTitle: project.title,
        });
        if (result !== null) {
          await writeReconstructionReport(services.projects, ctx.projectId, result);
          reconstruction = result;
          files = await collectLatexFiles(services.projects.manuscriptDir(ctx.projectId));
        }
      }
      if (files.mainTex === null) {
        throw new BusinessError(
          "IMPORT_VALIDATION",
          "项目缺少可解析的 main.tex（LaTeX 导入未完成，且没有可重建的 PDF 解析结果）",
        );
      }
      return {
        entryFile: report?.structure.entryFile ?? "main.tex",
        texFiles: files.allTex.length,
        bibFile: report?.structure.bibFile ?? null,
        ...(reconstruction !== null
          ? {
              reconstructedFromPdf: true,
              reconstructedSections: reconstruction.sections,
              reconstructedReferences: reconstruction.references,
              reconstructedCitations: reconstruction.citationsMapped,
            }
          : {}),
        warnings: (reconstruction?.warnings ?? files.warnings).slice(0, 5),
      };
    },
  };
}

function importBaselineBuildStage(services: WorkflowServices): StageSpec {
  return {
    id: "import.baseline_build",
    description: "Baseline Compile：记录原项目编译基线（失败不是 workflow 错误）",
    requiredInputs: ["import.parse"],
    producedOutputs: ["build/baseline 状态"],
    maxAttempts: 1,
    timeoutMs: services.stageTimeoutMs,
    retryable: [],
    async execute(ctx) {
      const report = await readImportReport(services, ctx.projectId);
      if (report?.baselineCompile.attempted) {
        return {
          baselineOk: report.baselineCompile.ok,
          fromImport: true,
          ...(report.baselineCompile.error !== undefined
            ? { error: report.baselineCompile.error }
            : {}),
        };
      }
      // 导入时未编译（如测试注入跳过）：现补一次 best-effort 编译
      const { build } = await runBuildGate(services.projects, services.latex, ctx.projectId);
      return { baselineOk: build.passed, fromImport: false, reasons: build.reasons.slice(0, 3) };
    },
  };
}

/**
 * M10.3 Stage A：资产清单（确定性，无 LLM）。
 * sources ↔ 案例角色映射（MANIFEST 是事实边界，不按文件名猜测）；
 * 产物 research/asset-inventory.json 供隔离校验与报告消费。MANIFEST 缺失
 * 退化为 unclassified 清单（不阻塞——非真实案例项目没有案例清单）。
 */
function importInventoryStage(services: WorkflowServices): StageSpec {
  return {
    id: "import.inventory",
    description: "资产清单：source ↔ 案例角色映射（MANIFEST 事实边界；确定性）",
    requiredInputs: ["import.parse"],
    producedOutputs: ["research/asset-inventory.json"],
    maxAttempts: 1,
    timeoutMs: 60_000,
    retryable: [],
    async execute(ctx) {
      const items = await services.sources.list(ctx.projectId);
      let manifestRaw: string | null = null;
      for (const item of items) {
        const name = (item.originalName ?? item.fileName ?? "").toLowerCase();
        if (name === "manifest.json" && item.fileName !== undefined) {
          try {
            manifestRaw = await readFile(
              await services.sources.filePath(ctx.projectId, item.sourceId),
              "utf8",
            );
          } catch {
            manifestRaw = null;
          }
          break;
        }
      }
      const inventory = buildAssetInventory(
        items.map((item) => ({
          sourceId: item.sourceId,
          fileName: item.fileName ?? item.sourceId,
          ...(item.originalName !== undefined ? { originalName: item.originalName } : {}),
          sourceType: item.sourceType ?? "other",
        })),
        manifestRaw,
      );
      await writeJsonAtomic(
        join(services.projects.researchDir(ctx.projectId), "asset-inventory.json"),
        inventory,
      );
      return {
        sources: inventory.entries.length,
        manifestFound: inventory.manifestFound,
        current: inventory.domains.current.length,
        historicalBoard: inventory.domains.historicalBoard.length,
        historical: inventory.domains.historical.length,
        feedback: inventory.domains.feedback.length,
        unclassified: inventory.domains.unclassified.length,
        warnings: inventory.warnings.slice(0, 3),
      };
    },
    async verifyDod(ctx) {
      try {
        await readFile(
          join(services.projects.researchDir(ctx.projectId), "asset-inventory.json"),
          "utf8",
        );
        return [];
      } catch {
        return ["research/asset-inventory.json 不存在"];
      }
    },
  };
}

/**
 * M10.3 Stage C：Revision Baseline（确定性，无 LLM）。
 * 从 current manuscript 提取事实基线（表格 / 数字 / 公式 / 方向句 / 引用 /
 * 图片 / 硬件 / 占位）→ research/revision-baseline.json。正式修改前的
 * 冻结事实投影：修订可追溯、冲突检测、报告输入。
 */
function importBaselineStage(services: WorkflowServices): StageSpec {
  return {
    id: "import.baseline",
    description: "Revision Baseline：current manuscript 事实基线（确定性）",
    requiredInputs: ["import.parse"],
    producedOutputs: ["research/revision-baseline.json"],
    maxAttempts: 1,
    timeoutMs: 60_000,
    retryable: [],
    async execute(ctx) {
      const files = await collectLatexFiles(services.projects.manuscriptDir(ctx.projectId));
      if (files.allTex.length === 0) {
        throw new BusinessError("STAGE_CONTRACT_VIOLATION", "manuscript 目录没有任何 .tex 文件");
      }
      const baseline = buildRevisionBaseline(
        files.allTex.map((file) => ({ file: file.relativePath, content: file.content })),
      );
      await writeJsonAtomic(
        join(services.projects.researchDir(ctx.projectId), "revision-baseline.json"),
        baseline,
      );
      return {
        contentHash: baseline.contentHash.slice(0, 12),
        tables: baseline.tables.length,
        citationKeys: baseline.citationKeys.length,
        figures: baseline.figures.length,
        hardware: baseline.hardware.length,
        placeholders: baseline.placeholders,
      };
    },
    async verifyDod(ctx) {
      try {
        const raw = JSON.parse(
          await readFile(
            join(services.projects.researchDir(ctx.projectId), "revision-baseline.json"),
            "utf8",
          ),
        ) as { contentHash?: unknown };
        return typeof raw.contentHash === "string" && raw.contentHash.length === 64
          ? []
          : ["revision-baseline.json 缺少合法 contentHash"];
      } catch {
        return ["research/revision-baseline.json 不存在或不可解析"];
      }
    },
  };
}

function importUnderstandStage(services: WorkflowServices): StageSpec {
  return {
    id: "import.understand",
    description: "Researcher 论文理解（结构 / 贡献 / 论证 / 实验 / 弱点）",
    requiredInputs: ["import.baseline_build"],
    producedOutputs: ["research/research.json（existing_paper_analysis）"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs,
    retryable: ["transient", "timeout", "runtime_unavailable", "contract_violation"],
    async execute(ctx) {
      const digest = await buildManuscriptDigest(services, ctx.projectId);
      const result = await services.researcher.analyzeExistingPaper({
        projectId: ctx.projectId,
        manuscriptDigest: digest,
      });
      return {
        taskId: result.taskId,
        weaknesses: result.weaknesses.length,
        contributions: result.contributions.length,
      };
    },
    async verifyDod(ctx) {
      const artifact = await readResearchArtifact(services.projects, ctx.projectId);
      return artifact === null ? ["research/research.json 不存在"] : [];
    },
  };
}

// ============================================================
// M10.3：修订研究链（M8 Research Plan → requirements → execute →
// evidence_supply → propose → ground；requirement-driven，无即时检索）
// ============================================================

/**
 * research.plan（LLM）：把「需要新增/补强文献的位置」转化为 M8 ResearchPlan。
 * 输入 = 论文理解弱点 + 外部意见（文献相关部分）+ 作者修订目标（run prompt）。
 * 只规划不检索；计划落盘 draft，等待 hitl.research_plan 批准。
 */
function researchPlanStage(services: WorkflowServices): StageSpec {
  return {
    id: "research.plan",
    description: "修订研究规划：文献缺口 → M8 ResearchPlan（requirements 驱动 queries；只规划不检索）",
    requiredInputs: ["assessment.target"],
    producedOutputs: ["research/research.json 计划链（draft）"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs,
    retryable: ["transient", "timeout", "runtime_unavailable", "contract_violation"],
    async execute(ctx) {
      const artifact = await requireResearchArtifact(services, ctx.projectId);
      const digest = [
        `概述：${artifact.report.domainOverview.slice(0, 600)}`,
        `弱点：${artifact.report.researchGaps.slice(0, 8).join("；")}`,
        `文献方向：${artifact.report.literaturePlan.slice(0, 6).join("；")}`,
        `研究问题：${artifact.report.researchQuestions.slice(0, 6).join("；")}`,
      ].join("\n");
      const external = await collectExternalDirectives(services, ctx.projectId);
      const instructionDigest = external
        .slice(0, 10)
        .map((directive) => `- [${directive.reviewerLabel ?? directive.source}] ${firstLine(directive.text, 200)}`)
        .join("\n");
      const authorGoal = readAuthorGoal(ctx.state.request);
      const feedback = readFeedback(ctx.state.inputs["hitl.research_plan"]?.payload);
      const result = await services.researcher.planRevisionResearch({
        projectId: ctx.projectId,
        analysisDigest: digest,
        ...(instructionDigest !== "" ? { externalInstructionDigest: instructionDigest } : {}),
        ...(authorGoal !== undefined ? { authorGoal } : {}),
        ...(feedback !== undefined ? { feedback } : {}),
      });
      const coverageRelevant = result.plan.requirements?.length ?? 0;
      return {
        planId: result.plan.planId,
        status: result.plan.status,
        questions: result.plan.questions.length,
        queries: result.plan.queries.length,
        requirements: coverageRelevant,
        ...(result.regenerated ? { regenerated: true } : {}),
      };
    },
    async verifyDod(ctx) {
      const artifact = await readResearchArtifact(services.projects, ctx.projectId);
      return artifact === null || (artifact.plans ?? []).length === 0
        ? ["research/research.json 缺少计划链"]
        : [];
    },
  };
}

/**
 * hitl.research_plan：M8 纪律——计划批准是 HITL（绝不自动批准）。
 * M11.1.4：survey 模式只换业务文案（检索语义不同：为综述找全文献，而非补强
 * 修订证据）；payload / 决策语义完全复用。
 */
function researchPlanConfirmStage(services: WorkflowServices, options: { survey?: boolean } = {}): StageSpec {
  return {
    id: "hitl.research_plan",
    description: options.survey === true ? "等待用户批准综述研究计划（检索执行前）" : "等待用户批准修订研究计划（检索执行前）",
    requiredInputs: ["research.plan"],
    producedOutputs: ["用户决策"],
    hitl: {
      prompt:
        options.survey === true
          ? "综述研究计划已生成（研究问题 + 检索词 + 初始方法分类词表；批准后将执行计划内检索并整理候选文献）。也可以带反馈重新规划，或取消"
          : "修订研究计划已生成（只覆盖需要外部文献支撑的修订需求；自身实验数据不属于文献管道）。批准后将执行计划内检索；也可以带反馈重新规划，或取消",
      options: ["approve", "revise", "cancel"],
      payload: async (ctx) => {
        const artifact = await readResearchArtifact(services.projects, ctx.projectId);
        const chain = artifact !== null ? readPlanChain(artifact) : null;
        const plan = chain?.plans.find((candidate) => candidate.planId === chain.activePlanId);
        if (plan === undefined) {
          return undefined;
        }
        return {
          planId: plan.planId,
          status: plan.status,
          questions: plan.questions.slice(0, 6),
          requirements: (plan.requirements ?? []).map((requirement) => ({
            requirementId: requirement.requirementId,
            topic: requirement.topic,
            claimType: requirement.claimType,
            expectedEvidenceType: requirement.expectedEvidenceType,
            priority: requirement.priority,
          })),
          queries: plan.queries.slice(0, 8).map((query) => ({
            queryId: query.queryId,
            query: query.query,
            kind: query.kind,
            ...(query.rationale !== undefined ? { rationale: query.rationale } : {}),
          })),
          // M11.1.4：survey 计划的画像意图（范围 + 初始 taxonomy + 覆盖意图）
          ...(artifact?.surveyProfile !== undefined
            ? {
                surveyProfile: {
                  ...(artifact.surveyProfile.scope !== "" ? { scope: artifact.surveyProfile.scope } : {}),
                  ...(artifact.surveyProfile.taxonomy !== undefined
                    ? {
                        taxonomyIntent: artifact.surveyProfile.taxonomy.families.map(
                          (family) => family.label,
                        ),
                      }
                    : {}),
                  ...(artifact.surveyProfile.coverageIntent !== undefined
                    ? { coverageIntent: artifact.surveyProfile.coverageIntent }
                    : {}),
                },
              }
            : {}),
        };
      },
    },
  };
}

/** HITL 决策：research_plan（approve → planExecution.approve；revise → 重规划） */
async function applyResearchPlanDecision(
  services: WorkflowServices,
  state: WorkflowState,
  input: ResumeInput,
): Promise<void | "cancel"> {
  if (input.decision === "approve") {
    // 幂等：计划已是 approved / done（前一批准过）→ 不重复批准，直接放行
    const artifact = await readResearchArtifact(services.projects, state.projectId);
    const chain = artifact !== null ? readPlanChain(artifact) : null;
    const plan = chain?.plans.find((candidate) => candidate.planId === chain.activePlanId);
    if (plan !== undefined && plan.status === "draft") {
      await services.planExecution.approve(state.projectId);
    }
    state.stageResults["hitl.research_plan"] = { decision: "approve" };
    return;
  }
  if (input.decision === "cancel") {
    return "cancel";
  }
  if (input.decision === "revise") {
    if (readFeedback(input.payload) === undefined) {
      throw new WorkflowInvalidStateError(
        state.runId,
        state.status,
        "revise 需要携带非空 payload.feedback",
      );
    }
    if (countCompletions(state, "research.plan") >= MAX_PLAN_REVISIONS) {
      throw new WorkflowInvalidStateError(
        state.runId,
        state.status,
        `研究计划修订次数已达上限（${MAX_PLAN_REVISIONS} 次），请 approve 或 cancel`,
      );
    }
    dropStageResult(state, "research.plan");
    return;
  }
  throw new WorkflowInvalidStateError(
    state.runId,
    state.status,
    `decision 只能是 approve / revise / cancel（当前 "${input.decision}"）`,
  );
}

/**
 * research.execute（确定性编排 + 外部检索）：执行批准后的计划检索
 * （结果快照回填，不写 Store）；随后 coverage 分析给出 requirement 覆盖视图。
 * 已 done 的计划（重跑场景）→ 只重算 coverage，不重复检索。
 */
function researchExecuteStage(services: WorkflowServices): StageSpec {
  return {
    id: "research.execute",
    description: "执行修订研究计划检索（requirement-driven；结果快照不自动入库）",
    requiredInputs: ["hitl.research_plan"],
    producedOutputs: ["research.json 执行历史 + 结果快照"],
    maxAttempts: 1,
    timeoutMs: services.stageTimeoutMs * 2,
    retryable: ["transient", "timeout"],
    async execute(ctx) {
      const artifact = await requireResearchArtifact(services, ctx.projectId);
      const chain = readPlanChain(artifact);
      const plan = chain.plans.find((candidate) => candidate.planId === chain.activePlanId);
      if (plan === undefined) {
        throw new BusinessError("STAGE_CONTRACT_VIOLATION", "缺少活动研究计划（先执行 research.plan）");
      }
      let executed = 0;
      let failed = 0;
      if (plan.status === "approved") {
        const result = await services.planExecution.execute(ctx.projectId);
        executed = result.executedQueries;
        failed = result.failedQueries;
      } else if (plan.status === "draft") {
        throw new BusinessError("STAGE_CONTRACT_VIOLATION", "研究计划尚未批准（先通过 hitl.research_plan）");
      }
      const coverage = await services.coverage.analyze(ctx.projectId);
      const missing = coverage.requirementCoverage.filter(
        (entry) => entry.coverage === "missing",
      ).length;
      const partial = coverage.requirementCoverage.filter(
        (entry) => entry.coverage === "partial",
      ).length;
      const pendingCandidates = (await services.candidates.list(ctx.projectId, "pending_review")).length;
      return {
        planId: plan.planId,
        planStatus: plan.status === "approved" ? "done" : plan.status,
        executed,
        failed,
        requirementsTotal: coverage.requirementCoverage.length,
        requirementsMissing: missing,
        requirementsPartial: partial,
        pendingCandidates,
      };
    },
  };
}

/** M10.3 planner 片段：研究执行后是否呈现 evidence-supply HITL（每 run 至多一次） */
function planEvidenceSupplyExisting(state: WorkflowState): PlanDecision | null {
  if ("hitl.evidence_supply" in state.stageResults) {
    return null;
  }
  const research = state.stageResults["research.execute"] ?? {};
  const pending = typeof research["pendingCandidates"] === "number" ? research["pendingCandidates"] : 0;
  const missing = typeof research["requirementsMissing"] === "number" ? research["requirementsMissing"] : 0;
  const partial = typeof research["requirementsPartial"] === "number" ? research["requirementsPartial"] : 0;
  const executed = typeof research["executed"] === "number" ? research["executed"] : 0;
  // 有可审候选（≥3 与 idea 流程同阈值），或存在未覆盖/部分覆盖的文献需求，
  // 或本轮真实执行过检索（用户需要从结果快照遴选候选）→ 呈现一次
  if (pending >= EVIDENCE_SUPPLY_MIN_PENDING || missing > 0 || partial > 0 || executed > 0) {
    return { kind: "stage", stageId: "hitl.evidence_supply" };
  }
  return null;
}

/**
 * research.propose（LLM + 工具）：从文献库全文为 requirements 提出锚定证据候选
 * （propose_evidence / retrieve_library / get_chunk）；候选进入核验管道，
 * verified 才转正。无全文可锚定时零候选（如实——需求覆盖留给 supply 链）。
 */
function researchProposeStage(services: WorkflowServices): StageSpec {
  return {
    id: "research.propose",
    description: "从文献库全文提出锚定证据候选（requirements 驱动；不检索）",
    requiredInputs: ["research.execute"],
    producedOutputs: ["evidence/candidates.jsonl 提案（待核验）"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs,
    retryable: ["transient", "timeout", "runtime_unavailable", "contract_violation"],
    async execute(ctx) {
      const artifact = await requireResearchArtifact(services, ctx.projectId);
      const chain = readPlanChain(artifact);
      const plan = chain.plans.find((candidate) => candidate.planId === chain.activePlanId);
      const requirementDigest = (plan?.requirements ?? [])
        .slice(0, 12)
        .map(
          (requirement) =>
            `- [${requirement.requirementId}][${requirement.priority}] ${requirement.topic}（${requirement.claimType} / ${requirement.expectedEvidenceType}）`,
        )
        .join("\n");
      const result = await services.researcher.proposeRevisionEvidence({
        projectId: ctx.projectId,
        requirementDigest:
          requirementDigest !== ""
            ? requirementDigest
            : "（计划未预写证据需求：只对正文修订明确需要的文献论断提出锚定证据）",
      });
      return {
        proposed: result.evidenceProposed,
        appended: result.evidenceAppended,
        taskId: result.taskId,
      };
    },
  };
}

function improvementPlanStage(services: WorkflowServices): StageSpec {
  return {
    id: "plan.improvement",
    description:
      "Writer 制定分节改进计划（审稿问题 + 目标差距 + 证据分层摘要 + 需求覆盖 + 基线事实）",
    requiredInputs: ["assessment.target"],
    producedOutputs: ["research/improvement-plan.json"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs,
    retryable: ["transient", "timeout", "runtime_unavailable", "contract_violation"],
    async execute(ctx) {
      const review = await latestReviewSummary(services, ctx.projectId);
      const feasibility = (await readFeasibilityReport(services.projects, ctx.projectId))?.report ?? null;
      const artifact = await requireResearchArtifact(services, ctx.projectId);
      const project = await services.projects.getRequired(ctx.projectId);
      const feedback = readFeedback(ctx.state.inputs["hitl.plan_confirm"]?.payload);
      const files = await collectLatexFiles(services.projects.manuscriptDir(ctx.projectId));
      // M10.3：计划输入扩展——A 原稿基线 / B user_confirmed 实验证据 /
      // E verified 文献证据 / 需求覆盖 / 外部意见 / 作者目标
      const baselineDigest = await readBaselineDigest(services, ctx.projectId);
      const evidenceDigest = await buildEvidenceDigest(services, ctx.projectId);
      const coverageDigest = await buildCoverageDigest(services, ctx.projectId);
      const instructionDigest = await buildInstructionDigest(services, ctx.projectId);
      const authorGoal = readAuthorGoal(ctx.state.request);
      // 确定性 id 清单：Writer 条目的 relatedEvidenceIds / instructionId 只能从中选取
      const [evidenceIds, instructions] = await Promise.all([
        services.evidence.list(ctx.projectId),
        services.externalInstructions.load(ctx.projectId),
      ]);
      const plan = await services.writer.planImprovement({
        projectId: ctx.projectId,
        issues: review?.issues ?? [],
        analysisDigest: `${artifact.report.domainOverview.slice(0, 400)}\n弱点：${artifact.report.researchGaps.slice(0, 5).join("；")}`,
        feasibilityLevel: feasibility?.level ?? "未评估",
        targetProfile: project.targetProfile,
        // 计划条目必须指向真实存在的章节文件（PDF 重建项目为 sections/secNN.tex）；
        // 单文件 LaTeX 项目 sections 为空 → 条目使用 main.tex
        sectionFiles: files.sections.map((file) => file.relativePath).slice(0, 20),
        ...(files.sections.length === 0 && files.mainTex !== null
          ? {
              logicalTargets: locateLatexSections("main.tex", files.mainTex.content).map((span) => ({
                file: span.file,
                logicalSection: span.logicalSection,
                heading: span.heading,
                ...(span.label !== undefined ? { label: span.label } : {}),
              })).slice(0, 80),
            }
          : {}),
        ...(baselineDigest !== undefined ? { baselineDigest } : {}),
        ...(evidenceDigest !== undefined ? { evidenceDigest } : {}),
        ...(coverageDigest !== undefined ? { coverageDigest } : {}),
        ...(instructionDigest !== undefined ? { instructionDigest } : {}),
        ...(authorGoal !== undefined ? { authorGoal } : {}),
        ...(feedback !== undefined ? { feedback } : {}),
        validEvidenceIds: evidenceIds.map((record) => record.id),
        validEvidenceProtocolScopes: Object.fromEntries(
          evidenceIds.flatMap((record) => record.protocolScope !== undefined ? [[record.id, record.protocolScope]] : []),
        ),
        validInstructionIds: instructions.map((instruction) => instruction.instructionId),
        externalInstructions: instructions.map((instruction) => ({
          instructionId: instruction.instructionId,
          text: instruction.text,
        })),
      });
      await writeJsonAtomic(
        join(services.projects.researchDir(ctx.projectId), "improvement-plan.json"),
        { generatedAt: new Date().toISOString(), plan },
      );
      return {
        items: plan.items.length,
        evidenceLinkedItems: plan.items.filter((item) => (item.relatedEvidenceIds ?? []).length > 0).length,
        instructionLinkedItems: plan.items.filter((item) => item.instructionId !== undefined).length,
      };
    },
    async verifyDod(ctx) {
      try {
        await readFile(
          join(services.projects.researchDir(ctx.projectId), "improvement-plan.json"),
          "utf8",
        );
        return [];
      } catch {
        return ["research/improvement-plan.json 不存在"];
      }
    },
  };
}

function planConfirmStage(services: WorkflowServices): StageSpec {
  return {
    id: "hitl.plan_confirm",
    description: "等待用户确认改进计划",
    requiredInputs: ["assessment.target"],
    producedOutputs: ["用户决策"],
    hitl: {
      prompt: "改进计划已生成，请确认后开始逐节改造",
      options: ["approve", "revise", "cancel"],
      payload: async (ctx) => {
        try {
          const plan = JSON.parse(
            await readFile(
              join(services.projects.researchDir(ctx.projectId), "improvement-plan.json"),
              "utf8",
            ),
          ) as { plan?: { items?: { section: string; action: string; priority: string }[] } };
          const feasibility = (await readFeasibilityReport(services.projects, ctx.projectId))?.report;
          return {
            feasibilityLevel: feasibility?.level ?? null,
            items: (plan.plan?.items ?? []).slice(0, 10),
          };
        } catch {
          return undefined;
        }
      },
    },
  };
}

export function createExistingPaperDefinition(services: WorkflowServices): WorkflowDefinition {
  const stages: readonly StageSpec[] = [
    importParseStage(services),
    importBaselineBuildStage(services),
    importInventoryStage(services),
    importBaselineStage(services),
    importUnderstandStage(services),
    citationVerifyStage(services),
    reviewRunStageInner(services, { existingPaper: true }),
    feasibilityStage(services, "assessment.target"),
    researchPlanStage(services),
    researchPlanConfirmStage(services),
    researchExecuteStage(services),
    evidenceSupplyStage(services, ["research.execute"]),
    researchProposeStage(services),
    evidenceGroundStage(services, ["research.propose"]),
    improvementPlanStage(services),
    planConfirmStage(services),
    revisionReviseStage(services, "revision.apply"),
    revisionReviseStage(services, "revision.revise"),
    revisionValidateStage(services),
    revisionValidationDecisionStage(services),
    revisionPlanStage(services),
    evidenceGroundClaimsStage(services),
    revisionRestoreFactsStage(services),
    revisionRepairStage(services),
    revisionOverflowStage(),
    revisionStalledStage(services),
    stylePolishDecisionStage(services),
    stylePolishStage(services),
    buildDraftStage(services),
    qualityGateStage(services),
    buildFinalStage(services),
    revisionReportStage(services),
  ];

  const frontPre = [
    "import.parse",
    "import.baseline_build",
    "import.inventory",
    "import.baseline",
    "import.understand",
    "citation.verify",
    "review.run",
    "assessment.target",
    "research.plan",
    "hitl.research_plan",
    "research.execute",
  ];
  const frontPost = ["plan.improvement", "hitl.plan_confirm", "revision.apply"];

  return {
    kind: "existing_paper_improvement",
    description:
      "Existing-LaTeX Improvement：结构解析 → 基线编译 → 资产清单 → 事实基线 → 论文理解 → 引用审计 → 审稿 → 目标评估 →（M10.3：修订研究计划 → 批准 → 检索执行 → 证据供给提示 → 锚定提案 → 三段核验）→ 改进计划 → 确认 → 逐节改造 →（共享后段：复审 / Quality Gate / bounded 修订 + 修订复核 / 构建）→ Revision Trace 报告",
    stages,
    plan(state: WorkflowState): PlanDecision {
      for (const stageId of frontPre) {
        if (!(stageId in state.stageResults)) {
          return { kind: "stage", stageId };
        }
      }
      // M10.3：检索执行后呈现一次 evidence-supply HITL（用户遴选候选 /
      // promote / 全文获取 / supply-query；continue 后走锚定提案 + 核验）
      const evidenceSupply = planEvidenceSupplyExisting(state);
      if (evidenceSupply !== null) {
        return evidenceSupply;
      }
      if (!("research.propose" in state.stageResults)) {
        return { kind: "stage", stageId: "research.propose" };
      }
      if (!("evidence.ground" in state.stageResults)) {
        return { kind: "stage", stageId: "evidence.ground" };
      }
      for (const stageId of frontPost) {
        if (!(stageId in state.stageResults)) {
          return { kind: "stage", stageId };
        }
      }
      const tail = planSharedTail(state, services);
      if (tail.kind === "complete" && !("revision.report" in state.stageResults)) {
        // 收尾产物：Revision Trace / Author Revision Report（确定性投影；
        // Draft 完成路径同样产出——返修语境下 Draft 即当前可用产物）
        return { kind: "stage", stageId: "revision.report" };
      }
      return tail;
    },
    async onInput(state, stageId, input): Promise<void | "cancel"> {
      switch (stageId) {
        case "hitl.research_plan":
          return applyResearchPlanDecision(services, state, input);
        case "hitl.evidence_supply":
          return applyEvidenceSupplyDecision(state, input);
        case "hitl.plan_confirm": {
          const result = await applyPlanDecision(state, input);
          if (input.decision === "approve") {
            // M10.3.1 G1：批准即授权——改进计划条目固化进 append-only 授权台账
            // （后续 run 覆盖 improvement-plan.json 也不丢失已授予的事实变更授权）
            await recordImprovementPlanApproval(services.projects, state.projectId, state.runId);
          }
          return result;
        }
        case "hitl.revision_overflow":
          return applyOverflowDecision(state, input);
        case "hitl.revision_stalled":
          return applyStalledDecision(state, input);
        case "hitl.revision_validation":
          return applyRevisionValidationDecision(services, state, input);
        case "hitl.style_polish":
          return applyStylePolishDecision(state, input);
        default:
          throw new WorkflowInvalidStateError(state.runId, state.status, `未知的待办节点 ${stageId}`);
      }
    },
  };
}

// ============================================================
// Existing-Paper Review（PDF 只读快速 Review）定义
// ============================================================

/**
 * 与旧 POST /api/projects/:id/review（manuscriptDigest + Evidence + 旧
 * Citation report 的三路审稿）是两条不同链路：本定义走 PDF Review
 * Foundation——Final PDF → PaperMap → Citation Integrity artifacts →
 * 分章节 Review（ReviewContextBuilder 受控上下文）→ ReviewFinding →
 * 聚合报告（reviews/existing-review-r*.json）。只读，不改正文。
 */
function paperEnsureStage(services: WorkflowServices): StageSpec {
  return {
    id: "paper.ensure",
    description: "确认 Final PDF 已解析并构建 PaperMap（章节导航与摘要）",
    requiredInputs: [],
    producedOutputs: ["paper/paper-map.json"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs,
    retryable: ["transient", "timeout"],
    async execute(ctx) {
      const document = await services.paper.store.loadDocument(ctx.projectId);
      if (document === null) {
        throw new BusinessError(
          "STAGE_CONTRACT_VIOLATION",
          "尚未上传/解析 Final PDF（先导入论文 PDF 再启动 Review）",
        );
      }
      const map = await services.paper.map.ensureMap(ctx.projectId, { signal: ctx.signal });
      const mapTelemetry = services.paper.map.lastTelemetry;
      return {
        pageCount: map.pageCount,
        sections: map.sections.length,
        ...(map.documentTitle !== undefined ? { documentTitle: map.documentTitle } : {}),
        // 性能画像（run checkpoint 持久化，事后分析）
        pdfParseMs: document.parse.durationMs,
        paperMapTelemetry: mapTelemetry ?? { modelCalls: 0, summariesRefreshed: 0, failures: 0 },
      };
    },
    async verifyDod(ctx) {
      const map = await services.paper.store.loadMap(ctx.projectId);
      return map === null ? ["paper/paper-map.json 不存在"] : [];
    },
  };
}

function citationExtractStage(services: WorkflowServices): StageSpec {
  return {
    id: "citation.extract",
    description: "引用提取：参考文献条目 + 正文引用（确定性）",
    requiredInputs: ["paper.ensure"],
    producedOutputs: ["paper/citation/references.json", "paper/citation/callouts.json"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs,
    retryable: ["transient", "timeout"],
    async execute(ctx) {
      const { result, reused } = await services.paper.citationIntegrity.extract(ctx.projectId);
      return { references: result.references.length, callouts: result.callouts.length, reused };
    },
    async verifyDod(ctx) {
      const summary = await services.paper.citationIntegrity.summary(ctx.projectId);
      return summary.extracted ? [] : ["引用提取产物不存在"];
    },
  };
}

function citationMetadataStage(services: WorkflowServices): StageSpec {
  return {
    id: "citation.metadata",
    description: "引用真实性核验：公开学术库 metadata 比对",
    requiredInputs: ["citation.extract"],
    producedOutputs: ["paper/citation/metadata/*.json"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs,
    retryable: ["transient", "timeout"],
    async execute(ctx) {
      const result = await services.paper.citationIntegrity.verifyMetadata(ctx.projectId, {
        signal: ctx.signal,
      });
      return {
        checked: result.checked,
        byStatus: result.byStatus,
        reused: result.reused,
        // 性能画像：外部检索调用 / 缓存 / 按 provider（run checkpoint 持久化）
        lookup: {
          providerCalls: result.telemetry.providerCalls,
          cacheHits: result.telemetry.cacheHits,
          retries: result.telemetry.retries,
          softwareCalls: result.profile.software.apiCalls + result.profile.software.htmlCalls,
          byProvider: result.profile.byProvider,
        },
      };
    },
  };
}

function citationClaimsStage(services: WorkflowServices): StageSpec {
  return {
    id: "citation.claims",
    description: "Claim-Citation 一致性核验（语义判断，逐条记录；contradiction_only 仅检查明显矛盾）",
    requiredInputs: ["citation.extract"],
    producedOutputs: ["paper/citation/claims/*.json"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs,
    retryable: ["transient", "timeout", "runtime_unavailable"],
    async execute(ctx) {
      // 模式来自 run request（off 时 planner 不会进入本 stage；历史 run 缺省 full）
      const mode = readSemanticMode(ctx.state.request);
      const result = await services.paper.citationIntegrity.verifyClaims(ctx.projectId, {
        signal: ctx.signal,
        mode,
        // 长批 judge / 拆解期间逐条汇报进度（喂空闲超时看门狗；30 条 judge × 40s+
        // 真实模型会超过 15min 无进展窗口，此前 stage 被误判超时后靠重试续跑）
        onProgress: (done, total) =>
          ctx.emitProgress({ phase: "semantic", done, total }),
      });
      return {
        mode,
        summary: result.summary,
        reused: result.reused,
        // 性能画像：模式 / 模型调用 / 确定性短路 / 拆解层 / 墙钟耗时（run checkpoint 持久化）
        modelTelemetry: {
          modelCalls: result.telemetry.modelCalls,
          skippedNoMetadata: result.telemetry.skippedNoMetadata,
          skippedNoEvidence: result.telemetry.skippedNoEvidence,
          failed: result.telemetry.failed,
          approxPromptChars: result.telemetry.approxPromptChars,
          totalModelMs: result.telemetry.totalModelMs,
          decompositionCalls: result.telemetry.decompositionCalls,
          decompositionCacheHits: result.telemetry.decompositionCacheHits,
          fallbackSentencePlans: result.telemetry.fallbackSentencePlans,
          sentencesPlanned: result.telemetry.sentencesPlanned,
        },
        durationMs: result.durationMs,
      };
    },
  };
}

function reviewSectionsStage(services: WorkflowServices): StageSpec {
  return {
    id: "review.sections",
    description: "分章节 Review：受控上下文 + Reviewer Agent → ReviewFinding",
    requiredInputs: ["paper.ensure", "citation.extract"],
    producedOutputs: ["章节 findings（进入聚合报告）"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs * 4,
    retryable: ["transient", "timeout", "runtime_unavailable"],
    async execute(ctx) {
      const allScopes = await services.paper.reviewContext.listSectionScopes(ctx.projectId);
      // 只有章节标题、没有正文的章节（如仅含子节的"3 实验与结果"）没有可审阅的内容：
      // 记为跳过，而不是让整个 run 失败
      const scopes = allScopes.filter((scope) => scope.chunkCount > 0 && scope.charCount >= MIN_REVIEW_SECTION_CHARS);
      const emptySections = allScopes.length - scopes.length;
      if (scopes.length === 0) {
        throw new BusinessError("STAGE_CONTRACT_VIOLATION", "论文没有可审阅的章节（所有章节都没有文本）");
      }
      const sectionLimit =
        services.review.reviewSectionLimit > 0
          ? Math.min(services.review.reviewSectionLimit, MAX_REVIEW_SECTIONS)
          : MAX_REVIEW_SECTIONS;
      const capped = scopes.slice(0, sectionLimit);
      const skipped = scopes.length - capped.length + emptySections;

      // 本节引用上下文：callout 关联到 reference 条目 + metadata 核验状态
      const callouts = await services.paper.store.loadCallouts<CitationCallout>(ctx.projectId);
      const references = await services.paper.store.loadReferences<ReferenceEntry>(ctx.projectId);
      const metadataRecords = await services.paper.citationIntegrity.listMetadataRecords(ctx.projectId);
      const statusByReference = new Map(metadataRecords.map((record) => [record.referenceId, record.status]));
      const rawTextByReference = new Map(references.map((entry) => [entry.referenceId, entry.rawText]));
      const jobs = capped.map((scope) => ({
        sectionId: scope.sectionId,
        contextScope: scope.contextScope,
        citations: callouts
          .filter((callout) => callout.sectionId === scope.sectionId)
          .flatMap((callout) => callout.references)
          .filter((relation) => relation.referenceId !== undefined)
          .map((relation) => ({
            referenceId: relation.referenceId!,
            rawText: rawTextByReference.get(relation.referenceId!) ?? relation.label,
            ...(statusByReference.get(relation.referenceId!) !== undefined
              ? { status: String(statusByReference.get(relation.referenceId!)) }
              : {}),
          })) as CitationContextEntry[],
      }));

      // 有界并发调度（backpressure：活跃模型调用 <= reviewConcurrency；单节失败
      // 不推翻整个池；每节完成立即落 journal；结果按论文顺序重排）。
      // 纯串行代码路径 = reviewConcurrency 1（语义与旧版一致）。
      const scheduler = new SectionReviewScheduler({
        store: services.paper.store,
        reviewContext: services.paper.reviewContext,
        sectionReview: services.paper.sectionReview,
        concurrency: services.review.reviewConcurrency,
        attempts: SECTION_REVIEW_ATTEMPTS,
        backoffMs: services.review.sectionRetryBackoffMs ?? SECTION_REVIEW_BACKOFF_MS,
        instruction: SECTION_REVIEW_INSTRUCTION,
        log: (message) => ctx.log(message),
      });
      const result = await scheduler.run(jobs, {
        projectId: ctx.projectId,
        runId: ctx.runId,
        signal: ctx.signal,
        emitProgress: ctx.emitProgress,
      });
      return {
        sectionsReviewed: result.reviewed.length,
        sectionsTotal: allScopes.length,
        skippedSections: skipped,
        emptySections,
        failedSections: result.failedSections,
        findingsTotal: result.findings.length,
        parseFailures: result.parseFailures,
        dropped: result.dropped,
        findings: result.findings,
        // 性能画像：每节一次模型调用（含节内重试），prompt/输出规模（run checkpoint 持久化）
        modelTelemetry: services.paper.sectionReview.lastTelemetry ?? {
          calls: 0,
          failed: 0,
          totalMs: 0,
          approxPromptChars: 0,
          outputChars: 0,
        },
        // 性能画像：并发度 / 队列等待 / wall vs sum-duration（run checkpoint 持久化）
        concurrencyTelemetry: result.telemetry,
      };
    },
    // DoD 由 review.aggregate 的文件级校验兜底（verifyDod 运行时本次产出
    // 尚未写入 stageResults，无法自读；findings 结构在聚合层强校验）
  };
}

function reviewAggregateStage(services: WorkflowServices): StageSpec {
  return {
    id: "review.aggregate",
    description: "聚合 Review Findings + Citation Integrity → 审阅报告（确定性）",
    requiredInputs: ["review.sections"],
    producedOutputs: ["reviews/existing-review-r*.json"],
    maxAttempts: 1, // 纯确定性聚合
    timeoutMs: services.stageTimeoutMs,
    retryable: [],
    async execute(ctx) {
      const sections = ctx.state.stageResults["review.sections"] ?? {};
      // findings 来自 checkpoint JSON（可能被手工编辑 / 损坏）：逐条校验，不盲信结构
      const { findings, dropped: corrupted } = readFindings(sections["findings"]);
      if (corrupted > 0) {
        ctx.log(`review.aggregate：checkpoint 中 ${corrupted} 条 finding 结构损坏，已丢弃`);
      }
      const integrity = await services.paper.citationIntegrity.integrityReport(ctx.projectId);
      const map = await services.paper.store.loadMap(ctx.projectId);
      const project = await services.projects.getRequired(ctx.projectId);
      // 本轮语义核验模式（run request；历史 run 缺省 full）。off 时绝不把项目里
      // 历史遗留的 claim records 汇总成本轮语义统计——按轮隔离，旧记录只属于旧轮
      const citationSemanticMode = readSemanticMode(ctx.state.request);

      const bySeverity: Record<FindingSeverity, number> = { critical: 0, major: 0, minor: 0, info: 0 };
      const byCategory: Partial<Record<FindingCategory, number>> = {};
      for (const finding of findings) {
        bySeverity[finding.severity] += 1;
        byCategory[finding.category] = (byCategory[finding.category] ?? 0) + 1;
      }
      const round = countCompletions(ctx.state, "review.aggregate") + 1;
      const report = {
        schemaVersion: 1,
        kind: "existing_paper_review",
        round,
        generatedAt: new Date().toISOString(),
        citationSemanticMode,
        paper: {
          title: map?.documentTitle ?? project.title,
          ...(map !== null ? { pageCount: map.pageCount, sections: map.sections.length } : {}),
        },
        review: {
          sectionsReviewed: Number(sections["sectionsReviewed"] ?? 0),
          sectionsTotal: Number(sections["sectionsTotal"] ?? 0),
          skippedSections: Number(sections["skippedSections"] ?? 0),
          emptySections: Number(sections["emptySections"] ?? 0),
          failedSections: Array.isArray(sections["failedSections"]) ? sections["failedSections"].length : 0,
          findingsTotal: findings.length,
          parseFailures: Number(sections["parseFailures"] ?? 0),
          dropped: Number(sections["dropped"] ?? 0),
          bySeverity,
          byCategory,
        },
        citationIntegrity: {
          metadataByStatus: integrity.metadataByStatus,
          ...(citationSemanticMode === "off"
            ? {}
            : { semantic: integrity.semantic }),
          probableFabrications: integrity.probableFabrications,
        },
        findings,
      };
      const reportPath = await services.reviewArtifacts.saveExistingReview(ctx.projectId, round, report);
      return {
        round,
        findingsTotal: findings.length,
        bySeverity,
        reportPath,
      };
    },
    async verifyDod(ctx) {
      const round = countCompletions(ctx.state, "review.aggregate") + 1;
      const fileName = services.reviewArtifacts.existingReviewFileName(round);
      return (await services.reviewArtifacts.exists(ctx.projectId, fileName)) ? [] : [`reviews/${fileName} 不存在`];
    },
  };
}

export function createExistingPaperReviewDefinition(services: WorkflowServices): WorkflowDefinition {
  const stages: readonly StageSpec[] = [
    paperEnsureStage(services),
    citationExtractStage(services),
    citationMetadataStage(services),
    citationClaimsStage(services),
    reviewSectionsStage(services),
    reviewAggregateStage(services),
  ];

  const front = [
    "paper.ensure",
    "citation.extract",
    "citation.metadata",
    "citation.claims",
    "review.sections",
    "review.aggregate",
  ];

  return {
    kind: "existing_paper_review",
    description:
      "Existing-Paper Review：PaperMap → 引用提取 → 真实性核验 →（语义核验：按模式）→ 分章节审阅 → 聚合审阅报告（只读，不修改论文）",
    stages,
    plan(state: WorkflowState): PlanDecision {
      // 语义核验可配置（citationSemanticMode，随 run request 持久化）：
      //   off                跳过 citation.claims（不进入 stage，非「跑完再隐藏」）
      //   contradiction_only / full  执行 claims stage（服务内部按模式判定）
      // 历史 run（request 无该字段）→ full，保持升级前的 resume 语义。
      const mode = readSemanticMode(state.request);
      const sequence = mode === "off" ? front.filter((stageId) => stageId !== "citation.claims") : front;
      for (const stageId of sequence) {
        if (!(stageId in state.stageResults)) {
          return { kind: "stage", stageId };
        }
      }
      const aggregate = state.stageResults["review.aggregate"] ?? {};
      return {
        kind: "complete",
        label: "review",
        summary: {
          round: aggregate["round"] ?? 0,
          findingsTotal: aggregate["findingsTotal"] ?? 0,
          sectionsReviewed: state.stageResults["review.sections"]?.["sectionsReviewed"] ?? 0,
          reportPath: aggregate["reportPath"] ?? null,
          citationSemanticMode: mode,
        },
      };
    },
    async onInput(state, stageId): Promise<void | "cancel"> {
      throw new WorkflowInvalidStateError(
        state.runId,
        state.status,
        `本工作流没有待办节点（收到 ${stageId}）`,
      );
    },
  };
}

// ============================================================
// Topic → Survey 定义（M11.1.4 topic_survey）
// ============================================================

/**
 * 文献遴选推荐集上限（M11.1.4 第一版验收口径：15-25 篇 selected literature；
 * 超出按确定性排序截断，用户可用 payload.candidateIds 增删）。
 */
const SURVEY_RECOMMENDED_MAX = 25;

/**
 * 推荐文献集（纯函数，HITL 决策与 stage 执行共用同一实现保证确定性）：
 * 学术形态（DOI / arXiv）优先，年份降序（缺年份排后），candidateId 升序破平。
 */
export function recommendedSurveyCandidateIds(candidates: readonly CandidateSource[]): string[] {
  const paperLike = candidates.filter(
    (candidate) => candidate.doi !== undefined || candidate.arxivId !== undefined,
  );
  const pool = paperLike.length > 0 ? paperLike : [...candidates];
  return pool
    .sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || a.candidateId.localeCompare(b.candidateId))
    .slice(0, SURVEY_RECOMMENDED_MAX)
    .map((candidate) => candidate.candidateId);
}

/** run request + project 的综述范围摘要（survey.plan prompt 输入；纯函数） */
function surveyScopeDigest(
  project: { title: string; targetVenue?: string; targetProfile?: string; language?: string },
  request: Record<string, unknown> | undefined,
): string {
  const yearFrom = typeof request?.["yearFrom"] === "number" ? request["yearFrom"] : undefined;
  const yearTo = typeof request?.["yearTo"] === "number" ? request["yearTo"] : undefined;
  const targetLength =
    typeof request?.["targetLength"] === "string" && request["targetLength"].trim() !== ""
      ? request["targetLength"].trim().slice(0, 100)
      : undefined;
  const targetJournal =
    typeof request?.["targetJournal"] === "string" && request["targetJournal"].trim() !== ""
      ? request["targetJournal"].trim().slice(0, 200)
      : undefined;
  return [
    `- 综述主题：${project.title}`,
    yearFrom !== undefined || yearTo !== undefined
      ? `- 时间范围意图：${yearFrom ?? "…"}–${yearTo ?? "…"}（检索词与遴选以此为参考，不是硬过滤）`
      : undefined,
    targetLength !== undefined ? `- 篇幅目标：${targetLength}` : undefined,
    `- 目标期刊 / 会议：${targetJournal ?? project.targetVenue ?? "未指定"}`,
    `- 目标定位：${project.targetProfile ?? "未指定"}`,
    `- 写作语言：${project.language ?? "未指定"}`,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

/** survey.research_plan（id 复用 research.plan：与计划 HITL / 执行链同 id 空间） */
function surveyPlanStage(services: WorkflowServices): StageSpec {
  return {
    id: "research.plan",
    description: "综述研究规划：survey 语义的 ResearchPlan + surveyProfile（只规划不检索）",
    requiredInputs: [],
    producedOutputs: ["research/research.json（survey 计划链 draft + surveyProfile）"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs,
    retryable: ["transient", "timeout", "runtime_unavailable", "contract_violation"],
    async execute(ctx) {
      const project = await services.projects.getRequired(ctx.projectId);
      const feedback = readFeedback(ctx.state.inputs["hitl.research_plan"]?.payload);
      const result = await services.researcher.planSurveyResearch({
        projectId: ctx.projectId,
        scopeDigest: surveyScopeDigest(project, ctx.state.request),
        ...(feedback !== undefined ? { feedback } : {}),
      });
      return {
        planId: result.plan.planId,
        status: result.plan.status,
        questions: result.plan.questions.length,
        queries: result.plan.queries.length,
        requirements: result.plan.requirements?.length ?? 0,
        ...(result.profile?.taxonomy !== undefined
          ? { taxonomyIntent: result.profile.taxonomy.families.length }
          : {}),
        ...(result.regenerated ? { regenerated: true } : {}),
      };
    },
    async verifyDod(ctx) {
      const artifact = await readResearchArtifact(services.projects, ctx.projectId);
      return artifact === null || (artifact.plans ?? []).length === 0
        ? ["research/research.json 缺少综述计划链"]
        : [];
    },
  };
}

/**
 * survey.search：执行批准后的检索计划（复用 planExecution 的批准 / 执行 /
 * 幂等语义），随后把执行结果快照经 Discovery 单一写入口径物化为候选——
 * Search Result → Candidate 是系统动作（有界快照 ≤10/query），Candidate →
 * Literature（promote）仍只发生在用户批准 literature_selection 之后。
 */
function surveySearchStage(services: WorkflowServices): StageSpec {
  return {
    id: "survey.search",
    description: "执行综述检索计划并把结果快照物化为候选文献（Retrieved ≠ Candidate ≠ Literature）",
    requiredInputs: ["hitl.research_plan"],
    producedOutputs: ["research.json 执行历史 + 候选文献（pending_review）"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs * 2,
    retryable: ["transient", "timeout"],
    async execute(ctx) {
      const artifact = await requireResearchArtifact(services, ctx.projectId);
      const chain = readPlanChain(artifact);
      const plan = chain.plans.find((candidate) => candidate.planId === chain.activePlanId);
      if (plan === undefined) {
        throw new BusinessError("STAGE_CONTRACT_VIOLATION", "缺少活动研究计划（先执行 research.plan）");
      }
      let executed = 0;
      let failed = 0;
      if (plan.status === "approved") {
        await ctx.emitProgress({ phase: "search", done: 0, total: plan.queries.length });
        const result = await services.planExecution.execute(ctx.projectId);
        executed = result.executedQueries;
        failed = result.failedQueries;
      } else if (plan.status === "draft") {
        throw new BusinessError("STAGE_CONTRACT_VIOLATION", "研究计划尚未批准（先通过 hitl.research_plan）");
      }
      // plan.status === "done"：resume / 重跑场景——检索不重复执行

      // 结果快照 → 候选（幂等：同身份候选合并，不重复建）；只物化本活动计划的执行记录
      await ctx.emitProgress({ phase: "materialize" });
      const fresh = await requireResearchArtifact(services, ctx.projectId);
      let candidatesSaved = 0;
      let candidatesMerged = 0;
      for (const entry of fresh.executionHistory ?? []) {
        if (entry.planId !== plan.planId || entry.status !== "executed") {
          continue;
        }
        const snapshots = entry.resultSnapshot ?? [];
        if (snapshots.length === 0) {
          continue;
        }
        const indexes = snapshots.map((_, index) => index);
        const result =
          entry.kind === "academic"
            ? await services.discovery.saveAcademicSnapshotCandidates(
                ctx.projectId,
                entry.query,
                snapshots.filter(
                  (snapshot): snapshot is PlanExecutionAcademicResultSnapshot => snapshot.kind === "academic",
                ),
                indexes,
              )
            : await services.discovery.saveWebSnapshotCandidates(
                ctx.projectId,
                entry.query,
                snapshots.filter(
                  (snapshot): snapshot is PlanExecutionWebResultSnapshot => snapshot.kind === "web",
                ),
                indexes,
              );
        candidatesSaved += result.saved.length;
        candidatesMerged += result.mergedExisting.length;
      }
      const pending = await services.candidates.list(ctx.projectId, "pending_review");
      const sources = await services.sources.list(ctx.projectId);
      const libraryEligible = sources.filter(
        (item) => item.sourceRole !== "reference" && item.status !== "rejected",
      ).length;
      if (pending.length === 0 && libraryEligible === 0) {
        throw new BusinessError(
          "STAGE_CONTRACT_VIOLATION",
          `检索没有产生任何候选文献（executed=${executed} failed=${failed} saved=${candidatesSaved}）：请检查检索 provider 配置 / 网络后重跑，或在「文献发现」手动添加候选`,
        );
      }
      return {
        planId: plan.planId,
        planStatus: plan.status === "approved" ? "done" : plan.status,
        executed,
        failedQueries: failed,
        candidatesSaved,
        candidatesMerged,
        pendingCandidates: pending.length,
        recommended: recommendedSurveyCandidateIds(pending).length,
        libraryEligible,
      };
    },
  };
}

/** hitl.literature_selection：候选文献集合的正式确认（Corpus 入选是用户决策） */
function literatureSelectionStage(services: WorkflowServices): StageSpec {
  return {
    id: "hitl.literature_selection",
    description: "等待用户确认进入综述矩阵的文献集合（推荐集可增删）",
    requiredInputs: ["survey.search"],
    producedOutputs: ["用户决策（candidateIds）"],
    hitl: {
      prompt:
        "文献检索已完成，候选清单如下。默认入选「推荐集」（学术形态优先、按年份降序，上限 25 篇）；确认后这些文献将入库（promote）并获取全文，进入综述矩阵构建。也可在决策 payload.candidateIds 中指定增删后的集合（candidateId 列表），或取消",
      options: ["approve", "cancel"],
      payload: async (ctx) => {
        const artifact = await readResearchArtifact(services.projects, ctx.projectId);
        const chain = artifact !== null ? readPlanChain(artifact) : null;
        const plan = chain?.plans.find((candidate) => candidate.planId === chain.activePlanId);
        const pending = await services.candidates.list(ctx.projectId, "pending_review");
        const sources = await services.sources.list(ctx.projectId);
        const years = pending
          .map((candidate) => candidate.year)
          .filter((year): year is number => typeof year === "number");
        return {
          pendingCount: pending.length,
          questions: plan?.questions.slice(0, 6) ?? [],
          ...(artifact?.surveyProfile?.taxonomy !== undefined
            ? {
                taxonomyIntent: artifact.surveyProfile.taxonomy.families.map(
                  (family) => family.label,
                ),
              }
            : {}),
          yearRange:
            years.length > 0 ? { from: Math.min(...years), to: Math.max(...years) } : undefined,
          libraryEligible: sources.filter(
            (item) => item.sourceRole !== "reference" && item.status !== "rejected",
          ).length,
          recommendedCandidateIds: recommendedSurveyCandidateIds(pending),
          candidates: pending.slice(0, 40).map((candidate) => ({
            candidateId: candidate.candidateId,
            title: candidate.title ?? "(untitled)",
            ...(candidate.year !== undefined ? { year: candidate.year } : {}),
            ...(candidate.doi !== undefined ? { doi: candidate.doi } : {}),
            ...(candidate.arxivId !== undefined ? { arxivId: candidate.arxivId } : {}),
            origin: candidate.origin,
            ...(candidate.query !== undefined ? { query: candidate.query } : {}),
          })),
        };
      },
    },
  };
}

/** HITL 决策：literature_selection（approve 可携带 payload.candidateIds 增删）。
 *  M11.2：candidateIds 同时接受「已 promote（accepted）」的候选——重跑 / 续跑
 *  场景（前一 run 已批准同一集合）可以原样再次提交，promote 幂等去重；
 *  只剩 accepted 候选（pending 为空）时默认推荐集退化为既有库（不再新增）。 */
async function applyLiteratureSelectionDecision(
  services: WorkflowServices,
  state: WorkflowState,
  input: ResumeInput,
): Promise<void | "cancel"> {
  if (input.decision === "cancel") {
    return "cancel";
  }
  if (input.decision !== "approve") {
    throw new WorkflowInvalidStateError(
      state.runId,
      state.status,
      `decision 只能是 approve / cancel（当前 "${input.decision}"）`,
    );
  }
  const [pending, accepted] = await Promise.all([
    services.candidates.list(state.projectId, "pending_review"),
    services.candidates.list(state.projectId, "accepted"),
  ]);
  const byId = new Map(
    [...pending, ...accepted].map((candidate) => [candidate.candidateId, candidate]),
  );
  let selected: string[];
  const raw = input.payload?.["candidateIds"];
  if (raw === undefined) {
    selected = recommendedSurveyCandidateIds(pending);
    if (selected.length === 0 && accepted.length > 0) {
      // 续跑：无新待审候选，文献库已有 corpus——保持既有库（空选择不合法）
      selected = accepted.map((candidate) => candidate.candidateId);
    }
  } else {
    if (!Array.isArray(raw) || raw.some((id) => typeof id !== "string")) {
      throw new WorkflowInvalidStateError(
        state.runId,
        state.status,
        "payload.candidateIds 必须是 candidateId 字符串数组（缺省 = 推荐集）",
      );
    }
    const ids = [...new Set(raw as string[])];
    if (ids.length === 0) {
      throw new WorkflowInvalidStateError(
        state.runId,
        state.status,
        "payload.candidateIds 不能为空（不继续请选择 cancel）",
      );
    }
    const missing = ids.filter((id) => !byId.has(id));
    if (missing.length > 0) {
      throw new WorkflowInvalidStateError(
        state.runId,
        state.status,
        `candidateIds 含未知或非待审候选：${missing.join("、")}`,
      );
    }
    selected = ids;
  }
  if (selected.length === 0) {
    throw new WorkflowInvalidStateError(
      state.runId,
      state.status,
      "没有任何可选文献（无待审候选且文献库为空）：请先执行检索或 cancel",
    );
  }
  state.stageResults["hitl.literature_selection"] = {
    decision: "approve",
    candidateIds: selected,
    pendingAtDecision: pending.length,
  };
  return;
}

/**
 * survey.fulltext：入选候选 promote（幂等）→ 批量全文解析（partial success，
 * 降级 abstract_only / metadata_only 不终止）→ 同步等待结构化解析（Matrix 的
 * fulltext 锚定依赖 chunk 就绪）。零选择（无 pending、文献库已有 corpus）时
 * 直接对文献库执行——支持「用户在暂停期间手动 promote」的续跑。
 *
 * M11.3（Phase C）Corpus Freeze：首次完成后冻结 Research Corpus Snapshot
 * （research/corpus-snapshot.json）。此后普通 resume 本 stage 是确定性 no-op
 * ——不再重试全文解析（网络恢复不得改变已冻结研究基线；Case B 实录
 * 5/25→13/25 的隐式漂移通道就此关闭）。补齐缺失全文走显式
 * refresh_missing_fulltext（CorpusSnapshotService.refresh，新 corpus revision
 * + matrix 可升级条目失效 → staleness 链传播）。
 */
function surveyFulltextStage(services: WorkflowServices): StageSpec {
  return {
    id: "survey.fulltext",
    description: "入选文献入库（promote）+ 全文解析 + 结构化解析等待（partial success；已冻结语料 = no-op）",
    requiredInputs: ["hitl.literature_selection"],
    producedOutputs: ["sources 入库 + 全文挂载 + chunks（Matrix fulltext 锚定前提）"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs * 2,
    retryable: ["transient", "timeout"],
    async execute(ctx) {
      // 冻结语义：快照在 → 普通 resume 不碰语料（resume ≠ refresh corpus）
      const frozen = await services.corpus.get(ctx.projectId);
      if (frozen !== null) {
        return {
          frozen: true,
          corpusRevision: frozen.revision,
          corpusFingerprint: frozen.fingerprint,
          sources: frozen.counts.total,
          fulltextResolved: frozen.counts.hasFulltext,
          fulltextBasis: frozen.counts.fulltextBasis,
          fulltextSkipped: 0,
          promoted: 0,
          alreadyExists: 0,
          promoteFailed: 0,
          fulltextNotFound: frozen.counts.total - frozen.counts.hasFulltext,
          fulltextNotResolvable: 0,
          fulltextFailed: 0,
          ingested: 0,
          ingestSkipped: 0,
          ingestFailed: 0,
        };
      }
      const marker = ctx.state.stageResults["hitl.literature_selection"] ?? {};
      const candidateIds = Array.isArray(marker["candidateIds"])
        ? (marker["candidateIds"] as string[]).filter((id): id is string => typeof id === "string")
        : [];
      let promoted = 0;
      let alreadyExists = 0;
      let promoteFailed = 0;
      let sourceIds: string[] = [];
      if (candidateIds.length > 0) {
        const batch = await services.sourceImport.promoteCandidatesBatch(ctx.projectId, {
          candidateIds,
          selectionReason: "topic_survey 文献遴选（workflow HITL 批准）",
        });
        promoted = batch.summary.promoted;
        alreadyExists = batch.summary.alreadyExists;
        promoteFailed = batch.summary.failed;
        sourceIds = batch.results
          .filter((entry) => entry.source !== undefined)
          .map((entry) => entry.source!.sourceId);
      }
      if (sourceIds.length === 0) {
        // 无新入选（用户全部手动 promote / 上一 run 已完成）：对文献库全部合格条目执行
        const sources = await services.sources.list(ctx.projectId);
        sourceIds = sources
          .filter((item) => item.sourceRole !== "reference" && item.status !== "rejected")
          .map((item) => item.sourceId);
      }
      await ctx.emitProgress({ phase: "resolve-fulltext", total: sourceIds.length });
      const fulltext =
        sourceIds.length > 0
          ? await services.sourceImport.resolveFullTextBatch(ctx.projectId, sourceIds, {
              signal: ctx.signal,
            })
          : { summary: { total: 0, resolved: 0, notFound: 0, failed: 0, notResolvable: 0, skipped: 0 }, results: [] };

      // 同步等待结构化解析（docling 后台任务 dedup；失败是数据不是异常——条目
      // 保持可检索的降级 chunk 或 metadata_only，Matrix 按 interpretationDepth 降级）。
      // 已新鲜的产物直接跳过（promote 钩子 / 上一 run 可能已解析，避免重复 spawn）
      const withFile = (await services.sources.list(ctx.projectId)).filter(
        (item) =>
          sourceIds.includes(item.sourceId) &&
          item.fileName !== undefined &&
          item.status !== "metadata_only",
      );
      let ingested = 0;
      let ingestSkipped = 0;
      let ingestFailed = 0;
      for (const [index, item] of withFile.entries()) {
        if (ctx.signal.aborted) {
          throw new BusinessError("WORKFLOW_CANCELLED", "全文准备已被取消");
        }
        await ctx.emitProgress({ phase: "ingest", done: index + 1, total: withFile.length, sourceId: item.sourceId });
        try {
          if ((await services.ingestion.getDocument(ctx.projectId, item.sourceId)) !== null) {
            ingestSkipped += 1;
            continue;
          }
          await services.ingestion.ingest(ctx.projectId, item.sourceId);
          ingested += 1;
        } catch {
          ingestFailed += 1;
        }
      }
      // M11.3：首次完成 → 冻结研究语料（幂等；basisDepth 待 matrix 构建后 sync）
      const frozenNow = await services.corpus.freeze(ctx.projectId, {
        matrix: await services.survey.getMatrix(ctx.projectId).catch(() => null),
      });
      return {
        selected: candidateIds.length,
        promoted,
        alreadyExists,
        promoteFailed,
        frozen: true,
        corpusRevision: frozenNow.revision,
        corpusFingerprint: frozenNow.fingerprint,
        sources: sourceIds.length,
        fulltextResolved: fulltext.summary.resolved,
        fulltextNotFound: fulltext.summary.notFound,
        fulltextNotResolvable: fulltext.summary.notResolvable,
        fulltextFailed: fulltext.summary.failed,
        fulltextSkipped: fulltext.summary.skipped,
        ingested,
        ingestSkipped,
        ingestFailed,
      };
    },
  };
}

/** survey.matrix：直接调用 MatrixService（taxonomy 意图来自 surveyProfile，非法回退缺省词表） */
function surveyMatrixStage(services: WorkflowServices): StageSpec {
  return {
    id: "survey.matrix",
    description: "Survey Matrix 构建：Literature → per-paper 结构化理解（复用 MatrixService 幂等语义）",
    requiredInputs: ["survey.fulltext"],
    producedOutputs: ["research/survey.json"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs * 4,
    retryable: ["transient", "timeout", "runtime_unavailable", "contract_violation"],
    async execute(ctx) {
      const artifact = await requireResearchArtifact(services, ctx.projectId);
      let taxonomy: SurveyTaxonomy | undefined;
      if (artifact.surveyProfile?.taxonomy !== undefined) {
        try {
          taxonomy = normalizeTaxonomy(artifact.surveyProfile.taxonomy);
        } catch {
          taxonomy = undefined; // 意图词表非法 → 服务内缺省词表（fail-open 只对词表，不伪造条目）
        }
      }
      const build = await services.survey.buildMatrix(ctx.projectId, {
        ...(taxonomy !== undefined ? { taxonomy } : {}),
        onProgress: (info) => {
          void ctx.emitProgress({
            phase: "matrix",
            done: info.done + 1,
            total: info.total,
            sourceId: info.sourceId,
          });
        },
      });
      const matrix = build.matrix;
      // M11.3（Phase C）：语料基线深度对齐（refresh 后重建的条目把快照的
      // basisDepth 升到 fulltext——指纹变化，revision 不动）
      await services.corpus.syncBasisDepth(ctx.projectId, matrix).catch(() => {});
      const byFamily = new Map<string, number>();
      let unclassified = 0;
      for (const entry of matrix.entries) {
        if (entry.methodFamily === undefined || entry.methodFamily === UNCLASSIFIED_FAMILY) {
          unclassified += 1;
        } else {
          byFamily.set(entry.methodFamily, (byFamily.get(entry.methodFamily) ?? 0) + 1);
        }
      }
      return {
        entries: matrix.entries.length,
        built: build.summary.built,
        skippedExisting: build.summary.skippedExisting,
        failed: build.summary.failed,
        fulltext: matrix.entries.filter((entry) => entry.interpretationDepth === "fulltext").length,
        abstractOnly: matrix.entries.filter((entry) => entry.interpretationDepth === "abstract_only")
          .length,
        unclassified,
        entriesWithIssues: matrix.entries.filter((entry) => (entry.issues ?? []).length > 0).length,
        ...(taxonomy !== undefined ? { taxonomyApplied: taxonomy.families.length } : {}),
      };
    },
    async verifyDod(ctx) {
      const matrix = await services.survey.getMatrix(ctx.projectId);
      return matrix === null || matrix.entries.length === 0
        ? ["research/survey.json 不存在或为空（0 条文献）"]
        : [];
    },
  };
}

/** hitl.matrix_confirm：进入 Synthesis 前的矩阵修正点（重点暴露 unclassified / 弱锚 / 降级条目） */
function matrixConfirmStage(services: WorkflowServices): StageSpec {
  return {
    id: "hitl.matrix_confirm",
    description: "等待用户确认综述矩阵（可修正 taxonomy / 归类 / 状态）",
    requiredInputs: ["survey.matrix"],
    producedOutputs: ["用户决策（approve / revise entryPatches）"],
    hitl: {
      prompt:
        "综述矩阵已生成（每篇文献的结构化理解）。下方重点列出需要人工关注的条目（未归类 / 弱锚定 / 仅摘要）。确认后进入跨论文综合；需要修正时在决策 payload.entryPatches 中给出条目修正（entryId + 要改的字段，字段校验与「矩阵」页编辑一致），修正会触发综合重建",
      options: ["approve", "revise", "cancel"],
      payload: async (ctx) => {
        const matrix = await services.survey.getMatrix(ctx.projectId);
        if (matrix === null) {
          return undefined;
        }
        const unclassified = matrix.entries.filter(
          (entry) => entry.methodFamily === undefined || entry.methodFamily === UNCLASSIFIED_FAMILY,
        );
        const weakAnchors = matrix.entries.filter(
          (entry) =>
            entry.interpretationDepth === "fulltext" &&
            (entry.anchors.length === 0 ||
              (entry.issues ?? []).some(
                (issue) => issue.code === "no_valid_anchors" || issue.code === "no_retrievable_chunks",
              )),
        );
        const byFamily = new Map<string, number>();
        for (const entry of matrix.entries) {
          if (entry.methodFamily !== undefined && entry.methodFamily !== UNCLASSIFIED_FAMILY) {
            byFamily.set(entry.methodFamily, (byFamily.get(entry.methodFamily) ?? 0) + 1);
          }
        }
        return {
          entries: matrix.entries.length,
          fulltext: matrix.entries.filter((entry) => entry.interpretationDepth === "fulltext").length,
          abstractOnly: matrix.entries.filter((entry) => entry.interpretationDepth === "abstract_only")
            .length,
          taxonomy: matrix.taxonomy.families.map(
            (family) => `${family.label}=${byFamily.get(family.label) ?? 0}`,
          ),
          attention: {
            unclassified: unclassified.map((entry) => ({
              entryId: entry.entryId,
              sourceId: entry.sourceId,
              proposed:
                entry.issues?.find((issue) => issue.code === "method_family_not_in_taxonomy")
                  ?.proposed ?? undefined,
            })),
            weakAnchors: weakAnchors.map((entry) => entry.entryId),
          },
          entriesWithIssues: matrix.entries.filter((entry) => (entry.issues ?? []).length > 0).length,
        };
      },
    },
  };
}

/** HITL 决策：matrix_confirm（revise = entryPatches 经服务严格校验后落盘） */
async function applyMatrixConfirmDecision(
  services: WorkflowServices,
  state: WorkflowState,
  input: ResumeInput,
): Promise<void | "cancel"> {
  if (input.decision === "cancel") {
    return "cancel";
  }
  if (input.decision === "approve") {
    // 最简语义：workflow 级批准。entry.status 不强制逐条 confirmed（构建产物
    // 默认 draft；PUT 编辑自然管理状态），Synthesis 不消费 entry.status
    state.stageResults["hitl.matrix_confirm"] = { decision: "approve" };
    return;
  }
  if (input.decision === "revise") {
    const raw = input.payload?.["entryPatches"];
    if (!Array.isArray(raw) || raw.length === 0) {
      throw new WorkflowInvalidStateError(
        state.runId,
        state.status,
        "revise 需要携带非空 payload.entryPatches（[{entryId, methodFamily?, subFamily?, status?, …}]；只提意见不改条目请 approve）",
      );
    }
    const patches: Array<{ entryId: string; patch: SurveyEntryPatch }> = [];
    for (const entry of raw) {
      if (typeof entry !== "object" || entry === null || typeof (entry as Record<string, unknown>)["entryId"] !== "string") {
        throw new WorkflowInvalidStateError(
          state.runId,
          state.status,
          "entryPatches[].entryId 必须是非空字符串",
        );
      }
      const { entryId, ...rest } = entry as { entryId: string } & SurveyEntryPatch;
      if (Object.keys(rest).length === 0) {
        throw new WorkflowInvalidStateError(
          state.runId,
          state.status,
          `entryPatches 中 ${entryId} 没有要修改的字段`,
        );
      }
      patches.push({ entryId, patch: rest });
    }
    // 逐条走服务写入口（严格 fail-closed：非法标签 / 越界字段直接抛错回给用户）
    const applied: string[] = [];
    for (const { entryId, patch } of patches) {
      const updated = await services.survey.updateEntry(state.projectId, entryId, patch);
      applied.push(updated.entryId);
    }
    state.stageResults["hitl.matrix_confirm"] = {
      decision: "revise",
      patched: applied.length,
      patchedEntries: applied,
    };
    return;
  }
  throw new WorkflowInvalidStateError(
    state.runId,
    state.status,
    `decision 只能是 approve / revise / cancel（当前 "${input.decision}"）`,
  );
}

/** survey.synthesis：直接调用 SynthesisService（Matrix 指纹复用 / 全量重建） */
function surveySynthesisStage(services: WorkflowServices): StageSpec {
  return {
    id: "survey.synthesis",
    description: "Structured Synthesis 构建：七类跨论文综合（grounding 规则零旁路）",
    requiredInputs: ["hitl.matrix_confirm"],
    producedOutputs: ["research/survey-synthesis.json"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs * 4,
    retryable: ["transient", "timeout", "runtime_unavailable", "contract_violation"],
    async execute(ctx) {
      const build = await services.synthesis.buildSynthesis(ctx.projectId, {
        onProgress: (info) => {
          void ctx.emitProgress({
            phase: "synthesis",
            done: info.done + 1,
            total: info.total,
            kind: info.kind,
          });
        },
      });
      return {
        synthesisItems: build.synthesis.items.length,
        reused: build.summary.reused,
        batches: build.summary.batches,
        byKind: build.summary.byKind,
        evidenceProposed: build.summary.evidenceProposed,
        evidenceVerified: build.summary.evidenceVerified,
        rejected: build.summary.rejected,
      };
    },
    async verifyDod(ctx) {
      const synthesis = await services.synthesis.getSynthesis(ctx.projectId);
      return synthesis === null ? ["research/survey-synthesis.json 不存在"] : [];
    },
  };
}

/** survey.outline：直接调用 SurveyOutlineService（validate blocking fail-closed 在服务内）。
 *  M11.2：无 feedback 且已落盘 outline 对当前 Matrix/Synthesis 新鲜（指纹一致 +
 *  契约无 blocking）时确定性复用——重跑 / 续跑不重烧规划 Token。 */
function surveyOutlineStage(services: WorkflowServices): StageSpec {
  return {
    id: "survey.outline",
    description: "Survey Outline 规划：Synthesis → 综述大纲（契约校验 + feedback 重规划；新鲜可复用）",
    requiredInputs: ["survey.synthesis"],
    producedOutputs: ["manuscript/outline.json（synthesisRefs / literatureRefs）"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs * 2,
    retryable: ["transient", "timeout", "runtime_unavailable", "contract_violation"],
    async execute(ctx) {
      const feedback = readFeedback(ctx.state.inputs["hitl.outline_confirm"]?.payload);
      if (feedback === undefined) {
        const reused = await services.surveyOutline.reuseFreshOutline(ctx.projectId);
        if (reused !== null) {
          return {
            title: reused.title,
            sections: reused.sections.length,
            reused: true,
          };
        }
      }
      const build = await services.surveyOutline.buildSurveyOutline(ctx.projectId, {
        ...(feedback !== undefined ? { feedback } : {}),
      });
      return {
        title: build.outline.title,
        sections: build.outline.sections.length,
        planningAttempts: build.summary.planningAttempts,
        matrixEntries: build.summary.matrixEntries,
        synthesisItems: build.summary.synthesisItems,
        synthesisCoverage: build.validation.summary.synthesisCoverage,
        literatureCoverage: build.validation.summary.literatureCoverage,
        warnings: build.validation.warnings.length,
        ...(build.summary.repair !== undefined ? { repair: build.summary.repair.attempts } : {}),
      };
    },
    async verifyDod(ctx) {
      const outline = await services.manuscript.loadOutline(ctx.projectId);
      return outline === null ? ["manuscript/outline.json 不存在"] : [];
    },
  };
}

/** hitl.outline_confirm（survey 变体：前置是 survey.outline；payload 与 idea 流程共用） */
function surveyOutlineConfirmStage(services: WorkflowServices): StageSpec {
  return {
    id: "hitl.outline_confirm",
    description: "等待用户确认综述大纲（refs 契约可见）",
    requiredInputs: ["survey.outline"],
    producedOutputs: ["用户决策"],
    hitl: {
      prompt: "综述大纲已生成（按方法体系 / 综合结果组织；各节携带 synthesis / literature 引用）。确认后将进入综述正文写作（分节写作 → 引用核验 → 审稿 → Quality Gate → 修订 → PDF）；也可以带反馈重新规划，或取消",
      options: ["approve", "revise", "cancel"],
      payload: (ctx) => outlineConfirmPayload(services, ctx),
    },
  };
}

/** HITL 决策：outline_confirm（survey 变体：revise 重跑 survey.outline，refs 链不丢） */
async function applySurveyOutlineDecision(
  state: WorkflowState,
  input: ResumeInput,
): Promise<void | "cancel"> {
  if (input.decision === "approve") {
    state.stageResults["hitl.outline_confirm"] = { decision: "approve" };
    return;
  }
  if (input.decision === "cancel") {
    return "cancel";
  }
  if (input.decision === "revise") {
    if (readFeedback(input.payload) === undefined) {
      throw new WorkflowInvalidStateError(
        state.runId,
        state.status,
        "revise 需要携带非空 payload.feedback",
      );
    }
    if (countCompletions(state, "survey.outline") >= MAX_OUTLINE_REVISIONS) {
      throw new WorkflowInvalidStateError(
        state.runId,
        state.status,
        `大纲修订次数已达上限（${MAX_OUTLINE_REVISIONS} 次），请 approve 或 cancel`,
      );
    }
    dropStageResult(state, "survey.outline");
    return;
  }
  throw new WorkflowInvalidStateError(
    state.runId,
    state.status,
    `decision 只能是 approve / revise / cancel（当前 "${input.decision}"）`,
  );
}

// ============================================================
// M11.2：Survey 写作链（Writing → Review → Revision → Gate → PDF）
// —— 复用 idea_to_paper 的共享后段（planSharedTail + 全部 tail stage 工厂），
//    本节只补 survey 语义：写作上下文 / review profile / gate 规则 / 修订约束
// ============================================================

/** survey 写作链共享输入：outline + matrix + synthesis（新鲜性校验）+ bibliography + formal evidence */
async function loadSurveyWritingInputs(
  services: WorkflowServices,
  projectId: string,
): Promise<{
  outline: NonNullable<Awaited<ReturnType<ManuscriptService["loadOutline"]>>>;
  matrix: NonNullable<Awaited<ReturnType<SurveyMatrixArtifactStore["read"]>>>;
  synthesis: NonNullable<Awaited<ReturnType<SurveySynthesisArtifactStore["read"]>>>;
  evidence: EvidenceRecord[];
  bibliography: CanonicalBibliographyEntry[];
  yearBySource: Map<string, number>;
  titleBySource: Map<string, string>;
  files: { file: string; content: string }[];
}> {
  const outline = await services.manuscript.loadOutline(projectId);
  if (outline === null) {
    throw new BusinessError("STAGE_CONTRACT_VIOLATION", "缺少综述大纲（manuscript/outline.json 不存在）");
  }
  const matrix = await new SurveyMatrixArtifactStore(services.projects).read(projectId);
  if (matrix === null) {
    throw new BusinessError("STAGE_CONTRACT_VIOLATION", "缺少 Survey Matrix（research/survey.json）");
  }
  const synthesis = await new SurveySynthesisArtifactStore(services.projects).read(projectId);
  if (synthesis === null) {
    throw new BusinessError("STAGE_CONTRACT_VIOLATION", "缺少 Structured Synthesis（research/survey-synthesis.json）");
  }
  if (synthesis.matrixFingerprint !== fingerprintJson(matrix)) {
    throw new BusinessError(
      "STAGE_CONTRACT_VIOLATION",
      "Survey Synthesis 相对当前 Matrix 已过期（指纹不一致）：请先重跑 survey.synthesis / survey.outline 再进入写作",
    );
  }
  const sourceItems = await services.sources.list(projectId);
  const yearBySource = new Map(
    sourceItems
      .filter((item) => item.metadata.year !== undefined)
      .map((item) => [item.sourceId, item.metadata.year as number]),
  );
  const titleBySource = new Map(
    sourceItems
      .filter((item) => item.metadata.title !== undefined && item.metadata.title.trim() !== "")
      .map((item) => [item.sourceId, item.metadata.title!.trim()]),
  );
  const evidence = (await services.evidence.list(projectId)).filter(isFormalEvidence);
  const bibliography = await buildCanonicalBibliography(services, projectId);
  const files = await collectLatexFiles(services.projects.manuscriptDir(projectId));
  return {
    outline,
    matrix,
    synthesis,
    evidence,
    bibliography,
    yearBySource,
    titleBySource,
    files: files.allTex.map((file) => ({ file: file.relativePath, content: file.content })),
  };
}

/** 当前稿件的 Survey Writing 评估（review / gate 共用；survey 项目在写作后必有产物） */
/** M11.3 起导出：Reviewer Stability 审计复用同轮 survey digest 条件。 */
export async function evaluateSurveyWritingForProject(
  services: WorkflowServices,
  projectId: string,
): Promise<SurveyWritingEvaluation> {
  const inputs = await loadSurveyWritingInputs(services, projectId);
  return evaluateSurveyWriting({
    outline: inputs.outline,
    matrix: inputs.matrix,
    synthesis: inputs.synthesis,
    bibliography: inputs.bibliography,
    evidence: inputs.evidence,
    files: inputs.files,
    titleBySource: inputs.titleBySource,
    yearBySource: inputs.yearBySource,
  });
}

/**
 * survey 写作 stage（id 与普通论文一致 = writing.sections）：逐节构建
 * SurveySectionContext（refs 契约的有界投影）→ Writer survey 模式 →
 * 确定性引用后检（writeSection 内）→ 落盘 / main.tex / bib 同步 / 修订提交。
 */
/**
 * M11.2.1：大纲结构指纹（幂等跳过判定用）。只取 sections 的结构性字段
 * （id / file / title / refs / keyPoints）——abstract 由修订流程写回
 * outline.abstract，不参与「大纲是否变化」的判定；targetLengthWords 属于
 * 意图参数，写作已完成后不构成重写依据。
 */
function surveyOutlineFingerprint(outline: {
  sections: Array<{
    id: string;
    file: string;
    title: string;
    synthesisRefs?: string[];
    literatureRefs?: string[];
    keyPoints?: string[];
  }>;
}): string {
  return createHash("sha256")
    .update(
      JSON.stringify(
        outline.sections.map((section) => [
          section.id,
          section.file,
          section.title,
          [...(section.synthesisRefs ?? [])].sort(),
          [...(section.literatureRefs ?? [])].sort(),
          section.keyPoints ?? [],
        ]),
      ),
    )
    .digest("hex")
    .slice(0, 16);
}

/**
 * M11.2.1：survey 写作幂等跳过（真实项目续跑语义）。满足以下全部条件时
 * 跳过逐节重写、不产生新修订：
 * - 已存在任一 writing.sections 修订（此前完成过写作）；
 * - 该修订快照中的 outline.json 结构指纹与当前 outline 一致（大纲未被
 *   重新确认改变——变了则如实重写）；
 * - 当前全部章节文件存在且非空（修订可能改写过它们，正是要保留的稿面）。
 * 收益：M11.2 真实项目恢复运行时不再整篇重写（重写会制造 rev-N→rev-N+1 的
 * 全量 pairwise 假漂移，正是振荡源头之一）；成本集中在 review / revision。
 */
async function surveyWritingSkippable(
  services: WorkflowServices,
  projectId: string,
  outline: import("../manuscript/ManuscriptService.js").Outline | null,
): Promise<{ skip: boolean; revision?: number }> {
  if (outline === null || outline.sections.length === 0) {
    return { skip: false };
  }
  const statuses = await services.manuscript.sectionStatuses(projectId);
  const allWritten = outline.sections.every((section) => {
    const status = statuses.find((candidate) => candidate.id === section.id);
    return status?.exists === true && status.nonEmpty === true;
  });
  if (!allWritten) {
    return { skip: false };
  }
  const state = await services.revisions.load(projectId);
  const writingRevision = [...state.revisions]
    .filter((record) => record.reason === "writing.sections")
    .sort((a, b) => b.revision - a.revision)[0];
  if (writingRevision === undefined) {
    return { skip: false };
  }
  try {
    const raw = await readFile(
      join(services.revisions.snapshotDir(projectId, writingRevision.revision), "outline.json"),
      "utf8",
    );
    const snapshotOutline = JSON.parse(raw) as import("../manuscript/ManuscriptService.js").Outline;
    if (surveyOutlineFingerprint(snapshotOutline) !== surveyOutlineFingerprint(outline)) {
      return { skip: false };
    }
  } catch {
    return { skip: false }; // 快照不可读：如实重写（不猜测）
  }
  return { skip: true, revision: writingRevision.revision };
}

function surveyWritingSectionsStage(services: WorkflowServices): StageSpec {
  return {
    id: "writing.sections",
    description: "Survey Writer 逐节写作（synthesis 驱动；每节有界上下文 + 引用白名单后检）",
    requiredInputs: ["hitl.outline_confirm"],
    producedOutputs: ["manuscript/sections/*.tex", "manuscript/main.tex"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs * 4,
    retryable: ["transient", "timeout", "runtime_unavailable", "contract_violation"],
    async execute(ctx) {
      const inputs = await loadSurveyWritingInputs(services, ctx.projectId);
      // M11.2.1：幂等跳过（大纲结构未变 + 章节齐全 → 保留既有稿面，不重写）
      const skip = await surveyWritingSkippable(services, ctx.projectId, inputs.outline);
      if (skip.skip) {
        await ctx.emitProgress({ reusedRevision: skip.revision ?? 0 });
        return {
          sectionsWritten: inputs.outline.sections.length,
          sections: inputs.outline.sections.map((section) => section.id),
          bytesTotal: 0,
          reusedFromRevision: skip.revision ?? null,
          synthesisItems: inputs.synthesis.items.length,
          matrixEntries: inputs.matrix.entries.length,
          bibliographyEntries: inputs.bibliography.length,
          evidenceFormal: inputs.evidence.length,
        };
      }
      const project = await services.projects.getRequired(ctx.projectId);
      const language = normalizeManuscriptLanguage(project.language);
      const usedEvidenceIds = new Set<string>();
      let bytesTotal = 0;
      const written: string[] = [];
      for (const [index, section] of inputs.outline.sections.entries()) {
        if (ctx.signal.aborted) {
          throw new BusinessError("WORKFLOW_CANCELLED", "写作已被取消");
        }
        const context = buildSurveySectionContext({
          section,
          matrix: inputs.matrix,
          synthesis: inputs.synthesis,
          bibliography: inputs.bibliography,
          evidence: inputs.evidence,
          titleBySource: inputs.titleBySource,
          yearBySource: inputs.yearBySource,
        });
        if (context.danglingSynthesisRefs.length > 0 || context.danglingLiteratureRefs.length > 0) {
          throw new BusinessError(
            "STAGE_CONTRACT_VIOLATION",
            `section ${section.id} 悬空 refs（synthesis：${context.danglingSynthesisRefs.join("、") || "无"}；literature：${context.danglingLiteratureRefs.join("、") || "无"}）——大纲与综合产物不一致，请重跑 survey.outline`,
          );
        }
        const result = await services.writer.writeSection({
          projectId: ctx.projectId,
          section,
          outline: inputs.outline,
          evidence: context.evidence,
          bibliography: inputs.bibliography,
          ...(language !== undefined ? { language } : {}),
          survey: context,
        });
        bytesTotal += await services.manuscript.writeSection(ctx.projectId, section, result.latex);
        written.push(section.id);
        for (const record of context.evidence) {
          usedEvidenceIds.add(record.id);
        }
        await ctx.emitProgress({
          section: section.id,
          file: section.file,
          index: index + 1,
          total: inputs.outline.sections.length,
        });
      }
      for (const evidenceId of usedEvidenceIds) {
        await safeMarkUsage(services, ctx.projectId, evidenceId, ctx.runId);
      }
      await services.manuscript.writeMainTex(ctx.projectId, inputs.outline, inputs.bibliography.length > 0);
      await services.manuscript.rebuildContext(ctx.projectId, {
        evidenceStats: await services.evidence.stats(ctx.projectId),
      });
      await syncReferencesBib(services, ctx.projectId);
      const revision = await services.revisions.commit(ctx.projectId, "writing.sections", ctx.runId);
      return {
        sectionsWritten: written.length,
        sections: written,
        bytesTotal,
        revision: revision.revision,
        synthesisItems: inputs.synthesis.items.length,
        matrixEntries: inputs.matrix.entries.length,
        bibliographyEntries: inputs.bibliography.length,
        evidenceFormal: inputs.evidence.length,
      };
    },
    async verifyDod(ctx) {
      const violations: string[] = [];
      const outline = await services.manuscript.loadOutline(ctx.projectId);
      if (outline === null) {
        return ["manuscript/outline.json 不存在"];
      }
      const statuses = await services.manuscript.sectionStatuses(ctx.projectId);
      for (const section of outline.sections) {
        const status = statuses.find((candidate) => candidate.id === section.id);
        if (!status?.exists) {
          violations.push(`sections/${section.file} 不存在`);
        } else if (!status.nonEmpty) {
          violations.push(`sections/${section.file} 内容为空`);
        }
      }
      return violations;
    },
  };
}

export function createTopicSurveyDefinition(services: WorkflowServices): WorkflowDefinition {
  const stages: readonly StageSpec[] = [
    surveyPlanStage(services),
    researchPlanConfirmStage(services, { survey: true }),
    surveySearchStage(services),
    literatureSelectionStage(services),
    surveyFulltextStage(services),
    surveyMatrixStage(services),
    matrixConfirmStage(services),
    surveySynthesisStage(services),
    surveyOutlineStage(services),
    surveyOutlineConfirmStage(services),
    // M11.2 写作链：复用 idea_to_paper 的共享后段 stage 工厂（citation / review /
    // gate / revision / build 全部同 id 同语义；survey 语义在 stage 工厂 option 内）
    surveyWritingSectionsStage(services),
    citationVerifyStage(services),
    reviewRunStageInner(services, { survey: true }),
    qualityGateStage(services, { survey: true }),
    revisionPlanStage(services),
    evidenceGroundClaimsStage(services),
    revisionRestoreFactsStage(services),
    revisionReviseStage(services, "revision.revise"),
    revisionValidateStage(services),
    revisionValidationDecisionStage(services),
    revisionRepairStage(services),
    revisionOverflowStage(),
    revisionStalledStage(services),
    stylePolishDecisionStage(services),
    stylePolishStage(services),
    buildDraftStage(services),
    buildFinalStage(services),
  ];

  const front = [
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

  return {
    kind: "topic_survey",
    description:
      "Topic-to-Survey：综述研究规划 → 确认 → 检索 → 文献遴选 → 全文准备 → Survey Matrix → 矩阵确认 → Structured Synthesis → Survey Outline → 大纲确认 → Survey 写作 → 引用核验 → 审稿（survey rubric）→ Quality Gate → bounded 修订 → 构建（Draft / Final PDF）",
    stages,
    plan(state: WorkflowState): PlanDecision {
      for (const stageId of front) {
        if (!(stageId in state.stageResults)) {
          return { kind: "stage", stageId };
        }
      }
      if (!("writing.sections" in state.stageResults)) {
        return { kind: "stage", stageId: "writing.sections" };
      }
      return planSharedTail(state, services);
    },
    async onInput(state, stageId, input): Promise<void | "cancel"> {
      switch (stageId) {
        case "hitl.research_plan":
          return applyResearchPlanDecision(services, state, input);
        case "hitl.literature_selection":
          return applyLiteratureSelectionDecision(services, state, input);
        case "hitl.matrix_confirm":
          return applyMatrixConfirmDecision(services, state, input);
        case "hitl.outline_confirm":
          return applySurveyOutlineDecision(state, input);
        case "hitl.revision_overflow":
          return applyOverflowDecision(state, input);
        case "hitl.revision_stalled":
          return applyStalledDecision(state, input);
        case "hitl.revision_validation":
          return applyRevisionValidationDecision(services, state, input);
        case "hitl.style_polish":
          return applyStylePolishDecision(state, input);
        default:
          throw new WorkflowInvalidStateError(state.runId, state.status, `未知的待办节点 ${stageId}`);
      }
    },
  };
}

// ============================================================
// HITL 决策
// ============================================================

async function applyFeasibilityDecision(
  services: WorkflowServices,
  state: WorkflowState,
  input: ResumeInput,
): Promise<void | "cancel"> {
  if (input.decision === "approve") {
    state.stageResults["hitl.feasibility_confirm"] = { decision: "approve" };
    return;
  }
  if (input.decision === "cancel") {
    return "cancel";
  }
  if (input.decision === "adjust") {
    const payload = input.payload ?? {};
    const targetProfile = readPayloadString(payload, "targetProfile");
    const targetVenue = readPayloadString(payload, "targetVenue");
    if (targetProfile === undefined && targetVenue === undefined) {
      throw new WorkflowInvalidStateError(
        state.runId,
        state.status,
        "adjust 需要携带 targetProfile 或 targetVenue",
      );
    }
    const assessments = countCompletions(state, "research.feasibility");
    if (assessments >= MAX_FEASIBILITY_ADJUSTMENTS) {
      throw new WorkflowInvalidStateError(
        state.runId,
        state.status,
        `目标调整次数已达上限（${MAX_FEASIBILITY_ADJUSTMENTS} 次），请 approve 或 cancel`,
      );
    }
    await services.projects.updateMeta(state.projectId, {
      ...(targetProfile !== undefined ? { targetProfile } : {}),
      ...(targetVenue !== undefined ? { targetVenue } : {}),
    });
    dropStageResult(state, "research.feasibility");
    return;
  }
  throw new WorkflowInvalidStateError(
    state.runId,
    state.status,
    `decision 只能是 approve / adjust / cancel（当前 "${input.decision}"）`,
  );
}

/** M9.7.4 evidence-supply 决策：continue = 以当前证据继续写作；cancel = 终止 run */
async function applyEvidenceSupplyDecision(state: WorkflowState, input: ResumeInput): Promise<void | "cancel"> {
  if (input.decision === "continue") {
    const research = state.stageResults["research.idea"] ?? {};
    state.stageResults["hitl.evidence_supply"] = {
      decision: "continue",
      pendingCandidatesAtDecision:
        typeof research["candidatePending"] === "number" ? research["candidatePending"] : 0,
    };
    return;
  }
  if (input.decision === "cancel") {
    return "cancel";
  }
  throw new WorkflowInvalidStateError(
    state.runId,
    state.status,
    `decision 只能是 continue / cancel（当前 "${input.decision}"）`,
  );
}

async function applyOutlineDecision(state: WorkflowState, input: ResumeInput): Promise<void | "cancel"> {
  if (input.decision === "approve") {
    state.stageResults["hitl.outline_confirm"] = { decision: "approve" };
    return;
  }
  if (input.decision === "cancel") {
    return "cancel";
  }
  if (input.decision === "revise") {
    const feedback = readFeedback(input.payload);
    if (feedback === undefined) {
      throw new WorkflowInvalidStateError(
        state.runId,
        state.status,
        "revise 需要携带非空 payload.feedback",
      );
    }
    if (countCompletions(state, "outline.plan") >= MAX_OUTLINE_REVISIONS) {
      throw new WorkflowInvalidStateError(
        state.runId,
        state.status,
        `大纲修订次数已达上限（${MAX_OUTLINE_REVISIONS} 次），请 approve 或 cancel`,
      );
    }
    dropStageResult(state, "outline.plan");
    return;
  }
  throw new WorkflowInvalidStateError(
    state.runId,
    state.status,
    `decision 只能是 approve / revise / cancel（当前 "${input.decision}"）`,
  );
}

async function applyPlanDecision(state: WorkflowState, input: ResumeInput): Promise<void | "cancel"> {
  if (input.decision === "approve") {
    state.stageResults["hitl.plan_confirm"] = { decision: "approve" };
    return;
  }
  if (input.decision === "cancel") {
    return "cancel";
  }
  if (input.decision === "revise") {
    if (readFeedback(input.payload) === undefined) {
      throw new WorkflowInvalidStateError(
        state.runId,
        state.status,
        "revise 需要携带非空 payload.feedback",
      );
    }
    if (countCompletions(state, "plan.improvement") >= MAX_PLAN_REVISIONS) {
      throw new WorkflowInvalidStateError(
        state.runId,
        state.status,
        `改进计划修订次数已达上限（${MAX_PLAN_REVISIONS} 次），请 approve 或 cancel`,
      );
    }
    dropStageResult(state, "plan.improvement");
    return;
  }
  throw new WorkflowInvalidStateError(
    state.runId,
    state.status,
    `decision 只能是 approve / revise / cancel（当前 "${input.decision}"）`,
  );
}

// ============================================================
// 辅助
// ============================================================

async function requireResearchArtifact(
  services: WorkflowServices,
  projectId: string,
): Promise<ResearchArtifact> {
  const artifact = await readResearchArtifact(services.projects, projectId);
  if (artifact === null) {
    throw new BusinessError("STAGE_CONTRACT_VIOLATION", "缺少 research/research.json（先执行调研）");
  }
  return artifact;
}

async function readImportReport(
  services: WorkflowServices,
  projectId: string,
): Promise<{
  structure: { entryFile: string; texFiles: string[]; bibFile: string | null };
  baselineCompile: { attempted: boolean; ok: boolean; error?: string };
} | null> {
  try {
    return JSON.parse(
      await readFile(
        join(services.projects.projectDir(projectId), "workflow", "import-report.json"),
        "utf8",
      ),
    );
  } catch {
    return null;
  }
}

/**
 * M10.3 §6：原稿事实基线 digest（improvement plan 输入 A）。
 * 只给结构化要点（表格标签 + 关键数值样例 + 引用 key 数），不给全文——
 * 计划需要知道「冻结了什么」而不是重读论文。
 */
async function readBaselineDigest(
  services: WorkflowServices,
  projectId: string,
): Promise<string | undefined> {
  try {
    const baseline = JSON.parse(
      await readFile(join(services.projects.researchDir(projectId), "revision-baseline.json"), "utf8"),
    ) as {
      tables?: { label: string | null; caption: string; rowCount: number }[];
      citationKeys?: string[];
      hardware?: string[];
      placeholders?: number;
    };
    const tables = (baseline.tables ?? []).slice(0, 12);
    const parts = [
      tables.length > 0
        ? `表格（${tables.length} 个）：${tables
            .map((table) => `${table.label ?? table.caption.slice(0, 24)}(${table.rowCount}行)`)
            .join("、")}`
        : undefined,
      `引用 key ${baseline.citationKeys?.length ?? 0} 个`,
      baseline.hardware !== undefined && baseline.hardware.length > 0
        ? `硬件：${baseline.hardware.join("、")}`
        : undefined,
      baseline.placeholders !== undefined && baseline.placeholders > 0
        ? `⚠ 基线含 ${baseline.placeholders} 处占位表述（待确认事实）`
        : undefined,
    ].filter((part): part is string => part !== undefined);
    return parts.length > 0 ? `原稿冻结基线：${parts.join("；")}` : undefined;
  } catch {
    return undefined;
  }
}

/**
 * M10.3 §8：证据分层 digest（improvement plan 输入 B/E）。
 * 两种 Evidence 用途严格区分：verified（grounded）= 外部文献证据，可支撑
 * related work / 外部事实论述；user_confirmed = 作者自身实验事实，只授权
 * 修改作者自己的实验数值，绝不等于「外部科学事实已验证」。
 */
async function buildEvidenceDigest(
  services: WorkflowServices,
  projectId: string,
): Promise<string | undefined> {
  const records = await services.evidence.list(projectId);
  const verified = records.filter((record) => record.verificationStatus === "verified");
  const userConfirmed = records.filter(
    (record) => record.verificationLevel === "user_confirmed" && record.verificationStatus !== "mismatch",
  );
  if (verified.length === 0 && userConfirmed.length === 0) {
    return undefined;
  }
  const parts: string[] = [];
  if (verified.length > 0) {
    parts.push(
      `【已核验外部文献证据（verified，可用于外部事实论述与引用）${verified.length} 条】`,
      ...verified.slice(0, 10).map(
        (record) =>
          `- [${record.id}] ${record.claim.slice(0, 160)}${record.quote !== undefined ? `（引文："${record.quote.slice(0, 100)}"）` : ""}`,
      ),
    );
  }
  if (userConfirmed.length > 0) {
    parts.push(
      `【作者实验证据（user_confirmed：只授权修改作者自身实验事实，不是外部科学事实验证）${userConfirmed.length} 条】`,
      ...userConfirmed.slice(0, 15).map((record) => {
        const location = record.location ?? {};
        const origin =
          location.path !== undefined
            ? `path=${location.path}`
            : location.sheet !== undefined
              ? `sheet=${location.sheet} row=${location.row ?? "?"} col=${location.column ?? "?"}`
              : location.figureBlockId !== undefined
                ? `figure=${location.figureBlockId}`
                : "（无结构化定位）";
        return `- [${record.id}] ${record.claim.slice(0, 160)}（${origin}）`;
      }),
    );
  }
  return parts.join("\n");
}

/** M10.3：requirement coverage digest（计划输入：文献需求覆盖现状） */
async function buildCoverageDigest(
  services: WorkflowServices,
  projectId: string,
): Promise<string | undefined> {
  try {
    const coverage = await services.coverage.get(projectId);
    if (coverage === null || coverage.requirementCoverage.length === 0) {
      return undefined;
    }
    const lines = coverage.requirementCoverage
      .slice(0, 12)
      .map(
        (entry) =>
          `- [${entry.requirementId}][${entry.coverage}] ${entry.topic}（证据 ${entry.evidenceCount} / 已入库文献 ${entry.promotedCount}${entry.missingReason !== undefined ? `；缺口：${entry.missingReason}` : ""}）`,
      );
    return `文献需求覆盖（ResearchPlan requirements）：\n${lines.join("\n")}`;
  } catch {
    return undefined;
  }
}

/** M10.3：外部意见 digest（计划输入 F：含已落实的历史意见——作者目标常以此为载体） */
async function buildInstructionDigest(
  services: WorkflowServices,
  projectId: string,
): Promise<string | undefined> {
  const instructions = await services.externalInstructions.load(projectId);
  if (instructions.length === 0) {
    return undefined;
  }
  const lines = instructions.slice(0, 12).map((instruction) => {
    const label = `${instruction.source}${instruction.reviewerLabel !== undefined ? `·${instruction.reviewerLabel}` : ""}`;
    return `- [${instruction.instructionId}][${instruction.status}][${label}] ${firstLine(instruction.text, 160)}`;
  });
  return `外部修改意见（状态：pending=待处理 / already_satisfied=已在当前稿落实 / conflict=与事实冲突）：\n${lines.join("\n")}`;
}

/** run request 的作者修订目标（prompt 字段；M10.3 真实案例的作者路线说明） */
function readAuthorGoal(request: Record<string, unknown> | undefined): string | undefined {
  const value = request?.["prompt"];
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, 4000) : undefined;
}

/** 文本首个非空行（截断） */
function firstLine(text: string, maxLength: number): string {
  const line = text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry !== "");
  return (line ?? text).slice(0, maxLength);
}

/**
 * M6.6 §9：usableEvidence 业务规则已下沉到 EvidenceSelectionService（架构审计：
 * definitions.ts 不再堆业务逻辑）。正式上下文只进 formal（verified + 三件套
 * 锚点）；legacy unverified 保留在库中但不再自动注入（§M6.6-11，M6.7 收口）。
 */
async function usableEvidence(services: WorkflowServices, projectId: string): Promise<EvidenceRecord[]> {
  const { formal } = await services.evidenceSelection.selectForWriting(projectId);
  return formal;
}

async function safeMarkUsage(
  services: WorkflowServices,
  projectId: string,
  evidenceId: string,
  runId: string,
): Promise<void> {
  try {
    await services.evidence.markUsage(projectId, evidenceId, { usedBy: `run:${runId}` });
  } catch {
    // 使用关系记录失败不影响写作主流程
  }
}

/**
 * 构建审稿 / 理解用的稿件摘要（大纲 + 各节内容截断；或导入项目全部 tex）。
 * M11.3 起导出：Reviewer Stability 审计需要在与 review.run 完全相同的
 * digest 条件下重复采样（scripts/m113-reviewer-stability.mjs）。
 */
export async function buildManuscriptDigest(services: WorkflowServices, projectId: string): Promise<string> {
  const files = await collectLatexFiles(services.projects.manuscriptDir(projectId));
  const outline = await services.manuscript.loadOutline(projectId);
  const parts: string[] = [];
  if (outline !== null) {
    // 有大纲时 main.tex 是确定性组装产物（无审稿价值）；摘要单独成块（M4.8），
    // 摘要类 finding 应归到 "abstract" 而不是 main.tex
    const inputs = outline.sections.map((section) => `sections/${section.file.replace(/\.tex$/, "")}`).join("、");
    parts.push(
      `[main.tex]（组装根：\\documentclass + 标题 + 摘要 + \\input 各节；由系统生成，不要把问题归到这里）\n\\input 清单：${inputs}`,
    );
    if ((outline.abstract ?? "").trim() !== "") {
      parts.push(`[abstract]（论文摘要，独立可修订）\n${(outline.abstract ?? "").slice(0, 2000)}`);
    }
  } else if (files.mainTex !== null) {
    // M10.3：单文件 LaTeX 导入项目（无 \input / 无大纲）——按 \section /
    // \subsection 边界切块，否则 2000 字符截断会让审稿与论文理解几乎失明
    parts.push(...splitSingleFileDigest(files.mainTex.content));
  }
  for (const section of files.sections.slice(0, 24)) {
    parts.push(`[${section.relativePath}]\n${sliceForDigest(section.content, SECTION_DIGEST_BUDGET)}`);
  }
  if (parts.length === 0) {
    throw new BusinessError("STAGE_CONTRACT_VIOLATION", "manuscript 目录没有任何 .tex 文件");
  }
  return parts.join("\n\n").slice(0, 60_000);
}

/** M11.3：单节 digest 预算（中文综述节常 2500–4000 字符；24 节 × 3600 ≈ 86k，总量由 60k 总预算兜底） */
const SECTION_DIGEST_BUDGET = 3600;

/** digest 截断的系统注（防 reviewer 把视图截断误判为稿件缺陷） */
const DIGEST_TRUNCATION_NOTE =
  "…【系统注：本节超出审稿视图预算，此处为系统截断——完整内容以 manuscript 文件为准，截断处不构成稿件缺陷，不要据此报 build/结构问题】";

/**
 * M11.3（Phase D 根因修复）：digest 的句子边界安全截断。
 *
 * 旧行为的实证危害（MOT r9–r11）：`content.slice(0, 2500)` 恰好切在
 * `\cite{ng2023traffic` 的 `ng` 之间——reviewer 如实报告「\cite 未闭合 /
 * 段落截断」，连续三轮烧 Writer 修订（稿件本身完好、编译通过）。修复：
 * - 绝不切在 `\cite{…}` 族命令内部（扩到命令闭合处再回退）；
 * - 在预算内回退到最后一个句子边界（。！？!?；或换行）；
 * - 截断时附加显式系统注，让 reviewer 知道这是视图截断不是稿件缺陷。
 */
export function sliceForDigest(content: string, budget: number): string {
  if (content.length <= budget) {
    return content;
  }
  let cut = budget;
  // 不得切在未闭合的 \cite/\ref 族命令内：预算点向前扫描最近的 `{` 命令起始
  const commandStart = /\\(?:cite[a-zA-Z]*|ref|eqref|autoref|label)\*?(?:\[[^\]\n]*\])*\{$/;
  for (let guard = 0; guard < 8 && cut > 0; guard += 1) {
    const head = content.slice(0, cut);
    const openAt = head.lastIndexOf("{");
    if (openAt !== -1) {
      const tail = content.slice(openAt + 1);
      // 命令形态且右括号不在同一行内出现 → 截断点落在命令内部，回退到 `{` 前
      const before = head.slice(Math.max(0, openAt - 30), openAt);
      if (commandStart.test(before) && !/^[^{}\n]*\}/.test(tail)) {
        cut = openAt;
        continue;
      }
    }
    break;
  }
  // 回退到句界（段落边界优先，其次句号/分号）；找不到再退到词间空白
  const window = content.slice(0, cut);
  let boundary = Math.max(window.lastIndexOf("\n"), window.lastIndexOf("。"), window.lastIndexOf("！"), window.lastIndexOf("？"), window.lastIndexOf(";"), window.lastIndexOf("；"));
  if (boundary === -1 || boundary < budget * 0.5) {
    boundary = window.lastIndexOf(" ");
  }
  if (boundary > 0) {
    cut = boundary + 1;
  }
  return content.slice(0, cut).trimEnd() + "\n" + DIGEST_TRUNCATION_NOTE;
}

/**
 * 单文件论文 digest 切块（M10.3）：preamble+摘要 为一块，其后每个
 * \section / \subsection 起始一段。总块数 ≤ 18、每块 ≤ 2600 字符——
 * 与分节项目的 digest 量级一致，不因单文件形态丢失正文可见性。
 */
function splitSingleFileDigest(content: string): string[] {
  const normalized = content.replace(/\r\n/g, "\n");
  const boundary = /(^|\n)\\(?:sub)*section\*?\{[^}]*\}/g;
  const indices: number[] = [0];
  for (const match of normalized.matchAll(boundary)) {
    const at = (match.index ?? 0) + (match[1] ?? "").length;
    if (at > indices[indices.length - 1]!) {
      indices.push(at);
    }
  }
  const parts: string[] = [];
  for (const [position, start] of indices.entries()) {
    const end = position + 1 < indices.length ? indices[position + 1]! : normalized.length;
    const chunk = normalized.slice(start, end).trim();
    if (chunk === "") {
      continue;
    }
    const headerMatch = /\\(?:sub)*section\*?\{([^}]*)\}/.exec(chunk);
    const label =
      position === 0
        ? "main.tex（导言 + 标题 + 摘要）"
        : `main.tex · ${headerMatch?.[1]?.trim() ?? `第 ${position} 段`}`;
    parts.push(`[${label}]\n${chunk.slice(0, 2600)}`);
    if (parts.length >= 18) {
      break;
    }
  }
  return parts;
}

/** 读取最新 review 汇总（按 round 编号最大） */
function latestReviewSummary(
  services: WorkflowServices,
  projectId: string,
): Promise<ReviewSummary | null> {
  return services.reviewArtifacts.latestSummary(projectId);
}

/**
 * M11.2.3（D-3）：读取 evidence.ground_claims stage 结果 → claimId → 新
 * verified evidenceIds（采证回绑的输入；stage 不存在 / 无结果 → 空 map）。
 */
function collectGroundedClaimEvidence(state: WorkflowState): Map<string, string[]> {
  const result = state.stageResults["evidence.ground_claims"] ?? {};
  const outcomes = Array.isArray(result["outcomes"]) ? result["outcomes"] : [];
  const grounded = new Map<string, string[]>();
  for (const outcome of outcomes) {
    if (typeof outcome !== "object" || outcome === null) {
      continue;
    }
    const record = outcome as Record<string, unknown>;
    const claimId = typeof record["claimId"] === "string" ? record["claimId"] : null;
    const evidenceIds = Array.isArray(record["evidenceIds"])
      ? record["evidenceIds"].filter((id): id is string => typeof id === "string")
      : [];
    if (claimId !== null && evidenceIds.length > 0) {
      grounded.set(claimId, evidenceIds);
    }
  }
  return grounded;
}

/**
 * M11.2.3（D-3）：定向采证的 verified evidence 追加进 Claim Repair 候选
 * （确定性；去重——已在候选里的 evidenceId 不重复渲染）。
 */
function mergeGroundedEvidenceIntoRepairs(
  claimRepairs: ClaimRepairDirective[],
  groundedClaims: ReadonlyMap<string, string[]>,
  evidenceById: ReadonlyMap<string, EvidenceRecord>,
  bibliography: readonly import("../review/claimGrounding.js").ClaimGroundingBibEntry[],
): void {
  if (groundedClaims.size === 0 || claimRepairs.length === 0) {
    return;
  }
  for (const directive of claimRepairs) {
    const evidenceIds = groundedClaims.get(directive.claimId);
    if (evidenceIds === undefined) {
      continue;
    }
    for (const evidenceId of evidenceIds) {
      if (directive.candidates.some((candidate) => candidate.evidenceId === evidenceId)) {
        continue;
      }
      const record = evidenceById.get(evidenceId);
      if (record === undefined) {
        continue;
      }
      const key = resolveEvidenceCitationKey(record, bibliography);
      directive.candidates.push({
        evidenceId: record.id,
        claim: record.claim,
        ...(record.quote !== undefined && record.quote !== "" ? { quote: record.quote } : {}),
        ...(key !== null ? { citationKey: key } : {}),
      });
    }
  }
}

/** 修订指令：以 ReviewIssue 形式表达，可按目标章节匹配 */
interface RevisionDirective {
  /** 返回匹配到目标时对应的 issue */
  match(target: RevisionTarget): ReviewIssue | null;
  /** 匹配时携带的计划条目（M6.7：revise 派发后标记 applied；执行期派生回退时缺省） */
  item?: RevisionPlanItem;
}

export interface RevisionTarget {
  key: string;
  relativePath: string;
  currentLatex: string;
  logicalSpan?: RevisionSpan;
}

/** shared loop：以落盘的确定性修订计划为准（计划缺失时回退执行期派生） */
async function collectPlanDirectives(
  services: WorkflowServices,
  projectId: string,
): Promise<RevisionDirective[]> {
  const summary = await latestReviewSummary(services, projectId);
  if (summary === null) {
    return [];
  }
  const plan = await services.reviewArtifacts.loadPlan(projectId, summary.round);
  if (plan === null) {
    // 旧 run resume / 计划文件缺失：回退到执行期派生（语义等价，仅少了落盘计划）
    return collectRevisionDirectives(services, projectId, "revision.revise");
  }
  const directives: RevisionDirective[] = [];
  for (const item of plan.items) {
    if (!dispatchableRevisionItems([item]).length) continue;
    if (item.kind === "external_instruction") {
      // M5.7：外部意见经独立通道派发（collectExternalDirectives，携带执行报告
      // 协议与状态回写）；计划里的 external 条目是审计快照，不重复派发
      continue;
    }
    const issue = revisionPlanItemToIssue(item);
    directives.push({
      match: (target: RevisionTarget) => (revisionItemMatchesTarget(item, target) ? issue : null),
      item,
    });
  }
  return directives;
}

/**
 * M5.7 外部修改意见派发：读指令存储，pending / partially_handled / unresolved
 * 进入派发（handled 已有执行证据；conflict 与事实冲突，不自动改事实）。
 * Quick Review（existing_paper_review）不含修订 stage，天然只读不派发。
 */
async function collectExternalDirectives(
  services: WorkflowServices,
  projectId: string,
): Promise<ExternalDirectiveDispatch[]> {
  const instructions = await services.externalInstructions.load(projectId);
  return instructions
    .filter(
      (instruction) =>
        instruction.status === "pending" ||
        instruction.status === "partially_handled" ||
        instruction.status === "unresolved",
    )
    .map((instruction) => ({
      instructionId: instruction.instructionId,
      source: instruction.source,
      ...(instruction.reviewerLabel !== undefined
        ? { reviewerLabel: instruction.reviewerLabel }
        : {}),
      text: instruction.text,
      ...(instruction.section !== undefined ? { section: instruction.section } : {}),
    }));
}

/** 目标扩展用的哑 issue（值不会被消费；只让 listRevisionTargets 纳入被引用文件） */
function externalScopeIssue(): ReviewIssue {
  return {
    category: "academic",
    severity: "minor",
    section: "(external)",
    description: "外部修改意见目标扩展",
    blocking: false,
  };
}

/** 修订计划条目 → ReviewIssue（Writer 修订 prompt 的输入形态） */
function revisionPlanItemToIssue(item: RevisionPlanItem): ReviewIssue {
  // M5.7：mandatory（外部意见）映射为 critical + blocking（理论上不经此通道
  // 派发，保留映射以兼容旧计划文件 / 审计视图）
  const severity =
    item.priority === "high" || item.priority === "mandatory"
      ? "critical"
      : item.priority === "low"
        ? "minor"
        : "major";
  return {
    category: item.kind === "citation_missing" || item.kind === "citation_removed" ? "citation" : "academic",
    severity,
    section: item.section,
    description: `${item.problem}（计划要求：${item.instruction}）`,
    suggestedAction: item.instruction,
    blocking: item.priority === "high" || item.priority === "mandatory",
  };
}

function recordUnresolvedPlanOutcome(
  instructions: ExternalInstruction[],
  item: { instructionId?: string; relatedEvidenceIds?: string[]; logicalSection?: string },
  index: number,
  reason: string,
  summary: string,
): void {
  if (item.instructionId === undefined) return;
  const instruction = instructions.find((candidate) => candidate.instructionId === item.instructionId);
  if (instruction === undefined || instruction.status === "handled" || instruction.status === "conflict") return;
  // A same-comment NO-OP may cover one subrequirement while another plan item
  // still requires an author decision. Preserve both item traces and keep the
  // composite comment open. Historical imported already_satisfied records
  // (empty planItemIds) remain terminal.
  if (instruction.status === "already_satisfied" && (instruction.resolutionTrace?.planItemIds.length ?? 0) === 0) return;
  const priorTrace = instruction.resolutionTrace;
  instruction.status = "unresolved";
  instruction.statusNote = `${reason}: ${summary}`;
  instruction.resolutionTrace = {
    commentId: instruction.instructionId,
    planItemIds: [...new Set([...(priorTrace?.planItemIds ?? []), `improvement:${index + 1}`])],
    actionType: "author_decision_required",
    ...(item.logicalSection !== undefined ? { target: `main.tex#${item.logicalSection}` } : {}),
    evidenceIds: [...new Set([...(priorTrace?.evidenceIds ?? []), ...(item.relatedEvidenceIds ?? [])])],
    patchIds: priorTrace?.patchIds ?? [],
    verification: {
      ...(priorTrace?.verification ?? {}),
      scope: priorTrace?.verification.scope ?? false,
      evidence: priorTrace?.verification.evidence ?? false,
    },
    status: "unresolved",
    resolutionSummary: [priorTrace?.resolutionSummary, summary].filter(Boolean).join("; "),
    remainingIssue: reason,
  };
  instruction.updatedAt = new Date().toISOString();
}

/** shared loop：最新 review 汇总的问题 + 引用核验问题；apply：改进计划条目 */
async function collectRevisionDirectives(
  services: WorkflowServices,
  projectId: string,
  stageId: "revision.revise" | "revision.apply",
): Promise<RevisionDirective[]> {
  if (stageId === "revision.apply") {
    try {
      const plan = JSON.parse(
        await readFile(
          join(services.projects.researchDir(projectId), "improvement-plan.json"),
          "utf8",
        ),
      ) as {
        plan?: {
          items?: {
            section: string;
            action: string;
            actionType?: "modify" | "noop" | "author_decision_required";
            logicalSection?: string;
            coverageQuote?: string;
            protocolId?: string;
            rationale?: string;
            priority?: string;
            instructionId?: string;
            relatedEvidenceIds?: string[];
          }[];
        };
      };
      const items = plan.plan?.items ?? [];
      const evidence = await services.evidence.list(projectId);
      const evidenceById = new Map(evidence.map((record) => [record.id, record]));
      const files = await collectLatexFiles(services.projects.manuscriptDir(projectId));
      const source = files.mainTex?.content ?? "";
      const spans = locateLatexSections("main.tex", source);
      const instructions = await services.externalInstructions.load(projectId);
      let instructionsChanged = false;
      const actionable = items.filter((item) => {
        if (item.actionType === "author_decision_required") {
          recordUnresolvedPlanOutcome(instructions, item, items.indexOf(item), "AUTHOR_DECISION_REQUIRED", "This plan item requires an author decision.");
          instructionsChanged = true;
          return false;
        }
        if (item.actionType !== "modify" && item.actionType !== "noop") {
          recordUnresolvedPlanOutcome(instructions, item, items.indexOf(item), "REVISION_ACTION_TYPE_REQUIRED", "Plan item has no recognized typed action; Writer dispatch was skipped.");
          instructionsChanged = true;
          return false;
        }
        if (item.actionType === "modify") return true;
        const evidenceIds = item.relatedEvidenceIds ?? [];
        const coverage = verifyNoopCoverage({
          logicalSection: item.logicalSection,
          coverageQuote: item.coverageQuote,
          evidenceIds,
          ...(item.protocolId !== undefined ? { protocolId: item.protocolId } : {}),
        }, spans, evidenceById);
        if (!coverage.verified) {
          recordUnresolvedPlanOutcome(instructions, item, items.indexOf(item), coverage.reason ?? "NOOP_COVERAGE_FAILED", "NO-OP coverage verification failed; no Writer call was made.");
          instructionsChanged = true;
          return false;
        }
        const unresolvedSibling = items.find((candidate) =>
          item.instructionId !== undefined &&
          candidate.instructionId === item.instructionId &&
          candidate.actionType === "author_decision_required",
        );
        if (unresolvedSibling !== undefined) {
          recordUnresolvedPlanOutcome(
            instructions,
            item,
            items.indexOf(item),
            "PARTIAL_COMMENT_REMAINS_OPEN",
            `This NO-OP verified one baseline subrequirement, but another item still requires an author decision: ${unresolvedSibling.action}`,
          );
          const instruction = instructions.find((candidate) => candidate.instructionId === item.instructionId);
          if (instruction?.resolutionTrace !== undefined) {
            instruction.resolutionTrace.verification = {
              ...instruction.resolutionTrace.verification,
              scope: true,
              evidence: true,
            };
          }
          instructionsChanged = true;
          return false;
        }
        if (item.instructionId !== undefined) {
          const index = instructions.findIndex((instruction) => instruction.instructionId === item.instructionId);
          const instruction = instructions[index];
          if (instruction !== undefined && instruction.status !== "handled" && instruction.status !== "conflict") {
            instructions[index] = {
              ...instruction,
              status: "already_satisfied",
              statusNote: `确定性 baseline coverage 通过：${item.logicalSection}; 原文引文与 evidence 核验通过。`,
              resolutionTrace: {
                commentId: instruction.instructionId,
                planItemIds: [`improvement:${items.indexOf(item) + 1}`],
                actionType: "noop",
                target: `main.tex#${item.logicalSection}`,
                evidenceIds,
                patchIds: [],
                verification: { scope: true, evidence: true },
                status: "already_satisfied",
                resolutionSummary: "Baseline already contains the requested content, verified quote, and evidence.",
              },
              updatedAt: new Date().toISOString(),
            };
            instructionsChanged = true;
          }
        }
        return false;
      });
      if (instructionsChanged) await services.externalInstructions.save(projectId, instructions);
      return actionable.map((item, index) => ({
        match: (target: RevisionTarget) => {
          const matches =
            (item.logicalSection !== undefined && target.logicalSpan?.logicalSection === item.logicalSection) ||
            (item.logicalSection !== undefined && target.logicalSpan?.heading.toLowerCase() === item.logicalSection.toLowerCase()) ||
            revisionItemMatchesTarget({
            id: `improvement:${items.indexOf(item) + 1}`, kind: "review_finding", priority: item.priority === "high" ? "high" : "medium",
            section: item.section, problem: item.rationale ?? item.action, instruction: item.action, expectedOutcome: item.action,
            status: "planned", ...(item.instructionId ? { instructionId: item.instructionId } : {}),
          }, target);
          return matches ? planItemToIssue(item) : null;
        },
        // M10.3：改进计划条目以伪 RevisionPlanItem 形态携带证据与意见关联——
        // Writer 修订 prompt 据此注入「修改前依据」（itemEvidence 池），Fact
        // Preservation 的授权口径不变（improvementPlanItems 通道）
        item: {
          id: `improvement:${index + 1}`,
          kind: "review_finding" as const,
          priority:
            item.instructionId !== undefined
              ? ("mandatory" as const)
              : item.priority === "high"
                ? ("high" as const)
                : item.priority === "low"
                  ? ("low" as const)
                  : ("medium" as const),
          section: item.logicalSection ?? item.section,
          problem: item.rationale ?? item.action.slice(0, 200),
          instruction: item.action,
          expectedOutcome: item.action.slice(0, 160),
          status: "planned" as const,
          actionType: item.actionType ?? "modify",
          ...(item.protocolId !== undefined ? { protocolRequirement: { protocolId: item.protocolId } } : {}),
          ...(item.logicalSection !== undefined ? { logicalSection: item.logicalSection } : {}),
          ...(item.instructionId !== undefined ? { instructionId: item.instructionId } : {}),
          ...(item.instructionId !== undefined ? { source: "external" as const } : {}),
          ...(item.relatedEvidenceIds !== undefined && item.relatedEvidenceIds.length > 0
            ? { relatedEvidenceIds: item.relatedEvidenceIds }
            : {}),
        },
      }));
    } catch {
      return [];
    }
  }
  const directives: RevisionDirective[] = [];
  const summary = await latestReviewSummary(services, projectId);
  for (const issue of summary?.issues ?? []) {
    directives.push({
      match: (target: RevisionTarget) => (sectionMatches(issue.section, target) ? issue : null),
    });
  }
  // 引用核验问题也进入修订指令：Writer 移除 / 修正无法支撑的引用（不允许新造文献）
  for (const missing of await citationMissingTargets(services, projectId)) {
    const issue: ReviewIssue = {
      category: "citation",
      severity: "critical",
      section: "(unknown)",
      description: `引用 \\cite{${missing.key}} 在 references.bib 中不存在：删除该引用，或改为只基于现有文献的表述`,
      suggestedAction: "删除或修正引用",
      blocking: true,
    };
    for (const file of missing.files) {
      directives.push({
        match: (target: RevisionTarget) => (target.relativePath === file ? issue : null),
      });
    }
  }
  return directives;
}

/**
 * M6.7 §5/§6：bib key ↔ verified evidence 关联（matchBibliographyKey 同源）。
 * formal evidence 覆盖到的每个 key 携带其 evidence id 列表；修订计划据此给
 * citation 类条目挂 relatedEvidenceIds，Revision Validation 对其做再核验（§9）。
 */
async function buildEvidenceLinks(
  services: WorkflowServices,
  projectId: string,
): Promise<{ key: string; evidenceIds: string[] }[]> {
  const citation = await services.citation.latestReport(projectId);
  if (citation === null) {
    return [];
  }
  const byKey = new Map<string, string[]>();
  const records = await services.evidence.list(projectId);
  for (const record of records) {
    if (!isFormalEvidence(record)) {
      continue; // 只有关联正式证据（verified + 锚点）的 key 才挂 relatedEvidenceIds
    }
    const key = EvidenceSelectionService.matchBibliographyKey(record, citation.static.bibEntries);
    if (key === null) {
      continue;
    }
    const ids = byKey.get(key) ?? [];
    ids.push(record.id);
    byKey.set(key, ids);
  }
  return [...byKey.entries()].map(([key, evidenceIds]) => ({ key, evidenceIds }));
}

/** 引用缺失的确定性定位：missing key → 出现该引用的 tex 文件（revision.plan / 修订指令共用） */async function citationMissingTargets(
  services: WorkflowServices,
  projectId: string,
): Promise<{ key: string; files: string[] }[]> {
  const citation = await services.citation.latestReport(projectId);
  if (citation === null || citation.static.missingKeys.length === 0) {
    return [];
  }
  const files = await collectLatexFiles(services.projects.manuscriptDir(projectId));
  return citation.static.missingKeys.map((key) => ({
    key,
    files: files.allTex
      .filter((file) => extractCitationKeys(file.relativePath, file.content).keys.includes(key))
      .map((file) => file.relativePath),
  }));
}

/**
 * 诊断给出的章节文件（TeX 日志解析结果，不可信输入）→ 受控 manuscript 内
 * 绝对路径。防 path traversal：resolve 后必须仍在 manuscript 目录内，且只接受 .tex。
 */
function safeManuscriptFile(
  services: WorkflowServices,
  projectId: string,
  relativeFile: string,
): string | null {
  const manuscriptDir = services.projects.manuscriptDir(projectId);
  const normalized = relativeFile.replaceAll("\\", "/").replace(/^\.\//, "");
  if (!normalized.endsWith(".tex")) {
    return null;
  }
  const absolute = resolve(manuscriptDir, normalized);
  if (!(absolute + sep).startsWith(manuscriptDir + sep)) {
    return null;
  }
  return absolute;
}

/** 修复目标：诊断定位到的文件（去重、按首个诊断排序、≤ 3 个） */
function repairTargetFiles(
  services: WorkflowServices,
  projectId: string,
  diagnostics: LatexDiagnostic[],
): string[] {
  const seen = new Set<string>();
  const files: string[] = [];
  for (const diagnostic of diagnostics) {
    if (diagnostic.file === null) {
      continue;
    }
    if (safeManuscriptFile(services, projectId, diagnostic.file) === null) {
      continue;
    }
    if (!seen.has(diagnostic.file)) {
      seen.add(diagnostic.file);
      files.push(diagnostic.file);
    }
  }
  return files.slice(0, 3);
}

function planItemToIssue(item: {
  section: string;
  action: string;
  rationale?: string;
  priority?: string;
}): ReviewIssue {
  return {
    category: "academic",
    severity: item.priority === "high" ? "critical" : item.priority === "low" ? "minor" : "major",
    section: item.section,
    description: `${item.action}${item.rationale ? `（依据：${item.rationale}）` : ""}`,
    blocking: item.priority === "high",
  };
}

/**
 * 摘要类 section 引用（M4.8）：Reviewer 可能把摘要 finding 归到
 * 「main.tex（摘要）」「摘要」「abstract」等——这些引用只允许路由到摘要
 * 修订目标（outline.abstract 的独立载体），绝不落入组装根 main.tex 或
 * 任何章节文件（M4.7 修复的回归方向）。
 */
function isAbstractSectionRef(sectionRef: string): boolean {
  const ref = sectionRef.trim().toLowerCase();
  return ref !== "" && (ref.includes("摘要") || ref.includes("abstract"));
}

/**
 * issue/plan 的 section 字段与修订目标的模糊匹配（路径 / id / 文件名 / heading）。
 *
 * M10.4.4 分层（逐层、确定性）：
 * 1. 摘要互斥（M4.8 语义 + grounded 补充）：摘要目标只收摘要类引用；摘要类
 *    引用对普通目标仅当该目标自身内容含摘要环境（latexContainsAbstract）才
 *    匹配——单文件 main.tex 项目（摘要物理在文件内、无独立摘要目标）的
 *    abstract 类 finding 不再永久滞留；outline 项目组装根不入目标、章节文件
 *    无摘要环境，行为不变。
 * 2. 路径 / stem / key 匹配：M10.3 前既有语义逐字保留（多文件与显式路径引用）。
 * 3. heading 匹配（grounded in target.currentLatex）：引用切段（分隔符 /
 *    括号注释 / 前导编号剥离）后与目标真实 \section 系标题做精确段匹配与
 *    子串兜底——「方法/3.6 轨迹稳定性自适应损失」类自由格式引用命中含该
 *    标题的目标文件；无法可靠匹配保持 unmatched（不广播、不伪造）。
 *
 * 导出供 M10.4.4 派发覆盖单测直接测试真实匹配语义。
 */
export function sectionMatches(sectionRef: string, target: RevisionTarget): boolean {
  const ref = sectionRef.trim().replaceAll("\\", "/").toLowerCase();
  if (ref === "") {
    return false;
  }
  // 摘要引用与普通目标互斥：摘要只进摘要目标，章节引用不进摘要目标；
  // M10.4.4 grounded 例外：目标自身含摘要环境（单文件 main.tex）时摘要类
  // 引用允许派发——摘要的物理载体就是该文件
  if (target.key === "abstract") {
    return isAbstractSectionRef(ref);
  }
  if (isAbstractSectionRef(ref)) {
    return latexContainsAbstract(target.currentLatex);
  }
  const path = target.relativePath.replaceAll("\\", "/").toLowerCase();
  const fileName = path.split("/").pop() ?? path;
  const stem = fileName.replace(/\.tex$/, "");
  if (target.logicalSpan !== undefined && (ref === path || ref === fileName || ref === stem)) {
    return false; // file identity is not a logical subsection authorization
  }
  if (
    ref === path ||
    ref === fileName ||
    ref === stem ||
    ref === target.key.toLowerCase() ||
    ref.endsWith(`/${path}`) ||
    path.endsWith(ref) ||
    ref.includes(stem) ||
    target.key.toLowerCase().includes(ref)
  ) {
    return true;
  }
  return sectionRefNamesHeading(sectionRef, headingsOfContent(target, target.currentLatex));
}

function revisionItemMatchesTarget(item: RevisionPlanItem, target: RevisionTarget): boolean {
  if (sectionMatches(item.section, target)) return true;
  if (target.logicalSpan === undefined) return false;
  const text = `${item.problem}\n${item.instruction}`.toLocaleLowerCase();
  const heading = target.logicalSpan.heading.toLocaleLowerCase().trim();
  return heading.length >= 5 && text.includes(heading);
}

/** 修订目标列表：有大纲按大纲；否则用全部非 main 的 tex；指令引用的额外文件一并纳入 */
function listRevisionTargets(
  outline: Outline | null,
  files: LatexProjectFiles,
  directives: RevisionDirective[],
): RevisionTarget[] {
  const contentByPath = new Map<string, string>();
  for (const file of files.allTex) {
    contentByPath.set(file.relativePath, file.content);
  }
  const targets: RevisionTarget[] = [];
  const add = (key: string, relativePath: string, content: string | undefined) => {
    if (content === undefined) {
      return;
    }
    if (targets.some((target) => target.relativePath === relativePath)) {
      return;
    }
    targets.push({ key, relativePath, currentLatex: content });
  };
  if (outline !== null && outline.sections.length > 0) {
    // 摘要是一等修订目标（M4.8）：载体是 outline.abstract（virtualPath "abstract"，
    // 写回 outline.json 而不是 manuscript/ 下的文件；由修订 stage 特判）
    if ((outline.abstract ?? "").trim() !== "") {
      targets.push({ key: "abstract", relativePath: "abstract", currentLatex: outline.abstract ?? "" });
    }
    for (const section of outline.sections) {
      add(section.id, `sections/${section.file}`, contentByPath.get(`sections/${section.file}`));
    }
  } else if (files.sections.length > 0) {
    for (const file of files.sections) {
      add(file.relativePath, file.relativePath, file.content);
    }
  } else if (files.mainTex !== null) {
    // M11.4.1: main.tex is a physical file, not a logical revision scope.
    const spans = locateLatexSections("main.tex", files.mainTex.content);
    if (spans.length > 0) {
      for (const span of spans) {
        const target: RevisionTarget = {
          key: span.logicalSection,
          relativePath: "main.tex",
          currentLatex: span.content,
          logicalSpan: span,
        };
        if (directives.some((directive) => directive.match(target) !== null)) targets.push(target);
      }
    } else {
      // No heading means there is no safe patch boundary; fail closed unless an explicit
      // whole-file build repair is the only directive.
      const wholeFileRepair = directives.some((directive) => directive.item?.kind === "build_error");
      if (wholeFileRepair) targets.push({ key: "main.tex", relativePath: "main.tex", currentLatex: files.mainTex.content });
    }
  }
  // 指令引用了不在目标中的现有文件（如导入项目的自定义路径）→ 追加。
  // 有大纲时根 main.tex 是 writeMainTex 的确定性组装产物（含 outline.abstract），
  // 本 stage 收尾即被重组覆盖 —— 绝不作为修订目标；Reviewer 把摘要类 finding
  // 归到 main.tex 时该条留在计划里不派发（复审仍可见，最坏走收敛 HITL）。
  // 无大纲的导入项目 main.tex 是用户内容，维持可修订（writeMainTex 不会运行）。
  for (const file of files.allTex) {
    if (outline !== null && file.relativePath === "main.tex") {
      continue;
    }
    const pseudoTarget: RevisionTarget = {
      key: file.relativePath,
      relativePath: file.relativePath,
      currentLatex: file.content,
    };
    if (targets.some((target) => target.relativePath === file.relativePath)) {
      continue;
    }
    if (directives.some((directive) => directive.match(pseudoTarget) !== null)) {
      add(file.relativePath, file.relativePath, file.content);
    }
  }
  return targets;
}

function readFeedback(payload: Record<string, unknown> | undefined): string | undefined {
  const value = payload?.["feedback"];
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, 4000) : undefined;
}

function readPayloadString(payload: Record<string, unknown>, field: string): string | undefined {
  const value = payload[field];
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, 300) : undefined;
}

function readBuildError(state: WorkflowState): string | undefined {
  const value = state.stageResults["build.draft"]?.["buildError"];
  return typeof value === "string" && value !== "" ? value : undefined;
}

/** 删除某个 stage 的成功结果（并从 completedStages 移除），使 planner 重跑 */
function dropStageResult(state: WorkflowState, stageId: string): void {
  delete state.stageResults[stageId];
  state.completedStages = state.completedStages.filter((id) => id !== stageId);
}

function countCompletions(state: WorkflowState, stageId: string): number {
  return state.stageHistory.filter((record) => record.stageId === stageId && record.status === "completed")
    .length;
}

function lastCompletionIndex(state: WorkflowState, stageId: string): number {
  let index = -1;
  for (let position = 0; position < state.stageHistory.length; position += 1) {
    const record = state.stageHistory[position];
    if (record?.stageId === stageId && record.status === "completed") {
      index = position;
    }
  }
  return index;
}
