/**
 * M14.1c：从 ParsedDocument 正文文本块确定性抽取科研事实候选。
 *
 * M14.1b 只覆盖表格单元格；本模块补正文中的数值实验结果 / 数据集规模 /
 * 评价指标 / 方法参数。纪律与表格抽取一致：
 *   - 只从原文（parser 的文本块）建立候选，不从模型生成内容建立来源事实；
 *   - 每个事实带 verbatim quote + blockId + page provenance（可独立核验）；
 *   - 只有「指标词 + 关系词 + 可解析数值」的句子成为事实（保守：宁漏勿错）；
 *   - 图内文本（bbox 落在 figure 块内的文本块）单独标记 condition=
 *     figure_embedded_text：不参与正文 / 表格数值比较，只作候选呈现——
 *     像素级图形数值本轮不做 OCR，如实缺省。
 *
 * 边界（如实记录，不编造）：
 *   - 数值只存在于图片像素中 → 不产生任何记录（需要后续多模态处理）；
 *   - 「从 X 降到 Y」区间叙述 → 只取结果值 Y，原文 quote 保留完整叙述；
 *   - 无指标语境的裸数字（年份、编号、章节号）不成为事实。
 */

import type { ParsedDocument, ParsedTextBlock } from "../ingestion/types.js";
import { sha256Hex } from "../util/hash.js";
import { hasGlyphIssues, normalizeSurfaceText, parseFactValue } from "./factValues.js";
import {
  RESEARCH_INPUT_ALGORITHM_VERSION,
  type FactKind,
  type FactKey,
  type ResearchInput,
  type ScientificFact,
} from "./researchInputTypes.js";

export const BODY_TEXT_FACT_EXTRACTOR = "thesis/bodyTextFacts#body_text";

/** 图内文本条件的显式标记（写入 key.condition，下游比较与正文事实隔离） */
export const FIGURE_EMBEDDED_CONDITION = "figure_embedded_text";

// ---------------------------------------------------------------------------
// 指标 / 数据集 / 参数词典（zh + en 常见形态；保守优先，逐条可测）
// ---------------------------------------------------------------------------

/** 评价指标词 → FactKind（命中即数值实验结果 / 指标陈述） */
const METRIC_TERMS: Array<{ pattern: RegExp; kind: FactKind; metric: string }> = [
  // 通用中文指标
  { pattern: /准确率|精度|正确率/u, kind: "numeric_result", metric: "accuracy" },
  { pattern: /召回率|查全率/u, kind: "numeric_result", metric: "recall" },
  { pattern: /查准率|精确率/u, kind: "numeric_result", metric: "precision" },
  { pattern: /平均精度均值|均值平均精度/u, kind: "numeric_result", metric: "map" },
  { pattern: /交并比|重叠度/u, kind: "numeric_result", metric: "iou" },
  { pattern: /误报率|虚警率|假阳性率/u, kind: "numeric_result", metric: "false_positive_rate" },
  { pattern: /漏检率|漏报率/u, kind: "numeric_result", metric: "miss_rate" },
  { pattern: /丢失率|身份切换/u, kind: "numeric_result", metric: "id_switch" },
  { pattern: /帧率|每秒帧数/u, kind: "numeric_result", metric: "fps" },
  { pattern: /耗时|延迟|时延|运行时间|推理时间/u, kind: "numeric_result", metric: "latency" },
  { pattern: /吞吐/u, kind: "numeric_result", metric: "throughput" },
  { pattern: /信噪比/u, kind: "numeric_result", metric: "psnr" },
  // 英文缩写（词边界，避免 SSR→S 之类误配）
  { pattern: /\bmAP(?:50|75|@[0-9.]+)?\b/, kind: "numeric_result", metric: "map" },
  { pattern: /\bAP(?:50|75)?\b/, kind: "numeric_result", metric: "ap" },
  { pattern: /\bAR\b/, kind: "numeric_result", metric: "ar" },
  { pattern: /\bIoU\b/, kind: "numeric_result", metric: "iou" },
  { pattern: /\bF1\b|\bF-score\b|\bF1-score\b/, kind: "numeric_result", metric: "f1" },
  { pattern: /\bAcc(?:uracy)?\b/, kind: "numeric_result", metric: "accuracy" },
  { pattern: /\bPrecision\b/, kind: "numeric_result", metric: "precision" },
  { pattern: /\bRecall\b/, kind: "numeric_result", metric: "recall" },
  { pattern: /\bTop-1\b|\bTop-5\b/, kind: "numeric_result", metric: "topk_accuracy" },
  { pattern: /\bPSNR\b/, kind: "numeric_result", metric: "psnr" },
  { pattern: /\bSSIM\b/, kind: "numeric_result", metric: "ssim" },
  { pattern: /\bFPS\b/, kind: "numeric_result", metric: "fps" },
  { pattern: /\bmota\b|\bMota\b/i, kind: "numeric_result", metric: "mota" },
  { pattern: /\bIDSW\b|\bIDs\b/, kind: "numeric_result", metric: "id_switch" },
];

/** 方法参数词 */
const PARAMETER_TERMS: Array<{ pattern: RegExp; parameter: string }> = [
  { pattern: /学习率|learning rate|\blr\b/i, parameter: "learning_rate" },
  { pattern: /批大小|batch size|\bbs\b/i, parameter: "batch_size" },
  { pattern: /轮次|迭代轮|训练轮|epoch(?:s)?/i, parameter: "epochs" },
  { pattern: /迭代次数|iterations?/i, parameter: "iterations" },
  { pattern: /动量|momentum/i, parameter: "momentum" },
  { pattern: /权重衰减|weight decay/i, parameter: "weight_decay" },
  { pattern: /批数量|线程数|并行数|workers?/i, parameter: "workers" },
  { pattern: /窗口大小|window size/i, parameter: "window_size" },
  { pattern: /阈值|threshold/i, parameter: "threshold" },
  { pattern: /温度|temperature/i, parameter: "temperature" },
];

/** 关系词：指标词与数值之间的连接（为/是/=/达到/约/of/is/：…） */
const RELATION_RE = /(?:为|是|达到了?|达到|约|大约|只有|仅有|稳定在|提升到|降低到|降到|下降到|提升至|降低至|of|is|was|were|reaches|reached|achieves|achieved|to|=|:|：)\s*/u;

/** 数值 token（含千分位 / 指数 / 百分号 / 计数单位 M/K） */
const NUMBER_TOKEN_RE = /([-+]?(?:\d{1,3}(?:,\d{3})+|\d+)(?:\.\d+)?(?:[eE][-+]?\d+)?)\s*([%‰]|[MKk](?![A-Za-z])|[A-Za-z]{1,3}B?)?/u;

/** 数据集名称模式：「在 X 数据集上」「on the X dataset」 */
const DATASET_NAME_RE = /(?:在|于)\s*([A-Za-z0-9一-龥-]{2,24}?)\s*(?:数据集|测试集|训练集|验证集)|on\s+(?:the\s+)?([A-Za-z0-9-]{2,24}?)\s+dataset/u;

/** 基线 / 方法名候选：全大写缩写词（供 key.subject 参考；不作事实本体） */
const METHOD_NAME_RE = /\b([A-Z][A-Za-z0-9]*(?:-[A-Za-z0-9]+){0,2})\b/g;

// ---------------------------------------------------------------------------

export interface BodyTextFactResult {
  facts: ScientificFact[];
  /** 跳过的候选句（有数值但语境不足 / 数值不可解析）——透明度，不猜测 */
  skippedCandidates: number;
  /** 文本层 bbox 落在图内而标记 figure_embedded_text 的事实数 */
  figureEmbeddedCount: number;
}

interface TextBlockMeta {
  block: ParsedTextBlock;
  /** 文本块 bbox 与同页 figure 块 bbox 相交 → 图内文本 */
  insideFigure: boolean;
}

export function extractBodyTextFacts(input: ResearchInput, document: ParsedDocument, now: string): BodyTextFactResult {
  const metas = annotateFigureOverlap(document);
  const facts: ScientificFact[] = [];
  let skippedCandidates = 0;
  let figureEmbeddedCount = 0;
  for (const meta of metas) {
    const text = normalizeSurfaceText(meta.block.text);
    if (text === "" || hasGlyphIssues(text)) {
      continue;
    }
    for (const sentence of splitSentences(text)) {
      const candidates = matchSentence(sentence);
      if (candidates.length === 0) {
        continue;
      }
      for (const candidate of candidates) {
        if (candidate === null) {
          skippedCandidates += 1;
          continue;
        }
        const key: FactKey = {
          ...(candidate.key.dataset !== undefined ? { dataset: candidate.key.dataset } : {}),
          ...(candidate.key.subject !== undefined ? { subject: candidate.key.subject } : {}),
          ...(candidate.key.metric !== undefined ? { metric: candidate.key.metric } : {}),
          ...(candidate.key.parameter !== undefined ? { parameter: candidate.key.parameter } : {}),
          ...(meta.insideFigure ? { condition: FIGURE_EMBEDDED_CONDITION } : {}),
        };
        if (meta.insideFigure) {
          figureEmbeddedCount += 1;
        }
        facts.push({
          schemaVersion: 1,
          factId: bodyTextFactId(input, meta.block.blockId, facts.length + skippedCandidates + figureEmbeddedCount, candidate.matchStart),
          projectId: input.projectId,
          researchInputId: input.inputId,
          kind: candidate.kind,
          key,
          surface: candidate.surface,
          value: parseFactValue(candidate.surface),
          provenance: {
            researchInputId: input.inputId,
            sourceId: input.version.sourceId,
            contentHash: input.version.contentHash,
            blockId: meta.block.blockId,
            ...(meta.block.provenance.page !== undefined ? { page: meta.block.provenance.page } : {}),
            pageBasis: meta.block.provenance.page !== undefined ? "parser" : "unknown",
            ...(meta.block.provenance.section !== undefined ? { section: meta.block.provenance.section } : {}),
            quote: sentence.text.slice(0, 400),
            surfaceHash: sha256Hex(candidate.surface),
          },
          extraction: {
            method: "deterministic_body_text",
            extractor: BODY_TEXT_FACT_EXTRACTOR,
            algorithmVersion: RESEARCH_INPUT_ALGORITHM_VERSION,
          },
          verification: { status: "extracted", sourceCheck: "unchecked" },
          conflict: { status: "none", conflictIds: [] },
          createdAt: now,
          updatedAt: now,
        });
      }
    }
  }
  return { facts, skippedCandidates, figureEmbeddedCount };
}

// ---------------------------------------------------------------------------

interface Sentence {
  text: string;
  /** 句子在归一化全文中的起始偏移（quote 定位参考） */
  offset: number;
}

/** 句切分：。；？！.!? 换行（保守：不切小数点） */
function splitSentences(text: string): Sentence[] {
  const sentences: Sentence[] = [];
  let start = 0;
  for (let i = 0; i < text.length; i += 1) {
    const ch = text[i]!;
    if ("。；？！!?;".includes(ch) || ch === "." && !/\d/.test(text[i + 1] ?? "")) {
      const piece = text.slice(start, i + 1).trim();
      if (piece !== "") {
        sentences.push({ text: piece, offset: start });
      }
      start = i + 1;
    }
  }
  const tail = text.slice(start).trim();
  if (tail !== "") {
    sentences.push({ text: tail, offset: start });
  }
  return sentences;
}

interface MatchedCandidate {
  kind: FactKind;
  key: { dataset?: string; subject?: string; metric?: string; parameter?: string };
  surface: string;
  matchStart: number;
}

/**
 * 句内匹配：指标词/参数词 + 关系词 + 数值。返回 null 表示「发现数值候选但
 * 语境不可靠」（计入 skippedCandidates），undefined 语义不使用。
 */
function matchSentence(sentence: Sentence): Array<MatchedCandidate | null> {
  const text = sentence.text;
  const results: Array<MatchedCandidate | null> = [];
  const datasetName = DATASET_NAME_RE.exec(text)?.[1] ?? DATASET_NAME_RE.exec(text)?.[2];

  for (const term of METRIC_TERMS) {
    for (const metricMatch of matchAll(term.pattern, text)) {
      const value = valueAfter(text, metricMatch.index + metricMatch[0].length, true);
      if (value === null) {
        results.push(null);
        continue;
      }
      results.push({
        kind: term.kind,
        key: {
          metric: term.metric,
          ...(datasetName !== undefined ? { dataset: normalizeSurfaceText(datasetName).toLowerCase() } : {}),
          ...(subjectBefore(text, metricMatch.index) !== undefined ? { subject: subjectBefore(text, metricMatch.index) } : {}),
        },
        surface: value.surface,
        matchStart: value.index,
      });
    }
  }
  for (const term of PARAMETER_TERMS) {
    for (const paramMatch of matchAll(term.pattern, text)) {
      // 参数语境关系词可缺省（「学习率 0.001」直接跟数值是强信号）
      const value = valueAfter(text, paramMatch.index + paramMatch[0].length, false);
      if (value === null) {
        results.push(null);
        continue;
      }
      results.push({
        kind: "parameter",
        key: { parameter: term.parameter },
        surface: value.surface,
        matchStart: value.index,
      });
    }
  }
  // 数据集规模：数量 + 量词（「包含 118,287 张图像」「500 videos」）
  for (const scaleMatch of matchAll(/(\d[\d,.]*)\s*(?:万\s*)?([张幅段个条支])|(?:^|\s)(\d[\d,.]*)\s*(k|K|M)?\s*(images?|videos?|frames?|sequences?|samples?|instances?)/gu, text)) {
    const surface = scaleMatch[0].trim();
    const parsed = parseFactValue(surface.replace(/[张幅段个条支]/u, "").trim());
    if (parsed.numeric === undefined) {
      results.push(null);
      continue;
    }
    results.push({
      kind: "dataset",
      key: {
        parameter: "dataset_size",
        ...(datasetName !== undefined ? { dataset: normalizeSurfaceText(datasetName).toLowerCase() } : {}),
      },
      surface: surface.replace(/[，。]$/u, ""),
      matchStart: scaleMatch.index,
    });
  }
  return results;
}

function matchAll(pattern: RegExp, text: string): RegExpExecArray[] {
  const global = pattern.flags.includes("g") ? pattern : new RegExp(pattern.source, pattern.flags + "g");
  const matches: RegExpExecArray[] = [];
  let match: RegExpExecArray | null;
  while ((match = global.exec(text)) !== null) {
    matches.push(match);
    if (match.index === global.lastIndex) {
      global.lastIndex += 1;
    }
  }
  return matches;
}

/**
 * 指标/参数词之后（≤ 24 字符窗口内）找 关系词 + 数值；找不到返回 null（候选不成立）。
 * 数值一律锚定在窗口/剩余段开头（^\s*）——禁止中窗跳跃（「epochs of training on
 * 4 GPUs」不会把 GPU 数量当 epoch 值）。requireRelation=false（参数语境）时
 * 直接跟数值优先。surface 带未知字母单位（"88.1 on"）解析失败时回退纯数值。
 */
function valueAfter(text: string, from: number, requireRelation: boolean): { surface: string; index: number } | null {
  const window = text.slice(from, from + 24);
  if (!requireRelation) {
    const direct = ANCHORED_NUMBER_RE.exec(window);
    const value = surfaceOf(direct);
    if (value !== null) {
      return { surface: value.surface, index: from + direct!.index + value.trimmed };
    }
  }
  const relation = RELATION_RE.exec(window);
  if (relation === null) {
    return null;
  }
  const rest = window.slice(relation.index + relation[0].length);
  const number = ANCHORED_NUMBER_RE.exec(rest);
  const value = surfaceOf(number);
  if (value === null) {
    return null;
  }
  return { surface: value.surface, index: from + relation.index + relation[0].length + number!.index + value.trimmed };
}

/** 锚定开头的数值匹配（允许前导空白） */
const ANCHORED_NUMBER_RE = new RegExp(`^\\s*${NUMBER_TOKEN_RE.source}`, "u");

/** 由锚定匹配构造 surface：优先全 match（含单位），单位不可解析时回退纯数值 */
function surfaceOf(match: RegExpExecArray | null): { surface: string; trimmed: number } | null {
  if (match === null) {
    return null;
  }
  const trimmed = match[0].length - match[0].trimStart().length;
  const full = match[0].trim();
  if (parseFactValue(full).numeric !== undefined) {
    return { surface: full, trimmed };
  }
  const numberOnly = (match[1] ?? "").trim();
  if (numberOnly !== "" && parseFactValue(numberOnly).numeric !== undefined) {
    return { surface: numberOnly, trimmed };
  }
  return null;
}

/** 指标词之前最近的方法名候选（「SSAA 的准确率」→ subject=SSAA；找不到缺省） */
function subjectBefore(text: string, metricIndex: number): string | undefined {
  const prefix = text.slice(Math.max(0, metricIndex - 30), metricIndex);
  const names = [...prefix.matchAll(METHOD_NAME_RE)].map((m) => m[1]);
  const last = names[names.length - 1];
  if (last === undefined || last.length < 2 || /^(?:的|在|与|和|本|该|我们|提出|方法|模型|达到|为|上)$/u.test(last)) {
    return undefined;
  }
  return last;
}

// ---------------------------------------------------------------------------
// 图内文本边界
// ---------------------------------------------------------------------------

/**
 * 标记文本块是否与 figure 块同页相交（bbox 归一 0-100；parser 不给 bbox 时
 * 不标记——宁缺勿错，不猜「在图附近」）。
 */
function annotateFigureOverlap(document: ParsedDocument): TextBlockMeta[] {
  const figuresByPage = new Map<number, Array<{ x0: number; y0: number; x1: number; y1: number }>>();
  const unpagedFigures: Array<{ x0: number; y0: number; x1: number; y1: number }> = [];
  for (const block of document.blocks) {
    if (block.type !== "figure" || block.provenance.bbox === undefined) {
      continue;
    }
    const box = block.provenance.bbox;
    if (block.provenance.page !== undefined) {
      const list = figuresByPage.get(block.provenance.page) ?? [];
      list.push(box);
      figuresByPage.set(block.provenance.page, list);
    } else {
      unpagedFigures.push(box);
    }
  }
  const metas: TextBlockMeta[] = [];
  for (const block of document.blocks) {
    if (block.type !== "text" || block.provenance.bbox === undefined) {
      if (block.type === "text") {
        metas.push({ block, insideFigure: false });
      }
      continue;
    }
    const box = block.provenance.bbox;
    const pageFigures = block.provenance.page !== undefined ? (figuresByPage.get(block.provenance.page) ?? []) : unpagedFigures;
    const overlapped = pageFigures.some((figure) => boxesOverlap(figure, box, 0.5));
    metas.push({ block, insideFigure: overlapped });
  }
  return metas;
}

function boxesOverlap(a: { x0: number; y0: number; x1: number; y1: number }, b: { x0: number; y0: number; x1: number; y1: number }, minCover: number): boolean {
  const ix = Math.max(0, Math.min(a.x1, b.x1) - Math.max(a.x0, b.x0));
  const iy = Math.max(0, Math.min(a.y1, b.y1) - Math.max(a.y0, b.y0));
  const inter = ix * iy;
  if (inter <= 0) {
    return false;
  }
  const areaB = Math.max(1e-9, (b.x1 - b.x0) * (b.y1 - b.y0));
  return inter / areaB >= minCover;
}

// ---------------------------------------------------------------------------

/** 正文事实 id：输入 + 内容版本 + 块 + 句内序号 → 确定性（重放幂等） */
export function bodyTextFactId(input: ResearchInput, blockId: string, ordinal: number, matchStart: number): string {
  return `F${sha256Hex(`${input.inputId}|${input.version.contentHash}|body|${blockId}|${ordinal}|${matchStart}`).slice(0, 16)}`;
}
