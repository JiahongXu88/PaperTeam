/**
 * 模型偏好持久化：`<runtimeRoot>/settings/model.json`。
 *
 * 只存非敏感的模型偏好（默认 "provider/model-id" + 可选的 per-Agent override）；
 * API Key 一律走 Pi 官方 credential storage（agentDir 下 auth.json，经
 * ModelRuntime.login/logout，见 ModelSettingsService）。文件位于 PaperTeam
 * 用户数据目录（~/.paperteam），与仓库目录隔离，不进 Git。
 *
 * 写入走 writeJsonAtomic（tmp → fsync → rename），中断不留半个 JSON；
 * 读取对损坏/缺省文件容错（返回空偏好，不阻塞启动）。
 */

import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { writeJsonAtomic } from "../util/atomic.js";

/**
 * 可独立配置模型的业务 Agent（M5.7）。键以仓库真实角色枚举为准：
 * 三路 Reviewer（academic / fact / style）是同一 agentId 的三个 contextScope，
 * 因此按键（而非 PiRoleKey）区分；citation 是引用语义核验 Agent。
 */
export type AgentModelKey =
  | "writer"
  | "researcher"
  | "academicReviewer"
  | "factReviewer"
  | "styleReviewer"
  | "citationReviewer";

export const AGENT_MODEL_KEYS: readonly AgentModelKey[] = [
  "writer",
  "researcher",
  "academicReviewer",
  "factReviewer",
  "styleReviewer",
  "citationReviewer",
];

function isAgentModelKey(value: unknown): value is AgentModelKey {
  return typeof value === "string" && (AGENT_MODEL_KEYS as readonly string[]).includes(value);
}

/**
 * contextScope（sanitizeContextScope 归一化后）→ 业务 Agent 键。
 * scope 是各 Service 调 runAgent 时的固定常量（见 WriterService / ReviewerService /
 * ResearcherService / CitationIntegrityService / SectionReviewService / PaperMapService）。
 * 返回 undefined = 无对应业务 Agent（default 角色 / 工具型任务）→ 继承全局默认。
 *
 * mapping 说明：分节审稿（review/section/*）与章节摘要（review/summary/*）是
 * Reviewer 的学术性工作面，归 academicReviewer。
 */
export function agentModelKeyForScope(scope: string | undefined): AgentModelKey | undefined {
  if (scope === undefined || scope === "") {
    return undefined;
  }
  if (scope === "writing" || scope.startsWith("writing/")) {
    return "writer";
  }
  if (scope === "research" || scope.startsWith("research/")) {
    return "researcher";
  }
  if (scope === "review/fact" || scope.startsWith("review/fact/")) {
    return "factReviewer";
  }
  if (
    scope === "review/academic" ||
    scope.startsWith("review/academic/") ||
    scope === "review/section" ||
    scope.startsWith("review/section/") ||
    scope === "review/summary" ||
    scope.startsWith("review/summary/")
  ) {
    return "academicReviewer";
  }
  if (scope === "review/style" || scope.startsWith("review/style/")) {
    return "styleReviewer";
  }
  if (scope === "citation" || scope.startsWith("citation/")) {
    return "citationReviewer";
  }
  return undefined;
}

/** 持久化的模型偏好（版本化 schema；v1 只有 model；M5.7 增加可选 agents） */
export interface StoredModelSettings {
  /** 生效默认偏好 "provider/model-id"（缺省 = 未保存） */
  model?: string;
  /**
   * per-Agent 模型 override（M5.7）：值 "provider/model-id"；
   * 缺省键 / null = 该 Agent 继承默认模型。只存非敏感配置，不含 API Key。
   */
  agents?: Partial<Record<AgentModelKey, string>>;
  /** 上次保存时间（ISO；诊断用） */
  savedAt?: string;
}

/** 磁盘 JSON → agents override（防御性：只接受已知键的非空字符串值） */
function readAgentOverrides(value: unknown): Partial<Record<AgentModelKey, string>> | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const agents: Partial<Record<AgentModelKey, string>> = {};
  let any = false;
  for (const [key, spec] of Object.entries(value as Record<string, unknown>)) {
    if (isAgentModelKey(key) && typeof spec === "string" && spec.trim() !== "") {
      agents[key] = spec.trim();
      any = true;
    }
  }
  return any ? agents : undefined;
}

export class ModelSettingsStore {
  private readonly filePath: string;

  constructor(options: { settingsDir: string }) {
    this.filePath = join(options.settingsDir, "model.json");
  }

  /** 读取持久化偏好（文件缺失 / 损坏 JSON / 形状不符 → 空偏好） */
  async load(): Promise<StoredModelSettings> {
    let text: string;
    try {
      text = await readFile(this.filePath, "utf8");
    } catch {
      return {};
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      return {};
    }
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
      return {};
    }
    const model = (parsed as Record<string, unknown>)["model"];
    const savedAt = (parsed as Record<string, unknown>)["savedAt"];
    const agents = readAgentOverrides((parsed as Record<string, unknown>)["agents"]);
    return {
      ...(typeof model === "string" && model.trim() !== "" ? { model: model.trim() } : {}),
      ...(typeof savedAt === "string" ? { savedAt } : {}),
      ...(agents !== undefined ? { agents } : {}),
    };
  }

  /** 保存模型偏好（原子写，含 savedAt 时间戳；首次写入自动建目录；agents 缺省 = 清空全部 override） */
  async save(model: string, agents?: Partial<Record<AgentModelKey, string>>): Promise<void> {
    await this.write({ model, ...(agents !== undefined ? { agents } : {}) });
  }

  /** 清除保存的偏好（回到「未保存本地配置」状态；不触碰 credential） */
  async clear(): Promise<void> {
    await this.write({});
  }

  /**
   * 原子写任意偏好组合（save/clear 之外的精细操作，如删除自定义提供商时
   * 只清掉指向它的默认偏好 / agent override，保留其余字段）。
   */
  async write(settings: StoredModelSettings): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    const agents =
      settings.agents !== undefined && Object.keys(settings.agents).length > 0
        ? { agents: settings.agents }
        : {};
    await writeJsonAtomic(this.filePath, {
      ...(settings.model !== undefined ? { model: settings.model } : {}),
      ...agents,
      savedAt: new Date().toISOString(),
    });
  }
}

/**
 * 启动时解析生效模型规格（wiring 层使用）：env（PAPERTEAM_PI_MODEL，
 * 含 .env 补缺）> 本地保存偏好。没有它，重启后 stored 配置只有展示、
 * Runtime 仍 not_configured。
 */
export async function resolveStartupModelSpec(
  envModel: string | undefined,
  store: ModelSettingsStore,
): Promise<string | undefined> {
  return envModel ?? (await store.load()).model;
}
