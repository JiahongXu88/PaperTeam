/**
 * Section-aware Evidence Allocation（M13.7.10）：把正式 Evidence 池按章节论证单元分配。
 *
 * 背景：生产 `writingSectionsStage` 过去在章节循环之前调用一次 `selectForWriting`，
 * 同一份 ≤ 20 条 Evidence 传给每一节——M13.7.7 定位的跨章节重复首要缺口。本模块
 * 在既有 `EvidenceSelectionService` 的 formal 判定之上做**逐节投影**，不改变正式证据
 * 的定义：
 * - 正式 Evidence 仍以 `isFormalEvidence` 为准；未核验 / 缺锚点的记录不进入任何章节；
 * - 规划者指定的 `evidenceIds`（pinned）只能命中 formal 池里的 canonical ID，命不中的
 *   逐条拒绝并给出原因（unknown / not_formal），绝不按自由文本猜证据；
 * - develop 节按相关性（标题 / 要点 / 任务 与 claim / quote / 来源标题 的词面重合）选取，
 *   并做覆盖兜底：池中每一条正式 Evidence 至少落到一个 develop 节（没有 develop 节时落到
 *   compare 节），不因每节限量而静默丢掉事实；
 * - partial 记录只交给相关 develop 节与 compare 节（M13.7.7 §8：partial 负例在全部章节
 *   成为「拆弹」吸引子）——规划者 pinned 到 framing / conclude 的 partial 同样被拒绝；
 * - framing / conclude 不注入正式 Evidence（B2 原型策略；背景引用能力由 B 组 key 保留），
 *   规划者显式 pinned 的除外（有界）；
 * - compare 节拿到整个 formal 池（限量时按相关性取前 N）；
 * - 多个章节共享真正相关的 Evidence 是允许的，不为去重强制互斥；
 * - 纯函数、确定性：同输入恒同分配（稳定排序：分数降序 → id 升序）。
 */

import type { EvidenceRecord } from "./EvidenceStore.js";
import { FORMAL_EVIDENCE_LIMIT, isFormalEvidence } from "./EvidenceSelectionService.js";
import type { Outline } from "../manuscript/ManuscriptService.js";
import type { ResolvedArgumentUnit } from "../writer/argumentUnit.js";
import { tokenizeText } from "../retrieval/tokenize.js";

export interface SectionEvidenceAllocation {
  sectionId: string;
  role: ResolvedArgumentUnit["role"];
  /** 最终进入本节 prompt 的 Evidence ID（有序：pinned → 相关性 → 覆盖兜底） */
  evidenceIds: string[];
  pinned: string[];
  pinnedRejected: Array<{ id: string; reason: "unknown" | "not_formal" | "partial_not_allowed_in_role" }>;
  relevanceSelected: string[];
  coverageAdded: string[];
  partialIds: string[];
  /** 可诊断事实（evidence_insufficient 等；进产物与 stage 结果，不进正文） */
  diagnostics: string[];
}

export interface EvidenceAllocationResult {
  sections: SectionEvidenceAllocation[];
  /** 没有落到任何 develop / compare 节的 formal 记录（正常为空；非空时如实报告） */
  unassigned: string[];
  /** 进入分配的 formal 池 ID（审计用） */
  formalIds: string[];
  /** 被排除的非正式记录数（审计用；不进 prompt） */
  excludedNonFormal: number;
}

export interface AllocationLimits {
  /** develop 节相关性选取上限（缺省 12） */
  develop: number;
  /** compare 节上限（缺省 FORMAL_EVIDENCE_LIMIT） */
  compare: number;
  /** framing / conclude 的 pinned 上限（缺省 4） */
  framingPinned: number;
  /** develop 节正式证据少于此数记 evidence_insufficient（缺省 2） */
  insufficientBelow: number;
}

export const DEFAULT_ALLOCATION_LIMITS: AllocationLimits = {
  develop: 12,
  compare: FORMAL_EVIDENCE_LIMIT,
  framingPinned: 4,
  insufficientBelow: 2,
};

interface ScoredRecord {
  id: string;
  score: number;
}

/** 相关性入选的最低分：一个独有标题 token（×3）或三个要点 token；更低的只靠覆盖兜底进入 */
export const MIN_RELEVANCE_SCORE = 3;

/**
 * 章节侧 token：标题取**独有** token（出现在 ≥ 2 个章节标题中的通用词如「逻辑」「方法」不计，
 * 否则相邻 develop 节会互相泄漏证据）；正文侧只用 keyPoints 与规划者自己写的 task 补充——
 * 模板任务会点名其他章节标题，不能参与打分。
 */
function sectionTokens(unit: ResolvedArgumentUnit, outline: Outline): { title: Set<string>; body: Set<string> } {
  const section = outline.sections.find((candidate) => candidate.id === unit.sectionId);
  const shared = new Map<string, number>();
  for (const candidate of outline.sections) {
    for (const token of new Set(tokenizeText(candidate.title))) {
      shared.set(token, (shared.get(token) ?? 0) + 1);
    }
  }
  const title = new Set(tokenizeText(section?.title ?? unit.title).filter((token) => (shared.get(token) ?? 0) <= 1));
  const body = new Set(tokenizeText([...(section?.keyPoints ?? []), section?.argument?.task ?? ""].join(" ")));
  return { title, body };
}

function recordTokens(record: EvidenceRecord): Set<string> {
  return new Set(
    tokenizeText(
      [record.claim, record.summary ?? "", (record.quote ?? "").slice(0, 1200), record.source?.title ?? ""].join(" "),
    ),
  );
}

/** 词面相关性：标题 token 命中 ×3，要点 / 任务 token 命中 ×1；relatedSections 命中 +10 */
function scoreRecord(
  record: EvidenceRecord,
  tokens: Set<string>,
  section: { id: string; title: string; titleTokens: Set<string>; bodyTokens: Set<string> },
): number {
  let score = 0;
  for (const token of section.titleTokens) {
    if (tokens.has(token)) score += 3;
  }
  for (const token of section.bodyTokens) {
    if (tokens.has(token)) score += 1;
  }
  if ((record.relatedSections ?? []).some((related) => related === section.id || related === section.title)) {
    score += 10;
  }
  return score;
}

function byScoreThenId(a: ScoredRecord, b: ScoredRecord): number {
  return b.score - a.score || a.id.localeCompare(b.id);
}

export function allocateSectionEvidence(params: {
  outline: Outline;
  units: readonly ResolvedArgumentUnit[];
  /** 证据库记录（可含非正式；本函数按 isFormalEvidence 过滤） */
  evidence: readonly EvidenceRecord[];
  limits?: Partial<AllocationLimits>;
}): EvidenceAllocationResult {
  const limits: AllocationLimits = { ...DEFAULT_ALLOCATION_LIMITS, ...(params.limits ?? {}) };
  const formal = params.evidence.filter(isFormalEvidence);
  const formalById = new Map(formal.map((record) => [record.id, record]));
  const knownIds = new Set(params.evidence.map((record) => record.id));
  const tokensById = new Map(formal.map((record) => [record.id, recordTokens(record)]));

  const scoresBySection = new Map<string, Map<string, number>>();
  for (const unit of params.units) {
    const { title, body } = sectionTokens(unit, params.outline);
    const scores = new Map<string, number>();
    for (const record of formal) {
      scores.set(
        record.id,
        scoreRecord(record, tokensById.get(record.id)!, { id: unit.sectionId, title: unit.title, titleTokens: title, bodyTokens: body }),
      );
    }
    scoresBySection.set(unit.sectionId, scores);
  }

  const allocations = new Map<string, SectionEvidenceAllocation>();
  for (const unit of params.units) {
    const allocation: SectionEvidenceAllocation = {
      sectionId: unit.sectionId,
      role: unit.role,
      evidenceIds: [],
      pinned: [],
      pinnedRejected: [],
      relevanceSelected: [],
      coverageAdded: [],
      partialIds: [],
      diagnostics: [],
    };
    // pinned：规划者指定，只认 formal 池里的 canonical ID。partial 记录是待核验命题（M13.7.7 §8：
    // 在全部章节成为「拆弹」吸引子），只允许进入 develop / compare；规划者把 partial 钉到 framing /
    // conclude（M13.7.11 真实 Planner：结论节 pinned 了负对照 E011）时逐条拒绝并给出原因。
    for (const id of unit.pinnedEvidenceIds) {
      const formalRecord = formalById.get(id);
      if (formalRecord === undefined) {
        allocation.pinnedRejected.push({ id, reason: knownIds.has(id) ? "not_formal" : "unknown" });
      } else if ((unit.role === "framing" || unit.role === "conclude") && formalRecord.supportStrength === "partial") {
        allocation.pinnedRejected.push({ id, reason: "partial_not_allowed_in_role" });
      } else if (!allocation.pinned.includes(id)) {
        allocation.pinned.push(id);
      }
    }
    const scores = scoresBySection.get(unit.sectionId)!;
    const ranked = formal.map((record) => ({ id: record.id, score: scores.get(record.id) ?? 0 })).sort(byScoreThenId);
    switch (unit.role) {
      case "develop": {
        const picked = ranked
          .filter((entry) => entry.score >= MIN_RELEVANCE_SCORE && !allocation.pinned.includes(entry.id))
          .slice(0, Math.max(0, limits.develop - allocation.pinned.length));
        allocation.relevanceSelected = picked.map((entry) => entry.id);
        break;
      }
      case "compare": {
        const picked = ranked.filter((entry) => !allocation.pinned.includes(entry.id)).slice(0, Math.max(0, limits.compare - allocation.pinned.length));
        allocation.relevanceSelected = picked.map((entry) => entry.id);
        break;
      }
      case "framing":
      case "conclude": {
        if (allocation.pinned.length > limits.framingPinned) {
          allocation.diagnostics.push(
            `规划者为 ${unit.role} 章节指定了 ${allocation.pinned.length} 条 Evidence，超出 ${limits.framingPinned} 条上限，只保留前 ${limits.framingPinned} 条`,
          );
          allocation.pinned = allocation.pinned.slice(0, limits.framingPinned);
        }
        break;
      }
    }
    allocations.set(unit.sectionId, allocation);
  }

  // 覆盖兜底：每条 formal 记录至少落到一个 develop 节（无 develop 节时落到 compare 节）
  const developUnits = params.units.filter((unit) => unit.role === "develop");
  const compareUnits = params.units.filter((unit) => unit.role === "compare");
  const unassigned: string[] = [];
  for (const record of formal) {
    const coveredByDevelop = developUnits.some((unit) => {
      const allocation = allocations.get(unit.sectionId)!;
      return allocation.pinned.includes(record.id) || allocation.relevanceSelected.includes(record.id);
    });
    if (coveredByDevelop) continue;
    if (developUnits.length > 0) {
      // 分数最高的 develop 节；全零时取当前最少的一节（确定性：先按分数，再按已分配数量，再按大纲顺序）
      const target = [...developUnits]
        .map((unit, order) => ({
          unit,
          order,
          score: scoresBySection.get(unit.sectionId)!.get(record.id) ?? 0,
          size: allocations.get(unit.sectionId)!.pinned.length + allocations.get(unit.sectionId)!.relevanceSelected.length + allocations.get(unit.sectionId)!.coverageAdded.length,
        }))
        .sort((a, b) => b.score - a.score || a.size - b.size || a.order - b.order)[0]!;
      allocations.get(target.unit.sectionId)!.coverageAdded.push(record.id);
      continue;
    }
    const coveredByCompare = compareUnits.some((unit) => {
      const allocation = allocations.get(unit.sectionId)!;
      return allocation.pinned.includes(record.id) || allocation.relevanceSelected.includes(record.id);
    });
    if (!coveredByCompare) {
      unassigned.push(record.id);
    }
  }

  const sections: SectionEvidenceAllocation[] = params.units.map((unit) => {
    const allocation = allocations.get(unit.sectionId)!;
    const ordered = [...allocation.pinned, ...allocation.relevanceSelected, ...allocation.coverageAdded];
    allocation.evidenceIds = [...new Set(ordered)];
    allocation.partialIds = allocation.evidenceIds.filter((id) => formalById.get(id)?.supportStrength === "partial");
    if (unit.role === "develop" && allocation.evidenceIds.length < limits.insufficientBelow) {
      allocation.diagnostics.push(
        `evidence_insufficient：develop 章节「${unit.title}」只分配到 ${allocation.evidenceIds.length} 条正式 Evidence——按证据短写 / 弱化，不凭空填充；需要更多依据时走 Evidence Supply 补证`,
      );
    }
    if (allocation.pinnedRejected.length > 0) {
      allocation.diagnostics.push(
        `规划者指定的 Evidence 中 ${allocation.pinnedRejected.length} 条不在正式池：${allocation.pinnedRejected
          .map((entry) => `${entry.id}(${entry.reason})`)
          .join("、")}`,
      );
    }
    if (allocation.coverageAdded.length > 0) {
      allocation.diagnostics.push(`覆盖兜底补入 ${allocation.coverageAdded.length} 条未被任何 develop 节按相关性选中的 Evidence：${allocation.coverageAdded.join("、")}`);
    }
    return allocation;
  });

  return {
    sections,
    unassigned,
    formalIds: formal.map((record) => record.id),
    excludedNonFormal: params.evidence.length - formal.length,
  };
}

/** 按分配结果取出本节记录（保持分配顺序；缺失 ID 静默跳过——分配与池同源，正常不缺） */
export function projectAllocatedEvidence(
  allocation: SectionEvidenceAllocation,
  evidence: readonly EvidenceRecord[],
): EvidenceRecord[] {
  const byId = new Map(evidence.map((record) => [record.id, record]));
  const projected: EvidenceRecord[] = [];
  for (const id of allocation.evidenceIds) {
    const record = byId.get(id);
    if (record !== undefined) projected.push(record);
  }
  return projected;
}
