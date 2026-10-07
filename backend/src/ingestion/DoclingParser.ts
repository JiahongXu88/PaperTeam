/**
 * DoclingAdapter（M10.1B 生产 Adapter）：PDF → DocumentExtraction。
 *
 * 纪律与 paper/PdfParser.ts（PyMuPdfParser）完全一致：
 * - child_process.execFile（无 shell，无注入面）；参数只有脚本绝对路径、
 *   PDF 绝对路径与 flag；
 * - 解释器由 DoclingToolchain 探测（PAPERTEAM_DOCLING_PYTHON > python >
 *   python3 > py -3）；
 * - PYTHONIOENCODING=utf-8；timeout（默认 600s——docling 首次解析含模型
 *   下载，比 pymupdf 慢得多）+ maxBuffer（默认 128MB）；
 * - 协议：stdout 最后一行非空 JSON；其余输出只进日志。
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
import { DoclingToolchain, doclingToolchainHint, type DoclingToolchainStatus } from "./DoclingToolchain.js";
import type {
  BBox,
  DocumentExtraction,
  DocumentParseOptions,
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
  timeoutMs?: number;
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

export class DoclingParser implements DocumentParser {
  readonly id = "docling";
  private readonly toolchain: DoclingToolchain;
  private readonly scriptPath: string;
  private readonly timeoutMs: number;
  private readonly maxBufferBytes: number;
  private readonly maxConcurrency: number;
  private readonly log: (message: string) => void;
  /** 信号量状态：在途解析数 + FIFO 等待者（maxConcurrency 收敛 torch 并发） */
  private activeParses = 0;
  private readonly parseWaiters: Array<() => void> = [];

  constructor(options: DoclingParserOptions = {}) {
    this.log = options.log ?? (() => {});
    this.toolchain = new DoclingToolchain({
      ...(options.pythonCommand !== undefined ? { pythonCommand: options.pythonCommand } : {}),
      ...(options.probeImport !== undefined ? { probeImport: options.probeImport } : {}),
      log: this.log,
    });
    this.scriptPath = resolve(options.scriptPath ?? defaultDoclingScriptPath());
    this.timeoutMs = options.timeoutMs ?? 600_000;
    this.maxBufferBytes = options.maxBufferBytes ?? 128 * 1024 * 1024;
    this.maxConcurrency = Math.max(1, Math.floor(options.maxConcurrency ?? 1));
  }

  checkAvailability(): Promise<DoclingToolchainStatus> {
    return this.toolchain.resolve();
  }

  async parseFile(
    absolutePath: string,
    options: DocumentParseOptions = {},
  ): Promise<DocumentExtraction> {
    const toolchain = await this.toolchain.resolve();
    if (!toolchain.available) {
      throw new DocumentParserUnavailableError(doclingToolchainHint(toolchain));
    }
    const args = [
      resolve(absolutePath),
      ...(options.figuresDir !== undefined ? [`--figures-dir=${resolve(options.figuresDir)}`] : []),
      ...(options.formulas === true ? ["--formulas"] : []),
    ];
    await this.acquireParseSlot();
    try {
      const stdout = await this.exec(toolchain.command, toolchain.args, args);
      return this.validate(stdout, basename(absolutePath));
    } finally {
      this.releaseParseSlot();
    }
  }

  /** FIFO 信号量：超并发上限时排队（不失败——上游已有 source 级去重/串行链） */
  private acquireParseSlot(): Promise<void> {
    if (this.activeParses < this.maxConcurrency) {
      this.activeParses += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolvePromise) => {
      this.parseWaiters.push(() => {
        this.activeParses += 1;
        resolvePromise();
      });
    });
  }

  private releaseParseSlot(): void {
    this.activeParses -= 1;
    const next = this.parseWaiters.shift();
    if (next !== undefined) {
      next();
    }
  }

  private exec(
    command: string,
    prefixArgs: readonly string[],
    args: readonly string[],
  ): Promise<string> {
    return new Promise<string>((resolvePromise, rejectPromise) => {
      execFile(
        command,
        [...prefixArgs, this.scriptPath, ...args],
        {
          timeout: this.timeoutMs,
          maxBuffer: this.maxBufferBytes,
          windowsHide: true,
          encoding: "utf8",
          env: { ...process.env, PYTHONIOENCODING: "utf8", PYTHONDONTWRITEBYTECODE: "1" },
        },
        (error, stdout, stderr) => {
          if (stderr.trim() !== "") {
            this.log(`[docling] stderr: ${stderr.trim().slice(0, NOISE_LOG_CHARS)}`);
          }
          if (error === null) {
            resolvePromise(stdout);
            return;
          }
          const { killed, code } = error as { killed?: boolean; code?: string | number };
          if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            rejectPromise(
              new DocumentParseFailedError(`解析输出超过 ${this.maxBufferBytes} 字节上限（文档过大）`),
            );
            return;
          }
          if (killed === true) {
            rejectPromise(
              new DocumentParseFailedError(`解析超时（${this.timeoutMs}ms；首次解析含模型下载，重试会使用已缓存模型）`),
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

function stringArray(value: unknown): string[] {
  return Array.isArray(value) ? value.map((entry) => String(entry ?? "")) : [];
}

function isTextKind(value: string): value is "paragraph" | "title" | "section_header" | "list_item" | "caption" {
  return ["paragraph", "title", "section_header", "list_item", "caption"].includes(value);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
