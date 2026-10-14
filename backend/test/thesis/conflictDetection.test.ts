import { afterAll, describe, expect, it } from "vitest";

import { ABLATION_PAPER, ABLATION_THESIS, cleanupThesisFixtures, newThesisFixture, tableBlock, textBlock, textLayerPage } from "./fixtures.js";

afterAll(cleanupThesisFixtures);

async function fanCase() {
  const fx = await newThesisFixture();
  const paper = await fx.importPdf(
    { fileName: "cvpr19.pdf", blocks: [textBlock("B0006", 8, "Table 5: Ablation studies of the SSAV on DAVSOD dataset.", "caption"), ABLATION_PAPER], textLayer: [textLayerPage(8, "0.724 0.603 0.092 0.684 0.593 0.103 0.667 0.541 0.132")] },
    "published_paper",
    { title: "Shifting More Attention to Video Salient Object Detection" },
  );
  const thesis = await fx.importPdf(
    { fileName: "thesis.pdf", blocks: [textBlock("B0041", 63, "表4.3 SSAV模型在DAVSOD数据集上的分离实验。"), ABLATION_THESIS], textLayer: [textLayerPage(63, "0.699 0.630 0.098 0.684 0.593 0.103 0.667 0.541 0.132")] },
    "unpublished_manuscript",
    { title: "认知规律启发的显著性物体检测方法与评测" },
  );
  for (const id of [paper.inputId, thesis.inputId]) {
    await fx.service.extractFacts(fx.projectId, id);
    await fx.service.verifyFacts(fx.projectId, id);
  }
  return { fx, paper, thesis };
}

describe("M14.1b 冲突检测（确定性）", () => {
  it("1/8：同实验同指标异值 → comparable 对齐 + 3 条 blocking value_mismatch；相同单元格不生成冲突", async () => {
    const { fx, paper, thesis } = await fanCase();
    const result = await fx.service.detectConflicts(fx.projectId);
    expect(result.alignments).toHaveLength(1);
    expect(result.alignments[0]).toMatchObject({ status: "comparable", evidence: { columnLabelsMatch: true, rowCounts: [3, 3], identicalCells: 6, comparedCells: 9, sharedIdentifiers: ["SSAV", "DAVSOD"] } });
    expect(result.alignments[0]!.evidence.rowPairs.map((pair) => pair.labelCompatibility)).toEqual(["contains", "contains", "equal"]);
    expect(result.conflicts.created).toBe(3);
    const conflicts = await fx.service.facts.listConflicts(fx.projectId);
    expect(conflicts.every((conflict) => conflict.classification === "value_mismatch" && conflict.severity === "blocking" && conflict.status === "unresolved")).toBe(true);
    const sConflict = conflicts.find((conflict) => conflict.key.metric === "s")!;
    expect(sConflict.parties.map((party) => party.raw).sort()).toEqual(["0.699", "0.724"]);
    expect(sConflict.parties.map((party) => party.researchInputId).sort()).toEqual([paper.inputId, thesis.inputId].sort());
    expect(sConflict.parties.every((party) => /p(8|63) Table5|表4.3/.test(party.location))).toBe(true);
    // 双方原始事实完整保留且标记 unresolved
    for (const party of sConflict.parties) {
      const fact = await fx.service.facts.get(fx.projectId, party.factId);
      expect(fact.value.raw).toBe(party.raw);
      expect(fact.conflict).toMatchObject({ status: "unresolved", conflictIds: [sConflict.conflictId] });
    }
    // 重放幂等
    const again = await fx.service.detectConflicts(fx.projectId);
    expect(again.conflicts).toMatchObject({ created: 0, existing: 3, reopened: 0 });
    expect((await fx.service.facts.listConflicts(fx.projectId)).length).toBe(3);
  });

  it("2/8：同数值但评价协议不同（不同表 / 不同列标签）不对齐 → 零冲突", async () => {
    const fx = await newThesisFixture();
    const a = await fx.importPdf({ fileName: "a.pdf", blocks: [tableBlock("B0001", 1, ["Method", "mAP@0.5"], [["Ours", "82.4"], ["Base", "78.2"]], "Table 1: COCO val")] }, "published_paper");
    const b = await fx.importPdf({ fileName: "b.pdf", blocks: [tableBlock("B0001", 1, ["Method", "mAP@0.75"], [["Ours", "82.4"], ["Base", "70.1"]], "Table 1: COCO test-dev")] }, "preprint");
    for (const id of [a.inputId, b.inputId]) await fx.service.extractFacts(fx.projectId, id);
    const result = await fx.service.detectConflicts(fx.projectId);
    expect(result.alignments).toHaveLength(0);
    expect(result.conflicts.created).toBe(0);
  });

  it("3/8：单位不同但可规范化（0.05 s vs 50 ms）→ advisory equal_after_unit_normalization，不阻断", async () => {
    const fx = await newThesisFixture();
    const rows = (t: string) => [["Ours", t], ["Base", "0.10 s"], ["Other", "0.20 s"], ["Fast", "0.30 s"]];
    const a = await fx.importPdf({ fileName: "a.pdf", blocks: [tableBlock("B0001", 1, ["Method", "Time"], rows("0.05 s"), "Table 2: runtime")] }, "published_paper");
    const b = await fx.importPdf({ fileName: "b.pdf", blocks: [tableBlock("B0001", 1, ["Method", "Time"], rows("50 ms"), "Table 2: runtime")] }, "preprint");
    for (const id of [a.inputId, b.inputId]) await fx.service.extractFacts(fx.projectId, id);
    const result = await fx.service.detectConflicts(fx.projectId);
    expect(result.alignments[0]!.status).toBe("comparable");
    const conflicts = await fx.service.facts.listConflicts(fx.projectId);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ classification: "equal_after_unit_normalization", severity: "advisory" });
    const context = await fx.service.plannerContext(fx.projectId);
    expect(context.writingBlockers).not.toContain(`CONFLICT_UNRESOLVED:${conflicts[0]!.conflictId}`);
  });

  it("4/8：单位无法可靠换算 → unit_incomparable（advisory，需人工）；事实标 not_comparable", async () => {
    const fx = await newThesisFixture();
    const rows = (t: string) => [["Ours", t], ["Base", "20 ms"], ["Other", "30 ms"], ["Fast", "40 ms"]];
    const a = await fx.importPdf({ fileName: "a.pdf", blocks: [tableBlock("B0001", 1, ["Method", "Cost"], rows("21 ms"), "Table 3: cost")] }, "published_paper");
    const b = await fx.importPdf({ fileName: "b.pdf", blocks: [tableBlock("B0001", 1, ["Method", "Cost"], rows("5.1MB"), "Table 3: cost")] }, "preprint");
    for (const id of [a.inputId, b.inputId]) await fx.service.extractFacts(fx.projectId, id);
    await fx.service.detectConflicts(fx.projectId);
    const conflicts = await fx.service.facts.listConflicts(fx.projectId);
    expect(conflicts).toHaveLength(1);
    expect(conflicts[0]).toMatchObject({ classification: "unit_incomparable", severity: "advisory" });
    expect((await fx.service.facts.get(fx.projectId, conflicts[0]!.parties[0]!.factId)).conflict.status).toBe("not_comparable");
  });

  it("5/8：作者指定权威版本 → resolved + 可追溯；被排除版本的原始事实不被覆盖", async () => {
    const { fx, thesis } = await fanCase();
    await fx.service.detectConflicts(fx.projectId);
    const conflict = (await fx.service.facts.listConflicts(fx.projectId)).find((entry) => entry.key.metric === "s")!;
    const thesisFact = conflict.parties.find((party) => party.researchInputId === thesis.inputId)!;
    const paperFact = conflict.parties.find((party) => party.researchInputId !== thesis.inputId)!;
    // adopt_fact 必须指向双方之一
    await expect(
      fx.service.submitDecision(fx.projectId, { actor: { kind: "test_fixture" }, payload: { type: "conflict_resolution", conflictId: conflict.conflictId, decision: "adopt_fact", adoptedFactId: "Fnope" } }),
    ).rejects.toThrow(/adoptedFactId/);
    const decision = await fx.service.submitDecision(fx.projectId, {
      actor: { kind: "test_fixture", note: "测试模拟作者裁决（公开论文，非用户本人成果）" },
      payload: { type: "conflict_resolution", conflictId: conflict.conflictId, decision: "adopt_fact", adoptedFactId: thesisFact.factId, rationale: "学位论文版本为重跑结果" },
    });
    const resolved = (await fx.service.facts.listConflicts(fx.projectId, "resolved"))[0]!;
    expect(resolved.resolution).toMatchObject({ decision: "adopt_fact", adoptedFactId: thesisFact.factId, decisionId: decision.decision.decisionId, actor: { kind: "test_fixture" } });
    expect(resolved.resolution!.appliesToContentHashes).toHaveLength(2);
    const excluded = await fx.service.facts.get(fx.projectId, paperFact.factId);
    expect(excluded.value.raw).toBe("0.724");
    expect(excluded.surface).toBe("0.724");
    expect(excluded.conflict.status).toBe("resolved");
    // 其余两条仍 unresolved → 对应事实仍不可确认
    const open = await fx.service.facts.listConflicts(fx.projectId, "unresolved");
    expect(open).toHaveLength(2);
  });

  it("6/8：新版本出现后旧裁决不适用——新版本的冲突是新的 unresolved 记录，旧裁决只绑定旧内容版本", async () => {
    const { fx, thesis } = await fanCase();
    await fx.service.detectConflicts(fx.projectId);
    const before = (await fx.service.facts.listConflicts(fx.projectId)).find((entry) => entry.key.metric === "s")!;
    await fx.service.submitDecision(fx.projectId, { actor: { kind: "test_fixture" }, payload: { type: "conflict_resolution", conflictId: before.conflictId, decision: "keep_both", rationale: "并存说明" } });
    // 论文修订版：S 值再次变化
    const revised = { ...ABLATION_PAPER, rows: [["SSAA", "explicit", "0.731", "0.603", "0.092"], ["SSAA", "implicit", "0.684", "0.593", "0.103"], ["SSLSTM", "w/o SSLSTM", "0.667", "0.541", "0.132"]] } as typeof ABLATION_PAPER;
    const paperV2 = await fx.importPdf({ fileName: "cvpr19_v2.pdf", bytes: "v2", blocks: [revised] }, "published_paper", { title: "SSAV v2" });
    await fx.service.extractFacts(fx.projectId, paperV2.inputId);
    const result = await fx.service.detectConflicts(fx.projectId, { inputIds: [paperV2.inputId, thesis.inputId] });
    const newConflict = result.conflicts.detected.find((entry) => entry.key.metric === "s")!;
    expect(newConflict.conflictId).not.toBe(before.conflictId);
    expect((await fx.service.facts.listConflicts(fx.projectId)).find((entry) => entry.conflictId === newConflict.conflictId)!.status).toBe("unresolved");
    expect((await fx.service.facts.listConflicts(fx.projectId)).find((entry) => entry.conflictId === before.conflictId)!.status).toBe("resolved");
  });

  it("7/8：冲突状态不能被 Writer / 模型清除——无 API 可绕过作者决定；冲突事实拒绝确认；planner 上下文隔离", async () => {
    const { fx, thesis } = await fanCase();
    await fx.service.detectConflicts(fx.projectId);
    const conflict = (await fx.service.facts.listConflicts(fx.projectId)).find((entry) => entry.key.metric === "s")!;
    const factId = conflict.parties.find((party) => party.researchInputId === thesis.inputId)!.factId;
    await expect(
      fx.service.submitDecision(fx.projectId, { actor: { kind: "test_fixture" }, payload: { type: "fact_confirmation", factIds: [factId], outcome: "confirmed" } }),
    ).rejects.toThrow(/未裁决冲突/);
    await fx.service.submitDecision(fx.projectId, { actor: { kind: "test_fixture" }, payload: { type: "scope_decision", inputId: thesis.inputId, scope: "included" } });
    await fx.service.submitDecision(fx.projectId, { actor: { kind: "test_fixture" }, payload: { type: "unpublished_material_policy", inputId: thesis.inputId, allowed: true } });
    const context = await fx.service.plannerContext(fx.projectId);
    expect(context.facts.conflicted.map((fact) => fact.factId)).toContain(factId);
    expect(context.facts.authorConfirmed).toHaveLength(0);
    expect(context.writingBlockers).toContain(`CONFLICT_UNRESOLVED:${conflict.conflictId}`);
    expect(context.pendingDecisions.some((pending) => pending.type === "conflict_resolution" && pending.subject === conflict.conflictId)).toBe(true);
    // defer 也不解除阻断
    await fx.service.submitDecision(fx.projectId, { actor: { kind: "test_fixture" }, payload: { type: "conflict_resolution", conflictId: conflict.conflictId, decision: "defer" } });
    const deferred = await fx.service.plannerContext(fx.projectId);
    expect(deferred.writingBlockers).toContain(`CONFLICT_UNRESOLVED:${conflict.conflictId}`);
    expect(deferred.conflicts.deferred).toHaveLength(1);
  });

  it("8/8：行标签不兼容的行对不比较（不会把不同基线强行配对）", async () => {
    const fx = await newThesisFixture();
    const a = await fx.importPdf({ fileName: "a.pdf", blocks: [tableBlock("B0001", 1, ["Model", "CER"], [["Baseline", "11.4"], ["LST", "9.3"], ["LST+SF", "8.3"], ["Big", "7.0"]], "Table 4: AISHELL-1")] }, "published_paper");
    const b = await fx.importPdf({ fileName: "b.pdf", blocks: [tableBlock("B0001", 1, ["Model", "CER"], [["Baseline", "7.6"], ["Conformer", "4.7"], ["TRANS-EXT", "6.3"], ["TRANS-EXT+SF", "5.8"]], "Table IX: AISHELL-1")] }, "published_paper");
    for (const id of [a.inputId, b.inputId]) await fx.service.extractFacts(fx.projectId, id);
    const result = await fx.service.detectConflicts(fx.projectId);
    // 列标签一致但相同单元格 0/4 → 不对齐；基线 11.4 vs 7.6 不会被自动判定为冲突（需作者 / 内容证据）
    expect(result.alignments).toHaveLength(0);
    expect(result.conflicts.created).toBe(0);
  });
});
