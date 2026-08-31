import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

import type { AgentRuntime, RuntimeHealth } from "./runtime/types.js";

/**
 * Backend 自身的极轻量 HTTP 服务（M1）：只提供 GET /health。
 * 不引入 Web 框架；后续里程碑需要完整 API 时再评估。
 *
 * 语义：HTTP 200 表示 PaperTeam Backend 进程存活；
 * OpenClaw Gateway 的健康状态体现在 body.runtime 中（每次请求实时探测）。
 */

export interface BackendHttpServerOptions {
  runtime: AgentRuntime;
}

export function createBackendHttpServer({ runtime }: BackendHttpServerOptions): Server {
  return createServer((req: IncomingMessage, res: ServerResponse) => {
    handleRequest(req, res, runtime).catch((error: unknown) => {
      const message = error instanceof Error ? error.message : String(error);
      res.statusCode = 500;
      res.setHeader("Content-Type", "application/json; charset=utf-8");
      res.end(JSON.stringify({ status: "error", detail: message }));
    });
  });
}

async function handleRequest(
  req: IncomingMessage,
  res: ServerResponse,
  runtime: AgentRuntime,
): Promise<void> {
  const pathname = new URL(req.url ?? "/", "http://localhost").pathname;
  const method = (req.method ?? "GET").toUpperCase();

  if (pathname !== "/health") {
    sendJson(res, 404, { status: "not_found", path: pathname });
    return;
  }
  if (method !== "GET" && method !== "HEAD") {
    res.setHeader("Allow", "GET, HEAD");
    sendJson(res, 405, { status: "method_not_allowed", method });
    return;
  }

  const health = await runtime.healthCheck();
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
}

function sendJson(res: ServerResponse, statusCode: number, body: unknown): void {
  res.statusCode = statusCode;
  res.setHeader("Content-Type", "application/json; charset=utf-8");
  res.setHeader("Cache-Control", "no-store");
  res.end(JSON.stringify(body));
}
