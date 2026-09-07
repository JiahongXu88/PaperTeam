/**
 * referenceText：PDF 文本层污染的归一化 / 断词恢复 / 标题 canonical 与相似度。
 * 全部纯函数，无网络。不可见字符（U+00AD / U+00A0 / U+2010）一律用转义写出。
 */

import { describe, expect, it } from "vitest";

import {
  HYPHENATION_MARKER,
  canonicalTitle,
  compactTitle,
  hasHyphenationArtifact,
  normalizeReferenceText,
  repairLineBreakHyphenation,
  stripHyphenationMarkers,
  titleQueryVariants,
  titleSimilarity,
} from "../../src/citation/referenceText.js";

/** 软连字符标记（U+00AD） */
const SH = HYPHENATION_MARKER;

describe("referenceText：断词恢复", () => {
  it("行尾断词（单换行）：编码为软连字符标记 U+00AD（不猜原词）", () => {
    expect(HYPHENATION_MARKER).toBe("\u00AD");
    expect(repairLineBreakHyphenation("deep as-\nsociation metric")).toBe(`deep as${SH}sociation metric`);
    expect(repairLineBreakHyphenation("Rethink-\n  ing sort")).toBe(`Rethink${SH}ing sort`);
    expect(stripHyphenationMarkers(`Rethink${SH}ing`)).toBe("Rethinking");
  });

  it("pymupdf 跨列 block 边界（双换行 / 连字符后有空格）同样修复", () => {
    expect(repairLineBreakHyphenation("“Byte-\n\ntrack: Multi-object")).toBe(`“Byte${SH}track: Multi-object`);
    expect(repairLineBreakHyphenation("multi- \nobject")).toBe(`multi${SH}object`);
  });

  it("下一行大写开头不视为断词（新条目 / 专名）", () => {
    expect(repairLineBreakHyphenation("OC-\nSORT")).toBe("OC-\nSORT");
    expect(repairLineBreakHyphenation("pp. 1-\n[7] Next entry")).toBe("pp. 1-\n[7] Next entry");
  });

  it("normalizeReferenceText：来源软连字符移除 / NBSP / Unicode 连字符 / 空白折叠 / NFC", () => {
    const dirty = `Simple\u00A0online and real${SH}time tracking\twith a deep as-\nsociation met\u2010ric   `;
    expect(normalizeReferenceText(dirty)).toBe(`Simple online and realtime tracking with a deep as${SH}sociation met-ric`);
    expect(normalizeReferenceText("école")).toBe("école");
    expect(normalizeReferenceText("a\n\n\nb")).toBe("a\n\n\nb"); // 段落边界保留（切单元用）
  });

  it("合法复合词连字符不被破坏", () => {
    for (const text of ["multi-object tracking", "Observation-Centric SORT", "real-time", "OC-SORT", "state-of-the-art"]) {
      expect(normalizeReferenceText(text)).toBe(text);
    }
  });
});

describe("referenceText：query variants", () => {
  it("无污染标题只有一条 variant", () => {
    expect(titleQueryVariants("Simple online and realtime tracking")).toEqual(["Simple online and realtime tracking"]);
    expect(hasHyphenationArtifact("multi-object tracking")).toBe(false);
    expect(hasHyphenationArtifact(`Byte${SH}track`)).toBe(true);
    expect(hasHyphenationArtifact("Byte- track")).toBe(true);
  });

  it("软连字符标记（extractor 修复后的形态）生成 拼合 > 保留连字符 两条", () => {
    expect(titleQueryVariants(`Byte${SH}track: Multi-object tracking by associating every detection box`)).toEqual([
      "Bytetrack: Multi-object tracking by associating every detection box",
      "Byte-track: Multi-object tracking by associating every detection box",
    ]);
  });

  it("已拍平的断词（旧提取结果）生成 拼合 > 保留连字符 > 原文 三条", () => {
    expect(titleQueryVariants("Byte- track: Multi-object tracking by associating every detection box")).toEqual([
      "Bytetrack: Multi-object tracking by associating every detection box",
      "Byte-track: Multi-object tracking by associating every detection box",
      "Byte- track: Multi-object tracking by associating every detection box",
    ]);
    expect(titleQueryVariants("Simple online and realtime tracking with a deep as- sociation metric")[0]).toBe(
      "Simple online and realtime tracking with a deep association metric",
    );
    expect(titleQueryVariants("Observation-centric sort: Rethink- ing sort for robust multi-object tracking")[0]).toBe(
      "Observation-centric sort: Rethinking sort for robust multi-object tracking",
    );
  });

  it("空标题 → 空数组", () => {
    expect(titleQueryVariants("   ")).toEqual([]);
  });
});

describe("referenceText：标题 canonical / 相似度", () => {
  it("大小写 / 标点 / 连字符 / 空白差异不影响 compact 相等", () => {
    expect(compactTitle("Multi-Object Tracking")).toBe(compactTitle("Multi Object Tracking"));
    expect(compactTitle("Observation-Centric SORT")).toBe(compactTitle("observation centric sort"));
    expect(compactTitle("Byte- track: Multi-object tracking")).toBe(compactTitle("ByteTrack: Multi-Object Tracking"));
    expect(compactTitle("Rethink- ing SORT")).toBe(compactTitle("Rethinking SORT"));
    expect(compactTitle(`Rethink${SH}ing SORT`)).toBe(compactTitle("Rethinking SORT"));
    expect(canonicalTitle("The Attention Is All You Need!")).toBe("attention is all you need");
    expect(canonicalTitle("Über die Aufmerksamkeit")).toBe("über die aufmerksamkeit");
  });

  it("三篇真实论文的 PDF 污染标题与 canonical 标题相似度 = 1", () => {
    expect(
      titleSimilarity(
        "Byte- track: Multi-object tracking by associating every detection box",
        "ByteTrack: Multi-object Tracking by Associating Every Detection Box",
      ),
    ).toBe(1);
    expect(
      titleSimilarity(
        "Observation-centric sort: Rethink- ing sort for robust multi-object tracking",
        "Observation-Centric SORT: Rethinking SORT for Robust Multi-Object Tracking",
      ),
    ).toBe(1);
    expect(
      titleSimilarity(
        `Simple online and realtime tracking with a deep as${SH}sociation metric`,
        "Simple online and realtime tracking with a deep association metric",
      ),
    ).toBe(1);
  });

  it("不同论文不高相似（不 bag-of-words 化）", () => {
    // SORT vs Deep SORT：前缀包含，旧 titlesMatch 会误判相等
    expect(titleSimilarity("Simple online and realtime tracking", "Simple online and realtime tracking with a deep association metric")).toBeLessThan(0.8);
    expect(titleSimilarity("Attention Is All You Need", "Attention Is Almost All You Need Probably")).toBeLessThan(0.8);
    expect(titleSimilarity("ByteTrack: Multi-object tracking by associating every detection box", "ByteTrack for Single Object Segmentation")).toBeLessThan(0.7);
    expect(titleSimilarity("Observation-Centric SORT: Rethinking SORT for Robust Multi-Object Tracking", "BoT-SORT: Robust Associations Multi-Pedestrian Tracking")).toBeLessThan(0.7);
    // 同词不同序不相等
    expect(titleSimilarity("tracking every detection box", "box detection every tracking")).toBeLessThan(0.8);
  });

  it("单字符 OCR 级差异仍为 strong", () => {
    expect(titleSimilarity("Deep residual learning for image recognition", "Deep residual learning for image recognitlon")).toBeGreaterThan(0.95);
  });

  it("空输入相似度 0", () => {
    expect(titleSimilarity("", "x")).toBe(0);
    expect(titleSimilarity("!!!", "x")).toBe(0);
  });
});
