import { afterAll, describe, expect, it } from "vitest";

import { ABLATION_PAPER, ABLATION_THESIS, cleanupThesisFixtures, newThesisFixture, textLayerPage } from "./fixtures.js";

afterAll(cleanupThesisFixtures);

describe("M14.1b Planner 可消费上下文", () => {
  it("严格分区：proposed 输入不供给；未发表材料未授权阻断；三态分开；版本未选阻断", async () => {
    const fx = await newThesisFixture();
    const published = await fx.importPdf({ fileName: "p.pdf", blocks: [ABLATION_PAPER], textLayer: [textLayerPage(8, "0.724 0.603")] }, "published_paper", { title: "P" });
    const manuscript = await fx.importPdf({ fileName: "m.pdf", blocks: [ABLATION_THESIS], textLayer: [textLayerPage(63, "0.699")] }, "unpublished_manuscript", { title: "M" });
    for (const id of [published.inputId, manuscript.inputId]) {
      await fx.service.extractFacts(fx.projectId, id);
      await fx.service.verifyFacts(fx.projectId, id);
    }
    let context = await fx.service.plannerContext(fx.projectId);
    expect(context.inputs.proposed).toHaveLength(2);
    expect(context.facts.authorConfirmed.length + context.facts.sourceVerifiedUnconfirmed.length + context.facts.extractedOnly.length).toBe(0);
    expect(context.pendingDecisions.filter((pending) => pending.type === "scope_decision")).toHaveLength(2);

    const actor = { kind: "test_fixture" as const };
    await fx.service.submitDecision(fx.projectId, { actor, payload: { type: "scope_decision", inputId: published.inputId, scope: "included" } });
    await fx.service.submitDecision(fx.projectId, { actor, payload: { type: "scope_decision", inputId: manuscript.inputId, scope: "included" } });
    context = await fx.service.plannerContext(fx.projectId);
    // 已发表论文：2 条核验通过未确认 + 7 条仅抽取；未发表手稿未授权 → 阻断且不供给
    expect(context.facts.sourceVerifiedUnconfirmed.map((fact) => fact.surface).sort()).toEqual(["0.603", "0.724"]);
    expect(context.facts.extractedOnly).toHaveLength(7);
    expect(context.writingBlockers).toContain(`UNPUBLISHED_POLICY_UNDECIDED:${manuscript.inputId}`);
    expect(context.facts.sourceVerifiedUnconfirmed.every((fact) => fact.researchInputId === published.inputId)).toBe(true);

    await fx.service.submitDecision(fx.projectId, { actor, payload: { type: "unpublished_material_policy", inputId: manuscript.inputId, allowed: false } });
    context = await fx.service.plannerContext(fx.projectId);
    expect(context.writingBlockers).toEqual([]);
    expect(context.facts.sourceVerifiedUnconfirmed.some((fact) => fact.researchInputId === manuscript.inputId)).toBe(false);

    const verified = context.facts.sourceVerifiedUnconfirmed[0]!;
    await fx.service.submitDecision(fx.projectId, { actor, payload: { type: "fact_confirmation", factIds: [verified.factId], outcome: "confirmed" } });
    context = await fx.service.plannerContext(fx.projectId);
    expect(context.facts.authorConfirmed.map((fact) => fact.factId)).toEqual([verified.factId]);
    expect(context.facts.authorConfirmed[0]).toMatchObject({ verification: "author_confirmed", sourceCheck: "verified", conflictStatus: "none" });
    expect(context.facts.authorConfirmed[0]!.location).toMatch(/p8/);

    // 同一成果两个 included 版本但未选定 → 阻断
    const relation = await fx.service.registry.proposeRelation(fx.projectId, { fromInputId: published.inputId, toInputId: manuscript.inputId, kind: "same_work", basis: "content_match", proposedBy: "system" });
    await fx.service.submitDecision(fx.projectId, { actor, payload: { type: "relation_confirmation", relationId: relation.relationId, outcome: "confirmed" } });
    context = await fx.service.plannerContext(fx.projectId);
    const workId = (await fx.service.registry.get(fx.projectId, published.inputId)).workId;
    expect(context.writingBlockers).toContain(`VERSION_UNSELECTED:${workId}`);
    expect(context.facts.authorConfirmed).toHaveLength(0);
    await fx.service.submitDecision(fx.projectId, { actor, payload: { type: "version_selection", workId, preferredInputId: published.inputId } });
    context = await fx.service.plannerContext(fx.projectId);
    expect(context.inputs.preferredVersionByWork[workId]).toBe(published.inputId);
    expect(context.facts.authorConfirmed).toHaveLength(1);
    expect(context.writingBlockers).toEqual([]);
  });
});
