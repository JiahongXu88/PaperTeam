/**
 * FullTextResolver：DOI / arXiv 身份 → 合法 OA 全文 PDF（M7.2；D-0033 §12 冻结形状）。
 *
 * 职责边界（ADR §12 注释原文：「返回可入库的字节流与来源标记；不写
 * SourceStore——入库是 LiteratureLibraryService 的职责」）：
 * - resolve 只回答「去哪下载（URL + license）」，不下载、不落盘；
 * - 下载由 downloadPdf 承担（ProviderHttpClient.fetchBytes + SSRF 逐跳护栏
 *   + 大小帽 + %PDF- 魔数校验）；
 * - 三实现：UnpaywallResolver（DOI）/ OpenAlexOaResolver（DOI / openalexId，
 *   ADR 名称 "oa-url"）/ ArxivPdfResolver（arxivId，确定性 URL 无 API）；
 * - 只认 PDF 直链（url_for_pdf / pdf_url）：landing page 不是全文，下载层
 *   只能消费 PDF 字节，不猜测、不解析 HTML。
 *
 * error ≠ not_found（D-0023）：网络失败 / 限流 / API 异常 → kind:"error"（可
 * 重试语义交调用方）；API 明确回答无 OA（或 404 未知 DOI）→ kind:"not_found"
 * （重试无意义）。绝不把 error 折叠成 not_found。
 */

import { BusinessError } from "../errors.js";
import { normalizeArxivId, type SourceIdentity } from "../sources/identity.js";
import { MAX_SOURCE_BYTES } from "../sources/SourceStore.js";
import { ProviderHttpError, type ProviderHttpClient } from "./providerHttp.js";

/** ADR §12 冻结形状（identity 为已落地超集） */
export interface FullTextResolver {
  /** "unpaywall" | "arxiv" | "oa-url"（ADR §12 注释约定名） */
  readonly name: string;
  resolve(identity: SourceIdentity): Promise<FullTextResolution>;
}

export type FullTextResolution =
  | { kind: "found"; url: string; source: string; license?: string }
  | { kind: "not_found" }
  | { kind: "error"; note: string };

const RESOLVER_TIMEOUT_MS = 10_000;
/** PDF 下载单跳超时（大文件允许慢，但不无限等） */
const DOWNLOAD_TIMEOUT_MS = 60_000;
/** 下载重定向上限（arxiv.org → export.arxiv.org 等合法跳转在内） */
const MAX_REDIRECT_HOPS = 5;
/** 下载流量画像名（ProviderHttpClient 健康追踪键；所有全文下载共用） */
const DOWNLOAD_PROFILE = "fulltext-download";
const USER_AGENT = "PaperTeam/0.1 (open-access fulltext resolution)";

// ---- Unpaywall（DOI → best_oa_location.url_for_pdf） ----

export interface UnpaywallResolverOptions {
  http: ProviderHttpClient;
  /** Unpaywall 强制要求 email 参数（无配置则该 resolver 不注册） */
  email: string;
}

export class UnpaywallResolver implements FullTextResolver {
  readonly name = "unpaywall";
  private readonly http: ProviderHttpClient;
  private readonly email: string;

  constructor(options: UnpaywallResolverOptions) {
    this.http = options.http;
    this.email = options.email;
  }

  async resolve(identity: SourceIdentity): Promise<FullTextResolution> {
    if (identity.doi === undefined) {
      return { kind: "not_found" };
    }
    const url = `https://api.unpaywall.org/v2/${encodeURIComponent(identity.doi)}?email=${encodeURIComponent(this.email)}`;
    let body: Record<string, unknown>;
    try {
      body = await this.http.fetchJson<Record<string, unknown>>(
        { name: this.name, timeoutMs: RESOLVER_TIMEOUT_MS },
        url,
        { headers: { Accept: "application/json" } },
      );
    } catch (error) {
      // 404 = DOI 不在 Unpaywall 库（确定性无记录）；其余（网络/限流/5xx）= error
      if (isNotFoundHttp(error)) {
        return { kind: "not_found" };
      }
      return { kind: "error", note: mapProviderError(error) };
    }
    const best = asRecord(body["best_oa_location"]);
    const pdfUrl = nonEmptyString(best?.["url_for_pdf"]);
    if (pdfUrl === undefined) {
      // is_oa=false / 仅有 landing page URL：对「获取 PDF 字节」而言就是没有
      return { kind: "not_found" };
    }
    const license = nonEmptyString(best?.["license"]);
    return {
      kind: "found",
      url: pdfUrl,
      source: this.name,
      ...(license !== undefined ? { license } : {}),
    };
  }
}

// ---- OpenAlex OA URL（DOI / openalexId → best_oa_location.pdf_url；ADR 名 "oa-url"） ----

export interface OpenAlexOaResolverOptions {
  http: ProviderHttpClient;
  /** 礼貌池标识（可选；与检索 provider 同一配置） */
  mailto?: string;
}

export class OpenAlexOaResolver implements FullTextResolver {
  readonly name = "oa-url";
  private readonly http: ProviderHttpClient;
  private readonly mailto?: string;

  constructor(options: OpenAlexOaResolverOptions) {
    this.http = options.http;
    this.mailto = options.mailto;
  }

  async resolve(identity: SourceIdentity): Promise<FullTextResolution> {
    const workId =
      identity.doi !== undefined
        ? `doi:${identity.doi}`
        : identity.openalexId !== undefined
          ? identity.openalexId // canonical 形态带 W 前缀（OpenAlex works API 原生接受）
          : undefined;
    if (workId === undefined) {
      return { kind: "not_found" };
    }
    const url = `https://api.openalex.org/works/${workId}${this.mailto !== undefined ? `?mailto=${encodeURIComponent(this.mailto)}` : ""}`;
    let body: Record<string, unknown>;
    try {
      body = await this.http.fetchJson<Record<string, unknown>>(
        { name: this.name, timeoutMs: RESOLVER_TIMEOUT_MS },
        url,
        { headers: { Accept: "application/json" } },
      );
    } catch (error) {
      // 404 = OpenAlex 无此 work（确定性无记录）；其余 = error
      if (isNotFoundHttp(error)) {
        return { kind: "not_found" };
      }
      return { kind: "error", note: mapProviderError(error) };
    }
    const best = asRecord(body["best_oa_location"]);
    const pdfUrl = nonEmptyString(best?.["pdf_url"]);
    if (pdfUrl === undefined) {
      return { kind: "not_found" };
    }
    const license = nonEmptyString(best?.["license"]);
    return {
      kind: "found",
      url: pdfUrl,
      source: this.name,
      ...(license !== undefined ? { license } : {}),
    };
  }
}

// ---- arXiv PDF（确定性 URL，无 API 查询；存在性由下载层如实报告） ----

export class ArxivPdfResolver implements FullTextResolver {
  readonly name = "arxiv";

  async resolve(identity: SourceIdentity): Promise<FullTextResolution> {
    const arxivId = identity.arxivId !== undefined ? normalizeArxivId(identity.arxivId) : undefined;
    if (arxivId === undefined) {
      return { kind: "not_found" };
    }
    return { kind: "found", url: `https://arxiv.org/pdf/${arxivId}`, source: this.name };
  }
}

// ---- 链构建与装配 ----

/**
 * 按身份键选择适用的 resolver 并固定优先级（正式版 OA 优先，预印本兜底）：
 *   有 doi → [unpaywall, oa-url]；仅有 openalexId → [oa-url]；
 *   有 arxivId → 追加 [arxiv]；都没有 → 空链（不可自动解析）。
 * 未知名的自定义 resolver 不参与（优先级未定义则不隐式排序）。
 */
export function applicableFullTextResolvers(
  resolvers: readonly FullTextResolver[],
  identity: SourceIdentity,
): FullTextResolver[] {
  const byName = new Map(resolvers.map((resolver) => [resolver.name, resolver]));
  const wanted: string[] = [];
  if (identity.doi !== undefined) {
    wanted.push("unpaywall", "oa-url");
  } else if (identity.openalexId !== undefined) {
    wanted.push("oa-url");
  }
  if (identity.arxivId !== undefined) {
    wanted.push("arxiv");
  }
  return wanted.flatMap((name) => {
    const resolver = byName.get(name);
    return resolver !== undefined ? [resolver] : [];
  });
}

/**
 * 生产装配：email 缺省不注册 Unpaywall（Unpaywall 强制 email；配置缺失
 * 降级而非失败——OpenAlex / arXiv 路径不受影响，同 AMiner 无 key 纪律）。
 */
export function buildDefaultFullTextResolvers(options: {
  http: ProviderHttpClient;
  /** Unpaywall email（PAPERTEAM_OPENALEX_MAILTO / CITATION_CONTACT_EMAIL） */
  email?: string;
}): FullTextResolver[] {
  const resolvers: FullTextResolver[] = [];
  if (options.email !== undefined && options.email.trim() !== "") {
    resolvers.push(new UnpaywallResolver({ http: options.http, email: options.email.trim() }));
  }
  resolvers.push(new OpenAlexOaResolver({ http: options.http }));
  resolvers.push(new ArxivPdfResolver());
  return resolvers;
}

// ---- 下载（fetchBytes + SSRF 逐跳护栏 + 大小帽 + 魔数校验） ----

export interface DownloadedPdf {
  bytes: Buffer;
  /** 建议文件名（仅安全字符 + .pdf；非法回退 fulltext.pdf） */
  fileName: string;
  /** 最终取到字节的 URL（重定向后；审计用） */
  finalUrl: string;
}

export interface DownloadPdfOptions {
  http: ProviderHttpClient;
  signal?: AbortSignal;
  /** 大小硬帽（缺省 MAX_SOURCE_BYTES，与文献库上传同一上限） */
  maxBytes?: number;
}

/**
 * 下载 PDF 字节。护栏（agent-search SSRF 逐跳校验教训 → M6.1 ADR §6）：
 * 1. 仅 https、无 userinfo、端口 443/缺省、拒绝 localhost / 私网与保留 IP
 *    字面量（不做 DNS 解析级校验——URL 来源限于 Unpaywall/OpenAlex/arXiv
 *    官方 API 响应，记录为已知边界）；
 * 2. 重定向手动逐跳跟随（≤5 跳，每跳重新校验）；
 * 3. 大小帽（content-length 预检 + 流式截断，由 fetchBytes 执行）；
 * 4. %PDF- 魔数（landing page / 付费墙 HTML 在此确定性拦截）。
 */
export async function downloadPdf(url: string, options: DownloadPdfOptions): Promise<DownloadedPdf> {
  const maxBytes = options.maxBytes ?? MAX_SOURCE_BYTES;
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECT_HOPS; hop += 1) {
    assertDownloadableUrl(current);
    let response: { bytes: Buffer; contentType: string | null };
    try {
      response = await options.http.fetchBytes(
        { name: DOWNLOAD_PROFILE, timeoutMs: DOWNLOAD_TIMEOUT_MS },
        current,
        {
          maxBytes,
          headers: { "User-Agent": USER_AGENT, Accept: "application/pdf" },
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
        },
      );
    } catch (error) {
      const redirect = redirectTargetOf(error);
      if (redirect !== undefined) {
        current = new URL(redirect, current).toString();
        continue;
      }
      throw downloadFailure(`下载失败（${current.slice(0, 160)}）：${mapProviderError(error)}`, options.signal);
    }
    if (response.bytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
      throw downloadFailure(
        `下载内容不是 PDF（缺少 %PDF- 头；可能是落地页 / 付费墙）：${current.slice(0, 160)}`,
        options.signal,
      );
    }
    return { bytes: response.bytes, fileName: suggestFileName(current), finalUrl: current };
  }
  throw downloadFailure(`重定向超过 ${MAX_REDIRECT_HOPS} 跳，中止`, options.signal);
}

/** 3xx → Location（相对地址基于当前 URL 解析）；非重定向错误返回 undefined */
function redirectTargetOf(error: unknown): string | undefined {
  if (
    error !== null &&
    typeof error === "object" &&
    (error as ProviderHttpError).name === "ProviderHttpError"
  ) {
    const providerError = error as ProviderHttpError;
    const status = providerError.status ?? 0;
    if (status >= 300 && status < 400 && providerError.location !== undefined && providerError.location !== "") {
      return providerError.location;
    }
  }
  return undefined;
}

/** 下载 URL 安全校验（每一跳执行；违反即 FULLTEXT_DOWNLOAD_FAILED） */
export function assertDownloadableUrl(raw: string): URL {
  let parsed: URL;
  try {
    parsed = new URL(raw);
  } catch {
    throw downloadFailure(`非法 URL：${raw.slice(0, 160)}`);
  }
  if (parsed.protocol !== "https:") {
    throw downloadFailure(`仅允许 https 下载地址（收到 ${parsed.protocol}）：${raw.slice(0, 160)}`);
  }
  if (parsed.username !== "" || parsed.password !== "") {
    throw downloadFailure(`拒绝带 userinfo 的下载地址：${raw.slice(0, 160)}`);
  }
  if (parsed.port !== "" && parsed.port !== "443") {
    throw downloadFailure(`拒绝非 443 端口下载地址（收到 :${parsed.port}）：${raw.slice(0, 160)}`);
  }
  const host = parsed.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (isPrivateOrLocalHost(host)) {
    throw downloadFailure(`拒绝内网 / 本地下载地址（${host}）：${raw.slice(0, 160)}`);
  }
  return parsed;
}

/** 内网 / 本地主机判定（字面量级；IPv4 / IPv6 / 保留后缀） */
export function isPrivateOrLocalHost(host: string): boolean {
  if (host === "localhost" || host.endsWith(".localhost") || host.endsWith(".local") || host.endsWith(".internal") || host.endsWith(".localdomain")) {
    return true;
  }
  // IPv4 字面量
  const ipv4 = /^(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})$/.exec(host);
  if (ipv4 !== null) {
    const [a, b] = [Number(ipv4[1]), Number(ipv4[2])];
    if (
      a === 0 ||
      a === 10 ||
      a === 127 ||
      (a === 169 && b === 254) ||
      (a === 172 && b >= 16 && b <= 31) ||
      (a === 192 && b === 168) ||
      a >= 224
    ) {
      return true;
    }
    return false;
  }
  // IPv6 字面量（含 ::ffff:IPv4 映射）
  if (host.includes(":")) {
    const lower = host.toLowerCase();
    if (lower === "::" || lower === "::1") {
      return true;
    }
    const mapped = /^::ffff:(\d{1,3}(?:\.\d{1,3}){3})$/.exec(lower);
    if (mapped !== null) {
      return isPrivateOrLocalHost(mapped[1]!);
    }
    const hextet = /^([0-9a-f]{1,4})(?::|$)/.exec(lower);
    if (hextet !== null) {
      const first = Number.parseInt(hextet[1]!, 16);
      if (
        (first >= 0xfc00 && first <= 0xfdff) || // fc00::/7 unique-local
        (first >= 0xfe80 && first <= 0xfebf) // fe80::/10 link-local
      ) {
        return true;
      }
    }
    return false;
  }
  return false;
}

// ---- 内部辅助 ----

function downloadFailure(message: string, signal?: AbortSignal): BusinessError {
  if (signal?.aborted) {
    return new BusinessError("FULLTEXT_DOWNLOAD_FAILED", "全文下载已被取消");
  }
  return new BusinessError("FULLTEXT_DOWNLOAD_FAILED", message);
}

function mapProviderError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200);
}

/** provider HTTP 404（确定性 not_found 的唯一形态；error ≠ not_found） */
function isNotFoundHttp(error: unknown): boolean {
  return (
    error instanceof ProviderHttpError && error.kind === "http_error" && error.status === 404
  );
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : null;
}

function nonEmptyString(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}

/** URL 末段 → 建议文件名（安全字符 + .pdf 才采纳，否则 fulltext.pdf） */
function suggestFileName(url: string): string {
  try {
    const last = decodeURIComponent(new URL(url).pathname.split("/").filter(Boolean).pop() ?? "");
    if (/\.pdf$/i.test(last) && /^[A-Za-z0-9._-]+$/.test(last) && last.length <= 150) {
      return last;
    }
  } catch {
    // 非法 URL（assertDownloadableUrl 会先行拒绝，这里只兜底）
  }
  return "fulltext.pdf";
}
