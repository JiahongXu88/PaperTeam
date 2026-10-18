/**
 * M14.9.1 阶段 B4：Academic Review 输入中立性 A/B 实验 Harness（shadow scoring comparator）。
 *
 * - 评分逻辑 = 生产 ReviewerService.reviewMode({mode:"academic"})：同一 buildReviewPrompt 五维 rubric、
 *   同一结构化解析与有界修复；不另造评分标准。生产长文档走 43 单元模式，本 Harness 是**整稿单次
 *   评分**的影子比较器——结论只说明「同一 Reviewer 业务逻辑对不同稿件表示是否敏感」，不等于生产
 *   Quality Gate 经过 A/B 证实。
 * - 每次调用使用独立 projectId（= 全新 Runtime 会话）；臂顺序按固定种子在每一轮重复内随机化；
 *   prompt 中没有臂标签、没有 80 分门槛、没有历史分数。
 * - 所有请求经任务级 GlobalBudgetLedger 在**调用前**预留（prompt 预估 + 输出上界），超限拒绝启动。
 */

import { createHash } from "node:crypto";

import type { ReviewIssue, ModeReviewResult } from "../agents/ReviewerService.js";
import { buildReviewPrompt } from "../agents/ReviewerService.js";
import { estimatePromptTokens } from "../runtime/globalBudgetLedger.js";

export type NeutralityArm = "raw" | "naive_text" | "structured_blind_md" | "format_only_md" | "identity_swap";

export interface NeutralityArmInput {
  familyId: string;
  arm: NeutralityArm;
  language: "zh" | "en";
  text: string;
  /** 等价门结论；INVALID_INPUT 的臂不得进入评分 */
  equivalence: "VALID" | "INVALID_INPUT";
  conversionLoss: boolean;
  /** 1 = 必须；2 = 次要；3 = 反例 / 扰动（预算不足时最先放弃） */
  tier: 1 | 2 | 3;
}

export interface PlannedCall {
  callId: string;
  familyId: string;
  arm: NeutralityArm;
  rep: number;
  order: number;
  tier: number;
  promptSha256: string;
  promptChars: number;
  estimatedPromptTokens: number;
  reservedTokens: number;
}

export interface NeutralityCallResult {
  callId: string;
  familyId: string;
  arm: NeutralityArm;
  rep: number;
  status: "completed" | "failed" | "refused_budget" | "skipped_invalid_input";
  error?: string;
  overallScore?: number;
  scores?: Record<string, number>;
  issues?: ReviewIssue[];
  summary?: string;
  repairAttempts?: number;
  durationMs?: number;
  startedAt?: string;
  model?: string;
  usage?: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; estimatedCost: number };
  rawOutputSha256?: string;
}

/** 生产 academic prompt（digest 模式）——manuscriptDigest = 该臂文本；无 Evidence；目标档次全臂一致 */
export function buildShadowPrompt(input: NeutralityArmInput, targetProfile: string): string {
  return buildReviewPrompt({
    projectId: "shadow",
    mode: "academic",
    manuscriptDigest: input.text,
    evidence: [],
    targetProfile,
    language: input.language,
  });
}

function sha256(text: string): string {
  return createHash("sha256").update(text).digest("hex");
}

/** mulberry32：固定种子的可复现洗牌 */
function rng(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state + 0x6d2b79f5) >>> 0;
    let t = state;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * 调用计划：按优先级（tier 1 → 2 → 3）分段，每段内逐轮重复（rep）、轮内臂顺序随机化。
 * 预算不足时 Harness 按顺序执行、在预留被拒处停止——先保证核心对照（tier 1）的全部重复完整。
 */
export function planNeutralityCalls(inputs: readonly NeutralityArmInput[], options: { reps: number; seed: number; targetProfile: string; outputReserveTokens: number }): PlannedCall[] {
  const random = rng(options.seed);
  const valid = inputs.filter((input) => input.equivalence === "VALID");
  const plan: PlannedCall[] = [];
  const push = (input: NeutralityArmInput, rep: number) => {
    const prompt = buildShadowPrompt(input, options.targetProfile);
    const estimated = estimatePromptTokens(prompt);
    plan.push({
      callId: `${input.familyId}.${input.arm}.r${rep}`,
      familyId: input.familyId, arm: input.arm, rep, order: plan.length + 1, tier: input.tier,
      promptSha256: sha256(prompt), promptChars: prompt.length,
      estimatedPromptTokens: estimated, reservedTokens: estimated + options.outputReserveTokens,
    });
  };
  for (const tier of [1, 2, 3] as const) {
    for (let rep = 1; rep <= options.reps; rep += 1) {
      const round = valid.filter((input) => input.tier === tier).map((input) => ({ input, key: random() }));
      round.sort((a, b) => a.key - b.key);
      for (const { input } of round) push(input, rep);
    }
  }
  return plan;
}

export function resultFromReview(call: PlannedCall, review: ModeReviewResult, extra: Pick<NeutralityCallResult, "durationMs" | "startedAt" | "model" | "usage" | "rawOutputSha256">): NeutralityCallResult {
  return {
    callId: call.callId, familyId: call.familyId, arm: call.arm, rep: call.rep, status: "completed",
    ...(review.overallScore !== undefined ? { overallScore: review.overallScore } : {}),
    ...(review.scores !== undefined ? { scores: review.scores } : {}),
    issues: review.issues, summary: review.summary,
    repairAttempts: review.repair?.attempts ?? 0,
    ...extra,
  };
}

// ---------------------------------------------------------------------------
// Finding 分类（确定性词面初筛；报告中逐条人工复核命中项）

const IDENTITY_PATTERN = /(作者(信息|单位|简介|署名|顺序|姓名)|署名|通信作者|通讯作者|邮箱|e-?mail|affiliation|author (information|list|names?|block)|corresponding author|基金|funding|grant number|致谢|\backnowledge?ments?\b|单位与|单位不一致|机构)/i;
const FORMAT_PATTERN = /(\bMS Word\b|Word\s*(模板|文档|格式|版)|\bdocx\b|双栏|单栏|版式|排版|模板|\btemplate\b|two-column|double-column|字体|字号|页边距|中图分类号|文献标志码|文献标识码|著录格式|GB\/?T\s?7714|投稿(格式|系统|要求|规范)|题名(长度|字数|过长)|摘要(字数|超过|过长)|word count|page limit|篇幅限制|LaTeX 源|源码注释|红字|占位)/i;

export interface IssueClassification {
  identity: boolean;
  format: boolean;
  matched: string[];
}

export function classifyNeutralityIssue(issue: ReviewIssue): IssueClassification {
  const text = [issue.section, issue.description, issue.suggestedAction ?? "", issue.reason ?? ""].join(" ");
  const identity = IDENTITY_PATTERN.exec(text);
  const format = FORMAT_PATTERN.exec(text);
  return { identity: identity !== null, format: format !== null, matched: [identity?.[0], format?.[0]].filter((value): value is string => value !== undefined) };
}

// ---------------------------------------------------------------------------
// 比较（成对差值 + 重复采样噪声）

export interface CellStats { n: number; mean: number | null; sd: number | null; min: number | null; max: number | null; values: number[] }

function stats(values: number[]): CellStats {
  if (values.length === 0) return { n: 0, mean: null, sd: null, min: null, max: null, values };
  const mean = values.reduce((a, b) => a + b, 0) / values.length;
  const sd = values.length < 2 ? null : Math.sqrt(values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1));
  return { n: values.length, mean: round(mean), sd: sd === null ? null : round(sd), min: Math.min(...values), max: Math.max(...values), values };
}

function round(value: number, digits = 2): number {
  const factor = 10 ** digits;
  return Math.round(value * factor) / factor;
}

export interface NeutralityComparison {
  cells: Array<{
    familyId: string; arm: NeutralityArm; overall: CellStats; dimensions: Record<string, CellStats>;
    majors: CellStats; criticals: CellStats; identityFindings: number; formatFindings: number; identityOrFormatMajor: number;
  }>;
  pooledWithinCellSd: number | null;
  pairedDeltas: Array<{ familyId: string; contrast: string; overallDelta: number | null; dimensionDeltas: Record<string, number | null>; majorDelta: number | null; exceedsNoise: boolean | null }>;
}

export function compareNeutrality(results: readonly NeutralityCallResult[]): NeutralityComparison {
  const completed = results.filter((result) => result.status === "completed");
  const keys = [...new Set(completed.map((result) => `${result.familyId}::${result.arm}`))];
  const cells = keys.map((key) => {
    const [familyId, arm] = key.split("::") as [string, NeutralityArm];
    const rows = completed.filter((result) => result.familyId === familyId && result.arm === arm);
    const dims = [...new Set(rows.flatMap((row) => Object.keys(row.scores ?? {})))];
    const dimensions: Record<string, CellStats> = {};
    for (const dim of dims) dimensions[dim] = stats(rows.map((row) => row.scores?.[dim]).filter((value): value is number => value !== undefined));
    const classified = rows.flatMap((row) => (row.issues ?? []).map((issue) => ({ issue, cls: classifyNeutralityIssue(issue) })));
    return {
      familyId, arm,
      overall: stats(rows.map((row) => row.overallScore).filter((value): value is number => value !== undefined)),
      dimensions,
      majors: stats(rows.map((row) => (row.issues ?? []).filter((issue) => issue.severity === "major").length)),
      criticals: stats(rows.map((row) => (row.issues ?? []).filter((issue) => issue.severity === "critical").length)),
      identityFindings: classified.filter((entry) => entry.cls.identity).length,
      formatFindings: classified.filter((entry) => entry.cls.format).length,
      identityOrFormatMajor: classified.filter((entry) => (entry.cls.identity || entry.cls.format) && entry.issue.severity !== "minor").length,
    };
  });
  // 合并组内 SD（各格 n≥2 的样本方差按自由度加权）
  let ss = 0;
  let df = 0;
  for (const cell of cells) {
    if (cell.overall.n >= 2 && cell.overall.mean !== null) {
      ss += cell.overall.values.reduce((sum, value) => sum + (value - cell.overall.mean!) ** 2, 0);
      df += cell.overall.n - 1;
    }
  }
  const pooled = df === 0 ? null : round(Math.sqrt(ss / df));
  const pairedDeltas: NeutralityComparison["pairedDeltas"] = [];
  const families = [...new Set(cells.map((cell) => cell.familyId))];
  const contrasts: Array<[NeutralityArm, NeutralityArm]> = [["structured_blind_md", "raw"], ["naive_text", "raw"], ["format_only_md", "raw"], ["structured_blind_md", "format_only_md"], ["identity_swap", "structured_blind_md"]];
  for (const familyId of families) {
    for (const [arm, base] of contrasts) {
      const a = cells.find((cell) => cell.familyId === familyId && cell.arm === arm);
      const b = cells.find((cell) => cell.familyId === familyId && cell.arm === base);
      if (a === undefined || b === undefined || a.overall.mean === null || b.overall.mean === null) continue;
      const dimensionDeltas: Record<string, number | null> = {};
      for (const dim of Object.keys(a.dimensions)) {
        const x = a.dimensions[dim]?.mean;
        const y = b.dimensions[dim]?.mean;
        dimensionDeltas[dim] = x === null || x === undefined || y === null || y === undefined ? null : round(x - y);
      }
      const overallDelta = round(a.overall.mean - b.overall.mean);
      // 差值的标准误 ≈ pooled·sqrt(1/n_a + 1/n_b)；|Δ| > 2·SE 记为超出采样噪声
      const se = pooled === null ? null : pooled * Math.sqrt(1 / a.overall.n + 1 / b.overall.n);
      pairedDeltas.push({
        familyId, contrast: `${arm} − ${base}`, overallDelta, dimensionDeltas,
        majorDelta: a.majors.mean === null || b.majors.mean === null ? null : round(a.majors.mean - b.majors.mean),
        exceedsNoise: se === null ? null : Math.abs(overallDelta) > 2 * se,
      });
    }
  }
  return { cells, pooledWithinCellSd: pooled, pairedDeltas };
}
