/**
 * Workflow 层核心类型（M3.0）。
 *
 * 设计约束（docs/ARCHITECTURE.md §3、DECISIONS D-0008 / D-0013 / D-0014）：
 * - WorkflowOrchestrator 是确定性 TypeScript 代码，不是 Agent，不调用 LLM；
 * - 线性主干 + 有限分支 + bounded loop + 少量 fan-out，不引入 DAG Engine；
 * - LLM 产出必须通过 StageContract 的 DoD 校验才算 Stage 完成；
 * - WorkflowState 是可持久化、可恢复的 checkpoint（Authoritative State）。
 */

import type { StageFailureCategory } from "../errors.js";

/** WorkflowRun 状态（PRD §9.7） */
export type WorkflowRunStatus =
  | "pending"
  | "running"
  | "awaiting_input"
  | "completed"
  | "failed"
  | "cancelled";

/** 一级工作流类型（PRD §9.1） */
export type WorkflowKind = "idea_to_paper" | "existing_paper_improvement";

// ---- Stage 与 StageContract ----

/** Stage 执行上下文（只读 run 信息；Stage 产出通过返回值进入 checkpoint） */
export interface StageRunContext {
  runId: string;
  projectId: string;
  /** 当前尝试次数（1 起） */
  attempt: number;
  /** 当前 checkpoint 快照（读取先前 stage 结果；不得直接改写） */
  state: WorkflowState;
  /** 取消信号（well-behaved Stage 应尽早退出） */
  signal: AbortSignal;
  /** Stage 内部进度事件（如逐 section 写作进度） */
  emitProgress(data: Record<string, unknown>): Promise<void>;
  /** 发布业务级 Domain Event（如 quality_gate.failed；不得透传 Runtime 细节） */
  emitDomain(
    type: WorkflowDomainEventType,
    data: Record<string, unknown>,
    message?: string,
  ): Promise<void>;
  /** 诊断日志 */
  log(message: string): void;
}

/** 执行型 Stage 契约（StageContract，ARCHITECTURE §3.4） */
export interface ExecutionStageSpec {
  readonly id: string;
  readonly description: string;
  /** 进入本 Stage 必需的前置 stage 结果（缺失视为编排缺陷，run 失败） */
  readonly requiredInputs: readonly string[];
  /** 逻辑产出物名称（诊断 / 文档用） */
  readonly producedOutputs: readonly string[];
  /** 最大尝试次数（含首次） */
  readonly maxAttempts: number;
  /** 单次执行超时（毫秒） */
  readonly timeoutMs: number;
  /** 可重试的失败分类 */
  readonly retryable: readonly StageFailureCategory[];
  /** 执行（返回值进入 state.stageResults[id]，必须 JSON 可序列化） */
  execute(ctx: StageRunContext): Promise<Record<string, unknown>>;
  /** DoD 校验：返回违规项列表（空数组 = 通过）；在 execute 成功后运行 */
  verifyDod?(ctx: StageRunContext): Promise<readonly string[]>;
}

/** HITL Stage：不执行，进入 awaiting_input 等待用户（ARCHITECTURE §3.6） */
export interface HitlStageSpec {
  readonly id: string;
  readonly description: string;
  readonly requiredInputs: readonly string[];
  readonly producedOutputs: readonly string[];
  readonly hitl: {
    /** 呈现给用户的提示（业务语言，不含 session / Gateway 细节） */
    prompt: string;
    /** 可选决策（如 approve / adjust / cancel） */
    options: readonly string[];
    /** 附加上下文（如可行性结论摘要） */
    payload?(ctx: StageRunContext): Promise<Record<string, unknown> | undefined>;
  };
}

export type StageSpec = ExecutionStageSpec | HitlStageSpec;

export function isHitlStage(stage: StageSpec): stage is HitlStageSpec {
  return "hitl" in stage;
}

/** 一次 Stage 尝试的运行记录（checkpoint 的 stageHistory 条目） */
export interface StageRecord {
  stageId: string;
  attempt: number;
  status: "completed" | "failed";
  startedAt: string;
  finishedAt: string;
  /** 失败信息（status=failed 时） */
  error?: { category: StageFailureCategory; code: string; message: string };
  /** 产出摘要（status=completed 时，来自 execute 返回值） */
  summary?: Record<string, unknown>;
}

/** awaiting_input 待办信息（checkpoint 持久化） */
export interface AwaitingInputCheckpoint {
  stageId: string;
  prompt: string;
  options: readonly string[];
  payload?: Record<string, unknown>;
}

/** HITL resume 输入 */
export interface ResumeInput {
  /** 决策（由 WorkflowDefinition 校验，如 approve / adjust / cancel） */
  decision: string;
  /** 附加输入（如修正后的 targetProfile / outline 反馈） */
  payload?: Record<string, unknown>;
}

/** Workflow 完成（label：final=双 Gate 通过；draft=Build Gate 通过即可） */
export interface WorkflowCompletion {
  label: "final" | "draft";
  summary: Record<string, unknown>;
}

// ---- WorkflowState（checkpoint 内容） ----

export interface WorkflowState {
  schemaVersion: 1;
  runId: string;
  projectId: string;
  workflowKind: WorkflowKind;
  status: WorkflowRunStatus;
  createdAt: string;
  updatedAt: string;
  startedAt?: string;
  finishedAt?: string;
  /** 创建 run 时的请求参数（如 prompt），随 checkpoint 持久化 */
  request?: Record<string, unknown>;
  /** 当前（或最近一次）执行的 stage */
  currentStage?: string;
  /** 按完成顺序的 stage id（重复执行时移动到末尾） */
  completedStages: string[];
  /** stage id → 最后一次成功产出 */
  stageResults: Record<string, Record<string, unknown>>;
  /** 全部尝试的运行记录（审计 / resume 依据） */
  stageHistory: StageRecord[];
  /** HITL 输入按 stage id 归档（含被 re-run 覆盖前的最新输入） */
  inputs: Record<string, ResumeInput>;
  /** 定义侧计数器（如手动追加的修订轮数；引擎不解释其语义） */
  counters?: Record<string, number>;
  awaiting?: AwaitingInputCheckpoint;
  error?: { code: string; message: string; stageId?: string };
  completion?: WorkflowCompletion;
  /** 已发出的 Domain Event 序号（单调递增） */
  eventsSeq: number;
}

// ---- WorkflowDefinition（确定性规划器） ----

/** 规划决策：执行下一个 stage / 完成 / 失败 */
export type PlanDecision =
  | { kind: "stage"; stageId: string }
  | { kind: "complete"; label: "final" | "draft"; summary: Record<string, unknown> }
  | { kind: "fail"; code: string; message: string };

/**
 * Workflow 定义：stage 注册表 + 确定性规划器 + HITL 输入处理。
 * plan() 必须是 state 的纯函数（可从 checkpoint 重放）；流程纪律全部在这里。
 */
export interface WorkflowDefinition {
  readonly kind: WorkflowKind;
  readonly description: string;
  readonly stages: readonly StageSpec[];
  /** 确定性推进：基于 state 决定下一步 */
  plan(state: WorkflowState): PlanDecision;
  /**
   * 校验并应用 HITL 输入（非法 decision 抛 WorkflowInvalidStateError）。
   * 返回 "cancel" 表示该输入要求取消整个 run（engine 负责终结）。
   */
  onInput(state: WorkflowState, stageId: string, input: ResumeInput): Promise<void | "cancel">;
}

// ---- Domain Event（与 Runtime Event 分层，ARCHITECTURE §2.3） ----

export type WorkflowDomainEventType =
  | "workflow.started"
  | "stage.started"
  | "stage.progress"
  | "stage.completed"
  | "stage.failed"
  | "workflow.awaiting_input"
  | "workflow.resumed"
  | "workflow.recovered"
  | "workflow.cancelled"
  | "workflow.completed"
  | "workflow.failed"
  | "quality_gate.passed"
  | "quality_gate.failed"
  | "build_gate.passed"
  | "build_gate.failed";

export interface WorkflowDomainEvent {
  seq: number;
  type: WorkflowDomainEventType | (string & {});
  runId: string;
  projectId: string;
  stageId?: string;
  attempt?: number;
  /** 人类可读业务说明（不含 sessionKey / token / 本机绝对路径） */
  message?: string;
  /** 业务级负载数据 */
  data?: Record<string, unknown>;
  ts: string;
}

/** SSE / 内存订阅者收到的事件回调 */
export type WorkflowEventListener = (event: WorkflowDomainEvent) => void;
