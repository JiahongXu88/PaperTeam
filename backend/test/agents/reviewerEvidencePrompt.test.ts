/**
 * Reviewer Evidence-aware prompt 测试（M6.6 §7）：
 * - fact 模式：evidence_query / get_chunk 主动核验指引 + verified 才可作 SUPPORTED 依据
 * - 无 verified evidence 时行为正确（UNSUPPORTED 口径 + 查询提示）
 * - academic / style 模式不携带 fact 工具指引
 */

import { describe, expect, it } from "vitest";

import { buildReviewPrompt } from "../../src/agents/ReviewerService.js";
import type { EvidenceRecord } from "../../src/evidence/EvidenceStore.js";

const FORMAL_EVIDENCE: EvidenceRecord = {
  id: "E001",
  claim: "RAG 降低幻觉率",
  verificationStatus: "verified",
  supportStrength: "direct",
  source: { sourceId: "S001", title: "A Survey of Retrieval-Augmented Generation", year: 2023 },
  location: { chunk: "S001:SEC01:0001:a1b2c3d4e5", section: "Introduction", page: 3 },
  createdBy: "researcher",
  createdAt: "2026-09-17T00:00:00Z",
};

describe("buildReviewPrompt M6.6：Evidence-aware Reviewer", () => {
  it("fact 模式：包含 evidence_query / get_chunk 主动查询指引与 verified 判定口径", () => {
    const prompt = buildReviewPrompt({
      projectId: "p-abc",
      mode: "fact",
      manuscriptDigest: "[main.tex]\n…",
      evidence: [FORMAL_EVIDENCE],
    });
    expect(prompt).toContain("evidence_query");
    expect(prompt).toContain("get_chunk");
    expect(prompt).toContain("claimContains");
    expect(prompt).toContain("只有 verificationStatus=verified");
    // digest 行带 chunk 锚点（可用 get_chunk 回查）
    expect(prompt).toContain("chunk: S001:SEC01:0001:a1b2c3d4e5");
  });

  it("fact 模式：无 verified evidence 时口径正确（强论断 UNSUPPORTED + 查询确认）", () => {
    const prompt = buildReviewPrompt({
      projectId: "p-abc",
      mode: "fact",
      manuscriptDigest: "[main.tex]\n…",
      evidence: [],
    });
    expect(prompt).toContain("无已核验（verified）Evidence");
    expect(prompt).toContain("UNSUPPORTED");
    expect(prompt).toContain("evidence_query");
  });

  it("academic / style 模式：不携带 fact 工具指引（各 mode 职责不混淆）", () => {
    for (const mode of ["academic", "style"] as const) {
      const prompt = buildReviewPrompt({
        projectId: "p-abc",
        mode,
        manuscriptDigest: "[main.tex]\n…",
        evidence: [FORMAL_EVIDENCE],
      });
      expect(prompt).not.toContain("claimContains");
      // Evidence 快照仍注入（academic 评审可见证据基础），但不带 fact 判定口径
      expect(prompt).toContain("[E001]");
    }
  });
});
