/**
 * M17.2 实验事实快照（experiment-fact-snapshot/v1）：把「作者确认 + 授权进入工作流」的指标观测冻结为可版本化、
 * 可追溯的实验事实，并在冻结时确定性地给出冲突分类与可比较对（零模型、零自由表达式）。
 *
 * 纪律：
 *  - 快照只收录已确认 + 已授权范围的观测（资格边界与 workflowContext 相同）；导入不是 Evidence 认证通道——
 *    快照事实的最高状态是 author_confirmed（作者确认 + 源哈希绑定），永远不是外部核验；
 *  - 冲突（同键不同值 / 版本冲突 / 标度未确认 / 汇总 vs 逐次运行不符）未裁决前不得冻结；作者可排除任一方事实
 *    （原件与审计轨迹不变）；
 *  - 只在同数据集 + 同划分 + 同协议 + 同子集 + 同指标 + 已知且同量纲单位时生成对比；协议 / 单位不明只展示原始值；
 *  - 绝对差（百分点 pp）与相对变化（%）分开计算，均带操作数引用、公式（derivedFormula AST）、显示精度区间与舍入规则；
 *  - 来源没有统计检验 → statisticalTests 恒为空；任何「显著」表述都没有快照支撑。
 */

import { sha256Hex } from "../util/hash.js";
import { displayInterval, evaluateFormula, renderFormula, type FormulaAtom, type FormulaNode, type Interval } from "../review/derivedFormula.js";
import { decimalsOf, toCanonical, unitDimension, type ExperimentUnit, type UnitBasis } from "./metricUnits.js";

export const FACT_SNAPSHOT_SCHEMA = "paperteam.experiment-fact-snapshot/v1";
const MAX_COMPARISONS = 2_000;
const MAX_NOT_COMPARABLE = 200;

/** 评测器汇总行标签（TrackEval COMBINED 等）：与「未分子集的整体结果」视为同一子集 */
const AGGREGATE_SUBSETS = new Set(["", "combined", "all", "overall", "total", "pooled"]);

export type FactConflictCode =
  | "SAME_KEY_DIFFERENT_VALUE"
  | "VERSION_CONFLICT"
  | "UNIT_SCALE_UNRESOLVED"
  | "AGGREGATE_VS_RUN_MISMATCH";
export type NotComparableCode = "PROTOCOL_NOT_COMPARABLE" | "MISSING_REQUIRED_METADATA" | "UNIT_NOT_COMPARABLE";

/** 快照输入：一条已确认 + 已授权的观测（携带包与文件哈希） */
export interface SnapshotInputObservation {
  packageId: string;
  packageHash: string;
  fileHash: string;
  groupId: string;
  groupRole: "main" | "baseline" | "ablation" | "other";
  scopeId: string;
  confirmedAt?: string;
  sourceId: string;
  path: string;
  blockId: string;
  sheet?: string;
  row?: number;
  column?: string;
  jsonPath?: string;
  method?: string;
  dataset?: string;
  split?: string;
  protocol?: string;
  seed?: string;
  subset?: string;
  version?: string;
  metric: string;
  value: number;
  rawText?: string;
  unit: ExperimentUnit;
  unitBasis?: UnitBasis;
  direction: "higher" | "lower" | "unknown";
  authorFilled?: string[];
}

export interface ExperimentFact extends SnapshotInputObservation {
  factId: string;
  /** 规范化指标键（TrackEval detailed 的 HOTA___AUC ≡ HOTA；大写叶子名） */
  metricKey: string;
  /** source_verified：解析单元格与源文件哈希绑定；author_confirmed：另经作者确认该范围（快照只收录这一级） */
  verificationStatus: "author_confirmed";
  sourceLocator: string;
}

export interface FactConflict {
  conflictId: string;
  code: FactConflictCode;
  key: string;
  factIds: string[];
  detail: string;
  /** 双方来源（文件 / 定位 / 原始文本 / 单位） */
  sides: Array<{ factId: string; sourceLocator: string; rawText?: string; value: number; unit: ExperimentUnit; version?: string; packageId: string }>;
}

export interface DerivedQuantity {
  value: number;
  interval: Interval;
  formula: FormulaNode;
  formulaText: string;
  /** 结果单位标签：pp = 百分点（两个百分数之差）；percent_relative = 相对变化百分比 */
  unitLabel: "pp" | "percent_relative" | ExperimentUnit;
  displayDecimals: number;
  rounding: string;
}

export interface FactComparison {
  comparisonId: string;
  context: { dataset: string; split: string; protocol: string; subset: string; metricKey: string };
  subject: { factId: string; method: string; role: SnapshotInputObservation["groupRole"]; value: number };
  reference: { factId: string; method: string; role: SnapshotInputObservation["groupRole"]; value: number };
  kind: "vs_baseline" | "ablation_vs_main";
  canonicalUnit: ExperimentUnit;
  direction: "higher" | "lower" | "unknown";
  absoluteDifference: DerivedQuantity;
  relativeChange: DerivedQuantity | null;
  relativeChangeUnavailable?: string;
  /** 方向已知且区间不重叠才判定优劣；否则 tie / unknown */
  outcome: "subject_better" | "reference_better" | "tie_within_rounding" | "direction_unknown";
  operandRefs: string[];
  limitations: string[];
}

export interface NotComparablePair {
  code: NotComparableCode;
  metricKey: string;
  factIds: [string, string];
  detail: string;
}

export interface SeedAggregate {
  aggregateId: string;
  key: string;
  factIds: string[];
  n: number;
  mean: number;
  sampleStd: number | null;
  formulaText: string;
}

export interface FactSnapshotBuild {
  facts: ExperimentFact[];
  excluded: Array<{ factId: string; reason: string }>;
  conflicts: FactConflict[];
  comparisons: FactComparison[];
  notComparable: NotComparablePair[];
  seedAggregates: SeedAggregate[];
  /** 来源中可用于「显著性」的统计检验：M17.2 只登记来源显式提供的检验——当前解析器不提取，恒为空 */
  statisticalTests: [];
  limitations: string[];
}

export interface FactSnapshot extends FactSnapshotBuild {
  schema: typeof FACT_SNAPSHOT_SCHEMA;
  snapshotId: string;
  version: number;
  createdAt: string;
  createdBy: "author";
  basedOn: Array<{ packageId: string; packageHash: string }>;
  contentHash: string;
  note?: string;
}

export function metricKeyOf(metric: string): string {
  const leaf = (metric.split(/[./]/).pop() ?? metric).trim();
  // TrackEval detailed.csv：HOTA___AUC 等于 summary 的 HOTA（同一指标的 α 积分值）；其余 ___<α> 列是逐阈值分量，保持原名
  return leaf.replace(/___AUC$/i, "").toUpperCase();
}

function norm(value: string | undefined): string {
  return (value ?? "").normalize("NFKC").trim().toLowerCase();
}

function subsetKey(subset: string | undefined): string {
  const key = norm(subset);
  return AGGREGATE_SUBSETS.has(key) ? "" : key;
}

export function locatorOf(observation: Pick<SnapshotInputObservation, "fileHash" | "path" | "sheet" | "row" | "column" | "jsonPath">): string {
  const parts = [`sha256:${observation.fileHash.slice(0, 16)}`, observation.path];
  if (observation.sheet !== undefined) parts.push(`sheet=${observation.sheet}`);
  if (observation.jsonPath !== undefined) parts.push(`json=${observation.jsonPath}`);
  if (observation.row !== undefined) parts.push(`row=${observation.row}`);
  if (observation.column !== undefined) parts.push(`col=${observation.column}`);
  return parts.join(" · ");
}

export function factIdOf(observation: Pick<SnapshotInputObservation, "packageHash" | "path" | "blockId" | "row" | "column" | "jsonPath" | "metric">): string {
  return `f-${sha256Hex([observation.packageHash, observation.path, observation.blockId, observation.row ?? "", observation.column ?? "", observation.jsonPath ?? "", observation.metric].join("\u0000")).slice(0, 16)}`;
}

function toFact(observation: SnapshotInputObservation): ExperimentFact {
  return { ...observation, factId: factIdOf(observation), metricKey: metricKeyOf(observation.metric), verificationStatus: "author_confirmed", sourceLocator: locatorOf(observation) };
}

/** 同一实验量的键（不含 seed / version：二者用于区分 run 与版本冲突） */
function quantityKey(fact: ExperimentFact): string {
  return [norm(fact.dataset), norm(fact.split), norm(fact.protocol), norm(fact.method), subsetKey(fact.subset), fact.metricKey].join("|");
}

function factInterval(fact: ExperimentFact): Interval {
  return displayInterval(fact.value, fact.rawText !== undefined ? decimalsOf(fact.rawText) : 15);
}

function canonicalInterval(fact: ExperimentFact): Interval | null {
  const canonical = toCanonical(1, fact.unit);
  if (canonical === null) return null;
  const interval = factInterval(fact);
  const factor = canonical.value;
  return factor >= 0 ? { lo: interval.lo * factor, hi: interval.hi * factor } : { lo: interval.hi * factor, hi: interval.lo * factor };
}

function overlap(a: Interval, b: Interval): boolean {
  const epsilon = 1e-9 * Math.max(1, Math.abs(a.lo), Math.abs(b.lo));
  return a.lo <= b.hi + epsilon && b.lo <= a.hi + epsilon;
}

function sameValue(a: ExperimentFact, b: ExperimentFact): "equal" | "different" | "scale_ambiguous" {
  if (a.unit !== "unknown" && b.unit !== "unknown") {
    if (unitDimension(a.unit) !== unitDimension(b.unit)) return "different";
    const ia = canonicalInterval(a);
    const ib = canonicalInterval(b);
    return ia !== null && ib !== null && overlap(ia, ib) ? "equal" : "different";
  }
  const ia = factInterval(a);
  const ib = factInterval(b);
  if (overlap(ia, ib)) return "equal";
  // 一方或双方单位未知：恰差 100 倍（显示精度内）= 比例 / 百分数标度未确认，不能判同值也不能判冲突
  for (const [x, y] of [[ia, ib], [ib, ia]] as const) {
    if (overlap({ lo: x.lo * 100, hi: x.hi * 100 }, y)) return "scale_ambiguous";
  }
  return "different";
}

function conflictId(code: string, factIds: string[]): string {
  return `fc-${sha256Hex([code, ...[...factIds].sort()].join("|")).slice(0, 12)}`;
}

function side(fact: ExperimentFact): FactConflict["sides"][number] {
  return { factId: fact.factId, sourceLocator: fact.sourceLocator, ...(fact.rawText !== undefined ? { rawText: fact.rawText } : {}), value: fact.value, unit: fact.unit, ...(fact.version !== undefined ? { version: fact.version } : {}), packageId: fact.packageId };
}

function findConflicts(facts: ExperimentFact[]): { conflicts: FactConflict[]; seedAggregates: SeedAggregate[] } {
  const conflicts: FactConflict[] = [];
  const seedAggregates: SeedAggregate[] = [];
  const byKey = new Map<string, ExperimentFact[]>();
  for (const fact of facts) {
    if (norm(fact.method) === "" || norm(fact.dataset) === "") continue; // 缺身份 metadata：不参与同键比较（另记不可比）
    const key = quantityKey(fact);
    byKey.set(key, [...(byKey.get(key) ?? []), fact]);
  }
  for (const [key, group] of byKey) {
    // 同 seed（含都无 seed）内两两比较；不同 seed 是不同 run，不是冲突
    const bySeed = new Map<string, ExperimentFact[]>();
    for (const fact of group) bySeed.set(norm(fact.seed), [...(bySeed.get(norm(fact.seed)) ?? []), fact]);
    for (const [, runFacts] of bySeed) {
      for (let i = 0; i < runFacts.length; i += 1) {
        for (let j = i + 1; j < runFacts.length; j += 1) {
          const a = runFacts[i]!;
          const b = runFacts[j]!;
          const relation = sameValue(a, b);
          if (relation === "equal") continue;
          const versionDiffers = norm(a.version) !== norm(b.version);
          const code: FactConflictCode = relation === "scale_ambiguous" ? "UNIT_SCALE_UNRESOLVED" : versionDiffers ? "VERSION_CONFLICT" : "SAME_KEY_DIFFERENT_VALUE";
          const detail = code === "UNIT_SCALE_UNRESOLVED"
            ? `同一实验量在两处数值相差 100 倍且单位未声明（${a.rawText ?? a.value} vs ${b.rawText ?? b.value}）：可能是比例与百分数两种标度，需作者在文件 metadata 声明单位`
            : code === "VERSION_CONFLICT"
              ? `同一实验量在不同版本（${a.version ?? "未标版本"} / ${b.version ?? "未标版本"}）取值不同：需作者选择最终版本`
              : `同一实验量（同数据集 / 划分 / 协议 / 方法 / 子集 / seed / 指标）出现不同取值：需作者裁决`;
          conflicts.push({ conflictId: conflictId(code, [a.factId, b.factId]), code, key, factIds: [a.factId, b.factId], detail, sides: [side(a), side(b)] });
        }
      }
    }
    // 多 seed：系统复算均值 / 样本标准差；与作者给出的无 seed 汇总值不符 → AGGREGATE_VS_RUN_MISMATCH
    const runs = group.filter((fact) => norm(fact.seed) !== "");
    const seeds = new Set(runs.map((fact) => norm(fact.seed)));
    if (seeds.size >= 2 && seeds.size === runs.length) {
      const units = new Set(runs.map((fact) => fact.unit));
      if (units.size === 1) {
        const values = runs.map((fact) => fact.value);
        const mean = values.reduce((sum, value) => sum + value, 0) / values.length;
        const variance = values.reduce((sum, value) => sum + (value - mean) ** 2, 0) / (values.length - 1);
        const aggregate: SeedAggregate = {
          aggregateId: `agg-${sha256Hex(key).slice(0, 12)}`, key, factIds: runs.map((fact) => fact.factId), n: values.length, mean,
          sampleStd: Math.sqrt(variance), formulaText: `mean(${runs.map((fact) => fact.factId).join(", ")})；样本标准差 n-1`,
        };
        seedAggregates.push(aggregate);
        for (const reported of group.filter((fact) => norm(fact.seed) === "" && fact.unit === runs[0]!.unit)) {
          const decimals = reported.rawText !== undefined ? decimalsOf(reported.rawText) : 15;
          if (!overlap(displayInterval(reported.value, decimals), { lo: mean, hi: mean })) {
            conflicts.push({
              conflictId: conflictId("AGGREGATE_VS_RUN_MISMATCH", [reported.factId, ...aggregate.factIds]), code: "AGGREGATE_VS_RUN_MISMATCH", key,
              factIds: [reported.factId, ...aggregate.factIds],
              detail: `作者给出的汇总值 ${reported.rawText ?? reported.value} 与 ${aggregate.n} 个 seed 的复算均值 ${mean.toPrecision(6)} 不符（按显示精度）`,
              sides: [side(reported), ...runs.map(side)],
            });
          }
        }
      }
    }
  }
  return { conflicts, seedAggregates };
}

function derived(op: "percentage_point_difference" | "subtract" | "relative_change_percent", subject: ExperimentFact, reference: ExperimentFact, label: DerivedQuantity["unitLabel"]): DerivedQuantity | null {
  const canonicalOf = (fact: ExperimentFact): FormulaAtom => {
    const scale = toCanonical(1, fact.unit)?.value ?? 1;
    const decimals = fact.rawText !== undefined ? decimalsOf(fact.rawText) : 15;
    // 标度换算（ratio ×100 → 百分数）：显示精度随之左移两位
    return { ref: fact.factId, value: fact.value * scale, decimals: scale === 100 ? decimals - 2 : scale === 0.001 ? decimals + 3 : decimals, unit: null };
  };
  const atoms = new Map<string, FormulaAtom>([[subject.factId, canonicalOf(subject)], [reference.factId, canonicalOf(reference)]]);
  // derivedFormula 的 percentage_point_difference 与 subtract 都是 a − b；op 名称区分语义（百分点 vs 同单位差）
  const formula: FormulaNode = { op, args: [{ op: "atom", ref: subject.factId }, { op: "atom", ref: reference.factId }] };
  const interval = evaluateFormula(formula, atoms);
  if (interval === null) return null;
  const a = atoms.get(subject.factId)!;
  const b = atoms.get(reference.factId)!;
  const value = op === "relative_change_percent" ? ((a.value - b.value) / b.value) * 100 : a.value - b.value;
  const displayDecimals = Math.max(0, Math.min(6, Math.max(a.decimals, b.decimals)));
  return {
    value, interval, formula, formulaText: renderFormula(formula), unitLabel: label, displayDecimals: op === "relative_change_percent" ? Math.min(2, Math.max(1, displayDecimals - 1)) : displayDecimals,
    rounding: "操作数按源文本显示精度取区间（如 61.7 → [61.65, 61.75]）；结果按区间传播，展示值四舍五入到 displayDecimals 位",
  };
}

function compareFacts(subject: ExperimentFact, reference: ExperimentFact, kind: FactComparison["kind"]): FactComparison {
  const canonicalUnit = toCanonical(1, subject.unit)!.unit;
  const isProportion = canonicalUnit === "percentage";
  const absolute = derived(isProportion ? "percentage_point_difference" : "subtract", subject, reference, isProportion ? "pp" : canonicalUnit)!;
  const referenceValue = toCanonical(reference.value, reference.unit)!.value;
  const relative = referenceValue === 0 ? null : derived("relative_change_percent", subject, reference, "percent_relative");
  const limitations: string[] = [];
  if (referenceValue === 0) limitations.push("参照值为 0：相对变化无定义");
  if (Math.abs(referenceValue) < 1 && relative !== null) limitations.push("参照值接近 0：相对变化数值对舍入极敏感");
  if (Math.sign(referenceValue) < 0) limitations.push("参照值为负：相对变化的方向解释不直观，优先报告绝对差");
  if (subject.direction === "unknown") limitations.push("指标方向未知：只报告差值，不判断优劣");
  limitations.push("单次确定性结果对比；来源无统计检验，不支持「显著」表述");
  let outcome: FactComparison["outcome"] = "direction_unknown";
  if (subject.direction !== "unknown") {
    if (absolute.interval.lo <= 0 && absolute.interval.hi >= 0) outcome = "tie_within_rounding";
    else {
      const subjectHigher = absolute.value > 0;
      outcome = (subject.direction === "higher") === subjectHigher ? "subject_better" : "reference_better";
    }
  }
  return {
    comparisonId: `cmp-${sha256Hex([subject.factId, reference.factId].join("|")).slice(0, 12)}`,
    context: { dataset: subject.dataset ?? "", split: subject.split ?? "", protocol: subject.protocol ?? "", subset: subject.subset ?? "", metricKey: subject.metricKey },
    subject: { factId: subject.factId, method: subject.method ?? "", role: subject.groupRole, value: subject.value },
    reference: { factId: reference.factId, method: reference.method ?? "", role: reference.groupRole, value: reference.value },
    kind, canonicalUnit, direction: subject.direction,
    absoluteDifference: absolute,
    relativeChange: relative,
    ...(relative === null ? { relativeChangeUnavailable: referenceValue === 0 ? "参照值为 0" : "参照值的显示精度区间含 0，相对变化不可算" } : {}),
    outcome,
    operandRefs: [subject.factId, reference.factId],
    limitations,
  };
}

function buildComparisons(facts: ExperimentFact[], blocked: Set<string>): { comparisons: FactComparison[]; notComparable: NotComparablePair[]; truncated: boolean } {
  const comparisons: FactComparison[] = [];
  const notComparable: NotComparablePair[] = [];
  let truncated = false;
  // 两轮配对：先全部指标的整体结果（无子集 / 评测器汇总行），再逐子集——逐序列对比数量大，达到上限时先保住论文层面的整体对比
  const usable = facts.filter((fact) => !blocked.has(fact.factId) && norm(fact.seed) === "");
  const pushNot = (pair: NotComparablePair) => { if (notComparable.length < MAX_NOT_COMPARABLE) notComparable.push(pair); };
  const groups: Array<[string, ExperimentFact[]]> = [];
  for (const aggregate of [true, false]) {
    const byMetric = new Map<string, ExperimentFact[]>();
    for (const fact of usable.filter((entry) => (subsetKey(entry.subset) === "") === aggregate)) byMetric.set(fact.metricKey, [...(byMetric.get(fact.metricKey) ?? []), fact]);
    groups.push(...byMetric);
  }
  for (const [metricKey, group] of groups) {
    const references = group.filter((fact) => fact.groupRole === "baseline" || fact.groupRole === "main");
    for (const reference of references) {
      for (const subject of group) {
        if (subject === reference) continue;
        if (comparisons.length >= MAX_COMPARISONS) { truncated = true; continue; }
        const kind: FactComparison["kind"] | null = reference.groupRole === "baseline" && subject.groupRole !== "baseline"
          ? "vs_baseline"
          : reference.groupRole === "main" && subject.groupRole === "ablation" ? "ablation_vs_main" : null;
        if (kind === null) continue;
        if (norm(subject.method) === "" || norm(reference.method) === "" || norm(subject.method) === norm(reference.method)) {
          if (norm(subject.method) === "" || norm(reference.method) === "") pushNot({ code: "MISSING_REQUIRED_METADATA", metricKey, factIds: [subject.factId, reference.factId], detail: "缺少方法标识：无法确定对比双方" });
          continue;
        }
        if (subsetKey(subject.subset) !== subsetKey(reference.subset)) continue; // 不同序列 / 子集：不配对（不是协议问题，静默跳过）
        const missing = (["dataset", "protocol"] as const).filter((field) => norm(subject[field]) === "" || norm(reference[field]) === "");
        if (missing.length > 0) {
          pushNot({ code: "MISSING_REQUIRED_METADATA", metricKey, factIds: [subject.factId, reference.factId], detail: `缺少 ${missing.join(" / ")}：协议不明只展示原始数值，不生成对比` });
          continue;
        }
        const differs = (["dataset", "split", "protocol"] as const).filter((field) => norm(subject[field]) !== norm(reference[field]));
        if (differs.length > 0) {
          pushNot({ code: "PROTOCOL_NOT_COMPARABLE", metricKey, factIds: [subject.factId, reference.factId], detail: `${differs.map((field) => `${field}：${subject[field] ?? "?"} ≠ ${reference[field] ?? "?"}`).join("；")}——不可直接比较` });
          continue;
        }
        if (subject.unit === "unknown" || reference.unit === "unknown") {
          pushNot({ code: "MISSING_REQUIRED_METADATA", metricKey, factIds: [subject.factId, reference.factId], detail: "单位未声明：不生成差值（请在文件 metadata 声明单位）" });
          continue;
        }
        if (unitDimension(subject.unit) !== unitDimension(reference.unit)) {
          pushNot({ code: "UNIT_NOT_COMPARABLE", metricKey, factIds: [subject.factId, reference.factId], detail: `单位量纲不同（${subject.unit} vs ${reference.unit}）` });
          continue;
        }
        if (subject.direction !== reference.direction) continue;
        comparisons.push(compareFacts(subject, reference, kind));
      }
    }
  }
  // 同一对（同 subject/reference 方法 + 指标 + 上下文）可能来自多份等值来源（summary.txt 与 detailed.csv COMBINED）：按上下文 + 方法去重；
  // 优先保留无需标度换算的来源（操作数原单位即规范单位，如 summary 的百分数），同等时保留首个
  const byId = new Map(facts.map((fact) => [fact.factId, fact]));
  const conversions = (comparison: FactComparison) => comparison.operandRefs.filter((id) => byId.get(id)?.unit !== comparison.canonicalUnit).length;
  const best = new Map<string, FactComparison>();
  for (const comparison of comparisons) {
    const key = [comparison.context.dataset, comparison.context.split, comparison.context.protocol, subsetKey(comparison.context.subset), comparison.context.metricKey, norm(comparison.subject.method), norm(comparison.reference.method)].join("|");
    const current = best.get(key);
    if (current === undefined || conversions(comparison) < conversions(current)) best.set(key, comparison);
  }
  const kept = new Set(best.values());
  const deduped = comparisons.filter((comparison) => kept.has(comparison));
  return { comparisons: deduped, notComparable, truncated };
}

/**
 * 构建快照内容（预览与冻结共用；纯函数）。excludedFactIds = 作者排除的事实（保留在 excluded 列表，审计可见）。
 * 冲突中被作者排除了一方的不再计为冲突；其余冲突所涉事实不进入对比。
 */
export function buildFactSnapshotContent(observations: SnapshotInputObservation[], excludedFactIds: ReadonlyMap<string, string>): FactSnapshotBuild {
  const all = observations.map(toFact);
  const facts = all.filter((fact) => !excludedFactIds.has(fact.factId));
  const excluded = all.filter((fact) => excludedFactIds.has(fact.factId)).map((fact) => ({ factId: fact.factId, reason: excludedFactIds.get(fact.factId)! }));
  const { conflicts, seedAggregates } = findConflicts(facts);
  const blocked = new Set(conflicts.flatMap((conflict) => conflict.factIds));
  const { comparisons, notComparable, truncated } = buildComparisons(facts, blocked);
  const limitations: string[] = [];
  if (truncated) limitations.push(`可比较对超过上限 ${MAX_COMPARISONS} 条：整体结果优先保留，其余逐子集对比未生成（不是不可比）`);
  const missingIdentity = facts.filter((fact) => norm(fact.method) === "" || norm(fact.dataset) === "").length;
  if (missingIdentity > 0) limitations.push(`${missingIdentity} 条事实缺少方法或数据集标识：可原样引用，但不参与同键冲突检查与对比`);
  const unknownUnit = facts.filter((fact) => fact.unit === "unknown").length;
  if (unknownUnit > 0) limitations.push(`${unknownUnit} 条事实单位未声明：不生成差值 / 相对变化`);
  limitations.push("来源未提供统计检验：快照不支持任何显著性 / p 值表述");
  return { facts, excluded, conflicts, comparisons, notComparable, seedAggregates, statisticalTests: [], limitations };
}

export function snapshotContentHash(build: FactSnapshotBuild): string {
  return sha256Hex(JSON.stringify({
    facts: build.facts.map((fact) => [fact.factId, fact.fileHash, fact.value, fact.unit, fact.method ?? "", fact.dataset ?? "", fact.split ?? "", fact.protocol ?? "", fact.seed ?? "", fact.subset ?? "", fact.version ?? ""]),
    excluded: build.excluded,
    comparisons: build.comparisons.map((comparison) => [comparison.comparisonId, comparison.absoluteDifference.value, comparison.relativeChange?.value ?? null]),
  }));
}

/** 展示用：派生量格式化（「+2.580 pp」「+5.46%」） */
export function formatDerived(quantity: DerivedQuantity): string {
  const sign = quantity.value > 0 ? "+" : "";
  const text = `${sign}${quantity.value.toFixed(quantity.displayDecimals)}`;
  if (quantity.unitLabel === "pp") return `${text} 个百分点（pp）`;
  if (quantity.unitLabel === "percent_relative") return `${text}%（相对变化）`;
  return `${text}${quantity.unitLabel === "count" ? "（计数）" : ` ${quantity.unitLabel}`}`;
}
