/**
 * M11.3（Phase B）Existing Evidence Quality Gate 单元测试（§10–§12）。
 *
 * 覆盖任务书要求的判定矩阵：
 * - 真正强支持 Evidence（来源合法 + 词面命中）→ 候选保留 → use_existing_evidence；
 * - 词面相似但来源不合法（claim 点名了其它文献 / 非本章引用源）→ 不短路；
 * - metadata-only 记录 → 不冒充 fulltext Evidence；
 * - 同一 Source 但 claim 要求 direct 而证据只有 partial / strength 缺失 → 不接受；
 * - Verified direct support（来源合法）→ 接受；
 * - 数值 claim 的数字锚定（候选不含特征数值 → 排除）。
 * 附：章节键归一化（sections/x.tex ↔ x）与 literatureRefs entryId（M-S005）
 * 前缀剥离——M11.2.3 投影从未命中的回归测试。
 */

import { describe, expect, it } from "vitest";

import {
  claimRequiresDirectSupport,
  computeClaimGroundingReport,
  distinctiveNumbers,
  eligibleSourceIdsForClaim,
  findEvidenceCandidates,
  literatureRefSourceIds,
  meetsEvidenceSupportQuality,
  normalizeSectionKey,
} from "../../src/review/claimGrounding.js";
import type { EvidenceRecord } from "../../src/evidence/EvidenceStore.js";

function evidence(
  id: string,
  claim: string,
  options: {
    sourceId?: string;
    quote?: string;
    title?: string;
    supportStrength?: "direct" | "partial" | "indirect" | "contradictory";
    verificationLevel?: "metadata" | "abstract" | "fulltext" | "user_confirmed";
    verified?: boolean;
  } = {},
): EvidenceRecord {
  return {
    id,
    claim,
    ...(options.quote !== undefined ? { quote: options.quote } : {}),
    source: {
      sourceId: options.sourceId ?? "S001",
      ...(options.title !== undefined ? { title: options.title } : {}),
    },
    location: { chunk: "c0" },
    verificationStatus: options.verified === false ? "unverified" : "verified",
    ...(options.supportStrength !== undefined ? { supportStrength: options.supportStrength } : {}),
    ...(options.verificationLevel !== undefined ? { verificationLevel: options.verificationLevel } : {}),
    createdBy: "test",
    createdAt: "2026-10-04T00:00:00.000Z",
  };
}

const BIB = [
  { key: "miah2024learning", sourceId: "S011" },
  { key: "wang2022extendable", sourceId: "S025" },
  { key: "stanojevic2024boosttrack", sourceId: "S004" },
];

describe("meetsEvidenceSupportQuality（记录级质量，§10）", () => {
  const numericClaim = "BoostTrack 无外观版 65.45 FPS、加外观骤降至 15.35 FPS";
  const qualitativeClaim = "低分检测二次关联可改善跟踪表现";

  it("verified + fulltext + direct 满足任何 claim", () => {
    const record = evidence("E1", "x", { supportStrength: "direct", verificationLevel: "fulltext" });
    expect(meetsEvidenceSupportQuality(record, numericClaim)).toBe(true);
    expect(meetsEvidenceSupportQuality(record, qualitativeClaim)).toBe(true);
  });

  it("verificationLevel=metadata 不冒充正文证据（即使 verified + direct）", () => {
    const record = evidence("E2", "x", { supportStrength: "direct", verificationLevel: "metadata" });
    expect(meetsEvidenceSupportQuality(record, qualitativeClaim)).toBe(false);
  });

  it("含数字 claim 要求 direct：partial 不足、strength 缺失 fail-closed", () => {
    const partial = evidence("E3", "x", { supportStrength: "partial", verificationLevel: "fulltext" });
    expect(claimRequiresDirectSupport(numericClaim)).toBe(true);
    expect(meetsEvidenceSupportQuality(partial, numericClaim)).toBe(false);
    expect(meetsEvidenceSupportQuality(partial, qualitativeClaim)).toBe(true);
    const missing = evidence("E4", "x", { verificationLevel: "fulltext" });
    expect(meetsEvidenceSupportQuality(missing, qualitativeClaim)).toBe(false);
  });

  it("indirect / contradictory 不达任何 claim 的最低等级", () => {
    for (const strength of ["indirect", "contradictory"] as const) {
      const record = evidence("E5", "x", { supportStrength: strength, verificationLevel: "fulltext" });
      expect(meetsEvidenceSupportQuality(record, qualitativeClaim)).toBe(false);
    }
  });
});

describe("distinctiveNumbers（数值锚定输入）", () => {
  it("小数与 ≥3 位整数是特征数值；纯年份与短数字不是", () => {
    expect(distinctiveNumbers("65.45 FPS 与 3.05，2019 至 2024 年共 25 篇")).toEqual(["65.45", "3.05"]);
    expect(distinctiveNumbers("2019 至 2025 年")).toEqual([]);
    expect(distinctiveNumbers("只有 7 和 42")).toEqual([]);
    expect(distinctiveNumbers("1000 FPS")).toEqual(["1000"]);
  });
});

describe("eligibleSourceIdsForClaim（来源合法性，§10 第 4 条）", () => {
  it("claim 点名具体文献（出现完整 bib key）→ 严格限定到点名源", () => {
    const claim = "miah2024learning 仅以边界框坐标学 Transformer 亲和度；wang2022extendable 提出可扩展框架";
    const result = eligibleSourceIdsForClaim(claim, { bibEntries: BIB });
    expect(result.scope).toBe("claim_named");
    expect(result.sourceIds).toEqual(["S011", "S025"]);
  });

  it("未点名 → 章节引用面（键归一化命中）；都无 → 全池", () => {
    const cited = { "detection-centric-low-score": ["S004", "S005"] };
    expect(
      eligibleSourceIdsForClaim("低分检测恢复改善关联", {
        section: "sections/detection-centric-low-score.tex",
        sectionCitedSourceIds: cited,
        bibEntries: BIB,
      }),
    ).toEqual({ scope: "section_cited", sourceIds: ["S004", "S005"] });
    expect(
      eligibleSourceIdsForClaim("低分检测恢复改善关联", {
        section: "sections/unknown.tex",
        sectionCitedSourceIds: cited,
        bibEntries: BIB,
      }),
    ).toEqual({ scope: "all" });
  });

  it("normalizeSectionKey：路径 / 扩展名 / 大小写归一；literatureRefs 的 M- 前缀剥离", () => {
    expect(normalizeSectionKey("sections/Taxonomy-Framework.tex")).toBe("taxonomy-framework");
    expect(normalizeSectionKey("taxonomy-framework.tex")).toBe("taxonomy-framework");
    expect(literatureRefSourceIds(["M-S005", "S016", "M-S023", "M-S005"])).toEqual(["S005", "S016", "S023"]);
  });
});

describe("findEvidenceCandidates（三层门槛集成，§11/§12）", () => {
  const realQuote =
    "BoostTrack without appearance runs at 65.45 FPS on MOT17 and 32.79 FPS on MOT20; with the appearance branch throughput drops to 15.35 and 3.05 FPS respectively.";
  const sectionCited = { "cross-method-comparison": ["S004"] };

  it("真支持（引用源 + direct + 数值锚定）→ 候选保留（→ use_existing_evidence）", () => {
    const claim = "BoostTrack 无外观版 65.45 FPS、加外观骤降至 15.35 FPS";
    const pool = [
      evidence("E100", "BoostTrack 速度消融", {
        sourceId: "S004",
        quote: realQuote,
        title: "BoostTrack",
        supportStrength: "direct",
        verificationLevel: "fulltext",
      }),
    ];
    const candidates = findEvidenceCandidates(claim, pool, {
      section: "sections/cross-method-comparison.tex",
      sectionCitedSourceIds: sectionCited,
      bibEntries: BIB,
    });
    expect(candidates.map((candidate) => candidate.evidenceId)).toEqual(["E100"]);
    expect(candidates[0]?.sourceId).toBe("S004");
  });

  it("词面假友（claim 点名 S011/S025，候选来自 S005/S009）→ 不短路（MOT #5 实录）", () => {
    const claim =
      "miah2024learning 仅以边界框坐标学 Transformer 亲和度；wang2022extendable RTU++ 可扩展框架；zaech2022learnable LiDAR 可学习在线图表示";
    const pool = [
      evidence("E013", "SMILEtrack 的 PRB-Net 检测端", {
        sourceId: "S005",
        quote: "PRB-Net Transformer 学习型检测 backbone tracking",
        title: "SMILEtrack",
        supportStrength: "direct",
        verificationLevel: "fulltext",
      }),
      evidence("E005", "ContrasTR 的对比学习", {
        sourceId: "S009",
        quote: "contrastive learning Transformer tracker",
        title: "ContrasTR",
        supportStrength: "direct",
        verificationLevel: "fulltext",
      }),
    ];
    const candidates = findEvidenceCandidates(claim, pool, {
      section: "sections/learned-and-end-to-end-association.tex",
      sectionCitedSourceIds: { "learned-and-end-to-end-association": ["S011", "S025"] },
      bibEntries: BIB,
    });
    expect(candidates).toEqual([]);
  });

  it("metadata-only 记录不进候选（verified + 词面命中也不行）", () => {
    const claim = "低分检测恢复改善关联";
    const pool = [
      evidence("E200", claim, { sourceId: "S004", supportStrength: "direct", verificationLevel: "metadata" }),
    ];
    expect(findEvidenceCandidates(claim, pool, { bibEntries: BIB })).toEqual([]);
  });

  it("同一 Source 但 claim 含数字而证据仅 partial → 不接受（→ 落到 ground/search 阶梯）", () => {
    const claim = "该方案将 IDSW 降低了 47.2%";
    const pool = [
      evidence("E300", "该方案降低了 IDSW", {
        sourceId: "S004",
        quote: "IDSW 47.2%",
        supportStrength: "partial",
        verificationLevel: "fulltext",
      }),
    ];
    expect(findEvidenceCandidates(claim, pool, { bibEntries: BIB })).toEqual([]);
  });

  it("数值 claim 的数字锚定：词面像但不含特征数值 → 排除", () => {
    const claim = "UCMCTrack 在给定检测下单 CPU 超过 1000 FPS";
    const pool = [
      evidence("E400", "UCMCTrack 是高效的统一补偿跟踪器", {
        sourceId: "S006",
        quote: "UCMCTrack runs in real time on a single CPU",
        title: "UCMCTrack",
        supportStrength: "direct",
        verificationLevel: "fulltext",
      }),
      evidence("E401", "速度测量", {
        sourceId: "S006",
        quote: "over 1000 FPS on a single CPU with given detections",
        title: "UCMCTrack",
        supportStrength: "direct",
        verificationLevel: "fulltext",
      }),
    ];
    const candidates = findEvidenceCandidates(claim, pool, { bibEntries: BIB });
    expect(candidates.map((candidate) => candidate.evidenceId)).toEqual(["E401"]);
  });

  it("未验证记录不进候选（既有 formal 口径回归）", () => {
    const claim = "低分检测恢复改善关联";
    const pool = [evidence("E500", claim, { sourceId: "S004", verified: false, verificationLevel: "fulltext" })];
    expect(findEvidenceCandidates(claim, pool, { bibEntries: BIB })).toEqual([]);
  });
});

describe("computeClaimGroundingReport 接线（sectionCitedSourceIds 投影）", () => {
  it("投影经归一化键命中：sections/x.tex 的 claim 只见本节引用源的证据", () => {
    const pool = [
      evidence("E600", "本节引用源的相关证据", {
        sourceId: "S004",
        quote: "低分检测二次关联 ByteTrack",
        supportStrength: "direct",
        verificationLevel: "fulltext",
      }),
      evidence("E601", "其它源的词面相似证据", {
        sourceId: "S030",
        quote: "低分检测二次关联 ByteTrack",
        supportStrength: "direct",
        verificationLevel: "fulltext",
      }),
    ];
    const report = computeClaimGroundingReport({
      projectId: "p-test",
      round: 1,
      factClaims: [
        { section: "sections/detection-centric-low-score.tex", claim: "低分检测二次关联改善跟踪", verdict: "UNSUPPORTED" },
      ],
      formalEvidence: pool,
      bibEntries: BIB,
      sectionCitedSourceIds: { "detection-centric-low-score": ["S004"] },
    });
    const entry = report.claims[0]!;
    expect(entry.repairCandidates.map((candidate) => candidate.evidenceId)).toEqual(["E600"]);
  });
});
