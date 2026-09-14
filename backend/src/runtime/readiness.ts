/**
 * Readiness（M5.5）：区分「进程活着」（/health）与「PaperTeam 真正可工作」（/ready）。
 *
 * 检查项（全部廉价，不调用模型）：
 *   runtime     AgentRuntime.healthCheck（Runtime 可初始化 / 已初始化；≠ 模型就绪）
 *   filesystem  PROJECTS_ROOT / PAPERTEAM_RUNTIME_ROOT 可创建、可写（写入并删除探针文件）
 *   latex       latexmk / xelatex 是否可用（版本探测，结果缓存 cacheMs，不每次 spawn）
 *   pdf         Python + pymupdf 工具链（PdfToolchain 自带缓存）
 *
 * ready = runtime ok && filesystem ok。TeX / Python 缺失是「降级」（Draft 构建 / PDF
 * 导入会以结构化 503/422 失败），不是不可服务——记入 degraded 数组如实暴露。
 */

import { access, mkdir, rm, writeFile } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";

import type { AgentRuntime } from "./types.js";

export interface ReadinessPath {
  label: string;
  path: string;
}

export interface ReadinessOptions {
  runtime: AgentRuntime;
  paths: readonly ReadinessPath[];
  /** LaTeX 工具探测（LatexCompiler.detectTool；缺省视为未配置 → degraded） */
  latex?: { detectTool(): Promise<string> };
  /** PDF 工具链探测（PdfParser.checkAvailability；缺省视为未配置 → degraded） */
  pdfParser?: { checkAvailability(): Promise<{ available: boolean; detail?: string }> };
  /** latex 探测结果缓存（毫秒；默认 60s） */
  cacheMs?: number;
  now?: () => number;
}

export interface ReadinessReport {
  ready: boolean;
  checkedAt: string;
  checks: {
    runtime: { ok: boolean; status: string; detail: string };
    filesystem: Array<{ label: string; path: string; ok: boolean; detail: string }>;
    latex: { ok: boolean; tool: string | null; detail: string; cached: boolean };
    pdf: { ok: boolean; detail: string };
  };
  /** 不阻塞 ready 但影响能力的降级项 */
  degraded: string[];
}

export class ReadinessProbe {
  private readonly runtime: AgentRuntime;
  private readonly paths: readonly ReadinessPath[];
  private readonly latex: ReadinessOptions["latex"];
  private readonly pdfParser: ReadinessOptions["pdfParser"];
  private readonly cacheMs: number;
  private readonly now: () => number;
  private latexCache: { at: number; result: ReadinessReport["checks"]["latex"] } | undefined;

  constructor(options: ReadinessOptions) {
    this.runtime = options.runtime;
    this.paths = options.paths;
    this.latex = options.latex;
    this.pdfParser = options.pdfParser;
    this.cacheMs = options.cacheMs ?? 60_000;
    this.now = options.now ?? (() => Date.now());
  }

  async check(): Promise<ReadinessReport> {
    const [runtime, filesystem, latex, pdf] = await Promise.all([
      this.checkRuntime(),
      Promise.all(this.paths.map((entry) => this.checkPath(entry))),
      this.checkLatex(),
      this.checkPdf(),
    ]);
    const degraded: string[] = [];
    if (!latex.ok) {
      degraded.push(`latex: ${latex.detail}`);
    }
    if (!pdf.ok) {
      degraded.push(`pdf: ${pdf.detail}`);
    }
    return {
      ready: runtime.ok && filesystem.every((entry) => entry.ok),
      checkedAt: new Date(this.now()).toISOString(),
      checks: { runtime, filesystem, latex, pdf },
      degraded,
    };
  }

  private async checkRuntime(): Promise<ReadinessReport["checks"]["runtime"]> {
    try {
      const health = await this.runtime.healthCheck();
      return { ok: health.ok, status: health.status, detail: health.detail };
    } catch (error) {
      return { ok: false, status: "unknown", detail: error instanceof Error ? error.message : String(error) };
    }
  }

  private async checkPath(entry: ReadinessPath): Promise<ReadinessReport["checks"]["filesystem"][number]> {
    const probe = join(entry.path, `.paperteam-ready-${process.pid}`);
    try {
      await mkdir(entry.path, { recursive: true });
      await access(entry.path, constants.W_OK);
      await writeFile(probe, String(this.now()), "utf8");
      await rm(probe, { force: true });
      return { label: entry.label, path: entry.path, ok: true, detail: "writable" };
    } catch (error) {
      await rm(probe, { force: true }).catch(() => {});
      return {
        label: entry.label,
        path: entry.path,
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  }

  private async checkLatex(): Promise<ReadinessReport["checks"]["latex"]> {
    if (this.latex === undefined) {
      return { ok: false, tool: null, detail: "LaTeX 编译器未配置", cached: false };
    }
    const nowMs = this.now();
    if (this.latexCache !== undefined && nowMs - this.latexCache.at < this.cacheMs) {
      return { ...this.latexCache.result, cached: true };
    }
    let result: ReadinessReport["checks"]["latex"];
    try {
      const tool = await this.latex.detectTool();
      result = { ok: true, tool, detail: `${tool} 可用`, cached: false };
    } catch (error) {
      result = { ok: false, tool: null, detail: error instanceof Error ? error.message : String(error), cached: false };
    }
    this.latexCache = { at: nowMs, result };
    return result;
  }

  private async checkPdf(): Promise<ReadinessReport["checks"]["pdf"]> {
    if (this.pdfParser === undefined) {
      return { ok: false, detail: "PDF 解析器未配置" };
    }
    try {
      const status = await this.pdfParser.checkAvailability();
      return { ok: status.available, detail: status.available ? "python + pymupdf 可用" : (status.detail ?? "不可用") };
    } catch (error) {
      return { ok: false, detail: error instanceof Error ? error.message : String(error) };
    }
  }
}
