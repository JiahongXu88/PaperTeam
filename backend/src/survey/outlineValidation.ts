/**
 * Survey Outline 确定性契约校验（M11.1.3）。
 *
 * 职责分离：
 * - 普通结构合法性（≥3 节 / id 唯一 / 文件名）属 ManuscriptService.validateOutline；
 * - 本文件只做 **Survey 专属语义**：refs 存在性、speculative 泄漏、
 *   paper-by-paper 退化、unsupported gap / future——普通论文 outline 不经过
 *   本校验（规则不互相污染）。
 *
 * 输出区分 blocking（不落盘，fail-closed）与 warnings（人审 / HITL 提示；
 * 覆盖与平衡类问题不是错误——「某 family 60%」不自动等于结构失当，第一版
 * 不用硬阈值拒绝不均衡，只要求可见）。
 *
 * 全部规则为纯函数判定（无 IO / 时钟 / 模型），逐条可单测锁死。
 */

import type { Outline, OutlineSection } from "../manuscript/ManuscriptService.js";
import type { SurveyMatrixArtifact } from "./matrixTypes.js";
import { UNCLASSIFIED_FAMILY } from "./matrixTypes.js";
import type { SurveySynthesisArtifact, SurveySynthesisItem } from "./synthesisTypes.js";

export type SurveySectionContext = "framing" | "future" | "gap" | "core";

export interface SurveyOutlineValidationSummary {
  sections: { total: number; framing: number; future: number; gap: number; core: number };
  /** distinct synthesisRefs / synthesis items（0-1） */
  synthesisCoverage: number;
  /** distinct literatureRefs / matrix entries（0-1） */
  literatureCoverage: number;
}

export interface SurveyOutlineValidation {
  blocking: string[];
  warnings: string[];
  summary: SurveyOutlineValidationSummary;
}

/** paper-by-paper 退化判据的最小文献规模（小于该值不判退化——小 corpus 逐篇结构可能是真实的） */
const DEGENERATION_MIN_LITERATURE = 5;
const DEGENERATION_MIN_SOLO_SECTIONS = 3;

const FUTURE_PATTERN = /future|outlook|prospect|展望|未来|前景/i;
const FRAMING_PATTERN = /introduction|conclusion|abstract|background|preface|summary|引言|绪论|结论|总结|摘要|背景|前言/i;
const GAP_PATTERN = /gap|limitation|open problem|open question|空缺|缺口|局限|不足|挑战|开放问题/i;
const TAXONOMY_SECTION_PATTERN = /categor|classif|taxonom|分类|类别|体系|方法族|方法体系/i;

/**
 * section 语境分类（确定性；基于 id + title 的启发式，供 grounding 消费规则
 * 判定）。次序：future → framing → gap → core——「Conclusion and Future
 * Directions」类混合标题按 future 处理（speculative 只能进这类章节）。
 */
export function classifySurveySection(section: OutlineSection): SurveySectionContext {
  const text = `${section.id} ${section.title}`;
  if (FUTURE_PATTERN.test(text)) {
    return "future";
  }
  if (FRAMING_PATTERN.test(text) || section.id === "introduction" || section.id === "conclusion" || section.id === "abstract") {
    return "framing";
  }
  if (GAP_PATTERN.test(text)) {
    return "gap";
  }
  return "core";
}

export function validateSurveyOutline(
  outline: Outline,
  input: {
    matrix: SurveyMatrixArtifact;
    synthesis: SurveySynthesisArtifact;
    /** sourceId → 年份（SourceStore 注入；缺省跳过年份类 warning） */
    yearBySource?: Map<string, number>;
  },
): SurveyOutlineValidation {
  const blocking: string[] = [];
  const warnings: string[] = [];

  const synthesisById = new Map<string, SurveySynthesisItem>(
    input.synthesis.items.map((item) => [item.synthesisId, item]),
  );
  const entryIds = new Set(input.matrix.entries.map((entry) => entry.entryId));
  const literatureCount = input.matrix.entries.length;

  const usedSynthesisRefs = new Set<string>();
  const usedLiteratureRefs = new Set<string>();
  const contextCounts = { framing: 0, future: 0, gap: 0, core: 0 };

  // 非 framing 的正文 section（退化判据的分母：gap / future 也是正文）
  const bodySections: OutlineSection[] = [];
  const soloSections: OutlineSection[] = [];

  for (const section of outline.sections) {
    const context = classifySurveySection(section);
    contextCounts[context] += 1;
    if (context !== "framing") {
      bodySections.push(section);
    }

    const synthesisRefs = section.synthesisRefs ?? [];
    const literatureRefs = section.literatureRefs ?? [];
    for (const ref of synthesisRefs) {
      usedSynthesisRefs.add(ref);
    }
    for (const ref of literatureRefs) {
      usedLiteratureRefs.add(ref);
    }

    // Rule 2：悬空 synthesisRefs（fail）
    const danglingSynthesis = synthesisRefs.filter((ref) => !synthesisById.has(ref));
    if (danglingSynthesis.length > 0) {
      blocking.push(
        `section ${section.id} 引用了不存在的 synthesisId：${danglingSynthesis.join("、")}（必须逐字复制 digest 中列出的 SYN- 标识）`,
      );
    }
    // Rule 3：悬空 literatureRefs（fail）
    const danglingLiterature = literatureRefs.filter((ref) => !entryIds.has(ref));
    if (danglingLiterature.length > 0) {
      blocking.push(
        `section ${section.id} 引用了不存在的 entryId：${danglingLiterature.join("、")}（必须逐字复制文献清单中的 M- 标识）`,
      );
    }

    // Rule 5：speculative 泄漏——speculative 只能被 future 语境 section 消费
    const speculativeRefs = synthesisRefs.filter(
      (ref) => synthesisById.get(ref)?.groundingLevel === "speculative",
    );
    if (speculativeRefs.length > 0 && context !== "future") {
      blocking.push(
        `section ${section.id}（${section.title}）是${context === "framing" ? "框架" : context === "gap" ? "空缺/局限" : "既定结论"}章节，不得消费 speculative synthesis：${speculativeRefs.join("、")}（推测类内容只能进入明确的展望 / 未来方向章节）`,
      );
    }

    // Rule 4：core 正文 section 必须绑定 synthesis（Outline 只能组织已有结论）
    if (context === "core" && synthesisRefs.length === 0) {
      blocking.push(
        `section ${section.id}（${section.title}）是核心正文章节但没有 synthesisRefs——核心章节必须说明消费了哪些 synthesis，不得自造结构依据`,
      );
    }

    // Rule 6：gap 章节只能消费 research_gap synthesis
    if (context === "gap") {
      if (synthesisRefs.length === 0) {
        blocking.push(
          `section ${section.id}（${section.title}）是空缺/局限章节但没有 synthesisRefs——研究空缺必须来自 research_gap synthesis，不得由大纲自造`,
        );
      } else {
        const foreign = synthesisRefs.filter((ref) => synthesisById.get(ref)?.kind !== "research_gap");
        if (foreign.length > 0) {
          blocking.push(
            `section ${section.id}（${section.title}）是空缺/局限章节，只能消费 research_gap synthesis（当前混入：${foreign.join("、")}）`,
          );
        }
      }
    }

    // Rule 7：future 章节必须消费 future_direction synthesis（可含 speculative，
    // 但不允许空手自造方向；grounding / speculation 的区分由 refs 指向的
    // synthesis 保持——Outline 不复制 groundingLevel，天然不抹平）
    if (context === "future") {
      if (synthesisRefs.length === 0) {
        blocking.push(
          `section ${section.id}（${section.title}）是展望章节但没有 synthesisRefs——未来方向必须来自 future_direction（或 research_gap）synthesis`,
        );
      } else {
        const foreign = synthesisRefs.filter(
          (ref) =>
            synthesisById.get(ref) !== undefined &&
            synthesisById.get(ref)!.kind !== "future_direction" &&
            synthesisById.get(ref)!.kind !== "research_gap",
        );
        if (foreign.length > 0) {
          warnings.push(
            `section ${section.id}（${section.title}）是展望章节但消费了非 future_direction / research_gap 的 synthesis（${foreign.join("、")}）——确认这是有意的组织而不是误绑`,
          );
        }
      }
    }

    // 退化采样：正文 section 恰好只挂 1 篇文献
    if (context !== "framing" && literatureRefs.length === 1) {
      soloSections.push(section);
    }
  }

  // Rule 1：paper-by-paper 退化（section 数量接近文献数且大量单篇节）
  if (
    literatureCount >= DEGENERATION_MIN_LITERATURE &&
    soloSections.length >= DEGENERATION_MIN_SOLO_SECTIONS &&
    soloSections.length >= Math.ceil(bodySections.length * 0.5)
  ) {
    blocking.push(
      `大纲疑似退化为逐篇论文罗列：${soloSections.length}/${bodySections.length} 个正文章节各自只覆盖 1 篇文献（${soloSections.map((section) => section.id).join("、")}）——综述必须按方法体系 / 研究问题组织，每节综合多篇文献`,
    );
  }

  // ---- warnings（覆盖 / 平衡：可见但不自动拒绝） ----

  const stats = summarizeMatrix(input.matrix, input.yearBySource);
  if (stats.totalEntries >= 5 && stats.topFamilyShare >= 0.6) {
    warnings.push(
      `family 分布失衡：${stats.topFamilyLabel} 占 ${stats.topFamilyCount}/${stats.totalEntries}（≥60%）——在相关章节 keyPoints 说明结构依据，不强行平均`,
    );
  }
  if (stats.unclassified > 0) {
    warnings.push(
      `unclassified 文献 ${stats.unclassified} 篇——确认大纲对未归类文献的处理方式（归入「其他」小节或先做 Matrix HITL 修正）`,
    );
  }
  if (stats.totalEntries >= 4 && stats.abstractOnlyShare >= 0.5) {
    warnings.push(
      `abstract_only 文献占比 ${stats.abstractOnly}/${stats.totalEntries}——结构过度依赖摘要级理解的风险，实证 / 评价类小节应主要依赖 fulltext 文献`,
    );
  }
  if (stats.totalEntries >= 5 && stats.distinctYears <= 1) {
    warnings.push("文献年份单一（≤1 个不同年份）——演进 / trend 类章节的依据薄弱");
  }
  if (literatureCount >= 6) {
    const coverage = usedLiteratureRefs.size / literatureCount;
    if (coverage < 0.5) {
      warnings.push(
        `literatureRefs 覆盖率低：outline 只覆盖 ${usedLiteratureRefs.size}/${literatureCount} 篇文献（<50%）——确认未覆盖文献是刻意取舍而不是遗漏`,
      );
    }
  }
  for (const section of outline.sections) {
    if (
      classifySurveySection(section) === "core" &&
      TAXONOMY_SECTION_PATTERN.test(`${section.id} ${section.title}`) &&
      !(section.synthesisRefs ?? []).some((ref) => synthesisById.get(ref)?.kind === "taxonomy")
    ) {
      warnings.push(
        `section ${section.id}（${section.title}）看起来是方法分类章节但未绑定任何 taxonomy synthesis——分类骨架必须与输入 taxonomy 一致`,
      );
    }
  }

  return {
    blocking,
    warnings,
    summary: {
      sections: {
        total: outline.sections.length,
        ...contextCounts,
      },
      synthesisCoverage:
        input.synthesis.items.length === 0 ? 0 : usedSynthesisRefs.size / input.synthesis.items.length,
      literatureCoverage: literatureCount === 0 ? 0 : usedLiteratureRefs.size / literatureCount,
    },
  };
}

function summarizeMatrix(
  matrix: SurveyMatrixArtifact,
  yearBySource: Map<string, number> | undefined,
): {
  totalEntries: number;
  abstractOnly: number;
  abstractOnlyShare: number;
  unclassified: number;
  distinctYears: number;
  topFamilyLabel: string;
  topFamilyCount: number;
  topFamilyShare: number;
} {
  const entries = matrix.entries;
  const byFamily = new Map<string, number>();
  for (const entry of entries) {
    const family = entry.methodFamily ?? UNCLASSIFIED_FAMILY;
    byFamily.set(family, (byFamily.get(family) ?? 0) + 1);
  }
  let topFamilyLabel = "";
  let topFamilyCount = 0;
  for (const [label, count] of byFamily.entries()) {
    if (count > topFamilyCount) {
      topFamilyLabel = label;
      topFamilyCount = count;
    }
  }
  return {
    totalEntries: entries.length,
    abstractOnly: entries.filter((entry) => entry.interpretationDepth === "abstract_only").length,
    abstractOnlyShare: entries.length === 0 ? 0 : entries.filter((entry) => entry.interpretationDepth === "abstract_only").length / entries.length,
    unclassified: entries.filter(
      (entry) => entry.methodFamily === undefined || entry.methodFamily === UNCLASSIFIED_FAMILY,
    ).length,
    distinctYears:
      yearBySource === undefined
        ? Number.MAX_SAFE_INTEGER // 未提供年份时不触发 single-year warning
        : new Set(
            matrix.entries
              .map((entry) => yearBySource.get(entry.sourceId))
              .filter((year): year is number => year !== undefined),
          ).size,
    topFamilyLabel,
    topFamilyCount,
    topFamilyShare: entries.length === 0 ? 0 : topFamilyCount / entries.length,
  };
}
