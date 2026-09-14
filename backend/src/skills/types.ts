/**
 * Skill Registry 领域类型。
 *
 * PaperTeam 不重新发明 Skill 执行引擎（Pi 官方已有发现 / progressive
 * disclosure / 按需读取）。PaperTeam 负责：发现、元数据、来源与 license
 * provenance、中文简介、Agent 绑定、前端展示、受控安装 / 更新。
 *
 * 第三方 Skill ≠ 自动可信：只有经过源码审计的白名单 skill（仓库内 seed，
 * 均 pin 完整 commit SHA + 保留 LICENSE + PROVENANCE）才允许进入 Skill Store。
 *
 * M5.3 起 Skill 内容以不可变版本快照（versions/<id>/<contentHash>/）注入 Pi
 * Session：更新只影响新 session / 新 generation，运行中的任务不会读到新版。
 */

import { createHash } from "node:crypto";

export type SkillSourceType = "builtin" | "external" | "local";

export type SkillStatus = "installed" | "disabled";

/**
 * 中文简介状态：
 *   ok              已生成并持久化
 *   summary_pending 模型不可用，暂未生成（UI 显示原始 description）
 *   stale           SKILL.md contentHash 变化，简介需要重新生成
 */
export type SkillSummaryStatus = "ok" | "summary_pending" | "stale";

/**
 * 完整性（现场校验；每次 list/get 派生，不持久化）：
 *   ok        安装目录 SKILL.md 与记录的 contentHash 一致
 *   tampered  不一致（被手工改写 / 损坏）→ 不注入任何会话，ensureInstalled 自愈
 */
export type SkillIntegrity = "ok" | "tampered";

/** Skill 元数据（registry 持久化单位；一个 skill 一个目录 + skill.json） */
export interface SkillMetadata {
  /** store 内目录名（即 skill id，如 "verify-citations"） */
  id: string;
  /** SKILL.md frontmatter 的 name */
  name: string;
  /** 原始 description（frontmatter，保留原文；adaptation 场景下为上游原始描述） */
  originalDescription: string;
  /** 面向普通用户的中文简介（2-3 句：干什么 / 什么时候有用；模型生成） */
  chineseSummary?: string;
  /** PaperTeam 撰写的用途说明（审计产物，不依赖模型；UI「用途」列） */
  purpose?: string;
  sourceType: SkillSourceType;
  /** 来源仓库 "owner/repo"（external 必填） */
  sourceRepo?: string;
  /** pin 的 commit revision（external 必填；必须是完整 40 位 SHA，不允许 main/latest/tag） */
  sourceRevision?: string;
  /** 来源 URL（repo / 本地路径） */
  sourceUrl?: string;
  /** 上游仓库内的源文件路径（如 skills/scientific-writing/SKILL.md） */
  upstreamPath?: string;
  /** 上游原件（UPSTREAM_SKILL.md）sha256（审计快照校验） */
  upstreamContentHash?: string;
  version?: string;
  license?: string;
  /** store 内相对路径（installed/<id>；元数据与当前内容副本） */
  installedPath: string;
  /** SKILL.md 内容 sha256（行尾归一化；summary stale / 篡改判据 / 版本快照键） */
  contentHash: string;
  /** 整个 skill 目录（除 skill.json）的 sha256（相对路径 + 内容；更新 diff 判据） */
  bundleHash?: string;
  status: SkillStatus;
  installedAt: string;
  updatedAt: string;
  /** 绑定的 Agent 角色（展示用；实际路由见 routing.ts 的 role + contextScope 规则） */
  assignedAgents: string[];
  /** 工具假设（元数据记录；Pi 0.84.x 不强制 allowed-tools，由 PaperTeam 工具白名单约束） */
  allowedTools: string[];
  summaryStatus: SkillSummaryStatus;
  /** PaperTeam-compatible wrapper / adaptation 说明（改写过的第三方 skill 必须注明） */
  wrapperNote?: string;
}

/** Agent 角色（+ 可选 contextScope 前缀）↔ Skill 绑定（展示 / API 用） */
export interface AgentSkillBinding {
  agentRole: string;
  /** contextScope 前缀（缺省 = 该角色的默认绑定；旧 role-only 调用命中此项） */
  contextScope?: string;
  skillIds: string[];
}

/** 注入某个会话的 Skill 版本引用（assigned 的最小可审计单位） */
export interface SkillAssignment {
  id: string;
  /** pin 的上游 revision（external skill 携带） */
  sourceRevision?: string;
  contentHash: string;
  /** 不可变版本快照目录（绝对路径；Pi additionalSkillPaths 的输入） */
  dir: string;
}

/** 更新可用性（seed 与已安装版本对比；派生视图） */
export interface SkillUpdateStatus {
  available: boolean;
  /** 当前已安装 contentHash */
  currentHash: string;
  /** seed（approved catalog）当前 contentHash */
  candidateHash: string;
  currentRevision?: string;
  candidateRevision?: string;
}

/** 对外视图：元数据 + 现场派生字段 */
export interface SkillView extends SkillMetadata {
  integrity: SkillIntegrity;
  /** 由 PAPERTEAM_DISABLED_SKILLS 配置禁用（不注入任何会话） */
  disabledByConfig: boolean;
  update?: SkillUpdateStatus;
}

/** approved catalog 条目（仓库内审计 seed；可能尚未安装） */
export interface SkillCatalogEntry {
  id: string;
  name: string;
  purpose?: string;
  sourceRepo?: string;
  sourceRevision?: string;
  license?: string;
  installed: boolean;
}

/** 更新预览（应用前必须可见：current / candidate hash、revision、文件级 diff 摘要） */
export interface SkillUpdatePreview {
  id: string;
  currentHash: string;
  candidateHash: string;
  currentRevision?: string;
  candidateRevision?: string;
  currentBundleHash?: string;
  candidateBundleHash: string;
  files: SkillFileChange[];
  /** SKILL.md 行级 diff（有界；unchanged 行不列出） */
  skillMdDiff: SkillLineDiff;
}

export interface SkillFileChange {
  path: string;
  status: "added" | "removed" | "modified" | "unchanged";
  currentBytes?: number;
  candidateBytes?: number;
}

export interface SkillLineDiff {
  added: number;
  removed: number;
  /** 有界样本（最多 200 行；+ 前缀新增，- 前缀删除） */
  hunks: string[];
  truncated: boolean;
}

/** 完整 40 位十六进制 commit SHA（immutable revision 的唯一合法形态） */
export const FULL_COMMIT_SHA = /^[0-9a-f]{40}$/;

export function isImmutableRevision(value: unknown): value is string {
  return typeof value === "string" && FULL_COMMIT_SHA.test(value);
}

/** SKILL.md 内容 hash：行尾归一化（Windows autocrlf 检出与 Linux 一致） */
export function skillContentHash(content: string): string {
  return createHash("sha256").update(content.replace(/\r\n/g, "\n")).digest("hex");
}

/** 防御性读取：registry/skill.json 结构损坏返回 undefined */
export function readSkillMetadata(value: unknown): SkillMetadata | undefined {
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
  const installedPath = str("installedPath");
  const contentHash = str("contentHash");
  const status = record["status"];
  const sourceType = record["sourceType"];
  const summaryStatus = record["summaryStatus"];
  const installedAt = str("installedAt");
  const updatedAt = str("updatedAt");
  if (
    id === undefined ||
    name === undefined ||
    originalDescription === undefined ||
    installedPath === undefined ||
    contentHash === undefined ||
    installedAt === undefined ||
    updatedAt === undefined ||
    (status !== "installed" && status !== "disabled") ||
    (sourceType !== "builtin" && sourceType !== "external" && sourceType !== "local") ||
    (summaryStatus !== "ok" && summaryStatus !== "summary_pending" && summaryStatus !== "stale")
  ) {
    return undefined;
  }
  return {
    id,
    name,
    originalDescription,
    ...(str("chineseSummary") !== undefined ? { chineseSummary: str("chineseSummary") } : {}),
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
    installedPath,
    contentHash,
    ...(str("bundleHash") !== undefined ? { bundleHash: str("bundleHash") } : {}),
    status,
    installedAt,
    updatedAt,
    assignedAgents: Array.isArray(record["assignedAgents"])
      ? record["assignedAgents"].filter((item): item is string => typeof item === "string")
      : [],
    allowedTools: Array.isArray(record["allowedTools"])
      ? record["allowedTools"].filter((item): item is string => typeof item === "string")
      : [],
    summaryStatus,
    ...(str("wrapperNote") !== undefined ? { wrapperNote: str("wrapperNote") } : {}),
  };
}

/**
 * SKILL.md frontmatter 解析（Pi loadSkills 只消费 name/description，
 * PaperTeam registry 需要完整 frontmatter 做元数据；宽松 YAML 子集：
 * key: value 行 + 简单缩进忽略，未知字段保留原文字符串）。
 */
export interface SkillFrontmatter {
  name?: string;
  description?: string;
  license?: string;
  /** 原始 frontmatter 键值（未知字段保留） */
  raw: Record<string, string>;
  /** frontmatter 之后正文 */
  body: string;
}

export function parseSkillFrontmatter(content: string): SkillFrontmatter {
  const normalized = content.replace(/\r\n/g, "\n");
  const match = /^---\n([\s\S]*?)\n---\n?([\s\S]*)$/.exec(normalized);
  if (match === null) {
    return { raw: {}, body: content };
  }
  const raw: Record<string, string> = {};
  let lastKey: string | undefined;
  for (const line of (match[1] ?? "").split("\n")) {
    const entry = /^([A-Za-z0-9_-]+):\s*(.*)$/.exec(line);
    if (entry !== null) {
      const key = entry[1] ?? "";
      const value = (entry[2] ?? "").trim();
      raw[key] = value;
      lastKey = key;
      continue;
    }
    // 多行折叠值（YAML `|` / `>` 或缩进续行）：拼进上一个 key
    const continuation = /^\s+(.+)$/.exec(line);
    if (continuation !== null && lastKey !== undefined) {
      raw[lastKey] = `${raw[lastKey] ?? ""} ${(continuation[1] ?? "").trim()}`.trim();
    }
  }
  const body = (match[2] ?? "").trim();
  return {
    ...(raw["name"] !== undefined ? { name: raw["name"] } : {}),
    ...(raw["description"] !== undefined ? { description: raw["description"] } : {}),
    ...(raw["license"] !== undefined ? { license: raw["license"] } : {}),
    raw,
    body,
  };
}
