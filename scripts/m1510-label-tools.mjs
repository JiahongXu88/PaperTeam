#!/usr/bin/env node
/**
 * M15.10 标签工具 CLI：validate（校验回传 CSV）/ freeze（冻结为盲测真值工件）。
 *
 * 校验规则 V1-V10 与冻结语义见 backend/src/target/expertLabels.ts 头注与
 * D:\PaperTeamData\M15\M15_10\phase-b\LABEL_IMPORT_GUIDE.md。确定性、零模型。
 *
 * 用法：
 *   node scripts/m1510-label-tools.mjs validate --labels <csv>... --manifest <sample-manifest.json> [--schema <labels_schema.json>]
 *   node scripts/m1510-label-tools.mjs freeze --labels <csv>... --manifest <...> --out <frozen-labels.json>
 *
 *   --labels 可重复（多文件按 reviewer 合并）；--out 缺省打印冻结产物（不写盘）。
 */

import { readFileSync, writeFileSync } from "node:fs";
import {
  EXPERT_LABEL_SCHEMA_VERSION,
  freezeLabels,
  parseLabelsCsv,
  validateLabels,
} from "../backend/src/target/expertLabels.ts";

const args = process.argv.slice(2);
const command = args[0];
const valueAfter = (flag) => {
  const i = args.indexOf(`--${flag}`);
  return i >= 0 && typeof args[i + 1] === "string" && !args[i + 1]?.startsWith("--")
    ? args[i + 1]
    : undefined;
};
const valuesOf = (flag) => {
  const inline = args.filter((a) => a.startsWith(`--${flag}=`)).map((a) => a.slice(flag.length + 3));
  const spaced = [];
  for (let i = 0; i < args.length; i += 1) {
    if (args[i] === `--${flag}` && typeof args[i + 1] === "string" && !(args[i + 1] ?? "").startsWith("--")) {
      spaced.push(args[i + 1]);
      i += 1;
    }
  }
  return [...inline, ...spaced];
};
const valueOf = (flag) => valuesOf(flag)[0] ?? valueAfter(flag);

function usage() {
  console.error("用法见文件头注（validate | freeze；--labels 可重复；--manifest 必填）");
  process.exit(2);
}

function loadInputs() {
  const labelPaths = valuesOf("labels");
  const manifestPath = valueOf("manifest");
  if (labelPaths.length === 0 || !manifestPath) usage();
  const manifest = JSON.parse(readFileSync(manifestPath, "utf8"));
  const rows = [];
  for (const path of labelPaths) {
    const parsed = parseLabelsCsv(readFileSync(path, "utf8"));
    if (parsed.findings.length > 0) {
      for (const f of parsed.findings) console.error(`[parse:${path}] ${f.severity} ${f.message}`);
      process.exit(1);
    }
    rows.push(...parsed.rows);
  }
  return { rows, manifest };
}

if (command === "validate") {
  const { rows, manifest } = loadInputs();
  const report = validateLabels(rows, manifest);
  console.log(JSON.stringify(report, null, 1));
  process.exit(report.ok ? 0 : 1);
} else if (command === "freeze") {
  const { rows, manifest } = loadInputs();
  const out = valueOf("out");
  const frozenAt = new Date().toISOString();
  const { error, frozen } = freezeLabels(rows, manifest, { frozenAt });
  if (error || !frozen) {
    console.error(`[freeze] 拒绝：${error}`);
    process.exit(1);
  }
  if (out) {
    writeFileSync(out, JSON.stringify(frozen, null, 1), "utf8");
    console.log(
      `[freeze] ${EXPERT_LABEL_SCHEMA_VERSION} → ${out}（rows=${frozen.sourceRows}，blindTestTriggered=${frozen.blindTestTriggered}，totalSha256=${frozen.totalSha256.slice(0, 16)}…）`,
    );
  } else {
    console.log(JSON.stringify(frozen, null, 1));
  }
} else {
  usage();
}
