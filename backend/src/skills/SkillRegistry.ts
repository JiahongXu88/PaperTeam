/**
 * Skill Registry（M4.3.6）：Skill 作为 PaperTeam 一级资源。
 *
 * PaperTeam 不重新发明 Skill 执行引擎（Pi 官方已有发现 / progressive
 * disclosure / 按需读取）。本层负责：安装（从仓库内审计过的 seed，pin
 * revision + LICENSE + PROVENANCE）、元数据、contentHash 校验、中文简介
 * 状态、Agent 绑定、以及给 PiRuntimeAdapter 的按角色注入路径。
 *
 * Skill Store 位于 PaperTeam 数据目录（<runtimeRoot>/skills/installed/），
 * 不污染用户 ~/.pi；只有 assigned 且 installed 的 skill 会被注入对应角色
 * 的 Pi Session（progressive disclosure：仅 name/description/location 进
 * system prompt，正文由 Agent 按需 read）。
 */

import { cp, mkdir, readFile, readdir, writeFile } from "node:fs/promises";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { sha256Hex } from "../util/hash.js";
import {
  parseSkillFrontmatter,
  readSkillMetadata,
  type SkillMetadata,
} from "./types.js";

/** 默认 Agent ↔ Skill 绑定（业务定义；写操作留 M5） */
export const DEFAULT_AGENT_SKILL_BINDINGS: Record<string, string[]> = {
  researcher: ["paper-search"],
  citation: ["paper-search", "verify-citations"],
  reviewer: ["verify-citations"],
  writer: [], // Writer 默认不配 citation-verification
};

/**
 * seed skill.json 的最小校验（仓库内审计产物；installedPath/contentHash/
 * installedAt/updatedAt 等由 installSeed 补全）。external seed 必须 pin
 * revision + 仓库来源——不允许无法追溯的"clone latest"。
 */
export function readSeedMetadata(value: unknown, expectedId: string): Partial<SkillMetadata> | undefined {
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
  return value as Partial<SkillMetadata>;
}

export interface SkillRegistryOptions {
  /** Skill Store 根（installed/ 的父目录） */
  storeRoot: string;
  /** 仓库内审计 seed 目录（默认 backend/skills/seed） */
  seedsRoot?: string;
  now?: () => Date;
  log?: (message: string) => void;
}

export function defaultSeedsRoot(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // 开发：src/skills → ../../skills/seed；构建后：dist/skills → ../../skills/seed
  return resolve(here, "..", "..", "skills", "seed");
}

export class SkillRegistry {
  private readonly storeRoot: string;
  private readonly seedsRoot: string;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  /** 内存缓存（skillDirsForAgent 的同步查询源；ensureInstalled/list 时刷新） */
  private cache: SkillMetadata[] = [];

  constructor(options: SkillRegistryOptions) {
    this.storeRoot = resolve(options.storeRoot);
    this.seedsRoot = resolve(options.seedsRoot ?? defaultSeedsRoot());
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  get installedRoot(): string {
    return join(this.storeRoot, "installed");
  }

  /** 从 seed 安装（幂等：hash 一致则跳过；变化则更新并标 stale） */
  async ensureInstalled(): Promise<SkillMetadata[]> {
    const seeds = await this.listSeeds();
    const installed: SkillMetadata[] = [];
    for (const seed of seeds) {
      installed.push(await this.installSeed(seed));
    }
    await this.list();
    return installed;
  }

  private async listSeeds(): Promise<string[]> {
    try {
      const entries = await readdir(this.seedsRoot, { withFileTypes: true });
      return entries.filter((entry) => entry.isDirectory()).map((entry) => entry.name);
    } catch {
      this.log(`[skills] seed 目录不存在：${this.seedsRoot}`);
      return [];
    }
  }

  private async installSeed(id: string): Promise<SkillMetadata> {
    const seedDir = join(this.seedsRoot, id);
    const targetDir = join(this.installedRoot, id);
    const skillMd = await readFile(join(seedDir, "SKILL.md"), "utf8");
    const contentHash = sha256Hex(skillMd);
    const existing = await this.readMetadataFile(id);

    const unchanged =
      existing !== null &&
      existing.contentHash === contentHash &&
      (await this.fileExists(join(targetDir, "SKILL.md")));
    if (unchanged) {
      return this.finalizeMetadata(existing!, skillMd);
    }

    await mkdir(targetDir, { recursive: true });
    // 整目录复制（SKILL.md/LICENSE/PROVENANCE.md/UPSTREAM_SKILL.md 随 seed 走）
    await cp(seedDir, targetDir, { recursive: true, force: true });

    const seedMeta = readSeedMetadata(
      JSON.parse(await readFile(join(seedDir, "skill.json"), "utf8")),
      id,
    );
    if (seedMeta === undefined) {
      throw new Error(`seed skill.json 非法：${join(seedDir, "skill.json")}`);
    }
    const timestamp = this.now().toISOString();
    const metadata: SkillMetadata = {
      id: seedMeta.id!,
      name: seedMeta.name!,
      originalDescription: seedMeta.originalDescription!,
      sourceType: seedMeta.sourceType!,
      ...(seedMeta.sourceRepo !== undefined ? { sourceRepo: seedMeta.sourceRepo } : {}),
      ...(seedMeta.sourceRevision !== undefined ? { sourceRevision: seedMeta.sourceRevision } : {}),
      ...(seedMeta.sourceUrl !== undefined ? { sourceUrl: seedMeta.sourceUrl } : {}),
      ...(seedMeta.version !== undefined ? { version: seedMeta.version } : {}),
      ...(seedMeta.license !== undefined ? { license: seedMeta.license } : {}),
      ...(seedMeta.wrapperNote !== undefined ? { wrapperNote: seedMeta.wrapperNote } : {}),
      installedPath: `installed/${id}`,
      contentHash,
      status: "installed",
      installedAt: existing !== null ? existing.installedAt : timestamp,
      updatedAt: timestamp,
      assignedAgents: seedMeta.assignedAgents ?? [],
      allowedTools: seedMeta.allowedTools ?? [],
      // seed 内容变化 → 旧简介失效，标 stale 待重生成
      summaryStatus:
        existing !== null && existing.contentHash === contentHash
          ? existing.summaryStatus
          : existing !== null
            ? "stale"
            : (seedMeta.summaryStatus ?? "summary_pending"),
      ...(existing !== null && existing.chineseSummary !== undefined && existing.contentHash === contentHash
        ? { chineseSummary: existing.chineseSummary }
        : {}),
    };
    await this.writeMetadata(id, metadata);
    this.log(`[skills] 安装/更新 skill：${id}（rev=${metadata.sourceRevision?.slice(0, 7) ?? "?"}）`);
    return this.finalizeMetadata(metadata, skillMd);
  }

  /** 列出全部已安装 skill（现场校验 hash → summaryStatus 实时派生；刷新缓存） */
  async list(): Promise<SkillMetadata[]> {
    try {
      const entries = await readdir(this.installedRoot, { withFileTypes: true });
      const out: SkillMetadata[] = [];
      for (const entry of entries) {
        if (!entry.isDirectory()) {
          continue;
        }
        const metadata = await this.readMetadataFile(entry.name);
        if (metadata === null) {
          continue;
        }
        try {
          const skillMd = await readFile(join(this.installedRoot, entry.name, "SKILL.md"), "utf8");
          out.push(this.finalizeMetadata(metadata, skillMd));
        } catch {
          out.push({ ...metadata, status: "disabled" });
        }
      }
      this.cache = out.sort((a, b) => a.id.localeCompare(b.id));
      return [...this.cache];
    } catch {
      return [];
    }
  }

  async get(id: string): Promise<SkillMetadata | null> {
    const metadata = await this.readMetadataFile(id);
    if (metadata === null) {
      return null;
    }
    try {
      const skillMd = await readFile(join(this.installedRoot, id, "SKILL.md"), "utf8");
      return this.finalizeMetadata(metadata, skillMd);
    } catch {
      return { ...metadata, status: "disabled" };
    }
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
    return updated;
  }

  /** 注入 Pi Session 的 skill 目录（assigned 且 installed 的角色子集；同步读缓存） */
  skillDirsForAgent(role: string): string[] {
    const bound = DEFAULT_AGENT_SKILL_BINDINGS[role] ?? [];
    if (bound.length === 0) {
      return [];
    }
    return this.cache
      .filter((skill) => bound.includes(skill.id) && skill.status === "installed")
      .map((skill) => join(this.storeRoot, skill.installedPath));
  }

  /** 供异步场景使用（刷新缓存并返回） */
  async refreshSkillDirsForAgent(role: string): Promise<string[]> {
    await this.list();
    return this.skillDirsForAgent(role);
  }

  /** Agent ↔ Skill 绑定表（展示/API 用） */
  bindings(): Array<{ agentRole: string; skillIds: string[] }> {
    return Object.entries(DEFAULT_AGENT_SKILL_BINDINGS).map(([agentRole, skillIds]) => ({
      agentRole,
      skillIds,
    }));
  }

  // ---- 内部 ----

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
    await writeFile(
      join(this.installedRoot, id, "skill.json"),
      JSON.stringify(metadata, null, 2) + "\n",
      "utf8",
    );
  }

  /** 现场校验：SKILL.md 实际 hash 与记录不符 → summary stale / status disabled */
  private finalizeMetadata(metadata: SkillMetadata, skillMd: string): SkillMetadata {
    const actualHash = sha256Hex(skillMd);
    const hashMatches = actualHash === metadata.contentHash;
    const frontmatter = parseSkillFrontmatter(skillMd);
    return {
      ...metadata,
      name: frontmatter.name ?? metadata.name,
      originalDescription: frontmatter.description ?? metadata.originalDescription,
      summaryStatus:
        metadata.summaryStatus === "ok" && !hashMatches ? "stale" : metadata.summaryStatus,
    };
  }

  private async fileExists(path: string): Promise<boolean> {
    try {
      await readFile(path, "utf8");
      return true;
    } catch {
      return false;
    }
  }
}
