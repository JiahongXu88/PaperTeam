/**
 * M13 Final Closure（A4）：多 key 引用归因稀释的确定性复审信号。
 * 真实反例（M13.7.9 §11）：「微波腔光子数态等离散变量…\cite{ni, sivak}」——只有 Ni 的证据含腔 / 光子数态。
 */

import { describe, expect, it } from "vitest";

import type { EvidenceRecord } from "../../src/evidence/EvidenceStore.js";
import {
  computeMultiKeyAttribution,
  renderMultiKeyAttributionDigest,
  splitLatexSentences,
} from "../../src/review/multiKeyAttribution.js";

function evidence(input: Partial<EvidenceRecord> & { id: string; claim: string; sourceId: string }): EvidenceRecord {
  const { sourceId, ...rest } = input;
  return {
    verificationStatus: "verified",
    supportStrength: "direct",
    verificationLevel: "abstract",
    source: { sourceId, title: `Paper ${sourceId}`, year: 2023 },
    location: { chunk: `${sourceId}:ABS:0001:deadbeef00` },
    createdBy: "test",
    createdAt: "2026-10-13T00:00:00Z",
    ...rest,
  } as EvidenceRecord;
}

const BIB = [
  { key: "ni2023beating", sourceId: "S-ni" },
  { key: "sivak2023real", sourceId: "S-sivak" },
  { key: "acharya2024below", sourceId: "S-acharya" },
  { key: "nometa2020", sourceId: "S-nometa" },
];
const POOL: EvidenceRecord[] = [
  evidence({
    id: "E010",
    sourceId: "S-ni",
    claim: "微波腔光子数态编码的逻辑量子比特，与辅助超导比特色散耦合，用频率梳脉冲重复提取错误征候并反馈纠错，寿命增强约 16%",
    quote: "a logical qubit encoded in photon-number states of a microwave cavity, dispersively coupled to an ancilla superconducting qubit",
  }),
  evidence({
    id: "E008",
    sourceId: "S-sivak",
    claim: "实时纠错实验展示完全稳定且经纠错的逻辑量子比特，相干增益 G=2.27±0.07，结合超导电路制备与无模型强化学习",
    quote: "a fully stabilized and error-corrected logical qubit whose quantum coherence is significantly longer than that of all the imperfect quantum components involved, coherence gain G = 2.27",
  }),
  evidence({
    id: "E005",
    sourceId: "S-acharya",
    claim: "两个阈值以下表面码存储器：距离 7 码与集成实时解码器的距离 5 码；码距每增 2 逻辑错误率抑制 Λ=2.14",
    quote: "two surface code memories operating below this threshold: a distance-7 code and a distance-5 code",
  }),
];

describe("computeMultiKeyAttribution", () => {
  it("真实反例：Ni 独有的腔 / 光子数态机制 + \\cite{ni,sivak} → 命中（attributed=ni，uncovered=sivak）", () => {
    const report = computeMultiKeyAttribution({
      files: [
        {
          file: "sections/introduction.tex",
          content: "突破盈亏平衡的工作以微波腔光子数态等离散变量编码为载体，通过频率梳脉冲重复提取错误征候\\cite{ni2023beating,sivak2023real}。",
        },
      ],
      evidence: POOL,
      bibEntries: BIB,
    });
    expect(report.sentencesWithMultiKeyCite).toBe(1);
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]).toMatchObject({ attributedKey: "ni2023beating", uncoveredKeys: ["sivak2023real"], file: "sections/introduction.tex" });
    expect(report.findings[0]!.matchedTerms.length).toBeGreaterThanOrEqual(2);
    const digest = renderMultiKeyAttributionDigest(report);
    expect(digest).toContain("sivak2023real 的证据零命中");
  });

  it("两篇都被句子的具体内容命中（真正的共同支撑）→ 不报", () => {
    const report = computeMultiKeyAttribution({
      files: [
        {
          file: "sections/x.tex",
          content: "两项实验都展示了经纠错的逻辑量子比特相干寿命增强：腔编码路线寿命增强约 16\\%，实时纠错路线相干增益 G=2.27\\cite{ni2023beating,sivak2023real}。",
        },
      ],
      evidence: POOL,
      bibEntries: BIB,
    });
    expect(report.findings).toHaveLength(0);
    expect(report.skipped).toEqual([{ reason: "shared_or_multi_hit", count: 1 }]);
  });

  it("分述标记（分别 / 前者后者 / respectively）→ 合法分述，不报", () => {
    const report = computeMultiKeyAttribution({
      files: [
        {
          file: "sections/x.tex",
          content: "两条路线分别采用微波腔光子数态编码与无模型强化学习控制\\cite{ni2023beating,sivak2023real}。",
        },
      ],
      evidence: POOL,
      bibEntries: BIB,
    });
    expect(report.findings).toHaveLength(0);
    expect(report.skipped).toEqual([{ reason: "distribution_marker", count: 1 }]);
  });

  it("任一 key 无正式证据 → 不可核对，跳过（不猜）", () => {
    const report = computeMultiKeyAttribution({
      files: [{ file: "sections/x.tex", content: "微波腔光子数态编码的频率梳脉冲征候提取\\cite{ni2023beating,nometa2020}。" }],
      evidence: POOL,
      bibEntries: BIB,
    });
    expect(report.findings).toHaveLength(0);
    expect(report.skipped).toEqual([{ reason: "key_without_evidence", count: 1 }]);
    expect(report.checkable).toBe(0);
  });

  it("纯背景引用（无机制 / 数字）→ 不报；单 key 引用不计入", () => {
    const report = computeMultiKeyAttribution({
      files: [
        {
          file: "sections/x.tex",
          content: "超导量子纠错是近年活跃的研究方向与研究领域\\cite{ni2023beating,sivak2023real}。微波腔光子数态编码的逻辑比特\\cite{ni2023beating}。",
        },
      ],
      evidence: POOL,
      bibEntries: BIB,
    });
    expect(report.sentencesWithMultiKeyCite).toBe(1);
    expect(report.findings).toHaveLength(0);
    expect(report.skipped).toEqual([{ reason: "no_specific_content", count: 1 }]);
  });

  it("特征数字只属于一篇（Λ=2.14 ← acharya）却与 sivak 并列 → 命中数字锚", () => {
    const report = computeMultiKeyAttribution({
      files: [{ file: "sections/x.tex", content: "表面码路线报告码距每增 2 的错误抑制因子 Λ=2.14\\cite{acharya2024below,sivak2023real}。" }],
      evidence: POOL,
      bibEntries: BIB,
    });
    expect(report.findings).toHaveLength(1);
    expect(report.findings[0]?.attributedKey).toBe("acharya2024below");
    expect(report.findings[0]?.matchedTerms).toContain("#2.14");
  });

  it("splitLatexSentences：节标题与注释不进句子；中英句末都能切", () => {
    const sentences = splitLatexSentences("\\section{引言}\n% 注释\n第一句\\cite{a,b}。Second sentence\\cite{c}. 第三句！");
    expect(sentences).toEqual(["第一句\\cite{a,b}。", "Second sentence\\cite{c}.", "第三句！"]);
  });
});
