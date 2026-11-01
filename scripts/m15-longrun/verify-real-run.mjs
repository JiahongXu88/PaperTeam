#!/usr/bin/env node
/**
 * M15 长程 E2：真实运行工件核验（零模型，只读）。回答 PROTOCOL.md §1 的 Q1–Q3。
 * 用法：node scripts/m15-longrun/verify-real-run.mjs --project <projectDir> --out <json>
 */
import { createHash } from "node:crypto";
import { readFile, readdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

const arg = (name) => process.argv[process.argv.indexOf(`--${name}`) + 1];
const DIR = arg("project");
const OUT = arg("out");
const readJson = async (path, fallback = null) => { try { return JSON.parse(await readFile(path, "utf8")); } catch { return fallback; } };
const sha = (buffer) => createHash("sha256").update(buffer).digest("hex");

async function texFiles(root, base = root, out = new Map()) {
  let entries = [];
  try { entries = await readdir(root, { withFileTypes: true }); } catch { return out; }
  for (const entry of entries) {
    const full = join(root, entry.name);
    if (entry.isDirectory()) await texFiles(full, base, out);
    else if (entry.name.endsWith(".tex")) out.set(full.slice(base.length + 1).replaceAll("\\", "/"), sha(await readFile(full)));
  }
  return out;
}

const report = { project: DIR, q1: {}, q2: [], q3: {}, verdicts: {} };

// Q1：review.snapshot 经 commitReviewSnapshot（provenance 字段 / 无吸收的 Agent 写入）+ Agent 写入日志
const revisions = await readJson(join(DIR, "manuscript", "revisions.json"), { revisions: [] });
const journalRaw = await readFile(join(DIR, "workflow", "agent-writes.jsonl"), "utf8").catch(() => "");
const journal = journalRaw.split("\n").filter((line) => line.trim() !== "").map((line) => JSON.parse(line));
report.q1 = {
  revisions: revisions.revisions.map((record) => ({ revision: record.revision, reason: record.reason, provenance: record.provenance ?? null })),
  agentWriteJournalEntries: journal.length,
  quarantine: await readdir(join(DIR, "workflow", "review-snapshot-quarantine")).catch(() => []),
};
// 每条日志记录：若其哈希出现在某个 review.snapshot 修订快照中（且该修订之前的修订不含此内容）= 被吸收（违规）
const absorbed = [];
for (const record of revisions.revisions.filter((entry) => entry.reason === "review.snapshot")) {
  const files = await texFiles(join(DIR, "manuscript", "revisions", `rev-${record.revision}`));
  const previous = record.revision > 1 ? await texFiles(join(DIR, "manuscript", "revisions", `rev-${record.revision - 1}`)) : new Map();
  for (const entry of journal) {
    if (Date.parse(entry.at) >= Date.parse(record.createdAt)) continue;
    if (files.get(entry.path) === entry.sha256 && previous.get(entry.path) !== entry.sha256) absorbed.push({ revision: record.revision, path: entry.path });
  }
}
report.q1.agentWritesAbsorbedBySnapshot = absorbed;

// Q2：gate 产物嵌入报告且 passed ≡ finalizable、L4 UNVALIDATED
const reviews = await readdir(join(DIR, "reviews")).catch(() => []);
for (const file of reviews.filter((name) => /^quality-gate-r\d+\.json$/.test(name)).sort()) {
  const artifact = await readJson(join(DIR, "reviews", file));
  const q = artifact?.gate?.qualityReport;
  report.q2.push({
    file,
    hasReport: q?.schemaVersion === "quality-report/v1",
    passed: artifact?.gate?.passed,
    finalizable: q?.overall?.finalizable,
    overall: q?.overall?.status,
    layers: q ? Object.fromEntries(Object.entries(q.layers).map(([id, layer]) => [id, layer.status])) : null,
    blocking: q ? Object.fromEntries(Object.entries(q.layers).map(([id, layer]) => [id, layer.blocking])) : null,
    compatDifference: q?.compat?.difference ?? null,
    entry: q?.binding?.entry,
  });
}

// Q3：修订写入全部经编辑契约
const store = await readJson(join(DIR, "research", "edit-contracts.json"), { events: [], approvals: [], contracts: [] });
const events = store.events ?? [];
const accepted = events.filter((event) => event.kind === "candidate_accepted");
const acceptedHashes = new Set(accepted.map((event) => event.appliedHash).filter(Boolean));
const unvalidatedTex = [];
for (const record of revisions.revisions.filter((entry) => entry.reason.startsWith("revision."))) {
  const files = await texFiles(join(DIR, "manuscript", "revisions", `rev-${record.revision}`));
  const previous = await texFiles(join(DIR, "manuscript", "revisions", `rev-${record.revision - 1}`));
  for (const [path, hash] of files) {
    if (previous.get(path) === hash || path === "main.tex") continue; // main.tex 由已校验大纲 / 章节确定性组装
    if (!acceptedHashes.has(hash)) unvalidatedTex.push({ revision: record.revision, reason: record.reason, path });
  }
}
report.q3 = {
  contracts: (store.contracts ?? []).length,
  approvals: (store.approvals ?? []).map((approval) => ({ kind: approval.kind, actor: approval.actor, approvedValueChanges: approval.approvedValueChanges?.length ?? 0 })),
  events: Object.fromEntries([...new Set(events.map((event) => event.kind))].map((kind) => [kind, events.filter((event) => event.kind === kind).length])),
  rejectionCodes: Object.fromEntries([...new Set(events.filter((event) => event.kind === "candidate_rejected").flatMap((event) => event.codes))].map((code) => [code, events.filter((event) => event.kind === "candidate_rejected" && event.codes.includes(code)).length])),
  valueChangeRequests: (store.valueChangeRequests ?? []).map((request) => ({ target: request.target, before: request.before, after: request.after, status: request.status })),
  revisionTexWithoutAcceptedEvent: unvalidatedTex,
};

report.verdicts = {
  Q1: absorbed.length === 0 ? "PASS" : "FAIL",
  Q2: report.q2.length > 0 && report.q2.every((gate) => gate.hasReport && gate.passed === gate.finalizable && gate.layers?.L4 === "UNVALIDATED") ? "PASS" : report.q2.length === 0 ? "NOT_EVALUATED" : "FAIL",
  Q3: unvalidatedTex.length === 0 ? "PASS" : "REVIEW",
};
await writeFile(OUT, JSON.stringify(report, null, 2), "utf8");
console.log(JSON.stringify({ verdicts: report.verdicts, q2: report.q2.map((gate) => [gate.file, gate.overall, gate.passed]), q3: { events: report.q3.events, unvalidated: unvalidatedTex.length, vcr: report.q3.valueChangeRequests.length }, journal: journal.length }, null, 1));
