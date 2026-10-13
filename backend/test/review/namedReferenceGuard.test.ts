/**
 * M13 Final Closure（A2）：Named Reference Provenance Guard 的确定性测试。
 * 真实样本：reviewer finding 点名「2021 Krinner 等阈值实验」→ 修订把「阈值实验、早期重复码演示」
 * 写进摘要限制句。本守卫只认高置信具名词（拉丁人名 / 作者引用形态 / 混排与全大写实体名）。
 */

import { describe, expect, it } from "vitest";

import type { EvidenceRecord } from "../../src/evidence/EvidenceStore.js";
import {
  buildReferenceVocabulary,
  extractNamedReferenceTerms,
  findIntroducedNamedReferences,
  normalizeNamedTerm,
} from "../../src/review/namedReferenceGuard.js";

const EVIDENCE: EvidenceRecord[] = [
  {
    id: "E005",
    claim: "In this work, we present two surface code memories operating below this threshold: a distance-7 code and a distance-5 code integrated with a real-time decoder.",
    quote: "two surface code memories operating below this threshold",
    verificationStatus: "verified",
    supportStrength: "direct",
    verificationLevel: "abstract",
    source: { sourceId: "S-acharya2024", title: "Quantum error correction below the surface code threshold", authors: ["Rajeev Acharya", "Google Quantum AI"], year: 2024 },
    location: { chunk: "S-acharya2024:ABS:0001:deadbeef00" },
    createdBy: "test",
    createdAt: "2026-10-13T00:00:00Z",
  } as EvidenceRecord,
];
const BIB = [{ key: "acharya2024quantum", title: "Quantum error correction below the surface code threshold" }, { key: "sivak2023real", title: "Real-time quantum error correction beyond break-even" }];
const VOCAB = buildReferenceVocabulary({ evidence: EVIDENCE, bibEntries: BIB });

const BEFORE_ABSTRACT =
  "本文综述超导平台量子纠错实验的两条路线：表面码规模扩展\\cite{acharya2024quantum}与突破盈亏平衡\\cite{sivak2023real}。本文是一篇基于四篇代表性实验文献摘要的受限综述。";

describe("extractNamedReferenceTerms", () => {
  it("中文稿件：首字母大写拉丁词 / 作者引用形态 / 混排实体名都识别；LaTeX 命令与 cite key 不算", () => {
    const terms = extractNamedReferenceTerms("该方向以 Krinner 等 2022 年的阈值实验与 ByteTrack、GKP 编码为代表\\cite{krinner2022realizing}，见 Figure 3。");
    expect([...terms.keys()].sort()).toEqual(["bytetrack", "gkp", "krinner"]);
    expect(terms.get("krinner")?.kind).toBe("cited_author");
    expect(terms.get("bytetrack")?.kind).toBe("latin_name");
  });

  it("英文稿件：普通句首大写词不算；et al. / 年份形态与混排实体名才算", () => {
    const terms = extractNamedReferenceTerms(
      "Recent work by Krinner et al. (2022) demonstrated this. However, the ByteTrack baseline differs. The decoder runs in real time.",
    );
    expect([...terms.keys()].sort()).toEqual(["bytetrack", "krinner"]);
  });

  it("词形归一：复数 / 所有格", () => {
    expect(normalizeNamedTerm("Transformers")).toBe("transformer");
    expect(normalizeNamedTerm("Krinner's")).toBe("krinner");
    expect(normalizeNamedTerm("GKP")).toBe("gkp");
  });
});

describe("findIntroducedNamedReferences", () => {
  it("真实样本：修订把审稿意见点名的 Krinner 阈值实验写进摘要限制句 → 命中", () => {
    const after =
      BEFORE_ABSTRACT +
      "未覆盖 Krinner 等 2022 年的阈值实验、早期重复码演示等奠基性工作。";
    const introduced = findIntroducedNamedReferences({ before: BEFORE_ABSTRACT, after, allowedTexts: VOCAB });
    expect(introduced.map((entry) => entry.term)).toEqual(["krinner"]);
    expect(introduced[0]?.kind).toBe("cited_author");
    expect(introduced[0]?.context).toContain("阈值实验");
  });

  it("修订前已有 / 证据池 / 参考文献中已有的具名词不算新引入（Acharya、Google、Sivak）", () => {
    const after = BEFORE_ABSTRACT + "其中 Acharya 等与 Google Quantum AI 的表面码工作、Sivak 等的实时纠错工作是代表。";
    expect(findIntroducedNamedReferences({ before: BEFORE_ABSTRACT, after, allowedTexts: VOCAB })).toEqual([]);
  });

  it("修订未新增具名词（只改措辞 / 删词）→ 空", () => {
    const after = BEFORE_ABSTRACT.replace("受限综述", "范围受限的综述");
    expect(findIntroducedNamedReferences({ before: BEFORE_ABSTRACT, after, allowedTexts: VOCAB })).toEqual([]);
    expect(findIntroducedNamedReferences({ before: BEFORE_ABSTRACT, after: "本文综述两条路线。", allowedTexts: VOCAB })).toEqual([]);
  });

  it("允许词表来自其它章节的修订前文本也算（同稿件已有的实体不是新引入）", () => {
    const after = BEFORE_ABSTRACT + "该结论与 Ni 等的腔编码实验一致。";
    expect(findIntroducedNamedReferences({ before: BEFORE_ABSTRACT, after, allowedTexts: [...VOCAB, "sections/x.tex: Ni 等人在微波腔中…"] })).toEqual([]);
    expect(findIntroducedNamedReferences({ before: BEFORE_ABSTRACT, after, allowedTexts: VOCAB }).map((entry) => entry.term)).toEqual(["ni"]);
  });

  it("中文修订引入无 \\cite 的英文模型名（MOTRv2）→ 命中；LaTeX 结构词不命中", () => {
    const before = "本节比较两类端到端跟踪方法。";
    const after = before + "其中 MOTRv2 在 DanceTrack 上表现更好（见 Table 2）。";
    const introduced = findIntroducedNamedReferences({ before, after, allowedTexts: [] });
    expect(introduced.map((entry) => entry.term).sort()).toEqual(["dancetrack", "motrv2"]);
  });

  it("英文稿件对抗：句首普通大写词、月份、Figure/Table 不误报", () => {
    const before = "We study two routes.";
    const after = before + " Moreover, Figure 2 and Table 1 summarize the results obtained in March. Therefore the comparison holds.";
    expect(findIntroducedNamedReferences({ before, after, allowedTexts: [] })).toEqual([]);
  });

  it("buildReferenceVocabulary：证据作者 / 标题 / 参考文献 key 片段都进允许词表", () => {
    expect(VOCAB.some((text) => text.includes("Rajeev Acharya"))).toBe(true);
    expect(VOCAB.some((text) => text.includes("sivak"))).toBe(true);
  });
});
