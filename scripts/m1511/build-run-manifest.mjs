#!/usr/bin/env node
/**
 * M15.11 — build phase-c/run-manifest.json + arm-configs.json
 * Summarizes per-family arm runs (status, calls, wall, findings, coverage inputs)
 * plus the frozen arm configuration for the record.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.M1511_ROOT ? resolve(process.env.M1511_ROOT) : resolve(here, ".."); // data root (env-overridable)
const manifest = JSON.parse(await readFile(join(ROOT, "phase-b", "SAMPLE_MANIFEST.json"), "utf8"));
const heldOut = manifest.families.filter((f) => f.role === "HELD-OUT" && f.familyId).slice(0, 12);
const dev = manifest.families.filter((f) => f.role === "DEV" && f.familyId);

const callsLog = (await readFile(join(ROOT, "phase-c", "model-calls.jsonl"), "utf8"))
  .trim().split("\n").filter(Boolean).map((l) => JSON.parse(l));

async function famEntry(fam) {
  const base = join(ROOT, "phase-c", "out", fam.familyId);
  const entry = { familyId: fam.familyId, role: fam.role, title: fam.title.slice(0, 80), primaryArea: fam.primaryArea };
  for (const arm of ["c0", "c1"]) {
    try {
      const d = JSON.parse(await readFile(join(base, `${arm}.json`), "utf8"));
      entry[arm] = arm === "c0"
        ? { status: d.status, calls: d.calls, attempts: d.attempts, findings: (d.findings ?? []).length, inputChars: d.inputChars, wallMs: d.wallMs, parseFailed: d.parseFailed ?? false }
        : { status: d.status, calls: d.calls, findingsTotal: d.findingsTotal, sectionsReviewed: d.sectionsReviewed, sectionsTotal: d.sectionsTotal, failedSections: (d.failedSections ?? []).length, wallMs: d.wallMs };
    } catch {
      entry[arm] = null;
    }
  }
  return entry;
}
const runs = [];
for (const fam of [...dev, ...heldOut]) runs.push(await famEntry(fam));

const armConfigs = {
  frozenAt: "2026-10-29",
  model: "zai-coding-cn/glm-5.3 (Z.AI Coding Plan channel via PiRuntimeAdapter; auth via ~/.paperteam/runtime/pi/agent/auth.json)",
  c0: {
    entry: "adapter.runAgent direct, contextScope m1511-c0/<fam>, default role, zero skills (routing.ts default has no bindings), toolPolicy=read_only",
    input: "same-project PyMuPDF chunks reassembled with [page N] markers",
    promptHashNote: "PROTOCOL_FROZEN.md §7 (verbatim)",
    parse: "production parseSectionFindingsOutput; 1 retry allowed",
  },
  c1: {
    entry: "production existing_paper_review workflow via in-process orchestrator (m1586 template assembly)",
    runRequest: { kind: "existing_paper_review", citationSemanticMode: "off" },
    stagesRun: ["paper.ensure (incl. PaperMap section summaries)", "citation.extract (deterministic)", "citation.metadata", "review.sections (academic-review skill)", "review.aggregate"],
    productFixApplied: "sectionChunking.findReferencesPage author-year relaxation (deviation v2.2)",
  },
  c2: { status: "NOT_RUN", reason: "no legitimate ICLR guideline artifact; CJIG/CEA stats must not be transferred (protocol §2)" },
  judge: {
    model: "same glm-5.3 (LLM_JUDGE_PROXY limitation)",
    design: "blind Set A (human issue families) x Set B (one arm's findings); language-neutral clause (deviation v3)",
  },
};

const byArmHint = {};
for (const c of callsLog) {
  const k = c.armHint;
  byArmHint[k] = (byArmHint[k] ?? 0) + 1;
}
const usage = callsLog.reduce(
  (acc, c) => {
    const u = c.usage ?? {};
    acc.calls += 1;
    acc.inputTokens += u.inputTokens ?? 0;
    acc.outputTokens += u.outputTokens ?? 0;
    acc.cacheReadTokens += u.cacheReadTokens ?? 0;
    acc.estimatedCostUsd += u.estimatedCost ?? 0;
    return acc;
  },
  { calls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, estimatedCostUsd: 0 },
);
await writeFile(join(ROOT, "phase-c", "run-manifest.json"), JSON.stringify({ generatedAt: new Date().toISOString(), runs, physicalCallLedger: { inLog: byArmHint, usage }, preResetCalls: 20 }, null, 1), "utf8");
await writeFile(join(ROOT, "phase-c", "arm-configs.json"), JSON.stringify(armConfigs, null, 1), "utf8");
console.log(JSON.stringify({ runs: runs.length, completedBoth: runs.filter((r) => r.c0 && r.c1 && r.c0.status === "ok" && r.c1.status === "completed").length }, null, 1));
