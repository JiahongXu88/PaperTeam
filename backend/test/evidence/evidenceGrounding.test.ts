/**
 * EvidenceGroundingService 行为测试（M6.5 三段核验管道）：
 * - 提案：合法候选 / 非法 chunkId / chunk 不存在 / quote 缺失 / 同文去重
 * - Stage 1：精确 quote / 归一化 quote / 错误 quote → mismatch
 * - Stage 2：metadata match / mismatch / unresolved（离线不阻塞）
 * - Stage 3：judge supported / partially_supported / unsupported / 失败 / 垃圾输出 /
 *   insufficient_evidence；judge 只见 claim+quote+chunk
 * - 生命周期：pending → verified / rejected / unverifiable（retry）/ 幂等
 * - 安全：候选不经过核验绝不进 EvidenceStore；verified 记录只产生一次
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { BusinessError, EvidenceValidationError } from "../../src/errors.js";
import { parseEvidenceJudgeOutput, buildEvidenceJudgePrompt } from "../../src/evidence/evidenceJudge.js";
import {
  canonicalRecord,
  CHUNK_TEXT,
  fakeScholarlyProvider,
  newGroundingFixture,
  supportedJson,
  type FixtureOptions,
  type GroundingFixture,
} from "./fixtures.js";

const fixtures: GroundingFixture[] = [];
afterAll(async () => {
  await Promise.all(fixtures.map((fixture) => fixture.cleanup()));
});

async function fixture(options: FixtureOptions = {}): Promise<GroundingFixture> {
  const created = await newGroundingFixture(options);
  fixtures.push(created);
  return created;
}

const GOOD_QUOTE = "The average factual error rate drops by 42 percent";
const CLAIM = "RAG 能显著降低开放域问答中的幻觉率";

async function evidenceLines(fixture: GroundingFixture): Promise<unknown[]> {
  try {
    const raw = await readFile(
      join(fixture.projects.evidenceDir(fixture.projectId), "evidence.jsonl"),
      "utf8",
    );
    return raw.trim() === "" ? [] : raw.trim().split("\n").map((line) => JSON.parse(line));
  } catch {
    return [];
  }
}

describe("propose：候选提案校验", () => {
  it("合法候选入队（pending），不写 EvidenceStore", async () => {
    const f = await fixture();
    const { candidate, deduplicated } = await f.grounding.propose(f.projectId, {
      sourceId: "S001",
      chunkId: f.chunkId,
      claim: CLAIM,
      quote: GOOD_QUOTE,
      proposedBy: "researcher",
    });
    expect(candidate.candidateId).toBe("EC001");
    expect(candidate.status).toBe("pending");
    expect(deduplicated).toBe(false);
    expect(await evidenceLines(f)).toHaveLength(0); // 不能绕过核验直接进证据库
  });

  it("非法 chunkId 格式 → INVALID_CHUNK_ID；不存在的 chunk → CHUNK_NOT_FOUND", async () => {
    const f = await fixture();
    await expect(
      f.grounding.propose(f.projectId, {
        sourceId: "S001",
        chunkId: "not-a-chunk-id",
        claim: CLAIM,
        quote: GOOD_QUOTE,
        proposedBy: "researcher",
      }),
    ).rejects.toMatchObject({ code: "INVALID_CHUNK_ID" });
    // 格式合法但 hash 不存在（chunk 未落盘）
    await expect(
      f.grounding.propose(f.projectId, {
        sourceId: "S001",
        chunkId: "S001:SEC01:0009:0000000000",
        claim: CLAIM,
        quote: GOOD_QUOTE,
        proposedBy: "researcher",
      }),
    ).rejects.toMatchObject({ code: "CHUNK_NOT_FOUND" });
    expect((await f.candidates.list(f.projectId))).toHaveLength(0);
  });

  it("sourceId 与 chunkId 前缀不一致 / quote 缺失或过短 → 拒绝", async () => {
    const f = await fixture();
    await expect(
      f.grounding.propose(f.projectId, {
        sourceId: "S002",
        chunkId: f.chunkId,
        claim: CLAIM,
        quote: GOOD_QUOTE,
        proposedBy: "researcher",
      }),
    ).rejects.toBeInstanceOf(EvidenceValidationError);
    await expect(
      f.grounding.propose(f.projectId, {
        sourceId: "S001",
        chunkId: f.chunkId,
        claim: CLAIM,
        quote: "   ",
        proposedBy: "researcher",
      }),
    ).rejects.toBeInstanceOf(EvidenceValidationError);
    await expect(
      f.grounding.propose(f.projectId, {
        sourceId: "S001",
        chunkId: f.chunkId,
        claim: CLAIM,
        quote: "ab",
        proposedBy: "researcher",
      }),
    ).rejects.toBeInstanceOf(EvidenceValidationError);
  });

  it("完全同文的 pending 候选去重复用", async () => {
    const f = await fixture();
    const first = await f.grounding.propose(f.projectId, {
      sourceId: "S001",
      chunkId: f.chunkId,
      claim: CLAIM,
      quote: GOOD_QUOTE,
      proposedBy: "researcher",
    });
    const second = await f.grounding.propose(f.projectId, {
      sourceId: "S001",
      chunkId: f.chunkId,
      claim: CLAIM,
      quote: GOOD_QUOTE,
      proposedBy: "researcher",
    });
    expect(second.deduplicated).toBe(true);
    expect(second.candidate.candidateId).toBe(first.candidate.candidateId);
    expect(await f.candidates.list(f.projectId)).toHaveLength(1);
  });
});

describe("ground：三段核验生命周期", () => {
  it("全通过 → verified：EvidenceRecord 字段完整（quote 精确 + metadata match + judge supported）", async () => {
    const f = await fixture({
      provider: fakeScholarlyProvider(async () => ({
        kind: "match",
        record: canonicalRecord(),
      })),
    });
    const { candidate } = await f.grounding.propose(f.projectId, {
      sourceId: "S001",
      chunkId: f.chunkId,
      claim: CLAIM,
      quote: GOOD_QUOTE,
      summary: "综述汇总",
      proposedBy: "researcher",
    });
    const result = await f.grounding.ground(f.projectId, candidate.candidateId);
    expect(result.status).toBe("verified");
    expect(result.evidenceId).toBe("E001");

    const stored = await f.candidates.get(f.projectId, candidate.candidateId);
    expect(stored).toMatchObject({
      status: "verified",
      evidenceId: "E001",
      judgeVerdict: "supported",
      metadataOutcome: "match",
    });

    const [record] = await evidenceLines(f) as Array<Record<string, unknown>>;
    expect(record).toMatchObject({
      id: "E001",
      claim: CLAIM,
      quote: GOOD_QUOTE,
      verificationStatus: "verified",
      supportStrength: "direct",
      verificationLevel: "fulltext",
      createdBy: "researcher",
    });
    expect(String(record!["verificationMethod"])).toContain("judge=supported");
    expect(String(record!["verificationMethod"])).toContain("metadata=match");
    expect(record!["location"]).toMatchObject({ chunk: f.chunkId, section: "Introduction", page: 3 });
    expect(record!["source"]).toMatchObject({ sourceId: "S001", title: "A Survey of Retrieval-Augmented Generation", year: 2023 });

    // judge 调用口径：citation 角色 scope，prompt 只含 claim + quote + chunk 原文
    expect(f.judgeCalls).toHaveLength(1);
    expect(f.judgeCalls[0]!.scope).toBe("citation/evidence/ec001");
    const task = f.judgeCalls[0]!.task;
    expect(task).toContain(CLAIM);
    expect(task).toContain(GOOD_QUOTE);
    expect(task).toContain(CHUNK_TEXT.slice(0, 60));
  });

  it("归一化 quote（大小写 / 跨行空白）同样通过 Stage 1", async () => {
    const f = await fixture();
    const { candidate } = await f.grounding.propose(f.projectId, {
      sourceId: "S001",
      chunkId: f.chunkId,
      claim: CLAIM,
      quote: "the AVERAGE factual error rate   drops by 42 percent",
      proposedBy: "researcher",
    });
    const result = await f.grounding.ground(f.projectId, candidate.candidateId);
    expect(result.status).toBe("verified");
  });

  it("错误 quote（改写数字）→ mismatch（quote_not_found_in_chunk），不进证据库", async () => {
    const f = await fixture();
    const { candidate } = await f.grounding.propose(f.projectId, {
      sourceId: "S001",
      chunkId: f.chunkId,
      claim: CLAIM,
      quote: "The average factual error rate drops by 99 percent",
      proposedBy: "researcher",
    });
    const result = await f.grounding.ground(f.projectId, candidate.candidateId);
    expect(result.status).toBe("mismatch");
    expect(result.reason).toContain("quote_not_found_in_chunk");
    expect(await evidenceLines(f)).toHaveLength(0);
    // mismatch 是终态：不可重试
    await expect(
      f.grounding.ground(f.projectId, candidate.candidateId, { retry: true }),
    ).rejects.toBeInstanceOf(EvidenceValidationError);
  });

  it("metadata mismatch（外部库同 DOI 不同标题）→ mismatch（metadata_mismatch）", async () => {
    const f = await fixture({
      provider: fakeScholarlyProvider(async () => ({
        kind: "match",
        record: canonicalRecord({ title: "A Completely Different Paper About Cats", year: 2019 }),
      })),
    });
    const { candidate } = await f.grounding.propose(f.projectId, {
      sourceId: "S001",
      chunkId: f.chunkId,
      claim: CLAIM,
      quote: GOOD_QUOTE,
      proposedBy: "researcher",
    });
    const result = await f.grounding.ground(f.projectId, candidate.candidateId);
    expect(result.status).toBe("mismatch");
    expect(result.reason).toContain("metadata_mismatch");
    expect(f.judgeCalls).toHaveLength(0); // 确定性失败短路，不进 judge
    expect(await evidenceLines(f)).toHaveLength(0);
  });

  it("metadata 无 provider（离线部署）→ unresolved 如实记录但不阻塞核验", async () => {
    const f = await fixture(); // 无 provider
    const { candidate } = await f.grounding.propose(f.projectId, {
      sourceId: "S001",
      chunkId: f.chunkId,
      claim: CLAIM,
      quote: GOOD_QUOTE,
      proposedBy: "researcher",
    });
    const result = await f.grounding.ground(f.projectId, candidate.candidateId);
    expect(result.status).toBe("verified");
    const stored = await f.candidates.get(f.projectId, candidate.candidateId);
    expect(stored?.metadataOutcome).toBe("unresolved");
    const [record] = await evidenceLines(f) as Array<Record<string, unknown>>;
    expect(String(record!["verificationMethod"])).toContain("metadata=unresolved");
  });

  it("judge unsupported → rejected（judge_unsupported），不进证据库", async () => {
    const f = await fixture({
      judge: () =>
        JSON.stringify({ verdict: "unsupported", reason: "段落只讨论 RAG，未涉及该具体数字" }),
    });
    const { candidate } = await f.grounding.propose(f.projectId, {
      sourceId: "S001",
      chunkId: f.chunkId,
      claim: "某 unrelated 论断",
      quote: GOOD_QUOTE,
      proposedBy: "researcher",
    });
    const result = await f.grounding.ground(f.projectId, candidate.candidateId);
    expect(result.status).toBe("rejected");
    expect(result.reason).toContain("judge_unsupported");
    expect(result.judgeVerdict).toBe("unsupported");
    expect(await evidenceLines(f)).toHaveLength(0);
  });

  it("judge partially_supported → verified 且 supportStrength=partial", async () => {
    const f = await fixture({
      judge: () => JSON.stringify({ verdict: "partially_supported", reason: "支撑一半" }),
    });
    const { candidate } = await f.grounding.propose(f.projectId, {
      sourceId: "S001",
      chunkId: f.chunkId,
      claim: CLAIM,
      quote: GOOD_QUOTE,
      proposedBy: "researcher",
    });
    await f.grounding.ground(f.projectId, candidate.candidateId);
    const [record] = await evidenceLines(f) as Array<Record<string, unknown>>;
    expect(record!["supportStrength"]).toBe("partial");
  });

  it("judge 任务失败 → unverifiable；retry 后可转正", async () => {
    const f = await fixture({ judge: () => ({ fail: true, error: "provider 503" }) });
    const { candidate } = await f.grounding.propose(f.projectId, {
      sourceId: "S001",
      chunkId: f.chunkId,
      claim: CLAIM,
      quote: GOOD_QUOTE,
      proposedBy: "researcher",
    });
    const failed = await f.grounding.ground(f.projectId, candidate.candidateId);
    expect(failed.status).toBe("unverifiable");
    expect(failed.reason).toContain("judge_failed");
    expect(await evidenceLines(f)).toHaveLength(0);

    // runtime 恢复 → retry 重核验 → verified
    f.setJudge(() => supportedJson());
    const retried = await f.grounding.ground(f.projectId, candidate.candidateId, { retry: true });
    expect(retried.status).toBe("verified");
    expect(await evidenceLines(f)).toHaveLength(1);
  });

  it("judge 垃圾输出 / 非法 verdict → unverifiable（judge_failed）；insufficient_evidence → unverifiable（judge_inconclusive）", async () => {
    const f = await fixture({ judge: () => ({ raw: "I think this is fine, not JSON" }) });
    const first = await f.grounding.propose(f.projectId, {
      sourceId: "S001",
      chunkId: f.chunkId,
      claim: CLAIM,
      quote: GOOD_QUOTE,
      proposedBy: "researcher",
    });
    const bad = await f.grounding.ground(f.projectId, first.candidate.candidateId);
    expect(bad.status).toBe("unverifiable");
    expect(bad.reason).toContain("judge_failed");

    const second = await f.grounding.propose(f.projectId, {
      sourceId: "S001",
      chunkId: f.chunkId,
      claim: "另一个论断",
      quote: GOOD_QUOTE,
      proposedBy: "researcher",
    });
    f.setJudge(() => JSON.stringify({ verdict: "insufficient_evidence", reason: "段落与论断无法建立可判关系" }));
    const inconclusive = await f.grounding.ground(f.projectId, second.candidate.candidateId);
    expect(inconclusive.status).toBe("unverifiable");
    expect(inconclusive.reason).toContain("judge_inconclusive");
    expect(await evidenceLines(f)).toHaveLength(0);
  });

  it("ground 时 chunk 已消失 → unverifiable（可重建后 retry）", async () => {
    const f = await fixture();
    const { candidate } = await f.grounding.propose(f.projectId, {
      sourceId: "S001",
      chunkId: f.chunkId,
      claim: CLAIM,
      quote: GOOD_QUOTE,
      proposedBy: "researcher",
    });
    await f.chunkStore.removeAll(f.projectId); // derived state 被清空
    const result = await f.grounding.ground(f.projectId, candidate.candidateId);
    expect(result.status).toBe("unverifiable");
    expect(String(result.reason)).toContain("chunk_not_found");
  });

  it("verified 幂等：重复 ground 不产生第二条 EvidenceRecord", async () => {
    const f = await fixture();
    const { candidate } = await f.grounding.propose(f.projectId, {
      sourceId: "S001",
      chunkId: f.chunkId,
      claim: CLAIM,
      quote: GOOD_QUOTE,
      proposedBy: "researcher",
    });
    await f.grounding.ground(f.projectId, candidate.candidateId);
    const again = await f.grounding.ground(f.projectId, candidate.candidateId);
    expect(again.status).toBe("verified");
    expect(again.evidenceId).toBe("E001");
    expect(await evidenceLines(f)).toHaveLength(1);
  });

  it("judge runtime 未注入 → unverifiable（judge_unavailable），不阻塞其余管道", async () => {
    const f = await fixture({ withoutJudge: true });
    const { candidate } = await f.grounding.propose(f.projectId, {
      sourceId: "S001",
      chunkId: f.chunkId,
      claim: CLAIM,
      quote: GOOD_QUOTE,
      proposedBy: "researcher",
    });
    const result = await f.grounding.ground(f.projectId, candidate.candidateId);
    expect(result.status).toBe("unverifiable");
    expect(result.reason).toContain("judge_unavailable");
  });
});

describe("groundPending：批量与汇总", () => {
  it("多候选一次核验：计数正确；单条失败不影响其余", async () => {
    const f = await fixture({
      judge: (scope) => {
        // EC002 判 unsupported，其余 supported
        return scope.endsWith("ec002")
          ? JSON.stringify({ verdict: "unsupported", reason: "不支撑" })
          : supportedJson();
      },
    });
    await f.grounding.propose(f.projectId, {
      sourceId: "S001",
      chunkId: f.chunkId,
      claim: "论断一",
      quote: GOOD_QUOTE,
      proposedBy: "researcher",
    });
    await f.grounding.propose(f.projectId, {
      sourceId: "S001",
      chunkId: f.chunkId,
      claim: "论断二",
      quote: GOOD_QUOTE,
      proposedBy: "researcher",
    });
    await f.grounding.propose(f.projectId, {
      sourceId: "S001",
      chunkId: f.chunkId,
      claim: "论断三",
      quote: "a completely fabricated quote not in the source",
      proposedBy: "researcher",
    });
    const summary = await f.grounding.groundPending(f.projectId);
    expect(summary).toMatchObject({
      pending: 3,
      processed: 3,
      verified: 1,
      mismatch: 1,
      rejected: 1,
      unverifiable: 0,
      evidenceAppended: 1,
    });
    const stats = await f.grounding.candidateStats(f.projectId);
    expect(stats.byStatus.pending).toBe(0); // DoD 口径
  });

  it("不存在的候选 → NOT_FOUND；pending 以外的终态候选拒绝再次 ground", async () => {
    const f = await fixture();
    await expect(f.grounding.ground(f.projectId, "EC404")).rejects.toMatchObject({
      code: "NOT_FOUND",
    });
    const { candidate } = await f.grounding.propose(f.projectId, {
      sourceId: "S001",
      chunkId: f.chunkId,
      claim: CLAIM,
      quote: "definitely not present in the chunk text",
      proposedBy: "researcher",
    });
    await f.grounding.ground(f.projectId, candidate.candidateId);
    await expect(f.grounding.ground(f.projectId, candidate.candidateId)).rejects.toBeInstanceOf(
      EvidenceValidationError,
    );
    expect(new BusinessError("INVALID_REQUEST", "x").name).toBe("BusinessError");
  });
});

describe("evidenceJudge：解析与引文守卫", () => {
  it("合法 verdict 解析；非法 verdict 抛错；伪造 keyQuote 剥离、真实 keyQuote 保留", () => {
    const parsed = parseEvidenceJudgeOutput(
      JSON.stringify({ verdict: "supported", reason: "r", keyQuote: "The average factual error rate drops by 42 percent" }),
      CHUNK_TEXT,
    );
    expect(parsed.verdict).toBe("supported");
    expect(parsed.keyQuote).toBe("The average factual error rate drops by 42 percent");

    const fabricated = parseEvidenceJudgeOutput(
      JSON.stringify({ verdict: "supported", reason: "r", keyQuote: "this quote is invented by the judge" }),
      CHUNK_TEXT,
    );
    expect(fabricated.keyQuote).toBeUndefined();

    expect(() =>
      parseEvidenceJudgeOutput(JSON.stringify({ verdict: "SUPPORTED", reason: "r" }), CHUNK_TEXT),
    ).toThrow();
    expect(() => parseEvidenceJudgeOutput("not json at all", CHUNK_TEXT)).toThrow();
  });

  it("judge prompt 只含 claim / quote / chunk，不含来源 digest 或其它证据", () => {
    const prompt = buildEvidenceJudgePrompt({
      claim: CLAIM,
      quote: GOOD_QUOTE,
      chunkText: CHUNK_TEXT,
      sourceLine: "A Survey of Retrieval-Augmented Generation（2023）",
    });
    expect(prompt).toContain(CLAIM);
    expect(prompt).toContain(GOOD_QUOTE);
    expect(prompt).toContain(CHUNK_TEXT.slice(0, 80));
    expect(prompt).toContain("禁止使用自己的记忆");
    expect(prompt).not.toContain("项目文献库摘要");
  });
});
