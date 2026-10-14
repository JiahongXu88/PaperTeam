/**
 * M14.1b：事实的来源核验（extracted → source_verified）。
 *
 * source_verified 的含义：事实的 surface 在**同一内容版本**的独立文本层中被逐字
 * 找到（表格事实：PyMuPDF 文本层同页 token；语句事实：解析文档文本块中的引文）。
 * 它只证明"抽取结果与来源一致"，不证明实验真实性，也不等于作者确认。
 *
 * 不可核验（页码未知 / 字形问题 / 文本层缺失 / 找不到）→ sourceCheck=failed 并留言，
 * 事实保持 extracted（fail closed，不冒充）。
 */

import { normalizeSurfaceText } from "./factValues.js";
import type { ScientificFact } from "./researchInputTypes.js";

export interface TextLayerPage {
  page: number;
  text: string;
}

export interface SourceCheckOutcome {
  verified: boolean;
  method?: "text_layer_match" | "quote_match";
  note: string;
}

/** 表格单元格：surface 以独立 token 形态出现在同页文本层 */
export function checkTableCellAgainstTextLayer(fact: ScientificFact, pages: readonly TextLayerPage[] | null): SourceCheckOutcome {
  if (fact.value.glyphIssues === true) {
    return { verified: false, note: "原文含不可映射字形（私用区），拒绝核验" };
  }
  if (pages === null || pages.length === 0) {
    return { verified: false, note: "文本层不可用（无 PyMuPDF 产物）" };
  }
  const page = fact.provenance.page;
  if (fact.provenance.pageBasis !== "parser" || page === undefined) {
    return { verified: false, note: "parser 未报告页码，不在全文盲搜（不猜页）" };
  }
  const pageText = pages.find((entry) => entry.page === page)?.text;
  if (pageText === undefined) {
    return { verified: false, note: `文本层缺少第 ${page} 页` };
  }
  if (containsToken(pageText, fact.surface)) {
    return { verified: true, method: "text_layer_match", note: `第 ${page} 页文本层含 token "${fact.surface}"` };
  }
  return { verified: false, note: `第 ${page} 页文本层未找到 token "${fact.surface}"` };
}

/** 语句类事实：quote 在文档全文中逐字（空白不敏感）出现 */
export function checkQuoteAgainstDocumentText(fact: ScientificFact, documentText: string): SourceCheckOutcome {
  const quote = fact.provenance.quote;
  if (quote === undefined || normalizeSurfaceText(quote).length < 12) {
    return { verified: false, note: "无足够长度（≥12 字符）的原文引文，无法核验" };
  }
  const pattern = quoteToWhitespaceInsensitivePattern(quote);
  const matches = documentText.match(pattern);
  if (matches !== null && matches.length >= 1) {
    return { verified: true, method: "quote_match", note: `引文在文档全文出现 ${matches.length} 次` };
  }
  return { verified: false, note: "引文未在文档全文逐字出现" };
}

export function containsToken(text: string, token: string): boolean {
  const normalizedText = normalizeSurfaceText(text);
  const normalizedToken = normalizeSurfaceText(token);
  if (normalizedToken === "") {
    return false;
  }
  const escaped = normalizedToken.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s*");
  return new RegExp(`(?<![\\p{L}\\p{N}.])${escaped}(?![\\p{L}\\p{N}])`, "u").test(normalizedText);
}

function quoteToWhitespaceInsensitivePattern(quote: string): RegExp {
  const parts = normalizeSurfaceText(quote)
    .split(/\s+/)
    .map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(parts.join("\\s*"), "gu");
}

/** 文档全文（文本块拼接；表格 / 图不计） */
export function documentPlainText(blocks: ReadonlyArray<{ type: string; text?: string; caption?: string }>): string {
  return blocks
    .map((block) => (block.type === "text" ? block.text ?? "" : block.caption ?? ""))
    .filter((text) => text !== "")
    .join("\n");
}
