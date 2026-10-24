#!/usr/bin/env node
/**
 * M15.4.3 零模型回放 harness（阶段 E1）：用当前 dist（v1543 协议 = P0-A 逻辑等价 + P0-A2 指标标记冲突
 * + P0-B 括号绝对值）重放 M15.4.1 38 例（F1-F7）与 M15.4.2 C2 13 例（G1-G3）的已落盘提案，并与
 * M15.4.2 记录基线逐例 diff。臂：
 *   baseline   纯规则证书器（bindTextAtom + certifyClaim，oracle 对照）——受 P0-B（atomQualifiers 生产变更）影响
 *   v1543      已落盘 RawProposal → resolveProposal → verifyProposal（本轮协议；与 M15.4.2 记录的 v1542 对比）
 *   production 已落盘 top 提案注入生产证书器 certifyClaim（受 P0-B 影响）
 * 产物：D:\PaperTeamData\M15\M15_4_3\runs\replay-<ts>.json + 控制台逐例 diff。
 * 用法：node scripts/m1543-replay.mjs [familyKey ...]   # 缺省全部 10 家族
 */
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { statSync } from "node:fs";
import { join } from "node:path";

const SRC_F = "D:\\PaperTeamData\\M15\\M15_4_1"; // 只读（M15.4.1 冻结档案）
const SRC_G = "D:\\PaperTeamData\\M15\\M15_4_2"; // 只读（M15.4.2 冻结档案）
const ROOT = "D:\\PaperTeamData\\M15\\M15_4_3"; // 本轮产物
const REPO = "D:\\Projects\\PaperTeam";
const dist = (...p) => `file://${join(REPO, "backend", "dist", ...p).replaceAll("\\", "/")}`;
const { buildCertificateDocument, locateAtom, bindTextAtom, certifyClaim } = await import(dist("review", "claimCertificate.js"));
const { locateQuote } = await import(dist("review", "claimAuditText.js"));
const { buildTableAllowlist, resolveProposal, verifyProposal } = await import(dist("review", "candidateProposer.js"));

const FAMILIES = {
  "F1-sleepeff": { src: SRC_F, split: "EXPOSED_DEV", proposals: "runs\\propose" },
  "F2-faultloc": { src: SRC_F, split: "EXPOSED_DEV", proposals: "runs\\propose" },
  "F3-npudenoise": { src: SRC_F, split: "EXPOSED_DEV", proposals: "runs\\propose" },
  "F4-msleep": { src: SRC_F, split: "FROZEN_HELDOUT", proposals: "runs\\propose" },
  "F5-continuir": { src: SRC_F, split: "FROZEN_HELDOUT", proposals: "runs\\propose" },
  "F6-vulndet": { src: SRC_F, split: "FROZEN_HELDOUT", proposals: "runs\\propose" },
  "F7-lqrs": { src: SRC_F, split: "FROZEN_HELDOUT", proposals: "runs\\propose" },
  "G1-hdmamba": { src: SRC_G, split: "C2_NEW", proposals: "runs-c2\\propose" },
  "G2-brainiac": { src: SRC_G, split: "C2_NEW", proposals: "runs-c2\\propose" },
  "G3-sparkdiff": { src: SRC_G, split: "C2_NEW", proposals: "runs-c2\\propose" },
};
const ARXIV = {
  "F1-sleepeff": "2609.22148", "F2-faultloc": "2608.11277", "F3-npudenoise": "2605.03680", "F4-msleep": "2606.13694",
  "F5-continuir": "2608.23799", "F6-vulndet": "2604.19031", "F7-lqrs": "2510.10580",
  "G1-hdmamba": "2609.23061", "G2-brainiac": "2609.23026", "G3-sparkdiff": "2609.23153",
};

async function walkTex(root) {
  const files = [];
  const walk = async (d) => {
    for (const name of await readdir(d)) {
      const p = join(d, name);
      if (statSync(p).isDirectory()) await walk(p);
      else if (name.endsWith(".tex")) files.push({ path: p.slice(root.length + 1).replaceAll("\\", "/"), content: await readFile(p, "utf8") });
    }
  };
  await walk(root);
  files.sort((a, b) => (a.path < b.path ? -1 : 1));
  return files;
}

async function caseView(familyKey, kase) {
  const edited = kase.editValue !== null && kase.editValue !== undefined;
  const base = join(FAMILIES[familyKey].src, edited ? join("materialized", familyKey, kase.caseId) : join("candidates", ARXIV[familyKey]));
  const files = await walkTex(base);
  const content = files.find((f) => f.path === kase.file).content;
  const quote = edited ? kase.claimQuote.replace(kase.originalValue, kase.editValue) : kase.claimQuote;
  const span = locateQuote(content, quote);
  if (span === null) throw new Error(`${kase.caseId}: quote not locatable`);
  return { files, content, span, claimValue: kase.editValue ?? kase.targetValue };
}

const cellKey = (c) => `${c.file}|${c.tableId}|${c.row}|${c.col}`;
const bindingGrade = (bound, goldCells) => {
  if (bound === null || bound === undefined) return "abstain";
  const keys = goldCells.map(cellKey);
  if (keys.includes(cellKey(bound))) return "exact";
  if (goldCells.some((g) => g.tableId === bound.tableId)) return "partial";
  return "wrong";
};

const argv = process.argv.slice(2);
const keys = argv.length > 0 ? argv : Object.keys(FAMILIES);
const out = { generatedAt: new Date().toISOString(), adapter: "candidate-proposer-adapter/v3", families: [] };

for (const familyKey of keys) {
  const corpus = JSON.parse(await readFile(join(FAMILIES[familyKey].src, "corpus", `${familyKey}-cases.json`), "utf8"));
  const rows = [];
  for (const kase of corpus.cases) {
    const view = await caseView(familyKey, kase);
    const document = buildCertificateDocument(view.files.map((f) => ({ file: f.path, content: f.content })));
    const claimInput = { file: kase.file, start: view.span.start, end: view.span.end, value: view.claimValue };
    // ---- baseline（受 P0-B 影响）----
    const located = locateAtom(document, kase.file, view.span.start, view.span.end, view.claimValue);
    let baseline;
    if (located.atom === null) baseline = { status: "NOT_INJECTABLE", reason: located.reason, l1: "abstain" };
    else {
      const binding = bindTextAtom(document, located.atom);
      let counterpart = null;
      if (kase.goldCells.length > 0) {
        const gold = kase.goldCells[0];
        const table = document.files.find((f) => f.file === gold.file)?.tables.find((t) => t.tableId === gold.tableId);
        const cell = table?.cells.find((c) => c.row === gold.row && c.col === gold.col);
        if (cell !== undefined && cell.value !== null) counterpart = { file: gold.file, start: cell.valueStart, end: cell.valueEnd, value: cell.value.raw };
      }
      const check = kase.expectedRelation === "SUPPORTED" ? "CONSISTENT" : kase.expectedRelation === "CONTRADICTED" ? "INCONSISTENT" : "CONSISTENT";
      const cert = certifyClaim(document, { claim: claimInput, counterpart, check: counterpart === null ? null : check });
      baseline = {
        status: cert.outcome === "NOT_CERTIFIED" ? "ABSTAIN" : cert.outcome,
        l1: bindingGrade(binding.status === "UNIQUE" ? binding.bound : null, kase.goldCells),
        reasons: cert.reasons.slice(0, 6), comparisonType: cert.comparisonType, bindingRule: binding.rule,
      };
    }
    // ---- v1543（重放已落盘提案 + 本轮协议验证器）----
    let record = null;
    try { record = JSON.parse(await readFile(join(FAMILIES[familyKey].src, FAMILIES[familyKey].proposals, `${kase.caseId}.json`), "utf8")); } catch { /* not run */ }
    let v1543 = { status: "NOT_RUN" };
    let production = { status: "NOT_RUN" };
    if (record !== null) {
      if (record.raw === null) v1543 = { status: "ABSTAIN", category: "PROPOSAL_SCHEMA_INVALID", detail: record.parseError, l1: "abstain" };
      else {
        const allowlist = buildTableAllowlist(document);
        const resolved = resolveProposal(document, record.raw, allowlist);
        const verification = verifyProposal({ document, claim: claimInput, resolved });
        const valid = resolved.candidates.filter((c) => c.status === "RESOLVED" && c.cell !== undefined);
        const l1 = bindingGrade(valid[0]?.cell, kase.goldCells);
        if (verification.status === "ACCEPTED") {
          const wrong = (!kase.expectedCertifiable && kase.expectedRelation === "ABSTAIN_ONLY") || (kase.expectedCertifiable && kase.expectedRelation !== verification.outcome);
          v1543 = {
            status: wrong ? "WRONG_STRONG" : "CORRECT_STRONG", outcome: verification.outcome, l1,
            witness: {
              adapter: verification.witness.version,
              hitCount: verification.witness.uniqueness.hitCount,
              physicalHitCount: verification.witness.uniqueness.physicalHitCount,
              logicalEquivalence: verification.witness.uniqueness.logicalEquivalence.map((c) => ({ members: c.members.length, pairs: c.pairs.length, shared: c.pairs[0]?.sharedMetricColumns ?? null })),
              valueCorroborated: verification.witness.uniqueness.valueCorroborated,
              multiBinding: verification.witness.uniqueness.multiBinding,
              claimQualifiers: verification.witness.claimAtom.qualifiers,
            },
          };
        } else v1543 = { status: "ABSTAIN", category: verification.category, detail: `${verification.reason}: ${verification.detail}`.slice(0, 220), l1 };
        // ---- production（top 提案注入生产证书器；受 P0-B 影响）----
        const top = valid[0];
        if (top === undefined || record.raw.abstain !== undefined) production = { status: "ABSTAIN", reason: record.raw.abstain?.reason ?? "no-valid-candidate", l1 };
        else {
          const table = document.files.find((f) => f.file === top.cell.file)?.tables[top.cell.tableIndex];
          const cell = table?.cells.find((c) => c.row === top.cell.row && c.col === top.cell.col && c.value !== null);
          if (cell === undefined) production = { status: "ABSTAIN", reason: "counterpart-cell-missing", l1 };
          else {
            const cert = certifyClaim(document, {
              claim: claimInput,
              counterpart: { file: top.cell.file, start: cell.valueStart, end: cell.valueEnd, value: cell.value.raw },
              check: record.raw.comparison === "CONSISTENT" ? "CONSISTENT" : record.raw.comparison === "INCONSISTENT" ? "INCONSISTENT" : null,
            });
            production = { status: cert.outcome === "NOT_CERTIFIED" ? "ABSTAIN" : cert.outcome, l1, reasons: cert.reasons.slice(0, 5) };
          }
        }
      }
    }
    rows.push({ caseId: kase.caseId, kind: kase.kind, difficulty: kase.difficulty, expected: kase.expectedRelation, certifiable: kase.expectedCertifiable, baseline, v1543, production });
  }
  out.families.push({ familyKey, split: FAMILIES[familyKey].split, rows });
  for (const r of rows) console.log(`${familyKey} ${r.caseId} [${r.kind}] exp=${r.expected} | base=${r.baseline.status} v1543=${r.v1543.status}${r.v1543.category ? "/" + r.v1543.category : ""}${r.v1543.outcome ? "/" + r.v1543.outcome : ""} prod=${r.production.status}`);
}

await mkdir(join(ROOT, "runs"), { recursive: true });
const outPath = join(ROOT, "runs", `replay-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`);
await writeFile(outPath, JSON.stringify(out, null, 2), "utf8");

// ---- 与 M15.4.2 记录基线逐例 diff ----
const prevF = JSON.parse(await readFile(join(SRC_G, "runs", "replay-zero-model-2026-10-24T13-38-35.json"), "utf8"));
const prevC2 = JSON.parse(await readFile(join(SRC_G, "runs-c2", "score-1792848924251.json"), "utf8"));
const prev = new Map();
for (const fam of prevF.families) for (const row of fam.rows) prev.set(row.caseId, { baseline: row.baseline.status, v1542: row.v1542.status, production: row.production.status });
for (const fam of prevC2.families) for (const row of fam.rows) prev.set(row.caseId, { baseline: row.baseline.status, v1542: row.model.status, production: null });
const flips = [];
const totals = { baseline: { CORRECT_STRONG: 0, WRONG_STRONG: 0, ABSTAIN: 0 }, v1543: { CORRECT_STRONG: 0, WRONG_STRONG: 0, ABSTAIN: 0 }, production: { SUPPORTED: 0, CONTRADICTED: 0, ABSTAIN: 0 } };
for (const fam of out.families) for (const row of fam.rows) {
  const before = prev.get(row.caseId);
  for (const arm of ["baseline", "v1543", "production"]) {
    const s = row[arm].status;
    if (s === "CORRECT_STRONG" || s === "SUPPORTED" || s === "CONTRADICTED") totals[arm][s === "CORRECT_STRONG" ? "CORRECT_STRONG" : s === "SUPPORTED" ? "SUPPORTED" : "CONTRADICTED"] += 1;
    else if (s === "ABSTAIN") totals[arm].ABSTAIN += 1;
  }
  if (before === undefined) continue;
  const pairs = [["baseline", before.baseline], ["v1543", before.v1542], ["production", before.production]];
  for (const [arm, was] of pairs) {
    if (was === null || was === undefined || was === "NOT_RUN") continue;
    const now = row[arm].status;
    if (was !== now) flips.push(`${row.caseId} ${arm}: ${was} -> ${now}`);
  }
}
console.log(`\nTOTALS: ${JSON.stringify(totals)}`);
console.log(`FLIPS vs M15.4.2 (${flips.length}):`);
for (const f of flips) console.log("  " + f);
console.log(`\nwritten: ${outPath}`);
