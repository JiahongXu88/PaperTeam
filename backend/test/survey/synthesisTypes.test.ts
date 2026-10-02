/**
 * M11.1.2 synthesis 类型层测试：candidate parse（fail-closed 账目 / 自报
 * 字段丢弃）、确定性 ID、跨 batch dedup。
 */

import { describe, expect, it } from "vitest";

import {
  dedupSynthesisItems,
  normalizeSynthesisClaim,
  parseSynthesisCandidates,
  synthesisFingerprint,
  synthesisId,
  type SurveySynthesisItem,
} from "../../src/survey/synthesisTypes.js";

describe("parseSynthesisCandidates", () => {
  it("合法 trend candidate：结构字段进入；模型自报的 groundingLevel / evidenceIds 被结构性丢弃", () => {
    const { candidates, rejections } = parseSynthesisCandidates({
      candidates: [
        {
          kind: "trend",
          claim: "关联方法从外观转向运动",
          groundingLevel: "evidence_backed", // 模型无权自报——必须被忽略
          evidenceIds: ["E999"], // 必须被忽略
          detail: { period: "2017-2023", direction: "外观 → 运动" },
          entryIds: ["M-S001", "M-S002"],
          evidenceProposals: [
            { entryId: "M-S001", chunkId: "S001:SEC01:0001:aaaaaaaaaa", evidenceClaim: "断言 A" },
          ],
        },
      ],
    });
    expect(rejections).toEqual([]);
    expect(candidates).toHaveLength(1);
    const candidate = candidates[0]!;
    expect(candidate.kind).toBe("trend");
    expect(candidate.sourceIds).toEqual([]); // 服务层从 entryIds 派生；模型无权声明
    expect(candidate.entryIds).toEqual(["M-S001", "M-S002"]);
    expect(candidate.proposals).toEqual([
      { entryId: "M-S001", chunkId: "S001:SEC01:0001:aaaaaaaaaa", evidenceClaim: "断言 A" },
    ]);
    // 自报字段在 SynthesisCandidate 类型上不存在（编译期保证 + 运行期丢弃）
    expect(candidate).not.toHaveProperty("groundingLevel");
    expect(candidate).not.toHaveProperty("evidenceIds");
  });

  it("未知 kind 与 taxonomy kind 的模型候选被丢弃（taxonomy 只由代码聚合）", () => {
    const { candidates, rejections } = parseSynthesisCandidates({
      candidates: [
        { kind: "made_up_kind", claim: "x", detail: {}, entryIds: ["M-S001"] },
        { kind: "taxonomy", claim: "y", detail: { family: "a" }, entryIds: ["M-S001"] },
        { kind: "consensus", claim: "z", detail: {}, entryIds: ["M-S001", "M-S002"] },
      ],
    });
    expect(rejections).toEqual([]);
    expect(candidates.map((candidate) => candidate.claim)).toEqual(["z"]);
  });

  it("research_gap：白名单外 trigger → 该条进 rejections（fail-closed），其余候选不受影响", () => {
    const { candidates, rejections } = parseSynthesisCandidates({
      candidates: [
        {
          kind: "research_gap",
          claim: "没人研究低照度关联",
          detail: { trigger: "intuitive_feeling", basis: "猜测" },
          entryIds: ["M-S001"],
        },
        {
          kind: "research_gap",
          claim: "多篇文献明确低照度空缺",
          detail: { trigger: "literature_limitation", basis: "limitation 聚合" },
          entryIds: ["M-S001", "M-S002"],
        },
      ],
    });
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.detail).toMatchObject({ kind: "research_gap", trigger: "literature_limitation" });
    expect(rejections).toHaveLength(1);
    expect(rejections[0]!.reason).toContain("literature_limitation");
    expect(rejections[0]!.claim).toBe("没人研究低照度关联");
  });

  it("future_direction：origin 缺失 / 非法 → rejections", () => {
    const { candidates, rejections } = parseSynthesisCandidates({
      candidates: [
        { kind: "future_direction", claim: "a", detail: {}, entryIds: ["M-S001"] },
        { kind: "future_direction", claim: "b", detail: { origin: "definitely_grounded" }, entryIds: ["M-S001"] },
        { kind: "future_direction", claim: "c", detail: { origin: "inferred" }, entryIds: ["M-S001"] },
      ],
    });
    expect(candidates.map((candidate) => candidate.claim)).toEqual(["c"]);
    expect(rejections).toHaveLength(2);
  });

  it("comparison / disagreement：sides 内 entryIds 并入总集；缺 claim → rejections", () => {
    const { candidates, rejections } = parseSynthesisCandidates({
      candidates: [
        {
          kind: "comparison",
          claim: "外观依赖对照",
          detail: {
            dimension: "appearance dependency",
            sides: [
              { label: "A", entryIds: ["M-S001"], basis: "依赖外观" },
              { label: "B", entryIds: ["M-S002", "M-S003"], basis: "无外观" },
            ],
          },
          entryIds: [],
        },
        { kind: "disagreement", claim: "", entryIds: ["M-S001"], detail: { issue: "i", sideA: { entryIds: [] }, sideB: { entryIds: [] } } },
      ],
    });
    expect(rejections).toHaveLength(1);
    expect(candidates).toHaveLength(1);
    expect(candidates[0]!.entryIds).toEqual(["M-S001", "M-S002", "M-S003"]);
  });

  it("evidenceProposals 超 4 条截断；形状非法项剔除", () => {
    const proposals = Array.from({ length: 6 }, (_, index) => ({
      entryId: `M-S00${index + 1}`,
      chunkId: `S00${index + 1}:SEC01:0001:aaaaaaaaaa`,
      evidenceClaim: `断言 ${index}`,
    }));
    const { candidates } = parseSynthesisCandidates({
      candidates: [
        {
          kind: "consensus",
          claim: "共识",
          detail: {},
          entryIds: ["M-S001"],
          evidenceProposals: [...proposals, { entryId: "M-S001" }, "not-an-object", null],
        },
      ],
    });
    expect(candidates[0]!.proposals).toHaveLength(4);
  });

  it("输出缺 candidates 数组 → 抛错（batch 级失败）", () => {
    expect(() => parseSynthesisCandidates({})).toThrow();
    expect(() => parseSynthesisCandidates({ candidates: "no" })).toThrow();
  });
});

describe("确定性 ID 与 dedup", () => {
  it("synthesisId 是输入纯函数：同输入恒同值；claim 归一后等价输入同 ID", () => {
    const a = synthesisId("trend", "关联方法  从外观转向运动", ["S002", "S001"]);
    const b = synthesisId("trend", "关联方法 从外观转向运动", ["S001", "S002"]);
    expect(a).toBe(b);
    expect(a).toMatch(/^SYN-[0-9a-f]{10}$/);
    // 不同 kind / 不同 claim / 不同 source 集 → 不同 ID
    expect(synthesisId("consensus", "关联方法 从外观转向运动", ["S001", "S002"])).not.toBe(a);
    expect(synthesisId("trend", "另一陈述", ["S001", "S002"])).not.toBe(a);
    expect(synthesisId("trend", "关联方法 从外观转向运动", ["S001", "S003"])).not.toBe(a);
  });

  it("normalizeSynthesisClaim：压缩空白 + 小写（claim 文本 dedup 口径）", () => {
    expect(normalizeSynthesisClaim("  A   B  ")).toBe("a b");
  });

  it("dedupSynthesisItems：同 fingerprint（claim 大小写 / 空白差异）合并 entryIds / evidenceIds；claim 取首条", () => {
    const mk = (claim: string, entryIds: string[], evidenceIds: string[]): SurveySynthesisItem => ({
      synthesisId: synthesisId("consensus", claim, ["S001", "S002", "S003"]),
      kind: "consensus",
      claim,
      groundingLevel: "evidence_backed",
      evidenceIds,
      sourceIds: ["S001", "S002", "S003"],
      derivedFrom: { entryIds },
      updatedAt: "2026-10-02T08:00:00.000Z",
    });
    const first = mk("低分框共识  成立", ["M-S001"], ["E001"]);
    const second = mk("低分框共识 成立", ["M-S002"], ["E002"]);
    const distinct = mk("完全不同的共识", ["M-S003"], []);
    const deduped = dedupSynthesisItems([first, second, distinct]);
    expect(deduped).toHaveLength(2);
    const merged = deduped.find((item) => item.claim === "低分框共识  成立")!;
    expect(merged.derivedFrom.entryIds).toEqual(["M-S001", "M-S002"]);
    expect(merged.evidenceIds).toEqual(["E001", "E002"]);
    expect(deduped.map((item) => item.synthesisId).sort()).toEqual(
      [...deduped].map((item) => item.synthesisId).sort(),
    );
  });

  it("synthesisFingerprint 与 dedup 键一致：完全重复的 batch 输出只剩一条", () => {
    const claim = "Trend：转向运动关联";
    const item: SurveySynthesisItem = {
      synthesisId: synthesisId("trend", claim, ["S001", "S002"]),
      kind: "trend",
      claim,
      groundingLevel: "literature_cited",
      evidenceIds: [],
      sourceIds: ["S001", "S002"],
      derivedFrom: { entryIds: ["M-S001", "M-S002"] },
      updatedAt: "2026-10-02T08:00:00.000Z",
    };
    expect(dedupSynthesisItems([item, { ...item }])).toHaveLength(1);
    expect(synthesisFingerprint("trend", claim, ["S001", "S002"])).toBe(
      synthesisFingerprint("trend", claim.toUpperCase(), ["S002", "S001"]),
    );
  });
});
