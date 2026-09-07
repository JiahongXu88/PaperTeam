/**
 * reviews/ 目录产物的读写（Workflow 与 HTTP 层共用；此前两边各自 readdir + 正则）。
 *
 * 文件命名：
 *   review-summary-r{n}.json    三路审稿聚合（idea_to_paper / existing_paper_improvement）
 *   existing-review-r{n}.json   已有论文只读 Review 聚合报告（existing_paper_review）
 * round 从 1 递增；「最新」= 编号最大。
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";

import type { ProjectStore } from "../project/ProjectStore.js";
import { writeJsonAtomic } from "../util/atomic.js";
import type { ReviewSummary } from "./ReviewAggregator.js";

const SUMMARY_PATTERN = /^review-summary-r(\d+)\.json$/;
const EXISTING_REVIEW_PATTERN = /^existing-review-r(\d+)\.json$/;

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

  /** 最新已有论文 Review 聚合报告（无则 null） */
  async latestExistingReview(projectId: string): Promise<Record<string, unknown> | null> {
    const rounds = await this.rounds(projectId, EXISTING_REVIEW_PATTERN);
    const latest = rounds[0];
    if (latest === undefined) {
      return null;
    }
    return this.readJson<Record<string, unknown>>(projectId, this.existingReviewFileName(latest));
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
