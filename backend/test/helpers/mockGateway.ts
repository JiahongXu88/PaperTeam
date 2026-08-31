/**
 * 测试辅助：按 OpenClaw Gateway WebSocket 协议响应的本地 mock 服务。
 *
 * 实现的协议子集（与 src/runtime/openclaw/gatewayWebSocket.ts 对应）：
 * - HTTP Upgrade → WebSocket 握手（Sec-WebSocket-Accept）
 * - 解析客户端（带掩码）文本帧，发送服务端（不带掩码）文本帧
 * - req/res 关联；connect 默认返回 hello-ok
 *
 * 不依赖任何第三方库，不依赖真实 Gateway。
 */

import { createHash } from "node:crypto";
import { createServer, type Server } from "node:http";
import type { Duplex } from "node:stream";

const WS_GUID = "258EAFA5-E914-47DA-95CA-C5AB0DC85B11";

export type MockGatewayReply =
  | { ok: true; payload: unknown }
  | { ok: false; error: { code: string; message: string; details?: unknown } };

/** 每个方法的脚本：返回 undefined 表示不响应（用于超时/断连测试） */
export type MockGatewayHandler = (
  method: string,
  params: Record<string, unknown>,
) => Promise<MockGatewayReply | undefined> | MockGatewayReply | undefined;

export interface MockGateway {
  /** ws:// 地址 */
  url: string;
  /** HTTP 探针地址（同端口） */
  httpUrl: string;
  /** 收到的全部请求（method + params） */
  requests: { method: string; params: Record<string, unknown> }[];
  close(): Promise<void>;
}

export interface MockGatewayOptions {
  handler: MockGatewayHandler;
  /** 每个响应前的人工延迟（毫秒，默认 0；模拟 agent.wait 长轮询节奏） */
  responseDelayMs?: number;
}

export async function startMockGateway(options: MockGatewayOptions): Promise<MockGateway> {
  const sockets = new Set<Duplex>();
  const requests: { method: string; params: Record<string, unknown> }[] = [];

  const server: Server = createServer((_req, res) => {
    res.writeHead(404);
    res.end();
  });

  server.on("connection", (socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
  });

  server.on("upgrade", (req, socket) => {
    const key = req.headers["sec-websocket-key"];
    if (typeof key !== "string" || key === "") {
      socket.destroy();
      return;
    }
    const accept = createHash("sha1").update(key + WS_GUID).digest("base64");
    socket.write(
      "HTTP/1.1 101 Switching Protocols\r\n" +
        "Upgrade: websocket\r\n" +
        "Connection: Upgrade\r\n" +
        `Sec-WebSocket-Accept: ${accept}\r\n` +
        "\r\n",
    );
    attachWebSocketSession(socket, options, requests);
  });

  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (address === null || typeof address === "string") {
    throw new Error("unexpected listen address");
  }

  return {
    url: `ws://127.0.0.1:${address.port}/`,
    httpUrl: `http://127.0.0.1:${address.port}`,
    requests,
    close: async () => {
      for (const socket of sockets) {
        socket.destroy();
      }
      await new Promise<void>((resolve) => {
        server.close(() => resolve());
      });
    },
  };
}

/** 默认 handler：connect 成功，其余方法返回未知方法错误 */
export function defaultHandler(): MockGatewayHandler {
  return (method) => {
    if (method === "connect") {
      return { ok: true, payload: buildHelloOk() };
    }
    return { ok: false, error: { code: "NOT_FOUND", message: `unknown method: ${method}` } };
  };
}

export function buildHelloOk(): Record<string, unknown> {
  return {
    type: "hello-ok",
    protocol: 4,
    server: { version: "mock-gateway", connId: "mock-conn-1" },
    features: { methods: ["agent", "agent.wait", "chat.history"], events: [] },
    snapshot: { presence: [], health: { ok: true }, stateVersion: 1, uptimeMs: 1 },
    auth: { role: "operator", scopes: ["operator.read", "operator.write"] },
    policy: { maxPayload: 26214400, maxBufferedBytes: 52428800, tickIntervalMs: 15000 },
  };
}

// ---- 极简 WebSocket 帧编解码（仅服务端所需子集） ----

function attachWebSocketSession(
  socket: Duplex,
  options: MockGatewayOptions,
  requests: { method: string; params: Record<string, unknown> }[],
): void {
  let buffer = Buffer.alloc(0);
  let fragmented: { opcode: number; chunks: Buffer[] } | null = null;

  socket.on("data", (chunk: Buffer) => {
    buffer = Buffer.concat([buffer, chunk]);
    // 循环取出完整帧
    for (;;) {
      const frame = tryReadFrame(buffer);
      if (frame === null) {
        return;
      }
      buffer = buffer.subarray(frame.consumed);
      const payload = frame.payload;

      if (frame.opcode === 0x8) {
        // close：回 close 帧后结束
        socket.end(Buffer.from([0x88, 0x00]));
        return;
      }
      if (frame.opcode === 0x9) {
        // ping → pong
        writeFrame(socket, 0xa, payload);
        continue;
      }
      if (frame.opcode === 0x1 || frame.opcode === 0x2) {
        if (!frame.fin) {
          fragmented = { opcode: frame.opcode, chunks: [payload] };
          continue;
        }
        handleMessage(socket, payload, options, requests);
        continue;
      }
      if (frame.opcode === 0x0 && fragmented) {
        fragmented.chunks.push(payload);
        if (frame.fin) {
          const whole = Buffer.concat(fragmented.chunks);
          const opcode = fragmented.opcode;
          fragmented = null;
          if (opcode === 0x1 || opcode === 0x2) {
            handleMessage(socket, whole, options, requests);
          }
        }
      }
    }
  });

  socket.on("error", () => {
    socket.destroy();
  });
}

async function handleMessage(
  socket: Duplex,
  payload: Buffer,
  options: MockGatewayOptions,
  requests: { method: string; params: Record<string, unknown> }[],
): Promise<void> {
  let frame: unknown;
  try {
    frame = JSON.parse(payload.toString("utf8"));
  } catch {
    return;
  }
  if (typeof frame !== "object" || frame === null) {
    return;
  }
  const record = frame as Record<string, unknown>;
  if (record["type"] !== "req") {
    return;
  }
  const id = record["id"];
  const method = record["method"];
  const params =
    typeof record["params"] === "object" && record["params"] !== null
      ? (record["params"] as Record<string, unknown>)
      : {};
  if (typeof id !== "string" || typeof method !== "string") {
    return;
  }
  requests.push({ method, params });

  if (options.responseDelayMs && options.responseDelayMs > 0) {
    await delay(options.responseDelayMs);
  }
  const reply = await options.handler(method, params);
  if (reply === undefined) {
    return; // 不响应
  }
  const response = reply.ok
    ? { type: "res", id, ok: true, payload: reply.payload }
    : { type: "res", id, ok: false, error: reply.error };
  writeFrame(socket, 0x1, Buffer.from(JSON.stringify(response), "utf8"));
}

/** 写一帧服务端 → 客户端（无掩码）文本/控制帧 */
function writeFrame(socket: Duplex, opcode: number, payload: Buffer): void {
  const header =
    payload.length < 126
      ? Buffer.from([0x80 | opcode, payload.length])
      : payload.length < 65536
        ? Buffer.from([0x80 | opcode, 126, payload.length >> 8, payload.length & 0xff])
        : (() => {
            const header = Buffer.alloc(10);
            header[0] = 0x80 | opcode;
            header[1] = 127;
            header.writeBigUInt64BE(BigInt(payload.length), 2);
            return header;
          })();
  socket.write(Buffer.concat([header, payload]));
}

/** 尝试从 buffer 解出一帧（客户端帧带掩码）；不完整返回 null */
function tryReadFrame(buffer: Buffer): { fin: boolean; opcode: number; payload: Buffer; consumed: number } | null {
  if (buffer.length < 2) {
    return null;
  }
  const fin = (buffer[0]! & 0x80) !== 0;
  const opcode = buffer[0]! & 0x0f;
  const masked = (buffer[1]! & 0x80) !== 0;
  let length = buffer[1]! & 0x7f;
  let offset = 2;
  if (length === 126) {
    if (buffer.length < offset + 2) {
      return null;
    }
    length = buffer.readUInt16BE(offset);
    offset += 2;
  } else if (length === 127) {
    if (buffer.length < offset + 8) {
      return null;
    }
    const big = buffer.readBigUInt64BE(offset);
    if (big > BigInt(Number.MAX_SAFE_INTEGER)) {
      throw new Error("frame too large");
    }
    length = Number(big);
    offset += 8;
  }
  const maskKeyLength = masked ? 4 : 0;
  if (buffer.length < offset + maskKeyLength + length) {
    return null;
  }
  let payload = buffer.subarray(offset + maskKeyLength, offset + maskKeyLength + length);
  if (masked) {
    const key = buffer.subarray(offset, offset + 4);
    const unmasked = Buffer.allocUnsafe(length);
    for (let index = 0; index < length; index += 1) {
      unmasked[index] = payload[index]! ^ key[index % 4]!;
    }
    payload = unmasked;
  }
  return { fin, opcode, payload, consumed: offset + maskKeyLength + length };
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
