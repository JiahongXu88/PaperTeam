/**
 * Workflow 定义（M3.2）。
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
 *   共享后段（bounded revision loop，PRD §9.5）：
 *     citation.verify（新鲜时跳过）→ review.run（fact/academic/style 并行）
 *     → quality.gate ─ 通过 → build.draft → Final（双 Gate 通过）
 *                   └ 失败 → revision.revise（≤ maxRounds 轮）→ 回到 citation.verify
 *                            超限 → HITL(revision_overflow: accept_draft/revise_more/cancel)
 *                            └ accept_draft → build.draft → Draft
 *     build 失败（质量问题不阻塞构建；构建失败进入修订或 HITL）
 *
 * 流程纪律全部在本文件的确定性 plan()/onInput() 中；LLM 只产出内容，
 * 其输出必须通过各 Stage 的 DoD 校验。
 */

import { readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BusinessError, WorkflowInvalidStateError } from "../errors.js";
import type { GenerationService } from "../generation/GenerationService.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { EvidenceStore, EvidenceRecord } from "../evidence/EvidenceStore.js";
import type { SourceStore } from "../sources/SourceStore.js";
import type { ManuscriptService } from "../manuscript/ManuscriptService.js";
import type { LatexCompiler } from "../latex/LatexCompiler.js";
import type { WriterService } from "../writer/WriterService.js";
import type { ResearcherService, ResearchArtifact } from "../agents/ResearcherService.js";
import { readResearchArtifact } from "../agents/ResearcherService.js";
import { readFeasibilityReport, type FeasibilityService } from "../agents/FeasibilityService.js";
import type { ReviewerService, ReviewIssue } from "../agents/ReviewerService.js";
import type { CitationService, CitationReport } from "../citation/CitationService.js";
import { extractCitationKeys } from "../citation/StaticCitationChecker.js";
import { aggregateReviews, type ReviewSummary } from "../review/ReviewAggregator.js";
import {
  evaluateQualityGate,
  runBuildGate,
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
  stageTimeoutMs: number;
  stageMaxAttempts: number;
  /** bounded loop 与 Quality Gate 阈值 */
  review: {
    maxRevisionRounds: number;
    academicPassScore: number;
    styleRiskMax: number;
  };
}

/** 目标调整 / 大纲与改进计划修订的次数上限（bounded，防无限循环烧 Token） */
const MAX_FEASIBILITY_ADJUSTMENTS = 3;
const MAX_OUTLINE_REVISIONS = 3;
const MAX_PLAN_REVISIONS = 3;
/** 手动追加修订轮数（HITL revise_more）的绝对上限 */
const MAX_MANUAL_REVISION_ROUNDS = 3;

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

      const round = countCompletions(ctx.state, "review.run") + 1;
      const reportPaths: string[] = [];
      for (const result of results) {
        reportPaths.push(await services.reviewer.saveReport(ctx.projectId, round, result));
      }
      const summary = aggregateReviews(results, round, reportPaths);
      const summaryPath = `reviews/review-summary-r${round}.json`;
      await writeJsonAtomic(
        join(services.projects.reviewsDir(ctx.projectId), `review-summary-r${round}.json`),
        summary,
      );
      return {
        round,
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
      const round = countCompletions(ctx.state, "review.run") + 1;
      try {
        await readFile(
          join(services.projects.reviewsDir(ctx.projectId), `review-summary-r${round}.json`),
          "utf8",
        );
        return [];
      } catch {
        return [`reviews/review-summary-r${round}.json 不存在`];
      }
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
      const round = countCompletions(ctx.state, "review.run");
      await saveQualityGateReport(services.projects, ctx.projectId, round, gate, review);
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
        },
        gate.passed ? "Quality Gate 通过" : `Quality Gate 未通过：${gate.reasons.length} 项阻止`,
      );
      return {
        passed: gate.passed,
        reasonCount: gate.reasons.length,
        reasons: gate.reasons.slice(0, 8),
        round,
      };
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

      // 修订指令：shared loop 用最新 review 汇总；apply 用改进计划（映射为 issue）
      const directives = await collectRevisionDirectives(services, ctx.projectId, stageId);

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
        const result = await services.writer.reviseSection({
          projectId: ctx.projectId,
          section: {
            id: target.key,
            file: target.relativePath.replaceAll("\\", "/").split("/").pop() ?? target.key,
            title: target.key,
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
      return { revisedSections: revised.length, sections: revised };
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
    description: "Build Gate：LaTeX 编译产出 PDF（质量语义不阻塞构建）",
    requiredInputs: [],
    producedOutputs: ["build/paper.pdf", "build/compile.log"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs,
    retryable: ["transient", "timeout"],
    async execute(ctx) {
      const { build, compile } = await runBuildGate(services.projects, services.latex, ctx.projectId);
      await ctx.emitDomain(
        build.passed ? "build_gate.passed" : "build_gate.failed",
        {
          reasons: build.reasons.slice(0, 5),
          tool: compile.tool,
          durationMs: compile.durationMs,
        },
        build.passed ? "Build Gate 通过（PDF 已产出）" : `Build Gate 失败：${build.reasons[0] ?? "编译失败"}`,
      );
      return {
        buildOk: build.passed,
        buildGateReasons: build.reasons.slice(0, 5),
        tool: compile.tool,
        durationMs: compile.durationMs,
        ...(compile.pdfPath !== null ? { pdfPath: "build/paper.pdf" } : {}),
        ...(compile.logPath !== null ? { logPath: "build/compile.log" } : {}),
        ...(compile.error !== undefined ? { buildError: compile.error } : {}),
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

/**
 * 共享后段：返回下一个 stage 或完成决策。
 * 前置条件：调用方保证前段已完成。
 */
function planSharedTail(state: WorkflowState, services: WorkflowServices): PlanDecision {
  const has = (id: string) => id in state.stageResults;
  const reviseIdx = lastRevisionIndex(state);
  const citationIdx = lastCompletionIndex(state, "citation.verify");
  const reviewIdx = lastCompletionIndex(state, "review.run");
  const gateIdx = lastCompletionIndex(state, "quality.gate");
  const buildIdx = lastCompletionIndex(state, "build.draft");

  // 1. 引用核验须新于最近一次修订
  if (!has("citation.verify") || citationIdx < reviseIdx) {
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

  const gatePassed = state.stageResults["quality.gate"]?.["passed"] === true;
  const overflowAnswered = "hitl.revision_overflow" in state.stageResults;
  const roundsLeft = revisionRoundsUsed(state) < revisionBudget(state, services);
  const build = state.stageResults["build.draft"] ?? {};
  const buildOk = build["buildOk"] === true;

  const completion = (label: "final" | "draft") =>
    ({
      kind: "complete",
      label,
      summary: {
        buildOk,
        buildGateReasons: build["buildGateReasons"] ?? [],
        qualityGatePassed: gatePassed,
        qualityGateReasons: state.stageResults["quality.gate"]?.["reasons"] ?? [],
        revisionRounds: revisionRoundsUsed(state),
      },
    }) satisfies PlanDecision;

  if (gatePassed) {
    if (!has("build.draft") || buildIdx < reviseIdx || buildIdx < gateIdx) {
      return { kind: "stage", stageId: "build.draft" };
    }
    if (buildOk) {
      // 双 Gate 通过 → Final（PRD §10.2）
      return completion("final");
    }
    // 构建失败：仍有修订预算 → 修（带编译错误上下文）；否则 HITL
    if (roundsLeft) {
      return { kind: "stage", stageId: "revision.revise" };
    }
    if (!overflowAnswered) {
      return { kind: "stage", stageId: "hitl.revision_overflow" };
    }
    return completion("draft"); // 用户知情接受（无 PDF 产出，buildOk=false 如实记录）
  }

  // Quality Gate 失败：质量语义不阻塞 Draft 构建，但 Final 必须通过
  if (roundsLeft) {
    return { kind: "stage", stageId: "revision.revise" };
  }
  if (!overflowAnswered) {
    return { kind: "stage", stageId: "hitl.revision_overflow" };
  }
  // accept_draft → 先构建 Draft PDF（Build Gate 通过即可）
  if (!has("build.draft") || buildIdx < reviseIdx) {
    return { kind: "stage", stageId: "build.draft" };
  }
  return completion("draft");
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
      return {
        sections: outline.sections.length,
        title: outline.title,
        references: artifact.bibliography.length,
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
      return { sectionsWritten: written.length, sections: written, bytesTotal };
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
    revisionReviseStage(services, "revision.revise"),
    revisionOverflowStage(),
    buildDraftStage(services),
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
    revisionOverflowStage(),
    buildDraftStage(services),
    qualityGateStage(services),
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

/** revision_overflow payload 内禁止访问闭包 services —— 占位（实际从 checkpoint 读） */
function ctxServices(): never {
  throw new BusinessError("INTERNAL_ERROR", "ctxServices 不应被调用");
}

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
async function latestReviewSummary(
  services: WorkflowServices,
  projectId: string,
): Promise<ReviewSummary | null> {
  const { readdir } = await import("node:fs/promises");
  try {
    const names = await readdir(services.projects.reviewsDir(projectId));
    const rounds = names
      .map((name) => /^review-summary-r(\d+)\.json$/.exec(name))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => Number(match[1]))
      .sort((a, b) => b - a);
    if (rounds.length === 0) {
      return null;
    }
    return JSON.parse(
      await readFile(
        join(services.projects.reviewsDir(projectId), `review-summary-r${rounds[0]}.json`),
        "utf8",
      ),
    ) as ReviewSummary;
  } catch {
    return null;
  }
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
  const citation = await services.citation.latestReport(projectId);
  if (citation !== null && citation.static.missingKeys.length > 0) {
    const files = await collectLatexFiles(services.projects.manuscriptDir(projectId));
    for (const key of citation.static.missingKeys) {
      const issue: ReviewIssue = {
        category: "citation",
        severity: "critical",
        section: "(unknown)",
        description: `引用 \\cite{${key}} 在 references.bib 中不存在：删除该引用，或改为只基于现有文献的表述`,
        suggestedAction: "删除或修正引用",
        blocking: true,
      };
      for (const file of files.allTex) {
        if (extractCitationKeys(file.relativePath, file.content).keys.includes(key)) {
          directives.push({
            match: (target: RevisionTarget) =>
              target.relativePath === file.relativePath ? issue : null,
          });
        }
      }
    }
  }
  return directives;
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
  // 指令引用了不在目标中的现有文件（如导入项目的自定义路径）→ 追加
  for (const file of files.allTex) {
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
