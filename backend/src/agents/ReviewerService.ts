/**
 * Reviewer 业务角色（M3.2，PRD §7.4）。
 *
 * 一个 Agent，三类 review skill（fact / academic / style），可并行 fan-out：
 *   - fact：正文 claim ↔ Evidence 核验（SUPPORTED / PARTIALLY_SUPPORTED /
 *     UNSUPPORTED / CONTRADICTED）
 *   - academic：学术质量评分（各维度 0-100）
 *   - style：AI 文风风险（0-100）
 *
 * 每个 mode 使用独立 contextScope（review/fact、review/academic、review/style），
 * 会话互不污染；输出为统一结构的 ReviewIssue，经确定性校验后落盘 reviews/。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AgentRunFailedError } from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { AgentRuntime } from "../runtime/types.js";
import type { EvidenceRecord } from "../evidence/EvidenceStore.js";
import {
  extractJsonObject,
  readRequiredEnum,
  readRequiredString,
} from "./outputParsing.js";

export type ReviewMode = "fact" | "academic" | "style";

export const REVIEW_MODES: readonly ReviewMode[] = ["fact", "academic", "style"];

export type IssueSeverity = "critical" | "major" | "minor";
export type IssueCategory = "fact" | "academic" | "style" | "citation" | "evidence_gap" | "build";
export type FactVerdict = "SUPPORTED" | "PARTIALLY_SUPPORTED" | "UNSUPPORTED" | "CONTRADICTED";

export interface ReviewIssue {
  category: IssueCategory;
  severity: IssueSeverity;
  section: string;
  description: string;
  evidenceRef?: string;
  suggestedAction?: string;
  blocking: boolean;
}

export interface FactClaimCheck {
  section: string;
  claim: string;
  verdict: FactVerdict;
  evidenceId?: string;
  note?: string;
}

export interface ModeReviewResult {
  mode: ReviewMode;
  taskId: string;
  /** fact 模式：逐 claim 核验 */
  claims?: FactClaimCheck[];
  /** academic 模式：维度评分 */
  scores?: Record<string, number>;
  overallScore?: number;
  /** style 模式：AI 文风风险 0-100 */
  riskScore?: number;
  issues: ReviewIssue[];
  summary: string;
}

export interface ReviewerServiceOptions {
  runtime: AgentRuntime;
  agentId: string;
  projects: ProjectStore;
  log?: (message: string) => void;
}

const SEVERITIES: readonly IssueSeverity[] = ["critical", "major", "minor"];
const CATEGORIES: readonly IssueCategory[] = [
  "fact",
  "academic",
  "style",
  "citation",
  "evidence_gap",
  "build",
];
const VERDICTS: readonly FactVerdict[] = [
  "SUPPORTED",
  "PARTIALLY_SUPPORTED",
  "UNSUPPORTED",
  "CONTRADICTED",
];

export class ReviewerService {
  private readonly runtime: AgentRuntime;
  private readonly agentId: string;
  private readonly projects: ProjectStore;
  private readonly log: (message: string) => void;

  constructor(options: ReviewerServiceOptions) {
    this.runtime = options.runtime;
    this.agentId = options.agentId;
    this.projects = options.projects;
    this.log = options.log ?? (() => {});
  }

  /** 并行 fan-out 三类 review skill（Promise.all；各 mode 独立会话） */
  async reviewAll(params: {
    projectId: string;
    manuscriptDigest: string;
    evidence: EvidenceRecord[];
    targetProfile?: string;
    citationDigest?: string;
  }): Promise<ModeReviewResult[]> {
    const results = await Promise.all(
      REVIEW_MODES.map((mode) => this.reviewMode({ ...params, mode })),
    );
    this.log(
      `[reviewer] projectId=${params.projectId} 三路 review 完成：issues=${results.reduce(
        (sum, result) => sum + result.issues.length,
        0,
      )}`,
    );
    return results;
  }

  /** 单个 review mode（独立 contextScope，会话隔离） */
  async reviewMode(params: {
    projectId: string;
    mode: ReviewMode;
    manuscriptDigest: string;
    evidence: EvidenceRecord[];
    targetProfile?: string;
    citationDigest?: string;
  }): Promise<ModeReviewResult> {
    const task = await this.runtime.runAgent({
      agentId: this.agentId,
      task: buildReviewPrompt(params),
      projectId: params.projectId,
      contextScope: `review/${params.mode}`,
      metadata: { role: "reviewer", skill: params.mode, milestone: "M3.2" },
    });
    if (task.status !== "completed") {
      throw new AgentRunFailedError(
        task.error ?? `Review（${params.mode}）任务以 ${task.status} 状态结束`,
      );
    }
    const parsed = extractJsonObject(task.output ?? "", `Review（${params.mode}）结果`);
    const result = parseModeReview(params.mode, parsed);
    this.log(
      `[reviewer] projectId=${params.projectId} mode=${params.mode} issues=${result.issues.length}`,
    );
    return result;
  }

  /** 落盘单个 mode 的报告（reviews/review-<round>-<mode>.json） */
  async saveReport(projectId: string, round: number, result: ModeReviewResult): Promise<string> {
    const dir = this.projects.reviewsDir(projectId);
    await mkdir(dir, { recursive: true });
    const file = `review-r${round}-${result.mode}.json`;
    await writeFile(
      join(dir, file),
      JSON.stringify({ generatedAt: new Date().toISOString(), ...result }, null, 2) + "\n",
      "utf8",
    );
    return `reviews/${file}`;
  }
}

/** 解析并校验单个 mode 的结构化输出 */
export function parseModeReview(
  mode: ReviewMode,
  parsed: Record<string, unknown>,
): ModeReviewResult {
  const context = `Review（${mode}）结果`;
  const issues = parseIssues(parsed, context);
  const base: ModeReviewResult = {
    mode,
    taskId: "",
    issues,
    summary: readRequiredString(parsed, "summary", context),
  };
  if (mode === "fact") {
    const claims = parseClaims(parsed, context);
    return { ...base, claims };
  }
  if (mode === "academic") {
    const scores: Record<string, number> = {};
    const rawScores = parsed["scores"];
    if (typeof rawScores === "object" && rawScores !== null) {
      for (const [dimension, value] of Object.entries(rawScores as Record<string, unknown>)) {
        if (typeof value === "number" && value >= 0 && value <= 100) {
          scores[dimension] = Math.round(value);
        }
      }
    }
    if (Object.keys(scores).length === 0) {
      throw new AgentRunFailedError(`${context}：缺少合法的 scores（各维度 0-100）`);
    }
    const overall =
      typeof parsed["overallScore"] === "number" && parsed["overallScore"] >= 0 && parsed["overallScore"] <= 100
        ? Math.round(parsed["overallScore"])
        : Math.round(Object.values(scores).reduce((a, b) => a + b, 0) / Object.values(scores).length);
    return { ...base, scores, overallScore: overall };
  }
  // style
  const risk = parsed["riskScore"];
  if (typeof risk !== "number" || risk < 0 || risk > 100) {
    throw new AgentRunFailedError(`${context}：缺少合法的 riskScore（0-100）`);
  }
  return { ...base, riskScore: Math.round(risk) };
}

function parseIssues(parsed: Record<string, unknown>, context: string): ReviewIssue[] {
  const raw = parsed["issues"];
  if (!Array.isArray(raw)) {
    throw new AgentRunFailedError(`${context}：缺少 issues 数组`);
  }
  const issues: ReviewIssue[] = [];
  for (const item of raw.slice(0, 100)) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const description =
      typeof record["description"] === "string" ? record["description"].trim() : "";
    if (description === "") {
      continue;
    }
    issues.push({
      category: readRequiredEnum(record, "category", CATEGORIES, context),
      severity: readRequiredEnum(record, "severity", SEVERITIES, context),
      section: typeof record["section"] === "string" && record["section"].trim() !== ""
        ? record["section"].trim()
        : "(unknown)",
      description,
      ...(typeof record["evidenceRef"] === "string" && record["evidenceRef"].trim() !== ""
        ? { evidenceRef: record["evidenceRef"].trim() }
        : {}),
      ...(typeof record["suggestedAction"] === "string" && record["suggestedAction"].trim() !== ""
        ? { suggestedAction: record["suggestedAction"].trim() }
        : {}),
      blocking: record["blocking"] === true,
    });
  }
  return issues;
}

function parseClaims(parsed: Record<string, unknown>, context: string): FactClaimCheck[] {
  const raw = parsed["claims"];
  if (!Array.isArray(raw)) {
    return [];
  }
  const claims: FactClaimCheck[] = [];
  for (const item of raw.slice(0, 100)) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const record = item as Record<string, unknown>;
    const claim = typeof record["claim"] === "string" ? record["claim"].trim() : "";
    if (claim === "") {
      continue;
    }
    claims.push({
      section: typeof record["section"] === "string" ? record["section"].trim() : "(unknown)",
      claim,
      verdict: readRequiredEnum(record, "verdict", VERDICTS, context),
      ...(typeof record["evidenceId"] === "string" && record["evidenceId"].trim() !== ""
        ? { evidenceId: record["evidenceId"].trim() }
        : {}),
      ...(typeof record["note"] === "string" ? { note: record["note"].trim() } : {}),
    });
  }
  return claims;
}

// ---- Prompt ----

export function buildReviewPrompt(params: {
  projectId: string;
  mode: ReviewMode;
  manuscriptDigest: string;
  evidence: EvidenceRecord[];
  targetProfile?: string;
  citationDigest?: string;
}): string {
  const evidenceLines = params.evidence
    .slice(0, 20)
    .map((record) => `- [${record.id}] ${record.claim.slice(0, 140)}（${record.verificationStatus}${record.supportStrength ? `/${record.supportStrength}` : ""}）`);

  const modeSpecs: Record<ReviewMode, string[]> = {
    fact: [
      "你使用 fact checking skill：把正文拆分为 factual claims，逐条对照 Evidence 判定：",
      "SUPPORTED / PARTIALLY_SUPPORTED / UNSUPPORTED / CONTRADICTED。",
      "输出额外字段 claims: [{section, claim, verdict, evidenceId?, note?}]；",
      "无证据支撑的关键论断必须是 UNSUPPORTED 并生成 critical/major issue（blocking 视严重度）。",
    ],
    academic: [
      "你使用 academic review skill：从问题定义、方法合理性、实验充分性、论证逻辑、写作质量评审。",
      `结合目标档次标准执行（目标档次：${params.targetProfile ?? "未指定"}）。`,
      "输出额外字段 scores: {问题定义: 0-100, 方法合理性: 0-100, 实验充分性: 0-100, 论证逻辑: 0-100, 写作质量: 0-100} 与 overallScore。",
    ],
    style: [
      "你使用 style review skill：检查模板化表达、连接词滥用、重复句式、段落结构机械化、空洞评价、信息密度、无证据评价词。",
      "输出额外字段 riskScore: 0-100（AI 文风风险，越高越像模板生成）。",
    ],
  };

  return [
    `你是一名论文审稿人（Reviewer）。请对下面的论文稿件执行 ${params.mode} 审查。`,
    "",
    ...modeSpecs[params.mode],
    "",
    "只输出一个 JSON 对象（不要 Markdown 围栏），公共字段：",
    "{",
    '  "summary": "总体评价（100 字内）",',
    '  "issues": [{"category": "fact|academic|style|citation|evidence_gap|build",',
    '    "severity": "critical|major|minor", "section": "sections/xxx.tex 或章节名",',
    '    "description": "问题描述", "evidenceRef": "E001（如有）",',
    '    "suggestedAction": "修改建议", "blocking": false}]',
    "}",
    "纪律：不虚构问题；问题描述必须可定位；确属阻断级（如关键论断无证据、引用不存在）才设 blocking=true。",
    "",
    "===== 论文稿件（结构化摘要）=====",
    params.manuscriptDigest,
    "",
    "===== 可用 Evidence =====",
    ...(evidenceLines.length > 0 ? evidenceLines : ["（无 Evidence：正文中所有强论断都应标记 UNSUPPORTED）"]),
    ...(params.citationDigest
      ? ["", "===== 引用核验摘要 =====", params.citationDigest]
      : []),
  ].join("\n");
}
