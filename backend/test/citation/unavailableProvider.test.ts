/**
 * Round 2 NB-R2-2：服务端 Retry-After 远超冷却帽的 provider（真实 run：OpenAlex 12–13 小时）
 * 在可预见时间内不可用——恢复 pass 的等待提示必须跳过它，否则每轮核验白等 90–100 s。
 * 冷却闸门语义不变（按帽值短路）；只是 earliestRecoveryMs 默认不把它算作「最早恢复者」。
 */

import { describe, expect, it } from "vitest";

import { ProviderCooldownRegistry, ScholarlyHttpClient } from "../../src/citation/scholarlyHttp.js";

describe("ProviderCooldownRegistry：长时不可用 provider", () => {
  it("markUnavailableUntil / isUnavailable；earliestRecoveryMs 默认跳过，不可用全覆盖时为 0", () => {
    let nowMs = 1_000_000;
    const registry = new ProviderCooldownRegistry(() => nowMs);
    registry.record("openalex", 120_000);
    registry.markUnavailableUntil("openalex", nowMs + 44_567_000); // 服务端声明 12.4h
    registry.record("crossref", 10_000);
    expect(registry.isUnavailable("openalex")).toBe(true);
    expect(registry.isUnavailable("crossref")).toBe(false);
    expect(registry.earliestRecoveryMs()).toBe(10_000); // crossref 才是值得等的
    expect(registry.earliestRecoveryMs({ includeUnavailable: true })).toBe(10_000);
    nowMs += 10_000; // crossref 冷却结束
    expect(registry.earliestRecoveryMs()).toBe(0); // 只剩不可用的 openalex → 不等
    expect(registry.earliestRecoveryMs({ includeUnavailable: true })).toBe(110_000);
    expect(registry.coolingProviders()).toEqual([{ provider: "openalex", remainingMs: 110_000, unavailable: true }]);
    nowMs += 44_600_000; // 声明期过去
    expect(registry.isUnavailable("openalex")).toBe(false);
  });

  it("不缩短既有不可用声明", () => {
    let nowMs = 0;
    const registry = new ProviderCooldownRegistry(() => nowMs);
    registry.markUnavailableUntil("openalex", 50_000);
    registry.markUnavailableUntil("openalex", 20_000);
    nowMs = 30_000;
    expect(registry.isUnavailable("openalex")).toBe(true);
  });
});

describe("ScholarlyHttpClient：Retry-After 超过冷却帽 → 标记长时不可用", () => {
  it("429 + Retry-After 44567s：冷却按帽值 120s 记录，同时 markUnavailableUntil；普通 429 不标记", async () => {
    let nowMs = 5_000_000;
    const registry = new ProviderCooldownRegistry(() => nowMs);
    let call = 0;
    const client = new ScholarlyHttpClient({
      fetchImpl: (async () => {
        call += 1;
        return call === 1
          ? new Response("{}", { status: 429, headers: { "Retry-After": "44567" } })
          : new Response("{}", { status: 429 });
      }) as unknown as typeof fetch,
      now: () => nowMs,
      sleep: async (ms) => {
        nowMs += ms;
      },
      maxRetries: 0,
      cooldownRegistry: registry,
    });
    await expect(client.fetchText("openalex", "https://api.openalex.org/works/x")).rejects.toMatchObject({ kind: "rate_limited" });
    expect(registry.remaining("openalex")).toBe(120_000);
    expect(registry.isUnavailable("openalex")).toBe(true);
    await expect(client.fetchText("crossref", "https://api.crossref.org/works/y")).rejects.toMatchObject({ kind: "rate_limited" });
    expect(registry.remaining("crossref")).toBe(10_000);
    expect(registry.isUnavailable("crossref")).toBe(false);
    // 恢复 pass 的等待提示：只等 crossref 的 10s，不等 openalex 的 120s
    expect(registry.earliestRecoveryMs()).toBe(10_000);
  });
});
