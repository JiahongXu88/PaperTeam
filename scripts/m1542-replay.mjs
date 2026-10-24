#!/usr/bin/env node
/**
 * M15.4.2 零模型回放 harness（C1 对照臂；只读 M15_4_1 冻结数据，产物写 D:\PaperTeamData\M15\M15_4_2\）。
 *
 * 臂：
 *   baseline   纯规则证书器（bindTextAtom + certifyClaim，oracle 对照）——历史 replay 语义
 *   v1541      已落盘 RawProposal → resolveProposal → verifyProposal（M15.4.1 实验验证器，当前代码重放）
 *   production 已落盘 top 提案注入生产证书器 certifyClaim（零模型后验）
 *
 * 另输出逐案例阶段漏斗诊断（funnel）：每个阶段独立评估，记录 primary（按验证器真实顺序的首个失败）
 * 与 allStages（可叠加多标签），供 BASELINE_AND_PRE_REGISTERED_GATES 分类使用。
 *
 * 用法：node scripts/m1542-replay.mjs            # 全部 7 家族
 *       node scripts/m1542-replay.mjs F2-faultloc
 */
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const SRC = "D:\\PaperTeamData\\M15\\M15_4_1"; // 只读（冻结档案）
const ROOT = "D:\\PaperTeamData\\M15\\M15_4_2"; // 本轮产物
const REPO = "D:\\Projects\\PaperTeam";
const dist = (...p) => `file://${join(REPO, "backend", "dist", ...p).replaceAll("\\", "/")}`;
const { buildCertificateDocument, locateAtom, bindTextAtom, certifyClaim, textScopes, contextTokens } = await import(dist("review", "claimCertificate.js"));
const { locateQuote } = await import(dist("review", "claimAuditText.js"));
const { buildTableAllowlist, resolveProposal, verifyProposal, renderAllowlist } = await import(dist("review", "candidateProposer.js"));
const { plainLatexText } = await import(dist("review", "latexTable.js"));

const FAMILIES = {
  "F1-sleepeff": { arxiv: "2609.22148", split: "EXPOSED_DEV" },
  "F2-faultloc": { arxiv: "2608.11277", split: "EXPOSED_DEV" },
  "F3-npudenoise": { arxiv: "2605.03680", split: "EXPOSED_DEV" },
  "F4-msleep": { arxiv: "2606.13694", split: "FROZEN_HELDOUT" },
  "F5-continuir": { arxiv: "2608.23799", split: "FROZEN_HELDOUT" },
  "F6-vulndet": { arxiv: "2604.19031", split: "FROZEN_HELDOUT" },
  "F7-lqrs": { arxiv: "2510.10580", split: "FROZEN_HELDOUT" },
};

async function familyFiles(familyKey) {
  const dir = join(SRC, "candidates", FAMILIES[familyKey].arxiv);
  const files = [];
  const walk = async (d) => {
    for (const name of await readdir(d, { withFileTypes: true })) {
      if (name.isDirectory()) await walk(join(d, name.name));
      else if (name.name.endsWith(".tex")) files.push({ abs: join(d, name.name), rel: join(d, name.name).slice(dir.length + 1).replaceAll("\\", "/") });
    }
  };
  await walk(dir);
  files.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  return Promise.all(files.map(async (f) => ({ path: f.rel, content: await readFile(f.abs, "utf8") })));
}

async function caseView(familyKey, kase) {
  const edited = kase.editValue !== null && kase.editValue !== undefined;
  if (!edited) {
    const files = await familyFiles(familyKey);
    const content = files.find((f) => f.path === kase.file).content;
    const span = locateQuote(content, kase.claimQuote);
    if (span === null) throw new Error(`${kase.caseId}: quote not locatable`);
    return { files, content, span, claimValue: kase.targetValue };
  }
  const files = [];
  const dir = join(SRC, "materialized", familyKey, kase.caseId);
  const walk = async (d) => {
    for (const name of await readdir(d, { withFileTypes: true })) {
      if (name.isDirectory()) await walk(join(d, name.name));
      else if (name.name.endsWith(".tex")) files.push({ abs: join(d, name.name), rel: join(d, name.name).slice(dir.length + 1).replaceAll("\\", "/") });
    }
  };
  await walk(dir);
  files.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  const loaded = await Promise.all(files.map(async (f) => ({ path: f.rel, content: await readFile(f.abs, "utf8") })));
  const content = loaded.find((f) => f.path === kase.file).content;
  const effectiveQuote = kase.claimQuote.replace(kase.originalValue, kase.editValue);
  const span = locateQuote(content, effectiveQuote);
  if (span === null) throw new Error(`${kase.caseId}: edited quote not locatable`);
  return { files: loaded, content, span, claimValue: kase.editValue };
}

const cellKey = (c) => `${c.file}|${c.tableId}|${c.row}|${c.col}`;
const bindingGrade = (bound, goldCells) => {
  if (bound === null || bound === undefined) return "abstain";
  const keys = goldCells.map(cellKey);
  if (keys.includes(cellKey(bound))) return "exact";
  if (goldCells.some((g) => g.tableId === bound.tableId)) return "partial";
  return "wrong";
};

/** 逐阶段独立诊断（分析专用；不改变验证器语义）。每阶段返回 {ok, detail}，失败叠加进 allStages。 */
function funnelDiagnose(document, kase, view, record) {
  const stages = [];
  const add = (id, ok, detail) => stages.push({ id, ok, detail });
  if (record.parseError !== null && record.raw === null) {
    add("S1_PARSE", false, record.parseError);
    return stages;
  }
  add("S1_PARSE", true, "");
  const located = locateAtom(document, kase.file, view.span.start, view.span.end, view.claimValue);
  add("S0_ATOM_LOCATED", located.atom !== null, located.reason ?? "ok");
  if (located.atom === null) return stages;
  const valid = (record.resolved?.candidates ?? []).filter((c) => c.status === "RESOLVED" && c.cell !== undefined && c.value !== undefined);
  add("S2_ALIAS_RESOLVED", valid.length > 0, `${valid.length}/${record.raw.candidates.length}`);
  if (valid.length === 0) return stages;
  const top = valid[0];
  const l1 = bindingGrade(top.cell, kase.goldCells);
  add("S2_L1_EXACT", l1 === "exact", l1);
  // S3 quote：对模型可见渲染文本 + 全文 plain（与 verifyProposal 相同的可定位面）
  const quotes = valid.flatMap((c) => c.raw.evidenceQuotes).map((q) => q.trim()).filter(Boolean);
  const norm = (t) => plainLatexText(t).replace(/\s+/g, " ").trim().toLowerCase();
  const visible = `${renderAllowlist(buildTableAllowlist(document))}\n${document.files.map((f) => plainLatexText(f.content)).join("\n")}`;
  const badQuotes = quotes.filter((q) => !norm(visible).includes(norm(q)));
  add("S3_QUOTE_VERBATIM", badQuotes.length === 0, badQuotes.length === 0 ? `${quotes.length} quotes` : `bad: ${badQuotes[0].slice(0, 60)}`);
  // S4 subject anaphora 形态诊断（主语是否回指词、前文是否有唯一专名锚）
  const entry = document.files.find((f) => f.file === kase.file);
  const scopes = textScopes(entry.content, located.atom.start, located.atom.end);
  const sentencePlain = norm(scopes.sentence);
  const anaphoric = /\b(?:this (?:method|approach|model|work|framework|architecture|strategy)|our (?:method|approach|model|framework)|the (?:model|method|approach)|the same (?:two|three|both)? ?models?|the proposed (?:method|approach|model))\b/i.test(scopes.sentence);
  const subject = record.raw.subject;
  add("S4_SUBJECT_FORM", true, `subject="${subject}" anaphoricSentence=${anaphoric}`);
  // S4 terms-from-claim：模型给的词是否都能在论断语境找到
  const STOP = new Set(["the", "a", "an", "of", "on", "in", "for", "and", "or", "to", "by", "at", "from", "as", "is", "are", "was", "were", "be", "with", "its", "their", "this", "that", "these", "those", "method", "methods", "model", "models", "approach", "approaches", "results", "result", "table", "tab", "score", "scores", "performance", "metric", "metrics", "value", "values", "which", "while", "whereas", "also", "both", "all", "each", "respectively", "using", "used", "use", "our", "ours", "we", "proposed", "work", "paper", "new", "et", "al", "fig", "figure", "sec", "section", "see", "eq", "i", "e", "g", "vs", "via"]);
  const claimTokens = new Set([...contextTokens(scopes.sentence), ...contextTokens(scopes.segment), ...contextTokens(scopes.window)].filter((t) => !STOP.has(t) && t.length >= 2));
  const split = (s) => (s.trim() === "" ? [] : s.trim().split(/\s*[,;]\s*|\s+/).filter(Boolean));
  const missingTerms = [...split(subject), ...split(record.raw.metric)].filter((t) => t.trim() !== "" && !claimTokens.has(t.toLowerCase()) && !norm(scopes.sentence).includes(norm(t)) && !norm(scopes.window).includes(norm(t)));
  add("S4_TERMS_FROM_CLAIM", missingTerms.length === 0, missingTerms.length === 0 ? "all terms in claim" : `missing: ${missingTerms.join("|")}`);
  return stages;
}

const argv = process.argv.slice(2);
const keys = argv.length > 0 ? argv : Object.keys(FAMILIES);
const out = { generatedAt: new Date().toISOString(), source: SRC, families: [] };

for (const familyKey of keys) {
  const corpus = JSON.parse(await readFile(join(SRC, "corpus", `${familyKey}-cases.json`), "utf8"));
  const rows = [];
  for (const kase of corpus.cases) {
    const view = await caseView(familyKey, kase);
    const document = buildCertificateDocument(view.files.map((f) => ({ file: f.path, content: f.content })));
    const claimInput = { file: kase.file, start: view.span.start, end: view.span.end, value: view.claimValue };
    // ---- baseline ----
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
    // ---- v1542（重放已落盘提案 + M15.4.2 协议验证器）----
    let record = null;
    try { record = JSON.parse(await readFile(join(SRC, "runs", "propose", `${kase.caseId}.json`), "utf8")); } catch { /* not run */ }
    let v1542 = { status: "NOT_RUN" };
    let production = { status: "NOT_RUN" };
    let funnel = null;
    if (record !== null) {
      if (record.raw === null) v1542 = { status: "ABSTAIN", category: "PROPOSAL_SCHEMA_INVALID", detail: record.parseError, l1: "abstain" };
      else {
        const allowlist = buildTableAllowlist(document);
        const resolved = resolveProposal(document, record.raw, allowlist);
        const verification = verifyProposal({ document, claim: claimInput, resolved });
        const valid = resolved.candidates.filter((c) => c.status === "RESOLVED" && c.cell !== undefined);
        const l1 = bindingGrade(valid[0]?.cell, kase.goldCells);
        if (verification.status === "ACCEPTED") {
          const wrong = (!kase.expectedCertifiable && kase.expectedRelation === "ABSTAIN_ONLY") || (kase.expectedCertifiable && kase.expectedRelation !== verification.outcome);
          v1542 = {
            status: wrong ? "WRONG_STRONG" : "CORRECT_STRONG", outcome: verification.outcome, l1,
            witness: {
              adapter: verification.witness.version, anaphora: verification.witness.anaphora ? { kind: verification.witness.anaphora.kind, subject: verification.witness.anaphora.effectiveSubject } : null,
              quotes: verification.witness.quotes.map((q) => q.verdict),
              hitCount: verification.witness.uniqueness.hitCount, valueCorroborated: verification.witness.uniqueness.valueCorroborated,
              rowCitation: verification.witness.citations.row.text.slice(0, 100),
            },
          };
        } else v1542 = { status: "ABSTAIN", category: verification.category, detail: `${verification.reason}: ${verification.detail}`.slice(0, 200), l1 };
        // ---- production（top 提案注入生产证书器）----
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
      funnel = funnelDiagnose(document, kase, view, record);
    }
    rows.push({ caseId: kase.caseId, kind: kase.kind, difficulty: kase.difficulty, expected: kase.expectedRelation, certifiable: kase.expectedCertifiable, baseline, v1542, production, funnel });
  }
  const count = (arm, key) => rows.reduce((acc, r) => { const s = r[arm].status; acc[s] = (acc[s] ?? 0) + 1; if (key && r[arm][key]) { const l = r[arm][key]; acc[`L1:${l}`] = (acc[`L1:${l}`] ?? 0) + 1; } return acc; }, {});
  out.families.push({ familyKey, split: FAMILIES[familyKey].split, cases: rows.length, baselineStatus: count("baseline", "l1"), v1542Status: count("v1542", "l1"), productionStatus: count("production", "l1"), rows });
  console.log(`${familyKey} (${FAMILIES[familyKey].split}):`);
  for (const r of rows) console.log(`  ${r.caseId} [${r.kind}] exp=${r.expected} | base=${r.baseline.status}/${r.baseline.l1} v1542=${r.v1542.status}${r.v1542.category ? "/" + r.v1542.category : ""}${r.v1542.outcome ? "/" + r.v1542.outcome : ""} prod=${r.production.status}`);
}

await mkdir(join(ROOT, "runs"), { recursive: true });
await writeFile(join(ROOT, "runs", `replay-zero-model-${new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19)}.json`), JSON.stringify(out, null, 2), "utf8");
// 汇总
const tot = { baseline: {}, v1542: {}, production: {} };
for (const f of out.families) for (const r of f.rows) for (const arm of ["baseline", "v1542", "production"]) {
  const s = r[arm].status;
  tot[arm][s] = (tot[arm][s] ?? 0) + 1;
}
const cats = {};
for (const f of out.families) for (const r of f.rows) if (r.v1542.category) cats[r.v1542.category] = (cats[r.v1542.category] ?? 0) + 1;
console.log(`\nTOTALS: ${JSON.stringify(tot, null, 1)}`);
console.log(`v1542 abstain cats: ${JSON.stringify(cats)}`);
