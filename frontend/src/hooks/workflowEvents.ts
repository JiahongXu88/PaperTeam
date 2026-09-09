import { useEffect, useRef, useState } from "react";
import { useQueryClient } from "@tanstack/react-query";

import { apiUrl } from "../api/client.js";
import type { WorkflowDomainEventView, WorkflowRunView } from "../types/api.js";
import { queryKeys } from "./queries.js";

/**
 * Workflow Domain Event SSE 订阅（Live View 的唯一实时通道）。
 *
 * 职责（页面组件不直接 new EventSource）：
 *   连接 /api/runs/:runId/events → seq 去重（重连 replay 不重复应用）
 *   → 事件驱动更新 TanStack Query 缓存（run 列表内的对应 run）
 *   → 终态 / awaiting 时失效查询取权威状态 → 自动清理
 *
 * 断线：EventSource 自动重连，服务端重连后全量 replay，seq 去重保证幂等；
 * 存在活跃 run 时的 3s 轮询作为 SSE 故障时的兜底，不依赖本 hook 存活。
 */

/** 服务端会发送的事件类型（未知类型忽略——向后兼容） */
const DOMAIN_EVENT_TYPES = [
  "workflow.started",
  "stage.started",
  "stage.progress",
  "stage.completed",
  "stage.failed",
  "workflow.awaiting_input",
  "workflow.resumed",
  "workflow.recovered",
  "workflow.cancelled",
  "workflow.completed",
  "workflow.failed",
  "quality_gate.passed",
  "quality_gate.failed",
  "build_gate.passed",
  "build_gate.failed",
] as const;

const TERMINAL_EVENT_TYPES: ReadonlySet<string> = new Set([
  "workflow.completed",
  "workflow.failed",
  "workflow.cancelled",
]);

export type WorkflowEventConnection = "connecting" | "open" | "closed";

export interface WorkflowEventsOptions {
  runId: string | undefined;
  projectId: string | undefined;
  /** false 时不建立连接（如无活跃 run） */
  enabled: boolean;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** 防御性解析 SSE data 载荷（损坏 / 结构不符 → null，不抛出） */
export function parseWorkflowEvent(raw: string): WorkflowDomainEventView | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (!isRecord(parsed) || typeof parsed["seq"] !== "number" || typeof parsed["type"] !== "string") {
    return null;
  }
  return parsed as unknown as WorkflowDomainEventView;
}

/**
 * 单个事件 → run 视图的增量更新（纯函数，测试直接覆盖）。
 * 返回 undefined 表示该事件不需要直接更新缓存（由调用方 invalidate 处理）。
 */
export function applyWorkflowEvent(run: WorkflowRunView, event: WorkflowDomainEventView): WorkflowRunView | undefined {
  switch (event.type) {
    case "stage.started":
      return {
        ...run,
        ...(event.stageId !== undefined ? { currentStage: event.stageId } : {}),
        status: run.status === "pending" ? "running" : run.status,
        progress: null,
        // 前端富化字段：当前 stage 的开始时间（SSE 事件 ts；用于阶段耗时展示）
        currentStageStartedAt: event.ts,
        updatedAt: event.ts,
      };
    case "stage.progress":
      return {
        ...run,
        progress: {
          stageId: event.stageId ?? run.currentStage ?? "",
          data: event.data ?? {},
          updatedAt: event.ts,
        },
        updatedAt: event.ts,
      };
    case "stage.completed":
      return {
        ...run,
        completedStages: [...new Set([...(run.completedStages ?? []), event.stageId ?? ""])].filter(
          (id) => id !== "",
        ),
        progress: null,
        updatedAt: event.ts,
      };
    case "workflow.resumed":
      return { ...run, status: "running", awaiting: null, updatedAt: event.ts };
    default:
      // awaiting_input（含 payload 的权威状态）与终态（finishedAt / completion /
      // error）经 invalidate + GET 恢复，避免前端拼装不完整状态
      return undefined;
  }
}

/** SSE 事件流 URL（导出供测试） */
export function workflowEventsUrl(runId: string): string {
  return apiUrl(`/api/runs/${encodeURIComponent(runId)}/events`);
}

export function useWorkflowEvents({ runId, projectId, enabled }: WorkflowEventsOptions): WorkflowEventConnection {
  const queryClient = useQueryClient();
  const [connection, setConnection] = useState<WorkflowEventConnection>("closed");
  const lastSeqRef = useRef(0);

  useEffect(() => {
    lastSeqRef.current = 0;
    if (!enabled || runId === undefined || runId === "") {
      setConnection("closed");
      return;
    }
    setConnection("connecting");
    const source = new EventSource(workflowEventsUrl(runId));
    let closed = false;

    const patchRun = (updater: (run: WorkflowRunView) => WorkflowRunView | undefined) => {
      if (projectId === undefined) {
        return;
      }
      queryClient.setQueryData<WorkflowRunView[]>(queryKeys.projectRuns(projectId), (prev) =>
        prev?.map((run) => {
          if (run.runId !== runId) {
            return run;
          }
          const next = updater(run);
          return next === undefined ? run : next;
        }),
      );
    };

    const invalidateRuns = () => {
      if (projectId !== undefined) {
        void queryClient.invalidateQueries({ queryKey: queryKeys.projectRuns(projectId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.project(projectId) });
        void queryClient.invalidateQueries({ queryKey: queryKeys.projectLists });
      }
    };

    const onEvent = (message: MessageEvent<string>) => {
      const event = parseWorkflowEvent(message.data);
      if (event === null) {
        return;
      }
      // seq 去重：重连后 replay 的历史事件不重复应用
      if (event.seq <= lastSeqRef.current) {
        return;
      }
      lastSeqRef.current = event.seq;

      if (TERMINAL_EVENT_TYPES.has(event.type)) {
        // 终态：关闭连接，取回权威完整状态（finishedAt / completion / error）；
        // review 类 run 结束后报告 / 引用 / 项目状态可能变化，一并失效
        if (projectId !== undefined) {
          const runs = queryClient.getQueryData<WorkflowRunView[]>(queryKeys.projectRuns(projectId));
          if (runs?.some((run) => run.runId === runId && run.workflowKind === "existing_paper_review")) {
            void queryClient.invalidateQueries({ queryKey: queryKeys.paperReview(projectId) });
            void queryClient.invalidateQueries({ queryKey: queryKeys.citations(projectId) });
          }
        }
        invalidateRuns();
        if (!closed) {
          closed = true;
          setConnection("closed");
          source.close();
        }
        return;
      }
      if (event.type === "workflow.awaiting_input") {
        invalidateRuns();
        return;
      }
      patchRun((run) => applyWorkflowEvent(run, event));
    };

    source.onopen = () => {
      if (!closed) {
        setConnection("open");
      }
    };
    source.onerror = () => {
      // EventSource 自动重连（服务端重连后全量 replay + seq 去重幂等）
      if (!closed) {
        setConnection("connecting");
      }
    };
    for (const type of DOMAIN_EVENT_TYPES) {
      source.addEventListener(type, onEvent as EventListener);
    }

    return () => {
      closed = true;
      source.close();
      setConnection("closed");
    };
  }, [runId, projectId, enabled, queryClient]);

  return connection;
}
