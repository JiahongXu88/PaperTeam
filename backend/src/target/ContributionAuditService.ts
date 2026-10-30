/**
 * ContributionAuditService（M15.14）：贡献级"论文声称 → 先前工作 → 证据"审查。
 *
 * 背景（M15.11-13 结论）：整稿 Review 对最强 one-shot 基线优势不稳定；三轮共同
 * 强信号是整稿级 claim-evidence 综合。本轮把研究主轴改为贡献级证据比较：把稿件
 * 声称的每个创新点逐项与可核验先前工作比较，并与论文自身实验/论证证据相连。
 *
 * 机制：三次有界调用（沿用 FullPaperReviewService 的纪律）：
 *   1. extract（scope review/contribution/extract）：概览 + 确定性全节导航索引
 *      （无模型摘要——标题/页码/字符数/首段导语）+ 关键节全文 → 贡献清册 JSON
 *      （verbatim 引文 + sectionId 锚 + 支撑位置 + 文档类型敏感）。
 *   2. compare（scope review/contribution/compare）：贡献 + 支撑节全文 + 先前工作
 *      pool 材料（内容等级标注）→ 逐贡献三方比较 JSON（四态局部风险语义）。
 *   3. synthesize（scope review/contribution/synthesize）：清册 + 比较 → findings
 *      （沿用 ReviewFinding 载体）+ gapPlan（can_rewrite vs requires_real_experiment，
 *      后者停 Author Decision）。
 *
 * 纪律：
 * - 确定性守卫（quote 锚校验 / pool 身份解析 / 时间 cutoff / 四态规则）在模型输出
 *   之后强制执行；解析失败有界重试 1 次（物理调用）；非法条目如实计数不带病入工件；
 * - 先前工作材料停留在 candidate/线索层级（abstract/metadata），绝不写 EvidenceStore；
 *   benchmark sourceRole=reference 隔离红线不触碰；
 * - 审阅覆盖率显式登记（sectionsTotal/included/chars），未覆盖内容不冒充已读；
 * - 本服务 advisory only：工件 research/target-contribution-audit.json，零 gate 接线。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { AgentRunFailedError } from "../errors.js";
import type { AgentRuntime } from "../runtime/types.js";
import { verifyQuoteInChunk } from "../evidence/quoteVerification.js";
import {
  createFinding,
  FINDING_CATEGORIES,
  FINDING_SEVERITIES,
  type FindingCategory,
  type FindingSeverity,
  type ReviewFinding,
} from "../review/finding.js";
import type { PaperStore } from "../paper/PaperStore.js";
import { normalizeDoi, normalizeArxivId } from "../sources/identity.js";
import { sha256Hex } from "../util/hash.js";

/** prompt/输出契约版本（纳入工件 fingerprint；任何 prompt 变更必须递增） */
export const CONTRIBUTION_AUDIT_PROMPT_VERSION = "m1514-caudit-v1";
export const CONTRIBUTION_AUDIT_SCHEMA_VERSION = 1;

// ---- 预算常量（对齐 FullPaperReviewService 的截断披露纪律） ----
const OVERVIEW_MAX_CHARS = 2_000;
const INDEX_ENTRY_MAX_CHARS = 600;
const INDEX_TOTAL_MAX_CHARS = 12_000;
const INDEX_LEAD_CHARS = 260;
const KEY_SECTION_MAX_CHARS = 10_000;
const KEY_SECTION_TOTAL_MAX_CHARS = 30_000;
const SUPPORT_TOTAL_MAX_CHARS = 30_000;
const POOL_ABSTRACT_MAX_CHARS = 1_500;
const COMPARISONS_JSON_MAX_CHARS = 16_000;
const INVENTORY_JSON_MAX_CHARS = 12_000;
const MAX_CONTRIBUTIONS = 5;
const MAX_NEAREST_PRIOR = 3;
const KEY_SECTION_TITLE_PATTERN = /intro|conclu|contribut|abstract|summar|related|method|experiment|evaluat/i;
const FORMAT_REMINDER =
  "【格式提醒】上一次输出无法解析为 JSON。请只输出一个合法 JSON 对象（无围栏、无前后说明文字），字段名与示例完全一致。";

// ---- 类型 ----

export type PriorWorkContentLevel = "abstract" | "metadata";

export interface PriorWorkCandidate {
  candidateId: string;
  title: string;
  year?: number;
  venue?: string;
  doi?: string;
  arxivId?: string;
  authors?: string;
  /** 比较材料正文（abstract）；metadata 级可为空 */
  abstract?: string;
  /** 来自稿件自身参考文献表（作者已认为相关） */
  citedByManuscript: boolean;
  contentLevel: PriorWorkContentLevel;
  /** 检索来源记录（openalex:W… / reference-list 等） */
  source: string;
}

export interface PriorWorkPool {
  /** 先前工作时间因果 cutoff（ISO 日期）：仅 ≤ 该日公开的工作可入 pool */
  cutoffDate: string;
  candidates: PriorWorkCandidate[];
  /** pool 构建使用的确定性查询（记录预算与排名依据） */
  queriesUsed: string[];
}

export type ContributionClaimType =
  | "technical_idea"
  | "method_combination"
  | "performance_advantage"
  | "application_scope"
  | "analysis_or_taxonomy"
  | "dataset_or_benchmark"
  | "other";

export type SupportKind =
  | "method"
  | "experiment"
  | "comparison"
  | "ablation"
  | "table"
  | "conclusion"
  | "other";

export interface SupportLocation {
  sectionId: string;
  kind: SupportKind;
  quote?: string;
  verified: boolean;
}

export interface ContributionUnit {
  contributionId: string;
  claimQuote: string;
  claimParaphrase?: string;
  claimType: ContributionClaimType;
  applicability?: string;
  sectionId: string;
  page?: number;
  supportLocations: SupportLocation[];
  supportStatus: "located" | "missing";
  anchorVerified: boolean;
}

export type ComparisonStatus =
  | "SUPPORTED_DIFFERENCE"
  | "POTENTIAL_OVERLAP"
  | "EVIDENCE_GAP"
  | "INSUFFICIENT_EVIDENCE";

export type PriorWorkSourceLevel = "pool_abstract" | "pool_metadata" | "model_memory";

export interface PriorWorkRef {
  candidateId?: string;
  title: string;
  year?: number;
  doi?: string;
  arxivId?: string;
  sourceLevel?: PriorWorkSourceLevel;
  quote?: string;
  /** 确定性解析结果：能对上 pool 身份（含 candidateId/doi/arXiv/标题指纹） */
  resolvesToPool: boolean;
  /** 引用年份晚于 cutoff（时间因果违规，不计为有效先前工作） */
  timeCausalityViolation?: boolean;
}

export type DifferenceBasis = "abstract" | "metadata" | "none";

export interface ContributionComparison {
  contributionId: string;
  nearestPriorWorks: PriorWorkRef[];
  commonMechanism: string;
  substantiveDifference: string;
  differenceBasis: DifferenceBasis;
  completedVerification: string;
  missingVerification: string;
  status: ComparisonStatus;
  uncertainty?: string;
}

export interface ExperimentPlan {
  purpose: string;
  baselines?: string;
  datasets?: string;
  metrics?: string;
  expectedEvidence?: string;
}

export interface GapPlanItem {
  contributionId: string;
  gap: string;
  actionType: "can_rewrite_from_existing_evidence" | "requires_real_experiment_or_author_input";
  experimentPlan?: ExperimentPlan;
  /** requires_real_experiment 恒为 author_decision——模型停在提议，不造数 */
  status: "proposed" | "author_decision";
}

/** ReviewFinding 的 additive 扩展（不改 finding.ts 本体；extra 字段随工件落盘） */
export interface ContributionAuditFinding extends ReviewFinding {
  contributionId?: string;
  comparisonStatus?: ComparisonStatus;
  priorWorkTitles?: string[];
}

export interface ContributionCoverageLedger {
  sectionsTotal: number;
  sectionsIndexed: number;
  sectionsIncludedFullText: number;
  manuscriptCharsTotal: number;
  manuscriptCharsIncluded: number;
  truncations: string[];
}

export interface ContributionAuditGuards {
  anchorFailures: number;
  unresolvedPriorWorkRefs: number;
  cutoffViolations: number;
  statusRuleViolations: number;
  droppedFindings: number;
}

export interface ContributionAuditInputFingerprint {
  manuscriptSha256: string;
  poolFingerprint: string;
  promptVersion: string;
  model?: string;
  documentType: string;
  venueId?: string;
}

export interface ContributionAuditArtifact {
  schemaVersion: typeof CONTRIBUTION_AUDIT_SCHEMA_VERSION;
  venueId?: string;
  documentType: string;
  promptVersion: string;
  model?: string;
  evaluatedAt: string;
  manuscriptRevision?: number | null;
  priorWork: {
    cutoffDate: string;
    poolFingerprint: string;
    poolSize: number;
    queriesUsed: string[];
    candidates: PriorWorkCandidate[];
  };
  inventory: ContributionUnit[];
  comparisons: ContributionComparison[];
  gapPlan: GapPlanItem[];
  findings: ContributionAuditFinding[];
  coverage: ContributionCoverageLedger;
  guards: ContributionAuditGuards;
  inputFingerprint: ContributionAuditInputFingerprint;
  summaryFailure?: string;
  provenance: { basis: "model_judgment_advisory"; disclaimer: string };
}

export interface ContributionAuditTelemetry {
  calls: number;
  failed: number;
  totalMs: number;
  approxPromptChars: number;
  outputChars: number;
}

export interface ContributionAuditOutcome {
  artifact: ContributionAuditArtifact;
  telemetry: ContributionAuditTelemetry;
  extractParseFailed: boolean;
  compareParseFailed: boolean;
  synthesizeParseFailed: boolean;
  extractRetried: boolean;
  compareRetried: boolean;
  synthesizeRetried: boolean;
}

const DISCLAIMER =
  "本工件为贡献级学术风险评估（模型判断，advisory）：比较材料为 abstract/metadata 级先前工作与稿件原文锚，不构成任何期刊录用判断，不进入任何质量门禁；'未发现同类工作'不等于创新性成立。";

// ---- 确定性守卫（纯函数，导出供测试与 harness 复用） ----

/** 标题指纹（与 scripts 选样同规则：小写 + 非字母数字折叠） */
export function titleFingerprint(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}

/** pool 指纹：候选行规范化排序后 sha256（内容敏感——摘要变化即失效） */
export function buildPoolFingerprint(pool: PriorWorkPool): string {
  const rows = [...pool.candidates]
    .map((c) =>
      [
        c.candidateId,
        titleFingerprint(c.title),
        c.year ?? "",
        c.doi ? normalizeDoi(c.doi) : "",
        c.arxivId ? normalizeArxivId(c.arxivId) : "",
        c.citedByManuscript ? "ref" : "ext",
        c.contentLevel,
        c.abstract ?? "",
      ].join("|"),
    )
    .sort();
  return sha256Hex(`${pool.cutoffDate}\n${rows.join("\n")}`).slice(0, 16);
}

/** 单个模型引用的先前工作 → pool 身份解析（candidateId > DOI > arXiv > 标题指纹） */
export function resolvePriorWorkRef(
  ref: { candidateId?: string; title: string; year?: number; doi?: string; arxivId?: string },
  pool: PriorWorkPool,
): PriorWorkCandidate | null {
  if (ref.candidateId !== undefined && ref.candidateId !== "") {
    const byId = pool.candidates.find((c) => c.candidateId === ref.candidateId);
    if (byId !== undefined) return byId;
  }
  if (ref.doi !== undefined && ref.doi !== "") {
    const doi = normalizeDoi(ref.doi);
    if (doi !== undefined) {
      const byDoi = pool.candidates.find((c) => c.doi !== undefined && normalizeDoi(c.doi) === doi);
      if (byDoi !== undefined) return byDoi;
    }
  }
  if (ref.arxivId !== undefined && ref.arxivId !== "") {
    const arxiv = normalizeArxivId(ref.arxivId);
    if (arxiv !== undefined) {
      const byArxiv = pool.candidates.find((c) => c.arxivId !== undefined && normalizeArxivId(c.arxivId) === arxiv);
      if (byArxiv !== undefined) return byArxiv;
    }
  }
  const fp = titleFingerprint(ref.title);
  if (fp !== "") {
    const byTitle = pool.candidates.find((c) => titleFingerprint(c.title) === fp);
    if (byTitle !== undefined) return byTitle;
  }
  return null;
}

/** 引用年份晚于 cutoff 年 → 时间因果违规（不可作为 novelty 证据） */
export function isCutoffViolation(year: number | undefined, cutoffDate: string): boolean {
  if (year === undefined) return false;
  const cutoffYear = Number.parseInt(cutoffDate.slice(0, 4), 10);
  return Number.isFinite(cutoffYear) && year > cutoffYear;
}

export interface StatusRuleResult {
  comparisons: ContributionComparison[];
  violations: Array<{ contributionId: string; rule: string }>;
}

/**
 * 四态规则强制执行（任务书 B3 红线）：
 * - SUPPORTED_DIFFERENCE 必须有 ≥1 个可解析到 pool 且非时间违规的先前工作
 *   （"没搜到同类工作"绝不能自动当 SUPPORTED_DIFFERENCE）；
 * - POTENTIAL_OVERLAP 必须点名 ≥1 个有效先前工作；
 * - 违规 → 降级 INSUFFICIENT_EVIDENCE 并计数（如实入 guards，不静默）。
 */
export function enforceStatusRules(comparisons: ContributionComparison[]): StatusRuleResult {
  const violations: Array<{ contributionId: string; rule: string }> = [];
  const out = comparisons.map((comparison) => {
    const validPriors = comparison.nearestPriorWorks.filter(
      (ref) => ref.resolvesToPool && ref.timeCausalityViolation !== true,
    );
    if (
      (comparison.status === "SUPPORTED_DIFFERENCE" || comparison.status === "POTENTIAL_OVERLAP") &&
      validPriors.length === 0
    ) {
      violations.push({
        contributionId: comparison.contributionId,
        rule: `${comparison.status}_without_resolvable_prior`,
      });
      return { ...comparison, status: "INSUFFICIENT_EVIDENCE" as ComparisonStatus };
    }
    if (comparison.status === "SUPPORTED_DIFFERENCE" && comparison.differenceBasis === "none") {
      violations.push({
        contributionId: comparison.contributionId,
        rule: "supported_difference_without_observable_basis",
      });
      return { ...comparison, status: "INSUFFICIENT_EVIDENCE" as ComparisonStatus };
    }
    return comparison;
  });
  return { comparisons: out, violations };
}

/** 渲染 pool 材料（A0/A2 共用同一段字节——保证臂间材料一致） */
export function renderPoolMaterial(pool: PriorWorkPool): string {
  const cutoffYear = pool.cutoffDate.slice(0, 4);
  const lines = pool.candidates.map((c) => {
    const head = `- ${c.candidateId} [${c.contentLevel}${c.citedByManuscript ? "; cited-by-manuscript" : ""}] ${c.title}`
      + `${c.authors ? ` — ${c.authors}` : ""} (${c.year ?? "year?"}${c.venue ? `, ${c.venue}` : ""})`
      + `${c.doi ? ` doi:${c.doi}` : ""}${c.arxivId ? ` arXiv:${c.arxivId}` : ""}`;
    const abstract =
      c.contentLevel === "abstract" && c.abstract !== undefined && c.abstract !== ""
        ? `\n  Abstract: ${c.abstract.slice(0, POOL_ABSTRACT_MAX_CHARS)}`
        : "";
    return head + abstract;
  });
  return [
    `【PRIOR WORK MATERIAL（确定性检索；公开时间 ≤ ${pool.cutoffDate}；内容等级标注）】`,
    `content-level 说明：abstract = 题录+摘要可观察；metadata = 仅题录。abstract 级可比较思想，但不得断言实现级异同。`,
    `novelty 评价时点 = ${cutoffYear} 年（cutoff ${pool.cutoffDate}）；不得以 cutoff 之后公开的工作否定当年 novelty。`,
    ...lines,
  ].join("\n");
}

// ---- 宽容 JSON（与 FullPaperReviewService 同容忍度） ----

function stripCodeFence(text: string): string {
  const fenced = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(text);
  return fenced !== null ? fenced[1] ?? text : text;
}

function parseLenientJson(raw: string): unknown | undefined {
  const text = raw.trim();
  if (text === "") {
    return undefined;
  }
  try {
    return JSON.parse(stripCodeFence(text));
  } catch {
    const start = text.indexOf("{");
    const end = text.lastIndexOf("}");
    if (start === -1 || end <= start) {
      return undefined;
    }
    try {
      return JSON.parse(text.slice(start, end + 1));
    } catch {
      return undefined;
    }
  }
}

function str(value: unknown, max: number): string {
  return String(value ?? "").replace(/\s+/g, " ").trim().slice(0, max);
}

function optionalStr(value: unknown, max: number): string | undefined {
  const s = str(value, max);
  return s === "" ? undefined : s;
}

function num(value: unknown): number | undefined {
  const n = typeof value === "number" ? value : Number.parseInt(String(value ?? ""), 10);
  return Number.isFinite(n) ? n : undefined;
}

function enumOf<T extends string>(value: unknown, allowed: readonly T[], fallback: T): T {
  const s = String(value ?? "");
  return (allowed as readonly string[]).includes(s) ? (s as T) : fallback;
}

// ---- 模型输出 → 结构化（纯函数，导出供测试） ----

const CLAIM_TYPES: readonly ContributionClaimType[] = [
  "technical_idea",
  "method_combination",
  "performance_advantage",
  "application_scope",
  "analysis_or_taxonomy",
  "dataset_or_benchmark",
  "other",
];
const SUPPORT_KINDS: readonly SupportKind[] = [
  "method",
  "experiment",
  "comparison",
  "ablation",
  "table",
  "conclusion",
  "other",
];
const COMPARISON_STATUSES: readonly ComparisonStatus[] = [
  "SUPPORTED_DIFFERENCE",
  "POTENTIAL_OVERLAP",
  "EVIDENCE_GAP",
  "INSUFFICIENT_EVIDENCE",
];
const DIFFERENCE_BASES: readonly DifferenceBasis[] = ["abstract", "metadata", "none"];

/** extract 输出的中间形态（未做锚校验/编号） */
export interface ParsedContribution {
  claimQuote: string;
  claimParaphrase?: string;
  claimType: ContributionClaimType;
  applicability?: string;
  sectionId: string;
  page?: number;
  rawSupportLocations: Array<{ sectionId: string; kind: SupportKind; quote?: string }>;
}

export function parseInventoryOutput(raw: string): {
  contributions: ParsedContribution[];
  parseFailed: boolean;
} {
  const parsed = parseLenientJson(raw);
  const list = Array.isArray((parsed as { contributions?: unknown } | undefined)?.contributions)
    ? ((parsed as { contributions: unknown[] }).contributions as unknown[])
    : [];
  const contributions = list.slice(0, MAX_CONTRIBUTIONS).map((item) => {
    const record = (item ?? {}) as Record<string, unknown>;
    const supports = Array.isArray(record["supportLocations"]) ? (record["supportLocations"] as unknown[]) : [];
    return {
      claimQuote: str(record["claimQuote"], 600),
      claimParaphrase: optionalStr(record["claimParaphrase"], 800),
      claimType: enumOf(record["claimType"], CLAIM_TYPES, "other"),
      applicability: optionalStr(record["applicability"], 500),
      sectionId: str(record["sectionId"], 64),
      page: num(record["page"]),
      rawSupportLocations: supports.slice(0, 6).map((s) => {
        const sr = (s ?? {}) as Record<string, unknown>;
        return {
          sectionId: str(sr["sectionId"], 64),
          kind: enumOf(sr["kind"], SUPPORT_KINDS, "other"),
          quote: optionalStr(sr["quote"], 400),
        };
      }),
    };
  });
  return { contributions, parseFailed: parsed === undefined };
}

export function parseComparisonsOutput(raw: string): {
  comparisons: Array<Omit<ContributionComparison, "nearestPriorWorks"> & {
    nearestPriorWorks: Array<{ candidateId?: string; title: string; year?: number; doi?: string; arxivId?: string; sourceLevel?: PriorWorkSourceLevel; quote?: string }>;
  }>;
  parseFailed: boolean;
} {
  const parsed = parseLenientJson(raw);
  const list = Array.isArray((parsed as { comparisons?: unknown } | undefined)?.comparisons)
    ? ((parsed as { comparisons: unknown[] }).comparisons as unknown[])
    : [];
  const comparisons = list.map((item) => {
    const record = (item ?? {}) as Record<string, unknown>;
    const refs = Array.isArray(record["nearestPriorWorks"]) ? (record["nearestPriorWorks"] as unknown[]) : [];
    return {
      contributionId: str(record["contributionId"], 16),
      nearestPriorWorks: refs.slice(0, MAX_NEAREST_PRIOR).map((r) => {
        const rr = (r ?? {}) as Record<string, unknown>;
        return {
          candidateId: optionalStr(rr["candidateId"], 16),
          title: str(rr["title"], 400),
          year: num(rr["year"]),
          doi: optionalStr(rr["doi"], 120),
          arxivId: optionalStr(rr["arxivId"], 60),
          sourceLevel: optionalStr(rr["sourceLevel"], 32) as PriorWorkSourceLevel | undefined,
          quote: optionalStr(rr["quote"], 300),
        };
      }),
      commonMechanism: str(record["commonMechanism"], 1000),
      substantiveDifference: str(record["substantiveDifference"], 1500),
      differenceBasis: enumOf(record["differenceBasis"], DIFFERENCE_BASES, "none"),
      completedVerification: str(record["completedVerification"], 1000),
      missingVerification: str(record["missingVerification"], 1000),
      status: enumOf(record["status"], COMPARISON_STATUSES, "INSUFFICIENT_EVIDENCE"),
      uncertainty: optionalStr(record["uncertainty"], 800),
    };
  });
  return { comparisons, parseFailed: parsed === undefined };
}

export function parseSynthesisOutput(raw: string): {
  findings: Array<{
    category: FindingCategory;
    severity: FindingSeverity;
    sectionId: string;
    contributionId?: string;
    claimText?: string;
    message: string;
    evidenceGap?: string;
    confidence?: "high" | "medium" | "low";
    suggestion?: string;
    priorWorkTitles?: string[];
  }>;
  gapPlan: GapPlanItem[];
  parseFailed: boolean;
} {
  const parsed = parseLenientJson(raw);
  const record = (parsed ?? {}) as Record<string, unknown>;
  const rawFindings = Array.isArray(record["findings"]) ? (record["findings"] as unknown[]) : [];
  const findings = rawFindings.map((item) => {
    const fr = (item ?? {}) as Record<string, unknown>;
    const priorTitles = Array.isArray(fr["priorWorkTitles"]) ? (fr["priorWorkTitles"] as unknown[]).map((t) => str(t, 300)) : [];
    return {
      category: enumOf(fr["category"], FINDING_CATEGORIES as readonly FindingCategory[], "academic"),
      severity: enumOf(fr["severity"], FINDING_SEVERITIES as readonly FindingSeverity[], "minor"),
      sectionId: str(fr["sectionId"], 64),
      contributionId: optionalStr(fr["contributionId"], 16),
      claimText: optionalStr(fr["claimText"], 600),
      message: str(fr["message"], 2000),
      evidenceGap: optionalStr(fr["evidenceGap"], 1000),
      confidence: optionalStr(fr["confidence"], 10) as "high" | "medium" | "low" | undefined,
      suggestion: optionalStr(fr["suggestion"], 1000),
      ...(priorTitles.length > 0 ? { priorWorkTitles: priorTitles.slice(0, 5) } : {}),
    };
  });
  const rawGaps = Array.isArray(record["gapPlan"]) ? (record["gapPlan"] as unknown[]) : [];
  const gapPlan = rawGaps.map((item) => {
    const gr = (item ?? {}) as Record<string, unknown>;
    const ep = (gr["experimentPlan"] ?? null) as Record<string, unknown> | null;
    const actionType = enumOf(
      gr["actionType"],
      ["can_rewrite_from_existing_evidence", "requires_real_experiment_or_author_input"] as const,
      "can_rewrite_from_existing_evidence",
    );
    return {
      contributionId: str(gr["contributionId"], 16),
      gap: str(gr["gap"], 1000),
      actionType,
      ...(ep !== null && actionType === "requires_real_experiment_or_author_input"
        ? {
            experimentPlan: {
              purpose: str(ep["purpose"], 800),
              baselines: optionalStr(ep["baselines"], 500),
              datasets: optionalStr(ep["datasets"], 500),
              metrics: optionalStr(ep["metrics"], 500),
              expectedEvidence: optionalStr(ep["expectedEvidence"], 500),
            },
          }
        : {}),
      status: actionType === "requires_real_experiment_or_author_input" ? ("author_decision" as const) : ("proposed" as const),
    };
  });
  return { findings, gapPlan, parseFailed: parsed === undefined };
}

// ---- prompt 指令（版本随 CONTRIBUTION_AUDIT_PROMPT_VERSION 冻结） ----

const EXTRACT_INSTRUCTION = `Extract the manuscript's core claimed contributions as a structured inventory.

Rules:
- Identify at most 5 contribution units — distinct claimed advances (technical idea / method combination / performance advantage / application scope / analysis-taxonomy / dataset-benchmark). Do not list the same idea twice under different wording.
- claimQuote MUST be a verbatim contiguous quote from the manuscript (<= 600 chars) that states the claim. Do not paraphrase inside claimQuote.
- sectionId must be one of the SEC ids shown in the navigation index; include page when known.
- supportLocations: where the manuscript substantiates this claim (method description / experiments / comparisons / ablations / tables / conclusions). Give sectionId + kind + a short verbatim quote when possible. If the manuscript contains NO substantiation for a claim, return an empty supportLocations array — never invent support.
- Document-type sensitivity: when documentType is a survey/review, contribution units are taxonomy, coverage, comparative synthesis, critical insight, future directions. Do NOT treat the absence of original experiments in a survey as missing support.

Output ONLY one JSON object:
{"contributions":[{"claimQuote":"...","claimParaphrase":"...","claimType":"technical_idea|method_combination|performance_advantage|application_scope|analysis_or_taxonomy|dataset_or_benchmark|other","applicability":"...","sectionId":"SECxx","page":0,"supportLocations":[{"sectionId":"SECxx","kind":"method|experiment|comparison|ablation|table|conclusion|other","quote":"..."}]}]}`;

function compareInstruction(cutoffDate: string): string {
  return `For each contribution unit, compare it against the closest prior work.

The PRIOR WORK MATERIAL below was retrieved deterministically (the manuscript's own reference list plus academic-database search, publication date <= ${cutoffDate}). Each entry carries an observable content level: "abstract" (title+abstract available) or "metadata" (bibliographic record only).

Rules:
- Judge novelty AS OF ${cutoffDate}. Never use knowledge of work published after that date as evidence against novelty. You may additionally draw on your own knowledge of work published before the cutoff; for such works set sourceLevel "model_memory" and give title + year + DOI/arXiv id if you are confident of the identity.
- For each contribution, list 0-3 nearestPriorWorks. For provided entries use their candidateId (P##). Prefer the closest TECHNICAL IDEAS, not merely highly-cited papers.
- commonMechanism: the technical mechanism shared with the nearest prior work.
- substantiveDifference: what is actually different (structural novelty / new combination / empirical improvement / scope extension / presentation-only rewording). Rephrasing is NOT a technical difference.
- differenceBasis: the observable content level your difference judgment rests on ("abstract" | "metadata" | "none"). With abstract-level material you may compare ideas, but you CANNOT assert implementation-level sameness or difference of details; with metadata-only material you cannot support strong claims.
- completedVerification: what the manuscript's own evidence already shows about this difference; missingVerification: what evidence is missing (baselines / ablations / datasets / statistics / analysis).
- status (local risk semantics, NOT an acceptance verdict):
  * SUPPORTED_DIFFERENCE — a locatable technical difference exists AND the observed material (manuscript + prior work at its content level) supports it;
  * POTENTIAL_OVERLAP — prior work may already cover the claimed novelty; show the concrete overlap AND the part that remains undecidable;
  * EVIDENCE_GAP — the paper's own evidence does not demonstrate the claimed advance (claim/experiment mismatch);
  * INSUFFICIENT_EVIDENCE — manuscript detail or prior-work material is missing to decide.
- "No similar work found in the provided material" is NEVER sufficient for SUPPORTED_DIFFERENCE — that situation is INSUFFICIENT_EVIDENCE (or POTENTIAL_OVERLAP when coverage is partial).
- quote: a short verbatim quote from the provided abstract when your judgment relies on specific wording (pool entries only; never fabricate quotes).

Output ONLY one JSON object:
{"comparisons":[{"contributionId":"C1","nearestPriorWorks":[{"candidateId":"P01","title":"...","year":2016,"doi":"...","arxivId":"...","sourceLevel":"pool_abstract|pool_metadata|model_memory","quote":"..."}],"commonMechanism":"...","substantiveDifference":"...","differenceBasis":"abstract|metadata|none","completedVerification":"...","missingVerification":"...","status":"...","uncertainty":"..."}]}`;
}

const SYNTHESIZE_INSTRUCTION = `Turn the contribution inventory and prior-work comparisons into review findings and an actionable gap plan.

Rules:
- findings: only substantive, checkable issues about novelty positioning, contribution substance, related-work coverage, claim-evidence support, or overclaiming. Each finding: category (academic|fact|citation|consistency), severity (critical|major|minor|info — critical/major only for substantive academic defects), sectionId (an existing SEC id, ideally where the claim is stated), claimText (a short verbatim anchor from the manuscript), message (1-3 sentences, concrete: which claim, which prior work, what gap), evidenceGap, suggestion. Do not fabricate manuscript text or prior-work identities; refer only to what appears in the inventory/comparisons.
- gapPlan: for each contribution with missing verification, exactly one item: actionType "can_rewrite_from_existing_evidence" (tighten overclaimed wording / reposition the contribution / add comparison discussion from existing material) or "requires_real_experiment_or_author_input" (needs real experiments, ablations, baselines, datasets, or author-provided facts). For the latter include experimentPlan {purpose, baselines, datasets, metrics, expectedEvidence} and STOP at proposing — never invent results, tables, or numbers.

Output ONLY one JSON object:
{"findings":[{"category":"academic","severity":"major","sectionId":"SEC01","contributionId":"C1","claimText":"...","message":"...","evidenceGap":"...","confidence":"high|medium|low","suggestion":"...","priorWorkTitles":["..."]}],"gapPlan":[{"contributionId":"C1","gap":"...","actionType":"can_rewrite_from_existing_evidence|requires_real_experiment_or_author_input","experimentPlan":{"purpose":"...","baselines":"...","datasets":"...","metrics":"...","expectedEvidence":"..."}}]}`;

// ---- 服务 ----

export interface ContributionAuditServiceOptions {
  store: PaperStore;
  runtime: AgentRuntime;
  reviewerAgentId: string;
  /** 工件落盘根（projects.researchDir） */
  researchDir: (projectId: string) => string;
  runTimeoutMs?: number;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface AuditInput {
  projectId: string;
  runId: string;
  pool: PriorWorkPool;
  documentType: string;
  venueId?: string;
  manuscriptRevision?: number | null;
  /** 实验侧统一 read_only（与 A0 对齐工具面）；产品路径可缺省 */
  toolPolicy?: "default" | "read_only" | "sealed";
  signal?: AbortSignal;
}

export class ContributionAuditService {
  private readonly store: PaperStore;
  private readonly runtime: AgentRuntime;
  private readonly reviewerAgentId: string;
  private readonly researchDir: (projectId: string) => string;
  private readonly now: () => Date;
  private readonly timeoutOverride: { timeoutMs?: number };

  constructor(options: ContributionAuditServiceOptions) {
    this.store = options.store;
    this.runtime = options.runtime;
    this.reviewerAgentId = options.reviewerAgentId;
    this.researchDir = options.researchDir;
    this.now = options.now ?? (() => new Date());
    this.timeoutOverride = options.runTimeoutMs !== undefined ? { timeoutMs: options.runTimeoutMs } : {};
  }

  artifactPath(projectId: string): string {
    return join(this.researchDir(projectId), "target-contribution-audit.json");
  }

  async audit(input: AuditInput): Promise<ContributionAuditOutcome> {
    const document = await this.store.loadDocument(input.projectId);
    if (document === null) {
      throw new AgentRunFailedError("尚未解析稿件（先完成 PDF/LaTeX 摄取）");
    }
    const pool = input.pool;
    const poolFingerprint = buildPoolFingerprint(pool);

    // ---- 事实源组装（确定性导航索引，无模型摘要；截断全部登记） ----
    const overviewParts: string[] = [];
    if (document.title !== undefined && document.title !== "") {
      overviewParts.push(`Title: ${document.title}`);
    }
    if (document.abstract !== undefined && document.abstract !== "") {
      overviewParts.push(`Abstract: ${document.abstract.slice(0, OVERVIEW_MAX_CHARS)}`);
    }
    const overview = overviewParts.join("\n");

    const chunksBySection = new Map<string, string[]>();
    let manuscriptCharsTotal = 0;
    for (const chunk of document.chunks) {
      const list = chunksBySection.get(chunk.sectionId) ?? [];
      list.push(chunk.text);
      chunksBySection.set(chunk.sectionId, list);
      manuscriptCharsTotal += chunk.text.length;
    }
    const fullTextOf = (sectionId: string): string =>
      (chunksBySection.get(sectionId) ?? []).join("\n\n");

    const sectionsById = new Map(document.sections.map((s) => [s.sectionId, s]));
    const truncations: string[] = [];
    const indexLines: string[] = [];
    let indexChars = 0;
    let sectionsIndexed = 0;
    for (const section of document.sections) {
      const text = fullTextOf(section.sectionId);
      const lead = text.replace(/\s+/g, " ").trim().slice(0, INDEX_LEAD_CHARS);
      const line = `- ${section.sectionId} ${section.title}（p${section.pageStart}-${section.pageEnd}，${section.charCount} chars）：${lead}`.slice(
        0,
        INDEX_ENTRY_MAX_CHARS,
      );
      if (indexChars + line.length > INDEX_TOTAL_MAX_CHARS) {
        truncations.push(`nav-index-truncated-after-${section.sectionId}`);
        break;
      }
      indexLines.push(line);
      indexChars += line.length;
      sectionsIndexed += 1;
    }
    const sectionIndex = indexLines.join("\n");

    const keySections = document.sections.filter((entry) => KEY_SECTION_TITLE_PATTERN.test(entry.title));
    const keySectionBlocks: string[] = [];
    let keyChars = 0;
    const sectionsIncluded = new Set<string>();
    for (const entry of keySections) {
      let text = fullTextOf(entry.sectionId).slice(0, KEY_SECTION_MAX_CHARS);
      if (keyChars + text.length > KEY_SECTION_TOTAL_MAX_CHARS) {
        const remaining = KEY_SECTION_TOTAL_MAX_CHARS - keyChars;
        if (remaining <= 200) {
          truncations.push(`key-sections-truncated-at-${entry.sectionId}`);
          break;
        }
        text = text.slice(0, remaining);
        truncations.push(`key-section-${entry.sectionId}-truncated`);
      }
      keySectionBlocks.push([`【${entry.sectionId} ${entry.title} 全文】`, text].join("\n"));
      keyChars += text.length;
      sectionsIncluded.add(entry.sectionId);
    }

    const telemetry: ContributionAuditTelemetry = {
      calls: 0,
      failed: 0,
      totalMs: 0,
      approxPromptChars: 0,
      outputChars: 0,
    };
    const callAgent = async (args: { prompt: string; contextScope: string; pass: string }): Promise<string> => {
      telemetry.calls += 1;
      telemetry.approxPromptChars += args.prompt.length;
      const startedAt = Date.now();
      const task = await this.runtime.runAgent({
        agentId: this.reviewerAgentId,
        ...this.timeoutOverride,
        projectId: input.projectId,
        contextScope: args.contextScope,
        task: args.prompt,
        ...(input.toolPolicy !== undefined ? { toolPolicy: input.toolPolicy } : {}),
        ...(input.signal !== undefined ? { signal: input.signal } : {}),
        metadata: { role: "reviewer", pass: args.pass },
      });
      const output = task.status === "completed" ? task.output ?? "" : "";
      telemetry.totalMs += Date.now() - startedAt;
      telemetry.outputChars += output.length;
      if (output.trim() === "") {
        telemetry.failed += 1;
      }
      return output;
    };
    const withParseRetry = async (
      run: (retry: boolean) => Promise<string>,
      parse: (output: string) => { parseFailed: boolean },
    ): Promise<{ value: string; parseFailed: boolean; retried: boolean }> => {
      let output = await run(false);
      if (!parse(output).parseFailed) {
        return { value: output, parseFailed: false, retried: false };
      }
      output = await run(true);
      return { value: output, parseFailed: parse(output).parseFailed, retried: true };
    };

    // ---- Call 1：贡献清册抽取 ----
    const extractPrompt = [
      ...(overview !== "" ? [`【Manuscript overview】\n${overview}`] : []),
      `【Navigation index (all sections; deterministic, no model summaries)】\n${sectionIndex}`,
      ...(keySectionBlocks.length > 0 ? [`【Key sections full text】\n${keySectionBlocks.join("\n\n")}`] : []),
      `【Task (documentType: ${input.documentType})】\n${EXTRACT_INSTRUCTION}`,
    ].join("\n\n");
    const extractOutcome = await withParseRetry(
      (retry) =>
        callAgent({
          prompt: retry ? `${extractPrompt}\n\n${FORMAT_REMINDER}` : extractPrompt,
          contextScope: "review/contribution/extract",
          pass: "contribution-extract",
        }),
      (output) => parseInventoryOutput(output),
    );
    const inventoryRaw = parseInventoryOutput(extractOutcome.value);

    const guards: ContributionAuditGuards = {
      anchorFailures: 0,
      unresolvedPriorWorkRefs: 0,
      cutoffViolations: 0,
      statusRuleViolations: 0,
      droppedFindings: 0,
    };

    const documentText = document.chunks.map((c) => c.text).join("\n\n");
    // CJK 锚校验修复（M15.14 Phase D 发现）：PDF 换行在中文句中插入空白，空白折叠
    // 后 substring 仍失配——含 CJK 的引文额外用"剥离全部空白"的文本核验（任一通过即锚定）。
    const hasCjk = (text: string): boolean => /[㐀-鿿豈-﫿　-〿＀-￯]/.test(text);
    const stripAllWhitespace = (text: string): string => text.replace(/\s+/g, "");
    const cjkDocumentText = hasCjk(documentText) ? stripAllWhitespace(documentText) : documentText;
    const verifyQuoteAnywhere = (quote: string): boolean => {
      if (verifyQuoteInChunk(quote, documentText).ok) return true;
      return hasCjk(quote) && verifyQuoteInChunk(stripAllWhitespace(quote), cjkDocumentText).ok;
    };
    const verifyQuoteInSection = (quote: string, sectionId: string): boolean => {
      const text = fullTextOf(sectionId);
      if (verifyQuoteInChunk(quote, text).ok) return true;
      return hasCjk(quote) && verifyQuoteInChunk(stripAllWhitespace(quote), stripAllWhitespace(text)).ok;
    };
    const inventory: ContributionUnit[] = [];
    inventoryRaw.contributions.forEach((c, index) => {
      // 锚纪律：claimQuote 为空/sectionId 非法/引文无法在稿件中核验 → 丢弃并计数
      //（不可追溯的声称不进入比较链，绝不以兜底节伪造锚）
      if (c.claimQuote === "" || c.sectionId === "" || !sectionsById.has(c.sectionId)) {
        guards.anchorFailures += 1;
        return;
      }
      if (!verifyQuoteAnywhere(c.claimQuote)) {
        guards.anchorFailures += 1;
        return;
      }
      const supportLocations: SupportLocation[] = [];
      for (const s of c.rawSupportLocations) {
        if (s.sectionId === "" || !sectionsById.has(s.sectionId)) {
          continue;
        }
        const verified = s.quote !== undefined && verifyQuoteInSection(s.quote, s.sectionId);
        supportLocations.push({ sectionId: s.sectionId, kind: s.kind, quote: s.quote, verified });
        sectionsIncluded.add(s.sectionId);
      }
      inventory.push({
        contributionId: `C${index + 1}`,
        claimQuote: c.claimQuote,
        claimParaphrase: c.claimParaphrase,
        claimType: c.claimType,
        applicability: c.applicability,
        sectionId: c.sectionId,
        page: c.page,
        supportLocations,
        supportStatus: supportLocations.length > 0 ? "located" : "missing",
        anchorVerified: true,
      });
    });

    // ---- Call 2：逐贡献三方比较（pool 材料 + 支撑节全文） ----
    const supportBlocks: string[] = [];
    let supportChars = 0;
    const supportSectionIds = new Set<string>();
    for (const unit of inventory) {
      supportSectionIds.add(unit.sectionId);
      for (const s of unit.supportLocations) {
        supportSectionIds.add(s.sectionId);
      }
    }
    for (const sectionId of supportSectionIds) {
      const entry = sectionsById.get(sectionId);
      if (entry === undefined) continue;
      let text = fullTextOf(sectionId);
      if (supportChars + text.length > SUPPORT_TOTAL_MAX_CHARS) {
        const remaining = SUPPORT_TOTAL_MAX_CHARS - supportChars;
        if (remaining <= 200) {
          truncations.push(`support-sections-truncated-at-${sectionId}`);
          break;
        }
        text = text.slice(0, remaining);
        truncations.push(`support-section-${sectionId}-truncated`);
      }
      supportBlocks.push([`【${entry.sectionId} ${entry.title} 全文】`, text].join("\n"));
      supportChars += text.length;
      sectionsIncluded.add(sectionId);
    }
    const inventoryJson = JSON.stringify(
      inventory.map(({ claimQuote, claimParaphrase, claimType, applicability, contributionId, sectionId, page, supportStatus, supportLocations }) => ({
        contributionId,
        claimQuote,
        claimParaphrase,
        claimType,
        applicability,
        sectionId,
        page,
        supportStatus,
        supportLocations,
      })),
    ).slice(0, INVENTORY_JSON_MAX_CHARS);
    const comparePrompt = [
      ...(overview !== "" ? [`【Manuscript overview】\n${overview}`] : []),
      `【CONTRIBUTION INVENTORY（第一步抽取）】\n${inventoryJson}`,
      ...(supportBlocks.length > 0 ? [`【Supporting sections full text】\n${supportBlocks.join("\n\n")}`] : []),
      renderPoolMaterial(pool),
      `【Task】\n${compareInstruction(pool.cutoffDate)}`,
    ].join("\n\n");
    const compareOutcome = await withParseRetry(
      (retry) =>
        callAgent({
          prompt: retry ? `${comparePrompt}\n\n${FORMAT_REMINDER}` : comparePrompt,
          contextScope: "review/contribution/compare",
          pass: "contribution-compare",
        }),
      (output) => parseComparisonsOutput(output),
    );
    const comparisonsRaw = parseComparisonsOutput(compareOutcome.value);

    let comparisons: ContributionComparison[] = comparisonsRaw.comparisons.map((comparison) => {
      const nearestPriorWorks: PriorWorkRef[] = comparison.nearestPriorWorks
        .filter((ref) => ref.title !== "")
        .map((ref) => {
          const resolved = resolvePriorWorkRef(ref, pool);
          const yearViolation = isCutoffViolation(ref.year, pool.cutoffDate);
          if (yearViolation) {
            guards.cutoffViolations += 1;
          }
          if (resolved === null && ref.sourceLevel !== "model_memory") {
            guards.unresolvedPriorWorkRefs += 1;
          }
          const resolvedContentLevel = resolved?.contentLevel;
          const sourceLevel: PriorWorkSourceLevel =
            ref.sourceLevel ??
            (resolvedContentLevel === "abstract" ? "pool_abstract" : resolvedContentLevel === "metadata" ? "pool_metadata" : "model_memory");
          return {
            candidateId: resolved?.candidateId ?? ref.candidateId,
            title: resolved?.title ?? ref.title,
            year: ref.year ?? resolved?.year,
            doi: ref.doi ?? resolved?.doi,
            arxivId: ref.arxivId ?? resolved?.arxivId,
            sourceLevel,
            quote: ref.quote,
            resolvesToPool: resolved !== null,
            ...(yearViolation ? { timeCausalityViolation: true } : {}),
          };
        });
      return { ...comparison, nearestPriorWorks };
    });
    const statusResult = enforceStatusRules(comparisons);
    comparisons = statusResult.comparisons;
    guards.statusRuleViolations = statusResult.violations.length;

    // ---- Call 3：findings + gapPlan 综合 ----
    const comparisonsJson = JSON.stringify(comparisons).slice(0, COMPARISONS_JSON_MAX_CHARS);
    const synthesizePrompt = [
      ...(overview !== "" ? [`【Manuscript overview】\n${overview}`] : []),
      `【CONTRIBUTION INVENTORY】\n${inventoryJson}`,
      `【PRIOR-WORK COMPARISONS（已通过确定性守卫：锚校验/身份解析/时间因果/四态规则）】\n${comparisonsJson}`,
      `【Task】\n${SYNTHESIZE_INSTRUCTION}`,
    ].join("\n\n");
    const synthesizeOutcome = await withParseRetry(
      (retry) =>
        callAgent({
          prompt: retry ? `${synthesizePrompt}\n\n${FORMAT_REMINDER}` : synthesizePrompt,
          contextScope: "review/contribution/synthesize",
          pass: "contribution-synthesize",
        }),
      (output) => parseSynthesisOutput(output),
    );
    const synthesis = parseSynthesisOutput(synthesizeOutcome.value);

    const validSectionIds = new Set(document.sections.map((s) => s.sectionId));
    const findings: ContributionAuditFinding[] = [];
    for (const candidate of synthesis.findings) {
      if (candidate.message === "" || !validSectionIds.has(candidate.sectionId)) {
        guards.droppedFindings += 1;
        continue;
      }
      const finding = createFinding({
        findingId: `ca-${input.runId}-${findings.length + 1}`,
        category: candidate.category,
        severity: candidate.severity,
        sectionId: candidate.sectionId,
        ...(candidate.claimText !== undefined ? { claimText: candidate.claimText } : {}),
        message: candidate.message,
        ...(candidate.evidenceGap !== undefined ? { evidenceGap: candidate.evidenceGap } : {}),
        ...(candidate.suggestion !== undefined ? { suggestion: candidate.suggestion } : {}),
        source: "contribution-audit",
        now: this.now().toISOString(),
      });
      const extended = finding as ContributionAuditFinding;
      if (candidate.contributionId !== undefined) extended.contributionId = candidate.contributionId;
      if (candidate.confidence !== undefined) extended.confidence = candidate.confidence;
      if (candidate.priorWorkTitles !== undefined) extended.priorWorkTitles = candidate.priorWorkTitles;
      const comparison = comparisons.find((c) => c.contributionId === candidate.contributionId);
      if (comparison !== undefined) extended.comparisonStatus = comparison.status;
      findings.push(extended);
    }
    const gapPlan = synthesis.gapPlan.filter((item) => item.gap !== "" && item.contributionId !== "");

    let manuscriptCharsIncluded = keyChars + supportChars;
    if (manuscriptCharsIncluded > manuscriptCharsTotal) {
      manuscriptCharsIncluded = manuscriptCharsTotal;
    }
    const coverage: ContributionCoverageLedger = {
      sectionsTotal: document.sections.length,
      sectionsIndexed,
      sectionsIncludedFullText: sectionsIncluded.size,
      manuscriptCharsTotal,
      manuscriptCharsIncluded,
      truncations,
    };

    const artifact: ContributionAuditArtifact = {
      schemaVersion: CONTRIBUTION_AUDIT_SCHEMA_VERSION,
      ...(input.venueId !== undefined ? { venueId: input.venueId } : {}),
      documentType: input.documentType,
      promptVersion: CONTRIBUTION_AUDIT_PROMPT_VERSION,
      evaluatedAt: this.now().toISOString(),
      ...(input.manuscriptRevision !== undefined ? { manuscriptRevision: input.manuscriptRevision } : {}),
      priorWork: {
        cutoffDate: pool.cutoffDate,
        poolFingerprint,
        poolSize: pool.candidates.length,
        queriesUsed: pool.queriesUsed,
        candidates: pool.candidates,
      },
      inventory,
      comparisons,
      gapPlan,
      findings,
      coverage,
      guards,
      inputFingerprint: {
        manuscriptSha256: sha256Hex(documentText).slice(0, 16),
        poolFingerprint,
        promptVersion: CONTRIBUTION_AUDIT_PROMPT_VERSION,
        documentType: input.documentType,
        ...(input.venueId !== undefined ? { venueId: input.venueId } : {}),
      },
      provenance: { basis: "model_judgment_advisory", disclaimer: DISCLAIMER },
    };

    const dir = this.researchDir(input.projectId);
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "target-contribution-audit.json"), JSON.stringify(artifact, null, 1), "utf8");

    return {
      artifact,
      telemetry,
      extractParseFailed: extractOutcome.parseFailed,
      compareParseFailed: compareOutcome.parseFailed,
      synthesizeParseFailed: synthesizeOutcome.parseFailed,
      extractRetried: extractOutcome.retried,
      compareRetried: compareOutcome.retried,
      synthesizeRetried: synthesizeOutcome.retried,
    };
  }
}
