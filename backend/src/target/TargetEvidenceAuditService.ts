/**
 * TargetEvidenceAuditService（M15.16 · P0-A）：目标面板「证据审计（实验性）」。
 *
 * 把 M15.14/15 已验证的 ContributionAuditService（三阶段贡献审计）接入正式产品：
 * 服务端确定性构建 PriorWorkPool → 调用既有审计（3 次有界模型调用 + 解析重试）→
 * 工件落盘 research/target-contribution-audit.json（与实验工件同形）+ 运行元数据
 * research/target-evidence-audit-meta.json。feature flag 缺省关闭
 * （PAPERTEAM_TARGET_EVIDENCE_AUDIT_ENABLED）——关闭时本服务不装配，旧
 * Review / Target / Gate 路径零改动。
 *
 * Pool 构建三通道（移植 scripts/m1514/build-pool.mjs 并生产化）：
 *   A 稿件自引：ReferenceExtractor → ScholarlyResolver（Crossref/OpenAlex；
 *     缓存 + 礼貌间隔 + telemetry 由 resolver 内建）逐条解析；
 *   B 外部检索：AcademicSearchService（题名/摘要拉丁词 top-8；中文稿无拉丁
 *     关键词时如实跳过并记录——M15.15 结论：空查询构造是跨语言检索根因）；
 *   C 在库全文升级：pool 候选 × SourceStore 身份匹配（DOI > arXiv > 标题
 *     compact 指纹）→ ChunkStore 确定性方法节摘录 → verified_fulltext 级。
 *
 * 纪律：
 * - 只读：不 import 新 source、不写 EvidenceStore、不触碰 benchmark
 *   sourceRole=reference 的证据链隔离（读 chunk 只作 advisory 审计材料）；
 * - 全文升级只认已在库的合法全文；无匹配 → abstract/metadata 如实降级；
 * - 防陈旧：GET 重算当前稿 sha256 + revision 与工件 inputFingerprint 对比，
 *   不一致 → stale 标记（不重建 pool、零网络）；
 * - 时间因果：cutoff = 评估日（novelty 以当前时点衡量）；年份晚于 cutoff
 *   的候选在构建期即排除，模型引用侧仍由 ContributionAuditService 守卫兜底。
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { BusinessError } from "../errors.js";
import type { AgentRuntime } from "../runtime/types.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { PaperStore } from "../paper/PaperStore.js";
import type { PaperDocument } from "../paper/types.js";
import { ReferenceExtractor } from "../paper/ReferenceExtractor.js";
import type { AcademicSearchService } from "../search/academicSearchService.js";
import type { ScholarlyResolver } from "../citation/scholarly.js";
import type { SourceItem } from "../sources/SourceStore.js";
import { compactTitle } from "../citation/referenceText.js";
import { arxivIdFromDoi, normalizeArxivId, normalizeDoi } from "../sources/identity.js";
import type { SourceChunk } from "../retrieval/types.js";
import { writeJsonAtomic } from "../util/atomic.js";
import { sha256Hex } from "../util/hash.js";
import {
  ContributionAuditService,
  type ContributionAuditArtifact,
  type ContributionAuditTelemetry,
  type PriorWorkCandidate,
  type PriorWorkPool,
  titleFingerprint,
} from "./ContributionAuditService.js";

/** pool 规模预算（与 M15.14 冻结口径一致） */
export const EVIDENCE_AUDIT_POOL_CAP = 12;
export const EVIDENCE_AUDIT_MAX_REFS = 20;
/** verified_fulltext 摘录预算（M15.15 口径：≤3 段、共 ≤6000 字符） */
export const EXCERPT_MAX_COUNT = 3;
export const EXCERPT_TOTAL_MAX_CHARS = 6_000;
export const EXCERPT_SINGLE_MAX_CHARS = 3_000;

// ---- 纯函数（导出供测试） ----

/** M15.14 同源停用词（外部检索词构建；中文稿无拉丁词 → 通道 B 如实跳过） */
const STOPWORDS = new Set(
  ("a an the and or of for in on to with via using based we our this that these those is are be as at by from into over under new novel propose proposed method methods model models approach approaches paper study work results result experiments experiment show shows shown showing demonstrate demonstrates demonstrated outperform outperforms outperformed state-of-the-art sota can could would should may might must not no any all each both few more most other some such only own same so than too very just also then once here there when where why how what which who whom whose does did doing done has have had having been being was were will shall about against between during before after above below up down out off again further because until while known well good better best large small high low use used uses one two three first second third general simple effective efficient significant significantly various different similar important key main propose present presented introduce introduced consider considered based called named given let et al".split(
    " ",
  )),
);

/** 题名+摘要拉丁词频 top-K（检索 query 用；CJK 词不进 query——空查询根因纪律） */
export function latinQueryTerms(title: string, abstract: string): string[] {
  const counts = new Map<string, number>();
  const feed = `${title} ${abstract}`.toLowerCase();
  for (const token of feed.match(/[a-z][a-z0-9-]{3,}/g) ?? []) {
    if (token.length < 4 || STOPWORDS.has(token)) continue;
    counts.set(token, (counts.get(token) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
    .slice(0, 8)
    .map(([term]) => term);
}

/**
 * 方法相关摘录（M15.15 c-prep pickExcerpts 的 SourceChunk 移植）：
 * 标题方法相关性 + 技术词密度确定性打分；References 节排除；≤3 段 / ≤6000 字符。
 */
export function pickMethodExcerpts(chunks: readonly SourceChunk[]): string[] {
  const scored = chunks.map((chunk) => {
    const sectionTitle = chunk.sectionTitle ?? "";
    if (/reference|bibliograph/i.test(sectionTitle)) {
      return { chunk, score: -1 };
    }
    const methodish = /method|approach|architect|propos|algorithm|model|framework|track|associat|metric|formulat|binariz|detect|segment|feature|network|train/i.test(
      sectionTitle,
    );
    const dense = (
      chunk.text.match(
        /\b(Kalman|Hungarian|association|query|regression|binariz|segmentation|embedding|matching|detection|tracking|score|confidence|formula|metric|loss|attention|feature|backbone|encoder|decoder|threshold|dataset|baseline|ablation)\b/gi,
      ) ?? []
    ).length;
    return { chunk, score: (methodish ? 40 : 0) + dense };
  });
  scored.sort((a, b) => b.score - a.score || a.chunk.ordinal - b.chunk.ordinal);
  const excerpts: string[] = [];
  let used = 0;
  for (const { chunk, score } of scored) {
    if (score <= 0 || used >= EXCERPT_TOTAL_MAX_CHARS || excerpts.length >= EXCERPT_MAX_COUNT) {
      break;
    }
    const header = `[${chunk.sectionTitle || "body"}${chunk.pageStart !== undefined ? `; p.${chunk.pageStart}` : ""}] `;
    const text = `${header}${chunk.text}`.slice(0, EXCERPT_SINGLE_MAX_CHARS);
    excerpts.push(text);
    used += text.length;
  }
  return excerpts;
}

/** 在库 source ↔ pool 候选身份匹配（DOI > arXiv > compact 标题指纹） */
export function librarySourceMatches(
  candidate: { title: string; year?: number; doi?: string; arxivId?: string },
  source: SourceItem,
): boolean {
  const identity = source.identity;
  if (identity === undefined) {
    return false;
  }
  const doi = candidate.doi !== undefined ? normalizeDoi(candidate.doi) : undefined;
  if (doi !== undefined && identity.doi === doi) {
    return true;
  }
  const arxiv =
    candidate.arxivId !== undefined
      ? normalizeArxivId(candidate.arxivId)
      : doi !== undefined
        ? arxivIdFromDoi(doi)
        : undefined;
  if (arxiv !== undefined && identity.arxivId === arxiv) {
    return true;
  }
  const fingerprint = compactTitle(candidate.title);
  if (fingerprint !== "" && identity.normalizedTitleFingerprint === fingerprint) {
    return candidate.year === undefined || identity.year === undefined || candidate.year === identity.year;
  }
  return false;
}

// ---- Pool 构建 ----

export interface PoolBuildDeps {
  scholarly: Pick<ScholarlyResolver, "resolve">;
  academic: Pick<AcademicSearchService, "search">;
  librarySources: readonly SourceItem[];
  readSourceChunks: (projectId: string, sourceId: string) => Promise<readonly SourceChunk[] | null>;
  signal?: AbortSignal;
}

export interface EvidenceAuditPoolBuildStats {
  cutoffDate: string;
  referenceEntriesTotal: number;
  referenceEntriesEligible: number;
  refResolved: number;
  refUnresolved: number;
  refLookupErrors: number;
  externalQuery: string | null;
  externalRetrieved: number;
  libraryCandidates: number;
  libraryUpgraded: number;
  dedupedCandidates: number;
  selfExcluded: number;
  poolCap: number;
  contentLevels: { abstract: number; metadata: number; verified_fulltext: number };
  buildNotes: string[];
  extractorNotes: string[];
}

interface PoolWork {
  title: string;
  year?: number;
  venue?: string;
  doi?: string;
  arxivId?: string;
  authors?: string;
  abstract?: string;
  citedByManuscript: boolean;
  source: string;
}

const CONTENT_LEVEL_RANK: Record<PriorWorkCandidate["contentLevel"], number> = {
  verified_fulltext: 0,
  abstract: 1,
  metadata: 2,
};

/**
 * 确定性构建 PriorWorkPool（网络访问仅限注入的 scholarly/academic 依赖；
 * 全部失败/跳过如实记入 buildNotes——缺料语义由审计侧 INSUFFICIENT_EVIDENCE 承担）。
 */
export async function buildPriorWorkPool(
  document: PaperDocument,
  cutoffDate: string,
  deps: PoolBuildDeps,
): Promise<{ pool: PriorWorkPool; stats: EvidenceAuditPoolBuildStats }> {
  const cutoffYear = Number.parseInt(cutoffDate.slice(0, 4), 10);
  const buildNotes: string[] = [];
  const queriesUsed: string[] = [];
  const retrieved: PoolWork[] = [];

  // ---- 通道 A：稿件自引（题名/DOI 解析链） ----
  const extraction = new ReferenceExtractor().extract(document);
  const isJunkTitle = (title: string): boolean =>
    /^https?:|^www\.|accessed:/i.test(title) || title.split(/\s+/).length < 3;
  const refEntries = extraction.references
    .filter(
      (ref) =>
        ref.title !== undefined &&
        ref.title.length > 8 &&
        !isJunkTitle(ref.title) &&
        (ref.year ?? cutoffYear) <= cutoffYear,
    )
    .sort((a, b) => (b.year ?? 0) - (a.year ?? 0) || String(a.title).localeCompare(String(b.title)))
    .slice(0, EVIDENCE_AUDIT_MAX_REFS);
  let refResolved = 0;
  let refUnresolved = 0;
  let refLookupErrors = 0;
  for (const ref of refEntries) {
    const title = ref.title ?? "";
    queriesUsed.push(`resolve:${title.slice(0, 80)}`);
    const verdict = await deps.scholarly.resolve(
      {
        ...(ref.doi !== undefined ? { doi: ref.doi } : {}),
        ...(ref.arxivId !== undefined ? { arxivId: ref.arxivId } : {}),
        ...(title !== "" ? { title } : {}),
        ...(ref.year !== undefined ? { year: ref.year } : {}),
      },
      { signal: deps.signal },
    );
    const canonical =
      verdict.outcome === "match" || verdict.outcome === "mismatch" ? verdict.canonical : undefined;
    if (canonical !== undefined) {
      refResolved += 1;
      const authors = canonical.authors?.slice(0, 3).filter((name) => name !== "").join(", ");
      retrieved.push({
        title: canonical.title ?? title,
        year: canonical.year ?? ref.year,
        venue: canonical.venue ?? ref.venue,
        doi: canonical.doi ?? ref.doi,
        arxivId: canonical.arxivId ?? ref.arxivId,
        ...(authors !== undefined && authors !== "" ? { authors } : {}),
        abstract: canonical.abstract,
        citedByManuscript: true,
        source: `${canonical.provider}:${canonical.recordId}`,
      });
      continue;
    }
    if (verdict.outcome === "not_found" || verdict.outcome === "ambiguous") {
      refUnresolved += 1;
    } else {
      refLookupErrors += 1;
      buildNotes.push(`resolve-error(${verdict.outcome}):${title.slice(0, 50)}`);
    }
    // 解析失败但条目本身有题名 → metadata 级入 pool（作者已认定相关，不猜字段）
    retrieved.push({
      title,
      year: ref.year,
      venue: ref.venue,
      doi: ref.doi,
      arxivId: ref.arxivId,
      citedByManuscript: true,
      source: "reference-list(unresolved)",
    });
  }

  // ---- 通道 B：外部检索（拉丁词为空 → 如实跳过，不造空查询） ----
  const terms = latinQueryTerms(document.title ?? "", document.abstract ?? "");
  let externalRetrieved = 0;
  if (terms.length === 0) {
    buildNotes.push("external-search-skipped(no-latin-terms)：稿件题名/摘要无拉丁关键词（中文稿常见），外部检索通道跳过——以参考文献通道为主");
  } else {
    const query = terms.join(" ");
    queriesUsed.push(`academic-search:${query}`);
    try {
      const response = await deps.academic.search(query, {
        limit: 10,
        yearTo: cutoffYear,
        ...(deps.signal !== undefined ? { signal: deps.signal } : {}),
      });
      externalRetrieved = response.results.length;
      for (const result of response.results) {
        const record = result.record;
        if (record.title === undefined || record.title === "") {
          continue;
        }
        const authors = record.authors?.slice(0, 3).filter((name) => name !== "").join(", ");
        retrieved.push({
          title: record.title,
          year: record.year,
          venue: record.venue,
          doi: record.doi,
          arxivId: record.arxivId,
          ...(authors !== undefined && authors !== "" ? { authors } : {}),
          abstract: record.abstract,
          citedByManuscript: false,
          source: result.sources.map((entry) => entry.provider).join("+") || "academic-search",
        });
      }
    } catch (error) {
      buildNotes.push(
        `external-search-failed(${error instanceof BusinessError ? error.code : "error"}):${terms.join(" ").slice(0, 60)}`,
      );
    }
  }

  // ---- 去重 + 自排除 + 排名（内容级 → 自引 → year desc → title asc） ----
  const selfFingerprint = titleFingerprint(document.title ?? "");
  retrieved.sort((a, b) => {
    const levelA = a.abstract !== undefined && a.abstract !== "" ? 1 : 2;
    const levelB = b.abstract !== undefined && b.abstract !== "" ? 1 : 2;
    if (levelA !== levelB) return levelA - levelB;
    if ((b.citedByManuscript === true) !== (a.citedByManuscript === true)) {
      return a.citedByManuscript === true ? -1 : 1;
    }
    return (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title);
  });
  const seen = new Set<string>();
  const deduped: PoolWork[] = [];
  let selfExcluded = 0;
  for (const work of retrieved) {
    if (work.title === "") continue;
    if (selfFingerprint !== "" && titleFingerprint(work.title) === selfFingerprint) {
      selfExcluded += 1;
      continue;
    }
    if ((work.year ?? cutoffYear) > cutoffYear) continue;
    const doi = work.doi !== undefined ? normalizeDoi(work.doi) : undefined;
    const arxiv = work.arxivId !== undefined ? normalizeArxivId(work.arxivId) : undefined;
    const keys = [
      ...(doi !== undefined ? [`doi:${doi}`] : []),
      ...(arxiv !== undefined ? [`arxiv:${arxiv}`] : []),
      `tf:${titleFingerprint(work.title)}|${work.year ?? ""}`,
    ];
    if (keys.some((key) => seen.has(key))) continue;
    deduped.push(work);
    for (const key of keys) seen.add(key);
  }

  // ---- 通道 C：在库全文升级（verified_fulltext；只读已在库 source） ----
  const libraryCandidates: Array<{ work: PoolWork; source: SourceItem }> = [];
  const candidates: PriorWorkCandidate[] = [];
  let libraryUpgraded = 0;
  for (const work of deduped) {
    const match = deps.librarySources.find((source) => librarySourceMatches(work, source));
    let contentLevel: PriorWorkCandidate["contentLevel"] =
      work.abstract !== undefined && work.abstract !== "" ? "abstract" : "metadata";
    let fullTextExcerpts: string[] | undefined;
    let librarySourceId: string | undefined;
    if (match !== undefined) {
      libraryCandidates.push({ work, source: match });
      const chunks = await deps.readSourceChunks(document.projectId, match.sourceId);
      if (chunks !== null && chunks.length > 0) {
        const excerpts = pickMethodExcerpts(chunks);
        if (excerpts.length > 0) {
          fullTextExcerpts = excerpts;
          librarySourceId = match.sourceId;
          contentLevel = "verified_fulltext";
          libraryUpgraded += 1;
        }
      }
    }
    candidates.push({
      candidateId: `P${String(candidates.length + 1).padStart(2, "0")}`,
      title: work.title,
      year: work.year,
      venue: work.venue,
      doi: work.doi,
      arxivId: work.arxivId,
      authors: work.authors,
      abstract: work.abstract,
      ...(fullTextExcerpts !== undefined ? { fullTextExcerpts } : {}),
      citedByManuscript: work.citedByManuscript,
      contentLevel,
      source: work.source,
      ...(librarySourceId !== undefined ? { librarySourceId } : {}),
    });
  }

  // 内容级升级后再按（内容级 → 自引 → year desc → title asc）取 cap
  candidates.sort((a, b) => {
    const rank = CONTENT_LEVEL_RANK[a.contentLevel] - CONTENT_LEVEL_RANK[b.contentLevel];
    if (rank !== 0) return rank;
    if ((b.citedByManuscript === true) !== (a.citedByManuscript === true)) {
      return a.citedByManuscript === true ? -1 : 1;
    }
    return (b.year ?? 0) - (a.year ?? 0) || a.title.localeCompare(b.title);
  });
  const finalCandidates = candidates.slice(0, EVIDENCE_AUDIT_POOL_CAP);

  const pool: PriorWorkPool = {
    cutoffDate,
    candidates: finalCandidates,
    queriesUsed,
  };
  const stats: EvidenceAuditPoolBuildStats = {
    cutoffDate,
    referenceEntriesTotal: extraction.references.length,
    referenceEntriesEligible: refEntries.length,
    refResolved,
    refUnresolved,
    refLookupErrors,
    externalQuery: terms.length > 0 ? terms.join(" ") : null,
    externalRetrieved,
    libraryCandidates: libraryCandidates.length,
    libraryUpgraded,
    dedupedCandidates: deduped.length,
    selfExcluded,
    poolCap: EVIDENCE_AUDIT_POOL_CAP,
    contentLevels: {
      abstract: finalCandidates.filter((c) => c.contentLevel === "abstract").length,
      metadata: finalCandidates.filter((c) => c.contentLevel === "metadata").length,
      verified_fulltext: finalCandidates.filter((c) => c.contentLevel === "verified_fulltext").length,
    },
    buildNotes,
    extractorNotes: extraction.notes.slice(0, 5),
  };
  return { pool, stats };
}

// ---- 服务 ----

export interface TargetEvidenceAuditRunMeta {
  schemaVersion: 1;
  evaluatedAt: string;
  venueId?: string;
  documentType: string;
  manuscriptRevision: number | null;
  poolBuild: EvidenceAuditPoolBuildStats;
  telemetry: ContributionAuditTelemetry;
  extractParseFailed: boolean;
  compareParseFailed: boolean;
  synthesizeParseFailed: boolean;
}

export interface TargetEvidenceAuditView {
  artifact: ContributionAuditArtifact;
  meta: TargetEvidenceAuditRunMeta | null;
  stale: boolean;
  staleReason?: string;
  currentManuscriptRevision: number | null;
}

export interface TargetEvidenceAuditServiceOptions {
  projects: ProjectStore;
  store: PaperStore;
  runtime: AgentRuntime;
  reviewerAgentId: string;
  scholarly: Pick<ScholarlyResolver, "resolve">;
  academic: Pick<AcademicSearchService, "search">;
  listLibrarySources: (projectId: string) => Promise<readonly SourceItem[]>;
  readSourceChunks: (projectId: string, sourceId: string) => Promise<readonly SourceChunk[] | null>;
  currentRevision?: (projectId: string) => Promise<number>;
  runTimeoutMs?: number;
  now?: () => Date;
  log?: (message: string) => void;
}

export class TargetEvidenceAuditService {
  private readonly audit: ContributionAuditService;
  private readonly projects: ProjectStore;
  private readonly store: PaperStore;
  private readonly deps: Omit<TargetEvidenceAuditServiceOptions, "projects" | "store" | "runtime" | "reviewerAgentId" | "runTimeoutMs">;
  private readonly currentRevision: ((projectId: string) => Promise<number>) | undefined;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(options: TargetEvidenceAuditServiceOptions) {
    this.projects = options.projects;
    this.store = options.store;
    this.currentRevision = options.currentRevision;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
    this.audit = new ContributionAuditService({
      store: options.store,
      runtime: options.runtime,
      reviewerAgentId: options.reviewerAgentId,
      researchDir: (projectId: string) => this.projects.researchDir(projectId),
      ...(options.runTimeoutMs !== undefined ? { runTimeoutMs: options.runTimeoutMs } : {}),
      now: this.now,
      log: this.log,
    });
    this.deps = {
      scholarly: options.scholarly,
      academic: options.academic,
      listLibrarySources: options.listLibrarySources,
      readSourceChunks: options.readSourceChunks,
    };
  }

  private metaPath(projectId: string): string {
    return join(this.projects.researchDir(projectId), "target-evidence-audit-meta.json");
  }

  /** 读已有工件 + 陈旧判定（零网络；损坏 meta 不阻塞工件展示） */
  async get(projectId: string): Promise<TargetEvidenceAuditView | null> {
    const artifact = await this.readArtifact(projectId);
    if (artifact === null) {
      return null;
    }
    let meta: TargetEvidenceAuditRunMeta | null = null;
    try {
      const raw = await readFile(this.metaPath(projectId), "utf8");
      meta = JSON.parse(raw) as TargetEvidenceAuditRunMeta;
    } catch {
      meta = null;
    }
    const document = await this.store.loadDocument(projectId);
    const currentRevision =
      this.currentRevision !== undefined ? await this.currentRevision(projectId) : null;
    let stale = false;
    let staleReason: string | undefined;
    if (document === null) {
      stale = true;
      staleReason = "当前项目无可读稿件解析产物（artifact 相对的稿件已不可用）";
    } else {
      const currentSha = sha256Hex(document.chunks.map((chunk) => chunk.text).join("\n\n")).slice(0, 16);
      if (currentSha !== artifact.inputFingerprint.manuscriptSha256) {
        stale = true;
        staleReason = `稿件内容已变更（artifact 指纹 ${artifact.inputFingerprint.manuscriptSha256} ≠ 当前 ${currentSha}）`;
      } else if (
        artifact.manuscriptRevision !== undefined &&
        artifact.manuscriptRevision !== null &&
        currentRevision !== null &&
        artifact.manuscriptRevision !== currentRevision
      ) {
        stale = true;
        staleReason = `稿件修订号已变更（artifact ${artifact.manuscriptRevision} ≠ 当前 ${currentRevision}）`;
      }
    }
    return {
      artifact,
      meta,
      stale,
      ...(staleReason !== undefined ? { staleReason } : {}),
      currentManuscriptRevision: currentRevision,
    };
  }

  /** 构建当前稿 fingerprint（无稿 → null；GET/POST 共用的 fail-closed 前置） */
  async currentManuscriptSha(projectId: string): Promise<string | null> {
    const document = await this.store.loadDocument(projectId);
    if (document === null) {
      return null;
    }
    return sha256Hex(document.chunks.map((chunk) => chunk.text).join("\n\n")).slice(0, 16);
  }

  /** 执行证据审计：确定性 pool → ContributionAuditService（3 次有界模型调用） */
  async evaluate(
    projectId: string,
    options: { venueId?: string; signal?: AbortSignal } = {},
  ): Promise<TargetEvidenceAuditView> {
    await this.projects.getRequired(projectId);
    const document = await this.store.loadDocument(projectId);
    if (document === null) {
      throw new BusinessError(
        "INVALID_REQUEST",
        "项目尚无可审计的稿件解析产物（先完成 PDF/LaTeX 摄取，再执行证据审计）",
      );
    }
    const project = await this.projects.get(projectId);
    const documentType = project?.documentType ?? "unknown";
    const cutoffDate = this.now().toISOString().slice(0, 10);
    const librarySources = await this.deps.listLibrarySources(projectId);
    const { pool, stats } = await buildPriorWorkPool(document, cutoffDate, {
      scholarly: this.deps.scholarly,
      academic: this.deps.academic,
      librarySources,
      readSourceChunks: this.deps.readSourceChunks,
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    this.log(
      `[target] projectId=${projectId} 证据审计 pool：refs=${stats.referenceEntriesTotal}(resolved ${stats.refResolved}/${stats.referenceEntriesEligible}) ext=${stats.externalRetrieved} library-upgraded=${stats.libraryUpgraded} pool=${pool.candidates.length}（fulltext ${stats.contentLevels.verified_fulltext}/abstract ${stats.contentLevels.abstract}/metadata ${stats.contentLevels.metadata}）`,
    );
    const revision =
      this.currentRevision !== undefined ? await this.currentRevision(projectId) : null;
    const runId = `ea-${this.now().toISOString().replace(/[-:TZ.]/g, "").slice(0, 14)}`;
    const outcome = await this.audit.audit({
      projectId,
      runId,
      pool,
      documentType,
      ...(options.venueId !== undefined ? { venueId: options.venueId } : {}),
      manuscriptRevision: revision,
      toolPolicy: "read_only",
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
    });
    const meta: TargetEvidenceAuditRunMeta = {
      schemaVersion: 1,
      evaluatedAt: outcome.artifact.evaluatedAt,
      documentType,
      manuscriptRevision: revision,
      poolBuild: stats,
      telemetry: outcome.telemetry,
      extractParseFailed: outcome.extractParseFailed,
      compareParseFailed: outcome.compareParseFailed,
      synthesizeParseFailed: outcome.synthesizeParseFailed,
      ...(options.venueId !== undefined ? { venueId: options.venueId } : {}),
    };
    const dir = this.projects.researchDir(projectId);
    await mkdir(dir, { recursive: true });
    await writeJsonAtomic(this.metaPath(projectId), meta);
    this.log(
      `[target] projectId=${projectId} 证据审计完成：calls=${outcome.telemetry.calls} failed=${outcome.telemetry.failed} totalMs=${outcome.telemetry.totalMs} guards=${JSON.stringify(outcome.artifact.guards)}`,
    );
    return {
      artifact: outcome.artifact,
      meta,
      stale: false,
      currentManuscriptRevision: revision,
    };
  }

  private async readArtifact(projectId: string): Promise<ContributionAuditArtifact | null> {
    let raw: string;
    try {
      raw = await readFile(this.audit.artifactPath(projectId), "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    return JSON.parse(raw) as ContributionAuditArtifact;
  }
}
