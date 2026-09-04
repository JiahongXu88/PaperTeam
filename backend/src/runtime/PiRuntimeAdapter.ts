/**
 * PiRuntimeAdapter —— AgentRuntime 的 Pi 实现（M3.7 Feasibility，side-by-side）。
 *
 * 架构（对照 OpenClawRuntimeAdapter）：
 *
 *   OpenClaw：Backend ─WebSocket/RPC→ Gateway 子进程 ─→ agent runtime
 *   Pi：     Backend ─in-process→ @earendil-works/pi-coding-agent SDK
 *
 * 所有 Pi 细节都封装在本文件（及 ./pi/ 内部模块）中，业务层只感知
 * AgentRuntime 接口。默认 Runtime 仍是 OpenClaw（config.agentRuntime
 * 选择，PAPERTEAM_AGENT_RUNTIME=pi 时启用本实现）。
 *
 * 官方 embedding API（对照 pi-coding-agent 0.84.4 dist/docs/sdk.md 与
 * dist/core/sdk.d.ts 确认）：
 *   createAgentSession({ cwd, agentDir, model, modelRuntime, tools,
 *                        resourceLoader, sessionManager, settingsManager })
 *   session.prompt(text, { expandPromptTemplates: false }) —— 同步终态语义
 *     （resolve 即本轮 agent run 已 settle；失败/中断不 reject，
 *       而是落进 transcript 的 assistant 消息 stopReason:
 *       "error" / "aborted"，见 pi-agent-core Agent.handleRunFailure）
 *   session.abort() / waitForIdle() / dispose()
 *   session.subscribe(listener) → unsubscribe
 *
 * 关键取舍（详见 M3.7 报告 §4）：
 * - 会话：SessionManager.inMemory(cwd)——Runtime session 是可丢弃执行
 *   上下文，Workspace/checkpoint 才是事实源；不为 Runtime session 建
 *   持久化。sessionKey 派生与 OpenClaw 完全一致（./sessionKey.ts），
 *   GenerationService 的显式 sessionKey 透传/回写语义保持兼容。
 * - 每个逻辑会话一个 AgentSession；Pi 的 Agent 单会话一次只允许一个
 *   run（"Agent is already processing"），Adapter 用 per-session 串行
 *   队列保证；不同 sessionKey 完全并发（Reviewer 三路 fan-out 即三个
 *   独立 AgentSession）。
 * - auto-compaction 经 SettingsManager.inMemory({compaction:{enabled:false}})
 *   关闭：M3 流程不依赖 compaction，关闭可避免长会话触发隐式摘要
 *   带来的不确定性（manual compact() 未使用，其 abort 边界不在本
 *   验证范围内）。
 * - healthCheck 语义：SDK 已加载 + Adapter 未关闭 + ModelRuntime 初始化
 *   成功 = healthy。「未配置 API Key」不是 Runtime 不健康，而是模型
 *   未就绪（modelStatus 单独报告，供 statusService 分区展示）。
 * - timeout：Pi SDK 无内建 run 超时，Adapter 用定时器 + session.abort()
 *   实现与 OpenClaw 一致的 runTimeoutMs 语义。
 * - 事件：Adapter 在会话创建时订阅事件并映射为 PaperTeam AgentEvent，
 *   按任务缓存（有界）。streamEvents(taskId) 为「replay 已缓存事件」
 *   语义——AgentRuntime Contract v1 的 runAgent 同步终态语义下，调用方
 *   在运行中拿不到 taskId，无法 mid-run 订阅（Runtime Contract v1
 *   limitation，见 types.ts 审计注释）；底层 mid-run 订阅能力真实存在
 *   （session.subscribe），由专项测试验证。
 */

import { randomUUID } from "node:crypto";
import { mkdir } from "node:fs/promises";
import { join, resolve, sep } from "node:path";

import {
  createAgentSession,
  DefaultResourceLoader,
  ModelRuntime,
  SessionManager,
  SettingsManager,
} from "@earendil-works/pi-coding-agent";
import type {
  AgentSession,
  AgentSessionEvent,
  CreateAgentSessionOptions,
  ResourceLoader,
} from "@earendil-works/pi-coding-agent";

import {
  AgentRunFailedError,
  AgentRuntimeUnavailableError,
  AgentTimeoutError,
} from "../errors.js";
import { resolveRoleConfig, type PiRoleConfig } from "./pi/roleConfig.js";
import { PI_RUNTIME_VERSION } from "./pi/version.js";
import { resolveSessionKey, sanitizeContextScope } from "./sessionKey.js";
import type {
  AgentEvent,
  AgentRuntime,
  AgentTask,
  RunAgentInput,
  RuntimeHealth,
  RuntimeProvider,
} from "./types.js";
import { RuntimeCapabilityError } from "./types.js";

/** Pi 模型类型（不直接依赖 pi-ai：经 pi-coding-agent 的公开选项类型提取） */
type PiModel = NonNullable<CreateAgentSessionOptions["model"]>;

/** Pi ModelRuntime 实例类型（pi-coding-agent 公开导出；构造器私有，用类名取实例类型） */
type PiModelRuntime = ModelRuntime;

/** 每任务事件缓冲上限（超出丢最旧，保尾部；诊断用途足够） */
const TASK_EVENT_BUFFER_LIMIT = 500;

/** 已完结任务记录上限（getTask/streamEvents 可回溯的窗口） */
const TASK_RECORD_LIMIT = 200;

/** 无 projectId 时的会话兜底键（对应 OpenClaw 的「网关默认会话」语义） */
function adhocSessionKey(agentId: string): string {
  return `agent:${agentId}:paperteam-adhoc`;
}

export interface PiRuntimeOptions {
  /**
   * 模型规格 "provider/model-id"（如 "anthropic/claude-opus-4-5"）。
   * 缺省时 Runtime 健康但模型未配置：runAgent 结构化失败（与 OpenClaw
   * 的 model_not_configured 口径一致），不伪造成功。
   */
  modelSpec?: string;
  /**
   * Provider API Key（可选）。设置后经 ModelRuntime.setRuntimeApiKey
   * 注入（仅内存，不落盘）；缺省时按 Pi 官方优先级解析：
   * auth.json（agentDir 下）> 标准环境变量（ANTHROPIC_API_KEY 等）。
   * Key 只传给 ModelRuntime，不进任何日志。
   */
  apiKey?: string;
  /**
   * Pi 全局配置目录（auth.json / models.json / settings 的隔离根）。
   * 必须是 PaperTeam 专属目录（wiring 层保证与 ~/.pi 隔离）。
   */
  agentDir: string;
  /** 项目 workspace 根目录（projectId → 工作目录解析用） */
  workspaceRoot: string;
  /** 无 projectId 调用的工作目录兜底（默认 process.cwd()） */
  defaultCwd?: string;
  /** 单次 runAgent 的整体超时（毫秒），默认 300000 */
  runTimeoutMs?: number;
  /** 测试注入：现成的 ModelRuntime（Level 2 fake provider 用） */
  modelRuntime?: PiModelRuntime;
  /** 测试注入：现成模型对象（优先于 modelSpec 解析） */
  model?: PiModel;
  /** 测试注入：会话工厂（Level 1 fake session 用）；缺省走官方 createAgentSession */
  createSession?: (params: {
    cwd: string;
    agentDir: string;
    role: PiRoleConfig;
    model: PiModel | undefined;
    modelRuntime: PiModelRuntime;
    settingsManager: SettingsManager;
    sessionManager: SessionManager;
    resourceLoader: ResourceLoader;
  }) => Promise<AgentSession>;
  /** 诊断日志输出，默认 console.log */
  log?: (message: string) => void;
}

/** 模型就绪摘要（statusService 经 duck-typing 读取；与 RuntimeHealth 分区） */
export interface PiModelStatus {
  phase: "configured" | "not_configured" | "unknown";
  /** 已配置凭据的 provider 名单（不含任何 key） */
  providers: string[];
  detail: string;
}

/** 进程内受管会话（一个逻辑 sessionKey 一个 Pi AgentSession） */
interface ManagedSession {
  key: string;
  session: AgentSession;
  role: PiRoleConfig;
  cwd: string;
  createdAt: string;
  lastUsedAt: string;
  runCount: number;
  /** per-session 串行队列尾（Pi Agent 单会话同时只允许一个 run） */
  queueTail: Promise<unknown>;
  /** 当前在该会话上运行的任务（事件归属用） */
  activeTaskId?: string;
  /** 会话级事件订阅的退订函数（close/dispose 兜底） */
  unsubscribe?: () => void;
}

/** 在途任务 */
interface InFlightTask {
  taskId: string;
  sessionKey: string;
  startedAt: string;
  /** 整个 runAgent promise（cancelTask 等待其收敛用） */
  runSettled: Promise<void>;
}

/** 已完结任务记录（getTask / streamEvents replay） */
interface TaskRecord {
  task: AgentTask;
  events: AgentEvent[];
}

export class PiRuntimeAdapter implements AgentRuntime {
  readonly provider: RuntimeProvider = "pi";

  private readonly modelSpec: string | undefined;
  private readonly apiKey: string | undefined;
  private readonly agentDir: string;
  private readonly workspaceRoot: string;
  private readonly defaultCwd: string;
  private readonly runTimeoutMs: number;
  private readonly injectedModelRuntime: PiModelRuntime | undefined;
  private readonly injectedModel: PiModel | undefined;
  private readonly createSessionImpl: NonNullable<PiRuntimeOptions["createSession"]> | undefined;
  private readonly log: (message: string) => void;

  private readonly sessions = new Map<string, ManagedSession>();
  /** 会话创建的 in-flight 去重（并发 runAgent 同 key 时只创建一次） */
  private readonly sessionCreations = new Map<string, Promise<ManagedSession>>();
  private readonly inFlight = new Map<string, InFlightTask>();
  private readonly taskRecords = new Map<string, TaskRecord>();

  private settingsManager?: SettingsManager;
  private modelRuntime?: PiModelRuntime;
  private model?: PiModel;
  private resolvedModelLabel?: string;
  private initPromise?: Promise<void>;
  private initError?: string;
  private modelStatus: PiModelStatus = { phase: "unknown", providers: [], detail: "尚未初始化" };
  private closed = false;

  constructor(options: PiRuntimeOptions) {
    this.modelSpec = options.modelSpec?.trim() || undefined;
    this.apiKey = options.apiKey?.trim() || undefined;
    this.agentDir = resolve(options.agentDir);
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.defaultCwd = resolve(options.defaultCwd ?? process.cwd());
    this.runTimeoutMs = options.runTimeoutMs ?? 300_000;
    this.injectedModelRuntime = options.modelRuntime;
    this.injectedModel = options.model;
    this.createSessionImpl = options.createSession;
    this.log = options.log ?? ((message) => console.log(message));
  }

  // ---- 初始化（懒加载、并发去重；healthCheck 与首个 runAgent 共享） ----

  private ensureInitialized(): Promise<void> {
    if (this.initPromise === undefined) {
      this.initPromise = this.doInitialize().catch((error: unknown) => {
        // 失败不缓存 initPromise 之外的状态：initError 置位后，
        // healthCheck/runAgent 都按「Runtime 不可用」结构化上报。
        this.initError =
          error instanceof Error ? error.message : `Pi Runtime 初始化失败：${String(error)}`;
      });
    }
    return this.initPromise;
  }

  private async doInitialize(): Promise<void> {
    const startedAt = Date.now();
    await mkdir(this.agentDir, { recursive: true });

    // 共享 in-memory settings：关闭 auto-compaction（M3.7 取舍，见文件头）
    this.settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
    });

    this.modelRuntime =
      this.injectedModelRuntime ??
      (await ModelRuntime.create({
        authPath: join(this.agentDir, "auth.json"),
        modelsPath: join(this.agentDir, "models.json"),
      }));
    const modelRuntime = this.modelRuntime;

    if (this.injectedModel !== undefined) {
      this.model = this.injectedModel;
      this.resolvedModelLabel = `${this.model.provider}/${this.model.id}`;
    } else if (this.modelSpec !== undefined) {
      const parsed = parseModelSpec(this.modelSpec);
      if (parsed === undefined) {
        this.modelStatus = {
          phase: "not_configured",
          providers: [],
          detail: `PAPERTEAM_PI_MODEL 格式非法："${this.modelSpec}"（应为 provider/model-id）`,
        };
        this.log(`[pi-runtime] 模型规格非法：${this.modelSpec}`);
        this.logInitDone(startedAt, true);
        return;
      }
      const { provider, modelId } = parsed;
      if (this.apiKey !== undefined) {
        // 运行时注入（不落盘）；key 本体不进日志
        await modelRuntime.setRuntimeApiKey(provider, this.apiKey);
        this.log(`[pi-runtime] 已注入 ${provider} 的运行时 API Key`);
      }
      const model = modelRuntime.getModel(provider, modelId);
      if (model === undefined) {
        this.modelStatus = {
          phase: "not_configured",
          providers: [],
          detail: `模型 ${provider}/${modelId} 不在注册表（内置目录 / agentDir models.json / 注册的 provider 均未提供）`,
        };
        this.log(`[pi-runtime] 模型未找到：${provider}/${modelId}`);
        this.logInitDone(startedAt, true);
        return;
      }
      if (!modelRuntime.hasConfiguredAuth(provider)) {
        this.modelStatus = {
          phase: "not_configured",
          providers: [],
          detail: `模型 ${provider}/${modelId} 已配置，但 provider 无可用凭据（PAPERTEAM_PI_API_KEY / agentDir 下 auth.json / 标准环境变量）`,
        };
        this.log(`[pi-runtime] provider=${provider} 无可用凭据`);
        this.logInitDone(startedAt, true);
        return;
      }
      this.model = model;
      this.resolvedModelLabel = `${provider}/${modelId}`;
    } else {
      this.modelStatus = {
        phase: "not_configured",
        providers: [],
        detail: "PAPERTEAM_PI_MODEL 未设置（如 anthropic/claude-opus-4-5）",
      };
      this.log("[pi-runtime] 未配置模型（PAPERTEAM_PI_MODEL）");
      this.logInitDone(startedAt, true);
      return;
    }

    this.modelStatus = {
      phase: "configured",
      providers: [this.model.provider],
      detail: `模型 ${this.resolvedModelLabel} 已配置`,
    };
    this.logInitDone(startedAt, false);
  }

  private logInitDone(startedAt: number, modelMissing: boolean): void {
    const note = modelMissing ? "（模型未配置：runAgent 将结构化失败）" : "";
    this.log(`[pi-runtime] 初始化完成（${Date.now() - startedAt}ms）${note}`);
  }

  // ---- 健康检查（Runtime 健康 ≠ 模型就绪） ----

  async healthCheck(): Promise<RuntimeHealth> {
    const startedAt = Date.now();
    const base = {
      provider: this.provider,
      checkedAt: new Date().toISOString(),
    };
    if (this.closed) {
      return {
        ...base,
        ok: false,
        status: "unhealthy",
        detail: "Pi Runtime 已关闭（adapter closed）",
        latencyMs: Date.now() - startedAt,
      };
    }
    await this.ensureInitialized();
    const latencyMs = Date.now() - startedAt;
    if (this.initError !== undefined) {
      return {
        ...base,
        ok: false,
        status: "unhealthy",
        detail: `Pi Runtime 初始化失败：${this.initError}`,
        latencyMs,
      };
    }
    const runtimeError = this.modelRuntime?.getError();
    if (runtimeError !== undefined) {
      return {
        ...base,
        ok: false,
        status: "unhealthy",
        detail: `Pi ModelRuntime 异常：${runtimeError}`,
        latencyMs,
      };
    }
    // Runtime 健康；模型就绪度单独报告（见 modelStatus()）
    return {
      ...base,
      ok: true,
      status: "healthy",
      detail:
        `Pi in-process Runtime（@earendil-works/pi-coding-agent ${PI_RUNTIME_VERSION}）正常` +
        (this.modelStatus.phase === "configured"
          ? `；模型 ${this.resolvedModelLabel}`
          : `；${this.modelStatus.detail}`),
      latencyMs,
    };
  }

  /** 模型就绪摘要（RuntimeStatusService 经 duck-typing 读取；非 AgentRuntime 契约） */
  async modelStatusSnapshot(): Promise<PiModelStatus> {
    if (this.closed) {
      return { phase: "unknown", providers: [], detail: "Pi Runtime 已关闭" };
    }
    await this.ensureInitialized();
    return this.modelStatus;
  }

  // ---- runAgent（同步终态语义，与 OpenClawRuntimeAdapter 对齐） ----

  async runAgent(input: RunAgentInput): Promise<AgentTask> {
    const message = input.task.trim();
    if (message === "") {
      throw new AgentRunFailedError("任务内容为空");
    }
    if (this.closed) {
      throw new AgentRuntimeUnavailableError("Runtime 已关闭", "adapter closed");
    }
    await this.ensureInitialized();
    if (this.initError !== undefined) {
      throw new AgentRuntimeUnavailableError("Pi Runtime 初始化失败", this.initError);
    }

    const sessionKey =
      resolveSessionKey(input) ?? adhocSessionKey(input.agentId || "default");
    const scope = sanitizeContextScope(input.contextScope);

    // 模型未配置：结构化失败（不抛异常），与 OpenClaw 的 model_not_configured 口径一致
    if (this.model === undefined) {
      this.log(`[pi-runtime] runAgent 拒绝（模型未配置）：sessionKey=${sessionKey}`);
      return this.buildTask({
        taskId: `pi-${randomUUID()}`,
        agentId: input.agentId,
        status: "failed",
        sessionKey,
        error: `Pi 模型未配置：${this.modelStatus.detail}`,
      });
    }

    const managed = await this.getOrCreateSession(sessionKey, input, scope);
    const release = await this.acquireSession(managed);
    const taskId = `pi-${randomUUID()}`;
    const events: AgentEvent[] = [];
    managed.activeTaskId = taskId;

    const runPromise = (async () => {
      try {
        return await this.runOnSession(managed, { taskId, input, message, events, sessionKey });
      } finally {
        managed.activeTaskId = undefined;
        release();
      }
    })();

    const runSettled = runPromise.then(
      () => undefined,
      () => undefined,
    );
    this.inFlight.set(taskId, { taskId, sessionKey, startedAt: new Date().toISOString(), runSettled });

    try {
      return await runPromise;
    } finally {
      this.inFlight.delete(taskId);
    }
  }

  /** 在已独占的会话上执行一次 run（超时 / abort / 终态归因都在这里收敛） */
  private async runOnSession(
    managed: ManagedSession,
    context: {
      taskId: string;
      input: RunAgentInput;
      message: string;
      events: AgentEvent[];
      sessionKey: string;
    },
  ): Promise<AgentTask> {
    const { taskId, input, message, events, sessionKey } = context;
    const runTimeoutMs = input.timeoutMs ?? this.runTimeoutMs;
    const createdAt = new Date().toISOString();
    managed.runCount += 1;
    managed.lastUsedAt = new Date().toISOString();
    this.attachEventCollector(managed, taskId, events);

    let timedOut = false;
    const timer = setTimeout(() => {
      timedOut = true;
      this.log(`[pi-runtime] runAgent ${taskId} 超时（${runTimeoutMs}ms），执行 abort`);
      void managed.session.abort().catch(() => {});
    }, runTimeoutMs);
    timer.unref?.();

    let promptError: unknown;
    try {
      await managed.session.prompt(message, { expandPromptTemplates: false });
    } catch (error) {
      promptError = error;
    } finally {
      clearTimeout(timer);
      this.collectors.delete(taskId);
    }

    if (timedOut) {
      await managed.session.waitForIdle().catch(() => {});
      throw new AgentTimeoutError(runTimeoutMs);
    }

    if (promptError !== undefined) {
      // prompt 前置校验 / compaction 互斥等同步拒绝：结构化失败（底层细节只进日志）
      const detail = promptError instanceof Error ? promptError.message : String(promptError);
      this.log(`[pi-runtime] runAgent ${taskId} prompt 被拒绝：${detail}`);
      return this.buildTask({
        taskId,
        agentId: input.agentId,
        status: "failed",
        sessionKey,
        createdAt,
        events,
        error: `Pi AgentSession 拒绝执行：${detail}`,
      });
    }

    // prompt() 正常 resolve：终态落在 transcript 的最后一条 assistant 消息
    const last = lastAssistantMessage(managed.session);
    const stopReason = last?.stopReason;

    if (stopReason === "error") {
      const errorText = last?.errorMessage ?? "Pi agent run 以 error 终态结束";
      this.log(`[pi-runtime] runAgent ${taskId} 终态=error：${errorText}`);
      return this.buildTask({
        taskId,
        agentId: input.agentId,
        status: "failed",
        sessionKey,
        createdAt,
        events,
        error: errorText,
      });
    }

    if (stopReason === "aborted") {
      // 超时路径已在上面抛 AgentTimeoutError；到这里说明是 cancelTask 触发的 abort
      this.log(`[pi-runtime] runAgent ${taskId} 终态=aborted（cancelled）`);
      return this.buildTask({
        taskId,
        agentId: input.agentId,
        status: "cancelled",
        sessionKey,
        createdAt,
        events,
        error: "任务已取消（session.abort）",
      });
    }

    const output = managed.session.getLastAssistantText();
    if (output === undefined || output.trim() === "") {
      throw new AgentRunFailedError(
        "Agent 运行成功但没有返回任何文本",
        `taskId=${taskId} sessionKey=${sessionKey} stopReason=${stopReason ?? "(unknown)"}`,
      );
    }

    return this.buildTask({
      taskId,
      agentId: input.agentId,
      status: "completed",
      sessionKey,
      createdAt,
      events,
      output,
      model: this.resolvedModelLabel,
      role: managed.role.role,
    });
  }

  private buildTask(fields: {
    taskId: string;
    agentId: string;
    status: AgentTask["status"];
    sessionKey: string;
    createdAt?: string;
    events?: AgentEvent[];
    output?: string;
    error?: string;
    model?: string;
    role?: string;
  }): AgentTask {
    const createdAt = fields.createdAt ?? new Date().toISOString();
    const now = new Date().toISOString();
    const task: AgentTask = {
      taskId: fields.taskId,
      agentId: fields.agentId,
      status: fields.status,
      createdAt,
      updatedAt: now,
      startedAt: createdAt,
      completedAt: now,
      ...(fields.output !== undefined ? { output: fields.output } : {}),
      ...(fields.error !== undefined ? { error: fields.error } : {}),
      metadata: {
        sessionKey: fields.sessionKey,
        ...(fields.model !== undefined ? { model: fields.model } : {}),
        ...(fields.role !== undefined ? { role: fields.role } : {}),
      },
    };
    this.rememberTask(fields.taskId, { task, events: fields.events ?? [] });
    return task;
  }

  private rememberTask(taskId: string, record: TaskRecord): void {
    this.taskRecords.set(taskId, record);
    while (this.taskRecords.size > TASK_RECORD_LIMIT) {
      const oldest = this.taskRecords.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.taskRecords.delete(oldest);
    }
  }

  // ---- 会话管理（进程内 registry；per-session 串行、跨 session 并发） ----

  private getOrCreateSession(
    sessionKey: string,
    input: RunAgentInput,
    scope: string | undefined,
  ): Promise<ManagedSession> {
    const existing = this.sessions.get(sessionKey);
    if (existing !== undefined) {
      return Promise.resolve(existing);
    }
    // 并发同 key（如 reviewer fan-out 之外的同一 scope 并发调用）：
    // 创建过程 in-flight 去重，避免重复建 AgentSession
    let creation = this.sessionCreations.get(sessionKey);
    if (creation === undefined) {
      creation = this.doCreateSession(sessionKey, input, scope)
        .then(
          (managed) => {
            this.sessions.set(sessionKey, managed);
            return managed;
          },
          (error: unknown) => {
            throw error;
          },
        )
        .finally(() => {
          this.sessionCreations.delete(sessionKey);
        });
      this.sessionCreations.set(sessionKey, creation);
    }
    return creation;
  }

  private async doCreateSession(
    sessionKey: string,
    input: RunAgentInput,
    scope: string | undefined,
  ): Promise<ManagedSession> {
    const role = resolveRoleConfig(scope);
    const cwd = this.resolveWorkspaceCwd(input.projectId);
    await mkdir(cwd, { recursive: true }).catch(() => {});

    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: this.agentDir,
      settingsManager: this.settingsManager!,
      systemPromptOverride: () => role.systemPrompt,
    });
    await resourceLoader.reload();

    const sessionManager = SessionManager.inMemory(cwd);
    const session =
      this.createSessionImpl !== undefined
        ? await this.createSessionImpl({
            cwd,
            agentDir: this.agentDir,
            role,
            model: this.model,
            modelRuntime: this.modelRuntime!,
            settingsManager: this.settingsManager!,
            sessionManager,
            resourceLoader,
          })
        : (
            await createAgentSession({
              cwd,
              agentDir: this.agentDir,
              model: this.model,
              modelRuntime: this.modelRuntime!,
              resourceLoader,
              sessionManager,
              settingsManager: this.settingsManager!,
              tools: role.tools,
            })
          ).session;

    const now = new Date().toISOString();
    const managed: ManagedSession = {
      key: sessionKey,
      session,
      role,
      cwd,
      createdAt: now,
      lastUsedAt: now,
      runCount: 0,
      queueTail: Promise.resolve(),
    };
    managed.unsubscribe = this.wireSessionEvents(managed);
    this.sessions.set(sessionKey, managed);
    this.log(
      `[pi-runtime] 创建会话 sessionKey=${sessionKey} role=${role.role} tools=[${role.tools.join(",")}] cwd=${cwd}`,
    );
    return managed;
  }

  /** projectId → workspace 子目录（含路径包含性防越界，与 ProjectStore.projectDir 同规则） */
  private resolveWorkspaceCwd(projectId: string | undefined): string {
    if (projectId === undefined || projectId.trim() === "") {
      return this.defaultCwd;
    }
    const dir = resolve(this.workspaceRoot, projectId.trim());
    if (dir !== this.workspaceRoot && !dir.startsWith(this.workspaceRoot + sep)) {
      throw new AgentRunFailedError(`非法的项目 ID：${projectId}`);
    }
    return dir;
  }

  /** per-session 互斥（Pi Agent 单会话一次一个 run；跨会话完全并发） */
  private async acquireSession(managed: ManagedSession): Promise<() => void> {
    const previous = managed.queueTail;
    let release!: () => void;
    const gate = new Promise<void>((resolveGate) => {
      release = resolveGate;
    });
    managed.queueTail = gate;
    await previous;
    return release;
  }

  // ---- 事件（Pi → PaperTeam AgentEvent 映射；运行期收集、事后 replay） ----

  private collectors = new Map<string, (event: AgentSessionEvent) => void>();

  private attachEventCollector(managed: ManagedSession, taskId: string, events: AgentEvent[]): void {
    void managed;
    // 会话创建时已挂持久 listener（见 wireSessionEvents）；
    // 这里登记当前任务的收集器，listener 按 activeTaskId 分发。
    this.collectors.set(taskId, (event) => {
      const mapped = mapPiEvent(taskId, event);
      if (mapped !== undefined) {
        events.push(mapped);
        if (events.length > TASK_EVENT_BUFFER_LIMIT) {
          events.splice(0, events.length - TASK_EVENT_BUFFER_LIMIT);
        }
      }
    });
  }

  /** 会话创建后立即挂持久 listener：向当前活跃任务收集器分发事件 */
  private wireSessionEvents(managed: ManagedSession): () => void {
    return managed.session.subscribe((event) => {
      const taskId = managed.activeTaskId;
      if (taskId === undefined) {
        return;
      }
      this.collectors.get(taskId)?.(event);
    });
  }

  // ---- v1 契约中的任务级接口（Pi 天然支持；OpenClaw 侧仍是占位） ----

  /** 查询已完结任务（AgentRuntime Contract v1 下调用方仅在 runAgent 返回后可用） */
  async getTask(taskId: string): Promise<AgentTask> {
    const record = this.taskRecords.get(taskId);
    if (record !== undefined) {
      return structuredClone(record.task);
    }
    const inFlightEntry = this.inFlight.get(taskId);
    if (inFlightEntry !== undefined) {
      throw new AgentRunFailedError(`任务 ${taskId} 仍在运行（v1 契约下运行中任务不可查询）`);
    }
    throw new AgentRunFailedError(`任务不存在或已超出回溯窗口（${TASK_RECORD_LIMIT} 条）：${taskId}`);
  }

  /**
   * 查询在途任务（非 AgentRuntime 契约；诊断用）。v1 契约下调用方在
   * runAgent 返回前拿不到 taskId，无法 mid-run cancel/订阅——这个只读
   * 口子是 Contract v2 需要正式暴露的能力的最小形态。
   */
  listActiveTasks(): { taskId: string; sessionKey: string; startedAt: string }[] {
    return [...this.inFlight.values()].map(({ taskId, sessionKey, startedAt }) => ({
      taskId,
      sessionKey,
      startedAt,
    }));
  }

  /**
   * 取消在途任务：真实 session.abort()（协作式：LLM 流中断、tool 执行
   * 收到 abort signal）。归因到对应 runAgent 返回 status="cancelled"。
   */
  async cancelTask(taskId: string): Promise<void> {
    const entry = this.inFlight.get(taskId);
    if (entry === undefined) {
      const record = this.taskRecords.get(taskId);
      if (record !== undefined && record.task.status === "cancelled") {
        return; // 幂等
      }
      throw new AgentRunFailedError(`任务不存在或已结束，无法取消：${taskId}`);
    }
    const managed = this.sessions.get(entry.sessionKey);
    if (managed === undefined) {
      throw new AgentRunFailedError(`取消失败：会话 ${entry.sessionKey} 已不存在`);
    }
    await managed.session.abort().catch(() => {});
    await entry.runSettled;
  }

  /**
   * 回放该任务的已缓存事件（replay 语义）。运行中实时订阅需要
   * AgentRuntime Contract v2（runAgent 返回句柄后再订阅）——底层能力
   * 已由 session.subscribe 提供（专项测试验证），此处不引入 v2。
   */
  async streamEvents(taskId: string, onEvent: (event: AgentEvent) => void): Promise<void> {
    const record = this.taskRecords.get(taskId);
    const inFlightEntry = this.inFlight.get(taskId);
    if (record === undefined && inFlightEntry === undefined) {
      throw new AgentRunFailedError(`任务不存在或已超出回溯窗口：${taskId}`);
    }
    for (const event of record?.events ?? []) {
      onEvent(structuredClone(event));
    }
  }

  /** PaperTeam 无运行中向会话追加消息的业务路径（HITL 走 Workflow resume） */
  sendMessage(_sessionId: string, _message: string): Promise<void> {
    void _sessionId;
    void _message;
    throw new RuntimeCapabilityError("sendMessage", this.provider);
  }

  // ---- 生命周期 ----

  /** 停止全部在途 run 并释放所有 AgentSession（幂等；进程 shutdown 时调用） */
  async close(): Promise<void> {
    this.closed = true;
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.collectors.clear();
    await Promise.allSettled(
      sessions.map(async (managed) => {
        if (managed.activeTaskId !== undefined) {
          await managed.session.abort().catch(() => {});
        }
        managed.session.dispose();
      }),
    );
  }
}

// ---- 辅助函数 ----

/** "provider/model-id" 解析（两段、均非空） */
function parseModelSpec(spec: string): { provider: string; modelId: string } | undefined {
  const trimmed = spec.trim();
  if (!trimmed.includes("/")) {
    return undefined;
  }
  const slash = trimmed.indexOf("/");
  const provider = trimmed.slice(0, slash).trim();
  const modelId = trimmed.slice(slash + 1).trim();
  if (provider === "" || modelId === "" || modelId.includes("/")) {
    return undefined;
  }
  return { provider, modelId };
}

/** transcript 最后一条 assistant 消息（防御性 duck-typing，不 deep import） */
function lastAssistantMessage(
  session: AgentSession,
): { stopReason?: string; errorMessage?: string } | undefined {
  const messages: readonly unknown[] = session.agent.state.messages;
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const candidate = messages[index];
    if (
      typeof candidate === "object" &&
      candidate !== null &&
      (candidate as { role?: unknown }).role === "assistant"
    ) {
      return candidate as { stopReason?: string; errorMessage?: string };
    }
  }
  return undefined;
}

/**
 * Pi AgentSessionEvent → PaperTeam AgentEvent（只保留可稳定映射的子集；
 * data 内容做浅拷贝裁剪，不透传原始对象引用）。
 */
function mapPiEvent(taskId: string, event: AgentSessionEvent): AgentEvent | undefined {
  const ts = new Date().toISOString();
  switch (event.type) {
    case "message_start":
    case "message_end":
      return { taskId, type: event.type, ts, data: {} };
    case "message_update": {
      const inner = (event as { assistantMessageEvent?: { type?: string; delta?: string } })
        .assistantMessageEvent;
      return {
        taskId,
        type: "message_update",
        ts,
        data: {
          streamEvent: inner?.type ?? "unknown",
          ...(typeof inner?.delta === "string" && inner.delta !== ""
            ? { delta: inner.delta.slice(0, 200) }
            : {}),
        },
      };
    }
    case "tool_execution_start":
    case "tool_execution_update":
      return {
        taskId,
        type: event.type,
        ts,
        data: { toolName: event.toolName, toolCallId: event.toolCallId },
      };
    case "tool_execution_end":
      return {
        taskId,
        type: event.type,
        ts,
        data: { toolName: event.toolName, toolCallId: event.toolCallId, isError: event.isError },
      };
    case "agent_start":
    case "agent_settled":
      return { taskId, type: event.type, ts, data: {} };
    case "agent_end":
      return { taskId, type: "agent_end", ts, data: { willRetry: event.willRetry } };
    case "turn_start":
    case "turn_end":
      return { taskId, type: event.type, ts, data: {} };
    default:
      // compaction / retry / queue 等 session 级事件：M3.7 不映射
      return undefined;
  }
}
