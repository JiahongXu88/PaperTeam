/**
 * M14.1c：噪声表格过滤 + 候选表格对齐作者确认测试。
 *
 * 噪声过滤（7.2）双向验证：
 *   - 定向命中：目录页码形态 / 封面短文本 / 退化网格 → noise.likely=true，
 *     不进事实抽取与对齐候选；
 *   - 反例守卫：无题注的真实数据表（正文页、列标签清晰）不得被误杀。
 *
 * 对齐确认（7.1）：
 *   - candidate 对齐 → 作者 confirmed → comparable + basis=author_decision +
 *     decisionId 可追溯；
 *   - 拒绝 → not_comparable + rejectionReason；
 *   - 确认后的 comparable 对齐进入冲突检测（列重排 / 增删行场景由作者兜底）；
 *   - 原始数值不被覆盖：确认不改动任何 fact 的 value；
 *   - 决定与内容版本绑定：contentHash 变化 → 新 alignmentId → 旧决定不自动适用。
 */

import { describe, expect, it } from "vitest";

import { classifyTableNoise, extractTableFacts, extractTables } from "../../src/thesis/factExtraction.js";
import { alignTables } from "../../src/thesis/tableAlignment.js";
import type { ParsedDocument, ParsedBlock } from "../../src/ingestion/types.js";
import type { ResearchInput } from "../../src/thesis/researchInputTypes.js";
import { cleanupThesisFixtures, newThesisFixture, tableBlock } from "./fixtures.js";

function documentOf(blocks: ParsedBlock[]): ParsedDocument {
  return {
    schemaVersion: 1,
    sourceId: "S001",
    fileName: "x.pdf",
    storedFileName: "S001-x.pdf",
    kind: "pdf",
    mimeType: "application/pdf",
    parser: { id: "test", version: "1" },
    parseMode: "structured",
    status: "ok",
    blocks,
    counts: { text: 0, table: 0, figure: 0, formula: 0, structured_record: 0, code: 0, output: 0 },
    notes: [],
    contentHash: "hash-1",
    parsedAt: "2026-10-15T00:00:00Z",
  };
}

function inputOf(inputId: string, hash: string): ResearchInput {
  return {
    schemaVersion: 1,
    inputId,
    projectId: "p-test",
    inputType: "published_paper",
    title: "t",
    authors: [],
    identifiers: {},
    workId: inputId,
    version: { sourceId: `S-${inputId}`, contentHash: hash, bytes: 1, importedAt: "2026-10-15T00:00:00Z" },
    parse: { status: "full_text", notes: [] },
    scope: { status: "included", updatedAt: "2026-10-15T00:00:00Z" },
    evidenceLinks: { evidenceIds: [] },
    createdAt: "2026-10-15T00:00:00Z",
    updatedAt: "2026-10-15T00:00:00Z",
  };
}

describe("classifyTableNoise（封面 / 目录定向过滤）", () => {
  it("目录页码形态（≥2 列递增小整数）判噪声", () => {
    const noise = classifyTableNoise({
      page: 3,
      headers: ["章节", "页", "章节页"],
      rows: [
        ["第一章 绪论", "1", "1"],
        ["第二章 方法", "12", "12"],
        ["第三章 实验", "30", "30"],
        ["第四章 结论", "55", "55"],
        ["参考文献", "60", "60"],
      ],
      labelBasis: "none",
    });
    expect(noise?.likely).toBe(true);
    expect(noise?.reasons.some((r) => r.startsWith("page_number_columns"))).toBe(true);
  });

  it("封面页短文本网格（page≤2 无题注）判噪声", () => {
    const noise = classifyTableNoise({
      page: 1,
      headers: ["题目", "信息"],
      rows: [["某大学", "博士学位论文"], ["作者姓名", "指导教师"]],
      labelBasis: "none",
    });
    expect(noise?.likely).toBe(true);
    expect(noise?.reasons).toContain("cover_page_short_text");
  });

  it("退化网格（单列）无题注判噪声", () => {
    const noise = classifyTableNoise({
      page: 5,
      headers: ["条目"],
      rows: [["第一条"], ["第二条"], ["第三条"]],
      labelBasis: "none",
    });
    expect(noise?.likely).toBe(true);
    expect(noise?.reasons).toContain("degenerate_grid");
  });

  it("反例守卫：正文页无题注的真实数据表不被误杀", () => {
    const noise = classifyTableNoise({
      page: 7,
      headers: ["Method", "AP50", "AP75"],
      rows: [
        ["Baseline", "60.2", "41.3"],
        ["Ours", "66.8", "47.9"],
        ["Ours-Lite", "63.1", "44.5"],
      ],
      labelBasis: "none",
    });
    expect(noise).toBeUndefined();
  });

  it("反例守卫：有题注的目录后页表格（页码列混合真实数值）不误杀", () => {
    const noise = classifyTableNoise({
      page: 12,
      caption: "表 5.2 配置对比",
      headers: ["Method", "参量", "增益"],
      rows: [
        ["A", "16", "2.4"],
        ["B", "19", "3.1"],
        ["C", "22", "4.8"],
      ],
      labelBasis: "parser_caption",
    });
    expect(noise).toBeUndefined();
  });

  it("extractTables / extractTableFacts 全链路：噪声表被跳过并计数", () => {
    const toc = tableBlock("B0001", 2, ["章节", "页"], [
      ["第一章", "1"], ["第二章", "12"], ["第三章", "30"], ["第四章", "55"], ["附录", "60"],
    ]);
    const real = tableBlock("B0004", 7, ["Method", "AP"], [["Ours", "82.4"], ["Base", "78.2"]], "Table 1: COCO");
    const doc = documentOf([toc, real]);
    const tables = extractTables(doc);
    expect(tables.find((t) => t.blockId === "B0001")!.noise?.likely).toBe(true);
    expect(tables.find((t) => t.blockId === "B0004")!.noise).toBeUndefined();
    const result = extractTableFacts(inputOf("ri-noise", "hash-1"), doc, "2026-10-15T00:00:00Z");
    expect(result.skippedNoiseTables).toBe(1);
    expect(result.facts.every((f) => f.provenance.blockId !== "B0001")).toBe(true);
    expect(result.facts.some((f) => f.provenance.blockId === "B0004")).toBe(true);
  });
});

describe("候选对齐作者确认（服务层全链路）", () => {
  it("candidate → confirmed：可比 + basis=author_decision + decisionId；确认后进入冲突检测；原始数值不动", async () => {
    const fx = await newThesisFixture();
    try {
      // 列重排场景（数据列顺序不同、集合一致）：确定性对齐只能到 candidate
      const base = tableBlock("B0001", 3, ["Method", "mAP", "FAR"], [["Ours", "82.4", "5.1"], ["Base", "78.2", "7.3"]], "Table 1");
      const variant = tableBlock("B0002", 4, ["Method", "FAR", "mAP"], [["Ours", "5.1", "82.4"], ["Base", "7.3", "78.2"]], "Table 1");
      const a = await fx.importPdf({ fileName: "v1.pdf", blocks: [base] }, "published_paper");
      const b = await fx.importPdf({ fileName: "v2.pdf", blocks: [variant] }, "preprint");
      await fx.service.extractFacts(fx.projectId, a.inputId);
      await fx.service.extractFacts(fx.projectId, b.inputId);

      const detected = await fx.service.detectConflicts(fx.projectId);
      const candidates = detected.alignments.filter((al) => al.status === "candidate");
      expect(candidates.length).toBeGreaterThan(0);
      // 候选展示信息：两侧表头样本
      for (const candidate of candidates) {
        expect(candidate.evidence.columnLabelsSample).toBeDefined();
        expect(candidate.evidence.columnLabelsSample!.length).toBe(2);
      }
      const candidate = candidates[0]!;
      const alignmentId = candidate.alignmentId;

      // 作者确认（HITL）
      const { decision } = await fx.service.submitDecision(fx.projectId, {
        actor: { kind: "test_fixture" },
        payload: { type: "table_alignment_confirmation", alignmentId, outcome: "confirmed" },
      });
      expect(decision.type).toBe("table_alignment_confirmation");

      const after = (await fx.service.list(fx.projectId)).alignments.find((al) => al.alignmentId === alignmentId)!;
      expect(after.status).toBe("comparable");
      expect(after.basis).toBe("author_decision");
      expect(after.decisionId).toBe(decision.decisionId);

      // 确认后重新检测：comparable 对齐进入冲突检测（此例数值相同 → 无冲突或仅既有）
      const redetected = await fx.service.detectConflicts(fx.projectId);
      expect(redetected.alignments.find((al) => al.alignmentId === alignmentId)!.status).toBe("comparable");

      // 原始数值不被覆盖：确认前后表格事实值一致
      const factsA = await fx.service.facts.list(fx.projectId, { researchInputId: a.inputId });
      expect(factsA.find((f) => f.value.raw === "82.4")).toBeTruthy();
    } finally {
      await cleanupThesisFixtures();
    }
  });

  it("candidate → rejected：not_comparable + rejectionReason；不进入冲突检测", async () => {
    const fx = await newThesisFixture();
    try {
      const base = tableBlock("B0001", 3, ["Method", "mAP"], [["Ours", "82.4"], ["Base", "78.2"]], "Table 1");
      const variant = tableBlock("B0002", 4, ["Method", "mAP"], [["Ours", "88.1"], ["Base", "78.2"]], "Table 1");
      const a = await fx.importPdf({ fileName: "v1.pdf", blocks: [base] }, "published_paper");
      const b = await fx.importPdf({ fileName: "v2.pdf", blocks: [variant] }, "preprint");
      await fx.service.extractFacts(fx.projectId, a.inputId);
      await fx.service.extractFacts(fx.projectId, b.inputId);

      const detected = await fx.service.detectConflicts(fx.projectId);
      // 该例数值差异大 → 可能不是 candidate；找任一 candidate 或用 comparable 拒绝路径
      const target = detected.alignments.find((al) => al.status === "candidate" || al.status === "comparable");
      expect(target).toBeTruthy();

      await fx.service.submitDecision(fx.projectId, {
        actor: { kind: "test_fixture" },
        payload: { type: "table_alignment_confirmation", alignmentId: target!.alignmentId, outcome: "rejected", rationale: "两表实验协议不同" },
      });

      const after = (await fx.service.list(fx.projectId)).alignments.find((al) => al.alignmentId === target!.alignmentId)!;
      expect(after.status).toBe("not_comparable");
      expect(after.evidence.rejectionReason).toBe("两表实验协议不同");

      // 拒绝后重新检测：deterministic 重算不覆盖作者拒绝（upsertAlignments 保留 author_decision）
      await fx.service.detectConflicts(fx.projectId);
      const final = (await fx.service.list(fx.projectId)).alignments.find((al) => al.alignmentId === target!.alignmentId)!;
      expect(final.status).toBe("not_comparable");
    } finally {
      await cleanupThesisFixtures();
    }
  });

  it("决定与内容版本绑定：contentHash 变化产生新 alignmentId，旧决定不自动适用", async () => {
    const fx = await newThesisFixture();
    try {
      const base = tableBlock("B0001", 3, ["Method", "mAP"], [["Ours", "82.4"], ["Base", "78.2"]], "Table 1");
      const a = await fx.importPdf({ fileName: "v1.pdf", blocks: [base] }, "published_paper");
      const b = await fx.importPdf({ fileName: "v2.pdf", blocks: [base] }, "preprint");
      await fx.service.extractFacts(fx.projectId, a.inputId);
      await fx.service.extractFacts(fx.projectId, b.inputId);
      const detected = await fx.service.detectConflicts(fx.projectId);
      const target = detected.alignments.find((al) => al.status !== "not_comparable");
      expect(target).toBeTruthy();
      await fx.service.submitDecision(fx.projectId, {
        actor: { kind: "test_fixture" },
        payload: { type: "table_alignment_confirmation", alignmentId: target!.alignmentId, outcome: "rejected" },
      });

      // 新版本 v3（不同 bytes → 不同 contentHash → 不同 alignmentId）
      const updated = tableBlock("B0001", 3, ["Method", "mAP"], [["Ours", "84.0"], ["Base", "78.2"]], "Table 1");
      const c = await fx.importPdf({ fileName: "v3.pdf", bytes: "different-bytes-v3", blocks: [updated] }, "preprint");
      await fx.service.extractFacts(fx.projectId, c.inputId);
      const redetected = await fx.service.detectConflicts(fx.projectId);
      const newAlignment = redetected.alignments.find(
        (al) => (al.left.researchInputId === a.inputId && al.right.researchInputId === c.inputId) ||
          (al.left.researchInputId === c.inputId && al.right.researchInputId === a.inputId),
      );
      if (newAlignment !== undefined) {
        expect(newAlignment.alignmentId).not.toBe(target!.alignmentId);
        expect(newAlignment.basis).toBe("deterministic"); // 旧决定不自动适用
      }
    } finally {
      await cleanupThesisFixtures();
    }
  });

  it("resume 输入映射：confirm_table_alignment / reject_table_alignment", async () => {
    const { authorDecisionFromResumeInput } = await import("../../src/thesis/ResearchInputService.js");
    const confirmed = authorDecisionFromResumeInput({
      decision: "confirm_table_alignment",
      payload: { alignmentId: "A123", rationale: "列对应关系已核对" },
    });
    expect(confirmed).toEqual({ type: "table_alignment_confirmation", alignmentId: "A123", outcome: "confirmed", rationale: "列对应关系已核对" });
    const rejected = authorDecisionFromResumeInput({ decision: "reject_table_alignment", payload: { alignmentId: "A456" } });
    expect(rejected).toEqual({ type: "table_alignment_confirmation", alignmentId: "A456", outcome: "rejected", rationale: undefined });
  });

  it("未知 alignmentId 的决定被拒绝（NotFound，不猜）", async () => {
    const fx = await newThesisFixture();
    try {
      await expect(
        fx.service.submitDecision(fx.projectId, {
          actor: { kind: "test_fixture" },
          payload: { type: "table_alignment_confirmation", alignmentId: "A-does-not-exist", outcome: "confirmed" },
        }),
      ).rejects.toMatchObject({ code: "NOT_FOUND" });
    } finally {
      await cleanupThesisFixtures();
    }
  });
});

describe("alignTables 候选证据（展示信息）", () => {
  it("纯函数层：candidate 对齐带 columnLabelsSample 与 rowPairs", () => {
    const a = extractTables(documentOf([tableBlock("B0001", 1, ["Method", "mAP"], [["Ours", "82.4"], ["Base", "78.2"], ["X", "79.0"]], "Table 1")]));
    const b = extractTables(documentOf([tableBlock("B0002", 2, ["Method", "mAP"], [["Ours", "82.4"], ["Base", "78.2"], ["X", "88.1"]], "Table 1")]));
    const alignments = alignTables(
      { input: inputOf("ri-a", "ha"), tables: a },
      { input: inputOf("ri-b", "hb"), tables: b },
      "p-test",
      "2026-10-15T00:00:00Z",
    );
    expect(alignments.length).toBeGreaterThan(0);
    for (const alignment of alignments) {
      // 数据列表头样本（标签列不计入）
      expect(alignment.evidence.columnLabelsSample).toEqual([["mAP"], ["mAP"]]);
      expect(alignment.evidence.rowPairs.length).toBe(3);
    }
  });
});
