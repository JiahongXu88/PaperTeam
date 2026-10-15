/**
 * M14.1c：学位论文模板适配器——generic-ctexbook（默认通用中文学位论文模板）。
 *
 * M14.0 模板研究结论：9/10 高校模板基于 ctexbook + XeLaTeX；通用模板不冒充
 * 任何高校标准（不捆绑 thuthesis / NJUThesis / ustcthesis 的 .cls）。适配器
 * 接口为未来高校适配器预留（产出 preamble / 前置 / 后置，编排由
 * thesisAssembler 统一负责）。
 *
 * 字体：fontset=fandol（TeX Live 自带开源 Fandol 家族，Linux/Windows 一致，
 * 不硬编码平台字体路径）。
 * 参考文献：缺省 bibtex + GB/T 7714-2015（gbt7714 宏包，TeX Live 发行版内置）；
 * 可选 biber（biblatex numeric）。无 references.bib 时不加载任何参考文献
 * 宏包（biblatex 的 \addbibresource 对缺失文件直接报错）。
 */

import type {
  ThesisBibliographyBackend,
  ThesisDocumentModel,
} from "./thesisDocumentTypes.js";

/**
 * 长纯文本（摘要：可能含偶发行内数学）防御转义——与
 * ManuscriptService.escapeAbstractPlainText 同策略：只转 text mode 直接报错
 * 的四个字符（_ & # %），只转尚未被转义的，不触碰 $ / {} / 反斜杠。
 */
function escapePlainText(text: string): string {
  return text.replace(/(^|[^\\])([_&#%])/g, (_match, before: string, ch: string) => `${before}\\${ch}`);
}

/** 短字段（标题 / 人名 / 关键词）单遍转义：\ & % $ # _ { } ~ ^ */
function escapeLaTeXText(text: string): string {
  return text.replace(/[\\&%$#_{}~^]/g, (ch) => {
    switch (ch) {
      case "\\":
        return "\\textbackslash{}";
      case "~":
        return "\\textasciitilde{}";
      case "^":
        return "\\textasciicircum{}";
      default:
        return `\\${ch}`;
    }
  });
}

/** 装配层复用：章标题等短字段的 LaTeX 转义 */
export function escapeThesisShortText(text: string): string {
  return escapeLaTeXText(text);
}

/** 适配器可见的装配上下文 */
export interface ThesisTemplateContext {
  /** manuscript/ 下是否存在 references.bib */
  hasBibliography: boolean;
}

export interface ThesisTemplateAdapter {
  readonly templateId: string;
  readonly defaultBibliography: ThesisBibliographyBackend;
  /** 文档类导言（documentclass + 宏包） */
  buildPreamble(model: ThesisDocumentModel, ctx: ThesisTemplateContext): string[];
  /** 前置部分（封面 → 摘要 → Abstract → 目录 → 图表目录） */
  buildFrontmatter(model: ThesisDocumentModel, ctx: ThesisTemplateContext): string[];
  /** 后置部分（参考文献 → 致谢；附录接入点由装配层按模型注入） */
  buildBackmatter(model: ThesisDocumentModel, ctx: ThesisTemplateContext): string[];
}

class GenericCtexbookAdapter implements ThesisTemplateAdapter {
  readonly templateId = "generic-ctexbook";
  readonly defaultBibliography: ThesisBibliographyBackend = "bibtex";

  private useBibliography(_model: ThesisDocumentModel, ctx: ThesisTemplateContext): boolean {
    return ctx.hasBibliography;
  }

  buildPreamble(model: ThesisDocumentModel, ctx: ThesisTemplateContext): string[] {
    const backend = model.bibliography ?? this.defaultBibliography;
    const withBib = ctx.hasBibliography;
    return [
      "% 生成自 PaperTeam ThesisDocumentModel（generic-ctexbook）——确定性装配，勿手改",
      "\\documentclass[UTF8,fontset=fandol]{ctexbook}",
      "\\usepackage{amsmath}",
      "\\usepackage{amssymb}",
      "\\usepackage{graphicx}",
      ...(withBib && backend === "biber"
        ? ["\\usepackage[backend=biber,style=numeric]{biblatex}", "\\addbibresource{references.bib}"]
        : []),
      ...(withBib && backend === "bibtex" ? ["\\usepackage{gbt7714}"] : []),
    ];
  }

  buildFrontmatter(model: ThesisDocumentModel): string[] {
    const lines: string[] = [];
    // ---- 封面（不伪造：未提供的字段留空）----
    lines.push("\\begin{titlepage}", "  \\centering", "  \\vspace*{2cm}");
    lines.push(`  {\\Large ${escapeLaTeXText(model.titleZh)}}`);
    if (model.titleEn !== undefined && model.titleEn.trim() !== "") {
      lines.push("  \\\\[0.6cm]", `  {\\large ${escapeLaTeXText(model.titleEn)}}`);
    }
    // M14.2 修复（真实编译实锤）：作者 / 学位信息全空时不得出现孤行 \\ ——
    // 段首的 \\ 会触发 "There's no line here to end"。垂直间距统一走 \\vspace。
    lines.push("  \\vspace{2cm}");
    const author = model.author;
    if (author?.nameZh !== undefined && author.nameZh.trim() !== "") {
      lines.push(`  ${escapeLaTeXText(author.nameZh)}\\\\[0.3cm]`);
    }
    if (author?.studentId !== undefined && author.studentId.trim() !== "") {
      lines.push(`  学号：${escapeLaTeXText(author.studentId)}\\\\[2cm]`);
    }
    const degree = model.degree;
    if (degree !== undefined) {
      if (degree.levelZh !== undefined && degree.levelZh.trim() !== "") {
        lines.push(`  ${escapeLaTeXText(degree.levelZh)}学位论文\\\\[0.3cm]`);
      }
      if (degree.fieldZh !== undefined && degree.fieldZh.trim() !== "") {
        lines.push(`  专业：${escapeLaTeXText(degree.fieldZh)}\\\\[0.3cm]`);
      }
      if (degree.schoolZh !== undefined && degree.schoolZh.trim() !== "") {
        lines.push(`  ${escapeLaTeXText(degree.schoolZh)}\\\\[1cm]`);
      }
      if (degree.dateZh !== undefined && degree.dateZh.trim() !== "") {
        lines.push(`  ${escapeLaTeXText(degree.dateZh)}\\\\`);
      }
    }
    lines.push("\\end{titlepage}", "");

    // ---- 中文摘要 + 关键词（ctexbook 无 abstract 环境：\chapter* + 手动入目录）----
    if (model.abstractZh !== undefined && model.abstractZh.trim() !== "") {
      lines.push("\\chapter*{摘要}", "\\addcontentsline{toc}{chapter}{摘要}", escapePlainText(model.abstractZh.trim()));
      if (model.keywordsZh !== undefined && model.keywordsZh.length > 0) {
        lines.push("", `\\noindent\\textbf{关键词：${model.keywordsZh.map(escapeLaTeXText).join("；")}}`);
      }
      lines.push("\\cleardoublepage", "");
    }
    // ---- 英文摘要 + Keywords ----
    if (model.abstractEn !== undefined && model.abstractEn.trim() !== "") {
      lines.push("\\chapter*{Abstract}", "\\addcontentsline{toc}{chapter}{Abstract}", escapePlainText(model.abstractEn.trim()));
      if (model.keywordsEn !== undefined && model.keywordsEn.length > 0) {
        lines.push("", `\\noindent\\textbf{Keywords: ${model.keywordsEn.map(escapeLaTeXText).join("; ")}}`);
      }
      lines.push("\\cleardoublepage", "");
    }

    // ---- 目录 / 图表目录（模板能力内的标准件）----
    lines.push("\\tableofcontents", "\\cleardoublepage");
    lines.push("\\listoffigures", "\\cleardoublepage");
    lines.push("\\listoftables", "\\cleardoublepage");
    return lines;
  }

  buildBackmatter(model: ThesisDocumentModel, ctx: ThesisTemplateContext): string[] {
    if (!this.useBibliography(model, ctx)) {
      return [];
    }
    const backend = model.bibliography ?? this.defaultBibliography;
    return backend === "biber"
      ? ["\\printbibliography[heading=bibintoc]"]
      : ["\\bibliographystyle{gbt7714-numerical}", "\\bibliography{references}"];
  }
}

const adapter = new GenericCtexbookAdapter();

/** 模板注册表（未来高校适配器在此追加；M14.1c 只实现 generic-ctexbook） */
export const THESIS_TEMPLATE_ADAPTERS: ReadonlyMap<string, ThesisTemplateAdapter> = new Map([
  [adapter.templateId, adapter],
]);

export function getThesisTemplateAdapter(templateId: string): ThesisTemplateAdapter | undefined {
  return THESIS_TEMPLATE_ADAPTERS.get(templateId);
}
