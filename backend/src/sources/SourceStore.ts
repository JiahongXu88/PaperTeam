/**
 * 项目文献库 SourceStore（M3.1）。
 *
 * 存储布局（PRD §5.5 / §6）：
 *   sources/papers/<sourceId>-<安全文件名>   原始文件（PDF / BibTeX 等）
 *   sources/parsed/<sourceId>.json           解析产物（PDF 分析摘要等）
 *   sources/index.json                       条目索引（原子重写）
 *
 * sourceRole（D-0012）：evidence（证据来源）/ reference（参考范文）/ both。
 * 解析失败不破坏项目：analysis.status=failed，条目保留可重试。
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BusinessError } from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { writeJsonAtomic } from "../util/atomic.js";
import type { PdfAnalysis } from "./PdfAnalyzer.js";

export type SourceRole = "evidence" | "reference" | "both";
export type SourceOrigin = "USER_ADDED" | "AGENT_RETRIEVED";
export type SourceStatus = "pending" | "available" | "partial" | "failed" | "rejected";

export interface SourceMetadata {
  title?: string;
  authors?: string[];
  year?: number;
  doi?: string;
  url?: string;
  venue?: string;
}

export interface SourceItem {
  sourceId: string;
  /** 存储文件名（sources/papers/ 下，不含路径） */
  fileName: string;
  originalName?: string;
  sourceRole: SourceRole;
  origin: SourceOrigin;
  status: SourceStatus;
  preferred: boolean;
  metadata: SourceMetadata;
  /** 最近一次解析产物（builtin 文本层 / multimodal 扩展） */
  analysis?: PdfAnalysis;
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

export interface SourceStoreOptions {
  now?: () => Date;
}

const SOURCE_ROLES: readonly SourceRole[] = ["evidence", "reference", "both"];
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

  /** 添加文献（写原始文件 + 索引条目；状态 pending，等待解析） */
  async add(projectId: string, input: AddSourceInput): Promise<SourceItem> {
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
    const role = input.sourceRole ?? "both";
    if (!SOURCE_ROLES.includes(role)) {
      throw new BusinessError("INVALID_REQUEST", `sourceRole 只能是 ${SOURCE_ROLES.join(" / ")}`);
    }

    const items = await this.list(projectId);
    const sourceId = `S${String(items.length + 1).padStart(3, "0")}`;
    const timestamp = this.now().toISOString();
    const item: SourceItem = {
      sourceId,
      fileName: `${sourceId}-${safeName}`,
      originalName: input.fileName,
      sourceRole: role,
      origin: input.origin ?? "USER_ADDED",
      status: "pending",
      preferred: input.preferred ?? false,
      metadata: sanitizeMetadata(input.metadata),
      bytes: input.content.byteLength,
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await mkdir(this.papersDir(projectId), { recursive: true });
    await writeFile(join(this.papersDir(projectId), item.fileName), input.content);
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
      throw new BusinessError("INVALID_REQUEST", `文献不存在：${sourceId}`);
    }
    return item;
  }

  async list(projectId: string): Promise<SourceItem[]> {
    try {
      const raw = await readFile(this.indexPath(projectId), "utf8");
      const parsed = JSON.parse(raw) as { items?: SourceItem[] };
      if (typeof parsed === "object" && parsed !== null && Array.isArray(parsed.items)) {
        return parsed.items.filter(
          (item) => typeof item === "object" && item !== null && typeof item.sourceId === "string",
        );
      }
      return [];
    } catch {
      return [];
    }
  }

  /** 原始文件绝对路径（供分析器 / Agent 读取） */
  async filePath(projectId: string, sourceId: string): Promise<string> {
    const item = await this.getRequired(projectId, sourceId);
    return join(this.papersDir(projectId), item.fileName);
  }

  /** 更新角色 / 重点参考标记 */
  async update(
    projectId: string,
    sourceId: string,
    patch: { sourceRole?: SourceRole; preferred?: boolean; metadata?: SourceMetadata },
  ): Promise<SourceItem> {
    const items = await this.list(projectId);
    const index = items.findIndex((item) => item.sourceId === sourceId);
    if (index === -1) {
      throw new BusinessError("INVALID_REQUEST", `文献不存在：${sourceId}`);
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
        ? { metadata: { ...current.metadata, ...sanitizeMetadata(patch.metadata) } }
        : {}),
      updatedAt: this.now().toISOString(),
    };
    items[index] = updated;
    await this.saveIndex(projectId, items);
    return updated;
  }

  /** 记录解析结果（parsed/<id>.json + 索引状态同步） */
  async setAnalysis(
    projectId: string,
    sourceId: string,
    analysis: PdfAnalysis,
  ): Promise<SourceItem> {
    const items = await this.list(projectId);
    const index = items.findIndex((item) => item.sourceId === sourceId);
    if (index === -1) {
      throw new BusinessError("INVALID_REQUEST", `文献不存在：${sourceId}`);
    }
    await mkdir(this.parsedDir(projectId), { recursive: true });
    await writeJsonAtomic(
      join(this.parsedDir(projectId), `${sourceId}.json`),
      analysis,
    );
    const status: SourceStatus =
      analysis.status === "ok" ? "available" : analysis.status === "partial" ? "partial" : "failed";
    const updated: SourceItem = {
      ...items[index]!,
      status,
      analysis,
      updatedAt: this.now().toISOString(),
    };
    items[index] = updated;
    await this.saveIndex(projectId, items);
    return updated;
  }

  /** 删除文献（原始文件 + 解析产物 + 索引条目） */
  async remove(projectId: string, sourceId: string): Promise<void> {
    const items = await this.list(projectId);
    const item = items.find((candidate) => candidate.sourceId === sourceId);
    if (item === undefined) {
      throw new BusinessError("INVALID_REQUEST", `文献不存在：${sourceId}`);
    }
    await rm(join(this.papersDir(projectId), item.fileName), { force: true });
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
  if (typeof metadata.url === "string" && metadata.url.trim() !== "") {
    out.url = metadata.url.trim().slice(0, 1000);
  }
  if (typeof metadata.venue === "string" && metadata.venue.trim() !== "") {
    out.venue = metadata.venue.trim().slice(0, 200);
  }
  return out;
}
