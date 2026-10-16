/**
 * M14.1c：学位论文确定性装配（ThesisDocumentModel + 模板 → 可编译 LaTeX 目录）。
 *
 * 核心纪律：
 *   - manuscript/sections/*.tex 是唯一正文事实源，装配只读不写；
 *   - Writer 契约（节片段以 \section 开头）不动：多节章由 wrapper 模式生成
 *     \chapter{...} 包裹原样 \input；单节章用 promoted 模式——对副本做
 *     **同行原地**标题层级改名（\section→\chapter、\subsection→\section、…），
 *     行数与行号不变 → logicalSpan / 文件行号映射保持；
 *   - 标签（\label）与交叉引用（\ref/\cite）永不触碰——只改标题命令名；
 *   - 同输入 byte-identical（无时间戳 / 无随机）。
 *
 * 装配产物目录（缺省 manuscript-thesis/）结构与普通 manuscript 相同：
 * main.tex + sections/ + references.bib（有则复制）——LatexCompiler 原样编译。
 */

import { cp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BusinessError } from "../errors.js";
import type { Outline } from "../manuscript/ManuscriptService.js";
import { getThesisTemplateAdapter, escapeThesisShortText, type ThesisTemplateAdapter, type ThesisTemplateContext } from "./genericCtexbookAdapter.js";
import { chapterLabelLatex, chapterOrder, normalizeChapterReferences, type ChapterOrderEntry, type ChapterReferenceIssue } from "./chapterReferences.js";
import {
  chapterAssemblyMode,
  validateThesisDocumentModel,
  type ThesisChapter,
  type ThesisDocumentModel,
} from "./thesisDocumentTypes.js";

export interface ThesisAssemblyResult {
  /** 生成的主文档内容（main.tex） */
  mainTex: string;
  bibliography: "bibtex" | "biber" | null;
  chapters: Array<{
    chapterId: string;
    titleZh: string;
    mode: "promoted" | "wrapper";
    sectionFiles: string[];
    part: "main" | "appendix";
  }>;
  /** promoted 模式做过层级改名的节文件（行数 / 行号不变） */
  transformedFiles: string[];
  /**
   * M14.6：字面章号引用的确定性归一（装配产物层；源 manuscript 不动）。rewrites = 「第四章」→
   * `第\ref{ch:…}章`（按邻近章标题解析）；issues = 无法解析 / 序号超界 / 序号与标题不符（已按标题改写）。
   */
  chapterReferences: {
    rewrites: Array<{ file: string; before: string; after: string; chapterId: string }>;
    issues: Array<{ file: string; literal: string; reason: ChapterReferenceIssue["reason"]; expectedChapterId?: string }>;
  };
}

/** 标题层级名（LaTeX 标准层级序）；shiftHeadingLevels 按 index 移动 */
const HEADING_NAMES = ["chapter", "section", "subsection", "subsubsection", "paragraph", "subparagraph"] as const;
const HEADING_COMMAND_RE = new RegExp(
  `\\\\(chapter|section|subsection|subsubsection|paragraph|subparagraph)(\\*?)(\\[[^\\]]*\\])?(\\s*\\{)`,
  "g",
);

/**
 * 标题层级原地改名（每行独立、单遍、行数不变）。levels>0 = 升级（section→chapter）。
 * 只改命令名（含星号 / 可选参数原样保留）；正文、\label、\ref、\cite 不触碰。
 * chapter 已是顶层：再升级保持 chapter（钳制）。
 */
export function shiftHeadingLevels(tex: string, levels: number): string {
  if (levels === 0) {
    return tex;
  }
  const lines = tex.split("\n");
  const shifted = lines.map((line) =>
    line.replace(HEADING_COMMAND_RE, (match, name: string, star: string, optional: string | undefined, brace: string) => {
      const index = HEADING_NAMES.indexOf(name as (typeof HEADING_NAMES)[number]);
      if (index < 0) {
        return match;
      }
      const target = Math.max(0, Math.min(HEADING_NAMES.length - 1, index - levels));
      return `\\${HEADING_NAMES[target]}${star}${optional ?? ""}${brace}`;
    }),
  );
  return shifted.join("\n");
}

/** outline → 装配校验视图 */
function outlineShape(outline: Outline): { sectionFiles: string[]; sectionTitles: Map<string, string> } {
  const sectionFiles = outline.sections.map((section) => section.file);
  const sectionTitles = new Map(outline.sections.map((section) => [section.file, section.title]));
  return { sectionFiles, sectionTitles };
}

export interface AssembleThesisOptions {
  model: ThesisDocumentModel;
  outline: Outline;
  /** 源 manuscript 目录（含 sections/ 与可选 references.bib）；只读 */
  manuscriptDir: string;
  /** 装配产物目录（缺省行为由调用方决定；测试可指向临时目录） */
  targetDir: string;
  /** 写盘前是否清空 targetDir（缺省 true：装配是确定性重建） */
  cleanTarget?: boolean;
}

/**
 * 确定性装配学位论文目录。产物与源分离：源 manuscript/ 不被写入。
 * 校验失败（未映射 section / 重复映射 / 模板未实现）抛 STAGE_CONTRACT_VIOLATION。
 */
export async function assembleThesisManuscript(options: AssembleThesisOptions): Promise<ThesisAssemblyResult> {
  const { model, outline, manuscriptDir, targetDir } = options;
  const adapter = getThesisTemplateAdapter(model.templateId);
  if (adapter === undefined) {
    throw new BusinessError("STAGE_CONTRACT_VIOLATION", `学位论文模板 ${model.templateId} 未实现`);
  }
  const shape = outlineShape(outline);
  const violations = validateThesisDocumentModel(model, shape);
  if (violations.length > 0) {
    throw new BusinessError("STAGE_CONTRACT_VIOLATION", `学位论文文档模型校验未通过：${violations.join("；")}`);
  }

  // references.bib 存在性 → 模板上下文
  let referencesBib = "";
  try {
    referencesBib = await readFile(join(manuscriptDir, "references.bib"), "utf8");
  } catch {
    referencesBib = "";
  }
  const ctx: ThesisTemplateContext = { hasBibliography: referencesBib.trim() !== "" };

  // ---- 产物目录：复制源（sections / 资产 / references.bib），再覆盖装配产物 ----
  if (options.cleanTarget !== false) {
    await rm(targetDir, { recursive: true, force: true });
  }
  await mkdir(targetDir, { recursive: true });
  await cp(manuscriptDir, targetDir, { recursive: true, force: true });

  const transformedFiles: string[] = [];
  const chaptersOut: ThesisAssemblyResult["chapters"] = [];
  const order = chapterOrder(model.chapters.map((chapter) => ({ chapterId: chapter.chapterId, titleZh: chapter.titleZh })));
  const chapterReferences: ThesisAssemblyResult["chapterReferences"] = { rewrites: [], issues: [] };

  // ---- 正文：wrapper / promoted ----
  const mainLines: string[] = [];
  mainLines.push(...adapter.buildPreamble(model, ctx), "");
  mainLines.push("\\begin{document}", "");
  mainLines.push(...adapter.buildFrontmatter(model, ctx), "");

  for (const chapter of model.chapters) {
    mainLines.push(...(await chapterLines(chapter, "main", { adapter, model, ctx, transformedFiles, chaptersOut, manuscriptDir, targetDir, order, chapterReferences })));
  }

  // ---- 参考文献 ----
  mainLines.push("\\cleardoublepage", "");
  mainLines.push(...adapter.buildBackmatter(model, ctx), "");

  // ---- 附录 ----
  if (model.appendix !== undefined && model.appendix.length > 0) {
    mainLines.push("\\cleardoublepage", "\\appendix", "");
    for (const chapter of model.appendix) {
      mainLines.push(...(await chapterLines(chapter, "appendix", { adapter, model, ctx, transformedFiles, chaptersOut, manuscriptDir, targetDir, order, chapterReferences })));
    }
  }

  // ---- 致谢（可选；未提供不生成，不伪造）----
  if (model.acknowledgmentsZh !== undefined && model.acknowledgmentsZh.trim() !== "") {
    mainLines.push("\\cleardoublepage", "\\chapter*{致谢}", "\\addcontentsline{toc}{chapter}{致谢}", "");
    mainLines.push(escapeAcknowledgments(model.acknowledgmentsZh.trim()), "");
  }

  mainLines.push("\\end{document}", "");
  const mainTex = mainLines.join("\n");

  await writeFile(join(targetDir, "main.tex"), mainTex, "utf8");
  // 装配元数据不出现在源目录
  for (const stale of ["outline.json", "thesis.json"]) {
    await rm(join(targetDir, stale), { force: true });
  }

  return {
    mainTex,
    bibliography: ctx.hasBibliography ? (model.bibliography ?? adapter.defaultBibliography) : null,
    chapters: chaptersOut,
    transformedFiles,
    chapterReferences,
  };
}

interface ChapterEmitContext {
  adapter: ThesisTemplateAdapter;
  model: ThesisDocumentModel;
  ctx: ThesisTemplateContext;
  transformedFiles: string[];
  chaptersOut: ThesisAssemblyResult["chapters"];
  manuscriptDir: string;
  targetDir: string;
  order: ChapterOrderEntry[];
  chapterReferences: ThesisAssemblyResult["chapterReferences"];
}

/** M14.6：节文件的字面章号归一（装配产物层）；返回是否改写 */
async function normalizeSectionChapterReferences(file: string, source: string, emit: ChapterEmitContext): Promise<string> {
  const normalized = normalizeChapterReferences(source, emit.order);
  for (const rewrite of normalized.rewrites) {
    emit.chapterReferences.rewrites.push({ file, before: rewrite.before, after: rewrite.after, chapterId: rewrite.chapterId });
  }
  for (const issue of normalized.issues) {
    emit.chapterReferences.issues.push({ file, literal: issue.literal, reason: issue.reason, ...(issue.expectedChapterId !== undefined ? { expectedChapterId: issue.expectedChapterId } : {}) });
  }
  return normalized.latex;
}

function escapeAcknowledgments(text: string): string {
  return text.replace(/(^|[^\\])([_&#%])/g, (_match, before: string, ch: string) => `${before}\\${ch}`);
}

async function chapterLines(
  chapter: ThesisChapter,
  part: "main" | "appendix",
  emit: ChapterEmitContext,
): Promise<string[]> {
  const mode = chapterAssemblyMode(chapter);
  const lines: string[] = [];
  emit.chaptersOut.push({ chapterId: chapter.chapterId, titleZh: chapter.titleZh, mode, sectionFiles: [...chapter.sections], part });
  if (mode === "wrapper") {
    // M14.6：章标签（\ref{ch:…} 由装配器解析真实章号；Writer 不写字面章号）
    lines.push(`\\chapter{${escapeThesisShortText(chapter.titleZh)}}`, chapterLabelLatex(chapter.chapterId), "");
    for (const file of chapter.sections) {
      // M14.6：字面章号引用归一（只改产物副本；源 manuscript 不动，bounded Revision 的逐字节基线不受影响）
      try {
        const source = await readFile(join(emit.manuscriptDir, "sections", file), "utf8");
        const normalized = await normalizeSectionChapterReferences(file, source, emit);
        if (normalized !== source) {
          await writeFile(join(emit.targetDir, "sections", file), normalized, "utf8");
          emit.transformedFiles.push(file);
        }
      } catch {
        // 节文件缺失由编译阶段如实报错；装配不吞错也不伪造
      }
      lines.push(`\\input{sections/${file.replace(/\.tex$/, "")}}`, "");
    }
    return lines;
  }
  // promoted：单节章。读取节文件 → 层级 +1 原地改名 → 写入产物 sections/。
  // 行数与行号不变（logicalSpan 兼容）；正文 / 标签 / 引用原样。
  const file = chapter.sections[0]!;
  const source = await readFile(join(emit.manuscriptDir, "sections", file), "utf8");
  let shifted = shiftHeadingLevels(source, 1);
  // M14.6：章标签插在首个 \chapter 行尾（同一行，行数不变）
  shifted = shifted.replace(/^(\\chapter\*?(?:\[[^\]]*\])?\{[^}]*\})/m, (match) => `${match}${chapterLabelLatex(chapter.chapterId)}`);
  shifted = await normalizeSectionChapterReferences(file, shifted, emit);
  if (shifted !== source) {
    emit.transformedFiles.push(file);
  }
  await writeFile(join(emit.targetDir, "sections", file), shifted, "utf8");
  lines.push(`\\input{sections/${file.replace(/\.tex$/, "")}}`, "");
  return lines;
}
