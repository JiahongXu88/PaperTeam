/**
 * M6.8 Evaluation 测试四：report generation（结构化 JSON + Markdown 摘要）。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { describe, expect, it } from "vitest";

import { buildEvaluationReport, renderMarkdownSummary, writeEvaluationReport } from "../../src/evaluation/runners/report.js";
import { runExperiment1 } from "../../src/evaluation/runners/experiment1.js";
import { GROUNDING_SCENARIOS } from "../../src/evaluation/datasets/index.js";
import { summarizeCalibration } from "../../src/evaluation/metrics/calibration.js";
import type { EvaluationReport } from "../../src/evaluation/types.js";

describe("M6.8 report generation", () => {
  it("合成输入：报告 schema 完整（runner 元数据 / 实验 / 校准）", () => {
    const report = buildEvaluationReport({
      calibration: summarizeCalibration([]),
      hitlPolicy: "reject",
      scenarioIds: { experiment1: [], experiment2: [], experiment3: [] },
    });
    expect(report.schemaVersion).toBe(1);
    expect(report.milestone).toBe("M6.8");
    expect(report.runner.mode).toBe("offline-scripted");
    expect(report.runner.hitlPolicy).toBe("reject");
    expect(report.experiments).toEqual([]);
    expect(report.calibration.agreementRate).toBeNull();
  });

  it("真实 Experiment 1 结果 → 报告含臂级 metrics / aggregate / comparison / limitations", async () => {
    const experiment1 = await runExperiment1({
      scenarios: [GROUNDING_SCENARIOS[0]!],
      log: () => {},
    });
    const report = buildEvaluationReport({
      experiment1,
      calibration: summarizeCalibration([]),
      hitlPolicy: "reject",
      scenarioIds: {
        experiment1: [GROUNDING_SCENARIOS[0]!.id],
        experiment2: [],
        experiment3: [],
      },
    });
    expect(report.experiments).toHaveLength(1);
    const first = report.experiments[0]!;
    if (first.experiment !== 1) {
      throw new Error("应包含 experiment 1");
    }
    expect(first.arms).toHaveLength(3);
    expect(Object.keys(first.aggregate)).toEqual(["plain-llm", "rag", "paperteam"]);
    expect(first.comparison["unsupportedClaimRate"]).toBeDefined();
    expect(first.limitations.length).toBeGreaterThan(0);
    // 可 JSON 序列化（结构化输出契约）
    expect(() => JSON.stringify(report)).not.toThrow();
  });

  it("Markdown 摘要：指标表 + 校准段", () => {
    const report: EvaluationReport = {
      schemaVersion: 1,
      milestone: "M6.8",
      generatedAt: "2026-09-18T00:00:00Z",
      runner: { mode: "offline-scripted", hitlPolicy: "reject", scenarios: { experiment1: ["g1"], experiment2: [], experiment3: [] } },
      experiments: [
        {
          experiment: 1,
          name: "evidence-grounding",
          arms: [],
          aggregate: {
            "plain-llm": { accepted: 6, unsupportedClaimRate: 0.33, fabricatedCitationRate: 0.33, evidenceCoverage: 1, dispositions: {} },
            rag: { accepted: 6, unsupportedClaimRate: 0.17, fabricatedCitationRate: 0, evidenceCoverage: 1, dispositions: {} },
            paperteam: { accepted: 3, unsupportedClaimRate: 0, fabricatedCitationRate: 0, evidenceCoverage: 1, dispositions: { accepted: 3, rejected_judge: 1 } },
          },
          comparison: {},
          limitations: ["synthetic"],
        },
      ],
      calibration: { records: 0, valid: 0, malformed: 0, agreementRate: null, perPrediction: [], parseErrors: [] },
    };
    const markdown = renderMarkdownSummary(report);
    expect(markdown).toContain("Experiment 1：evidence-grounding");
    expect(markdown).toContain("| plain-llm | 6 | 33.0% |");
    expect(markdown).toContain("Human Calibration");
    expect(markdown).toContain("n/a（无记录）");
  });

  it("落盘：JSON + Markdown 写入目标目录", async () => {
    const dir = await mkdtemp(join(tmpdir(), "paperteam-eval-report-"));
    try {
      const report = buildEvaluationReport({
        calibration: summarizeCalibration([]),
        hitlPolicy: "reject",
        scenarioIds: { experiment1: [], experiment2: [], experiment3: [] },
      });
      const written = await writeEvaluationReport(report, dir, "unit-eval");
      const json = JSON.parse(await readFile(written.jsonPath, "utf8")) as EvaluationReport;
      expect(json.milestone).toBe("M6.8");
      const markdown = await readFile(written.markdownPath, "utf8");
      expect(markdown).toContain("# M6.8 Evaluation Report Summary");
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});
