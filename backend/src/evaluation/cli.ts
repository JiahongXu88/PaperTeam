/**
 * M6.8 Evaluation CLI 入口（npm run evaluation → scripts/evaluation.mjs → 本模块）。
 *
 * 用法：
 *   npm run evaluation                                # 全部实验、全部场景
 *   npm run evaluation -- --experiment 1              # 只跑 Experiment 1
 *   npm run evaluation -- --scenario g1-rag-survey --scenario r1-fact-mutate
 *   npm run evaluation -- --experiment 2 --hitl-policy needs_review
 *   npm run evaluation -- --list                      # 列出全部场景
 *   npm run evaluation -- --out D:/Tmp/eval-reports   # 自定义报告目录
 *
 * 校准记录：evaluation/calibration/records.jsonl（相对仓库根；--calibration 覆盖）。
 * 报告输出：evaluation/reports/m6.8-evaluation-<timestamp>.{json,md}。
 */

import { readFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import { fileURLToPath } from "node:url";

import type { CalibrationRecord, RevisionHitlPolicy } from "./types.js";
import {
  GROUNDING_SCENARIOS,
  REVISION_SCENARIOS,
  WORKFLOW_SCENARIOS,
  selectScenarios,
  validateAllScenarios,
} from "./datasets/index.js";
import { parseCalibrationRecords, summarizeCalibration } from "./metrics/calibration.js";
import { runExperiment1, type Experiment1Result } from "./runners/experiment1.js";
import { runExperiment2, type Experiment2Result } from "./runners/experiment2.js";
import { runExperiment3, type Experiment3Result } from "./runners/experiment3.js";
import { buildEvaluationReport, writeEvaluationReport } from "./runners/report.js";

// backend/dist/evaluation/cli.js → 仓库根（dist/evaluation → dist → backend → root）
const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..", "..", "..");

export interface CliOptions {
  experiment: number | "all";
  scenarios: string[];
  hitlPolicy: RevisionHitlPolicy;
  out: string;
  calibrationPath: string;
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    experiment: "all",
    scenarios: [],
    hitlPolicy: "reject",
    out: resolve(repoRoot, "evaluation", "reports"),
    calibrationPath: resolve(repoRoot, "evaluation", "calibration", "records.jsonl"),
  };
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--experiment") {
      const value = argv[index + 1];
      if (value !== "all" && !["1", "2", "3"].includes(value ?? "")) {
        throw new Error(`--experiment 只接受 1 | 2 | 3 | all（收到 ${value ?? "(缺)"}）`);
      }
      options.experiment = value === "all" ? "all" : Number.parseInt(value!, 10);
      index += 1;
    } else if (arg === "--scenario") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--scenario 需要一个 id 参数");
      }
      options.scenarios.push(value);
      index += 1;
    } else if (arg === "--hitl-policy") {
      const value = argv[index + 1];
      if (value !== "reject" && value !== "approve" && value !== "needs_review") {
        throw new Error(`--hitl-policy 只接受 reject | approve | needs_review（收到 ${value ?? "(缺)"}）`);
      }
      options.hitlPolicy = value;
      index += 1;
    } else if (arg === "--out") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--out 需要一个目录参数");
      }
      options.out = resolve(value);
      index += 1;
    } else if (arg === "--calibration") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--calibration 需要一个文件参数");
      }
      options.calibrationPath = resolve(value);
      index += 1;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  return options;
}

export function listScenarioIds(): string {
  return [
    "Experiment 1（evidence-grounding）：",
    ...GROUNDING_SCENARIOS.map((scenario) => `  ${scenario.id} — ${scenario.title}`),
    "Experiment 2（revision-safety）：",
    ...REVISION_SCENARIOS.map((scenario) => `  ${scenario.id} — ${scenario.title}`),
    "Experiment 3（agent-workflow）：",
    ...WORKFLOW_SCENARIOS.map((scenario) => `  ${scenario.id} — ${scenario.title}`),
  ].join("\n");
}

async function loadCalibration(path: string): Promise<{ records: CalibrationRecord[]; summary: ReturnType<typeof summarizeCalibration> }> {
  let text = "";
  try {
    text = await readFile(path, "utf8");
  } catch {
    return { records: [], summary: summarizeCalibration([]) };
  }
  const { records, parseErrors } = parseCalibrationRecords(text);
  return { records, summary: summarizeCalibration(records, parseErrors) };
}

export async function runEvaluationCli(argv: readonly string[]): Promise<void> {
  const options = parseCliArgs(argv);
  const validationIssues = validateAllScenarios();
  if (validationIssues.length > 0) {
    console.error("[evaluation] 数据集校验失败（拒绝跑脏数据）：");
    for (const issue of validationIssues) {
      console.error(`  ${issue.scenarioId}: ${issue.problem}`);
    }
    process.exitCode = 1;
    return;
  }
  const groundingScenarios = selectScenarios(GROUNDING_SCENARIOS, options.scenarios);
  const revisionScenarios = selectScenarios(REVISION_SCENARIOS, options.scenarios);
  const workflowScenarios = selectScenarios(WORKFLOW_SCENARIOS, options.scenarios);
  const log = (message: string) => console.log(message);

  const calibration = await loadCalibration(options.calibrationPath);
  let experiment1: Experiment1Result | undefined;
  let experiment2: Experiment2Result | undefined;
  let experiment3: Experiment3Result | undefined;

  if (options.experiment === "all" || options.experiment === 1) {
    log(`[evaluation] Experiment 1 开始（${groundingScenarios.length} 场景 × 3 臂）`);
    experiment1 = await runExperiment1({ scenarios: groundingScenarios, log });
  }
  if (options.experiment === "all" || options.experiment === 2) {
    log(`[evaluation] Experiment 2 开始（${revisionScenarios.length} 场景 × 2 臂，policy=${options.hitlPolicy}）`);
    experiment2 = await runExperiment2({
      scenarios: revisionScenarios,
      hitlPolicy: options.hitlPolicy,
      log,
    });
  }
  if (options.experiment === "all" || options.experiment === 3) {
    log(`[evaluation] Experiment 3 开始（${workflowScenarios.length} 场景 × 2 臂）`);
    experiment3 = await runExperiment3({
      scenarios: workflowScenarios,
      hitlPolicy: options.hitlPolicy,
      calibration: calibration.records,
      log,
    });
  }

  const report = buildEvaluationReport({
    experiment1,
    experiment2,
    experiment3,
    calibration: calibration.summary,
    hitlPolicy: options.hitlPolicy,
    scenarioIds: {
      experiment1: groundingScenarios.map((scenario) => scenario.id),
      experiment2: revisionScenarios.map((scenario) => scenario.id),
      experiment3: workflowScenarios.map((scenario) => scenario.id),
    },
  });
  const written = await writeEvaluationReport(report, options.out, "m6.8-evaluation");
  log(`[evaluation] 报告已写入：${written.jsonPath}`);
  log(`[evaluation] 摘要已写入：${written.markdownPath}`);
  // 一致性问题以非零退出码暴露（CI 可感知）
  const issues = (experiment1?.issues ?? []);
  if (issues.length > 0) {
    console.error(`[evaluation] ⚠ Experiment 1 ground truth 一致性问题 ${issues.length} 条：`);
    for (const issue of issues) {
      console.error(`  ${issue}`);
    }
    process.exitCode = 1;
  }
}

// 直接 node dist/evaluation/cli.js 时生效（scripts/evaluation.mjs 委托到这里）
if (process.argv[1] !== undefined && process.argv[1].endsWith("cli.js")) {
  runEvaluationCli(process.argv.slice(2)).catch((error) => {
    console.error(`[evaluation] 运行失败：${error instanceof Error ? error.stack ?? error.message : String(error)}`);
    process.exitCode = 1;
  });
}
