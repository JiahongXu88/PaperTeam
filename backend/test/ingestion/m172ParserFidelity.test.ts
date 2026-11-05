/**
 * M17.2 解析保真回归（SYNTHETIC 夹具，测试内用 exceljs 生成）：XLSX 百分比格式 / 合并单元格从格 / 无缓存公式 / 多 sheet，
 * JSON 重复键。对照：普通数值、带缓存值公式、无重复键 JSON 照常解析。
 */

import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";

import { XlsxParser } from "../../src/ingestion/xlsxTabular.js";
import { JsonParser } from "../../src/ingestion/jsonStructured.js";
import { findDuplicateJsonKeys } from "../../src/ingestion/jsonDuplicateKeys.js";
import type { ParsedRecordBlock } from "../../src/ingestion/types.js";

async function workbookBuffer(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("results");
  sheet.addRow(["method", "HOTA", "IDF1", "Derived"]);
  sheet.addRow(["base", 0.47250, 52.600, { formula: "B2*100", result: 47.250 }]);
  sheet.addRow(["ours", 0.49830, 57.940, { formula: "B3*100" }]);
  sheet.addRow(["", 0.5, 60, 1]);
  sheet.getCell("B2").numFmt = "0.0%";
  sheet.getCell("B3").numFmt = "0.0%";
  sheet.mergeCells("C4:D4");
  const second = workbook.addWorksheet("ablation");
  second.addRow(["method", "HOTA"]);
  second.addRow(["ours-lite", 49.970]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("XLSX 保真（M17.2）", () => {
  it("百分比格式 / 合并从格 / 无缓存公式被显式标注；多 sheet 保留 sheet 定位", async () => {
    const extraction = await new XlsxParser().parseBuffer(await workbookBuffer(), "synthetic.xlsx");
    const blocks = extraction.blocks as ParsedRecordBlock[];
    const cell = (sheet: string, row: number, letter: string) => blocks.find((block) => block.provenance.sheet === sheet && block.provenance.row === row)?.cells.find((entry) => entry.letter === letter);
    expect(cell("results", 2, "B")).toMatchObject({ value: "0.4725", numberFormat: "percent" });
    expect(cell("results", 2, "C")).toMatchObject({ value: "52.6" });
    expect(cell("results", 2, "C")?.numberFormat).toBeUndefined();
    // 带缓存值的公式：取缓存值（对照）
    expect(cell("results", 2, "D")).toMatchObject({ value: "47.25" });
    // 无缓存值的公式：空值 + 标注，不执行公式、不猜值
    expect(cell("results", 3, "D")).toMatchObject({ value: "", formulaNoCachedValue: true });
    expect(extraction.notes.some((note) => note.includes("公式没有缓存计算结果"))).toBe(true);
    expect(extraction.quality).toBe("partial");
    // 合并区域从格：值复制自主格，标 mergedFrom
    expect(cell("results", 4, "D")).toMatchObject({ value: "60", mergedFrom: "C4" });
    expect(cell("results", 4, "C")?.mergedFrom).toBeUndefined();
    expect(cell("ablation", 2, "B")).toMatchObject({ value: "49.97" });
  });
});

describe("JSON 重复键（M17.2）", () => {
  it("同一对象内重复键登记为 note（解析值仍按标准后者覆盖）；对照：不同对象同名键不算重复", () => {
    const text = '{"arms":{"base":{"HOTA":47.250,"HOTA":48.250},"ours":{"HOTA":49.830}},"list":[{"a":1},{"a":2}]}';
    expect(findDuplicateJsonKeys(text)).toEqual(["$.arms.base.HOTA"]);
    const extraction = new JsonParser().parseBuffer(Buffer.from(text), "dup.json");
    expect(extraction.notes.some((note) => note.includes("JSON 重复键 $.arms.base.HOTA"))).toBe(true);
    expect(extraction.quality).toBe("partial");
    expect(findDuplicateJsonKeys('{"a":{"x":1},"b":{"x":2},"s":"{\\"x\\":1,\\"x\\":2}"}')).toEqual([]);
  });
});
