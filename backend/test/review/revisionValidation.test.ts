/**
 * Revision Validation 纯函数测试（M6.7 §6/§7/§8/§9）：
 * - 四类复核的条目归因：fact 漂移 / 引用无依据丢失 → rejected；
 *   claim 强度 block → rejected、warning / 证据失效 → needs_review；干净 → validated
 * - ok / blocked 语义：blocked（rejected / block finding）驱动 HITL；
 *   needs_review 不阻断循环但 Quality Gate 阻断 Final
 * - citation delta（新增引用 evidence-backed）与 evidence recheck 的记录
 * - 文件级归因口径（section 引用 → 文件；摘要引用归组装根 main.tex）
 */

import { describe, expect, it } from "vitest";

import type { EvidenceRecord } from "../../src/evidence/EvidenceStore.js";
import type { FactPreservationSummary } from "../../src/quality/factPreservation.js";
import type { CitationPreservationSummary } from "../../src/quality/citationPreservation.js";
import { buildRevisionPlan, type RevisionPlan } from "../../src/review/revisionPlan.js";
import { applyRevisionItemTransitions } from "../../src/review/revisionItemStatus.js";
import {
  evaluateRevisionValidation,
  itemTouchesFile,
  withUserDecision,
  type RevisionValidationInput,
} from "../../src/review/revisionValidation.js";
import type { ReviewSummary } from "../../src/review/ReviewAggregator.js";

const BEFORE_TEX = [
  "\\section{实验}",
  "该方法可能改善检索质量与幻觉率。",
  "我们在两个数据集上进行了评估 \\cite{gao2023survey}。",
  "",
  "\\begin{equation}",
  "  q = \\alpha r + (1-\\alpha) g",
  "\\end{equation}",
].join("\n");

function summaryOf(): ReviewSummary {
  return {
    generatedAt: "2026-09-18T00:00:00.000Z",
    round: 1,
    reviewedRevision: 2,
    issues: [
      {
        category: "fact",
        severity: "critical",
        section: "sections/experiments.tex",
        description: "关键论断无证据",
        evidenceRef: "E001",
        blocking: true,
      },
    ],
    counts: { critical: 1, major: 0, minor: 0, byCategory: {}, blocking: 1 },
    scores: { academicScore: 85, styleRisk: 20, factVerdicts: null },
    openCritical: 1,
    openMajor: 0,
    unsupportedCriticalClaims: 0,
    reportPaths: [],
  };
}

function appliedPlan(): RevisionPlan {
  const plan = buildRevisionPlan({
    projectId: "p1",
    sourceRevision: 2,
    reviewRound: 1,
    summary: summaryOf(),
  });
  const applied = applyRevisionItemTransitions(
    plan,
    plan.items
      .filter((item) => item.kind === "review_finding")
      .map((item) => ({ id: item.id, to: "applied" as const, reason: "dispatched" as const, appliedRevision: 3, targetChanged: true })),
    "2026-09-18T01:00:00.000Z",
  );
  return applied.plan;
}

const OK_FACT: FactPreservationSummary = {
  previousRevision: 2,
  currentRevision: 3,
  changedFacts: [],
  removedFacts: [],
  addedUnsupportedFacts: [],
  directionalChanges: [],
  formulaChanges: [],
  placeholderRegressions: [],
  allowedChanges: 0,
  allowedRemovals: 0,
  planId: "plan-r1-rev2",
  ok: true,
};

const OK_CITATION: CitationPreservationSummary = {
  previousRevision: 2,
  currentRevision: 3,
  previousCount: 1,
  currentCount: 1,
  previousKeys: ["gao2023survey"],
  currentKeys: ["gao2023survey"],
  removedKeys: [],
  addedKeys: [],
  allowedRemovedKeys: [],
  unexpectedRemovedKeys: [],
  unexpectedRemoved: [],
  catastrophic: false,
  historicalRegression: null,
  planId: "plan-r1-rev2",
  ok: true,
};

function formalEvidence(partial: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    id: "E001",
    claim: "RAG 可能改善事实准确性",
    verificationStatus: "verified",
    supportStrength: "partial",
    source: { sourceId: "src-1" },
    location: { chunk: "c1" },
    createdBy: "test",
    createdAt: "2026-09-18T00:00:00.000Z",
    ...partial,
  };
}

function inputOf(partial: Partial<RevisionValidationInput> = {}): RevisionValidationInput {
  return {
    projectId: "p1",
    reviewRound: 1,
    sourceRevision: 2,
    revision: 3,
    plan: appliedPlan(),
    previousFiles: [{ file: "sections/experiments.tex", content: BEFORE_TEX }],
    currentFiles: [{ file: "sections/experiments.tex", content: BEFORE_TEX }],
    factPreservation: OK_FACT,
    citationPreservation: OK_CITATION,
    evidenceRecords: [formalEvidence()],
    validatedAt: "2026-09-18T02:00:00.000Z",
    ...partial,
  };
}

describe("itemTouchesFile（文件级归因口径）", () => {
  it("路径 / 文件名 / stem / 包含；摘要引用归组装根 main.tex；(global) 不归因", () => {
    expect(itemTouchesFile("sections/experiments.tex", "sections/experiments.tex")).toBe(true);
    expect(itemTouchesFile("experiments.tex", "sections/experiments.tex")).toBe(true);
    expect(itemTouchesFile("experiments", "sections/experiments.tex")).toBe(true);
    expect(itemTouchesFile("sections/introduction.tex", "sections/experiments.tex")).toBe(false);
    expect(itemTouchesFile("摘要", "main.tex")).toBe(true);
    expect(itemTouchesFile("abstract", "main.tex")).toBe(true);
    expect(itemTouchesFile("abstract", "sections/experiments.tex")).toBe(false);
    expect(itemTouchesFile("(global)", "main.tex")).toBe(false);
    expect(itemTouchesFile("sections/experiments.tex", "main.tex")).toBe(false);
  });
});

describe("evaluateRevisionValidation", () => {
  it("干净修订：全部条目 validated，ok=true blocked=false", () => {
    const result = evaluateRevisionValidation(inputOf());
    expect(result.items).toHaveLength(1);
    expect(result.items[0]?.status).toBe("validated");
    expect(result.ok).toBe(true);
    expect(result.blocked).toBe(false);
    expect(result.validationId).toBe("val-r1-rev3");
  });

  it("fact 漂移：触达文件条目 rejected（fact_preservation_violation）", () => {
    const result = evaluateRevisionValidation(
      inputOf({
        factPreservation: {
          ...OK_FACT,
          ok: false,
          formulaChanges: [
            {
              kind: "formula",
              file: "sections/experiments.tex",
              section: "实验",
              before: "q = \\alpha r",
              after: "q = \\beta r",
              reason: "formula_changed",
            },
          ],
        },
      }),
    );
    expect(result.items[0]?.status).toBe("rejected");
    expect(result.items[0]?.reasonCodes).toContain("fact_preservation_violation");
    expect(result.items[0]?.reasons[0]).toContain("experiments.tex");
    expect(result.blocked).toBe(true);
    expect(result.ok).toBe(false);
  });

  it("引用无依据丢失：条目 rejected（citation_removal_unauthorized）+ delta 记录", () => {
    const after = BEFORE_TEX.replace(" \\cite{gao2023survey}", "");
    const result = evaluateRevisionValidation(
      inputOf({
        currentFiles: [{ file: "sections/experiments.tex", content: after }],
        citationPreservation: {
          ...OK_CITATION,
          ok: false,
          currentCount: 0,
          currentKeys: [],
          removedKeys: ["gao2023survey"],
          unexpectedRemovedKeys: ["gao2023survey"],
          unexpectedRemoved: [{ key: "gao2023survey", files: ["sections/experiments.tex"] }],
        },
      }),
    );
    expect(result.items[0]?.status).toBe("rejected");
    expect(result.items[0]?.reasonCodes).toContain("citation_removal_unauthorized");
    expect(result.citationDelta.removed.some((entry) => entry.key === "gao2023survey" && !entry.authorized)).toBe(true);
    expect(result.blocked).toBe(true);
  });

  it("claim 强度升级：block（强 claim 无证据）rejected；warning（部分证据）needs_review", () => {
    const escalated = BEFORE_TEX.replace("可能改善", "显著改善");
    const blockResult = evaluateRevisionValidation(
      inputOf({ currentFiles: [{ file: "sections/experiments.tex", content: escalated }], evidenceRecords: [] }),
    );
    expect(blockResult.items[0]?.status).toBe("rejected");
    expect(blockResult.items[0]?.reasonCodes).toContain("claim_strength_escalation");
    expect(blockResult.blocked).toBe(true);

    const warningResult = evaluateRevisionValidation(
      inputOf({ currentFiles: [{ file: "sections/experiments.tex", content: escalated }] }),
    );
    expect(warningResult.items[0]?.status).toBe("needs_review");
    expect(warningResult.blocked).toBe(false); // warning 不触发 HITL
    expect(warningResult.ok).toBe(false); // 但阻断 Final（gate revision_items_resolved）
  });

  it("Evidence 再核验：关联证据缺失 / 失锚 → needs_review（evidence_stale）", () => {
    const result = evaluateRevisionValidation(
      inputOf({ evidenceRecords: [formalEvidence({ location: {} })] }),
    );
    expect(result.items[0]?.status).toBe("needs_review");
    expect(result.items[0]?.reasonCodes).toContain("evidence_stale");
    expect(result.evidenceRecheck).toEqual([{ evidenceId: "E001", stillFormal: false }]);
    expect(result.blocked).toBe(false);
  });

  it("新增引用 evidence-backed 覆盖记录（未覆盖 → uncoveredAddedKeys）", () => {
    const after = `${BEFORE_TEX}\n相关工作另见 \\cite{lewis2020rag}。`;
    const result = evaluateRevisionValidation(
      inputOf({
        currentFiles: [{ file: "sections/experiments.tex", content: after }],
        evidenceLinks: new Map([["gao2023survey", ["E001"]]]),
      }),
    );
    expect(result.citationDelta.added).toEqual([
      { file: "sections/experiments.tex", key: "lewis2020rag", evidenceBacked: false },
    ]);
    expect(result.uncoveredAddedKeys).toEqual(["lewis2020rag"]);
  });

  it("无计划（apply 流程）：条目集为空但复核照跑；block 级 claim finding 仍 blocked", () => {
    const escalated = BEFORE_TEX.replace("可能改善", "显著改善");
    const result = evaluateRevisionValidation(
      inputOf({ plan: null, currentFiles: [{ file: "sections/experiments.tex", content: escalated }], evidenceRecords: [] }),
    );
    expect(result.items).toEqual([]);
    expect(result.claimStrength).toHaveLength(1);
    expect(result.blocked).toBe(true); // 无条目可归因，仍需人工决策
  });

  it("withUserDecision：决策记录在案（approve 后 gate 规则按用户决策解释）", () => {
    const result = evaluateRevisionValidation(
      inputOf({
        factPreservation: { ...OK_FACT, ok: false, changedFacts: [{ kind: "changed", file: "sections/experiments.tex", section: "实验", before: "45", after: "28", reason: "prose_number" }] },
      }),
    );
    expect(result.blocked).toBe(true);
    const approved = withUserDecision(result, "approve", "2026-09-18T03:00:00.000Z");
    expect(approved.userDecision).toEqual({ decision: "approve", decidedAt: "2026-09-18T03:00:00.000Z" });
    // 原结果不可变（纯函数）
    expect(result.userDecision).toBeUndefined();
  });
});
