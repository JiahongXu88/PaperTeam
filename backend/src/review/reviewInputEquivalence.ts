/**
 * M14.9.1 B3：Reviewer 输入投影的确定性内容等价门（零模型调用）。
 *
 * 科研内容清单（inventory）由**独立于转写器**的正则抽取从原稿得到：数值（含百分比 / 统计量）、
 * 数学块、引用键、图表题注、表格（逐表数值）、章节标题、参考文献条目与正文词元。投影臂必须
 * 逐项保留（字段级授权删除的元数据 span 除外）；任何科研数值 / 公式 / 引用 / 题注 / 参考文献缺失
 * → INVALID_INPUT，该臂不得进入评分比较。不要求逐字节相同，只要求科学内容可见性等价且差异可追溯。
 */

import { citedKeys, findMetadataSpans, readGroup, renderBibEntries, stripLatexComments, type LatexSourceBundle, type ProjectionOutput } from "./blindReviewInput.js";
import { cjkCount, isMetadataLine, looksLikeBody } from "./inputFidelityText.js";

export interface ScientificInventory {
  basis: "latex" | "pdf_text";
  numbers: Map<string, number>;
  math: Array<{ line: number; normalized: string }>;
  citations: Map<string, number>;
  captions: Array<{ line: number; tokens: string[] }>;
  tables: Array<{ line: number; numbers: string[] }>;
  figures: number;
  sections: Array<{ line: number; title: string }>;
  references: string[];
  tokens: Map<string, number>;
  /** 授权移除（元数据 span）里出现的数值——不算缺失，单独审计 */
  authorizedRemovedNumbers: string[];
  /**
   * M14.9.3：授权移除的原文（PDF 文本层：连续被删行合并为一段）。M14.9.1 只把它们排除出清单，
   * 被误删的正文因此从未进入「应保留」集合；删除侧审计据此复核每段删除是否真是元数据。
   */
  authorizedRemovedRuns?: Array<{ firstLine: number; text: string }>;
}

export interface EquivalenceReport {
  arm: string;
  status: "VALID" | "INVALID_INPUT";
  reasons: string[];
  conversionLoss: boolean;
  metrics: {
    numbersTotal: number; numbersMissing: number;
    mathTotal: number; mathRetained: number;
    citationsTotal: number; citationsMissing: number;
    captionsTotal: number; captionsRetained: number;
    tablesTotal: number; tablesRetained: number;
    figuresTotal: number; figureMarkers: number;
    sectionsTotal: number; sectionsRetained: number;
    referencesTotal: number; referencesRetained: number;
    tokenCoverage: number;
    redactions: Record<string, number>;
  };
  missing: { numbers: string[]; math: string[]; citations: string[]; captions: number[]; tables: number[]; sections: string[]; references: string[]; tokens: string[] };
  lineage: Array<{ kind: "section" | "math" | "table" | "caption"; sourceLine: number; projectedOffset: number | null; status: "retained" | "missing" }>;
}

// ---- 词元化（两侧同一函数） ----

const NUMBER = /(?<![A-Za-z0-9_\\])\.?\d+(?:[.,]\d+)*/g;

export function numberTokens(text: string): string[] {
  return [...text.replace(/[{}]/g, "").matchAll(NUMBER)].map((match) => match[0].replace(/,(?=\d{3}\b)/g, ""));
}

function wordTokens(text: string): string[] {
  const out: string[] = [];
  for (const match of text.matchAll(/[A-Za-z]{2,}|[一-鿿]/g)) out.push(match[0].toLowerCase());
  return out;
}

function multiset(items: string[]): Map<string, number> {
  const map = new Map<string, number>();
  for (const item of items) map.set(item, (map.get(item) ?? 0) + 1);
  return map;
}

function normalizeMath(text: string): string {
  return text.replace(/\\label\s*\{[^}]*\}/g, "").replace(/\\(nonumber|notag)\b/g, "").replace(/\s+/g, "");
}

function lineOf(src: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < src.length; index += 1) if (src[index] === "\n") line += 1;
  return line;
}

/** 只影响版式的命令（连同参数）——两侧都不计入科研清单 */
const LAYOUT_PATTERNS: RegExp[] = [
  /\\(label|ref|eqref|autoref|cref|Cref|pageref|nameref|bibliographystyle|bibliography|graphicspath|usepackage|documentclass|pagestyle|thispagestyle)\s*\{[^}]*\}/g,
  /\\(cite[a-zA-Z]*|Cite[a-zA-Z]*|citnum|parencite|textcite|autocite|nocite|upcite)\*?\s*(\[[^\]]*\]\s*){0,2}\{[^}]*\}/g,
  /\\includegraphics\s*(\[[^\]]*\])?\s*\{[^}]*\}/g,
  /\\(vspace|hspace|linespread|enlargethispage)\*?\s*\{[^}]*\}/g,
  /\\(captionsetup|hypersetup|setcitestyle|graphicspath)\s*(\[[^\]]*\])?\s*\{[^}]*\}/g,
  /\\setlength\s*\\[A-Za-z@]+\s*\{[^}]*\}/g,
  /\\(setlength|addtolength|setcounter|addtocounter|fontsize|rule)\s*\{[^}]*\}\s*\{[^}]*\}/g,
  /\\(cline|cmidrule)\s*(\([^)]*\))?\s*\{[^}]*\}/g,
  /\\addlinespace\s*(\[[^\]]*\])?/g,
  /\\(multicolumn|multirow)\s*\{[^}]*\}\s*\{[^}]*\}/g,
  /\\(resizebox|scalebox)\s*\{[^}]*\}(\s*\{[^}]*\})?/g,
  /\\(textcolor|color|colorbox)\s*\{[^}]*\}/g,
  /\\parbox\s*(\[[^\]]*\])?\s*\{[^}]*\}/g,
  /\\begin\{(table|table\*|figure|figure\*|minipage|wrapfigure|subfigure|adjustbox)\}\s*(\[[^\]]*\])?(\s*\{[^}]*\})?/g,
  /\\begin\{(tabular|tabularx|tabular\*|array|longtable)\}\s*(\{[^}]*\}\s*)?(\[[^\]]*\]\s*)?\{[^{}]*(\{[^{}]*\}[^{}]*)*\}/g,
  /\\\\\s*\[[^\]]*\]/g,
  /\\bibitem\s*(\[[^\]]*\])?\s*\{[^}]*\}/g,
  /\\begin\{thebibliography\}\s*\{[^}]*\}/g,
  /\\(rowcolor|cellcolor|columncolor|arrayrulecolor|aboverulesepcolor|belowrulesepcolor)\s*(\[[^\]]*\])?\s*\{[^}]*\}/g,
  /\{[A-Za-z]+![0-9]+(![A-Za-z]+)?\}/g,
  /\\renewcommand\s*\{?\\arraystretch\}?\s*\{[^}]*\}/g,
  /\\\\(?=\s)/g,
  /\\[a-zA-Z@]+\*?/g,
  /\\begin|\\end/g,
];

export function visibleLatex(text: string): string {
  let out = text;
  for (const pattern of LAYOUT_PATTERNS) out = out.replace(pattern, " ");
  // 环境名残留（\begin 去掉后剩 {equation}）
  return out.replace(/\{(equation|align|gather|multline|tabular|table|figure|itemize|enumerate|abstract|center|thebibliography|document|minipage|algorithm|algorithmic|description|subfigure|threeparttable|tablenotes|eqnarray|split|cases|array|matrix|pmatrix|bmatrix)\*?\}/g, " ");
}

export function visibleProjected(text: string): string {
  return text
    .replace(/\{#[^}]*\}/g, " ")
    .replace(/\[ref:[^\]]*\]/g, " ")
    .replace(/\[@[^\]]*\]/g, (whole) => " ".repeat(Math.min(1, whole.length)))
    .replace(/\\label\s*\{[^}]*\}/g, " ")
    .replace(/\\[a-zA-Z@]+\*?/g, " ")
    .replace(/\\begin|\\end/g, " ")
    .replace(/\{(equation|align|gather|multline|eqnarray|split|cases|array|matrix|pmatrix|bmatrix)\*?\}/g, " ");
}

const DISPLAY_ENVS = "equation|equation\\*|align|align\\*|gather|gather\\*|multline|multline\\*|eqnarray|eqnarray\\*|displaymath|flalign|flalign\\*|alignat|alignat\\*";

function extractMath(text: string): Array<{ offset: number; body: string }> {
  const out: Array<{ offset: number; body: string }> = [];
  const masked = text.split("");
  const take = (pattern: RegExp, group: number) => {
    for (const match of text.matchAll(pattern)) {
      const start = match.index!;
      if (masked[start] === "") continue;
      out.push({ offset: start, body: match[group] ?? "" });
      for (let index = start; index < start + match[0].length; index += 1) masked[index] = "";
    }
  };
  take(new RegExp(`\\\\begin\\{(${DISPLAY_ENVS})\\}([\\s\\S]*?)\\\\end\\{\\1\\}`, "g"), 2);
  take(/\$\$([\s\S]*?)\$\$/g, 1);
  take(/\\\[([\s\S]*?)\\\]/g, 1);
  take(/\\\(([\s\S]*?)\\\)/g, 1);
  const rest = masked.join("");
  for (const match of rest.matchAll(/(?<!\\)\$([^$]+?)(?<!\\)\$/g)) out.push({ offset: match.index!, body: match[1]! });
  return out.filter((entry) => normalizeMath(entry.body) !== "");
}

/** LaTeX 原稿的科研内容清单（题名 + 正文 + 参考文献；授权元数据 span 与注释除外） */
export function latexInventory(bundle: LatexSourceBundle): ScientificInventory {
  const { text } = stripLatexComments(bundle.main);
  const spans = findMetadataSpans(text);
  const authorizedRemovedNumbers = spans.flatMap((span) => numberTokens(visibleLatex(text.slice(span.start, span.end))));
  // 元数据 span 以等长空白替换：保持偏移与行号
  let masked = text;
  for (const span of spans) masked = masked.slice(0, span.start) + masked.slice(span.start, span.end).replace(/[^\n]/g, " ") + masked.slice(span.end);
  const begin = /\\begin\{document\}/.exec(masked);
  const endDoc = masked.lastIndexOf("\\end{document}");
  const bodyStart = begin === null ? 0 : begin.index + begin[0].length;
  const bodyEnd = endDoc < 0 ? masked.length : endDoc;
  const titleMatch = /\\title\s*(\[[^\]]*\])?\s*\{/.exec(masked);
  const titleGroup = titleMatch === null ? null : readGroup(masked, titleMatch.index + titleMatch[0].length - 1);
  const title = titleGroup?.content ?? "";
  // 题名单独计入一次（\title 可能写在 \begin{document} 之后）
  if (titleMatch !== null && titleGroup !== null) {
    masked = masked.slice(0, titleMatch.index) + masked.slice(titleMatch.index, titleGroup.end).replace(/[^\n]/g, " ") + masked.slice(titleGroup.end);
  }
  // 正文前补等量换行，使 body 内偏移的行号 = 源文件行号
  const body = "\n".repeat(lineOf(masked, bodyStart) - 1) + masked.slice(bodyStart, bodyEnd);
  let bibliographyText = "";
  const references: string[] = [];
  if (bundle.bibliography?.kind === "bbl") {
    bibliographyText = bundle.bibliography.content;
    for (const match of bibliographyText.matchAll(/\\bibitem\s*(\[[^\]]*\])?\s*\{([^}]*)\}/g)) references.push(match[2]!.trim());
  } else if (bundle.bibliography?.kind === "bib") {
    const entries = renderBibEntries(bundle.bibliography.content, citedKeys(text));
    bibliographyText = entries.map((entry) => entry.text).join("\n");
    references.push(...entries.map((entry) => entry.key));
  }
  for (const match of body.matchAll(/\\bibitem\s*(\[[^\]]*\])?\s*\{([^}]*)\}/g)) references.push(match[2]!.trim());
  const scientific = `${title}\n${body}\n${bibliographyText}`;
  const math = extractMath(body).map((entry) => ({ line: lineOf(body, entry.offset), normalized: normalizeMath(entry.body) }));
  const captions: ScientificInventory["captions"] = [];
  for (const match of body.matchAll(/\\(caption|subcaption)\s*(\[[^\]]*\])?\s*\{/g)) {
    const group = readGroup(body, match.index! + match[0].length - 1);
    if (group !== null) captions.push({ line: lineOf(body, match.index!), tokens: [...numberTokens(visibleLatex(group.content)), ...wordTokens(visibleLatex(group.content))] });
  }
  const tables: ScientificInventory["tables"] = [];
  for (const match of body.matchAll(/\\begin\{(tabular|tabularx|tabular\*|longtable)\}([\s\S]*?)\\end\{\1\}/g)) {
    tables.push({ line: lineOf(body, match.index!), numbers: numberTokens(visibleLatex(match[0])) });
  }
  const sections: ScientificInventory["sections"] = [];
  for (const match of body.matchAll(/\\(chapter|section|subsection|subsubsection)\*?\s*(\[[^\]]*\])?\s*\{/g)) {
    const group = readGroup(body, match.index! + match[0].length - 1);
    if (group !== null) sections.push({ line: lineOf(body, match.index!), title: visibleLatex(group.content).replace(/\s+/g, " ").trim() });
  }
  const visible = visibleLatex(scientific);
  return {
    basis: "latex",
    numbers: multiset(numberTokens(visible)),
    math,
    citations: multiset([...body.matchAll(/\\(?:cite[a-zA-Z]*|Cite[a-zA-Z]*|citnum|parencite|textcite|autocite|upcite)\*?\s*(?:\[[^\]]*\]\s*){0,2}\{([^}]*)\}/g)]
      .flatMap((match) => match[1]!.split(",").map((key) => key.trim()).filter((key) => key !== ""))),
    captions,
    tables,
    figures: [...body.matchAll(/\\begin\{(figure|figure\*|wrapfigure)\}/g)].length,
    sections,
    references,
    tokens: multiset(wordTokens(visible)),
    authorizedRemovedNumbers,
  };
}

/** PDF 文本层的清单（行文本；授权删除行由候选方案的字段 span 给出） */
export function pdfTextInventory(text: string, authorizedDroppedLines: ReadonlySet<number>): ScientificInventory {
  const lines = text.split("\n");
  const kept = lines.filter((_line, index) => !authorizedDroppedLines.has(index + 1)).join("\n");
  const dropped = lines.filter((_line, index) => authorizedDroppedLines.has(index + 1)).join("\n");
  const authorizedRemovedRuns: Array<{ firstLine: number; text: string }> = [];
  lines.forEach((line, index) => {
    if (!authorizedDroppedLines.has(index + 1)) return;
    const last = authorizedRemovedRuns[authorizedRemovedRuns.length - 1];
    if (last !== undefined && authorizedDroppedLines.has(index)) last.text += `\n${line}`;
    else authorizedRemovedRuns.push({ firstLine: index + 1, text: line });
  });
  return {
    basis: "pdf_text",
    numbers: multiset(numberTokens(kept)),
    math: [], citations: new Map(), captions: [], tables: [], figures: 0, sections: [], references: [],
    tokens: multiset(wordTokens(kept)),
    authorizedRemovedNumbers: numberTokens(dropped),
    authorizedRemovedRuns,
  };
}

/**
 * M14.9.3 删除侧审计：一段「授权删除」扣除元数据字段片段后仍像正文（≥40 汉字带句读 / ≥35 英文词）
 * → 删除越界。保留侧清单完整不等于删除合法——被删正文根本不在清单里。
 */
export function auditAuthorizedRemovals(inventory: ScientificInventory): Array<{ firstLine: number; bodyChars: number; excerpt: string }> {
  const out: Array<{ firstLine: number; bodyChars: number; excerpt: string }> = [];
  for (const run of inventory.authorizedRemovedRuns ?? []) {
    // 逐行剔除可证明的元数据 / 署名行，余下的连续被删行拼接后仍像正文 → 越界
    const residual = run.text.split("\n").filter((line) => !isMetadataLine(line)).join("");
    if (looksLikeBody(residual)) out.push({ firstLine: run.firstLine, bodyChars: cjkCount(residual) || residual.length, excerpt: residual.slice(0, 80) });
  }
  return out;
}

/** 对一个投影臂执行等价门（raw 臂即原稿本身：按定义等价，只报告清单规模） */
export function checkEquivalence(inventory: ScientificInventory, projection: ProjectionOutput): EquivalenceReport {
  if (projection.arm === "raw") return rawIdentityReport(inventory);
  const projected = projection.text;
  const visible = visibleProjected(projected);
  const projectedNumbers = multiset(numberTokens(visible));
  const projectedTokens = multiset(wordTokens(visible));
  const compact = projected.replace(/\s+/g, "");
  const reasons: string[] = [];
  const lineage: EquivalenceReport["lineage"] = [];

  const missingNumbers: string[] = [];
  let numbersTotal = 0;
  for (const [token, count] of inventory.numbers) {
    numbersTotal += count;
    const lost = count - (projectedNumbers.get(token) ?? 0);
    for (let index = 0; index < lost; index += 1) missingNumbers.push(token);
  }
  const missingMath: string[] = [];
  let mathRetained = 0;
  for (const entry of inventory.math) {
    const at = compact.indexOf(entry.normalized);
    const retained = at >= 0 || normalizeMath(compact).includes(entry.normalized);
    if (retained) mathRetained += 1;
    else missingMath.push(entry.normalized.slice(0, 120));
    lineage.push({ kind: "math", sourceLine: entry.line, projectedOffset: at >= 0 ? at : null, status: retained ? "retained" : "missing" });
  }
  const projectedCitations = multiset([...projected.matchAll(/@([^\s;\]]+)/g)].map((match) => match[1]!));
  const missingCitations: string[] = [];
  let citationsTotal = 0;
  for (const [key, count] of inventory.citations) {
    citationsTotal += count;
    if ((projectedCitations.get(key) ?? 0) < count) missingCitations.push(key);
  }
  const missingCaptions: number[] = [];
  let captionsRetained = 0;
  for (const caption of inventory.captions) {
    const covered = caption.tokens.every((token) => (/^\d/.test(token) ? (projectedNumbers.get(token) ?? 0) > 0 : (projectedTokens.get(token) ?? 0) > 0));
    if (covered) captionsRetained += 1;
    else missingCaptions.push(caption.line);
    lineage.push({ kind: "caption", sourceLine: caption.line, projectedOffset: null, status: covered ? "retained" : "missing" });
  }
  // 逐表：原表的数值多重集必须在投影的 Markdown 表格块中完整出现（按出现顺序一一对应）
  const projectedTables = [...projected.matchAll(/(?:^\|.*\|\s*$\n?)+/gm)].map((match) => ({ offset: match.index!, numbers: multiset(numberTokens(visibleProjected(match[0]))) }));
  const missingTables: number[] = [];
  let tablesRetained = 0;
  let cursor = 0;
  for (const table of inventory.tables) {
    const need = multiset(table.numbers);
    let found = -1;
    for (let index = cursor; index < projectedTables.length; index += 1) {
      const candidate = projectedTables[index]!;
      if ([...need].every(([token, count]) => (candidate.numbers.get(token) ?? 0) >= count)) {
        found = index;
        break;
      }
    }
    if (found >= 0 || (inventory.basis === "latex" && table.numbers.length === 0 && projectedTables.length > cursor)) {
      tablesRetained += 1;
      lineage.push({ kind: "table", sourceLine: table.line, projectedOffset: found >= 0 ? projectedTables[found]!.offset : null, status: "retained" });
      if (found >= 0) cursor = found + 1;
    } else {
      missingTables.push(table.line);
      lineage.push({ kind: "table", sourceLine: table.line, projectedOffset: null, status: "missing" });
    }
  }
  const missingSections: string[] = [];
  let sectionsRetained = 0;
  for (const section of inventory.sections) {
    const needle = section.title.replace(/\s+/g, "");
    const at = needle === "" ? 0 : compact.indexOf(needle);
    const tokensCovered = wordTokens(section.title).every((token) => (projectedTokens.get(token) ?? 0) > 0);
    const retained = at >= 0 || tokensCovered;
    if (retained) sectionsRetained += 1;
    else missingSections.push(section.title);
    lineage.push({ kind: "section", sourceLine: section.line, projectedOffset: at >= 0 ? at : null, status: retained ? "retained" : "missing" });
  }
  const missingReferences = inventory.references.filter((key) => !projected.includes(`@${key}`) && !projected.includes(`{${key}}`));
  let tokenTotal = 0;
  let tokenKept = 0;
  const missingTokens = new Map<string, number>();
  for (const [token, count] of inventory.tokens) {
    tokenTotal += count;
    const kept = Math.min(count, projectedTokens.get(token) ?? 0);
    tokenKept += kept;
    if (kept < count) missingTokens.set(token, count - kept);
  }
  const tokenCoverage = tokenTotal === 0 ? 1 : tokenKept / tokenTotal;
  const figureMarkers = (projected.match(/FIGURE_CONTENT_NOT_EVALUATED/g) ?? []).length;

  if (missingNumbers.length > 0) reasons.push(`科研数值缺失 ${missingNumbers.length} 个`);
  if (missingMath.length > 0) reasons.push(`公式缺失 ${missingMath.length}/${inventory.math.length}`);
  if (missingCitations.length > 0) reasons.push(`引用键缺失 ${missingCitations.length}`);
  if (missingCaptions.length > 0) reasons.push(`图表题注缺失 ${missingCaptions.length}/${inventory.captions.length}`);
  if (missingTables.length > 0) reasons.push(`表格数值不完整 ${missingTables.length}/${inventory.tables.length}`);
  if (missingSections.length > 0) reasons.push(`章节标题缺失 ${missingSections.length}`);
  if (missingReferences.length > 0) reasons.push(`参考文献条目缺失 ${missingReferences.length}/${inventory.references.length}`);
  if (inventory.basis === "latex" && inventory.figures > 0 && figureMarkers < inventory.figures) reasons.push(`图占位标记 ${figureMarkers} < 图 ${inventory.figures}`);
  if (tokenCoverage < 0.995) reasons.push(`正文词元覆盖率 ${(tokenCoverage * 100).toFixed(2)}% < 99.5%`);
  const overRemoved = auditAuthorizedRemovals(inventory);
  if (overRemoved.length > 0) reasons.push(`授权删除越界：${overRemoved.length} 段被删文本扣除元数据后仍是正文（首段第 ${overRemoved[0]!.firstLine} 行：${overRemoved[0]!.excerpt.slice(0, 30)}…）`);

  const redactions: Record<string, number> = {};
  for (const redaction of projection.redactions) redactions[redaction.kind] = (redactions[redaction.kind] ?? 0) + 1;
  return {
    arm: projection.arm,
    status: reasons.length === 0 ? "VALID" : "INVALID_INPUT",
    reasons,
    conversionLoss: inventory.basis === "pdf_text",
    metrics: {
      numbersTotal, numbersMissing: missingNumbers.length,
      mathTotal: inventory.math.length, mathRetained,
      citationsTotal, citationsMissing: missingCitations.length,
      captionsTotal: inventory.captions.length, captionsRetained,
      tablesTotal: inventory.tables.length, tablesRetained,
      figuresTotal: inventory.figures, figureMarkers,
      sectionsTotal: inventory.sections.length, sectionsRetained,
      referencesTotal: inventory.references.length, referencesRetained: inventory.references.length - missingReferences.length,
      tokenCoverage: Number(tokenCoverage.toFixed(5)),
      redactions,
    },
    missing: {
      numbers: [...new Set(missingNumbers)].slice(0, 40),
      math: missingMath.slice(0, 10),
      citations: missingCitations.slice(0, 20),
      captions: missingCaptions,
      tables: missingTables,
      sections: missingSections,
      references: missingReferences.slice(0, 20),
      tokens: [...missingTokens.entries()].sort((a, b) => b[1] - a[1]).slice(0, 30).map(([token, count]) => `${token}×${count}`),
    },
    lineage,
  };
}

function sum(map: Map<string, number>): number {
  let total = 0;
  for (const value of map.values()) total += value;
  return total;
}

function rawIdentityReport(inventory: ScientificInventory): EquivalenceReport {
  return {
    arm: "raw",
    status: "VALID",
    reasons: [],
    conversionLoss: inventory.basis === "pdf_text",
    metrics: {
      numbersTotal: sum(inventory.numbers), numbersMissing: 0,
      mathTotal: inventory.math.length, mathRetained: inventory.math.length,
      citationsTotal: sum(inventory.citations), citationsMissing: 0,
      captionsTotal: inventory.captions.length, captionsRetained: inventory.captions.length,
      tablesTotal: inventory.tables.length, tablesRetained: inventory.tables.length,
      figuresTotal: inventory.figures, figureMarkers: 0,
      sectionsTotal: inventory.sections.length, sectionsRetained: inventory.sections.length,
      referencesTotal: inventory.references.length, referencesRetained: inventory.references.length,
      tokenCoverage: 1,
      redactions: {},
    },
    missing: { numbers: [], math: [], citations: [], captions: [], tables: [], sections: [], references: [], tokens: [] },
    lineage: [],
  };
}
