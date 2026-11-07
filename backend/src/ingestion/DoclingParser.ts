/**
 * DoclingAdapter（M10.1B 生产 Adapter）：PDF → DocumentExtraction。
 *
 * 纪律与 paper/PdfParser.ts（PyMuPdfParser）完全一致：
 * - child_process.execFile（无 shell，无注入面）；参数只有脚本绝对路径、
 *   PDF 绝对路径与 flag；
 * - 解释器由 DoclingToolchain 探测（PAPERTEAM_DOCLING_PYTHON > python >
 *   python3 > py -3）；
 * - PYTHONIOENCODING=utf-8；maxBuffer（默认 128MB）；
 * - 协议：stdout 最后一行非空 JSON；其余输出只进日志。
 *
 * M17.2.2 解析可靠性（evidence.ground 冷启动 / 超时收口）：
 * - 模型资源预检与首次下载（warmup）独立于文档解析计时、报错；模型已缓存时
 *   解析子进程离线运行（HF_HUB_OFFLINE=1），不再每篇联网核对模型版本；
 * - 超时分层：无进展上限（stderr 进度行续期）+ 单篇总时长上限 + 取消；三类
 *   终止都 kill 子进程，promise 在子进程退出后才 settle；
 * - 进度经 DocumentParseOptions.onProgress 上报，供上游 stage watchdog 续期。
 *
 * 业务层只见 DocumentParser 接口与 DocumentExtraction——未来换 MinerU
 * 只替换本 adapter，不触碰存储 / Evidence / 检索层。
 */

import { execFile } from "node:child_process";
import { basename } from "node:path";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import {
  DocumentParseFailedError,
  DocumentParserUnavailableError,
} from "../errors.js";
import { DOCLING_DEFAULT_LIMITS } from "./doclingLimits.js";
import { DoclingToolchain, doclingToolchainHint, type DoclingToolchainStatus } from "./DoclingToolchain.js";
import type {
  BBox,
  DocumentExtraction,
  DocumentParseOptions,
  DocumentParseProgress,
  DocumentParser,
  ExtractionBlock,
  ParsedProvenance,
} from "./types.js";

export interface DoclingParserOptions {
  /** Python 解释器（PAPERTEAM_DOCLING_PYTHON；缺省自动探测） */
  pythonCommand?: string;
  /** 解析脚本路径（默认 backend/tools/parse_document_docling.py；测试指 fixture） */
  scriptPath?: string;
  /** 探测 import 的模块（缺省 docling；测试注入 "json" 解耦安装状态） */
  probeImport?: string;
  /** 单篇解析总时长硬上限（PAPERTEAM_DOCLING_TIMEOUT_MS） */
  timeoutMs?: number;
  /**
   * 单篇解析无进展上限（PAPERTEAM_DOCLING_IDLE_TIMEOUT_MS；M17.2.2）：子进程
   * 超过该时长没有报告任何真实进度（docling 流水线某 stage 完成一批页面）即终止。
   * 有进展的长文档不被固定预算误杀，卡死的解析仍有界失败。
   */
  idleTimeoutMs?: number;
  /**
   * 模型资源预检（PAPERTEAM_DOCLING_MODEL_PREFLIGHT；生产开启，fake 脚本测试缺省关）：
   * 首次解析前离线检查布局 / 表格模型是否已在 HuggingFace 缓存；已缓存 → 解析子进程
   * HF_HUB_OFFLINE=1（不再每篇联网核对模型版本）；未缓存 → 独立的 warmup 下载
   * （waiting_for_dependency，单独计时、单独报错），不占用文档解析预算。
   */
  modelPreflight?: boolean;
  /** 首次模型下载（warmup）的总时长上限（PAPERTEAM_DOCLING_WARMUP_TIMEOUT_MS） */
  warmupTimeoutMs?: number;
  /** 离线预检上限（缺省 DOCLING_DEFAULT_LIMITS.preflightTimeoutMs；测试注入短值） */
  preflightTimeoutMs?: number;
  maxBufferBytes?: number;
  /**
   * 解析子进程的进程级并发上限（PAPERTEAM_DOCLING_CONCURRENCY；默认 1）。
   * docling 是 CPU/内存密集（torch）子进程：显式 ingest 与后台链并行到达时
   * 由本信号量收敛为逐个执行，避免 N 个 torch 同时争抢（M12.2.5）。
   */
  maxConcurrency?: number;
  log?: (message: string) => void;
}

/** 工具脚本默认位置（backend/tools/，与 src、dist 的相对关系相同） */
export function defaultDoclingScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "tools", "parse_document_docling.py");
}

const NOISE_LOG_CHARS = 500;

/** stderr 进度协议行前缀（parse_document_docling.py emit_progress） */
const PROGRESS_PREFIX = "PAPERTEAM_PROGRESS ";

/** 模型资源状态：unchecked → ready（离线解析）/ unknown（预检不可判定，按旧行为联网解析） */
export type DoclingModelState = "unchecked" | "ready" | "unknown";

export interface DoclingModelPreflight {
  state: DoclingModelState;
  /** 预检时发现缺失、随后由 warmup 下载完成 */
  downloaded: boolean;
  detail: string;
}

interface DoclingProgressEvent {
  phase: string;
  stage?: string;
  pages?: number[];
  model?: string;
}

interface RunLimits {
  hardMs: number;
  idleMs?: number;
  /** 子进程 HF_HUB_OFFLINE=1（用户显式设置的 HF_HUB_OFFLINE 优先） */
  offline: boolean;
  signal?: AbortSignal;
  onProgress?: (event: DoclingProgressEvent) => void;
}

export class DoclingParser implements DocumentParser {
  readonly id = "docling";
  private readonly toolchain: DoclingToolchain;
  private readonly scriptPath: string;
  private readonly timeoutMs: number;
  private readonly idleTimeoutMs: number;
  private readonly warmupTimeoutMs: number;
  private readonly preflightTimeoutMs: number;
  private readonly modelPreflight: boolean;
  private readonly maxBufferBytes: number;
  private readonly maxConcurrency: number;
  private readonly log: (message: string) => void;
  /** 信号量状态：在途解析数 + FIFO 等待者（maxConcurrency 收敛 torch 并发） */
  private activeParses = 0;
  private readonly parseWaiters: Array<() => void> = [];
  private modelState: DoclingModelState = "unchecked";
  /** 在途预检 / warmup（并发解析共享同一次，不重复下载同一模型） */
  private modelCheck: Promise<DoclingModelPreflight> | null = null;

  constructor(options: DoclingParserOptions = {}) {
    this.log = options.log ?? (() => {});
    this.toolchain = new DoclingToolchain({
      ...(options.pythonCommand !== undefined ? { pythonCommand: options.pythonCommand } : {}),
      ...(options.probeImport !== undefined ? { probeImport: options.probeImport } : {}),
      log: this.log,
    });
    this.scriptPath = resolve(options.scriptPath ?? defaultDoclingScriptPath());
    this.timeoutMs = options.timeoutMs ?? DOCLING_DEFAULT_LIMITS.timeoutMs;
    this.idleTimeoutMs = options.idleTimeoutMs ?? DOCLING_DEFAULT_LIMITS.idleTimeoutMs;
    this.warmupTimeoutMs = options.warmupTimeoutMs ?? DOCLING_DEFAULT_LIMITS.warmupTimeoutMs;
    this.preflightTimeoutMs = options.preflightTimeoutMs ?? DOCLING_DEFAULT_LIMITS.preflightTimeoutMs;
    this.modelPreflight = options.modelPreflight ?? false;
    this.maxBufferBytes = options.maxBufferBytes ?? 128 * 1024 * 1024;
    this.maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency ?? 1));
  }

  checkAvailability(): Promise<DoclingToolchainStatus> {
    return this.toolchain.resolve();
  }

  /** 当前模型资源状态（只读；诊断 / 启动日志用） */
  get modelResourceState(): DoclingModelState {
    return this.modelState;
  }

  /**
   * 模型资源预检（必要时 warmup 下载）。幂等：ready 后直接返回；并发调用共享
   * 同一次检查。失败（下载失败 / 依赖缺失）抛 DocumentParserUnavailableError——
   * 这是依赖问题，不是 PDF 内容问题；失败不缓存，下次解析重新预检。
   */
  ensureModels(options: { onProgress?: (progress: DocumentParseProgress) => void } = {}): Promise<DoclingModelPreflight> {
    if (!this.modelPreflight || this.modelState !== "unchecked") {
      return Promise.resolve({ state: this.modelState, downloaded: false, detail: "" });
    }
    this.modelCheck ??= this.checkModels(options.onProgress).finally(() => {
      this.modelCheck = null;
    });
    return this.modelCheck;
  }

  async parseFile(
    absolutePath: string,
    options: DocumentParseOptions = {},
  ): Promise<DocumentExtraction> {
    const toolchain = await this.toolchain.resolve();
    if (!toolchain.available) {
      throw new DocumentParserUnavailableError(doclingToolchainHint(toolchain));
    }
    options.signal?.throwIfAborted();
    const fileName = basename(absolutePath);
    const args = [
      resolve(absolutePath),
      ...(options.figuresDir !== undefined ? [`--figures-dir=${resolve(options.figuresDir)}`] : []),
      ...(options.formulas === true ? ["--formulas"] : []),
    ];
    const queuedAt = Date.now();
    await this.acquireParseSlot(options.signal);
    const slotAt = Date.now();
    let startedAt = slotAt;
    try {
      await this.ensureModels(options.onProgress !== undefined ? { onProgress: options.onProgress } : {});
      startedAt = Date.now();
      // 公式 enrichment 需额外模型（不在预检范围）：保持联网解析
      const offline = this.modelState === "ready" && options.formulas !== true;
      this.log(
        `[docling] 开始解析 ${fileName}（排队 ${slotAt - queuedAt}ms；模型预检 / 下载 ${startedAt - slotAt}ms；模型资源 ${this.modelState}；` +
          `${offline ? "离线" : "联网"}；无进展上限 ${this.idleTimeoutMs}ms / 总上限 ${this.timeoutMs}ms）`,
      );
      const stdout = await this.run(toolchain.command, toolchain.args, args, {
        hardMs: this.timeoutMs,
        idleMs: this.idleTimeoutMs,
        offline,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        ...(options.onProgress !== undefined
          ? { onProgress: (event: DoclingProgressEvent) => options.onProgress?.({ state: "parsing", detail: describeProgress(event) }) }
          : {}),
      });
      const extraction = this.validate(stdout, fileName);
      this.log(
        `[docling] 解析完成 ${fileName}（${Date.now() - startedAt}ms；${extraction.pageCount ?? "?"} 页；块 ${extraction.blocks.length}）`,
      );
      return extraction;
    } catch (error) {
      if (options.signal?.aborted !== true) {
        this.log(`[docling] 解析失败 ${fileName}（${Date.now() - startedAt}ms）：${errorText(error).slice(0, 200)}`);
      }
      throw error;
    } finally {
      this.releaseParseSlot();
    }
  }

  private async checkModels(
    onProgress?: (progress: DocumentParseProgress) => void,
  ): Promise<DoclingModelPreflight> {
    const toolchain = await this.toolchain.resolve();
    if (!toolchain.available) {
      throw new DocumentParserUnavailableError(doclingToolchainHint(toolchain));
    }
    onProgress?.({ state: "waiting_for_dependency", detail: "preflight" });
    let preflight: ModelReport;
    try {
      preflight = parseModelReport(
        await this.run(toolchain.command, toolchain.args, ["--preflight"], {
          hardMs: this.preflightTimeoutMs,
          offline: true,
        }),
      );
    } catch (error) {
      // 预检自身失败（超时 / 崩溃）不是文档问题，也不证明模型缺失：本次按旧行为联网解析
      // （解析仍受分层上限约束），状态保持 unchecked，下次解析重新预检
      this.log(`[docling] 模型资源预检失败，本次按联网模式解析：${errorText(error).slice(0, 200)}`);
      return { state: "unknown", downloaded: false, detail: errorText(error) };
    }
    if (preflight.code === "models_ready") {
      this.modelState = "ready";
      this.log(`[docling] 模型资源就绪（离线缓存命中：${preflight.detail}）`);
      return { state: "ready", downloaded: false, detail: preflight.detail };
    }
    if (preflight.code === "dependency_missing") {
      throw new DocumentParserUnavailableError(preflight.detail);
    }
    if (preflight.code !== "models_missing") {
      // 预检不可判定（脚本版本不符 / 协议外输出）：不阻断，按旧行为联网解析
      this.modelState = "unknown";
      this.log(`[docling] 模型资源预检不可判定，按联网模式解析：${preflight.detail.slice(0, 200)}`);
      return { state: "unknown", downloaded: false, detail: preflight.detail };
    }
    const startedAt = Date.now();
    this.log(`[docling] WAITING_FOR_DEPENDENCY 模型资源未缓存，开始首次下载（上限 ${this.warmupTimeoutMs}ms）：${preflight.detail}`);
    onProgress?.({ state: "waiting_for_dependency", detail: `warmup ${preflight.detail}` });
    let warmup: ModelReport;
    try {
      warmup = parseModelReport(
        await this.run(toolchain.command, toolchain.args, ["--warmup"], {
          hardMs: this.warmupTimeoutMs,
          offline: false,
          onProgress: (event) => onProgress?.({ state: "waiting_for_dependency", detail: describeProgress(event) }),
        }),
      );
    } catch (error) {
      throw new DocumentParserUnavailableError(modelDownloadHint(errorText(error)));
    }
    if (warmup.code !== "models_ready") {
      throw new DocumentParserUnavailableError(modelDownloadHint(warmup.detail));
    }
    this.modelState = "ready";
    this.log(`[docling] 模型资源首次下载完成（${Date.now() - startedAt}ms）：${warmup.detail}`);
    return { state: "ready", downloaded: true, detail: warmup.detail };
  }

  /** FIFO 信号量：超并发上限时排队（不失败——上游已有 source 级去重/串行链）；排队中取消即退出 */
  private acquireParseSlot(signal?: AbortSignal): Promise<void> {
    if (this.activeParses < this.maxConcurrency) {
      this.activeParses += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolvePromise, rejectPromise) => {
      const waiter = () => {
        signal?.removeEventListener("abort", onAbort);
        this.activeParses += 1;
        resolvePromise();
      };
      const onAbort = () => {
        const index = this.parseWaiters.indexOf(waiter);
        if (index >= 0) {
          this.parseWaiters.splice(index, 1);
        }
        rejectPromise(signal?.reason ?? new Error("aborted"));
      };
      signal?.addEventListener("abort", onAbort, { once: true });
      this.parseWaiters.push(waiter);
    });
  }

  private releaseParseSlot(): void {
    this.activeParses -= 1;
    const next = this.parseWaiters.shift();
    if (next !== undefined) {
      next();
    }
  }

  /**
   * 子进程执行。三类终止各自报错：总时长上限、无进展上限、取消（signal.reason）。
   * 任何终止路径都 kill 子进程，且 promise 只在子进程退出、stdio 关闭后才 settle——
   * 信号量释放时不遗留在跑的 torch 进程。
   */
  private run(
    command: string,
    prefixArgs: readonly string[],
    args: readonly string[],
    limits: RunLimits,
  ): Promise<string> {
    return new Promise<string>((resolvePromise, rejectPromise) => {
      let stopReason: "hard" | "idle" | "abort" | null = null;
      let lastProgress = "尚无进度";
      let idleTimer: NodeJS.Timeout | undefined;
      const env: NodeJS.ProcessEnv = { ...process.env, PYTHONIOENCODING: "utf8", PYTHONDONTWRITEBYTECODE: "1" };
      if (limits.offline && process.env["HF_HUB_OFFLINE"] === undefined) {
        env["HF_HUB_OFFLINE"] = "1";
      }
      const onAbort = () => stop("abort");
      const child = execFile(
        command,
        [...prefixArgs, this.scriptPath, ...args],
        {
          maxBuffer: this.maxBufferBytes,
          windowsHide: true,
          encoding: "utf8",
          env,
        },
        (error, stdout, stderr) => {
          clearTimeout(hardTimer);
          clearTimeout(idleTimer);
          limits.signal?.removeEventListener("abort", onAbort);
          const noise = stderr
            .split(/\r?\n/)
            .filter((line) => !line.startsWith(PROGRESS_PREFIX))
            .join("\n")
            .trim();
          if (noise !== "") {
            this.log(`[docling] stderr: ${noise.slice(0, NOISE_LOG_CHARS)}`);
          }
          if (stopReason === "abort") {
            rejectPromise(limits.signal?.reason ?? new Error("aborted"));
            return;
          }
          if (stopReason === "hard") {
            rejectPromise(
              new DocumentParseFailedError(`解析总时长超过上限（${limits.hardMs}ms；最后进度：${lastProgress}）`),
            );
            return;
          }
          if (stopReason === "idle") {
            rejectPromise(
              new DocumentParseFailedError(
                `解析无进展超时（${limits.idleMs ?? 0}ms 内没有新的解析进度；最后进度：${lastProgress}）`,
              ),
            );
            return;
          }
          if (error === null) {
            resolvePromise(stdout);
            return;
          }
          const { code } = error as { code?: string | number };
          if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            rejectPromise(
              new DocumentParseFailedError(`解析输出超过 ${this.maxBufferBytes} 字节上限（文档过大）`),
            );
            return;
          }
          if (code === "ENOENT") {
            rejectPromise(
              new DocumentParserUnavailableError(`解释器 ${command} 无法执行（可能已被卸载，请重新检查安装）`),
            );
            return;
          }
          // 非零退出：脚本已尽力输出结构化 JSON，交给 validate 归一
          if (stdout.trim() !== "") {
            resolvePromise(stdout);
            return;
          }
          rejectPromise(
            new DocumentParseFailedError(
              `解析器进程异常退出（code=${String(code ?? "?")}）`,
              stderr.trim().slice(0, NOISE_LOG_CHARS),
            ),
          );
        },
      );
      function stop(reason: "hard" | "idle" | "abort"): void {
        if (stopReason !== null) {
          return;
        }
        stopReason = reason;
        child.kill();
      }
      const armIdle = () => {
        if (limits.idleMs === undefined) {
          return;
        }
        clearTimeout(idleTimer);
        idleTimer = setTimeout(() => stop("idle"), limits.idleMs);
      };
      const hardTimer = setTimeout(() => stop("hard"), limits.hardMs);
      armIdle();
      if (limits.signal?.aborted === true) {
        stop("abort");
      } else {
        limits.signal?.addEventListener("abort", onAbort, { once: true });
      }
      let pending = "";
      child.stderr?.on("data", (chunk: string | Buffer) => {
        pending += String(chunk);
        const lines = pending.split(/\r?\n|\r/);
        pending = lines.pop() ?? "";
        for (const line of lines) {
          const event = parseProgressLine(line);
          if (event === null) {
            continue;
          }
          lastProgress = describeProgress(event);
          armIdle();
          try {
            limits.onProgress?.(event);
          } catch {
            // 心跳回调失败不影响解析
          }
        }
      });
    });
  }

  /** stdout 协议校验：最后一行非空 JSON；结构不符 / 工具自报失败 → 结构化错误 */
  private validate(stdout: string, fileName: string): DocumentExtraction {
    const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
    const payloadLine = lines.pop() ?? "";
    if (lines.length > 0) {
      this.log(`[docling] 非协议输出已忽略：${lines.join(" | ").slice(0, NOISE_LOG_CHARS)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payloadLine);
    } catch {
      throw new DocumentParseFailedError("解析器输出了非法 JSON（协议错误）", payloadLine.slice(0, NOISE_LOG_CHARS));
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new DocumentParseFailedError("解析器输出不是 JSON 对象");
    }
    const record = parsed as Record<string, unknown>;
    if (record["ok"] !== true) {
      const detail = typeof record["error"] === "string" ? record["error"] : "未知错误";
      if (record["code"] === "dependency_missing") {
        throw new DocumentParserUnavailableError(detail);
      }
      if (record["code"] === "model_unavailable") {
        // 离线解析时模型缓存缺失 / 损坏：依赖问题而非 PDF 内容问题；下次解析重新预检
        this.modelState = "unchecked";
        throw new DocumentParserUnavailableError(`docling 模型资源不可用（${detail}）`);
      }
      throw new DocumentParseFailedError(detail);
    }
    const blocks = record["blocks"];
    if (!Array.isArray(blocks)) {
      throw new DocumentParseFailedError("解析器输出缺少 blocks 字段");
    }
    const parser = isRecord(record["parser"]) ? record["parser"] : {};
    const mapped: ExtractionBlock[] = [];
    let truncated = false;
    let seq = 0;
    for (const raw of blocks) {
      if (!isRecord(raw)) {
        continue;
      }
      seq += 1;
      const block = mapBlock(raw, fileName, `B${String(seq).padStart(4, "0")}`);
      if (block !== null) {
        mapped.push(block);
        if (mapped.length >= 20_000) {
          truncated = true;
          break;
        }
      }
    }
    const notes = Array.isArray(record["notes"])
      ? record["notes"].filter((note): note is string => typeof note === "string").slice(0, 20)
      : [];
    if (truncated) {
      notes.push("块数达到上限 20000，已截断");
    }
    return {
      parser: {
        id: "docling",
        ...(typeof parser["version"] === "string" ? { version: parser["version"] } : {}),
      },
      mode: "structured",
      quality: notes.length > 0 ? "partial" : "full",
      ...(typeof record["pageCount"] === "number" && record["pageCount"] > 0
        ? { pageCount: record["pageCount"] }
        : {}),
      blocks: mapped,
      notes,
    };
  }
}

/** 协议块 → ExtractionBlock（字段级校验；不合法块跳过，不整体失败） */
function mapBlock(raw: Record<string, unknown>, fileName: string, blockId: string): ExtractionBlock | null {
  const provenance = mapProvenance(raw, fileName);
  switch (raw["type"]) {
    case "text": {
      const text = typeof raw["text"] === "string" ? raw["text"] : "";
      if (text.trim() === "") {
        return null;
      }
      const textKind = typeof raw["textKind"] === "string" ? raw["textKind"] : "paragraph";
      return {
        blockId,
        type: "text",
        provenance,
        text,
        ...(isTextKind(textKind) ? { textKind } : {}),
      };
    }
    case "table": {
      const headers = stringArray(raw["headers"]);
      const rows = Array.isArray(raw["rows"])
        ? raw["rows"].filter(Array.isArray).map((row) => row.map((cell) => String(cell ?? "")))
        : [];
      const textFallback = typeof raw["textFallback"] === "string" ? raw["textFallback"] : undefined;
      if (headers.length === 0 && rows.length === 0 && textFallback === undefined) {
        return null;
      }
      return {
        blockId,
        type: "table",
        provenance,
        ...(typeof raw["caption"] === "string" && raw["caption"] !== "" ? { caption: raw["caption"] } : {}),
        headers,
        rows,
        rowCount: typeof raw["rowCount"] === "number" ? raw["rowCount"] : rows.length,
        columnCount: typeof raw["columnCount"] === "number" ? raw["columnCount"] : headers.length,
      };
    }
    case "figure": {
      const imageFile = typeof raw["imageFile"] === "string" ? raw["imageFile"] : undefined;
      const caption = typeof raw["caption"] === "string" && raw["caption"] !== "" ? raw["caption"] : undefined;
      if (imageFile === undefined && caption === undefined && provenance.page === undefined) {
        return null;
      }
      return {
        blockId,
        type: "figure",
        provenance,
        ...(caption !== undefined ? { caption } : {}),
        ...(imageFile !== undefined ? { assetName: imageFile } : {}),
      };
    }
    case "formula": {
      const latex = typeof raw["latex"] === "string" ? raw["latex"] : undefined;
      const text = typeof raw["text"] === "string" ? raw["text"] : undefined;
      // 无 enrichment 时内容为空：块仍登记（页码 / bbox 供 M10.2 定位）
      if (latex === undefined && text === undefined && provenance.page === undefined) {
        return null;
      }
      return {
        blockId,
        type: "formula",
        provenance,
        ...(latex !== undefined ? { latex } : {}),
        ...(text !== undefined ? { text } : {}),
      };
    }
    default:
      return null;
  }
}

function mapProvenance(raw: Record<string, unknown>, fileName: string): ParsedProvenance {
  const provenance: ParsedProvenance = { fileName };
  if (typeof raw["page"] === "number" && raw["page"] > 0) {
    provenance["page"] = raw["page"];
  }
  if (typeof raw["section"] === "string" && raw["section"] !== "") {
    provenance["section"] = raw["section"];
  }
  const bbox = raw["bbox"];
  if (Array.isArray(bbox) && bbox.length === 4 && bbox.every((v) => typeof v === "number")) {
    const [x0, y0, x1, y1] = bbox as [number, number, number, number];
    provenance["bbox"] = { x0, y0, x1, y1 } satisfies BBox;
  }
  if (typeof raw["ref"] === "string" && raw["ref"] !== "") {
    provenance["parserBlockId"] = raw["ref"];
  }
  return provenance;
}

/** stderr 进度行 → 事件（非协议行返回 null） */
function parseProgressLine(line: string): DoclingProgressEvent | null {
  if (!line.startsWith(PROGRESS_PREFIX)) {
    return null;
  }
  try {
    const parsed = JSON.parse(line.slice(PROGRESS_PREFIX.length)) as unknown;
    if (!isRecord(parsed) || typeof parsed["phase"] !== "string") {
      return null;
    }
    return {
      phase: parsed["phase"],
      ...(typeof parsed["stage"] === "string" ? { stage: parsed["stage"] } : {}),
      ...(Array.isArray(parsed["pages"])
        ? { pages: parsed["pages"].filter((page): page is number => typeof page === "number").slice(0, 32) }
        : {}),
      ...(typeof parsed["model"] === "string" ? { model: parsed["model"] } : {}),
    };
  } catch {
    return null;
  }
}

function describeProgress(event: DoclingProgressEvent): string {
  return [
    event.phase,
    ...(event.stage !== undefined ? [event.stage] : []),
    ...(event.pages !== undefined && event.pages.length > 0 ? [`p${event.pages.join(",")}`] : []),
    ...(event.model !== undefined ? [event.model] : []),
  ].join(" ");
}

interface ModelReport {
  code: string;
  detail: string;
}

/** --preflight / --warmup 的协议输出（最后一行 JSON）；不可解析 → code=unparsable */
function parseModelReport(stdout: string): ModelReport {
  const line = stdout.split(/\r?\n/).filter((entry) => entry.trim() !== "").pop() ?? "";
  try {
    const parsed = JSON.parse(line) as unknown;
    if (isRecord(parsed) && typeof parsed["code"] === "string") {
      const models = Array.isArray(parsed["models"])
        ? parsed["models"]
            .filter(isRecord)
            .map((model) => `${String(model["repo"] ?? "?")}=${model["cached"] === true ? "cached" : "missing"}`)
            .join(", ")
        : "";
      const error = typeof parsed["error"] === "string" ? parsed["error"] : "";
      return { code: parsed["code"], detail: [models, error].filter((part) => part !== "").join("；") };
    }
  } catch {
    // fallthrough
  }
  return { code: "unparsable", detail: line.slice(0, NOISE_LOG_CHARS) };
}

function modelDownloadHint(detail: string): string {
  return (
    `docling 模型资源首次下载失败（${detail.slice(0, 300)}）。这是依赖下载问题，不是文档内容问题。` +
    "恢复：确认本机可访问 HuggingFace（国内网络可设置 HF_ENDPOINT=https://hf-mirror.com），" +
    "或手动执行 python backend/tools/parse_document_docling.py --warmup 预热后重试"
  );
}

function errorText(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry ?? "")) : [];
}

function isTextKind(value: string): value is "paragraph" | "title" | "section_header" | "list_item" | "caption" {
  return ["paragraph", "title", "section_header", "list_item", "caption"].includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
