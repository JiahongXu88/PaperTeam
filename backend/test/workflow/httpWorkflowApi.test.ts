/**
 * WorkflowRun 异步 API + SSE 测试（M3.0）。
 *
 * 覆盖：POST /workflows 创建、GET /api/runs 状态轮询与列表、
 * 404/409 错误映射、协作式取消、SSE（实时订阅 + 完成后 replay + 断开清理）。
 * Stage 执行走 idea_to_paper（M3.0 最小形态：GenerationService 单 stage），
 * Runtime 使用注入式 fake（不依赖 Gateway）。
 */

import { get as httpGet, type ClientRequest } from "node:http";
import type { Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { GenerationService } from "../../src/generation/GenerationService.js";
import { createBackendHttpServer } from "../../src/httpServer.js";
import { LatexCompiler, type CommandRunner } from "../../src/latex/LatexCompiler.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";
import type { AgentRuntime, AgentTask, RuntimeHealth } from "../../src/runtime/types.js";
import { WriterService } from "../../src/writer/WriterService.js";
import {
  createIdeaToPaperDefinition,
  type WorkflowServices,
} from "../../src/workflow/definitions.js";
import { WorkflowOrchestrator } from "../../src/workflow/WorkflowOrchestrator.js";
import { WorkflowRunStore } from "../../src/workflow/runStore.js";
import type { WorkflowState } from "../../src/workflow/types.js";

const servers: Server[] = [];
const tempRoots: string[] = [];
const orchestrators: WorkflowOrchestrator[] = [];

afterAll(async () => {
  await Promise.all([
    ...servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    ...tempRoots.map((root) => rm(root, { recursive: true, force: true })),
    ...orchestrators.map((orchestrator) => orchestrator.close()),
  ]);
});

const LATEX_DOC = [
  "\\documentclass[UTF8]{ctexart}",
  "\\begin{document}",
  "异步 workflow 测试正文。",
  "\\end{document}",
].join("\n");

/** 可控 fake runtime：runAgent 挂起直到 release()（测试取消/并发拒绝） */
function controllableRuntime(): { runtime: AgentRuntime; release: () => void } {
  let releaseCurrent: (() => void) | undefined;
  let calls = 0;
  const runtime: AgentRuntime = {
    provider: "openclaw",
    healthCheck: async () => makeHealth(true),
    runAgent: async () => {
      calls += 1;
      await new Promise<void>((resolve) => {
        releaseCurrent = resolve;
      });
      const now = new Date().toISOString();
      const task: AgentTask = {
        taskId: `run-fake-${calls}`,
        agentId: "writer",
        status: "completed",
        createdAt: now,
        updatedAt: now,
        output: LATEX_DOC,
      };
      return task;
    },
    getTask: () => {
      throw new Error("not implemented");
    },
    cancelTask: () => {
      throw new Error("not implemented");
    },
    sendMessage: () => {
      throw new Error("not implemented");
    },
    streamEvents: () => {
      throw new Error("not implemented");
    },
  };
  return { runtime, release: () => releaseCurrent?.() };
}

/** 立即完成的 fake runtime */
function instantRuntime(): AgentRuntime {
  const now = () => new Date().toISOString();
  return {
    provider: "openclaw",
    healthCheck: async () => makeHealth(true),
    runAgent: async () => ({
      taskId: "run-instant",
      agentId: "writer",
      status: "completed" as const,
      createdAt: now(),
      updatedAt: now(),
      output: LATEX_DOC,
    }),
    getTask: () => {
      throw new Error("not implemented");
    },
    cancelTask: () => {
      throw new Error("not implemented");
    },
    sendMessage: () => {
      throw new Error("not implemented");
    },
    streamEvents: () => {
      throw new Error("not implemented");
    },
  };
}

function makeHealth(ok: boolean): RuntimeHealth {
  return {
    ok,
    provider: "openclaw",
    status: ok ? "healthy" : "unreachable",
    detail: ok ? "ok" : "down",
    latencyMs: ok ? 5 : null,
    checkedAt: new Date().toISOString(),
  };
}

/** 编译成功且生成 main.pdf 的假 runner */
const fakeRunner: CommandRunner = async (command, args) => {
  if (args.includes("--version")) {
    return { code: 0, stdout: `${command} 1.0`, stderr: "" };
  }
  const outputDir = args.find((arg) => arg.startsWith("-output-directory="));
  if (outputDir) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(outputDir.slice("-output-directory=".length), "main.pdf"), "%PDF-1.5");
  }
  return { code: 0, stdout: "compiled", stderr: "" };
};

async function startStack(runtime: AgentRuntime): Promise<{
  server: Server;
  store: ProjectStore;
  orchestrator: WorkflowOrchestrator;
}> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-wf-api-"));
  tempRoots.push(root);
  const store = new ProjectStore({ root });
  const writer = new WriterService({ runtime, agentId: "writer", log: () => {} });
  const latex = new LatexCompiler({ timeoutMs: 5_000, runner: fakeRunner });
  const generation = new GenerationService({ projects: store, writer, latex, log: () => {} });
  const workflowServices: WorkflowServices = {
    projects: store,
    generation,
    stageTimeoutMs: 10_000,
    stageMaxAttempts: 2,
  };
  const orchestrator = new WorkflowOrchestrator({
    projects: store,
    runStore: new WorkflowRunStore(store),
    definitionFactory: (kind) => {
      if (kind !== "idea_to_paper") {
        throw new Error(`unexpected kind: ${kind}`);
      }
      return createIdeaToPaperDefinition(workflowServices);
    },
    retryDelayMs: 0,
    log: () => {},
  });
  orchestrators.push(orchestrator);
  const server = createBackendHttpServer({ runtime, projects: store, generation, orchestrator });
  servers.push(server);
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  return { server, store, orchestrator };
}

function portOf(server: Server): number {
  return (server.address() as { port: number }).port;
}

async function requestJson(
  server: Server,
  method: string,
  path: string,
  body?: unknown,
): Promise<{ status: number; body: Record<string, unknown> }> {
  const response = await fetch(`http://127.0.0.1:${portOf(server)}${path}`, {
    method,
    ...(body !== undefined
      ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
      : {}),
  });
  return { status: response.status, body: (await response.json()) as Record<string, unknown> };
}

async function pollRun(
  server: Server,
  runId: string,
  statuses: string[],
  timeoutMs = 5_000,
): Promise<WorkflowState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await requestJson(server, "GET", `/api/runs/${runId}`);
    const run = body["run"] as WorkflowState;
    if (statuses.includes(run.status)) {
      return run;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 run 状态 ${statuses.join("|")} 超时（当前 ${run.status}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

interface SseEvent {
  id: number;
  event: string;
  data: Record<string, unknown>;
}

/** 订阅 SSE 并收集事件，直到满足条件或超时 */
function collectSse(
  server: Server,
  runId: string,
  until: (events: SseEvent[]) => boolean,
  timeoutMs = 5_000,
): { promise: Promise<SseEvent[]>; abort: () => void } {
  let req: ClientRequest | undefined;
  const promise = new Promise<SseEvent[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      req?.destroy();
      reject(new Error("SSE 收集超时"));
    }, timeoutMs);
    req = httpGet(`http://127.0.0.1:${portOf(server)}/api/runs/${runId}/events`, (res) => {
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
        if (until(events)) {
          clearTimeout(timer);
          req?.destroy();
          resolve(events);
        }
      });
    });
    req.on("error", () => {
      /* destroy 触发；忽略 */
    });
  });
  return { promise, abort: () => req?.destroy() };
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
          id: Number(idLine.slice(4)),
          event: eventLine.slice(7),
          data: JSON.parse(dataLine.slice(6)) as Record<string, unknown>,
        });
      } catch {
        // 非完整块；跳过
      }
    }
  }
  return events;
}

// ---- 测试 ----

describe("POST /api/projects/:id/workflows（异步 run 创建）", () => {
  it("创建返回 202 + runId；轮询到 completed；main.tex 与 checkpoint 落盘", async () => {
    const { server, store } = await startStack(instantRuntime());
    const project = await store.create("异步工作流测试");

    const created = await requestJson(server, "POST", `/api/projects/${project.id}/workflows`, {
      kind: "idea_to_paper",
      prompt: "写一篇关于检索增强生成的短文",
    });
    expect(created.status).toBe(202);
    // 循环在返回前即启动，pending → running 的跃迁可能已发生（两者都合法）
    expect(["pending", "running"]).toContain(created.body["status"]);
    const runId = created.body["runId"] as string;
    expect(runId).toMatch(/^w-[a-z0-9-]+$/);

    const finished = await pollRun(server, runId, ["completed"]);
    expect(finished.completedStages).toEqual(["writing.document"]);
    expect(finished.completion?.label).toBe("draft");

    const tex = await readFile(join(store.rootDir, project.id, "manuscript", "main.tex"), "utf8");
    expect(tex).toContain("\\documentclass");
    const checkpoint = await readFile(
      join(store.rootDir, project.id, "workflow", "runs", runId, "checkpoint.json"),
      "utf8",
    );
    expect(JSON.parse(checkpoint).status).toBe("completed");
  });

  it("非法 kind 返回 400；未知项目 404", async () => {
    const { server, store } = await startStack(instantRuntime());
    const project = await store.create("参数校验");
    const bad = await requestJson(server, "POST", `/api/projects/${project.id}/workflows`, {
      kind: "bogus",
    });
    expect(bad.status).toBe(400);
    const missing = await requestJson(server, "POST", "/api/projects/p-nosuch/workflows", {});
    expect(missing.status).toBe(404);
  });

  it("进行中的 run 存在时再创建返回 409；run 列表可见", async () => {
    const controlled = controllableRuntime();
    const { server, store } = await startStack(controlled.runtime);
    const project = await store.create("并发拒绝测试");

    const first = await requestJson(server, "POST", `/api/projects/${project.id}/workflows`, {});
    expect(first.status).toBe(202);
    // 等 runtime 被调用（stage 执行中）
    await new Promise((resolve) => setTimeout(resolve, 100));

    const second = await requestJson(server, "POST", `/api/projects/${project.id}/workflows`, {});
    expect(second.status).toBe(409);
    expect((second.body["error"] as { code?: string }).code).toBe("WORKFLOW_INVALID_STATE");

    const list = await requestJson(server, "GET", `/api/runs?projectId=${project.id}`);
    const runs = list.body["runs"] as WorkflowState[];
    expect(runs).toHaveLength(1);

    controlled.release();
    await pollRun(server, first.body["runId"] as string, ["completed"]);
  });
});

describe("GET /api/runs/:runId 与错误映射", () => {
  it("未知 run 返回 404 WORKFLOW_NOT_FOUND", async () => {
    const { server } = await startStack(instantRuntime());
    const missing = await requestJson(server, "GET", "/api/runs/w-nosuch");
    expect(missing.status).toBe(404);
    expect((missing.body["error"] as { code?: string }).code).toBe("WORKFLOW_NOT_FOUND");
  });

  it("resume 非 awaiting_input 状态返回 409", async () => {
    const { server, store } = await startStack(instantRuntime());
    const project = await store.create("resume 状态校验");
    const created = await requestJson(server, "POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;
    await pollRun(server, runId, ["completed"]);

    const resumed = await requestJson(server, "POST", `/api/runs/${runId}/resume`, {
      decision: "approve",
    });
    expect(resumed.status).toBe(409);
  });

  it("对已完成 run 取消返回 409", async () => {
    const { server, store } = await startStack(instantRuntime());
    const project = await store.create("cancel 状态校验");
    const created = await requestJson(server, "POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;
    await pollRun(server, runId, ["completed"]);

    const cancelled = await requestJson(server, "POST", `/api/runs/${runId}/cancel`, {});
    expect(cancelled.status).toBe(409);
  });
});

describe("POST /api/runs/:runId/cancel（协作式取消）", () => {
  it("执行中取消：请求登记后 run 在边界转为 cancelled；事件流有 workflow.cancelled", async () => {
    const controlled = controllableRuntime();
    const { server, store } = await startStack(controlled.runtime);
    const project = await store.create("取消测试");

    const created = await requestJson(server, "POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;
    await new Promise((resolve) => setTimeout(resolve, 100)); // stage 执行中

    const cancelResponse = await requestJson(server, "POST", `/api/runs/${runId}/cancel`, {});
    expect(cancelResponse.status).toBe(200);

    controlled.release(); // stage 返回（协作式：不强行中断 Agent）
    const finished = await pollRun(server, runId, ["cancelled"]);
    expect(finished.status).toBe("cancelled");
  });
});

describe("GET /api/runs/:runId/events（SSE）", () => {
  it("实时订阅：收到 workflow.started → stage.* → workflow.completed", async () => {
    const controlled = controllableRuntime();
    const { server, store } = await startStack(controlled.runtime);
    const project = await store.create("SSE 实时测试");

    const created = await requestJson(server, "POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;

    const collector = collectSse(
      server,
      runId,
      (events) => events.some((event) => event.event === "workflow.completed"),
    );
    // 让 stage 推进
    await new Promise((resolve) => setTimeout(resolve, 100));
    controlled.release();

    const events = await collector.promise;
    const types = events.map((event) => event.event);
    expect(types).toContain("workflow.started");
    expect(types).toContain("stage.started");
    expect(types).toContain("stage.completed");
    expect(types[types.length - 1]).toBe("workflow.completed");
    // seq 单调递增
    const ids = events.map((event) => event.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it("完成后连接：replay 全部历史事件（客户端断开不影响已完成的 workflow）", async () => {
    const { server, store } = await startStack(instantRuntime());
    const project = await store.create("SSE replay 测试");
    const created = await requestJson(server, "POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;
    await pollRun(server, runId, ["completed"]);

    const collector = collectSse(
      server,
      runId,
      (events) => events.some((event) => event.event === "workflow.completed"),
    );
    const events = await collector.promise;
    expect(events.length).toBeGreaterThanOrEqual(4);
    expect(events[0]?.event).toBe("workflow.started");
  });

  it("未知 run 的 SSE 返回 404 JSON（不进入事件流）", async () => {
    const { server } = await startStack(instantRuntime());
    const response = await fetch(`http://127.0.0.1:${portOf(server)}/api/runs/w-nosuch/events`);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    await response.text();
  });
});
