#!/usr/bin/env node
/**
 * M15.6 Evidence-Aware Gate Benchmark（2026-10-25）— 零模型重放 + MOT r3 重评。
 *
 * 三路对照（相同存储输入，规则层重放；零模型——不调用任何 LLM）：
 *   ① 生产 Gate v1 语义：evaluateQualityGate（不含 evidencePairing / crossSectionConsistency
 *      ——该两字段缺省时的旧口径，与 M15.5 重放同一形态）
 *   ③ Evidence-Aware 候选策略：同输入 + deriveEvidencePairing（清洁副本 = 证据库空 /
 *      污染副本 = 历史骨架库）+ computeCrossSectionConsistency（源 tex 确定性检查）
 *   ④ MOT r3：以 p-c923662f9c48 存储的 r3 review summary + claimGapAudit 重评
 *      （v1 vs new；existing-paper task-scoped 语境）
 *
 * 数据来源（只读，不动原始数据）：
 *   - D:\PaperTeamData\M11_4_QualityGateBenchmark\benchmark-report.json（21 样本，10-06 管线）
 *   - D:\PaperTeamData\M15\M15_5\runs\m155-benchmark-report.json（19 样本，当前管线）
 *   - 各锚点源 tex（M11.4 staging / M15.5 benchmark / M10.3-real-paper-case / mot r51）
 *
 * 预登记：D:\PaperTeamData\M15\M15_6\PRE_REGISTERED_PROTOCOL.md（§4 基准与泄漏处置）
 * 用法：node scripts/m156-evidence-aware-gate-benchmark.mjs [--replay] [--mot] [--all]
 */

import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const dist = (...p) => join(repoRoot, "backend", "dist", ...p);
const distUrl = (...p) => `file://${dist(...p).replaceAll("\\", "/")}`;

const WORK_DIR = "D:\\PaperTeamData\\M15\\M15_6";
const M114_REPORT = "D:\\PaperTeamData\\M11_4_QualityGateBenchmark\\benchmark-report.json";
const M155_REPORT = "D:\\PaperTeamData\\M15\\M15_5\\runs\\m155-benchmark-report.json";
const M114_STAGING = "D:\\PaperTeamData\\M11_4_QualityGateBenchmark\\staging";
const M114_CASE_ROOT = "D:\\PaperTeamData\\M10.3-real-paper-case";
const M155_BENCH = "D:\\PaperTeamData\\M15\\M15_5\\benchmark";
const M155_MOT = "D:\\PaperTeamData\\M15\\M15_5\\mot";
const MOT_R3_PROJECT = join(repoRoot, "backend", "projects", "p-c923662f9c48");

const args = process.argv.slice(2);
const doReplay = args.includes("--replay") || args.includes("--all");
const doMot = args.includes("--mot") || args.includes("--all");
if (!doReplay && !doMot) {
  console.log("用法：node scripts/m156-evidence-aware-gate-benchmark.mjs --replay | --mot | --all");
  process.exit(0);
}

const { evaluateQualityGate } = await import(distUrl("quality", "gates.js"));
const { deriveEvidencePairing } = await import(distUrl("quality", "evidencePairing.js"));
const { computeCrossSectionConsistency } = await import(distUrl("review", "crossSectionConsistency.js"));
const { computeClaimGroundingReport } = await import(distUrl("review", "claimGrounding.js"));
const { resolveClaimIndexLinks, tagIssueRootCauses } = await import(distUrl("review", "claimGapAudit.js"));

const sha256 = (text) => createHash("sha256").update(text, "utf8").digest("hex").toUpperCase();

// ---- 锚点源 tex 映射（caseId → files；与 m114/m155 脚本一致） ----
async function anchorFiles() {
  const files = {};
  const put = (caseId, entries) => {
    files[caseId] = entries;
  };
  const pre = await readFile(join(M114_CASE_ROOT, "manuscript", "historical", "paper_before_revision.tex"), "utf8");
  const human = await readFile(join(M114_CASE_ROOT, "manuscript", "source", "paper.tex"), "utf8");
  const candidate = await readFile(join(repoRoot, "backend", "projects", "p-d12dc28ad850", "manuscript", "main.tex"), "utf8");
  const bad = pre.replace(/\\begin\{table\*?\}[\s\S]*?\\end\{table\*?\}\s*/g, "");
  put("f1-pre", [{ file: "main.tex", content: pre }]);
  put("f1-human-final", [{ file: "main.tex", content: human }]);
  put("f1-candidate", [{ file: "main.tex", content: candidate }]);
  put("f1-bad-notables", [{ file: "main.tex", content: bad }]);
  put("f2-bytetrack", [{ file: "main.tex", content: await readFile(join(M114_STAGING, "bytetrack", "egpaper_final.tex"), "utf8") }]);
  put("f3-ocsort", [{ file: "main.tex", content: await readFile(join(M114_STAGING, "ocsort", "main.tex"), "utf8") }]);
  put("f4-strongsort", [{ file: "main.tex", content: await readFile(join(M114_STAGING, "strongsort", "bare_jrnl_new_sample4.tex"), "utf8") }]);
  // M15.5 anchors
  put("ce1-ocsort-numeric", [{ file: "main.tex", content: await readFile(join(M155_BENCH, "ce1-ocsort", "main.tex"), "utf8") }]);
  const f5dir = join(M155_BENCH, "f5-staging");
  const f5entries = [];
  for (const entry of await readdir(f5dir, { withFileTypes: true })) {
    if (entry.name.endsWith(".tex")) {
      const content = await readFile(join(f5dir, entry.name), "utf8");
      f5entries.push({ file: entry.name === "ms.tex" ? "main.tex" : entry.name, content });
    }
  }
  put("f5-attention", f5entries);
  put("mot-r51-real", [{
    file: "main.tex",
    content: await readFile(join(M155_MOT, "r51-extract", "mot_paperteam_review", "manuscript", "paper_submission_candidate.tex"), "utf8"),
  }]);
  return files;
}

// ---- 存储样本 → 统一形态 ----
function toUnified(sample, source) {
  const factVerdicts = {
    SUPPORTED: sample.supported ?? Math.max(0, (sample.claims ?? 0) - (sample.unsupported ?? 0) - (sample.contradicted ?? 0)),
    PARTIALLY_SUPPORTED: 0,
    UNSUPPORTED: sample.unsupported ?? 0,
    CONTRADICTED: sample.contradicted ?? 0,
  };
  return {
    key: sample.key,
    caseId: sample.caseId,
    source,
    anchor: sample.anchor,
    issues: sample.issues ?? [],
    factVerdicts,
    claimsTotal: sample.claims ?? (factVerdicts.SUPPORTED + factVerdicts.UNSUPPORTED + factVerdicts.CONTRADICTED),
    academicScore: sample.academicScore ?? null,
    styleRisk: sample.styleRisk ?? null,
  };
}

function buildReviewSummary(unified) {
  const issues = unified.issues.map((issue) => ({
    category: issue.category,
    severity: issue.severity,
    section: issue.section,
    description: issue.description,
    blocking: issue.blocking,
    ...(issue.verification ? { verification: issue.verification } : {}),
  }));
  return {
    generatedAt: "replay",
    round: 1,
    issues,
    counts: {
      critical: issues.filter((i) => i.severity === "critical").length,
      major: issues.filter((i) => i.severity === "major").length,
      minor: issues.filter((i) => i.severity === "minor").length,
      byCategory: {},
      blocking: issues.filter((i) => i.blocking).length,
    },
    scores: { academicScore: unified.academicScore, styleRisk: unified.styleRisk, factVerdicts: unified.factVerdicts },
    openCritical: issues.filter((i) => i.severity === "critical").length,
    openMajor: issues.filter((i) => i.severity === "major").length,
    unsupportedCriticalClaims: unified.factVerdicts.UNSUPPORTED + unified.factVerdicts.CONTRADICTED,
    reportPaths: [],
  };
}

/** ① v1 语义重放（不含 pairing / crossSection——M15.5 同形态） */
function replayV1(review, evidence) {
  return evaluateQualityGate({ review, citation: null, evidence, feasibility: null });
}

/** ③ 候选策略重放（清洁或污染证据库 + 跨节确定性检查；reconstructClaimGrounding = 无 claim 文本 → legacy verdicts 路径） */
function replayCandidate(review, unified, options) {
  const evidence = options.pairingAvailable
    ? { total: 3, byStatus: { unverified: 1, verified: 2, plausible: 0 }, contradictory: 0, skippedLines: 0 }
    : { total: 0, byStatus: { unverified: 0, verified: 0, plausible: 0 }, contradictory: 0, skippedLines: 0 };
  const pairing = deriveEvidencePairing({
    reviewPurpose: options.reviewPurpose,
    evidence: { total: evidence.total, verified: evidence.byStatus.verified, contradictory: 0 },
    claimGrounding: null,
    claimChecks: undefined,
    factVerdicts: unified.factVerdicts,
    unsupportedCriticalClaims: review.unsupportedCriticalClaims,
    issues: review.issues,
    evidenceRecords: [],
  });
  const crossSection = options.crossSection;
  return evaluateQualityGate({
    review,
    citation: null,
    evidence,
    feasibility: null,
    evidencePairing: pairing,
    ...(crossSection !== undefined ? { crossSectionConsistency: crossSection } : {}),
    ...(options.reviewPurpose === "published_paper_assessment" ? { reviewPurpose: "published_paper_assessment" } : {}),
  });
}

function ruleMap(gate) {
  const out = {};
  for (const rule of gate.rules) out[rule.rule] = { status: rule.status ?? (rule.passed ? "PASS" : "FAIL"), passed: rule.passed, required: rule.required === true };
  return out;
}

// ---- 阶段 D1/D2：重放 ----
async function runReplay() {
  const files = await anchorFiles();
  const m114 = JSON.parse(await readFile(M114_REPORT, "utf8"));
  const m155 = JSON.parse(await readFile(M155_REPORT, "utf8"));
  const samples = [
    ...m114.samples.map((s) => toUnified(s, "M11.4(10-06管线)")),
    ...m155.samples.map((s) => toUnified(s, "M15.5(当前管线)")),
  ];
  const out = [];
  for (const unified of samples) {
    const texEntries = files[unified.caseId];
    let crossSection;
    if (texEntries !== undefined) {
      crossSection = computeCrossSectionConsistency({ files: texEntries });
    }
    const review = buildReviewSummary(unified);
    const family = String(unified.anchor?.family ?? "");
    const isPublished = family.toUpperCase().includes("PUBLISHED") || unified.caseId.startsWith("ce");
    const reviewPurpose = isPublished ? "published_paper_assessment" : "author_manuscript";
    const v1 = replayV1(review, { total: 0, byStatus: { unverified: 0, verified: 0, plausible: 0 }, contradictory: 0, skippedLines: 0 });
    const candidateClean = replayCandidate(review, unified, { pairingAvailable: false, reviewPurpose, crossSection });
    const candidatePolluted = replayCandidate(review, unified, { pairingAvailable: true, reviewPurpose, crossSection });
    const rulesOf = (gate) => ruleMap(gate);
    const diffRules = [];
    const v1Rules = rulesOf(v1);
    for (const [ruleName, v1Rule] of Object.entries(v1Rules)) {
      const cRule = rulesOf(candidateClean)[ruleName];
      if (cRule !== undefined && (v1Rule.status !== cRule.status || v1Rule.passed !== cRule.passed)) {
        diffRules.push(`${ruleName}: ${v1Rule.status}→${cRule.status}`);
      }
    }
    out.push({
      key: unified.key,
      caseId: unified.caseId,
      source: unified.source,
      anchor: unified.anchor,
      paperFamily: unified.anchor?.family ?? "?",
      reviewPurpose,
      claimsEvaluated: unified.claimsTotal,
      verdicts: unified.factVerdicts,
      findings: { blocking: review.counts.blocking, critical: review.counts.critical, major: review.counts.major },
      v1: {
        passed: v1.passed,
        rule4: v1Rules["unsupported_critical_claims_zero"],
        rule5: v1Rules["blocking_issues_zero"],
        rule6: v1Rules["open_critical_major_zero"],
      },
      candidateClean: {
        passed: candidateClean.passed,
        rule4: rulesOf(candidateClean)["unsupported_critical_claims_zero"],
        rule5: rulesOf(candidateClean)["blocking_issues_zero"],
        rule6: rulesOf(candidateClean)["open_critical_major_zero"],
        crossSection: rulesOf(candidateClean)["cross_section_numeric_consistency"] ?? null,
      },
      candidatePollutedStore: {
        rule4: rulesOf(candidatePolluted)["unsupported_critical_claims_zero"],
        rule5: rulesOf(candidatePolluted)["blocking_issues_zero"],
        rule6: rulesOf(candidatePolluted)["open_critical_major_zero"],
      },
      crossSectionDetail: crossSection
        ? {
            status: crossSection.status,
            unavailableReason: crossSection.unavailableReason ?? null,
            counts: crossSection.counts,
            notEvaluatedReasons: crossSection.notEvaluatedReasons,
          }
        : { status: "NO_SOURCE_TEX" },
      diffRules,
      gateFlip: v1.passed !== candidateClean.passed,
    });
  }
  // 逐 case 记账（按 caseId 聚合；family 级报告）
  const byCase = new Map();
  for (const entry of out) {
    const list = byCase.get(entry.caseId) ?? [];
    list.push(entry);
    byCase.set(entry.caseId, list);
  }
  const accounting = [];
  for (const [caseId, entries] of byCase) {
    const first = entries[0];
    const anchor = first.anchor ?? {};
    accounting.push({
      caseId,
      family: first.paperFamily,
      samples: entries.length,
      qualityClass: anchor.qualityClass ?? "?",
      evidencePaired: anchor.evidencePaired === true,
      // 四路记账
      v1GateFailAll: entries.every((e) => e.v1.passed === false),
      candidateCleanGateFailAll: entries.every((e) => e.candidateClean.passed === false),
      rule4Flips: entries.filter((e) => e.v1.rule4.status === "FAIL" && e.candidateClean.rule4.status !== "FAIL").length,
      rule5Flips: entries.filter((e) => e.v1.rule5.status === "FAIL" && e.candidateClean.rule5.status !== "FAIL").length,
      rule6Flips: entries.filter((e) => e.v1.rule6.status === "FAIL" && e.candidateClean.rule6.status !== "FAIL").length,
      crossSectionVerifiedContradictions: first.crossSectionDetail.counts?.verifiedContradictions ?? null,
      crossSectionSuspected: first.crossSectionDetail.counts?.suspected ?? null,
    });
  }
  const report = {
    schemaVersion: 1,
    generatedAt: new Date().toISOString(),
    mode: "ZERO_MODEL_REPLAY",
    note: "v1 = evaluateQualityGate 旧口径（无 pairing / crossSection 字段）；candidateClean = 清洁副本语义（证据库空）；candidatePollutedStore = 历史骨架证据库（total=3）在库但未入 prompt（N3 形态）。M11.4/M15.5 输出为作者契约口径（非 published rubric）——published 语义的完整对照见 --fresh 阶段（生产只读评估工作流）。",
    samples: out,
    accounting,
  };
  await mkdir(join(WORK_DIR, "evaluation"), { recursive: true });
  await writeFile(join(WORK_DIR, "evaluation", "m156-replay-report.json"), JSON.stringify(report, null, 2), "utf8");
  // 控制台摘要
  console.log(`\n===== M15.6 重放：${samples.length} 样本 / ${accounting.length} case =====`);
  for (const entry of accounting) {
    console.log(
      `${entry.caseId.padEnd(28)} ${entry.qualityClass.padEnd(34)} v1FAIL=${entry.v1GateFailAll ? "Y" : "n"} candFAIL=${entry.candidateCleanGateFailAll ? "Y" : "n"} flips(r4/r5/r6)=${entry.rule4Flips}/${entry.rule5Flips}/${entry.rule6Flips} crossSection(verified/suspected)=${entry.crossSectionVerifiedContradictions}/${entry.crossSectionSuspected}`,
    );
  }
  const publishedCases = accounting.filter((a) => a.family.includes("PUBLISHED"));
  console.log(`\npublished family（F2-F5/CE）：${publishedCases.length} case`);
  console.log(`  v1 全 FAIL：${publishedCases.filter((a) => a.v1GateFailAll).length}/${publishedCases.length}`);
  console.log(`  candidate（clean）规则 4 翻正 case：${publishedCases.filter((a) => a.rule4Flips > 0).length}/${publishedCases.length}`);
  console.log(`  candidate（clean）规则 5 翻正 case：${publishedCases.filter((a) => a.rule5Flips > 0).length}/${publishedCases.length}`);
  console.log(`  candidate（clean）规则 6 翻正 case：${publishedCases.filter((a) => a.rule6Flips > 0).length}/${publishedCases.length}`);
  const defectCases = accounting.filter((a) => a.family.includes("real-revision") || a.family.includes("MOT"));
  console.log(`真实缺陷 family（F1/F6）：${defectCases.length} case`);
  for (const entry of defectCases) {
    console.log(`  ${entry.caseId.padEnd(28)} v1FAIL=${entry.v1GateFailAll ? "Y" : "n"} candFAIL=${entry.candidateCleanGateFailAll ? "Y" : "n"} flips=${entry.rule4Flips}/${entry.rule5Flips}/${entry.rule6Flips}`);
  }
  return report;
}

// ---- 阶段 D：MOT r3 重评（零模型；存储 review summary + claimGapAudit） ----
async function runMotR3() {
  const gateR3 = JSON.parse(await readFile(join(MOT_R3_PROJECT, "reviews", "quality-gate-r3.json"), "utf8"));
  const summary = gateR3.reviewSummary;
  // claimGapAudit r3（如存在）——重评 v1 vs new 的规则 4 语义（revisionIntroduced 路径不因 pairing 改写）
  let claimGapAudit = null;
  try {
    claimGapAudit = JSON.parse(await readFile(join(MOT_R3_PROJECT, "reviews", "claim-gap-audit-r3.json"), "utf8"));
  } catch {
    // 旧产物无 audit 文件：按 M15.5 r3 重放口径（gate 输入无 audit → 规则 4 走 claimGrounding/legacy 路径）
  }
  let claimGrounding = null;
  try {
    claimGrounding = JSON.parse(await readFile(join(MOT_R3_PROJECT, "reviews", "claim-grounding-r3.json"), "utf8"));
  } catch {
    // 无 claimGrounding → legacy verdicts 路径
  }
  const snapshotDir = join(MOT_R3_PROJECT, "revisions", "snapshots", "rev-3");
  let texEntries = null;
  try {
    const entries = [];
    const walk = async (dir, base) => {
      for (const entry of await readdir(dir, { withFileTypes: true })) {
        if (entry.isDirectory()) await walk(join(dir, entry.name), base ? `${base}/${entry.name}` : entry.name);
        else if (entry.name.endsWith(".tex")) entries.push({ file: base ? `${base}/${entry.name}` : entry.name, content: await readFile(join(dir, entry.name), "utf8") });
      }
    };
    await walk(snapshotDir, "");
    texEntries = entries.length > 0 ? entries : null;
  } catch {
    texEntries = null;
  }
  const crossSection = texEntries !== null ? computeCrossSectionConsistency({ files: texEntries }) : undefined;
  const baseInput = {
    review: summary,
    citation: null,
    evidence: { total: 8, byStatus: { unverified: 2, verified: 6, plausible: 0 }, contradictory: 0, skippedLines: 0 },
    feasibility: null,
    ...(claimGapAudit !== null ? { claimGapAudit } : {}),
    ...(claimGrounding !== null ? { claimGrounding } : {}),
  };
  const v1 = evaluateQualityGate(baseInput);
  const pairing = deriveEvidencePairing({
    reviewPurpose: "author_manuscript",
    evidence: { total: 8, verified: 6, contradictory: 0 },
    claimGrounding,
    claimChecks: undefined,
    factVerdicts: summary.scores.factVerdicts,
    unsupportedCriticalClaims: summary.unsupportedCriticalClaims,
    issues: summary.issues,
    evidenceRecords: [],
  });
  const next = evaluateQualityGate({
    ...baseInput,
    evidencePairing: pairing,
    ...(crossSection !== undefined ? { crossSectionConsistency: crossSection } : {}),
  });
  const v1Rules = ruleMap(v1);
  const nextRules = ruleMap(next);
  const flips = [];
  for (const [rule, info] of Object.entries(v1Rules)) {
    const after = nextRules[rule];
    if (after !== undefined && (info.status !== after.status || info.passed !== after.passed)) flips.push(`${rule}: ${info.status}→${after.status}`);
  }
  const report = {
    generatedAt: new Date().toISOString(),
    project: "p-c923662f9c48",
    round: 3,
    note: "存储 r3 review summary 重评（零模型）。v1 = 旧口径；new = M15.6（pairing + crossSection）。r3 语境 existing-paper task-scoped（claimGapAudit 路径优先，规则 4 不因 pairing 改写）；证据库 8 条（含 E001/S003 verified）→ PAIRING_AVAILABLE。",
    storedGateVerdict: { passed: gateR3.gate.passed, reasons: gateR3.gate.reasons.map((r) => r.split(":")[0]) },
    claimGapAuditPresent: claimGapAudit !== null,
    claimGapAuditCounts: claimGapAudit?.counts ?? null,
    v1: { passed: v1.passed, failedRules: v1.rules.filter((r) => !r.passed).map((r) => r.rule) },
    m156: { passed: next.passed, failedRules: next.rules.filter((r) => !r.passed).map((r) => r.rule) },
    flips,
    crossSection: crossSection
      ? { status: crossSection.status, counts: crossSection.counts, notEvaluatedReasons: crossSection.notEvaluatedReasons,
          witnesses: crossSection.witnesses.filter((w) => w.outcome !== "NOT_EVALUATED" && w.outcome !== "CONSISTENT").map((w) => ({ outcome: w.outcome, raw: w.raw, quote: w.quote.slice(0, 120), bound: w.binding?.bound?.value ?? null })) }
      : null,
    rule4Detail: next.rules.find((r) => r.rule === "unsupported_critical_claims_zero")?.detail ?? null,
  };
  await mkdir(join(WORK_DIR, "evaluation"), { recursive: true });
  await writeFile(join(WORK_DIR, "evaluation", "m156-mot-r3-reeval.json"), JSON.stringify(report, null, 2), "utf8");
  console.log(`\n===== MOT r3 重评 =====`);
  console.log(`存储 gate：${gateR3.gate.passed ? "PASS" : "FAIL"}（${gateR3.gate.reasons.map((r) => r.split(":")[0]).join(", ")}）`);
  console.log(`v1 重评：${v1.passed ? "PASS" : "FAIL"}（${v1.rules.filter((r) => !r.passed).map((r) => r.rule).join(", ")}）`);
  console.log(`M15.6 重评：${next.passed ? "PASS" : "FAIL"}（${next.rules.filter((r) => !r.passed).map((r) => r.rule).join(", ")}）`);
  console.log(`翻转：${flips.length === 0 ? "无（真实缺陷保持阻断）" : flips.join("; ")}`);
  console.log(`跨节检查：${crossSection ? JSON.stringify(crossSection.counts) : "快照不可得"}`);
  return report;
}

if (doReplay) await runReplay();
if (doMot) await runMotR3();
console.log("\nDONE. 报告：D:\\PaperTeamData\\M15\\M15_6\\evaluation\\");
