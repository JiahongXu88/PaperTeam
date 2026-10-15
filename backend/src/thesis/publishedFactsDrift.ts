/**
 * M14.2：published_facts_zero_drift 门禁（确定性）。
 *
 * 对象：作者已确认（author_confirmed）且被章节映射引用的 ScientificFact。
 * 对「学位论文正文 ↔ 已确认事实」做机械比对，输出三类：
 *   consistent        正文中出现该值（或受控等价形态）
 *   equivalent_format 经明确授权的格式等价（舍入 / 单位换算——复用 M14.1b
 *                     compareFactValues 的等价分类，不让模型判断"差不多"）
 *   unauthorized      正文声称该实验但数值与已确认值不一致（漂移）——FAIL
 *   absent            正文未提及该值——informational（未引用不是漂移）
 *
 * 不做：未映射事实的强制出现（作者可不引用）；对 extractedOnly/sourceVerified
 * 事实的数值约束（写作纪律层负责）；新数值的发明检测（Reviewer + claim
 * grounding 负责）。
 */

import { compareFactValues } from "./factValues.js";
import type { FactView } from "./researchInputTypes.js";

export type DriftStatus = "consistent" | "equivalent_format" | "unauthorized" | "absent";

export interface FactDriftFinding {
  factId: string;
  surface: string;
  status: DriftStatus;
  /** equivalent/unauthorized 时：正文中的实际数值形态 */
  observedValue?: string;
  detail: string;
}

export interface DriftReport {
  checked: number;
  consistent: number;
  equivalentFormat: number;
  unauthorized: number;
  absent: number;
  findings: FactDriftFinding[];
}

/** 数值 token：正文中的数字形态（含百分号 / 逗号千分位） */
const NUMERIC_TOKEN_PATTERN = /\d+(?:[,.]\d+)+|\d+(?:\.\d+)?/g;

/**
 * 剥离「非实验事实」的数字载体，防机械比对误报（确定性，无一模型判断）：
 * - 数学环境（equation/align/$...$/\(...\)/\[...\]）：符号系数不是实验结果；
 * - 引用 / 交叉引用参数（\cite{...}、\eqref{...}、\ref{...}、\label{...} 等）；
 * - 结构编号（表1 / 图2 / 式(3) / 第4章 / 步骤5 / eq:1）。
 * 这些位置的数字与「已确认实验数值」的邻域比对不构成漂移证据。
 */
export function stripNonFactualNumbers(text: string): string {
  return text
    .replace(/\\begin\{(equation|align|gather|multline|eqnarray|math|displaymath)\*?\}[\s\S]*?\\end\{\1\*?\}/g, " ")
    .replace(/\$\$[\s\S]*?\$\$/g, " ")
    .replace(/\$[^$\n]*\$/g, " ")
    .replace(/\\\(|\\\)/g, " ")
    .replace(/\\\[|\\\]/g, " ")
    .replace(/\\(?:cite|citep|citet|eqref|ref|autoref|label|bibliography|bibliographystyle|includegraphics|input|usepackage|documentclass)\*?(?:\[[^\]]*\])?\{[^{}]*\}/g, " ")
    .replace(/(?:表|图|式|例|章|节|步|附录)\s*\d+/g, " ")
    .replace(/第\s*\d+\s*(?:章|节|步|部分)/g, " ")
    .replace(/eq:\s*\w+/g, " ");
}

/**
 * 检查单条已确认事实相对正文的漂移。
 * - 正文含 fact.surface 的归一形态（空白不敏感）→ consistent；
 * - 否则做**句级锚定比对**（M14.3 真实案例修正）：数值比较只发生在「提及该
 *   事实锚词（subject/dataset/metric/protocol 归一形态，长度≥2）」的句子中：
 *   equal → consistent；rounding_difference / equal_after_unit_normalization →
 *   equivalent_format；邻域 value_mismatch → unauthorized；
 * - 无锚词可用（弱键：空 row label + 泛化列名 Year/No. 等）或正文无锚定句 →
 *   absent（机械比对无法定位该事实的声明位置——如实弃权，不猜）。
 *
 * 修正动机（案例 A 实测）：数据集统计表的年份（2010）/ 计数（2）等弱键事实
 * 在旧 ±10× 全文邻域下把章节里任何同数量级数字（如 555）判为「未授权变更」，
 * 31 处误报烧掉 gate。锚定后：真实指标漂移（句子提及方法/数据集/指标名 +
 * 数值不符）照常阻断；无关数值不再进入比对。
 */
export function checkFactDrift(fact: FactView, bodyText: string): FactDriftFinding {
  const stripped = stripNonFactualNumbers(bodyText);
  const normalizedBody = stripped.replace(/\s+/g, "");
  if (fact.surface !== "" && normalizedBody.includes(fact.surface.replace(/\s+/g, ""))) {
    return {
      factId: fact.factId,
      surface: fact.surface,
      status: "consistent",
      detail: "正文含已确认事实原文形态",
    };
  }
  const expected = parseValueTokens(fact.value.raw);
  if (expected.length === 0) {
    return {
      factId: fact.factId,
      surface: fact.surface,
      status: "consistent",
      detail: "非数值事实，按原文形态比对",
    };
  }
  // 句级锚定：拆句（小数点安全），筛含锚词的句子。
  // 锚词按字母数字/中文 token 拆分（剥掉 ↑↓ 等符号后缀，如表头 "S ↑" → "S"）；
  // 每个 token 以词边界出现（防 DUTS 里的 "s" 误锚；单字母指标 S/E/F 因此可用）。
  const anchors = anchorTermsOf(fact);
  const sentences = stripped
    .split(/(?<=[。；！？;])\s*|(?<=\n)|(?<=\.)(?=\s)/)
    .map((sentence) => sentence.trim())
    .filter((sentence) => sentence.length > 0);
  const anchored = anchors.length === 0
    ? []
    : sentences.filter((sentence) =>
        anchors.some((anchor) => anchor.tokens.every((token) => boundedMatch(sentence, token))),
      );
  if (anchored.length === 0) {
    return {
      factId: fact.factId,
      surface: fact.surface,
      status: "absent",
      detail:
        anchors.length === 0
          ? "弱键事实（无 subject/dataset/metric 锚词）无法机械定位声明句——不计入漂移比对"
          : "正文未在提及该事实锚词的句子中出现数值（未声称，不是漂移）",
    };
  }
  const observed = extractNumericTokens(anchored.join("\n"));
  if (observed.length === 0) {
    return {
      factId: fact.factId,
      surface: fact.surface,
      status: "absent",
      detail: "锚定句未出现数值形态（未声称，不是漂移）",
    };
  }
  let equivalent = false;
  let equivalentValue: string | undefined;
  let mismatch: { observed: string; classification: string } | undefined;
  for (const token of observed) {
    for (const exp of expected) {
      const outcome = compareFactValues(
        { raw: exp, numeric: toNumber(exp) },
        { raw: token, numeric: toNumber(token) },
      );
      if (outcome.outcome === "equal") {
        return { factId: fact.factId, surface: fact.surface, status: "consistent", detail: `正文数值 ${token} 与已确认值一致` };
      }
      if (outcome.outcome === "rounding_difference" || outcome.outcome === "equal_after_unit_normalization") {
        equivalent = true;
        equivalentValue = token;
      } else if (outcome.outcome === "value_mismatch") {
        // 只有当 token 落在期望值邻域（同数量级 ±10×）时才视为对该实验的改写，
        // 否则视为无关数值（正文必然充满其它合法数值）。
        const a = Math.abs(toNumber(exp) ?? 0);
        const b = Math.abs(toNumber(token) ?? 0);
        if (a > 0 && b > 0 && b >= a / 10 && b <= a * 10) {
          mismatch = mismatch ?? { observed: token, classification: outcome.outcome };
        }
      }
    }
  }
  if (equivalent) {
    return {
      factId: fact.factId,
      surface: fact.surface,
      status: "equivalent_format",
      ...(equivalentValue !== undefined ? { observedValue: equivalentValue } : {}),
      detail: "正文数值为已确认值的受控等价形态（舍入/单位换算）",
    };
  }
  if (mismatch !== undefined) {
    return {
      factId: fact.factId,
      surface: fact.surface,
      status: "unauthorized",
      observedValue: mismatch.observed,
      detail: `正文数值 ${mismatch.observed} 与已确认值 ${expected.join("/")} 不一致（未授权事实变更）`,
    };
  }
  return {
    factId: fact.factId,
    surface: fact.surface,
    status: "absent",
    detail: "正文锚定句未引用该已确认值（未声称，不是漂移）",
  };
}

/** 事实锚词：key 各字段拆为字母数字/中文 token（"S ↑" → ["S"]；"DUTS-TE" → ["DUTS","TE"]） */
function anchorTermsOf(fact: FactView): Array<{ raw: string; tokens: string[] }> {
  const raws = [fact.key.subject, fact.key.dataset, fact.key.metric, fact.key.protocol, fact.key.parameter].filter(
    (term): term is string => term !== undefined && term !== "",
  );
  const seen = new Set<string>();
  const anchors: Array<{ raw: string; tokens: string[] }> = [];
  for (const raw of raws) {
    const tokens = raw.toLowerCase().split(/[^a-z0-9一-鿿]+/).filter((token) => token !== "");
    if (tokens.length === 0) continue;
    const signature = tokens.join(" ");
    if (seen.has(signature)) continue;
    seen.add(signature);
    anchors.push({ raw, tokens });
  }
  return anchors;
}

/** 词边界匹配（大小写不敏感；中文 token 直接包含即可） */
function boundedMatch(sentence: string, token: string): boolean {
  if (/[一-鿿]/.test(token)) {
    return sentence.includes(token);
  }
  return new RegExp(`(^|[^A-Za-z0-9])${token.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^A-Za-z0-9]|$)`, "iu").test(sentence);
}

export function summarizeDrift(findings: readonly FactDriftFinding[]): DriftReport {
  const report: DriftReport = {
    checked: findings.length,
    consistent: findings.filter((item) => item.status === "consistent").length,
    equivalentFormat: findings.filter((item) => item.status === "equivalent_format").length,
    unauthorized: findings.filter((item) => item.status === "unauthorized").length,
    absent: findings.filter((item) => item.status === "absent").length,
    findings: [...findings],
  };
  return report;
}

function parseValueTokens(raw: string): string[] {
  return [...raw.matchAll(NUMERIC_TOKEN_PATTERN)].map((match) => match[0]);
}

function extractNumericTokens(text: string): string[] {
  return [...text.matchAll(NUMERIC_TOKEN_PATTERN)].map((match) => match[0]);
}

function toNumber(token: string): number | undefined {
  const normalized = token.replace(/,/g, "");
  const value = Number(normalized);
  return Number.isFinite(value) ? value : undefined;
}
