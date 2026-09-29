/**
 * JSON → DocumentExtraction（M10.1.1）。
 *
 * 不当普通文本索引：标量叶子投影成 structured_record（header = 完整路径
 * `$.training.epochs` / `$.metrics[0].mota`），可检索、可确认；原始文件
 * 仍是 source of truth。JSON.parse 不携带位置信息——行号缺省不伪造
 * （provenance = fileName + jsonPath）。
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { DocumentParseFailedError } from "../errors.js";
import { projectStructuredTree, structuredNodeOfJson } from "./structuredProjection.js";
import type { DocumentExtraction, DocumentParser } from "./types.js";

export class JsonParser implements DocumentParser {
  readonly id = "json";

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
      throw new DocumentParseFailedError("JSON 文件内容为空");
    }
    let value: unknown;
    try {
      value = JSON.parse(text);
    } catch (error) {
      throw new DocumentParseFailedError(
        `JSON 解析失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
    const notes: string[] = [];
    const blocks = projectStructuredTree(structuredNodeOfJson(value), fileName, notes);
    return {
      parser: { id: this.id },
      mode: "structured",
      quality: notes.length > 0 ? "partial" : "full",
      blocks,
      notes,
    };
  }
}
