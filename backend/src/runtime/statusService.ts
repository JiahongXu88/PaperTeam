/**
 * Runtime 状态诊断（M3.8）：GET /api/runtime/status 的实现。
 *
 * Pi 为 in-process Runtime 后，诊断不再有 Gateway / WebSocket / RPC 链路，
 * 一次诊断回答四个问题（全部只读，不泄露 token / 密钥 / 敏感路径）：
 *
 *   runtime  Pi SDK 可加载 + Adapter 未关闭 + 初始化正常（healthCheck）
 *   model    模型就绪度（configured / not_configured；Runtime 健康 ≠ 模型就绪：
 *            没有 API Key 时 runtime=healthy、model=not_configured）
 *   agents   业务角色 → 会话标识映射（Pi 无 agent 注册表，映射恒存在）
 *   sessions 在途 run 与受管 AgentSession 数量（进程内诊断）
 *
 * M4 Frontend 不需要感知历史上的 Gateway 概念（gateway / protocol /
 * clientSdk 等字段已随 M3.8 迁移删除，见 docs/DECISIONS.md D-0019）。
 */

import type { PdfToolchainStatus } from "../paper/pdfToolchain.js";
import { PI_RUNTIME_VERSION } from "./pi/version.js";
import type { AgentRuntime, RuntimeHealth, RuntimeModelStatus, RuntimeSessionStats } from "./types.js";

/** Runtime 相位 */
export type RuntimePhase = "healthy" | "unhealthy";

/** 模型就绪相位 */
export type ModelPhase = "configured" | "not_configured" | "unknown";

export interface AgentMappingStatus {
  role: string;
  /** 配置映射到的会话标识（sessionKey 组成段） */
  agentId: string;
  status: "configured" | "missing";
}

export interface RuntimeStatus {
  /** 后端自身（能响应即 ok） */
  backend: { ok: true };
  runtime: {
    provider: "pi";
    phase: RuntimePhase;
    /** Pi SDK 精确版本（与 backend/package.json pin 一致） */
    version: string;
    detail: string;
    latencyMs: number | null;
  };
  model: {
    phase: ModelPhase;
    /** 已解析的模型标签 "provider/model-id"（未配置时缺省） */
    model?: string;
    /** 有凭据的 provider 名单（不含任何 key） */
    providers: string[];
    detail: string;
  };
  agents: {
    roles: AgentMappingStatus[];
  };
  sessions: {
    /** 在途 run 数（startAgent 未 settle） */
    activeRuns: number;
    /** 受管 AgentSession 数（进程内、按 sessionKey） */
    managedSessions: number;
  };
  /** 外部工具链就绪度（缺失时前端可提前提示，而不是等上传失败） */
  tools: {
    pdfParser: PdfParserToolStatus;
  };
}

export interface PdfParserToolStatus {
  phase: "ready" | "unavailable" | "unknown";
  /** ready：解释器与 pymupdf 版本；unavailable：安装指引 */
  detail: string;
  pythonVersion?: string;
  pymupdfVersion?: string;
}

export interface RuntimeStatusOptions {
  runtime: AgentRuntime;
  agentIds: { writer: string; researcher: string; reviewer: string; citation: string };
  /** PDF 解析工具链探测（缺省 → unknown） */
  pdfParser?: { checkAvailability(): Promise<PdfToolchainStatus> };
  log?: (message: string) => void;
}

export class RuntimeStatusService {
  private readonly runtime: AgentRuntime;
  private readonly agentIds: RuntimeStatusOptions["agentIds"];
  private readonly pdfParser: RuntimeStatusOptions["pdfParser"];
  private readonly log: (message: string) => void;

  constructor(options: RuntimeStatusOptions) {
    this.runtime = options.runtime;
    this.agentIds = options.agentIds;
    this.pdfParser = options.pdfParser;
    this.log = options.log ?? (() => {});
  }

  /** 执行一次完整诊断（任何内部失败都收敛为结构化状态，不抛出） */
  async getStatus(): Promise<RuntimeStatus> {
    const health: RuntimeHealth = await this.runtime.healthCheck();
    const [modelSnapshot, pdfParser] = await Promise.all([this.piModelStatus(), this.pdfParserStatus()]);
    const sessions = this.runtimeSessions();
    return {
      backend: { ok: true },
      runtime: {
        provider: "pi",
        phase: health.ok ? "healthy" : "unhealthy",
        version: PI_RUNTIME_VERSION,
        detail: health.detail,
        latencyMs: health.latencyMs,
      },
      model: {
        phase: modelSnapshot.phase,
        ...(modelSnapshot.model !== undefined ? { model: modelSnapshot.model } : {}),
        providers: modelSnapshot.providers,
        detail: modelSnapshot.detail,
      },
      agents: {
        // Pi 角色映射在 PiRuntimeAdapter 内部（contextScope → role 配置），
        // 会话标识映射恒存在（无 agent 注册表概念）
        roles: roleEntries(this.agentIds).map(([role, agentId]) => ({
          role,
          agentId,
          status: "configured" as const,
        })),
      },
      sessions,
      tools: { pdfParser },
    };
  }

  private async pdfParserStatus(): Promise<PdfParserToolStatus> {
    if (this.pdfParser === undefined) {
      return { phase: "unknown", detail: "未接入 PDF 解析工具链探测" };
    }
    try {
      const status = await this.pdfParser.checkAvailability();
      if (status.available) {
        return {
          phase: "ready",
          detail: `Python ${status.pythonVersion} + pymupdf ${status.pymupdfVersion}`,
          pythonVersion: status.pythonVersion,
          pymupdfVersion: status.pymupdfVersion,
        };
      }
      return { phase: "unavailable", detail: status.detail };
    } catch (error) {
      this.log(`[runtime-status] PDF 工具链探测失败：${errorText(error)}`);
      return { phase: "unknown", detail: "PDF 解析工具链探测失败" };
    }
  }

  /** 模型就绪摘要（Runtime 未实现诊断面时为 unknown） */
  private async piModelStatus(): Promise<RuntimeModelStatus & { model?: string }> {
    if (this.runtime.modelStatusSnapshot === undefined) {
      return { phase: "unknown", providers: [], detail: "Runtime 实现未暴露模型就绪摘要" };
    }
    try {
      const result = await this.runtime.modelStatusSnapshot();
      const model = this.runtime.resolvedModel;
      return { ...result, ...(model !== undefined ? { model } : {}) };
    } catch (error) {
      this.log(`[runtime-status] 模型就绪摘要读取失败：${errorText(error)}`);
      return { phase: "unknown", providers: [], detail: "模型就绪摘要读取失败" };
    }
  }

  private runtimeSessions(): RuntimeSessionStats {
    if (this.runtime.runtimeStats === undefined) {
      return { activeRuns: 0, managedSessions: 0 };
    }
    try {
      return this.runtime.runtimeStats();
    } catch {
      return { activeRuns: 0, managedSessions: 0 };
    }
  }
}

function roleEntries(agentIds: RuntimeStatusOptions["agentIds"]): Array<[string, string]> {
  return [
    ["researcher", agentIds.researcher],
    ["writer", agentIds.writer],
    ["reviewer", agentIds.reviewer],
    ["citation", agentIds.citation],
  ];
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
