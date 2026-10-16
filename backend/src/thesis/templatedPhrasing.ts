/**
 * M14.5 — 模板化表达扫描（确定性、仅建议级）。
 *
 * 真实缺陷（案例 B）：章末小结写成「本章首先……其次……最后……」；「通过上述分析
 * 可以看出」反复出现；大段无内容的过渡句。
 *
 * 四类发现（全部 advisory，供 Reviewer / Revision 作为提示；不得据此改动数值
 * 或事实）：
 *   enumerated_summary   —— 总结语境下的「首先…其次…最后…」三段式枚举；
 *   formulaic_transition —— 「通过上述分析可以看出」（任意一次）或其它公式化
 *                           承接句在同一文件出现 ≥ 2 次（含数字/\ref 的结果句豁免）；
 *   repeated_opener      —— 同段 ≥ 3 个连续句子以同一连接词开头；
 *   generic_summary      —— 「小结」小节内无数字、无 \ref、无 \cite、≤ 2 句、
 *                           只复述「本章介绍了…」的段落。
 *
 * 防误报（与 academic-style-zh Skill 一致）：单个「首先 / 其次」、一两次「此外」
 * 均不是信号；含数值结果的句子不被判为公式化承接。
 */

export interface TemplatedPhrasingFinding {
  file: string;
  kind: "enumerated_summary" | "formulaic_transition" | "repeated_opener" | "generic_summary";
  excerpt: string;
  offset: number;
  detail: string;
}

export interface TemplatedPhrasingScan {
  findings: TemplatedPhrasingFinding[];
  summary: { files: number; findings: number; byKind: Record<string, number> };
}

interface Paragraph {
  text: string;
  offset: number;
  /** 最近的 \section/\subsection 标题（无则空串） */
  heading: string;
}

const HEADING_LINE = /^\s*\\(?:chapter|section|subsection|subsubsection|paragraph)\*?\s*(?:\[[^\]]*\])?\{([^}]*)\}/;
const SKIP_ENV_BEGIN = /\\begin\{(table\*?|tabular\*?|longtable|figure\*?|equation\*?|align\*?|gather\*?|multline\*?|lstlisting|verbatim|algorithm|algorithmic)\}/;
const SKIP_ENV_END = /\\end\{(table\*?|tabular\*?|longtable|figure\*?|equation\*?|align\*?|gather\*?|multline\*?|lstlisting|verbatim|algorithm|algorithmic)\}/;

/** 按空行/标题/浮动环境切分段落，并记录段落偏移与所属小节标题 */
function parseParagraphs(content: string): Paragraph[] {
  const paragraphs: Paragraph[] = [];
  const lines = content.split("\n");
  let offset = 0;
  let heading = "";
  let envDepth = 0;
  let buffer: string[] = [];
  let bufferOffset = 0;
  const flush = (): void => {
    const text = buffer.join(" ").replace(/\s+/g, " ").trim();
    if (text !== "") paragraphs.push({ text, offset: bufferOffset, heading });
    buffer = [];
  };
  for (const raw of lines) {
    const trimmed = raw.trim();
    if (SKIP_ENV_BEGIN.test(raw)) {
      flush();
      envDepth += 1;
    }
    if (envDepth > 0) {
      if (SKIP_ENV_END.test(raw)) envDepth = Math.max(0, envDepth - 1);
      offset += raw.length + 1;
      continue;
    }
    if (trimmed === "") {
      flush();
    } else if (trimmed.startsWith("%")) {
      // 注释行不参与
    } else {
      const headingMatch = HEADING_LINE.exec(raw);
      if (headingMatch !== null) {
        flush();
        heading = headingMatch[1] ?? "";
      } else {
        if (buffer.length === 0) bufferOffset = offset + (raw.length - raw.trimStart().length);
        buffer.push(trimmed);
      }
    }
    offset += raw.length + 1;
  }
  flush();
  return paragraphs;
}

function splitSentences(paragraph: string): string[] {
  return paragraph
    .split(/(?<=[。！？；])/)
    .map((sentence) => sentence.replace(/^\\(?:noindent|par)\b\s*/, "").trim())
    .filter((sentence) => sentence !== "");
}

function excerptOf(text: string, max = 60): string {
  const chars = [...text.replace(/\s+/g, " ").trim()];
  return chars.length <= max ? chars.join("") : `${chars.slice(0, max - 1).join("")}…`;
}

const SUMMARY_HEADING = /小结|总结/;
const SUMMARY_OPENER = /^(本章|本节|综上|总之)/;
const STRONG_FORMULAIC = /^通过上述分析可以看出/;
const MEDIUM_FORMULAIC = /^(由上述分析可知|综上所述可以看出)/;
const WEAK_FORMULAIC = /^(不难看出|可以看出，|由此可见，)/;
const OPENERS = /^(此外|然而|因此|同时|另外|值得注意的是)[，,]?/;
const RESTATEMENT = /^(本章|本节)(主要)?(介绍|阐述|讨论|给出|描述|总结|回顾|对|针对|围绕|从)|(本章|本节)[^。！？]{0,30}进行了/;

interface FormulaicCandidate {
  sentence: string;
  offset: number;
  strength: "strong" | "medium" | "weak";
}

export function scanTemplatedPhrasing(
  sections: ReadonlyArray<{ file: string; content: string }>,
): TemplatedPhrasingScan {
  const findings: TemplatedPhrasingFinding[] = [];
  for (const section of sections) {
    const paragraphs = parseParagraphs(section.content);
    const formulaic: FormulaicCandidate[] = [];
    for (const paragraph of paragraphs) {
      const sentences = splitSentences(paragraph.text);
      const summaryContext = SUMMARY_OPENER.test(paragraph.text) || SUMMARY_HEADING.test(paragraph.heading);

      // 1. 枚举式总结：首先 … 其次 … 最后（三者齐备且有序）出现在总结语境
      if (summaryContext) {
        const first = paragraph.text.indexOf("首先");
        const second = first === -1 ? -1 : paragraph.text.indexOf("其次", first + 2);
        const last = second === -1 ? -1 : paragraph.text.indexOf("最后", second + 2);
        if (first !== -1 && second !== -1 && last !== -1) {
          findings.push({
            file: section.file,
            kind: "enumerated_summary",
            excerpt: excerptOf(paragraph.text),
            offset: paragraph.offset,
            detail: "总结段落采用「首先……其次……最后……」三段式枚举；建议按逻辑关系组织，直接给出本章得到的具体结论与适用条件",
          });
        }
      }

      // 2. 公式化承接句候选（文件级汇总后判定）
      let sentenceCursor = 0;
      for (const sentence of sentences) {
        const localIndex = paragraph.text.indexOf(sentence, sentenceCursor);
        const sentenceOffset = paragraph.offset + (localIndex === -1 ? 0 : localIndex);
        if (localIndex !== -1) sentenceCursor = localIndex + sentence.length;
        if (STRONG_FORMULAIC.test(sentence)) {
          formulaic.push({ sentence, offset: sentenceOffset, strength: "strong" });
        } else if (MEDIUM_FORMULAIC.test(sentence)) {
          formulaic.push({ sentence, offset: sentenceOffset, strength: "medium" });
        } else if (WEAK_FORMULAIC.test(sentence) && !/\d|\\ref\{|\\eqref\{/.test(sentence)) {
          formulaic.push({ sentence, offset: sentenceOffset, strength: "weak" });
        }
      }

      // 3. 同一连接词连续开头 ≥ 3 句
      let streak = 0;
      let streakWord = "";
      let flagged = false;
      for (const sentence of sentences) {
        const opener = OPENERS.exec(sentence)?.[1] ?? "";
        if (opener !== "" && opener === streakWord) {
          streak += 1;
        } else {
          streak = opener === "" ? 0 : 1;
          streakWord = opener;
        }
        if (streak >= 3 && !flagged) {
          flagged = true;
          findings.push({
            file: section.file,
            kind: "repeated_opener",
            excerpt: excerptOf(paragraph.text),
            offset: paragraph.offset,
            detail: `同段连续 ${streak} 句均以「${streakWord}」开头，形成机械节奏；只在真实逻辑转折/递进处保留连接词`,
          });
        }
      }

      // 4. 空泛小结：仅在标题含「小结」的小节内判定
      if (
        /小结/.test(paragraph.heading) &&
        sentences.length <= 2 &&
        sentences.length > 0 &&
        !/\d/.test(paragraph.text) &&
        !/\\(?:ref|eqref|autoref|cite[A-Za-z]*)\{/.test(paragraph.text) &&
        RESTATEMENT.test(paragraph.text)
      ) {
        findings.push({
          file: section.file,
          kind: "generic_summary",
          excerpt: excerptOf(paragraph.text),
          offset: paragraph.offset,
          detail: "小结只复述「本章介绍了…」而无具体结论、数据或交叉引用；建议写明本章得到了什么结果、在什么条件下成立",
        });
      }
    }

    // 公式化承接句文件级判定
    const totalMediumWeak = formulaic.filter((candidate) => candidate.strength !== "strong").length;
    for (const candidate of formulaic) {
      if (candidate.strength === "strong" || totalMediumWeak >= 2) {
        findings.push({
          file: section.file,
          kind: "formulaic_transition",
          excerpt: excerptOf(candidate.sentence),
          offset: candidate.offset,
          detail:
            candidate.strength === "strong"
              ? "「通过上述分析可以看出」为公式化承接句；建议删去承接语，直接陈述结论"
              : `公式化承接句在本文件出现 ${formulaic.length} 次；建议只在真实推论处保留一处，其余直接陈述`,
        });
      }
    }
  }

  findings.sort((left, right) => (left.file === right.file ? left.offset - right.offset : left.file < right.file ? -1 : 1));
  const byKind: Record<string, number> = {};
  for (const finding of findings) byKind[finding.kind] = (byKind[finding.kind] ?? 0) + 1;
  return {
    findings,
    summary: { files: sections.length, findings: findings.length, byKind },
  };
}

const KIND_LABEL: Record<TemplatedPhrasingFinding["kind"], string> = {
  enumerated_summary: "枚举式总结",
  formulaic_transition: "公式化承接",
  repeated_opener: "连接词机械重复",
  generic_summary: "空泛小结",
};

/** Reviewer / Revision 提示行（≤ 8 行；每行锚定 file + 摘录；只涉表达，不涉数值/事实） */
export function renderTemplatedPhrasingAdvice(findings: ReadonlyArray<TemplatedPhrasingFinding>): string[] {
  if (findings.length === 0) return [];
  const lines: string[] = [];
  const maxItems = 7;
  for (const finding of findings.slice(0, maxItems)) {
    lines.push(`[${finding.file}] ${KIND_LABEL[finding.kind]}：「${excerptOf(finding.excerpt)}」——${finding.detail}`);
  }
  const remaining = findings.length - maxItems;
  lines.push(
    remaining > 0
      ? `另有 ${remaining} 处同类表达问题未列出。以上仅为表达层建议：改写时逐字保留全部数值、单位、事实陈述与 \\cite/\\ref。`
      : "以上仅为表达层建议：改写时逐字保留全部数值、单位、事实陈述与 \\cite/\\ref。",
  );
  return lines;
}
