/**
 * LaTeX heading 提取与章节引用匹配（M10.4.4 Finding Dispatch Coverage）。
 *
 * 背景：Reviewer 的 section 字段按输出契约允许「章节名」（ReviewerService
 * prompt：`"section": "sections/xxx.tex、abstract（摘要问题归这里）或章节名"`），
 * 而派发侧 sectionMatches 原先只认路径 / stem / key——单文件 main.tex 项目里
 * heading 式引用（「方法/3.6 轨迹稳定性自适应损失」）从不命中，finding 永久
 * 滞留 planned（M10.4.1 A3 / M10.4.4 分析文档 §1：真实 r2 回放 23/29 unmatched）。
 *
 * 本模块提供确定性的 heading 感知匹配（零 LLM / 零 NLP 依赖）：
 * - extractLatexHeadings：\section / \subsection / \subsubsection / \chapter /
 *   \paragraph（含 starred 变体）标题提取——平衡花括号扫描，支持嵌套
 *   \mbox{-} 与跨行标题（真实论文 `\subsection{… MRG\mbox{-}\nDTM}` 形态）；
 * - normalizeHeadingTitle：\mbox{X}→X、其余命令删除、连接号统一、去空白、小写；
 * - sectionRefNamesHeading：引用切段（分隔符 / 括号注释 / 前导编号）后先做
 *   「段 == 标题」精确匹配（文档序），再做「归一化标题 ⊆ 归一化引用」子串
 *   兜底（标题 ≥2 字）。grounded：调用方只把目标自身内容的标题喂进来，
 *   命中即「该标题物理存在于该目标文件」——不存在错派发到不含该标题的文件。
 *
 * 不做编号→标题映射：真实产物中 reviewer 编号与 LaTeX 实际编号存在错位
 * （M10.4.2 A1 r2 用 3.6/3.7 指方法节小节），按编号派发有错派风险；编号与
 * 标题并存的引用由标题段命中。
 */

/** 分节命令（含 starred 变体；\paragraph 纳入以覆盖段落级指位） */
const HEADING_PATTERN = /\\(?:chapter|section|subsection|subsubsection|paragraph)\*?\s*\{/g;

/**
 * 提取标题原文（未经归一化；保留 \mbox 等内部命令，由 normalize 处理）。
 * 平衡花括号扫描：跳过转义字符，支持嵌套命令与跨行标题。
 */
export function extractLatexHeadings(latex: string): string[] {
  const text = latex.replace(/\r\n/g, "\n");
  const headings: string[] = [];
  HEADING_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = HEADING_PATTERN.exec(text)) !== null) {
    let depth = 1;
    let index = match.index + match[0].length;
    while (index < text.length && depth > 0) {
      const char = text[index] as string;
      if (char === "\\") {
        index += 2; // 命令转义（\{ \} \\ 等）：不参与配对
        continue;
      }
      if (char === "{") {
        depth += 1;
      } else if (char === "}") {
        depth -= 1;
      }
      index += 1;
    }
    if (depth !== 0) {
      continue; // 花括号不闭合：丢弃该候选（防御 malformed 输入）
    }
    const title = text.slice(match.index + match[0].length, index - 1).trim();
    if (title !== "") {
      headings.push(title);
    }
  }
  return headings;
}

/** 标题 / 引用段的确定性归一化（纯函数；双侧同口径） */
export function normalizeHeadingTitle(title: string): string {
  let text = title;
  // \mbox{X} → X（迭代展开嵌套；真实论文标题用 \mbox{-} 连接复合词）
  for (let round = 0; round < 5; round += 1) {
    const next = text.replace(/\\mbox\s*\{([^{}]*)\}/g, "$1");
    if (next === text) {
      break;
    }
    text = next;
  }
  text = text.replace(/\\[a-zA-Z]+\*?(?:\[[^\]]*\])?/g, ""); // 其余命令（保留参数内文本不展开）
  text = text.replace(/[{}]/g, "");
  text = text.replace(/[－–—‐‑−ー]/g, "-"); // 全角 / 各类连接号统一
  return text.replace(/\s+/g, "").toLowerCase();
}

/** 引用切段分隔符：路径斜杠、中点、层级符、顿号、逗号、并列连词 */
const REF_SEPARATORS = /[／/·・>＞→、，,;；]|\s+与\s+|\s+及\s+|\s+和\s+/g;

/** 剥离括号注释（「（表 tab:x）」「（末段）」「(第一段)」等位置补充说明） */
const PARENTHETICAL = /[（(][^（）()]*[）)]/g;

/** 剥离前导编号（「3.6 」「2. 」「1、」；纯编号段剥完为空 → 自然淘汰） */
const LEADING_NUMBER = /^\d+(?:\.\d+)*[.、)]?\s*/;

/** 引用切成候选段（已归一化；空段淘汰） */
function refSegments(sectionRef: string): string[] {
  return sectionRef
    .replace(PARENTHETICAL, " ")
    .split(REF_SEPARATORS)
    .map((segment) => normalizeHeadingTitle(segment.replace(LEADING_NUMBER, "")))
    .filter((segment) => segment.length > 0);
}

/** 子串兜底的最短标题长度（单字符标题过泛） */
const MIN_SUBSTRING_HEADING_LENGTH = 2;

/**
 * 引用是否指向给定标题集合之一（grounded：标题集来自被考查目标自身内容）。
 * 先精确段匹配（按传入顺序即文档序），后子串兜底。
 */
export function sectionRefNamesHeading(
  sectionRef: string,
  headings: readonly string[],
): boolean {
  const trimmed = sectionRef.trim();
  if (trimmed === "" || trimmed === "(global)" || trimmed === "(unknown)" || trimmed === "(external)") {
    return false; // 哨兵引用不参与 heading 匹配
  }
  const segments = refSegments(trimmed);
  if (segments.length === 0) {
    return false;
  }
  for (const heading of headings) {
    const normalized = normalizeHeadingTitle(heading);
    if (segments.includes(normalized)) {
      return true;
    }
  }
  const normalizedRef = normalizeHeadingTitle(trimmed.replace(PARENTHETICAL, " "));
  if (normalizedRef === "") {
    return false;
  }
  for (const heading of headings) {
    const normalized = normalizeHeadingTitle(heading);
    if (normalized.length >= MIN_SUBSTRING_HEADING_LENGTH && normalizedRef.includes(normalized)) {
      return true;
    }
  }
  return false;
}

/** 摘要环境的确定性探测（grounded 摘要归属：摘要物理在该文件内才允许派发） */
export function latexContainsAbstract(latex: string): boolean {
  // \abstract 加边界：避免 \abstractname 等无关命令假阳性（它们出现时文档
  // 通常也确有 abstract 环境，双重保险而已）
  return /\\begin\{abstract\}/.test(latex) || /\\abstract(?![a-zA-Z])/.test(latex);
}

/**
 * 目标内容的标题缓存（派发循环对同一 target 反复求值 match；WeakMap 随
 * target 对象回收，无跨 run 泄漏。target 在每次 stage 组装时新建，缓存
 * 生命周期天然限定在本轮派发）。
 */
const headingCache = new WeakMap<object, string[]>();

/** 带缓存的目标标题提取（key 必须是携带 currentLatex 的目标对象） */
export function headingsOfContent(carrier: object, latex: string): string[] {
  const cached = headingCache.get(carrier);
  if (cached !== undefined) {
    return cached;
  }
  const headings = extractLatexHeadings(latex);
  headingCache.set(carrier, headings);
  return headings;
}
