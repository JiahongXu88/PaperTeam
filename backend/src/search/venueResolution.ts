/**
 * VenueResolutionService：venue 名 → OpenAlex source id（M12.1 A2；M12.0
 * §4.2-6 冻结的三段 resolution）。
 *
 * 1. 种子表精确命中：输入归一化（NFKC/小写/去非字母数字——与 venueFilter.ts
 *   同一归一函数）后与种子 displayName/aliases 全等比较；多 canonicalId 同时
 *   命中 → ambiguous（种子表歧义是数据问题，如实上报不裁决）；
 * 2. 种子未命中 → 调 OpenAlex `GET /sources?search=<q>` **一次**（经
 *   ProviderHttpClient——超时/重试/熔断/健康统一由它承担，provider 不写第二
 *   套 retry），首屏结果按「防错配相似判据」筛：归一化全等，或短侧 ≥6 字符
 *   的包含关系（与 venueFilter 的客户端匹配同规则）。恰好一个相似 source →
 *   resolved（origin=openalex_lookup）；≥2 个不同 id 相似 → ambiguous；
 *   0 个相似 → not_found——**绝不静默 fallback 到不相干的 source**（错误 id
 *   会在上游 venueSourceIds 服务端过滤里静默捞错 venue 的论文，比缺失更糟）；
 * 3. 全部失败 → 结构化 not_found（可序列化判别联合，UI/API 可直接消费）。
 *
 * 缓存：per service 实例的 in-memory Map（含 not_found——进程生命周期内的
 * 稳定答案；换进程即清。venue 种子表更新后重启生效，不做 TTL 复杂度）。
 *
 * 错误语义（D-0023：error ≠ not_found）：OpenAlex 网络/限流失败**抛**
 * ProviderHttpError（由调用方决定降级或重试），绝不折算成 not_found——
 * 「检索失败」与「确认无此 venue」是两种事实。
 *
 * 种子 JSON 加载策略（为什么不用 `import ... with { type: "json" }`）：
 * tsconfig.build 的 rootDir=src/outDir=dist 只编译 src——JSON import 断言在
 * `npm run build` 产物里找不到文件（build 不复制资源）；运行时 readFile +
 * `import.meta.url` 相对定位则天然双栖：src/search 与 dist/search 目录层级
 * 完全同构（backend/<src|dist>/search → ../../resources = backend/resources），
 * vitest（src 直跑）与 dist 部署都命中；再按 process.cwd 兜底两个候选路径。
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BusinessError } from "../errors.js";
import type { ProviderHttpClient } from "./providerHttp.js";
import { normalizeVenueForMatch } from "./venueFilter.js";

const SOURCES_URL = "https://api.openalex.org/sources";
/** lookup 首屏取多少个 source 参与相似判定（防错配判据的输入面） */
const LOOKUP_PER_PAGE = 5;
/** ambiguous 候选上限（人读 / UI 消费） */
const MAX_AMBIGUOUS_CANDIDATES = 3;
/** 包含匹配的短侧最小长度（与 venueFilter.VENUE_CONTAINMENT_MIN_CHARS 同值） */
const CONTAINMENT_MIN_CHARS = 6;

/** 种子表条目（backend/resources/venue-seeds.json） */
export interface VenueSeed {
  /** 稳定 canonical slug（如 "cvpr"；跨版本不变） */
  canonicalId: string;
  displayName: string;
  /** 常见变体（缩写/全称/出版社写法；归一后全等比较） */
  aliases: string[];
  venueType: "conference" | "journal";
  /**
   * OpenAlex source id（"S<digits>"）。只收录高置信真实 id——不确定就省略，
   * 错误 id 会在上游服务端过滤里静默捞错 venue（宁缺勿错）。
   */
  openalexSourceId?: string;
  notes?: string;
}

export interface VenueSeedsFile {
  schemaVersion: 1;
  seeds: VenueSeed[];
}

/** 判别联合 resolution 结果（可序列化；UI / API / discovery 直接消费） */
export type VenueResolution =
  | {
      status: "resolved";
      /** 原始输入（审计） */
      input: string;
      /** 种子命中时的 canonical slug；openalex_lookup 命中时缺省 */
      canonicalId?: string;
      displayName: string;
      /** 存在时可直接作为 SearchOptions.venueSourceIds（OpenAlex 服务端过滤） */
      openalexSourceId?: string;
      venueType?: "conference" | "journal";
      origin: "seed" | "openalex_lookup";
      /**
       * 客户端 venueNames 过滤的推荐名集（displayName + 种子 aliases + 原始
       * 输入，去重）——短缩写（如 "CVPR"）单独做包含匹配不可靠（见
       * venueFilter 长度门），多带全称可提高其它 provider 的召回。
       */
      matchNames: string[];
    }
  | {
      status: "ambiguous";
      input: string;
      candidates: Array<{
        displayName: string;
        openalexSourceId?: string;
        provenance: "seed" | "openalex_lookup";
      }>;
      note: string;
    }
  | {
      status: "not_found";
      input: string;
      reason: string;
    };

/** 归一化别名 → 种子索引（惰性构建一次） */
type SeedIndex = Map<string, VenueSeed[]>;

export interface VenueResolutionServiceOptions {
  http: ProviderHttpClient;
  /** 礼貌池标识（可选，与 openalexProvider 同源约定） */
  mailto?: string;
  /** 显式注入种子（测试用；缺省从 resources/venue-seeds.json 加载） */
  seeds?: VenueSeed[];
  userAgent?: string;
}

export class VenueResolutionService {
  readonly name = "venue-resolution";
  private readonly http: ProviderHttpClient;
  private readonly mailto?: string;
  private readonly userAgent: string;
  private readonly seedsPromise: Promise<VenueSeed[]>;
  private seedIndex: SeedIndex | null = null;
  /** 归一化输入 → resolution（per 实例缓存，含 not_found/ambiguous） */
  private readonly cache = new Map<string, VenueResolution>();

  constructor(options: VenueResolutionServiceOptions) {
    this.http = options.http;
    this.mailto = options.mailto;
    this.userAgent = options.userAgent ?? "PaperTeam/0.1 (venue resolution)";
    this.seedsPromise =
      options.seeds !== undefined
        ? Promise.resolve(validateSeeds(options.seeds))
        : loadVenueSeeds();
  }

  /** 种子数（诊断 / 测试） */
  async seedCount(): Promise<number> {
    return (await this.seedsPromise).length;
  }

  async resolve(input: string): Promise<VenueResolution> {
    const raw = input.trim();
    if (raw === "") {
      return { status: "not_found", input, reason: "空 venue 输入" };
    }
    const key = normalizeVenueForMatch(raw);
    if (key === "") {
      return { status: "not_found", input, reason: "venue 输入归一化后为空（仅标点/空白）" };
    }
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      return cached;
    }
    const resolution = await this.resolveUncached(raw, key);
    this.cache.set(key, resolution);
    return resolution;
  }

  private async resolveUncached(raw: string, key: string): Promise<VenueResolution> {
    // 1) 种子表精确命中（归一化全等；多 canonicalId 命中 = ambiguous）
    if (this.seedIndex === null) {
      this.seedIndex = buildSeedIndex(await this.seedsPromise);
    }
    const seedHits = this.seedIndex.get(key) ?? [];
    const distinctCanonical = new Set(seedHits.map((seed) => seed.canonicalId));
    if (distinctCanonical.size > 1) {
      return {
        status: "ambiguous",
        input: raw,
        candidates: seedHits
          .map((seed) => ({
            displayName: seed.displayName,
            ...(seed.openalexSourceId !== undefined ? { openalexSourceId: seed.openalexSourceId } : {}),
            provenance: "seed" as const,
          }))
          .slice(0, MAX_AMBIGUOUS_CANDIDATES),
        note: `种子表有 ${distinctCanonical.size} 个 canonical venue 命中同一别名（数据歧义，需作者裁决）`,
      };
    }
    if (seedHits.length > 0) {
      const seed = seedHits[0]!;
      return {
        status: "resolved",
        input: raw,
        canonicalId: seed.canonicalId,
        displayName: seed.displayName,
        ...(seed.openalexSourceId !== undefined ? { openalexSourceId: seed.openalexSourceId } : {}),
        venueType: seed.venueType,
        origin: "seed",
        matchNames: [...new Set([seed.displayName, ...seed.aliases, raw])],
      };
    }

    // 2) OpenAlex /sources lookup（一次；网络失败照实抛，不折算 not_found）
    const body = await this.http.fetchJson<Record<string, unknown>>(
      { name: this.name },
      this.lookupUrl(raw),
      {
        headers: {
          "User-Agent": this.userAgent,
          Accept: "application/json",
          ...(this.mailto !== undefined ? { "X-User-Agent": `mailto:${this.mailto}` } : {}),
        },
      },
    );
    const results = Array.isArray(body["results"])
      ? (body["results"] as Array<Record<string, unknown>>)
      : [];
    const similar: Array<{ displayName: string; openalexSourceId: string; type?: string }> = [];
    for (const item of results) {
      const displayName = typeof item["display_name"] === "string" ? item["display_name"] : undefined;
      const idRaw = typeof item["id"] === "string" ? item["id"] : undefined;
      if (displayName === undefined || idRaw === undefined) {
        continue;
      }
      const sourceId = idRaw.replace("https://openalex.org/", "");
      if (!/^S\d+$/.test(sourceId)) {
        continue;
      }
      if (isVenueSimilar(key, displayName)) {
        similar.push({ displayName, openalexSourceId: sourceId, type: typeof item["type"] === "string" ? item["type"] : undefined });
      }
    }
    if (similar.length === 0) {
      return {
        status: "not_found",
        input: raw,
        reason:
          results.length === 0
            ? "OpenAlex /sources 无任何结果"
            : `OpenAlex 首屏 ${results.length} 个 source 与查询均不相似（防错配判据：归一化全等或短侧≥${CONTAINMENT_MIN_CHARS}字符包含）——不采纳不相干结果`,
      };
    }
    if (similar.length > 1) {
      return {
        status: "ambiguous",
        input: raw,
        candidates: similar
          .map((hit) => ({
            displayName: hit.displayName,
            openalexSourceId: hit.openalexSourceId,
            provenance: "openalex_lookup" as const,
          }))
          .slice(0, MAX_AMBIGUOUS_CANDIDATES),
        note: `OpenAlex 首屏有 ${similar.length} 个不同 source 与查询相似（如会议分 source 收录），需作者裁决`,
      };
    }
    const hit = similar[0]!;
    const venueType = hit.type === "conference" || hit.type === "journal" ? hit.type : undefined;
    return {
      status: "resolved",
      input: raw,
      displayName: hit.displayName,
      openalexSourceId: hit.openalexSourceId,
      ...(venueType !== undefined ? { venueType } : {}),
      origin: "openalex_lookup",
      matchNames: [...new Set([hit.displayName, raw])],
    };
  }

  private lookupUrl(query: string): string {
    const params = new URLSearchParams({ search: query, "per-page": String(LOOKUP_PER_PAGE) });
    if (this.mailto !== undefined) {
      params.set("mailto", this.mailto);
    }
    return `${SOURCES_URL}?${params.toString()}`;
  }
}

/** 防错配相似判据（与 venueFilter.matchesVenueName 的两元素版一致） */
function isVenueSimilar(queryKey: string, candidateName: string): boolean {
  const candidateKey = normalizeVenueForMatch(candidateName);
  if (candidateKey === "") {
    return false;
  }
  if (queryKey === candidateKey) {
    return true;
  }
  const shorter = Math.min(queryKey.length, candidateKey.length);
  return (
    shorter >= CONTAINMENT_MIN_CHARS &&
    (queryKey.includes(candidateKey) || candidateKey.includes(queryKey))
  );
}

function buildSeedIndex(seeds: VenueSeed[]): SeedIndex {
  const index: SeedIndex = new Map();
  for (const seed of seeds) {
    for (const name of [seed.displayName, ...seed.aliases]) {
      const key = normalizeVenueForMatch(name);
      if (key === "") {
        continue;
      }
      const bucket = index.get(key);
      if (bucket === undefined) {
        index.set(key, [seed]);
      } else if (!bucket.includes(seed)) {
        bucket.push(seed);
      }
    }
  }
  return index;
}

// ---- 种子 JSON 加载（src 直跑与 dist 部署双栖；理由见文件头） ----

let seedsFileCache: Promise<VenueSeed[]> | null = null;

export function loadVenueSeeds(): Promise<VenueSeed[]> {
  if (seedsFileCache === null) {
    seedsFileCache = readVenueSeedsFile().catch((error) => {
      seedsFileCache = null; // 失败不粘缓存（下次调用重试）
      throw error;
    });
  }
  return seedsFileCache;
}

function venueSeedPaths(): string[] {
  const moduleDir = dirname(fileURLToPath(import.meta.url));
  return [
    resolve(moduleDir, "..", "..", "resources", "venue-seeds.json"),
    resolve(process.cwd(), "resources", "venue-seeds.json"),
    resolve(process.cwd(), "backend", "resources", "venue-seeds.json"),
  ];
}

async function readVenueSeedsFile(): Promise<VenueSeed[]> {
  let raw: string | null = null;
  let lastTried = "";
  for (const path of venueSeedPaths()) {
    lastTried = path;
    try {
      raw = await readFile(path, "utf8");
      break;
    } catch (error) {
      if ((error as { code?: string }).code !== "ENOENT") {
        throw new BusinessError(
          "INTERNAL_ERROR",
          `venue 种子表读取失败（${path}）：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
  }
  if (raw === null) {
    throw new BusinessError(
      "INTERNAL_ERROR",
      `venue 种子表不存在（尝试过 ${venueSeedPaths().join("; ")}）——backend/resources/venue-seeds.json 应随代码一起部署`,
    );
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new BusinessError("INTERNAL_ERROR", `venue 种子表不是合法 JSON（${lastTried}）`);
  }
  const file = parsed as VenueSeedsFile;
  if (file.schemaVersion !== 1 || !Array.isArray(file.seeds)) {
    throw new BusinessError("INTERNAL_ERROR", `venue 种子表 schema 不符（${lastTried}；期望 schemaVersion=1 + seeds[]）`);
  }
  return validateSeeds(file.seeds);
}

/** schema 自洽校验（canonicalId slug / aliases 非空 / venueType 枚举 / id 形态） */
function validateSeeds(seeds: VenueSeed[]): VenueSeed[] {
  const seenCanonical = new Set<string>();
  for (const seed of seeds) {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(seed.canonicalId)) {
      throw new BusinessError("INTERNAL_ERROR", `venue 种子 canonicalId 非法：${String(seed.canonicalId)}`);
    }
    if (seenCanonical.has(seed.canonicalId)) {
      throw new BusinessError("INTERNAL_ERROR", `venue 种子 canonicalId 重复：${seed.canonicalId}`);
    }
    seenCanonical.add(seed.canonicalId);
    if (typeof seed.displayName !== "string" || seed.displayName.trim() === "") {
      throw new BusinessError("INTERNAL_ERROR", `venue 种子 ${seed.canonicalId} 缺 displayName`);
    }
    if (
      !Array.isArray(seed.aliases) ||
      seed.aliases.some((alias) => typeof alias !== "string" || alias.trim() === "")
    ) {
      throw new BusinessError("INTERNAL_ERROR", `venue 种子 ${seed.canonicalId} aliases 非法（需非空字符串数组）`);
    }
    if (seed.venueType !== "conference" && seed.venueType !== "journal") {
      throw new BusinessError("INTERNAL_ERROR", `venue 种子 ${seed.canonicalId} venueType 非法：${String(seed.venueType)}`);
    }
    if (seed.openalexSourceId !== undefined && !/^S\d+$/.test(seed.openalexSourceId)) {
      throw new BusinessError("INTERNAL_ERROR", `venue 种子 ${seed.canonicalId} openalexSourceId 非法：${String(seed.openalexSourceId)}`);
    }
  }
  return seeds;
}
