/**
 * M14.3 — 跨章一致性 MVP 单元测试（术语变体 / 同实验跨章数值疑点 / 未定义引用；
 * 全部 advisory 不阻断）。
 */
import { describe, expect, it } from "vitest";

import { checkCrossChapterConsistency } from "../../src/thesis/crossChapterConsistency.js";
import type { ResearchFactContext } from "../../src/thesis/researchInputTypes.js";

function factContext(keys: Array<{ dataset?: string; metric?: string; subject?: string }>): ResearchFactContext {
  return {
    schemaVersion: 1,
    generatedAt: "2026-10-15T00:00:00Z",
    projectId: "p-test",
    inputs: { included: [], excluded: [], proposed: [], superseded: [], preferredVersionByWork: {} },
    facts: {
      authorConfirmed: keys.map((key, index) => ({
        factId: `F${index}`,
        researchInputId: "ri-x",
        kind: "table_cell" as const,
        key,
        surface: "0.724",
        value: { raw: "0.724", numeric: 0.724 },
        verification: "author_confirmed" as const,
        sourceCheck: "verified" as const,
        conflictStatus: "none" as const,
        location: "表1 行0 列1",
      })),
      sourceVerifiedUnconfirmed: [],
      extractedOnly: [],
      conflicted: [],
    },
    conflicts: { unresolved: [], resolved: [], deferred: [] },
    pendingDecisions: [],
    writingBlockers: [],
  };
}

describe("M14.3 跨章一致性 MVP", () => {
  it("术语变体：事实键中的同归一化形态（S-measure / SMeasure）跨章混用被检出（双位置）", () => {
    const result = checkCrossChapterConsistency({
      projectId: "p",
      now: "2026-10-15T00:00:00Z",
      chapters: [
        { chapterId: "ch1", titleZh: "第三章", sectionFiles: ["a.tex"] },
        { chapterId: "ch2", titleZh: "第四章", sectionFiles: ["b.tex"] },
      ],
      sectionContents: new Map([
        ["a.tex", "我们提出 S-measure 指标，在 DUTS 上为 0.724。"],
        ["b.tex", "本章沿用 SMeasure 指标进行分析，DUTS 上为 0.724。"],
      ]),
      factContext: factContext([
        { dataset: "DUTS", metric: "S-measure" },
        { dataset: "DUTS", metric: "SMeasure" },
      ]),
    });
    const variant = result.findings.find((finding) => finding.kind === "term_variant");
    expect(variant).toBeDefined();
    expect(variant!.summary).toContain("S-measure");
    expect(variant!.summary).toContain("SMeasure");
    expect(variant!.locations.length).toBeGreaterThanOrEqual(2);
    expect(variant!.severity).toBe("advisory");
  });

  it("同实验跨章数值疑点：同 key 两章不同数值（双位置 + suspicious）", () => {
    const result = checkCrossChapterConsistency({
      projectId: "p",
      now: "2026-10-15T00:00:00Z",
      chapters: [
        { chapterId: "ch1", titleZh: "方法章", sectionFiles: ["a.tex"] },
        { chapterId: "ch5", titleZh: "总结章", sectionFiles: ["e.tex"] },
      ],
      sectionContents: new Map([
        ["a.tex", "本方法在 DUTS 上 S 达到 0.724。"],
        ["e.tex", "本方法在 DUTS 上 S 达到 0.811。"],
      ]),
      factContext: factContext([{ dataset: "DUTS", metric: "S" }]),
    });
    const suspicion = result.findings.find((finding) => finding.kind === "numeric_suspicion");
    expect(suspicion).toBeDefined();
    expect(suspicion!.severity).toBe("suspicious");
    expect(suspicion!.locations).toHaveLength(2);
    expect(suspicion!.locations.map((location) => location.chapterId).sort()).toEqual(["ch1", "ch5"]);
  });

  it("等价舍入不算疑点", () => {
    const result = checkCrossChapterConsistency({
      projectId: "p",
      now: "2026-10-15T00:00:00Z",
      chapters: [
        { chapterId: "ch1", titleZh: "方法章", sectionFiles: ["a.tex"] },
        { chapterId: "ch5", titleZh: "总结章", sectionFiles: ["e.tex"] },
      ],
      sectionContents: new Map([
        ["a.tex", "本方法在 DUTS 上 S 达到 0.724。"],
        ["e.tex", "本方法在 DUTS 上 S 约 0.72。"],
      ]),
      factContext: factContext([{ dataset: "DUTS", metric: "S" }]),
    });
    expect(result.findings.find((finding) => finding.kind === "numeric_suspicion")).toBeUndefined();
  });

  it("未定义交叉引用被检出（advisory）", () => {
    const result = checkCrossChapterConsistency({
      projectId: "p",
      now: "2026-10-15T00:00:00Z",
      chapters: [{ chapterId: "ch1", titleZh: "方法章", sectionFiles: ["a.tex"] }],
      sectionContents: new Map([["a.tex", "如\\ref{tab:missing}所示，结果良好。\\label{fig:ok}"]]),
      factContext: factContext([]),
    });
    const reference = result.findings.find((finding) => finding.kind === "undefined_reference");
    expect(reference).toBeDefined();
    expect(reference!.summary).toContain("tab:missing");
  });

  it("一致文本零 finding", () => {
    const result = checkCrossChapterConsistency({
      projectId: "p",
      now: "2026-10-15T00:00:00Z",
      chapters: [
        { chapterId: "ch1", titleZh: "方法章", sectionFiles: ["a.tex"] },
        { chapterId: "ch2", titleZh: "实验章", sectionFiles: ["b.tex"] },
      ],
      sectionContents: new Map([
        ["a.tex", "本方法在 DUTS 上 S 达到 0.724。\\label{sec:method}"],
        ["b.tex", "实验表明 DUTS 上 S 为 0.724（见\\ref{sec:method}）。"],
      ]),
      factContext: factContext([{ dataset: "DUTS", metric: "S" }]),
    });
    expect(result.findings).toHaveLength(0);
    expect(result.checked.chapters).toBe(2);
  });
});
