/**
 * Quote Verification（M6.5 Grounding Stage 1；确定性，无 LLM）。
 *
 * 检查 candidate.quote 是否逐字存在于 chunk.text。允许轻量 normalization
 * （不改变文字内容本身的归一，只消除排版噪声）：
 * - NFKC（兼容分解：全角/半角、连字 ﬁ→fi 等排版变体）；
 * - 移除零宽字符与软连字符（U+200B–U+200D / U+FEFF / U+00AD——pymupdf
 *   块边界断词修复中 U+00AD 曾造成核验假失败的既有教训）；
 * - 空白折叠（任意空白串 → 单空格；CRLF / PDF 换行噪声）；
 * - 小写化（大小写排版差异；对中文无影响）。
 *
 * 禁止：同义词替换、标点改写、子串模糊匹配（ED）——那是语义层的事，
 * 由 Stage 3 的 judge 处理；本层只回答「原文里有没有这句话」。
 */

/** 归一化后允许匹配的最小长度（防 1-2 个字符的空洞命中） */
export const MIN_NORMALIZED_QUOTE_LENGTH = 6;

const INVISIBLE_CHARS = new Set([0x00ad, 0x200b, 0x200c, 0x200d, 0xfeff].map((code) => String.fromCharCode(code)));

/** 去除零宽字符与软连字符（排版噪声；不改变可见内容） */
function stripInvisible(text: string): string {
  let out = "";
  for (const ch of text) {
    if (!INVISIBLE_CHARS.has(ch)) {
      out += ch;
    }
  }
  return out;
}

/** 归一化（NFKC → 去零宽/软连字符 → 空白折叠 → 小写） */
export function normalizeForQuoteMatch(text: string): string {
  return stripInvisible(text.normalize("NFKC"))
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

export interface QuoteVerificationResult {
  ok: boolean;
  /** 归一化后的 quote（诊断/审计用） */
  normalizedQuote: string;
  /** 失败时的简短原因码 */
  reason?: "quote_empty" | "quote_too_short" | "quote_not_found";
}

/**
 * 逐字校验：quote（归一化后）必须是 chunkText（归一化后）的子串。
 * 完全确定性——同输入恒同输出，可独立测试。
 */
export function verifyQuoteInChunk(quote: string, chunkText: string): QuoteVerificationResult {
  const normalizedQuote = normalizeForQuoteMatch(quote);
  if (normalizedQuote === "") {
    return { ok: false, normalizedQuote, reason: "quote_empty" };
  }
  if (normalizedQuote.length < MIN_NORMALIZED_QUOTE_LENGTH) {
    return { ok: false, normalizedQuote, reason: "quote_too_short" };
  }
  const normalizedChunk = normalizeForQuoteMatch(chunkText);
  if (!normalizedChunk.includes(normalizedQuote)) {
    return { ok: false, normalizedQuote, reason: "quote_not_found" };
  }
  return { ok: true, normalizedQuote };
}
