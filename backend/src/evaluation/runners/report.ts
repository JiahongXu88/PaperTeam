/**
 * 报告生成（M6.8）：EvaluationReport 组装 + JSON / Markdown 落盘。
 *
 * JSON 是结构化事实源（schema 见 types.ts EvaluationReport）；
 * Markdown 是人读摘要（指标表 + 拦截明细 + limitations）。
 * 报告产物不修改任何项目数据——评估只读系统、只写自己的 reports 目录。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { EvaluationReport } from "../types.js";
import type { Experiment1Result } from "./experiment1.js";
import type { Experiment2Result } from "./experiment2.js";
import type { Experiment3Result } from "./experiment3.js";
import type { CalibrationSummary } from "../types.js";

export interface ReportInputs {
  experiment1?: Experiment1Result;
  experiment2?: Experiment2Result;
  experiment3?: Experiment3Result;
  calibration: CalibrationSummary;
  hitlPolicy: string;
  scenarioIds: { experiment1: string[]; experiment2: string[]; experiment3: string[] };
}

export function buildEvaluationReport(inputs: ReportInputs): EvaluationReport {
  const experiments: EvaluationReport["experiments"] = [];
  if (inputs.experiment1 !== undefined) {
    experiments.push({
      experiment: 1,
      name: "evidence-grounding",
      arms: inputs.experiment1.arms,
      aggregate: inputs.experiment1.aggregate,
      comparison: { ...inputs.experiment1.comparison, issues: inputs.experiment1.issues },
      limitations: inputs.experiment1.limitations,
    });
  }
  if (inputs.experiment2 !== undefined) {
    experiments.push({
      experiment: 2,
      name: "revision-safety",
      arms: inputs.experiment2.arms,
      aggregate: inputs.experiment2.aggregate,
      comparison: inputs.experiment2.comparison,
      limitations: inputs.experiment2.limitations,
    });
  }
  if (inputs.experiment3 !== undefined) {
    experiments.push({
      experiment: 3,
      name: "agent-workflow",
      arms: inputs.experiment3.arms,
      aggregate: inputs.experiment3.aggregate,
      comparison: inputs.experiment3.comparison,
      limitations: inputs.experiment3.limitations,
    });
  }
  return {
    schemaVersion: 1,
    milestone: "M6.8",
    generatedAt: new Date().toISOString(),
    runner: {
      mode: "offline-scripted",
      hitlPolicy: inputs.hitlPolicy as EvaluationReport["runner"]["hitlPolicy"],
      scenarios: inputs.scenarioIds,
    },
    experiments,
    calibration: inputs.calibration,
  };
}

const pct = (value: number | null | undefined) =>
  value === null || value === undefined ? "n/a" : `${(value * 100).toFixed(1)}%`;

export function renderMarkdownSummary(report: EvaluationReport): string {
  const lines: string[] = [
    "# M6.8 Evaluation Report Summary",
    "",
    `- generatedAt: ${report.generatedAt}`,
    `- runner: ${report.runner.mode}（hitlPolicy=${report.runner.hitlPolicy}）`,
    "",
  ];
  for (const experiment of report.experiments) {
    lines.push(`## Experiment ${experiment.experiment}：${experiment.name}`, "");
    if (experiment.experiment === 1) {
      lines.push("| arm | accepted | unsupportedClaimRate | fabricatedCitationRate | evidenceCoverage |", "|---|---|---|---|---|");
      for (const [arm, metrics] of Object.entries(experiment.aggregate)) {
        lines.push(
          `| ${arm} | ${metrics.accepted} | ${pct(metrics.unsupportedClaimRate)} | ${pct(metrics.fabricatedCitationRate)} | ${pct(metrics.evidenceCoverage)} |`,
        );
      }
      const issues = (experiment.comparison["issues"] as string[] | undefined) ?? [];
      if (issues.length > 0) {
        lines.push("", `> ⚠ ground truth 一致性问题 ${issues.length} 条（见 JSON issues）`);
      }
    } else if (experiment.experiment === 2) {
      const { baseline, paperteam } = experiment.aggregate;
      lines.push(
        "| metric | baseline | paperteam |",
        "|---|---|---|",
        `| factViolationRate | ${pct(baseline.factViolationRate)} | ${pct(paperteam.factViolationRate)} |`,
        `| citationLossRate | ${pct(baseline.citationLossRate)} | ${pct(paperteam.citationLossRate)} |`,
        `| claimEscalationRate | ${pct(baseline.claimEscalationRate)} | ${pct(paperteam.claimEscalationRate)} |`,
        `| falseAcceptanceRate | ${pct(baseline.falseAcceptanceRate)} | ${pct(paperteam.falseAcceptanceRate)} |`,
        `| falseRejectionRate | ${pct(baseline.falseRejectionRate)} | ${pct(paperteam.falseRejectionRate)} |`,
      );
      const paperteamRecords = experiment.arms.find((arm) => arm.arm === "paperteam")?.records ?? [];
      lines.push("", "### paperteam 臂逐场景", "");
      lines.push("| scenario | run | flagged | 渠道 |", "|---|---|---|---|");
      for (const record of paperteamRecords) {
        lines.push(
          `| ${record.scenarioId} | ${record.runOutcome?.status ?? "-"}${record.runOutcome?.label ? `/${record.runOutcome.label}` : ""} | ${record.flagged ? "✓" : "✗"} | ${record.flagChannels.join("; ") || "-"} |`,
        );
      }
    } else {
      lines.push("| arm | claimCorrectness | citationCorrectness | completeness | humanPreference |", "|---|---|---|---|---|");
      for (const [arm, metrics] of Object.entries(experiment.aggregate)) {
        lines.push(
          `| ${arm} | ${pct(metrics.claimCorrectness)} | ${pct(metrics.citationCorrectness)} | ${pct(metrics.completeness)} | ${metrics.humanPreference === null ? "null" : pct(metrics.humanPreference)} |`,
        );
      }
    }
    lines.push("", "**Limitations**:", "");
    for (const limitation of experiment.limitations) {
      lines.push(`- ${limitation}`);
    }
    lines.push("");
  }
  lines.push(
    "## Human Calibration",
    "",
    `- 记录：${report.calibration.records}（valid ${report.calibration.valid} / malformed ${report.calibration.malformed}）`,
    `- 自动指标 vs 人工标注一致率：${report.calibration.agreementRate === null ? "n/a（无记录）" : pct(report.calibration.agreementRate)}`,
    "",
  );
  return lines.join("\n");
}

export interface WrittenReport {
  jsonPath: string;
  markdownPath: string;
}

export async function writeEvaluationReport(
  report: EvaluationReport,
  outDir: string,
  baseName: string,
): Promise<WrittenReport> {
  await mkdir(outDir, { recursive: true });
  const stamp = new Date().toISOString().replaceAll(/[:.]/g, "-");
  const jsonPath = join(outDir, `${baseName}-${stamp}.json`);
  const markdownPath = join(outDir, `${baseName}-${stamp}.md`);
  await writeFile(jsonPath, `${JSON.stringify(report, null, 2)}\n`, "utf8");
  await writeFile(markdownPath, renderMarkdownSummary(report), "utf8");
  return { jsonPath, markdownPath };
}
