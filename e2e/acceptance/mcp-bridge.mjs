#!/usr/bin/env node
/**
 * Claude Browser Acceptance —— MCP stdio 桥（仅开发工具，不进产品代码）。
 *
 * 这是一个「连接层」：spawn 本地安装的 @playwright/mcp connector，完成 MCP initialize
 * 握手后转发一次工具调用，打印结果文本即退出。所有浏览器动作语义（navigate / click /
 * type / snapshot / file_upload / console / network / screenshot…）都来自 connector 自己
 * 的工具集 —— 本文件不含任何业务逻辑、选择器知识或编排。
 *
 * 存在的意义：Claude Code 的 MCP 工具在会话启动时加载；给本会话（尚未加载 browser MCP）
 * 与任何不想重启的会话提供等价的逐动作调用通道。重启后的会话应优先使用 .mcp.json 里的
 * 原生 playwright-browser 工具（同一 connector、同一能力）。
 *
 * 用法（在 e2e/ 或仓库根均可）：
 *   node e2e/acceptance/mcp-bridge.mjs --list
 *   node e2e/acceptance/mcp-bridge.mjs --call browser_navigate '{"url":"http://localhost:5173/"}'
 *   node e2e/acceptance/mcp-bridge.mjs --timeout 180000 \
 *     --call browser_click  '{"target":"role=button[name=\"上传 PDF\"]","element":"上传按钮"}' \
 *     --call browser_file_upload '{"paths":["D:/path/to/fixture.pdf"]}'
 *   （--call/--args 可重复：多个调用在同一 connector 会话内顺序执行，
 *    file chooser 这类会话内模态状态依赖这一点）
 *
 * connector 固定以 --cdp-endpoint 连接 browser.mjs 启动的 acceptance 浏览器（先 start）。
 */

import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";
import { fileURLToPath } from "node:url";
import { readFileSync } from "node:fs";

const here = dirname(fileURLToPath(import.meta.url));
const repoRoot = resolve(here, "..", "..");
const stateFile = resolve(here, "..", ".tmp", "acceptance", "state.json");

function readEndpoint() {
  let state;
  try {
    state = JSON.parse(readFileSync(stateFile, "utf8"));
  } catch {
    throw new Error(`读不到 acceptance 浏览器状态文件（${stateFile}）；请先 npm run browser:acceptance:start`);
  }
  return `http://127.0.0.1:${state.port}`;
}

/** 本地安装的 connector 入口（e2e devDependency，避免运行时 npx 冷启动与网络依赖） */
function resolveServerCli() {
  const require = createRequire(import.meta.url);
  const manifest = require.resolve("@playwright/mcp/package.json");
  const pkg = JSON.parse(readFileSync(manifest, "utf8"));
  const binRelative = pkg.bin?.["playwright-mcp"] ?? pkg.bin?.cli ?? "cli.js";
  return join(dirname(manifest), binRelative);
}

function parseArgs(argv) {
  const options = { timeout: 120_000, calls: [] };
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index];
    if (token === "--list") {
      options.list = true;
    } else if (token === "--call") {
      options.calls.push({ tool: argv[++index] });
    } else if (token === "--args") {
      if (options.calls.length === 0) {
        console.error("--args 必须跟在 --call 之后");
        process.exit(1);
      }
      options.calls[options.calls.length - 1].arguments = JSON.parse(argv[++index]);
    } else if (token === "--timeout") {
      options.timeout = Number(argv[++index]);
    } else {
      console.error(`未知参数：${token}`);
      process.exit(1);
    }
  }
  return options;
}

/**
 * 单次 MCP 会话：initialize → initialized →（顺序执行若干请求）→ 关闭。
 * 多个请求共用一个 connector 进程 —— file chooser 这类会话内模态状态
 * （click 触发 → browser_file_upload）必须如此；除此之外无任何编排语义。
 * 返回每个请求的 result 数组。
 */
function mcpSession(serverCli, endpoint, requests, timeoutMs) {
  return new Promise((fulfill, reject) => {
    const child = spawn(
      process.execPath,
      [
        serverCli,
        `--cdp-endpoint=${endpoint}`,
        // PaperTeam 的 UI 动作（建项目、导入解析）常超 connector 默认的 5s 动作预算
        "--timeout-action=20000",
        "--timeout-navigation=60000",
        // 截图 / 上传的相对路径以仓库根解析（与 .mcp.json 会话一致）
        "--output-dir=e2e/.tmp/acceptance/shots",
      ],
      { stdio: ["pipe", "pipe", "pipe"], cwd: repoRoot },
    );

    let nextId = 1;
    const pending = new Map();
    const stderrTail = [];
    let settled = false;

    const finish = (error, results) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      for (const { reject: fail } of pending.values()) {
        fail(new Error("会话结束"));
      }
      child.kill();
      error ? reject(error) : fulfill(results);
    };

    const timer = setTimeout(() => {
      finish(new Error(`MCP 调用超时（${timeoutMs}ms）；connector stderr 尾部：\n${stderrTail.join("\n")}`));
    }, timeoutMs);

    const send = (message) => child.stdin.write(`${JSON.stringify(message)}\n`);

    createInterface({ input: child.stdout }).on("line", (line) => {
      if (line.trim() === "") {
        return;
      }
      let message;
      try {
        message = JSON.parse(line);
      } catch {
        return; // 非 JSON 输出（如启动日志）忽略
      }
      if (message.id !== undefined && pending.has(message.id)) {
        const { fulfill: resolveOne, reject: rejectOne } = pending.get(message.id);
        pending.delete(message.id);
        if (message.error) {
          rejectOne(new Error(message.error.message ?? JSON.stringify(message.error)));
        } else {
          resolveOne(message.result);
        }
      }
      // 通知 / 服务端请求一律忽略：本桥只做单向工具调用
    });

    child.stderr
      .setEncoding("utf8")
      .on("data", (chunk) => {
        stderrTail.push(...chunk.split(/\r?\n/).filter(Boolean));
        if (stderrTail.length > 30) {
          stderrTail.splice(0, stderrTail.length - 30);
        }
      });
    child.on("error", (error) => finish(error));
    child.on("exit", (code) => {
      if (!settled) {
        finish(new Error(`connector 提前退出（code=${code}）；stderr 尾部：\n${stderrTail.join("\n")}`));
      }
    });

    const request0 = (method, params) =>
      new Promise((resolveOne, rejectOne) => {
        const id = nextId++;
        pending.set(id, { fulfill: resolveOne, reject: rejectOne });
        send({ jsonrpc: "2.0", id, method, params });
      });

    (async () => {
      await request0("initialize", {
        protocolVersion: "2025-06-18",
        capabilities: {},
        clientInfo: { name: "paperteam-browser-acceptance-bridge", version: "0.1.0" },
      });
      send({ jsonrpc: "2.0", method: "notifications/initialized", params: {} });
      const results = [];
      for (const request of requests) {
        results.push(await request0(request.method, request.params));
      }
      finish(null, results);
    })().catch((error) => finish(error));
  });
}

function renderResult(result) {
  if (result?.content === undefined) {
    return JSON.stringify(result, null, 2);
  }
  const parts = [];
  for (const item of result.content) {
    if (item.type === "text") {
      parts.push(item.text);
    } else {
      parts.push(JSON.stringify(item));
    }
  }
  return parts.join("\n");
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (!options.list && options.calls.length === 0) {
    console.error(
      "用法：node acceptance/mcp-bridge.mjs --list | (--call <tool> [--args <json>])... [--timeout ms]\n" +
        "（--call/--args 可重复：多个调用在同一 connector 会话内顺序执行）",
    );
    process.exit(1);
  }
  const serverCli = resolveServerCli();
  const endpoint = readEndpoint();
  const requests = options.list
    ? [{ method: "tools/list", params: {} }]
    : options.calls.map((call) => ({
        method: "tools/call",
        params: { name: call.tool, arguments: call.arguments ?? {} },
      }));
  const results = await mcpSession(serverCli, endpoint, requests, options.timeout);
  if (options.list) {
    for (const tool of results[0]?.tools ?? []) {
      console.log(`${tool.name} — ${(tool.description ?? "").split("\n")[0]}`);
    }
    return;
  }
  for (const result of results) {
    if (result?.isError) {
      console.error(renderResult(result));
      process.exit(1);
    }
    console.log(renderResult(result));
  }
}

await main();
