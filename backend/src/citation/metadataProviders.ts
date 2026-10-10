/**
 * Citation metadata verification providers（Layer 2）。
 *
 * Provider abstraction：CrossRef / OpenAlex / arXiv —— 均为无凭据可用的公开接口。
 * 纪律：
 * - 请求经共享 ScholarlyHttpClient（M13.6）：超时 / Retry-After / 指数退避 /
 *   provider 冷却 / AbortSignal 一体——provider 自身不再各写一套重试；
 * - 网络失败 / 超时 / 5xx / 429 → status="unverifiable"（绝不因网络问题判定
 *   not_found）；429 额外携带 errorKind="rate_limited" 与建议等待，供上层
 *   恢复 pass 只补查限流条目；
 * - 顺序调用（rate-limit friendly），不并发轰炸；
 * - 不把任何 API key 写入仓库或配置。
 * - M13.6 字段修复：OpenAlex 标题字段 display_name（旧 title 字段已弃用且
 *   普遍为 null——真实 Run 26/31 未核验的主因）；DOI 精确命中但响应缺标题
 *   时不再整条放弃（DOI 存在性本身是权威核验，如实标注未做标题比对）。
 */

import type { BibEntrySummary } from "./StaticCitationChecker.js";
import { ScholarlyHttpError, type ScholarlyHttpClient } from "./scholarlyHttp.js";

export type MetadataVerificationStatus = "verified" | "mismatch" | "not_found" | "unverifiable";

export interface MetadataVerificationResult {
  provider: string;
  entryKey: string;
  status: MetadataVerificationStatus;
  matched?: { title?: string; year?: number; doi?: string; url?: string };
  note?: string;
  /** unverifiable 的机器可读分类（M13.6：rate_limited ≠ timeout ≠ not_found） */
  errorKind?: "rate_limited" | "timeout" | "network_error" | "server_error" | "http_error" | "aborted";
  /** 建议等待毫秒（Retry-After / provider 冷却；rate_limited） */
  retryAfterMs?: number;
}

export interface MetadataProviderContext {
  /** 共享 HTTP 执行器（重试 / 冷却一体；provider 不自带重试层） */
  http: ScholarlyHttpClient;
  /** CrossRef 礼仪：提供联系邮箱可进入 polite pool（可选） */
  contactEmail?: string;
}

export interface CitationMetadataProvider {
  readonly name: string;
  /** 依据 bib 条目的 DOI / 标题查询公开元数据并比对 */
  verify(entry: BibEntrySummary, ctx: MetadataProviderContext): Promise<MetadataVerificationResult>;
}

// ---- 标题比对辅助 ----

/** 归一化标题：去大小写 / 标点 / 冠词，便于包含式比对 */
export function normalizeTitleForMatch(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, " ")
    .trim()
    .replace(/^(a|an|the)\s+/, "");
}

/** 标题匹配判定：完全一致或高重叠（双向包含） */
export function titlesMatch(expected: string, actual: string): boolean {
  const left = normalizeTitleForMatch(expected);
  const right = normalizeTitleForMatch(actual);
  if (left === "" || right === "") {
    return false;
  }
  if (left === right) {
    return true;
  }
  return left.includes(right) || right.includes(left);
}

/** ScholarlyHttpError → unverifiable 结果（保留分类与建议等待） */
function unverifiable(
  base: { provider: string; entryKey: string },
  label: string,
  error: ScholarlyHttpError,
): MetadataVerificationResult {
  const detail =
    error.kind === "rate_limited"
      ? `429 限流${error.retryAfterMs !== undefined ? `（${Math.ceil(error.retryAfterMs / 1000)}s 后可重试）` : ""}`
      : error.status !== undefined
        ? `http-${error.status}`
        : error.message.replace(/^\[.*?\]\s*/, "");
  return {
    ...base,
    status: "unverifiable",
    note: `${label} 查询失败：${detail}`,
    ...(error.kind !== "aborted" ? { errorKind: error.kind } : {}),
    ...(error.kind === "rate_limited" && error.retryAfterMs !== undefined && error.retryAfterMs > 0
      ? { retryAfterMs: error.retryAfterMs }
      : {}),
  };
}

function toHttpError(error: unknown): ScholarlyHttpError {
  return error instanceof ScholarlyHttpError
    ? error
    : new ScholarlyHttpError("network_error", "", error instanceof Error ? error.message : String(error));
}

/** provider 共用请求头（Crossref 礼仪：mailto 进 User-Agent / X-User-Agent） */
function metadataHeaders(ctx: MetadataProviderContext, userAgent: string): Record<string, string> {
  return {
    "User-Agent": userAgent,
    Accept: "application/json",
    ...(ctx.contactEmail ? { "X-User-Agent": `mailto:${ctx.contactEmail}` } : {}),
  };
}

// ---- CrossRef ----

export class CrossRefProvider implements CitationMetadataProvider {
  readonly name = "crossref";

  async verify(
    entry: BibEntrySummary,
    ctx: MetadataProviderContext,
  ): Promise<MetadataVerificationResult> {
    const base = { provider: this.name, entryKey: entry.key };
    if (!entry.doi && !entry.title) {
      return { ...base, status: "unverifiable", note: "缺少 DOI 与标题，无法查询" };
    }
    const doi = entry.doi !== undefined ? normalizeDoi(entry.doi) : undefined;
    const url = doi !== undefined
      ? `https://api.crossref.org/works/${encodeURIComponent(doi)}`
      : `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(entry.title ?? "")}&rows=3`;
    let body: unknown;
    try {
      body = await ctx.http.fetchJson(this.name, url, { headers: metadataHeaders(ctx, "PaperTeam/0.1 (citation verification)") });
    } catch (error) {
      const httpError = toHttpError(error);
      // 404 是权威否定（DOI 不存在）；其余（网络/5xx/超时/限流）不可据此判定
      if (httpError.status === 404) {
        return { ...base, status: "not_found", note: "CrossRef 中未找到该 DOI" };
      }
      return unverifiable(base, "CrossRef", httpError);
    }
    const { record: crossrefRecord, byDoi, hadTitlelessCandidates } = findCrossRefRecord(body, doi !== undefined, entry.title);
    if (crossrefRecord === null) {
      if (!byDoi && hadTitlelessCandidates) {
        // 检索返回了候选但全部缺标题字段：无法比对，不能声称「未找到」
        return { ...base, status: "unverifiable", note: "候选记录缺少标题字段，无法比对" };
      }
      return { ...base, status: "not_found", note: "CrossRef 中未找到匹配记录" };
    }
    const actualTitle = firstString(crossrefRecord["title"]);
    const subtitle = firstString(crossrefRecord["subtitle"]);
    const fullTitle =
      actualTitle !== undefined && subtitle !== undefined && subtitle !== "" && !actualTitle.toLowerCase().includes(subtitle.toLowerCase())
        ? `${actualTitle}: ${subtitle}`
        : actualTitle;
    if (!fullTitle) {
      if (byDoi) {
        // M13.6：DOI 精确命中但响应无标题——DOI 存在性本身是权威核验；
        // 如实标注「未做标题比对」，不虚构标题也不放弃该条
        return {
          ...base,
          status: "verified",
          matched: { ...(entry.doi !== undefined ? { doi: entry.doi } : {}) },
          note: "DOI 命中；响应缺少标题字段，未做标题比对",
        };
      }
      return { ...base, status: "unverifiable", note: "响应缺少标题字段" };
    }
    if (!entry.title || titlesMatch(entry.title, fullTitle)) {
      return {
        ...base,
        status: "verified",
        matched: { title: fullTitle, ...(entry.doi ? { doi: entry.doi } : {}) },
      };
    }
    return {
      ...base,
      status: "mismatch",
      matched: { title: fullTitle },
      note: `标题不匹配：bib="${entry.title}" vs CrossRef="${fullTitle}"`,
    };
  }
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? (value[0] as string) : undefined;
  }
  return typeof value === "string" ? value : undefined;
}

/**
 * DOI 归一化：去掉 doi: 前缀与 https://doi.org/ 等 resolver 前缀，只保留 10.xxxx/… 本体。
 * bib 里三种写法都常见；不归一化会把合法 DOI 查成 404 → not_found。
 */
export function normalizeDoi(raw: string): string {
  return raw
    .trim()
    .replace(/^doi:\s*/i, "")
    .replace(/^https?:\/\/(dx\.)?doi\.org\//i, "")
    .trim();
}

/**
 * CrossRef 响应 → 记录。DOI 查询返回单条；标题检索返回候选列表——只取标题匹配的
 * 那一条（列表第一条不一定是它，检索结果里排第一的无关论文不能当成「元数据不一致」）。
 * hadTitlelessCandidates：候选列表存在但全部无可比标题（不能据此判 not_found）。
 */
function findCrossRefRecord(
  body: unknown,
  byDoi: boolean,
  expectedTitle: string | undefined,
): { record: Record<string, unknown> | null; byDoi: boolean; hadTitlelessCandidates: boolean } {
  if (typeof body !== "object" || body === null) {
    return { record: null, byDoi, hadTitlelessCandidates: false };
  }
  const body_ = body as Record<string, unknown>;
  if (byDoi) {
    return {
      record: body_["status"] === "ok" && body_["message"] !== undefined
        ? (body_["message"] as Record<string, unknown>)
        : null,
      byDoi,
      hadTitlelessCandidates: false,
    };
  }
  const items = body_["message"] as Record<string, unknown> | undefined;
  const list = items?.["items"];
  if (!Array.isArray(list) || list.length === 0) {
    return { record: null, byDoi, hadTitlelessCandidates: false };
  }
  const picked = pickMatchingCandidate(list as Record<string, unknown>[], expectedTitle);
  return {
    record: picked,
    byDoi,
    hadTitlelessCandidates: picked === null && (list as Record<string, unknown>[]).every((candidate) => firstString(candidate["title"]) === undefined),
  };
}

/** 候选列表中标题匹配的第一条；无标题可比时退回第一条 */
function pickMatchingCandidate(
  candidates: Record<string, unknown>[],
  expectedTitle: string | undefined,
): Record<string, unknown> | null {
  if (expectedTitle === undefined) {
    return candidates[0] ?? null;
  }
  for (const candidate of candidates) {
    const title = firstString(candidate["title"]);
    if (title !== undefined && titlesMatch(expectedTitle, title)) {
      return candidate;
    }
  }
  return null;
}

// ---- OpenAlex ----

export class OpenAlexProvider implements CitationMetadataProvider {
  readonly name = "openalex";

  async verify(
    entry: BibEntrySummary,
    ctx: MetadataProviderContext,
  ): Promise<MetadataVerificationResult> {
    const base = { provider: this.name, entryKey: entry.key };
    if (!entry.doi && !entry.title) {
      return { ...base, status: "unverifiable", note: "缺少 DOI 与标题，无法查询" };
    }
    const doi = entry.doi !== undefined ? normalizeDoi(entry.doi) : undefined;
    const url = doi !== undefined
      ? `https://api.openalex.org/works/https://doi.org/${encodeURIComponent(doi)}`
      : `https://api.openalex.org/works?search=${encodeURIComponent(entry.title ?? "")}&per-page=3`;
    let body: unknown;
    try {
      body = await ctx.http.fetchJson(this.name, url, { headers: metadataHeaders(ctx, "PaperTeam/0.1 (citation verification)") });
    } catch (error) {
      const httpError = toHttpError(error);
      if (httpError.status === 404) {
        return { ...base, status: "not_found", note: "OpenAlex 中未找到该 DOI" };
      }
      return unverifiable(base, "OpenAlex", httpError);
    }
    const { record: openalexRecord, byDoi, hadTitlelessCandidates } = findOpenAlexRecord(body, doi !== undefined, entry.title);
    if (openalexRecord === null) {
      if (!byDoi && hadTitlelessCandidates) {
        return { ...base, status: "unverifiable", note: "候选记录缺少标题字段，无法比对" };
      }
      return { ...base, status: "not_found", note: "OpenAlex 中未找到匹配记录" };
    }
    // M13.6：OpenAlex works 的标题字段是 display_name（title 已弃用且普遍 null）
    const actualTitle =
      (typeof openalexRecord["display_name"] === "string" && openalexRecord["display_name"] !== ""
        ? (openalexRecord["display_name"] as string)
        : undefined) ??
      firstString(openalexRecord["title"]);
    if (!actualTitle) {
      if (byDoi) {
        return {
          ...base,
          status: "verified",
          matched: { ...(entry.doi !== undefined ? { doi: entry.doi } : {}) },
          note: "DOI 命中；响应缺少标题字段，未做标题比对",
        };
      }
      return { ...base, status: "unverifiable", note: "响应缺少标题字段" };
    }
    if (!entry.title || titlesMatch(entry.title, actualTitle)) {
      return { ...base, status: "verified", matched: { title: actualTitle } };
    }
    return {
      ...base,
      status: "mismatch",
      matched: { title: actualTitle },
      note: `标题不匹配：bib="${entry.title}" vs OpenAlex="${actualTitle}"`,
    };
  }
}

function findOpenAlexRecord(
  body: unknown,
  byDoi: boolean,
  expectedTitle: string | undefined,
): { record: Record<string, unknown> | null; byDoi: boolean; hadTitlelessCandidates: boolean } {
  if (typeof body !== "object" || body === null) {
    return { record: null, byDoi, hadTitlelessCandidates: false };
  }
  const body_ = body as Record<string, unknown>;
  if (byDoi) {
    return { record: typeof body_["id"] === "string" ? body_ : null, byDoi, hadTitlelessCandidates: false };
  }
  const results = body_["results"];
  if (!Array.isArray(results) || results.length === 0) {
    return { record: null, byDoi, hadTitlelessCandidates: false };
  }
  const list = results as Record<string, unknown>[];
  const picked = pickOpenAlexMatchingCandidate(list, expectedTitle);
  return {
    record: picked,
    byDoi,
    hadTitlelessCandidates: picked === null && list.every((candidate) => openAlexTitleOf(candidate) === undefined),
  };
}

function openAlexTitleOf(candidate: Record<string, unknown>): string | undefined {
  return (
    (typeof candidate["display_name"] === "string" && candidate["display_name"] !== ""
      ? (candidate["display_name"] as string)
      : undefined) ?? firstString(candidate["title"])
  );
}

function pickOpenAlexMatchingCandidate(
  candidates: Record<string, unknown>[],
  expectedTitle: string | undefined,
): Record<string, unknown> | null {
  if (expectedTitle === undefined) {
    return candidates[0] ?? null;
  }
  for (const candidate of candidates) {
    const title = openAlexTitleOf(candidate);
    if (title !== undefined && titlesMatch(expectedTitle, title)) {
      return candidate;
    }
  }
  return null;
}

// ---- arXiv ----

export class ArxivProvider implements CitationMetadataProvider {
  readonly name = "arxiv";

  async verify(
    entry: BibEntrySummary,
    ctx: MetadataProviderContext,
  ): Promise<MetadataVerificationResult> {
    const base = { provider: this.name, entryKey: entry.key };
    if (!entry.title) {
      return { ...base, status: "unverifiable", note: "缺少标题，无法查询" };
    }
    // arXiv API 返回 Atom XML；只做轻量文本匹配（不引入 XML 解析依赖）
    const url = `https://export.arxiv.org/api/query?search_type=all&max_results=3&query=${encodeURIComponent(
      `ti:"${entry.title}"`,
    )}`;
    let xml: string;
    try {
      xml = await ctx.http.fetchText(this.name, url, { headers: { "User-Agent": "PaperTeam/0.1 (citation verification)" } });
    } catch (error) {
      return unverifiable(base, "arXiv", toHttpError(error));
    }
    const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((match) => match[1] ?? "");
    const titles = entries
      .map((block) => /<title>([\s\S]*?)<\/title>/.exec(block)?.[1]?.trim() ?? "")
      .filter((title) => title !== "");
    const hit = titles.find((title) => titlesMatch(entry.title!, decodeXmlEntities(title)));
    if (hit === undefined) {
      return { ...base, status: "not_found", note: "arXiv 中未找到匹配记录" };
    }
    return { ...base, status: "verified", matched: { title: decodeXmlEntities(hit) } };
  }
}

function decodeXmlEntities(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}
