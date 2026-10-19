/**
 * M14.9.3 输入保真门 CLI（零模型）：源证据 JSON × 投影 Markdown × 删除清单 → 保真报告。
 *
 *   node scripts/m1493-input-fidelity.mjs --source <x.source.json> --projection <x.md> --deletions <x.deletions.json> [--out <report.json>]
 *
 * 源证据（paperteam.input-fidelity.source/v1）必须由独立于转写器的抽取器生成；语料与报告留在仓库外。
 * 退出码：0 = VALID_FOR_SCORING；2 = REQUIRES_HUMAN_QA；3 = INVALID_INPUT / SOURCE_INCOMPLETE（fail-closed）。
 */

import { readFileSync, writeFileSync } from "node:fs";

import { evaluateInputFidelity, type DeletionEntry, type SourceEvidence } from "../review/inputFidelity.js";

function option(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

export function main(args: readonly string[]): number {
  const sourcePath = option(args, "--source");
  const projectionPath = option(args, "--projection");
  const deletionsPath = option(args, "--deletions");
  if (sourcePath === undefined || projectionPath === undefined) {
    console.error("用法：--source <x.source.json> --projection <x.md> [--deletions <x.deletions.json>] [--out <report.json>]");
    return 64;
  }
  const source = JSON.parse(readFileSync(sourcePath, "utf8")) as SourceEvidence;
  if (source.schema !== "paperteam.input-fidelity.source/v1") {
    console.error(`源证据 schema 不符：${String(source.schema)}`);
    return 65;
  }
  const deletions = deletionsPath === undefined ? [] : (JSON.parse(readFileSync(deletionsPath, "utf8")) as DeletionEntry[]);
  const report = evaluateInputFidelity(source, { text: readFileSync(projectionPath, "utf8"), deletions });
  const out = option(args, "--out");
  if (out !== undefined) writeFileSync(out, JSON.stringify(report, null, 1) + "\n", "utf8");
  console.log(`${report.status} (legacy ${report.legacyStatus}) coverage=${report.metrics.coverageRatio} ${report.reasons.join(" ")}`);
  return report.status === "VALID_FOR_SCORING" ? 0 : report.status === "REQUIRES_HUMAN_QA" ? 2 : 3;
}
