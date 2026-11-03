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

/**
 * M16 工程收口 A：顶层对象的「只加转义」修复种类（不改任何字符内容，只把模型漏写的转义补上）。
 * - control_chars：字符串内原始 Tab / 换行（既有，M15.1）
 * - invalid_escape：字符串内 JSON 不认的反斜杠转义（LaTeX \mathcal、\cite 等）→ 反斜杠按字面量保留
 * - stray_quote：字符串内未转义的 ASCII 双引号（后面不是 , } ] : 等结构跟随符）→ 按字面量保留
 */
export type JsonRepairKind = "control_chars" | "invalid_escape" | "stray_quote";

export interface ExtractJsonOptions {
  /**
   * 合法结果必须至少含其中一个顶层键（缺省不校验）。防止把错误体（如 `401: {"code":…}`）或
   * 内层碎片（单条 issue / claim）当成整份输出接受。
   */
  expectAnyKey?: readonly string[];
  /** 顶层对象经只加转义修复后才解析成功时回调（调用方记入 provenance；未修复不回调） */
  onRepair?: (kinds: JsonRepairKind[]) => void;
}

/** 从模型输出中提取 JSON 对象（不信任自述；找不到抛 StructuredOutputError） */
export function extractJsonObject(raw: string, what: string, options: ExtractJsonOptions = {}): Record<string, unknown> {
  const text = stripCodeFence(raw);
  const start = text.indexOf("{");
  if (start === -1) {
    throw new StructuredOutputError(`${what}：输出中找不到 JSON 对象`, "json_parse");
  }
  const keysOk = (value: Record<string, unknown>): boolean =>
    options.expectAnyKey === undefined || options.expectAnyKey.some((key) => key in value);
  // M16 工程收口 A：输出本身就是一个顶层对象（首字符 "{" 且末字符 "}"）时，内层的 "{" 只可能是它的子对象。
  // 旧行为：顶层因未转义引号 / 反斜杠解析失败 → 回退到下一个 "{" → 返回单条 issue 碎片，整单元 issues 与分数
  // 被静默清零（单元仍记 completed，claims 缺失又触发修复调用）。M16 留出集 232 次单元输出中 35 次如此。
  // 现在：先对顶层对象做只加转义的修复；仍失败就如实报错（调用方按既有重试 / 失败处理），绝不回退到碎片。
  const wholeObject = start === 0 && text.endsWith("}");
  for (let from = start; from < text.length; from += 1) {
    if (text[from] !== "{") {
      continue;
    }
    const attempt = tryBalancedJson(text, from);
    if (attempt.kind === "parsed" && keysOk(attempt.value)) {
      return attempt.value;
    }
    if (from === start && attempt.kind !== "parsed") {
      const end = text.lastIndexOf("}");
      const repaired = end > from ? repairJsonEscapes(text.slice(from, end + 1)) : null;
      if (repaired !== null && repaired.kinds.length > 0) {
        try {
          const parsed = JSON.parse(repaired.text) as unknown;
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed) && keysOk(parsed as Record<string, unknown>)) {
            options.onRepair?.(repaired.kinds);
            return parsed as Record<string, unknown>;
          }
        } catch {
          // 修复后仍不合法：落到下面的如实报错 / 旧回退逻辑
        }
      }
      if (wholeObject) {
        throw new StructuredOutputError(
          `${what}：输出的顶层 JSON 对象不合法（只加转义修复后仍无法解析；不回退到内层片段）`,
          "json_parse",
        );
      }
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
  if (options.expectAnyKey !== undefined) {
    throw new StructuredOutputError(`${what}：输出中没有含 ${options.expectAnyKey.join(" / ")} 的 JSON 对象`, "missing_field");
  }
  throw new StructuredOutputError(`${what}：输出的 JSON 无法解析`, "json_parse");
}

/**
 * 只加转义的修复（control_chars → invalid_escape → stray_quote）。返回实际生效的修复种类；
 * 不删除、不改写任何字符，结构不合法的输出修复后仍会解析失败（fail-closed）。
 */
export function repairJsonEscapes(text: string): { text: string; kinds: JsonRepairKind[] } {
  const kinds: JsonRepairKind[] = [];
  const controls = escapeControlCharsInJsonStrings(text);
  if (controls !== text) kinds.push("control_chars");
  const escapes = escapeInvalidBackslashesInJsonStrings(controls);
  if (escapes !== controls) kinds.push("invalid_escape");
  const quotes = escapeStrayQuotesInJsonStrings(escapes);
  if (quotes !== escapes) kinds.push("stray_quote");
  return { text: quotes, kinds };
}

const VALID_ESCAPES = new Set(['"', "\\", "/", "b", "f", "n", "r", "t", "u"]);

/** 字符串内 JSON 不认的转义（\m、\c、\u 后不足 4 位十六进制…）→ 把反斜杠本身转义（字面量保留） */
export function escapeInvalidBackslashesInJsonStrings(text: string): string {
  let out = "";
  let inString = false;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]!;
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (ch === "\\") {
      const next = text[index + 1];
      const validUnicode = next !== "u" || /^[0-9a-fA-F]{4}$/.test(text.slice(index + 2, index + 6));
      if (next !== undefined && VALID_ESCAPES.has(next) && validUnicode) {
        out += ch + next;
        index += 1;
      } else {
        out += "\\\\";
      }
      continue;
    }
    if (ch === '"') inString = false;
    out += ch;
  }
  return out;
}

/** 字符串内未转义的双引号：其后（跳过空白）不是 } ] : 、文本结束或「, + 值起始符」→ 视为字面量并转义 */
export function escapeStrayQuotesInJsonStrings(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]!;
    if (!inString) {
      if (ch === '"') inString = true;
      out += ch;
      continue;
    }
    if (escaped) {
      escaped = false;
      out += ch;
      continue;
    }
    if (ch === "\\") {
      escaped = true;
      out += ch;
      continue;
    }
    if (ch === '"') {
      let next = index + 1;
      while (next < text.length && /\s/.test(text[next]!)) next += 1;
      const follower = text[next];
      // "," 之后还须是 JSON 值 / 键的起始符（"Splatting", a loose… 里的逗号属于正文）
      let afterComma = next + 1;
      while (follower === "," && afterComma < text.length && /\s/.test(text[afterComma]!)) afterComma += 1;
      const commaIsStructural = follower === "," && /["{[\-0-9tfn]/.test(text[afterComma] ?? "");
      if (follower === undefined || commaIsStructural || follower === "}" || follower === "]" || follower === ":") {
        inString = false;
        out += ch;
      } else {
        out += '\\"';
      }
      continue;
    }
    out += ch;
  }
  return out;
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
        const slice = text.slice(start, index + 1);
        try {
          const parsed = JSON.parse(slice) as unknown;
          if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
            return { kind: "parsed", value: parsed as Record<string, unknown> };
          }
          return { kind: "invalid" };
        } catch {
          // M15.1：模型逐字摘录 LaTeX 表格时常把原始 Tab / 换行写进 JSON 字符串（JSON 不允许未转义控制字符）。
          // 旧行为：整体解析失败 → 回退到下一个 "{" → 返回某个内层碎片（如单条 issue），整单元的 issues 与分数被静默丢弃
          // （M15 base run 2170 次输出中 5 次，均为含表格行的单元）。这里只把字符串内的控制字符转义后重试一次；
          // 结构本身不合法仍判 invalid，不放宽任何字段校验。
          const repaired = escapeControlCharsInJsonStrings(slice);
          if (repaired !== slice) {
            try {
              const parsed = JSON.parse(repaired) as unknown;
              if (typeof parsed === "object" && parsed !== null && !Array.isArray(parsed)) {
                return { kind: "parsed", value: parsed as Record<string, unknown> };
              }
            } catch {
              // 仍不合法：按原逻辑继续尝试下一个 "{"
            }
          }
          return { kind: "invalid" };
        }
      }
    }
  }
  return { kind: "unterminated" };
}

/** 只转义 JSON 字符串字面量内部的原始控制字符（U+0000–U+001F）；字符串外的空白不动 */
export function escapeControlCharsInJsonStrings(text: string): string {
  let out = "";
  let inString = false;
  let escaped = false;
  for (const ch of text) {
    if (inString) {
      if (escaped) {
        escaped = false;
        out += ch;
        continue;
      }
      if (ch === "\\") {
        escaped = true;
        out += ch;
        continue;
      }
      if (ch === '"') {
        inString = false;
        out += ch;
        continue;
      }
      const code = ch.charCodeAt(0);
      if (code < 0x20) {
        out += ch === "\t" ? "\\t" : ch === "\n" ? "\\n" : ch === "\r" ? "\\r" : `\\u${code.toString(16).padStart(4, "0")}`;
        continue;
      }
      out += ch;
      continue;
    }
    if (ch === '"') inString = true;
    out += ch;
  }
  return out;
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
