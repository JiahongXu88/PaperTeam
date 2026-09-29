/**
 * Parser Registry（M10.1.1）：文件名 → 资产大类 → parser 的唯一判定点。
 *
 * 纪律：这是查表函数，不是插件框架——不动态加载、不注册回调、不做
 * 内容嗅探兜底（内容层校验在各 parser 内：文本类拒二进制、图片类验
 * magic bytes、Notebook 验 JSON 结构——「不信文件名」由 parser 兜住）。
 * 新增格式 = 扩表 + 实现 DocumentParser，业务层（IngestionService /
 * SourceChunker / HTTP）不改分派逻辑。
 */

import type { ParsedDocumentKind } from "./types.js";

/** 资产大类（ingestion 分派粒度；"other" = 能力边界外，前置拒绝） */
export type SourceAssetKind =
  | "pdf"
  | "csv"
  | "xlsx"
  | "text" // .txt
  | "markdown" // .md
  | "latex" // .tex
  | "json"
  | "yaml" // .yaml / .yml
  | "code" // 常见源码扩展名
  | "notebook" // .ipynb
  | "image" // .png / .jpg / .jpeg
  | "other";

/** 源码扩展名 → 语言标签（CodeTextAsset 的 language 字段；小写） */
const CODE_LANGUAGES: ReadonlyMap<string, string> = new Map([
  [".py", "python"],
  [".pyw", "python"],
  [".c", "c"],
  [".h", "c"],
  [".cpp", "cpp"],
  [".cc", "cpp"],
  [".cxx", "cpp"],
  [".hpp", "cpp"],
  [".hh", "cpp"],
  [".ts", "typescript"],
  [".tsx", "typescript"],
  [".mts", "typescript"],
  [".cts", "typescript"],
  [".js", "javascript"],
  [".jsx", "javascript"],
  [".mjs", "javascript"],
  [".cjs", "javascript"],
  [".rs", "rust"],
  [".go", "go"],
  [".java", "java"],
  [".sh", "shell"],
  [".bash", "shell"],
  [".zsh", "shell"],
  [".ps1", "powershell"],
  [".psm1", "powershell"],
  [".sql", "sql"],
]);

/** 源码扩展名集合（SourceStore 上传白名单共用） */
export const CODE_EXTENSIONS: readonly string[] = [...CODE_LANGUAGES.keys()];

/** 文件名 → 资产大类（扩展名小写匹配；未知 → other） */
export function assetKindOfFileName(fileName: string): SourceAssetKind {
  const lower = fileName.toLowerCase();
  if (lower.endsWith(".pdf")) {
    return "pdf";
  }
  if (lower.endsWith(".csv")) {
    return "csv";
  }
  if (lower.endsWith(".xlsx")) {
    return "xlsx";
  }
  if (lower.endsWith(".txt")) {
    return "text";
  }
  if (lower.endsWith(".md") || lower.endsWith(".markdown")) {
    return "markdown";
  }
  if (lower.endsWith(".tex") || lower.endsWith(".ltx")) {
    return "latex";
  }
  if (lower.endsWith(".json")) {
    return "json";
  }
  if (lower.endsWith(".yaml") || lower.endsWith(".yml")) {
    return "yaml";
  }
  if (lower.endsWith(".ipynb")) {
    return "notebook";
  }
  if (lower.endsWith(".png") || lower.endsWith(".jpg") || lower.endsWith(".jpeg")) {
    return "image";
  }
  for (const extension of CODE_LANGUAGES.keys()) {
    if (lower.endsWith(extension)) {
      return "code";
    }
  }
  return "other";
}

/** 文件名 → 源码语言标签（非源码扩展名返回 undefined） */
export function languageOfFileName(fileName: string): string | undefined {
  const lower = fileName.toLowerCase();
  for (const [extension, language] of CODE_LANGUAGES) {
    if (lower.endsWith(extension)) {
      return language;
    }
  }
  return undefined;
}

/** 资产大类 → 存储模型 kind（xlsx/csv 归 tabular；其余一一对应） */
export function documentKindOfAssetKind(kind: SourceAssetKind): ParsedDocumentKind | "other" {
  switch (kind) {
    case "pdf":
      return "pdf";
    case "csv":
    case "xlsx":
      return "tabular";
    case "text":
    case "markdown":
    case "latex":
    case "json":
    case "yaml":
    case "code":
    case "notebook":
    case "image":
      return kind;
    default:
      return "other";
  }
}

/** 资产大类 → MIME（内容签名未提供时的缺省值） */
export function defaultMimeOfAssetKind(kind: SourceAssetKind): string {
  switch (kind) {
    case "pdf":
      return "application/pdf";
    case "csv":
      return "text/csv";
    case "xlsx":
      return "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet";
    case "text":
      return "text/plain";
    case "markdown":
      return "text/markdown";
    case "latex":
      return "application/x-tex";
    case "json":
      return "application/json";
    case "yaml":
      return "application/yaml";
    case "code":
      return "text/plain";
    case "notebook":
      return "application/x-ipynb+json";
    case "image":
      return "application/octet-stream"; // png/jpeg 由 parser 内容签名覆写
    default:
      return "application/octet-stream";
  }
}
