/**
 * M17.2 实验数值主张的确定性核查（零模型）：把稿件中关于实验结果的「幅度」与「显著性」表述对照当前冻结的实验事实快照。
 *
 * 检查项（只认快照；快照之外的数字不做任何推断）：
 *  - EXP_PP_PERCENT_CONFUSION：写成「X%」的提升等于快照里的百分点差（或写成「X 个百分点」却等于相对变化）——
 *    「HOTA 提升 2.6%」实为 +2.580 pp（相对 +5.46%）是本类典型；
 *  - EXP_DELTA_NOT_IN_SNAPSHOT：幅度既不等于该指标任何确定性对比的百分点差，也不等于相对变化（按显示精度区间）；
 *  - EXP_DELTA_WITHOUT_COMPARISON：给出了幅度，但快照中该指标没有任何可比较对（缺基线 / 协议不明 / 跨数据集）；
 *  - EXP_UNTESTED_SIGNIFICANCE：实验语境中出现「显著优于 / statistically significant / p<0.05」，快照没有任何统计检验；
 *  - EXP_SNAPSHOT_STALE：快照已失效（源变化 / 授权撤回），稿件中的实验数值需作者重新确认。
 *
 * 一致的主张同样登记（consistent），附对比 id 与操作数来源定位——Reviewer / 作者可以从正文数字反查到源文件单元格。
 * 本模块只证明「稿件幅度与快照复算是否一致」，不证明实验真实、不做外部核验。
 */

import { sha256Hex } from "../util/hash.js";
import { displayInterval, type Interval } from "./derivedFormula.js";
import { lineOf } from "./claimAuditText.js";
import { plainLatexText } from "./latexTable.js";
import type { ExperimentFact, FactComparison, FactSnapshot } from "../experiments/factSnapshot.js";

export const EXPERIMENT_FACT_AUDIT_SCHEMA = "paperteam.experiment-fact-audit/v1";

export type ExperimentFactAuditCode =
  | "EXP_PP_PERCENT_CONFUSION"
  | "EXP_DELTA_NOT_IN_SNAPSHOT"
  | "EXP_DELTA_WITHOUT_COMPARISON"
  | "EXP_UNTESTED_SIGNIFICANCE"
  | "EXP_SNAPSHOT_STALE";

export interface ExperimentFactAuditFinding {
  findingId: string;
  code: ExperimentFactAuditCode;
  severity: "major" | "minor";
  file: string;
  line: number;
  quote: string;
  metric?: string;
  claimedValue?: number;
  claimedKind?: "pp" | "percent";
  detail: string;
  matchedComparisonIds: string[];
  /** 涉及对比的操作数来源（sha256 · 文件 · 行列 / JSON path） */
  operandLocators: string[];
}

export interface ExperimentFactAuditResult {
  schema: typeof EXPERIMENT_FACT_AUDIT_SCHEMA;
  snapshotId: string;
  snapshotContentHash: string;
  snapshotStatus: "valid" | "stale";
  checkedClaims: number;
  consistent: Array<{ file: string; line: number; quote: string; metric: string; claimedValue: number; claimedKind: "pp" | "percent"; comparisonId: string; operandLocators: string[] }>;
  /** 无法归属到具体指标且与任何对比都不一致的幅度（不出 finding：宁可漏报不误报；供人工复核） */
  unbound: Array<{ file: string; line: number; quote: string; claimedValue: number; claimedKind: "pp" | "percent" }>;
  findings: ExperimentFactAuditFinding[];
}

const SENTENCE_END = /[。！？!?；;]/;
const CHANGE_CUE = /(提升|提高|增加|增长|上升|下降|降低|减少|改善|改进|领先|超出|高出|低出|优于|差距|相对|improv\w*|increas\w*|gain\w*|boost\w*|reduc\w*|decreas\w*|drop\w*|higher|lower|outperform\w*|\bby\b)/i;
const PP_CLAIM = /([+\-−]?\d+(?:\.\d+)?)\s*(?:个)?\s*(?:百分点|percentage[\s-]points?|pp\b|p\.p\.)/gi;
const PERCENT_CLAIM = /([+\-−]?\d+(?:\.\d+)?)\s*[%％]/g;
const SIGNIFICANCE = /(显著(?:地)?(?:优于|高于|低于|好于|提升|提高|改善|降低|减少|增加|超过|领先|差异)|统计(?:学)?(?:意义上|上)?显著|significantly\s+(?:better|outperform\w*|improv\w*|higher|lower|reduc\w*|increas\w*|decreas\w*|exceed\w*)|statistically\s+significant|\bp\s*[<≤=]\s*0?\.\d+|\bp\s*-?\s*value\s*[<≤=]|p\s*值\s*[<≤=])/i;
const NEGATED = /(不|未|没有|无|并非|not|no)\s*$/i;

interface Sentence { file: string; raw: string; start: number; content: string; plain: string }

function stripComments(content: string): string {
  return content.replace(/(^|[^\\])%[^\n]*/g, (match, prefix: string) => prefix + " ".repeat(match.length - prefix.length));
}

function sentencesOf(file: string, content: string): Sentence[] {
  const text = stripComments(content);
  const result: Sentence[] = [];
  let start = 0;
  const flush = (end: number) => {
    const raw = text.slice(start, end);
    if (raw.trim() !== "") result.push({ file, raw, start, content, plain: plainLatexText(raw) });
    start = end;
  };
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]!;
    if (SENTENCE_END.test(char)) flush(index + 1);
    else if (char === "." && /\s/.test(text[index + 1] ?? " ") && !/\d/.test(text[index - 1] ?? "")) flush(index + 1);
    else if (char === "\n" && text[index + 1] === "\n") flush(index + 1);
  }
  flush(text.length);
  return result;
}

function decimalsOf(raw: string): number {
  return /\.(\d+)/.exec(raw)?.[1]?.length ?? 0;
}

function absInterval(interval: Interval): Interval {
  if (interval.lo >= 0) return interval;
  if (interval.hi <= 0) return { lo: -interval.hi, hi: -interval.lo };
  return { lo: 0, hi: Math.max(-interval.lo, interval.hi) };
}

function overlaps(a: Interval, b: Interval): boolean {
  const epsilon = 1e-9 * Math.max(1, Math.abs(a.hi), Math.abs(b.hi));
  return a.lo <= b.hi + epsilon && b.lo <= a.hi + epsilon;
}

function metricPattern(metric: string): RegExp {
  const escaped = metric.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`(^|[^A-Za-z0-9])${escaped}(?=$|[^A-Za-z0-9])`, "i");
}

function quoteOf(sentence: Sentence): string {
  return sentence.raw.replace(/\s+/g, " ").trim().slice(0, 200);
}

function findingIdOf(code: string, file: string, quote: string, value?: number): string {
  return `efa-${sha256Hex([code, file, quote, value ?? ""].join("|")).slice(0, 12)}`;
}

export function auditExperimentFacts(
  files: ReadonlyArray<{ file: string; content: string }>,
  snapshot: FactSnapshot,
  status: "valid" | "stale",
): ExperimentFactAuditResult {
  const result: ExperimentFactAuditResult = {
    schema: EXPERIMENT_FACT_AUDIT_SCHEMA, snapshotId: snapshot.snapshotId, snapshotContentHash: snapshot.contentHash, snapshotStatus: status,
    checkedClaims: 0, consistent: [], unbound: [], findings: [],
  };
  if (status === "stale") {
    result.findings.push({
      findingId: findingIdOf("EXP_SNAPSHOT_STALE", "", snapshot.snapshotId), code: "EXP_SNAPSHOT_STALE", severity: "minor", file: files[0]?.file ?? "main.tex", line: 1, quote: "",
      detail: `实验事实快照 ${snapshot.snapshotId} 已失效：稿件中的实验数值与对比暂无有效快照支撑，需作者重新确认并冻结后复核`,
      matchedComparisonIds: [], operandLocators: [],
    });
    return result;
  }
  const factsById = new Map<string, ExperimentFact>(snapshot.facts.map((fact) => [fact.factId, fact]));
  const metricKeys = [...new Set(snapshot.facts.map((fact) => fact.metricKey))].filter((key) => key.length >= 2).sort((a, b) => b.length - a.length);
  const metricRegexes = metricKeys.map((key) => [key, metricPattern(key)] as const);
  const methodLabels = [...new Set(snapshot.facts.map((fact) => (fact.method ?? "").trim()).filter((label) => label.length >= 3))];
  const datasetLabels = [...new Set(snapshot.facts.map((fact) => (fact.dataset ?? "").trim()).filter((label) => label.length >= 3))];
  const locators = (comparison: FactComparison) => comparison.operandRefs.map((id) => factsById.get(id)?.sourceLocator ?? id);

  for (const { file, content } of files) {
    for (const sentence of sentencesOf(file, content)) {
      const plain = sentence.plain;
      const mentioned = metricRegexes.filter(([, regex]) => regex.test(plain)).map(([key]) => key);
      // 方法名比较忽略下划线（LaTeX 里 ma\\_x 与未转义的 ma_x 经纯文本化后写法不同）
      const lowered = plain.toLowerCase().replace(/_/g, "");
      const methodsMentioned = methodLabels.filter((label) => lowered.includes(label.toLowerCase().replace(/_/g, "")));
      const datasetsMentioned = datasetLabels.filter((label) => lowered.includes(label.toLowerCase()));
      const experimental = mentioned.length > 0 || methodsMentioned.length > 0;
      const line = lineOf(sentence.content, sentence.start + (sentence.raw.length - sentence.raw.trimStart().length));
      const quote = quoteOf(sentence);

      // 显著性 / p 值：实验语境 + 快照无统计检验 → finding
      const significance = SIGNIFICANCE.exec(plain);
      if (experimental && significance !== null && !NEGATED.test(plain.slice(Math.max(0, significance.index - 4), significance.index)) && snapshot.statisticalTests.length === 0) {
        result.findings.push({
          findingId: findingIdOf("EXP_UNTESTED_SIGNIFICANCE", file, quote), code: "EXP_UNTESTED_SIGNIFICANCE", severity: "major", file, line, quote,
          detail: `稿件声称统计显著（「${significance[0]}」），但实验事实快照 ${snapshot.snapshotId} 的来源没有任何统计检验（单次确定性结果）：删除显著性表述，或补充真实检验数据后重新冻结`,
          matchedComparisonIds: [], operandLocators: [],
        });
      }
      if (mentioned.length === 0) continue;

      const claims: Array<{ value: number; raw: string; kind: "pp" | "percent"; index: number }> = [];
      for (const match of plain.matchAll(PP_CLAIM)) claims.push({ value: Number(match[1]!.replace("−", "-")), raw: match[1]!, kind: "pp", index: match.index ?? 0 });
      for (const match of plain.matchAll(PERCENT_CLAIM)) {
        const index = match.index ?? 0;
        if (claims.some((claim) => claim.kind === "pp" && claim.index === index)) continue;
        // 只有变化语境（提升 / 降低 / improved by …）里的 % 才是幅度；「HOTA 为 48.0%」是水平值
        if (!CHANGE_CUE.test(plain.slice(Math.max(0, index - 18), index))) continue;
        claims.push({ value: Number(match[1]!.replace("−", "-")), raw: match[1]!, kind: "percent", index });
      }
      for (const claim of claims) {
        // 指标归属：数字之前最近提到的指标；数字之前没有任何快照指标名（如「身份切换次数 … 相对减少 x%」）时不猜归属——
        // 与快照全部对比核对：一致即记一致，否则记 unbound 不出 finding（M17.2 真实运行：退化归属曾把 IDSW 的 x% 误判到同句后文的 AssA）
        const before = plain.slice(0, claim.index);
        const located = mentioned
          .map((key) => {
            const regex = metricPattern(key);
            let last = -1;
            for (let offset = 0; offset < before.length;) {
              const found = regex.exec(before.slice(offset));
              if (found === null) break;
              last = offset + found.index;
              offset = last + found[0].length;
            }
            return { key, last };
          })
          .sort((a, b) => b.last - a.last);
        const attributed = located[0]!.last >= 0;
        const metric = attributed ? located[0]!.key : "(未归属)";
        result.checkedClaims += 1;
        if (!attributed) {
          const claimedAny = absInterval(displayInterval(Math.abs(claim.value), decimalsOf(claim.raw)));
          const hit = snapshot.comparisons.find((comparison) => claim.kind === "pp"
            ? comparison.absoluteDifference.unitLabel === "pp" && overlaps(claimedAny, absInterval(comparison.absoluteDifference.interval))
            : comparison.relativeChange !== null && overlaps(claimedAny, absInterval(comparison.relativeChange.interval)));
          if (hit !== undefined) result.consistent.push({ file, line, quote, metric: hit.context.metricKey, claimedValue: claim.value, claimedKind: claim.kind, comparisonId: hit.comparisonId, operandLocators: locators(hit) });
          else result.unbound.push({ file, line, quote, claimedValue: claim.value, claimedKind: claim.kind });
          continue;
        }
        let candidates = snapshot.comparisons.filter((comparison) => comparison.context.metricKey === metric);
        // 句中提到 ≥2 个方法时要求对比双方都被提及（「A 比 base …」不应绑定到 B 对 base；M17.2 真实数据负例重放）
        const named = (method: string) => methodsMentioned.some((label) => method.toLowerCase().replace(/_/g, "") === label.toLowerCase().replace(/_/g, ""));
        const narrowed = candidates.filter((comparison) =>
          (methodsMentioned.length === 0 ||
            (methodsMentioned.length >= 2 ? named(comparison.subject.method) && named(comparison.reference.method) : named(comparison.subject.method) || named(comparison.reference.method))) &&
          (datasetsMentioned.length === 0 || datasetsMentioned.some((label) => comparison.context.dataset.toLowerCase() === label.toLowerCase())));
        if (narrowed.length > 0) candidates = narrowed;
        if (candidates.length === 0) {
          result.findings.push({
            findingId: findingIdOf("EXP_DELTA_WITHOUT_COMPARISON", file, quote, claim.value), code: "EXP_DELTA_WITHOUT_COMPARISON", severity: "major", file, line, quote,
            metric, claimedValue: claim.value, claimedKind: claim.kind,
            detail: `稿件给出 ${metric} 的变化幅度 ${claim.raw}${claim.kind === "pp" ? " 个百分点" : "%"}，但快照 ${snapshot.snapshotId} 中该指标没有任何可比较对（缺基线、协议 / 单位不明或跨数据集）：只能报告原始数值`,
            matchedComparisonIds: [], operandLocators: [],
          });
          continue;
        }
        const claimed = absInterval(displayInterval(Math.abs(claim.value), decimalsOf(claim.raw)));
        const absMatches = candidates.filter((comparison) => overlaps(claimed, absInterval(comparison.absoluteDifference.interval)));
        const relMatches = candidates.filter((comparison) => comparison.relativeChange !== null && overlaps(claimed, absInterval(comparison.relativeChange.interval)));
        const proportionAbs = absMatches.filter((comparison) => comparison.absoluteDifference.unitLabel === "pp");
        if (claim.kind === "pp" ? proportionAbs.length > 0 : relMatches.length > 0) {
          const hit = (claim.kind === "pp" ? proportionAbs : relMatches)[0]!;
          result.consistent.push({ file, line, quote, metric, claimedValue: claim.value, claimedKind: claim.kind, comparisonId: hit.comparisonId, operandLocators: locators(hit) });
          continue;
        }
        const confusion = claim.kind === "pp" ? relMatches : proportionAbs;
        if (confusion.length > 0) {
          const hit = confusion[0]!;
          result.findings.push({
            findingId: findingIdOf("EXP_PP_PERCENT_CONFUSION", file, quote, claim.value), code: "EXP_PP_PERCENT_CONFUSION", severity: "major", file, line, quote,
            metric, claimedValue: claim.value, claimedKind: claim.kind,
            detail: claim.kind === "percent"
              ? `稿件写 ${metric} 变化「${claim.raw}%」，但该数值等于快照对比 ${hit.comparisonId} 的绝对差 ${hit.absoluteDifference.value.toFixed(hit.absoluteDifference.displayDecimals)} 个百分点（${hit.subject.method} 对 ${hit.reference.method}）；相对变化应为 ${hit.relativeChange !== null ? `${hit.relativeChange.value.toFixed(hit.relativeChange.displayDecimals)}%` : "不可算"}。百分点差不得写成 %`
              : `稿件写 ${metric} 变化「${claim.raw} 个百分点」，但该数值等于快照对比 ${hit.comparisonId} 的相对变化 ${hit.relativeChange?.value.toFixed(hit.relativeChange.displayDecimals) ?? "?"}%；绝对差应为 ${hit.absoluteDifference.value.toFixed(hit.absoluteDifference.displayDecimals)} 个百分点`,
            matchedComparisonIds: [hit.comparisonId], operandLocators: locators(hit),
          });
          continue;
        }
        // % 数值若等于该指标某个事实的水平值（如「提升至 55.49%」），是水平不是幅度：不判
        if (claim.kind === "percent" && snapshot.facts.some((fact) => fact.metricKey === metric && fact.unit === "percentage" && overlaps(claimed, absInterval(displayInterval(fact.value, decimalsOf(fact.rawText ?? String(fact.value))))))) continue;
        result.findings.push({
          findingId: findingIdOf("EXP_DELTA_NOT_IN_SNAPSHOT", file, quote, claim.value), code: "EXP_DELTA_NOT_IN_SNAPSHOT", severity: "major", file, line, quote,
          metric, claimedValue: claim.value, claimedKind: claim.kind,
          detail: `稿件给出的 ${metric} 变化幅度 ${claim.raw}${claim.kind === "pp" ? " 个百分点" : "%"} 与快照 ${snapshot.snapshotId} 中该指标的 ${candidates.length} 个确定性对比都不一致（例：${candidates.slice(0, 2).map((comparison) => `${comparison.subject.method} 对 ${comparison.reference.method} ${comparison.absoluteDifference.value.toFixed(comparison.absoluteDifference.displayDecimals)} pp / ${comparison.relativeChange?.value.toFixed(comparison.relativeChange.displayDecimals) ?? "-"}%`).join("；")}）`,
          matchedComparisonIds: candidates.slice(0, 3).map((comparison) => comparison.comparisonId), operandLocators: candidates.slice(0, 1).flatMap(locators),
        });
      }
    }
  }
  return result;
}
