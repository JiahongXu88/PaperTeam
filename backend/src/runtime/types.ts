/**
 * AgentRuntime 统一契约（对应 docs/ARCHITECTURE.md §2.1 与 PRD §12）。
 *
 * 业务层只依赖本文件中的类型与接口，不允许 import OpenClaw 相关实现。
 * M1 仅实现 healthCheck()；其余方法只固定契约，待后续里程碑实现。
 */

/** Agent Runtime 提供方标识 */
export type RuntimeProvider = "openclaw";

/** 任务状态（PRD §12.3 统一口径） */
export type AgentTaskStatus = "queued" | "running" | "completed" | "failed" | "cancelled";

/**
 * Runtime 健康状态：
 * - healthy     可连接且探针正常
 * - unreachable 不可连接（DNS 失败 / connection refused 等网络层错误）
 * - timeout     请求超时
 * - unhealthy   可连接但响应异常（非预期状态码 / 响应体）
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
  /** 人类可读的说明（成功摘要 / 失败原因），不含堆栈 */
  detail: string;
  /** 本次探测耗时（毫秒）；未能发出请求时为 null */
  latencyMs: number | null;
  /** 检查完成时间（ISO 8601） */
  checkedAt: string;
}

/** 发起一次 Agent 任务（M2 起由 OpenClawRuntimeAdapter 真实执行） */
export interface RunAgentInput {
  agentId: string;
  task: string;
  projectId?: string;
  /**
   * 复用的 Runtime 会话标识（M2.1）。
   * 来自上次任务结果 metadata.sessionKey 的原样透传；缺省时由 Adapter
   * 按 projectId 派生稳定会话（保证同一 Project 复用、不同 Project 隔离）。
   */
  sessionKey?: string;
  inputFiles?: string[];
  /** 本次任务的整体超时（毫秒）；缺省使用 Runtime 配置的默认值 */
  timeoutMs?: number;
  /** 附加到任务的业务侧标记（透传给 Adapter 诊断日志，不参与 Runtime 协议） */
  metadata?: Record<string, unknown>;
}

/**
 * Agent 任务（M2：同步完成语义 —— runAgent() 返回时任务已达终态）。
 * OpenClaw 特有标识保存在 metadata 诊断字段中：
 *   - runId      本次运行的 Gateway run 标识（即 taskId）
 *   - sessionKey 运行落到的 Runtime 会话（跨任务复用，见 RunAgentInput.sessionKey）
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

/** Agent 事件流事件（后续里程碑实现） */
export interface AgentEvent {
  taskId: string;
  type: string;
  data?: Record<string, unknown>;
  ts: string;
}

/**
 * PaperTeam 业务层与底层 Agent 系统之间的唯一边界。
 * 第一版实现见 OpenClawRuntimeAdapter；未来更换 Runtime 不影响上层。
 */
export interface AgentRuntime {
  readonly provider: RuntimeProvider;

  runAgent(input: RunAgentInput): Promise<AgentTask>;
  getTask(taskId: string): Promise<AgentTask>;
  cancelTask(taskId: string): Promise<void>;
  sendMessage(sessionId: string, message: string): Promise<void>;
  streamEvents(taskId: string, onEvent: (event: AgentEvent) => void): Promise<void>;

  healthCheck(): Promise<RuntimeHealth>;

  /**
   * 释放 Runtime 持有的资源（M2.1：进程 shutdown 时调用）。
   * 实现应停止在途连接并保证进程可退出；未实现时视为无资源需释放。
   */
  close?(): Promise<void>;
}

/** M2 范围外的方法被调用时抛出，避免留下静默的假实现 */
export class RuntimeCapabilityError extends Error {
  override readonly name = "RuntimeCapabilityError";

  constructor(method: keyof AgentRuntime, provider: RuntimeProvider) {
    super(
      `AgentRuntime.${method}() 尚未实现（当前里程碑 M2 提供 healthCheck 与 runAgent，provider: ${provider}）`,
    );
  }
}
