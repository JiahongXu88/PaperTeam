/**
 * M12.3 C4：Dataset 候选提取（figures/datasets.ts）单元测试。
 * - ParsedTableBlock（PDF 表格）→ 数据集（表头唯一化 / 数值化 / hash）；
 * - 连续 structured_record 游程（CSV/XLSX/JSON 投影）→ 数据集（列对齐 / 缺格 null）；
 * - coerceCell 确定性数值化（千分位 / 科学计数 / 非数值保留字符串 / 空 → null）；
 * - findDatasetByAnchor 锚查找。
 */

import { describe, expect, it } from "vitest";

import {
  coerceDatasetCell,
  extractDatasetsFromDocument,
  findDatasetByAnchor,
} from "../../src/figures/datasets.js";
import { computeDatasetHash } from "../../src/figures/spec.js";
import type { ParsedDocument } from "../../src/ingestion/types.js";

function documentOf(blocks: ParsedDocument["blocks"]): ParsedDocument {
  return {
    schemaVersion: 1,
    sourceId: "S01",
    fileName: "fixture.csv",
    storedFileName: "S01-fixture.csv",
    kind: "tabular",
    mimeType: "text/csv",
    parser: { id: "fixture" },
    parseMode: "structured",
    status: "ok",
    blocks,
    counts: { text: 0, table: 0, figure: 0, formula: 0, structured_record: 0, code: 0, output: 0 },
    notes: [],
    contentHash: "hash",
    parsedAt: "2026-10-08T00:00:00Z",
  };
}

describe("coerceDatasetCell", () => {
  it("数值 / 千分位 / 科学计数确定性数值化；非数值保留；空 → null", () => {
    expect(coerceDatasetCell("62.1")).toBe(62.1);
    expect(coerceDatasetCell(" 63.4 ")).toBe(63.4);
    expect(coerceDatasetCell("-3")).toBe(-3);
    expect(coerceDatasetCell("1,234")).toBe(1234);
    expect(coerceDatasetCell("1,234.5")).toBe(1234.5);
    expect(coerceDatasetCell("2e3")).toBe(2000);
    expect(coerceDatasetCell("Ours")).toBe("Ours");
    expect(coerceDatasetCell("")).toBeNull();
    expect(coerceDatasetCell("12,34")).toBe("12,34"); // 非千分位形态不剥离
  });
});

describe("extractDatasetsFromDocument", () => {
  it("table 块 → 数据集：表头保留、空表头补列号、重复表头唯一化、数值列数值化", () => {
    const document = documentOf([
      {
        blockId: "B0003",
        type: "table",
        caption: "Table 1: MOT results",
        headers: ["method", "hota", "", "hota"],
        rows: [
          ["Baseline", "62.1", "x", "62.1"],
          ["Ours", "63.4", "y", "63.4"],
        ],
        rowCount: 2,
        columnCount: 4,
        provenance: { fileName: "f", page: 1 },
      },
    ]);
    const datasets = extractDatasetsFromDocument(document);
    expect(datasets.length).toBe(1);
    const dataset = datasets[0]!;
    expect(dataset.kind).toBe("table");
    expect(dataset.blockId).toBe("B0003");
    expect(dataset.caption).toBe("Table 1: MOT results");
    expect(dataset.columns).toEqual(["method", "hota", "列3", "hota(2)"]);
    expect(dataset.rowCount).toBe(2);
    expect(dataset.inlineDataset.rows[0]).toEqual(["Baseline", 62.1, "x", 62.1]);
    // datasetHash 与 spec 同源函数
    expect(dataset.datasetHash).toBe(computeDatasetHash(dataset.inlineDataset));
  });

  it("连续 structured_record 游程 → 单数据集：按 header 首现序对齐、缺格 null、游程切割", () => {
    const record = (blockId: string, row: number, cells: Array<[string, string]>) => ({
      blockId,
      type: "structured_record" as const,
      cells: cells.map(([header, value]) => ({ header, value })),
      provenance: { fileName: "f", row },
    });
    const document = documentOf([
      record("B0001", 1, [["epoch", "1"], ["loss", "0.5"]]),
      record("B0002", 2, [["epoch", "2"], ["loss", "0.3"]]),
      record("B0003", 3, [["epoch", "3"], ["loss", "0.2"], ["lr", "0.01"]]),
      // 中断游程的文本块
      { blockId: "B0004", type: "text", text: "note", provenance: { fileName: "f" } },
      // 新游程（独立数据集）
      record("B0005", 5, [["epoch", "1"], ["acc", "81.2"]]),
    ]);
    const datasets = extractDatasetsFromDocument(document);
    expect(datasets.length).toBe(2);
    const first = datasets[0]!;
    expect(first.kind).toBe("records");
    expect(first.blockId).toBe("B0001-B0003");
    expect(first.columns).toEqual(["epoch", "loss", "lr"]);
    expect(first.rowCount).toBe(3);
    // 缺格 → null（不填 0）
    expect(first.inlineDataset.rows[0]).toEqual([1, 0.5, null]);
    expect(first.inlineDataset.rows[2]).toEqual([3, 0.2, 0.01]);
    const second = datasets[1]!;
    expect(second.blockId).toBe("B0005-B0005");
    expect(second.columns).toEqual(["epoch", "acc"]);
  });

  it("findDatasetByAnchor 按 (sourceId, blockId) 定位（含游程区间形态）", () => {
    const document = documentOf([
      {
        blockId: "B0002",
        type: "structured_record",
        cells: [{ header: "x", value: "1" }],
        provenance: { fileName: "f" },
      },
      {
        blockId: "B0003",
        type: "structured_record",
        cells: [{ header: "x", value: "2" }],
        provenance: { fileName: "f" },
      },
    ]);
    const payloads = extractDatasetsFromDocument(document);
    expect(findDatasetByAnchor(payloads, "S01", "B0002-B0003")?.rowCount).toBe(2);
    expect(findDatasetByAnchor(payloads, "S01", "B0009")).toBeUndefined();
    expect(findDatasetByAnchor(payloads, "S09", "B0002-B0003")).toBeUndefined();
  });
});
