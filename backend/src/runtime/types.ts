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

/** 发起一次 Agent 任务（后续里程碑实现） */
export interface RunAgentInput {
  agentId: string;
  task: string;
  projectId?: string;
  inputFiles?: string[];
}

/** Agent 任务（后续里程碑实现） */
export interface AgentTask {
  taskId: string;
  agentId: string;
  status: AgentTaskStatus;
  createdAt: string;
  updatedAt: string;
  output?: string;
  error?: string;
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
}

/** M1 范围外的方法被调用时抛出，避免留下静默的假实现 */
export class RuntimeCapabilityError extends Error {
  override readonly name = "RuntimeCapabilityError";

  constructor(method: keyof AgentRuntime, provider: RuntimeProvider) {
    super(
      `AgentRuntime.${method}() 尚未实现（当前里程碑 M1 只提供 healthCheck，provider: ${provider}）`,
    );
  }
}
