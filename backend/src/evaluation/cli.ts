/**
 * M6.8/M6.9 Evaluation CLI 入口（npm run evaluation → scripts/evaluation.mjs → 本模块）。
 *
 * 用法：
 *   npm run evaluation                                # 全部实验、全部场景（scripted）
 *   npm run evaluation -- --experiment 1              # 只跑 Experiment 1
 *   npm run evaluation -- --scenario g1-rag-survey --scenario r1-fact-mutate
 *   npm run evaluation -- --experiment 2 --hitl-policy needs_review
 *   npm run evaluation -- --list                      # 列出全部场景
 *   npm run evaluation -- --out D:/Tmp/eval-reports   # 自定义报告目录
 *   npm run evaluation -- --runtime real --experiment 1 --scenario g1-rag-survey
 *                                                     # M6.9.1 live 模式（真实模型，
 *                                                     #   目前仅 Exp1；模型走产品解析链）
 *   npm run evaluation -- --runtime real --model zai-coding-cn/glm-5.3 --experiment 1
 *                                                     # 显式指定模型规格
 *   npm run evaluation -- --runtime real --model claude-gateway/claude-fable-5-1 \
 *        --experiment 1 --scenario g1-rag-survey --dataset claude-compatible \
 *        --report-name live-claude-exp1-compatible
 *                                                     # M6.9.2.1：claude-compatible 数据集
 *                                                     #   （noise token 替换派生集，
 *                                                     #   绕开 Claude 通道 bio 过滤；
 *                                                     #   报告名不覆盖原始失败记录）
 *   npm run evaluation -- --runtime real --multi-model
 *                                                     # M6.9.3：多模型批次（网关目录中
 *                                                     #   选出的 5 个代表模型 × g1-rag-survey
 *                                                     #   × 2 臂，串行；固定 claude-compatible
 *                                                     #   数据集；汇总报告
 *                                                     #   multi-model-live-evaluation.{json,md}，
 *                                                     #   每模型原始报告在 reports/multi-model/）
 *
 * 校准记录：evaluation/calibration/records.jsonl（相对仓库根；--calibration 覆盖）。
 * 报告输出：scripted → evaluation/reports/m6.8-evaluation-<timestamp>.{json,md}；
 *           live    → evaluation/reports/live-<modeltag>-exp1.{json,md}
 *                     （--report-name 覆盖基名，如 live-claude-exp1-compatible）。
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
  /** scripted（M6.8 确定性离线）| real（M6.9.1 真实模型，经产品 Runtime） */
  runtime: "scripted" | "real";
  /** live 模式显式模型规格（"provider/model-id"）；缺省走产品解析链 */
  model?: string;
  /**
   * live 模式数据集变体（M6.9.2.1）：frozen = M6.8 冻结集；
   * claude-compatible = noise token 替换派生集（Claude 通道 bio 过滤兼容）。
   */
  dataset: "frozen" | "claude-compatible";
  /** live 模式报告文件名基名（如 live-claude-exp1-compatible；缺省 live-<modeltag>-exp1） */
  reportName?: string;
  /** M6.9.3 多模型批次（--runtime real 专用；模型清单固定在 runners/multiModel.ts） */
  multiModel?: boolean;
}

export function parseCliArgs(argv: readonly string[]): CliOptions {
  const options: CliOptions = {
    experiment: "all",
    scenarios: [],
    hitlPolicy: "reject",
    out: resolve(repoRoot, "evaluation", "reports"),
    calibrationPath: resolve(repoRoot, "evaluation", "calibration", "records.jsonl"),
    runtime: "scripted",
    dataset: "frozen",
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
    } else if (arg === "--runtime") {
      const value = argv[index + 1];
      if (value !== "scripted" && value !== "real") {
        throw new Error(`--runtime 只接受 scripted | real（收到 ${value ?? "(缺)"}）`);
      }
      options.runtime = value;
      index += 1;
    } else if (arg === "--model") {
      const value = argv[index + 1];
      if (value === undefined) {
        throw new Error("--model 需要一个 provider/model-id 参数");
      }
      options.model = value;
      index += 1;
    } else if (arg === "--dataset") {
      const value = argv[index + 1];
      if (value !== "frozen" && value !== "claude-compatible") {
        throw new Error(`--dataset 只接受 frozen | claude-compatible（收到 ${value ?? "(缺)"}）`);
      }
      options.dataset = value;
      index += 1;
    } else if (arg === "--report-name") {
      const value = argv[index + 1];
      if (value === undefined || !/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(value)) {
        throw new Error("--report-name 需要一个文件名基名参数（字母/数字/._-，如 live-claude-exp1-compatible）");
      }
      options.reportName = value;
      index += 1;
    } else if (arg === "--multi-model") {
      options.multiModel = true;
    } else {
      throw new Error(`未知参数：${arg}`);
    }
  }
  if (options.model !== undefined && options.runtime !== "real") {
    throw new Error("--model 只在 --runtime real 下有效（scripted 不访问任何模型）");
  }
  if (options.dataset !== "frozen" && options.runtime !== "real") {
    throw new Error("--dataset claude-compatible 只在 --runtime real 下有效（scripted 实验固定用 M6.8 frozen 数据集）");
  }
  if (options.reportName !== undefined && options.runtime !== "real") {
    throw new Error("--report-name 只在 --runtime real 下有效（scripted 报告名固定带时间戳）");
  }
  if (options.runtime === "real" && options.multiModel !== true && options.experiment !== 1) {
    throw new Error("--runtime real 目前只支持 --experiment 1（M6.9.1 首轮只接 Evidence Grounding）");
  }
  if (options.multiModel === true) {
    if (options.runtime !== "real") {
      throw new Error("--multi-model 只在 --runtime real 下有效（多模型批次需要真实模型）");
    }
    if (options.experiment !== "all" && options.experiment !== 1) {
      throw new Error("--multi-model 只支持 --experiment 1（协议固定 Evidence Grounding；缺省 all 视为 1）");
    }
    if (options.model !== undefined) {
      throw new Error("--multi-model 与 --model 互斥（多模型批次的模型清单固定在 runners/multiModel.ts）");
    }
    if (options.scenarios.length > 0) {
      throw new Error("--multi-model 与 --scenario 互斥（多模型批次协议固定 g1-rag-survey）");
    }
    if (options.reportName !== undefined) {
      throw new Error("--multi-model 与 --report-name 互斥（汇总报告名固定 multi-model-live-evaluation）");
    }
    // 协议要求全批统一 claude-compatible（批次含 Claude 通道模型，其 bio 过滤必须
    // 用派生集；混用两个数据集变体会引入跨模型混杂）。缺省 --dataset frozen 时
    // 自动切换并提示；显式 frozen 是协议矛盾，拒绝。
    if (options.dataset === "frozen") {
      options.dataset = "claude-compatible";
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
  const log = (message: string) => console.log(message);

  // M6.9.1 live 模式：真实模型（产品 Runtime 链）跑 Exp1 两臂，独立报告。
  // 只选 grounding 场景——revision/workflow 数据集与 live 无关，不参与 id 校验。
  // M6.9.2.1：--dataset claude-compatible 换用 noise token 替换派生集（同一
  // 场景 id 空间），先过兼容性校验（frozen 快照 / 结构一致 / 安全模式）再跑。
  if (options.runtime === "real") {
    // M6.9.3 多模型批次：固定协议（g1-rag-survey × 2 臂 × 5 提案，claude-compatible）
    // 串行跑编目模型，单模型失败不终止批次；runner 自带数据集校验。
    if (options.multiModel === true) {
      const { runMultiModelEvaluation } = await import("./runners/multiModel.js");
      const outcome = await runMultiModelEvaluation({ out: options.out, log });
      if (outcome.hasFailures) {
        console.error(
          `[evaluation] ⚠ multi-model 批次存在失败（completed ${outcome.report.aggregate.modelsCompleted}/${outcome.report.aggregate.modelsTotal}，详见 ${outcome.written.jsonPath}）`,
        );
        process.exitCode = 1;
      }
      return;
    }
    const claudeCompatible = options.dataset === "claude-compatible";
    let groundingPool = GROUNDING_SCENARIOS;
    if (claudeCompatible) {
      const { GROUNDING_SCENARIOS_CLAUDE, validateClaudeCompatibleDataset } = await import(
        "./datasets/claudeCompatible.js"
      );
      const compatibilityIssues = validateClaudeCompatibleDataset();
      if (compatibilityIssues.length > 0) {
        console.error("[evaluation] claude-compatible 数据集校验失败（拒绝跑脏数据）：");
        for (const issue of compatibilityIssues) {
          console.error(`  ${issue.scenarioId}: ${issue.problem}`);
        }
        process.exitCode = 1;
        return;
      }
      log("[evaluation] claude-compatible 数据集校验通过（frozen 快照一致 / 只差 noise token / 无 bio-编码模式新增）");
      groundingPool = GROUNDING_SCENARIOS_CLAUDE;
    }
    const liveScenarios = selectScenarios(groundingPool, options.scenarios);
    const { runLiveExperiment1 } = await import("./runners/liveExp1.js");
    const outcome = await runLiveExperiment1({
      scenarios: liveScenarios,
      ...(options.model !== undefined ? { modelSpec: options.model } : {}),
      dataset: claudeCompatible ? "claude-compatible" : "frozen-m6.8",
      ...(options.reportName !== undefined ? { reportBase: options.reportName } : {}),
      out: options.out,
      log,
    });
    if (outcome.hasArmFailures) {
      console.error(`[evaluation] ⚠ live 模式存在臂级失败 ${outcome.report.errors.length} 条（详见报告 errors）`);
      process.exitCode = 1;
    }
    return;
  }

  const revisionScenarios = selectScenarios(REVISION_SCENARIOS, options.scenarios);
  const workflowScenarios = selectScenarios(WORKFLOW_SCENARIOS, options.scenarios);
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
