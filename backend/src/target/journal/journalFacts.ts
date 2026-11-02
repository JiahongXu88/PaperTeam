/**
 * Journal Assessment 稿件观测（零模型）：在 M15.9 GuidelineFacts 之上补充 profile 检查器需要的
 * 观测点（摘要引用 / 交叉引用、脚注、章节、语言、声明段落信号）。
 *
 * 口径：
 * - 只从 LaTeX 源码观测；PDF-only 稿件只继承 GuidelineFacts 的参考文献观测，其余为 null
 *   （上层如实 NOT_EVALUATED——PDF 上「未观测到」与「不存在」不可区分）；
 * - 声明类（数据可用性 / 伦理）只给「稿件内是否出现相关措辞」的信号，不是合规证明。
 */
import { collectLatexFiles } from "../../manuscript/LatexFiles.js";
import type { ProjectStore } from "../../project/ProjectStore.js";
import type { PaperDocument } from "../../paper/types.js";
import { countCjk, extractAbstractText, observeGuidelineFacts, type GuidelineFacts } from "../guidelineFacts.js";

export interface JournalFacts {
  guideline: GuidelineFacts;
  /** 稿件事实源保真度：latex = 全字段；pdf = 仅参考文献；none = 无 */
  fidelity: "latex" | "pdf" | "none";
  titleChars: number | null;
  abstractEnWords: number | null;
  abstractCitations: string[] | null;
  abstractCrossRefs: string[] | null;
  abstractResultHasNumber: boolean | null;
  footnoteCount: number | null;
  sectionTitles: string[] | null;
  /** 独立成行的纯文本 / \paragraph / \textbf 标题（PDF 重建稿常把章节标题渲染成普通行） */
  plainHeadingLines: string[] | null;
  hasAbstractEnv: boolean | null;
  hasBibliography: boolean | null;
  language: { value: "zh" | "en" | "mixed"; cjkChars: number; latinWords: number } | null;
  clcNumberPresent: boolean | null;
  dataAvailabilityMentioned: boolean | null;
  humanSubjectSignals: string[] | null;
  ethicsStatementSignals: string[] | null;
  figureCount: number | null;
  tableCount: number | null;
  /** 稿件内容指纹（.tex + bib；评估与修订转入的陈旧判据） */
  manuscriptFiles: Array<{ path: string; content: string }>;
}

const HUMAN_SUBJECT = /\b(human (?:subjects?|participants?)|participants?|patients?|volunteers?|informed consent)\b|受试者|志愿者|患者|被试/gi;
const ETHICS = /ethic(?:s|al)\s+(?:approval|committee|statement|review)|institutional review board|\bIRB\b|declaration of helsinki|伦理(?:委员会|审批|审查|批准)/gi;

export async function observeJournalFacts(
  projects: ProjectStore,
  projectId: string,
  options: { evalYear?: number; loadPaperDocument?: (projectId: string) => Promise<PaperDocument | null> } = {},
): Promise<JournalFacts> {
  const guideline = await observeGuidelineFacts(projects, projectId, options);
  const files = await collectLatexFiles(projects.manuscriptDir(projectId));
  const manuscriptFiles = [
    ...files.allTex.map((file) => ({ path: file.relativePath, content: file.content })),
    ...(files.bibContent !== null && files.bibContent !== undefined ? [{ path: "(bibliography)", content: files.bibContent }] : []),
  ].sort((a, b) => a.path.localeCompare(b.path));
  const empty: JournalFacts = {
    guideline,
    fidelity: guideline.source === "pdf" ? "pdf" : "none",
    titleChars: null,
    abstractEnWords: null,
    abstractCitations: null,
    abstractCrossRefs: null,
    abstractResultHasNumber: null,
    footnoteCount: null,
    sectionTitles: null,
    plainHeadingLines: null,
    hasAbstractEnv: null,
    hasBibliography: null,
    language: null,
    clcNumberPresent: null,
    dataAvailabilityMentioned: null,
    humanSubjectSignals: null,
    ethicsStatementSignals: null,
    figureCount: null,
    tableCount: null,
    manuscriptFiles,
  };
  if (files.allTex.length === 0) return empty;

  const source = files.allTex.map((file) => file.content.replace(/(?<!\\)%[^\n]*/g, "")).join("\n");
  const abstract = extractAbstractText(files.allTex.map((file) => ({ content: file.content.replace(/(?<!\\)%[^\n]*/g, "") })));
  const abstractPlain = abstract !== null ? stripLatex(abstract) : null;
  const body = stripLatex(source);
  const cjk = countCjk(body);
  const latinWords = (body.match(/[A-Za-z]{2,}/g) ?? []).length;
  // CJK 字符与拉丁词元按 1:1 计（中文稿 CJK 远多于英文术语词元）
  const total = cjk + latinWords;
  const language: JournalFacts["language"] =
    total === 0 ? null : { value: cjk / total >= 0.5 ? "zh" : cjk / total <= 0.05 ? "en" : "mixed", cjkChars: cjk, latinWords };
  const sectionTitles = [...source.matchAll(/\\(?:section|chapter)\*?\s*(?:\[[^\]]*\])?\s*\{([^{}]*(?:\{[^{}]*\}[^{}]*)*)\}/g)].map((match) =>
    stripLatex(match[1]!).trim(),
  );
  const title = guideline.titleRaw;
  return {
    ...empty,
    fidelity: "latex",
    titleChars: title !== null ? [...title].length : null,
    abstractEnWords: abstractPlain !== null ? (abstractPlain.match(/[A-Za-z][A-Za-z'-]*|\d+(?:\.\d+)?/g) ?? []).length : null,
    abstractCitations: abstract !== null ? [...abstract.matchAll(/\\(?:cite|citep|citet|parencite|textcite|autocite)\w*\*?(?:\[[^\]]*\])*\{[^}]*\}|\[\d+(?:\s*[,–-]\s*\d+)*\]/g)].map((m) => m[0]) : null,
    abstractCrossRefs:
      abstract !== null
        ? [...abstract.matchAll(/\\(?:ref|eqref|autoref|cref|Cref)\{[^}]*\}|[图表式]\s*[（(]?\d+[）)]?|(?:Fig\.?|Figure|Table|Eq\.?)\s*\d+|第\s*\d+\s*[节章]/g)].map((m) => m[0])
        : null,
    abstractResultHasNumber: abstract !== null ? resultSegmentHasNumber(abstract) : null,
    footnoteCount: (source.match(/\\footnote(?:text)?\s*[[{]/g) ?? []).length,
    sectionTitles,
    plainHeadingLines: plainHeadingLinesOf(source),
    hasAbstractEnv: /\\begin\{abstract\}/.test(source),
    hasBibliography: /\\bibliography\{|\\begin\{thebibliography\}|\\printbibliography/.test(source) || files.bibContent !== null,
    language,
    clcNumberPresent: /中图(?:法)?分类号|\\(?:clc|CLC|zhongtu)\w*\{/.test(source),
    dataAvailabilityMentioned: /data availability|availability of data|数据可用性|数据获取方式/i.test(body),
    humanSubjectSignals: unique(body.match(HUMAN_SUBJECT) ?? []),
    ethicsStatementSignals: unique(body.match(ETHICS) ?? []),
    figureCount: (source.match(/\\begin\{figure\*?\}/g) ?? []).length,
    tableCount: (source.match(/\\begin\{table\*?\}/g) ?? []).length,
  };
}

/** 独立成行的短标题行：「Acknowledgements」「5 Results」「\paragraph{Acknowledgments}」「\textbf{References}」 */
function plainHeadingLinesOf(source: string): string[] {
  const lines: string[] = [];
  for (const raw of source.split(/\r?\n/)) {
    const line = raw.trim();
    const wrapped = line.match(/^\\(?:paragraph|subsubsection|textbf)\*?\{([^{}]{3,60})\}\.?$/);
    const candidate = wrapped !== null ? wrapped[1]! : line;
    if (/^(?:\d+(?:\.\d+)*\.?\s+)?[A-Za-z][A-Za-z &\-]{2,58}$/.test(candidate)) lines.push(candidate.replace(/^[\d.\s]+/, "").trim());
  }
  return lines;
}

export function stripLatex(text: string): string {
  return text
    .replace(/\\(?:begin|end)\{[^}]*\}/g, " ")
    .replace(/\\[A-Za-z@]+\*?(?:\[[^\]\n]*\])?/g, " ")
    .replace(/[{}~]/g, " ")
    .replace(/\s+/g, " ");
}

/** 摘要「结果」小标题段内是否含数字（未识别结果小标题 → null） */
function resultSegmentHasNumber(abstract: string): boolean | null {
  const plain = stripLatex(abstract).replace(/\s+/g, "");
  const start = plain.search(/结果[）)】\]:：]/);
  if (start < 0) return null;
  const rest = plain.slice(start + 3);
  const end = rest.search(/结论[）)】\]:：]/);
  const segment = end >= 0 ? rest.slice(0, end) : rest;
  return /\d/.test(segment);
}

function unique(values: string[]): string[] {
  return [...new Set(values.map((value) => value.toLowerCase()))].slice(0, 8);
}
