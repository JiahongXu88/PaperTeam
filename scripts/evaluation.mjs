#!/usr/bin/env node
/**
 * M6.8 Evaluation Framework 入口（npm run evaluation）。
 *
 * 委托 backend/dist/evaluation/cli.js（需先 npm run build——与 benchmark-review
 * 同约定）。用法见 backend/src/evaluation/cli.ts 头注释。
 */

import { existsSync } from "node:fs";
import { resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cliEntry = resolve(repoRoot, "backend", "dist", "evaluation", "cli.js");

if (!existsSync(cliEntry)) {
  console.error("[evaluation] backend/dist/evaluation/cli.js 不存在：先在仓库根执行 npm run build");
  process.exit(1);
}

const { runEvaluationCli, listScenarioIds } = await import(`file:///${cliEntry.replaceAll("\\", "/")}`);

if (process.argv.includes("--list")) {
  console.log(listScenarioIds());
} else {
  await runEvaluationCli(process.argv.slice(2));
}
