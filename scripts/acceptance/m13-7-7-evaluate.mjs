/** M13.7.7 deterministic evaluation of an arm output (no model calls).
 * Usage: node m13-7-7-evaluate.mjs REPO_ROOT ARM_OUTPUT_DIR MARKERS_JSON
 * Prints concept distribution (which sections carry each concept vs its owner), redundancy summary,
 * limitation-sentence distribution, usage and cost. Reads <arm>-sections.json and result.json.
 */
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [repoArg, dirArg, markersArg] = process.argv.slice(2);
if (!repoArg || !dirArg || !markersArg) throw new Error("Expected REPO_ROOT ARM_OUTPUT_DIR MARKERS_JSON");
const repo = resolve(repoArg), dir = resolve(dirArg);
const { analyzeCrossSectionRedundancy, stripLatexForRedundancy, splitRedundancySentences } = await import(pathToFileURL(join(repo, "backend/dist/review/crossSectionRedundancy.js")).href);
const markers = JSON.parse(await readFile(markersArg, "utf8"));
const sectionsFile = (await readdir(dir)).find((f) => f.endsWith("-sections.json"));
if (!sectionsFile) throw new Error("no *-sections.json in output dir");
const sections = JSON.parse(await readFile(join(dir, sectionsFile), "utf8"));
const result = JSON.parse(await readFile(join(dir, "result.json"), "utf8"));
const plain = (latex) => stripLatexForRedundancy(latex).replace(/\s+/g, " ");

const distribution = markers.concepts.map((concept) => {
  const carriers = sections.filter((s) => concept.all.every((p) => new RegExp(p).test(plain(s.latex)))).map((s) => s.id);
  return { id: concept.id, label: concept.label, owner: concept.owner, carriers, outsideOwner: carriers.filter((id) => id !== concept.owner) };
});
const negative = markers.negativeControl;
const escalations = [];
for (const section of sections) {
  for (const sentence of splitRedundancySentences(plain(section.latex))) {
    const match = new RegExp(negative.pattern).exec(sentence);
    if (!match) continue;
    const before = sentence.slice(0, match.index);
    const negated = new RegExp(negative.negationWindow).test(before) || /(不|未|无|缺乏|尚|并非|不能|无法)/.test(sentence.slice(match.index));
    escalations.push({ section: section.id, sentence, negated });
  }
}
const redundancy = analyzeCrossSectionRedundancy(sections);
const usage = result.calls.filter((c) => c.usage).reduce((acc, c) => {
  acc.inputTokens += c.usage.inputTokens; acc.outputTokens += c.usage.outputTokens; acc.cacheReadTokens += c.usage.cacheReadTokens;
  acc.cacheWriteTokens += c.usage.cacheWriteTokens; acc.estimatedCost += c.usage.estimatedCost ?? 0; acc.assistantTurns += c.usage.assistantTurns; acc.seconds += c.seconds ?? 0; return acc;
}, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCost: 0, assistantTurns: 0, seconds: 0 });
const chars = sections.map((s) => ({ id: s.id, chars: s.latex.length, cjk: (s.latex.match(/[一-鿿]/g) ?? []).length, cites: (s.latex.match(/\\cite\w*\{/g) ?? []).length }));
const report = { arm: result.arm, model: result.model, status: result.status, sections: chars,
  totals: { chars: chars.reduce((a, c) => a + c.chars, 0), cjk: chars.reduce((a, c) => a + c.cjk, 0), cites: chars.reduce((a, c) => a + c.cites, 0) },
  conceptDistribution: distribution, negativeControl: escalations, redundancy: redundancy.summary,
  limitationBySection: redundancy.sections.map((s) => ({ id: s.id, limitationSentences: s.limitationSentences, restatedSentences: s.restatedSentences })), usage };
console.log(JSON.stringify(report, null, 2));
