/**
 * M15.4.3（P1）CandidateProposer Shadow 编排单元测试（零模型；proposeClaimCandidate 以 stub 注入）。
 * 覆盖任务书 §六必测场景的模块层：无 claim（NO_CLAIMS）、合法 claim（EVALUATED 全链 + 规则基线）、
 * 模型 JSON 错误（解析重试一次 → 仍败则按解析失败记录）、同身份复用（零新调用）、输入变更（新身份重跑）、
 * 预算耗尽（BUDGET_EXHAUSTED）、单 claim 异常（FAILED 不上抛）。
 */
import { describe, expect, it } from "vitest";
import { runCandidateShadowStage, selectShadowClaims, CANDIDATE_SHADOW_SCHEMA, type CandidateShadowArtifact } from "../../src/review/candidateShadow.js";
import type { ClaimAuditArtifact, ReviewClaimRecord } from "../../src/review/claimAudit.js";

const DOC = [
  "\\title{DeepTrack UAV Detection}",
  "\\section{Results}",
  "Our tracker obtains 42.7\\% mAP 50 on DroneSet.",
  "\\begin{table}[t]\\caption{Comparison on DroneSet.}\\label{tab:main}",
  "\\begin{tabular}{lc}\\toprule Method & mAP 50 \\\\ \\midrule Proposed & 42.7 \\\\ Baseline & 39.9 \\\\ \\bottomrule \\end{tabular}\\end{table}",
  "",
].join("\n");

function claimRecord(overrides: Partial<ReviewClaimRecord> = {}): ReviewClaimRecord {
  const quote = "Our tracker obtains 42.7\\% mAP 50 on DroneSet.";
  const start = DOC.indexOf(quote);
  return {
    claimId: "cl1-abc123",
    idRule: "claim-id/v1",
    sourceRevision: 1,
    documentFingerprint: "fp-1",
    unitId: "u1",
    unitContentHash: "h",
    file: "main.tex",
    spanId: "s1",
    heading: "Results",
    location: { unitId: "u1", file: "main.tex", start, end: start + quote.length, line: 2 },
    quote,
    quoteSha256: "qsha-1",
    quoteOccurrences: 1,
    claimType: "own_result",
    linkedRefs: [],
    reviewer: { origin: "unit_claims", check: "CONSISTENT", claimValue: "42.7" },
    verificationStatus: "REVIEWER_CONSISTENT",
    basis: "MODEL_JUDGEMENT",
    verifier: { kind: "model", id: "reviewer-unit" },
    evidenceIds: [],
    downgrades: [],
    statusReason: "",
    contextCompleteness: "COMPLETE",
    crossUnitTaskIds: [],
    assessment: { severityObserved: null, blockingObserved: null, scope: null, impact: null, decision: "RESERVED_M15_2" },
    reportedBy: ["unit_claims"],
    provenance: { reused: false },
    ...overrides,
  } as ReviewClaimRecord;
}

function auditOf(claims: ReviewClaimRecord[]): ClaimAuditArtifact {
  return { claims } as unknown as ClaimAuditArtifact;
}

const PROPOSER_JSON = JSON.stringify({
  claimId: "cl1-abc123",
  subject: "ours",
  metric: "mAP 50",
  dataset: "DroneSet",
  conditions: [],
  comparison: "CONSISTENT",
  candidates: [{ tableAlias: "T1", rowAlias: "R2", colAlias: "C2", interpretation: "own row mAP 50", evidenceQuotes: ["mAP 50"] }],
});

interface Stub {
  calls: string[];
  responses: Array<{ text: string } | { error: Error }>;
  propose: (params: { projectId: string; prompt: string; sessionLabel: string; signal?: AbortSignal }) => Promise<{ text: string; taskId: string; promptSha256: string; model?: string; usage?: Record<string, unknown> }>;
}

function stubProposer(responses: Array<{ text: string } | { error: Error }>): Stub {
  const stub: Stub = {
    calls: [],
    responses,
    propose: async (params) => {
      stub.calls.push(params.prompt);
      const next = stub.responses.shift();
      if (next === undefined) throw new Error("stub exhausted");
      if ("error" in next) throw next.error;
      return { text: next.text, taskId: `t-${stub.calls.length}`, promptSha256: "psha", model: "stub-model", usage: { inputTokens: 100, outputTokens: 20 } };
    },
  };
  return stub;
}

const INPUT_BASE = {
  projectId: "p1",
  round: 1,
  revision: 1,
  documentFingerprint: "fp-1",
  certificateFiles: [{ file: "main.tex", content: DOC }],
};

describe("M15.4.3 CandidateProposer shadow stage", () => {
  it("selectShadowClaims：仅选「已定位 + CONSISTENT/INCONSISTENT + claimValue 可解析」的论断，未出具证书优先、claimId 字典序", () => {
    const eligible = claimRecord();
    const locatedButNeedsData = claimRecord({ claimId: "cl1-bbb", reviewer: { origin: "unit_claims", check: "NEEDS_AUTHOR_DATA", claimValue: "42.7" } });
    const noValue = claimRecord({ claimId: "cl1-ccc", reviewer: { origin: "unit_claims", check: "CONSISTENT", claimValue: undefined } });
    const unlocated = claimRecord({ claimId: "cl1-ddd", location: { unitId: "u1", file: "main.tex", start: null, end: null, line: null } });
    const certified = claimRecord({ claimId: "cl1-000", certificate: { outcome: "SUPPORTED" } as ReviewClaimRecord["certificate"] });
    const { selected, eligible: count } = selectShadowClaims(auditOf([eligible, locatedButNeedsData, noValue, unlocated, certified]), 4);
    expect(count).toBe(2);
    expect(selected.map((entry) => entry.record.claimId)).toEqual(["cl1-abc123", "cl1-000"]);
  });

  it("合法 claim：EVALUATED 全链（提案→解析→核验→规则基线→usage），产物 schema 与 SHADOW 声明", async () => {
    const stub = stubProposer([{ text: PROPOSER_JSON }]);
    const artifact = await runCandidateShadowStage({ ...INPUT_BASE, claimAudit: auditOf([claimRecord()]) }, { proposeClaimCandidate: stub.propose }, null);
    expect(artifact.schema).toBe(CANDIDATE_SHADOW_SCHEMA);
    expect(artifact.authority).toBe("SHADOW_OBSERVATION_ONLY");
    expect(artifact.status).toBe("COMPLETED");
    expect(artifact.summary).toMatchObject({ selected: 1, evaluated: 1, calls: 1 });
    const entry = artifact.claims[0]!;
    expect(entry.status).toBe("EVALUATED");
    expect(entry.verification?.status).toBe("ACCEPTED");
    const verification = entry.verification;
    if (verification?.status === "ACCEPTED") expect(verification.outcome).toBe("SUPPORTED");
    expect(entry.proposalEcho?.resolvedCell?.rowKey).toEqual(["Proposed"]);
    expect(entry.ruleBaseline?.bindingStatus).toBe("UNIQUE");
    expect(entry.usage?.calls).toBe(1);
    expect(entry.usage?.inputTokens).toBe(100);
    expect(stub.calls).toHaveLength(1);
    expect(stub.calls[0]).toContain("CLAIM cl1-abc123");
  });

  it("无 claim：NO_CLAIMS / NOT_EVALUATED，零调用", async () => {
    const stub = stubProposer([]);
    const artifact = await runCandidateShadowStage({ ...INPUT_BASE, claimAudit: auditOf([]) }, { proposeClaimCandidate: stub.propose }, null);
    expect(artifact.status).toBe("SKIPPED");
    expect(artifact.statusReason).toContain("NO_CLAIMS");
    expect(stub.calls).toHaveLength(0);
  });

  it("模型 JSON 错误：解析失败重试一次；仍败则记录 parseError、核验按不可解析弃判", async () => {
    const stub = stubProposer([{ text: "not json at all" }, { text: "{ broken" }]);
    const artifact = await runCandidateShadowStage({ ...INPUT_BASE, claimAudit: auditOf([claimRecord()]) }, { proposeClaimCandidate: stub.propose }, null);
    expect(stub.calls).toHaveLength(2);
    const entry = artifact.claims[0]!;
    expect(entry.status).toBe("EVALUATED");
    expect(entry.attempts).toBe(2);
    expect(entry.parseError).toBeTruthy();
    expect(entry.verification).toBeUndefined();
    expect(entry.proposalEcho).toBeUndefined();
    expect(artifact.summary.abstained).toBe(0);
  });

  it("同请求身份复用（resume/重试零新调用）；输入变更（claimValue）→ 新身份重跑", async () => {
    const stub = stubProposer([{ text: PROPOSER_JSON }]);
    const claim = claimRecord();
    const first = await runCandidateShadowStage({ ...INPUT_BASE, claimAudit: auditOf([claim]) }, { proposeClaimCandidate: stub.propose }, null);
    expect(first.summary.evaluated).toBe(1);
    const stub2 = stubProposer([]);
    const second = await runCandidateShadowStage({ ...INPUT_BASE, claimAudit: auditOf([claim]) }, { proposeClaimCandidate: stub2.propose }, first as CandidateShadowArtifact);
    expect(second.claims[0]!.status).toBe("REUSED");
    expect(second.summary.reused).toBe(1);
    expect(stub2.calls).toHaveLength(0);
    expect(second.summary.calls).toBe(1);
    const changed = claimRecord({ reviewer: { origin: "unit_claims", check: "CONSISTENT", claimValue: "42.8" } });
    const stub3 = stubProposer([{ text: PROPOSER_JSON }]);
    const third = await runCandidateShadowStage({ ...INPUT_BASE, claimAudit: auditOf([changed]) }, { proposeClaimCandidate: stub3.propose }, first as CandidateShadowArtifact);
    expect(third.claims[0]!.status).toBe("EVALUATED");
    expect(third.claims[0]!.requestId).not.toBe(first.claims[0]!.requestId);
    expect(stub3.calls).toHaveLength(1);
  });

  it("预算耗尽：超出 maxCallsPerRun 的论断记 BUDGET_EXHAUSTED，不再调用", async () => {
    const claims = ["cl1-a", "cl1-b", "cl1-c"].map((claimId, index) => claimRecord({ claimId, location: { unitId: "u1", file: "main.tex", start: 30, end: 70, line: 2 + index } }));
    const stub = stubProposer([{ text: PROPOSER_JSON }, { text: PROPOSER_JSON }]);
    const artifact = await runCandidateShadowStage({ ...INPUT_BASE, claimAudit: auditOf(claims) }, { proposeClaimCandidate: stub.propose }, null, { maxClaims: 3, maxCallsPerRun: 2 });
    expect(artifact.claims.map((entry) => entry.status)).toEqual(["EVALUATED", "EVALUATED", "SKIPPED"]);
    expect(artifact.claims[2]!.skipReason).toBe("BUDGET_EXHAUSTED");
    expect(artifact.summary.calls).toBe(2);
  });

  it("单 claim 异常：FAILED 条目 + PARTIAL，不上抛；下一条照常执行", async () => {
    const a = claimRecord({ claimId: "cl1-a", location: { unitId: "u1", file: "main.tex", start: 30, end: 70, line: 2 } });
    const b = claimRecord({ claimId: "cl1-b", location: { unitId: "u1", file: "main.tex", start: 30, end: 70, line: 3 } });
    const stub = stubProposer([{ error: new Error("boom at provider") }, { text: PROPOSER_JSON }]);
    const artifact = await runCandidateShadowStage({ ...INPUT_BASE, claimAudit: auditOf([a, b]) }, { proposeClaimCandidate: stub.propose }, null);
    expect(artifact.status).toBe("PARTIAL");
    expect(artifact.claims[0]!.status).toBe("FAILED");
    expect(artifact.claims[0]!.error).toContain("boom");
    expect(artifact.claims[1]!.status).toBe("EVALUATED");
  });

  it("取消（aborted）：直接上抛（与主链取消同语义）", async () => {
    const controller = new AbortController();
    controller.abort();
    const stub = stubProposer([]);
    await expect(runCandidateShadowStage(
      { ...INPUT_BASE, claimAudit: auditOf([claimRecord()]), signal: controller.signal },
      { proposeClaimCandidate: async () => { throw new Error("WORKFLOW_CANCELLED"); } },
      null,
    )).rejects.toThrow("WORKFLOW_CANCELLED");
    expect(stub.calls).toHaveLength(0);
  });
});
