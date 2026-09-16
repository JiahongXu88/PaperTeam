/**
 * 项目文献库 SourceStore（M6.2 扩展：Project Literature Library 的 authoritative 层）。
 *
 * 存储布局（PRD §5.5 / §6）：
 *   sources/papers/<sourceId>-<安全文件名>   原始文件（PDF / BibTeX 等；metadata-only 条目无）
 *   sources/parsed/<sourceId>.json           解析产物（PDF 分析摘要等）
 *   sources/index.json                       条目索引（原子重写）
 *   sources/candidates.json                  Discovery 候选（CandidateStore；非 authoritative）
 *
 * sourceRole（D-0012）：evidence（证据来源）/ reference（参考范文）/ both。
 * 解析失败不破坏项目：analysis.status=failed，条目保留可重试。
 *
 * M6.2 新增语义（全部字段 optional，老数据 lazy 兼容——list 不迁移旧条目，
 * identity 判等时从 metadata 动态推导）：
 * - identity：SourceIdentity（DOI/arXiv/PMID/标题指纹+年份+一作/URL 分层键）；
 * - contentHash：原始文件 sha256（重复上传判重 + 解析产物失效判定）；
 * - sourceType：pdf/bibtex/text/markdown/image/doi/arxiv/url/metadata
 *   （metadata-only 条目 fileName 为空，无原始文件）；
 * - status="metadata_only"：有元数据、无全文（DOI/URL/BibTeX 导入）；
 * - workKey / versionType / relatedSourceIds：同一研究工作多版本（preprint /
 *   conference / journal）的轻量关系，不同版本仍是独立 Source；
 * - metadataProvenance：user > resolved > inferred 的元数据可信层级
 *   （见 metadataMerge.ts，低可信不得覆盖高可信）。
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BusinessError, NotFoundError } from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { writeJsonAtomic } from "../util/atomic.js";
import { sha256Hex } from "../util/hash.js";
import type { PdfAnalysis } from "./PdfAnalyzer.js";
import {
  buildIdentity,
  identityFromMetadata,
  identityKey,
  type SourceIdentity,
} from "./identity.js";
import { mergeSourceMetadata, type MetadataProvenance } from "./metadataMerge.js";

export type SourceRole = "evidence" | "reference" | "both";
/**
 * 入库来源（M6.2 扩展；旧值 USER_ADDED / AGENT_RETRIEVED 保持兼容）：
 * DOI / arXiv / URL / BibTeX 导入在 M6.2 是用户触发的确定性导入（无自动检索）；
 * AGENT_RETRIEVED 为 M6.3+ discovery 自动入库预留。
 */
export type SourceOrigin =
  | "USER_ADDED"
  | "DOI_IMPORT"
  | "ARXIV_IMPORT"
  | "URL_IMPORT"
  | "BIBTEX_IMPORT"
  | "AGENT_RETRIEVED";
/**
 * 条目状态：metadata_only（有元数据无全文）→ pending（有文件待解析）→
 * available / partial / failed（解析终态）+ rejected（人工否决）。
 */
export type SourceStatus =
  | "pending"
  | "metadata_only"
  | "available"
  | "partial"
  | "failed"
  | "rejected";
/** 条目类型：前五种对应上传文件（按扩展名推断），后四种是 metadata-only 导入 */
export type SourceType =
  | "pdf"
  | "bibtex"
  | "text"
  | "markdown"
  | "image"
  | "doi"
  | "arxiv"
  | "url"
  | "metadata";
/** 同一研究工作内的版本类型（workKey 分组的语义标注；不参与判等） */
export type SourceVersionType = "preprint" | "conference" | "journal" | "other";

export interface SourceMetadata {
  title?: string;
  authors?: string[];
  year?: number;
  doi?: string;
  /** 原始输入（未归一）；归一身份在 item.identity */
  arxivId?: string;
  url?: string;
  venue?: string;
  /** 摘要（resolver / BibTeX 导入；M6.4 chunk 检索复用；≤3000 字符） */
  abstract?: string;
}

export interface SourceItem {
  sourceId: string;
  /** 存储文件名（sources/papers/ 下，不含路径）；metadata-only 条目为空 */
  fileName?: string;
  originalName?: string;
  /** 条目类型；老数据缺省时按 fileName 扩展名推断（见 effectiveSourceType） */
  sourceType?: SourceType;
  sourceRole: SourceRole;
  origin: SourceOrigin;
  status: SourceStatus;
  preferred: boolean;
  metadata: SourceMetadata;
  /** 元数据可信层级（最近一次写入）；缺省视为 inferred（老数据） */
  metadataProvenance?: MetadataProvenance;
  /** 跨 provider 归一身份（判等键见 identity.ts） */
  identity?: SourceIdentity;
  /** 原始文件 sha256（hex）；重复上传判重 + 解析产物失效判定 */
  contentHash?: string;
  /** 最近一次解析产物（builtin 文本层 / multimodal 扩展） */
  analysis?: PdfAnalysis;
  /** analysis 对应的原始文件 contentHash；与 contentHash 不一致 → 解析产物过期 */
  analysisHash?: string;
  /** 同一研究工作的分组键（link 操作统一；缺省即各自独立） */
  workKey?: string;
  /** 版本类型标注（用户 / 导入路径设置；不参与身份判等） */
  versionType?: SourceVersionType;
  /** 同一 workKey 下其它版本的 sourceId（link 操作维护，双向） */
  relatedSourceIds?: string[];
  bytes: number;
  createdAt: string;
  updatedAt: string;
}

export interface AddSourceInput {
  fileName: string;
  content: Buffer;
  sourceRole?: SourceRole;
  origin?: SourceOrigin;
  metadata?: SourceMetadata;
  preferred?: boolean;
}

/** metadata-only / 文件型共用的底层写入输入（import 路径使用） */
export interface AddRecordInput {
  sourceType: SourceType;
  origin?: SourceOrigin;
  sourceRole?: SourceRole;
  preferred?: boolean;
  metadata?: SourceMetadata;
  /** 已归一化的身份（缺省时从 metadata 推导并归一） */
  identity?: SourceIdentity | null;
  metadataProvenance?: MetadataProvenance;
  /** 版本类型标注（BibTeX 条目类型映射等） */
  versionType?: SourceVersionType;
  /** 文件型条目必填 */
  fileName?: string;
  content?: Buffer;
}

export interface SourceAddResult {
  source: SourceItem;
  /** false = 命中已有条目（重复上传 / 同身份导入），未新建 */
  created: boolean;
}

export interface SourceUpdatePatch {
  sourceRole?: SourceRole;
  preferred?: boolean;
  metadata?: SourceMetadata;
  versionType?: SourceVersionType;
  relatedSourceIds?: string[];
  workKey?: string;
}

export interface SourceStoreOptions {
  now?: () => Date;
}

const SOURCE_ROLES: readonly SourceRole[] = ["evidence", "reference", "both"];
const SOURCE_ORIGINS: readonly SourceOrigin[] = [
  "USER_ADDED",
  "DOI_IMPORT",
  "ARXIV_IMPORT",
  "URL_IMPORT",
  "BIBTEX_IMPORT",
  "AGENT_RETRIEVED",
];
const SOURCE_VERSION_TYPES: readonly SourceVersionType[] = [
  "preprint",
  "conference",
  "journal",
  "other",
];
const ALLOWED_EXTENSIONS: readonly string[] = [
  ".pdf",
  ".bib",
  ".txt",
  ".md",
  ".csv",
  ".png",
  ".jpg",
  ".jpeg",
];

/** 单文件大小上限 */
export const MAX_SOURCE_BYTES = 20 * 1024 * 1024;

/** 扩展名 → sourceType（老数据 / 新上传共用） */
export function sourceTypeFromFileName(fileName: string): SourceType {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) {
    return "pdf";
  }
  if (lower.endsWith(".bib")) {
    return "bibtex";
  }
  if (lower.endsWith(".txt") || lower.endsWith(".csv")) {
    return "text";
  }
  if (lower.endsWith(".md")) {
    return "markdown";
  }
  if (lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image";
  }
  return "text";
}

/** 条目生效类型：显式 sourceType 优先，否则按 fileName 推断，再退 metadata */
export function effectiveSourceType(item: SourceItem): SourceType {
  if (item.sourceType !== undefined) {
    return item.sourceType;
  }
  if (item.fileName !== undefined) {
    return sourceTypeFromFileName(item.fileName);
  }
  return "metadata";
}

export class SourceStore {
  private readonly projects: ProjectStore;
  private readonly now: () => Date;

  constructor(projects: ProjectStore, options: SourceStoreOptions = {}) {
    this.projects = projects;
    this.now = options.now ?? (() => new Date());
  }

  private papersDir(projectId: string): string {
    return join(this.projects.sourcesDir(projectId), "papers");
  }

  private parsedDir(projectId: string): string {
    return join(this.projects.sourcesDir(projectId), "parsed");
  }

  private indexPath(projectId: string): string {
    return join(this.projects.sourcesDir(projectId), "index.json");
  }

  /**
   * 添加文件型文献（写原始文件 + 索引条目；状态 pending，等待解析）。
   * 同项目内 contentHash 相同的重复上传不新建条目，返回已有条目（created=false）。
   */
  async add(projectId: string, input: AddSourceInput): Promise<SourceAddResult> {
    const safeName = sanitizeFileName(input.fileName);
    if (safeName === undefined) {
      throw new BusinessError(
        "INVALID_REQUEST",
        `非法文件名："${input.fileName}"（只允许字母、数字、点、下划线、连字符，扩展名需在允许列表内）`,
      );
    }
    if (input.content.byteLength === 0) {
      throw new BusinessError("INVALID_REQUEST", "文件内容不能为空");
    }
    if (input.content.byteLength > MAX_SOURCE_BYTES) {
      throw new BusinessError("INVALID_REQUEST", `文件超过 ${MAX_SOURCE_BYTES} 字节上限`);
    }
    const contentHash = sha256Hex(input.content);
    const existing = await this.findByContentHash(projectId, contentHash);
    if (existing !== null) {
      return { source: existing, created: false };
    }
    return {
      source: await this.addRecord(projectId, {
        sourceType: sourceTypeFromFileName(safeName),
        ...(input.origin !== undefined ? { origin: input.origin } : {}),
        ...(input.sourceRole !== undefined ? { sourceRole: input.sourceRole } : {}),
        ...(input.preferred !== undefined ? { preferred: input.preferred } : {}),
        ...(input.metadata !== undefined ? { metadata: input.metadata } : {}),
        identity: input.metadata !== undefined ? buildIdentity(metadataToIdentityInput(input.metadata)) : null,
        fileName: safeName,
        content: input.content,
      }),
      created: true,
    };
  }

  /**
   * 底层写入（import 路径 / add 共用）：文件型传 fileName+content，
   * metadata-only 传 sourceType ∈ {doi, arxiv, url, metadata, bibtex}。
   * 身份归一：显式 identity 优先，否则从 metadata 推导。
   */
  async addRecord(projectId: string, input: AddRecordInput): Promise<SourceItem> {
    const role = input.sourceRole ?? "both";
    if (!SOURCE_ROLES.includes(role)) {
      throw new BusinessError("INVALID_REQUEST", `sourceRole 只能是 ${SOURCE_ROLES.join(" / ")}`);
    }
    const origin = input.origin ?? "USER_ADDED";
    if (!SOURCE_ORIGINS.includes(origin)) {
      throw new BusinessError("INVALID_REQUEST", `origin 只能是 ${SOURCE_ORIGINS.join(" / ")}`);
    }
    const metadata = sanitizeMetadata(input.metadata);
    let fileName: string | undefined;
    let bytes = 0;
    let contentHash: string | undefined;
    let status: SourceStatus;
    if (input.fileName !== undefined && input.content !== undefined) {
      const safeName = sanitizeFileName(input.fileName);
      if (safeName === undefined) {
        throw new BusinessError("INVALID_REQUEST", `非法文件名："${input.fileName}"`);
      }
      if (input.content.byteLength === 0) {
        throw new BusinessError("INVALID_REQUEST", "文件内容不能为空");
      }
      if (input.content.byteLength > MAX_SOURCE_BYTES) {
        throw new BusinessError("INVALID_REQUEST", `文件超过 ${MAX_SOURCE_BYTES} 字节上限`);
      }
      fileName = safeName;
      bytes = input.content.byteLength;
      contentHash = sha256Hex(input.content);
      status = "pending";
    } else if (input.fileName !== undefined || input.content !== undefined) {
      throw new BusinessError("INVALID_REQUEST", "fileName 与 content 必须同时提供");
    } else {
      status = "metadata_only";
    }

    const items = await this.list(projectId);
    // 按已有最大编号递增（不是 length+1）：删除中间条目后新条目不得复用旧 id，
    // 否则 parsed/<id>.json 与索引会串到别的文献上
    const maxId = items.reduce((max, item) => {
      const match = /^S(\d+)$/.exec(item.sourceId);
      return match !== null ? Math.max(max, Number(match[1])) : max;
    }, 0);
    const sourceId = `S${String(maxId + 1).padStart(3, "0")}`;
    const timestamp = this.now().toISOString();
    const identity =
      input.identity !== undefined && input.identity !== null
        ? input.identity
        : buildIdentity(metadataToIdentityInput(metadata));
    const item: SourceItem = {
      sourceId,
      ...(fileName !== undefined
        ? { fileName: `${sourceId}-${fileName}`, originalName: input.fileName }
        : {}),
      sourceType: input.sourceType,
      sourceRole: role,
      origin,
      status,
      preferred: input.preferred ?? false,
      metadata,
      metadataProvenance: input.metadataProvenance ?? "inferred",
      ...(identity !== null ? { identity } : {}),
      ...(contentHash !== undefined ? { contentHash } : {}),
      ...(input.versionType !== undefined ? { versionType: input.versionType } : {}),
      bytes,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    if (fileName !== undefined) {
      await mkdir(this.papersDir(projectId), { recursive: true });
      await writeFile(join(this.papersDir(projectId), item.fileName!), input.content!);
    }
    await this.saveIndex(projectId, [...items, item]);
    return item;
  }

  async get(projectId: string, sourceId: string): Promise<SourceItem | null> {
    const items = await this.list(projectId);
    return items.find((item) => item.sourceId === sourceId) ?? null;
  }

  async getRequired(projectId: string, sourceId: string): Promise<SourceItem> {
    const item = await this.get(projectId, sourceId);
    if (item === null) {
      throw new NotFoundError("文献", sourceId);
    }
    return item;
  }

  async list(projectId: string): Promise<SourceItem[]> {
    let raw: string;
    try {
      raw = await readFile(this.indexPath(projectId), "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    // 索引损坏不能当成「空库」：下一次 add 会用单条目覆盖掉全部历史
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BusinessError("INTERNAL_ERROR", `文献索引损坏（${projectId}/sources/index.json 不是合法 JSON）`);
    }
    const items = (parsed as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) {
      throw new BusinessError("INTERNAL_ERROR", `文献索引损坏（${projectId}/sources/index.json 缺少 items）`);
    }
    return items.filter(
      (item): item is SourceItem => typeof item === "object" && item !== null && typeof (item as SourceItem).sourceId === "string",
    );
  }

  /** 条目的判等身份：显式 identity 优先；老数据从 metadata lazy 推导（不重写索引） */
  effectiveIdentity(item: SourceItem): SourceIdentity | null {
    return item.identity ?? identityFromMetadata(item.metadata);
  }

  /** 按身份找已有条目（导入 / promotion 去重）；键见 identity.ts 分层规则 */
  async findByIdentity(projectId: string, identity: SourceIdentity): Promise<SourceItem | null> {
    const key = identityKey(identity);
    if (key === undefined) {
      return null;
    }
    for (const item of await this.list(projectId)) {
      const itemIdentity = this.effectiveIdentity(item);
      const itemKey = itemIdentity !== null ? identityKey(itemIdentity) : undefined;
      if (itemKey !== undefined && itemKey === key) {
        return item;
      }
    }
    return null;
  }

  /** 按 contentHash 找已有条目（重复上传判重；老条目无 hash 时视为不可判重） */
  async findByContentHash(projectId: string, contentHash: string): Promise<SourceItem | null> {
    for (const item of await this.list(projectId)) {
      if (item.contentHash === contentHash) {
        return item;
      }
    }
    return null;
  }

  /** 原始文件绝对路径（供分析器 / Agent 读取）；metadata-only 条目无文件 */
  async filePath(projectId: string, sourceId: string): Promise<string> {
    const item = await this.getRequired(projectId, sourceId);
    if (item.fileName === undefined) {
      throw new BusinessError(
        "INVALID_REQUEST",
        `文献 ${sourceId} 是 metadata-only 条目（无原始文件）；可先通过 DOI / arXiv / URL 获取全文后上传`,
      );
    }
    return join(this.papersDir(projectId), item.fileName);
  }

  /** 更新角色 / 重点参考标记 / 版本关系标注 */
  async update(projectId: string, sourceId: string, patch: SourceUpdatePatch): Promise<SourceItem> {
    const items = await this.list(projectId);
    const index = items.findIndex((item) => item.sourceId === sourceId);
    if (index === -1) {
      throw new NotFoundError("文献", sourceId);
    }
    const current = items[index]!;
    const updated: SourceItem = {
      ...current,
      ...(patch.sourceRole !== undefined
        ? {
            sourceRole: SOURCE_ROLES.includes(patch.sourceRole)
              ? patch.sourceRole
              : (() => {
                  throw new BusinessError("INVALID_REQUEST", `非法 sourceRole：${patch.sourceRole}`);
                })(),
          }
        : {}),
      ...(patch.preferred !== undefined ? { preferred: patch.preferred } : {}),
      ...(patch.metadata !== undefined
        ? {
            metadata: { ...current.metadata, ...sanitizeMetadata(patch.metadata) },
            // PATCH 是用户显式操作 → 元数据升级为 user 级
            metadataProvenance: "user",
          }
        : {}),
      ...(patch.versionType !== undefined
        ? {
            versionType: SOURCE_VERSION_TYPES.includes(patch.versionType)
              ? patch.versionType
              : (() => {
                  throw new BusinessError(
                    "INVALID_REQUEST",
                    `versionType 只能是 ${SOURCE_VERSION_TYPES.join(" / ")}`,
                  );
                })(),
          }
        : {}),
      ...(patch.relatedSourceIds !== undefined ? { relatedSourceIds: dedupeIds(patch.relatedSourceIds) } : {}),
      ...(patch.workKey !== undefined && patch.workKey !== "" ? { workKey: patch.workKey } : {}),
      updatedAt: this.now().toISOString(),
    };
    // identity 增量更新：PATCH 带来的 doi/arxivId/url/title 变化同步进 identity
    const nextIdentity = buildIdentity({
      ...(updated.identity ?? {}),
      ...identityFieldsOfMetadata(updated.metadata),
    });
    updated.identity = nextIdentity ?? undefined;
    items[index] = updated;
    await this.saveIndex(projectId, items);
    return updated;
  }

  /**
   * 元数据合并写入（导入 / promotion / enrich 用；规则见 metadataMerge.ts：
   * user > resolved > inferred，低可信只填空缺不覆盖）。
   */
  async applyMetadataMerge(
    projectId: string,
    sourceId: string,
    incoming: { metadata: SourceMetadata; provenance: MetadataProvenance },
  ): Promise<SourceItem> {
    const items = await this.list(projectId);
    const index = items.findIndex((item) => item.sourceId === sourceId);
    if (index === -1) {
      throw new NotFoundError("文献", sourceId);
    }
    const current = items[index]!;
    const merged = mergeSourceMetadata(
      { metadata: current.metadata, provenance: current.metadataProvenance },
      { metadata: sanitizeMetadata(incoming.metadata), provenance: incoming.provenance },
    );
    const identity = buildIdentity({
      ...(current.identity ?? {}),
      ...identityFieldsOfMetadata(merged.metadata),
    });
    const updated: SourceItem = {
      ...current,
      metadata: merged.metadata,
      metadataProvenance: merged.provenance,
      ...(identity !== null ? { identity } : {}),
      updatedAt: this.now().toISOString(),
    };
    items[index] = updated;
    await this.saveIndex(projectId, items);
    return updated;
  }

  /**
   * 记录解析结果（parsed/<id>.json + 索引状态同步）。
   * 带 contentHash 防失效：文件内容已变化（hash 不一致）时拒绝写入，避免旧
   * 解析产物被错误复用；老条目（无 contentHash）不校验。
   */
  async setAnalysis(
    projectId: string,
    sourceId: string,
    analysis: PdfAnalysis,
    options: { contentHash?: string } = {},
  ): Promise<SourceItem> {
    const items = await this.list(projectId);
    const index = items.findIndex((item) => item.sourceId === sourceId);
    if (index === -1) {
      throw new NotFoundError("文献", sourceId);
    }
    const current = items[index]!;
    if (
      options.contentHash !== undefined &&
      current.contentHash !== undefined &&
      options.contentHash !== current.contentHash
    ) {
      throw new BusinessError(
        "INVALID_REQUEST",
        `文献 ${sourceId} 的内容已变化（contentHash 不一致），拒绝写入过期解析结果；请对当前内容重新分析`,
      );
    }
    await mkdir(this.parsedDir(projectId), { recursive: true });
    await writeJsonAtomic(
      join(this.parsedDir(projectId), `${sourceId}.json`),
      analysis,
    );
    const status: SourceStatus =
      analysis.status === "ok" ? "available" : analysis.status === "partial" ? "partial" : "failed";
    const updated: SourceItem = {
      ...current,
      status,
      analysis,
      ...(options.contentHash !== undefined ? { analysisHash: options.contentHash } : {}),
      updatedAt: this.now().toISOString(),
    };
    items[index] = updated;
    await this.saveIndex(projectId, items);
    return updated;
  }

  /**
   * 解析产物是否仍然对应当前内容（读取方判定用；无 hash 的老条目视为可信）。
   */
  isAnalysisFresh(item: SourceItem): boolean {
    if (item.contentHash === undefined || item.analysisHash === undefined) {
      return true;
    }
    return item.contentHash === item.analysisHash;
  }

  /** 删除文献（原始文件 + 解析产物 + 索引条目）；metadata-only 条目跳过文件删除 */
  async remove(projectId: string, sourceId: string): Promise<void> {
    const items = await this.list(projectId);
    const item = items.find((candidate) => candidate.sourceId === sourceId);
    if (item === undefined) {
      throw new NotFoundError("文献", sourceId);
    }
    if (item.fileName !== undefined) {
      await rm(join(this.papersDir(projectId), item.fileName), { force: true });
    }
    await rm(join(this.parsedDir(projectId), `${sourceId}.json`), { force: true });
    await this.saveIndex(
      projectId,
      items.filter((candidate) => candidate.sourceId !== sourceId),
    );
  }

  private async saveIndex(projectId: string, items: SourceItem[]): Promise<void> {
    await mkdir(this.projects.sourcesDir(projectId), { recursive: true });
    await writeJsonAtomic(this.indexPath(projectId), { items });
  }
}

/** 文件名安全化：拒绝含路径分隔符的名字；只允许安全字符与扩展名白名单 */
export function sanitizeFileName(name: string): string | undefined {
  if (name.includes("/") || name.includes("\\")) {
    return undefined; // 不做静默扁平化：显式拒绝更安全
  }
  const base = name;
  if (base === "" || base === "." || base === "..") {
    return undefined;
  }
  if (!/^[A-Za-z0-9._-]+$/.test(base)) {
    return undefined;
  }
  const lower = base.toLowerCase();
  if (!ALLOWED_EXTENSIONS.some((extension) => lower.endsWith(extension))) {
    return undefined;
  }
  if (base.length > 150) {
    return undefined;
  }
  return base.replace(/^[.-]+/, (match) => "_".repeat(match.length));
}

function sanitizeMetadata(metadata: SourceMetadata | undefined): SourceMetadata {
  if (metadata === undefined || typeof metadata !== "object" || metadata === null) {
    return {};
  }
  const out: SourceMetadata = {};
  if (typeof metadata.title === "string" && metadata.title.trim() !== "") {
    out.title = metadata.title.trim().slice(0, 500);
  }
  if (
    Array.isArray(metadata.authors) &&
    metadata.authors.every((author) => typeof author === "string")
  ) {
    out.authors = metadata.authors.map((author) => author.trim()).filter(Boolean).slice(0, 20);
  }
  if (typeof metadata.year === "number" && Number.isInteger(metadata.year)) {
    out.year = metadata.year;
  }
  if (typeof metadata.doi === "string" && metadata.doi.trim() !== "") {
    out.doi = metadata.doi.trim().slice(0, 200);
  }
  if (typeof metadata.arxivId === "string" && metadata.arxivId.trim() !== "") {
    out.arxivId = metadata.arxivId.trim().slice(0, 50);
  }
  if (typeof metadata.url === "string" && metadata.url.trim() !== "") {
    out.url = metadata.url.trim().slice(0, 1000);
  }
  if (typeof metadata.venue === "string" && metadata.venue.trim() !== "") {
    out.venue = metadata.venue.trim().slice(0, 200);
  }
  if (typeof metadata.abstract === "string" && metadata.abstract.trim() !== "") {
    out.abstract = metadata.abstract.trim().slice(0, 3000);
  }
  return out;
}

/** metadata → identity 构建输入（原始值；buildIdentity 内部归一化） */
function metadataToIdentityInput(metadata: SourceMetadata): {
  doi?: string;
  arxivId?: string;
  pmid?: string;
  url?: string;
  title?: string;
  authors?: string[];
  year?: number;
} {
  return identityFieldsOfMetadata(metadata);
}

function identityFieldsOfMetadata(metadata: SourceMetadata): {
  doi?: string;
  arxivId?: string;
  url?: string;
  title?: string;
  authors?: string[];
  year?: number;
} {
  const out: {
    doi?: string;
    arxivId?: string;
    url?: string;
    title?: string;
    authors?: string[];
    year?: number;
  } = {};
  if (metadata.doi !== undefined && metadata.doi !== "") {
    out.doi = metadata.doi;
  }
  if (metadata.arxivId !== undefined && metadata.arxivId !== "") {
    out.arxivId = metadata.arxivId;
  }
  if (metadata.url !== undefined && metadata.url !== "") {
    out.url = metadata.url;
  }
  if (metadata.title !== undefined && metadata.title !== "") {
    out.title = metadata.title;
  }
  if (metadata.authors !== undefined && metadata.authors.length > 0) {
    out.authors = metadata.authors;
  }
  if (metadata.year !== undefined) {
    out.year = metadata.year;
  }
  return out;
}

function dedupeIds(ids: string[]): string[] {
  return [...new Set(ids.map((id) => id.trim()).filter((id) => id !== ""))].slice(0, 50);
}
