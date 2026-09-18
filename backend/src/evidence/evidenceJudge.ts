/**
 * Evidence Semantic Judge（M6.5 Grounding Stage 3；复用 Citation 角色）。
 *
 * 与 CitationIntegrityService 的语义核验（semanticVerifier v4/v5）同纪律：
 * - 只喂 claim + quote + chunk 原文——judge 不见摘要、不见文献库 digest、
 *   不见其它证据（防蒸馏/摘要污染）；
 * - 禁止凭模型记忆判定（即使它认识这篇论文）；
 * - judge 声称的 keyQuote 必须逐字来自 chunk 原文，否则剥离（伪造引文
 *   不可采信——parseJudgeOutput 同款确定性守卫）；
 * - verdict 只有 supported / partially_supported / unsupported；
 *   judge 无法判断 → 不伪造裁决（调用方按 judge_failed 处理为 unverifiable）。
 *
 * 不新增 Agent：任务经 runtime.runAgent 以 citation 角色 scope
 * （citation/evidence/<candidateId>）提交，单任务短生命周期。
 */

import { extractJsonObject } from "../agents/outputParsing.js";
import { AgentRunFailedError } from "../errors.js";
import type { EvidenceJudgeVerdict } from "./candidates.js";
import { normalizeForQuoteMatch } from "./quoteVerification.js";

/** judge prompt 中 chunk 原文的字符上限（token 控制；与 semanticVerifier 同口径） */
const CHUNK_TEXT_MAX_CHARS = 4000;

export const EVIDENCE_JUDGE_VERDICTS: readonly EvidenceJudgeVerdict[] = [
  "supported",
  "partially_supported",
  "unsupported",
];

export interface EvidenceJudgeInput {
  claim: string;
  quote: string;
  chunkText: string;
  /** 来源展示行（标题/年份；仅供定位语境，judge 不据此判断） */
  sourceLine?: string;
}

/** judge prompt：只含 claim + quote + chunk 原文（严格证据边界） */
export function buildEvidenceJudgePrompt(input: EvidenceJudgeInput): string {
  const chunkText =
    input.chunkText.length > CHUNK_TEXT_MAX_CHARS
      ? `${input.chunkText.slice(0, CHUNK_TEXT_MAX_CHARS)}\n…（chunk 原文超长截断；quote 已在截断范围内经过独立校验）`
      : input.chunkText;
  return [
    "你是证据语义核验员。判断下方文献原文段落是否支撑这条研究论断（claim）。",
    "",
    "严格规则：",
    "1. 只能依据下方【文献原文段落】与【候选引文】判断；即使你认识这篇文献，也禁止使用自己的记忆、训练知识或常识推断文献内容；",
    "2. claim 是一条待支撑的研究论断；quote 是从该段落中摘出的候选引文（已做逐字校验，确实存在于原文中）；",
    "3. supported：段落内容整体明确支撑该论断；",
    "4. partially_supported：段落内容确实支撑论断的一部分，但论断中仍有重要成分未被段落内容覆盖；",
    "5. unsupported：段落内容与论断主题明确相关且足够具体，使你能较高置信度确认该段落并不能支撑该论断；「段落未提及」「段落过于笼统」「主题对不上」都不是 unsupported——证据不足不是不支持；",
    "6. 确实无法判断（段落与论断无法建立可判关系）时输出 insufficient_evidence——绝不猜测、绝不把「无法判断」说成 unsupported；",
    "7. keyQuote 必须逐字复制自【文献原文段落】（会被程序校验，编造的引文将被丢弃）；",
    "",
    '只输出一个 JSON 对象（无围栏）：{"verdict": "supported | partially_supported | unsupported | insufficient_evidence", "reason": "一句话中文理由", "keyQuote": "段落中最关键的一句"}',
    "",
    `【待核验论断（claim）】\n${input.claim}`,
    "",
    `【候选引文（quote，已确认存在于原文）】\n${input.quote}`,
    ...(input.sourceLine !== undefined ? ["", `【来源（仅语境参考）】${input.sourceLine}`] : []),
    "",
    "===== 文献原文段落（chunk）=====",
    chunkText,
  ].join("\n");
}

export interface EvidenceJudgeOutput {
  /**
   * insufficient_evidence：judge 无法判断（不是证据有问题）——调用方按
   * unverifiable 处理（可 retry），绝不映射成 unsupported / partially_supported。
   */
  verdict: EvidenceJudgeVerdict | "insufficient_evidence";
  reason: string;
  /** judge 声称的关键引文（必须逐字来自 chunk 原文，否则被剥离） */
  keyQuote?: string;
}

const PARSEABLE_VERDICTS: readonly string[] = [
  ...EVIDENCE_JUDGE_VERDICTS,
  "insufficient_evidence",
];

/** 解析 judge 输出 + 引文真实性校验（伪造 keyQuote 一律剥离） */
export function parseEvidenceJudgeOutput(
  raw: string,
  chunkText: string,
): EvidenceJudgeOutput {
  const parsed = extractJsonObject(raw, "Evidence 语义核验结果") as unknown as {
    verdict?: unknown;
    reason?: unknown;
    keyQuote?: unknown;
  };
  const verdict = PARSEABLE_VERDICTS.includes(parsed.verdict as string)
    ? (parsed.verdict as EvidenceJudgeOutput["verdict"])
    : undefined;
  if (verdict === undefined) {
    throw new AgentRunFailedError(
      `verdict 缺失或非法（必须是 ${PARSEABLE_VERDICTS.join(" / ")} 之一）`,
    );
  }
  const reason = typeof parsed.reason === "string" ? parsed.reason.trim().slice(0, 500) : "";
  let keyQuote: string | undefined =
    typeof parsed.keyQuote === "string" && parsed.keyQuote.trim() !== ""
      ? parsed.keyQuote.trim()
      : undefined;
  if (keyQuote !== undefined && !quoteFromChunk(keyQuote, chunkText)) {
    keyQuote = undefined; // judge 编造的引文：剥离，不进记录
  }
  return { verdict, reason, ...(keyQuote !== undefined ? { keyQuote } : {}) };
}

/** keyQuote 必须来自 chunk 原文（归一化口径与 Stage 1 一致的包含式校验） */
export function quoteFromChunk(quote: string, chunkText: string): boolean {
  const needle = normalizeForQuoteMatch(quote);
  if (needle === "") {
    return false;
  }
  return normalizeForQuoteMatch(chunkText).includes(needle);
}
