import type { WorkflowRunView } from "../../types/api.js";
import { stageSequenceFor } from "../common/status.js";

/**
 * Stage Timeline 推导（纯函数）：run 视图 → 有序时间线条目。
 * 状态语义：
 *   completed  在 completedStages 中（或存在 completed 记录）
 *   running    = currentStage 且 run 运行中
 *   awaiting   = awaiting.stageId（或 awaiting 状态下的 currentStage）
 *   failed     run 失败时 error.stageId 指向的 stage
 *   cancelled  run 取消时正在执行的 stage（在途被中断）
 *   pending    尚未开始（条件 stage 显示「按需」提示）
 */

export type StageTimelineState =
  | "pending"
  | "running"
  | "awaiting"
  | "completed"
  | "failed"
  | "cancelled";

export interface SectionProgressSnapshot {
  /** 已完成节数 */
  completed: number;
  /** 总节数 */
  total: number;
  /** 进行中（started - completed - failed，快照口径）；旧 payload 无 started 时缺省 */
  active?: number;
  /** 排队（total - started）；旧 payload 无 started 时缺省 */
  queued?: number;
  retried?: number;
  failed?: number;
  findings?: number;
  reused?: number;
}

export interface StageTimelineItem {
  stageId: string;
  state: StageTimelineState;
  hitl: boolean;
  conditional: boolean;
  /** 最近一次尝试的开始 / 结束时间（运行中的 stage 为富化 currentStageStartedAt） */
  startedAt?: string;
  finishedAt?: string;
  attempts?: number;
  error?: { code: string; message: string } | null;
  /** review.sections 运行中的进度快照 */
  sectionProgress?: SectionProgressSnapshot;
}

function isRunStatus(run: WorkflowRunView, ...statuses: string[]): boolean {
  return statuses.includes(run.status);
}

/** 防御性读取 stage.progress 载荷中的章节进度（review.sections / writing.sections） */
export function readSectionProgress(data: Record<string, unknown> | undefined): SectionProgressSnapshot | undefined {
  if (data === undefined) {
    return undefined;
  }
  const completed = data["completed"] ?? data["index"];
  const total = data["total"];
  if (typeof completed !== "number" || typeof total !== "number" || total <= 0) {
    return undefined;
  }
  const started = typeof data["started"] === "number" ? data["started"] : undefined;
  const failed = typeof data["failed"] === "number" ? data["failed"] : undefined;
  const retried = typeof data["retried"] === "number" ? data["retried"] : undefined;
  const findings = typeof data["findings"] === "number" ? data["findings"] : undefined;
  const reused = typeof data["reused"] === "number" ? data["reused"] : undefined;
  // started 缺失（旧 payload）：active 无法可靠区分，只给 completed / total
  const snapshot: SectionProgressSnapshot = { completed, total };
  if (started !== undefined) {
    snapshot.active = Math.max(0, started - completed - (failed ?? 0));
    snapshot.queued = Math.max(0, total - started);
  }
  if (retried !== undefined) {
    snapshot.retried = retried;
  }
  if (failed !== undefined) {
    snapshot.failed = failed;
  }
  if (findings !== undefined) {
    snapshot.findings = findings;
  }
  if (reused !== undefined) {
    snapshot.reused = reused;
  }
  return snapshot;
}

export function buildStageTimeline(run: WorkflowRunView): StageTimelineItem[] {
  const sequence = stageSequenceFor(run.workflowKind, run.citationSemanticMode);
  const completedSet = new Set(run.completedStages ?? []);
  // 每个 stage 的最近一次记录与尝试次数（运行中的 stage 尚无记录）
  const lastRecord = new Map<string, NonNullable<WorkflowRunView["stageHistory"]>[number]>();
  const attempts = new Map<string, number>();
  for (const record of run.stageHistory ?? []) {
    lastRecord.set(record.stageId, record);
    attempts.set(record.stageId, (attempts.get(record.stageId) ?? 0) + 1);
  }

  const runActive = isRunStatus(run, "pending", "running", "awaiting_input");
  const awaitingStage = run.awaiting?.stageId ?? (run.status === "awaiting_input" ? run.currentStage : undefined);

  return sequence.map((entry) => {
    const record = lastRecord.get(entry.stageId);
    const completed = completedSet.has(entry.stageId);
    let state: StageTimelineState;
    if (completed) {
      state = "completed";
    } else if (entry.stageId === awaitingStage) {
      state = "awaiting";
    } else if (runActive && entry.stageId === run.currentStage) {
      state = "running";
    } else if (run.status === "failed" && run.error?.stageId === entry.stageId) {
      state = "failed";
    } else if (!runActive && run.status === "cancelled" && entry.stageId === run.currentStage) {
      state = "cancelled";
    } else if (!runActive && run.status === "failed" && record !== undefined && record.status === "failed") {
      // run 在其他 stage 失败，但本 stage 留有失败尝试记录（如超限重试后失败）
      state = "failed";
    } else {
      state = "pending";
    }

    return {
      stageId: entry.stageId,
      state,
      hitl: entry.hitl === true,
      conditional: entry.conditional === true,
      ...(record !== undefined
        ? { startedAt: record.startedAt, finishedAt: record.finishedAt, attempts: attempts.get(entry.stageId) }
        : state === "running" || state === "awaiting" || state === "cancelled"
          ? { startedAt: run.currentStageStartedAt }
          : {}),
      ...(state === "failed" && run.error?.stageId === entry.stageId
        ? { error: run.error ? { code: run.error.code, message: run.error.message } : null }
        : record?.error !== undefined && record.error !== null && state === "failed"
          ? { error: record.error }
          : {}),
      ...(state === "running" && run.progress?.stageId === entry.stageId
        ? { sectionProgress: readSectionProgress(run.progress.data) }
        : {}),
    };
  });
}
