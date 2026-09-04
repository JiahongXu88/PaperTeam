import type { Server } from "node:http";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, afterEach, describe, expect, it } from "vitest";

import { createBackendHttpServer } from "../src/httpServer.js";
import { LatexCompiler, type CommandRunner } from "../src/latex/LatexCompiler.js";
import { ProjectStore } from "../src/project/ProjectStore.js";
import { AgentRunFailedError } from "../src/errors.js";
import type {
  AgentRuntime,
  AgentRunHandle,
  AgentTask,
  RunAgentInput,
  RuntimeHealth,
} from "../src/runtime/types.js";
import { buildServiceStack } from "../src/serviceStack.js";
import { createIdeaToPaperDefinition } from "../src/workflow/definitions.js";
import { WorkflowOrchestrator } from "../src/workflow/WorkflowOrchestrator.js";
import { WorkflowRunStore } from "../src/workflow/runStore.js";

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
    expect(body.runtime?.provider).toBe("pi");
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

describe("GET /api/projects（项目列表，M4.0）", () => {
  it("无项目时返回空数组", async () => {
    const { server } = await startApiStack(healthyRuntime());
    const response = await request(server, "GET", "/api/projects");
    expect(response.status).toBe(200);
    expect(JSON.parse(response.text) as { projects?: unknown[] }).toMatchObject({ projects: [] });
  });

  it("返回全部项目元数据，updatedAt 非升序（最近更新在前）", async () => {
    const { server, store } = await startApiStack(healthyRuntime());
    const first = await store.create("第一个项目");
    const second = await store.create("第二个项目", { researchField: "计算机科学" });
    await store.updateMeta(first.id, { targetVenue: "SIGIR" }); // bump updatedAt

    const response = await request(server, "GET", "/api/projects");
    expect(response.status).toBe(200);
    const { projects } = JSON.parse(response.text) as {
      projects?: Array<{ id?: string; updatedAt?: string; researchField?: string }>;
    };
    expect(projects?.map((p) => p.id).sort()).toEqual([first.id, second.id].sort());
    expect(projects?.find((p) => p.id === second.id)?.researchField).toBe("计算机科学");
    // 响应整体按 updatedAt 降序（自洽校验，不依赖时钟精度）
    const updateds = (projects ?? []).map((p) => p.updatedAt ?? "");
    expect([...updateds].sort((a, b) => b.localeCompare(a))).toEqual(updateds);
  });

  it("GET 以外的方法返回 405（Allow: GET, POST）", async () => {
    const { server } = await startApiStack(healthyRuntime());
    const response = await request(server, "PUT", "/api/projects", "{}");
    expect(response.status).toBe(405);
    expect(response.headers.get("allow")).toBe("GET, POST");
  });
});

describe("POST /api/projects/:id/generate（全链路）", () => {
  it("成功路径：HTTP → Project → Writer → runAgent(脚本化 Runtime) → main.tex → 编译(mock) → 200", async () => {
    const runtime = recordingLatexRuntime();
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
    // Runtime 收到的 writer prompt 含用户任务
    expect(runtime.calls[0]?.task).toContain("RAG");
    // 会话映射：首次调用不透传（Runtime 侧按 projectId 派生并在 metadata 回显），
    // 成功后派生 key 写回 project.json
    expect(runtime.calls[0]?.sessionKey).toBeUndefined();
    const persisted = await store.get(created.id);
    expect(persisted?.runtimeSessionKey).toBe(`agent:writer:paperteam-${created.id}`);
  });

  it("会话连续性：第二次 generate 复用 project.json 中持久化的 runtimeSessionKey", async () => {
    const runtime = recordingLatexRuntime();
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

    // 第一轮：透传缺省（undefined，Runtime 侧按 projectId 派生并在 metadata 回显）；
    // 第二轮：复用第一轮 Runtime 返回并持久化的 key（显式透传）
    const derivedKey = `agent:writer:paperteam-${created.id}`;
    expect(runtime.calls.map((call) => call.sessionKey)).toEqual([undefined, derivedKey]);
    expect((await store.get(created.id))?.runtimeSessionKey).toBe(derivedKey);
  });

  it("Agent 失败（Runtime 错误）：返回 502 AGENT_RUN_FAILED，项目状态 failed", async () => {
    const runtime = failingRuntime();
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

/** 记录 runAgent 输入（task / sessionKey 透传）的假 Runtime；返回固定 LaTeX。
 * sessionKey 语义与 PiRuntimeAdapter 对齐：透传优先，否则按 projectId 派生
 * 并在 task.metadata.sessionKey 回显（供 GenerationService 持久化）。 */
function recordingLatexRuntime(): AgentRuntime & {
  calls: { task: string; sessionKey?: string }[];
} {
  const calls: { task: string; sessionKey?: string }[] = [];
  const runtime: AgentRuntime = {
    provider: "pi",
    healthCheck: async () => makeHealth(true, "healthy", "Pi Runtime 正常"),
    startAgent: async (input: RunAgentInput) => {
      calls.push({ task: input.task, sessionKey: input.sessionKey });
      const task = latexTask("run-http-1", input);
      return handleOf(task);
    },
    runAgent: async (input: RunAgentInput) => {
      calls.push({ task: input.task, sessionKey: input.sessionKey });
      return latexTask("run-http-1", input);
    },
    getTask: () => {
      throw new Error("not implemented");
    },
    close: async () => {},
  };
  return Object.assign(runtime, { calls });
}

function latexTask(taskId: string, input: RunAgentInput): AgentTask {
  const now = new Date().toISOString();
  return {
    taskId,
    agentId: input.agentId,
    status: "completed",
    createdAt: now,
    updatedAt: now,
    output: LATEX_DOC,
    metadata: {
      sessionKey: input.sessionKey ?? `agent:writer:paperteam-${input.projectId ?? "adhoc"}`,
    },
  };
}

function handleOf(task: AgentTask): AgentRunHandle {
  return {
    taskId: task.taskId,
    sessionKey: String(task.metadata?.["sessionKey"]),
    events: async function* () {},
    cancel: async () => {},
    result: async () => task,
  };
}

/** runAgent 直接抛业务错误的假 Runtime（模拟 Runtime 不可用 / 拒绝执行） */
function failingRuntime(): AgentRuntime {
  return {
    provider: "pi",
    healthCheck: async () => makeHealth(true, "healthy", "Pi Runtime 正常"),
    startAgent: () => {
      throw new AgentRunFailedError("模型未配置", "not_configured");
    },
    runAgent: () => {
      throw new AgentRunFailedError("模型未配置", "not_configured");
    },
    getTask: () => {
      throw new Error("not implemented");
    },
    close: async () => {},
  };
}

function healthyRuntime(): AgentRuntime {
  return {
    provider: "pi",
    healthCheck: async () => makeHealth(true, "healthy", "Pi Runtime 正常"),
    startAgent: () => {
      throw new Error("not implemented");
    },
    runAgent: () => {
      throw new Error("not implemented");
    },
    getTask: () => {
      throw new Error("not implemented");
    },
    close: async () => {},
  };
}

/** 返回固定 LaTeX 的假 Runtime */
function latexRuntime(): AgentRuntime {
  return {
    ...healthyRuntime(),
    startAgent: async (input: RunAgentInput) => handleOf(latexTask("run-fake-1", input)),
    runAgent: async (input: RunAgentInput) => latexTask("run-fake-1", input),
  };
}

function makeHealth(
  ok: boolean,
  status: RuntimeHealth["status"],
  detail: string,
): RuntimeHealth {
  return {
    ok,
    provider: "pi",
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
  const latex = new LatexCompiler({
    timeoutMs: 5_000,
    runner: options.latexRunner ?? fakeSuccessfulRunner,
  });
  const stack = buildServiceStack({
    runtime,
    projects: store,
    latex,
    agentIds: { writer: "writer", researcher: "researcher", reviewer: "reviewer", citation: "citation" },
    stageTimeoutMs: 10_000,
    stageMaxAttempts: 2,
    log: () => {},
  });
  const orchestrator = new WorkflowOrchestrator({
    projects: store,
    runStore: new WorkflowRunStore(store),
    definitionFactory: (kind) => {
      if (kind !== "idea_to_paper") {
        throw new Error(`unexpected kind: ${kind}`);
      }
      return createIdeaToPaperDefinition(stack.workflowServices);
    },
    retryDelayMs: 0,
    log: () => {},
  });
  orchestrators.push(orchestrator);
  const server = createBackendHttpServer({
    runtime,
    projects: store,
    generation: stack.generation,
    orchestrator,
    stack,
  });
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
