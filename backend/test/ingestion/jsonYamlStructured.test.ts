/**
 * M10.1.1 JSON / YAML 结构化投影单测。
 * 覆盖：嵌套对象 / 数组稳定路径、空容器、malformed、深度触顶、值截断、
 * YAML 行号、复杂键括号记法。
 */

import { describe, expect, it } from "vitest";

import { DocumentParseFailedError } from "../../src/errors.js";
import { JsonParser } from "../../src/ingestion/jsonStructured.js";
import { YamlParser } from "../../src/ingestion/yamlStructured.js";
import type { ParsedRecordBlock } from "../../src/ingestion/types.js";

const JSON_PARSER = new JsonParser();
const YAML_PARSER = new YamlParser();

function jsonRecords(source: string): Map<string, { value: string; provenance: ParsedRecordBlock["provenance"] }> {
  const extraction = JSON_PARSER.parseBuffer(Buffer.from(source, "utf8"), "config.json");
  const map = new Map<string, { value: string; provenance: ParsedRecordBlock["provenance"] }>();
  for (const block of extraction.blocks as ParsedRecordBlock[]) {
    map.set(block.provenance.jsonPath!, { value: block.cells[0]!.value, provenance: block.provenance });
  }
  return map;
}

function yamlRecords(source: string): Map<string, { value: string; row?: number }> {
  const extraction = YAML_PARSER.parseBuffer(Buffer.from(source, "utf8"), "experiment.yaml");
  const map = new Map<string, { value: string; row?: number }>();
  for (const block of extraction.blocks as ParsedRecordBlock[]) {
    map.set(block.provenance.jsonPath!, {
      value: block.cells[0]!.value,
      ...(block.provenance.row !== undefined ? { row: block.provenance.row } : {}),
    });
  }
  return map;
}

describe("M10.1.1 JSON 结构化投影", () => {
  it("嵌套对象 → 叶子路径 structured_record（$.training.epochs = 100）", () => {
    const records = jsonRecords(
      JSON.stringify({ dataset: "MOT17", training: { epochs: 100, batch_size: 8 } }),
    );
    expect(records.size).toBe(3);
    expect(records.get("$")?.value).toBeUndefined(); // 根是 map：不产根记录
    expect(records.get("$.dataset")?.value).toBe("MOT17");
    expect(records.get("$.training.epochs")?.value).toBe("100");
    expect(records.get("$.training.batch_size")?.value).toBe("8");
    // JSON 无行号——不伪造
    expect(records.get("$.dataset")?.provenance.row).toBeUndefined();
    expect(records.get("$.dataset")?.provenance.fileName).toBe("config.json");
  });

  it("数组 → 稳定下标路径（$.metrics[0].mota）", () => {
    const records = jsonRecords(
      JSON.stringify({ metrics: [{ mota: 82.4, idf1: 79.1 }, { mota: 78.2, idf1: 75.0 }] }),
    );
    expect(records.get("$.metrics[0].mota")?.value).toBe("82.4");
    expect(records.get("$.metrics[1].mota")?.value).toBe("78.2");
  });

  it("标量类型文本化（null / boolean / number / string）；空容器标记", () => {
    const records = jsonRecords(
      JSON.stringify({ flag: true, ratio: null, name: "ours", emptyList: [], emptyMap: {} }),
    );
    expect(records.get("$.flag")?.value).toBe("true");
    expect(records.get("$.ratio")?.value).toBe("null");
    expect(records.get("$.name")?.value).toBe("ours");
    expect(records.get("$.emptyList")?.value).toBe("[]");
    expect(records.get("$.emptyMap")?.value).toBe("{}");
  });

  it("根标量 / 根数组 JSON 文件", () => {
    const scalar = JSON_PARSER.parseBuffer(Buffer.from('"just a string"', "utf8"), "root.json");
    expect((scalar.blocks[0] as ParsedRecordBlock).provenance.jsonPath).toBe("$");
    expect((scalar.blocks[0] as ParsedRecordBlock).cells[0]!.value).toBe("just a string");
    const array = jsonRecords(JSON.stringify([1, 2, 3]));
    expect(array.get("$[0]")?.value).toBe("1");
    expect(array.get("$[2]")?.value).toBe("3");
  });

  it("特殊键名 → 括号记法路径", () => {
    const records = jsonRecords(JSON.stringify({ "my key": 1, normal_key: 2 }));
    expect(records.get('$["my key"]')?.value).toBe("1");
    expect(records.get("$.normal_key")?.value).toBe("2");
  });

  it("malformed JSON → DocumentParseFailedError（不静默）", () => {
    expect(() => JSON_PARSER.parseBuffer(Buffer.from("{ not json", "utf8"), "bad.json")).toThrow(
      DocumentParseFailedError,
    );
    expect(() => JSON_PARSER.parseBuffer(Buffer.from("", "utf8"), "empty.json")).toThrow(/内容为空/);
    expect(() => JSON_PARSER.parseBuffer(Buffer.from("}{", "utf8"), "bad.json")).toThrow(
      /JSON 解析失败/,
    );
  });

  it("深度触顶 → 子树按紧凑 JSON 叶子渲染 + partial + truncated 标记", () => {
    // 构造 20 层嵌套
    let deep: unknown = { leaf: "bottom" };
    for (let i = 0; i < 20; i += 1) {
      deep = { [`level${i}`]: deep };
    }
    const extraction = JSON_PARSER.parseBuffer(Buffer.from(JSON.stringify(deep), "utf8"), "deep.json");
    expect(extraction.quality).toBe("partial");
    expect(extraction.notes.some((note) => note.includes("深度"))).toBe(true);
    const deepBlock = extraction.blocks.find(
      (block) => (block as ParsedRecordBlock).truncated === true,
    );
    expect(deepBlock).toBeDefined();
  });

  it("超长字符串值 → 截断 + truncated 标记", () => {
    const extraction = JSON_PARSER.parseBuffer(
      Buffer.from(JSON.stringify({ big: "y".repeat(5000) }), "utf8"),
      "big.json",
    );
    const record = (extraction.blocks[0] as ParsedRecordBlock)!;
    expect(record.cells[0]!.value.length).toBe(2000);
    expect(record.truncated).toBe(true);
    expect(extraction.quality).toBe("partial");
  });
});

describe("M10.1.1 YAML 结构化投影", () => {
  it("mapping / list / scalar → 路径投影（与 JSON 同型）+ 行号保留", () => {
    const source = [
      "dataset: MOT17",
      "training:",
      "  epochs: 100",
      "  batch_size: 8",
      "metrics:",
      "  - mota: 82.4",
      "    idf1: 79.1",
      "",
    ].join("\n");
    const records = yamlRecords(source);
    expect(records.get("$.dataset")?.value).toBe("MOT17");
    expect(records.get("$.training.epochs")?.value).toBe("100");
    expect(records.get("$.training.batch_size")?.value).toBe("8");
    expect(records.get("$.metrics[0].mota")?.value).toBe("82.4");
    expect(records.get("$.metrics[0].idf1")?.value).toBe("79.1");
    // 行号（1-based 文件行）
    expect(records.get("$.dataset")?.row).toBe(1);
    expect(records.get("$.training.epochs")?.row).toBe(3);
    expect(records.get("$.metrics[0].mota")?.row).toBe(6);
  });

  it("标量列表 + 嵌套 list of list", () => {
    const records = yamlRecords("tags:\n  - tracking\n  - mot17\ngrid:\n  - [1, 2]\n  - [3, 4]\n");
    expect(records.get("$.tags[0]")?.value).toBe("tracking");
    expect(records.get("$.grid[0][1]")?.value).toBe("2");
  });

  it("boolean / null 标量文本化", () => {
    const records = yamlRecords("debug: true\nname: ~\n");
    expect(records.get("$.debug")?.value).toBe("true");
    expect(records.get("$.name")?.value).toBe("null");
  });

  it("malformed YAML → DocumentParseFailedError（带行号）", () => {
    expect(() =>
      YAML_PARSER.parseBuffer(Buffer.from("a: [unclosed\nb: }bad", "utf8"), "bad.yaml"),
    ).toThrow(DocumentParseFailedError);
    expect(() => YAML_PARSER.parseBuffer(Buffer.from("a: [unclosed", "utf8"), "bad.yaml")).toThrow(
      /YAML 解析失败/,
    );
  });

  it("空文件 / 仅注释 → 明确失败", () => {
    expect(() => YAML_PARSER.parseBuffer(Buffer.from("", "utf8"), "empty.yaml")).toThrow(/内容为空/);
    expect(() =>
      YAML_PARSER.parseBuffer(Buffer.from("# only comments\n", "utf8"), "comments.yaml"),
    ).toThrow(/无内容/);
  });
});
