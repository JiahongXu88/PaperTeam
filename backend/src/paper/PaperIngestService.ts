/**
 * Final PDF Ingest 服务（M4.3.1）：Existing Paper 的合法 Review 输入。
 *
 * PDF 第一版定位：Read-only Review / Audit（不编辑 PDF）。
 *
 * 校验：扩展名 .pdf、%PDF- 签名、大小上限（默认 50MB，可配）、文件名规范化
 * （仅元数据用途——落盘路径固定 source/paper.pdf，天然免疫路径穿越）。
 * 重复处理：sha256 相同 → 幂等返回（不重解析）；不同 → 替换并清空派生产物。
 *
 * 可恢复：PDF 先落盘（解析失败可重试原料仍在）；stage 指纹随解析记录，
 * 后续 references/metadata/semantic stages 依据指纹跳过已完成工作。
 */

import { mkdir, readFile } from "node:fs/promises";
import { basename } from "node:path";

import { BusinessError } from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { sha256Hex } from "../util/hash.js";
import { PyMuPdfParser, type PdfParser } from "./PdfParser.js";
import { assemblePaper } from "./sectionChunking.js";
import type { PaperDocument } from "./types.js";
import type { PaperStore } from "./PaperStore.js";

export const MAX_PAPER_PDF_BYTES = 50 * 1024 * 1024;

export interface IngestOptions {
  projects: ProjectStore;
  store: PaperStore;
  parser?: PdfParser;
  /** 单文件上限（字节，默认 50MB） */
  maxBytes?: number;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface IngestResult {
  document: PaperDocument;
  /** true = 内容未变化，沿用既有解析产物（幂等） */
  unchanged: boolean;
}

export class PaperIngestService {
  private readonly projects: ProjectStore;
  private readonly store: PaperStore;
  private readonly parser: PdfParser;
  private readonly maxBytes: number;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(options: IngestOptions) {
    this.projects = options.projects;
    this.store = options.store;
    this.parser = options.parser ?? new PyMuPdfParser();
    this.maxBytes = options.maxBytes ?? MAX_PAPER_PDF_BYTES;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  /** 上传并解析（或幂等复用）；PDF 落盘在解析之前 */
  async ingest(projectId: string, input: { fileName: string; content: Buffer }): Promise<IngestResult> {
    await this.projects.getRequired(projectId);
    const fileName = normalizeUploadName(input.fileName);
    if (!fileName.toLowerCase().endsWith(".pdf")) {
      throw new BusinessError("INVALID_REQUEST", "只接受 .pdf 文件（Final PDF Review 输入）");
    }
    if (input.content.byteLength === 0) {
      throw new BusinessError("INVALID_REQUEST", "上传内容为空");
    }
    if (input.content.byteLength > this.maxBytes) {
      throw new BusinessError(
        "INVALID_REQUEST",
        `PDF 超过 ${Math.floor(this.maxBytes / (1024 * 1024))}MB 上限`,
      );
    }
    if (input.content.subarray(0, 5).toString("latin1") !== "%PDF-") {
      throw new BusinessError("INVALID_REQUEST", "不是合法 PDF（缺少 %PDF- 文件头）");
    }

    const sha = sha256Hex(input.content);
    const existing = await this.store.loadDocument(projectId);
    if (existing !== null && existing.sha256 === sha) {
      return { document: existing, unchanged: true };
    }

    // 新内容：替换。先落原料，再解析（失败时原料保留可重试）
    await this.store.clearDerived(projectId);
    await this.store.saveSource(projectId, input.content);

    const parsedStage = await this.parseAndPersist(projectId, fileName, input.content.byteLength, sha);
    return { document: parsedStage, unchanged: false };
  }

  /** 对已落盘的原料重跑解析（解析 stage 失败后的重试入口） */
  async reparse(projectId: string): Promise<PaperDocument> {
    await this.projects.getRequired(projectId);
    let content: Buffer;
    try {
      content = await readFile(this.store.sourcePath(projectId));
    } catch {
      throw new BusinessError("INVALID_REQUEST", "尚未上传 Final PDF（无可重试的原料）");
    }
    const existing = await this.store.loadDocument(projectId);
    await this.store.clearDerived(projectId);
    await this.store.saveSource(projectId, content);
    return this.parseAndPersist(projectId, existing?.originalFileName ?? "paper.pdf", content.byteLength, sha256Hex(content));
  }

  private async parseAndPersist(
    projectId: string,
    fileName: string,
    bytes: number,
    sha: string,
  ): Promise<PaperDocument> {
    const sourcePath = this.store.sourcePath(projectId);
    const started = Date.now();
    await this.store.saveStage(projectId, {
      stage: "parse",
      status: "running",
      inputFingerprint: sha,
      updatedAt: this.now().toISOString(),
    });
    let document: PaperDocument;
    try {
      const extraction = await this.parser.parseFile(sourcePath);
      const assembled = assemblePaper(extraction);
      document = {
        schemaVersion: 1,
        projectId,
        documentId: "paper-1",
        ...(assembled.title !== undefined ? { title: assembled.title } : {}),
        originalFileName: fileName,
        bytes,
        sha256: sha,
        parse: {
          parserId: extraction.parser.id,
          ...(extraction.parser.version !== undefined
            ? { parserVersion: extraction.parser.version }
            : {}),
          parsedAt: this.now().toISOString(),
          durationMs: Date.now() - started,
          pageCount: extraction.pageCount,
          extractionQuality: assembled.extractionQuality,
          ...(extraction.notes.length > 0 ? { notes: extraction.notes } : {}),
        },
        pages: assembled.pages,
        sections: assembled.sections,
        chunks: assembled.chunks,
        ...(assembled.abstractSectionId !== undefined
          ? { abstractSectionId: assembled.abstractSectionId }
          : {}),
        ...(assembled.referencesSectionId !== undefined
          ? { referencesSectionId: assembled.referencesSectionId }
          : {}),
        ingestedAt: this.now().toISOString(),
      };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      await this.store.saveStage(projectId, {
        stage: "parse",
        status: "failed",
        inputFingerprint: sha,
        error: message,
        updatedAt: this.now().toISOString(),
      });
      throw error;
    }
    await this.store.saveIngest(projectId, document);
    await this.store.saveStage(projectId, {
      stage: "parse",
      status: "ok",
      inputFingerprint: sha,
      outputSummary: {
        pageCount: document.parse.pageCount,
        sectionCount: document.sections.length,
        chunkCount: document.chunks.length,
        quality: document.parse.extractionQuality,
      },
      updatedAt: this.now().toISOString(),
    });
    this.log(
      `[paper] projectId=${projectId} 解析完成：pages=${document.parse.pageCount} sections=${document.sections.length} chunks=${document.chunks.length} quality=${document.parse.extractionQuality}`,
    );
    return document;
  }

  async getDocument(projectId: string): Promise<PaperDocument | null> {
    await this.projects.getRequired(projectId);
    return this.store.loadDocument(projectId);
  }

  async getStageSummary(projectId: string): Promise<Record<string, unknown>> {
    const stages = await this.store.loadStages(projectId);
    return Object.fromEntries(
      Object.entries(stages).map(([stage, record]) => [
        stage,
        {
          status: record.status,
          ...(record.error !== undefined ? { error: record.error } : {}),
          updatedAt: record.updatedAt,
          ...(record.outputSummary ?? {}),
        },
      ]),
    );
  }
}

/** 上传文件名规范化：取 basename、去控制字符、限长（仅元数据存储，不参与磁盘路径） */
export function normalizeUploadName(name: string): string {
  const trimmed = basename(name.trim()).replace(/[\x00-\x1f\x7f]/g, "");
  if (trimmed === "" || trimmed === "." || trimmed === "..") {
    throw new BusinessError("INVALID_REQUEST", "非法文件名");
  }
  if (trimmed.length > 200) {
    throw new BusinessError("INVALID_REQUEST", "文件名过长（>200 字符）");
  }
  return trimmed;
}
