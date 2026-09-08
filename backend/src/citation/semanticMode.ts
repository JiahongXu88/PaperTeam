/**
 * Citation Semantic Verification 模式（Claim-Citation 一致性核验的运行档位）。
 *
 * 两层核验中的 Layer 2（语义核验）是可配置能力；Layer 1（引用真实性 /
 * metadata 核验）始终执行，不受本模式影响：
 *
 *   off                 不执行语义核验（新 Review 默认）——不抽取 claim、
 *                       不做 evidence judge、不产生 SUPPORTED/UNSUPPORTED 等
 *                       semantic records；metadata 核验完整运行
 *   contradiction_only  仅检查明显冲突——只把「正文论断与引用来源内容明确
 *                       相反」判为 CONTRADICTED；宁可 NO_CONTRADICTION_DETECTED，
 *                       不把「证据不足」当问题展示；不为 SUPPORTED 消耗调用
 *   full                完整逐条核验（旧版默认行为）
 *
 * 两个默认值的区分（重要）：
 *   - 新 Review Run：缺省 off（HTTP 层显式写入 request，不靠读取端兜底）
 *   - 历史持久化 Run（request 无该字段）：解释为 full——旧版本实际始终执行
 *     完整语义核验，不能把旧 Run 解释成 off（readSemanticMode 的兜底语义）
 */

export const CITATION_SEMANTIC_MODES = ["off", "contradiction_only", "full"] as const;

export type CitationSemanticMode = (typeof CITATION_SEMANTIC_MODES)[number];

export function isCitationSemanticMode(value: unknown): value is CitationSemanticMode {
  return typeof value === "string" && (CITATION_SEMANTIC_MODES as readonly string[]).includes(value);
}

/** 新 Review Run 的缺省模式 */
export const DEFAULT_CITATION_SEMANTIC_MODE: CitationSemanticMode = "off";

/**
 * 从 WorkflowState.request 读取模式。
 * 字段缺失（旧版本创建的 run）→ full：旧 Run 曾始终执行完整语义核验，
 * planner 按 full 解释才能正确 resume，且历史语义结果不被「降级」为 off。
 */
export function readSemanticMode(request: Record<string, unknown> | undefined): CitationSemanticMode {
  const value = request?.["citationSemanticMode"];
  return isCitationSemanticMode(value) ? value : "full";
}
