/**
 * SourceImportService：文献入库路径编排（M6.2 Project Literature Library）。
 *
 * 职责（不含检索——真关键词检索是 M6.3 的 AcademicSearchProvider）：
 * - 五种入库路径：PDF 上传（contentHash 判重）/ DOI / arXiv ID / URL / BibTeX；
 * - DOI / arXiv 的元数据解析复用既有 ScholarlyResolver.resolve（lookup 语义）；
 *   解析失败（not_found / unresolved / 网络错误）不阻塞导入——条目照常入库，
 *   状态如实记录（metadata 存在 ≠ 全文存在，绝不伪造 PDF）；
 * - Candidate promotion（候选 → 正式文献，幂等）与 reject；
 * - enrich：对已有条目执行一次 resolver 元数据补全（merge 规则见 metadataMerge）;
 * - link：同一研究工作多版本（preprint / conference / journal）的轻量关系建立
 *   （workKey + relatedSourceIds + versionType；不做自动识别、不合并 Source）；
 * - removeSource：Evidence 引用保护（被引用的正式 Source 禁止删除，409）。
 */

import { randomUUID } from "node:crypto";

import { BusinessError, SourceInUseError } from "../errors.js";
import type { EvidenceStore } from "../evidence/EvidenceStore.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { CanonicalPaperRecord } from "../citation/integrity.js";
import { ScholarlyResolver, type ResolverVerdict } from "../citation/scholarly.js";
import type { CandidateAddResult, CandidateSource, CandidateStatus, AddCandidateInput } from "./CandidateStore.js";
import { mapBibEntry, parseBibTeX } from "./bibtex.js";
import { buildIdentity, normalizeArxivId, canonicalUrl, normalizeDoi, type SourceIdentity } from "./identity.js";
import type {
  SourceItem,
  SourceMetadata,
  SourceRole,
  SourceType,
  SourceVersionType,
} from "./SourceStore.js";
import type { CandidateStore } from "./CandidateStore.js";
import type { SourceStore } from "./SourceStore.js";

/** 元数据解析记录（如实呈现 resolver 结论；不阻塞导入） */
export interface ResolveNote {
  outcome: "match" | "mismatch" | "ambiguous" | "not_found" | "unresolved";
  provider?: string;
  note?: string;
}

export interface ImportResult {
  source: SourceItem;
  created: boolean;
  resolve?: ResolveNote;
}

export interface BibTexImportEntryResult {
  source: SourceItem;
  created: boolean;
  entryKey: string;
}

export interface BibTexImportResult {
  results: BibTexImportEntryResult[];
  errors: Array<{ line: number; message: string }>;
}

export interface PromoteResult {
  source: SourceItem;
  created: boolean;
  candidate: CandidateSource;
}

export interface SourceImportServiceOptions {
  projects: ProjectStore;
  sources: SourceStore;
  candidates: CandidateStore;
  /** Evidence 引用保护（缺省不启用） */
  evidence?: EvidenceStore;
  /** 元数据解析器（DOI/arXiv 导入与 enrich；测试注入 fake providers） */
  scholarly?: ScholarlyResolver;
  log?: (message: string) => void;
}

export class SourceImportService {
  private readonly sources: SourceStore;
  private readonly candidates: CandidateStore;
  private readonly evidence?: EvidenceStore;
  private readonly scholarly?: ScholarlyResolver;
  private readonly log: (message: string) => void;

  constructor(options: SourceImportServiceOptions) {
    this.sources = options.sources;
    this.candidates = options.candidates;
    this.evidence = options.evidence;
    this.scholarly = options.scholarly;
    this.log = options.log ?? (() => {});
  }

  // ---- A. PDF 上传（复用 SourceStore.add：contentHash 判重）----

  importPdf(
    projectId: string,
    input: {
      fileName: string;
      content: Buffer;
      sourceRole?: SourceRole;
      metadata?: SourceMetadata;
      preferred?: boolean;
    },
  ): Promise<{ source: SourceItem; created: boolean }> {
    return this.sources.add(projectId, input);
  }

  // ---- B. DOI 导入 ----

  async importDoi(
    projectId: string,
    input: { doi: string; sourceRole?: SourceRole; enrich?: boolean },
  ): Promise<ImportResult> {
    const doi = normalizeDoi(input.doi);
    if (doi === undefined) {
      throw new BusinessError("INVALID_REQUEST", `非法 DOI："${input.doi}"（期望形如 10.xxxx/xxxxx）`);
    }
    const identity = buildIdentity({ doi });
    const existing = await this.sources.findByIdentity(projectId, identity!);
    if (existing !== null) {
      return { source: existing, created: false };
    }
    const metadata: SourceMetadata = { doi };
    let provenance: "resolved" | "inferred" = "inferred";
    let resolveNote: ResolveNote | undefined;
    if (input.enrich !== false) {
      const resolved = await this.resolveMetadata({ doi });
      resolveNote = resolved.note;
      if (resolved.record !== undefined) {
        Object.assign(metadata, definedOnly(recordToMetadata(resolved.record)));
        provenance = "resolved";
      }
    }
    const source = await this.sources.addRecord(projectId, {
      sourceType: "doi",
      origin: "DOI_IMPORT",
      ...(input.sourceRole !== undefined ? { sourceRole: input.sourceRole } : {}),
      metadata,
      identity,
      metadataProvenance: provenance,
    });
    return { source, created: true, ...(resolveNote !== undefined ? { resolve: resolveNote } : {}) };
  }

  // ---- C. arXiv 导入 ----

  async importArxiv(
    projectId: string,
    input: { arxivId: string; sourceRole?: SourceRole; enrich?: boolean },
  ): Promise<ImportResult> {
    const arxivId = normalizeArxivId(input.arxivId);
    if (arxivId === undefined) {
      throw new BusinessError(
        "INVALID_REQUEST",
        `非法 arXiv ID："${input.arxivId}"（期望 2401.12345 / cs/0501034 / arXiv:… 形态）`,
      );
    }
    const identity = buildIdentity({ arxivId });
    const existing = await this.sources.findByIdentity(projectId, identity!);
    if (existing !== null) {
      return { source: existing, created: false };
    }
    const metadata: SourceMetadata = { arxivId, url: `https://arxiv.org/abs/${arxivId}` };
    let provenance: "resolved" | "inferred" = "inferred";
    let resolveNote: ResolveNote | undefined;
    if (input.enrich !== false) {
      const resolved = await this.resolveMetadata({ arxivId });
      resolveNote = resolved.note;
      if (resolved.record !== undefined) {
        Object.assign(metadata, definedOnly(recordToMetadata(resolved.record)));
        provenance = "resolved";
      }
    }
    const source = await this.sources.addRecord(projectId, {
      sourceType: "arxiv",
      origin: "ARXIV_IMPORT",
      ...(input.sourceRole !== undefined ? { sourceRole: input.sourceRole } : {}),
      metadata,
      identity,
      metadataProvenance: provenance,
    });
    return { source, created: true, ...(resolveNote !== undefined ? { resolve: resolveNote } : {}) };
  }

  // ---- D. URL 导入（canonical URL + 记录；不抓取正文——ContentFetcher 属后续节点）----

  async importUrl(
    projectId: string,
    input: { url: string; title?: string; sourceRole?: SourceRole },
  ): Promise<ImportResult> {
    const url = canonicalUrl(input.url);
    if (url === undefined) {
      throw new BusinessError("INVALID_REQUEST", `非法 URL："${input.url}"（仅支持 http/https）`);
    }
    const identity = buildIdentity({
      url,
      ...(input.title !== undefined ? { title: input.title } : {}),
    })!;
    const existing = await this.sources.findByIdentity(projectId, identity);
    if (existing !== null) {
      return { source: existing, created: false };
    }
    const source = await this.sources.addRecord(projectId, {
      sourceType: "url",
      origin: "URL_IMPORT",
      ...(input.sourceRole !== undefined ? { sourceRole: input.sourceRole } : {}),
      metadata: { url, ...(input.title !== undefined ? { title: input.title } : {}) },
      identity,
      metadataProvenance: "inferred",
    });
    return { source, created: true };
  }

  // ---- E. BibTeX 导入 ----

  async importBibtex(
    projectId: string,
    input: { content: string; sourceRole?: SourceRole },
  ): Promise<BibTexImportResult> {
    const { entries, errors } = parseBibTeX(input.content);
    const results: BibTexImportEntryResult[] = [];
    for (const entry of entries) {
      const { metadata, versionType } = mapBibEntry(entry);
      const identity = buildIdentity(metadata);
      let source: SourceItem;
      let created = false;
      if (identity !== null) {
        const existing = await this.sources.findByIdentity(projectId, identity);
        if (existing !== null) {
          source = await this.sources.applyMetadataMerge(projectId, existing.sourceId, {
            metadata,
            provenance: "inferred",
          });
          results.push({ source, created: false, entryKey: entry.key });
          continue;
        }
      }
      source = await this.sources.addRecord(projectId, {
        sourceType: "bibtex",
        origin: "BIBTEX_IMPORT",
        ...(input.sourceRole !== undefined ? { sourceRole: input.sourceRole } : {}),
        metadata,
        identity,
        versionType,
        metadataProvenance: "inferred",
      });
      created = true;
      results.push({ source, created, entryKey: entry.key });
    }
    return { results, errors };
  }

  // ---- 元数据补全（enrich）----

  /**
   * 对已有条目执行一次 resolver 元数据解析并 merge（resolved 级）。
   * 适用场景：先 PDF 上传（title 来自用户）→ 后补 DOI → resolver 找到正式
   * 记录 → merge 填充 authors/year/venue/abstract（不覆盖 user 级字段）。
   */
  async enrichMetadata(
    projectId: string,
    sourceId: string,
  ): Promise<{ source: SourceItem; resolve: ResolveNote }> {
    const item = await this.sources.getRequired(projectId, sourceId);
    const query = scholarlyQueryOf(item);
    if (query === null) {
      throw new BusinessError(
        "INVALID_REQUEST",
        `文献 ${sourceId} 缺少可解析字段（DOI / arXiv ID / 标题任一）`,
      );
    }
    const resolved = await this.resolveMetadata(query);
    const source = await this.sources.applyMetadataMerge(projectId, sourceId, {
      metadata: resolved.record !== undefined ? recordToMetadata(resolved.record) : {},
      provenance: "resolved",
    });
    return { source, resolve: resolved.note };
  }

  // ---- Candidate：添加 / 列表 / 删除 / promotion / reject ----

  addCandidate(projectId: string, input: AddCandidateInput): Promise<CandidateAddResult> {
    return this.candidates.add(projectId, input);
  }

  listCandidates(projectId: string, status?: CandidateStatus): Promise<CandidateSource[]> {
    return this.candidates.list(projectId, status);
  }

  deleteCandidate(projectId: string, candidateId: string): Promise<void> {
    return this.candidates.remove(projectId, candidateId);
  }

  /**
   * Candidate → Literature Library（幂等）：
   * 1. 重新执行 SourceIdentity 去重（library 已有同身份条目 → merge 元数据并
   *    返回既有条目，不复制）；
   * 2. 已 promoted 且目标 source 仍在 → 直接返回（重复调用幂等）；
   * 3. 新建条目的 origin：manual 候选 = USER_ADDED，检索候选 = AGENT_RETRIEVED；
   * 4. promotion 只影响 candidate 状态标记，不把候选清单变成文献事实来源。
   */
  async promoteCandidate(
    projectId: string,
    candidateId: string,
    input: { sourceRole?: SourceRole } = {},
  ): Promise<PromoteResult> {
    const candidate = await this.candidates.getRequired(projectId, candidateId);
    // 幂等快路径：已 promote 且 library 条目仍在
    if (candidate.status === "accepted" && candidate.promotedSourceId !== undefined) {
      const promoted = await this.sources.get(projectId, candidate.promotedSourceId);
      if (promoted !== null) {
        return { source: promoted, created: false, candidate };
      }
      // 目标条目已被删除 → 落回正常路径重新入库
    }
    const candidateMetadata = candidateMetadataOf(candidate);
    const existing = await this.sources.findByIdentity(projectId, candidate.identity);
    let source: SourceItem;
    let created = false;
    if (existing !== null) {
      source = await this.sources.applyMetadataMerge(projectId, existing.sourceId, {
        metadata: candidateMetadata,
        provenance: "inferred",
      });
    } else {
      source = await this.sources.addRecord(projectId, {
        sourceType: sourceTypeOfIdentity(candidate.identity),
        origin: candidate.origin === "manual" ? "USER_ADDED" : "AGENT_RETRIEVED",
        ...(input.sourceRole !== undefined ? { sourceRole: input.sourceRole } : {}),
        metadata: candidateMetadata,
        identity: candidate.identity,
        metadataProvenance: "inferred",
      });
      created = true;
    }
    const updated = await this.candidates.markAccepted(projectId, candidateId, source.sourceId);
    return { source, created, candidate: updated };
  }

  rejectCandidate(projectId: string, candidateId: string): Promise<CandidateSource> {
    return this.candidates.markRejected(projectId, candidateId);
  }

  // ---- 版本关系（work identity）----

  /**
   * 将两个 Source 标记为同一研究工作的不同版本（preprint / conference /
   * journal…）：统一 workKey、互记 relatedSourceIds、可选标注 versionType。
   * 不合并条目、不复制文件——多 Provider 搜到同一工作的不同版本时各自独立，
   * 由本操作显式建立关系（自动识别属 M6.3+ provider 元数据能力）。
   */
  async linkSources(
    projectId: string,
    sourceId: string,
    targetSourceId: string,
    input: { versionType?: SourceVersionType; targetVersionType?: SourceVersionType } = {},
  ): Promise<{ sources: [SourceItem, SourceItem] }> {
    if (sourceId === targetSourceId) {
      throw new BusinessError("INVALID_REQUEST", "不能把文献与它自己建立版本关系");
    }
    const a = await this.sources.getRequired(projectId, sourceId);
    const b = await this.sources.getRequired(projectId, targetSourceId);
    const workKey = a.workKey ?? b.workKey ?? `work:${sourceId}-${randomUUID().slice(0, 8)}`;
    const updatedA = await this.sources.update(projectId, sourceId, {
      workKey,
      relatedSourceIds: [...(a.relatedSourceIds ?? []), targetSourceId],
      ...(input.versionType !== undefined ? { versionType: input.versionType } : {}),
    });
    const updatedB = await this.sources.update(projectId, targetSourceId, {
      workKey,
      relatedSourceIds: [...(b.relatedSourceIds ?? []), sourceId],
      ...(input.targetVersionType !== undefined ? { versionType: input.targetVersionType } : {}),
    });
    return { sources: [updatedA, updatedB] };
  }

  // ---- 删除（Evidence 引用保护）----

  /** 删除正式 Source；被 Evidence 引用时抛 SOURCE_IN_USE（409） */
  async removeSource(projectId: string, sourceId: string): Promise<void> {
    if (this.evidence !== undefined) {
      const references = await this.evidence.query(projectId, { sourceId });
      if (references.length > 0) {
        throw new SourceInUseError(sourceId, references.length);
      }
    }
    await this.sources.remove(projectId, sourceId);
  }

  // ---- 内部 ----

  /** resolver 元数据解析：match / mismatch 都给出权威记录；其余结论如实记录 */
  private async resolveMetadata(
    query: { doi?: string; arxivId?: string; title?: string; authors?: string[]; year?: number },
  ): Promise<{ note: ResolveNote; record?: CanonicalPaperRecord }> {
    if (this.scholarly === undefined) {
      return { note: { outcome: "unresolved", note: "未配置元数据解析器（scholarly resolver）" } };
    }
    let verdict: ResolverVerdict;
    try {
      verdict = await this.scholarly.resolve(query);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(`[sources] 元数据解析异常（${JSON.stringify(query)}）：${message}`);
      return { note: { outcome: "unresolved", note: `解析器异常：${message}` } };
    }
    const provider = [...verdict.attempts]
      .reverse()
      .find((attempt) => attempt.outcome === "match" || attempt.outcome === "mismatch")?.provider;
    switch (verdict.outcome) {
      case "match":
        return {
          note: { outcome: "match", ...(provider !== undefined ? { provider } : {}) },
          record: verdict.canonical,
        };
      case "mismatch":
        // DOI/arXiv 导入路径下 query 只有标识符：record 是该标识符的权威记录，
        // 字段差异如实呈现在 mismatch 结论中，记录仍可用于元数据补全
        return {
          note: {
            outcome: "mismatch",
            ...(provider !== undefined ? { provider } : {}),
            note: verdict.mismatches?.map((m) => `${m.field}:${m.expected}≠${m.actual}`).join("; "),
          },
          record: verdict.canonical,
        };
      case "ambiguous":
        return {
          note: { outcome: "ambiguous", note: "多个候选无法裁决，未采信任何记录" },
        };
      case "not_found":
        return { note: { outcome: "not_found", note: "多源权威确认无匹配" } };
      case "unresolved":
        return {
          note: { outcome: "unresolved", note: "检索未定论（网络/限流），元数据未补全" },
        };
    }
  }
}

/** CanonicalPaperRecord → SourceMetadata（只取确定有值的字段） */
function recordToMetadata(record: CanonicalPaperRecord): SourceMetadata {
  const metadata: SourceMetadata = {};
  if (record.title !== undefined && record.title !== "") {
    metadata.title = record.title;
  }
  if (record.authors !== undefined && record.authors.length > 0) {
    metadata.authors = record.authors;
  }
  if (typeof record.year === "number" && Number.isInteger(record.year)) {
    metadata.year = record.year;
  }
  if (record.doi !== undefined && record.doi !== "") {
    metadata.doi = record.doi;
  }
  if (record.arxivId !== undefined && record.arxivId !== "") {
    metadata.arxivId = record.arxivId;
  }
  if (record.url !== undefined && record.url !== "") {
    metadata.url = record.url;
  }
  if (record.venue !== undefined && record.venue !== "") {
    metadata.venue = record.venue;
  }
  if (record.abstract !== undefined && record.abstract !== "") {
    metadata.abstract = record.abstract.slice(0, 3000);
  }
  return metadata;
}

function definedOnly(metadata: SourceMetadata): SourceMetadata {
  const out: SourceMetadata = {};
  for (const [key, value] of Object.entries(metadata)) {
    if (value !== undefined && value !== "") {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}

/** 条目 → resolver 查询（DOI 优先 > arXiv > 标题+作者+年份） */
function scholarlyQueryOf(item: SourceItem): {
  doi?: string;
  arxivId?: string;
  title?: string;
  authors?: string[];
  year?: number;
} | null {
  const metadata = item.metadata;
  const doi = metadata.doi !== undefined ? normalizeDoi(metadata.doi) : undefined;
  const arxivId = metadata.arxivId !== undefined ? normalizeArxivId(metadata.arxivId) : undefined;
  const title = metadata.title?.trim();
  if (doi === undefined && arxivId === undefined && (title === undefined || title === "")) {
    return null;
  }
  return {
    ...(doi !== undefined ? { doi } : {}),
    ...(arxivId !== undefined ? { arxivId } : {}),
    ...(title !== undefined && title !== "" ? { title } : {}),
    ...(metadata.authors !== undefined ? { authors: metadata.authors } : {}),
    ...(metadata.year !== undefined ? { year: metadata.year } : {}),
  };
}

function candidateMetadataOf(candidate: CandidateSource): SourceMetadata {
  const metadata: SourceMetadata = {};
  if (candidate.title !== undefined) {
    metadata.title = candidate.title;
  }
  if (candidate.authors !== undefined) {
    metadata.authors = candidate.authors;
  }
  if (candidate.year !== undefined) {
    metadata.year = candidate.year;
  }
  if (candidate.venue !== undefined) {
    metadata.venue = candidate.venue;
  }
  if (candidate.doi !== undefined) {
    metadata.doi = candidate.doi;
  }
  if (candidate.arxivId !== undefined) {
    metadata.arxivId = candidate.arxivId;
  }
  if (candidate.url !== undefined) {
    metadata.url = candidate.url;
  }
  if (candidate.snippetOrAbstract !== undefined) {
    metadata.abstract = candidate.snippetOrAbstract.slice(0, 3000);
  }
  return metadata;
}

function sourceTypeOfIdentity(identity: SourceIdentity): SourceType {
  if (identity.doi !== undefined) {
    return "doi";
  }
  if (identity.arxivId !== undefined) {
    return "arxiv";
  }
  if (identity.url !== undefined) {
    return "url";
  }
  return "metadata";
}
