/**
 * Review Coverage Ledger（M14.1a P0-2，纯确定性，无 LLM）。
 *
 * 长文档 review 的覆盖语义在此固化：
 *  - `buildReviewCoveragePlan`：把稿件文件切成不相交、连续、拼接零丢失的
 *    Review Units（复用 P0-1 的 locateFileSpans / partitionSpanIntoUnits——同一
 *    套 span/单元基础设施），并给全文档一个 snapshotId（文件哈希指纹）。
 *  - `digestIsLossy`：判定既有单 digest 路径（每节 3600 / 总 60k / ≤24 文件）
 *    是否结构性丢正文；有损 → review.run 切换到 per-unit 模式。
 *  - `computeReviewCoverage`：只把「实际完成审查」的单元计入覆盖——完成记录
 *    必须与计划同 snapshotId、同单元内容指纹（文档变了 → 旧结果不计数，
 *    不被误用）。单元彼此不相交，重叠上下文（如注入的相邻文本）从不计入
 *    targetChars，覆盖率不可能因此虚高。
 *
 * 100% coverage 的含义：计划纳入审查的目标正文范围全部由成功完成的 Review
 * Unit 覆盖。它不证明模型理解了全部内容，也不代表学术质量合格——那由
 * Quality Gate 的其余规则独立判定。
 */

import { fingerprintJson } from "../util/hash.js";
import type { ReviewContextSnapshotRecord, ReviewUnitContextPolicy } from "./reviewContextSnapshot.js";
import { locateFileSpans, partitionSpanIntoUnits } from "./logicalSpan.js";
import { revisionSourceHash } from "./revisionScope.js";

/** 既有 digest 路径的结构化预算（definitions.ts buildManuscriptDigest 同口径） */
export const SECTION_DIGEST_BUDGET = 3_600;
export const DIGEST_TOTAL_BUDGET = 60_000;
export const DIGEST_MAX_SECTION_FILES = 24;

export interface ReviewUnitPlanEntry {
  /** 稳定单元 id：`${file}::${spanLogicalSection}`（partition 内单元已含 #uN） */
  unitId: string;
  file: string;
  spanId: string;
  heading: string;
  unitIndex: number;
  unitCount: number;
  chars: number;
  contentHash: string;
}

export interface ReviewCoveragePlan {
  snapshotId: string;
  createdAt: string;
  maxUnitChars: number;
  files: Array<{ file: string; chars: number; hash: string }>;
  units: ReviewUnitPlanEntry[];
  targetChars: number;
}

export interface ReviewUnitOutcome {
  /** 该单元审查产出的 ReviewIssue（与 ReviewerService 契约同构；复用时恢复） */
  issues: Array<Record<string, unknown>>;
  academicScore: number | null;
  riskScore: number | null;
  summary: string;
}

export interface ReviewUnitRecord {
  unitId: string;
  round: number;
  /** 必须等于计划的 snapshotId 才可复用 / 计入覆盖 */
  snapshotId: string;
  /** 单元内容指纹（= 对应 plan entry 的 contentHash） */
  unitFingerprint: string;
  status: "completed" | "failed";
  taskId?: string;
  issueCount?: number;
  error?: string;
  attempts?: number;
  /** 完成记录的完整产物（复用时 issues / 分数不丢失） */
  outcome?: ReviewUnitOutcome;
  updatedAt: string;
  /**
   * M14.8.1-MOT：审稿请求指纹（ReviewerService.unitRequestFingerprint：完整 prompt + 模型 +
   * Skill 版本）。跨轮复用的唯一键；旧记录缺省 = 不可证明一致，不跨轮复用。
   */
  requestFingerprint?: string;
  /** M14.8.1-MOT：本记录是跨轮合法缓存（来源轮次与来源记录时间） */
  reusedFrom?: { round: number; updatedAt: string; taskId?: string };
  /** M14.8.1-MOT：写入时的增量处置（同轮 journal 恢复时沿用，账本不失真） */
  disposition?: IncrementalUnitDisposition;
  /** M14.9.5.1：产生本记录的单元上下文策略（缺省 = shared_session 旧记录） */
  contextPolicy?: ReviewUnitContextPolicy;
  /** M14.9.5.1：隔离策略下本单元送审输入的上下文快照（依赖原文由 sha256 绑定，不内联） */
  contextSnapshot?: ReviewContextSnapshotRecord;
  /** M14.9.5.1：逐次尝试 trace（物理会话 / prompt 哈希 / 状态 / usage）；缓存与复用记录为空 */
  attemptTrace?: ReviewUnitAttemptTrace[];
}

/** M14.9.5.1：单元一次模型尝试的可核对记录（同一单元各次尝试的 promptSha256 / contextSnapshotHash 必须一致） */
export interface ReviewUnitAttemptTrace {
  attempt: number;
  sessionKey: string;
  promptSha256: string;
  contextSnapshotHash: string;
  status: "completed" | "failed";
  taskId?: string;
  model?: string;
  usage?: Record<string, unknown>;
  error?: string;
  startedAt: string;
  ms: number;
}

/** M14.9.5.1：本轮单元上下文的汇总（隔离策略才有；依赖缺口如实呈现，不计入覆盖率字符） */
export interface ReviewContextCoverage {
  policy: ReviewUnitContextPolicy;
  sourceVerification: string;
  dependencyBudgetChars: number;
  unitsWithDependencies: number;
  attachedDependencies: number;
  /** M14.9.5.4：其中隐式依赖（共有实体 / 反向引用的最小片段）的数量；旧产物无此字段 */
  implicitDependencies?: number;
  dependencyChars: number;
  /** 有依赖缺口（未解析 / 歧义 / 超预算 / 策略不附）的单元：相关跨单元核对 NOT_EVALUATED */
  contextIncompleteUnits: Array<{ unitId: string; gaps: Array<{ mention: string; status: string; reason: string }> }>;
  /** quote 只出现在依赖参考、不在本单元原文中的 finding 数（只标注，不删除） */
  referenceOnlyQuoteFindings: number;
  /** 同轮 journal 记录与当前上下文策略 / 快照不等价而未复用的单元（CACHE_INCOMPATIBLE） */
  cacheIncompatibleUnitIds: string[];
  crossChapter?: { sessionKey?: string; promptSha256?: string; status: "completed" | "failed" | "skipped"; error?: string };
}

/** M14.8.1-MOT：增量复审中单元的处置（Fresh / 合法缓存 / 依赖失效重审 / 未审） */
export type IncrementalUnitDisposition =
  | "fresh_changed"
  | "fresh_new"
  | "fresh_invalidated"
  | "fresh_no_valid_cache"
  | "cached"
  | "heading_only"
  | "failed";

export interface IncrementalReviewLedger {
  enabled: boolean;
  /** 比较基准轮（上一轮单元 journal）；null = 无可比基准 */
  baselineRound: number | null;
  changedUnitIds: string[];
  removedUnitIds: string[];
  /** 未改动但因依赖失效必须重审的单元及原因 */
  invalidated: Array<{ unitId: string; reason: string }>;
  dispositions: Array<{ unitId: string; disposition: IncrementalUnitDisposition; sourceRound?: number }>;
  freshUnits: number;
  cachedUnits: number;
  invalidatedUnits: number;
  /** 跨章一致性审查恒为本轮新执行（不缓存） */
  crossChapterFresh: boolean;
  /** 禁用 / 降级原因（如 runtime 无法证明模型一致） */
  note?: string;
}

const SUMMARY_HEADING_PATTERN = /(摘要|引言|绪论|前言|结论|总结|结语|讨论|展望|贡献|局限|abstract|introduction|conclusion|discussion|summary|contribution|limitation)/i;
const SUMMARY_LABEL_PATTERN = /^sec:(intro|introduction|conclusion|conclusions|discussion|summary|contrib)/i;
const LATEX_LABEL_PATTERN = /\\label\{([^{}]+)\}/g;
const LATEX_REF_PATTERN = /\\(?:ref|eqref|autoref|cref|Cref|pageref|nameref)\*?\{([^{}]+)\}/g;

/**
 * M14.8.1-MOT：增量复审的保守依赖失效（纯函数）。
 *
 * 只改了少数章节时，未改动单元的既往审查可复用——但以下单元即使原文未变也必须重审：
 * 1. 汇总型单元（摘要 / 引言 / 讨论 / 结论 / 贡献 / 局限所在的顶层章节，含其子节）：
 *    它们复述全文主张，任何正文改动都可能使其与正文产生新冲突；
 * 2. 引用了改动单元内定义的 \label（表 / 图 / 公式 / 章节）的单元：其论述依赖被改内容。
 * 基准是上一轮 journal 的单元内容指纹；无基准 → 全部视为改动（等价全量审）。
 */
export function planIncrementalInvalidation(input: {
  units: ReadonlyArray<{ unitId: string; spanId: string; heading: string; contentHash: string; text: string }>;
  baselineHashes: ReadonlyMap<string, string> | null;
}): { changed: Set<string>; removed: string[]; invalidated: Map<string, string> } {
  const changed = new Set<string>();
  const invalidated = new Map<string, string>();
  if (input.baselineHashes === null) {
    for (const unit of input.units) changed.add(unit.unitId);
    return { changed, removed: [], invalidated };
  }
  const currentIds = new Set(input.units.map((unit) => unit.unitId));
  const removed = [...input.baselineHashes.keys()].filter((unitId) => !currentIds.has(unitId));
  for (const unit of input.units) {
    if (input.baselineHashes.get(unit.unitId) !== unit.contentHash) changed.add(unit.unitId);
  }
  const anyChange = changed.size > 0 || removed.length > 0;
  if (!anyChange) return { changed, removed, invalidated };
  const changedLabels = new Set<string>();
  for (const unit of input.units) {
    if (!changed.has(unit.unitId)) continue;
    for (const match of unit.text.matchAll(LATEX_LABEL_PATTERN)) changedLabels.add(match[1]!.trim());
  }
  let topHeading = "";
  let topSpanId = "";
  for (const unit of input.units) {
    if (/^\s*\\(?:chapter|section)\*?\{/.test(unit.text) || unit.spanId === "frontmatter") {
      topHeading = unit.heading;
      topSpanId = unit.spanId;
    }
    if (changed.has(unit.unitId)) continue;
    const summary = unit.spanId === "frontmatter" || topSpanId === "frontmatter" ||
      SUMMARY_HEADING_PATTERN.test(topHeading) || SUMMARY_LABEL_PATTERN.test(topSpanId) ||
      SUMMARY_HEADING_PATTERN.test(unit.heading) || SUMMARY_LABEL_PATTERN.test(unit.spanId);
    if (summary) {
      invalidated.set(unit.unitId, `summary_unit（${topHeading || unit.heading}）：正文有改动，汇总型单元必须重审`);
      continue;
    }
    const refs = [...unit.text.matchAll(LATEX_REF_PATTERN)].flatMap((match) => match[1]!.split(",").map((ref) => ref.trim()));
    const dependency = refs.find((ref) => changedLabels.has(ref));
    if (dependency !== undefined) invalidated.set(unit.unitId, `ref_dependency（\\ref{${dependency}} 指向改动单元）`);
  }
  return { changed, removed, invalidated };
}

export interface ReviewCoverageSummary {
  mode: "digest" | "units";
  snapshotId: string;
  round: number;
  targetUnits: number;
  completedUnits: number;
  failedUnits: number;
  reusedUnits: number;
  targetChars: number;
  /** 仅计入 status=completed 且 snapshotId / 指纹匹配的单元 */
  reviewedChars: number;
  ratio: number;
  complete: boolean;
  failedUnitIds: string[];
  /** M14.8.1-MOT：增量复审账本（Fresh / 合法缓存 / 依赖失效 / 未审；缺省 = 旧产物或 digest 模式） */
  incremental?: IncrementalReviewLedger;
  /** M14.9.5.1：单元上下文汇总（缺省 = shared_session 或 digest 模式） */
  context?: ReviewContextCoverage;
  /**
   * M14.9.5.2：跨章一致性审查的执行状态（units 模式；缺省 = 旧产物 / digest 模式）。failed = 本轮跨章核对 NOT_EVALUATED，
   * 「无跨章 finding」不代表无跨章冲突；skipped = 只有一个章节，不适用
   */
  crossChapter?: { status: "completed" | "failed" | "skipped"; error?: string };
  /** M14.9.5.2：shared_session 下同轮 journal 记录与当前请求指纹不一致而未复用的单元（隔离策略见 context.cacheIncompatibleUnitIds） */
  journalIncompatibleUnitIds?: string[];
}

/** 与 definitions.ts buildManuscriptDigest 相同的截面预算判定（不修改其输出） */
export function digestIsLossy(
  sectionFiles: ReadonlyArray<{ content: string }>,
  options?: { sectionBudget?: number; totalBudget?: number; maxFiles?: number },
): boolean {
  const sectionBudget = options?.sectionBudget ?? SECTION_DIGEST_BUDGET;
  const totalBudget = options?.totalBudget ?? DIGEST_TOTAL_BUDGET;
  const maxFiles = options?.maxFiles ?? DIGEST_MAX_SECTION_FILES;
  if (sectionFiles.length > maxFiles) return true;
  let total = 0;
  for (const file of sectionFiles) {
    if (file.content.length > sectionBudget) return true;
    total += Math.min(file.content.length, sectionBudget);
  }
  return total > totalBudget;
}

export function buildReviewCoveragePlan(
  files: ReadonlyArray<{ file: string; content: string }>,
  maxUnitChars: number,
): ReviewCoveragePlan {
  const fileEntries: ReviewCoveragePlan["files"] = [];
  const units: ReviewUnitPlanEntry[] = [];
  const snapshotInput: Record<string, string> = {};
  for (const entry of files) {
    const hash = revisionSourceHash(entry.content);
    fileEntries.push({ file: entry.file, chars: entry.content.length, hash });
    snapshotInput[entry.file] = hash;
    const spans = locateFileSpans(entry.file, entry.content);
    for (const span of spans) {
      const partition = partitionSpanIntoUnits(span, maxUnitChars);
      partition.units.forEach((unit, index) => {
        units.push({
          unitId: `${entry.file}::${unit.logicalSection}`,
          file: entry.file,
          spanId: span.logicalSection,
          heading: span.heading,
          unitIndex: index + 1,
          unitCount: partition.units.length,
          chars: unit.content.length,
          contentHash: unit.originalHash,
        });
      });
    }
  }
  return {
    snapshotId: fingerprintJson({ schema: "review-coverage-v1", files: snapshotInput }),
    createdAt: new Date().toISOString(),
    maxUnitChars,
    files: fileEntries,
    units,
    targetChars: units.reduce((sum, unit) => sum + unit.chars, 0),
  };
}

/** 只统计与当前计划真正对应的完成记录（snapshot + 单元指纹双绑定） */
export function computeReviewCoverage(
  plan: ReviewCoveragePlan,
  round: number,
  records: readonly ReviewUnitRecord[],
  mode: "digest" | "units" = "units",
): ReviewCoverageSummary {
  const charsByUnitId = new Map(plan.units.map((unit) => [unit.unitId, unit.chars]));
  let completedChars = 0;
  let completedUnits = 0;
  let reusedUnits = 0;
  const failedCandidates: string[] = [];
  const counted = new Set<string>();
  for (const record of records) {
    if (!charsByUnitId.has(record.unitId) || counted.has(record.unitId)) continue;
    if (record.snapshotId !== plan.snapshotId || record.unitFingerprint !== charsByUnitIdFingerprint(plan, record.unitId)) {
      continue; // 文档或单元内容已变化：旧结果不计入（也不得复用）
    }
    if (record.status === "completed") {
      counted.add(record.unitId);
      completedUnits += 1;
      completedChars += charsByUnitId.get(record.unitId) ?? 0;
      if (record.round !== round) reusedUnits += 1;
    } else if (record.status === "failed") {
      failedCandidates.push(record.unitId);
    }
  }
  // M14.8.1-MOT：同轮 stage 重试时旧 failed 记录排在新 completed 记录之前——单元已完成就
  // 不再同时计为失败（旧口径会让同一单元既计入完成又出现在 failedUnitIds）
  const failedUnitIds = [...new Set(failedCandidates.filter((unitId) => !counted.has(unitId)))];
  const targetChars = plan.targetChars;
  return {
    mode,
    snapshotId: plan.snapshotId,
    round,
    targetUnits: plan.units.length,
    completedUnits,
    failedUnits: failedUnitIds.length,
    reusedUnits,
    targetChars,
    reviewedChars: completedChars,
    ratio: targetChars === 0 ? 1 : completedChars / targetChars,
    complete: completedUnits === plan.units.length,
    failedUnitIds,
  };
}

function charsByUnitIdFingerprint(plan: ReviewCoveragePlan, unitId: string): string | undefined {
  return plan.units.find((unit) => unit.unitId === unitId)?.contentHash;
}

/** journal 文件名安全化（unitId 含路径与冒号） */
export function reviewUnitFileName(unitId: string): string {
  const safe = unitId.replace(/[^a-zA-Z0-9_-]+/g, "_").slice(0, 80);
  const suffix = fingerprintJson(unitId).slice(0, 8);
  return `${safe}.${suffix}.json`;
}
