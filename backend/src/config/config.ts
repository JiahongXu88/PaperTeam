/**
 * PaperTeam Backend 配置（M3.8 起 Runtime = Pi in-process，无 Gateway 配置）。
 *
 * 配置来源：环境变量（可选地从仓库根 / backend 目录的 .env 文件补缺）。
 * 语义与根目录 .env.example 保持一致，不引入新的必填项。
 */

import { homedir } from "node:os";
import { isAbsolute, join, resolve } from "node:path";

export class ConfigError extends Error {
  override readonly name = "ConfigError";

  constructor(message: string) {
    super(message);
  }
}

export type NodeEnv = "development" | "production" | "test";

export interface LatexConfig {
  /** 单次 LaTeX 编译超时（毫秒） */
  compileTimeoutMs: number;
}

export interface WorkflowConfig {
  /** 单个 Stage 执行超时（毫秒） */
  stageTimeoutMs: number;
  /** 单个 Stage 最大尝试次数（含首次） */
  stageMaxAttempts: number;
}

export interface CitationConfig {
  /** metadata 核验开关（关闭时仅静态层） */
  metadataEnabled: boolean;
  /** 最多核验的 bib 条目数（rate-limit friendly） */
  maxMetadataLookups: number;
  /** 单请求超时（毫秒） */
  metadataTimeoutMs: number;
  /** CrossRef 礼仪邮箱（可选，不写入任何密钥） */
  contactEmail?: string;
}

export interface ReviewConfig {
  /** 自动 revision 最大轮数（bounded loop；超出进 HITL） */
  maxRevisionRounds: number;
  /** Quality Gate：academic 总分阈值 */
  academicPassScore: number;
  /** Quality Gate：AI 文风风险上限 */
  styleRiskMax: number;
}

export interface PiRuntimeConfig {
  /** 模型规格 "provider/model-id"（如 anthropic/claude-opus-4-5）；缺省 = 模型未配置 */
  model?: string;
  /** Provider API Key（可选；不设置则按 Pi 官方优先级：auth.json > 标准环境变量） */
  apiKey?: string;
  /** Pi 全局配置目录（auth.json / models.json；默认 <PAPERTEAM_RUNTIME_ROOT>/runtime/pi/agent） */
  agentDir: string;
  /** 单次 runAgent 的整体超时（毫秒） */
  runTimeoutMs: number;
}

export interface AppConfig {
  env: NodeEnv;
  port: number;
  /** Pi Runtime 配置（唯一 Runtime，M3.8） */
  pi: PiRuntimeConfig;
  /** 各业务 Agent 的会话标识（sessionKey 组成段与诊断标签；Pi 无 agent 注册表） */
  agents: AgentIds;
  /** 论文项目工作区根目录（绝对路径） */
  projectsRoot: string;
  latex: LatexConfig;
  workflow: WorkflowConfig;
  citation: CitationConfig;
  review: ReviewConfig;
}

export interface AgentIds {
  writer: string;
  researcher: string;
  reviewer: string;
  citation: string;
}

const DEFAULT_PORT = 3000;
const DEFAULT_RUN_TIMEOUT_MS = 300_000;
const DEFAULT_PROJECTS_ROOT = "./projects";
const DEFAULT_LATEX_COMPILE_TIMEOUT_MS = 120_000;
const DEFAULT_STAGE_TIMEOUT_MS = 900_000;
const DEFAULT_STAGE_MAX_ATTEMPTS = 2;
const DEFAULT_CITATION_MAX_LOOKUPS = 20;
const DEFAULT_CITATION_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_REVISION_ROUNDS = 2;
const DEFAULT_ACADEMIC_PASS_SCORE = 80;
const DEFAULT_STYLE_RISK_MAX = 35;

const RUN_TIMEOUT_MIN_MS = 1_000;
const RUN_TIMEOUT_MAX_MS = 3_600_000;
const LATEX_TIMEOUT_MIN_MS = 1_000;
const LATEX_TIMEOUT_MAX_MS = 1_800_000;
const STAGE_TIMEOUT_MIN_MS = 5_000;
const STAGE_TIMEOUT_MAX_MS = 3_600_000;
const STAGE_MAX_ATTEMPTS_MIN = 1;
const STAGE_MAX_ATTEMPTS_MAX = 5;

const AGENT_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/;

const NODE_ENVS: readonly NodeEnv[] = ["development", "production", "test"];

/** PaperTeam 用户级运行时根目录的环境变量覆盖 */
const PAPERTEAM_RUNTIME_ROOT_ENV = "PAPERTEAM_RUNTIME_ROOT";

/**
 * PaperTeam 用户级 Runtime 根目录（默认 ~/.paperteam）。
 * Pi 的 auth.json / models.json 隔离在 <root>/runtime/pi/agent 下。
 */
export function resolveRuntimeRoot(
  source: Record<string, string | undefined> = process.env,
  home: string = homedir(),
): string {
  const override = source[PAPERTEAM_RUNTIME_ROOT_ENV]?.trim();
  if (override) {
    if (!isAbsolute(override)) {
      // 相对路径拒绝（resolve 会基于 cwd 静默补全，掩盖配置错误）
      throw new ConfigError(`PAPERTEAM_RUNTIME_ROOT 必须是绝对路径："${override}"`);
    }
    return resolve(override);
  }
  return join(home, ".paperteam");
}

export function loadConfig(source: Record<string, string | undefined> = process.env): AppConfig {
  return {
    env: readNodeEnv(source),
    port: readPort(source),
    pi: {
      model: readOptionalValue(source, "PAPERTEAM_PI_MODEL"),
      apiKey: readOptionalValue(source, "PAPERTEAM_PI_API_KEY"),
      agentDir:
        readOptionalValue(source, "PAPERTEAM_PI_AGENT_DIR") ??
        join(resolveRuntimeRoot(source), "runtime", "pi", "agent"),
      runTimeoutMs: readTimeoutMs(source, "PAPERTEAM_PI_RUN_TIMEOUT_MS", {
        default: DEFAULT_RUN_TIMEOUT_MS,
        min: RUN_TIMEOUT_MIN_MS,
        max: RUN_TIMEOUT_MAX_MS,
      }),
    },
    agents: {
      // 会话标识默认沿用 M3.7 验证基线（main）：业务角色
      // （Researcher/Writer/Reviewer/Citation）靠 prompt + contextScope 隔离
      // 会话（方案 A，见 docs/DECISIONS.md D-0018）。Pi 无 agent 注册表，
      // 此值仅作为 sessionKey 组成段与诊断标签；需要区分会话键时用环境变量覆盖。
      writer: readAgentId(source, "PAPERTEAM_WRITER_AGENT_ID", "main"),
      researcher: readAgentId(source, "PAPERTEAM_RESEARCHER_AGENT_ID", "main"),
      reviewer: readAgentId(source, "PAPERTEAM_REVIEWER_AGENT_ID", "main"),
      citation: readAgentId(source, "PAPERTEAM_CITATION_AGENT_ID", "main"),
    },
    projectsRoot: readProjectsRoot(source),
    latex: {
      compileTimeoutMs: readTimeoutMs(source, "LATEX_COMPILE_TIMEOUT_MS", {
        default: DEFAULT_LATEX_COMPILE_TIMEOUT_MS,
        min: LATEX_TIMEOUT_MIN_MS,
        max: LATEX_TIMEOUT_MAX_MS,
      }),
    },
    workflow: {
      stageTimeoutMs: readTimeoutMs(source, "WORKFLOW_STAGE_TIMEOUT_MS", {
        default: DEFAULT_STAGE_TIMEOUT_MS,
        min: STAGE_TIMEOUT_MIN_MS,
        max: STAGE_TIMEOUT_MAX_MS,
      }),
      stageMaxAttempts: readInt(source, "WORKFLOW_STAGE_MAX_ATTEMPTS", {
        default: DEFAULT_STAGE_MAX_ATTEMPTS,
        min: STAGE_MAX_ATTEMPTS_MIN,
        max: STAGE_MAX_ATTEMPTS_MAX,
      }),
    },
    citation: {
      metadataEnabled: readBool(source, "CITATION_METADATA_ENABLED", true),
      maxMetadataLookups: readInt(source, "CITATION_MAX_METADATA_LOOKUPS", {
        default: DEFAULT_CITATION_MAX_LOOKUPS,
        min: 0,
        max: 200,
      }),
      metadataTimeoutMs: readTimeoutMs(source, "CITATION_METADATA_TIMEOUT_MS", {
        default: DEFAULT_CITATION_TIMEOUT_MS,
        min: 1_000,
        max: 60_000,
      }),
      ...(readOptionalValue(source, "CITATION_CONTACT_EMAIL") !== undefined
        ? { contactEmail: readOptionalValue(source, "CITATION_CONTACT_EMAIL") }
        : {}),
    },
    review: {
      maxRevisionRounds: readInt(source, "WORKFLOW_MAX_REVISION_ROUNDS", {
        default: DEFAULT_MAX_REVISION_ROUNDS,
        min: 0,
        max: 5,
      }),
      academicPassScore: readInt(source, "QUALITY_ACADEMIC_PASS_SCORE", {
        default: DEFAULT_ACADEMIC_PASS_SCORE,
        min: 0,
        max: 100,
      }),
      styleRiskMax: readInt(source, "QUALITY_STYLE_RISK_MAX", {
        default: DEFAULT_STYLE_RISK_MAX,
        min: 0,
        max: 100,
      }),
    },
  };
}

function readNodeEnv(source: Record<string, string | undefined>): NodeEnv {
  const raw = (source["NODE_ENV"] ?? "development").trim();
  const match = NODE_ENVS.find((candidate) => candidate === raw);
  if (!match) {
    throw new ConfigError(
      `NODE_ENV 只能是 ${NODE_ENVS.join(" / ")}，当前为 "${raw}"`,
    );
  }
  return match;
}

function readPort(source: Record<string, string | undefined>): number {
  const raw = source["PAPERTEAM_PORT"];
  if (raw === undefined || raw.trim() === "") {
    return DEFAULT_PORT;
  }
  const port = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(port) || port < 1 || port > 65_535) {
    throw new ConfigError(
      `PAPERTEAM_PORT 必须是 1-65535 的整数，当前为 "${raw.trim()}"`,
    );
  }
  return port;
}

/** 通用整型超时配置读取（缺省 / 越界报错） */
function readTimeoutMs(
  source: Record<string, string | undefined>,
  key: string,
  bounds: { default: number; min: number; max: number },
): number {
  const raw = source[key];
  if (raw === undefined || raw.trim() === "") {
    return bounds.default;
  }
  const ms = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(ms) || ms < bounds.min || ms > bounds.max) {
    throw new ConfigError(
      `${key} 必须是 ${bounds.min}-${bounds.max} 的整数（毫秒），当前为 "${raw.trim()}"`,
    );
  }
  return ms;
}

/** 读取 agent id 配置（缺省用默认值；非法字符报错） */
function readAgentId(
  source: Record<string, string | undefined>,
  key: string,
  fallback: string,
): string {
  const raw = (source[key] ?? "").trim();
  if (raw === "") {
    return fallback;
  }
  if (!AGENT_ID_PATTERN.test(raw)) {
    throw new ConfigError(
      `${key} 只能包含字母、数字、下划线或连字符（长度 1-64），当前为 "${raw}"`,
    );
  }
  return raw;
}

/** 通用整型配置读取（缺省 / 越界报错） */
function readInt(
  source: Record<string, string | undefined>,
  key: string,
  bounds: { default: number; min: number; max: number },
): number {
  const raw = source[key];
  if (raw === undefined || raw.trim() === "") {
    return bounds.default;
  }
  const value = Number.parseInt(raw.trim(), 10);
  if (!Number.isInteger(value) || value < bounds.min || value > bounds.max) {
    throw new ConfigError(
      `${key} 必须是 ${bounds.min}-${bounds.max} 的整数，当前为 "${raw.trim()}"`,
    );
  }
  return value;
}

/** 布尔配置读取（true/false，缺省用 default） */
function readBool(
  source: Record<string, string | undefined>,
  key: string,
  defaultValue: boolean,
): boolean {
  const raw = source[key];
  if (raw === undefined || raw.trim() === "") {
    return defaultValue;
  }
  const trimmed = raw.trim().toLowerCase();
  if (trimmed === "true" || trimmed === "1" || trimmed === "yes") {
    return true;
  }
  if (trimmed === "false" || trimmed === "0" || trimmed === "no") {
    return false;
  }
  throw new ConfigError(`${key} 只能是 true/false，当前为 "${raw.trim()}"`);
}

function readProjectsRoot(source: Record<string, string | undefined>): string {
  const key = "PROJECTS_ROOT";
  const raw = (source[key] ?? "").trim() || DEFAULT_PROJECTS_ROOT;
  // 相对路径基于进程工作目录解析为绝对路径，路径管理集中在服务端
  return resolve(process.cwd(), raw);
}

function readOptionalValue(
  source: Record<string, string | undefined>,
  key: string,
): string | undefined {
  const raw = (source[key] ?? "").trim();
  return raw === "" ? undefined : raw;
}
