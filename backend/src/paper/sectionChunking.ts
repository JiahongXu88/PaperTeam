/**
 * 解析产物 → 领域结构组装（M4.3.1）：pages / sections / chunks / 质量评级。
 *
 * 纯 TypeScript 确定性代码（不依赖 Python，单测直接喂 RawPdfExtraction）：
 * - sections：PDF TOC outline（权威）> 页内标题正则 > 整档兜底；
 * - chunks：连续文本块聚合（~1800 字符、不跨 section），每 chunk 带页码 provenance；
 * - quality：页均字符 + 可打印比例（与 builtin 分析器同一口径）。
 */

import type { PaperChunk, PaperPage, PaperSection } from "./types.js";
import type { RawPdfExtraction } from "./PdfParser.js";

/** chunk 目标大小（字符）：单 section review 的输入单位 */
const CHUNK_TARGET_CHARS = 1800;
/** chunk 硬上限（保证单 chunk 不超模型上下文预算的量级） */
const CHUNK_MAX_CHARS = 2600;

export interface AssembledPaper {
  title: string | undefined;
  abstract: string;
  pages: PaperPage[];
  sections: PaperSection[];
  chunks: PaperChunk[];
  extractionQuality: "good" | "partial" | "poor";
  abstractSectionId: string | undefined;
  referencesSectionId: string | undefined;
}

export function assemblePaper(extraction: RawPdfExtraction): AssembledPaper {
  const pageCount = extraction.pageCount;
  const pages = buildPages(extraction);
  const sections = buildSections(extraction, pages);
  const blocksWithSection = assignBlocksToSections(extraction.blocks, sections);
  const chunks = buildChunks(blocksWithSection);
  for (const section of sections) {
    section.charCount = chunks
      .filter((chunk) => chunk.sectionId === section.sectionId)
      .reduce((sum, chunk) => sum + chunk.charCount, 0);
  }
  return {
    title: extraction.title.trim() === "" ? undefined : extraction.title.trim(),
    abstract: extraction.abstract,
    pages,
    sections,
    chunks,
    extractionQuality: rateQuality(extraction, pageCount),
    abstractSectionId: sections.find((section) => ABSTRACT_TITLES.test(section.title))?.sectionId,
    referencesSectionId: sections.find((section) => REFERENCES_TITLES.test(section.title))
      ?.sectionId,
  };
}

const ABSTRACT_TITLES = /^(abstract|摘要)\s*$/i;
const REFERENCES_TITLES = /^(references|bibliography|参考文献|reference list)\s*$/i;

// ---- pages ----

function buildPages(extraction: RawPdfExtraction): PaperPage[] {
  const byPage = new Map<number, string[]>();
  for (const block of extraction.blocks) {
    const list = byPage.get(block.page) ?? [];
    list.push(block.text);
    byPage.set(block.page, list);
  }
  const pages: PaperPage[] = [];
  for (let pageNumber = 1; pageNumber <= extraction.pageCount; pageNumber += 1) {
    const text = (byPage.get(pageNumber) ?? []).join("\n\n");
    pages.push({
      pageId: `P${String(pageNumber).padStart(3, "0")}`,
      pageNumber,
      text,
      charCount: text.length,
    });
  }
  return pages;
}

// ---- sections ----

function buildSections(extraction: RawPdfExtraction, pages: PaperPage[]): PaperSection[] {
  let sections: PaperSection[];
  if (extraction.toc.length >= 2) {
    sections = sectionsFromToc(extraction.toc, extraction.pageCount);
  } else {
    const headingSections = sectionsFromHeadings(pages);
    sections =
      headingSections.length >= 2
        ? headingSections
        : [
            {
              sectionId: "SEC01",
              title: "Whole Document",
              level: 1,
              pageStart: 1,
              pageEnd: extraction.pageCount,
              charCount: 0,
              source: "whole-document",
            },
          ];
  }
  // TOC 常缺 References 书签（引用提取的关键 section）：标题行 + [n] 条目双重确认后补齐
  if (!sections.some((section) => REFERENCES_TITLES.test(section.title))) {
    const referencesPage = findReferencesPage(pages);
    if (referencesPage !== undefined) {
      sections.push({
        sectionId: `SEC${String(sections.length + 1).padStart(2, "0")}`,
        title: "References",
        level: 1,
        pageStart: referencesPage,
        pageEnd: extraction.pageCount,
        charCount: 0,
        source: "heading-pattern",
      });
    }
  }
  return dedupeSections(sections);
}

/** 找 References 章节首页：标题行独立成行 + 页内含 [n] 条目标记（双条件降误报） */
function findReferencesPage(pages: PaperPage[]): number | undefined {
  for (const page of pages) {
    if (!/^\s*references\s*$/im.test(page.text)) {
      continue;
    }
    if (/\[\d{1,3}\]/.test(page.text)) {
      return page.pageNumber;
    }
  }
  return undefined;
}

/** TOC outline → sections（权威路径） */
function sectionsFromToc(
  toc: Array<[number, string, number]>,
  pageCount: number,
): PaperSection[] {
  const sections: PaperSection[] = [];
  for (let index = 0; index < toc.length; index += 1) {
    const [level, rawTitle, startPage] = toc[index]!;
    const title = rawTitle.trim();
    if (title === "") {
      continue;
    }
    const nextStart = toc
      .slice(index + 1)
      .find(([, , next]) => next >= startPage)?.[2] ?? pageCount;
    const pageStart = Math.max(1, startPage);
    const pageEnd = Math.max(pageStart, Math.min(pageCount, nextStart));
    sections.push({
      sectionId: `SEC${String(sections.length + 1).padStart(2, "0")}`,
      title,
      level: Math.max(1, level),
      pageStart,
      pageEnd,
      charCount: 0,
      source: "toc",
    });
  }
  return dedupeSections(sections);
}

/** 页内标题正则 → sections（无 TOC 的兜底；覆盖编号章节 + 常见专名章节） */
function sectionsFromHeadings(pages: PaperPage[]): PaperSection[] {
  const headingPattern =
    /^\s*(?:(\d{1,2})(?:\.\d{1,2})*\.?\s+)?(abstract|introduction|related work|background|preliminar\w*|method(s|ology)?|approach|experiment(s|al results)?|evaluation|results|discussion|conclusion(s)?|acknowledg\w*|references|bibliography)\s*$/im;
  const found: Array<{ title: string; page: number }> = [];
  for (const page of pages) {
    const match = headingPattern.exec(page.text);
    if (match !== null) {
      const title = (match[2] ?? "").trim();
      if (title !== "" && !found.some((entry) => entry.title.toLowerCase() === title.toLowerCase())) {
        found.push({ title, page: page.pageNumber });
      }
    }
  }
  if (found.length < 2) {
    return [];
  }
  const pageCount = pages.length;
  return found.map((entry, index) => ({
    sectionId: `SEC${String(index + 1).padStart(2, "0")}`,
    title: entry.title,
    level: 1,
    pageStart: entry.page,
    pageEnd: Math.max(entry.page, found[index + 1]?.page ?? pageCount),
    charCount: 0,
    source: "heading-pattern" as const,
  }));
}

/** 同页同标题（书签+页首重复出现）去重，保持顺序 */
function dedupeSections(sections: PaperSection[]): PaperSection[] {
  const seen = new Set<string>();
  const out: PaperSection[] = [];
  for (const section of sections) {
    const key = `${section.title.toLowerCase()}`;
    if (seen.has(key)) {
      continue;
    }
    seen.add(key);
    out.push({ ...section, sectionId: `SEC${String(out.length + 1).padStart(2, "0")}` });
  }
  return out;
}

// ---- chunks ----

interface BlockWithSection {
  page: number;
  text: string;
  sectionId: string;
}

/** block → section：页落在区间内的最后一个（文档顺序最靠后/最深）section */
function assignBlocksToSections(
  blocks: Array<{ page: number; text: string }>,
  sections: PaperSection[],
): BlockWithSection[] {
  return blocks.map((block) => {
    let chosen = sections[0]!;
    for (const section of sections) {
      if (block.page >= section.pageStart && block.page <= section.pageEnd) {
        chosen = section;
      }
    }
    return { page: block.page, text: block.text, sectionId: chosen.sectionId };
  });
}

/** 连续同 section block 聚合为 chunk（目标 ~1800、硬上限 2600 字符） */
function buildChunks(blocks: BlockWithSection[]): PaperChunk[] {
  const chunks: PaperChunk[] = [];
  let current: { pageStart: number; pageEnd: number; sectionId: string; parts: string[] } | null =
    null;

  const flush = () => {
    if (current === null) {
      return;
    }
    const text = current.parts.join("\n\n");
    chunks.push({
      chunkId: `C${String(chunks.length + 1).padStart(4, "0")}`,
      sequence: chunks.length + 1,
      pageStart: current.pageStart,
      pageEnd: current.pageEnd,
      sectionId: current.sectionId,
      text,
      charCount: text.length,
    });
    current = null;
  };

  for (const block of blocks) {
    if (current === null) {
      current = {
        pageStart: block.page,
        pageEnd: block.page,
        sectionId: block.sectionId,
        parts: [block.text],
      };
      continue;
    }
    const joinedLength =
      current.parts.reduce((sum, part) => sum + part.length, 0) + block.text.length + 2;
    const sameSection = current.sectionId === block.sectionId;
    if (!sameSection || joinedLength > CHUNK_MAX_CHARS || (sameSection && joinedLength > CHUNK_TARGET_CHARS && current.parts.length >= 2)) {
      flush();
      current = {
        pageStart: block.page,
        pageEnd: block.page,
        sectionId: block.sectionId,
        parts: [block.text],
      };
      continue;
    }
    current.parts.push(block.text);
    current.pageEnd = block.page;
  }
  flush();
  return chunks;
}

// ---- quality ----

function rateQuality(extraction: RawPdfExtraction, pageCount: number): "good" | "partial" | "poor" {
  const avg = extraction.totalChars / Math.max(1, pageCount);
  const fullText = extraction.blocks.map((block) => block.text).join("");
  const ratio = printableRatio(fullText);
  if (avg >= 300 && ratio >= 0.7) {
    return "good";
  }
  if (extraction.totalChars >= 60 && ratio >= 0.5) {
    return "partial";
  }
  return "poor";
}

function printableRatio(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  let printable = 0;
  for (const ch of text) {
    const code = ch.codePointAt(0) ?? 0;
    if (
      (code >= 0x20 && code <= 0x7e) ||
      (code >= 0x4e00 && code <= 0x9fff) ||
      ch === "\n" ||
      ch === "\t"
    ) {
      printable += 1;
    }
  }
  return printable / text.length;
}
