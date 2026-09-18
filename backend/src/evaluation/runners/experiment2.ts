/**
 * Experiment 2 Runner：Revision Safety Evaluation。
 *
 * 两臂对比（同一份故障注入实现——src 侧 scriptedRevision / scripted runtime 标记）：
 * - baseline：Reviewer → Writer，输出直接接受（无计划 / 无验证 / 无门禁）；
 * - paperteam：完整闭环 Reviewer → Revision Plan（条目生命周期）→ Writer →
 *   Revision Validation（四类确定性复核）→ Quality Gate（Revision Gate），
 *   由 WorkflowOrchestrator 全链路驱动（与生产同一引擎）。
 *
 * HITL 策略（hitl.revision_validation 出现时）：默认 reject（安全缺省：
 * 恢复修订前快照）；可配置 approve / needs_review 观察不同用户策略下的
 * 结果分布。指标口径见 metrics/revision.ts。
 */

import type {
  RevisionArmResult,
  RevisionHitlPolicy,
  RevisionScenario,
  RevisionScenarioRunRecord,
} from "../types.js";
import { computeRevisionSafetyMetrics, isSafetyGateRule } from "../metrics/revision.js";
import {
  baselineSectionContent,
  createWorkflowHarness,
  driveRunToTerminal,
  materializeWriterFaultOutput,
  readManuscriptSnapshot,
  readQualityGates,
  readRevisionValidations,
} from "./harness.js";
import { extractCitationKeys } from "../../review/styleInvariants.js";

const SAFETY_REASON_CODES = [
  "fact_preservation_violation",
  "citation_removal_unauthorized",
  "claim_strength_escalation",
];

function baselineRecordOf(scenario: RevisionScenario): RevisionScenarioRunRecord {
  const currentSection = baselineSectionContent(scenario.marker === "cite:drop");
  const accepted = materializeWriterFaultOutput(scenario.marker, currentSection);
  const citationKeys = extractCitationKeys(accepted);
  const injected = (kind: "fact" | "citation" | "strength") => scenario.injectedViolations.includes(kind);
  return {
    scenarioId: scenario.id,
    arm: "baseline",
    injectedViolations: scenario.injectedViolations,
    expectedClean: scenario.expectedClean,
    factSurvived: injected("fact") ? scenario.mutatedFactNeedles.some((needle) => accepted.includes(needle)) : null,
    citationSurvived: injected("citation")
      ? !scenario.mustKeepCitationKeys.every((key) => citationKeys.includes(key))
      : null,
    strengthSurvived: injected("strength")
      ? scenario.escalationNeedles.some((needle) => accepted.includes(needle))
      : null,
    flagged: false,
    flagChannels: [],
    runOutcome: null,
    validationRounds: [],
    gateRounds: [],
    hitlStages: [],
  };
}

async function paperteamRecordOf(
  scenario: RevisionScenario,
  hitlPolicy: RevisionHitlPolicy,
  log: (message: string) => void,
): Promise<RevisionScenarioRunRecord> {
  const harness = await createWorkflowHarness({ reviewSequence: [...scenario.reviewSequence] });
  try {
    const researchIdea =
      scenario.marker !== null ? `[${scenario.marker}] 检索增强生成的系统评估` : "检索增强生成的系统评估";
    const project = await harness.store.create(scenario.title, { researchIdea });
    const run = await harness.orchestrator.createRun(project.id, "idea_to_paper", {});
    const driven = await driveRunToTerminal(harness, run.runId, { hitlPolicy, timeoutMs: 180_000 });
    if (driven.timedOut) {
      log(`[exp2] ${scenario.id}：驱动超预算（status=${driven.run.status}）——按当前产物如实记录`);
    }
    const snapshot = await readManuscriptSnapshot(harness.root, project.id);
    const validationRounds = await readRevisionValidations(harness.root, project.id);
    const gateRounds = await readQualityGates(harness.root, project.id);
    const violationCodes = validationRounds.flatMap((round) =>
      round.reasonCodes.filter((code) => SAFETY_REASON_CODES.includes(code)),
    );
    const safetyFailedRules = gateRounds.flatMap((round) => round.failedRules.filter(isSafetyGateRule));
    const flagChannels = [
      ...(violationCodes.length > 0 ? [`revision.validate:${[...new Set(violationCodes)].join("+")}`] : []),
      ...(safetyFailedRules.length > 0 ? [`quality.gate:${[...new Set(safetyFailedRules)].join("+")}`] : []),
      ...(driven.hitlStages.includes("hitl.revision_validation") ? ["hitl.revision_validation"] : []),
    ];
    const injected = (kind: "fact" | "citation" | "strength") => scenario.injectedViolations.includes(kind);
    return {
      scenarioId: scenario.id,
      arm: "paperteam",
      injectedViolations: scenario.injectedViolations,
      expectedClean: scenario.expectedClean,
      factSurvived: injected("fact")
        ? scenario.mutatedFactNeedles.some((needle) => snapshot.text.includes(needle))
        : null,
      citationSurvived: injected("citation")
        ? !scenario.mustKeepCitationKeys.every((key) => snapshot.citationKeys.includes(key))
        : null,
      strengthSurvived: injected("strength")
        ? scenario.escalationNeedles.some((needle) => snapshot.text.includes(needle))
        : null,
      flagged: flagChannels.length > 0,
      flagChannels,
      runOutcome: {
        status: driven.run.status,
        label: driven.run.completion?.label ?? null,
      },
      validationRounds,
      gateRounds,
      hitlStages: driven.hitlStages,
    };
  } finally {
    await harness.cleanup();
  }
}

export interface Experiment2Result {
  experiment: 2;
  name: "revision-safety";
  arms: RevisionArmResult[];
  aggregate: { baseline: ReturnType<typeof computeRevisionSafetyMetrics>; paperteam: ReturnType<typeof computeRevisionSafetyMetrics> };
  comparison: Record<string, unknown>;
  limitations: string[];
}

export async function runExperiment2(options: {
  scenarios: readonly RevisionScenario[];
  hitlPolicy: RevisionHitlPolicy;
  log?: (message: string) => void;
}): Promise<Experiment2Result> {
  const log = options.log ?? (() => {});
  const baselineRecords: RevisionScenarioRunRecord[] = [];
  const paperteamRecords: RevisionScenarioRunRecord[] = [];
  for (const scenario of options.scenarios) {
    baselineRecords.push(baselineRecordOf(scenario));
    log(`[exp2] ${scenario.id}：paperteam 臂（policy=${options.hitlPolicy}）`);
    paperteamRecords.push(await paperteamRecordOf(scenario, options.hitlPolicy, log));
  }
  const arms: RevisionArmResult[] = [
    { arm: "baseline", records: baselineRecords, metrics: computeRevisionSafetyMetrics(baselineRecords) },
    { arm: "paperteam", records: paperteamRecords, metrics: computeRevisionSafetyMetrics(paperteamRecords) },
  ];
  const baseline = arms[0]!.metrics;
  const paperteam = arms[1]!.metrics;
  const delta = (a: number | null, b: number | null) => (a !== null && b !== null ? b - a : null);
  return {
    experiment: 2,
    name: "revision-safety",
    arms,
    aggregate: { baseline, paperteam },
    comparison: {
      factViolationRate: {
        baseline: baseline.factViolationRate,
        paperteam: paperteam.factViolationRate,
        delta: delta(baseline.factViolationRate, paperteam.factViolationRate),
      },
      citationLossRate: {
        baseline: baseline.citationLossRate,
        paperteam: paperteam.citationLossRate,
        delta: delta(baseline.citationLossRate, paperteam.citationLossRate),
      },
      claimEscalationRate: {
        baseline: baseline.claimEscalationRate,
        paperteam: paperteam.claimEscalationRate,
        delta: delta(baseline.claimEscalationRate, paperteam.claimEscalationRate),
      },
      falseAcceptanceRate: {
        baseline: baseline.falseAcceptanceRate,
        paperteam: paperteam.falseAcceptanceRate,
        delta: paperteam.falseAcceptanceRate - baseline.falseAcceptanceRate,
      },
      falseRejectionRate: {
        baseline: baseline.falseRejectionRate,
        paperteam: paperteam.falseRejectionRate,
      },
    },
    limitations: [
      "scripted 故障注入：三类违规（事实篡改 / 引用丢失 / 强度升级）来自 scriptedRuntime 固定形态，覆盖的是 Gate 与 Validation 的设计目标类，不是全部真实 Writer 错误形态",
      "paperteam 臂的存活率依赖 HITL 策略（默认 reject=恢复快照）；approve 策略下违规可随用户决策进入终稿（留痕但不阻断），这属于设计行为不是缺陷",
      "baseline 臂按「Writer 输出直接接受」建模，无系统信号可给——falseAcceptance=100% 是建模事实不是测量值",
    ],
  };
}
