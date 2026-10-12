/** M13.7.9 academic-redundancy classification of one arm output (no model calls).
 * Usage: node m13-7-9-classify.mjs REPO_ROOT ARM_OUTPUT_DIR [--roles introduction=framing,contrastive=develop,...] [--markdown]
 * Reads <arm>-sections.json (outline order) from ARM_OUTPUT_DIR, runs the frozen lexical detector + the classification layer
 * from backend/dist, and prints JSON (default) or a Markdown table of every pair with class / rule / reason plus the two metrics
 * (A lexical restated share, B harmful share with lower/upper bound). Never edits outputs. Roles default to inferSectionRoles.
 */
import { readFile, readdir } from "node:fs/promises";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";

const positional = [];
const flags = {};
for (let i = 2; i < process.argv.length; i += 1) {
  const value = process.argv[i];
  if (value === "--markdown") flags.markdown = true;
  else if (value.startsWith("--")) { flags[value.slice(2)] = process.argv[i + 1]; i += 1; }
  else positional.push(value);
}
const [repoArg, dirArg] = positional;
if (!repoArg || !dirArg) throw new Error("Expected REPO_ROOT ARM_OUTPUT_DIR");
const repo = resolve(repoArg), dir = resolve(dirArg);
const { classifyAcademicRedundancy, ACADEMIC_REDUNDANCY_RULES } = await import(pathToFileURL(join(repo, "backend/dist/review/academicRedundancyClassifier.js")).href);
const sectionsFile = (await readdir(dir)).find((f) => f.endsWith("-sections.json"));
if (!sectionsFile) throw new Error("no *-sections.json in output dir");
const sections = JSON.parse(await readFile(join(dir, sectionsFile), "utf8"));
const roles = flags.roles ? Object.fromEntries(flags.roles.split(",").map((kv) => kv.split("="))) : undefined;
const report = classifyAcademicRedundancy(sections, roles ? { roles } : {});

if (!flags.markdown) {
  const { detector, ...rest } = report;
  console.log(JSON.stringify({ ...rest, detectorSummary: detector.summary, detectorSections: detector.sections, rules: ACADEMIC_REDUNDANCY_RULES }, null, 2));
} else {
  const s = report.summary;
  const pct = (v) => `${(v * 100).toFixed(1)}%`;
  console.log(`roles: ${Object.entries(report.roles).map(([k, v]) => `${k}=${v}`).join(", ")}`);
  console.log(`sentences ${s.sentenceCount} / chars ${s.charCount}`);
  console.log(`A lexical: pairs ${s.lexical.pairCount}, restated sentences ${s.lexical.restatedSentenceCount}, chars ${s.lexical.restatedChars}, share ${pct(s.lexical.restatedCharShare)}`);
  console.log(`B harmful: sentences ${s.harmful.sentenceCount}, chars ${s.harmful.chars}, share ${pct(s.harmful.share)} (upper incl. uncertain ${pct(s.harmfulUpperShare)}; uncertain ${s.uncertain.sentenceCount} sentences / ${s.uncertain.chars} chars)`);
  console.log(`by class (harmful sentences): ${Object.entries(s.harmful.byClass).map(([k, v]) => `${k}=${v.sentences}/${v.chars}`).join(", ") || "—"}; pair classes: ${Object.entries(s.classCounts).filter(([, v]) => v > 0).map(([k, v]) => `${k}=${v}`).join(", ")}; framing roadmap sentences ${s.framingRoadmapSentences}`);
  console.log("\n| # | later | earlier | c | j | class | harmful | rule | reason |\n| --- | --- | --- | ---: | ---: | --- | --- | --- | --- |");
  report.pairs.forEach((p, i) => {
    const cut = (t) => t.replace(/\|/g, "\\|").slice(0, 60);
    console.log(`| ${i + 1} | ${p.pair.later.section}#${p.pair.later.index} ${cut(p.pair.later.text)} | ${p.pair.earlier.section}#${p.pair.earlier.index} ${cut(p.pair.earlier.text)} | ${p.pair.containment} | ${p.pair.jaccard} | ${p.class} | ${p.harmful ? p.harmfulSide : "no"} | ${p.rule} | ${p.reason.replace(/\|/g, "\\|")} |`);
  });
  console.log("\nHarmful sentences:");
  for (const h of report.harmfulSentences) console.log(`- [${h.class}] ${h.section}#${h.index} (${h.chars}) ${h.text}`);
  console.log("\nUncertain sentences:");
  for (const u of report.uncertainSentences) console.log(`- ${u.section}#${u.index} (${u.chars}) ${u.text} — ${u.reason}`);
  console.log("\nSignpost sentences:");
  for (const g of report.signpostSentences) console.log(`- ${g.section}#${g.index} role=${g.role} paired=${g.paired} harmful=${g.harmful}: ${g.text}`);
}
