/**
 * YAML / YML → DocumentExtraction（M10.1.1）。
 *
 * 行为与 JSON 投影同型（structuredProjection 共用）：mapping / list / scalar
 * 叶子 → structured_record（header = 完整路径）。复用成熟 `yaml` 库的 AST
 * + LineCounter 低成本保留行号（provenance.row = 值所在行，1-based）。
 * 不自写 YAML parser；复杂键（? 语法）按源文本键名处理（罕见，如实投影）。
 */

import { readFile } from "node:fs/promises";
import { basename } from "node:path";

import { LineCounter, parseDocument, Scalar, YAMLMap, YAMLSeq } from "yaml";

import { DocumentParseFailedError } from "../errors.js";
import { projectStructuredTree, type StructuredNode } from "./structuredProjection.js";
import type { DocumentExtraction, DocumentParser } from "./types.js";

export class YamlParser implements DocumentParser {
  readonly id = "yaml";

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
      throw new DocumentParseFailedError("YAML 文件内容为空");
    }
    const lineCounter = new LineCounter();
    const document = parseDocument(text, { lineCounter });
    if (document.errors.length > 0) {
      const first = document.errors[0]!;
      const position = first.linePos !== undefined ? `（line ${first.linePos[0]?.line}）` : "";
      throw new DocumentParseFailedError(`YAML 解析失败${position}：${first.message.slice(0, 200)}`);
    }
    if (document.contents === null) {
      // 仅注释 / 空文档：parse 成功但无内容——按空文件处理（明确失败）
      throw new DocumentParseFailedError("YAML 文档无内容（仅注释或空）");
    }
    const notes: string[] = [];
    const blocks = projectStructuredTree(
      structuredNodeOfYaml(document.contents, lineCounter),
      fileName,
      notes,
    );
    return {
      parser: { id: this.id },
      mode: "structured",
      quality: notes.length > 0 ? "partial" : "full",
      blocks,
      notes,
    };
  }
}

/** YAML AST → StructuredNode（携带 1-based 行号；linePos 缺失时不伪造） */
function structuredNodeOfYaml(node: unknown, lineCounter: LineCounter): StructuredNode {
  if (node === undefined || node === null) {
    return { kind: "scalar", value: null };
  }
  const line = lineOf(node, lineCounter);
  if (node instanceof Scalar) {
    return { kind: "scalar", value: node.value, ...(line !== undefined ? { line } : {}) };
  }
  if (node instanceof YAMLSeq) {
    return {
      kind: "seq",
      ...(line !== undefined ? { line } : {}),
      items: node.items.map((item) => structuredNodeOfYaml(item, lineCounter)),
    };
  }
  if (node instanceof YAMLMap) {
    return {
      kind: "map",
      ...(line !== undefined ? { line } : {}),
      entries: node.items.map((pair) => ({
        key: keyText(pair.key),
        node: structuredNodeOfYaml(pair.value, lineCounter),
      })),
    };
  }
  // 其它节点形态（极少见）：文本化处理，不猜测结构
  return { kind: "scalar", value: String(node), ...(line !== undefined ? { line } : {}) };
}

/** Pair 键名：常规标量键取值；复杂键按源文本（joinPath 自动转括号记法） */
function keyText(key: unknown): string {
  if (key instanceof Scalar) {
    return key.value === null || key.value === undefined ? "null" : String(key.value);
  }
  if (key === undefined || key === null) {
    return "null";
  }
  return String(key).trim();
}

function lineOf(node: unknown, lineCounter: LineCounter): number | undefined {
  const range = (node as { range?: unknown }).range;
  if (!Array.isArray(range) || typeof range[0] !== "number") {
    return undefined;
  }
  return lineCounter.linePos(range[0]).line;
}
