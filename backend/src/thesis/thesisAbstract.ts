/**
 * M14.6：学位论文摘要与关键词生成（正文写完之后的收口阶段）。
 *
 * 定位：从「已确认的研究主线 / 贡献 / 已确认科研事实 / 已写正文（有界投影）/
 * 受限模式章节」生成中英文摘要 + 关键词，并用**确定性门禁**保证摘要不会引入
 * 正文不支持的结果：
 *   - 摘要中的每个具体数值必须逐字（或受控等价形态）出自已确认事实表或正文；
 *   - 中英文摘要的数值集合必须一致；
 *   - 受限模式章节不得被写成已完成成果；
 *   - 不得出现 LaTeX 命令与内部流程措辞。
 *
 * 本模块只做「生成 + 核验」，不落盘：调用方（workflow 阶段）拿到 draft 与
 * violations 后自行决定是否写入 ThesisDocumentModel.abstractZh/abstractEn/
 * keywordsZh/keywordsEn。门禁永不静默改写数值——只报告，不修正。
 */

import { AgentRunFailedError, BusinessError } from "../errors.js";
import type { AgentRuntime, AgentRunUsage } from "../runtime/types.js";
import { extractJsonObject } from "../agents/outputParsing.js";
import { compareFactValues, normalizeSurfaceText, parseFactValue } from "./factValues.js";
import type { FactView } from "./researchInputTypes.js";
import type { ThesisChapterPlan, ThesisContribution, ThesisStoryline } from "./thesisWorkflowTypes.js";

// ---------------------------------------------------------------------------
// 公开类型
// ---------------------------------------------------------------------------

export interface ThesisAbstractInput {
  projectTitle: string;
  documentType: "master_thesis" | "doctoral_thesis" | string;
  language: "zh";
  storyline: ThesisStoryline | null;
  /** 章节规划；limitationMode=true 表示该章以「材料缺失 / 受限」模式写作 */
  chapters: ReadonlyArray<ThesisChapterPlan & { limitationMode?: boolean }>;
  /** 仅已确认（confirmed）的贡献 */
  contributions: ReadonlyArray<Pick<ThesisContribution, "id" | "kind" | "statement">>;
  /** 作者已确认的科研事实（摘要数值的唯一合法来源之一，另一来源是已过门禁的正文） */
  confirmedFacts: ReadonlyArray<FactView>;
  /** 已写正文（LaTeX 节文本） */
  sections: ReadonlyArray<{ file: string; chapterId: string; title: string; content: string }>;
  /** 已存在的摘要 / 关键词：存在时要求模型「更新」而非重写 */
  existing?: { abstractZh?: string; abstractEn?: string; keywordsZh?: string[]; keywordsEn?: string[] };
}

export interface ThesisAbstractDraft {
  abstractZh: string;
  abstractEn: string;
  keywordsZh: string[];
  keywordsEn: string[];
}

export type AbstractFactViolationCode =
  | "number_not_in_body"
  | "number_not_in_facts_or_body"
  | "zh_en_number_mismatch"
  | "future_work_as_done"
  | "limitation_chapter_claimed_done"
  | "third_party_as_own"
  | "keyword_not_grounded"
  | "keyword_count"
  | "length"
  | "latex_in_abstract"
  | "meta_note";

export interface AbstractFactViolation {
  code: AbstractFactViolationCode;
  detail: string;
  token?: string;
}

export interface ThesisAbstractCheckResult {
  ok: boolean;
  violations: AbstractFactViolation[];
  advisories: AbstractFactViolation[];
}

export interface ThesisAbstractGenerateResult {
  draft: ThesisAbstractDraft;
  violations: AbstractFactViolation[];
  advisories: AbstractFactViolation[];
  attempts: number;
  taskIds: string[];
  usage?: Record<string, number>;
}

// ---------------------------------------------------------------------------
// 预算常量
// ---------------------------------------------------------------------------

const NARRATIVE_BUDGET = 800;
const CHAPTER_HEAD_BUDGET = 600;
const CHAPTER_TOTAL_BUDGET = 9000;
const FACT_TABLE_MAX_LINES = 30;
const EXISTING_ABSTRACT_BUDGET = 2000;

/** 门禁硬边界（比提示词中的目标区间宽松：目标区间是写作要求，硬边界是契约） */
const ZH_LENGTH_BOUNDS = { min: 200, max: 1500 } as const;
const EN_WORD_BOUNDS = { min: 100, max: 700 } as const;
const KEYWORD_COUNT_BOUNDS = { min: 3, max: 6 } as const;

// ---------------------------------------------------------------------------
// 提示词
// ---------------------------------------------------------------------------

function lengthTargets(documentType: string): { zh: string; en: string } {
  const lower = documentType.toLowerCase();
  if (lower.includes("doctor") || lower.includes("phd")) {
    return { zh: "600–1200 字（博士学位论文）", en: "200–500 词" };
  }
  if (lower.includes("master")) {
    return { zh: "400–800 字（硕士学位论文）", en: "200–500 词" };
  }
  return { zh: "400–1200 字", en: "200–500 词" };
}

function clip(text: string, budget: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= budget ? normalized : `${normalized.slice(0, budget)}…（已截断）`;
}

/** 事实表一行：surface + 可比性键描述 */
function describeFactKey(fact: FactView): string {
  const parts: string[] = [];
  const key = fact.key;
  if (key.subject !== undefined && key.subject !== "") parts.push(`对象=${key.subject}`);
  if (key.dataset !== undefined && key.dataset !== "") parts.push(`数据集=${key.dataset}`);
  if (key.metric !== undefined && key.metric !== "") parts.push(`指标=${key.metric}`);
  if (key.condition !== undefined && key.condition !== "") parts.push(`条件=${key.condition}`);
  if (key.protocol !== undefined && key.protocol !== "") parts.push(`协议=${key.protocol}`);
  if (key.parameter !== undefined && key.parameter !== "") parts.push(`参数=${key.parameter}`);
  return parts.length > 0 ? parts.join("，") : fact.kind;
}

/** 章节的有界正文投影：首节前 ~600 字 + 含已确认事实原文形态的句子 */
function chapterExcerpt(
  chapter: ThesisChapterPlan,
  sections: ThesisAbstractInput["sections"],
  factSurfaces: readonly string[],
  budget: number,
): string {
  const own = sections.filter((section) => section.chapterId === chapter.chapterId);
  const ordered = [
    ...chapter.sectionFiles.map((file) => own.find((section) => section.file === file)).filter((s): s is NonNullable<typeof s> => s !== undefined),
    ...own.filter((section) => !chapter.sectionFiles.includes(section.file)),
  ];
  if (ordered.length === 0) {
    return "（本章尚无正文）";
  }
  const first = ordered[0];
  const head = first !== undefined ? clip(stripLatexToPlain(first.content), Math.min(CHAPTER_HEAD_BUDGET, budget)) : "";
  const factSentences: string[] = [];
  if (factSurfaces.length > 0) {
    for (const section of ordered) {
      for (const sentence of splitSentencesZh(stripLatexToPlain(section.content))) {
        const compact = sentence.replace(/\s+/g, "");
        if (factSurfaces.some((surface) => compact.includes(surface)) && !head.includes(sentence.trim())) {
          factSentences.push(sentence.trim());
        }
      }
    }
  }
  let text = head;
  for (const sentence of factSentences) {
    if (text.length + sentence.length + 1 > budget) break;
    text += `\n${sentence}`;
  }
  return text;
}

export function buildThesisAbstractPrompt(input: ThesisAbstractInput): string {
  const targets = lengthTargets(input.documentType);
  const lines: string[] = [];
  lines.push("# 角色：学位论文摘要撰写");
  lines.push(
    "你负责为一篇已完成正文写作的学位论文撰写中英文摘要与关键词。摘要只能概括正文已经写出的内容，不得新增任何正文没有依据的实验结果。",
  );
  lines.push("");
  lines.push(`## 论文题目\n${input.projectTitle}`);
  lines.push("");

  // 研究主线
  lines.push("## 研究主线（已确认）");
  if (input.storyline !== null) {
    lines.push(clip(input.storyline.narrative, NARRATIVE_BUDGET));
    lines.push(`主线结构：${input.storyline.structure}`);
    if (input.storyline.scopeConcerns !== undefined && input.storyline.scopeConcerns.length > 0) {
      lines.push(`范围问题：${input.storyline.scopeConcerns.map((item) => clip(item, 200)).join("；")}`);
    }
  } else {
    lines.push("（未提供研究主线；以贡献列表与正文为准）");
  }
  lines.push("");

  // 贡献
  lines.push("## 研究贡献（已确认，摘要中「本文提出 / 本文工作」只能指这些）");
  if (input.contributions.length === 0) {
    lines.push("（无已确认贡献——摘要不得声称任何创新成果，只概括研究内容）");
  } else {
    for (const contribution of input.contributions) {
      lines.push(`- [${contribution.kind}] ${clip(contribution.statement, 300)}`);
    }
  }
  lines.push("");

  // 事实表
  lines.push("## 已确认科研事实表（摘要中具体数值的唯一合法来源；逐字使用，不得改写精度）");
  if (input.confirmedFacts.length === 0) {
    lines.push("（无已确认事实——摘要不得出现任何具体实验数值）");
  } else {
    const shown = input.confirmedFacts.slice(0, FACT_TABLE_MAX_LINES);
    for (const fact of shown) {
      lines.push(`- ${normalizeSurfaceText(fact.surface)}｜${describeFactKey(fact)}`);
    }
    if (input.confirmedFacts.length > shown.length) {
      lines.push(`（另有 ${input.confirmedFacts.length - shown.length} 条已确认事实未列出；未列出的数值不得写入摘要）`);
    }
  }
  lines.push("");

  // 章节与投影
  const factSurfaces = input.confirmedFacts.map((fact) => normalizeSurfaceText(fact.surface).replace(/\s+/g, "")).filter((s) => s !== "");
  const limitationChapters = input.chapters.filter((chapter) => chapter.limitationMode === true);
  lines.push("## 章节与正文投影（有界摘录，仅供概括）");
  let remaining = CHAPTER_TOTAL_BUDGET;
  for (const chapter of input.chapters) {
    const flag = chapter.limitationMode === true ? "【受限模式】" : "";
    lines.push(`### ${chapter.titleZh} ${flag}（${chapter.responsibility}）`);
    lines.push(`目标：${clip(chapter.goal, 200)}`);
    if (remaining <= 0) {
      lines.push("（正文投影预算已用尽，本章摘录省略）");
      continue;
    }
    const excerpt = chapterExcerpt(chapter, input.sections, factSurfaces, remaining);
    remaining -= excerpt.length;
    lines.push(excerpt);
    lines.push("");
  }

  // 受限章节
  lines.push("## 受限模式章节（材料缺失 / 实验未开展）");
  if (limitationChapters.length === 0) {
    lines.push("（无）");
  } else {
    for (const chapter of limitationChapters) {
      const reasons = chapter.missingMaterials !== undefined && chapter.missingMaterials.length > 0
        ? `缺失材料：${chapter.missingMaterials.map((m) => clip(m, 120)).join("；")}`
        : "缺失材料未逐项列出";
      lines.push(`- ${chapter.titleZh}（${reasons}）`);
    }
    lines.push(
      "以上章节在摘要中只能描述为「未开展 / 受限 / 有待后续工作」，绝不能写成已完成、已验证、已取得的结果；也不要为其编造任何数值。",
    );
  }
  lines.push("");

  // 既有摘要
  if (input.existing !== undefined) {
    const { abstractZh, abstractEn, keywordsZh, keywordsEn } = input.existing;
    const hasAny =
      (abstractZh !== undefined && abstractZh.trim() !== "") ||
      (abstractEn !== undefined && abstractEn.trim() !== "") ||
      (keywordsZh !== undefined && keywordsZh.length > 0) ||
      (keywordsEn !== undefined && keywordsEn.length > 0);
    if (hasAny) {
      lines.push("## 既有摘要与关键词（请在此基础上更新，而不是从零重写；已有且仍被正文支持的事实陈述须保留）");
      if (abstractZh !== undefined && abstractZh.trim() !== "") lines.push(`中文摘要：${clip(abstractZh, EXISTING_ABSTRACT_BUDGET)}`);
      if (abstractEn !== undefined && abstractEn.trim() !== "") lines.push(`英文摘要：${clip(abstractEn, EXISTING_ABSTRACT_BUDGET)}`);
      if (keywordsZh !== undefined && keywordsZh.length > 0) lines.push(`中文关键词：${keywordsZh.join("；")}`);
      if (keywordsEn !== undefined && keywordsEn.length > 0) lines.push(`英文关键词：${keywordsEn.join("; ")}`);
      lines.push("");
    }
  }

  // 纪律
  lines.push("## 写作纪律（逐条遵守）");
  lines.push("1. 摘要中的每个具体数值必须逐字出自已确认事实表或正文；不得改写精度，不得四舍五入出新的数字。");
  lines.push("2. 不得新增正文没有依据的实验结果；不得夸大；没有数值依据的结论只能定性表述。");
  lines.push("3. 不把待完成实验写成已完成；受限模式章节按「未开展 / 受限」口径描述。");
  lines.push("4. 不把综述中第三方工作写成本文成果；第三方方法只能以「已有研究」口径出现，「本文提出」只能指上面的已确认贡献。");
  lines.push("5. 中英文摘要的科研事实（数值、方法名、数据集）必须一致：中文出现的数值英文也必须出现，且形态等价；反之亦然。");
  lines.push("6. 关键词 3–6 个（中英文各自），来自研究主题 / 方法 / 对象，不得编造；英文关键词与中文关键词一一对应。");
  lines.push(`7. 中文摘要 ${targets.zh}；英文摘要 ${targets.en}。`);
  lines.push("8. 纯文本：无 LaTeX 命令、无花括号、无 Markdown；不出现任何内部流程措辞（如工作流、提示词、待作者确认、本轮等）。");
  lines.push("");
  lines.push("## 输出契约");
  lines.push("只输出一个 JSON 对象，不要任何解释文字：");
  lines.push('{"abstractZh":"...","abstractEn":"...","keywordsZh":["...","..."],"keywordsEn":["...","..."]}');
  return lines.join("\n");
}

function buildRepairPrompt(basePrompt: string, previousOutput: string, problems: readonly string[]): string {
  return [
    basePrompt,
    "",
    "## 上一轮输出（需要修复）",
    clip(previousOutput, 6000),
    "",
    "## 修复以下问题，不得引入新数值",
    ...problems.map((problem, index) => `${index + 1}. ${problem}`),
    "",
    "修复方式：删除或改为定性表述没有依据的数值；补齐中英文不一致的数值；受限章节改为「未开展 / 受限」口径；去掉 LaTeX 与流程措辞。",
    "仍然只输出一个 JSON 对象。",
  ].join("\n");
}

// ---------------------------------------------------------------------------
// 解析
// ---------------------------------------------------------------------------

function readStringField(record: Record<string, unknown>, field: string): string {
  const value = record[field];
  if (typeof value !== "string" || value.trim() === "") {
    throw new BusinessError("STAGE_CONTRACT_VIOLATION", `摘要输出缺少非空字符串字段 ${field}`);
  }
  return value.trim();
}

function readKeywordsField(record: Record<string, unknown>, field: string): string[] {
  const value = record[field];
  if (!Array.isArray(value)) {
    throw new BusinessError("STAGE_CONTRACT_VIOLATION", `摘要输出缺少数组字段 ${field}`);
  }
  const items: string[] = [];
  for (const item of value) {
    if (typeof item !== "string") {
      throw new BusinessError("STAGE_CONTRACT_VIOLATION", `摘要输出字段 ${field} 含非字符串元素`);
    }
    const trimmed = item.trim();
    if (trimmed !== "") items.push(trimmed);
  }
  return items;
}

/** 解析模型输出为摘要草稿；形状不合法抛 BusinessError("STAGE_CONTRACT_VIOLATION") */
export function parseThesisAbstractOutput(raw: string): ThesisAbstractDraft {
  let record: Record<string, unknown>;
  try {
    record = extractJsonObject(raw, "学位论文摘要");
  } catch (error) {
    throw new BusinessError("STAGE_CONTRACT_VIOLATION", (error as Error).message);
  }
  return {
    abstractZh: readStringField(record, "abstractZh"),
    abstractEn: readStringField(record, "abstractEn"),
    keywordsZh: readKeywordsField(record, "keywordsZh"),
    keywordsEn: readKeywordsField(record, "keywordsEn"),
  };
}

// ---------------------------------------------------------------------------
// 文本工具
// ---------------------------------------------------------------------------

/** LaTeX → 纯文本（保留 \% 为百分号；去掉命令、数学、引用、花括号） */
export function stripLatexToPlain(latex: string): string {
  // 占位符用 U+0001（正文中不可能出现的控制字符），避免在源码里写转义序列
  const ESCAPED_PERCENT = String.fromCharCode(1);
  let text = latex.replace(/\r\n/g, "\n").replace(/\\%/g, ESCAPED_PERCENT);
  text = text.replace(/\\(?:sub)*section\*?\{[^{}]*\}/g, "\n");
  text = text.replace(/\\(?:label|ref|eqref|pageref|autoref|cref)\{[^{}]*\}/g, " ");
  text = text.replace(/\\(?:cite|citep|citet|citealp|parencite|textcite|autocite)\*?(?:\[[^\]\n]*\])*\{[^{}]*\}/g, " ");
  text = text.replace(/\\begin\{[^{}]*\}|\\end\{[^{}]*\}/g, "\n");
  text = text.replace(/\$\$[\s\S]*?\$\$|\\\[[\s\S]*?\\\]|\\\([\s\S]*?\\\)|\$[^$\n]*\$/g, " ");
  for (let i = 0; i < 3; i += 1) {
    text = text.replace(/\\[A-Za-z]+\*?(?:\[[^\]\n]*\])?\{([^{}]*)\}/g, "$1");
  }
  text = text.replace(/\\[A-Za-z]+\*?/g, " ");
  text = text.replace(/[{}~]/g, " ");
  text = text.replace(/%[^\n]*/g, " ");
  text = text.replace(new RegExp(ESCAPED_PERCENT, "g"), "%");
  return text;
}

function splitSentencesZh(text: string): string[] {
  return text.split(/[。！？；!?\n]+/).map((s) => s.trim()).filter((s) => s !== "");
}

/**
 * 数值 token 化（与 publishedFactsDrift 同风格）：
 *   - 先剥离年份（19xx/20xx）、章节序号（第3章 / 3章）、表图式编号、
 *     后接计数单位（章|节|个|种|类|篇|步|阶段）的 ≤12 小整数；
 *   - 再匹配 `[-−]?\d+(?:[.,]\d+)*[%‰]?`（负号只在非字母数字之后才算入）。
 */
export function extractAbstractNumbers(text: string): string[] {
  let normalized = normalizeSurfaceText(text);
  normalized = normalized
    .replace(/第\s*\d+\s*(?:章|节|部分|步|阶段)/g, " ")
    .replace(/(?<![\d.])\d+\s*章/g, " ")
    .replace(/(?:表|图|式|例|附录|Table|Figure|Fig\.|Eq\.)\s*\d+/g, " ")
    .replace(/(?<![\d.])(\d{1,2})\s*(?=章|节|个|种|类|篇|步|阶段)/g, (match, digits: string) => (Number(digits) <= 12 ? " " : match))
    .replace(/(?<![\d.])(?:19|20)\d{2}(?![\d.%‰])\s*(?:年|年代)?/g, " ");
  const pattern = /(?<![\d.,])(?:(?<![A-Za-z0-9_])[-−])?\d+(?:[.,]\d+)*[%‰]?/g;
  const tokens: string[] = [];
  for (const match of normalized.matchAll(pattern)) {
    const token = match[0].replace("−", "-");
    tokens.push(token);
  }
  return tokens;
}

function numericKey(token: string): string {
  return normalizeSurfaceText(token).replace(/\s+/g, "");
}

function decimalsOf(token: string): number {
  const match = /\.(\d+)/.exec(token.replace(/,/g, ""));
  return match?.[1]?.length ?? 0;
}

type NumberMatch = "verbatim" | "equivalent" | "none";

/**
 * 摘要数值 token 是否被来源 token 支持：
 *   verbatim    归一文本相等；
 *   equivalent  数值相等（含单位换算），或摘要形态是来源的**更粗**舍入（不允许摘要比来源更精确）。
 */
function matchAgainst(token: string, sources: ReadonlySet<string>): NumberMatch {
  const key = numericKey(token);
  if (sources.has(key)) return "verbatim";
  const parsed = parseFactValue(token);
  if (parsed.numeric === undefined) return "none";
  for (const source of sources) {
    const candidate = parseFactValue(source);
    if (candidate.numeric === undefined) continue;
    const outcome = compareFactValues(parsed, candidate);
    if (outcome.outcome === "equal" || outcome.outcome === "equal_after_unit_normalization") return "equivalent";
    if (outcome.outcome === "rounding_difference" && decimalsOf(token) <= decimalsOf(source)) return "equivalent";
  }
  return "none";
}

/** 中英文数值集合是否等价（只认相等 / 单位换算相等；舍入差异视为不一致） */
function hasExactCounterpart(token: string, others: readonly string[]): boolean {
  const key = numericKey(token);
  const parsed = parseFactValue(token);
  for (const other of others) {
    if (numericKey(other) === key) return true;
    if (parsed.numeric === undefined) continue;
    const candidate = parseFactValue(other);
    if (candidate.numeric === undefined) continue;
    const outcome = compareFactValues(parsed, candidate);
    if (outcome.outcome === "equal" || outcome.outcome === "equal_after_unit_normalization") return true;
  }
  return false;
}

function normalizeForGrounding(text: string): string {
  return normalizeSurfaceText(text).replace(/[\s、，,。．.：:；;（）()\[\]「」《》""'']+/g, "").toLowerCase();
}

function ngrams(text: string, n: number): Set<string> {
  const grams = new Set<string>();
  for (let i = 0; i + n <= text.length; i += 1) {
    grams.add(text.slice(i, i + n));
  }
  return grams;
}

function countZhChars(text: string): number {
  return text.replace(/\s+/g, "").length;
}

function countEnWords(text: string): number {
  return text.split(/\s+/).filter((word) => /[A-Za-z0-9]/.test(word)).length;
}

// ---------------------------------------------------------------------------
// 确定性门禁
// ---------------------------------------------------------------------------

const DONE_CLAIM_PATTERN = /完成|验证了|实现了|取得|表明/;
const FUTURE_PATTERN = /未来|后续/;
const DONE_STRICT_PATTERN = /已完成|已验证/;
const OWN_CLAIM_PATTERN = /本文提出|我们提出/;
const LATEX_PATTERN = /\\[a-zA-Z]+|[{}]/;
const META_NOTE_PATTERN = /工作流|workflow|提示词|科研事实纪律|待作者确认|本轮/i;
const NUMERIC_KEYWORD_PATTERN = /^[-−+\d.,%‰\s]+$/;

export function checkThesisAbstractFacts(draft: ThesisAbstractDraft, input: ThesisAbstractInput): ThesisAbstractCheckResult {
  const violations: AbstractFactViolation[] = [];
  const advisories: AbstractFactViolation[] = [];

  // --- 来源数值集合 ---
  const bodyPlain = input.sections.map((section) => stripLatexToPlain(section.content)).join("\n");
  const bodyNumbers = new Set(extractAbstractNumbers(bodyPlain).map(numericKey));
  const factNumbers = new Set<string>();
  for (const fact of input.confirmedFacts) {
    for (const token of extractAbstractNumbers(fact.surface)) factNumbers.add(numericKey(token));
    for (const token of extractAbstractNumbers(fact.value.raw)) factNumbers.add(numericKey(token));
  }

  // --- 数值溯源 ---
  const zhNumbers = extractAbstractNumbers(draft.abstractZh);
  const enNumbers = extractAbstractNumbers(draft.abstractEn);
  const seenTokens = new Set<string>();
  for (const { token, lang } of [
    ...zhNumbers.map((token) => ({ token, lang: "中文" })),
    ...enNumbers.map((token) => ({ token, lang: "英文" })),
  ]) {
    const key = `${lang}:${numericKey(token)}`;
    if (seenTokens.has(key)) continue;
    seenTokens.add(key);
    const inBody = matchAgainst(token, bodyNumbers);
    const inFacts = matchAgainst(token, factNumbers);
    if (inBody === "none" && inFacts === "none") {
      violations.push({
        code: "number_not_in_facts_or_body",
        token,
        detail: `${lang}摘要中的数值 ${token} 既不在已确认事实表也不在正文中（疑似编造或改写精度）`,
      });
    } else if (inBody === "none") {
      advisories.push({
        code: "number_not_in_body",
        token,
        detail: `${lang}摘要中的数值 ${token} 出自已确认事实表，但正文未写出该数值`,
      });
    }
  }

  // --- 中英文数值一致 ---
  for (const token of zhNumbers) {
    if (!hasExactCounterpart(token, enNumbers)) {
      violations.push({ code: "zh_en_number_mismatch", token, detail: `中文摘要数值 ${token} 在英文摘要中没有等价形态` });
    }
  }
  for (const token of enNumbers) {
    if (!hasExactCounterpart(token, zhNumbers)) {
      violations.push({ code: "zh_en_number_mismatch", token, detail: `英文摘要数值 ${token} 在中文摘要中没有等价形态` });
    }
  }

  // --- 受限章节 / 未来工作 / 第三方 ---
  const zhSentences = splitSentencesZh(draft.abstractZh);
  for (const chapter of input.chapters) {
    if (chapter.limitationMode !== true) continue;
    const title = chapter.titleZh.trim();
    const needles = [title, title.slice(0, 6)].filter((needle) => needle.length >= 2);
    for (const sentence of zhSentences) {
      if (needles.some((needle) => sentence.includes(needle)) && DONE_CLAIM_PATTERN.test(sentence)) {
        violations.push({
          code: "limitation_chapter_claimed_done",
          token: title,
          detail: `受限模式章节「${title}」被写成已完成结果：「${clip(sentence, 80)}」`,
        });
        break;
      }
    }
  }
  for (const sentence of zhSentences) {
    if (DONE_STRICT_PATTERN.test(sentence) && FUTURE_PATTERN.test(sentence)) {
      violations.push({ code: "future_work_as_done", detail: `同一句既称已完成/已验证又指向未来/后续工作（自相矛盾）：「${clip(sentence, 80)}」` });
    }
  }
  if (input.contributions.length > 0) {
    const ownGrams = new Set<string>();
    for (const contribution of input.contributions) {
      for (const gram of ngrams(normalizeForGrounding(contribution.statement), 4)) ownGrams.add(gram);
    }
    for (const sentence of zhSentences) {
      if (!OWN_CLAIM_PATTERN.test(sentence)) continue;
      const grams = ngrams(normalizeForGrounding(sentence), 4);
      let overlap = false;
      for (const gram of grams) {
        if (ownGrams.has(gram)) {
          overlap = true;
          break;
        }
      }
      if (!overlap) {
        advisories.push({ code: "third_party_as_own", detail: `「本文提出」句与任何已确认贡献陈述无重叠，可能把第三方工作写成本文成果：「${clip(sentence, 80)}」` });
      }
    }
  }

  // --- 关键词 ---
  const groundingCorpus = normalizeForGrounding(
    [
      input.projectTitle,
      input.storyline?.narrative ?? "",
      ...input.contributions.map((c) => c.statement),
      ...input.chapters.map((c) => `${c.titleZh} ${c.goal}`),
      ...input.sections.map((s) => s.title),
      bodyPlain,
    ].join("\n"),
  );
  for (const [lang, keywords] of [["中文", draft.keywordsZh], ["英文", draft.keywordsEn]] as const) {
    if (keywords.length < KEYWORD_COUNT_BOUNDS.min || keywords.length > KEYWORD_COUNT_BOUNDS.max) {
      violations.push({ code: "keyword_count", detail: `${lang}关键词应为 ${KEYWORD_COUNT_BOUNDS.min}–${KEYWORD_COUNT_BOUNDS.max} 个，实际 ${keywords.length} 个` });
    }
    for (const keyword of keywords) {
      if (LATEX_PATTERN.test(keyword)) {
        violations.push({ code: "latex_in_abstract", token: keyword, detail: `${lang}关键词含 LaTeX 命令或花括号：${keyword}` });
      } else if (NUMERIC_KEYWORD_PATTERN.test(keyword)) {
        violations.push({ code: "keyword_not_grounded", token: keyword, detail: `${lang}关键词是数字：${keyword}` });
      } else if (lang === "中文" && !groundingCorpus.includes(normalizeForGrounding(keyword))) {
        advisories.push({ code: "keyword_not_grounded", token: keyword, detail: `中文关键词「${keyword}」未在题目 / 主线 / 贡献 / 正文中逐字出现` });
      }
    }
  }

  // --- LaTeX / 流程措辞 ---
  for (const [lang, text] of [["中文", draft.abstractZh], ["英文", draft.abstractEn]] as const) {
    const latex = LATEX_PATTERN.exec(text);
    if (latex !== null) {
      violations.push({ code: "latex_in_abstract", token: latex[0], detail: `${lang}摘要含 LaTeX 命令或花括号：${latex[0]}` });
    }
    const meta = META_NOTE_PATTERN.exec(text);
    if (meta !== null) {
      violations.push({ code: "meta_note", token: meta[0], detail: `${lang}摘要含内部流程措辞：${meta[0]}` });
    }
  }

  // --- 长度 ---
  const zhLength = countZhChars(draft.abstractZh);
  if (zhLength < ZH_LENGTH_BOUNDS.min || zhLength > ZH_LENGTH_BOUNDS.max) {
    violations.push({ code: "length", detail: `中文摘要 ${zhLength} 字，超出 ${ZH_LENGTH_BOUNDS.min}–${ZH_LENGTH_BOUNDS.max} 字边界` });
  }
  const enWords = countEnWords(draft.abstractEn);
  if (enWords < EN_WORD_BOUNDS.min || enWords > EN_WORD_BOUNDS.max) {
    violations.push({ code: "length", detail: `英文摘要 ${enWords} 词，超出 ${EN_WORD_BOUNDS.min}–${EN_WORD_BOUNDS.max} 词边界` });
  }

  return { ok: violations.length === 0, violations, advisories };
}

// ---------------------------------------------------------------------------
// 服务
// ---------------------------------------------------------------------------

function accumulateUsage(target: Record<string, number> | undefined, usage: AgentRunUsage | undefined): Record<string, number> | undefined {
  if (usage === undefined) return target;
  const acc = target ?? {};
  acc.inputTokens = (acc.inputTokens ?? 0) + usage.inputTokens;
  acc.outputTokens = (acc.outputTokens ?? 0) + usage.outputTokens;
  acc.cacheReadTokens = (acc.cacheReadTokens ?? 0) + usage.cacheReadTokens;
  acc.cacheWriteTokens = (acc.cacheWriteTokens ?? 0) + usage.cacheWriteTokens;
  acc.assistantTurns = (acc.assistantTurns ?? 0) + usage.assistantTurns;
  if (usage.estimatedCost !== undefined) {
    acc.estimatedCost = (acc.estimatedCost ?? 0) + usage.estimatedCost;
  }
  return acc;
}

export class ThesisAbstractService {
  private readonly runtime: AgentRuntime;
  private readonly agentId: string;
  private readonly log: (message: string) => void;

  constructor(options: { runtime: AgentRuntime; agentId: string; log?: (message: string) => void }) {
    this.runtime = options.runtime;
    this.agentId = options.agentId;
    this.log = options.log ?? (() => {});
  }

  /**
   * 一次生成 → 解析 → 核验；有阻断违规且允许修复时追加一次修复调用（把违规清单
   * 附回提示词），再核验。返回最终草稿与违规清单，由调用方决定是否保存。
   * 永不静默修改数值。
   */
  async generate(
    input: ThesisAbstractInput,
    options: { projectId: string; maxRepairAttempts?: number } = { projectId: "" },
  ): Promise<ThesisAbstractGenerateResult> {
    const maxRepairAttempts = Math.max(0, options.maxRepairAttempts ?? 1);
    const basePrompt = buildThesisAbstractPrompt(input);
    const taskIds: string[] = [];
    let usage: Record<string, number> | undefined;
    let lastOutput = "";
    let problems: string[] = [];
    let best: { draft: ThesisAbstractDraft; check: ThesisAbstractCheckResult } | undefined;
    let lastParseError: BusinessError | undefined;
    let attempts = 0;

    for (let attempt = 0; attempt <= maxRepairAttempts; attempt += 1) {
      attempts = attempt + 1;
      const task = await this.runtime.runAgent({
        agentId: this.agentId,
        task: attempt === 0 ? basePrompt : buildRepairPrompt(basePrompt, lastOutput, problems),
        projectId: options.projectId,
        contextScope: "thesis/abstract",
        metadata: { role: "writer", skill: "thesis-abstract", ...(attempt > 0 ? { structuredRepairAttempt: attempt } : {}) },
      });
      taskIds.push(task.taskId);
      usage = accumulateUsage(usage, task.usage);
      if (task.status !== "completed") {
        throw new AgentRunFailedError(task.error ?? `摘要生成任务以 ${task.status} 状态结束`);
      }
      lastOutput = task.output ?? "";
      let draft: ThesisAbstractDraft;
      try {
        draft = parseThesisAbstractOutput(lastOutput);
      } catch (error) {
        lastParseError = error as BusinessError;
        problems = [`输出形状不合法：${(error as Error).message}`];
        this.log(`[thesis-abstract] 第 ${attempts} 次输出解析失败：${(error as Error).message}`);
        continue;
      }
      const check = checkThesisAbstractFacts(draft, input);
      best = { draft, check };
      if (check.ok) {
        this.log(`[thesis-abstract] 第 ${attempts} 次通过门禁（advisories=${check.advisories.length}）`);
        break;
      }
      problems = check.violations.map((violation) => `[${violation.code}] ${violation.detail}`);
      this.log(`[thesis-abstract] 第 ${attempts} 次门禁违规 ${check.violations.length} 条：${problems.join("；")}`);
    }

    if (best === undefined) {
      throw lastParseError ?? new BusinessError("STAGE_CONTRACT_VIOLATION", "摘要生成没有产生可解析的输出");
    }
    return {
      draft: best.draft,
      violations: best.check.violations,
      advisories: best.check.advisories,
      attempts,
      taskIds,
      ...(usage !== undefined ? { usage } : {}),
    };
  }
}
