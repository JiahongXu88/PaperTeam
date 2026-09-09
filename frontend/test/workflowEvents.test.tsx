import { describe, expect, it, vi, beforeEach, afterEach } from "vitest";
import { act, render } from "@testing-library/react";

import { applyWorkflowEvent, parseWorkflowEvent, workflowEventsUrl, useWorkflowEvents } from "../src/hooks/workflowEvents.js";
import { queryKeys } from "../src/hooks/queries.js";
import { createTestQueryClient } from "./helpers.js";
import { QueryClientProvider } from "@tanstack/react-query";
import type { WorkflowRunView } from "../src/types/api.js";

/**
 * Workflow SSE 数据层：
 * - parseWorkflowEvent 防御性解析
 * - applyWorkflowEvent 纯函数（stage.started / progress / completed / resumed）
 * - useWorkflowEvents：seq 去重（重连 replay 不重复应用）、终态关闭连接
 */

const baseRun: WorkflowRunView = {
  runId: "w-sse0001",
  projectId: "p-sse0001",
  workflowKind: "existing_paper_review",
  status: "running",
  currentStage: "review.sections",
  createdAt: "2026-09-09T00:00:00.000Z",
  updatedAt: "2026-09-09T00:00:00.000Z",
  awaiting: null,
  error: null,
  completion: null,
  progress: null,
};

describe("parseWorkflowEvent", () => {
  it("解析合法事件；损坏 JSON / 缺字段返回 null", () => {
    const event = parseWorkflowEvent(JSON.stringify({ seq: 3, type: "stage.progress", runId: "w", projectId: "p", ts: "t" }));
    expect(event?.seq).toBe(3);
    expect(parseWorkflowEvent("not json")).toBeNull();
    expect(parseWorkflowEvent(JSON.stringify({ type: "x" }))).toBeNull();
  });
});

describe("applyWorkflowEvent", () => {
  it("stage.progress 更新 progress 快照与 updatedAt", () => {
    const next = applyWorkflowEvent(baseRun, {
      seq: 5,
      type: "stage.progress",
      runId: "w-sse0001",
      projectId: "p-sse0001",
      stageId: "review.sections",
      data: { completed: 17, total: 33, started: 20, failed: 0, retried: 1, findings: 42 },
      ts: "2026-09-09T00:01:00.000Z",
    });
    expect(next?.progress?.data["completed"]).toBe(17);
    expect(next?.progress?.updatedAt).toBe("2026-09-09T00:01:00.000Z");
  });

  it("stage.completed 去重并入 completedStages，清空 progress", () => {
    const running: WorkflowRunView = {
      ...baseRun,
      completedStages: ["paper.ensure"],
      progress: { stageId: "citation.extract", data: {}, updatedAt: "t" },
    };
    const next = applyWorkflowEvent(running, {
      seq: 6,
      type: "stage.completed",
      runId: "w-sse0001",
      projectId: "p-sse0001",
      stageId: "citation.extract",
      ts: "t2",
    });
    expect(next?.completedStages).toEqual(["paper.ensure", "citation.extract"]);
    expect(next?.progress).toBeNull();
    // 同一 stage 重复完成事件不重复追加
    const again = applyWorkflowEvent(next!, {
      seq: 7,
      type: "stage.completed",
      runId: "w-sse0001",
      projectId: "p-sse0001",
      stageId: "citation.extract",
      ts: "t3",
    });
    expect(again?.completedStages).toEqual(["paper.ensure", "citation.extract"]);
  });

  it("stage.started 更新 currentStage 与富化字段 currentStageStartedAt", () => {
    const next = applyWorkflowEvent(baseRun, {
      seq: 2,
      type: "stage.started",
      runId: "w-sse0001",
      projectId: "p-sse0001",
      stageId: "review.aggregate",
      ts: "2026-09-09T00:02:00.000Z",
    });
    expect(next?.currentStage).toBe("review.aggregate");
    expect(next?.currentStageStartedAt).toBe("2026-09-09T00:02:00.000Z");
  });

  it("awaiting / 终态事件返回 undefined（由 invalidate 处理）", () => {
    expect(
      applyWorkflowEvent(baseRun, { seq: 9, type: "workflow.awaiting_input", runId: "w", projectId: "p", ts: "t" }),
    ).toBeUndefined();
    expect(
      applyWorkflowEvent(baseRun, { seq: 10, type: "workflow.cancelled", runId: "w", projectId: "p", ts: "t" }),
    ).toBeUndefined();
  });
});

// ---- useWorkflowEvents hook（Fake EventSource） ----

interface Emit {
  (type: string, payload: Record<string, unknown>): void;
}

class FakeEventSource {
  static instances: FakeEventSource[] = [];
  readonly url: string;
  onopen: (() => void) | null = null;
  onerror: (() => void) | null = null;
  closed = false;
  private listeners = new Map<string, Array<(message: { data: string }) => void>>();

  constructor(url: string) {
    this.url = url;
    FakeEventSource.instances.push(this);
  }

  addEventListener(type: string, listener: (message: { data: string }) => void): void {
    const list = this.listeners.get(type) ?? [];
    list.push(listener);
    this.listeners.set(type, list);
  }

  close(): void {
    this.closed = true;
  }

  emit: Emit = (type, payload) => {
    for (const listener of this.listeners.get(type) ?? []) {
      listener({ data: JSON.stringify({ runId: "w-sse0001", projectId: "p-sse0001", ts: "t", ...payload, type }) });
    }
  };
}

function renderHookProbe(options: Parameters<typeof useWorkflowEvents>[0], client: ReturnType<typeof createTestQueryClient>) {
  const states: string[] = [];
  function Probe() {
    states.push(useWorkflowEvents(options));
    return null;
  }
  render(
    <QueryClientProvider client={client}>
      <Probe />
    </QueryClientProvider>,
  );
  return states;
}

describe("useWorkflowEvents", () => {
  beforeEach(() => {
    FakeEventSource.instances = [];
    vi.stubGlobal("EventSource", FakeEventSource);
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("连接 SSE、按事件更新 run 缓存；重复 seq 不重复应用", () => {
    const client = createTestQueryClient();
    client.setQueryData(queryKeys.projectRuns("p-sse0001"), [structuredClone(baseRun)]);
    const states = renderHookProbe({ runId: "w-sse0001", projectId: "p-sse0001", enabled: true }, client);
    const source = FakeEventSource.instances.at(-1)!;
    expect(source.url).toBe(workflowEventsUrl("w-sse0001"));

    act(() => {
      source.onopen?.();
      source.emit("stage.progress", { seq: 5, stageId: "review.sections", data: { completed: 17, total: 33, started: 20 } });
    });
    expect(states.at(-1)).toBe("open");
    let run = client.getQueryData<WorkflowRunView[]>(queryKeys.projectRuns("p-sse0001"))![0]!;
    expect(run.progress?.data["completed"]).toBe(17);

    // 重连 replay 的重复 seq（<= 已见 max）被忽略：progress 不被旧快照覆盖
    act(() => {
      source.emit("stage.progress", { seq: 4, stageId: "review.sections", data: { completed: 2, total: 33 } });
    });
    run = client.getQueryData<WorkflowRunView[]>(queryKeys.projectRuns("p-sse0001"))![0]!;
    expect(run.progress?.data["completed"]).toBe(17);

    act(() => {
      source.emit("stage.completed", { seq: 6, stageId: "review.sections" });
    });
    run = client.getQueryData<WorkflowRunView[]>(queryKeys.projectRuns("p-sse0001"))![0]!;
    expect(run.completedStages).toContain("review.sections");
    // 同 seq 再次到达不重复
    act(() => {
      source.emit("stage.completed", { seq: 6, stageId: "review.sections" });
    });
    run = client.getQueryData<WorkflowRunView[]>(queryKeys.projectRuns("p-sse0001"))![0]!;
    expect(run.completedStages?.filter((id) => id === "review.sections")).toHaveLength(1);
  });

  it("终态事件关闭连接；enabled=false 不建立连接", () => {
    const client = createTestQueryClient();
    client.setQueryData(queryKeys.projectRuns("p-sse0001"), [structuredClone(baseRun)]);
    renderHookProbe({ runId: "w-sse0001", projectId: "p-sse0001", enabled: true }, client);
    const source = FakeEventSource.instances.at(-1)!;
    act(() => {
      source.emit("workflow.cancelled", { seq: 9 });
    });
    expect(source.closed).toBe(true);

    renderHookProbe({ runId: "w-sse0001", projectId: "p-sse0001", enabled: false }, client);
    expect(FakeEventSource.instances).toHaveLength(1);
  });
});
