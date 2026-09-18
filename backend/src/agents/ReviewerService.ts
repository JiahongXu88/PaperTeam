/**
 * Reviewer 业务角色（PRD §7.4）。
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
  /** 为什么是问题（M5.4：style / academic finding 的依据；可执行性要素之一） */
  reason?: string;
}

/**
 * PaperTeam 不做 AI detector：Reviewer 输出中任何「AI 概率 / 人类概率 / 检测器
 * 分数」字段一律丢弃，不解析、不落盘、不展示（riskScore 是模板化 / 机械化表达
 * 风险的工程口径，不是生成来源判断）。
 */
export const FORBIDDEN_DETECTOR_FIELDS: readonly string[] = [
  "aiProbability",
  "ai_probability",
  "aiGeneratedProbability",
  "humanProbability",
  "human_probability",
  "detectorScore",
  "detector_score",
  "aiScore",
  "aiLikelihood",
];

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
  /** 逐 run 执行超时覆盖（毫秒；长论文阶段口径，见 config.pi.longRunTimeoutMs）；缺省沿用 Runtime 默认 */
  runTimeoutMs?: number;
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
  private readonly timeoutOverride: { timeoutMs: number } | Record<string, never>;

  constructor(options: ReviewerServiceOptions) {
    this.runtime = options.runtime;
    this.agentId = options.agentId;
    this.projects = options.projects;
    this.log = options.log ?? (() => {});
    this.timeoutOverride = options.runTimeoutMs !== undefined ? { timeoutMs: options.runTimeoutMs } : {};
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
      ...this.timeoutOverride,
      task: buildReviewPrompt(params),
      projectId: params.projectId,
      contextScope: `review/${params.mode}`,
      metadata: { role: "reviewer", skill: params.mode },
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

/**
 * fact verdict 的近似值归一（M5.6 真实验收：模型两次输出 "CONTRADICTION" 而非 CONTRADICTED，
 * 整条 review.run 因此结构化失败）。只承认大小写 / 分隔符差异与少数同义写法，语义不放宽：
 * 其余值仍按 readRequiredEnum 严格拒绝。
 */
const VERDICT_ALIASES: Readonly<Record<string, FactVerdict>> = {
  CONTRADICTION: "CONTRADICTED",
  CONTRADICTORY: "CONTRADICTED",
  CONTRADICTS: "CONTRADICTED",
  PARTIAL: "PARTIALLY_SUPPORTED",
  PARTIALLY: "PARTIALLY_SUPPORTED",
  PARTIAL_SUPPORT: "PARTIALLY_SUPPORTED",
  PARTIALLY_SUPPORT: "PARTIALLY_SUPPORTED",
  SUPPORT: "SUPPORTED",
  NOT_SUPPORTED: "UNSUPPORTED",
  UNSUPPORT: "UNSUPPORTED",
};

export function normalizeFactVerdict(value: unknown): FactVerdict | null {
  if (typeof value !== "string") {
    return null;
  }
  const canonical = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if ((VERDICTS as readonly string[]).includes(canonical)) {
    return canonical as FactVerdict;
  }
  return VERDICT_ALIASES[canonical] ?? null;
}

function readFactVerdict(record: Record<string, unknown>, context: string): FactVerdict {
  const normalized = normalizeFactVerdict(record["verdict"]);
  if (normalized !== null) {
    return normalized;
  }
  return readRequiredEnum(record, "verdict", VERDICTS, context); // 抛出统一的结构化错误
}

/**
 * summary 是展示性自由文本（不参与任何 Gate 判定）。真实运行（2026-09-16 A10/B8，
 * glm-5.3 两臂、不同 lens）出现模型省略 summary 导致整轮 review 失败——与 A7 的
 * verdict 近似值同类的「模型输出契约漂移」。处置同先例：展示性字段做确定性兜底
 * （从 issues 计数派生），语义字段（verdict / scores / riskScore / issues）保持严格。
 */
function readSummaryOrFallback(parsed: Record<string, unknown>, issues: ReviewIssue[]): string {
  const value = parsed["summary"];
  if (typeof value === "string" && value.trim() !== "") {
    return value.trim();
  }
  const counts = issues.reduce(
    (acc, issue) => {
      acc[issue.severity] = (acc[issue.severity] ?? 0) + 1;
      return acc;
    },
    {} as Record<string, number>,
  );
  const parts = ["critical", "major", "minor"].map((severity) => `${counts[severity] ?? 0} ${severity}`);
  return `（模型未提供总体评价；确定性兜底）审阅完成：${issues.length} 项 finding（${parts.join(" / ")}）`;
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
    summary: readSummaryOrFallback(parsed, issues),
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
  // style（AI 概率类字段不进入结果：parseModeReview 只挑选已知字段，
  // FORBIDDEN_DETECTOR_FIELDS 列出的键即使出现也被丢弃）
  const risk = parsed["riskScore"];
  if (typeof risk !== "number" || risk < 0 || risk > 100) {
    throw new AgentRunFailedError(`${context}：缺少合法的 riskScore（0-100）`);
  }
  return { ...base, riskScore: Math.round(risk) };
}

/** 输出中是否出现了被禁止的检测器字段（诊断 / 测试用；解析结果本身不会携带它们） */
export function containsForbiddenDetectorFields(parsed: Record<string, unknown>): string[] {
  return FORBIDDEN_DETECTOR_FIELDS.filter((field) => field in parsed);
}

function parseIssues(parsed: Record<string, unknown>, context: string): ReviewIssue[] {
  const raw = parsed["issues"];
  if (raw === undefined || raw === null) {
    // 真实模型偶发省略 issues 字段（如学术维度给了评分但无逐条发现）——
    // 按「无发现」处理，不作废整轮昂贵审稿；字段存在但不是数组仍是结构
    // 错误（拒绝，不猜）。2026-09-10 真实 Improvement smoke 曾因此 2/2 失败。
    return [];
  }
  if (!Array.isArray(raw)) {
    throw new AgentRunFailedError(`${context}：issues 不是数组`);
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
        : typeof record["proposedAction"] === "string" && record["proposedAction"].trim() !== ""
          ? { suggestedAction: record["proposedAction"].trim() }
          : {}),
      ...(typeof record["reason"] === "string" && record["reason"].trim() !== ""
        ? { reason: record["reason"].trim() }
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
      verdict: readFactVerdict(record, context),
      ...(typeof record["evidenceId"] === "string" && record["evidenceId"].trim() !== ""
        ? { evidenceId: record["evidenceId"].trim() }
        : {}),
      ...(typeof record["note"] === "string" ? { note: record["note"].trim() } : {}),
    });
  }
  return claims;
}

// ---- Prompt ----

/**
 * M6.6 Evidence 消费模式（§M6.6-7）：Reviewer 的 fact 判定从「依赖 workflow
 * 塞入的静态 digest」升级为「主动查询」——digest 仍作为初始上下文（兼容），
 * 但逐 claim 核验时 Reviewer 应通过 evidence_query 查询证据库（§M6.6-10：
 * 只有 verified 且带 chunk 锚点的记录可作为 SUPPORTED 依据），必要时用
 * get_chunk 回查原文。
 */
const FACT_EVIDENCE_TOOL_GUIDANCE = [
  "证据核验工具（evidence_query / get_chunk）：上方 Evidence 只是初始快照；",
  "逐条 claim 判定时应先用 evidence_query 按 claim 关键词（claimContains）或 sourceId 查询证据库，",
  "只有 verificationStatus=verified（已核验）的证据才能作为 SUPPORTED / PARTIALLY_SUPPORTED 的依据；",
  "需要核对原文时用行内 chunk 锚点调用 get_chunk 回取逐字原文；",
  "unverified 记录只是待核验线索，不得据此给出 SUPPORTED。",
].join("");

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
    .map(
      (record) =>
        `- [${record.id}] ${record.claim.slice(0, 140)}（${record.verificationStatus}${record.supportStrength ? `/${record.supportStrength}` : ""}${record.location?.chunk ? `；chunk: ${record.location.chunk.slice(0, 60)}` : ""}）`,
    );

  const modeSpecs: Record<ReviewMode, string[]> = {
    fact: [
      "你使用 fact checking skill：把正文拆分为 factual claims，逐条对照 Evidence 判定：",
      "SUPPORTED / PARTIALLY_SUPPORTED / UNSUPPORTED / CONTRADICTED。",
      FACT_EVIDENCE_TOOL_GUIDANCE,
      "输出额外字段 claims: [{section, claim, verdict, evidenceId?, note?}]；",
      "无已核验（verified）证据支撑的关键论断必须是 UNSUPPORTED 并生成 critical/major issue（blocking 视严重度）。",
    ],
    academic: [
      "你使用 academic review skill：从问题定义、方法合理性、实验充分性、论证逻辑、写作质量评审。",
      `结合目标档次标准执行（目标档次：${params.targetProfile ?? "未指定"}）。`,
      "输出额外字段 scores: {问题定义: 0-100, 方法合理性: 0-100, 实验充分性: 0-100, 论证逻辑: 0-100, 写作质量: 0-100} 与 overallScore。",
    ],
    style: [
      "你使用 style review skill（中文学术表达质量，不是 AI 检测）：检查空泛总结、重复表达、机械排比、过度模板化、模糊归因、夸大意义、宣传式措辞、翻译腔 / 不自然表达、段落节奏过度一致、冗余过渡、术语漂移。",
      "每条 issue 必须同时给出：section（位置）、description（问题，引用原句片段 ≤ 60 字）、reason（为什么是问题：与前后句逻辑不符 / 评价词无数字支撑 / 同段第 N 次重复 等）、suggestedAction（具体到句的改法或删除）、severity（表达问题通常 minor；只有造成理解歧义才 major）。",
      "「此外 / 然而 / 因此 / 同时」在学术写作中是正常用法：不得仅因出现就报告；只有逻辑关系不符或同段连续多句机械开头才算冗余过渡。正常的中文学术段落应当零或极少 issue。",
      "禁止输出 AI 概率 / 人类概率 / 检测器分数等字段；不评价作者，不做整体印象式泛评。",
      "输出额外字段 riskScore: 0-100（模板化 / 机械化表达风险的工程口径，越高表示模板化越重；不是生成来源判断）。",
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
    '    "severity": "critical|major|minor", "section": "sections/xxx.tex、abstract（摘要问题归这里）或章节名",',
    '    "description": "问题描述", "evidenceRef": "E001（如有）",',
    '    "suggestedAction": "修改建议", "blocking": false}]',
    "}",
    "纪律：不虚构问题；问题描述必须可定位；确属阻断级（如关键论断无证据、引用不存在）才设 blocking=true。",
    "",
    "===== 论文稿件（结构化摘要）=====",
    params.manuscriptDigest,
    "",
    "===== 可用 Evidence（初始快照；正式证据 = verified）=====",
    ...(evidenceLines.length > 0
      ? [
          ...evidenceLines,
          ...(params.mode === "fact" ? [`（${FACT_EVIDENCE_TOOL_GUIDANCE}）`] : []),
        ]
      : params.mode === "fact"
        ? ["（无已核验（verified）Evidence：正文中所有强论断都应标记 UNSUPPORTED，可用 evidence_query 查询证据库确认后）"]
        : ["（无已核验（verified）Evidence）"]),
    ...(params.citationDigest
      ? ["", "===== 引用核验摘要 =====", params.citationDigest]
      : []),
  ].join("\n");
}
