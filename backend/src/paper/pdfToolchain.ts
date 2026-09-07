/**
 * PDF 解析工具链探测：定位可用的 Python 解释器并确认 pymupdf 已安装。
 *
 * Windows 上 `python` 不一定在 PATH（也可能是 Microsoft Store 的占位 stub，
 * 启动即退出并提示去商店安装），因此按候选顺序真实执行 `import pymupdf`
 * 探测一次并缓存结果；探测失败缓存一小段时间后允许重试（用户装完依赖
 * 无需重启 Backend）。业务层拿到的是结构化状态，而不是 spawn ENOENT。
 */

import { execFile } from "node:child_process";

/** 候选解释器（依次探测；PAPERTEAM_PDF_PYTHON 指定时只用该值） */
const DEFAULT_CANDIDATES: ReadonlyArray<{ command: string; args: readonly string[] }> = [
  { command: "python", args: [] },
  { command: "python3", args: [] },
  { command: "py", args: ["-3"] },
];

const PROBE_SCRIPT =
  "import sys, json\n" +
  "info = {'python': sys.version.split()[0]}\n" +
  "try:\n" +
  "    import pymupdf\n" +
  "    info['pymupdf'] = getattr(pymupdf, '__version__', 'unknown')\n" +
  "except ImportError:\n" +
  "    info['pymupdf'] = None\n" +
  "print(json.dumps(info))\n";

const PROBE_TIMEOUT_MS = 15_000;
/** 失败结果缓存时长：期间不重复 spawn，过后允许重新探测 */
const FAILURE_CACHE_MS = 30_000;

export interface PdfToolchainReady {
  available: true;
  command: string;
  args: readonly string[];
  pythonVersion: string;
  pymupdfVersion: string;
}

export interface PdfToolchainMissing {
  available: false;
  /** python_missing：所有候选都无法执行；pymupdf_missing：有 Python 但缺 pymupdf */
  reason: "python_missing" | "pymupdf_missing";
  /** 找到但缺 pymupdf 的解释器（用于给出精确安装命令） */
  pythonCommand?: string;
  pythonVersion?: string;
  detail: string;
}

export type PdfToolchainStatus = PdfToolchainReady | PdfToolchainMissing;

export interface PdfToolchainOptions {
  /** PAPERTEAM_PDF_PYTHON：显式解释器路径 / 命令（含空格路径直接传，不经 shell） */
  pythonCommand?: string;
  log?: (message: string) => void;
}

/** 面向用户的安装指引（错误消息 / doctor 共用） */
export function pdfToolchainHint(status: PdfToolchainMissing): string {
  if (status.reason === "pymupdf_missing") {
    const py = status.pythonCommand ?? "python";
    return `已找到 Python ${status.pythonVersion ?? ""}（${py}）但缺少 pymupdf，请执行：${py} -m pip install pymupdf`;
  }
  return "未找到 Python 3 解释器。请安装 Python 3.10+（https://www.python.org/downloads/）并执行 pip install pymupdf；或用 PAPERTEAM_PDF_PYTHON 指定解释器路径。";
}

export class PdfToolchain {
  private readonly candidates: ReadonlyArray<{ command: string; args: readonly string[] }>;
  private readonly log: (message: string) => void;
  private cached: { status: PdfToolchainStatus; at: number } | null = null;
  private inflight: Promise<PdfToolchainStatus> | null = null;

  constructor(options: PdfToolchainOptions = {}) {
    const explicit = options.pythonCommand?.trim();
    this.candidates = explicit ? [{ command: explicit, args: [] }] : DEFAULT_CANDIDATES;
    this.log = options.log ?? (() => {});
  }

  /** 解析工具链状态（成功永久缓存；失败缓存 FAILURE_CACHE_MS 后可重探） */
  resolve(): Promise<PdfToolchainStatus> {
    if (this.cached !== null) {
      const fresh = this.cached.status.available || Date.now() - this.cached.at < FAILURE_CACHE_MS;
      if (fresh) {
        return Promise.resolve(this.cached.status);
      }
    }
    if (this.inflight === null) {
      this.inflight = this.probeAll()
        .then((status) => {
          this.cached = { status, at: Date.now() };
          return status;
        })
        .finally(() => {
          this.inflight = null;
        });
    }
    return this.inflight;
  }

  private async probeAll(): Promise<PdfToolchainStatus> {
    let pythonWithoutPymupdf: { command: string; version: string } | null = null;
    for (const candidate of this.candidates) {
      const probe = await this.probe(candidate.command, candidate.args);
      if (probe === null) {
        continue;
      }
      if (probe.pymupdf !== null) {
        const status: PdfToolchainReady = {
          available: true,
          command: candidate.command,
          args: candidate.args,
          pythonVersion: probe.python,
          pymupdfVersion: probe.pymupdf,
        };
        this.log(
          `[pdf-toolchain] 就绪：${candidate.command} ${candidate.args.join(" ")} (Python ${probe.python}, pymupdf ${probe.pymupdf})`,
        );
        return status;
      }
      pythonWithoutPymupdf ??= { command: candidate.command, version: probe.python };
    }
    const status: PdfToolchainMissing =
      pythonWithoutPymupdf !== null
        ? {
            available: false,
            reason: "pymupdf_missing",
            pythonCommand: pythonWithoutPymupdf.command,
            pythonVersion: pythonWithoutPymupdf.version,
            detail: "",
          }
        : { available: false, reason: "python_missing", detail: "" };
    status.detail = pdfToolchainHint(status);
    this.log(`[pdf-toolchain] 不可用（${status.reason}）：${status.detail}`);
    return status;
  }

  /** 单个候选：能执行且输出合法 JSON 视为可用解释器（pymupdf 可缺） */
  private probe(
    command: string,
    args: readonly string[],
  ): Promise<{ python: string; pymupdf: string | null } | null> {
    return new Promise((resolvePromise) => {
      execFile(
        command,
        [...args, "-c", PROBE_SCRIPT],
        {
          timeout: PROBE_TIMEOUT_MS,
          windowsHide: true,
          encoding: "utf8",
          env: { ...process.env, PYTHONIOENCODING: "utf8", PYTHONDONTWRITEBYTECODE: "1" },
        },
        (error, stdout) => {
          if (error !== null) {
            resolvePromise(null);
            return;
          }
          const lastLine = stdout.trim().split(/\r?\n/).pop() ?? "";
          try {
            const parsed = JSON.parse(lastLine) as { python?: unknown; pymupdf?: unknown };
            if (typeof parsed.python !== "string") {
              resolvePromise(null);
              return;
            }
            resolvePromise({
              python: parsed.python,
              pymupdf: typeof parsed.pymupdf === "string" ? parsed.pymupdf : null,
            });
          } catch {
            resolvePromise(null);
          }
        },
      );
    });
  }
}
