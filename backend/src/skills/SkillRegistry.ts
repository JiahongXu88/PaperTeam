/**
 * Skill Registry：Skill 作为 PaperTeam 一级资源。
 *
 * PaperTeam 不重新发明 Skill 执行引擎（Pi 官方已有发现 / progressive
 * disclosure / 按需读取）。本层负责：受控安装 / 更新（只从仓库内审计过的
 * approved catalog = seed，pin 完整 commit SHA + LICENSE + PROVENANCE）、元数据、
 * contentHash / bundleHash 校验与篡改自愈、中文简介状态、role + contextScope
 * 路由，以及给 PiRuntimeAdapter 的按会话注入路径。
 *
 * Skill Store 位于 PaperTeam 数据目录（<runtimeRoot>/skills/）：
 *   installed/<id>/         元数据 skill.json + 当前内容副本（人类可读、Pi 可发现）
 *   versions/<id>/<hash>/   不可变版本快照（会话注入的真实路径；更新只新增快照）
 * 不污染用户 ~/.pi；只有 assigned 且 installed 且完整性 ok 的 skill 会被注入
 * 对应会话（progressive disclosure：仅 name/description/location 进 system prompt，
 * 正文由 Agent 按需 read）。
 *
 * M5.3 版本固定语义：会话创建（或 rotation 新 generation）时解析到的快照目录在
 * 会话生命周期内不变；applyUpdate 写新快照并切换「当前」指针，运行中的任务仍
 * 读旧快照。旧快照保留（纯文本，体积可忽略），可审计。
 */

import { cp, mkdir, readFile, readdir, rm, stat } from "node:fs/promises";
import { dirname, join, relative, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

import { NotFoundError, BusinessError } from "../errors.js";
import { writeJsonAtomic } from "../util/atomic.js";
import { sha256Hex } from "../util/hash.js";
import { diffFileSets, diffLines, type FileSnapshot } from "./diff.js";
import { DEFAULT_SKILL_ROUTES, resolveSkillIds, type SkillRoute } from "./routing.js";
import {
  isImmutableRevision,
  parseSkillFrontmatter,
  readSkillMetadata,
  skillContentHash,
  type AgentSkillBinding,
  type SkillAssignment,
  type SkillCatalogEntry,
  type SkillMetadata,
  type SkillUpdatePreview,
  type SkillView,
} from "./types.js";

/** 历史兼容：M4.3 的 role-only 默认绑定（等价于 routes 中 scopePrefix 缺省的条目） */
export const DEFAULT_AGENT_SKILL_BINDINGS: Record<string, string[]> = Object.fromEntries(
  DEFAULT_SKILL_ROUTES.filter((route) => route.scopePrefix === undefined).map((route) => [
    route.role,
    [...route.skillIds],
  ]),
);

/** seed 中允许携带的元数据子集（installedPath/contentHash/时间戳由安装补全） */
export type SeedMetadata = Pick<
  SkillMetadata,
  | "id"
  | "name"
  | "originalDescription"
  | "purpose"
  | "sourceType"
  | "sourceRepo"
  | "sourceRevision"
  | "sourceUrl"
  | "upstreamPath"
  | "upstreamContentHash"
  | "version"
  | "license"
  | "assignedAgents"
  | "allowedTools"
  | "summaryStatus"
  | "wrapperNote"
>;

/**
 * seed skill.json 的最小校验（仓库内审计产物）。external seed 必须 pin
 * 完整 commit SHA + 仓库来源——不允许 main / latest / tag 等会漂移的 revision。
 * 返回 undefined 表示结构非法；revision 不 immutable 单独抛出可读错误由调用方处理。
 */
export function readSeedMetadata(value: unknown, expectedId: string): SeedMetadata | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const str = (field: string): string | undefined => {
    const raw = record[field];
    return typeof raw === "string" && raw !== "" ? raw : undefined;
  };
  const id = str("id");
  const name = str("name");
  const originalDescription = str("originalDescription");
  const sourceType = record["sourceType"];
  if (
    id !== expectedId ||
    name === undefined ||
    originalDescription === undefined ||
    (sourceType !== "builtin" && sourceType !== "external" && sourceType !== "local")
  ) {
    return undefined;
  }
  if (sourceType === "external" && (str("sourceRepo") === undefined || str("sourceRevision") === undefined)) {
    return undefined;
  }
  const summaryStatus = record["summaryStatus"];
  return {
    id,
    name,
    originalDescription,
    ...(str("purpose") !== undefined ? { purpose: str("purpose") } : {}),
    sourceType,
    ...(str("sourceRepo") !== undefined ? { sourceRepo: str("sourceRepo") } : {}),
    ...(str("sourceRevision") !== undefined ? { sourceRevision: str("sourceRevision") } : {}),
    ...(str("sourceUrl") !== undefined ? { sourceUrl: str("sourceUrl") } : {}),
    ...(str("upstreamPath") !== undefined ? { upstreamPath: str("upstreamPath") } : {}),
    ...(str("upstreamContentHash") !== undefined
      ? { upstreamContentHash: str("upstreamContentHash") }
      : {}),
    ...(str("version") !== undefined ? { version: str("version") } : {}),
    ...(str("license") !== undefined ? { license: str("license") } : {}),
    assignedAgents: Array.isArray(record["assignedAgents"])
      ? record["assignedAgents"].filter((item): item is string => typeof item === "string")
      : [],
    allowedTools: Array.isArray(record["allowedTools"])
      ? record["allowedTools"].filter((item): item is string => typeof item === "string")
      : [],
    summaryStatus:
      summaryStatus === "ok" || summaryStatus === "stale" ? summaryStatus : "summary_pending",
    ...(str("wrapperNote") !== undefined ? { wrapperNote: str("wrapperNote") } : {}),
  };
}

export interface SkillRegistryOptions {
  /** Skill Store 根（installed/ 与 versions/ 的父目录） */
  storeRoot: string;
  /** 仓库内审计 seed 目录 = approved catalog（默认 backend/skills/seed） */
  seedsRoot?: string;
  /** 由配置禁用的 skill id（PAPERTEAM_DISABLED_SKILLS；不注入任何会话，仍可展示） */
  disabledSkillIds?: readonly string[];
  /**
   * 已安装 skill 的 seed 内容变化时是否在 ensureInstalled 自动应用（默认 false：
   * 受控更新——只标记 update available，需经 previewUpdate / applyUpdate）。
   */
  autoApplyUpdates?: boolean;
  /** 路由表（测试注入；默认 DEFAULT_SKILL_ROUTES） */
  routes?: readonly SkillRoute[];
  now?: () => Date;
  log?: (message: string) => void;
}

export function defaultSeedsRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // 开发：src/skills → ../../skills/seed；构建后：dist/skills → ../../skills/seed
  return resolve(here, "..", "..", "skills", "seed");
}

/** seed 校验结果（安装 / 更新预览共用） */
interface ValidatedSeed {
  id: string;
  dir: string;
  metadata: SeedMetadata;
  skillMd: string;
  contentHash: string;
  bundleHash: string;
  files: FileSnapshot[];
}

const SEED_REQUIRED_EXTERNAL_FILES = ["LICENSE", "PROVENANCE.md"] as const;

export class SkillRegistry {
  private readonly storeRoot: string;
  private readonly seedsRoot: string;
  private readonly disabled: Set<string>;
  private readonly autoApplyUpdates: boolean;
  private readonly routes: readonly SkillRoute[];
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  /** 内存缓存（skillDirsForAgent 的同步查询源；ensureInstalled/list 时刷新） */
  private cache: SkillView[] = [];

  constructor(options: SkillRegistryOptions) {
    this.storeRoot = resolve(options.storeRoot);
    this.seedsRoot = resolve(options.seedsRoot ?? defaultSeedsRoot());
    this.disabled = new Set(options.disabledSkillIds ?? []);
    this.autoApplyUpdates = options.autoApplyUpdates ?? false;
    this.routes = options.routes ?? DEFAULT_SKILL_ROUTES;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  get installedRoot(): string {
    return join(this.storeRoot, "installed");
  }

  get versionsRoot(): string {
    return join(this.storeRoot, "versions");
  }

  /** 不可变版本快照目录 */
  versionDir(id: string, contentHash: string): string {
    return join(this.versionsRoot, id, contentHash);
  }

  // ---- 安装 / 自愈 ----

  /**
   * 启动时对 approved catalog 逐项处理（幂等）：
   * - 未安装 → 安装；
   * - 已安装但安装目录被篡改 → 自愈（优先版本快照，其次 seed）；
   * - 已安装且 seed 变化 → 默认只标记 update available（autoApplyUpdates 时应用）。
   * 单个 seed 损坏只跳过该 skill，不阻塞 Backend 启动。
   */
  async ensureInstalled(): Promise<SkillView[]> {
    const seeds = await this.listSeedIds();
    for (const id of seeds) {
      try {
        const existing = await this.readMetadataFile(id);
        if (existing === null) {
          await this.installFromSeed(id, null);
          continue;
        }
        const healed = await this.healIfTampered(id, existing);
        if (this.autoApplyUpdates) {
          const seed = await this.validateSeed(id);
          if (seed.contentHash !== (healed ?? existing).contentHash) {
            await this.installFromSeed(id, healed ?? existing);
          }
        }
      } catch (error) {
        this.log(`[skills] seed ${id} 处理失败，已跳过：${error instanceof Error ? error.message : String(error)}`);
      }
    }
    const views = await this.list();
    const updates = views.filter((view) => view.update?.available === true).map((view) => view.id);
    if (updates.length > 0) {
      this.log(`[skills] ${updates.length} 个 skill 有可用更新（需在 Skills 页预览并应用）：${updates.join(", ")}`);
    }
    return views;
  }

  /** approved catalog（seed 列表 + 安装状态） */
  async catalog(): Promise<SkillCatalogEntry[]> {
    const ids = await this.listSeedIds();
    const entries: SkillCatalogEntry[] = [];
    for (const id of ids) {
      let seed: ValidatedSeed | undefined;
      try {
        seed = await this.validateSeed(id);
      } catch {
        continue; // 非法 seed 不进入 catalog（启动日志已报）
      }
      const installed = (await this.readMetadataFile(id)) !== null;
      entries.push({
        id,
        name: seed.metadata.name,
        ...(seed.metadata.purpose !== undefined ? { purpose: seed.metadata.purpose } : {}),
        ...(seed.metadata.sourceRepo !== undefined ? { sourceRepo: seed.metadata.sourceRepo } : {}),
        ...(seed.metadata.sourceRevision !== undefined
          ? { sourceRevision: seed.metadata.sourceRevision }
          : {}),
        ...(seed.metadata.license !== undefined ? { license: seed.metadata.license } : {}),
        installed,
      });
    }
    return entries.sort((a, b) => a.id.localeCompare(b.id));
  }

  /**
   * 安装 approved catalog 中的 skill（幂等：已安装直接返回）。
   * 只接受 seed id——没有任意 URL / 路径输入面。
   */
  async install(id: string): Promise<SkillView> {
    if (!(await this.seedExists(id))) {
      throw new NotFoundError("approved Skill", id);
    }
    const existing = await this.readMetadataFile(id);
    if (existing === null) {
      await this.installFromSeed(id, null);
    }
    const view = await this.get(id);
    if (view === null) {
      throw new BusinessError("INTERNAL_ERROR", `skill 安装后不可读：${id}`);
    }
    await this.list();
    return view;
  }

  /** 更新预览：current / candidate hash + revision + 文件级 diff + SKILL.md 行 diff */
  async previewUpdate(id: string): Promise<SkillUpdatePreview> {
    const existing = await this.readMetadataFile(id);
    if (existing === null) {
      throw new NotFoundError("Skill", id);
    }
    const seed = await this.validateSeed(id);
    const currentDir = this.versionDir(id, existing.contentHash);
    const currentFiles = await this.snapshotFiles(currentDir).catch(() => [] as FileSnapshot[]);
    const currentSkillMd = await readFile(join(currentDir, "SKILL.md"), "utf8").catch(() => "");
    return {
      id,
      currentHash: existing.contentHash,
      candidateHash: seed.contentHash,
      ...(existing.sourceRevision !== undefined ? { currentRevision: existing.sourceRevision } : {}),
      ...(seed.metadata.sourceRevision !== undefined
        ? { candidateRevision: seed.metadata.sourceRevision }
        : {}),
      ...(existing.bundleHash !== undefined ? { currentBundleHash: existing.bundleHash } : {}),
      candidateBundleHash: seed.bundleHash,
      files: diffFileSets(currentFiles, seed.files),
      skillMdDiff: diffLines(currentSkillMd, seed.skillMd),
    };
  }

  /**
   * 应用审计过的更新（seed → 新版本快照 + 切换当前指针）。
   * 无更新时幂等返回。运行中的会话继续使用旧快照（版本固定语义）。
   */
  async applyUpdate(id: string): Promise<SkillView> {
    const existing = await this.readMetadataFile(id);
    if (existing === null) {
      throw new NotFoundError("Skill", id);
    }
    const seed = await this.validateSeed(id);
    if (seed.contentHash !== existing.contentHash || seed.bundleHash !== existing.bundleHash) {
      await this.installFromSeed(id, existing);
      this.log(
        `[skills] 已应用更新：${id} ${existing.contentHash.slice(0, 12)} → ${seed.contentHash.slice(0, 12)}`,
      );
    }
    await this.list();
    const view = await this.get(id);
    if (view === null) {
      throw new BusinessError("INTERNAL_ERROR", `skill 更新后不可读：${id}`);
    }
    return view;
  }

  /** 审计材料：PROVENANCE.md / LICENSE / 上游快照校验（来自当前版本快照） */
  async provenance(id: string): Promise<{
    id: string;
    contentHash: string;
    provenance: string;
    license: string;
    upstreamSnapshot?: { file: string; sha256: string; matchesRecorded: boolean | null };
  }> {
    const existing = await this.readMetadataFile(id);
    if (existing === null) {
      throw new NotFoundError("Skill", id);
    }
    const dir = this.versionDir(id, existing.contentHash);
    const provenance = await readFile(join(dir, "PROVENANCE.md"), "utf8").catch(() => "");
    const license = await readFile(join(dir, "LICENSE"), "utf8").catch(() => "");
    const upstream = await readFile(join(dir, "UPSTREAM_SKILL.md"), "utf8").catch(() => undefined);
    return {
      id,
      contentHash: existing.contentHash,
      provenance,
      license,
      ...(upstream !== undefined
        ? {
            upstreamSnapshot: {
              file: "UPSTREAM_SKILL.md",
              sha256: skillContentHash(upstream),
              matchesRecorded:
                existing.upstreamContentHash !== undefined
                  ? skillContentHash(upstream) === existing.upstreamContentHash
                  : null,
            },
          }
        : {}),
    };
  }

  // ---- 查询 ----

  /** 列出全部已安装 skill（现场校验完整性 / 更新可用性；刷新缓存） */
  async list(): Promise<SkillView[]> {
    let ids: string[];
    try {
      const entries = await readdir(this.installedRoot, { withFileTypes: true });
      ids = entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      this.cache = [];
      return [];
    }
    const out: SkillView[] = [];
    for (const id of ids) {
      const view = await this.get(id);
      if (view !== null) {
        out.push(view);
      }
    }
    this.cache = out.sort((a, b) => a.id.localeCompare(b.id));
    return [...this.cache];
  }

  async get(id: string): Promise<SkillView | null> {
    const metadata = await this.readMetadataFile(id);
    if (metadata === null) {
      return null;
    }
    return this.buildView(metadata);
  }

  /** 中文简介落盘（SkillSummaryService 调用） */
  async saveSummary(id: string, summary: string): Promise<SkillMetadata | null> {
    const metadata = await this.readMetadataFile(id);
    if (metadata === null) {
      return null;
    }
    const updated: SkillMetadata = {
      ...metadata,
      chineseSummary: summary,
      summaryStatus: "ok",
      updatedAt: this.now().toISOString(),
    };
    await this.writeMetadata(id, updated);
    await this.list();
    return updated;
  }

  // ---- 路由 / 注入 ----

  /**
   * 解析某会话应注入的 Skill 版本引用（同步读缓存）：role + contextScope 路由 →
   * installed 且完整性 ok 且未被配置禁用的子集，指向不可变版本快照目录。
   */
  skillAssignmentsFor(role: string, contextScope?: string): SkillAssignment[] {
    const ids = resolveSkillIds(role, contextScope, this.routes);
    if (ids.length === 0) {
      return [];
    }
    const byId = new Map(this.cache.map((view) => [view.id, view]));
    const out: SkillAssignment[] = [];
    for (const id of ids) {
      const view = byId.get(id);
      if (
        view === undefined ||
        view.status !== "installed" ||
        view.integrity !== "ok" ||
        view.disabledByConfig
      ) {
        continue;
      }
      out.push({
        id: view.id,
        ...(view.sourceRevision !== undefined ? { sourceRevision: view.sourceRevision } : {}),
        contentHash: view.contentHash,
        dir: this.versionDir(view.id, view.contentHash),
      });
    }
    return out;
  }

  /** 注入 Pi Session 的 skill 目录（向后兼容：role-only 调用仍有效） */
  skillDirsForAgent(role: string, contextScope?: string): string[] {
    return this.skillAssignmentsFor(role, contextScope).map((assignment) => assignment.dir);
  }

  /** 供异步场景使用（刷新缓存并返回） */
  async refreshSkillDirsForAgent(role: string, contextScope?: string): Promise<string[]> {
    await this.list();
    return this.skillDirsForAgent(role, contextScope);
  }

  /** Agent ↔ Skill 绑定表（role + contextScope 粒度；展示/API 用） */
  bindings(): AgentSkillBinding[] {
    return this.routes.map((route) => ({
      agentRole: route.role,
      ...(route.scopePrefix !== undefined ? { contextScope: route.scopePrefix } : {}),
      skillIds: [...route.skillIds],
    }));
  }

  // ---- 内部：seed ----

  private async listSeedIds(): Promise<string[]> {
    try {
      const entries = await readdir(this.seedsRoot, { withFileTypes: true });
      return entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => entry.name)
        .sort();
    } catch {
      this.log(`[skills] seed 目录不存在：${this.seedsRoot}`);
      return [];
    }
  }

  private async seedExists(id: string): Promise<boolean> {
    if (!/^[a-z0-9][a-z0-9-]*$/.test(id)) {
      return false;
    }
    try {
      return (await stat(join(this.seedsRoot, id, "skill.json"))).isFile();
    } catch {
      return false;
    }
  }

  /**
   * seed 校验（安装 / 更新 / catalog 共用）：
   * - skill.json 结构合法；SKILL.md 存在；
   * - external：sourceRevision 必须是完整 40 位 SHA（拒绝 main / latest / tag）、
   *   LICENSE 与 PROVENANCE.md 必须存在且非空；
   * - 声明了 upstreamContentHash 时 UPSTREAM_SKILL.md 必须存在且 hash 一致。
   */
  private async validateSeed(id: string): Promise<ValidatedSeed> {
    const dir = join(this.seedsRoot, id);
    const jsonPath = join(dir, "skill.json");
    let parsed: unknown;
    try {
      parsed = JSON.parse(await readFile(jsonPath, "utf8"));
    } catch (error) {
      throw new Error(`seed skill.json 不可读或非法 JSON：${jsonPath}（${error instanceof Error ? error.message : String(error)}）`);
    }
    const metadata = readSeedMetadata(parsed, id);
    if (metadata === undefined) {
      throw new Error(`seed skill.json 非法：${jsonPath}`);
    }
    if (metadata.sourceType === "external") {
      if (!isImmutableRevision(metadata.sourceRevision)) {
        throw new Error(
          `seed ${id} 的 sourceRevision 不是 immutable commit SHA（得到 "${metadata.sourceRevision ?? ""}"；禁止 main/latest/tag）`,
        );
      }
      for (const required of SEED_REQUIRED_EXTERNAL_FILES) {
        const text = await readFile(join(dir, required), "utf8").catch(() => "");
        if (text.trim() === "") {
          throw new Error(`seed ${id} 缺少 ${required}（external skill 必须随附 license 与 provenance）`);
        }
      }
    }
    let skillMd: string;
    try {
      skillMd = await readFile(join(dir, "SKILL.md"), "utf8");
    } catch {
      throw new Error(`seed ${id} 缺少 SKILL.md`);
    }
    if (metadata.upstreamContentHash !== undefined) {
      const upstream = await readFile(join(dir, "UPSTREAM_SKILL.md"), "utf8").catch(() => undefined);
      if (upstream === undefined) {
        throw new Error(`seed ${id} 声明了 upstreamContentHash 但缺少 UPSTREAM_SKILL.md`);
      }
      const actual = skillContentHash(upstream);
      if (actual !== metadata.upstreamContentHash) {
        throw new Error(
          `seed ${id} 的 UPSTREAM_SKILL.md hash 与 skill.json 记录不一致（${actual.slice(0, 12)} ≠ ${metadata.upstreamContentHash.slice(0, 12)}）`,
        );
      }
    }
    const files = await this.snapshotFiles(dir);
    return {
      id,
      dir,
      metadata,
      skillMd,
      contentHash: skillContentHash(skillMd),
      bundleHash: bundleHashOf(files),
      files,
    };
  }

  /** 目录内全部文件快照（排除 skill.json；相对路径 POSIX；内容行尾归一化 hash） */
  private async snapshotFiles(dir: string): Promise<FileSnapshot[]> {
    const out: FileSnapshot[] = [];
    const walk = async (current: string): Promise<void> => {
      const entries = await readdir(current, { withFileTypes: true });
      for (const entry of entries) {
        const full = join(current, entry.name);
        if (entry.isDirectory()) {
          await walk(full);
          continue;
        }
        if (!entry.isFile()) {
          continue;
        }
        const rel = relative(dir, full).split(sep).join("/");
        if (rel === "skill.json") {
          continue;
        }
        const buffer = await readFile(full);
        out.push({
          path: rel,
          bytes: buffer.byteLength,
          sha256: skillContentHash(buffer.toString("utf8")),
        });
      }
    };
    await walk(dir);
    return out.sort((a, b) => a.path.localeCompare(b.path));
  }

  /**
   * 从 seed 安装 / 更新：写不可变版本快照 → 更新 installed/<id>/ 当前副本 →
   * 写 skill.json → 安装后重新校验 hash / provenance。
   */
  private async installFromSeed(id: string, existing: SkillMetadata | null): Promise<SkillMetadata> {
    const seed = await this.validateSeed(id);
    const versionDir = this.versionDir(id, seed.contentHash);
    // 版本快照：目录已存在且 hash 一致 → 不重写（不可变）；否则（首次 / 损坏）重建
    const snapshotOk = await this.snapshotIntact(versionDir, seed.contentHash);
    if (!snapshotOk) {
      await rm(versionDir, { recursive: true, force: true });
      await mkdir(versionDir, { recursive: true });
      await cp(seed.dir, versionDir, { recursive: true, force: true });
      await rm(join(versionDir, "skill.json"), { force: true });
    }
    // 当前内容副本（人类可读 + Pi loadSkillsFromDir 可发现）
    const targetDir = join(this.installedRoot, id);
    await mkdir(targetDir, { recursive: true });
    await cp(seed.dir, targetDir, { recursive: true, force: true });

    const timestamp = this.now().toISOString();
    const unchangedContent = existing !== null && existing.contentHash === seed.contentHash;
    const metadata: SkillMetadata = {
      id: seed.metadata.id,
      name: seed.metadata.name,
      originalDescription: seed.metadata.originalDescription,
      ...(seed.metadata.purpose !== undefined ? { purpose: seed.metadata.purpose } : {}),
      sourceType: seed.metadata.sourceType,
      ...(seed.metadata.sourceRepo !== undefined ? { sourceRepo: seed.metadata.sourceRepo } : {}),
      ...(seed.metadata.sourceRevision !== undefined
        ? { sourceRevision: seed.metadata.sourceRevision }
        : {}),
      ...(seed.metadata.sourceUrl !== undefined ? { sourceUrl: seed.metadata.sourceUrl } : {}),
      ...(seed.metadata.upstreamPath !== undefined ? { upstreamPath: seed.metadata.upstreamPath } : {}),
      ...(seed.metadata.upstreamContentHash !== undefined
        ? { upstreamContentHash: seed.metadata.upstreamContentHash }
        : {}),
      ...(seed.metadata.version !== undefined ? { version: seed.metadata.version } : {}),
      ...(seed.metadata.license !== undefined ? { license: seed.metadata.license } : {}),
      installedPath: `installed/${id}`,
      contentHash: seed.contentHash,
      bundleHash: seed.bundleHash,
      status: "installed",
      installedAt: existing !== null ? existing.installedAt : timestamp,
      updatedAt: timestamp,
      assignedAgents: seed.metadata.assignedAgents,
      allowedTools: seed.metadata.allowedTools,
      // 内容变化 → 旧简介失效，标 stale 待重生成；内容不变保留既有简介状态
      summaryStatus: unchangedContent
        ? existing!.summaryStatus
        : existing !== null && existing.chineseSummary !== undefined
          ? "stale"
          : seed.metadata.summaryStatus,
      ...(existing !== null && existing.chineseSummary !== undefined
        ? { chineseSummary: existing.chineseSummary }
        : {}),
      ...(seed.metadata.wrapperNote !== undefined ? { wrapperNote: seed.metadata.wrapperNote } : {}),
    };
    await this.writeMetadata(id, metadata);

    // 安装后校验：快照 hash / license / provenance 必须与记录一致
    if (!(await this.snapshotIntact(versionDir, seed.contentHash))) {
      throw new Error(`skill ${id} 安装后快照校验失败：${versionDir}`);
    }
    if (metadata.sourceType === "external") {
      for (const required of SEED_REQUIRED_EXTERNAL_FILES) {
        const text = await readFile(join(versionDir, required), "utf8").catch(() => "");
        if (text.trim() === "") {
          throw new Error(`skill ${id} 安装后缺少 ${required}`);
        }
      }
    }
    this.log(
      `[skills] ${existing === null ? "安装" : "更新"} skill：${id}（rev=${metadata.sourceRevision?.slice(0, 7) ?? "?"} hash=${metadata.contentHash.slice(0, 12)}）`,
    );
    return metadata;
  }

  /** 版本快照是否完整（SKILL.md 存在且 hash 一致） */
  private async snapshotIntact(versionDir: string, contentHash: string): Promise<boolean> {
    try {
      const skillMd = await readFile(join(versionDir, "SKILL.md"), "utf8");
      return skillContentHash(skillMd) === contentHash;
    } catch {
      return false;
    }
  }

  /**
   * 篡改自愈：installed/<id>/SKILL.md 或版本快照与记录 hash 不一致 →
   * 用完整的一方恢复另一方；两者都坏 → 按 seed 重装（记录 hash 若与 seed 一致
   * 则等价于恢复）。返回恢复后的元数据（无需处理返回 null）。
   */
  private async healIfTampered(id: string, existing: SkillMetadata): Promise<SkillMetadata | null> {
    const installedDir = join(this.installedRoot, id);
    const versionDir = this.versionDir(id, existing.contentHash);
    const installedOk = await this.snapshotIntact(installedDir, existing.contentHash);
    const versionOk = await this.snapshotIntact(versionDir, existing.contentHash);
    if (installedOk && versionOk) {
      return null;
    }
    if (versionOk && !installedOk) {
      // 从不可变快照恢复当前副本（保留 skill.json）
      await cp(versionDir, installedDir, { recursive: true, force: true });
      this.log(`[skills] ${id} 安装目录被改写，已从版本快照 ${existing.contentHash.slice(0, 12)} 恢复`);
      return existing;
    }
    if (installedOk && !versionOk) {
      await rm(versionDir, { recursive: true, force: true });
      await mkdir(versionDir, { recursive: true });
      await cp(installedDir, versionDir, { recursive: true, force: true });
      await rm(join(versionDir, "skill.json"), { force: true });
      this.log(`[skills] ${id} 版本快照损坏，已从安装目录重建`);
      return existing;
    }
    // 两者都坏：按 seed 重装（seed 是唯一可信来源）
    this.log(`[skills] ${id} 安装目录与版本快照均与记录不一致，按 seed 重装`);
    return this.installFromSeed(id, existing);
  }

  // ---- 内部：视图 ----

  private async buildView(metadata: SkillMetadata): Promise<SkillView> {
    const versionDir = this.versionDir(metadata.id, metadata.contentHash);
    let skillMd: string | undefined;
    try {
      skillMd = await readFile(join(versionDir, "SKILL.md"), "utf8");
    } catch {
      skillMd = await readFile(join(this.installedRoot, metadata.id, "SKILL.md"), "utf8").catch(
        () => undefined,
      );
    }
    const installedMd = await readFile(join(this.installedRoot, metadata.id, "SKILL.md"), "utf8").catch(
      () => undefined,
    );
    const integrityOk =
      skillMd !== undefined &&
      skillContentHash(skillMd) === metadata.contentHash &&
      installedMd !== undefined &&
      skillContentHash(installedMd) === metadata.contentHash;
    const frontmatter = skillMd !== undefined ? parseSkillFrontmatter(skillMd) : undefined;
    let update: SkillView["update"];
    try {
      const seed = await this.validateSeed(metadata.id);
      update = {
        available:
          seed.contentHash !== metadata.contentHash ||
          (metadata.bundleHash !== undefined && seed.bundleHash !== metadata.bundleHash),
        currentHash: metadata.contentHash,
        candidateHash: seed.contentHash,
        ...(metadata.sourceRevision !== undefined ? { currentRevision: metadata.sourceRevision } : {}),
        ...(seed.metadata.sourceRevision !== undefined
          ? { candidateRevision: seed.metadata.sourceRevision }
          : {}),
      };
    } catch {
      update = undefined; // seed 缺失 / 非法：无候选更新
    }
    return {
      ...metadata,
      name: frontmatter?.name ?? metadata.name,
      status: skillMd === undefined ? "disabled" : metadata.status,
      // 与记录不一致 → 已生成的简介失效
      summaryStatus:
        metadata.summaryStatus === "ok" && !integrityOk ? "stale" : metadata.summaryStatus,
      integrity: integrityOk ? "ok" : "tampered",
      disabledByConfig: this.disabled.has(metadata.id),
      ...(update !== undefined ? { update } : {}),
    };
  }

  private async readMetadataFile(id: string): Promise<SkillMetadata | null> {
    try {
      return (
        readSkillMetadata(
          JSON.parse(await readFile(join(this.installedRoot, id, "skill.json"), "utf8")),
        ) ?? null
      );
    } catch {
      return null;
    }
  }

  private async writeMetadata(id: string, metadata: SkillMetadata): Promise<void> {
    await mkdir(join(this.installedRoot, id), { recursive: true });
    await writeJsonAtomic(join(this.installedRoot, id, "skill.json"), metadata);
  }
}

/** 目录 bundle hash：sorted(path + "\n" + sha256(content)) 串接后 sha256 */
function bundleHashOf(files: FileSnapshot[]): string {
  return sha256Hex(files.map((file) => `${file.path}\n${file.sha256}\n`).join(""));
}
