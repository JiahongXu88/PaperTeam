/**
 * Fact Preservation Gate（M5.6 第二层，确定性、无 LLM）。
 *
 * 真实 pair-02 盲评暴露：Citation Preservation 通过的修订仍可能改写实验事实——
 * 候选稿出现表格数值替换（45→28、35.9%→38.7%）、漏检比例与结论方向反转、
 * 部署协议弱化（18 min/621 帧 → 15–20 min）、真实结果被替换成「待回填」占位、
 * 公式项被替换、以及无 Evidence 依据的新增超参数/实现细节。
 *
 * 口径（与 Citation Preservation 同构）：
 *   * 事实源是不可变修订快照（manuscript/revisions/rev-{n}/）：previous = 被审阅
 *     修订的前一个修订，current = 被审阅修订。
 *   * 默认 protected：previous 已存在的实验事实（表格单元格数值 / 正文数字+单位 /
 *     公式内容 / 方向性结论 / 数据集划分 / 硬件型号）不得无依据变化、消失或被占位。
 *   * authorized fact change 只承认结构化依据：
 *       - 计划条目（RevisionPlan planned / 改进计划）文本同时点名旧值与新值；
 *       - 计划点名旧值且 Evidence 文本包含新值；
 *       - needsEvidence 条目命中的章节内允许**删除/弱化论述**（连带其 prose 数字），
 *         但不授权改表格单元格、公式与方向性结论；
 *       - 新增数字要求出现在 Evidence 或计划文本中。
 *     自由文本里的「优化实验描述」不构成任何数字修改的依据。
 *   * 无法可靠判定 → FAIL（宁可 needs_review，不静默放行）。
 *   * 不可比较（无前序修订 / 快照缺失 / 用户恢复历史修订）→ null，以
 *     fact_preservation_not_applicable 中性规则呈现，绝不伪造 PASS。
 *
 * 诚实边界：这是保守的必要条件守卫，不是语义等价证明。方向哨兵只检测确定的
 * 方向反转（负结果→优势 / 基本一致→优势 / 同指标比较方向对调）；检测不到的
 * 语义改写仍依赖 Reviewer 与人审。
 */

import type { RevisionPlan, RevisionPlanItem } from "../review/revisionPlan.js";
import {
  deriveClaimGroundingWeakeningAuthorizations,
  derivePlanWeakeningAuthorizations,
  type WeakeningAuthorizationInput,
} from "../review/weakeningAuthorization.js";
import {
  extractMathSegments,
  extractNumericTokens,
} from "../review/styleInvariants.js";
import { STRONG_MARKERS } from "./claimStrength.js";

export interface FactTexFile {
  /** 相对 manuscript 目录的 POSIX 路径 */
  file: string;
  content: string;
}

export interface FactSnapshot {
  revision: number;
  files: FactTexFile[];
}

export type FactFindingKind =
  | "changed"
  | "removed"
  | "added_unsupported"
  | "directional"
  | "formula"
  | "placeholder";

export interface FactFinding {
  kind: FactFindingKind;
  /** 相对 manuscript 的文件路径 */
  file: string;
  /** 近似章节（离事实最近的 \section / \subsection 标题） */
  section: string;
  /** 修改前短片段（≤ 90 字符） */
  before: string;
  /** 修改后短片段（≤ 90 字符）；纯删除时为空串 */
  after: string;
  /** 机器可读原因（table_cell / prose_number / formula / negative_to_advantage …） */
  reason: string;
  /** 命中的授权（只出现在被放行的变更统计里；违规 finding 恒无授权） */
  authorization?: { basis: string; planItemId: string };
  /**
   * M9.10 Phase 3 事实变化分类（确定性）：
   * A 明确事实变化（数值 / 方向 / 公式 / 占位 / 协议的真实漂移）＝违规；
   * B 格式变化（千分位 / 全角 / 尾零 / 单位大小写等数值等价格式差异）＝非违规；
   * C 语言重写（数字未动、措辞变化）＝非违规；
   * D 引用范围变化（差异只在 \cite 参数）＝非违规（由 Citation Preservation 独立裁决）。
   */
  classification?: FactClassification;
}

/** 事实变化分类（M9.10 Phase 3；见 FactFinding.classification） */
export interface FactClassification {
  category: "A" | "B" | "C" | "D";
  /** 机器可读类型短语（number_changed / number_formatted / language_rewritten / citation_scope_changed / …） */
  type: string;
  severity: "high" | "medium" | "low";
  oldValue?: string;
  newValue?: string;
}

export interface FactPreservationSummary {
  previousRevision: number;
  currentRevision: number;
  changedFacts: FactFinding[];
  removedFacts: FactFinding[];
  addedUnsupportedFacts: FactFinding[];
  directionalChanges: FactFinding[];
  formulaChanges: FactFinding[];
  placeholderRegressions: FactFinding[];
  /**
   * 格式等价 / 语言重写 / 引用范围差异（M9.10 Phase 3 B/C/D 类）：数值未漂移，
   * 不计入违规（ok 不受影响），保留审计轨迹与分类标签
   */
  formatChanges: FactFinding[];
  /** 有计划 / Evidence 依据被放行的变更与删除数（审计口径） */
  allowedChanges: number;
  allowedRemovals: number;
  /** M11.2.1：typed weakening 授权（类别核验通过）放行的弱化数（审计口径） */
  allowedWeakenings: number;
  /** M11.2.1：参与判定的弱化授权条数（来源 = 台账 + 匹配计划派生） */
  weakeningAuthorizationCount: number;
  planId: string | null;
  /** 全部违规数组为空（formatChanges 不参与） */
  ok: boolean;
}

export interface FactPreservationInput {
  previous: FactSnapshot;
  current: FactSnapshot;
  /** sourceRevision == previous.revision 的确定性修订计划（无则 null） */
  plan: RevisionPlan | null;
  /** Existing-Paper 改进计划条目（与 Citation Preservation 同源） */
  improvementPlanItems?: { section: string; action: string; rationale?: string }[];
  /** Evidence 文本（claims + quotes + summaries；新增/替换值的授权依据） */
  evidenceTexts?: string[];
  /**
   * M10.3.1：当前 references.bib 中的既有 key。新增表格行若引用既有 key 且
   * 剥离 key 后不含任何数字（方法论比较行，非实验数值），授权为
   * bib_keyed_row——此类行是引用层的合法对象（key 只能来自既有 bib 或
   * evidence-backed 追加），不是 Fact Preservation 要拦的实验事实。
   */
  bibliographyKeys?: string[];
  /**
   * M11.2.1 typed weakening 授权（Reviewer Finding → Revision Plan → 台账 /
   * 匹配轮次计划现场派生）。每条授权经类型化类别核验后才放行对应 delta：
   * - weaken_claim_strength：只覆盖方向类 finding，且要求文件级不变量成立
   *   （方向词只减不增 / 数值只授权删除 / 强表述 marker 只减不增）；
   * - remove_unsupported_detail：只覆盖授权文本点名的数值删除（swap 配对成
   *   changed，永远不放行）。
   */
  weakeningAuthorizations?: WeakeningAuthorizationInput[];
  /**
   * M11.4 Reliability Closure：patch 候选级启用（与 cumulative gate 同授权
   * 标准）——revision-plan 文本不作为新增值/公式的授权依据（防机器计划
   * 文本自我授权的洗白通道；restoreAuths 恢复方向不受影响）。
   */
  strictPlanTextAuthorization?: boolean;
}

// ---- 提取：表格 ----

interface LatexTable {
  /** 匹配用标识：\label > caption > 序号 */
  key: string;
  label: string | null;
  caption: string;
  /** 行单元格原文（已去命令残留、trim） */
  rows: string[][];
  ordinal: number;
}

const TABLE_ENV_PATTERN = /\\begin\{table\*?\}([\s\S]*?)\\end\{table\*?\}/g;
const TABULAR_PATTERN = /\\begin\{tabular[xX*]*\}{[^}]*}([\s\S]*?)\\end\{tabular[xX*]*\}/;

/** 清理单元格文本：留数字/字母/中文/常用符号，压空白 */
function cleanCell(raw: string): string {
  return raw
    .replace(/\\(?:multicolumn|multirow)\{[^{}]*\}\{[^{}]*\}\{([^{}]*)\}/g, "$1")
    .replace(/\\[A-Za-z@]+\*?/g, " ")
    .replace(/[${}]/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function parseTables(content: string): LatexTable[] {
  const tables: LatexTable[] = [];
  let ordinal = 0;
  for (const envMatch of content.matchAll(TABLE_ENV_PATTERN)) {
    const body = envMatch[1] ?? "";
    const labelMatch = /\\label\{([^}]*)\}/.exec(body);
    const captionMatch = /\\caption\{([^}]*)\}/.exec(body);
    const label = labelMatch !== null ? (labelMatch[1] ?? "").trim() : null;
    const caption = cleanCell(captionMatch !== null ? (captionMatch[1] ?? "") : "");
    const tabularMatch = TABULAR_PATTERN.exec(body);
    const rows: string[][] = [];
    if (tabularMatch !== null) {
      const raw = tabularMatch[1] ?? "";
      for (const rawRow of raw.split(/\\\\(?!\()\s*(?:\[[^\]]*\])?/)) {
        const cells = rawRow.split("&").map((cell) => cleanCell(cell));
        const meaningful = cells.filter((cell) => cell !== "").length;
        if (meaningful === 0 || cells.length < 2) {
          continue; // 表头规则行 / 空行
        }
        rows.push(cells);
      }
    }
    tables.push({
      key: label !== null ? `label:${label}` : caption !== "" ? `caption:${caption}` : `ordinal:${ordinal}`,
      label,
      caption,
      rows,
      ordinal,
    });
    ordinal += 1;
  }
  return tables;
}

// ---- 提取：占位 / 方向 / 协议哨兵 ----

/**
 * M11.4 Reliability Closure（Run 1 实证）：「待作者确认 / 待作者裁决」是未决
 * 作者决策标记写进正文（Planner 把作者决策语义放进 modify 条目时 Writer 的
 * 唯一落笔形态）——真占位符，不属于对冲语豁免（对冲语是「尚待验证」类认识
 * 论限定，不含「作者」主体）。
 */
const PLACEHOLDER_PATTERN = /(待回填|待补充|待验证|待确认|待归档|暂无数据|待实验产出|待作者确认|待作者裁决|待作者决定|TBD|TODO)/g;
/** .test() 用（/g 正则的 test 有 lastIndex 状态，必须与 matchAll 分开） */
const PLACEHOLDER_TEST = /(待回填|待补充|待验证|待确认|待归档|暂无数据|待实验产出|待作者确认|待作者裁决|待作者决定|TBD|TODO)/;

/**
 * M11.4 Attempt 8：副词对冲形态剥离。占位守卫的靶标是**占位标记**（把具体
 * 实验事实替换成「待回填/TODO」——去内容化），不是认识论限定语：「能否…
 * 保持尚待验证」「仍待确认」是评审要求的合法弱化措辞（weakening 授权通道的
 * 正常产物），其中包含的「待验证」子串不构成占位（实证：clean run
 * p-e4f0737aa7e4 rev-3 的两处「尚待验证」对冲语被记为 placeholder_regression，
 * 阻断 Draft 构建）。剥离常见副词引导的对冲形态后再计数/判定。
 */
const HEDGED_PLACEHOLDER_PATTERN = /(?:尚|仍|还|亟|亟待|有望|有待)(?:待验证|待确认|待补充|待回填|待归档|待实验产出)/g;

function stripHedgedPlaceholders(text: string): string {
  return text.replace(HEDGED_PLACEHOLDER_PATTERN, "");
}

function countPlaceholders(content: string): number {
  return [...stripHedgedPlaceholders(content).matchAll(PLACEHOLDER_PATTERN)].length;
}

/** 硬件型号（保守白名单：常见边缘板卡 / GPU / SoC 形态） */
const HARDWARE_PATTERN =
  /(RDK\s?X\d|RK\d{4}|Jetson\s?[A-Za-z]+\d*|Xavier(?:\s?NX)?|Orin(?:\s?NX)?|旭日[^\s，。；]{0,4}|地平线|树莓派|Raspberry\s?Pi\s?\d*|RTX\s?\d{3,4}|GTX\s?\d{3,4}|\b(?:V100|A100|H100|A800|H800)\b|Intel\s?[A-Za-z]+\s?\d{4,}|i[3579]-\d{4,}[A-Za-z]*)/g;

/** 数据集划分表述 */
const OFFICIAL_SPLIT_PATTERN = /(官方|标准|official|原论文|原文)[^\n。；]{0,14}(划分|split)/i;
const CUSTOM_SPLIT_PATTERN = /(自定义|自行|重新|new|custom)[^\n。；]{0,14}(划分|split)/i;

/** 本文方法的优势 / 劣势 / 持平结论词（文件级方向规则） */
const ADVANTAGE_WORDS =
  /(优于|更优|更好|更强|领先|保持优势|优势明显|明显优势|全面超过|胜过|反超)/;
const DISADVANTAGE_WORDS = /(更差|劣于|差于|落后|劣势|不及|不如|恶化|退化|退步|额外增加|仍较敏感)/;
const PARITY_WORDS = /(基本一致|大致相当|差异不大|相差不大|性能相当|接近|相近|相当)/;

/** 指标 token（metric 级方向对调用） */
const METRIC_PATTERN =
  /(IDF1|MOTA|IDS\b|ID Switch|HOTA|DetA|AssA|Frag\b|FPS|fps|mAP|AP\b|RSS|Norm-IDS|latency|Latency|漏检|误报|延迟|内存|温度|精度|身份切换|召回|查准)/;

/** 比较方向对（metric 级：同指标的正反词互换） */
const POSITIVE_DIRECTION = new Set(["高于", "优于", "超过", "提升", "增加", "升至"]);

// ---- 通用工具 ----

function normalizeContent(content: string): string {
  return content.replace(/\r\n/g, "\n");
}

// ---- M9.10 Phase 3：数值归一化（等价判定 / 授权匹配共用） ----

/**
 * 数值 token 的等价归一化（只用于相等性判定与授权匹配，不用于展示）：
 * - 全角数字 / 小数点 / 百分号 → 半角；
 * - 千分位逗号剥离（1,446 ≡ 1446）；
 * - Unicode 减号统一为 ASCII '-'；
 * - 小数尾零剥离（45.90 ≡ 45.9；45. ≡ 45）；
 * - 单位字母小写化（3.31FPS ≡ 3.31fps）。
 * 归一相等 = 数值未漂移（B 类格式变化，非违规）；数值真正变化的判定口径不变。
 */
export function normalizeNumericToken(token: string): string {
  let text = token
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/．/g, ".")
    .replace(/％/g, "%")
    .replace(/，/g, ",");
  let previous = "";
  while (previous !== text) {
    previous = text;
    text = text.replace(/(\d),(\d{3})/g, "$1$2");
  }
  text = text.replace(/[−–—]/g, "-");
  text = text.replace(/(\.\d*?)0+$/, "$1").replace(/\.$/, "");
  return text.toLowerCase();
}

/** 全角数字 / 百分号预归一（提取前处理内容：２０２２ 根本进不了 \d 提取器，会伪装成删除） */
function normalizeFullWidthDigits(content: string): string {
  return content
    .replace(/[０-９]/g, (ch) => String.fromCharCode(ch.charCodeAt(0) - 0xfee0))
    .replace(/％/g, "%");
}

/** 文本内的数字串整体归一（授权匹配用：计划文本 1,446 能命中 token 1446） */
function normalizeNumbersInText(text: string): string {
  return text.replace(/[０-９\d][０-９\d,，．.\d]*[%‰]?/g, (match) => normalizeNumericToken(match));
}

/** 文本中的数字 run（归一后；分类用多重集比较） */
function normalizedNumberRuns(text: string): string[] {
  const half = normalizeFullWidthDigits(text);
  // M10.3.1：与 NUMBER_PATTERN 同口径的词内数字排除（YOLOv11 不产出 "11"，
  // BDD100K 不产出 "00K"）——真实 E2E 表格措辞单元格因模型名内嵌数字被误判
  // 数值变化（table_cell 假违规阻断 Draft）。
  return [...half.matchAll(/(?<![A-Za-z\\\d])[-−]?\d+(?:,\d{3})*(?:\.\d+)?/g)].map((match) =>
    normalizeNumericToken(match[0] ?? ""),
  );
}

/** 差异是否只在 \cite 参数（数字未动时的 D 类：引用范围由 Citation Preservation 裁决） */
function onlyCitationScopeChanged(before: string, after: string): boolean {
  const stripCites = (text: string): string =>
    text.replace(/\\(?:cite|citep|citet|citealp|parencite|textcite|autocite)\*?(?:\[[^\]\n]*\])*\{[^{}]*\}/g, " ");
  return (
    stripCites(before).replace(/\s+/g, "").trim() === stripCites(after).replace(/\s+/g, "").trim()
  );
}

/**
 * 值对分类（M9.10 Phase 3）：A 数值漂移（违规）/ B 数值等价格式差异（非违规）。
 * C（语言重写）/ D（引用范围）由调用方按上下文判定（见 classifyCell / prose 分类）。
 */
function classifyValuePair(oldValue: string, newValue: string): FactClassification {
  const oldNormalized = normalizeNumericToken(oldValue);
  const newNormalized = normalizeNumericToken(newValue);
  if (oldNormalized !== newNormalized) {
    return { category: "A", type: "number_changed", severity: "high", oldValue, newValue };
  }
  return { category: "B", type: "number_formatted", severity: "low", oldValue, newValue };
}

/** 表格单元格分类：数字多重集相等 → D（只在 cite 参数）/ B（数字格式变）/ C（数字未动措辞变） */
function classifyCellChange(before: string, after: string): FactClassification {
  const beforeNumbers = normalizedNumberRuns(before);
  const afterNumbers = normalizedNumberRuns(after);
  const diff = multisetDiff(beforeNumbers, afterNumbers);
  if (beforeNumbers.length !== afterNumbers.length || diff.missing.length > 0 || diff.added.length > 0) {
    return { category: "A", type: "number_changed", severity: "high", oldValue: before, newValue: after };
  }
  if (onlyCitationScopeChanged(before, after)) {
    return { category: "D", type: "citation_scope_changed", severity: "low", oldValue: before, newValue: after };
  }
  // 数值等价：数字原文变了（1,446→1446 / 45.90→45.9）＝B 格式变化；
  // 数字原文未动、只是周边措辞变 ＝C 语言重写（词内数字与 normalizedNumberRuns
  // 同口径排除——YOLOv11 等标识符内嵌数字不算「数字原文」）
  const rawNumberRuns = (text: string): string[] => [
    ...normalizeFullWidthDigits(text).matchAll(/(?<![A-Za-z\\\d])[-−]?\d+(?:,\d{3})*(?:\.\d+)?/g),
  ].map((match) => match[0] ?? "");
  return rawNumberRuns(before).join("|") !== rawNumberRuns(after).join("|")
    ? { category: "B", type: "number_formatted", severity: "low", oldValue: before, newValue: after }
    : { category: "C", type: "language_rewritten", severity: "medium", oldValue: before, newValue: after };
}

/** 各违规桶的固定 A 类分类（direction / formula / placeholder / protocol / added / removed） */
function classAFinding(type: string, oldValue?: string, newValue?: string): FactClassification {
  return {
    category: "A",
    type,
    severity: "high",
    ...(oldValue !== undefined && oldValue !== "" ? { oldValue } : {}),
    ...(newValue !== undefined && newValue !== "" ? { newValue } : {}),
  };
}

function snippet(text: string, maxLength = 90): string {
  const compact = text.replace(/\s+/g, " ").trim();
  return compact.length <= maxLength ? compact : `${compact.slice(0, maxLength - 1)}…`;
}

/**
 * 数字边界安全包含（47 不匹配 147 / 47.5）。
 * M9.10：追加两条归一化通道——原文 / 计划文本里的 1,446、４５.９ 等写法归一后
 * 与 token 匹配；token 带单位后缀（1446条 / 309MB）时再退化用数字核心匹配
 * （授权匹配不因格式写法 miss；miss = 保守违规，修的是 FP）
 */
function mentionsValue(texts: readonly string[], value: string): boolean {
  const escaped = value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const pattern = new RegExp(`(?<![\\w.])${escaped}(?![\\w.])`);
  if (texts.some((text) => pattern.test(text))) {
    return true;
  }
  const normalizedValue = normalizeNumericToken(value);
  if (normalizedValue === "") {
    return false;
  }
  const normalizedEscaped = normalizedValue.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const normalizedPattern = new RegExp(`(?<![\\w.])${normalizedEscaped}(?![\\w.])`);
  if (texts.some((text) => normalizedPattern.test(normalizeNumbersInText(text)))) {
    return true;
  }
  const coreMatch = /^[-+]?\d+(?:\.\d+)?/.exec(normalizedValue);
  if (coreMatch !== null && coreMatch[0] !== normalizedValue) {
    const coreEscaped = coreMatch[0].replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const corePattern = new RegExp(`(?<![\\w.])${coreEscaped}(?![\\w.])`);
    return texts.some((text) => corePattern.test(normalizeNumbersInText(text)));
  }
  return false;
}

/** 离内容位置最近的 \section / \subsection 标题（无则 "(global)"） */
function nearestSection(content: string, index: number): string {
  const before = content.slice(0, index);
  const matches = [...before.matchAll(/\\(?:sub)*section\*?\{([^}]*)\}/g)];
  const last = matches.at(-1);
  return last !== undefined ? (last[1] ?? "").trim() : "(global)";
}

/** 值所在行（报告片段用） */
function lineOf(content: string, index: number): string {
  const start = content.lastIndexOf("\n", index) + 1;
  const end = content.indexOf("\n", index);
  return content.slice(start, end === -1 ? content.length : end);
}

// ---- 授权 ----

interface AuthorizationContext {
  planTexts: { id: string; section: string; text: string }[];
  improvementTexts: { id: string; section: string; text: string }[];
  evidenceTexts: string[];
  bibliographyKeys: string[];
  needsEvidenceItems: RevisionPlanItem[];
  /**
   * M11.2.1：typed weakening 授权（weaken_claim_strength / remove_unsupported_detail）。
   * 来源 = 台账 + 调用方现场派生（匹配轮次计划 + 同轮 claim grounding）。
   */
  weakeningEntries: WeakeningAuthorizationInput[];
  /**
   * M10.3.1：fact_preserve 条目的恢复方向授权。这类条目的 problem 文本包含
   * 「before → after」片段——若进入通用 planTexts 会把「保留违规值」也判为
   * plan_value_correction（漂移被要求恢复它的计划洗白）。因此 fact_preserve
   * 条目整体移出通用授权，只按 factRestore 数值清单授权三个恢复方向：
   * 改回旧值（restoreValues 作 after）/ 重新加回被删旧值 / 删除无依据新增值。
   */
  restoreAuths: {
    id: string;
    section: string;
    restoreValues: string[];
    removeValues: string[];
  }[];
}

function buildAuthorization(
  plan: RevisionPlan | null,
  improvementPlanItems: FactPreservationInput["improvementPlanItems"],
  evidenceTexts: readonly string[],
  bibliographyKeys: readonly string[] = [],
  weakeningAuthorizations: readonly WeakeningAuthorizationInput[] = [],
  options: { strictPlanTextAuthorization?: boolean } = {},
): AuthorizationContext {
  /**
   * M11.2.1：匹配轮次计划（sourceRevision == previous）的条目授权在条目生命
   * 周期内持续有效。旧口径只认 planned——但 gate / validation 在 Writer 执行后
   * 消费，条目届时已 applied / validated / approved，授权系统性失效（M11.2 振荡
   * 的结构性成因之一：计划明确要求的修改被判「无依据」）。与 M10.3.1 对
   * restoreAuths 的生命周期修复同语义；skipped（从未派发）/ rejected（复核
   * 否定）除外。
   */
  const plannedItems = (plan?.items ?? []).filter(
    (item) => item.status !== "skipped" && item.status !== "rejected",
  );
  /**
   * M11.4 Reliability Closure（Run C 实证：p-af86ff877f8f，round-2 修订计划
   * finding 条目的 instruction 文本点名新公式 → pairwise/candidate 层自我授权
   * 放行，cumulative 层按「只认已批准台账 + Evidence」判漂移——两条链路授权
   * 标准不一致 = 洗白通道（机器生成的修订计划文本不得授权它自己要求的新增；
   * fact_preserve 的 restoreAuths 恢复方向授权不受影响）。
   * strictPlanTextAuthorization（patch 候选级启用）= 与 cumulative 同标准。
   */
  const planTexts = options.strictPlanTextAuthorization === true
    ? []
    : plannedItems
      .filter((item) => item.kind !== "fact_preserve")
      .map((item) => ({
        id: item.id,
        section: item.section,
        text: `${item.problem}\n${item.instruction}\n${item.expectedOutcome}`,
      }));
  const improvementTexts = (improvementPlanItems ?? []).map((item, index) => ({
    id: `improvement-plan:${index}`,
    section: item.section,
    text: `${item.action}\n${item.rationale ?? ""}`,
  }));
  const needsEvidenceItems = plannedItems.filter((item) => item.needsEvidence === true);
  // M10.3.1：恢复授权在条目生命周期内持续有效——restore stage 执行后会把条目
  // 推进到 validated，若只认 planned，恢复动作自身的变化会在下一轮 pairwise
  // 失去授权（恢复被误报为漂移）。rejected 条目除外（该方向已被复核否定）。
  const restoreAuths = (plan?.items ?? [])
    .filter(
      (item): item is RevisionPlanItem & { factRestore: { restoreValues?: string[]; removeValues?: string[] } } =>
        item.kind === "fact_preserve" &&
        item.factRestore !== undefined &&
        item.status !== "rejected" &&
        item.status !== "skipped",
    )
    .map((item) => ({
      id: item.id,
      section: item.section,
      restoreValues: item.factRestore.restoreValues ?? [],
      removeValues: item.factRestore.removeValues ?? [],
    }));
  return {
    planTexts,
    improvementTexts,
    evidenceTexts: [...evidenceTexts],
    bibliographyKeys: [...bibliographyKeys],
    needsEvidenceItems,
    weakeningEntries: [...weakeningAuthorizations],
    restoreAuths,
  };
}

/**
 * M10.3.1：表格新增行是否为「引用既有 bib key 的方法论行」（非实验数值行）：
 * - 至少一个单元格包含既有 key（作者年式 key 逐字出现在行内）；
 * - 剥离全部 key 子串后，整行不含数字——数字只允许来自 key 本身（如
 *   Maggiolino2023DeepOCSORT 的年份），实验数值（82.4 / 116 等）仍须
 *   Evidence / 计划授权，此通道不放行。
 */
function isBibKeyedMethodologyRow(row: readonly string[], bibliographyKeys: readonly string[]): boolean {
  if (bibliographyKeys.length === 0) {
    return false;
  }
  const joined = row.join(" | ");
  const hasKey = bibliographyKeys.some((key) => joined.includes(key));
  if (!hasKey) {
    return false;
  }
  const stripped = bibliographyKeys.reduce((text, key) => text.replaceAll(key, ""), joined);
  return !/\d/.test(stripped);
}

/** 计划条目是否显式指向该章节（与 Citation Preservation 同口径的宽松匹配） */
function sectionRefMatchesFile(sectionRef: string, file: string): boolean {
  const ref = sectionRef.trim().replaceAll("\\", "/").toLowerCase();
  if (ref === "" || ref === "(global)" || ref === "(unknown)") {
    return false;
  }
  const path = file.replaceAll("\\", "/").toLowerCase();
  const fileName = path.split("/").pop() ?? path;
  const stem = fileName.replace(/\.tex$/, "");
  return (
    ref === path ||
    ref === fileName ||
    ref === stem ||
    ref.endsWith(`/${path}`) ||
    path.endsWith(ref) ||
    (stem !== "" && ref.includes(stem))
  );
}

/** 值变更授权：计划点名旧值且（点名新值 或 Evidence 含新值） */
function valueChangeAuthorized(
  auth: AuthorizationContext,
  before: string,
  after: string,
  file?: string,
): { basis: string; planItemId: string } | null {
  const entries = [...auth.planTexts, ...auth.improvementTexts];
  for (const entry of entries) {
    if (mentionsValue([entry.text], before)) {
      if (mentionsValue([entry.text], after)) {
        return { basis: "plan_value_correction", planItemId: entry.id };
      }
      if (mentionsValue(auth.evidenceTexts, after)) {
        return { basis: "plan_and_evidence", planItemId: entry.id };
      }
    }
  }
  // M10.3.1 恢复方向：fact_preserve 条目点名「改回 restoreValues 中的旧值」
  if (file !== undefined) {
    for (const restore of auth.restoreAuths) {
      if (!sectionRefMatchesFile(restore.section, file)) {
        continue;
      }
      if (restore.restoreValues.some((value) => mentionsValue([value], after))) {
        return { basis: "planned_fact_restore", planItemId: restore.id };
      }
    }
  }
  return null;
}

/** 值删除授权：needsEvidence 条目命中章节，或计划点名值且明示删除/弱化 */
const REMOVAL_WORDS = /(删除|移除|弱化|去掉|删去|剪除)/;
/**
 * M10.3.1：计划点名的替换表达（「0.5 → 0.4」「改为 / 更正为 / 修正为 / 替换为」）
 * ——旧值出现在替换式左侧即构成删除授权（配对前分流的配套语义；否则计划点名的
 * 新值被新增通道先行放行后，旧值的删除会被误报）。
 */
const REPLACEMENT_WORDS = /(→|->|=>|改为|更正为|修正为|替换为|调整为)/;

function valueRemovalAuthorized(
  auth: AuthorizationContext,
  before: string,
  file: string,
): { basis: string; planItemId: string } | null {
  const covering = auth.needsEvidenceItems.find((item) => sectionRefMatchesFile(item.section, file));
  if (covering !== undefined) {
    return { basis: "planned_evidence_removal", planItemId: covering.id };
  }
  const entries = [...auth.planTexts, ...auth.improvementTexts];
  for (const entry of entries) {
    if (mentionsValue([entry.text], before) && REMOVAL_WORDS.test(entry.text)) {
      return { basis: "planned_value_removal", planItemId: entry.id };
    }
  }
  for (const entry of entries) {
    if (mentionsValue([entry.text], before) && REPLACEMENT_WORDS.test(entry.text)) {
      return { basis: "planned_value_replacement", planItemId: entry.id };
    }
  }
  // M10.3.1 恢复方向：fact_preserve 条目点名「删除无依据新增的违规值」
  for (const restore of auth.restoreAuths) {
    if (!sectionRefMatchesFile(restore.section, file)) {
      continue;
    }
    if (restore.removeValues.some((value) => mentionsValue([value], before))) {
      return { basis: "planned_fact_restore", planItemId: restore.id };
    }
  }
  // M11.2.1：remove_unsupported_detail 授权文本点名该值（claim grounding /
  // finding 原文里的数值——只授权删除方向；替换在配对层进 changed 不放行）
  const weakeningRemoval = findUnsupportedDetailRemoval(auth, before, file);
  if (weakeningRemoval !== null) {
    return { basis: "authorized_unsupported_detail_removal", planItemId: weakeningRemoval };
  }
  return null;
}

/** 值新增授权：Evidence 或计划文本包含该值 */
function valueAdditionAuthorized(
  auth: AuthorizationContext,
  value: string,
  file?: string,
): { basis: string; planItemId: string } | null {
  if (mentionsValue(auth.evidenceTexts, value)) {
    return { basis: "evidence", planItemId: "(evidence)" };
  }
  const entries = [...auth.planTexts, ...auth.improvementTexts];
  for (const entry of entries) {
    if (mentionsValue([entry.text], value)) {
      return { basis: "plan_value", planItemId: entry.id };
    }
  }
  // M10.3.1 恢复方向：fact_preserve 条目点名「重新加回被删的原值」
  if (file !== undefined) {
    for (const restore of auth.restoreAuths) {
      if (!sectionRefMatchesFile(restore.section, file)) {
        continue;
      }
      if (restore.restoreValues.some((candidate) => mentionsValue([candidate], value))) {
        return { basis: "planned_fact_restore", planItemId: restore.id };
      }
    }
  }
  return null;
}

/** 公式变更授权：计划明确提及公式修正 */
const FORMULA_WORDS = /(公式|equation|数学表达|损失函数|loss)/i;
/** 计划文本中「公式意图」的表述（新增小节要给出某式） */
const FORMULA_INTENT_WORDS = /(公式|equation|数学表达|损失函数|loss|更新式|表达式|定义式)/i;

/**
 * 公式骨架归一（授权匹配用）：剥空白 / 命令转义 / 乘点，只留字母数字下标与
 * 关系符——「R_t = Q_t \cdot C_t,」与计划文本「R_t=Q_t·C_t」归一到同一骨架。
 */
function formulaSkeleton(segment: string): string {
  return segment
    .replace(/\\cdot|\\times|[·∙×]/g, "")
    .replace(/\\[A-Za-z@]+/g, "")
    .replace(/[\s{}]/g, "")
    .replace(/[,;。]+$/g, "")
    .toLowerCase();
}

/**
 * 希腊字母命令 → Unicode 规范（符号匹配用）：`\eta_t` 与台账文本的 `η_t`
 * 归一到同一写法。
 */
function normalizeGreekSymbols(text: string): string {
  const map: Record<string, string> = {
    alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε",
    zeta: "ζ", eta: "η", theta: "θ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ",
    pi: "π", rho: "ρ", sigma: "σ", tau: "τ", phi: "φ", varphi: "φ", chi: "χ",
    psi: "ψ", omega: "ω",
  };
  // \mathbf{e} / \mathbf{\eta} 等字体包裹先剥（符号 e_t / η_t 要可直接提取）
  let unwrapped = text.replace(/\\math(?:bf|rm|it|cal|sf|tt)?\{([^{}]*)\}/g, "$1");
  for (let depth = 0; depth < 3 && /\\math[a-z]*\{/.test(unwrapped); depth += 1) {
    unwrapped = unwrapped.replace(/\\math(?:bf|rm|it|cal|sf|tt)?\{([^{}]*)\}/g, "$1");
  }
  // (?![A-Za-z]) 而非 \b：\eta_t 的命令名后跟下标下划线，\b 在字母↔下划线间
  // 不成立（两者都是 \w），希腊替换从未触发（真实 E2E 排查实录）
  return unwrapped.replace(/\\([a-z]+)(?![A-Za-z])/g, (whole, name: string) => map[name] ?? whole);
}

/**
 * M10.3.1：公式新增授权的确定性扩展——已批准计划/台账逐字给出公式（骨架
 * 包含），或给出「公式意图 + 公式主符号」（如『零参数门控 EMA 更新式 …
 * η_t=0.05+0.20·R_t』授权以其符号 η_t/R_t 定义的展开式）。真实 E2E：rgate
 * 方法小节的三个新公式由已批准改进计划明确规划，旧关键词口径漏授权。
 */
function formulaAdditionAuthorized(
  auth: AuthorizationContext,
  segment: string,
): { basis: string; planItemId: string } | null {
  const entries = [...auth.planTexts, ...auth.improvementTexts];
  const skeleton = formulaSkeleton(segment);
  if (skeleton.length >= 6) {
    for (const entry of entries) {
      if (formulaSkeleton(entry.text).includes(skeleton)) {
        return { basis: "planned_formula_change", planItemId: entry.id };
      }
    }
  }
  // 公式主符号（带下标的量，如 η_t / R_t / e_t）+ 计划文本的公式意图表述
  const normalized = normalizeGreekSymbols(segment);
  const symbols = [...normalized.matchAll(/([A-Za-zα-ωΑ-Ω])_([A-Za-z0-9]+)/g)].map(
    (match) => `${match[1]}_${match[2]}`,
  );
  if (symbols.length > 0) {
    for (const entry of entries) {
      const entryText = normalizeGreekSymbols(entry.text);
      if (FORMULA_INTENT_WORDS.test(entryText) && symbols.some((symbol) => entryText.includes(symbol))) {
        return { basis: "planned_formula_change", planItemId: entry.id };
      }
    }
  }
  return null;
}

function formulaChangeAuthorized(auth: AuthorizationContext): { basis: string; planItemId: string } | null {
  const entries = [...auth.planTexts, ...auth.improvementTexts];
  for (const entry of entries) {
    if (FORMULA_WORDS.test(entry.text)) {
      return { basis: "planned_formula_change", planItemId: entry.id };
    }
  }
  return null;
}

/**
 * M11.4 Attempt 8：一致的公式符号重命名（alpha-rename）配对。
 *
 * 真实缺陷形态（clean run p-db07e4273daa / w-e3ff6274abc5）：评审在 round 2
 * 指出基线符号冲突——`w_t^k = 1/(s_t^k+ε)` 的平滑权重 `w_t^k` 与同小节
 * `s_t^k = sqrt(w_t^k h_t^k)` 的边界框宽度 `w_t^k` 同名不同义——修订计划指示
 * 改用 `\omega_t^k`；Writer 一致替换后，公式多重集 diff 把「旧公式消失 + 新
 * 公式出现」记为 formula_removed_or_changed / formula_added 各 2 项，累计
 * 事实保持判 4 项未授权漂移 → Revision Task 必然 FAIL。结构不变、跨全部
 * 公式一致且单射的符号替换是**表示层变更**（alpha-rename 不改变任何陈述
 * 事实——这正是绑定换名的定义），归入 formatChanges 审计，不进违规桶。
 *
 * 判定（确定性，无 LLM）：
 * - missing × added 两两配对：whitespace token 序列长度相等，除被映射的
 *   符号 token 外逐 token 相同；
 * - 被映射 token 两侧都必须是「短标识符」：无数字（数值是事实）、长度有界、
 *   基名为单字母或希腊命令（多字母词 MOTA/IDF1 与结构命令 \frac/\sqrt 不
 *   参与映射——防止语义换名被误配）；
 * - 映射跨全部配对一致（同旧 token 恒映同新 token）且单射（不同旧 token
 *   不映到同一新 token）；不满足者留在违规桶，由授权通道裁决。
 */
const GREEK_COMMAND_NAMES = new Set([
  "alpha", "beta", "gamma", "delta", "epsilon", "varepsilon", "zeta", "eta", "theta",
  "vartheta", "iota", "kappa", "lambda", "mu", "nu", "xi", "pi", "varpi", "rho",
  "varrho", "sigma", "varsigma", "tau", "upsilon", "phi", "varphi", "chi", "psi",
  "omega", "Gamma", "Delta", "Theta", "Lambda", "Xi", "Pi", "Sigma", "Upsilon",
  "Phi", "Psi", "Omega",
]);

/** 符号 token 结构：`\omega_t^k` / `w_t^k` / `T_k`（基名 + 上下标组） */
const SYMBOL_TOKEN_PARTS = /^(\\?)([a-zA-Z]+)((?:[_^](?:\{[^0-9{}]*\}|[a-zA-Z]+))*)$/;

interface SymbolTokenParts {
  command: string;
  base: string;
  groups: string;
}

/**
 * 符号 token 解析；null = 非符号形态（结构命令 / 多字母词 / 含数字 / 超长）。
 * 基名只允许单字母或（带反斜杠的）希腊命令——`L_{objness}` 这类「字母基 +
 * 词下标」可解析，但其**下标组**承载语义（损失项名），见 renameablePair。
 */
function symbolTokenParts(token: string): SymbolTokenParts | null {
  if (token.length > 16 || /\d/.test(token)) {
    return null;
  }
  const match = SYMBOL_TOKEN_PARTS.exec(token);
  if (match === null) {
    return null;
  }
  const command = match[1] ?? "";
  const base = match[2] ?? "";
  const singleLetterBase = command === "" && base.length === 1;
  const greekCommandBase = command === "\\" && GREEK_COMMAND_NAMES.has(base);
  if (!singleLetterBase && !greekCommandBase) {
    return null;
  }
  return { command, base, groups: match[3] ?? "" };
}

/**
 * 合法换名对：两侧都可解析为符号 token，且**只有基名变化**——上下标组必须
 * 逐字相同（`w_t^k → \omega_t^k` 的 `_t^k` 不动；`L_{objness} → L_{DFL}`
 * 的下标组变化是损失项替换 = 事实变化，不放行）。
 */
function renameablePair(from: string, to: string): boolean {
  const fromParts = symbolTokenParts(from);
  const toParts = symbolTokenParts(to);
  if (fromParts === null || toParts === null) {
    return false;
  }
  return fromParts.groups === toParts.groups;
}

/** 单对公式的换名映射；null = 不可配对（结构不同 / 非法 token / 与已确立映射冲突） */
function renameMappingBetween(
  before: string,
  after: string,
  established: ReadonlyMap<string, string>,
  establishedInverse: ReadonlyMap<string, string>,
): Array<[string, string]> | null {
  const a = before.split(" ");
  const b = after.split(" ");
  if (a.length !== b.length) {
    return null;
  }
  const local: Array<[string, string]> = [];
  const localInverse = new Map<string, string>();
  for (let i = 0; i < a.length; i += 1) {
    const from = a[i]!;
    const to = b[i]!;
    if (from === to) {
      continue;
    }
    if (!renameablePair(from, to)) {
      return null;
    }
    if (localInverse.has(to) && localInverse.get(to) !== from) {
      return null; // 单射：不同旧 token 不得映到同一新 token
    }
    localInverse.set(to, from);
    const existing = local.findIndex(([f]) => f === from);
    if (existing >= 0) {
      if (local[existing]![1] !== to) {
        return null;
      }
      continue;
    }
    local.push([from, to]);
  }
  if (local.length === 0) {
    return null;
  }
  for (const [from, to] of local) {
    if (established.has(from) && established.get(from) !== to) {
      return null;
    }
    if (establishedInverse.has(to) && establishedInverse.get(to) !== from) {
      return null;
    }
  }
  return local;
}

/** 公式多重集 diff 的 alpha-rename 配对（贪心；结构不匹配者自然落选） */
function pairNotationRenames(
  missing: readonly string[],
  added: readonly string[],
): { pairs: Array<{ before: string; after: string }>; mapping: Map<string, string> } {
  const mapping = new Map<string, string>();
  const inverse = new Map<string, string>();
  const usedAdded = new Set<number>();
  const pairs: Array<{ before: string; after: string }> = [];
  for (const before of missing) {
    for (let j = 0; j < added.length; j += 1) {
      if (usedAdded.has(j)) {
        continue;
      }
      const local = renameMappingBetween(before, added[j]!, mapping, inverse);
      if (local === null) {
        continue;
      }
      for (const [from, to] of local) {
        mapping.set(from, to);
        inverse.set(to, from);
      }
      usedAdded.add(j);
      pairs.push({ before, after: added[j]! });
      break;
    }
  }
  return { pairs, mapping };
}

/**
 * 方向结论变更授权：计划**显式**要求修正结论方向（M11.2.1 收紧——旧口径的
 * 「结论|表述|比较」过宽，计划条目生命周期修复后会让任何提及这些常用词的
 * finding 变成整文件方向变更的 blanket 授权。方向语义的合法通道改为 typed
 * weakening（weaken_claim_strength，类别核验），显式方向修正仍走本通道但
 * 须点名修正语义）。
 */
const DIRECTION_AUTH_WORDS =
  /(方向(?:反转|相反|写反|颠倒|弄反)|结论方向|方向性结论有误|应为[^。；]{0,12}(?:高于|低于|优于|劣于|超过|不及)|更正为[^。；]{0,12}(?:高于|低于|优于|劣于))/;

function directionChangeAuthorized(
  auth: AuthorizationContext,
  file: string,
): { basis: string; planItemId: string } | null {
  const entries = [...auth.planTexts, ...auth.improvementTexts];
  for (const entry of entries) {
    if (DIRECTION_AUTH_WORDS.test(entry.text) && sectionRefMatchesFile(entry.section, file)) {
      return { basis: "planned_direction_change", planItemId: entry.id };
    }
  }
  return null;
}

// ---- M11.2.1：typed weakening 的类别核验（确定性） ----

/**
 * 弱化类别核验的方向词表（判定词全表 + 常见比较 / 程度词），按极性分组。
 * 核验口径 = 文件级**极性**多重集「只减不增」：
 * - 合法弱化（重排 / 拆句 / 删强断言词 / 同极性 paraphrase「提升→提高」）
 *   不增加任何极性方向词的出现次数；
 * - 真实方向反转必然引入 previous 没有的反极性方向词（提升→下降：负向 +1）。
 */
const WEAKENING_DIRECTION_VOCAB: ReadonlyArray<{ word: string; polarity: "positive" | "negative" }> = [
  { word: "高于", polarity: "positive" },
  { word: "低于", polarity: "negative" },
  { word: "优于", polarity: "positive" },
  { word: "劣于", polarity: "negative" },
  { word: "超过", polarity: "positive" },
  { word: "不及", polarity: "negative" },
  { word: "提升", polarity: "positive" },
  { word: "下降", polarity: "negative" },
  { word: "增加", polarity: "positive" },
  { word: "减少", polarity: "negative" },
  { word: "升至", polarity: "positive" },
  { word: "降至", polarity: "negative" },
  { word: "提高", polarity: "positive" },
  { word: "降低", polarity: "negative" },
  { word: "增大", polarity: "positive" },
  { word: "减小", polarity: "negative" },
  { word: "加快", polarity: "positive" },
  { word: "放慢", polarity: "negative" },
  { word: "超越", polarity: "positive" },
  { word: "胜过", polarity: "positive" },
  { word: "领先", polarity: "positive" },
  { word: "落后", polarity: "negative" },
  { word: "反超", polarity: "positive" },
  { word: "恶化", polarity: "negative" },
  { word: "退化", polarity: "negative" },
  { word: "改善", polarity: "positive" },
  { word: "变差", polarity: "negative" },
  { word: "变好", polarity: "positive" },
  { word: "好转", polarity: "positive" },
  { word: "变快", polarity: "positive" },
  { word: "变慢", polarity: "negative" },
];

function directionPolarityCounts(content: string): { positive: number; negative: number } {
  let positive = 0;
  let negative = 0;
  for (const { word, polarity } of WEAKENING_DIRECTION_VOCAB) {
    let count = 0;
    let at = content.indexOf(word);
    while (at !== -1) {
      count += 1;
      at = content.indexOf(word, at + word.length);
    }
    if (polarity === "positive") {
      positive += count;
    } else {
      negative += count;
    }
  }
  return { positive, negative };
}

/** 强表述 marker 出现次数（claimStrength 的 STRONG_MARKERS；evidence 文本无关的文件级计数） */
function strongMarkerCounts(content: string): Map<string, number> {
  const lower = content.toLowerCase();
  const counts = new Map<string, number>();
  for (const marker of STRONG_MARKERS) {
    let count = 0;
    let at = lower.indexOf(marker);
    while (at !== -1) {
      count += 1;
      at = lower.indexOf(marker, at + marker.length);
    }
    if (count > 0) {
      counts.set(marker, count);
    }
  }
  return counts;
}

/** 弱化类别核验结果（covered = 可按 weaken_claim_strength 放行） */
interface WeakeningClassCheck {
  covered: boolean;
  /** 首个不成立的不变量（covered=false 时非空；审计 / 报告用） */
  violation: string;
  /** 强表述 marker 净新增（epistemic_strengthening 检测复用） */
  strongMarkerAdds: string[];
}

/**
 * weaken_claim_strength 的类别核验（文件级；纯函数）：
 * 1. 方向词**按极性**只减不增（真实方向反转引入反极性词；同极性 paraphrase
 *    是合法弱化）。方向词增删的位置语义（哪个 claim 的方向）不做句子级
 *    追溯——那是被证伪的启发式（M11.2 振荡根源），文件级极性守恒是更弱的
 *    但鲁棒的不变量；
 * 2. 强表述 marker 只减不增（「可能 → 已经证明」是授权方向的逆向）。
 * 数值通道与方向通道正交：数值的新增 / 删除 / 替换由 prose-number 与表格
 * 通道按自己的授权裁决（remove_unsupported_detail 只授权删除方向），本核验
 * 不重复判定——任一通道的违规都会令 summary.ok=false，检测能力不降低。
 *
 * 诚实边界：同文件两处反极性互换（A 正→负、B 负→正，极性计数不变）检测
 * 不到——依赖每轮 claim grounding 复核与人工 HITL（与模块头声明一致）。
 */
function weakeningClassCheck(previous: string, current: string): WeakeningClassCheck {
  // 2. 强表述 marker（先算：任一分支都可能要引用 strongMarkerAdds）
  const previousStrong = strongMarkerCounts(previous);
  const currentStrong = strongMarkerCounts(current);
  const strongMarkerAdds: string[] = [];
  for (const [marker, count] of currentStrong) {
    if (count > (previousStrong.get(marker) ?? 0)) {
      strongMarkerAdds.push(marker);
    }
  }
  // 1. 方向词极性多重集
  const previousDirections = directionPolarityCounts(previous);
  const currentDirections = directionPolarityCounts(current);
  if (currentDirections.positive > previousDirections.positive) {
    return { covered: false, violation: "新增正向方向词", strongMarkerAdds };
  }
  if (currentDirections.negative > previousDirections.negative) {
    return { covered: false, violation: "新增反向方向词", strongMarkerAdds };
  }
  if (strongMarkerAdds.length > 0) {
    return { covered: false, violation: `新增强表述「${strongMarkerAdds[0] ?? ""}」`, strongMarkerAdds };
  }
  return { covered: true, violation: "", strongMarkerAdds };
}

/**
 * 文件是否有任一 weaken_claim_strength 授权覆盖（section 宽松匹配，
 * 与派发侧同口径）。
 */
function weakeningCoversFile(auth: AuthorizationContext, file: string): boolean {
  return auth.weakeningEntries.some(
    (entry) => entry.kind === "weaken_claim_strength" && sectionRefMatchesFile(entry.section, file),
  );
}

/**
 * remove_unsupported_detail / remove_claim 授权点名该值时返回其 itemId
 * （文件匹配 + 授权文本含值）。M11.2.3：remove_claim 与删细节同一消费路径
 * ——都只放行「删除」方向；替换进 changed 桶、加强被弱化类别核验拦截。
 */
function findUnsupportedDetailRemoval(
  auth: AuthorizationContext,
  value: string,
  file: string,
): string | null {
  for (const entry of auth.weakeningEntries) {
    if (
      (entry.kind === "remove_unsupported_detail" || entry.kind === "remove_claim") &&
      sectionRefMatchesFile(entry.section, file) &&
      mentionsValue([entry.targetSpan], value)
    ) {
      return entry.itemId;
    }
  }
  return null;
}

// ---- 数字事实（prose；排除表格与数学环境） ----

function stripTablesAndMath(content: string): string {
  let text = normalizeContent(content);
  text = text.replace(TABLE_ENV_PATTERN, " ");
  text = text.replace(TABULAR_PATTERN, " ");
  // M10.3.1（恢复 rerun 实录）：`\\[4pt]` / `\\[8pt]`（换行+间距选项）不是显示
  // 数学——先剥为空格，显示数学 `\[...\]` 加负向后行（与 styleInvariants 的
  // extractMathSegments 修复同口径；此前只修了公式通道，prose 通道漏了——作者块
  // `\\[4pt]` 会吞掉后续内容直到远处的 `\]`，其 "4" 进入多重集被任意配对）。
  text = text.replace(/\\\[\d+(?:\.\d+)?[a-zA-Z]{1,3}\]/g, " ");
  text = text.replace(/(?<!\\)\\\[([\s\S]*?)\\\]/g, " ").replace(/\\\(([\s\S]*?)\\\)/g, " ");
  text = text.replace(/\$\$[\s\S]*?\$\$/g, " ");
  // M10.3.1：内联数学中的赋值（$N_{\max}=20$ / $\lambda=0.5$）——数值没有
  // 消失，只是从 prose 迁入数学表达（真实 E2E：rev1「模板数超过 20」→ rev3
  // 「$N_{\max}=20$」被判成 20 被删 + 任意配对假违规）。赋值右值保留进 prose
  // 多重集；其余内联数学照旧剥离（公式片段由 extractMathSegments 独立比较）。
  text = text.replace(/(?<!\\)\$[^$\n]+?(?<!\\)\$/g, (span) => {
    if (!/=/u.test(span) || !/\d/.test(span)) {
      return " ";
    }
    const assignment = /(?:=|＝|\\eq)\s*([-−]?\d+(?:\.\d+)?)/.exec(span);
    return assignment !== null ? ` ${assignment[1] ?? ""} ` : " ";
  });
  return text;
}

/**
 * prose 数字提取前的保守归一（M10.3 整文件修订假阳性消除；只影响提取、
 * 不改变展示 / 表格 / 公式口径）：
 * - 数字 run 内部断行：`BDD1\n00K` 这类整文件重排把一个数字串拆到两行，
 *   是排版噪声而非事实变化——仅当断行两侧都是数字时连接（词边界断行
 *   `41.8\nafter` 保持原样，LaTeX 中换行即空格，语义不同）；
 * - 前导宏管道：`\newcommand{\keywords}[1]{...}` / `\def\x{...}` 的参数
 *   个数与默认值是 LaTeX 管道，不是论文事实——从 prose 提取中剥离。
 * 两条都只可能减少违规计数（保守方向）；真实数值漂移不受影响。
 */
function normalizeForProseExtraction(text: string): string {
  return text
    // M10.3.1（恢复 rerun 实录）：排版长度宏（\vspace{1.5ex} / \hspace{2pt}）
    // 是版面参数而非论文事实——"1.5ex" 会以数字+单位形态进入事实型新增判定。
    // 整段剥离（只减假阳性）。
    .replace(/\\(?:vspace|hspace|setlength|addvspace|vskip|hskip|baselineskip)\*?\s*(?:\{[^{}]*\}|[-−]?\d+(?:\.\d+)?[a-zA-Z]{1,3})/g, " ")
    // M10.3.1（恢复 rerun 实录）：千分位逗号后断行（"61,\n047"）——逗号挡住了
    // 数字-数字断行连接，"047" 被当独立 token 与无关新增值任意配对成假 changed。
    // 仅当断行后是恰好 3 位数字（千分位形态）时连接。同理处理 LaTeX 细空格
    // 千分位（61\,047）——\, 同样挡不住词内提取，归一为逗号千分位形态。
    .replace(/(\d)\\,(?=\d{3}(?![\d,\\]))/g, "$1,")
    .replace(/(\d),[ \t]*\r?\n[ \t]*(?=\d{3}(?![\d,]))/g, "$1,")
    .replace(/(\d)[ \t]*\r?\n[ \t]*(?=\d)/g, "$1")
    .replace(/\\(?:re?newcommand|providecommand|def|DeclareMathOperator)\s*\*?\s*(?:\[[^\]]*\]\s*)?\{[^{}]*\}\s*(?:\[\d\])?\s*\{(?:[^{}]|\{[^{}]*\})*\}/g, " ")
    // M10.3.1：交叉引用编号（式(12) / 式(17)--(19) / 表 7 / 图 3 / Eq. 5 /
    // Table 2 等）是文档结构管道而非论文事实——真实 E2E 中新增方法小节的
    // 公式引用「式(12)」被当作数值新增，与无关删除值配对成假 changed 违规。
    // 只剥编号本身，引用词保留（保守方向：只减少假阳性）。
    .replace(
      /((?:式|公式|表|图|章节|附录|算法)|(?:(?:Eqs?|Equations?|Figs?|Figures?|Tables?|Tabs?|Secs?|Sections?|Chapters?|Appendix|Appendices|Algorithms?)\.?)\s?)\(?\d+(?:\s*(?:,|and|&|to|~|[–—-]+)\s*\d+)*\)?/g,
      "$1",
    );
}

function proseNumberTokens(content: string): string[] {
  // M9.10：全角数字预归一（２０２２ 进不了 \d 提取器，会伪装成删除）。
  // token 保持原文写法：千分位 / 尾零 / 单位大小写差异会进入多重集差异，
  // 由 classifyValuePair 判为 B 类格式变化（formatChanges 审计，不计违规）——
  // 提取层直接归一会把这类变化完全吞掉，失去审计轨迹。
  // M10.3：整文件重排的行内断行 / 前导宏管道先经保守归一（见函数注释）
  return extractNumericTokens(
    normalizeForProseExtraction(normalizeFullWidthDigits(stripTablesAndMath(content))),
  );
}

function indexOfToken(content: string, token: string): number {
  // M9.10：token 已归一（无千分位逗号）；定位原文时允许数字间出现分隔符。
  // M10.3.1：分隔符扩展容忍 LaTeX 转义（原文 35.9\% 对 token 35.9%；旧模式
  // 不含反斜杠 → 定位失败 → 恢复 rerun 的 swap 配对拿不到行位置）
  const escaped = token
    .split("")
    .map((ch) => ch.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"))
    .join("(?:[,，\\\\\\s]?\\s*)?");
  const pattern = new RegExp(`(?<![\\w.])${escaped}`);
  const match = pattern.exec(content);
  return match !== null ? match.index : -1;
}

/** 多重集差异（值语义：missing = previous 多出的，added = current 多出的） */
function multisetDiff(
  before: readonly string[],
  after: readonly string[],
): { missing: string[]; added: string[] } {
  const counts = new Map<string, number>();
  for (const item of before) {
    counts.set(item, (counts.get(item) ?? 0) + 1);
  }
  for (const item of after) {
    const count = counts.get(item) ?? 0;
    if (count > 0) {
      counts.set(item, count - 1);
    } else {
      counts.set(item, -1);
    }
  }
  const missing: string[] = [];
  const added: string[] = [];
  for (const [item, count] of counts) {
    for (let i = 0; i < count; i += 1) {
      missing.push(item);
    }
    for (let i = 0; i < -count; i += 1) {
      added.push(item);
    }
  }
  return { missing, added };
}

/** 事实型新增数字（过滤裸整数噪音）：百分比 / 带单位 / 阈值式 */
function isFactLikeAddition(token: string): boolean {
  if (/%|‰/.test(token)) {
    return true;
  }
  if (/[A-Za-zμ]{1,6}$/.test(token.replace(/[.,]/g, "")) && /\d/.test(token)) {
    return true;
  }
  if (/(帧|次|维|倍|个|张|轮|epoch|batch|位|类|组|年|月|天|小时|分钟|秒)$/.test(token)) {
    return true;
  }
  return false;
}

/** 超参数 / 阈值赋值（name=value / name≥value；prose 上，数学环境内由公式段覆盖） */
const ASSIGNMENT_PATTERN = /([A-Za-zλγαβτμ][A-Za-z\d_]{0,9})\s*[=＝≥≤]\s*(\d+(?:\.\d+)?)/g;
/** 量纲后缀（71维 / 64路 / 8头 等；NUMBER_PATTERN 单位表之外的量纲词） */
const DIMENSION_PATTERN = /(?<![\w.])(\d+(?:\.\d+)?)\s*(维|路|通道|头|层)/g;

// ---- 句子级方向提取 ----

interface ClaimSentence {
  text: string;
  index: number;
  metric: string | null;
  ownMethod: boolean;
  direction: string | null; // 高于/低于/优于/劣于/升至/降至…
  polarity: "advantage" | "disadvantage" | "parity" | null;
}

function claimSentences(content: string): ClaimSentence[] {
  const text = normalizeContent(content);
  const sentences: ClaimSentence[] = [];
  let start = 0;
  const push = (end: number): void => {
    const raw = text.slice(start, end);
    if (raw.trim() !== "") {
      const metricMatch = METRIC_PATTERN.exec(raw);
      const directionMatch = [...raw.matchAll(/高于|低于|优于|劣于|超过|不及|提升|下降|增加|减少|升至|降至/g)].at(-1);
      const polarity: ClaimSentence["polarity"] = ADVANTAGE_WORDS.test(raw)
        ? "advantage"
        : DISADVANTAGE_WORDS.test(raw)
          ? "disadvantage"
          : PARITY_WORDS.test(raw)
            ? "parity"
            : null;
      if (metricMatch !== null || polarity !== null || directionMatch !== undefined) {
        sentences.push({
          text: raw.trim(),
          index: start,
          metric: metricMatch !== null ? metricMatch[0] : null,
          ownMethod: /(本文|本方法|该方法|本研究所?提)/.test(raw),
          direction: directionMatch !== undefined ? directionMatch[0] : null,
          polarity,
        });
      }
    }
    start = end + 1;
  };
  for (let index = 0; index < text.length; index += 1) {
    const ch = text[index];
    if (ch === "。" || ch === "！" || ch === "？" || ch === ";" || ch === "\n") {
      push(index);
    }
  }
  push(text.length);
  return sentences;
}

// ---- 主判定（纯函数） ----

const MAX_FINDINGS_PER_BUCKET = 30;

/**
 * M11.2.3（D-1）：pairwise fact 违规的 factRestore 数值投影。
 *
 * 背景（Case B 实录）：survey 项目（无冻结基线）的 pairwise 违规此前不提取
 * restoreValues / removeValues——rev N 的「无依据新增」在 rev N+1 按计划删除后，
 * 删除动作自身被判 number_removed（无授权）→ 加也拦、删也拦的结构性死锁
 * （FACT_PRESERVATION_FAILED 反复触发）。existing-paper 的累计路径
 * （buildCumulativeFactRegressions）自 M10.3.1 起就提取双清单，本函数把同一
 * 语义投影到 pairwise 路径：
 * - added_unsupported → removeValues：授权「删除该无依据新增」。行级提取（值
 *   所在行的全部数字 token）：新增时被 isFactLikeAddition 过滤的裸整数（年份
 *   等）删除时同样进 missing 多重集——只点名 classification.newValue 一值会漏
 *   （Case B 的 "-2026" 与 "2025" 同句），行级清单消除该不对称。
 * - removed → restoreValues：授权「重新加回被删原值」（行级，同上）。
 * - changed → restoreValues=[旧值] + removeValues=[新值]（与累计路径
 *   numericPart 同语义；值级而非行级——swap 的替换语义须双值精确点名）。
 * - direction / formula / placeholder / format：不投影（factRestore 通道只参与
 *   数值类 value*Authorized 判定；这些类别的授权走各自既有通道）。
 *
 * 授权消费 = buildAuthorization 的 restoreAuths（M10.3.1 既有）：只放行
 * 「删除被点名值 / 改回旧值 / 加回旧值」三个方向，永不放行替换与加强。
 */
export function projectPairwiseFactRestore(
  finding: Pick<FactFinding, "kind" | "file" | "classification">,
  files: readonly { file: string; content: string }[],
): { restoreValues?: string[]; removeValues?: string[] } {
  const numericPart = (value: string | undefined): string | undefined => {
    if (value === undefined) {
      return undefined;
    }
    const stripped = value.replace(/[^\d.%‰eE+\-−]/g, "").trim();
    return /\d/.test(stripped) ? stripped : undefined;
  };
  const content = files.find((entry) => entry.file === finding.file)?.content;
  /** 值所在行的全部数字 token（与 pairwise 判定同源 token 化；定位失败回退单值） */
  const lineNumericTokens = (value: string | undefined): string[] => {
    const stripped = numericPart(value);
    if (stripped === undefined || content === undefined) {
      return stripped !== undefined ? [stripped] : [];
    }
    const index = indexOfToken(content, stripped);
    if (index < 0) {
      return [stripped];
    }
    const tokens = proseNumberTokens(lineOf(content, index));
    return tokens.length > 0 ? tokens : [stripped];
  };
  const compact = (values: string[]): string[] | undefined => {
    const unique = [...new Set(values.filter((value) => value !== ""))];
    if (unique.length === 0) {
      return undefined;
    }
    return unique.slice(0, 12);
  };

  if (finding.kind === "added_unsupported") {
    return { removeValues: compact(lineNumericTokens(finding.classification?.newValue)) };
  }
  if (finding.kind === "removed") {
    return { restoreValues: compact(lineNumericTokens(finding.classification?.oldValue)) };
  }
  if (finding.kind === "changed") {
    return {
      ...(compact([numericPart(finding.classification?.oldValue) ?? ""]) !== undefined
        ? { restoreValues: compact([numericPart(finding.classification?.oldValue) ?? ""]) }
        : {}),
      ...(compact([numericPart(finding.classification?.newValue) ?? ""]) !== undefined
        ? { removeValues: compact([numericPart(finding.classification?.newValue) ?? ""]) }
        : {}),
    };
  }
  return {};
}

function cap(items: FactFinding[]): FactFinding[] {
  return items.slice(0, MAX_FINDINGS_PER_BUCKET);
}

export function evaluateFactPreservation(input: FactPreservationInput): FactPreservationSummary {
  const auth = buildAuthorization(
    input.plan,
    input.improvementPlanItems,
    input.evidenceTexts ?? [],
    input.bibliographyKeys ?? [],
    input.weakeningAuthorizations ?? [],
    ...(input.strictPlanTextAuthorization !== undefined
      ? [{ strictPlanTextAuthorization: input.strictPlanTextAuthorization }]
      : []),
  );
  const changedFacts: FactFinding[] = [];
  const removedFacts: FactFinding[] = [];
  const addedUnsupportedFacts: FactFinding[] = [];
  const directionalChanges: FactFinding[] = [];
  const formulaChanges: FactFinding[] = [];
  const placeholderRegressions: FactFinding[] = [];
  const formatChanges: FactFinding[] = [];
  let allowedChanges = 0;
  let allowedRemovals = 0;
  let allowedWeakenings = 0;
  /** M11.2.1：文件级弱化类别核验缓存（每文件一次；weaken 授权覆盖才计算） */
  const weakeningCheckByFile = new Map<string, WeakeningClassCheck | null>();
  /** M11.2.1：当前文件的方向类 finding 计数（4d 的作用域条件） */
  let directionalFindingsInFile = 0;

  const currentFiles = new Map(input.current.files.map((file) => [file.file, normalizeContent(file.content)]));

  for (const previousFile of input.previous.files) {
    const previous = normalizeContent(previousFile.content);
    const current = currentFiles.get(previousFile.file);
    directionalFindingsInFile = 0;

    // -- 1. 表格：同表同行同列的数值变化 / 整表整行消失 / 新增行 --
    const previousTables = parseTables(previous);
    const currentTables = current !== undefined ? parseTables(current) : [];
    const currentTableByKey = new Map(currentTables.map((table) => [table.key, table]));
    previousTables.forEach((table, tableOrdinal) => {
      const matched = currentTableByKey.get(table.key) ?? currentTables[tableOrdinal];
      const where = table.label !== null ? `表 ${table.label}` : table.caption !== "" ? `「${table.caption}」` : `第 ${tableOrdinal + 1} 个表`;
      if (matched === undefined) {
        removedFacts.push({
          kind: "removed",
          file: previousFile.file,
          section: "(table)",
          before: snippet(`${where}（${table.rows.length} 行）`),
          after: "",
          reason: "table_removed",
          classification: classAFinding("number_removed", `${where}（${table.rows.length} 行）`),
        });
        return;
      }
      const rowMatches = matchRows(table.rows, matched.rows);
      table.rows.forEach((row, rowIndex) => {
        const currentRowIndex = rowMatches[rowIndex];
        if (currentRowIndex === undefined) {
          if (row.some((cell) => /\d/.test(cell))) {
            removedFacts.push({
              kind: "removed",
              file: previousFile.file,
              section: "(table)",
              before: snippet(`${where} 行「${row[0] ?? ""}」：${row.join(" | ")}`),
              after: "",
              reason: "table_row_removed",
              classification: classAFinding("number_removed", row.join(" | ")),
            });
          }
          return;
        }
        const currentRow = matched.rows[currentRowIndex] ?? [];
        const cells = Math.max(row.length, currentRow.length);
        for (let cellIndex = 0; cellIndex < cells; cellIndex += 1) {
          const before = row[cellIndex] ?? "";
          const after = currentRow[cellIndex] ?? "";
          if (before === after) {
            continue;
          }
          const numericChange = /\d/.test(before) || /\d/.test(after);
          const placeholderNow = PLACEHOLDER_TEST.test(stripHedgedPlaceholders(after));
          if (!numericChange && !placeholderNow) {
            continue; // 纯措辞单元格：不属事实
          }
          const location = `${where} 行「${row[0] ?? currentRow[0] ?? ""}」第 ${cellIndex + 1} 列`;
          const finding: FactFinding = {
            kind: placeholderNow ? "placeholder" : "changed",
            file: previousFile.file,
            section: "(table)",
            before: snippet(`${location}：${before}`),
            after: snippet(after),
            reason: placeholderNow ? "table_cell_placeholder" : "table_cell",
          };
          if (placeholderNow) {
            placeholderRegressions.push({ ...finding, classification: classAFinding("placeholder_regression", before, after) });
            continue;
          }
          // M9.10：先分类再判授权——数值等价（B/C/D）不是违规，无需授权
          const classification = classifyCellChange(before, after);
          if (classification.category !== "A") {
            formatChanges.push({ ...finding, kind: "changed", classification });
            continue;
          }
          const grant = numericChange
            ? valueChangeAuthorized(
                auth,
                normalizeNumericToken(before.replace(/[^\d.%‰eE+\-−]/g, "")),
                normalizeNumericToken(after.replace(/[^\d.%‰eE+\-−]/g, "")),
                previousFile.file,
              )
            : null;
          if (grant !== null) {
            allowedChanges += 1;
          } else {
            changedFacts.push({ ...finding, classification });
          }
        }
      });
      matched.rows.forEach((row, index) => {
        if (rowMatches.includes(index)) {
          return; // 与 previous 某行配对过的行不算新增
        }
        if (row.some((cell) => /\d/.test(cell))) {
          const grant =
            row.some((cell) =>
              /\d/.test(cell) && valueAdditionAuthorized(auth, cell.replace(/[^\d.%‰eE+\-−]/g, ""), previousFile.file) !== null,
            ) || isBibKeyedMethodologyRow(row, auth.bibliographyKeys);
          const finding: FactFinding = {
            kind: "added_unsupported",
            file: previousFile.file,
            section: "(table)",
            before: "",
            after: snippet(`${where} 新增行：${row.join(" | ")}`),
            reason: "table_row_added",
            classification: classAFinding("number_added", undefined, row.join(" | ")),
          };
          if (grant) {
            allowedChanges += 1;
          } else {
            addedUnsupportedFacts.push(finding);
          }
        }
      });
    });
    currentTables.forEach((table, ordinal) => {
      const known =
        previousTables.some((candidate) => candidate.key === table.key) || previousTables[ordinal] !== undefined;
      if (!known && table.rows.some((row) => row.some((cell) => /\d/.test(cell)))) {
        addedUnsupportedFacts.push({
          kind: "added_unsupported",
          file: previousFile.file,
          section: "(table)",
          before: "",
          after: snippet(`新增表（${table.label ?? table.caption}，${table.rows.length} 行）`),
          reason: "table_added",
          classification: classAFinding("number_added", undefined, `新增表（${table.label ?? table.caption}）`),
        });
      }
    });

    if (current === undefined) {
      // 文件整体消失：prose 数字与公式全部记为删除
      for (const token of proseNumberTokens(previous)) {
        removedFacts.push({
          kind: "removed",
          file: previousFile.file,
          section: "(file removed)",
          before: snippet(token),
          after: "",
          reason: "file_removed",
          classification: classAFinding("number_removed", token),
        });
      }
      continue;
    }

    // -- 2. prose 数字：缺失（值语义）→ 删除 / 值变更；新增（事实型）→ 无依据新增 --
    const previousNumbers = proseNumberTokens(previous);
    const currentNumbers = proseNumberTokens(current);
    const numberDiff = multisetDiff(previousNumbers, currentNumbers);
    const placeholderIncreased = countPlaceholders(current) > countPlaceholders(previous);
    const missingNumericTotal = numberDiff.missing.length;
    /**
     * M10.3.1（恢复 rerun 实录）：配对前先分流独立授权——已授权的新增值
     * （Evidence / 计划文本 / 恢复清单）与已授权的删除值各自放行，剩余未授权
     * 部分才按多重集序配对成 changed。旧实现的任意配对会把「已授权新增」与
     * 「无关删除」撮合成一个假 changed（实例：rev3 恢复的板端值 0.9986 本应经
     * factRestore.restoreValues 授权，却被拿去与作者块消失的 "4" 配对）。
     * 计划点名的替换（0.5 → 0.4）由 valueRemovalAuthorized 的替换语义覆盖。
     */
    const remainingAdded: string[] = [];
    for (const addedToken of numberDiff.added) {
      if (valueAdditionAuthorized(auth, addedToken, previousFile.file) !== null) {
        allowedChanges += 1;
      } else {
        remainingAdded.push(addedToken);
      }
    }
    const remainingMissing: { token: string; index: number }[] = [];
    for (const missingToken of numberDiff.missing) {
      if (valueRemovalAuthorized(auth, missingToken, previousFile.file) !== null) {
        allowedRemovals += 1;
      } else {
        remainingMissing.push({ token: missingToken, index: indexOfToken(previous, missingToken) });
      }
    }
    /**
     * M10.3.1（恢复 rerun 定稿）：废除任意下标配对——只做「同章节 + 行上下文
     * 关键词共享」的定位配对（真实 swap：同一行的值替换，行内词面必然共享
     * 指标/术语）。任意配对会把互不相干的删除与新增撮合成假 changed（两类
     * 实录：板端值恢复 × 作者块消失的 "4"；λ_smooth 段 × 无关删除值）。
     * swap 配对走 valueChangeAuthorized（计划须点名双值——Evidence 池中的
     * 历史值不构成 swap 授权，M10.3 历史板测值防洗板语义保持）。
     */
    const contextTokens = (line: string): Set<string> => {
      const tokens = new Set<string>();
      for (const match of line.matchAll(/[A-Za-z]{3,}/g)) {
        tokens.add(match[0].toLowerCase());
      }
      for (const match of line.matchAll(/[一-鿿]{2,}/g)) {
        tokens.add(match[0]);
      }
      return tokens;
    };
    const sharesContext = (a: string, b: string): boolean => {
      const sa = contextTokens(a);
      const sb = contextTokens(b);
      for (const token of sa) {
        if (sb.has(token)) {
          return true;
        }
      }
      return false;
    };
    const pendingAdded: { token: string; index: number }[] = remainingAdded.map((token) => ({
      token,
      index: indexOfToken(current, token),
    }));
    const pairedMissing: { token: string; index: number; partner?: string }[] = [];
    const usedAdded = new Set<number>();
    for (const missingEntry of remainingMissing) {
      const missingLine = missingEntry.index >= 0 ? lineOf(previous, missingEntry.index) : "";
      const missingSection = missingEntry.index >= 0 ? nearestSection(previous, missingEntry.index) : "(global)";
      let partner: { token: string; index: number } | undefined;
      for (let ai = 0; ai < pendingAdded.length; ai += 1) {
        if (usedAdded.has(ai)) {
          continue;
        }
        const candidate = pendingAdded[ai]!;
        const candidateLine = candidate.index >= 0 ? lineOf(current, candidate.index) : "";
        const candidateSection = candidate.index >= 0 ? nearestSection(current, candidate.index) : "(global)";
        if (
          missingSection === candidateSection &&
          sharesContext(missingLine, candidateLine)
        ) {
          partner = candidate;
          usedAdded.add(ai);
          break;
        }
      }
      pairedMissing.push({ ...missingEntry, ...(partner !== undefined ? { partner: partner.token } : {}) });
    }
    const pairedAdded = pendingAdded.filter((_, ai) => !usedAdded.has(ai));
    for (let index = 0; index < pairedMissing.length && removedFacts.length + changedFacts.length < 400; index += 1) {
      const token = pairedMissing[index]!.token;
      const at = pairedMissing[index]!.index;
      const section = at >= 0 ? nearestSection(previous, at) : "(global)";
      const beforeSnippet = at >= 0 ? snippet(lineOf(previous, at)) : snippet(token);
      if (pairedMissing[index]!.partner !== undefined) {
        const replacement = pairedMissing[index]!.partner!;
        const classification = classifyValuePair(token, replacement);
        if (classification.category !== "A") {
          // M9.10 B 类：数值等价的格式差异（千分位 / 全角 / 尾零 / 单位写法）——
          // 不是事实漂移，不进违规桶（false positive 消除），保留审计轨迹
          formatChanges.push({
            kind: "changed",
            file: previousFile.file,
            section,
            before: beforeSnippet,
            after: snippet(`${replacement}（原 ${token}）`),
            reason: "prose_number",
            classification,
          });
          continue;
        }
        const grant = valueChangeAuthorized(auth, token, replacement, previousFile.file);
        if (grant !== null) {
          allowedChanges += 1;
          continue;
        }
        changedFacts.push({
          kind: "changed",
          file: previousFile.file,
          section,
          before: beforeSnippet,
          after: snippet(`${replacement}（原 ${token}）`),
          reason: "prose_number",
          classification,
        });
      } else {
        if (placeholderIncreased) {
          placeholderRegressions.push({
            kind: "placeholder",
            file: previousFile.file,
            section,
            before: beforeSnippet,
            after: snippet(`${token} → 占位表述`),
            reason: "placeholder_replacement",
            classification: classAFinding("placeholder_regression", token),
          });
          continue;
        }
        removedFacts.push({
          kind: "removed",
          file: previousFile.file,
          section,
          before: beforeSnippet,
          after: "",
          reason: "prose_number",
          classification: classAFinding("number_removed", token),
        });
      }
    }
    // 未被 swap 配对消费的新增值：fact-like 过滤后计违规（授权的已在分流步放行）
    const unpairedAdditions = pairedAdded;
    for (const entry of unpairedAdditions) {
      const token = entry.token;
      if (!isFactLikeAddition(token)) {
        continue;
      }
      const at = entry.index;
      addedUnsupportedFacts.push({
        kind: "added_unsupported",
        file: previousFile.file,
        section: at >= 0 ? nearestSection(current, at) : "(global)",
        before: "",
        after: snippet(at >= 0 ? lineOf(current, at) : token),
        reason: "added_number",
        classification: classAFinding("number_added", undefined, token),
      });
    }
    // -- 2b. 超参数 / 阈值赋值新增（r=16、Lclip≥3 类；仅 previous 已存在的文件参与，
    //    写作阶段的新章节文件不在本循环内——新增审查只针对既有稿） --
    const previousProseCompact = normalizeForProseExtraction(stripTablesAndMath(previous)).replace(/\s+/g, "");
    const currentProse = normalizeForProseExtraction(stripTablesAndMath(current));
    /**
     * M11.4 Reliability Closure（Run A 实证）：同一参数的等值重述（基线
     * λ_smooth=0.50，修订写 λ_smooth=0.5——normalizeNumericToken 两侧同为
     * 0.5，但整串 compact 形态不同）不是新超参数事实，是格式等价重述
     * （formatChanges 审计，不计违规）。
     */
    const previousAssignments = [...previousProseCompact.matchAll(ASSIGNMENT_PATTERN)];
    for (const match of currentProse.matchAll(ASSIGNMENT_PATTERN)) {
      const whole = (match[0] ?? "").replace(/\s+/g, "");
      const value = match[2] ?? "";
      if (whole === "" || previousProseCompact.includes(whole)) {
        continue;
      }
      const grant = valueAdditionAuthorized(auth, value, previousFile.file);
      if (grant !== null) {
        allowedChanges += 1;
        continue;
      }
      const lhs = (match[1] ?? "").replace(/\s+/g, "");
      const normalizedValue = normalizeNumericToken(value);
      const equivalentRestatement = lhs !== "" && normalizedValue !== "" && previousAssignments.some(
        (prior) =>
          (prior[1] ?? "").replace(/\s+/g, "") === lhs &&
          normalizeNumericToken(prior[2] ?? "") === normalizedValue,
      );
      if (equivalentRestatement) {
        formatChanges.push({
          kind: "changed",
          file: previousFile.file,
          section: nearestSection(currentProse, match.index ?? 0),
          before: "",
          after: snippet(whole),
          reason: "assignment_format_restatement",
        });
        continue;
      }
      addedUnsupportedFacts.push({
        kind: "added_unsupported",
        file: previousFile.file,
        section: nearestSection(currentProse, match.index ?? 0),
        before: "",
        after: snippet(whole),
        reason: "hyperparameter_assignment",
        classification: classAFinding("number_added", undefined, whole),
      });
    }
    // -- 2c. 量纲后缀新增（71维 / 64路：数字 token 本体不带这些量纲，单独扫描） --
    for (const match of currentProse.matchAll(DIMENSION_PATTERN)) {
      const whole = (match[0] ?? "").replace(/\s+/g, "");
      if (whole === "" || previousProseCompact.includes(whole)) {
        continue;
      }
      const grant = valueAdditionAuthorized(auth, match[1] ?? "", previousFile.file);
      if (grant !== null) {
        allowedChanges += 1;
        continue;
      }
      addedUnsupportedFacts.push({
        kind: "added_unsupported",
        file: previousFile.file,
        section: nearestSection(currentProse, match.index ?? 0),
        before: "",
        after: snippet(whole),
        reason: "added_number",
        classification: classAFinding("number_added", undefined, whole),
      });
    }
    if (placeholderIncreased && missingNumericTotal === 0) {
      const hadFacts = previousNumbers.length > 0 || previousTables.length > 0;
      if (hadFacts) {
        placeholderRegressions.push({
          kind: "placeholder",
          file: previousFile.file,
          section: "(global)",
          before: snippet("（该章节原有具体实验事实）"),
          after: snippet([...current.matchAll(PLACEHOLDER_PATTERN)].map((match) => match[0]).slice(0, 3).join("/")),
          reason: "placeholder_regression",
          classification: classAFinding("placeholder_regression"),
        });
      }
    }

    // -- 3. 公式：数学片段多重集（归一化空白）；缺失 → formulaChanges；
    //    新增 → added_unsupported（新公式 = 新增方法事实；仅既有文件参与）。
    //    M11.4 Attempt 8：missing × added 先做 alpha-rename 配对（一致符号
    //    重命名 = 表示层变更，进 formatChanges 审计），未配对者照旧走违规/
    //    授权通道 --
    const previousMath = extractMathSegments(previous);
    const currentMath = extractMathSegments(current);
    const mathDiff = multisetDiff(previousMath, currentMath);
    const notationRenames = pairNotationRenames(mathDiff.missing, mathDiff.added);
    const renamedBefore = new Set(notationRenames.pairs.map((pair) => pair.before));
    const renamedAfter = new Set(notationRenames.pairs.map((pair) => pair.after));
    for (const pair of notationRenames.pairs) {
      const at = previous.indexOf(pair.before.split(" ")[0] ?? "");
      formatChanges.push({
        kind: "formula",
        file: previousFile.file,
        section: at >= 0 ? nearestSection(previous, at) : "(global)",
        before: snippet(pair.before, 70),
        after: snippet(pair.after, 70),
        reason: "formula_notation_rename",
        classification: {
          category: "B",
          type: "formula_notation_renamed",
          severity: "low",
          oldValue: snippet(pair.before, 40),
          newValue: snippet(pair.after, 40),
        },
      });
    }
    for (const segment of mathDiff.missing) {
      if (renamedBefore.has(segment)) {
        continue;
      }
      const grant = formulaChangeAuthorized(auth);
      if (grant !== null) {
        allowedChanges += 1;
        continue;
      }
      const at = previous.indexOf(segment.split(" ")[0] ?? "");
      formulaChanges.push({
        kind: "formula",
        file: previousFile.file,
        section: at >= 0 ? nearestSection(previous, at) : "(global)",
        before: snippet(segment, 70),
        after: "",
        reason: "formula_removed_or_changed",
        classification: classAFinding("formula_changed", snippet(segment, 40)),
      });
    }
    for (const segment of mathDiff.added) {
      if (renamedAfter.has(segment)) {
        continue;
      }
      const grant = formulaAdditionAuthorized(auth, segment) ?? formulaChangeAuthorized(auth);
      if (grant !== null) {
        allowedChanges += 1;
        continue;
      }
      addedUnsupportedFacts.push({
        kind: "added_unsupported",
        file: previousFile.file,
        section: "(formula)",
        before: "",
        after: snippet(segment, 70),
        reason: "formula_added",
        classification: classAFinding("formula_changed", undefined, snippet(segment, 40)),
      });
    }

    // -- 4. 方向性结论：负结果 / 持平 → 优势；同指标比较方向对调 --
    const previousClaims = claimSentences(previous);
    const currentClaims = claimSentences(current);
    const previousNegative = previousClaims.filter((claim) => claim.polarity === "disadvantage");
    const previousParity = previousClaims.filter((claim) => claim.polarity === "parity");
    const currentAdvantage = currentClaims.filter((claim) => claim.polarity === "advantage");
    const currentHasNegative = currentClaims.some((claim) => claim.polarity === "disadvantage");
    const currentHasParity = currentClaims.some((claim) => claim.polarity === "parity");
    const grantDirection = () => directionChangeAuthorized(auth, previousFile.file);
    /**
     * M11.2.1：typed weakening 覆盖（weaken_claim_strength + 类别核验）。
     * 真实 E2E 的振荡形态：Writer 按 finding / claim grounding 合法弱化（加
     * 「据其报道」限定、拆分长句重排）后，句子级首指标 / 末方向词启发式把重排
     * 误判为 metric_direction_flip。类别核验（方向词只减不增 / 数值稳定 /
     * 强表述只减不增）证明「只有断言强度变化」时放行并计数审计。
     */
    const weakeningCheck = (): WeakeningClassCheck | null => {
      if (!weakeningCoversFile(auth, previousFile.file)) {
        return null;
      }
      let cached = weakeningCheckByFile.get(previousFile.file);
      if (cached === undefined) {
        cached = weakeningClassCheck(previous, current);
        weakeningCheckByFile.set(previousFile.file, cached);
      }
      return cached;
    };
    const directional = (finding: Omit<FactFinding, "kind">): void => {
      directionalFindingsInFile += 1;
      const grant = grantDirection();
      if (grant !== null) {
        allowedChanges += 1;
        return;
      }
      const weakCheck = weakeningCheck();
      if (weakCheck !== null && weakCheck.covered) {
        allowedWeakenings += 1;
        return;
      }
      directionalChanges.push({
        kind: "directional",
        classification: classAFinding("direction_changed", finding.before, finding.after),
        ...finding,
      });
    };
    // 4a. 负结果消失且出现优势结论（§9 hard protection）
    if (
      previousNegative.length > 0 &&
      !currentHasNegative &&
      currentAdvantage.length > 0 &&
      previousNegative.some((claim) => claim.ownMethod || claim.metric !== null)
    ) {
      directional({
        file: previousFile.file,
        section: nearestSection(previous, previousNegative[0]?.index ?? 0),
        before: snippet(previousNegative[0]?.text ?? ""),
        after: snippet(currentAdvantage[0]?.text ?? ""),
        reason: "negative_to_advantage",
      });
    }
    // 4b. 持平结论消失且出现优势结论
    if (previousParity.length > 0 && !currentHasParity && currentAdvantage.length > 0) {
      directional({
        file: previousFile.file,
        section: nearestSection(previous, previousParity[0]?.index ?? 0),
        before: snippet(previousParity[0]?.text ?? ""),
        after: snippet(currentAdvantage[0]?.text ?? ""),
        reason: "parity_to_advantage",
      });
    }
    // 4c. 同指标比较方向对调（metric + direction 词都出现且方向词极性相反）
    for (const previousClaim of previousClaims) {
      if (previousClaim.metric === null || previousClaim.direction === null) {
        continue;
      }
      // 保留性守卫：原 claim 句子逐字仍在当前文本中 → 该结论本身未被翻转。
      // 真实论文对同一指标常同时含负向（局限/消融边界）与正向（优势）结论；
      // 文件级交叉配对若不检查保留性，未修改的 baseline 也会被交叉判死
      // （M11.4 Attempt 7 实录：baseline==baseline 产生 6 条恒定 flip，
      // scoped patch 候选全部被误拒且 repair 永远 no_progress）。
      if (currentClaims.some((claim) => claim.text === previousClaim.text)) {
        continue;
      }
      const previousPositive = POSITIVE_DIRECTION.has(previousClaim.direction);
      const flip = currentClaims.find(
        (claim) =>
          claim.metric === previousClaim.metric &&
          claim.direction !== null &&
          POSITIVE_DIRECTION.has(claim.direction) !== previousPositive &&
          claim.direction !== previousClaim.direction,
      );
      if (flip !== undefined) {
        directional({
          file: previousFile.file,
          section: nearestSection(previous, previousClaim.index),
          before: snippet(previousClaim.text),
          after: snippet(flip.text),
          reason: "metric_direction_flip",
        });
      }
    }

    // -- 4d. M11.2.1：授权弱化语境下的断言升级（epistemic strengthening） --
    // 弱化授权只覆盖「强度下降」方向。Reviewer 要求弱化的同一文件里出现净新增
    // 强表述 marker（可能 → 已经证明 / 据报道 → 显著提升）= 授权方向的逆向，
    // 必须显式呈现，不得被弱化授权静默吞掉。作用域限定为「该文件确有方向类
    // finding」（弱化语境真实被消费）——无方向 finding 的纯措辞升级由
    // claimStrength 在 Revision Validation 独立裁决（block / needs_review /
    // 用户 HITL 决策，M6.7 语义不变），本守卫不重复裁决。
    {
      const weakCheck = weakeningCheck();
      if (weakCheck !== null && weakCheck.strongMarkerAdds.length > 0 && directionalFindingsInFile > 0) {
        directionalChanges.push({
          kind: "directional",
          file: previousFile.file,
          section: "(global)",
          before: snippet("（该章节原有断言强度）"),
          after: snippet(`新增强表述：${weakCheck.strongMarkerAdds.slice(0, 3).join("/")}`),
          reason: "epistemic_strengthening",
          classification: classAFinding(
            "direction_changed",
            undefined,
            weakCheck.strongMarkerAdds.slice(0, 3).join("/"),
          ),
        });
      }
    }

    // -- 5. 协议哨兵：数据集划分 / 硬件 --
    const previousOfficial = OFFICIAL_SPLIT_PATTERN.test(previous);
    const currentCustom = CUSTOM_SPLIT_PATTERN.test(current);
    const previousCustom = CUSTOM_SPLIT_PATTERN.test(previous);
    const currentOfficial = OFFICIAL_SPLIT_PATTERN.test(current);
    if ((previousOfficial && currentCustom && !previousCustom) || (previousCustom && currentOfficial && !previousOfficial)) {
      const grant = directionChangeAuthorized(auth, previousFile.file);
      if (grant === null) {
        changedFacts.push({
          kind: "changed",
          file: previousFile.file,
          section: "(protocol)",
          before: snippet(previousOfficial ? "official/官方数据划分" : "custom/自定义数据划分"),
          after: snippet(currentCustom ? "custom/自定义数据划分" : "official/官方数据划分"),
          reason: "dataset_split_changed",
          classification: classAFinding(
            "protocol_changed",
            previousOfficial ? "official/官方数据划分" : "custom/自定义数据划分",
            currentCustom ? "custom/自定义数据划分" : "official/官方数据划分",
          ),
        });
      } else {
        allowedChanges += 1;
      }
    }
    const previousHardware = new Set([...previous.matchAll(HARDWARE_PATTERN)].map((match) => (match[0] ?? "").replace(/\s+/g, " ")));
    const currentHardware = new Set([...current.matchAll(HARDWARE_PATTERN)].map((match) => (match[0] ?? "").replace(/\s+/g, " ")));
    for (const hardware of previousHardware) {
      if (![...currentHardware].some((candidate) => candidate.replace(/\s/g, "") === hardware.replace(/\s/g, ""))) {
        const grant = valueRemovalAuthorized(auth, hardware, previousFile.file);
        if (grant === null) {
          removedFacts.push({
            kind: "removed",
            file: previousFile.file,
            section: "(protocol)",
            before: snippet(hardware),
            after: "",
            reason: "hardware_removed",
            classification: classAFinding("protocol_changed", hardware),
          });
        } else {
          allowedRemovals += 1;
        }
      }
    }
    for (const hardware of currentHardware) {
      if (![...previousHardware].some((candidate) => candidate.replace(/\s/g, "") === hardware.replace(/\s/g, ""))) {
        const grant = valueAdditionAuthorized(auth, hardware, previousFile.file);
        if (grant === null) {
          addedUnsupportedFacts.push({
            kind: "added_unsupported",
            file: previousFile.file,
            section: "(protocol)",
            before: "",
            after: snippet(hardware),
            reason: "hardware_added",
            classification: classAFinding("protocol_changed", undefined, hardware),
          });
        } else {
          allowedChanges += 1;
        }
      }
    }
  }

  const summary: FactPreservationSummary = {
    previousRevision: input.previous.revision,
    currentRevision: input.current.revision,
    changedFacts: cap(changedFacts),
    removedFacts: cap(removedFacts),
    addedUnsupportedFacts: cap(addedUnsupportedFacts),
    directionalChanges: cap(directionalChanges),
    formulaChanges: cap(formulaChanges),
    placeholderRegressions: cap(placeholderRegressions),
    formatChanges: cap(formatChanges),
    allowedChanges,
    allowedRemovals,
    allowedWeakenings,
    weakeningAuthorizationCount: auth.weakeningEntries.length,
    planId: input.plan?.planId ?? null,
    ok:
      changedFacts.length === 0 &&
      removedFacts.length === 0 &&
      addedUnsupportedFacts.length === 0 &&
      directionalChanges.length === 0 &&
      formulaChanges.length === 0 &&
      placeholderRegressions.length === 0,
  };
  return summary;
}

/**
 * 行匹配键：数值列出现前的标签单元格串联（「低照度|纯IoU基线」这类前缀重复的表，
 * 只用首列会串行）；首列即数值的表退化为首单元格；全空退化为行号。
 */
function rowKey(row: readonly string[], index: number): string {
  const labelCells: string[] = [];
  for (const cell of row) {
    if (/\d/.test(cell)) {
      break;
    }
    if (cell !== "") {
      labelCells.push(cell);
    }
  }
  const label = labelCells.join("|");
  if (label !== "") {
    return `label:${label}`;
  }
  const first = row.find((cell) => cell !== "") ?? "";
  return first !== "" ? `first:${first}` : `index:${index}`;
}

/**
 * previous 行 → current 行 的配对（undefined = 该行消失）。
 * 1) 键精确匹配；2) 前缀兼容兜底：值列被「待回填」等占位替换后，占位单元格会
 * 混入标签前缀（高密度|本文方法 → 高密度|本文方法|待回填），此时要求列数相同、
 * 标签互为「|」边界前缀，按行序优先配对。
 */
function matchRows(previousRows: readonly string[][], currentRows: readonly string[][]): (number | undefined)[] {
  const used = new Set<number>();
  const tryClaim = (predicate: (row: string[], index: number) => boolean): number | undefined => {
    const index = currentRows.findIndex((row, candidateIndex) => !used.has(candidateIndex) && predicate(row, candidateIndex));
    if (index >= 0) {
      used.add(index);
      return index;
    }
    return undefined;
  };
  return previousRows.map((row, rowIndex) => {
    const key = rowKey(row, rowIndex);
    const exact = tryClaim((candidate, candidateIndex) => rowKey(candidate, candidateIndex) === key);
    if (exact !== undefined) {
      return exact;
    }
    if (!key.startsWith("label:")) {
      return undefined;
    }
    const label = key.slice("label:".length);
    return tryClaim(
      (candidate, candidateIndex) =>
        candidate.length === row.length &&
        (() => {
          const candidateKey = rowKey(candidate, candidateIndex);
          if (!candidateKey.startsWith("label:")) {
            return false;
          }
          const candidateLabel = candidateKey.slice("label:".length);
          return label.startsWith(`${candidateLabel}|`) || candidateLabel.startsWith(`${label}|`);
        })(),
    );
  });
}

/** Gate 规则 detail（有界；样本最多 3 条 / 类别） */
export function describeFactPreservation(summary: FactPreservationSummary): string {
  const base = `rev-${summary.previousRevision}→rev-${summary.currentRevision}`;
  if (summary.ok) {
    return `${base} 实验事实保持通过（授权变更 ${summary.allowedChanges} 项 / 授权删除 ${summary.allowedRemovals} 项${
      summary.allowedWeakenings > 0 ? ` / 授权弱化 ${summary.allowedWeakenings} 项（typed，类别核验通过）` : ""
    }${summary.formatChanges.length > 0 ? ` / 格式等价差异 ${summary.formatChanges.length} 项不计违规` : ""}）`;
  }
  const parts: string[] = [];
  const sample = (findings: FactFinding[], label: string): string => {
    if (findings.length === 0) {
      return "";
    }
    const first = findings[0] as FactFinding;
    const detail = `${first.before} → ${first.after}`.trim();
    return `${label} ${findings.length} 项（如 ${detail.slice(0, 80)}）`;
  };
  parts.push(sample(summary.changedFacts, "事实被改"));
  parts.push(sample(summary.removedFacts, "事实被删"));
  parts.push(sample(summary.addedUnsupportedFacts, "无依据新增"));
  parts.push(sample(summary.directionalChanges, "结论方向反转"));
  parts.push(sample(summary.formulaChanges, "公式变化"));
  parts.push(sample(summary.placeholderRegressions, "事实被占位替换"));
  const failures = parts.filter((part) => part !== "").join("；");
  const formatNote =
    summary.formatChanges.length > 0 ? `；另有格式等价差异 ${summary.formatChanges.length} 项（数值未漂移，不计违规）` : "";
  return `${base} 实验事实保持失败：${failures}——未经 RevisionPlan/Evidence 授权${formatNote}`;
}

// ---- 工作流 / HTTP 共用的加载器（与 computeCitationPreservation 同构） ----

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { ManuscriptRevisionStore } from "../manuscript/RevisionStore.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { ReviewArtifactStore } from "../review/reviewArtifacts.js";
import type { EvidenceStore } from "../evidence/EvidenceStore.js";
import { readSnapshotTex } from "./citationPreservation.js";
import { readWeakeningAuthorizations } from "./cumulativeFactPreservation.js";

export interface FactPreservationDeps {
  projects: ProjectStore;
  revisions: ManuscriptRevisionStore;
  reviewArtifacts: ReviewArtifactStore;
  evidence: EvidenceStore;
}

/**
 * 计算被审阅修订相对其前一修订的实验事实保持结果。
 * 返回 null = 不可比较（无前序修订 / 快照缺失 / reason=revision.restore），规则中性不参与。
 */
export async function computeFactPreservation(
  deps: FactPreservationDeps,
  projectId: string,
  reviewedRevision: number | undefined,
): Promise<FactPreservationSummary | null> {
  const state = await deps.revisions.load(projectId);
  const current = typeof reviewedRevision === "number" && reviewedRevision > 0 ? reviewedRevision : state.current;
  if (current <= 0) {
    return null;
  }
  const ordered = [...state.revisions].sort((a, b) => a.revision - b.revision);
  const index = ordered.findIndex((record) => record.revision === current);
  if (index <= 0) {
    return null; // 无前序修订
  }
  const currentRecord = ordered[index]!;
  const previousRecord = ordered[index - 1]!;
  if (currentRecord.reason === "revision.restore") {
    return null; // 用户显式恢复历史修订：不是 Writer 改稿，不做保持比较
  }
  const [previousFiles, currentFiles] = await Promise.all([
    readSnapshotTex(deps.revisions.snapshotDir(projectId, previousRecord.revision)),
    readSnapshotTex(deps.revisions.snapshotDir(projectId, currentRecord.revision)),
  ]);
  if (previousFiles === null || currentFiles === null || previousFiles.length === 0) {
    return null; // 快照缺失（旧项目）：如实不可比较
  }
  // 承认修改依据的计划：sourceRevision == previous 的 quality 修订计划（最新轮优先）
  let plan: import("../review/revisionPlan.js").RevisionPlan | null = null;
  for (const round of await deps.reviewArtifacts.planRounds(projectId)) {
    const candidate = await deps.reviewArtifacts.loadPlan(projectId, round);
    if (
      candidate !== null &&
      candidate.sourceRevision === previousRecord.revision &&
      candidate.revisionReason !== "style_polish"
    ) {
      plan = candidate;
      break;
    }
  }
  const improvementPlanItems = await readImprovementPlanItems(deps.projects, projectId);
  const evidenceTexts = (await deps.evidence.list(projectId)).flatMap((record) => [
    record.claim,
    record.summary ?? "",
    record.quote ?? "",
  ]);
  const bibliographyKeys = await readBibliographyKeys(deps.projects, projectId);
  /**
   * M11.2.1 typed weakening 授权（三源合并，派生纯函数与 revision.plan 落台账
   * 同源）：
   * 1. 匹配轮次计划现场派生——条目授权在生命周期内持续有效（gate / validation
   *    消费时条目已 applied / validated / approved，这是 M11.2 振荡的结构性
   *    成因之一；历史项目无台账也能当场解释合法弱化）；
   * 2. 同轮 claim grounding 的 UNSUPPORTED / CONTRADICTED claim（Reviewer
   *    fact 模式的结构化弱化裁决）；
   * 3. 授权台账（append-only：跨轮持续 + 审计追溯 + cumulative 口径）。
   */
  const weakeningAuthorizations: WeakeningAuthorizationInput[] = [];
  if (plan !== null) {
    weakeningAuthorizations.push(...derivePlanWeakeningAuthorizations(plan));
    const grounding = await deps.reviewArtifacts.loadClaimGrounding(projectId, plan.reviewRound);
    if (grounding !== null) {
      weakeningAuthorizations.push(...deriveClaimGroundingWeakeningAuthorizations(grounding));
    }
  }
  weakeningAuthorizations.push(...(await readWeakeningAuthorizations(deps.projects, projectId)));
  return evaluateFactPreservation({
    previous: { revision: previousRecord.revision, files: previousFiles },
    current: { revision: currentRecord.revision, files: currentFiles },
    plan,
    ...(improvementPlanItems.length > 0 ? { improvementPlanItems } : {}),
    evidenceTexts,
    ...(bibliographyKeys.length > 0 ? { bibliographyKeys } : {}),
    weakeningAuthorizations,
  });
}

/** Evaluate a not-yet-applied single-patch candidate against the immutable source snapshot. */
export async function computeFactPreservationForCandidate(
  deps: FactPreservationDeps,
  projectId: string,
  sourceRevision: number,
  candidateFiles: FactTexFile[],
): Promise<FactPreservationSummary | null> {
  if (sourceRevision <= 0) return null;
  const previousFiles = await readSnapshotTex(deps.revisions.snapshotDir(projectId, sourceRevision));
  if (previousFiles === null || previousFiles.length === 0) return null;
  let plan: import("../review/revisionPlan.js").RevisionPlan | null = null;
  for (const round of await deps.reviewArtifacts.planRounds(projectId)) {
    const candidate = await deps.reviewArtifacts.loadPlan(projectId, round);
    if (candidate !== null && candidate.sourceRevision === sourceRevision && candidate.revisionReason !== "style_polish") {
      plan = candidate;
      break;
    }
  }
  const improvementPlanItems = await readImprovementPlanItems(deps.projects, projectId);
  const evidenceTexts = (await deps.evidence.list(projectId)).flatMap((record) => [record.claim, record.summary ?? "", record.quote ?? ""]);
  const bibliographyKeys = await readBibliographyKeys(deps.projects, projectId);
  const weakeningAuthorizations: WeakeningAuthorizationInput[] = [];
  if (plan !== null) {
    weakeningAuthorizations.push(...derivePlanWeakeningAuthorizations(plan));
    const grounding = await deps.reviewArtifacts.loadClaimGrounding(projectId, plan.reviewRound);
    if (grounding !== null) weakeningAuthorizations.push(...deriveClaimGroundingWeakeningAuthorizations(grounding));
  }
  weakeningAuthorizations.push(...(await readWeakeningAuthorizations(deps.projects, projectId)));
  /**
   * M11.4 Reliability Closure（Run P 实证：w-ff42920a8421，metric 方向翻转
   * 分两步各自通过 pairwise 授权、在 cumulative（对冻结基线）口径才可见——
   * 候选校验只比 sourceRevision 会漏掉跨轮累积漂移）。追加冻结基线口径：
   * candidate 对最早修订（existing-paper 冻结稿）再评一次，取两次违规的并集
   * （frozen 口径无 plan / 台账授权差异由 strict 标准吸收；非 existing-paper
   * 无冻结基线时该口径自然缺省）。
   */
  const state = await deps.revisions.load(projectId);
  const ordered = [...state.revisions].sort((a, b) => a.revision - b.revision);
  const frozen = ordered[0];
  let frozenSummary: import("./factPreservation.js").FactPreservationSummary | null = null;
  if (frozen !== undefined && frozen.revision < sourceRevision) {
    const frozenFiles = await readSnapshotTex(deps.revisions.snapshotDir(projectId, frozen.revision));
    if (frozenFiles !== null && frozenFiles.length > 0) {
      frozenSummary = evaluateFactPreservation({
        previous: { revision: frozen.revision, files: frozenFiles },
        current: { revision: sourceRevision + 1, files: candidateFiles },
        plan: null,
        ...(improvementPlanItems.length > 0 ? { improvementPlanItems } : {}),
        evidenceTexts,
        ...(bibliographyKeys.length > 0 ? { bibliographyKeys } : {}),
        weakeningAuthorizations,
        strictPlanTextAuthorization: true,
      });
    }
  }
  const pairwise = evaluateFactPreservation({
    previous: { revision: sourceRevision, files: previousFiles },
    current: { revision: sourceRevision + 1, files: candidateFiles },
    plan,
    ...(improvementPlanItems.length > 0 ? { improvementPlanItems } : {}),
    evidenceTexts,
    ...(bibliographyKeys.length > 0 ? { bibliographyKeys } : {}),
    weakeningAuthorizations,
    // M11.4 Reliability Closure：候选级与 cumulative 同标准——revision-plan
    // 指令文本不授权新增（Run C 实证：round-2 计划文本自我授权新公式，
    // patch 层放行、gate 层判漂移且不可恢复）
    strictPlanTextAuthorization: true,
  });
  if (frozenSummary === null) return pairwise;
  return {
    ...pairwise,
    changedFacts: cap([...pairwise.changedFacts, ...frozenSummary.changedFacts]),
    removedFacts: cap([...pairwise.removedFacts, ...frozenSummary.removedFacts]),
    addedUnsupportedFacts: cap([...pairwise.addedUnsupportedFacts, ...frozenSummary.addedUnsupportedFacts]),
    directionalChanges: cap([...pairwise.directionalChanges, ...frozenSummary.directionalChanges]),
    formulaChanges: cap([...pairwise.formulaChanges, ...frozenSummary.formulaChanges]),
    placeholderRegressions: cap([...pairwise.placeholderRegressions, ...frozenSummary.placeholderRegressions]),
    ok: pairwise.ok && frozenSummary.ok,
  };
}

/**
 * M10.3.1：当前 manuscript 目录 bib 文件的 key 清单（bib-keyed 方法论行的
 * 授权通道）。bib 文件缺失 / 不可解析 → 空清单（该通道中性关闭，其余授权不变）。
 */
async function readBibliographyKeys(
  projects: ProjectStore,
  projectId: string,
): Promise<string[]> {
  const { readFile } = await import("node:fs/promises");
  for (const name of ["references.bib", "refs.bib"]) {
    try {
      const raw = await readFile(join(projects.manuscriptDir(projectId), name), "utf8");
      return [...raw.matchAll(/@\w+\s*\{\s*([^,\s]+)\s*,/g)].map((match) => match[1] ?? "");
    } catch {
      // 尝试下一个名字
    }
  }
  return [];
}

async function readImprovementPlanItems(
  projects: ProjectStore,
  projectId: string,
): Promise<{ section: string; action: string; rationale?: string }[]> {
  try {
    const parsed = JSON.parse(
      await readFile(join(projects.researchDir(projectId), "improvement-plan.json"), "utf8"),
    ) as {
      plan?: {
        items?: {
          section?: unknown;
          action?: unknown;
          rationale?: unknown;
          expectedFactChanges?: unknown;
        }[];
      };
    };
    return (parsed.plan?.items ?? [])
      .filter((item) => typeof item.section === "string" && typeof item.action === "string")
      .map((item) => ({
        section: item.section as string,
        action: item.action as string,
        ...(typeof item.rationale === "string" ? { rationale: item.rationale as string } : {}),
        // M10.3：expectedFactChanges（before → after）并入授权文本——
        // 计划点名旧值与新值的数值变更是 plan_value_correction 授权
        ...(Array.isArray(item.expectedFactChanges)
          ? {
              rationale: [
                typeof item.rationale === "string" ? item.rationale : "",
                ...item.expectedFactChanges
                  .filter(
                    (change): change is { before: string; after: string; basis?: string } =>
                      typeof change === "object" &&
                      change !== null &&
                      typeof (change as Record<string, unknown>)["before"] === "string" &&
                      typeof (change as Record<string, unknown>)["after"] === "string",
                  )
                  .map(
                    (change) =>
                      `${change.before} → ${change.after}${change.basis !== undefined ? `（依据：${change.basis}）` : ""}`,
                  ),
              ]
                .filter((part) => part !== "")
                .join("\n"),
            }
          : {}),
      }));
  } catch {
    return [];
  }
}
