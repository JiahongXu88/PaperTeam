/**
 * Citation metadata verification providers（Layer 2，M3.1）。
 *
 * Provider abstraction：CrossRef / OpenAlex / arXiv —— 均为无凭据可用的公开接口。
 * 纪律：
 * - 所有请求带超时（AbortController）与 User-Agent（CrossRef 礼仪）；
 * - 网络失败 / 超时 / 5xx → status="unverifiable"（绝不因网络问题判定 not_found）；
 * - 顺序调用（rate-limit friendly），不并发轰炸；
 * - 不把任何 API key 写入仓库或配置。
 */

import type { BibEntrySummary } from "./StaticCitationChecker.js";

export type MetadataVerificationStatus = "verified" | "mismatch" | "not_found" | "unverifiable";

export interface MetadataVerificationResult {
  provider: string;
  entryKey: string;
  status: MetadataVerificationStatus;
  matched?: { title?: string; year?: number; doi?: string; url?: string };
  note?: string;
}

export interface MetadataProviderContext {
  fetchImpl: typeof fetch;
  timeoutMs: number;
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

async function fetchJson(
  url: string,
  ctx: MetadataProviderContext,
  userAgent: string,
): Promise<{ ok: true; body: unknown } | { ok: false; reason: string; httpStatus?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
  try {
    const response = await ctx.fetchImpl(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": userAgent,
        Accept: "application/json",
        ...(ctx.contactEmail ? { "X-User-Agent": `mailto:${ctx.contactEmail}` } : {}),
      },
    });
    if (response.status === 404) {
      return { ok: false, reason: "http-404", httpStatus: 404 };
    }
    if (response.status >= 500) {
      return { ok: false, reason: `http-${response.status}`, httpStatus: response.status };
    }
    if (!response.ok) {
      return { ok: false, reason: `http-${response.status}`, httpStatus: response.status };
    }
    const body = (await response.json()) as unknown;
    return { ok: true, body };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: message };
  } finally {
    clearTimeout(timer);
  }
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
    const url = entry.doi
      ? `https://api.crossref.org/works/${entry.doi.replace(/^doi:/i, "")}`
      : `https://api.crossref.org/works?query.bibliographic=${encodeURIComponent(entry.title ?? "")}&rows=3`;
    const result = await fetchJson(url, ctx, "PaperTeam/0.1 (citation verification)");
    if (!result.ok) {
      // 404 是权威否定（DOI 不存在）；其余（网络/5xx/超时）不可据此判定
      if (result.reason === "http-404") {
        return { ...base, status: "not_found", note: "CrossRef 中未找到该 DOI" };
      }
      return { ...base, status: "unverifiable", note: `查询失败：${result.reason}` };
    }
    const record = findCrossRefRecord(result.body, entry.doi !== undefined);
    if (record === null) {
      return { ...base, status: "not_found", note: "CrossRef 中未找到匹配记录" };
    }
    const actualTitle = typeof record.title === "string" ? record.title : undefined;
    if (!actualTitle) {
      return { ...base, status: "unverifiable", note: "响应缺少标题字段" };
    }
    if (!entry.title || titlesMatch(entry.title, actualTitle)) {
      return {
        ...base,
        status: "verified",
        matched: { title: actualTitle, ...(entry.doi ? { doi: entry.doi } : {}) },
      };
    }
    return {
      ...base,
      status: "mismatch",
      matched: { title: actualTitle },
      note: `标题不匹配：bib="${entry.title}" vs CrossRef="${actualTitle}"`,
    };
  }
}

function findCrossRefRecord(
  body: unknown,
  byDoi: boolean,
): { title?: unknown } | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (byDoi) {
    return record["status"] === "ok" && record["message"] !== undefined
      ? (record["message"] as Record<string, unknown>)
      : null;
  }
  const items = record["message"] as Record<string, unknown> | undefined;
  const list = items?.["items"];
  if (!Array.isArray(list) || list.length === 0) {
    return null;
  }
  return list[0] as Record<string, unknown>;
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
    const url = entry.doi
      ? `https://api.openalex.org/works/https://doi.org/${entry.doi}`
      : `https://api.openalex.org/works?search=${encodeURIComponent(entry.title ?? "")}&per-page=3`;
    const result = await fetchJson(url, ctx, "PaperTeam/0.1 (citation verification)");
    if (!result.ok) {
      return { ...base, status: "unverifiable", note: `查询失败：${result.reason}` };
    }
    const record = findOpenAlexRecord(result.body, entry.doi !== undefined);
    if (record === null) {
      return { ...base, status: "not_found", note: "OpenAlex 中未找到匹配记录" };
    }
    const actualTitle = typeof record["title"] === "string" ? record["title"] : undefined;
    if (!actualTitle) {
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

function findOpenAlexRecord(body: unknown, byDoi: boolean): Record<string, unknown> | null {
  if (typeof body !== "object" || body === null) {
    return null;
  }
  const record = body as Record<string, unknown>;
  if (byDoi) {
    return typeof record["id"] === "string" ? record : null;
  }
  const results = record["results"];
  if (!Array.isArray(results) || results.length === 0) {
    return null;
  }
  return results[0] as Record<string, unknown>;
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
    try {
      const response = await ctx.fetchImpl(url, {
        signal: controller.signal,
        headers: { "User-Agent": "PaperTeam/0.1 (citation verification)" },
      });
      if (!response.ok) {
        return { ...base, status: "unverifiable", note: `查询失败：http-${response.status}` };
      }
      const xml = await response.text();
      const entries = [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((match) => match[1] ?? "");
      const titles = entries
        .map((block) => /<title>([\s\S]*?)<\/title>/.exec(block)?.[1]?.trim() ?? "")
        .filter((title) => title !== "");
      const hit = titles.find((title) => titlesMatch(entry.title!, decodeXmlEntities(title)));
      if (hit === undefined) {
        return { ...base, status: "not_found", note: "arXiv 中未找到匹配记录" };
      }
      return { ...base, status: "verified", matched: { title: decodeXmlEntities(hit) } };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { ...base, status: "unverifiable", note: `查询失败：${message}` };
    } finally {
      clearTimeout(timer);
    }
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
