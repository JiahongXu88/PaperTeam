/**
 * Workflow 定义。
 *
 * 两条一级工作流共享后段（D-0010）：
 *
 *   Idea-to-Paper 前段：
 *     research.idea → evidence.ground（有界文献/全文/RAG/三段核验）→ research.feasibility → HITL(feasibility: approve/adjust/cancel)
 *     → outline.plan → HITL(outline: approve/revise/cancel)
 *     → HITL(evidence_supply: continue/cancel；M9.7.4 条件出现——待审候选 ≥3，
 *       自动供给后仍无 verified 时提示人工补给) → writing.sections
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

import { createHash, randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { basename, join, resolve, sep } from "node:path";

import { BusinessError, InvalidLatexOutputError, WorkflowInvalidStateError } from "../errors.js";
import { isExistingPaperKind, isSurveyKind, isThesisKind } from "./kinds.js";
import type { GenerationService } from "../generation/GenerationService.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { normalizeManuscriptLanguage } from "../project/language.js";
import { tokenizeText } from "../retrieval/tokenize.js";
import type { EvidenceStore, EvidenceRecord } from "../evidence/EvidenceStore.js";
import type { EvidenceGroundingService } from "../evidence/EvidenceGroundingService.js";
import type { TargetedGroundingService } from "../evidence/TargetedGroundingService.js";
import { supplyResearchEvidence } from "../evidence/ResearchEvidenceSupply.js";
import {
  compareAbstractSnapshot,
  computeAuthorDecisionFingerprint,
  computeConfirmedFactFingerprint,
  computeManuscriptSectionsFingerprint,
  type AbstractSnapshotBinding,
} from "../thesis/abstractSnapshot.js";
import { selectReviewerSourceIds } from "../evidence/revisionSourceSelection.js";
import { buildPlannerAliases, plannerEligibleEvidence } from "../review/plannerAliases.js";
import type { ChunkStore } from "../retrieval/ChunkStore.js";
import { EvidenceSelectionService, isFormalEvidence } from "../evidence/EvidenceSelectionService.js";
import type { ResearchCoverageService } from "../agents/researchCoverage.js";
import type { ResearchPlanExecutionService } from "../agents/researchPlanExecution.js";
import { computeEvidenceCitationCoverage } from "../quality/evidenceCitationCoverage.js";
import type { SourceStore } from "../sources/SourceStore.js";
import type { ExperimentPackageService } from "../experiments/ExperimentPackageService.js";
import { renderExperimentPolicyLines } from "../experiments/experimentPolicy.js";
import { buildPublishedAssessmentView, readReviewPurpose, renderPublishedAssessmentPolicyLines } from "../review/reviewPurpose.js";
import { checkInputQaAttestation, type AttestationCheck } from "../review/inputFidelityAttestation.js";
import { INPUT_FIDELITY_REPORT_SCHEMA, type InputFidelityReport } from "../review/inputFidelityTypes.js";
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
import { fingerprintJson, sha256Hex } from "../util/hash.js";
import { buildSurveySectionContext } from "../survey/sectionContext.js";
import {
  resolveArgumentUnits,
  summarizeArgumentTask,
  type ResolvedArgumentUnit,
} from "../writer/argumentUnit.js";
import {
  allocateSectionEvidence,
  projectAllocatedEvidence,
  type SectionEvidenceAllocation,
} from "../evidence/sectionEvidenceAllocation.js";
import { classifyAcademicRedundancy } from "../review/academicRedundancyClassifier.js";
import type { WritingPlanArtifact, WritingPlanSectionRecord } from "../review/reviewArtifacts.js";
import {
  evaluateSurveyWriting,
  renderSurveyMetricsLines,
  type SurveyWritingEvaluation,
} from "../survey/writingInvariants.js";
import { normalizeTaxonomy, UNCLASSIFIED_FAMILY, type SurveyTaxonomy } from "../survey/matrixTypes.js";
import {
  buildQueryHitCounts,
  legacyRecencyOrder,
  rankSurveyCandidates,
  selectRecommendedCandidates,
  SURVEY_RECOMMENDED_MAX,
  type RankedCandidate,
  type RecommendationSelection,
  type SurveyRelevanceContext,
} from "../survey/candidateRelevance.js";
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
  computeFactPreservationForCandidate,
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
import { computeClaimGapAudit, resolveClaimIndexLinks, tagIssueRootCauses, type ClaimGapAudit } from "../review/claimGapAudit.js";
import { normalizeNumericToken as factPreservationNormalizeNumericToken } from "../quality/factPreservation.js";
import {
  classifyFindingOrigins,
  evaluateRevisionTaskGate,
  type ExternalInstructionSnapshot,
  type RevisionTaskGateResult,
  type RevisionTaskPolicy,
} from "../quality/revisionTaskGate.js";
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
import { reclassifyAuthorInputActions } from "../writer/WriterService.js";

/**
 * M11.4 Reliability Closure（Run A 实证）：修订元注记 / 决策标记 / 执行报告行
 * 出现在论文正文 = 内容污染（【修订说明】裸 λ_ 曾直接炸掉 LaTeX 编译）。
 * 候选级拒绝 + bounded repair（见 revision.revise 的 revision_meta_text 失败码）。
 */
const REVISION_META_TEXT_PATTERN = /【(修订说明|修订注记?|修复说明|执行报告|派发说明|决策点|待作者确认|待作者裁决|作者决策[：:]?)】|%%%PT-OUTCOMES%%%/;
import type { ResearcherService, ResearchArtifact, BibliographyEntryInput } from "../agents/ResearcherService.js";
import { readResearchArtifact } from "../agents/ResearcherService.js";
import { readPlanChain } from "../agents/researchPlan.js";
import { readFeasibilityReport, type FeasibilityService } from "../agents/FeasibilityService.js";
import type { ModeReviewResult, ReviewerService, ReviewIssue, UnitReviewContext } from "../agents/ReviewerService.js";
import {
  ACADEMIC_CONFIRMATION_SAMPLES_MAX,
  aggregateAcademicSamples,
  shouldConfirmAcademicScore,
  type AcademicScoreConfirmation,
} from "../review/academicConfirmation.js";
import {
  buildReferenceVocabulary,
  describeIntroducedNamedReferences,
  findIntroducedNamedReferences,
} from "../review/namedReferenceGuard.js";
import { annotateOutlinePartialKeyPoints } from "../writer/partialKeyPoints.js";
import { computeMultiKeyAttribution, renderMultiKeyAttributionDigest } from "../review/multiKeyAttribution.js";
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
import { aggregateReviews, type AcademicScoreBasis, type ReviewSummary } from "../review/ReviewAggregator.js";
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
import { adaptLineEndingsToSpan, alignProposalToSpan, applyRevisionSpan, checkMultiRangeScope, checkGlobalRevisionScope, checkRevisionScope, describeScopeViolation, hasNewContentAfterDocumentEnd, isWholeQuoteDeletion, hasRevisionWorkspaceMutation, locateLatexSections, revisionSourceHash, revisionSpansOverlap, verifyNoopCoverage, type RevisionSpan } from "../review/revisionScope.js";
import { findWriterProcessCommentary } from "../review/writerCommentary.js";
import { filterEvidenceForProtocol } from "../evidence/protocolScope.js";
import { attributeCitationChangesToPatches, summarizePatchValidation, validationForComment, type PatchValidationRecord } from "../review/patchValidation.js";
import { buildPatchRepairPrompt, selectFinalPatchRecords, type PatchRepairDirective, type RevisionViolationCode } from "../review/revisionHarness.js";
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
  applyPatchBackedOutcomeOverrides,
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
import { checkStyleInvariants, extractCitationKeys as extractCitedKeyList } from "../review/styleInvariants.js";
import {
  judgeOutcome,
  judgeConvergence,
  iterationsForRun,
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
  type ThesisGateInput,
} from "../quality/gates.js";
import type { ThesisPlannerService } from "../thesis/ThesisPlannerService.js";
import type { ResearchInputService } from "../thesis/ResearchInputService.js";
import { authorDecisionFromResumeInput } from "../thesis/ResearchInputService.js";
import type { ThesisDocumentService } from "../thesis/ThesisDocumentService.js";
import type { InheritedTableAssetStore } from "../thesis/inheritedAssets.js";
import { renderInheritedTableLatex, verifyInheritedTables, inheritedTableLabel, extractGuardedTableBlocks } from "../thesis/inheritedAssets.js";
import { checkCrossChapterConsistency } from "../thesis/crossChapterConsistency.js";
import type { AuthorDecision } from "../thesis/researchInputTypes.js";
import type { ThesisChapterPlan } from "../thesis/thesisWorkflowTypes.js";
import { buildThesisSectionContext, chapterSourceText, sourceProjectionForSection } from "../thesis/thesisWritingContext.js";
import { composeExperimentAndResearchFactPolicyLines, renderResearchFactLine } from "../thesis/researchFactPolicy.js";
import { detectConfirmedFactRemoval, disconfirmFactFindingsAgainstResearchFacts, researchFactsAsAuthorizedObservations } from "../thesis/factFindingDisconfirmation.js";
import type { MissingMaterialLedger } from "../thesis/MissingMaterialLedger.js";
import { chaptersWithUsableFacts, deriveChapterMaterialGaps, deriveScopeGapProposals, isBlockingGap } from "../thesis/MissingMaterialLedger.js";
import type { MissingMaterialService } from "../thesis/MissingMaterialService.js";
import type { ThesisAbstractService } from "../thesis/thesisAbstract.js";
import { chapterOrder, normalizeChapterReferences, renderChapterOrderLines } from "../thesis/chapterReferences.js";
import { detectWorkflowMetaNotes, stripWorkflowMetaNotes } from "../thesis/workflowMetaNotes.js";
import { scanTemplatedPhrasing } from "../thesis/templatedPhrasing.js";
import { checkFactDrift, summarizeDrift } from "../thesis/publishedFactsDrift.js";
import { outlineFingerprintFromChapters } from "../thesis/thesisWorkflowTypes.js";
import { validateThesisDocumentModel } from "../thesis/thesisDocumentTypes.js";
import type { Outline, OutlineSection } from "../manuscript/ManuscriptService.js";
import { collectLatexFiles, type LatexProjectFiles } from "../manuscript/LatexFiles.js";
import {
  readinessGateAdvisory,
  renderPlannerTargetDigest,
  renderTargetExpectationsBlock,
  renderTargetReferenceBlock,
} from "../target/promptBlocks.js";
import type { TargetServices } from "../target/services.js";
import { writeFileAtomic, writeJsonAtomic } from "../util/atomic.js";
import { mapWithConcurrency } from "../util/concurrency.js";
import {
  buildReviewCoveragePlan,
  computeReviewCoverage,
  digestIsLossy,
  planIncrementalInvalidation,
  type IncrementalReviewLedger,
  type IncrementalUnitDisposition,
  type ReviewCoverageSummary,
  type ReviewUnitAttemptTrace,
  type ReviewUnitPlanEntry,
  type ReviewUnitRecord,
} from "../review/coverageLedger.js";
import { projectFindingTarget } from "../review/findingProjection.js";
import {
  selectBestRevision,
  shouldRestoreBest,
  terminalScorecardForRun,
} from "../review/bestRevision.js";
import type { RunBudgetSnapshot } from "../runtime/runBudget.js";
import { budgetExhausted } from "../runtime/runBudget.js";
import {
  DEFAULT_REVISION_UNIT_MAX_CHARS,
  baseSpanId,
  buildUnitEditContext,
  fileBodySpan,
  isUnitSpanId,
  locateFileSpans,
  mergeAdjacentUnits,
  partitionSpanIntoBlockUnits,
  partitionSpanIntoUnits,
  relocateRevisionSpan,
  resolveUnitByQuotes,
} from "../review/logicalSpan.js";
import { evaluateScopedLatexRepair, isSingleFileManuscript, planScopedLatexRepair, type ScopedRepairPlan } from "../review/scopedLatexRepair.js";
import { stripLatexReviewMetadata } from "../review/blindReviewInput.js";
import {
  buildContextSnapshotRecord,
  DEFAULT_UNIT_DEPENDENCY_BUDGET_CHARS,
  indexDependencyTargets,
  locateAbstractAnchor,
  referenceOnlyQuoteIndices,
  resolveUnitDependencies,
  type ReviewContextSnapshotRecord,
  type ReviewUnitContextPolicy,
  type SourceVerification,
} from "../review/reviewContextSnapshot.js";
import type {
  PlanDecision,
  ResumeInput,
  StageRunContext,
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
  /** 作者确认实验观测只读上下文；绝不转成 Verified Evidence */
  experimentPackages: ExperimentPackageService;
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
  /**
   * M12 A9：Target Publication Intelligence 服务束（buildTargetServices 产物）。
   * **可选**——未接线（旧测试栈 / target 未配置）时 target.* stage 显式 no-op
   * （零模型调用 / 零 HITL / 不改任何终态语义），既有工作流行为不变。
   */
  targets?: TargetServices;
  stageTimeoutMs: number;
  stageMaxAttempts: number;
  /**
   * M14.1a：修订编辑单元上限（字符）。超过的章节文件 / 标题 span 切成有界
   * logicalSpan 单元（段落窗口）逐个修订；缺省 DEFAULT_REVISION_UNIT_MAX_CHARS。
   */
  revisionUnitMaxChars?: number;
  /**
   * M13.7.10：写作组织策略。argumentUnits=true → writing.sections 按章节论证单元
   * 分配 Evidence 并注入 B2 任务块；缺省（旧测试栈未接线）视为开启。
   */
  writing?: { argumentUnits: boolean };
  /**
   * M14.4 P0-3：run 级模型预算账本（可选；未接线 = 无预算约束，行为零变化）。
   * planSharedTail 在派发新的模型 stage（review.run / revision.revise）前查询：
   * 预算耗尽 → 走 overflow HITL / Draft 终态（优雅降级，保留产物），而不是
   * 让 runtime 硬约束在 stage 中途把 run 打失败。硬约束本体在
   * RunBudgetLedgerRuntime（startAgent 启动前拦截）。
   */
  modelBudget?: {
    /** 同步快照（进程内实时；进程刚启动无缓存时 null = 无预算信号） */
    snapshotSync(projectId: string, runId: string): RunBudgetSnapshot | null;
  };
  /** bounded loop 与 Quality Gate 阈值 */
  review: {
    maxRevisionRounds: number;
    academicPassScore: number;
    styleRiskMax: number;
    /** M13 Final Closure（任务 B）：academicScore 带内复核带宽 / 额外采样上限（缺省 0 = 关闭） */
    academicConfirmationBand?: number;
    academicConfirmationSamples?: number;
    /** 单节审阅节内重试的退避（毫秒；缺省 SECTION_REVIEW_BACKOFF_MS，测试可置 0） */
    sectionRetryBackoffMs?: readonly number[];
    /** section review 有界并发度（PAPERTEAM_REVIEW_CONCURRENCY；活跃模型调用上限） */
    reviewConcurrency: number;
    /** benchmark / 诊断：限制单次审阅的章节数（0 = 不限制） */
    reviewSectionLimit: number;
    /** M14.8.1-MOT：长文档单元审查的跨轮合法缓存（缺省开启；PAPERTEAM_REVIEW_INCREMENTAL=0 关闭） */
    incrementalUnitReuse?: boolean;
    /** M14.9.1 实验开关：digest 模式输入按字段移除身份元数据（缺省 production = 不变） */
    inputMode?: "production" | "metadata_blind";
    /** M14.9.1 实验开关：审稿 prompt 追加元数据中立条款（缺省 false = prompt 逐字节不变） */
    neutralityPolicy?: boolean;
    /**
     * M14.9.5.1 长文档单元审稿上下文策略（缺省 shared_session = 行为与 prompt 逐字节不变；见 review/reviewContextSnapshot.ts）
     */
    unitContextPolicy?: ReviewUnitContextPolicy;
    /** M14.9.5.1 单元依赖原文上限（字符；缺省 DEFAULT_UNIT_DEPENDENCY_BUDGET_CHARS） */
    unitDependencyBudgetChars?: number;
    /** M11.4：existing-paper 分层 gate 策略（Revision Task vs Publication Ready） */
    revisionTaskPolicy: RevisionTaskPolicy;
  };
  /**
   * M14.2：thesis_from_papers 服务束。必填字段——thesis 工厂在 kind 为
   * thesis_from_papers 时消费；其余 kind 的测试桩经 `as unknown as` 装配不受影响。
   */
  thesis: ThesisWorkflowServices;
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
/** M14.8.1-MOT：改进计划 HITL 展示条目上限（只防病态体量；正常计划全部展示） */
const HITL_PLAN_ITEMS_MAX = 80;
/** M14.8.1-MOT：Planner 意见别名表的常规上限（未闭环意见不受此上限约束，必全部入表） */
const PLANNER_COMMENT_ALIAS_MAX = 20;

/**
 * M14.8.1-MOT（真实继续返修实录）：别名表此前取 instructions.slice(0, 20)（按录入顺序），第 21 条起
 * 的意见——恰是后续轮次新增、仍待处理的意见——没有 C# 别名，Planner 无从链接，一律落入
 * 「作者决定」兜底（R2-6 / R2-7 / R3-1..3 五条可直接修订的意见因此从未被处理）。未闭环意见
 * 优先编号且全部入表；已闭环意见只作上下文补足到上限。
 */
export function orderInstructionsForPlannerAliases<T extends { status: string; statusNote?: string }>(
  instructions: readonly T[],
  max: number,
): T[] {
  const open = (instruction: T): boolean =>
    (instruction.status === "pending" || instruction.status === "partially_handled" || instruction.status === "unresolved") &&
    !(instruction.statusNote ?? "").startsWith("AUTHOR_DECISION_REQUIRED");
  const opened = instructions.filter(open);
  return [...opened, ...instructions.filter((instruction) => !open(instruction))].slice(0, Math.max(max, opened.length));
}
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
      // M12 A9：目标带数值期望（fresh profile 才有；仅 academic 模式消费）
      const targetExpectations = await readTargetExpectationsBlock(services, ctx.projectId);
      // M13.6：实验数据使用口径（三路 review 共享；综述无实验数据）
      // M14.5/M14.6：学位论文项目——作者已确认的研究输入事实是合法数据来源（与 Writer 纪律同源）；
      // M14.6 把 Experiment Policy 与事实表合成一个不自相矛盾的口径块（F5 真实失败形态：
      // 「没有已导入的实验数据」行紧接事实表，reviewer 取前者）
      const thesisConfirmedFacts = await thesisConfirmedResearchFacts(services, ctx.projectId);
      // M14.9.3：审稿目的。缺省 author_manuscript（作者稿件口径，行为不变）；published_paper_assessment 只在
      // idea_to_paper 只读评估入口生效——第三方已发表论文的自报数值不再按「实验支撑缺口」报告
      const publishedAssessment = isPublishedAssessmentRun(ctx.state);
      const publishedAssessmentLines = publishedAssessment ? renderPublishedAssessmentPolicyLines() : undefined;
      const experimentPolicyLines = options.survey === true || publishedAssessment
        ? undefined
        : await experimentAndResearchFactPolicyLines(services, ctx.projectId);
      // M13.7.10：写作期生成的只读学术重复报告（修订号一致才注入 style 模式；不进 Gate）
      const redundancyDigest = await buildRedundancyDigest(services, ctx.projectId, revision);
      // M13 Final Closure（A4）：多 key 引用归因只读观察（句子具体内容只命中组内一篇的证据）——
      // 仅注入 fact 模式作为逐句核验提示；产物按轮落盘，不进 Gate、不自动改稿
      const latexForAttribution = await collectLatexFiles(services.projects.manuscriptDir(ctx.projectId));
      // M14.1a P0-2：覆盖计划先于审查执行构建——review 到底看了多少正文由此可证明。
      // digest 有损（节 >3600 / 总量 >60k / 文件 >24）→ 切换 per-unit 长文档模式；
      // 否则维持既有单 digest 三路 review（短论文行为零变化，coverage = 完整 digest）。
      const coverageSourceFiles = latexForAttribution.sections.length > 0
        ? latexForAttribution.sections
        : latexForAttribution.mainTex !== null ? [latexForAttribution.mainTex] : [];
      const unitMaxChars = services.revisionUnitMaxChars ?? DEFAULT_REVISION_UNIT_MAX_CHARS;
      const coveragePlan = buildReviewCoveragePlan(
        coverageSourceFiles.map((file) => ({ file: file.relativePath, content: file.content })),
        unitMaxChars,
      );
      const longDocumentMode = digestIsLossy(coverageSourceFiles);
      const round = await services.reviewArtifacts.nextSummaryRound(ctx.projectId);
      let coverageSummary: ReviewCoverageSummary;
      const multiKeyAttribution = computeMultiKeyAttribution({
        files: latexForAttribution.sections.map((section) => ({ file: section.relativePath, content: section.content })),
        evidence,
        bibEntries: citationReport?.static.bibEntries ?? [],
        revision,
      });
      const attributionDigest = renderMultiKeyAttributionDigest(multiKeyAttribution);
      const reviewParams = {
        projectId: ctx.projectId,
        manuscriptDigest: digest,
        evidence,
        signal: ctx.signal,
        targetProfile: project.targetProfile,
        ...(language !== undefined ? { language } : {}),
        ...(citationDigest !== undefined ? { citationDigest } : {}),
        ...(options.survey === true ? { reviewProfile: "survey" as const } : {}),
        ...(surveyDigest !== undefined ? { surveyDigest } : {}),
        ...(targetExpectations !== undefined ? { targetExpectations } : {}),
        ...(experimentPolicyLines !== undefined ? { experimentPolicyLines } : {}),
        ...(redundancyDigest !== undefined ? { redundancyDigest } : {}),
        ...(attributionDigest !== undefined ? { attributionDigest } : {}),
        // M14.9.1 实验开关：缺省关闭时不出现该键（prompt / 单元请求指纹逐字节不变）
        ...(services.review.neutralityPolicy === true ? { neutralityPolicy: true } : {}),
        ...(publishedAssessmentLines !== undefined ? { publishedAssessmentLines } : {}),
      };
      type ReviewIssueOfUnit = Awaited<ReturnType<typeof services.reviewer.reviewUnit>>["issues"][number];
      let results: Awaited<ReturnType<typeof services.reviewer.reviewAll>>;
      let unitScoreBasis: AcademicScoreBasis | undefined;
      if (longDocumentMode) {
        /**
         * M14.1a P0-2 长文档模式：每个 Review Unit 一次有界全文审查（单元 ≤
         * unitMaxChars，永不截断；整篇从不重复发送给任何 Reviewer），per-unit
         * journal 落盘 reviews/review-units/r{round}/，同 fingerprint 完成单元在
         * stage retry / 进程重启后零模型调用复用（SectionReviewScheduler 同款
         * 语义）。单元失败重试 2 次后如实记 failed → 覆盖率下降 → Gate 不允许
         * 冒充全文 PASS。分数 = 各单元 academicScore / riskScore 的字符加权聚合
         * （确定性、可追溯），不再用部分 digest 视图冒充全文评分。
         */
        const journal = await services.reviewArtifacts.loadReviewUnitRecords(ctx.projectId, round);
        const journalByUnitId = new Map(journal.filter((record) => record.status === "completed").map((record) => [record.unitId, record]));
        const spanByUnitId = new Map<string, RevisionSpan>();
        for (const file of coverageSourceFiles) {
          for (const span of locateFileSpans(file.relativePath, file.content)) {
            for (const unit of partitionSpanIntoUnits(span, unitMaxChars).units) {
              spanByUnitId.set(`${file.relativePath}::${unit.logicalSection}`, unit);
            }
          }
        }
        const chapterIndex = [...new Set(coveragePlan.units.map((unit) => `${unit.heading}（${unit.file}）`))];
        /**
         * M14.9.5.1 单元上下文策略。shared_session（缺省）= 历史行为：全部单元共用一个审稿会话，prompt 与会话派生不变。
         * 隔离策略：每次尝试一个全新封闭会话（sealed 工具，prompt 即完整上下文）；isolated_snapshot 另附确定性解析的
         * 跨单元依赖（review/reviewContextSnapshot.ts）。快照只由冻结稿件与审稿政策决定，与调度顺序 / 并发 / 超时
         * 重建 / 进程恢复无关；物理会话标签不进入任何哈希。
         */
        const contextPolicy: ReviewUnitContextPolicy = services.review.unitContextPolicy ?? "shared_session";
        const isolatedContext = contextPolicy !== "shared_session";
        const dependencyBudget = services.review.unitDependencyBudgetChars ?? DEFAULT_UNIT_DEPENDENCY_BUDGET_CHARS;
        const sourceVerification: SourceVerification = !isolatedContext
          ? "AUTHOR_SOURCE"
          : publishedAssessment
            ? publishedSourceVerification(await loadPublishedInputFidelity(services, ctx.projectId))
            : "AUTHOR_SOURCE";
        const dependencyIndex = isolatedContext
          ? indexDependencyTargets(
              coveragePlan.units.map((unit) => ({ unitId: unit.unitId, file: unit.file, heading: unit.heading, text: spanByUnitId.get(unit.unitId)?.content ?? "" })),
              { documentOrderProven: coverageSourceFiles.length === 1 },
            )
          : null;
        // 只读口径的三轴 rubric 以「摘要所述核心结论」定义 blocking：隔离单元附摘要锚点（作者稿件口径不注入）
        const rubricAnchor = dependencyIndex !== null && publishedAssessmentLines !== undefined
          ? locateAbstractAnchor(coveragePlan.units.map((unit) => ({ unitId: unit.unitId, file: unit.file, heading: unit.heading, text: spanByUnitId.get(unit.unitId)?.content ?? "" })))
          : undefined;
        const contextSnapshots = new Map<string, ReviewContextSnapshotRecord>();
        const cacheIncompatibleUnitIds: string[] = [];
        const dependencyInvalidated = new Map<string, string>();
        let referenceOnlyQuoteFindings = 0;
        const evidenceDigestLines = evidenceSelection.formal.slice(0, 15).map((record, index) =>
          `- [E${String(index + 1).padStart(3, "0")}] ${record.claim.slice(0, 140)}（${record.verificationStatus}）`);
        const unitAttempts = 3;
        /**
         * M14.8.1-MOT 增量复审：M14.8 真实返修只改了 3 节，复审却重跑全部 35 个单元
         * （unit journal 只在同轮复用）。跨轮复用的条件同时满足才成立：
         *   ① 请求指纹相同（完整 prompt：单元原文 + 章节索引 + 证据 / 引用摘要 + 实验口径 +
         *      语言；+ 实际模型 + Skill 版本——任一输入变化即失效）；
         *   ② 单元未改动，且不被依赖失效（汇总型章节在正文有改动时恒重审；引用改动单元
         *      \label 的单元重审，见 planIncrementalInvalidation）。
         * 跨章一致性审查恒为新执行；Runtime 无法证明模型一致时不复用（等价全量审）。
         */
        const incrementalEnabled = services.review.incrementalUnitReuse !== false;
        let baselineRound: number | null = null;
        let baselineRecords: ReviewUnitRecord[] = [];
        const priorByFingerprint = new Map<string, ReviewUnitRecord>();
        if (incrementalEnabled) {
          for (let prior = round - 1; prior >= Math.max(1, round - 4); prior -= 1) {
            const records = (await services.reviewArtifacts.loadReviewUnitRecords(ctx.projectId, prior))
              .filter((record) => record.status === "completed");
            if (records.length === 0) continue;
            if (baselineRound === null) {
              baselineRound = prior;
              baselineRecords = records;
            }
            for (const record of records) {
              if (record.requestFingerprint !== undefined && record.outcome !== undefined && !priorByFingerprint.has(record.requestFingerprint)) {
                priorByFingerprint.set(record.requestFingerprint, record);
              }
            }
          }
        }
        const invalidation = planIncrementalInvalidation({
          units: coveragePlan.units.map((unit) => ({
            unitId: unit.unitId, spanId: unit.spanId, heading: unit.heading, contentHash: unit.contentHash,
            text: spanByUnitId.get(unit.unitId)?.content ?? "",
          })),
          baselineHashes: baselineRound === null ? null : new Map(baselineRecords.map((record) => [record.unitId, record.unitFingerprint])),
        });
        const baselineUnitIds = new Set(baselineRecords.map((record) => record.unitId));
        const dispositions = new Map<string, { disposition: IncrementalUnitDisposition; sourceRound?: number }>();
        let fingerprintUnavailable = false;
        const outcomes = await mapWithConcurrency(
          coveragePlan.units,
          services.review.reviewConcurrency,
          async (unit: ReviewUnitPlanEntry) => {
            const unitSpan = spanByUnitId.get(unit.unitId);
            if (unitSpan === undefined) {
              throw new BusinessError("STAGE_CONTRACT_VIOLATION", `REVIEW_UNIT_UNRESOLVED: ${unit.unitId}`);
            }
            // M14.9.5.1：隔离策略的冻结上下文（纯函数；与执行顺序无关）
            let unitContext: Omit<UnitReviewContext, "sessionLabel"> | undefined;
            let contextSnapshot: ReviewContextSnapshotRecord | undefined;
            if (dependencyIndex !== null && contextPolicy !== "shared_session") {
              const resolution = resolveUnitDependencies({
                unitId: unit.unitId, text: unitSpan.content, index: dependencyIndex, budgetChars: dependencyBudget,
                attach: contextPolicy === "isolated_snapshot",
                ...(rubricAnchor !== undefined ? { rubricAnchor } : {}),
              });
              contextSnapshot = buildContextSnapshotRecord({
                policy: contextPolicy, unitId: unit.unitId, text: unitSpan.content, resolution, sourceVerification, budgetChars: dependencyBudget,
              });
              unitContext = {
                policy: contextPolicy, dependencies: resolution.attached, gaps: resolution.gaps, sourceVerification,
                dependencyFingerprint: contextSnapshot.dependencyFingerprint,
              };
            }
            const unitParams = {
              projectId: ctx.projectId,
              unit: {
                unitId: unit.unitId, file: unit.file, heading: unit.heading,
                unitIndex: unit.unitIndex, unitCount: unit.unitCount, text: unitSpan.content,
              },
              ...(project.title !== "" ? { paperTitle: project.title } : {}),
              chapterIndex,
              ...(evidenceDigestLines.length > 0 ? { evidenceDigest: evidenceDigestLines } : {}),
              ...(citationDigest !== undefined ? { citationDigest } : {}),
              ...(experimentPolicyLines !== undefined ? { experimentPolicyLines } : {}),
              ...(language !== undefined ? { language } : {}),
              ...(services.review.neutralityPolicy === true ? { neutralityPolicy: true } : {}),
              ...(publishedAssessmentLines !== undefined ? { publishedAssessmentLines } : {}),
              ...(unitContext !== undefined ? { unitContext: { ...unitContext, sessionLabel: "" } } : {}),
              signal: ctx.signal,
            };
            const unitInput = unitContext !== undefined && !isHeadingOnlyUnit(unitSpan.content)
              ? await services.reviewer.describeUnitInput?.(unitParams)
              : undefined;
            if (contextSnapshot !== undefined && unitInput !== undefined) {
              contextSnapshot.promptSha256 = unitInput.promptSha256;
              contextSnapshot.contextSnapshotHash = unitInput.contextSnapshotHash;
              contextSnapshots.set(unit.unitId, contextSnapshot);
            }
            const reused = journalByUnitId.get(unit.unitId);
            // M14.9.5.1：同轮 journal 复用还要求上下文策略相同；隔离策略另要求快照哈希一致（旧共享会话记录 /
            // 不同依赖集合的记录不可互为缓存：CACHE_INCOMPATIBLE → 重新审查）
            const journalCompatible = reused !== undefined && (
              reused.taskId === "(heading-only)" ||
              ((reused.contextPolicy ?? "shared_session") === contextPolicy &&
                (!isolatedContext || (reused.contextSnapshot?.contextSnapshotHash !== undefined && reused.contextSnapshot.contextSnapshotHash === contextSnapshot?.contextSnapshotHash)))
            );
            if (
              reused !== undefined && reused.snapshotId === coveragePlan.snapshotId &&
              reused.unitFingerprint === unit.contentHash && !journalCompatible
            ) {
              cacheIncompatibleUnitIds.push(unit.unitId);
            }
            if (
              reused !== undefined && reused.snapshotId === coveragePlan.snapshotId &&
              reused.unitFingerprint === unit.contentHash && journalCompatible
            ) {
              // 复用 = 同 snapshot 同单元内容的既往成功审查：issues / 分数随
              // outcome 完整恢复（journal 复用绝不丢 finding）
              const restored = reused.outcome === undefined ? null : {
                issues: reused.outcome.issues as unknown as ReviewIssueOfUnit[],
                academicScore: reused.outcome.academicScore,
                riskScore: reused.outcome.riskScore,
                summary: reused.outcome.summary,
                taskId: reused.taskId ?? "(reused)",
              };
              // M14.8.1-MOT：同轮 journal 恢复（stage 重试 / 进程重启）沿用记录里的原处置，
              // 增量账本不把本轮新执行的单元误记为跨轮缓存
              dispositions.set(unit.unitId, reused.disposition !== undefined
                ? { disposition: reused.disposition, ...(reused.reusedFrom !== undefined ? { sourceRound: reused.reusedFrom.round } : {}) }
                : reused.reusedFrom !== undefined
                  ? { disposition: "cached", sourceRound: reused.reusedFrom.round }
                  : { disposition: reused.taskId === "(heading-only)" ? "heading_only" : "fresh_no_valid_cache" });
              return { unit, record: reused, review: restored, reused: true };
            }
            if (ctx.signal.aborted) {
              throw new BusinessError("WORKFLOW_CANCELLED", "审稿已被取消");
            }
            // M14.8-MOT：仅含章节命令 / \label 的单元（父章节标题紧跟子章节）没有可审正文——
            // 不调用模型（真实论文 41 个单元中 7 个是这种标题单元，每轮白耗 7 次调用）；
            // 记为已完成、零 finding、分数 null（不参与字符加权聚合），覆盖率如实计入。
            if (isHeadingOnlyUnit(unitSpan.content)) {
              dispositions.set(unit.unitId, { disposition: "heading_only" });
              const summaryText = "仅章节标题，无正文（未调用模型）";
              const record = {
                unitId: unit.unitId, round, snapshotId: coveragePlan.snapshotId, unitFingerprint: unit.contentHash,
                status: "completed" as const, taskId: "(heading-only)", issueCount: 0,
                attempts: 0, updatedAt: new Date().toISOString(), disposition: "heading_only" as const,
                outcome: { issues: [], academicScore: null, riskScore: null, summary: summaryText },
              };
              await services.reviewArtifacts.saveReviewUnitRecord(ctx.projectId, record);
              return { unit, record, review: { issues: [] as ReviewIssueOfUnit[], academicScore: null, riskScore: null, summary: summaryText, taskId: "(heading-only)" }, reused: false };
            }
            const requestFingerprint = incrementalEnabled
              ? (unitContext !== undefined
                  ? (unitInput?.requestFingerprint ?? null)
                  : ((await services.reviewer.unitRequestFingerprint?.(unitParams)) ?? null))
              : null;
            if (incrementalEnabled && requestFingerprint === null) fingerprintUnavailable = true;
            const invalidationReason = invalidation.invalidated.get(unit.unitId);
            const cachedSource = requestFingerprint !== null ? priorByFingerprint.get(requestFingerprint) : undefined;
            // M14.9.5.1：单元原文未改、但其跨单元依赖（被引表 / 图 / 公式原文或缺口）与基准轮不同 → 依赖失效重审
            const baselineDependencyFingerprint = baselineRecords.find((record) => record.unitId === unit.unitId)?.contextSnapshot?.dependencyFingerprint;
            const dependencyChanged = contextSnapshot !== undefined && baselineDependencyFingerprint !== undefined &&
              baselineDependencyFingerprint !== contextSnapshot.dependencyFingerprint;
            if (invalidation.changed.has(unit.unitId)) {
              dispositions.set(unit.unitId, { disposition: baselineRound !== null && !baselineUnitIds.has(unit.unitId) ? "fresh_new" : "fresh_changed" });
            } else if (invalidationReason !== undefined) {
              dispositions.set(unit.unitId, { disposition: "fresh_invalidated" });
            } else if (dependencyChanged) {
              dependencyInvalidated.set(unit.unitId, `dependency_changed（跨单元依赖指纹 ${baselineDependencyFingerprint!.slice(0, 12)} → ${contextSnapshot!.dependencyFingerprint.slice(0, 12)}）`);
              dispositions.set(unit.unitId, { disposition: "fresh_invalidated" });
            } else if (cachedSource !== undefined && cachedSource.outcome !== undefined && cachedSource.unitFingerprint === unit.contentHash) {
              // 合法缓存：同一审稿请求的既往完成审查（issues / 分数完整恢复；来源可追溯）
              const record: ReviewUnitRecord = {
                unitId: unit.unitId, round, snapshotId: coveragePlan.snapshotId, unitFingerprint: unit.contentHash,
                status: "completed", ...(cachedSource.taskId !== undefined ? { taskId: cachedSource.taskId } : {}),
                issueCount: cachedSource.outcome.issues.length, attempts: 0, updatedAt: new Date().toISOString(),
                outcome: cachedSource.outcome, requestFingerprint: requestFingerprint!,
                reusedFrom: { round: cachedSource.round, updatedAt: cachedSource.updatedAt, ...(cachedSource.taskId !== undefined ? { taskId: cachedSource.taskId } : {}) },
                disposition: "cached",
                ...(contextSnapshot !== undefined
                  ? { contextPolicy, contextSnapshot: { ...contextSnapshot, ...(cachedSource.contextSnapshot?.referenceOnlyQuoteIssueIndices !== undefined ? { referenceOnlyQuoteIssueIndices: cachedSource.contextSnapshot.referenceOnlyQuoteIssueIndices } : {}) }, attemptTrace: [] }
                  : {}),
              };
              await services.reviewArtifacts.saveReviewUnitRecord(ctx.projectId, record);
              dispositions.set(unit.unitId, { disposition: "cached", sourceRound: cachedSource.round });
              return {
                unit, record, reused: true,
                review: {
                  issues: cachedSource.outcome.issues as unknown as ReviewIssueOfUnit[],
                  academicScore: cachedSource.outcome.academicScore, riskScore: cachedSource.outcome.riskScore,
                  summary: cachedSource.outcome.summary, taskId: cachedSource.taskId ?? "(cached)",
                },
              };
            } else {
              dispositions.set(unit.unitId, { disposition: "fresh_no_valid_cache" });
            }
            let lastError: unknown;
            const attemptTrace: ReviewUnitAttemptTrace[] = [];
            const contextFields = contextSnapshot !== undefined ? { contextPolicy, contextSnapshot, attemptTrace } : {};
            for (let attempt = 1; attempt <= unitAttempts; attempt += 1) {
              // M14.9.5.1：隔离策略每次尝试一个全新物理会话（标签含随机段：同轮 stage 重试 / 恢复也不会命中残留会话）；
              // 规范化 prompt 与依赖集合由冻结快照决定，各次尝试逐字节一致（trace 可核对）
              const sessionLabel = unitContext !== undefined
                ? `${(contextSnapshot?.contextSnapshotHash ?? unit.contentHash).slice(0, 12)}-r${round}-a${attempt}-${randomUUID().slice(0, 8)}`
                : undefined;
              const startedAt = new Date();
              try {
                const review = await services.reviewer.reviewUnit(unitContext !== undefined
                  ? { ...unitParams, unitContext: { ...unitContext, sessionLabel: sessionLabel! } }
                  : unitParams);
                if (contextSnapshot !== undefined) {
                  attemptTrace.push({
                    attempt, sessionKey: review.sessionKey ?? sessionLabel!, promptSha256: review.promptSha256 ?? "", contextSnapshotHash: contextSnapshot.contextSnapshotHash ?? "",
                    status: "completed", taskId: review.taskId, ...(review.model !== undefined ? { model: review.model } : {}),
                    ...(review.usage !== undefined ? { usage: review.usage } : {}), startedAt: startedAt.toISOString(), ms: Date.now() - startedAt.getTime(),
                  });
                  const referenceOnly = referenceOnlyQuoteIndices(unitSpan.content, (unitContext?.dependencies ?? []).map((dep) => dep.text), review.issues);
                  if (referenceOnly.length > 0) contextSnapshot.referenceOnlyQuoteIssueIndices = referenceOnly;
                }
                const record = {
                  unitId: unit.unitId, round, snapshotId: coveragePlan.snapshotId, unitFingerprint: unit.contentHash,
                  status: "completed" as const, taskId: review.taskId, issueCount: review.issues.length,
                  attempts: attempt, updatedAt: new Date().toISOString(),
                  outcome: {
                    issues: review.issues as unknown as Array<Record<string, unknown>>,
                    academicScore: review.academicScore, riskScore: review.riskScore, summary: review.summary,
                  },
                  ...(requestFingerprint !== null ? { requestFingerprint } : {}),
                  ...(dispositions.get(unit.unitId) !== undefined ? { disposition: dispositions.get(unit.unitId)!.disposition } : {}),
                  ...contextFields,
                };
                await services.reviewArtifacts.saveReviewUnitRecord(ctx.projectId, record);
                return { unit, record, review, reused: false };
              } catch (error) {
                lastError = error;
                if (contextSnapshot !== undefined) {
                  attemptTrace.push({
                    attempt, sessionKey: services.reviewer.unitSessionKey?.(ctx.projectId, sessionLabel!) ?? sessionLabel!,
                    promptSha256: contextSnapshot.promptSha256 ?? "", contextSnapshotHash: contextSnapshot.contextSnapshotHash ?? "",
                    status: "failed", error: (error instanceof Error ? error.message : String(error)).slice(0, 300),
                    startedAt: startedAt.toISOString(), ms: Date.now() - startedAt.getTime(),
                  });
                }
                if (ctx.signal.aborted && !(error instanceof BusinessError)) {
                  throw error;
                }
              }
            }
            const record = {
              unitId: unit.unitId, round, snapshotId: coveragePlan.snapshotId, unitFingerprint: unit.contentHash,
              status: "failed" as const,
              error: lastError instanceof Error ? lastError.message.slice(0, 300) : String(lastError).slice(0, 300),
              attempts: unitAttempts, updatedAt: new Date().toISOString(),
              ...contextFields,
            };
            await services.reviewArtifacts.saveReviewUnitRecord(ctx.projectId, record);
            dispositions.set(unit.unitId, { disposition: "failed" });
            return { unit, record, review: null, reused: false };
          },
          { signal: ctx.signal },
        );
        const failedOutcome = outcomes.find((outcome) => !outcome.ok);
        if (failedOutcome !== undefined) {
          throw failedOutcome.error;
        }
        const settled = outcomes.map((outcome) => (outcome.ok ? outcome.value : null));
        const completedUnits = settled.filter((entry): entry is NonNullable<typeof entry> => entry !== null && entry.record.status === "completed");
        const allRecords = [...journal, ...settled.flatMap((entry) => (entry !== null ? [entry.record] : []))];
        if (completedUnits.length === 0 && coveragePlan.units.length > 0) {
          throw new BusinessError("STAGE_CONTRACT_VIOLATION", "REVIEW_UNITS_ALL_FAILED");
        }
        // 跨章一致性（单次有界调用；失败如实降级为本轮无跨章 finding，不影响正文覆盖率）
        let crossChapterIssues: Awaited<ReturnType<typeof services.reviewer.reviewCrossChapter>>["issues"] = [];
        const chapterDigests = [...new Map(coveragePlan.units.map((unit) => {
          const span = spanByUnitId.get(unit.unitId);
          return [unit.spanId, { heading: unit.heading, file: unit.file, digest: span === undefined ? "" : sliceForDigest(span.content, 1200) }];
        })).values()];
        let crossChapterTrace: NonNullable<ReviewCoverageSummary["context"]>["crossChapter"] = { status: "skipped" };
        if (chapterDigests.length >= 2) {
          try {
            const cross = await services.reviewer.reviewCrossChapter({
              projectId: ctx.projectId, chapters: [...chapterDigests],
              ...(experimentPolicyLines !== undefined ? { experimentPolicyLines } : {}),
              ...(services.review.neutralityPolicy === true ? { neutralityPolicy: true } : {}),
              ...(publishedAssessmentLines !== undefined ? { publishedAssessmentLines } : {}),
              ...(isolatedContext ? { isolation: { sessionLabel: `r${round}-${randomUUID().slice(0, 8)}` } } : {}),
              ...(language !== undefined ? { language } : {}), signal: ctx.signal,
            });
            crossChapterIssues = cross.issues;
            crossChapterTrace = { status: "completed", ...(cross.sessionKey !== undefined ? { sessionKey: cross.sessionKey } : {}), ...(cross.promptSha256 !== undefined ? { promptSha256: cross.promptSha256 } : {}) };
          } catch (error) {
            if (ctx.signal.aborted) throw error;
            crossChapterTrace = { status: "failed" };
            ctx.log(`[review] 跨章一致性审查失败（降级为本轮无跨章 finding；正文覆盖不受影响）：${error instanceof Error ? error.message.slice(0, 200) : String(error)}`);
          }
        }
        coverageSummary = computeReviewCoverage(coveragePlan, round, allRecords, "units");
        // 复用计数以本轮实际命中 journal 的单元为准（computeReviewCoverage 的
        // 跨轮口径无法识别同轮 stage 重启——journal 记录 round 相同）
        coverageSummary.reusedUnits = settled.filter((entry) => entry?.reused === true).length;
        // M14.8.1-MOT：增量复审账本——Fresh / 合法缓存（来源轮次）/ 依赖失效重审 / 未审 分开记录；
        // 100% coverage 不等于 100% 本轮重新调用模型
        {
          const entries = coveragePlan.units.map((unit) => ({ unitId: unit.unitId, ...(dispositions.get(unit.unitId) ?? { disposition: "cached" as const }) }));
          const ledger: IncrementalReviewLedger = {
            enabled: incrementalEnabled,
            baselineRound,
            changedUnitIds: [...invalidation.changed].filter(() => baselineRound !== null),
            removedUnitIds: invalidation.removed,
            invalidated: [...invalidation.invalidated.entries(), ...dependencyInvalidated.entries()].map(([unitId, reason]) => ({ unitId, reason })),
            dispositions: entries,
            freshUnits: entries.filter((entry) => entry.disposition.startsWith("fresh_")).length,
            cachedUnits: entries.filter((entry) => entry.disposition === "cached").length,
            invalidatedUnits: entries.filter((entry) => entry.disposition === "fresh_invalidated").length,
            crossChapterFresh: chapterDigests.length >= 2,
            ...(fingerprintUnavailable ? { note: "runtime 无法证明审稿模型 / Skill 一致：跨轮缓存未启用（等价全量审）" } : {}),
          };
          coverageSummary.incremental = ledger;
          ctx.log(`[review] 增量复审：基准轮 r${baselineRound ?? "-"}，改动 ${ledger.changedUnitIds.length}、依赖失效 ${ledger.invalidatedUnits}、新执行 ${ledger.freshUnits}、合法缓存 ${ledger.cachedUnits}`);
        }
        // M14.9.5.1：单元上下文汇总（依赖缺口如实呈现；依赖原文不计入覆盖率字符）
        if (isolatedContext) {
          const completedSnapshots = completedUnits
            .map((entry) => (entry.record as ReviewUnitRecord).contextSnapshot ?? contextSnapshots.get(entry.unit.unitId))
            .filter((snapshot): snapshot is ReviewContextSnapshotRecord => snapshot !== undefined);
          referenceOnlyQuoteFindings = completedSnapshots.reduce((sum, snapshot) => sum + (snapshot.referenceOnlyQuoteIssueIndices?.length ?? 0), 0);
          coverageSummary.context = {
            policy: contextPolicy,
            sourceVerification,
            dependencyBudgetChars: dependencyBudget,
            unitsWithDependencies: completedSnapshots.filter((snapshot) => snapshot.dependencies.length > 0).length,
            attachedDependencies: completedSnapshots.reduce((sum, snapshot) => sum + snapshot.dependencies.length, 0),
            dependencyChars: completedSnapshots.reduce((sum, snapshot) => sum + snapshot.dependencyChars, 0),
            contextIncompleteUnits: [...contextSnapshots.values()].filter((snapshot) => !snapshot.contextComplete).map((snapshot) => ({
              unitId: snapshot.unitId,
              gaps: snapshot.gaps.map((gap) => ({ mention: gap.mention, status: gap.status, reason: gap.reason })),
            })),
            referenceOnlyQuoteFindings,
            cacheIncompatibleUnitIds,
            crossChapter: crossChapterTrace,
          };
          ctx.log(`[review] 单元上下文：策略 ${contextPolicy}，附依赖 ${coverageSummary.context.attachedDependencies} 项（${coverageSummary.context.dependencyChars} 字），依赖缺口单元 ${coverageSummary.context.contextIncompleteUnits.length}，CACHE_INCOMPATIBLE ${cacheIncompatibleUnitIds.length}`);
        }
        // 确定性加权聚合：academicScore / styleRisk = 全部完成单元（本次执行 +
        // journal 复用，二者 review 等价）分数的字符加权平均
        let scoreWeight = 0;
        let academicSum = 0;
        let riskSum = 0;
        // M14.1b P1：单元 finding 携带 file + 章节 span id（模型不产出；review.run 确定性附加），
        // revision.plan 据此把 finding 投影为唯一 targetQuote
        const unitIssues = completedUnits.flatMap((entry) =>
          (entry.review?.issues ?? []).map((issue) => ({ ...issue, file: entry.unit.file, logicalSection: entry.unit.spanId })));
        for (const entry of completedUnits) {
          const review = entry.review;
          if (review === null) continue;
          if (review.academicScore !== null) { scoreWeight += entry.unit.chars; academicSum += review.academicScore * entry.unit.chars; }
          if (review.riskScore !== null) { riskSum += review.riskScore * entry.unit.chars; }
        }
        const academicScore = scoreWeight === 0 ? null : Math.round(academicSum / scoreWeight);
        const riskScore = scoreWeight === 0 ? null : Math.round(riskSum / scoreWeight);
        // M14.9.5：分数口径透明——有正文的完成单元中模型未给合法分数的，不参与加权（分数只覆盖其余正文）
        {
          const bodyUnits = completedUnits.filter((entry) => entry.review !== null && entry.record.taskId !== "(heading-only)");
          const scored = bodyUnits.filter((entry) => entry.review!.academicScore !== null);
          unitScoreBasis = {
            mode: "units_char_weighted",
            scoredUnits: scored.length,
            reviewedUnits: bodyUnits.length,
            scoredChars: scored.reduce((sum, entry) => sum + entry.unit.chars, 0),
            reviewedChars: bodyUnits.reduce((sum, entry) => sum + entry.unit.chars, 0),
            unscoredUnitIds: bodyUnits.filter((entry) => entry.review!.academicScore === null).map((entry) => entry.unit.unitId),
            ...(coverageSummary.context !== undefined
              ? { contextIncompleteUnitIds: coverageSummary.context.contextIncompleteUnits.map((entry) => entry.unitId) }
              : {}),
            calibration: "UNVALIDATED",
          };
        }
        const freshCount = completedUnits.filter((entry) => !entry.reused).length;
        results = [
          { mode: "fact", taskId: `(units:${completedUnits.length}/${coveragePlan.units.length})`, issues: unitIssues, summary: `长文档单元审查：${completedUnits.length}/${coveragePlan.units.length} 单元完成（复用 ${coverageSummary.reusedUnits}，失败 ${coverageSummary.failedUnits}）` },
          {
            mode: "academic", taskId: "(units)", issues: crossChapterIssues,
            ...(academicScore !== null ? { overallScore: academicScore } : {}),
            summary: `单元分数字符加权聚合（${freshCount} 新执行 + ${coverageSummary.reusedUnits} 复用；coverage ${(coverageSummary.ratio * 100).toFixed(1)}%）`,
          },
          {
            mode: "style", taskId: "(units)", issues: [],
            ...(riskScore !== null ? { riskScore } : {}),
            summary: `单元风险字符加权聚合（${freshCount} 新执行 + ${coverageSummary.reusedUnits} 复用）`,
          },
        ];
        ctx.log(
          `[review] 长文档单元模式：units=${completedUnits.length}/${coveragePlan.units.length}（复用 ${coverageSummary.reusedUnits}，失败 ${coverageSummary.failedUnits}），coverage=${(coverageSummary.ratio * 100).toFixed(1)}%，跨章 finding=${crossChapterIssues.length}`,
        );
      } else {
        results = await services.reviewer.reviewAll(reviewParams);
        coverageSummary = {
          mode: "digest", snapshotId: coveragePlan.snapshotId, round,
          targetUnits: coveragePlan.units.length, completedUnits: coveragePlan.units.length,
          failedUnits: 0, reusedUnits: 0,
          targetChars: coveragePlan.targetChars, reviewedChars: coveragePlan.targetChars,
          ratio: 1, complete: true, failedUnitIds: [],
        };
      }

      // M13 Final Closure（任务 B）：academicScore 带内复核——主样本分数落在阈值对称带内时
      // 追加有界独立采样（≤ 2 份）取中位数；事实类 critical/major 并入、意见类须跨样本重现。
      // 不触及 Gate 阈值 / 规则集与双层终态判定（见 review/academicConfirmation.ts）。
      const confirmationPolicy = {
        band: services.review.academicConfirmationBand ?? 0,
        extraSamples: Math.min(services.review.academicConfirmationSamples ?? 0, ACADEMIC_CONFIRMATION_SAMPLES_MAX),
        threshold: services.review.academicPassScore,
      };
      let academicConfirmation: AcademicScoreConfirmation | undefined;
      const primaryAcademic = results.find((result) => result.mode === "academic");
      if (!longDocumentMode && primaryAcademic !== undefined && shouldConfirmAcademicScore(primaryAcademic.overallScore, confirmationPolicy)) {
        const extras: ModeReviewResult[] = [];
        for (let index = 0; index < confirmationPolicy.extraSamples; index += 1) {
          if (ctx.signal.aborted) {
            break;
          }
          const extra = await services.reviewer.reviewMode({ ...reviewParams, mode: "academic" });
          extras.push(extra);
        }
        const aggregated = aggregateAcademicSamples({ primary: primaryAcademic, extras, policy: confirmationPolicy });
        academicConfirmation = aggregated.confirmation;
        results.splice(results.indexOf(primaryAcademic), 1, aggregated.result);
        ctx.log(
          `[review] academic 带内复核：主样本 ${aggregated.confirmation.primaryScore} ∈ [${confirmationPolicy.threshold - confirmationPolicy.band}, ${confirmationPolicy.threshold + confirmationPolicy.band})，额外 ${extras.length} 份 → 样本 ${aggregated.confirmation.samples.map((sample) => sample.overallScore ?? "null").join("/")}，中位数 ${aggregated.confirmation.aggregatedScore}；并入事实类 ${aggregated.confirmation.mergedIssues.factClass} / 重现意见类 ${aggregated.confirmation.mergedIssues.opinionClassReproduced} / 丢弃单样本意见类 ${aggregated.confirmation.mergedIssues.opinionClassDropped}`,
        );
      }

      // 轮次在审查执行前已确定（M14.1a：单元 journal 以 round 为目录，stage
      // retry / 进程恢复必须落同一轮；编号仍来自磁盘既有汇总，跨 run 递增）
      const reportPaths: string[] = [];
      for (const result of results) {
        reportPaths.push(await services.reviewer.saveReport(ctx.projectId, round, result));
      }
      if (academicConfirmation !== undefined) {
        for (const [index, sample] of academicConfirmation.samples.entries()) {
          if (index === 0) {
            continue; // 主样本已随 review-r{round}-academic.json（聚合后）落盘
          }
          await services.reviewArtifacts.saveAcademicConfirmationSample(ctx.projectId, round, index, sample);
        }
      }
      const summary = aggregateReviews(results, round, reportPaths);
      summary.reviewedRevision = revision;
      summary.coverage = coverageSummary;
      {
        const academicResult = results.find((result) => result.mode === "academic");
        summary.academicScoreBasis = unitScoreBasis ?? {
          mode: academicConfirmation?.triggered === true ? "digest_confirmation_median" : "digest_overall",
          dimensions: Object.keys(academicResult?.scores ?? {}),
          calibration: "UNVALIDATED",
        };
      }
      await services.reviewArtifacts.saveReviewCoverage(ctx.projectId, round, coverageSummary);
      if (academicConfirmation !== undefined) {
        summary.academicConfirmation = academicConfirmation;
      }
      // M9.7.6 Claim Grounding：fact claims 的确定性证据绑定整理（复用 verdict，
      // 无新 LLM 判定）。citation key 解析与 Writer 引用 / coverage gate 同源。
      // M11.2.3：先于 summary 落盘计算——rootCauseKey 标注（D-2 根因口径）要
      // 写进聚合 issues，gate 规则 5/6 据此去重。
      const factClaims = results.find((result) => result.mode === "fact")?.claims ?? [];
      // M11.3（Phase B）：章节引用面投影 → 候选证据来源合法性（§10）
      const sectionCitedSourceIds = await projectOutlineCitedSourceIds(services, ctx.projectId);
      // Round 2：作者授权进入工作流的实验观测值——数值全部被覆盖的 UNSUPPORTED claim
      // 披露为 author_experiment_data（Writer / Revision 据同一表写数值，Reviewer 没有
      // 外部文献可核；不计入凭空断言阻断，也不派发「数值删除」修订）
      const authorizedObservations = isSurveyKind(ctx.state.workflowKind)
        ? []
        : [
            // M14.8-MOT：existing-paper 用「稿件正文数值命中的全部授权观测」（确定性披露，
            // 不进 prompt，不受 100 条上下文预算限制）；其余工作流沿用上下文选择
            ...(options.existingPaper === true
              ? await services.experimentPackages.manuscriptMatchedObservations(
                ctx.projectId,
                latexForAttribution.allTex.map((file) => file.content).join("\n"),
              )
              : (await services.experimentPackages.workflowContext(ctx.projectId)).observations).map((observation) => ({
              value: observation.value,
              metric: observation.metric,
              groupId: observation.groupId,
              ...(observation.split !== undefined ? { split: observation.split } : {}),
            })),
            // M14.6（F5）：作者已确认的研究输入事实与实验包观测同一消费口径——数值全部命中的
            // UNSUPPORTED claim 披露为 author_experiment_data（不铸「数值只许删除」授权）
            ...researchFactsAsAuthorizedObservations(thesisConfirmedFacts),
          ];
      const claimGrounding = computeClaimGroundingReport({
        projectId: ctx.projectId,
        round,
        factClaims,
        formalEvidence: evidence,
        bibEntries: citationReport?.static.bibEntries ?? [],
        ...(Object.keys(sectionCitedSourceIds).length > 0 ? { sectionCitedSourceIds } : {}),
        ...(authorizedObservations.length > 0 ? { authorizedObservations } : {}),
      });
      // M11.4 Reliability Closure：claimIndex creator-side lineage → rootCauseKey
      //（存在性 + 弱佐证校验；audit 归因与任务层归层消费同一 id）。先于
      // claimGapAudit 执行——audit 的直接 id join 依赖该回填。
      summary.issues = resolveClaimIndexLinks(summary.issues, factClaims);
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
      /**
       * M14.6（F5）：Finding ↔ 作者已确认研究输入事实的确定性反证。reviewer 以「无实验数据 /
       * 未授权 / 仅见于外部来源」为由要求删除或弱化的数值若全部是已确认事实（M14.5 案例 B
       * 的 75.37%），该 finding 不成立：移出 issues（不计阻断、不进修订计划、不铸弱化授权），
       * 保留在 disconfirmedIssues 透明展示。不在事实表中的数值永不反证。
       */
      if (thesisConfirmedFacts.length > 0) {
        const factDisconfirmed = disconfirmFactFindingsAgainstResearchFacts(summary.issues, thesisConfirmedFacts);
        if (factDisconfirmed.disconfirmedCount > 0) {
          const flagged = new Set(summary.issues.filter((issue) => factDisconfirmed.isDisconfirmed(issue)));
          summary.disconfirmedIssues = [
            ...(summary.disconfirmedIssues ?? []),
            ...[...flagged].map((issue) => ({ ...issue, deterministicDisconfirmed: true, disconfirmReason: factDisconfirmed.reasonFor(issue) })),
          ];
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
          summary.researchFactDisconfirmed = factDisconfirmed.disconfirmed.map((entry) => ({
            section: entry.issue.section,
            description: entry.issue.description.slice(0, 200),
            matchedFacts: entry.matchedFacts,
            reason: entry.reason,
          }));
          ctx.log(
            `[review] 反证 ${factDisconfirmed.disconfirmedCount} 条事实 finding（要求删除 / 弱化的数值全部为作者已确认研究输入事实：${factDisconfirmed.disconfirmed.map((entry) => entry.matchedFacts.map((fact) => fact.surface).join("/")).join("；")}）`,
          );
        }
      }
      /**
       * M14.6：模板化表达（「本章首先……其次……最后」「通过上述分析可以看出」等）的确定性扫描 →
       * minor style finding（D-0026：minor 只记录不自动修订；进入 UI / 报告 / 后续 style_polish 视图）。
       * 不触碰数值 / 事实；只对学位论文项目启用。
       */
      if (isThesisKind(ctx.state.workflowKind)) {
        const templated = scanTemplatedPhrasing(latexForAttribution.sections.map((section) => ({ file: section.relativePath, content: section.content })));
        for (const finding of templated.findings.slice(0, 12)) {
          summary.issues.push({
            category: "style",
            severity: "minor",
            section: finding.file,
            description: `模板化表达（${finding.kind}）：「${finding.excerpt.slice(0, 60)}」`,
            suggestedAction: `${finding.detail}；只调整表达，不得改动任何数值 / 事实 / 引用。`,
            reason: "确定性风格扫描（templatedPhrasing）——机械小结 / 公式化过渡降低学术表达质量",
            evidenceRequirement: "none",
            blocking: false,
            ...(finding.excerpt.length >= 12 ? { quote: finding.excerpt } : {}),
          });
          summary.counts.minor += 1;
        }
        if (templated.findings.length > 0) {
          ctx.log(`[review] 模板化表达 ${templated.findings.length} 处（记为 minor style finding，不自动修订）`);
        }
      }
      await services.reviewArtifacts.saveSummary(ctx.projectId, round, summary);
      await services.reviewArtifacts.saveClaimGrounding(ctx.projectId, claimGrounding);
      if (multiKeyAttribution.sentencesWithMultiKeyCite > 0) {
        await services.reviewArtifacts.saveMultiKeyAttribution(ctx.projectId, round, multiKeyAttribution);
      }
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
        ...(academicConfirmation !== undefined
          ? {
              academicConfirmation: {
                primaryScore: academicConfirmation.primaryScore,
                samples: academicConfirmation.samples.map((sample) => sample.overallScore),
                aggregatedScore: academicConfirmation.aggregatedScore,
                mergedIssues: academicConfirmation.mergedIssues,
              },
            }
          : {}),
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
        ...(multiKeyAttribution.sentencesWithMultiKeyCite > 0
          ? {
              multiKeyAttribution: {
                sentences: multiKeyAttribution.sentencesWithMultiKeyCite,
                checkable: multiKeyAttribution.checkable,
                findings: multiKeyAttribution.findings.length,
              },
            }
          : {}),
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
  options: { survey?: boolean; thesis?: boolean } = {},
): StageSpec {
  return {
    id: "quality.gate",
    description: "Quality Gate：确定性判定（引用/事实/审稿/目标可行性；survey 含写作契约；thesis 含零漂移/映射/结构/冲突）",
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
      // M14.2：thesis 规则输入（确定性：已确认事实零漂移 / 映射冻结 / 结构完整 / 冲突清零）
      let thesisGate: ThesisGateInput | undefined;
      if (options.thesis === true) {
        thesisGate = await computeThesisGateInput(services, ctx.projectId);
      }
      // M11.2.3（D-2）：同轮 claim grounding（披露口径拆分 + 根因去重的输入）
      const claimGrounding = await services.reviewArtifacts.loadClaimGrounding(ctx.projectId, review.round);
      // M12 A9：Target Readiness advisory（additive 透传；零规则参与、零阻断）
      const targetReadiness = await readTargetReadinessAdvisory(services, ctx.projectId);
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
          ...(targetReadiness !== undefined ? { targetReadiness } : {}),
          ...(thesisGate !== undefined ? { thesis: thesisGate } : {}),
        },
        QUALITY_THRESHOLDS(services),
      );
      const patchValidation = typeof review.reviewedRevision === "number"
        ? await services.reviewArtifacts.loadPatchValidation(ctx.projectId, review.reviewedRevision)
        : null;
      // M11.4 Product Closure：existing-paper 分层 gate（Revision Task Success vs
      // Publication Ready）。任务层成功时修订循环不再追逐投稿层（whole-paper /
      // 基线继承）问题；非 existing-paper（idea_to_paper / topic_survey）与
      // legacy 模式维持原 gate.passed 单层语义，零行为变化。
      const taskScoped =
        isExistingPaperKind(ctx.state.workflowKind) && services.review.revisionTaskPolicy.mode === "task_scoped";
      let revisionTask: RevisionTaskGateResult | null = null;
      let patchSubstanceOk: boolean | null = null;
      let modifiedSections: string[] = [];
      if (patchValidation !== null && typeof review.reviewedRevision === "number") {
        const finalPatchRecords = selectFinalPatchRecords(patchValidation.records);
        const sourceRevision = Math.max(0, review.reviewedRevision - 1);
        const previousTex = await readSnapshotTex(services.revisions.snapshotDir(ctx.projectId, sourceRevision));
        const currentTex = await readSnapshotTex(services.revisions.snapshotDir(ctx.projectId, review.reviewedRevision));
        const facts: FactFinding[] = factPreservation === null ? [] : [
          ...factPreservation.changedFacts, ...factPreservation.removedFacts, ...factPreservation.addedUnsupportedFacts,
          ...factPreservation.directionalChanges, ...factPreservation.formulaChanges, ...factPreservation.placeholderRegressions,
        ];
        const assignedFacts = new Set<FactFinding>();
        for (const record of finalPatchRecords) {
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
              patches: finalPatchRecords.flatMap((record) => {
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
        for (const record of finalPatchRecords) {
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
        patchValidation.summary = summarizePatchValidation(finalPatchRecords, [
          ...unattributed.map(() => "UNATTRIBUTED_FACT_VIOLATION"),
          ...unapportionedCitation.map((finding) => finding.code === "AMBIGUOUS_PATCH_ATTRIBUTION" ? finding.code : "UNATTRIBUTED_CITATION_VIOLATION"),
        ], [...patchValidation.records, ...(patchValidation.attemptHistory ?? [])]);
        // M11.4：patch 实质（patches 全过 + 无未归因违规 + 事实/引用保持 + 无
        // build error）先于级联捕获——分层语义下任务层与投稿层消费不同级联
        patchSubstanceOk = patchValidation.summary.publishable &&
          (factPreservation?.ok ?? false) && (citationPreservation?.ok ?? false) &&
          readBuildError(ctx.state) === undefined;
        // 本轮修订修改区间（finding 归层输入：logicalTarget + 对应 heading + 文件路径
        // ——finding.section 可能是任一命名空间：逻辑名 / 标题 / 相对文件路径）
        modifiedSections = finalPatchRecords.flatMap((record) => {
          const span = previousMain !== undefined
            ? locateLatexSections("main.tex", previousMain).find((candidate) => candidate.logicalSection === record.logicalTarget)
            : undefined;
          return [record.logicalTarget, record.file, ...(span !== undefined ? [span.heading] : [])];
        });
        if (!taskScoped) {
          // 旧级联（非 existing-paper / legacy）：与 gate.passed AND——呈现级重复，
          // 非独立失败源（M11.4 审计定性），行为保持不变
          patchValidation.summary.publishable = patchSubstanceOk && gate.passed;
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
      }
      // M11.4：existing-paper 任务层判定 + 投稿层合成（确定性，无 LLM）
      if (taskScoped) {
        const instructions = await services.externalInstructions.load(ctx.projectId);
        const instructionSnapshots: ExternalInstructionSnapshot[] = instructions.map((instruction) => ({
          instructionId: instruction.instructionId,
          status: instruction.status,
          authorDecision:
            instruction.status === "conflict" ||
            (instruction.statusNote ?? "").startsWith("AUTHOR_DECISION_REQUIRED"),
        }));
        // 冻结基线学术分 = 本轮之前最早的 review 汇总（r1 审阅 rev-1 基线）；
        // 无更早轮（首轮即被 gate）→ null（非回归检查不适用，如实记录）
        const summaries = await services.reviewArtifacts.listSummaries(ctx.projectId);
        const baselineSummary = summaries.find((summary) => summary.round < review.round);
        /**
         * M11.4 F23：与冻结基线逐字一致的表格数值集合（字节级 lineage 的
         * 归层数据源）。Run P/Q/R 实证：审稿人对同一基线遗留问题（主表/
         * 消融表数值无证据、内部矛盾）的措辞变体无法穷举词面归因；但表格
         * 本身未被修订修改（Fact Guard 保证任何 cell 变更都会被拦）——引用
         * 数值全部落在未修改表格的 finding 是基线遗留，不是修订引入。
         */
        const unchangedTableNumbers = await computeUnchangedTableNumbers(services, ctx.projectId);
        const findingOrigins = classifyFindingOrigins(review.issues, claimGapAudit, modifiedSections, {
          ...(unchangedTableNumbers !== null ? { unchangedTableNumbers } : {}),
        });
        revisionTask = evaluateRevisionTaskGate({
          gateRules: gate.rules,
          externalInstructions: instructionSnapshots,
          claimGapAudit,
          findingOrigins,
          patchSubstanceOk,
          academicScore: review.scores.academicScore,
          baselineAcademicScore: baselineSummary?.scores.academicScore ?? null,
          policy: services.review.revisionTaskPolicy,
        });
        if (patchValidation !== null) {
          // 分层级联：patch 产物作为「修订候选」可发布 = 实质通过且任务层未 FAIL。
          // AUTHOR_DECISION_REQUIRED 不拖垮已全过的投稿层（M5.7 conflict 语义：
          // 系统如实报告冲突并保留条目，不因此冻结对合格稿件的 Final 判定；
          // 待作者裁决项随 publicationReadiness 呈现）
          const publishable = patchSubstanceOk === true && revisionTask.verdict !== "FAIL";
          patchValidation.summary.publishable = publishable;
          await services.reviewArtifacts.savePatchValidation(ctx.projectId, patchValidation);
          gate.rules.push({
            rule: "patch_validation_publishable",
            passed: publishable,
            detail: `patches=${patchValidation.summary.passedPatches}/${patchValidation.summary.totalPatches}; unattributed=${patchValidation.summary.unattributedViolations.length}`,
          });
          if (!publishable) {
            gate.reasons.push("patch_validation_publishable");
            gate.passed = false;
          }
        } else if (revisionTask.verdict === "FAIL") {
          // 无 patch 产物（本轮无 Writer 派发）时任务层 FAIL 也要拦住投稿层：
          // gate.passed 必须不与任务失败矛盾（否则未闭环意见也能冻结 Final）
          gate.passed = false;
          gate.reasons.push(`revision_task: ${revisionTask.verdict}`);
        }
        // 投稿层合成：READY = 全稿规则（含 patch 级联）&& 任务成功；
        // AUTHOR_DECISION 项待裁决时报告层给 AUTHOR_DECISION_REQUIRED（不阻断已过的规则层）
        const publicationVerdict: "READY" | "NOT_READY" | "AUTHOR_DECISION_REQUIRED" =
          revisionTask.verdict === "FAIL"
            ? "NOT_READY"
            : revisionTask.verdict === "AUTHOR_DECISION_REQUIRED"
              ? "AUTHOR_DECISION_REQUIRED"
              : gate.passed
                ? "READY"
                : "NOT_READY";
        gate.revisionTask = {
          verdict: revisionTask.verdict,
          success: revisionTask.success,
          checks: revisionTask.checks,
          reasons: revisionTask.reasons,
          authorDecisions: revisionTask.authorDecisions,
        };
        gate.publicationReadiness = {
          verdict: publicationVerdict,
          reasons: publicationVerdict === "READY"
            ? []
            : [...gate.reasons, ...revisionTask.publication.reasons].slice(0, 12),
          baselineInheritedRisks: revisionTask.publication.risks,
        };
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
      // Round 2：收敛只在同一 run 内比较（iteration-history 跨 run 累积；新 run 的
      // 首轮没有「上一轮」——整篇重写不是对上一 run 终稿的退化）
      const iterations = iterationsForRun(await services.reviewArtifacts.loadIterations(ctx.projectId), ctx.runId);
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
        revisionTaskSuccess: revisionTask?.success ?? undefined,
      });
      await services.reviewArtifacts.appendIteration(ctx.projectId, {
        revision: typeof review.reviewedRevision === "number" ? review.reviewedRevision : 0,
        reviewRound: review.round,
        gateRound: round,
        runId: ctx.runId,
        outcome,
        completedAt: new Date().toISOString(),
        scorecard,
      });
      // M14.4 P0-4：最佳合法版本跟踪（确定性；守卫干净 > blocking > critical >
      // 分数带宽，严格更好才替换）。终局（stalled / overflow / 预算停止）时
      // build.draft 从该版本恢复，替代 R3 的人工 rev-3 恢复。
      if (!gate.passed && typeof review.reviewedRevision === "number") {
        const incumbentBest = await services.reviewArtifacts.loadBestRevision(ctx.projectId);
        const bestDecision = selectBestRevision(
          { revision: review.reviewedRevision, gateRound: round, runId: ctx.runId, scorecard },
          incumbentBest,
        );
        await services.reviewArtifacts.saveBestRevision(ctx.projectId, bestDecision.best);
        if (bestDecision.changed && incumbentBest !== null && incumbentBest.runId === ctx.runId) {
          await ctx.emitDomain(
            "revision.best_updated",
            { revision: bestDecision.best.revision, gateRound: round, previous: incumbentBest.revision },
            `最佳合法版本更新：rev-${bestDecision.best.revision}（gateRound ${round}）严格优于 rev-${incumbentBest.revision}`,
          );
        }
      }
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
      // M14.9.3：第三方已发表论文只读评估——生产 gate 原样保留；另落盘标明规则适用性的评估视图
      let publishedAssessmentSummary: Record<string, unknown> | undefined;
      if (isPublishedAssessmentRun(ctx.state)) {
        const view = buildPublishedAssessmentView({
          gate, review,
          citationReportAvailable: citation !== null,
          evidenceRecords: evidenceRecords.length,
          feasibilityEvaluated: feasibility !== null,
          inputFidelity: await loadPublishedInputFidelity(services, ctx.projectId),
        });
        const dir = services.projects.reviewsDir(ctx.projectId);
        await mkdir(dir, { recursive: true });
        await writeJsonAtomic(join(dir, `published-assessment-r${round}.json`), view);
        publishedAssessmentSummary = {
          reviewPurpose: view.reviewPurpose,
          publicationGate: view.publicationGate,
          reviewCompleted: view.reviewCompleted,
          scientificFindings: view.scientificFindings,
          pendingVerification: view.pendingVerification.total,
          inputFidelity: view.inputFidelity.effectiveStatus,
          academicScoreCalibration: view.academicScore.calibration,
          evidenceLimitations: view.evidenceLimitations.total,
          notEvaluated: view.notEvaluated.map((entry) => entry.item),
        };
      }
      return {
        passed: gate.passed,
        reasonCount: gate.reasons.length,
        reasons: gate.reasons.slice(0, 8),
        round,
        outcome,
        ...(publishedAssessmentSummary !== undefined ? { publishedAssessment: publishedAssessmentSummary } : {}),
        // M11.2.3：确定性收敛状态与轮次质量差（planSharedTail / stalled payload 消费）
        ...(convergence !== null ? { convergence } : {}),
        // M11.3（Phase E）：产品终态语义（completion summary / stalled payload 共用）
        ...(gate.passed
          ? {}
          : {
              terminalStatus: terminal.status,
              // M14.9.4：只读评估没有生成 / 修订稿件，作者稿件的「Draft 可用」终态文案不适用
              terminalMessage: publishedAssessmentSummary !== undefined
                ? "已发表论文只读评估完成：生产 Quality Gate 按作者稿件口径未通过（仅供参考，不是发表 / 录用判定），详见 published-assessment 视图。"
                : terminal.message,
            }),
        // M11.4 Product Closure：分层判定（planSharedTail / completion summary 消费）
        ...(revisionTask !== null
          ? {
              revisionTaskSuccess: revisionTask.success,
              revisionTaskVerdict: revisionTask.verdict,
              revisionTaskReasons: revisionTask.reasons.slice(0, 6),
              publicationReadiness: gate.publicationReadiness?.verdict ?? null,
            }
          : {}),
        ...(authorDecisionClaims > 0 ? { authorDecisionClaims } : {}),
        revisionDelta: delta,
        revision: typeof review.reviewedRevision === "number" ? review.reviewedRevision : 0,
        // M14.7：引用完整性三分语义的原始输入透传（completion summary / 报告消费）
        ...(thesisGate?.citations !== undefined ? { citations: thesisGate.citations } : {}),
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
        await services.externalInstructions.update(ctx.projectId, (current) =>
          reverifyHandledInstructions(current, gateArtifact?.factPreservation ?? null,
            new Date().toISOString(), gateArtifact?.citationPreservation ?? null, patchFailures).instructions);
      }
      // M6.7 §5/§6：citation 类条目的 relatedEvidenceIds —— bib key ↔ verified
      // evidence 关联（与 Writer 引用标注 / Gate 覆盖判定同源 matchBibliographyKey）
      const evidenceLinks = await buildEvidenceLinks(services, ctx.projectId);
      // M14.1b P1：Finding → targetQuote 投影——以被审修订的快照为准（不是当前工作树）
      const reviewedSnapshot = await readSnapshotTex(services.revisions.snapshotDir(ctx.projectId, sourceRevision));
      const plan = buildRevisionPlan({
        projectId: ctx.projectId,
        sourceRevision,
        reviewRound: summary.round,
        summary,
        ...(reviewedSnapshot !== null ? { projectFinding: (issue) => projectFindingTarget(issue, reviewedSnapshot) } : {}),
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
      const scopedRepairs: Array<{ file: string; targets: string[]; applied: string[]; rejected: Array<{ unit: string; violations: string[] }>; unrepairable: ScopedRepairPlan["unrepairable"] }> = [];
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
        const normalizedFile = file.replaceAll("\\", "/").replace(/^\.\//, "");
        if (outline === null && normalizedFile === "main.tex" && isSingleFileManuscript(current)) {
          // M14.9.1 C3：单文件稿件的修复只针对诊断所在的编辑单元——模型只看到并只返回该单元，
          // 单元外逐字节不变；守卫（骨架 / 引用 / label / 事实保持 / 过程说明 / 长度）任一不过即不落盘
          const plan = planScopedLatexRepair(file, current, diagnostics.filter((diagnostic) => diagnostic.file === file));
          const report = { file, targets: plan.targets.map((target) => target.unit.logicalSection), applied: [] as string[], rejected: [] as Array<{ unit: string; violations: string[] }>, unrepairable: plan.unrepairable };
          let working = current;
          for (const target of plan.targets) {
            if (ctx.signal.aborted) {
              throw new BusinessError("WORKFLOW_CANCELLED", "修复已被取消");
            }
            const located = relocateRevisionSpan(file, working, target.unit);
            if (located === undefined) {
              report.rejected.push({ unit: target.unit.logicalSection, violations: ["REVISION_TARGET_STALE：单元已无法唯一定位"] });
              continue;
            }
            let repairedUnit: string;
            try {
              repairedUnit = (await services.writer.repairSection({
                projectId: ctx.projectId,
                sectionFile: `${file}（编辑单元 ${target.unit.logicalSection}）`,
                currentLatex: located.content,
                buildError,
                diagnostics: target.diagnostics,
              })).latex;
            } catch (error) {
              if (!(error instanceof InvalidLatexOutputError)) throw error;
              report.rejected.push({ unit: target.unit.logicalSection, violations: [error.message.slice(0, 200)] });
              continue;
            }
            if (ctx.signal.aborted) {
              throw new BusinessError("WORKFLOW_CANCELLED", "修复已被取消");
            }
            const verdict = evaluateScopedLatexRepair({ file, source: working, target: { ...target, unit: located }, repaired: repairedUnit });
            if (verdict.ok && verdict.candidate !== undefined) {
              working = verdict.candidate;
              report.applied.push(target.unit.logicalSection);
            } else {
              report.rejected.push({ unit: target.unit.logicalSection, violations: verdict.violations });
            }
          }
          scopedRepairs.push(report);
          if (working !== current) {
            await writeFile(absolute, working, "utf8");
            repaired.push(file);
            await ctx.emitProgress({ file, repairedCount: repaired.length, scopedUnits: report.applied });
          }
          continue;
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
        ...(scopedRepairs.length > 0 ? { scopedRepairs } : {}),
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
        // 前后两轮记分卡对比（iteration-history；payload 允许 async 读产物；Round 2：只看本 run）
        const iterations = iterationsForRun(await services.reviewArtifacts.loadIterations(ctx.projectId), ctx.runId);
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
          // M14.4 P0-4：最佳合法版本（accept_draft 时若当前可证明更差，Draft 会
          // 从该版本恢复构建——决策者需要知道将被交付的是哪个版本）
          ...(await (async () => {
            const best = await services.reviewArtifacts.loadBestRevision(ctx.projectId);
            if (best === null || best.runId !== ctx.runId) return {};
            return {
              bestValidRevision: {
                revision: best.revision,
                gateRound: best.gateRound,
                blocking: best.scorecard.blocking,
                critical: best.scorecard.critical,
                academicScore: best.scorecard.academicScore,
                note: "若接受 Draft 且当前稿可证明更差（守卫/阻断/关键问题），系统将从该版本恢复后构建 Draft",
              },
            };
          })()),
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
      // M13.6：修订与写作共享同一实验数值来源（授权观测表）；无授权时修订
      // 也不得引入具体实验数值（与 writeSection 同一纪律）
      const revisionExperimentContext = isSurveyKind(ctx.state.workflowKind)
        ? undefined
        : await services.experimentPackages.workflowContext(
          ctx.projectId,
          // M14.8-MOT：已有论文返修——授权观测按稿件现有数值锚定选择（修订表述
          // 与原稿实验数值同源，不被与稿件无关的观测挤占 100 条预算）
          ctx.state.workflowKind === "existing_paper_improvement"
            ? { anchorText: (await collectLatexFiles(services.projects.manuscriptDir(ctx.projectId))).allTex.map((file) => file.content).join("\n") }
            : {},
        );
      // M14.3：thesis 修订纪律——写作阶段的【科研事实纪律】注入修订（M14.2 遗留
      // 缺口）：修订只改语言/结构，实验数值仍以 authorConfirmed 白名单为唯一来源，
      // 未裁决冲突不得被润色消除，继承表格守卫块不得被改动。
      const thesisRevisionInputs = isThesisKind(ctx.state.workflowKind)
        ? await loadThesisRevisionInputs(services, ctx.projectId)
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
      const authorOwnedComments = new Set((await services.externalInstructions.load(ctx.projectId))
        .filter(instruction => /^(?:AUTHOR_DECISION_REQUIRED|EVIDENCE_ONLY_RECORDED)\b/.test(instruction.statusNote ?? ""))
        .map(instruction => instruction.instructionId));
      // Typed planning already resolved these comments to a non-Writer action.
      // Their raw, section-addressed text must not reopen dispatch via the parallel
      // external-comment channel. Safe modify siblings still dispatch via directives.
      const externalDirectives = (await collectExternalDirectives(services, ctx.projectId))
        .filter(directive => !authorOwnedComments.has(directive.instructionId));
      const sectionScopedExternals = externalDirectives.filter(
        (directive) => directive.section !== undefined,
      );
      let externalOutcomeReports: ExternalOutcomeReport[] = [];
      const patchValidationRecords: PatchValidationRecord[] = [];
      const currentRevision = await services.revisions.currentRevision(ctx.projectId);

      const listedTargets = listRevisionTargets(outline, files, [
        ...directives,
        ...sectionScopedExternals.map((directive) => ({
          match: (target: RevisionTarget) =>
            sectionMatches(directive.section ?? "", target) ? externalScopeIssue() : null,
        })),
      ]);
      // M14.1a P0-1：超过编辑单元上限的章节文件 / 标题 span 展开为有界 logicalSpan
      // 单元目标；指令按确定性定位绑定到单元（定位失败 = unresolved，不猜位置）
      // M14.4 P0-1：thesis 修订 bounded 模式——所有章节文件（不限尺寸）都 span 化：
      // quote 锚点 → 段落窗口；无锚点 → 整 span 合并单元。文件级整文件覆写
      // （真实 R3 的整节重写反馈环）在 thesis 路径不再存在。
      const unitMaxChars = services.revisionUnitMaxChars ?? DEFAULT_REVISION_UNIT_MAX_CHARS;
      const expansion = expandLongFileTargets(listedTargets, directives, sectionScopedExternals, unitMaxChars, {
        boundedAll: ctx.state.workflowKind === "thesis_from_papers",
      });
      const targets = expansion.targets;
      const unresolvedDispatch = expansion.unresolved;
      /** 指令 → 目标匹配：绑定目标只认绑定键（issue 仍从文件级匹配目标取回）。
       * M14.1a 严格 id 优先：指令 logicalSection / label 精确命中同文件某 span 时，
       * 该指令不再经 heading / 路径模糊匹配派给同文件的其它 span（同名标题防误派） */
      const strictSpanIdsByFile = new Map<string, Set<string>>();
      for (const directive of directives) {
        const id = directive.item?.logicalSection;
        if (id === undefined) continue;
        for (const target of targets) {
          if (target.logicalSpan === undefined || target.binding !== undefined) continue;
          if (target.logicalSpan.logicalSection === id || target.logicalSpan.label === id) {
            const set = strictSpanIdsByFile.get(target.relativePath) ?? new Set<string>();
            set.add(id);
            strictSpanIdsByFile.set(target.relativePath, set);
          }
        }
      }
      const matchDirective = (directive: RevisionDirective, index: number, target: RevisionTarget): ReviewIssue | null => {
        if (target.binding !== undefined) {
          return target.binding.keys.has(`d:${index}`) ? directive.match(target.binding.matchTarget) : null;
        }
        const strictId = directive.item?.logicalSection;
        if (
          target.logicalSpan !== undefined && strictId !== undefined &&
          strictSpanIdsByFile.get(target.relativePath)?.has(strictId) === true &&
          target.logicalSpan.logicalSection !== strictId && target.logicalSpan.label !== strictId
        ) {
          return null;
        }
        return directive.match(target);
      };
      const externalBoundToTarget = (directive: ExternalDirectiveDispatch, target: RevisionTarget): boolean =>
        target.binding !== undefined
          ? target.binding.keys.has(`x:${directive.instructionId}`)
          : sectionMatches(directive.section ?? "", target);
      if (unresolvedDispatch.length > 0) {
        await ctx.emitDomain(
          "revision.dispatch_unresolved",
          { count: unresolvedDispatch.length, items: unresolvedDispatch.slice(0, 20) },
          `${unresolvedDispatch.length} 条意见在长章节中无法可靠定位到编辑单元（未派发、不猜位置）：${unresolvedDispatch.slice(0, 3).map((entry) => `${entry.file}: ${entry.summary.slice(0, 40)}（${entry.reason}）`).join("；")}`,
        );
      }
      if (targets.length === 0) {
        /**
         * M11.4 Reliability Closure（Run M 实证：w-b52ff28ae148，计划 5 条全部
         * author_decision_required——全部意见合法走作者裁决/基线覆盖闭环，本轮
         * 没有 Writer 可执行条目。旧逻辑把「无可派发」当契约违反烧掉整个 run。
         * 无可派发条目是合法轮次（合法终态=作者裁决）：跳过派发，正常进入
         * 复审/gate；只有「有派发条目但零目标命中」仍属契约违反。
         */
        if (directives.length === 0 || unresolvedDispatch.length > 0) {
          await ctx.emitDomain(
            "revision.skipped",
            { reason: unresolvedDispatch.length > 0 ? "all_dispatch_unresolved" : "no_dispatchable_items", externalInstructions: externalDirectives.length, unresolved: unresolvedDispatch.length },
            unresolvedDispatch.length > 0
              ? `本轮计划条目全部无法在长章节中可靠定位（${unresolvedDispatch.length} 条）——不猜测修改位置，跳过 Writer 派发，直接进入复审`
              : "本轮计划无可派发条目（全部为作者裁决 / 基线覆盖闭环）——跳过 Writer 派发，直接进入复审",
          );
          return {
            revisedSections: 0,
            sections: [],
            revision: currentRevision,
            changed: false,
            findingDispatch: { total: directives.length, matched: 0, unmatched: directives.length, multiTarget: 0, unresolved: unresolvedDispatch.length },
            ...(externalDirectives.length > 0 ? { externalInstructions: externalDirectives.length } : {}),
          };
        }
        /**
         * M14.3（真实案例驱动）：指令存在但全部无法绑定任何章节目标——
         * reviewer 输出的复合 / 幻觉 section 引用（如「sections/a、sections/b
         * 及全部正文章节」或拼写不一致的文件名）经计划派生后 match 全空。
         * 旧语义把这一形态当契约违反烧掉整个 run（27 节已写完的学位论文
         * 因此失败）。修正：按 unresolved 口径记录并跳过本轮派发（事件流
         * 可审计，直接进入复审 / gate）；绑定失败明细进入 stage result。
         */
        await ctx.emitDomain(
          "revision.skipped",
          {
            reason: "all_directives_unbound",
            directives: directives.length,
            samples: directives.slice(0, 3).map((directive) => (directive.item?.problem ?? "").slice(0, 60)),
          },
          `本轮 ${directives.length} 条修订指令全部无法绑定到任何章节目标（复合/不一致 section 引用）——跳过 Writer 派发，直接进入复审`,
        );
        return {
          revisedSections: 0,
          sections: [],
          revision: currentRevision,
          changed: false,
          findingDispatch: { total: directives.length, matched: 0, unmatched: directives.length, multiTarget: 0, unresolved: directives.length },
          unboundDirectives: directives.length,
          ...(externalDirectives.length > 0 ? { externalInstructions: externalDirectives.length } : {}),
        };
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
        (directive, index) => targets.filter((target) => matchDirective(directive, index, target) !== null).length,
      );
      const dispatchMatched = dispatchTargetCounts.filter((count) => count > 0).length;
      const findingDispatch = {
        total: directives.length,
        matched: dispatchMatched,
        unmatched: directives.length - dispatchMatched,
        multiTarget: dispatchTargetCounts.filter((count) => count > 1).length,
        ...(unresolvedDispatch.length > 0 ? { unresolved: unresolvedDispatch.length } : {}),
        ...(expansion.expandedFiles > 0 ? { unitTargets: targets.filter((target) => target.binding !== undefined).length, expandedFiles: expansion.expandedFiles } : {}),
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
        const matchedDirectives = directives.filter((directive, directiveIndex) => matchDirective(directive, directiveIndex, target) !== null);
        const issues = matchedDirectives
          .map((directive) => matchDirective(directive, directives.indexOf(directive), target))
          .filter((issue): issue is ReviewIssue => issue !== null);
        const matchedItems = matchedDirectives
          .map((directive) => directive.item)
          .filter((item): item is RevisionPlanItem => item !== undefined);
        const protocolIds = [...new Set(matchedItems.flatMap((item) => item.protocolRequirement?.protocolId ? [item.protocolRequirement.protocolId] : []))];
        const recordProtocolId = protocolIds.length === 1 ? protocolIds[0] : undefined;
        // M9.7.6：UNSUPPORTED / CONTRADICTED claim 的 evidence-aware Repair
        // Context（复用该轮 claim grounding 报告；候选只含 formal evidence）。
        let claimRepairs: ClaimRepairDirective[] =
          claimGrounding !== null
            ? buildClaimRepairDirectives(
                claimGrounding,
                (claimSection) => sectionMatches(claimSection, target.binding?.matchTarget ?? target),
                evidenceById,
                bibliography,
              )
            : [];
        if (target.binding !== undefined && target.logicalSpan !== undefined && claimRepairs.length > 0) {
          // M14.1a：claim repair 二次定位到本单元（claim 原文锚点 → 词法）；定位不到
          // 本单元的 claim 不派发到这里（避免同一文件的每个单元都收到全部 claim）
          const { fileSpan, allUnits } = target.binding;
          const span = target.logicalSpan;
          claimRepairs = claimRepairs.filter((repair) => {
            const unit = resolveUnitByQuotes(fileSpan, allUnits, [repair.claim]).unit;
            return unit !== undefined && unit.start < span.end && span.start < unit.end;
          });
        }
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
            ? externalBoundToTarget(directive, target)
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
        // M14.1a：按 id（章节 span）/ id + 原文（编辑单元）在当前磁盘内容上重新定位；
        // 同文件兄弟 patch 造成的偏移不影响未触及单元，单元自身内容变化 = stale
        const relocated = target.logicalSpan !== undefined
          ? relocateRevisionSpan(target.relativePath, fileBefore ?? "", target.logicalSpan)
          : undefined;
        const resolvedSpan = relocated !== undefined && relocated.originalHash === target.logicalSpan?.originalHash ? relocated : undefined;
        if (target.logicalSpan !== undefined && resolvedSpan === undefined) {
          // stale / 不可定位的 patch：fail closed 记录并跳过本目标（兄弟 patch 照常），
          // 不再以 fatal 终结整个 run，也绝不猜位置
          const staleReason = relocated === undefined ? "REVISION_TARGET_UNRESOLVED" : "REVISION_TARGET_STALE";
          const staleRecord: PatchValidationRecord = {
            patchId: `patch:${target.logicalSpan.originalHash.slice(0, 12)}`,
            revisionId: `rev-${currentRevision + 1}`,
            file: target.relativePath,
            logicalTarget: target.logicalSpan.logicalSection,
            planItemIds: matchedItems.map((item) => item.id),
            commentIds: [...new Set([
              ...matchedItems.flatMap((item) => item.instructionId ? [item.instructionId] : []),
              ...targetExternals.map((directive) => directive.instructionId),
            ])],
            evidenceIds: [...new Set(matchedItems.flatMap((item) => item.relatedEvidenceIds ?? []))],
            beforeFileHash: revisionSourceHash(fileBefore ?? ""),
            beforeTargetHash: target.logicalSpan.originalHash,
            proposedReplacementHash: "",
            afterFileHash: revisionSourceHash(fileBefore ?? ""),
            scope: { ok: false, violations: [staleReason] },
            workspaceIntegrity: { ok: true, directMutationDetected: false, recoveryAttempted: false, recoverySucceeded: true },
            fact: { ok: false, findingIds: [], violations: ["NOT_RUN_TARGET_STALE"] },
            citation: { ok: false, findingIds: [], addedKeys: [], removedKeys: [], violations: ["NOT_RUN_TARGET_STALE"] },
            evidence: { ok: false, violations: ["NOT_RUN_TARGET_STALE"] },
            apply: { ok: false, status: "rejected" },
            overall: "fail",
            failedStage: "resolve",
            finalStatus: "rejected",
          };
          patchValidationRecords.push(staleRecord);
          // 同修订号可能已有既往应用的 patch 工件——合并而不是覆盖（审计线索不丢）
          const existingArtifact = await services.reviewArtifacts.loadPatchValidation(ctx.projectId, currentRevision);
          const mergedRecords = [...(existingArtifact?.records ?? []), ...patchValidationRecords];
          await services.reviewArtifacts.savePatchValidation(ctx.projectId, {
            revisionId: staleRecord.revisionId, revision: currentRevision,
            records: mergedRecords, summary: summarizePatchValidation(selectFinalPatchRecords(mergedRecords), [], mergedRecords),
          });
          ctx.log(`[revision] ${staleReason}: ${target.relativePath}#${target.logicalSpan.logicalSection} — 目标在当前文件中不可定位或内容已变化，patch 拒绝（不猜位置）`);
          await ctx.emitProgress({ section: target.key, index: index + 1, revisedCount: revised.length, stale: target.logicalSpan.logicalSection });
          continue;
        }
        /**
         * M11.4 Reliability Closure（F3b preserve-by-construction 前置投影）：
         * improvement 流派发的伪计划条目没有 mustPreserve（revision 流由
         * attachMustPreserveConstraints 投影）——Writer 改写前不知道 span 内
         * 哪些数值绝对不能动（8b 实证：为「创新性凝练」重写引言段时顺带删除
         * 56.8\% AP 既有事实）。此处对缺失 mustPreserve 的条目按目标 span 数值
         * token 投影（授权豁免口径与 factPreservation 的 improvement 文本授权
         * 通道一致：条目 instruction/expectedOutcome 点名的旧值/新值放行）。
         * 只进 prompt（改前约束）；守卫判定口径不变（候选级 F3a 拦截兜底）。
         */
        const writerItems = projectSpanMustPreserve(
          matchedItems,
          resolvedSpan?.content ?? target.currentLatex,
        );
        const requiredProtocols = new Set(matchedItems.flatMap((item) => item.protocolRequirement ? [item.protocolRequirement.protocolId] : []));
        if (requiredProtocols.size > 1) {
          throw new BusinessError("STAGE_CONTRACT_VIOLATION", "REVISION_PROTOCOL_SCOPE_CONFLICT");
        }
        const targetEvidence = requiredProtocols.size === 1
          ? filterEvidenceForProtocol(evidence, { protocolId: [...requiredProtocols][0]! })
          : evidence;
        let result: Awaited<ReturnType<typeof services.writer.reviseSection>> | undefined;
        let writerFailure: unknown;
        // M14.3：目标章节的 thesis 修订纪律块（确定性；无映射章时退化为全局口径）
        const thesisRevisionDiscipline =
          thesisRevisionInputs !== null
            ? renderThesisRevisionDiscipline(thesisRevisionInputs, basename(target.relativePath))
            : undefined;
        // M14.4：本目标的原文锚点授权（span 候选按引文区间逐字校验；prompt 同步
        // 告知授权范围，减少「合法修复被范围守卫拒绝」的无效修复轮）
        const targetAuthorizedQuotes = [
          ...new Set(matchedItems.flatMap((item) => (item.targetQuote !== undefined ? [item.targetQuote] : []))),
        ];
        const writerParams = {
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
            ? { wholeFile: true, targetFilePath: join(services.projects.manuscriptDir(ctx.projectId), target.relativePath) }
            : {}),
          ...(resolvedSpan !== undefined ? { proposalOnly: true } : {}),
          ...(resolvedSpan !== undefined && targetAuthorizedQuotes.length > 0 ? { authorizedQuotes: targetAuthorizedQuotes } : {}),
          ...(resolvedSpan !== undefined && isUnitSpanId(resolvedSpan.logicalSection) && fileBefore !== undefined
            ? (() => {
                // M14.1a：编辑单元的只读相邻上下文（标题 + 前后 800 字）——Writer 看到
                // 衔接但只能输出本单元的替换文本
                const base = relocateRevisionSpan(target.relativePath, fileBefore, { logicalSection: baseSpanId(resolvedSpan.logicalSection), content: "" });
                if (base === undefined) return {};
                const units = partitionSpanIntoUnits(base, unitMaxChars).units;
                return { unitContext: buildUnitEditContext(base, resolvedSpan, units) };
              })()
            : {}),
          ...(revisionLanguage !== undefined ? { language: revisionLanguage } : {}),
          ...(buildError !== undefined ? { buildError } : {}),
          ...(targetExternals.length > 0 ? { externalDirectives: targetExternals } : {}),
          ...(claimRepairs.length > 0 ? { claimRepairs } : {}),
          ...(surveyContext !== undefined ? { survey: surveyContext } : {}),
          ...(matchedItems.length > 0 ? { revisionItems: writerItems, itemEvidence } : {}),
          ...(revisionExperimentContext !== undefined ? { experimentContext: revisionExperimentContext } : {}),
          ...(thesisRevisionDiscipline !== undefined ? { extraInstructions: thesisRevisionDiscipline } : {}),
        };
        try {
          result = await services.writer.reviseSection(writerParams);
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
              await writeFileAtomic(targetFilePath, fileBefore);
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
        let acceptedAttempt = 0;
        let acceptedAlignment: { adjustments: Array<"eol_crlf" | "whitespace_resplice">; candidateRef?: string } | undefined;
        if (resolvedSpan !== undefined && fileBefore !== undefined && result.latex.trim() !== "") {
          const basePatchId = `patch:${resolvedSpan.originalHash.slice(0, 12)}`;
          const priorRoots: string[][] = [];
          const priorProposalHashes: string[] = [];
          // M14.8.1-MOT：引文授权区间与 span 一同固定（不随修复轮变化）。引文按 span 的
          // 换行风格对齐后定位（CRLF 稿件里 Planner 引文的裸 LF 不再导致 UNRESOLVED）。
          const quotes = [...new Set(matchedItems.flatMap(item => item.targetQuote ? [adaptLineEndingsToSpan(resolvedSpan.content, item.targetQuote)] : []))];
          // Reuse the existing immutable prefix/suffix guard inside the section.
          // Multiple quotes: M14.1a — quotes whose unique ranges pairwise overlap
          // or nest (same region of text) authorize exactly their union range;
          // disjoint or non-unique quotes still require explicit replanning and
          // are never unioned into a silently broader authorization.
          const quoteRanges = quotes
            .map((quote) => {
              const start = resolvedSpan.content.indexOf(quote);
              return start >= 0 && resolvedSpan.content.indexOf(quote, start + 1) < 0
                ? { start, end: start + quote.length, originalHash: revisionSourceHash(quote) }
                : null;
            })
            .filter((range): range is { start: number; end: number; originalHash: string } => range !== null);
          const quotesResolvable = quoteRanges.length === quotes.length;
          const pairwiseOverlapping = quotesResolvable && quoteRanges.every((range) =>
            quoteRanges.every((other) => other === range || (range.start < other.end && other.start < range.end)));
          const authorized = quotes.length === 0
            ? undefined
            : quotesResolvable && pairwiseOverlapping
              ? { start: Math.min(...quoteRanges.map((range) => range.start)), end: Math.max(...quoteRanges.map((range) => range.end)), originalHash: revisionSourceHash(resolvedSpan.content.slice(Math.min(...quoteRanges.map((range) => range.start)), Math.max(...quoteRanges.map((range) => range.end)))) }
              : quoteRanges.length === 1 ? quoteRanges[0] : undefined;
          // M14.8.1-MOT：多个可唯一定位、互不重叠的引文——逐个引文授权（不并集），引文外原文逐字节
          // 按序保留（checkMultiRangeScope）。重叠的引文先合并为其各自的并集区间。
          const multiRanges = authorized === undefined && quotes.length > 1 && quotesResolvable
            ? [...quoteRanges].sort((a, b) => a.start - b.start).reduce<Array<{ start: number; end: number }>>((merged, range) => {
                const last = merged[merged.length - 1];
                if (last !== undefined && range.start < last.end) last.end = Math.max(last.end, range.end);
                else merged.push({ start: range.start, end: range.end });
                return merged;
              }, [])
            : undefined;
          for (let attempt = 0; attempt <= 2; attempt += 1) {
            // M14.8.1-MOT：提案格式对齐（换行风格 + 引文外纯空白差异的原文回填）。判定口径
            // 不变：引文外仍逐字节校验，对齐只消除 LaTeX 无语义的格式差异。
            const alignment = alignProposalToSpan(resolvedSpan.content, result.latex.trim(), authorized);
            const proposal = alignment.proposal;
            const candidate = applyRevisionSpan(fileBefore, resolvedSpan, proposal, { preserveBoundaryWhitespace: matchedItems.some(item => item.targetQuote !== undefined) });
            const failures: { code: RevisionViolationCode; detail: string; evidenceId?: string; metric?: string }[] = [];
            const scope = checkGlobalRevisionScope(fileBefore, candidate, [resolvedSpan]);
            if (!scope.allowed) failures.push({ code: "scope_violation", detail: scope.reason ?? "revision scope violation" });
            if (quotes.length > 0) {
              const candidateSection = candidate.slice(resolvedSpan.start, candidate.length - (fileBefore.length - resolvedSpan.end));
              const multi = multiRanges !== undefined ? checkMultiRangeScope(resolvedSpan.content, candidateSection, multiRanges) : undefined;
              const inside = authorized !== undefined
                ? checkRevisionScope(resolvedSpan.content, candidateSection, authorized).allowed ||
                  isWholeQuoteDeletion(resolvedSpan.content, candidateSection, authorized)
                : multi?.allowed === true;
              if (!inside) {
                failures.push({
                  code: "scope_violation",
                  detail: authorized === undefined && multi === undefined
                    ? "REVISION_TARGET_QUOTE_UNRESOLVED"
                    : authorized === undefined
                      ? `REVISION_TARGET_QUOTE_SCOPE_VIOLATION（${multiRanges!.length} 处引文授权：引文外第 ${multi!.failedSegment! + 1} 段原文未逐字保留）`
                      // M14.8-MOT：附带引文外首个改动位置与摘录（候选不落盘时唯一的诊断依据）
                      : `REVISION_TARGET_QUOTE_SCOPE_VIOLATION（${describeScopeViolation(resolvedSpan.content, candidateSection, authorized)}）`,
                });
              }
            }
            if (hasNewContentAfterDocumentEnd(fileBefore, candidate)) failures.push({ code: "scope_violation", detail: "new content after document end" });
            // M14.3：继承表格守卫块完整性（span 候选）——候选不得改写任何守卫表格块
            //（真实案例 R3 实锤：修订 Writer 重构守卫表 13→12 列，gate 才事后检出）。
            // 数值/行列/题注变更只能走作者决定（table_inheritance）路径。
            const guardedBeforeSpan = extractGuardedTableBlocks(fileBefore);
            if (guardedBeforeSpan.size > 0) {
              const guardedCandidateSpan = extractGuardedTableBlocks(candidate);
              for (const [guardedAssetId, guardedBlock] of guardedBeforeSpan) {
                if (guardedCandidateSpan.get(guardedAssetId) !== guardedBlock) {
                  failures.push({
                    code: "scope_violation",
                    detail: `INHERITED_TABLE_MODIFICATION: 守卫表格 ${guardedAssetId} 被候选改写（继承表格数据/结构/题注只能经作者决定变更；请原样保留该表格块，只修订其上下文）`,
                  });
                }
              }
            }
            // M11.4（Attempt 7 实录）：scoped 提案可能破坏 span 自身的章节结构
            // （丢失 \subsection 命令 / 边界换行粘连），候选落盘后 locateLatexSections
            // 解析不出对应 span，后续 target 以 "Revision target no longer resolves"
            // fatal 终结整个 run。结构卫生检查：候选的章节数量必须与写前文件一致
            // （改写标题文本是既有合法行为；丢失/粘连/新增章节命令 = 结构损伤）。
            const structureBefore = locateLatexSections(target.relativePath, fileBefore).length;
            const structureCandidate = locateLatexSections(target.relativePath, candidate).length;
            if (structureBefore !== structureCandidate) {
              failures.push({ code: "scope_violation", detail: `REVISION_STRUCTURE_DAMAGE: candidate changes the section structure (${structureBefore} -> ${structureCandidate} sections)` });
            }
            // M14.4 P0-2：内容塌缩守卫（span 候选）——局部修复把目标区间压缩成
            // 摘要式短文 = 质量回归的确定性信号（进入同一 bounded repair 通道）
            const collapse = revisionContentCollapse(resolvedSpan.content, result.latex);
            if (collapse !== null) {
              failures.push({
                code: "revision_content_loss",
                detail: `REVISION_CONTENT_COLLAPSE: 候选把目标区间从 ${resolvedSpan.content.length} 字压缩到 ${result.latex.length} 字（保留 ${Math.round(collapse.ratio * 100)}%）——局部修订不得塌缩目标内容；如确需大幅删减请走重新规划或作者决定，并在修复中恢复被删内容`,
              });
            }
            /**
             * M11.4 Reliability Closure（Run A 实证：p-fce3f34e28c3，Writer 把
             * 「【修订说明】f-60cada…（λ_smooth=0.5 与表8 …）」执行注记实体写进
             * 正文——一处污染同时造成 LaTeX 编译失败（裸 λ_ 进 text mode）与
             * unauthorized 超参数新增）。修订元注记 / 决策标记 / 结果报告行
             * 永远不属于论文正文：候选级直接拒绝并进 bounded repair 通道。
             */
            if (REVISION_META_TEXT_PATTERN.test(result.latex)) {
              failures.push({ code: "revision_meta_text", detail: "REVISION_META_TEXT_IN_MANUSCRIPT: 修订执行注记/决策标记/报告行不得写进论文正文（删除全部标记文本后重写该 span；说明信息只允许出现在最后单独一行的执行报告）" });
            }
            // M14.9-MOT：无标记的修订过程说明（修复轮 Writer 在正文末尾回应校验结果）同样拒绝
            const processCommentary = findWriterProcessCommentary(resolvedSpan.content, result.latex);
            if (processCommentary !== null) {
              failures.push({ code: "revision_meta_text", detail: `REVISION_PROCESS_COMMENTARY_IN_MANUSCRIPT: 候选正文新增了关于修订过程 / 校验结果的说明（“${processCommentary}”）——替换文本会原样写进论文；只输出该 span 的论文正文，不要在正文中解释、复述或回应校验结果` });
            }

            const baselineFiles = await readSnapshotTex(services.revisions.snapshotDir(ctx.projectId, currentRevision));
            const baselineTarget = baselineFiles?.find((file) => file.file === target.relativePath);
            if (baselineFiles !== null && baselineFiles !== undefined && baselineTarget !== undefined) {
              const candidateFiles = baselineFiles.map((file) => file.file === target.relativePath ? { ...file, content: candidate } : file);
              const fact = await computeFactPreservationForCandidate(services, ctx.projectId, currentRevision, candidateFiles);
              if (fact !== null) {
                for (const finding of fact.directionalChanges) failures.push({ code: finding.reason.includes("flip") || finding.reason.includes("advantage") ? "metric_direction_flip" : "fact_direction_drift", detail: `${finding.before} → ${finding.after}: ${finding.reason}`, metric: finding.before.slice(0, 50) });
                for (const finding of fact.addedUnsupportedFacts) failures.push({ code: "unsupported_claim", detail: `${finding.before} → ${finding.after}: ${finding.reason}` });
                /**
                 * M11.4 Reliability Closure（8b 实证：p-e4f0737aa7e4，Writer 重写
                 * 引言段删除 56.8\% AP 既有事实）：候选级校验此前只覆盖方向翻转与
                 * 无依据新增——数值删除 / 占位替换 / 公式删除三类违规在 patch 层
                 * 静默通过、进修订后才由 gate 爆炸，bounded patch repair 从未获得
                 * 修复机会，2 轮预算耗尽即 run 级 permanent FAIL。三类违规在此进入
                 * 与 direction/added 同一 repair 通道（提交前拦截 + 定向修复）；
                 * 授权口径不变（evaluateFactPreservation 内部已做授权过滤，
                 * removedFacts 等列表只含未授权项）。
                 */
                for (const finding of fact.removedFacts) failures.push({ code: "unauthorized_fact_removal", detail: `${finding.before.slice(0, 120)}（被删除）: ${finding.reason}${finding.classification?.oldValue !== undefined ? `（值 ${finding.classification.oldValue}）` : ""}`, metric: finding.classification?.oldValue ?? finding.before.slice(0, 50) });
                /**
                 * M11.4 Reliability Closure（Run B 实证：p-8fb1a3cc92fc，Writer 给
                 * tab:baseline_source 的 DeepSORT 来源 cell 追加「自实现，ReID 特征
                 * 统一为 128 维」诚实澄清——科学上有价值但未走计划授权，patch 层
                 * 放行 → gate 层判 changed 漂移 → round-2 恢复不了（表格 cell 非
                 * 段落恢复对象）→ 任务层唯一 FAIL 因子。未授权值变更与删除同类，
                 * 必须在提交前进入 repair 通道（改回原值，或由计划 expectedFactChanges
                 * + Evidence 走合法授权）。
                 */
                for (const finding of fact.changedFacts) failures.push({ code: "unauthorized_fact_change", detail: `${String(finding.before).slice(0, 100)} → ${String(finding.after).slice(0, 100)}: ${finding.reason}`, metric: finding.classification?.oldValue ?? String(finding.before).slice(0, 50) });
                for (const finding of fact.placeholderRegressions) failures.push({ code: "placeholder_regression", detail: `${finding.before} → ${finding.after}: ${finding.reason}` });
                for (const finding of fact.formulaChanges) failures.push({ code: "unauthorized_formula_change", detail: `${finding.before.slice(0, 90)} → ${finding.after.slice(0, 90)}: ${finding.reason}` });
              }
            }
            /**
             * M14.6（F5）：学位论文作者已确认研究输入事实不得被修订候选删除——无论审稿意见如何
             * （M14.5 案例 B：reviewer 误判「无实验数据」→ 修订把 75.37% 改成「显著降低」）。
             * 删除 / 改值须经作者决定重新授权，不是修订的职权；进入同一 repair 通道（恢复原值）。
             */
            if (thesisRevisionInputs !== null) {
              for (const removed of detectConfirmedFactRemoval(fileBefore, candidate, thesisRevisionInputs.context.facts.authorConfirmed)) {
                failures.push({
                  code: "unauthorized_fact_removal",
                  detail: `作者已确认研究输入事实 ${removed.surface}（${removed.factId}）在修订候选中被删除：学位论文已确认事实不得由修订删除或改为定性表述`,
                  metric: removed.surface,
                });
              }
            }
            // M13 Final Closure（A2）：修订新引入、证据池 / 参考文献 / 修订前稿件都没有的具名文献 /
            // 作者 / 实体（Reviewer finding 文本经修订污染正文的确定性信号）→ 候选级拒绝 + 修复通道
            {
              const introducedNames = findIntroducedNamedReferences({
                before: fileBefore,
                after: candidate,
                allowedTexts: [
                  ...(baselineFiles ?? []).filter((file) => file.file !== target.relativePath).map((file) => file.content),
                  ...buildReferenceVocabulary({ evidence, bibEntries: bibliography }),
                ],
              });
              if (introducedNames.length > 0) {
                failures.push({
                  code: "unsupported_named_reference",
                  detail: `UNSUPPORTED_NAMED_REFERENCE: 修订引入证据池 / 参考文献 / 修订前稿件中都不存在的具名文献或实体——${describeIntroducedNamedReferences(introducedNames)}。审稿意见不是事实证据：删除该提及或改为不具名的限制表述，其余逐字保留`,
                });
              }
            }
            const originalKeys = new Set(extractCitationKeys(resolvedSpan.file, resolvedSpan.content).keys);
            const candidateKeys = new Set(extractCitationKeys(resolvedSpan.file, result.latex).keys);
            for (const key of originalKeys) {
              if (!candidateKeys.has(key)) failures.push({ code: "citation_removed", detail: `existing citation key ${key} was removed` });
            }
            for (const key of candidateKeys) {
              if (!originalKeys.has(key) && !bibliography.some((entry) => entry.key === key)) failures.push({ code: "citation_hallucinated", detail: `citation key ${key} is not in verified bibliography` });
            }
            for (const evidenceId of matchedItems.flatMap((item) => item.relatedEvidenceIds ?? [])) {
              const evidenceRecord = evidenceById.get(evidenceId);
              if (evidenceRecord === undefined || evidenceRecord.verificationStatus !== "verified" ||
                evidenceRecord.protocolScope?.status === "superseded" ||
                (recordProtocolId !== undefined && (evidenceRecord.protocolScope?.status !== "current" || evidenceRecord.protocolScope.protocolId !== recordProtocolId))) {
                failures.push({ code: "evidence_protocol_mismatch", detail: `Evidence ${evidenceId} is not verified/current for this patch`, evidenceId });
              }
            }
            const failuresKey = [...new Set(failures.map((failure) => failure.code))].sort();
            // M14.8.1-MOT：候选原文落盘（接受 / 拒绝都记录，供确定性回放）
            const candidateRef = await services.reviewArtifacts.savePatchCandidate(ctx.projectId, `rev-${currentRevision + 1}`, {
              schemaVersion: 1,
              patchId: `${basePatchId}.a${attempt}`, originalPatchId: basePatchId, attempt,
              revisionId: `rev-${currentRevision + 1}`, sourceRevision: currentRevision,
              file: target.relativePath, logicalTarget: resolvedSpan.logicalSection,
              planItemIds: matchedItems.map((item) => item.id), authorizedQuotes: quotes,
              beforeTargetHash: resolvedSpan.originalHash,
              rawProposal: result.latex.trim(), validatedProposal: proposal,
              proposalAdjustments: alignment.adjustments,
              verdict: failures.length === 0 ? "accepted" : "rejected",
              failures: failures.map((failure) => ({ code: failure.code, detail: failure.detail })),
              createdAt: new Date().toISOString(),
            }).catch(() => undefined);
            if (failures.length === 0) {
              acceptedAttempt = attempt;
              acceptedAlignment = { adjustments: alignment.adjustments, ...(candidateRef !== undefined ? { candidateRef } : {}) };
              // 落盘与后续 lineage 使用校验通过的对齐后提案（与被校验候选逐字节一致）
              result = { ...result, latex: proposal };
              break;
            }

            const failed: PatchValidationRecord = {
              patchId: `${basePatchId}.a${attempt}`, originalPatchId: basePatchId, attempt,
              ...(attempt > 0 ? { parentAttempt: attempt - 1, repairReasonFindingIds: [...(patchValidationRecords.find((record) => record.originalPatchId === basePatchId && record.attempt === attempt - 1)?.fact.findingIds ?? []), ...(patchValidationRecords.find((record) => record.originalPatchId === basePatchId && record.attempt === attempt - 1)?.citation.findingIds ?? [])] } : {}),
              planItemIds: matchedItems.map((item) => item.id),
              commentIds: [...new Set([...matchedItems.flatMap((item) => item.instructionId ? [item.instructionId] : []), ...targetExternals.map((directive) => directive.instructionId)])],
              revisionId: `rev-${currentRevision + 1}`, file: target.relativePath, logicalTarget: resolvedSpan.logicalSection,
              evidenceIds: [...new Set(matchedItems.flatMap((item) => item.relatedEvidenceIds ?? []))],
              ...(recordProtocolId !== undefined ? { protocolId: recordProtocolId } : {}),
              beforeFileHash: revisionSourceHash(fileBefore), beforeTargetHash: resolvedSpan.originalHash,
              proposedReplacementHash: revisionSourceHash(result.latex.trim()), afterFileHash: revisionSourceHash(candidate),
              scope: { ok: !failures.some((failure) => failure.code === "scope_violation" || failure.code === "revision_meta_text" || failure.code === "revision_content_loss"), violations: failures.filter((failure) => failure.code === "scope_violation" || failure.code === "revision_meta_text" || failure.code === "revision_content_loss").map((failure) => failure.detail) },
              workspaceIntegrity: { ok: true, directMutationDetected: false, recoveryAttempted: false, recoverySucceeded: true },
              fact: { ok: !failures.some((failure) => ["metric_direction_flip", "fact_direction_drift", "unsupported_claim", "unsupported_named_reference", "unauthorized_fact_removal", "unauthorized_fact_change", "placeholder_regression", "unauthorized_formula_change"].includes(failure.code)), findingIds: failures.filter((failure) => ["metric_direction_flip", "fact_direction_drift", "unsupported_claim", "unsupported_named_reference", "unauthorized_fact_removal", "unauthorized_fact_change", "placeholder_regression", "unauthorized_formula_change"].includes(failure.code)).map((failure) => `${failure.code}:${attempt}`), violations: failures.filter((failure) => ["metric_direction_flip", "fact_direction_drift", "unsupported_claim", "unsupported_named_reference", "unauthorized_fact_removal", "unauthorized_fact_change", "placeholder_regression", "unauthorized_formula_change"].includes(failure.code)).map((failure) => failure.detail) },
              citation: { ok: !failures.some((failure) => failure.code.startsWith("citation_")), findingIds: failures.filter((failure) => failure.code.startsWith("citation_")).map((failure) => `${failure.code}:${attempt}`), addedKeys: [...candidateKeys].filter((key) => !originalKeys.has(key)), removedKeys: [...originalKeys].filter((key) => !candidateKeys.has(key)), violations: failures.filter((failure) => failure.code.startsWith("citation_")).map((failure) => failure.detail) },
              evidence: { ok: true, violations: [] }, apply: { ok: false, status: "rejected" }, overall: "fail", failedStage: "candidate_validation",
              rootViolationIds: failuresKey, modelRole: "revision.primary", finalStatus: attempt === 2 ? "exhausted" : "rejected",
              ...(alignment.adjustments.length > 0 ? { proposalAdjustments: alignment.adjustments } : {}),
              ...(candidateRef !== undefined ? { candidateRef } : {}),
            };
            patchValidationRecords.push(failed);
            /**
             * M14.8.1-MOT：引文越界（且仅此一类范围违规）进入**一次**有界定向修复——修复轮以
             * 原文为底稿、附首个越界位置摘录，要求只改引文、其余逐字恢复。其他范围违规
             * （全局 span 越界 / 引文不可定位 / 结构损伤 / 守卫表格）仍直接拒绝，不修复。
             */
            const scopeFailures = failures.filter((failure) => failure.code === "scope_violation");
            const quoteScopeOnly = scope.allowed && scopeFailures.length > 0 &&
              scopeFailures.every((failure) => failure.detail.startsWith("REVISION_TARGET_QUOTE_SCOPE_VIOLATION"));
            if (!scope.allowed || (scopeFailures.length > 0 && !(quoteScopeOnly && attempt === 0))) break;
            const sameRoot = priorRoots.length > 0 && priorRoots[priorRoots.length - 1]!.join("|") === failuresKey.join("|");
            const proposalHash = revisionSourceHash(result.latex.trim());
            const sameProposal = priorProposalHashes.at(-1) === proposalHash;
            priorRoots.push(failuresKey);
            priorProposalHashes.push(proposalHash);
            if (attempt >= 2 || (sameRoot && sameProposal)) {
              failed.finalStatus = sameRoot && sameProposal ? "no_progress" : "exhausted";
              break;
            }
            const evidenceIds = [...new Set(matchedItems.flatMap((item) => item.relatedEvidenceIds ?? []))];
            const allowedEvidence = targetEvidence.filter((entry) => evidenceIds.includes(entry.id) && entry.verificationStatus === "verified" && entry.protocolScope?.status !== "superseded");
            // M11.4 Reliability Closure：删除/占位违规的修复指令必须点名被删的
            // 具体数值（mustPreserve）——repair prompt 据 this 构建「恢复这些值」
            // 的确定性约束，而不是泛泛「保持事实」。
            const removalMustPreserve = failures
              .filter((failure) => failure.code === "unauthorized_fact_removal" || failure.code === "placeholder_regression" || failure.code === "unauthorized_fact_change")
              .map((failure) => failure.metric)
              .filter((value): value is string => typeof value === "string" && value.trim() !== "");
            const directive: PatchRepairDirective = {
              patchId: basePatchId, planItemIds: matchedItems.map((item) => item.id),
              commentIds: failed.commentIds, logicalTarget: resolvedSpan.logicalSection,
              originalText: resolvedSpan.content, proposedText: result.latex,
              mustPreserve: [...new Set([...matchedItems.flatMap((item) => item.mustPreserve?.values ?? []), ...removalMustPreserve])],
              evidenceIds: allowedEvidence.map((entry) => entry.id), ...(recordProtocolId ? { protocolId: recordProtocolId } : {}),
              validationFailures: failures,
              forbiddenChanges: [
                "Change the verified direction or numeric values", "Modify any other patch or target", "Use evidence outside the listed verified IDs",
                ...(quoteScopeOnly
                  ? [`Change any text outside the authorized quote(s) — copy every character outside them verbatim from "Original verified text"; only these quote(s) may be rewritten: ${quotes.map((quote) => JSON.stringify(quote.slice(0, 300))).join(" / ")}`]
                  : []),
              ],
              repairAttempt: attempt + 1,
            };
            const diskNow = await readFile(targetFilePath, "utf8");
            if (revisionSourceHash(diskNow) !== revisionSourceHash(fileBefore)) throw new BusinessError("DIRECT_WORKSPACE_MUTATION", `patch repair workspace changed: ${basePatchId}`);
            // 引文越界修复以原文为底稿（上一版越界提案只作参考，见 repair prompt）
            result = await services.writer.reviseSection({ ...writerParams, currentLatex: quoteScopeOnly ? resolvedSpan.content : result.latex, evidence: allowedEvidence, patchRepairContext: buildPatchRepairPrompt(directive) });
            const diskAfterRepair = await readFile(targetFilePath, "utf8");
            if (revisionSourceHash(diskAfterRepair) !== revisionSourceHash(fileBefore)) {
              await writeFileAtomic(targetFilePath, fileBefore);
              throw new BusinessError("DIRECT_WORKSPACE_MUTATION", `patch repair directly mutated workspace: ${basePatchId}`);
            }
          }
          if (patchValidationRecords.some((record) => record.originalPatchId === basePatchId)) {
            const priorAttempts = patchValidationRecords.filter((record) => record.originalPatchId === basePatchId);
            const finalAttempt = priorAttempts[priorAttempts.length - 1]!;
            if (finalAttempt.overall === "fail" && acceptedAttempt === 0) {
              // A rejected candidate did not create currentRevision + 1. Store its
              // fail-closed validation artifact alongside the unchanged current revision.
              await services.reviewArtifacts.savePatchValidation(ctx.projectId, { revisionId: finalAttempt.revisionId, revision: currentRevision, records: patchValidationRecords, summary: summarizePatchValidation(selectFinalPatchRecords(patchValidationRecords), [], patchValidationRecords) });
              // Keep the rejected proposal out of the manuscript while allowing sibling patches
              // to finish; the persisted failed record keeps the candidate gate fail-closed.
              await ctx.emitProgress({ section: target.key, index: index + 1, revisedCount: revised.length });
              continue;
            }
          }
          // The final applied PatchValidationRecord is appended below. Earlier failed
          // records remain immutable so revision.validate can move them to attemptHistory.
        }
        // M13 Final Closure（A2）：摘要目标不经过候选 patch 管线——在此做具名实体守卫（真实样本：
        // reviewer 点名「阈值实验、早期重复码演示」经修订写进摘要限制句）。一次有界修复；仍失败则
        // 保留原摘要（targetChanged=false → 条目按 writer_unchanged 归层，下一轮复审再裁）。
        if (isAbstractTarget && result.latex.trim() !== "" && result.latex.trim() !== target.currentLatex.trim()) {
          const manuscriptFiles = (await readSnapshotTex(services.revisions.snapshotDir(ctx.projectId, currentRevision))) ?? [];
          const abstractAllowed = [
            ...manuscriptFiles.map((file) => file.content),
            ...buildReferenceVocabulary({ evidence, bibEntries: bibliography }),
          ];
          let introducedNames = findIntroducedNamedReferences({ before: target.currentLatex, after: result.latex, allowedTexts: abstractAllowed });
          if (introducedNames.length > 0) {
            ctx.log(`[revision] 摘要修订引入无据具名实体：${describeIntroducedNamedReferences(introducedNames)}；执行一次有界修复`);
            const repaired = await services.writer.reviseSection({
              ...writerParams,
              currentLatex: result.latex,
              patchRepairContext: [
                "上一版摘要修订引入了证据池 / 参考文献 / 稿件中都不存在的具名文献或实体：",
                describeIntroducedNamedReferences(introducedNames),
                "审稿意见不是事实证据。请删除这些具名提及，或改为不点名的限制表述（如「未覆盖其他类型的实验工作」）；其余内容逐字保留，不新增任何文献、数字或机制。",
              ].join("\n"),
            });
            introducedNames = findIntroducedNamedReferences({ before: target.currentLatex, after: repaired.latex, allowedTexts: abstractAllowed });
            if (introducedNames.length === 0) {
              result = { ...repaired, externalOutcomes: result.externalOutcomes ?? repaired.externalOutcomes };
            } else {
              ctx.log(`[revision] 摘要修复后仍含无据具名实体（${introducedNames.map((entry) => entry.surface).join("、")}）——保留原摘要，不写入`);
              result = { ...result, latex: target.currentLatex };
            }
          }
        }
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
        /**
         * M11.4 Reliability Closure（Run 1 实证：p-c923662f9c48 R2）：意见对应
         * 的计划条目命中本目标、候选 patch 通过全部守卫并被接受、目标真实变化
         * ——机器 lineage 已构成 §14 的执行证据（accepted patch + target 对应 +
         * guards PASS）。Writer 自报 not_applicable / unreported 与该证据冲突时，
         * 以确定性 lineage 为准（自报留档在 basis）。conflict 是更强的诚实信号，
         * 不覆盖（其本身即合法 author_decision 终态）。
         */
        if (targetChanged && resolvedSpan !== undefined) {
          const patchBacked = applyPatchBackedOutcomeOverrides(externalOutcomeReports, {
            instructionIds: matchedItems.flatMap((item) => item.instructionId !== undefined ? [item.instructionId] : []),
            target: `${target.relativePath}#${target.logicalSpan?.heading ?? target.key}`,
            planItemIds: matchedItems.map((item) => item.id),
            patchIds: [`patch:${resolvedSpan.originalHash.slice(0, 12)}`],
            evidenceIds: [...new Set(matchedItems.flatMap((item) => item.relatedEvidenceIds ?? []))],
          });
          if (patchBacked !== externalOutcomeReports) externalOutcomeReports = patchBacked;
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
            const candidate = applyRevisionSpan(fileBefore, resolvedSpan, result.latex.trim(), { preserveBoundaryWhitespace: matchedItems.some(item => item.targetQuote !== undefined) });
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
            await writeFileAtomic(targetFilePath, output);
            const actualFinal = await readFile(targetFilePath, "utf8");
            const finalScope = checkGlobalRevisionScope(fileBefore, actualFinal, [resolvedSpan]);
            if (sha256(actualFinal) !== sha256(output) || !finalScope.allowed) {
              await writeFileAtomic(targetFilePath, fileBefore);
              await persistScopeFailure("REVISION_FINAL_WORKSPACE_MISMATCH", actualFinal);
              throw new BusinessError("STAGE_CONTRACT_VIOLATION", "REVISION_FINAL_WORKSPACE_MISMATCH");
            }
            const finalPatchId = `patch:${resolvedSpan.originalHash.slice(0, 12)}`;
            const patchRecord: PatchValidationRecord = {
              patchId: acceptedAttempt > 0 ? `${finalPatchId}.a${acceptedAttempt}` : finalPatchId,
              ...(acceptedAttempt > 0 ? {
                originalPatchId: finalPatchId, attempt: acceptedAttempt, parentAttempt: acceptedAttempt - 1,
                repairReasonFindingIds: patchValidationRecords.filter((record) => record.originalPatchId === finalPatchId && record.attempt === acceptedAttempt - 1).flatMap((record) => [...record.fact.findingIds, ...record.citation.findingIds]),
                rootViolationIds: patchValidationRecords.find((record) => record.originalPatchId === finalPatchId)?.rootViolationIds ?? [],
                finalStatus: "accepted" as const, modelRole: "revision.primary" as const,
              } : { finalStatus: "accepted" as const }),
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
              ...(acceptedAlignment !== undefined && acceptedAlignment.adjustments.length > 0 ? { proposalAdjustments: acceptedAlignment.adjustments } : {}),
              ...(acceptedAlignment?.candidateRef !== undefined ? { candidateRef: acceptedAlignment.candidateRef } : {}),
            };
            patchValidationRecords.push(patchRecord);
            try {
              await services.reviewArtifacts.savePatchValidation(ctx.projectId, {
                revisionId: patchRecord.revisionId, revision: currentRevision + 1,
                records: patchValidationRecords, summary: summarizePatchValidation(patchValidationRecords),
              });
            } catch (error) {
              if (acceptedAttempt > 0) {
                await writeFileAtomic(targetFilePath, fileBefore);
                throw new BusinessError("REPAIR_PIPELINE_ERROR", `REPAIR_RESULT_NOT_PROMOTED: ${finalPatchId}.a${acceptedAttempt}${error instanceof Error ? ` (${error.message})` : ""}`);
              }
              throw error;
            }
            revised.push(target.key);
            await ctx.emitProgress({ section: target.key, index: index + 1, revisedCount: revised.length });
            continue;
          }
          // M14.3：继承表格守卫块完整性（文件级目标——thesis 章节文件整文件修订）。
          // 候选改写守卫块 → 本目标保留原稿（fail-closed；事件可审计），修订不落盘。
          const guardedBeforeFile = extractGuardedTableBlocks(target.currentLatex);
          if (guardedBeforeFile.size > 0) {
            const guardedAfterFile = extractGuardedTableBlocks(output);
            const guardedViolations = [...guardedBeforeFile.entries()]
              .filter(([guardedAssetId, guardedBlock]) => guardedAfterFile.get(guardedAssetId) !== guardedBlock)
              .map(([guardedAssetId]) => guardedAssetId);
            if (guardedViolations.length > 0) {
              await ctx.emitDomain(
                "revision.guarded_table_rejected",
                { file: target.relativePath, assets: guardedViolations },
                `${target.relativePath} 的修订候选改写了守卫继承表格（${guardedViolations.join("、")}）——拒绝落盘，目标保留原稿（表格变更须走作者决定）`,
              );
              output = target.currentLatex;
            }
          }
          // M14.4 P0-2：内容塌缩守卫（文件级目标）——整文件候选把章节压缩成摘要式
          // 短文（真实 R3 的整节重写形态之一）→ 拒绝落盘，目标保留原稿。
          // span 候选在候选校验环内拦截并给修复机会；文件级路径无候选校验环，
          // 按守卫表格同语义 fail-closed。
          const fileCollapse = revisionContentCollapse(target.currentLatex, output);
          if (fileCollapse !== null) {
            await ctx.emitDomain(
              "revision.content_collapse_rejected",
              {
                file: target.relativePath,
                beforeChars: target.currentLatex.length,
                afterChars: output.length,
                retainedRatio: Number(fileCollapse.ratio.toFixed(3)),
              },
              `${target.relativePath} 的修订候选把章节从 ${target.currentLatex.length} 字压缩到 ${output.length} 字（保留 ${Math.round(fileCollapse.ratio * 100)}%）——疑似摘要式重写，拒绝落盘，目标保留原稿`,
            );
            output = target.currentLatex;
          }
          // M14.1a：章节文件写入原子化（tmp → fsync → rename），进程中断不留半个文件
          await writeFileAtomic(targetFilePath, output);
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
          const updatedInstructions = await services.externalInstructions.update(ctx.projectId, (current) =>
            applyDispatchOutcome(current, dispatch, new Date().toISOString()).instructions);
          const conflicts = updatedInstructions.filter(
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
      let sourceRevision =
        plan?.sourceRevision !== undefined && plan.sourceRevision >= 0 && plan.sourceRevision <= revision
          ? plan.sourceRevision
          : Math.max(0, revision - 1);
      let previousFiles = await readSnapshotTex(services.revisions.snapshotDir(ctx.projectId, sourceRevision));
      const currentFiles = await readSnapshotTex(services.revisions.snapshotDir(ctx.projectId, revision));
      // Existing-paper imports may have only the current baseline snapshot. If no revision
      // was applied, validate against that immutable baseline rather than inventing rev-0.
      if (previousFiles === null && sourceRevision === 0 && revision > 0) {
        previousFiles = currentFiles;
        sourceRevision = revision;
      }
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
        const attemptRecords = patchArtifact.records;
        const patchRecords = selectFinalPatchRecords(attemptRecords);
        patchArtifact.attemptHistory = [
          ...(patchArtifact.attemptHistory ?? []),
          ...attemptRecords.filter((record) => !patchRecords.includes(record)),
        ];
        patchArtifact.records = patchRecords;
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
        patchArtifact.summary = summarizePatchValidation(patchRecords, unattributed, attemptRecords);
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
        patchEvidenceIds: patchArtifact?.records.flatMap(record => record.evidenceIds) ?? [],
        evidenceLinks,
        // M13 Final Closure（A2）：具名实体允许词表 = 证据池 + 参考文献（审稿意见 / 计划文本不在内）
        referenceVocabulary: buildReferenceVocabulary({
          evidence: evidenceRecords,
          bibEntries: citationReport?.static.bibEntries ?? [],
        }),
        // M13 Final Closure：新增 \cite key 必须存在于 bibliography（拼写错误 / 捏造 key fail-closed）
        ...(citationReport !== null ? { knownBibKeys: citationReport.static.bibEntries.map((entry) => entry.key) } : {}),
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
        finalizedPatchArtifact.summary = summarizePatchValidation(finalizedPatchArtifact.records, finalizedPatchArtifact.summary.unattributedViolations, [
          ...finalizedPatchArtifact.records, ...(finalizedPatchArtifact.attemptHistory ?? []),
        ]);
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
  // 内联 thebibliography 稿件：参考文献的事实源是正文里的 \bibitem，没有可追加的
  // .bib 文件（写一个未被 \bibliography 引用的 references.bib 不会进入编译，
  // 只会制造「看似已补齐」的假象）——不追加，由引用核验如实报告。
  if (files.bibSource === "thebibliography") {
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
  // 稿件实际参考文献：\bibliography{refs} 指向的 .bib（不限文件名）或内联
  // thebibliography 的 \bibitem（M14.8-MOT：此前硬编码 references.bib，refs.bib /
  // 内联参考文献的稿件 Writer 拿到空 key 清单，会把合法引用当违规删除）
  let bib: string | null = null;
  try {
    bib = (await collectLatexFiles(services.projects.manuscriptDir(projectId))).bibContent;
  } catch {
    bib = null;
  }
  if (bib === null) {
    try {
      bib = await readFile(join(services.projects.manuscriptDir(projectId), "references.bib"), "utf8");
    } catch {
      // 无 references.bib：只有 canonical bibliography
    }
  }
  if (bib !== null) {
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

/**
 * M14.4 P0-4：终局恢复最佳合法版本（确定性、幂等；build.draft thesis 分支前置）。
 *
 * 触发条件（全部满足才恢复）：存在同 run 的 best-revision 工件；当前修订不是
 * 该版本；当前内容也不等价于该版本（防重复恢复）；本 run 终局记分卡**可证明
 * 劣于**最佳（shouldRestoreBest：守卫干净 / blocking / critical 主键上更差且无
 * 任何主键更好——分数带内差异不触发，不追 reviewer 噪声）。
 * 恢复 = RevisionStore.restore（提交新的不可变修订，历史不动）。恢复后：
 * - 防御性复核新修订快照与最佳版本快照逐文件一致；
 * - 下游 assemble / 编译 / Build Gate / Fact Preservation 全部按恢复后内容执行
 *   （Draft 不会因恢复跳过任何检查）；
 * - 事件 revision.best_restored 可审计（替代 R3 的人工 rev-3 恢复）。
 */
async function maybeRestoreBestRevision(
  services: WorkflowServices,
  ctx: StageRunContext,
): Promise<{ restored: boolean; restoredFrom?: number; revision: number; reasons: string[] }> {
  const currentRevision = await services.revisions.currentRevision(ctx.projectId);
  const best = await services.reviewArtifacts.loadBestRevision(ctx.projectId);
  if (best === null) {
    return { restored: false, revision: currentRevision, reasons: ["无 best-revision 工件（本 run 未发生 gate 失败轮）"] };
  }
  if (best.runId !== ctx.runId) {
    return { restored: false, revision: currentRevision, reasons: [`最佳合法版本属于其它 run（${best.runId}）——不跨 run 恢复`] };
  }
  if (best.revision === currentRevision) {
    return { restored: false, revision: currentRevision, reasons: [`当前修订 rev-${currentRevision} 即最佳合法版本`] };
  }
  const filesEqual = async (a: number, b: number): Promise<boolean | null> => {
    const [left, right] = await Promise.all([
      readSnapshotTex(services.revisions.snapshotDir(ctx.projectId, a)),
      readSnapshotTex(services.revisions.snapshotDir(ctx.projectId, b)),
    ]);
    if (left === null || right === null) return null;
    if (left.length !== right.length) return false;
    const byFile = new Map(right.map((file) => [file.file, file.content]));
    return left.every((file) => byFile.get(file.file) === file.content);
  };
  // 幂等：当前内容已等价于最佳快照（此前恢复过 / 漂移回同内容）→ 不重复恢复
  const alreadyEquivalent = await filesEqual(currentRevision, best.revision);
  if (alreadyEquivalent === true) {
    return { restored: false, revision: currentRevision, reasons: [`当前修订 rev-${currentRevision} 内容与最佳版本 rev-${best.revision} 逐文件一致（已恢复过）`] };
  }
  const terminal = terminalScorecardForRun(await services.reviewArtifacts.loadIterations(ctx.projectId), ctx.runId);
  if (terminal === null) {
    return { restored: false, revision: currentRevision, reasons: ["本 run 无终局记分卡（无迭代历史）"] };
  }
  const verdict = shouldRestoreBest(terminal, best);
  if (!verdict.restore) {
    return { restored: false, revision: currentRevision, reasons: verdict.reasons };
  }
  const restored = await services.revisions.restore(ctx.projectId, best.revision);
  if (restored.created) {
    const verified = await filesEqual(restored.revision, best.revision);
    if (verified !== true) {
      throw new BusinessError(
        "STAGE_CONTRACT_VIOLATION",
        `最佳版本恢复后快照核验失败（rev-${restored.revision} vs rev-${best.revision}）——不在此状态上构建 Draft`,
      );
    }
    await ctx.emitDomain(
      "revision.best_restored",
      { restoredFrom: best.revision, revision: restored.revision, gateRound: best.gateRound, reasons: verdict.reasons },
      `终局质量劣于最佳合法版本——已从 rev-${best.revision} 恢复（新修订 rev-${restored.revision}，历史不动），Draft 将从恢复后版本构建`,
    );
  }
  return { restored: true, restoredFrom: best.revision, revision: restored.revision, reasons: verdict.reasons };
}

function buildDraftStage(services: WorkflowServices, options: { thesis?: boolean } = {}): StageSpec {
  return {
    id: "build.draft",
    description:
      options.thesis === true
        ? "Thesis Build Gate：确定性装配复核 → 学位论文编译（600s 预算）→ Draft 产物注册"
        : "Build Gate：LaTeX 编译产出 PDF（质量语义不阻塞构建；D-0015）",
    requiredInputs: [],
    producedOutputs: ["build/paper.pdf", "build/compile.log", "build/build-gate.json"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: options.thesis === true ? services.stageTimeoutMs * 4 : services.stageTimeoutMs,
    retryable: ["transient", "timeout"],
    async execute(ctx) {
      // M14.4 P0-4：终局恢复最佳合法版本（thesis 分支前置；确定性、幂等）。
      // 必须发生在 assemble 之前——装配与编译都消费恢复后的 manuscript。
      // 非 thesis（existing-paper 等）本轮不动：分层 gate 已有任务层终态语义。
      const bestRestore = options.thesis === true
        ? await maybeRestoreBestRevision(services, ctx)
        : { restored: false, revision: await services.revisions.currentRevision(ctx.projectId), reasons: [] as string[] };
      // M14.2：thesis 项目先做确定性装配复核，编译目标切到 manuscript-thesis/
      const thesisOptions: { manuscriptDir?: string } = {};
      if (options.thesis === true) {
        const outline = await services.manuscript.loadOutline(ctx.projectId);
        if (outline === null) {
          throw new BusinessError("STAGE_CONTRACT_VIOLATION", "缺少大纲（thesis 写作未落盘 outline.json）");
        }
        const model = await services.thesis.documents.loadModel(ctx.projectId);
        await services.thesis.documents.assemble(ctx.projectId, outline, model ?? undefined);
        thesisOptions.manuscriptDir = services.thesis.documents.thesisManuscriptDir(ctx.projectId);
      }
      // 编译前读取当前修订：record.revision 是 Finalize 的新鲜度依据
      const revision = await services.revisions.currentRevision(ctx.projectId);
      // M14.7：终局恢复最佳版本后，摘要绑定可能不再对应恢复后的正文（恢复发生在最后一次
      // gate 之后，gate 的 ABSTRACT_STALE 判定覆盖不到）——确定性复核并如实标注，不静默改判
      let abstractSnapshotStale: boolean | undefined;
      if (options.thesis === true) {
        try {
          const staleModel = await services.thesis.documents.loadModel(ctx.projectId);
          const abstractPresentForStale =
            staleModel !== null && (staleModel.abstractZh ?? "").trim() !== "" && (staleModel.abstractEn ?? "").trim() !== "";
          if (abstractPresentForStale) {
            const staleMapping = await services.thesis.planner.loadMapping(ctx.projectId);
            const staleArtifact = JSON.parse(
              await readFile(join(services.projects.researchDir(ctx.projectId), "thesis-abstract.json"), "utf8"),
            ) as { snapshot?: AbstractSnapshotBinding };
            const staleContext = await services.thesis.researchInputs.plannerContext(ctx.projectId);
            abstractSnapshotStale = !compareAbstractSnapshot(staleArtifact.snapshot, {
              revision,
              manuscriptFingerprint: await computeManuscriptSectionsFingerprint(
                services.projects,
                ctx.projectId,
                (staleMapping?.chapters ?? []).flatMap((chapter) => chapter.sectionFiles),
              ),
              confirmedFactFingerprint: computeConfirmedFactFingerprint(staleContext.facts.authorConfirmed),
              authorDecisionFingerprint: computeAuthorDecisionFingerprint(
                await services.thesis.researchInputs.decisions.list(ctx.projectId),
              ),
            }).current;
          }
        } catch {
          abstractSnapshotStale = undefined; // 复核失败不阻断构建；gate 侧判定仍为权威口径
        }
      }
      const { build, compile, record } = await runBuildGateForRevision(
        services.projects,
        options.thesis === true ? services.thesis.latex : services.latex,
        ctx.projectId,
        revision,
        thesisOptions,
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
        ...(options.thesis === true ? { thesis: true } : {}),
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
        // M14.4：终局最佳版本恢复（build.draft 前置执行的确定性结果）
        ...(bestRestore.restored ? { restoredBestFrom: bestRestore.restoredFrom, restoredBestReasons: bestRestore.reasons.slice(0, 2) } : {}),
        ...(abstractSnapshotStale === true ? { abstractSnapshotStale: true } : {}),
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
  // M13 Final Closure（A1）：正式证据池进 context——拒绝 / 不确定性立场的含数字 claim
  // 只有在数值全部锚定正式证据时才走 author_decision_required（否则照常数值阶梯）
  const formalEvidence = (await services.evidenceSelection.selectForWriting(projectId)).formal;
  return { sources: groundability, sectionCitedSourceIds, targetedSearchBudget: 0, formalEvidence };
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

/**
 * M11.4 Reliability Closure（F3b）：目标 span 数值 → mustPreserve 前置投影
 * （improvement 流伪条目专用；revision 流已由 attachMustPreserveConstraints
 * 处理，此处不覆盖既有投影）。授权豁免 = 条目 instruction/expectedOutcome 文本
 * 点名的数值——与 factPreservation 的 improvement 计划文本授权通道同口径
 *（readImprovementPlanItems 把 action/rationale 并入授权文本）。
 */
function projectSpanMustPreserve(
  items: readonly RevisionPlanItem[],
  spanContent: string,
): RevisionPlanItem[] {
  if (items.length === 0) {
    return [...items];
  }
  return items.map((item) => {
    if (item.mustPreserve?.values !== undefined && item.mustPreserve.values.length > 0) {
      return item;
    }
    const authorized = new Set(
      (`${item.instruction} ${item.expectedOutcome}`.match(/[-−]?\d+(?:\.\d+)?[%‰]?/g) ?? [])
        .map((token) => token.replace("−", "-")),
    );
    const values = [
      ...new Set(
        (spanContent.match(/[-−]?\d+(?:\.\d+)?[%‰]?/g) ?? [])
          .map((token) => token.replace("−", "-"))
          .filter((token) => !authorized.has(token) && token.length >= 2),
      ),
    ].slice(0, 40);
    if (values.length === 0) {
      return item;
    }
    return {
      ...item,
      mustPreserve: {
        values,
        ...(item.mustPreserve?.citationKeys !== undefined ? { citationKeys: item.mustPreserve.citationKeys } : {}),
      },
    };
  });
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

  // ---- gate / 预算上下文（纯 state 派生；提前声明，预算降级分支与规则判定共用）----
  const gateResult = state.stageResults["quality.gate"] ?? {};
  const gatePassed = gateResult["passed"] === true;
  const gateRound = typeof gateResult["round"] === "number" ? gateResult["round"] : 0;
  const outcome = typeof gateResult["outcome"] === "string" ? gateResult["outcome"] : null;
  // M14.7：引用完整性三分（citation integrity ≠ evidence sufficiency ≠ bibliography completeness）
  const gateCitations = (gateResult["citations"] ?? null) as Record<string, unknown> | null;
  // M11.2.3（D-4）：确定性收敛状态（PROGRESS / STALLED / REGRESSED）——
  // STALLED（连续两轮核心阻断指标无改善）优先于轮数预算：不再自动续跑，
  // 按 NO_PROGRESS 语义进 HITL；REGRESSED（新增 critical / fact / citation
  // 回归）同样先停下（修新回归或人工决策，不「还有轮数就继续」）。
  const convergence =
    typeof gateResult["convergence"] === "string" ? gateResult["convergence"] : null;
  const overflowAnswered = "hitl.revision_overflow" in state.stageResults;
  // M14.4 容错：legacy 测试桩 / 最小服务束可能不带 review 配置——视为无自动轮数
  //（与既有「预算耗尽」路径同语义），不让 plan() 在缺失字段上崩溃。
  const roundsLeft =
    services.review !== undefined &&
    revisionRoundsUsed(state) < revisionBudget(state, services);
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

  // M11.4 Product Closure：existing-paper 分层 gate——任务层成功（外审意见闭环 +
  // 修订引入违规为零 + 守卫全过 + 无实质回退）时返修任务已完成，剩余 failing
  // 规则属投稿就绪层（whole-paper 质量 / 基线继承风险 / 绝对学术线）。继续
  // 自动修订只会追逐作者级问题（Attempt 7 实录：Writer 被派发补充论文里本来就
  // 存在的实验）。直接产出修订候选 Draft（明确标记非投稿就绪），不进
  // stalled / overflow 追问。
  const revisionTaskSuccess = gateResult["revisionTaskSuccess"] === true;
  const revisionTaskVerdict =
    gateResult["revisionTaskVerdict"] === "PASS" ||
    gateResult["revisionTaskVerdict"] === "FAIL" ||
    gateResult["revisionTaskVerdict"] === "AUTHOR_DECISION_REQUIRED"
      ? (gateResult["revisionTaskVerdict"] as "PASS" | "FAIL" | "AUTHOR_DECISION_REQUIRED")
      : null;

  const completion = (label: "final" | "draft") => {
    // M11.3（Phase E）：产品终态语义（gate 结果带同轮 author_decision 口径；
    // 旧 run 的 gate 结果无该字段 → classifyTerminalStatus 内按 0 处理；
    // M11.4：分层 gate 的任务层结果一并传入）
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
          ...(revisionTaskSuccess ? { revisionTaskSuccess: true } : {}),
        });
    return {
      kind: "complete",
      label,
      summary: {
        buildOk,
        buildGateReasons: build["buildGateReasons"] ?? [],
        qualityGatePassed: gatePassed,
        qualityGateReasons: gateResult["reasons"] ?? [],
        // M11.3：产品终态语义（PASS / REVISION_TASK_COMPLETE / QUALITY_NOT_REACHED /
        // NO_PROGRESS / AUTHOR_DECISION_REQUIRED / SYSTEM_FAILED + 用户可读 message）
        qualityStatus: terminal.status,
        qualityStatusMessage: terminal.message,
        // M11.4：分层判定（existing-paper；旧 run 无该字段 → 单层语义）
        ...(revisionTaskVerdict !== null
          ? {
              revisionTaskVerdict,
              revisionTaskSuccess,
              publicationReadiness:
                gateResult["publicationReadiness"] === "READY" ||
                gateResult["publicationReadiness"] === "NOT_READY" ||
                gateResult["publicationReadiness"] === "AUTHOR_DECISION_REQUIRED"
                  ? (gateResult["publicationReadiness"] as "READY" | "NOT_READY" | "AUTHOR_DECISION_REQUIRED")
                  : null,
            }
          : {}),
        // M11.2 §十四：报告层区分「自动修改轮数耗尽 / 不收敛后接受 Draft」与
        // 「双 Gate 通过自然完结」——qualityGatePassed=false 的 Draft 不是异常，
        // 是 bounded loop 的正常终态（PASS / IMPROVED / CONVERGED / REGRESSION）
        ...(outcome !== null && !gatePassed ? { qualityOutcome: outcome } : {}),
        ...(budgetStop !== null ? { modelBudgetExhausted: true } : {}),
        // M14.7：引用完整性三分（结构化；零引用 Draft 不因 hallucinated=0 被误读为证据充分）
        ...(gateCitations !== null
          ? {
              citationIntegrity: {
                citedCount: gateCitations["citedCount"] ?? 0,
                hallucinated: gateCitations["hallucinated"] ?? 0,
                missingKeys: gateCitations["missingKeys"] ?? 0,
                evidenceSufficiency: gateCitations["applicable"] !== true
                  ? "not_applicable"
                  : ((gateCitations["citedCount"] as number | undefined) ?? 0) > 0
                    ? "cited"
                    : (((gateCitations["formalEvidence"] as number | undefined) ?? 0) > 0 || ((gateCitations["bibEntries"] as number | undefined) ?? 0) > 0)
                      ? "zero_cited_with_citable_material"
                      : "no_formal_evidence",
              },
            }
          : {}),
        revisionRounds: revisionRoundsUsed(state),
        draftArtifactId: build["draftArtifactId"] ?? null,
        // M14.4：Draft 由恢复的最佳合法版本构建（终局质量劣化时的自动止损回滚）
        ...(build["restoredBestFrom"] !== undefined ? { restoredBestFrom: build["restoredBestFrom"] as number } : {}),
        // M14.7：Draft 摘要与最终正文不一致的显式标记（预算耗尽跳过刷新 / 终局恢复最佳
        // 版本等 gate 未覆盖的窗口；gate 规则 thesis_abstract_snapshot_current 是权威判定）
        ...(build["abstractSnapshotStale"] === true ? { abstractSnapshotStale: true } : {}),
        ...(label === "final"
          ? { finalArtifactId: state.stageResults["build.final"]?.["finalArtifactId"] ?? null }
          : {}),
      },
    } satisfies PlanDecision;
  };

  // accept_draft（overflow 或 stalled 的回答）→ 构建 Draft PDF 后完成。
  // M5.4/M5.6：用户显式 apply_once 时，Draft 构建前同样提供一次语言润色（Quality
  // Gate 未通过 ≠ 不能润色表达；润色产生新修订后尾部照旧重走复审 / gate）
  // M14.6：学位论文摘要在正文被修订后刷新（构建前；预算耗尽 / 从未生成 → 不刷新，Draft 如实）
  const abstractIdx = lastCompletionIndex(state, "thesis.abstract");
  const abstractRefreshDue = (): boolean =>
    isThesisKind(state.workflowKind) && budgetStop === null && has("thesis.abstract") && abstractIdx < contentIdx;
  const draftPath = (): PlanDecision => {
    // M14.4：模型预算耗尽时不再进入润色（润色也是模型调用）
    if (budgetStop === null) {
      const stylePolishBeforeDraft = planStylePolish(state, gateRound);
      if (stylePolishBeforeDraft !== null) {
        return stylePolishBeforeDraft;
      }
    }
    // Draft（质量未达 / 预算或收敛停止）不重复生成摘要（预算允许时已在规则 0c 刷新）
    if (!has("build.draft") || buildIdx < contentIdx) {
      return { kind: "stage", stageId: "build.draft" };
    }
    if (buildOk) {
      return completion("draft");
    }
    // M14.7：Draft 路径的构建失败同样先走有界 LaTeX 修复（此前修复只在 gate 通过分支
    // 存在——M14.7 案例 B 真实 run 实证：预算耗尽收口时 \\bm 未定义编译失败直接完成，
    // 无 Draft 产物）。修复产生修订 → 尾部照旧重走；预算耗尽则如实带 buildOk=false 完成。
    const draftRepairAttempts = countCompletions(state, "revision.repair_latex");
    const draftDiagnostics = Array.isArray(build["diagnosticFiles"]) ? build["diagnosticFiles"] : [];
    if (draftRepairAttempts < MAX_AUTO_LATEX_REPAIRS && draftDiagnostics.length > 0 && budgetStop === null) {
      return { kind: "stage", stageId: "revision.repair_latex" };
    }
    if (roundsLeft && budgetStop === null) {
      return { kind: "stage", stageId: "revision.revise" };
    }
    return completion("draft"); // buildOk=false 如实记录（不伪造 Draft 产物）
  };

  // M14.4 P0-3：run 级模型预算——派发新的模型 stage（review.run / revision.revise）
  // 前检查；耗尽 → overflow HITL / Draft 终态（优雅降级：产物保留、终态如实，
  // 不让 runtime 硬约束在 stage 中途打失败 run）。硬约束本体在
  // RunBudgetLedgerRuntime.startAgent（启动前拦截，并发不突破）。
  const budgetStop =
    services.modelBudget !== undefined
      ? (() => {
          const snapshot = services.modelBudget!.snapshotSync(state.projectId, state.runId);
          return snapshot !== null && budgetExhausted(snapshot) ? snapshot : null;
        })()
      : null;
  /** 预算耗尽的收口：未回答 overflow → 问一次；已回答 → Draft 链 */
  const budgetStopPath = (): PlanDecision =>
    overflowAnswered ? draftPath() : { kind: "stage", stageId: "hitl.revision_overflow" };

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

  // 0b. M14.5（案例 B 真实 run 实证）：本轮修订**没有任何候选被接受**（全部被
  //     候选守卫 fail-closed 拒绝 / 全部意见无法定位 / 无可派发条目）→ 稿件正文与
  //     上一轮 review 看到的内容相同。再启动一整轮 review（长文档 = N 个单元调用）
  //     只会在相同文本上得到 reviewer 噪声（run1 实录：major 11→13 / 分数 71→70 被
  //     判 REGRESSION，白烧 3 次调用）。按「Guard 持续拒绝 / 无进展」语义直接进
  //     stalled HITL（payload 仍是本轮 gate 的真实记分卡）；作者 accept_draft →
  //     Draft 链；revise_more → 下一轮计划照常派发。
  //     只在 revise 是最新的内容变更且晚于本轮 review 时生效（repair_latex / 润色 /
  //     restore_facts 产生的真实改稿照旧重走复审）。
  if (
    reviseIdx > -1 &&
    reviseIdx === contentIdx &&
    reviseIdx > reviewIdx &&
    reviseIdx > gateIdx &&
    lastCompletionIndex(state, "revision.revise") === reviseIdx &&
    reviseAppliedNothing(state)
  ) {
    if (!stalledAnswered) {
      return { kind: "stage", stageId: "hitl.revision_stalled" };
    }
    if (stalledDecision === "accept_draft" || !roundsLeft || budgetStop !== null) {
      return budgetStop !== null && !overflowAnswered && stalledDecision !== "accept_draft"
        ? budgetStopPath()
        : draftPath();
    }
    // revise_more：允许下一轮重新计划（计划新鲜度按 gateRound 判定——同轮计划已
    // 存在且已派发过 → 必须经过复审才能再派发，避免同一计划反复派发死循环）
    if (reviseIdx > planIdx) {
      return { kind: "stage", stageId: "citation.verify" };
    }
  }

  // 0c. M14.7：正文在摘要生成之后发生变化（修订 / 修复 / 润色 / 事实恢复）→ 刷新摘要。
  //     M14.6 只在 gate 通过路径刷新，Draft 终态保留写作期摘要且无过期标记；本轮修正：
  //     Draft 路径预算允许时同样刷新（交付 Draft 的摘要与最终正文一致），预算耗尽时跳过，
  //     由 gate 规则 thesis_abstract_snapshot_current 如实标记 ABSTRACT_STALE。
  //     有界：abstractIdx 更新后不再派发（每次内容变更至多刷新一次）。
  if (abstractRefreshDue()) {
    return { kind: "stage", stageId: "thesis.abstract" };
  }
  // 1. 引用核验须新于最近一次改稿
  if (!has("citation.verify") || citationIdx < contentIdx) {
    return { kind: "stage", stageId: "citation.verify" };
  }
  // 2. review 须新于其消费的 citation
  if (!has("review.run") || reviewIdx < citationIdx) {
    if (budgetStop !== null) {
      // 最后一轮修订未经复审即停（预算优先于「再审一轮」）：条目级
      // revision.validate（确定性）照常执行，终态 summary 如实标注
      return budgetStopPath();
    }
    return { kind: "stage", stageId: "review.run" };
  }
  // 3. gate 须新于 review
  if (!has("quality.gate") || gateIdx < reviewIdx) {
    return { kind: "stage", stageId: "quality.gate" };
  }

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
    if (abstractRefreshDue()) {
      return { kind: "stage", stageId: "thesis.abstract" };
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
    if (roundsLeft && budgetStop === null) {
      return { kind: "stage", stageId: "revision.revise" };
    }
    if (!overflowAnswered) {
      return { kind: "stage", stageId: "hitl.revision_overflow" };
    }
    return completion("draft"); // 用户知情接受（无 PDF 产出，buildOk=false 如实记录）
  }

  // ---- M11.4：任务层成功但投稿层未就绪 → 返修任务完成，产出修订候选 Draft ----
  // 不再进入 stalled / overflow / 自动续轮（投稿层剩余项是作者级裁决，Writer
  // 无法也不应单方解决）；Draft 完成态为 REVISION_TASK_COMPLETE（completion
  // 内 classifyTerminalStatus 消费 revisionTaskSuccess）。
  if (revisionTaskSuccess) {
    return draftPath();
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
      // M14.4 P0-3：模型预算耗尽 → 不再派发修订（优雅降级到 overflow / Draft）
      if (budgetStop !== null) {
        return budgetStopPath();
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
      const experimentContext = await services.experimentPackages.workflowContext(ctx.projectId);
      const result = await services.researcher.research({ projectId: ctx.projectId, experimentContext });
      // M9.7.4：待审候选数随 stage 结果暴露（planEvidenceSupply 纯函数消费，
      // 决定是否在写作前呈现 evidence-supply HITL；实际有界供给由 evidence.ground 执行）
      const pendingCandidates = (await services.candidates.list(ctx.projectId, "pending_review")).length;
      return {
        taskId: result.taskId,
        reportPath: result.reportPath,
        evidenceCount: result.evidenceAppended,
        evidenceProposed: result.evidenceProposed,
        bibliographyCount: result.bibliographyCount,
        gaps: result.report.researchGaps.length,
        candidatePending: pendingCandidates,
        confirmedExperimentObservations: experimentContext.observations.length,
        experimentContextTruncated: experimentContext.truncated,
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
      const supply = ctx.state.workflowKind === "idea_to_paper"
        ? await supplyResearchEvidence(
            services, ctx.projectId, await requireResearchArtifact(services, ctx.projectId),
            {
              signal: ctx.signal,
              progress: (phase, counts) => ctx.log(`[research-evidence-supply:${phase}] ${JSON.stringify(counts)}`),
            },
          )
        : undefined;
      if (supply !== undefined) ctx.log(`[research-evidence-supply] ${JSON.stringify(supply)}`);
      const summary = await services.evidenceGrounding.groundPending(ctx.projectId, { signal: ctx.signal });
      return {
        ...(supply !== undefined ? { researchSupply: supply } : {}),
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

// ============================================================
// M12 A9：Target Publication Intelligence stages
//（target.benchmark → target.profile → target.readiness，插在 feasibility 之前）
// ============================================================

/** target stage 的显式 no-op 结果（零模型调用 / 零 HITL；终态语义不变） */
function targetSkipResult(reason: string): Record<string, unknown> {
  return { skipped: true, reason };
}

/**
 * target 三 stage 的 advisory 纪律兜底（M12.0 §15：Target Readiness 不阻断）：
 * discovery / 提取 / 评估的失败（未配置检索 provider、网络、artifact 损坏等）
 * 如实记入 stage result（reason 带错误码与消息），但**不使主 workflow 失败**——
 * target 参照系缺席时下游 stage 以「benchmark 未冻结」显式 no-op。产品语义：
 * 目标智能增强写作流程，绝不改变既有 workflow 终态。
 */
function targetAdvisoryReason(error: unknown): string {
  const code = error instanceof BusinessError ? error.code : error instanceof Error ? error.name : "unknown";
  const message = error instanceof Error ? error.message : String(error);
  return `target 参照系建立失败（${code}：${message}）——advisory 语义不阻断主流程`;
}

/**
 * target.benchmark：benchmark 语料冻结。三层 no-op 判定（诚实跳过，不静默）：
 * 1. services.targets 未接线（旧栈 / target 未配置部署）；
 * 2. benchmark artifact 已冻结 → 幂等返回（resume ≠ refresh 纪律——普通 run
 *    不得改写已冻结参照系，更新走显式 refresh）；
 * 3. 项目未配置 researchField（discovery 的确定性检索词来源；无字段无从检索）。
 * 配置齐全且未冻结 → discoverAndFreeze（A6 默认流程：auto-select 8–15、
 * 零暂停）。requiresAttention 四触发（<5 篇 / venue 歧义 / venue 未解析 /
 * 空检索）如实透传——advisory 语义照常继续，profile/readiness 按语料事实
 * 降级 INSUFFICIENT_EVIDENCE，不新增任何 HITL 暂停。
 */
function targetBenchmarkStage(services: WorkflowServices): StageSpec {
  return {
    id: "target.benchmark",
    description:
      "Target benchmark 语料发现与冻结（venue 过滤检索 + 引用数排序 auto-select 8–15 篇；未配置 / 已冻结 / 未接线 → 显式 no-op）",
    requiredInputs: [],
    producedOutputs: ["research/target-benchmark.json（配置 target 时）"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs,
    retryable: ["transient", "timeout", "runtime_unavailable"],
    async execute(ctx) {
      if (services.targets === undefined) {
        return targetSkipResult("target services 未接线（services.targets 缺省）——no-op");
      }
      const existing = await services.targets.benchmark.get(ctx.projectId);
      if (existing !== null) {
        return {
          skipped: false,
          alreadyFrozen: true,
          revision: existing.revision,
          papers: effectiveTargetPaperCount(existing.papers),
          sufficiency: existing.selection?.sufficiency ?? null,
          requiresAttention: existing.selection?.requiresAttention ?? [],
        };
      }
      const project = await services.projects.getRequired(ctx.projectId);
      const researchField = project.researchField?.trim() ?? "";
      if (researchField === "") {
        return targetSkipResult(
          "项目未配置 researchField（benchmark discovery 的确定性检索词来源）——无 target 参照系可建立，no-op",
        );
      }
      let result: Awaited<ReturnType<typeof services.targets.discovery.discoverAndFreeze>>;
      try {
        result = await services.targets.discovery.discoverAndFreeze(ctx.projectId, {
          target: {
            documentType: project.documentType ?? "",
            targetProfile: project.targetProfile ?? "",
            ...(project.targetVenue !== undefined && project.targetVenue.trim() !== ""
              ? { targetVenue: project.targetVenue.trim() }
              : {}),
            researchField,
          },
        });
      } catch (error) {
        // advisory 兜底：未配置检索 provider / 网络 / 检索失败——如实记录，不阻断主 workflow
        return targetSkipResult(targetAdvisoryReason(error));
      }
      return {
        skipped: false,
        alreadyFrozen: result.alreadyFrozen,
        revision: result.artifact.revision,
        papers: effectiveTargetPaperCount(result.artifact.papers),
        savedSourceIds: result.savedSourceIds.length,
        venueDegraded: result.discovery.venueDegraded,
        sufficiency: result.selection.selection.sufficiency,
        requiresAttention: result.selection.selection.requiresAttention,
      };
    },
  };
}

/** target.profile：确定性提取 + bounded method/writing 摘要（freshness 保证） */
function targetProfileStage(services: WorkflowServices): StageSpec {
  return {
    id: "target.profile",
    description: "Target Profile 提取（分位带 + bounded method/writing 摘要；benchmark 未冻结 / 未接线 → no-op）",
    requiredInputs: ["target.benchmark"],
    producedOutputs: ["research/target-profile.json（配置 target 时）"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs,
    retryable: ["transient", "timeout", "runtime_unavailable", "contract_violation"],
    async execute(ctx) {
      if (services.targets === undefined) {
        return targetSkipResult("target services 未接线——no-op");
      }
      let benchmark: Awaited<ReturnType<typeof services.targets.benchmark.get>>;
      try {
        benchmark = await services.targets.benchmark.get(ctx.projectId);
      } catch (error) {
        // artifact 损坏 fail-closed 抛错——advisory 兜底：记录后继续（不阻断主 workflow）
        return targetSkipResult(targetAdvisoryReason(error));
      }
      if (benchmark === null) {
        return targetSkipResult("benchmark 语料未冻结（target.benchmark 为 no-op）——profile 无数据源");
      }
      let current: Awaited<ReturnType<typeof services.targets.profile.ensureCurrent>>;
      try {
        current = await services.targets.profile.ensureCurrent(ctx.projectId);
      } catch (error) {
        return targetSkipResult(targetAdvisoryReason(error));
      }
      const { profile, regenerated } = current;
      return {
        skipped: false,
        regenerated,
        benchmarkRevision: profile.benchmarkRevision,
        n: profile.n,
        availability: Object.fromEntries(
          (Object.keys(profile.dimensions) as Array<keyof typeof profile.dimensions>).map((name) => [
            name,
            profile.dimensions[name].availability,
          ]),
        ),
      };
    },
  };
}

/**
 * target.readiness：当前稿 × profile → 四档判决。无手稿（idea_to_paper 前段）
 * → INSUFFICIENT_EVIDENCE 产物（诚实「无观测点」），不 crash 不阻断。
 */
function targetReadinessStage(services: WorkflowServices): StageSpec {
  return {
    id: "target.readiness",
    description: "Target Readiness 评估（六维四档 advisory 判决 + 结构化差距；无手稿 → INSUFFICIENT_EVIDENCE 产物）",
    requiredInputs: ["target.profile"],
    producedOutputs: ["research/target-readiness.json（配置 target 时）"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs,
    retryable: ["transient", "timeout"],
    async execute(ctx) {
      if (services.targets === undefined) {
        return targetSkipResult("target services 未接线——no-op");
      }
      let benchmark: Awaited<ReturnType<typeof services.targets.benchmark.get>>;
      try {
        benchmark = await services.targets.benchmark.get(ctx.projectId);
      } catch (error) {
        return targetSkipResult(targetAdvisoryReason(error));
      }
      if (benchmark === null) {
        return targetSkipResult("benchmark 语料未冻结（target.benchmark 为 no-op）——readiness 无参照系");
      }
      let artifact: Awaited<ReturnType<typeof services.targets.gap.evaluate>>;
      try {
        artifact = await services.targets.gap.evaluate(ctx.projectId);
      } catch (error) {
        return targetSkipResult(targetAdvisoryReason(error));
      }
      return {
        skipped: false,
        overall: artifact.overall.verdict,
        verdicts: Object.fromEntries(artifact.dimensions.map((entry) => [entry.dimension, entry.verdict])),
        manuscriptRevision: artifact.manuscriptRevision,
      };
    },
  };
}

/** M12 A9：target 三 stage 工厂（idea_to_paper / existing_paper_improvement 共用） */
export function targetStages(services: WorkflowServices): StageSpec[] {
  return [targetBenchmarkStage(services), targetProfileStage(services), targetReadinessStage(services)];
}

/** 冻结语料的有效条目数（未 excluded） */
function effectiveTargetPaperCount(papers: Array<{ excluded?: unknown }>): number {
  return papers.filter((paper) => paper.excluded === undefined).length;
}

/**
 * M12 A9 消费入口：目标实证参照系块（profile fresh + 最新 readiness）。
 * 任一前提不满足（未接线 / 未冻结 / profile 陈旧且未重建 / readiness 未评估 /
 * 产物损坏）→ undefined（消费端 prompt 与旧版逐字节一致，不因 target 缺席
 * 改变既有行为）。这里只读不建：重建（LLM 摘要）只发生在 target.profile
 * stage / ensureCurrent 显式调用。
 */
async function readTargetReferenceBlock(
  services: WorkflowServices,
  projectId: string,
): Promise<string | undefined> {
  if (services.targets === undefined) {
    return undefined;
  }
  try {
    const envelope = await services.targets.profile.get(projectId);
    const readiness = await services.targets.gap.get(projectId);
    return (
      renderTargetReferenceBlock(envelope !== null && envelope.fresh ? envelope.profile : null, readiness) ?? undefined
    );
  } catch {
    return undefined; // 损坏产物不阻断主流程（fail-closed 语义在 target.* stage 内）
  }
}

/** M12 A9：Reviewer academic 模式的目标带数值期望块（fresh profile 才注入） */
async function readTargetExpectationsBlock(
  services: WorkflowServices,
  projectId: string,
): Promise<string | undefined> {
  if (services.targets === undefined) {
    return undefined;
  }
  try {
    const envelope = await services.targets.profile.get(projectId);
    return renderTargetExpectationsBlock(envelope !== null && envelope.fresh ? envelope.profile : null) ?? undefined;
  } catch {
    return undefined;
  }
}

/** M12 A9：Planner 的目标带差距 digest（readiness 存在才注入；advisory 不立项） */
async function readPlannerTargetDigest(
  services: WorkflowServices,
  projectId: string,
): Promise<string | undefined> {
  if (services.targets === undefined) {
    return undefined;
  }
  try {
    return renderPlannerTargetDigest(await services.targets.gap.get(projectId));
  } catch {
    return undefined;
  }
}

/** M12 A9：Quality Gate 的 targetReadiness advisory 投影（readiness 存在才透传） */
async function readTargetReadinessAdvisory(
  services: WorkflowServices,
  projectId: string,
) {
  if (services.targets === undefined) {
    return undefined;
  }
  try {
    return readinessGateAdvisory(await services.targets.gap.get(projectId));
  } catch {
    return undefined;
  }
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
      // M12 A9：目标实证参照系（fresh profile + 最新 readiness；陈旧/缺失/
      // 未接线 → 不注入，prompt 与旧版逐字节一致）
      const targetReference = await readTargetReferenceBlock(services, ctx.projectId);
      // M13.6：实验数据使用口径（范围级授权视图，无具体数值）——可行性评估
      // 据此区分「作者已授权数据可用」与「真实待补实验」
      const experimentPolicyLines = renderExperimentPolicyLines(
        await services.experimentPackages.experimentPolicy(ctx.projectId),
      );
      const result = await services.feasibility.assess({
        projectId: ctx.projectId,
        research: artifact.report,
        evidenceStats,
        ...(id === "assessment.target" ? { assessKind: "existing_paper" as const } : {}),
        ...(targetReference !== undefined ? { targetReference } : {}),
        experimentPolicyLines,
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
      // M13.6（NB-11）：大纲 / 摘要与正文共享同一实验数值纪律——授权观测表
      // 注入大纲规划（无授权 = 摘要 / keyPoints 禁写具体数值）
      const experimentContext = await services.experimentPackages.workflowContext(ctx.projectId);
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
        ...(experimentContext !== undefined ? { experimentContext } : {}),
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
      prompt: requiredInputs.includes("hitl.outline_confirm")
        ? "研究发现了一批候选文献，当前证据仍有缺口。idea_to_paper 已在写作前尝试有界入库、全文定位和三段核验。无法获取全文或核验支持关系的材料仍不能作为正式证据；可补充文献或全文，也可继续写作并保留缺口。"
        : "研究发现了一批待审候选文献，而当前已核验（verified）证据只覆盖少数来源。你可以先在「文献发现」页审阅并 Promote 候选文献（入库并获取全文后，重新运行研究阶段可扩大证据池、提高后续引用的证据覆盖），也可以直接以当前证据继续写作。",
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
          ...(ctx.state.stageResults["evidence.ground"]?.["researchSupply"] !== undefined
            ? { automaticSupply: ctx.state.stageResults["evidence.ground"]!["researchSupply"] } : {}),
          action: ctx.state.workflowKind === "idea_to_paper"
            ? "查看自动供给诊断；补充可访问全文或带 chunk 锚点的证据。未核验缺口不能正式引用。"
            : "在「文献发现」页 Promote 候选 → 文献库获取全文 → 重跑研究（或本 run 直接 continue 使用现有证据）",
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
  const supply = state.stageResults["evidence.ground"]?.["researchSupply"] as { verified?: number } | undefined;
  if ((supply?.verified ?? 0) > 0) return null;
  const research = state.stageResults["research.idea"] ?? {};
  const pending = typeof research["candidatePending"] === "number" ? research["candidatePending"] : 0;
  return pending >= EVIDENCE_SUPPLY_MIN_PENDING ? { kind: "stage", stageId: "hitl.evidence_supply" } : null;
}

// ============================================================
// M13.7.10：章节论证单元写作计划（可追溯产物）与只读学术重复报告
// ============================================================

/** 计划指纹：大纲结构字段 + 正式证据集合（id / 状态 / 锚点）+（Survey）matrix 指纹——同输入恒同计划 */
function writingPlanFingerprint(
  outline: import("../manuscript/ManuscriptService.js").Outline,
  formal: readonly EvidenceRecord[],
  extra?: string,
): string {
  return fingerprintJson({
    sections: outline.sections.map((section) => ({
      id: section.id,
      title: section.title,
      keyPoints: section.keyPoints ?? [],
      targetLengthWords: section.targetLengthWords ?? null,
      synthesisRefs: section.synthesisRefs ?? [],
      literatureRefs: section.literatureRefs ?? [],
      argument: section.argument ?? null,
    })),
    evidence: formal
      .map((record) => ({ id: record.id, status: record.verificationStatus, chunk: record.location?.chunk ?? null, support: record.supportStrength ?? null }))
      .sort((a, b) => a.id.localeCompare(b.id)),
    ...(extra !== undefined ? { extra } : {}),
  });
}

function planSectionRecord(
  unit: ResolvedArgumentUnit,
  allocation: SectionEvidenceAllocation,
  citationKeys: { evidenceBacked: string[]; allowed?: string[] },
): WritingPlanSectionRecord {
  return {
    sectionId: unit.sectionId,
    title: unit.title,
    role: unit.role,
    roleSource: unit.roleSource,
    roleConfidence: unit.roleConfidence,
    taskSummary: summarizeArgumentTask(unit),
    doNotExplain: unit.doNotExplain,
    targetLengthUpperBound: unit.targetLengthUpperBound,
    lengthSource: unit.lengthSource,
    evidence: {
      allocated: allocation.evidenceIds,
      consumed: [],
      pinned: allocation.pinned,
      pinnedRejected: allocation.pinnedRejected,
      coverageAdded: allocation.coverageAdded,
      partial: allocation.partialIds,
    },
    citationKeys: {
      evidenceBacked: citationKeys.evidenceBacked,
      ...(citationKeys.allowed !== undefined ? { allowed: citationKeys.allowed } : {}),
    },
    diagnostics: [...unit.warnings, ...allocation.diagnostics],
    status: "planned",
  };
}

/**
 * 写作前落盘计划（reviews/writing-plan.json）。同一项目再次写作（重试 / Resume /
 * 重新生成）时：指纹相同 → attempt 递增、计划不变；指纹不同（Outline 或正式证据集合
 * 变化）→ 如实记录 previousFingerprint——Writer 只消费当前有效证据，不沿用旧绑定。
 */
async function beginWritingPlan(
  services: WorkflowServices,
  ctx: { projectId: string; runId: string },
  input: {
    mode: WritingPlanArtifact["mode"];
    outline: import("../manuscript/ManuscriptService.js").Outline;
    units: readonly ResolvedArgumentUnit[];
    fingerprint: string;
    sections: WritingPlanSectionRecord[];
    unassignedEvidence: string[];
    warnings: string[];
  },
): Promise<WritingPlanArtifact> {
  const previous = await services.reviewArtifacts.loadWritingPlan(ctx.projectId);
  const now = new Date().toISOString();
  const sameRun = previous?.runId === ctx.runId;
  /**
   * M14.1a P0-3：同一 run 内 stage retry / 进程重启恢复时，输入指纹未变且磁盘
   * 输出仍与完成记录的 outputHash 一致的章节保留 written 状态（写作循环据此
   * 跳过，不重复生成）。指纹变化（大纲 / 正式证据集合变化）或输出被外部改动
   * 的章节回落为 planned 重写——「跳过」必须同时核验输入版本与输出产物。
   */
  const resumableSections = sameRun && previous !== null && previous.fingerprint === input.fingerprint
    ? await Promise.all(previous.sections.map(async (section) =>
        section.status === "written" && section.outputHash !== undefined
          ? await sectionOutputMatches(services, ctx.projectId, section)
          : false))
    : [];
  const resumeById = new Map<string, WritingPlanSectionRecord>();
  if (previous !== null) {
    previous.sections.forEach((section, index) => {
      if (resumableSections[index] === true) resumeById.set(section.sectionId, section);
    });
  }
  const plan: WritingPlanArtifact = {
    schemaVersion: 1,
    mode: input.mode,
    runId: ctx.runId,
    createdAt: sameRun && previous !== null ? previous.createdAt : now,
    updatedAt: now,
    fingerprint: input.fingerprint,
    ...(previous !== null && previous.fingerprint !== input.fingerprint ? { previousFingerprint: previous.fingerprint } : {}),
    attempt: sameRun && previous !== null ? previous.attempt + 1 : 1,
    sections: input.sections.map((section) => resumeById.get(section.sectionId) ?? section),
    unassignedEvidence: input.unassignedEvidence,
    warnings: [
      ...input.warnings,
      ...(previous !== null && previous.fingerprint !== input.fingerprint
        ? [sameRun
            ? "同一 run 内重试时大纲或正式证据集合已变化：本次按当前有效证据重新分配（旧绑定不再视为 Verified）"
            : "相对上一次写作，大纲或正式证据集合已变化：本次按当前有效证据重新分配"]
        : []),
    ],
  };
  await services.reviewArtifacts.saveWritingPlan(ctx.projectId, plan);
  return plan;
}

/** M14.1a P0-3：章节文件当前内容是否仍等于完成记录的 outputHash（缺文件/空/被改 = false） */
async function sectionOutputMatches(
  services: WorkflowServices,
  projectId: string,
  record: WritingPlanSectionRecord,
): Promise<boolean> {
  if (record.outputHash === undefined || record.fileName === undefined) {
    return false;
  }
  try {
    const content = await readFile(join(services.projects.manuscriptDir(projectId), "sections", record.fileName), "utf8");
    return content.trim() !== "" && sha256Hex(content) === record.outputHash;
  } catch {
    return false;
  }
}

/** M14.1a P0-3：可恢复（跳过重写）的已完成章节：written + 磁盘输出与 outputHash 一致 */
async function resumableWrittenSection(
  services: WorkflowServices,
  projectId: string,
  plan: WritingPlanArtifact,
  sectionId: string,
  fileName: string,
): Promise<WritingPlanSectionRecord | null> {
  const record = plan.sections.find((section) => section.sectionId === sectionId);
  if (record === undefined || record.status !== "written") {
    return null;
  }
  if (record.fileName !== fileName) {
    return null; // 大纲文件映射变化（指纹虽同但文件重命名）——保守重写
  }
  return (await sectionOutputMatches(services, projectId, record)) ? record : null;
}

async function updateWritingPlanSection(
  services: WorkflowServices,
  projectId: string,
  plan: WritingPlanArtifact,
  sectionId: string,
  update: { status: WritingPlanSectionRecord["status"]; latencyMs: number; taskId?: string; usage?: unknown; cited?: string[]; outputHash?: string },
): Promise<void> {
  const record = plan.sections.find((section) => section.sectionId === sectionId);
  if (record === undefined) {
    return;
  }
  record.status = update.status;
  record.latencyMs = update.latencyMs;
  if (update.taskId !== undefined) record.taskId = update.taskId;
  if (update.usage !== undefined) record.usage = update.usage;
  if (update.outputHash !== undefined) record.outputHash = update.outputHash;
  else if (update.status !== "written") record.outputHash = undefined;
  if (update.status === "written") {
    record.evidence.consumed = [...record.evidence.allocated];
  }
  if (update.cited !== undefined) record.citationKeys.cited = [...new Set(update.cited)].sort();
  plan.updatedAt = new Date().toISOString();
  await services.reviewArtifacts.saveWritingPlan(projectId, plan);
}

/** stage 结果里的有界摘要（checkpoint 可序列化；完整计划在 reviews/writing-plan.json） */
function summarizeWritingPlan(plan: WritingPlanArtifact): Record<string, unknown> {
  return {
    enabled: true,
    fingerprint: plan.fingerprint.slice(0, 16),
    attempt: plan.attempt,
    sections: plan.sections.map((section) => ({
      id: section.sectionId,
      role: section.role,
      roleSource: section.roleSource,
      evidence: section.evidence.allocated.length,
      pinnedRejected: section.evidence.pinnedRejected.length,
      upperBound: section.targetLengthUpperBound,
      diagnostics: section.diagnostics.length,
    })),
    unassignedEvidence: plan.unassignedEvidence.length,
    warnings: plan.warnings.length,
  };
}

const REDUNDANCY_REPORT_KNOWN_LIMITATIONS = [
  "词面 + 位置规则，不是语义等价证明；类别判据与阈值回显在 thresholds。",
  "改写过的引言预展开可能召回不足（M13.7.9 盲区②）：P 类数字是下界。",
  "数学模式内的数字在探测器中被整体占位，不参与词面比对（M13.7.9 盲区③）。",
  "uncertain 条目不是事实错误，不计入有害下界；本报告不进入 Quality Gate，不触发任何自动删改。",
];

/** 全文草稿生成后生成只读 Academic Redundancy Report（按修订号落盘；失败不影响写作主流程） */
async function saveAcademicRedundancyReport(
  services: WorkflowServices,
  ctx: { projectId: string; runId: string },
  revision: number,
  sections: ReadonlyArray<{ id: string; title: string; latex: string }>,
  units: readonly ResolvedArgumentUnit[],
): Promise<Record<string, unknown> | undefined> {
  try {
    const roles = Object.fromEntries(units.map((unit) => [unit.sectionId, unit.role]));
    const report = classifyAcademicRedundancy(sections, { roles });
    await services.reviewArtifacts.saveAcademicRedundancy(ctx.projectId, {
      schemaVersion: 1,
      revision,
      runId: ctx.runId,
      createdAt: new Date().toISOString(),
      roles: report.roles,
      summary: report.summary,
      harmfulSentences: report.harmfulSentences,
      uncertainSentences: report.uncertainSentences,
      signpostSentences: report.signpostSentences,
      pairs: report.pairs.slice(0, 60),
      knownLimitations: REDUNDANCY_REPORT_KNOWN_LIMITATIONS,
    });
    return {
      revision,
      lexicalShare: Number(report.summary.lexical.restatedCharShare.toFixed(4)),
      harmfulShare: Number(report.summary.harmful.share.toFixed(4)),
      harmfulUpperShare: Number(report.summary.harmfulUpperShare.toFixed(4)),
      harmfulSentences: report.summary.harmful.sentenceCount,
      uncertainSentences: report.summary.uncertain.sentenceCount,
      classCounts: report.summary.classCounts,
    };
  } catch (error) {
    return { revision, error: error instanceof Error ? error.message.slice(0, 200) : String(error) };
  }
}

/** review.run：最新报告修订号 === 本轮审阅修订号时才注入（有界：至多 8 条有害句 + 计数） */
async function buildRedundancyDigest(
  services: WorkflowServices,
  projectId: string,
  reviewedRevision: number,
): Promise<string | undefined> {
  const report = await services.reviewArtifacts.latestAcademicRedundancy(projectId);
  if (report === null || report.revision !== reviewedRevision) {
    return undefined;
  }
  const lines = [
    `修订 rev-${report.revision}：词面复述占比 ${(report.summary.lexical.restatedCharShare * 100).toFixed(1)}%；有害重复占比下界 ${(report.summary.harmful.share * 100).toFixed(1)}%（${report.summary.harmful.sentenceCount} 句）/ 上界 ${(report.summary.harmfulUpperShare * 100).toFixed(1)}%（含 ${report.summary.uncertain.sentenceCount} 句 uncertain）。`,
  ];
  if (report.harmfulSentences.length === 0) {
    lines.push("未发现确定有害的跨章节重复句。");
  } else {
    lines.push("确定有害的重复句（类别：M 机制重述 / L 重复免责 / P 引言预展开 / S 路标模板 / X·E 逐字搬运）：");
    for (const sentence of report.harmfulSentences.slice(0, 8)) {
      lines.push(`- [${sentence.class}] ${sentence.section}：「${sentence.text.slice(0, 80)}」——${sentence.reason.slice(0, 80)}`);
    }
  }
  return lines.join("\n");
}

function writingSectionsStage(services: WorkflowServices): StageSpec {
  return {
    id: "writing.sections",
    description: "Writer 逐节写作（section-based；M13.7.10 章节论证单元 + 逐节证据分配）",
    requiredInputs: ["hitl.outline_confirm"],
    producedOutputs: ["manuscript/sections/*.tex", "manuscript/main.tex", "reviews/writing-plan.json"],
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
      // M13.5.4：作者确认 + 授权的实验观测是实验数值的唯一来源（Writer 文件工具
      // 已被工作区隔离挡在实验原始材料之外）；空上下文也要显式注入（禁写数值）
      const experimentContext = await services.experimentPackages.workflowContext(ctx.projectId);

      // M13.7.10：章节论证单元 + 逐节 Evidence 分配（B2 生产化）。关闭时回到
      // 旧组织（同一 formal 快照给每一节、「约 N 字」），prompt 与旧版逐字节一致。
      const argumentUnitsEnabled = services.writing?.argumentUnits ?? true;
      const allFormal = argumentUnitsEnabled
        ? (await services.evidenceSelection.selectForWriting(ctx.projectId, { limit: Number.MAX_SAFE_INTEGER })).formal
        : evidence;
      // M13 Final Closure（A3）：Planning → Writing 契约边界——与 partial 证据待核验命题词面重合的
      // 肯定式 keyPoints 加「待核验命题」标注（内存副本；落盘 outline / 分配 / 写作计划指纹按原始大纲）
      const keyPointGuard = annotateOutlinePartialKeyPoints(outline, allFormal);
      const writerOutline = keyPointGuard.outline;
      if (keyPointGuard.annotations.length > 0) {
        ctx.log(
          `[writing] partial keyPoint 守卫：${keyPointGuard.annotations.length} 条要点标注为待核验命题（${keyPointGuard.annotations.map((entry) => `${entry.sectionId}#${entry.keyPointIndex}→${entry.evidenceId}`).join("、")}）`,
        );
      }
      const units = argumentUnitsEnabled ? resolveArgumentUnits({ outline: writerOutline }) : undefined;
      const allocation =
        units !== undefined ? allocateSectionEvidence({ outline, units, evidence: allFormal }) : undefined;
      const plan =
        units !== undefined && allocation !== undefined
          ? await beginWritingPlan(services, ctx, {
              mode: "idea_to_paper",
              outline,
              units,
              fingerprint: writingPlanFingerprint(outline, allFormal),
              sections: units.map((unit, index) => {
                const sectionAllocation = allocation.sections[index]!;
                const consumed = projectAllocatedEvidence(sectionAllocation, allFormal);
                const record = planSectionRecord(unit, sectionAllocation, {
                  evidenceBacked: [...new Set(consumed.map((record) => resolveEvidenceCitationKey(record, bibliography)).filter((key): key is string => key !== null))].sort(),
                });
                record.fileName = outline.sections.find((section) => section.id === unit.sectionId)?.file ?? "";
                return record;
              }),
              unassignedEvidence: allocation.unassigned,
              warnings: units.flatMap((unit) => unit.warnings),
            })
          : undefined;

      let bytesTotal = 0;
      const written: string[] = [];
      const reused: string[] = [];
      const writtenLatex: Array<{ id: string; title: string; latex: string }> = [];
      const usedEvidenceIds = new Set<string>();
      for (const [index, section] of writerOutline.sections.entries()) {
        if (ctx.signal.aborted) {
          throw new BusinessError("WORKFLOW_CANCELLED", "写作已被取消");
        }
        // M14.1a P0-3：断点恢复——输入指纹未变且磁盘输出未被改动的已完成章节
        // 直接复用（零 Writer 调用）；重复报告 / usage 统计按原产物计入
        const resumed = plan !== undefined ? await resumableWrittenSection(services, ctx.projectId, plan, section.id, section.file) : null;
        if (resumed !== null) {
          reused.push(section.id);
          const content = await readFile(join(services.projects.manuscriptDir(ctx.projectId), "sections", section.file), "utf8");
          writtenLatex.push({ id: section.id, title: section.title, latex: content });
          for (const evidenceId of resumed.evidence.consumed) {
            usedEvidenceIds.add(evidenceId);
          }
          await ctx.emitProgress({ section: section.id, file: section.file, index: index + 1, total: outline.sections.length, resumed: true });
          continue;
        }
        const unit = units?.[index];
        const sectionAllocation = allocation?.sections[index];
        const sectionEvidence =
          sectionAllocation !== undefined ? projectAllocatedEvidence(sectionAllocation, allFormal) : evidence;
        const startedAt = Date.now();
        let result: Awaited<ReturnType<WriterService["writeSection"]>>;
        try {
          result = await services.writer.writeSection({
            projectId: ctx.projectId,
            section,
            outline: writerOutline,
            evidence: sectionEvidence,
            bibliography,
            experimentContext,
            ...(language !== undefined ? { language } : {}),
            ...(unit !== undefined ? { argument: unit } : {}),
            ...(unit?.role === "compare"
              ? { argumentPartialClaims: sectionEvidence.filter((record) => record.supportStrength === "partial").map((record) => record.claim) }
              : {}),
          });
        } catch (error) {
          if (plan !== undefined) {
            await updateWritingPlanSection(services, ctx.projectId, plan, section.id, { status: "failed", latencyMs: Date.now() - startedAt });
          }
          throw error;
        }
        bytesTotal += await services.manuscript.writeSection(ctx.projectId, section, result.latex);
        written.push(section.id);
        writtenLatex.push({ id: section.id, title: section.title, latex: result.latex });
        for (const record of sectionEvidence) {
          usedEvidenceIds.add(record.id);
        }
        if (plan !== undefined) {
          await updateWritingPlanSection(services, ctx.projectId, plan, section.id, {
            status: "written",
            latencyMs: Date.now() - startedAt,
            taskId: result.taskId,
            ...(result.usage !== undefined ? { usage: result.usage } : {}),
            cited: extractCitedKeyList(result.latex),
            // M14.1a P0-3：输出产物哈希（与 ManuscriptService.writeSection 的
            // 落盘内容同构：latex.trim() + 换行）——恢复跳过的版本核验依据
            outputHash: sha256Hex(result.latex.trim() + "\n"),
          });
        }
        await ctx.emitProgress({
          section: section.id,
          file: section.file,
          index: index + 1,
          total: outline.sections.length,
          ...(unit !== undefined ? { role: unit.role, evidence: sectionEvidence.length } : {}),
        });
      }
      for (const evidenceId of usedEvidenceIds) {
        await safeMarkUsage(services, ctx.projectId, evidenceId, ctx.runId);
      }
      await services.manuscript.writeMainTex(ctx.projectId, outline, bibliography.length > 0);
      await services.manuscript.rebuildContext(ctx.projectId, {
        evidenceStats: await services.evidence.stats(ctx.projectId),
      });
      // M9.5：初稿 bib 裁剪为实际引用集合（与正文同一修订号提交）
      await syncReferencesBib(services, ctx.projectId);
      // 初稿完成：提交首个内容修订
      const revision = await services.revisions.commit(ctx.projectId, "writing.sections", ctx.runId);
      const redundancy =
        units !== undefined
          ? await saveAcademicRedundancyReport(services, ctx, revision.revision, writtenLatex, units)
          : undefined;
      if (plan !== undefined) {
        plan.revision = revision.revision;
        plan.updatedAt = new Date().toISOString();
        await services.reviewArtifacts.saveWritingPlan(ctx.projectId, plan);
      }
      return {
        sectionsWritten: written.length,
        sections: written,
        ...(reused.length > 0 ? { sectionsReused: reused.length, reusedSections: reused } : {}),
        ...(reused.length > 0 ? { sectionsReused: reused.length, reusedSections: reused } : {}),
        bytesTotal,
        revision: revision.revision,
        evidenceFormal: argumentUnitsEnabled ? allFormal.length : evidenceSelection.formal.length,
        evidenceExcluded: evidenceSelection.excluded,
        ...(plan !== undefined ? { argumentUnits: summarizeWritingPlan(plan) } : { argumentUnits: { enabled: false } }),
        ...(redundancy !== undefined ? { redundancy } : {}),
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
    // M12 A9：target 三 stage（未配置 target / 未接线 → 显式 no-op，零行为变化）
    ...targetStages(services),
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
    // M12 A9：参照系先行（profile 供 feasibility/Reviewer/Writer 消费；
    // readiness 此时无手稿 → INSUFFICIENT_EVIDENCE 产物，诚实无观测点）
    "target.benchmark",
    "target.profile",
    "target.readiness",
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
      "Idea-to-Paper：（目标参照系，条件 no-op）→ 调研 → 可行性 → 确认 → 大纲 → 确认 →（证据供给提示，条件出现）→ 分节写作 → 引用核验 → 审稿 → Quality Gate →（bounded 修订 + 修订复核）→ 构建",
    stages,
    plan(state: WorkflowState): PlanDecision {
      // M14.9.4：第三方已发表论文只读评估不得进入调研 / 大纲 / 写作 / 修订 / 构建（都会生成或改写稿件）
      if (readReviewPurpose(state.request) === "published_paper_assessment") {
        return planPublishedAssessment(state);
      }
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

/**
 * M14.9.4：published_paper_assessment 的只读路径——review.run → quality.gate → 以 review 标签结束。
 * 生产 Gate 原样执行（规则 / 阈值不变），未通过也不进入修订；结论看 published-assessment 视图。
 */
function planPublishedAssessment(state: WorkflowState): PlanDecision {
  for (const stageId of ["review.run", "quality.gate"]) {
    if (!(stageId in state.stageResults)) {
      return { kind: "stage", stageId };
    }
  }
  const gate = state.stageResults["quality.gate"] ?? {};
  return {
    kind: "complete",
    label: "review",
    summary: {
      reviewPurpose: "published_paper_assessment",
      productionGatePassed: gate["passed"] === true,
      productionGateReasons: gate["reasons"] ?? [],
      publishedAssessment: gate["publishedAssessment"] ?? null,
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
      const baselinePath = join(services.projects.researchDir(ctx.projectId), "revision-baseline.json");
      /**
       * M14.8.1-MOT：同一项目上的后续改进 run（继续返修）会以当前修订重算事实基线——
       * 这是 Planner 需要的「当前稿件事实」。首次导入的基线（R0 投影）在被覆盖前归档一次
       * 到 revision-baseline-initial.json，保留完整 lineage（累计事实守卫的冻结基线始终是
       * revisions.json 的最早修订，不受本文件影响）。
       */
      let archivedInitial = false;
      try {
        const existing = JSON.parse(await readFile(baselinePath, "utf8")) as { contentHash?: unknown };
        const initialPath = join(services.projects.researchDir(ctx.projectId), "revision-baseline-initial.json");
        if (typeof existing.contentHash === "string" && existing.contentHash !== baseline.contentHash) {
          try {
            await readFile(initialPath, "utf8");
          } catch {
            await writeJsonAtomic(initialPath, existing);
            archivedInitial = true;
          }
        }
      } catch { /* 首次导入：无既有基线 */ }
      await writeJsonAtomic(baselinePath, baseline);
      return {
        contentHash: baseline.contentHash.slice(0, 12),
        tables: baseline.tables.length,
        citationKeys: baseline.citationKeys.length,
        figures: baseline.figures.length,
        hardware: baseline.hardware.length,
        placeholders: baseline.placeholders,
        ...(archivedInitial ? { archivedInitialBaseline: "research/revision-baseline-initial.json" } : {}),
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

function reviewEvidenceSupplyStage(services: WorkflowServices): StageSpec {
  return {
    id: "evidence.supply.review",
    description: "按审稿意见从已有本地 Sources 定向 grounding 并走现有 Evidence verification",
    requiredInputs: ["assessment.target"],
    producedOutputs: ["evidence/evidence.jsonl（verified 追加）"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs * 2,
    retryable: ["transient", "timeout", "runtime_unavailable"],
    async execute(ctx) {
      const instructions = await services.externalInstructions.load(ctx.projectId);
      const sourceItems = await services.sources.list(ctx.projectId);
      // Uploaded text / structured assets stay SourceStatus=pending after their
      // ParsedDocument is written; pending here means the legacy Source index
      // has not transitioned, not that the successfully parsed local Source is
      // unusable. Admit only a fresh, successful parsed document in that case.
      const sourceCandidates = await Promise.all(sourceItems.map(async (source) => {
        if (source.status === "failed" || source.status === "rejected") return null;
        if (source.status !== "pending") return source;
        const document = await services.ingestion.getDocument(ctx.projectId, source.sourceId).catch(() => null);
        return document !== null && document.status !== "failed" ? source : null;
      }));
      const sources = sourceCandidates.filter((source): source is NonNullable<typeof source> => source !== null);
      const evidenceBefore = await services.evidence.list(ctx.projectId);
      const result = instructions.length > 0 && sources.length > 0
        ? await services.targetedGrounding.groundClaims(ctx.projectId, instructions.slice(0, 10).map((instruction) => ({
            claimId: instruction.instructionId, claim: instruction.text.slice(0, 1200),
            section: instruction.section ?? "", sourceIds: selectReviewerSourceIds(instruction.text, sources),
          })), { signal: ctx.signal })
        : { outcomes: [], verifiedClaims: 0, verifiedEvidence: 0, unsupportedByJudge: 0 };
      const candidates = result.outcomes.reduce((sum, outcome) => sum + outcome.attempts.length, 0);
      const rejected = result.outcomes.reduce((sum, outcome) => sum + outcome.attempts.filter((attempt) => ["mismatch", "rejected", "unverifiable", "failed"].includes(attempt.outcome)).length, 0);
      const evidenceAfter = await services.evidence.list(ctx.projectId);
      const priorIds = new Set(evidenceBefore.map((record) => record.id));
      const protocolRejected = evidenceAfter.filter((record) => !priorIds.has(record.id) && record.protocolScope?.status === "superseded").length;
      const proposals = result.outcomes.reduce((sum, outcome) => sum + outcome.attempts.filter((attempt) => attempt.outcome !== "skipped").length, 0);
      return { sourcesConsidered: sources.length, chunksRetrieved: candidates, groundedCandidates: proposals, proposals, verified: result.verifiedEvidence, rejected, protocolRejected };
    },
  };
}

/**
 * M11.4 F23：冻结基线 ↔ 当前修订中逐字一致的表格块数值集合（字节级
 * lineage）。表格块 = \begin{table}…\end{table} 整块；一致性按去空白归一
 * 后字节比较。返回 null = 无冻结基线可比（口径不适用）。
 */
async function computeUnchangedTableNumbers(
  services: WorkflowServices,
  projectId: string,
): Promise<Set<string> | null> {
  const TABLE_BLOCK = /\\begin\{table\*?\}[\s\S]*?\\end\{table\*?\}/g;
  const numbersOf = (block: string): string[] => {
    const set = new Set<string>();
    for (const match of block.matchAll(/[-−]?\d+(?:\.\d+)?/g)) {
      const token = normalizeNumericTokenForTables(match[0] ?? "");
      if (token !== "") set.add(token);
    }
    return [...set];
  };
  const baseline = await loadFrozenBaseline(services, projectId, { existingPaper: true });
  if (baseline === null) return null;
  const currentRevision = await services.revisions.currentRevision(projectId);
  const currentFiles = await readSnapshotTex(services.revisions.snapshotDir(projectId, currentRevision));
  if (currentFiles === null) return null;
  const normalize = (text: string) => text.replace(/\s+/g, "");
  const baselineTables = new Map<string, string[]>();
  for (const file of baseline.files) {
    for (const block of file.content.matchAll(TABLE_BLOCK)) {
      const key = `${file.file}|${normalize(block[0] ?? "")}`;
      baselineTables.set(key, numbersOf(block[0] ?? ""));
    }
  }
  const result = new Set<string>();
  for (const file of currentFiles) {
    for (const block of file.content.matchAll(TABLE_BLOCK)) {
      const key = `${file.file}|${normalize(block[0] ?? "")}`;
      if (baselineTables.has(key)) {
        for (const token of numbersOf(block[0] ?? "")) result.add(token);
      }
    }
  }
  return result;
}

/** 表格数值归一（与 findingNumberTokens 同源：factPreservation.normalizeNumericToken） */
function normalizeNumericTokenForTables(token: string): string {
  return factPreservationNormalizeNumericToken(token);
}

/**
 * M11.4 Reliability Closure（F7）：意见 ↔ 基线章节词面相关提示（确定性，
 * 只提示不决策）。每条意见取词面重叠 ≥2 的章节标题 Top-3——Reviewer 前提
 * 可能已被基线反驳（「缺少 X 实验」而基线已有 X 小节），Planner 需要先看到
 * 这些章节才能给出 actionType=noop + coverageQuote 的合法闭环。
 */
function buildCommentTargetHints(
  commentAliases: readonly { ref: string; reviewerLabel?: string; text: string }[],
  logicalTargets: readonly { heading: string; logicalSection: string }[] | undefined,
): string[] {
  if (logicalTargets === undefined || logicalTargets.length === 0 || commentAliases.length === 0) {
    return [];
  }
  const hints: string[] = [];
  for (const alias of commentAliases) {
    const commentTerms = new Set(tokenizeText(alias.text).filter((token) => token.length >= 2));
    if (commentTerms.size === 0) {
      continue;
    }
    const scored = logicalTargets
      .map((target) => {
        const headingTerms = new Set([...tokenizeText(target.heading), ...tokenizeText(target.logicalSection)]);
        let shared = 0;
        for (const term of commentTerms) {
          if (headingTerms.has(term)) {
            shared += 1;
          }
        }
        return { target, shared };
      })
      .filter((entry) => entry.shared >= 2)
      .sort((a, b) => b.shared - a.shared || a.target.logicalSection.localeCompare(b.target.logicalSection))
      .slice(0, 3);
    if (scored.length > 0) {
      hints.push(
        `${alias.ref}${alias.reviewerLabel !== undefined ? `（${alias.reviewerLabel}）` : ""} 可能相关的基线章节：${scored.map((entry) => `${entry.target.heading}（${entry.target.logicalSection}）`).join("、")}`,
      );
    }
  }
  return hints;
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
      const coverageDigest = await buildCoverageDigest(services, ctx.projectId);
      const authorGoal = readAuthorGoal(ctx.state.request);
      // 确定性 id 清单：Writer 条目的 relatedEvidenceIds / instructionId 只能从中选取
      const [evidenceIds, instructions] = await Promise.all([
        services.evidence.list(ctx.projectId),
        services.externalInstructions.load(ctx.projectId),
      ]);
      const eligibleEvidence = plannerEligibleEvidence(evidenceIds);
      const aliasedInstructions = orderInstructionsForPlannerAliases(instructions, PLANNER_COMMENT_ALIAS_MAX);
      const commentAliases = buildPlannerAliases(aliasedInstructions, "C", (item) => item.instructionId).map((alias) => ({ ref: alias.ref, canonicalId: alias.canonicalId, text: alias.value.text, reviewerLabel: alias.value.reviewerLabel }));
      const evidenceAliases = buildPlannerAliases(eligibleEvidence, "EV", (item) => item.id).map((alias) => ({
        ref: alias.ref, canonicalId: alias.canonicalId, claim: alias.value.claim,
        provenance: `${alias.value.source?.title ?? alias.value.source?.sourceId ?? "source"}${alias.value.location?.chunk ? ` / ${alias.value.location.chunk}` : ""}`,
        protocolStatus: alias.value.protocolScope?.status ?? "unspecified",
        ...(alias.value.supportStrength ? { supportStrength: alias.value.supportStrength } : {}),
        ...(alias.value.verificationLevel ? { verificationLevel: alias.value.verificationLevel } : {}),
      }));
      const logicalTargets = files.sections.length === 0 && files.mainTex !== null
        ? locateLatexSections("main.tex", files.mainTex.content).map((span) => ({
            file: span.file,
            logicalSection: span.logicalSection,
            heading: span.heading,
            content: span.content,
            ...(span.label !== undefined ? { label: span.label } : {}),
          })).slice(0, 80)
        : undefined;
      /**
       * M11.4 Reliability Closure（F7，8c 实证 R1/R2）：评论前提可能已被基线
       * 反驳（R2「缺少部署实验」而基线已有 subsec:edge_deploy 全套数值；R1
       * 「参考文献不少于 20 篇」而基线已引 25 key）——Planner 输入此前没有
       * 「意见 ↔ 基线章节」的可见性，只能猜 modify / author_decision。此处
       * 注入确定性词面相关章节提示（只提示，不决策；noop 的确定性核验
       * verifyNoopCoverage 兜底错误引文）。
       */
      const commentTargetHints = buildCommentTargetHints(commentAliases, logicalTargets);
      // M12 A9：目标带 readiness 差距 digest（作者可选上下文；不自动立项——
      // 修订范围仍由外审意见与作者裁决主导；readiness 缺席 → 不注入，prompt 不变）
      const targetReadinessDigest = await readPlannerTargetDigest(services, ctx.projectId);
      const plan = await services.writer.planImprovement({
        projectId: ctx.projectId,
        issues: review?.issues ?? [],
        analysisDigest: `${artifact.report.domainOverview.slice(0, 400)}\n弱点：${artifact.report.researchGaps.slice(0, 5).join("；")}`,
        feasibilityLevel: feasibility?.level ?? "未评估",
        targetProfile: project.targetProfile,
        // 计划条目必须指向真实存在的章节文件（PDF 重建项目为 sections/secNN.tex）；
        // 单文件 LaTeX 项目 sections 为空 → 条目使用 main.tex
        sectionFiles: files.sections.map((file) => file.relativePath).slice(0, 20),
        ...(logicalTargets !== undefined ? { logicalTargets } : {}),
        ...(commentTargetHints.length > 0 ? { commentTargetHints } : {}),
        ...(baselineDigest !== undefined ? { baselineDigest } : {}),
        ...(coverageDigest !== undefined ? { coverageDigest } : {}),
        ...(authorGoal !== undefined ? { authorGoal } : {}),
        ...(targetReadinessDigest !== undefined ? { targetReadinessDigest } : {}),
        ...(feedback !== undefined ? { feedback } : {}),
        validEvidenceIds: eligibleEvidence.map((record) => record.id),
        validEvidenceProtocolScopes: Object.fromEntries(
          evidenceIds.flatMap((record) => record.protocolScope !== undefined ? [[record.id, record.protocolScope]] : []),
        ),
        validInstructionIds: instructions.map((instruction) => instruction.instructionId),
        externalInstructions: instructions.map((instruction) => ({
          instructionId: instruction.instructionId,
          text: instruction.text,
        })),
        commentAliases,
        evidenceAliases,
      });
      await writeJsonAtomic(
        join(services.projects.researchDir(ctx.projectId), "improvement-plan.json"),
        {
          generatedAt: new Date().toISOString(),
          // M11.4 Reliability Closure：落盘即赋稳定 id（improvement:N）——派发
          // 指令、意见 resolutionTrace、patch planItemIds 共用同一编号空间
          //（8c 实证：两个通道各自编号，同号不同条，lineage 错位）；同时执行
          // author-input 确定性重分类（modify 且 action 依赖作者确认 →
          // author_decision_required，Run 1 实证：不重分类则 Writer 把
          //【待作者确认】写进正文）
          plan: {
            ...plan,
            items: reclassifyAuthorInputActions(plan.items).map((item, index) => ({
              id: `improvement:${index + 1}`,
              ...item,
            })),
          },
        },
      );
      return {
        items: plan.items.length,
        evidenceLinkedItems: plan.items.filter((item) => (item.relatedEvidenceIds ?? []).length > 0).length,
        instructionLinkedItems: plan.items.filter((item) => item.instructionId !== undefined).length,
        evidenceSupply: ctx.state.stageResults["evidence.supply.review"] ?? { plannerEligibleEvidence: eligibleEvidence.length },
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
          // M14.8.1-MOT：计划批准即进入事实授权台账——HITL 必须展示全部条目（旧口径只给前 10 条，
          // M14.8 真实返修 26 条中 16 条作者从未看到即被批准）。上限只防病态体量，并如实报告总数。
          const allItems = plan.plan?.items ?? [];
          return {
            feasibilityLevel: feasibility?.level ?? null,
            items: allItems.slice(0, HITL_PLAN_ITEMS_MAX),
            totalItems: allItems.length,
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
    // M12 A9：target 三 stage（未配置 target / 未接线 → 显式 no-op，零行为变化）
    ...targetStages(services),
    citationVerifyStage(services),
    reviewRunStageInner(services, { existingPaper: true }),
    feasibilityStage(services, "assessment.target"),
    researchPlanStage(services),
    researchPlanConfirmStage(services),
    researchExecuteStage(services),
    evidenceSupplyStage(services, ["research.execute"]),
    researchProposeStage(services),
    evidenceGroundStage(services, ["research.propose"]),
    reviewEvidenceSupplyStage(services),
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
    // M12 A9：目标参照系在评估/审稿消费前建立（import 后 manuscript 已就绪，
    // readiness 有观测点；未配置 target → no-op）
    "target.benchmark",
    "target.profile",
    "target.readiness",
    "citation.verify",
    "review.run",
    "assessment.target",
    "research.plan",
    "hitl.research_plan",
    "research.execute",
  ];
  const frontPost = ["evidence.supply.review", "plan.improvement", "hitl.plan_confirm", "revision.apply"];

  return {
    kind: "existing_paper_improvement",
    description:
      "Existing-LaTeX Improvement：结构解析 → 基线编译 → 资产清单 → 事实基线 → 论文理解 →（目标参照系，条件 no-op）→ 引用审计 → 审稿 → 目标评估 →（M10.3：修订研究计划 → 批准 → 检索执行 → 证据供给提示 → 锚定提案 → 三段核验）→ 改进计划 → 确认 → 逐节改造 →（共享后段：复审 / Quality Gate / bounded 修订 + 修订复核 / 构建）→ Revision Trace 报告",
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
        // M13.6 限流恢复画像（等待 / 补查 / 补查成功）
        rateLimitRecovery: result.recovery,
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
          // M14.1c：显式覆盖块——实际审阅范围可证明；未完成审阅不得冒充 Full Review
          // （skipped 含 emptySections：reviewed + skipped = sectionsTotal 时全部
          // 章节有终态；failedSections > 0 或缺口未补齐 → complete=false）
          coverage: {
            reviewableSections: Number(sections["sectionsTotal"] ?? 0),
            reviewed: Number(sections["sectionsReviewed"] ?? 0),
            skipped: Number(sections["skippedSections"] ?? 0),
            failed: Array.isArray(sections["failedSections"]) ? sections["failedSections"].length : 0,
            complete:
              Array.isArray(sections["failedSections"]) && sections["failedSections"].length === 0
                ? Number(sections["sectionsReviewed"] ?? 0) + Number(sections["skippedSections"] ?? 0) >=
                  Number(sections["sectionsTotal"] ?? 0)
                : false,
          },
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
 * 推荐文献集（纯函数；HITL 决策与 stage 执行共用同一实现保证确定性）。
 *
 * M13.8：有研究计划上下文时按主题相关性 + 多查询命中 + 方法家族覆盖排序并选集
 * （survey/candidateRelevance.ts；low / uncertain / 近似重复不进推荐集）；无上下文
 * （旧 artifact / 单元测试）保持 M11.1.4 旧口径：学术形态（DOI / arXiv）优先、年份
 * 降序（缺年份排后）、candidateId 升序破平、上限 25。
 */
export function recommendedSurveyCandidateIds(
  candidates: readonly CandidateSource[],
  context?: SurveyRelevanceContext,
): string[] {
  if (context === undefined) {
    return legacyRecencyOrder(candidates)
      .slice(0, SURVEY_RECOMMENDED_MAX)
      .map((candidate) => candidate.candidateId);
  }
  const ranked = rankSurveyCandidates(candidates, context);
  return selectRecommendedCandidates(candidates, ranked, {
    ...(context.taxonomyFamilies !== undefined ? { familyOrder: context.taxonomyFamilies.map((family) => family.label) } : {}),
  }).candidateIds;
}

/**
 * 从项目与 research artifact 组装相关性上下文并给出推荐（M13.8）：主题 = 项目标题；
 * 检索词 = 活动计划的 academic 查询；方法家族 = surveyProfile.taxonomy；多查询命中 =
 * executionHistory 结果快照；年份范围 = run request。HITL payload、approve 缺省与
 * survey.search 的 recommended 计数共用这一个入口（同一上下文 → 同一推荐集）。
 */
export async function surveyRecommendation(
  services: Pick<WorkflowServices, "projects">,
  projectId: string,
  pending: readonly CandidateSource[],
  request: Record<string, unknown> | undefined,
): Promise<{ selection: RecommendationSelection; ranked: RankedCandidate[]; context: SurveyRelevanceContext }> {
  const [project, artifact] = await Promise.all([
    services.projects.getRequired(projectId),
    readResearchArtifact(services.projects, projectId),
  ]);
  const chain = artifact !== null ? readPlanChain(artifact) : null;
  const plan = chain?.plans.find((candidate) => candidate.planId === chain.activePlanId);
  const context: SurveyRelevanceContext = {
    topic: project.title,
    ...(plan !== undefined ? { queries: plan.queries.map((query) => ({ query: query.query, kind: query.kind })) } : {}),
    ...(artifact?.surveyProfile?.taxonomy !== undefined
      ? { taxonomyFamilies: artifact.surveyProfile.taxonomy.families }
      : {}),
    ...(artifact?.executionHistory !== undefined
      ? { queryHits: buildQueryHitCounts(artifact.executionHistory, plan?.planId) }
      : {}),
    ...(typeof request?.["yearFrom"] === "number" ? { yearFrom: request["yearFrom"] as number } : {}),
    ...(typeof request?.["yearTo"] === "number" ? { yearTo: request["yearTo"] as number } : {}),
  };
  const ranked = rankSurveyCandidates(pending, context);
  const selection = selectRecommendedCandidates(pending, ranked, {
    ...(context.taxonomyFamilies !== undefined ? { familyOrder: context.taxonomyFamilies.map((family) => family.label) } : {}),
  });
  return { selection, ranked, context };
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
      const recommendation = await surveyRecommendation(services, ctx.projectId, pending, ctx.state.request);
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
        recommended: recommendation.selection.candidateIds.length,
        recommendationBasis: recommendation.selection.basis,
        relevanceCounts: recommendation.selection.counts,
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
        "文献检索已完成，候选清单如下。默认入选「推荐集」（按主题相关性、多检索词命中与方法家族覆盖排序，剔除近似重复；无法确认相关性的候选如实标注，上限 25 篇）；确认后这些文献将入库（promote）并获取全文，进入综述矩阵构建。也可在决策 payload.candidateIds 中指定增删后的集合（candidateId 列表），或取消",
      options: ["approve", "cancel"],
      payload: async (ctx) => {
        const artifact = await readResearchArtifact(services.projects, ctx.projectId);
        const chain = artifact !== null ? readPlanChain(artifact) : null;
        const plan = chain?.plans.find((candidate) => candidate.planId === chain.activePlanId);
        const pending = await services.candidates.list(ctx.projectId, "pending_review");
        const sources = await services.sources.list(ctx.projectId);
        const recommendation = await surveyRecommendation(services, ctx.projectId, pending, ctx.state.request);
        const rankedById = new Map(recommendation.ranked.map((entry) => [entry.candidateId, entry]));
        const pendingById = new Map(pending.map((candidate) => [candidate.candidateId, candidate]));
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
          recommendedCandidateIds: recommendation.selection.candidateIds,
          recommendationBasis: recommendation.selection.basis,
          relevanceCounts: recommendation.selection.counts,
          familyCoverage: recommendation.selection.familyCoverage,
          nearDuplicatesSuppressed: recommendation.selection.nearDuplicatesSuppressed,
          // 展示顺序 = 相关性排序（推荐集在前），不再是候选创建顺序
          candidates: recommendation.ranked.slice(0, 40).flatMap((entry) => {
            const candidate = pendingById.get(entry.candidateId);
            if (candidate === undefined) {
              return [];
            }
            const ranked = rankedById.get(candidate.candidateId);
            return [
              {
                candidateId: candidate.candidateId,
                title: candidate.title ?? "(untitled)",
                ...(candidate.year !== undefined ? { year: candidate.year } : {}),
                ...(candidate.doi !== undefined ? { doi: candidate.doi } : {}),
                ...(candidate.arxivId !== undefined ? { arxivId: candidate.arxivId } : {}),
                origin: candidate.origin,
                ...(candidate.query !== undefined ? { query: candidate.query } : {}),
                ...(ranked !== undefined
                  ? {
                      relevance: {
                        label: ranked.relevance,
                        score: ranked.score,
                        queryHits: ranked.signals.queryHits,
                        familyMatches: ranked.signals.familyMatches,
                        reasons: ranked.reasons,
                        ...(ranked.signals.nearDuplicateOf !== undefined ? { nearDuplicateOf: ranked.signals.nearDuplicateOf } : {}),
                      },
                    }
                  : {}),
              },
            ];
          }),
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
    selected = (await surveyRecommendation(services, state.projectId, pending, state.request)).selection.candidateIds;
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
      // M13.7.10：Survey 的证据仍以本节 synthesisRefs / literatureRefs 投影为准（契约不变）；
      // 论证单元只增加 role / task / doNotExplain / 上限长度的组织约定与写作计划产物。
      const argumentUnitsEnabled = services.writing?.argumentUnits ?? true;
      // M13 Final Closure（A3）：同普通论文路径——partial 命题 keyPoints 标注（内存副本；指纹按原始大纲）
      const keyPointGuard = annotateOutlinePartialKeyPoints(inputs.outline, inputs.evidence);
      const writerOutline = keyPointGuard.outline;
      if (keyPointGuard.annotations.length > 0) {
        ctx.log(
          `[writing] partial keyPoint 守卫：${keyPointGuard.annotations.length} 条要点标注为待核验命题（${keyPointGuard.annotations.map((entry) => `${entry.sectionId}#${entry.keyPointIndex}→${entry.evidenceId}`).join("、")}）`,
        );
      }
      const units = argumentUnitsEnabled
        ? resolveArgumentUnits({ outline: writerOutline, synthesis: inputs.synthesis })
        : undefined;
      const contexts = writerOutline.sections.map((section) =>
        buildSurveySectionContext({
          section,
          matrix: inputs.matrix,
          synthesis: inputs.synthesis,
          bibliography: inputs.bibliography,
          evidence: inputs.evidence,
          titleBySource: inputs.titleBySource,
          yearBySource: inputs.yearBySource,
        }),
      );
      const plan =
        units !== undefined
          ? await beginWritingPlan(services, ctx, {
              mode: "topic_survey",
              outline: inputs.outline,
              units,
              fingerprint: writingPlanFingerprint(inputs.outline, inputs.evidence, inputs.synthesis.matrixFingerprint),
              sections: units.map((unit, index) => {
                const context = contexts[index]!;
                const ids = context.evidence.map((record) => record.id);
                const record = planSectionRecord(
                  unit,
                  {
                    sectionId: unit.sectionId,
                    role: unit.role,
                    evidenceIds: ids,
                    pinned: [],
                    pinnedRejected: [],
                    relevanceSelected: ids,
                    coverageAdded: [],
                    partialIds: context.evidence.filter((record) => record.supportStrength === "partial").map((record) => record.id),
                    diagnostics: context.warnings.map((warning) => `survey_context: ${warning}`),
                  },
                  { evidenceBacked: context.evidenceBackedKeys, allowed: context.allowedCitationKeys },
                );
                record.fileName = inputs.outline.sections.find((section) => section.id === unit.sectionId)?.file ?? "";
                return record;
              }),
              unassignedEvidence: [],
              warnings: units.flatMap((unit) => unit.warnings),
            })
          : undefined;
      const usedEvidenceIds = new Set<string>();
      let bytesTotal = 0;
      const written: string[] = [];
      const reused: string[] = [];
      const writtenLatex: Array<{ id: string; title: string; latex: string }> = [];
      for (const [index, section] of writerOutline.sections.entries()) {
        if (ctx.signal.aborted) {
          throw new BusinessError("WORKFLOW_CANCELLED", "写作已被取消");
        }
        // M14.1a P0-3：断点恢复（与 idea 路径同一语义：指纹 + outputHash 双核验）
        const resumed = plan !== undefined ? await resumableWrittenSection(services, ctx.projectId, plan, section.id, section.file) : null;
        if (resumed !== null) {
          reused.push(section.id);
          const content = await readFile(join(services.projects.manuscriptDir(ctx.projectId), "sections", section.file), "utf8");
          writtenLatex.push({ id: section.id, title: section.title, latex: content });
          for (const evidenceId of resumed.evidence.consumed) {
            usedEvidenceIds.add(evidenceId);
          }
          await ctx.emitProgress({ section: section.id, file: section.file, index: index + 1, total: inputs.outline.sections.length, resumed: true });
          continue;
        }
        const context = contexts[index]!;
        if (context.danglingSynthesisRefs.length > 0 || context.danglingLiteratureRefs.length > 0) {
          throw new BusinessError(
            "STAGE_CONTRACT_VIOLATION",
            `section ${section.id} 悬空 refs（synthesis：${context.danglingSynthesisRefs.join("、") || "无"}；literature：${context.danglingLiteratureRefs.join("、") || "无"}）——大纲与综合产物不一致，请重跑 survey.outline`,
          );
        }
        const unit = units?.[index];
        const startedAt = Date.now();
        let result: Awaited<ReturnType<WriterService["writeSection"]>>;
        try {
          result = await services.writer.writeSection({
            projectId: ctx.projectId,
            section,
            outline: writerOutline,
            evidence: context.evidence,
            bibliography: inputs.bibliography,
            ...(language !== undefined ? { language } : {}),
            survey: context,
            ...(unit !== undefined ? { argument: unit } : {}),
            ...(unit?.role === "compare"
              ? { argumentPartialClaims: context.evidence.filter((record) => record.supportStrength === "partial").map((record) => record.claim) }
              : {}),
          });
        } catch (error) {
          if (plan !== undefined) {
            await updateWritingPlanSection(services, ctx.projectId, plan, section.id, { status: "failed", latencyMs: Date.now() - startedAt });
          }
          throw error;
        }
        bytesTotal += await services.manuscript.writeSection(ctx.projectId, section, result.latex);
        written.push(section.id);
        writtenLatex.push({ id: section.id, title: section.title, latex: result.latex });
        for (const record of context.evidence) {
          usedEvidenceIds.add(record.id);
        }
        if (plan !== undefined) {
          await updateWritingPlanSection(services, ctx.projectId, plan, section.id, {
            status: "written",
            latencyMs: Date.now() - startedAt,
            taskId: result.taskId,
            ...(result.usage !== undefined ? { usage: result.usage } : {}),
            cited: extractCitedKeyList(result.latex),
            outputHash: sha256Hex(result.latex.trim() + "\n"), // M14.1a P0-3：恢复核验
          });
        }
        await ctx.emitProgress({
          section: section.id,
          file: section.file,
          index: index + 1,
          total: inputs.outline.sections.length,
          ...(unit !== undefined ? { role: unit.role, evidence: context.evidence.length } : {}),
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
      const redundancy =
        units !== undefined
          ? await saveAcademicRedundancyReport(services, ctx, revision.revision, writtenLatex, units)
          : undefined;
      if (plan !== undefined) {
        plan.revision = revision.revision;
        plan.updatedAt = new Date().toISOString();
        await services.reviewArtifacts.saveWritingPlan(ctx.projectId, plan);
      }
      return {
        sectionsWritten: written.length,
        sections: written,
        ...(reused.length > 0 ? { sectionsReused: reused.length, reusedSections: reused } : {}),
        bytesTotal,
        revision: revision.revision,
        synthesisItems: inputs.synthesis.items.length,
        matrixEntries: inputs.matrix.entries.length,
        bibliographyEntries: inputs.bibliography.length,
        evidenceFormal: inputs.evidence.length,
        ...(plan !== undefined ? { argumentUnits: summarizeWritingPlan(plan) } : { argumentUnits: { enabled: false } }),
        ...(redundancy !== undefined ? { redundancy } : {}),
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
// ============================================================
// M14.2 thesis_from_papers：研究成果输入集 → 学位论文
// ============================================================

/** thesis 工作流的服务束（serviceStack / testStack 装配；survey 等测试桩不提供） */
export interface ThesisWorkflowServices {
  planner: ThesisPlannerService;
  researchInputs: ResearchInputService;
  documents: ThesisDocumentService;
  /** 学位论文编译器（独立 600s 预算；与 thesisDocuments 共用实例） */
  latex: LatexCompiler;
  /** M14.3：继承表格资产 store（写作期插入 + gate/build 复核共用） */
  inheritedTables: InheritedTableAssetStore;
  /** M14.6：研究材料缺口台账（thesis.evidence_supply 同步；hitl.author_decision 消费） */
  missingMaterials?: MissingMaterialLedger;
  /** M14.6：范围缺口的有界模型提案（不自动调用；显式 API / smoke） */
  missingMaterialProposals?: MissingMaterialService;
  /** M14.6：双语摘要 + 关键词生成（thesis.abstract stage） */
  abstract?: ThesisAbstractService;
  /** 测试栈显式开启后，HITL resume 才允许 actor=test_fixture（生产不设=拒绝） */
  allowTestFixtureActor?: boolean;
}

/**
 * M14.6：把 Planner 的缺材料章判定 + storyline.scopeConcerns 同步进 MissingMaterialLedger
 * （确定性：A 类 planned_chapter_material / B 类 proposed_scope_gap 提案；已解决缺口重评估；
 * 重复执行幂等）。台账未装配 → null。
 */
async function syncMissingMaterialLedger(
  services: WorkflowServices,
  projectId: string,
  missingChapters: readonly ThesisChapterPlan[],
): Promise<{ created: number; unchanged: number; refreshed: number; staleMarked: number; resolved: number; blocking: number; total: number } | null> {
  const ledger = services.thesis.missingMaterials;
  if (ledger === undefined) return null;
  const mapping = await services.thesis.planner.loadMapping(projectId);
  const context = await services.thesis.researchInputs.plannerContext(projectId);
  const contributions = (await services.thesis.planner.loadContributions(projectId))?.items ?? [];
  const storyline = (await services.thesis.planner.loadStoryline(projectId))?.storyline ?? null;
  const proposals = [
    ...(mapping !== null
      ? deriveChapterMaterialGaps({ projectId, mapping, missingChapters, contributions, factContext: context })
      : []),
    ...deriveScopeGapProposals({ projectId, storyline, mapping, factContext: context }),
  ];
  const upsert = await ledger.upsertProposals(projectId, proposals);
  const reevaluated =
    mapping !== null
      ? await ledger.reevaluate(projectId, {
          chaptersWithUsableFacts: chaptersWithUsableFacts({ mapping, contributions, facts: context.facts }),
          currentMissingChapterIds: new Set(missingChapters.map((chapter) => chapter.chapterId)),
        })
      : { resolved: 0, unchanged: 0 };
  const gaps = await ledger.list(projectId);
  return {
    ...upsert,
    resolved: reevaluated.resolved,
    blocking: gaps.filter(isBlockingGap).length,
    total: gaps.length,
  };
}

/** M14.6：run 级模型预算是否已耗尽（plan() 前段派发模型 stage 前检查；无预算配置 → false） */
function thesisModelBudgetExhausted(services: WorkflowServices, state: WorkflowState): boolean {
  if (services.modelBudget === undefined) return false;
  const snapshot = services.modelBudget.snapshotSync(state.projectId, state.runId);
  return snapshot !== null && budgetExhausted(snapshot);
}

const THESIS_SCOPE_ROUND_CAP = 24;
const THESIS_CONFLICT_ROUND_CAP = 16;
const THESIS_AUTHOR_DECISION_ROUND_CAP = 12;

function thesisIngestStage(services: WorkflowServices): StageSpec {
  return {
    id: "thesis.ingest",
    description: "研究输入登记核验：解析状态就绪 + 确定性事实抽取/核验 + 跨输入冲突检测（幂等）",
    requiredInputs: [],
    producedOutputs: ["research/research-inputs.json", "research/scientific-facts.json"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs * 4,
    retryable: ["transient", "timeout", "runtime_unavailable"],
    async execute(ctx) {
      const registry = await services.thesis.researchInputs.list(ctx.projectId);
      if (registry.inputs.length === 0) {
        throw new BusinessError(
          "INVALID_REQUEST",
          "项目没有登记任何研究输入——先上传研究材料并经 /api/projects/:id/research-inputs 登记，再启动学位论文工作流",
        );
      }
      let parsed = 0;
      let extractedInputs = 0;
      const skipped: string[] = [];
      for (const input of registry.inputs) {
        if (ctx.signal.aborted) throw new BusinessError("WORKFLOW_CANCELLED", "工作流已被取消");
        await ctx.emitProgress({ input: input.inputId, parse: input.parse.status });
        if (input.parse.status === "pending") {
          await services.ingestion.ingest(ctx.projectId, input.version.sourceId);
          await services.thesis.researchInputs.registry.refreshParse(ctx.projectId, input.inputId);
        }
        const fresh = await services.thesis.researchInputs.list(ctx.projectId);
        const status = fresh.inputs.find((entry) => entry.inputId === input.inputId)?.parse.status ?? input.parse.status;
        if (status === "full_text" || status === "partial") {
          parsed += 1;
          await services.thesis.researchInputs.extractFacts(ctx.projectId, input.inputId);
          await services.thesis.researchInputs.verifyFacts(ctx.projectId, input.inputId);
          extractedInputs += 1;
        } else {
          skipped.push(`${input.inputId}(${status})`);
        }
      }
      await services.thesis.researchInputs.detectConflicts(ctx.projectId);
      const context = await services.thesis.researchInputs.plannerContext(ctx.projectId);
      if (parsed === 0) {
        throw new BusinessError(
          "STAGE_CONTRACT_VIOLATION",
          `没有任何研究输入可解析（${skipped.join("、")}）——材料不可用时不得继续学位论文工作流`,
        );
      }
      return {
        inputs: registry.inputs.length,
        parsed,
        factsExtractedInputs: extractedInputs,
        skippedInputs: skipped,
        conflictsUnresolved: context.conflicts.unresolved.length,
        pendingScopeDecisions: context.pendingDecisions.filter((item) =>
          item.type === "scope_decision" || item.type === "version_selection" || item.type === "unpublished_material_policy",
        ).length,
      };
    },
  };
}

function thesisContributionsStage(services: WorkflowServices): StageSpec {
  return {
    id: "thesis.contributions",
    description: "逐输入提取研究贡献提案（quote 逐字锚定；提案不等于作者确认）",
    requiredInputs: ["thesis.ingest"],
    producedOutputs: ["research/thesis-contributions.json"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs,
    retryable: ["transient", "timeout", "runtime_unavailable", "contract_violation"],
    async execute(ctx) {
      const result = await services.thesis.planner.extractContributions(ctx.projectId, { signal: ctx.signal });
      if (result.inputsProcessed === 0) {
        throw new BusinessError(
          "STAGE_CONTRACT_VIOLATION",
          `贡献提取没有处理任何输入（${result.skippedInputs.map((item) => `${item.inputId}:${item.reason}`).join("；")}）`,
        );
      }
      return {
        inputsProcessed: result.inputsProcessed,
        proposals: result.proposals,
        anchored: result.anchored,
        skippedInputs: result.skippedInputs.length,
        perInput: result.perInput,
      };
    },
  };
}

function thesisScopeVersionStage(services: WorkflowServices): StageSpec {
  return {
    id: "hitl.scope_and_version",
    description: "作者决定：研究输入入选/排除、版本选择、未发表材料政策、研究贡献确认（authorship 由作者声明，模型不得代答）",
    requiredInputs: ["thesis.contributions"],
    producedOutputs: ["research/author-decisions.jsonl"],
    hitl: {
      prompt:
        "请逐项决定：哪些研究材料入选学位论文、版本链跟随哪个版本、未发表材料是否允许纳入；并确认哪些研究贡献属于你本人完成的工作（贡献未确认前不能规划大纲）。",
      options: [
        "include",
        "exclude",
        "select_version",
        "allow_unpublished",
        "deny_unpublished",
        "confirm_facts",
        "confirm_contribution",
        "reject_contribution",
        "approve",
        "cancel",
      ],
      payload: async (ctx) => buildThesisScopePayload(services, ctx.projectId),
    },
  };
}

async function buildThesisScopePayload(services: WorkflowServices, projectId: string): Promise<Record<string, unknown>> {
  const context = await services.thesis.researchInputs.plannerContext(projectId);
  const contributions = await services.thesis.planner.loadContributions(projectId);
  const items = (contributions?.items ?? []).slice(0, 60);
  return {
    inputs: {
      proposed: context.inputs.proposed,
      included: context.inputs.included,
      excluded: context.inputs.excluded,
      preferredVersionByWork: context.inputs.preferredVersionByWork,
    },
    pendingDecisions: context.pendingDecisions,
    conflicts: {
      unresolved: context.conflicts.unresolved.slice(0, 20).map((conflict) => ({
        conflictId: conflict.conflictId,
        classification: conflict.classification,
        parties: conflict.parties.map((party) => `${party.raw}@${party.location}`),
      })),
    },
    contributions: items.map((item) => ({
      id: item.id,
      researchInputId: item.researchInputId,
      kind: item.kind,
      statement: item.statement,
      anchorStatus: item.anchorStatus,
      status: item.status,
    })),
    factCounts: {
      authorConfirmed: context.facts.authorConfirmed.length,
      sourceVerifiedUnconfirmed: context.facts.sourceVerifiedUnconfirmed.length,
      extractedOnly: context.facts.extractedOnly.length,
      conflicted: context.facts.conflicted.length,
    },
    hint: {
      include: { payload: { inputId: "ri-…" } },
      select_version: { payload: { workId: "w-…", preferredInputId: "ri-…" } },
      confirm_facts: { payload: { factIds: ["f…"] } },
      confirm_contribution: { payload: { contributionIds: ["c-…"] } },
    },
  };
}

function thesisFactConflictsStage(services: WorkflowServices): StageSpec {
  return {
    id: "hitl.fact_conflicts",
    description: "作者裁决：同实验异值冲突（adopt_fact / keep_both / request_material / defer；defer 不解除阻断）",
    requiredInputs: ["hitl.scope_and_version"],
    producedOutputs: ["research/author-decisions.jsonl"],
    hitl: {
      prompt:
        "以下研究事实存在未裁决的跨来源冲突（同一实验/指标出现不同数值）。请逐条裁决采用哪一方、并存声明、或向作者本人索取材料；未裁决前写作不得继续。",
      options: ["adopt_fact", "keep_both", "request_material", "defer", "approve", "cancel"],
      payload: async (ctx) => {
        const context = await services.thesis.researchInputs.plannerContext(ctx.projectId);
        return {
          unresolved: context.conflicts.unresolved.map((conflict) => ({
            conflictId: conflict.conflictId,
            classification: conflict.classification,
            severity: conflict.severity,
            parties: conflict.parties.map((party) => ({ factId: party.factId, raw: party.raw, location: party.location })),
          })),
          hint: { adopt_fact: { payload: { conflictId: "fc-…", adoptedFactId: "f…" } } },
        };
      },
    },
  };
}

function thesisStorylineStage(services: WorkflowServices): StageSpec {
  return {
    id: "thesis.storyline",
    description: "研究主线 + 两级大纲 + 章节—来源映射规划（模型提案；确定性校验：贡献/输入/事实引用、每节恰属一章）",
    requiredInputs: ["hitl.scope_and_version"],
    producedOutputs: ["research/thesis-storyline.json", "manuscript/outline.json", "manuscript/thesis.json", "research/chapter-mapping.json"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs,
    retryable: ["transient", "timeout", "runtime_unavailable", "contract_violation"],
    async execute(ctx) {
      const project = await services.projects.getRequired(ctx.projectId);
      const feedback = readFeedback(ctx.state.inputs["hitl.outline_confirm"]?.payload);
      const result = await services.thesis.planner.planStoryline(ctx.projectId, {
        ...(feedback !== undefined ? { feedback } : {}),
        signal: ctx.signal,
        language: normalizeManuscriptLanguage(project.language),
      });
      return {
        structure: result.storyline.structure,
        narrative: result.storyline.narrative,
        ...(result.storyline.scopeConcerns !== undefined ? { scopeConcerns: result.storyline.scopeConcerns } : {}),
        chapters: result.chapters.length,
        sections: result.outline.sections.length,
        repairAttempts: result.repairAttempts,
        taskId: result.taskId,
      };
    },
  };
}

function thesisOutlineConfirmStage(services: WorkflowServices): StageSpec {
  return {
    id: "hitl.outline_confirm",
    description: "作者确认：学位论文大纲 + 章节—来源映射（确认后映射冻结；fragmented 主线须作者知情）",
    requiredInputs: ["thesis.storyline"],
    producedOutputs: ["research/chapter-mapping.json"],
    hitl: {
      prompt:
        "请审阅学位论文大纲与章节—来源映射：研究主线、章/节结构、每章拥有的研究贡献与来源输入、缺失材料提示。approve 确认后开始分章写作；revise 携带修改意见重新规划。",
      options: ["approve", "revise", "cancel"],
      payload: async (ctx) => {
        const storyline = await services.thesis.planner.loadStoryline(ctx.projectId);
        const mapping = await services.thesis.planner.loadMapping(ctx.projectId);
        const outline = await services.manuscript.loadOutline(ctx.projectId);
        const missing = await services.thesis.planner.missingMaterialChapters(ctx.projectId);
        return {
          storyline: storyline?.storyline ?? null,
          chapters: (mapping?.chapters ?? []).map((chapter) => ({
            chapterId: chapter.chapterId,
            titleZh: chapter.titleZh,
            responsibility: chapter.responsibility,
            goal: chapter.goal,
            sectionFiles: chapter.sectionFiles,
            ownsContributionIds: chapter.ownsContributionIds,
            sourceInputIds: chapter.sourceInputIds,
            factIds: chapter.factIds.length,
          })),
          outlineSections: outline?.sections.map((section) => ({ id: section.id, file: section.file, title: section.title })) ?? [],
          mappingStatus: mapping?.status ?? "missing",
          missingMaterialChapters: missing.map((chapter) => ({
            chapterId: chapter.chapterId,
            titleZh: chapter.titleZh,
            responsibility: chapter.responsibility,
          })),
        };
      },
    },
  };
}

function thesisEvidenceSupplyStage(services: WorkflowServices): StageSpec {
  return {
    id: "thesis.evidence_supply",
    description: "定向文献补证：绪论/综述主题 → 学术检索 → 候选 → 提升 → 全文 → 定向 grounding（有界 12/6/6）",
    requiredInputs: ["hitl.outline_confirm"],
    producedOutputs: ["sources/candidates.json", "evidence/evidence.jsonl"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs * 2,
    retryable: ["transient", "timeout", "runtime_unavailable"],
    async execute(ctx) {
      const outline = await services.manuscript.loadOutline(ctx.projectId);
      if (outline === null) {
        throw new BusinessError("STAGE_CONTRACT_VIOLATION", "缺少大纲（thesis.storyline 未落盘 outline.json）");
      }
      const themes = [
        ...new Set(
          outline.sections
            .flatMap((section) => section.literatureRefs ?? [])
            .map((ref) => ref.trim())
            .filter((ref) => ref !== ""),
        ),
      ].slice(0, 4);
      const missingChapters = await services.thesis.planner.missingMaterialChapters(ctx.projectId);
      const missingChapterIds = missingChapters.map((chapter) => chapter.chapterId);
      // M14.6：研究材料缺口台账同步（确定性提案 + 重评估；幂等）
      const materialGaps = await syncMissingMaterialLedger(services, ctx.projectId, missingChapters);
      if (themes.length === 0) {
        return {
          skipped: true,
          themes: 0,
          missingChapters: missingChapterIds,
          ...(materialGaps !== null ? { materialGaps } : {}),
          note: "大纲没有声明文献主题（literatureRefs 为空）——跳过检索补证",
        };
      }
      const queries: string[] = [];
      const candidatesSaved: number[] = [];
      let degraded = false;
      for (const theme of themes) {
        if (ctx.signal.aborted) throw new BusinessError("WORKFLOW_CANCELLED", "工作流已被取消");
        try {
          const response = await services.discovery.academicSearch(theme, { limit: 6 }, ctx.projectId);
          if (response.results.length === 0) {
            degraded = true;
            continue;
          }
          const saved = await services.discovery.saveAcademicCandidates(
            ctx.projectId,
            theme,
            response.results,
            response.results.map((_, index) => index).slice(0, 5),
          );
          queries.push(theme);
          candidatesSaved.push(saved.saved.length);
        } catch (error) {
          // 检索通道失败不阻断工作流：如实降级（综述章质量由 review/gate 判定）
          ctx.log(`thesis evidence supply 检索失败（${theme}）：${(error as Error).message}`);
          degraded = true;
        }
      }
      // 复用 M10.3 有界供给管线（候选 → 提升 → 全文 → chunk → 定向 grounding）
      const artifact = {
        report: {
          domainOverview: themes.join("。"),
          relatedWorkDirections: themes,
        },
        evidence: themes.map((theme) => ({ claim: `${theme}（学位论文文献综述主题，需要已核验的外部文献支撑）` })),
      } as unknown as ResearchArtifact;
      const supply = await supplyResearchEvidence(services, ctx.projectId, artifact, {
        signal: ctx.signal,
        progress: (phase, counts) => {
          void ctx.emitProgress({ phase, ...counts }).catch(() => undefined);
        },
      });
      return {
        skipped: false,
        themes: themes.length,
        queries,
        candidatesSaved: candidatesSaved.reduce((sum, count) => sum + count, 0),
        ...(degraded ? { degraded: true } : {}),
        supply,
        missingChapters: missingChapterIds,
        ...(materialGaps !== null ? { materialGaps } : {}),
      };
    },
  };
}

function thesisAuthorDecisionStage(services: WorkflowServices): StageSpec {
  return {
    id: "hitl.author_decision",
    description: "作者决定：缺实验材料的章（写成研究限制 / 暂缓该章 / 附实验包；不存在「编造数值继续写」选项）",
    requiredInputs: ["thesis.evidence_supply"],
    producedOutputs: ["research/author-decisions.jsonl"],
    hitl: {
      prompt:
        "以下章节声明了核心研究贡献，但没有可写的已确认实验事实。请作者决定处理方式：write_as_limitation（以研究限制口径撰写）、defer_chapter（暂缓，仍按限制口径占位）、attach_experiment_package（上传实验包并确认事实后继续）、pause（保持等待）。系统不会为缺失材料生成任何实验数值。",
      options: ["write_as_limitation", "defer_chapter", "attach_experiment_package", "supply_research_record", "supply_manuscript", "confirm_missing", "reject_gap", "pause", "approve", "cancel"],
      payload: async (ctx) => {
        const missing = await services.thesis.planner.missingMaterialChapters(ctx.projectId);
        // M14.6：材料缺口台账视图（A 类未决 + B 类建议；带 gapId 的决定经同一 resume 入口）
        const gaps = services.thesis.missingMaterials !== undefined ? await services.thesis.missingMaterials.list(ctx.projectId) : [];
        const openGaps = gaps.filter((gap) => gap.status === "proposed" || gap.status === "confirmed_missing" || gap.status === "supplied" || gap.stale !== undefined);
        return {
          missingChapters: missing.map((chapter) => ({
            chapterId: chapter.chapterId,
            titleZh: chapter.titleZh,
            responsibility: chapter.responsibility,
            goal: chapter.goal,
            ownsContributionIds: chapter.ownsContributionIds,
          })),
          materialGaps: openGaps.map((gap) => ({
            gapId: gap.gapId,
            gapType: gap.gapType,
            origin: gap.origin,
            status: gap.status,
            ...(gap.chapterId !== undefined ? { chapterId: gap.chapterId } : {}),
            ...(gap.chapterTitleZh !== undefined ? { chapterTitleZh: gap.chapterTitleZh } : {}),
            title: gap.title,
            whyInsufficient: gap.whyInsufficient,
            requiredMaterials: gap.requiredMaterials,
            canWriteWithoutMaterial: gap.canWriteWithoutMaterial,
            requiresExperiment: gap.requiresExperiment,
            ...(gap.stale !== undefined ? { stale: gap.stale } : {}),
          })),
          hint: {
            write_as_limitation: { payload: { subject: "ch-…" } },
            attach_experiment_package: { payload: { subject: "ch-…" } },
            gap_decision: { payload: { gapId: "g-…", rationale: "可选" }, decisions: ["confirm_missing", "supply_research_record", "supply_manuscript", "attach_experiment_package", "write_as_limitation", "defer_chapter", "reject_gap"] },
          },
        };
      },
    },
  };
}

/**
 * M14.6：学位论文双语摘要 + 关键词（正文有一定完成度之后生成；修订后刷新）。
 * 摘要只消费：已确认研究主题 / 贡献、已写正文、作者已确认事实、限制口径章；事实守卫
 * （checkThesisAbstractFacts）零违规才写入 ThesisDocumentModel；有违规 → 不写入、如实记录
 * （Gate 规则 thesis_abstract_complete 据此判结构不完整；Draft 仍可构建）。
 */
function thesisAbstractStage(services: WorkflowServices): StageSpec {
  return {
    id: "thesis.abstract",
    description: "学位论文双语摘要与关键词（基于已写正文 + 已确认事实；确定性事实守卫；缺摘要 ≠ 结构完整）",
    requiredInputs: ["writing.sections"],
    producedOutputs: ["manuscript/thesis.json", "research/thesis-abstract.json"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs,
    retryable: ["transient", "timeout", "runtime_unavailable", "contract_violation"],
    async execute(ctx) {
      if (services.thesis.abstract === undefined) {
        return { skipped: true, note: "摘要生成能力未装配" };
      }
      const outline = await services.manuscript.loadOutline(ctx.projectId);
      const mapping = await services.thesis.planner.loadMapping(ctx.projectId);
      const model = await services.thesis.documents.loadModel(ctx.projectId);
      if (outline === null || mapping === null || model === null) {
        throw new BusinessError("STAGE_CONTRACT_VIOLATION", "缺少大纲 / 章节映射 / 文档模型（thesis.storyline 未落盘）");
      }
      const project = await services.projects.getRequired(ctx.projectId);
      const context = await services.thesis.researchInputs.plannerContext(ctx.projectId);
      const contributions = ((await services.thesis.planner.loadContributions(ctx.projectId))?.items ?? []).filter((item) => item.status === "confirmed");
      const storyline = (await services.thesis.planner.loadStoryline(ctx.projectId))?.storyline ?? null;
      const decisions: readonly AuthorDecision[] = await services.thesis.researchInputs.decisions.list(ctx.projectId);
      const limitationChapters = new Set(
        decisions
          .filter((decision) => decision.payload.type === "writing_pause" && (decision.payload.decision === "write_as_limitation" || decision.payload.decision === "defer"))
          .map((decision) => (decision.payload as { subject: string }).subject),
      );
      const sections: Array<{ file: string; chapterId: string; title: string; content: string }> = [];
      for (const chapter of mapping.chapters) {
        for (const file of chapter.sectionFiles) {
          try {
            const content = await readFile(join(services.projects.manuscriptDir(ctx.projectId), "sections", file), "utf8");
            sections.push({ file, chapterId: chapter.chapterId, title: outline.sections.find((section) => section.file === file)?.title ?? file, content });
          } catch {
            // 缺节由 writing.sections DoD 负责
          }
        }
      }
      const result = await services.thesis.abstract.generate(
        {
          projectTitle: model.titleZh,
          documentType: project.documentType ?? "master_thesis",
          language: "zh",
          storyline,
          chapters: mapping.chapters.map((chapter) => ({ ...chapter, limitationMode: limitationChapters.has(chapter.chapterId) })),
          contributions,
          confirmedFacts: context.facts.authorConfirmed,
          sections,
          ...(model.abstractZh !== undefined || model.abstractEn !== undefined
            ? {
                existing: {
                  ...(model.abstractZh !== undefined ? { abstractZh: model.abstractZh } : {}),
                  ...(model.abstractEn !== undefined ? { abstractEn: model.abstractEn } : {}),
                  ...(model.keywordsZh !== undefined ? { keywordsZh: model.keywordsZh } : {}),
                  ...(model.keywordsEn !== undefined ? { keywordsEn: model.keywordsEn } : {}),
                },
              }
            : {}),
        },
        { projectId: ctx.projectId, maxRepairAttempts: 1 },
      );
      const ok = result.violations.length === 0;
      // M14.7：摘要快照绑定——写入 thesis.json 成功时记录「本摘要对应哪一版正文 / 事实 / 决定」
      //（未成功写入时模型保留旧摘要，绑定不落盘 → Gate 按绑定缺失判 ABSTRACT_STALE，语义正确）
      const snapshot: AbstractSnapshotBinding = {
        schemaVersion: 1,
        revision: await services.revisions.currentRevision(ctx.projectId),
        manuscriptFingerprint: await computeManuscriptSectionsFingerprint(
          services.projects,
          ctx.projectId,
          mapping.chapters.flatMap((chapter) => chapter.sectionFiles),
        ),
        confirmedFactFingerprint: computeConfirmedFactFingerprint(context.facts.authorConfirmed),
        authorDecisionFingerprint: computeAuthorDecisionFingerprint(decisions),
        generatedAt: new Date().toISOString(),
      };
      if (ok) {
        await services.thesis.documents.saveModel(
          ctx.projectId,
          {
            ...model,
            abstractZh: result.draft.abstractZh,
            abstractEn: result.draft.abstractEn,
            keywordsZh: result.draft.keywordsZh,
            keywordsEn: result.draft.keywordsEn,
          },
          outline,
        );
      }
      await writeJsonAtomic(join(services.projects.researchDir(ctx.projectId), "thesis-abstract.json"), {
        schemaVersion: 1,
        projectId: ctx.projectId,
        generatedAt: new Date().toISOString(),
        saved: ok,
        draft: result.draft,
        violations: result.violations,
        advisories: result.advisories,
        attempts: result.attempts,
        taskIds: result.taskIds,
        ...(result.usage !== undefined ? { usage: result.usage } : {}),
        inputs: { sections: sections.length, confirmedFacts: context.facts.authorConfirmed.length, contributions: contributions.length, limitationChapters: [...limitationChapters] },
        // M14.7：快照绑定（saved=true 时才记录；对应 thesis.json 当前摘要）
        ...(ok ? { snapshot } : {}),
      });
      return {
        saved: ok,
        ...(ok ? { boundRevision: snapshot.revision, boundManuscriptFingerprint: snapshot.manuscriptFingerprint.slice(0, 16) } : {}),
        abstractZhChars: result.draft.abstractZh.length,
        abstractEnWords: result.draft.abstractEn.split(/\s+/).filter(Boolean).length,
        keywordsZh: result.draft.keywordsZh.length,
        keywordsEn: result.draft.keywordsEn.length,
        violations: result.violations.length,
        advisories: result.advisories.length,
        attempts: result.attempts,
        ...(result.violations.length > 0 ? { violationCodes: [...new Set(result.violations.map((violation) => violation.code))] } : {}),
      };
    },
  };
}

function thesisWritingSectionsStage(services: WorkflowServices): StageSpec {
  return {
    id: "writing.sections",
    description: "Thesis Writer 分章逐节写作（作者确认事实注入 + 源文本投影 + 章级纪律；节级断点恢复）",
    requiredInputs: ["hitl.outline_confirm"],
    producedOutputs: ["manuscript/sections/*.tex", "manuscript-thesis/"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs * 4,
    retryable: ["transient", "timeout", "runtime_unavailable", "contract_violation"],
    async execute(ctx) {
      const outline = await services.manuscript.loadOutline(ctx.projectId);
      if (outline === null) {
        throw new BusinessError("STAGE_CONTRACT_VIOLATION", "缺少大纲（thesis.storyline 未落盘 outline.json）");
      }
      const mapping = await services.thesis.planner.loadMapping(ctx.projectId);
      if (mapping === null || mapping.status !== "confirmed") {
        throw new BusinessError("AUTHOR_DECISION_REQUIRED", "章节映射未确认（hitl.outline_confirm 未 approve）");
      }
      const context = await services.thesis.researchInputs.plannerContext(ctx.projectId);
      if (context.writingBlockers.length > 0) {
        throw new BusinessError(
          "AUTHOR_DECISION_REQUIRED",
          `研究输入出现新的未决阻断（写作前必须解决）：${context.writingBlockers.join("；")}`,
        );
      }
      const missing = await services.thesis.planner.missingMaterialChapters(ctx.projectId);
      if (missing.length > 0) {
        throw new BusinessError(
          "AUTHOR_DECISION_REQUIRED",
          `仍有缺材料且未获作者决定的章：${missing.map((chapter) => chapter.chapterId).join("、")}`,
        );
      }
      const project = await services.projects.getRequired(ctx.projectId);
      const language = normalizeManuscriptLanguage(project.language);
      const contributions = await services.thesis.planner.loadContributions(ctx.projectId);
      const contributionStatements = new Map(
        (contributions?.items ?? []).map((item) => [item.id, { statement: item.statement, kind: item.kind }]),
      );
      const thesisDecisions: readonly AuthorDecision[] = await services.thesis.researchInputs.decisions.list(ctx.projectId);
      const writingDecisions = { limitation: new Set<string>(), covered: new Set<string>() };
      for (const decision of thesisDecisions) {
        if (decision.payload.type !== "writing_pause" || typeof decision.payload.subject !== "string") continue;
        writingDecisions.covered.add(decision.payload.subject);
        if (decision.payload.decision === "write_as_limitation" || decision.payload.decision === "defer") {
          writingDecisions.limitation.add(decision.payload.subject);
        }
      }
      const evidence = (await services.evidenceSelection.selectForWriting(ctx.projectId)).formal;
      const bibliography = await buildCanonicalBibliography(services, ctx.projectId);
      // 章 → 节装配（outline 全序；file → chapter）
      const chapterByFile = new Map<string, ThesisChapterPlan>();
      for (const chapter of mapping.chapters) {
        for (const file of chapter.sectionFiles) chapterByFile.set(file, chapter);
      }
      const contributionsById = new Map((contributions?.items ?? []).map((item) => [item.id, item]));
      // 事实 id 扩展：owner 贡献的 linkedFactIds 并入章节可写事实集合
      const chapterFactIds = new Map<string, Set<string>>();
      for (const chapter of mapping.chapters) {
        const ids = new Set(chapter.factIds);
        for (const contributionId of chapter.ownsContributionIds) {
          for (const factId of contributionsById.get(contributionId)?.linkedFactIds ?? []) ids.add(factId);
        }
        chapterFactIds.set(chapter.chapterId, ids);
      }
      const plan = await beginWritingPlan(services, ctx, {
        mode: "thesis_from_papers",
        outline,
        units: [],
        fingerprint: writingPlanFingerprint(outline, evidence),
        sections: outline.sections.map((section) => thesisPlanSectionRecord(section, chapterByFile.get(section.file))),
        unassignedEvidence: [],
        warnings: [],
      });
      const usedEvidenceIds = new Set<string>();
      let bytesTotal = 0;
      const written: string[] = [];
      const reused: string[] = [];
      const chapterSummaries: Record<string, unknown>[] = [];
      // M14.6：全文章序（Writer 以 \ref{ch:…} 引用他章，不猜章号）+ 输出卫生统计
      const chapterOrderEntries = chapterOrder(mapping.chapters.map((chapter) => ({ chapterId: chapter.chapterId, titleZh: chapter.titleZh })));
      const consistency = {
        metaNotesStripped: 0,
        metaNotesKept: 0,
        chapterRefRewrites: 0,
        chapterRefIssues: 0,
        samples: [] as string[],
      };
      // M14.3：继承表格插入计划（确定性）。授权资产 → 来源输入所属章（优先
      // method/experiment 章）→ 该章最后一节文件末尾。幂等：节文件已有守卫块则跳过。
      const assetsFile = await services.thesis.inheritedTables.load(ctx.projectId);
      // M14.3：authorized + 已 inserted 资产都参与本轮插入——新 run 重写节文件后
      // 旧守卫块随文件消失，inserted 资产须重插（幂等：内容总是 Writer 新写 + 块追加）。
      const authorizedAssets = (assetsFile?.assets ?? []).filter(
        (asset) => asset.status === "authorized" || asset.status === "inserted",
      );
      const insertionsByFile = new Map<string, typeof authorizedAssets>();
      const insertionNotes: string[] = [];
      const insertedRecords: Array<{ assetId: string; chapterId: string; sectionFile: string; latexHash: string }> = [];
      for (const asset of authorizedAssets) {
        const chapter =
          mapping.chapters.find(
            (entry) =>
              (entry.responsibility === "method" || entry.responsibility === "experiment") &&
              entry.sourceInputIds.includes(asset.source.researchInputId),
          ) ?? mapping.chapters.find((entry) => entry.sourceInputIds.includes(asset.source.researchInputId));
        if (chapter === undefined || chapter.sectionFiles.length === 0) {
          insertionNotes.push(`${asset.assetId}:no_target_chapter（来源输入未映射到任何章，未插入）`);
          continue;
        }
        const targetFile = chapter.sectionFiles[chapter.sectionFiles.length - 1]!;
        const list = insertionsByFile.get(targetFile) ?? [];
        list.push(asset);
        insertionsByFile.set(targetFile, list);
      }
      const chapterTablesByChapter = new Map<string, Array<{ label: string; captionZh: string; sectionFile: string }>>();
      for (const [file, assets] of insertionsByFile) {
        const chapter = mapping.chapters.find((entry) => entry.sectionFiles.includes(file));
        if (chapter === undefined) continue;
        const list = chapterTablesByChapter.get(chapter.chapterId) ?? [];
        for (const asset of assets) {
          list.push({ label: inheritedTableLabel(asset.assetId), captionZh: asset.captionZh, sectionFile: file });
        }
        chapterTablesByChapter.set(chapter.chapterId, list);
      }
      for (const [index, section] of outline.sections.entries()) {
        if (ctx.signal.aborted) throw new BusinessError("WORKFLOW_CANCELLED", "工作流已被取消");
        const chapter = chapterByFile.get(section.file);
        if (chapter === undefined) {
          throw new BusinessError(
            "STAGE_CONTRACT_VIOLATION",
            `节 ${section.file} 未映射到任何章（chapter-mapping 与 outline 不一致）`,
          );
        }
        const sectionIndex = chapter.sectionFiles.indexOf(section.file);
        const limitationMode = writingDecisions.limitation.has(chapter.chapterId);
        const pendingInsertions = insertionsByFile.get(section.file) ?? [];
        const resumed = await resumableWrittenSection(services, ctx.projectId, plan, section.id, section.file);
        if (resumed !== null) {
          reused.push(section.id);
          for (const evidenceId of resumed.evidence.consumed) usedEvidenceIds.add(evidenceId);
          // M14.3：恢复节的继承表格补插（上轮授权晚于写作的资产在此幂等补齐）
          const filePath = join(services.projects.manuscriptDir(ctx.projectId), "sections", section.file);
          try {
            const current = await readFile(filePath, "utf8");
            const missing = pendingInsertions.filter((asset) => !current.includes(`% inherited-table:${asset.assetId} begin`));
            if (missing.length > 0) {
              const appended = `${current.trim()}\n\n${missing.map((asset) => renderInheritedTableLatex(asset)).join("\n\n")}\n`;
              await writeFile(filePath, appended, "utf8");
              for (const asset of missing) {
                insertedRecords.push({
                  assetId: asset.assetId,
                  chapterId: chapter.chapterId,
                  sectionFile: section.file,
                  latexHash: sha256Hex(renderInheritedTableLatex(asset)),
                });
              }
              insertionNotes.push(`${section.file}:backfilled ${missing.length} tables（恢复节补插）`);
              await updateWritingPlanSection(services, ctx.projectId, plan, section.id, {
                status: "written",
                latencyMs: 0,
                outputHash: sha256Hex(appended.trim() + "\n"),
              });
            }
          } catch {
            // 文件读取失败走非恢复路径重写（下方 writeSection 重建）
          }
          await ctx.emitProgress({ section: section.id, file: section.file, index: index + 1, total: outline.sections.length, resumed: true, chapter: chapter.chapterId });
          continue;
        }
        // 章级源文本投影（确定性分窗）
        const sourceText = await thesisChapterSourceText(services, ctx.projectId, chapter);
        const projection = sourceText === null
          ? null
          : sourceProjectionForSection({
              text: sourceText,
              sectionIndex: Math.max(0, sectionIndex),
              sectionCount: chapter.sectionFiles.length,
            });
        const writingContext = buildThesisSectionContext({
          chapter: { ...chapter, factIds: [...(chapterFactIds.get(chapter.chapterId) ?? new Set<string>())] },
          sectionFile: section.file,
          sectionTitle: section.title,
          sectionIndex: Math.max(0, sectionIndex),
          sectionCount: chapter.sectionFiles.length,
          factContext: context,
          contributionStatements,
          sourceProjection: projection,
          limitationMode,
          ...(section.literatureRefs !== undefined ? { literatureRefs: section.literatureRefs } : {}),
          ...(chapterTablesByChapter.get(chapter.chapterId) !== undefined
            ? { inheritedTables: chapterTablesByChapter.get(chapter.chapterId) }
            : {}),
          chapterOrderLines: renderChapterOrderLines(chapterOrderEntries, chapter.chapterId),
        });
        const startedAt = Date.now();
        let result: Awaited<ReturnType<WriterService["writeSection"]>>;
        try {
          result = await services.writer.writeSection({
            projectId: ctx.projectId,
            section,
            outline,
            evidence,
            bibliography,
            ...(language !== undefined ? { language } : {}),
            extraInstructions: writingContext.extraInstructions,
          });
        } catch (error) {
          await updateWritingPlanSection(services, ctx.projectId, plan, section.id, { status: "failed", latencyMs: Date.now() - startedAt });
          throw error;
        }
        // M14.6：写作输出卫生——剥离高置信工作流元注记（「依据本章的科研事实纪律」等），
        // 字面章号归一为 \ref{ch:…}（按邻近章标题解析；无法解析的只记录不改）。确定性、幂等。
        const stripped = stripWorkflowMetaNotes(result.latex);
        const normalizedRefs = normalizeChapterReferences(stripped.text, chapterOrderEntries, { currentChapterId: chapter.chapterId });
        consistency.metaNotesStripped += stripped.removed.length;
        consistency.metaNotesKept += stripped.kept.length;
        consistency.chapterRefRewrites += normalizedRefs.rewrites.length;
        consistency.chapterRefIssues += normalizedRefs.issues.length;
        for (const hit of stripped.removed.slice(0, 2)) consistency.samples.push(`${section.file}: 剥离元注记「${hit.sentence.slice(0, 60)}」`);
        for (const rewrite of normalizedRefs.rewrites.slice(0, 2)) consistency.samples.push(`${section.file}: ${rewrite.before} → ${rewrite.after}`);
        for (const issue of normalizedRefs.issues.slice(0, 2)) consistency.samples.push(`${section.file}: 章号引用「${issue.literal}」${issue.reason}`);
        const hygienicLatex = normalizedRefs.latex;
        // M14.3：写作输出 + 继承表格守卫块一次写入（outputHash 覆盖合并内容——
        // 恢复复用与守卫复核都以合并后的文件为准）
        const insertionBlocks = pendingInsertions.map((asset) => renderInheritedTableLatex(asset));
        const sectionLatex =
          insertionBlocks.length > 0 ? `${hygienicLatex}\n\n${insertionBlocks.join("\n\n")}` : hygienicLatex;
        bytesTotal += await services.manuscript.writeSection(ctx.projectId, section, sectionLatex);
        for (const asset of pendingInsertions) {
          insertedRecords.push({
            assetId: asset.assetId,
            chapterId: chapter.chapterId,
            sectionFile: section.file,
            latexHash: sha256Hex(renderInheritedTableLatex(asset)),
          });
        }
        written.push(section.id);
        chapterSummaries.push(writingContext.summary);
        for (const record of evidence) usedEvidenceIds.add(record.id);
        await updateWritingPlanSection(services, ctx.projectId, plan, section.id, {
          status: "written",
          latencyMs: Date.now() - startedAt,
          taskId: result.taskId,
          ...(result.usage !== undefined ? { usage: result.usage } : {}),
          cited: extractCitedKeyList(hygienicLatex),
          outputHash: sha256Hex(sectionLatex.trim() + "\n"),
        });
        await ctx.emitProgress({
          section: section.id,
          file: section.file,
          index: index + 1,
          total: outline.sections.length,
          chapter: chapter.chapterId,
          limitationMode,
        });
      }
      for (const evidenceId of usedEvidenceIds) {
        await safeMarkUsage(services, ctx.projectId, evidenceId, ctx.runId);
      }
      await services.manuscript.rebuildContext(ctx.projectId, {
        evidenceStats: await services.evidence.stats(ctx.projectId),
      });
      await syncReferencesBib(services, ctx.projectId);
      const revision = await services.revisions.commit(ctx.projectId, "writing.sections", ctx.runId);
      // M14.1c 确定性装配（manuscript-thesis/；源目录只读）
      const model = await services.thesis.documents.loadModel(ctx.projectId);
      const assembly = await services.thesis.documents.assemble(ctx.projectId, outline, model ?? undefined);
      // M14.3：已插入资产状态落盘（inserted + 定位 + 渲染 hash）
      if (insertedRecords.length > 0) {
        const insertedById = new Map(insertedRecords.map((record) => [record.assetId, record]));
        for (const asset of assetsFile?.assets ?? []) {
          const record = insertedById.get(asset.assetId);
          if (record === undefined) continue;
          asset.status = "inserted";
          asset.insertion = {
            sectionFile: record.sectionFile,
            chapterId: record.chapterId,
            insertedAt: new Date().toISOString(),
            latexHash: record.latexHash,
          };
          asset.updatedAt = new Date().toISOString();
        }
        await services.thesis.inheritedTables.save(ctx.projectId, {
          ...(assetsFile ?? { schemaVersion: 1 as const, projectId: ctx.projectId, assets: [] }),
          updatedAt: new Date().toISOString(),
        });
      }
      plan.revision = revision.revision;
      plan.updatedAt = new Date().toISOString();
      await services.reviewArtifacts.saveWritingPlan(ctx.projectId, plan);
      return {
        sectionsWritten: written.length,
        sections: written,
        ...(reused.length > 0 ? { sectionsReused: reused.length, reusedSections: reused } : {}),
        bytesTotal,
        revision: revision.revision,
        chapters: mapping.chapters.length,
        bibliographyEntries: bibliography.length,
        evidenceFormal: evidence.length,
        assemblyMainTex: assembly.mainTex,
        chaptersWithLimitationMode: [...writingDecisions.limitation],
        ...(insertedRecords.length > 0
          ? { inheritedTablesInserted: insertedRecords.length, inheritedTableNotes: insertionNotes.slice(0, 10) }
          : { inheritedTablesAuthorized: authorizedAssets.length }),
        argumentUnits: summarizeWritingPlan(plan),
        // M14.6：写作输出卫生与装配层章号归一统计
        writerConsistency: { ...consistency, samples: consistency.samples.slice(0, 12) },
        assemblyChapterReferences: {
          rewrites: assembly.chapterReferences.rewrites.length,
          issues: assembly.chapterReferences.issues.length,
          samples: [
            ...assembly.chapterReferences.rewrites.slice(0, 4).map((entry) => `${entry.file}: ${entry.before} → ${entry.after}`),
            ...assembly.chapterReferences.issues.slice(0, 4).map((entry) => `${entry.file}: 「${entry.literal}」${entry.reason}`),
          ],
        },
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

/** thesis 写作计划的节记录（非 argument-unit 模式：role 由章角色确定性派生） */
function thesisPlanSectionRecord(section: OutlineSection, chapter: ThesisChapterPlan | undefined): WritingPlanSectionRecord {
  const role: WritingPlanSectionRecord["role"] =
    chapter === undefined
      ? "develop"
      : chapter.responsibility === "introduction" || chapter.responsibility === "background" || chapter.responsibility === "literature_review"
        ? "framing"
        : chapter.responsibility === "conclusion" || chapter.responsibility === "discussion"
          ? "conclude"
          : "develop";
  return {
    sectionId: section.id,
    title: section.title,
    fileName: section.file,
    role,
    roleSource: `thesis-chapter:${chapter?.chapterId ?? "unmapped"}`,
    roleConfidence: "deterministic",
    taskSummary: chapter?.goal ?? section.title,
    doNotExplain: [],
    targetLengthUpperBound: section.targetLengthWords ?? 5000,
    lengthSource: "outline",
    evidence: { allocated: [], consumed: [], pinned: [], pinnedRejected: [], coverageAdded: [], partial: [] },
    citationKeys: { evidenceBacked: [] },
    diagnostics: [],
    status: "planned",
  };
}

/** 章级来源文本（含原文投影；无来源章 → null） */
async function thesisChapterSourceText(
  services: WorkflowServices,
  projectId: string,
  chapter: ThesisChapterPlan,
): Promise<string | null> {
  if (chapter.sourceInputIds.length === 0) return null;
  const registry = await services.thesis.researchInputs.list(projectId);
  const blocks: Array<{ blocks: ReadonlyArray<{ type: string; text?: string; caption?: string }> }> = [];
  for (const inputId of chapter.sourceInputIds) {
    const input = registry.inputs.find((entry) => entry.inputId === inputId);
    if (input === undefined) continue;
    const document = await services.ingestion.getDocument(projectId, input.version.sourceId);
    if (document === null || document.contentHash !== input.version.contentHash) continue;
    blocks.push({ blocks: document.blocks });
  }
  if (blocks.length === 0) return null;
  return chapterSourceText(blocks);
}

/**
 * M14.2：thesis gate 规则输入（确定性）。
 * - 零漂移：已确认事实（author_confirmed ∩ 章节映射）↔ 映射章正文机械比对；
 * - 映射：confirmed + 自洽指纹 + section 文件与 outline 完全一致 + 引用来源/事实仍有效；
 * - 结构：ThesisDocumentModel 对 outline 的装配校验（每节恰好映射一次）；
 * - 冲突：plannerContext 未决阻断冲突必须为 0。
 */
// ---------------------------------------------------------------------------
// M14.3：thesis 修订纪律（与写作阶段同一事实白名单口径）
// ---------------------------------------------------------------------------

interface ThesisRevisionInputs {
  context: import("../thesis/researchInputTypes.js").ResearchFactContext;
  /** 节文件 → 章（factIds 含 owner 贡献 linkedFactIds 扩展） */
  chapterByFile: Map<string, { chapterId: string; titleZh: string; factIds: Set<string> }>;
  /** 本章已插入的继承表格（label 列表；守卫块禁改） */
  guardedTablesByChapter: Map<string, string[]>;
}

async function loadThesisRevisionInputs(services: WorkflowServices, projectId: string): Promise<ThesisRevisionInputs | null> {
  const mapping = await services.thesis.planner.loadMapping(projectId);
  if (mapping === null) return null;
  const context = await services.thesis.researchInputs.plannerContext(projectId);
  const contributions = await services.thesis.planner.loadContributions(projectId);
  const contributionsById = new Map((contributions?.items ?? []).map((item) => [item.id, item]));
  const chapterByFile = new Map<string, { chapterId: string; titleZh: string; factIds: Set<string> }>();
  for (const chapter of mapping.chapters) {
    const factIds = new Set(chapter.factIds);
    for (const contributionId of chapter.ownsContributionIds) {
      for (const factId of contributionsById.get(contributionId)?.linkedFactIds ?? []) factIds.add(factId);
    }
    const entry = { chapterId: chapter.chapterId, titleZh: chapter.titleZh, factIds };
    for (const file of chapter.sectionFiles) chapterByFile.set(file, entry);
  }
  const assetsFile = await services.thesis.inheritedTables.load(projectId);
  const guardedTablesByChapter = new Map<string, string[]>();
  for (const asset of assetsFile?.assets ?? []) {
    if (asset.status !== "inserted" || asset.insertion === undefined) continue;
    const list = guardedTablesByChapter.get(asset.insertion.chapterId) ?? [];
    list.push(inheritedTableLabel(asset.assetId));
    guardedTablesByChapter.set(asset.insertion.chapterId, list);
  }
  return { context, chapterByFile, guardedTablesByChapter };
}

/** 单次修订调用的纪律块（≤40 行事实白名单 + 冲突 + 守卫表格警示） */
function renderThesisRevisionDiscipline(inputs: ThesisRevisionInputs, sectionFile: string): string {
  const lines: string[] = [];
  const chapter = inputs.chapterByFile.get(sectionFile);
  lines.push("【学位论文修订纪律】本次修订对象是学位论文章节，科研事实纪律与写作阶段完全一致：");
  const scope = chapter !== undefined ? chapter.factIds : new Set<string>();
  const confirmed =
    chapter !== undefined
      ? inputs.context.facts.authorConfirmed.filter((fact) => scope.has(fact.factId))
      : inputs.context.facts.authorConfirmed;
  lines.push(
    `本章「${chapter?.titleZh ?? "（未映射章——按全局口径）"}」的实验指标/参数/数据集数值只能来自以下作者已确认事实（共 ${confirmed.length} 条${confirmed.length > 40 ? "，此处列前 40 条" : ""}）：`,
  );
  for (const fact of confirmed.slice(0, 40)) {
    lines.push(renderResearchFactLine(fact));
  }
  lines.push(
    "修订只允许改善语言、结构、逻辑衔接；禁止改动上述数值（含等价换算须保持原值口径）、禁止删除上述数值、禁止新增任何未列出的具体实验数值、禁止把待确认或冲突数值写成定论。",
    "审稿意见若以「无实验数据 / 未授权 / 仅见于外部来源」为由要求删除或弱化上述数值，该意见不成立：上表事实经来源核验并由作者确认，是本论文合法的实验数据来源；不得据此删值或改为定性表述。",
  );
  if (inputs.context.facts.conflicted.length > 0) {
    lines.push(
      `存在 ${inputs.context.facts.conflicted.length} 条未裁决冲突事实：修订不得以任何一方的数值改写正文，也不得通过改写表述隐式消除冲突。`,
    );
  }
  const guarded = chapter !== undefined ? inputs.guardedTablesByChapter.get(chapter.chapterId) : undefined;
  if (guarded !== undefined && guarded.length > 0) {
    lines.push(
      `本章含系统继承表格（${guarded.join("、")}）：表格环境由守卫标记包裹，任何数值/行列改动都会被 Quality Gate 拒绝；如审稿意见认为表格数据有误，正确做法是提请作者决定（修改来源数据须重新授权），不是在修订中直接改表。`,
    );
  }
  return lines.join("\n");
}

async function computeThesisGateInput(services: WorkflowServices, projectId: string): Promise<ThesisGateInput> {
  const mapping = await services.thesis.planner.loadMapping(projectId);
  const outline = await services.manuscript.loadOutline(projectId);
  const context = await services.thesis.researchInputs.plannerContext(projectId);
  const contributions = await services.thesis.planner.loadContributions(projectId);
  const contributionsById = new Map((contributions?.items ?? []).map((item) => [item.id, item]));

  // ---- 映射校验 ----
  const invalidSourceInputs: string[] = [];
  const invalidFactIds: string[] = [];
  let fingerprintMatchesOutline = false;
  if (mapping !== null && outline !== null) {
    const includedIds = new Set(context.inputs.included.map((input) => input.inputId));
    const validFactIds = new Set(
      [
        ...context.facts.authorConfirmed,
        ...context.facts.sourceVerifiedUnconfirmed,
        ...context.facts.extractedOnly,
      ].map((fact) => fact.factId),
    );
    for (const chapter of mapping.chapters) {
      for (const inputId of chapter.sourceInputIds) {
        if (!includedIds.has(inputId)) invalidSourceInputs.push(`${chapter.chapterId}:${inputId}`);
      }
      for (const factId of chapter.factIds) {
        if (!validFactIds.has(factId)) invalidFactIds.push(`${chapter.chapterId}:${factId}`);
      }
    }
    const storedFiles = mapping.chapters.flatMap((chapter) => chapter.sectionFiles);
    const outlineFiles = outline.sections.map((section) => section.file);
    fingerprintMatchesOutline =
      outlineFingerprintFromChapters(mapping.chapters) === mapping.outlineFingerprint &&
      storedFiles.length === outlineFiles.length &&
      new Set(storedFiles).size === new Set(outlineFiles).size &&
      storedFiles.every((file) => new Set(outlineFiles).has(file));
  }

  // ---- 零漂移：已确认事实 ∩（章节 factIds ∪ owner 贡献 linkedFactIds）----
  const chapterFactIdsByChapter = new Map<string, Set<string>>();
  if (mapping !== null) {
    for (const chapter of mapping.chapters) {
      const ids = new Set(chapter.factIds);
      for (const contributionId of chapter.ownsContributionIds) {
        for (const factId of contributionsById.get(contributionId)?.linkedFactIds ?? []) ids.add(factId);
      }
      chapterFactIdsByChapter.set(chapter.chapterId, ids);
    }
  }
  const factViewById = new Map(context.facts.authorConfirmed.map((fact) => [fact.factId, fact]));
  const findings: ThesisGateInput["drift"]["findings"] = [];
  if (mapping !== null && outline !== null) {
    const sectionsByChapter = new Map<string, string[]>();
    for (const chapter of mapping.chapters) {
      const contents: string[] = [];
      for (const file of chapter.sectionFiles) {
        try {
          contents.push(await readFile(join(services.projects.manuscriptDir(projectId), "sections", file), "utf8"));
        } catch {
          contents.push("");
        }
      }
      sectionsByChapter.set(chapter.chapterId, contents);
    }
    for (const chapter of mapping.chapters) {
      const ids = chapterFactIdsByChapter.get(chapter.chapterId) ?? new Set<string>();
      const body = (sectionsByChapter.get(chapter.chapterId) ?? []).join("\n");
      if (body.trim() === "") continue;
      for (const factId of ids) {
        const fact = factViewById.get(factId);
        if (fact === undefined || fact.verification !== "author_confirmed") continue;
        const finding = checkFactDrift(fact, body);
        findings.push({
          factId: finding.factId,
          surface: finding.surface,
          status: finding.status,
          detail: finding.detail,
          ...(finding.observedValue !== undefined ? { observedValue: finding.observedValue } : {}),
        });
      }
    }
  }
  /**
   * M14.6（F5）：已确认事实被修订**删除**（上一修订存在、当前缺失）同样是未授权变更——
   * checkFactDrift 只能把缺失判为 absent（未声称 ≠ 漂移），这里补上与上一修订的差分比对。
   * 作者决定授权删除的通路目前不存在（删除 / 改值须回到研究材料面板重新确认事实）。
   */
  if (mapping !== null && outline !== null) {
    try {
      const currentRevision = await services.revisions.currentRevision(projectId);
      const previousTex = currentRevision > 1 ? await readSnapshotTex(services.revisions.snapshotDir(projectId, currentRevision - 1)) : null;
      if (previousTex !== null) {
        const previousBody = previousTex.map((file) => file.content).join("\n");
        const currentBody: string[] = [];
        for (const chapter of mapping.chapters) {
          for (const file of chapter.sectionFiles) {
            try {
              currentBody.push(await readFile(join(services.projects.manuscriptDir(projectId), "sections", file), "utf8"));
            } catch {
              currentBody.push("");
            }
          }
        }
        const alreadyReported = new Set(findings.filter((finding) => finding.status === "unauthorized").map((finding) => finding.factId));
        for (const removed of detectConfirmedFactRemoval(previousBody, currentBody.join("\n"), context.facts.authorConfirmed)) {
          if (alreadyReported.has(removed.factId)) continue;
          findings.push({
            factId: removed.factId,
            surface: removed.surface,
            status: "unauthorized",
            detail: `已确认事实在修订 rev-${currentRevision - 1} → rev-${currentRevision} 中被删除（上一修订正文存在、当前缺失；删除须经作者决定）`,
            observedValue: "（已删除）",
          });
        }
      }
    } catch {
      // 修订快照不可读 → 不做差分（不阻断 gate；零漂移规则仍按当前正文比对）
    }
  }
  const drift = summarizeDrift(
    findings.map((finding) => ({
      factId: finding.factId,
      surface: finding.surface,
      status: finding.status as "consistent" | "equivalent_format" | "unauthorized" | "absent",
      detail: finding.detail,
      ...(finding.observedValue !== undefined ? { observedValue: finding.observedValue } : {}),
    })),
  );

  // ---- 结构校验 ----
  const structureViolations: string[] = [];
  const model = await services.thesis.documents.loadModel(projectId);
  if (model === null) {
    structureViolations.push("thesis.json 缺失（thesis.storyline 未落盘文档模型）");
  } else if (outline !== null) {
    structureViolations.push(
      ...validateThesisDocumentModel(model, {
        sectionFiles: outline.sections.map((section) => section.file),
        sectionTitles: new Map(outline.sections.map((section) => [section.file, section.title])),
      }),
    );
  } else {
    structureViolations.push("outline.json 缺失");
  }

  // ---- M14.3 继承表格守卫（已插入资产 ↔ 章节文件的确定性比对）----
  const assetsFile = await services.thesis.inheritedTables.load(projectId);
  const insertedAssets = (assetsFile?.assets ?? []).filter((asset) => asset.status === "inserted");
  let tables: ThesisGateInput["tables"] | undefined;
  const sectionFiles: Array<{ file: string; latex: string }> = [];
  if (outline !== null) {
    for (const section of outline.sections) {
      try {
        sectionFiles.push({
          file: section.file,
          latex: await readFile(join(services.projects.manuscriptDir(projectId), "sections", section.file), "utf8"),
        });
      } catch {
        sectionFiles.push({ file: section.file, latex: "" });
      }
    }
  }
  if (insertedAssets.length > 0) {
    const verification = verifyInheritedTables(insertedAssets, sectionFiles);
    tables = {
      checked: verification.checked,
      intact: verification.intact,
      findings: verification.findings.map((finding) => ({
        assetId: finding.assetId,
        ok: finding.ok,
        violations: finding.violations,
      })),
    };
  }

  // ---- M14.3 跨章一致性 MVP（确定性；advisory 不阻断，产物落盘 research/）----
  let consistency: ThesisGateInput["consistency"];
  if (mapping !== null && outline !== null) {
    const sectionContents = new Map(sectionFiles.map((entry) => [entry.file, entry.latex]));
    const result = checkCrossChapterConsistency({
      projectId,
      now: new Date().toISOString(),
      chapters: mapping.chapters.map((chapter) => ({
        chapterId: chapter.chapterId,
        titleZh: chapter.titleZh,
        sectionFiles: chapter.sectionFiles,
      })),
      sectionContents,
      factContext: context,
    });
    try {
      await writeJsonAtomic(
        join(services.projects.researchDir(projectId), "cross-chapter-consistency.json"),
        result,
      );
    } catch {
      // 产物写失败不阻断 gate（内存结果照常进 gate detail）
    }
    consistency = {
      checked: result.checked,
      findings: result.findings.length,
      suspicious: result.findings.filter((finding) => finding.severity === "suspicious").length,
      topFindings: result.findings.slice(0, 5).map((finding) => finding.summary),
    };
  }

  // ---- M14.6：摘要完整性 / 工作流元注记 / 模板化表达 / 学术引用存在性 ----
  const abstractPresent =
    model !== null &&
    (model.abstractZh ?? "").trim() !== "" &&
    (model.abstractEn ?? "").trim() !== "" &&
    (model.keywordsZh?.length ?? 0) >= 3 &&
    (model.keywordsEn?.length ?? 0) >= 3;
  // M14.7：摘要快照绑定新鲜度（摘要存在时；绑定缺失 / 指纹不一致 → ABSTRACT_STALE）
  let abstractSnapshot: { current: boolean; detail: string } | undefined;
  if (abstractPresent) {
    try {
      const abstractArtifact = JSON.parse(
        await readFile(join(services.projects.researchDir(projectId), "thesis-abstract.json"), "utf8"),
      ) as { snapshot?: AbstractSnapshotBinding };
      abstractSnapshot = compareAbstractSnapshot(abstractArtifact.snapshot, {
        revision: await services.revisions.currentRevision(projectId),
        manuscriptFingerprint: await computeManuscriptSectionsFingerprint(
          services.projects,
          projectId,
          sectionFiles.map((entry) => entry.file),
        ),
        confirmedFactFingerprint: computeConfirmedFactFingerprint(context.facts.authorConfirmed),
        authorDecisionFingerprint: computeAuthorDecisionFingerprint(
          await services.thesis.researchInputs.decisions.list(projectId),
        ),
      });
    } catch (error) {
      abstractSnapshot = {
        current: false,
        detail: `ABSTRACT_STALE：摘要绑定校验异常（${(error as Error).message.slice(0, 120)}）——无法证明与当前正文一致`,
      };
    }
  }
  const abstractInput = {
    present: abstractPresent,
    detail: abstractPresent
      ? `双语摘要 + 关键词齐备（中文 ${model!.abstractZh!.length} 字 / 英文 ${model!.abstractEn!.split(/\s+/).filter(Boolean).length} 词 / 关键词 ${model!.keywordsZh!.length}+${model!.keywordsEn!.length}）`
      : `学位论文结构不完整：${[
          (model?.abstractZh ?? "").trim() === "" ? "缺中文摘要" : "",
          (model?.abstractEn ?? "").trim() === "" ? "缺英文摘要" : "",
          (model?.keywordsZh?.length ?? 0) < 3 ? "中文关键词不足 3 个" : "",
          (model?.keywordsEn?.length ?? 0) < 3 ? "英文关键词不足 3 个" : "",
        ].filter(Boolean).join("、")}（thesis.abstract 未生成或事实守卫未通过；Draft 可生成但不得视为结构完整）`,
    ...(abstractSnapshot !== undefined
      ? { snapshotCurrent: abstractSnapshot.current, snapshotDetail: abstractSnapshot.detail }
      : {}),
  };
  const metaNoteHits = sectionFiles.flatMap((entry) => detectWorkflowMetaNotes(entry.latex).filter((hit) => hit.confidence === "high").map((hit) => `${entry.file}: ${hit.sentence.slice(0, 60)}`));
  const templated = scanTemplatedPhrasing(sectionFiles.map((entry) => ({ file: entry.file, content: entry.latex })));
  let citationsInput: ThesisGateInput["citations"] | undefined;
  try {
    const citationReport = await services.citation.latestReport(projectId);
    const formal = (await services.evidenceSelection.selectForWriting(projectId)).formal.length;
    const academicCandidates = (await services.candidates.list(projectId)).filter((candidate) => candidate.origin === "academic_search").length;
    const applicable =
      (mapping?.chapters.some((chapter) => chapter.responsibility === "literature_review") ?? false) ||
      (outline?.sections.some((section) => (section.literatureRefs ?? []).length > 0) ?? false);
    citationsInput = {
      citedCount: citationReport?.summary.citedCount ?? 0,
      hallucinated: citationReport?.summary.hallucinated ?? 0,
      missingKeys: citationReport?.summary.missingKeys ?? 0,
      applicable,
      supplyDegraded: academicCandidates === 0,
      formalEvidence: formal,
      bibEntries: citationReport?.static.bibEntries.length ?? 0,
    };
  } catch {
    citationsInput = undefined;
  }

  return {
    abstract: abstractInput,
    metaNotes: { hits: metaNoteHits.length, samples: metaNoteHits.slice(0, 5) },
    templatedPhrasing: {
      findings: templated.summary.findings,
      byKind: templated.summary.byKind,
      samples: templated.findings.slice(0, 5).map((finding) => `${finding.file}: ${finding.excerpt.slice(0, 50)}`),
    },
    ...(citationsInput !== undefined ? { citations: citationsInput } : {}),
    drift: {
      checked: drift.checked,
      consistent: drift.consistent,
      equivalentFormat: drift.equivalentFormat,
      unauthorized: drift.unauthorized,
      absent: drift.absent,
      findings: findings.slice(0, 50),
    },
    mapping: {
      exists: mapping !== null,
      confirmed: mapping?.status === "confirmed",
      fingerprintMatchesOutline,
      invalidSourceInputs: invalidSourceInputs.slice(0, 20),
      invalidFactIds: invalidFactIds.slice(0, 20),
    },
    structureViolations: structureViolations.slice(0, 10),
    conflictsUnresolved: context.conflicts.unresolved.length,
    ...(tables !== undefined ? { tables } : {}),
    ...(consistency !== undefined ? { consistency } : {}),
  };
}

export function createThesisFromPapersDefinition(services: WorkflowServices): WorkflowDefinition {
  const stages: readonly StageSpec[] = [
    thesisIngestStage(services),
    thesisContributionsStage(services),
    thesisScopeVersionStage(services),
    thesisFactConflictsStage(services),
    thesisStorylineStage(services),
    thesisOutlineConfirmStage(services),
    thesisEvidenceSupplyStage(services),
    thesisAuthorDecisionStage(services),
    thesisWritingSectionsStage(services),
    thesisAbstractStage(services),
    // 共享后段（同 id 同语义；quality gate / build 走 thesis 分支工厂）
    citationVerifyStage(services),
    reviewRunStageInner(services, {}),
    qualityGateStage(services, { thesis: true }),
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
    buildDraftStage(services, { thesis: true }),
    buildFinalStage(services),
  ];

  const front = [
    "thesis.ingest",
    "thesis.contributions",
    "hitl.scope_and_version",
  ];

  return {
    kind: "thesis_from_papers",
    description:
      "Thesis-from-Papers：研究输入登记核验 → 贡献提取（锚定）→ 范围/版本/贡献确认（HITL）→ 冲突裁决（HITL，条件）→ 主线+两级大纲+章节映射 → 大纲确认（HITL）→ 定向文献补证 → 缺材料作者决定（HITL，条件）→ 分章写作（事实注入）→ 引用核验 → 审稿（长文档单元模式）→ Quality Gate（含 published_facts_zero_drift）→ bounded 修订 → 学位论文装配编译（Draft / Final PDF）",
    stages,
    plan(state: WorkflowState): PlanDecision {
      if ((state.counters?.["thesis.scope_rounds"] ?? 0) > THESIS_SCOPE_ROUND_CAP) {
        return {
          kind: "fail",
          code: "AUTHOR_DECISION_REQUIRED",
          message: `范围/版本决策轮次超过上限（${THESIS_SCOPE_ROUND_CAP}）——仍有未决事项，请通过研究材料面板处理后重新运行`,
        };
      }
      if ((state.counters?.["thesis.conflict_rounds"] ?? 0) > THESIS_CONFLICT_ROUND_CAP) {
        return {
          kind: "fail",
          code: "AUTHOR_DECISION_REQUIRED",
          message: `冲突裁决轮次超过上限（${THESIS_CONFLICT_ROUND_CAP}）——冲突仍未解决，不得继续写作`,
        };
      }
      if ((state.counters?.["thesis.author_decision_rounds"] ?? 0) > THESIS_AUTHOR_DECISION_ROUND_CAP) {
        return {
          kind: "fail",
          code: "AUTHOR_DECISION_REQUIRED",
          message: `缺材料章作者决定轮次超过上限（${THESIS_AUTHOR_DECISION_ROUND_CAP}）`,
        };
      }
      for (const stageId of front) {
        if (!(stageId in state.stageResults)) {
          return { kind: "stage", stageId };
        }
      }
      // 条件节点：冲突未裁决（scope 结果记录的数量）→ 先裁决
      const conflictsPending = readNumberResult(state, "hitl.scope_and_version", "conflictsUnresolved");
      if (conflictsPending > 0 && !("hitl.fact_conflicts" in state.stageResults)) {
        return { kind: "stage", stageId: "hitl.fact_conflicts" };
      }
      if (!("thesis.storyline" in state.stageResults)) {
        return { kind: "stage", stageId: "thesis.storyline" };
      }
      if (!("hitl.outline_confirm" in state.stageResults)) {
        return { kind: "stage", stageId: "hitl.outline_confirm" };
      }
      if (!("thesis.evidence_supply" in state.stageResults)) {
        return { kind: "stage", stageId: "thesis.evidence_supply" };
      }
      const missingChapters = readNumberArrayResult(state, "thesis.evidence_supply", "missingChapters");
      if (missingChapters.length > 0 && !("hitl.author_decision" in state.stageResults)) {
        return { kind: "stage", stageId: "hitl.author_decision" };
      }
      if (!("writing.sections" in state.stageResults)) {
        return { kind: "stage", stageId: "writing.sections" };
      }
      // M14.6：正文初稿完成后生成双语摘要（1 次模型调用；预算耗尽时跳过——Draft 如实无摘要）
      if (!("thesis.abstract" in state.stageResults) && !thesisModelBudgetExhausted(services, state)) {
        return { kind: "stage", stageId: "thesis.abstract" };
      }
      return planSharedTail(state, services);
    },
    async onInput(state, stageId, input): Promise<void | "cancel"> {
      switch (stageId) {
        case "hitl.scope_and_version":
          return applyThesisScopeDecision(services, state, input);
        case "hitl.fact_conflicts":
          return applyThesisFactConflictDecision(services, state, input);
        case "hitl.outline_confirm":
          return applyThesisOutlineDecision(services, state, input);
        case "hitl.author_decision":
          return applyThesisAuthorDecision(services, state, input);
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

/**
 * M14.5/M14.6：学位论文项目的作者已确认研究输入事实（无未决冲突）。非 thesis 项目
 * （无研究输入）返回空。
 */
async function thesisConfirmedResearchFacts(
  services: WorkflowServices,
  projectId: string,
): Promise<import("../thesis/researchInputTypes.js").FactView[]> {
  const registry = await services.thesis.researchInputs.list(projectId);
  if (registry.inputs.length === 0) return [];
  const context = await services.thesis.researchInputs.plannerContext(projectId);
  return context.facts.authorConfirmed;
}

/**
 * M14.6（F5）：Experiment Policy + 研究输入已确认事实的统一口径块（review.run 三路 digest /
 * 长文档单元 / 跨章一致性共用）。无研究输入的项目与 renderExperimentPolicyLines 逐字节一致。
 */
/**
 * M14.9.3：本 run 是否为第三方已发表论文的只读评估。只在 idea_to_paper 的显式 request.reviewPurpose 下成立；
 * 其他工作流（已有论文返修 / 综述 / 学位论文）若携带该字段则 fail-closed（不得借只读口径放宽作者稿件守卫）。
 */
function isPublishedAssessmentRun(state: WorkflowState): boolean {
  if (readReviewPurpose(state.request) !== "published_paper_assessment") return false;
  if (state.workflowKind !== "idea_to_paper") {
    throw new BusinessError("STAGE_CONTRACT_VIOLATION", `reviewPurpose=published_paper_assessment 只适用于 idea_to_paper 只读评估入口（当前 ${state.workflowKind}）`);
  }
  return true;
}

/**
 * M14.9.5.1：已发表论文转写投影中依赖原文的来源核验等级——只有与源 / 投影 / 被审稿件哈希绑定且有效的人工 QA 证明
 * 才是 SOURCE_ATTESTED；保真门自动判定或未提供报告一律 SOURCE_UNVERIFIED（上下文供给不改变保真结论）。
 */
function publishedSourceVerification(fidelity: { report: InputFidelityReport; attestation: AttestationCheck | null } | null): SourceVerification {
  return fidelity?.attestation?.verdict === "VALID" && fidelity.attestation.effectiveStatus === "VALID_FOR_SCORING" ? "SOURCE_ATTESTED" : "SOURCE_UNVERIFIED";
}

/**
 * M14.9.5：已发表论文只读评估的输入保真 provenance——项目 artifacts/ 下随附的送审前保真报告与人工 QA
 * 证明（均可缺省）。证明必须与报告的源 / 投影哈希及当前被审 main.tex 哈希绑定，否则不改变有效状态。
 */
async function loadPublishedInputFidelity(services: WorkflowServices, projectId: string): Promise<{ report: InputFidelityReport; attestation: AttestationCheck | null } | null> {
  const dir = join(services.projects.projectDir(projectId), "artifacts");
  const readJson = async (file: string): Promise<unknown> => {
    try {
      return JSON.parse(await readFile(join(dir, file), "utf8")) as unknown;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
      throw error;
    }
  };
  const report = await readJson("input-fidelity-report.json") as InputFidelityReport | undefined;
  if (report === undefined || report.schema !== INPUT_FIDELITY_REPORT_SCHEMA) return null;
  const attestation = await readJson("input-qa-attestation.json");
  if (attestation === undefined) return { report, attestation: null };
  let manuscriptSha256: string | undefined;
  try {
    manuscriptSha256 = createHash("sha256").update(await readFile(join(services.projects.manuscriptDir(projectId), "main.tex"))).digest("hex");
  } catch {
    manuscriptSha256 = undefined;
  }
  return { report, attestation: checkInputQaAttestation(report, attestation, { ...(manuscriptSha256 !== undefined ? { manuscriptSha256 } : {}), requireManuscriptBinding: true }) };
}

async function experimentAndResearchFactPolicyLines(services: WorkflowServices, projectId: string): Promise<string[]> {
  const policy = await services.experimentPackages.experimentPolicy(projectId);
  const registry = await services.thesis.researchInputs.list(projectId);
  if (registry.inputs.length === 0) return renderExperimentPolicyLines(policy);
  const context = await services.thesis.researchInputs.plannerContext(projectId);
  return composeExperimentAndResearchFactPolicyLines(policy, context);
}

function readNumberResult(state: WorkflowState, stageId: string, field: string): number {
  const value = state.stageResults[stageId]?.[field];
  return typeof value === "number" ? value : 0;
}

/**
 * M14.5：最近一次 revision.revise 是否「零接受」——没有任何章节/单元被修订、没有
 * 外部意见派发报告、没有 claim 修复。stage result 字段由 revise 阶段如实填写
 * （revisedSections / appliedItems / claimRepairs / externalInstructions）。
 */
export function reviseAppliedNothing(state: WorkflowState): boolean {
  const result = state.stageResults["revision.revise"];
  if (result === undefined) return false;
  const revised = typeof result["revisedSections"] === "number" ? result["revisedSections"] : 0;
  const applied = typeof result["appliedItems"] === "number" ? result["appliedItems"] : 0;
  const claimRepairs = typeof result["claimRepairs"] === "number" ? result["claimRepairs"] : 0;
  const external = typeof result["externalInstructions"] === "number" ? result["externalInstructions"] : 0;
  return revised === 0 && applied === 0 && claimRepairs === 0 && external === 0;
}

function readNumberArrayResult(state: WorkflowState, stageId: string, field: string): unknown[] {
  const value = state.stageResults[stageId]?.[field];
  return Array.isArray(value) ? value : [];
}

/** HITL actor 读取：默认 user；test_fixture 仅测试栈显式允许（生产拒绝） */
function readThesisActor(services: WorkflowServices, payload: Record<string, unknown> | undefined): { kind: "user" | "test_fixture" } {
  const requested = payload?.["actorKind"];
  if (requested === "test_fixture") {
    if (services.thesis.allowTestFixtureActor !== true) {
      throw new BusinessError("INVALID_REQUEST", "test_fixture 决策只允许在测试栈使用（生产拒绝）");
    }
    return { kind: "test_fixture" };
  }
  return { kind: "user" };
}

async function applyThesisScopeDecision(
  services: WorkflowServices,
  state: WorkflowState,
  input: ResumeInput,
): Promise<void | "cancel"> {
  if (input.decision === "cancel") return "cancel";
  state.counters = state.counters ?? {};
  state.counters["thesis.scope_rounds"] = (state.counters["thesis.scope_rounds"] ?? 0) + 1;
  const actor = readThesisActor(services, input.payload);
  if (input.decision === "confirm_contribution" || input.decision === "reject_contribution") {
    const ids = readStringArrayPayload(input.payload, "contributionIds");
    if (ids.length === 0) {
      throw new WorkflowInvalidStateError(state.runId, state.status, `${input.decision} 需要携带非空 payload.contributionIds`);
    }
    await services.thesis.planner.confirmContributions(state.projectId, {
      contributionIds: ids,
      outcome: input.decision === "confirm_contribution" ? "confirmed" : "rejected",
      actorKind: actor.kind,
    });
  } else if (input.decision !== "approve") {
    const payload = authorDecisionFromResumeInput({ decision: input.decision, payload: input.payload });
    await services.thesis.researchInputs.submitDecision(state.projectId, { actor, payload });
  }
  // 重估：范围/版本/未发表全部决定 + ≥1 入选输入 + ≥1 已确认贡献
  const context = await services.thesis.researchInputs.plannerContext(state.projectId);
  const pendingScope = context.pendingDecisions.filter((item) =>
    item.type === "scope_decision" || item.type === "version_selection" || item.type === "unpublished_material_policy",
  );
  const contributions = await services.thesis.planner.loadContributions(state.projectId);
  const confirmed = (contributions?.items ?? []).filter((item) => item.status === "confirmed").length;
  const resolved = pendingScope.length === 0 && context.inputs.included.length > 0 && confirmed > 0;
  if (input.decision === "approve" && !resolved) {
    throw new WorkflowInvalidStateError(
      state.runId,
      state.status,
      `approve 前必须完成全部决定（待决：${pendingScope.map((item) => item.type).join("、") || "无"}；入选输入 ${context.inputs.included.length}；已确认贡献 ${confirmed}）`,
    );
  }
  if (resolved) {
    state.stageResults["hitl.scope_and_version"] = {
      resolved: true,
      included: context.inputs.included.length,
      confirmedContributions: confirmed,
      conflictsUnresolved: context.conflicts.unresolved.length,
    };
  } else {
    delete state.stageResults["hitl.scope_and_version"];
  }
}

async function applyThesisFactConflictDecision(
  services: WorkflowServices,
  state: WorkflowState,
  input: ResumeInput,
): Promise<void | "cancel"> {
  if (input.decision === "cancel") return "cancel";
  state.counters = state.counters ?? {};
  state.counters["thesis.conflict_rounds"] = (state.counters["thesis.conflict_rounds"] ?? 0) + 1;
  const actor = readThesisActor(services, input.payload);
  if (input.decision !== "approve") {
    const payload = authorDecisionFromResumeInput({ decision: input.decision, payload: input.payload });
    await services.thesis.researchInputs.submitDecision(state.projectId, { actor, payload });
  }
  const context = await services.thesis.researchInputs.plannerContext(state.projectId);
  const unresolved = context.conflicts.unresolved.length;
  if (input.decision === "approve" && unresolved > 0) {
    throw new WorkflowInvalidStateError(state.runId, state.status, `仍有 ${unresolved} 条未裁决冲突，不能 approve`);
  }
  if (unresolved === 0) {
    state.stageResults["hitl.fact_conflicts"] = { resolved: true, conflictsResolvedInRound: true };
  } else {
    delete state.stageResults["hitl.fact_conflicts"];
  }
}

async function applyThesisOutlineDecision(
  services: WorkflowServices,
  state: WorkflowState,
  input: ResumeInput,
): Promise<void | "cancel"> {
  if (input.decision === "approve") {
    const actor = readThesisActor(services, input.payload);
    await services.thesis.planner.confirmMapping(state.projectId, actor.kind);
    state.stageResults["hitl.outline_confirm"] = { decision: "approve" };
    return;
  }
  if (input.decision === "cancel") return "cancel";
  if (input.decision === "revise") {
    const feedback = readFeedback(input.payload);
    if (feedback === undefined) {
      throw new WorkflowInvalidStateError(state.runId, state.status, "revise 需要携带非空 payload.feedback");
    }
    if (countCompletions(state, "thesis.storyline") >= MAX_OUTLINE_REVISIONS) {
      throw new WorkflowInvalidStateError(
        state.runId,
        state.status,
        `大纲修订次数已达上限（${MAX_OUTLINE_REVISIONS} 次），请 approve 或 cancel`,
      );
    }
    dropStageResult(state, "thesis.storyline");
    return;
  }
  throw new WorkflowInvalidStateError(
    state.runId,
    state.status,
    `decision 只能是 approve / revise / cancel（当前 "${input.decision}"）`,
  );
}

async function applyThesisAuthorDecision(
  services: WorkflowServices,
  state: WorkflowState,
  input: ResumeInput,
): Promise<void | "cancel"> {
  if (input.decision === "cancel") return "cancel";
  state.counters = state.counters ?? {};
  state.counters["thesis.author_decision_rounds"] = (state.counters["thesis.author_decision_rounds"] ?? 0) + 1;
  const actor = readThesisActor(services, input.payload);
  if (input.decision !== "approve") {
    const payload = authorDecisionFromResumeInput({ decision: input.decision, payload: input.payload });
    await services.thesis.researchInputs.submitDecision(state.projectId, { actor, payload });
    // M14.6：缺口决定若对应已规划章且选择了写作处置（限制口径 / 暂缓 / 附实验包），同步镜像为
    // writing_pause 决定——Planner 的缺材料章抑制与 Writer 的限制口径都消费 writing_pause
    if (payload.type === "missing_material_decision" && services.thesis.missingMaterials !== undefined) {
      const gap = await services.thesis.missingMaterials.get(state.projectId, payload.gapId);
      const writingDecision =
        payload.decision === "write_as_limitation"
          ? "write_as_limitation"
          : payload.decision === "defer_chapter"
            ? "defer"
            : payload.decision === "supply_experiment_data"
              ? "attach_experiment_package"
              : null;
      if (gap !== undefined && gap !== null && gap.chapterId !== undefined && writingDecision !== null) {
        await services.thesis.researchInputs.submitDecision(state.projectId, {
          actor,
          payload: { type: "writing_pause", subject: gap.chapterId, decision: writingDecision, rationale: `缺口 ${gap.gapId} 的作者决定（${payload.decision}）` },
        });
      }
    }
  }
  const missing = await services.thesis.planner.missingMaterialChapters(state.projectId);
  // M14.6：决定后重评估缺口台账（已解决缺口不再阻断；幂等）
  await syncMissingMaterialLedger(services, state.projectId, missing);
  if (input.decision === "approve" && missing.length > 0) {
    throw new WorkflowInvalidStateError(
      state.runId,
      state.status,
      `仍有缺材料且未获决定的章：${missing.map((chapter) => chapter.chapterId).join("、")}`,
    );
  }
  if (missing.length === 0) {
    state.stageResults["hitl.author_decision"] = { resolved: true };
  } else {
    delete state.stageResults["hitl.author_decision"];
  }
}

function readStringArrayPayload(payload: Record<string, unknown> | undefined, field: string): string[] {
  const value = payload?.[field];
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
}

export async function buildManuscriptDigest(services: WorkflowServices, projectId: string): Promise<string> {
  const files = await collectLatexFiles(services.projects.manuscriptDir(projectId));
  // M14.9.1 实验开关 metadata_blind：审稿视图按字段去掉作者 / 单位 / 邮箱 / 致谢与源码注释（缺省 production = 原样）
  const reviewInputView = (content: string) => (services.review?.inputMode === "metadata_blind" ? stripLatexReviewMetadata(content).text : content);
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
    parts.push(...splitSingleFileDigest(reviewInputView(files.mainTex.content)));
  }
  for (const section of files.sections.slice(0, 24)) {
    parts.push(`[${section.relativePath}]\n${sliceForDigest(reviewInputView(section.content), SECTION_DIGEST_BUDGET)}`);
  }
  if (parts.length === 0) {
    throw new BusinessError("STAGE_CONTRACT_VIOLATION", "manuscript 目录没有任何 .tex 文件");
  }
  // M11.4：总预算截断同样走句界安全切（裸 slice 会切在词中/命令内且无告知）
  return sliceForDigest(parts.join("\n\n"), 60_000);
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
/** 单元只含章节命令 / \label / 注释 / 空白（无可审正文） */
export function isHeadingOnlyUnit(content: string): boolean {
  return content
    .replace(/(^|[^\\])%.*$/gm, "$1")
    .replace(/\\(?:part|chapter|(?:sub){0,2}section|paragraph)\*?\s*(?:\[[^\]]*\])?\s*\{[^{}\n]*(?:\{[^{}\n]*\}[^{}\n]*)*\}/g, "")
    .replace(/\\label\{[^}]*\}/g, "")
    .trim() === "";
}

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
 * 单文件论文 digest 切块（M10.3；M11.4 audit 修复）：
 * preamble+摘要 为一块，其后每个 \section / \subsection / \subsubsection
 * 起始一段。
 *
 * M11.4 修复（实证：Attempt 7 clean run p-d12dc28ad850）：
 * - 旧「≤18 块」上限在真实返修稿（4 section + 15 subsection + 16
 *   subsubsection = 36 块）上把实验章后半（主对比 / 消融 / 极端场景 /
 *   边缘部署 / 结论）整体丢弃——reviewer 只见 44% 正文，三轮
 *   实验充分性恒 25/35，学术评分被截断视图压顶。上限提高到 64
 *   （总量仍由 60k 总预算兜底，成本有界）。
 * - 每块截断从裸 slice(0, 2600) 换成 sliceForDigest（句界安全 + 显式
 *   截断系统注）——M11.3 Phase D 已为分节路径修复同一缺陷类
 *   （截断误报 build/结构问题），单文件路径此前漏改。
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
    parts.push(`[${label}]\n${sliceForDigest(chunk, 2600)}`);
    if (parts.length >= 64) {
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
  /**
   * M14.1a：长章节编辑单元的派发绑定。存在时该目标是某物理文件的一个有界
   * logicalSpan 单元，哪些指令派发到它由确定性定位（原文引文锚点 / 标题 /
   * 严格词法）在目标构造期决定——循环里不再用 sectionMatches 的文件身份匹配
   * （否则同一文件的每个单元都会收到全部意见）。
   */
  binding?: RevisionTargetBinding;
}

export interface RevisionTargetBinding {
  /** 绑定到本单元的指令键：`d:<directive index>` / `x:<external instructionId>` */
  keys: Set<string>;
  /** 用于取回 issue 的文件级匹配目标（无 logicalSpan，文件身份可匹配） */
  matchTarget: RevisionTarget;
  /** 本单元所在物理文件的整文件 span 与全部单元（claim repair 等二次定位复用） */
  fileSpan: RevisionSpan;
  allUnits: RevisionSpan[];
}

/** M14.1a：未能可靠定位到编辑单元的派发（不猜位置；透明记录） */
export interface UnresolvedDispatch {
  file: string;
  directive: string;
  summary: string;
  reason: string;
}

/** 指令文本中的原文引文锚点（targetQuote 优先；其后是「」“”""『』内 ≥12 字的片段） */
function directiveAnchors(item: RevisionPlanItem | undefined, issue: ReviewIssue | null, extraText?: string): string[] {
  const anchors: string[] = [];
  if (item?.targetQuote !== undefined && item.targetQuote.trim() !== "") anchors.push(item.targetQuote);
  const texts = [item?.sourceText, item?.problem, item?.instruction, issue?.description, issue?.suggestedAction, extraText]
    .filter((text): text is string => typeof text === "string" && text !== "");
  for (const text of texts) {
    for (const match of text.matchAll(/[「“"『]([^」”"』]{12,})[」”"』]/g)) {
      anchors.push(match[1]!);
    }
  }
  return [...new Set(anchors)];
}

/**
 * 在一个物理文件内把一条指令定位到唯一编辑单元（确定性；找不到可靠定位即
 * unresolved，绝不猜）：
 *   1. 范围收窄：item.logicalSection 命中某 span id，或 section 引用恰好命名
 *      一个 span 的标题 → 只在该 span 的单元里找；该 span 若只有一个单元即命中。
 *   2. 原文锚点：targetQuote / 引号片段在（收窄后的）范围内恰好出现一次；
 *      跨相邻单元的锚点合并两个单元；多次出现 = 歧义。
 *   3. 否则 unresolved（不做任何词法 / 语义相似度猜测）。
 */
function resolveDirectiveUnit(
  spans: readonly RevisionSpan[],
  unitsBySpan: ReadonlyMap<string, RevisionSpan[]>,
  fileSpan: RevisionSpan,
  allUnits: readonly RevisionSpan[],
  input: { item?: RevisionPlanItem; issue: ReviewIssue | null; sectionRef?: string; extraText?: string },
  options: { wholeSpanFallback?: boolean } = {},
): { unit?: RevisionSpan; matchedBy?: string; reason?: string } {
  const { item, issue } = input;
  const sectionRef = input.sectionRef ?? item?.section ?? issue?.section ?? "";
  let scopeSpan: RevisionSpan | undefined;
  if (spans.length > 1) {
    const byId = item?.logicalSection !== undefined
      ? spans.find((span) => span.logicalSection === item.logicalSection || span.label === item.logicalSection)
      : undefined;
    const byHeading = spans.filter((span) => sectionRefNamesHeading(sectionRef, [span.heading]));
    scopeSpan = byId ?? (byHeading.length === 1 ? byHeading[0] : undefined);
  } else {
    scopeSpan = spans[0];
  }
  const anchors = directiveAnchors(item, issue, input.extraText);
  if (scopeSpan !== undefined) {
    const units = unitsBySpan.get(scopeSpan.logicalSection) ?? [scopeSpan];
    const byQuote = resolveUnitByQuotes(scopeSpan, units, anchors);
    if (byQuote.unit !== undefined) return { unit: byQuote.unit, matchedBy: "quote" };
    if (units.length === 1) return { unit: units[0]!, matchedBy: "heading" };
    // M14.4 thesis bounded：**完全没有锚点**的指令（gate blocker / 无引文的泛化
    // 章节意见）回退到整 span 合并单元——编辑范围仍不超出该 span，且候选进入
    // 同一守卫链。注意：带锚点但解析失败（NOT_FOUND / AMBIGUOUS）**不**回退
    // ——找不到唯一目标时按 M14.1a 纪律 unresolved，不允许悄悄扩大为整节重写。
    if (options.wholeSpanFallback === true && anchors.length === 0) {
      return { unit: mergeAdjacentUnits(units, 0, units.length - 1), matchedBy: "heading" };
    }
    return { reason: byQuote.reason ?? "UNRESOLVED" };
  }
  const byQuote = resolveUnitByQuotes(fileSpan, allUnits, anchors);
  if (byQuote.unit !== undefined) {
    if (isUnitSpanId(byQuote.unit.logicalSection) && /#u\d+-\d+$/.test(byQuote.unit.logicalSection)) {
      // 合并单元必须属于同一 span（跨章节边界的引文不构成单一编辑范围）
      const from = allUnits.find((unit) => unit.start === byQuote.unit!.start);
      const to = allUnits.find((unit) => unit.end === byQuote.unit!.end);
      if (from !== undefined && to !== undefined && baseSpanId(from.logicalSection) !== baseSpanId(to.logicalSection)) {
        return { reason: "ANCHOR_CROSSES_SECTIONS" };
      }
    }
    return { unit: byQuote.unit, matchedBy: "quote" };
  }
  return { reason: byQuote.reason ?? "UNRESOLVED" };
}

/**
 * M14.1a P0-1：把超过编辑单元上限的目标展开成有界 logicalSpan 单元目标。
 *
 * - 整文件目标（outline 的 sections/x.tex、多文件导入的章节文件）> maxChars：
 *   按标题切 span（无标题 = 整文件 span），每个 span 再按段落窗口切单元；
 * - 单文件 main.tex 的标题 span > maxChars：同样切单元；
 * - ≤ maxChars 的目标原样保留（短论文行为零变化）。
 * 指令按 resolveDirectiveUnit 绑定到单元；同一 span 内重叠的绑定单元合并为一个
 * 目标（不会出现两个 patch 静默覆盖同一范围）；定位失败的指令记入 unresolved。
 *
 * M14.4 thesis bounded（options.boundedAll）：学位论文修订不再以文件尺寸决定
 * 是否 span 化——≤ maxChars 的章节文件也展开为段落块单元（quote 锚点绑定到
 * 引文所在段落窗口；无锚点指令回退整 span 合并单元）。真实 R3 实锤：thesis
 * 节文件普遍 2–5KB（全部低于旧阈值），文件级派发使 Writer 输出整体覆写章节
 * 且候选不经过 scope/fact/citation 校验环（186→544 issues 反馈环）。
 */
/**
 * M14.4 P0-2：候选内容塌缩信号（确定性纯函数）。局部修订（解决 finding）不应把
 * 目标区间压缩成摘要式短文——真实 R3 实锤：整文件重写把 2–5KB 章节改写成数百
 * 字梗概，逐轮丢失正文细节（issues 186→544 / academicScore 63→54 反馈环）。
 * 触发口径（保守）：绝对缩减 > 300 字符 且 替换文本 < 原文 50%。只拦截「塌缩」，
 * 不拦截等长/小幅增删与正常精简；大幅删减本应走重新规划 / 作者决定。
 */
function revisionContentCollapse(before: string, after: string): { ratio: number; droppedChars: number } | null {
  const dropped = before.length - after.length;
  if (dropped <= 300) return null;
  const ratio = after.length / Math.max(1, before.length);
  return ratio < 0.5 ? { ratio, droppedChars: dropped } : null;
}

function expandLongFileTargets(
  targets: readonly RevisionTarget[],
  directives: readonly RevisionDirective[],
  externals: readonly ExternalDirectiveDispatch[],
  maxChars: number,
  options: { boundedAll?: boolean } = {},
): { targets: RevisionTarget[]; unresolved: UnresolvedDispatch[]; expandedFiles: number } {
  const out: RevisionTarget[] = [];
  const unresolved: UnresolvedDispatch[] = [];
  let expandedFiles = 0;
  for (const target of targets) {
    const isSpanTarget = target.logicalSpan !== undefined;
    const size = isSpanTarget ? target.logicalSpan!.content.length : target.currentLatex.length;
    const headless = !isSpanTarget && locateLatexSections(target.relativePath, target.currentLatex).length === 0;
    const preamble = !isSpanTarget && target.currentLatex.includes("\\documentclass");
    const bounded = options.boundedAll === true && !isSpanTarget;
    if (target.key === "abstract" || (headless && preamble) || (size <= maxChars && !bounded)) {
      out.push(target);
      continue;
    }
    expandedFiles += 1;
    const spans = isSpanTarget ? [target.logicalSpan!] : locateFileSpans(target.relativePath, target.currentLatex);
    const unitsBySpan = new Map<string, RevisionSpan[]>();
    const allUnits: RevisionSpan[] = [];
    for (const span of spans) {
      // thesis bounded：小文件用段落块粒度（quote → 段落窗口）；大文件维持
      // 贪心装箱（prompt 有界）。两种分法的单元都精确拼回 span 全文。
      const units = size <= maxChars
        ? partitionSpanIntoBlockUnits(span).units
        : partitionSpanIntoUnits(span, maxChars).units;
      unitsBySpan.set(span.logicalSection, units);
      allUnits.push(...units);
    }
    const fileSpan = fileBodySpan(target.relativePath, target.currentLatex);
    // 文件级匹配目标：无 logicalSpan 时文件身份 / 标题都可匹配；单文件 span 目标沿用其自身
    const matchTarget: RevisionTarget = isSpanTarget
      ? target
      : { key: target.key, relativePath: target.relativePath, currentLatex: target.currentLatex };
    const candidates: Array<{ key: string; item?: RevisionPlanItem; issue: ReviewIssue | null; sectionRef?: string; extraText?: string; summary: string }> = [];
    for (const [index, directive] of directives.entries()) {
      const issue = directive.match(matchTarget);
      if (issue === null) continue;
      candidates.push({ key: `d:${index}`, item: directive.item, issue, summary: (directive.item?.problem ?? issue.description).slice(0, 120) });
    }
    for (const external of externals) {
      if (external.section === undefined || !sectionMatches(external.section, matchTarget)) continue;
      candidates.push({ key: `x:${external.instructionId}`, issue: null, sectionRef: external.section, extraText: external.text, summary: external.text.slice(0, 120) });
    }
    if (candidates.length === 0) continue;
    const bound = new Map<string, { unit: RevisionSpan; keys: Set<string> }>();
    for (const candidate of candidates) {
      const resolution = resolveDirectiveUnit(spans, unitsBySpan, fileSpan, allUnits, {
        ...(candidate.item !== undefined ? { item: candidate.item } : {}),
        issue: candidate.issue,
        ...(candidate.sectionRef !== undefined ? { sectionRef: candidate.sectionRef } : {}),
        ...(candidate.extraText !== undefined ? { extraText: candidate.extraText } : {}),
      }, { wholeSpanFallback: bounded });
      if (resolution.unit === undefined) {
        unresolved.push({ file: target.relativePath, directive: candidate.key, summary: candidate.summary, reason: resolution.reason ?? "UNRESOLVED" });
        continue;
      }
      const existing = bound.get(resolution.unit.logicalSection);
      if (existing !== undefined) existing.keys.add(candidate.key);
      else bound.set(resolution.unit.logicalSection, { unit: resolution.unit, keys: new Set([candidate.key]) });
    }
    // 同一 span 内重叠的绑定单元 → 合并为一个目标（keys 取并集）
    for (const span of spans) {
      const units = unitsBySpan.get(span.logicalSection) ?? [span];
      const entries = [...bound.values()]
        .filter((entry) => baseSpanId(entry.unit.logicalSection) === span.logicalSection)
        .sort((a, b) => a.unit.start - b.unit.start);
      let index = 0;
      while (index < entries.length) {
        let current = entries[index]!;
        let end = current.unit.end;
        const keys = new Set(current.keys);
        let next = index + 1;
        while (next < entries.length && entries[next]!.unit.start < end) {
          end = Math.max(end, entries[next]!.unit.end);
          for (const key of entries[next]!.keys) keys.add(key);
          next += 1;
        }
        if (next - index > 1) {
          const from = units.findIndex((unit) => unit.start === current.unit.start);
          const to = units.findIndex((unit) => unit.end === end);
          current = { unit: from >= 0 && to >= from ? mergeAdjacentUnits(units, from, to) : current.unit, keys };
        }
        out.push({
          key: target.key,
          relativePath: target.relativePath,
          currentLatex: current.unit.content,
          logicalSpan: current.unit,
          binding: { keys: current.keys, matchTarget, fileSpan, allUnits },
        });
        index = next;
      }
    }
  }
  return { targets: out, unresolved, expandedFiles };
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
  item: { id?: string; instructionId?: string; relatedEvidenceIds?: string[]; logicalSection?: string },
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
    planItemIds: [...new Set([...(priorTrace?.planItemIds ?? []), item.id ?? `improvement:${index + 1}`])],
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
            id?: string;
            section: string;
            action: string;
            actionType?: "modify" | "noop" | "author_decision_required" | "evidence_only";
            logicalSection?: string;
            targetQuote?: string;
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
      const instructionBaseline = structuredClone(instructions);
      let instructionsChanged = false;
      const actionable = items.filter((item) => {
        if (item.actionType === "author_decision_required") {
          recordUnresolvedPlanOutcome(instructions, item, items.indexOf(item), "AUTHOR_DECISION_REQUIRED", "This plan item requires an author decision.");
          instructionsChanged = true;
          return false;
        }
        if (item.actionType === "evidence_only") {
          // 合法类型但无 Writer 派发语义（证据链接即计划响应）——fail-closed：
          // 意见保持 open 待作者/证据确认，如实记录原因（不误称「未识别类型」）
          recordUnresolvedPlanOutcome(instructions, item, items.indexOf(item), "EVIDENCE_ONLY_RECORDED", "evidence_only item: no Writer dispatch (evidence linkage is the planned response); instruction remains open for author confirmation.");
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
          /**
           * M11.4 Reliability Closure（Run F 实证）：Planner 主张基线已覆盖、
           * 确定性引文核验失败——这既不是系统故障也不是可自动修复项：基线
           * 是否满足该意见无法机器确认，诚实终态 = 作者裁决（引文失败原因
           * 如实记录），而不是 plain unresolved（会被任务层判系统 FAIL）。
           */
          recordUnresolvedPlanOutcome(
            instructions,
            item,
            items.indexOf(item),
            "AUTHOR_DECISION_REQUIRED",
            `Planner 主张基线已覆盖该意见（actionType=noop），但确定性核验未通过（${coverage.reason ?? "NOOP_COVERAGE_FAILED"}；引文与目标章节不匹配）——基线覆盖需作者确认。`,
          );
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
      if (instructionsChanged) await services.externalInstructions.saveChanges(projectId, instructionBaseline, instructions);
      return actionable.map((item, index) => ({
        match: (target: RevisionTarget) => {
          const matches =
            (item.logicalSection !== undefined && target.logicalSpan?.logicalSection === item.logicalSection) ||
            (item.logicalSection !== undefined && target.logicalSpan?.heading.toLowerCase() === item.logicalSection.toLowerCase()) ||
            revisionItemMatchesTarget({
            // M11.4 Reliability Closure：优先消费落盘稳定 id（同 trace / patch 空间）
            id: item.id ?? `improvement:${items.indexOf(item) + 1}`, kind: "review_finding", priority: item.priority === "high" ? "high" : "medium",
            section: item.section, problem: item.rationale ?? item.action, instruction: item.action, expectedOutcome: item.action,
            status: "planned", ...(item.instructionId ? { instructionId: item.instructionId } : {}),
          }, target);
          return matches ? planItemToIssue(item) : null;
        },
        // M10.3：改进计划条目以伪 RevisionPlanItem 形态携带证据与意见关联——
        // Writer 修订 prompt 据此注入「修改前依据」（itemEvidence 池），Fact
        // Preservation 的授权口径不变（improvementPlanItems 通道）
        item: {
          id: item.id ?? `improvement:${index + 1}`,
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
          ...(item.targetQuote !== undefined ? { targetQuote: item.targetQuote } : {}),
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
