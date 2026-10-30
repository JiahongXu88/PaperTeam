#!/usr/bin/env node
/**
 * M15.14 Phase E5 — 零模型守卫审计（G3 门输入）：
 *   1) A2 工件 guards 聚合（锚失败/四态规则违规/时间违规/未解析引用）；
 *   2) A2/A0 模型引用的 pool 外先前工作清单 → OpenAlex 存在性核验（确定性检索，
 *      零模型；匹配不到 = unverified_citation，不自动定 fabricated）；
 *   3) A2 高风险结论（POTENTIAL_OVERLAP/SUPPORTED_DIFFERENCE）双锚率
 *      （稿件引文锚 ∩ 可解析 pool 先前工作）；
 *   4) "无先前工作"断言守卫：statusRuleViolations 应为 0（服务层已强制）。
 * 产物 phase-e/audit-guards.json。
 * 用法：node scripts/m1514/audit-guards.mjs
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.M1514_ROOT ? resolve(process.env.M1514_ROOT) : resolve("D:\\PaperTeamData\\M15\\M15_14");
const REPO = resolve(here, "..", "..");
const dist = (...p) => join(REPO, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;
const { rebuildAbstract } = await import(distUrl("citation", "scholarly.js"));

const titleFp = (t) => String(t ?? "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
const REQUEST_INTERVAL_MS = 1100;
let lastRequestAt = 0;

/** 存在性核验链：Crossref（稳定）→ S2 → OpenAlex（预算窗口外常 429） */
async function providerTitleProbe(title) {
  const attempts = [
    {
      name: "crossref",
      url: (() => { const u = new URL("https://api.crossref.org/works"); u.searchParams.set("query.bibliographic", title.slice(0, 200)); u.searchParams.set("rows", "3"); u.searchParams.set("select", "DOI,title,issued"); return u; })(),
      parse: (body) => (body?.message?.items ?? []).map((i) => ({ title: Array.isArray(i.title) ? i.title[0] : undefined, year: i.issued?.["date-parts"]?.[0]?.[0] })),
    },
    {
      name: "s2",
      url: (() => { const u = new URL("https://api.semanticscholar.org/graph/v1/paper/search"); u.searchParams.set("query", title.slice(0, 200)); u.searchParams.set("fields", "title,year"); u.searchParams.set("limit", "3"); return u; })(),
      parse: (body) => (body?.data ?? []).map((p) => ({ title: p.title, year: p.year })),
    },
    {
      name: "openalex",
      url: (() => { const u = new URL("https://api.openalex.org/works"); u.searchParams.set("filter", `title.search:${title}`); u.searchParams.set("per-page", "3"); u.searchParams.set("select", "id,doi,title,publication_year"); return u; })(),
      parse: (body) => (body?.results ?? []).map((w) => ({ title: w.title, year: w.publication_year })),
    },
  ];
  const notes = [];
  for (const attempt of attempts) {
    const wait = REQUEST_INTERVAL_MS - (Date.now() - lastRequestAt);
    if (wait > 0) await new Promise((r) => setTimeout(r, wait));
    lastRequestAt = Date.now();
    try {
      const response = await fetch(attempt.url, { headers: { "User-Agent": "PaperTeam-M15114-audit" }, signal: AbortSignal.timeout(20_000) });
      if (!response.ok) { notes.push(`${attempt.name}:${response.status}`); continue; }
      const body = await response.json();
      return { ok: true, results: attempt.parse(body).filter((r) => r.title !== undefined), via: attempt.name, notes };
    } catch (error) {
      notes.push(`${attempt.name}:error`);
    }
  }
  return { ok: false, results: [], via: null, notes };
}

const projectsInfo = JSON.parse(await readFile(join(ROOT, "phase-c", "projects.json"), "utf8"));
const formalFams = projectsInfo.families.filter((f) => f.role === "PRIMARY").map((f) => f.familyId);

const guardTotals = { anchorFailures: 0, statusRuleViolations: 0, cutoffViolations: 0, unresolvedPriorWorkRefs: 0, droppedFindings: 0 };
const highRisk = { total: 0, dualAnchored: 0 };
const outsidePoolRefs = []; // {familyId, arm, title, year, doi, arxivId, loadBearing}
const perFamily = [];

for (const famId of formalFams) {
  const a2Path = join(ROOT, "phase-d", "out", famId, "a2.json");
  const a0Path = join(ROOT, "phase-d", "out", famId, "a0.json");
  const poolPath = join(ROOT, "phase-c", "pools", `${famId}.json`);
  const famReport = { familyId: famId, a2: null, a0: null };
  if (existsSync(a2Path)) {
    const data = JSON.parse(await readFile(a2Path, "utf8"));
    const artifact = data.artifact;
    const g = artifact.guards;
    for (const k of Object.keys(guardTotals)) guardTotals[k] += g[k] ?? 0;
    for (const c of artifact.comparisons) {
      if (c.status === "POTENTIAL_OVERLAP" || c.status === "SUPPORTED_DIFFERENCE") {
        highRisk.total += 1;
        const unit = artifact.inventory.find((u) => u.contributionId === c.contributionId);
        const hasPoolPrior = c.nearestPriorWorks.some((r) => r.resolvesToPool && r.timeCausalityViolation !== true);
        if (unit?.anchorVerified === true && hasPoolPrior) highRisk.dualAnchored += 1;
      }
      for (const r of c.nearestPriorWorks) {
        if (!r.resolvesToPool) {
          outsidePoolRefs.push({ familyId: famId, arm: "a2", title: r.title, year: r.year, doi: r.doi, arxivId: r.arxivId, sourceLevel: r.sourceLevel, contributionId: c.contributionId, comparisonStatus: c.status });
        }
      }
    }
    famReport.a2 = { guards: g, contributions: artifact.inventory.length, comparisons: artifact.comparisons.length, coverage: artifact.coverage };
  }
  if (existsSync(a0Path) && existsSync(poolPath)) {
    const data = JSON.parse(await readFile(a0Path, "utf8"));
    const pool = JSON.parse(await readFile(poolPath, "utf8"));
    const poolFps = new Set(pool.candidates.map((c) => titleFp(c.title)));
    let outside = 0;
    for (const comp of Array.isArray(data.comparisons) ? data.comparisons : []) {
      for (const ref of Array.isArray(comp.nearestPriorWorks) ? comp.nearestPriorWorks : []) {
        if (!poolFps.has(titleFp(ref.title))) {
          outside += 1;
          outsidePoolRefs.push({ familyId: famId, arm: "a0", title: ref.title, year: ref.year, doi: ref.doi, arxivId: ref.arxivId, sourceLevel: ref.sourceLevel });
        }
      }
    }
    famReport.a0 = { comparisons: Array.isArray(data.comparisons) ? data.comparisons.length : 0, outsidePoolRefs: outside };
  }
  perFamily.push(famReport);
}

// ---- pool 外引用存在性核验（确定性 OpenAlex 检索；同题去重减少查询量） ----
const verified = [];
const unverified = [];
const seenTitles = new Map();
for (const ref of outsidePoolRefs) {
  const fp = titleFp(ref.title);
  if (fp === "") continue;
  if (seenTitles.has(fp)) {
    const prior = seenTitles.get(fp);
    (prior.exists ? verified : unverified).push(ref);
    continue;
  }
  const result = await providerTitleProbe(ref.title.slice(0, 200));
  let exists = null;
  let matchedTitle = null;
  if (result.ok) {
    const match = result.results.find((w) => {
      const wfp = titleFp(w.title);
      return wfp === fp || (wfp.length > 12 && (wfp.includes(fp) || fp.includes(wfp)));
    });
    if (match !== undefined) {
      exists = true;
      matchedTitle = match.title;
    } else if (result.results.length > 0) {
      exists = false; // 有检索结果但题名无匹配——不足以断言存在
    } else {
      exists = false;
    }
  }
  const record = { ...ref, providerExists: exists, matchedTitle, checkedVia: result.via, checkStatus: result.ok ? "ok" : `failed:${(result.notes ?? []).join(",")}` };
  seenTitles.set(fp, { exists: exists === true });
  (exists === true ? verified : unverified).push(record);
}

const dualAnchorRatio = highRisk.total > 0 ? highRisk.dualAnchored / highRisk.total : null;
const gates = {
  fabricatedCitationsRule: {
    // 经确定性核验：pool 外引用若 OpenAlex 检索无任何题名匹配 → 未经证实（investigator
    // 复核后若确认不存在才算 fabricated——本脚本只做确定性初筛，不自动定罪）
    verifiedOutsidePool: verified.length,
    unverifiedOutsidePool: unverified.filter((u) => u.checkStatus === "ok").length,
    checkFailed: unverified.filter((u) => u.checkStatus !== "ok").length,
    byArm: { a2: outsidePoolRefs.filter((r) => r.arm === "a2").length, a0: outsidePoolRefs.filter((r) => r.arm === "a0").length },
    verdict: "NEEDS_INVESTIGATOR_REVIEW",
    note: "unverified ≠ fabricated：网络/匹配局限。investigator 抽查后回填 verifiedFabricated 数。",
  },
  dualAnchor: { total: highRisk.total, dualAnchored: highRisk.dualAnchored, ratio: dualAnchorRatio, pass: dualAnchorRatio !== null && dualAnchorRatio >= 0.7 },
  statusRuleViolationsTotal: guardTotals.statusRuleViolations,
  cutoffViolationsTotal: guardTotals.cutoffViolations,
  anchorFailuresTotal: guardTotals.anchorFailures,
};

const out = {
  generatedAt: new Date().toISOString(),
  families: formalFams,
  guardTotals,
  highRisk,
  perFamily,
  outsidePoolRefs: { total: outsidePoolRefs.length, verified, unverified },
  gates,
};
await mkdir(join(ROOT, "phase-e"), { recursive: true });
await writeFile(join(ROOT, "phase-e", "audit-guards.json"), JSON.stringify(out, null, 1), "utf8");
console.log(JSON.stringify({
  families: formalFams.length,
  guardTotals,
  highRisk,
  dualAnchorRatio,
  outsidePool: { total: outsidePoolRefs.length, verified: verified.length, unverified: unverified.length },
  gates: { dualAnchor: gates.dualAnchor.pass, statusRuleViolations: guardTotals.statusRuleViolations },
}, null, 1));
