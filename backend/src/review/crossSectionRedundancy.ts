/**
 * Cross-Section Redundancy（M13.7.7）：确定性的跨章节复述探测器。
 *
 * 背景：M13.7.3 / M13.7.4 两轮真实 A/B 都只能靠人工阅读和关键词计数定位
 * "同一机制在多章被完整重述"，没有任何可重复的定位工具；Reviewer 的
 * digest 还会截断长节后部。本模块只做**词面必要条件**检测：
 * - 把每节 LaTeX 剥成句子，按 CJK 字符 bigram + 拉丁 / 数字 token 建集合；
 * - 只比较**不同章节**之间的句子对，报告包含度（shared / min）与 Jaccard；
 * - 以大纲顺序把"后节句子 ≈ 前节句子"记为 restatement，附两处原句，
 *   供 Reviewer / 人工 / 定向修订直接消费。
 *
 * 纪律：不是语义等价证明，不检测换一套措辞的重述，不进入 Quality Gate，
 * 不自动删改任何正文；输出只用来定位候选和统计，最终判断仍需人工阅读。
 * 同一机制的"必要承接"也会被命中——这是设计使然：工具报告位置，人判断必要性。
 */

export interface RedundancySectionInput {
  id: string;
  title?: string;
  latex: string;
}

export interface RedundancySentence {
  section: string;
  /** 句子在本节剥离后的序号（0 起） */
  index: number;
  text: string;
  chars: number;
}

export interface RedundantPair {
  /** 大纲顺序靠后的句子（候选复述） */
  later: RedundancySentence;
  /** 大纲顺序靠前的句子（候选原始展开） */
  earlier: RedundancySentence;
  /** shared / min(|A|, |B|) */
  containment: number;
  /** shared / |A ∪ B| */
  jaccard: number;
  shared: number;
}

export interface LimitationSentence {
  section: string;
  text: string;
}

export interface CrossSectionRedundancyOptions {
  /** 低于此字符数的句子不参与比较（默认 12） */
  minSentenceChars?: number;
  /** 共享 token 数下限（默认 6） */
  minShared?: number;
  /** 包含度下限（默认 0.5） */
  minContainment?: number;
  /** Jaccard 下限（默认 0.2） */
  minJaccard?: number;
}

export interface RedundancySectionStats {
  id: string;
  title?: string;
  sentences: number;
  chars: number;
  /** 本节中与任一前节句子构成 pair 的句子数（每句只计一次） */
  restatedSentences: number;
  restatedChars: number;
  limitationSentences: number;
}

export interface CrossSectionRedundancyReport {
  options: Required<CrossSectionRedundancyOptions>;
  sections: RedundancySectionStats[];
  pairs: RedundantPair[];
  limitationSentences: LimitationSentence[];
  summary: {
    sentenceCount: number;
    charCount: number;
    pairCount: number;
    restatedSentenceCount: number;
    /** restated 句字符数 / 全部句字符数（0–1） */
    restatedCharShare: number;
    sectionsWithRestatement: number;
    limitationSentenceCount: number;
    sectionsWithLimitation: number;
  };
}

const DEFAULT_OPTIONS: Required<CrossSectionRedundancyOptions> = {
  minSentenceChars: 12,
  minShared: 6,
  minContainment: 0.5,
  minJaccard: 0.2,
};

/** 纯功能字：任一侧落在此集合的 bigram 不参与相似度（避免"的是""并且"等虚词抬高重合） */
const FUNCTION_CHARS = new Set("的了是在与和及或并对将把被为以于其此这该等而则也都不之者从到由向所".split(""));

const CJK_RUN = /[㐀-鿿]+/g;
const LATIN_OR_NUMBER = /[A-Za-z][A-Za-z0-9\-]+|\d+(?:\.\d+)?/g;

/**
 * 科学限制 / 免责类句子的保守哨兵（中文）。只用于统计"限制声明分布在几节"，
 * 不判断是否必要——集中在局限性 / 结论处的声明是应当保留的。
 */
const LIMITATION_PATTERNS: RegExp[] = [
  /(无|没有|未|不)(进行|开展|包含|做|含|设)?(本文|独立|统一|额外|任何|新的|新)?(的)?(实验|复现|评测|验证|评估)/,
  /仅(有|基于|依据|限于|来自|采用|使用|为)?(两篇|三篇|四篇|五篇|所给|给定|摘要|有限|现有|公开)/,
  /(不能|无法|不足以|难以|不应)(给出|推出|排序|保证|证明|推断|断言|比较|外推|得出)/,
  /尚(缺|未|待|无)/,
  /有待(进一步)?(验证|评测|研究|复现)/,
  /未经(核验|验证|复现)/,
  /超出(本文|引文|摘要|证据)(的)?(范围|覆盖)/,
  // M13.7.9（冻结前补充；只影响限制句统计与分类层的 L 判定，不影响 pair / 复述占比）：
  // "不涉及本文自己的实验" / "未包括本文实验" / "本文未复现" / "不作横向排序" / "文献自述 / 作者自述" / "限于摘要"
  /(未|不|没有)(涉及|包括|包含|开展|进行|含有)(本文|本综述|我们)?(自己的|自身的|的)?(实验|复现|评测|实证)/,
  /(本文|本综述|我们|本节)(未|不|没有)[^。；，]{0,6}(实验|复现|评测|验证|排序|评估)/,
  /(不作|不做|不宜|不构成|不予)[^。；，]{0,10}(排序|排名|断言|比较|对比|确认|推断|外推)/,
  /(文献|作者|原文)(自述|自我报告|自身的陈述|自身报告)/,
  /(限于|局限于|依据的是|来自)[^。；，]{0,10}(摘要|公开摘要|文献自述)/,
];

export function stripLatexForRedundancy(latex: string): string {
  let text = latex.replace(/\r\n/g, "\n");
  // M13.7.8：转义百分号 `\%`（如 `76.5\%`）是正文字符，不是注释起点；先换成占位符，
  // 注释剥离之后再还原为 %，否则该句之后的整段正文会被当作注释删掉（held-out 实测两臂各丢两段）。
  const ESCAPED_PERCENT = "\u0001";
  text = text.replace(/\\%/g, ESCAPED_PERCENT);
  // 节标题 / 标签 / 引用标注：不是正文论述
  text = text.replace(/\\(?:sub)*section\*?\{[^{}]*\}/g, "\n");
  text = text.replace(/\\(?:label|ref|eqref|pageref|autoref|cref)\{[^{}]*\}/g, " ");
  text = text.replace(/\\(?:cite|citep|citet|citealp|parencite|textcite|autocite)\*?(?:\[[^\]\n]*\])*\{[^{}]*\}/g, " ");
  text = text.replace(/\\begin\{[^{}]*\}|\\end\{[^{}]*\}/g, "\n");
  // 数学：整体视为一个占位符
  text = text.replace(/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$[^$\n]*\$/g, " ");
  // \cmd[opt]{inner} → inner（最多三层嵌套）
  for (let i = 0; i < 3; i += 1) {
    text = text.replace(/\\[A-Za-z]+\*?(?:\[[^\]\n]*\])?\{([^{}]*)\}/g, "$1");
  }
  text = text.replace(/\\[A-Za-z]+\*?/g, " ");
  text = text.replace(/[{}~]/g, " ");
  text = text.replace(/%[^\n]*/g, " ");
  text = text.replace(/\u0001/g, "%");
  return text;
}

export function splitRedundancySentences(text: string): string[] {
  return text
    .split(/(?<=[。！？；!?;])|\n+/)
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter((sentence) => sentence !== "");
}

function countChars(sentence: string): number {
  return sentence.replace(/[\s。！？；，、：“”‘’（）()\[\]【】《》.,:;!?"'-]/g, "").length;
}

export function tokenizeForRedundancy(sentence: string): Set<string> {
  const tokens = new Set<string>();
  for (const run of sentence.match(CJK_RUN) ?? []) {
    if (run.length === 1) {
      if (!FUNCTION_CHARS.has(run)) {
        tokens.add(run);
      }
      continue;
    }
    for (let i = 0; i + 1 < run.length; i += 1) {
      const a = run[i] ?? "";
      const b = run[i + 1] ?? "";
      if (FUNCTION_CHARS.has(a) || FUNCTION_CHARS.has(b)) {
        continue;
      }
      tokens.add(a + b);
    }
  }
  for (const token of sentence.match(LATIN_OR_NUMBER) ?? []) {
    tokens.add(token.toLowerCase());
  }
  return tokens;
}

function sharedCount(a: ReadonlySet<string>, b: ReadonlySet<string>): number {
  let shared = 0;
  const [small, large] = a.size <= b.size ? [a, b] : [b, a];
  for (const token of small) {
    if (large.has(token)) {
      shared += 1;
    }
  }
  return shared;
}

export function isLimitationSentence(sentence: string): boolean {
  return LIMITATION_PATTERNS.some((pattern) => pattern.test(sentence));
}

interface IndexedSentence extends RedundancySentence {
  order: number;
  tokens: Set<string>;
}

/**
 * 跨章节复述分析。sections 必须按大纲顺序传入：pair 的 earlier 总是顺序靠前的
 * 一节，这样"谁是原始展开、谁是复述"由大纲顺序决定而不是由模型判断。
 */
export function analyzeCrossSectionRedundancy(
  sections: readonly RedundancySectionInput[],
  options: CrossSectionRedundancyOptions = {},
): CrossSectionRedundancyReport {
  const resolved: Required<CrossSectionRedundancyOptions> = { ...DEFAULT_OPTIONS, ...options };
  const indexed: IndexedSentence[] = [];
  const stats: RedundancySectionStats[] = [];
  const limitationSentences: LimitationSentence[] = [];

  sections.forEach((section, order) => {
    const sentences = splitRedundancySentences(stripLatexForRedundancy(section.latex));
    let chars = 0;
    let limitation = 0;
    sentences.forEach((text, index) => {
      const count = countChars(text);
      chars += count;
      if (isLimitationSentence(text)) {
        limitation += 1;
        limitationSentences.push({ section: section.id, text });
      }
      if (count < resolved.minSentenceChars) {
        return;
      }
      indexed.push({ section: section.id, index, text, chars: count, order, tokens: tokenizeForRedundancy(text) });
    });
    stats.push({
      id: section.id,
      ...(section.title !== undefined ? { title: section.title } : {}),
      sentences: sentences.length,
      chars,
      restatedSentences: 0,
      restatedChars: 0,
      limitationSentences: limitation,
    });
  });

  const pairs: RedundantPair[] = [];
  const restated = new Set<IndexedSentence>();
  for (const later of indexed) {
    for (const earlier of indexed) {
      if (earlier.order >= later.order) {
        continue;
      }
      const shared = sharedCount(later.tokens, earlier.tokens);
      if (shared < resolved.minShared) {
        continue;
      }
      const minSize = Math.min(later.tokens.size, earlier.tokens.size);
      const union = later.tokens.size + earlier.tokens.size - shared;
      const containment = minSize === 0 ? 0 : shared / minSize;
      const jaccard = union === 0 ? 0 : shared / union;
      if (containment < resolved.minContainment || jaccard < resolved.minJaccard) {
        continue;
      }
      pairs.push({
        later: toSentence(later),
        earlier: toSentence(earlier),
        containment: round(containment),
        jaccard: round(jaccard),
        shared,
      });
      restated.add(later);
    }
  }
  pairs.sort((a, b) => b.containment - a.containment || b.jaccard - a.jaccard || a.later.section.localeCompare(b.later.section));

  for (const sentence of restated) {
    const entry = stats[sentence.order];
    if (entry !== undefined) {
      entry.restatedSentences += 1;
      entry.restatedChars += sentence.chars;
    }
  }

  const charCount = stats.reduce((sum, entry) => sum + entry.chars, 0);
  const restatedChars = stats.reduce((sum, entry) => sum + entry.restatedChars, 0);
  return {
    options: resolved,
    sections: stats,
    pairs,
    limitationSentences,
    summary: {
      sentenceCount: stats.reduce((sum, entry) => sum + entry.sentences, 0),
      charCount,
      pairCount: pairs.length,
      restatedSentenceCount: restated.size,
      restatedCharShare: charCount === 0 ? 0 : round(restatedChars / charCount),
      sectionsWithRestatement: stats.filter((entry) => entry.restatedSentences > 0).length,
      limitationSentenceCount: limitationSentences.length,
      sectionsWithLimitation: stats.filter((entry) => entry.limitationSentences > 0).length,
    },
  };
}

function toSentence(sentence: IndexedSentence): RedundancySentence {
  return { section: sentence.section, index: sentence.index, text: sentence.text, chars: sentence.chars };
}

function round(value: number): number {
  return Math.round(value * 1000) / 1000;
}
