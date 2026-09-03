/**
 * Idea-to-Paper Workflow 定义（M3.1）。
 *
 * 流程（PRD §9.2，产品红线：不要一上来就让 Writer 写论文）：
 *
 *   research.idea → research.feasibility → HITL(feasibility confirm)
 *     ├─ adjust：更新 targetProfile/Venue → 重评估（≤3 次）
 *     └─ approve ↓
 *   outline.plan → HITL(outline confirm)
 *     ├─ revise：带反馈重规划（≤3 次）
 *     └─ approve ↓
 *   writing.sections（逐节，progress 事件）→ citation.verify → build.draft → complete(draft)
 *
 * 红线落实（D-0011）：可行性结论在 HITL payload 中如实呈现；
 * adjust 只是更新目标并重评估，不伪造"可达"。
 * M3.2 将在 writing 与 build 之间插入 Review → Quality Gate → bounded revision。
 */

import { BusinessError, WorkflowInvalidStateError } from "../errors.js";
import type { GenerationService } from "../generation/GenerationService.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { EvidenceStore, EvidenceRecord } from "../evidence/EvidenceStore.js";
import type { SourceStore } from "../sources/SourceStore.js";
import type { ManuscriptService } from "../manuscript/ManuscriptService.js";
import type { LatexCompiler } from "../latex/LatexCompiler.js";
import type { WriterService } from "../writer/WriterService.js";
import type { ResearcherService, ResearchArtifact } from "../agents/ResearcherService.js";
import type { FeasibilityService } from "../agents/FeasibilityService.js";
import { readResearchArtifact } from "../agents/ResearcherService.js";
import type { CitationService } from "../citation/CitationService.js";
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
  evidence: EvidenceStore;
  sources: SourceStore;
  manuscript: ManuscriptService;
  writer: WriterService;
  citation: CitationService;
  latex: LatexCompiler;
  stageTimeoutMs: number;
  stageMaxAttempts: number;
}

/** 目标调整 / 大纲修订的次数上限（bounded，防无限循环烧 Token） */
const MAX_FEASIBILITY_ADJUSTMENTS = 3;
const MAX_OUTLINE_REVISIONS = 3;

// ---- Stage 构造 ----

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

function feasibilityStage(services: WorkflowServices): StageSpec {
  return {
    id: "research.feasibility",
    description: "Target Feasibility Assessment（HIGH/MEDIUM/LOW/INSUFFICIENT）",
    requiredInputs: ["research.idea"],
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
      });
      return {
        level: result.level,
        reportPath: result.reportPath,
        missingRequirements: result.missingRequirements.length,
        requiredExperiments: result.requiredExperiments.length,
      };
    },
    async verifyDod(ctx) {
      const violations: string[] = [];
      const { readFeasibilityReport } = await import("../agents/FeasibilityService.js");
      const report = await readFeasibilityReport(services.projects, ctx.projectId);
      if (report === null) {
        violations.push("research/feasibility.json 不存在或不可解析");
      } else if (!["HIGH", "MEDIUM", "LOW", "INSUFFICIENT"].includes(report.report.level)) {
        violations.push(`feasibility level 非法：${report.report.level}`);
      }
      return violations;
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
        const { readFeasibilityReport } = await import("../agents/FeasibilityService.js");
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
      return { sections: outline.sections.length, title: outline.title, references: artifact.bibliography.length };
    },
    async verifyDod(ctx) {
      const violations: string[] = [];
      const outline = await services.manuscript.loadOutline(ctx.projectId);
      if (outline === null) {
        violations.push("manuscript/outline.json 不存在");
        return violations;
      }
      const { readFile } = await import("node:fs/promises");
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
            ...(section.targetLengthWords !== undefined
              ? { targetLengthWords: section.targetLengthWords }
              : {}),
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
    timeoutMs: services.stageTimeoutMs * 4, // 多节串行，预算放宽
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
      // 记录 Evidence 使用关系（usedBy：本 run）
      for (const record of evidence) {
        await safeMarkUsage(services, ctx.projectId, record.id, ctx.runId);
      }
      await services.manuscript.writeMainTex(ctx.projectId, outline, artifact.bibliography.length > 0);
      // Derived Context 随写作完成重建（可随时由事实来源重建）
      const evidenceStats = await services.evidence.stats(ctx.projectId);
      await services.manuscript.rebuildContext(ctx.projectId, { evidenceStats });
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

function citationVerifyStage(services: WorkflowServices): StageSpec {
  return {
    id: "citation.verify",
    description: "Citation 核验（静态一致性 + 公开元数据比对）",
    requiredInputs: ["writing.sections"],
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

function buildDraftStage(services: WorkflowServices): StageSpec {
  return {
    id: "build.draft",
    description: "Build Gate：LaTeX 编译产出 Draft PDF（质量语义不阻塞构建）",
    requiredInputs: ["citation.verify"],
    producedOutputs: ["build/paper.pdf", "build/compile.log"],
    maxAttempts: services.stageMaxAttempts,
    timeoutMs: services.stageTimeoutMs,
    retryable: ["transient", "timeout"],
    async execute(ctx) {
      // 编译失败记录为结果（不抛出）：Draft 构建状态如实进入完成摘要
      try {
        const compile = await services.latex.compile({
          manuscriptDir: services.projects.manuscriptDir(ctx.projectId),
          buildDir: services.projects.buildDir(ctx.projectId),
        });
        return {
          buildOk: true,
          tool: compile.tool,
          durationMs: compile.durationMs,
          pdfPath: "build/paper.pdf",
          logPath: "build/compile.log",
        };
      } catch (error) {
        const businessError =
          error instanceof BusinessError
            ? error
            : new BusinessError("INTERNAL_ERROR", String(error));
        return { buildOk: false, buildErrorCode: businessError.code, buildError: businessError.message };
      }
    },
  };
}

// ---- 定义组装 ----

export function createIdeaToPaperDefinition(services: WorkflowServices): WorkflowDefinition {
  const stages: readonly StageSpec[] = [
    researchIdeaStage(services),
    feasibilityStage(services),
    feasibilityConfirmStage(services),
    outlinePlanStage(services),
    outlineConfirmStage(services),
    writingSectionsStage(services),
    citationVerifyStage(services),
    buildDraftStage(services),
  ];

  const ordered = [
    "research.idea",
    "research.feasibility",
    "hitl.feasibility_confirm",
    "outline.plan",
    "hitl.outline_confirm",
    "writing.sections",
    "citation.verify",
    "build.draft",
  ];

  return {
    kind: "idea_to_paper",
    description: "Idea-to-Paper：调研 → 可行性 → 确认 → 大纲 → 确认 → 分节写作 → 引用核验 → Draft 构建",
    stages,
    plan(state: WorkflowState): PlanDecision {
      for (const stageId of ordered) {
        if (!(stageId in state.stageResults)) {
          return { kind: "stage", stageId };
        }
      }
      const buildResult = state.stageResults["build.draft"] ?? {};
      return {
        kind: "complete",
        // M3.1 无 Quality Gate：一律 Draft（M3.2 起 Final 需双 Gate 通过）
        label: "draft",
        summary: {
          buildOk: buildResult["buildOk"] ?? false,
          citation: state.stageResults["citation.verify"] ?? {},
          sections: state.stageResults["writing.sections"]?.["sectionsWritten"] ?? 0,
        },
      };
    },
    async onInput(state, stageId, input): Promise<void | "cancel"> {
      switch (stageId) {
        case "hitl.feasibility_confirm":
          return applyFeasibilityDecision(services, state, input);
        case "hitl.outline_confirm":
          return applyOutlineDecision(services, state, input);
        default:
          throw new WorkflowInvalidStateError(state.runId, state.status, `未知的待办节点 ${stageId}`);
      }
    },
  };
}

// ---- HITL 决策 ----

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
    const adjustments = countCompletions(state, "research.feasibility");
    if (adjustments >= MAX_FEASIBILITY_ADJUSTMENTS) {
      throw new WorkflowInvalidStateError(
        state.runId,
        state.status,
        `目标调整次数已达上限（${MAX_FEASIBILITY_ADJUSTMENTS} 次），请 approve 或 cancel`,
      );
    }
    // 更新目标 → 重评估（删除 feasibility 结果，planner 重跑）
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

async function applyOutlineDecision(
  services: WorkflowServices,
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
    // 反馈保存在 inputs（outline.plan 会读取 hitl.outline_confirm 的 payload）
    dropStageResult(state, "outline.plan");
    return;
  }
  throw new WorkflowInvalidStateError(
    state.runId,
    state.status,
    `decision 只能是 approve / revise / cancel（当前 "${input.decision}"）`,
  );
}

// ---- 辅助 ----

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

/** 可用于写作的 Evidence（verified / plausible 优先，unverified 兜底，限量） */
async function usableEvidence(services: WorkflowServices, projectId: string): Promise<EvidenceRecord[]> {
  const records = await services.evidence.list(projectId);
  const trusted = records.filter(
    (record) => record.verificationStatus === "verified" || record.verificationStatus === "plausible",
  );
  const pool = trusted.length >= 3 ? trusted : [...trusted, ...records.filter((r) => r.verificationStatus === "unverified")];
  return pool
    .sort((a, b) => (b.supportStrength === "direct" ? 1 : 0) - (a.supportStrength === "direct" ? 1 : 0))
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

function readFeedback(payload: Record<string, unknown> | undefined): string | undefined {
  const value = payload?.["feedback"];
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, 4000) : undefined;
}

function readPayloadString(payload: Record<string, unknown>, field: string): string | undefined {
  const value = payload[field];
  return typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, 300) : undefined;
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
