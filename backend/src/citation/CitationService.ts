/**
 * Citation 业务服务（M3.1）。
 *
 * 两层核验：
 *   Layer 1 静态检查（确定性，永远可用）
 *   Layer 2 metadata verification（CrossRef / OpenAlex / arXiv，顺序调用、
 *     超时与网络故障 → unverifiable，绝不等于 not_found）
 *
 * 结果落盘 reviews/citation-report.json；报告包含：
 *   missing / unused / duplicate（静态）与 not_found / mismatch（metadata，
 *   即 hallucinated citation 候选）。
 */

import { mkdir } from "node:fs/promises";
import { join } from "node:path";

import type { ProjectStore } from "../project/ProjectStore.js";
import { writeJsonAtomic } from "../util/atomic.js";
import { collectLatexFiles } from "../manuscript/LatexFiles.js";
import { checkCitations, type CitationCheckResult } from "./StaticCitationChecker.js";
import {
  CrossRefProvider,
  OpenAlexProvider,
  ArxivProvider,
  type CitationMetadataProvider,
  type MetadataVerificationResult,
} from "./metadataProviders.js";

export interface CitationReport {
  generatedAt: string;
  static: CitationCheckResult;
  metadata: {
    enabled: boolean;
    providers: string[];
    checked: number;
    skipped: number;
    results: MetadataVerificationResult[];
    byStatus: { verified: number; mismatch: number; not_found: number; unverifiable: number };
  };
  /** 汇总（Quality Gate 消费；hallucinated = metadata not_found） */
  summary: {
    citedCount: number;
    missingKeys: number;
    unusedKeys: number;
    duplicateKeys: number;
    badCitations: number;
    hallucinated: number;
    mismatched: number;
    unverifiable: number;
  };
}

export interface CitationServiceOptions {
  projects: ProjectStore;
  /** metadata 核验开关（默认 true；关闭时仅静态层） */
  metadataEnabled?: boolean;
  /** 最多核验多少条 bib 条目（rate-limit friendly，默认 20） */
  maxMetadataLookups?: number;
  /** 单请求超时（默认 8000ms） */
  metadataTimeoutMs?: number;
  /** CrossRef 礼仪邮箱（可选） */
  contactEmail?: string;
  /** 可注入 fetch（测试） */
  fetchImpl?: typeof fetch;
  /** 可注入 provider 列表（测试） */
  providers?: CitationMetadataProvider[];
  now?: () => Date;
  log?: (message: string) => void;
}

export class CitationService {
  private readonly projects: ProjectStore;
  private readonly metadataEnabled: boolean;
  private readonly maxLookups: number;
  private readonly timeoutMs: number;
  private readonly contactEmail?: string;
  private readonly fetchImpl: typeof fetch;
  private readonly providers: CitationMetadataProvider[];
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(options: CitationServiceOptions) {
    this.projects = options.projects;
    this.metadataEnabled = options.metadataEnabled ?? true;
    this.maxLookups = options.maxMetadataLookups ?? 20;
    this.timeoutMs = options.metadataTimeoutMs ?? 8_000;
    this.contactEmail = options.contactEmail;
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.providers = options.providers ?? [
      new CrossRefProvider(),
      new OpenAlexProvider(),
      new ArxivProvider(),
    ];
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  reportPath(projectId: string): string {
    return join(this.projects.reviewsDir(projectId), "citation-report.json");
  }

  /** 执行核验并落盘报告 */
  async verify(projectId: string): Promise<CitationReport> {
    await this.projects.getRequired(projectId);
    const files = await collectLatexFiles(this.projects.manuscriptDir(projectId));
    const staticResult = checkCitations(
      files.allTex.map((file) => ({ file: file.relativePath, content: file.content })),
      files.bibContent,
    );

    // Layer 2：只核验「被正文引用」的条目，按优先级（有 DOI 优先），顺序调用
    const citedSet = new Set(staticResult.citedKeys);
    const candidates = staticResult.bibEntries
      .filter((entry) => citedSet.has(entry.key))
      .sort((a, b) => (b.doi ? 1 : 0) - (a.doi ? 1 : 0))
      .slice(0, this.maxLookups);

    const results: MetadataVerificationResult[] = [];
    if (this.metadataEnabled) {
      const ctx = {
        fetchImpl: this.fetchImpl,
        timeoutMs: this.timeoutMs,
        ...(this.contactEmail ? { contactEmail: this.contactEmail } : {}),
      };
      for (const entry of candidates) {
        // 每个 provider 依次尝试：verified 即停止；not_found 与 unverifiable 区分记录
        const perProvider: MetadataVerificationResult[] = [];
        for (const provider of this.providers) {
          const result = await provider.verify(entry, ctx);
          perProvider.push(result);
          if (result.status === "verified" || result.status === "mismatch") {
            break; // 有明确比对结论即停止
          }
        }
        const decisive = decideMetadataResult(perProvider);
        if (decisive !== undefined) {
          results.push(decisive);
        }
      }
    }

    const byStatus = { verified: 0, mismatch: 0, not_found: 0, unverifiable: 0 };
    for (const result of results) {
      byStatus[result.status] += 1;
    }

    const report: CitationReport = {
      generatedAt: this.now().toISOString(),
      static: staticResult,
      metadata: {
        enabled: this.metadataEnabled,
        providers: this.providers.map((provider) => provider.name),
        checked: results.length,
        skipped: Math.max(0, candidates.length - results.length),
        results,
        byStatus,
      },
      summary: {
        citedCount: staticResult.citedKeys.length,
        missingKeys: staticResult.missingKeys.length,
        unusedKeys: staticResult.unusedKeys.length,
        duplicateKeys: staticResult.duplicateKeys.length,
        badCitations: staticResult.badCitations.length,
        hallucinated: byStatus.not_found,
        mismatched: byStatus.mismatch,
        unverifiable: byStatus.unverifiable,
      },
    };

    const reviewsDir = this.projects.reviewsDir(projectId);
    await mkdir(reviewsDir, { recursive: true });
    await writeJsonAtomic(this.reportPath(projectId), report);
    this.log(
      `[citation] projectId=${projectId} 核验完成：cited=${report.summary.citedCount} missing=${report.summary.missingKeys} hallucinated=${report.summary.hallucinated}`,
    );
    return report;
  }

  /** 读取最近一次报告 */
  async latestReport(projectId: string): Promise<CitationReport | null> {
    const { readFile } = await import("node:fs/promises");
    try {
      return JSON.parse(
        await readFile(this.reportPath(projectId), "utf8"),
      ) as CitationReport;
    } catch {
      return null;
    }
  }
}

/** 单个来源 not_found 视为权威所需的最少来源数（与 ScholarlyResolver 同一口径） */
const NOT_FOUND_QUORUM = 2;

/**
 * 多来源结果 → 单条结论。
 * verified / mismatch 是明确比对结论，直接采用；not_found 只有在至少两个来源都
 * 未找到、且没有任何来源查询失败时才成立——一个来源覆盖不全（如 arXiv 之于期刊
 * 论文）或网络抖动都不能把真实文献判成 hallucinated（该字段会让 Quality Gate 硬失败）。
 */
export function decideMetadataResult(
  perProvider: readonly MetadataVerificationResult[],
): MetadataVerificationResult | undefined {
  const decisive = perProvider.find((r) => r.status === "verified" || r.status === "mismatch");
  if (decisive !== undefined) {
    return decisive;
  }
  const notFound = perProvider.filter((r) => r.status === "not_found");
  const unverifiable = perProvider.filter((r) => r.status === "unverifiable");
  if (notFound.length >= NOT_FOUND_QUORUM && unverifiable.length === 0) {
    return {
      ...notFound[0]!,
      provider: notFound.map((r) => r.provider).join("+"),
      note: `${notFound.length} 个来源均未找到（${notFound.map((r) => r.provider).join("、")}）`,
    };
  }
  const fallback = unverifiable[0] ?? notFound[0] ?? perProvider[perProvider.length - 1];
  if (fallback === undefined) {
    return undefined;
  }
  if (fallback.status === "not_found") {
    return {
      ...fallback,
      status: "unverifiable",
      note: `仅 ${notFound.length} 个来源未找到，不足以判定不存在（需要 ${NOT_FOUND_QUORUM} 个来源一致且无查询失败）`,
    };
  }
  return fallback;
}
