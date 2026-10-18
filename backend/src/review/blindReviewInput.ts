/**
 * M14.9.1 阶段 B：Reviewer 输入的匿名内容投影（实验用；生产 Reviewer 默认输入不变）。
 *
 * 三种（+1）可审计的稿件表示，供「同稿不同表示」的成对 A/B：
 *   - raw                 原始 LaTeX（\input 展开 + 参考文献源），含作者 / 单位 / 基金 / 注释等全部元数据；
 *   - naive_text          用户朴素方案：简单 Markdown + 全局关键词整行删除（大学 / 基金 / 邮箱 …），
 *                         每一处删除落审计——它会误删正文里有学术意义的机构 / 数据集来源，
 *                         这正是内容等价门要暴露的风险；
 *   - structured_blind_md 候选方案：按 LaTeX 结构转写为同一内容契约（标题 / 摘要 / 章节、公式原文、
 *                         表格单元格、图号与图注、脚注、引用键与参考文献全部保留），只按**字段与源
 *                         span** 移除 frontmatter 作者 / 单位 / 邮箱 / \thanks / 致谢 / 基金 / 投稿元数据
 *                         与源码注释——从不按「学校」「基金」二字全局删除；
 *   - format_only_md      structured_blind_md 的同一转写 + 原样回填被移除的身份字段（2×2 拆分：
 *                         表示格式 vs 身份字段）。
 * PDF 文本层（期刊 PDF）只能做同一文本基底上的字段 span 移除（identity-only；表格 / 公式在所有臂
 * 中同等丢失，标 conversionLoss）。
 *
 * 纪律：投影不润色、不改写、不概括、不删引文、不改数值；图像内容不可表达时输出
 * FIGURE_CONTENT_NOT_EVALUATED 标记并保留图注。匿名化不承诺完全：算法名 / 自引仍可能暴露作者。
 */

export type ReviewInputArm = "raw" | "naive_text" | "structured_blind_md" | "format_only_md";

export type RedactionKind =
  | "comment"
  | "author"
  | "affiliation"
  | "email"
  | "thanks"
  | "funding"
  | "acknowledgment"
  | "submission_metadata"
  | "date"
  | "running_header"
  | "naive_keyword_line";

export interface Redaction {
  kind: RedactionKind;
  /** 源中的 1 基行号（PDF 文本为文本行号） */
  line: number;
  /** 被移除的原文（截断到 400 字；审计用） */
  excerpt: string;
  /** naive 删除命中的关键词 */
  matched?: string;
}

export interface ProjectionOutput {
  arm: ReviewInputArm;
  text: string;
  redactions: Redaction[];
  /** 转写中遇到但无法表达的内容（图像等）计数 */
  figuresNotEvaluated: number;
  notes: string[];
}

export const FIGURE_NOT_EVALUATED = "FIGURE_CONTENT_NOT_EVALUATED";

/**
 * 朴素方案的全局关键词（整行删除）——刻意保持「用户方案」的原样，不做字段判断。
 * 邮箱按地址形态匹配（而不是裸 @，否则会误删 [@key] 引用标记）。
 */
export const NAIVE_METADATA_PATTERN =
  /(大学|学院|研究院|研究所|University|Institute|College|School of|Laborator|基金|资助|Fund|Foundation|Grant|supported by|E-?mail|[\w.+-]+@[\w-]+\.[\w.-]+|通信作者|通讯作者|Correspond|作者简介|收稿日期|修回日期|中图分类号|文献标志码|文献标识码|文章编号|Word 模板|双栏)/i;

// ---------------------------------------------------------------------------
// 基础扫描工具

/** 从 open（指向 "{"）读取配平的花括号组；返回内容与结束位置（"}" 之后） */
export function readGroup(src: string, open: number): { content: string; end: number } | null {
  if (src[open] !== "{") return null;
  let depth = 0;
  for (let index = open; index < src.length; index += 1) {
    const char = src[index];
    if (char === "\\") {
      index += 1;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") {
      depth -= 1;
      if (depth === 0) return { content: src.slice(open + 1, index), end: index + 1 };
    }
  }
  return null;
}

function readOptional(src: string, at: number): { content: string; end: number } | null {
  let index = at;
  while (src[index] === " " || src[index] === "\t") index += 1;
  if (src[index] !== "[") return null;
  let depth = 0;
  for (let cursor = index; cursor < src.length; cursor += 1) {
    const char = src[cursor];
    if (char === "\\") {
      cursor += 1;
      continue;
    }
    if (char === "[") depth += 1;
    else if (char === "]") {
      depth -= 1;
      if (depth === 0) return { content: src.slice(index + 1, cursor), end: cursor + 1 };
    }
  }
  return null;
}

function skipSpaces(src: string, at: number): number {
  let index = at;
  while (index < src.length && (src[index] === " " || src[index] === "\t" || src[index] === "\n" || src[index] === "\r")) index += 1;
  return index;
}

function lineOf(src: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < src.length; index += 1) if (src[index] === "\n") line += 1;
  return line;
}

/** 删除源码注释（未转义的 % 到行尾；comment 环境整体），返回去注释文本与被删注释（含行号） */
export function stripLatexComments(src: string): { text: string; comments: Array<{ line: number; text: string }> } {
  const comments: Array<{ line: number; text: string }> = [];
  const lines = src.split("\n");
  const out: string[] = [];
  let inCommentEnv = false;
  lines.forEach((line, index) => {
    if (inCommentEnv) {
      comments.push({ line: index + 1, text: line });
      if (/\\end\{comment\}/.test(line)) inCommentEnv = false;
      out.push("");
      return;
    }
    if (/^\s*\\begin\{comment\}/.test(line)) {
      inCommentEnv = true;
      comments.push({ line: index + 1, text: line });
      out.push("");
      return;
    }
    let cut = -1;
    for (let cursor = 0; cursor < line.length; cursor += 1) {
      if (line[cursor] === "\\") {
        cursor += 1;
        continue;
      }
      if (line[cursor] === "%") {
        cut = cursor;
        break;
      }
    }
    if (cut >= 0) {
      const removed = line.slice(cut);
      if (removed.replace(/^%+/, "").trim() !== "") comments.push({ line: index + 1, text: removed });
      out.push(line.slice(0, cut));
    } else {
      out.push(line);
    }
  });
  // 行结构保持不变（审计行号 = 源文件行号）；整行注释变为空行
  return { text: out.join("\n"), comments };
}

/** \input / \include 递归展开（resolver 返回 null = 文件缺失，保留原命令并记 note） */
export function flattenLatexInputs(src: string, resolve: (name: string) => string | null, notes: string[] = [], depth = 0): string {
  if (depth > 8) return src;
  return src.replace(/\\(input|include)\s*\{([^}]+)\}/g, (whole, _cmd: string, name: string) => {
    const content = resolve(name.trim());
    if (content === null) {
      notes.push(`missing_input:${name.trim()}`);
      return whole;
    }
    return flattenLatexInputs(content, resolve, notes, depth + 1);
  });
}

// ---------------------------------------------------------------------------
// 元数据字段识别（字段 / span 级；不做全局关键词删除）

const METADATA_COMMANDS: Record<string, RedactionKind> = {
  author: "author",
  affil: "affiliation",
  affiliation: "affiliation",
  address: "affiliation",
  institute: "affiliation",
  email: "email",
  thanks: "thanks",
  date: "date",
  markboth: "submission_metadata",
  IEEEpubid: "submission_metadata",
  IEEEspecialpapernotice: "submission_metadata",
  corresp: "email",
  fund: "funding",
  funding: "funding",
  received: "submission_metadata",
  CLCnumber: "submission_metadata",
};

const ACK_HEADING = /^(acknowledg?ements?|acknowledg?ments?|致\s*谢|funding|基金项目|资助)$/i;
const ACK_ENVS = ["acks", "acknowledgments", "acknowledgements", "acknowledgment", "acknowledgement"];

interface Span { start: number; end: number; kind: RedactionKind }

/** 在（已去注释的）源中找出字段级元数据 span（命令整体 / 致谢节 / 致谢环境） */
export function findMetadataSpans(src: string): Span[] {
  const spans: Span[] = [];
  const commandPattern = /\\([A-Za-z]+)\*?/g;
  let match: RegExpExecArray | null;
  while ((match = commandPattern.exec(src)) !== null) {
    const name = match[1]!;
    const kind = METADATA_COMMANDS[name];
    if (kind === undefined) continue;
    let cursor = match.index + match[0].length;
    const optional = readOptional(src, cursor);
    if (optional !== null) cursor = optional.end;
    cursor = skipSpaces(src, cursor);
    const group = readGroup(src, cursor);
    if (group === null) continue;
    let end = group.end;
    // \markboth{A}{B} 两个参数
    if (name === "markboth") {
      const second = readGroup(src, skipSpaces(src, end));
      if (second !== null) end = second.end;
    }
    spans.push({ start: match.index, end, kind });
    commandPattern.lastIndex = end;
  }
  // 致谢 / 基金节：标题命中 → 到下一个章节命令 / 参考文献 / \end{document}
  const heading = /\\(section|subsection|paragraph)\*?\s*\{([^}]*)\}/g;
  while ((match = heading.exec(src)) !== null) {
    if (!ACK_HEADING.test(match[2]!.trim())) continue;
    const rest = src.slice(match.index + match[0].length);
    const stop = rest.search(/\\(section|chapter)\*?\s*\{|\\bibliography(style)?\s*\{|\\begin\{thebibliography\}|\\end\{document\}|\\printbibliography|\\appendix/);
    const end = match.index + match[0].length + (stop < 0 ? rest.length : stop);
    spans.push({ start: match.index, end, kind: /fund|基金|资助/i.test(match[2]!) ? "funding" : "acknowledgment" });
  }
  for (const env of ACK_ENVS) {
    const envPattern = new RegExp(`\\\\begin\\{${env}\\}[\\s\\S]*?\\\\end\\{${env}\\}`, "g");
    while ((match = envPattern.exec(src)) !== null) spans.push({ start: match.index, end: match.index + match[0].length, kind: "acknowledgment" });
  }
  // 段首粗体致谢（\textbf{Acknowledgement.} ……）：到段落结束 / 下一个章节或参考文献
  const inlineAck = /\\(textbf|textit|emph|bf)\s*\{\s*(Acknowledg\w*|致\s*谢)\s*[.:：]?\s*\}|\{\\bf\s+(Acknowledg\w*)\s*[.:：]?\s*\}/g;
  while ((match = inlineAck.exec(src)) !== null) {
    const rest = src.slice(match.index);
    const stop = rest.slice(1).search(/\n\s*\n|\\(section|chapter)\*?\s*\{|\\bibliography(style)?\s*\{|\\begin\{thebibliography\}|\\end\{document\}|\\appendix/);
    spans.push({ start: match.index, end: match.index + 1 + (stop < 0 ? rest.length - 1 : stop), kind: "acknowledgment" });
  }
  // 题名区的身份脚注（第一个章节命令之前的 \footnote / \footnotetext：通信作者、同等贡献、实习、资助）
  const firstSection = src.search(/\\(section|chapter)\*?\s*\{/);
  const footnote = /\\(footnotetext|footnote)\s*(\[[^\]]*\])?\s*\{/g;
  while ((match = footnote.exec(src)) !== null) {
    if (firstSection >= 0 && match.index > firstSection) break;
    const group = readGroup(src, match.index + match[0].length - 1);
    if (group === null) continue;
    if (/(corresponding author|equal(ly)? contribut|work (was )?done|intern(ship)?|supported by|funded by|通信作者|通讯作者|基金|资助)/i.test(group.content)) {
      spans.push({ start: match.index, end: group.end, kind: /supported|funded|基金|资助/i.test(group.content) ? "funding" : "thanks" });
    }
  }
  // 合并重叠（外层优先）
  spans.sort((a, b) => a.start - b.start || b.end - a.end);
  const merged: Span[] = [];
  for (const span of spans) {
    const last = merged[merged.length - 1];
    if (last !== undefined && span.start < last.end) {
      if (span.end > last.end) last.end = span.end;
      continue;
    }
    merged.push({ ...span });
  }
  return merged;
}

// ---------------------------------------------------------------------------
// LaTeX → Markdown（内容契约转写）

/**
 * M14.9.1 metadata_blind 输入模式（实验开关）：保持 LaTeX 表示不变，只按字段 / span 去掉身份元数据
 * 与源码注释；被移除的 span 以等量换行占位（行号不漂移）。不做 Markdown 转写——A/B 中格式成分
 * （D−A）未显示可分辨的影响，而转写本身曾引入表格伪影。
 */
export function stripLatexReviewMetadata(source: string): { text: string; redactions: Redaction[] } {
  const { text, comments } = stripLatexComments(source);
  const spans = findMetadataSpans(text);
  let out = text;
  for (const span of [...spans].sort((a, b) => b.start - a.start)) {
    out = out.slice(0, span.start) + out.slice(span.start, span.end).replace(/[^\n]/g, "") + out.slice(span.end);
  }
  const redactions: Redaction[] = [
    ...spans.map((span) => ({ kind: span.kind, line: lineOf(text, span.start), excerpt: text.slice(span.start, span.end).slice(0, 400) })),
    ...comments.map((comment) => ({ kind: "comment" as const, line: comment.line, excerpt: comment.text.slice(0, 400) })),
  ];
  return { text: out, redactions: redactions.sort((a, b) => a.line - b.line) };
}

/** 只影响版式、参数不含科研内容的命令：整体（含参数）丢弃 */
const LAYOUT_DROP_WITH_ARGS: Record<string, number> = {
  vspace: 1, hspace: 1, setlength: 2, addtolength: 2, includegraphics: 1, bibliographystyle: 1, pagestyle: 1, thispagestyle: 1,
  cline: 1, cmidrule: 1, addlinespace: 0, rule: 2, renewcommand: 2, newcommand: 2, providecommand: 2, DeclareMathOperator: 2,
  setcounter: 2, addtocounter: 2, linespread: 1, fontsize: 2, color: 1, definecolor: 3, usepackage: 1, documentclass: 1,
  graphicspath: 1, captionsetup: 1, setcitestyle: 1, hypersetup: 1, newtheorem: 2, pagenumbering: 1, enlargethispage: 1,
  arraystretch: 0, tabcolsep: 0, label: 1, title: 1, rowcolor: 1, cellcolor: 1, columncolor: 1, arrayrulecolor: 1,
};
/** 包装命令：丢弃前 n 个参数、保留最后一个参数的内容 */
const WRAP_KEEP_LAST: Record<string, number> = {
  textcolor: 2, colorbox: 2, resizebox: 3, scalebox: 2, parbox: 2, raisebox: 2, multicolumn: 3, multirow: 3, makebox: 1, framebox: 1,
  adjustbox: 2, rotatebox: 2, href: 2,
};
const STYLE: Record<string, [string, string]> = {
  textbf: ["**", "**"], bfseries: ["", ""], emph: ["*", "*"], textit: ["*", "*"], texttt: ["`", "`"], underline: ["", ""],
};
const SECTION_LEVEL: Record<string, string> = {
  chapter: "#", section: "##", subsection: "###", subsubsection: "####", paragraph: "**", subparagraph: "**",
};
const DISPLAY_MATH_ENVS = new Set(["equation", "equation*", "align", "align*", "gather", "gather*", "multline", "multline*", "eqnarray", "eqnarray*", "displaymath", "flalign", "flalign*", "alignat", "alignat*", "math"]);
const VERBATIM_BLOCK_ENVS = new Set(["algorithm", "algorithm*", "algorithmic", "algorithm2e", "lstlisting", "verbatim"]);

export interface ConvertContext {
  macros: Map<string, { args: number; body: string }>;
  figures: number;
  notes: string[];
}

/** 收集导言区里的简单 \newcommand / \def 宏（≤ 3 参数），用于在正文中展开（保留语义文字） */
export function collectMacros(preamble: string): Map<string, { args: number; body: string }> {
  const macros = new Map<string, { args: number; body: string }>();
  const pattern = /\\(?:re)?newcommand\*?\s*\{?\\([A-Za-z]+)\}?\s*(?:\[(\d)\])?/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(preamble)) !== null) {
    let cursor = match.index + match[0].length;
    const optional = readOptional(preamble, cursor);
    if (optional !== null && match[2] !== undefined) cursor = optional.end;
    const group = readGroup(preamble, skipSpaces(preamble, cursor));
    if (group === null) continue;
    const args = Number(match[2] ?? "0");
    if (args <= 3) macros.set(match[1]!, { args, body: group.content });
  }
  return macros;
}

function findEnvEnd(src: string, env: string, from: number): number {
  const escaped = env.replace(/[*]/g, "\\*");
  const pattern = new RegExp(`\\\\(begin|end)\\{${escaped}\\}`, "g");
  pattern.lastIndex = from;
  let depth = 1;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(src)) !== null) {
    depth += match[1] === "begin" ? 1 : -1;
    if (depth === 0) return match.index;
  }
  return -1;
}

/** 一段 LaTeX 正文 → Markdown（数学原样、引用 / 交叉引用以可读标记保留） */
export function convertLatex(src: string, ctx: ConvertContext, depth = 0): string {
  if (depth > 12) return src;
  let out = "";
  let index = 0;
  while (index < src.length) {
    const char = src[index]!;
    if (char === "$") {
      // 行内 / 显示数学：原样保留
      const display = src[index + 1] === "$";
      const close = findMathClose(src, index + (display ? 2 : 1), display ? "$$" : "$");
      if (close < 0) {
        out += char;
        index += 1;
        continue;
      }
      const body = src.slice(index + (display ? 2 : 1), close);
      out += display ? `\n$$\n${body.trim()}\n$$\n` : `$${body}$`;
      index = close + (display ? 2 : 1);
      continue;
    }
    if (char === "~") {
      out += " ";
      index += 1;
      continue;
    }
    if (char === "{" || char === "}") {
      index += 1;
      continue;
    }
    if (char !== "\\") {
      out += char;
      index += 1;
      continue;
    }
    // ---- 反斜杠命令 ----
    const next = src[index + 1];
    if (next === undefined) break;
    if (next === "[" || next === "(") {
      const closeToken = next === "[" ? "\\]" : "\\)";
      const close = src.indexOf(closeToken, index + 2);
      if (close < 0) {
        out += src.slice(index, index + 2);
        index += 2;
        continue;
      }
      const body = src.slice(index + 2, close);
      out += next === "[" ? `\n$$\n${body.trim()}\n$$\n` : `$${body}$`;
      index = close + 2;
      continue;
    }
    if (next === "\\") {
      const optional = readOptional(src, index + 2);
      out += "\n";
      index = optional !== null ? optional.end : index + 2;
      continue;
    }
    if (!/[A-Za-z@]/.test(next)) {
      // 转义字符：\% \& \# \_ \$ \{ \} ；间距命令 \, \; \! \  丢弃为空格
      if ("%&#_${}".includes(next)) out += next;
      else if (",;:! ".includes(next)) out += " ";
      else if (next === "-") out += "";
      index += 2;
      continue;
    }
    const nameMatch = /^[A-Za-z@]+\*?/.exec(src.slice(index + 1))!;
    const name = nameMatch[0].replace(/\*$/, "");
    let cursor = index + 1 + nameMatch[0].length;

    if (name === "begin") {
      const group = readGroup(src, cursor);
      if (group === null) {
        index = cursor;
        continue;
      }
      const env = group.content.trim();
      const bodyStart = group.end;
      const endAt = findEnvEnd(src, env, bodyStart);
      const bodyEnd = endAt < 0 ? src.length : endAt;
      const after = endAt < 0 ? src.length : endAt + `\\end{${env}}`.length;
      out += convertEnvironment(env, src.slice(bodyStart, bodyEnd), ctx, depth);
      index = after;
      continue;
    }
    if (name === "end") {
      const group = readGroup(src, cursor);
      index = group === null ? cursor : group.end;
      continue;
    }
    if (SECTION_LEVEL[name] !== undefined) {
      const optional = readOptional(src, cursor);
      if (optional !== null) cursor = optional.end;
      const group = readGroup(src, skipSpaces(src, cursor));
      if (group !== null) {
        const title = convertLatex(group.content, ctx, depth + 1).trim();
        const marker = SECTION_LEVEL[name]!;
        out += marker === "**" ? `\n\n**${title}** ` : `\n\n${marker} ${title}\n\n`;
        index = group.end;
        continue;
      }
    }
    if (/^(cite[a-zA-Z]*|Cite[a-zA-Z]*|citnum|parencite|textcite|autocite|nocite|upcite)$/.test(name)) {
      const optional = readOptional(src, cursor);
      if (optional !== null) cursor = optional.end;
      const second = readOptional(src, cursor);
      if (second !== null) cursor = second.end;
      const group = readGroup(src, skipSpaces(src, cursor));
      if (group !== null) {
        const keys = group.content.split(",").map((key) => key.trim()).filter((key) => key !== "");
        out += name === "nocite" ? "" : `[${keys.map((key) => `@${key}`).join("; ")}]`;
        index = group.end;
        continue;
      }
    }
    if (/^(ref|eqref|autoref|cref|Cref|pageref|nameref)$/.test(name)) {
      const group = readGroup(src, skipSpaces(src, cursor));
      if (group !== null) {
        out += name === "eqref" ? `([ref:${group.content.trim()}])` : `[ref:${group.content.trim()}]`;
        index = group.end;
        continue;
      }
    }
    if (name === "label") {
      const group = readGroup(src, skipSpaces(src, cursor));
      if (group !== null) {
        out += ` {#${group.content.trim()}}`;
        index = group.end;
        continue;
      }
    }
    if (name === "footnote" || name === "footnotetext") {
      const optional = readOptional(src, cursor);
      if (optional !== null) cursor = optional.end;
      const group = readGroup(src, skipSpaces(src, cursor));
      if (group !== null) {
        out += ` [^脚注: ${convertLatex(group.content, ctx, depth + 1).trim()}]`;
        index = group.end;
        continue;
      }
    }
    if (name === "url") {
      const group = readGroup(src, skipSpaces(src, cursor));
      if (group !== null) {
        out += group.content;
        index = group.end;
        continue;
      }
    }
    if (name === "item") {
      const optional = readOptional(src, cursor);
      out += optional !== null ? `\n- ${convertLatex(optional.content, ctx, depth + 1)} ` : "\n- ";
      index = optional !== null ? optional.end : cursor;
      continue;
    }
    if (name === "caption" || name === "subcaption" || name === "captionof") {
      if (name === "captionof") {
        const kind = readGroup(src, skipSpaces(src, cursor));
        if (kind !== null) cursor = kind.end;
      }
      const optional = readOptional(src, cursor);
      if (optional !== null) cursor = optional.end;
      const group = readGroup(src, skipSpaces(src, cursor));
      if (group !== null) {
        out += `\n**图表题注：** ${convertLatex(group.content, ctx, depth + 1).trim()}\n`;
        index = group.end;
        continue;
      }
    }
    if (name === "bibitem") {
      const optional = readOptional(src, cursor);
      if (optional !== null) cursor = optional.end;
      const group = readGroup(src, skipSpaces(src, cursor));
      if (group !== null) {
        out += `\n- [@${group.content.trim()}] `;
        index = group.end;
        continue;
      }
    }
    if (STYLE[name] !== undefined) {
      const group = readGroup(src, skipSpaces(src, cursor));
      if (group !== null) {
        const [open, close] = STYLE[name]!;
        const inner = convertLatex(group.content, ctx, depth + 1);
        out += inner.trim() === "" ? inner : `${open}${inner}${close}`;
        index = group.end;
        continue;
      }
    }
    if (LAYOUT_DROP_WITH_ARGS[name] !== undefined) {
      let end = cursor;
      if (name === "cmidrule") {
        const paren = /^\s*\([^)]*\)/.exec(src.slice(end));
        if (paren !== null) end += paren[0].length;
      }
      const optional = readOptional(src, end);
      if (optional !== null) end = optional.end;
      for (let arg = 0; arg < LAYOUT_DROP_WITH_ARGS[name]!; arg += 1) {
        // \newcommand{\x}[n]{...}: 参数之间可能夹 [n]
        const opt = readOptional(src, end);
        if (opt !== null) end = opt.end;
        const group = readGroup(src, skipSpaces(src, end));
        if (group === null) {
          // \newcommand\x{...} 形式：跳过命令名
          const bare = /^\s*\\[A-Za-z@]+/.exec(src.slice(end));
          if (bare !== null) {
            end += bare[0].length;
            continue;
          }
          break;
        }
        end = group.end;
      }
      index = end;
      continue;
    }
    if (WRAP_KEEP_LAST[name] !== undefined) {
      let end = cursor;
      const total = WRAP_KEEP_LAST[name]!;
      let last = "";
      let first = "";
      for (let arg = 0; arg < total; arg += 1) {
        const optional = readOptional(src, end);
        if (optional !== null) end = optional.end;
        const group = readGroup(src, skipSpaces(src, end));
        if (group === null) break;
        if (arg === 0) first = group.content;
        last = group.content;
        end = group.end;
      }
      const inner = convertLatex(last, ctx, depth + 1);
      out += name === "href" ? `${inner} (${first})` : inner;
      index = end;
      continue;
    }
    const macro = ctx.macros.get(name);
    if (macro !== undefined) {
      let end = cursor;
      const args: string[] = [];
      for (let arg = 0; arg < macro.args; arg += 1) {
        const group = readGroup(src, skipSpaces(src, end));
        if (group === null) break;
        args.push(group.content);
        end = group.end;
      }
      const expanded = macro.body.replace(/#(\d)/g, (_whole, digit: string) => args[Number(digit) - 1] ?? "");
      out += convertLatex(expanded, ctx, depth + 1);
      index = end;
      continue;
    }
    // 其余命令：有花括号参数 → 保留参数内容；无参数 → 丢弃（版式开关 \centering \small \hline …）
    if (/^(maketitle|IEEEpeerreviewmaketitle|tableofcontents|newpage|clearpage|noindent|centering|hline|toprule|midrule|bottomrule|appendix|par)$/.test(name)) {
      index = cursor;
      if (name === "appendix") out += "\n\n## 附录 / Appendix\n\n";
      if (name === "par") out += "\n\n";
      continue;
    }
    if (name === "bibliography" || name === "printbibliography") {
      const group = readGroup(src, skipSpaces(src, cursor));
      out += "\n\n@@BIBLIOGRAPHY@@\n\n";
      index = group !== null ? group.end : cursor;
      continue;
    }
    index = cursor;
    // 命令后的空格是分隔符
    if (src[index] === " " && /[A-Za-z]$/.test(nameMatch[0])) index += 1;
  }
  return out;
}

function findMathClose(src: string, from: number, token: "$" | "$$"): number {
  for (let index = from; index < src.length; index += 1) {
    if (src[index] === "\\") {
      index += 1;
      continue;
    }
    if (token === "$$" ? src.startsWith("$$", index) : src[index] === "$") return index;
  }
  return -1;
}

function convertEnvironment(env: string, body: string, ctx: ConvertContext, depth: number): string {
  const base = env.replace(/\*$/, "");
  if (DISPLAY_MATH_ENVS.has(env) || DISPLAY_MATH_ENVS.has(base)) {
    return `\n$$\n\\begin{${env}}${body}\\end{${env}}\n$$\n`;
  }
  if (VERBATIM_BLOCK_ENVS.has(env) || VERBATIM_BLOCK_ENVS.has(base)) {
    return `\n\`\`\`latex-${base}\n${body.trim()}\n\`\`\`\n`;
  }
  if (base === "abstract") return `\n\n## 摘要 / Abstract\n\n${convertLatex(body, ctx, depth + 1).trim()}\n\n`;
  if (base === "IEEEkeywords" || base === "keywords") return `\n\n**Keywords:** ${convertLatex(body, ctx, depth + 1).trim()}\n\n`;
  // 浮动体的位置参数（[htbp]）只影响版式
  if (/^(table|figure|wrapfigure|sidewaystable|algorithm|minipage)$/.test(base)) body = body.replace(/^\s*\[[^\]]*\]/, "");
  if (base === "table" || base === "longtable" || base === "sidewaystable") return convertTableFloat(env, body, ctx, depth);
  if (/^(tabular|tabularx|tabular\*|array|tabu)$/.test(base) || base === "tabular") return convertTabular(base, body, ctx, depth);
  if (/^(figure|subfigure|wrapfigure|SCfigure)$/.test(base)) {
    const graphics = (body.match(/\\includegraphics/g) ?? []).length;
    ctx.figures += Math.max(1, graphics);
    // 只保留题注与 label（图像内容不由文字评分评估）
    const labels = [...body.matchAll(/\\label\s*\{([^}]*)\}/g)].map((match) => match[1]);
    const inner = convertLatex(body.replace(/\\label\s*\{[^}]*\}/g, ""), ctx, depth + 1).trim();
    return `\n\n> [图${labels.map((label) => ` {#${label}}`).join("")}] ${FIGURE_NOT_EVALUATED}\n> ${inner.replace(/\n+/g, "\n> ")}\n\n`;
  }
  if (/^(itemize|enumerate|description|compactitem|inparaenum)$/.test(base)) {
    return `\n${convertLatex(body, ctx, depth + 1)}\n`;
  }
  if (base === "thebibliography") {
    const stripped = body.replace(/^\s*\{[^}]*\}/, "");
    return `\n\n## 参考文献 / References\n${convertLatex(stripped, ctx, depth + 1)}\n`;
  }
  // 未知环境：去掉标记、保留内容（minipage 的宽度参数、center 等）
  const cleaned = /^(minipage|center|flushleft|flushright|small|footnotesize|threeparttable|tablenotes|adjustbox|spacing|quote|quotation|theorem|lemma|proof|definition|remark|proposition|corollary)$/.test(base)
    ? body.replace(/^\s*(\[[^\]]*\])?\s*(\{[^{}]*\})?/, (whole) => (base === "minipage" || base === "adjustbox" || base === "spacing" ? "" : whole))
    : body;
  const label = /^(theorem|lemma|proof|definition|remark|proposition|corollary)$/.test(base) ? `\n\n**${base}.** ` : "\n";
  return `${label}${convertLatex(cleaned, ctx, depth + 1)}\n`;
}

function convertTableFloat(env: string, body: string, ctx: ConvertContext, depth: number): string {
  void env;
  const labels = [...body.matchAll(/\\label\s*\{([^}]*)\}/g)].map((match) => match[1]);
  const inner = convertLatex(body.replace(/\\label\s*\{[^}]*\}/g, ""), ctx, depth + 1).trim();
  return `\n\n**[表${labels.map((label) => ` {#${label}}`).join("")}]**\n\n${inner}\n\n`;
}

/** tabular → Markdown 表格（行列标题、单位、显著性符号、数学原样保留） */
function convertTabular(env: string, body: string, ctx: ConvertContext, depth: number): string {
  // 去掉列格式参数 {lcc|r} 与 tabularx 宽度参数
  let content = body;
  const widthArg = env === "tabularx" || env === "tabular*" ? readGroup(content, skipSpaces(content, 0)) : null;
  if (widthArg !== null) content = content.slice(widthArg.end);
  const optional = readOptional(content, 0);
  if (optional !== null) content = content.slice(optional.end);
  const spec = readGroup(content, skipSpaces(content, 0));
  if (spec !== null) content = content.slice(spec.end);
  const rows = splitTopLevel(content, "\\\\").map((row) => row.replace(/^\s*\[[^\]]*\]/, ""));
  const table: string[][] = [];
  for (const row of rows) {
    const cleaned = row.replace(/\\(hline|toprule|midrule|bottomrule|endhead|endfoot|endfirsthead|endlastfoot)\b/g, "")
      .replace(/\\(cline|cmidrule)(\([^)]*\))?\s*\{[^}]*\}/g, "").replace(/\\addlinespace(\[[^\]]*\])?/g, "");
    if (cleaned.trim() === "") continue;
    // \multicolumn{n}{…}{X}：X 占首格、其后补 n−1 个空格位（与 LaTeX 列对齐一致；M14.9.1 A/B 中
    // 曾把补位统一放到行尾，审稿模型据此报出「表格整体左移一列」的转换伪影）
    const cells = splitTopLevel(cleaned, "&").flatMap((cell) => {
      const text = convertLatex(cell, ctx, depth + 1).replace(/\s+/g, " ").replace(/\|/g, "\\|").trim();
      const span = /^\s*\\multicolumn\s*\{(\d+)\}/.exec(cell);
      const width = span === null ? 1 : Math.max(1, Math.min(64, Number(span[1])));
      return [text, ...Array.from({ length: width - 1 }, () => "")];
    });
    table.push(cells);
  }
  if (table.length === 0) return "";
  const width = Math.max(...table.map((row) => row.length));
  const padded = table.map((row) => [...row, ...Array.from({ length: width - row.length }, () => "")]);
  const lines = [`| ${padded[0]!.join(" | ")} |`, `|${" --- |".repeat(width)}`, ...padded.slice(1).map((row) => `| ${row.join(" | ")} |`)];
  return `\n${lines.join("\n")}\n`;
}

/** 按顶层分隔符切分（忽略花括号 / 数学内部；\\ 与 & 的转义） */
function splitTopLevel(src: string, separator: "\\\\" | "&"): string[] {
  const parts: string[] = [];
  let depth = 0;
  let inMath = false;
  let start = 0;
  for (let index = 0; index < src.length; index += 1) {
    const char = src[index];
    if (char === "\\") {
      if (separator === "\\\\" && src[index + 1] === "\\" && depth === 0 && !inMath) {
        parts.push(src.slice(start, index));
        index += 1;
        start = index + 1;
        continue;
      }
      index += 1;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    else if (char === "$") inMath = !inMath;
    else if (separator === "&" && char === "&" && depth === 0 && !inMath) {
      parts.push(src.slice(start, index));
      start = index + 1;
    }
  }
  parts.push(src.slice(start));
  return parts;
}

function tidyMarkdown(text: string): string {
  return text
    .replace(/[ \t]+\n/g, "\n")
    .replace(/\n{3,}/g, "\n\n")
    .replace(/[ \t]{2,}/g, " ")
    .trim() + "\n";
}

// ---------------------------------------------------------------------------
// 参考文献

/** .bib 解析（只取被引用 key；字段原文保留） */
export function renderBibEntries(bib: string, keys: readonly string[] | null): Array<{ key: string; raw: string; text: string }> {
  const entries: Array<{ key: string; raw: string; text: string }> = [];
  const pattern = /@([A-Za-z]+)\s*\{\s*([^,\s]+)\s*,/g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(bib)) !== null) {
    if (/^(comment|string|preamble)$/i.test(match[1]!)) continue;
    const open = bib.indexOf("{", match.index);
    const group = readGroup(bib, open);
    if (group === null) continue;
    const key = match[2]!;
    if (keys !== null && !keys.includes(key)) continue;
    const fields: Record<string, string> = {};
    const fieldPattern = /([A-Za-z]+)\s*=\s*/g;
    let field: RegExpExecArray | null;
    const content = group.content;
    while ((field = fieldPattern.exec(content)) !== null) {
      let cursor = field.index + field[0].length;
      let value = "";
      if (content[cursor] === "{") {
        const inner = readGroup(content, cursor);
        if (inner === null) break;
        value = inner.content;
        cursor = inner.end;
      } else if (content[cursor] === '"') {
        const close = content.indexOf('"', cursor + 1);
        value = content.slice(cursor + 1, close);
        cursor = close + 1;
      } else {
        const bare = /^[^,}\s]+/.exec(content.slice(cursor));
        value = bare?.[0] ?? "";
        cursor += value.length;
      }
      fields[field[1]!.toLowerCase()] = value.replace(/[{}]/g, "").replace(/\s+/g, " ").trim();
      fieldPattern.lastIndex = cursor;
    }
    const text = [fields["author"], fields["title"], fields["journal"] ?? fields["booktitle"] ?? fields["publisher"] ?? fields["howpublished"], fields["volume"], fields["pages"], fields["year"]]
      .filter((value) => value !== undefined && value !== "").join(". ");
    entries.push({ key, raw: bib.slice(match.index, group.end), text });
    pattern.lastIndex = group.end;
  }
  return entries;
}

export function citedKeys(src: string): string[] {
  const keys: string[] = [];
  for (const match of src.matchAll(/\\(?:cite[a-zA-Z]*|Cite[a-zA-Z]*|citnum|parencite|textcite|autocite|nocite|upcite)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]*)\}/g)) {
    for (const key of match[1]!.split(",")) if (key.trim() !== "" && !keys.includes(key.trim())) keys.push(key.trim());
  }
  return keys;
}

// ---------------------------------------------------------------------------
// 臂构建（LaTeX）

export interface LatexSourceBundle {
  /** 已展开 \input 的主文件 */
  main: string;
  /** 外部参考文献：已编译 .bbl（优先）或 .bib 源 */
  bibliography?: { kind: "bbl" | "bib"; content: string };
}

interface PreparedLatex {
  stripped: string;
  comments: Array<{ line: number; text: string }>;
  spans: Span[];
  preamble: string;
  bodyStart: number;
  bodyEnd: number;
  title: string | null;
}

function prepare(bundle: LatexSourceBundle): PreparedLatex {
  const { text, comments } = stripLatexComments(bundle.main);
  const begin = /\\begin\{document\}/.exec(text);
  const endDoc = text.lastIndexOf("\\end{document}");
  const bodyStart = begin === null ? 0 : begin.index + begin[0].length;
  const bodyEnd = endDoc < 0 ? text.length : endDoc;
  const preamble = begin === null ? "" : text.slice(0, begin.index);
  const titleMatch = /\\title\s*(\[[^\]]*\])?\s*\{/.exec(text);
  const title = titleMatch === null ? null : readGroup(text, titleMatch.index + titleMatch[0].length - 1)?.content ?? null;
  return { stripped: text, comments, spans: findMetadataSpans(text), preamble, bodyStart, bodyEnd, title };
}

function renderBibliographySection(bundle: LatexSourceBundle, keys: readonly string[], ctx: ConvertContext): string {
  if (bundle.bibliography === undefined) return "";
  if (bundle.bibliography.kind === "bbl") {
    const env = /\\begin\{thebibliography\}([\s\S]*?)\\end\{thebibliography\}/.exec(bundle.bibliography.content);
    return env === null ? "" : convertEnvironment("thebibliography", env[1]!, ctx, 0);
  }
  const entries = renderBibEntries(bundle.bibliography.content, keys);
  return `\n\n## 参考文献 / References\n${entries.map((entry) => `\n- [@${entry.key}] ${convertLatex(entry.text, ctx, 1).trim()}`).join("")}\n`;
}

function convertBodyWithout(prepared: PreparedLatex, removeMetadata: boolean, ctx: ConvertContext): string {
  let body = "";
  let cursor = prepared.bodyStart;
  const inBody = prepared.spans.filter((span) => span.end > prepared.bodyStart && span.start < prepared.bodyEnd);
  for (const span of inBody) {
    body += prepared.stripped.slice(cursor, Math.max(cursor, span.start));
    if (!removeMetadata) body += prepared.stripped.slice(Math.max(cursor, span.start), Math.min(span.end, prepared.bodyEnd));
    cursor = Math.min(span.end, prepared.bodyEnd);
  }
  body += prepared.stripped.slice(cursor, prepared.bodyEnd);
  return convertLatex(body, ctx);
}

function metadataRedactions(prepared: PreparedLatex, includeComments: boolean): Redaction[] {
  const out: Redaction[] = prepared.spans.map((span) => ({
    kind: span.kind,
    line: lineOf(prepared.stripped, span.start),
    excerpt: prepared.stripped.slice(span.start, span.end).slice(0, 400),
  }));
  if (includeComments) {
    for (const comment of prepared.comments) out.push({ kind: "comment", line: comment.line, excerpt: comment.text.slice(0, 400) });
  }
  return out.sort((a, b) => a.line - b.line);
}

/** 原样（RAW）：展开后的源码 + 参考文献源（不去注释、不去元数据） */
export function projectRaw(bundle: LatexSourceBundle): ProjectionOutput {
  const keys = citedKeys(bundle.main);
  let bibliography = "";
  if (bundle.bibliography?.kind === "bbl") bibliography = `\n\n% ===== 参考文献（编译产物 .bbl）=====\n${bundle.bibliography.content}`;
  if (bundle.bibliography?.kind === "bib") bibliography = `\n\n% ===== 参考文献（refs.bib 中被引用的条目）=====\n${renderBibEntries(bundle.bibliography.content, keys).map((entry) => entry.raw).join("\n\n")}`;
  return { arm: "raw", text: bundle.main + bibliography, redactions: [], figuresNotEvaluated: 0, notes: [] };
}

/** 候选方案：结构化盲化 Markdown（字段 / span 级移除） */
export function projectStructuredBlind(bundle: LatexSourceBundle, options: { keepIdentity?: boolean } = {}): ProjectionOutput {
  const prepared = prepare(bundle);
  const ctx: ConvertContext = { macros: collectMacros(prepared.preamble), figures: 0, notes: [] };
  const titleMd = prepared.title === null ? "" : `# ${convertLatex(prepared.title, ctx).replace(/\s*\n\s*/g, " ").trim()}\n\n`;
  const body = convertBodyWithout(prepared, options.keepIdentity !== true, ctx);
  const keys = citedKeys(prepared.stripped);
  const bib = renderBibliographySection(bundle, keys, ctx);
  let identity = "";
  if (options.keepIdentity === true) {
    // format_only：被移除的身份字段原样（转写为文字）回填到题名之后——只回填命令内容，不回填注释
    const fields = prepared.spans.filter((span) => span.kind !== "acknowledgment" && span.kind !== "funding" && span.start < prepared.bodyStart);
    identity = fields.map((span) => `${convertLatex(prepared.stripped.slice(span.start, span.end).replace(/^\\[A-Za-z]+\*?/, ""), ctx).replace(/\s*\n\s*/g, " ").trim()}`)
      .filter((line) => line !== "").map((line) => `${line}\n`).join("");
    identity = identity === "" ? "" : `${identity}\n`;
  }
  const text = tidyMarkdown(`${titleMd}${identity}${body.replace("@@BIBLIOGRAPHY@@", bib)}${body.includes("@@BIBLIOGRAPHY@@") ? "" : bib}`);
  return {
    arm: options.keepIdentity === true ? "format_only_md" : "structured_blind_md",
    text,
    redactions: options.keepIdentity === true ? metadataRedactions(prepared, true).filter((entry) => entry.kind === "comment") : metadataRedactions(prepared, true),
    figuresNotEvaluated: ctx.figures,
    notes: ctx.notes,
  };
}

/** 朴素方案：同一 Markdown 转写（身份字段作为普通文字行），再按全局关键词整行删除 */
export function projectNaive(bundle: LatexSourceBundle): ProjectionOutput {
  const prepared = prepare(bundle);
  const ctx: ConvertContext = { macros: collectMacros(prepared.preamble), figures: 0, notes: [] };
  const titleMd = prepared.title === null ? "" : `# ${convertLatex(prepared.title, ctx).replace(/\s*\n\s*/g, " ").trim()}\n\n`;
  const frontFields = prepared.spans.filter((span) => span.start < prepared.bodyStart && span.kind !== "date")
    .map((span) => convertLatex(prepared.stripped.slice(span.start, span.end).replace(/^\\[A-Za-z]+\*?/, ""), ctx).trim()).join("\n");
  const body = convertBodyWithout(prepared, false, ctx);
  const bib = renderBibliographySection(bundle, citedKeys(prepared.stripped), ctx);
  const converted = tidyMarkdown(`${titleMd}${frontFields}\n\n${body.replace("@@BIBLIOGRAPHY@@", bib)}${body.includes("@@BIBLIOGRAPHY@@") ? "" : bib}`);
  const redactions: Redaction[] = prepared.comments.map((comment) => ({ kind: "comment" as const, line: comment.line, excerpt: comment.text.slice(0, 400) }));
  const kept: string[] = [];
  converted.split("\n").forEach((line, index) => {
    const hit = NAIVE_METADATA_PATTERN.exec(line);
    if (hit !== null) {
      redactions.push({ kind: "naive_keyword_line", line: index + 1, excerpt: line.slice(0, 400), matched: hit[0] });
      return;
    }
    kept.push(line);
  });
  return { arm: "naive_text", text: tidyMarkdown(kept.join("\n")), redactions, figuresNotEvaluated: ctx.figures, notes: ["line numbers of naive_keyword_line refer to the converted Markdown before deletion"] };
}

// ---------------------------------------------------------------------------
// PDF 文本层（期刊 PDF）：同一文本基底上的字段 span 移除

/**
 * PDF 文本的字段级移除（同一文本基底；不做全局关键词删除）：
 *  - 每页重复（≥3 次）的期刊页眉 / 卷期行 / 作者页眉（「某某，等：题名」）；
 *  - 首页中文题名之后、「摘要」之前的作者行 / 单位行 / 通信作者行与卷期行；
 *  - 英文题名之后、「Abstract」之前的作者行（大写姓 + 名）与单位行；
 *  - 行首字段标签（基金项目 / 作者简介 / 收稿 / 修回日期 / 文献标志码 / 中图分类号 / doi / 文章编号 /
 *    引用格式 / E-mail）；只有基金 / 作者简介 / 引用格式允许最多 4 行续行（上一行未以句末标点结束）。
 * 正文、参考文献、表格文字（PDF 中已被拍平）一律不动。
 */
const PDF_FIELD_LABELS: Array<{ pattern: RegExp; kind: RedactionKind; continues: boolean }> = [
  { pattern: /^\s*(基金项目|Foundation items?|Fund(ed|ing)?\s*[:：])/i, kind: "funding", continues: true },
  { pattern: /^\s*作者简介/, kind: "author", continues: true },
  { pattern: /^\s*(引用格式|Citation)\s*[:：]/i, kind: "submission_metadata", continues: true },
  { pattern: /^\s*(收稿日期|修回日期|录用日期|网络出版|Received|Revised|Accepted)\s*[:：]/i, kind: "submission_metadata", continues: false },
  { pattern: /^\s*(文献标志码|文献标识码|中图分类号|文章编号|doi\s*[:：]|DOI\s*[:：])/i, kind: "submission_metadata", continues: false },
  { pattern: /^\s*\+?\s*(E-?mail|通信作者|通讯作者|Corresponding author)/i, kind: "email", continues: false },
];

const CJK_RUN = /[一-鿿]/g;

export function projectPdfTextBlind(text: string, options: { journalNames?: string[] } = {}): ProjectionOutput {
  const lines = text.split("\n");
  const drop = new Map<number, RedactionKind>();
  const journal = new RegExp(`(${["计算机工程与应用", "Computer Engineering and Applications", "www\\.ceaj\\.org", ...(options.journalNames ?? [])].join("|")})`, "i");
  const volume = /^\s*\d{4}\s*[，,]\s*\d+\s*[（(]\s*\d+\s*[）)]\s*$/;
  const counts = new Map<string, number>();
  for (const line of lines) {
    const key = line.trim();
    if (key.length >= 4) counts.set(key, (counts.get(key) ?? 0) + 1);
  }
  lines.forEach((line, index) => {
    const key = line.trim();
    if ((counts.get(key) ?? 0) < 3) return;
    if (journal.test(key) || volume.test(key) || /[，,]\s*等\s*[:：]|et al\.\s*[:：]/.test(key)) drop.set(index, "running_header");
  });
  // 首页范围
  const pageTwo = lines.findIndex((line) => /^\s*-{2,}\s*page\s*2\b/i.test(line));
  const pageOneEnd = pageTwo > 0 ? pageTwo : Math.min(lines.length, 120);
  const zhAbstract = lines.findIndex((line, index) => index < pageOneEnd && (/^\s*摘\s*要\s*[:：]/.test(line) || (line.trim() === "摘" && /^\s*要\s*[:：]/.test(lines[index + 1] ?? ""))));
  if (zhAbstract > 0) {
    // 题名 = 摘要之前 CJK 字数最多的一行；其后到摘要之间是作者 / 单位 / 通信作者
    let titleIndex = -1;
    let best = 0;
    for (let index = 0; index < zhAbstract; index += 1) {
      const cjk = (lines[index]!.match(CJK_RUN) ?? []).length;
      if (cjk > best && !/(大学|学院|研究院|研究所|实验室|E-?mail)/.test(lines[index]!)) {
        best = cjk;
        titleIndex = index;
      }
    }
    for (let index = 0; index < zhAbstract; index += 1) {
      const line = lines[index]!.trim();
      if (index === titleIndex || line === "" || /^-{2,}\s*page/i.test(line) || /^⦾.*⦾$/.test(line)) continue;
      if (volume.test(line)) drop.set(index, "submission_metadata");
      else if (/E-?mail|通信作者|通讯作者/.test(line)) drop.set(index, "email");
      else if (index > titleIndex && (/^\d+\s*[.．]/.test(line) || /\d{6}/.test(line)) && /(大学|学院|研究|实验室|公司|中心|院|所|\d{6})/.test(line)) drop.set(index, "affiliation");
      else if (index > titleIndex && /^[一-鿿0-9，,、+*＊\s]{1,40}$/.test(line)) drop.set(index, "author");
    }
  }
  const enAbstract = lines.findIndex((line, index) => index < pageOneEnd && /^\s*Abstract\s*[:：]/i.test(line));
  if (enAbstract > 0) {
    const start = Math.max(zhAbstract, 0);
    const doi = lines.findIndex((line, index) => index > start && index < enAbstract && /^\s*doi\s*[:：]/i.test(line));
    let sawAuthor = false;
    for (let index = (doi > 0 ? doi + 1 : Math.max(0, enAbstract - 12)); index < enAbstract; index += 1) {
      const line = lines[index]!.trim();
      if (line === "" || drop.has(index)) continue;
      const authorLike = /\b[A-Z]{2,}\s+[A-Z][a-z]+/.test(line) || /^[\d，,+¹²³⁴\s]+$/.test(line) || (sawAuthor && /^[\d，,+¹²³⁴\s]*,?\s*[A-Z]{2,}\b/.test(line));
      const affiliation = (/^\d+\s*[.．]/.test(line) && /(School|University|Laborator|Institute|College|Academy|Department|Company|Center|Centre)/i.test(line)) || (/\b\d{6}\b/.test(line) && /China|Province/.test(line));
      if (affiliation) drop.set(index, "affiliation");
      else if (authorLike) {
        sawAuthor = true;
        drop.set(index, "author");
      }
    }
  }
  for (let index = 0; index < lines.length; index += 1) {
    const label = PDF_FIELD_LABELS.find((entry) => entry.pattern.test(lines[index]!));
    if (label === undefined) continue;
    drop.set(index, label.kind);
    if (!label.continues) continue;
    for (let next = index + 1, taken = 0; next < lines.length && taken < 4; next += 1, taken += 1) {
      const previous = lines[next - 1]!.trim();
      const line = lines[next]!;
      if (/[。；;.]$/.test(previous) || line.trim() === "" || /^\s*-{2,}\s*page/i.test(line) || PDF_FIELD_LABELS.some((entry) => entry.pattern.test(line))) break;
      drop.set(next, label.kind);
    }
  }
  const redactions: Redaction[] = [];
  const kept: string[] = [];
  lines.forEach((line, index) => {
    const kind = drop.get(index);
    if (kind !== undefined) redactions.push({ kind, line: index + 1, excerpt: line.slice(0, 400) });
    else kept.push(line);
  });
  return { arm: "structured_blind_md", text: kept.join("\n"), redactions, figuresNotEvaluated: 0, notes: ["pdf_text_basis: 表格 / 公式在 PDF 文本层中已被拍平，所有臂同等 conversion_loss"] };
}

export function projectPdfTextNaive(text: string): ProjectionOutput {
  const redactions: Redaction[] = [];
  const kept: string[] = [];
  text.split("\n").forEach((line, index) => {
    const hit = NAIVE_METADATA_PATTERN.exec(line);
    if (hit !== null) redactions.push({ kind: "naive_keyword_line", line: index + 1, excerpt: line.slice(0, 400), matched: hit[0] });
    else kept.push(line);
  });
  return { arm: "naive_text", text: kept.join("\n"), redactions, figuresNotEvaluated: 0, notes: ["pdf_text_basis"] };
}
