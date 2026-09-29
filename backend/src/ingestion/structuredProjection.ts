/**
 * 结构化树 → structured_record 投影（M10.1.1；JSON / YAML 共用）。
 *
 * 轻量投影纪律：
 * - 每个标量叶子（含空容器标记）一条 structured_record，cells 单值
 *   （header = 完整路径 `$.training.epochs` / `$.metrics[0].mota`）；
 * - 原始文件仍是 source of truth——投影只是可检索 / 可确认的视图，
 *   永远不是新的事实源；
 * - 行号可提供时进 provenance.row（YAML AST；JSON.parse 无位置——缺省）；
 * - 防御上限：深度 / 块数 / 单值字符，触顶如实截断（notes + truncated）。
 */

import type { ParsedRecordBlock } from "./types.js";
import { INGESTION_LIMITS } from "./types.js";

/** 解析树中立项（JSON value 树 / YAML AST 的共同形状） */
export interface StructuredNode {
  kind: "scalar" | "map" | "seq";
  /** scalar 原始值（string / number / boolean / null / 其它原样 String 化） */
  value?: unknown;
  /** map 条目（保序） */
  entries?: Array<{ key: string; node: StructuredNode }>;
  /** seq 条目 */
  items?: StructuredNode[];
  /** 1-based 所在行（YAML 提供；JSON 缺省） */
  line?: number;
}

/** JSON value → StructuredNode（无行号） */
export function structuredNodeOfJson(value: unknown): StructuredNode {
  if (value === null || typeof value !== "object") {
    return { kind: "scalar", value };
  }
  if (Array.isArray(value)) {
    return { kind: "seq", items: value.map((item) => structuredNodeOfJson(item)) };
  }
  return {
    kind: "map",
    entries: Object.entries(value).map(([key, node]) => ({ key, node: structuredNodeOfJson(node) })),
  };
}

/** 标量值 → 记录值字符串（null/boolean/number/unknown 统一文本化） */
export function renderScalarValue(value: unknown): string {
  if (value === null) {
    return "null";
  }
  if (typeof value === "string") {
    return value;
  }
  if (typeof value === "number" || typeof value === "boolean") {
    return String(value);
  }
  // YAML 特殊标量（undefined 等）与未知类型：文本化，不猜测语义
  return value === undefined ? "undefined" : String(value);
}

/** 路径段拼接：安全标识符用点号，否则 JSON 括号记法（显示 + 寻址两用） */
export function joinPath(parent: string, key: string): string {
  if (/^[A-Za-z0-9_$-]+$/.test(key)) {
    return `${parent}.${key}`;
  }
  return `${parent}[${JSON.stringify(key)}]`;
}

/**
 * 投影入口。root 为空（空文件在 parser 层已拒绝）时返回空数组并记 note。
 */
export function projectStructuredTree(
  root: StructuredNode | null,
  fileName: string,
  notes: string[],
): ParsedRecordBlock[] {
  const blocks: ParsedRecordBlock[] = [];
  let capped = false;
  const pushNote = (message: string) => {
    if (!notes.includes(message) && notes.length < INGESTION_LIMITS.maxNotes) {
      notes.push(message);
    }
  };
  const emit = (node: StructuredNode, path: string, rendered: string, truncated: boolean) => {
    blocks.push({
      blockId: `B${String(blocks.length + 1).padStart(4, "0")}`,
      type: "structured_record",
      provenance: {
        fileName,
        jsonPath: path,
        ...(node.line !== undefined ? { row: node.line } : {}),
      },
      cells: [{ header: path, value: rendered }],
      ...(truncated ? { truncated: true } : {}),
    });
  };
  const walk = (node: StructuredNode, path: string, depth: number): void => {
    if (blocks.length >= INGESTION_LIMITS.maxBlocks) {
      if (!capped) {
        capped = true;
        pushNote(`投影条目数达到块上限 ${INGESTION_LIMITS.maxBlocks}，已截断`);
      }
      return;
    }
    if (node.kind === "scalar") {
      const raw = renderScalarValue(node.value);
      if (raw.length <= INGESTION_LIMITS.maxCellChars) {
        emit(node, path, raw, false);
      } else {
        pushNote(`值超过 ${INGESTION_LIMITS.maxCellChars} 字符，已截断（${path}）`);
        emit(node, path, raw.slice(0, INGESTION_LIMITS.maxCellChars), true);
      }
      return;
    }
    if (depth >= INGESTION_LIMITS.maxProjectionDepth) {
      // 深度触顶：按叶子渲染（紧凑 JSON），如实标记截断
      const compact = safeStringify(node);
      pushNote(`嵌套深度达到 ${INGESTION_LIMITS.maxProjectionDepth}，子树按叶子渲染（${path}）`);
      emit(node, path, compact.slice(0, INGESTION_LIMITS.maxCellChars), true);
      return;
    }
    if (node.kind === "seq") {
      const items = node.items ?? [];
      if (items.length === 0) {
        emit(node, path, "[]", false);
        return;
      }
      for (let index = 0; index < items.length; index += 1) {
        walk(items[index]!, `${path}[${index}]`, depth + 1);
      }
      return;
    }
    const entries = node.entries ?? [];
    if (entries.length === 0) {
      emit(node, path, "{}", false);
      return;
    }
    for (const entry of entries) {
      walk(entry.node, joinPath(path, entry.key), depth + 1);
    }
  };
  if (root !== null) {
    walk(root, "$", 0);
  }
  return blocks;
}

/** 结构化树 → 紧凑 JSON（循环引用防御：失败退化为 String 化） */
function safeStringify(node: StructuredNode): string {
  try {
    return JSON.stringify(toPlainValue(node)) ?? "null";
  } catch {
    return "[unserializable]";
  }
}

function toPlainValue(node: StructuredNode): unknown {
  if (node.kind === "scalar") {
    return node.value ?? null;
  }
  if (node.kind === "seq") {
    return (node.items ?? []).map((item) => toPlainValue(item));
  }
  return Object.fromEntries((node.entries ?? []).map((entry) => [entry.key, toPlainValue(entry.node)]));
}
