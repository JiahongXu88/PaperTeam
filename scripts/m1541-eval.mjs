#!/usr/bin/env node
/**
 * M15.4.1 评测 harness：baseline（规则基线，零模型，历史 replay 语义）/ propose（真实模型提案臂）/
 * score（分层评分：L1 绑定准确率 + L2 认证漏斗）。数据与原始响应全部在 D:\PaperTeamData\M15\M15_4_1\。
 *
 * 用法：
 *   node scripts/m1541-eval.mjs baseline <familyKey...>
 *   node scripts/m1541-eval.mjs propose <familyKey...>      # 真实模型；逐案例独立 session；断点续跑
 *   node scripts/m1541-eval.mjs score <familyKey...>
 */
import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

const ROOT = "D:\\PaperTeamData\\M15\\M15_4_1";
const REPO = "D:\\Projects\\PaperTeam";
const dist = (...p) => `file://${join(REPO, "backend", "dist", ...p).replaceAll("\\", "/")}`;
const { buildCertificateDocument, locateAtom, bindTextAtom, certifyClaim, textScopes } = await import(dist("review", "claimCertificate.js"));
const { locateQuote } = await import(dist("review", "claimAuditText.js"));
const { runCandidateProposer } = await import(dist("review", "candidateProposer.js"));
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
  const dir = join(ROOT, "candidates", FAMILIES[familyKey].arxiv);
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

/** 每案例独立视图：编辑案例读 materialized/<family>/<caseId>/，未编辑读 candidates/ */
async function caseView(familyKey, kase) {
  const edited = kase.editValue !== null && kase.editValue !== undefined;
  if (!edited) {
    const files = await familyFiles(familyKey);
    const content = files.find((f) => f.path === kase.file).content;
    const span = locateQuote(content, kase.claimQuote);
    if (span === null) throw new Error(`${kase.caseId}: quote not locatable`);
    return { files, content, span, effectiveQuote: kase.claimQuote, claimValue: kase.targetValue };
  }
  const files = [];
  const dir = join(ROOT, "materialized", familyKey, kase.caseId);
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
  return { files: loaded, content, span, effectiveQuote, claimValue: kase.editValue };
}

const cellKey = (c) => `${c.file}|${c.tableId}|${c.row}|${c.col}`;

/** L1 绑定判定：exact（命中任一 gold）/ partial（同表异格）/ wrong / abstain */
function bindingGrade(bound, goldCells) {
  if (bound === null || bound === undefined) return "abstain";
  const keys = goldCells.map(cellKey);
  if (keys.includes(cellKey(bound))) return "exact";
  if (goldCells.some((g) => g.tableId === bound.tableId)) return "partial";
  return "wrong";
}

// ---- baseline：零模型，历史 replay 语义（oracle 对照 + 规则绑定独立复现 + B2/B3 + 双钥匙） ----

async function runBaseline(familyKey) {
  const corpus = JSON.parse(await readFile(join(ROOT, "corpus", `${familyKey}-cases.json`), "utf8"));
  const out = [];
  for (const kase of corpus.cases) {
    const view = await caseView(familyKey, kase);
    const document = buildCertificateDocument(view.files.map((f) => ({ file: f.path, content: f.content })));
    const located = locateAtom(document, kase.file, view.span.start, view.span.end, view.claimValue);
    if (located.atom === null) {
      out.push({ caseId: kase.caseId, arm: "baseline", status: "NOT_INJECTABLE", reason: located.reason });
      continue;
    }
    const binding = bindTextAtom(document, located.atom);
    // 对照 = oracle 金格（生产中由 Reviewer 模型提案；历史 harness 以 oracle 提案为替身）
    let counterpart = null;
    if (kase.goldCells.length > 0) {
      const gold = kase.goldCells[0];
      const table = document.files.find((f) => f.file === gold.file)?.tables.find((t) => t.tableId === gold.tableId);
      const cell = table?.cells.find((c) => c.row === gold.row && c.col === gold.col);
      if (cell !== undefined && cell.value !== null) {
        counterpart = { file: gold.file, start: cell.valueStart, end: cell.valueEnd, value: cell.value.raw };
      }
    }
    const check = kase.expectedRelation === "SUPPORTED" ? "CONSISTENT" : kase.expectedRelation === "CONTRADICTED" ? "INCONSISTENT" : "CONSISTENT";
    const certificate = certifyClaim(document, {
      claim: { file: kase.file, start: view.span.start, end: view.span.end, value: view.claimValue },
      counterpart,
      check: counterpart === null ? null : check,
    });
    out.push({
      caseId: kase.caseId, arm: "baseline",
      l1: bindingGrade(binding.status === "UNIQUE" ? binding.bound : null, kase.goldCells),
      l1BindingStatus: binding.status, l1BindingRule: binding.rule,
      outcome: certificate.outcome,
      status: certificate.outcome === "NOT_CERTIFIED" ? "ABSTAIN" : certificate.outcome,
      reasons: certificate.reasons.slice(0, 6),
      comparisonType: certificate.comparisonType,
    });
  }
  const outDir = join(ROOT, "runs", "baseline");
  await mkdir(outDir, { recursive: true });
  await writeFile(join(outDir, `${familyKey}.json`), JSON.stringify({ familyKey, results: out }, null, 2), "utf8");
  console.log(`baseline ${familyKey}: ${out.map((r) => `${r.caseId}=${r.status}${r.l1 ? "/" + r.l1 : ""}`).join(" ")}`);
}

// ---- propose：真实模型提案臂（并发 1 ≤ 2；每案例独立 session；断点续跑） ----

async function runPropose(familyKeys) {
  const { createLiveEvaluationRuntime } = await import(dist("evaluation", "liveRuntime.js"));
  process.env["PAPERTEAM_PI_MODEL"] ??= "zai-coding-cn/glm-5.3";
  const handle = await createLiveEvaluationRuntime({ log: (m) => console.log(m) });
  console.log(`model=${handle.modelSpec} (source=${handle.specSource})`);
  let calls = 0;
  const maxCalls = Number(process.env["M1541_MAX_CALLS"] ?? 80);
  try {
    for (const familyKey of familyKeys) {
      const corpus = JSON.parse(await readFile(join(ROOT, "corpus", `${familyKey}-cases.json`), "utf8"));
      const outDir = join(ROOT, "runs", "propose");
      await mkdir(outDir, { recursive: true });
      for (const kase of corpus.cases) {
        if (process.env["M1541_ONLY"] !== undefined && !process.env["M1541_ONLY"].split(",").includes(kase.caseId)) continue;
        const outPath = join(outDir, `${kase.caseId}.json`);
        try {
          const existing = JSON.parse(await readFile(outPath, "utf8"));
          if (existing.model !== undefined && existing.model !== "") { console.log(`${kase.caseId}: skip (done)`); continue; }
        } catch { /* 未跑过 */ }
        if (calls >= maxCalls) { console.log(`BUDGET: ${calls}/${maxCalls} 已达调用上限，停止`); return; }
        const view = await caseView(familyKey, kase);
        const document = buildCertificateDocument(view.files.map((f) => ({ file: f.path, content: f.content })));
        const scopes = textScopes(view.content, view.span.start, view.span.end);
        const plainAround = plainLatexText(view.content).replace(/\s+/g, " ");
        // 上下文：整句 ± 邻近一段（有界）
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
            agentId: "reviewer", task: prompt, projectId: "m1541-poc",
            contextScope: "review/candidate-proposer", sessionKey: `m1541-${kase.caseId}`, timeoutMs: 300_000,
          });
          if (task.status !== "completed") throw new Error(`model call ${task.status}: ${task.errorCode ?? ""} ${task.error ?? ""}`);
          rawTexts.push(task.output ?? "");
          return {
            text: task.output ?? "",
            ...(task.usage !== undefined ? { usage: { inputTokens: task.usage.inputTokens, outputTokens: task.usage.outputTokens } } : {}),
            model: handle.modelSpec,
          };
        });
        const record = { ...result, rawTexts, family: familyKey, split: FAMILIES[familyKey].split, durationMs: Date.now() - started, savedAt: new Date().toISOString() };
        await writeFile(outPath, JSON.stringify(record, null, 2), "utf8");
        const v = record.verification;
        console.log(`${kase.caseId}: ${v === null ? `PARSE_FAIL(${result.parseError})` : v.status === "ACCEPTED" ? `${v.outcome}@${v.cell.tableId.slice(0, 8)}:${v.cell.row},${v.cell.col}` : `ABSTAIN/${v.category}`} (${((record.durationMs) / 1000).toFixed(0)}s, calls=${calls})`);
      }
    }
  } finally {
    await handle.close();
    console.log(`total model calls: ${calls}`);
  }
}

/** 第三对照（零模型）：模型 top 提案注入现有生产证书器（certifyClaim，counterpart=模型格，check=模型 comparison）
 *  ——最接近生产接线的漏斗视图：区分「实验验证器严格」与「生产证书器下的转化」。 */
async function runModelViaProduction(familyKeys) {
  const outDir = join(ROOT, "runs", "model-via-production");
  await mkdir(outDir, { recursive: true });
  for (const familyKey of familyKeys) {
    const corpus = JSON.parse(await readFile(join(ROOT, "corpus", `${familyKey}-cases.json`), "utf8"));
    const results = [];
    for (const kase of corpus.cases) {
      let record = null;
      try { record = JSON.parse(await readFile(join(ROOT, "runs", "propose", `${kase.caseId}.json`), "utf8")); } catch { results.push({ caseId: kase.caseId, status: "NOT_RUN" }); continue; }
      if (record.raw === null || record.raw === null) { results.push({ caseId: kase.caseId, status: "PARSE_FAIL" }); continue; }
      const view = await caseView(familyKey, kase);
      const document = buildCertificateDocument(view.files.map((f) => ({ file: f.path, content: f.content })));
      const valid = (record.resolved?.candidates ?? []).filter((c) => c.status === "RESOLVED" && c.cell !== undefined && c.value !== undefined);
      if (valid.length === 0 || record.raw.abstain !== undefined) { results.push({ caseId: kase.caseId, status: "ABSTAIN", reason: record.raw.abstain?.reason ?? "no-valid-candidate" }); continue; }
      const top = valid[0];
      // 生产证书器需要 counterpart span：用解析器的 valueStart/valueEnd
      const table = document.files.find((f) => f.file === top.cell.file)?.tables[top.cell.tableIndex];
      const cell = table?.cells.find((c) => c.row === top.cell.row && c.col === top.cell.col && c.value !== null);
      if (cell === undefined) { results.push({ caseId: kase.caseId, status: "ABSTAIN", reason: "counterpart-cell-missing" }); continue; }
      const certificate = certifyClaim(document, {
        claim: { file: kase.file, start: view.span.start, end: view.span.end, value: view.claimValue },
        counterpart: { file: top.cell.file, start: cell.valueStart, end: cell.valueEnd, value: cell.value.raw },
        check: record.raw.comparison === "CONSISTENT" ? "CONSISTENT" : record.raw.comparison === "INCONSISTENT" ? "INCONSISTENT" : null,
      });
      results.push({
        caseId: kase.caseId, status: certificate.outcome === "NOT_CERTIFIED" ? "ABSTAIN" : certificate.outcome,
        l1: bindingGrade(top.cell, kase.goldCells),
        reasons: certificate.reasons.slice(0, 5),
      });
    }
    await writeFile(join(outDir, `${familyKey}.json`), JSON.stringify({ familyKey, results }, null, 2), "utf8");
    console.log(`model-via-production ${familyKey}: ${results.map((r) => `${r.caseId}=${r.status}${r.l1 ? "/" + r.l1 : ""}`).join(" ")}`);
  }
}

// ---- score：分层评分（L1 + L2 + 漏斗 + 成本） ----

async function runScore(familyKeys) {
  const report = { families: [], totals: { model: {}, baseline: {} }, cost: {} };
  const sumTokens = { input: 0, output: 0, unknown: 0 };
  let totalCalls = 0, totalAttempts = 0;
  for (const familyKey of familyKeys) {
    const corpus = JSON.parse(await readFile(join(ROOT, "corpus", `${familyKey}-cases.json`), "utf8"));
    let baseline;
    try {
      baseline = new Map(JSON.parse(await readFile(join(ROOT, "runs", "baseline", `${familyKey}.json`), "utf8")).results.map((r) => [r.caseId, r]));
    } catch { baseline = new Map(); }
    const rows = [];
    for (const kase of corpus.cases) {
      let proposal = null;
      try { proposal = JSON.parse(await readFile(join(ROOT, "runs", "propose", `${kase.caseId}.json`), "utf8")); } catch { /* 未跑 */ }
      const base = baseline.get(kase.caseId) ?? null;
      const goldKeys = kase.goldCells.map(cellKey);
      // ---- 模型臂 ----
      let modelRow;
      if (proposal === null) modelRow = { status: "NOT_RUN" };
      else if (proposal.parseError !== null && proposal.raw === null) modelRow = { status: "ABSTAIN", category: "PROPOSAL_SCHEMA_INVALID", l1: "abstain", detail: proposal.parseError };
      else {
        const valid = (proposal.resolved?.candidates ?? []).filter((c) => c.status === "RESOLVED" && c.cell !== undefined);
        const topCell = valid[0]?.cell;
        const l1 = topCell === undefined ? "abstain" : goldKeys.includes(cellKey(topCell)) ? "exact" : kase.goldCells.some((g) => g.tableId === topCell.tableId) ? "partial" : "wrong";
        const v = proposal.verification;
        if (v === null) modelRow = { status: "ABSTAIN", category: "VERIFICATION_MISSING", l1 };
        else if (v.status === "ACCEPTED") {
          const expected = kase.expectedRelation;
          const correct = expected === v.outcome || (kase.kind === "SCALE-PROBE" && false);
          // 可证分母外的案例（expectedCertifiable=false）强判 = 违规（AMBIG/ABSTAIN_ONLY 不得出证）
          modelRow = {
            status: (!kase.expectedCertifiable && expected === "ABSTAIN_ONLY") || (kase.expectedCertifiable && expected !== v.outcome) ? "WRONG_STRONG" : "CORRECT_STRONG",
            outcome: v.outcome, l1, valueCorroborated: v.grounding.valueCorroborated,
            funnel: l1 === "exact" ? "PROPOSER_CORRECT_CERTIFIED" : "PROPOSER_WRONG_CERTIFIED",
          };
          if (!kase.expectedCertifiable && expected !== "ABSTAIN_ONLY") {
            // SCALE-PROBE 等：表示差出证 = 表示问题上的强判（SCALE_AMBIGUOUS 应拦；若模型 check 一致且 overlap…按实际记录）
            modelRow.status = expected === v.outcome ? "CORRECT_STRONG_UNEXPECTED" : "WRONG_STRONG";
          }
        } else {
          modelRow = {
            status: "ABSTAIN", category: v.category, l1, detail: `${v.reason}: ${v.detail}`.slice(0, 140),
            funnel: l1 === "exact" ? "PROPOSER_CORRECT_BUT_CERTIFIER_ABSTAINS" : l1 === "wrong" || l1 === "partial" ? "PROPOSER_WRONG_REJECTED_BY_GUARD" : "PROPOSER_ABSTAINED",
          };
        }
        if (proposal.usage !== undefined) {
          sumTokens.input += proposal.usage.inputTokens ?? 0;
          sumTokens.output += proposal.usage.outputTokens ?? 0;
          if (proposal.usage.inputTokens === undefined) sumTokens.unknown += 1;
        } else sumTokens.unknown += 1;
        totalCalls += 1;
        totalAttempts += proposal.attempts ?? 1;
      }
      // ---- 基线臂 ----
      let baseRow;
      if (base === null) baseRow = { status: "NOT_RUN" };
      else if (base.status === "NOT_INJECTABLE") baseRow = { status: "NOT_INJECTABLE", l1: "abstain" };
      else {
        const l1 = base.l1;
        if (base.outcome === "NOT_CERTIFIED") {
          baseRow = { status: "ABSTAIN", l1, detail: base.reasons.join(";").slice(0, 120), funnel: l1 === "exact" ? "BINDING_CORRECT_BUT_CERTIFIER_ABSTAINS" : "RULE_ABSTAIN" };
        } else {
          const expected = kase.expectedRelation;
          baseRow = {
            status: (!kase.expectedCertifiable && expected === "ABSTAIN_ONLY") || (kase.expectedCertifiable && expected !== base.outcome) ? "WRONG_STRONG" : "CORRECT_STRONG",
            outcome: base.outcome, l1,
            funnel: l1 === "exact" ? "BINDING_CORRECT_CERTIFIED" : "BINDING_WRONG_CERTIFIED",
          };
          if (!kase.expectedCertifiable && expected !== "ABSTAIN_ONLY") {
            baseRow.status = expected === base.outcome ? "CORRECT_STRONG_UNEXPECTED" : "WRONG_STRONG";
          }
        }
      }
      rows.push({
        caseId: kase.caseId, kind: kase.kind, difficulty: kase.difficulty, certifiable: kase.expectedCertifiable, expected: kase.expectedRelation,
        model: modelRow, baseline: baseRow,
      });
    }
    const counts = (arm) => rows.reduce((acc, r) => { const s = r[arm].status ?? "NOT_RUN"; acc[s] = (acc[s] ?? 0) + 1; return acc; }, {});
    const l1counts = (arm) => rows.reduce((acc, r) => { const l = r[arm].l1 ?? "n/a"; acc[l] = (acc[l] ?? 0) + 1; return acc; }, {});
    report.families.push({ familyKey, split: FAMILIES[familyKey].split, cases: rows.length, modelStatus: counts("model"), modelL1: l1counts("model"), baselineStatus: counts("baseline"), baselineL1: l1counts("baseline"), rows });
  }
  report.cost = { totalCalls, totalAttempts, tokens: sumTokens, billingVisible: sumTokens.unknown === 0 ? "yes" : `partial (${sumTokens.unknown} runs without usage)` };
  await mkdir(join(ROOT, "runs"), { recursive: true });
  const split = FAMILIES[familyKeys[0]].split;
  await writeFile(join(ROOT, "runs", `score-${split}-${Date.now()}.json`), JSON.stringify(report, null, 2), "utf8");
  for (const f of report.families) {
    console.log(`\n=== ${f.familyKey} (${f.split}) n=${f.cases}`);
    console.log(`  model    : status=${JSON.stringify(f.modelStatus)} L1=${JSON.stringify(f.modelL1)}`);
    console.log(`  baseline : status=${JSON.stringify(f.baselineStatus)} L1=${JSON.stringify(f.baselineL1)}`);
    for (const r of f.rows) {
      const m = r.model, b = r.baseline;
      console.log(`  ${r.caseId} [${r.kind}/${r.difficulty}] exp=${r.expected} | model=${m.status}${m.category ? "/" + m.category : ""}${m.outcome ? "/" + m.outcome : ""} l1=${m.l1 ?? "?"} | base=${b.status}${b.outcome ? "/" + b.outcome : ""} l1=${b.l1 ?? "?"}`);
    }
  }
  console.log(`\ncost: ${JSON.stringify(report.cost)}`);
}

/** reverify：用已落盘的 RawProposal 重跑确定性 resolve+verify（验证器迭代不耗模型调用；模型输出不变） */
async function reverify(familyKeys) {
  const { parseProposerResponse, buildTableAllowlist: buildAllowlist, resolveProposal: resolve, verifyProposal: verify } = await import(dist("review", "candidateProposer.js"));
  for (const familyKey of familyKeys) {
    const corpus = JSON.parse(await readFile(join(ROOT, "corpus", `${familyKey}-cases.json`), "utf8"));
    for (const kase of corpus.cases) {
      if (process.env["M1541_ONLY"] !== undefined && !process.env["M1541_ONLY"].split(",").includes(kase.caseId)) continue;
      const outPath = join(ROOT, "runs", "propose", `${kase.caseId}.json`);
      let record;
      try { record = JSON.parse(await readFile(outPath, "utf8")); } catch { continue; }
      if (record.raw === null) continue;
      const view = await caseView(familyKey, kase);
      const document = buildCertificateDocument(view.files.map((f) => ({ file: f.path, content: f.content })));
      const allowlist = buildAllowlist(document);
      const resolved = resolve(document, record.raw, allowlist);
      const verification = verify({ document, claim: { file: kase.file, start: view.span.start, end: view.span.end, value: view.claimValue }, resolved });
      record.resolved = resolved;
      record.verification = verification;
      record.reverifiedAt = new Date().toISOString();
      await writeFile(outPath, JSON.stringify(record, null, 2), "utf8");
      const v = verification;
      console.log(`${kase.caseId}: ${v.status === "ACCEPTED" ? `${v.outcome}@${v.cell.tableId.slice(0, 8)}:${v.cell.row},${v.cell.col}${v.grounding.valueCorroborated ? "(VC)" : ""}` : `ABSTAIN/${v.category}`}`);
    }
  }
}

const [cmd, ...familyKeys] = process.argv.slice(2);
const keys = familyKeys.length > 0 ? familyKeys : Object.keys(FAMILIES);
if (cmd === "baseline") for (const k of keys) await runBaseline(k);
else if (cmd === "propose") await runPropose(keys);
else if (cmd === "reverify") await reverify(keys);
else if (cmd === "score") await runScore(keys);
else if (cmd === "model-via-production") await runModelViaProduction(keys);
else console.log("usage: baseline|propose|reverify|score <familyKey...>");
