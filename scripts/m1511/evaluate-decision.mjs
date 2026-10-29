#!/usr/bin/env node
/**
 * M15.11 Phase E — evaluate pre-registered go/no-go conditions (protocol §6)
 * against phase-d/paired-metrics.json. Emits phase-e/decision.json.
 * This script only applies the frozen thresholds; it cannot alter them.
 */
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.M1511_ROOT ? resolve(process.env.M1511_ROOT) : resolve(here, ".."); // data root (env-overridable)
const { summary } = JSON.parse(await readFile(join(ROOT, "phase-d", "paired-metrics.json"), "utf8"));

const fam12 = summary.familiesWithBothArms >= 12;
const issues30 = summary.totalJudgeableIssueFamilies >= 30;
const cov = summary.hriCoverage;
const gain = cov.diff;
const groundedDrop = summary.groundedRatio.c0 - summary.groundedRatio.c1; // positive = C1 worse
const seriousDrop = summary.seriousCoverage.c0 - summary.seriousCoverage.c1;
const refutedC1 = summary.refutedTotal.c1;
const refutedC0 = summary.refutedTotal.c0;
const findingsC1 = summary.findingsTotal.c1 || 1;
const findingsC0 = summary.findingsTotal.c0 || 1;
const refutedRateC1 = refutedC1 / findingsC1;
const refutedRateC0 = refutedC0 / findingsC0;
const callRatio = summary.costPerFamily.c1.calls / Math.max(1, summary.costPerFamily.c0.calls);

const conditions = {
  dataFloor: { fam12, issues30, families: summary.familiesWithBothArms, judgeableIssueFamilies: summary.totalJudgeableIssueFamilies },
  coverageGainGe10pp: gain != null && gain >= 0.10,
  groundedNotWorseThan5pp: groundedDrop <= 0.05,
  seriousNotWorseThan5pp: seriousDrop <= 0.05,
  refutedNotIncreasedBeyond5pp: refutedRateC1 - refutedRateC0 <= 0.05,
};
const promising = Object.values(conditions).slice(1).every(Boolean) && conditions.dataFloor.fam12 && conditions.dataFloor.issues30;
const costInefficient = callRatio > 3 && gain < 0.10;

let decision;
if (!fam12 || !issues30) {
  decision = "EXPERIMENT_PARTIAL"; // data floor not met on judged scope
} else if (promising && !costInefficient) {
  decision = "PILOT_PROMISING";
} else if (promising && costInefficient) {
  decision = "PILOT_PROMISING"; // with COST_INEFFICIENT flag per protocol
} else {
  decision = "PILOT_NO_MEASURABLE_GAIN";
}
const flags = { COST_INEFFICIENT: costInefficient };
const out = {
  decidedAt: new Date().toISOString(),
  decision,
  flags,
  conditions,
  numbers: {
    hriCoverageC0: cov.c0,
    hriCoverageC1: cov.c1,
    diff: cov.diff,
    diffCI95: cov.diffCI,
    seriousCoverage: summary.seriousCoverage,
    groundedRatio: summary.groundedRatio,
    refuted: { c0: refutedC0, c1: refutedC1, rateC0: refutedRateC0, rateC1: refutedRateC1 },
    findings: summary.findingsTotal,
    costPerFamily: summary.costPerFamily,
    callRatio,
  },
  scopeNote: "探索性判据（exploratory），非发表级统计显著性；结论限于本数据集与本 judge 代理；不改变 M15_OVERALL=INCOMPLETE，不构成任何期刊录用水平声称。",
};
await writeFile(join(ROOT, "phase-e", "decision.json"), JSON.stringify(out, null, 1), "utf8");
console.log(JSON.stringify(out, null, 1));
