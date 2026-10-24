/**
 * M15.4.3（P0-B）括号绝对值语境归属的合成正反例（claimCertificate.atomQualifiers 生产行为变更）：
 * 数值位于括号组内且组头词为普通名词 → 同位语绝对值（不继承 DERIVED）；
 * 派生名词 / 触发词族 / 介词 / 单位 / 数字组头 → 维持继承；后缀形派生由 DERIVED_AFTER 直接判定兜底；
 * 无括号直接派生措辞与 from/to 端点语义不动。
 * 夹具为合成句（不含任何版权原文）；atomQualifiers 经 locateAtom 真实定位路径驱动。
 */
import { describe, expect, it } from "vitest";
import { buildCertificateDocument, locateAtom, type CertificateDocument } from "../../src/review/claimCertificate.js";
import { locateQuote } from "../../src/review/claimAuditText.js";

const BASE = "\\section{Results}\n";

function qualifiersOf(document: CertificateDocument, sentence: string, value: string): string[] {
  const content = document.files[0]!.content;
  const span = locateQuote(content, sentence);
  if (span === null) throw new Error(`sentence not found: ${sentence}`);
  const located = locateAtom(document, "main.tex", span.start, span.end, value);
  if (located.atom === null) throw new Error(`atom not located (${value}): ${located.reason}`);
  return located.atom.qualifiers;
}

function docWith(sentence: string): CertificateDocument {
  return buildCertificateDocument([{ file: "main.tex", content: `${BASE}${sentence}\n` }]);
}

describe("M15.4.3 P0-B 括号绝对值语境归属（atomQualifiers）", () => {
  it("B-1 比较语境 + 括号同位语绝对值（G2-C02 形态）：higher … channel (68.9%) → 不继承 DERIVED", () => {
    const sentence = "This resulted in a much higher percentage of SWI connect components being detected when using the agnostic channel (68.9\\%) compared to our original setup.";
    expect(qualifiersOf(docWith(sentence), sentence, "68.9")).not.toContain("DERIVED");
  });

  it("B-2 lower accuracy (68.9%)：比较词不改变括号同位语绝对值的原子性", () => {
    const sentence = "The pruned model yields lower accuracy (68.9\\%) than the baseline on the same split.";
    expect(qualifiersOf(docWith(sentence), sentence, "68.9")).not.toContain("DERIVED");
  });

  it("B-3 多括号数：(68.9% vs 72.1%) 两数均为同位语绝对值", () => {
    const sentence = "The agnostic channel detects a higher share (68.9\\% vs 72.1\\% for the extra channel) in the same budget.";
    expect(qualifiersOf(docWith(sentence), sentence, "68.9")).not.toContain("DERIVED");
    expect(qualifiersOf(docWith(sentence), sentence, "72.1")).not.toContain("DERIVED");
  });

  it("B-4 负例：派生名词组头 an improvement (3.2%) → 维持 DERIVED", () => {
    const sentence = "The fusion module brings an improvement (3.2\\%) on the main benchmark over the prior release.";
    expect(qualifiersOf(docWith(sentence), sentence, "3.2")).toContain("DERIVED");
  });

  it("B-5 负例：by 组头 reduced by (15%) → 维持 DERIVED", () => {
    const sentence = "With caching, the end-to-end latency is reduced by (15\\%) on the same hardware configuration.";
    expect(qualifiersOf(docWith(sentence), sentence, "15")).toContain("DERIVED");
  });

  it("B-6 负例：单位组头 reduces … by 2.1 ms (15%) 降幅重述 → 维持 DERIVED", () => {
    const sentence = "The quantized build reduces the decoding time by 2.1 ms (15\\%) compared with the fp16 build.";
    expect(qualifiersOf(docWith(sentence), sentence, "15")).toContain("DERIVED");
  });

  it("B-7 负例：触发词组头 higher (3.2%) → 维持 DERIVED（组头是比较词）", () => {
    const sentence = "The tuned schedule is higher (3.2\\%) than the default schedule under the same seed.";
    expect(qualifiersOf(docWith(sentence), sentence, "3.2")).toContain("DERIVED");
  });

  it("B-8 后缀形派生兜底：(68.9% higher) 由 DERIVED_AFTER 直接判定，不被括号规则吞掉", () => {
    const sentence = "On the audit split the recalibrated head is clearly higher (68.9\\% higher) than the factory default.";
    expect(qualifiersOf(docWith(sentence), sentence, "68.9")).toContain("DERIVED");
  });

  it("B-9 无括号直接派生措辞不动：lower by 68.9% → DERIVED", () => {
    const sentence = "Without the auxiliary loss, the recall drops lower by 68.9\\% relative to the full model on the test split.";
    expect(qualifiersOf(docWith(sentence), sentence, "68.9")).toContain("DERIVED");
  });

  it("B-10 from/to 端点语义不动：from 82.36% to 83.7% 两端均不继承", () => {
    const sentence = "After calibration the top-1 accuracy improves from 82.36\\% to 83.7\\% on the held-out split.";
    expect(qualifiersOf(docWith(sentence), sentence, "82.36")).not.toContain("DERIVED");
    expect(qualifiersOf(docWith(sentence), sentence, "83.7")).not.toContain("DERIVED");
  });

  it("B-11 既有 M3 语义不动：a Top-1 accuracy of 0.800 → 不继承（of 归因）", () => {
    const sentence = "The distilled model achieves lower accuracy with a Top-1 accuracy of 0.800 under the same budget.";
    expect(qualifiersOf(docWith(sentence), sentence, "0.800")).not.toContain("DERIVED");
  });

  it("B-12 负例：副词组头 improved markedly (3.2%) → 维持 DERIVED（-ly 形不作同位语组头，fail-closed）", () => {
    const sentence = "With the new sampler, the small-object recall improved markedly (3.2\\%) on the audit split.";
    expect(qualifiersOf(docWith(sentence), sentence, "3.2")).toContain("DERIVED");
  });
});
