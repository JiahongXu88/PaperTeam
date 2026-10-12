/** M13.7.9 cross-arm comparison (no model calls): prints a Markdown table from one or more *.eval.json files produced by
 * m13-7-9-evaluate.mjs (also accepts m13-7-8 eval files: classification rows show "—" when absent). The first file is the
 * reference arm (Baseline); relative changes are reported against it. Metric A (lexical restated share) and metric B
 * (harmful share, lower / upper bound) are both printed; neither alone is a quality verdict.
 * Usage: node m13-7-9-compare.mjs A.eval.json [B2.eval.json ...]
 */
import { readFile } from "node:fs/promises";

const files = process.argv.slice(2);
if (files.length === 0) throw new Error("Expected at least one eval JSON");
const evals = [];
for (const file of files) evals.push(JSON.parse(await readFile(file, "utf8")));
const ref = evals[0];
const pct = (value, base) => (base === 0 ? "n/a" : `${((value / base - 1) * 100).toFixed(1)}%`);
const row = (label, pick, format = (v) => String(v), withDelta = true) => {
  const cells = evals.map((e, i) => {
    const v = pick(e);
    if (v === undefined || v === null) return "—";
    const refValue = pick(ref);
    return i === 0 || !withDelta || typeof v !== "number" || typeof refValue !== "number" ? format(v) : `${format(v)} (${pct(v, refValue)})`;
  });
  return `| ${label} | ${cells.join(" | ")} |`;
};
const cls = (e) => e.classification?.summary;
const byClass = (e, k) => cls(e)?.harmful.byClass?.[k]?.sentences ?? 0;
const lines = [
  `| 指标 | ${evals.map((e) => e.arm).join(" | ")} |`,
  `| --- | ${evals.map(() => "---:").join(" | ")} |`,
  row("汉字", (e) => e.totals.cjk),
  row("cite 命令", (e) => e.totals.cites),
  row("未知 cite key", (e) => e.totals.unknownKeys.length),
  row("句数 / 句字符", (e) => `${e.redundancy.sentenceCount} / ${e.redundancy.charCount}`, (v) => v, false),
  row("A 跨节复述对", (e) => e.redundancy.pairCount),
  row("A 复述句数 / 字符", (e) => `${e.redundancy.restatedSentenceCount} / ${cls(e)?.lexical.restatedChars ?? "—"}`, (v) => v, false),
  row("A 词面复述占比", (e) => e.redundancy.restatedCharShare, (v) => `${(v * 100).toFixed(1)}%`),
  row("B 有害重复句数 / 字符", (e) => (cls(e) ? `${cls(e).harmful.sentenceCount} / ${cls(e).harmful.chars}` : undefined), (v) => v, false),
  row("B 有害重复占比（下界）", (e) => cls(e)?.harmful.share, (v) => `${(v * 100).toFixed(1)}%`),
  row("B 上界（含 uncertain）", (e) => cls(e)?.harmfulUpperShare, (v) => `${(v * 100).toFixed(1)}%`),
  row("uncertain 句数 / 字符", (e) => (cls(e) ? `${cls(e).uncertain.sentenceCount} / ${cls(e).uncertain.chars}` : undefined), (v) => v, false),
  row("有害 M / L / P / S", (e) => (cls(e) ? `${byClass(e, "M")} / ${byClass(e, "L")} / ${byClass(e, "P")} / ${byClass(e, "S")}` : undefined), (v) => v, false),
  row("有害 X（逐字） / E（逐字）", (e) => (cls(e) ? `${byClass(e, "X")} / ${byClass(e, "E")}` : undefined), (v) => v, false),
  row("pair 类别 M/L/P/S/X/E/F/u", (e) => (cls(e) ? ["M", "L", "P", "S", "X", "E", "F", "uncertain"].map((k) => cls(e).classCounts[k]).join("/") : undefined), (v) => v, false),
  row("路标句（非引言 / 引言）", (e) => (e.classification ? `${e.classification.signpostSentences.filter((s) => s.harmful).length} / ${cls(e).framingRoadmapSentences}` : undefined), (v) => v, false),
  row("限制句 / 所在节数", (e) => `${e.redundancy.limitationSentenceCount} / ${e.redundancy.sectionsWithLimitation}`, (v) => v, false),
  ...ref.conceptDistribution.map((concept) =>
    row(`${concept.label} 所在节`, (e) => {
      const match = e.conceptDistribution.find((c) => c.id === concept.id);
      return match ? `${match.carriers.length}（${match.carriers.join(", ") || "—"}）` : "—";
    }, (v) => v, false)),
  row("负对照升级句（未否定）", (e) => e.negativeControls.filter((n) => !n.negated).length, (v) => String(v), false),
  row("引文外数字句", (e) => e.numbersOutsideQuotes.length, (v) => String(v), false),
  row("任务 / assistant turns", (e) => `${e.usage.tasks} / ${e.usage.assistantTurns}`, (v) => v, false),
  row("非缓存 input tokens", (e) => e.usage.inputTokens),
  row("output tokens", (e) => e.usage.outputTokens),
  row("cache read", (e) => e.usage.cacheReadTokens),
  row("SDK estimatedCost", (e) => e.usage.estimatedCost, (v) => v.toFixed(5)),
  row("任务秒数之和", (e) => e.usage.seconds, (v) => v.toFixed(1)),
];
console.log(lines.join("\n"));
