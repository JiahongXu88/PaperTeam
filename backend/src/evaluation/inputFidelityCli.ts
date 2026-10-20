/**
 * M14.9.3 输入保真门 CLI（零模型）：源证据 JSON × 投影 Markdown × 删除清单 → 保真报告。
 *
 *   node scripts/m1493-input-fidelity.mjs --source <x.source.json> --projection <x.md> --deletions <x.deletions.json> [--out <report.json>]
 *     [--manuscript <main.tex>] [--attestation-template <qa.template.json>] [--attestation <qa.json>]
 *
 * 源证据（paperteam.input-fidelity.source/v1）必须由独立于转写器的抽取器生成；语料与报告留在仓库外。
 * M14.9.5：--attestation-template 输出待人工逐条核对的清单（含源 / 投影 / 稿件哈希，结论留空，本身不构成证明）；
 * --attestation 校验已填写的人工 QA 证明（哈希绑定、逐条覆盖、原文定位），退出码按证明后的有效状态计算。
 * 退出码：0 = VALID_FOR_SCORING；2 = REQUIRES_HUMAN_QA；3 = INVALID_INPUT / SOURCE_INCOMPLETE（fail-closed）。
 */

import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";

import { evaluateInputFidelity, type DeletionEntry, type SourceEvidence } from "../review/inputFidelity.js";
import { attestationTemplate, checkInputQaAttestation } from "../review/inputFidelityAttestation.js";

function option(args: readonly string[], name: string): string | undefined {
  const at = args.indexOf(name);
  return at >= 0 ? args[at + 1] : undefined;
}

export function main(args: readonly string[]): number {
  const sourcePath = option(args, "--source");
  const projectionPath = option(args, "--projection");
  const deletionsPath = option(args, "--deletions");
  if (sourcePath === undefined || projectionPath === undefined) {
    console.error("用法：--source <x.source.json> --projection <x.md> [--deletions <x.deletions.json>] [--out <report.json>] [--manuscript <main.tex>] [--attestation-template <out.json>] [--attestation <qa.json>]");
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
  const manuscriptPath = option(args, "--manuscript");
  const manuscriptSha256 = manuscriptPath === undefined ? undefined : createHash("sha256").update(readFileSync(manuscriptPath)).digest("hex");
  const templatePath = option(args, "--attestation-template");
  if (templatePath !== undefined) {
    writeFileSync(templatePath, JSON.stringify(attestationTemplate(report, manuscriptSha256), null, 1) + "\n", "utf8");
    console.log(`人工 QA 待核对清单已写出（${report.findings.filter((finding) => finding.severity === "soft").length} 条；结论留空，本身不构成证明）：${templatePath}`);
  }
  let effective = report.status;
  const attestationPath = option(args, "--attestation");
  if (attestationPath !== undefined) {
    const check = checkInputQaAttestation(report, JSON.parse(readFileSync(attestationPath, "utf8")) as unknown, manuscriptSha256 !== undefined ? { manuscriptSha256, requireManuscriptBinding: true } : {});
    effective = check.effectiveStatus;
    console.log(`人工 QA 证明：${check.verdict} → 有效状态 ${check.effectiveStatus}（覆盖 ${check.coveredFindings}/${check.requiredFindings}）${check.reasons.length > 0 ? `：${check.reasons.join("；")}` : ""}`);
  }
  return effective === "VALID_FOR_SCORING" ? 0 : effective === "REQUIRES_HUMAN_QA" ? 2 : 3;
}
