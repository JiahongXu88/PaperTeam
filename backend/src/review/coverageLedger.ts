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
  const failedUnitIds: string[] = [];
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
      failedUnitIds.push(record.unitId);
    }
  }
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
