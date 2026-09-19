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
 *
 * M7.1a P-B：Agent 会话内的 save_candidates 工具经进程内检索缓存按下标回放
 * （saveCandidatesFromCache）。缓存是 derived 状态——不落盘、重启即失（检索默认
 * 零持久化 D-0035 不变）；保存仍汇聚到 saveAcademic/WebCandidates 单一写入口径，
 * 元数据只能来自 provider 真实返回，Agent 无法按值伪造入库。
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

/** 检索缓存条目（save_candidates 的回放源；kind 判别联合保证结果类型不混用） */
type CachedSearch =
  | { kind: "academic"; query: string; results: FusedAcademicResult[]; cachedAt: number }
  | { kind: "web"; query: string; results: WebSearchResult[]; cachedAt: number };

/** 每项目缓存的最大检索数（LRU 上限；超出淘汰最久未使用） */
const MAX_CACHED_SEARCHES_PER_PROJECT = 5;
/** 缓存有效期：超时视为 miss，调用方需重新检索（下标只对最近一次检索有效） */
const SEARCH_CACHE_TTL_MS = 10 * 60 * 1000;
/** save_candidates 单次可保存的条数硬帽（防滥存） */
const MAX_SAVE_CANDIDATES_PER_CALL = 25;

export interface ResearchDiscoveryServiceOptions {
  academic: AcademicSearchService;
  web: WebSearchService;
  candidates: CandidateStore;
}

export class ResearchDiscoveryService {
  private readonly academic: AcademicSearchService;
  private readonly web: WebSearchService;
  private readonly candidates: CandidateStore;
  /**
   * 进程内检索缓存（projectId → 最近检索，LRU；M7.1a save_candidates 的回放源）。
   * derived 状态：不落盘、重启即失，不是持久化候选的另一种形态。
   */
  private readonly searchCache = new Map<string, CachedSearch[]>();

  constructor(options: ResearchDiscoveryServiceOptions) {
    this.academic = options.academic;
    this.web = options.web;
    this.candidates = options.candidates;
  }

  /**
   * 学术检索。projectId 传入时（Agent 会话内检索）把结果写入项目检索缓存，
   * 供 save_candidates 按下标回放；缺省（HTTP 直调等）行为与 M6 完全一致。
   */
  async academicSearch(
    query: string,
    opts: SearchOptions = {},
    projectId?: string,
  ): Promise<AcademicSearchResponse> {
    const response = await this.academic.search(query, opts);
    if (projectId !== undefined && response.results.length > 0) {
      this.rememberSearch(projectId, {
        kind: "academic",
        query,
        results: response.results,
        cachedAt: Date.now(),
      });
    }
    return response;
  }

  /** Web 检索；缓存语义同 academicSearch */
  async webSearch(
    query: string,
    opts: SearchOptions = {},
    projectId?: string,
  ): Promise<WebSearchResponse> {
    const response = await this.web.search(query, opts);
    if (projectId !== undefined && response.results.length > 0) {
      this.rememberSearch(projectId, {
        kind: "web",
        query,
        results: response.results,
        cachedAt: Date.now(),
      });
    }
    return response;
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

  /**
   * save_candidates 工具的唯一后端（M7.1a P-B）：按 (kind, query) 回放项目检索
   * 缓存中最近一次检索的选中下标，复用既有显式保存函数落 CandidateStore——
   * 与 HTTP saveAsCandidates 汇聚同一写入口径。
   * 缓存 miss（未检索过 / TTL 过期 / 被 LRU 覆盖 / query 不一致）抛结构化
   * SEARCH_CACHE_MISS，调用方应引导「先用相同 query 重新检索再保存」。
   */
  async saveCandidatesFromCache(
    projectId: string,
    kind: "academic" | "web",
    query: string,
    resultIndexes: number[],
  ): Promise<SavedCandidatesResult> {
    if (resultIndexes.length > MAX_SAVE_CANDIDATES_PER_CALL) {
      throw new BusinessError(
        "INVALID_REQUEST",
        `单次最多保存 ${MAX_SAVE_CANDIDATES_PER_CALL} 条候选（收到 ${resultIndexes.length} 个下标），请按相关性分批遴选`,
      );
    }
    const cached = this.findCached(projectId, kind, query);
    if (cached === undefined) {
      throw new BusinessError(
        "SEARCH_CACHE_MISS",
        `没有可用的检索缓存（kind=${kind}；query 必须与最近一次检索完全一致，缓存有效期约 ${Math.round(SEARCH_CACHE_TTL_MS / 60_000)} 分钟）`,
        "请先用相同的 query 重新检索，再保存选中条目",
      );
    }
    return cached.kind === "academic"
      ? this.saveAcademicCandidates(projectId, query, cached.results, resultIndexes)
      : this.saveWebCandidates(projectId, query, cached.results, resultIndexes);
  }

  providerHealth(): ProviderHealthReport {
    return { academic: this.academic.healthSnapshots(), web: this.web.healthSnapshots() };
  }

  /** 写入项目检索缓存：同 (kind, query) 只保留最近一次；超出 LRU 上限淘汰最旧 */
  private rememberSearch(projectId: string, entry: CachedSearch): void {
    const kept = (this.searchCache.get(projectId) ?? []).filter(
      (existing) => !(existing.kind === entry.kind && existing.query === entry.query),
    );
    kept.push(entry);
    this.searchCache.set(projectId, kept.slice(-MAX_CACHED_SEARCHES_PER_PROJECT));
  }

  /** 查找缓存检索：TTL 内命中并把条目移回 MRU 位（保存视为一次使用）；过期即清除 */
  private findCached(
    projectId: string,
    kind: "academic" | "web",
    query: string,
  ): CachedSearch | undefined {
    const entries = this.searchCache.get(projectId);
    if (entries === undefined) {
      return undefined;
    }
    const index = entries.findIndex((entry) => entry.kind === kind && entry.query === query);
    if (index === -1) {
      return undefined;
    }
    const entry = entries[index]!;
    if (Date.now() - entry.cachedAt > SEARCH_CACHE_TTL_MS) {
      entries.splice(index, 1);
      return undefined;
    }
    entries.splice(index, 1);
    entries.push(entry);
    return entry;
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
