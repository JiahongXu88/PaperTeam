/**
 * Agent 结构化输出解析辅助。
 *
 * LLM 时常无视指令在 JSON 外包一层说明文字或 Markdown 围栏；
 * 这里做防御性提取：剥围栏 → 定位首个平衡的 JSON 对象 → 解析。
 * 解析失败抛 AgentRunFailedError（映射为可重试的 transient 失败）。
 */

import { AgentRunFailedError } from "../errors.js";

/**
 * 结构化输出校验错误的分类（M9.7.4 Reviewer Repair）。
 * 用于 error-feedback repair：把具体违约类型回馈给模型，而不是原样重跑。
 */
export type StructuredOutputErrorKind =
  | "json_parse"
  | "missing_field"
  | "wrong_type"
  | "invalid_enum"
  | "invalid_value";

/**
 * 结构化输出校验失败（AgentRunFailedError 的子类：对既有 catch / Stage
 * 分类完全兼容，额外携带 kind + field 供 repair 循环反馈）。
 */
export class StructuredOutputError extends AgentRunFailedError {
  readonly kind: StructuredOutputErrorKind;
  readonly field?: string;

  constructor(message: string, kind: StructuredOutputErrorKind, field?: string) {
    super(message);
    this.kind = kind;
    this.field = field;
  }
}

/** 校验错误的人读描述（repair prompt 注入用；非 StructuredOutputError 原样返回消息） */
export function describeStructuredError(error: AgentRunFailedError): string {
  if (error instanceof StructuredOutputError) {
    return `[${error.kind}${error.field !== undefined ? `:${error.field}` : ""}] ${error.message}`;
  }
  return error.message;
}

/** Markdown 代码围栏 */
const FENCE_PATTERN = /^\s*```[a-zA-Z]*\s*\n([\s\S]*?)\n?```\s*$/;

/** 剥离模型可能误加的 Markdown 代码围栏 */
export function stripCodeFence(text: string): string {
  const match = FENCE_PATTERN.exec(text.trim());
  if (match?.[1]) {
    return match[1].trim();
  }
  return text.trim();
}

/** 从模型输出中提取 JSON 对象（不信任自述；找不到抛 StructuredOutputError） */
export function extractJsonObject(raw: string, what: string): Record<string, unknown> {
  const text = stripCodeFence(raw);
  const start = text.indexOf("{");
  if (start === -1) {
    throw new StructuredOutputError(`${what}：输出中找不到 JSON 对象`, "json_parse");
  }
  // 从每个 "{" 起尝试平衡匹配（容忍字符串内的花括号）
  for (let from = start; from < text.length; from += 1) {
    if (text[from] !== "{") {
      continue;
    }
    const attempt = tryBalancedJson(text, from);
    if (attempt.kind === "parsed") {
      return attempt.value;
    }
    if (attempt.kind === "unterminated") {
      // 该 "{" 直到文本末尾都没有闭合：之后的每个 "{" 都是它的嵌套子对象，
      // 继续回退只会抓到一个碎片（例如 bibliography 里的某一条）并报出
      // 误导性的「缺少字段 X」。这是输出被截断的确定性信号，直接如实报告。
      throw new StructuredOutputError(
        `${what}：输出的 JSON 不完整（对象未闭合，疑似被模型输出上限截断）`,
        "json_parse",
      );
    }
  }
  throw new StructuredOutputError(`${what}：输出的 JSON 无法解析`, "json_parse");
}

type BalancedJsonAttempt =
  | { kind: "parsed"; value: Record<string, unknown> }
  /** 闭合了但不是合法 JSON 对象（可能是说明文字里的花括号）→ 继续尝试下一个 "{" */
  | { kind: "invalid" }
  /** 直到文本末尾都未闭合（截断信号） */
  | { kind: "unterminated" };

function tryBalancedJson(text: string, start: number): BalancedJsonAttempt {
  let depth = 0;
  let inString = false;
  let escaped = false;
  for (let index = start; index < text.length; index += 1) {
    const ch = text[index];
    if (inString) {
      if (escaped) {
        escaped = false;
      } else if (ch === "\\") {
        escaped = true;
      } else if (ch === '"') {
        inString = false;
      }
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        try {
          const parsed = JSON.parse(text.slice(start, index + 1)) as unknown;
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            return { kind: "parsed", value: parsed as Record<string, unknown> };
          }
          return { kind: "invalid" };
        } catch {
          return { kind: "invalid" };
        }
      }
    }
  }
  return { kind: "unterminated" };
}

// ---- 结构化字段的防御性读取 ----

export function readRequiredString(record: Record<string, unknown>, field: string, context: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new StructuredOutputError(
      `${context}：缺少非空字符串字段 ${field}`,
      value === undefined ? "missing_field" : "wrong_type",
      field,
    );
  }
  return value.trim();
}

export function readRequiredStringArray(
  record: Record<string, unknown>,
  field: string,
  context: string,
  options: { minItems?: number } = {},
): string[] {
  const value = record[field];
  if (!Array.isArray(value) || value.length < (options.minItems ?? 1)) {
    throw new StructuredOutputError(
      `${context}：字段 ${field} 必须是至少 ${options.minItems ?? 1} 项的字符串数组`,
      value === undefined ? "missing_field" : "wrong_type",
      field,
    );
  }
  const items = value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  if (items.length < (options.minItems ?? 1)) {
    throw new StructuredOutputError(`${context}：字段 ${field} 包含非法项`, "wrong_type", field);
  }
  return items.map((item) => item.trim());
}

export function readOptionalStringArray(
  record: Record<string, unknown>,
  field: string,
): string[] | undefined {
  const value = record[field];
  if (!Array.isArray(value)) {
    return undefined;
  }
  const items = value.filter((item): item is string => typeof item === "string" && item.trim() !== "");
  return items.length > 0 ? items.map((item) => item.trim()) : undefined;
}

export function readRequiredEnum<T extends string>(
  record: Record<string, unknown>,
  field: string,
  allowed: readonly T[],
  context: string,
): T {
  const value = record[field];
  if (typeof value !== "string" || !allowed.includes(value as T)) {
    throw new StructuredOutputError(
      `${context}：字段 ${field} 只能是 ${allowed.join(" / ")}，当前为 "${String(value)}"`,
      value === undefined ? "missing_field" : "invalid_enum",
      field,
    );
  }
  return value as T;
}
