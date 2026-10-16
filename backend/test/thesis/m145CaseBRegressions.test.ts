/**
 * M14.5 案例 B（李谨杰 CDC 2023 小论文）真实 run 暴露的确定性解析缺陷回归：
 *   1. 堆叠式子表头表格（Table II：「Setting|Layers|Initialization|Activation」之后
 *      又一行「Optimizer|Epoch|Learning Rate|Loss Function」+ 数据行）——旧抽取把
 *      「20,000」标成「Adam | Layers」、「1e-4」标成「Adam | Initialization」，Writer 据此
 *      写出「初始化参数取为 1e-4」（语义错误）。
 *   2. 控制类论文核心结果「a 75.37% reduction in tracking error」/「跟踪误差降低了 75.37%」
 *      不在旧指标词典中 → 零正文事实 → 结果只能以贡献陈述形式存在，Writer 写入后
 *      Reviewer 阻断。
 */
import { describe, expect, it } from "vitest";

import type { ParsedBlock, ParsedDocument } from "../../src/ingestion/types.js";
import { extractBodyTextFacts } from "../../src/thesis/bodyTextFacts.js";
import { renderThesisFactPolicyLines } from "../../src/thesis/thesisWritingContext.js";
import { detectStackedSubHeaders, extractTableFacts, extractTables, isPairedKeyValueHeader } from "../../src/thesis/factExtraction.js";
import type { ResearchInput } from "../../src/thesis/researchInputTypes.js";
import { tableBlock, textBlock } from "./fixtures.js";

function researchInputOf(inputId = "ri-caseb000001"): ResearchInput {
  return {
    schemaVersion: 1,
    inputId,
    projectId: "p-test",
    inputType: "published_paper",
    title: "NDP-NMPC",
    authors: [],
    identifiers: {},
    workId: inputId,
    version: { sourceId: "S001", contentHash: "hash-1", bytes: 100, importedAt: "2026-10-16T00:00:00Z" },
    parse: { status: "full_text", notes: [] },
    scope: { status: "included", updatedAt: "2026-10-16T00:00:00Z" },
    evidenceLinks: { evidenceIds: [] },
    createdAt: "2026-10-16T00:00:00Z",
    updatedAt: "2026-10-16T00:00:00Z",
  } as unknown as ResearchInput;
}

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
    parsedAt: "2026-10-16T00:00:00Z",
  };
}

/** CDC 2023 Table II 的 docling 真实形状（M14.5 案例 B 实录） */
const TABLE_II = tableBlock(
  "B0113",
  6,
  ["Setting", "Layers", "Initialization", "Activation Function"],
  [
    ["Value", "6-128-64-128-3", "normal", "ReLU"],
    ["Optimizer", "Epoch", "Learning Rate", "Loss Function"],
    ["Adam", "20,000", "1e-4", "Mean Squared Error"],
  ],
  "TABLE II: SETTINGS FOR TRAINING THE NETWORK",
);

describe("M14.5 堆叠式子表头表格（案例 B Table II）", () => {
  it("子表头行被识别：其后数据行的列标签取子表头，而不是顶部表头", () => {
    const [table] = extractTables(documentOf([TABLE_II]));
    expect(table).toBeDefined();
    expect(table!.rows[1]!.columnLabels).toBeUndefined(); // 子表头行本身
    expect(table!.rows[2]!.columnLabels).toEqual(["Optimizer", "Epoch", "Learning Rate", "Loss Function"]);
    expect(table!.rows[0]!.columnLabels).toBeUndefined(); // 第一组数据行仍用顶部表头
    const { facts } = extractTableFacts(researchInputOf(), documentOf([TABLE_II]), "2026-10-16T00:00:00Z");
    const labelled = facts.map((fact) => `${fact.provenance.table?.rowLabel} | ${fact.provenance.table?.columnLabel} = ${fact.value.raw}`);
    expect(labelled).toContain("Adam | Epoch = 20,000");
    expect(labelled).toContain("Adam | Learning Rate = 1e-4");
    expect(labelled.some((entry) => entry.includes("| Layers = 20,000") || entry.includes("| Initialization = 1e-4"))).toBe(false);
    // 事实 id 仍按 (block,row,column) 稳定——重抽取对同一单元格不产生第二条事实
    expect(new Set(facts.map((fact) => fact.factId)).size).toBe(facts.length);
  });

  it("保守边界：全文本数据行后无数值行 / 与表头相同的行 / 首行 → 不当成子表头", () => {
    const direct = detectStackedSubHeaders(
      ["Method", "Backbone", "Pretrain"],
      [
        ["Ours", "ResNet", "yes"],
        ["Base", "VGG", "no"],
      ],
    );
    expect(direct.size).toBe(0);
    const repeatedHeader = detectStackedSubHeaders(
      ["Method", "S"],
      [
        ["Ours", "0.724"],
        ["Method", "S"],
        ["Base", "0.667"],
      ],
    );
    expect(repeatedHeader.size).toBe(0);
    const normal = extractTables(documentOf([tableBlock("B0001", 1, ["Method", "S ↑"], [["Ours", "0.724"], ["Base", "0.667"]], "表1")]));
    expect(normal[0]!.rows.every((row) => row.columnLabels === undefined)).toBe(true);
    // 真实数据行永远不会被当成子表头（含数值）
    const numericRow = detectStackedSubHeaders(["A", "B"], [["x", "1"], ["y", "2"], ["z", "3"]]);
    expect(numericRow.size).toBe(0);
  });
});

/** CDC 2023 Table III 的 docling 真实形状：三组 Parameter|Value 并排 */
const TABLE_III = tableBlock(
  "B0121",
  6,
  ["Parameter", "Value", "Parameter", "Value", "Parameter", "Value"],
  [
    ["N", "20", "dtnmpc", "1/60s", "dtpred", "0.1s"],
    ["Qp,xy", "300", "Qp,z", "400", "Qv,xyz", "1"],
    ["Qq,xyz", "0.1", "Rω,xyz", "10", "Rfc", "10"],
  ],
  "TABLE III: CONTROL PARAMETERS",
);

describe("M14.5 成对键值列表格（案例 B Table III）", () => {
  it("每个数值的行标签取左侧相邻键：Qp,z=400 / dtpred=0.1s，而不是整行首列", () => {
    expect(isPairedKeyValueHeader(["Parameter", "Value", "Parameter", "Value", "Parameter", "Value"])).toBe(true);
    expect(isPairedKeyValueHeader(["Method", "S", "max F", "M"])).toBe(false);
    expect(isPairedKeyValueHeader(["Parameter", "Value"])).toBe(false);
    const [table] = extractTables(documentOf([TABLE_III]));
    expect(table!.pairedKeyValue).toBe(true);
    const { facts } = extractTableFacts(researchInputOf(), documentOf([TABLE_III]), "2026-10-16T00:00:00Z");
    const labelled = facts.map((fact) => `${fact.provenance.table?.rowLabel} | ${fact.provenance.table?.columnLabel} = ${fact.value.raw}`);
    expect(labelled).toContain("Qp,z | Value = 400");
    expect(labelled).toContain("Qp,xy | Value = 300");
    expect(labelled).toContain("dtpred | Value = 0.1s");
    expect(labelled).toContain("Rω,xyz | Value = 10");
    expect(labelled.filter((entry) => entry.startsWith("Qp,xy |"))).toHaveLength(1);
    expect(labelled.filter((entry) => entry.startsWith("N |"))).toHaveLength(1);
    const qpz = facts.find((fact) => fact.value.raw === "400")!;
    expect(qpz.key.subject).toMatch(/qp,?z/i);
  });
});

describe("M14.5 Reviewer 事实口径：作者已确认研究输入事实 = 合法数据来源", () => {
  const fact = (factId: string, surface: string, metric: string) =>
    ({ factId, kind: "numeric_result", surface, key: { metric }, value: { raw: surface } }) as never;
  it("有已确认事实 → 注入事实表与口径；无已确认事实 → 空（prompt 不变）", () => {
    const lines = renderThesisFactPolicyLines({ facts: { authorConfirmed: [fact("F1", "75.37%", "error")], sourceVerifiedUnconfirmed: [fact("F2", "0.12", "error")], conflicted: [] } });
    const text = lines.join("\n");
    expect(text).toContain("学位论文研究输入已确认事实");
    expect(text).toContain("- 75.37%（error）");
    expect(text).toContain("不得判为「无实验数据」");
    expect(text).toContain("1 条仅来源核验");
    expect(renderThesisFactPolicyLines({ facts: { authorConfirmed: [], sourceVerifiedUnconfirmed: [fact("F2", "0.12", "error")], conflicted: [] } })).toEqual([]);
  });
});

describe("M14.5 正文结果事实：误差类指标与「数值在前」的相对变化句式", () => {
  it("英文：『a 75.37% reduction in tracking error in height』→ error=75.37%", () => {
    const doc = documentOf([
      textBlock("B0001", 1, "In addition, a real-time trajectory tracking experiment is performed with the entire system, demonstrating a 75.37% reduction in tracking error in height under the downwash effect."),
    ]);
    const result = extractBodyTextFacts(researchInputOf(), doc, "2026-10-16T00:00:00Z");
    const metrics = result.facts.map((fact) => `${fact.key.metric}=${fact.value.raw}`);
    expect(metrics).toContain("error=75.37%");
    const fact = result.facts.find((entry) => entry.value.raw === "75.37%")!;
    expect(fact.kind).toBe("numeric_result");
    expect(fact.provenance.blockId).toBe("B0001");
    expect(fact.surface).toBe("75.37%");
  });

  it("中文：『跟踪误差降低了 75.37%』/『RMSE 为 0.12』命中；无变化词的百分比不猜", () => {
    const doc = documentOf([
      textBlock("B0002", 2, "在下洗效应影响下，高度跟踪误差降低了 75.37%。整体 RMSE 为 0.12。"),
      textBlock("B0003", 3, "About 30% of the flights were conducted outdoors near the tracking error threshold."),
    ]);
    const result = extractBodyTextFacts(researchInputOf(), doc, "2026-10-16T00:00:00Z");
    const metrics = result.facts.map((fact) => `${fact.key.metric}=${fact.value.raw}`);
    expect(metrics).toContain("error=75.37%");
    expect(metrics).toContain("error=0.12");
    // 「30% of the flights … tracking error threshold」：百分比后面不是变化词 → 不成为误差事实
    expect(result.facts.filter((fact) => fact.provenance.blockId === "B0003")).toHaveLength(0);
  });
});
