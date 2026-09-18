/**
 * M6.8 Evaluation 测试五：baseline comparison（两臂对照结论成立）。
 *
 * - Experiment 1（g1 + g6）：plain-llm → rag → paperteam 的错误率单调下降
 *   （fabricated：plain > rag ≥ paperteam=0；unsupported：plain = rag > paperteam=0）；
 * - Experiment 2（r4 干净 + r3 强度升级）：baseline 零信号全放行 vs
 *   paperteam 拦截注入且不误拦干净修订。
 */

import { describe, expect, it, vi } from "vitest";

import { GROUNDING_SCENARIOS, REVISION_SCENARIOS } from "../../src/evaluation/datasets/index.js";
import { runExperiment1 } from "../../src/evaluation/runners/experiment1.js";
import { runExperiment2 } from "../../src/evaluation/runners/experiment2.js";

vi.setConfig({ testTimeout: 240_000 });

describe("Experiment 1 baseline comparison（A/B/C 三臂）", () => {
  it("错误率单调下降、coverage 不受损", async () => {
    const scenarios = GROUNDING_SCENARIOS.filter((scenario) =>
      ["g1-rag-survey", "g6-sentiment-zh"].includes(scenario.id),
    );
    const result = await runExperiment1({ scenarios, log: () => {} });
    expect(result.issues).toEqual([]);
    const { "plain-llm": plain, rag, paperteam } = result.aggregate;
    // 捏造引文：plain（无约束）> rag（检索条件化，g1/g6 均可命中）≥ paperteam=0
    expect(plain!.fabricatedCitationRate).toBeGreaterThan(rag!.fabricatedCitationRate);
    expect(rag!.fabricatedCitationRate).toBeGreaterThanOrEqual(paperteam!.fabricatedCitationRate);
    expect(paperteam!.fabricatedCitationRate).toBe(0);
    // 越界论断：plain = rag（都不核语义）> paperteam=0（judge 拒绝）
    expect(plain!.unsupportedClaimRate).toBeGreaterThan(0);
    expect(rag!.unsupportedClaimRate).toBeGreaterThan(0);
    expect(paperteam!.unsupportedClaimRate).toBe(0);
    // 拦截没有以牺牲正例召回为代价
    expect(paperteam!.evidenceCoverage).toBe(1);
    expect(plain!.evidenceCoverage).toBe(1);
  });
});

describe("Experiment 2 baseline comparison（Reviewer→Writer vs PaperTeam 闭环）", () => {
  it("baseline：注入违规零信号全放行（falseAcceptance=1）；paperteam：拦截注入、不误拦干净修订", async () => {
    const scenarios = REVISION_SCENARIOS.filter((scenario) =>
      ["r4-clean-fail-pass", "r3-strength-escalate"].includes(scenario.id),
    );
    const result = await runExperiment2({ scenarios, hitlPolicy: "reject", log: () => {} });
    const baseline = result.aggregate.baseline;
    const paperteam = result.aggregate.paperteam;
    const paperteamArm = result.arms.find((arm) => arm.arm === "paperteam")!;

    // baseline：强度升级存活且无任何系统信号
    expect(baseline.claimEscalationRate).toBe(1);
    expect(baseline.falseAcceptanceRate).toBe(1);

    // paperteam：升级被拦（reject 策略恢复快照 → 终稿无升级句）、有信号
    expect(paperteam.claimEscalationRate).toBe(0);
    expect(paperteam.falseAcceptanceRate).toBe(0);
    expect(paperteam.falseRejectionRate).toBe(0);

    const clean = paperteamArm.records.find((record) => record.scenarioId === "r4-clean-fail-pass")!;
    expect(clean.flagged).toBe(false);
    expect(clean.runOutcome?.label).toBe("final");

    const escalate = paperteamArm.records.find((record) => record.scenarioId === "r3-strength-escalate")!;
    expect(escalate.flagged).toBe(true);
    expect(escalate.flagChannels.join("\n")).toContain("claim_strength");
  });
});
