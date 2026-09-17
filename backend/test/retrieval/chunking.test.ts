/**
 * M6.4 chunking 纯函数测试：section 边界 / 段落切分 / 超长兜底 / overlap /
 * 稳定 ID / page mapping / 空输入 / 配置校验。
 */

import { describe, expect, it } from "vitest";

import {
  buildSourceChunks,
  shortContentHash,
  splitParagraphs,
  splitSentences,
  tailOverlap,
  validateChunkOptions,
  type ResolvedSection,
} from "../../src/retrieval/chunking.js";
import { estimateTextTokens } from "../../src/runtime/pi/contextBudget.js";

const FIXED_NOW = () => new Date("2026-09-17T00:00:00Z");
const OPTIONS = { targetTokens: 60, maxTokens: 90, overlapTokens: 15 };

function paragraph(index: number, words: number, prefix = "method"): string {
  return `${prefix} paragraph ${index} ` + Array.from({ length: words }, (_, i) => `token${index}_${i}`).join(" ") + ".";
}

describe("M6.4 chunking：section 边界与结构", () => {
  it("不跨 section：Abstract 与 Introduction 不拼接进同一 chunk", () => {
    const sections: ResolvedSection[] = [
      { sectionId: "SEC01", title: "Abstract", level: 1, units: [{ text: "Abstract body alpha beta gamma." }] },
      { sectionId: "SEC02", title: "Introduction", level: 1, units: [{ text: "Introduction body delta epsilon zeta." }] },
    ];
    const { chunks } = buildSourceChunks({
      projectId: "p1",
      sourceId: "S001",
      sections,
      options: OPTIONS,
      now: FIXED_NOW,
    });
    expect(chunks.length).toBe(2);
    expect(chunks[0]!.sectionId).toBe("SEC01");
    expect(chunks[0]!.sectionTitle).toBe("Abstract");
    expect(chunks[0]!.text).toContain("Abstract body");
    expect(chunks[1]!.sectionId).toBe("SEC02");
    expect(chunks[1]!.text).toContain("Introduction body");
    expect(chunks[0]!.text).not.toContain("Introduction");
  });

  it("level≥2 的 section 记 subsection", () => {
    const sections: ResolvedSection[] = [
      { sectionId: "SEC03", title: "Ablation Study", level: 2, units: [{ text: "ablation content here." }] },
    ];
    const { chunks } = buildSourceChunks({
      projectId: "p1",
      sourceId: "S001",
      sections,
      options: OPTIONS,
      now: FIXED_NOW,
    });
    expect(chunks[0]!.subsection).toBe("Ablation Study");
  });

  it("page provenance：pageStart/pageEnd 来自 unit 页码", () => {
    const sections: ResolvedSection[] = [
      {
        sectionId: "SEC01",
        title: "Method",
        level: 1,
        units: [
          { text: paragraph(1, 10), page: 4 },
          { text: paragraph(2, 10), page: 5 },
        ],
      },
    ];
    const { chunks } = buildSourceChunks({
      projectId: "p1",
      sourceId: "S001",
      sections,
      options: OPTIONS,
      now: FIXED_NOW,
    });
    expect(chunks.length).toBeGreaterThanOrEqual(1);
    expect(chunks[0]!.pageStart).toBe(4);
    // 同 chunk 跨页时 pageEnd 记尾页
    if (chunks.length === 1) {
      expect(chunks[0]!.pageEnd).toBe(5);
    }
  });

  it("无页码输入 → pageStart/pageEnd 缺省（不伪造）", () => {
    const sections: ResolvedSection[] = [
      { sectionId: "SEC01", title: "Whole Document", level: 1, units: [{ text: paragraph(1, 8) }] },
    ];
    const { chunks } = buildSourceChunks({
      projectId: "p1",
      sourceId: "S001",
      sections,
      options: OPTIONS,
      now: FIXED_NOW,
    });
    expect(chunks[0]!.pageStart).toBeUndefined();
    expect(chunks[0]!.pageEnd).toBeUndefined();
  });
});

describe("M6.4 chunking：大小预算 / 超长兜底 / overlap", () => {
  it("段落聚合到 target 附近；单 chunk 不超 max", () => {
    const units = Array.from({ length: 12 }, (_, i) => ({ text: paragraph(i + 1, 20) }));
    const sections: ResolvedSection[] = [
      { sectionId: "SEC01", title: "Method", level: 1, units },
    ];
    const { chunks } = buildSourceChunks({
      projectId: "p1",
      sourceId: "S001",
      sections,
      options: OPTIONS,
      now: FIXED_NOW,
    });
    expect(chunks.length).toBeGreaterThan(2);
    for (const chunk of chunks) {
      // overlap 携带可能略超 max——上限是 max + overlap 预算（见 tailOverlap 注释）
      expect(chunk.tokenCount).toBeLessThanOrEqual(OPTIONS.maxTokens + OPTIONS.overlapTokens + 5);
    }
  });

  it("超长单元（单段落 > max）→ 句子窗口切分", () => {
    const longSentence = Array.from({ length: 200 }, (_, i) => `word${i}`).join(" ") + ".";
    const longParagraph = longSentence + " " + longSentence;
    const sections: ResolvedSection[] = [
      { sectionId: "SEC01", title: "Method", level: 1, units: [{ text: longParagraph }] },
    ];
    const { chunks } = buildSourceChunks({
      projectId: "p1",
      sourceId: "S001",
      sections,
      options: OPTIONS,
      now: FIXED_NOW,
    });
    expect(chunks.length).toBeGreaterThan(1);
    // 拼接后内容完整（overlap 重复允许，但不得丢正文）
    const joined = chunks.map((chunk) => chunk.text).join("\n\n");
    expect(joined).toContain("word0");
    expect(joined).toContain("word199");
  });

  it("同节相邻 chunk 带尾部 overlap（下一 chunk 以上一 chunk 尾句开头）", () => {
    const units = Array.from({ length: 10 }, (_, i) => ({ text: paragraph(i + 1, 30) }));
    const sections: ResolvedSection[] = [
      { sectionId: "SEC01", title: "Experiments", level: 1, units },
    ];
    const { chunks } = buildSourceChunks({
      projectId: "p1",
      sourceId: "S001",
      sections,
      options: OPTIONS,
      now: FIXED_NOW,
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i += 1) {
      const previous = chunks[i - 1]!;
      const current = chunks[i]!;
      expect(current.sectionId).toBe(previous.sectionId);
      // current 的首段（overlap carry）必须是 previous 尾部的逐字子串
      const probe = (current.text.split("\n\n")[0] ?? "").trim();
      expect(probe).not.toBe("");
      expect(previous.text.includes(probe)).toBe(true);
    }
  });

  it("overlap=0 → 相邻 chunk 无重叠", () => {
    const units = Array.from({ length: 8 }, (_, i) => ({ text: paragraph(i + 1, 30) }));
    const sections: ResolvedSection[] = [
      { sectionId: "SEC01", title: "Experiments", level: 1, units },
    ];
    const { chunks } = buildSourceChunks({
      projectId: "p1",
      sourceId: "S001",
      sections,
      options: { targetTokens: 60, maxTokens: 90, overlapTokens: 0 },
      now: FIXED_NOW,
    });
    expect(chunks.length).toBeGreaterThan(1);
    for (let i = 1; i < chunks.length; i += 1) {
      const previousTail = splitSentences(chunks[i - 1]!.text).pop() ?? "";
      expect(chunks[i]!.text.startsWith(previousTail)).toBe(false);
    }
  });
});

describe("M6.4 chunking：稳定 chunk ID（D-0036）", () => {
  const sectionsOf = (extra = false): ResolvedSection[] => [
    { sectionId: "SEC01", title: "Method", level: 1, units: [{ text: paragraph(1, 30) }, { text: paragraph(2, 30) }] },
    { sectionId: "SEC02", title: "Experiments", level: 1, units: [{ text: paragraph(3, 30, "experiment") }, { text: paragraph(4, 30, "experiment") }] },
    ...(extra ? [{ sectionId: "SEC03", title: "Conclusion", level: 1, units: [{ text: paragraph(9, 20, "conclusion") }] }] : []),
  ];
  const build = (secs: ResolvedSection[]) =>
    buildSourceChunks({ projectId: "p1", sourceId: "S001", sections: secs, options: OPTIONS, now: FIXED_NOW }).chunks;

  it("同内容 rebuild → chunkId 逐字节一致（generatedAt 固定）", () => {
    expect(build(sectionsOf())).toEqual(build(sectionsOf()));
  });

  it("chunkId 组成：sourceId:sectionId:节内序号:内容hash10", () => {
    const chunks = build(sectionsOf());
    const chunk = chunks[0]!;
    expect(chunk.chunkId).toMatch(/^S001:SEC01:0001:[0-9a-f]{10}$/);
    expect(chunk.chunkId.endsWith(shortContentHash(chunk.text))).toBe(true);
  });

  it("某节内容变化 → 只有该节 chunkId 变化，其他节不变", () => {
    const before = build(sectionsOf());
    // SEC02 增加一个段落（30 词段落 > target 60 token → 独立成 chunk）
    const changed = build([
      sectionsOf()[0]!,
      {
        sectionId: "SEC02",
        title: "Experiments",
        level: 1,
        units: [
          { text: paragraph(3, 30, "experiment") },
          { text: paragraph(4, 30, "experiment") },
          { text: paragraph(5, 30, "experiment") },
        ],
      },
    ]);
    const idsOf = (chunks: ReturnType<typeof build>, sectionId: string) =>
      chunks.filter((chunk) => chunk.sectionId === sectionId).map((chunk) => chunk.chunkId);
    expect(idsOf(changed, "SEC01")).toEqual(idsOf(before, "SEC01"));
    expect(idsOf(changed, "SEC02").length).toBeGreaterThan(idsOf(before, "SEC02").length);
  });

  it("前置章节增删 chunk 不影响后续章节 chunkId（节内序号局部性）", () => {
    const before = build(sectionsOf());
    const after = build(sectionsOf(true));
    const find = (chunks: ReturnType<typeof build>, sectionId: string) =>
      chunks.filter((chunk) => chunk.sectionId === sectionId).map((chunk) => chunk.chunkId);
    expect(find(after, "SEC01")).toEqual(find(before, "SEC01"));
    expect(find(after, "SEC02")).toEqual(find(before, "SEC02"));
  });
});

describe("M6.4 chunking：空输入与配置", () => {
  it("空 section / 全空 → 0 chunks", () => {
    const { chunks } = buildSourceChunks({
      projectId: "p1",
      sourceId: "S001",
      sections: [{ sectionId: "SEC01", title: "Empty", level: 1, units: [{ text: "   " }] }],
      options: OPTIONS,
      now: FIXED_NOW,
    });
    expect(chunks).toEqual([]);
  });

  it("非法配置被拒绝", () => {
    expect(() => validateChunkOptions({ targetTokens: 30, maxTokens: 600, overlapTokens: 60 })).toThrow();
    expect(() => validateChunkOptions({ targetTokens: 100, maxTokens: 40, overlapTokens: 10 })).toThrow();
    expect(() => validateChunkOptions({ targetTokens: 400, maxTokens: 300, overlapTokens: 60 })).toThrow();
    expect(() => validateChunkOptions({ targetTokens: 400, maxTokens: 600, overlapTokens: 400 })).toThrow();
    expect(() => validateChunkOptions({ targetTokens: 400, maxTokens: 600, overlapTokens: 60 })).not.toThrow();
  });

  it("tokenCount 与 estimateTextTokens 同口径", () => {
    const { chunks } = buildSourceChunks({
      projectId: "p1",
      sourceId: "S001",
      sections: [{ sectionId: "SEC01", title: "M", level: 1, units: [{ text: "中文内容测试。" }] }],
      options: OPTIONS,
      now: FIXED_NOW,
    });
    expect(chunks[0]!.tokenCount).toBe(estimateTextTokens(chunks[0]!.text));
  });
});

describe("M6.4 chunking：切分辅助", () => {
  it("splitParagraphs：空行分段，退化按行", () => {
    expect(splitParagraphs("a\n\nb")).toEqual(["a", "b"]);
    expect(splitParagraphs("a\nb")).toEqual(["a", "b"]);
    expect(splitParagraphs("  \n\n  ")).toEqual([]);
  });

  it("splitSentences：中英终点标点", () => {
    expect(splitSentences("First sentence. Second one! 第三句。")).toEqual([
      "First sentence.",
      "Second one!",
      "第三句。",
    ]);
  });

  it("tailOverlap：尾部句子对齐且不超预算（句子级）", () => {
    const text = "Sentence one about alpha. Sentence two about beta. Sentence three about gamma.";
    const overlap = tailOverlap(text, 10);
    expect(overlap).toContain("gamma");
    expect(estimateTextTokens(overlap)).toBeLessThanOrEqual(30);
  });
});
