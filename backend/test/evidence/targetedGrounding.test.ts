/**
 * M11.2.3 Targeted Evidence Grounding 单元测试（D-3 §8）。
 *
 * 覆盖：
 * - selectQuoteWindow：claim 词面覆盖最大窗口；逐字来自 chunk（非合成）；
 * - groundClaims：检索 → propose → ground 管线（fake 三段核验），第一个
 *   verified 即停（成本 bound）；无候选如实 no_candidate；
 * - judge 拒绝（rejected / mismatch）→ unverified 回落（不硬配）。
 */

import { describe, expect, it } from "vitest";

import {
  TargetedGroundingService,
  claimAnchorTokens,
  selectAnchorWindow,
  selectQuoteWindow,
  TARGETED_GROUNDING_CHUNK_LIMIT,
} from "../../src/evidence/TargetedGroundingService.js";
import type { RetrievalService } from "../../src/retrieval/RetrievalService.js";
import type { EvidenceGroundingService } from "../../src/evidence/EvidenceGroundingService.js";
import type { ProjectStore } from "../../src/project/ProjectStore.js";
import type { RetrievedChunk, RetrievalResult } from "../../src/retrieval/types.js";

function chunkOf(sourceId: string, ordinal: number, text: string): RetrievedChunk {
  return {
    chunk: {
      chunkId: `${sourceId}:SEC01:${String(ordinal).padStart(4, "0")}:${"a".repeat(10)}`,
      projectId: "p-test",
      sourceId,
      sectionId: "SEC01",
      sectionTitle: "Body",
      ordinal,
      text,
      charCount: text.length,
      tokenCount: 10,
      contentHash: "a".repeat(10),
      generatedAt: "2026-10-04T00:00:00Z",
    },
    source: { sourceId, sourceRole: "reference" as const },
    score: { fused: 0.5, lexicalRank: 1, lexicalScore: 0.5 },
    channels: ["lexical"],
  };
}

function fakeRetrieval(results: RetrievedChunk[]): RetrievalService {
  return {
    search: async (_projectId: string, query: string) =>
      ({
        mode: "lexical",
        query,
        results,
        diagnostics: { lexical: true, dense: false, suppressedAdjacent: 0, indexChunks: results.length },
      }) as RetrievalResult,
  } as unknown as RetrievalService;
}

interface GroundCall {
  sourceId: string;
  chunkId: string;
  claim: string;
  quote: string;
}

function fakeGrounding(
  outcomes: { status: "verified" | "mismatch" | "rejected" | "unverifiable"; evidenceId?: string }[],
): { service: EvidenceGroundingService; calls: GroundCall[] } {
  const calls: GroundCall[] = [];
  const service = {
    propose: async (_projectId: string, input: GroundCall) => {
      calls.push(input);
      return { candidate: { candidateId: `EC${String(calls.length).padStart(3, "0")}` }, deduplicated: false };
    },
    ground: async (_projectId: string, candidateId: string) => ({
      candidateId,
      ...(outcomes[calls.length - 1] ?? { status: "unverifiable" as const }),
    }),
  };
  return { service: service as unknown as EvidenceGroundingService, calls };
}

const projects = { getRequired: async () => ({ id: "p-test" }) } as unknown as ProjectStore;

describe("selectQuoteWindow（逐字窗口选择）", () => {
  const chunkText = [
    "This paper studies tomato counting in agriculture fields. ",
    "We transplant the tracking template to tomato scenes. ",
    "The camera calibration is described elsewhere. ",
    "Finally we report yields per hectare.",
  ].join("");

  it("选 claim 词面覆盖最大的句子窗口", () => {
    const quote = selectQuoteWindow("番茄跟踪计数模板移植到农业场景（tomato counting tracking transplant agriculture）", chunkText);
    expect(quote).not.toBeNull();
    expect(quote).toContain("tomato");
    // 逐字来自 chunk（切片非合成）
    expect(chunkText.includes(quote ?? "")).toBe(true);
  });

  it("claim 无有效 token → chunk 头部切片", () => {
    const quote = selectQuoteWindow("。。。", chunkText);
    expect(quote).toBe(chunkText.trim().slice(0, 900));
  });

  it("过短 chunk 原样返回 / 空 chunk → null", () => {
    expect(selectQuoteWindow("claim", "short")).toBe("short");
    expect(selectQuoteWindow("claim", "  ")).toBeNull();
  });
});

describe("TargetedGroundingService.groundClaims", () => {
  const claim = {
    claimId: "c-abc123",
    claim: "模板被移植到农业番茄跟踪计数场景",
    section: "sections/reid.tex",
    sourceIds: ["S024"],
  };

  it("verified：第一个 verified 即停（≤3 chunk 尝试，成本 bound）", async () => {
    const chunks = Array.from({ length: 5 }, (_, index) =>
      chunkOf("S024", index + 1, `内容 ${index}。The tracking template is transplanted to tomato counting.`),
    );
    const { service, calls } = fakeGrounding([{ status: "verified", evidenceId: "E999" }]);
    const targeted = new TargetedGroundingService({
      projects,
      retrieval: fakeRetrieval(chunks),
      evidenceGrounding: service,
    });
    const summary = await targeted.groundClaims("p-test", [claim]);
    expect(summary.verifiedClaims).toBe(1);
    expect(summary.verifiedEvidence).toBe(1);
    expect(summary.outcomes[0]?.status).toBe("verified");
    expect(summary.outcomes[0]?.evidenceIds).toEqual(["E999"]);
    expect(calls).toHaveLength(1); // verified 后不再尝试
    expect(calls[0]?.sourceId).toBe("S024");
  });

  it("chunk 尝试上限 = TARGETED_GROUNDING_CHUNK_LIMIT", async () => {
    const chunks = Array.from({ length: 6 }, (_, index) =>
      chunkOf("S024", index + 1, `内容 ${index}。unrelated filler text with no tomato.`),
    );
    const { service, calls } = fakeGrounding([
      { status: "mismatch" },
      { status: "rejected" },
      { status: "unverifiable" },
      { status: "verified", evidenceId: "E001" },
      { status: "verified", evidenceId: "E002" },
    ]);
    const targeted = new TargetedGroundingService({
      projects,
      retrieval: fakeRetrieval(chunks),
      evidenceGrounding: service,
    });
    const summary = await targeted.groundClaims("p-test", [claim]);
    expect(calls).toHaveLength(TARGETED_GROUNDING_CHUNK_LIMIT);
    expect(summary.verifiedClaims).toBe(0);
    expect(summary.outcomes[0]?.status).toBe("unverified");
    expect(summary.unsupportedByJudge).toBe(1);
  });

  it("检索无命中 → no_candidate（回落弱化/删除，不硬配）", async () => {
    const { service, calls } = fakeGrounding([]);
    const targeted = new TargetedGroundingService({
      projects,
      retrieval: fakeRetrieval([]),
      evidenceGrounding: service,
    });
    const summary = await targeted.groundClaims("p-test", [claim]);
    expect(summary.outcomes[0]?.status).toBe("no_candidate");
    expect(calls).toHaveLength(0);
  });

  /**
   * M15.8.2（D-2）：中文 claim × 英文 chunk 的跨语言锚回落——M15.8.2 P run
   * r7-r9 实证 ground_existing_source 反复派发而词面通道结构性零命中
   * （claim「…65,213 个像素掩码」↔ S025 英文摘要 "comprise 65,213 pixel masks"）。
   */
  it("词面零命中但数值/拉丁锚在目标源 chunk 中 → 锚回落候选仍走三段核验", async () => {
    const zhClaim = {
      claimId: "c-mots65213",
      claim: "MOTS 对两个已有数据集以半自动标注创建像素级稠密标注，据其报道共获得 65,213 个像素掩码",
      section: "sections/benchmark-protocols.tex",
      sourceIds: ["S025"],
    };
    const abstractText = [
      "This paper extends the popular task of multi-object tracking to multi-object tracking and segmentation (MOTS). ",
      "Towards this goal, we create dense pixel-level annotations for two existing tracking datasets using a semi-automatic annotation procedure. ",
      "Our new annotations comprise 65,213 pixel masks for 977 distinct objects (cars and pedestrians) in 10,870 video frames. ",
      "For evaluation, we extend existing multi-object tracking metrics to this new task.",
    ].join("");
    const retrieval = {
      search: async () => ({ mode: "lexical", query: "", results: [], diagnostics: { lexical: true, dense: false, suppressedAdjacent: 0, indexChunks: 0 } }),
      readSourceChunks: async () => [chunkOf("S025", 1, abstractText).chunk],
    } as unknown as RetrievalService;
    const { service, calls } = fakeGrounding([{ status: "verified", evidenceId: "E018" }]);
    const targeted = new TargetedGroundingService({ projects, retrieval, evidenceGrounding: service });
    const summary = await targeted.groundClaims("p-test", [zhClaim]);
    expect(summary.verifiedClaims).toBe(1);
    expect(summary.outcomes[0]?.status).toBe("verified");
    expect(summary.outcomes[0]?.evidenceIds).toEqual(["E018"]);
    expect(calls).toHaveLength(1);
    // quote 逐字来自 chunk 且锚句在窗口内（锚居中，非头部切片）
    expect(abstractText.includes(calls[0]?.quote ?? "~")).toBe(true);
    expect(calls[0]?.quote).toContain("65,213 pixel masks");
  });

  it("锚回落无锚可用（纯中文 claim 无数值）→ 保持 no_candidate；readSourceChunks 抛错 → 同样保持", async () => {
    const pureZh = { ...claim, claim: "该综述指出跨帧轨迹保持仍是待研究挑战" };
    const retrievalOk = {
      search: async () => ({ mode: "lexical", query: "", results: [], diagnostics: { lexical: true, dense: false, suppressedAdjacent: 0, indexChunks: 0 } }),
      readSourceChunks: async () => [chunkOf("S024", 1, "The challenge of trajectory maintenance across frames remains open.").chunk],
    } as unknown as RetrievalService;
    const a = new TargetedGroundingService({ projects, retrieval: retrievalOk, evidenceGrounding: fakeGrounding([]).service });
    expect((await a.groundClaims("p-test", [pureZh])).outcomes[0]?.status).toBe("no_candidate");
    const retrievalBroken = {
      search: async () => ({ mode: "lexical", query: "", results: [], diagnostics: { lexical: true, dense: false, suppressedAdjacent: 0, indexChunks: 0 } }),
      readSourceChunks: async () => {
        throw new Error("chunk store down");
      },
    } as unknown as RetrievalService;
    const b = new TargetedGroundingService({ projects, retrieval: retrievalBroken, evidenceGrounding: fakeGrounding([]).service });
    const out = await b.groundClaims("p-test", [{ ...claim, claim: "MOTS 共获得 65,213 个像素掩码" }]);
    expect(out.outcomes[0]?.status).toBe("no_candidate");
  });

  it("claimAnchorTokens：千分位/小数与 ≥5 位数值进锚，裸年份不进；拉丁 ≥3 字符", () => {
    expect(claimAnchorTokens("MOTS 报道共获得 65,213 个像素掩码，HOTA 为 0.801，2024 年发表")).toEqual({
      numbers: ["65,213", "0.801"],
      latin: ["MOTS", "HOTA"],
    });
    expect(claimAnchorTokens("纯中文论断，没有任何锚")).toEqual({ numbers: [], latin: [] });
  });

  it("selectAnchorWindow：锚居中窗口包含锚句且逐字来自 chunk；无锚命中 → null", () => {
    const filler = "Unrelated introduction sentences about the survey scope and motivation. ".repeat(30);
    const text = `${filler}Our new annotations comprise 65,213 pixel masks for 977 distinct objects. Concluding remarks follow here.`;
    const window = selectAnchorWindow("据其报道共获得 65,213 个像素掩码", text);
    expect(window).not.toBeNull();
    expect(window).toContain("65,213 pixel masks");
    expect(text.includes(window ?? "~")).toBe(true);
    expect(window!.length).toBeLessThanOrEqual(2000);
    expect(selectAnchorWindow("无锚论断", "Any text without matches.")).toBeNull();
  });

  it("空 sourceIds → no_candidate", async () => {
    const targeted = new TargetedGroundingService({
      projects,
      retrieval: fakeRetrieval([]),
      evidenceGrounding: fakeGrounding([]).service,
    });
    const summary = await targeted.groundClaims("p-test", [{ ...claim, sourceIds: [] }]);
    expect(summary.outcomes[0]?.status).toBe("no_candidate");
  });

  it("检索抛错 → failed（单 claim 失败不阻断批次）", async () => {
    const retrieval = {
      search: async () => {
        throw new Error("boom");
      },
    } as unknown as RetrievalService;
    const targeted = new TargetedGroundingService({
      projects,
      retrieval,
      evidenceGrounding: fakeGrounding([]).service,
    });
    const summary = await targeted.groundClaims("p-test", [claim]);
    expect(summary.outcomes[0]?.status).toBe("failed");
    expect(summary.outcomes[0]?.reason).toContain("检索失败");
  });

  it("quote 逐字性：propose 收到的 quote 必须是 chunk 文本的子串", async () => {
    const text = "The tracking template is transplanted to agricultural tomato counting scenarios with calibration.";
    const { service, calls } = fakeGrounding([{ status: "verified", evidenceId: "E001" }]);
    const targeted = new TargetedGroundingService({
      projects,
      retrieval: fakeRetrieval([chunkOf("S024", 1, text)]),
      evidenceGrounding: service,
    });
    await targeted.groundClaims("p-test", [claim]);
    expect(calls[0]?.quote.length ?? 0).toBeGreaterThan(0);
    expect(text.includes(calls[0]?.quote ?? "~")).toBe(true);
  });
});
