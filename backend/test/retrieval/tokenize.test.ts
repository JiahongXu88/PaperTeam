/**
 * M6.4 tokenizer 测试：中英兼容 lexical tokenization（D-0036）。
 */

import { describe, expect, it } from "vitest";

import { tokenizeText } from "../../src/retrieval/tokenize.js";

describe("M6.4 tokenize（中英兼容）", () => {
  it("英文词：小写化 + 词边界", () => {
    expect(tokenizeText("ByteTrack achieves MOTA gains")).toEqual([
      "bytetrack",
      "achieves",
      "mota",
      "gains",
    ]);
  });

  it("学术标识符：连字符整体 + 部分双索引", () => {
    expect(tokenizeText("MRG-DTM")).toEqual(["mrg-dtm", "mrg", "dtm"]);
    expect(tokenizeText("YOLOv11-L")).toEqual(["yolov11-l", "yolov11"]);
    expect(tokenizeText("L1 YOLOv11-L")).toEqual(["l1", "yolov11-l", "yolov11"]);
  });

  it("数字形态：小数点两侧各自成 token（查询/文档对称，精确匹配成立）", () => {
    expect(tokenizeText("version 2.3 improves AP by 1.8 points")).toEqual([
      "version",
      "2",
      "3",
      "improves",
      "ap",
      "by",
      "1",
      "8",
      "points",
    ]);
    // 对称性：同串查询与文档 token 化一致 → 精确匹配可达
    expect(tokenizeText("2.3")).toEqual(tokenizeText("2.3"));
  });

  it("中文：连续段 bigram + 尾单字", () => {
    expect(tokenizeText("多目标跟踪")).toEqual(["多目", "目标", "标跟", "跟踪", "踪"]);
  });

  it("中文 bigram 基本形态（显式断言）", () => {
    // "数据关联" → bigrams 数据/据关/关联 + 尾单字 "联"
    expect(tokenizeText("数据关联")).toEqual(["数据", "据关", "关联", "联"]);
    // 单字落单 → 单字 token
    expect(tokenizeText("图")).toEqual(["图"]);
  });

  it("中文标点是分隔符（不进 token；分段各自 bigram）", () => {
    expect(tokenizeText("方法，实验。结论")).toEqual(["方法", "法", "实验", "验", "结论", "论"]);
  });

  it("中英混合", () => {
    const tokens = tokenizeText("使用 ByteTrack 在 MOT17 上评估 数据关联");
    expect(tokens).toContain("bytetrack");
    expect(tokens).toContain("mot17");
    expect(tokens).toContain("数据");
    expect(tokens).toContain("据关");
    expect(tokens).toContain("关联");
  });

  it("查询子串召回：查询词是文档词的子串前缀（bigram 命中）", () => {
    const document = tokenizeText("数据关联方法");
    const query = tokenizeText("数据关联");
    // 查询的每个 bigram 都应出现在文档 token 中
    for (const token of query) {
      if (token.length === 2) {
        expect(document).toContain(token);
      }
    }
  });

  it("确定性：同文本恒同结果", () => {
    const text = "Transformer 注意力机制 attention mechanism 2024";
    expect(tokenizeText(text)).toEqual(tokenizeText(text));
  });

  it("空文本 / 纯空白 / 纯标点 → 空 token 流", () => {
    expect(tokenizeText("")).toEqual([]);
    expect(tokenizeText("   \n\t ")).toEqual([]);
    expect(tokenizeText("！！！……——")).toEqual([]);
  });
});
