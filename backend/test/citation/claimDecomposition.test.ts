/**
 * Atomic Claim 拆解层（claimDecomposition）纯函数测试：
 * 句子归组 / 拆解触发条件 / marker 标注 / 论断清洗（PDF 残留）/ 模型输出
 * 解析的防御（未知 marker、空绑定、未绑定组、残片）/ 确定性兜底。
 */

import { describe, expect, it } from "vitest";

import {
  buildDecompositionPrompt,
  calloutRawText,
  cleanClaimText,
  fallbackPlan,
  groupCalloutsBySentence,
  needsDecomposition,
  parseDecompositionSentence,
  tagMarkers,
  type SentenceCalloutGroup,
} from "../../src/citation/claimDecomposition.js";
import type { CitationCallout } from "../../src/citation/integrity.js";

function callout(
  id: string,
  rawText: string,
  labels: string[],
  sentence: string,
  referenceId?: string,
): CitationCallout {
  return {
    citationId: id,
    style: "numeric",
    references: labels.map((label, index) => ({
      label,
      ...(referenceId !== undefined ? { referenceId: `${referenceId}-${index}` } : {}),
      status: referenceId !== undefined ? ("resolved" as const) : ("unresolved" as const),
    })),
    rawText,
    page: 1,
    sectionId: "SEC01",
    chunkId: "C0001",
    sentence,
  };
}

const SENTENCE =
  "Architecture A [1] and architecture B [2] are established approaches in sequence modeling such as language modeling and machine translation [3, 4, 5].";

describe("groupCalloutsBySentence：同一句的多个标记归入一组", () => {
  it("句内三个 callout（[1] / [2] / [3,4,5]）→ 一个句子组、三个 citation group", () => {
    const groups = groupCalloutsBySentence([
      callout("CT001", "[1]", ["1"], SENTENCE),
      callout("CT002", "[2]", ["2"], SENTENCE),
      callout("CT003", "[3, 4, 5]", ["3", "4", "5"], SENTENCE),
    ]);
    expect(groups).toHaveLength(1);
    expect(groups[0]!.groups.map((callout) => callout.citationId)).toEqual(["CT001", "CT002", "CT003"]);
    // sentenceKey 稳定且文件名安全（字母开头，仅 [A-Za-z0-9_-]）
    expect(groups[0]!.sentenceKey).toMatch(/^S[A-Za-z0-9_-]+$/);
  });

  it("不同句子 / 不同 chunk 不合并；空白归一后同句合并", () => {
    const groups = groupCalloutsBySentence([
      callout("CT001", "[1]", ["1"], SENTENCE),
      callout("CT002", "[1]", ["1"], SENTENCE.replace(/\s+/g, " "), undefined),
      callout("CT003", "[2]", ["2"], "Different sentence [2]."),
      callout("CT004", "[3]", ["3"], SENTENCE, "R"),
    ]);
    // CT001 与 CT002 句子归一后相同 → 同组；CT004 也同句；CT003 独立
    expect(groups).toHaveLength(2);
  });

  it("calloutRawText：新记录用 rawText；旧记录（无字段）按 labels 重建", () => {
    expect(calloutRawText(callout("CT001", "[3, 4, 5]", ["3", "4", "5"], SENTENCE))).toBe("[3, 4, 5]");
    const legacy = callout("CT001", "", ["7"], SENTENCE);
    const withoutRaw: CitationCallout = { ...legacy, rawText: undefined };
    expect(calloutRawText(withoutRaw)).toBe("[7]");
  });
});

describe("needsDecomposition：确定性触发（成本有界）", () => {
  it("单组短句不拆；多组 / 长句 / 复合连接词拆", () => {
    expect(needsDecomposition("Simple sentence with one citation.", 1)).toBe(false);
    expect(needsDecomposition("Short [1] but two groups [2].", 2)).toBe(true);
    expect(needsDecomposition(`${"A very long sentence about methods. ".repeat(5)}[1].`, 1)).toBe(true);
    expect(needsDecomposition("Claim A, and claim B follows [1].", 1)).toBe(true);
    expect(needsDecomposition("Claim A；claim B [1].", 1)).toBe(true);
  });
});

describe("tagMarkers + cleanClaimText", () => {
  const group: SentenceCalloutGroup = {
    sentenceKey: "S1",
    sentence: SENTENCE,
    chunkId: "C0001",
    sectionId: "SEC01",
    page: 1,
    groups: [
      callout("CT001", "[1]", ["1"], SENTENCE),
      callout("CT003", "[3, 4, 5]", ["3", "4", "5"], SENTENCE),
    ],
  };

  it("tagMarkers：标记替换为无歧义 token", () => {
    const tagged = tagMarkers(group);
    expect(tagged).toContain("⟦CT001⟧");
    expect(tagged).toContain("⟦CT003⟧");
    expect(tagged).not.toContain("[3, 4, 5]");
  });

  it("cleanClaimText：去 token / 数字标记；剥 PDF 行首残留（arXiv 水印尾巴、章节号）；压空白", () => {
    expect(cleanClaimText("Architecture A ⟦CT001⟧ is strong [3, 4, 5].")).toBe("Architecture A is strong.");
    expect(cleanClaimText("CL] 2 Aug 2023 1 Introduction Recurrent networks are widely used.")).toBe(
      "Introduction Recurrent networks are widely used.",
    );
    expect(cleanClaimText("3.2 Experimental Setup  We train models.")).toBe("Experimental Setup We train models.");
    expect(cleanClaimText("  Multiple   spaces\tand\nnewlines  ")).toBe("Multiple spaces and newlines");
    expect(cleanClaimText("x".repeat(500)).length).toBeLessThanOrEqual(400);
  });
});

describe("parseDecompositionSentence：模型输出防御", () => {
  const group: SentenceCalloutGroup = {
    sentenceKey: "S1",
    sentence: SENTENCE,
    chunkId: "C0001",
    sectionId: "SEC01",
    page: 1,
    groups: [
      callout("CT001", "[1]", ["1"], SENTENCE),
      callout("CT003", "[3, 4, 5]", ["3", "4", "5"], SENTENCE),
    ],
  };

  it("合法输出：marker 绑定保留；未知 marker 过滤；空绑定保持为空（预告性论断不继承标记）", () => {
    const claims = parseDecompositionSentence(
      {
        claims: [
          { text: "Architecture A is established for sequence modeling.", markers: ["CT001", "CT999"] },
          { text: "Both architectures are used in machine translation.", markers: [] },
        ],
      },
      group,
    );
    expect(claims).not.toBeNull();
    // CT999 不在句内 → 过滤；CT003 未被任何论断绑定 → 补绑到最后一条已绑定论断
    expect(claims![0]!.citationIds).toEqual(["CT001", "CT003"]);
    expect(claims![1]!.citationIds).toEqual([]); // 空绑定 = 不需要引用支撑（预告性表述）
    expect(claims!.map((claim) => claim.claimIndex)).toEqual([1, 2]);
  });

  it("未绑定的组补绑到最后一条已绑定论断（组不能凭空消失）", () => {
    const claims = parseDecompositionSentence(
      {
        claims: [
          { text: "In the following sections, we will describe system Z.", markers: [] },
          { text: "System Z outperforms the cited prior models.", markers: ["CT001"] },
        ],
      },
      group,
    );
    expect(claims![0]!.citationIds).toEqual([]); // 预告性论断保持未绑定
    expect(claims![1]!.citationIds).toEqual(["CT001", "CT003"]); // 未覆盖的组补绑到这里
  });

  it("整句预告性表述：claims 空数组 = 合法结果（零记录），不是解析失败", () => {
    expect(parseDecompositionSentence({ claims: [] }, group)).toEqual([]);
  });

  it("全部论断未绑定（纯预告句）：组无处补绑，保持空绑定（该句零记录）", () => {
    const claims = parseDecompositionSentence(
      { claims: [{ text: "In the following sections, we will describe system Z.", markers: [] }] },
      group,
    );
    expect(claims![0]!.citationIds).toEqual([]);
  });

  it("残片 / 超量 / 结构损坏 → null（整句走确定性兜底）", () => {
    expect(parseDecompositionSentence({ claims: [{ text: "Tiny.", markers: ["CT001"] }] }, group)).toBeNull();
    expect(
      parseDecompositionSentence(
        { claims: Array.from({ length: 7 }, (_, i) => ({ text: `Claim number ${i} is long enough here.`, markers: ["CT001"] })) },
        group,
      ),
    ).toBeNull();
    expect(parseDecompositionSentence("garbage", group)).toBeNull();
    expect(parseDecompositionSentence(undefined, group)).toBeNull();
  });
});

describe("fallbackPlan + buildDecompositionPrompt", () => {
  const group: SentenceCalloutGroup = {
    sentenceKey: "S1",
    sentence: SENTENCE,
    chunkId: "C0001",
    sectionId: "SEC01",
    page: 1,
    groups: [
      callout("CT001", "[1]", ["1"], SENTENCE),
      callout("CT003", "[3, 4, 5]", ["3", "4", "5"], SENTENCE),
    ],
  };

  it("兜底：整句去标记 = 单论断，绑定全部组", () => {
    const plan = fallbackPlan(group);
    expect(plan.method).toBe("fallback");
    expect(plan.claims).toHaveLength(1);
    expect(plan.claims[0]!.claimText).not.toContain("[3, 4, 5]");
    expect(plan.claims[0]!.citationIds).toEqual(["CT001", "CT003"]);
  });

  it("批量 prompt：句子 id + 标记说明 + 输出契约", () => {
    const prompt = buildDecompositionPrompt([group]);
    expect(prompt).toContain("[S1]");
    expect(prompt).toContain("⟦CT001⟧");
    expect(prompt).toContain("原子论断");
    expect(prompt).toContain('"markers"');
    expect(prompt).toContain("最多拆 6 条");
    expect(prompt).toContain("预告性"); // 预告/组织性表述不绑定标记
  });
});
