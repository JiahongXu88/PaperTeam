/**
 * Skill Registry 领域类型（M4.3.6）。
 *
 * PaperTeam 不重新发明 Skill 执行引擎（Pi 官方已有发现 / progressive
 * disclosure / 按需读取）。PaperTeam 负责：发现、元数据、来源与 license
 * provenance、中文简介、Agent 绑定、前端展示——以及未来安装管理的基础模型。
 *
 * 第三方 Skill ≠ 自动可信：只有经过源码审计的白名单 skill 才允许进入
 * Skill Store（M4.3 仅两项 Academic Skill，均 pin revision + 保留 LICENSE）。
 */

export type SkillSourceType = "builtin" | "external" | "local";

export type SkillStatus = "installed" | "disabled";

/**
 * 中文简介状态：
 *   ok              已生成并持久化
 *   summary_pending 模型不可用，暂未生成（UI 显示原始 description）
 *   stale           SKILL.md contentHash 变化，简介需要重新生成
 */
export type SkillSummaryStatus = "ok" | "summary_pending" | "stale";

/** Skill 元数据（registry 持久化单位；一个 skill 一个目录 + skill.json） */
export interface SkillMetadata {
  /** store 内目录名（即 skill id，如 "verify-citations"） */
  id: string;
  /** SKILL.md frontmatter 的 name */
  name: string;
  /** 原始 description（frontmatter，保留原文） */
  originalDescription: string;
  /** 面向普通用户的中文简介（2-3 句：干什么 / 什么时候有用） */
  chineseSummary?: string;
  sourceType: SkillSourceType;
  /** 来源仓库 "owner/repo"（external 必填） */
  sourceRepo?: string;
  /** pin 的 commit revision（external 必填——不允许 clone latest 无法追溯） */
  sourceRevision?: string;
  /** 来源 URL（repo / 本地路径） */
  sourceUrl?: string;
  version?: string;
  license?: string;
  /** store 内相对路径（installed/<id>） */
  installedPath: string;
  /** SKILL.md 内容 sha256（summary stale 判据） */
  contentHash: string;
  status: SkillStatus;
  installedAt: string;
  updatedAt: string;
  /** 绑定的 Agent 角色（researcher / writer / reviewer / citation） */
  assignedAgents: string[];
  /** 工具假设（元数据记录；Pi 0.84.x 不强制 allowed-tools，由 PaperTeam 工具白名单约束） */
  allowedTools: string[];
  summaryStatus: SkillSummaryStatus;
  /** PaperTeam-compatible wrapper 说明（改写过的第三方 skill 必须注明） */
  wrapperNote?: string;
}

/** Agent 角色 ↔ Skill 绑定（Pi session 构建时只有 assigned skill 被暴露给该角色） */
export interface AgentSkillBinding {
  agentRole: string;
  skillIds: string[];
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
    sourceType,
    ...(str("sourceRepo") !== undefined ? { sourceRepo: str("sourceRepo") } : {}),
    ...(str("sourceRevision") !== undefined ? { sourceRevision: str("sourceRevision") } : {}),
    ...(str("sourceUrl") !== undefined ? { sourceUrl: str("sourceUrl") } : {}),
    ...(str("version") !== undefined ? { version: str("version") } : {}),
    ...(str("license") !== undefined ? { license: str("license") } : {}),
    installedPath,
    contentHash,
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
