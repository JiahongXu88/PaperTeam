/**
 * PiRuntimeAdapter —— AgentRuntime Contract v2 的 Pi 实现。
 *
 * 架构：
 *
 *   PaperTeam Backend ─in-process→ @earendil-works/pi-coding-agent SDK → LLM/Tools
 *
 * 所有 Pi 细节都封装在本文件（及 ./pi/ 内部模块）中，业务层只感知
 * AgentRuntime 接口（./types.ts）。
 *
 * 官方 embedding API（对照 pi-coding-agent 0.84.4 dist/docs/sdk.md 与
 * dist/core/sdk.d.ts 确认）：
 *   createAgentSession({ cwd, agentDir, model, modelRuntime, tools,
 *                        resourceLoader, sessionManager, settingsManager,
 *                        customTools })
 *   session.prompt(text, { expandPromptTemplates: false }) —— 同步终态语义
 *     （resolve 即本轮 agent run 已 settle；失败/中断不 reject，
 *       而是落进 transcript 的 assistant 消息 stopReason:
 *       "error" / "aborted"，见 pi-agent-core Agent.handleRunFailure）
 *   session.abort / waitForIdle / dispose
 *   session.subscribe(listener) → unsubscribe
 *   ToolDefinition.execute(toolCallId, params, signal, ...) —— 工具执行
 *     收到协作式 AbortSignal（cancel 传导验证点）
 *
 * v2 关键取舍（延续 M3.7 验证结论，详见 docs/DECISIONS.md D-0019）：
 * - 会话：SessionManager.inMemory(cwd)——Runtime session 是可丢弃执行
 *   上下文，Workspace/checkpoint 才是事实源；不为 Runtime session 建
 *   持久化。sessionKey 派生（./sessionKey.ts）保持稳定，
 *   GenerationService 的显式 sessionKey 透传/回写语义保持兼容。
 * - 每个逻辑会话一个 AgentSession；Pi 的 Agent 单会话一次只允许一个
 *   run（"Agent is already processing"），Adapter 用 per-session 显式
 *   FIFO 队列保证（排队任务被取消可直接摘除并即时终态，不等前序 run，
 *   也不阻塞后续排队者）；不同 sessionKey 完全并发（Reviewer 三路
 *   fan-out 即三个独立 AgentSession）。排队发生在 startAgent 返回句柄
 *   之后——taskId 的立即可得性不依赖队列位置。
 * - auto-compaction 经 SettingsManager.inMemory({compaction:{enabled:false}})
 *   关闭：M3 流程不依赖 compaction（manual compact 未使用，其 abort
 *   边界不在验证范围内，记录为上游边界）。
 * - healthCheck 语义：SDK 已加载 + Adapter 未关闭 + ModelRuntime 初始化
 *   成功 = healthy。「未配置 API Key」不是 Runtime 不健康，而是模型
 *   未就绪（modelStatus 单独报告，供 statusService 分区展示）。
 * - timeout（M5.1 分层）：Pi SDK 无内建 run 超时，Adapter 按真实生命周期
 *   阶段分层计时：init（懒初始化）→ session（会话获取/创建）→ queue
 *   （等待同会话独占权）→ execution（session.prompt 开始后）。每阶段可
 *   独立配置超时（缺省兼容：execution 回退 runTimeoutMs；其余阶段不限）。
 *   超时统一以 AgentTimeoutError(phase) reject，同时留下 timed_out 结构化
 *   终态（errorCode=*_TIMEOUT + timeoutPhase，getTask 可查）。timeout 与
 *   manual cancel 竞态以「首个 abort 发起者」定归因（abortInitiator），
 *   first-settle-wins，绝不双重归因。
 * - 终态（M5.1）：无论 result resolve 还是 reject，全部终态（completed /
 *   cancelled / failed / timed_out）都写入任务记录（getTask 可回溯），
 *   携带 queuedAt / startedAt / queueDurationMs / executionDurationMs /
 *   totalDurationMs（settle 时计算，保证非负）。
 * - usage（M5.2 基础采集）：message_end 送达的 assistant 消息按 Pi 原生
 *   usage 累计（input/output/cacheRead/cacheWrite/cost 为增量求和；
 *   totalTokens 是上下文规模快照 → contextTokens 取最后一个有效值）。
 *   forwarder 仅在本 run 独占会话期间挂载，会话复用不重复计入历史 turn。
 * - 事件：会话创建时挂持久 listener，Pi 事件映射为 PaperTeam AgentEvent
 *   （原始事件对象不透传业务层）。handle.events 为「replay + live」
 *   语义：订阅即从头回放已缓存事件，随后 live 消费，settle 后迭代
 *   自然结束；多次订阅互相独立。缓冲有界（保尾部 TASK_EVENT_BUFFER_LIMIT
 *   条）：真实事件带单调递增 seq；消费者落后于淘汰窗口或订阅晚于截断
 *   时，先交付 type="event_gap" 合成事件显式报告被淘汰区间（M5.1），
 *   绝不静默漏事件。
 * - cancel：幂等。排队中（未获得 session）的任务直接从 per-session 队列
 *   摘除并即时终态 cancelled（不等前序 run，不触发 prompt，也不误伤同
 *   会话正在运行的其他任务）；运行中的任务执行真实 session.abort
 *   （协作式：LLM 流中断、tool 执行收到 AbortSignal）。
 * - AbortSignal：RunAgentInput.signal 由 startAgent 统一消费（M5.1），
 *   与 handle.cancel() 同一条取消链路：pre-aborted / 排队中 / 运行中
 *   三态都进入取消语义；监听器 once + settle 后移除，不泄漏。
 *   runAgent 只是 startAgent + await result 的 convenience wrapper，
 *   不再有第二套 signal 实现。
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
  ToolDefinition,
} from "@earendil-works/pi-coding-agent";

import {
  AgentRunFailedError,
  AgentRuntimeUnavailableError,
  AgentTimeoutError,
  ModelConfigBusyError,
} from "../errors.js";
import { resolveRoleConfig, type PiRoleConfig, type PiRoleKey } from "./pi/roleConfig.js";
import { PI_RUNTIME_VERSION } from "./pi/version.js";
import { resolveSessionKey, sanitizeContextScope } from "./sessionKey.js";
import type {
  AgentEvent,
  AgentRuntime,
  AgentRunHandle,
  AgentRunUsage,
  AgentTask,
  AgentTimeoutPhase,
  RunAgentInput,
  RuntimeHealth,
  RuntimeModelStatus,
  RuntimeProvider,
} from "./types.js";

/** Pi 模型类型（不直接依赖 pi-ai：经 pi-coding-agent 的公开选项类型提取） */
type PiModel = NonNullable<CreateAgentSessionOptions["model"]>;

/** Pi ModelRuntime 实例类型（pi-coding-agent 公开导出；构造器私有，用类名取实例类型） */
type PiModelRuntime = ModelRuntime;

/** 每任务事件缓冲上限（超出丢最旧保尾部；缺口经 event_gap 显式暴露，见 AgentEventIterator） */
const TASK_EVENT_BUFFER_LIMIT = 500;

/** 已完结任务记录上限（getTask 可回溯的窗口） */
const TASK_RECORD_LIMIT = 200;

/** 无 projectId 时的会话兜底键（对应 v1 的「默认会话」语义） */
function adhocSessionKey(agentId: string): string {
  return `agent:${agentId}:paperteam-adhoc`;
}

export interface PiRuntimeOptions {
  /**
   * 模型规格 "provider/model-id"（如 "anthropic/claude-opus-4-5"）。
   * 缺省时 Runtime 健康但模型未配置：startAgent 结构化失败
   * （result resolve status="failed"），不伪造成功。
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
  /** 无 projectId 调用的工作目录兜底（默认 process.cwd） */
  defaultCwd?: string;
  /**
   * 执行阶段超时（毫秒）——任务进入 session.prompt 后才开始计时（排队
   * 等待不计入）。兼容默认值链：executionTimeoutMs ?? runTimeoutMs ?? 300000
   * （未引入新配置时行为与历史 runTimeoutMs 完全一致）。
   */
  executionTimeoutMs?: number;
  /**
   * 单次 run 的整体超时（毫秒；兼容字段，M5.1 前的唯一超时）。
   * 未设置 executionTimeoutMs 时作为执行阶段超时的默认值；本身缺省 300000。
   */
  runTimeoutMs?: number;
  /**
   * 排队阶段超时（毫秒）：任务在 per-session FIFO 中等待独占权超过该值
   * 即以 timed_out(QUEUE_TIMEOUT) 即时终态（从队列摘除，不等前序 run）。
   * 缺省不限（保持既有行为——排队等待无上限，由上层 stage 超时兜底）。
   */
  queueTimeoutMs?: number;
  /**
   * 会话获取/创建阶段超时（毫秒）：超过即 timed_out(SESSION_TIMEOUT)。
   * 缺省不限。迟到成功的创建会被识别并销毁（不入池、无幽灵会话）。
   */
  sessionTimeoutMs?: number;
  /**
   * Runtime 懒初始化阶段超时（毫秒）：超过即 timed_out(INIT_TIMEOUT)，
   * 初始化本身继续后台收敛（共享 initPromise，后续任务不受影响）。
   * 缺省不限。
   */
  initTimeoutMs?: number;
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
  /**
   * 附加自定义工具（createAgentSession customTools；测试注入用，生产角色
   * 工具面由 roleConfig 白名单决定）。工具执行的 AbortSignal 由 SDK 提供
   * （cancel 传导验证点）。
   */
  customTools?: ToolDefinition[];
  /**
   * 按角色注入的 skill 目录。Pi 会话经
   * noSkills + additionalSkillPaths 完全由 PaperTeam 控制技能面：
   * 只有 assigned 且 installed 的 skill 进入该角色的
   * <available_skills>（progressive disclosure：仅 name/description/location
   * 进 system prompt，正文由 Agent 按需 read）。
   */
  roleSkillDirs?: (role: PiRoleKey) => string[];
  /** 按角色注入的自定义工具（如 researcher/citation 的受控学术检索） */
  roleCustomTools?: (role: PiRoleKey) => ToolDefinition[];
  /** 诊断日志输出，默认 console.log */
  log?: (message: string) => void;
}

/** 模型就绪摘要（statusService 读取；与 RuntimeHealth 分区） */
export type PiModelStatus = RuntimeModelStatus;

/** 进程内受管会话（一个逻辑 sessionKey 一个 Pi AgentSession） */
interface ManagedSession {
  key: string;
  session: AgentSession;
  role: PiRoleConfig;
  cwd: string;
  createdAt: string;
  lastUsedAt: string;
  runCount: number;
  /**
   * per-session 显式 FIFO 排队（Pi Agent 单会话同时只允许一个 run）。
   * 显式队列（而非 promise 链）使排队任务被取消时可直接摘除并即时终态，
   * 不等待前序 run（M5.1 queued cancellation）。
   */
  queue: SessionQueueEntry[];
  /** 当前在该会话上运行的任务（事件归属 + 互斥判定；由队列泵管理） */
  activeTaskId?: string;
  /** 会话级事件订阅的退订函数（close/dispose 兜底） */
  unsubscribe?: () => void;
}

/** per-session 排队项：state 与「获得独占权」的 resolver */
interface SessionQueueEntry {
  state: RunState;
  resolveAcquire: (release: () => void) => void;
}

/** 排队期间被取消的任务的 acquire 释放函数（不 pump：其后的排队者由泵续派） */
const NOOP_RELEASE = (): void => {};

/** 会话创建的 in-flight 去重槽（并发同 key 只创建一次；M5.1 起带等待者计数） */
interface SessionCreationSlot {
  promise: Promise<ManagedSession>;
  /**
   * 仍在等待本创建的任务数：获得会话或提前放弃（session 阶段超时）时递减。
   * 创建迟到成功而等待者已归零 → 会话直接销毁，不入池（无幽灵会话）。
   */
  waiting: number;
  /** promise 已收敛（成功入池 / 迟到销毁 / 失败）；此后新请求走新创建 */
  done: boolean;
}

/**
 * 任务运行状态：v2 handle 的事实源。
 * 事件以 events 数组为单一事实源（有界，保尾部）；消费者用 seq 逻辑游标
 * 回放，缓冲前部裁剪由 bufferStartSeq 显式记账，缺口经 event_gap 暴露。
 */
interface RunState {
  taskId: string;
  sessionKey: string;
  /** 发起任务的角色标识（排队取消路径构建终态用） */
  agentId: string;
  /** startAgent 受理时刻（epoch ms；计时字段唯一事实源） */
  requestedAt: number;
  /** 进入 per-session 队列时刻（epoch ms；未入队任务缺省） */
  queuedAtMs?: number;
  /** 进入执行（session.prompt 开始）时刻（epoch ms；未执行任务缺省） */
  runningAtMs?: number;
  /** settle 时刻（epoch ms；settle 路径写入） */
  settledAtMs?: number;
  /** 映射后的任务事件（单一事实源；只保留最近 TASK_EVENT_BUFFER_LIMIT 条） */
  events: AgentEvent[];
  /** events[0] 的事件 seq（events 为空时 === nextSeq；前部裁剪后右移） */
  bufferStartSeq: number;
  /** 下一个待分配的事件 seq（单调递增，从 1 开始） */
  nextSeq: number;
  /** events 迭代器的唤醒回调（事件新增 / settle 时全部唤醒后清空） */
  eventWaiters: Set<() => void>;
  /** 任务是否已达终态（result 已 resolve/reject） */
  settled: boolean;
  /** resolve 路径终态 */
  task?: AgentTask;
  /** reject 路径错误（timeout / runtime 异常 / 空输出） */
  failure?: unknown;
  /** result 的缓存 promise（settle 时 resolve/reject，可重复 await） */
  resultPromise: Promise<AgentTask>;
  resolveResult: (task: AgentTask) => void;
  rejectResult: (error: unknown) => void;
  /** queued：等待 per-session 队列；running：已独占 session 执行中 */
  phase: "queued" | "running";
  /** cancel 请求（幂等标记；queued 任务据此即时终态或由队列泵/后台链兜底短路） */
  cancelRequested: boolean;
  /** running 阶段已触发过 session.abort（防并发 cancel/timeout 重复 abort） */
  abortRequested: boolean;
  /** 首个发起 session.abort 的归因方（timeout/cancel 竞态的唯一裁决依据） */
  abortInitiator?: "timeout" | "cancel";
  /** 排队阶段超时定时器（入队时武装，出队/取消/超时/settle 时清理） */
  queueTimer?: ReturnType<typeof setTimeout>;
  /** 本 run 新产生的 usage 累计（M5.2；首个 usage-bearing message_end 时创建） */
  usage?: AgentRunUsage;
  /** 后台 run 链完全收敛（cancel/close 等待用） */
  runSettled: Promise<void>;
}

/** 已完结任务记录（getTask 回溯） */
interface TaskRecord {
  task: AgentTask;
}

/** events 返回的迭代器（独立 seq 逻辑游标；break 经 return 清理订阅） */
class AgentEventIterator implements AsyncIterator<AgentEvent>, AsyncIterable<AgentEvent> {
  private readonly state: RunState;
  /** 逻辑游标（下一个待读事件的 seq；-1 = 未初始化，首次 next 取 bufferStartSeq） */
  private cursor = -1;
  private waiter: (() => void) | null = null;

  constructor(state: RunState) {
    this.state = state;
  }

  [Symbol.asyncIterator](): AsyncIterator<AgentEvent> {
    return this;
  }

  async next(): Promise<IteratorResult<AgentEvent>> {
    const state = this.state;
    if (this.cursor === -1) {
      this.cursor = state.bufferStartSeq;
      if (this.cursor > 1) {
        // 订阅晚于截断：先显式报告头部缺口，再从缓冲头开始
        return { done: false, value: gapEvent(state.taskId, 1, this.cursor - 1) };
      }
    }
    // replay（已缓存）与 live（新事件）走同一游标逻辑；不变量：
    // settle 后 events 不再增长，排空即 done。
    while (true) {
      if (this.cursor < state.bufferStartSeq) {
        // 消费者落后于淘汰窗口：显式报告被淘汰区间，再从缓冲头继续——
        // 绝不静默跳过（数组前部裁剪移动的是物理下标，逻辑位置由 seq 保证）
        const missedFrom = this.cursor;
        const missedTo = state.bufferStartSeq - 1;
        this.cursor = state.bufferStartSeq;
        return { done: false, value: gapEvent(state.taskId, missedFrom, missedTo) };
      }
      const index = this.cursor - state.bufferStartSeq;
      const event = index < state.events.length ? state.events[index] : undefined;
      if (event !== undefined) {
        this.cursor += 1;
        return { done: false, value: structuredClone(event) };
      }
      if (state.settled) {
        return { done: true, value: undefined };
      }
      // 等待新事件或 settle；注册后立即复查，杜绝「唤醒先于注册」的竞态悬挂
      await new Promise<void>((resolve) => {
        const wake = (): void => {
          state.eventWaiters.delete(wake);
          resolve();
        };
        this.waiter = wake;
        state.eventWaiters.add(wake);
        if (this.cursor < state.nextSeq || state.settled) {
          wake();
        }
      });
      this.waiter = null;
    }
  }

  async return(): Promise<IteratorResult<AgentEvent>> {
    if (this.waiter !== null) {
      this.state.eventWaiters.delete(this.waiter);
      this.waiter = null;
    }
    return { done: true, value: undefined };
  }
}

/** 缓冲淘汰缺口的显式标记（合成事件；不携带 seq，见 AgentEvent） */
function gapEvent(taskId: string, missedFrom: number, missedTo: number): AgentEvent {
  return {
    taskId,
    type: "event_gap",
    ts: new Date().toISOString(),
    data: { missedFrom, missedTo, missedCount: missedTo - missedFrom + 1 },
  };
}

export class PiRuntimeAdapter implements AgentRuntime {
  readonly provider: RuntimeProvider = "pi";

  private modelSpec: string | undefined;
  /** 启动时的 env API Key（PAPERTEAM_PI_API_KEY）；reconfigure 时按优先级重新注入 */
  private readonly startupApiKey: string | undefined;
  private readonly agentDir: string;
  private readonly workspaceRoot: string;
  private readonly defaultCwd: string;
  /** 执行阶段超时（executionTimeoutMs ?? runTimeoutMs ?? 300000；兼容解析） */
  private readonly executionTimeoutMs: number;
  /** 排队阶段超时（缺省不限） */
  private readonly queueTimeoutMs: number | undefined;
  /** 会话创建阶段超时（缺省不限） */
  private readonly sessionTimeoutMs: number | undefined;
  /** Runtime 懒初始化阶段超时（缺省不限） */
  private readonly initTimeoutMs: number | undefined;
  private readonly injectedModelRuntime: PiModelRuntime | undefined;
  private readonly injectedModel: PiModel | undefined;
  private readonly createSessionImpl: NonNullable<PiRuntimeOptions["createSession"]> | undefined;
  private readonly customTools: ToolDefinition[] | undefined;
  private readonly roleSkillDirs: NonNullable<PiRuntimeOptions["roleSkillDirs"]> | undefined;
  private readonly roleCustomTools: NonNullable<PiRuntimeOptions["roleCustomTools"]> | undefined;
  private readonly log: (message: string) => void;

  private readonly sessions = new Map<string, ManagedSession>();
  /** 会话创建的 in-flight 去重（并发同 key 时只创建一次；带等待者计数） */
  private readonly sessionCreations = new Map<string, SessionCreationSlot>();
  private readonly inFlight = new Map<string, RunState>();
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
    this.startupApiKey = options.apiKey?.trim() || undefined;
    this.agentDir = resolve(options.agentDir);
    this.workspaceRoot = resolve(options.workspaceRoot);
    this.defaultCwd = resolve(options.defaultCwd ?? process.cwd());
    // 兼容解析：未引入 executionTimeoutMs 时沿用 runTimeoutMs 语义
    this.executionTimeoutMs = options.executionTimeoutMs ?? options.runTimeoutMs ?? 300_000;
    this.queueTimeoutMs = options.queueTimeoutMs;
    this.sessionTimeoutMs = options.sessionTimeoutMs;
    this.initTimeoutMs = options.initTimeoutMs;
    this.injectedModelRuntime = options.modelRuntime;
    this.injectedModel = options.model;
    this.createSessionImpl = options.createSession;
    this.customTools = options.customTools;
    this.roleSkillDirs = options.roleSkillDirs;
    this.roleCustomTools = options.roleCustomTools;
    this.log = options.log ?? ((message) => console.log(message));
  }

  // ---- 初始化（懒加载、并发去重；healthCheck 与首个 startAgent 共享） ----

  private ensureInitialized(): Promise<void> {
    if (this.initPromise === undefined) {
      this.initPromise = this.doInitialize().catch((error: unknown) => {
        // 失败不缓存 initPromise 之外的状态：initError 置位后，
        // healthCheck/startAgent 都按「Runtime 不可用」结构化上报。
        this.initError =
          error instanceof Error ? error.message : `Pi Runtime 初始化失败：${String(error)}`;
      });
    }
    return this.initPromise;
  }

  /** protected：测试可用子类注入受控初始化（init 阶段超时验证） */
  protected async doInitialize(): Promise<void> {
    const startedAt = Date.now();
    await mkdir(this.agentDir, { recursive: true });

    // 共享 in-memory settings：关闭 auto-compaction（见文件头取舍）
    this.settingsManager = SettingsManager.inMemory({
      compaction: { enabled: false },
    });

    this.modelRuntime =
      this.injectedModelRuntime ??
      (await ModelRuntime.create({
        authPath: join(this.agentDir, "auth.json"),
        modelsPath: join(this.agentDir, "models.json"),
      }));

    if (this.injectedModel !== undefined) {
      this.model = this.injectedModel;
      this.resolvedModelLabel = `${this.model.provider}/${this.model.id}`;
      this.modelStatus = {
        phase: "configured",
        providers: [this.model.provider],
        detail: `模型 ${this.resolvedModelLabel} 已配置`,
      };
      this.logInitDone(startedAt, false);
      return;
    }
    await this.applyModelConfig();
    this.logInitDone(startedAt, this.modelStatus.phase !== "configured");
  }

  /**
   * 按当前 modelSpec 解析模型并更新就绪状态（doInitialize 与 reconfigure 共享）。
   * env API Key（startupApiKey）在内存覆盖层注入（不落盘）；key 本体不进日志。
   */
  private async applyModelConfig(): Promise<void> {
    this.model = undefined;
    this.resolvedModelLabel = undefined;
    if (this.modelSpec === undefined) {
      this.modelStatus = {
        phase: "not_configured",
        providers: [],
        detail: "PAPERTEAM_PI_MODEL 未设置，且 Settings UI 未保存本地模型配置（如 anthropic/claude-opus-4-5）",
      };
      this.log("[pi-runtime] 未配置模型（PAPERTEAM_PI_MODEL / Settings UI）");
      return;
    }
    const parsed = parseModelSpec(this.modelSpec);
    if (parsed === undefined) {
      this.modelStatus = {
        phase: "not_configured",
        providers: [],
        detail: `模型规格非法："${this.modelSpec}"（应为 provider/model-id）`,
      };
      this.log(`[pi-runtime] 模型规格非法：${this.modelSpec}`);
      return;
    }
    const { provider, modelId } = parsed;
    const modelRuntime = this.modelRuntime!;
    if (this.startupApiKey !== undefined) {
      // 运行时注入（不落盘）；key 本体不进日志
      await modelRuntime.setRuntimeApiKey(provider, this.startupApiKey);
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
      return;
    }
    if (!modelRuntime.hasConfiguredAuth(provider)) {
      this.modelStatus = {
        phase: "not_configured",
        providers: [],
        detail: `模型 ${provider}/${modelId} 已配置，但 provider 无可用凭据（PAPERTEAM_PI_API_KEY / agentDir 下 auth.json / 标准环境变量 / Settings UI 保存）`,
      };
      this.log(`[pi-runtime] provider=${provider} 无可用凭据`);
      return;
    }
    this.model = model;
    this.resolvedModelLabel = `${provider}/${modelId}`;
    this.modelStatus = {
      phase: "configured",
      providers: [model.provider],
      detail: `模型 ${this.resolvedModelLabel} 已配置`,
    };
  }

  private logInitDone(startedAt: number, modelMissing: boolean): void {
    const note = modelMissing ? "（模型未配置：startAgent 将结构化失败）" : "";
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
    // Runtime 健康；模型就绪度单独报告（见 modelStatus）
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

  /** 模型就绪摘要（RuntimeStatusService 读取；非 AgentRuntime 契约） */
  async modelStatusSnapshot(): Promise<PiModelStatus> {
    if (this.closed) {
      return { phase: "unknown", providers: [], detail: "Pi Runtime 已关闭" };
    }
    await this.ensureInitialized();
    return this.modelStatus;
  }

  /** 已解析的模型标签（"provider/model-id"；未配置为 undefined；诊断用） */
  get resolvedModel(): string | undefined {
    return this.resolvedModelLabel;
  }

  /**
   * 运行时重载模型配置（Settings UI）：按新的 modelSpec 重新解析
   * 模型并释放既有 AgentSession。只影响新的 Agent Run：
   * - 存在在途 run 时拒绝（ModelConfigBusyError → 409），不中断活跃任务；
   * - 释放的会话必然空闲（Workspace/checkpoint 是事实源，Runtime session
   *   本就是可丢弃执行上下文，见文件头取舍）；
   * - env API Key（startupApiKey）在重载后按优先级重新注入（env > stored）。
   */
  async reconfigure(modelSpec: string | undefined): Promise<PiModelStatus> {
    if (this.closed) {
      throw new AgentRuntimeUnavailableError("Runtime 已关闭", "adapter closed");
    }
    await this.ensureInitialized();
    if (this.initError !== undefined) {
      throw new AgentRuntimeUnavailableError("Pi Runtime 初始化失败", this.initError);
    }
    if (this.inFlight.size > 0) {
      throw new ModelConfigBusyError(this.inFlight.size);
    }
    if (this.injectedModel !== undefined) {
      // 测试注入模型：不参与动态重配（保持注入语义，模型恒定）
      return { ...this.modelStatus };
    }
    const nextSpec = modelSpec?.trim() || undefined;
    if (nextSpec !== undefined && parseModelSpec(nextSpec) === undefined) {
      throw new AgentRunFailedError(`模型规格非法："${nextSpec}"（应为 provider/model-id）`);
    }
    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(
      sessions.map(async (managed) => {
        managed.unsubscribe?.();
        managed.session.dispose();
      }),
    );
    this.modelSpec = nextSpec;
    await this.applyModelConfig();
    this.log(`[pi-runtime] 模型配置已重载：${this.resolvedModelLabel ?? "(未配置)"}`);
    return { ...this.modelStatus };
  }

  // ---- startAgent（v2 主入口：句柄立即返回，run 在后台收敛） ----

  async startAgent(input: RunAgentInput): Promise<AgentRunHandle> {
    const message = input.task.trim();
    if (message === "") {
      throw new AgentRunFailedError("任务内容为空");
    }
    if (this.closed) {
      throw new AgentRuntimeUnavailableError("Runtime 已关闭", "adapter closed");
    }

    const sessionKey =
      resolveSessionKey(input) ?? adhocSessionKey(input.agentId || "default");
    const scope = sanitizeContextScope(input.contextScope);
    const taskId = `pi-${randomUUID()}`;
    const state = this.createRunState(taskId, sessionKey, input.agentId || "default");

    // init 阶段（懒初始化）：缺省不限时（历史行为）；配置 initTimeoutMs 时
    // 超时 → 句柄仍返回，result 以 AgentTimeoutError("init") reject +
    // timed_out(INIT_TIMEOUT) 结构化终态。初始化本身继续后台收敛——
    // initPromise 全局共享，迟到成功惠及后续任务，不属于本任务。
    if (this.initTimeoutMs === undefined) {
      await this.ensureInitialized();
    } else {
      const initTimeoutMs = this.initTimeoutMs;
      let initTimer: ReturnType<typeof setTimeout> | undefined;
      try {
        await Promise.race([
          this.ensureInitialized(),
          new Promise<never>((_, reject) => {
            initTimer = setTimeout(
              () => reject(new AgentTimeoutError(initTimeoutMs, "init")),
              initTimeoutMs,
            );
            initTimer.unref?.();
          }),
        ]);
      } catch (error) {
        if (error instanceof AgentTimeoutError && error.phase === "init") {
          this.log(`[pi-runtime] startAgent ${taskId} 初始化超时（${initTimeoutMs}ms）`);
          this.settleFailure(state, error);
          return this.makeHandle(state);
        }
        throw error;
      } finally {
        if (initTimer !== undefined) {
          clearTimeout(initTimer);
        }
      }
    }
    if (this.initError !== undefined) {
      throw new AgentRuntimeUnavailableError("Pi Runtime 初始化失败", this.initError);
    }

    // 模型未配置：句柄立即结构化失败（不进 session；口径与 v1 runAgent 一致）
    if (this.model === undefined) {
      this.log(`[pi-runtime] startAgent 拒绝（模型未配置）：sessionKey=${sessionKey}`);
      this.settleTask(
        state,
        this.buildTask({
          taskId,
          agentId: input.agentId,
          status: "failed",
          sessionKey,
          error: `Pi 模型未配置：${this.modelStatus.detail}`,
          errorCode: "MODEL_NOT_CONFIGURED",
        }),
      );
      return this.makeHandle(state);
    }

    // 后台链：会话获取（含排队）→ 独占执行 → 终态归因。
    // startAgent 不 await 这条链——taskId 与句柄立即对上层可见。
    state.runSettled = (async () => {
      let release: (() => void) | undefined;
      try {
        const managed = await this.obtainSession(sessionKey, input, scope, state);
        if (state.settled) {
          // session 阶段已超时（或排队期间被取消并已即时终态）：不入场执行
          return;
        }
        release = await this.acquireSession(managed, state);
        if (state.settled) {
          // 排队期间被取消并已即时终态（出队路径，见 trySettleQueuedCancel）：
          // 不入场执行（activeTaskId 由队列泵管理，此时也未被置位）
          return;
        }
        state.phase = "running";
        state.runningAtMs = Date.now();
        managed.runCount += 1;
        managed.lastUsedAt = new Date().toISOString();

        if (state.cancelRequested) {
          // 派发交接窗口内的取消（尚未及从队列摘除）：不触发 prompt，
          // 也不误伤同会话前序 / 后续任务
          this.log(`[pi-runtime] startAgent ${taskId} 在排队期间被取消，直接终态`);
          this.settleTask(
            state,
            this.buildTask({
              taskId,
              agentId: input.agentId,
              status: "cancelled",
              sessionKey,
              error: "任务已取消（开始执行前）",
            }),
          );
          return;
        }

        const task = await this.runOnSession(managed, { taskId, input, message, state, sessionKey });
        this.settleTask(state, task);
      } catch (error) {
        this.settleFailure(state, error);
      } finally {
        release?.();
        this.inFlight.delete(taskId);
      }
    })();
    this.inFlight.set(taskId, state);

    // input.signal 统一在 startAgent 消费（M5.1）：runAgent 只是
    // startAgent + await result，不再有第二套 signal 实现。
    this.attachAbortSignal(state, input.signal);

    return this.makeHandle(state);
  }

  /**
   * convenience：startAgent + await result（同步终态语义，业务层零改动）。
   * input.signal 的取消语义由 startAgent 内建（见 attachAbortSignal）。
   */
  async runAgent(input: RunAgentInput): Promise<AgentTask> {
    const handle = await this.startAgent(input);
    return handle.result();
  }

  /**
   * RunAgentInput.signal 的唯一消费点：
   * - pre-aborted：立即走取消语义（queued 短路 / running abort）
   * - 监听器 { once } + settle 后显式移除，双保险不泄漏
   * - settle 后到达的 abort 是幂等 no-op（cancelRun 对终态任务直接返回）
   */
  private attachAbortSignal(state: RunState, signal: AbortSignal | undefined): void {
    if (signal === undefined) {
      return;
    }
    const trigger = () => {
      void this.cancelRun(state).catch(() => {});
    };
    if (signal.aborted) {
      trigger();
      return;
    }
    signal.addEventListener("abort", trigger, { once: true });
    void state.runSettled.then(() => {
      signal.removeEventListener("abort", trigger);
    });
  }

  private createRunState(taskId: string, sessionKey: string, agentId: string): RunState {
    let resolveResult!: (task: AgentTask) => void;
    let rejectResult!: (error: unknown) => void;
    const resultPromise = new Promise<AgentTask>((resolve, reject) => {
      resolveResult = resolve;
      rejectResult = reject;
    });
    return {
      taskId,
      sessionKey,
      agentId,
      requestedAt: Date.now(),
      events: [],
      bufferStartSeq: 1,
      nextSeq: 1,
      eventWaiters: new Set(),
      settled: false,
      resultPromise,
      resolveResult,
      rejectResult,
      phase: "queued",
      cancelRequested: false,
      abortRequested: false,
      runSettled: Promise.resolve(),
    };
  }

  private makeHandle(state: RunState): AgentRunHandle {
    return {
      taskId: state.taskId,
      sessionKey: state.sessionKey,
      events: () => new AgentEventIterator(state),
      cancel: () => this.cancelRun(state),
      result: () => state.resultPromise,
    };
  }

  /**
   * 终态统一收口（resolve 路径；first-settle-wins）：计时 / usage 注入 →
   * 任务记录（getTask 可回溯）→ resolve → 唤醒全部等待方。
   */
  private settleTask(state: RunState, task: AgentTask): void {
    if (state.settled) {
      return;
    }
    state.settled = true;
    state.settledAtMs = Date.now();
    this.clearQueueTimer(state);
    const final = this.withTerminalDiagnostics(state, task);
    state.task = final;
    this.rememberTask(final.taskId, final);
    state.resolveResult(final);
    this.wakeEventWaiters(state);
  }

  /**
   * 终态统一收口（reject 路径：timeout / runtime 异常 / 空输出）。
   * reject 不丢状态：错误分类为 timed_out（*_TIMEOUT + timeoutPhase）或
   * failed 后同样写入任务记录（M5.1 结构化终态），再 reject。
   */
  private settleFailure(state: RunState, error: unknown): void {
    if (state.settled) {
      return;
    }
    state.settled = true;
    state.settledAtMs = Date.now();
    this.clearQueueTimer(state);
    state.failure = error;
    const final = this.withTerminalDiagnostics(state, this.buildFailureTask(state, error));
    state.task = final;
    this.rememberTask(final.taskId, final);
    state.rejectResult(error);
    this.wakeEventWaiters(state);
  }

  /**
   * settle 时一次性注入结构化诊断：createdAt/queuedAt/startedAt/completedAt
   * 由 RunState 时钟（epoch ms）派生；duration 非负（Math.max(0, …)）；
   * 未到达的阶段不携带对应字段。usage 为本 run 累计（可能缺省）。
   */
  private withTerminalDiagnostics(state: RunState, task: AgentTask): AgentTask {
    const settledAtMs = state.settledAtMs ?? Date.now();
    const enriched: AgentTask = {
      ...task,
      createdAt: new Date(state.requestedAt).toISOString(),
      updatedAt: new Date(settledAtMs).toISOString(),
      completedAt: new Date(settledAtMs).toISOString(),
      totalDurationMs: Math.max(0, settledAtMs - state.requestedAt),
      ...(state.queuedAtMs !== undefined
        ? { queuedAt: new Date(state.queuedAtMs).toISOString() }
        : {}),
      ...(state.runningAtMs !== undefined
        ? { startedAt: new Date(state.runningAtMs).toISOString() }
        : {}),
      ...(state.queuedAtMs !== undefined
        ? {
            queueDurationMs: Math.max(
              0,
              (state.runningAtMs ?? settledAtMs) - state.queuedAtMs,
            ),
          }
        : {}),
      ...(state.runningAtMs !== undefined
        ? { executionDurationMs: Math.max(0, settledAtMs - state.runningAtMs) }
        : {}),
      ...(state.usage !== undefined ? { usage: { ...state.usage } } : {}),
    };
    return enriched;
  }

  /** reject 路径错误 → 结构化终态（timed_out 携带 phase 归因，failed 携带错误码） */
  private buildFailureTask(state: RunState, error: unknown): AgentTask {
    if (error instanceof AgentTimeoutError) {
      const phase: AgentTimeoutPhase = error.phase ?? "execution";
      return this.buildTask({
        taskId: state.taskId,
        agentId: state.agentId,
        status: "timed_out",
        sessionKey: state.sessionKey,
        error: error.message,
        errorCode: timeoutErrorCode(phase),
        timeoutPhase: phase,
      });
    }
    const message = error instanceof Error ? error.message : String(error);
    return this.buildTask({
      taskId: state.taskId,
      agentId: state.agentId,
      status: "failed",
      sessionKey: state.sessionKey,
      error: message,
      errorCode: "RUN_FAILED",
    });
  }

  private wakeEventWaiters(state: RunState): void {
    const waiters = [...state.eventWaiters];
    state.eventWaiters.clear();
    for (const waiter of waiters) {
      waiter();
    }
  }

  /** 取消单个 run（幂等；handle.cancel、input.signal、close 共用） */
  private async cancelRun(state: RunState): Promise<void> {
    if (state.settled) {
      return; // 已完成 / 已取消 / 已失败 / 已超时：幂等 no-op
    }
    state.cancelRequested = true;
    if (state.phase === "running") {
      // 并发 cancel（signal + handle.cancel）只触发一次真实 abort；
      // timeout 已先发起 abort 时归因保持 timeout（abortInitiator 只记首个）
      if (!state.abortRequested) {
        state.abortRequested = true;
        if (state.abortInitiator === undefined) {
          state.abortInitiator = "cancel";
        }
        const managed = this.sessions.get(state.sessionKey);
        if (managed !== undefined) {
          await managed.session.abort().catch(() => {});
        }
      }
      await state.runSettled;
      return;
    }
    // queued 任务：优先从队列即时摘除终态（不等前序 run）；
    // 会话创建中 / 派发交接窗口内则由后台链兜底。
    if (this.trySettleQueuedCancel(state)) {
      await state.runSettled;
      return;
    }
    await state.runSettled;
  }

  /** 排队超时定时器清理（出队 / 取消 / settle 等所有离开排队阶段的路径） */
  private clearQueueTimer(state: RunState): void {
    if (state.queueTimer !== undefined) {
      clearTimeout(state.queueTimer);
      state.queueTimer = undefined;
    }
  }

  /** 在已独占的会话上执行一次 run（超时 / abort / 终态归因都在这里收敛） */
  private async runOnSession(
    managed: ManagedSession,
    context: {
      taskId: string;
      input: RunAgentInput;
      message: string;
      state: RunState;
      sessionKey: string;
    },
  ): Promise<AgentTask> {
    const { taskId, input, message, state, sessionKey } = context;
    this.attachEventForwarder(managed, taskId, state);

    // 执行阶段超时（M5.1 分层）：只在 session.prompt 开始后计时。
    // timeout 与 cancel 竞态的归因规则：abortInitiator 只记首个发起
    // session.abort 的一方——deadline 先到 → timed_out；cancel 先到 →
    // cancelled（即便底层 Pi 都表现为 abort）。
    const executionTimeoutMs = input.timeoutMs ?? this.executionTimeoutMs;
    const timer = setTimeout(() => {
      if (state.settled || state.abortInitiator !== undefined) {
        // 任务已终态，或 cancel 已先发起 abort（归因归 cancel）：不重复 abort
        return;
      }
      state.abortRequested = true;
      state.abortInitiator = "timeout";
      this.log(`[pi-runtime] runAgent ${taskId} 执行超时（${executionTimeoutMs}ms），执行 abort`);
      void managed.session.abort().catch(() => {});
    }, executionTimeoutMs);
    timer.unref?.();

    let promptError: unknown;
    try {
      await managed.session.prompt(message, { expandPromptTemplates: false });
    } catch (error) {
      promptError = error;
    } finally {
      clearTimeout(timer);
      this.eventForwarders.delete(taskId);
    }

    if (state.abortInitiator === "timeout") {
      await managed.session.waitForIdle().catch(() => {});
      throw new AgentTimeoutError(executionTimeoutMs, "execution");
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
        error: `Pi AgentSession 拒绝执行：${detail}`,
        errorCode: "PROMPT_REJECTED",
      });
    }

    // prompt 正常 resolve：终态落在 transcript 的最后一条 assistant 消息
    const last = lastAssistantMessage(managed.session);
    const stopReason = last?.stopReason;

    // 工具执行中 abort 的实测路径：SDK 将终态记为
    // stopReason="error" + errorMessage="This operation was aborted"
    // （LLM 流中断才是 "aborted"）。以 Adapter 侧的取消意图为准归因，
    // 不依赖 SDK 的 stopReason 编码差异。
    if (state.cancelRequested && (stopReason === "error" || stopReason === "aborted")) {
      this.log(`[pi-runtime] runAgent ${taskId} 终态=${stopReason ?? "(none)"}（cancelRequested → cancelled）`);
      return this.buildTask({
        taskId,
        agentId: input.agentId,
        status: "cancelled",
        sessionKey,
        error: "任务已取消（session.abort）",
      });
    }

    if (stopReason === "error") {
      const errorText = last?.errorMessage ?? "Pi agent run 以 error 终态结束";
      this.log(`[pi-runtime] runAgent ${taskId} 终态=error：${errorText}`);
      return this.buildTask({
        taskId,
        agentId: input.agentId,
        status: "failed",
        sessionKey,
        error: errorText,
        errorCode: "RUN_FAILED",
      });
    }

    if (stopReason === "aborted") {
      // 超时路径已在上面抛 AgentTimeoutError；到这里说明是 cancel 触发的 abort
      this.log(`[pi-runtime] runAgent ${taskId} 终态=aborted（cancelled）`);
      return this.buildTask({
        taskId,
        agentId: input.agentId,
        status: "cancelled",
        sessionKey,
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
    output?: string;
    error?: string;
    /** 结构化错误码（failed/timed_out 携带；completed/cancelled 不携带） */
    errorCode?: string;
    /** 超时归属阶段（仅 timed_out 携带） */
    timeoutPhase?: AgentTimeoutPhase;
    model?: string;
    role?: string;
  }): AgentTask {
    // createdAt / startedAt / completedAt 等计时字段由 settle 路径统一注入
    // （withTerminalDiagnostics），这里只占位保证类型完整
    const now = new Date().toISOString();
    const task: AgentTask = {
      taskId: fields.taskId,
      agentId: fields.agentId,
      status: fields.status,
      createdAt: now,
      updatedAt: now,
      ...(fields.output !== undefined ? { output: fields.output } : {}),
      ...(fields.error !== undefined ? { error: fields.error } : {}),
      ...(fields.errorCode !== undefined ? { errorCode: fields.errorCode } : {}),
      ...(fields.timeoutPhase !== undefined ? { timeoutPhase: fields.timeoutPhase } : {}),
      metadata: {
        sessionKey: fields.sessionKey,
        ...(fields.model !== undefined ? { model: fields.model } : {}),
        ...(fields.role !== undefined ? { role: fields.role } : {}),
      },
    };
    return task;
  }

  private rememberTask(taskId: string, task: AgentTask): void {
    this.taskRecords.set(taskId, { task });
    while (this.taskRecords.size > TASK_RECORD_LIMIT) {
      const oldest = this.taskRecords.keys().next().value;
      if (oldest === undefined) {
        break;
      }
      this.taskRecords.delete(oldest);
    }
  }

  // ---- 会话管理（进程内 registry；per-session 串行、跨 session 并发） ----

  /**
   * 任务链的会话获取入口（M5.1 起含 session 阶段超时）：
   * - 命中池内会话 → 直接返回（无阶段开销）；
   * - 否则加入（或发起）该 key 的 in-flight 创建，配置了 sessionTimeoutMs
   *   时与定时器竞速：超时 → AgentTimeoutError("session") reject（由后台链
   *   catch 收敛为 timed_out(SESSION_TIMEOUT) 终态），创建继续后台收敛；
   * - 等待者计数保证「迟到成功的创建」可识别：所有等待者都已放弃时，
   *   迟到会话直接销毁、不入池（无幽灵会话，见 createSessionSlot）。
   */
  private async obtainSession(
    sessionKey: string,
    input: RunAgentInput,
    scope: string | undefined,
    state: RunState,
  ): Promise<ManagedSession> {
    void state; // 归因走异常通道（AgentTimeoutError.phase），state 仅备用
    const existing = this.sessions.get(sessionKey);
    if (existing !== undefined) {
      return existing;
    }
    let slot = this.sessionCreations.get(sessionKey);
    if (slot === undefined || slot.done) {
      slot = this.createSessionSlot(sessionKey, input, scope);
      this.sessionCreations.set(sessionKey, slot);
    }
    const creation = slot;
    creation.waiting += 1;
    const timeoutMs = this.sessionTimeoutMs;
    if (timeoutMs === undefined) {
      try {
        return await creation.promise;
      } finally {
        creation.waiting -= 1;
      }
    }
    let phaseTimer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await new Promise<ManagedSession>((resolve, reject) => {
        phaseTimer = setTimeout(() => reject(new AgentTimeoutError(timeoutMs, "session")), timeoutMs);
        phaseTimer.unref?.();
        creation.promise.then(resolve, reject);
      });
    } finally {
      if (phaseTimer !== undefined) {
        clearTimeout(phaseTimer);
      }
      creation.waiting -= 1;
    }
  }

  /**
   * 发起一次会话创建（去重槽）。成功时若仍有等待者（waiting > 0）→ 正常
   * 入池；等待者已全部放弃（超时离开）→ 迟到会话销毁并不入池，promise 以
   * AgentRunFailedError reject（此刻已无人等待，仅作槽收敛信号）。
   */
  private createSessionSlot(
    sessionKey: string,
    input: RunAgentInput,
    scope: string | undefined,
  ): SessionCreationSlot {
    const slot = {} as SessionCreationSlot;
    slot.waiting = 0;
    slot.done = false;
    slot.promise = this.doCreateSession(sessionKey, input, scope)
      .then(
        (managed) => {
          slot.done = true;
          if (slot.waiting <= 0 && !this.closed) {
            this.log(
              `[pi-runtime] 迟到会话销毁（等待者已全部因 session 超时放弃）：sessionKey=${sessionKey}`,
            );
            managed.unsubscribe?.();
            managed.session.dispose();
            throw new AgentRunFailedError(`会话创建迟到（等待者已放弃）：sessionKey=${sessionKey}`);
          }
          this.sessions.set(sessionKey, managed);
          return managed;
        },
        (error: unknown) => {
          slot.done = true;
          throw error;
        },
      )
      .finally(() => {
        if (this.sessionCreations.get(sessionKey) === slot) {
          this.sessionCreations.delete(sessionKey);
        }
      });
    return slot;
  }

  private async doCreateSession(
    sessionKey: string,
    input: RunAgentInput,
    scope: string | undefined,
  ): Promise<ManagedSession> {
    const role = resolveRoleConfig(scope);
    const cwd = this.resolveWorkspaceCwd(input.projectId);
    await mkdir(cwd, { recursive: true }).catch(() => {});

    // 技能面完全自控：关闭全部默认发现（workspace/.pi、~/.pi 等），
    // 只注入 PaperTeam Skill Store 中该角色 assigned 的 skill 目录。
    const skillDirs = this.roleSkillDirs?.(role.role) ?? [];
    const resourceLoader = new DefaultResourceLoader({
      cwd,
      agentDir: this.agentDir,
      settingsManager: this.settingsManager!,
      systemPromptOverride: () => role.systemPrompt,
      noSkills: true,
      ...(skillDirs.length > 0 ? { additionalSkillPaths: skillDirs } : {}),
    });
    await resourceLoader.reload();

    const sessionManager = SessionManager.inMemory(cwd);
    // 角色级自定义工具（受控学术检索等）与全局 customTools 合并注入
    const roleTools = this.roleCustomTools?.(role.role) ?? [];
    const allCustomTools = [...(this.customTools ?? []), ...roleTools];
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
              // tools 是白名单（allowedToolNames）：自定义工具名必须并入，
              // 否则 _refreshToolRegistry 会把未列入白名单的 customTools 过滤掉
              tools: [
                ...role.tools,
                ...allCustomTools.map((tool) => tool.name),
              ],
              ...(allCustomTools.length > 0 ? { customTools: allCustomTools } : {}),
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
      queue: [],
    };
    managed.unsubscribe = this.wireSessionEvents(managed);
    // 入池由 createSessionSlot 决定（迟到成功的会话在等待者已全部放弃时
    // 直接销毁，不入池——无幽灵会话）
    this.log(
      `[pi-runtime] 创建会话 sessionKey=${sessionKey} role=${role.role} tools=[${[...role.tools, ...allCustomTools.map((tool) => tool.name)].join(",")}] skills=[${skillDirs.length}] cwd=${cwd}`,
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
  private acquireSession(managed: ManagedSession, state: RunState): Promise<() => void> {
    return new Promise((resolveAcquire) => {
      // 取消先于入队到达（signal/abort 与后台链竞态）且会话忙：泵不会
      // 扫描忙会话的队列，直接不排队、即时终态
      if (state.cancelRequested && managed.activeTaskId !== undefined) {
        this.dispatchCancelAtQueue({ state, resolveAcquire });
        return;
      }
      state.queuedAtMs = Date.now();
      if (this.queueTimeoutMs !== undefined) {
        // 排队阶段超时（M5.1 分层）：到点仍未获得独占权 → 从队列即时摘除，
        // timed_out(QUEUE_TIMEOUT) 终态，不等前序 run、不误伤后续排队者
        const queueTimeoutMs = this.queueTimeoutMs;
        state.queueTimer = setTimeout(() => {
          state.queueTimer = undefined;
          if (state.settled || state.phase === "running") {
            return;
          }
          this.trySettleQueuedTimeout(state);
        }, queueTimeoutMs);
        state.queueTimer.unref?.();
      }
      managed.queue.push({ state, resolveAcquire });
      this.pumpSessionQueue(managed);
    });
  }

  /**
   * 会话队列泵：空闲即派发队首；排队期间已被取消/超时的条目直接以对应
   * 终态出队（不入场执行），并继续检查后续排队者——被摘除条目不阻塞队列。
   */
  private pumpSessionQueue(managed: ManagedSession): void {
    while (managed.activeTaskId === undefined) {
      const entry = managed.queue.shift();
      if (entry === undefined) {
        return;
      }
      if (entry.state.settled || entry.state.cancelRequested) {
        this.dispatchCancelAtQueue(entry);
        continue;
      }
      managed.activeTaskId = entry.state.taskId;
      // 出队进入执行：排队超时定时器退役（执行阶段有独立超时）
      this.clearQueueTimer(entry.state);
      const state = entry.state;
      entry.resolveAcquire(() => {
        if (managed.activeTaskId === state.taskId) {
          managed.activeTaskId = undefined;
        }
        this.pumpSessionQueue(managed);
      });
      return;
    }
  }

  /** 队列中的任务以取消终态收场：settle + 释放其 acquire（noop，不重复泵） */
  private dispatchCancelAtQueue(entry: SessionQueueEntry): void {
    this.clearQueueTimer(entry.state);
    if (!entry.state.settled) {
      this.log(
        `[pi-runtime] startAgent ${entry.state.taskId} 在排队中被取消，直接终态（不等待前序 run）`,
      );
      this.settleTask(
        entry.state,
        this.buildTask({
          taskId: entry.state.taskId,
          agentId: entry.state.agentId,
          status: "cancelled",
          sessionKey: entry.state.sessionKey,
          error: "任务已取消（开始执行前）",
        }),
      );
    }
    entry.resolveAcquire(NOOP_RELEASE);
  }

  /**
   * queued 任务被取消：直接从所属会话队列摘除并即时终态。
   * 返回 false 表示尚未进入任何队列（会话创建中 / 正在派发交接），
   * 由后台链获得会话后的取消检查兜底。
   */
  private trySettleQueuedCancel(state: RunState): boolean {
    const managed = this.sessions.get(state.sessionKey);
    if (managed === undefined) {
      return false;
    }
    const index = managed.queue.findIndex((entry) => entry.state === state);
    if (index < 0) {
      return false;
    }
    const [entry] = managed.queue.splice(index, 1);
    if (entry !== undefined) {
      this.dispatchCancelAtQueue(entry);
    }
    return true;
  }

  /**
   * queued 任务排队超时：从队列即时摘除，以 timed_out(QUEUE_TIMEOUT)
   * settle（result reject AgentTimeoutError("queue")，getTask 可查结构化
   * 终态）。前序 run 与后续排队者完全不受影响。
   */
  private trySettleQueuedTimeout(state: RunState): boolean {
    const queueTimeoutMs = this.queueTimeoutMs;
    if (queueTimeoutMs === undefined) {
      return false;
    }
    const managed = this.sessions.get(state.sessionKey);
    if (managed === undefined) {
      return false;
    }
    const index = managed.queue.findIndex((entry) => entry.state === state);
    if (index < 0) {
      return false;
    }
    const [entry] = managed.queue.splice(index, 1);
    this.clearQueueTimer(state);
    if (entry === undefined) {
      return false;
    }
    this.log(
      `[pi-runtime] startAgent ${state.taskId} 排队超时（${queueTimeoutMs}ms），即时终态（不等待前序 run）`,
    );
    this.settleFailure(state, new AgentTimeoutError(queueTimeoutMs, "queue"));
    entry.resolveAcquire(NOOP_RELEASE);
    return true;
  }

  // ---- 事件（Pi → PaperTeam AgentEvent 映射；写入 RunState 事实源） ----

  private eventForwarders = new Map<string, (event: AgentSessionEvent) => void>();

  private attachEventForwarder(managed: ManagedSession, taskId: string, state: RunState): void {
    void managed;
    // 会话创建时已挂持久 listener（见 wireSessionEvents）；
    // 这里登记当前任务的事件转发器，listener 按 activeTaskId 分发。
    this.eventForwarders.set(taskId, (event) => {
      if (event.type === "message_end") {
        // run 级 usage 累计（M5.2 基础采集）：只统计本 run 期间送达的
        // assistant 消息——forwarder 仅在独占会话期间挂载，会话复用不会
        // 重复计入历史 turn（见 accumulateRunUsage 的语义注释）
        accumulateRunUsage(state, event);
      }
      const mapped = mapPiEvent(taskId, event);
      if (mapped === undefined) {
        return;
      }
      mapped.seq = state.nextSeq;
      state.nextSeq += 1;
      state.events.push(mapped);
      if (state.events.length > TASK_EVENT_BUFFER_LIMIT) {
        const dropped = state.events.length - TASK_EVENT_BUFFER_LIMIT;
        state.events.splice(0, dropped);
        state.bufferStartSeq += dropped;
      }
      this.wakeEventWaiters(state);
    });
  }

  /** 会话创建后立即挂持久 listener：向当前活跃任务转发器分发事件 */
  private wireSessionEvents(managed: ManagedSession): () => void {
    return managed.session.subscribe((event) => {
      const taskId = managed.activeTaskId;
      if (taskId === undefined) {
        return;
      }
      this.eventForwarders.get(taskId)?.(event);
    });
  }

  // ---- 任务级接口 ----

  /** 查询已完结任务（运行中任务经 handle.result 获取终态） */
  async getTask(taskId: string): Promise<AgentTask> {
    const record = this.taskRecords.get(taskId);
    if (record !== undefined) {
      return structuredClone(record.task);
    }
    if (this.inFlight.has(taskId)) {
      throw new AgentRunFailedError(`任务 ${taskId} 仍在运行（请经 handle.result() 获取终态）`);
    }
    throw new AgentRunFailedError(`任务不存在或已超出回溯窗口（${TASK_RECORD_LIMIT} 条）：${taskId}`);
  }

  /**
   * 查询在途任务（非 AgentRuntime 契约；诊断用）。
   */
  listActiveTasks(): { taskId: string; sessionKey: string; phase: "queued" | "running"; startedAt: string }[] {
    return [...this.inFlight.values()].map(({ taskId, sessionKey, phase, requestedAt }) => ({
      taskId,
      sessionKey,
      phase,
      startedAt: new Date(requestedAt).toISOString(),
    }));
  }

  /** 会话/在途诊断快照（非 AgentRuntime 契约；RuntimeStatusService 读取） */
  runtimeStats(): { activeRuns: number; managedSessions: number } {
    return { activeRuns: this.inFlight.size, managedSessions: this.sessions.size };
  }

  /**
   * 释放某项目的全部 Runtime 会话（项目永久删除时的最小清理 seam）。
   *
   * sessionKey 派生规则（./sessionKey.ts）保证项目会话形如
   *   agent:{agentId}:paperteam-{projectId}          （无 scope）
   *   agent:{agentId}:paperteam-{projectId}--{scope} （有 scope）
   * 按 projectId 边界精确匹配（p-x1 不误伤 p-x12）。
   * 语义与 close 相同但只作用于该项目：取消其在途 run → 等收敛 → dispose 会话。
   * Workspace/checkpoint 是事实源，会话只是可丢弃执行上下文。
   */
  async releaseProjectSessions(projectId: string): Promise<number> {
    if (this.closed) {
      return 0;
    }
    const owned = (sessionKey: string): boolean => {
      const peer = sessionKey.split(":")[2] ?? "";
      return peer === `paperteam-${projectId}` || peer.startsWith(`paperteam-${projectId}--`);
    };
    const matchingSessions = [...this.sessions.values()].filter((managed) => owned(managed.key));
    const matchingRuns = [...this.inFlight.values()].filter((state) => owned(state.sessionKey));
    for (const state of matchingRuns) {
      state.cancelRequested = true;
      if (state.phase === "running" && !state.abortRequested) {
        state.abortRequested = true;
        if (state.abortInitiator === undefined) {
          state.abortInitiator = "cancel";
        }
        void this.sessions.get(state.sessionKey)?.session.abort().catch(() => {});
      }
    }
    // queued 任务即时终态（不等同项目前序 run 收敛）
    for (const state of matchingRuns) {
      if (state.phase === "queued") {
        this.trySettleQueuedCancel(state);
      }
    }
    await Promise.allSettled(matchingRuns.map((state) => state.runSettled));
    for (const managed of matchingSessions) {
      this.sessions.delete(managed.key);
      managed.unsubscribe?.();
      managed.session.dispose();
    }
    if (matchingSessions.length > 0) {
      this.log(
        `[pi-runtime] 释放项目会话：projectId=${projectId} sessions=${matchingSessions.length} runsCancelled=${matchingRuns.length}`,
      );
    }
    return matchingSessions.length;
  }

  // ---- 生命周期 ----

  /** 取消/收敛全部在途 run 并释放所有 AgentSession（幂等；进程 shutdown 时调用） */
  async close(): Promise<void> {
    this.closed = true;
    const states = [...this.inFlight.values()];
    for (const state of states) {
      state.cancelRequested = true;
      if (state.phase === "running" && !state.abortRequested) {
        // close 窗口内与执行超时并发时归因仍唯一：abort 已被 timeout 发起
        // 则保持 timeout 归因（timed_out），close 的取消意图不覆盖
        state.abortRequested = true;
        if (state.abortInitiator === undefined) {
          state.abortInitiator = "cancel";
        }
        const managed = this.sessions.get(state.sessionKey);
        if (managed !== undefined) {
          void managed.session.abort().catch(() => {});
        }
      }
    }
    // queued 任务即时终态（不等前序 run 收敛）；派发交接中的由后台链兜底
    for (const state of states) {
      if (state.phase === "queued") {
        this.trySettleQueuedCancel(state);
      }
    }
    // 等全部 run 收敛（含 queued 任务的直接终态路径）
    await Promise.allSettled(states.map((state) => state.runSettled));

    const sessions = [...this.sessions.values()];
    this.sessions.clear();
    this.eventForwarders.clear();
    await Promise.allSettled(
      sessions.map(async (managed) => {
        managed.unsubscribe?.();
        managed.session.dispose();
      }),
    );
    // 兜底：close 窗口内并发创建、晚于上方快照落位的会话一并释放（防泄漏）
    const lateSessions = [...this.sessions.values()];
    this.sessions.clear();
    await Promise.allSettled(
      lateSessions.map(async (managed) => {
        managed.unsubscribe?.();
        managed.session.dispose();
      }),
    );
  }
}

// ---- 辅助函数 ----

/** 超时阶段 → 结构化错误码（timed_out 终态的 errorCode） */
function timeoutErrorCode(phase: AgentTimeoutPhase): string {
  return `${phase.toUpperCase()}_TIMEOUT`;
}

/**
 * message_end → run 级 usage 累计（M5.2 基础采集）。
 *
 * Pi 原生语义（@earendil-works/pi-ai Usage，0.84.4）：
 * - input / output / cacheRead / cacheWrite 是「本条 assistant 消息（本次
 *   LLM 请求）」的增量 → 跨 turn 求和即 run 总量；
 * - totalTokens 是「本次请求时的上下文规模」快照 → contextTokens 只保留
 *   最后一个有效值，绝不跨 turn 累加；
 * - cost.total 是 provider 按 list-price 的估算 → estimatedCost 求和，
 *   provider 未返回则整体缺省（不自行计价、不伪造 0 成本结论）。
 *
 * 防重复计数：只在 run 独占会话期间的 message_end 事件上累计（调用点
 * attachEventForwarder → runOnSession finally 摘除）；Pi subscribe 为纯
 * live 事件流（无 replay），会话复用时历史 turn 不会再次送达。
 * 非 assistant 消息、usage 缺失或字段非法 → 跳过该 turn（不伪造数据）。
 */
function accumulateRunUsage(state: RunState, event: AgentSessionEvent): void {
  const message = (event as { message?: { role?: unknown; usage?: unknown } }).message;
  if (message === undefined || message.role !== "assistant") {
    return;
  }
  const usage = message.usage;
  if (typeof usage !== "object" || usage === null) {
    return;
  }
  const readNumber = (value: unknown): number | undefined =>
    typeof value === "number" && Number.isFinite(value) ? value : undefined;
  const record = usage as {
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
    totalTokens?: unknown;
    cost?: { total?: unknown };
  };
  const input = readNumber(record.input);
  const output = readNumber(record.output);
  const cacheRead = readNumber(record.cacheRead);
  const cacheWrite = readNumber(record.cacheWrite);
  const totalTokens = readNumber(record.totalTokens);
  const cost = readNumber(record.cost?.total);
  if (state.usage === undefined) {
    state.usage = {
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      contextTokens: 0,
      assistantTurns: 0,
    };
  }
  const acc = state.usage;
  acc.inputTokens += input ?? 0;
  acc.outputTokens += output ?? 0;
  acc.cacheReadTokens += cacheRead ?? 0;
  acc.cacheWriteTokens += cacheWrite ?? 0;
  if (cost !== undefined) {
    acc.estimatedCost = (acc.estimatedCost ?? 0) + cost;
  }
  if (totalTokens !== undefined) {
    acc.contextTokens = totalTokens;
  }
  acc.assistantTurns += 1;
}

/**
 * "provider/model-id" 解析（首段为 provider，其余整体为 model-id；均非空）。
 * modelId 本身可含 "/"（如 openrouter 的 "anthropic/claude-sonnet-4"，
 * Pi 注册表内该 provider 的模型 id 即为带斜杠形式）；Settings 服务共享校验。
 */
export function parseModelSpec(spec: string): { provider: string; modelId: string } | undefined {
  const trimmed = spec.trim();
  const slash = trimmed.indexOf("/");
  if (slash <= 0) {
    return undefined;
  }
  const provider = trimmed.slice(0, slash).trim();
  const modelId = trimmed.slice(slash + 1).trim();
  if (provider === "" || modelId === "") {
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
      // compaction / retry / queue 等 session 级事件：不映射
      return undefined;
  }
}
