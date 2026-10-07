/**
 * 视觉确定性检查核心（M12 Batch 2 · B3）：纯函数、零 IO、零 LLM。
 *
 * 输入 = VisualArtifactView 投影（三源统一形状）+ 手稿 inventory + 正文
 * prose 单元；输出 = visual 类 ReviewFinding + 每项子检查的执行结果。
 *
 * 纪律（延续 B1/B2 与 revisionBaseline 手法）：
 * - 同输入同输出（确定性、无时间戳注入——now 由调用方传入）；
 * - fail-soft：解析不动的输入一律跳过并记录，绝不伪造；
 * - 「裸数字在别处存在」不是 finding——只有上下文绑定（同行标签 + 同指标
 *   + 数字邻近）才允许数值比对（防假阳性的核心规则，见下方数字一致性）；
 * - 启发式可判但语义不确定的检查（题注-描述匹配）显式标
 *   needs_author_review，绝不冒充确定性结论。
 *
 * 检查项（checkId，全部 deterministic）：
 * - label-ref-resolution：\ref{fig:…}/\ref{tab:…} 指向不存在 label；
 * - duplicate-label：多个视觉环境声明同一 label（编译期歧义）；
 * - missing-caption：figure/table 环境缺 caption（inventory.captionMissing；
 *   仅 latex——PDF 侧 caption 缺失常为 parser 能力边界，不制造噪声 finding）；
 * - unreferenced-artifact：定义了 label 但全文零引用（info；仅当文档存在
 *   至少一个视觉引用时才运行——纯字面引用（"Figure 1"）风格的手稿不误报）；
 * - table-text-numeric：表格数值 ↔ 正文数值一致性（上下文绑定比对，见下）；
 * - caption-reference-mismatch：正文对图表的描述与题注词面不符（启发式，
 *   needs_author_review）。
 */

import { createFinding, type ReviewFinding } from "../review/finding.js";
import type { VisualArtifactView } from "../review/visualArtifactView.js";
import type { ManuscriptVisualInventory } from "../manuscript/visualInventory.js";

// ---- 公共形状（服务层与测试共用） ----

/** 正文 prose 单元（表格 / 数学 / 图表环境已剔除；句子级定位由此派生） */
export interface ProseUnit {
  /** 分组键："tex:<file>"（latex）| "pdf:<sourceId>"（pdf 文本块） */
  sourceKey: string;
  text: string;
  /** latex：相对 manuscript/ 的文件路径（chunkId 定位用） */
  file?: string;
  /** pdf：文本块页码（finding page 用） */
  page?: number;
  /** pdf：来源 sourceId（数值检查分组用；sourceKey 已含） */
  sourceId?: string;
}

/** 单项子检查的执行结果（capability 报告与 UI 的数据源） */
export interface VisualCheckOutcome {
  checkId: string;
  kind: "deterministic" | "vision";
  status: "passed" | "finding" | "skipped" | "failed";
  /** 人读说明（计数 / 跳过原因 / 失败原因） */
  detail?: string;
  visualArtifactIds?: string[];
  findingIds?: string[];
}

export interface DeterministicCheckInput {
  views: ReadonlyArray<VisualArtifactView>;
  inventory: ManuscriptVisualInventory | null;
  prose: ReadonlyArray<ProseUnit>;
  /** ISO 时间戳（createFinding 需要；调用方注入保证确定性测试） */
  now: string;
  /** findingId 前缀（缺省 "vf"） */
  findingIdPrefix?: string;
}

export interface DeterministicCheckResult {
  findings: ReviewFinding[];
  checks: VisualCheckOutcome[];
}

/** 正文句子（含原文定位；sentence.text 已做长度保持的字面引用掩码） */
interface Sentence {
  unit: ProseUnit;
  unitIndex: number;
  text: string;
  start: number;
}

// ---- 数值一致性规则（精确文档；测试逐条锁定） ----
//
// 适用对象：kind=table 且携带 tableGrid 的视图。分组：
//   - latex_env 表 → 组 "manuscript"，prose = 全部 tex 单元（\ref 跨文件，
//     全手稿为一个正文域）；
//   - pdf_parsed 表 → 组 "pdf:<sourceId>"，prose = 该 source 的文本块
//     （textKind=caption 的块剔除，避免题注数字与表自比）。
//   两条组间绝不交叉比较（latex 表不与 pdf 正文比，反之亦然）。
//
// 单元格抽取：行标签 = 每行第一列（归一后 ≥3 字符且含字母/中文才有效）；
// 指标 = 表头列（归一后 ≥2 字符）；可接受值集合 = 单元格内全部数值
// （"62.4 ± 0.3" → {62.4, 0.3}，两者任一匹配即算一致）。
//
// 比对规则（每个「指标出现位置」独立执行）：
//   1. 句子内抽取边界安全数值（千分位感知；紧邻字母的数字如 MOT17 的 17
//      不算独立数值；"Table 3"/"图 2" 字面引用先掩码）；
//   2. 取与该指标词距离最近且 ≤60 字符的一个数值（唯一——同一指标词
//      只比一个数，防 "A is 118 while B is 79" 的错位配对）；
//   3. 增量守卫：数值前文命中 by/±/~ /约/approximately/了/到 或带正负号
//      → 是差值不是取值，跳过；无小数点且 |v| ≤ 12 的整数（行数/场景数等
//      常见小整数）跳过——宁可漏报不误报；
//   4. 行绑定：句子中出现的行标签决定候选单元格集合（句子没提到任何行
//      标签 → 无绑定 → 不比较；这正是「裸数字不是 finding」的实现）；
//   5. 冲突判定：该数值 ∉ 候选单元格可接受值集合的并集（跨表：同一
//      (行, 指标) 出现在多张表时并集消歧——匹配任一张即一致，全不匹配
//      才报冲突，finding 列出各表期望值）。

const NUMBER_DISTANCE_LIMIT = 60;
const SMALL_INT_LIMIT = 12;

/** 数值抽取（边界安全：两侧不得紧邻字母/数字；千分位逗号组感知） */
const NUMBER_PATTERN =
  /(?<![A-Za-z0-9])(-?\d{1,3}(?:,\d{3})+(?:\.\d+)?|-?\d+(?:\.\d+)?)(?![A-Za-z0-9])/g;

interface ExtractedNumber {
  value: number;
  start: number;
  end: number;
  text: string;
}

function extractNumbers(text: string): ExtractedNumber[] {
  const numbers: ExtractedNumber[] = [];
  for (const match of text.matchAll(NUMBER_PATTERN)) {
    const raw = match[0] ?? "";
    const value = Number(raw.replace(/,/g, ""));
    if (Number.isFinite(value)) {
      numbers.push({ value, start: match.index ?? 0, end: (match.index ?? 0) + raw.length, text: raw });
    }
  }
  return numbers;
}

/** 长度保持掩码：字面图表引用（"Table 3"/"Figure 12"/"Fig. 2"/"图 2"/"表 1"）的数字不作数值参与比对 */
const LITERAL_VISUAL_REF_PATTERN =
  /(?:table|figure|fig\.|tab\.|eq\.)\s*~?\s*\d+|(?:表|图|式)\s*~?\s*\d+/gi;

function maskLiteralVisualRefs(sentence: string): string {
  return sentence.replace(LITERAL_VISUAL_REF_PATTERN, (matched) => " ".repeat(matched.length));
}

/** 增量守卫：数值前文（≤12 字符）出现差值语 → 跳过该数值 */
const DELTA_CONTEXT_PATTERN = /(?:by|±|~|approx\.?|approximately|about|了|到|约)\s*[+-]?\s*$/i;

function isDeltaLike(masked: string, number: ExtractedNumber): boolean {
  const before = masked.slice(Math.max(0, number.start - 12), number.start);
  if (DELTA_CONTEXT_PATTERN.test(before)) {
    return true;
  }
  const prev = number.start > 0 ? masked[number.start - 1] : "";
  return prev === "+" || prev === "-";
}

function numericEq(a: number, b: number): boolean {
  return Math.abs(a - b) < 1e-9;
}

/** 归一化标签/指标：小写、非字母数字中文压缩为单空格 */
function normalizeLabel(raw: string): string {
  return raw
    .toLowerCase()
    .replace(/[^a-z0-9一-鿿]+/g, " ")
    .trim();
}

/** 行标签有效性：归一后 ≥3 字符且含字母或中文（纯数字短标签不参与绑定） */
function isUsableRowLabel(normalized: string): boolean {
  return normalized.length >= 3 && /[a-z一-鿿]/.test(normalized);
}

/** 指标有效性：归一后 ≥2 字符 */
function isUsableMetric(normalized: string): boolean {
  return normalized.length >= 2 && /[a-z0-9一-鿿]/.test(normalized);
}

/**
 * 词面匹配 pattern：label 的非字母数字段放宽为「任意非字母数字段」，
 * 使 "w/o memory" 也能命中 "w/o memory"/"w o memory"；首尾加边界
 * （拉丁侧禁止紧邻字母数字；中文侧无边界要求）。
 */
function phrasePattern(normalized: string): RegExp | undefined {
  const segments = normalized.split(" ").filter((segment) => segment !== "");
  if (segments.length === 0) {
    return undefined;
  }
  const body = segments
    .map((segment) => segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("[^a-z0-9\\u4e00-\\u9fff]*");
  // "g" 必需（matchAll）；匹配在原文小写副本上执行，"i" 冗余但无害
  return new RegExp(`(?<![a-z0-9])${body}(?![a-z0-9])`, "gi");
}

/** 指标别名组（提及检测用；只影响召回，不影响冲突判定） */
const METRIC_ALIAS_GROUPS: ReadonlyArray<readonly string[]> = [
  ["ids", "id switch", "id switches", "identity switch", "identity switches", "身份切换", "身份转换"],
  ["frag", "fragmentation", "fragmentations", "碎片"],
  ["fps", "frames per second", "frame rate", "帧率", "每秒帧数"],
  ["latency", "延迟", "时延"],
];

function metricMentionPhrases(normalizedMetric: string): string[] {
  const phrases = [normalizedMetric];
  for (const group of METRIC_ALIAS_GROUPS) {
    if (group.includes(normalizedMetric)) {
      phrases.push(...group.filter((entry) => entry !== normalizedMetric));
    }
  }
  return phrases;
}

/** 全部出现位置（词面 pattern 扫描） */
function phraseOccurrences(lowerSentence: string, pattern: RegExp): Array<{ start: number; end: number }> {
  const occurrences: Array<{ start: number; end: number }> = [];
  for (const match of lowerSentence.matchAll(pattern)) {
    if (match[0] !== "") {
      occurrences.push({ start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
    }
  }
  return occurrences;
}

// ---- 表格单元格模型 ----

interface TableCell {
  view: VisualArtifactView;
  rowLabelRaw: string;
  metricRaw: string;
  acceptedValues: number[];
}

/** 从表格视图抽取可比对单元格（规则见文件头「数值一致性规则」） */
function extractTableCells(view: VisualArtifactView): TableCell[] {
  const grid = view.tableGrid;
  if (grid === undefined || grid.headers.length < 2 || grid.rows.length === 0) {
    return [];
  }
  const cells: TableCell[] = [];
  for (const row of grid.rows) {
    const rowLabelRaw = row[0] ?? "";
    const rowLabel = normalizeLabel(rowLabelRaw);
    if (!isUsableRowLabel(rowLabel)) {
      continue;
    }
    for (let column = 1; column < grid.headers.length && column < row.length; column += 1) {
      const metricRaw = grid.headers[column] ?? "";
      const metric = normalizeLabel(metricRaw);
      if (!isUsableMetric(metric)) {
        continue;
      }
      const acceptedValues = extractNumbers(row[column] ?? "").map((entry) => entry.value);
      if (acceptedValues.length === 0) {
        continue;
      }
      cells.push({ view, rowLabelRaw: rowLabelRaw.trim(), metricRaw: metricRaw.trim(), acceptedValues });
    }
  }
  return cells;
}

/** 表格的人读定位（label 优先，其次 caption 截断，最后 view id） */
function describeTable(view: VisualArtifactView): string {
  if (view.label !== undefined) {
    return view.label;
  }
  if (view.caption !== undefined && view.caption !== "") {
    return view.caption.length > 40 ? `${view.caption.slice(0, 40)}…` : view.caption;
  }
  return view.id;
}

// ---- 句子切分与 prose 预处理 ----

const VISUAL_ENV_STRIP_PATTERN =
  /\\begin\{(?:figure|table)\*?\}[\s\S]*?\\end\{(?:figure|table)\*?\}/g;
const TABULAR_STRIP_PATTERN = /\\begin\{tabular[xX*]*\}{[^}]*}[\s\S]*?\\end\{tabular[xX*]*\}/g;
/**
 * 剔除「路径/导入类」命令（includegraphics 路径可能含独立数字）。
 * 刻意**保留** \ref/\cite/\label——题注-描述检查需要 \ref 原文；其参数内
 * 数字要么字母相邻（被数值边界排除）要么无数字，不参与数值比对。
 */
const COMMAND_STRIP_PATTERN =
  /\\(?:usepackage|documentclass|input|include|includegraphics)\*?(?:\[[^\]]*\])?\{[^{}]*\}/g;

/** LaTeX prose 预处理：剔注释、图表/table 环境、数学、导入命令（保持其余文本） */
export function stripLatexVisualAndMath(content: string): string {
  const withoutComments = content
    .replace(/\r\n/g, "\n")
    .split("\n")
    .map((line) => {
      const index = line.search(/(?<!\\)%/);
      return index === -1 ? line : line.slice(0, index);
    })
    .join("\n");
  return withoutComments
    .replace(VISUAL_ENV_STRIP_PATTERN, " ")
    .replace(TABULAR_STRIP_PATTERN, " ")
    .replace(COMMAND_STRIP_PATTERN, " ")
    .replace(/\\\[[\s\S]*?\\\]/g, " ")
    .replace(/\\\(([\s\S]*?)\\\)/g, " ")
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/(?<!\\)\$[^$\n]+?(?<!\\)\$/g, " ");
}

/** 句子切分（。！？；;换行 与「句点+空白」；保留原文偏移） */
function splitSentences(unit: ProseUnit, unitIndex: number): Sentence[] {
  const text = unit.text;
  const sentences: Sentence[] = [];
  const push = (start: number, end: number): void => {
    const raw = text.slice(start, end);
    if (raw.trim() !== "") {
      sentences.push({ unit, unitIndex, text: raw, start });
    }
  };
  let start = 0;
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index]!;
    const isBreak =
      ch === "。" ||
      ch === "！" ||
      ch === "？" ||
      ch === "；" ||
      ch === ";" ||
      ch === "\n" ||
      (ch === "." && (index + 1 >= text.length || /\s/.test(text[index + 1]!)));
    if (isBreak) {
      push(start, index + 1);
      start = index + 1;
    }
  }
  push(start, text.length);
  return sentences;
}

function lineOfUnitSentence(unit: ProseUnit, sentence: Sentence): number {
  let line = 1;
  for (let index = 0; index < sentence.start && index < unit.text.length; index += 1) {
    if (unit.text[index] === "\n") {
      line += 1;
    }
  }
  return line;
}

/** finding 的正文侧 provenance：latex → chunkId "tex:<file>#L<行>"；pdf → page */
function proseProvenance(sentence: Sentence): { chunkId?: string; page?: number } {
  if (sentence.unit.sourceKey.startsWith("tex:") && sentence.unit.file !== undefined) {
    const line = lineOfUnitSentence(sentence.unit, sentence);
    return { chunkId: `${sentence.unit.sourceKey}#L${line}` };
  }
  if (sentence.unit.page !== undefined) {
    return { page: sentence.unit.page };
  }
  if (sentence.unit.sourceKey.startsWith("pdf:")) {
    return { chunkId: sentence.unit.sourceKey };
  }
  return { chunkId: sentence.unit.sourceKey };
}

// ---- 数值一致性检查 ----

interface NumericConflictFindingInput {
  sentence: Sentence;
  metricRaw: string;
  value: number;
  valueText: string;
  candidates: TableCell[];
}

function buildNumericConflictFinding(
  input: NumericConflictFindingInput,
  now: string,
  prefix: string,
  ordinal: number,
): ReviewFinding {
  const { sentence, metricRaw, valueText, candidates } = input;
  const expected = candidates
    .slice(0, 3)
    .map((cell) => `${describeTable(cell.view)} 行「${cell.rowLabelRaw}」= ${cell.acceptedValues.join(" / ")}`)
    .join("；");
  const excerpt = sentence.text.trim().slice(0, 160);
  const provenance = proseProvenance(sentence);
  const firstCell = candidates[0]!;
  return createFinding({
    findingId: `${prefix}-table-text-numeric-${ordinal}`,
    category: "visual",
    severity: "major",
    message:
      `表格数值与正文不一致：正文写「${metricRaw} ${valueText}」（${excerpt}），` +
      `但 ${expected}。请核对数据来源后统一。`,
    source: "deterministic-visual",
    now,
    figureEnvRef: firstCell.view.id,
    ...(provenance.chunkId !== undefined ? { chunkId: provenance.chunkId } : {}),
    ...(provenance.page !== undefined ? { page: provenance.page } : {}),
    claimText: sentence.text.trim().slice(0, 300),
    visualConfidence: "high",
    verificationStatus: "verified_deterministic",
  });
}

function runNumericConsistency(
  views: ReadonlyArray<VisualArtifactView>,
  prose: ReadonlyArray<ProseUnit>,
  now: string,
  prefix: string,
): { findings: ReviewFinding[]; detail: string } {
  // 分组：latex 表 → "manuscript"；pdf 表 → "pdf:<sourceId>"
  const cellsByGroup = new Map<string, TableCell[]>();
  const tableIdsByGroup = new Map<string, Set<string>>();
  for (const view of views) {
    if (view.kind !== "table" || view.tableGrid === undefined) {
      continue;
    }
    const group =
      view.sourceKind === "pdf_parsed"
        ? view.id.slice(0, view.id.lastIndexOf(":")) // "pdf:<sourceId>"
        : "manuscript";
    const cells = extractTableCells(view);
    if (cells.length === 0) {
      continue;
    }
    cellsByGroup.set(group, [...(cellsByGroup.get(group) ?? []), ...cells]);
    const ids = tableIdsByGroup.get(group) ?? new Set<string>();
    ids.add(view.id);
    tableIdsByGroup.set(group, ids);
  }

  // prose 按组预筛（组内无表格的 prose 不参与）
  const sentences: Array<{ sentence: Sentence; group: string }> = [];
  for (let unitIndex = 0; unitIndex < prose.length; unitIndex += 1) {
    const unit = prose[unitIndex]!;
    const group = unit.sourceKey.startsWith("pdf:") ? unit.sourceKey : "manuscript";
    if (!cellsByGroup.has(group)) {
      continue;
    }
    for (const sentence of splitSentences(unit, unitIndex)) {
      sentences.push({ sentence, group });
    }
  }

  const findings: ReviewFinding[] = [];
  let comparedCount = 0;
  let consistentCount = 0;
  for (const { sentence, group } of sentences) {
    const cells = cellsByGroup.get(group) ?? [];
    if (cells.length === 0) {
      continue;
    }
    const masked = maskLiteralVisualRefs(sentence.text);
    const numbers = extractNumbers(masked);
    if (numbers.length === 0) {
      continue;
    }
    const lower = masked.toLowerCase();

    // 句内出现的行标签 → pattern（一次计算，句内复用）
    const rowPatterns: Array<{ cell: TableCell; pattern: RegExp }> = [];
    const seenRows = new Map<string, RegExp>();
    for (const cell of cells) {
      const normalized = normalizeLabel(cell.rowLabelRaw);
      if (seenRows.has(normalized)) {
        continue;
      }
      const pattern = phrasePattern(normalized);
      if (pattern !== undefined) {
        seenRows.set(normalized, pattern);
      }
    }
    for (const cell of cells) {
      const pattern = seenRows.get(normalizeLabel(cell.rowLabelRaw));
      if (pattern !== undefined && phraseOccurrences(lower, pattern).length > 0) {
        rowPatterns.push({ cell, pattern });
      }
    }
    if (rowPatterns.length === 0) {
      continue; // 无行标签绑定 → 裸数字不比较（假阳性守卫）
    }
    const sentenceRows = rowPatterns.map((entry) => entry.cell.rowLabelRaw);

    // 指标出现位置（去重后的指标集合）
    const metricPatterns = new Map<string, Array<{ metricRaw: string; pattern: RegExp }>>();
    for (const cell of cells) {
      const normalized = normalizeLabel(cell.metricRaw);
      if (metricPatterns.has(normalized)) {
        continue;
      }
      const phrases = metricMentionPhrases(normalized);
      const patterns = phrases
        .map((phrase) => phrasePattern(phrase))
        .filter((pattern): pattern is RegExp => pattern !== undefined);
      if (patterns.length > 0) {
        metricPatterns.set(normalized, patterns.map((pattern) => ({ metricRaw: cell.metricRaw, pattern })));
      }
    }

    for (const [normalizedMetric, patterns] of metricPatterns) {
      // 收集该指标（含别名）的全部出现位置
      const occurrences: Array<{ start: number; end: number; metricRaw: string }> = [];
      for (const { metricRaw, pattern } of patterns) {
        for (const at of phraseOccurrences(lower, pattern)) {
          occurrences.push({ ...at, metricRaw });
        }
      }
      if (occurrences.length === 0) {
        continue;
      }
      // 句内提到该指标的候选单元格（行绑定）
      const candidates = cells.filter(
        (cell) =>
          normalizeLabel(cell.metricRaw) === normalizedMetric &&
          sentenceRows.includes(cell.rowLabelRaw),
      );
      if (candidates.length === 0) {
        continue;
      }
      for (const occurrence of occurrences) {
        // 最近邻数值（唯一）：距离 ≤60 字符
        let nearest: { number: ExtractedNumber; distance: number } | undefined;
        for (const number of numbers) {
          const distance =
            number.start >= occurrence.end
              ? number.start - occurrence.end
              : occurrence.start >= number.end
                ? occurrence.start - number.end
                : 0;
          if (distance > NUMBER_DISTANCE_LIMIT) {
            continue;
          }
          if (nearest === undefined || distance < nearest.distance) {
            nearest = { number, distance };
          }
        }
        if (nearest === undefined) {
          continue;
        }
        if (isDeltaLike(masked, nearest.number)) {
          continue; // 差值/约数 → 非取值，不比较
        }
        if (Number.isInteger(nearest.number.value) && Math.abs(nearest.number.value) <= SMALL_INT_LIMIT) {
          continue; // 常见小整数（行数/场景数等）→ 保守跳过
        }
        comparedCount += 1;
        const accepted = new Set<number>();
        for (const cell of candidates) {
          for (const value of cell.acceptedValues) {
            accepted.add(value);
          }
        }
        const matches = [...accepted].some((value) => numericEq(value, nearest!.number.value));
        if (matches) {
          consistentCount += 1;
        } else {
          findings.push(
            buildNumericConflictFinding(
              {
                sentence,
                metricRaw: occurrence.metricRaw,
                value: nearest.number.value,
                valueText: nearest.number.text,
                candidates,
              },
              now,
              prefix,
              findings.length + 1,
            ),
          );
        }
      }
    }
  }

  const detail =
    cellsByGroup.size === 0
      ? "无比对表格（无 tableGrid 或无数值单元格）"
      : `比对 ${comparedCount} 处上下文绑定的数值引用，${consistentCount} 处一致，${findings.length} 处冲突`;
  return { findings, detail };
}

// ---- 题注-描述匹配（启发式，needs_author_review） ----

const CAPTION_VERB_PATTERN =
  "(?:shows?|reports?|presents?|displays?|summarizes?|illustrates?|gives?|lists?|compares?|details?|给出|展示|报告|列出|总结|对比|比较|说明|描述)";
const LITERAL_REF_DESC_PATTERN = new RegExp(
  `\\b(table|figure|fig\\.)\\s*~?\\s*(\\d+)\\s+${CAPTION_VERB_PATTERN}\\s+([^\\n]{4,180})`,
  "gi",
);
const REF_ATTACHED_DESC_PATTERN = new RegExp(
  `\\b(table|figure)\\s*~?\\\\(?:ref|autoref|Cref|cref)\\{([^}]+)\\}\\s+${CAPTION_VERB_PATTERN}\\s+([^\\n]{4,180})`,
  "gi",
);
const DESCRIPTION_MAX_CHARS = 160;

/** 词面 token：拉丁词（≥3 字符，去停用/泛词）+ 中文字符集 */
const STOPWORDS = new Set([
  "the", "a", "an", "of", "in", "on", "for", "and", "with", "our", "we", "is", "are", "as",
  "to", "by", "from", "that", "this", "its", "at", "over", "into", "per", "all", "each",
]);
const GENERIC_WORDS = new Set([
  "results", "result", "table", "tables", "figure", "figures", "fig", "performance",
  "comparison", "method", "methods", "model", "models", "dataset", "datasets",
  "experiment", "experiments", "experimental", "benchmark", "study", "studies",
  "approach", "system", "systems", "overview", "pipeline", "proposed", "evaluation",
  "analysis", "statistics", "numbers", "values", "scores", "score", "metrics",
]);

function contentTokens(text: string): Set<string> {
  const tokens = new Set<string>();
  for (const match of text.toLowerCase().matchAll(/[a-z][a-z0-9-]{2,}/g)) {
    const word = match[0] ?? "";
    if (!STOPWORDS.has(word) && !GENERIC_WORDS.has(word)) {
      tokens.add(word);
    }
  }
  for (const match of text.matchAll(/[一-鿿]/g)) {
    tokens.add(match[0] ?? "");
  }
  return tokens;
}

function runCaptionReferenceMismatch(
  views: ReadonlyArray<VisualArtifactView>,
  prose: ReadonlyArray<ProseUnit>,
  now: string,
  prefix: string,
): { findings: ReviewFinding[]; detail: string } {
  // 编号：latex 表/图各按 inventory 文件序独立编号（LaTeX 源序即编号序）
  const numberedTables: VisualArtifactView[] = [];
  const numberedFigures: VisualArtifactView[] = [];
  const viewsByLabel = new Map<string, VisualArtifactView>();
  for (const view of views) {
    if (view.label !== undefined) {
      viewsByLabel.set(view.label, view);
    }
    if (view.sourceKind === "latex_env") {
      if (view.kind === "table") {
        numberedTables.push(view);
      } else if (view.kind === "figure") {
        numberedFigures.push(view);
      }
    }
  }

  const findings: ReviewFinding[] = [];
  let checked = 0;
  for (let unitIndex = 0; unitIndex < prose.length; unitIndex += 1) {
    const unit = prose[unitIndex]!;
    // 该检查只对 latex 正文运行（pdf 文本块的图表编号语义不可靠）
    if (!unit.sourceKey.startsWith("tex:")) {
      continue;
    }
    for (const sentence of splitSentences(unit, unitIndex)) {
      if (!/(?:table|figure|fig\.)/i.test(sentence.text)) {
        continue;
      }
      const targets: Array<{ view: VisualArtifactView; mention: string; description: string }> = [];
      for (const match of sentence.text.matchAll(REF_ATTACHED_DESC_PATTERN)) {
        const keyword = match[1] ?? "table";
        const label = (match[2] ?? "").trim();
        const description = (match[3] ?? "").trim();
        const view = viewsByLabel.get(label);
        if (view !== undefined && view.caption !== undefined) {
          targets.push({ view, mention: `${/^fig/i.test(keyword) ? "Figure" : "Table"} \\ref{${label}}`, description });
        }
      }
      for (const match of sentence.text.matchAll(LITERAL_REF_DESC_PATTERN)) {
        const keyword = match[1] ?? "table";
        const ordinal = Number(match[2] ?? "0");
        const description = (match[3] ?? "").trim();
        const isFigure = /^fig/i.test(keyword);
        const pool = isFigure ? numberedFigures : numberedTables;
        const view = ordinal >= 1 ? pool[ordinal - 1] : undefined;
        if (view !== undefined && view.caption !== undefined) {
          targets.push({ view, mention: `${isFigure ? "Figure" : "Table"} ${ordinal}`, description });
        }
      }
      for (const target of targets) {
        checked += 1;
        const descTokens = contentTokens(target.description);
        const captionTokens = contentTokens(target.view.caption ?? "");
        if (descTokens.size === 0 || captionTokens.size === 0) {
          continue; // 描述/题注无可比内容词 → 不可靠，不判（fail-soft）
        }
        let overlap = false;
        for (const token of descTokens) {
          if (captionTokens.has(token)) {
            overlap = true;
            break;
          }
        }
        if (overlap) {
          continue;
        }
        const provenance = proseProvenance(sentence);
        findings.push(
          createFinding({
            findingId: `${prefix}-caption-ref-mismatch-${findings.length + 1}`,
            category: "visual",
            severity: "minor",
            message:
              `正文对图表的描述与题注可能不符：正文称 ${target.mention} ` +
              `「${target.description.slice(0, DESCRIPTION_MAX_CHARS)}」，但其题注为` +
              `「${(target.view.caption ?? "").slice(0, DESCRIPTION_MAX_CHARS)}」。` +
              `（词面启发式比对，请作者复核）`,
            source: "deterministic-visual",
            now,
            figureEnvRef: target.view.id,
            ...(provenance.chunkId !== undefined ? { chunkId: provenance.chunkId } : {}),
            ...(provenance.page !== undefined ? { page: provenance.page } : {}),
            claimText: sentence.text.trim().slice(0, 300),
            visualConfidence: "medium",
            verificationStatus: "needs_author_review",
          }),
        );
      }
    }
  }
  const detail = `检查 ${checked} 处带描述的图表提及，${findings.length} 处词面不符（启发式，待作者复核）`;
  return { findings, detail };
}

// ---- 主入口 ----

/**
 * 运行全部确定性视觉检查（纯函数）。任何输入缺失（inventory 为 null、
 * prose 为空）都表现为对应检查 skipped（带原因），绝不抛异常。
 */
export function runDeterministicVisualChecks(input: DeterministicCheckInput): DeterministicCheckResult {
  const prefix = input.findingIdPrefix ?? "vf";
  const now = input.now;
  const views = input.views;
  const inventory = input.inventory;
  const prose = input.prose;
  const findings: ReviewFinding[] = [];
  const checks: VisualCheckOutcome[] = [];

  // 1. label-ref-resolution（需要 inventory；pdf 侧无 \ref 语义）
  {
    const unresolved = inventory?.unresolvedRefs ?? [];
    if (inventory === null) {
      checks.push({
        checkId: "label-ref-resolution",
        kind: "deterministic",
        status: "skipped",
        detail: "无手稿 inventory（manuscript 缺失或未提供）",
      });
    } else {
      for (const label of unresolved) {
        const site = (inventory.references ?? []).find((ref) => ref.label === label);
        findings.push(
          createFinding({
            findingId: `${prefix}-unresolved-ref-${findings.length + 1}`,
            category: "visual",
            severity: "major",
            message:
              `视觉引用 \\ref{${label}} 指向不存在的 label（编译期将成为 "??",读者无法定位）` +
              `${site !== undefined ? `；首次引用位于 ${site.file} 第 ${site.line} 行` : ""}。`,
            source: "deterministic-visual",
            now,
            ...(site !== undefined ? { chunkId: `tex:${site.file}#L${site.line}` } : {}),
            claimText: label,
            visualConfidence: "high",
            verificationStatus: "verified_deterministic",
          }),
        );
      }
      checks.push({
        checkId: "label-ref-resolution",
        kind: "deterministic",
        status: unresolved.length > 0 ? "finding" : "passed",
        ...(unresolved.length > 0 ? { findingIds: findings.map((f) => f.findingId).slice(-unresolved.length) } : {}),
        detail:
          unresolved.length > 0
            ? `${unresolved.length} 个未解析视觉引用：${unresolved.join("、")}`
            : `全部 ${inventory.references?.length ?? 0} 个视觉引用均可解析`,
      });
    }
  }

  // 2. duplicate-label（视图 label 重复；latex + generated）
  {
    const labelCounts = new Map<string, VisualArtifactView[]>();
    for (const view of views) {
      if (view.label === undefined) {
        continue;
      }
      labelCounts.set(view.label, [...(labelCounts.get(view.label) ?? []), view]);
    }
    const duplicates = [...labelCounts.entries()].filter(([, list]) => list.length > 1);
    const before = findings.length;
    for (const [label, list] of duplicates) {
      findings.push(
        createFinding({
          findingId: `${prefix}-duplicate-label-${findings.length + 1}`,
          category: "visual",
          severity: "major",
          message:
            `label "${label}" 被 ${list.length} 个视觉环境重复声明（${list.map((view) => view.id).join("、")}）：` +
            `LaTeX 交叉引用将指向最后编译的环境，正文 \ref 语义歧义。`,
          source: "deterministic-visual",
          now,
          figureEnvRef: list[0]!.id,
          claimText: label,
          visualConfidence: "high",
          verificationStatus: "verified_deterministic",
        }),
      );
    }
    checks.push({
      checkId: "duplicate-label",
      kind: "deterministic",
      status: duplicates.length > 0 ? "finding" : "passed",
      ...(duplicates.length > 0
        ? { findingIds: findings.slice(before).map((f) => f.findingId), visualArtifactIds: duplicates.flatMap(([, list]) => list.map((view) => view.id)) }
        : {}),
      detail: duplicates.length > 0 ? `${duplicates.length} 个重复 label` : `无重复视觉 label（共 ${labelCounts.size} 个）`,
    });
  }

  // 3. missing-caption（inventory.captionMissing；仅 latex）
  {
    const missing = inventory?.captionMissing ?? [];
    const byId = new Map(views.map((view) => [view.id, view]));
    const before = findings.length;
    const artifactIds: string[] = [];
    for (const entry of missing) {
      // inventory id "<file>#figure-<n>" ↔ view id "tex:<file>:figure-<n>"
      const viewId = `tex:${entry.replaceAll("#", ":")}`;
      const view = byId.get(viewId);
      if (view !== undefined) {
        artifactIds.push(viewId);
      }
      findings.push(
        createFinding({
          findingId: `${prefix}-missing-caption-${findings.length + 1}`,
          category: "visual",
          severity: "minor",
          message:
            `视觉环境缺 caption（${entry}）：读者与审稿人无法仅凭编号理解图表内容；` +
            `LaTeX 惯例要求每个 figure/table 环境携带 \\caption。`,
          source: "deterministic-visual",
          now,
          figureEnvRef: viewId,
          visualConfidence: "high",
          verificationStatus: "verified_deterministic",
        }),
      );
    }
    checks.push({
      checkId: "missing-caption",
      kind: "deterministic",
      status: missing.length > 0 ? "finding" : "passed",
      ...(missing.length > 0 ? { findingIds: findings.slice(before).map((f) => f.findingId), visualArtifactIds: artifactIds } : {}),
      detail:
        missing.length > 0
          ? `${missing.length} 个环境缺 caption：${missing.join("、")}`
          : "全部视觉环境均有 caption",
    });
  }

  // 4. unreferenced-artifact（info；仅当文档存在视觉引用时运行——防字面引用风格手稿误报）
  {
    const referenceCount = inventory?.references?.length ?? 0;
    if (inventory === null || referenceCount === 0) {
      checks.push({
        checkId: "unreferenced-artifact",
        kind: "deterministic",
        status: "skipped",
        detail: inventory === null ? "无手稿 inventory" : "全文无 \\ref 类视觉引用（可能采用字面编号引用风格），不判定未引用",
      });
    } else {
      const before = findings.length;
      const artifactIds: string[] = [];
      for (const view of views) {
        if (view.label === undefined || view.referencedBy.length > 0) {
          continue;
        }
        artifactIds.push(view.id);
        findings.push(
          createFinding({
            findingId: `${prefix}-unreferenced-${findings.length + 1}`,
            category: "visual",
            severity: "info",
            message:
              `视觉环境 ${view.id}${view.label !== undefined ? `（label ${view.label}）` : ""} 在全文中未被 \\ref 引用：` +
              `未被引用的图表通常意味着正文论述与图表脱节，或应删除该图表。`,
            source: "deterministic-visual",
            now,
            figureEnvRef: view.id,
            claimText: view.label,
            visualConfidence: "high",
            verificationStatus: "verified_deterministic",
          }),
        );
      }
      checks.push({
        checkId: "unreferenced-artifact",
        kind: "deterministic",
        status: artifactIds.length > 0 ? "finding" : "passed",
        ...(artifactIds.length > 0 ? { findingIds: findings.slice(before).map((f) => f.findingId), visualArtifactIds: artifactIds } : {}),
        detail: artifactIds.length > 0 ? `${artifactIds.length} 个带 label 环境未被引用` : "全部带 label 环境均被引用",
      });
    }
  }

  // 5. table-text-numeric（上下文绑定比对；规则见文件头）
  {
    const numeric = runNumericConsistency(views, prose, now, prefix);
    findings.push(...numeric.findings);
    checks.push({
      checkId: "table-text-numeric",
      kind: "deterministic",
      status: numeric.findings.length > 0 ? "finding" : "passed",
      ...(numeric.findings.length > 0 ? { findingIds: numeric.findings.map((f) => f.findingId) } : {}),
      detail: numeric.detail,
    });
  }

  // 6. caption-reference-mismatch（启发式；needs_author_review）
  {
    const captionMismatch = runCaptionReferenceMismatch(views, prose, now, prefix);
    findings.push(...captionMismatch.findings);
    checks.push({
      checkId: "caption-reference-mismatch",
      kind: "deterministic",
      status: captionMismatch.findings.length > 0 ? "finding" : "passed",
      ...(captionMismatch.findings.length > 0
        ? { findingIds: captionMismatch.findings.map((f) => f.findingId) }
        : {}),
      detail: captionMismatch.detail,
    });
  }

  return { findings, checks };
}
