/** M13.7.8 cross-arm comparison (no model calls): prints a Markdown table from one or more *.eval.json files produced by
 * m13-7-8-evaluate.mjs. The first file is the reference arm (Baseline); relative changes are reported against it.
 * Usage: node m13-7-8-compare.mjs A.eval.json [B.eval.json ...]
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
    return i === 0 || !withDelta || typeof v !== "number" ? format(v) : `${format(v)} (${pct(v, pick(ref))})`;
  });
  return `| ${label} | ${cells.join(" | ")} |`;
};
const lines = [
  `| 指标 | ${evals.map((e) => e.arm).join(" | ")} |`,
  `| --- | ${evals.map(() => "---:").join(" | ")} |`,
  row("汉字", (e) => e.totals.cjk),
  row("cite 命令", (e) => e.totals.cites),
  row("未知 cite key", (e) => e.totals.unknownKeys.length),
  row("句数", (e) => e.redundancy.sentenceCount),
  row("跨节复述对", (e) => e.redundancy.pairCount),
  row("复述句数", (e) => e.redundancy.restatedSentenceCount),
  row("复述字符占比", (e) => e.redundancy.restatedCharShare, (v) => `${(v * 100).toFixed(1)}%`),
  row("含复述的节", (e) => e.redundancy.sectionsWithRestatement, (v) => String(v), false),
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
