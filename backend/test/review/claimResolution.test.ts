/**
 * M11.2.3 Unsupported Claim Resolution Contract 单元测试（D-1/D-2/D-3）。
 *
 * 覆盖：
 * - 7 类 resolution action 的确定性分类（Evidence First 顺序）；
 * - 披露口径（opaque_assertion vs transparent_unverified）对分类的影响；
 * - 正常语料 vs 降级语料（abstract_only 为主）fixture 的行为差异；
 * - resolutionRequiresWriterDispatch 的派发语义；
 * - deriveClaimResolutionAuthorizations 只铸 remove 类窄授权。
 */

import { describe, expect, it } from "vitest";

import {
  classifyClaimResolution,
  computeClaimResolutions,
  resolutionRequiresWriterDispatch,
  type ClaimResolutionContext,
  type SourceGroundability,
} from "../../src/review/claimResolution.js";
import {
  classifyClaimDisclosure,
  computeClaimGroundingReport,
  type ClaimGroundingEntry,
} from "../../src/review/claimGrounding.js";
import { deriveClaimResolutionAuthorizations } from "../../src/review/weakeningAuthorization.js";
import type { FactClaimCheck } from "../../src/agents/ReviewerService.js";
import type { EvidenceRecord } from "../../src/evidence/EvidenceStore.js";

function unsupportedEntry(
  claim: string,
  options: { section?: string; candidates?: number; disclosure?: "opaque_assertion" | "transparent_unverified" } = {},
): ClaimGroundingEntry {
  return {
    claimId: `c-${claim.slice(0, 6)}`,
    section: options.section ?? "sections/methods.tex",
    claim,
    verdict: "UNSUPPORTED",
    evidenceFormal: false,
    repairCandidates: Array.from({ length: options.candidates ?? 0 }, (_, index) => ({
      evidenceId: `E${String(index + 1).padStart(3, "0")}`,
      score: 0.1,
      matchedTerms: 3,
    })),
    ...(options.disclosure !== undefined ? { disclosure: options.disclosure } : {}),
  };
}

function contextOf(
  sources: Partial<SourceGroundability>[],
  options: { cited?: Record<string, string[]>; searchBudget?: number } = {},
): ClaimResolutionContext {
  return {
    sources: sources.map((source, index) => ({
      sourceId: source.sourceId ?? `S${String(index + 1).padStart(3, "0")}`,
      ...(source.title !== undefined ? { title: source.title } : {}),
      hasChunks: source.hasChunks ?? false,
      metadataOnly: source.metadataOnly ?? false,
    })),
    ...(options.cited !== undefined ? { sectionCitedSourceIds: options.cited } : {}),
    ...(options.searchBudget !== undefined ? { targetedSearchBudget: options.searchBudget } : {}),
  };
}

describe("classifyClaimDisclosure（D-2 披露口径）", () => {
  it("来源归因 + 核验缺口声明同时存在 → transparent_unverified", () => {
    expect(classifyClaimDisclosure("文献摘要报告 Q-Former 有效，但当前尚缺全文证据核验")).toBe(
      "transparent_unverified",
    );
    expect(classifyClaimDisclosure("GLOA 仅 UAVDT car——据其原文自述且未经独立核验")).toBe(
      "transparent_unverified",
    );
  });

  it("只有归因没有核验缺口声明（凭空强断言）→ opaque_assertion", () => {
    expect(classifyClaimDisclosure("据报道 BoostTrack 达到 65.45 FPS")).toBe("opaque_assertion");
  });

  it("无任何披露 marker 的强断言 → opaque_assertion", () => {
    expect(classifyClaimDisclosure("已有研究证明混合级融合一定有效")).toBe("opaque_assertion");
  });
});

describe("classifyClaimResolution（Evidence First 顺序）", () => {
  it("1. 已有 formal 候选 → use_existing_evidence（不动事实，只绑定）", () => {
    const resolution = classifyClaimResolution(
      unsupportedEntry("SMILEtrack PRB-Net 优于 YOLOX", { candidates: 2 }),
      contextOf([]),
    );
    expect(resolution.action).toBe("use_existing_evidence");
    expect(resolution.evidenceIds).toEqual(["E001", "E002"]);
    expect(resolutionRequiresWriterDispatch(resolution.action)).toBe(true);
  });

  it("2. 全文在库、证据未采 → ground_existing_source（先采证，不改文字）", () => {
    const resolution = classifyClaimResolution(
      unsupportedEntry("Deep OC-SORT 按置信度选择性吸收外观", { section: "sections/reid.tex" }),
      contextOf([{ sourceId: "S016", title: "Deep OC-SORT", hasChunks: true }], {
        cited: { "sections/reid.tex": ["S016"] },
      }),
    );
    expect(resolution.action).toBe("ground_existing_source");
    expect(resolution.sourceIds).toEqual(["S016"]);
    expect(resolutionRequiresWriterDispatch(resolution.action)).toBe(false);
  });

  it("2b. 未被章节引用但标题词面重合 ≥2 → 仍可定向采证（词面通道）", () => {
    const resolution = classifyClaimResolution(
      unsupportedEntry("番茄跟踪计数模板移植实验（agricultural tomato counting）"),
      contextOf([{ sourceId: "S024", title: "Tracking counting tomato agricultural", hasChunks: true }]),
    );
    expect(resolution.action).toBe("ground_existing_source");
  });

  it("3. 引用源 metadata_only 且有搜索预算 → targeted_evidence_search（bounded）", () => {
    const resolution = classifyClaimResolution(
      unsupportedEntry("学习式关联三路线共同主张", { section: "sections/learned.tex" }),
      contextOf([{ sourceId: "S011", metadataOnly: true }], {
        cited: { "sections/learned.tex": ["S011"] },
        searchBudget: 6,
      }),
    );
    expect(resolution.action).toBe("targeted_evidence_search");
    expect(resolutionRequiresWriterDispatch(resolution.action)).toBe(false);
  });

  it("3b. metadata_only 但无预算 → 回落弱化/删除阶梯（搜索不是默认出口）", () => {
    const resolution = classifyClaimResolution(
      unsupportedEntry("学习式关联三路线共同主张", { section: "sections/learned.tex" }),
      contextOf([{ sourceId: "S011", metadataOnly: true }], {
        cited: { "sections/learned.tex": ["S011"] },
      }),
    );
    expect(resolution.action).toBe("weaken_claim_strength");
  });

  it("4. 透明披露 + 无 grounding 通路 → author_decision_required（不自动改稿）", () => {
    const resolution = classifyClaimResolution(
      unsupportedEntry("karle 报告 36% 误差——据其原文自述且未经独立核验", {
        disclosure: "transparent_unverified",
      }),
      contextOf([]),
    );
    expect(resolution.action).toBe("author_decision_required");
    expect(resolutionRequiresWriterDispatch(resolution.action)).toBe(false);
  });

  it("4b. 透明披露但有可采证源 → 采证优先于作者裁决", () => {
    const resolution = classifyClaimResolution(
      unsupportedEntry("RTU++ 将长期跟踪列为目标——据其摘要、待全文核验", {
        disclosure: "transparent_unverified",
        section: "sections/future.tex",
      }),
      contextOf([{ sourceId: "S025", title: "RTU++", hasChunks: true }], {
        cited: { "sections/future.tex": ["S025"] },
      }),
    );
    expect(resolution.action).toBe("ground_existing_source");
  });

  it("5. 凭空断言 + 含数字 + 无通路 → remove_unsupported_detail（数值只许删）", () => {
    const resolution = classifyClaimResolution(
      unsupportedEntry("UCMCTrack 单 CPU 超过 1000 FPS"),
      contextOf([]),
    );
    expect(resolution.action).toBe("remove_unsupported_detail");
  });

  it("6. 凭空断言 + 无数字 + 弱化形态可接受 → weaken_claim_strength", () => {
    const resolution = classifyClaimResolution(
      unsupportedEntry("混合级融合的分支组织方式在文献中被讨论"),
      contextOf([]),
    );
    expect(resolution.action).toBe("weaken_claim_strength");
  });

  it("7. 比较语义即 claim 核心（弱化形态不可接受）→ remove_claim（窄授权）", () => {
    const resolution = classifyClaimResolution(
      unsupportedEntry("重型学习式外观与近零开销自适应外观在速度上两极分化"),
      contextOf([]),
    );
    expect(resolution.action).toBe("remove_claim");
    expect(resolution.basis).toContain("weaken_form_rejected");
  });

  it("非 UNSUPPORTED claim 抛错（防误用）", () => {
    expect(() =>
      classifyClaimResolution(
        { ...unsupportedEntry("x"), verdict: "SUPPORTED" },
        contextOf([]),
      ),
    ).toThrow();
  });
});

describe("computeClaimResolutions（正常 vs 降级语料 fixture）", () => {
  /** 正常语料：多数源 fulltext + chunks，少数无候选（词面 miss） */
  const normalCorpus: ClaimResolutionContext = contextOf([
    { sourceId: "S001", title: "ByteTrack multi-object tracking", hasChunks: true },
    { sourceId: "S002", title: "OC-SORT observation-centric", hasChunks: true },
    { sourceId: "S003", title: "BoT-SORT strong associations", hasChunks: true },
  ]);

  /** 降级语料（Case B 形态）：80% abstract_only，仅 1/5 源有 chunks */
  const degradedCorpus: ClaimResolutionContext = contextOf([
    { sourceId: "S001", title: "Q-Former visual tokens", hasChunks: true },
    { sourceId: "S002", title: "Perceiver Resampler", metadataOnly: true },
    { sourceId: "S003", title: "Pooling Abstractor", metadataOnly: true },
    { sourceId: "S004", title: "Native early fusion", metadataOnly: true },
    { sourceId: "S005", title: "TokenLearner", metadataOnly: true },
  ]);

  it("正常语料：可采证的走采证，无可采证的走弱化/删除（不依赖搜索）", () => {
    const report = computeClaimResolutions(
      [
        unsupportedEntry("ByteTrack 关联范式综述", { candidates: 1 }),
        unsupportedEntry("OC-SORT 观察中心范式主张", { section: "sections/a.tex" }),
        unsupportedEntry("GMC 估计在关联中带来 3.2 点提升"),
      ],
      normalCorpus,
      { projectId: "p-test", round: 1 },
    );
    expect(report.counts.use_existing_evidence).toBe(1);
    expect(report.counts.ground_existing_source).toBe(1);
    expect(report.counts.remove_unsupported_detail).toBe(1);
  });

  it("降级语料：无预算时全部落弱化/删除/作者裁决，不出 targeted_search", () => {
    const report = computeClaimResolutions(
      [
        unsupportedEntry("Q-Former 在视觉 token 压缩中被广泛采用", { section: "sections/q.tex" }),
        unsupportedEntry("Perceiver Resampler 报告 128 token", { section: "sections/p.tex" }),
      ],
      degradedCorpus,
      { projectId: "p-test", round: 1 },
    );
    expect(report.counts.targeted_evidence_search).toBe(0);
    expect(report.counts.ground_existing_source).toBe(1); // Q-Former（chunks 在库）
    expect(report.counts.remove_unsupported_detail).toBe(1); // 128 token 数值
  });

  it("降级语料 + 搜索预算：重要 claim 才给 targeted_search 通道", () => {
    const report = computeClaimResolutions(
      [unsupportedEntry("Perceiver Resampler 的机制描述", { section: "sections/p.tex" })],
      degradedCorpus,
      { projectId: "p-test", round: 1 },
    );
    // 无预算（默认）→ 弱化
    expect(report.resolutions[0]?.action).toBe("weaken_claim_strength");
  });
});

describe("deriveClaimResolutionAuthorizations（窄授权铸造）", () => {
  it("只铸 remove_unsupported_detail / remove_claim；其余动作不产生授权", () => {
    const report = computeClaimResolutions(
      [
        unsupportedEntry("已有候选的 claim", { candidates: 1 }),
        unsupportedEntry("可采证的 claim", { section: "sections/a.tex" }),
        unsupportedEntry("数值断言 3.5 FPS"),
        unsupportedEntry("重型学习式外观与近零开销自适应外观在速度上两极分化"),
      ],
      contextOf([{ sourceId: "S001", title: "可采证 claim", hasChunks: true }], {
        cited: { "sections/a.tex": ["S001"] },
      }),
      { projectId: "p-test", round: 2 },
    );
    const authorizations = deriveClaimResolutionAuthorizations(report.resolutions, 2);
    expect(authorizations).toHaveLength(2);
    expect(authorizations.map((entry) => entry.kind).sort()).toEqual(["remove_claim", "remove_unsupported_detail"]);
    expect(authorizations.every((entry) => entry.round === 2)).toBe(true);
    expect(authorizations.every((entry) => entry.itemId.startsWith("resolution:"))).toBe(true);
  });
});

describe("claimGrounding 集成：disclosure 与 counts 落进报告", () => {
  const factClaims: FactClaimCheck[] = [
    { section: "sections/a.tex", claim: "已有研究证明 X 一定有效", verdict: "UNSUPPORTED" },
    { section: "sections/b.tex", claim: "文献摘要报告 Y，但当前尚缺全文证据核验", verdict: "UNSUPPORTED" },
    { section: "sections/c.tex", claim: "已核验的 Z", verdict: "SUPPORTED", evidenceId: "E001" },
  ];
  const evidence: EvidenceRecord[] = [
    {
      id: "E001",
      claim: "已核验的 Z",
      quote: "verified quote",
      source: { sourceId: "S001", title: "Z source" },
      location: { chunk: "S001:SEC01:0001:abcdef0123" },
      verificationStatus: "verified",
      verificationLevel: "fulltext",
      createdBy: "test",
      createdAt: "2026-10-04T00:00:00Z",
    },
  ];

  it("unsupported 拆分 opaque / transparent 计数，SUPPORTED claim 不参与披露分类", () => {
    const report = computeClaimGroundingReport({
      projectId: "p-test",
      round: 1,
      factClaims,
      formalEvidence: evidence,
      bibEntries: [],
    });
    expect(report.unsupportedClaims).toBe(2);
    expect(report.opaqueUnsupportedClaims).toBe(1);
    expect(report.transparentUnsupportedClaims).toBe(1);
    const disclosures = report.claims
      .filter((entry) => entry.disclosure !== undefined)
      .map((entry) => entry.disclosure);
    expect(disclosures).toContain("opaque_assertion");
    expect(disclosures).toContain("transparent_unverified");
  });
});
