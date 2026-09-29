/**
 * IngestionService（M10.1）：source 文件 → ParsedDocument 编排 + 结构化
 * 记录 → user_confirmed Evidence 的确认通道。
 *
 * 解析链（显式降级，不静默）：
 *   PDF:   DoclingParser（结构化：版面 / 阅读顺序 / 表格 / 图 / 页码 bbox）
 *          └ 不可用 → LegacyPdfTextParser（pymupdf 文本层 → builtin 文本层；
 *            parseMode=text_only + degradedFrom 审计）
 *          └ 解析失败（损坏 / 加密 / 超时）→ status=failed 如实落盘，可重试
 *   CSV:   CsvParser（每行一条 structured_record，file/row/column provenance）
 *   XLSX:  XlsxParser（sheet/row/column provenance）
 *
 * Evidence 语义红线（M10.0.5 §8.5-R1）：结构化记录 → 用户确认 →
 * verificationLevel=user_confirmed 的 Evidence；verificationStatus 保持
 * unverified（用户自己的实验数字不是「已被外部文献机械验证」），
 * isFormalEvidence / grounded_verified 分级不受影响。claim 与单元格值
 * 做机械包含校验——登记的数值必须真的在那个格子里。
 */

import { BusinessError, EvidenceValueMismatchError, NotFoundError } from "../errors.js";
import type { EvidenceStore } from "../evidence/EvidenceStore.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { SourceItem, SourceStore } from "../sources/SourceStore.js";
import { CsvParser } from "./csvTabular.js";
import type { DocumentExtraction, DocumentParser, ParsedBlock, ParsedDocument, ParsedRecordBlock } from "./types.js";
import { isDocumentFresh } from "./types.js";
import type { ParsedDocumentStore } from "./ParsedDocumentStore.js";
import { XlsxParser } from "./xlsxTabular.js";

export interface IngestionServiceOptions {
  projects: ProjectStore;
  sources: SourceStore;
  documents: ParsedDocumentStore;
  /** 结构化 PDF parser（生产 DoclingParser；测试注入 fake） */
  structuredParser: DocumentParser;
  /** PDF 降级链第二级（缺省不降级——只有结构化 parser 不可用才需要） */
  fallbackParser?: DocumentParser;
  evidence?: EvidenceStore;
  csvParser?: DocumentParser;
  xlsxParser?: DocumentParser;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface RecordQuery {
  sheet?: string;
  rowFrom?: number;
  rowTo?: number;
  /** 单次返回上限（缺省 100，上限 500） */
  limit?: number;
}

export interface RecordEvidenceInput {
  /** sheet 名（XLSX 必填语义由记录本身决定；CSV 省略） */
  sheet?: string;
  /** 物理行号（含表头 = 1；与 Excel 行号一致） */
  row: number;
  /** 列（表头名或列字母） */
  column: string;
  claim: string;
}

export class IngestionService {
  private readonly projects: ProjectStore;
  private readonly sources: SourceStore;
  private readonly documents: ParsedDocumentStore;
  private readonly structuredParser: DocumentParser;
  private readonly fallbackParser?: DocumentParser;
  private readonly evidence?: EvidenceStore;
  private readonly csvParser: DocumentParser;
  private readonly xlsxParser: DocumentParser;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  /** 同一 source 的在途解析去重（并发上传 / 后台触发 / 手动触发不重复 spawn） */
  private readonly inflight = new Map<string, Promise<ParsedDocument>>();
  /** 解析产物落盘后的钩子（serviceStack 接检索失效；缺省 no-op） */
  private ingestedHook?: (projectId: string, sourceId: string, document: ParsedDocument) => Promise<void>;
  /**
   * 后台解析串行链：docling 是 CPU 密集子进程，批量全文挂载 / 连续上传时
   * 逐个执行（并发 1），避免 N 个 torch 进程同时争抢；失败不阻塞后继。
   */
  private backgroundChain: Promise<void> = Promise.resolve();

  constructor(options: IngestionServiceOptions) {
    this.projects = options.projects;
    this.sources = options.sources;
    this.documents = options.documents;
    this.structuredParser = options.structuredParser;
    this.fallbackParser = options.fallbackParser;
    this.evidence = options.evidence;
    this.csvParser = options.csvParser ?? new CsvParser();
    this.xlsxParser = options.xlsxParser ?? new XlsxParser();
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  // ---- Ingestion ----

  /**
   * 解析并落盘单个 source 的 ParsedDocument（显式降级链；失败也落盘
   * status=failed 的文档——调用方可见，重试 = 再次调用）。
   */
  async ingest(projectId: string, sourceId: string): Promise<ParsedDocument> {
    await this.projects.getRequired(projectId);
    const key = `${projectId}/${sourceId}`;
    const existing = this.inflight.get(key);
    if (existing !== undefined) {
      return existing;
    }
    const task = this.ingestInner(projectId, sourceId).finally(() => {
      this.inflight.delete(key);
    });
    this.inflight.set(key, task);
    return task;
  }

  /** 后台触发（上传后的 fire-and-forget；串行执行，失败只记日志） */
  ingestInBackground(projectId: string, sourceId: string): void {
    this.backgroundChain = this.backgroundChain
      .then(async () => {
        await this.ingest(projectId, sourceId);
      })
      .catch((error) => {
        this.log(
          `[ingestion] ${projectId}/${sourceId} 后台解析异常：${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  private async ingestInner(projectId: string, sourceId: string): Promise<ParsedDocument> {
    const item = await this.sources.getRequired(projectId, sourceId);
    if (item.fileName === undefined) {
      throw new BusinessError("INVALID_REQUEST", `文献 ${sourceId} 是 metadata-only 条目（无原始文件可解析）`);
    }
    const kind = documentKindOf(item);
    if (kind === "other") {
      // 不支持的类型：前置拒绝（不落 failed 文档——这不是解析失败，是能力边界）
      throw new BusinessError(
        "INVALID_REQUEST",
        `文献 ${sourceId} 的文件类型不支持结构化解析（${item.fileName}；支持 pdf / csv / xlsx）`,
      );
    }
    const filePath = await this.sources.filePath(projectId, sourceId);
    const contentHash = item.contentHash ?? "";
    try {
      let extraction: DocumentExtraction;
      let degradedFrom: ParsedDocument["degradedFrom"];
      if (kind === "pdf") {
        try {
          extraction = await this.structuredParser.parseFile(filePath, {
            figuresDir: this.documents.figuresDir(projectId, sourceId),
          });
        } catch (error) {
          if (isUnavailable(error) && this.fallbackParser !== undefined) {
            const reason = error instanceof Error ? error.message : String(error);
            this.log(`[ingestion] ${sourceId} 结构化解析器不可用，降级到文本层：${reason.slice(0, 160)}`);
            extraction = await this.fallbackParser.parseFile(filePath);
            degradedFrom = { parser: this.structuredParser.id, reason: reason.slice(0, 300) };
          } else {
            throw error;
          }
        }
      } else if (kind === "csv") {
        extraction = await this.csvParser.parseFile(filePath);
      } else {
        extraction = await this.xlsxParser.parseFile(filePath);
      }
      const document = buildParsedDocument({
        item,
        extraction,
        contentHash,
        parsedAt: this.now().toISOString(),
        ...(degradedFrom !== undefined ? { degradedFrom } : {}),
      });
      await this.documents.save(projectId, document);
      this.log(
        `[ingestion] ${projectId}/${sourceId} 解析完成（${document.parser.id}，${document.parseMode}，块 ${document.blocks.length}）` +
          (degradedFrom !== undefined ? `——降级自 ${degradedFrom.parser}` : ""),
      );
      // 解析产物落盘 → 检索层按新产物重建（失败只记日志；重建本身是 lazy 的）
      const hook = this.ingestedHook;
      if (hook !== undefined) {
        try {
          await hook(projectId, sourceId, document);
        } catch (error) {
          this.log(
            `[ingestion] ${projectId}/${sourceId} 解析后检索失效失败（下次检索自动自愈）：${errorText(error)}`,
          );
        }
      }
      return document;
    } catch (error) {
      // 解析失败如实落盘（可重试；不静默、不伪装成功）
      const reason = error instanceof Error ? error.message : String(error);
      const document: ParsedDocument = {
        schemaVersion: 1,
        sourceId,
        fileName: item.originalName ?? item.fileName,
        storedFileName: item.fileName,
        kind: kind === "xlsx" || kind === "csv" ? "tabular" : "pdf",
        mimeType: mimeOf(kind),
        parser: { id: attemptedParserId(kind, this.structuredParser.id) },
        parseMode: "structured",
        status: "failed",
        blocks: [],
        counts: emptyCounts(),
        notes: [`解析失败：${reason.slice(0, 400)}`],
        contentHash,
        parsedAt: this.now().toISOString(),
      };
      await this.documents.save(projectId, document);
      this.log(`[ingestion] ${projectId}/${sourceId} 解析失败（已落盘 status=failed）：${reason.slice(0, 200)}`);
      return document;
    }
  }

  /** 解析产物落盘后的钩子（serviceStack 接 retrieval.invalidateSource；幂等覆盖） */
  attachIngestedHook(hook: (projectId: string, sourceId: string, document: ParsedDocument) => Promise<void>): void {
    this.ingestedHook = hook;
  }

  // ---- 读取 ----

  /** 读取解析产物；不新鲜（内容已变）或不存在返回 null（调用方决定重新 ingest） */
  async getDocument(projectId: string, sourceId: string): Promise<ParsedDocument | null> {
    const item = await this.sources.getRequired(projectId, sourceId);
    const document = await this.documents.load(projectId, sourceId);
    if (document === null || !isDocumentFresh(document, item)) {
      return null;
    }
    return document;
  }

  /** 结构化记录窗口读取（有界；行号升序） */
  async listRecords(
    projectId: string,
    sourceId: string,
    query: RecordQuery = {},
  ): Promise<{ document: ParsedDocumentSummary; records: ParsedRecordBlock[] }> {
    const document = await this.requireFreshDocument(projectId, sourceId, "记录读取");
    const limit = Math.min(Math.max(query.limit ?? 100, 1), 500);
    const records = document.blocks.filter((block): block is ParsedRecordBlock => {
      if (block.type !== "structured_record") {
        return false;
      }
      if (query.sheet !== undefined && block.provenance.sheet !== query.sheet) {
        return false;
      }
      if (query.rowFrom !== undefined && (block.provenance.row ?? 0) < query.rowFrom) {
        return false;
      }
      if (query.rowTo !== undefined && (block.provenance.row ?? 0) > query.rowTo) {
        return false;
      }
      return true;
    });
    return { document: summarizeDocument(document), records: records.slice(0, limit) };
  }

  // ---- 结构化记录 → user_confirmed Evidence ----

  /**
   * 用户确认一条记录值为事实（M10.1C/D）：
   * - 机械校验：claim 必须真的提到该单元格的值（数值等价归一）；
   * - verificationLevel=user_confirmed、verificationStatus=unverified——
   *   用户实验数字 ≠ 文献机械核验（grounded_verified 分级不受影响）；
   * - provenance 落 location.sheet/row/column，quote 为原始值。
   */
  async confirmRecordEvidence(
    projectId: string,
    sourceId: string,
    input: RecordEvidenceInput,
    createdBy = "user",
  ) {
    if (this.evidence === undefined) {
      throw new BusinessError("INVALID_REQUEST", "EvidenceStore 未装配（无法登记结构化数据事实）");
    }
    const item = await this.sources.getRequired(projectId, sourceId);
    const document = await this.requireFreshDocument(projectId, sourceId, "事实确认");
    if (document.status === "failed") {
      throw new BusinessError("INVALID_REQUEST", `文献 ${sourceId} 的解析产物不可用（status=failed；请重新解析）`);
    }
    const record = findRecord(document.blocks, input.sheet, input.row);
    if (record === null) {
      throw new NotFoundError(
        "结构化记录",
        `${sourceId} ${input.sheet !== undefined ? `sheet=${input.sheet} ` : ""}row=${input.row}`,
      );
    }
    const cell = findCell(record, input.column);
    if (cell === null) {
      throw new NotFoundError("记录列", `${sourceId} row=${input.row} column=${input.column}`);
    }
    if (cell.value.trim() === "") {
      throw new BusinessError("INVALID_REQUEST", `该单元格为空（row=${input.row} column=${input.column}），无可确认事实`);
    }
    if (!claimMentionsValue(input.claim, cell.value)) {
      throw new EvidenceValueMismatchError(
        `claim 未包含记录值（row=${input.row} ${cell.header}=${cell.value}；claim 应提到该值）`,
      );
    }
    const created = await this.evidence.append(
      projectId,
      {
        claim: input.claim,
        quote: cell.value.slice(0, 2000),
        source: {
          sourceId,
          title: item.originalName ?? item.fileName,
        },
        location: {
          ...(record.provenance.sheet !== undefined ? { sheet: record.provenance.sheet } : {}),
          row: input.row,
          column: cell.header,
        },
        verificationStatus: "unverified",
        verificationMethod: "user-confirmed:experiment-data",
        verificationLevel: "user_confirmed",
      },
      createdBy,
    );
    this.log(
      `[ingestion] ${projectId}/${sourceId} 结构化事实确认（${record.provenance.sheet ?? "csv"} row=${input.row} ${cell.header}=${cell.value.slice(0, 40)}）→ Evidence ${created.id}`,
    );
    return { evidence: created, record, cell };
  }

  /** 新鲜且可用的文档（不存在 / 过期 / 未解析 → 明确 400，提示触发 ingest） */
  private async requireFreshDocument(projectId: string, sourceId: string, action: string): Promise<ParsedDocument> {
    const document = await this.getDocument(projectId, sourceId);
    if (document === null) {
      throw new BusinessError(
        "INVALID_REQUEST",
        `文献 ${sourceId} 尚无有效的结构化解析产物（${action} 需要；请先 POST /sources/${sourceId}/ingest）`,
      );
    }
    return document;
  }
}

// ---- 汇总投影（HTTP 响应用；不泄漏全量 blocks） ----

export interface ParsedDocumentSummary {
  sourceId: string;
  fileName: string;
  kind: ParsedDocument["kind"];
  parser: ParsedDocument["parser"];
  parseMode: ParsedDocument["parseMode"];
  status: ParsedDocument["status"];
  pageCount?: number;
  sheets?: ParsedDocument["sheets"];
  blockCount: number;
  counts: ParsedDocument["counts"];
  degradedFrom?: ParsedDocument["degradedFrom"];
  notes: string[];
  parsedAt: string;
}

export function summarizeDocument(document: ParsedDocument): ParsedDocumentSummary {
  return {
    sourceId: document.sourceId,
    fileName: document.fileName,
    kind: document.kind,
    parser: document.parser,
    parseMode: document.parseMode,
    status: document.status,
    ...(document.pageCount !== undefined ? { pageCount: document.pageCount } : {}),
    ...(document.sheets !== undefined ? { sheets: document.sheets } : {}),
    blockCount: document.blocks.length,
    counts: document.counts,
    ...(document.degradedFrom !== undefined ? { degradedFrom: document.degradedFrom } : {}),
    notes: document.notes,
    parsedAt: document.parsedAt,
  };
}

// ---- 构建辅助 ----

function buildParsedDocument(input: {
  item: SourceItem;
  extraction: DocumentExtraction;
  contentHash: string;
  parsedAt: string;
  degradedFrom?: ParsedDocument["degradedFrom"];
}): ParsedDocument {
  const { item, extraction, contentHash, parsedAt } = input;
  const kind = documentKindOf(item);
  const counts = emptyCounts();
  for (const block of extraction.blocks) {
    counts[block.type] += 1;
  }
  return {
    schemaVersion: 1,
    sourceId: item.sourceId,
    fileName: item.originalName ?? item.fileName ?? item.sourceId,
    storedFileName: item.fileName ?? "",
    kind: kind === "xlsx" || kind === "csv" ? "tabular" : "pdf",
    mimeType: mimeOf(kind),
    parser: extraction.parser,
    parseMode: extraction.mode,
    status: extraction.quality === "full" ? "ok" : "partial",
    ...(extraction.pageCount !== undefined ? { pageCount: extraction.pageCount } : {}),
    ...(extraction.sheets !== undefined ? { sheets: extraction.sheets } : {}),
    blocks: extraction.blocks,
    counts,
    ...(input.degradedFrom !== undefined ? { degradedFrom: input.degradedFrom } : {}),
    notes: extraction.notes.slice(0, 20),
    contentHash,
    parsedAt,
  };
}

function emptyCounts(): Record<ParsedBlock["type"], number> {
  return { text: 0, table: 0, figure: 0, formula: 0, structured_record: 0 };
}

/** 文件类型判定（扩展名优先，兼容老数据 sourceType） */
export function documentKindOf(item: SourceItem): "pdf" | "csv" | "xlsx" | "other" {
  const name = (item.fileName ?? "").toLowerCase();
  if (name.endsWith(".pdf")) {
    return "pdf";
  }
  if (name.endsWith(".csv")) {
    return "csv";
  }
  if (name.endsWith(".xlsx")) {
    return "xlsx";
  }
  return "other";
}

function mimeOf(kind: "pdf" | "csv" | "xlsx" | "other"): string {
  switch (kind) {
    case "pdf":
      return "application/pdf";
    case "csv":
      return "text/csv";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    default:
      return "application/octet-stream";
  }
}

function attemptedParserId(kind: string, structuredId: string): string {
  return kind === "pdf" ? structuredId : kind;
}

function isUnavailable(error: unknown): boolean {
  // DocumentParserUnavailableError / PdfParserUnavailableError 均走降级链
  const code = (error as { code?: string }).code;
  return code === "INGESTION_PARSER_UNAVAILABLE" || code === "PDF_PARSER_UNAVAILABLE";
}

function findRecord(blocks: ParsedBlock[], sheet: string | undefined, row: number): ParsedRecordBlock | null {
  for (const block of blocks) {
    if (block.type !== "structured_record") {
      continue;
    }
    if (block.provenance.row !== row) {
      continue;
    }
    if (sheet !== undefined && block.provenance.sheet !== sheet) {
      continue;
    }
    return block;
  }
  return null;
}

function findCell(record: ParsedRecordBlock, column: string): { letter: string; header: string; value: string } | null {
  const needle = column.trim();
  if (needle === "") {
    return null;
  }
  const byHeader = record.cells.find((cell) => cell.header.toLowerCase() === needle.toLowerCase());
  if (byHeader !== undefined) {
    return byHeader;
  }
  return record.cells.find((cell) => cell.letter === needle.toUpperCase()) ?? null;
}

/** claim 是否提到记录值（子串或数值等价：82.40 ≡ 82.4） */
export function claimMentionsValue(claim: string, value: string): boolean {
  const v = value.trim();
  if (v === "") {
    return false;
  }
  if (claim.includes(v)) {
    return true;
  }
  const numeric = Number(v.replace(/,/g, ""));
  if (Number.isFinite(numeric)) {
    const tokens = claim.match(/-?\d[\d,]*(?:\.\d+)?/g) ?? [];
    for (const token of tokens) {
      if (Number(token.replace(/,/g, "")) === numeric) {
        return true;
      }
    }
  }
  return false;
}

/** 错误短摘要（日志用；无堆栈） */
function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200);
}
