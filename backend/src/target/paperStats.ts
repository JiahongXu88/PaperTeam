/**
 * 单篇 benchmark 论文的确定性统计提取（M12 Batch 2 · A7）。
 *
 * 输入 = ParsedDocument（Docling/文本层解析产物）+ 论文元数据年份；输出 =
 * 聚合前的 per-paper 事实。全部纯代码确定性（无 LLM、无 IO、无时间随机）。
 *
 * 诚实纪律（M12.0 §4.2-9「不发明统计」）：
 * - 无解析产物 / 解析失败（status=failed）→ hasParsedDoc=false，该论文对
 *   所有维度零贡献（聚合侧 coverage 不计它），不是零值论文；
 * - 参考文献节缺失 → 引用规模/密度/文献年龄为 null（该论文不进这三个
 *   统计的样本），不伪造 0；
 * - 章节名经规范化字典折叠（introduction/method/experiments…）；解析产物
 *   没有节标题层级时（provenance.section 全空），只有总长/表格/图片计数
 *   可用——sectionPattern 对该论文零贡献；
 * - 所有启发式（参考文献条目计数、dataset 名识别、方法图识别）在 notes
 *   里如实登记口径；启发式是确定性的，不是「准确」的——聚合侧照抄披露。
 */

import type { ParsedDocument, ParsedTextBlock } from "../ingestion/types.js";

/** 语料论文统计（全部字段：null = 该论文对此无贡献，绝不发明数值） */
export interface PaperStats {
  sourceId: string;
  hasParsedDoc: boolean;
  /** structured / text_only（降级产物照用，但登记口径） */
  parseMode: "structured" | "text_only" | null;
  /** 全文词数（全部 text 块按 Unicode 词元计数） */
  totalWords: number | null;
  /** 摘要词数（Abstract 节；节缺失 → null） */
  abstractWords: number | null;
  /** 规范化章节名 → 词数（无节标题产物 → 空对象） */
  sectionWords: Map<string, number>;
  tableCount: number | null;
  figureCount: number | null;
  /** 参考文献条目数（[n] 标记计数；无标记 → 年份计数兜底并注明） */
  referenceEntryCount: number | null;
  /** 参考文献年份提取计数兜底是否被使用（诚实口径） */
  referenceCountByYearFallback: boolean;
  /** 参考文献出现年份样本（条目年龄计算用；空 = 无贡献） */
  referenceYears: number[];
  /** 论文自身年份（SourceMetadata.year；缺 → 年龄统计不参与） */
  paperYear: number | null;
  /** distinct dataset 候选数（启发式；详见 notes） */
  datasetCount: number | null;
  ablationPresent: boolean;
  robustnessPresent: boolean;
  methodDiagramPresent: boolean;
  limitationsPresent: boolean;
  notes: string[];
}

/** 规范化章节名折叠字典（顺序敏感：先命中先归）。输入先小写去编号。 */
const SECTION_CANONICAL_RULES: ReadonlyArray<{ pattern: RegExp; canonical: string }> = [
  { pattern: /^(abstract|摘要)/, canonical: "abstract" },
  { pattern: /^(intro(duction)?|引言|绪论)/, canonical: "introduction" },
  { pattern: /^(related work|prior work|literature (review|survey)|相关工作|文献综述)/, canonical: "related work" },
  { pattern: /^(background|preliminar(y|ies)| preliminaries|背景|预备)/, canonical: "background" },
  {
    pattern: /^(method(s|ology)?|approach|proposed (method|approach|framework|model)|model( architecture)?|system (design|overview)|framework|architecture|our (method|approach)|methodology|方法|模型|方法与?模型)/,
    canonical: "method",
  },
  {
    pattern: /^(experiment(s|al)?( setup| results)?|evaluation|results( and (discussion|analysis))?|实验|评估|结果)/,
    canonical: "experiments",
  },
  { pattern: /^(discussion|讨论)/, canonical: "discussion" },
  { pattern: /^(conclusion(s)?|summary|结论|总结)/, canonical: "conclusion" },
  { pattern: /^(limitation(s)?|threats to validity|局限性)/, canonical: "limitations" },
  { pattern: /^(references|bibliography|参考文献)/, canonical: "references" },
  { pattern: /^(acknowledg(e)?ments?|致谢)/, canonical: "acknowledgments" },
];

/** 词元计数：Unicode 字母/数字连续段（中英文一致口径；确定性） */
export function countWords(text: string): number {
  const matches = text.match(/[\p{L}\p{N}]+/gu);
  return matches === null ? 0 : matches.length;
}

/** 原始节名 → 规范化（小写、去编号前缀、折叠空白；未知节保留原样 ≤ 40 字符） */
export function canonicalSectionName(rawSection: string): string {
  let name = rawSection
    .trim()
    .toLowerCase()
    .replace(/^((\d+(\.\d+)*)|([ivxlc]+))[\s.:、)）-]+/, "")
    .replace(/\s+/g, " ")
    .trim();
  if (name === "") {
    return "";
  }
  for (const rule of SECTION_CANONICAL_RULES) {
    if (rule.pattern.test(name)) {
      return rule.canonical;
    }
  }
  return name.slice(0, 40);
}

/** 参考文献条目标记：[1] / [12]（每条目一个标记的常见 PDF 形态） */
const REFERENCE_MARKER_PATTERN = /\[\d{1,3}\]/g;
/** 年份样本：19xx / 20xx（1900–2099；参考文献年龄估计口径） */
const YEAR_PATTERN = /\b(19|20)(\d{2})\b/g;
/** dataset 候选：<name> dataset(s)/benchmark(s)/corpus（名称取末词元；大小写不敏感去重） */
const DATASET_NAME_PATTERN = /([A-Za-z][A-Za-z0-9&'+.\-]{1,40})\s+(datasets?|benchmarks?|corpora|corpus)\b/gi;
/** 方法总览图 caption 启发式 */
const METHOD_DIAGRAM_CAPTION_PATTERN = /(overview|architecture|framework|pipeline|structure of (the|our) (proposed )?(method|model|system)|整体(结构|框架|架构)|方法(结构|框架|总览))/i;
const ABLATION_PATTERN = /ablation/i;
const ROBUSTNESS_PATTERN = /robust(ness)?/i;
const LIMITATION_PATTERN = /limitation/i;

/** dataset 候选上限（防 pathological 解析产物撑爆统计） */
const MAX_DATASET_CANDIDATES = 30;
/** 参考文献年份样本上限 */
const MAX_REFERENCE_YEARS = 400;

/**
 * 从解析产物提取单篇统计。itemYear 来自 SourceMetadata.year（可缺省）。
 * 无解析产物 → hasParsedDoc=false 的空壳（其余字段全部 null/false）。
 */
export function extractPaperStats(
  sourceId: string,
  document: ParsedDocument | null,
  itemYear: number | undefined,
): PaperStats {
  const notes: string[] = [];
  if (document === null || document.status === "failed" || document.blocks.length === 0) {
    return {
      sourceId,
      hasParsedDoc: false,
      parseMode: null,
      totalWords: null,
      abstractWords: null,
      sectionWords: new Map(),
      tableCount: null,
      figureCount: null,
      referenceEntryCount: null,
      referenceCountByYearFallback: false,
      referenceYears: [],
      paperYear: itemYear ?? null,
      datasetCount: null,
      ablationPresent: false,
      robustnessPresent: false,
      methodDiagramPresent: false,
      limitationsPresent: false,
      notes: [
        document === null
          ? "无解析产物（sources/parsed 缺失）——该论文对所有维度零贡献"
          : `解析产物不可用（status=${document.status} / blocks=${document.blocks.length}）——零贡献`,
      ],
    };
  }

  let totalWords = 0;
  let abstractWords: number | null = null;
  const sectionWords = new Map<string, number>();
  let ablationPresent = false;
  let robustnessPresent = false;
  let limitationsPresent = false;
  let referenceText = "";

  for (const block of document.blocks) {
    if (block.type === "text") {
      const text = block.text;
      totalWords += countWords(text);
      if (ABLATION_PATTERN.test(text)) {
        ablationPresent = true;
      }
      if (ROBUSTNESS_PATTERN.test(text)) {
        robustnessPresent = true;
      }
      if (LIMITATION_PATTERN.test(text)) {
        limitationsPresent = true;
      }
      const canonical = canonicalSectionName(block.provenance.section ?? "");
      if (canonical !== "") {
        sectionWords.set(canonical, (sectionWords.get(canonical) ?? 0) + countWords(text));
      }
      if (canonical === "references") {
        referenceText += `\n${text}`;
      }
    }
  }
  // 摘要：Abstract 节的词数（无该节 → null；不把首段当摘要）
  abstractWords = sectionWords.get("abstract") ?? null;

  // 参考文献条目计数：[n] 标记；0 标记 → 年份计数兜底（口径注明）
  let referenceEntryCount: number | null = null;
  let referenceCountByYearFallback = false;
  const referenceYears: number[] = [];
  if (referenceText.trim() !== "") {
    const markers = referenceText.match(REFERENCE_MARKER_PATTERN);
    const years = [...referenceText.matchAll(YEAR_PATTERN)]
      .map((match) => Number(match[0]))
      .filter((year) => year >= 1900 && year <= 2099)
      .slice(0, MAX_REFERENCE_YEARS);
    referenceYears.push(...years);
    if (markers !== null && markers.length > 0) {
      referenceEntryCount = markers.length;
    } else if (years.length > 0) {
      referenceEntryCount = years.length;
      referenceCountByYearFallback = true;
      notes.push("参考文献节无 [n] 标记——条目数按年份出现次数估计（确定性启发式，可能低估无年份条目）");
    } else {
      referenceEntryCount = null;
      notes.push("参考文献节存在但未提取到条目标记或年份——引用规模统计零贡献");
    }
  } else {
    notes.push("未识别到参考文献节（references/bibliography）——引用规模/密度/文献年龄零贡献");
  }

  // dataset 广度：<name> dataset/benchmark/corpus 的 distinct 名称（启发式）
  const allText = document.blocks
    .filter((block): block is ParsedTextBlock => block.type === "text")
    .map((block) => block.text)
    .join("\n");
  const datasetNames = new Set<string>();
  for (const match of allText.matchAll(DATASET_NAME_PATTERN)) {
    const raw = (match[1] ?? "").trim();
    // 去掉冠词/介词类尾词（"the MOT17 dataset" → MOT17；"on ImageNet" 形态的介词前缀）
    const token = raw.split(/\s+/).at(-1) ?? raw;
    if (token.length >= 2) {
      datasetNames.add(token.toLowerCase());
    }
    if (datasetNames.size >= MAX_DATASET_CANDIDATES) {
      break;
    }
  }
  const datasetCount = datasetNames.size;

  // 方法总览图：figure 块 caption 启发式 或 figure 位于 method 节
  let methodDiagramPresent = false;
  let figureCount = 0;
  for (const block of document.blocks) {
    if (block.type !== "figure") {
      continue;
    }
    figureCount += 1;
    const caption = block.caption ?? "";
    const section = canonicalSectionName(block.provenance.section ?? "");
    if (METHOD_DIAGRAM_CAPTION_PATTERN.test(caption) || section === "method") {
      methodDiagramPresent = true;
    }
  }

  if (document.parseMode === "text_only") {
    notes.push("解析为 text_only 降级产物——表格/图片计数不可用（counts 为解析层事实，如实保留）");
  }
  if (document.degradedFrom !== undefined) {
    notes.push(`解析降级：${document.degradedFrom.parser}（${document.degradedFrom.reason}）`);
  }

  return {
    sourceId,
    hasParsedDoc: true,
    parseMode: document.parseMode,
    totalWords,
    abstractWords,
    sectionWords,
    tableCount: document.counts.table,
    figureCount,
    referenceEntryCount,
    referenceCountByYearFallback,
    referenceYears,
    paperYear: itemYear ?? null,
    datasetCount,
    ablationPresent,
    robustnessPresent,
    methodDiagramPresent,
    limitationsPresent,
    notes,
  };
}

/** 文献年龄（论文年 − 参考文献年中位数）；任一侧缺失 → null */
export function referenceAgeYears(stats: PaperStats, medianReferenceYear: number | null): number | null {
  if (stats.paperYear === null || medianReferenceYear === null) {
    return null;
  }
  return stats.paperYear - medianReferenceYear;
}
