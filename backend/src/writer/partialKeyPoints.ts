/**
 * Partial Evidence keyPoint Guard（M13 Final Closure，A3）：Planning → Writing 契约边界上的
 * 一次性确定性标注——Planner 的 keyPoints 若与某条 partial 证据的待核验命题词面高度重合、
 * 且本身写成了肯定断言，则在交给 Writer 之前给该要点加上「待核验命题」口径标注。
 *
 * 真实样本（M13.7.11 §6）：真实 idea_to_paper Planner 把 partial 负对照 E012（「G 与寿命倍数
 * 可直接比较」）写成比较维度 keyPoint「寿命增益维度的直接可比性（G 与寿命倍数）」。写作期只有
 * compare 节的任务块会列出 partial 命题，framing / develop 的 keyPoints 仍可能把它当事实。
 *
 * 设计约束：
 * - 只标注、不删除：Planner 用 partial 提出待研究问题 / 比较维度 / 研究空白是合法的；
 * - 保守：要点已是拒绝 / 不确定性立场（classifyClaimStance ≠ assertion）→ 不标；
 *   要点与某条 **direct** 记录的重合不弱于与 partial 的重合 → 不标（事实有 direct 支撑）；
 * - 幂等：已带标注的要点不重复标；
 * - 集中在 Workflow 写作 stage 的一处（普通论文 + 综述共用），不让各 Writer 各自实现一套守卫；
 * - 不改落盘 outline（只改交给 Writer 的内存副本），写作计划指纹仍按原始大纲计算。
 */

import type { EvidenceRecord } from "../evidence/EvidenceStore.js";
import type { Outline, OutlineSection } from "../manuscript/ManuscriptService.js";
import { tokenizeText } from "../retrieval/tokenize.js";
import { classifyClaimStance, distinctiveNumbers } from "../review/claimStance.js";

export const PARTIAL_KEYPOINT_MARKER = "待核验命题：partial 证据";

export interface PartialKeyPointAnnotation {
  sectionId: string;
  keyPointIndex: number;
  keyPoint: string;
  evidenceId: string;
  sharedTerms: number;
  sharedFraction: number;
}

interface Overlap {
  shared: number;
  fraction: number;
  sharedNumber: boolean;
}

function overlap(keyPoint: string, record: EvidenceRecord): Overlap {
  const keyTerms = new Set(tokenizeText(keyPoint));
  if (keyTerms.size === 0) {
    return { shared: 0, fraction: 0, sharedNumber: false };
  }
  const recordText = [record.claim, record.summary ?? ""].join("\n");
  const recordTerms = new Set(tokenizeText(recordText));
  let shared = 0;
  for (const term of keyTerms) {
    if (recordTerms.has(term)) {
      shared += 1;
    }
  }
  const keyNumbers = distinctiveNumbers(keyPoint);
  const recordNumbers = new Set(distinctiveNumbers(recordText));
  const sharedNumber = keyNumbers.some((value) => recordNumbers.has(value));
  return { shared, fraction: shared / keyTerms.size, sharedNumber };
}

/**
 * 重合门槛（精度优先）：短要点里「两条路线的」这类通用二元组会与任何比较类 partial 命题
 * 重合 3–4 项，因此至少要 5 个不同词项且占要点词项 30%，或 ≥ 7 项，或共享特征数字且 ≥ 3 项。
 * 已知局限：Planner 用改写后的维度名复述 partial 命题（如「寿命增益维度的直接可比性」只共享
 * 4 项 / 23%）不会被标注——该情形由 compare 任务块的 partial 命题清单与 Planner 规则 2b 覆盖；
 * 反向地，逐字搬运 partial 命题片段的要点（「比较两条路线的纠错效果」）会被标注——标注只是口径
 * 提示（不删要点、不改事实），这类命中可接受。
 */
function strongEnough(hit: Overlap): boolean {
  return (hit.shared >= 5 && hit.fraction >= 0.3) || hit.shared >= 7 || (hit.sharedNumber && hit.shared >= 3);
}

function strength(hit: Overlap): number {
  return hit.shared + (hit.sharedNumber ? 2 : 0);
}

/** 单条要点的判定：返回命中的 partial 记录（或 null） */
export function matchPartialKeyPoint(
  keyPoint: string,
  evidence: readonly EvidenceRecord[],
): { record: EvidenceRecord; hit: Overlap } | null {
  if (keyPoint.includes(PARTIAL_KEYPOINT_MARKER)) {
    return null;
  }
  if (classifyClaimStance(keyPoint).stance !== "assertion") {
    return null;
  }
  let bestPartial: { record: EvidenceRecord; hit: Overlap } | null = null;
  let bestDirect = 0;
  for (const record of evidence) {
    if (record.verificationStatus !== "verified") {
      continue;
    }
    const hit = overlap(keyPoint, record);
    if (record.supportStrength === "partial") {
      if (strongEnough(hit) && (bestPartial === null || strength(hit) > strength(bestPartial.hit))) {
        bestPartial = { record, hit };
      }
    } else if (record.supportStrength === "direct") {
      bestDirect = Math.max(bestDirect, strength(hit));
    }
  }
  if (bestPartial === null) {
    return null;
  }
  // direct 记录对该要点的支撑不弱于 partial 命题 → 要点有 direct 事实基础，不标
  if (bestDirect >= strength(bestPartial.hit)) {
    return null;
  }
  return bestPartial;
}

export function renderPartialKeyPointSuffix(evidenceId: string): string {
  return `（${PARTIAL_KEYPOINT_MARKER} ${evidenceId} 仅提出该命题、未证实——只能作为待研究问题 / 比较维度 / 研究空白表述，不得写成本节结论或既成事实）`;
}

/**
 * 返回带标注的大纲**副本**与标注清单（原对象不变）。evidence 应为正式池（含 partial 记录）。
 */
export function annotateOutlinePartialKeyPoints(
  outline: Outline,
  evidence: readonly EvidenceRecord[],
): { outline: Outline; annotations: PartialKeyPointAnnotation[] } {
  const partialRecords = evidence.filter((record) => record.supportStrength === "partial" && record.verificationStatus === "verified");
  if (partialRecords.length === 0) {
    return { outline, annotations: [] };
  }
  const annotations: PartialKeyPointAnnotation[] = [];
  const sections: OutlineSection[] = outline.sections.map((section) => {
    if (section.keyPoints === undefined || section.keyPoints.length === 0) {
      return section;
    }
    let changed = false;
    const keyPoints = section.keyPoints.map((keyPoint, index) => {
      const match = matchPartialKeyPoint(keyPoint, evidence);
      if (match === null) {
        return keyPoint;
      }
      changed = true;
      annotations.push({
        sectionId: section.id,
        keyPointIndex: index,
        keyPoint,
        evidenceId: match.record.id,
        sharedTerms: match.hit.shared,
        sharedFraction: Number(match.hit.fraction.toFixed(3)),
      });
      return `${keyPoint}${renderPartialKeyPointSuffix(match.record.id)}`;
    });
    return changed ? { ...section, keyPoints } : section;
  });
  return { outline: annotations.length > 0 ? { ...outline, sections } : outline, annotations };
}
