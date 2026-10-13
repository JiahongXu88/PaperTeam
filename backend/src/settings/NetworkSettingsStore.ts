/**
 * 网络设置持久化（M13.8）：`<runtimeRoot>/settings/network.json`。
 *
 * 只存非敏感的 Research 代理偏好（启用 / 类型 / 主机 / 端口）；代理 URL 不含
 * 凭据（初版拒绝需要认证的代理，见 network/researchProxy.ts）。文件位于 PaperTeam
 * 用户数据目录（~/.paperteam），与仓库隔离，不进 Git。
 *
 * 写入走 writeJsonAtomic（tmp → fsync → rename）；读取对缺省 / 损坏 / 形状不符
 * 容错（返回空偏好 = 直连，不阻塞启动）——与 ModelSettingsStore 同一纪律。
 */

import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import {
  normalizeResearchProxyConfig,
  type ResearchProxyConfig,
  type ResearchProxyProtocol,
} from "../network/researchProxy.js";
import { writeJsonAtomic } from "../util/atomic.js";

/** 持久化的代理偏好：enabled=false 时仍保留 host / port（用户关掉开关不丢输入） */
export interface StoredResearchProxy extends ResearchProxyConfig {
  enabled: boolean;
}

export interface StoredNetworkSettings {
  proxy?: StoredResearchProxy;
  /** 上次保存时间（ISO；诊断用） */
  savedAt?: string;
}

const SCHEMA_VERSION = 1;

/** 磁盘 JSON → 代理偏好（防御性：任一字段非法 → 整体忽略 = 直连） */
function readStoredProxy(value: unknown): StoredResearchProxy | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  if (
    typeof record["enabled"] !== "boolean" ||
    typeof record["protocol"] !== "string" ||
    typeof record["host"] !== "string" ||
    typeof record["port"] !== "number"
  ) {
    return undefined;
  }
  try {
    const normalized = normalizeResearchProxyConfig({
      protocol: record["protocol"],
      host: record["host"],
      port: record["port"],
    });
    return { ...normalized, enabled: record["enabled"] };
  } catch {
    return undefined;
  }
}

export class NetworkSettingsStore {
  private readonly filePath: string;

  constructor(options: { settingsDir: string }) {
    this.filePath = join(options.settingsDir, "network.json");
  }

  /** 读取持久化偏好（文件缺失 / 损坏 JSON / 形状不符 → 空偏好） */
  async load(): Promise<StoredNetworkSettings> {
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
    const record = parsed as Record<string, unknown>;
    const proxy = readStoredProxy(record["proxy"]);
    const savedAt = record["savedAt"];
    return {
      ...(proxy !== undefined ? { proxy } : {}),
      ...(typeof savedAt === "string" ? { savedAt } : {}),
    };
  }

  /** 原子写（首次写入自动建目录；含 schema 版本与 savedAt） */
  async save(settings: { proxy?: StoredResearchProxy }): Promise<void> {
    await mkdir(dirname(this.filePath), { recursive: true });
    await writeJsonAtomic(this.filePath, {
      version: SCHEMA_VERSION,
      ...(settings.proxy !== undefined
        ? {
            proxy: {
              enabled: settings.proxy.enabled,
              protocol: settings.proxy.protocol satisfies ResearchProxyProtocol,
              host: settings.proxy.host,
              port: settings.proxy.port,
            },
          }
        : {}),
      savedAt: new Date().toISOString(),
    });
  }
}
