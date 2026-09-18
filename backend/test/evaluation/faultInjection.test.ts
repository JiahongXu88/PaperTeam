/**
 * M6.8 Evaluation 测试三：fault injection（注入 → 真实机制拦截全链路）。
 *
 * - Experiment 1：g1 场景三臂实跑（真实 EvidenceGroundingService + 真实
 *   RetrievalService + ground-truth judge/resolver 替身）；
 * - Experiment 2 baseline 物化：scriptedRevision 同源故障输出（三类标记）；
 * - Experiment 2 paperteam：[cite:drop] 全链路 workflow 驱动（orchestrator
 *   → revision.validate 拦截 → HITL reject → 恢复快照）。
 */

import { describe, expect, it, vi } from "vitest";

import { GROUNDING_SCENARIOS } from "../../src/evaluation/datasets/index.js";
import { runExperiment1 } from "../../src/evaluation/runners/experiment1.js";
import {
  baselineSectionContent,
  createWorkflowHarness,
  driveRunToTerminal,
  materializeWriterFaultOutput,
  readManuscriptSnapshot,
  readRevisionValidations,
} from "../../src/evaluation/runners/harness.js";
import { extractCitationKeys } from "../../src/review/styleInvariants.js";

vi.setConfig({ testTimeout: 180_000 });

const g1 = GROUNDING_SCENARIOS.find((scenario) => scenario.id === "g1-rag-survey")!;

describe("Experiment 1 fault injection（真实三段核验）", () => {
  it("paperteam 臂：fabricated quote → quote mismatch；unsupported → judge 拒绝；metadata 冲突 → Stage 2 mismatch；正例全部转正", async () => {
    const result = await runExperiment1({ scenarios: [g1], log: () => {} });
    expect(result.issues).toEqual([]);
    const paperteam = result.arms.find((arm) => arm.arm === "paperteam")!;
    // g1：3 正例 + 3 故障（fabricated / unsupported / metadata）
    const dispositions = new Map(paperteam.outcomes.map((outcome) => [outcome.key, outcome.disposition]));
    expect(dispositions.get("ok-1")).toBe("accepted");
    expect(dispositions.get("ok-2")).toBe("accepted");
    expect(dispositions.get("ok-3")).toBe("accepted");
    expect(dispositions.get("g1-f1")).toBe("rejected_quote_mismatch");
    expect(dispositions.get("g1-f2")).toBe("rejected_judge");
    expect(dispositions.get("g1-f3")).toBe("rejected_metadata_mismatch");
    expect(paperteam.metrics.unsupportedClaimRate).toBe(0);
    expect(paperteam.metrics.fabricatedCitationRate).toBe(0);
    expect(paperteam.metrics.evidenceCoverage).toBe(1);
  });

  it("plain-llm 臂：零核验 → 全部入池（错误率 > 0）；rag 臂：检索条件化消除捏造引文但放行越界论断", async () => {
    const result = await runExperiment1({ scenarios: [g1], log: () => {} });
    const plain = result.arms.find((arm) => arm.arm === "plain-llm")!;
    const rag = result.arms.find((arm) => arm.arm === "rag")!;
    expect(plain.metrics.unsupportedClaimRate).toBeGreaterThan(0);
    expect(plain.metrics.fabricatedCitationRate).toBeGreaterThan(0);
    // g1 三条故障 claim 均可检索命中 → rag 的捏造引文被条件化消除
    expect(rag.metrics.fabricatedCitationRate).toBeLessThan(plain.metrics.fabricatedCitationRate);
    // 但越界论断照单全收（无 judge）
    expect(rag.metrics.unsupportedClaimRate).toBeGreaterThan(0);
  });
});

describe("Experiment 2 baseline 物化（scriptedRevision 同源故障）", () => {
  it("[fact:mutate]：公式常量被替换 + 无依据数值新增", () => {
    const accepted = materializeWriterFaultOutput("fact:mutate", baselineSectionContent(false));
    expect(accepted).toContain("\\beta");
    expect(accepted).toContain("12.4");
  });

  it("[cite:drop]：实验章节独有引用被删光", () => {
    const accepted = materializeWriterFaultOutput("cite:drop", baselineSectionContent(true));
    expect(extractCitationKeys(accepted)).not.toContain("lewis2020rag");
  });

  it("[strength:escalate]：追加无数字支撑的强表述", () => {
    const accepted = materializeWriterFaultOutput("strength:escalate", baselineSectionContent(false));
    expect(accepted).toContain("显著优于现有方法");
  });

  it("干净修订：引用保留、无注入痕迹", () => {
    const accepted = materializeWriterFaultOutput(null, baselineSectionContent(false));
    expect(extractCitationKeys(accepted)).toContain("gao2023survey");
    expect(accepted).not.toContain("12.4");
    expect(accepted).not.toContain("显著优于现有方法");
  });
});

describe("Experiment 2 paperteam：[cite:drop] 全链路拦截", () => {
  it("revision.validate 拦截 → HITL reject 恢复快照 → 复审 → 终稿引用完整", async () => {
    const harness = await createWorkflowHarness({ reviewSequence: ["fail", "pass"] });
    try {
      const project = await harness.store.create("cite-drop-e2e", {
        researchIdea: "[cite:drop] 检索增强生成的系统评估",
      });
      const run = await harness.orchestrator.createRun(project.id, "idea_to_paper", {});
      const driven = await driveRunToTerminal(harness, run.runId, { hitlPolicy: "reject", timeoutMs: 150_000 });
      expect(driven.timedOut).toBe(false);
      expect(driven.run.status).toBe("completed");

      const validations = await readRevisionValidations(harness.root, project.id);
      expect(validations.length).toBeGreaterThan(0);
      const reasonCodes = validations.flatMap((round) => round.reasonCodes);
      expect(reasonCodes).toContain("citation_removal_unauthorized");

      const snapshot = await readManuscriptSnapshot(harness.root, project.id);
      // reject 策略恢复快照：lewis2020rag 回到终稿
      expect(snapshot.citationKeys).toContain("lewis2020rag");
      expect(driven.hitlStages).toContain("hitl.revision_validation");
    } finally {
      await harness.cleanup();
    }
  });
});
