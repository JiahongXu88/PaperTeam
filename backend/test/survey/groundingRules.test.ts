/**
 * M11.1.2 grounding 规则矩阵测试：deriveGroundingLevel 是确定性纯函数，
 * 这里逐条锁死任务书要求的规则（LLM 无权自报 grounded；inferred 一律
 * speculative；consensus 阈值；disagreement 分级降级；gap/taxonomy 封顶）。
 */

import { describe, expect, it } from "vitest";

import { deriveGroundingLevel, type SynthesisEvidenceRef } from "../../src/survey/groundingRules.js";
import type { SynthesisDetail, SynthesisEntryTrust } from "../../src/survey/synthesisTypes.js";

function trust(entryId: string, sourceId: string, reliable: boolean): SynthesisEntryTrust {
  return {
    entryId,
    sourceId,
    interpretationDepth: reliable ? "fulltext" : "abstract_only",
    reliableAnchor: reliable,
  };
}

function evidence(id: string, sourceId: string, verified = true): SynthesisEvidenceRef {
  return { id, verified, sourceId };
}

/** 三篇 fulltext 有锚条目（S001/S002/S003；consensus 场景基线） */
const THREE_TRUSTS = [
  trust("M-S001", "S001", true),
  trust("M-S002", "S002", true),
  trust("M-S003", "S003", true),
];

describe("deriveGroundingLevel", () => {
  it("taxonomy 恒为 literature_cited（即使塞入 verified evidence 也不升级）", () => {
    const decision = deriveGroundingLevel({
      kind: "taxonomy",
      detail: { kind: "taxonomy", family: "tracking_association" },
      entryIds: ["M-S001", "M-S002"],
      entries: THREE_TRUSTS.slice(0, 2),
      evidence: [evidence("E001", "S001"), evidence("E002", "S002")],
      sourceIds: ["S001", "S002"],
    });
    expect(decision.level).toBe("literature_cited");
  });

  it("research_gap 恒为 literature_cited（不存在性论断不走 evidence 通道）", () => {
    for (const trigger of ["literature_limitation", "taxonomy_empty", "coverage_missing"] as const) {
      const decision = deriveGroundingLevel({
        kind: "research_gap",
        detail: { kind: "research_gap", trigger, basis: "依据" },
        entryIds: ["M-S001", "M-S002"],
        entries: THREE_TRUSTS.slice(0, 2),
        evidence: [evidence("E001", "S001"), evidence("E002", "S002")],
        sourceIds: ["S001", "S002"],
      });
      expect(decision.level).toBe("literature_cited");
    }
  });

  describe("future_direction", () => {
    const strongEvidence = [evidence("E001", "S001"), evidence("E002", "S002")];

    it("inferred 一律 speculative（硬规则：证据再强也不升级）", () => {
      const decision = deriveGroundingLevel({
        kind: "future_direction",
        detail: { kind: "future_direction", origin: "inferred" },
        entryIds: ["M-S001", "M-S002"],
        entries: THREE_TRUSTS.slice(0, 2),
        evidence: strongEvidence,
        sourceIds: ["S001", "S002"],
      });
      expect(decision.level).toBe("speculative");
    });

    it("cited_future_work + 2 条 verified evidence（2 来源）→ evidence_backed", () => {
      const decision = deriveGroundingLevel({
        kind: "future_direction",
        detail: { kind: "future_direction", origin: "cited_future_work" },
        entryIds: ["M-S001", "M-S002"],
        entries: THREE_TRUSTS.slice(0, 2),
        evidence: strongEvidence,
        sourceIds: ["S001", "S002"],
      });
      expect(decision.level).toBe("evidence_backed");
    });

    it("cited_future_work 但 evidence 只 1 条 → literature_cited", () => {
      const decision = deriveGroundingLevel({
        kind: "future_direction",
        detail: { kind: "future_direction", origin: "cited_future_work" },
        entryIds: ["M-S001", "M-S002"],
        entries: THREE_TRUSTS.slice(0, 2),
        evidence: [evidence("E001", "S001")],
        sourceIds: ["S001", "S002"],
      });
      expect(decision.level).toBe("literature_cited");
    });
  });

  describe("通用 evidence 阈值（trend / comparison / cited future）", () => {
    it("2 条 verified 且 2 个不同来源 → evidence_backed", () => {
      const decision = deriveGroundingLevel({
        kind: "trend",
        detail: { kind: "trend", period: "2017-2023", direction: "转向" },
        entryIds: ["M-S001", "M-S002"],
        entries: THREE_TRUSTS.slice(0, 2),
        evidence: [evidence("E001", "S001"), evidence("E002", "S002")],
        sourceIds: ["S001", "S002"],
      });
      expect(decision.level).toBe("evidence_backed");
    });

    it("2 条 verified 但同属 1 个来源 → literature_cited（单源不能撑跨论文结论）", () => {
      const decision = deriveGroundingLevel({
        kind: "trend",
        detail: { kind: "trend", period: "2017-2023", direction: "转向" },
        entryIds: ["M-S001", "M-S002"],
        entries: THREE_TRUSTS.slice(0, 2),
        evidence: [evidence("E001", "S001"), evidence("E002", "S001")],
        sourceIds: ["S001", "S002"],
      });
      expect(decision.level).toBe("literature_cited");
    });

    it("evidence.sourceId 不属于 synthesis 的 sourceIds → 不计入（归属双保险）", () => {
      const decision = deriveGroundingLevel({
        kind: "comparison",
        detail: {
          kind: "comparison",
          dimension: "appearance dependency",
          sides: [
            { label: "A", entryIds: ["M-S001"], basis: "依据" },
            { label: "B", entryIds: ["M-S002"], basis: "依据" },
          ],
        },
        entryIds: ["M-S001", "M-S002"],
        entries: THREE_TRUSTS.slice(0, 2),
        evidence: [evidence("E001", "S099"), evidence("E002", "S098")],
        sourceIds: ["S001", "S002"],
      });
      expect(decision.level).toBe("literature_cited");
    });

    it("unverified evidence 不计入阈值", () => {
      const decision = deriveGroundingLevel({
        kind: "trend",
        detail: { kind: "trend", period: "2017-2023", direction: "转向" },
        entryIds: ["M-S001", "M-S002"],
        entries: THREE_TRUSTS.slice(0, 2),
        evidence: [evidence("E001", "S001", false), evidence("E002", "S002", false)],
        sourceIds: ["S001", "S002"],
      });
      expect(decision.level).toBe("literature_cited");
    });
  });

  describe("consensus", () => {
    const consensusDetail: SynthesisDetail = { kind: "consensus", observedAgreement: false, distinctSources: 0 };

    it("3 来源 + 2 条 verified（2 来源）→ evidence_backed；detail 回填统计", () => {
      const detail: SynthesisDetail = { ...consensusDetail };
      const decision = deriveGroundingLevel({
        kind: "consensus",
        detail,
        entryIds: ["M-S001", "M-S002", "M-S003"],
        entries: THREE_TRUSTS,
        evidence: [evidence("E001", "S001"), evidence("E002", "S002")],
        sourceIds: ["S001", "S002", "S003"],
      });
      expect(decision.level).toBe("evidence_backed");
      expect(detail.kind === "consensus" && detail.distinctSources).toBe(3);
      expect(detail.kind === "consensus" && detail.observedAgreement).toBe(false);
    });

    it("恰好 2 来源 → 不是 consensus：observedAgreement=true 且封顶 literature_cited", () => {
      const detail: SynthesisDetail = { ...consensusDetail };
      const decision = deriveGroundingLevel({
        kind: "consensus",
        detail,
        entryIds: ["M-S001", "M-S002"],
        entries: THREE_TRUSTS.slice(0, 2),
        evidence: [evidence("E001", "S001"), evidence("E002", "S002")],
        sourceIds: ["S001", "S002"],
      });
      expect(decision.level).toBe("literature_cited");
      expect(detail.kind === "consensus" && detail.observedAgreement).toBe(true);
    });

    it("3 来源但零 verified evidence → literature_cited", () => {
      const decision = deriveGroundingLevel({
        kind: "consensus",
        detail: { ...consensusDetail },
        entryIds: ["M-S001", "M-S002", "M-S003"],
        entries: THREE_TRUSTS,
        evidence: [],
        sourceIds: ["S001", "S002", "S003"],
      });
      expect(decision.level).toBe("literature_cited");
    });
  });

  describe("disagreement", () => {
    const detail = (aIds: string[], bIds: string[]): SynthesisDetail => ({
      kind: "disagreement",
      issue: "外观模型是否必要",
      sideA: { label: "不必要", entryIds: aIds },
      sideB: { label: "必要", entryIds: bIds },
    });

    it("双侧可靠锚点 + 双侧各 1 条 verified → evidence_backed", () => {
      const decision = deriveGroundingLevel({
        kind: "disagreement",
        detail: detail(["M-S001"], ["M-S002"]),
        entryIds: ["M-S001", "M-S002"],
        entries: THREE_TRUSTS.slice(0, 2),
        evidence: [evidence("E001", "S001"), evidence("E002", "S002")],
        sourceIds: ["S001", "S002"],
      });
      expect(decision.level).toBe("evidence_backed");
    });

    it("单侧无可靠锚点（abstract-only 立论）→ literature_cited（不能 evidence_backed）", () => {
      const decision = deriveGroundingLevel({
        kind: "disagreement",
        detail: detail(["M-S001"], ["M-S003"]),
        entryIds: ["M-S001", "M-S003"],
        entries: [trust("M-S001", "S001", true), trust("M-S003", "S003", false)],
        evidence: [evidence("E001", "S001"), evidence("E002", "S003")],
        sourceIds: ["S001", "S003"],
      });
      expect(decision.level).toBe("literature_cited");
    });

    it("双侧都无可靠锚点 → speculative", () => {
      const decision = deriveGroundingLevel({
        kind: "disagreement",
        detail: detail(["M-S001"], ["M-S003"]),
        entryIds: ["M-S001", "M-S003"],
        entries: [trust("M-S001", "S001", false), trust("M-S003", "S003", false)],
        evidence: [],
        sourceIds: ["S001", "S003"],
      });
      expect(decision.level).toBe("speculative");
    });

    it("双侧锚点可靠但只有一侧有 verified evidence → literature_cited", () => {
      const decision = deriveGroundingLevel({
        kind: "disagreement",
        detail: detail(["M-S001"], ["M-S002"]),
        entryIds: ["M-S001", "M-S002"],
        entries: THREE_TRUSTS.slice(0, 2),
        evidence: [evidence("E001", "S001")],
        sourceIds: ["S001", "S002"],
      });
      expect(decision.level).toBe("literature_cited");
    });

    it("缺结构化 detail → 按最保守 literature_cited", () => {
      const decision = deriveGroundingLevel({
        kind: "disagreement",
        entryIds: ["M-S001", "M-S002"],
        entries: THREE_TRUSTS.slice(0, 2),
        evidence: [evidence("E001", "S001"), evidence("E002", "S002")],
        sourceIds: ["S001", "S002"],
      });
      expect(decision.level).toBe("literature_cited");
    });
  });
});
