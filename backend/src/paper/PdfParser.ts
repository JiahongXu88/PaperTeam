/**
 * PDF Parser 抽象与 pymupdf 实现（M4.3.1）。
 *
 * PdfParser 接口是唯一 seam：业务层不感知 Python / pymupdf 存在。
 * ScholarlyStructureParser（GROBID 等学术结构服务）是另一个 seam，
 * 本轮不实现（见 docs/DECISIONS.md M4.3）。
 *
 * pymupdf adapter 纪律：
 * - child_process.execFile（无 shell，无注入面）；参数只传脚本绝对路径 + PDF 绝对路径；
 * - PYTHONIOENCODING=utf-8（Windows GBK 控制台默认会崩非 ASCII）；
 * - timeout（默认 60s）+ maxBuffer（默认 64MB）；
 * - stdout = 单个 JSON 对象（协议错误与退出码都收敛为结构化 PdfParserError）；
 * - stderr 仅进日志，不参与协议；
 * - python 解释器路径可配（PAPERTEAM_PDF_PYTHON，默认 "python"）。
 */

import { execFile } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import { BusinessError } from "../errors.js";

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
}

export interface PyMuPdfParserOptions {
  /** Python 解释器（默认 "python"；Windows 也可给绝对路径） */
  pythonCommand?: string;
  /** 解析脚本路径（默认 backend/tools/parse_paper_pdf.py；测试可指 fixture） */
  scriptPath?: string;
  timeoutMs?: number;
  maxBufferBytes?: number;
  log?: (message: string) => void;
}

/** 工具脚本默认位置（backend/tools/，与 src 的 dist 目录相对关系固定） */
export function defaultParseScriptPath(): string {
  const here = dirname(fileURLToPath(import.meta.url));
  // 开发：src/paper → ../../tools；构建后：dist/paper → ../../tools
  return resolve(here, "..", "..", "tools", "parse_paper_pdf.py");
}

export class PyMuPdfParser implements PdfParser {
  readonly id = "pymupdf";
  private readonly pythonCommand: string;
  private readonly scriptPath: string;
  private readonly timeoutMs: number;
  private readonly maxBufferBytes: number;
  private readonly log: (message: string) => void;

  constructor(options: PyMuPdfParserOptions = {}) {
    this.pythonCommand = options.pythonCommand ?? "python";
    this.scriptPath = resolve(options.scriptPath ?? defaultParseScriptPath());
    this.timeoutMs = options.timeoutMs ?? 60_000;
    this.maxBufferBytes = options.maxBufferBytes ?? 64 * 1024 * 1024;
    this.log = options.log ?? (() => {});
  }

  async parseFile(absolutePath: string): Promise<RawPdfExtraction> {
    const stdout = await this.exec(absolutePath);
    return this.validate(stdout);
  }

  private exec(absolutePath: string): Promise<string> {
    return new Promise<string>((resolvePromise, rejectPromise) => {
      execFile(
        this.pythonCommand,
        [this.scriptPath, resolve(absolutePath)],
        {
          timeout: this.timeoutMs,
          maxBuffer: this.maxBufferBytes,
          windowsHide: true,
          encoding: "utf8",
          env: { ...process.env, PYTHONIOENCODING: "utf8", PYTHONDONTWRITEBYTECODE: "1" },
        },
        (error, stdout, stderr) => {
          if (stderr !== undefined && stderr.trim() !== "") {
            this.log(`[pdf-parser] stderr: ${stderr.trim().slice(0, 500)}`);
          }
          if (error !== null) {
            const timedOut = (error as { killed?: boolean }).killed === true;
            rejectPromise(
              new BusinessError(
                "INVALID_REQUEST",
                timedOut
                  ? `PDF 解析超时（${this.timeoutMs}ms）`
                  : `PDF 解析器执行失败（${this.pythonCommand}）：${error.message}`,
              ),
            );
            return;
          }
          resolvePromise(stdout);
        },
      );
    });
  }

  /** stdout JSON 协议校验：结构不符 / 工具自报失败 → 结构化业务错误 */
  private validate(stdout: string): RawPdfExtraction {
    let parsed: unknown;
    try {
      parsed = JSON.parse(stdout);
    } catch {
      throw new BusinessError(
        "INVALID_REQUEST",
        "PDF 解析器输出了非法 JSON（协议错误，请检查 backend/tools/parse_paper_pdf.py）",
      );
    }
    if (typeof parsed !== "object" || parsed === null) {
      throw new BusinessError("INVALID_REQUEST", "PDF 解析器输出不是 JSON 对象");
    }
    const record = parsed as Record<string, unknown>;
    if (record["ok"] !== true) {
      const detail = typeof record["error"] === "string" ? record["error"] : "未知错误";
      throw new BusinessError("INVALID_REQUEST", `PDF 解析失败：${detail}`);
    }
    const pageCount = record["pageCount"];
    const blocks = record["blocks"];
    const toc = record["toc"];
    if (typeof pageCount !== "number" || pageCount <= 0 || !Array.isArray(blocks)) {
      throw new BusinessError("INVALID_REQUEST", "PDF 解析器输出缺少 pageCount/blocks 字段");
    }
    return {
      ok: true,
      parser: {
        id: typeof record["parser"] === "object" && record["parser"] !== null
          ? String((record["parser"] as Record<string, unknown>)["id"] ?? "unknown")
          : "unknown",
        ...((typeof record["parser"] === "object" &&
        record["parser"] !== null &&
        typeof (record["parser"] as Record<string, unknown>)["version"] === "string")
          ? { version: String((record["parser"] as Record<string, unknown>)["version"]) }
          : {}),
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
          typeof block === "object" &&
          block !== null &&
          typeof (block as Record<string, unknown>)["page"] === "number" &&
          typeof (block as Record<string, unknown>)["text"] === "string",
      ),
      totalChars: typeof record["totalChars"] === "number" ? record["totalChars"] : 0,
      notes: Array.isArray(record["notes"])
        ? record["notes"].filter((note): note is string => typeof note === "string")
        : [],
    };
  }
}
