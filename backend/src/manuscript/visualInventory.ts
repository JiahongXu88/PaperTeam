/**
 * Manuscript Visual Inventory（M12 Batch 1 · B1：确定性、零 LLM、零 IO 的核心解析）。
 *
 * 从 LaTeX 手稿的 .tex 文本解析 figure / figure* / table / table* 四种视觉
 * 环境（第一版就这四种，不做 scope creep），产出结构化 inventory：
 *   - 环境清单：label / caption / includegraphics 路径 / placement /
 *     1-based 行号 / 归属章节（linkedSection）/ 表格行列与网格；
 *   - 视觉引用域：\ref / \autoref / \Cref / \cref 中 fig: / tab: 前缀 key
 *     的引用位置清单与 unresolved 判定（确定性 review finding 源）；
 *   - caption 缺失环境清单（确定性 finding 源）。
 *
 * 纪律（照抄 revisionBaseline 手法，已在 3 个真实返修项目验证）：
 * - 纯读取：不写回任何 .tex；花括号不闭合等解析不动的地方一律字段缺省，
 *   fail-soft 不伪造（缺 label / 缺 caption / 无 tabular 都如实呈现）；
 * - 保守正则 + 有限花括号平衡提取（一层嵌套取平；解不动 → undefined）；
 * - 确定性：无时间戳 / 无随机 / 无 LLM，同输入同输出（byte 级一致）；
 *   CRLF 在入口统一归一为 LF，CRLF 与 LF 输入产出等价 inventory；
 * - 截断防御（表格行数上限）显式进 notes，不静默。
 *
 * 与 M12.0 §8.2 冻结 schema 的 additive 差异（均为任务书明确要求或 B2/B3
 * 消费所必需）：environment 字面量、lineEnd / linkedSection / hasTabular /
 * headers / rows、references 位置清单、notes、manuscriptRevision 可缺省
 * （调用方给不了就不写，不伪造 0）。generatedFiguresUsed 保留 §8.2 原样
 * （figs/generated/ 前缀的确定性字符串判定，为 M12.3 跨轨对齐预留）。
 *
 * 持久化（IO 层，见文件底部）：research/manuscript-visuals.json —— 手稿侧
 * 唯一新落盘物（derived、可随时重建）。本轮不接 revision 循环（B3/B5 职责）。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { BusinessError } from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { writeJsonAtomic } from "../util/atomic.js";

/** 输入文件（与 review/revisionBaseline 的 BaselineTexFile 同形，可直接传入） */
export interface VisualInventoryTexFile {
  /** 相对 manuscript 目录的 POSIX 路径 */
  file: string;
  content: string;
}

export interface BuildVisualInventoryOptions {
  /** 对齐 RevisionStore 的修订编号；给不了就缺省（不伪造） */
  manuscriptRevision?: number;
}

export interface VisualInventoryFigureEntry {
  /** 文件内同类环境的 1-based 序号（figures 数组内位置 + 1；确定性 id 组成部分） */
  envIndex: number;
  environment: "figure" | "figure*";
  label?: string;
  caption?: string;
  /** 环境体内首个 \includegraphics 的路径（保留原文，反斜杠归一为 /） */
  includegraphicsPath?: string;
  /** \begin{figure}[htbp] 可选参数原文（无则缺省） */
  placement?: string;
  /** 环境起始 \begin 所在 1-based 行号 */
  lineStart: number;
  /** 环境 \end 收尾所在 1-based 行号 */
  lineEnd: number;
  /** 同文件内、环境之前最近的 \chapter/\section/\subsection 标题（清洗后文本） */
  linkedSection?: string;
}

export interface VisualInventoryTableEntry {
  envIndex: number;
  environment: "table" | "table*";
  label?: string;
  caption?: string;
  /** 解析出的网格行数（含表头行；≤ VISUAL_INVENTORY_LIMITS.maxTableRows） */
  rowCount: number;
  /** 网格最大列数（无 tabular → 0） */
  columnCount: number;
  lineStart: number;
  lineEnd: number;
  linkedSection?: string;
  /** 环境内是否检测到 tabular 类环境 */
  hasTabular: boolean;
  /** 首行按惯例作为表头（LaTeX 无独立表头语法——诚实约定，投影层有 note 说明） */
  headers?: string[];
  /** 数据行（去表头行；单元格经 cleanCell 同款清洗） */
  rows?: string[][];
}

/** 单个视觉 label 的一个引用位置（重复引用以 count 计入） */
export interface VisualInventoryReferenceSite {
  /** 被引用的 fig:/tab: 前缀 label */
  label: string;
  /** 引用所在文件（输入原样的相对路径） */
  file: string;
  /** 引用所在 1-based 行号 */
  line: number;
  /** 该（label, file, line）位置上的引用次数（同一行多次 \ref 同一 label 计入） */
  count: number;
}

export interface ManuscriptVisualInventory {
  schemaVersion: 1;
  /** 对齐 RevisionStore 的修订编号；调用方给不了就缺省（不伪造 0） */
  manuscriptRevision?: number;
  files: Array<{
    /** 相对 manuscript/ 的 POSIX 路径（输入原样拷贝；无环境文件也保留——覆盖面可见） */
    file: string;
    figures: VisualInventoryFigureEntry[];
    tables: VisualInventoryTableEntry[];
  }>;
  /** \ref{fig:…}/\ref{tab:…} 指向不存在 label 的 key（去重升序；确定性 finding 源） */
  unresolvedRefs: string[];
  /** fig:/tab: 域内每个 label 的正文引用位置（per (label, file, line) 一条） */
  references: VisualInventoryReferenceSite[];
  /** 无 caption（或 caption 不可解析——后者另有 note）的环境确定性 id："<file>#figure-<n>" */
  captionMissing: string[];
  /** 引用 M12.3 生成图目录（figs/generated/）的 includegraphics 路径（去重升序） */
  generatedFiguresUsed: string[];
  /** 截断 / 解析降级说明（确定性；不静默） */
  notes: string[];
}

/** 防御上限（同 revisionBaseline 表格行上限口径） */
export const VISUAL_INVENTORY_LIMITS = {
  maxTableRows: 80,
} as const;

const FIGURE_ENV_PATTERN = /\\begin\{(figure\*?)\}([\s\S]*?)\\end\{\1\}/g;
const TABLE_ENV_PATTERN = /\\begin\{(table\*?)\}([\s\S]*?)\\end\{\1\}/g;
const TABULAR_PATTERN = /\\begin\{tabular[xX*]*\}{[^}]*}([\s\S]*?)\\end\{tabular[xX*]*\}/;
/** \chapter/\section/\subsection（含可选短标题 [..]；星号变体同为标题） */
const HEADING_PATTERN = /\\(chapter|section|subsection)\*?(?:\[[^\]]*\])?\{/g;
const CAPTION_START_PATTERN = /\\caption(?:\[[^\]]*\])?\{/;
const LABEL_PATTERN = /\\label\{([^}]*)\}/;
const INCLUDEGRAPHICS_PATTERN = /\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/;
/** cleveref 的 \Cref/\cref 接受逗号分隔多 key——按其真实语义拆分，防假 unresolved */
const REF_PATTERN = /\\(ref|autoref|Cref|cref)\{([^}]*)\}/g;

const GENERATED_FIGURES_PREFIX = "figs/generated/";

/** caption 提取的三态结果（absent / 解析不动 / 文本）——fail-soft 但可区分归因 */
type CaptionExtraction =
  | { kind: "absent" }
  | { kind: "unparseable" }
  | { kind: "text"; text: string };

/** offset 之前（不含）的换行数 + 1 = 该 offset 字符所在的 1-based 行号 */
function lineOfOffset(text: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < text.length; index += 1) {
    if (text[index] === "\n") {
      line += 1;
    }
  }
  return line;
}

/**
 * 从 text[openBraceIndex] === "{" 起读一层可嵌套的花括号组内容。
 * 转义字符（\{ \} \\）跳过；到文本末尾仍不闭合 → null（fail-soft）。
 */
function readBraceGroup(text: string, openBraceIndex: number): string | null {
  let depth = 0;
  for (let index = openBraceIndex; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === "\\") {
      index += 1; // 跳过被转义的下一字符
      continue;
    }
    if (ch === "{") {
      depth += 1;
    } else if (ch === "}") {
      depth -= 1;
      if (depth === 0) {
        return text.slice(openBraceIndex + 1, index);
      }
    }
  }
  return null;
}

/** 标题 / 题注的展示清洗（cleanCell 同款：去命令、去括号与 $、折叠空白） */
function cleanLatexText(raw: string): string {
  return raw
    .replace(/\\[A-Za-z@]+\*?/g, " ")
    .replace(/[{}$]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

/** 单元格清洗（照抄 revisionBaseline.cleanCell：multicolumn/multirow 展开） */
function cleanCell(raw: string): string {
  return raw
    .replace(/\\(?:multicolumn|multirow)\{[^{}]*\}\{[^{}]*\}\{([^{}]*)\}/g, "$1")
    .replace(/\\[A-Za-z@]+\*?/g, " ")
    .replace(/[${}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function extractLabel(body: string): string | undefined {
  const match = LABEL_PATTERN.exec(body);
  if (match === null) {
    return undefined;
  }
  const label = (match[1] ?? "").trim();
  return label === "" ? undefined : label;
}

function extractCaption(body: string): CaptionExtraction {
  const start = CAPTION_START_PATTERN.exec(body);
  if (start === null) {
    return { kind: "absent" };
  }
  // start[0] 以 "{" 结尾——从该括号做平衡提取
  const braceIndex = start.index + start[0].length - 1;
  const group = readBraceGroup(body, braceIndex);
  if (group === null) {
    return { kind: "unparseable" };
  }
  return { kind: "text", text: cleanLatexText(group) };
}

function extractIncludegraphicsPath(body: string): string | undefined {
  const match = INCLUDEGRAPHICS_PATTERN.exec(body);
  if (match === null) {
    return undefined;
  }
  const raw = (match[1] ?? "").trim();
  if (raw === "") {
    return undefined;
  }
  return raw.replaceAll("\\", "/");
}

function extractPlacement(envWhole: string): string | undefined {
  // \begin{figure}[htbp] —— 紧跟环境名之后的可选参数（锚定串首防误配 body 内 []）
  const match = /^\\begin\{[^}]+\}\[([^\]]*)\]/.exec(envWhole);
  return match === null ? undefined : (match[1] ?? "");
}

interface HeadingSite {
  offset: number;
  title: string;
}

function collectHeadings(text: string): HeadingSite[] {
  const headings: HeadingSite[] = [];
  for (const match of text.matchAll(HEADING_PATTERN)) {
    // match[0] 以 "{" 结尾
    const braceIndex = (match.index ?? 0) + match[0].length - 1;
    const group = readBraceGroup(text, braceIndex);
    if (group === null) {
      continue; // 花括号不闭合 → 该标题不可用（fail-soft，不伪造）
    }
    headings.push({ offset: match.index ?? 0, title: cleanLatexText(group) });
  }
  return headings;
}

function nearestHeadingBefore(headings: HeadingSite[], offset: number): string | undefined {
  let best: HeadingSite | undefined;
  for (const heading of headings) {
    if (heading.offset < offset) {
      best = heading; // headings 按文档序扫描，最后一个 < offset 的即最近前置
    }
  }
  return best?.title;
}

/** revisionBaseline 同款 tabular 网格解析（行拆 \\、列拆 &、空行/单列行跳过） */
function splitTabularRows(
  raw: string,
  file: string,
  envIndex: number,
  notes: string[],
): string[][] {
  const rows: string[][] = [];
  for (const rawRow of raw.split(/\\\\(?!\()\s*(?:\[[^\]]*\])?/)) {
    const cells = rawRow.split("&").map((cell) => cleanCell(cell));
    if (cells.filter((cell) => cell !== "").length === 0 || cells.length < 2) {
      continue;
    }
    if (rows.length >= VISUAL_INVENTORY_LIMITS.maxTableRows) {
      notes.push(`${file} 第 ${envIndex} 个表超过 ${VISUAL_INVENTORY_LIMITS.maxTableRows} 行，inventory 截断`);
      break;
    }
    rows.push(cells);
  }
  return rows;
}

/**
 * 构建 manuscript 视觉环境 inventory（纯函数；同输入同输出，byte 级一致）。
 * 环境定位为保守正则 + 内容偏移算行号；一切解析不动的地方字段缺省（fail-soft）。
 */
export function buildVisualInventory(
  files: readonly VisualInventoryTexFile[],
  opts: BuildVisualInventoryOptions = {},
): ManuscriptVisualInventory {
  const notes: string[] = [];
  const fileEntries: ManuscriptVisualInventory["files"] = [];
  const captionMissing: string[] = [];
  const generatedFiguresUsed = new Set<string>();
  const labelUniverse = new Set<string>();
  // (label, file, line) → 引用计数；Map 保持首次出现顺序（确定性输出）
  const referenceSites = new Map<string, VisualInventoryReferenceSite>();

  // CRLF → LF 入口归一：CRLF 与 LF 输入产出等价 inventory（行号口径一致）
  const normalized = files.map((entry) => ({
    file: entry.file,
    text: entry.content.replace(/\r\n/g, "\n"),
  }));

  // label 全集 = 全部文件的全部 \label（figure/table 环境 ∪ 其它环境；
  // 只有 fig:/tab: 域做 unresolved 判定，普通 eq:/sec: 不多管）
  for (const { text } of normalized) {
    for (const match of text.matchAll(/\\label\{([^}]*)\}/g)) {
      const key = (match[1] ?? "").trim();
      if (key !== "") {
        labelUniverse.add(key);
      }
    }
  }

  for (const { file, text } of normalized) {
    const headings = collectHeadings(text);

    const figures: VisualInventoryFigureEntry[] = [];
    for (const match of text.matchAll(FIGURE_ENV_PATTERN)) {
      const envStart = match.index ?? 0;
      const body = match[2] ?? "";
      const envIndex = figures.length + 1;
      const caption = extractCaption(body);
      if (caption.kind !== "text") {
        captionMissing.push(`${file}#figure-${envIndex}`);
        if (caption.kind === "unparseable") {
          notes.push(`${file} 第 ${envIndex} 个 figure 的 caption 花括号不闭合，未提取`);
        }
      }
      const includegraphicsPath = extractIncludegraphicsPath(body);
      if (includegraphicsPath !== undefined && includegraphicsPath.startsWith(GENERATED_FIGURES_PREFIX)) {
        generatedFiguresUsed.add(includegraphicsPath);
      }
      const label = extractLabel(body);
      const placement = extractPlacement(match[0]);
      const linkedSection = nearestHeadingBefore(headings, envStart);
      figures.push({
        envIndex,
        environment: match[1] === "figure*" ? "figure*" : "figure",
        ...(label !== undefined ? { label } : {}),
        ...(caption.kind === "text" ? { caption: caption.text } : {}),
        ...(includegraphicsPath !== undefined ? { includegraphicsPath } : {}),
        ...(placement !== undefined ? { placement } : {}),
        lineStart: lineOfOffset(text, envStart),
        lineEnd: lineOfOffset(text, envStart + match[0].length),
        ...(linkedSection !== undefined ? { linkedSection } : {}),
      });
    }

    const tables: VisualInventoryTableEntry[] = [];
    for (const match of text.matchAll(TABLE_ENV_PATTERN)) {
      const envStart = match.index ?? 0;
      const body = match[2] ?? "";
      const envIndex = tables.length + 1;
      const caption = extractCaption(body);
      if (caption.kind !== "text") {
        captionMissing.push(`${file}#table-${envIndex}`);
        if (caption.kind === "unparseable") {
          notes.push(`${file} 第 ${envIndex} 个 table 的 caption 花括号不闭合，未提取`);
        }
      }
      const tabularMatch = TABULAR_PATTERN.exec(body);
      const rows =
        tabularMatch === null
          ? []
          : splitTabularRows(tabularMatch[1] ?? "", file, envIndex, notes);
      const columnCount = rows.reduce((max, row) => Math.max(max, row.length), 0);
      const label = extractLabel(body);
      const linkedSection = nearestHeadingBefore(headings, envStart);
      tables.push({
        envIndex,
        environment: match[1] === "table*" ? "table*" : "table",
        ...(label !== undefined ? { label } : {}),
        ...(caption.kind === "text" ? { caption: caption.text } : {}),
        rowCount: rows.length,
        columnCount,
        lineStart: lineOfOffset(text, envStart),
        lineEnd: lineOfOffset(text, envStart + match[0].length),
        ...(linkedSection !== undefined ? { linkedSection } : {}),
        hasTabular: tabularMatch !== null,
        ...(rows.length > 0 ? { headers: rows[0], rows: rows.slice(1) } : {}),
      });
    }

    fileEntries.push({ file, figures, tables });

    // 视觉引用域：\ref/\autoref 单 key；\Cref/\cref 按逗号拆多 key
    for (const match of text.matchAll(REF_PATTERN)) {
      const command = match[1] ?? "ref";
      const rawKeys = match[2] ?? "";
      const line = lineOfOffset(text, match.index ?? 0);
      const keys = command === "Cref" || command === "cref" ? rawKeys.split(",") : [rawKeys];
      for (const rawKey of keys) {
        const key = rawKey.trim();
        if (key === "" || !(key.startsWith("fig:") || key.startsWith("tab:"))) {
          continue;
        }
        const siteKey = `${key}\x00${file}\x00${line}`;
        const existing = referenceSites.get(siteKey);
        if (existing === undefined) {
          referenceSites.set(siteKey, { label: key, file, line, count: 1 });
        } else {
          existing.count += 1;
        }
      }
    }
  }

  const references = [...referenceSites.values()];
  const unresolvedRefs = [
    ...new Set(references.map((site) => site.label).filter((key) => !labelUniverse.has(key))),
  ].sort();

  return {
    schemaVersion: 1,
    ...(opts.manuscriptRevision !== undefined ? { manuscriptRevision: opts.manuscriptRevision } : {}),
    files: fileEntries,
    unresolvedRefs,
    references,
    captionMissing,
    generatedFiguresUsed: [...generatedFiguresUsed].sort(),
    notes,
  };
}

// ---- 持久化（IO 层；research/ 目录由 ProjectStore.create 保证存在）----

const VISUAL_INVENTORY_FILE = "manuscript-visuals.json";

export function visualInventoryPath(projects: ProjectStore, projectId: string): string {
  return join(projects.researchDir(projectId), VISUAL_INVENTORY_FILE);
}

/**
 * 落盘 inventory 到 research/manuscript-visuals.json（writeJsonAtomic）。
 * 薄 helper：不做 revision 循环接线、不做增量合并——重建语义由调用方决定。
 */
export async function persistVisualInventory(
  projects: ProjectStore,
  projectId: string,
  inventory: ManuscriptVisualInventory,
): Promise<void> {
  await writeJsonAtomic(visualInventoryPath(projects, projectId), inventory);
}

/**
 * 读取 inventory：不存在 → null（尚未构建）；损坏 / schema 不兼容 →
 * VISUAL_INVENTORY_CORRUPTED fail-closed（同 corpus-snapshot 口径——derived
 * 产物拒绝降级解读，调用方可提示人工核查或删除重建）。
 */
export async function loadVisualInventory(
  projects: ProjectStore,
  projectId: string,
): Promise<ManuscriptVisualInventory | null> {
  let raw: string;
  try {
    raw = await readFile(visualInventoryPath(projects, projectId), "utf8");
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") {
      return null;
    }
    throw error;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw visualInventoryCorrupted(projectId, "不是合法 JSON");
  }
  const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  if (
    record === null ||
    record["schemaVersion"] !== 1 ||
    !Array.isArray(record["files"]) ||
    !Array.isArray(record["references"]) ||
    !Array.isArray(record["unresolvedRefs"]) ||
    !Array.isArray(record["captionMissing"])
  ) {
    throw visualInventoryCorrupted(projectId, "缺少必需字段或 schemaVersion 不兼容");
  }
  return parsed as ManuscriptVisualInventory;
}

function visualInventoryCorrupted(projectId: string, detail: string): BusinessError {
  return new BusinessError(
    "VISUAL_INVENTORY_CORRUPTED",
    `项目 ${projectId} 的 ${VISUAL_INVENTORY_FILE} 损坏（${detail}）——拒绝降级解读，请人工核查或删除后重建`,
  );
}
