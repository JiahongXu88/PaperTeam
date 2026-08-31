import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import { BusinessError, toBusinessError } from "./errors.js";
import type { GenerationService } from "./generation/GenerationService.js";
import type { ProjectStore } from "./project/ProjectStore.js";
import type { AgentRuntime, RuntimeHealth } from "./runtime/types.js";

/**
 * Backend 自身的轻量 HTTP 服务（Node 原生 http，无 Web 框架）。
 *
 * M2 端点：
 *   GET  /health                     存活探针（含 Gateway 实时健康）
 *   POST /api/projects               创建论文项目 {title}
 *   GET  /api/projects/:id           查询项目元数据
 *   POST /api/projects/:id/generate  Writer 写作 + LaTeX 编译 {prompt}
 */

/** 请求体大小上限（字节） */
const MAX_BODY_BYTES = 1024 * 1024;

export interface BackendHttpServerOptions {
  runtime: AgentRuntime;
  projects: ProjectStore;
  generation: GenerationService;
}

export function createBackendHttpServer({
  runtime,
  projects,
  generation,
}: BackendHttpServerOptions): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    handleRequest(req, res, { runtime, projects, generation }).catch((error: unknown) => {
      const businessError = toBusinessError(error);
      if (businessError.code === "INTERNAL_ERROR") {
        console.error("[http] 未处理错误:", error);
      }
      sendBusinessError(res, businessError);
    });
  });
}

interface Services {
  runtime: AgentRuntime;
  projects: ProjectStore;
  generation: GenerationService;
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  services: Services,
): Promise<void> {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  const method = (req.method ?? "GET").toUpperCase();

  // ---- GET /health ----
  if (pathname === "/health") {
    if (method !== "GET" && method !== "HEAD") {
      res.setHeader("Allow", "GET, HEAD");
      sendJson(res, 405, { status: "method_not_allowed", method });
      return;
    }
    const health: RuntimeHealth = await services.runtime.healthCheck();
    sendJson(res, 200, {
      status: "ok",
      runtime: {
        provider: health.provider,
        ok: health.ok,
        status: health.status,
        detail: health.detail,
        latencyMs: health.latencyMs,
        checkedAt: health.checkedAt,
      },
    });
    return;
  }

  // ---- /api/projects ----
  if (pathname === "/api/projects") {
    if (method !== "POST") {
      res.setHeader("Allow", "POST");
      sendJson(res, 405, { status: "method_not_allowed", method });
      return;
    }
    const body = await readJsonBody(req);
    const title = readStringField(body, "title");
    if (title === undefined) {
      throw new BusinessError("INVALID_REQUEST", "请求体必须包含非空字符串字段 title");
    }
    const project = await services.projects.create(title);
    sendJson(res, 201, { project });
    return;
  }

  // ---- /api/projects/:id 与 /api/projects/:id/generate ----
  const projectMatch = /^\/api\/projects\/([a-z0-9][a-z0-9-]{0,63})$/.exec(pathname);
  if (projectMatch) {
    const projectId = projectMatch[1] ?? "";
    if (method !== "GET") {
      res.setHeader("Allow", "GET");
      sendJson(res, 405, { status: "method_not_allowed", method });
      return;
    }
    const project = await services.projects.getRequired(projectId);
    sendJson(res, 200, { project });
    return;
  }

  const generateMatch = /^\/api\/projects\/([a-z0-9][a-z0-9-]{0,63})\/generate$/.exec(pathname);
  if (generateMatch) {
    const projectId = generateMatch[1] ?? "";
    if (method !== "POST") {
      res.setHeader("Allow", "POST");
      sendJson(res, 405, { status: "method_not_allowed", method });
      return;
    }
    const body = await readJsonBody(req);
    const prompt = readStringField(body, "prompt");
    if (prompt === undefined) {
      throw new BusinessError("INVALID_REQUEST", "请求体必须包含非空字符串字段 prompt");
    }
    const result = await services.generation.generate({ projectId, prompt });
    sendJson(res, 200, result);
    return;
  }

  sendJson(res, 404, { status: "not_found", path: pathname });
}

/** 读取并解析 JSON 请求体；非法 JSON / 超限抛 INVALID_REQUEST */
async function readJsonBody(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  let size = 0;
  for await (const chunk of req) {
    size += (chunk as Buffer).byteLength;
    if (size > MAX_BODY_BYTES) {
      throw new BusinessError("INVALID_REQUEST", `请求体超过 ${MAX_BODY_BYTES} 字节上限`);
    }
    chunks.push(chunk as Buffer);
  }
  const text = Buffer.concat(chunks).toString("utf8").trim();
  if (text === "") {
    throw new BusinessError("INVALID_REQUEST", "请求体不能为空（需要 JSON 对象）");
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new BusinessError("INVALID_REQUEST", "请求体不是合法 JSON");
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    throw new BusinessError("INVALID_REQUEST", "请求体必须是 JSON 对象");
  }
  return parsed as Record<string, unknown>;
}

function readStringField(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field];
  return typeof value === "string" && value.trim() !== "" ? value : undefined;
}

function sendBusinessError(res: ServerResponse, error: BusinessError): void {
  sendJson(res, error.httpStatus, {
    status: "error",
    error: {
      code: error.code,
      message: error.message,
      ...(error.detail !== undefined ? { detail: error.detail } : {}),
    },
  });
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}
