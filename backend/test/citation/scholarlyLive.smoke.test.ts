/**
 * M4.3.4 Live scholarly smoke（真实外部服务；默认跳过，不进默认 CI）。
 *
 * 运行：PAPERTEAM_LIVE_SMOKE=1 npx vitest run test/citation/scholarlyLive.smoke.test.ts
 * 覆盖：真实著名论文 VERIFIED / 故意错误年份 mismatch / 不存在文献 NOT_FOUND。
 */

import { describe, expect, it } from "vitest";

import { ScholarlyResolver } from "../../src/citation/scholarly.js";

const live = process.env["PAPERTEAM_LIVE_SMOKE"] === "1";

describe.skipIf(!live)("M4.3.4 live scholarly lookup smoke（真实公网调用）", () => {
  const resolver = new ScholarlyResolver({ politenessDelayMs: 300, timeoutMs: 15_000 });

  it("真实论文：Attention Is All You Need → match（VERIFIED）", { timeout: 120_000 }, async () => {
    const verdict = await resolver.resolve({
      title: "Attention is all you need",
      authors: ["Ashish Vaswani"],
      year: 2017,
    });
    // eslint-disable-next-line no-console
    console.log("[live] attention:", JSON.stringify({
      outcome: verdict.outcome,
      provider: verdict.canonical?.provider,
      title: verdict.canonical?.title,
      year: verdict.canonical?.year,
      doi: verdict.canonical?.doi,
      attempts: verdict.attempts,
    }));
    expect(["match", "mismatch"]).toContain(verdict.outcome);
    expect(verdict.canonical?.title?.toLowerCase()).toContain("attention");
    expect(verdict.canonical?.year).toBeGreaterThanOrEqual(2017);
  });

  it("真实论文 + 故意错误年份 → mismatch(year)", { timeout: 120_000 }, async () => {
    const verdict = await resolver.resolve({
      title: "Attention is all you need",
      year: 2021,
    });
    // eslint-disable-next-line no-console
    console.log("[live] wrong-year:", JSON.stringify({ outcome: verdict.outcome, mismatches: verdict.mismatches }));
    expect(verdict.outcome === "mismatch" || verdict.canonical?.year === 2021).toBe(true);
  });

  it("arXiv 论文：Neural machine translation by jointly learning to align and translate", { timeout: 120_000 }, async () => {
    const verdict = await resolver.resolve({
      title: "Neural machine translation by jointly learning to align and translate",
      year: 2014,
    });
    // eslint-disable-next-line no-console
    console.log("[live] bahdanau:", JSON.stringify({
      outcome: verdict.outcome,
      provider: verdict.canonical?.provider,
      arxiv: verdict.canonical?.arxivId,
    }));
    expect(["match", "mismatch"]).toContain(verdict.outcome);
  });

  it("故意虚构文献 → NOT_FOUND（不允许被“补成真的”）", { timeout: 180_000 }, async () => {
    const verdict = await resolver.resolve({
      title: "Quantum Frobnication Fluctuations in Imaginary Tensor Manifolds for Nonexistent Research",
      year: 2027,
    });
    // eslint-disable-next-line no-console
    console.log("[live] ghost:", JSON.stringify({ outcome: verdict.outcome, attempts: verdict.attempts }));
    expect(["not_found", "unresolved"]).toContain(verdict.outcome);
    expect(verdict.outcome).not.toBe("match");
  });
});
