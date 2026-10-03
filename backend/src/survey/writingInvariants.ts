/**
 * Survey Writing 确定性 Invariant Checker + Metrics（M11.2 §八/§十二）。
 *
 * 定位：写作 / 修订产物的**可计算**质量信号——LLM Reviewer 之外的确定性
 * 底座。规则分两档（保守原则：第一版只把「契约违约」做成 blocking，启发式
 * 一律 warning / reviewer signal，不把 NLP 判断变成硬门）：
 *
 * blocking（Quality Gate survey 规则消费）：
 * - 悬空 refs：outline 引用了不存在的 synthesisId / entryId（写作期契约破坏）；
 * - fake citation key：正文 \cite 了 bibliography 之外的 key（与 citation.verify
 *   的 missing 同源，这里按 survey 契约再判一次——Writer 只允许白名单 key）；
 * - evidence_backed synthesis 不可回溯：被某节 refs 消费的 evidence_backed
 *   synthesis，其引用候选组在整个正文一个都没出现——关键科学 claim 断链。
 *
 * warnings / metrics（Review context / Quality report / trace 消费）：
 * - 单 key 段落占比、连续罗列游程（literature listing 倾向）；
 * - 多 key 引用占比（multi-source claim ratio）；
 * - 文献覆盖（cited matrix sources / entries）与 family 覆盖；
 * - speculative-only 来源被既定结论章节引用（speculative 泄漏信号）；
 * - 非 future 章节出现强断言式未来措辞（必将 / 终将 / 必然实现 …）。
 *
 * 纯函数（无 IO / 时钟 / LLM）：同输入恒同结果。
 */

import type { Outline } from "../manuscript/ManuscriptService.js";
import type { EvidenceRecord } from "../evidence/EvidenceStore.js";
import type { BibRenderEntry } from "../citation/bibliography.js";
import { extractCitationKeys } from "../review/styleInvariants.js";
import { classifySurveySection } from "./outlineValidation.js";
import type { SurveyMatrixArtifact } from "./matrixTypes.js";
import { UNCLASSIFIED_FAMILY } from "./matrixTypes.js";
import type { SurveySynthesisArtifact } from "./synthesisTypes.js";
import { buildSurveySectionContext, type SurveySectionWritingContext } from "./sectionContext.js";

/** 与 styleInvariants.CITE_PATTERN 同口径（occurrence 级：多 key 并列可分辨） */
const CITE_OCCURRENCE = /\\(?:cite|citep|citet|citealp|citealt|citeauthor|citeyear|parencite|textcite|autocite)\*?(?:\[[^\]]*\])*\{([^}]*)\}/g;

/** 强断言式未来措辞（speculative 泄漏的保守词表——只抓明显违规，宁缺毋滥） */
const STRONG_FUTURE_PATTERN = /必将|终将|必然(会|实现|带来)|一定会(实现|成为|取代)|不可避免地(实现|到来)/;

/** 单 key 段落占比的 warning 阈值（≥ 该值且样本足够时提示罗列倾向） */
const SINGLE_KEY_RATIO_WARN = 0.6;
const SINGLE_KEY_MIN_PARAGRAPHS = 5;
/** 多 key 引用占比的 warning 阈值（低于时提示综合引用不足） */
const MULTI_KEY_RATIO_WARN = 0.2;
const MULTI_KEY_MIN_CITES = 10;
/** family 覆盖 warning 的最小家族规模 */
const FAMILY_COVERAGE_MIN_ENTRIES = 3;

export interface SurveyWritingSectionResult {
  sectionId: string;
  file: string;
  context: "framing" | "core" | "gap" | "future";
  citedKeys: string[];
  /** 不在本节 refs 契约白名单、但在 bibliography 内的 key（跨节引用漂移；warning） */
  outOfScopeKeys: string[];
  paragraphs: number;
  citeParagraphs: number;
  singleKeyParagraphs: number;
  /** 连续 ≥3 个「每段恰好 1 个不同 key」的游程数（逐篇罗列形态） */
  listingRuns: number;
  /** 非 future 章节命中强断言式未来措辞（speculative 泄漏信号） */
  strongFutureHits: number;
}

/** blocking 类型（Quality Gate survey 规则分规则消费） */
export type SurveyWritingBlockerCode =
  | "dangling_refs"
  | "fake_citation_key"
  | "synthesis_untraceable";

export interface SurveyWritingBlocker {
  code: SurveyWritingBlockerCode;
  detail: string;
}

export interface SurveyWritingMetrics {
  sections: number;
  totalCiteCommands: number;
  multiKeyCiteCommands: number;
  /** multiKeyCiteCommands / totalCiteCommands（multi-source claim ratio） */
  multiKeyCiteRatio: number;
  /** 被 \cite 的 matrix 文献比例（literature coverage rate） */
  literatureCoverage: number;
  citedLiterature: number;
  totalLiterature: number;
  /** evidence_backed synthesis 中「候选 key 至少一个被引用」的比例 */
  groundedSynthesisUsage: number;
  evidenceBackedUsed: number;
  evidenceBackedTotal: number;
  singleKeyParagraphRatio: number;
  listingRuns: number;
  speculativeLeakSignals: number;
  familyCoverage: Array<{ label: string; cited: number; total: number }>;
}

export interface SurveyWritingEvaluation {
  blockers: SurveyWritingBlocker[];
  warnings: string[];
  metrics: SurveyWritingMetrics;
  sections: SurveyWritingSectionResult[];
  /** 每节的写作上下文投影（review context / trace 消费；与写作阶段同源） */
  contexts: SurveySectionWritingContext[];
}

export interface EvaluateSurveyWritingInput {
  outline: Outline;
  matrix: SurveyMatrixArtifact;
  synthesis: SurveySynthesisArtifact;
  bibliography: readonly BibRenderEntry[];
  /** formal evidence（调用方过滤 verified + 锚点） */
  evidence: EvidenceRecord[];
  /** 落盘的章节正文（file → content；相对 manuscript/ 的 POSIX 路径） */
  files: readonly { file: string; content: string }[];
  titleBySource?: Map<string, string>;
  yearBySource?: Map<string, number>;
}

export function evaluateSurveyWriting(input: EvaluateSurveyWritingInput): SurveyWritingEvaluation {
  const blockers: SurveyWritingBlocker[] = [];
  const warnings: string[] = [];
  const fileByPath = new Map(input.files.map((file) => [file.file.replaceAll("\\", "/"), file.content]));
  const bibliographyKeys = new Set(input.bibliography.map((entry) => entry.key));
  const sourceKeyBySourceId = new Map<string, string>();
  for (const entry of input.bibliography) {
    if ((entry.sourceId ?? "").trim() !== "") {
      sourceKeyBySourceId.set(entry.sourceId!.trim(), entry.key);
    }
  }

  const sectionResults: SurveyWritingSectionResult[] = [];
  const contexts: SurveySectionWritingContext[] = [];
  const allCitedKeys = new Set<string>();
  let totalCiteCommands = 0;
  let multiKeyCiteCommands = 0;
  let citeParagraphs = 0;
  let singleKeyParagraphs = 0;
  let listingRuns = 0;

  for (const section of input.outline.sections) {
    const context = buildSurveySectionContext({
      section,
      matrix: input.matrix,
      synthesis: input.synthesis,
      bibliography: input.bibliography,
      evidence: input.evidence,
      ...(input.titleBySource !== undefined ? { titleBySource: input.titleBySource } : {}),
      ...(input.yearBySource !== undefined ? { yearBySource: input.yearBySource } : {}),
    });
    contexts.push(context);
    if (context.danglingSynthesisRefs.length > 0 || context.danglingLiteratureRefs.length > 0) {
      blockers.push({
        code: "dangling_refs",
        detail: `section ${section.id} 悬空 refs：${
          context.danglingSynthesisRefs.length > 0
            ? `synthesisRefs ${context.danglingSynthesisRefs.join("、")}`
            : ""
        }${context.danglingLiteratureRefs.length > 0 ? ` literatureRefs ${context.danglingLiteratureRefs.join("、")}` : ""}`,
      });
    }

    const sectionContextClass = classifySurveySection(section);
    const content = fileByPath.get(`sections/${section.file}`) ?? "";
    const citedKeys = extractCitationKeys(content);
    for (const key of citedKeys) {
      allCitedKeys.add(key);
    }
    // fake key（不在 bibliography）：blocking；跨节白名单漂移：warning
    const fakeKeys = [...new Set(citedKeys)].filter((key) => !bibliographyKeys.has(key));
    if (fakeKeys.length > 0) {
      blockers.push({
        code: "fake_citation_key",
        detail: `section ${section.id} 引用了 bibliography 之外的 citation key：${fakeKeys.join("、")}（综述引用只允许文献库白名单）`,
      });
    }
    const allowed = new Set(context.allowedCitationKeys);
    const outOfScopeKeys = [...new Set(citedKeys)].filter(
      (key) => bibliographyKeys.has(key) && !allowed.has(key),
    );
    if (outOfScopeKeys.length > 0) {
      warnings.push(
        `section ${section.id} 引用了本节 refs 契约之外的 key：${outOfScopeKeys.join("、")}（跨节引用漂移；确认是综合需要而不是结构混乱）`,
      );
    }

    // 段落级统计（空行分段；只统计含 \cite 的段落）
    const paragraphs = content.split(/\n\s*\n/).filter((part) => part.trim() !== "");
    let sectionCiteParagraphs = 0;
    let sectionSingleKeyParagraphs = 0;
    let sectionListingRuns = 0;
    const singleKeySequence: boolean[] = [];
    for (const paragraph of paragraphs) {
      let paragraphKeys = 0;
      for (const match of paragraph.matchAll(CITE_OCCURRENCE)) {
        totalCiteCommands += 1;
        const keys = (match[1] ?? "").split(",").map((key) => key.trim()).filter((key) => key !== "");
        paragraphKeys += keys.length;
        if (keys.length >= 2) {
          multiKeyCiteCommands += 1;
        }
      }
      if (paragraphKeys > 0) {
        sectionCiteParagraphs += 1;
        citeParagraphs += 1;
        if (paragraphKeys === 1) {
          sectionSingleKeyParagraphs += 1;
          singleKeyParagraphs += 1;
          singleKeySequence.push(true);
          continue;
        }
      }
      singleKeySequence.push(false);
    }
    // 连续 ≥3 个单 key 段（罗列游程）
    let run = 0;
    for (const flag of singleKeySequence) {
      if (flag) {
        run += 1;
      } else {
        if (run >= 3) {
          sectionListingRuns += 1;
          listingRuns += 1;
        }
        run = 0;
      }
    }
    if (run >= 3) {
      sectionListingRuns += 1;
      listingRuns += 1;
    }

    const strongFutureHits =
      sectionContextClass === "future" ? 0 : (content.match(new RegExp(STRONG_FUTURE_PATTERN, "g")) ?? []).length;

    sectionResults.push({
      sectionId: section.id,
      file: section.file,
      context: sectionContextClass,
      citedKeys: [...new Set(citedKeys)].sort(),
      outOfScopeKeys: outOfScopeKeys.sort(),
      paragraphs: paragraphs.length,
      citeParagraphs: sectionCiteParagraphs,
      singleKeyParagraphs: sectionSingleKeyParagraphs,
      listingRuns: sectionListingRuns,
      strongFutureHits,
    });
  }

  // evidence_backed synthesis 可回溯性（blocking：候选组内至少 1 个 key 被正文引用）
  const consumedEvidenceBacked = input.synthesis.items.filter((item) =>
    input.outline.sections.some((section) => (section.synthesisRefs ?? []).includes(item.synthesisId)),
  ).filter((item) => item.groundingLevel === "evidence_backed");
  const untraceable: string[] = [];
  let evidenceBackedUsed = 0;
  for (const item of consumedEvidenceBacked) {
    const candidates = new Set<string>();
    for (const sourceId of item.sourceIds) {
      const key = sourceKeyBySourceId.get(sourceId);
      if (key !== undefined) {
        candidates.add(key);
      }
    }
    for (const evidenceId of item.evidenceIds) {
      const record = input.evidence.find((entry) => entry.id === evidenceId);
      if (record !== undefined) {
        const sourceKey = sourceKeyBySourceId.get(record.source?.sourceId?.trim() ?? "");
        if (sourceKey !== undefined) {
          candidates.add(sourceKey);
        }
      }
    }
    if (candidates.size > 0 && [...candidates].some((key) => allCitedKeys.has(key))) {
      evidenceBackedUsed += 1;
    } else {
      untraceable.push(`${item.synthesisId}（候选：${[...candidates].join(",") || "无"}）`);
    }
  }
  if (untraceable.length > 0) {
    blockers.push({
      code: "synthesis_untraceable",
      detail: `evidence_backed synthesis 不可回溯 ${untraceable.length} 条（正文未引用其任何候选 key）：${untraceable.slice(0, 6).join("；")}${untraceable.length > 6 ? " 等" : ""}`,
    });
  }

  // speculative-only 来源被既定结论章节引用（泄漏信号，warning）
  const keysFromGrounded = new Set<string>();
  const keysFromSpeculativeOnly = new Set<string>();
  for (const item of input.synthesis.items) {
    const keys = item.sourceIds
      .map((sourceId) => sourceKeyBySourceId.get(sourceId))
      .filter((key): key is string => key !== undefined);
    if (item.groundingLevel === "speculative") {
      for (const key of keys) {
        keysFromSpeculativeOnly.add(key);
      }
    } else {
      for (const key of keys) {
        keysFromGrounded.add(key);
      }
    }
  }
  let speculativeLeakSignals = 0;
  for (const result of sectionResults) {
    if (result.context === "future" || result.context === "framing") {
      continue;
    }
    for (const key of result.citedKeys) {
      if (keysFromSpeculativeOnly.has(key) && !keysFromGrounded.has(key)) {
        speculativeLeakSignals += 1;
        warnings.push(
          `section ${result.sectionId} 在既定结论语境引用了仅由 speculative synthesis 支撑的文献（${key}）——确认没有把推测当结论`,
        );
      }
    }
  }

  // literature / family 覆盖
  const citedSources = new Set<string>();
  for (const entry of input.matrix.entries) {
    const key = sourceKeyBySourceId.get(entry.sourceId);
    if (key !== undefined && allCitedKeys.has(key)) {
      citedSources.add(entry.sourceId);
    }
  }
  const familyCoverage: Array<{ label: string; cited: number; total: number }> = [];
  for (const family of input.matrix.taxonomy.families) {
    const inFamily = input.matrix.entries.filter((entry) => entry.methodFamily === family.label);
    if (inFamily.length === 0) {
      continue;
    }
    const cited = inFamily.filter((entry) => citedSources.has(entry.sourceId)).length;
    familyCoverage.push({ label: family.label, cited, total: inFamily.length });
    if (inFamily.length >= FAMILY_COVERAGE_MIN_ENTRIES && cited === 0) {
      warnings.push(
        `方法家族「${family.label}」（${inFamily.length} 篇）在正文中完全未被引用——检查是否遗漏主要方法路线`,
      );
    }
  }
  const unclassified = input.matrix.entries.filter(
    (entry) => entry.methodFamily === undefined || entry.methodFamily === UNCLASSIFIED_FAMILY,
  );
  if (unclassified.length >= FAMILY_COVERAGE_MIN_ENTRIES) {
    const citedUnclassified = unclassified.filter((entry) => citedSources.has(entry.sourceId)).length;
    familyCoverage.push({ label: UNCLASSIFIED_FAMILY, cited: citedUnclassified, total: unclassified.length });
  }

  // 汇总 warnings（阈值类）
  if (citeParagraphs >= SINGLE_KEY_MIN_PARAGRAPHS && singleKeyParagraphs / citeParagraphs >= SINGLE_KEY_RATIO_WARN) {
    warnings.push(
      `单文献段落占比 ${(singleKeyParagraphs / citeParagraphs).toFixed(0)}%（${singleKeyParagraphs}/${citeParagraphs}）——存在逐篇罗列倾向，建议按方法家族合并叙述`,
    );
  }
  if (listingRuns > 0) {
    warnings.push(`检测到 ${listingRuns} 处连续单文献段落游程（≥3 段）——疑似 literature listing 结构`);
  }
  if (totalCiteCommands >= MULTI_KEY_MIN_CITES && multiKeyCiteCommands / totalCiteCommands < MULTI_KEY_RATIO_WARN) {
    warnings.push(
      `多源并列引用占比 ${(multiKeyCiteCommands / totalCiteCommands).toFixed(0)}%（${multiKeyCiteCommands}/${totalCiteCommands}）——综合结论引用过散，考虑 \\cite{a,b,c} 形式`,
    );
  }
  for (const result of sectionResults) {
    if (result.strongFutureHits > 0) {
      warnings.push(
        `section ${result.sectionId}（非展望章节）出现 ${result.strongFutureHits} 处强断言式未来措辞（必将 / 终将 / 必然实现…）——推测内容不得写成既定结论`,
      );
      speculativeLeakSignals += result.strongFutureHits;
    }
  }

  const evidenceBackedTotal = consumedEvidenceBacked.length;
  const metrics: SurveyWritingMetrics = {
    sections: sectionResults.length,
    totalCiteCommands,
    multiKeyCiteCommands,
    multiKeyCiteRatio: totalCiteCommands === 0 ? 0 : multiKeyCiteCommands / totalCiteCommands,
    literatureCoverage: input.matrix.entries.length === 0 ? 0 : citedSources.size / input.matrix.entries.length,
    citedLiterature: citedSources.size,
    totalLiterature: input.matrix.entries.length,
    groundedSynthesisUsage: evidenceBackedTotal === 0 ? 0 : evidenceBackedUsed / evidenceBackedTotal,
    evidenceBackedUsed,
    evidenceBackedTotal,
    singleKeyParagraphRatio: citeParagraphs === 0 ? 0 : singleKeyParagraphs / citeParagraphs,
    listingRuns,
    speculativeLeakSignals,
    familyCoverage,
  };

  return { blockers, warnings, metrics, sections: sectionResults, contexts };
}

/** metrics → reviewer / report 用的确定性 digest 行 */
export function renderSurveyMetricsLines(evaluation: SurveyWritingEvaluation): string[] {
  const { metrics } = evaluation;
  return [
    `- 章节数：${metrics.sections}；引用命令：${metrics.totalCiteCommands}（多源并列 ${metrics.multiKeyCiteCommands}，占比 ${(metrics.multiKeyCiteRatio * 100).toFixed(0)}%）`,
    `- 文献覆盖：${metrics.citedLiterature}/${metrics.totalLiterature}（${(metrics.literatureCoverage * 100).toFixed(0)}%）`,
    `- evidence_backed synthesis 可回溯：${metrics.evidenceBackedUsed}/${metrics.evidenceBackedTotal}（${(metrics.groundedSynthesisUsage * 100).toFixed(0)}%）`,
    `- 单文献段落占比：${(metrics.singleKeyParagraphRatio * 100).toFixed(0)}%；连续罗列游程：${metrics.listingRuns}；speculative 泄漏信号：${metrics.speculativeLeakSignals}`,
    ...(metrics.familyCoverage.length > 0
      ? [
          `- 家族覆盖：${metrics.familyCoverage
            .map((family) => `${family.label} ${family.cited}/${family.total}`)
            .join("、")}`,
        ]
      : []),
    ...(evaluation.warnings.length > 0
      ? ["- 确定性 warnings：", ...evaluation.warnings.slice(0, 10).map((warning) => `  - ${warning}`)]
      : []),
  ];
}
