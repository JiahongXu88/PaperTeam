/**
 * reviews/ 目录产物的读写（Workflow 与 HTTP 层共用；此前两边各自 readdir + 正则）。
 *
 * 文件命名：
 *   review-summary-r{n}.json    三路审稿聚合（idea_to_paper / existing_paper_improvement）
 *   existing-review-r{n}.json   已有论文只读 Review 聚合报告（existing_paper_review）
 *   quality-gate-r{n}.json      按轮 Quality Gate 结果（{gate, reviewSummary} 同轮配对）
 *   revision-validation-r{n}.json  修订写入后的条目级复核（M6.7 Revision Safety）
 * round 从 1 递增；「最新」= 编号最大。
 */

import { mkdir, readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { ProjectStore } from "../project/ProjectStore.js";
import { writeJsonAtomic } from "../util/atomic.js";
import type { QualityGateResult } from "../quality/gates.js";
import type { CitationPreservationSummary } from "../quality/citationPreservation.js";
import type { FactPreservationSummary } from "../quality/factPreservation.js";
import type { CumulativeFactValidation } from "../quality/cumulativeFactPreservation.js";
import type { ReviewSummary } from "./ReviewAggregator.js";
import { reviewUnitFileName, type ReviewCoverageSummary, type ReviewUnitRecord } from "./coverageLedger.js";
import type { ClaimGroundingReport } from "./claimGrounding.js";
import type { ClaimCheckLedger } from "../experiments/claimChecks.js";
import type { ClaimResolutionReport } from "./claimResolution.js";
import type { ClaimGapAudit } from "./claimGapAudit.js";
import type { RevisionPlan } from "./revisionPlan.js";
import type { RevisionValidationResult } from "./revisionValidation.js";
import type { IterationRecord } from "./revisionOutcome.js";
import type { BestRevisionArtifact } from "./bestRevision.js";
import type { StylePolishResult } from "./stylePolicy.js";
import type { SurveyWritingEvaluation } from "../survey/writingInvariants.js";
import type { PatchCandidateRecord, PatchValidationArtifact } from "./patchValidation.js";
import type { AcademicRedundancyReport } from "./academicRedundancyClassifier.js";

const SUMMARY_PATTERN = /^review-summary-r(\d+)\.json$/;
const EXISTING_REVIEW_PATTERN = /^existing-review-r(\d+)\.json$/;
const GATE_PATTERN = /^quality-gate-r(\d+)\.json$/;
const PLAN_PATTERN = /^revision-plan-r(\d+)\.json$/;
const VALIDATION_PATTERN = /^revision-validation-r(\d+)\.json$/;
const CLAIM_GROUNDING_PATTERN = /^claim-grounding-r(\d+)\.json$/;
const SURVEY_WRITING_PATTERN = /^survey-writing-r(\d+)\.json$/;
const ACADEMIC_REDUNDANCY_PATTERN = /^academic-redundancy-rev(\d+)\.json$/;

/**
 * M13.7.10：写作期论证单元计划（reviews/writing-plan.json，最新一次写作覆盖）。
 * 记录 section 的 role / 任务摘要 / 分配与实际消费的 Evidence ID / 选证依据与不足
 * 原因 / 本节引用 key / 模型 usage 与耗时——可追溯、可诊断；不是第二套 Outline，
 * 不参与任何 Gate 判定。
 */
/** M15.1 shadow 审计产物种类（M15.4.3 起含 candidate-shadow：CandidateProposer 影子旁路产物） */
export type M151AuditKind = "claim-audit" | "citation-audit" | "quality-decision-v2-shadow" | "finding-adjudication" | "candidate-shadow";

export interface WritingPlanSectionRecord {
  sectionId: string;
  title: string;
  /** M14.1a P0-3：输出文件名（manuscript/sections/ 下；恢复核验定位输出产物） */
  fileName?: string;
  /** M14.1a P0-3：完成时的输出内容哈希（与磁盘一致才允许恢复跳过） */
  outputHash?: string;
  role: "framing" | "develop" | "compare" | "conclude";
  roleSource: string;
  roleConfidence: string;
  taskSummary: string;
  doNotExplain: string[];
  targetLengthUpperBound: number;
  lengthSource: string;
  evidence: {
    allocated: string[];
    consumed: string[];
    pinned: string[];
    pinnedRejected: Array<{ id: string; reason: string }>;
    coverageAdded: string[];
    partial: string[];
  };
  citationKeys: { evidenceBacked: string[]; allowed?: string[]; cited?: string[] };
  diagnostics: string[];
  usage?: unknown;
  latencyMs?: number;
  taskId?: string;
  status: "planned" | "written" | "failed";
}

export interface WritingPlanArtifact {
  schemaVersion: 1;
  mode: "idea_to_paper" | "topic_survey" | "thesis_from_papers";
  runId: string;
  createdAt: string;
  updatedAt: string;
  /** outline 结构 + 正式证据集合的指纹（同输入恒同计划；不同 → 如实记录 previousFingerprint） */
  fingerprint: string;
  previousFingerprint?: string;
  attempt: number;
  revision?: number;
  sections: WritingPlanSectionRecord[];
  unassignedEvidence: string[];
  warnings: string[];
}

/** M13.7.10：全文草稿生成后的只读 Academic Redundancy Report（按修订号落盘） */
export interface AcademicRedundancyArtifact {
  schemaVersion: 1;
  revision: number;
  runId: string;
  createdAt: string;
  roles: AcademicRedundancyReport["roles"];
  summary: AcademicRedundancyReport["summary"];
  harmfulSentences: AcademicRedundancyReport["harmfulSentences"];
  uncertainSentences: AcademicRedundancyReport["uncertainSentences"];
  signpostSentences: AcademicRedundancyReport["signpostSentences"];
  /** 有界的候选 pair（含原句与分类）；完整探测器输出不落盘 */
  pairs: AcademicRedundancyReport["pairs"];
  /** 评价器已知不确定性（M13.7.9 §2.3 三处盲区的当前状态） */
  knownLimitations: string[];
}

/** 按轮落盘的 Quality Gate 产物（saveQualityGateReport 的结构） */
export interface QualityGateArtifact {
  round: number;
  gate: QualityGateResult;
  /** 评估时消费的同轮审稿汇总（round 配对由文件结构保证，不跨轮拼装） */
  reviewSummary: ReviewSummary;
  /** 该轮 review 审阅的 manuscript 修订（M4.7 stale 防护；旧产物缺省） */
  reviewedRevision?: number;
  /** 引用保持明细（M5.6；null = 不可比较；旧产物缺省） */
  citationPreservation?: CitationPreservationSummary | null;
  /** 实验事实保持明细（M5.6 第二层；null = 不可比较；旧产物缺省） */
  factPreservation?: FactPreservationSummary | null;
  /** 累计事实保持明细（M10.3.1 G1；null = 无导入基线不可比较；旧产物缺省） */
  cumulativeFactPreservation?: CumulativeFactValidation | null;
}

export class ReviewArtifactStore {
  constructor(private readonly projects: ProjectStore) {}

  // ---- M13.7.10：写作计划 / 学术重复报告 ----

  writingPlanFileName(): string {
    return "writing-plan.json";
  }

  async saveWritingPlan(projectId: string, plan: WritingPlanArtifact): Promise<string> {
    const fileName = this.writingPlanFileName();
    await writeJsonAtomic(join(this.projects.reviewsDir(projectId), fileName), plan);
    return `reviews/${fileName}`;
  }

  async loadWritingPlan(projectId: string): Promise<WritingPlanArtifact | null> {
    return this.readJson<WritingPlanArtifact>(projectId, this.writingPlanFileName());
  }

  academicRedundancyFileName(revision: number): string {
    return `academic-redundancy-rev${revision}.json`;
  }

  async saveAcademicRedundancy(projectId: string, artifact: AcademicRedundancyArtifact): Promise<string> {
    const fileName = this.academicRedundancyFileName(artifact.revision);
    await writeJsonAtomic(join(this.projects.reviewsDir(projectId), fileName), artifact);
    return `reviews/${fileName}`;
  }

  /** 最新（修订号最大）的学术重复报告；无 / 损坏 → null */
  async latestAcademicRedundancy(projectId: string): Promise<AcademicRedundancyArtifact | null> {
    const revisions = await this.rounds(projectId, ACADEMIC_REDUNDANCY_PATTERN);
    const latest = revisions[0];
    if (latest === undefined) {
      return null;
    }
    return this.readJson<AcademicRedundancyArtifact>(projectId, this.academicRedundancyFileName(latest));
  }

  summaryFileName(round: number): string {
    return `review-summary-r${round}.json`;
  }

  existingReviewFileName(round: number): string {
    return `existing-review-r${round}.json`;
  }

  /** 下一轮三路审稿的 round（已有文件编号最大值 + 1） */
  async nextSummaryRound(projectId: string): Promise<number> {
    const rounds = await this.rounds(projectId, SUMMARY_PATTERN);
    return (rounds[0] ?? 0) + 1;
  }

  async saveSummary(projectId: string, round: number, summary: ReviewSummary): Promise<string> {
    const fileName = this.summaryFileName(round);
    await writeJsonAtomic(join(this.projects.reviewsDir(projectId), fileName), summary);
    return `reviews/${fileName}`;
  }

  /** 最新三路审稿聚合（无则 null；损坏文件视为不存在） */
  async latestSummary(projectId: string): Promise<ReviewSummary | null> {
    const rounds = await this.rounds(projectId, SUMMARY_PATTERN);
    const latest = rounds[0];
    if (latest === undefined) {
      return null;
    }
    return this.readJson<ReviewSummary>(projectId, this.summaryFileName(latest));
  }

  /** 全部三路审稿聚合（按 round 升序） */
  async listSummaries(projectId: string): Promise<ReviewSummary[]> {
    const rounds = (await this.rounds(projectId, SUMMARY_PATTERN)).sort((a, b) => a - b);
    const summaries: ReviewSummary[] = [];
    for (const round of rounds) {
      const summary = await this.readJson<ReviewSummary>(projectId, this.summaryFileName(round));
      if (summary !== null) {
        summaries.push(summary);
      }
    }
    return summaries;
  }

  // ---- M14.1a P0-2：Review Coverage Ledger（单元 journal + 覆盖汇总，原子写） ----

  async saveReviewUnitRecord(projectId: string, record: ReviewUnitRecord): Promise<void> {
    const roundDir = join(this.projects.reviewsDir(projectId), "review-units", `r${record.round}`);
    await mkdir(roundDir, { recursive: true });
    await writeJsonAtomic(join(roundDir, reviewUnitFileName(record.unitId)), record);
  }

  /** 该轮全部单元 journal 记录（目录缺失 / 单文件损坏 → 空表，如实降级） */
  async loadReviewUnitRecords(projectId: string, round: number): Promise<ReviewUnitRecord[]> {
    const roundDir = join(this.projects.reviewsDir(projectId), "review-units", `r${round}`);
    let names: string[];
    try {
      names = await readdir(roundDir);
    } catch {
      return [];
    }
    const records: ReviewUnitRecord[] = [];
    for (const name of names.filter((entry) => entry.endsWith(".json"))) {
      try {
        const parsed = JSON.parse(await readFile(join(roundDir, name), "utf8")) as ReviewUnitRecord;
        if (typeof parsed.unitId === "string" && (parsed.status === "completed" || parsed.status === "failed")) {
          records.push(parsed);
        }
      } catch {
        // 单条 journal 损坏：跳过该单元（其覆盖状态由失败 / 缺失如实反映）
      }
    }
    return records;
  }

  reviewCoverageFileName(round: number): string {
    return `review-coverage-r${round}.json`;
  }

  async saveReviewCoverage(projectId: string, round: number, coverage: ReviewCoverageSummary): Promise<string> {
    const fileName = this.reviewCoverageFileName(round);
    await writeJsonAtomic(join(this.projects.reviewsDir(projectId), fileName), coverage);
    return `reviews/${fileName}`;
  }

  async loadReviewCoverage(projectId: string, round: number): Promise<ReviewCoverageSummary | null> {
    return this.readJson<ReviewCoverageSummary>(projectId, this.reviewCoverageFileName(round));
  }

  async saveExistingReview(projectId: string, round: number, report: unknown): Promise<string> {
    const fileName = this.existingReviewFileName(round);
    await writeJsonAtomic(join(this.projects.reviewsDir(projectId), fileName), report);
    return `reviews/${fileName}`;
  }

  // ---- Survey Writing Evaluation（M11.2：按轮的综述写作契约 + metrics） ----

  surveyWritingFileName(round: number): string {
    return `survey-writing-r${round}.json`;
  }

  /**
   * M13 Final Closure（任务 B）：带内复核的额外 academic 样本逐份落盘
   * （academic-confirmation-r{round}-s{index}.json；不与 review-r*-academic.json 撞名）。
   */
  async saveAcademicConfirmationSample(
    projectId: string,
    round: number,
    index: number,
    sample: unknown,
  ): Promise<string> {
    const fileName = `academic-confirmation-r${round}-s${index}.json`;
    await writeJsonAtomic(join(this.projects.reviewsDir(projectId), fileName), {
      round,
      sampleIndex: index,
      savedAt: new Date().toISOString(),
      ...(typeof sample === "object" && sample !== null ? (sample as Record<string, unknown>) : { sample }),
    });
    return `reviews/${fileName}`;
  }

  async saveSurveyWriting(
    projectId: string,
    round: number,
    evaluation: SurveyWritingEvaluation,
  ): Promise<string> {
    const fileName = this.surveyWritingFileName(round);
    await writeJsonAtomic(
      join(this.projects.reviewsDir(projectId), fileName),
      { round, evaluatedAt: new Date().toISOString(), ...evaluation },
    );
    return `reviews/${fileName}`;
  }

  /** 某一轮的 Survey Writing 评估（无文件 / 损坏 → null） */
  async loadSurveyWriting(
    projectId: string,
    round: number,
  ): Promise<(SurveyWritingEvaluation & { round: number }) | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        await readFile(join(this.projects.reviewsDir(projectId), this.surveyWritingFileName(round)), "utf8"),
      );
    } catch {
      return null;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      !Array.isArray((parsed as Record<string, unknown>)["blockers"]) ||
      typeof (parsed as Record<string, unknown>)["metrics"] !== "object"
    ) {
      return null;
    }
    return parsed as SurveyWritingEvaluation & { round: number };
  }

  /** 已落盘的 survey-writing 轮次编号，降序（最新在前） */
  async surveyWritingRounds(projectId: string): Promise<number[]> {
    return this.rounds(projectId, SURVEY_WRITING_PATTERN);
  }

  // ---- Quality Gate 产物（按轮） ----

  gateFileName(round: number): string {
    return `quality-gate-r${round}.json`;
  }

  /** 已落盘的 gate 轮次编号，降序（最新在前） */
  async gateRounds(projectId: string): Promise<number[]> {
    return this.rounds(projectId, GATE_PATTERN);
  }

  /**
   * 读取某一轮的 gate 产物（无文件或结构损坏 → null）。
   * 防御性校验与 readFinding 同一思路：磁盘 JSON 不盲信。
   */
  async loadGate(projectId: string, round: number): Promise<QualityGateArtifact | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        await readFile(join(this.projects.reviewsDir(projectId), this.gateFileName(round)), "utf8"),
      );
    } catch {
      return null;
    }
    if (typeof parsed !== "object" || parsed === null) {
      return null;
    }
    const record = parsed as Record<string, unknown>;
    const gate = readGateResult(record["gate"]);
    const reviewSummary = record["reviewSummary"];
    if (
      gate === null ||
      typeof reviewSummary !== "object" ||
      reviewSummary === null ||
      typeof (reviewSummary as Record<string, unknown>)["round"] !== "number"
    ) {
      return null;
    }
    return {
      round,
      gate,
      reviewSummary: reviewSummary as ReviewSummary,
      ...(typeof record["reviewedRevision"] === "number"
        ? { reviewedRevision: record["reviewedRevision"] }
        : {}),
      ...(readCitationPreservation(record["citationPreservation"])),
      ...(readFactPreservation(record["factPreservation"])),
      ...(readCumulativeFactPreservation(record["cumulativeFactPreservation"])),
    };
  }

  /** 全部轮次的 gate 产物（按 round 降序；损坏轮次跳过） */
  async listGates(projectId: string): Promise<QualityGateArtifact[]> {
    const rounds = await this.gateRounds(projectId);
    const artifacts: QualityGateArtifact[] = [];
    for (const round of rounds) {
      const artifact = await this.loadGate(projectId, round);
      if (artifact !== null) {
        artifacts.push(artifact);
      }
    }
    return artifacts;
  }

  /** 最新已有论文 Review 聚合报告（无则 null） */
  async latestExistingReview(projectId: string): Promise<Record<string, unknown> | null> {
    const rounds = await this.rounds(projectId, EXISTING_REVIEW_PATTERN);
    const latest = rounds[0];
    if (latest === undefined) {
      return null;
    }
    return this.readJson<Record<string, unknown>>(projectId, this.existingReviewFileName(latest));
  }

  // ---- Claim Grounding 报告（M9.7.6：fact claims 的确定性证据绑定统计） ----

  claimGroundingFileName(round: number): string {
    return `claim-grounding-r${round}.json`;
  }

  /** M13 Final Closure（A4）：多 key 引用归因观察（只读产物；citation-attribution-r{round}.json） */
  async saveMultiKeyAttribution(projectId: string, round: number, report: unknown): Promise<string> {
    const fileName = `citation-attribution-r${round}.json`;
    await writeJsonAtomic(join(this.projects.reviewsDir(projectId), fileName), {
      round,
      ...(typeof report === "object" && report !== null ? (report as Record<string, unknown>) : { report }),
    });
    return `reviews/${fileName}`;
  }

  /**
   * M14.9.5.4：同轮实验论断复算账本（reviews/claim-checks-r{round}.json）。review.run 在审稿前计算并注入 prompt，
   * quality.gate 消费同一份（计划在审稿后变更时由 gate 重算并标注）。
   */
  async saveClaimCheckLedger(projectId: string, round: number, ledger: ClaimCheckLedger): Promise<string> {
    const fileName = `claim-checks-r${round}.json`;
    await mkdir(this.projects.reviewsDir(projectId), { recursive: true });
    await writeJsonAtomic(join(this.projects.reviewsDir(projectId), fileName), { round, ...ledger });
    return `reviews/${fileName}`;
  }

  async loadClaimCheckLedger(projectId: string, round: number): Promise<ClaimCheckLedger | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(join(this.projects.reviewsDir(projectId), `claim-checks-r${round}.json`), "utf8"));
    } catch {
      return null;
    }
    const record = parsed as Record<string, unknown> | null;
    if (record === null || typeof record !== "object" || !Array.isArray(record["results"]) || typeof record["ledgerHash"] !== "string") return null;
    return parsed as ClaimCheckLedger;
  }

  /**
   * M15.1：版本化 shadow 审计产物（claim-audit / citation-audit / quality-decision-v2-shadow，按轮 reviews/*-r{round}.json）。
   * 读取方只认匹配 schema 的对象；是否与被审修订一致由 claimAudit.validateClaimAudit 判定。
   */
  async saveAuditArtifact(projectId: string, kind: M151AuditKind, round: number, artifact: unknown): Promise<string> {
    const fileName = `${kind}-r${round}.json`;
    await mkdir(this.projects.reviewsDir(projectId), { recursive: true });
    await writeJsonAtomic(join(this.projects.reviewsDir(projectId), fileName), artifact);
    return `reviews/${fileName}`;
  }

  async loadAuditArtifact<T>(projectId: string, kind: M151AuditKind, round: number, schema: string): Promise<T | null> {
    const parsed = await this.readJson<Record<string, unknown>>(projectId, `${kind}-r${round}.json`);
    if (parsed === null || typeof parsed !== "object" || parsed["schema"] !== schema) return null;
    return parsed as T;
  }

  async saveClaimGrounding(projectId: string, report: ClaimGroundingReport): Promise<string> {
    const fileName = this.claimGroundingFileName(report.round);
    await writeJsonAtomic(join(this.projects.reviewsDir(projectId), fileName), report);
    return `reviews/${fileName}`;
  }

  /**
   * 读取某一轮的 Claim Grounding 报告（无文件 / 结构损坏 → null；旧项目
   * （M9.7.6 之前）没有该产物属正常态，调用方按 legacy 跳过 Claim Repair）。
   */
  async loadClaimGrounding(projectId: string, round: number): Promise<ClaimGroundingReport | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        await readFile(join(this.projects.reviewsDir(projectId), this.claimGroundingFileName(round)), "utf8"),
      );
    } catch {
      return null;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>)["reportId"] !== "string" ||
      typeof (parsed as Record<string, unknown>)["round"] !== "number" ||
      !Array.isArray((parsed as Record<string, unknown>)["claims"])
    ) {
      return null;
    }
    return parsed as ClaimGroundingReport;
  }

  /** 最新一轮 Claim Grounding 报告（无则 null） */
  async latestClaimGrounding(projectId: string): Promise<ClaimGroundingReport | null> {
    const rounds = await this.rounds(projectId, CLAIM_GROUNDING_PATTERN);
    const round = rounds[0];
    return round === undefined ? null : this.loadClaimGrounding(projectId, round);
  }

  // ---- Claim Resolution（M11.2.3：Unsupported Claim Resolution Contract，按轮） ----

  claimResolutionFileName(round: number): string {
    return `claim-resolution-r${round}.json`;
  }

  async saveClaimResolution(projectId: string, report: ClaimResolutionReport): Promise<string> {
    const fileName = this.claimResolutionFileName(report.round);
    await writeJsonAtomic(join(this.projects.reviewsDir(projectId), fileName), report);
    return `reviews/${fileName}`;
  }

  /**
   * 读取某一轮的 Claim Resolution（无文件 / 结构损坏 → null；非 survey 或
   * M11.2.3 之前的项目没有该产物属正常态）。
   */
  async loadClaimResolution(projectId: string, round: number): Promise<ClaimResolutionReport | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        await readFile(join(this.projects.reviewsDir(projectId), this.claimResolutionFileName(round)), "utf8"),
      );
    } catch {
      return null;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>)["round"] !== "number" ||
      !Array.isArray((parsed as Record<string, unknown>)["resolutions"])
    ) {
      return null;
    }
    return parsed as ClaimResolutionReport;
  }

  // ---- Claim Gap Audit（M10.3.1 G2：task-aware 适用性审计，按轮） ----

  claimGapAuditFileName(round: number): string {
    return `claim-gap-audit-r${round}.json`;
  }

  async saveClaimGapAudit(projectId: string, audit: ClaimGapAudit): Promise<string> {
    const fileName = this.claimGapAuditFileName(audit.round);
    await writeJsonAtomic(join(this.projects.reviewsDir(projectId), fileName), audit);
    return `reviews/${fileName}`;
  }

  async loadClaimGapAudit(projectId: string, round: number): Promise<ClaimGapAudit | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        await readFile(join(this.projects.reviewsDir(projectId), this.claimGapAuditFileName(round)), "utf8"),
      );
    } catch {
      return null;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>)["reportId"] !== "string" ||
      typeof (parsed as Record<string, unknown>)["round"] !== "number" ||
      !Array.isArray((parsed as Record<string, unknown>)["claims"])
    ) {
      return null;
    }
    return parsed as ClaimGapAudit;
  }

  // ---- Revision Plan 与迭代历史（M4.7） ----

  planFileName(round: number): string {
    return `revision-plan-r${round}.json`;
  }

  /** 已落盘的 quality 修订计划轮次（降序） */
  async planRounds(projectId: string): Promise<number[]> {
    return this.rounds(projectId, PLAN_PATTERN);
  }

  async savePlan(projectId: string, plan: RevisionPlan): Promise<string> {
    const fileName = this.planFileName(plan.reviewRound);
    await writeJsonAtomic(join(this.projects.reviewsDir(projectId), fileName), plan);
    return `reviews/${fileName}`;
  }

  /** 读取某一轮的修订计划（无文件 / 结构损坏 → null） */
  async loadPlan(projectId: string, round: number): Promise<RevisionPlan | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        await readFile(join(this.projects.reviewsDir(projectId), this.planFileName(round)), "utf8"),
      );
    } catch {
      return null;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>)["planId"] !== "string" ||
      !Array.isArray((parsed as Record<string, unknown>)["items"])
    ) {
      return null;
    }
    return parsed as RevisionPlan;
  }

  // ---- Revision Validation 产物（M6.7：修订写入后、复审前的条目级复核结果） ----

  validationFileName(round: number): string {
    return `revision-validation-r${round}.json`;
  }

  async saveValidation(projectId: string, result: RevisionValidationResult): Promise<string> {
    const fileName = this.validationFileName(result.reviewRound);
    await writeJsonAtomic(join(this.projects.reviewsDir(projectId), fileName), result);
    return `reviews/${fileName}`;
  }

  patchValidationFileName(revision: number): string { return `patch-validation-rev-${revision}.json`; }

  async savePatchValidation(projectId: string, artifact: PatchValidationArtifact): Promise<string> {
    const fileName = this.patchValidationFileName(artifact.revision);
    /**
     * M14.8.1-MOT（真实继续返修实录）：被拒候选的 fail-closed 记录写在「当前修订号」下；
     * 同一项目上的后续 run 从同一修订号出发时，会覆盖上一个 run 写下的、记录该修订**如何
     * 产生**的补丁校验（M14.8 run 的 rev-2 产生记录被新 run 的被拒记录整体覆盖）。覆盖前若
     * 既有记录不是新记录的子集（不同 run / 不同 stage），原样保留到 supersededArtifacts。
     */
    const path = join(this.projects.reviewsDir(projectId), fileName);
    let next: PatchValidationArtifact = artifact;
    try {
      const existing = JSON.parse(await readFile(path, "utf8")) as PatchValidationArtifact;
      if (existing.revision === artifact.revision && Array.isArray(existing.records)) {
        // revision.validate 会把非终态记录移入 attemptHistory——按 records ∪ attemptHistory 判子集，
        // 同一 stage / run 的重组不产生冗余副本
        const incoming = new Set([...artifact.records, ...(artifact.attemptHistory ?? [])].map((record) => JSON.stringify(record)));
        const subset = [...existing.records, ...(existing.attemptHistory ?? [])].every((record) => incoming.has(JSON.stringify(record)));
        const carried = existing.supersededArtifacts ?? [];
        const { supersededArtifacts: _ignored, ...existingBody } = existing;
        next = {
          ...artifact,
          ...(subset
            ? (carried.length > 0 ? { supersededArtifacts: carried } : {})
            : { supersededArtifacts: [...carried, { ...existingBody, supersededAt: new Date().toISOString() }] }),
        };
      }
    } catch { /* no prior artifact */ }
    await writeJsonAtomic(path, next);
    return `reviews/${fileName}`;
  }

  async loadPatchValidation(projectId: string, revision: number): Promise<PatchValidationArtifact | null> {
    try {
      const parsed = JSON.parse(await readFile(join(this.projects.reviewsDir(projectId), this.patchValidationFileName(revision)), "utf8")) as PatchValidationArtifact;
      return parsed.revision === revision && Array.isArray(parsed.records) ? parsed : null;
    } catch { return null; }
  }

  /**
   * M14.8.1-MOT：补丁候选原文落盘（接受与拒绝都记录）。M14.8 真实返修 13/16 个候选被拒
   * 却只留下 hash——事后无法区分守卫误拒、Writer 越界与管线格式错误。候选按
   * reviews/patch-candidates/rev-{N}/{patchId}.json 存放（单个 span ≤ 数万字符，有界）。
   */
  async savePatchCandidate(projectId: string, revisionId: string, record: PatchCandidateRecord): Promise<string> {
    const safeRevision = revisionId.replace(/[^a-zA-Z0-9_-]+/g, "_");
    const safePatch = record.patchId.replace(/[^a-zA-Z0-9_.-]+/g, "_").slice(0, 80);
    const relative = join("patch-candidates", safeRevision, `${safePatch}.json`);
    await mkdir(join(this.projects.reviewsDir(projectId), "patch-candidates", safeRevision), { recursive: true });
    await writeJsonAtomic(join(this.projects.reviewsDir(projectId), relative), record);
    return `reviews/${relative.replaceAll("\\", "/")}`;
  }

  async listPatchCandidates(projectId: string, revisionId: string): Promise<PatchCandidateRecord[]> {
    const dir = join(this.projects.reviewsDir(projectId), "patch-candidates", revisionId.replace(/[^a-zA-Z0-9_-]+/g, "_"));
    let names: string[];
    try { names = await readdir(dir); } catch { return []; }
    const records: PatchCandidateRecord[] = [];
    for (const name of names.filter((entry) => entry.endsWith(".json")).sort()) {
      try { records.push(JSON.parse(await readFile(join(dir, name), "utf8")) as PatchCandidateRecord); } catch { /* corrupt entry skipped */ }
    }
    return records;
  }

  /** 读取某一轮的验证产物（无文件 / 结构损坏 → null；防御性校验同 loadGate） */
  async loadValidation(projectId: string, round: number): Promise<RevisionValidationResult | null> {
    let parsed: unknown;
    try {
      parsed = JSON.parse(
        await readFile(join(this.projects.reviewsDir(projectId), this.validationFileName(round)), "utf8"),
      );
    } catch {
      return null;
    }
    if (
      typeof parsed !== "object" ||
      parsed === null ||
      typeof (parsed as Record<string, unknown>)["validationId"] !== "string" ||
      typeof (parsed as Record<string, unknown>)["revision"] !== "number" ||
      !Array.isArray((parsed as Record<string, unknown>)["items"])
    ) {
      return null;
    }
    return parsed as RevisionValidationResult;
  }

  /** 最新一轮验证产物（无则 null） */
  async latestValidation(projectId: string): Promise<RevisionValidationResult | null> {
    const rounds = await this.rounds(projectId, VALIDATION_PATTERN);
    const round = rounds[0];
    return round === undefined ? null : this.loadValidation(projectId, round);
  }

  // ---- Style polish（M5.4）：与 quality 修订计划分文件，互不覆盖 ----

  stylePlanFileName(round: number): string {
    return `style-plan-r${round}.json`;
  }

  stylePolishFileName(round: number): string {
    return `style-polish-r${round}.json`;
  }

  async saveStylePlan(projectId: string, plan: RevisionPlan): Promise<string> {
    const fileName = this.stylePlanFileName(plan.reviewRound);
    await writeJsonAtomic(join(this.projects.reviewsDir(projectId), fileName), plan);
    return `reviews/${fileName}`;
  }

  async loadStylePlan(projectId: string, round: number): Promise<RevisionPlan | null> {
    const parsed = await this.readJson<RevisionPlan>(projectId, this.stylePlanFileName(round));
    return parsed !== null && typeof parsed.planId === "string" && Array.isArray(parsed.items) ? parsed : null;
  }

  async saveStylePolishResult(projectId: string, result: StylePolishResult): Promise<string> {
    const fileName = this.stylePolishFileName(result.reviewRound);
    await writeJsonAtomic(join(this.projects.reviewsDir(projectId), fileName), result);
    return `reviews/${fileName}`;
  }

  async loadStylePolishResult(projectId: string, round: number): Promise<StylePolishResult | null> {
    const parsed = await this.readJson<StylePolishResult>(projectId, this.stylePolishFileName(round));
    return parsed !== null && typeof parsed.planId === "string" && typeof parsed.status === "string" ? parsed : null;
  }

  /** 最新一轮 style polish 结果（无则 null） */
  async latestStylePolishResult(projectId: string): Promise<StylePolishResult | null> {
    const rounds = await this.rounds(projectId, /^style-polish-r(\d+)\.json$/);
    const round = rounds[0];
    return round === undefined ? null : this.loadStylePolishResult(projectId, round);
  }

  /** 最新一轮 style plan（无则 null） */
  async latestStylePlan(projectId: string): Promise<RevisionPlan | null> {
    const rounds = await this.rounds(projectId, /^style-plan-r(\d+)\.json$/);
    const round = rounds[0];
    return round === undefined ? null : this.loadStylePlan(projectId, round);
  }

  /** 迭代历史（reviews/iteration-history.json；quality.gate 逐轮追加） */
  async loadIterations(projectId: string): Promise<IterationRecord[]> {
    try {
      const parsed = JSON.parse(
        await readFile(join(this.projects.reviewsDir(projectId), "iteration-history.json"), "utf8"),
      ) as { iterations?: unknown };
      return Array.isArray(parsed["iterations"]) ? (parsed["iterations"] as IterationRecord[]) : [];
    } catch {
      return [];
    }
  }

  async appendIteration(projectId: string, record: IterationRecord): Promise<void> {
    const iterations = await this.loadIterations(projectId);
    // 幂等：同一 gateRound 只保留一条（stage 重放不重复追加）
    const next = iterations.filter((item) => item.gateRound !== record.gateRound);
    next.push(record);
    next.sort((a, b) => a.gateRound - b.gateRound);
    await writeJsonAtomic(join(this.projects.reviewsDir(projectId), "iteration-history.json"), {
      schemaVersion: 1,
      iterations: next,
    });
  }

  /** M14.4：最佳合法版本工件（reviews/best-revision.json；quality.gate 更新，终局恢复消费） */
  async loadBestRevision(projectId: string): Promise<BestRevisionArtifact | null> {
    try {
      const parsed = JSON.parse(
        await readFile(join(this.projects.reviewsDir(projectId), "best-revision.json"), "utf8"),
      ) as BestRevisionArtifact;
      return typeof parsed.revision === "number" && typeof parsed.gateRound === "number" ? parsed : null;
    } catch {
      return null;
    }
  }

  async saveBestRevision(projectId: string, artifact: BestRevisionArtifact): Promise<void> {
    await writeJsonAtomic(join(this.projects.reviewsDir(projectId), "best-revision.json"), {
      schemaVersion: 1,
      ...artifact,
    });
  }

  async exists(projectId: string, fileName: string): Promise<boolean> {
    try {
      await readFile(join(this.projects.reviewsDir(projectId), fileName));
      return true;
    } catch {
      return false;
    }
  }

  /** 匹配到的 round 编号，降序 */
  private async rounds(projectId: string, pattern: RegExp): Promise<number[]> {
    let names: string[];
    try {
      names = await readdir(this.projects.reviewsDir(projectId));
    } catch {
      return [];
    }
    return names
      .map((name) => pattern.exec(name))
      .filter((match): match is RegExpExecArray => match !== null)
      .map((match) => Number(match[1]))
      .filter((round) => Number.isInteger(round) && round > 0)
      .sort((a, b) => b - a);
  }

  private async readJson<T>(projectId: string, fileName: string): Promise<T | null> {
    try {
      return JSON.parse(await readFile(join(this.projects.reviewsDir(projectId), fileName), "utf8")) as T;
    } catch {
      return null;
    }
  }
}

/** gate 产物中的引用保持明细（null 如实保留；结构损坏 → 视为缺省） */
function readCitationPreservation(value: unknown): { citationPreservation?: CitationPreservationSummary | null } {
  if (value === null) {
    return { citationPreservation: null };
  }
  if (typeof value !== "object") {
    return {};
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record["ok"] !== "boolean" ||
    !Array.isArray(record["unexpectedRemovedKeys"]) ||
    typeof record["previousCount"] !== "number" ||
    typeof record["currentCount"] !== "number"
  ) {
    return {};
  }
  return { citationPreservation: value as CitationPreservationSummary };
}

/** gate 产物中的实验事实保持明细（M5.6 第二层；null 如实保留；结构损坏 → 缺省） */
function readFactPreservation(value: unknown): { factPreservation?: FactPreservationSummary | null } {
  if (value === null) {
    return { factPreservation: null };
  }
  if (typeof value !== "object") {
    return {};
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record["ok"] !== "boolean" ||
    typeof record["previousRevision"] !== "number" ||
    typeof record["currentRevision"] !== "number" ||
    !Array.isArray(record["changedFacts"]) ||
    !Array.isArray(record["removedFacts"]) ||
    !Array.isArray(record["addedUnsupportedFacts"]) ||
    !Array.isArray(record["directionalChanges"]) ||
    !Array.isArray(record["formulaChanges"]) ||
    !Array.isArray(record["placeholderRegressions"])
  ) {
    return {};
  }
  return { factPreservation: value as FactPreservationSummary };
}

function readCumulativeFactPreservation(
  value: unknown,
): { cumulativeFactPreservation?: CumulativeFactValidation | null } {
  if (value === null) {
    return { cumulativeFactPreservation: null };
  }
  if (typeof value !== "object") {
    return {};
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record["ok"] !== "boolean" ||
    typeof record["baselineRevision"] !== "number" ||
    typeof record["currentRevision"] !== "number" ||
    !Array.isArray(record["unresolvedViolations"])
  ) {
    return {};
  }
  return { cumulativeFactPreservation: value as CumulativeFactValidation };
}

/** QualityGateResult 的防御性读取（结构损坏 → null，不盲信磁盘 JSON） */
function readGateResult(value: unknown): QualityGateResult | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record["passed"] !== "boolean" ||
    !Array.isArray(record["reasons"]) ||
    !Array.isArray(record["rules"]) ||
    !record["rules"].every(
      (rule) =>
        typeof rule === "object" &&
        rule !== null &&
        typeof (rule as Record<string, unknown>)["rule"] === "string" &&
        typeof (rule as Record<string, unknown>)["passed"] === "boolean" &&
        typeof (rule as Record<string, unknown>)["detail"] === "string",
    ) ||
    typeof record["checkedAt"] !== "string" ||
    typeof record["thresholds"] !== "object" ||
    record["thresholds"] === null ||
    typeof (record["thresholds"] as Record<string, unknown>)["academicPassScore"] !== "number" ||
    typeof (record["thresholds"] as Record<string, unknown>)["styleRiskMax"] !== "number"
  ) {
    return null;
  }
  return value as QualityGateResult;
}
