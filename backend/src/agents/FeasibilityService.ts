/**
 * Target Feasibility Assessment（M3.1，D-0011 产品红线）。
 *
 * 基于 Idea、Research 结果、Evidence 与目标定位（documentType / targetProfile /
 * targetVenue）诚实评估目标论文层级能否被支撑：
 * - 结论只用离散档位 HIGH / MEDIUM / LOW / INSUFFICIENT，禁止"83% 成功概率"式虚假精确；
 * - 无法支撑时必须回答：为什么达不到、缺什么、哪些仅靠写作无法解决、
 *   应补什么、或建议下调目标（suggestedTargetAdjustment）；
 * - 结构化输出经确定性校验后落盘 research/feasibility.json。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AgentRunFailedError } from "../errors.js";
import type { ProjectMetadata, ProjectStore } from "../project/ProjectStore.js";
import type { AgentRuntime } from "../runtime/types.js";
import type { EvidenceStats } from "../evidence/EvidenceStore.js";
import {
  extractJsonObject,
  readOptionalStringArray,
  readRequiredEnum,
  readRequiredString,
  readRequiredStringArray,
} from "./outputParsing.js";
import type { ResearchReport } from "./ResearcherService.js";

export type FeasibilityLevel = "HIGH" | "MEDIUM" | "LOW" | "INSUFFICIENT";

export const FEASIBILITY_LEVELS: readonly FeasibilityLevel[] = [
  "HIGH",
  "MEDIUM",
  "LOW",
  "INSUFFICIENT",
];

export interface FeasibilityReport {
  level: FeasibilityLevel;
  reasons: string[];
  missingRequirements: string[];
  researchGaps: string[];
  requiredExperiments: string[];
  evidenceGaps: string[];
  recommendations: string[];
  suggestedTargetAdjustment?: string;
}

export interface FeasibilityResult extends FeasibilityReport {
  reportPath: string;
  taskId: string;
}

export interface FeasibilityServiceOptions {
  runtime: AgentRuntime;
  agentId: string;
  projects: ProjectStore;
  log?: (message: string) => void;
}

export class FeasibilityService {
  private readonly runtime: AgentRuntime;
  private readonly agentId: string;
  private readonly projects: ProjectStore;
  private readonly log: (message: string) => void;

  constructor(options: FeasibilityServiceOptions) {
    this.runtime = options.runtime;
    this.agentId = options.agentId;
    this.projects = options.projects;
    this.log = options.log ?? (() => {});
  }

  /**
   * 评估目标可行性（Idea-to-Paper：调研之后；Existing-Paper：审计之后）。
   * assessKind 用于区分两类工作流的措辞与依据。
   */
  async assess(params: {
    projectId: string;
    research: ResearchReport;
    evidenceStats: EvidenceStats;
    assessKind?: "idea" | "existing_paper";
  }): Promise<FeasibilityResult> {
    const project = await this.projects.getRequired(params.projectId);
    const task = await this.runtime.runAgent({
      agentId: this.agentId,
      task: buildFeasibilityPrompt(
        project,
        params.research,
        params.evidenceStats,
        params.assessKind ?? "idea",
      ),
      projectId: params.projectId,
      contextScope: "research/feasibility",
      metadata: { role: "researcher", skill: "feasibility", milestone: "M3.1" },
    });
    if (task.status !== "completed") {
      throw new AgentRunFailedError(task.error ?? `Feasibility 任务以 ${task.status} 状态结束`);
    }
    const parsed = extractJsonObject(task.output ?? "", "可行性评估结果");
    const report: FeasibilityReport = {
      level: readRequiredEnum(parsed, "level", FEASIBILITY_LEVELS, "可行性评估结果"),
      reasons: readRequiredStringArray(parsed, "reasons", "可行性评估结果"),
      missingRequirements: readRequiredStringArray(
        parsed,
        "missingRequirements",
        "可行性评估结果",
        { minItems: 0 },
      ),
      researchGaps: readRequiredStringArray(parsed, "researchGaps", "可行性评估结果", {
        minItems: 0,
      }),
      requiredExperiments: readRequiredStringArray(
        parsed,
        "requiredExperiments",
        "可行性评估结果",
        { minItems: 0 },
      ),
      evidenceGaps: readRequiredStringArray(parsed, "evidenceGaps", "可行性评估结果", {
        minItems: 0,
      }),
      recommendations: readRequiredStringArray(parsed, "recommendations", "可行性评估结果"),
      ...(readOptionalStringArray(parsed, "suggestedTargetAdjustment") !== undefined
        ? {
            suggestedTargetAdjustment: readOptionalStringArray(
              parsed,
              "suggestedTargetAdjustment",
            )!.join("；"),
          }
        : {}),
    };
    if (report.level === "LOW" || report.level === "INSUFFICIENT") {
      // 红线：无法支撑时必须说明缺什么（PRD §8.4 必答问题）
      if (report.missingRequirements.length === 0 && report.requiredExperiments.length === 0) {
        throw new AgentRunFailedError(
          `可行性评估结果：结论为 ${report.level} 时 missingRequirements / requiredExperiments 不能同时为空（必须说明差距）`,
        );
      }
    }

    const researchDir = this.projects.researchDir(params.projectId);
    await mkdir(researchDir, { recursive: true });
    const artifact = {
      generatedAt: new Date().toISOString(),
      taskId: task.taskId,
      assessKind: params.assessKind ?? "idea",
      target: {
        documentType: project.documentType,
        targetProfile: project.targetProfile,
        targetVenue: project.targetVenue,
      },
      report,
    };
    const reportPath = join("research", "feasibility.json");
    await writeFile(
      join(researchDir, "feasibility.json"),
      JSON.stringify(artifact, null, 2) + "\n",
      "utf8",
    );
    this.log(
      `[feasibility] projectId=${params.projectId} 评估完成：level=${report.level}`,
    );
    return { ...report, reportPath, taskId: task.taskId };
  }
}

/** 读取最近一次 feasibility 报告 */
export async function readFeasibilityReport(
  projects: ProjectStore,
  projectId: string,
): Promise<{ generatedAt: string; report: FeasibilityReport; target: Record<string, unknown> } | null> {
  try {
    const raw = await readFile(
      join(projects.researchDir(projectId), "feasibility.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as {
      generatedAt: string;
      report: FeasibilityReport;
      target: Record<string, unknown>;
    };
    if (typeof parsed === "object" && parsed !== null && parsed.report?.level) {
      return parsed;
    }
    return null;
  } catch {
    return null;
  }
}

// ---- Prompt ----

export function buildFeasibilityPrompt(
  project: ProjectMetadata,
  research: ResearchReport,
  evidenceStats: EvidenceStats,
  assessKind: "idea" | "existing_paper",
): string {
  const subject =
    assessKind === "existing_paper" ? "当前论文与目标档次的差距" : "当前研究 Idea 与目标档次";
  return [
    "你是一名诚实的学术可行性评估专家。请评估：" + subject + "是否能够被现有条件支撑。",
    "",
    "核心纪律：",
    "1. 论文层级由 Novelty、Methodology、实验与 Evidence 决定，不是由写作决定。",
    "2. 只输出离散结论 level：HIGH（有望支撑）/ MEDIUM（有差距但有可行路径）/ LOW（差距显著）/ INSUFFICIENT（当前条件不足以合理声称达到）。",
    "3. 禁止输出任何百分比概率、评分等虚假精确数字。",
    "4. 结论为 LOW 或 INSUFFICIENT 时，missingRequirements 与 requiredExperiments 至少一项非空，明确说明缺什么、哪些仅靠写作无法解决。",
    "",
    "只输出一个 JSON 对象（不要 Markdown 围栏、不要解释文字），字段：",
    "{",
    '  "level": "HIGH|MEDIUM|LOW|INSUFFICIENT",',
    '  "reasons": ["判断理由"],',
    '  "missingRequirements": ["缺失的必要条件（如缺少 Baseline 对比、缺少数据集）"],',
    '  "researchGaps": ["与已有工作的差距"],',
    '  "requiredExperiments": ["需要补充的实验"],',
    '  "evidenceGaps": ["证据缺口"],',
    '  "recommendations": ["建议（先做什么后做什么）"],',
    '  "suggestedTargetAdjustment": ["建议的目标档次调整（可选，如\"下调为核心期刊\"）"]',
    "}",
    "",
    "===== 目标定位 =====",
    `目标类型：${project.documentType ?? "（未填写）"}`,
    `目标档次：${project.targetProfile ?? "（未填写）"}`,
    `目标 Venue：${project.targetVenue ?? "（未填写）"}`,
    "",
    "===== 研究概况 =====",
    `研究 Idea：${project.researchIdea ?? project.title}`,
    `领域现状：${research.domainOverview.slice(0, 600)}`,
    `研究空白：${research.researchGaps.slice(0, 5).join("；") || "（无）"}`,
    `潜在贡献：${research.potentialContributions.slice(0, 5).join("；") || "（无）"}`,
    "",
    "===== Evidence 现状 =====",
    `Evidence 总数：${evidenceStats.total}（verified=${evidenceStats.byStatus.verified}，unverified=${evidenceStats.byStatus.unverified}，contradictory=${evidenceStats.contradictory}）`,
  ].join("\n");
}
