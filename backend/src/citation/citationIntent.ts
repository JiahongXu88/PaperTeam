/** Conservative routing hints, never a substitute for source-content verification. */
export type CitationIntent = "background" | "method" | "result" | "comparison";
export type CitationRelevance = "relevant" | "irrelevant" | "unknown";

export function isOwnResultClaim(text: string): boolean {
  return /(?:本文|本研究|我们的|本方法|所提方法|our\b|we\b)[\s\S]{0,100}(?:实验|准确率|性能|提升|优于|达到|得分|结果|accuracy|achiev|outperform|result|score)/i.test(text);
}

export function classifyCitationIntent(text: string): CitationIntent {
  // Numerical/performance assertions remain factual even in an introduction.
  if (isOwnResultClaim(text) || /\d+(?:\.\d+)?\s*(?:%|\\%|BLEU|ms|百分点)|性能|准确率|实验结果|achiev|accuracy|outperform|\bresults?\b/i.test(text)) return "result";
  if (/相比|相反|不同于|与[^。；]{0,60}不同|对比|然而|报告|指出|认为|whereas|contrast|unlike|report|argue|found/i.test(text)) return "comparison";
  if (/机制|通过|依赖|采用|计算|损失函数|证明|表明|导致|mechanism|rely|using|compute|prove|demonstrat|caus/i.test(text)) return "method";
  if (/研究背景|研究方向|研究领域|相关工作|研究主题|研究脉络|领域概述|背景文献|background|research (?:area|direction|topic)|related work|line of research/i.test(text)) return "background";
  return "method"; // Unknown assertions must not escape factual checking.
}

export const CITATION_INTENT_GUIDANCE = [
  "引用用途必须区分 background / method / result / comparison。Metadata Verified 只确认书目身份；Evidence Verified 只确认某条证据；Citation Relevance 是与当前论述相关；Claim Supported 是证据覆盖当前具体命题，四者不能互相替代。",
  "背景引用只需文献真实且与研究背景相关，不要求它证明本文实验；不相关文献不能因为真实就引用。方法机制必须核对来源原文；具体数值与性能比较必须有覆盖该命题的可靠证据。",
  "对比引用允许与本文结论相反：核对的是本文对被引观点的归因是否准确，不是要求被引论文赞同本文。不得把对立观点的如实转述判为矛盾。",
  "本文实验结果只能由本研究已授权实验观测支撑；外部相关论文无论真实、相关或 verified，都不能证明本文结果。",
].join("\n");
