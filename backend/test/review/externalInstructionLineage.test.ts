/**
 * M15.18 单元回归：指令 lineage 字段（origin / planItemOutcomes）、candidateStatus 状态机、
 * 旧工件读取兼容，以及 assessRewriteClosure 的 VALIDATED_FIXED 证据门（纯函数，零 IO）。
 */

import { describe, expect, it } from "vitest";

import {
  applyDispatchOutcome,
  appendPlanItemOutcome,
  isApprovedAuditRewrite,
  readExternalInstructions,
  type ExternalInstruction,
} from "../../src/review/externalInstructions.js";
import { assessRewriteClosure, type ClosurePatchEvidence } from "../../src/target/TargetAuditRevisionService.js";
import type { PatchValidationRecord } from "../../src/review/patchValidation.js";

const NOW = "2026-11-01T00:00:00.000Z";

function rewriteInstruction(overrides: Partial<ExternalInstruction> = {}): ExternalInstruction {
  return {
    instructionId: "x-rewrite0001",
    source: "target_audit",
    text: "【来源】目标期刊证据审计（advisory）\n【允许的修改】仅限弱化",
    section: "sections/sec02.tex",
    status: "pending",
    origin: {
      kind: "target_audit_rewrite", planId: "tap-1", itemId: "ta-gap-1", contributionId: "C1",
      claimQuote: "The fusion module combines", texAnchor: "The fusion module combines", targetFile: "sections/sec02.tex", approvedAt: NOW,
    },
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

const item = {
  itemId: "ta-gap-1",
  classification: "REWRITE_ELIGIBLE" as const,
  anchor: { claimQuote: "q", sectionId: "SEC02", anchorVerified: true, projection: { status: "resolved" as const, file: "sections/sec02.tex" } },
};

function patch(overrides: Partial<PatchValidationRecord> = {}): ClosurePatchEvidence {
  return {
    revision: 3,
    record: {
      patchId: "patch:aaaaaaaaaaaa", revisionId: "rev-3", file: "sections/sec02.tex", logicalTarget: "sec02#u1",
      planItemIds: ["improvement:1"], commentIds: ["x-rewrite0001"], evidenceIds: [],
      beforeFileHash: "before", beforeTargetHash: "t", proposedReplacementHash: "p", afterFileHash: "after",
      scope: { ok: true, violations: [] },
      workspaceIntegrity: { ok: true, directMutationDetected: false, recoverySucceeded: true },
      fact: { ok: true, findingIds: [], violations: [] },
      citation: { ok: true, findingIds: [], addedKeys: [], removedKeys: [], violations: [] },
      evidence: { ok: true, violations: [] },
      apply: { ok: true, status: "applied" }, overall: "pass", finalStatus: "accepted",
      ...overrides,
    },
  };
}

describe("isApprovedAuditRewrite / 旧工件兼容", () => {
  it("origin 优先；旧工件（无 origin）以【允许的修改】段识别；真人意见永远 false", () => {
    expect(isApprovedAuditRewrite(rewriteInstruction())).toBe(true);
    expect(isApprovedAuditRewrite(rewriteInstruction({ origin: { ...rewriteInstruction().origin!, kind: "target_audit_author_decision" } }))).toBe(false);
    const legacy = rewriteInstruction();
    delete legacy.origin;
    expect(isApprovedAuditRewrite(legacy)).toBe(true);
    expect(isApprovedAuditRewrite({ ...legacy, text: "【所需真实实验 / 作者输入】" })).toBe(false);
    expect(isApprovedAuditRewrite({ ...legacy, source: "journal_reviewer" })).toBe(false);
  });

  it("readExternalInstructions 往返 origin / planItemOutcomes；畸形条目丢弃；旧记录无字段照常读取", () => {
    const withOutcomes = appendPlanItemOutcome(rewriteInstruction(), { planItemId: "improvement:2", outcome: "author_decision", summary: "s", at: NOW });
    const legacy = { instructionId: "x-legacy00001", source: "user", text: "t", status: "pending", createdAt: NOW };
    const read = readExternalInstructions({
      instructions: [
        { ...withOutcomes, planItemOutcomes: [...withOutcomes.planItemOutcomes!, { planItemId: 1, outcome: "bogus" }] },
        legacy,
      ],
    });
    expect(read[0]!.origin?.texAnchor).toBe("The fusion module combines");
    expect(read[0]!.planItemOutcomes).toEqual([{ planItemId: "improvement:2", outcome: "author_decision", summary: "s", at: NOW }]);
    expect(read[1]!.origin).toBeUndefined();
    expect(read[1]!.planItemOutcomes).toBeUndefined();
  });

  it("appendPlanItemOutcome 同子条+结果+修订号去重（重试 / 恢复不重复计数）", () => {
    let next = rewriteInstruction();
    for (let i = 0; i < 3; i += 1) next = appendPlanItemOutcome(next, { planItemId: "improvement:1", outcome: "applied", summary: `try ${i}`, revision: 3, at: NOW });
    expect(next.planItemOutcomes?.length).toBe(1);
    next = appendPlanItemOutcome(next, { planItemId: "improvement:1", outcome: "applied", summary: "later round", revision: 4, at: NOW });
    expect(next.planItemOutcomes?.length).toBe(2);
  });
});

describe("applyDispatchOutcome × candidateStatus（落盘后裁决）", () => {
  const dispatch = (report: Record<string, unknown>) => ({
    round: 1, revision: 3, unmatched: [],
    outcomes: [{ instructionId: "x-rewrite0001", outcome: "applied" as const, planItemIds: ["improvement:1"], file: "sections/sec02.tex", ...report }],
  });

  it("候选被拒：即使带 targetChanged=true（旧顺序差形态）也不 handled；记 candidate_rejected + 守卫拒绝说明", () => {
    const [next] = applyDispatchOutcome([rewriteInstruction()], dispatch({ targetChanged: true, candidateStatus: "rejected" }), NOW).instructions;
    expect(next!.status).toBe("unresolved");
    expect(next!.statusNote).toMatch(/守卫拒绝/);
    expect(next!.planItemOutcomes?.[0]?.outcome).toBe("candidate_rejected");
  });

  it("unchanged：Writer 自称 applied 无真实变化 → unresolved，lineage 记 unchanged", () => {
    const [next] = applyDispatchOutcome([rewriteInstruction()], dispatch({ targetChanged: false, candidateStatus: "unchanged" }), NOW).instructions;
    expect(next!.status).toBe("unresolved");
    expect(next!.planItemOutcomes?.[0]?.outcome).toBe("unchanged");
  });

  it("accepted + 真实变化 → handled，lineage 记 applied 并携带前后 SHA", () => {
    const [next] = applyDispatchOutcome([rewriteInstruction()], dispatch({ targetChanged: true, candidateStatus: "accepted", beforeSha256: "a", afterSha256: "b", patchIds: ["patch:x"] }), NOW).instructions;
    expect(next!.status).toBe("handled");
    expect(next!.planItemOutcomes?.[0]).toMatchObject({ outcome: "applied", beforeSha256: "a", afterSha256: "b", revision: 3, patchIds: ["patch:x"] });
  });

  it("旧报告（无 candidateStatus）保持 M5.7 语义：targetChanged=true → handled", () => {
    const [next] = applyDispatchOutcome([rewriteInstruction()], dispatch({ targetChanged: true }), NOW).instructions;
    expect(next!.status).toBe("handled");
  });
});

describe("assessRewriteClosure（VALIDATED_FIXED 证据门）", () => {
  const handled = (extra: Partial<ExternalInstruction> = {}) => rewriteInstruction({ status: "handled", ...extra });

  it("accepted span patch + 绑定 + 变化 + 未回退 + 守卫 + 无开放子条 → VALIDATED_FIXED", () => {
    const result = assessRewriteClosure({ item, instruction: handled(), patches: [patch()], currentTargetFileHash: "after" });
    expect(result.closure).toBe("VALIDATED_FIXED");
    expect(result.checks).toEqual({ lineage: true, targetBinding: true, contentChanged: true, notReverted: true, guards: true });
  });

  it("文件级 applied lineage（前后 SHA 不同）：无 gate 复核记录 → NOT_EVALUATED；fact/citation 复核为 true 才可证", () => {
    const instruction = appendPlanItemOutcome(handled(), { planItemId: "improvement:1", outcome: "applied", summary: "", file: "sections/sec02.tex", beforeSha256: "b0", afterSha256: "b1", revision: 3, at: NOW });
    expect(assessRewriteClosure({ item, instruction, patches: [], currentTargetFileHash: "b1" }).closure).toBe("NOT_EVALUATED");
    const verified = { ...instruction, resolutionTrace: { commentId: "x-rewrite0001", planItemIds: ["improvement:1"], actionType: "modify" as const, evidenceIds: [], patchIds: [], verification: { fact: true, citation: true }, status: "handled" as const, resolutionSummary: "" } };
    expect(assessRewriteClosure({ item, instruction: verified, patches: [], currentTargetFileHash: "b1" }).closure).toBe("VALIDATED_FIXED");
    // 守卫证据也可来自覆盖该修订的 Quality Gate（事实 / 引用保持 PASS）；gate FAIL → STILL_OPEN；gate 覆盖不到 → NOT_EVALUATED
    const gatePass = () => ({ fact: true, citation: true, round: 2, reviewedRevision: 3 });
    expect(assessRewriteClosure({ item, instruction, patches: [], currentTargetFileHash: "b1", gateEvidence: gatePass }).closure).toBe("VALIDATED_FIXED");
    const gateFail = () => ({ fact: false, citation: true, round: 2, reviewedRevision: 3 });
    expect(assessRewriteClosure({ item, instruction, patches: [], currentTargetFileHash: "b1", gateEvidence: gateFail }).closure).toBe("STILL_OPEN");
    expect(assessRewriteClosure({ item, instruction, patches: [], currentTargetFileHash: "b1", gateEvidence: () => undefined }).closure).toBe("NOT_EVALUATED");
  });

  it("只有 handled 状态、无任何 lineage（旧「只看 handled 即判成功」路径）→ NOT_EVALUATED", () => {
    expect(assessRewriteClosure({ item, instruction: handled(), patches: [], currentTargetFileHash: "x" }).closure).toBe("NOT_EVALUATED");
  });

  it("patch 落在其它文件 → STILL_OPEN（目标绑定不成立）", () => {
    const result = assessRewriteClosure({ item, instruction: handled(), patches: [patch({ file: "sections/sec01.tex" })], currentTargetFileHash: "after" });
    expect(result.closure).toBe("STILL_OPEN");
    expect(result.checks?.targetBinding).toBe(false);
  });

  it("当前文件已回到修订前（restore / 回退）→ STILL_OPEN；当前文件不可读 → NOT_EVALUATED", () => {
    expect(assessRewriteClosure({ item, instruction: handled(), patches: [patch()], currentTargetFileHash: "before" }).closure).toBe("STILL_OPEN");
    expect(assessRewriteClosure({ item, instruction: handled(), patches: [patch()], currentTargetFileHash: undefined }).closure).toBe("NOT_EVALUATED");
  });

  it("gate 复核记录 fact=false → STILL_OPEN（不夸大）", () => {
    const instruction = handled({ resolutionTrace: { commentId: "x-rewrite0001", planItemIds: [], actionType: "modify", evidenceIds: [], patchIds: [], verification: { fact: false }, status: "handled", resolutionSummary: "" } });
    expect(assessRewriteClosure({ item, instruction, patches: [patch()], currentTargetFileHash: "after" }).closure).toBe("STILL_OPEN");
  });

  it("仍有作者裁决子条 → PARTIALLY_ADDRESSED，并列出子条；后续该子条 applied 则不再开放", () => {
    const open = appendPlanItemOutcome(handled(), { planItemId: "improvement:2", outcome: "author_decision", summary: "", at: NOW });
    const partial = assessRewriteClosure({ item, instruction: open, patches: [patch()], currentTargetFileHash: "after" });
    expect(partial.closure).toBe("PARTIALLY_ADDRESSED");
    expect(partial.openSubItems?.map((entry) => entry.planItemId)).toEqual(["improvement:2"]);
    const resolved = appendPlanItemOutcome(open, { planItemId: "improvement:2", outcome: "applied", summary: "", file: "sections/sec02.tex", beforeSha256: "after", afterSha256: "after2", at: NOW });
    expect(assessRewriteClosure({ item, instruction: resolved, patches: [patch()], currentTargetFileHash: "after2" }).closure).toBe("VALIDATED_FIXED");
  });

  it("被拒 patch 不构成 lineage；unresolved + candidate_rejected → STILL_OPEN", () => {
    const instruction = appendPlanItemOutcome(rewriteInstruction({ status: "unresolved", statusNote: "候选被守卫拒绝" }), { planItemId: "improvement:1", outcome: "candidate_rejected", summary: "", revision: 3, at: NOW });
    const result = assessRewriteClosure({ item, instruction, patches: [patch({ overall: "fail", finalStatus: "rejected", apply: { ok: false, status: "rejected" } })], currentTargetFileHash: "before" });
    expect(result.closure).toBe("STILL_OPEN");
    expect(result.basis).toMatch(/守卫拒绝/);
    expect(result.checks?.lineage).toBe(false);
  });
});
