/**
 * AgentRuntime 统一契约 v2（M3.8，对应 docs/ARCHITECTURE.md §2.1 与 PRD §12）。
 *
 * 业务层只依赖本文件中的类型与接口，不允许 import Pi SDK 相关实现。
 *
 * v1 → v2 的核心变化（动机见 M3.7 报告 §7）：
 *   v1 runAgent() 阻塞到任务终态才返回 AgentTask，调用方在运行期间拿不到
 *   taskId，导致 cancelTask / streamEvents 对上层天然不可达。
 *
 *   v2 startAgent(input) 立即返回 AgentRunHandle：
 *     - taskId 在执行开始时即可获得
 *     - events() 可在运行期间消费（replay + live，settle 后自然结束）
 *     - cancel() 可在运行期间调用（幂等）
 *     - result() 单独 await 终态（Promise 缓存，可重复 await）
 *
 *   runAgent(input) 保留为 convenience helper（= startAgent + await result），
 *   供既有同步语义业务路径（Writer/Reviewer/Researcher 等）零改动使用；
 *   它不再是唯一入口。
 */

/**
 * Agent Runtime 提供方标识。
 * - pi：@earendil-works/pi-coding-agent 的 in-process SDK Runtime
 *   （M3.8 起为唯一正式 Runtime baseline；OpenClaw 为 M3.6 历史基线）
 */
export type RuntimeProvider = "pi";

/** 任务状态（PRD §12.3 统一口径） */
export type AgentTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

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

/** 发起一次 Agent 任务（M3.8 起由 PiRuntimeAdapter 真实执行） */
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
  /** 本次任务的整体超时（毫秒）；缺省使用 Runtime 配置的默认值 */
  timeoutMs?: number;
  /** 附加到任务的业务侧标记（透传给 Adapter 诊断日志，不参与 Runtime 协议） */
  metadata?: Record<string, unknown>;
}

/**
 * Agent 任务终态（runAgent()/handle.result() resolve 时任务已达终态）。
 * 诊断标识保存在 metadata 字段中：
 *   - sessionKey 运行落到的 Runtime 会话（跨任务复用，见 RunAgentInput.sessionKey）
 *   - model     实际使用的模型标签（provider/model-id）
 *   - role      Pi 角色映射键（researcher/writer/reviewer/default）
 * 业务层不得依赖 metadata 的具体结构。
 */
export interface AgentTask {
  taskId: string;
  agentId: string;
  status: AgentTaskStatus;
  createdAt: string;
  updatedAt: string;
  /** 任务实际执行的开始/结束时间（ISO 8601） */
  startedAt?: string;
  completedAt?: string;
  output?: string;
  error?: string;
  /** 诊断元数据（内容由 Runtime 实现决定，仅用于排障） */
  metadata?: Record<string, unknown>;
}

/**
 * Agent 事件流事件（Runtime 实现 → 业务层的稳定映射；底层 Runtime 的
 * 原始事件对象不得透传到业务层）。
 */
export interface AgentEvent {
  taskId: string;
  type: string;
  data?: Record<string, unknown>;
  ts: string;
}

/**
 * 一次 Agent 运行的句柄（AgentRuntime Contract v2 核心）。
 *
 * 生命周期：startAgent() 返回 handle 时任务已在后台启动（或已结构化失败）；
 * events() 在 settle 后自然结束；cancel() 幂等；result() 缓存终态。
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
   * 可重复 await。
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

  /** 查询已完结任务（超出回溯窗口或不存在时报错；运行中任务经 handle 查询） */
  getTask(taskId: string): Promise<AgentTask>;

  healthCheck(): Promise<RuntimeHealth>;

  /**
   * 释放 Runtime 持有的资源：取消/收敛所有 active run、释放全部会话
   * （幂等；进程 shutdown 时调用），保证进程可退出。
   */
  close(): Promise<void>;
}
