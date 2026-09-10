/**
 * PDF → 可修订 manuscript 重建（M4.8 Existing Paper Improvement 闭环）。
 *
 * 背景：PDF 导入 + goal=improvement 的项目此前在 import.parse 处中断——
 * 「项目缺少可解析的 main.tex」。本模块用确定性代码（零 LLM）把已解析的
 * PaperDocument 重建为 outline + 分节 LaTeX + references.bib + 组装根：
 *
 *   outline.json     标题 + 摘要（abstractSectionId 文本）+ 章节清单
 *   sections/*.tex   每个正文章节一个文件（\section 标题 + 转义正文）
 *   references.bib   ReferenceExtractor 条目 → @misc{refN}
 *   main.tex         ManuscriptService.writeMainTex 组装（含 \cite 映射后的正文）
 *
 * 重建是文本级的（不含原图 / 原版式；公式以转义文本呈现）——这是如实边界，
 * 不是隐藏行为；改进工作流的 Writer 修订在此基础上逐节重写。
 *
 * 纪律：
 * - 确定性：同输入同输出（幂等，可从 checkpoint 重放）；
 * - 不猜：无法安全重建（无文档 / 正文过少）→ 返回 null 或明确错误，不产半成品；
 * - LaTeX 转义先于 \cite 映射（标记本身不含特殊字符，不受转义影响）。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { BusinessError } from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { PaperStore } from "../paper/PaperStore.js";
import type { PaperSection } from "../paper/types.js";
import type { ManuscriptService, Outline, OutlineSection } from "../manuscript/ManuscriptService.js";
import { ReferenceExtractor } from "../paper/ReferenceExtractor.js";
import type { CitationCallout, ReferenceEntry } from "../citation/integrity.js";
import { writeJsonAtomic } from "../util/atomic.js";

/** 正文章节进入重建的最小字符量（与 Review 的空章节口径一致） */
const MIN_SECTION_CHARS = 80;
/** validateOutline 的章节数上限；超出时先合并子章节、再合并最短相邻章节 */
const MAX_OUTLINE_SECTIONS = 20;

export interface ReconstructResult {
  reconstructed: true;
  /** 重建的章节文件数 */
  sections: number;
  /** references.bib 条目数 */
  references: number;
  /** [n] 标记成功映射为 \cite 的次数 */
  citationsMapped: number;
  warnings: string[];
}

export interface ReconstructOptions {
  projects: ProjectStore;
  paper: PaperStore;
  manuscript: ManuscriptService;
  projectId: string;
  /** 论文标题兜底（PDF 未识别出标题时） */
  projectTitle: string;
}

/** LaTeX 特殊字符转义（比 writeMainTex 的标题转义多覆盖 \ ^ ~——PDF 正文可能包含） */
export function escapeLatexText(value: string): string {
  return value
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([*&%$#_{}])/g, "\\$1")
    .replace(/\^/g, "\\textasciicircum{}")
    .replace(/~/g, "\\textasciitilde{}");
}

/** PDF 正文 → 可修订 LaTeX：转义 + [n] 引用标记 → \cite{refN}（基于提取器 relations） */
function toRevisableLatex(text: string, callouts: CitationCallout[], keyByReferenceId: Map<string, string>): { latex: string; mapped: number } {
  let mapped = 0;
  let out = escapeLatexText(text);
  // rawText 精确替换（提取器已做 [n] 展开与范围关联；标记文本不含转义字符）
  for (const callout of callouts) {
    if (callout.rawText === undefined || !callout.rawText.includes("[")) {
      continue; // author-year 风格与未识别标记不动（保持原文，不猜）
    }
    const keys = callout.references
      .filter((relation) => relation.status === "resolved" && relation.referenceId !== undefined)
      .map((relation) => keyByReferenceId.get(relation.referenceId ?? ""))
      .filter((key): key is string => key !== undefined);
    if (keys.length === 0) {
      continue;
    }
    const escaped = escapeLatexText(callout.rawText);
    if (out.includes(escaped)) {
      out = out.split(escaped).join(`\\cite{${keys.join(", ")}}`);
      mapped += 1;
    }
  }
  return { latex: out, mapped };
}

function bibEntry(key: string, entry: ReferenceEntry): string {
  const fields: string[] = [];
  if (entry.title !== undefined && entry.title !== "") {
    fields.push(`  title = {${escapeLatexText(entry.title)}}`);
  }
  if (entry.authors !== undefined && entry.authors.length > 0) {
    fields.push(`  author = {${escapeLatexText(entry.authors.join(" and "))}}`);
  }
  if (entry.year !== undefined) {
    fields.push(`  year = {${entry.year}}`);
  }
  if (fields.length === 0) {
    // 条目字段全缺：以原文落 bib（保持 \cite 可解析，内容可追溯）
    fields.push(`  note = {${escapeLatexText(entry.rawText.slice(0, 300))}}`);
  }
  return `@misc{${key},\n${fields.join(",\n")}\n}\n`;
}

/** 章节合并：level ≥ 2 并入前一个 level-1 章节（保留主章节标题） */
function mergeSubsections(sections: ReconstructSection[]): ReconstructSection[] {
  const out: ReconstructSection[] = [];
  for (const section of sections) {
    const previous = out[out.length - 1];
    if (previous !== undefined && section.level >= 2) {
      previous.text = `${previous.text}\n\n${section.text}`;
      previous.warnings.push(`子章节「${section.title}」并入「${previous.title}」`);
      continue;
    }
    out.push(section);
  }
  return out;
}

/** 仍超上限：反复合并「合并后最短」的相邻章节（确定性） */
function mergeToLimit(sections: ReconstructSection[], limit: number): ReconstructSection[] {
  let out = [...sections];
  while (out.length > limit) {
    let bestIndex = 0;
    let bestSize = Number.MAX_SAFE_INTEGER;
    for (let index = 0; index < out.length - 1; index += 1) {
      const size = out[index]!.text.length + out[index + 1]!.text.length;
      if (size < bestSize) {
        bestSize = size;
        bestIndex = index;
      }
    }
    const first = out[bestIndex]!;
    const second = out[bestIndex + 1]!;
    out.splice(
      bestIndex,
      2,
      {
        ...first,
        title: first.title,
        text: `${first.text}\n\n${second.text}`,
        warnings: [...first.warnings, ...second.warnings, `「${second.title}」并入「${first.title}」（章节数超过 ${limit}）`],
      },
    );
  }
  return out;
}

interface ReconstructSection {
  source: PaperSection;
  title: string;
  text: string;
  level: number;
  warnings: string[];
}

/**
 * 重建 manuscript（确定性）。无已解析文档 → null（调用方决定是否报错）；
 * 正文结构不足以形成合法大纲 → BusinessError（如实失败，不产半成品大纲）。
 */
export async function reconstructManuscriptFromPaper(options: ReconstructOptions): Promise<ReconstructResult | null> {
  const { projects, paper, manuscript, projectId, projectTitle } = options;
  const document = await paper.loadDocument(projectId);
  if (document === null) {
    return null;
  }

  const warnings: string[] = [];
  const extractor = new ReferenceExtractor();
  const extraction = extractor.extract(document);

  // referenceId → bib key（按条目出现顺序编号；number 与 raw [n] 对齐由提取器保证）
  const keyByReferenceId = new Map<string, string>();
  const orderedReferences = [...extraction.references].sort((a, b) => {
    const numberA = a.number ?? Number.MAX_SAFE_INTEGER;
    const numberB = b.number ?? Number.MAX_SAFE_INTEGER;
    return numberA === numberB ? a.referenceId.localeCompare(b.referenceId) : numberA - numberB;
  });
  const bibLines: string[] = ["% 由 PDF 解析结果重建（PaperReconstructor；文本级，不含原图）\n"];
  orderedReferences.forEach((entry, index) => {
    const key = `ref${entry.number ?? index + 1}`;
    keyByReferenceId.set(entry.referenceId, key);
    bibLines.push(bibEntry(key, entry));
  });

  // 正文章节：排除 References / 摘要；按 chunk 组装文本
  const chunksBySection = new Map<string, string[]>();
  for (const chunk of document.chunks) {
    const list = chunksBySection.get(chunk.sectionId) ?? [];
    list.push(chunk.text);
    chunksBySection.set(chunk.sectionId, list);
  }
  const calloutsBySection = new Map<string, CitationCallout[]>();
  for (const callout of extraction.callouts) {
    const list = calloutsBySection.get(callout.sectionId) ?? [];
    list.push(callout);
    calloutsBySection.set(callout.sectionId, list);
  }

  const skipped = [document.referencesSectionId, document.abstractSectionId];
  let bodySections: ReconstructSection[] = [];
  for (const section of document.sections) {
    if (skipped.includes(section.sectionId)) {
      continue;
    }
    const text = (chunksBySection.get(section.sectionId) ?? []).join("\n\n").trim();
    if (text.length < MIN_SECTION_CHARS) {
      continue; // 标题型 / 空章节：不进入重建（与 Review 的空章节口径一致）
    }
    bodySections.push({ source: section, title: section.title.trim(), text, level: section.level, warnings: [] });
  }
  const subsectionMerged = bodySections.length > MAX_OUTLINE_SECTIONS ? mergeSubsections(bodySections) : bodySections;
  bodySections = subsectionMerged.length > MAX_OUTLINE_SECTIONS ? mergeToLimit(subsectionMerged, MAX_OUTLINE_SECTIONS) : subsectionMerged;
  if (bodySections.length < 3) {
    throw new BusinessError(
      "IMPORT_VALIDATION",
      `论文正文结构过少（${bodySections.length} 个有效章节），无法重建可修订稿件；建议改用「快速 Review」`,
    );
  }
  for (const section of bodySections) {
    warnings.push(...section.warnings);
  }
  if (extraction.references.length === 0) {
    warnings.push("未识别到参考文献条目：references.bib 为空，正文引用标记保持原文");
  }

  // 摘要：解析器提取的原文优先（TOC 无 Abstract 条目时 abstractSectionId 缺失），
  // 否则用摘要章节 chunks；转义后作为 outline.abstract 纯文本载体
  const abstractFromSection =
    document.abstractSectionId !== undefined
      ? (chunksBySection.get(document.abstractSectionId) ?? []).join("\n\n").trim()
      : "";
  const documentAbstract = document.abstract ?? "";
  const abstractText = documentAbstract !== "" ? documentAbstract : abstractFromSection;
  const abstract = abstractText !== "" ? escapeLatexText(abstractText.trim()).slice(0, 2000) : undefined;

  // 章节文件（sec01.tex…；\section 标题 + 转义正文 + \cite 映射）
  const outlineSections: OutlineSection[] = [];
  let citationsMapped = 0;
  for (const [index, section] of bodySections.entries()) {
    const file = `sec${String(index + 1).padStart(2, "0")}.tex`;
    const { latex, mapped } = toRevisableLatex(
      section.text,
      calloutsBySection.get(section.source.sectionId) ?? [],
      keyByReferenceId,
    );
    citationsMapped += mapped;
    const heading = section.level >= 2 ? "\\subsection" : "\\section";
    const content = `${heading}{${escapeLatexText(section.title)}}\n\n${latex.trim()}\n`;
    outlineSections.push({
      id: `sec${index + 1}`,
      file,
      title: section.title.slice(0, 80),
    });
    await manuscript.writeSection(projectId, { id: `sec${index + 1}`, file, title: section.title.slice(0, 80) }, content);
  }

  const outline: Outline = {
    title: (document.title ?? projectTitle).trim(),
    ...(abstract !== undefined ? { abstract } : {}),
    sections: outlineSections,
  };
  await manuscript.saveOutline(projectId, outline);

  // references.bib + 组装根
  await mkdir(projects.manuscriptDir(projectId), { recursive: true });
  await writeFile(join(projects.manuscriptDir(projectId), "references.bib"), bibLines.join("\n"), "utf8");
  await manuscript.writeMainTex(projectId, outline, orderedReferences.length > 0);

  return {
    reconstructed: true,
    sections: outlineSections.length,
    references: orderedReferences.length,
    citationsMapped,
    warnings: warnings.slice(0, 5),
  };
}

/** 供测试与诊断读取的落盘路径（不重复实现） */
export function reconstructionReportPath(projects: ProjectStore, projectId: string): string {
  return join(projects.manuscriptDir(projectId), "reconstruction.json");
}

/** 重建报告留档（幂等重写；结构化，供 UI / 诊断读取） */
export async function writeReconstructionReport(
  projects: ProjectStore,
  projectId: string,
  result: ReconstructResult,
): Promise<void> {
  await writeJsonAtomic(reconstructionReportPath(projects, projectId), {
    ...result,
    reconstructedAt: new Date().toISOString(),
  });
}
