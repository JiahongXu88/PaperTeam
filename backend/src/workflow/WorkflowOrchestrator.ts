/**
 * WorkflowOrchestrator —— 确定性 Workflow 编排引擎（M3.0，D-0008）。
 *
 * 职责（代码负责流程纪律，LLM 只负责内容）：
 *   stage sequencing / branch / retry / timeout / bounded loop（由 plan() 表达）
 *   checkpoint / resume / awaiting_input / cancellation / hard gate / domain event
 *
 * 引擎不认识任何业务 Stage：WorkflowDefinition 提供 stage 注册表与确定性规划器
 * （plan 是 WorkflowState 的纯函数，可从 checkpoint 重放）。执行模型：
 *
 *   createRun → (后台) runLoop：
 *     plan(state)
 *       ├─ stage（执行型）→ timeout+retry 包裹 execute → DoD 校验 → 记录 + checkpoint
 *       ├─ stage（HITL） → status=awaiting_input → checkpoint → 暂停（resume() 重入）
 *       ├─ complete      → status=completed + completion
 *       └─ fail          → status=failed + error
 *   cancel → 协作式：标记后立即 abort 在途 stage 并在下个边界生效；
 *            awaiting_input / pending 无循环，立即终结
 *   recoverInterruptedRuns → 进程重启后把磁盘上 running/pending 的 run 重新拉起
 *     （已成功 stage 不重复执行：plan 只基于 stageResults 推进）
 */

import { randomUUID } from "node:crypto";

import {
  BusinessError,
  StageContractViolationError,
  StageFailedError,
  WorkflowInvalidStateError,
  WorkflowNotFoundError,
  type StageFailureCategory,
} from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { appendEventLine, readEventLog } from "./eventLog.js";
import { WorkflowRunStore } from "./runStore.js";
import type {
  ExecutionStageSpec,
  HitlStageSpec,
  ResumeInput,
  StageRecord,
  StageRunContext,
  StageSpec,
  WorkflowDefinition,
  WorkflowDomainEvent,
  WorkflowDomainEventType,
  WorkflowEventListener,
  WorkflowKind,
  WorkflowState,
} from "./types.js";
import { isHitlStage } from "./types.js";

export type WorkflowDefinitionFactory = (kind: WorkflowKind) => WorkflowDefinition;

export interface WorkflowOrchestratorOptions {
  projects: ProjectStore;
  runStore: WorkflowRunStore;
  definitionFactory: WorkflowDefinitionFactory;
  /** 可注入时钟与 id 生成器（测试用） */
  now?: () => Date;
  idFactory?: () => string;
  /** 重试之间的退避延迟（毫秒，默认 200；测试可设 0） */
  retryDelayMs?: number;
  log?: (message: string) => void;
}

/** 活跃 run 的内存句柄 */
interface RunHandle {
  state: WorkflowState;
  definition: WorkflowDefinition;
  cancelRequested: boolean;
  /** 当前执行循环的 Promise（无循环时为 null：awaiting_input / 已终止 / 未启动） */
  loop: Promise<void> | null;
  listeners: Set<WorkflowEventListener>;
  /** 事件追加串行化（保证 seq 单调且写入有序） */
  emitChain: Promise<void>;
  /** 从磁盘恢复的 run（重启拉起时发 workflow.recovered 而非 workflow.started） */
  recovered: boolean;
  /** 在途 stage 的取消信号（cancel 时全部 abort） */
  abortControllers: Set<AbortController>;
}

export class WorkflowOrchestrator {
  private readonly projects: ProjectStore;
  private readonly runStore: WorkflowRunStore;
  private readonly definitionFactory: WorkflowDefinitionFactory;
  private readonly now: () => Date;
  private readonly idFactory: () => string;
  private readonly retryDelayMs: number;
  private readonly log: (message: string) => void;
  private readonly handles = new Map<string, RunHandle>();
  private closed = false;

  constructor(options: WorkflowOrchestratorOptions) {
    this.projects = options.projects;
    this.runStore = options.runStore;
    this.definitionFactory = options.definitionFactory;
    this.now = options.now ?? (() => new Date());
    this.idFactory =
      options.idFactory ?? (() => `w-${randomUUID().replaceAll("-", "").slice(0, 12)}`);
    this.retryDelayMs = options.retryDelayMs ?? 200;
    this.log = options.log ?? (() => {});
  }

  // ---- 创建与查询 ----

  /**
   * 创建 WorkflowRun（校验项目存在、无进行中的 run），持久化 pending 状态
   * 并立即开始后台执行循环。
   */
  async createRun(
    projectId: string,
    kind: WorkflowKind,
    request: Record<string, unknown> = {},
  ): Promise<WorkflowState> {
    if (this.closed) {
      throw new BusinessError("WORKFLOW_INVALID_STATE", "Orchestrator 已关闭，不能创建新的 run");
    }
    await this.projects.getRequired(projectId);
    const definition = this.definitionFactory(kind);

    if (await this.hasActiveRun(projectId)) {
      const active = (await this.listRuns(projectId)).find((state) =>
        state.status === "pending" || state.status === "running" || state.status === "awaiting_input",
      );
      throw new WorkflowInvalidStateError(
        active?.runId ?? "(unknown)",
        active?.status ?? "active",
        "创建新 run（同一项目已有进行中的 WorkflowRun）",
      );
    }

    const timestamp = this.now().toISOString();
    const state: WorkflowState = {
      schemaVersion: 1,
      runId: this.idFactory(),
      projectId,
      workflowKind: kind,
      status: "pending",
      createdAt: timestamp,
      updatedAt: timestamp,
      ...(Object.keys(request).length > 0 ? { request } : {}),
      completedStages: [],
      stageResults: {},
      stageHistory: [],
      inputs: {},
      eventsSeq: 0,
    };
    await this.runStore.saveCheckpoint(state);
    this.registerHandle(state, definition);
    this.startLoop(state.runId);
    return structuredClone(state);
  }

  /** 查询 run（内存优先，磁盘兜底；不存在抛 WORKFLOW_NOT_FOUND） */
  async getRun(runId: string): Promise<WorkflowState> {
    const { state } = await this.getRunWithProject(runId);
    return state;
  }

  /** 查询 run 及其 projectId（调用方不需要预先知道项目） */
  async getRunWithProject(runId: string): Promise<{ projectId: string; state: WorkflowState }> {
    const handle = this.handles.get(runId);
    if (handle) {
      return { projectId: handle.state.projectId, state: structuredClone(handle.state) };
    }
    const location = await this.runStore.findRunLocation(runId);
    if (location === null) {
      throw new WorkflowNotFoundError(runId);
    }
    return location;
  }

  /** 列出项目的全部 run（按创建时间倒序） */
  async listRuns(projectId: string): Promise<WorkflowState[]> {
    const states: WorkflowState[] = [];
    for (const runId of await this.runStore.listRunIds(projectId)) {
      const state = await this.loadState(projectId, runId);
      if (state !== null) {
        states.push(state);
      }
    }
    return states.sort((a, b) => b.createdAt.localeCompare(a.createdAt));
  }

  /** 是否存在进行中的 run（pending / running / awaiting_input） */
  async hasActiveRun(projectId: string): Promise<boolean> {
    for (const runId of await this.runStore.listRunIds(projectId)) {
      const state = await this.loadState(projectId, runId);
      if (
        state !== null &&
        (state.status === "pending" || state.status === "running" || state.status === "awaiting_input")
      ) {
        return true;
      }
    }
    return false;
  }

  // ---- HITL / 取消 ----

  /** 提交 HITL 输入：awaiting_input → running 并继续执行 */
  async resume(runId: string, input: ResumeInput): Promise<WorkflowState> {
    const handle = await this.requireHandle(runId);
    if (handle.state.status !== "awaiting_input" || handle.state.awaiting === undefined) {
      throw new WorkflowInvalidStateError(
        runId,
        handle.state.status,
        "resume（仅在 awaiting_input 状态可恢复）",
      );
    }
    const stageId = handle.state.awaiting.stageId;
    const outcome = await handle.definition.onInput(handle.state, stageId, input);
    handle.state.inputs[stageId] = input;
    if (outcome === "cancel") {
      // 用户决策为取消：直接终结（保持 awaiting 清理与事件一致）
      handle.state.awaiting = undefined;
      await this.finalizeCancelled(handle);
      return structuredClone(handle.state);
    }
    handle.state.awaiting = undefined;
    handle.state.status = "running";
    // HITL stage 在收到输入时视为完成（与执行型 stage 一致进入 completedStages）
    handle.state.completedStages = [
      ...handle.state.completedStages.filter((id) => id !== stageId),
      stageId,
    ];
    this.touch(handle.state);
    await this.emit(handle, {
      type: "workflow.resumed",
      stageId,
      message: `已收到用户输入（decision=${input.decision}），继续执行`,
      data: { decision: input.decision },
    });
    await this.runStore.saveCheckpoint(handle.state);
    this.startLoop(runId);
    return structuredClone(handle.state);
  }

  /**
   * 请求取消：abort 在途 stage 并标记；执行循环在下个检查点终结并落盘。
   * awaiting_input / pending（无执行循环）立即终结。
   */
  async cancel(runId: string): Promise<WorkflowState> {
    const handle = await this.requireHandle(runId);
    const status = handle.state.status;
    if (status === "completed" || status === "failed" || status === "cancelled") {
      throw new WorkflowInvalidStateError(runId, status, "cancel");
    }
    handle.cancelRequested = true;
    for (const controller of handle.abortControllers) {
      controller.abort();
    }
    if (handle.loop === null) {
      await this.finalizeCancelled(handle);
    }
    return structuredClone(handle.state);
  }

  // ---- 恢复（进程重启后） ----

  /**
   * 扫描磁盘，把处于 pending / running（进程中断）的 run 重新拉起。
   * awaiting_input 的 run 保持等待（恢复语义由用户 resume 触发）。
   * 已成功 stage 不重复执行（plan 基于 stageResults 推进）。
   */
  async recoverInterruptedRuns(): Promise<
    { runId: string; outcome: "restarted" | "awaiting_input" }[]
  > {
    const results: { runId: string; outcome: "restarted" | "awaiting_input" }[] = [];
    for (const projectId of await this.projects.list()) {
      for (const runId of await this.runStore.listRunIds(projectId)) {
        if (this.handles.has(runId)) {
          continue; // 内存中已有（正在执行 / 已恢复）
        }
        const state = await this.runStore.loadCheckpoint(projectId, runId);
        if (state === null) {
          continue;
        }
        if (state.status === "awaiting_input") {
          await this.registerDiskHandle(state);
          results.push({ runId, outcome: "awaiting_input" });
          continue;
        }
        if (state.status === "pending" || state.status === "running") {
          const handle = await this.registerDiskHandle(state);
          await this.emit(handle, {
            type: "workflow.recovered",
            message: "进程重启后从 checkpoint 恢复执行（依据 Workspace 状态，不依赖对话历史）",
          });
          this.startLoop(runId);
          results.push({ runId, outcome: "restarted" });
        }
      }
    }
    return results;
  }

  // ---- 事件订阅（SSE / 进度） ----

  /**
   * 订阅实时事件；返回取消订阅函数。
   * 会先把 run 句柄从磁盘装载进内存（重启后的 run 也能收到后续实时事件；
   * 不存在时抛 WORKFLOW_NOT_FOUND）。
   */
  async subscribe(runId: string, listener: WorkflowEventListener): Promise<() => void> {
    const handle = await this.requireHandle(runId);
    handle.listeners.add(listener);
    return () => {
      handle.listeners.delete(listener);
    };
  }

  /** 读取事件日志（含损坏行统计），供 SSE replay */
  async readEvents(
    runId: string,
  ): Promise<{ events: WorkflowDomainEvent[]; projectId: string; skippedLines: number }> {
    const { projectId } = await this.getRunWithProject(runId);
    const result = await readEventLog(this.runStore.eventsPath(projectId, runId));
    return { events: result.events, projectId, skippedLines: result.skippedLines };
  }

  // ---- 生命周期 ----

  /** 停止引擎：请求取消全部活跃 run 并等待循环退出（进程 shutdown 用） */
  async close(): Promise<void> {
    this.closed = true;
    for (const handle of this.handles.values()) {
      handle.cancelRequested = true;
      for (const controller of handle.abortControllers) {
        controller.abort();
      }
    }
    const loops = [...this.handles.values()]
      .map((handle) => handle.loop)
      .filter((loop): loop is Promise<void> => loop !== null);
    await Promise.allSettled(loops);
  }

  // ---- 内部：执行循环 ----

  private startLoop(runId: string): void {
    const handle = this.handles.get(runId);
    if (!handle || handle.loop !== null) {
      return;
    }
    handle.loop = this.runLoop(runId).finally(() => {
      const current = this.handles.get(runId);
      if (current) {
        current.loop = null;
      }
    });
  }

  private async runLoop(runId: string): Promise<void> {
    const handle = this.handles.get(runId);
    if (!handle) {
      return;
    }
    const { state, definition } = handle;

    if (state.status === "pending") {
      state.status = "running";
      state.startedAt = this.now().toISOString();
      this.touch(state);
      if (!handle.recovered) {
        await this.emit(handle, {
          type: "workflow.started",
          message: `Workflow 启动（${definition.description}）`,
          data: { workflowKind: state.workflowKind },
        });
      }
      await this.runStore.saveCheckpoint(state);
    } else {
      state.status = "running";
      this.touch(state);
    }

    try {
      for (;;) {
        if (handle.cancelRequested) {
          await this.finalizeCancelled(handle);
          return;
        }

        const decision = definition.plan(state);

        if (decision.kind === "complete") {
          const summary = decision.summary;
          const label = decision.label;
          await this.persistThenCommit(
            handle,
            (target) => {
              target.status = "completed";
              target.finishedAt = this.now().toISOString();
              target.currentStage = undefined;
              target.completion = { label, summary };
              target.updatedAt = this.now().toISOString();
            },
            () => ({
              type: "workflow.completed" as const,
              message: `Workflow 完成（${label === "final" ? "Final：双 Gate 通过" : "Draft：Build Gate 通过"}）`,
              data: { label, summary },
            }),
          );
          return;
        }

        if (decision.kind === "fail") {
          await this.finalizeFailed(handle, { code: decision.code, message: decision.message });
          return;
        }

        const stage = this.requireStage(definition, decision.stageId);

        if (isHitlStage(stage)) {
          await this.enterAwaitingInput(handle, stage);
          return; // 暂停，等待 resume()
        }

        const continueLoop = await this.executeStage(handle, stage);
        if (!continueLoop) {
          return; // run 已终结（失败 / 取消）
        }
      }
    } catch (error) {
      // plan()/引擎自身的异常兜底：run 失败
      const businessError =
        error instanceof BusinessError
          ? error
          : new BusinessError("INTERNAL_ERROR", `编排引擎异常：${errorText(error)}`);
      await this.finalizeFailed(handle, {
        code: businessError.code,
        message: businessError.message,
        stageId: state.currentStage,
      });
    }
  }

  /** 执行一个（执行型）stage；返回 false 表示 run 已终结 */
  private async executeStage(handle: RunHandle, stage: ExecutionStageSpec): Promise<boolean> {
    const { state } = handle;

    // 契约检查：requiredInputs 必须已在 stageResults 中（防规划缺陷）
    const missing = stage.requiredInputs.filter((id) => !(id in state.stageResults));
    if (missing.length > 0) {
      await this.finalizeFailed(handle, {
        code: "STAGE_CONTRACT_VIOLATION",
        message: `Stage ${stage.id} 缺少必需输入：${missing.join(", ")}`,
        stageId: stage.id,
      });
      return false;
    }

    state.currentStage = stage.id;
    this.touch(state);

    for (let attempt = 1; attempt <= stage.maxAttempts; attempt += 1) {
      if (handle.cancelRequested) {
        await this.finalizeCancelled(handle);
        return false;
      }

      const startedAt = this.now().toISOString();
      await this.emit(handle, {
        type: "stage.started",
        stageId: stage.id,
        attempt,
        message: stage.description,
      });

      const controller = new AbortController();
      handle.abortControllers.add(controller);

      let outcome:
        | { ok: true; result: Record<string, unknown> }
        | { ok: false; category: StageFailureCategory; code: string; message: string };
      try {
        const ctx: StageRunContext = {
          runId: state.runId,
          projectId: state.projectId,
          attempt,
          state: structuredClone(state),
          signal: controller.signal,
          emitProgress: (data) =>
            this.emit(handle, { type: "stage.progress", stageId: stage.id, attempt, data }),
          log: (message) => this.log(`[workflow ${state.runId}] ${message}`),
        };
        const result = await withTimeout(
          stage.execute(ctx),
          stage.timeoutMs,
          `Stage ${stage.id} 执行超时（${stage.timeoutMs}ms）`,
        );

        // DoD 校验（StageContract：Agent 返回文本 ≠ 成功，产出必须确定性可检）
        const violations = (await stage.verifyDod?.(ctx)) ?? [];
        if (violations.length > 0) {
          throw new StageContractViolationError(stage.id, violations);
        }
        outcome = { ok: true, result };
      } catch (error) {
        if (error instanceof StageContractViolationError) {
          outcome = { ok: false, category: "contract_violation", code: error.code, message: error.message };
        } else if (error instanceof StageFailedError) {
          outcome = { ok: false, category: error.category, code: error.code, message: error.message };
        } else if (error instanceof TimeoutSignal) {
          outcome = { ok: false, category: "timeout", code: "STAGE_FAILED", message: error.message };
        } else if (error instanceof BusinessError) {
          outcome = {
            ok: false,
            category: classifyBusinessError(error),
            code: error.code,
            message: error.message,
          };
        } else {
          outcome = { ok: false, category: "transient", code: "INTERNAL_ERROR", message: errorText(error) };
        }
      } finally {
        handle.abortControllers.delete(controller);
      }

      const finishedAt = this.now().toISOString();

      if (outcome.ok) {
        const record: StageRecord = {
          stageId: stage.id,
          attempt,
          status: "completed",
          startedAt,
          finishedAt,
          summary: outcome.result,
        };
        state.stageResults[stage.id] = outcome.result;
        state.stageHistory.push(record);
        state.completedStages = [...state.completedStages.filter((id) => id !== stage.id), stage.id];
        this.touch(state);
        await this.runStore.saveStageRecord(
          state.projectId,
          state.runId,
          state.stageHistory.length,
          record,
        );
        await this.emit(handle, {
          type: "stage.completed",
          stageId: stage.id,
          attempt,
          message: `Stage 完成（产出：${stage.producedOutputs.join("、") || "—"}）`,
          data: summarizeResult(outcome.result),
        });
        await this.runStore.saveCheckpoint(state);
        return true;
      }

      const record: StageRecord = {
        stageId: stage.id,
        attempt,
        status: "failed",
        startedAt,
        finishedAt,
        error: { category: outcome.category, code: outcome.code, message: outcome.message },
      };
      state.stageHistory.push(record);
      this.touch(state);
      await this.runStore.saveStageRecord(state.projectId, state.runId, state.stageHistory.length, record);
      await this.emit(handle, {
        type: "stage.failed",
        stageId: stage.id,
        attempt,
        message: `Stage 失败（${outcome.category}）：${outcome.message}`,
        data: {
          category: outcome.category,
          code: outcome.code,
          attempt,
          maxAttempts: stage.maxAttempts,
        },
      });

      const retryable = stage.retryable.includes(outcome.category);
      if (retryable && attempt < stage.maxAttempts) {
        this.log(`[workflow ${state.runId}] stage ${stage.id} 第 ${attempt} 次失败，准备重试`);
        if (this.retryDelayMs > 0) {
          await delay(this.retryDelayMs);
        }
        continue;
      }

      await this.finalizeFailed(handle, {
        code: outcome.code,
        message: `Stage ${stage.id} 失败（${outcome.category}，尝试 ${attempt}/${stage.maxAttempts}）：${outcome.message}`,
        stageId: stage.id,
      });
      return false;
    }
    return false; // 不可达：循环内必 return
  }

  private async enterAwaitingInput(handle: RunHandle, stage: HitlStageSpec): Promise<void> {
    const { state } = handle;
    const ctx: StageRunContext = {
      runId: state.runId,
      projectId: state.projectId,
      attempt: 1,
      state: structuredClone(state),
      signal: new AbortController().signal,
      emitProgress: () => Promise.resolve(),
      log: (message) => this.log(`[workflow ${state.runId}] ${message}`),
    };
    const payload = (await stage.hitl.payload?.(ctx)) ?? undefined;
    await this.persistThenCommit(
      handle,
      (target) => {
        target.status = "awaiting_input";
        target.currentStage = stage.id;
        target.awaiting = {
          stageId: stage.id,
          prompt: stage.hitl.prompt,
          options: stage.hitl.options,
          ...(payload !== undefined ? { payload } : {}),
        };
        target.updatedAt = this.now().toISOString();
      },
      () => ({
        type: "workflow.awaiting_input" as const,
        stageId: stage.id,
        message: stage.hitl.prompt,
        data: {
          options: stage.hitl.options,
          ...(payload !== undefined ? { payload } : {}),
        },
      }),
    );
  }

  private async finalizeCancelled(handle: RunHandle): Promise<void> {
    await this.persistThenCommit(
      handle,
      (target) => {
        target.status = "cancelled";
        target.finishedAt = this.now().toISOString();
        target.updatedAt = this.now().toISOString();
      },
      () => ({
        type: "workflow.cancelled" as const,
        stageId: handle.state.currentStage,
        message: "Workflow 已取消",
      }),
    );
  }

  private async finalizeFailed(
    handle: RunHandle,
    error: { code: string; message: string; stageId?: string },
  ): Promise<void> {
    await this.persistThenCommit(
      handle,
      (target) => {
        target.status = "failed";
        target.finishedAt = this.now().toISOString();
        target.error = {
          code: error.code,
          message: error.message,
          ...(error.stageId ? { stageId: error.stageId } : {}),
        };
        target.updatedAt = this.now().toISOString();
      },
      () => ({
        type: "workflow.failed" as const,
        stageId: error.stageId,
        message: `Workflow 失败：${error.message}`,
        data: { code: error.code },
      }),
    );
  }

  /**
   * 终态转换统一走「先持久化、后提交内存、再广播」：
   * 保证对外可见的终态（completed / failed / cancelled / awaiting_input）
   * 一定已经写入 checkpoint（重启恢复读取的就是这份文件）。
   */
  private async persistThenCommit(
    handle: RunHandle,
    apply: (state: WorkflowState) => void,
    buildEvent: () => {
      type: WorkflowDomainEventType;
      stageId?: string;
      attempt?: number;
      message: string;
      data?: Record<string, unknown>;
    },
  ): Promise<void> {
    const snapshot = structuredClone(handle.state);
    apply(snapshot);
    await this.runStore.saveCheckpoint(snapshot);
    apply(handle.state);
    await this.emit(handle, buildEvent());
  }

  // ---- 内部：事件与句柄 ----

  private async emit(
    handle: RunHandle,
    event: Omit<WorkflowDomainEvent, "seq" | "runId" | "projectId" | "ts"> & {
      type: WorkflowDomainEventType;
    },
  ): Promise<void> {
    // 串行化追加，保证 seq 单调、文件有序
    handle.emitChain = handle.emitChain.then(async () => {
      const { state } = handle;
      state.eventsSeq += 1;
      const full: WorkflowDomainEvent = {
        seq: state.eventsSeq,
        runId: state.runId,
        projectId: state.projectId,
        ts: this.now().toISOString(),
        ...event,
      };
      await appendEventLine(this.runStore.eventsPath(state.projectId, state.runId), full);
      for (const listener of handle.listeners) {
        try {
          listener(full);
        } catch (error) {
          this.log(`[workflow ${state.runId}] 事件监听器异常：${errorText(error)}`);
        }
      }
    });
    await handle.emitChain;
  }

  private registerHandle(state: WorkflowState, definition: WorkflowDefinition): RunHandle {
    const handle: RunHandle = {
      state,
      definition,
      cancelRequested: false,
      loop: null,
      listeners: new Set(),
      emitChain: Promise.resolve(),
      recovered: false,
      abortControllers: new Set(),
    };
    this.handles.set(state.runId, handle);
    return handle;
  }

  /** 从磁盘装载 run（重启后）：eventsSeq 与磁盘日志对齐，避免 seq 回退 */
  private async registerDiskHandle(state: WorkflowState): Promise<RunHandle> {
    const definition = this.definitionFactory(state.workflowKind);
    const logResult = await readEventLog(this.runStore.eventsPath(state.projectId, state.runId));
    if (logResult.maxSeq > state.eventsSeq) {
      state.eventsSeq = logResult.maxSeq;
    }
    const handle = this.registerHandle(state, definition);
    handle.recovered = true;
    return handle;
  }

  private async requireHandle(runId: string): Promise<RunHandle> {
    const handle = this.handles.get(runId);
    if (handle) {
      return handle;
    }
    // 进程重启后（如 awaiting_input 的 run）：从磁盘装载
    const location = await this.runStore.findRunLocation(runId);
    if (location === null) {
      throw new WorkflowNotFoundError(runId);
    }
    return this.registerDiskHandle(location.state);
  }

  private async loadState(projectId: string, runId: string): Promise<WorkflowState | null> {
    const handle = this.handles.get(runId);
    if (handle) {
      return handle.state;
    }
    return this.runStore.loadCheckpoint(projectId, runId);
  }

  private requireStage(definition: WorkflowDefinition, stageId: string): StageSpec {
    const stage = definition.stages.find((candidate) => candidate.id === stageId);
    if (!stage) {
      throw new BusinessError(
        "INTERNAL_ERROR",
        `WorkflowDefinition（${definition.kind}）的 plan() 返回未知 stage：${stageId}`,
      );
    }
    return stage;
  }

  private touch(state: WorkflowState): void {
    state.updatedAt = this.now().toISOString();
  }
}

// ---- 辅助 ----

/** 超时信号（内部；用于区分超时与其他错误） */
class TimeoutSignal extends Error {}

export function withTimeout<T>(promise: Promise<T>, timeoutMs: number, message: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => reject(new TimeoutSignal(message)), timeoutMs);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      (error) => {
        clearTimeout(timer);
        reject(error);
      },
    );
  });
}

/** BusinessError → Stage 失败分类（决定可否重试） */
export function classifyBusinessError(error: BusinessError): StageFailureCategory {
  switch (error.code) {
    case "AGENT_RUNTIME_UNAVAILABLE":
      return "runtime_unavailable";
    case "AGENT_TIMEOUT":
      return "timeout";
    case "AGENT_RUN_FAILED":
    case "INVALID_LATEX_OUTPUT":
    case "LATEX_COMPILE_TIMEOUT":
      return "transient";
    case "LATEX_TOOL_UNAVAILABLE":
      return "runtime_unavailable";
    case "LATEX_COMPILE_FAILED":
    case "STAGE_CONTRACT_VIOLATION":
    case "EVIDENCE_VALIDATION":
    case "IMPORT_VALIDATION":
      return "contract_violation";
    default:
      return "permanent";
  }
}

function summarizeResult(result: Record<string, unknown>): Record<string, unknown> {
  // 事件负载只保留短摘要，避免大 payload 进 events.jsonl
  const summary: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(result)) {
    if (typeof value === "number" || typeof value === "boolean" || typeof value === "string") {
      summary[key] = typeof value === "string" && value.length > 200 ? `${value.slice(0, 200)}…` : value;
    } else if (Array.isArray(value)) {
      summary[key] = value.length;
    }
  }
  return summary;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
