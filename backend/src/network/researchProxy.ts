/**
 * Research 网络代理（M13.8）：学术检索 / 文献元数据核验 / 合法全文下载的
 * **可选**出口代理。
 *
 * 边界（产品契约，docs/network-settings.md）：
 * - 只作用于经 ResearchFetchRouter.fetch 发出的请求——ProviderHttpClient
 *   （OpenAlex / arXiv / Semantic Scholar / AMiner / SearXNG / FullText 下载）与
 *   ScholarlyHttpClient / SoftwareReferenceResolver（Crossref / OpenAlex / S2 /
 *   arXiv / Unpaywall / GitHub 元数据核验）；
 * - 不触碰进程全局 dispatcher（禁止 setGlobalDispatcher）：Pi Runtime 模型请求、
 *   公司模型网关、自定义模型 Provider、ModelDiscovery、本机 HTTP API、docling、
 *   git 等一切其它出口保持原样；
 * - 回环 / 私网 / 单标签主机名（本机 SearXNG、compose 服务名）一律直连；
 * - 未配置代理时 fetch 即 globalThis.fetch——与旧版逐字节一致的行为；
 * - 代理 URL 不接受 userinfo（初版明确拒绝需要认证的代理；凭据永不入日志）。
 *
 * 实现：undici（npm 8.x）的 fetch + ProxyAgent / Socks5ProxyAgent。Node 22 内建
 * fetch 绑定的是 undici 6，不能与 npm 版 Dispatcher 混用（实测 UND_ERR_INVALID_ARG），
 * 因此代理路径整体走 npm undici 的 fetch；直连路径仍走内建 fetch。
 *
 * 切换语义：configure() 立即对后续新请求生效；旧 dispatcher 优雅关闭
 * （close() 等在途请求自然结束），超过宽限期才 destroy——不中断正在执行的请求。
 */

import { ProxyAgent, Socks5ProxyAgent, fetch as undiciFetch, type Dispatcher } from "undici";

import { shouldBypassResearchProxy } from "./hosts.js";

export const RESEARCH_PROXY_PROTOCOLS = ["http", "socks5"] as const;
export type ResearchProxyProtocol = (typeof RESEARCH_PROXY_PROTOCOLS)[number];

export interface ResearchProxyConfig {
  protocol: ResearchProxyProtocol;
  /** 主机名 / IPv4 / IPv6 字面量（IPv6 不带方括号） */
  host: string;
  port: number;
}

/** 代理配置非法（URL / 字段）：调用方按上下文映射为 ConfigError 或 400 */
export class ResearchProxyConfigError extends Error {
  override readonly name = "ResearchProxyConfigError";
}

/** 代理不可达等代理层失败（由 router 从 undici 的 fetch failed + cause 归类） */
export class ResearchProxyError extends Error {
  override readonly name = "ResearchProxyError";
  readonly kind: "proxy_unreachable" | "proxy_rejected";
  readonly proxy: string;

  constructor(kind: ResearchProxyError["kind"], proxy: string, message: string, cause?: unknown) {
    super(message, cause !== undefined ? { cause } : undefined);
    this.kind = kind;
    this.proxy = proxy;
  }
}

const MAX_PORT = 65_535;

function isProtocol(value: string): value is ResearchProxyProtocol {
  return (RESEARCH_PROXY_PROTOCOLS as readonly string[]).includes(value);
}

/** 字段级归一化与校验（UI 保存路径）；IPv6 可带或不带方括号 */
export function normalizeResearchProxyConfig(input: {
  protocol: string;
  host: string;
  port: number | string;
}): ResearchProxyConfig {
  const protocol = input.protocol.trim().toLowerCase();
  if (!isProtocol(protocol)) {
    throw new ResearchProxyConfigError(
      `代理类型只能是 ${RESEARCH_PROXY_PROTOCOLS.join(" / ")}（收到 "${protocol.slice(0, 20)}"）`,
    );
  }
  const rawHost = input.host.trim();
  if (rawHost.includes("://")) {
    throw new ResearchProxyConfigError("代理地址不要带协议前缀（如 http://），协议请用「代理类型」选择");
  }
  const host = rawHost.replace(/^\[|\]$/g, "").toLowerCase();
  if (host === "") {
    throw new ResearchProxyConfigError("代理地址不能为空（如 127.0.0.1）");
  }
  if (/[\s/@#?]/.test(host) || (host.includes(":") && !/^[0-9a-f:.]+$/i.test(host))) {
    throw new ResearchProxyConfigError("代理地址只填主机名或 IP，不含协议、路径、端口或账号信息");
  }
  const port = typeof input.port === "string" ? Number.parseInt(input.port.trim(), 10) : input.port;
  if (!Number.isInteger(port) || port < 1 || port > MAX_PORT) {
    throw new ResearchProxyConfigError(`代理端口必须是 1-${MAX_PORT} 的整数（如 7890）`);
  }
  return { protocol, host, port };
}

/**
 * 解析代理 URL（环境变量 PAPERTEAM_RESEARCH_PROXY_URL）：
 * `http://host:port` / `socks5://host:port`（接受 socks5h 同义）。必须显式带端口；
 * 不接受 userinfo（带账号密码一律拒绝，且错误信息不回显原文）；不接受路径 / 查询。
 */
export function parseResearchProxyUrl(raw: string): ResearchProxyConfig {
  const trimmed = raw.trim();
  const safeEcho = trimmed.includes("@") ? "<含账号信息，已隐去>" : trimmed.slice(0, 120);
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ResearchProxyConfigError(`代理 URL 不合法："${safeEcho}"（示例：http://127.0.0.1:7890）`);
  }
  if (url.username !== "" || url.password !== "") {
    throw new ResearchProxyConfigError("暂不支持需要账号密码认证的代理（URL 不得包含 userinfo）");
  }
  const scheme = url.protocol.replace(/:$/, "").toLowerCase();
  const protocol: ResearchProxyProtocol | undefined =
    scheme === "http" ? "http" : scheme === "socks5" || scheme === "socks5h" ? "socks5" : undefined;
  if (protocol === undefined) {
    throw new ResearchProxyConfigError(`代理协议只支持 http:// 或 socks5://（收到 ${scheme}://）`);
  }
  if (url.port === "") {
    throw new ResearchProxyConfigError(
      `代理 URL 必须显式包含端口："${safeEcho}"（示例：http://127.0.0.1:7890）`,
    );
  }
  if ((url.pathname !== "" && url.pathname !== "/") || url.search !== "" || url.hash !== "") {
    throw new ResearchProxyConfigError("代理 URL 只能是 协议://主机:端口，不接受路径 / 查询参数");
  }
  return normalizeResearchProxyConfig({ protocol, host: url.hostname, port: url.port });
}

/** 展示 / 构造 dispatcher 用的规范 URL（IPv6 自动加方括号；无凭据） */
export function formatResearchProxyUrl(config: ResearchProxyConfig): string {
  const host = config.host.includes(":") ? `[${config.host}]` : config.host;
  return `${config.protocol}://${host}:${config.port}`;
}

export function sameResearchProxyConfig(
  a: ResearchProxyConfig | null,
  b: ResearchProxyConfig | null,
): boolean {
  if (a === null || b === null) {
    return a === b;
  }
  return a.protocol === b.protocol && a.host === b.host && a.port === b.port;
}

/** 生产 dispatcher 工厂（测试注入 fake） */
export function createResearchProxyDispatcher(config: ResearchProxyConfig): Dispatcher {
  const uri = formatResearchProxyUrl(config);
  if (config.protocol === "socks5") {
    // undici 8：SOCKS5 支持标记为 experimental（构造时打印一次 ExperimentalWarning）
    return new Socks5ProxyAgent(uri);
  }
  return new ProxyAgent(uri);
}

export type ProxiedFetch = (
  url: string,
  init: RequestInit | undefined,
  dispatcher: Dispatcher,
) => Promise<Response>;

/** 默认代理路径：npm undici fetch + dispatcher（与内建 fetch 的 Response 结构兼容，仅类型不同） */
const defaultProxiedFetch: ProxiedFetch = (url, init, dispatcher) =>
  undiciFetch(url, { ...(init as object), dispatcher } as never) as unknown as Promise<Response>;

export interface ResearchFetchRouterOptions {
  /** 直连 fetch（缺省 globalThis.fetch——未配置代理时与旧版一致） */
  directFetch?: typeof fetch;
  /** 代理路径 fetch（测试注入：记录用了哪个 dispatcher，不出网） */
  proxiedFetch?: ProxiedFetch;
  /** dispatcher 工厂（测试注入 fake，可观测 close / destroy） */
  createDispatcher?: (config: ResearchProxyConfig) => Dispatcher;
  /** 旧 dispatcher 优雅关闭的宽限（毫秒；超过即 destroy；缺省 5 分钟） */
  releaseGraceMs?: number;
  log?: (message: string) => void;
}

export interface ResearchFetchRouterStats {
  proxied: number;
  direct: number;
  /** 代理启用但目标为回环 / 私网 / 单标签主机名而直连的次数 */
  bypassed: number;
  /** 已退役、仍在等待在途请求结束的 dispatcher 数 */
  retiring: number;
}

interface Generation {
  config: ResearchProxyConfig;
  dispatcher: Dispatcher;
}

const DEFAULT_RELEASE_GRACE_MS = 5 * 60_000;

/** 代理可达性相关的 socket 错误码（cause.code）；其它 fetch failed 原样抛出（目标站点问题） */
const PROXY_SOCKET_CODES = new Set([
  "ECONNREFUSED",
  "ECONNRESET",
  "ENOTFOUND",
  "EHOSTUNREACH",
  "ETIMEDOUT",
  "EAI_AGAIN",
]);

export class ResearchFetchRouter {
  private readonly directFetch: typeof fetch;
  private readonly proxiedFetch: ProxiedFetch;
  private readonly createDispatcher: (config: ResearchProxyConfig) => Dispatcher;
  private readonly releaseGraceMs: number;
  private readonly log: (message: string) => void;
  private active: Generation | null = null;
  private readonly retiring = new Set<Generation>();
  private readonly counters = { proxied: 0, direct: 0, bypassed: 0 };

  /** 可直接注入 fetchImpl 的绑定函数（按调用时的当前配置路由） */
  readonly fetch: typeof fetch;

  constructor(options: ResearchFetchRouterOptions = {}) {
    this.directFetch = options.directFetch ?? ((input, init) => fetch(input, init));
    this.proxiedFetch = options.proxiedFetch ?? defaultProxiedFetch;
    this.createDispatcher = options.createDispatcher ?? createResearchProxyDispatcher;
    this.releaseGraceMs = options.releaseGraceMs ?? DEFAULT_RELEASE_GRACE_MS;
    this.log = options.log ?? (() => {});
    this.fetch = (input, init) => this.route(input, init);
  }

  /** 当前生效代理（null = 直连） */
  current(): ResearchProxyConfig | null {
    return this.active?.config ?? null;
  }

  stats(): ResearchFetchRouterStats {
    return { ...this.counters, retiring: this.retiring.size };
  }

  /**
   * 切换代理（null = 关闭）。对后续新请求立即生效；旧 dispatcher 退役：
   * close() 等待在途请求结束，超过宽限期 destroy。相同配置 no-op。
   */
  configure(next: ResearchProxyConfig | null): { changed: boolean } {
    const previous = this.active;
    if (sameResearchProxyConfig(previous?.config ?? null, next)) {
      return { changed: false };
    }
    this.active = next === null ? null : { config: next, dispatcher: this.createDispatcher(next) };
    if (previous !== null) {
      this.retire(previous);
    }
    this.log(
      `[network] research proxy ${next === null ? "disabled (direct)" : `→ ${formatResearchProxyUrl(next)}`}${
        previous !== null ? `（旧 dispatcher ${formatResearchProxyUrl(previous.config)} 优雅退役）` : ""
      }`,
    );
    return { changed: true };
  }

  /** 关闭全部 dispatcher（进程退出 / 测试清理；在途请求等待结束） */
  async close(): Promise<void> {
    const generations = [...this.retiring, ...(this.active !== null ? [this.active] : [])];
    this.active = null;
    this.retiring.clear();
    await Promise.all(
      generations.map((generation) =>
        generation.dispatcher.close().catch(() => generation.dispatcher.destroy().catch(() => {})),
      ),
    );
  }

  private retire(generation: Generation): void {
    this.retiring.add(generation);
    const timer = setTimeout(() => {
      if (this.retiring.has(generation)) {
        this.retiring.delete(generation);
        this.log(`[network] 旧代理 dispatcher 超过宽限期（${this.releaseGraceMs}ms）仍有在途请求，强制释放`);
        generation.dispatcher.destroy().catch(() => {});
      }
    }, this.releaseGraceMs);
    timer.unref?.();
    generation.dispatcher.close().then(
      () => {
        clearTimeout(timer);
        this.retiring.delete(generation);
      },
      () => {
        clearTimeout(timer);
        this.retiring.delete(generation);
        generation.dispatcher.destroy().catch(() => {});
      },
    );
  }

  private async route(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const generation = this.active;
    if (generation === null) {
      this.counters.direct += 1;
      return this.directFetch(input, init);
    }
    if (typeof input !== "string" && !(input instanceof URL)) {
      // 内部客户端只传 string / URL；Request 对象的 init 不可无损拆解，拒绝而非猜测
      throw new TypeError("ResearchFetchRouter 只接受 string | URL 形式的请求地址");
    }
    const url = typeof input === "string" ? safeUrl(input) : input;
    if (url === undefined || shouldBypassResearchProxy(url.hostname)) {
      this.counters.bypassed += 1;
      return this.directFetch(input, init);
    }
    this.counters.proxied += 1;
    try {
      return await this.proxiedFetch(url.toString(), init, generation.dispatcher);
    } catch (error) {
      throw classifyProxyFailure(error, generation.config);
    }
  }
}

function safeUrl(raw: string): URL | undefined {
  try {
    return new URL(raw);
  } catch {
    return undefined;
  }
}

/**
 * undici 的「fetch failed」把真实原因放在 cause：连不上代理（ECONNREFUSED 到
 * 代理 host:port）/ 代理拒绝隧道（"Proxy response (4xx)"）→ 归类为代理层错误，
 * 消息直接点名代理地址；其它错误（目标站点 / 取消 / 超时）原样抛出。
 */
export function classifyProxyFailure(error: unknown, config: ResearchProxyConfig): unknown {
  if (!(error instanceof Error)) {
    return error;
  }
  if (error.name === "AbortError" || error.name === "TimeoutError") {
    return error;
  }
  const proxy = formatResearchProxyUrl(config);
  const cause = (error as { cause?: unknown }).cause;
  const causeRecord =
    typeof cause === "object" && cause !== null ? (cause as Record<string, unknown>) : undefined;
  const code = typeof causeRecord?.["code"] === "string" ? (causeRecord["code"] as string) : undefined;
  const causeMessage =
    causeRecord !== undefined && typeof causeRecord["message"] === "string"
      ? (causeRecord["message"] as string)
      : "";
  const address = typeof causeRecord?.["address"] === "string" ? (causeRecord["address"] as string) : undefined;
  const port = typeof causeRecord?.["port"] === "number" ? (causeRecord["port"] as number) : undefined;
  const mentionsProxy =
    (address !== undefined && port !== undefined && port === config.port && hostMatches(address, config.host)) ||
    causeMessage.includes(`${config.host}:${config.port}`);
  if (code !== undefined && PROXY_SOCKET_CODES.has(code) && mentionsProxy) {
    return new ResearchProxyError("proxy_unreachable", proxy, `研究代理不可连接（${proxy}）：${code}`, error);
  }
  if (/proxy response/i.test(causeMessage) || /proxy response/i.test(error.message)) {
    return new ResearchProxyError(
      "proxy_rejected",
      proxy,
      `研究代理拒绝建立隧道（${proxy}）：${(causeMessage || error.message).slice(0, 120)}`,
      error,
    );
  }
  return error;
}

function hostMatches(address: string, host: string): boolean {
  const a = address.toLowerCase();
  const h = host.toLowerCase();
  if (a === h) {
    return true;
  }
  // localhost 解析到回环地址
  return h === "localhost" && (a === "127.0.0.1" || a === "::1");
}
