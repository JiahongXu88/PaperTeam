/**
 * Claim Strength Check（M6.7 §8，确定性、无 LLM）。
 *
 * 防护目标：证据弱但表达强。证据说「may improve / 可能改善」，修订把表述升级成
 * 「significantly improves / 显著提升」——这不会触发 Fact Preservation（没有数字
 * 变化）、也不会触发 Citation Preservation（引用没动），是 M5.6 两层守卫之外的
 * 第三类修订风险：claim 强度漂移。
 *
 * 口径：
 *   claim strength：weak（可能 / 或 / 在一定程度上…）< moderate（中性陈述）
 *                   < strong（显著 / 大幅 / 证明 / 全面超过…）
 *   evidence support：direct / partial / insufficient（来自关联 verified evidence
 *                    的 supportStrength；无关联 formal evidence = insufficient）
 *   判定：修订把句子强度升级到 strong（或新增 strong 句）且未被计划 / Evidence
 *         文本授权 → finding：
 *           strong + insufficient → block（Revision Validation 拒绝该条目）
 *           strong + partial     → warning（needs_review，交人工复核）
 *
 * 授权（升级合法）：计划条目文本（instruction / problem）明确点名该强表述，或
 * 关联 evidence 的 claim / quote 原文包含该强表述 / 该句引用的数字（数字本身就是
 * 强度依据）。自由文本里的「优化表述」不构成授权（与 Fact Preservation 同纪律）。
 *
 * 诚实边界：marker 级启发式（与 styleInvariants 同级），不是语义理解。检测不到
 * 的委婉升级仍依赖 Reviewer fact 复核与人审；宁可漏报不制造海量误报——只报
 * 「升级到 strong」的句子，不报 strong 句的平移。
 */

import type { EvidenceRecord } from "../evidence/EvidenceStore.js";
import { isFormalEvidence } from "../evidence/EvidenceSelectionService.js";

export type ClaimStrength = "weak" | "moderate" | "strong";
export type EvidenceSupport = "direct" | "partial" | "insufficient";
export type ClaimStrengthAction = "block" | "warning";

export interface ClaimStrengthFinding {
  /** 相对 manuscript 的文件路径 */
  file: string;
  /** 修改前短片段（无对应句时为新句占位说明；≤ 90 字符） */
  before: string;
  /** 修改后短片段（≤ 90 字符） */
  after: string;
  claimStrength: ClaimStrength;
  evidenceSupport: EvidenceSupport;
  action: ClaimStrengthAction;
  /** 命中的强表述 marker（审计 / UI 定位） */
  markers: string[];
}

/** 强表述 marker（中文为主，学术写作高频；新增须保持保守——误报比漏报伤害大） */
const STRONG_MARKERS: readonly string[] = [
  "显著提升",
  "显著提高",
  "显著改善",
  "显著优于",
  "显著超过",
  "显著降低",
  "大幅提升",
  "大幅提高",
  "大幅改善",
  "大幅下降",
  "全面超过",
  "全面超越",
  "明显优于",
  "明显超过",
  "远超",
  "远优于",
  "彻底解决",
  "完全消除",
  "极大提升",
  "证明",
  "significantly improves",
  "significantly outperforms",
  "substantially improves",
  "proves",
];

/** 弱表述 marker（升级检测的起点之一） */
const WEAK_MARKERS: readonly string[] = [
  "可能",
  "或许",
  "有望",
  "在一定程度上",
  "似乎",
  "或可",
  "may improve",
  "might improve",
  "potentially",
];

/** 数学 / 引用命令剥离后的正文句子切分（。！？；与换行） */
function splitSentences(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split(/(?<=[。！？；!?;])\s*|\n+/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence !== "");
}

/** 剥离 LaTeX 命令与数学环境后的 prose（强度 marker 只可能出现在自然语言里） */
function proseOf(latex: string): string {
  return latex
    .replace(/\r\n/g, "\n")
    .replace(/\\begin\{(equation\*?|align\*?|gather\*?|multline\*?|table\*?|tabular[xX*]*|thebibliography)\}[\s\S]*?\\end\{\1\}/g, " ")
    .replace(/\\(?:cite|citep|citet|citealp|citealt|parencite|textcite|autocite|ref|eqref|label)\*?(?:\[[^\]\n]*\])*\{[^{}]*\}/g, " ")
    .replace(/\\[A-Za-z@]+\*?/g, " ")
    .replace(/[{}]/g, " ");
}

export function classifyClaimStrength(sentence: string): ClaimStrength {
  const lower = sentence.toLowerCase();
  if (STRONG_MARKERS.some((marker) => sentence.includes(marker) || lower.includes(marker))) {
    return "strong";
  }
  if (WEAK_MARKERS.some((marker) => sentence.includes(marker) || lower.includes(marker))) {
    return "weak";
  }
  return "moderate";
}

/**
 * 关联证据对一句 claim 的支撑档位（§8）：
 *   任一 formal evidence supportStrength=direct → direct；
 *   任一 = partial → partial（direct 优先）；
 *   无 formal 关联 / 仅 indirect / contradictory → insufficient。
 * 只认 formal（verified + 锚点）——与 Writer / Reviewer 的正式上下文同口径。
 */
export function evidenceSupportOf(records: readonly EvidenceRecord[]): EvidenceSupport {
  let sawPartial = false;
  for (const record of records) {
    if (!isFormalEvidence(record)) {
      continue;
    }
    if (record.supportStrength === "direct") {
      return "direct";
    }
    if (record.supportStrength === "partial") {
      sawPartial = true;
    }
  }
  return sawPartial ? "partial" : "insufficient";
}

function actionFor(support: EvidenceSupport): ClaimStrengthAction | null {
  // direct：强表述有直接证据支撑，升级合法（不产生 finding）
  if (support === "direct") {
    return null;
  }
  return support === "partial" ? "warning" : "block";
}

/** 数字 token 提取（授权判定：Evidence 含同数字 = 强度有量化依据） */
function numericTokens(sentence: string): string[] {
  return sentence.match(/\d+(?:\.\d+)?/g) ?? [];
}

/** CJK / 拉丁词元（句子配对用；≥ 2 字符才有区分度） */
function contentTokens(sentence: string): string[] {
  const cjk = sentence.match(/[一-鿿]{2,}/g) ?? [];
  const latin = (sentence.toLowerCase().match(/[a-z]{4,}/g) ?? []).filter((word) => word !== "");
  return [...cjk, ...latin];
}

function snippet(text: string, maxLength = 90): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

export interface ClaimStrengthCheckInput {
  file: string;
  before: string;
  after: string;
  /** 关联的 formal evidence（调用方按条目 relatedEvidenceIds / 章节引用解析） */
  relatedEvidence: readonly EvidenceRecord[];
  /** 授权文本（计划条目 instruction / problem；命中强 marker 或数字 = 授权） */
  authorizationTexts?: readonly string[];
}

/**
 * 检测一次修订的 claim 强度升级（单文件；纯函数）。
 * 只报 after 侧新出现的 strong 句；强 marker 平移（before 已是 strong 同 marker）
 * 不报。授权判定在句子粒度：authorizationTexts 或 relatedEvidence 文本包含该句
 * 的任一强 marker，或包含该句引用的任一数字。
 */
export function checkClaimStrengthEscalation(input: ClaimStrengthCheckInput): ClaimStrengthFinding[] {
  const beforeSentences = splitSentences(proseOf(input.before));
  const authorizationPool = [
    ...(input.authorizationTexts ?? []),
    ...input.relatedEvidence.flatMap((record) => [record.claim, record.summary ?? "", record.quote ?? ""]),
  ];
  const findings: ClaimStrengthFinding[] = [];
  const support = evidenceSupportOf(input.relatedEvidence);

  for (const afterSentence of splitSentences(proseOf(input.after))) {
    if (classifyClaimStrength(afterSentence) !== "strong") {
      continue;
    }
    const markers = STRONG_MARKERS.filter(
      (marker) => afterSentence.includes(marker) || afterSentence.toLowerCase().includes(marker),
    );
    if (markers.length === 0) {
      continue;
    }
    // 找 before 侧的最相近句（内容词元重合最多）；无重合句 = 新增句
    const afterTokens = new Set(contentTokens(afterSentence));
    let bestOverlap = 0;
    let counterpart: string | null = null;
    let counterpartStrength: ClaimStrength = "moderate";
    for (const beforeSentence of beforeSentences) {
      const overlap = contentTokens(beforeSentence).filter((token) => afterTokens.has(token)).length;
      if (overlap > bestOverlap) {
        bestOverlap = overlap;
        counterpart = beforeSentence;
        counterpartStrength = classifyClaimStrength(beforeSentence);
      }
    }
    const isNewSentence = bestOverlap === 0;
    if (!isNewSentence && counterpartStrength === "strong") {
      continue; // 强度平移，不算升级
    }
    // 授权：文本包含强 marker 或同数字
    const numbers = numericTokens(afterSentence);
    const authorized =
      markers.some((marker) => authorizationPool.some((text) => text.includes(marker))) ||
      numbers.some((number) => authorizationPool.some((text) => text.includes(number)));
    if (authorized) {
      continue;
    }
    const action = actionFor(support);
    if (action === null) {
      continue;
    }
    findings.push({
      file: input.file,
      before: isNewSentence ? "（新增句，无对应原文）" : snippet(counterpart ?? ""),
      after: snippet(afterSentence),
      claimStrength: "strong",
      evidenceSupport: support,
      action,
      markers: markers.slice(0, 3),
    });
  }
  return findings;
}

export function describeClaimStrengthFindings(findings: readonly ClaimStrengthFinding[]): string {
  if (findings.length === 0) {
    return "无 claim 强度升级问题";
  }
  const blocks = findings.filter((finding) => finding.action === "block").length;
  const warnings = findings.length - blocks;
  return `claim 强度升级 ${findings.length} 处（block ${blocks} / warning ${warnings}）：${findings
    .slice(0, 3)
    .map((finding) => `${finding.file}「${finding.after.slice(0, 40)}」（${finding.markers[0] ?? ""}，证据 ${finding.evidenceSupport}）`)
    .join("；")}`;
}
