/**
 * M6.4 ContextBudgetPacker 测试：token 预算 / 邻近冗余 / 来源多样性 /
 * source 限定查询不过度多样化 / 引用标记。
 */

import { describe, expect, it } from "vitest";

import {
  chunkCitationMarker,
  packRetrievalContext,
} from "../../src/retrieval/contextPacker.js";
import { estimateTextTokens } from "../../src/runtime/pi/contextBudget.js";
import type { RetrievedChunk, SourceChunk } from "../../src/retrieval/types.js";

function chunk(params: {
  sourceId: string;
  ordinal: number;
  sectionId?: string;
  text: string;
  pageStart?: number;
  pageEnd?: number;
}): SourceChunk {
  return {
    chunkId: `${params.sourceId}:${params.sectionId ?? "SEC01"}:${String(params.ordinal).padStart(4, "0")}:hash${params.ordinal}`,
    projectId: "p1",
    sourceId: params.sourceId,
    sectionId: params.sectionId ?? "SEC01",
    sectionTitle: "Method",
    ...(params.pageStart !== undefined
      ? { pageStart: params.pageStart, ...(params.pageEnd !== undefined ? { pageEnd: params.pageEnd } : {}) }
      : {}),
    ordinal: params.ordinal,
    text: params.text,
    charCount: params.text.length,
    tokenCount: estimateTextTokens(params.text),
    contentHash: "x".repeat(10),
    generatedAt: "2026-09-17T00:00:00Z",
  };
}

function retrieved(sourceChunk: SourceChunk, rank: number): RetrievedChunk {
  return {
    chunk: sourceChunk,
    source: { sourceId: sourceChunk.sourceId, sourceRole: "both" },
    score: { fused: 1 / (60 + rank) },
    channels: ["lexical"],
  };
}

/** 生成 ~N token 的确定性文本 */
function textOfTokens(approxTokens: number, tag: string): string {
  const words: string[] = [];
  let tokens = 0;
  let i = 0;
  while (tokens < approxTokens) {
    const word = `${tag}word${i}`;
    words.push(word);
    tokens += Math.ceil((word.length + 1) / 4);
    i += 1;
  }
  return words.join(" ") + ".";
}

describe("M6.4 ContextBudgetPacker", () => {
  it("token 预算：超预算的 chunk 被跳过，总量不超预算", () => {
    const results = [
      retrieved(chunk({ sourceId: "S001", ordinal: 1, text: textOfTokens(200, "a") }), 1),
      retrieved(chunk({ sourceId: "S002", ordinal: 5, text: textOfTokens(200, "b") }), 2),
      retrieved(chunk({ sourceId: "S003", ordinal: 9, text: textOfTokens(200, "c") }), 3),
    ];
    const packed = packRetrievalContext(results, { budgetTokens: 500, sourceScoped: false });
    expect(packed.included.length).toBe(2);
    expect(packed.usedTokens).toBeLessThanOrEqual(500);
    expect(packed.excluded.budget).toBe(1);
  });

  it("邻近冗余：已入选 chunk 的直接相邻 ordinal 被跳过；隔位的不受影响", () => {
    const results = [
      retrieved(chunk({ sourceId: "S001", ordinal: 1, text: "first chunk text" }), 1),
      retrieved(chunk({ sourceId: "S001", ordinal: 2, text: "second chunk text" }), 2),
      retrieved(chunk({ sourceId: "S001", ordinal: 3, text: "third chunk text" }), 3),
    ];
    const packed = packRetrievalContext(results, { budgetTokens: 6000, sourceScoped: true });
    expect(packed.included.map((entry) => entry.chunk.ordinal)).toEqual([1, 3]);
    expect(packed.excluded.adjacent).toBe(1);
  });

  it("同 source 不同 section 的相邻 ordinal 不算冗余", () => {
    const results = [
      retrieved(chunk({ sourceId: "S001", ordinal: 1, sectionId: "SEC01", text: "intro text" }), 1),
      retrieved(chunk({ sourceId: "S001", ordinal: 2, sectionId: "SEC02", text: "method text" }), 2),
    ];
    const packed = packRetrievalContext(results, { budgetTokens: 6000, sourceScoped: true });
    expect(packed.included.length).toBe(2);
  });

  it("来源多样性：单 source 不吞掉全部预算（未限定 source 时）", () => {
    const results = Array.from({ length: 8 }, (_, i) =>
      retrieved(chunk({ sourceId: "S001", ordinal: i * 3 + 1, sectionId: `SEC${i + 1}`, text: `chunk ${i}` }), i + 1),
    ).concat([
      retrieved(chunk({ sourceId: "S002", ordinal: 1, sectionId: "SEC01", text: "other source" }), 9),
    ]);
    const packed = packRetrievalContext(results, { budgetTokens: 6000, sourceScoped: false });
    const fromS001 = packed.included.filter((entry) => entry.chunk.sourceId === "S001").length;
    // 允许占多数，但 S002（最低排名）也能入选——前 8 个全占会被多样性挡下
    expect(packed.included.some((entry) => entry.chunk.sourceId === "S002")).toBe(true);
    expect(fromS001).toBeLessThan(8);
  });

  it("source 限定查询（sourceScoped）不做来源多样化", () => {
    const results = Array.from({ length: 6 }, (_, i) =>
      retrieved(chunk({ sourceId: "S001", ordinal: i * 3 + 1, sectionId: `SEC${i + 1}`, text: `scoped ${i}` }), i + 1),
    );
    const packed = packRetrievalContext(results, { budgetTokens: 6000, sourceScoped: true });
    expect(packed.included.length).toBe(6);
  });

  it("引用标记：SRC / CHUNK / SECTION / PAGE 稳定格式", () => {
    const c = chunk({ sourceId: "S003", ordinal: 2, sectionId: "SEC02", text: "x", pageStart: 4, pageEnd: 5 });
    const marker = chunkCitationMarker(c);
    expect(marker).toBe("[SRC:S003 CHUNK:S003:SEC02:0002:hash2 SECTION:Method PAGE:4-5]");
    const single = chunkCitationMarker(chunk({ sourceId: "S003", ordinal: 1, text: "x", pageStart: 7, pageEnd: 7 }));
    expect(single).toContain("PAGE:7");
    const noPage = chunkCitationMarker(chunk({ sourceId: "S003", ordinal: 1, text: "x" }));
    expect(noPage).not.toContain("PAGE");
  });

  it("打包文本包含标记行与原文", () => {
    const results = [retrieved(chunk({ sourceId: "S001", ordinal: 1, text: "the actual passage text" }), 1)];
    const packed = packRetrievalContext(results, { budgetTokens: 6000, sourceScoped: false });
    expect(packed.text).toContain("[SRC:S001 CHUNK:S001:SEC01:0001:hash1");
    expect(packed.text).toContain("the actual passage text");
  });

  it("空输入 → 空文本零预算", () => {
    const packed = packRetrievalContext([], { budgetTokens: 6000, sourceScoped: false });
    expect(packed.text).toBe("");
    expect(packed.included).toEqual([]);
    expect(packed.usedTokens).toBe(0);
  });
});
