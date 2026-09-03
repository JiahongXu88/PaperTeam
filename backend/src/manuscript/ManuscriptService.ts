/**
 * Section-based Manuscript 管理（M3.1）。
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
import type { BibliographyEntryInput } from "../agents/ResearcherService.js";
import { writeJsonAtomic, writeFileAtomic } from "../util/atomic.js";

export interface OutlineSection {
  id: string;
  /** 章节文件名（sections/ 下，如 introduction.tex） */
  file: string;
  title: string;
  targetLengthWords?: number;
  keyPoints?: string[];
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
const SECTION_FILE_PATTERN = /^[a-z0-9][a-z0-9-]{0,63}\.tex$/;

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

  /** 校验并保存大纲（manuscript/outline.json） */
  async saveOutline(projectId: string, outline: Outline): Promise<Outline> {
    const violations = validateOutline(outline);
    if (violations.length > 0) {
      throw new BusinessError("STAGE_CONTRACT_VIOLATION", `大纲校验未通过：${violations.join("；")}`);
    }
    await mkdir(this.sectionsDir(projectId), { recursive: true });
    await writeJsonAtomic(this.outlinePath(projectId), outline);
    return outline;
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
   */
  async writeMainTex(projectId: string, outline: Outline, withBibliography: boolean): Promise<string> {
    validateOutline(outline);
    const lines = [
      "\\documentclass[UTF8]{ctexart}",
      "\\usepackage{amsmath}",
      "\\usepackage{amssymb}",
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
        ? ["\\begin{abstract}", outline.abstract.trim(), "\\end{abstract}", ""]
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

  /** 由结构化 bibliography 确定性生成 references.bib */
  async writeBibliography(projectId: string, entries: BibliographyEntryInput[]): Promise<number> {
    const content = entries.map(renderBibEntry).join("\n\n") + (entries.length > 0 ? "\n" : "");
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
export function validateOutline(outline: Outline): string[] {
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
  if (outline.sections.length > 20) {
    violations.push("sections 数量不能超过 20");
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
    ids.add(section.id);
    files.add(section.file);
  }
  return violations;
}

function renderBibEntry(entry: BibliographyEntryInput): string {
  const fields: string[] = [`  title = {${entry.title}}`];
  if (entry.authors?.length) {
    fields.push(`  author = {${entry.authors.join(" and ")}}`);
  }
  if (entry.year !== undefined) {
    fields.push(`  year = {${entry.year}}`);
  }
  if (entry.doi) {
    fields.push(`  doi = {${entry.doi}}`);
  }
  if (entry.url) {
    fields.push(`  url = {${entry.url}}`);
  }
  if (entry.venue) {
    fields.push(`  journal = {${entry.venue}}`);
  }
  return `@article{${entry.key},\n${fields.join(",\n")}\n}`;
}

function escapeLatex(value: string): string {
  return value.replace(/([&%$#_{}])/g, "\\$1");
}

function yamlScalar(value: string): string {
  const cleaned = value.replaceAll("\"", "'");
  return `"${cleaned}"`;
}
