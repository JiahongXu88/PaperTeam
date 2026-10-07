/**
 * FigureCompiler（M12.3 C3）：spec → 校验 → codegen → xelatex 单遍 → PDF 资产。
 *
 * 与整篇 manuscript 的 LatexCompiler（latex/LatexCompiler.ts）刻意分层：
 * - 单文件、单遍、无 bibtex、无 staging 复制（就一个 .tex）、隔离 mkdtemp
 *   临时目录、结束即清理；
 * - CommandRunner 注入 seam 与 LatexCompiler 同构（形状一致，测试手法可复用），
 *   但 spawn 实现是本模块独立的一份——有意不提取共享：LatexCompiler 属
 *   manuscript 编译域（Track 外文件），为共享实现改动它的风险大于复制约
 *   60 行 spawn/超时/Windows shell 处理的维护成本（两处编译的演化节奏不同：
 *   整稿编排会继续加步骤，单图编译保持极简）。
 *
 * 错误模型（任务书 §15）：结构化结果对象，不抛业务异常。理由：
 * - 编译失败是**预期内的运营结果**（四类：工具缺失 / 宏包缺失 / 编译失败 /
 *   超时，另加 spec 非法），消费方（C4 HTTP、C5 插入、工作流）需要按类
 *   分支处理而不是 try/catch 字符串匹配；
 * - cache hit 是正常快速路径（cached: true），不是异常；
 * - 编程错误（内部契约破坏）仍直接抛 Error——不进结果通道。
 * errors.ts 提供 kind → BusinessError 的映射（figureFailureToBusinessError，
 *   C4 的 HTTP 层直接可用），但本模块自身只返回结果对象。
 *
 * 流程（每步失败都有归属的 failure kind）：
 *   1. spec 校验（C1，zero LLM）          → invalid_spec
 *   2. specHash / figId 派生（figureStore）
 *   3. 缓存：同 specHash 且 PDF 在盘      → { ok, cached: true }（不探测不编译）
 *   4. xelatex 探测（--version）          → tool_unavailable
 *   5. codegen（C2）→ 隔离临时目录写 .tex
 *   6. xelatex -interaction=nonstopmode -halt-on-error 单遍
 *      - 超时                             → timeout
 *      - spawn 失败                       → tool_unavailable
 *      - 非零退出 + 宏包缺失模式          → package_missing（附宏包名）
 *      - 非零退出（其他）                 → compile_failed（log 中 "!" 错误行摘要）
 *      - 退出 0 但无 PDF / 非 %PDF 魔数   → compile_failed
 *   7. 产物持久化（figureStore）→ manifest lineage
 *   8. 清理临时目录（finally，尽力而为）
 */

import { spawn } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BusinessError,
  FigureCompileFailedError,
  FigureCompileTimeoutError,
  FigurePackageMissingError,
  FigureSpecInvalidError,
  LatexToolUnavailableError,
} from "../errors.js";
import { renderPlotTeX } from "./pgfplotsCodeGen.js";
import {
  computeSpecHash,
  deriveFigId,
  type FigureStore,
  type GeneratedFigureRecord,
} from "./figureStore.js";
import { renderDiagramTeX } from "./tikzCodeGen.js";
import {
  validateDiagramSpec,
  validatePlotSpec,
  type NormalizedDiagramSpec,
  type NormalizedPlotSpec,
} from "./spec.js";

// ---- 命令执行 seam（与 LatexCompiler.CommandRunner 同构；独立实现，见文件头） ----

export type CommandRunner = (
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number },
) => Promise<CommandResult>;

export interface CommandResult {
  /** 进程退出码；null 表示未正常退出（被终止） */
  code: number | null;
  stdout: string;
  stderr: string;
  /** 进程无法启动（如可执行文件不存在） */
  spawnError?: string;
  /** 因超时被强制终止 */
  timedOut?: boolean;
}

/** Windows 上 TeX 工具链可能以 .bat/.cmd 脚本分发，需要 shell 解析 PATHEXT */
const IS_WINDOWS = process.platform === "win32";

function spawnCommand(
  command: string,
  args: readonly string[],
  options: { cwd: string; timeoutMs: number },
): Promise<CommandResult> {
  return new Promise((resolve) => {
    // shell 模式下含空格/特殊字符的参数必须自行加引号
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

/** Windows shell 模式下对含空格/特殊字符的参数加双引号 */
function quoteForWindowsShell(arg: string): string {
  if (/[\s&|<>()^%"]/.test(arg)) {
    return `"${arg.replaceAll('"', '""')}"`;
  }
  return arg;
}

// ---- 错误模型 ----

export type FigureFailureKind =
  | "invalid_spec"
  | "tool_unavailable"
  | "package_missing"
  | "compile_failed"
  | "timeout";

export interface FigureFailure {
  kind: FigureFailureKind;
  /** 人读错误摘要（含定位信息；不吞细节也不倾倒全量日志） */
  message: string;
  /** package_missing 时缺失的宏包名（如 pgfplots） */
  packageName?: string;
  /** log 中 "!" 错误行摘要（编译失败时；上限 5 行 / 300 字符） */
  logExcerpt?: string;
}

export type FigureCompileOutcome =
  | { ok: true; record: GeneratedFigureRecord; cached: boolean }
  | { ok: false; failure: FigureFailure };

/** kind → BusinessError 映射（C4 HTTP 层 / 工作流 stage 分类用） */
export function figureFailureToBusinessError(failure: FigureFailure): BusinessError {
  switch (failure.kind) {
    case "invalid_spec":
      return new FigureSpecInvalidError(failure.message);
    case "tool_unavailable":
      return new LatexToolUnavailableError(failure.message);
    case "package_missing":
      return new FigurePackageMissingError(failure.packageName ?? "未知", failure.message);
    case "compile_failed":
      return new FigureCompileFailedError(failure.message);
    case "timeout":
      return new FigureCompileTimeoutError(failure.message);
  }
}

/**
 * 宏包缺失模式（xelatex stdout/stderr/日志联合扫描）：
 * - MiKTeX / TeX Live 直接形态：! LaTeX Error: File 'pgfplots.sty' not found.
 * - 简写形态：! I can't find file `tikzlibrary...';
 * - TeX Live 间接形态（pgfplots 缺失时 axis 环境未定义）：
 *   ! LaTeX Error: Environment axis undefined.
 */
const PACKAGE_FILE_PATTERNS: readonly RegExp[] = [
  /! LaTeX Error: File [`']([^`']+?\.(?:sty|cls|def|cfg|tikz))' not found/,
  /! I can't find file [`']([^`']+?\.(?:sty|cls|def|cfg|tikz))'/,
];

/** 环境名 → 宏包名（pgfplots/tikz 内的环境缺失即对应宏包缺失） */
const ENVIRONMENT_PACKAGE_MAP: Readonly<Record<string, string>> = {
  axis: "pgfplots",
  semilogxaxis: "pgfplots",
  tikzpicture: "tikz",
};

/** 从失败输出中识别缺失宏包；未命中返回 undefined */
function detectMissingPackage(log: string): string | undefined {
  for (const pattern of PACKAGE_FILE_PATTERNS) {
    const match = log.match(pattern);
    if (match !== null && match[1] !== undefined) {
      // 报文件名 → 归一宏包名（pgfplots.sty → pgfplots）
      return match[1].replace(/\.(sty|cls|def|cfg|tikz)$/, "");
    }
  }
  const envMatch = log.match(/! LaTeX Error: Environment (\w+) undefined/);
  if (envMatch !== null && envMatch[1] !== undefined) {
    return ENVIRONMENT_PACKAGE_MAP[envMatch[1]] ?? `${envMatch[1]}`;
  }
  return undefined;
}

/** log 中 "!" 开头的 LaTeX 错误行摘要（最多 5 行，拼接后 300 字符；无则首个非空 stderr 行） */
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
    .split(/\r?\n/)
    .map((line) => line.trim())
    .find((line) => line !== "");
  return (stderrLine ?? "无明确错误行").slice(0, 300);
}

// ---- 编译器 ----

export interface FigureCompilerOptions {
  /** 单图编译超时（毫秒；pgfplots 单图秒级，默认 60s 足够含 MiKTeX 首次解包） */
  timeoutMs?: number;
  /** 可注入命令执行器（测试用；生产为真实 spawn） */
  runner?: CommandRunner;
  /** 临时构建目录父目录（缺省 os.tmpdir()） */
  buildRootDir?: string;
}

export class FigureCompiler {
  private readonly timeoutMs: number;
  private readonly runner: CommandRunner;
  private readonly buildRootDir: string;

  constructor(options: FigureCompilerOptions = {}) {
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.runner = options.runner ?? spawnCommand;
    this.buildRootDir = options.buildRootDir ?? tmpdir();
  }

  /**
   * 生成（或缓存复用）一张图。kind 与 spec 形状不符（如 kind="plot" 但传入
   * DiagramSpec）→ invalid_spec（双重确认，防调用方拼错）。
   */
  async generate(input: {
    kind: "plot" | "diagram";
    spec: unknown;
    store: FigureStore;
  }): Promise<FigureCompileOutcome> {
    // ---- 1. 校验（zero LLM） ----
    const validation =
      input.kind === "plot" ? validatePlotSpec(input.spec) : validateDiagramSpec(input.spec);
    if (!validation.ok || validation.spec === undefined) {
      return {
        ok: false,
        failure: { kind: "invalid_spec", message: validation.errors.join("；") },
      };
    }
    const spec = validation.spec;

    // ---- 2. 身份派生 ----
    const specHash = computeSpecHash(spec);
    let figId = deriveFigId(specHash);

    // ---- 3. 缓存（同 specHash + PDF 在盘 → 不探测不编译） ----
    const cachedRecord = await input.store.findBySpecHash(specHash);
    if (cachedRecord !== undefined && (await input.store.pdfAssetExists(cachedRecord))) {
      return { ok: true, record: cachedRecord, cached: true };
    }
    // figId 前缀碰撞（同 figId 不同 specHash）：退化为全 hash 形态
    const sameIdRecord = await input.store.get(figId);
    if (sameIdRecord !== undefined && sameIdRecord.specHash !== specHash) {
      figId = `fig-${specHash}`;
    }

    // ---- 4. 工具探测 ----
    if (!(await this.isXelatexAvailable())) {
      return {
        ok: false,
        failure: { kind: "tool_unavailable", message: "xelatex 不可用（PATH 中未找到）" },
      };
    }

    // ---- 5. codegen + 隔离构建目录 ----
    const startedAt = Date.now();
    const tex =
      input.kind === "plot"
        ? renderPlotTeX(spec as NormalizedPlotSpec)
        : renderDiagramTeX(spec as NormalizedDiagramSpec);
    // buildRootDir 允许指向尚不存在的目录（测试注入 / 自定义盘符）——先确保存在
    await mkdir(this.buildRootDir, { recursive: true });
    const buildDir = await mkdtemp(join(this.buildRootDir, "paperteam-figure-"));
    try {
      await writeFile(join(buildDir, `${figId}.tex`), tex, "utf8");

      // ---- 6. xelatex 单遍 ----
      const result = await this.runner("xelatex", [
        "-interaction=nonstopmode",
        "-halt-on-error",
        `${figId}.tex`,
      ], { cwd: buildDir, timeoutMs: this.timeoutMs });

      if (result.timedOut === true) {
        return {
          ok: false,
          failure: { kind: "timeout", message: `图编译超时（${this.timeoutMs}ms）终止` },
        };
      }
      if (result.spawnError !== undefined) {
        return {
          ok: false,
          failure: { kind: "tool_unavailable", message: `xelatex 无法启动：${result.spawnError}` },
        };
      }
      if (result.code !== 0) {
        const log = await this.collectBuildLog(buildDir, figId, result);
        const excerpt = summarizeLogError(log);
        const packageName = detectMissingPackage(log);
        if (packageName !== undefined) {
          return {
            ok: false,
            failure: {
              kind: "package_missing",
              message: `LaTeX 宏包缺失：${packageName}（TeX 发行版需安装该宏包；MiKTeX 可自动安装，TeX Live 见对应包名）`,
              packageName,
              logExcerpt: excerpt,
            },
          };
        }
        return {
          ok: false,
          failure: {
            kind: "compile_failed",
            message: `xelatex exitCode=${result.code}；${excerpt}`,
            logExcerpt: excerpt,
          },
        };
      }

      // 产物校验：存在 + %PDF 魔数
      let pdfBytes: Buffer;
      try {
        pdfBytes = await readFile(join(buildDir, `${figId}.pdf`));
      } catch {
        const log = await this.collectBuildLog(buildDir, figId, result);
        return {
          ok: false,
          failure: {
            kind: "compile_failed",
            message: `编译进程正常退出但没有生成 ${figId}.pdf`,
            logExcerpt: summarizeLogError(log),
          },
        };
      }
      if (pdfBytes.subarray(0, 5).toString("latin1") !== "%PDF-") {
        const log = await this.collectBuildLog(buildDir, figId, result);
        return {
          ok: false,
          failure: {
            kind: "compile_failed",
            message: "产物不是 PDF（%PDF 魔数缺失）",
            logExcerpt: summarizeLogError(log),
          },
        };
      }

      // ---- 7. 持久化 + lineage ----
      const record: GeneratedFigureRecord = {
        figId,
        kind: input.kind,
        specHash,
        ...(input.kind === "plot"
          ? { datasetHash: (spec as NormalizedPlotSpec).data.datasetHash }
          : {}),
        dataOrigin:
          input.kind === "plot"
            ? (spec as NormalizedPlotSpec).data.origin
            : { origin: "manual", note: "DiagramSpec：结构化方法图（无数据集；布局确定性生成）" },
        assets: { tex: `${figId}.tex`, pdf: `${figId}.pdf` },
        caption:
          input.kind === "plot"
            ? ((spec as NormalizedPlotSpec).caption ?? (spec as NormalizedPlotSpec).title ?? "")
            : ((spec as NormalizedDiagramSpec).title ?? ""),
        createdAt: new Date().toISOString(),
        compiler: {
          durationMs: Date.now() - startedAt,
          diagnostics: `xelatex 单遍 exit 0（${(tex.match(/\n/g) ?? []).length + 1} 行 TeX）`,
        },
      };
      const persisted = await input.store.persistFigure({ record, spec, tex, pdfBytes });
      return { ok: true, record: persisted, cached: false };
    } finally {
      // ---- 8. 清理（Windows 句柄延迟释放 → 有限重试） ----
      await rm(buildDir, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }).catch(
        () => undefined,
      );
    }
  }

  /** xelatex --version 探测（Windows cmd 包装脚本可能非零退出但有输出，同 LatexCompiler 口径） */
  private async isXelatexAvailable(): Promise<boolean> {
    try {
      const result = await this.runner("xelatex", ["--version"], {
        cwd: process.cwd(),
        timeoutMs: Math.min(this.timeoutMs, 10_000),
      });
      if (result.spawnError !== undefined) {
        return false;
      }
      return result.code === 0 || (IS_WINDOWS && result.stdout !== "");
    } catch {
      return false;
    }
  }

  /** 汇总编译输出：stdout + stderr + 临时目录里的 .log（真实 xelatex 会写日志文件） */
  private async collectBuildLog(
    buildDir: string,
    figId: string,
    result: CommandResult,
  ): Promise<string> {
    const parts = [result.stdout, result.stderr];
    try {
      parts.push(await readFile(join(buildDir, `${figId}.log`), "utf8"));
    } catch {
      // fake 工具链 / 极早失败时可能没有日志文件
    }
    return parts.join("\n");
  }
}
