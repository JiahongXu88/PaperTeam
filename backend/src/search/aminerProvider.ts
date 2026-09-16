/**
 * AMinerSearchProvider：China secondary + enrichment（D-0033 §4）。
 *
 * 角色约束（分析报告 §6）：全境内托管、中文一等公民，但免费层无摘要、无精确
 * 引用数（桶值）、无前向引用——绝不做 primary。**只使用免费端点**
 * `GET /api/paper/search?title=&page=&size=`（size ≤ 20）；付费端点
 * （paper_search_pro 等，¥0.01-0.70/次）一律不接入（D-0033：计费矛盾未实测前
 * 默认关闭）——本 provider 的 URL 集被测试钉死不含任何付费路径。
 *
 * AMiner 特有失败形态：**HTTP 200 + 信封 code != success 的业务错误**
 * （40301 permission_denied / 40302 token_expired / 40306 rate_limited /
 * 40307 invalid_api_key）——HTTP 状态不可作为成功判据，经 envelope 钩子穿透
 * 上报 ProviderHttpClient（40306 → rate_limited 冷却；其余 → business_error
 * 不重试不熔断，HTTP 200 也绝不标记 healthy）。
 *
 * 无 API Key 时 provider 不注册（serviceStack 裁配逻辑），不影响其余 provider。
 */

import { buildIdentity, normalizeDoi, type SourceIdentity } from "../sources/identity.js";
import type { CanonicalPaperRecord } from "../citation/integrity.js";
import type { EnvelopeInspector, ProviderHttpClient } from "./providerHttp.js";
import type { AcademicSearchProvider, AcademicSearchResult, SearchOptions } from "./types.js";
import { clampLimit } from "./openalexProvider.js";

const BASE_URL = "https://datacenter.aminer.cn/gateway/open_platform";
/** 免费检索端点（唯一允许的路径；付费端点默认关闭） */
const SEARCH_PATH = "/api/paper/search";
/** 免费层单页上限（分析报告 §6.1：size ≤ 20） */
const AMINER_SIZE_CAP = 20;

/** AMiner 业务错误码 → 语义（分析报告 §6.1 错误码表） */
const AMINER_RATE_LIMITED_CODE = 40306;

export interface AMinerSearchProviderOptions {
  http: ProviderHttpClient;
  /** API Key（PAPERTEAM_AMINER_API_KEY；缺失时 provider 不注册，不在这里兜底） */
  apiKey: string;
  userAgent?: string;
}

export class AMinerSearchProvider implements AcademicSearchProvider {
  readonly name = "aminer";
  private readonly http: ProviderHttpClient;
  private readonly apiKey: string;
  private readonly userAgent: string;

  constructor(options: AMinerSearchProviderOptions) {
    this.http = options.http;
    this.apiKey = options.apiKey;
    this.userAgent = options.userAgent ?? "PaperTeam/0.1 (research discovery)";
  }

  async search(query: string, opts: SearchOptions = {}): Promise<AcademicSearchResult[]> {
    const limit = clampLimit(opts.limit, AMINER_SIZE_CAP);
    const params = new URLSearchParams({ title: query, page: "1", size: String(limit) });
    const body = await this.http.fetchJson<Record<string, unknown>>(
      { name: this.name, maxRetries: 1 },
      `${BASE_URL}${SEARCH_PATH}?${params.toString()}`,
      {
        signal: opts.signal,
        headers: {
          "User-Agent": this.userAgent,
          Accept: "application/json",
          // AMiner 开放平台鉴权：Authorization 头直接放 token（无 Bearer 前缀）
          Authorization: this.apiKey,
        },
        envelope: aminerEnvelope,
      },
    );
    const items = extractItems(body);
    const results: AcademicSearchResult[] = [];
    for (const [index, item] of items.entries()) {
      const mapped = toResult(item, index, opts);
      if (mapped !== null) {
        results.push(mapped);
      }
    }
    return results;
  }

  healthSnapshot() {
    return this.http.health(this.name);
  }
}

/**
 * HTTP-200 信封检查：code ∈ {0, 200} 放行；40306 → rate_limited（Retry-After 缺失
 * 时 client 按冷却帽处理）；其余业务错误 → business_error（不重试、不熔断、不 healthy）。
 */
export const aminerEnvelope: EnvelopeInspector = (body) => {
  if (typeof body !== "object" || body === null) {
    return { ok: false, kind: "business_error", message: "响应不是 JSON 对象" };
  }
  const code = (body as Record<string, unknown>)["code"];
  if (code === undefined || code === 0 || code === 200) {
    return { ok: true };
  }
  const message = String(
    (body as Record<string, unknown>)["msg"] ?? (body as Record<string, unknown>)["message"] ?? "未知业务错误",
  ).slice(0, 200);
  if (code === AMINER_RATE_LIMITED_CODE) {
    return { ok: false, kind: "rate_limited", code: Number(code), message: `AMiner 限流（40306）：${message}` };
  }
  return { ok: false, kind: "business_error", code: Number(code), message: `AMiner 业务错误（${code}）：${message}` };
};

/** data 信封三形态：data=[...] / data.data=[...] / data.items=[...]（参考实现 _envelope_items） */
function extractItems(body: Record<string, unknown>): Array<Record<string, unknown>> {
  let data: unknown = body["data"];
  if (typeof data === "object" && data !== null && !Array.isArray(data)) {
    const nested = data as Record<string, unknown>;
    data = nested["data"] ?? nested["items"] ?? [];
  }
  if (!Array.isArray(data)) {
    return [];
  }
  return data.filter((item): item is Record<string, unknown> => typeof item === "object" && item !== null);
}

function toResult(
  item: Record<string, unknown>,
  index: number,
  opts: SearchOptions,
): AcademicSearchResult | null {
  const title =
    firstNonEmpty(item["title"]) ??
    firstNonEmpty(item["title_zh"]) ??
    undefined;
  if (title === undefined) {
    return null;
  }
  const id = firstNonEmpty(item["id"], item["_id"], item["paper_id"]);
  const doiRaw = firstNonEmpty(item["doi"]);
  const doi = doiRaw !== undefined ? normalizeDoi(doiRaw) : undefined;
  const firstAuthor = firstNonEmpty(item["first_author"]);
  const authors = firstAuthor !== undefined ? [firstAuthor] : undefined;
  const yearRaw = item["year"];
  const year = typeof yearRaw === "number" && Number.isInteger(yearRaw) ? yearRaw : undefined;
  // 客户端过滤（免费端点无原生 year / OA 参数）
  if (opts.yearFrom !== undefined && (year === undefined || year < opts.yearFrom)) {
    return null;
  }
  if (opts.yearTo !== undefined && (year === undefined || year > opts.yearTo)) {
    return null;
  }
  if (opts.openAccessOnly === true) {
    // 免费层无 OA 字段：无法判定的一律不放行（不猜测）
    return null;
  }
  const identity: SourceIdentity | null = buildIdentity({
    ...(doi !== undefined ? { doi } : {}),
    ...(id !== undefined ? { aminerId: id } : {}),
    title,
    ...(authors !== undefined ? { authors } : {}),
    ...(year !== undefined ? { year } : {}),
  });
  if (identity === null) {
    return null;
  }
  const venue = firstNonEmpty(item["venue_name"]);
  const record: CanonicalPaperRecord = {
    provider: "aminer",
    recordId: id ?? "",
    title,
    ...(authors !== undefined ? { authors } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(venue !== undefined ? { venue } : {}),
    ...(doi !== undefined ? { doi } : {}),
    ...(id !== undefined ? { url: `https://www.aminer.cn/pub/${id}` } : {}),
    retrievedAt: new Date().toISOString(),
  };
  return {
    identity,
    record,
    relevance: { provider: "aminer", rank: index + 1 },
  };
}

function firstNonEmpty(...values: unknown[]): string | undefined {
  for (const value of values) {
    if (typeof value === "string" && value.trim() !== "") {
      return value.trim();
    }
  }
  return undefined;
}
