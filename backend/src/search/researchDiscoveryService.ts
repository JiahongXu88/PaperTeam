/**
 * ResearchDiscoveryService：Discovery 编排层（M6.1 ADR §3；对外唯一入口）。
 *
 * 职责：academic / web 发现检索 + Provider Health 观测 + **显式** Candidate 持久化。
 *
 * Search Result ≠ SourceItem ≠ Evidence（D-0033 红线）：
 * - 检索结果默认只返回（进程内），一次 100 条结果不无条件污染 sources/candidates.json；
 * - 持久化必须显式选择结果子集（saveAcademicCandidates / saveWebCandidates 的
 *   resultIndexes），经 CandidateStore 身份判重写入 pending 候选；
 * - promotion（candidate → Literature Library）仍由 SourceImportService.promoteCandidate
 *   幂等执行；EvidenceStore 在本链路中不存在——snippet 最高支撑 plausible 属 M6.5。
 */

import { BusinessError } from "../errors.js";
import type { CandidateSource } from "../sources/CandidateStore.js";
import type { CandidateStore } from "../sources/CandidateStore.js";
import { buildIdentity } from "../sources/identity.js";
import type { AcademicSearchResponse, AcademicSearchService } from "./academicSearchService.js";
import type { FusedAcademicResult } from "./fusion.js";
import type { ProviderHealthSnapshot } from "./providerHttp.js";
import type { SearchOptions, WebSearchResult } from "./types.js";
import type { WebSearchResponse, WebSearchService } from "./webSearchService.js";

export interface ProviderHealthReport {
  academic: ProviderHealthSnapshot[];
  web: ProviderHealthSnapshot[];
}

export interface SavedCandidatesResult {
  saved: CandidateSource[];
  /** 同身份已有 pending 候选（合并补充而非新建）的结果下标 */
  mergedExisting: number[];
}

export interface ResearchDiscoveryServiceOptions {
  academic: AcademicSearchService;
  web: WebSearchService;
  candidates: CandidateStore;
}

export class ResearchDiscoveryService {
  private readonly academic: AcademicSearchService;
  private readonly web: WebSearchService;
  private readonly candidates: CandidateStore;

  constructor(options: ResearchDiscoveryServiceOptions) {
    this.academic = options.academic;
    this.web = options.web;
    this.candidates = options.candidates;
  }

  academicSearch(query: string, opts: SearchOptions = {}): Promise<AcademicSearchResponse> {
    return this.academic.search(query, opts);
  }

  webSearch(query: string, opts: SearchOptions = {}): Promise<WebSearchResponse> {
    return this.web.search(query, opts);
  }

  /** 把选中的学术结果显式存为候选（origin=academic_search；provenance 带 query） */
  async saveAcademicCandidates(
    projectId: string,
    query: string,
    results: FusedAcademicResult[],
    resultIndexes: number[],
  ): Promise<SavedCandidatesResult> {
    validateIndexes(resultIndexes, results.length);
    const saved: CandidateSource[] = [];
    const mergedExisting: number[] = [];
    for (const index of resultIndexes) {
      const fused = results[index]!;
      const record = fused.record;
      const result = await this.candidates.add(projectId, {
        identity: fused.identity,
        ...(record.doi !== undefined ? { doi: record.doi } : {}),
        ...(record.arxivId !== undefined ? { arxivId: record.arxivId } : {}),
        ...(record.url !== undefined ? { url: record.url } : {}),
        ...(record.title !== undefined ? { title: record.title } : {}),
        ...(record.authors !== undefined ? { authors: record.authors } : {}),
        ...(record.year !== undefined ? { year: record.year } : {}),
        ...(record.venue !== undefined ? { venue: record.venue } : {}),
        ...(record.abstract !== undefined ? { snippetOrAbstract: record.abstract } : {}),
        query,
        origin: "academic_search",
        // 主来源 = 融合后最强 provider（fusion 排序保证 sources[0]）
        provider: fused.sources[0]?.provider ?? "academic_search",
      });
      if (result.created) {
        saved.push(result.candidate);
      } else {
        mergedExisting.push(index);
      }
    }
    return { saved, mergedExisting };
  }

  /** 把选中的 Web 结果显式存为候选（origin=web_search；canonical URL 为身份键） */
  async saveWebCandidates(
    projectId: string,
    query: string,
    results: WebSearchResult[],
    resultIndexes: number[],
  ): Promise<SavedCandidatesResult> {
    validateIndexes(resultIndexes, results.length);
    const saved: CandidateSource[] = [];
    const mergedExisting: number[] = [];
    for (const index of resultIndexes) {
      const result0 = results[index]!;
      const identity = buildIdentity({ url: result0.url, title: result0.title });
      if (identity === null) {
        throw new BusinessError("INVALID_REQUEST", `Web 结果 #${index} 缺少可判等身份（URL）`);
      }
      const result = await this.candidates.add(projectId, {
        identity,
        url: result0.url,
        title: result0.title,
        snippetOrAbstract: result0.snippet,
        query,
        origin: "web_search",
        provider: result0.provider,
      });
      if (result.created) {
        saved.push(result.candidate);
      } else {
        mergedExisting.push(index);
      }
    }
    return { saved, mergedExisting };
  }

  providerHealth(): ProviderHealthReport {
    return { academic: this.academic.healthSnapshots(), web: this.web.healthSnapshots() };
  }
}

function validateIndexes(indexes: number[], length: number): void {
  if (indexes.length === 0) {
    throw new BusinessError("INVALID_REQUEST", "resultIndexes 不能为空（显式保存语义：至少选择一条结果）");
  }
  for (const index of indexes) {
    if (!Number.isInteger(index) || index < 0 || index >= length) {
      throw new BusinessError(
        "INVALID_REQUEST",
        `resultIndexes 含越界下标 ${index}（结果共 ${length} 条，下标 0-${Math.max(length - 1, 0)}）`,
      );
    }
  }
}
