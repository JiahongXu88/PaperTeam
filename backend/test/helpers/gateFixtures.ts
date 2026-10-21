/**
 * M14.9.5.4 Quality Gate 单元测试共用夹具：「已执行」的引用核验报告与 claim 核验计数。
 *
 * 规则执行状态语义（gates.ts）：citation=null（未执行 citation.verify）或 factVerdicts=null（未执行 claim 级核验）
 * 时，对应规则是 NOT_EVALUATED（必需）而不是 PASS。意在测试「其他规则通过 / 失败」的夹具需要显式给出已执行的前提。
 */
import type { CitationReport } from "../../src/citation/CitationService.js";

export function cleanCitationReport(citedCount = 1): CitationReport {
  return {
    generatedAt: "2026-10-21T00:00:00Z",
    static: { citedKeys: citedCount > 0 ? ["a"] : [], missingKeys: [], unusedKeys: [], duplicateKeys: [], badCitations: [], bibEntries: [] },
    metadata: { enabled: true, providers: [], checked: citedCount, skipped: 0, results: [], byStatus: { verified: citedCount, mismatch: 0, not_found: 0, unverifiable: 0 } },
    summary: { citedCount, missingKeys: 0, unusedKeys: 0, duplicateKeys: 0, badCitations: 0, hallucinated: 0, mismatched: 0, unverifiable: 0 },
  } as CitationReport;
}

/** fact 路已评估 n 条 claim（全部 SUPPORTED） */
export const EVALUATED_FACT_VERDICTS = { SUPPORTED: 1, PARTIALLY_SUPPORTED: 0, UNSUPPORTED: 0, CONTRADICTED: 0 } as const;
