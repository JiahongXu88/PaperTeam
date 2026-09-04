/**
 * Dev 进程监督器（M3.5 Runtime Bootstrap）。
 *
 * 管理 Gateway 与 Backend 两个子进程的完整生命周期：
 *   启动（gateway → health → backend）
 *   ↓
 *   Ctrl+C / SIGTERM
 *   ↓
 *   先停 Backend、再停 Gateway（各带优雅期与强制 tree-kill 兜底）
 *
 * 无孤儿进程保证：
 *   - Windows：强制阶段使用 `taskkill /PID <pid> /T /F`（杀整棵进程树）
 *   - POSIX：SIGTERM 优雅 → SIGKILL 兜底
 *   - 任一子进程自行退出（如崩溃）也会触发整体关闭，不留下半套服务
 *
 * 进程启动抽象为 ProcessRunner（测试注入 fake，不真正 spawn node）。
 */

import { spawn, type ChildProcess } from "node:child_process";

import { BootstrapError } from "./runtimePaths.js";

/** 受管子进程（真实进程或测试 fake 的统一外观） */
export interface ManagedProcess {
  readonly pid: number | undefined;
  /** 进程退出 promise（resolve 为 exit code，被信号杀死时为 null） */
  readonly exited: Promise<number | null>;
  /** 请求终止（先优雅，实现内部可含强制兜底） */
  kill(): Promise<void>;
}

/** 进程启动器（可注入） */
export interface ProcessRunner {
  spawn(spec: ProcessSpec): ManagedProcess;
}

export interface ProcessSpec {
  /** 日志前缀（gateway / backend） */
  label: string;
  /** 可执行文件（node） */
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** 输出回调（stdout+stderr 已按行合并；缺省打印到控制台） */
  onOutput?: (chunk: string) => void;
}

/** 真实 spawn 实现（stdio pipe + 行透传） */
export class NodeProcessRunner implements ProcessRunner {
  spawn(spec: ProcessSpec): ManagedProcess {
    const child = spawn(spec.command, spec.args, {
      cwd: spec.cwd,
      env: spec.env,
      stdio: ["ignore", "pipe", "pipe"],
      windowsHide: true,
    });
    const onOutput = spec.onOutput ?? ((chunk: string) => process.stdout.write(chunk));
    pipeLines(child, spec.label, onOutput);

    const exited = new Promise<number | null>((resolve) => {
      child.once("exit", (code, signal) => resolve(code !== null ? code : signal !== null ? null : code));
    });
    return {
      pid: child.pid,
      exited,
      kill: () => killProcessTree(child),
    };
  }
}

function pipeLines(child: ChildProcess, label: string, onOutput: (chunk: string) => void): void {
  let stdoutRest = "";
  let stderrRest = "";
  child.stdout?.on("data", (chunk: Buffer) => {
    stdoutRest = emitLines(stdoutRest + chunk.toString("utf8"), onOutput);
  });
  child.stderr?.on("data", (chunk: Buffer) => {
    stderrRest = emitLines(stderrRest + chunk.toString("utf8"), (line) =>
      onOutput(`[stderr] ${line}`),
    );
  });
  child.once("exit", () => {
    if (stdoutRest !== "") {
      onOutput(stdoutRest);
    }
    if (stderrRest !== "") {
      onOutput(`[stderr] ${stderrRest}`);
    }
  });
  // 起始行带标签，输出可区分来源
  onOutput(`[${label}] 进程已启动（pid=${child.pid}）`);
}

function emitLines(buffer: string, onLine: (line: string) => void): string {
  let rest = buffer;
  let index = rest.indexOf("\n");
  while (index >= 0) {
    const line = rest.slice(0, index).replace(/\r$/, "");
    if (line !== "") {
      onLine(line);
    }
    rest = rest.slice(index + 1);
    index = rest.indexOf("\n");
  }
  return rest;
}

/** 优雅终止 → 超时后强制杀进程树（Windows 用 taskkill /T，POSIX 用 SIGKILL） */
export async function killProcessTree(child: ChildProcess): Promise<void> {
  const pid = child.pid;
  if (pid === undefined) {
    return;
  }
  if (child.exitCode !== null || child.signalCode !== null) {
    return;
  }
  // 阶段 1：优雅（POSIX SIGTERM 触发 OpenClaw/Backend 的 graceful shutdown；
  // Windows 上 Node 的 kill() 即 TerminateProcess，直接进入确认）
  try {
    child.kill("SIGTERM");
  } catch {
    // 已退出
  }
  const graceful = await waitForExit(child, 5_000);
  if (graceful) {
    return;
  }
  // 阶段 2：强制 tree-kill（子进程可能还有自己的子进程）
  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
        stdio: "ignore",
        windowsHide: true,
      });
      killer.once("close", () => resolve());
      killer.once("error", () => resolve());
    });
  } else {
    try {
      child.kill("SIGKILL");
    } catch {
      // 已退出
    }
  }
  await waitForExit(child, 3_000);
}

function waitForExit(child: ChildProcess, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    if (child.exitCode !== null || child.signalCode !== null) {
      resolve(true);
      return;
    }
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref?.();
    child.once("exit", () => {
      clearTimeout(timer);
      resolve(true);
    });
  });
}

// ---- DevSupervisor ----

export interface DevSupervisorOptions {
  runner?: ProcessRunner;
  log?: (message: string) => void;
  /** shutdown 时给各进程的额外确认窗口（毫秒），默认 3000 */
  shutdownSettleMs?: number;
}

export interface StartGatewaySpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

export interface StartBackendSpec {
  command: string;
  args: string[];
  cwd: string;
  env: NodeJS.ProcessEnv;
}

/**
 * Gateway + Backend 双进程监督器。
 *
 * run() 完整编排：spawn gateway → waitForHealth → spawn backend →
 * 等待任一进程退出或收到信号 → 关闭另一个 → 返回退出摘要。
 * health 等待由调用方注入（Bootstrap CLI 用真实轮询，测试用即时 resolve）。
 */
export class DevSupervisor {
  private readonly runner: ProcessRunner;
  private readonly log: (message: string) => void;
  private readonly settleMs: number;
  private gateway: ManagedProcess | null = null;
  private backend: ManagedProcess | null = null;
  private shutdownRequested = false;
  private shutdownPromise: Promise<void> | null = null;
  private stopWaiters: (() => void)[] = [];
  private gatewayExitCode: number | null | undefined = undefined;
  private backendExitCode: number | null | undefined = undefined;
  private firstExit: { label: string; code: number | null } | null = null;
  private backendStartedNotifier: (() => void) | null = null;
  /** backend 子进程已 spawn 后 resolve（测试 / 编排同步用） */
  readonly whenBackendStarted: Promise<void> = new Promise((resolve) => {
    this.backendStartedNotifier = resolve;
  });

  constructor(options: DevSupervisorOptions = {}) {
    this.runner = options.runner ?? new NodeProcessRunner();
    this.log = options.log ?? ((message) => console.log(message));
    this.settleMs = options.shutdownSettleMs ?? 3_000;
  }

  /** 注册外部信号（SIGINT/SIGTERM）→ 优雅关闭 */
  registerSignalHandlers(signals: readonly NodeJS.Signals[] = ["SIGINT", "SIGTERM"]): void {
    for (const signal of signals) {
      process.on(signal, () => {
        void this.shutdown(`收到 ${signal}`);
      });
    }
  }

  get isShutdownRequested(): boolean {
    return this.shutdownRequested;
  }

  /**
   * 启动 Gateway，等待健康，再启动 Backend；阻塞至整体退出。
   * @returns 退出摘要（哪个进程先退、退出码）
   */
  async run(
    gatewaySpec: StartGatewaySpec,
    waitForHealth: () => Promise<void>,
    backendSpec: StartBackendSpec,
  ): Promise<DevRunResult> {
    this.gateway = this.runner.spawn({ label: "gateway", ...gatewaySpec });
    this.log(`[gateway] 启动中（pid=${this.gateway.pid}）`);

    // Gateway 进程立即崩溃时，健康等待会一直轮询失败——并行竞速：
    // 先到者胜（进程退出 → 直接进入关闭流程并报错）。
    const healthOrExit = await Promise.race([
      waitForHealth().then(() => "healthy" as const),
      this.gateway.exited.then((code) => ({ gatewayExitedEarly: code })),
    ]);
    if (typeof healthOrExit === "object" && "gatewayExitedEarly" in healthOrExit) {
      const code = healthOrExit.gatewayExitedEarly;
      this.gateway = null; // 已退出，无需再 kill
      if (this.shutdownRequested) {
        // 外部信号（Ctrl+C）触发的正常退出，不是启动失败
        return {
          firstExit: { label: "gateway", code: code ?? null },
          gatewayExit: code ?? null,
          backendExit: undefined,
        };
      }
      await this.shutdown("gateway 提前退出");
      throw new BootstrapError(
        `Gateway 进程启动后立即退出（code=${code ?? "signal"}）。` +
          ` 请检查上方 [gateway] 日志（常见原因：端口被占用、Node 版本不满足 openclaw 要求）。`,
        "GATEWAY_PROCESS_EXITED",
      );
    }
    this.log("[gateway] 健康检查通过");

    this.backend = this.runner.spawn({ label: "backend", ...backendSpec });
    this.log(`[backend] 启动中（pid=${this.backend.pid}）`);
    this.backendStartedNotifier?.();

    // 等待任一退出或外部 shutdown
    await this.waitForAnyExit();
    const firstExit = this.collectFirstExit();
    await this.shutdown(firstExit !== null ? "进程退出" : "外部请求");
    return {
      firstExit,
      gatewayExit: this.gatewayExitCode,
      backendExit: this.backendExitCode,
    };
  }

  /**
   * 仅启动并监督 Backend（M3.7：PAPERTEAM_AGENT_RUNTIME=pi 时无 Gateway 进程）。
   * 阻塞至 Backend 退出或外部信号；语义与 run() 的 Backend 段一致。
   */
  async runBackendOnly(backendSpec: StartBackendSpec): Promise<DevRunResult> {
    this.backend = this.runner.spawn({ label: "backend", ...backendSpec });
    this.log(`[backend] 启动中（pid=${this.backend.pid}）`);
    this.backendStartedNotifier?.();

    await this.waitForAnyExit();
    const firstExit = this.collectFirstExit();
    await this.shutdown(firstExit !== null ? "进程退出" : "外部请求");
    return {
      firstExit,
      gatewayExit: undefined,
      backendExit: this.backendExitCode,
    };
  }

  private collectFirstExit(): { label: string; code: number | null } | null {
    return this.firstExit;
  }

  /** 等待任一子进程退出或外部 shutdown 通知 */
  private waitForAnyExit(): Promise<void> {
    return new Promise((resolve) => {
      const done = () => resolve();
      this.stopWaiters.push(done);
      void this.gateway?.exited.then((code) => {
        this.gatewayExitCode = code ?? null;
        this.firstExit ??= { label: "gateway", code: code ?? null };
        done();
      });
      void this.backend?.exited.then((code) => {
        this.backendExitCode = code ?? null;
        this.firstExit ??= { label: "backend", code: code ?? null };
        done();
      });
    });
  }

  /** 优雅关闭全部子进程（幂等；并发调用等待同一次关闭完成） */
  shutdown(reason: string): Promise<void> {
    if (this.shutdownPromise !== null) {
      return this.shutdownPromise;
    }
    this.shutdownRequested = true;
    this.log(`[dev] 正在关闭（${reason}）...`);
    this.shutdownPromise = this.doShutdown();
    return this.shutdownPromise;
  }

  private async doShutdown(): Promise<void> {
    // 先 Backend（它会取消活跃 run、落盘 checkpoint），再 Gateway
    for (const [label, proc] of [
      ["backend", this.backend],
      ["gateway", this.gateway],
    ] as const) {
      if (proc === null) {
        continue;
      }
      try {
        await proc.kill();
      } catch (error) {
        this.log(`[dev] 停止 ${label} 异常（已忽略）：${errorText(error)}`);
      }
    }
    // 确认窗口：让最后的日志刷出来
    await new Promise((resolve) => setTimeout(resolve, this.settleMs));
    for (const notify of this.stopWaiters.splice(0)) {
      notify();
    }
  }
}

export interface DevRunResult {
  firstExit: { label: string; code: number | null } | null;
  gatewayExit: number | null | undefined;
  backendExit: number | null | undefined;
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}
