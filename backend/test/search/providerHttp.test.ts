/**
 * ProviderHttpClient 单元测试（M6.3；指令 §40 全 14 项）。
 *
 * 全部离线：fetchImpl / now / sleep 注入假实现；不访问公网。
 */

import { describe, expect, it, vi } from "vitest";

import { parseRetryAfter, ProviderHttpError, ProviderHttpClient } from "../../src/search/providerHttp.js";

/** 可编程假 fetch：按 URL/次序回放响应 */
function fakeFetch(responses: Array<(url: string, init?: RequestInit) => Promise<Response>>) {
  let call = 0;
  const urls: string[] = [];
  const impl = async (url: string | URL | Request, init?: RequestInit): Promise<Response> => {
    urls.push(String(url));
    const index = Math.min(call, responses.length - 1);
    call += 1;
    return responses[index]!(String(url), init);
  };
  return { impl, urls, get callCount() { return call; } };
}

function jsonResponse(body: unknown, init: { status?: number; headers?: Record<string, string> } = {}): Response {
  return new Response(JSON.stringify(body), {
    status: init.status ?? 200,
    headers: { "Content-Type": "application/json", ...(init.headers ?? {}) },
  });
}

/** 受控时钟 + 记录型 sleep（sleep 推进时钟——与真实 setTimeout 时间语义一致） */
function fakeClock(startMs = 1_000_000) {
  let now = startMs;
  const sleeps: number[] = [];
  return {
    now: () => now,
    advance: (ms: number) => {
      now += ms;
    },
    sleep: async (ms: number) => {
      sleeps.push(ms);
      now += ms;
    },
    sleeps,
  };
}

function makeClient(fetchImpl: typeof fetch, clock: ReturnType<typeof fakeClock>) {
  return new ProviderHttpClient({
    fetchImpl,
    now: clock.now,
    sleep: clock.sleep,
    // 测试用小参数（真实默认值见 providerHttp.ts 常量）
    defaultTimeoutMs: 200,
    defaultMaxRetries: 2,
    circuitFailureThreshold: 3,
    circuitCooldownMs: 30_000,
    retryAfterRequestWaitCapMs: 5_000,
    retryAfterCooldownCapMs: 60_000,
    backoffBaseMs: 100,
    backoffJitterMs: 50,
  });
}

describe("parseRetryAfter（RFC 9110 双格式）", () => {
  it("delay-seconds 形式", () => {
    expect(parseRetryAfter("10")).toBe(10_000);
    expect(parseRetryAfter("0")).toBe(0);
  });
  it("HTTP-date 形式（未来时刻 → 正差值）", () => {
    const target = new Date(Date.now() + 30_000).toUTCString();
    const ms = parseRetryAfter(target)!;
    expect(ms).toBeGreaterThan(29_000);
    expect(ms).toBeLessThanOrEqual(30_000);
  });
  it("HTTP-date 过去时 → 0；畸形 → undefined", () => {
    expect(parseRetryAfter(new Date(Date.now() - 60_000).toUTCString())).toBe(0);
    expect(parseRetryAfter("not-a-date")).toBeUndefined();
    expect(parseRetryAfter("nan")).toBeUndefined();
    expect(parseRetryAfter(null)).toBeUndefined();
  });
});

describe("ProviderHttpClient", () => {
  it("1. 正常 200：返回 JSON 且状态 healthy", async () => {
    const fetch = fakeFetch([() => Promise.resolve(jsonResponse({ ok: 1 }))]);
    const clock = fakeClock();
    const client = makeClient(fetch.impl, clock);
    const body = await client.fetchJson<{ ok: number }>({ name: "p" }, "https://api.example/x");
    expect(body).toEqual({ ok: 1 });
    expect(client.health("p").state).toBe("healthy");
    expect(client.health("p").circuit).toBe("closed");
  });

  it("2. 超时：每次尝试都挂起 → timeout 错误（不无限等）", async () => {
    const fetch = fakeFetch([
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("aborted: provider timeout")));
        }),
    ]);
    const clock = fakeClock();
    const client = makeClient(fetch.impl, clock);
    await expect(client.fetchJson({ name: "p" }, "https://api.example/x")).rejects.toMatchObject({
      kind: "timeout",
    });
    // 1 + 2 次重试 = 3 次尝试
    expect(fetch.callCount).toBe(3);
    expect(client.health("p").state).toBe("unavailable"); // 连续 3 次超时 → 熔断
  });

  it("3. AbortSignal：调用方取消 → aborted，不再重试", async () => {
    const fetch = fakeFetch([
      (_url, init) =>
        new Promise<Response>((_resolve, reject) => {
          init?.signal?.addEventListener("abort", () => reject(new Error("This operation was aborted")));
        }),
    ]);
    const clock = fakeClock();
    const client = makeClient(fetch.impl, clock);
    const controller = new AbortController();
    const pending = client.fetchJson({ name: "p" }, "https://api.example/x", { signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toMatchObject({ kind: "aborted" });
    expect(fetch.callCount).toBe(1);
  });

  it("4. 429 + Retry-After 秒数：等待后重试成功，健康态先 rate_limited", async () => {
    const fetch = fakeFetch([
      () => Promise.resolve(jsonResponse({}, { status: 429, headers: { "Retry-After": "1" } })),
      () => Promise.resolve(jsonResponse({ ok: 1 })),
    ]);
    const clock = fakeClock();
    const client = makeClient(fetch.impl, clock);
    const body = await client.fetchJson<{ ok: number }>({ name: "p" }, "https://api.example/x");
    expect(body).toEqual({ ok: 1 });
    expect(clock.sleeps).toEqual([1_000]); // Retry-After 优先于退避
    expect(client.health("p").state).toBe("healthy"); // 成功后恢复
  });

  it("5. 429 + Retry-After HTTP-date：按日期差等待", async () => {
    const target = new Date(fakeClock().now() + 2_000).toUTCString();
    const fetch = fakeFetch([
      () => Promise.resolve(jsonResponse({}, { status: 429, headers: { "Retry-After": target } })),
      () => Promise.resolve(jsonResponse({ ok: 1 })),
    ]);
    const clock = fakeClock();
    const client = makeClient(fetch.impl, clock);
    await client.fetchJson({ name: "p" }, "https://api.example/x");
    expect(clock.sleeps[0]).toBeGreaterThanOrEqual(1_990);
    expect(clock.sleeps[0]).toBeLessThanOrEqual(2_000);
  });

  it("6. Retry-After 硬帽：3600s 的要求不在请求内等待；冷却封顶 60s", async () => {
    const fetch = fakeFetch([
      () => Promise.resolve(jsonResponse({}, { status: 429, headers: { "Retry-After": "3600" } })),
      () => Promise.resolve(jsonResponse({ ok: 1 })),
    ]);
    const clock = fakeClock();
    const client = makeClient(fetch.impl, clock);
    // 请求立即失败（不为 1 小时阻塞）；第二次调用命中冷却短路
    await expect(client.fetchJson({ name: "p" }, "https://api.example/x")).rejects.toMatchObject({
      kind: "rate_limited",
    });
    expect(clock.sleeps).toEqual([]); // 没有任何请求内 sleep
    expect(fetch.callCount).toBe(1);
    const health = client.health("p");
    expect(health.state).toBe("rate_limited");
    expect(health.cooldownUntilMs! - clock.now()).toBeLessThanOrEqual(60_000);
    await expect(client.fetchJson({ name: "p" }, "https://api.example/x")).rejects.toMatchObject({
      kind: "rate_limited",
    });
    expect(fetch.callCount).toBe(1); // 冷却期内不发新请求
    // 冷却结束：自动恢复（无需探测）
    clock.advance(60_001);
    expect(client.health("p").state).not.toBe("rate_limited");
  });

  it("7. 502/503：指数退避后重试成功", async () => {
    const fetch = fakeFetch([
      () => Promise.resolve(jsonResponse({}, { status: 502 })),
      () => Promise.resolve(jsonResponse({}, { status: 503 })),
      () => Promise.resolve(jsonResponse({ ok: 1 })),
    ]);
    const clock = fakeClock();
    const client = makeClient(fetch.impl, clock);
    const body = await client.fetchJson<{ ok: number }>({ name: "p" }, "https://api.example/x");
    expect(body).toEqual({ ok: 1 });
    expect(clock.sleeps.length).toBe(2);
    expect(fetch.callCount).toBe(3);
  });

  it("8. 400：立即失败不重试", async () => {
    const fetch = fakeFetch([() => Promise.resolve(jsonResponse({ error: "bad" }, { status: 400 }))]);
    const clock = fakeClock();
    const client = makeClient(fetch.impl, clock);
    await expect(client.fetchJson({ name: "p" }, "https://api.example/x")).rejects.toMatchObject({
      kind: "http_error",
      status: 400,
    });
    expect(fetch.callCount).toBe(1);
    expect(clock.sleeps).toEqual([]);
  });

  it("9. 401 / 403：不盲目重试", async () => {
    for (const status of [401, 403]) {
      const fetch = fakeFetch([() => Promise.resolve(jsonResponse({}, { status }))]);
      const clock = fakeClock();
      const client = makeClient(fetch.impl, clock);
      await expect(client.fetchJson({ name: "p" }, "https://api.example/x")).rejects.toMatchObject({
        kind: "http_error",
        status,
      });
      expect(fetch.callCount).toBe(1);
    }
  });

  it("10. 退避有界：基数×2^n + 有界抖动，且次数受 maxRetries 约束", async () => {
    const fetch = fakeFetch([
      () => Promise.resolve(jsonResponse({}, { status: 503 })),
      () => Promise.resolve(jsonResponse({}, { status: 503 })),
      () => Promise.resolve(jsonResponse({}, { status: 503 })),
    ]);
    const clock = fakeClock();
    const client = makeClient(fetch.impl, clock);
    await expect(client.fetchJson({ name: "p" }, "https://api.example/x")).rejects.toMatchObject({
      kind: "http_error",
    });
    // 2 次重试等待：第一次 100×1+[0,50]，第二次 100×2+[0,50]
    expect(clock.sleeps.length).toBe(2);
    expect(clock.sleeps[0]).toBeGreaterThanOrEqual(100);
    expect(clock.sleeps[0]).toBeLessThanOrEqual(150);
    expect(clock.sleeps[1]).toBeGreaterThanOrEqual(200);
    expect(clock.sleeps[1]).toBeLessThanOrEqual(250);
    expect(fetch.callCount).toBe(3);
  });

  it("11. 熔断：连续失败达阈值 → open，后续请求不再外呼", async () => {
    const networkError = () => Promise.reject(new TypeError("fetch failed"));
    const fetch = fakeFetch([networkError]);
    const clock = fakeClock();
    const client = makeClient(fetch.impl, clock);
    // 用 maxRetries:0 的 profile 精确观察：每次尝试计一次临时失败
    const profile = { name: "p", maxRetries: 0 };
    await expect(client.fetchJson(profile, "https://api.example/x")).rejects.toMatchObject({
      kind: "network_error",
    });
    expect(client.health("p").state).toBe("degraded"); // 1 次失败：degraded 不熔断
    expect(client.health("p").consecutiveFailures).toBe(1);
    await expect(client.fetchJson(profile, "https://api.example/x")).rejects.toBeInstanceOf(ProviderHttpError);
    expect(client.health("p").circuit).toBe("closed"); // 2 次：仍闭合
    await expect(client.fetchJson(profile, "https://api.example/x")).rejects.toBeInstanceOf(ProviderHttpError);
    const health = client.health("p");
    expect(health.state).toBe("unavailable"); // 连续 3 次 → 熔断开路
    expect(health.circuit).toBe("open");
    // 熔断后：新请求直接被闸门拒绝，不再外呼
    const before = fetch.callCount;
    await expect(client.fetchJson(profile, "https://api.example/x")).rejects.toMatchObject({
      kind: "circuit_open",
    });
    expect(fetch.callCount).toBe(before);
  });

  it("12. 半开恢复：cooldown 到期 → half_open 探测成功 → closed", async () => {
    let mode: "fail" | "ok" = "fail";
    const fetch = fakeFetch([
      () =>
        mode === "fail"
          ? Promise.reject(new TypeError("fetch failed"))
          : Promise.resolve(jsonResponse({ ok: 1 })),
    ]);
    const clock = fakeClock();
    const client = makeClient(fetch.impl, clock);
    const profile = { name: "p", maxRetries: 0 };
    for (let i = 0; i < 3; i += 1) {
      await expect(client.fetchJson(profile, "https://api.example/x")).rejects.toBeInstanceOf(ProviderHttpError);
    }
    expect(client.health("p").circuit).toBe("open");
    clock.advance(30_001); // 超过熔断冷却
    expect(client.health("p").circuit).toBe("half_open"); // 快照即时推导
    expect(client.health("p").state).toBe("degraded"); // 半开探测期
    mode = "ok";
    const body = await client.fetchJson<{ ok: number }>(profile, "https://api.example/x");
    expect(body).toEqual({ ok: 1 });
    const health = client.health("p");
    expect(health.circuit).toBe("closed");
    expect(health.state).toBe("healthy");
  });

  it("13. 限流 ≠ 宕机：429 → rate_limited（不累计熔断失败、不 unavailable）", async () => {
    const fetch = fakeFetch([
      () => Promise.resolve(jsonResponse({}, { status: 429, headers: { "Retry-After": "1" } })),
    ]);
    const clock = fakeClock();
    const client = makeClient(fetch.impl, clock);
    // 两次 429（各 3 次尝试）——若 429 误计为宕机会触发熔断
    await expect(client.fetchJson({ name: "p" }, "https://api.example/x")).rejects.toMatchObject({
      kind: "rate_limited",
    });
    clock.advance(1_100); // 冷却结束
    await expect(client.fetchJson({ name: "p" }, "https://api.example/x")).rejects.toMatchObject({
      kind: "rate_limited",
    });
    const health = client.health("p");
    expect(health.state).not.toBe("unavailable");
    expect(health.circuit).toBe("closed");
    expect(health.consecutiveFailures).toBe(0); // 限流不计失败
    clock.advance(1_100);
    expect(client.health("p").state).toBe("healthy"); // 冷却到期自动恢复
  });

  it("14. 网络错误（DNS/连接失败）：归类 network_error 并可重试", async () => {
    let calls = 0;
    const impl = vi.fn(async (): Promise<Response> => {
      calls += 1;
      if (calls < 3) {
        throw new TypeError("getaddrinfo ENOTFOUND api.example");
      }
      return jsonResponse({ ok: 1 });
    });
    const clock = fakeClock();
    const client = makeClient(impl as unknown as typeof fetch, clock);
    const body = await client.fetchJson<{ ok: number }>({ name: "p" }, "https://api.example/x");
    expect(body).toEqual({ ok: 1 });
    expect(calls).toBe(3);
  });

  it("envelope 钩子：HTTP 200 信封业务错误穿透（AMiner 形态）", async () => {
    const fetch = fakeFetch([
      () => Promise.resolve(jsonResponse({ code: 40306, msg: "rate limited" })),
      () => Promise.resolve(jsonResponse({ code: 40301, msg: "permission denied" })),
    ]);
    const clock = fakeClock();
    const client = makeClient(fetch.impl, clock);
    // 40306 → rate_limited（进冷却，不再重试外呼）
    await expect(
      client.fetchJson({ name: "aminer" }, "https://api.example/x", {
        envelope: (body) => {
          const code = (body as { code?: number }).code;
          return code === 0 || code === 200 || code === undefined
            ? { ok: true }
            : code === 40306
              ? { ok: false, kind: "rate_limited", code, message: "limited" }
              : { ok: false, kind: "business_error", code, message: "denied" };
        },
      }),
    ).rejects.toMatchObject({ kind: "rate_limited" });
    expect(client.health("aminer").state).toBe("rate_limited");
    clock.advance(60_001);
    // 40301 → business_error：HTTP 200 也绝不标记 healthy
    await expect(
      client.fetchJson({ name: "aminer" }, "https://api.example/x", {
        envelope: (body) => {
          const code = (body as { code?: number }).code;
          return code === 40306
            ? { ok: false, kind: "rate_limited", code, message: "limited" }
            : { ok: false, kind: "business_error", code, message: "denied" };
        },
      }),
    ).rejects.toMatchObject({ kind: "business_error" });
    const health = client.health("aminer");
    expect(health.state).toBe("degraded"); // 业务错误≠healthy
    expect(health.circuit).toBe("closed"); // 也不熔断（配置问题）
  });

  it("非 JSON 响应体（json 请求）：明确错误而非下游崩溃", async () => {
    const fetch = fakeFetch([() => Promise.resolve(new Response("<html>gateway</html>", { status: 200 }))]);
    const clock = fakeClock();
    const client = makeClient(fetch.impl, clock);
    await expect(client.fetchJson({ name: "p" }, "https://api.example/x")).rejects.toMatchObject({
      kind: "network_error",
    });
  });

  it("markDegraded：外部观测信号（如 unresponsive_engines）→ degraded", () => {
    const clock = fakeClock();
    const client = makeClient(async () => jsonResponse({}), clock);
    client.markDegraded("searxng", "baidu: timeout");
    const health = client.health("searxng");
    expect(health.state).toBe("degraded");
    expect(health.lastError).toContain("baidu");
  });
});
