/**
 * 论文项目最小文件系统存储。
 *
 * 目录约定（PRD §5.1 的 M2 子集，不为未来功能预建更多空目录）：
 *   {root}/{project-id}/
 *   ├── manuscript/   论文正文（main.tex）
 *   ├── sources/      用户上传与文献原始文件（使用）
 *   ├── evidence/     Evidence Store（后续里程碑使用）
 *   ├── reviews/      审稿结果（后续里程碑使用）
 *   ├── build/        LaTeX 编译输出（paper.pdf 等）
 *   └── project.json  项目元数据
 *
 * 不引入数据库；projectId 与文件名严格校验，禁止路径穿越。
 */

import { randomUUID } from "node:crypto";
import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { isAbsolute, join, resolve, sep } from "node:path";

import {
  BusinessError,
  InvalidProjectIdError,
  InvalidProjectTitleError,
  ProjectNotFoundError,
} from "../errors.js";
import { writeJsonAtomic } from "../util/atomic.js";
import { isWorkflowKind, type WorkflowKind } from "../workflow/kinds.js";

/** 项目状态 */
export type ProjectStatus = "created" | "generated" | "failed";

/** 项目记录的一级工作流类型（与编排层同一组常量） */
export type ProjectWorkflowKind = WorkflowKind;

/**
 * 目标定位（PRD §5.4）：三个维度分开表达，不使用单一 paperLevel。
 * 取值为自由字符串（长度受限）；DOCUMENT_TYPES / TARGET_PROFILES 只是
 * 前端与 Prompt 使用的建议值集合，不在存储层冻结 enum。
 */
export const DOCUMENT_TYPES: readonly string[] = [
  "undergraduate_thesis",
  "master_thesis",
  "doctoral_thesis",
  "journal_article",
  "conference_paper",
];

export const TARGET_PROFILES: readonly string[] = [
  "course_paper",
  "undergraduate_thesis",
  "excellent_undergraduate_thesis",
  "master_thesis",
  "doctoral_thesis",
  "general_journal",
  "core_journal",
  "high_level_journal",
  "general_conference",
  "high_level_conference",
  "top_conference",
  "top_journal",
];

/** project.json 的结构（schemaVersion 用于后续兼容性判断） */
export interface ProjectMetadata {
  schemaVersion: 1;
  id: string;
  title: string;
  createdAt: string;
  updatedAt: string;
  status: ProjectStatus;
  /**
   * Runtime 会话引用（Runtime-neutral）。
   * 指向上次生成任务落到的 Agent Runtime 会话（sessionKey），
   * 下次生成原样复用，保证同一 Project 上下文连续、不同 Project 隔离。
   * Project 与 Runtime Session 是两个概念：这里是引用，不是合并。
   */
  runtimeSessionKey?: string;
  /** 一级工作流类型（缺省视为 idea_to_paper，向后兼容） */
  workflowKind?: ProjectWorkflowKind;
  /**
   * 生命周期：归档时间（独立于 status 的业务执行状态）。
   * 存在 = 已归档（默认项目列表不显示）；清除 = 恢复为活跃项目。
   */
  archivedAt?: string;
  /** 研究资料元数据（PRD §5.2） */
  researchIdea?: string;
  researchField?: string;
  documentType?: string;
  targetProfile?: string;
  targetVenue?: string;
  language?: string;
}

/** 创建项目时可提供的研究定位字段（全部可选、经同一套校验） */
export interface ProjectResearchMetaInput {
  workflowKind?: ProjectWorkflowKind;
  researchIdea?: string;
  researchField?: string;
  documentType?: string;
  targetProfile?: string;
  targetVenue?: string;
  language?: string;
}

/** 合法 projectId：小写字母/数字开头，允许连字符，长度 1-64 */
const PROJECT_ID_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}$/;

const TITLE_MAX_LENGTH = 200;

/** 每个项目的固定子目录 */
export const PROJECT_DIRECTORIES: readonly string[] = [
  "manuscript",
  "sources",
  "evidence",
  "reviews",
  "build",
  "workflow",
  "research",
];

export interface ProjectStoreOptions {
  /** 项目工作区根目录（绝对路径） */
  root: string;
  /** 可注入时钟（测试用） */
  now?: () => Date;
  /** 可注入 id 生成器（测试用） */
  idFactory?: () => string;
  /** 损坏的 project.json 等只能跳过的问题在此记录（缺省静默） */
  log?: (message: string) => void;
}

export class ProjectStore {
  private readonly root: string;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly log: (message: string) => void;
  /** 每个项目的 read-modify-write 串行队列（并发 PATCH / 状态更新不互相覆盖） */
  private readonly writeQueues = new Map<string, Promise<unknown>>();

  constructor(options: ProjectStoreOptions) {
    if (!isAbsolute(options.root)) {
      throw new Error(`ProjectStore: root 必须是绝对路径（当前为 "${options.root}"）`);
    }
    this.root = resolve(options.root);
    this.now = options.now ?? (() => new Date());
    this.idFactory = options.idFactory ?? defaultProjectId;
    this.log = options.log ?? (() => {});
  }

  /** 根目录（绝对路径） */
  get rootDir(): string {
    return this.root;
  }

  /** 创建项目：生成目录结构与 project.json（可选研究定位字段） */
  async create(title: string, meta: ProjectResearchMetaInput = {}): Promise<ProjectMetadata> {
    const normalizedTitle = normalizeTitle(title);
    const normalizedMeta = normalizeResearchMeta(meta);

    // 根目录首次使用时可能不存在
    await mkdir(this.root, { recursive: true });

    // id 冲突时重试（随机 id 碰撞概率极低，防御性上限）
    let id: string | undefined;
    for (let attempt = 0; attempt < 5; attempt += 1) {
      const candidate = this.idFactory();
      if (!PROJECT_ID_PATTERN.test(candidate)) {
        throw new Error(`ProjectStore: idFactory 产生了非法 projectId："${candidate}"`);
      }
      const dir = this.projectDir(candidate);
      try {
        await mkdir(dir, { recursive: false });
        id = candidate;
        break;
      } catch (error) {
        if (!isDirectoryExistsError(error)) {
          throw error;
        }
        // 目录已存在（id 冲突）→ 换一个 id 重试
      }
    }
    if (id === undefined) {
      throw new Error("ProjectStore: 无法生成未占用的项目 id（连续冲突 5 次）");
    }

    await Promise.all(
      PROJECT_DIRECTORIES.map((name) =>
        mkdir(join(this.projectDir(id), name), { recursive: true }),
      ),
    );

    const timestamp = this.now().toISOString();
    const metadata: ProjectMetadata = {
      schemaVersion: 1,
      id,
      title: normalizedTitle,
      createdAt: timestamp,
      updatedAt: timestamp,
      status: "created",
      ...normalizedMeta,
    };
    await this.writeMetadata(metadata);
    return metadata;
  }

  /** 读取项目元数据；不存在返回 null（project.json 损坏同样视为不存在，但记录日志） */
  async get(projectId: string): Promise<ProjectMetadata | null> {
    const dir = this.projectDir(projectId);
    let raw: string;
    try {
      raw = await readFile(join(dir, "project.json"), "utf8");
    } catch (error) {
      if (!isNotFoundError(error)) {
        this.log(`[projects] 读取 ${projectId}/project.json 失败：${errorText(error)}`);
      }
      return null;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      this.log(`[projects] ${projectId}/project.json 不是合法 JSON，已跳过`);
      return null;
    }
    const metadata = normalizeMetadata(parsed);
    if (metadata === null) {
      this.log(`[projects] ${projectId}/project.json 缺少必需字段，已跳过`);
    }
    return metadata;
  }

  /** 读取项目元数据；不存在或 id 非法时抛业务错误 */
  async getRequired(projectId: string): Promise<ProjectMetadata> {
    const metadata = await this.get(projectId);
    if (metadata === null) {
      throw new ProjectNotFoundError(projectId);
    }
    return metadata;
  }

  /** 更新项目状态（写回 project.json） */
  updateStatus(projectId: string, status: ProjectStatus): Promise<ProjectMetadata> {
    return this.mutate(projectId, (metadata) => ({ ...metadata, status }));
  }

  /** 更新研究定位字段（PATCH 语义：只改传入的字段；title 一并可改） */
  async updateMeta(
    projectId: string,
    patch: ProjectResearchMetaInput & { title?: string },
  ): Promise<ProjectMetadata> {
    // 先校验再进队列：非法输入不占用写锁
    const normalized = normalizeResearchMeta(patch);
    const title = patch.title !== undefined ? normalizeTitle(patch.title) : undefined;
    return this.mutate(projectId, (metadata) => ({
      ...metadata,
      ...(title !== undefined ? { title } : {}),
      ...normalized,
    }));
  }

  /**
   * 记录 / 更新 Runtime 会话引用：传入 undefined 清除引用。
   * 值由 Runtime 层产生（sessionKey），ProjectStore 只做存储，不理解其格式。
   */
  updateRuntimeSessionKey(
    projectId: string,
    runtimeSessionKey: string | undefined,
  ): Promise<ProjectMetadata> {
    return this.mutate(projectId, (metadata) => {
      const { runtimeSessionKey: _previous, ...rest } = metadata;
      return runtimeSessionKey !== undefined ? { ...rest, runtimeSessionKey } : rest;
    });
  }

  // ---- 生命周期：归档 / 恢复 / 永久删除 ----

  /** 归档项目（幂等：已归档时保持原 archivedAt 不变） */
  archive(projectId: string): Promise<ProjectMetadata> {
    return this.mutate(projectId, (metadata) =>
      metadata.archivedAt !== undefined
        ? null
        : { ...metadata, archivedAt: this.now().toISOString() },
    );
  }

  /** 恢复项目（幂等：未归档时原样返回） */
  restore(projectId: string): Promise<ProjectMetadata> {
    return this.mutate(projectId, (metadata) => {
      if (metadata.archivedAt === undefined) {
        return null;
      }
      const { archivedAt: _archivedAt, ...rest } = metadata;
      return rest;
    });
  }

  /**
   * 永久删除项目工作区（整个 {root}/{projectId}/ 目录：PDF / parsed /
   * citations / reviews / workflow checkpoints / manuscript / build / 元数据）。
   * 不可恢复。调用方（HTTP 层）负责前置校验：必须已归档且无进行中任务。
   */
  async delete(projectId: string): Promise<void> {
    const dir = this.projectDir(projectId);
    await rm(dir, { recursive: true, force: true });
  }

  // ---- 路径工具（全部经过 projectId 校验与包含性检查） ----

  /** 项目根目录（先校验 id，再做路径包含检查） */
  projectDir(projectId: string): string {
    validateProjectId(projectId);
    const dir = resolve(this.root, projectId);
    if (dir !== this.root && !dir.startsWith(this.root + sep)) {
      // resolve 后越出 root：理论上被正则拦截，双保险
      throw new InvalidProjectIdError(projectId);
    }
    return dir;
  }

  manuscriptDir(projectId: string): string {
    return join(this.projectDir(projectId), "manuscript");
  }

  buildDir(projectId: string): string {
    return join(this.projectDir(projectId), "build");
  }

  sourcesDir(projectId: string): string {
    return join(this.projectDir(projectId), "sources");
  }

  evidenceDir(projectId: string): string {
    return join(this.projectDir(projectId), "evidence");
  }

  reviewsDir(projectId: string): string {
    return join(this.projectDir(projectId), "reviews");
  }

  researchDir(projectId: string): string {
    return join(this.projectDir(projectId), "research");
  }

  /** WorkflowRun 状态根目录（Authoritative State，PRD §5.5 workflow/） */
  workflowDir(projectId: string): string {
    return join(this.projectDir(projectId), "workflow");
  }

  mainTexPath(projectId: string): string {
    return join(this.manuscriptDir(projectId), "main.tex");
  }

  paperPdfPath(projectId: string): string {
    return join(this.buildDir(projectId), "paper.pdf");
  }

  /** 列出全部项目 id（依据目录名 + project.json 可解析） */
  async list(): Promise<string[]> {
    return (await this.readAll()).map((metadata) => metadata.id);
  }

  /**
   * 列出项目元数据（GET /api/projects 用）。
   * scope：active（默认，未归档）/ archived（已归档）/ all。
   * 按 updatedAt 降序（最近更新在前，id 作稳定 tie-break）；
   * project.json 损坏的目录静默跳过（与 list 一致）。
   */
  async listMetadata(
    scope: "active" | "archived" | "all" = "active",
  ): Promise<ProjectMetadata[]> {
    const metadata: ProjectMetadata[] = [];
    for (const project of await this.readAll()) {
      const archived = project.archivedAt !== undefined;
      if ((scope === "archived" && !archived) || (scope === "active" && archived)) {
        continue;
      }
      metadata.push(project);
    }
    return metadata.sort(
      (a, b) => b.updatedAt.localeCompare(a.updatedAt) || b.id.localeCompare(a.id),
    );
  }

  /** 读取全部可解析的 project.json（目录名非法 / 文件损坏的跳过） */
  private async readAll(): Promise<ProjectMetadata[]> {
    let entries: readonly string[];
    try {
      entries = await readdir(this.root);
    } catch {
      return [];
    }
    const projects: ProjectMetadata[] = [];
    for (const entry of entries.filter((name) => PROJECT_ID_PATTERN.test(name)).sort()) {
      const metadata = await this.get(entry);
      if (metadata !== null) {
        projects.push(metadata);
      }
    }
    return projects;
  }

  /**
   * 串行化的 read-modify-write：同一项目的并发更新排队执行，后者基于前者的
   * 落盘结果计算。apply 返回 null 表示无需写入（幂等短路）。
   */
  private mutate(
    projectId: string,
    apply: (metadata: ProjectMetadata) => ProjectMetadata | null,
  ): Promise<ProjectMetadata> {
    const previous = this.writeQueues.get(projectId) ?? Promise.resolve();
    const task = previous
      .catch(() => {})
      .then(async () => {
        const metadata = await this.getRequired(projectId);
        const next = apply(metadata);
        if (next === null) {
          return metadata;
        }
        const updated: ProjectMetadata = { ...next, updatedAt: this.now().toISOString() };
        await this.writeMetadata(updated);
        return updated;
      });
    this.writeQueues.set(projectId, task);
    const cleanup = () => {
      if (this.writeQueues.get(projectId) === task) {
        this.writeQueues.delete(projectId);
      }
    };
    task.then(cleanup, cleanup);
    return task;
  }

  /** 写入 project.json（原子：tmp → fsync → rename） */
  private async writeMetadata(metadata: ProjectMetadata): Promise<void> {
    await writeJsonAtomic(join(this.projectDir(metadata.id), "project.json"), metadata);
  }
}

/** 生成随机项目 id：p-<12 位十六进制> */
function defaultProjectId(): string {
  return `p-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function validateProjectId(projectId: string): void {
  if (!PROJECT_ID_PATTERN.test(projectId)) {
    throw new InvalidProjectIdError(projectId);
  }
}

function normalizeTitle(title: string): string {
  const trimmed = title.trim();
  if (trimmed === "") {
    throw new InvalidProjectTitleError("标题不能为空");
  }
  if (trimmed.length > TITLE_MAX_LENGTH) {
    throw new InvalidProjectTitleError(`标题长度不能超过 ${TITLE_MAX_LENGTH} 个字符`);
  }
  if (/[\x00-\x1f\x7f]/.test(trimmed)) {
    throw new InvalidProjectTitleError("标题不能包含换行或控制字符");
  }
  return trimmed;
}

/** 防御性解析 project.json（字段缺失/类型错误返回 null；旧版文件缺 M3 字段可读） */
function normalizeMetadata(value: unknown): ProjectMetadata | null {
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  const id = typeof record["id"] === "string" ? record["id"] : undefined;
  const title = typeof record["title"] === "string" ? record["title"] : undefined;
  const createdAt = typeof record["createdAt"] === "string" ? record["createdAt"] : undefined;
  const updatedAt = typeof record["updatedAt"] === "string" ? record["updatedAt"] : undefined;
  const status = record["status"];
  const runtimeSessionKey =
    typeof record["runtimeSessionKey"] === "string" && record["runtimeSessionKey"] !== ""
      ? record["runtimeSessionKey"]
      : undefined;
  const archivedAt =
    typeof record["archivedAt"] === "string" && record["archivedAt"] !== ""
      ? record["archivedAt"]
      : undefined;
  if (
    !id ||
    !PROJECT_ID_PATTERN.test(id) ||
    !title ||
    !createdAt ||
    !updatedAt ||
    (status !== "created" && status !== "generated" && status !== "failed")
  ) {
    return null;
  }
  // 可选研究定位字段：只在合法时保留，非法值静默丢弃（防御性读取）
  const research = readOptionalResearchFields(record);
  const workflowKind = isWorkflowKind(record["workflowKind"])
    ? record["workflowKind"]
    : undefined;
  return {
    schemaVersion: 1,
    id,
    title,
    createdAt,
    updatedAt,
    status,
    ...(runtimeSessionKey !== undefined ? { runtimeSessionKey } : {}),
    ...(archivedAt !== undefined ? { archivedAt } : {}),
    ...(workflowKind !== undefined ? { workflowKind } : {}),
    ...research,
  };
}


/**
 * 研究定位字段长度上限：写入校验与读取校验共用同一张表
 * （两处不一致会让合法写入的值在下次读取时被静默丢弃）。
 */
export const RESEARCH_FIELD_LIMITS = {
  researchIdea: 8000,
  researchField: 200,
  documentType: 100,
  targetProfile: 100,
  targetVenue: 300,
  language: 50,
} as const;

type ResearchField = keyof typeof RESEARCH_FIELD_LIMITS;

/** 读取可选研究定位字段（类型与长度校验，非法返回不包含该字段） */
function readOptionalResearchFields(record: Record<string, unknown>): Partial<ProjectMetadata> {
  const out: Partial<ProjectMetadata> = {};
  for (const field of Object.keys(RESEARCH_FIELD_LIMITS) as ResearchField[]) {
    const raw = record[field];
    if (typeof raw === "string" && raw.trim() !== "" && raw.trim().length <= RESEARCH_FIELD_LIMITS[field]) {
      out[field] = raw.trim();
    }
  }
  return out;
}

function isDirectoryExistsError(error: unknown): boolean {
  return errorCode(error) === "EEXIST";
}

function isNotFoundError(error: unknown): boolean {
  return errorCode(error) === "ENOENT";
}

function errorCode(error: unknown): unknown {
  return typeof error === "object" && error !== null ? (error as { code?: unknown }).code : undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** 校验并归一化研究定位输入（非法值直接抛业务错误） */
function normalizeResearchMeta(meta: ProjectResearchMetaInput): Partial<ProjectMetadata> {
  const out: Partial<ProjectMetadata> = {};
  if (meta.workflowKind !== undefined) {
    if (!isWorkflowKind(meta.workflowKind)) {
      throw new BusinessError("INVALID_REQUEST", `非法的 workflowKind："${meta.workflowKind}"`);
    }
    out.workflowKind = meta.workflowKind;
  }
  for (const [field, maxLength] of Object.entries(RESEARCH_FIELD_LIMITS) as [ResearchField, number][]) {
    const raw = meta[field];
    if (raw === undefined) {
      continue;
    }
    if (typeof raw !== "string") {
      throw new BusinessError("INVALID_REQUEST", `字段 ${field} 必须是字符串`);
    }
    const trimmed = raw.trim();
    if (trimmed === "") {
      continue; // 空串视为「不设置」
    }
    if (trimmed.length > maxLength) {
      throw new BusinessError(
        "INVALID_REQUEST",
        `字段 ${field} 长度不能超过 ${maxLength} 个字符`,
      );
    }
    if (/[\x00-\x08\x0b\x0c\x0e-\x1f\x7f]/.test(trimmed)) {
      throw new BusinessError("INVALID_REQUEST", `字段 ${field} 不能包含控制字符`);
    }
    (out as Record<string, unknown>)[field] = trimmed;
  }
  return out;
}
