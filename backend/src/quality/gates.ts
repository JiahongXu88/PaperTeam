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
import {
  describeCumulativeFactPreservation,
  type CumulativeFactValidation,
} from "./cumulativeFactPreservation.js";
import type { ClaimGapAudit } from "../review/claimGapAudit.js";
import type { ClaimGroundingReport } from "../review/claimGrounding.js";
import type { ReviewIssue } from "../agents/ReviewerService.js";
import type { EvidencePairingSummary } from "./evidencePairing.js";
import type { CrossSectionConsistencySummary } from "../review/crossSectionConsistency.js";
import type { TargetReadinessGateAdvisory } from "../target/promptBlocks.js";
import type { SurveyWritingEvaluation } from "../survey/writingInvariants.js";
import type { ClaimCheckGateSummary } from "../experiments/claimChecks.js";
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
  options: { manuscriptDir?: string } = {},
): Promise<{ build: BuildGateResult; compile: LatexCompileResult }> {
  const manuscriptDir = options.manuscriptDir ?? projects.manuscriptDir(projectId);
  const files = await collectLatexFiles(manuscriptDir);
  const missingIncludes = files.warnings.filter((warning) => warning.includes("无法读取"));
  const bibMissing =
    files.mainTex !== null &&
    /\\(bibliography|addbibresource)\{/.test(files.mainTex.content) &&
    files.bibPath === null;

  let compile: LatexCompileResult;
  try {
    compile = await latex.compile({
      manuscriptDir,
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
  options: { manuscriptDir?: string } = {},
): Promise<{ build: BuildGateResult; compile: LatexCompileResult; record: BuildGateRecord }> {
  return withCompileLock(projectId, async () => {
    const { build, compile } = await runBuildGate(projects, latex, projectId, options);
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
   * Cumulative Fact Preservation（M10.3.1 G1）：冻结基线（导入 rev-1）→ 被审阅
   * 修订的累计事实校验。undefined = 调用方未计算（规则不出现，兼容纯单元输入）；
   * null = 不可比较（无导入基线——idea_to_paper 项目）→ 规则以中性形态呈现；
   * validation → cumulative_fact_preservation 参与判定（Final 必须通过；
   * Draft 不受阻断但结果必须可见——见 build.draft / revision.report）。
   */
  cumulativeFactPreservation?: CumulativeFactValidation | null;
  /**
   * Claim Gap Audit（M10.3.1 G2）：existing-paper 语境下 unsupported claims 的
   * task-aware 适用性（pre-existing 原稿既有 / author-data 作者实验数据覆盖 /
   * revision-introduced 修订引入）。undefined = 未计算（规则按原口径）；提供时
   * 规则 4/5/6 只对「修订引入」口径计数——原稿既有 claim 的证据完备性属作者
   * 裁决，不因返修任务被重新证明（审计产物逐条留档，不隐藏）。
   */
  claimGapAudit?: ClaimGapAudit;
  /**
   * Claim Grounding（M11.2.3 D-2）：同轮 claim grounding 报告。提供时规则 4
   * 按披露口径只计 opaque_assertion（transparent_unverified 单独呈现不阻断），
   * 规则 5/6 对 rootCauseKey 归因到本轮 unsupported claim 的 finding 去重——
   * 同一根因（无证据论断）不再被 claim / blocking / critical 口径重复计因。
   * undefined = 未提供（旧项目 / 单元输入，按原口径）。
   */
  claimGrounding?: ClaimGroundingReport;
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
  /**
   * Survey Writing Evaluation（M11.2）：综述写作契约的确定性判定（悬空 refs /
   * fake citation key / evidence_backed synthesis 可回溯）+ 启发式 metrics。
   * undefined = 非 survey 项目（规则不出现，普通论文路径零改动）；
   * blocking 三规则参与 Final 判定，metrics 以 warning 形态呈现（不阻断）。
   */
  surveyWriting?: SurveyWritingEvaluation;
  /**
   * M12 A9：Target Readiness advisory 投影（readinessGateAdvisory 产物）。
   * **零阻断**：不进任何规则、不影响 passed / revisionTask / publicationReadiness
   * 判定——只随 gate 结果透传（UI / 报告可见）。undefined = 无 target 配置 /
   * 未评估（既有项目行为完全不变）。
   */
  targetReadiness?: TargetReadinessGateAdvisory;
  /**
   * M14.2 thesis_from_papers：学位论文确定性规则输入。
   * undefined = 非 thesis 项目（四条规则不出现，其余 kind 零改动）。
   */
  thesis?: ThesisGateInput;
  /**
   * M14.9.5.4：审稿目的（缺省 author_manuscript）。published_paper_assessment 时作者实验复算规则不适用
   * （第三方论文没有、也不需要作者原始数据）；其余规则照常按作者稿件口径执行（只读视图另标适用性）。
   */
  reviewPurpose?: "author_manuscript" | "published_paper_assessment";
  /**
   * M14.9.5.4：预先登记的实验论断复算账本摘要（experiments/claimChecks.ts）。undefined = 调用方未计算
   * （规则不出现，兼容纯单元输入）；提供时 experiment_claims_recomputed 规则呈现：CONTRADICTED → FAIL，
   * 登记了但无法复算 → NOT_EVALUATED（必需），未登记 → 有实验包时 NOT_EVALUATED（不阻断）/ 无实验包 NOT_APPLICABLE。
   */
  claimChecks?: ClaimCheckGateSummary;
  /**
   * M15.6：Evidence-Aware 分层（quality/evidencePairing.ts；纯函数派生）。undefined = 调用方未计算
   * （规则 4/5/6 按旧口径，兼容纯单元输入与旧产物）。提供时规则 4 的 UNSUPPORTED 计数与
   * 规则 5/6 的 heavy finding 计数按预登记状态表分层：无 pairing 材料（证据库空 + formal 池空）
   * 的 UNSUPPORTED 与 evidence_gap 工件 finding 降为 NOT_EVALUATED 呈现（published 只读不阻断；
   * author 稿件 = 必需核验未完成仍阻断）；CONTRADICTED（formal 解析 / opaque 披露）与
   * VERIFIED_IN_DOC / BY_EVIDENCE 类缺陷保持阻断。
   */
  evidencePairing?: EvidencePairingSummary;
  /**
   * M15.6：跨节数值一致性（摘要/结论 ↔ 结果表；review/crossSectionConsistency.ts；确定性零模型）。
   * undefined = 调用方未计算（规则不出现，兼容纯单元输入）。EVALUATED 时呈现
   * cross_section_numeric_consistency 规则：verifiedContradictions > 0 → FAIL（required）；
   * suspected（跨表疑义未消解 / 派生量全解释不相容）→ NOT_EVALUATED（author 稿件 required 转作者裁决，
   * published 只读不阻断）；绑定唯一且数值一致 → PASS；绑定不唯一 / 限定词 / 聚合口径 →
   * NOT_EVALUATED（不阻断——不能要求所有摘要数字都绑上表，但绝不签发「已核验一致」）。
   */
  crossSectionConsistency?: CrossSectionConsistencySummary;
}

/** M14.2：thesis gate 规则输入（definitions.computeThesisGateInput 产出） */
export interface ThesisGateInput {
  /** published_facts_zero_drift：已确认事实 ↔ 正文的机械比对 */
  drift: {
    checked: number;
    consistent: number;
    equivalentFormat: number;
    unauthorized: number;
    absent: number;
    findings: Array<{ factId: string; surface: string; status: string; detail: string; observedValue?: string }>;
  };
  /** thesis_mapping_confirmed */
  mapping: {
    exists: boolean;
    confirmed: boolean;
    fingerprintMatchesOutline: boolean;
    invalidSourceInputs: string[];
    invalidFactIds: string[];
  };
  /** thesis_structure_complete（ThesisDocumentModel 对 outline 的装配校验） */
  structureViolations: string[];
  /** thesis_conflicts_resolved（未裁决阻断冲突必须为 0） */
  conflictsUnresolved: number;
  /**
   * M14.3 inherited_tables_intact：已插入继承表格的守卫复核（数值 / 行列 /
   * 标记块完整性）。undefined = 无继承表格资产（规则不出现）。
   */
  tables?: {
    checked: number;
    intact: number;
    findings: Array<{ assetId: string; ok: boolean; violations: string[] }>;
  };
  /**
   * M14.3 cross_chapter_consistency：跨章一致性 MVP 的确定性结果摘要
   * （advisory——不参与 pass/fail；产物在 research/cross-chapter-consistency.json）。
   */
  consistency?: {
    checked: { terms: number; factKeys: number; references: number; chapters: number };
    findings: number;
    suspicious: number;
    topFindings: string[];
  };
  /** M14.6 thesis_abstract_complete：双语摘要 + 关键词是否齐备（Draft 可生成 ≠ 结构完整） */
  abstract?: {
    present: boolean;
    detail: string;
    /** M14.7 thesis_abstract_snapshot_current：摘要快照绑定是否对应当前正文 / 事实 / 决定（缺省 = 无摘要，规则不适用） */
    snapshotCurrent?: boolean;
    snapshotDetail?: string;
  };
  /** M14.6 workflow_meta_notes_absent：正文中的高置信工作流元注记（确定性词面检测） */
  metaNotes?: { hits: number; samples: string[] };
  /** M14.6 templated_phrasing_reported（advisory）：模板化小结 / 公式化过渡 */
  templatedPhrasing?: { findings: number; byKind: Record<string, number>; samples: string[] };
  /** M14.6 thesis_citations_present：正式学术引用是否存在（文献综述章 / 文献主题声明时适用） */
  citations?: {
    citedCount: number;
    /** M14.7：引用完整性报告补充（hallucinated=0 ≠ 证据充分；零引用 + 无材料 = 材料缺口） */
    hallucinated?: number;
    missingKeys?: number;
    applicable: boolean;
    supplyDegraded: boolean;
    formalEvidence: number;
    bibEntries: number;
  };
}

/**
 * M14.9.5.4：规则的执行状态（与 passed 并存；passed 为历史消费者保留）。
 *   PASS           规则的核验前提成立、已执行、未观察到违规
 *   FAIL           已执行且观察到违规
 *   NOT_EVALUATED  核验前提不成立（无报告 / 无证据 / claim 未抽取 / 调用失败）：「0 条违规」来自没有执行，不是已核验；
 *                  required=true 时 passed=false——未完成的必需核验不得放行 Final / READY
 *   NOT_APPLICABLE 规则对本项目 / 本轮不适用（首轮无前序修订、无引用、只读评估等），passed=true
 *   INFO           只呈现、不判定的观察（informational；passed 恒 true）
 *   ADVISORY       M15.7：已评估但结果只作解释性呈现、不单独否决（UNCALIBRATED 分数阈值等）。
 *                  evaluateQualityGate 本身不产出该状态——由 qualityPolicyV2 的政策适配层把
 *                  指定 FAIL 规则转为此状态；passed 恒 true，原分数 / 原阈值 / Legacy 判定保留在 detail 与 advisory 字段。
 */
export type QualityGateRuleStatus = "PASS" | "FAIL" | "NOT_EVALUATED" | "NOT_APPLICABLE" | "INFO" | "ADVISORY";

export interface QualityGateRule {
  rule: string;
  passed: boolean;
  detail: string;
  /** M14.9.5.4：执行状态（旧产物无此字段 = 只能按 passed 解释，前端不臆测） */
  status?: QualityGateRuleStatus;
  /** M14.9.5.4：该规则是否为进入 Final / READY 的必需核验（NOT_EVALUATED + required → passed=false） */
  required?: boolean;
  /**
   * M15.7：政策适配层（qualityPolicyV2）把本规则从 Legacy FAIL 转为 ADVISORY 时附带的机读载荷；
   * evaluateQualityGate 不产出该字段，旧产物 / 非 advisory 规则无此字段。
   */
  advisory?: {
    kind: "UNCALIBRATED_SCORE";
    legacyStatus: "FAIL";
    legacyRequired: boolean;
    legacyDetail: string;
    score: number | null;
    threshold: number;
    direction: "at_least" | "at_most";
    calibration: "UNVALIDATED";
    policyVersion: string;
  };
}

/** M14.9.5.4：Gate 的核验完整性摘要——「没有违规」与「完成核验」分开报告 */
export interface QualityGateVerificationSummary {
  /** 所有必需核验都已执行（没有 required NOT_EVALUATED） */
  requiredComplete: boolean;
  notEvaluated: Array<{ rule: string; required: boolean; detail: string }>;
  notApplicable: string[];
  counts: Record<QualityGateRuleStatus, number>;
}

export interface QualityGateResult {
  passed: boolean;
  reasons: string[];
  rules: QualityGateRule[];
  thresholds: QualityGateThresholds;
  checkedAt: string;
  /** M14.9.5.4：核验完整性（旧产物无此字段） */
  verification?: QualityGateVerificationSummary;
  /**
   * M14.9.5.4：评估入口与输入指纹。workflow stage 与 POST /quality-gate 共用 evaluateProjectQualityGate；
   * inputFingerprint 相同 = 等价输入（规则集合与判定必须相同）。旧产物无此字段。
   */
  evaluation?: {
    entry: "workflow" | "manual";
    workflowKind: string | null;
    reviewPurpose: string;
    reviewRound: number;
    reviewedRevision: number | null;
    runId: string | null;
    inputFingerprint: string;
    /** 等价输入不可得的部分（如手动入口找不到对应 run 的 build 结果）：如实列出，不静默假设 */
    contextGaps: string[];
  };
  /**
   * M11.4 Product Closure：existing-paper 分层判定——Revision Task Success
   * （本轮返修是否正确完成）。undefined = 非 existing-paper 工作流 / legacy
   * 模式 / 旧产物（读取方按 legacy 单层 gate.passed 语义解释，不 crash）。
   */
  revisionTask?: {
    verdict: "PASS" | "FAIL" | "AUTHOR_DECISION_REQUIRED";
    success: boolean;
    checks: { check: string; passed: boolean; detail: string }[];
    reasons: string[];
    authorDecisions: { instructions: number; greyZoneClaims: number; unknownOriginFindings: number };
  };
  /**
   * M11.4：投稿就绪层（整篇是否适合作为最终投稿候选）。gate.passed 在
   * existing-paper 语境下的语义 = 本层 READY（全稿规则 + 任务成功）；本字段
   * 额外携带基线继承风险清单（作者裁决层，不阻塞任务层）。
   */
  publicationReadiness?: {
    verdict: "READY" | "NOT_READY" | "AUTHOR_DECISION_REQUIRED";
    reasons: string[];
    baselineInheritedRisks: { description: string; origin: string; reviewerRequired: boolean }[];
  };
  /**
   * M12 A9：Target Readiness advisory（additive 透传字段；不参与任何判定——
   * 三层语义冻结：Correctness / Publication Ready / Target Readiness 互不侵蚀）。
   */
  targetReadiness?: TargetReadinessGateAdvisory;
}

/** Quality Gate 判定（确定性；Draft 不经过本判定） */
export function evaluateQualityGate(
  input: QualityGateInput,
  thresholds: QualityGateThresholds = DEFAULT_QUALITY_THRESHOLDS,
): QualityGateResult {
  const rules: QualityGateRule[] = [];
  /**
   * M14.9.5.4：规则按执行状态入列。passed 由状态派生（PASS / NOT_APPLICABLE / INFO → true；FAIL → false；
   * NOT_EVALUATED → !required）——空集合上的「0 条违规」不再与「完成核验」混为一谈。
   */
  const push = (rule: string, status: QualityGateRuleStatus, detail: string, required = false): void => {
    const passed = status === "FAIL" ? false : status === "NOT_EVALUATED" ? !required : true;
    rules.push({
      rule,
      passed,
      detail: status === "NOT_EVALUATED" ? `NOT_EVALUATED${required ? "（必需核验未完成）" : ""}：${detail}` : detail,
      status,
      required,
    });
  };
  const verdict = (ok: boolean): QualityGateRuleStatus => (ok ? "PASS" : "FAIL");

  // 1. hallucinated citation（metadata 权威 not_found）。前提：citation.verify 报告存在
  const citation = input.citation;
  if (citation === null) {
    push("hallucinated_citations_zero", "NOT_EVALUATED", "没有引用核验报告（未执行 citation.verify）：0 条虚构引用来自未检查，不代表引用真实性已核验", true);
    push("citation_structure_valid", "NOT_EVALUATED", "没有引用核验报告（未执行 citation.verify）：\\cite ↔ bib 结构未检查", true);
  } else {
    const hallucinated = citation.summary.hallucinated;
    if (citation.summary.citedCount === 0 && hallucinated === 0) {
      push("hallucinated_citations_zero", "NOT_APPLICABLE", "稿件没有任何 \\cite：虚构引用检查不适用（不代表引用充分）");
    } else {
      push("hallucinated_citations_zero", verdict(hallucinated === 0), `metadata not_found 引用 ${hallucinated} 条`, true);
    }
    // 2. 引用结构完整（\cite 有 bib 对应、无重复 key、无坏引用）
    const missingKeys = citation.summary.missingKeys;
    const duplicateKeys = citation.summary.duplicateKeys;
    const badCitations = citation.summary.badCitations;
    push(
      "citation_structure_valid",
      verdict(missingKeys === 0 && duplicateKeys === 0 && badCitations === 0),
      `missing=${missingKeys} duplicate=${duplicateKeys} bad=${badCitations}`,
      true,
    );
  }

  // 3. 无矛盾证据（contradictory evidence）。前提：证据库非空——空库上「0 条矛盾」只是没有可比对的证据
  if (input.evidence.total === 0) {
    push("no_contradictory_evidence", "NOT_EVALUATED", "项目证据库为空：没有可比对的证据，0 条矛盾不代表已核验无矛盾（不阻断；不要求所有稿件先导入证据）");
  } else {
    push("no_contradictory_evidence", verdict(input.evidence.contradictory === 0), `contradictory evidence ${input.evidence.contradictory} 条（证据库 ${input.evidence.total} 条）`, true);
  }

  // 4. unsupported / contradicted 关键 claim = 0（M10.3.1：existing-paper 语境
  //    只计修订引入口径；M11.2.3：claimGrounding 可用时按披露口径只计
  //    opaque_assertion——transparent_unverified（据来源转述 + 未核验声明）
  //    单独呈现不阻断，不是 evidence-backed，学术评分照常反映缺口）
  //    M14.9.5.4：前提 = fact 路确实抽取并评估了 claim（长文档单元模式不产出 claims；fact 路返回 0 条 claim
  //    同样是「没有被评估的论断」）——未评估时 NOT_EVALUATED（必需），不再显示「0 条 → PASS」
  //    M15.6：evidencePairing 可用时按预登记状态表分层——无 pairing 材料的 UNSUPPORTED 与被拒绝的
  //    跨域 CONTRADICTED pairing 不再计成「已证实论断违规」（缺证据 ≠ 已证伪）；author 稿件语境下
  //    这部分是必需核验未完成（required NOT_EVALUATED 仍阻断 READY），published 只读是诚实评估缺口。
  //    CONTRADICTED（formal 解析 / opaque 披露）与既有 opaque 计数口径不变——真实缺陷保持阻断。
  const audit = input.claimGapAudit;
  const claimGrounding = input.claimGrounding;
  const pairing = input.evidencePairing;
  const verdicts = input.review.scores.factVerdicts;
  const claimsEvaluated = verdicts === null || verdicts === undefined
    ? 0
    : verdicts.SUPPORTED + verdicts.PARTIALLY_SUPPORTED + verdicts.UNSUPPORTED + verdicts.CONTRADICTED;
  const unsupported =
    audit !== undefined
      ? audit.counts.revisionIntroduced
      : pairing !== undefined
        ? pairing.claims.countedUnsupported + pairing.claims.reviewerContradictions + pairing.claims.verifiedContradictions
        : claimGrounding !== undefined
          ? claimGrounding.opaqueUnsupportedClaims
          : (input.review.unsupportedCriticalClaims ?? 0);
  if (claimsEvaluated === 0) {
    push(
      "unsupported_critical_claims_zero",
      "NOT_EVALUATED",
      verdicts === null || verdicts === undefined
        ? `本轮没有执行 claim 级核验（${input.review.coverage?.mode === "units" ? "长文档单元审稿模式不产出 claims" : "fact 路未返回 claims"}）：0 条 UNSUPPORTED 来自未评估，不代表论断都有支撑`
        : "fact 路返回 0 条 claim：没有被评估的论断，0 条 UNSUPPORTED 不代表论断都有支撑",
      true,
    );
  } else {
    // M15.6：分层呈现（信息完整性契约：评估了什么 / 证实矛盾多少 / 审稿怀疑多少 / 缺口多少）
    const pairingDetail = pairing === undefined
      ? null
      : `；M15.6 分层：已证实矛盾 ${pairing.claims.verifiedContradictions}（formal evidence / 实验复算）+ 审稿怀疑 ${pairing.claims.reviewerContradictions}（opaque CONTRADICTED，无 formal 解析）计入${
          pairing.claims.evidenceGapUnsupported > 0 || pairing.claims.domainMismatchContradictions > 0
            ? `；证据库无 pairing 材料的 UNSUPPORTED ${pairing.claims.evidenceGapUnsupported} 条 + 跨域 pairing 拒绝 ${pairing.claims.domainMismatchContradictions} 条不计为论断违规（NOT_EVALUATED——缺证据 ≠ 已证伪）`
            : ""
        }${pairing.claims.claimCheckContradicted > 0 ? `；实验复算矛盾 ${pairing.claims.claimCheckContradicted} 条由规则 4d 计数` : ""}`;
    if (unsupported === 0 && pairing !== undefined && (pairing.claims.evidenceGapUnsupported > 0 || pairing.claims.domainMismatchContradictions > 0)) {
      // 计违规为 0，但存在核验缺口：author 稿件 = 必需核验未完成（阻断）；published 只读 = 诚实缺口（不阻断）
      const required = input.reviewPurpose !== "published_paper_assessment";
      push(
        "unsupported_critical_claims_zero",
        "NOT_EVALUATED",
        (pairing.pairingStatus === "NO_PAIRING_MATERIAL"
          ? `证据库无 pairing 材料（formal 池空）：UNSUPPORTED ${pairing.claims.evidenceGapUnsupported} 条为核验缺口，不是已证实的论断违规${required ? "——author 稿件的必需核验未完成（不得据此认定论文有科学错误，也不得放行 Final/READY）" : "——只读评估：论断尚未核验（详见 pendingVerification），不是已证实错误"}`
          : `跨域 pairing 拒绝 ${pairing.claims.domainMismatchContradictions} 条 CONTRADICTED 判定（证据与论断零词面关联）${required ? "——需作者核对" : "——只读评估：该判定不作为论文错误计数"}`) +
          (pairingDetail ?? ""),
        required,
      );
    } else {
      push(
        "unsupported_critical_claims_zero",
        verdict(unsupported === 0),
        audit !== undefined
          ? `修订引入 UNSUPPORTED/CONTRADICTED claim ${unsupported} 条（另有原稿既有 ${audit.counts.excludedPreExisting} 条 / 作者数据覆盖 ${audit.counts.excludedAuthorData} 条——返修语境不重证，见 claim-gap-audit）`
          : pairing !== undefined
            ? `UNSUPPORTED/CONTRADICTED claim 计违规 ${unsupported} 条${pairingDetail ?? ""}`
            : claimGrounding !== undefined
              ? `UNSUPPORTED/CONTRADICTED claim ${claimGrounding.unsupportedClaims} 条（凭空断言 ${claimGrounding.opaqueUnsupportedClaims} 条计入阻断；透明未核验转述 ${claimGrounding.transparentUnsupportedClaims} 条单独呈现不阻断${(claimGrounding.authorDataUnsupportedClaims ?? 0) > 0 ? `；作者授权实验数据 ${claimGrounding.authorDataUnsupportedClaims} 条单独呈现不阻断` : ""}——口径见 M11.2.3）`
              : `UNSUPPORTED/CONTRADICTED claim ${unsupported} 条`,
        true,
      );
    }
  }
  // 4b. 透明未核验转述的可见性（informational：永远通过，只呈现计数——
  //     「诚实限定」不是 evidence-backed，也不应凭空消失）
  if (claimGrounding !== undefined && claimGrounding.transparentUnsupportedClaims > 0) {
    push(
      "transparent_unverified_reported",
      "INFO",
      `透明未核验转述 ${claimGrounding.transparentUnsupportedClaims} 条（据来源转述 + 声明未核验；不阻断，作者裁决是否取全文 / 删除）`,
    );
  }

  // 4c. 作者授权实验数据的可见性（Round 2，informational：永远通过——数值来自
  //     作者确认并授权进入工作流的观测，不需要外部文献重证；但仍不是 evidence-backed，
  //     报告里如实标注「作者确认、未经外部核验」）
  if (claimGrounding !== undefined && (claimGrounding.authorDataUnsupportedClaims ?? 0) > 0) {
    push(
      "author_experiment_data_reported",
      "INFO",
      `作者授权实验数据 ${claimGrounding.authorDataUnsupportedClaims} 条（数值全部来自已授权观测；不阻断，但仍为作者确认、未经外部核验）`,
    );
  }

  // 4d. M14.9.5.4：预先登记的实验论断复算（claim → 原始输入 / 哈希 → 确定性计算 → verdict）。
  //     CONTRADICTED = 论文数值与作者自己的实验数据复算结果不一致（FAIL）；登记了却因缺列 / 错协议 / 哈希不符 /
  //     冲突版本 / 未授权等无法复算 = NOT_EVALUATED（必需：登记即声明需要核验）；复算一致 ≠ 外部独立核验
  const claimChecks = input.claimChecks;
  if (claimChecks !== undefined) {
    if (input.reviewPurpose === "published_paper_assessment") {
      push("experiment_claims_recomputed", "NOT_APPLICABLE", "第三方已发表论文只读评估：没有、也不需要作者原始实验数据，论文自报数值不做复算");
    } else if (claimChecks.registered === 0) {
      if (claimChecks.experimentPackages > 0) {
        push("experiment_claims_recomputed", "NOT_EVALUATED", `已导入 ${claimChecks.experimentPackages} 个实验包，但没有登记可复算的论文论断：稿件中的实验数值未经 PaperTeam 复算（不阻断；导入记录不等于 Verified Evidence）`);
      } else {
        push("experiment_claims_recomputed", "NOT_APPLICABLE", "项目没有实验包，也没有登记可复算论断");
      }
    } else if (claimChecks.contradicted.length > 0) {
      push(
        "experiment_claims_recomputed",
        "FAIL",
        `${claimChecks.contradicted.length}/${claimChecks.registered} 项论断与实验数据复算不一致：${claimChecks.contradicted.slice(0, 4).map((entry) => `${entry.id}（稿件 ${entry.manuscriptValue} ≠ 复算 ${entry.derivedValue}）`).join("；")}` +
          `${claimChecks.notEvaluated.length > 0 ? `；另有 ${claimChecks.notEvaluated.length} 项无法复算` : ""}（账本 ${claimChecks.ledgerHash.slice(0, 12)}；复算基于作者提供的数据，未经外部独立核验）`,
        true,
      );
    } else if (claimChecks.notEvaluated.some((entry) => entry.required)) {
      const missing = claimChecks.notEvaluated.filter((entry) => entry.required);
      push(
        "experiment_claims_recomputed",
        "NOT_EVALUATED",
        `${missing.length}/${claimChecks.registered} 项登记论断无法复算：${missing.slice(0, 4).map((entry) => `${entry.id} ${entry.reason}`).join("；")}——不得据此认定论文有误，也不得视为已核验（一致 ${claimChecks.consistent} 项）`,
        true,
      );
    } else {
      push(
        "experiment_claims_recomputed",
        "PASS",
        `${claimChecks.consistent}/${claimChecks.registered} 项登记论断与实验数据复算一致（账本 ${claimChecks.ledgerHash.slice(0, 12)}；数据为作者提供、哈希绑定，未经外部独立核验）`,
        true,
      );
    }
  }

  // 4e. M15.6：跨节数值一致性（摘要 / 结论 ↔ 结果表）。确定性零模型检查（review/crossSectionConsistency.ts），
  //     复用 claimCertificate 的唯一绑定 / 数值区间判别 / 派生量复算 / 跨表疑义消解。
  //     verifiedContradictions > 0 → FAIL（真实稿内矛盾，CE1 型盲区的确定性检出）；
  //     suspected（跨表疑义未消解 / 派生量全解释不相容）→ NOT_EVALUATED（author 稿件 required 转作者裁决）；
  //     全部绑定一致 → PASS；其余（绑定不唯一 / 限定词 / 聚合口径 / 整数）→ NOT_EVALUATED 不阻断——
  //     不能要求所有摘要数字都绑上表，但绝不签发「已核验一致」。
  const crossSection = input.crossSectionConsistency;
  if (crossSection !== undefined) {
    if (crossSection.status !== "EVALUATED") {
      push(
        "cross_section_numeric_consistency",
        "NOT_EVALUATED",
        crossSection.status === "UNAVAILABLE"
          ? `跨节数值一致性检查未能执行（${crossSection.unavailableReason ?? "未知原因"}）：摘要/结论 ↔ 结果表的一致性未核验（不代表一致）`
          : "跨节数值一致性检查状态未知（不代表一致）",
      );
    } else if (crossSection.counts.verifiedContradictions > 0) {
      const witnesses = crossSection.witnesses.filter((witness) => witness.outcome === "VERIFIED_CONTRADICTION");
      push(
        "cross_section_numeric_consistency",
        "FAIL",
        `摘要/结论与结果表格的数值矛盾 ${crossSection.counts.verifiedContradictions} 处（确定性核验：唯一绑定 + 显示精度区间判别 + 跨表疑义消解）：` +
          witnesses.slice(0, 3).map((witness) => `${witness.sectionKind === "abstract" ? "摘要" : "结论"}「${witness.quote.slice(0, 80)}」的 ${witness.raw}${witness.unit ?? ""} ↔ 表 ${witness.binding?.bound?.tableId ?? "?"} ${witness.binding?.bound?.rowKey.join("/") ?? ""} 行 ${witness.binding?.bound?.headerPath.slice(-1)[0] ?? ""} 列 = ${witness.binding?.bound?.value ?? "?"}（${witness.valueRelation?.note ?? ""}）`).join("；") +
          `；另 consistent ${crossSection.counts.consistent} / not_evaluated ${crossSection.counts.notEvaluated} / suspected ${crossSection.counts.suspected}`,
        true,
      );
    } else if (crossSection.counts.suspected > 0) {
      const required = input.reviewPurpose !== "published_paper_assessment";
      push(
        "cross_section_numeric_consistency",
        "NOT_EVALUATED",
        `摘要/结论数值与表格存在 ${crossSection.counts.suspected} 处疑似不一致（唯一绑定 + 数值不相交，但跨表归属不可证或派生量解释不唯一——fail-closed 不出强判）${required ? "：需作者核对后再依赖" : "：只读评估如实报告，未证实为错误"}；consistent ${crossSection.counts.consistent} / not_evaluated ${crossSection.counts.notEvaluated}（含聚合口径 ${crossSection.notEvaluatedReasons["AGGREGATE_WORDING"] ?? 0}、绑定不唯一 ${Object.entries(crossSection.notEvaluatedReasons).filter(([code]) => code.startsWith("BINDING")).reduce((sum, [, count]) => sum + count, 0)}）`,
        required,
      );
    } else if (crossSection.counts.consistent > 0 && crossSection.counts.notEvaluated === 0) {
      push(
        "cross_section_numeric_consistency",
        "PASS",
        `摘要/结论 ↔ 结果表数值一致性：核验 ${crossSection.counts.consistent} 处全部一致（唯一绑定 + 显示精度区间）`,
        true,
      );
    } else if (crossSection.counts.consistent === 0 && crossSection.counts.notEvaluated === 0) {
      push(
        "cross_section_numeric_consistency",
        "NOT_APPLICABLE",
        `摘要/结论无可核验的测量值数值（整数计数 / 引用 / 集合量词不在核验范围；集合量词结论 ${crossSection.counts.setQuantifierClaims} 处仅观察）`,
      );
    } else {
      push(
        "cross_section_numeric_consistency",
        "NOT_EVALUATED",
        `摘要/结论 ↔ 结果表数值一致性：一致 ${crossSection.counts.consistent} 处，未核验 ${crossSection.counts.notEvaluated} 处（${Object.entries(crossSection.notEvaluatedReasons).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([code, count]) => `${code} ${count}`).join("、")}）——部分核验通过不等于全部一致`,
      );
    }
  }
  // 5. blocking review issue = 0（M10.3.1：归因到被排除 claim 的不计；
  //    M11.2.3：rootCauseKey 归因到本轮 unsupported claim 的不计——同一根因
  //    已由规则 4 的 claim 口径覆盖，不重复计入 blocking 口径）
  //    M15.6：evidencePairing 可用时，无 pairing 材料的 evidence_gap 工件 finding 与
  //    （published 只读）rubric 自报「需作者核对 / 需外部数据」的 finding 不计为已证实违规
  //    （NOT_EVALUATED 呈现）；真实缺陷（稿内矛盾 / verified evidence 冲突 / 引用结构）照旧计数。
  const unsupportedClaimIds = new Set(claimGrounding?.unsupportedClaimIds ?? []);
  // M14.9.5.4：与实验复算 CONTRADICTED 同根因的确定性 finding（rootCauseKey=claim-check:<id>）已由规则 4d 计因
  for (const entry of claimChecks?.contradicted ?? []) unsupportedClaimIds.add(`claim-check:${entry.id}`);
  const rootCauseCounted = (predicate: (issue: ReviewIssue) => boolean): number =>
    input.review.issues.filter(
      (issue) =>
        issue.rootCauseKey !== undefined &&
        unsupportedClaimIds.has(issue.rootCauseKey) &&
        predicate(issue),
    ).length;
  const blockingTotal = input.review.counts.blocking;
  const blockingExcluded = audit?.counts.issues.excludedBlocking ?? 0;
  const blockingRootCaused = rootCauseCounted((issue) => issue.blocking);
  const blockingPairingExcluded = pairing?.findings.blockingEvidenceGapExcluded ?? 0;
  const blockingEffective = Math.max(0, blockingTotal - blockingExcluded - blockingRootCaused - blockingPairingExcluded);
  const pairingExcludedNote = (excluded: number): string =>
    excluded > 0
      ? `、${excluded} 条为证据库无 pairing 材料的 evidence_gap 工件 / 只读口径「需作者核对 / 需外部数据」自报（M15.6：核验不足 ≠ 已证实违规，NOT_EVALUATED 呈现不计数）`
      : "";
  push(
    "blocking_issues_zero",
    verdict(blockingEffective === 0),
    blockingExcluded + blockingRootCaused + blockingPairingExcluded > 0
      ? `blocking issue ${blockingEffective} 条（另有 ${blockingExcluded} 条归因于原稿既有 / 作者数据覆盖 claim${blockingRootCaused > 0 ? `、${blockingRootCaused} 条为 unsupported claim / 实验复算矛盾的同根因 finding（规则 4 / 4d 已计）` : ""}${pairingExcludedNote(blockingPairingExcluded)}，不重复计入）`
      : `blocking issue ${blockingTotal} 条`,
    true,
  );

  // 6. 未解决的 critical / major = 0（M10.3.1 同 5 的归因口径；M11.2.3 根因去重同上；M15.6 分层同上）
  const criticalRootCaused = rootCauseCounted((issue) => issue.severity === "critical");
  const majorRootCaused = rootCauseCounted((issue) => issue.severity === "major");
  const criticalPairingExcluded = pairing?.findings.criticalEvidenceGapExcluded ?? 0;
  const majorPairingExcluded = pairing?.findings.majorEvidenceGapExcluded ?? 0;
  const criticalEffective = Math.max(
    0,
    input.review.openCritical -
      (audit?.counts.issues.excludedCritical ?? 0) -
      criticalRootCaused -
      criticalPairingExcluded,
  );
  const majorEffective = Math.max(
    0,
    input.review.openMajor - (audit?.counts.issues.excludedMajor ?? 0) - majorRootCaused - majorPairingExcluded,
  );
  push(
    "open_critical_major_zero",
    verdict(criticalEffective === 0 && majorEffective === 0),
    `critical=${criticalEffective} major=${majorEffective}${
      (audit?.counts.issues.excludedCritical ?? 0) +
        (audit?.counts.issues.excludedMajor ?? 0) +
        criticalRootCaused +
        majorRootCaused +
        criticalPairingExcluded +
        majorPairingExcluded >
      0
        ? `（归因排除 critical ${(audit?.counts.issues.excludedCritical ?? 0) + criticalRootCaused} / major ${(audit?.counts.issues.excludedMajor ?? 0) + majorRootCaused} 条——含 unsupported claim / 实验复算矛盾同根因 finding${criticalPairingExcluded + majorPairingExcluded > 0 ? `；M15.6 再排除 evidence_gap 工件 / 只读核验自报 critical ${criticalPairingExcluded} / major ${majorPairingExcluded} 条（NOT_EVALUATED 呈现）` : ""}）`
        : ""
    }`,
    true,
  );

  // 7. academic score ≥ 阈值（缺失评分视为不通过——不能因没评就通过）
  const academic = input.review.scores.academicScore;
  // M14.1a P0-2：覆盖不完整（长文档单元失败 / digest 有损）时，任何部分视图
  // 分数都不得推导全文学术质量——academic 规则强制 FAIL，独立于分数本身。
  const coverage = input.review.coverage;
  const coverageComplete = coverage?.complete ?? true;
  push(
    "academic_score_threshold",
    verdict(academic !== null && academic >= thresholds.academicPassScore && coverageComplete),
    academic === null
      ? "缺少 academic 评分"
      : `academicScore=${academic}（要求 ≥ ${thresholds.academicPassScore}）${
          input.review.academicScoreBasis !== undefined
            ? `；${input.review.academicScoreBasis.mode === "units_char_weighted" ? "长文档单元聚合分" : "整稿评分"}，尚未校准，不等同录用概率`
            : ""
        }${
          input.review.academicConfirmation?.triggered === true
            ? `；带内复核：${input.review.academicConfirmation.samples.length} 份独立样本 ${input.review.academicConfirmation.samples
                .map((sample) => sample.overallScore ?? "null")
                .join("/")} 取中位数`
            : ""
        }${coverageComplete ? "" : `；review coverage 不完整（${coverage!.mode} 模式 ${(coverage!.ratio * 100).toFixed(1)}%，失败单元 ${coverage!.failedUnits}）——部分视图分数不得推导全文学术质量`}`,
    true,
  );

  // 8. style risk ≤ 阈值
  const styleRisk = input.review.scores.styleRisk;
  push(
    "style_risk_threshold",
    verdict(styleRisk !== null && styleRisk <= thresholds.styleRiskMax),
    styleRisk === null ? "缺少 style 风险评分" : `styleRisk=${styleRisk}（要求 ≤ ${thresholds.styleRiskMax}）`,
    true,
  );

  // 8b. M14.1a P0-2：review 覆盖完整性——计划纳入审查的目标正文必须全部由成功
  // 完成的 Review Unit 覆盖。coverage 是确定性账本（不是模型自述）；旧产物无
  // 该字段 = digest 单轮语义，按不适用呈现（不改历史判定）。
  if (coverage === undefined) {
    push("review_coverage_complete_not_applicable", "NOT_APPLICABLE", "本轮 review 产物无 coverage 字段（legacy digest 单轮语义）");
  } else {
    push(
      "review_coverage_complete",
      verdict(coverage.complete),
      `${coverage.mode} 模式：实际完成审查 ${coverage.reviewedChars}/${coverage.targetChars} 字符` +
        `（${(coverage.ratio * 100).toFixed(1)}%；单元 ${coverage.completedUnits}/${coverage.targetUnits}，` +
        `失败 ${coverage.failedUnits}，复用 ${coverage.reusedUnits}；snapshot ${coverage.snapshotId.slice(0, 12)}）` +
        (coverage.complete ? "" : "——未覆盖正文不得被任何全文性结论（含学术分数）引用"),
      true,
    );
  }

  // 8c. M14.9.5.2：长文档单元模式的跨单元 / 跨章核对是否真的执行（informational：永远通过，只把未执行的核对
  // 显式写成 NOT_EVALUATED——「没有跨单元 / 跨章 finding」不得被读成「已核对且无问题」）
  if (coverage?.mode === "units") {
    const context = coverage.context;
    const gaps = (context?.contextIncompleteUnits ?? []).flatMap((entry) => entry.gaps.map((gap) => ({ unitId: entry.unitId, ...gap })));
    push(
      "review_unit_context_reported",
      context !== undefined && gaps.length > 0 ? "NOT_EVALUATED" : "INFO",
      context === undefined
        ? "shared_session：长文档单元共用一个审稿会话，单元能否看到其他单元的表 / 图 / 公式取决于会话历史（调度顺序、超时重建），跨单元核对未逐项记录、不可复现"
        : gaps.length === 0
          ? `${context.policy}：跨单元依赖 ${context.attachedDependencies} 项全部附上（${context.dependencyChars} 字，只读参考、不计覆盖率）`
          : `${context.policy}：${gaps.length} 处跨单元核对 NOT_EVALUATED（${gaps.slice(0, 6).map((gap) => `${gap.mention} ${gap.status}`).join("；")}${gaps.length > 6 ? "；…" : ""}）——对应单元未核对这些被引对象，不代表其一致`,
    );
    const cross = coverage.crossChapter ?? context?.crossChapter;
    push(
      "review_cross_chapter_reported",
      cross === undefined ? "INFO" : cross.status === "completed" ? "INFO" : cross.status === "skipped" ? "NOT_APPLICABLE" : "NOT_EVALUATED",
      cross === undefined
        ? "跨章一致性审查执行状态未记录（旧产物）"
        : cross.status === "completed"
          ? "跨章一致性审查已执行（跨章 finding 为待核验、不阻断）"
          : cross.status === "skipped"
            ? "只有一个章节：跨章一致性审查不适用"
            : `跨章一致性审查失败：跨章核对 NOT_EVALUATED（本轮没有跨章 finding 不代表没有跨章冲突）${"error" in cross && cross.error !== undefined ? `；${cross.error.slice(0, 120)}` : ""}`,
    );
  }

  // 9. 目标可行性达标（LOW / INSUFFICIENT 阻止 Final；用户知情接受不降低标准）
  // M10.3.1：existing_paper 的 task-aware 适用性在 detail 中可见（required
  // vs not_applicable 逐条留档于 feasibility.json；判定口径不变——level 仍由
  // 评估器诚实给出，不因 N/A 条目自动放行）
  // M14.9.5.4：未评估（null）照旧不阻断，但状态如实为 NOT_EVALUATED（不是「通过」）
  const feasibility = input.feasibility;
  const applicabilityNote =
    feasibility?.criterionApplicability !== undefined && feasibility.criterionApplicability.length > 0
      ? `（task-aware：required ${feasibility.criterionApplicability.filter((entry) => entry.applicability === "required").length} 项 / not_applicable ${feasibility.criterionApplicability.filter((entry) => entry.applicability === "not_applicable").length} 项，理由见 feasibility.json）`
      : "";
  if (feasibility === null) {
    push("target_feasibility", "NOT_EVALUATED", "本工作流未执行目标可行性评估（不阻断；不是「可行性已通过」）");
  } else if (!thresholds.requireFeasibility) {
    push("target_feasibility", "INFO", `feasibility=${feasibility.level}${applicabilityNote}（阈值配置不要求可行性档位）`);
  } else {
    push(
      "target_feasibility",
      verdict(feasibility.level === "HIGH" || feasibility.level === "MEDIUM"),
      `feasibility=${feasibility.level}${applicabilityNote}`,
      true,
    );
  }

  // 10-13. Citation Integrity（并入同一 Gate Engine，不另造平行体系）
  if (input.citationIntegrity !== undefined) {
    const integrity = input.citationIntegrity;
    // Layer 1（真实性 / metadata）规则始终参与——off 只关掉语义层
    push("citation_fabrication_zero", verdict(integrity.probableFabricated === 0), `confirmed/probable fabricated ${integrity.probableFabricated} 条`, true);
    push(
      "citation_not_found_obligatory_zero",
      verdict(integrity.notFoundObligatory === 0),
      `NOT_FOUND obligatory citation ${integrity.notFoundObligatory} 条（需人工判定）`,
      true,
    );
    push("citation_metadata_mismatch_critical_zero", verdict(integrity.mismatchCritical === 0), `title/DOI 级 mismatch ${integrity.mismatchCritical} 条`, true);
    // Layer 2（语义）规则只在语义核验开启时参与：off 时不因「没有 semantic records」
    // FAIL；contradiction_only 时 unsupportedCritical 天然只统计 CONTRADICTED
    const semanticMode = input.citationSemanticMode ?? "full";
    if (semanticMode === "off") {
      push("citation_semantic_verification_off", "NOT_EVALUATED", "本轮未开启引用语义核验（语义类规则不参与判定；引用是否支撑论断未检查）");
    } else {
      push(
        "citation_unsupported_critical_zero",
        verdict(integrity.unsupportedCritical === 0),
        `critical claim UNSUPPORTED/CONTRADICTED ${integrity.unsupportedCritical} 条`,
        true,
      );
      // INSUFFICIENT_EVIDENCE ≠ fabricated：不阻断，要求补证据/人工复核
      push("citation_insufficient_evidence_review", "INFO", `INSUFFICIENT_EVIDENCE ${integrity.insufficientEvidence} 条（人工复核，不阻断）`);
    }
  }

  // 14. Citation Preservation（M5.6 验收驱动）：修订不得无依据丢失既有引用
  if (input.citationPreservation !== undefined) {
    if (input.citationPreservation === null) {
      push("citation_preservation_not_applicable", "NOT_APPLICABLE", "无前序修订可比较（首轮 / 快照缺失 / 用户恢复历史修订）；引用保持规则不参与判定");
    } else {
      push("citation_keys_preserved", verdict(input.citationPreservation.ok), describeCitationPreservation(input.citationPreservation), true);
    }
  }

  // 15. Fact Preservation（M5.6 第二层，pair-02 盲评驱动）：修订不得无依据
  // 改写 / 删除 / 弱化既有实验事实，也不得新增无 Evidence 依据的实验细节
  if (input.factPreservation !== undefined) {
    if (input.factPreservation === null) {
      push("fact_preservation_not_applicable", "NOT_APPLICABLE", "无前序修订可比较（首轮 / 快照缺失 / 用户恢复历史修订）；实验事实保持规则不参与判定");
    } else {
      push("fact_preservation", verdict(input.factPreservation.ok), describeFactPreservation(input.factPreservation), true);
    }
  }

  // 15b. Cumulative Fact Preservation（M10.3.1 G1）：Frozen Baseline → Current。
  // previous→current 干净不等于安全——历史未授权漂移必须跨轮保持 unresolved，
  // 直到恢复基线值或获（已批准计划 / Evidence）授权。Final 必须通过本规则；
  // Draft 不阻断但 unresolved 明细随产物与报告可见（不隐藏）。
  if (input.cumulativeFactPreservation !== undefined) {
    if (input.cumulativeFactPreservation === null) {
      push(
        "cumulative_fact_preservation_not_applicable",
        "NOT_APPLICABLE",
        // computeCumulativeFactPreservation 的 null 有多种成因（idea_to_paper 无冻结导入稿 /
        // existing-paper 冻结基线之后尚无修订 / 快照缺失），这里不能断言项目类型（M14.9.5.3）
        "累计事实不可比较（无导入冻结基线，或冻结基线之后尚无修订 / 快照缺失）；累计事实保持规则不参与判定",
      );
    } else {
      push(
        "cumulative_fact_preservation",
        verdict(input.cumulativeFactPreservation.ok),
        describeCumulativeFactPreservation(input.cumulativeFactPreservation),
        true,
      );
    }
  }

  // 16. Evidence Citation Coverage（M6.6 §13）：正文引用 ↔ Verified Evidence。
  // 默认只呈现（可检测不阻断——M6.6 接入期存量项目覆盖率必然低）；
  // requireEvidenceBackedCitations=true 时未覆盖引用阻断 Final。
  if (input.evidenceCitationCoverage !== undefined) {
    const evidenceCoverage = input.evidenceCitationCoverage;
    const enforcing = thresholds.requireEvidenceBackedCitations === true;
    if (enforcing) {
      push(
        "citations_evidence_backed",
        verdict(evidenceCoverage.uncovered.length === 0),
        `无 verified evidence 对应的引用 ${evidenceCoverage.uncovered.length} 条${
          evidenceCoverage.uncovered.length > 0 ? `（${evidenceCoverage.uncovered.slice(0, 5).join("、")}）` : ""
        }`,
        true,
      );
    } else {
      push(
        "citations_evidence_backed",
        "INFO",
        `引用覆盖：${evidenceCoverage.covered.length}/${evidenceCoverage.covered.length + evidenceCoverage.uncovered.length} 有 verified evidence（未覆盖 ${evidenceCoverage.uncovered.length} 条：${
          evidenceCoverage.uncovered.length > 0 ? evidenceCoverage.uncovered.slice(0, 5).join("、") : "无"
        }；人工复核，不阻断）`,
      );
    }
  }

  // 17-18. Revision Gate（M6.7 §10）：修订条目全部解决 + claim 强度守卫。
  // 用户 approve 决策覆盖自动判定（HITL 明示接受已知风险，记录在案）。
  if (input.revisionValidation !== undefined) {
    const validation = input.revisionValidation;
    const userApproved = validation.userDecision?.decision === "approve";
    const counts = countItemStatuses(validation);
    push(
      "revision_items_resolved",
      verdict(userApproved || (counts.rejected === 0 && counts.needsReview === 0)),
      userApproved
        ? `修订条目 validated=${counts.validated} rejected=${counts.rejected} needs_review=${counts.needsReview}；用户已在修订验证 HITL 明示接受（${validation.validationId}）`
        : `修订条目 validated=${counts.validated} rejected=${counts.rejected} needs_review=${counts.needsReview}（${validation.validationId}；rejected 须重派发解决，needs_review 须人工确认后才能 Final）`,
      true,
    );
    const blocks = validation.claimStrength.filter((finding) => finding.action === "block");
    const warnings = validation.claimStrength.filter((finding) => finding.action === "warning");
    push(
      "claim_strength_guard",
      verdict(userApproved || blocks.length === 0),
      blocks.length === 0 && warnings.length === 0
        ? "无 claim 强度升级问题"
        : describeClaimStrengthFindings(validation.claimStrength) +
          (userApproved ? "；用户已明示接受" : ""),
      true,
    );
  }

  // 19-22. Survey Writing（M11.2 §十二：保守分档——契约违约 blocking，
  // 启发式 metrics 只呈现不阻断；family 失衡 / 罗列倾向交 Reviewer 与人工）
  if (input.surveyWriting !== undefined) {
    const evaluation = input.surveyWriting;
    const byCode = (code: string) => evaluation.blockers.filter((blocker) => blocker.code === code);
    const dangling = byCode("dangling_refs");
    const fakeKeys = byCode("fake_citation_key");
    const untraceable = byCode("synthesis_untraceable");
    push(
      "survey_outline_contract",
      verdict(dangling.length === 0),
      dangling.length === 0
        ? "outline refs 契约完好（synthesis / literature refs 全部可回溯）"
        : `悬空 refs ${dangling.length} 处：${dangling.slice(0, 3).map((blocker) => blocker.detail).join("；")}`,
      true,
    );
    push(
      "survey_citation_keys_valid",
      verdict(fakeKeys.length === 0),
      fakeKeys.length === 0
        ? "正文引用 key 全部在 bibliography 白名单内"
        : `越界 key ${fakeKeys.length} 处：${fakeKeys.slice(0, 3).map((blocker) => blocker.detail).join("；")}`,
      true,
    );
    push(
      "survey_synthesis_traceability",
      verdict(untraceable.length === 0),
      untraceable.length === 0
        ? `evidence_backed synthesis 可回溯 ${evaluation.metrics.evidenceBackedUsed}/${evaluation.metrics.evidenceBackedTotal}`
        : untraceable[0]!.detail,
      true,
    );
    const { metrics } = evaluation;
    push(
      "survey_writing_metrics",
      "INFO",
      `文献覆盖 ${metrics.citedLiterature}/${metrics.totalLiterature}；多源引用占比 ${(metrics.multiKeyCiteRatio * 100).toFixed(0)}%；`
        + `单文献段落占比 ${(metrics.singleKeyParagraphRatio * 100).toFixed(0)}%；罗列游程 ${metrics.listingRuns}；`
        + `speculative 泄漏信号 ${metrics.speculativeLeakSignals}`
        + (evaluation.warnings.length > 0 ? `；warnings ${evaluation.warnings.length} 条（明细见产物）` : ""),
    );
  }

  // M14.2 thesis_from_papers：学位论文确定性规则（已确认事实零漂移 / 映射冻结 / 结构完整 / 冲突清零）
  if (input.thesis !== undefined) {
    const thesis = input.thesis;
    push(
      "published_facts_zero_drift",
      verdict(thesis.drift.unauthorized === 0),
      thesis.drift.unauthorized === 0
        ? `已确认事实比对：一致 ${thesis.drift.consistent} / 等价形态 ${thesis.drift.equivalentFormat} / 未引用 ${thesis.drift.absent}（共 ${thesis.drift.checked} 条，零未授权变更）`
        : `未授权事实变更 ${thesis.drift.unauthorized} 处：${thesis.drift.findings.filter((finding) => finding.status === "unauthorized").slice(0, 3).map((finding) => `${finding.surface} → ${finding.observedValue ?? "?"}（${finding.detail}）`).join("；")}`,
      true,
    );
    const mappingOk =
      thesis.mapping.exists && thesis.mapping.confirmed && thesis.mapping.fingerprintMatchesOutline &&
      thesis.mapping.invalidSourceInputs.length === 0 && thesis.mapping.invalidFactIds.length === 0;
    push(
      "thesis_mapping_confirmed",
      verdict(mappingOk),
      !thesis.mapping.exists
        ? "章节映射产物缺失（chapter-mapping.json 不存在）"
        : !thesis.mapping.confirmed
          ? "章节映射未经作者确认（hitl.outline_confirm 未 approve）"
          : !thesis.mapping.fingerprintMatchesOutline
            ? "章节映射与当前大纲结构不一致（outline 已变化，映射失效）"
            : mappingOk
              ? `章节映射已确认且与大纲一致（${thesis.mapping.invalidSourceInputs.length} 个失效来源 / ${thesis.mapping.invalidFactIds.length} 个失效事实）`
              : `映射引用失效：来源 ${thesis.mapping.invalidSourceInputs.join("、") || "无"}；事实 ${thesis.mapping.invalidFactIds.join("、") || "无"}`,
      true,
    );
    push(
      "thesis_structure_complete",
      verdict(thesis.structureViolations.length === 0),
      thesis.structureViolations.length === 0
        ? "ThesisDocumentModel 装配校验通过（每节恰好映射一章）"
        : `结构违规 ${thesis.structureViolations.length} 处：${thesis.structureViolations.slice(0, 3).join("；")}`,
      true,
    );
    push(
      "thesis_conflicts_resolved",
      verdict(thesis.conflictsUnresolved === 0),
      thesis.conflictsUnresolved === 0
        ? "研究事实冲突全部裁决（无未决阻断）"
        : `仍有 ${thesis.conflictsUnresolved} 条未裁决冲突——未裁决数值不得出现在正文`,
      true,
    );
    // M14.3：继承表格守卫（存在已插入资产时必现；数值 / 行列 / 标记块漂移 = FAIL）
    if (thesis.tables !== undefined) {
      const broken = thesis.tables.findings.filter((finding) => !finding.ok);
      push(
        "inherited_tables_intact",
        verdict(broken.length === 0),
        broken.length === 0
          ? `继承表格守卫：${thesis.tables.intact}/${thesis.tables.checked} 资产完整（数值 / 行列 / 标记块一致）`
          : `继承表格漂移 ${broken.length} 处：${broken.slice(0, 3).map((finding) => `${finding.assetId}（${finding.violations.slice(0, 2).join("；")}）`).join("；")}`,
        true,
      );
    }
    // M14.6：双语摘要 + 关键词（缺失 → 结构不完整；Draft 仍可构建，不得标 Final/READY）
    if (thesis.abstract !== undefined) {
      push("thesis_abstract_complete", verdict(thesis.abstract.present), thesis.abstract.detail, true);
    }
    // M14.7：摘要快照绑定——摘要存在但绑定快照与当前正文 / 事实 / 决定不一致 → ABSTRACT_STALE
    //（M14.6 遗留：Draft 保留写作期摘要且无任何过期标记）。Draft 仍可构建预览，但不得视为摘要同步。
    if (thesis.abstract !== undefined && thesis.abstract.snapshotCurrent !== undefined) {
      push("thesis_abstract_snapshot_current", verdict(thesis.abstract.snapshotCurrent), thesis.abstract.snapshotDetail ?? "", true);
    }
    // M14.6：工作流元注记不得进入正文（高置信词面；Writer 写作期已剥离，此处是终检）
    if (thesis.metaNotes !== undefined) {
      push(
        "workflow_meta_notes_absent",
        verdict(thesis.metaNotes.hits === 0),
        thesis.metaNotes.hits === 0
          ? "正文未检出工作流元注记（高置信词面）"
          : `正文检出 ${thesis.metaNotes.hits} 处工作流元注记：${thesis.metaNotes.samples.slice(0, 3).join("；")}`,
        true,
      );
    }
    // M14.6：模板化表达（advisory——不阻断；进入 Reviewer style 视图与报告）
    if (thesis.templatedPhrasing !== undefined) {
      push(
        "templated_phrasing_reported",
        "INFO",
        thesis.templatedPhrasing.findings === 0
          ? "未检出模板化小结 / 公式化过渡"
          : `模板化表达 ${thesis.templatedPhrasing.findings} 处（${Object.entries(thesis.templatedPhrasing.byKind).map(([kind, count]) => `${kind} ${count}`).join(" / ")}）——advisory 不阻断；如 ${thesis.templatedPhrasing.samples[0] ?? ""}`,
      );
    }
    // M14.6：学术引用存在性——零幻觉 ≠ 证据充足。文献综述章 / 文献主题声明时适用：
    // 检索通道可用而零引用 → 学术质量缺口（FAIL）；检索降级（provider 不可用）→ 如实报告缺口但不
    // 以阻断掩盖工程配置问题（规则 detail 明示「学术引用缺口」）。
    if (thesis.citations !== undefined) {
      const c = thesis.citations;
      const zero = c.citedCount === 0;
      // 阻断条件：适用 + 零引用 + Writer 确实拿到了可引用材料（正式 Evidence 或 bib 条目）——
      // 否则（检索降级 / 候选未能成为正式证据）是材料缺口而非 Writer 缺陷，如实报告但不阻断
      const citable = c.formalEvidence > 0 || c.bibEntries > 0;
      const blocking = c.applicable && zero && citable;
      push(
        "thesis_citations_present",
        !c.applicable ? "NOT_APPLICABLE" : !zero ? "PASS" : !citable ? "NOT_EVALUATED" : "FAIL",
        !c.applicable
          ? `无文献综述章 / 文献主题声明——引用存在性不适用（cited=${c.citedCount}）`
          : !zero
            ? `正文引用 ${c.citedCount} 个 bib key（正式 Evidence ${c.formalEvidence} 条 / bib 条目 ${c.bibEntries}）`
            : !citable
              ? `学术引用缺口：正文零引用且无可引用的正式 Evidence / bib 条目（${c.supplyDegraded ? "学术检索降级 / 不可用" : "检索有候选但未形成正式 Evidence"}）——零幻觉不等于证据充足；非阻断（材料缺口不以 Gate 掩盖），Draft 不得视为引用完整`
              : `学术引用缺口：已有可引用材料（正式 Evidence ${c.formalEvidence} 条 / bib 条目 ${c.bibEntries}）但正文零引用——文献综述 / 绪论须引用已核验文献`,
        blocking || c.applicable && !zero,
      );
    }
    // M14.3：跨章一致性（advisory——恒过；确认的未授权数值变更由零漂移规则阻断）
    if (thesis.consistency !== undefined) {
      const c = thesis.consistency;
      push(
        "cross_chapter_consistency_reported",
        "INFO",
        `跨章确定性检查：术语 ${c.checked.terms} / 事实键 ${c.checked.factKeys} / label ${c.checked.references} / 章 ${c.checked.chapters}；` +
          `发现 ${c.findings} 条（疑似 ${c.suspicious}）——advisory 不阻断${c.topFindings.length > 0 ? `；如 ${c.topFindings[0]}` : ""}`,
      );
    }
  }

  const reasons = rules.filter((rule) => !rule.passed).map((rule) => `${rule.rule}: ${rule.detail}`);
  return {
    passed: reasons.length === 0,
    reasons,
    rules,
    thresholds,
    checkedAt: new Date().toISOString(),
    verification: summarizeGateVerification(rules),
    // M12 A9：advisory 透传（零规则参与——targetReadiness 不影响本函数任何判定）
    ...(input.targetReadiness !== undefined ? { targetReadiness: input.targetReadiness } : {}),
  };
}

/** M14.9.5.4：规则状态 → 核验完整性摘要（旧产物 / 外部追加的规则没有 status 时按 passed 归 PASS / FAIL） */
export function summarizeGateVerification(rules: readonly QualityGateRule[]): QualityGateVerificationSummary {
  const counts: Record<QualityGateRuleStatus, number> = { PASS: 0, FAIL: 0, NOT_EVALUATED: 0, NOT_APPLICABLE: 0, INFO: 0, ADVISORY: 0 };
  const notEvaluated: QualityGateVerificationSummary["notEvaluated"] = [];
  const notApplicable: string[] = [];
  for (const rule of rules) {
    const status = rule.status ?? (rule.passed ? "PASS" : "FAIL");
    counts[status] += 1;
    if (status === "NOT_EVALUATED") notEvaluated.push({ rule: rule.rule, required: rule.required === true, detail: rule.detail });
    if (status === "NOT_APPLICABLE") notApplicable.push(rule.rule);
  }
  return { requiredComplete: notEvaluated.every((entry) => !entry.required), notEvaluated, notApplicable, counts };
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
    cumulativeFactPreservation?: CumulativeFactValidation | null;
    evidenceCitationCoverage?: EvidenceCitationCoverage;
    revisionValidation?: RevisionValidationResult;
    surveyWriting?: SurveyWritingEvaluation;
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
    // M10.3.1 G1：累计事实保持明细（Frozen → Current；restore stage / 报告消费）
    ...(extras.cumulativeFactPreservation !== undefined
      ? { cumulativeFactPreservation: extras.cumulativeFactPreservation }
      : {}),
    // M6.6：引用 ↔ verified evidence 覆盖明细（UI / 审计可见）
    ...(extras.evidenceCitationCoverage !== undefined
      ? { evidenceCitationCoverage: extras.evidenceCitationCoverage }
      : {}),
    // M6.7：修订条目复核明细（Revision Gate 两条规则的输入；UI / 审计可见）
    ...(extras.revisionValidation !== undefined ? { revisionValidation: extras.revisionValidation } : {}),
    // M11.2：综述写作契约判定 + metrics 明细（survey 三条 blocking 规则的输入）
    ...(extras.surveyWriting !== undefined ? { surveyWriting: extras.surveyWriting } : {}),
    ...(typeof summary.reviewedRevision === "number"
      ? { revision: summary.reviewedRevision, reviewedRevision: summary.reviewedRevision }
      : {}),
  });
  return `reviews/${file}`;
}
