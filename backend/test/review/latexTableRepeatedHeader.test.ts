/**
 * M15.2.1 P0-B（N09）：体内重复表头块解析——分块数据表（复现表）的「分组行 + Source/Metric 局部表头」
 * 在首个数据行之后重复出现时，块后数据行必须继承该块的列头路径（此前一律沿用首个表头块 → 跨块单元格错位、
 * 竞争单元格对绑定不可见）。无法对齐 / 覆盖不全 → 记 IN_BODY_REPEATED_HEADER（下游不得依此表出证书）。
 * 夹具为本仓库自写的合成文本（不含任何版权原文）。
 */
import { describe, expect, it } from "vitest";
import { parseLatexTables } from "../../src/review/latexTable.js";

const FLOAT = (body: string): string => `\\begin{table}[t]\n\\caption{Reproduction comparison on two benchmarks.}\\label{tab:repro}\n${body}\n\\end{table}\n`;

const REPEATED = FLOAT([
  "\\begin{tabular}{c|cccc}",
  "\\hline",
  "& \\multicolumn{2}{c}{HetGNN} & \\multicolumn{2}{c}{NSHE} \\\\",
  "\\hline",
  "Source & \\multicolumn{2}{c}{ACM} & \\multicolumn{2}{c}{DBLP} \\\\",
  "\\hline",
  "Metric & MaF1 & MiF1 & MaF1 & MiF1 \\\\",
  "\\hline",
  "model* & 83.27 & 83.08 & 84.78 & 84.95 \\\\",
  "model & 83.19 & 83.00 & 84.71 & 84.88 \\\\",
  "\\hline",
  "& \\multicolumn{2}{c}{RpHGNN} & \\multicolumn{2}{c}{MHGCN} \\\\",
  "\\hline",
  "Source & \\multicolumn{2}{c}{ACM} & \\multicolumn{2}{c}{ACM} \\\\",
  "\\hline",
  "Metric & MaF1 & MiF1 & MaF1 & MiF1 \\\\",
  "\\hline",
  "model* & 92.20 & 92.10 & 91.11 & 90.22 \\\\",
  "\\hline",
  "\\end{tabular}",
].join("\n"));

/** 块 2 的分组行 / Source 行只覆盖前两列 → 数值列 3、4 无表头来源 → 不重建，记解析问题 */
const PARTIAL = FLOAT([
  "\\begin{tabular}{c|cccc}",
  "\\hline",
  "& \\multicolumn{2}{c}{HetGNN} & \\multicolumn{2}{c}{NSHE} \\\\",
  "\\hline",
  "Source & \\multicolumn{2}{c}{ACM} & \\multicolumn{2}{c}{DBLP} \\\\",
  "\\hline",
  "Metric & MaF1 & MiF1 & MaF1 & MiF1 \\\\",
  "\\hline",
  "model* & 83.27 & 83.08 & 84.78 & 84.95 \\\\",
  "\\hline",
  "& \\multicolumn{2}{c}{RpHGNN} & & \\\\",
  "\\hline",
  "Source & \\multicolumn{2}{c}{ACM} & & \\\\",
  "\\hline",
  "Metric & MaF1 & MiF1 & & \\\\",
  "\\hline",
  "model* & 92.20 & 92.10 & 91.11 & 90.22 \\\\",
  "\\hline",
  "\\end{tabular}",
].join("\n"));

const GROUPS = FLOAT([
  "\\begin{tabular}{lcc}",
  "Method & HOTA & IDF1 \\\\",
  "\\multicolumn{3}{c}{MOT17} \\\\",
  "Ours & 61.7 & 78.8 \\\\",
  "\\multicolumn{3}{c}{MOT20} \\\\",
  "Ours & 62.1 & 79.3 \\\\",
  "\\end{tabular}",
].join("\n"));

describe("M15.2.1 P0-B（N09）体内重复表头块", () => {
  it("重复块被识别：块内行为 header，块后数据行继承该块列头路径；无解析问题", () => {
    const [table] = parseLatexTables(REPEATED);
    expect(table).toBeDefined();
    expect(table!.parseIssues).toEqual([]);
    // 首块数据行沿用首个表头块
    const firstBlock = table!.cells.find((cell) => cell.row === 3 && cell.col === 3)!;
    expect(firstBlock.rowKey).toEqual(["model*"]);
    expect(firstBlock.headerPath).toEqual(["NSHE", "DBLP", "MaF1"]);
    // 块 2 的三行（分组行 / Source / Metric）是 header 行
    for (const r of [5, 6, 7]) expect(table!.rows[r]!.kind).toBe("header");
    // 块 2 数据行列头来自块 2（不再是首块的 NSHE/DBLP）
    const secondBlock = table!.cells.find((cell) => cell.row === 8 && cell.col === 1)!;
    expect(secondBlock.rowKey).toEqual(["model*"]);
    expect(secondBlock.headerPath).toEqual(["RpHGNN", "ACM", "MaF1"]);
    const secondBlock4 = table!.cells.find((cell) => cell.row === 8 && cell.col === 4)!;
    expect(secondBlock4.headerPath).toEqual(["MHGCN", "ACM", "MiF1"]);
  });

  it("重复块覆盖不了全部数值列：不重建（沿用首块路径），记 IN_BODY_REPEATED_HEADER", () => {
    const [table] = parseLatexTables(PARTIAL);
    expect(table).toBeDefined();
    expect(table!.parseIssues).toContain("IN_BODY_REPEATED_HEADER");
    // 块 2 数据行列头保持首个表头块（与旧行为一致），但表被标记 → 下游 TABLE_PARSE_ISSUES 拒绝出证
    const cell = table!.cells.find((entry) => entry.row === 7 && entry.col === 3)!;
    expect(cell.headerPath).toEqual(["NSHE", "DBLP", "MaF1"]);
  });

  it("普通整行单格分组行（非重复表头）不受影响：仍为 group，后续数据行继承 rowGroup", () => {
    const [table] = parseLatexTables(GROUPS);
    expect(table).toBeDefined();
    expect(table!.parseIssues).toEqual([]);
    expect(table!.rows[1]!.kind).toBe("group");
    const ours17 = table!.cells.find((cell) => cell.row === 2 && cell.col === 1)!;
    expect(ours17.rowGroup).toBe("MOT17");
    expect(ours17.headerPath).toEqual(["HOTA"]);
    const ours20 = table!.cells.find((cell) => cell.row === 4 && cell.col === 2)!;
    expect(ours20.rowGroup).toBe("MOT20");
  });
});
