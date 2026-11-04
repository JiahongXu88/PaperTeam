/**
 * M17.1 学术写作风格与过度防御性表达：默认必检（审查）+ 受控定点修订（守卫）的纯函数内核。
 *
 * 产品裁决（M17.1 §0）：AI 模板化写作风格与过度防御性表达审查是正常论文工作流的默认必检项，
 * 不是可选的「去 AI 痕」模式。必检 ≠ 必改；风格发现是建议性 / 可修复的风格问题，不进入科学 Quality Gate。
 *
 * 分工（确定性 vs 模型）：
 *   - 确定性候选扫描（scanStyleCandidates）只是廉价的候选发现与覆盖辅助：没命中词表 ≠ 没有防御性写作；
 *     审查本身由每个 Review Unit 一次有界模型调用对**单元全文**完成（prompt 由 buildUnitStyleAuditPrompt 生成）。
 *   - 模型给出的 necessity / action 只是建议；机器侧（classifyStyleFinding）按合法类别白名单强制分级：
 *     必要限定 / 负结果恒 KEEP，贡献弱化 / overclaim 风险 / 必要性不确定恒 AUTHOR_DECISION，
 *     只有「UNNECESSARY + MINIMAL_REWRITE + 锚点唯一 + 确定性守卫预检通过」才进入自动定点修订候选。
 *   - checkStyleRewrite 是**锚内**确定性守卫（数值 / 引用 / LaTeX / 方向 / 因果 / 强断言 / 泛化 / 实质限定 /
 *     对冲保留 / 长度）。它只能阻断常见越权模式，**不是**语义等价证明：自动落盘前另需一次只可否决的语义复核
 *     （buildStyleRewriteCheckPrompt），判断不了 → 保持原文 / Author Decision。
 *
 * 不做的事：不鉴定作者身份或 AI 生成来源；不输出任何「AI 率 / AI 概率」；不放宽 styleInvariants.ts（style_polish
 * 通道照旧禁止改动限定强度——本模块是另一条只允许删除冗余对冲的窄通道）。
 *
 * 规则来源（只借鉴判定思路，未引入第三方 Skill 文本；见 docs/research/M17_0_ANTI_DEFENSIVE_SKILL_RESEARCH.md）：
 *   Kiterlin/anti-defensive-writing@f516147（MIT）的「必要限定」判据与防御句分类；
 *   OvOYu/anti-defensive-writing@bdab0d2（MIT）的「事实与必要披露优先 / audit 只读」优先级；
 *   ShaishavMaisuria/research-paper-lifecycle-skills@cf30d64（Apache-2.0）的「支撑—缩窄—删除，强度变化逐条审查」。
 *   明确拒绝 Adkid-Zephyr「不说输 / 打不过的维度不设为比赛」等鼓励选择性报告的条款。
 */

import { createHash } from "node:crypto";

import { StructuredOutputError } from "../agents/outputParsing.js";
import { STRONG_MARKERS } from "../quality/claimStrength.js";
import { extractCitationKeys, extractLatexStructure, extractMathSegments, extractNumericTokens } from "./styleInvariants.js";

export const ACADEMIC_STYLE_POLICY_VERSION = "academic-style-audit/v1" as const;
export const ACADEMIC_STYLE_REPORT_SCHEMA = "academic-style-audit-report/v1" as const;
export const ACADEMIC_STYLE_REVISION_SCHEMA = "academic-style-revision/v1" as const;
/** 每单元最多报告的风格发现（精度优先；超出截断并如实计数） */
export const STYLE_FINDINGS_PER_UNIT_MAX = 12;
/** prompt 中列出的确定性候选句上限（只是提示，不限制模型审查范围） */
export const STYLE_CANDIDATE_HINTS_MAX = 15;
/** 语义复核每批条目数 */
export const STYLE_REWRITE_CHECK_BATCH = 20;
/** 不同于正文语言识别的「中文单元」判据：CJK 字符占非空白字符比例 */
const CJK_RATIO_MIN = 0.15;

// ---------------------------------------------------------------------------
// 共享政策（Writer 预防规则与 Reviewer 审查规则同源：两条工作流消费同一份文本）
// ---------------------------------------------------------------------------

/** Writer 初稿 / 修订的轻量预防规则（只约束表达；不得借此改动事实或制造更强结论） */
export const ACADEMIC_STYLE_WRITER_LINES: readonly string[] = [
  "表达纪律（M17.1 学术风格政策）：不写无信息的谦辞、道歉与预先免责（如「本文仅作粗浅尝试」「不足之处敬请批评指正」「需要指出的是」）；同一结论只保留一个与证据强度对应的限定，并写明不确定性的来源；不用机械过渡句与空泛总结。",
  "该纪律不得改变事实：真实的样本 / 数据集 / 测试协议限制、未做的统计检验、负结果、失败案例、资源成本与不可比条件必须保留；不得因此新增「显著」「首次」「SOTA」「全面领先」「导致」「证明」等没有证据支撑的强断言。",
];

export type StyleCategory =
  | "uninformative_hedge"
  | "repeated_modesty_apology"
  | "mechanical_template"
  | "empty_summary_transition"
  | "unnatural_wording"
  | "understated_contribution"
  | "required_limitation"
  | "negative_result_disclosure"
  | "overclaim_risk";

export const STYLE_CATEGORIES: readonly StyleCategory[] = [
  "uninformative_hedge",
  "repeated_modesty_apology",
  "mechanical_template",
  "empty_summary_transition",
  "unnatural_wording",
  "understated_contribution",
  "required_limitation",
  "negative_result_disclosure",
  "overclaim_risk",
];

export const STYLE_CATEGORY_LABELS: Record<StyleCategory, string> = {
  uninformative_hedge: "无信息防御性限定 / 对冲堆叠",
  repeated_modesty_apology: "重复自谦 / 道歉",
  mechanical_template: "机械模板套话",
  empty_summary_transition: "空泛总结 / 过渡",
  unnatural_wording: "不自然的语言组织",
  understated_contribution: "贡献被无端弱化",
  required_limitation: "科学必要限定（保留）",
  negative_result_disclosure: "负结果 / 风险披露（保留）",
  overclaim_risk: "存在 overclaim 风险",
};

/** 允许自动定点改写的类别（纯措辞问题）；其余类别机器侧不自动改 */
const AUTO_REWRITE_CATEGORIES: ReadonlySet<StyleCategory> = new Set([
  "uninformative_hedge",
  "repeated_modesty_apology",
  "mechanical_template",
  "empty_summary_transition",
  "unnatural_wording",
]);
/** 允许以空串删除整段原句 / 分句的类别（无信息内容；删除不丢科研信息） */
const DELETABLE_CATEGORIES: ReadonlySet<StyleCategory> = new Set(["repeated_modesty_apology", "mechanical_template", "empty_summary_transition"]);

export type NecessityJudgment = "UNNECESSARY" | "REQUIRED" | "UNCERTAIN";
export type StyleSuggestedAction = "KEEP" | "MINIMAL_REWRITE" | "AUTHOR_DECISION";
/** 机器分级后的处置（模型建议只是输入之一） */
export type StyleDisposition = "AUTO_REWRITE_ELIGIBLE" | "KEEP" | "AUTHOR_DECISION";
export type StyleRevisionStatus =
  | "NOT_DISPATCHED"
  | "KEPT"
  | "AUTHOR_DECISION"
  | "AUTO_FIXED"
  | "GUARD_REJECTED"
  | "SEMANTIC_REJECTED"
  | "ANCHOR_LOST"
  | "STALE";

const NECESSITY: readonly NecessityJudgment[] = ["UNNECESSARY", "REQUIRED", "UNCERTAIN"];
const ACTIONS: readonly StyleSuggestedAction[] = ["KEEP", "MINIMAL_REWRITE", "AUTHOR_DECISION"];

/** 模型原始输出（解析 + 锚点校验后；未经机器分级） */
export interface RawStyleFinding {
  quote: string;
  styleCategory: StyleCategory;
  reason: string;
  necessity: NecessityJudgment;
  constraints: string[];
  action: StyleSuggestedAction;
  /** action=MINIMAL_REWRITE 时的最小改写；空串 = 删除该片段；undefined = 未给出 */
  rewrite?: string;
}

export interface StyleRewriteViolation {
  rule:
    | "unchanged"
    | "numbers"
    | "citations"
    | "latex_structure"
    | "math"
    | "strong_claim_added"
    | "causal_added"
    | "generalization_added"
    | "direction_changed"
    | "limitation_removed"
    | "negation_removed"
    | "hedge_removed"
    | "expanded"
    | "sentence_added"
    | "deletion_not_allowed";
  detail: string;
}

export interface StyleRewriteCheck {
  ok: boolean;
  violations: StyleRewriteViolation[];
}

export interface StyleFinding {
  /** 稳定 id：file + 原句（空白归一）+ 类别 的哈希（同一原句跨轮同 id，lineage 可追） */
  id: string;
  unitId: string;
  file: string;
  logicalSection: string;
  heading: string;
  originalQuote: string;
  styleCategory: StyleCategory;
  candidateReason: string;
  necessityJudgment: NecessityJudgment;
  evidenceConstraints: string[];
  /** 模型建议（原样记录） */
  suggestedAction: StyleSuggestedAction;
  proposedRewrite?: string;
  /** 机器分级结果与理由（UI 展示「为什么不自动改」） */
  disposition: StyleDisposition;
  dispositionReason: string;
  precheck?: StyleRewriteCheck;
  /** 命中的确定性候选信号（只读辅助） */
  candidateSignals: string[];
  reviewStatus: "REVIEWED";
  revisionStatus: StyleRevisionStatus;
  lineage: { round: number; unitFingerprint: string; taskId?: string; model?: string; promptSha256?: string; reusedFromRound?: number };
}

export type StyleAuditUnitStatus = "COMPLETE" | "REUSED" | "FAILED" | "SKIPPED_BUDGET" | "NOT_APPLICABLE";

export interface StyleAuditUnitRecord {
  unitId: string;
  file: string;
  heading: string;
  chars: number;
  unitFingerprint: string;
  status: StyleAuditUnitStatus;
  /** NOT_APPLICABLE / FAILED / SKIPPED_BUDGET 的原因（UI 原样展示） */
  reason?: string;
  attempts: number;
  findings: number;
  candidates: number;
  /** 确定性候选句中模型未逐条裁决的数量（覆盖辅助：不等于漏审，只提示） */
  candidatesUnaddressed?: number;
  droppedFindings?: number;
  error?: string;
  taskId?: string;
  model?: string;
  promptSha256?: string;
  usage?: Record<string, unknown>;
  ms?: number;
  reusedFromRound?: number;
}

export type StyleAuditCoverageState = "COMPLETE" | "PARTIAL" | "FAILED" | "NOT_APPLICABLE" | "DISABLED";

export interface StyleAuditCoverage {
  state: StyleAuditCoverageState;
  eligibleUnits: number;
  completedUnits: number;
  reusedUnits: number;
  failedUnits: number;
  skippedUnits: number;
  notApplicableUnits: number;
  eligibleChars: number;
  reviewedChars: number;
  /** 未完成单元的原因汇总（失败 / 预算 / 不适用） */
  reasons: string[];
}

export interface StyleAuditCounts {
  findings: number;
  byCategory: Partial<Record<StyleCategory, number>>;
  byDisposition: Record<StyleDisposition, number>;
  unanchored: number;
}

export interface StyleRevisionClosureItem {
  findingId: string;
  status: "CLOSED" | "NOT_CLOSED";
  /** 改写后的句子在新一轮风格审查中又被标出（不阻塞，仅提示） */
  reflagged: boolean;
}

export interface StyleAuditReport {
  schemaVersion: typeof ACADEMIC_STYLE_REPORT_SCHEMA;
  policyVersion: typeof ACADEMIC_STYLE_POLICY_VERSION;
  projectId: string;
  round: number;
  reviewedRevision?: number;
  generatedAt: string;
  coverage: StyleAuditCoverage;
  units: StyleAuditUnitRecord[];
  findings: StyleFinding[];
  /** 引文锚点无法在单元原文中定位的模型输出（fail-closed：不进入 findings、不可改写） */
  unanchored: Array<{ unitId: string; quote: string; reason: string }>;
  counts: StyleAuditCounts;
  calls: { audit: number; retries: number; failures: number };
  /** 上一轮自动修订条目在本轮的关闭情况（确定性：原句已不在、改写句仍在） */
  previousRevisionClosure?: { sourceRound: number; items: StyleRevisionClosureItem[] };
  disclaimer: string;
}

export const STYLE_AUDIT_DISCLAIMER =
  "「AI 写作风格风险」只描述可定位的模板化 / 过度防御性表达，不是对作者身份或 AI 生成来源的鉴定；不承诺通过任何 AIGC 检测器，也不输出 AI 率。";

// ---------------------------------------------------------------------------
// 确定性词表（候选发现 + 守卫共用；守卫只阻断，不证明语义等价）
// ---------------------------------------------------------------------------

export const HEDGE_TERMS: readonly string[] = [
  "在一定程度上", "一定程度上", "在某种程度上", "某种程度上", "可能", "或许", "也许", "似乎", "大概", "大致",
  "潜在", "有望", "或可", "倾向于", "初步",
];

/** 无信息的自谦 / 道歉 / 预先免责 / 模板过渡（可安全删除的样板；只用于守卫的「样板剥离」与候选提示） */
const BOILERPLATE_PATTERNS: readonly RegExp[] = [
  /(?:难免|不可避免地?)存在(?:诸多|一些|许多|若干)?(?:的)?不足(?:之处)?/g,
  /不足之处(?:在所难免)?/g,
  /在所难免/g,
  /敬请(?:各位)?(?:读者|专家|同行|老师)?(?:批评指正|斧正|指正)/g,
  /恳请(?:各位)?(?:读者|专家|同行|老师)?(?:批评指正|斧正|指正)/g,
  /(?:水平|能力|学识)有限/g,
  /抛砖引玉/g,
  /粗浅(?:的)?(?:尝试|探索|工作)?/g,
  /(?:仅仅|仅|只)?是(?:一次|一个)?初步(?:的)?(?:尝试|探索)/g,
  /(?:仅|只)作(?:初步|粗浅)?(?:的)?(?:尝试|探索)/g,
  /(?:我们|本文|笔者)?并不(?:声称|是说|意味着|试图证明)/g,
  /这并不意味着/g,
  /当然这并不影响/g,
  /需要(?:特别)?(?:指出|说明|澄清|强调)的是[，,]?/g,
  /值得(?:注意|一提|指出|强调)的是[，,]?/g,
  /不可否认(?:的是)?[，,]?/g,
  /毋庸置疑(?:的是)?[，,]?/g,
  /众所周知[，,]?/g,
  /综上所述[，,]?/g,
  /总而言之[，,]?/g,
  /遗憾的是[，,]?/g,
];

const TEMPLATE_HINTS: readonly RegExp[] = [
  /具有(?:重要的?)?(?:理论|现实|实际)?(?:意义|价值)和(?:理论|现实|实际)?(?:意义|价值)/,
  /为.{0,12}提供了?(?:有益的?|一定的|新的)?(?:参考|借鉴|思路|启示)/,
  /(?:随着|伴随着).{0,20}的(?:快速|飞速|迅猛)发展/,
  /(?:越来越|日益)受到(?:广泛)?(?:关注|重视)/,
  /仍有(?:很大的?|较大的?)?(?:提升|改进)空间/,
  /只能提供有限(?:的)?参考/,
];

export const STRONG_CLAIM_TERMS: readonly string[] = [
  ...STRONG_MARKERS,
  "显著", "首次", "第一次", "率先", "证实", "确证", "全面", "彻底", "完全", "始终", "必然", "一定能",
  "SOTA", "state-of-the-art", "最先进", "最优", "领先", "突破", "远超", "大幅", "明显优于",
];
export const CAUSAL_TERMS: readonly string[] = ["导致", "引起", "造成", "致使", "使得", "归因于", "决定了", "从而", "因而"];
export const GENERALIZATION_TERMS: readonly string[] = ["所有", "全部", "一切", "任何", "普遍", "各种", "广泛适用", "通用"];
export const DIRECTION_TERMS: readonly string[] = [
  "高于", "低于", "优于", "劣于", "弱于", "差于", "不如", "超过", "落后", "提升", "提高", "下降", "降低", "增加",
  "减少", "增大", "减小", "改善", "恶化", "增强", "减弱", "上升",
];
/** 实质限定（样本 / 数据集 / 协议 / 验证 / 统计 / 负结果 / 代价）：自动改写不得减少 */
export const LIMITATION_TERMS: readonly string[] = [
  "未在", "尚未", "未经", "未做", "未进行", "未开展", "未验证", "未覆盖", "未考虑", "无法", "不能", "不可比", "不具可比",
  "不显著", "无显著", "仅在", "仅限", "仅覆盖", "仅适用", "仅针对", "仅基于", "只在", "只适用", "只针对", "只基于",
  "单一", "单个数据集", "小样本", "样本量", "样本较少", "样本有限", "局限", "限制", "失败", "负结果", "不同协议",
  "不同的协议", "训练数据不同", "代价", "开销", "成本", "不足以", "待验证", "待补充", "有待",
];
const NEGATION_CHARS = /[不未无非没否]/g;

const sha256 = (text: string): string => createHash("sha256").update(text).digest("hex");
export const compactWhitespace = (text: string): string => text.replace(/\s+/g, "");

/** 最长优先计数并抹去已计片段（避免「在一定程度上」被「一定程度上」重复计数） */
export function countTerms(text: string, terms: readonly string[]): Map<string, number> {
  let rest = text;
  const counts = new Map<string, number>();
  for (const term of [...terms].sort((a, b) => b.length - a.length)) {
    if (term === "") continue;
    let count = 0;
    let index = rest.indexOf(term);
    while (index !== -1) {
      count += 1;
      rest = `${rest.slice(0, index)}${"\u0000".repeat(term.length)}${rest.slice(index + term.length)}`;
      index = rest.indexOf(term, index + term.length);
    }
    if (count > 0) counts.set(term, count);
  }
  return counts;
}

const total = (counts: Map<string, number>): number => [...counts.values()].reduce((sum, value) => sum + value, 0);

/** 自然语言正文（剥离数学、引用 / 交叉引用命令与命令名；保留命令参数里的文字） */
export function styleProse(latex: string): string {
  return latex
    .replace(/\r\n/g, "\n")
    .replace(/\\begin\{(equation\*?|align\*?|gather\*?|multline\*?|table\*?|tabular[xX*]*)\}[\s\S]*?\\end\{\1\}/g, " ")
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/(?<!\\)\$[^$\n]+?(?<!\\)\$/g, " ")
    .replace(/\\(?:cite|citep|citet|citealp|citealt|parencite|textcite|autocite|ref|eqref|label|autoref|cref|Cref)\*?(?:\[[^\]\n]*\])*\{[^{}]*\}/g, " ")
    .replace(/\\[A-Za-z@]+\*?/g, " ")
    .replace(/[{}]/g, "");
}

function stripBoilerplate(text: string): string {
  let out = text;
  for (const pattern of BOILERPLATE_PATTERNS) out = out.replace(pattern, " ");
  return out;
}

/** 单元是否为中文正文（CJK 占比；纯标题 / 英文单元不适用中文风格审查） */
export function isChineseText(text: string): boolean {
  const compact = compactWhitespace(styleProse(text));
  if (compact.length < 8) return false;
  const cjk = (compact.match(/[一-鿿]/g) ?? []).length;
  return cjk / compact.length > CJK_RATIO_MIN;
}

// ---------------------------------------------------------------------------
// 候选扫描（廉价提示；不是判定）
// ---------------------------------------------------------------------------

export interface StyleCandidate {
  sentence: string;
  signals: string[];
  /** 句中含实质限定信号（这类候选更可能应 KEEP） */
  limitationSignal: boolean;
}

export function splitStyleSentences(text: string): string[] {
  return text
    .replace(/\r\n/g, "\n")
    .split(/(?<=[。！？；!?])|\n{2,}/)
    .map((sentence) => sentence.replace(/\s+/g, " ").trim())
    .filter((sentence) => sentence.length >= 6);
}

export function scanStyleCandidates(text: string): StyleCandidate[] {
  const out: StyleCandidate[] = [];
  for (const sentence of splitStyleSentences(text)) {
    const prose = styleProse(sentence);
    const signals: string[] = [];
    const hedges = total(countTerms(prose, HEDGE_TERMS));
    if (hedges >= 2) signals.push(`hedge_stacking×${hedges}`);
    if (BOILERPLATE_PATTERNS.some((pattern) => new RegExp(pattern.source).test(prose))) signals.push("boilerplate");
    if (TEMPLATE_HINTS.some((pattern) => pattern.test(prose))) signals.push("template");
    if (signals.length === 0) continue;
    out.push({ sentence, signals, limitationSignal: total(countTerms(prose, LIMITATION_TERMS)) > 0 });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 锚点定位（空白容忍；唯一才可改写）
// ---------------------------------------------------------------------------

export interface QuoteLocation {
  count: number;
  start: number;
  end: number;
}

/** 在原文中定位引文（字符间允许任意空白——LaTeX 源文常在句中换行）；count=匹配次数 */
export function locateStyleQuote(text: string, quote: string): QuoteLocation {
  const chars = [...compactWhitespace(quote)];
  if (chars.length === 0) return { count: 0, start: -1, end: -1 };
  const pattern = new RegExp(chars.map((char) => char.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("\\s*"), "g");
  let count = 0;
  let start = -1;
  let end = -1;
  for (const match of text.matchAll(pattern)) {
    count += 1;
    if (count === 1) {
      start = match.index ?? -1;
      end = start + match[0].length;
    }
    if (count > 1) break;
  }
  return { count, start, end };
}

// ---------------------------------------------------------------------------
// 审查 prompt + 严格解析
// ---------------------------------------------------------------------------

export function buildUnitStyleAuditPrompt(params: {
  unit: { file: string; heading: string; unitIndex: number; unitCount: number; text: string };
  paperTitle?: string;
  candidates: readonly StyleCandidate[];
}): string {
  const hints = params.candidates.slice(0, STYLE_CANDIDATE_HINTS_MAX);
  return [
    "你是中文学术写作的风格审稿人。任务：对下面这个论文片段（编辑单元）的**全文**做学术写作风格与过度防御性表达审查。",
    "这不是 AI 检测：不要判断作者身份或是否由 AI 生成，不要输出任何「AI 率 / AI 概率」。",
    ...(params.paperTitle !== undefined ? [`论文题目：${params.paperTitle}`] : []),
    `章节：「${params.unit.heading}」（文件 ${params.unit.file}；第 ${params.unit.unitIndex}/${params.unit.unitCount} 单元）`,
    "",
    "优先级（从高到低）：事实与必要披露 → 论断与证据一致 → 论证结构 → 表达力度。表达改进永远不能以牺牲科学信息为代价。",
    "",
    "需要找出的问题（只报能在本单元原文中逐字定位的句子 / 分句）：",
    "- uninformative_hedge：同一论断上堆叠「可能 / 或许 / 在一定程度上 / 潜在 / 似乎」等、且不说明不确定性来源的无信息限定；",
    "- repeated_modesty_apology：无信息的自谦、道歉、预先免责（「仅作粗浅尝试」「难免存在不足，敬请批评指正」「需要指出的是…并不影响」）；",
    "- mechanical_template：机械模板套话、空泛的意义陈述（「具有重要的理论意义和现实价值」「为…提供了有益参考」）；",
    "- empty_summary_transition：没有新增信息的过渡句 / 空泛总结；",
    "- unnatural_wording：明显不自然、翻译腔或重复堆砌的语言组织（只改措辞即可修复的）；",
    "- understated_contribution：文中已有证据支撑的贡献被无端弱化（只能报告，不能由你决定加强）；",
    "- overclaim_risk：反方向的问题——无证据的「显著 / 首次 / SOTA / 普遍适用 / 全面领先 / 导致」等（只报告）。",
    "",
    "必须保留、不得当作「防御性写作」改掉的内容（如在候选中出现，报为 required_limitation 或 negative_result_disclosure 并给 action=KEEP）：",
    "- 影响论断成立、证据解读、适用范围、研究设计或读者正确使用结果的限定：样本量 / 单一数据集 / 特定测试协议 / 未做统计检验 / 未在某条件下验证 / 观察性相关不能推因果；",
    "- 负实验结果、低于基线的结果、失败案例、资源成本、协议或训练数据不可比、待完成实验与真实局限。",
    "- 「初步」「可能」「提示」如果与研究证据强度相符，就应保留，不要为了显得有力改成「显著」「证明」「全面」。",
    "",
    "necessity：UNNECESSARY = 删去 / 改写不丢失任何科学信息；REQUIRED = 承载上述必要信息；UNCERTAIN = 仅凭本单元无法判断（不要臆测证据）。",
    "action：KEEP = 原句应保持；MINIMAL_REWRITE = 只需在原句内部做最小措辞修改即可；AUTHOR_DECISION = 涉及证据强度、是否保留限定、是否需要新实验等科学判断，交作者决定。",
    "",
    "rewrite 纪律（仅 action=MINIMAL_REWRITE 时给出；它将**逐字替换** quote，原句之外一字不改）：",
    "1. 保留全部数字、单位、百分比、引用命令（\\cite{…}）、\\ref / \\label、公式、术语、比较方向（高于 / 低于 / 提升 / 下降）与实验条件；",
    "2. 不新增任何事实、数字、数据集、范围或论证；不新增「显著 / 首次 / SOTA / 证明 / 导致 / 全面 / 普遍 / 所有」等强断言或因果、泛化表述；",
    "3. 对冲堆叠只删冗余：保留一个与证据强度对应的限定（例如「可能」），不要把不确定的结论改成确定；",
    "4. 不得把限制改写成优势（如把「样本有限」改成「样本具有代表性」），不得更换评价指标或比较口径；负结果只能去掉情绪化修饰（如「遗憾的是」），事实保留；",
    "5. 改写不应比原句更长；纯样板自谦 / 套话可以给空串 \"\" 表示整段删除。",
    "",
    "不要报告本来准确、自然的句子；每单元最多 12 条，按重要性排序。没有问题时返回空数组 styleFindings: []（表示已审查且未发现问题）。",
    ...(hints.length > 0
      ? [
          "",
          "以下句子命中了廉价的词表信号——这只是提示，不代表一定有问题；请逐条判断（应保留的给 action=KEEP 并写明理由），也不要只看这些句子，未命中的句子同样需要审查：",
          ...hints.map((candidate, index) => `  [C${index + 1}] ${candidate.sentence.slice(0, 220)}（信号：${candidate.signals.join("、")}${candidate.limitationSignal ? "；含实质限定词" : ""}）`),
        ]
      : []),
    "",
    "只输出一个 JSON 对象（不要 Markdown 围栏）：",
    "{",
    '  "styleFindings": [{"quote": "从本单元原文逐字摘出的句子或分句（≥6 字，不改写）",',
    '    "styleCategory": "uninformative_hedge|repeated_modesty_apology|mechanical_template|empty_summary_transition|unnatural_wording|understated_contribution|required_limitation|negative_result_disclosure|overclaim_risk",',
    '    "reason": "为什么（点名句中的具体词；说明是否承载科学信息）", "necessity": "UNNECESSARY|REQUIRED|UNCERTAIN",',
    '    "constraints": ["该句承载的真实限制 / 条件 / 证据范围（没有则空数组）"],',
    '    "action": "KEEP|MINIMAL_REWRITE|AUTHOR_DECISION", "rewrite": "仅 MINIMAL_REWRITE 时给出"}],',
    '  "unitNote": "本单元风格总体评价（60 字内）"',
    "}",
    "",
    `===== 单元原文（${params.unit.file} · ${params.unit.heading} · ${params.unit.unitIndex}/${params.unit.unitCount}，完整无截断）=====`,
    params.unit.text,
  ].join("\n");
}

export interface ParsedUnitStyleAudit {
  findings: RawStyleFinding[];
  unanchored: Array<{ quote: string; reason: string }>;
  truncated: number;
  unitNote: string;
}

const readEnum = <T extends string>(value: unknown, allowed: readonly T[]): T | undefined =>
  typeof value === "string" && allowed.includes(value.trim() as T) ? (value.trim() as T) : undefined;

/**
 * 严格解析：styleFindings 缺失 / 非数组 = 结构违约（抛出 → 调用方重试，最终 FAILED，绝不当作「已审无问题」）。
 * 单条非法（类别 / necessity / action 越界、quote 过短）丢弃并计入 unanchored（reason 写明），不整单元作废。
 */
export function parseUnitStyleAuditOutput(parsed: Record<string, unknown>, unitText: string, context: string): ParsedUnitStyleAudit {
  const raw = parsed["styleFindings"];
  if (raw === undefined || raw === null) {
    throw new StructuredOutputError(`${context}：缺少 styleFindings 数组（无问题时也必须返回空数组）`, "missing_field", "styleFindings");
  }
  if (!Array.isArray(raw)) {
    throw new StructuredOutputError(`${context}：styleFindings 不是数组`, "wrong_type", "styleFindings");
  }
  const findings: RawStyleFinding[] = [];
  const unanchored: Array<{ quote: string; reason: string }> = [];
  const seen = new Set<string>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const quote = typeof record["quote"] === "string" ? record["quote"].trim() : "";
    const category = readEnum(record["styleCategory"], STYLE_CATEGORIES);
    const necessity = readEnum(record["necessity"], NECESSITY);
    const action = readEnum(record["action"], ACTIONS);
    if (compactWhitespace(quote).length < 6) {
      unanchored.push({ quote: quote.slice(0, 120), reason: "QUOTE_TOO_SHORT" });
      continue;
    }
    if (category === undefined || necessity === undefined || action === undefined) {
      unanchored.push({ quote: quote.slice(0, 120), reason: `INVALID_ENUM（category=${String(record["styleCategory"])} necessity=${String(record["necessity"])} action=${String(record["action"])}）` });
      continue;
    }
    const location = locateStyleQuote(unitText, quote);
    if (location.count === 0) {
      unanchored.push({ quote: quote.slice(0, 120), reason: "QUOTE_NOT_IN_UNIT" });
      continue;
    }
    const key = `${compactWhitespace(quote)}|${category}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      quote,
      styleCategory: category,
      reason: typeof record["reason"] === "string" ? record["reason"].trim().slice(0, 400) : "",
      necessity,
      constraints: Array.isArray(record["constraints"])
        ? (record["constraints"] as unknown[]).filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "").slice(0, 6).map((entry) => entry.trim().slice(0, 200))
        : [],
      action,
      ...(typeof record["rewrite"] === "string" ? { rewrite: record["rewrite"].trim() } : {}),
    });
  }
  const truncated = Math.max(0, findings.length - STYLE_FINDINGS_PER_UNIT_MAX);
  return {
    findings: findings.slice(0, STYLE_FINDINGS_PER_UNIT_MAX),
    unanchored,
    truncated,
    unitNote: typeof parsed["unitNote"] === "string" ? parsed["unitNote"].slice(0, 200) : "",
  };
}

// ---------------------------------------------------------------------------
// 锚内确定性守卫
// ---------------------------------------------------------------------------

function multisetDiff(before: readonly string[], after: readonly string[]): { missing: string[]; added: string[] } {
  const counts = new Map<string, number>();
  for (const item of before) counts.set(item, (counts.get(item) ?? 0) + 1);
  const added: string[] = [];
  for (const item of after) {
    const left = counts.get(item) ?? 0;
    if (left > 0) counts.set(item, left - 1);
    else added.push(item);
  }
  const missing = [...counts.entries()].flatMap(([item, count]) => Array.from({ length: count }, () => item));
  return { missing, added };
}

function termIncreases(before: string, after: string, terms: readonly string[]): string[] {
  const b = countTerms(before, terms);
  const a = countTerms(after, terms);
  return [...a.entries()].filter(([term, count]) => count > (b.get(term) ?? 0)).map(([term]) => term);
}

function termDecreases(before: string, after: string, terms: readonly string[]): string[] {
  const b = countTerms(before, terms);
  const a = countTerms(after, terms);
  return [...b.entries()].filter(([term, count]) => count > (a.get(term) ?? 0)).map(([term]) => term);
}

/**
 * 锚内改写的确定性守卫（fail-closed）。before = 原句，after = 改写（空串 = 删除）。
 * 通过 ≠ 语义等价：只说明没有命中已知越权模式；自动落盘仍需语义复核通过。
 */
export function checkStyleRewrite(before: string, after: string, category: StyleCategory): StyleRewriteCheck {
  const violations: StyleRewriteViolation[] = [];
  const push = (rule: StyleRewriteViolation["rule"], detail: string): void => {
    violations.push({ rule, detail });
  };
  if (compactWhitespace(before) === compactWhitespace(after)) {
    push("unchanged", "改写与原句相同");
    return { ok: false, violations };
  }
  if (after.trim() === "" && !DELETABLE_CATEGORIES.has(category)) {
    push("deletion_not_allowed", `类别 ${category} 不允许整段删除（只有无信息样板 / 套话 / 空泛过渡可删）`);
  }
  const numbers = multisetDiff(extractNumericTokens(before), extractNumericTokens(after));
  if (numbers.missing.length + numbers.added.length > 0) push("numbers", `数值变化：缺 [${numbers.missing.join(", ")}] 增 [${numbers.added.join(", ")}]`);
  const cites = multisetDiff(extractCitationKeys(before), extractCitationKeys(after));
  if (cites.missing.length + cites.added.length > 0) push("citations", `引用 key 变化：缺 [${cites.missing.join(", ")}] 增 [${cites.added.join(", ")}]`);
  const structure = multisetDiff(extractLatexStructure(before), extractLatexStructure(after));
  if (structure.missing.length + structure.added.length > 0) push("latex_structure", `\\ref / \\label / 环境变化：缺 [${structure.missing.join(", ")}] 增 [${structure.added.join(", ")}]`);
  const math = multisetDiff(extractMathSegments(before), extractMathSegments(after));
  if (math.missing.length + math.added.length > 0) push("math", "公式片段变化");

  const proseBefore = styleProse(before);
  const proseAfter = styleProse(after);
  const strong = termIncreases(proseBefore, proseAfter, STRONG_CLAIM_TERMS);
  if (strong.length > 0) push("strong_claim_added", `新增强断言：${strong.join("、")}（风格修订不得加强论断）`);
  const causal = termIncreases(proseBefore, proseAfter, CAUSAL_TERMS);
  if (causal.length > 0) push("causal_added", `新增因果表述：${causal.join("、")}`);
  const general = termIncreases(proseBefore, proseAfter, GENERALIZATION_TERMS);
  if (general.length > 0) push("generalization_added", `新增泛化表述：${general.join("、")}`);
  const directionLost = termDecreases(proseBefore, proseAfter, DIRECTION_TERMS);
  const directionAdded = termIncreases(proseBefore, proseAfter, DIRECTION_TERMS);
  if (directionLost.length + directionAdded.length > 0) push("direction_changed", `比较方向词变化：减 [${directionLost.join(", ")}] 增 [${directionAdded.join(", ")}]`);
  const limitation = termDecreases(proseBefore, proseAfter, LIMITATION_TERMS);
  if (limitation.length > 0) push("limitation_removed", `实质限定减少：${limitation.join("、")}（样本 / 数据集 / 协议 / 验证 / 负结果 / 代价类限定不得由风格修订删除）`);

  // 否定与对冲：先剥离可安全删除的样板（自谦 / 道歉 / 预先免责），其余部分不得减少
  const coreBefore = stripBoilerplate(proseBefore);
  const coreAfter = stripBoilerplate(proseAfter);
  const negBefore = (coreBefore.match(NEGATION_CHARS) ?? []).length;
  const negAfter = (coreAfter.match(NEGATION_CHARS) ?? []).length;
  if (negAfter < negBefore) push("negation_removed", `样板之外的否定词减少（${negBefore} → ${negAfter}）`);
  const hedgeBefore = total(countTerms(coreBefore, HEDGE_TERMS));
  const hedgeAfter = total(countTerms(coreAfter, HEDGE_TERMS));
  if (category === "uninformative_hedge") {
    if (hedgeBefore > 0 && hedgeAfter < 1) push("hedge_removed", "对冲堆叠只允许删冗余：至少保留一个与证据强度对应的限定（删光等于改变论断确定性）");
  } else if (hedgeAfter < hedgeBefore) {
    push("hedge_removed", `类别 ${category} 不允许减少样板之外的限定词（${hedgeBefore} → ${hedgeAfter}）`);
  }

  const beforeLen = compactWhitespace(before).length;
  const afterLen = compactWhitespace(after).length;
  if (afterLen > beforeLen + Math.max(6, Math.round(beforeLen * 0.1))) push("expanded", `改写比原句明显变长（${beforeLen} → ${afterLen} 字）：风格修订不得添加论证`);
  const terminators = (text: string): number => (text.match(/[。！？!?]/g) ?? []).length;
  if (terminators(after) > Math.max(terminators(before), 1)) push("sentence_added", "改写新增了句子");
  return { ok: violations.length === 0, violations };
}

// ---------------------------------------------------------------------------
// 机器分级
// ---------------------------------------------------------------------------

export function styleFindingId(file: string, quote: string, category: StyleCategory): string {
  return `sty-${sha256(`${file}\u0000${compactWhitespace(quote)}\u0000${category}`).slice(0, 16)}`;
}

export function classifyStyleFinding(
  raw: RawStyleFinding,
  context: { unitId: string; file: string; logicalSection: string; heading: string; unitText: string; round: number; unitFingerprint: string; taskId?: string; model?: string; promptSha256?: string },
): StyleFinding {
  const signals = scanStyleCandidates(raw.quote).flatMap((candidate) => candidate.signals);
  let disposition: StyleDisposition;
  let reason: string;
  let precheck: StyleRewriteCheck | undefined;
  if (raw.styleCategory === "required_limitation" || raw.styleCategory === "negative_result_disclosure") {
    disposition = "KEEP";
    reason = "科学必要限定 / 负结果披露：机器侧恒保留（不随模型建议改动）";
  } else if (raw.styleCategory === "overclaim_risk") {
    disposition = "AUTHOR_DECISION";
    reason = "overclaim 风险：涉及论断强度与证据，系统不自动加强或弱化，交作者决定";
  } else if (raw.styleCategory === "understated_contribution") {
    disposition = "AUTHOR_DECISION";
    reason = "贡献表述是否可加强取决于证据：系统不自行强化，交作者核对证据后决定";
  } else if (raw.action === "KEEP") {
    disposition = "KEEP";
    reason = "审稿人判断原句应保持";
  } else if (raw.necessity === "REQUIRED") {
    disposition = "KEEP";
    reason = "审稿人判断该表述承载必要信息（necessity=REQUIRED）";
  } else if (raw.necessity === "UNCERTAIN" || raw.action === "AUTHOR_DECISION") {
    disposition = "AUTHOR_DECISION";
    reason = raw.necessity === "UNCERTAIN" ? "仅凭本单元无法判断该限定是否必要（necessity=UNCERTAIN）" : "审稿人建议交作者决定";
  } else if (!AUTO_REWRITE_CATEGORIES.has(raw.styleCategory)) {
    disposition = "AUTHOR_DECISION";
    reason = `类别 ${raw.styleCategory} 不在自动改写白名单`;
  } else if (raw.rewrite === undefined) {
    disposition = "AUTHOR_DECISION";
    reason = "审稿人建议最小改写但未给出改写文本";
  } else if (locateStyleQuote(context.unitText, raw.quote).count !== 1) {
    disposition = "AUTHOR_DECISION";
    reason = "原句在单元中出现多次：锚点不唯一，不自动改写";
  } else {
    precheck = checkStyleRewrite(raw.quote, raw.rewrite, raw.styleCategory);
    if (precheck.ok) {
      disposition = "AUTO_REWRITE_ELIGIBLE";
      reason = "纯措辞问题，改写通过锚内确定性预检；落盘前仍需语义复核与提交边界守卫";
    } else {
      disposition = "AUTHOR_DECISION";
      reason = `改写未通过确定性预检：${precheck.violations.map((violation) => violation.rule).join(", ")}`;
    }
  }
  return {
    id: styleFindingId(context.file, raw.quote, raw.styleCategory),
    unitId: context.unitId,
    file: context.file,
    logicalSection: context.logicalSection,
    heading: context.heading,
    originalQuote: raw.quote,
    styleCategory: raw.styleCategory,
    candidateReason: raw.reason,
    necessityJudgment: raw.necessity,
    evidenceConstraints: raw.constraints,
    suggestedAction: raw.action,
    ...(raw.rewrite !== undefined ? { proposedRewrite: raw.rewrite } : {}),
    disposition,
    dispositionReason: reason,
    ...(precheck !== undefined ? { precheck } : {}),
    candidateSignals: [...new Set(signals)],
    reviewStatus: "REVIEWED",
    revisionStatus: disposition === "KEEP" ? "KEPT" : disposition === "AUTHOR_DECISION" ? "AUTHOR_DECISION" : "NOT_DISPATCHED",
    lineage: {
      round: context.round,
      unitFingerprint: context.unitFingerprint,
      ...(context.taskId !== undefined ? { taskId: context.taskId } : {}),
      ...(context.model !== undefined ? { model: context.model } : {}),
      ...(context.promptSha256 !== undefined ? { promptSha256: context.promptSha256 } : {}),
    },
  };
}

/** 确定性候选中模型没有逐条裁决（无任何 finding 的 quote 与之重叠）的数量——只是覆盖提示 */
export function countUnaddressedCandidates(candidates: readonly StyleCandidate[], findings: readonly RawStyleFinding[]): number {
  const quotes = findings.map((finding) => compactWhitespace(finding.quote));
  return candidates.slice(0, STYLE_CANDIDATE_HINTS_MAX).filter((candidate) => {
    const sentence = compactWhitespace(candidate.sentence);
    return !quotes.some((quote) => sentence.includes(quote) || quote.includes(sentence));
  }).length;
}

// ---------------------------------------------------------------------------
// 覆盖与计数
// ---------------------------------------------------------------------------

export function summarizeStyleAuditCoverage(units: readonly StyleAuditUnitRecord[], disabledReason?: string): StyleAuditCoverage {
  const eligible = units.filter((unit) => unit.status !== "NOT_APPLICABLE");
  const done = eligible.filter((unit) => unit.status === "COMPLETE" || unit.status === "REUSED");
  const failed = eligible.filter((unit) => unit.status === "FAILED");
  const skipped = eligible.filter((unit) => unit.status === "SKIPPED_BUDGET");
  const reasons = [
    ...(disabledReason !== undefined ? [disabledReason] : []),
    ...failed.map((unit) => `${unit.heading}（${unit.unitId}）：FAILED ${unit.error ?? unit.reason ?? ""}`.trim()),
    ...skipped.map((unit) => `${unit.heading}（${unit.unitId}）：SKIPPED_BUDGET ${unit.reason ?? ""}`.trim()),
  ].slice(0, 20);
  const state: StyleAuditCoverageState = disabledReason !== undefined
    ? "DISABLED"
    : eligible.length === 0
      ? "NOT_APPLICABLE"
      : done.length === eligible.length
        ? "COMPLETE"
        : done.length === 0
          ? "FAILED"
          : "PARTIAL";
  return {
    state,
    eligibleUnits: eligible.length,
    completedUnits: done.filter((unit) => unit.status === "COMPLETE").length,
    reusedUnits: done.filter((unit) => unit.status === "REUSED").length,
    failedUnits: failed.length,
    skippedUnits: skipped.length,
    notApplicableUnits: units.length - eligible.length,
    eligibleChars: eligible.reduce((sum, unit) => sum + unit.chars, 0),
    reviewedChars: done.reduce((sum, unit) => sum + unit.chars, 0),
    reasons,
  };
}

export function countStyleFindings(findings: readonly StyleFinding[], unanchored: number): StyleAuditCounts {
  const byCategory: Partial<Record<StyleCategory, number>> = {};
  const byDisposition: Record<StyleDisposition, number> = { AUTO_REWRITE_ELIGIBLE: 0, KEEP: 0, AUTHOR_DECISION: 0 };
  for (const finding of findings) {
    byCategory[finding.styleCategory] = (byCategory[finding.styleCategory] ?? 0) + 1;
    byDisposition[finding.disposition] += 1;
  }
  return { findings: findings.length, byCategory, byDisposition, unanchored };
}

/** ReviewSummary / Gate / stage 结果消费的精简摘要（不含原句） */
export interface StyleAuditSummary {
  state: StyleAuditCoverageState;
  round: number;
  eligibleUnits: number;
  reviewedUnits: number;
  failedUnits: number;
  skippedUnits: number;
  findings: number;
  autoEligible: number;
  keep: number;
  authorDecision: number;
  reasons: string[];
}

export function styleAuditSummaryOf(report: StyleAuditReport): StyleAuditSummary {
  return {
    state: report.coverage.state,
    round: report.round,
    eligibleUnits: report.coverage.eligibleUnits,
    reviewedUnits: report.coverage.completedUnits + report.coverage.reusedUnits,
    failedUnits: report.coverage.failedUnits,
    skippedUnits: report.coverage.skippedUnits,
    findings: report.counts.findings,
    autoEligible: report.counts.byDisposition.AUTO_REWRITE_ELIGIBLE,
    keep: report.counts.byDisposition.KEEP,
    authorDecision: report.counts.byDisposition.AUTHOR_DECISION,
    reasons: report.coverage.reasons.slice(0, 6),
  };
}

// ---------------------------------------------------------------------------
// 语义复核（只可否决；判断不了 = 不改）
// ---------------------------------------------------------------------------

export interface StyleRewriteCheckItem {
  id: string;
  category: StyleCategory;
  original: string;
  rewrite: string;
  /** 原句所在段落的上下文（只读） */
  context: string;
}

export type StyleSemanticVerdict = "EQUIVALENT" | "CHANGED" | "UNSURE";

export function buildStyleRewriteCheckPrompt(items: readonly StyleRewriteCheckItem[]): string {
  return [
    "你是严格的学术编辑复核员。下面每一条是对论文原句的风格改写（只应删去冗余对冲 / 自谦 / 套话或调整措辞）。",
    "请逐条判断改写是否保持了原句的科学命题。只依据给出的原句、改写与上下文；不要依赖其他材料。",
    "判 CHANGED 的情形（任一即是）：",
    "- 删去或弱化了样本 / 数据集 / 协议 / 适用范围 / 验证状态 / 统计检验 / 不确定性来源 / 负结果 / 代价 / 不可比条件等信息；",
    "- 新增了原句没有的信息（事实、范围、数字、理由、评价）；",
    "- 论断强度改变超出「删除重复限定」：例如把不确定结论改成确定、把相关改成因果、把部分结果说成整体、把限制说成优势；",
    "- 比较对象、方向、指标或口径改变。",
    "判 EQUIVALENT：改写只删除了无信息的重复限定 / 自谦 / 套话或调整了语序措辞，科学命题、证据强度与限制条件完全不变。",
    "无法确定时判 UNSURE（会被保留原文，不算失败）。",
    "",
    "只输出一个 JSON 对象（不要 Markdown 围栏）：",
    '{"checks": [{"id": "条目 id", "verdict": "EQUIVALENT|CHANGED|UNSURE", "reason": "一句话理由"}]}',
    "",
    ...items.flatMap((item) => [
      `--- 条目 ${item.id}（类别 ${item.category}）---`,
      `上下文：${item.context}`,
      `原句：${item.original}`,
      `改写：${item.rewrite === "" ? "（删除该片段）" : item.rewrite}`,
    ]),
  ].join("\n");
}

export function parseStyleRewriteCheckOutput(parsed: Record<string, unknown>, ids: ReadonlySet<string>): Map<string, { verdict: StyleSemanticVerdict; reason: string }> {
  const raw = parsed["checks"];
  if (!Array.isArray(raw)) {
    throw new StructuredOutputError("风格改写语义复核：缺少 checks 数组", raw === undefined ? "missing_field" : "wrong_type", "checks");
  }
  const out = new Map<string, { verdict: StyleSemanticVerdict; reason: string }>();
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const id = typeof record["id"] === "string" ? record["id"].trim() : "";
    const verdict = readEnum(record["verdict"], ["EQUIVALENT", "CHANGED", "UNSURE"] as const);
    if (!ids.has(id) || verdict === undefined || out.has(id)) continue;
    out.set(id, { verdict, reason: typeof record["reason"] === "string" ? record["reason"].trim().slice(0, 240) : "" });
  }
  return out;
}

// ---------------------------------------------------------------------------
// 定点修订记录（reviews/style-revision-r{round}.json）与复评关闭
// ---------------------------------------------------------------------------

export interface StyleRevisionItem {
  findingId: string;
  file: string;
  heading: string;
  styleCategory: StyleCategory;
  before: string;
  after: string;
  status: StyleRevisionStatus;
  /** 未落盘的原因 / 守卫结论（可读、可操作） */
  detail: string;
  guard?: StyleRewriteCheck;
  editContract?: { ok: boolean; contractId?: string; detail?: string };
  semantic?: { verdict: StyleSemanticVerdict | "UNAVAILABLE"; reason: string };
}

export interface StyleRevisionRecord {
  schemaVersion: typeof ACADEMIC_STYLE_REVISION_SCHEMA;
  projectId: string;
  runId: string;
  /** 来源风格审查轮次 */
  reviewRound: number;
  sourceRevision: number;
  revision?: number;
  status: "applied" | "noop" | "stale";
  entry: "final" | "draft";
  items: StyleRevisionItem[];
  limits: { maxAutoRewrites: number; semanticCheckCalls: number };
  calls: { semanticCheck: number; failures: number };
  completedAt: string;
}

/** 上一轮自动修订条目是否已关闭：原句已不在且改写仍在（删除型：原句已不在） */
export function computeStyleRevisionClosure(
  record: StyleRevisionRecord,
  currentText: (file: string) => string | undefined,
  currentFindings: readonly StyleFinding[],
): { sourceRound: number; items: StyleRevisionClosureItem[] } {
  const items: StyleRevisionClosureItem[] = [];
  for (const item of record.items) {
    if (item.status !== "AUTO_FIXED") continue;
    const text = currentText(item.file);
    const originalGone = text !== undefined && locateStyleQuote(text, item.before).count === 0;
    const rewritePresent = item.after.trim() === "" || (text !== undefined && locateStyleQuote(text, item.after).count > 0);
    const afterCompact = compactWhitespace(item.after);
    const reflagged = afterCompact !== "" && currentFindings.some((finding) => {
      const quote = compactWhitespace(finding.originalQuote);
      return finding.file === item.file && finding.disposition !== "KEEP" && (quote.includes(afterCompact) || afterCompact.includes(quote));
    });
    items.push({ findingId: item.findingId, status: originalGone && rewritePresent ? "CLOSED" : "NOT_CLOSED", reflagged });
  }
  return { sourceRound: record.reviewRound, items };
}
