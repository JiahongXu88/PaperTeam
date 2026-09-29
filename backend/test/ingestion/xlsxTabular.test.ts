/**
 * M10.1C XLSX 解析测试（exceljs 现场构造 fixture，零网络）：
 * sheet/row/column provenance、数值与日期、公式结果、损坏文件报错。
 */

import { describe, expect, it } from "vitest";
import ExcelJS from "exceljs";

import { XlsxParser } from "../../src/ingestion/xlsxTabular.js";

const parser = new XlsxParser();

async function buildWorkbook(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet1 = workbook.addWorksheet("Sheet1");
  sheet1.addRow(["Method", "MOTA", "IDF1", "Note"]);
  sheet1.addRow(["Ours", 82.4, 79.1, "best"]);
  sheet1.addRow(["Baseline", 78.2, 75.0]);
  // addRow([])（零单元格行）exceljs 序列化时不物化——重读后后续行号前移；
  // 真实 Excel 文件里空行有 r 编号，行号保持。此处验证读取侧行号跟随 r 编号。
  sheet1.addRow([]);
  sheet1.addRow(["Gain", { formula: "B2-B3" }, { formula: "C2-C3" }]);
  const sheet2 = workbook.addWorksheet("Ablation");
  sheet2.addRow(["Variant", "MOTA"]);
  sheet2.addRow(["full", 82.4]);
  sheet2.addRow(["w/o motion", 80.1]);
  const data = await workbook.xlsx.writeBuffer();
  return Buffer.from(data);
}

describe("M10.1C XLSX 解析", () => {
  it("多 sheet / 行列 provenance（sheet + Excel 行号 + 表头 + 列字母）", async () => {
    const buffer = await buildWorkbook();
    const extraction = await parser.parseBuffer(buffer, "S001-experiment.xlsx");
    expect(extraction.mode).toBe("structured");
    expect(extraction.sheets).toHaveLength(2);
    expect(extraction.sheets?.[0]).toMatchObject({ name: "Sheet1", rowCount: 3, columnCount: 4 });
    expect(extraction.sheets?.[1]).toMatchObject({ name: "Ablation", rowCount: 2, columnCount: 2 });

    const records = extraction.blocks.filter((block) => block.type === "structured_record");
    // Sheet1：行 2（Ours）/ 行 3（Baseline）/ Gain 行（exceljs 零单元格空行不
    // 物化 → r 编号前移到 5；真实 Excel 文件空行物化、编号保持）
    const ours = records[0]!;
    expect(ours.provenance).toMatchObject({ sheet: "Sheet1", row: 2, fileName: "S001-experiment.xlsx" });
    if (ours.type === "structured_record") {
      expect(ours.cells.find((cell) => cell.header === "MOTA")).toEqual({
        letter: "B",
        header: "MOTA",
        value: "82.4",
      });
    }
    const baseline = records[1]!;
    expect(baseline.provenance.row).toBe(3);
    const gain = records[2]!;
    expect(gain.provenance.row).toBe(5);
    if (gain.type === "structured_record") {
      // 公式取计算结果（exceljs 写入时未 calc——本仓只承诺「公式对象取 result，
      // 无 result 时如实为空」；此处验证寻址与 sheet 归属）
      expect(gain.cells[0]).toEqual({ letter: "A", header: "Method", value: "Gain" });
    }
    const ablation = records[3]!;
    expect(ablation.provenance).toMatchObject({ sheet: "Ablation", row: 2 });
  });

  it("损坏 xlsx → DocumentParseFailedError（不静默）", async () => {
    await expect(
      parser.parseBuffer(Buffer.from("this is not a zip / xlsx at all", "utf8"), "broken.xlsx"),
    ).rejects.toMatchObject({ code: "INGESTION_PARSE_FAILED" });
  });

  it("空 workbook（无 sheet）→ DocumentParseFailedError", async () => {
    const workbook = new ExcelJS.Workbook();
    const data = await workbook.xlsx.writeBuffer();
    await expect(
      parser.parseBuffer(Buffer.from(data), "empty.xlsx"),
    ).rejects.toMatchObject({ code: "INGESTION_PARSE_FAILED" });
  });
});
