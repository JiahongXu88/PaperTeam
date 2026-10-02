/**
 * M10.4.0 Agent Runtime Trace —— 轻量进程内 tracing（零第三方依赖）。
 *
 * 设计目标：为真实论文 workflow 建立 latency / token 可观测能力，找出性能
 * 瓶颈；只观测，不改变任何业务行为（不动 Fact Gate / Quality Gate / Revision）。
 *
 * OTel 兼容性：span 形状与 OpenTelemetry JSON span 一一对应
 *   traceId / spanId / parentSpanId / name / kind / startTime / endTime /
 *   status / attributes / events —— 后续接 OTLP exporter 时按字段映射即可，
 * 当前以 JSON trace（run-trace.json）落盘为交付形态。
 *
 * 采集面（三类 span + 一层 ALS 归属）：
 * - stage span（WorkflowOrchestrator）：workflow stage 尝试的真实耗时
 * - agent.task span（PiRuntimeAdapter）：一次 AgentRuntime 任务的执行段
 * - model.turn span：一次 LLM 请求（assistant message_start→message_end）
 * - tool.call span：一次工具执行（tool_execution_start→end，按 toolCallId 配对）
 *
 * 归属机制：orchestrator 在 stage 执行期间进入 AsyncLocalStorage trace scope；
 * PiRuntimeAdapter 在 startAgent 入口（首个 await 前）捕获该 scope，后续后台链
 * 与事件转发一律用捕获值——事件触发点不依赖动态 async 上下文（Pi 会话的
 * 持久 listener 可能落在会话创建时的上下文）。
 */

import { randomBytes } from "node:crypto";
import { AsyncLocalStorage } from "node:async_hooks";

/** OTel 兼容属性值类型 */
export type TraceAttributeValue = string | number | boolean;

/** OTel 兼容 span event */
export interface TraceSpanEvent {
  name: string;
  /** epoch ms（导出 OTLP 时换算纳米） */
  timeMs: number;
  attributes?: Record<string, TraceAttributeValue>;
}

export interface TraceSpan {
  traceId: string;
  spanId: string;
  parentSpanId: string | null;
  name: string;
  /** OTel span kind（stage/task/tool=internal；模型请求=client） */
  kind: "internal" | "client" | "server";
  /** epoch ms */
  startMs: number;
  endMs: number;
  durationMs: number;
  status: "ok" | "error" | "unset";
  statusMessage?: string;
  attributes: Record<string, TraceAttributeValue>;
  events?: TraceSpanEvent[];
}

/** 一个 WorkflowRun 的 trace 全量快照（run-trace.json 内容） */
export interface RunTraceDocument {
  schemaVersion: 1;
  /** OTel 兼容声明：spans[] 字段与 OTLP JSON span 对应（startMs/endMs 为毫秒扩展） */
  format: "paperteam-run-trace";
  traceId: string;
  projectId: string;
  workflowKind: string;
  createdAtMs: number;
  updatedAtMs: number;
  finishedAtMs?: number;
  runStatus?: string;
  spans: TraceSpan[];
  /** 超出单 run span 上限后被丢弃的 span 数（如实计数，不静默） */
  droppedSpans: number;
}

/** 单 run span 上限（内存护栏；一次 60min 真实 run 实测 << 该值） */
const MAX_SPANS_PER_RUN = 50_000;

/** 进程内保留的 run trace 会话数上限（超出淘汰最旧，防止长期驻留泄漏） */
const MAX_TRACE_SESSIONS = 8;

function newSpanId(): string {
  return randomBytes(8).toString("hex");
}

// ---------------------------------------------------------------------------
// RunTraceSession
// ---------------------------------------------------------------------------

export interface StageSpanHandle {
  readonly spanId: string;
  end(result: {
    status: "ok" | "error";
    statusMessage?: string;
    attributes?: Record<string, TraceAttributeValue>;
    /** 收口时钟（orchestrator 注入时钟；缺省按 span 开始时间 + 1ms 兜底） */
    endMs: number;
  }): void;
}

/** 一个 WorkflowRun 的进程内 trace 会话（orchestrator 创建 / 写盘，adapter 写入） */
export class RunTraceSession {
  readonly traceId: string;
  readonly projectId: string;
  readonly workflowKind: string;
  private readonly createdAtMs: number;
  private updatedAtMs: number;
  private finishedAtMs: number | undefined;
  private runStatus: string | undefined;
  private readonly spanList: TraceSpan[] = [];
  private droppedSpans = 0;

  constructor(params: { projectId: string; runId: string; workflowKind: string; nowMs: number }) {
    this.traceId = params.runId;
    this.projectId = params.projectId;
    this.workflowKind = params.workflowKind;
    this.createdAtMs = params.nowMs;
    this.updatedAtMs = params.nowMs;
  }

  /** 追加一个已完成 span（超上限丢弃并计数；trace 是观测面，绝不反向影响业务） */
  addSpan(span: TraceSpan): void {
    if (this.spanList.length >= MAX_SPANS_PER_RUN) {
      this.droppedSpans += 1;
      return;
    }
    this.spanList.push(span);
    this.updatedAtMs = Math.max(this.updatedAtMs, span.endMs);
  }

  /** stage 尝试 span（execute 或 hitl-payload 阶段）；返回句柄在终态时 end() */
  startStageSpan(params: {
    stageId: string;
    attempt: number;
    phase: "execute" | "hitl-payload";
    startMs: number;
    attributes?: Record<string, TraceAttributeValue>;
  }): StageSpanHandle {
    const spanId = newSpanId();
    const open: TraceSpan = {
      traceId: this.traceId,
      spanId,
      parentSpanId: null,
      name: params.phase === "execute" ? `stage:${params.stageId}` : `hitl-payload:${params.stageId}`,
      kind: "internal",
      startMs: params.startMs,
      endMs: params.startMs,
      durationMs: 0,
      status: "unset",
      attributes: {
        "stage.id": params.stageId,
        "stage.attempt": params.attempt,
        "stage.phase": params.phase,
        ...(params.attributes ?? {}),
      },
    };
    let ended = false;
    return {
      spanId,
      end: (result) => {
        if (ended) {
          return;
        }
        ended = true;
        open.endMs = Math.max(open.startMs, result.endMs);
        open.durationMs = open.endMs - open.startMs;
        open.status = result.status;
        if (result.statusMessage !== undefined) {
          open.statusMessage = truncate(result.statusMessage, 300);
        }
        Object.assign(open.attributes, result.attributes ?? {});
        this.addSpan(open);
      },
    };
  }

  finish(status: string, nowMs: number): void {
    this.runStatus = status;
    this.finishedAtMs = nowMs;
    this.updatedAtMs = Math.max(this.updatedAtMs, nowMs);
  }

  snapshot(): RunTraceDocument {
    return {
      schemaVersion: 1,
      format: "paperteam-run-trace",
      traceId: this.traceId,
      projectId: this.projectId,
      workflowKind: this.workflowKind,
      createdAtMs: this.createdAtMs,
      updatedAtMs: Math.max(this.updatedAtMs, ...this.spanList.map((span) => span.endMs)),
      ...(this.finishedAtMs !== undefined ? { finishedAtMs: this.finishedAtMs } : {}),
      ...(this.runStatus !== undefined ? { runStatus: this.runStatus } : {}),
      spans: structuredClone(this.spanList),
      droppedSpans: this.droppedSpans,
    };
  }

  /** 测试 / 诊断只读访问 */
  get spanCount(): number {
    return this.spanList.length;
  }
}

// ---------------------------------------------------------------------------
// 会话注册表（进程级；backend 与 adapter 同进程）
// ---------------------------------------------------------------------------

const sessions = new Map<string, RunTraceSession>();

function sessionKey(projectId: string, runId: string): string {
  return `${projectId}/${runId}`;
}

export function getOrCreateRunTraceSession(params: {
  projectId: string;
  runId: string;
  workflowKind: string;
  nowMs: number;
}): RunTraceSession {
  const key = sessionKey(params.projectId, params.runId);
  const existing = sessions.get(key);
  if (existing !== undefined) {
    return existing;
  }
  const session = new RunTraceSession(params);
  sessions.set(key, session);
  // 超出保留上限：淘汰最旧的会话（插入序 = 创建序；活跃 run 通常最新）
  while (sessions.size > MAX_TRACE_SESSIONS) {
    const oldest = sessions.keys().next().value;
    if (oldest === undefined || oldest === key) {
      break;
    }
    sessions.delete(oldest);
  }
  return session;
}

export function findRunTraceSession(projectId: string, runId: string): RunTraceSession | undefined {
  return sessions.get(sessionKey(projectId, runId));
}

export function finishRunTraceSession(projectId: string, runId: string, status: string, nowMs: number): void {
  sessions.get(sessionKey(projectId, runId))?.finish(status, nowMs);
}

/** 测试隔离：清空进程级注册表 */
export function resetTraceSessionsForTest(): void {
  sessions.clear();
}

// ---------------------------------------------------------------------------
// AsyncLocalStorage scope（orchestrator → adapter 的 stage 归属）
// ---------------------------------------------------------------------------

export interface TraceScope {
  projectId: string;
  runId: string;
  stageId: string;
  attempt: number;
  /** 当前 stage 尝试的 spanId（model/tool/task span 的 parent） */
  stageSpanId: string | null;
}

const scopeStorage = new AsyncLocalStorage<TraceScope>();

export function currentTraceScope(): TraceScope | undefined {
  return scopeStorage.getStore();
}

export async function runInTraceScope<T>(scope: TraceScope, fn: () => Promise<T>): Promise<T> {
  return scopeStorage.run(scope, fn);
}

// ---------------------------------------------------------------------------
// TaskTraceRecorder（PiRuntimeAdapter 侧：任务 / 模型请求 / 工具 / 重试）
// ---------------------------------------------------------------------------

/** Pi 事件的防御性读取形状（与 accumulateRunUsage 同口径，不依赖 pi 类型） */
interface ObservedEvent {
  type: string;
  message?: { role?: unknown; usage?: unknown; stopReason?: unknown };
  toolCallId?: unknown;
  toolName?: unknown;
  isError?: unknown;
  willRetry?: unknown;
  attempt?: unknown;
  success?: unknown;
  reason?: unknown;
  errorMessage?: unknown;
}

/** taskSettled 接受的终态最小面（AgentTask 结构子集） */
export interface TaskSettleInfo {
  status: string;
  errorCode?: string;
  error?: string;
  queueDurationMs?: number;
  executionDurationMs?: number;
  totalDurationMs?: number;
  /**
   * M10.4.4：prompt 开始 → 首条 provider 活动的时长（毫秒）。未观测到
   * provider 活动即终态（含 first-activity 超时）时缺省——不伪造。
   */
  firstActivityMs?: number;
  usage?: {
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    estimatedCost?: number;
    assistantTurns: number;
  };
}

interface OpenSpan {
  span: TraceSpan;
}

/**
 * 单个 AgentRuntime 任务的 trace 记录器。
 * 生命周期：executionStarted（prompt 前）→ observeEvent×N → taskSettled（终态）。
 * settle 时收敛一切未闭合 span（abort / retry 中断的流记为 unset，不伪造）。
 */
export class TaskTraceRecorder {
  private readonly scope: TraceScope;
  private readonly session: RunTraceSession;
  private readonly base: { taskId: string; agentId: string; modelLabel: string; role: string };
  private readonly nowMs: () => number;
  private taskSpan: TraceSpan | undefined;
  private openModelSpan: OpenSpan | undefined;
  private readonly openToolSpans = new Map<string, TraceSpan>();
  private autoRetries = 0;
  private agentRetries = 0;
  private compactions = 0;
  /**
   * M10.4.4：上一条活动（assistant message_end / 工具执行 end）的结束时刻
   * ——下一个 model.turn 的 message_start 距它的间隔即该次 provider 请求的
   * TTFB（首 turn 无前序活动时以任务执行开始为基线）。
   */
  private lastActivityEndMs: number | undefined;

  constructor(
    scope: TraceScope,
    session: RunTraceSession,
    base: { taskId: string; agentId: string; modelLabel: string; role: string },
    nowMs: () => number,
  ) {
    this.scope = scope;
    this.session = session;
    this.base = base;
    this.nowMs = nowMs;
  }

  /** 进入 session.prompt（执行段开始） */
  executionStarted(): void {
    if (this.taskSpan !== undefined) {
      return;
    }
    this.taskSpan = {
      traceId: this.session.traceId,
      spanId: newSpanId(),
      parentSpanId: this.scope.stageSpanId,
      name: "agent.task",
      kind: "internal",
      startMs: this.nowMs(),
      endMs: this.nowMs(),
      durationMs: 0,
      status: "unset",
      attributes: {
        "task.id": this.base.taskId,
        "agent.id": this.base.agentId,
        "agent.role": this.base.role,
        "model.label": this.base.modelLabel,
        "stage.id": this.scope.stageId,
        "stage.attempt": this.scope.attempt,
      },
    };
  }

  /** 消费一条 Pi 会话事件（在事件转发器内调用；先记 trace 后做既有映射） */
  observeEvent(raw: ObservedEvent): void {
    switch (raw.type) {
      case "message_start":
        if (raw.message?.role === "assistant") {
          this.closeOpenModelSpan("unset", "message_start 重入（前序流未收尾）");
          const startedAt = this.nowMs();
          // M10.4.4：本 turn 的 provider TTFB（距上一活动结束 / 任务执行开始）
          const baseline = this.lastActivityEndMs ?? this.taskSpan?.startMs ?? startedAt;
          const ttfbMs = Math.max(0, startedAt - baseline);
          this.openModelSpan = {
            span: {
              traceId: this.session.traceId,
              spanId: newSpanId(),
              parentSpanId: this.taskSpan?.spanId ?? this.scope.stageSpanId,
              name: "model.turn",
              kind: "client",
              startMs: startedAt,
              endMs: startedAt,
              durationMs: 0,
              status: "unset",
              attributes: {
                "model.provider": this.providerOf(),
                "model.id": this.modelIdOf(),
                "model.label": this.base.modelLabel,
                "agent.id": this.base.agentId,
                "stage.id": this.scope.stageId,
                "model.ttfbMs": ttfbMs,
              },
            },
          };
        }
        return;
      case "message_end": {
        if (raw.message?.role !== "assistant") {
          return;
        }
        const usage = readUsage(raw.message.usage);
        const stopReason = typeof raw.message.stopReason === "string" ? raw.message.stopReason : undefined;
        const now = this.nowMs();
        // message_start 缺失（脚本化会话 / 事件淘汰）时补一条零时长 span，如实标注
        if (this.openModelSpan === undefined) {
          this.openModelSpan = {
            span: {
              traceId: this.session.traceId,
              spanId: newSpanId(),
              parentSpanId: this.taskSpan?.spanId ?? this.scope.stageSpanId,
              name: "model.turn",
              kind: "client",
              startMs: now,
              endMs: now,
              durationMs: 0,
              status: "unset",
              attributes: {
                "model.provider": this.providerOf(),
                "model.id": this.modelIdOf(),
                "model.label": this.base.modelLabel,
                "agent.id": this.base.agentId,
                "stage.id": this.scope.stageId,
                "model.startObserved": false,
              },
            },
          };
        }
        const span = this.openModelSpan.span;
        span.endMs = now;
        span.durationMs = Math.max(0, span.endMs - span.startMs);
        span.status = stopReason === "error" ? "error" : "ok";
        this.lastActivityEndMs = now; // M10.4.4：下一 turn TTFB 的基线
        if (stopReason !== undefined) {
          span.attributes["model.stopReason"] = stopReason;
        }
        if (usage !== undefined) {
          span.attributes["model.inputTokens"] = usage.input;
          span.attributes["model.outputTokens"] = usage.output;
          span.attributes["model.cacheReadTokens"] = usage.cacheRead;
          span.attributes["model.cacheWriteTokens"] = usage.cacheWrite;
          if (usage.cost !== undefined) {
            span.attributes["model.estimatedCost"] = usage.cost;
          }
        }
        this.session.addSpan(span);
        this.openModelSpan = undefined;
        return;
      }
      case "tool_execution_start": {
        const toolCallId = typeof raw.toolCallId === "string" ? raw.toolCallId : undefined;
        const toolName = typeof raw.toolName === "string" ? raw.toolName : "(unknown)";
        if (toolCallId === undefined) {
          return;
        }
        const now = this.nowMs();
        this.openToolSpans.set(toolCallId, {
          traceId: this.session.traceId,
          spanId: newSpanId(),
          parentSpanId: this.taskSpan?.spanId ?? this.scope.stageSpanId,
          name: "tool.call",
          kind: "internal",
          startMs: now,
          endMs: now,
          durationMs: 0,
          status: "unset",
          attributes: {
            "tool.name": toolName,
            "tool.callId": toolCallId,
            "agent.id": this.base.agentId,
            "stage.id": this.scope.stageId,
          },
        });
        return;
      }
      case "tool_execution_end": {
        const toolCallId = typeof raw.toolCallId === "string" ? raw.toolCallId : undefined;
        if (toolCallId === undefined) {
          return;
        }
        const span = this.openToolSpans.get(toolCallId);
        if (span === undefined) {
          return;
        }
        this.openToolSpans.delete(toolCallId);
        span.endMs = this.nowMs();
        span.durationMs = Math.max(0, span.endMs - span.startMs);
        span.status = raw.isError === true ? "error" : "ok";
        this.lastActivityEndMs = span.endMs; // M10.4.4：下一 turn TTFB 的基线
        this.session.addSpan(span);
        return;
      }
      case "auto_retry_start": {
        // 当前在途模型请求即失败请求：以 error 收口（下一次 message_start 开新 span）
        this.closeOpenModelSpan("error", "provider 请求失败，进入 auto-retry");
        this.autoRetries += 1;
        this.appendTaskEvent("auto_retry", {
          attempt: typeof raw.attempt === "number" ? raw.attempt : 0,
          error: truncate(String(raw.errorMessage ?? ""), 200),
        });
        return;
      }
      case "auto_retry_end":
        this.appendTaskEvent("auto_retry_end", {
          success: raw.success === true,
        });
        return;
      case "agent_end":
        if (raw.willRetry === true) {
          this.agentRetries += 1;
          this.appendTaskEvent("agent_retry", {});
        }
        return;
      case "compaction_start":
        this.compactions += 1;
        this.appendTaskEvent("compaction_start", {
          reason: typeof raw.reason === "string" ? raw.reason : "",
        });
        return;
      case "compaction_end":
        this.appendTaskEvent("compaction_end", {
          reason: typeof raw.reason === "string" ? raw.reason : "",
          willRetry: raw.willRetry === true,
        });
        return;
      default:
        return;
    }
  }

  /** 任务终态（withTerminalDiagnostics 后调用）；收敛一切未闭合 span */
  taskSettled(info: TaskSettleInfo): void {
    const now = this.nowMs();
    this.closeOpenModelSpan("unset", "任务终态时流未收尾（abort / 中断）");
    for (const span of this.openToolSpans.values()) {
      span.endMs = now;
      span.durationMs = Math.max(0, span.endMs - span.startMs);
      span.status = "unset";
      span.statusMessage = "任务终态时工具未收尾（abort / 中断）";
      this.session.addSpan(span);
    }
    this.openToolSpans.clear();
    const span = this.taskSpan;
    this.taskSpan = undefined;
    if (span === undefined) {
      return;
    }
    span.endMs = now;
    span.durationMs = Math.max(0, span.endMs - span.startMs);
    span.status = info.status === "completed" ? "ok" : info.status === "cancelled" ? "unset" : "error";
    if (info.errorCode !== undefined) {
      span.attributes["task.errorCode"] = info.errorCode;
    }
    if (info.error !== undefined) {
      span.statusMessage = truncate(info.error, 300);
    }
    if (typeof info.queueDurationMs === "number") {
      span.attributes["task.queueDurationMs"] = Math.max(0, info.queueDurationMs);
    }
    if (typeof info.executionDurationMs === "number") {
      span.attributes["task.executionDurationMs"] = Math.max(0, info.executionDurationMs);
    }
    if (typeof info.totalDurationMs === "number") {
      span.attributes["task.totalDurationMs"] = Math.max(0, info.totalDurationMs);
    }
    if (typeof info.firstActivityMs === "number") {
      span.attributes["task.firstActivityMs"] = Math.max(0, info.firstActivityMs);
    }
    if (info.usage !== undefined) {
      span.attributes["task.inputTokens"] = info.usage.inputTokens;
      span.attributes["task.outputTokens"] = info.usage.outputTokens;
      span.attributes["task.cacheReadTokens"] = info.usage.cacheReadTokens;
      span.attributes["task.cacheWriteTokens"] = info.usage.cacheWriteTokens;
      if (info.usage.estimatedCost !== undefined) {
        span.attributes["task.estimatedCost"] = info.usage.estimatedCost;
      }
      span.attributes["task.assistantTurns"] = info.usage.assistantTurns;
    }
    span.attributes["task.retriesAuto"] = this.autoRetries;
    span.attributes["task.retriesAgent"] = this.agentRetries;
    span.attributes["task.compactions"] = this.compactions;
    this.session.addSpan(span);
  }

  private closeOpenModelSpan(status: TraceSpan["status"], message: string): void {
    const open = this.openModelSpan;
    if (open === undefined) {
      return;
    }
    this.openModelSpan = undefined;
    open.span.endMs = this.nowMs();
    open.span.durationMs = Math.max(0, open.span.endMs - open.span.startMs);
    open.span.status = status;
    open.span.statusMessage = message;
    this.session.addSpan(open.span);
  }

  private appendTaskEvent(name: string, attributes: Record<string, TraceAttributeValue>): void {
    const span = this.taskSpan;
    if (span === undefined) {
      return;
    }
    span.events = [...(span.events ?? []), { name, timeMs: this.nowMs(), attributes }];
  }

  /**
   * M10.4.4：first-activity watchdog 触发的显式 trace 事件（threshold /
   * elapsed / 是否武装过）——不伪装成普通 provider error，超时类型可观测。
   */
  recordFirstActivityTimeout(params: { thresholdMs: number; elapsedMs: number }): void {
    this.appendTaskEvent("first_activity_timeout", {
      "timeout.thresholdMs": params.thresholdMs,
      "timeout.elapsedMs": params.elapsedMs,
    });
  }

  private providerOf(): string {
    return this.base.modelLabel.split("/")[0] ?? "";
  }

  private modelIdOf(): string {
    const slash = this.base.modelLabel.indexOf("/");
    return slash >= 0 ? this.base.modelLabel.slice(slash + 1) : this.base.modelLabel;
  }
}

/** pi usage 对象的防御性读取（与 accumulateRunUsage 同语义） */
function readUsage(
  usage: unknown,
): { input: number; output: number; cacheRead: number; cacheWrite: number; cost?: number } | undefined {
  if (typeof usage !== "object" || usage === null) {
    return undefined;
  }
  const record = usage as {
    input?: unknown;
    output?: unknown;
    cacheRead?: unknown;
    cacheWrite?: unknown;
    cost?: { total?: unknown };
  };
  const read = (value: unknown): number =>
    typeof value === "number" && Number.isFinite(value) ? value : 0;
  const cost = record.cost?.total;
  return {
    input: read(record.input),
    output: read(record.output),
    cacheRead: read(record.cacheRead),
    cacheWrite: read(record.cacheWrite),
    ...(typeof cost === "number" && Number.isFinite(cost) ? { cost } : {}),
  };
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max)}…`;
}
