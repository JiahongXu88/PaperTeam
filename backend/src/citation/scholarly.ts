/**
 * ScholarlyResolver：文献真实性核验（确定性，无 LLM）。
 *
 * 原则：
 * - LLM 不负责决定「文献是否真实存在」——全部由外部学术库回答；
 * - NOT_FOUND ≠ 检索失败：网络/5xx/超时 → error（最终 UNRESOLVED），
 *   只有「检索成功但多源均无匹配」才是 NOT_FOUND；
 * - probable fabrication 需要强证据（≥2 个来源的权威 not_found + 有可查字段）；
 * - DOI exact match 优先级最高；
 * - 所有 canonical record 保留 provenance（provider/recordId/doi/retrievedAt）。
 *
 * Provider 顺序：crossref → openalex → semantic-scholar → arxiv
 * （借鉴 paper-search-mcp 的 provider 集，PaperTeam 自建轻量 connector，
 *  不引入其 Python MCP server——部署成本与 Windows 可靠性不划算）。
 */

import type {
  CanonicalPaperRecord,
  CitationFieldMismatch,
  ScholarlyProvider as ScholarlyProviderName,
} from "./integrity.js";
import { compareFields, sameWork, scoreCandidate } from "./candidateScoring.js";
import { REFERENCE_NORMALIZATION_VERSION, titleQueryVariants } from "./referenceText.js";
import { fingerprintJson } from "../util/hash.js";

export { compareFields } from "./candidateScoring.js";

// ---- 查询与结果 ----

export interface ScholarlyQuery {
  title?: string;
  authors?: string[];
  year?: number;
  doi?: string;
  arxivId?: string;
}

export type LookupOutcome =
  | { kind: "match"; record: CanonicalPaperRecord }
  | { kind: "mismatch"; record: CanonicalPaperRecord; mismatches: CitationFieldMismatch[] }
  | { kind: "ambiguous"; candidates: CanonicalPaperRecord[] }
  | { kind: "not_found" }
  | { kind: "error"; note: string };

export interface ProviderContext {
  fetchImpl: typeof fetch;
  timeoutMs: number;
  contactEmail?: string;
}

export interface ScholarlyProvider {
  readonly name: ScholarlyProviderName;
  lookup(query: ScholarlyQuery, ctx: ProviderContext): Promise<LookupOutcome>;
}

// ---- 共用 HTTP ----

async function fetchJson(
  url: string,
  ctx: ProviderContext,
  userAgent: string,
): Promise<{ ok: true; body: unknown } | { ok: false; reason: string; httpStatus?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
  try {
    const response = await ctx.fetchImpl(url, {
      signal: controller.signal,
      headers: {
        "User-Agent": userAgent,
        Accept: "application/json",
        ...(ctx.contactEmail ? { "X-User-Agent": `mailto:${ctx.contactEmail}` } : {}),
      },
    });
    if (response.status === 404) {
      return { ok: false, reason: "http-404", httpStatus: 404 };
    }
    if (!response.ok) {
      return { ok: false, reason: `http-${response.status}`, httpStatus: response.status };
    }
    return { ok: true, body: (await response.json()) as unknown };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: message.includes("abort") ? `timeout(${ctx.timeoutMs}ms)` : message };
  } finally {
    clearTimeout(timer);
  }
}

/** 搜索候选条数：标题比对严格，多取两条只提升召回不放宽判定 */
const SEARCH_ROWS = 5;

function record(base: Omit<CanonicalPaperRecord, "retrievedAt">, now: string): CanonicalPaperRecord {
  return { ...base, retrievedAt: now };
}

// ---- Crossref ----

export class CrossrefProvider implements ScholarlyProvider {
  readonly name = "crossref" as const;

  async lookup(query: ScholarlyQuery, ctx: ProviderContext): Promise<LookupOutcome> {
    if (query.doi === undefined && query.title === undefined) {
      return { kind: "error", note: "缺少 DOI 与标题，无法查询" };
    }
    const url =
      query.doi !== undefined
        ? `https://api.crossref.org/works/${encodeURIComponent(query.doi)}`
        : `https://api.crossref.org/works?rows=${SEARCH_ROWS}&query.bibliographic=${encodeURIComponent(query.title ?? "")}`;
    const result = await fetchJson(url, ctx, "PaperTeam/0.1 (scholarly verification; mailto:support@paperteam.local)");
    if (!result.ok) {
      return { kind: "error", note: `crossref 查询失败：${result.reason}` };
    }
    const items = extractCrossrefItems(result.body, query.doi !== undefined);
    const now = new Date().toISOString();
    const candidates = items.map((item) => crossrefToRecord(item, now)).filter(hasTitle);
    return pickFromSearch(query, candidates);
  }
}

function extractCrossrefItems(body: unknown, byDoi: boolean): Array<Record<string, unknown>> {
  if (typeof body !== "object" || body === null) {
    return [];
  }
  const message = (body as Record<string, unknown>)["message"];
  if (byDoi) {
    return typeof message === "object" && message !== null ? [message as Record<string, unknown>] : [];
  }
  const items = (message as Record<string, unknown> | undefined)?.["items"];
  return Array.isArray(items) ? (items as Array<Record<string, unknown>>).slice(0, SEARCH_ROWS) : [];
}

function crossrefToRecord(item: Record<string, unknown>, now: string): CanonicalPaperRecord {
  // Crossref 把 "Main: Subtitle" 拆成 title + subtitle 两个字段；拼回完整标题再比对
  const mainTitle = firstString(item["title"]);
  const subtitle = firstString(item["subtitle"]);
  const title =
    mainTitle !== undefined && subtitle !== undefined && subtitle !== "" && !mainTitle.toLowerCase().includes(subtitle.toLowerCase())
      ? `${mainTitle}: ${subtitle}`
      : mainTitle;
  const authors = Array.isArray(item["author"])
    ? (item["author"] as Array<Record<string, unknown>>).map(
        (author) =>
          [author["given"], author["family"]].filter((part) => typeof part === "string").join(" ").trim(),
      )
    : undefined;
  const yearParts = item["issued"];
  const year =
    typeof yearParts === "object" && yearParts !== null && Array.isArray((yearParts as Record<string, unknown>)["date-parts"])
      ? Number(
          ((yearParts as Record<string, unknown>)["date-parts"] as number[][])[0]?.[0] ?? NaN,
        )
      : undefined;
  return record(
    {
      provider: "crossref",
      recordId: typeof item["DOI"] === "string" ? (item["DOI"] as string).toLowerCase() : "",
      ...(title !== undefined && title !== "" ? { title } : {}),
      ...(authors !== undefined && authors.length > 0 ? { authors } : {}),
      ...(Number.isFinite(year) ? { year: year as number } : {}),
      ...(typeof item["container-title"] === "string" ? { venue: item["container-title"] as string } : {}),
      ...(typeof item["DOI"] === "string" ? { doi: (item["DOI"] as string).toLowerCase() } : {}),
      ...(typeof item["URL"] === "string" ? { url: item["URL"] as string } : {}),
      ...(typeof item["abstract"] === "string" ? { abstract: stripXml(item["abstract"] as string) } : {}),
    },
    now,
  );
}

function firstString(value: unknown): string | undefined {
  if (Array.isArray(value)) {
    return typeof value[0] === "string" ? (value[0] as string) : undefined;
  }
  return typeof value === "string" ? value : undefined;
}

function stripXml(text: string): string {
  return text.replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim();
}

function hasTitle(candidate: CanonicalPaperRecord): boolean {
  return candidate.title !== undefined && candidate.title.trim() !== "";
}

// ---- OpenAlex ----

export class OpenAlexProvider implements ScholarlyProvider {
  readonly name = "openalex" as const;

  async lookup(query: ScholarlyQuery, ctx: ProviderContext): Promise<LookupOutcome> {
    if (query.doi === undefined && query.title === undefined) {
      return { kind: "error", note: "缺少 DOI 与标题，无法查询" };
    }
    const url =
      query.doi !== undefined
        ? `https://api.openalex.org/works/https://doi.org/${query.doi}`
        : `https://api.openalex.org/works?search=${encodeURIComponent(query.title ?? "")}&per-page=${SEARCH_ROWS}`;
    const result = await fetchJson(url, ctx, "PaperTeam/0.1 (scholarly verification)");
    if (!result.ok) {
      return { kind: "error", note: `openalex 查询失败：${result.reason}` };
    }
    const now = new Date().toISOString();
    const body = result.body as Record<string, unknown>;
    const items: Array<Record<string, unknown>> = Array.isArray(body["results"])
      ? (body["results"] as Array<Record<string, unknown>>).slice(0, SEARCH_ROWS)
      : typeof body["id"] === "string"
        ? [body]
        : [];
    const candidates = items
      .map((item) => openalexToRecord(item, now))
      .filter(hasTitle);
    return pickFromSearch(query, candidates);
  }
}

function openalexToRecord(item: Record<string, unknown>, now: string): CanonicalPaperRecord {
  const doiRaw = typeof item["doi"] === "string" ? (item["doi"] as string) : undefined;
  const doi = doiRaw?.replace(/^https?:\/\/doi\.org\//i, "").toLowerCase();
  const authors = Array.isArray(item["authorships"])
    ? (item["authorships"] as Array<Record<string, unknown>>).map(
        (authorship) => {
          const author = authorship["author"] as Record<string, unknown> | undefined;
          return typeof author?.["display_name"] === "string" ? (author["display_name"] as string) : "";
        },
      )
    : undefined;
  return record(
    {
      provider: "openalex",
      recordId: typeof item["id"] === "string" ? (item["id"] as string).replace("https://openalex.org/", "") : "",
      ...(typeof item["title"] === "string" && item["title"] !== "" ? { title: item["title"] as string } : {}),
      ...(authors !== undefined && authors.filter((a) => a !== "").length > 0
        ? { authors: authors.filter((a) => a !== "") }
        : {}),
      ...(typeof item["publication_year"] === "number" ? { year: item["publication_year"] as number } : {}),
      ...(typeof item["host_venue"] === "object" && item["host_venue"] !== null
        ? { venue: String((item["host_venue"] as Record<string, unknown>)["display_name"] ?? "") }
        : {}),
      ...(doi !== undefined ? { doi } : {}),
      ...(doiRaw !== undefined ? { url: `https://doi.org/${doi}` } : {}),
      ...(item["abstract_inverted_index"] != null &&
      typeof item["abstract_inverted_index"] === "object"
        ? { abstract: rebuildAbstract(item["abstract_inverted_index"] as Record<string, number[]>) }
        : {}),
    },
    now,
  );
}

/** OpenAlex inverted index → 顺序摘要（null 安全：无摘要的记录该字段为 null） */
function rebuildAbstract(index: Record<string, number[]>): string {
  if (typeof index !== "object" || index === null) {
    return "";
  }
  const slots: Array<{ word: string; position: number }> = [];
  for (const [word, positions] of Object.entries(index)) {
    for (const position of positions ?? []) {
      slots.push({ word, position });
    }
  }
  return slots
    .sort((a, b) => a.position - b.position)
    .map((slot) => slot.word)
    .join(" ")
    .slice(0, 3000);
}

// ---- Semantic Scholar ----

export class SemanticScholarProvider implements ScholarlyProvider {
  readonly name = "semantic-scholar" as const;

  async lookup(query: ScholarlyQuery, ctx: ProviderContext): Promise<LookupOutcome> {
    if (query.doi === undefined && query.title === undefined) {
      return { kind: "error", note: "缺少 DOI 与标题，无法查询" };
    }
    const fields = "title,authors,year,venue,externalIds,abstract";
    const url =
      query.doi !== undefined
        ? `https://api.semanticscholar.org/graph/v1/paper/DOI:${encodeURIComponent(query.doi)}?fields=${fields}`
        : `https://api.semanticscholar.org/graph/v1/paper/search?limit=${SEARCH_ROWS}&fields=${fields}&query=${encodeURIComponent(query.title ?? "")}`;
    const result = await fetchJson(url, ctx, "PaperTeam/0.1 (scholarly verification)");
    if (!result.ok) {
      return { kind: "error", note: `semantic-scholar 查询失败：${result.reason}` };
    }
    const body = result.body as Record<string, unknown>;
    const items: Array<Record<string, unknown>> = Array.isArray(body["data"])
      ? (body["data"] as Array<Record<string, unknown>>).slice(0, SEARCH_ROWS)
      : body["paperId"] !== undefined
        ? [body]
        : [];
    const now = new Date().toISOString();
    const candidates = items
      .map((item) => s2ToRecord(item, now))
      .filter(hasTitle);
    return pickFromSearch(query, candidates);
  }
}

function s2ToRecord(item: Record<string, unknown>, now: string): CanonicalPaperRecord {
  const external = (item["externalIds"] ?? {}) as Record<string, unknown>;
  const doi = typeof external["DOI"] === "string" ? (external["DOI"] as string).toLowerCase() : undefined;
  return record(
    {
      provider: "semantic-scholar",
      recordId: typeof item["paperId"] === "string" ? (item["paperId"] as string) : "",
      ...(typeof item["title"] === "string" ? { title: item["title"] as string } : {}),
      ...(Array.isArray(item["authors"])
        ? {
            authors: (item["authors"] as Array<Record<string, unknown>>)
              .map((author) => String(author["name"] ?? ""))
              .filter((name) => name !== ""),
          }
        : {}),
      ...(typeof item["year"] === "number" ? { year: item["year"] as number } : {}),
      ...(typeof item["venue"] === "string" && item["venue"] !== "" ? { venue: item["venue"] as string } : {}),
      ...(doi !== undefined ? { doi } : {}),
      ...(typeof external["ArXiv"] === "string" ? { arxivId: external["ArXiv"] as string } : {}),
      ...(typeof item["abstract"] === "string" ? { abstract: item["abstract"] as string } : {}),
    },
    now,
  );
}

// ---- arXiv ----

export class ArxivLookupProvider implements ScholarlyProvider {
  readonly name = "arxiv" as const;

  async lookup(query: ScholarlyQuery, ctx: ProviderContext): Promise<LookupOutcome> {
    if (query.arxivId === undefined && query.title === undefined) {
      return { kind: "error", note: "缺少 arXiv id 与标题，无法查询" };
    }
    const term = query.arxivId !== undefined ? `id:${query.arxivId}` : `ti:"${query.title}"`;
    const url = `https://export.arxiv.org/api/query?max_results=${SEARCH_ROWS}&search_query=${encodeURIComponent(term)}`;
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
    try {
      const response = await ctx.fetchImpl(url, {
        signal: controller.signal,
        headers: { "User-Agent": "PaperTeam/0.1 (scholarly verification)" },
      });
      if (!response.ok) {
        return { kind: "error", note: `arxiv 查询失败：http-${response.status}` };
      }
      const xml = await response.text();
      const now = new Date().toISOString();
      const candidates: CanonicalPaperRecord[] = [];
      for (const block of [...xml.matchAll(/<entry>([\s\S]*?)<\/entry>/g)].map((m) => m[1] ?? "")) {
        const title = decodeXml(/<title>([\s\S]*?)<\/title>/.exec(block)?.[1] ?? "");
        const idMatch = /<id>http:\/\/arxiv\.org\/abs\/([^<\s]+)<\/id>/.exec(block);
        const summary = decodeXml(/<summary>([\s\S]*?)<\/summary>/.exec(block)?.[1] ?? "");
        if (title !== "") {
          candidates.push(
            record(
              {
                provider: "arxiv",
                recordId: idMatch?.[1] ?? "",
                title,
                ...(idMatch?.[1] !== undefined ? { arxivId: idMatch[1].replace(/v\d+$/, "") } : {}),
                ...(summary !== "" ? { abstract: summary.slice(0, 3000) } : {}),
                ...(query.year !== undefined ? { year: query.year } : {}),
              },
              now,
            ),
          );
        }
      }
      return pickFromSearch(query, candidates);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return { kind: "error", note: `arxiv 查询失败：${message}` };
    } finally {
      clearTimeout(timer);
    }
  }
}

function decodeXml(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&amp;/g, "&")
    .replace(/\s+/g, " ")
    .trim();
}

// ---- 候选裁决（搜索路径共享） ----

/**
 * 搜索候选裁决（确定性打分，见 candidateScoring.ts）：
 * 1. DOI 精确命中优先；
 * 2. 标题 strong / medium tier 之外的候选一律拒绝（不硬凑相近结果）；
 * 3. 接受的候选按 年份精确 > 第一作者 > 正式 DOI 排序；
 * 4. 剩余多条若互为同一作品的多版本（预印本 / 正式发表 / 多库收录）→ 取代表记录；
 * 5. 真正不同的作品并存 → ambiguous，不猜。
 */
export function pickFromSearch(query: ScholarlyQuery, candidates: CanonicalPaperRecord[]): LookupOutcome {
  if (candidates.length === 0) {
    return { kind: "not_found" };
  }
  const scored = candidates.map((candidate) => scoreCandidate(query, candidate));
  const byDoi = scored.find((entry) => entry.tier === "doi");
  if (byDoi !== undefined) {
    return verdictFor(query, byDoi.candidate);
  }
  const accepted = scored
    .filter((entry) => entry.tier === "strong" || entry.tier === "medium")
    .sort((a, b) => b.rank - a.rank);
  if (accepted.length === 0) {
    // 搜索结果都与草稿标题不符 → 该来源没有此文
    return { kind: "not_found" };
  }
  const best = accepted[0]!;
  const rivals = accepted.slice(1).filter((entry) => !sameWork(best.candidate, entry.candidate));
  if (rivals.length > 0) {
    return { kind: "ambiguous", candidates: [best, ...rivals].slice(0, 3).map((entry) => entry.candidate) };
  }
  return verdictFor(query, best.candidate);
}

function verdictFor(query: ScholarlyQuery, chosen: CanonicalPaperRecord): LookupOutcome {
  const mismatches = compareFields(query, chosen);
  return mismatches.length > 0 ? { kind: "mismatch", record: chosen, mismatches } : { kind: "match", record: chosen };
}

// ---- Query plan ----

export interface QueryStep {
  kind: "doi" | "title" | "arxiv";
  /** 诊断标签（进入 attempt note） */
  label: string;
  query: ScholarlyQuery;
}

/** 单条文献的 query plan 上限（每 provider）：DOI + 最多 3 个标题 variant */
const MAX_TITLE_VARIANTS = 3;

/**
 * 有界 query plan：
 *   1. DOI（有则先精确查；404/error 或未命中再退回标题——DOI 抄错不该让真实文献 NOT_FOUND）；
 *   2. 标题 variants（referenceText.titleQueryVariants：断词拼合 > 保留连字符 > 原文），
 *      每个 variant 都带原始 authors/year/arxivId 供候选打分。
 */
export function buildQueryPlan(query: ScholarlyQuery): QueryStep[] {
  const steps: QueryStep[] = [];
  const shared = {
    ...(query.authors !== undefined ? { authors: query.authors } : {}),
    ...(query.year !== undefined ? { year: query.year } : {}),
    ...(query.arxivId !== undefined ? { arxivId: query.arxivId } : {}),
  };
  if (query.doi !== undefined) {
    steps.push({
      kind: "doi",
      label: `doi:${query.doi}`,
      query: { doi: query.doi, ...shared, ...(query.title !== undefined ? { title: query.title } : {}) },
    });
  }
  if (query.title !== undefined) {
    const variants = titleQueryVariants(query.title).slice(0, MAX_TITLE_VARIANTS);
    for (const [index, variant] of variants.entries()) {
      steps.push({
        kind: "title",
        label: variants.length > 1 ? `title#${index + 1}:${variant}` : `title:${variant}`,
        query: { title: variant, ...shared },
      });
    }
  } else if (query.arxivId !== undefined && query.doi === undefined) {
    steps.push({ kind: "arxiv", label: `arxiv:${query.arxivId}`, query: { arxivId: query.arxivId, ...shared } });
  }
  return steps;
}

/**
 * 核验算法版本：归一化 / 打分 / query plan / 核验分派（software 路径、PROVIDER_ERROR
 * 语义）任一变化就递增，纳入 metadata 记录与 cache fingerprint——旧 NOT_FOUND 结果
 * 自动失效，无需用户删 workspace。
 *   v3：+ software kind 核验（SoftwareReferenceResolver）+ PROVIDER_ERROR 结论分离
 */
export const METADATA_VERIFICATION_VERSION = `v3.n${REFERENCE_NORMALIZATION_VERSION}`;

// ---- Resolver（编排 + 缓存 + 语义裁决） ----

export interface ScholarlyResolverOptions {
  providers?: ScholarlyProvider[];
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  contactEmail?: string;
  /** 相邻 provider 调用之间的礼貌间隔（默认 0；live 用 100ms） */
  politenessDelayMs?: number;
  log?: (message: string) => void;
}

/** Resolver 级裁决结果（供 CitationIntegrityService 组装 record） */
export interface ResolverVerdict {
  outcome: "match" | "mismatch" | "ambiguous" | "not_found" | "unresolved";
  canonical?: CanonicalPaperRecord;
  mismatches?: CitationFieldMismatch[];
  candidates?: CanonicalPaperRecord[];
  attempts: Array<{ provider: string; outcome: string; note?: string }>;
  cacheHits: number;
}

export class ScholarlyResolver {
  private readonly providers: ScholarlyProvider[];
  private readonly ctx: ProviderContext;
  private readonly delayMs: number;
  private readonly log: (message: string) => void;
  /** 查询级缓存（key = provider+query 指纹） */
  private readonly cache = new Map<string, LookupOutcome>();
  readonly cacheSize = 200;

  /** telemetry（外部读取；回答“这次核验花了多少外部调用”） */
  telemetry = { providerCalls: 0, cacheHits: 0, retries: 0 };
  /** 按 provider 的调用画像（性能诊断用；随 providerCalls 同步累积） */
  readonly byProvider = new Map<
    ScholarlyProviderName,
    { calls: number; notFound: number; errors: number; cacheHits: number; totalMs: number }
  >();

  private providerStat(name: ScholarlyProviderName) {
    let stat = this.byProvider.get(name);
    if (stat === undefined) {
      stat = { calls: 0, notFound: 0, errors: 0, cacheHits: 0, totalMs: 0 };
      this.byProvider.set(name, stat);
    }
    return stat;
  }

  constructor(options: ScholarlyResolverOptions = {}) {
    this.providers = options.providers ?? [
      new CrossrefProvider(),
      new OpenAlexProvider(),
      new SemanticScholarProvider(),
      new ArxivLookupProvider(),
    ];
    this.ctx = {
      fetchImpl: options.fetchImpl ?? fetch,
      timeoutMs: options.timeoutMs ?? 8_000,
      ...(options.contactEmail !== undefined ? { contactEmail: options.contactEmail } : {}),
    };
    this.delayMs = options.politenessDelayMs ?? 0;
    this.log = options.log ?? (() => {});
  }

  /**
   * 多源顺序核验：match/mismatch 即定；≥2 来源权威 not_found → not_found；否则 unresolved。
   *
   * 每个 provider 走一条有界 query plan（见 buildQueryPlan）：DOI 精确查询 →
   * 标题 query variants（断词拼合 / 保留连字符 / 原文）。某一步 not_found 才试下一步；
   * error 立即停止该 provider（限流时不再加压），不把失败折叠成 not_found。
   * 字段比对始终以原始 reference 字段为准（variant 只用于检索）。
   */
  async resolve(query: ScholarlyQuery): Promise<ResolverVerdict> {
    const attempts: ResolverVerdict["attempts"] = [];
    let notFoundCount = 0;
    let firstAmbiguous: CanonicalPaperRecord[] | undefined;

    const plan = buildQueryPlan(query);
    if (plan.length === 0) {
      return {
        outcome: "unresolved",
        attempts: [{ provider: "none", outcome: "error", note: "无可查字段（无标题/DOI/arXiv）" }],
        cacheHits: 0,
      };
    }

    for (const provider of this.providers) {
      if (this.delayMs > 0 && attempts.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }
      const step = await this.runPlan(provider, plan);
      const outcome = step.outcome;
      switch (outcome.kind) {
        case "match":
        case "mismatch": {
          // variant 命中后按原始字段重新比对（variant 标题只服务检索）
          const mismatches = compareFields(query, outcome.record);
          attempts.push({ provider: provider.name, outcome: mismatches.length > 0 ? "mismatch" : "match", note: step.note });
          return {
            outcome: mismatches.length > 0 ? "mismatch" : "match",
            canonical: outcome.record,
            ...(mismatches.length > 0 ? { mismatches } : {}),
            attempts,
            cacheHits: this.telemetry.cacheHits,
          };
        }
        case "ambiguous":
          attempts.push({ provider: provider.name, outcome: "ambiguous", note: step.note });
          firstAmbiguous ??= outcome.candidates;
          break;
        case "not_found":
          attempts.push({ provider: provider.name, outcome: "not_found", note: step.note });
          notFoundCount += 1;
          break;
        case "error":
          attempts.push({ provider: provider.name, outcome: "error", note: outcome.note });
          break;
      }
    }

    if (notFoundCount >= 2) {
      return { outcome: "not_found", attempts, cacheHits: this.telemetry.cacheHits };
    }
    if (firstAmbiguous !== undefined) {
      return { outcome: "ambiguous", candidates: firstAmbiguous, attempts, cacheHits: this.telemetry.cacheHits };
    }
    return { outcome: "unresolved", attempts, cacheHits: this.telemetry.cacheHits };
  }

  /** 逐步执行 query plan：not_found 继续；match/mismatch/ambiguous/error 停止 */
  private async runPlan(
    provider: ScholarlyProvider,
    plan: QueryStep[],
  ): Promise<{ outcome: LookupOutcome; note: string }> {
    let last: LookupOutcome = { kind: "not_found" };
    const tried: string[] = [];
    for (const [index, step] of plan.entries()) {
      if (this.delayMs > 0 && index > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }
      last = await this.lookupCached(provider, step.query);
      tried.push(step.label);
      if (last.kind === "not_found") {
        continue;
      }
      // DOI 在该库查不到（404）不等于文献不存在：退回标题检索；其它 error（限流/超时）停止
      if (step.kind === "doi" && last.kind === "error" && /http-404/.test(last.note) && index < plan.length - 1) {
        tried[tried.length - 1] = `${step.label}(404)`;
        continue;
      }
      break;
    }
    return { outcome: last, note: `查询：${tried.join(" → ")}` };
  }

  private async lookupCached(provider: ScholarlyProvider, query: ScholarlyQuery): Promise<LookupOutcome> {
    const key = `${provider.name}:${fingerprintJson(query)}`;
    const stat = this.providerStat(provider.name);
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.telemetry.cacheHits += 1;
      stat.cacheHits += 1;
      return cached;
    }
    this.telemetry.providerCalls += 1;
    stat.calls += 1;
    const startedAt = Date.now();
    let outcome = await provider.lookup(query, this.ctx);
    // 单次重试（网络抖动/5xx；重试仍失败如实报 error）
    if (outcome.kind === "error") {
      this.telemetry.retries += 1;
      this.log(`[scholarly] ${provider.name} 失败（${outcome.note}），重试一次`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      outcome = await provider.lookup(query, this.ctx);
    }
    stat.totalMs += Date.now() - startedAt;
    if (outcome.kind === "not_found") {
      stat.notFound += 1;
    } else if (outcome.kind === "error") {
      stat.errors += 1;
    }
    if (this.cache.size >= this.cacheSize) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
    this.cache.set(key, outcome);
    return outcome;
  }

  /** 受控检索（search_papers 工具 / semantic 证据用）：跨 crossref+openalex */
  async search(keywords: string, limit = 5): Promise<CanonicalPaperRecord[]> {
    const results: CanonicalPaperRecord[] = [];
    for (const provider of this.providers.filter((p) => p.name === "crossref" || p.name === "openalex")) {
      const outcome = await this.lookupCached(provider, { title: keywords });
      if (outcome.kind === "match") {
        results.push(outcome.record);
      } else if (outcome.kind === "ambiguous") {
        results.push(...outcome.candidates);
      }
    }
    return results.slice(0, limit);
  }
}
