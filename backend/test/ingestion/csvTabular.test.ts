/**
 * M10.1C CSV 解析测试：表头 / 引号语义 / 分隔符嗅探 / 行号口径（Excel 一致）/
 * 空行与重复表头 / 上限截断 / 二进制误传与空文件报错。
 */

import { describe, expect, it } from "vitest";

import { CsvParser, columnLetter } from "../../src/ingestion/csvTabular.js";

const parser = new CsvParser();

describe("M10.1C CSV 解析", () => {
  it("表头 + 数据行 → structured_record（行号含表头 = 1，首条数据 = 2）", () => {
    const extraction = parser.parseBuffer(
      Buffer.from("Method,MOTA,IDF1\nOurs,82.4,79.1\nBaseline,78.2,75.0\n", "utf8"),
      "S001-experiment.csv",
    );
    expect(extraction.mode).toBe("structured");
    expect(extraction.blocks).toHaveLength(2);
    const first = extraction.blocks[0]!;
    expect(first.type).toBe("structured_record");
    expect(first.provenance.row).toBe(2);
    expect(first.provenance.fileName).toBe("S001-experiment.csv");
    if (first.type === "structured_record") {
      expect(first.cells).toEqual([
        { letter: "A", header: "Method", value: "Ours" },
        { letter: "B", header: "MOTA", value: "82.4" },
        { letter: "C", header: "IDF1", value: "79.1" },
      ]);
    }
    expect(extraction.sheets?.[0]).toMatchObject({
      rowCount: 2,
      columnCount: 3,
      headers: ["Method", "MOTA", "IDF1"],
    });
  });

  it("RFC4180：引号内分隔符 / 换行 / \"\" 转义属于字段；CRLF 兼容", () => {
    const csv = 'name,note\r\n"Smith, John","said ""ok"""\r\nmulti,"line\nbreak"\r\n';
    const extraction = parser.parseBuffer(Buffer.from(csv, "utf8"), "a.csv");
    expect(extraction.blocks).toHaveLength(2);
    const row2 = extraction.blocks[0]!;
    if (row2.type === "structured_record") {
      expect(row2.cells[0]).toEqual({ letter: "A", header: "name", value: "Smith, John" });
      expect(row2.cells[1]).toEqual({ letter: "B", header: "note", value: 'said "ok"' });
    }
    const row3 = extraction.blocks[1]!;
    if (row3.type === "structured_record") {
      expect(row3.cells[1]!.value).toBe("line\nbreak");
      expect(row3.provenance.row).toBe(3);
    }
  });

  it("分隔符嗅探：分号 / 制表符 CSV 按首行计数选择", () => {
    const semi = parser.parseBuffer(Buffer.from("a;b;c\n1;2;3\n", "utf8"), "a.csv");
    const tab = parser.parseBuffer(Buffer.from("a\tb\tc\n1\t2\t3\n", "utf8"), "a.csv");
    expect(semi.blocks[0]).toMatchObject({ type: "structured_record" });
    if (semi.blocks[0]!.type === "structured_record") {
      expect(semi.blocks[0]!.cells).toHaveLength(3);
      expect(semi.blocks[0]!.cells[0]!.value).toBe("1");
    }
    if (tab.blocks[0]!.type === "structured_record") {
      expect(tab.blocks[0]!.cells).toHaveLength(3);
    }
  });

  it("UTF-8 BOM 剥离；全空行跳过且不占记录", () => {
    const csv = "﻿h1,h2\n1,2\n,\n\n3,4\n";
    const extraction = parser.parseBuffer(Buffer.from(csv, "utf8"), "a.csv");
    expect(extraction.blocks).toHaveLength(2);
    expect(extraction.blocks[0]!.provenance.row).toBe(2);
    expect(extraction.blocks[1]!.provenance.row).toBe(5);
  });

  it("空表头降级 columnN；重复表头加序号后缀", () => {
    const extraction = parser.parseBuffer(Buffer.from("val,,val\n1,2,3\n", "utf8"), "a.csv");
    if (extraction.blocks[0]!.type === "structured_record") {
      expect(extraction.blocks[0]!.cells.map((cell) => cell.header)).toEqual(["val", "column2", "val_2"]);
    }
  });

  it("短行 / 长行（ragged）按表头宽度对齐，缺失格不产出 cell；超表头列用列字母兜底", () => {
    const extraction = parser.parseBuffer(Buffer.from("a,b,c\n1\n1,2,3,4\n", "utf8"), "a.csv");
    const row2 = extraction.blocks[0]!;
    const row3 = extraction.blocks[1]!;
    if (row2.type === "structured_record" && row3.type === "structured_record") {
      expect(row2.cells).toHaveLength(1);
      expect(row2.cells[0]).toEqual({ letter: "A", header: "a", value: "1" });
      expect(row3.cells).toHaveLength(4);
      expect(row3.cells[3]).toEqual({ letter: "D", header: "D", value: "4" });
    }
  });

  it("空文件 / NUL 二进制误传 → DocumentParseFailedError（不静默）", () => {
    expect(() => parser.parseBuffer(Buffer.from("", "utf8"), "a.csv")).toThrowError(/为空/);
    expect(() =>
      parser.parseBuffer(Buffer.concat([Buffer.from([0x00, 0x01, 0x02])]), "a.csv"),
    ).toThrowError(/NUL/);
  });

  it("列字母：0=A、25=Z、26=AA", () => {
    expect(columnLetter(0)).toBe("A");
    expect(columnLetter(25)).toBe("Z");
    expect(columnLetter(26)).toBe("AA");
    expect(columnLetter(27)).toBe("AB");
  });
});
