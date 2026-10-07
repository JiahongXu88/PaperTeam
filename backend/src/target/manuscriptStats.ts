/**
 * 当前稿（manuscript）的确定性观测（M12 Batch 2 · A8 输入侧）。
 *
 * 纪律（与 A7 的 paperStats 同构）：
 * - 确定性优先：全部指标来自 .tex 文本 / visualInventory（B1 产物，可缺省）/
 *   citation key 提取（StaticCitationChecker 同款正则），零 LLM；
 * - 不存在的东西如实为 null（无 abstract 环境 → abstractWords=null，不把
 *   首段当摘要）；手稿不存在 → exists=false 的空壳（readiness 全维
 *   INSUFFICIENT_EVIDENCE，不 crash）；
 * - 词数口径与 paperStats 对齐：剥注释/命令/环境定界后的 Unicode 词元计数
 *   （与 PDF 解析侧「全部 text 块词元」口径可比）。
 */

import { extractCitationKeys } from "../citation/StaticCitationChecker.js";
import { collectLatexFiles, type LatexProjectFiles } from "../manuscript/LatexFiles.js";
import { loadVisualInventory, type ManuscriptVisualInventory } from "../manuscript/visualInventory.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { canonicalSectionName, countWords } from "./paperStats.js";
import { round2 } from "./quantiles.js";

export interface ManuscriptObservation {
  /** manuscript 目录是否有任何 .tex（false → readiness 无观测点） */
  exists: boolean;
  files: string[];
  totalWords: number | null;
  abstractWords: number | null;
  /** 规范化章节名 → 词数（与 profile sectionPattern 同键空间） */
  sectionWords: Map<string, number>;
  /** distinct \cite key 数 */
  citationKeyCount: number | null;
  /** 每 100 词引用密度 */
  citationDensity: number | null;
  /** 表环境数（visualInventory 优先；缺省回退 \begin{table} 计数） */
  tableCount: number | null;
  /** figure 环境数（visualInventory 优先；缺省回退 \includegraphics 计数） */
  figureCount: number | null;
  /** distinct dataset 候选数（与 paperStats 同款启发式） */
  datasetCount: number | null;
  /** method 章词数（无 method 章 → null） */
  methodSectionWords: number | null;
  /** 含 ablation 表述（确定性字符串判定；与 paperStats 同口径） */
  ablationPresent: boolean;
  limitationsPresent: boolean;
  /** 方法总览图启发式（caption/文件名命中） */
  methodDiagramPresent: boolean | null;
  /** 指标来源（观测口径披露） */
  source: { visualInventory: boolean; latexDirect: boolean };
}

const ABSTRACT_PATTERN = /\\begin\{abstract\}([\s\S]*?)\\end\{abstract\}/;
const DATASET_NAME_PATTERN = /([A-Za-z][A-Za-z0-9&'+.\-]{1,40})\s+(datasets?|benchmarks?|corpora|corpus)\b/gi;
const METHOD_DIAGRAM_PATTERN = /(overview|architecture|framework|pipeline|整体(结构|框架|架构)|方法(结构|框架|总览))/i;
const LIMITATION_PATTERN = /limitation|局限性/i;
const MAX_DATASET_CANDIDATES = 30;

/** .tex → 词数口径文本（剥注释 / 环境定界 / 命令 / 花括号；确定性） */
export function texWordText(content: string): string {
  return content
    .replace(/\r\n/g, "\n")
    .replace(/(?<!\\)%[^\n]*/g, "")
    .replace(/\\(?:begin|end)\{[^}]*\}/g, " ")
    .replace(/\\[A-Za-z@]+\*?(?:\[[^\]\n]*\])?/g, " ")
    .replace(/[{}]/g, " ");
}

export function texWords(content: string): number {
  return countWords(texWordText(content));
}

/**
 * 顶层章节切分（\chapter / \section 级；subsection 不独立成段——避免与上级
 * 章节区间重叠造成双重计数）。PDF 侧章节词来自解析产物 section 归属，两侧
 * 通过 canonical 章节名对齐。
 */
export function topLevelSections(content: string): Array<{ heading: string; body: string }> {
  const normalized = content.replace(/\r\n/g, "\n");
  const pattern = /^[ \t]*\\(chapter|section)\*?[ \t]*\{([^}]*)\}/gm;
  const marks: Array<{ start: number; heading: string }> = [];
  for (const match of normalized.matchAll(pattern)) {
    marks.push({ start: match.index ?? 0, heading: (match[2] ?? "").trim() });
  }
  return marks.map((mark, index) => ({
    heading: mark.heading,
    body: normalized.slice(mark.start, marks[index + 1]?.start ?? normalized.length),
  }));
}

/** 观测当前稿（visualInventory 产物存在则用，缺省直接 .tex 确定性回退） */
export async function observeManuscript(
  projects: ProjectStore,
  projectId: string,
): Promise<ManuscriptObservation> {
  const files: LatexProjectFiles = await collectLatexFiles(projects.manuscriptDir(projectId));
  const texFiles = files.allTex;
  const empty: ManuscriptObservation = {
    exists: false,
    files: [],
    totalWords: null,
    abstractWords: null,
    sectionWords: new Map(),
    citationKeyCount: null,
    citationDensity: null,
    tableCount: null,
    figureCount: null,
    datasetCount: null,
    methodSectionWords: null,
    ablationPresent: false,
    limitationsPresent: false,
    methodDiagramPresent: null,
    source: { visualInventory: false, latexDirect: false },
  };
  if (texFiles.length === 0) {
    return empty;
  }

  // visual inventory（B1 产物；可缺省——A8 不依赖 B 轨进度）
  let inventory: ManuscriptVisualInventory | null = null;
  try {
    inventory = await loadVisualInventory(projects, projectId);
  } catch {
    inventory = null; // 损坏产物按无产物处理（readiness 不因 B1 产物损坏而 crash）
  }

  let totalWords = 0;
  const sectionWords = new Map<string, number>();
  const citationKeys = new Set<string>();
  let limitationsPresent = false;
  let abstractWords: number | null = null;
  const allProse: string[] = [];

  for (const file of texFiles) {
    const content = file.content;
    totalWords += texWords(content);
    allProse.push(content);
    for (const key of extractCitationKeys(file.relativePath, content).keys) {
      citationKeys.add(key);
    }
    if (LIMITATION_PATTERN.test(texWordText(content))) {
      limitationsPresent = true;
    }
    if (abstractWords === null) {
      const match = ABSTRACT_PATTERN.exec(content);
      if (match !== null) {
        abstractWords = texWords(match[1] ?? "");
      }
    }
    for (const span of topLevelSections(content)) {
      const canonical = canonicalSectionName(span.heading);
      if (canonical !== "") {
        sectionWords.set(canonical, (sectionWords.get(canonical) ?? 0) + texWords(span.body));
      }
    }
  }

  // dataset 广度（与 paperStats 完全同款启发式——两侧口径必须一致）
  const prose = allProse.join("\n");
  const datasetNames = new Set<string>();
  for (const match of prose.matchAll(DATASET_NAME_PATTERN)) {
    const token = ((match[1] ?? "").trim().split(/\s+/).at(-1) ?? "").toLowerCase();
    if (token.length >= 2) {
      datasetNames.add(token);
    }
    if (datasetNames.size >= MAX_DATASET_CANDIDATES) {
      break;
    }
  }

  // 表/图计数：visualInventory 优先；缺省确定性回退（\begin{table*?} / \includegraphics）
  let tableCount: number | null;
  let figureCount: number | null;
  let methodDiagramPresent: boolean | null = null;
  if (inventory !== null) {
    tableCount = inventory.files.reduce((sum, file) => sum + file.tables.length, 0);
    figureCount = inventory.files.reduce((sum, file) => sum + file.figures.length, 0);
    methodDiagramPresent = inventory.files.some((file) =>
      file.figures.some(
        (figure) =>
          (figure.caption !== undefined && METHOD_DIAGRAM_PATTERN.test(figure.caption)) ||
          (figure.includegraphicsPath !== undefined && METHOD_DIAGRAM_PATTERN.test(figure.includegraphicsPath)),
      ),
    );
  } else {
    tableCount = (prose.match(/\\begin\{table\*?\}/g) ?? []).length;
    figureCount = (prose.match(/\\includegraphics/g) ?? []).length;
  }

  const citationKeyCount = citationKeys.size;
  return {
    exists: true,
    files: texFiles.map((file) => file.relativePath),
    totalWords,
    abstractWords,
    sectionWords,
    citationKeyCount,
    citationDensity: totalWords > 0 ? round2((citationKeyCount / totalWords) * 100) : null,
    tableCount,
    figureCount,
    datasetCount: datasetNames.size,
    methodSectionWords: sectionWords.get("method") ?? null,
    ablationPresent: /ablation/i.test(texWordText(prose)),
    limitationsPresent,
    methodDiagramPresent,
    source: { visualInventory: inventory !== null, latexDirect: true },
  };
}
