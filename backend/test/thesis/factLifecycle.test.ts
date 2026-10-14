import { afterAll, describe, expect, it } from "vitest";

import { ABLATION_PAPER, cleanupThesisFixtures, newThesisFixture, tableBlock, textBlock, textLayerPage } from "./fixtures.js";

afterAll(cleanupThesisFixtures);

describe("M14.1b 事实生命周期：extracted → source_verified → author_confirmed", () => {
  it("确定性表格抽取：数值单元格成为事实，标签列 / 非数值不成为事实，标签来自相邻题注", async () => {
    const fx = await newThesisFixture();
    const paper = await fx.importPdf(
      {
        fileName: "paper.pdf",
        blocks: [textBlock("B0006", 8, "Table 5: Ablation studies of the SSAV on DAVSOD dataset.", "caption"), ABLATION_PAPER, tableBlock("B0008", 9, ["Method", "Code"], [["SIVM", "M&C++"], ["TIMP", "✓"]])],
        textLayer: [textLayerPage(8, "Type Baseline S max F M", "0.724", "0.603", "0.092", "0.684", "0.593", "0.103", "0.667", "0.541", "0.132")],
      },
      "published_paper",
    );
    const extracted = await fx.service.extractFacts(fx.projectId, paper.inputId);
    expect(extracted.created).toBe(9);
    expect(extracted.skippedCells).toBe(2);
    expect(extracted.tables[0]).toMatchObject({ label: "Table5", labelBasis: "adjacent_text", labelColumnCount: 2, page: 8 });
    const facts = await fx.service.facts.list(fx.projectId, { researchInputId: paper.inputId });
    const cell = facts.find((fact) => fact.surface === "0.724")!;
    expect(cell.verification).toMatchObject({ status: "extracted", sourceCheck: "unchecked" });
    expect(cell.provenance).toMatchObject({ page: 8, pageBasis: "parser", blockId: "B0007", table: { rowIndex: 0, columnIndex: 2, rowLabel: "SSAA | explicit", columnLabel: "S ↑", label: "Table5" } });
    expect(cell.key).toMatchObject({ subject: "ssaaexplicit", metric: "s", protocol: "table:Table5" });
    // 幂等：重抽取不新增
    const again = await fx.service.extractFacts(fx.projectId, paper.inputId);
    expect(again).toMatchObject({ created: 0, unchanged: 9 });
  });

  it("来源核验：同页文本层含 token → source_verified；缺页 / 不含 / 无页码 → 保持 extracted 并留言", async () => {
    const fx = await newThesisFixture();
    const paper = await fx.importPdf(
      {
        fileName: "paper.pdf",
        blocks: [
          ABLATION_PAPER,
          // 无页码的表格（parser 未报告）：不得盲搜
          { ...tableBlock("B0020", 1, ["k", "v"], [["a", "0.999"]]), provenance: { fileName: "x.pdf" } },
        ],
        textLayer: [textLayerPage(8, "0.724 0.603 0.092", "0.684 0.593 0.103", "0.667 0.541"), textLayerPage(1, "0.999")],
      },
      "published_paper",
    );
    await fx.service.extractFacts(fx.projectId, paper.inputId);
    const outcome = await fx.service.verifyFacts(fx.projectId, paper.inputId);
    expect(outcome).toMatchObject({ checked: 10, verified: 8, failed: 2, textLayerAvailable: true });
    const facts = await fx.service.facts.list(fx.projectId, { researchInputId: paper.inputId });
    expect(facts.find((fact) => fact.surface === "0.724")!.verification).toMatchObject({ status: "source_verified", sourceCheck: "verified", sourceCheckMethod: "text_layer_match" });
    const missing = facts.find((fact) => fact.surface === "0.132")!;
    expect(missing.verification.status).toBe("extracted");
    expect(missing.verification.sourceCheckNote).toMatch(/未找到 token/);
    const noPage = facts.find((fact) => fact.surface === "0.999")!;
    expect(noPage.verification.status).toBe("extracted");
    expect(noPage.verification.sourceCheckNote).toMatch(/未报告页码/);
  });

  it("token 边界：0.72 不能冒充 0.724 的核验证据", async () => {
    const fx = await newThesisFixture();
    const paper = await fx.importPdf(
      { fileName: "p.pdf", blocks: [tableBlock("B0001", 2, ["k", "v"], [["a", "0.724"]])], textLayer: [textLayerPage(2, "0.72 10.724 0.7245")] },
      "preprint",
    );
    await fx.service.extractFacts(fx.projectId, paper.inputId);
    expect(await fx.service.verifyFacts(fx.projectId, paper.inputId)).toMatchObject({ verified: 0, failed: 1 });
  });

  it("文本层不可用 → 全部 failed（fail closed），事实仍保留为 extracted", async () => {
    const fx = await newThesisFixture();
    const paper = await fx.importPdf({ fileName: "p.pdf", blocks: [ABLATION_PAPER] }, "preprint");
    await fx.service.extractFacts(fx.projectId, paper.inputId);
    const outcome = await fx.service.verifyFacts(fx.projectId, paper.inputId);
    expect(outcome).toMatchObject({ checked: 9, verified: 0, textLayerAvailable: false });
    expect((await fx.service.facts.list(fx.projectId, { verification: "extracted" })).length).toBe(9);
  });

  it("模型候选事实只能以 extracted 入库；引文逐字命中才 source_verified；模型无法直接 author_confirmed", async () => {
    const fx = await newThesisFixture();
    const paper = await fx.importPdf(
      { fileName: "p.pdf", blocks: [textBlock("B0001", 1, "We propose SSAV, a saliency-shift-aware model evaluated on DAVSOD with 226 videos.")] },
      "published_paper",
    );
    const result = await fx.service.addStatementFacts(
      fx.projectId,
      paper.inputId,
      [
        { kind: "method", statement: "提出 SSAV 模型", quote: "We propose SSAV, a saliency-shift-aware model" },
        { kind: "dataset", statement: "DAVSOD 含 226 个视频", quote: "DAVSOD with 226 videos", value: "226" },
        { kind: "conclusion", statement: "幻觉结论", quote: "SSAV achieves state of the art on every benchmark ever" },
      ],
      { method: "model_candidate", extractor: "test-model", taskId: "task-1" },
    );
    expect(result.verified).toBe(2);
    const byKind = Object.fromEntries(result.facts.map((fact) => [fact.kind, fact.verification.status]));
    expect(byKind).toEqual({ method: "source_verified", dataset: "source_verified", conclusion: "extracted" });
    expect(result.facts.every((fact) => fact.extraction.method === "model_candidate" && fact.verification.status !== "author_confirmed")).toBe(true);
  });

  it("作者确认是唯一通往 author_confirmed 的路径；撤销回退到核验状态；actor 不能是模型", async () => {
    const fx = await newThesisFixture();
    const paper = await fx.importPdf({ fileName: "p.pdf", blocks: [ABLATION_PAPER], textLayer: [textLayerPage(8, "0.724")] }, "published_paper");
    await fx.service.extractFacts(fx.projectId, paper.inputId);
    await fx.service.verifyFacts(fx.projectId, paper.inputId);
    const facts = await fx.service.facts.list(fx.projectId);
    const verified = facts.find((fact) => fact.surface === "0.724")!;
    const unverified = facts.find((fact) => fact.surface === "0.603")!;
    await expect(
      fx.service.submitDecision(fx.projectId, { actor: { kind: "model" as never }, payload: { type: "fact_confirmation", factIds: [verified.factId], outcome: "confirmed" } }),
    ).rejects.toThrow(/actor.kind/);
    const decision = await fx.service.submitDecision(fx.projectId, {
      decisionId: "confirm-1",
      actor: { kind: "test_fixture", note: "测试模拟；非真实作者" },
      payload: { type: "fact_confirmation", factIds: [verified.factId, unverified.factId], outcome: "confirmed" },
    });
    expect(decision.duplicate).toBe(false);
    let stored = await fx.service.facts.get(fx.projectId, verified.factId);
    expect(stored.verification).toMatchObject({ status: "author_confirmed", sourceCheck: "verified", confirmation: { decisionId: "confirm-1", actor: { kind: "test_fixture" } } });
    // 未经文本层核验的事实也可被作者确认，但 sourceCheck 如实保留 failed（可见）
    expect((await fx.service.facts.get(fx.projectId, unverified.factId)).verification).toMatchObject({ status: "author_confirmed", sourceCheck: "failed" });
    // 重复提交同 decisionId → duplicate，不重复应用
    const dup = await fx.service.submitDecision(fx.projectId, { decisionId: "confirm-1", actor: { kind: "test_fixture" }, payload: { type: "fact_confirmation", factIds: [verified.factId], outcome: "confirmed" } });
    expect(dup.duplicate).toBe(true);
    expect((await fx.service.decisions.list(fx.projectId)).length).toBe(1);
    // 撤销
    await fx.service.submitDecision(fx.projectId, { actor: { kind: "test_fixture" }, payload: { type: "fact_confirmation", factIds: [verified.factId, unverified.factId], outcome: "revoked" } });
    stored = await fx.service.facts.get(fx.projectId, verified.factId);
    expect(stored.verification.status).toBe("source_verified");
    expect((await fx.service.facts.get(fx.projectId, unverified.factId)).verification.status).toBe("extracted");
  });

  it("重放重抽取不改变已确认事实的状态；表头占位符由首行推导并标记", async () => {
    const fx = await newThesisFixture();
    const paper = await fx.importPdf(
      {
        fileName: "li.pdf",
        blocks: [textBlock("B0001", 64, "表 9 在不同谱归一化系数下的测试集Loss"), tableBlock("B0002", 64, ["0", "1", "2", "3", "4", "5"], [["", "2", "4", "6", "8", "(无 )"], ["损失Loss", "1.6288", "1.0523", "0.6645", "0.6250", "0.6185"]])],
        textLayer: [textLayerPage(64, "1.6288 1.0523 0.6645 0.6250 0.6185")],
      },
      "unpublished_manuscript",
    );
    const extracted = await fx.service.extractFacts(fx.projectId, paper.inputId);
    expect(extracted.tables[0]).toMatchObject({ headerRowDerived: true, label: "表9", labelBasis: "adjacent_text" });
    const facts = await fx.service.facts.list(fx.projectId);
    expect(facts.map((fact) => fact.surface).sort()).toEqual(["0.6185", "0.6250", "0.6645", "1.0523", "1.6288"]);
    // 列标签含私用区字形 → glyphIssues 如实标记（最后一列 "(无γ)" 列头）
    expect(facts.find((fact) => fact.surface === "0.6185")!.value.glyphIssues).toBe(true);
    expect(facts.find((fact) => fact.surface === "1.6288")!.value.glyphIssues).toBeUndefined();
    await fx.service.verifyFacts(fx.projectId, paper.inputId);
    const target = facts.find((fact) => fact.surface === "1.0523")!;
    await fx.service.submitDecision(fx.projectId, { actor: { kind: "test_fixture" }, payload: { type: "fact_confirmation", factIds: [target.factId], outcome: "confirmed" } });
    await fx.service.extractFacts(fx.projectId, paper.inputId);
    expect((await fx.service.facts.get(fx.projectId, target.factId)).verification.status).toBe("author_confirmed");
  });
});
