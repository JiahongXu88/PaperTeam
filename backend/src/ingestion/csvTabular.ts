/**
 * CSV → DocumentExtraction（M10.1C）。
 *
 * 不再「CSV → 一整段文本 → chunk」：每行数据产出一条 structured_record，
 * cells 携带列级 provenance（表头名 + 列字母），行号与 Excel 口径一致
 * （表头 = 行 1，首条数据 = 行 2）。
 *
 * 确定性解析（无模型）：RFC4180 引号语义（"" 转义、跨行字段）、BOM 剥离、
 * 分隔符嗅探（, ; \t——首行引号外出现次数最高者）、防御上限截断进 notes。
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { DocumentParseFailedError } from "../errors.js";
import {
  INGESTION_LIMITS,
  type DocumentExtraction,
  type DocumentParser,
  type ParsedRecordCell,
  type ParsedRecordBlock,
  type ParsedSheetSummary,
} from "./types.js";

export class CsvParser implements DocumentParser {
  readonly id = "csv";

  async parseFile(absolutePath: string): Promise<DocumentExtraction> {
    const buffer = await readFileBounded(absolutePath);
    return this.parseBuffer(buffer, basename(absolutePath));
  }

  parseBuffer(buffer: Buffer, fileName: string): DocumentExtraction {
    // UTF-8 优先（剥 BOM）；解码失败（二进制误传）如实报错
    let text = buffer.toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1);
    }
    if (text.includes("\u0000")) {
      throw new DocumentParseFailedError("CSV 内容包含 NUL（疑似二进制文件误传）");
    }
    if (text.trim() === "") {
      throw new DocumentParseFailedError("CSV 文件内容为空");
    }
    const delimiter = sniffDelimiter(text);
    const notes: string[] = [];
    const rows = parseCsvRows(text, delimiter);

    if (rows.length === 0) {
      throw new DocumentParseFailedError("CSV 未解析出任何行");
    }
    if (rows.length > INGESTION_LIMITS.maxTabularRows) {
      notes.push(`行数超过上限 ${INGESTION_LIMITS.maxTabularRows}（共 ${rows.length} 行），已截断`);
      rows.length = INGESTION_LIMITS.maxTabularRows;
    }

    const headerRow = rows[0]!.cells;
    const headerCount = headerRow.length;
    const headers = dedupeHeaders(headerRow.map((header, index) => headerName(header, index)));

    const blocks: ParsedRecordBlock[] = [];
    // 数据行从物理行 2 起（行 1 = 表头）；row.line 是物理行号（空行也计数）
    for (const row of rows.slice(1)) {
      if (row.cells.every((cell) => cell.trim() === "")) {
        continue; // 全空行跳过（不占记录）
      }
      const cells: ParsedRecordCell[] = [];
      const width = Math.max(row.cells.length, headerCount);
      for (let colIndex = 0; colIndex < width; colIndex += 1) {
        const value = clipCell(row.cells[colIndex] ?? "", notes);
        if (value === "") {
          continue; // 空值不产出 cell（与 XLSX 同口径；列寻址见 findCell 语义）
        }
        cells.push({
          letter: columnLetter(colIndex),
          header: headers[colIndex] ?? columnLetter(colIndex),
          value,
        });
      }
      if (cells.length === 0) {
        continue;
      }
      blocks.push({
        blockId: `B${String(blocks.length + 1).padStart(4, "0")}`,
        type: "structured_record",
        provenance: { fileName, row: row.line },
        cells,
      });
      if (blocks.length >= INGESTION_LIMITS.maxBlocks) {
        notes.push(`记录数达到块上限 ${INGESTION_LIMITS.maxBlocks}，已截断`);
        break;
      }
    }

    const sheet: ParsedSheetSummary = {
      name: "csv",
      rowCount: blocks.length,
      columnCount: headerCount,
      headers,
    };
    return {
      parser: { id: this.id },
      mode: "structured",
      quality: notes.length > 0 ? "partial" : "full",
      sheets: [sheet],
      blocks,
      notes,
    };
  }
}

/** 读文件（大小上限由 SourceStore 上传层把关；此处兜底读取失败） */
async function readFileBounded(absolutePath: string): Promise<Buffer> {
  try {
    return await readFile(absolutePath);
  } catch (error) {
    throw new DocumentParseFailedError(
      `无法读取文件：${error instanceof Error ? error.message : String(error)}`,
    );
  }
}

/** 分隔符嗅探：首行引号外 , ; \t 出现次数最高者（并列取 , ） */
function sniffDelimiter(text: string): string {
  const firstLine = text.split(/\r?\n/, 1)[0] ?? "";
  let inQuotes = false;
  const counts = new Map<string, number>([
    [",", 0],
    [";", 0],
    ["\t", 0],
  ]);
  for (const ch of firstLine) {
    if (ch === '"') {
      inQuotes = !inQuotes;
      continue;
    }
    if (!inQuotes && counts.has(ch)) {
      counts.set(ch, (counts.get(ch) ?? 0) + 1);
    }
  }
  let best: string = ",";
  let bestCount = counts.get(",") ?? 0;
  for (const [delimiter, count] of counts) {
    if (count > bestCount) {
      best = delimiter;
      bestCount = count;
    }
  }
  return bestCount === 0 ? "," : best;
}

/**
 * RFC4180 行解析：引号内分隔符 / 换行属于字段，"" 转义为 "。
 * 返回行携带物理行号（line，1 起）——空行不计入结果但行号连续，
 * 与 Excel 行号口径一致。
 */
function parseCsvRows(text: string, delimiter: string): Array<{ cells: string[]; line: number }> {
  const rows: Array<{ cells: string[]; line: number }> = [];
  let row: string[] = [];
  let field = "";
  let inQuotes = false;
  let started = false; // 当前行已出现非终结内容
  let line = 1; // 物理行号（1 起）
  let rowStartLine = 1;
  const pushField = () => {
    row.push(field);
    field = "";
  };
  const pushRow = () => {
    pushField();
    rows.push({ cells: row, line: rowStartLine });
    row = [];
    started = false;
  };
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]!;
    if (inQuotes) {
      if (ch === '"') {
        if (text[index + 1] === '"') {
          field += '"';
          index += 1;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
        if (ch === "\n") {
          line += 1; // 引号内换行也推进物理行号
        }
      }
      continue;
    }
    if (ch === '"') {
      inQuotes = true;
      started = true;
      continue;
    }
    if (ch === delimiter) {
      pushField();
      started = true;
      continue;
    }
    if (ch === "\n") {
      if (started || field !== "") {
        pushRow();
      } else {
        row = []; // 空行：不产出，行号继续
      }
      line += 1;
      rowStartLine = line;
      continue;
    }
    if (ch === "\r") {
      continue; // CRLF 的 \r
    }
    field += ch;
    started = true;
  }
  if (started || field !== "" || row.length > 0) {
    pushRow();
  }
  return rows;
}

/** 表头名：空表头降级为 columnN；重复表头加序号后缀（保证可寻址） */
function headerName(raw: string, index: number): string {
  return raw.trim() !== "" ? raw.trim() : `column${index + 1}`;
}

export function dedupeHeaders(headers: string[]): string[] {
  const seen = new Map<string, number>();
  return headers.map((header) => {
    const count = seen.get(header) ?? 0;
    seen.set(header, count + 1);
    return count === 0 ? header : `${header}_${count + 1}`;
  });
}

/** 0-based 列序号 → 字母（0=A、25=Z、26=AA） */
export function columnLetter(index: number): string {
  let letter = "";
  let n = index;
  while (n >= 0) {
    letter = String.fromCharCode((n % 26) + 65) + letter;
    n = Math.floor(n / 26) - 1;
  }
  return letter;
}

function clipCell(value: string, notes: string[]): string {
  if (value.length <= INGESTION_LIMITS.maxCellChars) {
    return value;
  }
  notes.push(`单元格内容超过 ${INGESTION_LIMITS.maxCellChars} 字符，已截断`);
  return value.slice(0, INGESTION_LIMITS.maxCellChars);
}
