/**
 * SoftwareReferenceResolver：软件/模型类引用的真实性核验（确定性，无 LLM）。
 *
 * 背景：Ultralytics YOLO11、PyTorch 这类条目没有正式 research paper，
 * Crossref/OpenAlex/arXiv 未收录是事实——学术库 NOT_FOUND 推不出"引用不存在"。
 * software 类的 authoritative source 是官方 repository / documentation：
 *
 *   Tier 1  GitHub REST API（github.com 条目）——元数据最全（描述 / homepage=官方文档 /
 *           stars / 活跃度）；403/429（未认证限额 60/h，共享出口 IP 常见）降级 Tier 2
 *   Tier 2  repository 页面本身（github.com / gitlab.com 通用）——HTML og:title /
 *           og:description 提供基础元数据；页面 404 才是权威 not_found
 *
 * 语义纪律（与 ScholarlyResolver 一致）：
 * - 查询失败（网络 / 限流 / 超时）→ error → 最终 PROVIDER_ERROR，绝不折叠成 NOT_FOUND；
 * - 仓库存在 + 标题与仓库身份有明显对应 → VERIFIED；仓库存在但标题完全对不上 →
 *   METADATA_MISMATCH（作者可能抄错了链接）；仓库 404 → NOT_FOUND（权威）；
 * - software 不比对年份/作者（书目里的 version/年份是 release 语义，repo 创建时间
 *   不可比——ultralytics 仓库 2022 年创建，YOLO11 是 2024 年的模型）。
 */

import type {
  CanonicalPaperRecord,
  CitationFieldMismatch,
} from "./integrity.js";
import type { RepositoryRef } from "./referenceKinds.js";

/** 软件核验算法版本（独立于 scholarly；变更即让旧 software 记录失效） */
export const SOFTWARE_VERIFICATION_VERSION = 1;

export interface SoftwareResolveQuery {
  title?: string;
  repository: RepositoryRef;
}

export type SoftwareOutcome =
  | { kind: "match"; canonical: CanonicalPaperRecord }
  | { kind: "mismatch"; canonical: CanonicalPaperRecord; mismatches: CitationFieldMismatch[] }
  | { kind: "not_found" }
  | { kind: "error"; note: string };

export interface SoftwareResolverOptions {
  fetchImpl?: typeof fetch;
  timeoutMs?: number;
  log?: (message: string) => void;
}

/** 标题里的通用词（不参与"标题 ↔ 仓库身份"对应判定） */
const GENERIC_TITLE_TOKENS = new Set([
  "software",
  "version",
  "package",
  "library",
  "framework",
  "tool",
  "tools",
  "code",
  "source",
  "online",
  "available",
]);

function compact(text: string): string {
  return text
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, "");
}

/** 标题与仓库身份（owner/repo/描述）是否存在可判定的对应 */
function titleMatchesRepository(title: string | undefined, identity: string): boolean {
  if (title === undefined || title.trim() === "") {
    return true; // 无标题可比对：repository 链接本身就是书目给出的事实
  }
  const haystack = compact(identity);
  if (haystack === "") {
    return false;
  }
  const tokens = title
    .normalize("NFKC")
    .toLowerCase()
    .replace(/[^\p{L}\p{N}]+/gu, " ")
    .split(" ")
    .filter((token) => token.length >= 3 && !GENERIC_TITLE_TOKENS.has(token));
  if (tokens.length === 0) {
    return true;
  }
  return tokens.some((token) => haystack.includes(token));
}

async function fetchText(
  url: string,
  ctx: { fetchImpl: typeof fetch; timeoutMs: number },
  userAgent: string,
  accept: string,
): Promise<{ ok: true; body: string } | { ok: false; reason: string; httpStatus?: number }> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), ctx.timeoutMs);
  try {
    const response = await ctx.fetchImpl(url, {
      signal: controller.signal,
      headers: { "User-Agent": userAgent, Accept: accept },
      redirect: "follow",
    });
    if (!response.ok) {
      return { ok: false, reason: `http-${response.status}`, httpStatus: response.status };
    }
    return { ok: true, body: await response.text() };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { ok: false, reason: message.includes("abort") ? `timeout(${ctx.timeoutMs}ms)` : message };
  } finally {
    clearTimeout(timer);
  }
}

interface GitHubRepoPayload {
  full_name?: string;
  name?: string;
  description?: string | null;
  html_url?: string;
  homepage?: string | null;
  stargazers_count?: number;
  created_at?: string;
  pushed_at?: string;
  owner?: { login?: string };
}

function canonicalFromGitHubApi(payload: GitHubRepoPayload, repository: RepositoryRef, now: string): CanonicalPaperRecord {
  const owner = payload.owner?.login ?? repository.owner;
  const description = payload.description ?? undefined;
  return {
    provider: "github",
    recordId: payload.full_name ?? `${repository.owner}/${repository.repo}`,
    title: payload.name ?? repository.repo,
    authors: [owner],
    ...(payload.created_at !== undefined ? { year: Number(payload.created_at.slice(0, 4)) } : {}),
    url: payload.html_url ?? repository.url,
    ...(description !== undefined && description !== "" ? { abstract: description } : {}),
    software: {
      repositoryUrl: payload.html_url ?? repository.url,
      ...(payload.homepage !== undefined && payload.homepage !== null && payload.homepage !== ""
        ? { homepage: payload.homepage }
        : {}),
      ...(description !== undefined ? { description } : {}),
      ...(typeof payload.stargazers_count === "number" ? { stars: payload.stargazers_count } : {}),
      ...(payload.pushed_at !== undefined ? { pushedAt: payload.pushed_at } : {}),
    },
    retrievedAt: now,
  };
}

/** HTML og:title / og:description / <meta description> 提取（Tier 2 基础元数据） */
function canonicalFromHtml(html: string, repository: RepositoryRef, now: string): CanonicalPaperRecord {
  const meta = (property: string): string | undefined => {
    const pattern = new RegExp(
      `<meta[^>]+(?:property|name)=["']${property}["'][^>]+content=["']([^"']*)["']`,
      "i",
    );
    const match = pattern.exec(html);
    if (match !== null) {
      return decodeHtmlEntities(match[1] ?? "");
    }
    // content 在前、property 在后的属性顺序也接受
    const reversed = new RegExp(
      `<meta[^>]+content=["']([^"']*)["'][^>]+(?:property|name)=["']${property}["']`,
      "i",
    );
    const reversedMatch = reversed.exec(html);
    return reversedMatch !== null ? decodeHtmlEntities(reversedMatch[1] ?? "") : undefined;
  };
  // og:title 形如 "GitHub - ultralytics/ultralytics: Ultralytics YOLO11 …"
  const ogTitle = meta("og:title") ?? meta("description");
  const separator = ogTitle !== undefined ? ogTitle.indexOf(": ") : -1;
  const description =
    separator > 0 ? ogTitle!.slice(separator + 2) : meta("og:description") ?? ogTitle ?? undefined;
  return {
    provider: "github",
    recordId: `${repository.owner}/${repository.repo}`,
    title: repository.repo,
    authors: [repository.owner],
    url: repository.url,
    ...(description !== undefined && description !== "" ? { abstract: description } : {}),
    software: {
      repositoryUrl: repository.url,
      ...(description !== undefined ? { description } : {}),
    },
    retrievedAt: now,
  };
}

function decodeHtmlEntities(text: string): string {
  return text
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&apos;/g, "'");
}

export class SoftwareReferenceResolver {
  private readonly ctx: { fetchImpl: typeof fetch; timeoutMs: number };
  private readonly log: (message: string) => void;
  private readonly cache = new Map<string, SoftwareOutcome>();

  /** telemetry（resolver profiling 用） */
  telemetry = { apiCalls: 0, htmlCalls: 0, cacheHits: 0, notFound: 0, errors: 0 };

  constructor(options: SoftwareResolverOptions = {}) {
    this.ctx = {
      fetchImpl: options.fetchImpl ?? fetch,
      timeoutMs: options.timeoutMs ?? 8_000,
    };
    this.log = options.log ?? (() => {});
  }

  async resolve(query: SoftwareResolveQuery, now: string): Promise<SoftwareOutcome> {
    const cacheKey = `${query.repository.host}:${query.repository.owner}/${query.repository.repo}`;
    const cached = this.cache.get(cacheKey);
    if (cached !== undefined) {
      this.telemetry.cacheHits += 1;
      return this.withFreshTimestamp(cached, now);
    }
    const outcome = await this.resolveUncached(query, now);
    if (this.cache.size >= 64) {
      const oldest = this.cache.keys().next().value;
      if (oldest !== undefined) {
        this.cache.delete(oldest);
      }
    }
    this.cache.set(cacheKey, outcome);
    return outcome;
  }

  /** 缓存命中也要如实反映本次检索时间 */
  private withFreshTimestamp(outcome: SoftwareOutcome, now: string): SoftwareOutcome {
    if (outcome.kind === "match" || outcome.kind === "mismatch") {
      return { ...outcome, canonical: { ...outcome.canonical, retrievedAt: now } };
    }
    return outcome;
  }

  private async resolveUncached(query: SoftwareResolveQuery, now: string): Promise<SoftwareOutcome> {
    const { repository } = query;
    const repoPath = `${repository.owner}/${repository.repo}`;

    if (repository.host === "github.com") {
      this.telemetry.apiCalls += 1;
      const api = await fetchText(
        `https://api.github.com/repos/${repoPath}`,
        this.ctx,
        "PaperTeam/0.1 (software reference verification)",
        "application/vnd.github+json",
      );
      if (api.ok) {
        let payload: GitHubRepoPayload;
        try {
          payload = JSON.parse(api.body) as GitHubRepoPayload;
        } catch {
          return { kind: "error", note: "github api 返回非法 JSON" };
        }
        if (payload.full_name === undefined) {
          return { kind: "error", note: "github api 响应缺少 full_name" };
        }
        return this.verdictFor(query, canonicalFromGitHubApi(payload, repository, now), `github-api:${repoPath}`);
      }
      if (api.httpStatus === 404) {
        this.telemetry.notFound += 1;
        return { kind: "not_found" };
      }
      // 403/429（未认证限额）等：API 不可用不是"仓库不存在"，降级 HTML 存在性核验
      this.log(`[software] github api 不可用（${api.reason}），降级页面核验 ${repoPath}`);
    }

    this.telemetry.htmlCalls += 1;
    const page = await fetchText(
      repository.url,
      this.ctx,
      "PaperTeam/0.1 (software reference verification)",
      "text/html",
    );
    if (page.ok) {
      return this.verdictFor(query, canonicalFromHtml(page.body, repository, now), `github-page:${repoPath}`);
    }
    if (page.httpStatus === 404) {
      this.telemetry.notFound += 1;
      return { kind: "not_found" };
    }
    this.telemetry.errors += 1;
    return {
      kind: "error",
      note: `软件权威源查询失败（${repository.url}）：${page.reason}`,
    };
  }

  /** 仓库存在 → 标题对应判定（VERIFIED / METADATA_MISMATCH） */
  private verdictFor(
    query: SoftwareResolveQuery,
    canonical: CanonicalPaperRecord,
    source: string,
  ): SoftwareOutcome {
    const software = canonical.software;
    const identity = [
      canonical.recordId,
      software?.description ?? "",
    ].join(" ");
    if (!titleMatchesRepository(query.title, identity)) {
      const mismatches: CitationFieldMismatch[] = [
        {
          field: "title",
          ...(query.title !== undefined ? { expected: query.title } : {}),
          ...(canonical.title !== undefined ? { actual: `${canonical.title}（${canonical.recordId}）` } : {}),
          note: `repository 存在（${source}）但与标题对不上——请核对链接是否抄错`,
        },
      ];
      return { kind: "mismatch", canonical, mismatches };
    }
    return { kind: "match", canonical };
  }
}
