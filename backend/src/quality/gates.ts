/**
 * Build Gate 与 Quality Gate（D-0015）。
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
import type { CitationSemanticMode } from "../citation/semanticMode.js";
import type { EvidenceStats } from "../evidence/EvidenceStore.js";
import type { FeasibilityReport } from "../agents/FeasibilityService.js";
import type { ReviewSummary } from "../review/ReviewAggregator.js";
import type { EvidenceCitationCoverage } from "./evidenceCitationCoverage.js";
import type { RevisionValidationResult } from "../review/revisionValidation.js";
import { countItemStatuses } from "../review/revisionValidation.js";
import { describeClaimStrengthFindings } from "./claimStrength.js";
import { describeCitationPreservation, type CitationPreservationSummary } from "./citationPreservation.js";
import { describeFactPreservation, type FactPreservationSummary } from "./factPreservation.js";
import type { LatexCompileResult, LatexCompiler } from "../latex/LatexCompiler.js";
import type { LatexDiagnostic } from "../latex/diagnostics.js";
import { parseLatexDiagnostics } from "../latex/diagnostics.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { collectLatexFiles } from "../manuscript/LatexFiles.js";
import { mkdir, readFile } from "node:fs/promises";
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

// ---- Build Gate 持久化记录（M4.7：Finalize 的新鲜度依据；Build UI 的数据源） ----

export const BUILD_GATE_RECORD_FILE = "build-gate.json";

/** build/build-gate.json 的结构（runBuildGateForRevision 写入） */
export interface BuildGateRecord {
  passed: boolean;
  reasons: string[];
  checkedAt: string;
  /** 编译时的 manuscript 修订（Finalize 校验：record.revision 必须等于当前 revision） */
  revision: number;
  compile: {
    ok: boolean;
    tool: string;
    durationMs: number;
    exitCode: number | null;
    pdfPath: string | null;
    logPath: string | null;
    error?: string;
  };
  /** 结构化编译诊断（失败时从 compile.log 解析；供 UI 摘要与 Writer 修复上下文） */
  diagnostics: LatexDiagnostic[];
}

/** 每项目编译互斥（并发编译同一项目会互相覆盖 build/ 输出；跨项目不受影响） */
const compileLocks = new Map<string, Promise<unknown>>();

/** 在项目编译锁内执行（per-project serial；失败不阻塞后续编译） */
export function withCompileLock<T>(projectId: string, task: () => Promise<T>): Promise<T> {
  const previous = compileLocks.get(projectId) ?? Promise.resolve();
  const next = previous.then(task, task);
  compileLocks.set(
    projectId,
    next.catch(() => undefined),
  );
  return next;
}

/**
 * 编译 + Build Gate 判定 + 落盘 build/build-gate.json（M4.7 主入口）。
 * - revision 由调用方传入（编译前读取的 manuscript 当前修订）；
 * - 编译在 per-project 锁内串行执行；
 * - 失败时解析 compile.log 为结构化诊断（文件 / 行号 / 错误 / 附近行）。
 */
export async function runBuildGateForRevision(
  projects: ProjectStore,
  latex: LatexCompiler,
  projectId: string,
  revision: number,
): Promise<{ build: BuildGateResult; compile: LatexCompileResult; record: BuildGateRecord }> {
  return withCompileLock(projectId, async () => {
    const { build, compile } = await runBuildGate(projects, latex, projectId);
    const diagnostics = await readCompileDiagnostics(projects, projectId);
    const record: BuildGateRecord = {
      passed: build.passed,
      reasons: build.reasons,
      checkedAt: build.checkedAt,
      revision,
      compile: {
        ok: compile.ok,
        tool: compile.tool,
        durationMs: compile.durationMs,
        exitCode: compile.exitCode,
        pdfPath: compile.pdfPath !== null ? "build/paper.pdf" : null,
        logPath: compile.logPath !== null ? "build/compile.log" : null,
        ...(compile.error !== undefined ? { error: compile.error } : {}),
      },
      diagnostics,
    };
    await mkdir(projects.buildDir(projectId), { recursive: true });
    await writeJsonAtomic(
      join(projects.buildDir(projectId), BUILD_GATE_RECORD_FILE),
      record,
    );
    return { build, compile, record };
  });
}

/** 读取已落盘的 Build Gate 记录（无 / 损坏 → null，防御性校验） */
export async function loadBuildGateRecord(
  projects: ProjectStore,
  projectId: string,
): Promise<BuildGateRecord | null> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(
      await readFile(join(projects.buildDir(projectId), BUILD_GATE_RECORD_FILE), "utf8"),
    );
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) {
    return null;
  }
  const record = parsed as Record<string, unknown>;
  if (
    typeof record["passed"] !== "boolean" ||
    !Array.isArray(record["reasons"]) ||
    typeof record["checkedAt"] !== "string" ||
    typeof record["revision"] !== "number" ||
    typeof record["compile"] !== "object" ||
    record["compile"] === null ||
    !Array.isArray(record["diagnostics"])
  ) {
    return null;
  }
  return parsed as BuildGateRecord;
}

/** 编译日志 → 结构化诊断（编译抛错时 LatexCompiler 仍已写出 compile.log） */
async function readCompileDiagnostics(
  projects: ProjectStore,
  projectId: string,
): Promise<LatexDiagnostic[]> {
  try {
    const log = await readFile(join(projects.buildDir(projectId), "compile.log"), "utf8");
    return parseLatexDiagnostics(log);
  } catch {
    return [];
  }
}

// ---- Quality Gate ----

export interface QualityGateThresholds {
  academicPassScore: number;
  styleRiskMax: number;
  /** 允许进入 Final 的最低可行性档位（HIGH / MEDIUM） */
  requireFeasibility: boolean;
  /**
   * M6.6：引用必须有对应 Verified Evidence 才放行（citations_evidence_backed
   * 规则参与阻断）。缺省 false——规则仍呈现覆盖计数（可检测），但未覆盖引用
   * 不阻断 Final（M6.6 刚接入，存量项目覆盖率必然低，冒进会全量误伤）。
   */
  requireEvidenceBackedCitations?: boolean;
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
  /** Citation Integrity Gate 输入（PDF Review 流程；缺省不启用这组规则） */
  citationIntegrity?: {
    probableFabricated: number;
    notFoundObligatory: number;
    unsupportedCritical: number;
    mismatchCritical: number;
    insufficientEvidence: number;
  };
  /**
   * 语义核验模式（与 citationIntegrity 配套）。off 时语义类 Gate 规则不参与——
   * 不能因为「本轮没有 semantic records」而 FAIL；缺省按 full 解释（历史行为）。
   */
  citationSemanticMode?: CitationSemanticMode;
  /**
   * Citation Preservation（M5.6）：被审阅修订相对前一修订的引用保持结果。
   * undefined = 调用方未计算（规则不出现，兼容纯单元输入）；null = 不可比较
   * （无前序修订等）→ 以 citation_preservation_not_applicable 中性呈现；
   * summary → citation_keys_preserved 参与判定。
   */
  citationPreservation?: CitationPreservationSummary | null;
  /**
   * Fact Preservation（M5.6）：被审阅修订相对前一修订的实验事实保持结果
   * （表格数值 / 正文数字 / 公式 / 方向结论 / 协议 / 占位回归）。
   * undefined = 调用方未计算（规则不出现）；null = 不可比较 →
   * fact_preservation_not_applicable 中性呈现；summary → fact_preservation 参与判定。
   */
  factPreservation?: FactPreservationSummary | null;
  /**
   * Evidence Citation Coverage（M6.6 §13）：正文引用 key ↔ Verified Evidence
   * 的覆盖结果。undefined = 调用方未计算（规则不出现）；提供了则呈现
   * citations_evidence_backed 规则（未覆盖计数可见；只有
   * requireEvidenceBackedCitations=true 时参与阻断）。
   */
  evidenceCitationCoverage?: EvidenceCitationCoverage;
  /**
   * Revision Validation（M6.7 §10 Revision Gate）：最近一次修订的条目级复核
   * 结果（Fact / Citation / Claim Strength / Evidence 再核验）。
   * undefined = 调用方未计算或无可比修订（规则不出现）；提供了则呈现
   * revision_items_resolved 与 claim_strength_guard 两条规则。用户在
   * hitl.revision_validation 的 approve 决策覆盖自动判定（记录在案，不静默）。
   */
  revisionValidation?: RevisionValidationResult;
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

  // 10-13. Citation Integrity（并入同一 Gate Engine，不另造平行体系）
  if (input.citationIntegrity !== undefined) {
    const integrity = input.citationIntegrity;
    // Layer 1（真实性 / metadata）规则始终参与——off 只关掉语义层
    rules.push({
      rule: "citation_fabrication_zero",
      passed: integrity.probableFabricated === 0,
      detail: `confirmed/probable fabricated ${integrity.probableFabricated} 条`,
    });
    rules.push({
      rule: "citation_not_found_obligatory_zero",
      passed: integrity.notFoundObligatory === 0,
      detail: `NOT_FOUND obligatory citation ${integrity.notFoundObligatory} 条（需人工判定）`,
    });
    rules.push({
      rule: "citation_metadata_mismatch_critical_zero",
      passed: integrity.mismatchCritical === 0,
      detail: `title/DOI 级 mismatch ${integrity.mismatchCritical} 条`,
    });
    // Layer 2（语义）规则只在语义核验开启时参与：off 时不因「没有 semantic records」
    // FAIL；contradiction_only 时 unsupportedCritical 天然只统计 CONTRADICTED
    const semanticMode = input.citationSemanticMode ?? "full";
    if (semanticMode === "off") {
      rules.push({
        rule: "citation_semantic_verification_off",
        passed: true,
        detail: "本轮未开启引用语义核验（语义类规则不参与判定）",
      });
    } else {
      rules.push({
        rule: "citation_unsupported_critical_zero",
        passed: integrity.unsupportedCritical === 0,
        detail: `critical claim UNSUPPORTED/CONTRADICTED ${integrity.unsupportedCritical} 条`,
      });
      // INSUFFICIENT_EVIDENCE ≠ fabricated：不阻断，要求补证据/人工复核
      rules.push({
        rule: "citation_insufficient_evidence_review",
        passed: true,
        detail: `INSUFFICIENT_EVIDENCE ${integrity.insufficientEvidence} 条（人工复核，不阻断）`,
      });
    }
  }

  // 14. Citation Preservation（M5.6 验收驱动）：修订不得无依据丢失既有引用
  if (input.citationPreservation !== undefined) {
    if (input.citationPreservation === null) {
      rules.push({
        rule: "citation_preservation_not_applicable",
        passed: true,
        detail: "无前序修订可比较（首轮 / 快照缺失 / 用户恢复历史修订）；引用保持规则不参与判定",
      });
    } else {
      rules.push({
        rule: "citation_keys_preserved",
        passed: input.citationPreservation.ok,
        detail: describeCitationPreservation(input.citationPreservation),
      });
    }
  }

  // 15. Fact Preservation（M5.6 第二层，pair-02 盲评驱动）：修订不得无依据
  // 改写 / 删除 / 弱化既有实验事实，也不得新增无 Evidence 依据的实验细节
  if (input.factPreservation !== undefined) {
    if (input.factPreservation === null) {
      rules.push({
        rule: "fact_preservation_not_applicable",
        passed: true,
        detail: "无前序修订可比较（首轮 / 快照缺失 / 用户恢复历史修订）；实验事实保持规则不参与判定",
      });
    } else {
      rules.push({
        rule: "fact_preservation",
        passed: input.factPreservation.ok,
        detail: describeFactPreservation(input.factPreservation),
      });
    }
  }

  // 16. Evidence Citation Coverage（M6.6 §13）：正文引用 ↔ Verified Evidence。
  // 默认只呈现（可检测不阻断——M6.6 接入期存量项目覆盖率必然低）；
  // requireEvidenceBackedCitations=true 时未覆盖引用阻断 Final。
  if (input.evidenceCitationCoverage !== undefined) {
    const coverage = input.evidenceCitationCoverage;
    const enforcing = thresholds.requireEvidenceBackedCitations === true;
    rules.push({
      rule: "citations_evidence_backed",
      passed: enforcing ? coverage.uncovered.length === 0 : true,
      detail: enforcing
        ? `无 verified evidence 对应的引用 ${coverage.uncovered.length} 条${
            coverage.uncovered.length > 0 ? `（${coverage.uncovered.slice(0, 5).join("、")}）` : ""
          }`
        : `引用覆盖：${coverage.covered.length}/${coverage.covered.length + coverage.uncovered.length} 有 verified evidence（未覆盖 ${coverage.uncovered.length} 条：${
            coverage.uncovered.length > 0 ? coverage.uncovered.slice(0, 5).join("、") : "无"
          }；人工复核，不阻断）`,
    });
  }

  // 17-18. Revision Gate（M6.7 §10）：修订条目全部解决 + claim 强度守卫。
  // 用户 approve 决策覆盖自动判定（HITL 明示接受已知风险，记录在案）。
  if (input.revisionValidation !== undefined) {
    const validation = input.revisionValidation;
    const userApproved = validation.userDecision?.decision === "approve";
    const counts = countItemStatuses(validation);
    rules.push({
      rule: "revision_items_resolved",
      passed: userApproved || (counts.rejected === 0 && counts.needsReview === 0),
      detail: userApproved
        ? `修订条目 validated=${counts.validated} rejected=${counts.rejected} needs_review=${counts.needsReview}；用户已在修订验证 HITL 明示接受（${validation.validationId}）`
        : `修订条目 validated=${counts.validated} rejected=${counts.rejected} needs_review=${counts.needsReview}（${validation.validationId}；rejected 须重派发解决，needs_review 须人工确认后才能 Final）`,
    });
    const blocks = validation.claimStrength.filter((finding) => finding.action === "block");
    const warnings = validation.claimStrength.filter((finding) => finding.action === "warning");
    rules.push({
      rule: "claim_strength_guard",
      passed: userApproved || blocks.length === 0,
      detail:
        blocks.length === 0 && warnings.length === 0
          ? "无 claim 强度升级问题"
          : describeClaimStrengthFindings(validation.claimStrength) +
            (userApproved ? "；用户已明示接受" : ""),
    });
  }

  const reasons = rules.filter((rule) => !rule.passed).map((rule) => `${rule.rule}: ${rule.detail}`);
  return {
    passed: reasons.length === 0,
    reasons,
    rules,
    thresholds,
    checkedAt: new Date().toISOString(),
  };
}

/**
 * Quality Gate 结果落盘（reviews/quality-gate-r{round}.json）。
 * M4.7 起附带修订对齐信息（Finalize 的 stale 防护依据）：
 *   revision         评估时的 manuscript 当前修订
 *   reviewedRevision 该轮 review 审阅的修订（summary.reviewedRevision）
 * 旧产物无这两个字段 → Finalize 视为不可信（重新评估后才能 Final）。
 */
export async function saveQualityGateReport(
  projects: ProjectStore,
  projectId: string,
  round: number,
  result: QualityGateResult,
  summary: ReviewSummary,
  extras: {
    citationPreservation?: CitationPreservationSummary | null;
    factPreservation?: FactPreservationSummary | null;
    evidenceCitationCoverage?: EvidenceCitationCoverage;
    revisionValidation?: RevisionValidationResult;
  } = {},
): Promise<string> {
  const dir = projects.reviewsDir(projectId);
  await mkdir(dir, { recursive: true });
  const file = `quality-gate-r${round}.json`;
  await writeJsonAtomic(join(dir, file), {
    gate: result,
    reviewSummary: summary,
    // M5.6：引用保持明细随 gate 产物落盘（revision.plan 据此派发恢复条目；UI 可解释）
    ...(extras.citationPreservation !== undefined ? { citationPreservation: extras.citationPreservation } : {}),
    // M5.6 第二层：实验事实保持明细（revision.plan 派发恢复条目；build.draft 拦截依据）
    ...(extras.factPreservation !== undefined ? { factPreservation: extras.factPreservation } : {}),
    // M6.6：引用 ↔ verified evidence 覆盖明细（UI / 审计可见）
    ...(extras.evidenceCitationCoverage !== undefined
      ? { evidenceCitationCoverage: extras.evidenceCitationCoverage }
      : {}),
    // M6.7：修订条目复核明细（Revision Gate 两条规则的输入；UI / 审计可见）
    ...(extras.revisionValidation !== undefined ? { revisionValidation: extras.revisionValidation } : {}),
    ...(typeof summary.reviewedRevision === "number"
      ? { revision: summary.reviewedRevision, reviewedRevision: summary.reviewedRevision }
      : {}),
  });
  return `reviews/${file}`;
}
