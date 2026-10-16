/**
 * M14.6（F5）：Review Finding 与作者已确认研究输入事实的确定性反证。
 *
 * M14.5 真实 run 实录：reviewer 把作者已确认事实（小论文的「高度跟踪误差降低 75.37%」）判为
 * 「本项目没有已导入的实验数据 / 未授权 / 仅见于外部来源 / 证据库无记录」，要求删除或弱化；
 * revision.plan 把该 finding 原样派发并铸造弱化授权，修订随之把合法数值改成「显著降低」。
 *
 * 本模块在 review.run 聚合之后、revision.plan 之前，用**确定性**规则反证这类 finding：
 *   A. finding 文本中的全部特征数值（小数 / 百分数 / ≥3 位整数）都等于某条作者已确认事实的数值；
 *   B. finding 的理由是「来源 / 授权缺失」类（而不是指标口径、单位或表述问题）；
 *   C. finding 要求删除 / 弱化该数值（而不是只要求补充说明）；
 *   D. finding 没有同时承认该数值合法（「属授权数值」「保留 75.37%」等）。
 * 四条全部成立 → 反证成立：finding 移出 issues（不计 blocking / critical、不进修订计划、不铸弱化授权），
 * 保留在 disconfirmedIssues 透明展示并写明匹配的 Fact ID。
 *
 * 诚实边界：这是词面级确定性启发式（与 disconfirmBuildFindings 同级），不是语义理解。
 * 对指标口径错误（「原始口径为 RMSE，与正文『高度跟踪误差』不符」）、单位换算、夸大外推等
 * 真实问题，只要 finding 不以「无来源 / 未授权」为由要求删值，就不反证，照常派发。
 * 对不在事实表中的数值（真正无来源）永不反证——反例必须仍被拦截。
 */

import type { ReviewIssue } from "../agents/ReviewerService.js";
import type { AuthorizedObservationValue } from "../review/claimGrounding.js";
import type { FactView } from "./researchInputTypes.js";

/** 来源 / 授权缺失类理由（finding 以此为据判值非法） */
const SOURCE_DEFICIT_PATTERN =
  /(没有|无|缺少|缺乏|不存在|未见).{0,10}(已导入|导入的|授权|实验数据|实验包|已核验|核验证据|证据支撑|证据记录|数据支撑|来源)|未授权|未经授权|证据库(中)?无|证据清单为空|仅见于外部|外部来源|外部论文数值|不在授权范围|来源不明|未提供.{0,6}(数据|实验|来源)|无法核验来源|未在.{0,8}(实验数据|继承表格)中/;

/** 删除 / 弱化类处置（针对数值） */
const REMOVAL_PATTERN = /删除|删去|移除|去掉|剪除|弱化|降格|改为定性|定性表述|定性描述|替换为定性|不得保留|不保留|删掉/;

/** 承认数值合法的措辞（出现即不反证） */
const ACKNOWLEDGEMENT_PATTERN =
  /属授权|属合法|合法来源|已授权数值|已确认事实|作者已确认|数值本身(正确|合法|无误|属|有)|保留\s*[-−]?\d|数值可以保留|数值予以保留|无需删除|不必删除|不要求删除|表中(仅)?有|事实表(内|中)|与.{0,8}事实一致/;

/** 删除 / 弱化动作所针对的「数值类」名词（窗口内出现才算针对数值本身） */
const NUMERIC_NOUN_PATTERN = /数值|百分比|百分数|统计量|统计表述|统计值|指标值|具体数字|该值|数字|定量表述|误差统计/;

/**
 * 处置文本中的删除 / 弱化动作是否针对给定数值（±25 字符窗口内出现该数值或数值类名词）。
 * 「删除『完成即证明满足实时性要求』的推断式结论」这类针对其它论断的动作不算（M14.6 verify 实录）。
 */
export function removalTargetsValues(actionText: string, surfaces: ReadonlyArray<string>): boolean {
  const bare = surfaces.map((surface) => surface.replace(/[%‰]$/, "").replace(/\s+/g, ""));
  for (const match of actionText.matchAll(new RegExp(REMOVAL_PATTERN.source, "g"))) {
    const at = match.index ?? 0;
    const window = actionText.slice(Math.max(0, at - 25), at + (match[0]?.length ?? 0) + 25);
    if (bare.some((surface) => surface !== "" && window.replace(/\s+/g, "").includes(surface))) return true;
    if (NUMERIC_NOUN_PATTERN.test(window)) return true;
  }
  return false;
}

/** 数值 token（与 publishedFactsDrift / mustPreserve 同口径；排除粘连在字母上的数字） */
const NUMBER_TOKEN_PATTERN = /(?<![A-Za-z\d.])[-−]?\d+(?:[.,]\d+)?\s?[%‰]?(?![A-Za-z\d])/gu;

export interface FactFindingDisconfirmation {
  issue: ReviewIssue;
  matchedFacts: Array<{ factId: string; surface: string }>;
  reason: string;
}

export interface FactFindingDisconfirmationResult {
  disconfirmed: FactFindingDisconfirmation[];
  disconfirmedCount: number;
  isDisconfirmed: (issue: ReviewIssue) => boolean;
  reasonFor: (issue: ReviewIssue) => string | undefined;
}

interface NumberToken {
  raw: string;
  numeric: number;
  percent: boolean;
  distinctive: boolean;
}

function parseNumberTokens(text: string): NumberToken[] {
  const tokens: NumberToken[] = [];
  for (const match of text.matchAll(NUMBER_TOKEN_PATTERN)) {
    const raw = (match[0] ?? "").trim();
    if (raw === "") continue;
    const percent = /[%‰]$/.test(raw);
    const bare = raw.replace(/[%‰]$/, "").replace("−", "-").trim();
    // 千分位（20,000）与欧式小数逗号（0,5）区分：逗号后恰 3 位且无小数点 → 千分位
    const body = /^-?\d{1,3}(,\d{3})+$/.test(bare) ? bare.replace(/,/g, "") : bare.replace(",", ".");
    const numeric = Number(body);
    if (!Number.isFinite(numeric)) continue;
    const hasDecimal = body.includes(".");
    const digits = body.replace(/[^0-9]/g, "").length;
    // 年份 / 章节号 / 小整数（第 5 章、两架、3 个）不是特征数值
    const isYear = !hasDecimal && !percent && /^(19|20)\d{2}$/.test(body);
    const distinctive = !isYear && (hasDecimal || percent || digits >= 3);
    tokens.push({ raw, numeric, percent, distinctive });
  }
  return tokens;
}

function factNumeric(fact: FactView): { numeric: number; percent: boolean } | null {
  const stored = fact.value.numeric;
  const numeric = stored !== undefined && Number.isFinite(stored) ? stored : parseNumberTokens(fact.surface)[0]?.numeric;
  if (numeric === undefined || !Number.isFinite(numeric)) return null;
  const percent = fact.value.unit === "%" || /%$/.test(fact.surface);
  return { numeric, percent };
}

function numericEquals(a: number, b: number): boolean {
  const scale = Math.max(1, Math.abs(a), Math.abs(b));
  return Math.abs(a - b) <= 1e-9 * scale;
}

function findingText(issue: ReviewIssue): string {
  return [issue.description, issue.suggestedAction ?? "", issue.reason ?? "", issue.quote ?? ""].join("\n");
}

/** 把 finding 文本的特征数值全部匹配到已确认事实；任一不匹配 → null */
export function matchFindingNumbersToFacts(
  text: string,
  confirmedFacts: ReadonlyArray<FactView>,
): Array<{ factId: string; surface: string }> | null {
  const tokens = parseNumberTokens(text).filter((token) => token.distinctive);
  if (tokens.length === 0) return null;
  const matched = new Map<string, { factId: string; surface: string }>();
  for (const token of tokens) {
    const hit = confirmedFacts.find((fact) => {
      const value = factNumeric(fact);
      if (value === null) return false;
      if (!numericEquals(value.numeric, token.numeric)) return false;
      // 百分数只匹配百分数事实；无单位 token 可匹配任意同值事实（75.37 ↔ 75.37%）
      return !token.percent || value.percent;
    });
    if (hit === undefined) return null;
    matched.set(hit.factId, { factId: hit.factId, surface: hit.surface });
  }
  return [...matched.values()];
}

/**
 * 确定性反证（纯函数）。只对 fact / evidence_gap / academic 类 finding 生效；
 * 四条件（见模块头）全部成立才反证。
 */
export function disconfirmFactFindingsAgainstResearchFacts(
  issues: ReadonlyArray<ReviewIssue>,
  confirmedFacts: ReadonlyArray<FactView>,
): FactFindingDisconfirmationResult {
  const disconfirmed: FactFindingDisconfirmation[] = [];
  const reasons = new Map<ReviewIssue, string>();
  if (confirmedFacts.length > 0) {
    for (const issue of issues) {
      if (issue.category !== "fact" && issue.category !== "evidence_gap" && issue.category !== "academic") continue;
      const text = findingText(issue);
      if (ACKNOWLEDGEMENT_PATTERN.test(text)) continue;
      if (!SOURCE_DEFICIT_PATTERN.test(text)) continue;
      const action = issue.suggestedAction !== undefined && issue.suggestedAction.trim() !== "" ? issue.suggestedAction : issue.description;
      if (!REMOVAL_PATTERN.test(action)) continue;
      const matched = matchFindingNumbersToFacts(text, confirmedFacts);
      if (matched === null) continue;
      // C 的数值针对性：删除 / 弱化动作的窗口内须出现匹配数值或数值类名词
      if (!removalTargetsValues(action, matched.map((fact) => fact.surface))) continue;
      const reason =
        `确定性反证：finding 以「无实验数据 / 未授权 / 仅见于外部来源」为由要求删除或弱化的数值` +
        `（${matched.map((fact) => fact.surface).join("、")}）全部为作者已确认的研究输入事实` +
        `（${matched.map((fact) => fact.factId).join("、")}；来源核验通过并经作者确认）——不计入阻断、不派发修订、不铸弱化授权`;
      disconfirmed.push({ issue, matchedFacts: matched, reason });
      reasons.set(issue, reason);
    }
  }
  return {
    disconfirmed,
    disconfirmedCount: disconfirmed.length,
    isDisconfirmed: (issue) => reasons.has(issue),
    reasonFor: (issue) => reasons.get(issue),
  };
}

/**
 * 作者已确认研究输入事实 → claim grounding 的授权观测值（与实验包观测同一消费口径：
 * UNSUPPORTED claim 的数值全部命中 → disclosure=author_experiment_data，不铸「数值只许删除」授权，
 * resolution 走 author_decision_required）。
 */
export function researchFactsAsAuthorizedObservations(confirmedFacts: ReadonlyArray<FactView>): AuthorizedObservationValue[] {
  const observations: AuthorizedObservationValue[] = [];
  for (const fact of confirmedFacts) {
    const value = factNumeric(fact);
    if (value === null) continue;
    const metric = fact.key.metric ?? fact.key.parameter ?? fact.key.subject ?? fact.kind;
    observations.push({ value: value.numeric, metric, groupId: `research-input:${fact.researchInputId}` });
  }
  return observations;
}

/** 事实表面形态的比对归一：`75.37\%` → `75.37%`，空白不敏感 */
function normalizeBodyForSurface(text: string): string {
  return text.replace(/\\%/g, "%").replace(/\s+/g, "");
}

/**
 * M14.6（F5）：修订候选 / 相邻修订之间，作者已确认研究输入事实的**删除**检测（纯函数）。
 * before 含该事实的表面形态而 after 不含 → 该事实被删除。只看表面形态（与 published_facts_zero_drift
 * 的 consistent 判定同口径），不做数值等价推断（等价换算改写由 drift 比对处理）。
 * 短表面（< 2 字符）与纯年份不参与（噪声）。
 */
export function detectConfirmedFactRemoval(
  before: string,
  after: string,
  confirmedFacts: ReadonlyArray<FactView>,
): Array<{ factId: string; surface: string }> {
  const normalizedBefore = normalizeBodyForSurface(before);
  const normalizedAfter = normalizeBodyForSurface(after);
  const removed: Array<{ factId: string; surface: string }> = [];
  const seen = new Set<string>();
  for (const fact of confirmedFacts) {
    const surface = fact.surface.replace(/\s+/g, "");
    if (surface.length < 2 || /^(19|20)\d{2}$/.test(surface)) continue;
    if (seen.has(surface)) continue;
    if (normalizedBefore.includes(surface) && !normalizedAfter.includes(surface)) {
      seen.add(surface);
      removed.push({ factId: fact.factId, surface: fact.surface });
    }
  }
  return removed;
}
