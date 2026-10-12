/** M13.7.9 deterministic evaluation of one arm output (no model calls). Extends the frozen M13.7.8 evaluator with the
 * academic-redundancy classification layer (metric A lexical share + metric B harmful share with lower / upper bound).
 * Usage: node m13-7-9-evaluate.mjs REPO_ROOT ARM_OUTPUT_DIR MARKERS_JSON FIXTURE_JSON > arm.eval.json
 * Reports: per-section size / cite keys / unknown keys, concept distribution (carriers vs owner, with locating sentences outside
 * the owner), negative-control escalations, lexical redundancy (summary, per-section, every pair with both sentences), the
 * classification of every pair (class / rule / reason / harmful side), harmful and uncertain sentences, signpost sentences,
 * limitation distribution, numeric tokens outside any evidence quote, usage and cost. Section roles come from the fixture's
 * argumentUnitsV2 / argumentUnits roles (fallback: inferSectionRoles). Reads <arm>-sections.json and result.json; never edits outputs.
 */
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const [repoArg, dirArg, markersArg, fixtureArg] = process.argv.slice(2);
if (!repoArg || !dirArg || !markersArg || !fixtureArg) throw new Error("Expected REPO_ROOT ARM_OUTPUT_DIR MARKERS_JSON FIXTURE_JSON");
const repo = resolve(repoArg), dir = resolve(dirArg);
const { stripLatexForRedundancy, splitRedundancySentences } = await import(pathToFileURL(join(repo, "backend/dist/review/crossSectionRedundancy.js")).href);
const { classifyAcademicRedundancy, ACADEMIC_REDUNDANCY_RULES } = await import(pathToFileURL(join(repo, "backend/dist/review/academicRedundancyClassifier.js")).href);
const markers = JSON.parse(await readFile(markersArg, "utf8"));
const fixture = JSON.parse(await readFile(fixtureArg, "utf8"));
const sectionsFile = (await readdir(dir)).find((f) => f.endsWith("-sections.json"));
if (!sectionsFile) throw new Error("no *-sections.json in output dir");
const sections = JSON.parse(await readFile(join(dir, sectionsFile), "utf8"));
const result = JSON.parse(await readFile(join(dir, "result.json"), "utf8"));
const plain = (latex) => stripLatexForRedundancy(latex).replace(/\s+/g, " ");

// ---- citation keys -------------------------------------------------------------------------------------------------
const knownKeys = new Set(fixture.bibliography.map((b) => b.key));
const citeKeysOf = (latex) => [...latex.matchAll(/\\cite\w*\*?(?:\[[^\]\n]*\])*\{([^{}]*)\}/g)].flatMap((m) => m[1].split(",").map((k) => k.trim()).filter(Boolean));
const citations = sections.map((s) => {
  const keys = citeKeysOf(s.latex);
  const counts = {};
  for (const k of keys) counts[k] = (counts[k] ?? 0) + 1;
  return { id: s.id, citeCommands: (s.latex.match(/\\cite\w*\{/g) ?? []).length, keyUses: keys.length, keys: counts, unknownKeys: [...new Set(keys.filter((k) => !knownKeys.has(k)))] };
});

// ---- concept distribution ------------------------------------------------------------------------------------------
const distribution = markers.concepts.map((concept) => {
  const carriers = sections.filter((s) => concept.all.every((p) => new RegExp(p).test(plain(s.latex)))).map((s) => s.id);
  const outsideOwner = carriers.filter((id) => id !== concept.owner);
  const locate = outsideOwner.map((id) => {
    const section = sections.find((s) => s.id === id);
    const first = new RegExp(concept.all[0]);
    return { section: id, sentences: splitRedundancySentences(plain(section.latex)).filter((sentence) => first.test(sentence)).slice(0, 4) };
  });
  return { id: concept.id, label: concept.label, owner: concept.owner, carriers, outsideOwner, locate };
});

// ---- negative controls ----------------------------------------------------------------------------------------------
const controls = markers.negativeControls ?? (markers.negativeControl ? [markers.negativeControl] : []);
const escalations = [];
for (const control of controls) {
  for (const section of sections) {
    for (const sentence of splitRedundancySentences(plain(section.latex))) {
      const match = new RegExp(control.pattern).exec(sentence);
      if (!match) continue;
      const before = sentence.slice(0, match.index);
      const negated = new RegExp(control.negationWindow).test(before) || /(不|未|无|缺乏|尚|并非|不能|无法|没有)/.test(sentence.slice(match.index));
      escalations.push({ control: control.id, section: section.id, sentence, negated });
    }
  }
}

// ---- redundancy: lexical detector + classification layer ---------------------------------------------------------
const unitBlock = fixture.argumentUnitsV2 ?? fixture.argumentUnits;
const roles = unitBlock?.sections ? Object.fromEntries(Object.entries(unitBlock.sections).map(([id, unit]) => [id, unit.role])) : undefined;
const classified = classifyAcademicRedundancy(sections, roles ? { roles } : {});
const redundancy = classified.detector;

// ---- numeric tokens outside quotes -----------------------------------------------------------------------------------
const numberTokens = (text) => [...text.matchAll(/\d+(?:\.\d+)?/g)].map((m) => m[0]);
const allowedNumbers = new Set([
  ...fixture.evidence.flatMap((e) => numberTokens(e.quote)),
  ...fixture.bibliography.map((b) => String(b.year)),
]);
const numbersOutsideQuotes = sections.flatMap((s) => {
  const body = s.latex.replace(/\\cite\w*\*?(?:\[[^\]\n]*\])*\{[^{}]*\}/g, " ").replace(/\\(?:label|ref|eqref)\{[^{}]*\}/g, " ");
  return splitRedundancySentences(body.replace(/\\(?:sub)*section\*?\{[^{}]*\}/g, "\n")).flatMap((sentence) => {
    const outside = [...new Set(numberTokens(sentence))].filter((n) => !allowedNumbers.has(n));
    return outside.length > 0 ? [{ section: s.id, numbers: outside, sentence: sentence.replace(/\s+/g, " ").trim() }] : [];
  });
});

// ---- usage / sizes -------------------------------------------------------------------------------------------------------
const usage = result.calls.filter((c) => c.usage).reduce((acc, c) => {
  acc.inputTokens += c.usage.inputTokens ?? 0; acc.outputTokens += c.usage.outputTokens ?? 0; acc.cacheReadTokens += c.usage.cacheReadTokens ?? 0;
  acc.cacheWriteTokens += c.usage.cacheWriteTokens ?? 0; acc.estimatedCost += c.usage.estimatedCost ?? 0; acc.assistantTurns += c.usage.assistantTurns ?? 0;
  acc.seconds += c.seconds ?? 0; acc.tasks += 1; return acc;
}, { tasks: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCost: 0, assistantTurns: 0, seconds: 0 });
const chars = sections.map((s) => ({ id: s.id, chars: s.latex.length, cjk: (s.latex.match(/[一-鿿]/g) ?? []).length, cites: (s.latex.match(/\\cite\w*\{/g) ?? []).length }));
const skills = result.calls.map((c) => ({ name: c.name, accessed: c.skills?.accessed ?? c.skills?.accessedSkills ?? null, turns: c.usage?.assistantTurns ?? null, seconds: c.seconds ?? null, status: c.status }));

const report = {
  arm: result.arm, model: result.model, status: result.status, inputHash: result.inputHash, unitsBlock: result.unitsBlock ?? null,
  sections: chars,
  totals: { chars: chars.reduce((a, c) => a + c.chars, 0), cjk: chars.reduce((a, c) => a + c.cjk, 0), cites: chars.reduce((a, c) => a + c.cites, 0),
    unknownKeys: [...new Set(citations.flatMap((c) => c.unknownKeys))] },
  citations,
  conceptDistribution: distribution,
  negativeControls: escalations,
  redundancy: redundancy.summary,
  redundancyBySection: redundancy.sections,
  redundancyPairs: redundancy.pairs,
  limitationSentences: redundancy.limitationSentences,
  classification: {
    roles: classified.roles,
    thresholds: classified.thresholds,
    summary: classified.summary,
    pairs: classified.pairs.map((p) => ({ later: `${p.pair.later.section}#${p.pair.later.index}`, earlier: `${p.pair.earlier.section}#${p.pair.earlier.index}`,
      containment: p.pair.containment, jaccard: p.pair.jaccard, class: p.class, harmful: p.harmful, harmfulSide: p.harmfulSide, rule: p.rule, reason: p.reason,
      laterText: p.pair.later.text, earlierText: p.pair.earlier.text })),
    harmfulSentences: classified.harmfulSentences,
    uncertainSentences: classified.uncertainSentences,
    signpostSentences: classified.signpostSentences,
    rules: ACADEMIC_REDUNDANCY_RULES,
  },
  numbersOutsideQuotes,
  calls: skills,
  usage,
};
console.log(JSON.stringify(report, null, 2));
