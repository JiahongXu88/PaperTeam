/**
 * M15.1 Reviewer 契约守卫：论断账本契约只在显式开启时注入（缺省 prompt 逐字节不变），claims 缺失只做 1 次有界修复；
 * Style 审稿不输出 AIGC / 检测器概率（M15 产品红线不随新审计变化）。
 */
import { describe, expect, it } from "vitest";
import { ReviewerService, buildReviewPrompt, parseModeReview, containsForbiddenDetectorFields } from "../../src/agents/ReviewerService.js";
import type { AgentRuntime } from "../../src/runtime/types.js";

function fakeRuntime(outputs: string[]): { runtime: AgentRuntime; prompts: string[]; metadata: Array<Record<string, unknown> | undefined> } {
  const prompts: string[] = [];
  const metadata: Array<Record<string, unknown> | undefined> = [];
  const runtime = {
    runAgent: async (input: { task: string; metadata?: Record<string, unknown> }) => {
      prompts.push(input.task);
      metadata.push(input.metadata);
      const now = new Date().toISOString();
      return { taskId: `t${prompts.length}`, agentId: "reviewer", status: "completed", createdAt: now, updatedAt: now, output: outputs.shift() ?? "{}", events: [] };
    },
  } as unknown as AgentRuntime;
  return { runtime, prompts, metadata };
}

const unit = { unitId: "main.tex::section:A", file: "main.tex", heading: "A", unitIndex: 1, unitCount: 1, text: "We report 61.7 HOTA on MOT17 in Table 2." };

describe("M15.1 Reviewer 论断账本契约", () => {
  it("缺省（shadow / 作者稿件）：单元 prompt 不含论断账本契约；开启后只追加契约行与 JSON 模板行", async () => {
    const legacy = fakeRuntime([JSON.stringify({ summary: "ok", issues: [], academicScore: 70, riskScore: 20 })]);
    const service = new ReviewerService({ runtime: legacy.runtime, agentId: "reviewer", projects: {} as never });
    const legacyResult = await service.reviewUnit({ projectId: "p", unit, chapterIndex: ["A（main.tex）"] });
    expect(legacy.prompts[0]).not.toContain("论断账本");
    expect(legacyResult.claimExtraction).toBeUndefined();
    const extended = fakeRuntime([JSON.stringify({ summary: "ok", issues: [], academicScore: 70, riskScore: 20, claims: [{ quote: "We report 61.7 HOTA on MOT17", check: "NEEDS_OTHER_SECTION", linkedRefs: ["Table 2"] }] })]);
    const extService = new ReviewerService({ runtime: extended.runtime, agentId: "reviewer", projects: {} as never });
    const result = await extService.reviewUnit({ projectId: "p", unit, chapterIndex: ["A（main.tex）"], claimAudit: { contract: "unit-claims/v1" } });
    const added = extended.prompts[0]!.split("\n").filter((line) => !legacy.prompts[0]!.split("\n").includes(line));
    expect(added.length).toBeGreaterThan(0);
    expect(added.every((line) => /claims|quote|claimType|linkedRefs|check|counterpart|issueIndex|CONSISTENT/.test(line))).toBe(true);
    expect(extended.prompts[0]!.split("\n").filter((line) => !added.includes(line))).toEqual(legacy.prompts[0]!.split("\n"));
    expect(result.claimExtraction).toMatchObject({ status: "EXTRACTED", repairAttempts: 0 });
    expect(result.claimExtraction!.claims[0]).toMatchObject({ check: "NEEDS_OTHER_SECTION", linkedRefs: ["Table 2"] });
  });

  it("claims 缺失：恰好 1 次有界修复调用（同一单元会话，只补 claims）；修复失败如实 ABSENT，不阻断单元", async () => {
    const fake = fakeRuntime([JSON.stringify({ summary: "ok", issues: [], academicScore: 70, riskScore: 20 }), "not json"]);
    const service = new ReviewerService({ runtime: fake.runtime, agentId: "reviewer", projects: {} as never });
    const result = await service.reviewUnit({ projectId: "p", unit, chapterIndex: [], claimAudit: { contract: "unit-claims/v1" } });
    expect(fake.prompts).toHaveLength(2);
    expect(fake.metadata[1]).toMatchObject({ repairField: "claims", structuredRepairAttempt: 1 });
    expect(result.claimExtraction).toMatchObject({ status: "ABSENT", repairAttempts: 1 });
    expect(result.academicScore).toBe(70);
  });

  it("digest fact 路：claimAuditContract 只改 fact 模式 prompt；academic / style 逐字节不变", () => {
    const base = { projectId: "p", manuscriptDigest: "digest", evidence: [] };
    for (const mode of ["academic", "style"] as const) {
      expect(buildReviewPrompt({ ...base, mode, claimAuditContract: true })).toBe(buildReviewPrompt({ ...base, mode }));
    }
    expect(buildReviewPrompt({ ...base, mode: "fact", claimAuditContract: true })).toContain("论断账本扩展（M15.1）");
    expect(buildReviewPrompt({ ...base, mode: "fact" })).not.toContain("论断账本");
  });

  it("Style：AI 概率 / 检测器字段一律丢弃；riskScore 仍是可解释的写作风险口径", () => {
    const raw = { summary: "s", riskScore: 30, aiProbability: 0.9, detectorScore: 88, issues: [{ category: "style", severity: "minor", section: "A", description: "模板化排比", reason: "同段第 3 次", suggestedAction: "改写", blocking: false }] };
    expect(containsForbiddenDetectorFields(raw)).toEqual(["aiProbability", "detectorScore"]);
    const parsed = parseModeReview("style", raw) as unknown as Record<string, unknown>;
    expect(parsed["riskScore"]).toBe(30);
    expect("aiProbability" in parsed || "detectorScore" in parsed).toBe(false);
    expect((parsed["issues"] as Array<Record<string, unknown>>)[0]).toMatchObject({ reason: "同段第 3 次", suggestedAction: "改写" });
    expect(buildReviewPrompt({ projectId: "p", mode: "style", manuscriptDigest: "d", evidence: [] })).toContain("不是 AI 检测");
  });
});
