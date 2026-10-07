/**
 * Benchmark / Evidence 隔离回归（M12.1；M12.0 §5 四道隔离的 targeted 回归）。
 *
 * 断言面：reference SourceItem 不能通过任何普通路径变成
 * - survey 语料成员（isCorpusEligible，第 1 道——既有能力回归钉死）；
 * - evidence proposal（EvidenceGroundingService.propose 服务端 role 过滤，
 *   M12.1 增补——propose_evidence 工具 / JSON 锚定 / targeted grounding 的
 *   唯一候选入口）；
 * - verified evidence（ground 对历史候选的防御纵深 → unverifiable，
 *   EvidenceStore 查询确认零记录）；
 * - vision candidate fact → user_confirmed Evidence（confirmFactEvidence
 *   服务端校验，第 3 道）；
 * - targeted grounding 目标源集合（selectReviewerSourceIds role 过滤）。
 */

import { afterAll, describe, expect, it } from "vitest";

import { isCorpusEligible } from "../../src/survey/CorpusSnapshotService.js";
import { buildCorpusRows } from "../../src/survey/CorpusSnapshotService.js";
import { selectReviewerSourceIds } from "../../src/evidence/revisionSourceSelection.js";
import { newGroundingFixture, type GroundingFixture } from "../evidence/fixtures.js";
import { cleanupVisionFixtures, newVisionFixture, pdfFigureBlock } from "../vision/fixtures.js";
import { makePng } from "../ingestion/binaryFixtures.js";
import { sha256Hex } from "../../src/util/hash.js";
import type { SourceChunk } from "../../src/retrieval/types.js";

const fixtures: GroundingFixture[] = [];
afterAll(async () => {
  await Promise.all(fixtures.map((fixture) => fixture.cleanup()));
  await cleanupVisionFixtures();
});

async function fixture(): Promise<GroundingFixture> {
  const created = await newGroundingFixture();
  fixtures.push(created);
  return created;
}

describe("第 1 道：survey corpus 资格（isCorpusEligible 既有隔离回归）", () => {
  it("reference 源不进 corpus 快照；evidence/both/rejected 语义不变", () => {
    expect(isCorpusEligible({ sourceId: "R001", sourceRole: "reference", status: "available" })).toBe(false);
    expect(isCorpusEligible({ sourceId: "S001", sourceRole: "evidence", status: "available" })).toBe(true);
    expect(isCorpusEligible({ sourceId: "S002", sourceRole: "both", status: "available" })).toBe(true);
    expect(isCorpusEligible({ sourceId: "X001", sourceRole: "evidence", status: "rejected" })).toBe(false);
    const rows = buildCorpusRows(
      [
        { sourceId: "S001", sourceRole: "evidence", status: "available", fileName: "a.pdf" },
        { sourceId: "R001", sourceRole: "reference", status: "available", fileName: "r.pdf" },
      ],
      null,
    );
    expect(rows.map((row) => row.sourceId)).toEqual(["S001"]);
  });
});

describe("第 1 道增补：evidence 供给链 role 过滤（propose / targeted grounding）", () => {
  it("propose：reference 源的 chunk 提案 → EVIDENCE_VALIDATION 拒绝，候选不入队", async () => {
    const f = await fixture();
    await f.sources.update(f.projectId, "S001", { sourceRole: "reference" });
    await expect(
      f.grounding.propose(f.projectId, {
        sourceId: "S001",
        chunkId: f.chunkId,
        claim: "RAG 降低幻觉率",
        quote: "The average factual error rate drops by 42 percent",
        proposedBy: "researcher",
      }),
    ).rejects.toMatchObject({ code: "EVIDENCE_VALIDATION" });
    expect(await f.candidates.list(f.projectId)).toHaveLength(0);
    expect(await f.evidence.query(f.projectId, { sourceId: "S001" })).toEqual([]);
  });

  it("ground：历史候选（role 过滤上线前入队）→ unverifiable(reference_source_not_evidence)，不进 EvidenceStore", async () => {
    const f = await fixture();
    // 先以合法角色提案（模拟过滤上线前的历史候选），再翻转为 reference
    const { candidate } = await f.grounding.propose(f.projectId, {
      sourceId: "S001",
      chunkId: f.chunkId,
      claim: "RAG 降低幻觉率",
      quote: "The average factual error rate drops by 42 percent",
      proposedBy: "researcher",
    });
    await f.sources.update(f.projectId, "S001", { sourceRole: "reference" });
    const result = await f.grounding.ground(f.projectId, candidate.candidateId);
    expect(result.status).toBe("unverifiable");
    expect(result.reason).toContain("reference_source_not_evidence");
    // judge 未被调用（role 检查在 Stage 1，先于三段核验）
    expect(f.judgeCalls).toHaveLength(0);
    // EvidenceStore 零记录：reference 源没有变成 verified evidence
    const records = await f.evidence.query(f.projectId, { sourceId: "S001" });
    expect(records).toEqual([]);
  });

  it("角色恢复（reference → both）后 retry 可走正常核验（role 门不是永久死刑）", async () => {
    const f = await fixture();
    const { candidate } = await f.grounding.propose(f.projectId, {
      sourceId: "S001",
      chunkId: f.chunkId,
      claim: "RAG 降低幻觉率",
      quote: "The average factual error rate drops by 42 percent",
      proposedBy: "researcher",
    });
    await f.sources.update(f.projectId, "S001", { sourceRole: "reference" });
    await f.grounding.ground(f.projectId, candidate.candidateId); // unverifiable
    await f.sources.update(f.projectId, "S001", { sourceRole: "both" });
    const retried = await f.grounding.ground(f.projectId, candidate.candidateId, { retry: true });
    expect(retried.status).toBe("verified");
    expect(await f.evidence.query(f.projectId, { sourceId: "S001" })).toHaveLength(1);
  });

  it("selectReviewerSourceIds：reference 源不进 targeted grounding 目标集", () => {
    const like = (sourceId: string, sourceRole: "evidence" | "reference" | "both") =>
      ({
        sourceId,
        sourceRole,
        origin: "USER_ADDED",
        status: "available",
        preferred: false,
        metadata: {},
        bytes: 10,
        createdAt: "",
        updatedAt: "",
      }) as import("../../src/sources/SourceStore.js").SourceItem;
    const sources = [like("S001", "evidence"), like("R001", "reference"), like("B001", "both")];
    expect(selectReviewerSourceIds("泛化意见", sources).sort()).toEqual(["B001", "S001"]);
  });
});

describe("第 3 道：vision candidateFacts 确认入口（confirmFactEvidence 服务端校验）", () => {
  it("reference 源：分析可正常执行（视觉规范参照合法），但 confirm → Evidence 被拒", async () => {
    const f = await newVisionFixture();
    const { source } = await f.sources.add(f.projectId, {
      fileName: "benchmark-ref.pdf",
      content: Buffer.from("%PDF- fake"),
      sourceRole: "reference",
    });
    await f.seedDocument(source.sourceId, [pdfFigureBlock()], { "fig-001.png": makePng(20, 20) });
    // 分析本身不受限（FigureAnalysis 是 Derived Context，不是 Evidence）
    const analyzed = await f.vision.analyze(f.projectId, source.sourceId);
    expect(analyzed.status.counts).toMatchObject({ total: 1, completed: 1 });
    // 确认入口 fail-closed：服务端校验 role（UI 不提供该动作不是防线）
    await expect(
      f.vision.confirmFactEvidence(f.projectId, source.sourceId, "B0005-F01", {
        claim: "MOTA 峰值为 82.4",
      }),
    ).rejects.toMatchObject({ code: "EVIDENCE_VALIDATION" });
    // EvidenceStore 层面零记录
    expect(await f.evidence.query(f.projectId, { sourceId: source.sourceId })).toEqual([]);
  });
});

describe("EvidenceStore 层面：reference sourceId 无法经任何普通路径留下 verified 记录", () => {
  it("propose（拒）+ ground（unverifiable）+ confirmFactEvidence（拒）后：evidence.jsonl 无该源记录", async () => {
    const f = await fixture();
    await f.sources.update(f.projectId, "S001", { sourceRole: "reference" });
    // 直接构造历史候选（绕过 propose 的 role 门——模拟极端遗留数据）
    const contentHash = sha256Hex("legacy chunk text for reference source").slice(0, 10);
    const legacyChunk: SourceChunk = {
      chunkId: `S001:SEC02:0001:${contentHash}`,
      projectId: f.projectId,
      sourceId: "S001",
      sectionId: "SEC02",
      sectionTitle: "Legacy",
      ordinal: 1,
      text: "legacy chunk text for reference source",
      charCount: 34,
      tokenCount: 6,
      contentHash,
      generatedAt: new Date().toISOString(),
    };
    await f.chunkStore.writeChunks(f.projectId, "S001", [legacyChunk]);
    const legacy = await f.candidates.append(f.projectId, {
      sourceId: "S001",
      chunkId: legacyChunk.chunkId,
      claim: "遗留 claim",
      quote: "legacy chunk text for reference source",
      proposedBy: "legacy-path",
    });
    const outcome = await f.grounding.ground(f.projectId, legacy.candidateId);
    expect(outcome.status).toBe("unverifiable");
    const stats = await f.evidence.stats(f.projectId);
    expect(stats.total).toBe(0); // EvidenceStore 层面：零记录
  });
});
