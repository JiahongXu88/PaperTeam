/**
 * M17.2.1 作者确认的研究方法事实（method-facts/v1）与确定性核查（零模型）。
 *
 * 实验事实快照只覆盖实验观测与可推导比较；方法节还需要两类可机器核对的事实：
 *  - 参数（parameter）：符号 / 名称 + 数值 + 标度 + 适用配置范围（`0.5` 与 `50` 是不同的科学值）；
 *  - 组件状态（component）：ACTIVE / REMOVED / PROPOSED / UNKNOWN（旧版用过 ≠ 当前版仍存在）。
 *
 * 纪律：
 *  - 只有作者显式确认（confirmedBy=author）的事实才是权威；从研究想法原文确定性抽取的只是候选，不升级为事实；
 *  - 事实表冻结为带内容哈希的版本；撤销或其来源（研究想法原文）变化即失效，失效后不再支撑任何论断；
 *  - 核查只认「主体 + 数值 + 标度 + 范围」的绑定：同一个数字出现在别处不构成来源；
 *  - 不能确定的语言（主体 / 时态 / 否定不清）记 UNCERTAIN 交作者裁决，不臆造来源，也不报「通过」。
 */

import { sha256Hex } from "../util/hash.js";

export const METHOD_FACT_SHEET_SCHEMA = "paperteam.method-facts/v1";
export const METHOD_FACT_AUDIT_SCHEMA = "paperteam.method-fact-audit/v1";

export type MethodFactKind = "parameter" | "component";
export type ComponentStatus = "ACTIVE" | "REMOVED" | "PROPOSED" | "UNKNOWN";
export const COMPONENT_STATUSES: readonly ComponentStatus[] = ["ACTIVE", "REMOVED", "PROPOSED", "UNKNOWN"];

export interface MethodFact {
  factId: string;
  factKind: MethodFactKind;
  /** 参数符号（λ / k / \gamma_{s}）或组件名（如「门控模块」） */
  subject: string;
  /** 等价写法：LaTeX 命令、英文名、中文名称（如「确认阈值」） */
  aliases: string[];
  /** 参数取值（规范数值）与作者原写法 */
  value?: number;
  valueText?: string;
  /** 参数标度：dimensionless（默认，0–1 比例等）/ percent / 其他自由单位（frames、px …） */
  unit?: string;
  /** 组件状态 */
  status?: ComponentStatus;
  /** 适用的配置 / 实验变体标签；空 = 当前方法全文适用 */
  scope: string[];
  sourceLocator: string;
  confirmationStatus: "author_confirmed";
  confirmedBy: "author";
  confirmedAt: string;
  note?: string;
}

export interface MethodFactSheet {
  schema: typeof METHOD_FACT_SHEET_SCHEMA;
  sheetId: string;
  version: number;
  createdAt: string;
  /** 当前论文采用的方法版本说明（作者填写，可空） */
  methodVersion?: string;
  /** 事实来源基线：研究想法原文哈希（来源变化 → 失效，需作者重新确认） */
  basis: { researchIdeaSha256: string | null };
  facts: MethodFact[];
  note?: string;
  contentHash: string;
}

export interface MethodFactCandidate {
  candidateId: string;
  factKind: MethodFactKind;
  subject: string;
  aliases: string[];
  value?: number;
  valueText?: string;
  status?: ComponentStatus;
  sourceLocator: string;
  quote: string;
  confirmationStatus: "candidate";
}

export type MethodFactState =
  | { status: "none"; candidates: MethodFactCandidate[] }
  | { status: "valid"; sheet: MethodFactSheet; candidates: MethodFactCandidate[] }
  | { status: "stale" | "revoked"; sheet: MethodFactSheet; reasons: string[]; candidates: MethodFactCandidate[] };

// ---------------------------------------------------------------- 归一化

const GREEK: Record<string, string> = {
  alpha: "α", beta: "β", gamma: "γ", delta: "δ", epsilon: "ε", varepsilon: "ε", zeta: "ζ", eta: "η", theta: "θ", vartheta: "θ",
  iota: "ι", kappa: "κ", lambda: "λ", mu: "μ", nu: "ν", xi: "ξ", pi: "π", rho: "ρ", sigma: "σ", tau: "τ", upsilon: "υ",
  phi: "φ", varphi: "φ", chi: "χ", psi: "ψ", omega: "ω",
  Gamma: "Γ", Delta: "Δ", Theta: "Θ", Lambda: "Λ", Xi: "Ξ", Pi: "Π", Sigma: "Σ", Phi: "Φ", Psi: "Ψ", Omega: "Ω",
};
const GREEK_CHARS = "α-ωΑ-Ω";

/** 符号规范形：\lambda / lambda / λ → λ；去掉空白与花括号（\lambda_{s} → λ_s） */
export function canonicalSymbol(symbol: string): string {
  let text = symbol.trim().replace(/\\([A-Za-z]+)/g, (match, name: string) => GREEK[name] ?? match);
  if (/^[A-Za-z]+$/.test(text) && GREEK[text] !== undefined && text.length > 2) text = GREEK[text]!;
  return text.replace(/[\s{}$]/g, "").replace(/\\(?:mathrm|text|mathit|operatorname)/g, "");
}

export interface ParsedNumber { value: number; decimals: number; percent: boolean; raw: string }

const NUMBER_SOURCE = String.raw`[+\-−]?\d+(?:\.\d+)?(?:\s*[eE][+\-−]?\d+|\s*(?:\\times|×|\\cdot|·)\s*10\s*\^\s*\{?\s*[+\-−]?\d+\s*\}?)?(?:\s*\\?[%％])?`;

/** 科学数字 → 数值 + 有效小数位（科学计数法折算）+ 是否百分数写法；不认识的写法返回 null */
export function parseScientificNumber(raw: string): ParsedNumber | null {
  const text = raw.trim().replace(/−/g, "-");
  const match = /^([+-]?\d+(?:\.(\d+))?)(?:\s*[eE]([+-]?\d+)|\s*(?:\\times|×|\\cdot|·)\s*10\s*\^\s*\{?\s*([+-]?\d+)\s*\}?)?(\s*\\?[%％])?$/.exec(text);
  if (match === null) return null;
  const mantissa = Number(match[1]);
  const exponent = Number(match[3] ?? match[4] ?? 0);
  const decimals = Math.max(0, (match[2]?.length ?? 0) - exponent);
  const value = Number((mantissa * 10 ** exponent).toFixed(Math.min(20, decimals + 2)));
  return Number.isFinite(value) ? { value, decimals, percent: match[5] !== undefined, raw: raw.trim() } : null;
}

/** 写出的数字（按显示精度区间）是否与作者确认值等价；百分数写法只在事实标度不是 percent 时 ÷100 */
export function numberMatchesFact(claim: ParsedNumber, fact: { value: number; unit?: string }): boolean {
  const scaled = claim.percent && fact.unit !== "percent" ? { value: claim.value / 100, decimals: claim.decimals + 2 } : claim;
  const half = 0.5 * 10 ** -scaled.decimals;
  const epsilon = 1e-9 * Math.max(1, Math.abs(fact.value));
  return fact.value >= scaled.value - half - epsilon && fact.value <= scaled.value + half + epsilon;
}

function scaleHint(claim: ParsedNumber, fact: { value: number; unit?: string }): string {
  if (fact.value !== 0 && numberMatchesFact({ ...claim, value: claim.value / 100, decimals: claim.decimals + 2 }, fact)) return "（疑似标度错误：写出值是作者确认值的 100 倍）";
  if (numberMatchesFact({ ...claim, value: claim.value * 100, decimals: Math.max(0, claim.decimals - 2) }, fact)) return "（疑似标度错误：写出值是作者确认值的 1/100）";
  if (fact.value !== 0 && Math.sign(claim.value) !== Math.sign(fact.value)) return "（符号相反）";
  return "";
}

// ---------------------------------------------------------------- 文本切分

export interface AuditText { file: string; content: string }
interface Sentence { file: string; raw: string; start: number; content: string; prepared: string }

function stripComments(content: string): string {
  return content.replace(/(^|[^\\])%[^\n]*/g, (match, prefix: string) => prefix + " ".repeat(match.length - prefix.length));
}

/** 匹配用的规范文本：希腊命令 → Unicode、\_ → _、{=} → =、去掉数学定界符与结构性命令参数（\ref / \label / \cite …） */
function prepare(raw: string): string {
  return raw
    .replace(/\\(?:ref|eqref|autoref|cref|Cref|label|cite[a-z]*|input|include|url|href)\*?\{[^{}]*\}/g, (match) => (match.startsWith("\\cite") ? " \\cite " : " "))
    .replace(/\\_/g, "_")
    .replace(/\\%/g, "%")
    .replace(/\\([A-Za-z]+)/g, (match, name: string) => GREEK[name] ?? match)
    .replace(/\{\s*=\s*\}/g, "=")
    .replace(/\\(?:mathrm|text|mathit|textit|textbf|emph)\{([^{}]*)\}/g, "$1")
    .replace(/\\[(),\[\]]|\$/g, " ")
    .replace(/[~]|\\,|\\;|\\!/g, " ");
}

function sentencesOf(file: string, content: string): Sentence[] {
  const text = stripComments(content);
  const result: Sentence[] = [];
  let start = 0;
  const flush = (end: number) => {
    const raw = text.slice(start, end);
    if (raw.trim() !== "") result.push({ file, raw, start, content, prepared: prepare(raw) });
    start = end;
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (/[。！？!?；;]/.test(char)) flush(index + 1);
    else if (char === "." && /\s/.test(text[index + 1] ?? " ") && !/\d/.test(text[index - 1] ?? "")) flush(index + 1);
    else if (char === "\n" && text[index + 1] === "\n") flush(index + 1);
  }
  flush(text.length);
  return result;
}

function lineOf(content: string, offset: number): number {
  let line = 1;
  for (let index = 0; index < offset && index < content.length; index += 1) if (content[index] === "\n") line += 1;
  return line;
}

function quoteOf(sentence: Sentence): string {
  return sentence.raw.replace(/\s+/g, " ").trim().slice(0, 200);
}

/** 位置是否在下标 / 上标花括号内（\sum_{i=1}^{N} 的 i=1 不是方法参数） */
function insideScript(text: string, index: number): boolean {
  let depth = 0;
  for (let cursor = index - 1; cursor >= 0; cursor -= 1) {
    const char = text[cursor];
    if (char === "}") depth += 1;
    else if (char === "{") {
      if (depth === 0) return text[cursor - 1] === "_" || text[cursor - 1] === "^";
      depth -= 1;
    }
  }
  return false;
}

// ---------------------------------------------------------------- 参数论断抽取

export interface ParameterClaim {
  file: string;
  line: number;
  quote: string;
  /** 规范符号或命中的中文名称别名 */
  symbol: string;
  number: ParsedNumber;
  /** 句中提到的配置 / 变体标签（规范形） */
  sentenceLower: string;
}

const SYMBOL_SOURCE = String.raw`(?<![A-Za-z0-9_\\${GREEK_CHARS}])([${GREEK_CHARS}]|[A-Za-z]{1,8})(_(?:\{[^{}]{1,24}\}|[A-Za-z0-9]))?`;
const ASSIGN_SOURCE = String.raw`\s*(?:=|＝|:=|≡|取值为|设置为|设定为|设为|取为|取|为)\s*`;
const PARAMETER_ASSIGNMENT = new RegExp(`${SYMBOL_SOURCE}${ASSIGN_SOURCE}(${NUMBER_SOURCE})(?![\\d.]|[A-Za-z_])`, "g");

/** 参数形符号：希腊字母、单个拉丁字母（可带下标）；多字母词（HOTA / IoU）只在被作者事实登记为别名时才视为参数 */
function parameterLike(symbol: string, registered: ReadonlySet<string>): boolean {
  if (registered.has(symbol) || registered.has(symbol.toLowerCase())) return true;
  const base = symbol.split("_")[0]!;
  return new RegExp(`^[${GREEK_CHARS}]$`).test(base) || /^[A-Za-z]$/.test(base);
}

export function extractParameterClaims(texts: readonly AuditText[], registered: ReadonlySet<string> = new Set(), nameAliases: readonly string[] = []): ParameterClaim[] {
  const claims: ParameterClaim[] = [];
  const nameRegexes = nameAliases.filter((alias) => /[一-鿿]/.test(alias)).map((alias) => [alias, new RegExp(`${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}${ASSIGN_SOURCE}(${NUMBER_SOURCE})(?![\\d.]|[A-Za-z_])`, "g")] as const);
  for (const { file, content } of texts) {
    for (const sentence of sentencesOf(file, content)) {
      const text = sentence.prepared;
      const base = { file, line: lineOf(sentence.content, sentence.start + (sentence.raw.length - sentence.raw.trimStart().length)), quote: quoteOf(sentence), sentenceLower: text.toLowerCase() };
      // 并列「λ 与 k 分别为 0.35 与 12」：位置不能确定归属——不抽取（宁可漏报，不误绑）
      for (const match of text.matchAll(PARAMETER_ASSIGNMENT)) {
        const symbol = canonicalSymbol(`${match[1]!}${match[2] ?? ""}`);
        if (!parameterLike(symbol, registered)) continue;
        if (insideScript(text, match.index ?? 0)) continue;
        const number = parseScientificNumber(match[3]!);
        if (number !== null) claims.push({ ...base, symbol, number });
      }
      for (const [alias, regex] of nameRegexes) {
        for (const match of text.matchAll(regex)) {
          const number = parseScientificNumber(match[1]!);
          if (number !== null) claims.push({ ...base, symbol: alias, number });
        }
      }
    }
  }
  return claims;
}

// ---------------------------------------------------------------- 组件提及分类

export type MentionClass = "asserted_current" | "negated" | "historical" | "other_work" | "proposal" | "uncertain";

const NEGATION_BEFORE = /(去掉|去除|移除|删除|删去|取消|摒弃|舍弃|不再使用|不再采用|不再包含|不再含有|不使用|未使用|不采用|未采用|没有使用|没有采用|不含|不包含|未包含|不设|未设|无需|没有|无|\b(?:without|removing|removed|remove|dropping|dropped|eliminating|omitting|no))\s*(?:了|掉)?\s*(?:原有|原先|旧版|此前|先前)?\s*(?:的)?\s*(?:the|a|any)?\s*$/i;
const NEGATION_AFTER = /^\s*(?:已|已经|被|已被|均已|现已)?\s*(?:去掉|去除|移除|删除|删去|取消|弃用|舍弃|关闭|禁用)|^\s*(?:is|was|has been|have been|were|are)?\s*(?:removed|dropped|eliminated|disabled|omitted|not used)/i;
const HISTORICAL = /(旧版|早期版本|此前版本|先前版本|原版本|上一版|曾经|曾使用|曾采用|曾包含|以前|previous(?:ly)?\s+version|earlier\s+version|originally|formerly|legacy|prior\s+version)/i;
const PROPOSAL = /(未来|今后|后续工作|拟(?:议|采用|引入|在|将)|计划|将来|展望|有待|可进一步|可以进一步|future\s+work|in\s+future|we\s+plan|could\s+be\s+explored|will\s+explore)/i;
const UNCERTAIN = /(不确定|尚不清楚|是否采用|是否使用|未知|待确认|unclear|unknown|to\s+be\s+confirmed)/i;
const SELF = /(本文|我们|本方法|所提|该方法|该模块|本模块|本层|\bour\b|\bours\b|\bwe\b|the\s+proposed|this\s+paper|this\s+work)/i;
const OTHER_WORK = /(\\cite|\[\d+\]|相关工作|现有(?:工作|方法)|已有(?:工作|方法)|其他(?:方法|工作|跟踪器)|其它(?:方法|工作)|prior\s+work|existing\s+(?:methods|work)|other\s+(?:methods|works|trackers)|previous\s+(?:methods|work))/i;

const CONTRAST = /(与本文不同|不同于本文|区别于本文|有别于本文|unlike\s+(?:ours|our|the\s+proposed))/i;

function relatedWorkFile(file: string): boolean {
  return /related|literature|相关工作|background/i.test(file);
}

export function classifyMention(sentence: string, index: number, length: number, file: string): MentionClass {
  if (NEGATION_BEFORE.test(sentence.slice(Math.max(0, index - 16), index)) || NEGATION_AFTER.test(sentence.slice(index + length, index + length + 12))) {
    return HISTORICAL.test(sentence) ? "historical" : "negated";
  }
  if (HISTORICAL.test(sentence)) return "historical";
  if (PROPOSAL.test(sentence)) return "proposal";
  if (UNCERTAIN.test(sentence)) return "uncertain";
  if (CONTRAST.test(sentence) && OTHER_WORK.test(sentence)) return "other_work";
  const self = SELF.test(sentence);
  if (OTHER_WORK.test(sentence) && !self) return "other_work";
  if (relatedWorkFile(file) && !self) return "uncertain";
  return "asserted_current";
}

// ---------------------------------------------------------------- 核查

export type MethodFactAuditCode =
  | "METHOD_PARAM_CONFLICT"
  | "METHOD_PARAM_UNSOURCED"
  | "METHOD_COMPONENT_CONFLICT"
  | "METHOD_COMPONENT_UNCERTAIN"
  | "METHOD_COMPONENT_UNCONFIRMED"
  | "METHOD_FACTS_STALE";

export interface MethodFactAuditFinding {
  findingId: string;
  code: MethodFactAuditCode;
  severity: "major" | "minor";
  /** 冲突需改稿；需作者裁决的不确定 / 未确认项另行标注 */
  authorDecisionRequired: boolean;
  file: string;
  line: number;
  quote: string;
  subject: string;
  claimedValue?: number;
  claimedText?: string;
  mentionClass?: MentionClass;
  factId?: string;
  detail: string;
}

export interface MethodFactAuditResult {
  schema: typeof METHOD_FACT_AUDIT_SCHEMA;
  /** 审查阶段（outline / writing / review / revision_patch），用于责任归属 */
  stage: string;
  factState: MethodFactState["status"];
  sheetId?: string;
  sheetContentHash?: string;
  /** 是否以作者确认事实完成了冲突核查（无有效事实表 = false：不能据此报「方法事实保护通过」） */
  evaluated: boolean;
  checkedParameters: number;
  checkedComponentMentions: number;
  consistent: Array<{ file: string; line: number; subject: string; basis: string; quote: string }>;
  findings: MethodFactAuditFinding[];
}

function findingId(code: string, file: string, subject: string, quote: string, value?: number): string {
  return `mfa-${sha256Hex([code, file, subject, quote, value ?? ""].join("|")).slice(0, 12)}`;
}

function normalizeLabel(label: string): string {
  return label.toLowerCase().replace(/\\_/g, "_").replace(/\s+/g, "");
}

function factSymbols(fact: MethodFact): string[] {
  return [fact.subject, ...fact.aliases].map((entry) => canonicalSymbol(entry)).filter((entry) => entry !== "");
}

function sameSymbol(a: string, b: string): boolean {
  return a === b || a.toLowerCase() === b.toLowerCase();
}

/** 研究想法原文中作者本人写出的「符号 = 值」（未确认候选；只作为新增数字的作者陈述来源，不作冲突权威） */
function authorStatedPairs(researchIdea: string | undefined): Array<{ symbol: string; number: ParsedNumber }> {
  if (researchIdea === undefined || researchIdea.trim() === "") return [];
  return extractParameterClaims([{ file: "project.researchIdea", content: researchIdea }]).map((claim) => ({ symbol: claim.symbol, number: claim.number }));
}

export interface MethodFactAuditOptions {
  stage: string;
  researchIdea?: string;
  /** 快照指标名：与指标同名的赋值是实验水平值，归实验事实核查，不在此处判 */
  metricKeys?: readonly string[];
}

export function auditMethodFacts(texts: readonly AuditText[], state: MethodFactState, options: MethodFactAuditOptions): MethodFactAuditResult {
  const valid = state.status === "valid" ? state.sheet : null;
  const result: MethodFactAuditResult = {
    schema: METHOD_FACT_AUDIT_SCHEMA, stage: options.stage, factState: state.status,
    ...(state.status !== "none" ? { sheetId: state.sheet.sheetId, sheetContentHash: state.sheet.contentHash } : {}),
    evaluated: valid !== null, checkedParameters: 0, checkedComponentMentions: 0, consistent: [], findings: [],
  };
  if (state.status === "stale" || state.status === "revoked") {
    result.findings.push({
      findingId: findingId("METHOD_FACTS_STALE", "", state.sheet.sheetId, state.status), code: "METHOD_FACTS_STALE", severity: "minor", authorDecisionRequired: true,
      file: texts[0]?.file ?? "main.tex", line: 1, quote: "", subject: state.sheet.sheetId,
      detail: `作者方法事实表 ${state.sheet.sheetId} 已${state.status === "revoked" ? "撤销" : "失效"}（${state.reasons.join("；")}）：方法参数与组件状态当前没有有效权威来源，需作者重新确认`,
    });
  }
  const facts = valid?.facts ?? [];
  const parameters = facts.filter((fact) => fact.factKind === "parameter" && fact.value !== undefined);
  const registered = new Set(parameters.flatMap(factSymbols).flatMap((symbol) => [symbol, symbol.toLowerCase()]));
  const nameAliases = parameters.flatMap((fact) => fact.aliases);
  const metricKeys = new Set((options.metricKeys ?? []).map((key) => key.toLowerCase()));
  const stated = authorStatedPairs(options.researchIdea);

  for (const claim of extractParameterClaims(texts, registered, nameAliases)) {
    if (metricKeys.has(claim.symbol.toLowerCase()) && !registered.has(claim.symbol)) continue;
    result.checkedParameters += 1;
    let candidates = parameters.filter((fact) => factSymbols(fact).some((symbol) => sameSymbol(symbol, claim.symbol)) || fact.aliases.includes(claim.symbol));
    if (candidates.length > 0) {
      // 句中点名了某个配置 / 变体：只在这些范围内核对（「cfg-b 的 k=6」不得由 cfg-a 的 k=12 支撑，反之亦然）
      const scoped = candidates.filter((fact) => fact.scope.some((label) => claim.sentenceLower.replace(/\s+/g, "").includes(normalizeLabel(label))));
      if (scoped.length > 0) candidates = scoped;
      const hit = candidates.find((fact) => numberMatchesFact(claim.number, { value: fact.value!, ...(fact.unit !== undefined ? { unit: fact.unit } : {}) }));
      if (hit !== undefined) {
        result.consistent.push({ file: claim.file, line: claim.line, subject: claim.symbol, basis: `author_confirmed:${hit.factId}`, quote: claim.quote });
        continue;
      }
      const reference = candidates[0]!;
      result.findings.push({
        findingId: findingId("METHOD_PARAM_CONFLICT", claim.file, claim.symbol, claim.quote, claim.number.value), code: "METHOD_PARAM_CONFLICT", severity: "major", authorDecisionRequired: false,
        file: claim.file, line: claim.line, quote: claim.quote, subject: claim.symbol, claimedValue: claim.number.value, claimedText: claim.number.raw, factId: reference.factId,
        detail: `参数 ${claim.symbol} 写作 ${claim.number.raw}，与作者确认值 ${candidates.map((fact) => `${fact.valueText ?? fact.value}${fact.scope.length > 0 ? `（${fact.scope.join("、")}）` : ""}`).join(" / ")} 不一致${scaleHint(claim.number, { value: reference.value!, ...(reference.unit !== undefined ? { unit: reference.unit } : {}) })}；来源 ${reference.sourceLocator}`,
      });
      continue;
    }
    if (stated.some((pair) => sameSymbol(pair.symbol, claim.symbol) && numberMatchesFact(claim.number, { value: pair.number.value, unit: pair.number.percent ? "percent" : "dimensionless" }))) {
      result.consistent.push({ file: claim.file, line: claim.line, subject: claim.symbol, basis: "author_stated_unconfirmed:project.researchIdea", quote: claim.quote });
      continue;
    }
    result.findings.push({
      findingId: findingId("METHOD_PARAM_UNSOURCED", claim.file, claim.symbol, claim.quote, claim.number.value), code: "METHOD_PARAM_UNSOURCED", severity: "minor", authorDecisionRequired: true,
      file: claim.file, line: claim.line, quote: claim.quote, subject: claim.symbol, claimedValue: claim.number.value, claimedText: claim.number.raw,
      detail: `参数 ${claim.symbol}=${claim.number.raw} 没有可追溯来源（作者确认方法事实 / 研究想法原文均未给出该符号的此取值）：不得由模型补全参数值，需作者确认或删除`,
    });
  }

  const components = facts.filter((fact) => fact.factKind === "component" && fact.status !== undefined);
  for (const { file, content } of texts) {
    for (const sentence of sentencesOf(file, content)) {
      const lower = sentence.prepared.toLowerCase();
      for (const fact of components) {
        const names = [fact.subject, ...fact.aliases].map((name) => name.toLowerCase()).filter((name) => name.length >= 2).sort((a, b) => b.length - a.length);
        const index = names.map((name) => ({ name, at: lower.indexOf(name) })).find((entry) => entry.at >= 0);
        if (index === undefined) continue;
        result.checkedComponentMentions += 1;
        const mention = classifyMention(sentence.prepared, index.at, index.name.length, file);
        const line = lineOf(sentence.content, sentence.start + (sentence.raw.length - sentence.raw.trimStart().length));
        const quote = quoteOf(sentence);
        const push = (code: MethodFactAuditCode, severity: "major" | "minor", authorDecisionRequired: boolean, detail: string) => result.findings.push({
          findingId: findingId(code, file, fact.subject, quote), code, severity, authorDecisionRequired, file, line, quote, subject: fact.subject, mentionClass: mention, factId: fact.factId, detail,
        });
        const status = fact.status!;
        if (status === "REMOVED" && mention === "asserted_current") {
          push("METHOD_COMPONENT_CONFLICT", "major", false, `组件「${fact.subject}」已由作者确认移除（REMOVED），此句把它写成当前方法的组成 / 作用机制；只能作为「已去掉 / 旧版曾使用」的说明（来源 ${fact.sourceLocator}）`);
        } else if (status === "ACTIVE" && mention === "negated") {
          push("METHOD_COMPONENT_CONFLICT", "major", false, `组件「${fact.subject}」经作者确认为当前方法的启用组件（ACTIVE），此句写成未采用 / 已移除（来源 ${fact.sourceLocator}）`);
        } else if (status === "PROPOSED" && mention === "asserted_current") {
          push("METHOD_COMPONENT_CONFLICT", "major", false, `组件「${fact.subject}」经作者确认只是拟议（PROPOSED），此句把它写成已实现的当前组件（来源 ${fact.sourceLocator}）`);
        } else if (status === "UNKNOWN" && (mention === "asserted_current" || mention === "negated")) {
          push("METHOD_COMPONENT_UNCONFIRMED", "minor", true, `组件「${fact.subject}」在当前方法中的状态未经作者确认（UNKNOWN），此句给出了确定状态：需作者裁决，不得由模型补完`);
        } else if (mention === "uncertain" && status !== "ACTIVE") {
          push("METHOD_COMPONENT_UNCERTAIN", "minor", true, `无法确定此句中的「${fact.subject}」是否指本文当前方法（作者确认状态 ${status}）：请作者核对表述`);
        } else {
          result.consistent.push({ file, line, subject: fact.subject, basis: `${status}:${mention}`, quote });
        }
      }
    }
  }
  return result;
}

/**
 * 修订补丁的方法事实守卫：只拒绝**本补丁新引入**的问题——
 *  - 与作者确认事实冲突的参数值 / 组件状态（按 code + 主体 + 取值计数，补丁后多于补丁前即新增）；
 *  - 新增的参数赋值（符号 + 取值）既无作者确认事实，也不是研究想法原文的作者陈述 → 无来源，fail closed。
 * 补丁前已存在、未被加重的问题不归咎于本补丁（由审稿继续报告）。
 */
export function methodFactPatchViolations(input: {
  file: string;
  before: string;
  after: string;
  state: MethodFactState;
  researchIdea?: string;
  metricKeys?: readonly string[];
}): Array<{ code: "METHOD_FACT_CONFLICT" | "UNSOURCED_SCIENTIFIC_NUMBER"; detail: string }> {
  const options = { stage: "revision_patch", ...(input.researchIdea !== undefined ? { researchIdea: input.researchIdea } : {}), ...(input.metricKeys !== undefined ? { metricKeys: input.metricKeys } : {}) };
  const before = auditMethodFacts([{ file: input.file, content: input.before }], input.state, options);
  const after = auditMethodFacts([{ file: input.file, content: input.after }], input.state, options);
  const keyOf = (finding: MethodFactAuditFinding) => [finding.code, finding.subject, finding.claimedValue ?? ""].join("|");
  const counts = new Map<string, number>();
  for (const finding of before.findings) counts.set(keyOf(finding), (counts.get(keyOf(finding)) ?? 0) + 1);
  const violations: Array<{ code: "METHOD_FACT_CONFLICT" | "UNSOURCED_SCIENTIFIC_NUMBER"; detail: string }> = [];
  for (const finding of after.findings) {
    const key = keyOf(finding);
    const remaining = counts.get(key) ?? 0;
    if (remaining > 0) { counts.set(key, remaining - 1); continue; }
    if (finding.code === "METHOD_PARAM_CONFLICT" || finding.code === "METHOD_COMPONENT_CONFLICT") {
      violations.push({ code: "METHOD_FACT_CONFLICT", detail: `METHOD_FACT_CONFLICT: ${finding.detail}；原句「${finding.quote.slice(0, 120)}」` });
    } else if (finding.code === "METHOD_PARAM_UNSOURCED") {
      violations.push({ code: "UNSOURCED_SCIENTIFIC_NUMBER", detail: `UNSOURCED_SCIENTIFIC_NUMBER: 修订新增参数 ${finding.subject}=${finding.claimedText ?? finding.claimedValue}，没有作者确认方法事实或作者原文支撑（配置名 / 变量名中的数字不是参数取值）：删除该取值或写明「未给出」，其余逐字保留` });
    }
  }
  return violations;
}

// ---------------------------------------------------------------- 候选抽取与事实表

/** 从研究想法原文确定性抽取候选（「符号 = 值」与「去掉 / 不使用 X」）；候选永远不是事实，需作者确认 */
export function extractMethodFactCandidates(researchIdea: string | undefined): MethodFactCandidate[] {
  if (researchIdea === undefined || researchIdea.trim() === "") return [];
  const candidates: MethodFactCandidate[] = [];
  const seen = new Set<string>();
  for (const claim of extractParameterClaims([{ file: "project.researchIdea", content: researchIdea }])) {
    const key = `p|${claim.symbol}|${claim.number.value}`;
    if (seen.has(key)) continue;
    seen.add(key);
    candidates.push({
      candidateId: `mfc-${sha256Hex(key).slice(0, 10)}`, factKind: "parameter", subject: claim.symbol, aliases: [], value: claim.number.value,
      valueText: claim.number.raw, sourceLocator: "project.researchIdea", quote: claim.quote, confirmationStatus: "candidate",
    });
  }
  const removal = /(去掉|去除|移除|删除|删去|取消|不使用|不采用|不含|不包含|without|removing|removed)\s*(?:了|掉)?\s*(?:the\s+)?([一-鿿A-Za-z][一-鿿A-Za-z\- ]{1,15}?)(?=[、，,；;。.（(）)\s]|$)/gi;
  for (const match of researchIdea.matchAll(removal)) {
    const subject = match[2]!.trim();
    const key = `c|${subject.toLowerCase()}`;
    if (subject.length < 2 || seen.has(key)) continue;
    seen.add(key);
    const start = Math.max(0, (match.index ?? 0) - 30);
    candidates.push({
      candidateId: `mfc-${sha256Hex(key).slice(0, 10)}`, factKind: "component", subject, aliases: [], status: "REMOVED",
      sourceLocator: "project.researchIdea", quote: researchIdea.slice(start, (match.index ?? 0) + match[0].length + 30).replace(/\s+/g, " "), confirmationStatus: "candidate",
    });
  }
  return candidates;
}

export interface MethodFactInput {
  factKind: MethodFactKind;
  subject: string;
  aliases?: string[];
  valueText?: string;
  unit?: string;
  status?: ComponentStatus;
  scope?: string[];
  sourceLocator?: string;
  note?: string;
}

/** 校验作者提交的事实（取值必须是可解析的科学数字；组件状态必须是四态之一）；返回问题列表 */
export function validateMethodFactInputs(inputs: unknown): { facts: MethodFactInput[]; problems: string[] } {
  const problems: string[] = [];
  const facts: MethodFactInput[] = [];
  if (!Array.isArray(inputs) || inputs.length === 0) return { facts, problems: ["facts 必须是非空数组"] };
  if (inputs.length > 200) return { facts, problems: ["facts 最多 200 条"] };
  const strings = (value: unknown, name: string, index: number): string[] => {
    if (value === undefined) return [];
    if (!Array.isArray(value) || value.some((entry) => typeof entry !== "string" || entry.length > 80)) { problems.push(`facts[${index}].${name} 必须是字符串数组（每项 ≤80 字）`); return []; }
    return (value as string[]).map((entry) => entry.trim()).filter((entry) => entry !== "");
  };
  inputs.forEach((raw, index) => {
    if (raw === null || typeof raw !== "object") { problems.push(`facts[${index}] 不是对象`); return; }
    const entry = raw as Record<string, unknown>;
    const kind = entry["factKind"];
    const subject = typeof entry["subject"] === "string" ? entry["subject"].trim() : "";
    if (kind !== "parameter" && kind !== "component") { problems.push(`facts[${index}].factKind 必须是 parameter / component`); return; }
    if (subject === "" || subject.length > 80) { problems.push(`facts[${index}].subject 必填（≤80 字）`); return; }
    const fact: MethodFactInput = { factKind: kind, subject, aliases: strings(entry["aliases"], "aliases", index), scope: strings(entry["scope"], "scope", index) };
    if (kind === "parameter") {
      const valueText = typeof entry["valueText"] === "string" ? entry["valueText"].trim() : typeof entry["valueText"] === "number" ? String(entry["valueText"]) : "";
      if (parseScientificNumber(valueText) === null) { problems.push(`facts[${index}]（${subject}）取值「${valueText.slice(0, 20)}」不是可解析的数字`); return; }
      fact.valueText = valueText;
      if (entry["unit"] !== undefined) {
        if (typeof entry["unit"] !== "string" || entry["unit"].length > 30) { problems.push(`facts[${index}].unit 必须是 ≤30 字的字符串`); return; }
        fact.unit = entry["unit"];
      }
    } else {
      const status = entry["status"];
      if (typeof status !== "string" || !(COMPONENT_STATUSES as readonly string[]).includes(status)) { problems.push(`facts[${index}]（${subject}）status 必须是 ${COMPONENT_STATUSES.join(" / ")}`); return; }
      fact.status = status as ComponentStatus;
    }
    for (const name of ["sourceLocator", "note"] as const) {
      const value = entry[name];
      if (value === undefined) continue;
      if (typeof value !== "string" || value.length > 300) { problems.push(`facts[${index}].${name} 必须是 ≤300 字的字符串`); return; }
      fact[name] = value;
    }
    facts.push(fact);
  });
  return { facts, problems };
}

export function buildMethodFactSheet(input: {
  sheetId: string; version: number; createdAt: string; facts: MethodFactInput[]; researchIdea: string | undefined; methodVersion?: string; note?: string;
}): MethodFactSheet {
  const facts: MethodFact[] = input.facts.map((fact) => {
    const parsed = fact.valueText !== undefined ? parseScientificNumber(fact.valueText) : null;
    const body = {
      factKind: fact.factKind, subject: fact.subject, aliases: fact.aliases ?? [],
      ...(parsed !== null ? { value: parsed.percent && fact.unit !== "percent" ? parsed.value / 100 : parsed.value, valueText: fact.valueText! } : {}),
      ...(fact.factKind === "parameter" ? { unit: fact.unit ?? "dimensionless" } : {}),
      ...(fact.status !== undefined ? { status: fact.status } : {}),
      scope: fact.scope ?? [],
      sourceLocator: fact.sourceLocator ?? "author:method-facts-form",
    };
    return {
      factId: `mf-${sha256Hex(JSON.stringify([body.factKind, body.subject, body.scope])).slice(0, 12)}`,
      ...body,
      confirmationStatus: "author_confirmed" as const, confirmedBy: "author" as const, confirmedAt: input.createdAt,
      ...(fact.note !== undefined ? { note: fact.note } : {}),
    };
  });
  const basis = { researchIdeaSha256: input.researchIdea !== undefined && input.researchIdea.trim() !== "" ? sha256Hex(input.researchIdea) : null };
  const hashed = { schema: METHOD_FACT_SHEET_SCHEMA, basis, facts, ...(input.methodVersion !== undefined ? { methodVersion: input.methodVersion } : {}) };
  return {
    schema: METHOD_FACT_SHEET_SCHEMA, sheetId: input.sheetId, version: input.version, createdAt: input.createdAt,
    ...(input.methodVersion !== undefined ? { methodVersion: input.methodVersion } : {}),
    basis, facts, ...(input.note !== undefined ? { note: input.note } : {}),
    contentHash: sha256Hex(JSON.stringify(hashed)),
  };
}

export function methodFactSheetHash(sheet: MethodFactSheet): string {
  return sha256Hex(JSON.stringify({ schema: sheet.schema, basis: sheet.basis, facts: sheet.facts, ...(sheet.methodVersion !== undefined ? { methodVersion: sheet.methodVersion } : {}) }));
}

/** 事实表有效性：内容哈希一致、未撤销、研究想法原文未变化（变化 → 失效，不悄悄继续使用旧事实） */
export function evaluateMethodFactState(input: {
  sheet: MethodFactSheet | null; pointerHash?: string; revoked?: { at: string; reason: string }; researchIdea: string | undefined; loadError?: string;
}): MethodFactState {
  const candidates = extractMethodFactCandidates(input.researchIdea);
  if (input.sheet === null) return { status: "none", candidates };
  const reasons: string[] = [];
  if (input.loadError !== undefined) reasons.push(input.loadError);
  if (input.revoked !== undefined) return { status: "revoked", sheet: input.sheet, reasons: [`作者于 ${input.revoked.at} 撤销：${input.revoked.reason}`], candidates };
  if (methodFactSheetHash(input.sheet) !== input.sheet.contentHash || (input.pointerHash !== undefined && input.pointerHash !== input.sheet.contentHash)) reasons.push("事实表内容哈希不符");
  const ideaHash = input.researchIdea !== undefined && input.researchIdea.trim() !== "" ? sha256Hex(input.researchIdea) : null;
  if (input.sheet.basis.researchIdeaSha256 !== ideaHash) reasons.push("研究想法原文已在确认后修改");
  return reasons.length > 0 ? { status: "stale", sheet: input.sheet, reasons, candidates } : { status: "valid", sheet: input.sheet, candidates };
}
