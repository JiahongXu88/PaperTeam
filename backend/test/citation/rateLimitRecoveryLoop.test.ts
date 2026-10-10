/**
 * Round 2 真实 run 回归：限流恢复 pass 的「实时冷却提示 + 有界多轮」语义
 * （见 src/citation/rateLimitRecovery.ts 头注释里的真实失败模式）。
 *
 * A. runRateLimitRecovery 纯函数语义（fake 时钟 / sleep）：
 *    - 等待取实时冷却提示而非失败快照；等待后补查；
 *    - 补查中再次限流 → 下一轮继续等待（多轮）；
 *    - 零进展且无冷却提示 → 停止（不空转）；超预算 → 不等待、如实标记；预算 ≤0 关闭；轮数上限。
 * B. CitationService × 真实 ScholarlyHttpClient 复现真实失败模式（短冷却、真实计时器）：
 *    首个 crossref 请求 429（无 Retry-After）→ 其余条目被冷却闸门短路；恢复 pass 等待
 *    实时冷却后补查，补查中再次 429 → 第二轮再等 → 全部恢复；报告携带 byErrorKind /
 *    recovery / http 遥测。
 * C. ScholarlyHttpClient 礼貌节奏（minRequestIntervalMs）：同 provider 相邻请求按间隔等待，
 *    其它 provider 不受影响；等待计入 telemetry.pacingWaitMs。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { CitationService } from "../../src/citation/CitationService.js";
import { CrossRefProvider } from "../../src/citation/metadataProviders.js";
import { runRateLimitRecovery } from "../../src/citation/rateLimitRecovery.js";
import { ProviderCooldownRegistry, ScholarlyHttpClient } from "../../src/citation/scholarlyHttp.js";

const tempRoots: string[] = [];
afterAll(async () => {
  for (const root of tempRoots.reverse()) await rm(root, { recursive: true, force: true });
});

describe("A. runRateLimitRecovery 语义", () => {
  function harness(initialPending: number[]) {
    let nowMs = 1_000_000;
    const sleeps: number[] = [];
    const logs: string[] = [];
    const pending = new Set(initialPending);
    return {
      now: () => nowMs,
      advance: (ms: number) => {
        nowMs += ms;
      },
      sleep: async (ms: number) => {
        sleeps.push(ms);
        nowMs += ms;
      },
      sleeps,
      logs,
      log: (message: string) => {
        logs.push(message);
      },
      pending: () => [...pending].sort((a, b) => a - b),
      resolve: (index: number) => pending.delete(index),
    };
  }

  it("等待取实时冷却提示（不是失败快照的 min）；等待后补查全部恢复", async () => {
    const h = harness([0, 1, 2]);
    let hint = 10_000; // 注册表：provider 还要冷却 10s
    const telemetry = await runRateLimitRecovery({
      budgetMs: 60_000,
      now: h.now,
      sleep: h.sleep,
      pending: h.pending,
      waitHintMs: () => hint,
      retry: async (index) => {
        hint = 0; // 等待后 provider 已恢复
        h.resolve(index);
        return true;
      },
      log: h.log,
      label: "[t]",
    });
    expect(h.sleeps).toEqual([10_000]);
    expect(telemetry).toEqual({ passes: 1, waitedMs: 10_000, retried: 3, recovered: 3, overBudget: false });
    expect(h.logs.some((line) => line.includes("等待 10s 后补查"))).toBe(true);
  });

  it("补查中再次限流 → 下一轮继续等待（多轮有界），直到全部恢复", async () => {
    const h = harness([0, 1, 2]);
    let hint = 5_000;
    let calls = 0;
    const telemetry = await runRateLimitRecovery({
      budgetMs: 60_000,
      now: h.now,
      sleep: h.sleep,
      pending: h.pending,
      waitHintMs: () => hint,
      retry: async (index) => {
        calls += 1;
        if (calls === 1) {
          hint = 0;
          h.resolve(index);
          return true; // 第一条恢复
        }
        if (calls === 2) {
          hint = 5_000; // 第二条再次 429 → provider 重新冷却 5s
          return false;
        }
        if (calls === 3) {
          return false; // 第三条被冷却短路
        }
        hint = 0;
        h.resolve(index);
        return true; // 第二轮：余下两条恢复
      },
      log: h.log,
      label: "[t]",
    });
    expect(h.sleeps).toEqual([5_000, 5_000]);
    expect(telemetry).toEqual({ passes: 2, waitedMs: 10_000, retried: 5, recovered: 3, overBudget: false });
  });

  it("一轮零进展且无冷却提示 → 停止补查（不空转）", async () => {
    const h = harness([0, 1]);
    let retries = 0;
    const telemetry = await runRateLimitRecovery({
      budgetMs: 60_000,
      now: h.now,
      sleep: h.sleep,
      pending: h.pending,
      waitHintMs: () => 0,
      retry: async () => {
        retries += 1;
        return false;
      },
      log: h.log,
      label: "[t]",
    });
    expect(retries).toBe(2);
    expect(telemetry.passes).toBe(1);
    expect(telemetry.recovered).toBe(0);
    expect(h.logs.some((line) => line.includes("零进展"))).toBe(true);
  });

  it("冷却剩余超过预算 → 不等待、不补查、overBudget=true；预算 ≤0 → 直接关闭", async () => {
    const h = harness([0]);
    let retries = 0;
    const over = await runRateLimitRecovery({
      budgetMs: 60_000,
      now: h.now,
      sleep: h.sleep,
      pending: h.pending,
      waitHintMs: () => 120_000,
      retry: async () => {
        retries += 1;
        return true;
      },
      log: h.log,
      label: "[t]",
    });
    expect(over).toEqual({ passes: 0, waitedMs: 0, retried: 0, recovered: 0, overBudget: true });
    expect(retries).toBe(0);
    expect(h.sleeps).toEqual([]);
    expect(h.logs.some((line) => line.includes("超过恢复预算"))).toBe(true);

    const disabled = await runRateLimitRecovery({
      budgetMs: 0,
      now: h.now,
      sleep: h.sleep,
      pending: h.pending,
      waitHintMs: () => 0,
      retry: async () => true,
      log: h.log,
      label: "[t]",
    });
    expect(disabled.passes).toBe(0);
  });

  it("预算在多轮中逐步消耗：剩余预算不够下一次等待时如实停止", async () => {
    const h = harness([0]);
    const telemetry = await runRateLimitRecovery({
      budgetMs: 12_000,
      now: h.now,
      sleep: h.sleep,
      pending: h.pending,
      waitHintMs: () => 5_000,
      retry: async () => false, // 永远限流
      maxPasses: 10,
      log: h.log,
      label: "[t]",
    });
    // 第 1 轮 t=5s、第 2 轮 t=10s 可等；第 3 轮 10s+5s > 12s 预算 → 超预算停止
    expect(telemetry.passes).toBe(2);
    expect(telemetry.overBudget).toBe(true);
    expect(h.sleeps).toEqual([5_000, 5_000]);
  });

  it("轮数上限兜底", async () => {
    const h = harness([0]);
    const telemetry = await runRateLimitRecovery({
      budgetMs: 1_000_000,
      now: h.now,
      sleep: h.sleep,
      pending: h.pending,
      waitHintMs: () => 1_000,
      retry: async () => false,
      maxPasses: 3,
      log: h.log,
      label: "[t]",
    });
    expect(telemetry.passes).toBe(3);
    expect(telemetry.overBudget).toBe(false);
  });
});

describe("B. CitationService 复现真实失败模式（冷却短路 + 恢复中再次 429）", () => {
  async function prepareBibProject(keys: string[]): Promise<{ store: ProjectStore; projectId: string }> {
    const root = await mkdtemp(join(tmpdir(), "paperteam-cit-loop-"));
    tempRoots.push(root);
    const store = new ProjectStore({ root });
    const project = await store.create("bib 限流多轮");
    const manuscriptDir = store.manuscriptDir(project.id);
    await mkdir(join(manuscriptDir, "sections"), { recursive: true });
    await writeFile(
      join(manuscriptDir, "main.tex"),
      ["\\documentclass{ctexart}", "\\begin{document}", "\\input{sections/introduction}", "\\bibliographystyle{unsrt}", "\\bibliography{references}", "\\end{document}"].join("\n"),
      "utf8",
    );
    await writeFile(join(manuscriptDir, "sections", "introduction.tex"), `如 \\cite{${keys.join(", ")}} 所示。`, "utf8");
    await writeFile(
      join(manuscriptDir, "references.bib"),
      keys.flatMap((key, index) => [`@article{${key},`, `  title = {Paper ${index + 1}},`, "  year = {2020},", `  doi = {10.1/${key}}`, "}"]).join("\n"),
      "utf8",
    );
    return { store, projectId: project.id };
  }

  it("首个 429 让其余条目被冷却短路；恢复 pass 按实时冷却等待、再次 429 后再等一轮 → 全部核验", async () => {
    const keys = ["e1", "e2", "e3", "e4", "e5"];
    const { store, projectId } = await prepareBibProject(keys);
    let crossrefCalls = 0;
    const logs: string[] = [];
    const service = new CitationService({
      projects: store,
      providers: [new CrossRefProvider()],
      fetchImpl: (async (url: string | URL | Request) => {
        crossrefCalls += 1;
        // 第 1 次（首轮 e1）与第 3 次（恢复第 1 轮的第二条）返回 429（无 Retry-After）；其余成功
        if (crossrefCalls === 1 || crossrefCalls === 3) {
          return new Response("{}", { status: 429 });
        }
        const doi = decodeURIComponent(String(url)).split("/works/")[1] ?? "";
        const index = keys.indexOf(doi.replace("10.1/", ""));
        return new Response(JSON.stringify({ status: "ok", message: { title: `Paper ${index + 1}` } }), {
          status: 200,
          headers: { "content-type": "application/json" },
        });
      }) as unknown as typeof fetch,
      httpOptions: { maxRetries: 0, rateLimitDefaultCooldownMs: 60, cooldownCapMs: 60 },
      rateLimitRecoveryMs: 5_000,
      log: (message) => {
        logs.push(message);
      },
    });
    const report = await service.verify(projectId);
    expect(report.metadata.byStatus.verified).toBe(5);
    expect(report.metadata.byStatus.unverifiable).toBe(0);
    // 首轮：1 次真实请求（429）+ 4 次冷却短路；恢复第 1 轮：e1 成功、e2 429、e3–e5 短路；第 2 轮：e2–e5 成功
    expect(crossrefCalls).toBe(1 + 1 + 1 + 4);
    expect(report.metadata.recovery).toMatchObject({ passes: 2, recovered: 5, overBudget: false });
    expect(report.metadata.recovery?.waitedMs ?? 0).toBeGreaterThan(0);
    expect(report.metadata.http).toMatchObject({ requests: 7, rateLimited: 2 });
    expect(report.metadata.http?.cooldownSkips).toBe(4 + 3);
    expect(report.metadata.byErrorKind).toEqual({});
    expect(logs.filter((line) => line.includes("限流恢复第")).length).toBeGreaterThanOrEqual(2);
  });

  it("冷却超过预算 → 如实 unverifiable + byErrorKind.rate_limited + overBudget（不等待）", async () => {
    const keys = ["s1", "s2"];
    const { store, projectId } = await prepareBibProject(keys);
    const service = new CitationService({
      projects: store,
      providers: [new CrossRefProvider()],
      fetchImpl: (async () => new Response("{}", { status: 429, headers: { "Retry-After": "600" } })) as unknown as typeof fetch,
      httpOptions: { maxRetries: 0 },
      rateLimitRecoveryMs: 1_000,
      log: () => {},
    });
    const startedAt = Date.now();
    const report = await service.verify(projectId);
    expect(Date.now() - startedAt).toBeLessThan(900); // 没有真的等待
    expect(report.metadata.byStatus.unverifiable).toBe(2);
    expect(report.metadata.byErrorKind).toEqual({ rate_limited: 2 });
    expect(report.metadata.recovery).toMatchObject({ passes: 0, overBudget: true });
  });
});

describe("C. ScholarlyHttpClient 礼貌节奏", () => {
  it("同 provider 相邻请求按 minRequestIntervalMs 等待；其它 provider 不受影响", async () => {
    let nowMs = 0;
    const sleeps: number[] = [];
    const client = new ScholarlyHttpClient({
      fetchImpl: (async () => new Response("{}", { status: 200 })) as unknown as typeof fetch,
      now: () => nowMs,
      sleep: async (ms) => {
        sleeps.push(ms);
        nowMs += ms;
      },
      minRequestIntervalMs: { arxiv: 3_000 },
      cooldownRegistry: new ProviderCooldownRegistry(() => nowMs),
    });
    await client.fetchText("arxiv", "https://export.arxiv.org/api/query?a");
    await client.fetchText("crossref", "https://api.crossref.org/works/x");
    nowMs += 500;
    await client.fetchText("arxiv", "https://export.arxiv.org/api/query?b");
    expect(sleeps).toEqual([2_500]);
    expect(client.telemetry.pacingWaitMs).toBe(2_500);
    expect(client.telemetry.requests).toBe(3);
  });

  it("ProviderCooldownRegistry.earliestRecoveryMs 只看仍在冷却的 provider", () => {
    let nowMs = 10_000;
    const registry = new ProviderCooldownRegistry(() => nowMs);
    expect(registry.earliestRecoveryMs()).toBe(0);
    registry.record("openalex", 120_000);
    registry.record("crossref", 10_000);
    expect(registry.earliestRecoveryMs()).toBe(10_000);
    expect(registry.coolingProviders().map((entry) => entry.provider).sort()).toEqual(["crossref", "openalex"]);
    nowMs += 10_000;
    expect(registry.earliestRecoveryMs()).toBe(110_000);
    expect(registry.coolingProviders()).toEqual([{ provider: "openalex", remainingMs: 110_000, unavailable: false }]);
  });
});
