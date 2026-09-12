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
 * - 全局并发与有界受理（M5.2）：进程内全局 execution guard——整个
 *   Adapter 同时真实执行（进入 session.prompt）的 run 数 <=
 *   maxConcurrentRuns（FIFO permit 派发，不 LIFO / 不插队）；已受理
 *   未执行（等待会话创建 / per-session FIFO / 全局 permit）的 run 数
 *   <= maxQueuedRuns，占满后 startAgent 立即 failed(RUNTIME_QUEUE_FULL)
 *   结构化失败（不建会话、不排队；与 QUEUE_TIMEOUT 的「已进入等待但
 *   超过 deadline」语义互斥，绝不互相伪装）。permit 在任务到达 session
 *   队头后才申请——同 session 的排队任务不提前占用全局 permit（不会
 *   出现「跑不了却占坑」阻塞其他 session）。permit 等待属于 queue 阶段：
 *   由统一的 queueTimeoutMs deadline 覆盖（入队时武装、跨阶段切换不
 *   重置）。记账收口在 settle（first-wins）：completed / failed /
 *   cancelled / timed_out / close 全路径都释放 permit 与等待容量。
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
 * - 长程治理（M5.2 收口，任务 H/I/J/K）：
 *   - Context Budget：contextWindow / maxTokens 只取 resolved Pi Model
 *     （不维护模型表）。任务成为会话队头、prompt 之前做 preflight：
 *     当前上下文（上一 run 的 provider 实测 usage.totalTokens 优先，
 *     CJK 感知估算兜底）+ 下次输入估算 + 输出预留
 *     （min(maxTokens, ⌈window×25%⌉, 32768)，可配置）超窗 → rotation；
 *     即使全新会话也装不下 → failed(CONTEXT_BUDGET_EXCEEDED)（不调
 *     provider、不静默截断 Evidence/稿件）。usage 不可得时 runCount
 *     上限兜底。auto-compaction 保持关闭。
 *   - Session Rotation：ManagedSession 是稳定调度容器（sessionKey /
 *     FIFO 队列 / activeTaskId 不变），内部 Pi AgentSession 按
 *     generation 替换。rotation 只发生在安全边界（队头任务独占会话、
 *     已持有全局 permit、尚未 prompt），绝不 dispose 正被他人使用的
 *     会话。不做摘要迁移：Workspace/checkpoint + 本轮业务 prompt 是
 *     新会话的完整事实源。
 *   - TTL / GC / 容量：idle（无 active、无排队、无到达中任务）超过
 *     TTL 的会话由 GC 回收（周期定时器 unref + settle/容量机会式触发）；
 *     池内会话 + 在建槽位达到 maxSessions 时先收 TTL、再 LRU 淘汰
 *     idle，全忙则 failed(RUNTIME_SESSION_CAPACITY)。active / queued /
 *     到达中的会话绝不被回收（pendingArrivals 覆盖「命中会话 → 入队」
 *     的 microtask 窗口）。
 *   - Self-healing：execution timeout / prompt 异常后会话状态不确定 →
 *     标记 needsRotation，下一安全边界重建底层会话。只恢复 Runtime
 *     后续可用性，绝不自动重试业务任务。进程崩溃的边界如实：内存中的
 *     AgentSession 无法迁移，Workspace/checkpoint 语义不变（已完成
 *     stage 保留，未完成调用由 Workflow 层处理）。
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
import { assertValidConcurrency } from "../util/concurrency.js";
import {
  computeOutputReserve,
  estimatePromptTokens,
  estimateSessionContextTokens,
} from "./pi/contextBudget.js";
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
  RuntimeSessionStats,
  SessionDiagnosticEntry,
} from "./types.js";

/** Pi 模型类型（不直接依赖 pi-ai：经 pi-coding-agent 的公开选项类型提取） */
type PiModel = NonNullable<CreateAgentSessionOptions["model"]>;

/** Pi ModelRuntime 实例类型（pi-coding-agent 公开导出；构造器私有，用类名取实例类型） */
type PiModelRuntime = ModelRuntime;

/** 每任务事件缓冲上限（超出丢最旧保尾部；缺口经 event_gap 显式暴露，见 AgentEventIterator） */
const TASK_EVENT_BUFFER_LIMIT = 500;

/** 已完结任务记录上限（getTask 可回溯的窗口） */
const TASK_RECORD_LIMIT = 200;

/**
 * 全局最大同时执行数默认值（M5.2）：>= Reviewer 三路 fan-out（3 路
 * scope 并行是既有正常形态），再留一路余量吸收跨 stage 交叠。
 */
const DEFAULT_MAX_CONCURRENT_RUNS = 4;

/** 全局最大等待任务数默认值（M5.2）：单机单用户，32 足以吸收 Workflow 级排队 */
const DEFAULT_MAX_QUEUED_RUNS = 32;

/**
 * 单会话 run 数回转上限默认值（M5.2 任务 I）：context usage 不可得/
 * 非实测时的生命周期 fallback。依据：PaperTeam 单 scope 的正常 run 密度
 * 约 5-15 次（调研/成文/复审），32 已覆盖 P95；按每 run 2-8k token 的
 * 典型增量，32 run 累计 64-256k，恰好在主流模型上下文上限附近封顶。
 */
const DEFAULT_MAX_RUNS_PER_SESSION = 32;

/**
 * 会话空闲 TTL 默认值（M5.2 任务 J）：30 分钟。依据：多轮审稿-修订
 * 工作流的 stage 间隔通常在分钟级（LaTeX 编译 / Quality Gate / HITL），
 * 空闲 30 分钟意味着该 scope 的本轮工作确实结束；期间到达的任务会刷新
 * lastUsedAt，活跃 scope 不会被误回收。
 */
const DEFAULT_SESSION_IDLE_TTL_MS = 30 * 60_000;

/**
 * 受管会话数上限默认值（M5.2 任务 J）：16。依据：4 角色 ×（默认 + 至多
 * 3 个 contextScope）× 单活跃项目 ≈ 12-16；多项目长期驻留的会话由
 * idle TTL 兜底回收，容量上限只防无界增长。
 */
const DEFAULT_MAX_SESSIONS = 16;

/** GC 周期扫描间隔（未显式注入时按 TTL/4 推导，并夹紧到 [1s, 60s]） */
const GC_SWEEP_MIN_INTERVAL_MS = 1_000;
const GC_SWEEP_MAX_INTERVAL_MS = 60_000;

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
  /**
   * 全局最大同时执行数（M5.2）：整个 Adapter 同时真实进入 session.prompt
   * 的 run 数上限（FIFO permit，跨 project / agentId / contextScope /
   * Reviewer 类型 / Workflow 统一生效）。缺省 4；必须 >= 1（构造校验）。
   */
  maxConcurrentRuns?: number;
  /**
   * 全局最大等待任务数（M5.2）：已受理、尚未开始执行的 run 数上限（含
   * 等待会话创建 / per-session FIFO / 全局 permit 三种执行前等待）。
   * 占满后 startAgent 立即 failed(RUNTIME_QUEUE_FULL)。缺省 32；
   * 0 = 不允许任何等待；必须 >= 0（构造校验）。
   */
  maxQueuedRuns?: number;
  /**
   * 单会话 run 数回转上限（M5.2 任务 I）：context usage 不可得或非实测
   * （provider 不返回 usage）时的 rotation fallback。实测 basis 下 context
   * budget 优先，不按 run 数回转。缺省 32；必须 >= 1（构造校验）。
   */
  maxRunsPerSession?: number;
  /**
   * 会话空闲 TTL（毫秒，M5.2 任务 J）：会话无在途 run、无排队、无到达中
   * 任务持续该时长后由 GC 回收（unsubscribe + dispose + 出池）。缺省
   * 30 分钟；必须 >= 1（config 层对 env 来源另设 >= 60s 下限）。
   */
  sessionIdleTtlMs?: number;
  /**
   * 受管会话数硬上限（M5.2 任务 J）：新建会话时若池内会话 + 在建槽位达到
   * 上限，先回收 TTL 过期的空闲会话，再按 LRU 淘汰空闲会话；全部忙则
   * failed(RUNTIME_SESSION_CAPACITY)。缺省 16；必须 >= 1（构造校验）。
   */
  maxSessions?: number;
  /**
   * 输出预留 token 数（M5.2 任务 H3）：下次 prompt 前为模型输出保留的
   * 空间。缺省按公式 min(maxTokens, ceil(contextWindow×25%), 32768) 从
   * resolved model 推导；显式配置时仍夹紧到 [1024, 262144] 且不超过
   * model.maxTokens。
   */
  outputReserveTokens?: number;
  /**
   * GC 周期扫描间隔（毫秒；测试注入用）。缺省 clamp(TTL/4, 1s, 60s)。
   * 定时器 unref，不阻止进程退出；除定时器外 GC 也在任务 settle 与
   * 容量闸门处机会式触发。
   */
  gcSweepIntervalMs?: number;
  /** 时钟注入（测试用受控 now；缺省 Date.now） */
  now?: () => number;
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

/**
 * 会话上下文快照（M5.2 任务 H）：当前 generation 的上下文占用视图。
 * - measured：来自上一 run provider 返回的 usage.totalTokens（最可靠）；
 * - estimated：PaperTeam CJK 感知估算（provider 未返回 usage 时）；
 * - unknown：消息面不可读且 Pi getContextUsage 不可用（runCount fallback）。
 */
interface SessionContextSnapshot {
  contextWindow: number;
  /** 当前上下文占用（estimate 或 measured 快照；null = unknown） */
  contextTokens: number | null;
  basis: "measured" | "estimated" | "unknown";
  updatedAt: string;
}

/** 进程内受管会话（一个逻辑 sessionKey 一个 Pi AgentSession） */
interface ManagedSession {
  key: string;
  session: AgentSession;
  role: PiRoleConfig;
  cwd: string;
  /** 逻辑会话创建时间（容器创建；rotation 不重置——业务 sessionKey 稳定） */
  createdAt: string;
  lastUsedAt: string;
  /** lastUsedAt 的 epoch ms（TTL/GC 判定唯一时钟事实源） */
  lastUsedAtMs: number;
  /** 本 generation 内真实执行的 run 数（rotation 时归零） */
  runCount: number;
  /**
   * 会话 generation（从 1 开始；rotation +1）。ManagedSession 容器与业务
   * sessionKey 稳定不变，只有内部 Pi AgentSession 按代替换。
   */
  generation: number;
  /** 最近一次 rotation 原因（诊断面；未回转为 undefined） */
  lastRotationReason?: string;
  /**
   * self-healing 标记（M5.2 任务 K3）：底层会话被认为不宜继续复用
   * （execution timeout / prompt 异常 / rotation 重建失败），下一个
   * 安全边界（队头任务 prompt 前）强制重建。容器在池内保持可用。
   */
  needsRotation: boolean;
  /** 待重建原因（needsRotation 的伴随记账；成功 rotation 后清空） */
  needsRotationReason?: string;
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
  /**
   * 已命中本池内会话、尚未入队的在途任务数（M5.2 任务 J1）：covering
   * obtainSession 返回 → acquireSession 入队之间的 microtask 窗口，
   * 防止 GC 在该窗口误回收「即将被使用」的会话。入队后由 queue/
   * activeTaskId 表达占用；本计数在任务 settle 时统一释放。
   */
  pendingArrivals: number;
  /** 容器级 dispose 幂等标记（GC / close / reconfigure / release 共用） */
  disposed: boolean;
  /** 当前 generation 的上下文快照（尚未执行过 run 时缺省） */
  context?: SessionContextSnapshot;
}

/** per-session 排队项：state 与「获得独占权」的 resolver */
interface SessionQueueEntry {
  state: RunState;
  resolveAcquire: (release: () => void) => void;
}

/** 排队期间被取消的任务的 acquire 释放函数（不 pump：其后的排队者由泵续派） */
const NOOP_RELEASE = (): void => {};

/**
 * 受管会话容量已满且无可淘汰的空闲会话（M5.2 任务 J3）。经 run 链 catch
 * 转为 failed(RUNTIME_SESSION_CAPACITY) 结构化终态（与 BusinessError 的
 * code 体系分离：这是 AgentTask.errorCode）。
 */
class SessionCapacityError extends AgentRunFailedError {
  constructor(detail: string) {
    super(detail);
  }
}

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
  /**
   * 全局 admission 记账（M5.2）：queued = 已受理、占用全局等待容量
   * （等待会话创建 / per-session FIFO / 全局 permit 任一）；
   * executing = 已持有全局执行 permit；undefined = 未受理（受理前结构化
   * 失败）或已释放（settle 收口，见 releaseAdmission）。
   */
  admission?: "queued" | "executing";
  /**
   * 等待全局执行 permit 的唤醒函数（注册于 acquireExecutionPermit）。
   * settle 收口统一以 false 唤醒（取消 / QUEUE_TIMEOUT / close 即时终态
   * 后后台链据此短路返回，不悬挂）；permit 授予时以 true 唤醒并清空。
   */
  permitWaitResolve?: (granted: boolean) => void;
  /** 本 run 新产生的 usage 累计（M5.2；首个 usage-bearing message_end 时创建） */
  usage?: AgentRunUsage;
  /**
   * 本任务占用的 pendingArrivals 配额所属会话（M5.2 任务 J1）：settle 时
   * 统一释放，保证 GC 的 idle 判定不漏掉「已命中会话但尚未入队」的任务。
   */
  arrivalSession?: ManagedSession;
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
  /** 全局最大同时执行数（M5.2；跨一切维度的 execution permit 上限） */
  private readonly maxConcurrentRuns: number;
  /** 全局最大等待任务数（M5.2；已受理未执行的 admission 上限） */
  private readonly maxQueuedRuns: number;
  /** 单会话 run 数回转上限（M5.2 任务 I；context usage 缺失时的 fallback） */
  private readonly maxRunsPerSession: number;
  /** 会话空闲 TTL（M5.2 任务 J） */
  private readonly sessionIdleTtlMs: number;
  /** 受管会话数硬上限（M5.2 任务 J） */
  private readonly maxSessions: number;
  /** 输出预留 token（M5.2 任务 H3；缺省按 resolved model 推导） */
  private readonly outputReserveTokens: number | undefined;
  /** GC 周期扫描间隔（测试可注入） */
  private readonly gcSweepIntervalMs: number;
  /** 时钟（测试可注入；TTL/GC/诊断统一使用） */
  private readonly now: () => number;
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
  /** 当前持有全局执行 permit 的 run 数（真实执行中；M5.2） */
  private activeExecutions = 0;
  /** 当前已受理、尚未开始执行的 run 数（全部执行前等待合计；M5.2） */
  private queuedAdmission = 0;
  /** FIFO：到达 session 队头、等待全局执行 permit 的任务（M5.2） */
  private readonly permitWaiters: RunState[] = [];
  /** 累计 session rotation 次数（M5.2 任务 I；观测面） */
  private sessionRotations = 0;
  /** 累计会话 GC 回收次数（idle_ttl + 容量 LRU 淘汰；M5.2 任务 J） */
  private sessionGcEvictions = 0;
  /** 累计 CONTEXT_BUDGET_EXCEEDED 结构化拒绝数（M5.2 任务 H5） */
  private contextBudgetRejects = 0;
  /** GC 周期扫描定时器（unref；首个会话入池时启动，close 清理） */
  private gcTimer?: ReturnType<typeof setInterval>;

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
    // M5.2 全局并发 / 受理上限：容量约束是正确性契约（不是可静默回退的
    // 调优项），非法值在构造期立即拒绝
    this.maxConcurrentRuns = options.maxConcurrentRuns ?? DEFAULT_MAX_CONCURRENT_RUNS;
    this.maxQueuedRuns = options.maxQueuedRuns ?? DEFAULT_MAX_QUEUED_RUNS;
    assertValidConcurrency(this.maxConcurrentRuns, "maxConcurrentRuns");
    if (!Number.isInteger(this.maxQueuedRuns) || this.maxQueuedRuns < 0) {
      throw new RangeError(`maxQueuedRuns 必须是 >= 0 的整数，当前为 ${this.maxQueuedRuns}`);
    }
    // M5.2 长程治理容量约束（任务 I/J/H）：同上，非法值构造期拒绝
    this.maxRunsPerSession = options.maxRunsPerSession ?? DEFAULT_MAX_RUNS_PER_SESSION;
    if (!Number.isInteger(this.maxRunsPerSession) || this.maxRunsPerSession < 1) {
      throw new RangeError(`maxRunsPerSession 必须是 >= 1 的整数，当前为 ${this.maxRunsPerSession}`);
    }
    this.sessionIdleTtlMs = options.sessionIdleTtlMs ?? DEFAULT_SESSION_IDLE_TTL_MS;
    if (!Number.isInteger(this.sessionIdleTtlMs) || this.sessionIdleTtlMs < 1) {
      throw new RangeError(`sessionIdleTtlMs 必须是 >= 1 的整数（毫秒），当前为 ${this.sessionIdleTtlMs}`);
    }
    this.maxSessions = options.maxSessions ?? DEFAULT_MAX_SESSIONS;
    if (!Number.isInteger(this.maxSessions) || this.maxSessions < 1) {
      throw new RangeError(`maxSessions 必须是 >= 1 的整数，当前为 ${this.maxSessions}`);
    }
    this.outputReserveTokens = options.outputReserveTokens;
    if (
      this.outputReserveTokens !== undefined &&
      (!Number.isInteger(this.outputReserveTokens) ||
        this.outputReserveTokens < 1_024 ||
        this.outputReserveTokens > 262_144)
    ) {
      throw new RangeError(
        `outputReserveTokens 必须是 1024-262144 的整数（token），当前为 ${this.outputReserveTokens}`,
      );
    }
    this.gcSweepIntervalMs =
      options.gcSweepIntervalMs ??
      Math.min(
        Math.max(Math.floor(this.sessionIdleTtlMs / 4), GC_SWEEP_MIN_INTERVAL_MS),
        GC_SWEEP_MAX_INTERVAL_MS,
      );
    this.now = options.now ?? (() => Date.now());
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
    for (const managed of sessions) {
      // 幂等释放（disposed 标记防 GC timer / 本路径双重 dispose）
      this.disposeManaged(managed);
    }
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

    // M5.2 oversized 单输入预算检查（任务 H5）：估算输入 + 输出预留超过
    // contextWindow 时立即结构化失败——不创建会话、不排队、不调用
    // provider、不静默截断任务内容。
    const oversized = this.checkContextBudget(message, sessionKey, input.agentId, state);
    if (oversized !== undefined) {
      this.settleTask(state, oversized);
      return this.makeHandle(state);
    }

    // M5.2 全局受理闸门：已受理未执行任务（等待会话创建 / per-session
    // FIFO / 全局 permit）达到 maxQueuedRuns 时立即结构化拒绝——不创建
    // 会话、不进任何队列、不占用 permit。RUNTIME_QUEUE_FULL（受理容量已
    // 满，立即失败）与 QUEUE_TIMEOUT（已进入等待但超过 deadline）语义
    // 互斥，绝不互相伪装。
    if (this.queuedAdmission >= this.maxQueuedRuns) {
      const capacity = `queued=${this.queuedAdmission}/${this.maxQueuedRuns} active=${this.activeExecutions}/${this.maxConcurrentRuns}`;
      this.log(`[pi-runtime] startAgent 拒绝（等待队列已满，${capacity}）：sessionKey=${sessionKey}`);
      this.settleTask(
        state,
        this.buildTask({
          taskId,
          agentId: input.agentId,
          status: "failed",
          sessionKey,
          error: `Runtime 等待队列已满（${capacity}）：请稍后重试，或调大 PAPERTEAM_PI_MAX_QUEUED_RUNS`,
          errorCode: "RUNTIME_QUEUE_FULL",
        }),
      );
      return this.makeHandle(state);
    }
    this.queuedAdmission += 1;
    state.admission = "queued";

    // 后台链：会话获取（含排队）→ session 队头 → 全局执行 permit（M5.2）
    // → 独占执行 → 终态归因。startAgent 不 await 这条链——taskId 与句柄
    // 立即对上层可见。
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
        // 到达 session 队头：等待全局执行 permit（M5.2）。同 session 的后续
        // 排队任务仍留在会话队列里，不会提前走到这里——不浪费 permit。
        // 等待属于 queue 阶段，由入队时武装的 queue deadline 覆盖（不重置）。
        const granted = await this.acquireExecutionPermit(state);
        if (!granted) {
          // 派发交接窗口内的取消（未及注册等待）：与排队取消同口径即时终态；
          // 等待期间的取消 / QUEUE_TIMEOUT / close 已由对应路径即时 settle。
          if (!state.settled) {
            this.log(`[pi-runtime] startAgent ${taskId} 在获得执行许可前被取消，直接终态`);
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
          }
          return;
        }
        if (state.settled) {
          // permit 授予与取消/超时并发的双保险（授予即从等待队列摘除，
          // 正常不可能到达；到达则 permit 已由该终态的 settle 收口释放）
          return;
        }
        state.phase = "running";
        state.runningAtMs = this.now();
        // 排队阶段（per-session FIFO + 全局 permit 等待）全部收敛：queue
        // 定时器退役，执行阶段有独立超时
        this.clearQueueTimer(state);

        // M5.2 会话生命周期安全边界（任务 I）：本任务已独占该逻辑会话队头
        // 且持有全局执行 permit，尚未 prompt——在这里做 self-healing 重建、
        // context budget preflight 与 session rotation。rotation 只替换
        // ManagedSession 内部的 Pi AgentSession（generation +1），容器、
        // FIFO 队列、sessionKey、Workspace 全部不变。oversized 输入已在
        // startAgent 受理前拦截（checkContextBudget）。
        await this.sessionPreflight(managed, message);

        if (state.cancelRequested) {
          // 派发交接窗口内的取消（含 preflight/rotation 等待期间）：不触发
          // prompt，也不误伤同会话前序 / 后续任务
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

        managed.runCount += 1;
        managed.lastUsedAt = new Date(this.now()).toISOString();
        managed.lastUsedAtMs = this.now();

        const task = await this.runOnSession(managed, { taskId, input, message, state, sessionKey });
        // 实测 usage 回写（M5.2 任务 H2）：provider 返回的 totalTokens 是
        // 「本次请求时的上下文规模」快照——它是下一 run preflight 的
        // measured 基准（优先级高于一切估算；失败/取消 run 已产生的 turn
        // 同样占用上下文，照常回写）。
        const measured = state.usage?.contextTokens;
        if (measured !== undefined && measured > 0) {
          const contextWindow = this.model?.contextWindow ?? 0;
          managed.context = {
            contextWindow,
            contextTokens: measured,
            basis: "measured",
            updatedAt: new Date(this.now()).toISOString(),
          };
        }
        this.settleTask(state, task);
      } catch (error) {
        if (error instanceof SessionCapacityError && !state.settled) {
          // RUNTIME_SESSION_CAPACITY（M5.2 任务 J3）：全部会话忙且已达硬上限
          // → 结构化 failed（resolve 通道，与 RUNTIME_QUEUE_FULL 同口径）
          this.log(`[pi-runtime] startAgent ${taskId} 被拒绝（会话容量已满）：${error.message}`);
          this.settleTask(
            state,
            this.buildTask({
              taskId,
              agentId: input.agentId,
              status: "failed",
              sessionKey,
              error: error.message,
              errorCode: "RUNTIME_SESSION_CAPACITY",
            }),
          );
          return;
        }
        this.settleFailure(state, error);
      } finally {
        release?.();
        this.inFlight.delete(taskId);
        // 机会式 GC（M5.2 任务 J）：任务 settle 后扫一遍空闲超时会话
        this.sweepIdleSessions();
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
    state.settledAtMs = this.now();
    this.clearQueueTimer(state);
    this.releaseAdmission(state);
    this.releaseArrivalToken(state);
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
    state.settledAtMs = this.now();
    this.clearQueueTimer(state);
    this.releaseAdmission(state);
    this.releaseArrivalToken(state);
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

  // ---- 全局并发与有界受理（M5.2；进程内 admission / execution guard） ----

  /**
   * 申请全局执行 permit：到达 session 队头、即将进入 session.prompt 的
   * 任务在此受限——同一时刻全 Runtime 真实执行的 run 数 <=
   * maxConcurrentRuns。FIFO 派发（先到先得，不 LIFO / 不插队）。
   * 返回 false = 等待前已被取消（派发交接窗口）或等待期间已被取消 /
   * QUEUE_TIMEOUT / close 即时终态（后台链据此短路返回，绝不悬挂）。
   */
  private async acquireExecutionPermit(state: RunState): Promise<boolean> {
    if (state.settled || state.cancelRequested) {
      return false;
    }
    return new Promise<boolean>((resolve) => {
      state.permitWaitResolve = resolve;
      this.permitWaiters.push(state);
      this.dispatchPermits();
    });
  }

  /** FIFO 派发 permit：容量可用时按等待顺序授予（记账与状态同拍更新） */
  private dispatchPermits(): void {
    while (this.activeExecutions < this.maxConcurrentRuns && this.permitWaiters.length > 0) {
      const waiter = this.permitWaiters.shift();
      if (waiter === undefined) {
        return;
      }
      if (waiter.settled) {
        // 防御：已被终态但尚未摘除的等待者（正常路径由 releaseAdmission
        // 同步摘除，其后台链已被以 false 唤醒，这里只跳过不授予）
        continue;
      }
      this.queuedAdmission -= 1;
      this.activeExecutions += 1;
      waiter.admission = "executing";
      const resolve = waiter.permitWaitResolve;
      waiter.permitWaitResolve = undefined;
      resolve?.(true);
    }
  }

  /**
   * admission / execution 记账收口：每个已受理任务恰好一次（settle 的
   * first-wins 守卫之上，admission 字段一次性清空保证幂等）。
   * - executing：归还执行 permit，并立即 FIFO 派发给下一个等待者；
   * - queued：归还等待容量，从 permit 等待队列摘除，并唤醒其后台链。
   * completed / failed / cancelled / timed_out / close 全部经此释放，
   * 任何路径都不泄漏容量。
   */
  private releaseAdmission(state: RunState): void {
    if (state.admission === "executing") {
      state.admission = undefined;
      this.activeExecutions -= 1;
      this.dispatchPermits();
      return;
    }
    if (state.admission === "queued") {
      state.admission = undefined;
      const index = this.permitWaiters.indexOf(state);
      if (index >= 0) {
        this.permitWaiters.splice(index, 1);
      }
      this.queuedAdmission -= 1;
      const resolve = state.permitWaitResolve;
      state.permitWaitResolve = undefined;
      resolve?.(false);
    }
  }

  /** 释放任务占用的会话到达配额（settle 收口；每任务至多一次） */
  private releaseArrivalToken(state: RunState): void {
    const managed = state.arrivalSession;
    if (managed !== undefined) {
      state.arrivalSession = undefined;
      managed.pendingArrivals = Math.max(0, managed.pendingArrivals - 1);
    }
  }

  // ---- 会话生命周期治理（M5.2 任务 H/I/J/K：preflight / rotation / GC / 容量） ----

  /**
   * 会话队头安全边界 preflight（M5.2）：调用方保证本任务已独占该逻辑会话
   * 且持有全局执行 permit、尚未 prompt。按序执行：
   * 1. needsRotation（self-healing）→ 重建底层 AgentSession；
   * 2. oversized 单输入检查（任务 H5）——即使全新会话也装不下时立即
   *    CONTEXT_BUDGET_EXCEEDED 结构化失败（不调用 provider、不截断）；
   * 3. context budget 压力检查（任务 H2/H3）——超限则 rotation；
   * 4. context usage 不可得/非实测时的 runCount fallback（任务 I1）。
   * 返回 "ready"（可 prompt，会话可能已换代）或 "budget_exceeded"
   * （已 settle，调用方直接返回）。
   */
  private async sessionPreflight(managed: ManagedSession, message: string): Promise<void> {
    if (managed.needsRotation) {
      await this.rotateSession(managed, managed.needsRotationReason ?? "marked_unhealthy");
    }
    // 事实源：resolved Pi Model（任务 H1；PaperTeam 不维护模型上下文表）
    const contextWindow = this.model?.contextWindow ?? 0;
    if (contextWindow > 0) {
      const maxTokens = this.model?.maxTokens ?? 0;
      const reserve = computeOutputReserve(contextWindow, maxTokens, this.outputReserveTokens);
      const nextInputEstimate = estimatePromptTokens(message);
      // oversized 已在 startAgent 受理前拦截（见 checkContextBudget），能走到
      // 这里的输入在全新会话中必然可容纳；这里只判断「当前会话是否还装得下」
      const usage = this.currentContextUsage(managed);
      if (usage !== undefined) {
        managed.context = {
          contextWindow,
          contextTokens: usage.tokens,
          basis: usage.basis,
          updatedAt: new Date(this.now()).toISOString(),
        };
        if (usage.tokens + nextInputEstimate + reserve > contextWindow) {
          await this.rotateSession(managed, "context_budget");
        }
      } else {
        // context usage unknown：runCount fallback（任务 I1）
        managed.context = {
          contextWindow,
          contextTokens: null,
          basis: "unknown",
          updatedAt: new Date(this.now()).toISOString(),
        };
        if (managed.runCount >= this.maxRunsPerSession) {
          await this.rotateSession(managed, "run_count_limit");
        }
      }
    } else {
      // 模型上下文窗口不可知（未配置 / 元数据缺失）：只做 runCount fallback
      if (managed.runCount >= this.maxRunsPerSession) {
        await this.rotateSession(managed, "run_count_limit");
      }
    }
  }

  /**
   * oversized 单输入检查（任务 H5；startAgent 受理前调用，会话尚未创建）：
   * next prompt 估算 + 输出预留本身超过 contextWindow 时，任何会话（含
   * 全新）都不可能安全执行——立即结构化失败，绝不调用 provider、绝不
   * 静默截断 Evidence / 稿件 / Review 内容。返回 undefined = 可继续受理。
   */
  private checkContextBudget(
    message: string,
    sessionKey: string,
    agentId: string,
    state: RunState,
  ): AgentTask | undefined {
    const contextWindow = this.model?.contextWindow ?? 0;
    if (contextWindow <= 0) {
      return undefined; // 模型窗口不可知：预算 guard 不生效（不伪造数字）
    }
    const reserve = computeOutputReserve(
      contextWindow,
      this.model?.maxTokens ?? 0,
      this.outputReserveTokens,
    );
    const nextInputEstimate = estimatePromptTokens(message);
    if (nextInputEstimate + reserve <= contextWindow) {
      return undefined;
    }
    this.contextBudgetRejects += 1;
    const available = Math.max(0, contextWindow - reserve);
    this.log(
      `[pi-runtime] startAgent ${state.taskId} 拒绝（单次输入超上下文预算）：` +
        `contextWindow=${contextWindow} estimatedInput=${nextInputEstimate} ` +
        `reservedOutput=${reserve} available=${available}`,
    );
    return this.buildTask({
      taskId: state.taskId,
      agentId,
      status: "failed",
      sessionKey,
      error:
        `单次任务输入超过模型上下文预算（估算）：contextWindow=${contextWindow}，` +
        `estimatedInputTokens=${nextInputEstimate}，reservedOutputTokens=${reserve}，` +
        `availableTokens=${available}。请缩小任务输入（分节 / 摘要 / 拆分）后重试`,
      errorCode: "CONTEXT_BUDGET_EXCEEDED",
    });
  }

  /**
   * 当前会话上下文占用（任务 H2）。优先级：
   * 1. 上一 run 的 provider 实测 usage.totalTokens（measured，最可靠）；
   * 2. 会话消息面的 CJK 感知估算（estimated；provider 未返回 usage 时）；
   * 3. Pi 公开 AgentSession.getContextUsage()（estimated 兜底）；
   * 4. undefined（unknown）——runCount fallback 接管。
   * unknown 绝不伪装成 0。
   */
  private currentContextUsage(
    managed: ManagedSession,
  ): { tokens: number; basis: "measured" | "estimated" } | undefined {
    const tracked = managed.context;
    if (
      tracked !== undefined &&
      tracked.basis === "measured" &&
      typeof tracked.contextTokens === "number" &&
      tracked.contextTokens >= 0
    ) {
      return { tokens: tracked.contextTokens, basis: "measured" };
    }
    const messages = readableSessionMessages(managed.session);
    if (messages !== undefined) {
      const estimated = estimateSessionContextTokens(messages);
      // 空会话估 0 是准确的（无任何对话内容），不是 unknown→0 的伪装
      return { tokens: estimated ?? 0, basis: "estimated" };
    }
    const piUsage = readContextUsage(managed.session);
    if (piUsage !== undefined && typeof piUsage.tokens === "number") {
      return { tokens: piUsage.tokens, basis: "estimated" };
    }
    return undefined;
  }

  /**
   * 会话 rotation（M5.2 任务 I2/I3/I4）：只替换 ManagedSession 内部的 Pi
   * AgentSession。调用方保证当前任务已独占该逻辑会话（activeTaskId 已置位），
   * 因此：
   * - FIFO 队列 / 排队任务完全不受影响（容器不动）；
   * - 业务 sessionKey 不变（generation 内部记账）；
   * - 旧 session 先 unsubscribe 再 dispose（此刻它必然空闲：上一 run 已
   *   settle，本 run 尚未 prompt）；
   * - runCount / context 快照随 generation 重置。
   * 重建失败：容器标记 needsRotation（下一安全边界重试重建），当前错误
   * 向上抛出由 run 链收敛为结构化失败——绝不复用已 dispose 的旧会话。
   */
  /** 标记会话需要重建（self-healing；原因随标记保存，成功 rotation 后清空） */
  private markNeedsRotation(managed: ManagedSession, reason: string): void {
    managed.needsRotation = true;
    managed.needsRotationReason = reason;
  }

  private async rotateSession(managed: ManagedSession, reason: string): Promise<void> {
    this.sessionRotations += 1;
    const previous = managed.session;
    managed.unsubscribe?.();
    managed.unsubscribe = undefined;
    try {
      previous.dispose();
    } catch {
      // dispose 不允许抛出中断 rotation
    }
    managed.generation += 1;
    managed.runCount = 0;
    try {
      const fresh = await this.createPiSessionWithTimeout(managed.role, managed.cwd);
      managed.session = fresh;
      managed.unsubscribe = this.wireSessionEvents(managed);
      const contextWindow = this.model?.contextWindow ?? 0;
      managed.context = {
        contextWindow,
        // 全新会话：无任何对话内容，0 是准确值（estimated 基准）
        contextTokens: 0,
        basis: "estimated",
        updatedAt: new Date(this.now()).toISOString(),
      };
      managed.needsRotation = false;
      managed.needsRotationReason = undefined;
      managed.lastRotationReason = reason;
      this.log(
        `[pi-runtime] 会话轮换 sessionKey=${managed.key} generation=${managed.generation} reason=${reason}`,
      );
    } catch (error) {
      // 重建失败：旧会话已销毁，容器保持待重建标记（沿用本次原因，下一安全
      // 边界重试）；本任务按 RUN_FAILED 收敛——绝不复用已 dispose 的旧会话
      managed.needsRotation = true;
      managed.needsRotationReason = reason;
      managed.lastRotationReason = `rotation_failed:${reason}`;
      this.log(
        `[pi-runtime] 会话轮换失败（已标记待重建）sessionKey=${managed.key} reason=${reason}: ${errorText(error)}`,
      );
      throw error;
    }
  }

  /** rotation 的会话重建（配置了 sessionTimeoutMs 时与之竞速，防重建悬挂） */
  private async createPiSessionWithTimeout(
    role: PiRoleConfig,
    cwd: string,
  ): Promise<AgentSession> {
    const timeoutMs = this.sessionTimeoutMs;
    if (timeoutMs === undefined) {
      return this.createPiSession(role, cwd);
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    try {
      return await Promise.race([
        this.createPiSession(role, cwd),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new AgentTimeoutError(timeoutMs, "session")), timeoutMs);
          timer.unref?.();
        }),
      ]);
    } finally {
      if (timer !== undefined) {
        clearTimeout(timer);
      }
    }
  }

  /**
   * 会话是否空闲（M5.2 任务 J1）：activeTaskId 空 + 无排队 + 无「已命中
   * 会话但尚未入队」的在途任务。三个条件缺一不可——active / queued /
   * 到达中的会话绝不被 GC。
   */
  private isSessionIdle(managed: ManagedSession): boolean {
    return (
      managed.activeTaskId === undefined &&
      managed.queue.length === 0 &&
      managed.pendingArrivals === 0
    );
  }

  /** 容器级幂等释放（GC / close / reconfigure / releaseProjectSessions 共用） */
  private disposeManaged(managed: ManagedSession): void {
    if (managed.disposed) {
      return;
    }
    managed.disposed = true;
    managed.unsubscribe?.();
    managed.unsubscribe = undefined;
    try {
      managed.session.dispose();
    } catch {
      // dispose 不允许抛出（进程退出路径）
    }
  }

  /**
   * 空闲会话 GC（M5.2 任务 J2；public 供诊断/测试显式触发）：
   * idle 超过 TTL 的会话 unsubscribe + dispose + 出池，reason=idle_ttl。
   * 绝不触碰 Workspace；active / queued / 到达中的会话天然被 idle 判定排除。
   */
  sweepIdleSessions(): number {
    if (this.closed) {
      return 0;
    }
    const nowMs = this.now();
    let evicted = 0;
    for (const managed of [...this.sessions.values()]) {
      if (!this.isSessionIdle(managed)) {
        continue;
      }
      if (nowMs - managed.lastUsedAtMs < this.sessionIdleTtlMs) {
        continue;
      }
      this.sessions.delete(managed.key);
      this.disposeManaged(managed);
      this.sessionGcEvictions += 1;
      evicted += 1;
      this.log(
        `[pi-runtime] GC 会话（idle_ttl=${this.sessionIdleTtlMs}ms）sessionKey=${managed.key} ` +
          `generation=${managed.generation} runs=${managed.runCount}`,
      );
    }
    return evicted;
  }

  /** 周期 GC 定时器（unref；首个会话入池时启动，close 清理） */
  private ensureGcTimer(): void {
    if (this.gcTimer !== undefined || this.closed) {
      return;
    }
    const timer = setInterval(() => {
      this.sweepIdleSessions();
    }, this.gcSweepIntervalMs);
    timer.unref?.();
    this.gcTimer = timer;
  }

  /** 容量闸门下最久未使用的空闲会话（LRU 淘汰候选；无候选返回 undefined） */
  private leastRecentlyUsedIdleSession(): ManagedSession | undefined {
    let candidate: ManagedSession | undefined;
    for (const managed of this.sessions.values()) {
      if (!this.isSessionIdle(managed)) {
        continue;
      }
      if (candidate === undefined || managed.lastUsedAtMs < candidate.lastUsedAtMs) {
        candidate = managed;
      }
    }
    return candidate;
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
      // self-healing（M5.2 任务 K3）：执行超时后底层会话状态不确定
      //（waitForIdle 已收敛，但流中断点后的会话复用没有上游保证），
      // 标记下一安全边界重建——只恢复 Runtime 后续可用性，不重试本任务
      this.markNeedsRotation(managed, "execution_timeout");
      throw new AgentTimeoutError(executionTimeoutMs, "execution");
    }

    if (promptError !== undefined) {
      // prompt 前置校验 / compaction 互斥等同步拒绝：结构化失败（底层细节只进日志）。
      // prompt 抛异常意味着会话状态不确定 → 标记待重建（self-healing）
      const detail = promptError instanceof Error ? promptError.message : String(promptError);
      this.log(`[pi-runtime] runAgent ${taskId} prompt 被拒绝：${detail}`);
      this.markNeedsRotation(managed, "prompt_exception");
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
      // 命中池内会话：占一个到达配额，覆盖「返回 → 入队」之间的窗口，
      // 防止 GC 在该窗口把「即将被使用」的会话回收（settle 时统一释放）
      existing.pendingArrivals += 1;
      state.arrivalSession = existing;
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
   *
   * M5.2 任务 J3 容量闸门（建槽前执行）：池内会话 + 在建槽位达到
   * maxSessions 时，先收 TTL 过期的空闲会话，再按 LRU 淘汰空闲会话；
   * 仍然满（全部忙）→ SessionCapacityError（run 链收敛为
   * failed(RUNTIME_SESSION_CAPACITY)）。绝不为腾空间取消 active run 或
   * 删除有排队任务的会话（LRU 候选仅限 idle 会话）。
   */
  private createSessionSlot(
    sessionKey: string,
    input: RunAgentInput,
    scope: string | undefined,
  ): SessionCreationSlot {
    if (this.sessions.size + this.sessionCreations.size >= this.maxSessions) {
      this.sweepIdleSessions();
      while (this.sessions.size + this.sessionCreations.size >= this.maxSessions) {
        const victim = this.leastRecentlyUsedIdleSession();
        if (victim === undefined) {
          break;
        }
        this.sessions.delete(victim.key);
        this.disposeManaged(victim);
        this.sessionGcEvictions += 1;
        this.log(
          `[pi-runtime] 会话容量淘汰（LRU idle）sessionKey=${victim.key} ` +
            `sessions=${this.sessions.size}/${this.maxSessions}`,
        );
      }
    }
    if (this.sessions.size + this.sessionCreations.size >= this.maxSessions) {
      throw new SessionCapacityError(
        `Runtime 受管会话已达上限（${this.sessions.size}/${this.maxSessions}）且全部忙：` +
          `请稍后重试，或调大 PAPERTEAM_PI_MAX_SESSIONS`,
      );
    }
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
          this.ensureGcTimer();
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
    const session = await this.createPiSession(role, cwd);
    const nowMs = this.now();
    const now = new Date(nowMs).toISOString();
    const managed: ManagedSession = {
      key: sessionKey,
      session,
      role,
      cwd,
      createdAt: now,
      lastUsedAt: now,
      lastUsedAtMs: nowMs,
      runCount: 0,
      generation: 1,
      needsRotation: false,
      queue: [],
      pendingArrivals: 0,
      disposed: false,
    };
    managed.unsubscribe = this.wireSessionEvents(managed);
    // 入池由 createSessionSlot 决定（迟到成功的会话在等待者已全部放弃时
    // 直接销毁，不入池——无幽灵会话）
    this.log(
      `[pi-runtime] 创建会话 sessionKey=${sessionKey} role=${role.role} tools=[${role.tools.join(",")}] cwd=${cwd}`,
    );
    return managed;
  }

  /**
   * 创建底层 Pi AgentSession（doCreateSession 与 rotation 共用）：角色
   * resourceLoader + in-memory SessionManager + 工具白名单。rotation 复用
   * 时传入原 ManagedSession 的 role/cwd——角色配置与工作目录随会话稳定。
   */
  private async createPiSession(role: PiRoleConfig, cwd: string): Promise<AgentSession> {
    await mkdir(cwd, { recursive: true }).catch(() => {});
    // 技能面完全自控：关闭全部默认发现（workspace/.pi、~/.pi 等），
    // 只注入 PaperTeam Skill Store 中该角色 assigned 的 skill 目录。
    const skillDirs = this.roleSkillDirs?.(role.role) ?? [];
    if (skillDirs.length > 0) {
      this.log(`[pi-runtime] 会话技能注入 role=${role.role} skills=[${skillDirs.length}]`);
    }
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
    return session;
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
        // 排队阶段超时（M5.1 分层；M5.2 起覆盖至开始执行）：到点仍未进入
        // 执行（含 per-session FIFO 等待与队头等全局 permit）→ 即时
        // timed_out(QUEUE_TIMEOUT) 终态，不等前序 run、不误伤后续排队者。
        // deadline 从入队起算，跨 FIFO → permit 等待的阶段切换不重置。
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
      // 出队后先等全局执行 permit（M5.2）：排队超时定时器保持武装——
      // permit 等待仍属 queue 阶段（同一 deadline 覆盖），直到真正进入
      // 执行（phase=running）才在后台链退役
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
   * queued 任务被取消：直接从所属会话队列或全局 permit 等待队列摘除并
   * 即时终态（M5.2 起覆盖 permit 等待者）。返回 false 表示尚未进入任何
   * 队列（会话创建中 / 正在派发交接），由后台链获得会话后的取消检查兜底。
   */
  private trySettleQueuedCancel(state: RunState): boolean {
    const managed = this.sessions.get(state.sessionKey);
    if (managed !== undefined) {
      const index = managed.queue.findIndex((entry) => entry.state === state);
      if (index >= 0) {
        const [entry] = managed.queue.splice(index, 1);
        if (entry !== undefined) {
          this.dispatchCancelAtQueue(entry);
        }
        return true;
      }
    }
    // 等待全局执行 permit 的任务：settle 收口统一完成摘除 / 记账 / 唤醒
    // 后台链（releaseAdmission），永不「复活」获得 permit
    if (this.permitWaiters.includes(state)) {
      this.log(`[pi-runtime] startAgent ${state.taskId} 等待执行许可时被取消，直接终态`);
      this.settleTask(
        state,
        this.buildTask({
          taskId: state.taskId,
          agentId: state.agentId,
          status: "cancelled",
          sessionKey: state.sessionKey,
          error: "任务已取消（开始执行前）",
        }),
      );
      return true;
    }
    return false;
  }

  /**
   * queued 任务排队超时（M5.2 起覆盖全部执行前等待）：在 per-session
   * FIFO 中 → 从队列即时摘除；已出队、等待全局执行 permit（或派发交接
   * 窗口）→ 同一 QUEUE_TIMEOUT deadline 直接 settle。settle 收口统一
   * 完成 permit 等待队列摘除 / 记账 / 唤醒后台链（releaseAdmission）。
   * 前序 run 与后续排队者完全不受影响。
   */
  private trySettleQueuedTimeout(state: RunState): boolean {
    const queueTimeoutMs = this.queueTimeoutMs;
    if (queueTimeoutMs === undefined) {
      return false;
    }
    const managed = this.sessions.get(state.sessionKey);
    if (managed !== undefined) {
      const index = managed.queue.findIndex((entry) => entry.state === state);
      if (index >= 0) {
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
    }
    // 已出会话队列：等待全局执行 permit，或处于派发交接窗口。deadline
    // 自入队起算（未因阶段切换重置）——permit 等待就是排队等待的延续。
    if (!state.settled && state.phase !== "running" && state.admission === "queued") {
      this.log(
        `[pi-runtime] startAgent ${state.taskId} 排队超时（含全局执行许可等待，${queueTimeoutMs}ms），即时终态`,
      );
      this.settleFailure(state, new AgentTimeoutError(queueTimeoutMs, "queue"));
      return true;
    }
    return false;
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
  runtimeStats(): RuntimeSessionStats {
    let busySessions = 0;
    let contextPressureSessions = 0;
    for (const managed of this.sessions.values()) {
      if (!this.isSessionIdle(managed)) {
        busySessions += 1;
      }
      const context = managed.context;
      if (
        context !== undefined &&
        typeof context.contextTokens === "number" &&
        context.contextWindow > 0 &&
        context.contextTokens / context.contextWindow >= 0.75
      ) {
        contextPressureSessions += 1;
      }
    }
    return {
      activeRuns: this.inFlight.size,
      managedSessions: this.sessions.size,
      // M5.2 全局调度状态（生效上限 + 实时计数；GET /api/runtime/status 透传）
      maxConcurrentRuns: this.maxConcurrentRuns,
      maxQueuedRuns: this.maxQueuedRuns,
      activeExecutions: this.activeExecutions,
      queuedRuns: this.queuedAdmission,
      // M5.2 长程治理（任务 J/K）：会话生命周期与预算观测面
      busySessions,
      idleSessions: this.sessions.size - busySessions,
      maxSessions: this.maxSessions,
      sessionRotations: this.sessionRotations,
      sessionGcEvictions: this.sessionGcEvictions,
      contextBudgetRejects: this.contextBudgetRejects,
      contextPressureSessions,
    };
  }

  /**
   * 逐会话诊断快照（M5.2 任务 K2；非 AgentRuntime 契约，RuntimeStatusService
   * 读取）。只暴露生命周期与预算计数，不含 prompt 内容 / 工具输出 / 密钥 /
   * 工作区路径。
   */
  sessionDiagnostics(): SessionDiagnosticEntry[] {
    const nowMs = this.now();
    return [...this.sessions.values()].map((managed) => {
      const context = managed.context;
      const contextTokens =
        context !== undefined && typeof context.contextTokens === "number"
          ? context.contextTokens
          : null;
      const contextWindow = context?.contextWindow ?? null;
      return {
        sessionKey: managed.key,
        role: managed.role.role,
        generation: managed.generation,
        runCount: managed.runCount,
        createdAt: managed.createdAt,
        lastUsedAt: managed.lastUsedAt,
        idleMs: Math.max(0, nowMs - managed.lastUsedAtMs),
        busy: !this.isSessionIdle(managed),
        queueDepth: managed.queue.length,
        contextTokens,
        contextWindow,
        contextBasis: context?.basis ?? "unknown",
        contextPercent:
          contextTokens !== null && contextWindow !== null && contextWindow > 0
            ? Math.round((contextTokens / contextWindow) * 1000) / 10
            : null,
        needsRotation: managed.needsRotation,
        ...(managed.lastRotationReason !== undefined
          ? { lastRotationReason: managed.lastRotationReason }
          : {}),
      };
    });
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
      // rotation 与 release 竞态的兜底：此刻 managed.session 可能已是新一代，
      // disposeManaged 释放的是当前 generation（幂等，不双重释放）
      this.disposeManaged(managed);
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
    // GC 定时器先行退役（unref 定时器不阻止退出，但显式清理更干净）
    if (this.gcTimer !== undefined) {
      clearInterval(this.gcTimer);
      this.gcTimer = undefined;
    }
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
    for (const managed of sessions) {
      this.disposeManaged(managed);
    }
    // 兜底：close 窗口内并发创建、晚于上方快照落位的会话一并释放（防泄漏；
    // disposeManaged 幂等，与上方快照重叠也不双重释放）
    const lateSessions = [...this.sessions.values()];
    this.sessions.clear();
    for (const managed of lateSessions) {
      this.disposeManaged(managed);
    }
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
  const messages = readableSessionMessages(session);
  if (messages === undefined) {
    return undefined;
  }
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
 * 会话消息面读取（防御性 duck-typing）：fake/最小 AgentSession 实现可能
 * 没有可读的 agent.state.messages，此时返回 undefined（调用方进入 unknown
 * 状态，绝不猜测）。
 */
function readableSessionMessages(session: AgentSession): readonly unknown[] | undefined {
  const messages: unknown = (session as { agent?: { state?: { messages?: unknown } } }).agent?.state
    ?.messages;
  return Array.isArray(messages) ? (messages as readonly unknown[]) : undefined;
}

/** Pi AgentSession.getContextUsage 的防御性 duck-typing 读取（公开 API） */
function readContextUsage(
  session: AgentSession,
): { tokens: number | null; contextWindow: number; percent: number | null } | undefined {
  const getter = (session as { getContextUsage?: () => unknown }).getContextUsage;
  if (typeof getter !== "function") {
    return undefined;
  }
  try {
    const usage = getter.call(session) as {
      tokens?: unknown;
      contextWindow?: unknown;
      percent?: unknown;
    } | undefined;
    if (
      typeof usage !== "object" ||
      usage === null ||
      typeof usage.contextWindow !== "number"
    ) {
      return undefined;
    }
    return {
      tokens: typeof usage.tokens === "number" ? usage.tokens : null,
      contextWindow: usage.contextWindow,
      percent: typeof usage.percent === "number" ? usage.percent : null,
    };
  } catch {
    return undefined;
  }
}

/** 错误消息提取（诊断日志用，不含堆栈） */
function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
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
