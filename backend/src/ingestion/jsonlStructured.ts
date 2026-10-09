/**
 * JSONL（NDJSON）→ DocumentExtraction（M13.3）。
 *
 * 行式语义：每条非空行是一个独立 JSON 记录 → 一条 structured_record，
 * cells = 顶层标量字段（与 CSV 的「每行一条记录」同构——这正是行流格式
 * 在实验包里的自然形态：逐事件 / 逐机会 / 逐 step 的记录流）。
 * - 嵌套字段值以紧凑 JSON 字符串入 cell（行流的首要用途是按字段对齐，
 *   不做叶子展开——展开会产生唯一表头的 1×N 宽表，丢失行语义）；
 * - 非对象行 → 单值记录（header = "value"）；
 * - provenance = fileName + 物理行号（1-based，含空行计数）；
 * - 行流是特征/事件数据，不是实验级指标表：ExperimentPackageService 的
 *   指标观测提取明确跳过本 parser 的文档（防 score/cos 之类逐事件数值
 *   淹没 workflow context；行流的首要去向是图表数据集）。
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { DocumentParseFailedError } from "../errors.js";
import { renderScalarValue } from "./structuredProjection.js";
import type { DocumentExtraction, DocumentParser } from "./types.js";
import { INGESTION_LIMITS } from "./types.js";

interface Cell {
  header: string;
  value: string;
  letter?: string;
}

export class JsonlParser implements DocumentParser {
  readonly id = "jsonl";

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

  parseBuffer(buffer: Buffer, fileName: string): DocumentExtraction {
    let text = buffer.toString("utf8");
    if (text.charCodeAt(0) === 0xfeff) {
      text = text.slice(1);
    }
    if (text.trim() === "") {
      throw new DocumentParseFailedError("JSONL 文件内容为空");
    }
    const notes: string[] = [];
    const blocks: Array<{ blockId: string; provenance: { fileName: string; row: number }; cells: Cell[] }> = [];
    let capped = false;
    const lines = text.split(/\r\n|\n/);
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!.trim();
      if (line === "") continue;
      if (blocks.length >= INGESTION_LIMITS.maxBlocks) {
        if (!capped) {
          capped = true;
          notes.push(`记录条数达到块上限 ${INGESTION_LIMITS.maxBlocks}，已截断`);
        }
        break;
      }
      let value: unknown;
      try {
        value = JSON.parse(line);
      } catch (error) {
        throw new DocumentParseFailedError(
          `JSONL 第 ${index + 1} 行不是合法 JSON：${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const cells: Cell[] = [];
      if (value !== null && typeof value === "object" && !Array.isArray(value)) {
        for (const [key, field] of Object.entries(value as Record<string, unknown>)) {
          if (cells.length >= 256) {
            notes.push(`第 ${index + 1} 行字段数超过 256，已截断`);
            break;
          }
          const rendered =
            field !== null && typeof field === "object"
              ? safeCompact(field)
              : renderScalarValue(field);
          cells.push({ header: key, value: rendered.slice(0, INGESTION_LIMITS.maxCellChars) });
        }
      } else {
        cells.push({ header: "value", value: renderScalarValue(value).slice(0, INGESTION_LIMITS.maxCellChars) });
      }
      blocks.push({
        blockId: `B${String(blocks.length + 1).padStart(4, "0")}`,
        provenance: { fileName, row: index + 1 },
        cells,
      });
    }
    return {
      parser: { id: this.id },
      mode: "structured",
      quality: capped || notes.length > 0 ? "partial" : "full",
      blocks: blocks.map((block) => ({
        blockId: block.blockId,
        type: "structured_record" as const,
        provenance: { fileName: block.provenance.fileName, row: block.provenance.row },
        cells: block.cells,
      })),
      notes,
    };
  }
}

/** 嵌套字段 → 紧凑 JSON（循环引用防御：JSON.parse 产物无环，防御仅兜底） */
function safeCompact(value: unknown): string {
  try {
    return JSON.stringify(value) ?? "null";
  } catch {
    return "[unserializable]";
  }
}
