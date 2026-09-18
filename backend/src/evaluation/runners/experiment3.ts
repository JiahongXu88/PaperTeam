/**
 * Experiment 3 Runner：Agent Workflow Evaluation。
 *
 * 两臂对比：
 * - plain-llm：单次生成（scenario 携带的代表性裸 LLM 输出——含捏造引用、
 *   无证据数值论断、章节缺失等典型缺陷，作为 scripted 数据如实标注）；
 * - paperteam：完整 idea_to_paper workflow（Research → Evidence Grounding →
 *   Feasibility → Outline → Writing → Citation Verify → Review → Revision →
 *   Gate → Build），带语料场景在 run 前预置 anchored 正例候选（evidence.ground
 *   stage 内真实三段核验转正）。
 *
 * 指标是管线保障口径（可追溯性 / 反捏造 / 完整度），不是生成质量——
 * limitations 如实声明；生成质量对比需要 live run（校准接口已预留）。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type {
  CalibrationRecord,
  WorkflowArmResult,
  WorkflowScenario,
} from "../types.js";
import { aggregateWorkflowMetrics, computeWorkflowMetrics } from "../metrics/workflow.js";
import { computeHumanPreference } from "../metrics/calibration.js";
import {
  createWorkflowHarness,
  driveRunToTerminal,
  readManuscriptSnapshot,
} from "./harness.js";
import { ChunkStore } from "../../retrieval/ChunkStore.js";
import { extractCitationKeys } from "../../review/styleInvariants.js";
import { isFormalEvidence, EvidenceSelectionService } from "../../evidence/EvidenceSelectionService.js";

/** 大纲章节文件 → scripted 标题（plain 输出的章节覆盖按标题匹配） */
const SECTION_TITLES: Record<string, string> = {
  "sections/introduction.tex": "引言",
  "sections/related-work.tex": "相关工作",
  "sections/method.tex": "评估方法",
  "sections/experiments.tex": "实验",
  "sections/conclusion.tex": "结论",
};

function plainArmResult(
  scenario: WorkflowScenario,
  calibration: readonly CalibrationRecord[],
): WorkflowArmResult {
  const output = scenario.plainBaseline.output;
  const citationsInOutput = [...new Set(extractCitationKeys(output))];
  const fabricated = new Set(scenario.plainBaseline.fabricatedCitationKeys);
  const validCitationKeys = citationsInOutput.filter((key) => !fabricated.has(key));
  const sectionsWritten = scenario.expected.sectionFiles.filter(
    (file) => SECTION_TITLES[file] !== undefined && output.includes(SECTION_TITLES[file]!),
  );
  const metrics = computeWorkflowMetrics({
    citationsInOutput,
    validCitationKeys,
    expectedCitationKeys: scenario.expected.citationKeys,
    expectedStages: scenario.expected.stages,
    stagesCompleted: [],
    expectedSections: scenario.expected.sectionFiles,
    sectionsWritten,
    expectedClaimNeedles: scenario.expected.claimNeedles,
    outputText: output,
    traceableClaims: 0,
    totalCitedClaims: citationsInOutput.length,
    humanPreference: computeHumanPreference(calibration, 3, scenario.id, "plain-llm"),
  });
  return {
    arm: "plain-llm",
    scenarioId: scenario.id,
    metrics,
    detail: {
      stagesCompleted: [],
      stagesMissing: [...scenario.expected.stages],
      sectionsWritten,
      citationsInOutput,
      verifiedEvidenceCount: 0,
      evidenceBackedCitedKeys: [],
      runOutcome: null,
    },
  };
}

async function paperteamArmResult(
  scenario: WorkflowScenario,
  hitlPolicy: "reject" | "approve" | "needs_review",
  calibration: readonly CalibrationRecord[],
  log: (message: string) => void,
): Promise<WorkflowArmResult> {
  const harness = await createWorkflowHarness({ reviewSequence: [...scenario.reviewSequence] });
  try {
    const project = await harness.store.create(scenario.title, { researchIdea: scenario.researchIdea });
    // 语料 + 预置 anchored 候选（evidence.ground stage 会真实核验转正）
    if (scenario.corpus !== undefined) {
      const fileNameToSourceId = new Map<string, string>();
      for (const item of scenario.corpus) {
        const { source } = await harness.stack.sources.add(project.id, {
          fileName: item.fileName,
          content: Buffer.from(item.content, "utf8"),
          metadata: { title: item.title, year: item.year },
        });
        fileNameToSourceId.set(item.fileName, source.sourceId);
      }
      await harness.stack.retrieval.search(project.id, scenario.corpus[0]!.fileName, { topK: 1 });
      const chunkStore = new ChunkStore(harness.store);
      for (const claim of scenario.preseedClaims ?? []) {
        const sourceId = fileNameToSourceId.get(claim.locator.fileName);
        if (sourceId === undefined) {
          log(`[exp3] ${scenario.id}：preseed 定位失败（${claim.locator.fileName}）——如实跳过`);
          continue;
        }
        const chunks = await chunkStore.readChunks(project.id, sourceId);
        const chunk = (chunks ?? []).find((item) => item.text.includes(claim.locator.needle));
        if (chunk === undefined) {
          log(`[exp3] ${scenario.id}：preseed needle 未命中 chunk——如实跳过`);
          continue;
        }
        await harness.stack.evidenceGrounding.propose(project.id, {
          sourceId,
          chunkId: chunk.chunkId,
          claim: claim.claim,
          quote: claim.locator.needle,
          proposedBy: "evaluation:preseed",
        });
      }
    }
    const run = await harness.orchestrator.createRun(project.id, "idea_to_paper", {});
    const driven = await driveRunToTerminal(harness, run.runId, { hitlPolicy, timeoutMs: 180_000 });
    if (driven.timedOut) {
      log(`[exp3] ${scenario.id}：驱动超预算（status=${driven.run.status}）——按当前产物如实记录`);
    }
    const snapshot = await readManuscriptSnapshot(harness.root, project.id);

    // research bibliography（合法引用面）+ verified evidence → bib key 关联
    // artifact 形状：{ report, evidence, bibliography }——bibliography 在顶层
    let bibliography: { key: string; title?: string; year?: number }[] = [];
    try {
      const research = JSON.parse(
        await readFile(join(harness.root, project.id, "research", "research.json"), "utf8"),
      ) as { bibliography?: { key: string; title?: string; year?: number }[] };
      bibliography = research.bibliography ?? [];
    } catch {
      bibliography = [];
    }
    const evidenceRecords = await harness.stack.evidence.list(project.id);
    const verified = evidenceRecords.filter(isFormalEvidence);
    const evidenceBackedKeys = new Set(
      verified.flatMap((record) => {
        const key = EvidenceSelectionService.matchBibliographyKey(record, bibliography);
        return key !== null ? [key] : [];
      }),
    );
    const bibliographyKeys = bibliography.map((entry) => entry.key);
    const citationsInOutput = snapshot.citationKeys;
    const validCitationKeys = citationsInOutput.filter((key) => bibliographyKeys.includes(key));
    const evidenceBackedCitedKeys = citationsInOutput.filter((key) => evidenceBackedKeys.has(key));
    const stagesCompleted = driven.run.completedStages;
    const metrics = computeWorkflowMetrics({
      citationsInOutput,
      validCitationKeys,
      expectedCitationKeys: scenario.expected.citationKeys,
      expectedStages: scenario.expected.stages,
      stagesCompleted,
      expectedSections: scenario.expected.sectionFiles,
      sectionsWritten: snapshot.files,
      expectedClaimNeedles: scenario.expected.claimNeedles,
      outputText: snapshot.text,
      traceableClaims: evidenceBackedCitedKeys.length,
      totalCitedClaims: citationsInOutput.length,
      humanPreference: computeHumanPreference(calibration, 3, scenario.id, "paperteam"),
    });
    return {
      arm: "paperteam",
      scenarioId: scenario.id,
      metrics,
      detail: {
        stagesCompleted,
        stagesMissing: scenario.expected.stages.filter((stage) => !stagesCompleted.includes(stage)),
        sectionsWritten: snapshot.files,
        citationsInOutput,
        verifiedEvidenceCount: verified.length,
        evidenceBackedCitedKeys,
        runOutcome: { status: driven.run.status, label: driven.run.completion?.label ?? null },
      },
    };
  } finally {
    await harness.cleanup();
  }
}

export interface Experiment3Result {
  experiment: 3;
  name: "agent-workflow";
  arms: WorkflowArmResult[];
  aggregate: Record<string, ReturnType<typeof aggregateWorkflowMetrics>>;
  comparison: Record<string, unknown>;
  limitations: string[];
}

export async function runExperiment3(options: {
  scenarios: readonly WorkflowScenario[];
  hitlPolicy: "reject" | "approve" | "needs_review";
  calibration?: readonly CalibrationRecord[];
  log?: (message: string) => void;
}): Promise<Experiment3Result> {
  const log = options.log ?? (() => {});
  const calibration = options.calibration ?? [];
  const arms: WorkflowArmResult[] = [];
  for (const scenario of options.scenarios) {
    arms.push(plainArmResult(scenario, calibration));
    log(`[exp3] ${scenario.id}：paperteam 臂`);
    arms.push(await paperteamArmResult(scenario, options.hitlPolicy, calibration, log));
  }
  const collect = (arm: string) => arms.filter((entry) => entry.arm === arm);
  const aggregate = {
    "plain-llm": aggregateWorkflowMetrics(collect("plain-llm")),
    paperteam: aggregateWorkflowMetrics(collect("paperteam")),
  };
  const delta = (a: number, b: number) => b - a;
  return {
    experiment: 3,
    name: "agent-workflow",
    arms,
    aggregate,
    comparison: {
      claimCorrectness: {
        plainLlm: aggregate["plain-llm"]!.claimCorrectness,
        paperteam: aggregate.paperteam!.claimCorrectness,
        delta: delta(aggregate["plain-llm"]!.claimCorrectness, aggregate.paperteam!.claimCorrectness),
      },
      citationCorrectness: {
        plainLlm: aggregate["plain-llm"]!.citationCorrectness,
        paperteam: aggregate.paperteam!.citationCorrectness,
        delta: delta(aggregate["plain-llm"]!.citationCorrectness, aggregate.paperteam!.citationCorrectness),
      },
      completeness: {
        plainLlm: aggregate["plain-llm"]!.completeness,
        paperteam: aggregate.paperteam!.completeness,
        delta: delta(aggregate["plain-llm"]!.completeness, aggregate.paperteam!.completeness),
      },
      humanPreference: {
        plainLlm: aggregate["plain-llm"]!.humanPreference,
        paperteam: aggregate.paperteam!.humanPreference,
        note: "无校准记录时为 null——人工偏好需要 live run + 人工标注（evaluation/calibration/records.jsonl）",
      },
    },
    limitations: [
      "plain 臂输出是 scenario 携带的代表性单次生成（scripted 数据，缺陷形态来自常见 LLM 失败模式的先验），不是真实模型采样",
      "claimCorrectness 度量「被引用论断可追溯到 verified evidence」的管线保障；无语料的 paperteam 场景按 M6.6 口径同样计 0（legacy unverified 不构成正式证据）",
      "humanPreference 在无人工校准记录时为 null（结构上不伪造偏好结论）",
    ],
  };
}
