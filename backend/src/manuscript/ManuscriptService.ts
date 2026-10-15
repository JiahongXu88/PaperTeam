/**
 * Section-based Manuscript 管理。
 *
 * 把写作从「一个巨大 main.tex」升级为：
 *   manuscript/main.tex        确定性生成（\input 各 section，不交给 LLM）
 *   manuscript/sections/*.tex  Writer 逐节产出的正文片段
 *   manuscript/outline.json    大纲（Authoritative State）
 *   manuscript/references.bib  由结构化 bibliography 确定性生成
 *   context.yaml（项目根）      Derived Context：大纲摘要 / 章节状态 / Evidence 统计，
 *                              可随时从事实来源重建，不是第二份事实数据库（D-0013）。
 */

import { mkdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BusinessError } from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { EvidenceStats } from "../evidence/EvidenceStore.js";
import { renderBibliographyFile, type BibRenderEntry } from "../citation/bibliography.js";
import { writeJsonAtomic, writeFileAtomic } from "../util/atomic.js";
import {
  normalizeOutlineArgument,
  validateOutlineArgument,
  type OutlineArgumentUnit,
} from "../writer/argumentUnit.js";

export interface OutlineSection {
  id: string;
  /** 章节文件名（sections/ 下，如 introduction.tex） */
  file: string;
  title: string;
  targetLengthWords?: number;
  keyPoints?: string[];
  /**
   * M11.1.3（Survey 专用，普通论文不产生）：本节消费的
   * SurveySynthesisItem.synthesisId 列表。只存 refs——taxonomy 标签 /
   * synthesis claim 不复制进 Outline（refs → Synthesis / Matrix artifact
   * 追溯），Matrix HITL 修正 → Synthesis rebuild → Outline rebuild 链不回填。
   */
  synthesisRefs?: string[];
  /** M11.1.3（Survey 专用）：本节覆盖的 SurveyMatrixEntry.entryId 列表（经 Matrix → sourceId 追溯） */
  literatureRefs?: string[];
  /**
   * M13.7.10：章节论证单元（可选；旧 Outline 无此字段）。role / task /
   * evidenceIds / doNotExplain / targetLengthUpperBound 全部可选——缺省由
   * writer/argumentUnit.resolveArgumentUnits 按位置 / 标题 / Survey 语境确定性
   * 派生；Planner 可选输出，无效部分在解析时丢弃并诊断，不阻断写作。
   */
  argument?: OutlineArgumentUnit;
}

export interface Outline {
  title: string;
  abstract?: string;
  sections: OutlineSection[];
}

export interface SectionStatus {
  id: string;
  file: string;
  title: string;
  exists: boolean;
  bytes: number;
  nonEmpty: boolean;
}

/** 合法章节文件名：小写字母/数字/连字符 + .tex */
export const SECTION_FILE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}\.tex$/;

/**
 * M13 Final Closure（真实 Topic → PDF run 1 实录）：摘要按契约是纯文本（Planner / 修订 Writer 都被要求
 * 「不使用任何 LaTeX 命令」），但 writeMainTex 曾把它原样放进 \\begin{abstract}——taxonomy 标签
 * `track_query_based` 的下划线让 xelatex 报 `Missing $ inserted`，build.draft 失败、Draft 无 PDF。
 * 这里只转义会在 text mode 直接报错的四个字符（_ & # %），且只转义**尚未被转义**的（前面没有反斜杠），
 * 不触碰 $ / { } / 反斜杠——摘要里偶发的行内数学或既有转义不被破坏。章节 .tex 由 Writer 自行转义，不经此处。
 */
export function escapeAbstractPlainText(text: string): string {
  return text.replace(/(^|[^\\])([_&#%])/g, (_match, before: string, ch: string) => `${before}\\${ch}`);
}

export class ManuscriptService {
  private readonly projects: ProjectStore;

  constructor(projects: ProjectStore) {
    this.projects = projects;
  }

  private manuscriptDir(projectId: string): string {
    return this.projects.manuscriptDir(projectId);
  }

  private sectionsDir(projectId: string): string {
    return join(this.manuscriptDir(projectId), "sections");
  }

  outlinePath(projectId: string): string {
    return join(this.manuscriptDir(projectId), "outline.json");
  }

  sectionPath(projectId: string, section: OutlineSection): string {
    return join(this.sectionsDir(projectId), section.file);
  }

  bibPath(projectId: string): string {
    return join(this.manuscriptDir(projectId), "references.bib");
  }

  contextPath(projectId: string): string {
    return join(this.projects.projectDir(projectId), "context.yaml");
  }

  /** 校验并保存大纲（manuscript/outline.json）；refs 归一（去重 + 升序）后落盘 */
  async saveOutline(projectId: string, outline: Outline, options: ValidateOutlineOptions = {}): Promise<Outline> {
    const violations = validateOutline(outline, options);
    if (violations.length > 0) {
      throw new BusinessError("STAGE_CONTRACT_VIOLATION", `大纲校验未通过：${violations.join("；")}`);
    }
    const normalized = normalizeOutlineRefs(outline);
    await mkdir(this.sectionsDir(projectId), { recursive: true });
    await writeJsonAtomic(this.outlinePath(projectId), normalized);
    return normalized;
  }

  async loadOutline(projectId: string): Promise<Outline | null> {
    try {
      const raw = await readFile(this.outlinePath(projectId), "utf8");
      return JSON.parse(raw) as Outline;
    } catch {
      return null;
    }
  }

  /**
   * 确定性生成 main.tex（\input 各 section）。
   * 章节按 outline 顺序；有 bibliography 时含 \bibliography{references}。
   * graphicx（M12.3 C5）：加载图片宏包——正文只 \includegraphics 已登记的
   * 生成图资产（figs/generated/），tikz/pgfplots 永不进正文。
   */
  async writeMainTex(projectId: string, outline: Outline, withBibliography: boolean): Promise<string> {
    validateOutline(outline);
    const lines = [
      "\\documentclass[UTF8]{ctexart}",
      "\\usepackage{amsmath}",
      "\\usepackage{amssymb}",
      "\\usepackage{graphicx}",
      ...(withBibliography
        ? ["\\usepackage[numbers]{natbib}"]
        : []),
      "",
      `\\title{${escapeLatex(outline.title)}}`,
      "\\author{}",
      "\\date{}",
      "",
      "\\begin{document}",
      "\\maketitle",
      "",
      ...(outline.abstract
        ? ["\\begin{abstract}", escapeAbstractPlainText(outline.abstract.trim()), "\\end{abstract}", ""]
        : []),
      ...outline.sections.map((section) => `\\input{sections/${section.file.replace(/\.tex$/, "")}}`),
      "",
      ...(withBibliography
        ? ["\\bibliographystyle{unsrt}", "\\bibliography{references}", ""]
        : []),
      "\\end{document}",
      "",
    ];
    const content = lines.join("\n");
    await mkdir(this.manuscriptDir(projectId), { recursive: true });
    await writeFileAtomic(this.projects.mainTexPath(projectId), content);
    return content;
  }

  /** 写入章节正文片段（strip 后落盘；返回字节数） */
  async writeSection(projectId: string, section: OutlineSection, latex: string): Promise<number> {
    if (!SECTION_FILE_PATTERN.test(section.file)) {
      throw new BusinessError("INVALID_REQUEST", `非法章节文件名：${section.file}`);
    }
    await mkdir(this.sectionsDir(projectId), { recursive: true });
    const content = latex.trim() + "\n";
    await writeFile(this.sectionPath(projectId, section), content, "utf8");
    return Buffer.byteLength(content, "utf8");
  }

  /**
   * 由结构化 bibliography 确定性生成 references.bib（M9.5：渲染下沉
   * citation/bibliography.ts——按 key 排序、article/inproceedings/misc 类型化、
   * LaTeX 转义、同输入字节级一致）。重复生成 byte identical。
   */
  async writeBibliography(projectId: string, entries: readonly BibRenderEntry[]): Promise<number> {
    const content = renderBibliographyFile(entries);
    await mkdir(this.manuscriptDir(projectId), { recursive: true });
    await writeFileAtomic(this.bibPath(projectId), content);
    return entries.length;
  }

  /** 章节状态（Derived：从文件系统事实读取） */
  async sectionStatuses(projectId: string): Promise<SectionStatus[]> {
    const outline = await this.loadOutline(projectId);
    if (outline === null) {
      return [];
    }
    const statuses: SectionStatus[] = [];
    for (const section of outline.sections) {
      let exists = false;
      let bytes = 0;
      try {
        const content = await readFile(this.sectionPath(projectId, section), "utf8");
        exists = true;
        bytes = Buffer.byteLength(content, "utf8");
      } catch {
        // 未生成
      }
      statuses.push({
        id: section.id,
        file: section.file,
        title: section.title,
        exists,
        bytes,
        nonEmpty: exists && bytes > 10,
      });
    }
    return statuses;
  }

  /**
   * 构建 / 重建 Derived Context（context.yaml）。
   * 内容全部来自事实来源（outline / section 文件 / evidence / feasibility），
   * 可随时删除重建，不承担 authoritative state。
   */
  async rebuildContext(
    projectId: string,
    extras: { evidenceStats?: EvidenceStats; feasibilityLevel?: string } = {},
  ): Promise<string> {
    const outline = await this.loadOutline(projectId);
    const statuses = await this.sectionStatuses(projectId);
    const lines: string[] = [
      "# PaperTeam Derived Context（可重建，非事实来源；删除后由 Workspace 状态重建）",
      `projectId: ${projectId}`,
      `generatedAt: ${new Date().toISOString()}`,
      "",
      "outline:",
      outline
        ? [
            `  title: ${yamlScalar(outline.title)}`,
            "  sections:",
            ...outline.sections.map(
              (section) =>
                `    - {id: ${section.id}, file: ${section.file}, title: ${yamlScalar(section.title)}}`,
            ),
          ].join("\n")
        : "  ~  # 尚未生成大纲",
      "",
      "sectionStatus:",
      ...(statuses.length > 0
        ? statuses.map(
            (status) =>
              `  ${status.id}: {exists: ${status.exists}, bytes: ${status.bytes}, nonEmpty: ${status.nonEmpty}}`,
          )
        : ["  ~"]),
      "",
      ...(extras.evidenceStats
        ? [
            "evidence:",
            `  total: ${extras.evidenceStats.total}`,
            `  verified: ${extras.evidenceStats.byStatus.verified}`,
            `  unverified: ${extras.evidenceStats.byStatus.unverified}`,
            `  contradictory: ${extras.evidenceStats.contradictory}`,
            "",
          ]
        : []),
      ...(extras.feasibilityLevel
        ? [`feasibility:`, `  level: ${extras.feasibilityLevel}`, ""]
        : []),
    ];
    const content = lines.join("\n");
    await writeFileAtomic(this.contextPath(projectId), content);
    return content;
  }
}

/** 大纲校验（DoD 的确定性部分） */
/** 大纲校验选项：学位论文（M14.2）放宽节数上限（outline 模式差异） */
export interface ValidateOutlineOptions {
  /** 节数上限（缺省 20；thesis_from_papers 用 60） */
  maxSections?: number;
}

export function validateOutline(outline: Outline, options: ValidateOutlineOptions = {}): string[] {
  const maxSections = options.maxSections ?? 20;
  const violations: string[] = [];
  if (typeof outline !== "object" || outline === null) {
    return ["outline 不是对象"];
  }
  if (typeof outline.title !== "string" || outline.title.trim() === "") {
    violations.push("title 必须是非空字符串");
  }
  if (!Array.isArray(outline.sections) || outline.sections.length < 3) {
    violations.push("sections 必须是至少 3 项的数组");
    return violations;
  }
  if (outline.sections.length > maxSections) {
    violations.push(`sections 数量不能超过 ${maxSections}`);
  }
  const ids = new Set<string>();
  const files = new Set<string>();
  for (const section of outline.sections) {
    if (typeof section?.id !== "string" || section.id.trim() === "") {
      violations.push("section.id 必须是非空字符串");
      continue;
    }
    if (typeof section?.title !== "string" || section.title.trim() === "") {
      violations.push(`section ${section.id} 缺少 title`);
    }
    if (!SECTION_FILE_PATTERN.test(section.file ?? "")) {
      violations.push(
        `section ${section.id} 的 file 非法："${section.file}"（应形如 introduction.tex）`,
      );
    }
    if (ids.has(section.id)) {
      violations.push(`section id 重复：${section.id}`);
    }
    if (files.has(section.file)) {
      violations.push(`section file 重复：${section.file}`);
    }
    // M11.1.3：survey refs 形状校验（可选字段；存在则必须是非空字符串数组）。
    // 语义校验（悬空引用 / speculative 泄漏等）属 survey 域 validateSurveyOutline，
    // 不污染普通论文路径。
    for (const [field, refs] of [
      ["synthesisRefs", section.synthesisRefs],
      ["literatureRefs", section.literatureRefs],
    ] as const) {
      if (refs === undefined) {
        continue;
      }
      if (
        !Array.isArray(refs) ||
        refs.some((ref) => typeof ref !== "string" || ref.trim() === "")
      ) {
        violations.push(`section ${section.id} 的 ${field} 必须是非空字符串数组`);
      }
    }
    // M13.7.10：论证单元形状校验（可选字段；语义派生在 writer/argumentUnit）
    violations.push(...validateOutlineArgument(section.id, section.argument));
    ids.add(section.id);
    files.add(section.file);
  }
  return violations;
}

/**
 * M11.1.3：survey refs 归一（trim + 去重 + 升序）。确定性序列化纪律：同一
 * refs 集合无论输入顺序如何，落盘恒同字节；普通论文 outline 无 refs 字段，
 * 原样返回（不新增键）。
 */
export function normalizeOutlineRefs(outline: Outline): Outline {
  const dedupe = (refs: string[]): string[] => [
    ...new Set(refs.map((ref) => ref.trim()).filter((ref) => ref !== "")),
  ].sort();
  let changed = false;
  const sections = outline.sections.map((section) => {
    const next = { ...section };
    if (section.synthesisRefs !== undefined) {
      const normalized = dedupe(section.synthesisRefs);
      if (normalized.length === 0) {
        delete next.synthesisRefs;
        changed = true;
      } else if (normalized.join(" ") !== section.synthesisRefs.join(" ")) {
        next.synthesisRefs = normalized;
        changed = true;
      }
    }
    if (section.literatureRefs !== undefined) {
      const normalized = dedupe(section.literatureRefs);
      if (normalized.length === 0) {
        delete next.literatureRefs;
        changed = true;
      } else if (normalized.join(" ") !== section.literatureRefs.join(" ")) {
        next.literatureRefs = normalized;
        changed = true;
      }
    }
    // M13.7.10：argument 归一（去重 / 去空；全空删除键，旧 Outline 无键不新增）
    if (section.argument !== undefined) {
      const normalized = normalizeOutlineArgument(section.argument);
      if (normalized === undefined) {
        delete next.argument;
        changed = true;
      } else if (JSON.stringify(normalized) !== JSON.stringify(section.argument)) {
        next.argument = normalized;
        changed = true;
      }
    }
    return next;
  });
  return changed ? { ...outline, sections } : outline;
}

function escapeLatex(value: string): string {
  return value.replace(/([&%$#_{}])/g, "\\$1");
}

function yamlScalar(value: string): string {
  const cleaned = value.replaceAll("\"", "'");
  return `"${cleaned}"`;
}
