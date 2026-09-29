/**
 * XLSX → DocumentExtraction（M10.1C）。
 *
 * 成熟组件负责解析：exceljs（npm，纯 JS，无外部进程）。PaperTeam 负责
 * provenance：每个 sheet 的每条数据行产出 structured_record，provenance
 * 携带 sheet + 物理行号（含表头 = 1，与 Excel 行号一致），cells 携带
 * 表头名 + 列字母。损坏文件 / 非表格内容抛 DocumentParseFailedError，
 * 不静默。
 *
 * 已知边界（如实，不伪装）：合并单元格只有左上主格有值；公式取计算结果
 *（公式文本不保留）；日期统一 ISO 字符串。
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
import { columnLetter, dedupeHeaders } from "./csvTabular.js";

/** exceljs 是体量较大的可选依赖：延迟加载，缺依赖时报结构化错误 */
async function loadExcelJs(): Promise<typeof import("exceljs")> {
  try {
    return await import("exceljs");
  } catch {
    throw new DocumentParseFailedError(
      "exceljs 依赖不可用（XLSX 解析需要 exceljs，请检查 backend 依赖安装）",
    );
  }
}

export class XlsxParser implements DocumentParser {
  readonly id = "xlsx-exceljs";

  async parseFile(absolutePath: string): Promise<DocumentExtraction> {
    let buffer: Buffer;
    try {
      buffer = await readFile(absolutePath);
    } catch (error) {
      throw new DocumentParseFailedError(
        `无法读取文件：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    return this.parseBuffer(buffer, basename(absolutePath));
  }

  async parseBuffer(buffer: Buffer, fileName: string): Promise<DocumentExtraction> {
    const ExcelJS = await loadExcelJs();
    const workbook = new ExcelJS.Workbook();
    try {
      // cellDates：日期读为 Date（否则是 OAD 编号）；再统一 ISO 字符串。
      // Buffer 类型断言：exceljs 的声明与当前 @types/node 泛型 Buffer 形状不一致
      await workbook.xlsx.load(buffer as unknown as Parameters<typeof workbook.xlsx.load>[0]);
    } catch (error) {
      throw new DocumentParseFailedError(
        `XLSX 解析失败（文件损坏或不是合法 xlsx）：${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
      );
    }
    if (workbook.worksheets.length === 0) {
      throw new DocumentParseFailedError("XLSX 不含任何工作表");
    }

    const notes: string[] = [];
    const blocks: ParsedRecordBlock[] = [];
    const sheets: ParsedSheetSummary[] = [];
    let totalRows = 0;
    let truncated = false;

    for (const worksheet of workbook.worksheets) {
      const sheetName = worksheet.name;
      // exceljs 行号从 1 起（与 Excel 一致）；首行 = 表头
      const headerRow = worksheet.getRow(1);
      const headerCount = Math.max(headerRow.cellCount, 1);
      const headers = dedupeHeaders(
        Array.from({ length: headerCount }, (_, index) => {
          const value = headerRow.getCell(index + 1).value;
          const text = stringifyCell(value).trim();
          return text !== "" ? text : `column${index + 1}`;
        }),
      );

      let sheetRecords = 0;
      // 数据行从物理行 2 起
      for (let rowIndex = 2; rowIndex <= worksheet.rowCount; rowIndex += 1) {
        if (totalRows >= INGESTION_LIMITS.maxTabularRows || blocks.length >= INGESTION_LIMITS.maxBlocks) {
          truncated = true;
          break;
        }
        const row = worksheet.getRow(rowIndex);
        const cells: ParsedRecordCell[] = [];
        const width = Math.max(row.cellCount, headerCount);
        for (let colIndex = 1; colIndex <= width; colIndex += 1) {
          const value = stringifyCell(row.getCell(colIndex).value);
          if (value === "") {
            continue;
          }
          const headerIndex = colIndex - 1;
          cells.push({
            letter: columnLetter(headerIndex),
            header: headers[headerIndex] ?? columnLetter(headerIndex),
            value: clipCell(value, notes),
          });
        }
        if (cells.length === 0) {
          continue; // 空行跳过
        }
        blocks.push({
          blockId: `B${String(blocks.length + 1).padStart(4, "0")}`,
          type: "structured_record",
          provenance: { fileName, sheet: sheetName, row: rowIndex },
          cells,
        });
        sheetRecords += 1;
        totalRows += 1;
      }
      sheets.push({
        name: sheetName,
        rowCount: sheetRecords,
        columnCount: headerCount,
        headers,
      });
      if (truncated) {
        break;
      }
    }
    if (truncated) {
      notes.push(`达到解析上限（行 ${INGESTION_LIMITS.maxTabularRows} / 块 ${INGESTION_LIMITS.maxBlocks}），后续内容截断`);
    }

    return {
      parser: { id: this.id },
      mode: "structured",
      quality: notes.length > 0 ? "partial" : "full",
      sheets,
      blocks,
      notes,
    };
  }
}

/** exceljs cell 值 → 确定性字符串（公式取 result；rich text 拼接；日期 ISO） */
function stringifyCell(value: unknown): string {
  if (value === null || value === undefined) {
    return "";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  if (value instanceof Date) {
    return value.toISOString();
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>;
    // 公式对象 { formula, result }
    if ("result" in record) {
      return stringifyCell(record["result"]);
    }
    // rich text { richText: [{ text }] }
    if (Array.isArray(record["richText"])) {
      return (record["richText"] as Array<{ text?: unknown }>)
        .map((part) => (typeof part.text === "string" ? part.text : ""))
        .join("");
    }
    // 共享字符串对象 { text }
    if (typeof record["text"] === "string") {
      return record["text"];
    }
    if ("error" in record) {
      return String(record["error"]); // #DIV/0! 等，如实保留
    }
  }
  return "";
}

function clipCell(value: string, notes: string[]): string {
  if (value.length <= INGESTION_LIMITS.maxCellChars) {
    return value;
  }
  notes.push(`单元格内容超过 ${INGESTION_LIMITS.maxCellChars} 字符，已截断`);
  return value.slice(0, INGESTION_LIMITS.maxCellChars);
}
