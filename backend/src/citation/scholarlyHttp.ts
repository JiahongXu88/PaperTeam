/**
 * ScholarlyHttpClient + ProviderCooldownRegistry（M13.6）。
 *
 * citation 栈（ScholarlyResolver 的学术库 provider、CitationService 的 bib
 * 元数据 provider）共用的 HTTP 执行器。与 search 栈的 ProviderHttpClient
 * （D-0033）同一套纪律，按 429 自动恢复的需求补齐：
 * - Retry-After 双格式（秒数 / HTTP-date）优先于指数退避；
 * - 指数退避 + 有界抖动（不再固定 300ms 重试一次）；
 * - Provider 级冷却：同一 provider 冷却期内所有组件直接短路（不发网络
 *   请求）——ProviderCooldownRegistry 可跨栈共享（检索与核验同用
 *   Semantic Scholar / Crossref / OpenAlex 时不再各自轰炸）；
 * - 有界等待：单请求重试上限、单次等待帽、冷却帽；
 * - AbortSignal 全程生效（等待与请求都可取消）；
 * - 4xx（除 429）不重试：404 等权威否定立即上抛，由调用方区分
 *   「文献不存在」与「查询失败」——限流绝不折叠成 not_found。
 *
 * 错误分类（ScholarlyHttpError.kind）：
 *   rate_limited（429）/ timeout / network_error / server_error（5xx 重试
 *   耗尽）/ http_error（其它非 2xx，含 404——非重试）/ aborted。
 */

import { parseRetryAfter } from "../search/providerHttp.js";

export type ScholarlyHttpErrorKind =
  | "rate_limited"
  | "timeout"
  | "aborted"
  | "network_error"
  | "server_error"
  | "http_error";

export class ScholarlyHttpError extends Error {
  override readonly name = "ScholarlyHttpError";
  readonly kind: ScholarlyHttpErrorKind;
  readonly provider: string;
  readonly status?: number;
  /** 已解析的 Retry-After / 建议冷却（毫秒；rate_limited） */
  readonly retryAfterMs?: number;
  /** 本请求已完成的尝试次数（含首次） */
  readonly attempts: number;
  /** 本请求累计等待（毫秒；重试间隔之和） */
  readonly waitedMs: number;

  constructor(
    kind: ScholarlyHttpErrorKind,
    provider: string,
    message: string,
    extra: { status?: number; retryAfterMs?: number; attempts?: number; waitedMs?: number } = {},
  ) {
    super(message);
    this.kind = kind;
    this.provider = provider;
    this.status = extra.status;
    this.retryAfterMs = extra.retryAfterMs;
    this.attempts = extra.attempts ?? 1;
    this.waitedMs = extra.waitedMs ?? 0;
  }
}

/**
 * 跨组件共享的 provider 冷却状态（毫秒时钟）。记录取最大值（服务端新
 * Retry-After 不会缩短既有冷却）；remaining 只读查询。
 */
export class ProviderCooldownRegistry {
  private readonly until = new Map<string, number>();

  constructor(private readonly now: () => number = Date.now) {}

  /** 记录冷却（相对毫秒）；返回更新后的剩余毫秒 */
  record(provider: string, cooldownMs: number): number {
    if (cooldownMs <= 0) {
      return this.remaining(provider);
    }
    const until = Math.max(this.until.get(provider) ?? 0, this.now() + cooldownMs);
    this.until.set(provider, until);
    return until - this.now();
  }

  /** 记录冷却（绝对截止 epoch ms；不缩短既有冷却） */
  recordUntil(provider: string, untilMs: number): void {
    const current = this.until.get(provider) ?? 0;
    if (untilMs > current) {
      this.until.set(provider, untilMs);
    }
  }

  /** 剩余冷却毫秒（无冷却 / 已过期 → 0） */
  remaining(provider: string): number {
    const until = this.until.get(provider) ?? 0;
    return Math.max(0, until - this.now());
  }

  /** 冷却截止（epoch ms；无冷却 → 0）。用于「下一次可重试时间」的报告 */
  untilOf(provider: string): number {
    return this.until.get(provider) ?? 0;
  }
}

export interface ScholarlyFetchInit {
  headers?: Record<string, string>;
  signal?: AbortSignal;
  /** 响应体读取模式：text（默认，JSON 由调用方解析） */
}

export interface ScholarlyHttpClientOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  /** 可取消的 sleep（默认 setTimeout；测试注入 fake clock） */
  sleep?: (ms: number, signal?: AbortSignal) => Promise<void>;
  /** 单次 HTTP 请求超时（默认 8000ms） */
  timeoutMs?: number;
  /** 单请求失败重试上限（默认 2 → 最多 3 次尝试） */
  maxRetries?: number;
  /** Retry-After 单次请求内等待硬帽（默认 10s；超帽立即失败进冷却） */
  retryAfterRequestWaitCapMs?: number;
  /** provider 冷却硬帽（默认 120s；无 Retry-After 的 429 也按帽值冷却） */
  cooldownCapMs?: number;
  /** 无 Retry-After 的 429 的默认冷却（默认 10s） */
  rateLimitDefaultCooldownMs?: number;
  /** 指数退避基数与抖动上限（默认 500ms / 250ms） */
  backoffBaseMs?: number;
  backoffJitterMs?: number;
  /** 跨组件共享冷却（缺省 = 客户端私有状态） */
  cooldownRegistry?: ProviderCooldownRegistry;
  log?: (message: string) => void;
}

const DEFAULT_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_RETRY_AFTER_REQUEST_WAIT_CAP_MS = 10_000;
const DEFAULT_COOLDOWN_CAP_MS = 120_000;
const DEFAULT_RATE_LIMIT_DEFAULT_COOLDOWN_MS = 10_000;
const DEFAULT_BACKOFF_BASE_MS = 500;
const DEFAULT_BACKOFF_JITTER_MS = 250;

export interface ScholarlyHttpTelemetry {
  requests: number;
  retries: number;
  rateLimited: number;
  /** 冷却短路（未发网络请求即被冷却闸门拒绝）的次数 */
  cooldownSkips: number;
  /** 重试等待累计（毫秒） */
  totalWaitMs: number;
  byProvider: Map<string, { requests: number; rateLimited: number; errors: number }>;
}

/** 可中断 sleep：aborted 时以 aborted 错误结束等待 */
function defaultSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    if (signal?.aborted) {
      reject(new ScholarlyHttpError("aborted", "", "请求已被调用方取消"));
      return;
    }
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new ScholarlyHttpError("aborted", "", "等待重试时被调用方取消"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export class ScholarlyHttpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleepImpl: (ms: number, signal?: AbortSignal) => Promise<void>;
  readonly timeoutMs: number;
  private readonly maxRetries: number;
  private readonly retryAfterRequestWaitCapMs: number;
  private readonly cooldownCapMs: number;
  private readonly rateLimitDefaultCooldownMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffJitterMs: number;
  private readonly registry: ProviderCooldownRegistry;
  private readonly log: (message: string) => void;
  readonly telemetry: ScholarlyHttpTelemetry = {
    requests: 0,
    retries: 0,
    rateLimited: 0,
    cooldownSkips: 0,
    totalWaitMs: 0,
    byProvider: new Map(),
  };

  constructor(options: ScholarlyHttpClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleepImpl = options.sleep ?? defaultSleep;
    this.timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.maxRetries = options.maxRetries ?? DEFAULT_MAX_RETRIES;
    this.retryAfterRequestWaitCapMs = options.retryAfterRequestWaitCapMs ?? DEFAULT_RETRY_AFTER_REQUEST_WAIT_CAP_MS;
    this.cooldownCapMs = options.cooldownCapMs ?? DEFAULT_COOLDOWN_CAP_MS;
    this.rateLimitDefaultCooldownMs = options.rateLimitDefaultCooldownMs ?? DEFAULT_RATE_LIMIT_DEFAULT_COOLDOWN_MS;
    this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.backoffJitterMs = options.backoffJitterMs ?? DEFAULT_BACKOFF_JITTER_MS;
    this.registry = options.cooldownRegistry ?? new ProviderCooldownRegistry(this.now);
    this.log = options.log ?? (() => {});
  }

  /** 共享冷却注册表（CitationIntegrityService 恢复pass读「下一次可重试时间」） */
  get cooldowns(): ProviderCooldownRegistry {
    return this.registry;
  }

  private providerStat(provider: string): { requests: number; rateLimited: number; errors: number } {
    let stat = this.telemetry.byProvider.get(provider);
    if (stat === undefined) {
      stat = { requests: 0, rateLimited: 0, errors: 0 };
      this.telemetry.byProvider.set(provider, stat);
    }
    return stat;
  }

  /** 文本响应（JSON 由调用方解析——bib/xml/json 混合栈不做统一解析假设） */
  async fetchText(provider: string, url: string, init: ScholarlyFetchInit = {}): Promise<string> {
    let attempt = 0;
    let waitedMs = 0;
    for (;;) {
      attempt += 1;
      // 冷却闸门：provider 冷却期内不发网络请求（可恢复的临时失败）。
      // 只在首次尝试时拦截——同请求内的重试已经按 Retry-After / 退避等待过，
      // 不被自己刚记录的冷却短路
      const cooling = attempt === 1 ? this.registry.remaining(provider) : 0;
      if (cooling > 0) {
        this.telemetry.cooldownSkips += 1;
        throw new ScholarlyHttpError(
          "rate_limited",
          provider,
          `[${provider}] 限流冷却中，${Math.ceil(cooling / 1000)}s 后自动恢复`,
          { retryAfterMs: cooling, attempts: attempt, waitedMs },
        );
      }
      this.telemetry.requests += 1;
      this.providerStat(provider).requests += 1;
      let error: ScholarlyHttpError;
      try {
        return await this.fetchOnce(provider, url, init);
      } catch (caught) {
        error = caught instanceof ScholarlyHttpError ? caught : this.toError(provider, caught);
      }
      if (error.kind === "rate_limited") {
        this.telemetry.rateLimited += 1;
        this.providerStat(provider).rateLimited += 1;
        const cooldown = this.clampCooldown(error.retryAfterMs);
        this.registry.record(provider, cooldown);
        this.log(
          `[scholarly-http] ${provider} 429 限流（第 ${attempt} 次尝试；Retry-After=${error.retryAfterMs !== undefined ? `${Math.round(error.retryAfterMs / 1000)}s` : "无"} → 冷却 ${Math.round(cooldown / 1000)}s）`,
        );
      } else if (
        error.kind === "timeout" ||
        error.kind === "network_error" ||
        error.kind === "server_error"
      ) {
        this.providerStat(provider).errors += 1;
      }
      // 可重试集：429 / 超时 / 网络 / 5xx；aborted、404 等其它 4xx 立即上抛
      const retryable =
        error.kind === "rate_limited" ||
        error.kind === "timeout" ||
        error.kind === "network_error" ||
        error.kind === "server_error";
      if (!retryable || attempt > this.maxRetries) {
        if (error.kind !== "aborted" && error.kind !== "http_error") {
          // 5xx 重试耗尽也进短暂冷却（服务端过载时别让下一个请求立刻打过去）
          if (error.kind === "server_error") {
            this.registry.record(provider, this.rateLimitDefaultCooldownMs);
          }
        }
        throw new ScholarlyHttpError(error.kind, provider, error.message, {
          status: error.status,
          retryAfterMs: error.retryAfterMs ?? (error.kind === "rate_limited" ? this.registry.remaining(provider) : undefined),
          attempts: attempt,
          waitedMs,
        });
      }
      // 等待：429 → Retry-After 优先（超单请求帽立即失败，provider 已进冷却，
      // 由冷却闸门与后续恢复 pass 接管）；其余 → 指数退避 + 抖动
      let waitMs: number;
      if (error.kind === "rate_limited" && error.retryAfterMs !== undefined && error.retryAfterMs > 0) {
        if (error.retryAfterMs > this.retryAfterRequestWaitCapMs) {
          this.log(
            `[scholarly-http] ${provider} Retry-After ${Math.round(error.retryAfterMs / 1000)}s 超过单请求等待帽 ${Math.round(this.retryAfterRequestWaitCapMs / 1000)}s：本请求让位（provider 冷却 ${Math.round(cooldownOf(this.registry, provider) / 1000)}s，后续自动恢复）`,
          );
          throw new ScholarlyHttpError("rate_limited", provider, error.message, {
            status: 429,
            retryAfterMs: this.registry.remaining(provider),
            attempts: attempt,
            waitedMs,
          });
        }
        waitMs = error.retryAfterMs;
      } else {
        waitMs = this.backoffBaseMs * 2 ** (attempt - 1) + Math.random() * this.backoffJitterMs;
      }
      this.telemetry.retries += 1;
      this.telemetry.totalWaitMs += waitMs;
      waitedMs += waitMs;
      this.log(`[scholarly-http] ${provider} 第 ${attempt} 次失败（${error.kind}），${Math.round(waitMs)}ms 后重试`);
      try {
        await this.sleepImpl(waitMs, init.signal);
      } catch (sleepError) {
        throw sleepError instanceof ScholarlyHttpError
          ? sleepError
          : new ScholarlyHttpError("aborted", provider, "等待重试时被取消", { attempts: attempt, waitedMs });
      }
    }
  }

  async fetchJson<T>(provider: string, url: string, init: ScholarlyFetchInit = {}): Promise<T> {
    const text = await this.fetchText(provider, url, init);
    try {
      return JSON.parse(text) as T;
    } catch {
      throw new ScholarlyHttpError("network_error", provider, `[${provider}] 响应不是合法 JSON`);
    }
  }

  private clampCooldown(retryAfterMs: number | undefined): number {
    if (retryAfterMs === undefined || retryAfterMs <= 0) {
      return Math.min(this.rateLimitDefaultCooldownMs, this.cooldownCapMs);
    }
    return Math.min(retryAfterMs, this.cooldownCapMs);
  }

  private toError(provider: string, error: unknown): ScholarlyHttpError {
    if (error instanceof ScholarlyHttpError) {
      return error;
    }
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof Error && error.name === "AbortError") {
      return new ScholarlyHttpError("aborted", provider, `[${provider}] 请求已取消`);
    }
    if (/timeout|timed? out/i.test(message)) {
      return new ScholarlyHttpError("timeout", provider, `[${provider}] 请求超时`);
    }
    return new ScholarlyHttpError("network_error", provider, `[${provider}] 网络错误：${message}`);
  }

  private async fetchOnce(provider: string, url: string, init: ScholarlyFetchInit): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("scholarly timeout")), this.timeoutMs);
    const onOuterAbort = () => controller.abort(new Error("caller aborted"));
    init.signal?.addEventListener("abort", onOuterAbort, { once: true });
    const finish = () => {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", onOuterAbort);
    };
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        signal: controller.signal,
        method: "GET",
        headers: init.headers,
      });
    } catch (error) {
      finish();
      if (init.signal?.aborted) {
        throw new ScholarlyHttpError("aborted", provider, `[${provider}] 请求已被调用方取消`);
      }
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("scholarly timeout")) {
        throw new ScholarlyHttpError("timeout", provider, `[${provider}] 请求超时（${this.timeoutMs}ms）`);
      }
      throw new ScholarlyHttpError("network_error", provider, `[${provider}] 网络错误：${message}`);
    }
    finish();
    if (response.status === 429) {
      // headers 可选访问：测试注入的极简 Response 形态可能没有 headers
      const retryAfterRaw = typeof response.headers?.get === "function" ? response.headers.get("retry-after") : null;
      const retryAfterMs = parseRetryAfter(retryAfterRaw, this.now);
      throw new ScholarlyHttpError("rate_limited", provider, `[${provider}] 429 限流`, {
        status: 429,
        retryAfterMs,
      });
    }
    if (response.status >= 500) {
      throw new ScholarlyHttpError("server_error", provider, `[${provider}] HTTP ${response.status}`, {
        status: response.status,
      });
    }
    if (!response.ok) {
      // 404 / 403 / 400 等：非重试（404 是权威否定，语义由调用方解释）
      throw new ScholarlyHttpError("http_error", provider, `[${provider}] HTTP ${response.status}`, {
        status: response.status,
      });
    }
    // text 优先（真实 Response）；测试注入的极简形态只有 json 时兜底
    if (typeof (response as { text?: unknown }).text === "function") {
      return await response.text();
    }
    return JSON.stringify(await (response as { json(): Promise<unknown> }).json());
  }
}

function cooldownOf(registry: ProviderCooldownRegistry, provider: string): number {
  return registry.remaining(provider);
}
