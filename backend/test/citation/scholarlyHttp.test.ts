/**
 * M13.6 ScholarlyHttpClient / ProviderCooldownRegistry 429 策略回归。
 * 受控 Fake HTTP + Fake Clock + 注入 sleep（不依赖真实公网）：
 * - Retry-After 双格式（秒数 / HTTP-date）优先于指数退避；
 * - 429 → 429 → 200 恢复；持续 429 有界停止 + provider 冷却短路（不发请求）；
 * - Retry-After 超过单请求等待帽 → 立即让位（可恢复失败 + 冷却信息）；
 * - 等待可取消（AbortSignal）；
 * - 冷却跨组件共享：citation 429 → 检索栈（ProviderHttpClient，同名 provider）
 *   同步短路；其它 provider 不受影响；
 * - 400 / 401 / 403 / 404 不重试；5xx / 超时按退避重试后恢复；
 * - 尝试次数有上限（maxRetries）。
 */

import { describe, expect, it } from "vitest";

import { ProviderCooldownRegistry, ScholarlyHttpClient, ScholarlyHttpError } from "../../src/citation/scholarlyHttp.js";
import { ProviderHttpClient } from "../../src/search/providerHttp.js";

/** 构造可控 fetch：按序返回脚本化响应（或抛错） */
function scriptedFetch(script: Array<Response | Error | (() => Response | Error)>): {
  fetchImpl: typeof fetch;
  calls: string[];
} {
  const calls: string[] = [];
  let index = 0;
  const fetchImpl = (async (url: string | URL | Request) => {
    calls.push(String(url));
    const step = script[Math.min(index, script.length - 1)]!;
    index += 1;
    const value = typeof step === "function" ? step() : step;
    if (value instanceof Error) {
      throw value;
    }
    return value;
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

function response(status: number, body = "{}", headers: Record<string, string> = {}): Response {
  return new Response(body, { status, headers });
}

/** 注入 sleep：记录等待时长并立即放行（不真实等待） */
function recordingSleep(): { sleep: (ms: number, signal?: AbortSignal) => Promise<void>; waits: number[] } {
  const waits: number[] = [];
  return {
    sleep: (ms: number) => {
      waits.push(ms);
      return Promise.resolve();
    },
    waits,
  };
}

function fakeClock(startMs = 1_000_000): { now: () => number; advance: (ms: number) => void } {
  let current = startMs;
  return { now: () => current, advance: (ms) => { current += ms; } };
}

const FAST = { backoffBaseMs: 500, backoffJitterMs: 0 };

describe("ScholarlyHttpClient 429 策略", () => {
  it("429 + Retry-After 秒数：等待指定时长后重试成功（Retry-After 优先于退避）", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      response(429, "", { "Retry-After": "3" }),
      response(200, JSON.stringify({ ok: true })),
    ]);
    const sleep = recordingSleep();
    const client = new ScholarlyHttpClient({ fetchImpl, sleep: sleep.sleep, ...FAST });
    const body = await client.fetchJson<{ ok: boolean }>("crossref", "https://api.example/works");
    expect(body.ok).toBe(true);
    expect(calls).toHaveLength(2);
    expect(sleep.waits).toEqual([3000]);
    expect(client.telemetry.retries).toBe(1);
    expect(client.telemetry.rateLimited).toBe(1);
  });

  it("429 + Retry-After HTTP-date：按日期差等待（fake clock）", async () => {
    const clock = fakeClock();
    const dateHeader = new Date(clock.now() + 5_000).toUTCString();
    const { fetchImpl } = scriptedFetch([
      response(429, "", { "Retry-After": dateHeader }),
      response(200, "ok"),
    ]);
    const sleep = recordingSleep();
    const client = new ScholarlyHttpClient({ fetchImpl, sleep: sleep.sleep, now: clock.now, ...FAST });
    await client.fetchText("crossref", "https://api.example/works");
    expect(sleep.waits).toEqual([5000]);
  });

  it("429 无 Retry-After：走指数退避 + 抖动（非固定 300ms）；429→429→200 恢复", async () => {
    const { fetchImpl, calls } = scriptedFetch([
      response(429),
      response(429),
      response(200, JSON.stringify({ data: [] })),
    ]);
    const sleep = recordingSleep();
    const client = new ScholarlyHttpClient({ fetchImpl, sleep: sleep.sleep, backoffBaseMs: 500, backoffJitterMs: 0, rateLimitDefaultCooldownMs: 30_000 });
    const body = await client.fetchJson<{ data: unknown[] }>("openalex", "https://api.example/works");
    expect(body.data).toEqual([]);
    expect(calls).toHaveLength(3);
    // 指数退避：500ms → 1000ms（无抖动注入下确定）
    expect(sleep.waits).toEqual([500, 1000]);
  });

  it("持续 429：尝试次数有上限（maxRetries + 1 次尝试）后停止，provider 进入冷却；冷却期内短路不发请求", async () => {
    const { fetchImpl, calls } = scriptedFetch([response(429, "", { "Retry-After": "1" })]);
    const sleep = recordingSleep();
    const client = new ScholarlyHttpClient({ fetchImpl, sleep: sleep.sleep, maxRetries: 2, retryAfterRequestWaitCapMs: 10_000, ...FAST });
    await expect(client.fetchText("semantic-scholar", "https://api.example/paper")).rejects.toMatchObject({
      kind: "rate_limited",
    });
    expect(calls).toHaveLength(3); // 1 + 2 次重试
    expect(client.cooldowns.remaining("semantic-scholar")).toBeGreaterThan(0);
    // 冷却期内的新请求：立即失败（rate_limited + retryAfterMs），零网络调用
    const callsBefore = calls.length;
    await expect(client.fetchText("semantic-scholar", "https://api.example/paper/other")).rejects.toMatchObject({
      kind: "rate_limited",
    });
    expect(calls).toHaveLength(callsBefore);
    expect(client.telemetry.cooldownSkips).toBe(1);
  });

  it("Retry-After 超过单请求等待帽：立即让位（可恢复失败），provider 进入冷却供后续恢复", async () => {
    const { fetchImpl, calls } = scriptedFetch([response(429, "", { "Retry-After": "120" })]);
    const sleep = recordingSleep();
    const client = new ScholarlyHttpClient({ fetchImpl, sleep: sleep.sleep, retryAfterRequestWaitCapMs: 10_000, cooldownCapMs: 120_000 });
    const error: ScholarlyHttpError = await client.fetchText("crossref", "https://api.example/works").then(
      () => {
        throw new Error("expected rejection");
      },
      (caught: unknown) => {
        if (!(caught instanceof ScholarlyHttpError)) throw new Error("expected ScholarlyHttpError");
        return caught;
      },
    );
    expect(error.kind).toBe("rate_limited");
    expect(error.retryAfterMs).toBeGreaterThan(60_000); // 冷却信息保留（供恢复 pass 决策）
    expect(calls).toHaveLength(1);
    expect(sleep.waits).toEqual([]); // 没有在单个请求里 sleep 两分钟
  });

  it("等待可取消：AbortSignal 在退避等待期间触发 → aborted，不再发起重试", async () => {
    const { fetchImpl, calls } = scriptedFetch([response(503)]);
    const controller = new AbortController();
    const sleep = (_ms: number) =>
      new Promise<void>((_resolve, reject) => {
        // 等待开始即取消（模拟取消发生在退避窗口内）
        queueMicrotask(() => controller.abort());
        setTimeout(() => reject(new ScholarlyHttpError("aborted", "", "等待重试时被调用方取消")), 0);
      });
    const client = new ScholarlyHttpClient({ fetchImpl, sleep, ...FAST });
    await expect(
      client.fetchText("openalex", "https://api.example/works", { signal: controller.signal }),
    ).rejects.toMatchObject({ kind: "aborted" });
    expect(calls).toHaveLength(1);
  });

  it("永久性 400 / 401 / 403 / 404 不重试（404 保持权威否定语义）", async () => {
    for (const status of [400, 401, 403, 404]) {
      const { fetchImpl, calls } = scriptedFetch([response(status)]);
      const sleep = recordingSleep();
      const client = new ScholarlyHttpClient({ fetchImpl, sleep: sleep.sleep, ...FAST });
      const error = await client.fetchText("crossref", "https://api.example/works").then(
        () => {
          throw new Error("expected rejection");
        },
        (caught: unknown) => {
          if (!(caught instanceof ScholarlyHttpError)) throw new Error("expected ScholarlyHttpError");
          return caught;
        },
      );
      expect(error.kind).toBe("http_error");
      expect(error.status).toBe(status);
      expect(calls).toHaveLength(1);
      expect(sleep.waits).toEqual([]);
    }
  });

  it("5xx 按退避重试后恢复；超时 / 网络错误同样可重试", async () => {
    const { fetchImpl, calls } = scriptedFetch([response(503), response(200, "ok")]);
    const sleep = recordingSleep();
    const client = new ScholarlyHttpClient({ fetchImpl, sleep: sleep.sleep, ...FAST });
    expect(await client.fetchText("arxiv", "https://api.example/query")).toBe("ok");
    expect(calls).toHaveLength(2);
    const network = scriptedFetch([new TypeError("fetch failed"), response(200, "fine")]);
    const networkSleep = recordingSleep();
    const networkClient = new ScholarlyHttpClient({ fetchImpl: network.fetchImpl, sleep: networkSleep.sleep, ...FAST });
    expect(await networkClient.fetchText("arxiv", "https://api.example/query")).toBe("fine");
  });

  it("5xx 重试耗尽也进入短暂冷却（服务端过载不再立即加压）", async () => {
    const { fetchImpl } = scriptedFetch([response(503)]);
    const client = new ScholarlyHttpClient({
      fetchImpl,
      sleep: (() => Promise.resolve()) as unknown as (ms: number) => Promise<void>,
      maxRetries: 1,
      rateLimitDefaultCooldownMs: 8_000,
      ...FAST,
    });
    await expect(client.fetchText("openalex", "https://api.example/works")).rejects.toMatchObject({ kind: "server_error" });
    expect(client.cooldowns.remaining("openalex")).toBeGreaterThan(0);
  });
});

describe("ProviderCooldownRegistry 跨栈共享（citation ↔ search）", () => {
  it("citation 429 进入冷却 → 检索栈同上游请求被短路；其它 provider 不受影响", async () => {
    const registry = new ProviderCooldownRegistry();
    // citation 侧：一次 429（Retry-After 60s > 默认单请求帽 10s → 让位进冷却）
    const scholarly = new ScholarlyHttpClient({
      fetchImpl: scriptedFetch([response(429, "", { "Retry-After": "60" })]).fetchImpl,
      sleep: recordingSleep().sleep,
      cooldownRegistry: registry,
      retryAfterRequestWaitCapMs: 10_000,
      cooldownCapMs: 120_000,
    });
    await expect(scholarly.fetchText("semantic-scholar", "https://api.example/paper")).rejects.toMatchObject({ kind: "rate_limited" });
    expect(registry.remaining("semantic-scholar")).toBeGreaterThan(30_000);

    // 检索栈：同上游（semantic-scholar）被共享冷却短路；openalex 正常放行
    const searchCalls: string[] = [];
    const searchHttp = new ProviderHttpClient({
      fetchImpl: (async (url: string | URL | Request) => {
        searchCalls.push(String(url));
        return response(200, JSON.stringify({ data: [] }));
      }) as unknown as typeof fetch,
      cooldownRegistry: registry,
      defaultMaxRetries: 0,
    });
    await expect(
      searchHttp.fetchJson({ name: "semantic-scholar" }, "https://api.example/search"),
    ).rejects.toMatchObject({ kind: "rate_limited" });
    expect(searchCalls).toEqual([]); // 未发任何网络请求
    await expect(searchHttp.fetchJson({ name: "openalex" }, "https://api.example/works")).resolves.toEqual({ data: [] });
    expect(searchCalls).toHaveLength(1);
  });

  it("两个 citation 组件共享冷却：Resolver 侧 429 后，CitationService 侧同上游也被短路", async () => {
    const registry = new ProviderCooldownRegistry();
    const first = new ScholarlyHttpClient({
      fetchImpl: scriptedFetch([response(429, "", { "Retry-After": "30" })]).fetchImpl,
      sleep: recordingSleep().sleep,
      cooldownRegistry: registry,
      retryAfterRequestWaitCapMs: 5_000,
    });
    await expect(first.fetchText("crossref", "https://api.example/a")).rejects.toMatchObject({ kind: "rate_limited" });
    const secondCalls: string[] = [];
    const second = new ScholarlyHttpClient({
      fetchImpl: (async (url: string | URL | Request) => {
        secondCalls.push(String(url));
        return response(200, "{}");
      }) as unknown as typeof fetch,
      cooldownRegistry: registry,
    });
    await expect(second.fetchText("crossref", "https://api.example/b")).rejects.toMatchObject({ kind: "rate_limited" });
    expect(secondCalls).toEqual([]);
  });

  it("冷却到期自动恢复（registry.remaining 归零后请求照常派发）", async () => {
    const clock = fakeClock();
    const registry = new ProviderCooldownRegistry(clock.now);
    registry.record("crossref", 1_000);
    clock.advance(1_001);
    expect(registry.remaining("crossref")).toBe(0);
    const { fetchImpl, calls } = scriptedFetch([response(200, "ok")]);
    const client = new ScholarlyHttpClient({ fetchImpl, cooldownRegistry: registry, now: clock.now });
    expect(await client.fetchText("crossref", "https://api.example/works")).toBe("ok");
    expect(calls).toHaveLength(1);
  });
});
