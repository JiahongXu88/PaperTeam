/**
 * EvidenceCandidateStore 测试（M6.5）：
 * 候选追加 / 查询 / 受控状态转换（markResolved）/ 终态保护 / 项目隔离。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { EvidenceValidationError } from "../../src/errors.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";
import { EvidenceCandidateStore } from "../../src/evidence/candidates.js";

const tempRoots: string[] = [];
afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function newProject(): Promise<{ store: ProjectStore; candidates: EvidenceCandidateStore; projectId: string }> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-ec-"));
  tempRoots.push(root);
  const store = new ProjectStore({ root });
  const project = await store.create("候选测试");
  return { store, candidates: new EvidenceCandidateStore(store), projectId: project.id };
}

describe("EvidenceCandidateStore：追加与查询", () => {
  it("追加生成递增 id，初始 pending；必填字段校验", async () => {
    const { candidates, projectId } = await newProject();
    const first = await candidates.append(projectId, {
      sourceId: "S001",
      chunkId: "S001:SEC01:0001:aaaaaaaaaa",
      claim: "RAG 降低幻觉率",
      quote: "hallucination drops significantly",
      proposedBy: "researcher",
    });
    const second = await candidates.append(projectId, {
      sourceId: "S001",
      chunkId: "S001:SEC01:0002:bbbbbbbbbb",
      claim: "第二条候选",
      quote: "another verbatim quote",
      proposedBy: "researcher:tools",
    });
    expect(first.candidateId).toBe("EC001");
    expect(first.status).toBe("pending");
    expect(second.candidateId).toBe("EC002");
    expect(first.projectId).toBe(projectId);

    await expect(
      candidates.append(projectId, {
        sourceId: "S001",
        chunkId: "S001:SEC01:0001:aaaaaaaaaa",
        claim: "  ",
        quote: "q",
        proposedBy: "researcher",
      }),
    ).rejects.toBeInstanceOf(EvidenceValidationError);
    await expect(
      candidates.append(projectId, {
        sourceId: "S001",
        chunkId: "S001:SEC01:0001:aaaaaaaaaa",
        claim: "c",
        quote: "",
        proposedBy: "researcher",
      }),
    ).rejects.toBeInstanceOf(EvidenceValidationError);
  });

  it("按 status / sourceId / chunkId / claimContains 过滤；项目隔离", async () => {
    const { candidates, projectId } = await newProject();
    const other = await newProject();
    await candidates.append(projectId, {
      sourceId: "S001",
      chunkId: "S001:SEC01:0001:aaaaaaaaaa",
      claim: "检索质量影响幻觉",
      quote: "quote one",
      proposedBy: "researcher",
    });
    await candidates.append(projectId, {
      sourceId: "S002",
      chunkId: "S002:SEC02:0001:bbbbbbbbbb",
      claim: "重排策略最稳健",
      quote: "quote two",
      proposedBy: "researcher",
    });
    await other.candidates.append(other.projectId, {
      sourceId: "S001",
      chunkId: "S001:SEC01:0001:aaaaaaaaaa",
      claim: "另一个项目的候选",
      quote: "quote three",
      proposedBy: "researcher",
    });

    expect(await candidates.query(projectId, { status: "pending" })).toHaveLength(2);
    expect(await candidates.query(projectId, { sourceId: "S002" })).toHaveLength(1);
    expect(await candidates.query(projectId, { claimContains: "重排" })).toHaveLength(1);
    expect(await candidates.query(projectId, { chunkId: "S001:SEC01:0001:aaaaaaaaaa" })).toHaveLength(1);
    expect((await candidates.list(projectId)).map((c) => c.candidateId)).toEqual(["EC001", "EC002"]);
    // 项目隔离：本项目 store 看不到 other 项目的候选；other 项目自身可见
    expect(await candidates.query(other.projectId, { status: "pending" })).toHaveLength(0);
    expect(await other.candidates.query(other.projectId, { status: "pending" })).toHaveLength(1);

    const stats = await candidates.stats(projectId);
    expect(stats.total).toBe(2);
    expect(stats.byStatus.pending).toBe(2);
  });
});

describe("EvidenceCandidateStore：受控状态转换", () => {
  it("pending → 终态可转；终态不可再变；verified 必须带 evidenceId", async () => {
    const { candidates, projectId } = await newProject();
    const created = await candidates.append(projectId, {
      sourceId: "S001",
      chunkId: "S001:SEC01:0001:aaaaaaaaaa",
      claim: "c",
      quote: "q",
      proposedBy: "researcher",
    });

    const verified = await candidates.markResolved(projectId, created.candidateId, {
      status: "verified",
      evidenceId: "E001",
      judgeVerdict: "supported",
      judgeReason: "原文明确支撑",
      metadataOutcome: "match",
    });
    expect(verified.status).toBe("verified");
    expect(verified.evidenceId).toBe("E001");
    expect(verified.judgeVerdict).toBe("supported");
    expect(verified.updatedAt).toBeDefined();

    // 终态保护：verified 之后再转换 → 拒绝
    await expect(
      candidates.markResolved(projectId, created.candidateId, { status: "rejected" }),
    ).rejects.toBeInstanceOf(EvidenceValidationError);

    // verified 必须带 evidenceId
    const second = await candidates.append(projectId, {
      sourceId: "S001",
      chunkId: "S001:SEC01:0002:bbbbbbbbbb",
      claim: "c2",
      quote: "q2",
      proposedBy: "researcher",
    });
    await expect(
      candidates.markResolved(projectId, second.candidateId, { status: "verified" }),
    ).rejects.toBeInstanceOf(EvidenceValidationError);

    // unverifiable 可以 retry（→ 终态）
    const third = await candidates.append(projectId, {
      sourceId: "S001",
      chunkId: "S001:SEC01:0003:cccccccccc",
      claim: "c3",
      quote: "q3",
      proposedBy: "researcher",
    });
    await candidates.markResolved(projectId, third.candidateId, {
      status: "unverifiable",
      statusReason: "judge_failed（测试）",
    });
    const retried = await candidates.markResolved(projectId, third.candidateId, {
      status: "mismatch",
      statusReason: "quote_not_found_in_chunk",
    });
    expect(retried.status).toBe("mismatch");

    await expect(
      candidates.markResolved(projectId, "EC999", { status: "rejected" }),
    ).rejects.toBeInstanceOf(EvidenceValidationError);
  });
});
