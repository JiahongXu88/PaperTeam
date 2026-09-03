/**
 * M3.5 DevSupervisor 生命周期测试。
 *
 * 前两组用 fake ProcessRunner（不 spawn 真进程）验证编排逻辑；
 * 最后一组用真实 node 子进程（stand-in gateway/backend 脚本）验证：
 * 健康等待 → 启动 → 关闭 → 无孤儿进程（进程树确实退出）。
 */

import { describe, expect, it } from "vitest";
import { createServer } from "node:http";

import { BootstrapError } from "../../src/dev/runtimePaths.js";
import {
  DevSupervisor,
  NodeProcessRunner,
  type ManagedProcess,
  type ProcessRunner,
  type ProcessSpec,
} from "../../src/dev/supervisor.js";

// ---- fake runner ----

interface FakeProcess extends ManagedProcess {
  spec: ProcessSpec;
  /** 模拟进程退出 */
  exit(code: number | null): void;
  killCalls: number;
}

function fakeRunner(): { runner: ProcessRunner; processes: FakeProcess[] } {
  const processes: FakeProcess[] = [];
  const runner: ProcessRunner = {
    spawn: (spec) => {
      let resolveExit: (code: number | null) => void;
      let alreadyExited = false;
      const exited = new Promise<number | null>((resolve) => {
        resolveExit = resolve;
      });
      const fake: FakeProcess = {
        spec,
        pid: 1000 + processes.length,
        exited,
        killCalls: 0,
        exit: (code) => {
          if (alreadyExited) {
            return;
          }
          alreadyExited = true;
          resolveExit(code);
        },
        kill: async () => {
          // 模拟真实 killProcessTree：已退出的进程不再发信号
          if (alreadyExited) {
            return;
          }
          fake.killCalls += 1;
          alreadyExited = true;
          resolveExit(null);
        },
      };
      processes.push(fake);
      return fake;
    },
  };
  return { runner, processes };
}

const gwSpec = { command: "node", args: ["gateway"], cwd: ".", env: {} };
const beSpec = { command: "node", args: ["backend"], cwd: ".", env: {} };

describe("DevSupervisor（fake 进程）", () => {
  it("正常启动序列：gateway → health → backend；backend 退出 → gateway 被 kill", async () => {
    const { runner, processes } = fakeRunner();
    const supervisor = new DevSupervisor({ runner, shutdownSettleMs: 1 });
    const runPromise = supervisor.run(gwSpec, async () => {}, beSpec);
    // 等 backend spawn 完成
    await waitUntil(() => processes.length === 2);
    expect(processes[0]?.spec.args[0]).toBe("gateway");
    expect(processes[1]?.spec.args[0]).toBe("backend");
    processes[1]!.exit(0); // backend 退出
    const result = await runPromise;
    expect(result.firstExit?.label).toBe("backend");
    expect(result.firstExit?.code).toBe(0);
    // gateway 被关闭（无孤儿）
    expect(processes[0]!.killCalls).toBe(1);
    expect(processes[1]!.killCalls).toBe(0); // backend 已自行退出，不再 kill
  });

  it("gateway 启动后立即退出 → BootstrapError，backend 不启动", async () => {
    const { runner, processes } = fakeRunner();
    const supervisor = new DevSupervisor({ runner, shutdownSettleMs: 1 });
    const runPromise = supervisor.run(gwSpec, () => new Promise<void>(() => {}), beSpec);
    await waitUntil(() => processes.length === 1);
    processes[0]!.exit(1);
    await expect(runPromise).rejects.toThrow(BootstrapError);
    expect(processes.length).toBe(1);
  });

  it("健康等待超时前收到外部 shutdown（Ctrl+C 等价）→ 正常返回，不误报崩溃", async () => {
    const { runner, processes } = fakeRunner();
    const supervisor = new DevSupervisor({ runner, shutdownSettleMs: 1 });
    const runPromise = supervisor.run(gwSpec, () => new Promise<void>(() => {}), beSpec);
    await waitUntil(() => processes.length === 1);
    await supervisor.shutdown("收到 SIGINT");
    const result = await runPromise;
    expect(supervisor.isShutdownRequested).toBe(true);
    // gateway 被 shutdown 终止（code=null），不是启动失败
    expect(result.firstExit).toEqual({ label: "gateway", code: null });
    expect(result.gatewayExit).toBeNull();
    expect(result.backendExit).toBeUndefined(); // backend 尚未启动
    expect(processes[0]!.killCalls).toBe(1);
  });

  it("shutdown 幂等：多次调用只 kill 一次", async () => {
    const { runner, processes } = fakeRunner();
    const supervisor = new DevSupervisor({ runner, shutdownSettleMs: 1 });
    const runPromise = supervisor.run(gwSpec, async () => {}, beSpec);
    await waitUntil(() => processes.length === 2);
    await supervisor.shutdown("first");
    await supervisor.shutdown("second");
    await runPromise;
    expect(processes[0]!.killCalls).toBe(1);
    expect(processes[1]!.killCalls).toBe(1);
  });
});

// ---- 真实进程（stand-in gateway/backend node 脚本） ----

/**
 * 真实 node 进程级验证（Windows / POSIX 均适用）：
 * stand-in gateway 是一个真实 HTTP 服务（/health → ok），
 * stand-in backend 是常驻进程；supervisor 关闭后两者必须真实退出。
 */
describe("DevSupervisor（真实子进程，无孤儿验证）", () => {
  it("bootstrap → health → backend → shutdown → 全部退出", async () => {
    // 找一个空闲端口给 stand-in gateway
    const probeServer = createServer();
    const port = await new Promise<number>((resolve) => {
      probeServer.listen(0, "127.0.0.1", () => {
        resolve((probeServer.address() as { port: number }).port);
      });
    });
    await new Promise<void>((resolve) => probeServer.close(() => resolve()));

    const gatewayScript = `
      const http = require("node:http");
      const server = http.createServer((req, res) => {
        if (req.url === "/health") {
          res.writeHead(200, { "Content-Type": "application/json" });
          res.end(JSON.stringify({ ok: true, status: "live" }));
          return;
        }
        res.writeHead(404); res.end();
      });
      server.listen(${port}, "127.0.0.1");
    `;
    const backendScript = `
      // stand-in backend：常驻直到被杀
      setInterval(() => {}, 1000);
    `;
    const runner = new NodeProcessRunner();
    const supervisor = new DevSupervisor({ runner, shutdownSettleMs: 100 });
    const runPromise = supervisor.run(
      {
        command: process.execPath,
        args: ["--eval", gatewayScript],
        cwd: process.cwd(),
        env: { ...process.env },
      },
      async () => {
        // 轮询真实 /health（最多 10s）
        const deadline = Date.now() + 10_000;
        while (Date.now() < deadline) {
          try {
            const response = await fetch(`http://127.0.0.1:${port}/health`);
            if (response.status === 200) {
              const body = (await response.json()) as { ok?: boolean };
              if (body.ok === true) {
                return;
              }
            }
          } catch {
            // 未就绪
          }
          await new Promise((resolve) => setTimeout(resolve, 100));
        }
        throw new Error("stand-in gateway 未就绪");
      },
      {
        command: process.execPath,
        args: ["--eval", backendScript],
        cwd: process.cwd(),
        env: { ...process.env },
      },
    );

    // 等 backend 也起来（同步信号，避免竞态），然后主动关闭（等价 Ctrl+C 处理路径）
    await supervisor.whenBackendStarted;
    expect(supervisor.isShutdownRequested).toBe(false);
    await supervisor.shutdown("测试请求");
    const result = await runPromise;

    // 无孤儿：两个子进程的退出码都已收集
    expect(result.gatewayExit).not.toBeUndefined();
    expect(result.backendExit).not.toBeUndefined();
  }, 30_000);
});

// ---- 工具 ----

async function waitUntil(condition: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!condition()) {
    if (Date.now() > deadline) {
      throw new Error("waitUntil 超时");
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}
