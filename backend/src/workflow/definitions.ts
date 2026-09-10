/**
 * Workflow 定义。
 *
 * 两条一级工作流共享后段（D-0010）：
 *
 *   Idea-to-Paper 前段：
 *     research.idea → research.feasibility → HITL(feasibility: approve/adjust/cancel)
 *     → outline.plan → HITL(outline: approve/revise/cancel) → writing.sections
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

import { readFile, writeFile } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import { BusinessError, WorkflowInvalidStateError } from "../errors.js";
import type { GenerationService } from "../generation/GenerationService.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { EvidenceStore, EvidenceRecord } from "../evidence/EvidenceStore.js";
import type { SourceStore } from "../sources/SourceStore.js";
import type { ManuscriptService } from "../manuscript/ManuscriptService.js";
import type { ManuscriptRevisionStore } from "../manuscript/RevisionStore.js";
import type { LatexCompiler } from "../latex/LatexCompiler.js";
import { diagnosticFiles, type LatexDiagnostic } from "../latex/diagnostics.js";
import type { WriterService } from "../writer/WriterService.js";
import type { ResearcherService, ResearchArtifact } from "../agents/ResearcherService.js";
import { readResearchArtifact } from "../agents/ResearcherService.js";
import { readFeasibilityReport, type FeasibilityService } from "../agents/FeasibilityService.js";
import type { ReviewerService, ReviewIssue } from "../agents/ReviewerService.js";
import type { CitationService, CitationReport } from "../citation/CitationService.js";
import { extractCitationKeys } from "../citation/StaticCitationChecker.js";
import type { CitationIntegrityService } from "../citation/CitationIntegrityService.js";
import type { CitationCallout, ReferenceEntry } from "../citation/integrity.js";
import { readSemanticMode } from "../citation/semanticMode.js";
import type { PaperStore } from "../paper/PaperStore.js";
import type { PaperMapService } from "../paper/PaperMapService.js";
import type { ReviewContextBuilder, CitationContextEntry } from "../paper/ReviewContextBuilder.js";
import { SectionReviewService, SECTION_REVIEW_INSTRUCTION } from "../paper/SectionReviewService.js";
import { SectionReviewScheduler } from "../paper/SectionReviewScheduler.js";
import { readFindings, type FindingCategory, type FindingSeverity } from "../review/finding.js";
import { aggregateReviews, type ReviewSummary } from "../review/ReviewAggregator.js";
import type { ReviewArtifactStore } from "../review/reviewArtifacts.js";
import { buildRevisionPlan, type RevisionPlanItem } from "../review/revisionPlan.js";
import {
  judgeOutcome,
  scorecardOf,
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
  sources: SourceStore;
  manuscript: ManuscriptService;
  writer: WriterService;
  citation: CitationService;
  latex: LatexCompiler;
  /** PDF Review Foundation 服务束（existing_paper_review 用） */
  paper: PaperReviewServices;
  /** reviews/ 产物读写（round 编号、最新汇总） */
  reviewArtifacts: ReviewArtifactStore;
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
      const evidence = await usableEvidence(services, ctx.projectId);
      const project = await services.projects.getRequired(ctx.projectId);
      const citationReport = await services.citation.latestReport(ctx.projectId);
      const citationDigest = citationReport
        ? `cited=${citationReport.summary.citedCount} missing=${citationReport.summary.missingKeys} hallucinated=${citationReport.summary.hallucinated} mismatched=${citationReport.summary.mismatched}`
        : undefined;

      // fan-out：三类 review skill 并行（Promise.all；各 mode 独立 contextScope）
      const results = await services.reviewer.reviewAll({
        projectId: ctx.projectId,
        manuscriptDigest: digest,
        evidence,
        targetProfile: project.targetProfile,
        ...(citationDigest !== undefined ? { citationDigest } : {}),
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
      await services.reviewArtifacts.saveSummary(ctx.projectId, round, summary);
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

function qualityGateStage(services: WorkflowServices): StageSpec {
  return {
    id: "quality.gate",
    description: "Quality Gate：确定性判定（引用/事实/审稿/目标可行性）",
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
      const gate = evaluateQualityGate(
        { review, citation, evidence, feasibility },
        QUALITY_THRESHOLDS(services),
      );
      // 轮次 = 所消费 review 汇总的轮次（同轮配对，跨 run 不漂移）
      const round = review.round;
      await saveQualityGateReport(services.projects, ctx.projectId, round, gate, review);
      // 收敛判定（D-0026，确定性无 LLM）：与 iteration-history 上一轮 scorecard
      // 对比得 PASS / IMPROVED / CONVERGED / REGRESSION；逐轮追加记录（按 gateRound 幂等）
      const scorecard = scorecardOf(gate, review);
      const iterations = await services.reviewArtifacts.loadIterations(ctx.projectId);
      const previous = iterations.at(-1)?.scorecard ?? null;
      const outcome = judgeOutcome(scorecard, previous);
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
        },
        gate.passed
          ? "Quality Gate 通过"
          : `Quality Gate 未通过：${gate.reasons.length} 项阻止（${outcome ?? "首轮无对比"}）`,
      );
      return {
        passed: gate.passed,
        reasonCount: gate.reasons.length,
        reasons: gate.reasons.slice(0, 8),
        round,
        outcome,
        revision: typeof review.reviewedRevision === "number" ? review.reviewedRevision : 0,
      };
    },
  };
}

// ============================================================
// Revision Plan / LaTeX 修复 / Finalize / 不收敛 HITL（M4.7）
// ============================================================

/**
 * 确定性派生修订计划（reviews/revision-plan-r{round}.json）：
 * critical/major finding 与引用缺失 → 派发；minor 只记录不修（避免非收敛）。
 * 纯代码，无 LLM——Writer 只是计划的执行者。
 */
function revisionPlanStage(services: WorkflowServices): StageSpec {
  return {
    id: "revision.plan",
    description: "确定性派生修订计划（critical/major 派发，minor 只记录）",
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
      const buildErrorValue = readBuildError(ctx.state);
      const plan = buildRevisionPlan({
        projectId: ctx.projectId,
        sourceRevision,
        reviewRound: summary.round,
        summary,
        citationMissing: await citationMissingTargets(services, ctx.projectId),
        ...(buildErrorValue !== undefined
          ? { buildError: { message: buildErrorValue.slice(0, 500) } }
          : {}),
        ...(gateBlockers.length > 0 ? { gateBlockers } : {}),
      });
      await services.reviewArtifacts.savePlan(ctx.projectId, plan);
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
      // 修复即改稿：提交修订（幂等；Writer 输出与原文相同则不产生新修订号）
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
              };
        return {
          outcome: typeof gate["outcome"] === "string" ? gate["outcome"] : null,
          gateRound,
          gateReasons: gate["reasons"] ?? [],
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
    retryable: ["transient", "timeout", "runtime_unavailable", "contract_violation"],
    async execute(ctx) {
      const outline = await services.manuscript.loadOutline(ctx.projectId);
      const files = await collectLatexFiles(services.projects.manuscriptDir(ctx.projectId));
      if (outline === null && files.sections.length === 0) {
        throw new BusinessError("STAGE_CONTRACT_VIOLATION", "没有任何可修订的章节文件");
      }
      const buildError = readBuildError(ctx.state);
      const evidence = await usableEvidence(services, ctx.projectId);
      const artifact = await readResearchArtifact(services.projects, ctx.projectId);
      const bibliography = artifact?.bibliography ?? [];
      const project = await services.projects.getRequired(ctx.projectId);

      // 修订指令：shared loop 以落盘的确定性修订计划为准（计划缺失时回退执行期派生）；
      // apply 仍用改进计划（映射为 issue）
      const directives =
        stageId === "revision.apply"
          ? await collectRevisionDirectives(services, ctx.projectId, stageId)
          : await collectPlanDirectives(services, ctx.projectId);

      const targets = listRevisionTargets(outline, files, directives);
      const revised: string[] = [];
      for (const [index, target] of targets.entries()) {
        if (ctx.signal.aborted) {
          throw new BusinessError("WORKFLOW_CANCELLED", "修订已被取消");
        }
        const issues = directives
          .map((directive) => directive.match(target))
          .filter((issue): issue is ReviewIssue => issue !== null);
        if (issues.length === 0 && buildError === undefined) {
          continue; // 无问题的章节不动（不烧 Token）
        }
        // 章节人类标题（大纲 id → title；缺大纲时回退 id）：修订 prompt 以标题称呼章节
        const sectionMeta = outline?.sections.find((section) => section.id === target.key);
        const result = await services.writer.reviseSection({
          projectId: ctx.projectId,
          section: {
            id: target.key,
            file: target.relativePath.replaceAll("\\", "/").split("/").pop() ?? target.key,
            title: sectionMeta?.title ?? target.key,
          },
          outline: outline ?? { title: project.title, sections: [] },
          currentLatex: target.currentLatex,
          issues,
          evidence,
          bibliography,
          ...(buildError !== undefined ? { buildError } : {}),
        });
        await writeFile(
          join(services.projects.manuscriptDir(ctx.projectId), target.relativePath),
          result.latex.trim() + "\n",
          "utf8",
        );
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
      // 一轮修订 = 一个不可变修订号（全部章节写完后统一提交，不逐节切碎）
      const revision = await services.revisions.commit(ctx.projectId, stageId, ctx.runId);
      return {
        revisedSections: revised.length,
        sections: revised,
        revision: revision.revision,
        changed: revision.created,
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
      await ctx.emitDomain(
        build.passed ? "build_gate.passed" : "build_gate.failed",
        {
          revision,
          reasons: build.reasons.slice(0, 5),
          tool: compile.tool,
          durationMs: compile.durationMs,
        },
        build.passed ? "Build Gate 通过（PDF 已产出）" : `Build Gate 失败：${build.reasons[0] ?? "编译失败"}`,
      );
      // Build 通过即冻结 Draft（幂等；质量 Gate 不参与 Draft 判定）
      let draftArtifactId: string | undefined;
      if (build.passed) {
        const draft = await services.artifacts.ensureDraft(ctx.projectId, revision, record, ctx.runId);
        draftArtifactId = draft.artifactId;
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
  // 任何改稿动作（修订 / 编译修复都写入 manuscript）
  const contentIdx = Math.max(reviseIdx, repairIdx);
  const citationIdx = lastCompletionIndex(state, "citation.verify");
  const reviewIdx = lastCompletionIndex(state, "review.run");
  const gateIdx = lastCompletionIndex(state, "quality.gate");
  const buildIdx = lastCompletionIndex(state, "build.draft");
  const planIdx = lastCompletionIndex(state, "revision.plan");
  const finalIdx = lastCompletionIndex(state, "build.final");

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

  const completion = (label: "final" | "draft") =>
    ({
      kind: "complete",
      label,
      summary: {
        buildOk,
        buildGateReasons: build["buildGateReasons"] ?? [],
        qualityGatePassed: gatePassed,
        qualityGateReasons: gateResult["reasons"] ?? [],
        revisionRounds: revisionRoundsUsed(state),
        draftArtifactId: build["draftArtifactId"] ?? null,
        ...(label === "final"
          ? { finalArtifactId: state.stageResults["build.final"]?.["finalArtifactId"] ?? null }
          : {}),
      },
    }) satisfies PlanDecision;

  // accept_draft（overflow 或 stalled 的回答）→ 构建 Draft PDF 后完成
  const draftPath = (): PlanDecision => {
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
  if ((outcome === "CONVERGED" || outcome === "REGRESSION") && !stalledAnswered) {
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
      return {
        taskId: result.taskId,
        reportPath: result.reportPath,
        evidenceCount: result.evidenceAppended,
        bibliographyCount: result.bibliographyCount,
        gaps: result.report.researchGaps.length,
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
      const evidence = await usableEvidence(services, ctx.projectId);
      const feedback = readFeedback(ctx.state.inputs["hitl.outline_confirm"]?.payload);
      const outline = await services.writer.planOutline({
        projectId: ctx.projectId,
        researchDigest: {
          domainOverview: artifact.report.domainOverview,
          researchGaps: artifact.report.researchGaps,
          potentialContributions: artifact.report.potentialContributions,
        },
        evidence,
        bibliography: artifact.bibliography,
        targetProfile: project.targetProfile,
        documentType: project.documentType,
        ...(feedback !== undefined ? { feedback } : {}),
      });
      await services.manuscript.saveOutline(ctx.projectId, outline);
      await services.manuscript.writeBibliography(ctx.projectId, artifact.bibliography);
      await services.manuscript.writeMainTex(ctx.projectId, outline, artifact.bibliography.length > 0);
      // 大纲骨架也是 manuscript 状态：提交修订（后续 gate/build 对齐基准）
      const revision = await services.revisions.commit(ctx.projectId, "outline.plan", ctx.runId);
      return {
        sections: outline.sections.length,
        title: outline.title,
        references: artifact.bibliography.length,
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

function outlineConfirmStage(services: WorkflowServices): StageSpec {
  return {
    id: "hitl.outline_confirm",
    description: "等待用户确认大纲",
    requiredInputs: ["outline.plan"],
    producedOutputs: ["用户决策"],
    hitl: {
      prompt: "大纲已生成，请确认后开始分节写作",
      options: ["approve", "revise", "cancel"],
      payload: async (ctx) => {
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
          })),
        };
      },
    },
  };
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
      const artifact = await requireResearchArtifact(services, ctx.projectId);
      const evidence = await usableEvidence(services, ctx.projectId);

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
          bibliography: artifact.bibliography,
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
      await services.manuscript.writeMainTex(ctx.projectId, outline, artifact.bibliography.length > 0);
      await services.manuscript.rebuildContext(ctx.projectId, {
        evidenceStats: await services.evidence.stats(ctx.projectId),
      });
      // 初稿完成：提交首个内容修订
      const revision = await services.revisions.commit(ctx.projectId, "writing.sections", ctx.runId);
      return { sectionsWritten: written.length, sections: written, bytesTotal, revision: revision.revision };
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
    feasibilityStage(services),
    feasibilityConfirmStage(services),
    outlinePlanStage(services),
    outlineConfirmStage(services),
    writingSectionsStage(services),
    citationVerifyStage(services),
    reviewRunStage(services),
    qualityGateStage(services),
    revisionPlanStage(services),
    revisionReviseStage(services, "revision.revise"),
    revisionRepairStage(services),
    revisionOverflowStage(),
    revisionStalledStage(services),
    buildDraftStage(services),
    buildFinalStage(services),
  ];

  const front = [
    "research.idea",
    "research.feasibility",
    "hitl.feasibility_confirm",
    "outline.plan",
    "hitl.outline_confirm",
    "writing.sections",
  ];

  return {
    kind: "idea_to_paper",
    description:
      "Idea-to-Paper：调研 → 可行性 → 确认 → 大纲 → 确认 → 分节写作 → 引用核验 → 审稿 → Quality Gate →（bounded 修订）→ 构建",
    stages,
    plan(state: WorkflowState): PlanDecision {
      for (const stageId of front) {
        if (!(stageId in state.stageResults)) {
          return { kind: "stage", stageId };
        }
      }
      return planSharedTail(state, services);
    },
    async onInput(state, stageId, input): Promise<void | "cancel"> {
      switch (stageId) {
        case "hitl.feasibility_confirm":
          return applyFeasibilityDecision(services, state, input);
        case "hitl.outline_confirm":
          return applyOutlineDecision(state, input);
        case "hitl.revision_overflow":
          return applyOverflowDecision(state, input);
        case "hitl.revision_stalled":
          return applyStalledDecision(state, input);
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
    description: "校验已导入的 LaTeX 项目结构（入口 / 章节 / bib / 图表）",
    requiredInputs: [],
    producedOutputs: ["结构校验结果"],
    maxAttempts: 1,
    timeoutMs: 60_000,
    retryable: [],
    async execute(ctx) {
      const report = await readImportReport(services, ctx.projectId);
      const files = await collectLatexFiles(services.projects.manuscriptDir(ctx.projectId));
      if (files.mainTex === null) {
        throw new BusinessError(
          "IMPORT_VALIDATION",
          "项目缺少可解析的 main.tex（请先调用 POST /api/projects/:id/import 导入 LaTeX 项目）",
        );
      }
      return {
        entryFile: report?.structure.entryFile ?? "main.tex",
        texFiles: files.allTex.length,
        bibFile: report?.structure.bibFile ?? null,
        warnings: files.warnings.slice(0, 5),
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

function improvementPlanStage(services: WorkflowServices): StageSpec {
  return {
    id: "plan.improvement",
    description: "Writer 制定分节改进计划（基于审稿问题 + 目标差距）",
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
      const plan = await services.writer.planImprovement({
        projectId: ctx.projectId,
        issues: review?.issues ?? [],
        analysisDigest: `${artifact.report.domainOverview.slice(0, 400)}\n弱点：${artifact.report.researchGaps.slice(0, 5).join("；")}`,
        feasibilityLevel: feasibility?.level ?? "未评估",
        targetProfile: project.targetProfile,
        ...(feedback !== undefined ? { feedback } : {}),
      });
      await writeJsonAtomic(
        join(services.projects.researchDir(ctx.projectId), "improvement-plan.json"),
        { generatedAt: new Date().toISOString(), plan },
      );
      return { items: plan.items.length };
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
    importUnderstandStage(services),
    citationVerifyStage(services),
    reviewRunStage(services),
    feasibilityStage(services, "assessment.target"),
    improvementPlanStage(services),
    planConfirmStage(services),
    revisionReviseStage(services, "revision.apply"),
    revisionReviseStage(services, "revision.revise"),
    revisionPlanStage(services),
    revisionRepairStage(services),
    revisionOverflowStage(),
    revisionStalledStage(services),
    buildDraftStage(services),
    qualityGateStage(services),
    buildFinalStage(services),
  ];

  const front = [
    "import.parse",
    "import.baseline_build",
    "import.understand",
    "citation.verify",
    "review.run",
    "assessment.target",
    "plan.improvement",
    "hitl.plan_confirm",
    "revision.apply",
  ];

  return {
    kind: "existing_paper_improvement",
    description:
      "Existing-LaTeX Improvement：结构解析 → 基线编译 → 论文理解 → 引用审计 → 审稿 → 目标评估 → 改进计划 → 确认 → 逐节改造 →（共享后段：复审 / Quality Gate / bounded 修订 / 构建）",
    stages,
    plan(state: WorkflowState): PlanDecision {
      for (const stageId of front) {
        if (!(stageId in state.stageResults)) {
          return { kind: "stage", stageId };
        }
      }
      return planSharedTail(state, services);
    },
    async onInput(state, stageId, input): Promise<void | "cancel"> {
      switch (stageId) {
        case "hitl.plan_confirm":
          return applyPlanDecision(state, input);
        case "hitl.revision_overflow":
          return applyOverflowDecision(state, input);
        case "hitl.revision_stalled":
          return applyStalledDecision(state, input);
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

/** 可用于写作 / 审稿的 Evidence（verified / plausible 优先，unverified 兜底，限量） */
async function usableEvidence(services: WorkflowServices, projectId: string): Promise<EvidenceRecord[]> {
  const records = await services.evidence.list(projectId);
  const trusted = records.filter(
    (record) => record.verificationStatus === "verified" || record.verificationStatus === "plausible",
  );
  const pool =
    trusted.length >= 3
      ? trusted
      : [...trusted, ...records.filter((record) => record.verificationStatus === "unverified")];
  return pool
    .sort(
      (a, b) => (b.supportStrength === "direct" ? 1 : 0) - (a.supportStrength === "direct" ? 1 : 0),
    )
    .slice(0, 20);
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

/** 构建审稿 / 理解用的稿件摘要（大纲 + 各节内容截断；或导入项目全部 tex） */
async function buildManuscriptDigest(services: WorkflowServices, projectId: string): Promise<string> {
  const files = await collectLatexFiles(services.projects.manuscriptDir(projectId));
  const parts: string[] = [];
  if (files.mainTex !== null) {
    parts.push(`[main.tex]\n${files.mainTex.content.slice(0, 2000)}`);
  }
  for (const section of files.sections.slice(0, 15)) {
    parts.push(`[${section.relativePath}]\n${section.content.slice(0, 2500)}`);
  }
  if (parts.length === 0) {
    throw new BusinessError("STAGE_CONTRACT_VIOLATION", "manuscript 目录没有任何 .tex 文件");
  }
  return parts.join("\n\n").slice(0, 40_000);
}

/** 读取最新 review 汇总（按 round 编号最大） */
function latestReviewSummary(
  services: WorkflowServices,
  projectId: string,
): Promise<ReviewSummary | null> {
  return services.reviewArtifacts.latestSummary(projectId);
}

/** 修订指令：以 ReviewIssue 形式表达，可按目标章节匹配 */
interface RevisionDirective {
  /** 返回匹配到目标时对应的 issue */
  match(target: RevisionTarget): ReviewIssue | null;
}

export interface RevisionTarget {
  key: string;
  relativePath: string;
  currentLatex: string;
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
    if (item.status !== "planned") {
      continue; // minor / gate 阻止项：记录但不派发（D-0026 收敛纪律）
    }
    const issue = revisionPlanItemToIssue(item);
    directives.push({
      match: (target: RevisionTarget) => (sectionMatches(item.section, target) ? issue : null),
    });
  }
  return directives;
}

/** 修订计划条目 → ReviewIssue（Writer 修订 prompt 的输入形态） */
function revisionPlanItemToIssue(item: RevisionPlanItem): ReviewIssue {
  const severity = item.priority === "high" ? "critical" : item.priority === "low" ? "minor" : "major";
  return {
    category: item.kind === "citation_missing" ? "citation" : "academic",
    severity,
    section: item.section,
    description: `${item.problem}（计划要求：${item.instruction}）`,
    suggestedAction: item.instruction,
    blocking: item.priority === "high",
  };
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
      ) as { plan?: { items?: { section: string; action: string; rationale?: string; priority?: string }[] } };
      return (plan.plan?.items ?? []).map((item) => ({
        match: (target: RevisionTarget) =>
          sectionMatches(item.section, target) ? planItemToIssue(item) : null,
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

/** 引用缺失的确定性定位：missing key → 出现该引用的 tex 文件（revision.plan / 修订指令共用） */
async function citationMissingTargets(
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

/** issue/plan 的 section 字段与修订目标的模糊匹配（路径 / id / 文件名） */
function sectionMatches(sectionRef: string, target: RevisionTarget): boolean {
  const ref = sectionRef.trim().replaceAll("\\", "/").toLowerCase();
  if (ref === "") {
    return false;
  }
  const path = target.relativePath.replaceAll("\\", "/").toLowerCase();
  const fileName = path.split("/").pop() ?? path;
  const stem = fileName.replace(/\.tex$/, "");
  return (
    ref === path ||
    ref === fileName ||
    ref === stem ||
    ref === target.key.toLowerCase() ||
    ref.endsWith(`/${path}`) ||
    path.endsWith(ref) ||
    ref.includes(stem) ||
    target.key.toLowerCase().includes(ref)
  );
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
    for (const section of outline.sections) {
      add(section.id, `sections/${section.file}`, contentByPath.get(`sections/${section.file}`));
    }
  } else {
    for (const file of files.sections) {
      add(file.relativePath, file.relativePath, file.content);
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
