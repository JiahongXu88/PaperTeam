/**
 * reviews/ 目录产物的读写（Workflow 与 HTTP 层共用；此前两边各自 readdir + 正则）。
 *
 * 文件命名：
 *   review-summary-r{n}.json    三路审稿聚合（idea_to_paper / existing_paper_improvement）
 *   existing-review-r{n}.json   已有论文只读 Review 聚合报告（existing_paper_review）
 *   quality-gate-r{n}.json      按轮 Quality Gate 结果（{gate, reviewSummary} 同轮配对）
 * round 从 1 递增；「最新」= 编号最大。
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { ProjectStore } from "../project/ProjectStore.js";
import { writeJsonAtomic } from "../util/atomic.js";
import type { QualityGateResult } from "../quality/gates.js";
import type { ReviewSummary } from "./ReviewAggregator.js";
import type { RevisionPlan } from "./revisionPlan.js";
import type { IterationRecord } from "./revisionOutcome.js";

const SUMMARY_PATTERN = /^review-summary-r(\d+)\.json$/;
const EXISTING_REVIEW_PATTERN = /^existing-review-r(\d+)\.json$/;
const GATE_PATTERN = /^quality-gate-r(\d+)\.json$/;

/** 按轮落盘的 Quality Gate 产物（saveQualityGateReport 的结构） */
export interface QualityGateArtifact {
  round: number;
  gate: QualityGateResult;
  /** 评估时消费的同轮审稿汇总（round 配对由文件结构保证，不跨轮拼装） */
  reviewSummary: ReviewSummary;
  /** 该轮 review 审阅的 manuscript 修订（M4.7 stale 防护；旧产物缺省） */
  reviewedRevision?: number;
}

export class ReviewArtifactStore {
  constructor(private readonly projects: ProjectStore) {}

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

  async saveExistingReview(projectId: string, round: number, report: unknown): Promise<string> {
    const fileName = this.existingReviewFileName(round);
    await writeJsonAtomic(join(this.projects.reviewsDir(projectId), fileName), report);
    return `reviews/${fileName}`;
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

  // ---- Revision Plan 与迭代历史（M4.7） ----

  planFileName(round: number): string {
    return `revision-plan-r${round}.json`;
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
