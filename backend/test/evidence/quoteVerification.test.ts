/**
 * Quote Verification（M6.5 Stage 1）纯函数测试：
 * 精确命中 / 归一化命中（空白·大小写·全角·零宽·软连字符）/ 错误引文 / 空洞引文。
 */

import { describe, expect, it } from "vitest";

import {
  MIN_NORMALIZED_QUOTE_LENGTH,
  normalizeForQuoteMatch,
  verifyQuoteInChunk,
} from "../../src/evidence/quoteVerification.js";

const CHUNK = [
  "Retrieval-augmented generation (RAG) mitigates hallucination in open-domain",
  "question answering. The average factual error rate drops by 42% when retrieval",
  "is introduced at inference time.",
].join("\n");

describe("normalizeForQuoteMatch", () => {
  it("折叠空白并小写化", () => {
    expect(normalizeForQuoteMatch("  The   Average\nFactual ")).toBe("the average factual");
  });

  it("去除零宽字符与软连字符（U+00AD / U+200B / U+FEFF）", () => {
    const softHyphen = String.fromCharCode(0x00ad);
    const zeroWidthSpace = String.fromCharCode(0x200b);
    const bom = String.fromCharCode(0xfeff);
    const noisy = `factual${softHyphen}er${zeroWidthSpace}ror${bom}rate`;
    expect(normalizeForQuoteMatch(noisy)).toBe("factualerrorrate");
  });

  it("NFKC 兼容分解（全角字母 / 连字）", () => {
    expect(normalizeForQuoteMatch("ＲＡＧ ｍｉｔｉｇａｔｅｓ")).toBe("rag mitigates");
    const ligatureFi = String.fromCharCode(0xfb01); // ﬁ
    expect(normalizeForQuoteMatch(`mi${ligatureFi}eld`)).toBe("mifield");
  });
});

describe("verifyQuoteInChunk", () => {
  it("精确逐字引文通过", () => {
    const result = verifyQuoteInChunk(
      "The average factual error rate drops by 42% when retrieval",
      CHUNK,
    );
    expect(result.ok).toBe(true);
  });

  it("归一化后命中：跨行空白折叠 + 大小写差异", () => {
    const result = verifyQuoteInChunk(
      "the AVERAGE   factual\nerror rate drops by 42%",
      CHUNK,
    );
    expect(result.ok).toBe(true);
  });

  it("归一化后命中：引文带软连字符 / 零宽字符", () => {
    const softHyphen = String.fromCharCode(0x00ad);
    const result = verifyQuoteInChunk(`factual er${softHyphen}ror rate drops by 42%`, CHUNK);
    expect(result.ok).toBe(true);
  });

  it("改写过的引文（非逐字）失败", () => {
    const result = verifyQuoteInChunk("the average factual error rate drops by 50%", CHUNK);
    expect(result.ok).toBe(false);
    expect(result.reason).toBe("quote_not_found");
  });

  it("完全无关的引文失败", () => {
    expect(verifyQuoteInChunk("this sentence never appears anywhere", CHUNK).ok).toBe(false);
  });

  it("空洞引文（空白 / 过短）拒绝", () => {
    expect(verifyQuoteInChunk("   ", CHUNK).reason).toBe("quote_empty");
    expect(verifyQuoteInChunk("abc", CHUNK).reason).toBe("quote_too_short");
    expect(MIN_NORMALIZED_QUOTE_LENGTH).toBe(6);
  });

  it("中文引文同样适用（空白折叠 + 精确子串）", () => {
    const zhChunk = "实验表明，检索增强生成能显著降低开放域问答中的幻觉率，平均下降 42%。";
    expect(verifyQuoteInChunk("显著降低开放域问答中的幻觉率", zhChunk).ok).toBe(true);
    expect(verifyQuoteInChunk("显著提高开放域问答的幻觉率", zhChunk).ok).toBe(false);
  });
});
