/**
 * Evidence Selection Service 测试（M6.6）：
 * - §10 使用策略：只有 verified + sourceId + chunkId 三件套齐备才是正式证据
 * - §11 legacy unverified 不进入正式上下文（派生标识 legacy_unverified）
 * - §12 EvidenceRecord → bibliography key 关联（citation integration）
 */

import { afterAll, describe, expect, it } from "vitest";

import {
  EvidenceSelectionService,
  classifyEvidence,
  isFormalEvidence,
  FORMAL_EVIDENCE_LIMIT,
} from "../../src/evidence/EvidenceSelectionService.js";
import type { EvidenceRecord } from "../../src/evidence/EvidenceStore.js";
import { newGroundingFixture, type GroundingFixture } from "./fixtures.js";

const fixtures: GroundingFixture[] = [];
afterAll(async () => {
  await Promise.all(fixtures.map((fixture) => fixture.cleanup()));
});

async function fixture(): Promise<GroundingFixture> {
  const created = await newGroundingFixture();
  fixtures.push(created);
  return created;
}

const GOOD_QUOTE =
  "The average factual error rate drops by 42 percent when retrieval is introduced at inference time";

/** 走真实 grounding 管道产出一条 grounded verified 记录 */
async function groundOneVerified(f: GroundingFixture): Promise<EvidenceRecord> {
  const { candidate } = await f.grounding.propose(f.projectId, {
    sourceId: "S001",
    chunkId: f.chunkId,
    claim: "RAG 在推理时引入检索可降低事实错误率",
    quote: GOOD_QUOTE,
    proposedBy: "researcher",
  });
  const summary = await f.grounding.groundPending(f.projectId);
  expect(summary.verified).toBe(1);
  expect(candidate.status).toBe("pending"); // propose 只入队；状态机由 grounding 推进
  const record = await f.evidence.get(f.projectId, "E001");
  expect(record).not.toBeNull();
  return record!;
}

describe("isFormalEvidence / classifyEvidence（使用策略唯一事实源）", () => {
  it("grounded verified（真实管道产物）→ grounded_verified", async () => {
    const f = await fixture();
    const record = await groundOneVerified(f);
    expect(record.verificationStatus).toBe("verified");
    expect(record.source?.sourceId).toBe("S001");
    expect(record.location?.chunk).toBe(f.chunkId);
    expect(isFormalEvidence(record)).toBe(true);
    expect(classifyEvidence(record)).toBe("grounded_verified");
  });

  it("verified 但缺 chunk 锚点 → verified_missing_anchor（不可正式使用）", () => {
    const record: EvidenceRecord = {
      id: "E002",
      claim: "verified 无锚点",
      verificationStatus: "verified",
      source: { sourceId: "S001" },
      createdBy: "test",
      createdAt: "2026-09-17T00:00:00Z",
    };
    expect(isFormalEvidence(record)).toBe(false);
    expect(classifyEvidence(record)).toBe("verified_missing_anchor");
  });

  it("unverified → legacy_unverified；plausible/mismatch/not_found → untrusted", () => {
    const base = { claim: "c", createdBy: "test", createdAt: "2026-09-17T00:00:00Z" };
    expect(
      classifyEvidence({ ...base, id: "E1", verificationStatus: "unverified" }),
    ).toBe("legacy_unverified");
    expect(
      classifyEvidence({ ...base, id: "E2", verificationStatus: "plausible" }),
    ).toBe("untrusted");
    expect(
      classifyEvidence({ ...base, id: "E3", verificationStatus: "mismatch" }),
    ).toBe("untrusted");
    expect(
      classifyEvidence({ ...base, id: "E4", verificationStatus: "not_found" }),
    ).toBe("untrusted");
  });
});

describe("selectForWriting（正式上下文选择）", () => {
  it("formal 只含 grounded verified；legacy unverified 被排除并计数", async () => {
    const f = await fixture();
    const verified = await groundOneVerified(f);
    await f.evidence.append(
      f.projectId,
      { claim: "legacy 线索一", source: { sourceId: "S001" } },
      "researcher",
    );
    await f.evidence.append(
      f.projectId,
      { claim: "legacy 线索二", verificationStatus: "plausible", source: { sourceId: "S002" } },
      "researcher",
    );
    const selection = await new EvidenceSelectionService(f.evidence).selectForWriting(f.projectId);
    expect(selection.formal.map((record) => record.id)).toEqual([verified.id]);
    expect(selection.excluded.legacyUnverified).toBe(1);
    expect(selection.excluded.untrusted).toBe(1);
    expect(selection.excluded.verifiedMissingAnchor).toBe(0);
  });

  it("全部为 legacy 时 formal 为空（存量项目：弱化论断而非注入未核验线索）", async () => {
    const f = await fixture();
    await f.evidence.append(f.projectId, { claim: "只有 legacy" }, "researcher");
    const selection = await new EvidenceSelectionService(f.evidence).selectForWriting(f.projectId);
    expect(selection.formal).toEqual([]);
    expect(selection.excluded.legacyUnverified).toBe(1);
  });

  it("direct 支撑优先排序 + limit 截断", async () => {
    const f = await fixture();
    await f.evidence.append(
      f.projectId,
      {
        claim: "indirect 支撑",
        verificationStatus: "verified",
        supportStrength: "indirect",
        source: { sourceId: "S002" },
        location: { chunk: "S002:SEC01:0001:aaaa" },
      },
      "researcher",
    );
    await f.evidence.append(
      f.projectId,
      {
        claim: "direct 支撑",
        verificationStatus: "verified",
        supportStrength: "direct",
        source: { sourceId: "S001" },
        location: { chunk: "S001:SEC01:0001:bbbb" },
      },
      "researcher",
    );
    const full = await new EvidenceSelectionService(f.evidence).selectForWriting(f.projectId);
    expect(full.formal.map((record) => record.claim)).toEqual(["direct 支撑", "indirect 支撑"]);
    const limited = await new EvidenceSelectionService(f.evidence).selectForWriting(f.projectId, {
      limit: 1,
    });
    expect(limited.formal.map((record) => record.claim)).toEqual(["direct 支撑"]);
  });
});

describe("matchBibliographyKey（EvidenceRecord → bib key 关联）", () => {
  const entries = [
    { key: "gao2023survey", title: "A Survey of Retrieval-Augmented Generation", year: 2023, doi: "10.1000/survey" },
    { key: "lewis2020rag", title: "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks", year: 2020 },
  ];
  const base = { claim: "c", createdBy: "test", createdAt: "2026-09-17T00:00:00Z" };

  it("DOI 精确匹配（大小写不敏感）", () => {
    const key = EvidenceSelectionService.matchBibliographyKey(
      { ...base, id: "E1", verificationStatus: "verified", source: { sourceId: "S001", doi: "10.1000/SURVEY" } },
      entries,
    );
    expect(key).toBe("gao2023survey");
  });

  it("归一化 title + 年份一致命中；年份冲突不命中", () => {
    const byTitle = EvidenceSelectionService.matchBibliographyKey(
      {
        ...base,
        id: "E2",
        verificationStatus: "verified",
        source: { sourceId: "S001", title: "Retrieval-Augmented Generation for Knowledge-intensive NLP tasks", year: 2020 },
      },
      entries,
    );
    expect(byTitle).toBe("lewis2020rag");

    const yearConflict = EvidenceSelectionService.matchBibliographyKey(
      {
        ...base,
        id: "E3",
        verificationStatus: "verified",
        source: { sourceId: "S001", title: "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks", year: 2021 },
      },
      entries,
    );
    expect(yearConflict).toBeNull();
  });

  it("无匹配返回 null", () => {
    const key = EvidenceSelectionService.matchBibliographyKey(
      { ...base, id: "E4", verificationStatus: "verified", source: { sourceId: "S009", title: "无关标题" } },
      entries,
    );
    expect(key).toBeNull();
  });

  it("默认上限 FORMAL_EVIDENCE_LIMIT 保持 20（防 Evidence 淹没 Agent）", () => {
    expect(FORMAL_EVIDENCE_LIMIT).toBe(20);
  });
});
