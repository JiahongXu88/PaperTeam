import { afterAll, describe, expect, it } from "vitest";

import { authorDecisionFromResumeInput } from "../../src/thesis/ResearchInputService.js";
import { ABLATION_PAPER, cleanupThesisFixtures, newThesisFixture, textBlock } from "./fixtures.js";

afterAll(cleanupThesisFixtures);

describe("M14.1b 作者决定（HITL 契约）", () => {
  it("七类决定可提交；账本 append-only；重开后幂等恢复；派生 decisionId 对同载荷稳定", async () => {
    const fx = await newThesisFixture();
    const a = await fx.importPdf({ fileName: "a.pdf", blocks: [ABLATION_PAPER] }, "submitted_manuscript", { title: "CDC submission" });
    const b = await fx.importPdf({ fileName: "b.pdf", blocks: [textBlock("B0001", 1, "x")] }, "published_paper", { title: "CDC final" });
    const relation = await fx.service.registry.proposeRelation(fx.projectId, { fromInputId: a.inputId, toInputId: b.inputId, kind: "same_work", basis: "title_similarity", proposedBy: "system" });
    const first = await fx.service.submitDecision(fx.projectId, { actor: { kind: "test_fixture" }, payload: { type: "scope_decision", inputId: a.inputId, scope: "included" } });
    const second = await fx.service.submitDecision(fx.projectId, { actor: { kind: "test_fixture" }, payload: { type: "scope_decision", inputId: a.inputId, scope: "included" } });
    expect(second.duplicate).toBe(true);
    expect(second.decision.decisionId).toBe(first.decision.decisionId);
    await fx.service.submitDecision(fx.projectId, { actor: { kind: "test_fixture" }, payload: { type: "unpublished_material_policy", inputId: a.inputId, allowed: true, note: "作者提供的在投稿件" } });
    await fx.service.submitDecision(fx.projectId, { actor: { kind: "test_fixture" }, payload: { type: "relation_confirmation", relationId: relation.relationId, outcome: "confirmed" } });
    const workId = (await fx.service.registry.get(fx.projectId, a.inputId)).workId;
    await fx.service.submitDecision(fx.projectId, { actor: { kind: "test_fixture" }, payload: { type: "version_selection", workId, preferredInputId: b.inputId } });
    await fx.service.submitDecision(fx.projectId, { actor: { kind: "test_fixture" }, payload: { type: "writing_pause", subject: "ch2:param-identification", decision: "write_as_limitation", rationale: "缺原始测量数据" } });
    // 中断恢复：新进程读账本
    const reopened = fx.reopen();
    const decisions = await reopened.service.decisions.list(fx.projectId);
    expect(decisions.map((decision) => decision.type)).toEqual(["scope_decision", "unpublished_material_policy", "relation_confirmation", "version_selection", "writing_pause"]);
    expect(decisions.every((decision) => decision.actor.kind === "test_fixture")).toBe(true);
    const input = await reopened.service.registry.get(fx.projectId, a.inputId);
    expect(input.scope.status).toBe("included");
    expect(input.unpublishedMaterialPolicy).toMatchObject({ allowed: true });
    // 重放同一决定 → duplicate，不再应用
    const replay = await reopened.service.submitDecision(fx.projectId, { decisionId: first.decision.decisionId, actor: { kind: "user" }, payload: { type: "scope_decision", inputId: a.inputId, scope: "excluded" } });
    expect(replay.duplicate).toBe(true);
    expect((await reopened.service.registry.get(fx.projectId, a.inputId)).scope.status).toBe("included");
  });

  it("应用失败的决定不落账（不存在的 inputId / 非法 decisionId）", async () => {
    const fx = await newThesisFixture();
    await expect(fx.service.submitDecision(fx.projectId, { actor: { kind: "user" }, payload: { type: "scope_decision", inputId: "ri-000000000000", scope: "included" } })).rejects.toThrow(/不存在/);
    await expect(fx.service.submitDecision(fx.projectId, { decisionId: "bad id!", actor: { kind: "user" }, payload: { type: "writing_pause", subject: "x", decision: "pause" } })).rejects.toThrow(/decisionId/);
    expect(await fx.service.decisions.list(fx.projectId)).toEqual([]);
  });

  it("ResumeInput → AuthorDecisionPayload 适配（供未来 hitl.* onInput 复用）；非法载荷不猜", () => {
    expect(authorDecisionFromResumeInput({ decision: "include", payload: { inputId: "ri-1" } })).toEqual({ type: "scope_decision", inputId: "ri-1", scope: "included" });
    expect(authorDecisionFromResumeInput({ decision: "select_version", payload: { workId: "w", preferredInputId: "ri-2" } })).toEqual({ type: "version_selection", workId: "w", preferredInputId: "ri-2" });
    expect(authorDecisionFromResumeInput({ decision: "adopt_fact", payload: { conflictId: "C1", adoptedFactId: "F1" } })).toEqual({ type: "conflict_resolution", conflictId: "C1", decision: "adopt_fact", adoptedFactId: "F1" });
    expect(authorDecisionFromResumeInput({ decision: "confirm_facts", payload: { factIds: ["F1"] } })).toEqual({ type: "fact_confirmation", factIds: ["F1"], outcome: "confirmed" });
    expect(authorDecisionFromResumeInput({ decision: "allow_unpublished", payload: { inputId: "ri-1" } })).toEqual({ type: "unpublished_material_policy", inputId: "ri-1", allowed: true });
    expect(authorDecisionFromResumeInput({ decision: "defer_chapter", payload: { subject: "ch5" } })).toEqual({ type: "writing_pause", subject: "ch5", decision: "defer" });
    expect(() => authorDecisionFromResumeInput({ decision: "approve" })).toThrow(/未知作者决定/);
    expect(() => authorDecisionFromResumeInput({ decision: "include", payload: {} })).toThrow(/inputId/);
  });
});
