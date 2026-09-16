/**
 * 最小 BibTeX 条目解析器（M6.2 BibTeX 导入路径）。
 *
 * 边界（刻意最小，不做完整 BibTeX engine）：
 * - 支持 @type{key, field = {value} | "value" | bare, …} 的常见形态；
 * - 值内花括号平衡（嵌套 {…} 保留原样拼接）；@comment/@string/@preamble
 *   跳过（@string 变量不做展开——导入路径如实记录字段原文）；
 * - 连写空白折叠；不解析 LaTeX 宏（\emph 等原样保留，供展示）；
 * - 解析错误按条目收集（errors[].line），不中断其余条目。
 *
 * references.bib 是 ManuscriptService 的**输出**（确定性生成）；本 parser
 * 服务的是导入方向：用户粘贴 / 上传外部 .bib 文件 → SourceItem 元数据。
 */

import type { SourceMetadata, SourceVersionType } from "./SourceStore.js";

export interface BibTexEntry {
  key: string;
  /** 小写条目类型（article / inproceedings / misc / …） */
  type: string;
  /** 字段名小写 → 值（已剥 {...} / "…" 与外层空白） */
  fields: Record<string, string>;
}

export interface BibTexParseIssue {
  line: number;
  message: string;
}

export interface BibTexParseResult {
  entries: BibTexEntry[];
  errors: BibTexParseIssue[];
}

export function parseBibTeX(content: string): BibTexParseResult {
  const entries: BibTexEntry[] = [];
  const errors: BibTexParseIssue[] = [];
  let position = 0;

  while (position < content.length) {
    const at = content.indexOf("@", position);
    if (at === -1) {
      break;
    }
    const header = /^@([A-Za-z]+)\s*([{(])/.exec(content.slice(at, at + 64));
    if (header === null) {
      // 孤立 @（正文里的邮箱等）：跳过继续
      position = at + 1;
      continue;
    }
    const type = header[1]!.toLowerCase();
    const open = header[2]!;
    const close = open === "{" ? "}" : ")";
    const bodyStart = at + header[0].length;
    const line = lineOf(content, at);

    if (type === "comment" || type === "string" || type === "preamble") {
      position = skipBalanced(content, bodyStart, open, close).end;
      continue;
    }

    const { body, end } = readBalanced(content, bodyStart, open, close);
    if (body === null) {
      errors.push({ line, message: `@${type} 条目缺少闭合 ${close}` });
      break;
    }
    position = end;

    const parsed = parseEntryBody(type, body);
    if (typeof parsed === "string") {
      errors.push({ line, message: `@${type} 条目解析失败：${parsed}` });
      continue;
    }
    if (parsed.key === "") {
      errors.push({ line, message: `@${type} 条目缺少 citation key` });
      continue;
    }
    entries.push(parsed);
  }
  return { entries, errors };
}

/** 读到与开头配对的闭合符；返回内部内容与结束位置（未闭合 end=末尾） */
function readBalanced(
  content: string,
  start: number,
  open: string,
  close: string,
): { body: string | null; end: number } {
  let depth = 1;
  let index = start;
  while (index < content.length) {
    const ch = content[index];
    if (ch === open) {
      depth += 1;
    } else if (ch === close) {
      depth -= 1;
      if (depth === 0) {
        return { body: content.slice(start, index), end: index + 1 };
      }
    }
    index += 1;
  }
  return { body: null, end: content.length };
}

/** 只前进到配对闭合符的结束位置（内容丢弃） */
function skipBalanced(
  content: string,
  start: number,
  open: string,
  close: string,
): { end: number } {
  const { end } = readBalanced(content, start, open, close);
  return { end };
}

function parseEntryBody(type: string, body: string): BibTexEntry | string {
  const keyMatch = /^\s*([^,\s]+)\s*,/.exec(body);
  if (keyMatch === null) {
    return "缺少 citation key";
  }
  const key = keyMatch[1]!;
  const fields: Record<string, string> = {};
  let position = keyMatch[0].length;

  while (position < body.length) {
    // 跳过空白与分隔逗号
    while (position < body.length && /[\s,]/.test(body[position]!)) {
      position += 1;
    }
    if (position >= body.length) {
      break;
    }
    const nameMatch = /^([A-Za-z][A-Za-z0-9_-]*)\s*=/.exec(body.slice(position));
    if (nameMatch === null) {
      return `字段名格式非法（"${body.slice(position, position + 20).trim()}…"）`;
    }
    const name = nameMatch[1]!.toLowerCase();
    position += nameMatch[0].length;
    while (position < body.length && /\s/.test(body[position]!)) {
      position += 1;
    }
    const valueResult = readFieldValue(body, position);
    if (valueResult.value === null) {
      return `字段 ${name} 的值格式非法`;
    }
    fields[name] = normalizeWhitespace(valueResult.value);
    position = valueResult.end;
  }
  return { key, type, fields };
}

/** 字段值：{平衡花括号} | "到下一个未转义引号" | 裸 token（到逗号/结尾） */
function readFieldValue(body: string, start: number): { value: string | null; end: number } {
  const ch = body[start];
  if (ch === "{") {
    const { body: inner, end } = readBalanced(body, start + 1, "{", "}");
    return { value: inner, end };
  }
  if (ch === '"') {
    let index = start + 1;
    let value = "";
    while (index < body.length) {
      const current = body[index]!;
      if (current === "\\" && index + 1 < body.length) {
        value += current + body[index + 1]!;
        index += 2;
        continue;
      }
      if (current === '"') {
        return { value, end: index + 1 };
      }
      value += current;
      index += 1;
    }
    return { value: null, end: index };
  }
  const bare = /^[^,}]*/.exec(body.slice(start));
  const value = bare === null ? "" : bare[0]!;
  return { value: value.trim() === "" ? null : value.trim(), end: start + value.length };
}

function normalizeWhitespace(value: string): string {
  return value.replace(/\s+/g, " ").trim();
}

function lineOf(content: string, index: number): number {
  let line = 1;
  for (let i = 0; i < index && i < content.length; i += 1) {
    if (content[i] === "\n") {
      line += 1;
    }
  }
  return line;
}

// ---- BibTeX entry → 导入输入映射 ----

export interface BibEntryMapping {
  metadata: SourceMetadata;
  versionType: SourceVersionType;
}

/** entry 类型 → versionType 映射 */
const VERSION_TYPE_BY_ENTRY: Readonly<Record<string, SourceVersionType>> = {
  article: "journal",
  inproceedings: "conference",
  conference: "conference",
  phdthesis: "other",
  mastersthesis: "other",
  techreport: "other",
  misc: "other",
};

/**
 * 条目字段 → SourceMetadata（最小映射：title / author / year / doi / url /
 * venue；author 按 " and " 分割；eprint 或 arxiv URL 提取 arxivId）。
 */
export function mapBibEntry(entry: BibTexEntry): BibEntryMapping {
  const fields = entry.fields;
  const metadata: SourceMetadata = {};
  if (fields["title"] !== undefined && fields["title"] !== "") {
    // BibTeX 花括号是大小写保护语法，不是内容——展示/检索用去壳文本
    metadata.title = fields["title"].replace(/[{}]/g, "");
  }
  if (fields["author"] !== undefined) {
    const authors = fields["author"]
      .split(/\s+and\s+/i)
      .map((author) => normalizeWhitespace(author.replace(/[{}]/g, "")))
      .filter((author) => author !== "")
      .slice(0, 20);
    if (authors.length > 0) {
      metadata.authors = authors;
    }
  }
  const year = Number.parseInt(fields["year"] ?? "", 10);
  if (Number.isInteger(year)) {
    metadata.year = year;
  }
  if (fields["doi"] !== undefined && fields["doi"] !== "") {
    metadata.doi = fields["doi"];
  }
  const venue = fields["journal"] ?? fields["booktitle"];
  if (venue !== undefined && venue !== "") {
    metadata.venue = venue.replace(/[{}]/g, "");
  }
  const url = fields["url"] ?? fields["howpublished"];
  if (url !== undefined && /^https?:\/\//i.test(url)) {
    metadata.url = url;
  }
  const arxivId = extractArxivId(fields);
  if (arxivId !== undefined) {
    metadata.arxivId = arxivId;
  }
  if (fields["abstract"] !== undefined && fields["abstract"] !== "") {
    metadata.abstract = fields["abstract"].slice(0, 3000);
  }
  return {
    metadata,
    versionType: VERSION_TYPE_BY_ENTRY[entry.type] ?? "other",
  };
}

/** eprint 字段或 arxiv.org URL 中提取 arXiv id（原始值；归一在 identity 层） */
function extractArxivId(fields: Record<string, string>): string | undefined {
  if (fields["eprint"] !== undefined && fields["eprint"] !== "") {
    return fields["eprint"];
  }
  for (const key of ["url", "howpublished"]) {
    const value = fields[key];
    if (value === undefined) {
      continue;
    }
    const match = /arxiv\.org\/(?:abs|pdf)\/([^\s)}]+?)(?:v\d+)?$/i.exec(value);
    if (match !== null) {
      return match[1]!;
    }
  }
  return undefined;
}
