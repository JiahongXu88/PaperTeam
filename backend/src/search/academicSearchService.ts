/**
 * AcademicSearchService：多 AcademicSearchProvider 编排（M6.1 ADR §3）。
 *
 * 聚合纪律（借 SearXNG「单引擎失败不拖垮请求」，分析报告 §3.5/§10.3）：
 * - 有界并发 fan-out（mapWithConcurrency，不用无上限 Promise.all）；
 * - timeout isolation：单 provider 超时/熔断/冷却只记入 diagnostics，不拖住整体；
 * - partial success：≥1 provider 成功即返回（status=partial 如有失败者）；
 * - 全部失败 → 结构化失败（SEARCH_ALL_PROVIDERS_FAILED），**不伪造空结果**
 *   （D-0023：error ≠ not_found ≠ 空集）；
 * - 融合：SourceIdentity 去重 + 带权重 RRF（fusion.ts），多源互补 metadata merge。
 */

import { BusinessError } from "../errors.js";
import { mapWithConcurrency } from "../util/concurrency.js";
import { ProviderHttpError } from "./providerHttp.js";
import { fuseAcademicResults, type FusedAcademicResult } from "./fusion.js";
import type {
  AcademicSearchProvider,
  ProviderAttempt,
  SearchDiagnostics,
  SearchOptions,
} from "./types.js";

export interface AcademicSearchResponse {
  /** success=全部参与 provider 成功；partial=部分失败但有结果；failed 由异常表达 */
  status: "success" | "partial";
  results: FusedAcademicResult[];
  diagnostics: SearchDiagnostics;
}

export interface AcademicSearchServiceOptions {
  providers: AcademicSearchProvider[];
  /** provider 并发上限（provider 数少；缺省 4） */
  concurrency?: number;
  /** 整体结果上限（API 层硬帽 50；缺省 50） */
  maxResults?: number;
  log?: (message: string) => void;
}

export class AcademicSearchService {
  private readonly providers: AcademicSearchProvider[];
  private readonly concurrency: number;
  private readonly maxResults: number;
  private readonly log: (message: string) => void;

  constructor(options: AcademicSearchServiceOptions) {
    this.providers = options.providers;
    this.concurrency = options.concurrency ?? 4;
    this.maxResults = options.maxResults ?? 50;
    this.log = options.log ?? (() => {});
  }

  async search(query: string, opts: SearchOptions = {}): Promise<AcademicSearchResponse> {
    if (this.providers.length === 0) {
      throw new BusinessError(
        "SEARCH_PROVIDER_NOT_CONFIGURED",
        "未配置任何学术检索 provider（Academic Search 不可用）",
      );
    }
    const outcomes = await mapWithConcurrency(
      this.providers,
      this.concurrency,
      async (provider) => {
        const startedAt = Date.now();
        try {
          const results = await provider.search(query, opts);
          return { provider: provider.name, ok: true as const, results, latencyMs: Date.now() - startedAt };
        } catch (error) {
          return { provider: provider.name, ok: false as const, error, latencyMs: Date.now() - startedAt };
        }
      },
      { signal: opts.signal },
    );
    const attempts: ProviderAttempt[] = [];
    const allResults = [];
    for (const [index, outcome] of outcomes.entries()) {
      const provider = this.providers[index]!;
      // worker 内部已捕获全部异常（ok 恒为 true）；外层 outcome 只在 map 本身
      // 异常时为 ok:false（如 abort），按 provider 失败如实记录
      const value = outcome.ok ? outcome.value : { ok: false as const, error: outcome.error, latencyMs: 0 };
      if (value.ok) {
        attempts.push({
          provider: provider.name,
          outcome: "ok",
          resultCount: value.results.length,
          latencyMs: value.latencyMs,
        });
        allResults.push(value.results);
      } else {
        attempts.push({
          provider: provider.name,
          outcome: "failed",
          resultCount: 0,
          latencyMs: value.latencyMs,
          ...attemptError(value.error),
        });
        this.log(
          `[search] provider ${provider.name} 失败：${attemptError(value.error).error?.message ?? "未知错误"}`,
        );
      }
    }
    const succeeded = attempts.filter((attempt) => attempt.outcome === "ok");
    if (succeeded.length === 0) {
      throw new BusinessError(
        "SEARCH_ALL_PROVIDERS_FAILED",
        `全部学术检索 provider 失败（${attempts.map((a) => `${a.provider}:${a.error?.kind ?? "?"}`).join(", ")}）——检索失败不等于无结果，请稍后重试`,
      );
    }
    const fused = fuseAcademicResults(allResults).slice(0, Math.min(opts.limit ?? 10, this.maxResults));
    return {
      status: succeeded.length === attempts.length ? "success" : "partial",
      results: fused,
      diagnostics: {
        providers: attempts,
        rawResultCount: allResults.reduce((sum, results) => sum + results.length, 0),
        fusedResultCount: fused.length,
      },
    };
  }

  healthSnapshots() {
    return this.providers.map((provider) => provider.healthSnapshot());
  }
}

/** ProviderHttpError → 无敏感信息的诊断条目（不透传 header / key / URL） */
function attemptError(error: unknown): { error: { kind: string; message: string } } {
  if (error instanceof ProviderHttpError) {
    return { error: { kind: error.kind, message: error.message } };
  }
  const message = error instanceof Error ? error.message : String(error);
  return { error: { kind: "internal", message: message.slice(0, 200) } };
}
