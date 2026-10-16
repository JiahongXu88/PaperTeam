/**
 * M14.5 — 章节引用规范化（确定性、保守）。
 *
 * 真实缺陷（案例 B 42 页学位论文草稿）：绪论「论文结构安排」写成「第四章为实验
 * 验证」，而实际结构中实验章是第五章——Writer 只看见本章计划，猜测了编号。
 *
 * 治理分三层：
 *   1. 提示层：renderChapterOrderLines 给 Writer 完整章序 + 规则（跨章引用写
 *      `第\ref{ch:<id>}章` 或章标题，禁止字面序号）；
 *   2. 装配层：chapterLabelLatex 在每个 \chapter{} 后发射 \label{ch:<id>}，
 *      真实编号由 LaTeX 解析；
 *   3. 修复层：normalizeChapterReferences 把正文里残留的字面「第 N 章」按
 *      邻近章标题改写为 \ref；标题是权威依据，序号不可信（默认不按序号改写）。
 *
 * 不触碰 \chapter{} 标题、\label/\ref/\cite 参数、数学与注释；幂等。
 */

import type { ThesisChapterPlan } from "./thesisWorkflowTypes.js";

/** 章 label：`ch:` + chapterId（只保留 [A-Za-z0-9:_-]，其余替换为 `-`） */
export function chapterLabel(chapterId: string): string {
  const sanitized = chapterId.replace(/[^A-Za-z0-9:_-]/g, "-");
  return `ch:${sanitized}`;
}

/** 装配器在 \chapter{...} 之后发射的 \label 片段 */
export function chapterLabelLatex(chapterId: string): string {
  return `\\label{${chapterLabel(chapterId)}}`;
}

export interface ChapterOrderEntry {
  chapterId: string;
  /** 1 起的章序号（由大纲顺序决定） */
  ordinal: number;
  titleZh: string;
  label: string;
}

export function chapterOrder(
  chapters: ReadonlyArray<Pick<ThesisChapterPlan, "chapterId" | "titleZh">>,
): ChapterOrderEntry[] {
  return chapters.map((chapter, index) => ({
    chapterId: chapter.chapterId,
    ordinal: index + 1,
    titleZh: chapter.titleZh,
    label: chapterLabel(chapter.chapterId),
  }));
}

/** Writer 提示词中的章序与跨章引用规则（中文指令行） */
export function renderChapterOrderLines(
  chapters: ReadonlyArray<Pick<ThesisChapterPlan, "chapterId" | "titleZh">>,
  currentChapterId: string,
): string[] {
  const order = chapterOrder(chapters);
  const lines: string[] = [];
  lines.push("【全文章节顺序】（由大纲确定；章编号在编译时由装配器解析，不要自行推算）");
  for (const entry of order) {
    const marker = entry.chapterId === currentChapterId ? "　←本章" : "";
    lines.push(`第${entry.ordinal}章 ${entry.titleZh}（\\ref{${entry.label}}）${marker}`);
  }
  const example = order.find((entry) => entry.chapterId !== currentChapterId) ?? order[0];
  const exampleLabel = example?.label ?? "ch:ch05";
  lines.push(
    `【跨章引用规则】提及其他章时只允许两种写法：（1）\`第\\ref{ch:<chapterId>}章\`（例：第\\ref{${exampleLabel}}章）；（2）直接写该章标题（如「${example?.titleZh ?? "实验章"}」）。禁止手写字面序号（「第四章」「第 4 章」等），真实编号由装配器解析——你看到的只是本章计划，猜测编号会出错。`,
  );
  lines.push(
    "【论文结构安排 / 论文组织段落】须严格按上面给出的顺序逐章列举，每章用 `第\\ref{ch:<chapterId>}章` 引用并一句话概述该章内容；不得遗漏、合并或调换章次。",
  );
  return lines;
}

export interface ChapterReferenceRewrite {
  before: string;
  after: string;
  chapterId: string;
  /** 在原文中的偏移 */
  offset: number;
}

export interface ChapterReferenceIssue {
  literal: string;
  ordinal: number;
  offset: number;
  reason: "ordinal_out_of_range" | "ordinal_title_mismatch" | "unresolved";
  nearbyTitle?: string;
  expectedChapterId?: string;
}

export interface LiteralChapterReference {
  literal: string;
  ordinal: number;
  offset: number;
}

/** 字面章序号：第一章 / 第 4 章 / 第十二章（中文数字 ≤ 20，阿拉伯数字 ≤ 2 位） */
const LITERAL_PATTERN = /第\s*((?:[一二三四五六七八九两]?十[一二三四五六七八九]?)|[一二三四五六七八九〇零两]|\d{1,2})\s*章/g;

const CN_DIGITS: Record<string, number> = {
  "〇": 0,
  "零": 0,
  "一": 1,
  "二": 2,
  "两": 2,
  "三": 3,
  "四": 4,
  "五": 5,
  "六": 6,
  "七": 7,
  "八": 8,
  "九": 9,
};

/** 解析序号（阿拉伯数字或中文数字；不可解析返回 undefined） */
export function parseChapterOrdinal(raw: string): number | undefined {
  const text = raw.trim();
  if (/^\d+$/.test(text)) return Number(text);
  const chars = [...text];
  if (chars.length === 1) {
    const only = chars[0]!;
    if (only === "十") return 10;
    return CN_DIGITS[only];
  }
  if (chars.length === 2) {
    const [first, second] = chars as [string, string];
    if (first === "十") {
      const unit = CN_DIGITS[second];
      return unit === undefined ? undefined : 10 + unit;
    }
    if (second === "十") {
      const tens = CN_DIGITS[first];
      return tens === undefined ? undefined : tens * 10;
    }
    return undefined;
  }
  if (chars.length === 3 && chars[1] === "十") {
    const tens = CN_DIGITS[chars[0]!];
    const unit = CN_DIGITS[chars[2]!];
    if (tens === undefined || unit === undefined) return undefined;
    return tens * 10 + unit;
  }
  return undefined;
}

interface Range {
  start: number;
  end: number;
}

/** 受保护区间：\ref/\label/\cite/\chapter 等命令参数、数学、注释 */
function protectedRanges(latex: string): Range[] {
  const ranges: Range[] = [];
  const patterns: RegExp[] = [
    /\\(?:ref|eqref|autoref|pageref|nameref|label|cite[A-Za-z]*|chapter\*?|hyperref|url|href|input|include|includegraphics)\s*(?:\[[^\]]*\])?\{[^}]*\}/g,
    /\$\$[\s\S]*?\$\$/g,
    /\$[^$\n]*\$/g,
    /\\\([\s\S]*?\\\)/g,
    /\\\[[\s\S]*?\\\]/g,
    /\\begin\{(equation|align|gather|multline|eqnarray|math|displaymath)\*?\}[\s\S]*?\\end\{\1\*?\}/g,
    /(?<!\\)%[^\n]*/g,
  ];
  for (const pattern of patterns) {
    for (const match of latex.matchAll(pattern)) {
      ranges.push({ start: match.index, end: match.index + match[0].length });
    }
  }
  return ranges;
}

function inRanges(ranges: Range[], start: number, end: number): boolean {
  return ranges.some((range) => start < range.end && end > range.start);
}

/** 正文中（受保护区间之外）的全部字面章序号 */
export function detectLiteralChapterReferences(latex: string): LiteralChapterReference[] {
  const ranges = protectedRanges(latex);
  const result: LiteralChapterReference[] = [];
  for (const match of latex.matchAll(LITERAL_PATTERN)) {
    const literal = match[0];
    const start = match.index;
    if (inRanges(ranges, start, start + literal.length)) continue;
    const ordinal = parseChapterOrdinal(match[1]!);
    if (ordinal === undefined) continue;
    result.push({ literal, ordinal, offset: start });
  }
  return result;
}

const CJK = /[一-鿿]/;
/** 标题中不具区分度的通用二元组（不参与第三层关键词匹配） */
const GENERIC_BIGRAMS = new Set([
  "研究",
  "设计",
  "分析",
  "方法",
  "理论",
  "系统",
  "模型",
  "实现",
  "结果",
  "总结",
  "相关",
  "现状",
  "基于",
  "本文",
  "问题",
  "技术",
  "应用",
  "概述",
  "介绍",
  "背景",
  "工作",
  "内容",
  "讨论",
  "验证",
  "综述",
  "及其",
  "与分",
]);

function compact(text: string): string {
  return text.replace(/\s+/g, "");
}

/** 去除连接词/通用后缀后的简化标题（「下洗数据采集与神经网络预测器设计」→「下洗数据采集神经网络预测器」） */
function simplifiedTitle(title: string): string {
  return compact(title).replace(/研究|设计|分析|与|及|和|、|基于|的/g, "");
}

function cjkBigrams(text: string): string[] {
  const chars = [...text];
  const result: string[] = [];
  for (let index = 0; index + 1 < chars.length; index += 1) {
    const first = chars[index]!;
    const second = chars[index + 1]!;
    if (CJK.test(first) && CJK.test(second)) result.push(first + second);
  }
  return result;
}

/** 每章独有的（且非通用的）标题二元组 */
function distinctiveBigrams(chapters: ChapterOrderEntry[]): Map<string, Set<string>> {
  const owners = new Map<string, Set<string>>();
  for (const chapter of chapters) {
    for (const bigram of new Set(cjkBigrams(chapter.titleZh))) {
      if (GENERIC_BIGRAMS.has(bigram)) continue;
      const set = owners.get(bigram) ?? new Set<string>();
      set.add(chapter.chapterId);
      owners.set(bigram, set);
    }
  }
  const result = new Map<string, Set<string>>();
  for (const chapter of chapters) {
    const set = new Set<string>();
    for (const bigram of new Set(cjkBigrams(chapter.titleZh))) {
      if (owners.get(bigram)?.size === 1) set.add(bigram);
    }
    result.set(chapter.chapterId, set);
  }
  return result;
}

interface TitleMatch {
  chapter?: ChapterOrderEntry;
  ambiguous: boolean;
  /** 命中层级：1 完整标题 / 2 标题前缀 / 3 独有二元组（弱证据） */
  tier?: 1 | 2 | 3;
}

/**
 * 三层标题匹配（上一层无命中才进入下一层；某层命中 >1 章即判为歧义、停止）：
 *   1. 完整标题出现在窗口中；
 *   2. 标题前 4 字 / 简化标题 / 简化标题前 4 字出现在窗口中；
 *   3. 窗口中出现该章独有的标题二元组（如「实验」只属于实验章）。
 */
function matchTitle(window: string, chapters: ChapterOrderEntry[], bigramIndex: Map<string, Set<string>>): TitleMatch {
  const haystack = compact(window);
  if (haystack === "") return { ambiguous: false };
  const decide = (hits: ChapterOrderEntry[], tier: 1 | 2 | 3): TitleMatch | undefined => {
    if (hits.length === 1) return { chapter: hits[0], ambiguous: false, tier };
    if (hits.length > 1) return { ambiguous: true, tier };
    return undefined;
  };

  const tier1 = chapters.filter((chapter) => {
    const title = compact(chapter.titleZh);
    return title.length >= 2 && haystack.includes(title);
  });
  const decided1 = decide(tier1, 1);
  if (decided1 !== undefined) return decided1;

  const tier2 = chapters.filter((chapter) => {
    const title = compact(chapter.titleZh);
    const simplified = simplifiedTitle(chapter.titleZh);
    const candidates = new Set<string>();
    if ([...title].length >= 4) candidates.add([...title].slice(0, 4).join(""));
    if ([...simplified].length >= 3 && simplified !== title) candidates.add(simplified);
    if ([...simplified].length >= 4) candidates.add([...simplified].slice(0, 4).join(""));
    return [...candidates].some((candidate) => haystack.includes(candidate));
  });
  const decided2 = decide(tier2, 2);
  if (decided2 !== undefined) return decided2;

  const windowBigrams = new Set(cjkBigrams(haystack));
  const tier3 = chapters.filter((chapter) => {
    const own = bigramIndex.get(chapter.chapterId);
    if (own === undefined) return false;
    for (const bigram of windowBigrams) if (own.has(bigram)) return true;
    return false;
  });
  const decided3 = decide(tier3, 3);
  if (decided3 !== undefined) return decided3;
  return { ambiguous: false };
}

/** 字面序号之后、同一句内、≤ 40 字、到下一个字面序号为止的窗口 */
function followingWindow(latex: string, from: number): string {
  const slice = latex.slice(from, from + 40);
  const stop = slice.search(/[。！？；\n]/);
  const cut = stop === -1 ? slice : slice.slice(0, stop);
  const next = cut.search(/第\s*(?:[一二三四五六七八九两]?十[一二三四五六七八九]?|[一二三四五六七八九〇零两]|\d{1,2})\s*章/);
  return next === -1 ? cut : cut.slice(0, next);
}

export function normalizeChapterReferences(
  latex: string,
  chapters: ChapterOrderEntry[],
  options?: { currentChapterId?: string; trustOrdinal?: boolean },
): { latex: string; rewrites: ChapterReferenceRewrite[]; issues: ChapterReferenceIssue[] } {
  const trustOrdinal = options?.trustOrdinal === true;
  // currentChapterId 预留给调用方做诊断分组；规范化本身只以标题为权威依据。
  void options?.currentChapterId;
  const rewrites: ChapterReferenceRewrite[] = [];
  const issues: ChapterReferenceIssue[] = [];
  if (chapters.length === 0) return { latex, rewrites, issues };

  const bigramIndex = distinctiveBigrams(chapters);
  const byOrdinal = new Map<number, ChapterOrderEntry>();
  for (const chapter of chapters) byOrdinal.set(chapter.ordinal, chapter);

  for (const literal of detectLiteralChapterReferences(latex)) {
    const end = literal.offset + literal.literal.length;
    const window = followingWindow(latex, end);
    const match = matchTitle(window, chapters, bigramIndex);
    const atOrdinal = byOrdinal.get(literal.ordinal);

    // M14.6 真实案例 B 实测：仅凭「独有二元组」（tier 3）且序号与标题不符的改写有误判风险
    //（「第一章…数据采集」被改到 ch03）——弱证据只能在序号与标题一致时确认；否则只报告不改写。
    if (match.chapter !== undefined && match.tier === 3 && match.chapter.ordinal !== literal.ordinal) {
      issues.push({
        literal: literal.literal,
        ordinal: literal.ordinal,
        offset: literal.offset,
        reason: "unresolved",
        nearbyTitle: match.chapter.titleZh,
        expectedChapterId: match.chapter.chapterId,
      });
      continue;
    }
    if (match.chapter !== undefined) {
      const target = match.chapter;
      rewrites.push({
        before: literal.literal,
        after: `第\\ref{${target.label}}章`,
        chapterId: target.chapterId,
        offset: literal.offset,
      });
      if (target.ordinal !== literal.ordinal) {
        issues.push({
          literal: literal.literal,
          ordinal: literal.ordinal,
          offset: literal.offset,
          reason: "ordinal_title_mismatch",
          nearbyTitle: target.titleZh,
          expectedChapterId: target.chapterId,
        });
      }
      continue;
    }

    if (atOrdinal === undefined) {
      issues.push({
        literal: literal.literal,
        ordinal: literal.ordinal,
        offset: literal.offset,
        reason: "ordinal_out_of_range",
      });
      continue;
    }

    if (trustOrdinal && !match.ambiguous) {
      rewrites.push({
        before: literal.literal,
        after: `第\\ref{${atOrdinal.label}}章`,
        chapterId: atOrdinal.chapterId,
        offset: literal.offset,
      });
      continue;
    }

    issues.push({
      literal: literal.literal,
      ordinal: literal.ordinal,
      offset: literal.offset,
      reason: "unresolved",
      expectedChapterId: atOrdinal.chapterId,
    });
  }

  if (rewrites.length === 0) return { latex, rewrites, issues };

  let output = "";
  let cursor = 0;
  for (const rewrite of rewrites) {
    output += latex.slice(cursor, rewrite.offset) + rewrite.after;
    cursor = rewrite.offset + rewrite.before.length;
  }
  output += latex.slice(cursor);
  return { latex: output, rewrites, issues };
}
