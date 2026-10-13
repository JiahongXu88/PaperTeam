/**
 * Network Settings（M13.8）：Research 代理的状态 / 保存 / 测试连接。
 *
 * 优先级：env `PAPERTEAM_RESEARCH_PROXY_URL` > UI 保存（network.json）> 直连。
 * env 覆盖时保存仍被允许（env 移除后生效），但不会改写运行中的 router。
 *
 * 生效边界：保存后对**后续新请求**立即生效（ResearchFetchRouter.configure 优雅
 * 退役旧 dispatcher，不中断在途请求）；不触碰模型 Runtime、不需要 409 busy 检查。
 *
 * 测试连接：用候选配置（可以是尚未保存的表单值）建一个临时 router，对
 * 代理 TCP 可达性 / arXiv API / arXiv PDF 首段下载 / OpenAlex / Semantic Scholar /
 * Crossref 逐项探测并分类（ok / rate_limited / http_error / timeout /
 * proxy_unreachable / proxy_rejected / network_error / not_pdf）。探测走独立
 * fetch，不经过生产 ProviderHttpClient / ScholarlyHttpClient——不污染熔断与冷却状态。
 */

import { connect as netConnect } from "node:net";

import { BusinessError } from "../errors.js";
import {
  ResearchFetchRouter,
  ResearchProxyConfigError,
  ResearchProxyError,
  formatResearchProxyUrl,
  normalizeResearchProxyConfig,
  parseResearchProxyUrl,
  type ResearchFetchRouterStats,
  type ResearchProxyConfig,
} from "../network/researchProxy.js";
import type { NetworkSettingsStore, StoredResearchProxy } from "./NetworkSettingsStore.js";

export type NetworkConfigurationSource = "environment" | "stored" | "none";

export interface NetworkSettingsStatus {
  /** 生效配置（env 或已启用的保存值）；直连时 null */
  effective: ResearchProxyConfig | null;
  /** 生效配置的规范 URL（展示用；无凭据） */
  effectiveUrl?: string;
  source: NetworkConfigurationSource;
  envOverride: boolean;
  /** UI 保存的偏好（含 enabled=false 的保留输入）；未保存过 = null */
  saved: StoredResearchProxy | null;
  savedAt?: string;
  scope: {
    appliesTo: string[];
    notAppliedTo: string[];
    bypass: string;
  };
  routerStats: ResearchFetchRouterStats;
}

export type NetworkCheckId = "proxy" | "arxiv_api" | "arxiv_pdf" | "openalex" | "semantic_scholar" | "crossref";

export type NetworkCheckStatus =
  | "ok"
  | "rate_limited"
  | "http_error"
  | "timeout"
  | "proxy_unreachable"
  | "proxy_rejected"
  | "network_error"
  | "not_pdf"
  | "skipped";

export interface NetworkCheckResult {
  id: NetworkCheckId;
  label: string;
  /** 探测目标（主机级；不含任何 key / mailto） */
  target: string;
  status: NetworkCheckStatus;
  httpStatus?: number;
  latencyMs?: number;
  firstByteMs?: number;
  bytes?: number;
  throughputKBps?: number;
  retryAfterSeconds?: number;
  /** 简洁的用户可读说明（中文；不含敏感信息） */
  detail: string;
}

export interface NetworkTestResult {
  /** 核心路径（代理可达 + arXiv API + arXiv PDF）全部通过 */
  ok: boolean;
  mode: "proxy" | "direct";
  proxy?: string;
  checkedAt: string;
  durationMs: number;
  checks: NetworkCheckResult[];
  summary: string;
}

export interface NetworkProbeRouter {
  fetch: typeof fetch;
  close(): Promise<void>;
}

export interface NetworkSettingsServiceOptions {
  store: NetworkSettingsStore;
  router: ResearchFetchRouter;
  /** PAPERTEAM_RESEARCH_PROXY_URL（已由 config 校验；存在即覆盖 UI） */
  envProxyUrl?: string;
  /** 探测请求携带的礼貌 / 认证标识（与生产 provider 同一配置；绝不进入返回值） */
  hints?: {
    openalexMailto?: string;
    semanticScholarApiKey?: string;
    crossrefMailto?: string;
  };
  /** 探测 router 工厂（测试注入：返回 canned Response，不出网） */
  createProbeRouter?: (config: ResearchProxyConfig | null) => NetworkProbeRouter;
  /** 代理 TCP 可达性探测（测试注入） */
  connectProbe?: (host: string, port: number, timeoutMs: number) => Promise<{ ok: boolean; code?: string }>;
  /** 单项 HTTP 探测超时（缺省 10s；PDF 首段 20s） */
  probeTimeoutMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

export const NETWORK_PROXY_SCOPE = {
  appliesTo: [
    "学术检索（OpenAlex / arXiv / Semantic Scholar / AMiner）",
    "Web 检索 Provider（SearXNG 等公网地址）",
    "文献元数据核验（Crossref / OpenAlex / Semantic Scholar / arXiv / Unpaywall / GitHub 软件引用）",
    "合法开放获取全文 PDF 下载（FullTextResolver）",
  ],
  notAppliedTo: [
    "模型 API 请求（Pi Runtime / 公司模型网关 / 自定义模型 Provider）",
    "本机 PaperTeam HTTP API",
    "docling 本地解析、LaTeX 编译",
    "Git / GitHub 与用户其它程序",
  ],
  bypass: "回环 / 私网 / 单标签主机名（如本机 SearXNG）始终直连",
} as const;

const DEFAULT_PROBE_TIMEOUT_MS = 10_000;
const PDF_PROBE_TIMEOUT_MS = 20_000;
/** PDF 首段探测读取上限：足够验证 %PDF- 头与估算吞吐，不做整篇下载 */
const PDF_PROBE_MAX_BYTES = 256 * 1024;
const CONNECT_PROBE_TIMEOUT_MS = 4_000;
const USER_AGENT = "PaperTeam/0.1 (network settings connectivity probe)";

/**
 * 探测目标（固定、公开、与文献遴选无关）：arXiv PDF 用 arXiv:1706.03762
 * （Attention Is All You Need；仅读首 256KB 验证 PDF 头与吞吐）。
 */
const PROBES: Record<Exclude<NetworkCheckId, "proxy">, { label: string; target: string; url: string }> = {
  arxiv_api: {
    label: "arXiv API（检索）",
    target: "export.arxiv.org",
    url: "https://export.arxiv.org/api/query?search_query=all:electron&max_results=1",
  },
  arxiv_pdf: {
    label: "arXiv PDF 下载（首段）",
    target: "arxiv.org",
    url: "https://arxiv.org/pdf/1706.03762",
  },
  openalex: {
    label: "OpenAlex（检索 / 元数据）",
    target: "api.openalex.org",
    url: "https://api.openalex.org/works?search=electron&per-page=1",
  },
  semantic_scholar: {
    label: "Semantic Scholar（检索 / 元数据）",
    target: "api.semanticscholar.org",
    url: "https://api.semanticscholar.org/graph/v1/paper/search?query=electron&limit=1",
  },
  crossref: {
    label: "Crossref（引用元数据）",
    target: "api.crossref.org",
    url: "https://api.crossref.org/works?rows=1&query=electron",
  },
};

function defaultConnectProbe(host: string, port: number, timeoutMs: number): Promise<{ ok: boolean; code?: string }> {
  return new Promise((resolve) => {
    const socket = netConnect({ host, port });
    const finish = (result: { ok: boolean; code?: string }) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs, () => finish({ ok: false, code: "ETIMEDOUT" }));
    socket.once("connect", () => finish({ ok: true }));
    socket.once("error", (error: NodeJS.ErrnoException) => finish({ ok: false, code: error.code ?? "ERROR" }));
  });
}

export class NetworkSettingsService {
  private readonly store: NetworkSettingsStore;
  private readonly router: ResearchFetchRouter;
  private readonly envProxy: ResearchProxyConfig | null;
  private readonly hints: NonNullable<NetworkSettingsServiceOptions["hints"]>;
  private readonly createProbeRouter: (config: ResearchProxyConfig | null) => NetworkProbeRouter;
  private readonly connectProbe: NonNullable<NetworkSettingsServiceOptions["connectProbe"]>;
  private readonly probeTimeoutMs: number;
  private readonly now: () => number;
  private readonly log: (message: string) => void;

  constructor(options: NetworkSettingsServiceOptions) {
    this.store = options.store;
    this.router = options.router;
    this.envProxy = options.envProxyUrl !== undefined ? parseResearchProxyUrl(options.envProxyUrl) : null;
    this.hints = options.hints ?? {};
    this.createProbeRouter =
      options.createProbeRouter ??
      ((config) => {
        const probe = new ResearchFetchRouter({ releaseGraceMs: 30_000 });
        probe.configure(config);
        return probe;
      });
    this.connectProbe = options.connectProbe ?? defaultConnectProbe;
    this.probeTimeoutMs = options.probeTimeoutMs ?? DEFAULT_PROBE_TIMEOUT_MS;
    this.now = options.now ?? Date.now;
    this.log = options.log ?? (() => {});
  }

  /**
   * 启动装配：按优先级把生效配置写进 router（env > stored enabled > 直连）。
   * index.ts 在 buildServiceStack 之前调用；返回生效配置用于启动日志。
   */
  async applyStartupConfiguration(): Promise<ResearchProxyConfig | null> {
    const effective = await this.resolveEffective();
    this.router.configure(effective);
    return effective;
  }

  async getStatus(): Promise<NetworkSettingsStatus> {
    const stored = await this.store.load();
    const saved = stored.proxy ?? null;
    const effective = this.envProxy ?? (saved !== null && saved.enabled ? toConfig(saved) : null);
    const source: NetworkConfigurationSource =
      this.envProxy !== null ? "environment" : effective !== null ? "stored" : "none";
    return {
      effective,
      ...(effective !== null ? { effectiveUrl: formatResearchProxyUrl(effective) } : {}),
      source,
      envOverride: this.envProxy !== null,
      saved,
      ...(stored.savedAt !== undefined ? { savedAt: stored.savedAt } : {}),
      scope: {
        appliesTo: [...NETWORK_PROXY_SCOPE.appliesTo],
        notAppliedTo: [...NETWORK_PROXY_SCOPE.notAppliedTo],
        bypass: NETWORK_PROXY_SCOPE.bypass,
      },
      routerStats: this.router.stats(),
    };
  }

  /** 保存偏好；env 未覆盖时立即切换 router（只影响后续新请求） */
  async save(input: { enabled: boolean; protocol: string; host: string; port: number | string }): Promise<NetworkSettingsStatus> {
    const config = this.normalize(input);
    const proxy: StoredResearchProxy = { ...config, enabled: input.enabled };
    await this.store.save({ proxy });
    if (this.envProxy === null) {
      const { changed } = this.router.configure(proxy.enabled ? config : null);
      this.log(
        `[network] 保存网络设置：${proxy.enabled ? formatResearchProxyUrl(config) : "直连"}${changed ? "（已对后续请求生效）" : "（与当前生效配置相同）"}`,
      );
    } else {
      this.log("[network] 保存网络设置：PAPERTEAM_RESEARCH_PROXY_URL 覆盖中，保存值将在环境变量移除后生效");
    }
    return this.getStatus();
  }

  /**
   * 测试连接：input 缺省 = 测试当前生效配置；给出候选 = 测试候选（可未保存）。
   * enabled=false 的候选即直连测试（用于对照）。
   */
  async test(input?: { enabled: boolean; protocol: string; host: string; port: number | string }): Promise<NetworkTestResult> {
    const startedAt = this.now();
    const candidate: ResearchProxyConfig | null =
      input === undefined ? await this.resolveEffective() : input.enabled ? this.normalize(input) : null;
    const checks: NetworkCheckResult[] = [];
    const proxyCheck = await this.checkProxyReachable(candidate);
    checks.push(proxyCheck);
    const probe = this.createProbeRouter(candidate);
    try {
      if (proxyCheck.status === "ok" || proxyCheck.status === "skipped") {
        const results = await Promise.all([
          this.probeText(probe, "arxiv_api", (body) => body.includes("<feed")),
          this.probePdfHead(probe),
          this.probeText(probe, "openalex", (body) => body.includes("\"results\"")),
          this.probeText(probe, "semantic_scholar", (body) => body.includes("\"data\"") || body.includes("\"total\"")),
          this.probeText(probe, "crossref", (body) => body.includes("\"status\":\"ok\"")),
        ]);
        checks.push(...results);
      } else {
        for (const id of ["arxiv_api", "arxiv_pdf", "openalex", "semantic_scholar", "crossref"] as const) {
          checks.push({
            id,
            label: PROBES[id].label,
            target: PROBES[id].target,
            status: "skipped",
            detail: "代理不可连接，未探测",
          });
        }
      }
    } finally {
      await probe.close().catch(() => {});
    }
    const core = checks.filter((check) => check.id === "proxy" || check.id === "arxiv_api" || check.id === "arxiv_pdf");
    const ok = core.every((check) => check.status === "ok" || (check.id === "proxy" && check.status === "skipped"));
    const result: NetworkTestResult = {
      ok,
      mode: candidate === null ? "direct" : "proxy",
      ...(candidate !== null ? { proxy: formatResearchProxyUrl(candidate) } : {}),
      checkedAt: new Date(startedAt).toISOString(),
      durationMs: this.now() - startedAt,
      checks,
      summary: summarize(candidate, checks, ok),
    };
    this.log(`[network] 测试连接 ${result.mode}${result.proxy !== undefined ? ` ${result.proxy}` : ""}：${result.summary}`);
    return result;
  }

  // ---- 内部 ----

  private normalize(input: { protocol: string; host: string; port: number | string }): ResearchProxyConfig {
    try {
      return normalizeResearchProxyConfig(input);
    } catch (error) {
      if (error instanceof ResearchProxyConfigError) {
        throw new BusinessError("INVALID_REQUEST", error.message);
      }
      throw error;
    }
  }

  private async resolveEffective(): Promise<ResearchProxyConfig | null> {
    if (this.envProxy !== null) {
      return this.envProxy;
    }
    const stored = await this.store.load();
    return stored.proxy !== undefined && stored.proxy.enabled ? toConfig(stored.proxy) : null;
  }

  private async checkProxyReachable(candidate: ResearchProxyConfig | null): Promise<NetworkCheckResult> {
    if (candidate === null) {
      return { id: "proxy", label: "代理可连接性", target: "—", status: "skipped", detail: "未启用代理（直连测试）" };
    }
    const target = formatResearchProxyUrl(candidate);
    const started = this.now();
    const outcome = await this.connectProbe(candidate.host, candidate.port, CONNECT_PROBE_TIMEOUT_MS);
    const latencyMs = this.now() - started;
    if (outcome.ok) {
      return { id: "proxy", label: "代理可连接性", target, status: "ok", latencyMs, detail: `代理端口可连接（${latencyMs}ms）` };
    }
    return {
      id: "proxy",
      label: "代理可连接性",
      target,
      status: outcome.code === "ETIMEDOUT" ? "timeout" : "proxy_unreachable",
      latencyMs,
      detail:
        outcome.code === "ECONNREFUSED"
          ? "代理端口拒绝连接：请确认代理软件已启动且端口正确"
          : outcome.code === "ETIMEDOUT"
            ? "连接代理超时：地址可能不正确或被防火墙拦截"
            : `无法连接代理（${outcome.code ?? "未知错误"}）`,
    };
  }

  private headersFor(id: Exclude<NetworkCheckId, "proxy">): Record<string, string> {
    const headers: Record<string, string> = { "User-Agent": USER_AGENT };
    if (id === "openalex" && this.hints.openalexMailto !== undefined) {
      headers["X-User-Agent"] = `mailto:${this.hints.openalexMailto}`;
    }
    if (id === "crossref" && (this.hints.crossrefMailto ?? this.hints.openalexMailto) !== undefined) {
      headers["X-User-Agent"] = `mailto:${this.hints.crossrefMailto ?? this.hints.openalexMailto}`;
    }
    if (id === "semantic_scholar" && this.hints.semanticScholarApiKey !== undefined) {
      headers["x-api-key"] = this.hints.semanticScholarApiKey;
    }
    headers["Accept"] = id === "arxiv_pdf" ? "application/pdf" : id === "arxiv_api" ? "application/atom+xml" : "application/json";
    return headers;
  }

  private urlFor(id: Exclude<NetworkCheckId, "proxy">): string {
    const base = PROBES[id].url;
    if (id === "openalex" && this.hints.openalexMailto !== undefined) {
      return `${base}&mailto=${encodeURIComponent(this.hints.openalexMailto)}`;
    }
    return base;
  }

  private async probeText(
    probe: NetworkProbeRouter,
    id: Exclude<NetworkCheckId, "proxy">,
    looksValid: (body: string) => boolean,
  ): Promise<NetworkCheckResult> {
    const spec = PROBES[id];
    const base = { id, label: spec.label, target: spec.target };
    const started = this.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("probe timeout")), this.probeTimeoutMs);
    try {
      const response = await probe.fetch(this.urlFor(id), { headers: this.headersFor(id), signal: controller.signal });
      const firstByteMs = this.now() - started;
      if (response.status === 429) {
        const retryAfter = parseRetryAfterSeconds(response.headers.get("retry-after"));
        await response.body?.cancel().catch(() => {});
        return {
          ...base,
          status: "rate_limited",
          httpStatus: 429,
          latencyMs: this.now() - started,
          ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}),
          detail: rateLimitDetail(id, retryAfter),
        };
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return { ...base, status: "http_error", httpStatus: response.status, latencyMs: this.now() - started, detail: `服务返回 HTTP ${response.status}` };
      }
      const text = await response.text();
      const latencyMs = this.now() - started;
      if (!looksValid(text)) {
        return { ...base, status: "http_error", httpStatus: response.status, latencyMs, firstByteMs, detail: "返回内容不是预期格式（可能被拦截页替换）" };
      }
      return { ...base, status: "ok", httpStatus: response.status, latencyMs, firstByteMs, bytes: Buffer.byteLength(text), detail: `可访问（${latencyMs}ms）` };
    } catch (error) {
      return { ...base, ...classifyProbeError(error, this.now() - started) };
    } finally {
      clearTimeout(timer);
    }
  }

  private async probePdfHead(probe: NetworkProbeRouter): Promise<NetworkCheckResult> {
    const spec = PROBES.arxiv_pdf;
    const base = { id: "arxiv_pdf" as const, label: spec.label, target: spec.target };
    const started = this.now();
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("probe timeout")), PDF_PROBE_TIMEOUT_MS);
    try {
      const response = await probe.fetch(spec.url, {
        headers: this.headersFor("arxiv_pdf"),
        signal: controller.signal,
        redirect: "follow",
      });
      const firstByteMs = this.now() - started;
      if (response.status === 429) {
        const retryAfter = parseRetryAfterSeconds(response.headers.get("retry-after"));
        await response.body?.cancel().catch(() => {});
        return { ...base, status: "rate_limited", httpStatus: 429, latencyMs: this.now() - started, ...(retryAfter !== undefined ? { retryAfterSeconds: retryAfter } : {}), detail: rateLimitDetail("arxiv_pdf", retryAfter) };
      }
      if (!response.ok) {
        await response.body?.cancel().catch(() => {});
        return { ...base, status: "http_error", httpStatus: response.status, latencyMs: this.now() - started, detail: `服务返回 HTTP ${response.status}` };
      }
      const reader = response.body?.getReader();
      if (reader === undefined) {
        return { ...base, status: "network_error", httpStatus: response.status, latencyMs: this.now() - started, detail: "响应没有可读的正文流" };
      }
      const parts: Uint8Array[] = [];
      let total = 0;
      while (total < PDF_PROBE_MAX_BYTES) {
        const { done, value } = await reader.read();
        if (done) {
          break;
        }
        parts.push(value);
        total += value.byteLength;
      }
      await reader.cancel().catch(() => {});
      const latencyMs = this.now() - started;
      const head = Buffer.concat(parts.map((part) => Buffer.from(part))).subarray(0, 5).toString("latin1");
      if (head !== "%PDF-") {
        return { ...base, status: "not_pdf", httpStatus: response.status, latencyMs, firstByteMs, bytes: total, detail: "返回内容不是 PDF（可能是落地页 / 拦截页）" };
      }
      const transferMs = Math.max(1, latencyMs - firstByteMs);
      const throughputKBps = Math.round((total / 1024) / (transferMs / 1000));
      return {
        ...base,
        status: "ok",
        httpStatus: response.status,
        latencyMs,
        firstByteMs,
        bytes: total,
        throughputKBps,
        detail: `PDF 头合法；首字节 ${firstByteMs}ms，首 ${Math.round(total / 1024)}KB 约 ${throughputKBps}KB/s`,
      };
    } catch (error) {
      return { ...base, ...classifyProbeError(error, this.now() - started) };
    } finally {
      clearTimeout(timer);
    }
  }
}

function toConfig(stored: StoredResearchProxy): ResearchProxyConfig {
  return { protocol: stored.protocol, host: stored.host, port: stored.port };
}

function parseRetryAfterSeconds(raw: string | null): number | undefined {
  if (raw === null || raw.trim() === "") {
    return undefined;
  }
  const seconds = Number(raw.trim());
  if (Number.isFinite(seconds)) {
    return Math.max(0, Math.round(seconds));
  }
  const asDate = Date.parse(raw.trim());
  return Number.isFinite(asDate) ? Math.max(0, Math.round((asDate - Date.now()) / 1000)) : undefined;
}

function rateLimitDetail(id: NetworkCheckId, retryAfterSeconds: number | undefined): string {
  const wait =
    retryAfterSeconds === undefined
      ? ""
      : retryAfterSeconds >= 3600
        ? `，约 ${Math.round(retryAfterSeconds / 3600)} 小时后重置`
        : `，${retryAfterSeconds}s 后可重试`;
  if (id === "openalex") {
    return `匿名额度已用尽（按出口 IP 计）${wait}；与代理无关，可申请免费 OpenAlex API Key`;
  }
  if (id === "semantic_scholar") {
    return `匿名限流${wait}；可配置 PAPERTEAM_SEMANTIC_SCHOLAR_API_KEY`;
  }
  return `服务限流（429）${wait}`;
}

function classifyProbeError(error: unknown, latencyMs: number): Pick<NetworkCheckResult, "status" | "latencyMs" | "detail"> {
  if (error instanceof ResearchProxyError) {
    return {
      status: error.kind,
      latencyMs,
      detail: error.kind === "proxy_unreachable" ? "代理不可连接（请求阶段）" : "代理拒绝建立到目标站点的隧道",
    };
  }
  if (error instanceof Error) {
    const message = error.message;
    if (error.name === "AbortError" || error.name === "TimeoutError" || message.includes("probe timeout")) {
      return { status: "timeout", latencyMs, detail: "连接超时（目标站点在当前网络下不可达或过慢）" };
    }
    const cause = (error as { cause?: { code?: unknown; message?: unknown } }).cause;
    const code = typeof cause?.code === "string" ? cause.code : undefined;
    return {
      status: "network_error",
      latencyMs,
      detail: code !== undefined ? `网络错误（${code}）` : `网络错误：${message.slice(0, 80)}`,
    };
  }
  return { status: "network_error", latencyMs, detail: "网络错误" };
}

function summarize(candidate: ResearchProxyConfig | null, checks: NetworkCheckResult[], ok: boolean): string {
  const proxy = checks.find((check) => check.id === "proxy");
  if (proxy !== undefined && proxy.status !== "ok" && proxy.status !== "skipped") {
    return `代理 ${candidate !== null ? formatResearchProxyUrl(candidate) : ""} 不可连接，学术服务探测已跳过`;
  }
  const pdf = checks.find((check) => check.id === "arxiv_pdf");
  const okCount = checks.filter((check) => check.id !== "proxy" && check.status === "ok").length;
  const limited = checks.filter((check) => check.status === "rate_limited").map((check) => check.label.split("（")[0]);
  const mode = candidate === null ? "直连" : `代理 ${formatResearchProxyUrl(candidate)}`;
  const parts = [
    `${mode}：${okCount}/${checks.filter((check) => check.id !== "proxy").length} 项学术服务可访问`,
    pdf !== undefined && pdf.status === "ok" && pdf.throughputKBps !== undefined ? `arXiv PDF 约 ${pdf.throughputKBps}KB/s` : undefined,
    limited.length > 0 ? `限流：${limited.join(" / ")}（与代理无关）` : undefined,
    ok ? undefined : "核心路径（代理 / arXiv API / arXiv PDF）未全部通过",
  ].filter((part): part is string => part !== undefined);
  return parts.join("；");
}
