/**
 * M17.2 由冻结实验事实快照确定性生成结果表（零 LLM）：行 = 数据集 × 方法，列 = 有确定性对比的指标；单元格为快照事实
 * 的规范标度取值（比例统一 ×100 为百分数——换算在题注中写明），表注写明快照版本 / 内容哈希与来源文件 sha256。
 *
 * Writer 不经手本表任何字节（写作阶段在结果节末尾确定性追加）；没有确定性对比 → 不生成表（返回无表决定与原因）。
 */

import { escapeLatex } from "../figures/latexEscape.js";
import type { ConfirmedExperimentWorkflowContext, WorkflowComparison } from "./ExperimentPackageService.js";

const MAX_METRICS = 5;
const MAX_ROWS = 24;
const RESULTS_SECTION = /result|结果/i;
const EXPERIMENT_SECTION = /experiment|evaluation|实验|评估|评测/i;

export interface SnapshotResultsTable {
  label: string;
  latex: string;
  metrics: string[];
  rowCount: number;
  sourceFiles: string[];
}

export function snapshotTableLabel(snapshotId: string): string {
  return `tab:exp-${snapshotId}`;
}

/**
 * 把确定性结果表追加到节末：只有该节已含同名 \label（Writer 自己写了这张表）才跳过；正文中的 Table~\ref{…} 引用不算
 * （M17.2 真实运行：按 label 子串判断时引用命中，表被跳过，稿件留下悬空引用）。
 */
export function appendResultsTable(sectionLatex: string, table: Pick<SnapshotResultsTable, "label" | "latex">): { latex: string; appended: boolean } {
  if (sectionLatex.includes(`\\label{${table.label}}`)) return { latex: sectionLatex, appended: false };
  return { latex: `${sectionLatex.trimEnd()}\n\n${table.latex}\n`, appended: true };
}

/** 在大纲中选择附表的章节：先找标题 / id 含 result / 结果，其次 experiment / 实验；都没有 → null（无表决定） */
export function selectResultsSection<T extends { id: string; title: string }>(sections: readonly T[]): T | null {
  return sections.find((section) => RESULTS_SECTION.test(section.id) || RESULTS_SECTION.test(section.title))
    ?? sections.find((section) => EXPERIMENT_SECTION.test(section.id) || EXPERIMENT_SECTION.test(section.title))
    ?? null;
}

function formatValue(value: number): string {
  if (Number.isInteger(value)) return String(value);
  return Number(value.toFixed(3)).toString();
}

function unitHeader(unit: WorkflowComparison["canonicalUnit"]): string {
  switch (unit) {
    case "percentage": return " (\\%)";
    case "fps": return " (FPS)";
    case "seconds": return " (s)";
    case "count": return "";
    default: return "";
  }
}

/** 正文中提及的快照指标（按提及次数降序、首次出现位置升序）——结果表列优先与正文一致（确定性） */
export function mentionedMetrics(text: string, metrics: readonly string[]): string[] {
  const plain = text.replace(/\\[A-Za-z]+/g, " ");
  const scored = metrics.map((metric) => {
    const escaped = metric.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    const matches = [...plain.matchAll(new RegExp(`(^|[^A-Za-z0-9])${escaped}(?=$|[^A-Za-z0-9])`, "gi"))];
    return { metric, count: matches.length, first: matches[0]?.index ?? Number.MAX_SAFE_INTEGER };
  }).filter((entry) => entry.count > 0);
  return scored.sort((a, b) => b.count - a.count || a.first - b.first).map((entry) => entry.metric);
}

export function renderSnapshotResultsTable(
  context: ConfirmedExperimentWorkflowContext,
  options: { language?: string; preferMetrics?: readonly string[] } = {},
): { table: SnapshotResultsTable } | { table: null; reason: string } {
  const snapshot = context.snapshot;
  if (snapshot === undefined) return { table: null, reason: "无冻结快照" };
  if (snapshot.status !== "valid") return { table: null, reason: "快照已失效" };
  const comparisons = context.comparisons ?? [];
  if (comparisons.length === 0) return { table: null, reason: "快照中没有确定性对比（协议 / 单位 / 基线不明），只允许正文报告原始数值" };
  // 指标：按对比数降序、名称码位序；每个指标的单位取首个对比的规范单位
  const metricCounts = new Map<string, { count: number; unit: WorkflowComparison["canonicalUnit"]; direction: string; label: string }>();
  for (const comparison of comparisons) {
    const entry = metricCounts.get(comparison.metric) ?? { count: 0, unit: comparison.canonicalUnit, direction: "", label: comparison.metricLabel ?? comparison.metric };
    entry.count += 1;
    metricCounts.set(comparison.metric, entry);
  }
  // 列：正文提及的指标优先（与正文一致），其余按对比数降序、名称码位序补足
  const preferred = (options.preferMetrics ?? []).filter((metric) => metricCounts.has(metric));
  const rest = [...metricCounts.entries()].sort((a, b) => b[1].count - a[1].count || (a[0] < b[0] ? -1 : 1)).map(([metric]) => metric).filter((metric) => !preferred.includes(metric));
  const metrics = [...preferred, ...rest].slice(0, MAX_METRICS);
  // 行：数据集 × 方法；角色 baseline 在前、main 次之、ablation 最后
  const roleRank: Record<string, number> = { baseline: 0, main: 1, ablation: 2, other: 3 };
  const rows = new Map<string, { dataset: string; method: string; role: string; values: Map<string, number> }>();
  for (const comparison of comparisons) {
    if (!metrics.includes(comparison.metric)) continue;
    for (const side of [comparison.subject, comparison.reference]) {
      const key = `${comparison.dataset}\u0000${side.method}`;
      const row = rows.get(key) ?? { dataset: comparison.dataset, method: side.method, role: side.role, values: new Map<string, number>() };
      if (!row.values.has(comparison.metric)) row.values.set(comparison.metric, side.canonicalValue);
      rows.set(key, row);
    }
  }
  const ordered = [...rows.values()]
    .sort((a, b) => (a.dataset < b.dataset ? -1 : a.dataset > b.dataset ? 1 : 0) || (roleRank[a.role] ?? 9) - (roleRank[b.role] ?? 9) || (a.method < b.method ? -1 : a.method > b.method ? 1 : 0))
    .slice(0, MAX_ROWS);
  const datasets = new Set(ordered.map((row) => row.dataset));
  const english = options.language === "en";
  const label = snapshotTableLabel(snapshot.snapshotId);
  // 单一数据集：省去数据集列（写入题注），减少列宽；多数据集保留，并在表注说明跨数据集不可比
  const singleDataset = datasets.size === 1 ? [...datasets][0]! : null;
  const header = [...(singleDataset === null ? [english ? "Dataset" : "数据集"] : []), english ? "Method" : "方法", ...metrics.map((metric) => `${escapeLatex(metricCounts.get(metric)!.label)}${unitHeader(metricCounts.get(metric)!.unit)}`)];
  const body = ordered.map((row) => [
    ...(singleDataset === null ? [escapeLatex(row.dataset)] : []), `${escapeLatex(row.method)}${row.role === "baseline" ? (english ? " (baseline)" : "（基线）") : row.role === "ablation" ? (english ? " (ablation)" : "（消融）") : ""}`,
    ...metrics.map((metric) => row.values.has(metric) ? formatValue(row.values.get(metric)!) : "--"),
  ].join(" & ") + " \\\\");
  const sourceFiles = [...new Set(context.observations.map((observation) => observation.path))].sort();
  const caption = english
    ? `Experimental results${singleDataset !== null ? ` on ${singleDataset}` : ""} from author-confirmed fact snapshot ${snapshot.snapshotId} (content hash ${snapshot.contentHash.slice(0, 12)}); proportions are shown on a percentage scale; single deterministic runs without statistical tests.`
    : `${singleDataset !== null ? `${singleDataset} 上的` : ""}实验结果（来自作者确认的实验事实快照 ${snapshot.snapshotId}，内容哈希 ${snapshot.contentHash.slice(0, 12)}；比例统一按百分数标度；单次确定性运行，无统计检验）`;
  const note = english
    ? `Values are copied deterministically from the snapshot; differences in the text are recomputed from the same facts.`
    : `表中数值由系统从快照确定性抄录；正文中的差值由同一事实复算。`;
  const latex = [
    `% PaperTeam M17.2 deterministic results table — snapshot ${snapshot.snapshotId} ${snapshot.contentHash}; do not edit numbers by hand`,
    "\\begin{table}[htbp]",
    "  \\centering",
    // 指标列 + 标签列在单栏版心内易溢出（M17.2 真实重放 PDF 目检）：统一小字号、收窄列距、最多 5 个指标列
    "  \\small",
    "  \\setlength{\\tabcolsep}{4pt}",
    `  \\caption{${escapeLatex(caption)}}`,
    `  \\label{${label}}`,
    `  \\begin{tabular}{${"l".repeat(singleDataset === null ? 2 : 1)}${"r".repeat(metrics.length)}}`,
    "    \\hline",
    `    ${header.join(" & ")} \\\\`,
    "    \\hline",
    ...body.map((line) => `    ${line}`),
    "    \\hline",
    "  \\end{tabular}",
    `  \\par\\footnotesize ${escapeLatex(note)}${datasets.size > 1 ? (english ? " Rows from different datasets are not comparable with each other." : " 不同数据集的行之间不可直接比较。") : ""}`,
    "\\end{table}",
  ].join("\n");
  return { table: { label, latex, metrics, rowCount: ordered.length, sourceFiles } };
}
