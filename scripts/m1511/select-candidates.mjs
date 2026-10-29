#!/usr/bin/env node
/**
 * M15.11 Phase B — stratified, seeded, metadata-only candidate selection.
 *
 * Frame: ICLR 2025 version-confirmed rejected families (from phase-a/sampling-frame.json).
 * Strata: collapsed primary-area buckets.
 * Selection inputs: metadata only (venueid/invitations/pdf/primaryArea/tcdate/title/number).
 * Review text is NOT read at this stage.
 *
 * Output: phase-b/candidate-list.json (ordered by seeded shuffle; role assignment
 * happens after qualification check in a separate step).
 */
import { readFile, writeFile } from "node:fs/promises";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const frame = JSON.parse(await readFile(resolve(here, "phase-a", "sampling-frame.json"), "utf8"));
const SEED = 1511;
const TARGET = 34; // 24 planned (8 DEV + 16 HELD-OUT) + attrition reserve

// deterministic PRNG (mulberry32)
function mulberry32(a) {
  return function () {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const rng = mulberry32(SEED);

// collapse primary areas into buckets (order matters for allocation)
const AREA_BUCKETS = [
  { name: "cv-multimodal", match: ["applications to computer vision", "representation learning for computer vision", "visualization or interpretation"] },
  { name: "generative", match: ["generative models"] },
  { name: "representation", match: ["unsupervised, self-supervised", "transfer learning, meta learning"] },
  { name: "llm-foundation", match: ["foundation or frontier models"] },
  { name: "rl-planning-robotics", match: ["reinforcement learning", "robotics, autonomy, planning"] },
  { name: "graphs-geometry", match: ["graphs and other geometries"] },
  { name: "optimization-theory", match: ["optimization", "learning theory"] },
  { name: "interpretability-safety", match: ["interpretability and explainable", "alignment, fairness, safety"] },
  { name: "data-benchmarks", match: ["datasets and benchmarks"] },
  { name: "sciences-neuro", match: ["physical sciences", "neuroscience"] },
  { name: "probabilistic-causal", match: ["probabilistic methods", "causal reasoning"] },
  { name: "other-ml", match: [] }, // catch-all
];

function bucketOf(area) {
  const a = (area ?? "").toLowerCase();
  for (const b of AREA_BUCKETS) {
    if (b.match.some((m) => a.includes(m))) return b.name;
  }
  return "other-ml";
}

const pool = frame.families.filter((f) => f.venueid === "ICLR.cc/2025/Conference/Rejected_Submission");
// stratified seeded selection: proportional allocation with min 1, largest-remainder
const strata = new Map();
for (const f of pool) {
  const b = bucketOf(f.primaryArea);
  if (!strata.has(b)) strata.set(b, []);
  strata.get(b).push(f);
}
const names = [...strata.keys()].sort();
const sizes = names.map((n) => strata.get(n).length);
const total = sizes.reduce((a, b) => a + b, 0);
const raw = sizes.map((s) => (TARGET * s) / total);
const alloc = raw.map(Math.floor);
let remaining = TARGET - alloc.reduce((a, b) => a + b, 0);
// min 1 for every stratum (from remainders, then largest remainder rule)
for (let i = 0; i < alloc.length && remaining > 0; i += 1) {
  if (alloc[i] === 0) {
    alloc[i] = 1;
    remaining -= 1;
  }
}
const order = names
  .map((n, i) => ({ i, frac: raw[i] - Math.floor(raw[i]) }))
  .sort((a, b) => b.frac - a.frac);
for (const { i } of order) {
  if (remaining <= 0) break;
  if (alloc[i] > 0) {
    alloc[i] += 1;
    remaining -= 1;
  }
}
// seeded shuffle within each stratum, then take allocation
const selected = [];
for (let i = 0; i < names.length; i += 1) {
  const members = strata.get(names[i]).slice();
  for (let j = members.length - 1; j > 0; j -= 1) {
    const k = Math.floor(rng() * (j + 1));
    [members[j], members[k]] = [members[k], members[j]];
  }
  for (const m of members.slice(0, alloc[i])) {
    selected.push({
      candidateId: "cand-" + String(selected.length + 1).padStart(2, "0"),
      noteId: m.id,
      number: m.number,
      title: m.title,
      titleShaHint: null,
      primaryArea: m.primaryArea,
      bucket: names[i],
      venueid: m.venueid,
      tcdate: m.tcdate,
      pdfPath: m.pdf,
      invSuffixes: m.invSuffixes,
    });
  }
}
// final seeded shuffle across all selected (role assignment order)
for (let j = selected.length - 1; j > 0; j -= 1) {
  const k = Math.floor(rng() * (j + 1));
  [selected[j], selected[k]] = [selected[k], selected[j]];
}
selected.forEach((s, i) => (s.candidateId = "cand-" + String(i + 1).padStart(2, "0")));

await writeFile(
  resolve(here, "phase-b", "candidate-list.json"),
  JSON.stringify({ generatedAt: new Date().toISOString(), seed: SEED, target: TARGET, frameFile: "phase-a/sampling-frame.json", strataAlloc: Object.fromEntries(names.map((n, i) => [n, { pool: sizes[i], alloc: alloc[i] }])) , candidates: selected }, null, 1),
  "utf8",
);
console.log(JSON.stringify({ pool, selected: selected.length, alloc: Object.fromEntries(names.map((n, i) => [n, alloc[i]])) }, null, 1));
