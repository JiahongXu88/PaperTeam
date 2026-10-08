/**
 * Manuscript Figure Insertion（M12.3 C5）：确定性 figure 环境 emitter 与
 * 受控插入 / 替换。**零 LLM、零自由 LaTeX 编辑**——Writer 不经手本模块产出的
 * 任何字节；插入内容全部由已登记 Figure 资产 + 转义后的 caption 拼装。
 *
 * 安全边界（任务书 §10/§11 + M12.0 §13）：
 * - includegraphics 路径恒为 `figs/generated/<figId>.pdf`（由 manifest 登记的
 *   figId 派生，不接受任何用户/模型提供的路径——路径穿越 / 未登记外部资产
 *   在构造层就不存在）；
 * - caption 经 latexEscape 单一出口转义（LaTeX 控制序列注入不可构造）；
 * - label 走 `fig:` 前缀 + 安全 slug 白名单，插入前查全稿冲突；
 * - replace 模式只改写目标 figure 环境内部的 includegraphics/caption 两行，
 *   label / placement / 环境位置与正文一字不动（M11 修订安全边界：图表动作
 *   不成为跨章节改写的后门）；
 * - append 模式只在目标文件末尾追加（不插入正文中间）；
 * - main.tex 缺 graphicx 时在 documentclass 后确定性补一行（幂等）。
 */

import { escapeLatex } from "./latexEscape.js";
import { buildVisualInventory, type ManuscriptVisualInventory } from "../manuscript/visualInventory.js";

/** 安全长 label 形态（不含 "fig:" 前缀）：字母数字连字符下划线点 */
const LABEL_BODY_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.-]*$/;

export interface FigureEnvironmentInput {
  figId: string;
  caption: string;
  /** 不含 "fig:" 前缀的 label body（调用方保证唯一） */
  labelBody: string;
  /** 图宽（LaTeX 长度表达式白名单；缺省 0.85\textwidth） */
  widthExpression?: string;
}

/** 允许的宽度表达式（白名单——不接受任意 TeX） */
const WIDTH_WHITELIST = /^((0?\.[1-9]\d*)|1(\.0+)?)?\\(text|line)width$/;

/** 确定性 figure 环境 emitter（字节稳定；caption 全量转义） */
export function renderFigureEnvironment(input: FigureEnvironmentInput): string {
  const width = input.widthExpression !== undefined && WIDTH_WHITELIST.test(input.widthExpression)
    ? input.widthExpression
    : "0.85\\textwidth";
  return [
    "\\begin{figure}[htbp]",
    "    \\centering",
    `    \\includegraphics[width=${width}]{figs/generated/${input.figId}.pdf}`,
    `    \\caption{${escapeLatex(input.caption)}}`,
    `    \\label{fig:${input.labelBody}}`,
    "\\end{figure}",
  ].join("\n");
}

/** 校验 label body（用户提供的 label 去掉可选 fig: 前缀后必须匹配白名单） */
export function normalizeLabelBody(raw: string): string | null {
  const stripped = raw.trim().replace(/^fig:/, "");
  if (!LABEL_BODY_PATTERN.test(stripped)) {
    return null;
  }
  return stripped;
}

/** 从 caption / title 推导默认 label body（确定性 slug；ASCII 词优先） */
export function deriveLabelBody(caption: string, figId: string): string {
  const words = caption
    .toLowerCase()
    .replace(/[^a-z0-9\s-]/g, " ")
    .split(/\s+/)
    .filter((word) => word.length >= 2)
    .slice(0, 4);
  const slug = words.join("-");
  if (slug.length >= 3) {
    return slug.slice(0, 48);
  }
  return figId.replace(/^fig-/, "");
}

/** 冲突消解：existing 中的 label body 集合，追加 -2/-3… 直到唯一 */
export function uniqueLabelBody(base: string, existing: ReadonlySet<string>): string {
  if (!existing.has(base)) {
    return base;
  }
  for (let suffix = 2; suffix < 1000; suffix += 1) {
    const candidate = `${base}-${suffix}`;
    if (!existing.has(candidate)) {
      return candidate;
    }
  }
  throw new Error(`label 冲突消解失败：${base}`);
}

/** 全稿已存在的 fig: label body 集合（visualInventory 投影） */
export function existingFigureLabelBodies(inventory: ManuscriptVisualInventory): Set<string> {
  const bodies = new Set<string>();
  for (const file of inventory.files) {
    for (const figure of file.figures) {
      if (figure.label === undefined) {
        continue;
      }
      bodies.add(figure.label.replace(/^fig:/, ""));
    }
  }
  return bodies;
}

// ---- 文件内容变换（纯函数；IO 由服务层做） ----

/**
 * append 模式：文件末尾追加 figure 环境 + 可选引用句。
 * 引用句必须包含 \ref{fig:<labelBody>}（调用方校验后传入；此处防御性再验）。
 */
export function applyAppendInsertion(
  content: string,
  environment: string,
  labelBody: string,
  referenceSentence: string | undefined,
): string {
  const blocks = [content.replace(/\s*$/, ""), environment];
  if (referenceSentence !== undefined && referenceSentence.includes(`\\ref{fig:${labelBody}}`)) {
    // 引用句 = 普通文本 + 恰好一个 \ref{fig:<label>}：文本部分转义，
    // \ref 命令原样保留（它是本模块产出的唯一受控 TeX 命令）；"~" 还原为
    // 原字符（LaTeX 不断行空格——"图~\ref{...}" 是标准学术写法，转成可见
    // 波浪号是错的；单独的 ~ 不构成任何注入面）
    const refToken = `\\ref{fig:${labelBody}}`;
    const [before, after = ""] = referenceSentence.split(refToken);
    blocks.push(
      `${escapeReferenceText(before ?? "")}${refToken}${escapeReferenceText(after)}`,
    );
  }
  return `${blocks.join("\n\n")}\n`;
}

/** 引用句文本转义：全套特殊字符，但 "~" 保留为原字符（nbsp 语义） */
function escapeReferenceText(text: string): string {
  return escapeLatex(text).replaceAll("\\textasciitilde{}", "~");
}

export interface ReplacementTarget {
  /** 目标 figure 环境在文件内的行区间（1-based，含端点；visualInventory 提供） */
  lineStart: number;
  lineEnd: number;
  label: string;
}

export type ReplacementResult =
  | { ok: true; content: string; replacedLabel: string; previousPath?: string }
  | { ok: false; reason: "label_not_found" };

/**
 * replace 模式：同文件内按 label 定位既有 figure 环境，整体替换为受控环境
 * （新 label 与旧一致——正文 \ref 全部继续解析；placement 保持 [htbp]）。
 * 只动 [lineStart, lineEnd] 区间，环境外一字节不改；区间内容必须确实含
 * 目标 \label（防调用方行号错位时静默替换错误环境）。
 */
export function applyReplacement(
  content: string,
  target: ReplacementTarget,
  environment: string,
): ReplacementResult {
  const lines = content.split("\n");
  const start = target.lineStart - 1;
  const end = target.lineEnd - 1;
  if (start < 0 || end >= lines.length || start > end) {
    return { ok: false, reason: "label_not_found" };
  }
  const previous = lines.slice(start, end + 1).join("\n");
  if (!previous.includes(`\\label{${target.label}}`)) {
    return { ok: false, reason: "label_not_found" };
  }
  const pathMatch = /\\includegraphics(?:\[[^\]]*\])?\{([^}]+)\}/.exec(previous);
  lines.splice(start, end - start + 1, environment);
  return {
    ok: true,
    content: `${lines.join("\n")}\n`.replace(/\n{3,}$/, "\n"),
    replacedLabel: target.label,
    ...(pathMatch !== null ? { previousPath: pathMatch[1] ?? undefined } : {}),
  };
}

/** main.tex 缺 graphicx 时在 documentclass 行后补一行（幂等；无 documentclass → 原样） */
export function ensureGraphicxPreamble(mainTex: string): { content: string; injected: boolean } {
  if (/\\usepackage\{graphicx\}/.test(mainTex)) {
    return { content: mainTex, injected: false };
  }
  const lines = mainTex.split("\n");
  const classIndex = lines.findIndex((line) => /^\\documentclass/.test(line.trim()));
  if (classIndex === -1) {
    return { content: mainTex, injected: false };
  }
  lines.splice(classIndex + 1, 0, "\\usepackage{graphicx}");
  return { content: lines.join("\n"), injected: true };
}

// ---- 单文件 figure 环境定位（replace 模式服务层用；复用 visualInventory 解析） ----

/** 在单文件内容中按 label 找 figure 环境（返回 1-based 行区间） */
export function findFigureEnvByLabel(
  file: string,
  content: string,
  label: string,
): ReplacementTarget | undefined {
  const inventory = buildVisualInventory([{ file, content }]);
  const entry = inventory.files[0]?.figures.find((figure) => figure.label === label);
  if (entry === undefined) {
    return undefined;
  }
  return { lineStart: entry.lineStart, lineEnd: entry.lineEnd, label };
}
