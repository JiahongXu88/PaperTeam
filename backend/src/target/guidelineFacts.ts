/**
 * Guideline 观测事实提取（M15.9 · Phase E G1）：manuscript .tex/.bib →
 * 官方投稿要求可核查的确定性观测点。
 *
 * 纪律（与 manuscriptStats 同构）：
 * - 零 LLM、零 IO 之外的状态；观测不到 → null（NOT_EVALUATED 的输入），
 *   绝不发明数值；
 * - 与 TargetGapService 的观测互不干扰（独立模块，不动 manuscriptStats 的
 *   既有语义——readiness 六维行为零变化）；
 * - 口径披露：题目字数 = CJK 字符数（中文刊"汉字"口径）；关键词以
 *   \keywords{}/关键词： 行解析；参考文献统计以 bib 条目为口径。
 */

import type { LatexProjectFiles } from "../manuscript/LatexFiles.js";
import { collectLatexFiles } from "../manuscript/LatexFiles.js";
import type { ProjectStore } from "../project/ProjectStore.js";

export interface GuidelineFacts {
  exists: boolean;
  /** \title{...} 原文（剥命令） */
  titleRaw: string | null;
  /** 题目汉字数（CJK）；纯英文题目为 0 */
  titleCjkChars: number | null;
  /** 题目英文实词数（仅当题目基本无汉字时报；否则 null） */
  titleEnWords: number | null;
  /** 关键词个数（\keywords{} 或 关键词： 行；分号/逗号分隔） */
  keywordCount: number | null;
  keywords: string[] | null;
  /** 摘要四要素结构化标记（目的/方法/结果/结论；abstract 环境内文本判定） */
  abstractStructured: { purpose: boolean; method: boolean; result: boolean; conclusion: boolean } | null;
  /** 摘要汉字数 */
  abstractCjkChars: number | null;
  /** 正文总字数（CJK + 拉丁词元；与 readiness 口径无关的粗计） */
  bodyCjkAndWordChars: number | null;
  /** 参考文献统计（bib 条目口径；无 bib/无年份可析 → 子字段如实缺省） */
  references: {
    entryCount: number;
    withYearCount: number | null;
    recent10yCount: number | null;
    /** 近 10 年占比（evalYear-9..evalYear）；无年份样本 → null */
    recent10yRatio: number | null;
    withDoiCount: number | null;
    doiCoverageRatio: number | null;
  } | null;
  /** bib 来源（file / thebibliography / null）——口径披露 */
  bibSource: "file" | "thebibliography" | null;
}

const CJK_CHAR = /[㐀-鿿豈-﫿぀-ヿ]/g;

export function countCjk(text: string): number {
  return (text.match(CJK_CHAR) ?? []).length;
}

/** \title{...}（跨文件首个；剥内层命令/空白） */
export function extractTitle(files: readonly { content: string }[]): string | null {
  for (const file of files) {
    const match = file.content.match(/\\title\{([\s\S]*?)\}/);
    if (match !== null) {
      return match[1]!.replace(/\\[A-Za-z@]+/g, " ").replace(/[{}]/g, " ").replace(/\s+/g, " ").trim();
    }
  }
  return null;
}

/** \keywords{a,b;c} / 关键词：a；b；c → 词表（trim/去空） */
export function extractKeywords(files: readonly { content: string }[]): string[] | null {
  for (const file of files) {
    const brace = file.content.match(/\\keywords?\{([\s\S]*?)\}/);
    let raw: string | undefined;
    if (brace !== null) {
      raw = brace[1];
    } else {
      const plain = file.content.match(/关键词[：:]\s*([^\n]{2,200})/);
      if (plain !== null) {
        raw = plain[1];
      }
    }
    if (raw !== undefined) {
      const items = raw
        .replace(/\\[A-Za-z@]+/g, " ")
        .split(/[，,；;、]/)
        .map((item) => item.replace(/[{}]/g, " ").trim())
        .filter((item) => item !== "");
      if (items.length > 0) {
        return items;
      }
    }
  }
  return null;
}

/** abstract 环境文本（首个命中文件） */
export function extractAbstractText(files: readonly { content: string }[]): string | null {
  for (const file of files) {
    const start = file.content.indexOf("\\begin{abstract}");
    if (start >= 0) {
      const end = file.content.indexOf("\\end{abstract}", start);
      const body = end > start ? file.content.slice(start + "\\begin{abstract}".length, end) : "";
      if (body.trim() !== "") {
        return body;
      }
    }
  }
  return null;
}

const ABSTRACT_MARKERS = [
  ["purpose", /目的\s*[）)】\]:：]/],
  ["method", /方法\s*[）)】\]:：]/],
  ["result", /结果\s*[）)】\]:：]/],
  ["conclusion", /结论\s*[）)】\]:：]/],
] as const;

export function abstractStructureOf(abstractText: string): GuidelineFacts["abstractStructured"] {
  // 归一常见小标题形态（\textbf{目的：} / 【目的】 / （目的） / 目的:）后判定
  const plain = abstractText
    .replace(/\\[A-Za-z@]+/g, " ")
    .replace(/[{}]/g, " ")
    .replace(/\s+/g, "");
  const entries = ABSTRACT_MARKERS.map(([key, pattern]) => [key, pattern.test(plain)] as const);
  return Object.fromEntries(entries) as GuidelineFacts["abstractStructured"];
}

export interface BibStats {
  entryCount: number;
  withYearCount: number | null;
  recent10yCount: number | null;
  recent10yRatio: number | null;
  withDoiCount: number | null;
  doiCoverageRatio: number | null;
}

/** bib 内容 → 条目统计（@type{key, 切分；year=/doi= 字段） */
export function bibStatsOf(bibContent: string, evalYear: number): BibStats {
  const entries = bibContent
    .split(/(?=@[A-Za-z]+\s*\{)/)
    .map((entry) => entry.trim())
    .filter((entry) => /^@[A-Za-z]+\s*\{[^,]+,/.test(entry));
  if (entries.length === 0) {
    return { entryCount: 0, withYearCount: null, recent10yCount: null, recent10yRatio: null, withDoiCount: null, doiCoverageRatio: null };
  }
  const years: number[] = [];
  const withDoi = entries.filter((entry) => /doi\s*=/i.test(entry)).length;
  for (const entry of entries) {
    const match = entry.match(/year\s*=\s*[{"]?(\d{4})/i);
    if (match !== null) {
      years.push(Number(match[1]));
    }
  }
  const recent = years.filter((year) => year >= evalYear - 9 && year <= evalYear).length;
  return {
    entryCount: entries.length,
    withYearCount: years.length > 0 ? years.length : null,
    recent10yCount: years.length > 0 ? recent : null,
    recent10yRatio: years.length > 0 ? Math.round((recent / years.length) * 100) / 100 : null,
    withDoiCount: withDoi,
    doiCoverageRatio: Math.round((withDoi / entries.length) * 100) / 100,
  };
}

/** 观测官方要求核查点（collectLatexFiles 单次遍历；evalYear 控制"近10年"窗口） */
export async function observeGuidelineFacts(
  projects: ProjectStore,
  projectId: string,
  options: { evalYear?: number } = {},
): Promise<GuidelineFacts> {
  const evalYear = options.evalYear ?? new Date().getFullYear();
  const files: LatexProjectFiles = await collectLatexFiles(projects.manuscriptDir(projectId));
  const empty: GuidelineFacts = {
    exists: false,
    titleRaw: null,
    titleCjkChars: null,
    titleEnWords: null,
    keywordCount: null,
    keywords: null,
    abstractStructured: null,
    abstractCjkChars: null,
    bodyCjkAndWordChars: null,
    references: null,
    bibSource: files.bibSource ?? null,
  };
  if (files.allTex.length === 0) {
    return empty;
  }
  const title = extractTitle(files.allTex);
  const titleCjk = title !== null ? countCjk(title) : null;
  const titleEnWords =
    title !== null && (titleCjk ?? 0) === 0
      ? (title.match(/[A-Za-z][A-Za-z'-]*/g) ?? []).filter((w) => !/^(a|an|the|of|for|and|in|on|with|to|by)$/i.test(w)).length
      : null;
  const keywords = extractKeywords(files.allTex);
  const abstractText = extractAbstractText(files.allTex);
  const abstractPlain = abstractText?.replace(/\\[A-Za-z@]+/g, " ").replace(/[{}]/g, " ") ?? null;
  const bodyText = files.allTex
    .map((file) => file.content)
    .join("\n")
    .replace(/(?<!\\)%[^\n]*/g, "")
    .replace(/\\(?:begin|end)\{[^}]*\}/g, " ")
    .replace(/\\[A-Za-z@]+\*?(?:\[[^\]\n]*\])?/g, " ")
    .replace(/[{}]/g, " ");
  const references = files.bibContent !== null ? bibStatsOf(files.bibContent, evalYear) : null;
  return {
    exists: true,
    titleRaw: title,
    titleCjkChars: titleCjk,
    titleEnWords,
    keywordCount: keywords !== null ? keywords.length : null,
    keywords,
    abstractStructured: abstractText !== null ? abstractStructureOf(abstractText) : null,
    abstractCjkChars: abstractPlain !== null ? countCjk(abstractPlain) : null,
    bodyCjkAndWordChars: countCjk(bodyText) + (bodyText.match(/[A-Za-z]{2,}/g) ?? []).length,
    references,
    bibSource: files.bibSource ?? null,
  };
}
