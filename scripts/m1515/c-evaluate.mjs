#!/usr/bin/env node
/**
 * M15.15 C — 机械评估器（oracle 对照中可程序化的部分；人工语义判定另录 review-notes）。
 * 指标（预注册）：
 *   - targetEngaged：比较是否点名目标先前工作（P01）而非仅干扰项
 *   - statusSet：对目标的 status
 *   - basisFulltext：differenceBasis=fulltext 的目标比较数
 *   - priorQuoteReplay：目标比较的 quote 是否在其 pool 材料（P0=摘要；P1/P2=摘要+摘录）内回放
 *   - claimQuoteReplay：稿件 claimQuote 是否在稿件文本内回放
 *   - oracleKeywordCoverage：oracle 差异关键词（每族固定列表）在 substantiveDifference 中的命中比例
 *   - cost：调用数/tokens/ms（读 model-calls.jsonl + 臂文件）
 * 输出 phase-c/eval/mechanical.json + 控制台摘要。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..", "..");
const ROOT = "D:\\PaperTeamData\\M15\\M15_15\\phase-c";
const dist = (...p) => join(REPO, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;
const { verifyQuoteInChunk } = await import(distUrl("evidence", "quoteVerification.js"));

const familiesFile = JSON.parse(await readFile(join(ROOT, "families", "families.json"), "utf8"));

// oracle 差异关键词（ORACLE_PREREGISTRATION.md 差异事实的确定性锚词；评估前冻结）
const ORACLE_KEYWORDS = {
  F1: ["low", "confidence", "two", "association", "second", "high"],
  F2: ["observation", "re-update", "recovery", "confidence", "kalman", "error"],
  F3: ["appearance", "embedding", "re-identification", "motion", "without", "cascade"],
  F4: ["tracking querie", "propagat", "identity", "object querie", "end-to-end", "embedding"],
  F5: ["fusion", "semantic", "hierarch", "binariz", "segmentation", "multi-scale"],
  F6: ["detection", "association", "geometric", "identity", "f1", "det"],
  F7: ["regression", "query", "propagat", "roi", "transformer", "autoregressive"],
};

const callLog = [];
try {
  const logText = await readFile(join(ROOT, "model-calls.jsonl"), "utf8");
  for (const line of logText.split("\n")) {
    if (line.trim() !== "") callLog.push(JSON.parse(line));
  }
} catch {}

const stripWs = (t) => String(t ?? "").replace(/\s+/g, "");
const replay = (quote, material) => {
  if (!quote) return null;
  if (verifyQuoteInChunk(quote, material).ok) return true;
  if (/[㐀-鿿　-〿]/.test(quote) && verifyQuoteInChunk(stripWs(quote), stripWs(material)).ok) return true;
  return false;
};

const rows = [];
for (const family of familiesFile.families) {
  const famDir = join(ROOT, "out", family.familyId);
  const oracleKeywords = ORACLE_KEYWORDS[family.familyId] ?? [];
  const manuscriptText = await readFile(join(ROOT, "projects-root", (await readFile(join(famDir, "project-id.txt"), "utf8")).trim(), "paper", "parsed", "chunks.jsonl"), "utf8")
    .then((t) => t.split("\n").filter((l) => l.trim() !== "").map((l) => JSON.parse(l).text).join("\n\n"));
  const priorMaterialP0 = family.priorAbstract ?? "";
  const priorMaterialP1 = [family.priorAbstract ?? "", ...(family.priorExcerpts ?? [])].join("\n\n");
  for (const arm of ["p0", "p1"]) {
    let armFile;
    try { armFile = JSON.parse(await readFile(join(famDir, `${arm}.json`), "utf8")); } catch { rows.push({ family: family.familyId, arm, present: false }); continue; }
    const parsed = armFile.parsed;
    const targetComparisons = (parsed?.comparisons ?? []).filter((c) =>
      (c.nearestPriorWorks ?? []).some((p) => p.candidateId === "P01" || String(p.title ?? "").toLowerCase().includes("realtime") || String(p.title ?? "").toLowerCase().includes("real-time") || String(p.title ?? "").toLowerCase().includes("bells and whistles") || String(p.title ?? "").toLowerCase().includes("transformers") || String(p.title ?? "").toLowerCase().includes("online multiple object tracking benchmark")),
    );
    const perTarget = targetComparisons.map((c) => {
      const diffText = String(c.substantiveDifference ?? "");
      const coverage = oracleKeywords.filter((k) => diffText.toLowerCase().includes(k)).length / Math.max(1, oracleKeywords.length);
      return {
        status: c.status ?? null,
        basis: c.differenceBasis ?? null,
        quote: c.quote ?? null,
        priorQuoteReplay: replay(c.quote, arm === "p0" ? priorMaterialP0 : priorMaterialP1),
        oracleKeywordCoverage: Number(coverage.toFixed(2)),
      };
    });
    const claimQuotes = (parsed?.contributions ?? []).map((c) => c.claimQuote);
    rows.push({
      family: family.familyId, arm, present: true,
      parseOk: parsed !== undefined,
      nComparisons: (parsed?.comparisons ?? []).length,
      engagedTarget: targetComparisons.length > 0,
      targets: perTarget,
      claimQuoteReplay: claimQuotes.map((q) => replay(q, manuscriptText)),
      ms: armFile.ms ?? null,
    });
  }
  // P2：从 artifact 提取
  let p2File;
  try { p2File = JSON.parse(await readFile(join(famDir, "p2.json"), "utf8")); } catch { rows.push({ family: family.familyId, arm: "p2", present: false }); continue; }
  const artifact = p2File.artifact;
  const p2TargetComparisons = (artifact?.comparisons ?? []).filter((c) =>
    (c.nearestPriorWorks ?? []).some((p) => p.candidateId === "P01"),
  );
  const p2PerTarget = p2TargetComparisons.map((c) => {
    const diffText = String(c.substantiveDifference ?? "");
    const coverage = oracleKeywords.filter((k) => diffText.toLowerCase().includes(k)).length / Math.max(1, oracleKeywords.length);
    const priorRef = (c.nearestPriorWorks ?? []).find((p) => p.candidateId === "P01");
    return {
      status: c.status ?? null,
      basis: c.differenceBasis ?? null,
      sourceLevel: priorRef?.sourceLevel ?? null,
      quote: priorRef?.quote ?? null,
      priorQuoteVerified: priorRef?.priorQuoteVerified ?? (priorRef?.quote === undefined ? null : false),
      oracleKeywordCoverage: Number(coverage.toFixed(2)),
    };
  });
  rows.push({
    family: family.familyId, arm: "p2", present: true,
    guards: artifact?.guards ?? null,
    engagedTarget: p2TargetComparisons.length > 0,
    targets: p2PerTarget,
    claimQuoteAnchorVerified: (artifact?.contributions ?? []).map((c) => c.anchorVerified),
    ms: p2File.ms ?? null,
    telemetry: p2File.telemetry ?? null,
  });
}

// 成本汇总
const byArm = {};
for (const call of callLog) {
  const arm = call.arm ?? "?";
  byArm[arm] ??= { calls: 0, ms: 0, promptTokens: 0, completionTokens: 0 };
  byArm[arm].calls += 1;
  byArm[arm].ms += call.ms ?? 0;
  const usage = call.usage ?? {};
  byArm[arm].promptTokens += usage.promptTokens ?? usage.input_tokens ?? 0;
  byArm[arm].completionTokens += usage.completionTokens ?? usage.output_tokens ?? 0;
}

const report = { generatedAt: new Date().toISOString(), rows, costByArm: byArm };
await mkdir(join(ROOT, "eval"), { recursive: true });
await writeFile(join(ROOT, "eval", "mechanical.json"), JSON.stringify(report, null, 2), "utf8");

// 控制台摘要
for (const arm of ["p0", "p1", "p2"]) {
  const armRows = rows.filter((r) => r.arm === arm && r.present);
  const engaged = armRows.filter((r) => r.engagedTarget);
  const decided = armRows.filter((r) => (r.targets ?? []).some((t) => t.status === "SUPPORTED_DIFFERENCE" || t.status === "POTENTIAL_OVERLAP"));
  const fulltextBasis = armRows.filter((r) => (r.targets ?? []).some((t) => t.basis === "fulltext"));
  const replayOk = armRows.filter((r) => (r.targets ?? []).some((t) => t.priorQuoteReplay === true || t.priorQuoteVerified === true));
  console.log(`[${arm}] families=${armRows.length} engagedTarget=${engaged.length} decided=${decided.length} fulltextBasis=${fulltextBasis.length} priorQuoteReplayOk=${replayOk.length}`);
}
console.log("[cost]", JSON.stringify(byArm));
console.log("[done] ->", join(ROOT, "eval", "mechanical.json"));
