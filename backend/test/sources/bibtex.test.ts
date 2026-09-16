/**
 * BibTeX 最小解析器测试（M6.2）：
 * 花括号平衡值 / 引号值 / 裸值、@string/@comment 跳过、
 * 损坏条目按行收集错误、entry → metadata 映射。
 */

import { describe, expect, it } from "vitest";

import { mapBibEntry, parseBibTeX } from "../../src/sources/bibtex.js";

describe("parseBibTeX", () => {
  it("常规条目：花括号值（含嵌套）、引号值、多空格", () => {
    const content = [
      "@article{key2024,",
      "  title = {A {Nested {Deep}} Title},",
      '  author = "Doe, Jane and Smith, John",',
      "  year   =   {2024},",
      "  doi = 10.1234/bare,",
      "}",
    ].join("\n");
    const { entries, errors } = parseBibTeX(content);
    expect(errors).toEqual([]);
    expect(entries).toHaveLength(1);
    expect(entries[0]!.key).toBe("key2024");
    expect(entries[0]!.type).toBe("article");
    expect(entries[0]!.fields["title"]).toBe("A {Nested {Deep}} Title");
    expect(entries[0]!.fields["author"]).toBe("Doe, Jane and Smith, John");
    expect(entries[0]!.fields["year"]).toBe("2024");
    expect(entries[0]!.fields["doi"]).toBe("10.1234/bare");
  });

  it("@comment / @string / @preamble 跳过；正文中的孤立 @ 不致命", () => {
    const content = [
      "联系作者 mailto:a@b.com 不应中断解析",
      "@comment{this is ignored @article{fake, title={x}}}",
      "@string{venue = {Some Journal}}",
      "@preamble{\"\\ding{110}\"}",
      "@misc{real, title = {Real Entry}}",
    ].join("\n");
    const { entries, errors } = parseBibTeX(content);
    expect(errors).toEqual([]);
    expect(entries.map((e) => e.key)).toEqual(["real"]);
  });

  it("多个条目；圆括号条目形态", () => {
    const { entries } = parseBibTeX(
      "@inproceedings(a1, title={One})\n@article{b2, title={Two}}",
    );
    expect(entries.map((e) => e.key)).toEqual(["a1", "b2"]);
    expect(entries[0]!.type).toBe("inproceedings");
  });

  it("损坏条目：未闭合花括号报错并记录行号；其后的条目因边界不可恢复而不再解析", () => {
    const { entries, errors } = parseBibTeX(
      "@article{good, title={Fine}}\n@article{broken, title={Never closed\n@article{also-good, title={Ok}}",
    );
    // 诚实语义：未闭合条目吞掉其后内容（无可靠边界可恢复），报错而不是猜测切分
    expect(entries.map((e) => e.key)).toEqual(["good"]);
    expect(errors.length).toBe(1);
    expect(errors[0]!.line).toBe(2);
    // 损坏条目之前的完好条目正常保留
    const recovered = parseBibTeX("@article{first, title={A}}\n@article{ok-too, title={B}}");
    expect(recovered.entries.map((e) => e.key)).toEqual(["first", "ok-too"]);
  });

  it("空内容 / 无条目 → 空结果", () => {
    expect(parseBibTeX("")).toEqual({ entries: [], errors: [] });
    expect(parseBibTeX("no entries here").entries).toEqual([]);
  });
});

describe("mapBibEntry", () => {
  it("字段映射：author 按 and 分割、venue 优先 journal、arXiv URL 提取", () => {
    const { metadata, versionType } = mapBibEntry({
      key: "k",
      type: "inproceedings",
      fields: {
        title: "{Capitalized} Method",
        author: "Alice Smith and Bob Jones and Carol Wu",
        year: "2023",
        journal: "Journal V",
        booktitle: "Conference V",
        url: "https://arxiv.org/abs/2301.00001v2",
      },
    });
    expect(metadata.title).toBe("Capitalized Method"); // 大小写保护花括号去壳
    expect(metadata.authors).toEqual(["Alice Smith", "Bob Jones", "Carol Wu"]);
    expect(metadata.year).toBe(2023);
    expect(metadata.venue).toBe("Journal V"); // journal 优先
    expect(metadata.arxivId).toBe("2301.00001");
    expect(metadata.url).toBe("https://arxiv.org/abs/2301.00001v2");
    expect(versionType).toBe("conference");
  });

  it("entry 类型 → versionType 映射；非法 year 忽略", () => {
    expect(mapBibEntry({ key: "a", type: "article", fields: { year: "2020" } }).versionType).toBe("journal");
    expect(mapBibEntry({ key: "b", type: "phdthesis", fields: {} }).versionType).toBe("other");
    expect(mapBibEntry({ key: "c", type: "article", fields: { year: "not-a-year" } }).metadata.year).toBeUndefined();
  });
});
