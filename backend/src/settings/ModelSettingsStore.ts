/**
 * 模型偏好持久化：`<runtimeRoot>/settings/model.json`。
 *
 * 只存非敏感的模型偏好（"provider/model-id"）；API Key 一律走 Pi 官方
 * credential storage（agentDir 下 auth.json，经 ModelRuntime.login/logout，
 * 见 ModelSettingsService）。文件位于 PaperTeam 用户数据目录（~/.paperteam），
 * 与仓库目录隔离，不进 Git。
 *
 * 写入走 writeJsonAtomic（tmp → fsync → rename），中断不留半个 JSON；
 * 读取对损坏/缺省文件容错（返回空偏好，不阻塞启动）。
 */

import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { writeJsonAtomic } from "../util/atomic.js";

/** 持久化的模型偏好（版本化 schema；v1 仅 model 一个字段） */
export interface StoredModelSettings {
  /** 生效偏好 "provider/model-id"（缺省 = 未保存） */
  model?: string;
  /** 上次保存时间（ISO；诊断用） */
  savedAt?: string;
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
    return {
      ...(typeof model === "string" && model.trim() !== "" ? { model: model.trim() } : {}),
      ...(typeof savedAt === "string" ? { savedAt } : {}),
    };
  }

  /** 保存模型偏好（原子写，含 savedAt 时间戳；首次写入自动建目录） */
  async save(model: string): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeJsonAtomic(this.filePath, { model, savedAt: new Date().toISOString() });
  }

  /** 清除保存的偏好（回到「未保存本地配置」状态；不触碰 credential） */
  async clear(): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeJsonAtomic(this.filePath, {});
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
