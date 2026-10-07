/**
 * VisualArtifactView 投影（M12 Batch 1 · B2：纯函数、无 IO、无新持久 store）。
 *
 * M12.0 §8.1 冻结裁决：视觉事实已有三个权威源（PDF：sources/parsed/
 * <id>.document.json 的块；LaTeX：manuscript/ .tex 文件本身；生成图：M12.3
 * figure store）。本模块只提供**消费视角的统一只读形状**——reviewer / gate
 * 要同时看三方，但绝不再造第二事实源。
 *
 * 纪律：
 * - view 字段全部是权威源的**拷贝**（扁平结构显式复制，改 view 不影响源）；
 *   view 无任何落盘通道——**禁止反向写回**权威源；
 * - id 由权威源坐标确定性生成（同输入同 id），无随机 / 无 UUID；
 * - PDF 与 LaTeX 的底层 raw representation 不强行统一——只统一视图
 *   （sourceKind 三值：pdf_parsed / latex_env / generated）；
 * - figure 细分类型（figureType）可判断才填、不猜：pdf 侧来自调用方提供的
 *   FigureAnalysis.figureType；latex 侧缺省；generated 侧来自生成元数据
 *   （plot→chart、diagram→diagram）；
 * - `analysis` 仅 pdf_parsed 可附带，且 freshness（imageHash/analyzedModelSpec/
 *   outputSchemaVersion/sourceContentHash 四键全同）是**调用方职责**——
 *   投影函数只透传、不校验（见 fromParsedBlocks 注释）。
 *
 * 三个独立入口（而非一个判别入口）的理由：调用方在调用点天然知道自己的
 * 权威源类型，且三种源的输入形状完全不同（ParsedDocument / inventory /
 * 生成记录）；单一判别入口只会把调用方刚做完的判别再要求做一遍（包装成
 * union 再 discriminate），除 id/kind 簿记外无任何共享逻辑。
 */

import type { BBox, ParsedDocument, ParsedFigureBlock, ParsedTableBlock } from "../ingestion/types.js";
import type { ManuscriptVisualInventory } from "../manuscript/visualInventory.js";
import type { FigureAnalysis } from "../vision/types.js";

export interface VisualReferenceSite {
  /** 相对 manuscript/ 的 POSIX 路径（latex/generated） */
  file: string;
  /** 1-based 行号 */
  line: number;
}

export interface VisualTableGrid {
  headers: string[];
  rows: string[][];
}

export type VisualArtifactView = {
  /** 确定性："pdf:<sourceId>:<blockId>" | "tex:<file>:<figure|table>-<envIndex>" | "gen:<figId>" */
  id: string;
  kind: "figure" | "table";
  sourceKind: "pdf_parsed" | "latex_env" | "generated";
  /** figure 细分（可判断才填，不猜；值域对齐 vision FigureType） */
  figureType?: string;
  caption?: string;
  /** LaTeX \label（latex_env / generated） */
  label?: string;
  /** pdf: "figures/<sourceId>/<assetName>"；latex: includegraphicsPath；gen: 生成资产路径 */
  assetRef?: string;
  /** pdf_parsed 专有（parser fact 拷贝，缺则不伪造） */
  page?: number;
  bbox?: BBox;
  /** table 专有（pdf / latex 两源同形） */
  tableGrid?: VisualTableGrid;
  /** pdf 侧来自 ParsedProvenance.section；latex 侧来自 inventory 的章节归属 */
  linkedSection?: string;
  /** latex/generated：正文 \ref 引用位置（inventory.references 反查）；pdf 缺省空数组 */
  referencedBy: VisualReferenceSite[];
  /** 仅 pdf_parsed 且调用方判定 freshness 后附带（本投影只透传） */
  analysis?: FigureAnalysis;
  /** 人读溯源（权威源在哪：document.json 路径形态 / .tex 文件 / figure store） */
  provenanceNote: string;
  /** 提取元数据（如 caption 缺失、表头约定、资产未落盘） */
  extraction?: { note?: string };
};

/** fromParsedBlocks 的可选分析表：blockId → 已判定新鲜的 FigureAnalysis */
export interface ParsedBlocksProjectionOptions {
  analysisByBlockId?: Map<string, FigureAnalysis>;
}

/**
 * PDF 权威源投影：遍历 ParsedDocument 的 figure / table 块。
 * sourceId 参数决定 id 与 assetRef 前缀（与 doc.sourceId 不一致时以参数为准
 * ——投影消费的是调用方指定的源坐标）。
 */
export function fromParsedBlocks(
  sourceId: string,
  doc: ParsedDocument,
  opts: ParsedBlocksProjectionOptions = {},
): VisualArtifactView[] {
  const views: VisualArtifactView[] = [];
  for (const block of doc.blocks) {
    if (block.type === "figure") {
      views.push(pdfFigureView(sourceId, doc, block, opts.analysisByBlockId));
    } else if (block.type === "table") {
      views.push(pdfTableView(sourceId, doc, block));
    }
  }
  return views;
}

function pdfFigureView(
  sourceId: string,
  doc: ParsedDocument,
  block: ParsedFigureBlock,
  analyses?: Map<string, FigureAnalysis>,
): VisualArtifactView {
  // freshness（四键全同）由调用方判定后再放进 analysisByBlockId；此处只透传
  const analysis = analyses?.get(block.blockId);
  const extractionNotes: string[] = [];
  const caption = block.caption !== undefined && block.caption !== "" ? block.caption : undefined;
  if (caption === undefined) {
    extractionNotes.push("caption 缺失（parser 未提供）");
  }
  if (block.assetName === undefined && block.visualOutputPresent === true) {
    extractionNotes.push("图片存在但资产未落盘（visualOutputPresent）");
  }
  return {
    id: `pdf:${sourceId}:${block.blockId}`,
    kind: "figure",
    sourceKind: "pdf_parsed",
    ...(analysis?.figureType !== undefined ? { figureType: analysis.figureType } : {}),
    ...(caption !== undefined ? { caption } : {}),
    ...(block.assetName !== undefined ? { assetRef: `figures/${sourceId}/${block.assetName}` } : {}),
    ...(block.provenance.page !== undefined ? { page: block.provenance.page } : {}),
    ...(block.provenance.bbox !== undefined ? { bbox: { ...block.provenance.bbox } } : {}),
    ...(block.provenance.section !== undefined ? { linkedSection: block.provenance.section } : {}),
    referencedBy: [],
    ...(analysis !== undefined ? { analysis } : {}),
    provenanceNote: `权威源：sources/parsed/${sourceId}.document.json（figure 块 ${block.blockId}；fileName ${doc.fileName}）`,
    ...(extractionNotes.length > 0 ? { extraction: { note: extractionNotes.join("；") } } : {}),
  };
}

function pdfTableView(
  sourceId: string,
  doc: ParsedDocument,
  block: ParsedTableBlock,
): VisualArtifactView {
  const caption = block.caption !== undefined && block.caption !== "" ? block.caption : undefined;
  return {
    id: `pdf:${sourceId}:${block.blockId}`,
    kind: "table",
    sourceKind: "pdf_parsed",
    ...(caption !== undefined ? { caption } : {}),
    ...(block.provenance.page !== undefined ? { page: block.provenance.page } : {}),
    ...(block.provenance.bbox !== undefined ? { bbox: { ...block.provenance.bbox } } : {}),
    ...(block.provenance.section !== undefined ? { linkedSection: block.provenance.section } : {}),
    tableGrid: {
      headers: [...block.headers],
      rows: block.rows.map((row) => [...row]),
    },
    referencedBy: [],
    provenanceNote: `权威源：sources/parsed/${sourceId}.document.json（table 块 ${block.blockId}；fileName ${doc.fileName}）`,
    ...(caption === undefined ? { extraction: { note: "caption 缺失（parser 未提供）" } } : {}),
  };
}

/**
 * LaTeX 权威源投影：inventory 内全部 figure / table 环境。
 * referencedBy 由 inventory.references 按 label 反查（无 label → 空数组）；
 * caption / 表网格 / 资产路径均为 inventory 条目拷贝，缺省字段不伪造。
 */
export function fromVisualInventory(inventory: ManuscriptVisualInventory): VisualArtifactView[] {
  const sitesByLabel = new Map<string, VisualReferenceSite[]>();
  for (const site of inventory.references) {
    const list = sitesByLabel.get(site.label) ?? [];
    list.push({ file: site.file, line: site.line });
    sitesByLabel.set(site.label, list);
  }
  const copySites = (label: string | undefined): VisualReferenceSite[] =>
    label === undefined ? [] : (sitesByLabel.get(label) ?? []).map((site) => ({ ...site }));

  const views: VisualArtifactView[] = [];
  for (const fileEntry of inventory.files) {
    for (const figure of fileEntry.figures) {
      const extractionNotes: string[] = [];
      if (figure.caption === undefined) {
        extractionNotes.push("caption 缺失（inventory captionMissing 标记）");
      }
      views.push({
        id: `tex:${fileEntry.file}:figure-${figure.envIndex}`,
        kind: "figure",
        sourceKind: "latex_env",
        ...(figure.label !== undefined ? { label: figure.label } : {}),
        ...(figure.caption !== undefined ? { caption: figure.caption } : {}),
        ...(figure.includegraphicsPath !== undefined ? { assetRef: figure.includegraphicsPath } : {}),
        ...(figure.linkedSection !== undefined ? { linkedSection: figure.linkedSection } : {}),
        referencedBy: copySites(figure.label),
        provenanceNote: `权威源：manuscript/${fileEntry.file}（${figure.environment} 环境，行 ${figure.lineStart}-${figure.lineEnd}）`,
        ...(extractionNotes.length > 0 ? { extraction: { note: extractionNotes.join("；") } } : {}),
      });
    }
    for (const table of fileEntry.tables) {
      const extractionNotes: string[] = [];
      if (table.caption === undefined) {
        extractionNotes.push("caption 缺失（inventory captionMissing 标记）");
      }
      if (table.hasTabular && table.headers !== undefined && table.rows !== undefined) {
        extractionNotes.push("LaTeX 表无独立表头语法：首行按惯例作 headers");
      } else if (!table.hasTabular) {
        extractionNotes.push("未检测到 tabular 环境（行列为 0）");
      }
      views.push({
        id: `tex:${fileEntry.file}:table-${table.envIndex}`,
        kind: "table",
        sourceKind: "latex_env",
        ...(table.label !== undefined ? { label: table.label } : {}),
        ...(table.caption !== undefined ? { caption: table.caption } : {}),
        ...(table.linkedSection !== undefined ? { linkedSection: table.linkedSection } : {}),
        ...(table.headers !== undefined && table.rows !== undefined
          ? { tableGrid: { headers: [...table.headers], rows: table.rows.map((row) => [...row]) } }
          : {}),
        referencedBy: copySites(table.label),
        provenanceNote: `权威源：manuscript/${fileEntry.file}（${table.environment} 环境，行 ${table.lineStart}-${table.lineEnd}）`,
        ...(extractionNotes.length > 0 ? { extraction: { note: extractionNotes.join("；") } } : {}),
      });
    }
  }
  return views;
}

/**
 * 生成图（M12.3 figure store）权威源投影的最小输入形状。
 *
 * 故意不 import figures/ 模块（Track C 并行开发中，store 形状未冻结）——
 * 这里只声明投影实际消费的结构子集；GeneratedFigureRecord（manifest 条目）
 * 天然满足该形状（figId/kind/caption/assetRef/createdAt 均为其必需字段）。
 */
export interface GeneratedFigureLike {
  figId: string;
  kind: "plot" | "diagram";
  caption: string;
  label?: string;
  assetRef: string;
  referencedBy?: VisualReferenceSite[];
  createdAt: string;
}

/** 生成图投影：figureType 由生成元数据映射（plot→chart、diagram→diagram） */
export function fromGeneratedFigure(record: GeneratedFigureLike): VisualArtifactView {
  return {
    id: `gen:${record.figId}`,
    kind: "figure",
    sourceKind: "generated",
    figureType: record.kind === "plot" ? "chart" : "diagram",
    caption: record.caption,
    ...(record.label !== undefined ? { label: record.label } : {}),
    assetRef: record.assetRef,
    referencedBy: (record.referencedBy ?? []).map((site) => ({ ...site })),
    provenanceNote: `权威源：figure store manifest（生成图 ${record.figId}，kind=${record.kind}，createdAt ${record.createdAt}）`,
  };
}
