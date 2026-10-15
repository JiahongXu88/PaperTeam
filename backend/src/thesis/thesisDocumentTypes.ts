/**
 * M14.1c：学位论文文档模型（ThesisDocumentModel）。
 *
 * 定位：普通论文（Outline + sections/*.tex，Writer 契约 \section 开头）之上的
 * 「文档组织层」——只声明结构（章节分组 / 前置 / 后置 / 模板），不复制正文
 * 内容：章节通过 file 引用 Outline sections，正文仍以 manuscript/sections/
 * 为唯一事实源。装配（thesisAssembler）在编译期确定性生成 ctexbook 主文档，
 * Writer / Review / logicalSpan 契约不动。
 *
 * 真实性纪律：作者 / 导师 / 学校 / 日期等个人信息全部可选——未提供的保留
 * 空值或测试占位符，装配层不伪造导师、学校或研究成果（M14.0 研究结论）。
 */

export const THESIS_TEMPLATE_IDS = ["generic-ctexbook"] as const;
export type ThesisTemplateId = (typeof THESIS_TEMPLATE_IDS)[number];

/** 参考文献后端（generic-ctexbook：bibtex + gbt7714 为缺省；biber 可选） */
export type ThesisBibliographyBackend = "bibtex" | "biber";

export interface ThesisAuthorInfo {
  /** 作者姓名（中文）；未提供则封面留空 */
  nameZh?: string;
  nameEn?: string;
  studentId?: string;
}

export interface ThesisDegreeInfo {
  /** 学位级别（博士 / 硕士 / 学士）；未提供则留空 */
  levelZh?: string;
  /** 学科专业 */
  fieldZh?: string;
  /** 学校（不默认任何学校——通用模板不冒充高校标准） */
  schoolZh?: string;
  /** 答辩 / 提交日期（自由文本） */
  dateZh?: string;
}

export interface ThesisChapter {
  /** 模型内唯一 id（suggested: ch01…；确定性装配引用） */
  chapterId: string;
  /** 章标题（wrapper 模式下成为 \chapter{...}；promoted 模式须与节标题一致） */
  titleZh: string;
  titleEn?: string;
  /**
   * 映入本章的 outline section 文件名（如 "introduction.tex"）。每个 outline
   * section 必须恰好映入一个章 / 附录——装配校验强制（未映射 = 正文丢失）。
   */
  sections: string[];
}

export interface ThesisDocumentModel {
  schemaVersion: 1;
  templateId: ThesisTemplateId;
  /** 中文标题（必填） */
  titleZh: string;
  titleEn?: string;
  author?: ThesisAuthorInfo;
  degree?: ThesisDegreeInfo;
  /** 中文摘要（纯文本；装配层转义与 abstract 相同的四个 text-mode 字符） */
  abstractZh?: string;
  abstractEn?: string;
  keywordsZh?: string[];
  keywordsEn?: string[];
  chapters: ThesisChapter[];
  /** 参考文献后端（缺省取模板默认：generic-ctexbook = bibtex） */
  bibliography?: ThesisBibliographyBackend;
  /** 附录章（引用 outline sections；无则无附录） */
  appendix?: ThesisChapter[];
  /** 致谢正文（纯文本；未提供则不生成致谢环境） */
  acknowledgmentsZh?: string;
}

export interface ThesisModelOutlineShape {
  /** outline 的 section 文件名集合（装配校验用；不复制 Outline 内容） */
  sectionFiles: readonly string[];
  /** outline 的 section 标题（file → title；promoted 模式标题一致性校验用） */
  sectionTitles: ReadonlyMap<string, string>;
}

/**
 * 校验模型（对当前 outline）：返回违规列表（空 = 合法）。
 *   - templateId 必须是已实现模板；
 *   - titleZh 非空；
 *   - 章节引用的 section 文件必须存在于 outline；
 *   - 每个 outline section 恰好被映射一次（未映射 = 正文丢失；重复 = 内容重复）；
 *   - 单节章（promoted 模式）的章标题须与节标题归一一致（章标题来自节自身
 *     的 \section 行，模型标题不一致 = 文档模型与产物目录脱节）；
 *   - 章节内 section 顺序去重；chapterId 唯一。
 */
export function validateThesisDocumentModel(model: ThesisDocumentModel, outline: ThesisModelOutlineShape): string[] {
  const violations: string[] = [];
  if (!THESIS_TEMPLATE_IDS.includes(model.templateId)) {
    violations.push(`模板 ${model.templateId} 未实现（可用：${THESIS_TEMPLATE_IDS.join(" / ")}）`);
  }
  if (model.titleZh.trim() === "") {
    violations.push("中文标题（titleZh）不能为空");
  }
  const chapterIds = new Set<string>();
  const mapped = new Map<string, number>();
  const allChapters = [...model.chapters, ...(model.appendix ?? [])];
  if (model.chapters.length === 0) {
    violations.push("正文章节（chapters）不能为空");
  }
  for (const chapter of allChapters) {
    if (chapter.chapterId.trim() === "") {
      violations.push("chapterId 不能为空");
    } else if (chapterIds.has(chapter.chapterId)) {
      violations.push(`chapterId 重复：${chapter.chapterId}`);
    }
    chapterIds.add(chapter.chapterId);
    if (chapter.titleZh.trim() === "") {
      violations.push(`章 ${chapter.chapterId} 标题为空`);
    }
    if (chapter.sections.length === 0) {
      violations.push(`章 ${chapter.chapterId} 未映射任何 section`);
    }
    for (const file of chapter.sections) {
      if (!outline.sectionFiles.includes(file)) {
        violations.push(`章 ${chapter.chapterId} 引用了 outline 中不存在的 section：${file}`);
      }
      mapped.set(file, (mapped.get(file) ?? 0) + 1);
    }
  }
  for (const file of outline.sectionFiles) {
    const count = mapped.get(file) ?? 0;
    if (count === 0) {
      violations.push(`outline section 未映射进任何章 / 附录：${file}（未映射 = 正文丢失）`);
    } else if (count > 1) {
      violations.push(`outline section 被映射 ${count} 次：${file}（正文会重复）`);
    }
  }
  // 单节章 promoted 一致性
  for (const chapter of model.chapters) {
    if (chapter.sections.length === 1) {
      const file = chapter.sections[0]!;
      const sectionTitle = outline.sectionTitles.get(file);
      if (sectionTitle !== undefined && normalizeThesisTitle(sectionTitle) !== normalizeThesisTitle(chapter.titleZh)) {
        violations.push(`单节章 ${chapter.chapterId}（${chapter.titleZh}）与节 ${file} 的标题（${sectionTitle}）不一致——promoted 模式下章标题来自节自身`);
      }
    }
  }
  return violations;
}

/** 标题归一（去空白 / 全角空格；比较用） */
export function normalizeThesisTitle(title: string): string {
  return title.replace(/\s+/g, "").trim();
}

/** 单节章判定（装配模式：promoted = 提升节标题层级；wrapper = 生成 \chapter 包裹） */
export function chapterAssemblyMode(chapter: ThesisChapter): "promoted" | "wrapper" {
  return chapter.sections.length === 1 ? "promoted" : "wrapper";
}
