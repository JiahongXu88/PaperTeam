import { afterAll, describe, expect, it } from "vitest";

import { ABLATION_PAPER, ABLATION_THESIS, cleanupThesisFixtures, newThesisFixture, tableBlock, textBlock } from "./fixtures.js";

afterAll(cleanupThesisFixtures);

describe("M14.1b ResearchInputRegistry", () => {
  it("五类研究输入均可注册，默认 scope=proposed，解析状态如实（full_text / failed / pending）", async () => {
    const fx = await newThesisFixture();
    const types = ["published_paper", "preprint", "submitted_manuscript", "unpublished_manuscript", "experiment_report"] as const;
    const ids: string[] = [];
    for (const type of types) {
      const result = await fx.importPdf({ fileName: `${type}.pdf`, blocks: [textBlock("B0001", 1, `${type} body`)] }, type);
      ids.push(result.inputId);
    }
    const file = await fx.service.list(fx.projectId);
    expect(file.inputs.map((input) => input.inputType)).toEqual([...types]);
    expect(file.inputs.every((input) => input.scope.status === "proposed")).toBe(true);
    expect(file.inputs.every((input) => input.parse.status === "full_text")).toBe(true);
    expect(new Set(ids).size).toBe(5);

    const failed = await fx.importPdf({ fileName: "broken.pdf", blocks: [], parse: "failed" }, "experiment_report");
    const failedInput = await fx.service.registry.get(fx.projectId, failed.inputId);
    expect(failedInput.parse.status).toBe("failed");
    expect(failedInput.version.contentHash).toMatch(/^[a-f0-9]{64}$/);

    const pending = await fx.importPdf({ fileName: "later.pdf", blocks: [], parse: "unavailable" }, "preprint");
    expect((await fx.service.registry.get(fx.projectId, pending.inputId)).parse.status).toBe("pending");
  });

  it("重复导入相同文件幂等（同 inputId / created=false）；不同内容 = 新版本不覆盖旧条目", async () => {
    const fx = await newThesisFixture();
    const v1 = await fx.importPdf({ fileName: "paper_v1.pdf", bytes: "v1", blocks: [ABLATION_PAPER] }, "preprint", { arxivId: "1901.09993v1", versionLabel: "arXiv v1" });
    const again = await fx.importPdf({ fileName: "paper_v1.pdf", bytes: "v1", blocks: [ABLATION_PAPER] }, "preprint", { arxivId: "1901.09993v1" });
    expect(again.created).toBe(false);
    expect(again.inputId).toBe(v1.inputId);
    const v3 = await fx.importPdf({ fileName: "paper_v3.pdf", bytes: "v3", blocks: [ABLATION_THESIS] }, "published_paper", { arxivId: "1901.09993v3", versionLabel: "arXiv v3" });
    expect(v3.inputId).not.toBe(v1.inputId);
    const file = await fx.service.list(fx.projectId);
    expect(file.inputs).toHaveLength(2);
    expect(file.inputs.map((input) => input.version.contentHash)).toHaveLength(2);
    expect(new Set(file.inputs.map((input) => input.version.contentHash)).size).toBe(2);
    // 同 arXiv 记录 → 确定性 same_work（系统 confirmed，basis=arxiv_identifier），合并成果分组
    const relation = file.relations.find((entry) => entry.kind === "same_work");
    expect(relation).toMatchObject({ status: "confirmed", basis: "arxiv_identifier", proposedBy: "system" });
    expect(file.inputs[0]!.workId).toBe(file.inputs[1]!.workId);
    expect(file.workGroups).toHaveLength(1);
    expect(file.workGroups[0]!.preferredInputId).toBeUndefined();
  });

  it("标题相似 / 模型建议只能是 candidate，确认须作者决定；拒绝后不合并分组", async () => {
    const fx = await newThesisFixture();
    const conf = await fx.importPdf({ fileName: "interspeech.pdf", blocks: [textBlock("B0001", 1, "Learn Spelling from Teachers")] }, "published_paper", { title: "Learn Spelling from Teachers" });
    const journal = await fx.importPdf({ fileName: "taslp.pdf", blocks: [textBlock("B0001", 1, "Integrating Knowledge")] }, "published_paper", { title: "Integrating Knowledge into E2E ASR" });
    const relation = await fx.service.registry.proposeRelation(fx.projectId, {
      fromInputId: conf.inputId,
      toInputId: journal.inputId,
      kind: "supersedes",
      basis: "model_candidate",
      evidence: "期刊扩展版",
      proposedBy: "model",
    });
    expect(relation.status).toBe("candidate");
    let file = await fx.service.list(fx.projectId);
    expect(file.workGroups).toHaveLength(2);
    const rejected = await fx.service.submitDecision(fx.projectId, {
      actor: { kind: "test_fixture", note: "测试模拟作者拒绝" },
      payload: { type: "relation_confirmation", relationId: relation.relationId, outcome: "rejected" },
    });
    expect(rejected.decision.applied.effects).toEqual([`relation:${relation.relationId}=rejected`]);
    file = await fx.service.list(fx.projectId);
    expect(file.relations[0]).toMatchObject({ status: "rejected", basis: "author_decision", decisionId: rejected.decision.decisionId });
    expect(file.workGroups).toHaveLength(2);
  });

  it("作者确认 same_work 候选后合并分组；版本选择只能由作者决定且必须属于该组", async () => {
    const fx = await newThesisFixture();
    const a = await fx.importPdf({ fileName: "a.pdf", blocks: [] }, "preprint", { title: "A" });
    const b = await fx.importPdf({ fileName: "b.pdf", blocks: [] }, "published_paper", { title: "A (journal)" });
    const other = await fx.importPdf({ fileName: "c.pdf", blocks: [] }, "experiment_report", { title: "C" });
    const relation = await fx.service.registry.proposeRelation(fx.projectId, { fromInputId: a.inputId, toInputId: b.inputId, kind: "same_work", basis: "title_similarity", proposedBy: "system" });
    await fx.service.submitDecision(fx.projectId, { actor: { kind: "test_fixture" }, payload: { type: "relation_confirmation", relationId: relation.relationId, outcome: "confirmed" } });
    let file = await fx.service.list(fx.projectId);
    const workId = file.inputs.find((input) => input.inputId === a.inputId)!.workId;
    expect(file.inputs.find((input) => input.inputId === b.inputId)!.workId).toBe(workId);
    await expect(
      fx.service.submitDecision(fx.projectId, { actor: { kind: "test_fixture" }, payload: { type: "version_selection", workId, preferredInputId: other.inputId } }),
    ).rejects.toThrow(/不属于成果分组/);
    await fx.service.submitDecision(fx.projectId, { actor: { kind: "test_fixture" }, payload: { type: "version_selection", workId, preferredInputId: b.inputId } });
    file = await fx.service.list(fx.projectId);
    expect(file.workGroups.find((group) => group.workId === workId)!.preferredInputId).toBe(b.inputId);
    // 失败的决定不落账
    expect((await fx.service.decisions.list(fx.projectId)).map((decision) => decision.type)).toEqual(["relation_confirmation", "version_selection"]);
  });

  it("入选 / 排除 / 取代由作者决定写入并持久化（重开仍在）", async () => {
    const fx = await newThesisFixture();
    const a = await fx.importPdf({ fileName: "a.pdf", blocks: [tableBlock("B0001", 1, ["x", "y"], [["r", "1"]])] }, "published_paper");
    await fx.service.submitDecision(fx.projectId, { decisionId: "scope-a", actor: { kind: "test_fixture" }, payload: { type: "scope_decision", inputId: a.inputId, scope: "excluded", rationale: "范围之外" } });
    const reopened = fx.reopen();
    const input = await reopened.service.registry.get(fx.projectId, a.inputId);
    expect(input.scope).toMatchObject({ status: "excluded", decisionId: "scope-a" });
    expect((await reopened.service.decisions.get(fx.projectId, "scope-a"))?.payload).toMatchObject({ scope: "excluded" });
  });

  it("metadata-only 文献不能登记为研究输入", async () => {
    const fx = await newThesisFixture();
    const item = await fx.sources.addRecord(fx.projectId, { sourceType: "doi", metadata: { title: "no file", doi: "10.1/x" } });
    await expect(fx.service.register(fx.projectId, { sourceId: item.sourceId, inputType: "published_paper" })).rejects.toThrow(/metadata-only/);
  });
});
