/**
 * VenueResolutionService 单元测试（M12.1 A2）。
 *
 * 覆盖：种子 alias 多别名命中（大小写/标点/空白归一）、openalex_lookup 命中
 * （fake fetch 注入 ProviderHttpClient）、lookup 无结果 → not_found、
 * 首屏不相似 → not_found（不 silent fallback 到错误 venue）、多相似 →
 * ambiguous、per 实例缓存（同输入只打一次 HTTP）、网络失败照实抛
 * （error ≠ not_found）、种子 JSON 可加载且 schema 自洽、matchNames 供
 * venueNames 客户端过滤。
 */

import { describe, expect, it } from "vitest";

import { ProviderHttpClient } from "../../src/search/providerHttp.js";
import {
  VenueResolutionService,
  loadVenueSeeds,
  type VenueSeed,
} from "../../src/search/venueResolution.js";

const json = (body: unknown, status = 200): Response =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

function httpWith(responses: Array<(url: string) => Response>) {
  const calls: string[] = [];
  let call = 0;
  const impl = async (url: string | URL | Request): Promise<Response> => {
    calls.push(String(url));
    const response = responses[Math.min(call, responses.length - 1)]!;
    call += 1;
    return response(String(url));
  };
  return { http: new ProviderHttpClient({ fetchImpl: impl as typeof fetch, now: () => 1_000_000, sleep: async () => {}, defaultMaxRetries: 0 }), calls };
}

/** 注入式种子（不依赖 JSON 文件；文件加载单独测） */
const SEEDS: VenueSeed[] = [
  {
    canonicalId: "cvpr",
    displayName: "CVPR",
    aliases: ["CVPR", "IEEE/CVF Conference on Computer Vision and Pattern Recognition"],
    venueType: "conference",
    openalexSourceId: "S4210176548",
  },
  {
    canonicalId: "tpami",
    displayName: "IEEE TPAMI",
    aliases: ["TPAMI", "IEEE Transactions on Pattern Analysis and Machine Intelligence"],
    venueType: "journal",
    openalexSourceId: "S199944782",
  },
  {
    canonicalId: "shared-alias-a",
    displayName: "Venue Alpha",
    aliases: ["Dual Purpose Journal"],
    venueType: "journal",
  },
  {
    canonicalId: "shared-alias-b",
    displayName: "Venue Beta",
    aliases: ["Dual Purpose Journal"],
    venueType: "journal",
  },
];

function service(seeds: VenueSeed[] = SEEDS, responses: Array<(url: string) => Response> = [() => json({ results: [] })]) {
  const harness = httpWith(responses);
  const resolver = new VenueResolutionService({ http: harness.http, seeds });
  return { resolver, calls: harness.calls };
}

describe("VenueResolutionService", () => {
  it("种子 alias 命中：多别名 / 大小写 / 标点 / 空白归一 → resolved(origin=seed)", async () => {
    const { resolver, calls } = service();
    const direct = await resolver.resolve("CVPR");
    expect(direct).toMatchObject({
      status: "resolved",
      origin: "seed",
      canonicalId: "cvpr",
      displayName: "CVPR",
      openalexSourceId: "S4210176548",
      venueType: "conference",
    });
    // 全称别名（不同标点/大小写形态）
    const full = await resolver.resolve("ieee/cvf conference on computer vision and pattern recognition");
    expect(full).toMatchObject({ status: "resolved", canonicalId: "cvpr" });
    // journal 种子 + 点号/空格变体
    const t = await resolver.resolve("IEEE. Transactions on Pattern Analysis and Machine  Intelligence");
    expect(t).toMatchObject({ status: "resolved", canonicalId: "tpami", openalexSourceId: "S199944782" });
    expect(calls).toHaveLength(0); // 种子命中不发 HTTP
  });

  it("resolved.matchNames 含 displayName + aliases + 原始输入（供 venueNames 客户端过滤）", async () => {
    const { resolver } = service();
    const resolved = await resolver.resolve("CVPR");
    expect(resolved.status).toBe("resolved");
    if (resolved.status === "resolved") {
      expect(resolved.matchNames).toContain("CVPR");
      expect(resolved.matchNames).toContain("IEEE/CVF Conference on Computer Vision and Pattern Recognition");
      expect(resolved.matchNames).toContain("CVPR"); // 原始输入（去重后）
    }
  });

  it("openalex_lookup 命中：首个结果与查询归一化全等 → resolved(origin=openalex_lookup)", async () => {
    const { resolver, calls } = service(
      SEEDS.filter((seed) => seed.canonicalId !== "cvpr" && !seed.canonicalId.startsWith("shared")),
      [
        () =>
          json({
            results: [
              { id: "https://openalex.org/S1234567890", display_name: "Journal of Obscure Studies", type: "journal" },
            ],
          }),
      ],
    );
    const outcome = await resolver.resolve("Journal of Obscure Studies");
    expect(outcome).toMatchObject({
      status: "resolved",
      origin: "openalex_lookup",
      displayName: "Journal of Obscure Studies",
      openalexSourceId: "S1234567890",
      venueType: "journal",
    });
    expect(calls[0]).toContain("/sources?search=");
  });

  it("lookup 包含命中：查询是结果名的子串（短侧 ≥6）→ resolved", async () => {
    const { resolver } = service(
      SEEDS.filter((seed) => !seed.canonicalId.startsWith("shared") && seed.canonicalId !== "cvpr"),
      [
        () =>
          json({
            results: [
              { id: "https://openalex.org/S9876543210", display_name: "IEEE Robotics and Automation Letters", type: "journal" },
            ],
          }),
      ],
    );
    const outcome = await resolver.resolve("Robotics and Automation Letters");
    expect(outcome).toMatchObject({ status: "resolved", openalexSourceId: "S9876543210" });
  });

  it("lookup 无结果 → not_found；首屏不相似 → not_found（不 silent fallback）", async () => {
    const empty = service(undefined, [() => json({ results: [] })]);
    await expect(empty.resolver.resolve("Totally Unknown Venue")).resolves.toMatchObject({
      status: "not_found",
    });
    // 有结果但都不相似：绝不采纳第一个不相干结果（防错配）
    const dissimilar = service(
      SEEDS.filter((seed) => !seed.canonicalId.startsWith("shared")),
      [
        () =>
          json({
            results: [{ id: "https://openalex.org/S1", display_name: "Annual Review of Fluid Mechanics", type: "journal" }],
          }),
      ],
    );
    const outcome = await dissimilar.resolver.resolve("Venue of Interest Here");
    expect(outcome).toMatchObject({ status: "not_found" });
    if (outcome.status === "not_found") {
      expect(outcome.reason).toContain("不相似");
    }
  });

  it("lookup 多个不同 source 相似 → ambiguous（带 candidates，不裁决）", async () => {
    const { resolver } = service(
      SEEDS.filter((seed) => !seed.canonicalId.startsWith("shared")),
      [
        () =>
          json({
            results: [
              { id: "https://openalex.org/S7407086902", display_name: "IEEE International Conference on Computer Vision", type: "conference" },
              { id: "https://openalex.org/S4363607764", display_name: "IEEE/CVF International Conference on Computer Vision", type: "conference" },
            ],
          }),
      ],
    );
    const outcome = await resolver.resolve("International Conference on Computer Vision");
    expect(outcome.status).toBe("ambiguous");
    if (outcome.status === "ambiguous") {
      expect(outcome.candidates).toHaveLength(2);
      expect(outcome.candidates[0]).toMatchObject({ provenance: "openalex_lookup" });
    }
  });

  it("种子多 canonicalId 共享别名 → ambiguous", async () => {
    const { resolver } = service();
    const outcome = await resolver.resolve("Dual Purpose Journal");
    expect(outcome.status).toBe("ambiguous");
    if (outcome.status === "ambiguous") {
      expect(new Set(outcome.candidates.map((c) => c.displayName))).toEqual(new Set(["Venue Alpha", "Venue Beta"]));
    }
  });

  it("per 实例缓存：同输入两次 resolve 只发一次 HTTP（含 not_found 结果）", async () => {
    const { resolver, calls } = service(
      SEEDS.filter((seed) => !seed.canonicalId.startsWith("shared")),
      [
        () =>
          json({
            results: [{ id: "https://openalex.org/S55", display_name: "Cache Test Venue Journal", type: "journal" }],
          }),
      ],
    );
    await resolver.resolve("Cache Test Venue");
    await resolver.resolve("Cache Test Venue");
    expect(calls).toHaveLength(1);
  });

  it("lookup HTTP 失败 → 照实抛错（error ≠ not_found）", async () => {
    const { resolver } = service(undefined, [() => json({ message: "boom" }, 500)]);
    await expect(resolver.resolve("Some Unseeded Venue")).rejects.toMatchObject({ kind: "http_error" });
  });

  it("空输入 / 纯标点输入 → not_found（不发请求）", async () => {
    const { resolver, calls } = service();
    await expect(resolver.resolve("   ")).resolves.toMatchObject({ status: "not_found" });
    await expect(resolver.resolve("...")).resolves.toMatchObject({ status: "not_found" });
    expect(calls).toHaveLength(0);
  });
});

describe("venue-seeds.json（真实资源文件）", () => {
  it("可加载、schema 自洽、覆盖 15+ 种子、高置信 id 形态合法", async () => {
    const seeds = await loadVenueSeeds();
    expect(seeds.length).toBeGreaterThanOrEqual(15);
    const canonicalIds = new Set<string>();
    for (const seed of seeds) {
      expect(seed.canonicalId).toMatch(/^[a-z0-9][a-z0-9-]*$/);
      expect(canonicalIds.has(seed.canonicalId)).toBe(false);
      canonicalIds.add(seed.canonicalId);
      expect(seed.displayName.trim()).not.toBe("");
      expect(seed.aliases.length).toBeGreaterThan(0);
      expect(["conference", "journal"]).toContain(seed.venueType);
      if (seed.openalexSourceId !== undefined) {
        expect(seed.openalexSourceId).toMatch(/^S\d+$/);
      }
    }
    // 高置信 id 抽查（2026-10-07 api.openalex.org/sources 直接核验过的值）
    const byId = new Map(seeds.map((seed) => [seed.canonicalId, seed]));
    expect(byId.get("cvpr")?.openalexSourceId).toBe("S4210176548");
    expect(byId.get("neurips")?.openalexSourceId).toBe("S4363606243");
    expect(byId.get("tpami")?.openalexSourceId).toBe("S199944782");
    expect(byId.get("ijcv")?.openalexSourceId).toBe("S25538012");
    // 宁缺勿错：不确定的 venue 不带 id（iccv/kdd 双 source 归属歧义）
    expect(byId.get("iccv")?.openalexSourceId).toBeUndefined();
    expect(byId.get("kdd")?.openalexSourceId).toBeUndefined();
  });

  it("真实种子可被 service 消费（seed 命中不发 HTTP）", async () => {
    const { http, calls } = httpWith([() => json({ results: [] })]);
    const resolver = new VenueResolutionService({ http });
    const outcome = await resolver.resolve("CVPR");
    expect(outcome).toMatchObject({ status: "resolved", canonicalId: "cvpr" });
    expect(calls).toHaveLength(0);
  });
});
