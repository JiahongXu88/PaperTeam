/**
 * Evidence Citation Coverage（M6.6 §13 Quality Gate Integration）：
 * 确定性检测「正文引用的 bib key 是否存在对应的 Verified Evidence」。
 *
 * 匹配链（EvidenceRecord → source metadata → bib entry）：
 *   DOI 精确匹配 → 归一化 title（+ 年份一致性）匹配
 * 只有 formal evidence（verified + chunk 锚点，EvidenceSelectionService 规则）
 * 参与覆盖判定——legacy unverified 不产生覆盖（§M6.6-10 使用策略）。
 *
 * 与既有 Gate 的关系：不替换任何规则，只新增 `citations_evidence_backed`
 * 规则的输入（呈现计数；是否阻断由 requireEvidenceBackedCitations 阈值决定）。
 */

import type { EvidenceRecord } from "../evidence/EvidenceStore.js";
import { EvidenceSelectionService, isFormalEvidence } from "../evidence/EvidenceSelectionService.js";
import type { BibEntrySummary } from "../citation/StaticCitationChecker.js";

export interface EvidenceCitationCoverageInput {
  /** 正文实际引用的 bib key（去重；CitationReport.static.citedKeys） */
  citedKeys: readonly string[];
  /** bib 条目摘要（CitationReport.static.bibEntries） */
  bibEntries: readonly BibEntrySummary[];
  /** 证据库全量记录 */
  evidenceRecords: readonly EvidenceRecord[];
}

export interface EvidenceCitationCoverage {
  /** 每个 cited key 是否有对应 verified evidence 覆盖 */
  byKey: Record<string, boolean>;
  covered: string[];
  uncovered: string[];
}

export function computeEvidenceCitationCoverage(
  input: EvidenceCitationCoverageInput,
): EvidenceCitationCoverage {
  const entryByKey = new Map(input.bibEntries.map((entry) => [entry.key, entry]));
  // formal evidence 覆盖的 bib key 集合（匹配规则与 Writer 引用关联同源：
  // EvidenceSelectionService.matchBibliographyKey——DOI → 归一化 title+年份）
  const coveredKeys = new Set<string>();
  for (const record of input.evidenceRecords) {
    if (!isFormalEvidence(record)) {
      continue;
    }
    const key = EvidenceSelectionService.matchBibliographyKey(record, input.bibEntries);
    if (key !== null) {
      coveredKeys.add(key);
    }
  }
  const byKey: Record<string, boolean> = {};
  const covered: string[] = [];
  const uncovered: string[] = [];
  for (const key of input.citedKeys) {
    // bib 中不存在的 key 由既有 citation_structure_valid 规则处理，
    // 这里只评估「存在但无 verified evidence」的情况
    const backed = entryByKey.has(key) && coveredKeys.has(key);
    byKey[key] = backed;
    (backed ? covered : uncovered).push(key);
  }
  return { byKey, covered, uncovered };
}
