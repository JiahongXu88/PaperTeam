/**
 * M12 Batch 2 · B3：ReviewFinding 视觉扩展（"visual" 类目 + figure 锚 +
 * 核验状态）的 schema 与序列化回归。
 *
 * 覆盖：createFinding 的 visual 类目与锚字段、provenance 第四形态
 * （figureEnvRef 单独成立）、JSON 往返（序列化路径不丢新字段）、
 * 旧 JSON 反向兼容（无新字段 / 无 visual 类目照常可读）、结构损坏丢弃。
 */

import { describe, expect, it } from "vitest";

import {
  createFinding,
  FINDING_CATEGORIES,
  readFinding,
  readFindings,
  type ReviewFinding,
} from "../../src/review/finding.js";

const NOW = "2026-10-07T10:00:00.000Z";

function visualFinding(): ReviewFinding {
  return createFinding({
    findingId: "vf-table-text-numeric-1",
    category: "visual",
    severity: "major",
    message: "表格数值与正文不一致：正文写「MOTA 76.3」，但 tab:main 行「MOT tracklet」= 78.2。",
    source: "deterministic-visual",
    now: NOW,
    figureEnvRef: "tex:main.tex:table-1",
    assetRef: "figures/S0001/fig-001.png",
    chunkId: "tex:main.tex#L12",
    visualConfidence: "high",
    verificationStatus: "verified_deterministic",
    claimText: "MOT tracklet achieves a MOTA of 76.3.",
  });
}

describe("M12 B3 finding schema：visual 类目与锚字段", () => {
  it("FINDING_CATEGORIES 含 visual（additive 追加，旧值序不变）", () => {
    expect(FINDING_CATEGORIES).toEqual([
      "fact",
      "academic",
      "style",
      "citation",
      "consistency",
      "visual",
    ]);
  });

  it("createFinding：visual + 全套锚字段（figureEnvRef/assetRef/visualConfidence/verificationStatus）", () => {
    const finding = visualFinding();
    expect(finding).toMatchObject({
      findingId: "vf-table-text-numeric-1",
      category: "visual",
      severity: "major",
      source: "deterministic-visual",
      status: "open",
      figureEnvRef: "tex:main.tex:table-1",
      assetRef: "figures/S0001/fig-001.png",
      chunkId: "tex:main.tex#L12",
      visualConfidence: "high",
      verificationStatus: "verified_deterministic",
      createdAt: NOW,
      updatedAt: NOW,
    });
  });

  it("provenance 第四形态：visual 类目仅 figureEnvRef 即合法；非 visual 仍要求三锚其一", () => {
    expect(() =>
      createFinding({
        findingId: "vf-1",
        category: "visual",
        severity: "info",
        message: "未被引用的图表。",
        source: "deterministic-visual",
        now: NOW,
        figureEnvRef: "tex:main.tex:figure-2",
      }),
    ).not.toThrow();
    expect(() =>
      createFinding({
        findingId: "f-1",
        category: "fact",
        severity: "major",
        message: "无锚。",
        source: "section-review",
        now: NOW,
      }),
    ).toThrow(/provenance/);
  });

  it("JSON 往返：新字段全部保留（序列化路径不丢）", () => {
    const finding = visualFinding();
    const restored = readFinding(JSON.parse(JSON.stringify(finding)));
    expect(restored).toEqual(finding);
  });

  it("vision-assisted 形态往返（model_observation 永不冒充 verified）", () => {
    const finding = createFinding({
      findingId: "vf-vision-tex-main-tex-figure-1-figure-caption-consistency",
      category: "visual",
      severity: "major",
      message: "视觉观察（模型，未经自动核验）：题注与图片不符。",
      source: "vision-assisted",
      now: NOW,
      figureEnvRef: "tex:main.tex:figure-1",
      page: 3,
      visualConfidence: "medium",
      verificationStatus: "model_observation",
    });
    expect(readFinding(JSON.parse(JSON.stringify(finding)))).toEqual(finding);
  });
});

describe("M12 B3 finding 反向兼容（旧 JSON）", () => {
  it("M11 形态（无任何新字段、category=fact）照常可读", () => {
    const legacy = {
      findingId: "f-run1-sec1-1",
      category: "fact",
      severity: "minor",
      sectionId: "SEC01",
      message: "旧产物无视觉字段。",
      status: "open",
      source: "section-review",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
    };
    expect(readFinding(legacy)).toEqual(legacy);
  });

  it("readFindings：混合新旧条目逐条保留，损坏条目丢弃并计数", () => {
    const good = visualFinding();
    const legacy = {
      findingId: "f-1",
      category: "style",
      severity: "info",
      page: 2,
      message: "旧条目。",
      status: "open",
      source: "section-review",
      createdAt: NOW,
      updatedAt: NOW,
    };
    const result = readFindings([
      good,
      legacy,
      { findingId: "bad-1", category: "visual", severity: "major", message: "锚类型损坏", status: "open", source: "x", createdAt: NOW, updatedAt: NOW, figureEnvRef: 42 },
      { findingId: "bad-2", category: "visual", severity: "major", message: "非法核验状态", status: "open", source: "x", createdAt: NOW, updatedAt: NOW, figureEnvRef: "tex:a:figure-1", verificationStatus: "auto_verified" },
      "not-an-object",
    ]);
    expect(result.findings).toEqual([good, legacy]);
    expect(result.dropped).toBe(3);
  });

  it("旧 JSON 中 category=visual 不存在时不受影响；新 JSON category 非法仍拒", () => {
    expect(readFinding({ findingId: "x", category: "hypothetical", severity: "info", page: 1, message: "m", status: "open", source: "s", createdAt: NOW, updatedAt: NOW })).toBeUndefined();
  });
});
