/**
 * Target Feasibility Assessment（D-0011 产品红线）。
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
  /**
   * M10.3.1 G2（task-aware applicability，§16-§18）：existing_paper 评估必须
   * 对列出的每个 missingRequirements / requiredExperiments / researchGaps 条目
   * 给出适用性：required（返修任务真正需要满足）或 not_applicable（idea_to_paper
   * 级「从零完成全部研究阶段」标准被错误套用到返修任务；必须携带 reason）。
   * 不能为了过 Gate 自动 N/A——factual correctness / evidence support / citation /
   * newly introduced claims 的可行性 / 修订引入的 research gaps 永远 required。
   */
  criterionApplicability?: {
    criterion: string;
    applicability: "required" | "not_applicable";
    reason: string;
  }[];
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
    const prompt = buildFeasibilityPrompt(
      project,
      params.research,
      params.evidenceStats,
      params.assessKind ?? "idea",
    );
    // Record only bounded size metadata, never prompt content. This makes the
    // preflight payload auditable without leaking manuscript or source text.
    this.log(
      `[feasibility] projectId=${params.projectId} promptChars=${prompt.length} promptTokensEstimate=${estimatePromptTokens(prompt)} researchChars=${JSON.stringify(params.research).length} evidenceTotal=${params.evidenceStats.total}`,
    );
    const task = await this.runtime.runAgent({
      agentId: this.agentId,
      task: prompt,
      projectId: params.projectId,
      contextScope: "research/feasibility",
      metadata: { role: "researcher", skill: "feasibility" },
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
      ...(parseCriterionApplicability(parsed) !== null
        ? { criterionApplicability: parseCriterionApplicability(parsed)! }
        : {}),
    };
    const isExistingPaper = (params.assessKind ?? "idea") === "existing_paper";
    if (isExistingPaper) {
      // M10.3.1：existing_paper 评估必须携带逐条适用性（required / not_applicable + reason）
      const applicability = report.criterionApplicability ?? [];
      const criteria = [...report.missingRequirements, ...report.requiredExperiments, ...report.researchGaps];
      if (criteria.length > 0 && applicability.length === 0) {
        throw new AgentRunFailedError(
          "可行性评估结果：existing_paper 评估列出差距条目时必须携带 criterionApplicability（逐条 required / not_applicable + reason）",
        );
      }
      if (applicability.some((entry) => entry.applicability === "not_applicable" && entry.reason.trim() === "")) {
        throw new AgentRunFailedError(
          "可行性评估结果：criterionApplicability 的 not_applicable 条目必须携带非空 reason（不能为过 Gate 自动 N/A）",
        );
      }
    }
    if (report.level === "LOW" || report.level === "INSUFFICIENT") {
      // 红线：无法支撑时必须说明缺什么（PRD §8.4 必答问题）；
      // M10.3.1：existing_paper 口径下「缺什么」必须至少有一条是 required 适用
      // （全部 not_applicable 却给出 LOW/INSUFFICIENT 是自相矛盾，不接受）
      if (report.missingRequirements.length === 0 && report.requiredExperiments.length === 0) {
        throw new AgentRunFailedError(
          `可行性评估结果：结论为 ${report.level} 时 missingRequirements / requiredExperiments 不能同时为空（必须说明差距）`,
        );
      }
      if (isExistingPaper) {
        const applicableMissing = report.missingRequirements.filter((criterion) =>
          isRequiredCriterion(criterion, report.criterionApplicability ?? []),
        );
        const applicableExperiments = report.requiredExperiments.filter((criterion) =>
          isRequiredCriterion(criterion, report.criterionApplicability ?? []),
        );
        if (applicableMissing.length === 0 && applicableExperiments.length === 0) {
          throw new AgentRunFailedError(
            `可行性评估结果：结论为 ${report.level} 但所有差距条目均标记 not_applicable——结论与适用性自相矛盾（level 应上调或至少一条差距须为 required）`,
          );
        }
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

/** Conservative size estimate for diagnostics only; runtime context checks remain authoritative. */
function estimatePromptTokens(prompt: string): number {
  const cjk = (prompt.match(/[\u3400-\u9fff]/g) ?? []).length;
  return Math.ceil(cjk / 1.5 + (prompt.length - cjk) / 4);
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

/** criterionApplicability 数组解析（缺省 / 非法 → null，防御性） */
function parseCriterionApplicability(
  parsed: Record<string, unknown>,
): FeasibilityReport["criterionApplicability"] | null {
  const value = parsed["criterionApplicability"];
  if (!Array.isArray(value)) {
    return null;
  }
  const entries: NonNullable<FeasibilityReport["criterionApplicability"]> = [];
  for (const item of value) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    if (
      typeof record["criterion"] !== "string" ||
      (record["applicability"] !== "required" && record["applicability"] !== "not_applicable") ||
      typeof record["reason"] !== "string"
    ) {
      continue;
    }
    entries.push({
      criterion: record["criterion"],
      applicability: record["applicability"],
      reason: record["reason"],
    });
  }
  return entries.length > 0 ? entries : null;
}

/** criterion 是否按适用性清单判为 required（未覆盖 → 保守 required） */
function isRequiredCriterion(
  criterion: string,
  applicability: NonNullable<FeasibilityReport["criterionApplicability"]>,
): boolean {
  const entry = applicability.find(
    (candidate) =>
      candidate.criterion.trim() === criterion.trim() ||
      candidate.criterion.includes(criterion.slice(0, 24)) ||
      criterion.includes(candidate.criterion.slice(0, 24)),
  );
  return entry === undefined || entry.applicability === "required";
}

export function buildFeasibilityPrompt(
  project: ProjectMetadata,
  research: ResearchReport,
  evidenceStats: EvidenceStats,
  assessKind: "idea" | "existing_paper",
): string {
  const subject =
    assessKind === "existing_paper" ? "当前论文与目标档次的差距" : "当前研究 Idea 与目标档次";
  // M10.3.1 G2（§16-§18）：existing_paper 的 task-aware 适用性纪律
  const taskAware =
    assessKind === "existing_paper"
      ? [
          "",
          "===== 任务语境（task-aware applicability，必须遵守）=====",
          "本次评估对象是**已有论文的修订任务（existing paper revision）**：目标是在已有论文和现有实验基础上可靠地完成修订，不是从零重做全部研究。判定差距时按以下适用性口径：",
          "- 永远 required（不能 N/A）：修订内容的 factual correctness；修订引入论断的 evidence support；引用完整性；修订新增 claim 的可行性；修订引入 / 触及的 unresolved research gaps。",
          "- 默认 not_applicable（除非修订本身声称完成它们）：要求原论文补齐从零写作级的完整研究阶段——如重跑全部基线对比、完整数据集训练、板端部署完成、多种子方差检验、SOTA 基线实测等。这类条目属于原论文既有实验体系的完备性问题，由作者在新投稿语境裁决，不由返修任务承担。",
          "- level 结论必须与适用性一致：若全部列出的差距均为 not_applicable，level 不得为 LOW/INSUFFICIENT（那属于错误套用从零写作标准）。",
          "- 列出的每个 missingRequirements / requiredExperiments / researchGaps 条目都必须在 criterionApplicability 中逐条登记（criterion 与条目前 24 字对齐即可），not_applicable 必须携带非空 reason，不允许为过 Gate 自动 N/A。",
        ]
      : [];
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

    ...(assessKind === "existing_paper"
      ? [
          ',  "criterionApplicability": [',
          '    {"criterion": "与 missingRequirements/requiredExperiments/researchGaps 条目对齐", "applicability": "required|not_applicable", "reason": "为什么该标准适用于（或不适用于）本次返修任务"}',
          "  ]",
        ]
      : []),    "}",
    ...taskAware,
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
