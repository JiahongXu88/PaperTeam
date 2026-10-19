#!/usr/bin/env node
/**
 * M14.9.3 输入保真门 CLI 入口（先 cd backend && npm run build）。语料、源证据与报告全部在仓库外：
 *   node scripts/m1493-input-fidelity.mjs --source D:/.../P005.source.json --projection D:/.../P005.md --deletions D:/.../P005.deletions.json --out D:/.../P005.fidelity.json
 */
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "..");
const cli = join(repoRoot, "backend", "dist", "evaluation", "inputFidelityCli.js");
const { main } = await import(`file://${cli.replaceAll("\\", "/")}`);
process.exitCode = main(process.argv.slice(2));
