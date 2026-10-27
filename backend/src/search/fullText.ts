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
import { isPrivateOrLocalHost } from "../network/hosts.js";
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
  /** 按主机的下载节流（缺省进程级 defaultDownloadLimiter；测试注入） */
  limiter?: HostDownloadLimiter;
}

/** 主机级下载节流规则：同时在途上限 + 相邻下载起始最小间隔 */
export interface HostDownloadPolicy {
  maxConcurrent: number;
  minIntervalMs: number;
}

/**
 * 按主机的下载节流（M13.8）。arXiv 的访问条款要求对 PDF 串行、≥ 3s 间隔的「礼貌」访问；
 * 真实 run 中 batchConcurrency(3) + promote 钩子的后台尝试叠加成 ≥ 6 路并发 → 代理出口被
 * arxiv.org 节流（60s 级慢速 + 连接错误）→ 6 个 network_error 在同一瞬间触发共享熔断
 * （阈值 3）→ 其余文献全部被 circuit_open 短路（10/14 而非 13/14）。
 * 节流在 downloadPdf 入口按主机排队：arxiv.org / export.arxiv.org 同时只放 1 路、起始间隔
 * ≥ 1s；其它主机不限制（Unpaywall / OpenAlex 直链来自各出版社，无统一条款）。
 * 进程级单例（与 M13.6 共享冷却同一纪律）；可注入替换以便测试。
 */
export class HostDownloadLimiter {
  private readonly policies: Array<{ match: (host: string) => boolean; policy: HostDownloadPolicy }>;
  private readonly state = new Map<string, { inflight: number; lastStartMs: number; waiters: Array<() => void> }>();
  private readonly now: () => number;
  private readonly sleep: (ms: number) => Promise<void>;

  constructor(
    policies: Array<{ hosts: readonly string[]; policy: HostDownloadPolicy }> = [
      { hosts: ["arxiv.org", "export.arxiv.org"], policy: { maxConcurrent: 1, minIntervalMs: 1_000 } },
    ],
    clock: { now?: () => number; sleep?: (ms: number) => Promise<void> } = {},
  ) {
    this.policies = policies.map((entry) => ({
      match: (host) => entry.hosts.some((candidate) => host === candidate || host.endsWith(`.${candidate}`)),
      policy: entry.policy,
    }));
    this.now = clock.now ?? Date.now;
    this.sleep = clock.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  }

  /** 该主机当前在途数（测试 / 诊断） */
  inflight(host: string): number {
    const index = this.policyIndex(host);
    return index < 0 ? 0 : (this.state.get(`policy:${index}`)?.inflight ?? 0);
  }

  /** 取得许可（无策略的主机立即返回 no-op release）；release 必须且只能调用一次 */
  async acquire(host: string, signal?: AbortSignal): Promise<() => void> {
    const index = this.policyIndex(host);
    if (index < 0) {
      return () => {};
    }
    const policy = this.policies[index]!.policy;
    // 同一策略组共享一个队列（arxiv.org 与 export.arxiv.org 是同一出口限制）
    const key = `policy:${index}`;
    let entry = this.state.get(key);
    if (entry === undefined) {
      entry = { inflight: 0, lastStartMs: 0, waiters: [] };
      this.state.set(key, entry);
    }
    for (;;) {
      signal?.throwIfAborted();
      if (entry.inflight < policy.maxConcurrent) {
        const wait = entry.lastStartMs + policy.minIntervalMs - this.now();
        if (wait > 0) {
          await this.sleep(wait);
          continue; // 重新检查在途数（等待期间可能有别的下载起始）
        }
        entry.inflight += 1;
        entry.lastStartMs = this.now();
        let released = false;
        return () => {
          if (released) return;
          released = true;
          entry!.inflight -= 1;
          const next = entry!.waiters.shift();
          next?.();
        };
      }
      await new Promise<void>((resolve) => entry!.waiters.push(resolve));
    }
  }

  private policyIndex(host: string): number {
    const normalized = host.toLowerCase();
    return this.policies.findIndex((entry) => entry.match(normalized));
  }
}

/** 进程级缺省节流器（arXiv 串行 + 1s 间隔） */
export const defaultDownloadLimiter = new HostDownloadLimiter();

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
  const limiter = options.limiter ?? defaultDownloadLimiter;
  const firstHop = assertDownloadableUrl(url);
  let release: () => void;
  try {
    release = await limiter.acquire(firstHop.hostname, options.signal);
  } catch (error) {
    if (options.signal?.aborted) {
      throw downloadFailure("全文下载已被取消", options.signal);
    }
    throw error;
  }
  try {
    try {
      return await downloadPdfHops(url, options, options.maxBytes ?? MAX_SOURCE_BYTES);
    } catch (error) {
      // M15.8.1：arxiv.org 主 CDN 对部分文件 / 网络路径呈现 HTTP/2 流中断
      //（ERR_HTTP2_STREAM_ERROR / body terminated——代理出口实测同文件 2/2 复现、
      // export.arxiv.org 官方镜像 2/2 稳定）。确定性失败（非 PDF 内容 / 取消 /
      // SSRF 拒绝）不回退；网络类失败按官方镜像做一次有界回退——同一库、每跳
      // 护栏照常、finalUrl 如实记录镜像地址（provenance 可审计）。
      if (options.signal?.aborted) {
        throw error;
      }
      const mirror = arxivExportMirrorOf(url);
      if (mirror === undefined || !isRecoverableDownloadFailure(error)) {
        throw error;
      }
      return await downloadPdfHops(mirror, options, options.maxBytes ?? MAX_SOURCE_BYTES);
    }
  } finally {
    release();
  }
}

/** arxiv.org(/www) 的 /pdf/ 路径 → 官方 export.arxiv.org 镜像；其余 undefined */
function arxivExportMirrorOf(url: string): string | undefined {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    return undefined;
  }
  const host = parsed.hostname.toLowerCase();
  if (host !== "arxiv.org" && host !== "www.arxiv.org") {
    return undefined;
  }
  if (!parsed.pathname.startsWith("/pdf/")) {
    return undefined;
  }
  return `https://export.arxiv.org${parsed.pathname}`;
}

/** 网络类下载失败（重试 / 镜像回退有意义的形态）；确定性内容判定与取消不算 */
function isRecoverableDownloadFailure(error: unknown): boolean {
  if (!(error instanceof BusinessError) || error.code !== "FULLTEXT_DOWNLOAD_FAILED") {
    return false;
  }
  const message = error.message;
  if (message.includes("不是 PDF") || message.includes("已被取消")) {
    return false;
  }
  return true;
}

async function downloadPdfHops(url: string, options: DownloadPdfOptions, maxBytes: number): Promise<DownloadedPdf> {
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
          // 只接受 application/pdf 会被部分中文期刊平台（rc-pub：响应为 application/pdf;charset=utf-8）
          // 以 406 拒绝；保留 PDF 优先并允许回退，内容是否为 PDF 仍由下方 %PDF- 魔数判定
          headers: { "User-Agent": USER_AGENT, Accept: "application/pdf,*/*;q=0.8" },
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

/**
 * 内网 / 本地主机判定：实现迁至 network/hosts.ts（M13.8 与代理旁路共用同一判定），
 * 此处保留 re-export 以兼容既有导入路径。
 */
export { isPrivateOrLocalHost } from "../network/hosts.js";

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
