#!/usr/bin/env node
/**
 * M16 收口 · B0：零模型诊断（只读 M16 首轮已开封的封存集裁判输出，DEV_OPENED）。
 *
 *   node scripts/m16-closure/b0-dev-rescore.mjs
 *
 * 问题：把人类参考限定为 SPECIFIC 后，M16 原裁判输出里「通用套话 G0」与「全文单次 Afull」能否拉开？
 * 只重算，不调用模型；结果只用于设计（不作为 B 门证据）。输出 <ROOT>\B\b0-dev-rescore.json
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";

import { bootstrapCi, humanWeaknesses, loadCocoRecords } from "../m16-review-validity/lib.mjs";
import { M16, ROOT, readJson } from "./lib.mjs";
import { classifyOpinion, loadCorpus } from "./specificity.mjs";

const corpus = loadCorpus(humanWeaknesses);
const sel = readJson(join(M16, "B", "sealed-selection.json")).selected;
const judge = readJson(join(M16, "C", "judge-sealed.json"));
const records = loadCocoRecords(sel.map((p) => p.id));
const ARMS = ["G0", "Atrunc", "Afull", "Bfull"];
const per = [];
for (const p of sel) {
  const md = readFileSync(join(M16, "external", "cocoreviewbench-md", p.mdPath.replace(/^benchmark\/MD\//, "")), "utf8");
  const human = humanWeaknesses(records.get(p.id));
  const labels = human.map((o) => classifyOpinion(o.text, p.id, md, corpus));
  const j = judge[p.id];
  const row = { id: p.id, human: human.length, specific: labels.filter((l) => l.label === "SPECIFIC").length, arms: {} };
  for (const arm of ARMS) {
    const list = j.lists.find((l) => l.arm === arm);
    const hits = new Set();
    for (let i = 1; i <= Math.min(10, list.n); i += 1) for (const h of j.matches[`${list.label}-${i}`] ?? []) hits.add(Number(String(h).slice(1)) - 1);
    const spec = [...hits].filter((k) => labels[k]?.label === "SPECIFIC").length;
    const gen = [...hits].filter((k) => labels[k]?.label === "GENERIC").length;
    row.arms[arm] = { recallAll: hits.size / human.length, recallSpecific: row.specific ? spec / row.specific : null, recallGeneric: human.length - row.specific ? gen / (human.length - row.specific) : null };
  }
  row.examples = human.slice(0, 40).map((o, k) => ({ k: k + 1, label: labels[k].label, anchor: labels[k].anchor, terms: labels[k].terms.slice(0, 6), text: o.text.slice(0, 160) }));
  per.push(row);
}
const summary = {};
for (const arm of ARMS) {
  summary[arm] = {
    recallAll: bootstrapCi(per.map((r) => r.arms[arm].recallAll)),
    recallSpecific: bootstrapCi(per.filter((r) => r.specific > 0).map((r) => r.arms[arm].recallSpecific)),
    recallGeneric: bootstrapCi(per.filter((r) => r.human > r.specific).map((r) => r.arms[arm].recallGeneric)),
  };
}
const diff = (a, b, key) => bootstrapCi(per.filter((r) => r.arms[a][key] !== null).map((r) => r.arms[a][key] - r.arms[b][key]));
const contrasts = { "Afull-G0 specific": diff("Afull", "G0", "recallSpecific"), "Afull-G0 all": diff("Afull", "G0", "recallAll"), "Afull-G0 generic": diff("Afull", "G0", "recallGeneric") };
writeFileSync(join(ROOT, "B", "b0-dev-rescore.json"), `${JSON.stringify({ schema: "m16-closure-b0/v1", set: "DEV_OPENED (M16 sealed 8)", generatedAt: new Date().toISOString(), summary, contrasts, per }, null, 1)}\n`);
const f = (c) => `${(c.mean * 100).toFixed(1)} [${(c.low * 100).toFixed(1)}, ${(c.high * 100).toFixed(1)}]`;
console.log("papers", per.map((r) => `${r.id}:${r.specific}/${r.human}`).join(" "));
for (const arm of ARMS) console.log(arm.padEnd(7), "all", f(summary[arm].recallAll), "| specific", f(summary[arm].recallSpecific), "| generic", f(summary[arm].recallGeneric));
for (const [k, v] of Object.entries(contrasts)) console.log(k, f(v));
