#!/usr/bin/env node
/**
 * M14.9.1 Review Neutrality A/B Harness 入口（先 cd backend && npm run build）。
 * 配置、语料与产物全部在仓库外：
 *   node scripts/m1491-review-neutrality.mjs --config D:/.../experiment-config.json --dry-run
 *   node scripts/m1491-review-neutrality.mjs --config ... --run
 *   node scripts/m1491-review-neutrality.mjs --config ... --compare
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repoRoot, "backend", "dist", "evaluation", "reviewNeutralityCli.js");
const { main } = await import(`file://${cli.replaceAll("\\", "/")}`);
await main(process.argv.slice(2));
