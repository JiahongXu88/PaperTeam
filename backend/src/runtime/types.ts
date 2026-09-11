/**
 * AgentRuntime 统一契约 v2（对应 docs/ARCHITECTURE.md §2.1 与 PRD §12）。
 *
 * 业务层只依赖本文件中的类型与接口，不允许 import Pi SDK 相关实现。
 *
 * v1 → v2 的核心变化：
 *   v1 runAgent 阻塞到任务终态才返回 AgentTask，调用方在运行期间拿不到
 *   taskId，导致 cancelTask / streamEvents 对上层天然不可达。
 *
 *   v2 startAgent(input) 立即返回 AgentRunHandle：
 *     - taskId 在执行开始时即可获得
 *     - events 可在运行期间消费（replay + live，settle 后自然结束）
 *     - cancel 可在运行期间调用（幂等）
 *     - result 单独 await 终态（Promise 缓存，可重复 await）
 *
 *   runAgent(input) 保留为 convenience helper（= startAgent + await result），
 *   供既有同步语义业务路径（Writer/Reviewer/Researcher 等）零改动使用；
 *   它不再是唯一入口。
 */

/**
 * Agent Runtime 提供方标识。
 * - pi：@earendil-works/pi-coding-agent 的 in-process SDK Runtime
 *   （唯一正式 Runtime；OpenClaw 为历史基线）
 */
export type RuntimeProvider = "pi";

/**
 * 任务状态（PRD §12.3 统一口径）。
 * M5.1 起 timed_out 从「Promise reject + 状态丢失」升级为独立终态：
 * 超时任务同样可经 getTask / handle.result 查询结构化终态。
 */
export type AgentTaskStatus =
  | "queued"
  | "running"
  | "completed"
  | "failed"
  | "cancelled"
  | "timed_out";

/**
 * 超时归属阶段（M5.1 timeout 分层）。timed_out 任务的 timeoutPhase 必填，
 * 对应真实生命周期阶段（不人为制造不存在的阶段）：
 * - init      Runtime 懒初始化（ensureInitialized）超时
 * - session   会话获取/创建（getOrCreateSession）超时
 * - queue     等待同会话独占权（per-session FIFO）超时
 * - execution 进入 session.prompt 后的执行超时
 */
export type AgentTimeoutPhase = "init" | "session" | "queue" | "execution";

/**
 * Runtime 健康状态（Runtime 健康 ≠ 模型就绪，见 healthCheck）：
 * - healthy     Runtime 初始化正常、可接受任务
 * - unreachable 依赖组件不可加载（SDK 加载失败等）
 * - timeout     初始化超时
 * - unhealthy   可加载但状态异常（初始化失败 / 已关闭）
 * - unknown     尚未检查，或检查过程本身出现未分类错误
 */
export type RuntimeHealthStatus =
  | "healthy"
  | "unreachable"
  | "timeout"
  | "unhealthy"
  | "unknown";

/** 健康检查结果（结构化，面向业务层，不携带底层堆栈） */
export interface RuntimeHealth {
  ok: boolean;
  provider: RuntimeProvider;
  status: RuntimeHealthStatus;
  /** 人类可读的说明（成功摘要 / 失败原因），不含堆栈与密钥 */
  detail: string;
  /** 本次探测耗时（毫秒）；未能执行时为 null */
  latencyMs: number | null;
  /** 检查完成时间（ISO 8601） */
  checkedAt: string;
}

/** 发起一次 Agent 任务（由 PiRuntimeAdapter 真实执行） */
export interface RunAgentInput {
  agentId: string;
  task: string;
  projectId?: string;
  /**
   * 复用的 Runtime 会话标识。
   * 来自上次任务结果 metadata.sessionKey 的原样透传；缺省时由 Adapter
   * 按 projectId 派生稳定会话（保证同一 Project 复用、不同 Project 隔离）。
   */
  sessionKey?: string;
  /**
   * 上下文作用域（ARCHITECTURE §6.3）。
   * 会话维度为 projectId × agentId × contextScope：同一 Agent 的不同
   * scope（如 Reviewer 的 fact / academic / style）持有独立会话，互不污染。
   * 取值为简短的业务 scope 字符串（如 "research" / "writing" / "review/fact"），
   * 非法字符会被安全归一化。
   */
  contextScope?: string;
  inputFiles?: string[];
  /**
   * 执行阶段超时（毫秒）——任务进入 session.prompt 之后才计时（M5.1
   * timeout 分层）；排队等待不计入。缺省使用 Runtime 配置的执行阶段默认值
   * （兼容历史 runTimeoutMs 语义）。
   */
  timeoutMs?: number;
  /**
   * 协作式取消信号（如 Workflow stage 的 ctx.signal）。由 startAgent 统一
   * 消费（M5.1 起与 handle.cancel 同一条取消链路；runAgent 只是
   * startAgent + await result，不含第二套 signal 实现）：触发后 Runtime
   * 中断在途生成 / 工具执行并以 cancelled 终态收尾，而不是等到 timeoutMs
   * 才释放；pre-aborted 信号同样生效（任务直接进入取消语义）。运行期间
   * 恰好挂一个监听器，任务 settle 后即移除。
   */
  signal?: AbortSignal;
  /** 附加到任务的业务侧标记（透传给 Adapter 诊断日志，不参与 Runtime 协议） */
  metadata?: Record<string, unknown>;
}

/**
 * Agent 任务终态（runAgent/handle.result resolve 时任务已达终态）。
 * 诊断标识保存在 metadata 字段中：
 *   - sessionKey 运行落到的 Runtime 会话（跨任务复用，见 RunAgentInput.sessionKey）
 *   - model     实际使用的模型标签（provider/model-id）
 *   - role      Pi 角色映射键（researcher/writer/reviewer/default）
 * 业务层不得依赖 metadata 的具体结构。
 *
 * M5.1 结构化终态：无论 result Promise resolve 还是 reject，Runtime 都在
 * taskRecords 留下可查询的完整终态（getTask 对 timed_out / failed 同样
 * 可查）。计时字段（queuedAt / queueDurationMs / executionDurationMs /
 * totalDurationMs）由 Runtime 在 settle 时一次性写入，保证非负；未到达的
 * 阶段不携带对应字段（如排队即超时的任务没有 executionDurationMs）。
 */
export interface AgentTask {
  taskId: string;
  agentId: string;
  status: AgentTaskStatus;
  createdAt: string;
  updatedAt: string;
  /** 任务实际执行的开始/结束时间（ISO 8601）；未进入执行的终态（排队取消/
   *  排队超时/会话阶段超时）不携带 startedAt。completedAt 恒为 settle 时间。 */
  startedAt?: string;
  completedAt?: string;
  /** 任务进入 per-session 队列的时刻（会话已就绪、等待独占；ISO 8601） */
  queuedAt?: string;
  /**
   * 结构化错误码（failed / timed_out 终态携带；completed/cancelled 不携带）。
   * timed_out：INIT_TIMEOUT / SESSION_TIMEOUT / QUEUE_TIMEOUT / EXECUTION_TIMEOUT。
   */
  errorCode?: string;
  /** 超时归属阶段（仅 timed_out 终态携带，见 AgentTimeoutPhase） */
  timeoutPhase?: AgentTimeoutPhase;
  /** 排队等待时长（毫秒；进入过队列的任务携带） */
  queueDurationMs?: number;
  /** 执行时长（毫秒；进入过 session.prompt 的任务携带） */
  executionDurationMs?: number;
  /** 任务总时长（毫秒；从 startAgent 受理到 settle） */
  totalDurationMs?: number;
  output?: string;
  error?: string;
  /**
   * 本次 run 新产生的 assistant turn usage 汇总（M5.2 基础采集）。
   * 只统计本 run 期间 message_end 送达的 assistant 消息（会话复用不重复
   * 计算历史 turn）；provider 未返回 usage 时整个字段缺省，不伪造 0 成本。
   */
  usage?: AgentRunUsage;
  /** 诊断元数据（内容由 Runtime 实现决定，仅用于排障） */
  metadata?: Record<string, unknown>;
}

/**
 * Run 级 token / cost 用量（来自 Pi AssistantMessage.usage 的原生语义）。
 *
 * 语义口径（pi-ai Usage，0.84.4）：
 * - input/output/cacheRead/cacheWrite 为「本条 assistant 消息（本次 LLM
 *   请求）」的增量，跨 turn 累加即为 run 总量；
 * - totalTokens 是「本次请求时的上下文规模」快照（近似等于该 turn 各项
 *   之和），跨 turn 累加没有意义——contextTokens 只保留最后一个有效值；
 * - cost 是 Pi/provider 按 list-price 的估算（estimatedCost），不一定等于
 *   用户 Coding Plan / 企业账号的实际付款；provider 未返回时缺省。
 */
export interface AgentRunUsage {
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  /** 上下文规模快照（最后一个 assistant turn 的 totalTokens；不跨 turn 累加） */
  contextTokens: number;
  /** Pi/provider 返回的 list-price 成本估算（未返回时缺省，不自行计算） */
  estimatedCost?: number;
  /** 已累计 usage 的 assistant turn 数（0 值 usage 也计入） */
  assistantTurns: number;
}

/**
 * Agent 事件流事件（Runtime 实现 → 业务层的稳定映射；底层 Runtime 的
 * 原始事件对象不得透传到业务层）。
 *
 * seq / event_gap 语义（M5.1）：
 * - 每个真实事件携带任务内单调递增的可选 seq（从 1 开始）；
 * - Runtime 的事件缓冲有界（保尾部）；当消费者需要的事件已被淘汰
 *   （落后太多或订阅晚于截断）时，以 type="event_gap" 的合成事件
 *   显式报告被淘汰区间（data: { missedFrom, missedTo, missedCount }），
 *   绝不静默跳过。gap 标记本身不携带 seq。
 */
export interface AgentEvent {
  taskId: string;
  type: string;
  data?: Record<string, unknown>;
  ts: string;
  /** 任务内单调递增序号（从 1 开始；Runtime 赋值，可选） */
  seq?: number;
}

/**
 * 一次 Agent 运行的句柄（AgentRuntime Contract v2 核心）。
 *
 * 生命周期：startAgent 返回 handle 时任务已在后台启动（或已结构化失败）；
 * events 在 settle 后自然结束；cancel 幂等；result 缓存终态。
 */
export interface AgentRunHandle {
  /** 任务标识（startAgent 返回时即已生成，不等任务结束） */
  readonly taskId: string;
  /** 运行落到的 Runtime 会话（与 AgentTask.metadata.sessionKey 一致） */
  readonly sessionKey: string;

  /**
   * 任务事件流：先 replay 已缓存事件，再 live 消费新事件；
   * 任务 settle 且事件排空后迭代自然结束（不抛错）。
   * 多次调用返回独立迭代器（各自 replay）。消费方提前 break 会清理
   * 订阅，不造成泄漏。
   *
   * 事件缓冲有界（保尾部）：真实事件带单调递增 seq；消费者落后于淘汰
   * 窗口或订阅晚于截断时，先收到 type="event_gap" 合成事件（报告被淘汰
   * 区间），再从当前缓冲头继续——缺口绝不静默（见 AgentEvent）。
   */
  events(): AsyncIterable<AgentEvent>;

  /**
   * 请求取消：协作式中断当前生成 / 工具执行。
   * - 幂等：重复调用、对已终态任务调用均为 no-op
   * - 等待 run 完全收敛后返回
   */
  cancel(): Promise<void>;

  /**
   * 任务终态：正常/结构化失败 resolve AgentTask；超时、Runtime 异常等
   * 以业务错误 reject（与 v1 runAgent 抛错口径一致）。Promise 缓存，
   * 可重复 await。reject 不丢失状态：timed_out / failed 的结构化终态
   * 同样写入 Runtime 任务记录，可经 getTask 查询（M5.1）。
   */
  result(): Promise<AgentTask>;
}

/**
 * PaperTeam 业务层与底层 Agent 系统之间的唯一边界。
 * 当前实现：PiRuntimeAdapter；更换 Runtime 不影响上层。
 */
export interface AgentRuntime {
  readonly provider: RuntimeProvider;

  /** 发起任务并立即返回句柄（v2 主入口） */
  startAgent(input: RunAgentInput): Promise<AgentRunHandle>;

  /**
   * 同步终态 convenience（= startAgent + await result）。
   * 供既有同步语义业务路径使用，不应成为新代码的唯一入口。
   */
  runAgent(input: RunAgentInput): Promise<AgentTask>;

  /**
   * 查询已完结任务（超出回溯窗口或不存在时报错；运行中任务经 handle 查询）。
   * M5.1 起 reject 路径（timed_out / runtime 异常）也留有结构化终态记录。
   */
  getTask(taskId: string): Promise<AgentTask>;

  healthCheck(): Promise<RuntimeHealth>;

  /**
   * 释放某项目持有的全部会话（项目永久删除时的最小清理 seam；可选）。
   * 实现按 sessionKey 派生规则（projectId × agentId × contextScope）精确定位；
   * 调用方负责先确认没有应保留的运行中任务。
   */
  releaseProjectSessions?(projectId: string): Promise<number>;

  /**
   * 释放 Runtime 持有的资源：取消/收敛所有 active run、释放全部会话
   * （幂等；进程 shutdown 时调用），保证进程可退出。
   */
  close(): Promise<void>;

  // ---- 诊断面（可选；GET /api/runtime/status 消费，缺省视为 unknown / 0） ----

  /** 模型就绪摘要（Runtime 健康 ≠ 模型就绪） */
  modelStatusSnapshot?(): Promise<RuntimeModelStatus>;
  /** 已解析生效的模型标签 "provider/model-id"（未配置时 undefined） */
  readonly resolvedModel?: string;
  /** 在途 run 与受管会话数量（进程内诊断） */
  runtimeStats?(): RuntimeSessionStats;
}

export interface RuntimeModelStatus {
  phase: "configured" | "not_configured" | "unknown";
  /** 已配置凭据的 provider 名单（不含任何 key） */
  providers: string[];
  detail: string;
}

export interface RuntimeSessionStats {
  activeRuns: number;
  managedSessions: number;
  /**
   * 全局并发上限（M5.2 admission / execution guard；实现未暴露时缺省，
   * 视为不限）。四个字段刻画 Runtime 进程内的全局调度状态：
   * 同时真实进入 session.prompt 的 run 数 <= maxConcurrentRuns；
   * 已受理未执行（等待会话创建 / per-session FIFO / 全局 permit）的
   * run 数 <= maxQueuedRuns，占满后新任务立即 RUNTIME_QUEUE_FULL。
   */
  maxConcurrentRuns?: number;
  /** 全局等待队列容量上限（M5.2；与 maxConcurrentRuns 成对） */
  maxQueuedRuns?: number;
  /** 当前持有全局执行 permit 的 run 数（真实执行中） */
  activeExecutions?: number;
  /** 当前已受理、尚未开始执行的 run 数（全部执行前等待合计） */
  queuedRuns?: number;
}
