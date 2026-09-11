/**
 * PaperTeam Backend 配置（Runtime = Pi in-process，无 Gateway 配置）。
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
  /** section review 有界并发度（PAPERTEAM_REVIEW_CONCURRENCY；无效值回退默认，不报错） */
  reviewConcurrency: number;
  /** PaperMap 章节摘要有界并发度（PAPERTEAM_SUMMARY_CONCURRENCY；无效值回退默认） */
  summaryConcurrency: number;
  /** 单次 review.sections 最多审阅的章节数（benchmark / 诊断用；0 = 不限制） */
  reviewSectionLimit: number;
}

export interface PiRuntimeConfig {
  /** 模型规格 "provider/model-id"（如 anthropic/claude-opus-4-5）；缺省 = 模型未配置 */
  model?: string;
  /** Provider API Key（可选；不设置则按 Pi 官方优先级：auth.json > 标准环境变量） */
  apiKey?: string;
  /** Pi 全局配置目录（auth.json / models.json；默认 <PAPERTEAM_RUNTIME_ROOT>/runtime/pi/agent） */
  agentDir: string;
  /**
   * 单次 runAgent 的整体超时（毫秒；M5.1 兼容字段）：未设置
   * executionTimeoutMs 时作为执行阶段超时的默认值。
   */
  runTimeoutMs: number;
  /** 执行阶段超时（毫秒；PAPERTEAM_PI_EXECUTION_TIMEOUT_MS；缺省回退 runTimeoutMs） */
  executionTimeoutMs?: number;
  /** 排队阶段超时（毫秒；PAPERTEAM_PI_QUEUE_TIMEOUT_MS；缺省不限） */
  queueTimeoutMs?: number;
  /** 会话创建阶段超时（毫秒；PAPERTEAM_PI_SESSION_TIMEOUT_MS；缺省不限） */
  sessionTimeoutMs?: number;
  /** Runtime 懒初始化阶段超时（毫秒；PAPERTEAM_PI_INIT_TIMEOUT_MS；缺省不限） */
  initTimeoutMs?: number;
  /**
   * 全局最大同时执行数（PAPERTEAM_PI_MAX_CONCURRENT_RUNS；默认 4）。
   * 整个进程同时真实执行的 run 数上限（Runtime 层最后一道 admission /
   * execution guard，跨一切业务维度生效）。非法值启动报错（容量约束是
   * 正确性契约，不同于可静默回退的并发调优项）。
   */
  maxConcurrentRuns: number;
  /**
   * 全局最大等待任务数（PAPERTEAM_PI_MAX_QUEUED_RUNS；默认 32；0 = 不
   * 允许任何等待）。已受理未执行任务达到上限后新任务立即结构化失败
   * （RUNTIME_QUEUE_FULL）。非法值启动报错。
   */
  maxQueuedRuns: number;
}

export interface PdfConfig {
  /** PDF 解析用 Python 解释器（PAPERTEAM_PDF_PYTHON；缺省自动探测 python / python3 / py -3） */
  pythonCommand?: string;
}

export interface AppConfig {
  env: NodeEnv;
  port: number;
  /** PaperTeam 用户级 Runtime 根目录（skills store 等挂在其下） */
  runtimeRoot: string;
  /** Pi Runtime 配置（唯一 Runtime） */
  pi: PiRuntimeConfig;
  /** 各业务 Agent 的会话标识（sessionKey 组成段与诊断标签；Pi 无 agent 注册表） */
  agents: AgentIds;
  /** 论文项目工作区根目录（绝对路径） */
  projectsRoot: string;
  latex: LatexConfig;
  workflow: WorkflowConfig;
  citation: CitationConfig;
  review: ReviewConfig;
  pdf: PdfConfig;
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
const DEFAULT_CITATION_MAX_LOOKUPS = 40;
const DEFAULT_CITATION_TIMEOUT_MS = 8_000;
const DEFAULT_MAX_REVISION_ROUNDS = 2;
const DEFAULT_ACADEMIC_PASS_SCORE = 80;
const DEFAULT_STYLE_RISK_MAX = 35;
const DEFAULT_REVIEW_CONCURRENCY = 3;
const DEFAULT_SUMMARY_CONCURRENCY = 3;
/** 并发度允许范围：1（纯串行）到 8（Provider 限流压力已明显） */
const CONCURRENCY_MIN = 1;
const CONCURRENCY_MAX = 8;
const DEFAULT_REVIEW_SECTION_LIMIT = 0;
const REVIEW_SECTION_LIMIT_MAX = 40;
/** Runtime 全局并发上限（M5.2）：>= Reviewer 三路 fan-out + 一路余量 */
const DEFAULT_PI_MAX_CONCURRENT_RUNS = 4;
const PI_MAX_CONCURRENT_MIN = 1;
const PI_MAX_CONCURRENT_MAX = 64;
/** Runtime 全局等待队列容量（M5.2）：单机单用户的 Workflow 级排队余量 */
const DEFAULT_PI_MAX_QUEUED_RUNS = 32;
const PI_MAX_QUEUED_MIN = 0;
const PI_MAX_QUEUED_MAX = 1024;

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
    runtimeRoot: resolveRuntimeRoot(source),
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
      executionTimeoutMs: readOptionalTimeoutMs(source, "PAPERTEAM_PI_EXECUTION_TIMEOUT_MS", {
        min: RUN_TIMEOUT_MIN_MS,
        max: RUN_TIMEOUT_MAX_MS,
      }),
      queueTimeoutMs: readOptionalTimeoutMs(source, "PAPERTEAM_PI_QUEUE_TIMEOUT_MS", {
        min: RUN_TIMEOUT_MIN_MS,
        max: RUN_TIMEOUT_MAX_MS,
      }),
      sessionTimeoutMs: readOptionalTimeoutMs(source, "PAPERTEAM_PI_SESSION_TIMEOUT_MS", {
        min: RUN_TIMEOUT_MIN_MS,
        max: RUN_TIMEOUT_MAX_MS,
      }),
      initTimeoutMs: readOptionalTimeoutMs(source, "PAPERTEAM_PI_INIT_TIMEOUT_MS", {
        min: RUN_TIMEOUT_MIN_MS,
        max: RUN_TIMEOUT_MAX_MS,
      }),
      // 容量上限（M5.2）用严格 readInt：非法值报 ConfigError 拒绝启动
      //（区别于 reviewConcurrency 等可静默回退的性能调优项——容量契约
      //  被静默放大/缩小会掩盖背压语义）
      maxConcurrentRuns: readInt(source, "PAPERTEAM_PI_MAX_CONCURRENT_RUNS", {
        default: DEFAULT_PI_MAX_CONCURRENT_RUNS,
        min: PI_MAX_CONCURRENT_MIN,
        max: PI_MAX_CONCURRENT_MAX,
      }),
      maxQueuedRuns: readInt(source, "PAPERTEAM_PI_MAX_QUEUED_RUNS", {
        default: DEFAULT_PI_MAX_QUEUED_RUNS,
        min: PI_MAX_QUEUED_MIN,
        max: PI_MAX_QUEUED_MAX,
      }),
    },
    agents: {
      // 会话标识默认为 main：业务角色
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
      // 并发度是性能调优项，不是正确性约束：0 / 负数 / 超上限 / 非数字一律
      // 回退默认值继续跑（不让一次手滑让整个后端拒绝启动）
      reviewConcurrency: readIntWithFallback(source, "PAPERTEAM_REVIEW_CONCURRENCY", {
        default: DEFAULT_REVIEW_CONCURRENCY,
        min: CONCURRENCY_MIN,
        max: CONCURRENCY_MAX,
      }),
      summaryConcurrency: readIntWithFallback(source, "PAPERTEAM_SUMMARY_CONCURRENCY", {
        default: DEFAULT_SUMMARY_CONCURRENCY,
        min: CONCURRENCY_MIN,
        max: CONCURRENCY_MAX,
      }),
      reviewSectionLimit: readIntWithFallback(source, "PAPERTEAM_REVIEW_SECTION_LIMIT", {
        default: DEFAULT_REVIEW_SECTION_LIMIT,
        min: 0,
        max: REVIEW_SECTION_LIMIT_MAX,
      }),
    },
    pdf: {
      ...(readOptionalValue(source, "PAPERTEAM_PDF_PYTHON") !== undefined
        ? { pythonCommand: readOptionalValue(source, "PAPERTEAM_PDF_PYTHON") }
        : {}),
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

/** 可选整型超时配置读取（缺省/空 = 不配置 = 不限；设置了则校验范围） */
function readOptionalTimeoutMs(
  source: Record<string, string | undefined>,
  key: string,
  bounds: { min: number; max: number },
): number | undefined {
  const raw = source[key];
  if (raw === undefined || raw.trim() === "") {
    return undefined;
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

/**
 * 宽松整型配置读取（性能调优项专用）：非法值静默回退默认值。
 * 与 readInt 的区别：readInt 报错（正确性约束），这里不报（调优项不阻断启动）。
 */
function readIntWithFallback(
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
    return bounds.default;
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
