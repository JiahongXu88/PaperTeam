/**
 * LaTeX 编译器（M2）。
 *
 * 职责：manuscript/main.tex → build/paper.pdf。
 *
 * 工具链选择（自动探测，不把命令硬编码进业务逻辑）：
 *   1. latexmk -xelatex（推荐，自动处理多轮编译）
 *   2. xelatex（fallback，单轮编译）
 *
 * 结果结构化返回：exitCode、短错误、完整日志路径、PDF 路径、耗时。
 * 几千行 LaTeX 日志保存到 build/compile.log，不塞进 API 响应。
 */

import { spawn } from "node:child_process";
import { mkdir, rename, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";

import {
  LatexCompileFailedError,
  LatexCompileTimeoutError,
  LatexToolUnavailableError,
} from "../errors.js";

/** 可注入的命令执行器（测试用；生产为真实 spawn） */
export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<CommandResult>;

export interface CommandResult {
  /** 进程退出码；null 表示进程未正常退出（被终止） */
  code: number | null;
  stdout: string;
  stderr: string;
  /** 进程无法启动（如可执行文件不存在） */
  spawnError?: string;
  /** 因超时被强制终止 */
  timedOut?: boolean;
}

export interface LatexCompileResult {
  ok: boolean;
  /** 使用的编译工具（latexmk / xelatex） */
  tool: string;
  exitCode: number | null;
  /** 编译产物（成功时为绝对路径） */
  pdfPath: string | null;
  /** 完整编译日志（已落盘） */
  logPath: string | null;
  durationMs: number;
  /** 短错误摘要（失败时；只保留以 "!" 开头的 LaTeX 错误行等关键信息） */
  error?: string;
}

export interface LatexCompilerOptions {
  /** 单次编译超时（毫秒） */
  timeoutMs: number;
  /** 可注入命令执行器（测试用） */
  runner?: CommandRunner;
}

/** Windows 上 spawn 不会按 PATHEXT 解析 .bat/.cmd，这里显式处理 */
const IS_WINDOWS = process.platform === "win32";

export class LatexCompiler {
  private readonly timeoutMs: number;
  private readonly runner: CommandRunner;

  constructor(options: LatexCompilerOptions) {
    this.timeoutMs = options.timeoutMs;
    this.runner = options.runner ?? spawnCommand;
  }

  /**
   * 探测本机可用的 LaTeX 工具。
   * 返回首选工具名；两者都不可用时抛 LatexToolUnavailableError。
   */
  async detectTool(): Promise<"latexmk" | "xelatex"> {
    const tools: readonly ("latexmk" | "xelatex")[] = ["latexmk", "xelatex"];
    for (const tool of tools) {
      const result = await this.runVersionProbe(tool);
      if (result !== null) {
        return tool;
      }
    }
    throw new LatexToolUnavailableError("latexmk 与 xelatex 均不可用（PATH 中未找到）");
  }

  /**
   * 编译项目的 main.tex，产出 build/paper.pdf。
   * 目录约定：manuscriptDir 内有 main.tex，buildDir 为输出目录。
   */
  async compile(params: {
    manuscriptDir: string;
    buildDir: string;
  }): Promise<LatexCompileResult> {
    const tool = await this.detectTool();
    await mkdir(params.buildDir, { recursive: true });

    const startedAt = Date.now();
    const args =
      tool === "latexmk"
        ? [
            "-xelatex",
            "-interaction=nonstopmode",
            "-halt-on-error",
            `-output-directory=${params.buildDir}`,
            "main.tex",
          ]
        : [
            "-interaction=nonstopmode",
            "-halt-on-error",
            `-output-directory=${params.buildDir}`,
            "main.tex",
          ];

    const result = await this.runner(tool, args, {
      cwd: params.manuscriptDir,
      timeoutMs: this.timeoutMs,
    });
    const durationMs = Date.now() - startedAt;

    const logPath = join(params.buildDir, "compile.log");
    const logContent = formatLog(tool, args, result);
    await writeFile(logPath, logContent, "utf8");

    if (result.timedOut === true) {
      throw new LatexCompileTimeoutError(this.timeoutMs);
    }
    if (result.spawnError !== undefined) {
      // 工具已通过探测，此处启动失败属于环境异常，按编译失败归类
      throw new LatexCompileFailedError(
        `${tool} 无法启动：${result.spawnError}（完整日志：${logPath}）`,
      );
    }
    if (result.code === null) {
      throw new LatexCompileFailedError(`进程未正常退出（完整日志：${logPath}）`);
    }

    const compiledPdf = join(params.buildDir, "main.pdf");
    const compiledPdfExists = await fileExists(compiledPdf);
    if (result.code !== 0 || !compiledPdfExists) {
      const reason =
        result.code !== 0
          ? summarizeLogError(logContent)
          : "编译进程正常退出但没有生成 main.pdf";
      throw new LatexCompileFailedError(`exitCode=${result.code}；${reason}（完整日志：${logPath}）`);
    }

    // 统一产物名：main.pdf → paper.pdf
    const paperPdf = join(params.buildDir, "paper.pdf");
    await rename(compiledPdf, paperPdf);

    return {
      ok: true,
      tool,
      exitCode: result.code,
      pdfPath: paperPdf,
      logPath,
      durationMs,
    };
  }

  /** 探测单个工具是否可执行（--version 退出码 0 视为可用） */
  private async runVersionProbe(tool: "latexmk" | "xelatex"): Promise<CommandResult | null> {
    try {
      const result = await this.runner(tool, ["--version"], {
        cwd: process.cwd(),
        // 探测超时远小于编译超时
        timeoutMs: Math.min(this.timeoutMs, 10_000),
      });
      if (result.spawnError !== undefined) {
        return null;
      }
      // Windows 上 cmd 包装脚本可能以 1 退出但仍打印版本；以是否有输出为准
      if (result.code === 0 || (IS_WINDOWS && result.stdout !== "")) {
        return result;
      }
      return null;
    } catch {
      return null;
    }
  }
}

/** 真实命令执行（child_process.spawn，带超时终止） */
function spawnCommand(
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    // Windows 下 latexmk 通常是 .bat 脚本，需要 shell 解析 PATHEXT；
    // 此时含空格/特殊字符的参数必须自行加引号
    const finalArgs = IS_WINDOWS ? args.map(quoteForWindowsShell) : args;
    let child;
    try {
      child = spawn(command, finalArgs, { cwd: options.cwd, shell: IS_WINDOWS });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      resolve({ code: -1, stdout: "", stderr: "", spawnError: message });
      return;
    }

    let stdout = "";
    let stderr = "";
    let settled = false;

    const timer = setTimeout(() => {
      if (settled) {
        return;
      }
      settled = true;
      child.kill();
      resolve({ code: null, stdout, stderr, timedOut: true });
    }, options.timeoutMs);

    child.stdout?.on("data", (chunk: Buffer) => {
      stdout += chunk.toString("utf8");
    });
    child.stderr?.on("data", (chunk: Buffer) => {
      stderr += chunk.toString("utf8");
    });
    child.on("error", (error: NodeJS.ErrnoException) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ code: -1, stdout, stderr, spawnError: error.message });
    });
    child.on("close", (code) => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      resolve({ code: code === null ? -1 : code, stdout, stderr });
    });
  });
}

async function fileExists(path: string): Promise<boolean> {
  try {
    const info = await stat(path);
    return info.isFile();
  } catch {
    return false;
  }
}

/** Windows shell 模式下对含空格/特殊字符的参数加双引号 */
function quoteForWindowsShell(arg: string): string {
  if (/[\s&|<>()^%"]/.test(arg)) {
    return `"${arg.replaceAll('"', '""')}"`;
  }
  return arg;
}

/** 组装完整日志（命令行 + stdout + stderr） */
function formatLog(tool: string, args: readonly string[], result: CommandResult): string {
  const lines = [
    `$ ${tool} ${args.join(" ")}`,
    result.spawnError !== undefined ? `spawn error: ${result.spawnError}` : "",
    `exit code: ${result.code === null ? "null(terminated)" : result.code}`,
    "---- stdout ----",
    result.stdout,
    "---- stderr ----",
    result.stderr,
  ];
  return lines.join("\n");
}

/** 从日志中提取短错误：优先 "!" 开头的 LaTeX 错误行，否则 stderr 首个非空行 */
function summarizeLogError(log: string): string {
  const errorLines: string[] = [];
  for (const line of log.split(/\r?\n/)) {
    const trimmed = line.trim();
    if (trimmed.startsWith("!") && trimmed.length > 1) {
      errorLines.push(trimmed);
      if (errorLines.length >= 5) {
        break;
      }
    }
  }
  if (errorLines.length > 0) {
    return errorLines.join(" | ").slice(0, 300);
  }
  const stderrLine = log
    .split("---- stderr ----")[1]
    ?.split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "");
  return (stderrLine ?? "无明确错误行").slice(0, 300);
}
