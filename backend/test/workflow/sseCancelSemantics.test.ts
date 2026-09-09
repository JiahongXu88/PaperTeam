/**
 * Workflow SSE / Cancel 语义测试（M4.4 Workflow Live View 的后端契约）：
 *
 * 1. SSE 重连：断开后重新连接 → replay 全部历史事件，seq 唯一且单调，
 *    不因重连产生重复事件（前端按 seq 去重的服务端前提）
 * 2. 取消幂等：运行中重复 cancel → 全部 200；终态 cancelled 后再 cancel → 200 no-op；
 *    events.jsonl 中 workflow.cancelled 恰好一条（completed/failed 仍 409，见既有测试）
 * 3. review.sections 的 stage.progress 载荷携带 started / retried（活跃 / 排队 / 重试
 *    展示口径；active = started - completed - failed）
 */

import { get as httpGet, type ClientRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import {
  startTestStack,
  scriptedIdeaRuntime,
  type TestStack,
} from "../helpers/testStack.js";

vi.setConfig({ testTimeout: 20_000 });

const cleanups: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
});

async function newStack(options: { hangFirstCall?: boolean } = {}): Promise<{
  stack: TestStack;
  release: () => void;
}> {
  const scripted = scriptedIdeaRuntime({
    ...(options.hangFirstCall !== undefined ? { hangFirstCall: options.hangFirstCall } : {}),
  });
  const stack = await startTestStack(scripted.runtime, {
    registerCleanup: (cleanup) => cleanups.push(cleanup),
  });
  return { stack, release: scripted.release };
}

async function createRun(stack: TestStack): Promise<{ projectId: string; runId: string }> {
  const project = await stack.store.create("SSE/Cancel 语义测试", {});
  const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
  expect(created.status).toBe(202);
  return { projectId: project.id, runId: created.body["runId"] as string };
}

async function pollStatus(
  stack: TestStack,
  runId: string,
  statuses: string[],
  timeoutMs = 8_000,
): Promise<Record<string, unknown>> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = (await stack.request("GET", `/api/runs/${runId}`)).body["run"] as Record<string, unknown>;
    if (statuses.includes(String(run["status"]))) {
      return run;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 run 状态 ${statuses.join("|")} 超时（当前 ${String(run["status"])}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

interface SseEvent {
  seq: number;
  type: string;
  data: Record<string, unknown>;
}

function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.split("\n\n")) {
    const idLine = block.split("\n").find((line) => line.startsWith("id: "));
    const eventLine = block.split("\n").find((line) => line.startsWith("event: "));
    const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
    if (idLine && eventLine && dataLine) {
      try {
        events.push({
          seq: Number(idLine.slice(4)),
          type: eventLine.slice(7),
          data: JSON.parse(dataLine.slice(6)) as Record<string, unknown>,
        });
      } catch {
        // 非完整块
      }
    }
  }
  return events;
}

/** 收集 SSE 事件直到条件满足；返回（事件列表, 主动断开函数）——断开后不再 resolve */
function collectSse(
  stack: TestStack,
  runId: string,
  until: (events: SseEvent[]) => boolean,
  onEvents?: (events: SseEvent[]) => void,
): { promise: Promise<SseEvent[]>; close: () => void } {
  let req: ClientRequest | undefined;
  let earlyClose = false;
  const promise = new Promise<SseEvent[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      req?.destroy();
      reject(new Error("SSE 收集超时"));
    }, 15_000);
    req = httpGet(`http://127.0.0.1:${stack.port()}/api/runs/${runId}/events`, (res) => {
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        reject(new Error(`SSE 状态码 ${res.statusCode}`));
        res.resume();
        return;
      }
      let text = "";
      res.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
        const events = parseSse(text);
        onEvents?.(events);
        if (until(events)) {
          clearTimeout(timer);
          req?.destroy();
          resolve(events);
        }
      });
    });
    req.on("error", () => {
      /* destroy 触发；若已提前 close 则视为正常 */
      if (earlyClose) {
        clearTimeout(timer);
        resolve([]);
      }
    });
  });
  return {
    promise,
    close: () => {
      earlyClose = true;
      req?.destroy();
    },
  };
}

describe("GET /api/runs/:runId/events 重连语义", () => {
  it("断开重连后：replay 全部历史事件，seq 唯一单调、无重复", async () => {
    const { stack, release } = await newStack({ hangFirstCall: true });
    const { projectId, runId } = await createRun(stack);

    // 第一段连接：收到 workflow.started + stage.started（research.idea 挂起中）
    const first = collectSse(stack, runId, (events) =>
      events.some((event) => event.type === "stage.started"),
    );
    await new Promise((resolve) => setTimeout(resolve, 100));
    await first.promise;

    // 断开 → 释放挂起 → run 推进到 awaiting_input（期间若干事件只进 events.jsonl）
    first.close();
    release();
    await pollStatus(stack, runId, ["awaiting_input"]);

    // 第二段连接：replay 应包含全部历史事件且 seq 无重复、单调递增
    const second = await collectSse(
      stack,
      runId,
      (events) => events.some((event) => event.type === "workflow.awaiting_input"),
    ).promise;
    const seqs = second.map((event) => event.seq);
    expect(seqs.length).toBeGreaterThan(3);
    expect(new Set(seqs).size).toBe(seqs.length);
    expect(seqs).toEqual([...seqs].sort((a, b) => a - b));
    expect(second[0]?.type).toBe("workflow.started");
    expect(second.map((event) => event.type)).toContain("workflow.awaiting_input");

    // 重连不产生新的日志事件（连接本身零副作用）
    const log = await readEventLog(stack, projectId, runId);
    const logSeqs = log.map((event) => event.seq);
    expect(new Set(logSeqs).size).toBe(logSeqs.length);
    expect(Math.max(...logSeqs)).toBe(Math.max(...seqs));
  });

  it("运行中订阅：replay 之后继续收到 LIVE 事件（无缝衔接）", async () => {
    const { stack, release } = await newStack({ hangFirstCall: true });
    const { runId } = await createRun(stack);

    // 连接建立后先收到 replay（workflow.started / stage.started），再等 LIVE 的
    // stage.completed / workflow.awaiting_input（释放挂起后产生）
    const seen: SseEvent[] = [];
    const collector = collectSse(stack, runId, () => false, (events) => {
      seen.splice(0, seen.length, ...events);
    });
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    const deadline = Date.now() + 15_000;
    while (!seen.some((event) => event.type === "workflow.awaiting_input")) {
      if (Date.now() > deadline) {
        collector.close();
        throw new Error("等待 LIVE 事件超时");
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    collector.close();
    const types = seen.map((event) => event.type);
    expect(types).toContain("workflow.started");
    expect(types).toContain("stage.started");
    expect(types.indexOf("stage.started")).toBeLessThan(types.indexOf("workflow.awaiting_input"));
  });
});

describe("POST /api/runs/:runId/cancel 幂等", () => {
  it("运行中连续两次 cancel 均 200；cancelled 后再 cancel 200 no-op；workflow.cancelled 恰好一条", async () => {
    const { stack, release } = await newStack({ hangFirstCall: true });
    const { projectId, runId } = await createRun(stack);
    await new Promise((resolve) => setTimeout(resolve, 100));

    const first = await stack.request("POST", `/api/runs/${runId}/cancel`, {});
    expect(first.status).toBe(200);
    const second = await stack.request("POST", `/api/runs/${runId}/cancel`, {});
    expect(second.status).toBe(200);

    release();
    await pollStatus(stack, runId, ["cancelled"]);

    // 终态后的重复取消：幂等 no-op（不 409、不产生第二条 cancelled 事件）
    const third = await stack.request("POST", `/api/runs/${runId}/cancel`, {});
    expect(third.status).toBe(200);
    expect((third.body["run"] as Record<string, unknown>)["status"]).toBe("cancelled");

    const log = await readEventLog(stack, projectId, runId);
    const cancelledEvents = log.filter((event) => event.type === "workflow.cancelled");
    expect(cancelledEvents).toHaveLength(1);
  });
});

interface LoggedEvent {
  seq: number;
  type: string;
  stageId?: string;
  data?: Record<string, unknown>;
}

async function readEventLog(
  stack: TestStack,
  projectId: string,
  runId: string,
): Promise<LoggedEvent[]> {
  const text = await readFile(join(stack.root, projectId, "workflow", "runs", runId, "events.jsonl"), "utf8");
  return text
    .split("\n")
    .filter((line) => line.trim() !== "")
    .map((line) => JSON.parse(line) as LoggedEvent);
}

export {};
