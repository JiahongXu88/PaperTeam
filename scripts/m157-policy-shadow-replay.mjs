#!/usr/bin/env bun
/**
 * M15.7 Stage B/C：Quality Policy V2 Shadow 零模型重放（预登记协议 §3 三臂判定矩阵）。
 *
 * 数据基底：D:\PaperTeamData\M15\QualityGateCalibration\experiments\runs\<arm>__<K>__r<n>\
 *   （M15 评分有效性研究的 159 个已完成生产管线 run；引擎 3400f87，reviewPurpose=published_paper_assessment）。
 *   只读消费存储的 quality-gate-r1.json / review-summary-r1.json / run-result.json——同引擎同输入，
 *   政策臂是唯一变量；本脚本零模型调用（--max-model-calls 恒 0）。
 *
 * 三臂：legacy_v1（存储判定原样，用于适配层恒等校验）/ score_style_advisory（A）/ policy_aware（B）。
 * 输出：evaluation/m157-shadow-replay-report.json + m157-shadow-replay-summary.md
 *
 * CLI（协议 §5）：
 *   --list                 只枚举 run 清单（arm/track/split/caseId）退出
 *   --dry-run              全量解析与校验但不写报告
 *   --resume               跳过输出报告中已存在的 runId（缺省行为之外的显式选择）
 *   --fresh                显式覆盖既有报告（缺省：报告存在即拒绝，避免无意重跑）
 *   --out <path>           报告路径（缺省 evaluation/m157-shadow-replay-report.json）
 *   --max-model-calls N    必须为 0（本脚本零模型；非 0 直接拒绝）
 *   --include-cand1        同时重放 cand1 臂（评分 rubric 变体；缺省只跑 base 臂）
 */

import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import {dirname, join} from "node:path";
import { fileURLToPath } from "node:url";
import { applyQualityPolicy, QUALITY_POLICY_VERSION } from "../backend/src/quality/qualityPolicyV2.ts";

const SCRIPT_DIR = dirname(fileURLToPath(import.meta.url));
const RUNS_ROOT = "D:/PaperTeamData/M15/QualityGateCalibration/experiments/runs";
const OUT_DIR = "D:/PaperTeamData/M15/M15_7/evaluation";
const DEFAULT_OUT = join(OUT_DIR, "m157-shadow-replay-report.json");

const args = process.argv.slice(2);
const has = (flag) => args.includes(flag);
const valueOf = (flag) => {
  const index = args.indexOf(flag);
  return index >= 0 ? args[index + 1] : undefined;
};

const maxModelCalls = valueOf("--max-model-calls");
if (maxModelCalls !== undefined && maxModelCalls !== "0") {
  console.error(`[refuse] 本脚本零模型调用，--max-model-calls 只接受 0（收到 ${maxModelCalls}）`);
  process.exit(2);
}

const listOnly = has("--list");
const dryRun = has("--dry-run");
const fresh = has("--fresh");
const resume = has("--resume");
const includeCand1 = has("--include-cand1");
const outPath = valueOf("--out") ?? DEFAULT_OUT;

// ---- run 发现 ----

const listRunDirs = async () => {
  const entries = await readdirSafe(RUNS_ROOT);
  return entries.filter((name) => name.includes("__"));
};

const readdirSafe = async (path) => {
  try {
    return await readdir(path);
  } catch (error) {
    console.error(`[refuse] 无法读取运行目录 ${path}：${error.message}`);
    process.exit(2);
  }
};

const readJsonSafe = async (path) => {
  try {
    return JSON.parse(await readFile(path, "utf-8"));
  } catch {
    return null;
  }
};

/** registry/case_ids.json：案例名（C01-HEADLINE_CROSS-M01 等）→ K 哈希；本脚本反查 K → 案例名 */
const REGISTRY_CASE_IDS = "D:/PaperTeamData/M15/QualityGateCalibration/registry/case_ids.json";
const caseIdReverse = new Map();
{
  const registry = await readJsonSafe(REGISTRY_CASE_IDS);
  if (registry === null) {
    console.error(`[refuse] 无法读取 registry ${REGISTRY_CASE_IDS}（案例名反查必需）`);
    process.exit(2);
  }
  for (const [caseName, kHash] of Object.entries(registry)) caseIdReverse.set(kHash, caseName);
}

/** run-result.json → { runId, harnessArm, caseId, track, split, status } */
const runMeta = (dirName, runResult) => ({
  runId: runResult?.runId ?? dirName,
  harnessArm: dirName.split("__")[0],
  caseId: caseIdReverse.get(runResult?.caseId) ?? runResult?.caseId ?? null,
  track: runResult?.track ?? null,
  split: runResult?.split ?? null,
  status: runResult?.status ?? null,
});

/** C 家族注入类型（registry 构造事实，非测量标签）：C01-HEADLINE_CROSS-M01 → HEADLINE_CROSS */
const mutationOf = (caseId) => {
  if (typeof caseId !== "string") return null;
  const match = caseId.match(/^[CB]-?\d*-(?:([A-Z_]+))-M\d+$/) ?? caseId.match(/^C\d+-([A-Z_]+)-M\d+$/);
  return match ? match[1] : null;
};

const isMutationCase = (caseId) => typeof caseId === "string" && /-[A-Z_]+-M\d+$/.test(caseId);

// ---- 单 run 重放 ----

const replayRun = async (dirName) => {
  const dir = join(RUNS_ROOT, dirName);
  const runResult = await readJsonSafe(join(dir, "run-result.json"));
  const meta = runMeta(dirName, runResult);
  if (meta.status !== "completed") return { ...meta, outcome: "SKIPPED_NOT_COMPLETED" };
  if (meta.track === "SMOKE") return { ...meta, outcome: "SKIPPED_SMOKE" };

  const gateArtifact = await readJsonSafe(join(dir, "artifacts", "quality-gate-r1.json"));
  const summaryArtifact = await readJsonSafe(join(dir, "artifacts", "review-summary-r1.json"));
  if (gateArtifact === null || summaryArtifact === null) {
    return { ...meta, outcome: "SKIPPED_MISSING_ARTIFACTS" };
  }
  const gate = gateArtifact.gate ?? gateArtifact;
  if (!Array.isArray(gate.rules) || typeof gate.passed !== "boolean") {
    return { ...meta, outcome: "SKIPPED_MALFORMED_GATE" };
  }

  const scores = {
    academicScore: summaryArtifact.scores?.academicScore ?? null,
    styleRisk: summaryArtifact.scores?.styleRisk ?? null,
  };
  const scenario = {
    reviewPurpose: gate.evaluation?.reviewPurpose ?? "author_manuscript",
    workflowKind: gate.evaluation?.workflowKind ?? null,
  };

  const legacy = applyQualityPolicy({ gate, arm: "legacy_v1", scores, scenario });
  const candidateA = applyQualityPolicy({ gate, arm: "score_style_advisory", scores, scenario });
  const candidateB = applyQualityPolicy({ gate, arm: "policy_aware", scores, scenario });

  // 恒等校验：legacy 臂必须与存储判定逐规则一致（适配层没有偷偷改历史）
  const legacyRulesMatch = JSON.stringify(legacy.gate.rules) === JSON.stringify(gate.rules)
    && legacy.gate.passed === gate.passed;

  const falseReadyFlag =
    meta.track === "C" &&
    isMutationCase(meta.caseId) &&
    legacy.gate.passed === false &&
    candidateA.outcome.candidatePassed === true;

  return {
    ...meta,
    outcome: "REPLAYED",
    reviewPurpose: scenario.reviewPurpose,
    scores,
    legacyPassed: legacy.gate.passed,
    legacyRulesMatch,
    candidateA: {
      passed: candidateA.outcome.candidatePassed,
      reasonCode: candidateA.outcome.reasonCode,
      unblocked: candidateA.outcome.unblocked,
      remainingBlockers: candidateA.outcome.remainingBlockers,
      ruleDiffs: candidateA.ruleDiffs,
    },
    candidateB: {
      passed: candidateB.outcome.candidatePassed,
      reasonCode: candidateB.outcome.reasonCode,
      assessment: candidateB.assessment ?? null,
      ruleDiffs: candidateB.ruleDiffs,
    },
    mutationType: mutationOf(meta.caseId),
    falseReadyFlag,
  };
};

// ---- 聚合 ----

const aggregate = (records) => {
  const replayed = records.filter((record) => record.outcome === "REPLAYED");
  const by = (keyFn) => {
    const table = {};
    for (const record of replayed) {
      const key = keyFn(record);
      table[key] = (table[key] ?? 0) + 1;
    }
    return table;
  };
  return {
    runsTotal: records.length,
    replayed: replayed.length,
    skipped: records.filter((record) => record.outcome !== "REPLAYED").map((record) => ({ runId: record.runId, outcome: record.outcome })),
    legacyIdentityViolations: replayed.filter((record) => record.legacyRulesMatch !== true).map((record) => record.runId),
    monotonicityViolations: replayed.filter((record) => record.candidateA.reasonCode === "MONOTONICITY_VIOLATION").map((record) => record.runId),
    reasonCodeByTrack: replayed.reduce((table, record) => {
      const track = record.track ?? "?";
      table[track] = table[track] ?? {};
      const code = record.candidateA.reasonCode;
      table[track][code] = (table[track][code] ?? 0) + 1;
      return table;
    }, {}),
    unblockedRuns: replayed
      .filter((record) => record.legacyPassed === false && record.candidateA.passed === true)
      .map((record) => ({ runId: record.runId, caseId: record.caseId, track: record.track, split: record.split, reasonCode: record.candidateA.reasonCode })),
    falseReadyCandidates: replayed.filter((record) => record.falseReadyFlag).map((record) => ({
      runId: record.runId,
      caseId: record.caseId,
      mutationType: record.mutationType,
      scores: record.scores,
      remainingBlockers: record.candidateA.remainingBlockers,
    })),
    assessmentCompletionB: by((record) => record.candidateB.assessment?.completion ?? "NO_ASSESSMENT_BLOCK"),
  };
};

// ---- main ----

const dirNames = await listRunDirs();
const selected = includeCand1 ? dirNames : dirNames.filter((name) => name.startsWith("base__"));

if (listOnly) {
  for (const name of selected.sort()) {
    const runResult = await readJsonSafe(join(RUNS_ROOT, name, "run-result.json"));
    const meta = runMeta(name, runResult);
    console.log(`${name}\tarm=${meta.harnessArm}\ttrack=${meta.track}\tsplit=${meta.split}\tcase=${meta.caseId}\tstatus=${meta.status}`);
  }
  console.log(`[list] ${selected.length} runs（${includeCand1 ? "含 cand1" : "仅 base"}）`);
  process.exit(0);
}

const reportExists = await readJsonSafe(outPath);
if (reportExists !== null && !fresh && !resume) {
  console.error(`[refuse] 报告已存在 ${outPath}：用 --resume 续跑或 --fresh 显式覆盖（协议 §5 防无意重跑）`);
  process.exit(2);
}

const previous = resume && reportExists !== null ? reportExists : null;
const doneRunIds = new Set((previous?.records ?? []).map((record) => record.runId));

const records = previous ? [...previous.records] : [];
let processed = 0;
for (const name of selected.sort()) {
  const runResult = await readJsonSafe(join(RUNS_ROOT, name, "run-result.json"));
  const meta = runMeta(name, runResult);
  if (doneRunIds.has(meta.runId)) continue;
  const record = await replayRun(name);
  if (record.outcome === "SKIPPED_NOT_COMPLETED") continue; // SMOKE 等未完成 run 不入报告
  records.push(record);
  processed += 1;
}

const summary = aggregate(records);
const report = {
  schema: "m157-shadow-replay/v1",
  policyVersion: QUALITY_POLICY_VERSION,
  generatedAt: new Date().toISOString(),
  runsRoot: RUNS_ROOT,
  selection: includeCand1 ? "base+cand1" : "base-only",
  modelCalls: 0,
  aggregate: summary,
  records,
};

if (!dryRun) {
  await mkdir(dirname(outPath), { recursive: true });
  await writeFile(outPath, JSON.stringify(report, null, 2), "utf-8");
  const mdLines = [
    "# M15.7 Shadow 零模型重放摘要（自动生成）",
    "",
    `- 生成：${report.generatedAt}；policyVersion=${QUALITY_POLICY_VERSION}；模型调用 0`,
    `- runs：${summary.runsTotal} 枚举 / ${summary.replayed} 重放 / ${summary.skipped.length} 跳过`,
    `- Legacy 恒等校验违规：${summary.legacyIdentityViolations.length}（必须 0）`,
    `- 单调性违规（Legacy PASS→Candidate FAIL）：${summary.monotonicityViolations.length}（必须 0）`,
    `- 解锁样本（Legacy FAIL→A PASS）：${summary.unblockedRuns.length}`,
    `- FALSE_READY_CANDIDATE（C 注入案例被解锁）：${summary.falseReadyCandidates.length}`,
    "",
    "## reasonCode × track（Candidate A）",
    "",
    "```json",
    JSON.stringify(summary.reasonCodeByTrack, null, 2),
    "```",
    "",
    "## Candidate B assessment completion",
    "",
    "```json",
    JSON.stringify(summary.assessmentCompletionB, null, 2),
    "```",
  ];
  await writeFile(join(dirname(outPath), "m157-shadow-replay-summary.md"), mdLines.join("\n"), "utf-8");
}

console.log(`[done] 处理 ${processed} 新 run；重放 ${summary.replayed}；跳过 ${summary.skipped.length}`);
console.log(`[gates] legacyIdentity=${summary.legacyIdentityViolations.length} monotonicity=${summary.monotonicityViolations.length} falseReadyFlag=${summary.falseReadyCandidates.length}`);
if (!dryRun) console.log(`[written] ${outPath}`);
