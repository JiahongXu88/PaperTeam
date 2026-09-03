import type { Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { GenerationService } from "../src/generation/GenerationService.js";
import { createBackendHttpServer } from "../src/httpServer.js";
import { LatexCompiler, type CommandRunner } from "../src/latex/LatexCompiler.js";
import { ProjectStore } from "../src/project/ProjectStore.js";
import { OpenClawRuntimeAdapter } from "../src/runtime/OpenClawRuntimeAdapter.js";
import type { AgentRuntime, RuntimeHealth } from "../src/runtime/types.js";
import { WriterService } from "../src/writer/WriterService.js";
import {
  createIdeaToPaperDefinition,
  type WorkflowServices,
} from "../src/workflow/definitions.js";
import { WorkflowOrchestrator } from "../src/workflow/WorkflowOrchestrator.js";
import { WorkflowRunStore } from "../src/workflow/runStore.js";
import { defaultHandler, startMockGateway, type MockGateway } from "./helpers/mockGateway.js";

const servers: Server[] = [];
const tempRoots: string[] = [];
const gateways: MockGateway[] = [];
const orchestrators: WorkflowOrchestrator[] = [];

afterAll(async () => {
  await Promise.all([
    ...servers.map((server) => new Promise<void>((resolve) => server.close(() => resolve()))),
    ...tempRoots.map((root) => rm(root, { recursive: true, force: true })),
    ...gateways.map((gateway) => gateway.close()),
    ...orchestrators.map((orchestrator) => orchestrator.close()),
  ]);
});

const LATEX_DOC = [
  "\\documentclass[UTF8]{ctexart}",
  "\\begin{document}",
  "RAG 简介正文。",
  "\\end{document}",
].join("\n");

/** 成功创建 main.pdf 的假 LaTeX runner */
const fakeSuccessfulRunner: CommandRunner = async (command, args) => {
  if (args.includes("--version")) {
    return { code: 0, stdout: `${command} version 1.0`, stderr: "" };
  }
  const outputDir = args.find((arg) => arg.startsWith("-output-directory="));
  if (outputDir === undefined) {
    throw new Error("no output-directory");
  }
  const { writeFile } = await import("node:fs/promises");
  await writeFile(join(outputDir.slice("-output-directory=".length), "main.pdf"), "%PDF-1.5");
  return { code: 0, stdout: "compiled", stderr: "" };
};

/** 编译失败的假 runner */
const fakeFailingRunner: CommandRunner = async (command, args) => {
  if (args.includes("--version")) {
    return { code: 0, stdout: `${command} version 1.0`, stderr: "" };
  }
  return { code: 1, stdout: "! Undefined control sequence.", stderr: "" };
};

describe("Backend HTTP /health（M1 行为保持）", () => {
  it("runtime 健康时返回 200 与结构化状态", async () => {
    const server = await startBackend(healthyRuntime());
    const body = await getJson(server, "/health");

    expect(body.status).toBe("ok");
    expect(body.runtime?.provider).toBe("openclaw");
    expect(body.runtime?.ok).toBe(true);
    expect(body.runtime?.status).toBe("healthy");
    expect(typeof body.runtime?.detail).toBe("string");
    expect(typeof body.runtime?.latencyMs).toBe("number");
    expect(typeof body.runtime?.checkedAt).toBe("string");
  });

  it("runtime 不可用时仍返回 200，但 runtime.ok 为 false", async () => {
    const server = await startBackend({
      ...healthyRuntime(),
      healthCheck: async () => makeHealth(false, "unreachable", "无法连接 Gateway"),
    });
    const body = await getJson(server, "/health");

    expect(body.status).toBe("ok");
    expect(body.runtime?.ok).toBe(false);
    expect(body.runtime?.status).toBe("unreachable");
  });

  it("未知路径返回 404", async () => {
    const server = await startBackend(healthyRuntime());
    const response = await request(server, "GET", "/api/unknown");
    expect(response.status).toBe(404);
  });

  it("/health 只允许 GET/HEAD，POST 返回 405", async () => {
    const server = await startBackend(healthyRuntime());
    const response = await request(server, "POST", "/health", "{}");
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, HEAD");
  });
});

describe("POST /api/projects（项目创建）", () => {
  it("创建成功：返回 201 与项目元数据，目录与 project.json 落盘", async () => {
    const { server, store } = await startApiStack(healthyRuntime());
    const response = await request(server, "POST", "/api/projects", JSON.stringify({ title: "RAG Demo Paper" }));

    expect(response.status).toBe(201);
    const body = JSON.parse(response.text) as { project?: { id?: string; status?: string } };
    expect(body.project?.id).toMatch(/^p-[a-z0-9]{12}$/);
    expect(body.project?.status).toBe("created");

    const metadata = JSON.parse(
      await readFile(join(store.rootDir, body.project!.id!, "project.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(metadata["title"]).toBe("RAG Demo Paper");
  });

  it("缺少 title / 非法 JSON / 非 JSON 对象：返回 400", async () => {
    const { server } = await startApiStack(healthyRuntime());
    expect((await request(server, "POST", "/api/projects", "{}")).status).toBe(400);
    expect((await request(server, "POST", "/api/projects", "not-json")).status).toBe(400);
    expect((await request(server, "POST", "/api/projects", "[1,2]")).status).toBe(400);
    expect((await request(server, "POST", "/api/projects", JSON.stringify({ title: "  " }))).status).toBe(400);
  });

  it("GET /api/projects/:id 返回项目；不存在返回 404", async () => {
    const { server, store } = await startApiStack(healthyRuntime());
    const created = await store.create("查询测试");
    const ok = await request(server, "GET", `/api/projects/${created.id}`);
    expect(ok.status).toBe(200);
    expect((JSON.parse(ok.text) as { project?: { id?: string } }).project?.id).toBe(created.id);

    const missing = await request(server, "GET", "/api/projects/p-doesnotexist");
    expect(missing.status).toBe(404);
    expect((JSON.parse(missing.text) as { error?: { code?: string } }).error?.code).toBe("PROJECT_NOT_FOUND");
  });
});

describe("POST /api/projects/:id/generate（全链路）", () => {
  afterEach(() => {
    // gateway 由 gateways 数组统一回收
  });

  it("成功路径：HTTP → Project → Writer → runAgent(WS mock Gateway) → main.tex → 编译(mock) → 200", async () => {
    const gateway = await startMockGateway({
      handler: (method, params) => {
        if (method === "agent") {
          // 2026.8.1 官方验收 payload（status=accepted + acceptedAt）
          return {
            ok: true,
            payload: {
              runId: "run-http-1",
              sessionKey: "agent:writer:paperteam-s-http",
              agentId: "writer",
              status: "accepted",
              acceptedAt: Date.now(),
            },
          };
        }
        if (method === "agent.wait") {
          return { ok: true, payload: { runId: "run-http-1", status: "ok" } };
        }
        if (method === "chat.history") {
          return { ok: true, payload: { messages: [{ role: "assistant", text: LATEX_DOC }] } };
        }
        return defaultHandler()(method, params);
      },
    });
    gateways.push(gateway);

    const runtime = new OpenClawRuntimeAdapter({
      baseUrl: gateway.httpUrl,
      rpcTimeoutMs: 2_000,
      log: () => {},
    });
    const { server, store } = await startApiStack(runtime, { latexRunner: fakeSuccessfulRunner });
    const created = await store.create("全链路测试");

    const response = await request(
      server,
      "POST",
      `/api/projects/${created.id}/generate`,
      JSON.stringify({ prompt: "写一篇关于 RAG 的简短中文学术文章" }),
    );

    expect(response.status).toBe(200);
    const body = JSON.parse(response.text) as {
      projectId?: string;
      taskId?: string;
      mainTexPath?: string;
      compile?: { ok?: boolean; tool?: string; pdfPath?: string };
    };
    expect(body.projectId).toBe(created.id);
    expect(body.taskId).toBe("run-http-1");
    expect(body.mainTexPath).toBe("manuscript/main.tex");
    expect(body.compile?.ok).toBe(true);
    expect(body.compile?.pdfPath).toBe("build/paper.pdf");

    // main.tex 与 paper.pdf 真实落盘
    const tex = await readFile(join(store.rootDir, created.id, "manuscript", "main.tex"), "utf8");
    expect(tex).toContain("\\documentclass[UTF8]{ctexart}");
    const pdf = await readFile(join(store.rootDir, created.id, "build", "paper.pdf"), "utf8");
    expect(pdf).toContain("%PDF-1.5");
    // 项目状态已更新
    expect((await store.get(created.id))?.status).toBe("generated");
    // Gateway 收到的 writer prompt 含用户任务
    const agentRequest = gateway.requests.find((request) => request.method === "agent");
    expect((agentRequest?.params["message"] as string)).toContain("RAG");
    // M2.1 会话映射：按 projectId 派生 sessionKey，成功后写回 project.json
    expect(agentRequest?.params["sessionKey"]).toBe(`agent:writer:paperteam-${created.id}`);
    const persisted = await store.get(created.id);
    expect(persisted?.runtimeSessionKey).toBe("agent:writer:paperteam-s-http");
  });

  it("会话连续性：第二次 generate 复用 project.json 中持久化的 runtimeSessionKey", async () => {
    const seenSessionKeys: string[] = [];
    const gateway = await startMockGateway({
      handler: (method, params) => {
        if (method === "agent") {
          const key = String(params["sessionKey"] ?? "");
          seenSessionKeys.push(key);
          return {
            ok: true,
            payload: {
              runId: `run-http-${seenSessionKeys.length}`,
              sessionKey: key,
              agentId: "writer",
              status: "accepted",
              acceptedAt: Date.now(),
            },
          };
        }
        if (method === "agent.wait") {
          return { ok: true, payload: { status: "ok" } };
        }
        if (method === "chat.history") {
          return { ok: true, payload: { messages: [{ role: "assistant", text: LATEX_DOC }] } };
        }
        return defaultHandler()(method, params);
      },
    });
    gateways.push(gateway);

    const runtime = new OpenClawRuntimeAdapter({
      baseUrl: gateway.httpUrl,
      rpcTimeoutMs: 2_000,
      log: () => {},
    });
    const { server, store } = await startApiStack(runtime, { latexRunner: fakeSuccessfulRunner });
    const created = await store.create("会话连续性测试");

    for (const prompt of ["第一轮：引言", "第二轮：结论"]) {
      const response = await request(
        server,
        "POST",
        `/api/projects/${created.id}/generate`,
        JSON.stringify({ prompt }),
      );
      expect(response.status).toBe(200);
    }

    // 第一轮：按 projectId 派生；第二轮：复用第一轮网关返回并持久化的 key
    expect(seenSessionKeys).toEqual([
      `agent:writer:paperteam-${created.id}`,
      `agent:writer:paperteam-${created.id}`,
    ]);
    expect((await store.get(created.id))?.runtimeSessionKey).toBe(
      `agent:writer:paperteam-${created.id}`,
    );
  });

  it("Agent 失败（Gateway RPC 错误）：返回 502 AGENT_RUN_FAILED，项目状态 failed", async () => {
    const gateway = await startMockGateway({
      handler: (method, params) => {
        if (method === "agent") {
          return { ok: false, error: { code: "INVALID_REQUEST", message: "agent not found: writer" } };
        }
        return defaultHandler()(method, params);
      },
    });
    gateways.push(gateway);

    const runtime = new OpenClawRuntimeAdapter({
      baseUrl: gateway.httpUrl,
      rpcTimeoutMs: 2_000,
      log: () => {},
    });
    const { server, store } = await startApiStack(runtime, { latexRunner: fakeSuccessfulRunner });
    const created = await store.create("Agent 失败测试");

    const response = await request(
      server,
      "POST",
      `/api/projects/${created.id}/generate`,
      JSON.stringify({ prompt: "写一篇短文" }),
    );

    expect(response.status).toBe(502);
    const body = JSON.parse(response.text) as { error?: { code?: string } };
    expect(body.error?.code).toBe("AGENT_RUN_FAILED");
    expect((await store.get(created.id))?.status).toBe("failed");
  });

  it("LaTeX 编译失败：HTTP 200 但 compile.ok=false 且带短错误（tex 已落盘）", async () => {
    const { server, store } = await startApiStack(latexRuntime(), { latexRunner: fakeFailingRunner });
    const created = await store.create("编译失败测试");

    const response = await request(
      server,
      "POST",
      `/api/projects/${created.id}/generate`,
      JSON.stringify({ prompt: "写一篇短文" }),
    );

    expect(response.status).toBe(200);
    const body = JSON.parse(response.text) as { compile?: { ok?: boolean; error?: string } };
    expect(body.compile?.ok).toBe(false);
    expect(body.compile?.error).toContain("Undefined control sequence");
    // main.tex 已写入
    const tex = await readFile(join(store.rootDir, created.id, "manuscript", "main.tex"), "utf8");
    expect(tex).toContain("\\documentclass");
    expect((await store.get(created.id))?.status).toBe("failed");
  });

  it("项目不存在：返回 404 PROJECT_NOT_FOUND", async () => {
    const { server } = await startApiStack(healthyRuntime());
    const response = await request(
      server,
      "POST",
      "/api/projects/p-nosuchproject/generate",
      JSON.stringify({ prompt: "写" }),
    );
    expect(response.status).toBe(404);
    expect((JSON.parse(response.text) as { error?: { code?: string } }).error?.code).toBe("PROJECT_NOT_FOUND");
  });

  it("缺少 prompt：返回 400", async () => {
    const { server, store } = await startApiStack(healthyRuntime());
    const created = await store.create("缺 prompt");
    const response = await request(
      server,
      "POST",
      `/api/projects/${created.id}/generate`,
      JSON.stringify({ prompt: "" }),
    );
    expect(response.status).toBe(400);
  });
});

// ---- 测试辅助 ----

function healthyRuntime(): AgentRuntime {
  return {
    provider: "openclaw",
    healthCheck: async () => makeHealth(true, "healthy", "Gateway 在线"),
    runAgent: () => {
      throw new Error("not implemented");
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
}

/** 返回固定 LaTeX 的假 Runtime（不经过 WebSocket） */
function latexRuntime(): AgentRuntime {
  return {
    ...healthyRuntime(),
    runAgent: async () => {
      const now = new Date().toISOString();
      return {
        taskId: "run-fake-1",
        agentId: "writer",
        status: "completed" as const,
        createdAt: now,
        updatedAt: now,
        output: LATEX_DOC,
      };
    },
  };
}

function makeHealth(
  ok: boolean,
  status: RuntimeHealth["status"],
  detail: string,
): RuntimeHealth {
  return {
    ok,
    provider: "openclaw",
    status,
    detail,
    latencyMs: ok ? 12 : null,
    checkedAt: new Date().toISOString(),
  };
}

interface ApiStack {
  server: Server;
  store: ProjectStore;
}

async function startApiStack(
  runtime: AgentRuntime,
  options: { latexRunner?: CommandRunner } = {},
): Promise<ApiStack> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-api-"));
  tempRoots.push(root);
  const store = new ProjectStore({ root });
  const writer = new WriterService({ runtime, agentId: "writer", log: () => {} });
  const latex = new LatexCompiler({
    timeoutMs: 5_000,
    runner: options.latexRunner ?? fakeSuccessfulRunner,
  });
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
  return { server, store };
}

async function startBackend(runtime: AgentRuntime): Promise<Server> {
  const stack = await startApiStack(runtime);
  return stack.server;
}

async function request(
  server: Server,
  method: string,
  path: string,
  body?: string,
): Promise<{ status: number; headers: Headers; text: string }> {
  const { port } = server.address() as { port: number };
  const response = await fetch(`http://127.0.0.1:${port}${path}`, {
    method,
    ...(body !== undefined
      ? { body, headers: { "Content-Type": "application/json" } }
      : {}),
  });
  return {
    status: response.status,
    headers: response.headers,
    text: await response.text(),
  };
}

interface HealthResponseBody {
  status?: string;
  runtime?: {
    provider?: string;
    ok?: boolean;
    status?: string;
    detail?: string;
    latencyMs?: number | null;
    checkedAt?: string;
  };
}

async function getJson(server: Server, path: string): Promise<HealthResponseBody> {
  const response = await request(server, "GET", path);
  expect(response.status).toBe(200);
  expect(response.headers.get("content-type")).toContain("application/json");
  return JSON.parse(response.text) as HealthResponseBody;
}
