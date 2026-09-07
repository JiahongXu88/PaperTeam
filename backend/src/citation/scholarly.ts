/**
 * ScholarlyResolver（M4.3.4）：文献真实性核验（确定性，无 LLM）。
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
import { titlesMatch } from "./metadataProviders.js";
import { fingerprintJson } from "../util/hash.js";

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
        : `https://api.crossref.org/works?rows=3&query.bibliographic=${encodeURIComponent(query.title ?? "")}`;
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
  return Array.isArray(items) ? (items as Array<Record<string, unknown>>).slice(0, 3) : [];
}

function crossrefToRecord(item: Record<string, unknown>, now: string): CanonicalPaperRecord {
  const titleRaw = item["title"];
  const title = Array.isArray(titleRaw) ? String(titleRaw[0] ?? "") : typeof titleRaw === "string" ? titleRaw : undefined;
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
        : `https://api.openalex.org/works?search=${encodeURIComponent(query.title ?? "")}&per-page=3`;
    const result = await fetchJson(url, ctx, "PaperTeam/0.1 (scholarly verification)");
    if (!result.ok) {
      return { kind: "error", note: `openalex 查询失败：${result.reason}` };
    }
    const now = new Date().toISOString();
    const body = result.body as Record<string, unknown>;
    const items: Array<Record<string, unknown>> = Array.isArray(body["results"])
      ? (body["results"] as Array<Record<string, unknown>>).slice(0, 3)
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
        : `https://api.semanticscholar.org/graph/v1/paper/search?limit=3&fields=${fields}&query=${encodeURIComponent(query.title ?? "")}`;
    const result = await fetchJson(url, ctx, "PaperTeam/0.1 (scholarly verification)");
    if (!result.ok) {
      return { kind: "error", note: `semantic-scholar 查询失败：${result.reason}` };
    }
    const body = result.body as Record<string, unknown>;
    const items: Array<Record<string, unknown>> = Array.isArray(body["data"])
      ? (body["data"] as Array<Record<string, unknown>>).slice(0, 3)
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
    const url = `https://export.arxiv.org/api/query?max_results=3&search_query=${encodeURIComponent(term)}`;
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
 * 搜索候选裁决（RefWarden 门控思想：标题 + 作者重合 + 年份 ±1）：
 * 1. 标题不匹配的候选一律拒绝（不硬凑相近结果）；
 * 2. DOI 精确命中优先；
 * 3. 年份（±1）与第一作者姓氏门控逐步收窄；
 * 4. 收窄后仍多条但「同年 + 同第一作者」→ 同一作品的多库重复收录，
 *    选带 DOI 的代表记录（不判 ambiguous）；
 * 5. 真正多版本（年份/作者不一致）→ ambiguous，不猜。
 */
function pickFromSearch(query: ScholarlyQuery, candidates: CanonicalPaperRecord[]): LookupOutcome {
  if (candidates.length === 0) {
    return { kind: "not_found" };
  }
  if (query.title !== undefined) {
    const titled = candidates.filter((candidate) => titlesMatch(query.title!, candidate.title!));
    if (titled.length === 0) {
      // 搜索结果都与草稿标题不符 → 该来源没有此文
      return { kind: "not_found" };
    }
    candidates = titled;
  }

  if (query.doi !== undefined) {
    const byDoi = candidates.find((candidate) => candidate.doi === query.doi!.toLowerCase());
    if (byDoi !== undefined) {
      const mismatches = compareFields(query, byDoi);
      return mismatches.length > 0
        ? { kind: "mismatch", record: byDoi, mismatches }
        : { kind: "match", record: byDoi };
    }
  }

  let pool = candidates;
  if (query.year !== undefined) {
    const byYear = pool.filter(
      (candidate) => candidate.year !== undefined && Math.abs(candidate.year - query.year!) <= 1,
    );
    if (byYear.length > 0) {
      pool = byYear;
    }
  }
  if (query.authors !== undefined && query.authors.length > 0) {
    const byAuthor = pool.filter((candidate) => authorsOverlap(query.authors!, candidate.authors));
    if (byAuthor.length > 0) {
      pool = byAuthor;
    }
  }
  if (pool.length > 1) {
    const years = new Set(pool.map((candidate) => candidate.year));
    const sameFirstAuthor = pool.every((candidate) =>
      authorsOverlap([query.authors?.[0] ?? pool[0]!.authors?.[0] ?? ""], candidate.authors),
    );
    if (years.size === 1 && sameFirstAuthor) {
      pool = [pool.find((candidate) => candidate.doi !== undefined) ?? pool[0]!];
    }
  }
  if (pool.length > 1) {
    return { kind: "ambiguous", candidates: pool.slice(0, 3) };
  }
  const chosen = pool[0]!;
  const mismatches = compareFields(query, chosen);
  return mismatches.length > 0
    ? { kind: "mismatch", record: chosen, mismatches }
    : { kind: "match", record: chosen };
}

/** 姓氏候选：PDF 提取常「姓在前」，学术库多「姓在后」——首/末 token 都可能是姓 */
function surnameCandidates(name: string): Set<string> {
  const tokens = name
    .replace(/\./g, "")
    .split(/\s+/)
    .map((token) => token.toLowerCase().replace(/[^a-zà-žüöä'-]/g, ""))
    .filter((token) => token.length > 1);
  if (tokens.length === 0) {
    return new Set();
  }
  return new Set([tokens[0]!, tokens[tokens.length - 1]!]);
}

function authorsOverlap(queryAuthors: string[], candidateAuthors?: string[]): boolean {
  if (candidateAuthors === undefined || candidateAuthors.length === 0) {
    return false;
  }
  for (const queryAuthor of queryAuthors) {
    for (const surname of surnameCandidates(queryAuthor)) {
      if (candidateAuthors.some((candidate) => surnameCandidates(candidate).has(surname))) {
        return true;
      }
    }
  }
  return false;
}

/** DOI 路径：canonical 已由 DOI 定位，只做字段比对 */
export function compareFields(query: ScholarlyQuery, canonical: CanonicalPaperRecord): CitationFieldMismatch[] {
  const mismatches: CitationFieldMismatch[] = [];
  if (
    query.title !== undefined &&
    canonical.title !== undefined &&
    !titlesMatch(query.title, canonical.title)
  ) {
    mismatches.push({ field: "title", expected: query.title, actual: canonical.title });
  }
  if (query.year !== undefined && canonical.year !== undefined) {
    if (Math.abs(query.year - canonical.year) > 1) {
      mismatches.push({ field: "year", expected: String(query.year), actual: String(canonical.year) });
    } else if (query.year !== canonical.year) {
      mismatches.push({
        field: "year",
        expected: String(query.year),
        actual: String(canonical.year),
        note: "年份差 1（arXiv 预印本 vs 正式发表常见），按容忍处理不计 mismatch",
      });
    }
  }
  if (
    query.doi !== undefined &&
    canonical.doi !== undefined &&
    query.doi.toLowerCase() !== canonical.doi
  ) {
    mismatches.push({ field: "doi", expected: query.doi, actual: canonical.doi });
  }
  return mismatches.filter((m) => m.note === undefined);
}

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

  /** 多源顺序核验：match/mismatch 即定；≥2 来源权威 not_found → not_found；否则 unresolved */
  async resolve(query: ScholarlyQuery): Promise<ResolverVerdict> {
    const attempts: ResolverVerdict["attempts"] = [];
    let notFoundCount = 0;
    let firstAmbiguous: CanonicalPaperRecord[] | undefined;
    let lastError: string | undefined;

    if (query.title === undefined && query.doi === undefined && query.arxivId === undefined) {
      return { outcome: "unresolved", attempts: [{ provider: "none", outcome: "error", note: "无可查字段（无标题/DOI/arXiv）" }], cacheHits: 0 };
    }

    for (const provider of this.providers) {
      if (this.delayMs > 0 && attempts.length > 0) {
        await new Promise((resolve) => setTimeout(resolve, this.delayMs));
      }
      const outcome = await this.lookupCached(provider, query);
      switch (outcome.kind) {
        case "match":
          attempts.push({ provider: provider.name, outcome: "match" });
          return { outcome: "match", canonical: outcome.record, attempts, cacheHits: this.telemetry.cacheHits };
        case "mismatch":
          attempts.push({ provider: provider.name, outcome: "mismatch" });
          return {
            outcome: "mismatch",
            canonical: outcome.record,
            mismatches: outcome.mismatches,
            attempts,
            cacheHits: this.telemetry.cacheHits,
          };
        case "ambiguous":
          attempts.push({ provider: provider.name, outcome: "ambiguous" });
          firstAmbiguous ??= outcome.candidates;
          break;
        case "not_found":
          attempts.push({ provider: provider.name, outcome: "not_found" });
          notFoundCount += 1;
          break;
        case "error":
          attempts.push({ provider: provider.name, outcome: "error", note: outcome.note });
          lastError = outcome.note;
          break;
      }
    }

    if (notFoundCount >= 2) {
      return { outcome: "not_found", attempts, cacheHits: this.telemetry.cacheHits };
    }
    if (firstAmbiguous !== undefined) {
      return { outcome: "ambiguous", candidates: firstAmbiguous, attempts, cacheHits: this.telemetry.cacheHits };
    }
    void lastError;
    return { outcome: "unresolved", attempts, cacheHits: this.telemetry.cacheHits };
  }

  private async lookupCached(provider: ScholarlyProvider, query: ScholarlyQuery): Promise<LookupOutcome> {
    const key = `${provider.name}:${fingerprintJson(query)}`;
    const cached = this.cache.get(key);
    if (cached !== undefined) {
      this.telemetry.cacheHits += 1;
      return cached;
    }
    this.telemetry.providerCalls += 1;
    let outcome = await provider.lookup(query, this.ctx);
    // 单次重试（网络抖动/5xx；重试仍失败如实报 error）
    if (outcome.kind === "error") {
      this.telemetry.retries += 1;
      this.log(`[scholarly] ${provider.name} 失败（${outcome.note}），重试一次`);
      await new Promise((resolve) => setTimeout(resolve, 300));
      outcome = await provider.lookup(query, this.ctx);
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
