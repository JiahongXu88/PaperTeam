/**
 * M13 Final Closure（A1）：Claim Stance —— 正面事实断言 vs 对未证实命题的拒绝 / 不确定性。
 *
 * 真实样本（M13.7.11 §5.4 / p-8ddfa9fda825 r2–r4）：
 *   claim  「相干增益 G=2.27 与表面码 2.4 倍寿命超越并非同一指标，不可据此判定两条路线优劣。」
 *   bound  E012（partial）「相干增益 G = 2.27 与表面码的 2.4 倍寿命提升是同一指标，可直接比较…」
 *   reviewer SUPPORTED → 旧 grounding 改判 UNSUPPORTED（含数字 + partial）→ gate 阻断三轮。
 *
 * 本文件覆盖：立场分类的正例 / 反例 / 对抗例；数值锚定；联合判定的四个条件逐一失效。
 */

import { describe, expect, it } from "vitest";

import type { EvidenceRecord } from "../../src/evidence/EvidenceStore.js";
import {
  assessPartialRefutation,
  classifyClaimStance,
  numbersAnchoredInEvidence,
  overlapsEvidenceRecord,
} from "../../src/review/claimStance.js";

function evidence(input: Partial<EvidenceRecord> & { id: string; claim: string }): EvidenceRecord {
  return {
    verificationStatus: "verified",
    supportStrength: "direct",
    verificationLevel: "abstract",
    source: { sourceId: `S-${input.id}`, title: `Paper ${input.id}`, year: 2024 },
    location: { chunk: `${input.id}:ABS:0001:deadbeef00` },
    createdBy: "test",
    createdAt: "2026-10-13T00:00:00Z",
    ...input,
  } as EvidenceRecord;
}

// 与历史项目同构的正式证据池（摘要级 direct + 两条 partial 负对照）
const E006 = evidence({
  id: "E006",
  claim: "This logical memory is also beyond break-even, exceeding its best physical qubit's lifetime by a factor of 2.4 ± 0.3.",
  quote: "This logical memory is also beyond break-even, exceeding its best physical qubit's lifetime by a factor of 2.4 $\\pm$ 0.3.",
});
const E008 = evidence({
  id: "E008",
  claim: "实时纠错实验展示完全稳定且经纠错的逻辑量子比特，相干增益 G = 2.27 ± 0.07。",
  quote: "a fully stabilized and error-corrected logical qubit ... coherence gain of G = 2.27 ± 0.07",
});
const E012 = evidence({
  id: "E012",
  supportStrength: "partial",
  claim: "相干增益 G = 2.27 与表面码的 2.4 倍寿命提升是同一指标，可直接比较两条路线的纠错效果。",
  quote: "Whether it is practically possible to utilize QEC for extending quantum coherence thus remains an open question.",
});
const E011 = evidence({
  id: "E011",
  supportStrength: "partial",
  claim: "表面码实验已经达到大规模容错量子算法所需的逻辑错误率。",
  quote: "Our results present device performance that, if scaled, could realize the operational requirements of large scale fault-tolerant quantum algorithms.",
});
const POOL = [E006, E008, E011, E012];

const REAL_REFUTATION = "相干增益 G=2.27 与表面码 2.4 倍寿命超越并非同一指标，不可据此判定两条路线优劣。";
const REAL_REFUTATION_R4 = "G=2.27与表面码2.4倍最佳物理比特寿命超越分属不同实验的指标设定，不可据此判定优劣";

describe("classifyClaimStance（立场分类）", () => {
  it("真实拒绝句（r2 / r3 / r4 三种措辞）→ refutation", () => {
    expect(classifyClaimStance(REAL_REFUTATION).stance).toBe("refutation");
    expect(classifyClaimStance("相干增益G=2.27与表面码的2.4倍最佳物理比特寿命超越并非同一指标，不可据此判定优劣").stance).toBe(
      "refutation",
    );
    expect(classifyClaimStance(REAL_REFUTATION_R4).stance).toBe("refutation");
  });

  it("可比性 / 推断 / 排序拒绝的其它形态 → refutation", () => {
    for (const text of [
      "两条路线的编码载体、规模、指标口径存在维度差异，不支持整体性能排序",
      "G 与寿命倍数不能直接比较",
      "0.143% 的每周期错误率不构成已达到容错阈值的证据",
      "The coherence gain G = 2.27 and the 2.4x lifetime extension are not directly comparable.",
      "These results cannot be used to rank the two routes.",
    ]) {
      expect(classifyClaimStance(text).stance, text).toBe("refutation");
    }
  });

  it("不确定性陈述 → uncertainty", () => {
    for (const text of [
      "表面码实验是否已达大规模容错算法所需逻辑错误率，现有证据尚无法判断",
      "能否在统一口径下比较两条路线尚无定论",
      "Whether 2.4x can be compared with G = 2.27 remains an open question.",
      "该换算的有效性有待实验验证",
    ]) {
      expect(classifyClaimStance(text).stance, text).toBe("uncertainty");
    }
  });

  it("否定形态的事实断言不是拒绝：未超越 / 不优于 / 低于 / 未达到 → assertion（保持原口径）", () => {
    for (const text of [
      "相干增益 G=2.27 的逻辑比特并未超越盈亏平衡",
      "距离 5 表面码不优于距离 3 集合",
      "该方案的逻辑错误率低于 0.143%",
      "表面码实验未达到 1e-6 的逻辑错误率",
      "寿命增益 2.4 倍没有超过玻色编码路线",
      "该结果不显著",
    ]) {
      expect(classifyClaimStance(text).stance, text).toBe("assertion");
    }
  });

  it("正面断言与正面可比性主张 → assertion", () => {
    for (const text of [
      "相干增益 G=2.27 与 2.4 倍寿命提升是同一指标，可直接比较两条路线",
      "2024 年展示两个阈值以下表面码存储器：距离 7 与距离 5 码",
      "码距每增 2 逻辑错误率被抑制 Λ=2.14±0.02",
    ]) {
      expect(classifyClaimStance(text).stance, text).toBe("assertion");
    }
  });

  it("仅出现否定词不触发（「不」「不能」单独出现）", () => {
    expect(classifyClaimStance("该实验不使用实时解码器，每周期 1.1 μs").stance).toBe("assertion");
    expect(classifyClaimStance("解码器不能在 63 μs 内完成").stance).toBe("assertion");
  });
});

describe("numbersAnchoredInEvidence（数值锚定）", () => {
  it("拒绝句的 2.27 / 2.4 都在正式证据池 → anchored", () => {
    const result = numbersAnchoredInEvidence(REAL_REFUTATION, POOL);
    expect(result.anchored).toBe(true);
    expect(result.numbers.sort()).toEqual(["2.27", "2.4"]);
  });

  it("任一特征数字不在池内 → 不锚定并点名缺失数值", () => {
    const result = numbersAnchoredInEvidence("表面码的 3.1 倍寿命提升与 G=2.27 并非同一指标", POOL);
    expect(result.anchored).toBe(false);
    expect(result.missing).toEqual(["3.1"]);
  });

  it("无特征数字（年份 / 两位整数）→ 视为无需锚定", () => {
    expect(numbersAnchoredInEvidence("2022 年的距离 5 码与距离 3 集合不能直接比较", POOL).anchored).toBe(true);
  });

  it("全角数字按 NFKC 归一后锚定", () => {
    expect(numbersAnchoredInEvidence("Ｇ＝２.２７ 与 ２.４ 倍并非同一指标", POOL).anchored).toBe(true);
  });
});

describe("assessPartialRefutation（四条件联合判定）", () => {
  it("真实样本：refutation + partial + 锚定 + 重叠 → qualifies", () => {
    const result = assessPartialRefutation(REAL_REFUTATION, E012, POOL);
    expect(result.qualifies).toBe(true);
    expect(result.stance).toBe("refutation");
    expect(result.numbersAnchored).toBe(true);
    expect(result.overlapsRecord).toBe(true);
    expect(result.reason).toContain("E012");
  });

  it("条件 1 失效：否定形态事实断言 → 不豁免", () => {
    const result = assessPartialRefutation("相干增益 G=2.27 的逻辑比特并未超越盈亏平衡", E012, POOL);
    expect(result.qualifies).toBe(false);
    expect(result.stance).toBe("assertion");
  });

  it("条件 2 失效：绑定记录为 direct / indirect / 缺失 strength → 不豁免（direct 走原口径）", () => {
    expect(assessPartialRefutation(REAL_REFUTATION, E006, POOL).qualifies).toBe(false);
    expect(
      assessPartialRefutation(REAL_REFUTATION, evidence({ ...E012, id: "E013", supportStrength: "indirect" }), POOL)
        .qualifies,
    ).toBe(false);
    const { supportStrength: _omit, ...noStrength } = E012;
    expect(assessPartialRefutation(REAL_REFUTATION, evidence({ ...noStrength, id: "E014" }), POOL).qualifies).toBe(false);
  });

  it("条件 3 失效：拒绝句夹带池外数值（3.1 倍）→ 不豁免，缺失数值可审计", () => {
    const result = assessPartialRefutation("表面码 3.1 倍寿命提升与 G=2.27 并非同一指标，不可据此判定优劣", E012, POOL);
    expect(result.qualifies).toBe(false);
    expect(result.missingNumbers).toEqual(["3.1"]);
    expect(result.reason).toContain("3.1");
  });

  it("条件 4 失效：拒绝句与绑定的 partial 记录无词项重叠（绑错命题）→ 不豁免", () => {
    const unrelatedPartial = evidence({
      id: "E020",
      supportStrength: "partial",
      claim: "Rydberg atom arrays achieve high-fidelity entangling gates.",
      quote: "Rydberg atom arrays achieve high-fidelity entangling gates.",
    });
    const result = assessPartialRefutation(
      "The coherence gain G = 2.27 and the 2.4 lifetime factor are not directly comparable.",
      unrelatedPartial,
      [...POOL, unrelatedPartial],
    );
    expect(result.qualifies).toBe(false);
    expect(result.overlapsRecord).toBe(false);
    expect(overlapsEvidenceRecord(REAL_REFUTATION, E012)).toBe(true);
  });

  it("uncertainty 立场同样可豁免（E011 型：声明尚不能判断）", () => {
    const result = assessPartialRefutation(
      "表面码实验是否已达大规模容错算法所需逻辑错误率（Λ=2.14 仍属抑制因子），现有证据尚无法判断",
      E011,
      [...POOL, evidence({ id: "E005", claim: "suppressed by a factor of Λ = 2.14 ± 0.02 when increasing the code distance by two" })],
    );
    expect(result.stance).toBe("uncertainty");
    expect(result.qualifies).toBe(true);
  });
});
