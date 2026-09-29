/**
 * Docling 工具链探测：定位可用 Python 解释器并确认 docling 已安装。
 *
 * 与 paper/pdfToolchain.ts 同一模式（候选解释器真实执行探测脚本并缓存；
 * 失败缓存 30s 后允许重试——用户装完依赖无需重启 Backend）。docling 的
 * 首次解析会下载布局 / 表格识别模型（HuggingFace），国内网络可用
 * HF_ENDPOINT=https://hf-mirror.com 镜像——模型落盘后不再联网。
 */

import { execFile } from "node:child_process";

/** 候选解释器（依次探测；PAPERTEAM_DOCLING_PYTHON 指定时只用该值） */
const DEFAULT_CANDIDATES: ReadonlyArray<{ command: string; args: readonly string[] }> = [
  { command: "python", args: [] },
  { command: "python3", args: [] },
  { command: "py", args: ["-3"] },
];

/** 探测脚本（import 指定模块并报告其版本；缺依赖时 module=None） */
function probeScript(module: string): string {
  return (
    "import sys, json\n" +
    "info = {'python': sys.version.split()[0]}\n" +
    "try:\n" +
    `    import ${module}\n` +
    `    info['module'] = getattr(${module}, '__version__', 'unknown')\n` +
    "except ImportError:\n" +
    "    info['module'] = None\n" +
    "print(json.dumps(info))\n"
  );
}

const PROBE_TIMEOUT_MS = 15_000;
const FAILURE_CACHE_MS = 30_000;

export interface DoclingToolchainReady {
  available: true;
  command: string;
  args: readonly string[];
  pythonVersion: string;
  doclingVersion: string;
}

export interface DoclingToolchainMissing {
  available: false;
  reason: "python_missing" | "docling_missing";
  pythonCommand?: string;
  pythonVersion?: string;
  detail: string;
}

export type DoclingToolchainStatus = DoclingToolchainReady | DoclingToolchainMissing;

export interface DoclingToolchainOptions {
  /** PAPERTEAM_DOCLING_PYTHON：显式解释器路径 / 命令 */
  pythonCommand?: string;
  /** 探测时 import 的模块（缺省 docling；测试注入 "json" 以解耦安装状态） */
  probeImport?: string;
  log?: (message: string) => void;
}

/** 面向用户的安装指引（错误消息 / 报告共用） */
export function doclingToolchainHint(status: DoclingToolchainMissing): string {
  if (status.reason === "docling_missing") {
    const py = status.pythonCommand ?? "python";
    return `已找到 Python ${status.pythonVersion ?? ""}（${py}）但缺少 docling，请执行：${py} -m pip install docling（含 torch 依赖，下载量较大）；国内 PyPI 镜像可加 -i https://pypi.tuna.tsinghua.edu.cn/simple`;
  }
  return "未找到 Python 3 解释器。docling 结构化解析需要 Python 3.10+ 并安装 docling（pip install docling），或用 PAPERTEAM_DOCLING_PYTHON 指定解释器；未安装时 PDF 将显式降级为文本层解析。";
}

export class DoclingToolchain {
  private readonly candidates: ReadonlyArray<{ command: string; args: readonly string[] }>;
  private readonly probeImport: string;
  private readonly log: (message: string) => void;
  private cached: { status: DoclingToolchainStatus; at: number } | null = null;
  private inflight: Promise<DoclingToolchainStatus> | null = null;

  constructor(options: DoclingToolchainOptions = {}) {
    const explicit = options.pythonCommand?.trim();
    this.candidates = explicit ? [{ command: explicit, args: [] }] : DEFAULT_CANDIDATES;
    this.probeImport = options.probeImport ?? "docling";
    this.log = options.log ?? (() => {});
  }

  resolve(): Promise<DoclingToolchainStatus> {
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

  private async probeAll(): Promise<DoclingToolchainStatus> {
    let pythonWithoutDocling: { command: string; version: string } | null = null;
    for (const candidate of this.candidates) {
      const probe = await this.probe(candidate.command, candidate.args);
      if (probe === null) {
        continue;
      }
      if (probe.module !== null) {
        this.log(
          `[docling-toolchain] 就绪：${candidate.command} (Python ${probe.python}, ${this.probeImport} ${probe.module})`,
        );
        return {
          available: true,
          command: candidate.command,
          args: candidate.args,
          pythonVersion: probe.python,
          doclingVersion: probe.module,
        };
      }
      pythonWithoutDocling ??= { command: candidate.command, version: probe.python };
    }
    const status: DoclingToolchainMissing =
      pythonWithoutDocling !== null
        ? {
            available: false,
            reason: "docling_missing",
            pythonCommand: pythonWithoutDocling.command,
            pythonVersion: pythonWithoutDocling.version,
            detail: "",
          }
        : { available: false, reason: "python_missing", detail: "" };
    status.detail = doclingToolchainHint(status);
    this.log(`[docling-toolchain] 不可用（${status.reason}）：${status.detail}`);
    return status;
  }

  private probe(
    command: string,
    args: readonly string[],
  ): Promise<{ python: string; module: string | null } | null> {
    const script = probeScript(this.probeImport);
    return new Promise((resolvePromise) => {
      execFile(
        command,
        [...args, "-c", script],
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
            const parsed = JSON.parse(lastLine) as { python?: unknown; module?: unknown };
            if (typeof parsed.python !== "string") {
              resolvePromise(null);
              return;
            }
            resolvePromise({
              python: parsed.python,
              module: typeof parsed.module === "string" ? parsed.module : null,
            });
          } catch {
            resolvePromise(null);
          }
        },
      );
    });
  }
}
