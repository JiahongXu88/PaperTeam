/**
 * M14.9.5.1 Review Context Snapshot：长文档单元审稿的显式、冻结、可指纹化输入（纯函数）。
 *
 * 背景（D:\PaperTeamData\M14_9_5_1_ReviewerContextConsistency\baseline.json）：缺省同一项目的全部单元共用
 * review/academic/unit 会话，单元能看到哪些其他单元的表格取决于调度顺序与超时后会话是否重建——P008 2.2 单元
 * 引用的表2 在「2 结果」单元里，会话延续时检出、超时重建后漏检。这里把「本单元需要的其他单元材料」确定性地
 * 解析为依赖集合，与单元原文一起冻结进 prompt：
 *   1. 依赖定位按精确度递减：\label 经 \ref/\autoref/\cref/\eqref… 引用 → 题注 / 标题中的显式编号（表 / Table /
 *      图 / Figure；公式只认 \tag）→ 全篇浮动体都没有显式编号时才用 LaTeX 计数器顺序（文中有 \chapter /
 *      \appendix / \setcounter / \numberwithin 时不推断）。唯一候选才附上；多个候选 = DEPENDENCY_AMBIGUOUS，
 *      找不到 = DEPENDENCY_UNRESOLVED，绝不猜。
 *   2. 表格块保留题注、表头、全部单元格与紧随的英文题注 / 注释段，带来源单元、sha256 与来源核验等级
 *      （PDF 转写投影未经人工核验 = SOURCE_UNVERIFIED，不冒充原始事实）。
 *   3. 预算：主单元原文从不截断；依赖整块附上或整块不附（CONTEXT_OVERFLOW，绝不截断表格）。\label 引用优先于
 *      文本编号引用，按首次出现顺序。
 *   4. 依赖只是只读参考：不计入覆盖率字符，不作为本单元的独立审稿对象。
 *   5. 审稿政策自身引用的材料也是依赖：已发表论文只读口径的 blocking 以「摘要所述核心结论」为准，隔离单元因此
 *      附上摘要段（RubricAnchor，独立上限；找不到 / 超限时 blocking 判断记 NOT_EVALUATED）。
 */
import { createHash } from "node:crypto";

export type ReviewUnitContextPolicy = "shared_session" | "isolated_no_dependencies" | "isolated_snapshot";
export const REVIEW_UNIT_CONTEXT_POLICIES: readonly ReviewUnitContextPolicy[] = ["shared_session", "isolated_no_dependencies", "isolated_snapshot"];
export const REVIEW_CONTEXT_SNAPSHOT_SCHEMA = "paperteam.review-context-snapshot/v2";
export const DEFAULT_UNIT_DEPENDENCY_BUDGET_CHARS = 12_000;

export type DependencyKind = "table" | "figure" | "equation";
/** 附上的依赖类型：浮动体 / 公式，或审稿政策本身引用的「论文摘要」锚点 */
export type AttachedKind = DependencyKind | "abstract";
/**
 * 依赖原文的来源核验等级（文档级）：作者 LaTeX 源稿 / 有哈希绑定人工 QA 的转写投影 / 有保真报告但未经人工 QA 的
 * 转写投影 / 第三方输入且没有保真报告（M14.9.5.2：来源未记录，不断言是 PDF 转写投影）
 */
export type SourceVerification = "AUTHOR_SOURCE" | "SOURCE_ATTESTED" | "SOURCE_UNVERIFIED" | "SOURCE_UNKNOWN";
export type DependencyResolution = "label" | "caption_number" | "latex_counter" | "tag" | "rubric_anchor";
export type DependencyGapStatus = "DEPENDENCY_UNRESOLVED" | "DEPENDENCY_AMBIGUOUS" | "CONTEXT_OVERFLOW" | "NOT_ATTACHED_BY_POLICY";

export interface DependencyTarget {
  targetId: string;
  kind: DependencyKind;
  unitId: string;
  file: string;
  heading: string;
  /** 显式编号（题注 / 标题 / \tag）或计数器推断编号；多个不同值 = 编号冲突（不按编号索引） */
  numbers: string[];
  numberSource: "caption_text" | "latex_counter" | "tag" | "none";
  labels: string[];
  text: string;
  sha256: string;
  /** M14.9.5.2：跨页续表 / 续图（与同号主表合为一个依赖对象，见 resolveUnitDependencies） */
  continued?: true;
}

export interface DependencyIndex {
  targets: DependencyTarget[];
  /** \label → 全文所有定义处（含章节等非浮动体标签：unitId 列表） */
  labelDefinitions: Map<string, string[]>;
  counterNumbering: { table: boolean; figure: boolean };
}

export interface AttachedDependency {
  refId: string;
  kind: AttachedKind;
  targetId: string;
  sourceUnitId: string;
  sourceFile: string;
  sourceHeading: string;
  via: DependencyResolution;
  mentions: string[];
  numbers: string[];
  labels: string[];
  sha256: string;
  chars: number;
  /** M14.9.5.2：由主表与跨页续表合成的依赖（各部分 targetId，文档顺序）；缺省 = 单一对象 */
  parts?: string[];
}

export interface DependencyGap {
  kind: DependencyKind | "label" | "abstract";
  mention: string;
  status: DependencyGapStatus;
  reason: string;
  candidates?: string[];
  /**
   * 该依赖对应的核对在本单元未执行（如实呈现，不伪装已审）：跨单元引述核对，或（摘要锚点缺失时）
   * 三轴口径中以摘要核心结论为准的 blocking 判断
   */
  check: "CROSS_REFERENCE_CONSISTENCY" | "BLOCKING_DETERMINATION";
  checkStatus: "NOT_EVALUATED";
}

/**
 * M14.9.5.1：审稿政策自身引用的「论文摘要」锚点。已发表论文只读口径把 blocking 定义为「澄清之前不应把论文
 * 摘要所述的某个核心结论当作可靠发现引用」——隔离单元看不到摘要就无从判断（共享会话里摘要只是碰巧留在历史中）。
 * 只取摘要段本身（\begin{abstract} 或以「摘要 / Abstract」起首的段落，文档中第一个含摘要的单元），不附引言等其余前置内容。
 */
export interface RubricAnchor {
  found: true;
  unitId: string;
  file: string;
  heading: string;
  text: string;
  sha256: string;
}
export type RubricAnchorResult = RubricAnchor | { found: false; status: "DEPENDENCY_UNRESOLVED" | "CONTEXT_OVERFLOW"; reason: string };
export const ABSTRACT_ANCHOR_MAX_CHARS = 4_000;

const ABSTRACT_PARAGRAPH = /^\s*(?:\\noindent\s*)?(?:\\(?:textbf|textit|emph)\s*\{\s*)?(?:摘\s*要|Abstract|ABSTRACT)\s*\}?\s*[：:]/;

export function locateAbstractAnchor(units: ReadonlyArray<{ unitId: string; file: string; heading: string; text: string }>, maxChars = ABSTRACT_ANCHOR_MAX_CHARS): RubricAnchorResult {
  for (const unit of units) {
    const envs = [...unit.text.matchAll(/\\begin\{abstract\}[\s\S]*?\\end\{abstract\}/g)].map((match) => match[0]);
    const blocks = envs.length > 0 ? envs : paragraphs(unit.text).map((paragraph) => paragraph.text).filter((text) => ABSTRACT_PARAGRAPH.test(text));
    if (blocks.length === 0) continue;
    const joined = blocks.join("\n\n");
    const text = joined.length <= maxChars ? joined : blocks[0]!.length <= maxChars ? blocks[0]! : null;
    if (text === null) {
      return { found: false, status: "CONTEXT_OVERFLOW", reason: `摘要 ${blocks[0]!.length} 字超出摘要锚点上限 ${maxChars} 字（不截断）` };
    }
    return { found: true, unitId: unit.unitId, file: unit.file, heading: unit.heading, text, sha256: sha256Hex(text) };
  }
  return { found: false, status: "DEPENDENCY_UNRESOLVED", reason: "全文没有 \\begin{abstract} 或以「摘要 / Abstract」起首的段落" };
}

export interface UnitDependencyResolution {
  attached: Array<AttachedDependency & { text: string }>;
  gaps: DependencyGap[];
  /** 本单元自身包含的被引对象（无需附上） */
  inUnit: string[];
  /** 指向章节等非依赖对象的 \ref（导航，不附正文） */
  navigational: string[];
  dependencyChars: number;
}

/** 写入 unit journal / trace 的快照元数据（不含依赖原文；原文由 sha256 绑定） */
export interface ReviewContextSnapshotRecord {
  schema: typeof REVIEW_CONTEXT_SNAPSHOT_SCHEMA;
  policy: ReviewUnitContextPolicy;
  unitId: string;
  unitSha256: string;
  unitChars: number;
  sourceVerification: SourceVerification;
  dependencyBudgetChars: number;
  dependencyChars: number;
  dependencies: AttachedDependency[];
  gaps: DependencyGap[];
  inUnitReferences: string[];
  navigationalReferences: string[];
  /** 依赖集合指纹（附上的目标 id + 原文哈希 + 缺口）：被引表改动 → 变化 → 引用它的单元缓存失效 */
  dependencyFingerprint: string;
  contextComplete: boolean;
  /** 实际送模型的规范化 prompt 的 sha256（ReviewerService 填写） */
  promptSha256?: string;
  /** schema + policy + prompt + 依赖指纹 + 模型 / Skill 的 sha256（ReviewerService 填写） */
  contextSnapshotHash?: string;
  /** 模型 finding 的 quote 只出现在依赖参考而不在本单元原文中的 issue 下标（只标注，不删除） */
  referenceOnlyQuoteIssueIndices?: number[];
}

export function sha256Hex(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

const DASHES = /[‐‑‒–—－]/g;
const NUMBER_PATTERN = String.raw`(\d+(?:\s*[.\-‐‑‒–—－]\s*\d+)?)`;
function normalizeNumber(raw: string): string {
  return raw.replace(DASHES, "-").replace(/\s+/g, "");
}

const KIND_WORDS: Record<Exclude<DependencyKind, "equation">, string> = {
  table: String.raw`(?:表|Tables?|Tab\.)`,
  figure: String.raw`(?:图|Figures?|Fig\.)`,
};
/** 中文对象词前允许出现的汉字（「见表 2」「如图 3」「与表 1」）；其余汉字（「代表 2」「试图 3」）不算引用 */
const CJK_PREFIX_ALLOW = "见如由据和与及在从按照比对自同至、及并或";
const CJK = /[\u3400-\u9fff]/;

function plainMentions(text: string, kind: Exclude<DependencyKind, "equation">): Array<{ number: string; mention: string; index: number }> {
  const out: Array<{ number: string; mention: string; index: number }> = [];
  const pattern = new RegExp(`${KIND_WORDS[kind]}\\s*~?\\s*${NUMBER_PATTERN}(?![\\d])`, "g");
  for (const match of text.matchAll(pattern)) {
    const index = match.index!;
    const head = match[0];
    const before = text.slice(Math.max(0, index - 1), index);
    if (/^[表图]/.test(head) && CJK.test(before) && !CJK_PREFIX_ALLOW.includes(before)) continue;
    if (/^[A-Za-z]/.test(head) && /[A-Za-z]/.test(before)) continue;
    // 「表 2.」句末句点不属于编号；「表 2.1」才是带节号的编号
    const number = normalizeNumber(match[1]!);
    out.push({ number, mention: head.replace(/\s+/g, " ").trim(), index });
  }
  return out;
}

function equationMentions(text: string): Array<{ number: string; mention: string; index: number }> {
  const out: Array<{ number: string; mention: string; index: number }> = [];
  const pattern = /(?:公式|式|Eqs?\.|Equations?)\s*~?\s*[（(]\s*(\d+(?:[.\-]\d+)?)\s*[)）]/g;
  for (const match of text.matchAll(pattern)) {
    const before = text.slice(Math.max(0, match.index! - 1), match.index!);
    if (match[0].startsWith("式") && CJK.test(before) && !CJK_PREFIX_ALLOW.includes(before) && before !== "公") continue;
    out.push({ number: normalizeNumber(match[1]!), mention: match[0].replace(/\s+/g, " ").trim(), index: match.index! });
  }
  return out;
}

/** 平衡花括号读取 \cmd{...} 的参数（从 openIndex 处的 "{" 开始） */
function readBraced(text: string, openIndex: number): string | null {
  if (text[openIndex] !== "{") return null;
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    const ch = text[i];
    if (ch === "\\") { i += 1; continue; }
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) return text.slice(openIndex + 1, i);
    }
  }
  return null;
}

function captionsOf(block: string): Array<{ text: string; numbered: boolean }> {
  const out: Array<{ text: string; numbered: boolean }> = [];
  for (const match of block.matchAll(/\\caption(\*)?(?:\[[^\]]*\])?\s*(?=\{)/g)) {
    const text = readBraced(block, match.index! + match[0].length);
    if (text !== null) out.push({ text, numbered: match[1] !== "*" });
  }
  return out;
}

function labelsOf(text: string): string[] {
  return [...text.matchAll(/\\label\{([^{}]+)\}/g)].map((match) => match[1]!.trim());
}

/** 题注 / 标题行开头的显式编号（「表 2 …」「Table 2 …」「\textbf{表 2 …}」；M14.9.5.2：「续表 2」同样给出编号 2） */
function leadingNumber(text: string, kind: Exclude<DependencyKind, "equation">): string | null {
  const stripped = text.replace(/^\s*(?:\\noindent\s*)?(?:\\(?:textbf|textit|emph|bfseries)\s*\{?\s*)?/, "").replace(/^续\s*(?=[表图])/, "");
  const match = new RegExp(`^${KIND_WORDS[kind]}\\s*~?\\s*${NUMBER_PATTERN}(?![\\d])`).exec(stripped);
  return match === null ? null : normalizeNumber(match[1]!);
}

/**
 * M14.9.5.2：跨页续表 / 续图的标题（「续表 2」「Table 2 (continued)」「Table 2 (cont.)」）。续表不是一张新表：
 * 旧口径不认「续表」标题，导致全篇标题约定被打乱、下一张表的编号被续表吞掉，或把「表 2」只附上半张。
 */
function isContinuationTitle(text: string, kind: Exclude<DependencyKind, "equation">): boolean {
  const stripped = text.replace(/^\s*(?:\\noindent\s*)?(?:\\(?:textbf|textit|emph|bfseries)\s*\{?\s*)?/, "");
  if (new RegExp(`^续\\s*${kind === "table" ? "表" : "图"}`).test(stripped)) return true;
  return new RegExp(`^${KIND_WORDS[kind]}\\s*~?\\s*${NUMBER_PATTERN}\\s*[.:：]?\\s*[(（\\[]\\s*(?:continued|cont\\.?|续)\\s*[)）\\]]`, "i").test(stripped);
}

interface Paragraph { start: number; end: number; text: string }
function paragraphs(text: string): Paragraph[] {
  const out: Paragraph[] = [];
  const re = /\n[ \t]*\n/g;
  let start = 0;
  for (const match of text.matchAll(re)) {
    out.push({ start, end: match.index!, text: text.slice(start, match.index!) });
    start = match.index! + match[0].length;
  }
  out.push({ start, end: text.length, text: text.slice(start) });
  return out.filter((paragraph) => paragraph.text.trim() !== "");
}

const NOTE_PARAGRAPH = /^\s*(?:\\(?:textbf|textit|emph)\s*\{\s*)?(?:注|Notes?|资料来源|来源|Sources?|Data source)\s*[：:]/i;
const FLOAT_ENV: Record<Exclude<DependencyKind, "equation">, RegExp> = {
  table: /\\begin\{(table\*?|sidewaystable\*?|longtable)\}[\s\S]*?\\end\{\1\}/g,
  figure: /\\begin\{(figure\*?|sidewaysfigure\*?)\}[\s\S]*?\\end\{\1\}/g,
};
const EQUATION_ENV = /\\begin\{(equation\*?|align\*?|gather\*?|multline\*?|eqnarray\*?)\}[\s\S]*?\\end\{\1\}/g;

interface TitleParagraph { start: number; end: number; number: string | null; continued?: boolean }
interface RawBlock {
  kind: DependencyKind;
  start: number;
  end: number;
  numbers: string[];
  numberedCaption: boolean;
  labels: string[];
  /** 浮动体环境自身的范围（不含标题 / 注释段） */
  coreStart?: number;
  coreEnd?: number;
  /** \caption 中的显式编号（作者 LaTeX；优先于环境外的标题段） */
  captionNumbers?: string[];
  /** 紧邻其前（只隔空行）的「表 N …」标题段 */
  prevTitle?: TitleParagraph;
  /** 紧随其后的连续标题 / 注释段链（遇到正文段或下一个浮动体即止） */
  trailing?: TitleParagraph[];
  /** M14.9.5.2：跨页续表 / 续图（「续表 N」「Table N (continued)」、\ContinuedFloat）：与同号主表合为一个依赖对象 */
  continued?: boolean;
  /** 环境内有 \ContinuedFloat（LaTeX 计数器不递增） */
  continuedFloat?: boolean;
  /** \caption 文字标明续表（「(continued)」/「续」） */
  captionContinued?: boolean;
}

function floatBlocks(text: string, kind: Exclude<DependencyKind, "equation">): RawBlock[] {
  const ranges: Array<{ start: number; end: number }> = [...text.matchAll(FLOAT_ENV[kind])].map((match) => ({ start: match.index!, end: match.index! + match[0].length }));
  if (kind === "table") {
    // 转写器常输出不带 table 环境的裸 tabular
    for (const match of text.matchAll(/\\begin\{tabular\*?\}[\s\S]*?\\end\{tabular\*?\}/g)) {
      const start = match.index!;
      if (!ranges.some((range) => start >= range.start && start < range.end)) ranges.push({ start, end: start + match[0].length });
    }
    ranges.sort((a, b) => a.start - b.start);
  }
  const paras = paragraphs(text);
  return ranges.map((range) => {
    const block = text.slice(range.start, range.end);
    const captions = captionsOf(block);
    const captionNumbers = [...new Set(captions.map((caption) => leadingNumber(caption.text, kind)).filter((number): number is string => number !== null))];
    const previous = [...paras].reverse().find((paragraph) => paragraph.end <= range.start);
    let prevTitle: TitleParagraph | undefined;
    if (previous !== undefined && text.slice(previous.end, range.start).trim() === "") {
      const number = leadingNumber(previous.text, kind);
      if (number !== null) prevTitle = { start: previous.start, end: previous.end, number, ...(isContinuationTitle(previous.text, kind) ? { continued: true } : {}) };
    }
    const trailing: TitleParagraph[] = [];
    let cursor = range.end;
    for (let taken = 0; taken < 6; taken += 1) {
      const next = paras.find((paragraph) => paragraph.start >= cursor);
      if (next === undefined || text.slice(cursor, next.start).trim() !== "") break;
      const number = leadingNumber(next.text, kind);
      if (number === null && !NOTE_PARAGRAPH.test(next.text)) break;
      trailing.push({ start: next.start, end: next.end, number, ...(number !== null && isContinuationTitle(next.text, kind) ? { continued: true } : {}) });
      cursor = next.end;
    }
    return {
      kind, start: range.start, end: range.end, numbers: [], numberedCaption: captions.some((caption) => caption.numbered),
      labels: labelsOf(block), coreStart: range.start, coreEnd: range.end, captionNumbers, ...(prevTitle !== undefined ? { prevTitle } : {}), trailing,
      ...(/\\ContinuedFloat\b/.test(block) ? { continuedFloat: true } : {}),
      ...(captions.some((caption) => /[(（]\s*(?:continued|cont\.?|续)\s*[)）]|^\s*续/i.test(caption.text)) ? { captionContinued: true } : {}),
    };
  });
}

/**
 * 标题在表上方还是下方，转写稿里只能从全篇判断：一个标题段夹在两张表之间时，局部结构无法证明它属于哪一张。
 * 规则（按类型、全文统一）：\caption 有显式编号的块用自身题注；其余块里，若「上方标题」对全部块都存在而「下方
 * 标题」不全，用上方；反之用下方；两者都齐全且逐块一致，用之；都齐全但不一致或都不齐全 → 该块编号取两侧并集
 * （多个不同编号 = 冲突，不按编号索引——fail closed）。块的原文范围 = 选中的标题 + 环境 + 其后连续注释段与同号标题。
 */
function assignTitleConvention(blocks: RawBlock[]): void {
  const free = blocks.filter((block) => (block.captionNumbers ?? []).length === 0);
  const firstTrailingTitle = (block: RawBlock): TitleParagraph | undefined => (block.trailing ?? []).find((entry) => entry.number !== null);
  const aboveComplete = free.length > 0 && free.every((block) => block.prevTitle !== undefined);
  const belowComplete = free.length > 0 && free.every((block) => firstTrailingTitle(block) !== undefined);
  const agree = free.every((block) => block.prevTitle?.number === firstTrailingTitle(block)?.number);
  const convention: "above" | "below" | "union" =
    aboveComplete && belowComplete ? (agree ? "above" : "union") : aboveComplete ? "above" : belowComplete ? "below" : "union";
  for (const block of blocks) {
    const numbers = new Set<string>(block.captionNumbers ?? []);
    let start = block.coreStart ?? block.start;
    const trailing = block.trailing ?? [];
    const useCaption = numbers.size > 0;
    const below = firstTrailingTitle(block);
    let continued = block.continuedFloat === true || block.captionContinued === true;
    if (useCaption) {
      if (block.prevTitle?.number !== undefined && block.prevTitle.number !== null && numbers.has(block.prevTitle.number)) start = block.prevTitle.start;
    } else if (convention === "above" && block.prevTitle !== undefined) {
      numbers.add(block.prevTitle.number!);
      start = block.prevTitle.start;
      continued ||= block.prevTitle.continued === true;
    } else if (convention === "below" && below !== undefined) {
      numbers.add(below.number!);
      continued ||= below.continued === true;
      // M14.9.5.2：下方标题约定下，紧邻上方的同号标题（中文题注在上、英文题注在下）一并纳入（与上方约定并入同号下方标题对称）
      if (block.prevTitle !== undefined && block.prevTitle.number === below.number) start = block.prevTitle.start;
    } else if (convention === "union") {
      if (block.prevTitle !== undefined) { numbers.add(block.prevTitle.number!); start = block.prevTitle.start; continued ||= block.prevTitle.continued === true; }
      if (below !== undefined) { numbers.add(below.number!); continued ||= below.continued === true; }
    }
    // 其后连续段：注释段与同号标题并入；遇到不同编号的标题（下一张表的上方标题）即止。
    // M14.9.5.2：上方标题约定下，紧随的「续表 N」标题属于下一块（续表本身），不并入主表
    let end = block.coreEnd ?? block.end;
    for (const entry of trailing) {
      if (entry.number !== null && !numbers.has(entry.number)) break;
      if (entry.continued === true && convention !== "below" && !continued) break;
      end = entry.end;
    }
    if (continued) block.continued = true;
    block.numbers = [...numbers];
    block.start = start;
    block.end = end;
  }
}

function equationBlocks(text: string): RawBlock[] {
  return [...text.matchAll(EQUATION_ENV)].map((match) => {
    const block = match[0];
    const tags = [...block.matchAll(/\\tag\*?\{([^{}]+)\}/g)].map((tag) => normalizeNumber(tag[1]!.trim()));
    return { kind: "equation" as const, start: match.index!, end: match.index! + block.length, numbers: tags, numberedCaption: false, labels: labelsOf(block) };
  }).filter((block) => block.labels.length > 0 || block.numbers.length > 0);
}

const COUNTER_BREAKERS = /\\(?:chapter|appendix|setcounter\{(?:table|figure)\}|numberwithin|addtocounter\{(?:table|figure)\})/;

/**
 * 全文依赖目标索引。同一单元文本由 coverage plan 的 span 原样给出，
 * 依赖原文直接切自单元原文（不改写稿件）。
 */
export function indexDependencyTargets(
  units: ReadonlyArray<{ unitId: string; file: string; heading: string; text: string }>,
  options: { documentOrderProven: boolean },
): DependencyIndex {
  const targets: DependencyTarget[] = [];
  const labelDefinitions = new Map<string, string[]>();
  const pending: Array<{ unit: (typeof units)[number]; block: RawBlock }> = [];
  // 计数器顺序只在单元顺序可证明等于排版顺序时才推断（多文件经 BFS 收集时不成立）
  let counterBlocked = !options.documentOrderProven;
  for (const unit of units) {
    if (COUNTER_BREAKERS.test(unit.text)) counterBlocked = true;
    for (const label of labelsOf(unit.text)) labelDefinitions.set(label, [...(labelDefinitions.get(label) ?? []), unit.unitId]);
    for (const block of [...floatBlocks(unit.text, "table"), ...floatBlocks(unit.text, "figure"), ...equationBlocks(unit.text)]) pending.push({ unit, block });
  }
  for (const kind of ["table", "figure"] as const) assignTitleConvention(pending.filter((entry) => entry.block.kind === kind).map((entry) => entry.block));
  const counterNumbering = { table: false, figure: false };
  for (const kind of ["table", "figure"] as const) {
    const blocks = pending.filter((entry) => entry.block.kind === kind);
    counterNumbering[kind] = !counterBlocked && blocks.length > 0 && blocks.every((entry) => entry.block.numbers.length === 0);
    if (!counterNumbering[kind]) continue;
    let counter = 0;
    for (const entry of blocks) {
      if (!entry.block.numberedCaption) continue;
      // M14.9.5.2：\ContinuedFloat 的续表沿用上一张表的编号（LaTeX 计数器不递增）——旧口径会让其后每张表的编号都错一位
      if (entry.block.continuedFloat === true && counter > 0) {
        entry.block.numbers = [String(counter)];
        entry.block.continued = true;
        continue;
      }
      counter += 1;
      entry.block.numbers = [String(counter)];
    }
  }
  const ordinals = new Map<string, number>();
  for (const { unit, block } of pending) {
    const key = `${block.kind}:${unit.unitId}`;
    const ordinal = (ordinals.get(key) ?? 0) + 1;
    ordinals.set(key, ordinal);
    const text = unit.text.slice(block.start, block.end);
    targets.push({
      targetId: `${block.kind}:${unit.unitId}#${ordinal}`,
      kind: block.kind,
      unitId: unit.unitId,
      file: unit.file,
      heading: unit.heading,
      numbers: block.numbers,
      numberSource: block.numbers.length === 0 ? "none" : block.kind === "equation" ? "tag" : counterNumbering[block.kind] ? "latex_counter" : "caption_text",
      labels: block.labels,
      text,
      sha256: sha256Hex(text),
      ...(block.continued === true ? { continued: true as const } : {}),
    });
  }
  return { targets, labelDefinitions, counterNumbering };
}

const KIND_LABEL: Record<DependencyKind, string> = { table: "表", figure: "图", equation: "公式" };

/**
 * M14.9.5.2：主表 + 跨页续表合为一个依赖对象。成立条件（任一不满足 → null，按原规则处理）：候选同类、同一个唯一编号，
 * 全文该编号恰有一个非续表块且位于所有续表之前，至少有一个续表。
 */
function continuationGroup(index: DependencyIndex, candidates: readonly DependencyTarget[]): { main: DependencyTarget; parts: DependencyTarget[] } | null {
  const first = candidates[0];
  if (first === undefined || first.kind === "equation" || first.numbers.length !== 1) return null;
  const number = first.numbers[0]!;
  if (!candidates.every((candidate) => candidate.kind === first.kind && candidate.numbers.length === 1 && candidate.numbers[0] === number)) return null;
  const same = index.targets.filter((target) => target.kind === first.kind && target.numbers.length === 1 && target.numbers[0] === number);
  const mains = same.filter((target) => target.continued !== true);
  if (mains.length !== 1 || same.length < 2 || same[0] !== mains[0]) return null;
  if (!candidates.every((candidate) => same.includes(candidate))) return null;
  return { main: mains[0]!, parts: same };
}

/**
 * 单元的跨单元依赖解析（确定性）：label 引用优先，其次文本编号；唯一候选才附上；整块附上或 CONTEXT_OVERFLOW。
 * policy=isolated_no_dependencies 时照样解析（trace 可见缺了什么），但一律记为 NOT_ATTACHED_BY_POLICY。
 */
export function resolveUnitDependencies(input: {
  unitId: string;
  text: string;
  index: DependencyIndex;
  budgetChars: number;
  attach: boolean;
  /** 审稿政策引用的摘要锚点（只读口径的 blocking 定义需要；不占表格依赖预算，有独立上限） */
  rubricAnchor?: RubricAnchorResult;
}): UnitDependencyResolution {
  const { index, unitId } = input;
  const ownTargets = index.targets.filter((target) => target.unitId === unitId);
  // 本单元自身浮动体（标题 / 题注 / 注释）中的编号不算引用
  let scanText = input.text;
  for (const target of ownTargets) scanText = scanText.split(target.text).join(" ".repeat(Math.min(target.text.length, 1)));

  type Wanted = { order: number; priority: 0 | 1; mention: string; kind: DependencyKind | "label"; candidates: DependencyTarget[]; via: DependencyResolution; reasonIfNone: string; navigational?: boolean; ambiguous?: string };
  const wanted: Wanted[] = [];
  for (const match of input.text.matchAll(/\\(?:ref|autoref|cref|Cref|eqref|pageref|nameref|vref|Vref)\*?\{([^{}]+)\}/g)) {
    for (const raw of match[1]!.split(",")) {
      const label = raw.trim();
      if (label === "") continue;
      const defined = index.labelDefinitions.get(label) ?? [];
      const candidates = index.targets.filter((target) => target.labels.includes(label));
      const mention = `\\ref{${label}}`;
      if (defined.length > 1) {
        wanted.push({ order: match.index!, priority: 0, mention, kind: "label", candidates, via: "label", reasonIfNone: "", ambiguous: `\\label{${label}} 在全文定义了 ${defined.length} 次（${[...new Set(defined)].join("、")}）` });
      } else if (defined.length === 0) {
        wanted.push({ order: match.index!, priority: 0, mention, kind: "label", candidates: [], via: "label", reasonIfNone: `全文没有 \\label{${label}}` });
      } else if (candidates.length === 0) {
        wanted.push({ order: match.index!, priority: 0, mention, kind: "label", candidates: [], via: "label", reasonIfNone: "", navigational: true });
      } else {
        wanted.push({ order: match.index!, priority: 0, mention, kind: candidates[0]!.kind, candidates, via: "label", reasonIfNone: "" });
      }
    }
  }
  for (const kind of ["table", "figure"] as const) {
    for (const mention of plainMentions(scanText, kind)) {
      const candidates = index.targets.filter((target) => target.kind === kind && target.numbers.length === 1 && target.numbers[0] === mention.number);
      const conflicting = index.targets.filter((target) => target.kind === kind && target.numbers.length > 1 && target.numbers.includes(mention.number));
      const all = [...candidates, ...conflicting];
      const via: DependencyResolution = index.counterNumbering[kind] ? "latex_counter" : "caption_number";
      wanted.push({
        order: mention.index, priority: 1, mention: mention.mention, kind, candidates: conflicting.length > 0 ? all : candidates, via,
        reasonIfNone: index.targets.some((target) => target.kind === kind && target.numberSource === "none")
          ? `全文没有可证明编号为 ${mention.number} 的${KIND_LABEL[kind]}（存在无显式编号的${KIND_LABEL[kind]}，不按顺序猜测）`
          : `全文没有编号为 ${mention.number} 的${KIND_LABEL[kind]}`,
      });
    }
  }
  for (const mention of equationMentions(scanText)) {
    const candidates = index.targets.filter((target) => target.kind === "equation" && target.numbers.includes(mention.number));
    wanted.push({
      order: mention.index, priority: 1, mention: mention.mention, kind: "equation", candidates, via: "tag",
      reasonIfNone: `公式编号 (${mention.number}) 无 \\tag 或 \\label 可证明（LaTeX 自动编号与转写编号不一定对应，不推断）`,
    });
  }
  wanted.sort((a, b) => a.priority - b.priority || a.order - b.order);

  const gaps: DependencyGap[] = [];
  const inUnit: string[] = [];
  const navigational: string[] = [];
  const attachedById = new Map<string, AttachedDependency & { text: string }>();
  const gapKeys = new Set<string>();
  const pushGap = (gap: Omit<DependencyGap, "check" | "checkStatus">, check: DependencyGap["check"] = "CROSS_REFERENCE_CONSISTENCY"): void => {
    const key = `${gap.status}|${gap.mention}`;
    if (gapKeys.has(key)) return;
    gapKeys.add(key);
    gaps.push({ ...gap, check, checkStatus: "NOT_EVALUATED" });
  };
  let anchorChars = 0;
  const anchor = input.rubricAnchor;
  if (anchor !== undefined) {
    const mention = "论文摘要";
    if (!anchor.found) {
      if (input.attach) pushGap({ kind: "abstract", mention, status: anchor.status, reason: anchor.reason }, "BLOCKING_DETERMINATION");
    } else if (anchor.unitId === unitId) {
      inUnit.push(mention);
    } else if (!input.attach) {
      pushGap({ kind: "abstract", mention, status: "NOT_ATTACHED_BY_POLICY", reason: `位于单元 ${anchor.unitId}；本策略不附跨单元依赖`, candidates: [`abstract:${anchor.unitId}`] }, "BLOCKING_DETERMINATION");
    } else {
      anchorChars = anchor.text.length;
      attachedById.set(`abstract:${anchor.unitId}`, {
        refId: "D1", kind: "abstract", targetId: `abstract:${anchor.unitId}`, sourceUnitId: anchor.unitId, sourceFile: anchor.file, sourceHeading: anchor.heading,
        via: "rubric_anchor", mentions: [mention], numbers: [], labels: [], sha256: anchor.sha256, chars: anchor.text.length, text: anchor.text,
      });
    }
  }
  let used = 0;
  for (const entry of wanted) {
    if (entry.navigational === true) {
      if (!navigational.includes(entry.mention)) navigational.push(entry.mention);
      continue;
    }
    const kind = entry.kind;
    if (entry.ambiguous !== undefined) {
      pushGap({ kind, mention: entry.mention, status: "DEPENDENCY_AMBIGUOUS", reason: entry.ambiguous, candidates: entry.candidates.map((candidate) => candidate.targetId) });
      continue;
    }
    if (entry.candidates.length === 0) {
      pushGap({ kind, mention: entry.mention, status: "DEPENDENCY_UNRESOLVED", reason: entry.reasonIfNone });
      continue;
    }
    const unique = [...new Map(entry.candidates.map((candidate) => [candidate.targetId, candidate])).values()];
    // M14.9.5.2：主表 + 跨页续表（同号、恰有一个非续表块）是同一个对象，不算歧义；\label 只挂在主表上时同样带上续表
    const group = continuationGroup(index, unique);
    if (unique.length > 1 && group === null) {
      pushGap({ kind, mention: entry.mention, status: "DEPENDENCY_AMBIGUOUS", reason: `${unique.length} 个候选，不选择`, candidates: unique.map((candidate) => candidate.targetId) });
      continue;
    }
    const target = group?.main ?? unique[0]!;
    const outside = group === null ? (target.unitId === unitId ? [] : [target]) : group.parts.filter((part) => part.unitId !== unitId);
    if (outside.length === 0) {
      if (!inUnit.includes(entry.mention)) inUnit.push(entry.mention);
      continue;
    }
    const existing = attachedById.get(target.targetId);
    if (existing !== undefined) {
      if (!existing.mentions.includes(entry.mention)) existing.mentions.push(entry.mention);
      continue;
    }
    if (!input.attach) {
      pushGap({ kind, mention: entry.mention, status: "NOT_ATTACHED_BY_POLICY", reason: `位于单元 ${outside[0]!.unitId}；本策略不附跨单元依赖`, candidates: outside.map((part) => part.targetId) });
      continue;
    }
    const text = outside.map((part) => part.text).join("\n\n");
    if (used + text.length > input.budgetChars) {
      pushGap({
        kind, mention: entry.mention, status: "CONTEXT_OVERFLOW", candidates: outside.map((part) => part.targetId),
        reason: `${text.length} 字超出依赖预算剩余 ${input.budgetChars - used} 字（预算 ${input.budgetChars}；不截断表格${group !== null ? "，续表与主表整体附上或整体不附" : ""}）`,
      });
      continue;
    }
    used += text.length;
    const source = outside[0]!;
    attachedById.set(target.targetId, {
      refId: `D${attachedById.size + 1}`, kind: target.kind, targetId: target.targetId, sourceUnitId: source.unitId,
      sourceFile: source.file, sourceHeading: source.heading, via: entry.via, mentions: [entry.mention],
      numbers: target.numbers, labels: target.labels, sha256: group === null ? target.sha256 : sha256Hex(text), chars: text.length, text,
      ...(group !== null ? { parts: outside.map((part) => part.targetId) } : {}),
    });
  }
  return { attached: [...attachedById.values()], gaps, inUnit, navigational, dependencyChars: used + anchorChars };
}

export function dependencyFingerprint(resolution: Pick<UnitDependencyResolution, "attached" | "gaps">): string {
  return sha256Hex(JSON.stringify({
    attached: resolution.attached.map((dep) => [dep.targetId, dep.sha256, dep.via]),
    gaps: resolution.gaps.map((gap) => [gap.kind, gap.mention, gap.status, gap.candidates ?? []]),
  }));
}

export function buildContextSnapshotRecord(input: {
  policy: ReviewUnitContextPolicy;
  unitId: string;
  text: string;
  resolution: UnitDependencyResolution;
  sourceVerification: SourceVerification;
  budgetChars: number;
}): ReviewContextSnapshotRecord {
  const { resolution } = input;
  return {
    schema: REVIEW_CONTEXT_SNAPSHOT_SCHEMA,
    policy: input.policy,
    unitId: input.unitId,
    unitSha256: sha256Hex(input.text),
    unitChars: input.text.length,
    sourceVerification: input.sourceVerification,
    dependencyBudgetChars: input.budgetChars,
    dependencyChars: resolution.dependencyChars,
    dependencies: resolution.attached.map(({ text: _text, ...meta }) => ({ ...meta, mentions: [...meta.mentions] })),
    gaps: resolution.gaps,
    inUnitReferences: resolution.inUnit,
    navigationalReferences: resolution.navigational,
    dependencyFingerprint: dependencyFingerprint(resolution),
    contextComplete: resolution.gaps.length === 0,
  };
}

const VERIFICATION_TEXT: Record<SourceVerification, string> = {
  AUTHOR_SOURCE: "AUTHOR_SOURCE（作者 LaTeX 源稿）",
  SOURCE_ATTESTED: "SOURCE_ATTESTED（PDF 转写投影，有哈希绑定的人工 QA 证明）",
  SOURCE_UNVERIFIED: "SOURCE_UNVERIFIED（PDF 转写投影，表格 / 公式未经人工逐格核验，不等于原始事实）",
  SOURCE_UNKNOWN: "SOURCE_UNKNOWN（第三方论文输入，来源与转写方式未记录；表格 / 公式未经人工逐格核验，不等于原始事实）",
};
const VIA_TEXT: Record<DependencyResolution, string> = {
  label: "\\label 引用",
  caption_number: "题注 / 标题中的唯一编号",
  latex_counter: "LaTeX 计数器顺序（全文无显式编号）",
  tag: "公式 \\tag 编号",
  rubric_anchor: "审稿口径锚点（摘要段）",
};

/**
 * prompt 中的依赖块（policy=isolated_snapshot 且有依赖或缺口时才非空）：「论文摘要」锚点块在前，
 * 表 / 图 / 公式依赖块在后，未能附上的依赖（含摘要锚点缺口）列在末尾。
 */
export function renderDependencyBlock(input: {
  attached: ReadonlyArray<AttachedDependency & { text: string }>;
  gaps: readonly DependencyGap[];
  sourceVerification: SourceVerification;
}): string[] {
  const gaps = input.gaps.filter((gap) => gap.status !== "NOT_ATTACHED_BY_POLICY");
  if (input.attached.length === 0 && gaps.length === 0) return [];
  const anchors = input.attached.filter((dep) => dep.kind === "abstract");
  const refs = input.attached.filter((dep) => dep.kind !== "abstract");
  return [
    ...anchors.flatMap((dep) => [
      `===== 论文摘要（只读参考：判断 blocking 时「摘要所述核心结论」以此为准；不在本单元审查范围内，不要报告摘要自身的问题）· 来源单元「${dep.sourceHeading}」（${dep.sourceFile}）· 来源核验：${VERIFICATION_TEXT[input.sourceVerification]} · sha256:${dep.sha256.slice(0, 12)} =====`,
      dep.text,
      "",
    ]),
    ...(refs.length > 0 || gaps.length > 0
      ? ["===== 跨单元依赖（只读参考：本单元正文引用、但位于其他单元的表格 / 图 / 公式；不在本单元审查范围内）====="]
      : []),
    ...refs.flatMap((dep) => [
      `--- [${dep.refId}] ${dep.mentions.join(" / ")} · 来源单元「${dep.sourceHeading}」（${dep.sourceFile}）· 定位：${VIA_TEXT[dep.via]}${dep.parts !== undefined ? ` · 含跨页续表 / 续图（${dep.parts.length} 部分，按原文顺序合为一个对象）` : ""} · 来源核验：${VERIFICATION_TEXT[input.sourceVerification]} · sha256:${dep.sha256.slice(0, 12)} ---`,
      dep.text,
    ]),
    ...(gaps.length > 0
      ? [
          "--- 未能附上的依赖（对应的核对未执行；不要猜测其内容，也不要因「看不到」而报告该对象缺失）---",
          ...gaps.map((gap) => `- ${gap.mention}：${gap.status}（${gap.reason}）`),
        ]
      : []),
    ...(refs.length > 0 || gaps.length > 0 ? [""] : []),
  ];
}

/** quote 只出现在依赖参考、不在本单元原文中的 issue（空白归一化后逐字比较）；只用于标注与计数 */
export function referenceOnlyQuoteIndices(unitText: string, dependencyTexts: readonly string[], issues: ReadonlyArray<{ quote?: string }>): number[] {
  const normalize = (text: string): string => text.replace(/\s+/g, "");
  const unit = normalize(unitText);
  const refs = dependencyTexts.map(normalize);
  const out: number[] = [];
  issues.forEach((issue, index) => {
    const quote = normalize(issue.quote ?? "");
    if (quote.length < 6 || unit.includes(quote)) return;
    if (refs.some((ref) => ref.includes(quote))) out.push(index);
  });
  return out;
}

export function parseReviewUnitContextPolicy(raw: string | undefined): ReviewUnitContextPolicy | undefined {
  const value = raw?.trim().toLowerCase();
  if (value === undefined || value === "") return undefined;
  return (REVIEW_UNIT_CONTEXT_POLICIES as readonly string[]).includes(value) ? (value as ReviewUnitContextPolicy) : undefined;
}
