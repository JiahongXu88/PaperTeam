/**
 * M16 后续 · md-to-tex v2（基于 m16-closure/md-to-tex-fidelity.mjs 逐字复制后只改两处，原文件不动）：
 *   1. HTML 表格的 rowspan / colspan 还原为 \multirow / \multicolumn（v1 展平导致多级表头错位，确定性绑定正确地拒判）；
 *   2. 「Table N: …」题注段落移入浮动体为 \caption{…}——只有当全文题注编号恰为 1..k 且 k 等于表格数时才按序移入
 *      （否则整篇不加任何 caption，下游按表号解析一律 fail-closed），记 TABLE_CAPTIONS_ATTACHED / _SKIPPED。
 * 其余规则与 v1 完全相同。以下为 v1 原说明：
 *
 * M16 收口 · A：送审 Markdown（Marker / MinerU 转写稿）→ 单文件 main.tex 的保真适配器（确定性、零模型）。
 *
 * 取代 M15 `md_to_tex.mjs`（D:\PaperTeamData\M15\QualityGateCalibration\scripts，sha256 前缀见 LEGACY_ADAPTER）
 * 只用于 benchmark 输入。旧适配器对每个正文块整体调用 esc()：行内 `$\mu_k^n$` 被写成 `\$\textbackslash{}mu\_k\^{}n\$`，
 * 显示公式内部也被转义，HTML <table> 成为转义后的标签串，`# 1.1` 小节一律升为 \section。
 *
 * 规则（对所有论文相同）：
 * - 数学原样直通：`$$…$$`、`\[…\]`、`\(…\)`、行内 `$…$`、顶层 `\begin{equation|align|…}` 内容逐字保留，不转义、不改写；
 *   原稿本身可疑的数学（花括号 / \left\right / \begin\end 不配对、未闭合的 $）照样保留并记 SOURCE_* 诊断——归因原稿，不替作者修正。
 * - 只转义非数学正文；`\$` 视为字面美元；疑似货币的 `$…$`（无数学记号、含多个英文词）按文本处理并记录。
 * - 标题层级按编号深度（1 → section，1.1 → subsection，A.1 → subsection…），编号文本保留在标题里以便「Section 3.2」类引用可对应。
 * - HTML 表格 → tabular（rowspan / colspan 展平并记 LAYOUT_SIMPLIFIED），单元格内数学同样直通；图片 → 显式占位并记 FIGURE_NOT_READABLE。
 *
 *   node md-to-tex-fidelity.mjs <in.md> <out.tex> <zh|en>
 */
import { readFileSync, writeFileSync } from "node:fs";

export const LEGACY_ADAPTER = { path: "D:\\PaperTeamData\\M15\\QualityGateCalibration\\scripts\\md_to_tex.mjs", md5: "7b167b58c4a6dde332a656e9c1e32881" };

const ESC = { "\\": "\\textbackslash{}", "{": "\\{", "}": "\\}", $: "\\$", "&": "\\&", "#": "\\#", "%": "\\%", _: "\\_", "^": "\\^{}", "~": "\\~{}" };
export const escText = (s) => s.replace(/[\\{}$&#%_^~]/g, (c) => ESC[c]);

const ENTITY = { amp: "&", lt: "<", gt: ">", quot: '"', apos: "'", nbsp: " " };
export const decodeEntities = (s) =>
  s.replace(/&(#x[0-9a-f]+|#\d+|[a-z]+);/gi, (m, e) => {
    if (e[0] === "#") return String.fromCodePoint(e[1] === "x" || e[1] === "X" ? parseInt(e.slice(2), 16) : parseInt(e.slice(1), 10));
    return ENTITY[e.toLowerCase()] ?? m;
  });

const DISPLAY_ENVS = "equation|equation\\*|align|align\\*|gather|gather\\*|multline|multline\\*|eqnarray|eqnarray\\*|displaymath";
const MATH_HINT = /[\\^_{}=<>+|]|\d/;

/** 原稿数学的确定性可疑项（只诊断，不改写） */
export function mathSuspects(body) {
  const out = [];
  let depth = 0;
  let negative = false;
  const stripped = body.replace(/\\\\/g, "  ").replace(/\\[{}]/g, "  ");
  for (const c of stripped) {
    if (c === "{") depth += 1;
    else if (c === "}") {
      depth -= 1;
      if (depth < 0) negative = true;
    }
  }
  if (depth !== 0 || negative) out.push("SOURCE_MATH_UNBALANCED_BRACES");
  const left = (body.match(/\\left(?![a-z])/g) ?? []).length;
  const right = (body.match(/\\right(?![a-z])/g) ?? []).length;
  if (left !== right) out.push("SOURCE_MATH_LEFT_RIGHT_MISMATCH");
  const begins = [...body.matchAll(/\\begin\s*\{\s*([^}]*?)\s*\}/g)].map((m) => m[1].replace(/\s+/g, ""));
  const ends = [...body.matchAll(/\\end\s*\{\s*([^}]*?)\s*\}/g)].map((m) => m[1].replace(/\s+/g, ""));
  if (begins.join(",") !== ends.join(",")) out.push("SOURCE_MATH_ENV_MISMATCH");
  return out;
}

/**
 * 正文切分为 text / math 段（行内）。display 公式在块级先行抽出，这里只处理 `\(…\)`、`$…$`、`\$`。
 * 返回段落数组；math 段的 raw 为分隔符之间的原文。
 */
export function segmentInline(text, notes = []) {
  const segs = [];
  let buf = "";
  const flush = () => {
    if (buf !== "") segs.push({ type: "text", raw: buf });
    buf = "";
  };
  let i = 0;
  while (i < text.length) {
    const c = text[i];
    if (c === "\\" && text[i + 1] === "$") {
      buf += "$";
      i += 2;
      continue;
    }
    if (c === "\\" && text[i + 1] === "(") {
      const end = text.indexOf("\\)", i + 2);
      if (end > 0) {
        flush();
        segs.push({ type: "math", raw: text.slice(i + 2, end), delim: "\\(" });
        i = end + 2;
        continue;
      }
    }
    if (c === "$" && text[i + 1] !== "$") {
      let j = i + 1;
      let close = -1;
      while (j < text.length) {
        if (text[j] === "\\") {
          j += 2;
          continue;
        }
        if (text[j] === "\n" && text[j + 1] === "\n") break;
        if (text[j] === "$") {
          close = j;
          break;
        }
        j += 1;
      }
      const body = close > 0 ? text.slice(i + 1, close) : "";
      const prose = (body.match(/[A-Za-z]{3,}/g) ?? []).length >= 2 && !/[\\^_{}=]/.test(body);
      if (close > 0 && body.trim() !== "" && !/^\d/.test(text[close + 1] ?? "") && !prose && body.length <= 800) {
        flush();
        segs.push({ type: "math", raw: body, delim: "$" });
        i = close + 1;
        continue;
      }
      notes.push(close > 0 && prose ? "CURRENCY_DOLLAR_AS_TEXT" : "SOURCE_UNPAIRED_DOLLAR");
      buf += "$";
      i += 1;
      continue;
    }
    buf += c;
    i += 1;
  }
  flush();
  return segs;
}

/** 正文（含行内数学）→ LaTeX：文本转义，数学逐字直通 */
export function inlineToLatex(text, ctx) {
  return segmentInline(text, ctx.notes)
    .map((s) => {
      if (s.type === "text") {
        // 转写稿把 LaTeX 命令 / 上标写在数学分隔符之外（如 `Score(\cdot)`）：按原文字面转义，归因原稿转写
        if (/\\[A-Za-z]+|\^/.test(s.raw)) ctx.notes.push("SOURCE_LATEX_COMMAND_OUTSIDE_MATH");
        return textToLatex(s.raw);
      }
      ctx.math.push({ kind: "inline", raw: s.raw, suspects: mathSuspects(s.raw) });
      return `$${s.raw}$`;
    })
    .join("");
}

function textToLatex(raw) {
  const decoded = decodeEntities(raw);
  // <sup>/<sub> 是 Marker 对上下标正文的转写；其余 HTML 标签只去标签、保留文字
  const parts = decoded.split(/(<sup>[\s\S]*?<\/sup>|<sub>[\s\S]*?<\/sub>)/i);
  return parts
    .map((p) => {
      const m = /^<(sup|sub)>([\s\S]*?)<\/\1>$/i.exec(p);
      if (m) return `\\text${m[1].toLowerCase() === "sup" ? "superscript" : "subscript"}{${escBold(m[2])}}`;
      return escBold(p.replace(/<\/?[a-z][^>]*>/gi, ""));
    })
    .join("");
}

function escBold(s) {
  return s
    .split(/\*\*/)
    .map((p, i, arr) => (i % 2 === 1 && i < arr.length - 1 ? `\\textbf{${escText(p)}}` : escText(i % 2 === 1 ? `**${p}` : p)))
    .join("");
}

/** 标题层级：编号深度优先（MinerU 稿全是一级 #），否则用 Markdown 层级 */
export function headingLevel(hashes, text) {
  const numbered = /^(?:(\d+(?:\.\d+)*)|([A-Z](?:\.\d+)*))\.?\s+\S/.exec(text);
  if (numbered) {
    const depth = (numbered[1] ?? numbered[2]).split(".").length;
    return numbered[2] !== undefined ? Math.max(1, depth) : depth;
  }
  return Math.max(1, hashes - 1);
}

const HEADING_CMD = { 1: "section", 2: "subsection", 3: "subsubsection" };
const REFS = /^(参考文献|References|REFERENCES|Bibliography|BIBLIOGRAPHY)$/;

export const CAPTION_SLOT = "%%M16V2_CAPTION_SLOT%%";

function spanOf(attrs, name) {
  const m = new RegExp(`${name}\\s*=\\s*["']?(\\d+)`, "i").exec(attrs);
  return m ? Math.max(1, Number(m[1])) : 1;
}

function tableToLatex(html, ctx) {
  const rows = [...html.matchAll(/<tr[^>]*>([\s\S]*?)<\/tr>/gi)].map((r) => [...r[1].matchAll(/<t([dh])([^>]*)>([\s\S]*?)<\/t[dh]>/gi)].map((c) => ({ attrs: c[2], text: c[3], rowspan: spanOf(c[2], "rowspan"), colspan: spanOf(c[2], "colspan") })));
  // 网格占位：rowspan 向下占用、colspan 向右占用；下方被占用的格输出空单元（\multirow 的 LaTeX 约定）
  const grid = [];
  let width = 1;
  rows.forEach((row, r) => {
    grid[r] ??= [];
    let c = 0;
    for (const cell of row) {
      while (grid[r][c] !== undefined) c += 1;
      for (let dr = 0; dr < cell.rowspan; dr += 1) {
        grid[r + dr] ??= [];
        for (let dc = 0; dc < cell.colspan; dc += 1) grid[r + dr][c + dc] = dr === 0 && dc === 0 ? cell : dr === 0 ? "COVERED_RIGHT" : dc === 0 ? { below: true, colspan: cell.colspan } : "COVERED_BELOW_RIGHT";
      }
      c += cell.colspan;
      width = Math.max(width, c);
    }
  });
  width = Math.max(width, ...grid.map((g) => g.length));
  if (rows.some((r) => r.some((c) => c.rowspan > 1 || c.colspan > 1))) ctx.notes.push("TABLE_SPANS_RESTORED");
  ctx.tables.push({ rows: rows.length, cells: rows.reduce((n, r) => n + r.length, 0) });
  const lines = grid.slice(0, Math.max(rows.length, grid.length)).map((g, r) => {
    const out = [];
    for (let c = 0; c < width; c += 1) {
      const slot = g[c];
      if (slot === "COVERED_RIGHT" || slot === "COVERED_BELOW_RIGHT") continue;
      if (slot === undefined) { out.push(""); continue; }
      if (typeof slot === "object" && slot.below === true) { out.push(slot.colspan > 1 ? `\\multicolumn{${slot.colspan}}{c}{}` : ""); continue; }
      let text = inlineToLatex(slot.text.replace(/\s+/g, " ").trim(), ctx);
      if (slot.rowspan > 1) text = `\\multirow{${slot.rowspan}}{*}{${text}}`;
      if (slot.colspan > 1) text = `\\multicolumn{${slot.colspan}}{c}{${text}}`;
      out.push(text);
    }
    return out.join(" & ") + " \\\\";
  });
  // 表头行数 = 首行的最大 rowspan（多级表头完整后再画分隔线）
  const headerRows = Math.max(1, ...(rows[0] ?? []).map((c) => c.rowspan));
  return [
    "\\begin{table}[htbp]\\centering",
    CAPTION_SLOT,
    `\\begin{tabular}{${"l".repeat(width)}}`,
    "\\hline",
    ...lines.map((line, i) => line + (i === headerRows - 1 ? " \\hline" : "")),
    "\\hline",
    "\\end{tabular}",
    "\\end{table}",
  ].join("\n");
}

/** 题注移入：块序列中每张表取紧邻的「Table N: …」块（先看前一块、再看后一块）；编号须恰为 1..k 且与表序一致，否则整篇不移入 */
export function attachCaptions(blocks, ctx) {
  const CAP = /^(?:\\textbf\{)?Table\s+(\d+)\s*[:.]\s*([\s\S]*?)\}?\s*$/;
  const tables = blocks.map((b, i) => (b.includes(CAPTION_SLOT) ? i : -1)).filter((i) => i >= 0);
  if (tables.length === 0) return blocks;
  // 纠偏：题注段落不一定紧邻表格（转写常把两条题注连排）。全文题注编号恰为 1..k、k = 表格数时按序配对；否则整篇不加 caption
  const captions = blocks.map((b, i) => ({ i, m: b.includes(CAPTION_SLOT) ? null : CAP.exec(b.trim()) })).filter((entry) => entry.m !== null).map((entry) => ({ blockIndex: entry.i, number: Number(entry.m[1]), text: entry.m[2].trim() }));
  const plan = [...captions].sort((a, b) => a.number - b.number);
  const consistent = plan.length === tables.length && plan.every((entry, k) => entry.number === k + 1);
  const out = blocks.slice();
  if (!consistent) {
    ctx.notes.push("TABLE_CAPTIONS_SKIPPED");
    for (const t of tables) out[t] = out[t].replace(`${CAPTION_SLOT}\n`, "");
    return out;
  }
  ctx.notes.push("TABLE_CAPTIONS_ATTACHED");
  plan.forEach((entry, k) => {
    out[tables[k]] = out[tables[k]].replace(CAPTION_SLOT, `\\caption{${entry.text}}\\label{tab:m16v2-${entry.number}}`);
    out[entry.blockIndex] = null;
  });
  return out.filter((b) => b !== null);
}

function pipeTableToLatex(block, ctx) {
  const lines = block.split("\n");
  const caption = lines.filter((l) => /^\*\*.*\*\*$/.test(l)).map((l) => l.slice(2, -2));
  const rows = lines.filter((l) => /^\|/.test(l) && !/^\|(\s*:?-+:?\s*\|)+\s*$/.test(l)).map((l) => l.trim().slice(1, -1).split(/(?<!\\)\|/).map((c) => c.trim().replace(/\\\|/g, "|")));
  const width = Math.max(...rows.map((r) => r.length));
  ctx.tables.push({ rows: rows.length, cells: rows.reduce((n, r) => n + r.length, 0) });
  return [
    "\\begin{table}[htbp]\\centering",
    ...caption.map((c) => `\\caption*{${inlineToLatex(c, ctx)}}`),
    `\\begin{tabular}{${"l".repeat(width)}}`,
    "\\hline",
    ...rows.map((r, i) => [...r, ...Array(width - r.length).fill("")].map((c) => inlineToLatex(c, ctx)).join(" & ") + " \\\\" + (i === 0 ? " \\hline" : "")),
    "\\hline",
    "\\end{tabular}",
    "\\end{table}",
  ].join("\n");
}

/**
 * @returns {{ tex: string, report: { math: Array<{kind:string, raw:string, suspects:string[]}>, headings: Array<{level:number,text:string}>, tables: Array<{rows:number,cells:number}>, figures: number, notes: Record<string, number> } }}
 */
export function markdownToLatexFidelity(md, language = "en") {
  const ctx = { math: [], tables: [], notes: [], figures: 0, headings: [] };
  // 1) 块级数学 / HTML 表格先抽成占位符（它们可以跨空行，且内部不得被块切分或转义）
  const held = [];
  const hold = (latex) => `\u0000H${held.push(latex) - 1}\u0000`;
  let src = md.replace(/\r\n?/g, "\n");
  src = src.replace(new RegExp(`\\\\begin\\{(${DISPLAY_ENVS})\\}[\\s\\S]*?\\\\end\\{\\1\\}`, "g"), (m) => {
    ctx.math.push({ kind: "environment", raw: m, suspects: mathSuspects(m) });
    return hold(m);
  });
  src = src.replace(/\$\$([\s\S]+?)\$\$|\\\[([\s\S]+?)\\\]/g, (m, a, b) => {
    const raw = a ?? b;
    ctx.math.push({ kind: "display", raw, suspects: mathSuspects(raw) });
    // 原稿若在 $$ 内再写 equation 环境，直接输出原文（避免嵌套显示环境），否则包成 \[ … \]
    return hold(/\\begin\s*\{\s*(equation|align|gather|multline)/.test(raw) ? raw.trim() : `\\[\n${raw.trim()}\n\\]`);
  });
  src = src.replace(/<table[\s\S]*?<\/table>/gi, (m) => hold(tableToLatex(m, ctx)));
  src = src.replace(/!\[([^\]]*)\]\(([^)]*)\)/g, (_m, alt) => {
    ctx.figures += 1;
    return `\u0000F${alt}\u0000`;
  });

  const blocks = src.split(/\n{2,}/).map((b) => b.trim()).filter(Boolean);
  let title = "";
  const front = [];
  const body = [];
  const refs = [];
  let seenHeading = false;
  let inRefs = false;
  const restore = (s) =>
    s
      .replace(/\u0000H(\d+)\u0000/g, (_m, n) => held[Number(n)])
      .replace(/\u0000F([^\u0000]*)\u0000/g, (_m, alt) => `\\textit{[Figure image not available as text${alt.trim() ? `: ${escText(alt.trim())}` : ""}]}`);
  for (const block of blocks) {
    const h = /^(#{1,6})\s+(.*)$/.exec(block);
    if (h && !block.includes("\n")) {
      const text = h[2].trim();
      if (!title) {
        title = text;
        continue;
      }
      if (REFS.test(text.replace(/^\d+\s*/, ""))) {
        inRefs = true;
        continue;
      }
      inRefs = false;
      seenHeading = true;
      const level = Math.min(3, headingLevel(h[1].length, text));
      ctx.headings.push({ level, text });
      body.push(`\\${HEADING_CMD[level]}*{${inlineToLatex(text, ctx)}}`);
      continue;
    }
    if (inRefs) {
      refs.push(block.replace(/^-\s+/, ""));
      continue;
    }
    let out;
    if (/^\u0000H\d+\u0000$/.test(block)) out = block;
    else if (/^\|.*\|$/m.test(block) && block.split("\n").every((l) => /^\|.*\|\s*$/.test(l) || /^\*\*.*\*\*$/.test(l))) out = pipeTableToLatex(block, ctx);
    else if (/^- /.test(block)) out = "\\begin{itemize}\n" + block.split(/\n(?=- )/).map((it) => `\\item ${convertWithHeld(it.replace(/^- /, ""), ctx)}`).join("\n") + "\n\\end{itemize}";
    else out = convertWithHeld(block, ctx);
    (seenHeading ? body : front).push(restore(out));
  }
  const bib = refs.length ? ["\\begin{thebibliography}{99}", ...refs.map((r, i) => `\\bibitem{ref${i + 1}} ${restore(convertWithHeld(r, ctx))}`), "\\end{thebibliography}"].join("\n") : "";
  const tex = [
    language === "zh" ? "\\documentclass{ctexart}" : "\\documentclass{article}",
    "\\usepackage{amsmath,amssymb}",
    "\\usepackage{caption}",
    `\\title{${inlineToLatex(title, ctx)}}`,
    "\\date{}",
    "\\begin{document}",
    "\\maketitle",
    "",
    attachCaptions(front, ctx).join("\n\n"),
    "",
    attachCaptions(body, ctx).join("\n\n"),
    "",
    bib,
    "",
    "\\end{document}",
    "",
  ].join("\n");
  const notes = {};
  for (const n of ctx.notes) notes[n] = (notes[n] ?? 0) + 1;
  for (const m of ctx.math) for (const s of m.suspects) notes[s] = (notes[s] ?? 0) + 1;
  if (ctx.figures > 0) notes.FIGURE_NOT_READABLE = ctx.figures;
  return { tex, report: { math: ctx.math, headings: ctx.headings, tables: ctx.tables, figures: ctx.figures, notes } };
}

/** 含占位符的块：占位符原样保留，其余按正文转换 */
function convertWithHeld(block, ctx) {
  return block
    .split(/(\u0000H\d+\u0000|\u0000F[^\u0000]*\u0000)/)
    .map((p) => (/^\u0000[HF]/.test(p) ? p : inlineToLatex(p, ctx)))
    .join("");
}

/** 去掉参考文献标题到下一个标题（附录）之间的内容 */
export function stripReferences(md) {
  const lines = md.replace(/\r\n?/g, "\n").split("\n");
  let inRefs = false;
  return lines
    .filter((line) => {
      const h = /^#{1,6}\s+(.*)$/.exec(line);
      if (h) inRefs = REFS.test(h[1].trim().replace(/^\d+\s*/, ""));
      return !inRefs;
    })
    .join("\n");
}

// ── 保真比较（零模型）：源 MD 与生成 TeX（或任一下游文本，如 Reviewer prompt）之间的结构对照 ──

const norm = (s) => s.replace(/\s+/g, "");
/** 数字：去掉逗号千分位；只取正文（非数学）中的数字 */
const numbers = (s) => (s.match(/\d+(?:\.\d+)?/g) ?? []).map((n) => n.replace(/^0+(?=\d)/, ""));
const citeMarkers = (s) => (s.match(/\[\d+(?:\s*[,–-]\s*\d+)*\]/g) ?? []).map(norm);

/**
 * 比较源 Markdown 与下游文本：
 * - mathPreserved：源中每个数学段（去空白后）作为子串按顺序出现在下游；
 * - escapedMathResidue：下游中由转义造成的数学残留（`\textbackslash{}<命令>`、`\$`+转义下划线等）；
 * - numbers / citeMarkers：源正文的数字与 [n] 引用标记多重集是否被下游覆盖；
 * - headings：源标题文本在下游中的保留数。
 */
export function compareFidelity(sourceMd, downstream, { bodyOnly = false } = {}) {
  // bodyOnly：去掉参考文献节（生产 review.run 按设计从末节剥离 thebibliography，不作为正文审阅）
  const md = bodyOnly ? stripReferences(sourceMd) : sourceMd;
  const { report } = markdownToLatexFidelity(md);
  const target = norm(downstream);
  let cursor = 0;
  const missing = [];
  let ordered = 0;
  for (const m of report.math) {
    const needle = norm(m.raw);
    if (needle === "") continue;
    const at = target.indexOf(needle, cursor);
    if (at >= 0) {
      ordered += 1;
      cursor = at + needle.length;
    } else if (target.includes(needle)) ordered += 1;
    else missing.push(m.raw.slice(0, 80));
  }
  const residue = (downstream.match(/\\textbackslash\{\}[A-Za-z]+|\\\$[^$\n]{0,40}?\\_|\\\^\{\}/g) ?? []).length;
  const sourceText = decodeEntities(md.replace(/\$\$[\s\S]+?\$\$|\$[^$\n]+\$|!\[[^\]]*\]\([^)]*\)|<[^>]+>/g, " "));
  const multiset = (arr) => arr.reduce((m, x) => m.set(x, (m.get(x) ?? 0) + 1), new Map());
  const covered = (need, have) => {
    const h = multiset(have);
    let ok = 0;
    let total = 0;
    for (const [k, n] of multiset(need)) {
      total += n;
      ok += Math.min(n, h.get(k) ?? 0);
    }
    return { total, preserved: ok };
  };
  const headingTexts = (md.match(/^#{1,6}\s+.*$/gm) ?? []).slice(1).map((h) => h.replace(/^#+\s+/, "").trim()).filter((t) => !REFS.test(t.replace(/^\d+\s*/, "")));
  return {
    math: { total: report.math.length, preserved: report.math.length - missing.length, orderedHits: ordered, missing: missing.slice(0, 10) },
    escapedMathResidue: residue,
    numbers: covered(numbers(sourceText), numbers(downstream)),
    citeMarkers: covered(citeMarkers(sourceText), citeMarkers(downstream)),
    headings: { total: headingTexts.length, preserved: headingTexts.filter((t) => target.includes(norm(escText(t))) || target.includes(norm(t))).length },
    sourceNotes: report.notes,
  };
}

if (process.argv[1] && process.argv[1].endsWith("md-to-tex-v2.mjs")) {
  const [, , inPath, outPath, language] = process.argv;
  writeFileSync(outPath, markdownToLatexFidelity(readFileSync(inPath, "utf8"), language ?? "en").tex, "utf8");
}
