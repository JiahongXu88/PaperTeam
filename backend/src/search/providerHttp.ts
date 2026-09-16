/**
 * ProviderHttpClient：所有 search provider 共用的 HTTP 执行器（D-0033 §2-6 / M6.1 ADR §6）。
 *
 * 统一承担（provider 特有的只有速率档位、base URL、鉴权、字段映射）：
 * - 超时（per-provider timeoutMs + AbortSignal 组合）；
 * - 类型化错误（timeout / aborted / http_error / rate_limited / network / circuit_open / business）；
 * - 重试：只对临时失败（429 / 500 / 502 / 503 / 504 / 网络错误 / 超时）重试，
 *   400 / 401 / 403 / 404 与其它 4xx 立即失败（除非协议明确说明）；
 * - Retry-After 双格式（delay-seconds / HTTP-date）优先于指数退避；
 * - 两级硬帽：单次请求内等待 ≤ RETRY_AFTER_REQUEST_WAIT_CAP_MS（不为一个 Retry-After
 *   阻塞请求几十秒）；provider 冷却 ≤ RETRY_AFTER_COOLDOWN_CAP_MS（不让几小时的
 *   Retry-After 把 provider 长期打死——超帽按帽值冷却）；
 * - 指数退避 + 有界抖动；退避 sleep 不持锁（每个请求独立执行，无全局串行原语——
 *   s2-mcp「退避持锁 → head-of-line blocking」教训，分析报告 §7.1/§7.2）；
 * - Provider Health 四态（healthy / degraded / rate_limited / unavailable）+
 *   连续失败熔断（open → cooldown → half-open 探测 → close）；
 *   「限流 ≠ 宕机」：429 走冷却恢复（定时唤醒，无需探测），连续网络/5xx 失败走熔断。
 *
 * 状态由本模块统一维护（不是每个 provider 各写一份）；观测输入是真实请求结果
 * （含 AMiner HTTP-200 信封业务错误，经 envelope 钩子穿透上报）。
 */

export type ProviderHealth = "healthy" | "degraded" | "rate_limited" | "unavailable";

/** 熔断器三态（unavailable 的内部实现；rate_limited 不经过熔断器） */
export type CircuitState = "closed" | "open" | "half_open";

export interface ProviderHealthSnapshot {
  provider: string;
  state: ProviderHealth;
  circuit: CircuitState;
  /** rate_limited 冷却截止（epoch ms）；过期自动恢复，无需探测 */
  cooldownUntilMs?: number;
  lastError?: string;
  consecutiveFailures: number;
}

export type ProviderErrorKind =
  | "timeout"
  | "aborted"
  | "http_error"
  | "rate_limited"
  | "network_error"
  | "circuit_open"
  | "business_error";

/** 类型化 provider 错误（上层按 kind 决定降级语义，不解析 message） */
export class ProviderHttpError extends Error {
  override readonly name = "ProviderHttpError";
  readonly kind: ProviderErrorKind;
  readonly provider: string;
  /** HTTP 状态码（http_error / rate_limited）或业务信封错误码（business_error） */
  readonly status?: number;
  /** 已解析的 Retry-After（毫秒；rate_limited）或建议冷却 */
  readonly retryAfterMs?: number;

  constructor(
    kind: ProviderErrorKind,
    provider: string,
    message: string,
    extra: { status?: number; retryAfterMs?: number } = {},
  ) {
    super(message);
    this.kind = kind;
    this.provider = provider;
    this.status = extra.status;
    this.retryAfterMs = extra.retryAfterMs;
  }
}

/** provider 执行画像（速率档位 / 超时 / 重试次数；base URL 与鉴权归 provider 自己） */
export interface ProviderProfile {
  name: string;
  /** 单次 HTTP 请求超时（默认 client 级 defaultTimeoutMs） */
  timeoutMs?: number;
  /** 失败重试次数上限（默认 2，即最多 3 次尝试） */
  maxRetries?: number;
}

/** 单个 provider 的健康状态机（ProviderHttpClient 内部持有，按 profile name 索引） */
class ProviderHealthTracker {
  private state: ProviderHealth = "healthy";
  private circuit: CircuitState = "closed";
  private consecutiveFailures = 0;
  private cooldownUntilMs = 0;
  private circuitOpenUntilMs = 0;
  private lastError?: string;

  constructor(
    private readonly now: () => number,
    private readonly failureThreshold: number,
    private readonly circuitCooldownMs: number,
  ) {}

  /**
   * 熔断/冷却闸门：open 未到期 → 拒绝（circuit_open）；rate_limited 未到期 →
   * 拒绝（rate_limited）；open 到期 → half_open 放行探测；rate_limited 到期 →
   * 直接放行（冷却结束自动恢复，无需探测）。
   */
  admit(): ProviderHttpError | null {
    if (this.circuit === "open") {
      if (this.now() >= this.circuitOpenUntilMs) {
        this.circuit = "half_open";
      } else {
        return new ProviderHttpError(
          "circuit_open",
          "",
          `provider 熔断开路中（连续失败 ≥ ${this.failureThreshold}），${Math.ceil((this.circuitOpenUntilMs - this.now()) / 1000)}s 后半开探测`,
        );
      }
    }
    if (this.state === "rate_limited" && this.now() < this.cooldownUntilMs) {
      return new ProviderHttpError(
        "rate_limited",
        "",
        `provider 限流冷却中，${Math.ceil((this.cooldownUntilMs - this.now()) / 1000)}s 后自动恢复`,
        { retryAfterMs: this.cooldownUntilMs - this.now() },
      );
    }
    return null;
  }

  recordSuccess(): void {
    this.consecutiveFailures = 0;
    this.circuit = "closed";
    this.state = "healthy";
    this.lastError = undefined;
  }

  /** 偶发临时失败（未到熔断阈值）：degraded；达到阈值：熔断开路 unavailable */
  recordTransientFailure(message: string): void {
    this.consecutiveFailures += 1;
    this.lastError = message;
    if (this.consecutiveFailures >= this.failureThreshold) {
      this.circuit = "open";
      this.circuitOpenUntilMs = this.now() + this.circuitCooldownMs;
      this.state = "unavailable";
    } else {
      this.state = "degraded";
    }
  }

  /** 429 / AMiner 40306：限流不是宕机——不累计熔断失败，走独立冷却 */
  recordRateLimit(cooldownMs: number, message: string): void {
    this.cooldownUntilMs = Math.max(this.cooldownUntilMs, this.now() + cooldownMs);
    this.state = "rate_limited";
    this.lastError = message;
  }

  /** 非重试业务错误（如 AMiner 40301 permission_denied / invalid key）：如实记录，不熔断 */
  recordBusinessError(message: string): void {
    // 过期的限流冷却先回落（HTTP 200 的业务错误绝不因残留状态被判 healthy）
    if (this.state === "rate_limited" && this.now() >= this.cooldownUntilMs) {
      this.state = this.consecutiveFailures > 0 ? "degraded" : "healthy";
    }
    this.lastError = message;
    if (this.state === "healthy") {
      this.state = "degraded";
    }
  }

  /** 外部观测信号（如 SearXNG unresponsive_engines 非空）：degraded 标记，继续用 */
  markDegraded(reason: string): void {
    this.lastError = reason;
    if (this.state === "healthy") {
      this.state = "degraded";
    }
  }

  snapshot(provider: string): ProviderHealthSnapshot {
    // 有效状态即时推导：冷却/熔断到期后不再报旧状态
    const now = this.now();
    if (this.circuit === "open" && now < this.circuitOpenUntilMs) {
      return {
        provider,
        state: "unavailable",
        circuit: "open",
        lastError: this.lastError,
        consecutiveFailures: this.consecutiveFailures,
      };
    }
    if (this.circuit === "open" && now >= this.circuitOpenUntilMs) {
      this.circuit = "half_open";
    }
    // 限流冷却到期：回落（无需探测——下一个真实请求照常派发），并回写状态
    if (this.state === "rate_limited" && now >= this.cooldownUntilMs) {
      this.state = this.consecutiveFailures > 0 ? "degraded" : "healthy";
    }
    return {
      provider,
      state: this.circuit === "half_open" ? "degraded" : this.state,
      circuit: this.circuit,
      ...(this.state === "rate_limited" && now < this.cooldownUntilMs
        ? { cooldownUntilMs: this.cooldownUntilMs }
        : {}),
      ...(this.lastError !== undefined ? { lastError: this.lastError } : {}),
      consecutiveFailures: this.consecutiveFailures,
    };
  }
}

/**
 * HTTP-200 信封业务错误钩子（AMiner 形态：HTTP 200 但 body.code != success）。
 * 返回 ok:true 放行；ok:false 由 client 上报健康状态并按 kind 终止/重试。
 */
export type EnvelopeInspector = (
  body: unknown,
) =>
  | { ok: true }
  | { ok: false; kind: "rate_limited" | "business_error"; code?: number; message: string; retryAfterMs?: number };

export interface ProviderFetchInit {
  signal?: AbortSignal;
  headers?: Record<string, string>;
  method?: string;
  body?: string;
  /** JSON 信封业务错误检查（HTTP 200 也要穿透；AMiner HTTP 状态不可作为成功判据） */
  envelope?: EnvelopeInspector;
}

export interface ProviderHttpClientOptions {
  fetchImpl?: typeof fetch;
  now?: () => number;
  sleep?: (ms: number) => Promise<void>;
  /** 单请求默认超时（per-provider timeoutMs 覆盖） */
  defaultTimeoutMs?: number;
  /** 默认失败重试次数（per-provider maxRetries 覆盖） */
  defaultMaxRetries?: number;
  /** 熔断阈值：连续临时失败次数（≥ 即开路） */
  circuitFailureThreshold?: number;
  /** 熔断开路时长（半开探测前冷却） */
  circuitCooldownMs?: number;
  /** Retry-After 单次请求内等待硬帽 */
  retryAfterRequestWaitCapMs?: number;
  /** Retry-After 冷却硬帽（provider 级） */
  retryAfterCooldownCapMs?: number;
  /** 退避基数与抖动上限（有界抖动：uniform(0, jitterMs) 加性） */
  backoffBaseMs?: number;
  backoffJitterMs?: number;
  log?: (message: string) => void;
}

/** 可重试 HTTP 集见 fetchWithRetry（429 + 5xx）；400/401/403/404 与其它 4xx 立即失败 */
const DEFAULT_TIMEOUT_MS = 10_000;
const DEFAULT_MAX_RETRIES = 2;
const DEFAULT_CIRCUIT_FAILURE_THRESHOLD = 3;
const DEFAULT_CIRCUIT_COOLDOWN_MS = 30_000;
const DEFAULT_RETRY_AFTER_REQUEST_WAIT_CAP_MS = 5_000;
const DEFAULT_RETRY_AFTER_COOLDOWN_CAP_MS = 60_000;
const DEFAULT_BACKOFF_BASE_MS = 500;
const DEFAULT_BACKOFF_JITTER_MS = 250;

/**
 * Retry-After 解析（RFC 9110 双格式，参考 s2-mcp 教科书实现，分析报告 §7.1）：
 * - "10" → 10_000ms；
 * - "Wed, 16 Sep 2026 10:00:00 GMT" → 相对 now 的毫秒（过去时 → 0）；
 * - 畸形 / nan / inf → undefined（回退指数退避）。
 */
export function parseRetryAfter(
  value: string | null | undefined,
  now: () => number = Date.now,
): number | undefined {
  if (value === null || value === undefined) {
    return undefined;
  }
  const trimmed = value.trim();
  if (trimmed === "") {
    return undefined;
  }
  if (/^\d+$/.test(trimmed)) {
    const seconds = Number(trimmed);
    if (!Number.isFinite(seconds)) {
      return undefined;
    }
    return Math.max(0, seconds * 1000);
  }
  const asDate = Date.parse(trimmed);
  if (Number.isFinite(asDate)) {
    return Math.max(0, asDate - now());
  }
  return undefined;
}

export class ProviderHttpClient {
  private readonly fetchImpl: typeof fetch;
  private readonly now: () => number;
  private readonly sleepImpl: (ms: number) => Promise<void>;
  private readonly defaultTimeoutMs: number;
  private readonly defaultMaxRetries: number;
  private readonly circuitFailureThreshold: number;
  private readonly circuitCooldownMs: number;
  private readonly retryAfterRequestWaitCapMs: number;
  private readonly retryAfterCooldownCapMs: number;
  private readonly backoffBaseMs: number;
  private readonly backoffJitterMs: number;
  private readonly log: (message: string) => void;
  private readonly trackers = new Map<string, ProviderHealthTracker>();

  constructor(options: ProviderHttpClientOptions = {}) {
    this.fetchImpl = options.fetchImpl ?? fetch;
    this.now = options.now ?? Date.now;
    this.sleepImpl = options.sleep ?? ((ms) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
    this.defaultTimeoutMs = options.defaultTimeoutMs ?? DEFAULT_TIMEOUT_MS;
    this.defaultMaxRetries = options.defaultMaxRetries ?? DEFAULT_MAX_RETRIES;
    this.circuitFailureThreshold = options.circuitFailureThreshold ?? DEFAULT_CIRCUIT_FAILURE_THRESHOLD;
    this.circuitCooldownMs = options.circuitCooldownMs ?? DEFAULT_CIRCUIT_COOLDOWN_MS;
    this.retryAfterRequestWaitCapMs =
      options.retryAfterRequestWaitCapMs ?? DEFAULT_RETRY_AFTER_REQUEST_WAIT_CAP_MS;
    this.retryAfterCooldownCapMs =
      options.retryAfterCooldownCapMs ?? DEFAULT_RETRY_AFTER_COOLDOWN_CAP_MS;
    this.backoffBaseMs = options.backoffBaseMs ?? DEFAULT_BACKOFF_BASE_MS;
    this.backoffJitterMs = options.backoffJitterMs ?? DEFAULT_BACKOFF_JITTER_MS;
    this.log = options.log ?? (() => {});
  }

  /** 健康快照（provider 尚无任何调用记录时返回 healthy / closed 初态） */
  health(provider: string): ProviderHealthSnapshot {
    return this.tracker(provider).snapshot(provider);
  }

  healthAll(): ProviderHealthSnapshot[] {
    return [...this.trackers.keys()].map((name) => this.health(name));
  }

  /** 外部观测信号标记 degraded（SearXNG unresponsive_engines 等） */
  markDegraded(provider: string, reason: string): void {
    this.tracker(provider).markDegraded(reason);
  }

  async fetchJson<T>(provider: ProviderProfile, url: string, init: ProviderFetchInit = {}): Promise<T> {
    const text = await this.fetchWithRetry(provider, url, init, true);
    return JSON.parse(text) as T;
  }

  /** arXiv Atom XML 等文本响应 */
  async fetchText(provider: ProviderProfile, url: string, init: ProviderFetchInit = {}): Promise<string> {
    return this.fetchWithRetry(provider, url, init, false);
  }

  // ---- 内部 ----

  private tracker(provider: string): ProviderHealthTracker {
    let tracker = this.trackers.get(provider);
    if (tracker === undefined) {
      tracker = new ProviderHealthTracker(this.now, this.circuitFailureThreshold, this.circuitCooldownMs);
      this.trackers.set(provider, tracker);
    }
    return tracker;
  }

  private async fetchWithRetry(
    profile: ProviderProfile,
    url: string,
    init: ProviderFetchInit,
    json: boolean,
  ): Promise<string> {
    const tracker = this.tracker(profile.name);
    const timeoutMs = profile.timeoutMs ?? this.defaultTimeoutMs;
    const maxRetries = profile.maxRetries ?? this.defaultMaxRetries;

    let lastError: ProviderHttpError;
    for (let attempt = 0; ; attempt += 1) {
      const gate = tracker.admit();
      if (gate !== null) {
        throw new ProviderHttpError(gate.kind, profile.name, `[${profile.name}] ${gate.message}`, {
          retryAfterMs: gate.retryAfterMs,
        });
      }
      try {
        const body = await this.fetchOnce(profile.name, url, init, timeoutMs, json);
        tracker.recordSuccess();
        return body;
      } catch (error) {
        lastError = error instanceof ProviderHttpError ? error : this.toProviderError(profile.name, error);
        if (init.signal?.aborted) {
          lastError = new ProviderHttpError("aborted", profile.name, `[${profile.name}] 请求已被调用方取消`);
          throw lastError;
        }
        // 健康上报与重试判定
        if (lastError.kind === "rate_limited") {
          const cooldown = this.clampCooldown(lastError.retryAfterMs);
          tracker.recordRateLimit(cooldown, lastError.message);
        } else if (
          lastError.kind === "timeout" ||
          lastError.kind === "network_error" ||
          (lastError.kind === "http_error" && lastError.status !== undefined && lastError.status >= 500)
        ) {
          tracker.recordTransientFailure(lastError.message);
        } else if (lastError.kind === "business_error") {
          tracker.recordBusinessError(lastError.message);
        }
        // 可重试集：429 / 超时 / 网络错误 / 5xx（500-599 统一纳入——s2-mcp 只重试
        // 502/503 不对称的教训）；aborted、4xx http_error、业务信封错误不重试
        const retryableKind =
          lastError.kind === "rate_limited" ||
          lastError.kind === "timeout" ||
          lastError.kind === "network_error" ||
          (lastError.kind === "http_error" && lastError.status !== undefined && lastError.status >= 500);
        if (!retryableKind || attempt >= maxRetries) {
          throw lastError;
        }
        await this.waitBeforeRetry(profile.name, attempt, lastError);
      }
    }
  }

  /** 429 → Retry-After 优先（有请求内硬帽，超帽不睡眠直接失败进冷却）；否则指数退避+抖动 */
  private async waitBeforeRetry(providerName: string, attempt: number, error: ProviderHttpError): Promise<void> {
    let waitMs: number;
    if (error.kind === "rate_limited" && error.retryAfterMs !== undefined && error.retryAfterMs > 0) {
      if (error.retryAfterMs > this.retryAfterRequestWaitCapMs) {
        // 服务端要求的等待超过单请求硬帽：本请求立即失败（provider 已进冷却），
        // 后续请求在冷却期内直接短路——不为一个 Retry-After 阻塞请求几十秒
        throw error;
      }
      waitMs = error.retryAfterMs;
    } else {
      waitMs = this.backoffBaseMs * 2 ** attempt + Math.random() * this.backoffJitterMs;
    }
    this.log(`[search] ${providerName} 第 ${attempt + 1} 次失败（${error.kind}），${Math.round(waitMs)}ms 后重试`);
    await this.sleepImpl(waitMs);
  }

  private clampCooldown(retryAfterMs: number | undefined): number {
    if (retryAfterMs === undefined || retryAfterMs <= 0) {
      return this.retryAfterCooldownCapMs; // 无 Retry-After 的 429：按帽值冷却
    }
    return Math.min(retryAfterMs, this.retryAfterCooldownCapMs);
  }

  private toProviderError(providerName: string, error: unknown): ProviderHttpError {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof Error && error.name === "AbortError") {
      return new ProviderHttpError("aborted", providerName, `[${providerName}] 请求已取消`);
    }
    if (error instanceof Error && error.name === "TimeoutError") {
      return new ProviderHttpError("timeout", providerName, `[${providerName}] 请求超时`);
    }
    return new ProviderHttpError("network_error", providerName, `[${providerName}] 网络错误：${message}`);
  }

  private async fetchOnce(
    providerName: string,
    url: string,
    init: ProviderFetchInit,
    timeoutMs: number,
    json: boolean,
  ): Promise<string> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(new Error("provider timeout")), timeoutMs);
    const onOuterAbort = () => controller.abort(new Error("caller aborted"));
    init.signal?.addEventListener("abort", onOuterAbort, { once: true });
    let response: Response;
    try {
      response = await this.fetchImpl(url, {
        signal: controller.signal,
        method: init.method ?? "GET",
        headers: init.headers,
        ...(init.body !== undefined ? { body: init.body } : {}),
      });
    } catch (error) {
      // 区分：整体超时 / 调用方取消 / 网络错误
      if (init.signal?.aborted) {
        throw new ProviderHttpError("aborted", providerName, `[${providerName}] 请求已被调用方取消`);
      }
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes("provider timeout") || error instanceof Error && error.name === "TimeoutError") {
        throw new ProviderHttpError("timeout", providerName, `[${providerName}] 请求超时（${timeoutMs}ms）`);
      }
      throw new ProviderHttpError("network_error", providerName, `[${providerName}] 网络错误：${message}`);
    } finally {
      clearTimeout(timer);
      init.signal?.removeEventListener("abort", onOuterAbort);
    }
    if (response.status === 429) {
      const retryAfterMs = parseRetryAfter(response.headers.get("retry-after"), this.now);
      throw new ProviderHttpError("rate_limited", providerName, `[${providerName}] 429 限流`, {
        status: 429,
        retryAfterMs,
      });
    }
    if (!response.ok) {
      throw new ProviderHttpError(
        "http_error",
        providerName,
        `[${providerName}] HTTP ${response.status}`,
        { status: response.status },
      );
    }
    const text = await response.text();
    if (init.envelope !== undefined) {
      let parsed: unknown;
      try {
        parsed = JSON.parse(text);
      } catch {
        parsed = undefined;
      }
      const verdict = init.envelope(parsed);
      if (!verdict.ok) {
        throw new ProviderHttpError(verdict.kind, providerName, `[${providerName}] 业务错误 ${verdict.code ?? ""}：${verdict.message}`, {
          status: verdict.code,
          retryAfterMs: verdict.retryAfterMs,
        });
      }
    }
    if (json) {
      // 提前校验 JSON 合法性（malformed payload → 明确错误而非下游崩溃）
      try {
        JSON.parse(text);
      } catch {
        throw new ProviderHttpError("network_error", providerName, `[${providerName}] 响应不是合法 JSON`);
      }
    }
    return text;
  }
}
