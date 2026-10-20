/**
 * M14.9.5 P0：转写伪影检测 + 哈希绑定的人工 QA 证明（零模型；合成文本，不含任何真实论文内容）。
 *
 * 形态来源：M14.9.4 两篇已人工逐页核对的真实投影（私用区统计符号、栏目标签插进英文摘要成伪章节、表格隔断句子、
 * 行末断词、参考文献英文译文单独成段、本刊引用行残留）。检测只报告、从不改写投影；研究数值（含原作者笔误）原样保留。
 */
import { describe, expect, it } from "vitest";

import { detectConversionArtifacts } from "../../src/review/inputFidelityArtifacts.js";
import { evaluateInputFidelity, type SourceBlock, type SourceEvidence } from "../../src/review/inputFidelity.js";
import { attestationTemplate, checkInputQaAttestation, fidelityFindingKey, INPUT_QA_ATTESTATION_SCHEMA, type InputQaAttestation } from "../../src/review/inputFidelityAttestation.js";

const FULL = (y: number, h = 40): [number, number, number, number] => [50, y, 545, y + h];
const ABSTRACT_EN_1 = "Objective To describe the prevalence of two chronic conditions among older residents. Results Group A had";
const ABSTRACT_EN_2 = "the highest prevalence among the four groups, and the difference was significant.";
const BODY_1 = "本研究采用分层整群抽样方法，在两个县共调查一千二百名六十岁及以上居民，问卷由经过统一培训的调查员面对面完成，所有调查对象均签署知情同意书。";
const BODY_2 = "统计分析采用卡方检验比较各组患病率差异，以双侧检验水准零点零五判断差异是否具有统计学意义，所有分析均在统计软件中完成并由两人独立核对。";

function block(id: string, order: number, bbox: SourceBlock["bbox"], text: string, extra: Partial<SourceBlock> = {}): SourceBlock {
  return { id, order, page: 1, bbox, text, zone: "body", role: "text", ...extra };
}

function source(): SourceEvidence {
  const blocks = [
    block("S01", 0, [400, 40, 545, 60], "·专题·", { zone: "margin" }),
    block("S02", 1, FULL(70), "两种慢性病的患病现状调查"),
    block("S03", 2, FULL(120), ABSTRACT_EN_1),
    block("S04", 3, FULL(170), ABSTRACT_EN_2),
    block("S05", 4, FULL(220, 16), "1 对象与方法", { role: "heading" }),
    block("S06", 5, FULL(240, 60), BODY_1),
    block("S07", 6, FULL(310, 60), BODY_2),
    block("S08", 7, FULL(600, 30), "［1］ 赵六, 孙七. 慢性病调查方法[J]. 调查研究, 2023, 12(3): 1-9.", { role: "reference" }),
  ];
  return {
    schema: "paperteam.input-fidelity.source/v1", sourceSha256: "a".repeat(64), extractor: { name: "synthetic", version: "1" }, pageCount: 1,
    incompleteContinuations: [], readingOrderReliable: true, blocks, tables: [], formulas: [], figures: [],
    references: [{ number: 1, text: blocks[7]!.text }], identityTerms: [],
  };
}

function projection(parts: { abstract?: string[]; body?: string[]; refs?: string[]; extra?: string } = {}): string {
  return [
    "# 两种慢性病的患病现状调查",
    ...(parts.abstract ?? [`${ABSTRACT_EN_1} ${ABSTRACT_EN_2}`]),
    "## 1 对象与方法",
    ...(parts.body ?? [BODY_1, BODY_2]),
    ...(parts.extra !== undefined ? [parts.extra] : []),
    "## 参考文献",
    ...(parts.refs ?? ["［1］ 赵六, 孙七. 慢性病调查方法[J]. 调查研究, 2023, 12(3): 1-9."]),
  ].join("\n\n");
}

const deletions = [{ kind: "page_furniture", page: 1, bbox: [400, 40, 545, 60] as [number, number, number, number], excerpt: "·专题·" }];
const codes = (text: string) => detectConversionArtifacts(text, source()).map((finding) => `${finding.code}:${finding.severity}`);

describe("detectConversionArtifacts：正常投影零误报", () => {
  it("合法删除版边 + 完整句子 + 编号参考文献 → 无转写伪影，联合门 VALID_FOR_SCORING", () => {
    expect(codes(projection())).toEqual([]);
    expect(evaluateInputFidelity(source(), { text: projection(), deletions }).status).toBe("VALID_FOR_SCORING");
  });
});

describe("detectConversionArtifacts：失效注入", () => {
  it("栏目标签插入英文摘要句中并成为标题 → FURNITURE_HEADING_SPLICE（硬失败，INVALID_INPUT）", () => {
    const text = projection({ abstract: [ABSTRACT_EN_1, "## ·专题·", ABSTRACT_EN_2] });
    expect(codes(text)).toContain("FURNITURE_HEADING_SPLICE:hard");
    expect(evaluateInputFidelity(source(), { text, deletions: [] }).status).toBe("INVALID_INPUT");
  });

  it("同一标签作为独立标题但不切断句子 → 只要求人工 QA", () => {
    const text = projection({ abstract: [`${ABSTRACT_EN_1} ${ABSTRACT_EN_2}`, "## ·专题·"] });
    expect(codes(text)).toEqual(["FURNITURE_AS_HEADING:soft"]);
  });

  it("私用区统计符号 → PRIVATE_USE_GLYPH（不猜测其含义，投影原样不改）", () => {
    const glyph = String.fromCodePoint(0x100c7d);
    const body = BODY_2.replace("卡方检验", `${glyph}2检验`);
    const text = projection({ body: [BODY_1, body] });
    expect(codes(text)).toEqual(["PRIVATE_USE_GLYPH:soft"]);
    expect(text).toContain(glyph);
    expect(evaluateInputFidelity(source(), { text, deletions }).status).toBe("REQUIRES_HUMAN_QA");
  });

  it("表格插入句中把一句拆成两段 → SENTENCE_SPLIT_BY_BLOCK", () => {
    const table = "| 组别 | 例数 |\n|---|---|\n| A | 600 |";
    const text = projection({ body: [BODY_1.slice(0, 30), table, BODY_1.slice(30), BODY_2] });
    expect(codes(text)).toContain("SENTENCE_SPLIT_BY_BLOCK:soft");
  });

  it("标题文字被重复粘在上一段末尾 → HEADING_TEXT_DUPLICATED", () => {
    const text = projection({ abstract: [`${ABSTRACT_EN_1} ${ABSTRACT_EN_2} 1 对象与方法`] });
    expect(codes(text)).toContain("HEADING_TEXT_DUPLICATED:soft");
  });

  it("行末断词连字符：正文 soft，参考文献只记 info；「pre- and post-」类不计", () => {
    expect(codes(projection({ abstract: [`${ABSTRACT_EN_1} the high‐ est ${ABSTRACT_EN_2}`] }))).toContain("LINE_BREAK_HYPHEN_RESIDUE:soft");
    expect(codes(projection({ abstract: [`${ABSTRACT_EN_1} pre- and post-test ${ABSTRACT_EN_2}`] }))).toEqual([]);
    expect(codes(projection({ refs: ["［1］ Zhao L. Survey meth‐ ods[J]. Survey Studies, 2023, 12(3): 1-9."] }))).toEqual(["LINE_BREAK_HYPHEN_RESIDUE:info"]);
  });

  it("参考文献英文译文 / 跨栏续文单独成段 → REFERENCE_FRAGMENT", () => {
    const refs = ["［1］ 赵六, 孙七. 慢性病调查方法[J]. 调查研究, 2023, 12(3): 1-9.", "ZHAO L, SUN Q. Survey methods for chronic diseases[J]. Survey Studies, 2023, 12(3): 1-9."];
    expect(codes(projection({ refs }))).toEqual(["REFERENCE_FRAGMENT:soft"]);
  });

  it("关键词后残留期刊引用行 → BLINDING_RESIDUE（刊名可推断期刊级别）", () => {
    const text = projection({ extra: "【Keywords】 chronic disease; survey （Chin J Surv Stud 2026，30（9）：101‐107）" });
    expect(codes(text)).toContain("BLINDING_RESIDUE:soft");
  });

  it("原作者数值笔误（百分比与例数不符）不是转写伪影：不报告、不改写", () => {
    const typo = BODY_1.replace("一千二百名", "1 200 名（其中男性 600 名，占 60.0%）");
    const text = projection({ body: [typo, BODY_2] });
    expect(codes(text)).toEqual([]);
    expect(text).toContain("600 名，占 60.0%");
  });
});

describe("哈希绑定的人工 QA 证明", () => {
  const glyph = String.fromCodePoint(0x100c7d);
  const qaText = projection({ body: [BODY_1, BODY_2.replace("卡方检验", `${glyph}2检验`)] });
  const report = evaluateInputFidelity(source(), { text: qaText, deletions });
  const manuscriptSha256 = "b".repeat(64);
  const filled = (overrides: Partial<InputQaAttestation> = {}): InputQaAttestation => {
    const template = attestationTemplate(report, manuscriptSha256);
    return {
      ...template, attestedBy: "qa-reviewer@example", attestedAt: "2026-10-20T08:00:00.000Z",
      items: template.items.map((item) => ({ findingKey: item.findingKey, code: item.code, page: 1, region: [50, 310, 545, 370] as [number, number, number, number], result: "MATCHES_SOURCE" as const })),
      ...overrides,
    };
  };

  it("前提：保真门对私用区字形只给 REQUIRES_HUMAN_QA", () => {
    expect(report.status).toBe("REQUIRES_HUMAN_QA");
    expect(report.findings.filter((finding) => finding.severity === "soft").map((finding) => finding.code)).toEqual(["PRIVATE_USE_GLYPH"]);
  });

  it("逐条覆盖全部疑点、带原文定位、哈希一致 → VALID，有效状态 VALID_FOR_SCORING", () => {
    const check = checkInputQaAttestation(report, filled(), { manuscriptSha256, requireManuscriptBinding: true });
    expect(check).toMatchObject({ verdict: "VALID", effectiveStatus: "VALID_FOR_SCORING", requiredFindings: 1, coveredFindings: 1 });
  });

  it("模板本身（结论留空、无核对人）不构成证明", () => {
    expect(checkInputQaAttestation(report, attestationTemplate(report, manuscriptSha256)).verdict).toBe("REJECTED");
    expect(checkInputQaAttestation(report, true).verdict).toBe("REJECTED");
  });

  it("投影文本或源证据变化 → 证明失效（INVALIDATED），有效状态回到自动判定", () => {
    const changed = evaluateInputFidelity(source(), { text: `${qaText}\n\n补充一句。`, deletions });
    expect(checkInputQaAttestation(changed, filled())).toMatchObject({ verdict: "INVALIDATED", effectiveStatus: changed.status });
    expect(checkInputQaAttestation({ ...report, sourceSha256: "c".repeat(64) }, filled()).verdict).toBe("INVALIDATED");
    expect(checkInputQaAttestation(report, filled(), { manuscriptSha256: "d".repeat(64) }).verdict).toBe("INVALIDATED");
  });

  it("漏核一条 / 缺原文定位 → INCOMPLETE；未绑定被审稿件 → INCOMPLETE", () => {
    expect(checkInputQaAttestation(report, filled({ items: [] })).verdict).toBe("INCOMPLETE");
    const unlocated = filled();
    unlocated.items = unlocated.items.map((item) => ({ findingKey: item.findingKey, code: item.code, page: 1, result: item.result }));
    expect(checkInputQaAttestation(report, unlocated)).toMatchObject({ verdict: "INCOMPLETE", effectiveStatus: "REQUIRES_HUMAN_QA" });
    const { manuscriptSha256: _drop, ...unbound } = filled();
    expect(checkInputQaAttestation(report, unbound, { requireManuscriptBinding: true }).verdict).toBe("INCOMPLETE");
  });

  it("人工核对发现与原文不一致 → MISMATCH_FOUND，有效状态 INVALID_INPUT", () => {
    const mismatch = filled();
    mismatch.items[0] = { ...mismatch.items[0]!, result: "MISMATCH", note: "原文为 χ²" };
    expect(checkInputQaAttestation(report, mismatch)).toMatchObject({ verdict: "MISMATCH_FOUND", effectiveStatus: "INVALID_INPUT" });
  });

  it("证明永远不能覆盖硬缺陷（INVALID_INPUT / SOURCE_INCOMPLETE）", () => {
    const invalid = evaluateInputFidelity(source(), { text: projection({ abstract: [ABSTRACT_EN_1, "## ·专题·", ABSTRACT_EN_2] }), deletions: [] });
    expect(invalid.status).toBe("INVALID_INPUT");
    const template = attestationTemplate(invalid);
    const attestation = { ...template, attestedBy: "qa", attestedAt: "2026-10-20T08:00:00.000Z", items: invalid.findings.map((finding) => ({ findingKey: fidelityFindingKey(finding), code: finding.code, page: 1, region: [0, 0, 1, 1], result: "MATCHES_SOURCE" })) };
    expect(checkInputQaAttestation(invalid, attestation)).toMatchObject({ verdict: "REJECTED", effectiveStatus: "INVALID_INPUT" });
    expect(attestation.schema).toBe(INPUT_QA_ATTESTATION_SCHEMA);
  });
});
