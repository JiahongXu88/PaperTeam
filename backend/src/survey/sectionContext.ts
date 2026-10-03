/**
 * Survey Section Writing Context（M11.2）。
 *
 * 定位：Writer 的**表达层输入**——把 OutlineSection 的 refs 契约投影成
 * 有界的逐节写作上下文。研究（Literature → Matrix → Synthesis → Outline）
 * 已在 M11.1 完成，Writer 只消费这里的投影，不重新做研究：
 * - 每节只看到与本节 synthesisRefs / literatureRefs 相关的 synthesis claim、
 *   绑定 Evidence 与文献元数据——绝不注入整个 survey.json /
 *   survey-synthesis.json / EvidenceStore / PDF；
 * - 引用候选按 synthesis 推导（一个 synthesis → 多 evidenceIds → 多
 *   citation key）：多源综合结论天然携带 \cite{a,b,c} 候选组，不由 Writer
 *   凭记忆挑单篇；
 * - grounding 分级进入上下文（evidence_backed / literature_cited /
 *   speculative），措辞强度纪律由 Writer prompt 按 Consumer 端分级执行；
 * - 悬空 refs fail-closed（dangling 列表非空即非法上下文，调用方拒绝写作）。
 *
 * 纯函数（无 IO / 时钟 / LLM）：同 outline + matrix + synthesis + evidence +
 * bibliography 恒同上下文。
 */

import type { EvidenceRecord } from "../evidence/EvidenceStore.js";
import { resolveEvidenceCitationKey } from "../citation/bibliography.js";
import type { BibRenderEntry } from "../citation/bibliography.js";
import type { OutlineSection } from "../manuscript/ManuscriptService.js";
import type { SurveyMatrixArtifact } from "./matrixTypes.js";
import type {
  SurveySynthesisArtifact,
  SurveySynthesisItem,
  SurveySynthesisKind,
  SynthesisGroundingLevel,
} from "./synthesisTypes.js";
import { classifySurveySection } from "./outlineValidation.js";
import { summarizeDetail } from "./outlineDigest.js";

/** 单条 synthesis 在写作上下文中的投影 */
export interface SurveySectionSynthesisRef {
  synthesisId: string;
  kind: SurveySynthesisKind;
  groundingLevel: SynthesisGroundingLevel;
  claim: string;
  /** detail 关键字段单行摘要（family / period / dimension / trigger / origin 等） */
  detail?: string;
  /** evidenceIds 中解析到 bibliography key 的（verified evidence 支撑组） */
  evidenceKeys: string[];
  /** sourceIds（Matrix 条目）解析到的 citation key */
  literatureKeys: string[];
  /** 全部引用候选（evidenceKeys ∪ literatureKeys，升序去重） */
  citationCandidates: string[];
  evidenceIds: string[];
  sourceIds: string[];
}

/** 单条 literature ref 在写作上下文中的投影 */
export interface SurveySectionLiteratureRef {
  entryId: string;
  sourceId: string;
  family: string;
  subFamily?: string;
  year?: number;
  title?: string;
  interpretationDepth: "fulltext" | "abstract_only";
  /** bibliography 解析的确定性 key（无匹配 = null：该文献无法被 \cite） */
  citationKey: string | null;
}

export interface SurveySectionWritingContext {
  sectionId: string;
  title: string;
  keyPoints: string[];
  targetLengthWords?: number;
  /** 语境分类（classifySurveySection：framing / core / gap / future） */
  sectionContext: "framing" | "core" | "gap" | "future";
  /** future 语境才允许消费 speculative synthesis（与 outline 校验同口径） */
  speculativeAllowed: boolean;
  /** 本节消费的 synthesis 投影（按 synthesisRefs 顺序；refs 已归一升序） */
  synthesis: SurveySectionSynthesisRef[];
  /** 本节覆盖的文献投影 */
  literature: SurveySectionLiteratureRef[];
  /** 本节绑定 synthesis 的 evidence 记录（formal only 由调用方保证；去重有界） */
  evidence: EvidenceRecord[];
  /** evidence 支撑 key（A 组：事实性论断优先引用来源） */
  evidenceBackedKeys: string[];
  /**
   * 本节允许使用的全部 citation key：
   * - 有 refs 的节 = synthesis 候选 ∪ literature keys；
   * - framing 节（无 refs）= 整个 bibliography（背景章节可引用库内文献）。
   * Writer 输出中出现的任何 \cite key 必须 ∈ 此集合（确定性后检 fail-closed）。
   */
  allowedCitationKeys: string[];
  /** 悬空 refs（非空 = 非法上下文，调用方必须拒绝写作） */
  danglingSynthesisRefs: string[];
  danglingLiteratureRefs: string[];
  /** evidenceIds 解析不到 key / 文献无 key 等降级事实（prompt 如实提示） */
  warnings: string[];
}

/** 每节 evidence 记录上限（防单节上下文膨胀；direct 支撑优先） */
export const SECTION_EVIDENCE_MAX = 24;

export interface BuildSurveySectionContextInput {
  section: OutlineSection;
  matrix: SurveyMatrixArtifact;
  synthesis: SurveySynthesisArtifact;
  /** canonical bibliography（确定性 key；sourceId → key 的解析源） */
  bibliography: readonly BibRenderEntry[];
  /** 本项目 formal evidence（调用方过滤 verified + 锚点；这里只做绑定投影） */
  evidence: EvidenceRecord[];
  titleBySource?: Map<string, string>;
  yearBySource?: Map<string, number>;
}

export function buildSurveySectionContext(
  input: BuildSurveySectionContextInput,
): SurveySectionWritingContext {
  const synthesisById = new Map<string, SurveySynthesisItem>(
    input.synthesis.items.map((item) => [item.synthesisId, item]),
  );
  const entryByEntryId = new Map(input.matrix.entries.map((entry) => [entry.entryId, entry]));
  const evidenceById = new Map(input.evidence.map((record) => [record.id, record]));

  const synthesisRefs = input.section.synthesisRefs ?? [];
  const literatureRefs = input.section.literatureRefs ?? [];
  const sectionContext = classifySurveySection(input.section);

  const danglingSynthesisRefs = synthesisRefs.filter((ref) => !synthesisById.has(ref));
  const danglingLiteratureRefs = literatureRefs.filter((ref) => !entryByEntryId.has(ref));

  const warnings: string[] = [];
  const synthesisProjection: SurveySectionSynthesisRef[] = [];
  const boundEvidence = new Map<string, EvidenceRecord>();
  const allowedKeys = new Set<string>();
  const evidenceBackedKeys = new Set<string>();

  for (const ref of synthesisRefs) {
    const item = synthesisById.get(ref);
    if (item === undefined) {
      continue; // 悬空：dangling 列表已记录，调用方 fail-closed
    }
    // 该 synthesis 绑定的 verified evidence（formal 池内解析）
    const itemEvidence: EvidenceRecord[] = [];
    for (const evidenceId of item.evidenceIds) {
      const record = evidenceById.get(evidenceId);
      if (record !== undefined) {
        itemEvidence.push(record);
      }
    }
    const evidenceKeys: string[] = [];
    for (const record of itemEvidence) {
      const key = resolveEvidenceCitationKey(record, input.bibliography);
      if (key !== null) {
        if (!evidenceKeys.includes(key)) {
          evidenceKeys.push(key);
        }
        evidenceBackedKeys.add(key);
        allowedKeys.add(key);
        boundEvidence.set(record.id, record);
      }
    }
    const literatureKeys: string[] = [];
    for (const sourceId of item.sourceIds) {
      const key = keyForSource(input.bibliography, sourceId);
      if (key !== null && !literatureKeys.includes(key)) {
        literatureKeys.push(key);
        allowedKeys.add(key);
      }
    }
    if (
      item.evidenceIds.length > 0 &&
      itemEvidence.length === 0 &&
      item.groundingLevel === "evidence_backed"
    ) {
      warnings.push(
        `${item.synthesisId} 标记 evidence_backed 但其 evidenceIds 均不在 formal 池（可能被锚点 / 核验状态过滤）——按 literature_cited 口径措辞`,
      );
    }
    synthesisProjection.push({
      synthesisId: item.synthesisId,
      kind: item.kind,
      groundingLevel: item.groundingLevel,
      claim: item.claim,
      ...(item.detail !== undefined ? { detail: summarizeDetail(item.detail) } : {}),
      evidenceKeys: [...evidenceKeys].sort(),
      literatureKeys: [...literatureKeys].sort(),
      citationCandidates: [...new Set([...evidenceKeys, ...literatureKeys])].sort(),
      evidenceIds: [...item.evidenceIds],
      sourceIds: [...item.sourceIds],
    });
  }

  const literatureProjection: SurveySectionLiteratureRef[] = [];
  for (const ref of literatureRefs) {
    const entry = entryByEntryId.get(ref);
    if (entry === undefined) {
      continue;
    }
    const citationKey = keyForSource(input.bibliography, entry.sourceId);
    if (citationKey === null) {
      warnings.push(
        `${entry.entryId}（${input.titleBySource?.get(entry.sourceId) ?? entry.sourceId}）在 bibliography 中无对应条目——该文献不可被 \\cite，只能文字性提及`,
      );
    } else {
      allowedKeys.add(citationKey);
    }
    literatureProjection.push({
      entryId: entry.entryId,
      sourceId: entry.sourceId,
      family: entry.methodFamily ?? "unclassified",
      ...(entry.subFamily !== undefined ? { subFamily: entry.subFamily } : {}),
      ...(input.yearBySource?.get(entry.sourceId) !== undefined
        ? { year: input.yearBySource!.get(entry.sourceId) }
        : {}),
      ...(input.titleBySource?.get(entry.sourceId) !== undefined
        ? { title: input.titleBySource!.get(entry.sourceId)!.slice(0, 120) }
        : {}),
      interpretationDepth: entry.interpretationDepth,
      citationKey,
    });
  }

  // framing 节（无 refs）：允许引用整个 bibliography（背景章节的泛指引用）
  if (synthesisRefs.length === 0 && literatureRefs.length === 0) {
    for (const entry of input.bibliography) {
      allowedKeys.add(entry.key);
    }
  }

  // 绑定 evidence 有界化：direct 支撑优先（与 EvidenceSelectionService 排序口径一致）
  const evidencePool = [...boundEvidence.values()].sort(
    (a, b) => (b.supportStrength === "direct" ? 1 : 0) - (a.supportStrength === "direct" ? 1 : 0),
  );

  return {
    sectionId: input.section.id,
    title: input.section.title,
    keyPoints: input.section.keyPoints ?? [],
    ...(input.section.targetLengthWords !== undefined
      ? { targetLengthWords: input.section.targetLengthWords }
      : {}),
    sectionContext,
    speculativeAllowed: sectionContext === "future",
    synthesis: synthesisProjection,
    literature: literatureProjection,
    evidence: evidencePool.slice(0, SECTION_EVIDENCE_MAX),
    evidenceBackedKeys: [...evidenceBackedKeys].sort(),
    allowedCitationKeys: [...allowedKeys].sort(),
    danglingSynthesisRefs,
    danglingLiteratureRefs,
    warnings,
  };
}

/** sourceId → bibliography key（source-library 条目携带 sourceId；精确匹配） */
function keyForSource(bibliography: readonly BibRenderEntry[], sourceId: string): string | null {
  for (const entry of bibliography) {
    if ((entry.sourceId ?? "").trim() === sourceId) {
      return entry.key;
    }
  }
  return null;
}

// ---- 渲染（prompt 组装单元；WriterService.buildSurveySectionPrompt 消费） ----

/** grounding 分级 → 措辞纪律行（M11.2 §五：literature_cited / speculative 的措辞约束） */
const GROUNDING_WORDING: Record<SynthesisGroundingLevel, string> = {
  evidence_backed:
    "可用确定语气陈述（在证据范围内：范围 / 数值 / 限定词以证据为准，不得扩大），引用其 evidence 支撑 key",
  literature_cited:
    "只能弱措辞（如「现有文献普遍关注」「多项工作表明」「已有研究提出」），禁止写成「研究已经证明」——该结论只有文献支撑、无逐字核验证据",
  speculative:
    "只能进入展望 / 推测语境，措辞必须保留不确定性（可能 / 值得探索 / 未来可考虑 / 有待验证），禁止「研究表明未来一定」「已有证据证明」",
};

/** 渲染 synthesis 投影行（每条：标识 / kind / grounding / claim / 引用候选组） */
export function renderSectionSynthesisLines(context: SurveySectionWritingContext): string[] {
  if (context.synthesis.length === 0) {
    return ["（本节没有绑定 synthesis：只写框架性 / 背景性内容，不引入任何具体研究结论）"];
  }
  return context.synthesis.map((item) => {
    const citation =
      item.citationCandidates.length > 0
        ? item.citationCandidates.join(",")
        : "（无可用 key：不得引用，只能文字性概述）";
    const sources =
      item.evidenceKeys.length > 0
        ? `evidence key：${item.evidenceKeys.join(",")}`
        : "（无 evidence key）";
    return [
      `- [${item.synthesisId}]（${item.kind}｜grounding=${item.groundingLevel}｜来源 ${item.sourceIds.length} 篇）`,
      `  claim：${item.claim}`,
      ...(item.detail !== undefined ? [`  detail：${item.detail}`] : []),
      `  ${sources}｜文献 key：${item.literatureKeys.length > 0 ? item.literatureKeys.join(",") : "（无）"}`,
      `  本条结论的引用候选组（\\cite 可多 key 并列）：${citation}`,
      `  措辞纪律：${GROUNDING_WORDING[item.groundingLevel]}`,
    ].join("\n");
  });
}

/** 渲染文献投影行（本节覆盖的文献清单：entryId / 家族 / 年份 / 深度 / key） */
export function renderSectionLiteratureLines(context: SurveySectionWritingContext): string[] {
  if (context.literature.length === 0) {
    return ["（本节没有独立 literatureRefs：文献经 synthesis 引用候选组进入）"];
  }
  return context.literature.map((item) =>
    [
      `- ${item.entryId}`,
      `深度=${item.interpretationDepth}`,
      `家族=${item.family}${item.subFamily !== undefined ? `/${item.subFamily}` : ""}`,
      ...(item.year !== undefined ? [String(item.year)] : []),
      ...(item.title !== undefined ? [item.title] : []),
      item.citationKey !== null ? `cite: ${item.citationKey}` : "（无 cite key）",
    ].join("｜"),
  );
}
