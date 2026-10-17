/**
 * 内联参考文献（`\begin{thebibliography} … \bibitem{key} 文本 … \end{thebibliography}`）。
 *
 * 中文期刊（GB/T 7714 顺序编码制）的 LaTeX 稿件普遍不用 .bib，而是把参考文献
 * 直接写在 thebibliography 环境里。此前 collectLatexFiles 只认
 * `\bibliography{}` / `\addbibresource{}`：这类稿件的每个 `\cite` 都被判成
 * missingKey（citation_structure_valid 误阻断），元数据核验也拿不到任何条目，
 * Writer 的「允许引用的 key」清单为空（M14.8-MOT 真实论文暴露）。
 *
 * 这里把每个 `\bibitem` 解析为与 .bib 条目同形的摘要（key 必有；题名 / 年份 /
 * DOI 按 GB/T 7714 文献类型标识 `[J]` `[C]` `[M]` `[J/OL]` … 尽力提取，提取不到
 * 就缺省——缺省只影响元数据核验能否发起，不影响 key 的存在性）。
 * 渲染出的 BibTeX 文本只在内存中供解析复用，**从不写回稿件**：稿件的事实源仍是
 * thebibliography 环境本身。
 */

export interface InlineBibItem {
  key: string;
  /** 条目原文（去掉 LaTeX 标记后的纯文本） */
  text: string;
  title?: string;
  year?: number;
  doi?: string;
  /** 由文献类型标识推断的 BibTeX 类型 */
  type: string;
}

const ENVIRONMENT = /\\begin\{thebibliography\}(?:\{[^}]*\})?([\s\S]*?)\\end\{thebibliography\}/g;
const BIBITEM = /\\bibitem\s*(?:\[[^\]]*\])?\s*\{([^}]+)\}/g;
/** GB/T 7714 文献类型标识（含 /OL 电子资源） */
const TYPE_MARKER = /\[(J|C|M|D|R|S|P|N|A|Z|G|EB|DB|CP|DS)(?:\/OL)?\]/;
const TYPE_BY_MARKER: Record<string, string> = { J: "article", C: "inproceedings", M: "book", D: "phdthesis", R: "techreport", S: "misc", P: "patent", N: "article", A: "incollection" };

export function hasInlineBibliography(tex: string): boolean {
  return /\\begin\{thebibliography\}/.test(stripComments(tex));
}

/** 提取全部 \bibitem（按出现顺序；同 key 重复只保留首个） */
export function extractInlineBibliography(tex: string): InlineBibItem[] {
  const items: InlineBibItem[] = [];
  const seen = new Set<string>();
  const source = stripComments(tex);
  let environment: RegExpExecArray | null;
  ENVIRONMENT.lastIndex = 0;
  while ((environment = ENVIRONMENT.exec(source)) !== null) {
    const body = environment[1] ?? "";
    const marks: Array<{ key: string; start: number; end: number }> = [];
    let match: RegExpExecArray | null;
    BIBITEM.lastIndex = 0;
    while ((match = BIBITEM.exec(body)) !== null) {
      marks.push({ key: (match[1] ?? "").trim(), start: match.index, end: match.index + match[0].length });
    }
    marks.forEach((mark, index) => {
      if (mark.key === "" || seen.has(mark.key)) return;
      seen.add(mark.key);
      const raw = body.slice(mark.end, index + 1 < marks.length ? marks[index + 1]!.start : body.length);
      items.push(describe(mark.key, plainText(raw)));
    });
  }
  return items;
}

function describe(key: string, text: string): InlineBibItem {
  const marker = TYPE_MARKER.exec(text);
  const item: InlineBibItem = { key, text, type: marker ? TYPE_BY_MARKER[marker[1] ?? ""] ?? "misc" : "misc" };
  if (marker !== null) {
    // 题名 = 类型标识之前、最后一个「. 」之后的片段（作者段以「. 」结束）
    const head = text.slice(0, marker.index);
    const cut = head.lastIndexOf(". ");
    const title = (cut >= 0 ? head.slice(cut + 2) : "").trim();
    if (title.length >= 4) item.title = title;
    const year = /\b(19|20)\d{2}\b/.exec(text.slice(marker.index));
    if (year !== null) item.year = Number.parseInt(year[0], 10);
  }
  const doi = /\b10\.\d{4,9}\/[^\s,;]+/i.exec(text);
  if (doi !== null) item.doi = doi[0].replace(/[.)\]]+$/, "");
  return item;
}

/** 渲染为 BibTeX 文本（仅供 parseBib 复用；值里的花括号已去除） */
export function renderInlineBibliographyAsBib(items: InlineBibItem[]): string {
  const value = (raw: string) => raw.replace(/[{}]/g, "");
  return items
    .map((item) => {
      const fields = [
        item.title !== undefined ? `  title = {${value(item.title)}}` : undefined,
        item.year !== undefined ? `  year = {${item.year}}` : undefined,
        item.doi !== undefined ? `  doi = {${value(item.doi)}}` : undefined,
        `  note = {${value(item.text)}}`,
      ].filter((field): field is string => field !== undefined);
      return `@${item.type}{${item.key},\n${fields.join(",\n")}\n}`;
    })
    .join("\n\n");
}

function stripComments(tex: string): string {
  return tex.replace(/(^|[^\\])%.*$/gm, "$1");
}

function plainText(raw: string): string {
  return raw
    .replace(/\\(?:url|href)\s*\{([^}]*)\}(?:\{[^}]*\})?/g, "$1")
    .replace(/\\(?:textit|textbf|emph|textrm|texttt|mathrm|mbox)\s*\{([^}]*)\}/g, "$1")
    .replace(/\\(?:small|footnotesize|normalsize|newblock|par)\b/g, " ")
    .replace(/~/g, " ")
    .replace(/--/g, "-")
    .replace(/\\([&%#_$])/g, "$1")
    .replace(/\\[a-zA-Z]+\*?/g, " ")
    .replace(/[{}$]/g, "")
    .replace(/\s+/g, " ")
    .trim();
}
