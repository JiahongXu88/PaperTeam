/**
 * M10.2 候选事实 → user_confirmed Evidence 测试（§10/§11）：
 * - 确认后 verificationLevel=user_confirmed、verificationStatus=unverified；
 * - user_confirmed ≠ grounded_verified（isFormalEvidence 不成立——无 chunk 锚点
 *   + unverified；EvidenceSelectionService 分级不受影响）；
 * - provenance：figureBlockId / assetName / page / bbox / visionFactRef；
 * - fact 带 value 时 claim 必须提到该值（机械校验纪律）；
 * - 事实不存在 / 分析过期 → 明确失败。
 */

import { afterAll, describe, expect, it } from "vitest";

import { classifyEvidence, isFormalEvidence } from "../../src/evidence/EvidenceSelectionService.js";
import { makePng } from "../ingestion/binaryFixtures.js";
import { cleanupVisionFixtures, newVisionFixture, notebookFigureBlock, pdfFigureBlock } from "./fixtures.js";

afterAll(async () => {
  await cleanupVisionFixtures();
});

type VisionFixture = Awaited<ReturnType<typeof newVisionFixture>>;

async function analyzedSource(f: VisionFixture) {
  const { source } = await f.sources.add(f.projectId, { fileName: "paper.pdf", content: Buffer.from("%PDF-") });
  await f.seedDocument(source.sourceId, [pdfFigureBlock()], { "fig-001.png": makePng(20, 20) });
  await f.vision.analyze(f.projectId, source.sourceId);
  return source;
}

describe("confirmFactEvidence", () => {
  it("确认 → user_confirmed Evidence + 完整视觉 provenance", async () => {
    const f = await newVisionFixture();
    const source = await analyzedSource(f);
    const result = await f.vision.confirmFactEvidence(f.projectId, source.sourceId, "B0005-F01", {
      claim: "MOTA 在 threshold=0.5 时达到 82.4",
    });
    expect(result.evidence.verificationLevel).toBe("user_confirmed");
    expect(result.evidence.verificationStatus).toBe("unverified");
    expect(result.evidence.verificationMethod).toBe("user-confirmed:figure-analysis");
    expect(result.evidence.location).toMatchObject({
      page: 3,
      figureBlockId: "B0005",
      assetName: "fig-001.png",
      bbox: { x0: 5, y0: 5, x1: 50, y1: 50 },
      visionFactRef: "VA-B0005/B0005-F01",
    });
    expect(result.evidence.quote).toContain("fig-001.png");
    expect(result.evidence.source?.sourceId).toBe(source.sourceId);
    expect(result.fact.factId).toBe("B0005-F01");
  });

  it("user_confirmed ≠ grounded_verified（分级边界锁定）", async () => {
    const f = await newVisionFixture();
    const source = await analyzedSource(f);
    const { evidence } = await f.vision.confirmFactEvidence(f.projectId, source.sourceId, "B0005-F01", {
      claim: "MOTA 峰值为 82.4",
    });
    // 形式证据三条件（verified + sourceId + chunk 锚点）不满足：
    // status=unverified 且无 chunk → isFormalEvidence=false → 不属 grounded_verified
    expect(isFormalEvidence(evidence)).toBe(false);
    expect(classifyEvidence(evidence)).not.toBe("grounded_verified");
    // 即便后续被误标 verified，也无 chunk 锚点（location.chunk 缺省）
    expect(evidence.location?.chunk).toBeUndefined();
  });

  it("fact 带 value 时 claim 未提到该值 → 422（机械校验）", async () => {
    const f = await newVisionFixture();
    const source = await analyzedSource(f);
    await expect(
      f.vision.confirmFactEvidence(f.projectId, source.sourceId, "B0005-F01", {
        claim: "图中曲线呈上升趋势",
      }),
    ).rejects.toMatchObject({ code: "EVIDENCE_VALUE_MISMATCH" });
  });

  it("事实不存在 → 404", async () => {
    const f = await newVisionFixture();
    const source = await analyzedSource(f);
    await expect(
      f.vision.confirmFactEvidence(f.projectId, source.sourceId, "B9999-F01", { claim: "任意 claim 82.4" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("空 claim → 400", async () => {
    const f = await newVisionFixture();
    const source = await analyzedSource(f);
    await expect(
      f.vision.confirmFactEvidence(f.projectId, source.sourceId, "B0005-F01", { claim: "  " }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("分析未完成（skipped）的事实不可确认；Notebook 链路确认带 Cell provenance", async () => {
    // Notebook 链
    const f = await newVisionFixture();
    const { source } = await f.sources.add(f.projectId, { fileName: "analysis.ipynb", content: Buffer.from("{}") });
    await f.seedDocument(source.sourceId, [notebookFigureBlock()], {
      "cell-2-output-0.png": makePng(30, 30),
    });
    await f.vision.analyze(f.projectId, source.sourceId);
    const result = await f.vision.confirmFactEvidence(f.projectId, source.sourceId, "B0007-F01", {
      claim: "输出图显示 MOTA 为 82.4",
    });
    expect(result.evidence.location?.figureBlockId).toBe("B0007");
    expect(result.evidence.location?.section).toBe("Cell 2 · output 0");

    // skipped 链：模型不可用 → 分析 skipped → 无 completed 事实
    const f2 = await newVisionFixture({ modelCandidates: () => ({}) });
    const { source: s2 } = await f2.sources.add(f2.projectId, { fileName: "paper.pdf", content: Buffer.from("%PDF-") });
    await f2.seedDocument(s2.sourceId, [pdfFigureBlock()], { "fig-001.png": makePng(10, 10) });
    await f2.vision.analyze(f2.projectId, s2.sourceId);
    await expect(
      f2.vision.confirmFactEvidence(f2.projectId, s2.sourceId, "B0005-F01", { claim: "x 82.4" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
