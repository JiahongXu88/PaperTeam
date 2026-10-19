/**
 * M14.9.3 P0-A：输入保真 / 盲化 / 可评分性联合门的合成回归（零模型；不含任何受版权保护的真实论文）。
 *
 * 失效注入：引言连删（「作者简介」触发的开放式删除）、题名前缀误判页眉删题注、公式乱码、勾选列移位、
 * 不相邻段落拼接、参考文献条目误删、他文混排泄漏、续页缺失；正常字段删除与正文中「某大学 / 基金」
 * 字样必须保留且不被判越界。
 */
import { describe, expect, it } from "vitest";

import { evaluateInputFidelity, type DeletionEntry, type SourceBlock, type SourceEvidence } from "../../src/review/inputFidelity.js";
import type { FidelityWord } from "../../src/review/inputFidelityTables.js";

const L = (y: number, h = 40): [number, number, number, number] => [50, y, 290, y + h];
const R = (y: number, h = 40): [number, number, number, number] => [305, y, 545, y + h];
const FULL = (y: number, h = 20): [number, number, number, number] => [50, y, 545, y + h];

const INTRO_1 = "近年来，城市道路监控视频的规模快速增长，人工巡检难以覆盖全部路段。本文关注低照度条件下的车辆检测问题，现有方法在夜间场景中的召回率明显下降，漏检会直接影响后续的轨迹关联与事件分析。";
const INTRO_2 = "针对上述问题，本文提出一种结合多尺度特征与时序一致性约束的检测框架，并在两个公开数据集上验证其有效性。与已有工作相比，该框架不依赖额外的红外传感器，部署成本较低，适合存量摄像头的升级改造。";
const METHOD_1 = "实验数据来自某大学交通研究中心公开发布的监控数据集，该数据集的建设得到国家自然科学基金支持，本文仅使用其公开的标注子集。训练时采用随机裁剪与亮度扰动两种增强方式，共训练一百二十个轮次。";
const METHOD_2 = "检测头输出的置信度经过温度缩放后与时序平滑项加权求和，权重在验证集上通过网格搜索确定，最终取值见表1。为保证公平比较，所有对照方法均使用相同的输入分辨率与训练轮次设置。";

function block(id: string, order: number, page: number, bbox: SourceBlock["bbox"], text: string, extra: Partial<SourceBlock> = {}): SourceBlock {
  return { id, order, page, bbox, text, zone: "body", role: "text", ...extra };
}

/** 消融表：表头 + 3 行，勾选列 A / B，数值列 mAP（文本层逐词坐标） */
function tableWords(): FidelityWord[] {
  const word = (text: string, x: number, y: number): FidelityWord => ({ text, x0: x, x1: x + 6 * text.length, y0: y, y1: y + 8 });
  return [
    word("Model", 60, 300), word("A", 140, 300), word("B", 200, 300), word("mAP", 260, 300),
    word("Base", 60, 312), word("41.2", 258, 312),
    word("M1", 60, 324), word("√", 140, 324), word("45.7", 258, 324),
    word("M2", 60, 336), word("√", 140, 336), word("√", 200, 336), word("48.3", 258, 336),
  ];
}

function source(overrides: Partial<SourceEvidence> = {}): SourceEvidence {
  const blocks: SourceBlock[] = [
    block("S01", 0, 1, [60, 40, 500, 50], "第30卷第9期 某某学报 2026年9月", { zone: "margin" }),
    block("S02", 1, 1, FULL(70), "低照度场景下的车辆检测方法研究"),
    block("S03", 2, 1, FULL(95), "张三1，李四2，王五1"),
    block("S04", 3, 1, FULL(110), "1.某大学计算机学院，某市 100000；2.某研究院，某市 200000"),
    block("S05", 4, 1, FULL(130, 50), "摘要：针对夜间监控视频中车辆漏检严重的问题，提出一种结合多尺度特征与时序一致性约束的检测方法，在两个公开数据集上召回率分别提升4.1和3.6个百分点。"),
    block("S06", 5, 1, FULL(185), "关键词：车辆检测；低照度；时序一致性"),
    block("S07", 6, 1, L(220, 70), INTRO_1),
    block("S08", 7, 1, L(300, 70), INTRO_2),
    block("S09", 8, 1, [50, 760, 545, 790], "作者简介：张三（1990—），男，博士，讲师，研究方向为计算机视觉。基金项目：某省自然科学基金（2024AB0001）。"),
    block("S10", 9, 1, R(220, 16), "1 方法", { role: "heading" }),
    block("S11", 10, 1, R(240, 70), METHOD_1),
    block("S12", 11, 1, R(320, 70), METHOD_2),
    block("S13", 12, 2, L(280, 12), "表1 消融实验结果", { role: "caption" }),
    block("S14", 13, 2, R(600, 30), "［1］ 赵六, 孙七. 夜间车辆检测综述[J]. 交通信息, 2023, 12(3): 1-9.", { role: "reference" }),
    block("S15", 14, 2, R(640, 30), "［2］ Wang Q, Liu M. Temporal consistency for detection[J]. Vision Letters, 2024, 7: 10-20.", { role: "reference" }),
  ];
  return {
    schema: "paperteam.input-fidelity.source/v1",
    sourceSha256: "0".repeat(64),
    extractor: { name: "synthetic", version: "1" },
    pageCount: 2,
    incompleteContinuations: [],
    readingOrderReliable: true,
    blocks,
    tables: [{ id: "T1", page: 2, bbox: [50, 295, 300, 350], words: tableWords() }],
    formulas: [{ id: "F1", page: 2, bbox: [60, 400, 290, 420], text: "Y1 = W1 X + b1 （1）", label: "（1）", scripts: [{ text: "1", kind: "sub" }, { text: "1", kind: "sub" }, { text: "1", kind: "sub" }], stackedLines: 1, pieceGlyphs: 0 }],
    figures: [],
    references: [{ number: 1, text: blocks[13]!.text }, { number: 2, text: blocks[14]!.text }],
    identityTerms: ["张三", "李四", "王五", "某某学报"],
    ...overrides,
  };
}

const TABLE_OK = [
  "**表1 消融实验结果**",
  "",
  "| Model | A | B | mAP |",
  "|---|---|---|---|",
  "| Base |  |  | 41.2 |",
  "| M1 | √ |  | 45.7 |",
  "| M2 | √ | √ | 48.3 |",
].join("\n");

function projection(parts: { intro?: string[]; method?: string[]; table?: string; formula?: string; refs?: string[]; extra?: string } = {}): string {
  return [
    "# 低照度场景下的车辆检测方法研究",
    "**摘要**：针对夜间监控视频中车辆漏检严重的问题，提出一种结合多尺度特征与时序一致性约束的检测方法，在两个公开数据集上召回率分别提升4.1和3.6个百分点。",
    "**关键词**：车辆检测；低照度；时序一致性",
    ...(parts.intro ?? [INTRO_1, INTRO_2]),
    "## 1 方法",
    ...(parts.method ?? [METHOD_1, METHOD_2]),
    parts.table ?? TABLE_OK,
    parts.formula ?? "$$ Y_{1} = W_{1} X + b_{1} （1） $$",
    ...(parts.extra !== undefined ? [parts.extra] : []),
    "## 参考文献",
    ...(parts.refs ?? ["［1］ 赵六, 孙七. 夜间车辆检测综述[J]. 交通信息, 2023, 12(3): 1-9.", "［2］ Wang Q, Liu M. Temporal consistency for detection[J]. Vision Letters, 2024, 7: 10-20."]),
  ].join("\n\n");
}

const METADATA_DELETIONS: DeletionEntry[] = [
  { kind: "running_header", page: 1, bbox: [60, 40, 500, 50], excerpt: "第30卷第9期 某某学报 2026年9月" },
  { kind: "author", page: 1, bbox: FULL(95), excerpt: "张三1，李四2，王五1" },
  { kind: "affiliation", page: 1, bbox: FULL(110), excerpt: "1.某大学计算机学院" },
  { kind: "author_bio", page: 1, bbox: [50, 760, 545, 790], excerpt: "作者简介：张三" },
];

const codes = (report: ReturnType<typeof evaluateInputFidelity>, severity?: string) =>
  report.findings.filter((finding) => severity === undefined || finding.severity === severity).map((finding) => finding.code);

describe("evaluateInputFidelity：正常字段删除", () => {
  it("只删除可证明的元数据；正文里的「某大学 / 国家自然科学基金」保留；公式上下标显式编码、表格逐格一致 → VALID_FOR_SCORING", () => {
    const report = evaluateInputFidelity(source(), { text: projection(), deletions: METADATA_DELETIONS });
    expect(codes(report, "hard")).toEqual([]);
    expect(codes(report, "soft")).toEqual([]);
    expect(report.status).toBe("VALID_FOR_SCORING");
    expect(report.legacyStatus).toBe("VALID");
    expect(report.metrics.deletions.authorized).toBe(4);
    expect(report.tables[0]!.status).toBe("VERIFIED");
    expect(report.formulas[0]!.status).toBe("VERIFIED");
  });
});

describe("evaluateInputFidelity：失效注入（每一类都必须被拦截）", () => {
  it("引言连删：首页作者简介触发「删到下一标题」，引言被记成 author_bio 删除 → INVALID_INPUT（数值齐全也不放行）", () => {
    const deletions = [...METADATA_DELETIONS,
      { kind: "author_bio", page: 1, bbox: L(220, 70), excerpt: INTRO_1.slice(0, 40) },
      { kind: "author_bio", page: 1, bbox: L(300, 70), excerpt: INTRO_2.slice(0, 40) }];
    const report = evaluateInputFidelity(source(), { text: projection({ intro: [] }), deletions });
    expect(report.status).toBe("INVALID_INPUT");
    expect(report.legacyStatus).toBe("INVALID_INPUT");
    expect(codes(report, "hard").filter((code) => code === "ILLEGITIMATE_DELETION")).toHaveLength(2);
    expect(report.metrics.deletions.illegitimate).toBe(2);
  });

  it("题名前缀误命中页眉：表题被当作 running_header 删除 → 题注不可删", () => {
    const deletions = [...METADATA_DELETIONS, { kind: "running_header", page: 2, bbox: L(280, 12), excerpt: "表1 消融实验结果" }];
    const report = evaluateInputFidelity(source(), { text: projection({ table: TABLE_OK.replace("**表1 消融实验结果**\n\n", "") }), deletions });
    expect(report.status).toBe("INVALID_INPUT");
    expect(report.findings.some((finding) => finding.code === "ILLEGITIMATE_DELETION" && finding.detail.includes("题注"))).toBe(true);
  });

  it("正文含「大学 / 基金」的方法段被当作基金信息删除 → 越界", () => {
    const deletions = [...METADATA_DELETIONS, { kind: "funding", page: 1, bbox: R(240, 70), excerpt: METHOD_1.slice(0, 40) }];
    const report = evaluateInputFidelity(source(), { text: projection({ method: [METHOD_2] }), deletions });
    expect(report.status).toBe("INVALID_INPUT");
    expect(report.findings.find((finding) => finding.code === "ILLEGITIMATE_DELETION")?.blockId).toBe("S11");
  });

  it("无删除记录的正文丢失 → BODY_TEXT_LOST", () => {
    const report = evaluateInputFidelity(source(), { text: projection({ method: [METHOD_1] }), deletions: METADATA_DELETIONS });
    expect(report.status).toBe("INVALID_INPUT");
    expect(codes(report, "hard")).toContain("BODY_TEXT_LOST");
  });

  it("勾选列移位：数值与勾选数都一样，只是 √ 落在错误的列 → TABLE_MISMATCH", () => {
    const shifted = TABLE_OK.replace("| M1 | √ |  | 45.7 |", "| M1 |  | √ | 45.7 |");
    const report = evaluateInputFidelity(source(), { text: projection({ table: shifted }), deletions: METADATA_DELETIONS });
    expect(report.status).toBe("INVALID_INPUT");
    expect(report.tables[0]!.codes).toContain("TABLE_CELL_POSITION_MISMATCH");
  });

  it("勾选合并（「√√」挤进一格）→ 行内容不一致", () => {
    const merged = TABLE_OK.replace("| M2 | √ | √ | 48.3 |", "| M2 | √√ |  | 48.3 |");
    const report = evaluateInputFidelity(source(), { text: projection({ table: merged }), deletions: METADATA_DELETIONS });
    expect(report.tables[0]!.status).toBe("MISMATCH");
  });

  it("公式乱码：文本层分段字形冒充结构且未标记 → FORMULA_GARBLED（硬失败）；标 FORMULA_UNVERIFIED 后降为人工 QA", () => {
    const garbled = evaluateInputFidelity(source(), { text: projection({ formula: "$$ ì í î Y1 = W1 X + b1 （1） $$" }), deletions: METADATA_DELETIONS });
    expect(garbled.status).toBe("INVALID_INPUT");
    expect(garbled.formulas[0]!.status).toBe("GARBLED");
    const marked = evaluateInputFidelity(source(), { text: projection({ formula: "$$ [FORMULA_UNVERIFIED：文本层无法证明结构] ì í î Y1 = W1 X + b1 （1） $$" }), deletions: METADATA_DELETIONS });
    expect(marked.status).toBe("REQUIRES_HUMAN_QA");
    expect(marked.fullPaperQuantitativeScoring).toBe(false);
    expect(marked.limitations.join("")).toContain("FORMULA_UNVERIFIED");
  });

  it("上下标被拍平（Y1 与 Y_1 不可区分）且未标记 → FORMULA_STRUCTURE_LOST", () => {
    const report = evaluateInputFidelity(source(), { text: projection({ formula: "$$ Y1 = W1 X + b1 （1） $$" }), deletions: METADATA_DELETIONS });
    expect(report.formulas[0]!.status).toBe("STRUCTURE_LOST");
    expect(report.status).toBe("INVALID_INPUT");
  });

  it("叠行公式（分式）即使上下标齐全也不能自动判 VERIFIED", () => {
    const stacked = source({ formulas: [{ id: "F1", page: 2, bbox: [60, 400, 290, 430], text: "P = TP （1） TP + FP", label: "（1）", scripts: [], stackedLines: 2, pieceGlyphs: 0 }] });
    const report = evaluateInputFidelity(stacked, { text: projection({ formula: "$$ P = TP / (TP + FP) （1） $$" }), deletions: METADATA_DELETIONS });
    expect(report.formulas[0]!.status).toBe("STRUCTURE_LOST");
  });

  it("不相邻段落拼接：双栏错序把方法段并进引言段 → PARAGRAPH_SPLICE + 顺序异常", () => {
    const spliced = projection({ intro: [`${INTRO_1}${METHOD_2}`, INTRO_2], method: [METHOD_1] });
    const report = evaluateInputFidelity(source(), { text: spliced, deletions: METADATA_DELETIONS });
    expect(codes(report)).toContain("PARAGRAPH_SPLICE");
    expect(codes(report)).toContain("READING_ORDER_ANOMALY");
    expect(report.status).toBe("INVALID_INPUT");
  });

  it("版面顺序不可靠时，同样的拼接只要求人工 QA（不臆断）", () => {
    const spliced = projection({ intro: [`${INTRO_1}${METHOD_2}`, INTRO_2], method: [METHOD_1] });
    const report = evaluateInputFidelity(source({ readingOrderReliable: false }), { text: spliced, deletions: METADATA_DELETIONS });
    expect(report.status).toBe("REQUIRES_HUMAN_QA");
  });

  it("参考文献行误删 → REFERENCE_LOST + 编号序列异常", () => {
    const report = evaluateInputFidelity(source(), { text: projection({ refs: ["［1］ 赵六, 孙七. 夜间车辆检测综述[J]. 交通信息, 2023, 12(3): 1-9."] }), deletions: METADATA_DELETIONS });
    expect(codes(report, "hard")).toEqual(expect.arrayContaining(["REFERENCE_LOST", "REFERENCE_SEQUENCE_ANOMALY"]));
  });

  it("同页他文混排内容回填进投影 → FOREIGN_CONTENT_LEAK", () => {
    const foreignText = "［5］ Zhou K, Chen L. A completely unrelated study of soil moisture sensing networks in arid regions[J]. Land Systems, 2022, 4: 33-48.";
    const withForeign = source({ blocks: [...source().blocks, block("S16", 15, 2, R(700, 30), foreignText, { zone: "foreign" })] });
    const report = evaluateInputFidelity(withForeign, { text: projection({ refs: [...["［1］ 赵六, 孙七. 夜间车辆检测综述[J]. 交通信息, 2023, 12(3): 1-9.", "［2］ Wang Q, Liu M. Temporal consistency for detection[J]. Vision Letters, 2024, 7: 10-20."], foreignText] }), deletions: METADATA_DELETIONS });
    expect(codes(report, "hard")).toContain("FOREIGN_CONTENT_LEAK");
  });

  it("续页不在 PDF 内 → SOURCE_INCOMPLETE（优先于其他状态）", () => {
    const report = evaluateInputFidelity(source({ incompleteContinuations: ["p2 下转第516页（PDF 不含该页）"] }), { text: projection(), deletions: METADATA_DELETIONS });
    expect(report.status).toBe("SOURCE_INCOMPLETE");
    expect(report.legacyStatus).toBe("INVALID_INPUT");
  });

  it("删除种类不在授权闭集 → 硬失败；身份词残留 → 人工 QA", () => {
    const unknownKind = evaluateInputFidelity(source(), { text: projection(), deletions: [...METADATA_DELETIONS, { kind: "anything_goes", page: 1, excerpt: "x" }] });
    expect(codes(unknownKind, "hard")).toContain("DELETION_KIND_UNAUTHORIZED");
    const residue = evaluateInputFidelity(source(), { text: projection({ extra: "致谢张三老师的指导。" }), deletions: METADATA_DELETIONS });
    expect(codes(residue, "soft")).toContain("BLINDING_RESIDUE");
  });
});
