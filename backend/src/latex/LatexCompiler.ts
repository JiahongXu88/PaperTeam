/**
 * LaTeX 编译器。
 *
 * 职责：manuscript/main.tex → build/paper.pdf。
 *
 * 工具链（M9.5.1 重构）：xelatex + bibtex 显式编排，不再委托 latexmk。
 * 根因（M9.5 §13 实录）：Windows 上 MiKTeX latexmk.exe 是 perl 包装脚本，
 * 委托 PATH 中的 perl（开发机通常是 Git-Bash MSYS perl），其运行时把
 * BIBINPUTS 写成 /d/... MSYS 路径形态，Windows bibtex 据此打开错误的
 * references.bib → PDF 参考文献为空而 latexmk 仍 exit 0。显式编排不经过
 * perl，任何原生 xelatex + bibtex（MiKTeX / TeX Live / WSL）行为一致。
 *
 * 编译采用「staging 统一工作目录」：先把 manuscript/ 全部源文件复制进
 * build/，然后在 build/ 内编译（cwd=buildDir，不用 -output-directory）。
 * tex / bib / aux / bbl 全部同目录：bibtex 天然读到正确的 references.bib，
 * xelatex 天然读到 main.bbl——零环境变量（BIBINPUTS 等），跨发行版一致，
 * manuscript/ 源目录不被编译产物污染。
 *
 * 编排步骤（全程共享 timeoutMs 预算）：
 *   1. xelatex（产出 main.aux）
 *   2. main.aux 含 \bibdata → bibtex main；bibtex 失败、或 .blg 显示
 *      0 entries（aux 有 \citation）→ 编译失败（M9.5 事故形态显式化）
 *   3. xelatex × 2（渲染 bbl + 解析引用编号）；main.log 提示 Rerun 时
 *      最多追加 2 轮（固定上限保证终止）
 *   4. 终检：main.log 仍有未解析引用 → 编译失败（references 不完整的
 *      PDF 不静默通过）
 *
 * 结果结构化返回：exitCode、短错误、完整日志路径、PDF 路径、耗时。
 * 全部步骤日志保存到 build/compile.log，不塞进 API 响应。
 */

import { spawn } from "node:child_process";
import { cp, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
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
  /** 使用的编译工具（xelatex / xelatex+bibtex） */
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
  /** 整次编译的超时预算（毫秒；覆盖全部编排步骤） */
  timeoutMs: number;
  /** 可注入命令执行器（测试用） */
  runner?: CommandRunner;
}

/** Windows 上 spawn 不会按 PATHEXT 解析 .bat/.cmd，这里显式处理 */
const IS_WINDOWS = process.platform === "win32";

const XELATEX_ARGS = ["-interaction=nonstopmode", "-halt-on-error", "main.tex"] as const;

/**
 * main.log 中提示需要再编译的行。统一匹配 "Rerun to get …"（LaTeX 的
 * cross-references right / natbib 的 citations correct / hyperref 的
 * outlines right 等）与 "Label(s) may have changed"（M9.5.1 实测：natbib
 * 用自己的措辞，只匹配 cross-references 会漏判 → 提前收敛 → 引用未解析）。
 */
const RERUN_PATTERN = /Rerun to get|Label\(s\) may have changed/;

/** main.log 中存在未解析引用（bib 缺条目或渲染链故障） */
const UNDEFINED_CITATION_PATTERN = /Citation `[^']+' on page \d+ undefined/;

/** bibtex .blg 报告未产出任何条目（M9.5 事故形态：打开了错误的 references.bib） */
const ZERO_ENTRIES_PATTERN = /used 0 entries/i;

/** Rerun 提示后的最大追加轮次（固定上限保证编译终止；共最多 4 轮 xelatex） */
const MAX_RERUN_ROUNDS = 2;

/** 编译产物扩展名（staging 前清理 build/，保证重复 build 输出一致） */
const TEX_PRODUCT_EXTENSIONS = [
  ".aux",
  ".bbl",
  ".bcf",
  ".blg",
  ".fdb_latexmk",
  ".fls",
  ".idx",
  ".ilg",
  ".ind",
  ".lof",
  ".log",
  ".lot",
  ".nav",
  ".out",
  ".pdf",
  ".run.xml",
  ".snm",
  ".synctex.gz",
  ".toc",
  ".vrb",
  ".xdv",
] as const;

/** 编排中一次命令执行的记录（写 compile.log 用） */
interface CommandStep {
  label: string;
  command: string;
  args: readonly string[];
  result: CommandResult;
}

export class LatexCompiler {
  private readonly timeoutMs: number;
  private readonly runner: CommandRunner;

  constructor(options: LatexCompilerOptions) {
    this.timeoutMs = options.timeoutMs;
    this.runner = options.runner ?? spawnCommand;
  }

  /**
   * 探测本机可用的 LaTeX 工具链。
   * 返回工具描述（"xelatex+bibtex" / "xelatex"）；xelatex 不可用时抛
   * LatexToolUnavailableError（bibtex 缺失只降级描述——无 bibliography
   * 的文档不需要它，compile() 里在确认需要时才硬性要求）。
   */
  async detectTool(): Promise<string> {
    if (!(await this.isToolAvailable("xelatex"))) {
      throw new LatexToolUnavailableError("xelatex 不可用（PATH 中未找到）");
    }
    return (await this.isToolAvailable("bibtex")) ? "xelatex+bibtex" : "xelatex";
  }

  /**
   * 编译项目的 main.tex，产出 build/paper.pdf。
   * 目录约定：manuscriptDir 内有 main.tex（及可选 sections/、references.bib），
   * buildDir 为 staging 编译工作区（源文件复制进来，产物同目录生成）。
   */
  async compile(params: {
    manuscriptDir: string;
    buildDir: string;
  }): Promise<LatexCompileResult> {
    if (!(await this.isToolAvailable("xelatex"))) {
      throw new LatexToolUnavailableError("xelatex 不可用（PATH 中未找到）");
    }

    const startedAt = Date.now();
    const deadline = startedAt + this.timeoutMs;
    const logPath = join(params.buildDir, "compile.log");
    const steps: CommandStep[] = [];

    try {
      await stageBuildWorkspace(params.manuscriptDir, params.buildDir);

      /** 执行一步编排命令；超预算 / spawn 失败 / 被终止 → 结构化抛错 */
      const runStep = async (
        label: string,
        command: string,
        args: readonly string[],
      ): Promise<CommandResult> => {
        const remainingMs = deadline - Date.now();
        if (remainingMs <= 0) {
          throw new LatexCompileTimeoutError(this.timeoutMs);
        }
        const result = await this.runner(command, args, {
          cwd: params.buildDir,
          timeoutMs: remainingMs,
        });
        steps.push({ label, command, args, result });
        if (result.timedOut === true) {
          throw new LatexCompileTimeoutError(this.timeoutMs);
        }
        if (result.spawnError !== undefined) {
          throw new LatexCompileFailedError(
            `${command} 无法启动：${result.spawnError}（完整日志：${logPath}）`,
          );
        }
        if (result.code === null) {
          throw new LatexCompileFailedError(`${command} 进程未正常退出（完整日志：${logPath}）`);
        }
        return result;
      };

      /** xelatex 轮次失败（非零退出）→ 立即失败（错误行摘要来自累计日志） */
      const failOnBadExit = (result: CommandResult): void => {
        if (result.code !== 0) {
          throw new LatexCompileFailedError(
            `exitCode=${result.code}；${summarizeLogError(formatStepLog(steps))}（完整日志：${logPath}）`,
          );
        }
      };

      // ---- pass 1：产出 main.aux ----
      let result = await runStep("xelatex pass 1", "xelatex", XELATEX_ARGS);
      failOnBadExit(result);

      // ---- bibtex：aux 声明 \bibdata 时执行（统一工作目录内零环境变量） ----
      let ranBibtex = false;
      const aux = await readTextIfExists(join(params.buildDir, "main.aux"));
      if (/\\bibdata\{/.test(aux)) {
        if (!(await this.isToolAvailable("bibtex"))) {
          throw new LatexToolUnavailableError(
            "main.tex 声明了参考文献但 bibtex 不可用（PATH 中未找到）",
          );
        }
        result = await runStep("bibtex", "bibtex", ["main"]);
        ranBibtex = true;
        if (result.code !== 0) {
          throw new LatexCompileFailedError(
            `bibtex exitCode=${result.code}；${summarizeLogError(formatStepLog(steps))}（完整日志：${logPath}）`,
          );
        }
        // M9.5 事故形态回归：bibtex exit 0 但读到错误的 references.bib（0 entries）
        const blg = await readTextIfExists(join(params.buildDir, "main.blg"));
        if (ZERO_ENTRIES_PATTERN.test(blg) && /\\citation\{/.test(aux)) {
          throw new LatexCompileFailedError(
            `bibtex 处理 0 条文献：正文有 \\cite 但 references.bib 未被正确读取或条目全部缺失（完整日志：${logPath}）`,
          );
        }
      }

      // ---- pass 2/3（渲染 bbl + 解析编号）+ Rerun 追加（上限 MAX_RERUN_ROUNDS） ----
      let round = 2;
      for (;;) {
        result = await runStep(`xelatex pass ${round}`, "xelatex", XELATEX_ARGS);
        failOnBadExit(result);
        const texLog = await readTextIfExists(join(params.buildDir, "main.log"));
        if (!RERUN_PATTERN.test(texLog) || round >= 2 + MAX_RERUN_ROUNDS) {
          break;
        }
        round += 1;
      }

      const compiledPdf = join(params.buildDir, "main.pdf");
      const compiledPdfExists = await fileExists(compiledPdf);
      if (!compiledPdfExists) {
        throw new LatexCompileFailedError(
          `编译进程正常退出但没有生成 main.pdf（完整日志：${logPath}）`,
        );
      }

      // ---- 终检：未解析引用不让「references 空」的 PDF 静默通过 ----
      const finalTexLog = await readTextIfExists(join(params.buildDir, "main.log"));
      if (UNDEFINED_CITATION_PATTERN.test(finalTexLog)) {
        throw new LatexCompileFailedError(
          `存在未解析的 \\cite 引用（references.bib 缺条目或渲染链故障；完整日志：${logPath}）`,
        );
      }

      // 统一产物名：main.pdf → paper.pdf
      const paperPdf = join(params.buildDir, "paper.pdf");
      await rename(compiledPdf, paperPdf);

      return {
        ok: true,
        tool: ranBibtex ? "xelatex+bibtex" : "xelatex",
        exitCode: result.code,
        pdfPath: paperPdf,
        logPath,
        durationMs: Date.now() - startedAt,
      };
    } finally {
      // 所有路径（成功/失败）都落盘完整编排日志，供诊断与 Writer 修复上下文
      await writeFile(logPath, formatStepLog(steps), "utf8").catch(() => undefined);
    }
  }

  /** 探测单个工具是否可执行（--version 退出码 0 视为可用） */
  private async isToolAvailable(tool: string): Promise<boolean> {
    try {
      const result = await this.runner(tool, ["--version"], {
        cwd: process.cwd(),
        // 探测超时远小于编译超时
        timeoutMs: Math.min(this.timeoutMs, 10_000),
      });
      if (result.spawnError !== undefined) {
        return false;
      }
      // Windows 上 cmd 包装脚本可能以 1 退出但仍打印版本；以是否有输出为准
      return result.code === 0 || (IS_WINDOWS && result.stdout !== "");
    } catch {
      return false;
    }
  }
}

// ---- staging 工作目录 ----

/**
 * 准备 build/ 编译工作区：
 * 1. 清理上次编译的 TeX 产物（重复 build 从干净状态出发，输出一致；
 *    build-gate.json 等非 TeX 文件保留）；
 * 2. 复制 manuscript/ 全部源文件（main.tex / sections/ / references.bib）。
 * 之后编排命令全部以 buildDir 为 cwd，源文件与产物同目录。
 */
async function stageBuildWorkspace(manuscriptDir: string, buildDir: string): Promise<void> {
  await mkdir(buildDir, { recursive: true });
  await cleanTexProducts(buildDir);
  await cp(manuscriptDir, buildDir, { recursive: true, force: true });
}

/** 递归删除目录内全部 TeX 编译产物（按扩展名白名单） */
async function cleanTexProducts(dir: string): Promise<void> {
  const entries = await readdir(dir, { withFileTypes: true, recursive: true });
  await Promise.all(
    entries
      .filter(
        (entry) =>
          entry.isFile() && TEX_PRODUCT_EXTENSIONS.some((ext) => entry.name.endsWith(ext)),
      )
      .map((entry) => rm(join(entry.parentPath, entry.name), { force: true })),
  );
}

async function readTextIfExists(path: string): Promise<string> {
  try {
    return await readFile(path, "utf8");
  } catch {
    return "";
  }
}

// ---- 命令执行 ----

/** 真实命令执行（child_process.spawn，带超时终止） */
function spawnCommand(
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    // Windows 下 TeX 工具链可能以 .bat/.cmd 脚本分发，需要 shell 解析 PATHEXT；
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

// ---- 日志 ----

/** Windows shell 模式下对含空格/特殊字符的参数加双引号 */
function quoteForWindowsShell(arg: string): string {
  if (/[\s&|<>()^%"]/.test(arg)) {
    return `"${arg.replaceAll('"', '""')}"`;
  }
  return arg;
}

/** 组装全部编排步骤的完整日志（每步：命令行 + stdout + stderr） */
function formatStepLog(steps: readonly CommandStep[]): string {
  return steps
    .map((step) => {
      const lines = [
        `# ${step.label}`,
        `$ ${step.command} ${step.args.join(" ")}`,
        step.result.spawnError !== undefined ? `spawn error: ${step.result.spawnError}` : "",
        `exit code: ${step.result.code === null ? "null(terminated)" : step.result.code}`,
        "---- stdout ----",
        step.result.stdout,
        "---- stderr ----",
        step.result.stderr,
      ];
      return lines.filter((line) => line !== "").join("\n");
    })
    .join("\n\n");
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
  // 多步日志有多个 stderr 段；每段取到首个空行为止（其后是下一段的头部）
  const stderrLines = log
    .split("---- stderr ----")
    .slice(1)
    .map((section) => section.replace(/^\r?\n/, "").split(/\r?\n\r?\n/)[0] ?? "")
    .map((section) => section.split(/\r?\n/).map((line) => line.trim()))
    .flat()
    .filter((line) => line !== "");
  return (stderrLines[0] ?? "无明确错误行").slice(0, 300);
}
