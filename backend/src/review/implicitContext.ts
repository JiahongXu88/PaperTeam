/**
 * M14.9.5.4 受控的隐式依赖（isolated_snapshot）：本单元没有用 \ref 显式引用、但其他章节已给出定义 / 口径 / 数据 / 解读的内容。
 *
 * 背景（M14.9.5.3 findings-audit）：C 臂多出的数值误报 Major 几乎都是「其他章节已解释、但不在本单元快照里」——训练数据与
 * 测试集零重叠写在「数据集与划分」、代价公式的 min(d², τ) 截断写在「跟踪基座」、118 起事件对 121 次 IDSW 的口径差写在
 * 「取证方法」、配对统计的估计量 / 比较族 / 「优/劣/平」定义写在「评测器与统计方法」、只有表格的单元其解读写在引用该表的段落。
 * 共享会话靠会话历史碰巧看到，隔离快照看不到。
 *
 * 只用确定性、可追溯的信号（不做开放式检索，不读工作区）：
 *   1. protocol_convention：标题表明是记号 / 定义 / 统计方法 / 评测协议 / 数据集划分的短单元，是其后各单元共用的口径
 *      实体 → 整段附给文档顺序在其后的单元（独立预算，整段附上或不附）；
 *   2. reverse_reference：本单元浮动体（表 / 图 / 公式）的 \label 被其他单元 \ref → 附上引用句（表格的「解读」）；
 *   3. entity_cooccurrence：本单元（含已附显式依赖）与其他单元的某一句共有 ≥2 个区分性实体（数值 / 带数字或下划线 / 加号的
 *      标识符），且实体的逆文档频度之和达到阈值 → 附上该句（多句按原文顺序，句前紧邻的公式环境一并附上）。
 * 候选确定性排序；片段逐个整体附上或不附（预算内、绝不截断到半句），带来源单元 / sha256 / 命中实体。只读参考、不计覆盖率。
 */
import { sha256Hex } from "../util/hash.js";

export interface ImplicitContextOptions {
  /** reverse_reference + entity_cooccurrence 片段总预算（字符） */
  budgetChars: number;
  /** 最多附上的来源单元数（reverse_reference + entity_cooccurrence） */
  maxSnippets: number;
  /** 每个来源单元最多附上的句子数 */
  maxSegmentsPerSnippet: number;
  /** entity_cooccurrence 至少共有的区分性实体数 */
  minSharedAnchors: number;
  /** protocol_convention 总预算（字符）与单个口径单元上限 */
  conventionBudgetChars: number;
  conventionMaxUnitChars: number;
}

export const DEFAULT_IMPLICIT_CONTEXT_OPTIONS: ImplicitContextOptions = {
  budgetChars: 4_500,
  maxSnippets: 6,
  maxSegmentsPerSnippet: 3,
  minSharedAnchors: 2,
  conventionBudgetChars: 5_000,
  conventionMaxUnitChars: 2_500,
};

/** 口径单元的标题（记号 / 定义 / 统计方法 / 评测协议 / 数据集划分 / 指标） */
const CONVENTION_HEADING = /(记号|符号说明|术语|定义|统计方法|统计检验|评测器|评测协议|实验协议|评价指标|评估指标|数据集与划分|数据划分|Notation|Definitions?|Statistical|Evaluation protocol|Protocols?|Metrics|Datasets? and splits?)/i;

/** 桥接句的排序加成（约等于再多两个中等稀有实体） */
const BRIDGE_BONUS = 10;

const SUMMARY_HEADING = /^(?:frontmatter|前置内容|摘\s*要|Abstract|引言|绪论|Introduction|结论|总结|Conclusions?)$/i;

interface Segment {
  unitId: string;
  file: string;
  heading: string;
  order: number;
  text: string;
  anchors: Set<string>;
  refs: Set<string>;
}

export interface ImplicitContextIndex {
  segments: Segment[];
  documentFrequency: Map<string, number>;
  /** 区分性实体的文档频度上限（句数）：只有不超过它的共有实体计入 entity_cooccurrence */
  rareLimit: number;
  /** 实体出现的单元数（「成对实体」= 只出现在两个单元里） */
  unitFrequency: Map<string, number>;
  unitOrder: Map<string, number>;
  /** 本单元浮动体 / 公式环境里定义的 \label */
  floatLabels: Map<string, Set<string>>;
  conventions: Array<{ unitId: string; file: string; heading: string; order: number; text: string }>;
  /** 摘要 / 前置 / 引言 / 结论单元：复述全文结论而非给出定义或数据，不作为共有实体的来源 */
  summaryUnits: Set<string>;
}

export interface ImplicitSnippet {
  via: "protocol_convention" | "entity_cooccurrence" | "reverse_reference";
  sourceUnitId: string;
  sourceFile: string;
  sourceHeading: string;
  anchors: string[];
  text: string;
  sha256: string;
}

const STRIP_COMMANDS = /\\(?:ref|eqref|autoref|cref|Cref|pageref|label|cite[a-z]*|input|include|includegraphics|begin|end)\*?(?:\[[^\]]*\])?\{[^{}]*\}/g;

/** 实体归一：去 LaTeX 千分位 {,} / 转义下划线 / 数学 $ / 不换行 ~ */
function normalizeForAnchors(text: string): string {
  return text.normalize("NFKC").replace(STRIP_COMMANDS, " ").replace(/\{,\}/g, "").replace(/\\_/g, "_").replace(/\\[A-Za-z]+/g, " ").replace(/[$~]/g, " ")
    // 「QD(120)」与「QD120」是同一标识符（表格行常带括号）
    .replace(/(?<![\w])([A-Za-z]+)\((\d+)\)/g, "$1$2");
}

/** 区分性实体候选：数值（多位整数 / 小数 / 千分位）与带数字、下划线或加号的标识符 */
export function anchorsOf(text: string): Set<string> {
  const normalized = normalizeForAnchors(text);
  const anchors = new Set<string>();
  for (const match of normalized.matchAll(/(?<![\w.])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+\.\d+|\d{2,})(?![\w])/g)) {
    anchors.add(`#${match[1]!.replace(/,/g, "")}`);
  }
  for (const match of normalized.matchAll(/(?<![\w])([A-Za-z][A-Za-z0-9]*(?:[_+][A-Za-z0-9]+)+|[A-Za-z]+\d+[A-Za-z0-9]*)(?![\w])/g)) {
    anchors.add(`@${match[1]!}`);
  }
  return anchors;
}

function referencedLabels(text: string): Set<string> {
  const labels = new Set<string>();
  for (const match of text.matchAll(/\\(?:ref|autoref|cref|Cref|eqref|vref)\*?\{([^{}]+)\}/g)) {
    for (const raw of match[1]!.split(",")) if (raw.trim() !== "") labels.add(raw.trim());
  }
  return labels;
}

const FLOAT_OR_EQUATION = /\\begin\{(table\*?|sidewaystable\*?|longtable|figure\*?|sidewaysfigure\*?|equation\*?|align\*?|gather\*?|multline\*?)\}[\s\S]*?\\end\{\1\}/g;
const DISPLAY_MATH = /\\begin\{(equation\*?|align\*?|gather\*?|multline\*?)\}[\s\S]*?\\end\{\1\}/g;

/** 句级切分：公式环境整体一段；其余按行与中文 / 英文句末标点切分（不改写原文） */
function segmentsOf(text: string): string[] {
  const out: string[] = [];
  let cursor = 0;
  const pushProse = (prose: string): void => {
    for (const line of prose.split(/\n/)) {
      for (const match of line.matchAll(/[^。；！？]+[。；！？]?/g)) {
        const piece = match[0].trim();
        if (piece.length >= 6) out.push(piece);
      }
    }
  };
  for (const match of text.matchAll(DISPLAY_MATH)) {
    pushProse(text.slice(cursor, match.index));
    out.push(match[0]);
    cursor = match.index! + match[0].length;
  }
  pushProse(text.slice(cursor));
  return out;
}

export function indexImplicitContext(
  units: ReadonlyArray<{ unitId: string; file: string; heading: string; text: string }>,
  options: ImplicitContextOptions = DEFAULT_IMPLICIT_CONTEXT_OPTIONS,
): ImplicitContextIndex {
  const segments: Segment[] = [];
  const unitOrder = new Map<string, number>();
  const floatLabels = new Map<string, Set<string>>();
  const conventions: ImplicitContextIndex["conventions"] = [];
  const summaryUnits = new Set<string>();
  let order = 0;
  units.forEach((unit, position) => {
    unitOrder.set(unit.unitId, position);
    if (SUMMARY_HEADING.test(unit.heading) || /::frontmatter$/.test(unit.unitId)) summaryUnits.add(unit.unitId);
    floatLabels.set(unit.unitId, new Set([...unit.text.matchAll(FLOAT_OR_EQUATION)].flatMap((match) => [...match[0].matchAll(/\\label\{([^{}]+)\}/g)].map((label) => label[1]!.trim()))));
    const body = unit.text.replace(/^\s*\\(?:sub)*section\*?\{[^}]*\}\s*(?:\\label\{[^}]*\})?/, "").trim();
    if (CONVENTION_HEADING.test(unit.heading) && body.length >= 80 && body.length <= options.conventionMaxUnitChars) {
      conventions.push({ unitId: unit.unitId, file: unit.file, heading: unit.heading, order: position, text: body });
    }
    for (const text of segmentsOf(unit.text)) {
      segments.push({ unitId: unit.unitId, file: unit.file, heading: unit.heading, order: order++, text, anchors: anchorsOf(text), refs: referencedLabels(text) });
    }
  });
  const documentFrequency = new Map<string, number>();
  for (const segment of segments) for (const anchor of segment.anchors) documentFrequency.set(anchor, (documentFrequency.get(anchor) ?? 0) + 1);
  const unitsOfAnchor = new Map<string, Set<string>>();
  for (const segment of segments) for (const anchor of segment.anchors) unitsOfAnchor.set(anchor, (unitsOfAnchor.get(anchor) ?? new Set<string>()).add(segment.unitId));
  const unitFrequency = new Map([...unitsOfAnchor.entries()].map(([anchor, owners]) => [anchor, owners.size]));
  // 全文 2% 的句子（至少 3 句）：比它更普遍的数值 / 标识符（样本量、主结果总数等）不区分来源
  const rareLimit = Math.max(3, Math.round(segments.length * 0.02));
  return { segments, documentFrequency, rareLimit, unitFrequency, unitOrder, floatLabels, conventions, summaryUnits };
}

/**
 * 单元的隐式依赖（确定性）。attachedTexts = 已附显式依赖原文（参与实体抽取；其中的句子不重复附上）。
 */
export function resolveImplicitContext(input: {
  unitId: string;
  text: string;
  attachedTexts: readonly string[];
  index: ImplicitContextIndex;
  options?: ImplicitContextOptions;
}): { snippets: ImplicitSnippet[]; skippedOverBudget: number } {
  const options = input.options ?? DEFAULT_IMPLICIT_CONTEXT_OPTIONS;
  const { index } = input;
  const position = index.unitOrder.get(input.unitId) ?? Number.MAX_SAFE_INTEGER;
  const snippets: ImplicitSnippet[] = [];
  let skippedOverBudget = 0;
  const already = (text: string) => input.text.includes(text) || input.attachedTexts.some((attached) => attached.includes(text));

  // 1. 口径单元（文档顺序在本单元之前）：整段附上
  const conventionUnits = new Set<string>();
  let conventionChars = 0;
  for (const convention of index.conventions) {
    if (convention.unitId === input.unitId || convention.order >= position || already(convention.text)) continue;
    if (conventionChars + convention.text.length > options.conventionBudgetChars) { skippedOverBudget += 1; continue; }
    conventionChars += convention.text.length;
    conventionUnits.add(convention.unitId);
    snippets.push({
      via: "protocol_convention", sourceUnitId: convention.unitId, sourceFile: convention.file, sourceHeading: convention.heading,
      anchors: [convention.heading], text: convention.text, sha256: sha256Hex(convention.text),
    });
  }

  // 2/3. 反向引用与共有实体：按来源单元分组，句级最小片段
  const ownFloatLabels = index.floatLabels.get(input.unitId) ?? new Set<string>();
  const summaryUnits = index.summaryUnits;
  const ownUnit = anchorsOf(input.text);
  const own = new Set<string>([...ownUnit, ...input.attachedTexts.flatMap((text) => [...anchorsOf(text)])]);
  const total = Math.max(index.segments.length, 1);
  const idf = (anchor: string): number => Math.log(total / (index.documentFrequency.get(anchor) ?? total));
  type Hit = { segment: Segment; via: "reverse_reference" | "entity_cooccurrence"; shared: string[]; score: number };
  const hits: Hit[] = [];
  for (const segment of index.segments) {
    if (segment.unitId === input.unitId || conventionUnits.has(segment.unitId) || summaryUnits.has(segment.unitId) || already(segment.text)) continue;
    const reverse = [...segment.refs].filter((label) => ownFloatLabels.has(label));
    if (reverse.length > 0) {
      hits.push({ segment, via: "reverse_reference", shared: reverse.map((label) => `\\ref{${label}}`), score: 1_000 + reverse.length });
      continue;
    }
    const shared = [...segment.anchors].filter((anchor) => own.has(anchor) && (index.documentFrequency.get(anchor) ?? total) <= index.rareLimit);
    // 至少一个共有实体出自本单元原文：只由已附表格的数值牵出的句子不是本单元说法的上下文
    if (!shared.some((anchor) => ownUnit.has(anchor))) continue;
    // ≥2 个区分性实体；或 1 个只出现在本单元与该句所在单元的「成对」实体（全文只有这两个单元出现）
    if (shared.length < options.minSharedAnchors && !(shared.length === 1 && (index.unitFrequency.get(shared[0]!) ?? 0) <= 2)) continue;
    // 「桥接句」：同时含本单元原文的实体与只出现在已附依赖（被引表格）里的实体——正是解释两者口径关系的上下文，优先
    const bridges = shared.some((anchor) => ownUnit.has(anchor)) && shared.some((anchor) => !ownUnit.has(anchor));
    const score = shared.reduce((sum, anchor) => sum + idf(anchor), 0) + (bridges ? BRIDGE_BONUS : 0);
    hits.push({ segment, via: "entity_cooccurrence", shared: shared.sort(), score });
  }
  const bySource = new Map<string, Hit[]>();
  for (const hit of hits) bySource.set(hit.segment.unitId, [...(bySource.get(hit.segment.unitId) ?? []), hit]);
  const groups = [...bySource.entries()].map(([unitId, list]) => {
    const ranked = [...list].sort((a, b) => b.score - a.score || a.segment.order - b.segment.order).slice(0, options.maxSegmentsPerSnippet);
    return { unitId, best: ranked[0]!.score, chosen: ranked.sort((a, b) => a.segment.order - b.segment.order) };
  }).sort((a, b) => b.best - a.best || a.chosen[0]!.segment.order - b.chosen[0]!.segment.order);
  let used = 0;
  let taken = 0;
  for (const group of groups) {
    if (taken >= options.maxSnippets) break;
    const pieces: string[] = [];
    for (const hit of group.chosen) {
      // 命中句之前（同一单元、≤3 句内）若是「公式环境 + 其中…」的符号说明，公式与说明句一并附上：参数句解释的是那个公式
      for (let back = 3; back >= 1; back -= 1) {
        const equation = index.segments[hit.segment.order - back];
        const explanation = index.segments[hit.segment.order - back + 1];
        if (equation === undefined || explanation === undefined || equation.unitId !== hit.segment.unitId) continue;
        if (!/^\\begin\{/.test(equation.text) || !/^(?:其中|where\b)/i.test(explanation.text)) continue;
        for (const piece of index.segments.slice(hit.segment.order - back, hit.segment.order).map((entry) => entry.text)) {
          if (!pieces.includes(piece)) pieces.push(piece);
        }
        break;
      }
      if (!pieces.includes(hit.segment.text)) pieces.push(hit.segment.text);
    }
    const text = pieces.join(" … ");
    if (used + text.length > options.budgetChars) { skippedOverBudget += 1; continue; }
    used += text.length;
    taken += 1;
    const first = group.chosen[0]!;
    const via = group.chosen.some((hit) => hit.via === "reverse_reference") ? "reverse_reference" : "entity_cooccurrence";
    snippets.push({
      via, sourceUnitId: group.unitId, sourceFile: first.segment.file, sourceHeading: first.segment.heading,
      anchors: [...new Set(group.chosen.flatMap((hit) => hit.shared.map((anchor) => anchor.replace(/^[#@]/, ""))))],
      text, sha256: sha256Hex(text),
    });
  }
  return { snippets, skippedOverBudget };
}
