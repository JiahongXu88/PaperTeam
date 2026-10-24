#!/usr/bin/env node
/**
 * M15.4.2 C2 真实模型运行（封存样本一轮提案；≤40 调用；逐调用 usage 落盘）+ 零模型基线臂 + 评分。
 * 用法：
 *   node scripts/m1542-c2.mjs baseline        # 纯规则基线（零模型）
 *   node scripts/m1542-c2.mjs propose         # 真实模型（GLM-5.3 Coding Plan 通道，同 m1541）
 *   node scripts/m1542-c2.mjs score           # 评分（预测落盘后）
 */
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const ROOT = "D:\\PaperTeamData\\M15\\M15_4_2";
const SRC_ARXIV = { "G1-hdmamba": "2609.23061", "G2-brainiac": "2609.23026", "G3-sparkdiff": "2609.23153" };
const REPO = "D:\\Projects\\PaperTeam";
const dist = (...p) => "file://D:/Projects/PaperTeam/backend/dist/" + p.join("/");
const { buildCertificateDocument, locateAtom, bindTextAtom, certifyClaim, textScopes } = await import(dist("review", "claimCertificate.js"));
const { locateQuote } = await import(dist("review", "claimAuditText.js"));
const { runCandidateProposer, buildTableAllowlist, resolveProposal, verifyProposal } = await import(dist("review", "candidateProposer.js"));
const { plainLatexText } = await import(dist("review", "latexTable.js"));

async function caseView(familyKey, kase) {
  const edited = kase.editValue !== null && kase.editValue !== undefined;
  const root = edited ? join(ROOT, "materialized", familyKey, kase.caseId) : join(ROOT, "candidates", SRC_ARXIV[familyKey]);
  const files = [];
  const walk = async (d) => {
    for (const n of await readdir(d, { withFileTypes: true })) {
      if (n.isDirectory()) await walk(join(d, n.name));
      else if (n.name.endsWith(".tex")) files.push({ abs: join(d, n.name), rel: join(d, n.name).slice(root.length + 1).replaceAll("\\", "/") });
    }
  };
  await walk(root);
  files.sort((a, b) => (a.rel < b.rel ? -1 : 1));
  const loaded = await Promise.all(files.map(async (f) => ({ path: f.rel, content: await readFile(f.abs, "utf8") })));
  const content = loaded.find((f) => f.path === kase.file).content;
  const quote = edited ? kase.claimQuote.replace(kase.originalValue, kase.editValue) : kase.claimQuote;
  const span = locateQuote(content, quote);
  if (span === null) throw new Error(`${kase.caseId}: quote not locatable`);
  return { files: loaded, content, span, claimValue: kase.editValue ?? kase.targetValue };
}

const cellKey = (c) => `${c.file}|${c.tableId}|${c.row}|${c.col}`;
const bindingGrade = (bound, goldCells) => {
  if (bound === null || bound === undefined) return "abstain";
  const keys = goldCells.map(cellKey);
  if (keys.includes(cellKey(bound))) return "exact";
  if (goldCells.some((g) => g.tableId === bound.tableId)) return "partial";
  return "wrong";
};

const cmd = process.argv[2];

if (cmd === "baseline") {
  for (const familyKey of Object.keys(SRC_ARXIV)) {
    const corpus = JSON.parse(await readFile(join(ROOT, "corpus", `${familyKey}-cases.json`), "utf8"));
    const out = [];
    for (const kase of corpus.cases) {
      const view = await caseView(familyKey, kase);
      const document = buildCertificateDocument(view.files.map((f) => ({ file: f.path, content: f.content })));
      const located = locateAtom(document, kase.file, view.span.start, view.span.end, view.claimValue);
      if (located.atom === null) { out.push({ caseId: kase.caseId, status: "NOT_INJECTABLE", reason: located.reason }); continue; }
      const binding = bindTextAtom(document, located.atom);
      let counterpart = null;
      if (kase.goldCells.length > 0) {
        const gold = kase.goldCells[0];
        const table = document.files.find((f) => f.file === gold.file)?.tables.find((t) => t.tableId === gold.tableId);
        const cell = table?.cells.find((c) => c.row === gold.row && c.col === gold.col);
        if (cell !== undefined && cell.value !== null) counterpart = { file: gold.file, start: cell.valueStart, end: cell.valueEnd, value: cell.value.raw };
      }
      const check = kase.expectedRelation === "SUPPORTED" ? "CONSISTENT" : kase.expectedRelation === "CONTRADICTED" ? "INCONSISTENT" : "CONSISTENT";
      const cert = certifyClaim(document, { claim: { file: kase.file, start: view.span.start, end: view.span.end, value: view.claimValue }, counterpart, check: counterpart === null ? null : check });
      out.push({ caseId: kase.caseId, status: cert.outcome === "NOT_CERTIFIED" ? "ABSTAIN" : cert.outcome, l1: bindingGrade(binding.status === "UNIQUE" ? binding.bound : null, kase.goldCells), reasons: cert.reasons.slice(0, 5) });
    }
    await mkdir(join(ROOT, "runs-c2", "baseline"), { recursive: true });
    await writeFile(join(ROOT, "runs-c2", "baseline", `${familyKey}.json`), JSON.stringify({ familyKey, results: out }, null, 2), "utf8");
    console.log(`baseline ${familyKey}: ${out.map((r) => `${r.caseId}=${r.status}/${r.l1 ?? "-"}`).join(" ")}`);
  }
} else if (cmd === "propose") {
  const { createLiveEvaluationRuntime } = await import(dist("evaluation", "liveRuntime.js"));
  process.env["PAPERTEAM_PI_MODEL"] ??= "zai-coding-cn/glm-5.3";
  const handle = await createLiveEvaluationRuntime({ log: (m) => console.log(m) });
  console.log(`model=${handle.modelSpec}`);
  let calls = 0;
  const maxCalls = 40;
  try {
    for (const familyKey of Object.keys(SRC_ARXIV)) {
      const corpus = JSON.parse(await readFile(join(ROOT, "corpus", `${familyKey}-cases.json`), "utf8"));
      await mkdir(join(ROOT, "runs-c2", "propose"), { recursive: true });
      for (const kase of corpus.cases) {
        const outPath = join(ROOT, "runs-c2", "propose", `${kase.caseId}.json`);
        try {
          const existing = JSON.parse(await readFile(outPath, "utf8"));
          if (existing.model !== undefined && existing.model !== "") { console.log(`${kase.caseId}: skip (done)`); continue; }
        } catch { /* 未跑 */ }
        if (calls >= maxCalls) { console.log(`BUDGET ${calls}/${maxCalls} 停止`); break; }
        const view = await caseView(familyKey, kase);
        const document = buildCertificateDocument(view.files.map((f) => ({ file: f.path, content: f.content })));
        const scopes = textScopes(view.content, view.span.start, view.span.end);
        const plainAround = plainLatexText(view.content).replace(/\s+/g, " ");
        const sentencePlain = plainLatexText(scopes.sentence).replace(/\s+/g, " ").trim();
        const at = plainAround.indexOf(sentencePlain.slice(0, 40));
        const contextBefore = at > 0 ? plainAround.slice(Math.max(0, at - 300), at).trim() : "";
        const contextAfter = at >= 0 ? plainAround.slice(at + sentencePlain.length, at + sentencePlain.length + 300).trim() : "";
        const claim = {
          claimId: kase.caseId, file: kase.file,
          claimSentence: sentencePlain, contextBefore: contextBefore.slice(-280), contextAfter: contextAfter.slice(0, 280),
          claimValue: view.claimValue, start: view.span.start, end: view.span.end,
        };
        const started = Date.now();
        const rawTexts = [];
        const result = await runCandidateProposer(document, claim, async (prompt) => {
          calls += 1;
          const task = await handle.runtime.runAgent({
            agentId: "reviewer", task: prompt, projectId: "m1542-c2",
            contextScope: "review/candidate-proposer", sessionKey: `m1542-${kase.caseId}`, timeoutMs: 300_000,
          });
          if (task.status !== "completed") throw new Error(`model call ${task.status}: ${task.errorCode ?? ""} ${task.error ?? ""}`);
          rawTexts.push(task.output ?? "");
          return {
            text: task.output ?? "",
            ...(task.usage !== undefined ? { usage: { inputTokens: task.usage.inputTokens, outputTokens: task.usage.outputTokens } } : {}),
            model: handle.modelSpec,
          };
        });
        const record = { ...result, rawTexts, family: familyKey, durationMs: Date.now() - started, savedAt: new Date().toISOString() };
        await writeFile(outPath, JSON.stringify(record, null, 2), "utf8");
        const v = record.verification;
        console.log(`${kase.caseId}: ${v === null ? `PARSE_FAIL(${result.parseError})` : v.status === "ACCEPTED" ? `${v.outcome}@${v.cell.tableId.slice(0, 8)}:${v.cell.row},${v.cell.col}` : `ABSTAIN/${v.category}`} (${((record.durationMs) / 1000).toFixed(0)}s, calls=${calls})`);
      }
    }
  } finally {
    await handle.close();
    console.log(`total model calls: ${calls}`);
  }
} else if (cmd === "score") {
  const report = { families: [], cost: { calls: 0, input: 0, output: 0 } };
  for (const familyKey of Object.keys(SRC_ARXIV)) {
    const corpus = JSON.parse(await readFile(join(ROOT, "corpus", `${familyKey}-cases.json`), "utf8"));
    let baseline;
    try { baseline = new Map(JSON.parse(await readFile(join(ROOT, "runs-c2", "baseline", `${familyKey}.json`), "utf8")).results.map((r) => [r.caseId, r])); } catch { baseline = new Map(); }
    const rows = [];
    for (const kase of corpus.cases) {
      let record = null;
      try { record = JSON.parse(await readFile(join(ROOT, "runs-c2", "propose", `${kase.caseId}.json`), "utf8")); } catch { /* 未跑 */ }
      const base = baseline.get(kase.caseId) ?? { status: "NOT_RUN" };
      let modelRow = { status: "NOT_RUN" };
      if (record !== null) {
        if (record.usage !== undefined) { report.cost.calls += 1; report.cost.input += record.usage.inputTokens ?? 0; report.cost.output += record.usage.outputTokens ?? 0; }
        if (record.raw === null) modelRow = { status: "ABSTAIN", category: "PROPOSAL_SCHEMA_INVALID", l1: "abstain" };
        else {
          const view = await caseView(familyKey, kase);
          const document = buildCertificateDocument(view.files.map((f) => ({ file: f.path, content: f.content })));
          const allowlist = buildTableAllowlist(document);
          const resolved = resolveProposal(document, record.raw, allowlist);
          const verification = verifyProposal({ document, claim: { file: kase.file, start: view.span.start, end: view.span.end, value: view.claimValue }, resolved });
          const valid = resolved.candidates.filter((c) => c.status === "RESOLVED" && c.cell !== undefined);
          const l1 = bindingGrade(valid[0]?.cell, kase.goldCells);
          if (verification.status === "ACCEPTED") {
            const wrong = (!kase.expectedCertifiable && kase.expectedRelation === "ABSTAIN_ONLY") || (kase.expectedCertifiable && kase.expectedRelation !== verification.outcome);
            modelRow = {
              status: wrong ? "WRONG_STRONG" : "CORRECT_STRONG", outcome: verification.outcome, l1,
              witness: verification.witness.anaphora ? { kind: verification.witness.anaphora.kind, subject: verification.witness.anaphora.effectiveSubject } : null,
              valueCorroborated: verification.witness.uniqueness.valueCorroborated, multiBinding: verification.witness.uniqueness.multiBinding,
              quotes: verification.witness.quotes.map((q) => q.verdict),
            };
          } else modelRow = { status: "ABSTAIN", category: verification.category, detail: `${verification.reason}: ${verification.detail}`.slice(0, 170), l1 };
        }
      }
      let baseRow = { status: base.status, l1: base.l1 ?? "n/a" };
      if (base.status === "SUPPORTED" || base.status === "CONTRADICTED") {
        const wrong = (!kase.expectedCertifiable && kase.expectedRelation === "ABSTAIN_ONLY") || (kase.expectedCertifiable && kase.expectedRelation !== base.status);
        baseRow = { ...baseRow, status: wrong ? "WRONG_STRONG" : "CORRECT_STRONG", outcome: base.status };
      }
      rows.push({ caseId: kase.caseId, kind: kase.kind, expected: kase.expectedRelation, certifiable: kase.expectedCertifiable, model: modelRow, baseline: baseRow });
    }
    report.families.push({ familyKey, rows });
    for (const r of rows) console.log(`  ${r.caseId} [${r.kind}] exp=${r.expected} | model=${r.model.status}${r.model.category ? "/" + r.model.category : ""}${r.model.outcome ? "/" + r.model.outcome : ""} l1=${r.model.l1 ?? "?"} | base=${r.baseline.status}/${r.baseline.l1 ?? "-"}`);
  }
  await writeFile(join(ROOT, "runs-c2", `score-${Date.now()}.json`), JSON.stringify(report, null, 2), "utf8");
  const tot = { m: {}, b: {} };
  for (const f of report.families) for (const r of f.rows) { tot.m[r.model.status] = (tot.m[r.model.status] ?? 0) + 1; tot.b[r.baseline.status] = (tot.b[r.baseline.status] ?? 0) + 1; }
  console.log(`\nMODEL: ${JSON.stringify(tot.m)}\nBASELINE: ${JSON.stringify(tot.b)}\nCOST: ${JSON.stringify(report.cost)}`);
} else {
  console.log("usage: baseline|propose|score");
}
