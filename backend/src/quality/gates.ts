/**
 * Build Gate 与 Quality Gate（M3.2，D-0015）。
 *
 * Build Gate：文档能否构建（编译结果 / include 文件存在 / bib 可用）。
 * Quality Gate：论文质量能否进入 Final（确定性判定器，消费 Review /
 * Citation / Evidence / Feasibility 的结构化结果；不使用 LLM 自评数值
 * confidence 做核心依据）。
 *
 * 规则（PRD §9.5 默认，阈值可配置）：
 *   Draft：只要求 Build Gate 通过。
 *   Final：Build Gate + Quality Gate 全部通过。
 */

import type { CitationReport } from "../citation/CitationService.js";
import type { EvidenceStats } from "../evidence/EvidenceStore.js";
import type { FeasibilityReport } from "../agents/FeasibilityService.js";
import type { ReviewSummary } from "../review/ReviewAggregator.js";
import type { LatexCompileResult, LatexCompiler } from "../latex/LatexCompiler.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { collectLatexFiles } from "../manuscript/LatexFiles.js";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { writeJsonAtomic } from "../util/atomic.js";

// ---- Build Gate ----

export interface BuildGateInput {
  compile: LatexCompileResult;
  /** collectLatexFiles 的 warnings（缺失 include 等） */
  missingIncludes: readonly string[];
  /** 使用了 \bibliography 但 bib 缺失 */
  bibMissing: boolean;
}

export interface BuildGateResult {
  passed: boolean;
  reasons: string[];
  checkedAt: string;
}

/**
 * Build Gate 判定（确定性）。注意：不包含任何质量语义 ——
 * not_found citation、文风、评分等问题永远不影响本判定（D-0015）。
 */
export function evaluateBuildGate(input: BuildGateInput): BuildGateResult {
  const reasons: string[] = [];
  if (!input.compile.ok) {
    reasons.push(input.compile.error ?? "LaTeX 编译失败");
  }
  for (const missing of input.missingIncludes) {
    reasons.push(missing);
  }
  if (input.bibMissing) {
    reasons.push("main.tex 使用了 \\bibliography 但未找到 references.bib");
  }
  return { passed: reasons.length === 0, reasons, checkedAt: new Date().toISOString() };
}

/** 编译 + 结构检查 + Build Gate 判定（Draft PDF 产出由 compile 负责） */
export async function runBuildGate(
  projects: ProjectStore,
  latex: LatexCompiler,
  projectId: string,
): Promise<{ build: BuildGateResult; compile: LatexCompileResult }> {
  const files = await collectLatexFiles(projects.manuscriptDir(projectId));
  const missingIncludes = files.warnings.filter((warning) => warning.includes("无法读取"));
  const bibMissing =
    files.mainTex !== null &&
    /\\(bibliography|addbibresource)\{/.test(files.mainTex.content) &&
    files.bibPath === null;

  let compile: LatexCompileResult;
  try {
    compile = await latex.compile({
      manuscriptDir: projects.manuscriptDir(projectId),
      buildDir: projects.buildDir(projectId),
    });
  } catch (error) {
    // 工具缺失 / 编译失败 / 超时 → 结构化编译失败结果（Build Gate 如实失败）
    compile = {
      ok: false,
      tool: "unknown",
      exitCode: null,
      pdfPath: null,
      logPath: null,
      durationMs: 0,
      error: error instanceof Error ? error.message : String(error),
    };
  }
  const build = evaluateBuildGate({ compile, missingIncludes, bibMissing });
  return { build, compile };
}

// ---- Quality Gate ----

export interface QualityGateThresholds {
  academicPassScore: number;
  styleRiskMax: number;
  /** 允许进入 Final 的最低可行性档位（HIGH / MEDIUM） */
  requireFeasibility: boolean;
}

export const DEFAULT_QUALITY_THRESHOLDS: QualityGateThresholds = {
  academicPassScore: 80,
  styleRiskMax: 35,
  requireFeasibility: true,
};

export interface QualityGateInput {
  review: ReviewSummary;
  citation: CitationReport | null;
  evidence: EvidenceStats;
  feasibility: FeasibilityReport | null;
  /** HITL 明示接受已知差距（仍按目标标准执行，仅降低口径说明；不改判定） */
  acceptedKnownGaps?: boolean;
}

export interface QualityGateResult {
  passed: boolean;
  reasons: string[];
  rules: { rule: string; passed: boolean; detail: string }[];
  thresholds: QualityGateThresholds;
  checkedAt: string;
}

/** Quality Gate 判定（确定性；Draft 不经过本判定） */
export function evaluateQualityGate(
  input: QualityGateInput,
  thresholds: QualityGateThresholds = DEFAULT_QUALITY_THRESHOLDS,
): QualityGateResult {
  const rules: { rule: string; passed: boolean; detail: string }[] = [];

  // 1. hallucinated citation（metadata 权威 not_found）
  const hallucinated = input.citation?.summary.hallucinated ?? 0;
  rules.push({
    rule: "hallucinated_citations_zero",
    passed: hallucinated === 0,
    detail: `metadata not_found 引用 ${hallucinated} 条`,
  });

  // 2. 引用结构完整（\cite 有 bib 对应、无重复 key、无坏引用）
  const missingKeys = input.citation?.summary.missingKeys ?? 0;
  const duplicateKeys = input.citation?.summary.duplicateKeys ?? 0;
  const badCitations = input.citation?.summary.badCitations ?? 0;
  rules.push({
    rule: "citation_structure_valid",
    passed: missingKeys === 0 && duplicateKeys === 0 && badCitations === 0,
    detail: `missing=${missingKeys} duplicate=${duplicateKeys} bad=${badCitations}`,
  });

  // 3. 无矛盾证据（contradictory evidence）
  rules.push({
    rule: "no_contradictory_evidence",
    passed: input.evidence.contradictory === 0,
    detail: `contradictory evidence ${input.evidence.contradictory} 条`,
  });

  // 4. unsupported / contradicted 关键 claim = 0
  const unsupported = input.review.unsupportedCriticalClaims ?? 0;
  rules.push({
    rule: "unsupported_critical_claims_zero",
    passed: unsupported === 0,
    detail: `UNSUPPORTED/CONTRADICTED claim ${unsupported} 条`,
  });

  // 5. blocking review issue = 0
  rules.push({
    rule: "blocking_issues_zero",
    passed: input.review.counts.blocking === 0,
    detail: `blocking issue ${input.review.counts.blocking} 条`,
  });

  // 6. 未解决的 critical / major = 0
  rules.push({
    rule: "open_critical_major_zero",
    passed: input.review.openCritical === 0 && input.review.openMajor === 0,
    detail: `critical=${input.review.openCritical} major=${input.review.openMajor}`,
  });

  // 7. academic score ≥ 阈值（缺失评分视为不通过——不能因没评就通过）
  const academic = input.review.scores.academicScore;
  rules.push({
    rule: "academic_score_threshold",
    passed: academic !== null && academic >= thresholds.academicPassScore,
    detail:
      academic === null
        ? "缺少 academic 评分"
        : `academicScore=${academic}（要求 ≥ ${thresholds.academicPassScore}）`,
  });

  // 8. style risk ≤ 阈值
  const styleRisk = input.review.scores.styleRisk;
  rules.push({
    rule: "style_risk_threshold",
    passed: styleRisk !== null && styleRisk <= thresholds.styleRiskMax,
    detail:
      styleRisk === null ? "缺少 style 风险评分" : `styleRisk=${styleRisk}（要求 ≤ ${thresholds.styleRiskMax}）`,
  });

  // 9. 目标可行性达标（LOW / INSUFFICIENT 阻止 Final；用户知情接受不降低标准）
  const feasibility = input.feasibility;
  const feasibilityOk =
    !thresholds.requireFeasibility ||
    feasibility === null ||
    feasibility.level === "HIGH" ||
    feasibility.level === "MEDIUM";
  rules.push({
    rule: "target_feasibility",
    passed: feasibilityOk,
    detail: feasibility === null ? "未评估（跳过）" : `feasibility=${feasibility.level}`,
  });

  const reasons = rules.filter((rule) => !rule.passed).map((rule) => `${rule.rule}: ${rule.detail}`);
  return {
    passed: reasons.length === 0,
    reasons,
    rules,
    thresholds,
    checkedAt: new Date().toISOString(),
  };
}

/** Quality Gate 结果落盘（reviews/quality-gate-<round>.json） */
export async function saveQualityGateReport(
  projects: ProjectStore,
  projectId: string,
  round: number,
  result: QualityGateResult,
  summary: ReviewSummary,
): Promise<string> {
  const dir = projects.reviewsDir(projectId);
  await mkdir(dir, { recursive: true });
  const file = `quality-gate-r${round}.json`;
  await writeJsonAtomic(join(dir, file), { gate: result, reviewSummary: summary });
  return `reviews/${file}`;
}
