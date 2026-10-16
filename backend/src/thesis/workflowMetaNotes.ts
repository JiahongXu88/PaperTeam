/**
 * M14.5 — 工作流元注记泄漏检测与剥离（确定性、保守）。
 *
 * 真实缺陷（案例 B）：正文出现「依据本章的科研事实纪律」；其它已知泄漏形态：
 * 「根据当前 Workflow」「系统已完成本阶段」「需要用户确认后继续」「Agent 将进一步
 * 处理」「按照提示词要求」「本轮检索」「待作者确认」等。
 *
 * 两级置信度：
 *   high   —— 工作流/提示词词汇，正文中不可能是合法学术表述。满足安全条件
 *             （整句 ≤ 120 字、不含带单位数值、不含 \cite/\ref）时整句剥离，
 *             否则保留并上报；
 *   medium —— 「尚未核验」「待补实验」「内部记录」「授权范围」等可能是合法表述，
 *             只上报不剥离。
 *
 * 防误报：「系统」「模型」是合法计算机术语，单独出现一律不命中（见测试）。
 * 跳过 LaTeX 注释行、\begin{table}…\end{table} 块、\label/\ref/\cite 参数。
 */

export interface MetaNoteHit {
  sentence: string;
  /** 命中的模式（正则源码） */
  pattern: string;
  /** 句子在原文中的偏移 */
  offset: number;
  confidence: "high" | "medium";
}

const HIGH_PATTERNS: RegExp[] = [
  /根据当前\s*Workflow/i,
  /按(照)?(当前)?(提示词|prompt)要求/i,
  /系统已完成本阶段/,
  /需要用户确认后继续/,
  /Agent\s*将(进一步)?处理/i,
  /科研事实纪律/,
  /写作纪律/,
  /依据本章的[^。！？!?；;\n]{0,20}纪律/,
  /本轮(检索|审稿|修订)/,
  /【(修订说明|决策点|待作者确认|执行报告|执行注记|修订注记)】/,
  /%%%PT-OUTCOMES%%%/,
  /(作者|用户)(尚)?未确认(的)?(事实|数值)/,
  /(待作者确认|待作者授权|待作者裁决)/,
  /PaperTeam/,
];

const MEDIUM_PATTERNS: RegExp[] = [/尚未核验/, /待补实验/, /内部(记录|状态)/, /授权范围/];

/** 带单位的数值（剥离安全条件之一：含此类事实的句子不整句剥离） */
const NUMBER_WITH_UNIT =
  /\d+(?:\.\d+)?\s*(?:%|％|‰|[A-Za-zμ°]{1,4}(?![A-Za-z])|个|次|倍|张|帧|组|秒|毫秒|分钟|小时|天|年|篇|项|层|维|位|度|米|厘米|毫米|千克|克|牛|像素|节点|样本|轮)/;

const TABLE_BEGIN = /\\begin\{(?:table\*?|tabular\*?|longtable|tabularx)\}/;
const TABLE_END = /\\end\{(?:table\*?|tabular\*?|longtable|tabularx)\}/;

/** 句子切分（保留终止符；按 。！？!?；; 切分） */
const SENTENCE_SEGMENT = /[^。！？!?；;]*[。！？!?；;]+|[^。！？!?；;]+$/g;

/** 屏蔽 \label/\ref/\cite 参数，避免 key 文本误命中 */
function maskLatexArguments(sentence: string): string {
  return sentence.replace(/\\(label|ref|eqref|autoref|pageref|cite[A-Za-z]*)\s*(?:\[[^\]]*\])?\{[^}]*\}/g, "\\$1{}");
}

function containsCitationOrReference(sentence: string): boolean {
  return /\\(?:cite[A-Za-z]*|ref|eqref|autoref)\s*\{/.test(sentence);
}

interface SentenceSpan {
  text: string;
  offset: number;
}

interface LineScan {
  offset: number;
  raw: string;
  skipped: boolean;
  sentences: SentenceSpan[];
}

function scanLines(text: string): LineScan[] {
  const lines = text.split("\n");
  const result: LineScan[] = [];
  let offset = 0;
  let inTable = false;
  for (const raw of lines) {
    const trimmed = raw.trim();
    let skipped = false;
    if (TABLE_BEGIN.test(raw)) inTable = true;
    if (inTable) {
      skipped = true;
      if (TABLE_END.test(raw)) inTable = false;
    } else if (trimmed.startsWith("%") && !/%%%PT-OUTCOMES%%%/.test(trimmed)) {
      // 注释行跳过；但 %%%PT-OUTCOMES%%% 执行报告标记本身以 % 开头，必须参与检测
      skipped = true;
    }
    const sentences: SentenceSpan[] = [];
    if (!skipped) {
      for (const match of raw.matchAll(SENTENCE_SEGMENT)) {
        if (match[0].trim() === "") continue;
        sentences.push({ text: match[0], offset: offset + match.index });
      }
    }
    result.push({ offset, raw, skipped, sentences });
    offset += raw.length + 1;
  }
  return result;
}

interface Classified {
  hit: MetaNoteHit;
  strippable: boolean;
}

function classify(span: SentenceSpan): Classified | undefined {
  const masked = maskLatexArguments(span.text);
  for (const pattern of HIGH_PATTERNS) {
    if (!pattern.test(masked)) continue;
    const sentence = span.text.trim();
    const safe =
      [...sentence].length <= 120 && !NUMBER_WITH_UNIT.test(masked) && !containsCitationOrReference(span.text);
    return {
      hit: { sentence, pattern: pattern.source, offset: span.offset, confidence: "high" },
      strippable: safe,
    };
  }
  for (const pattern of MEDIUM_PATTERNS) {
    if (!pattern.test(masked)) continue;
    return {
      hit: { sentence: span.text.trim(), pattern: pattern.source, offset: span.offset, confidence: "medium" },
      strippable: false,
    };
  }
  return undefined;
}

/** 检测全部工作流元注记（high + medium），不改动文本 */
export function detectWorkflowMetaNotes(text: string): MetaNoteHit[] {
  const hits: MetaNoteHit[] = [];
  for (const line of scanLines(text)) {
    for (const span of line.sentences) {
      const classified = classify(span);
      if (classified !== undefined) hits.push(classified.hit);
    }
  }
  return hits;
}

/**
 * 剥离 high 置信度且满足安全条件的整句；保留段落结构（句子删除后压缩多余空格，
 * 行变空则删除该行；连续空行折叠为一个段落分隔）。
 */
export function stripWorkflowMetaNotes(text: string): { text: string; removed: MetaNoteHit[]; kept: MetaNoteHit[] } {
  const removed: MetaNoteHit[] = [];
  const kept: MetaNoteHit[] = [];
  const outputLines: Array<string | null> = [];
  for (const line of scanLines(text)) {
    if (line.skipped || line.sentences.length === 0) {
      outputLines.push(line.raw);
      continue;
    }
    let changed = false;
    const pieces: string[] = [];
    for (const span of line.sentences) {
      const classified = classify(span);
      if (classified === undefined) {
        pieces.push(span.text);
        continue;
      }
      if (classified.strippable) {
        removed.push(classified.hit);
        changed = true;
      } else {
        kept.push(classified.hit);
        pieces.push(span.text);
      }
    }
    if (!changed) {
      outputLines.push(line.raw);
      continue;
    }
    const rebuilt = pieces.join("").replace(/ {2,}/g, " ").replace(/[ \t]+$/, "");
    outputLines.push(rebuilt.trim() === "" ? null : rebuilt);
  }
  const joined = outputLines.filter((line): line is string => line !== null).join("\n");
  return { text: joined.replace(/\n{3,}/g, "\n\n"), removed, kept };
}
