/**
 * PDF Parser 抽象与 pymupdf 实现。
 *
 * PdfParser 接口是唯一 seam：业务层不感知 Python / pymupdf 存在。
 * ScholarlyStructureParser（GROBID 等学术结构服务）是另一个 seam，
 * 尚未实现（见 docs/DECISIONS.md M4.3）。
 *
 * pymupdf adapter 纪律：
 * - child_process.execFile（无 shell，无注入面）；参数只传脚本绝对路径 + PDF 绝对路径；
 * - 解释器由 PdfToolchain 探测（PAPERTEAM_PDF_PYTHON > python > python3 > py -3）；
 * - PYTHONIOENCODING=utf-8（Windows GBK 控制台默认会崩非 ASCII）；
 * - timeout（默认 60s）+ maxBuffer（默认 64MB）；
 * - 协议：stdout 最后一个非空行是 JSON 对象。前面若有其它输出（MuPDF C 层告警等）
 *   只进日志，不参与协议；stderr 同样只进日志。
 */

import { execFile } from "node:child_process";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { PdfParseFailedError, PdfParserUnavailableError } from "../errors.js";
import { PdfToolchain, pdfToolchainHint, type PdfToolchainStatus } from "./pdfToolchain.js";

/** 解析器原始输出（Python 工具 JSON 协议，业务层只消费经校验的字段） */
export interface RawPdfExtraction {
  ok: true;
  parser: { id: string; version?: string };
  pageCount: number;
  title: string;
  abstract: string;
  toc: Array<[number, string, number]>;
  blocks: Array<{ page: number; text: string }>;
  totalChars: number;
  notes: string[];
}

export interface PdfParser {
  readonly id: string;
  /** 解析 PDF 文件（绝对路径）；失败抛 BusinessError（不抛裸系统异常） */
  parseFile(absolutePath: string): Promise<RawPdfExtraction>;
  /** 解析依赖是否就绪（启动自检 / 诊断用；不抛异常） */
  checkAvailability(): Promise<PdfToolchainStatus>;
}

export interface PyMuPdfParserOptions {
  /** Python 解释器（PAPERTEAM_PDF_PYTHON；缺省自动探测） */
  pythonCommand?: string;
  /** 解析脚本路径（默认 backend/tools/parse_paper_pdf.py；测试可指 fixture） */
  scriptPath?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
  log?: (message: string) => void;
}

/** 工具脚本默认位置（backend/tools/，与 src、dist 的相对关系相同） */
export function defaultParseScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  return resolve(here, "..", "..", "tools", "parse_paper_pdf.py");
}

/** 日志中保留的非协议输出长度 */
const NOISE_LOG_CHARS = 500;

export class PyMuPdfParser implements PdfParser {
  readonly id = "pymupdf";
  private readonly toolchain: PdfToolchain;
  private readonly scriptPath: string;
  private readonly timeoutMs: number;
  private readonly maxBufferBytes: number;
  private readonly log: (message: string) => void;

  constructor(options: PyMuPdfParserOptions = {}) {
    this.log = options.log ?? (() => {});
    this.toolchain = new PdfToolchain({
      ...(options.pythonCommand !== undefined ? { pythonCommand: options.pythonCommand } : {}),
      log: this.log,
    });
    this.scriptPath = resolve(options.scriptPath ?? defaultParseScriptPath());
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxBufferBytes = options.maxBufferBytes ?? 64 * 1024 * 1024;
  }

  checkAvailability(): Promise<PdfToolchainStatus> {
    return this.toolchain.resolve();
  }

  async parseFile(absolutePath: string): Promise<RawPdfExtraction> {
    const toolchain = await this.toolchain.resolve();
    if (!toolchain.available) {
      throw new PdfParserUnavailableError(pdfToolchainHint(toolchain));
    }
    const stdout = await this.exec(toolchain.command, toolchain.args, absolutePath);
    return this.validate(stdout);
  }

  private exec(command: string, prefixArgs: readonly string[], absolutePath: string): Promise<string> {
    return new Promise<string>((resolvePromise, rejectPromise) => {
      execFile(
        command,
        [...prefixArgs, this.scriptPath, resolve(absolutePath)],
        {
          timeout: this.timeoutMs,
          maxBuffer: this.maxBufferBytes,
          windowsHide: true,
          encoding: "utf8",
          env: { ...process.env, PYTHONIOENCODING: "utf8", PYTHONDONTWRITEBYTECODE: "1" },
        },
        (error, stdout, stderr) => {
          if (stderr.trim() !== "") {
            this.log(`[pdf-parser] stderr: ${stderr.trim().slice(0, NOISE_LOG_CHARS)}`);
          }
          if (error === null) {
            resolvePromise(stdout);
            return;
          }
          const { killed, code } = error as { killed?: boolean; code?: string | number };
          if (code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
            rejectPromise(new PdfParseFailedError(`解析输出超过 ${this.maxBufferBytes} 字节上限（文档过大）`));
            return;
          }
          if (killed === true) {
            rejectPromise(new PdfParseFailedError(`解析超时（${this.timeoutMs}ms）`));
            return;
          }
          if (code === "ENOENT") {
            rejectPromise(
              new PdfParserUnavailableError(`解释器 ${command} 无法执行（可能已被卸载，请重新检查安装）`),
            );
            return;
          }
          // 非零退出：脚本已尽力输出结构化 JSON（依赖缺失 / 打开失败 / 提取异常），交给 validate 归一
          if (stdout.trim() !== "") {
            resolvePromise(stdout);
            return;
          }
          rejectPromise(
            new PdfParseFailedError(`解析器进程异常退出（code=${String(code ?? "?")}）`, stderr.trim().slice(0, NOISE_LOG_CHARS)),
          );
        },
      );
    });
  }

  /** stdout 协议校验：取最后一个非空行为 JSON；结构不符 / 工具自报失败 → 结构化业务错误 */
  private validate(stdout: string): RawPdfExtraction {
    const lines = stdout.split(/\r?\n/).filter((line) => line.trim() !== "");
    const payloadLine = lines.pop() ?? "";
    if (lines.length > 0) {
      this.log(`[pdf-parser] 非协议输出已忽略：${lines.join(" | ").slice(0, NOISE_LOG_CHARS)}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(payloadLine);
    } catch {
      throw new PdfParseFailedError(
        "解析器输出了非法 JSON（协议错误）",
        payloadLine.slice(0, NOISE_LOG_CHARS),
      );
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new PdfParseFailedError("解析器输出不是 JSON 对象");
    }
    const record = parsed as Record<string, unknown>;
    if (record["ok"] !== true) {
      const detail = typeof record["error"] === "string" ? record["error"] : "未知错误";
      if (record["code"] === "dependency_missing") {
        throw new PdfParserUnavailableError(detail);
      }
      throw new PdfParseFailedError(detail);
    }
    const pageCount = record["pageCount"];
    const blocks = record["blocks"];
    const toc = record["toc"];
    if (typeof pageCount !== "number" || pageCount <= 0 || !Array.isArray(blocks)) {
      throw new PdfParseFailedError("解析器输出缺少 pageCount/blocks 字段");
    }
    const parser = isRecord(record["parser"]) ? record["parser"] : {};
    return {
      ok: true,
      parser: {
        id: typeof parser["id"] === "string" ? parser["id"] : "unknown",
        ...(typeof parser["version"] === "string" ? { version: parser["version"] } : {}),
      },
      pageCount,
      title: typeof record["title"] === "string" ? record["title"] : "",
      abstract: typeof record["abstract"] === "string" ? record["abstract"] : "",
      toc: Array.isArray(toc)
        ? toc.filter(
            (entry): entry is [number, string, number] =>
              Array.isArray(entry) &&
              typeof entry[0] === "number" &&
              typeof entry[1] === "string" &&
              typeof entry[2] === "number",
          )
        : [],
      blocks: blocks.filter(
        (block): block is { page: number; text: string } =>
          isRecord(block) && typeof block["page"] === "number" && typeof block["text"] === "string",
      ),
      totalChars: typeof record["totalChars"] === "number" ? record["totalChars"] : 0,
      notes: Array.isArray(record["notes"])
        ? record["notes"].filter((note): note is string => typeof note === "string")
        : [],
    };
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
