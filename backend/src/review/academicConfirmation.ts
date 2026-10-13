/**
 * Academic Score Confirmation（M13 Final Closure，任务 B）：有界、带触发条件、可解释的
 * Reviewer 方差复核——不是盲目多数投票，也不是无条件取平均。
 *
 * 事实基础：M11.3 对同一冻结稿 5 次独立采样 academicScore 75–84（σ 3.3，阈值 80 落在分布
 * 中心 → 单次 PASS/FAIL 是抛硬币）；fact verdict 对同一 claim 26/26 一致（稳定），finding
 * 枚举不稳定；M13.7.11 同一 rev-1 三次 review PASS / FAIL(1) / FAIL(2 major + 79)。
 *
 * 机制（确定性部分在本模块；采样调用在 review.run stage）：
 * 1. 触发：主 academic 采样的 overallScore 落在阈值的对称带内
 *    [threshold − band, threshold + band)（缺省 band=5 → 75–84），且 band > 0、extraSamples > 0。
 *    对称带 = 不偏向 PASS 也不偏向 FAIL（只在 FAIL 侧重采是统计上的偏倚）。
 * 2. 上限：每轮至多 extraSamples（缺省 2）次额外独立 academic 采样 → 同一冻结稿最多 3 份。
 * 3. 分数：取全部样本 overallScore 的**中位数**作为 gate 输入；全部样本逐条落盘。
 * 4. 事实问题分层：额外样本的 critical / major finding 中——
 *    - fact / evidence_gap / citation / build 类（稳定事实错误类）**并入**问题集（任何一次采样
 *      发现的事实错误都不因其它样本未发现而被忽略）；
 *    - academic / style 类（学术意见）只有在 ≥ 2 份样本于同一章节都给出 critical / major 时才并入
 *      （单份样本的意见级 major 不阻断 Final）。主样本自身的 finding 全部保留（现状不回退）。
 *    minor 只保留主样本（不膨胀 minor 列表）。
 * 5. 不触及：Revision Task Success 与 Publication Readiness 的双层判定、M11.4 的任何不变量、
 *    Quality Gate 的阈值与规则集。
 */

import type { ModeReviewResult, ReviewIssue } from "../agents/ReviewerService.js";

export interface AcademicConfirmationPolicy {
  /** 对称触发带宽（分）；0 = 关闭 */
  band: number;
  /** 额外采样上限（份）；0 = 关闭 */
  extraSamples: number;
  threshold: number;
}

export interface AcademicConfirmationSample {
  index: number;
  taskId: string;
  overallScore: number | null;
  critical: number;
  major: number;
  minor: number;
}

export interface AcademicScoreConfirmation {
  triggered: boolean;
  reason: string;
  threshold: number;
  band: number;
  primaryScore: number | null;
  samples: AcademicConfirmationSample[];
  /** 中位数（triggered=false 时等于 primaryScore） */
  aggregatedScore: number | null;
  method: "primary_only" | "median_of_samples";
  /** 从额外样本并入的 critical / major finding 数（按类别分层） */
  mergedIssues: { factClass: number; opinionClassReproduced: number; opinionClassDropped: number };
}

export const DEFAULT_ACADEMIC_CONFIRMATION_BAND = 5;
export const DEFAULT_ACADEMIC_CONFIRMATION_SAMPLES = 2;
export const ACADEMIC_CONFIRMATION_SAMPLES_MAX = 2;

/** 稳定事实错误类（任何一次采样发现即并入） */
const FACT_CLASS_CATEGORIES: ReadonlySet<string> = new Set(["fact", "evidence_gap", "citation", "build"]);

export function shouldConfirmAcademicScore(score: number | null | undefined, policy: AcademicConfirmationPolicy): boolean {
  if (policy.band <= 0 || policy.extraSamples <= 0) {
    return false;
  }
  if (typeof score !== "number" || Number.isNaN(score)) {
    return false; // 分数缺失 = 结构化输出问题，由 gate 的 null 规则处理，不是方差问题
  }
  return score >= policy.threshold - policy.band && score < policy.threshold + policy.band;
}

export function medianScore(scores: readonly number[]): number | null {
  const sorted = scores.filter((value) => typeof value === "number" && !Number.isNaN(value)).sort((a, b) => a - b);
  if (sorted.length === 0) {
    return null;
  }
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.round(((sorted[mid - 1]! + sorted[mid]!) / 2) * 10) / 10;
}

function normalizeSection(section: string): string {
  return section.replace(/\\/g, "/").split("/").pop()!.replace(/\.tex$/i, "").trim().toLowerCase();
}

function issueKey(issue: ReviewIssue): string {
  return `${issue.category}|${issue.section}|${issue.description}`;
}

function sampleOf(result: ModeReviewResult, index: number): AcademicConfirmationSample {
  return {
    index,
    taskId: result.taskId,
    overallScore: typeof result.overallScore === "number" ? result.overallScore : null,
    critical: result.issues.filter((issue) => issue.severity === "critical").length,
    major: result.issues.filter((issue) => issue.severity === "major").length,
    minor: result.issues.filter((issue) => issue.severity === "minor").length,
  };
}

/**
 * 把主样本与额外样本聚合为一份 academic ModeReviewResult（纯函数）。
 * 返回的 result 可直接替换 reviewAll 结果中的 academic 条目送入 aggregateReviews。
 */
export function aggregateAcademicSamples(params: {
  primary: ModeReviewResult;
  extras: readonly ModeReviewResult[];
  policy: AcademicConfirmationPolicy;
}): { result: ModeReviewResult; confirmation: AcademicScoreConfirmation } {
  const { primary, extras, policy } = params;
  const primaryScore = typeof primary.overallScore === "number" ? primary.overallScore : null;
  const samples = [sampleOf(primary, 0), ...extras.map((extra, index) => sampleOf(extra, index + 1))];
  if (extras.length === 0) {
    return {
      result: primary,
      confirmation: {
        triggered: false,
        reason: shouldConfirmAcademicScore(primaryScore, policy)
          ? "触发条件成立但未提供额外样本"
          : `主样本分数 ${primaryScore ?? "null"} 不在复核带 [${policy.threshold - policy.band}, ${policy.threshold + policy.band}) 内`,
        threshold: policy.threshold,
        band: policy.band,
        primaryScore,
        samples,
        aggregatedScore: primaryScore,
        method: "primary_only",
        mergedIssues: { factClass: 0, opinionClassReproduced: 0, opinionClassDropped: 0 },
      },
    };
  }
  const aggregatedScore = medianScore(samples.map((sample) => sample.overallScore).filter((value): value is number => value !== null));
  // finding 分层并入
  const seen = new Set(primary.issues.map(issueKey));
  const merged: ReviewIssue[] = [...primary.issues];
  const counts = { factClass: 0, opinionClassReproduced: 0, opinionClassDropped: 0 };
  const allSamples = [primary, ...extras];
  const severeBySample = allSamples.map(
    (sample) =>
      new Set(
        sample.issues
          .filter((issue) => issue.severity === "critical" || issue.severity === "major")
          .filter((issue) => !FACT_CLASS_CATEGORIES.has(issue.category))
          .map((issue) => normalizeSection(issue.section)),
      ),
  );
  extras.forEach((extra, extraIndex) => {
    for (const issue of extra.issues) {
      if (issue.severity !== "critical" && issue.severity !== "major") {
        continue; // minor 只保留主样本
      }
      const key = issueKey(issue);
      if (seen.has(key)) {
        continue;
      }
      if (FACT_CLASS_CATEGORIES.has(issue.category)) {
        seen.add(key);
        merged.push({ ...issue, reason: `${issue.reason ?? ""}${issue.reason ? "；" : ""}[带内复核样本 ${extraIndex + 1} 发现的事实类问题，并入]`.trim() });
        counts.factClass += 1;
        continue;
      }
      // 意见类：同一章节在 ≥ 2 份样本中都出现 critical / major 才并入
      const section = normalizeSection(issue.section);
      const reproducedBy = severeBySample.filter((set, sampleIndex) => sampleIndex !== extraIndex + 1 && set.has(section)).length;
      if (reproducedBy >= 1) {
        seen.add(key);
        merged.push({ ...issue, reason: `${issue.reason ?? ""}${issue.reason ? "；" : ""}[带内复核：同章节 ${reproducedBy + 1} 份样本重现的意见级问题，并入]`.trim() });
        counts.opinionClassReproduced += 1;
      } else {
        counts.opinionClassDropped += 1;
      }
    }
  });
  const result: ModeReviewResult = {
    ...primary,
    ...(aggregatedScore !== null ? { overallScore: aggregatedScore } : {}),
    issues: merged,
    summary: `${primary.summary}（带内复核：${samples.length} 份样本分数 ${samples.map((sample) => sample.overallScore ?? "null").join("/")}，中位数 ${aggregatedScore ?? "null"}）`,
  };
  return {
    result,
    confirmation: {
      triggered: true,
      reason: `主样本分数 ${primaryScore ?? "null"} 落在复核带 [${policy.threshold - policy.band}, ${policy.threshold + policy.band}) 内，追加 ${extras.length} 份独立采样取中位数`,
      threshold: policy.threshold,
      band: policy.band,
      primaryScore,
      samples,
      aggregatedScore,
      method: "median_of_samples",
      mergedIssues: counts,
    },
  };
}
