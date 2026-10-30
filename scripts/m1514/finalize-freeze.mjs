#!/usr/bin/env node
/**
 * M15.14 — 协议冻结收尾：pools 聚合哈希 + 代码 SHA 回填 + PROTOCOL_FROZEN.sha256。
 * 前置：13 个 pool 全部由当前代码构建（q-04 若为旧代际需先重建）。
 * 用法：node scripts/m1514/finalize-freeze.mjs
 */
import { readFile, writeFile, readdir } from "node:fs/promises";
import { createHash } from "node:crypto";
import { execFileSync } from "node:child_process";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.M1514_ROOT ? resolve(process.env.M1514_ROOT) : resolve("D:\\PaperTeamData\\M15\\M15_14");
const REPO = resolve(here, "..", "..");

const files = (await readdir(join(ROOT, "phase-c", "pools"), { withFileTypes: true }))
  .filter((e) => e.isFile() && e.name.startsWith("fam-") && e.name.endsWith(".json"))
  .map((e) => e.name)
  .sort();
if (files.length !== 13) throw new Error(`pool 数量 ${files.length} ≠ 13`);

const rows = [];
for (const name of files) {
  const content = await readFile(join(ROOT, "phase-c", "pools", name), "utf8");
  rows.push(`${name}:${createHash("sha256").update(content).digest("hex").slice(0, 16)}`);
}
const poolsSha = createHash("sha256").update(rows.join("\n")).digest("hex");
const projectsSha = createHash("sha256").update(await readFile(join(ROOT, "phase-c", "projects.json"), "utf8")).digest("hex");
const frameSha = createHash("sha256").update(await readFile(join(ROOT, "phase-b", "candidate-frame.json"), "utf8")).digest("hex");
const codeSha = execFileSync("git", ["rev-parse", "HEAD"], { cwd: REPO }).toString().trim();

// 汇总 pool 统计
const stats = [];
for (const name of files) {
  const pool = JSON.parse(await readFile(join(ROOT, "phase-c", "pools", name), "utf8"));
  const bs = pool.buildStats;
  stats.push(`${pool.familyId}: pool=${pool.candidates.length} abstract=${bs.contentLevels.abstract} metadata=${bs.contentLevels.metadata} resolved=${bs.refResolved}/${bs.referenceEntriesEligible}`);
}
const totalAbstract = stats.length > 0 ? stats.reduce((a, s) => a + Number(/abstract=(\d+)/.exec(s)[1]), 0) : 0;
const totalCand = stats.reduce((a, s) => a + Number(/pool=(\d+)/.exec(s)[1]), 0);

// 回填协议 §9
const protocolPath = join(ROOT, "phase-b", "PROTOCOL_FROZEN.md");
let protocol = await readFile(protocolPath, "utf8");
protocol = protocol.replace(
  /- 候选框：phase-b\/candidate-frame\.json sha256=[0-9a-f]+/,
  `- 候选框：phase-b/candidate-frame.json sha256=${frameSha}`,
);
protocol = protocol.replace(
  /- 代码：`<commit SHA — 提交后回填>`/,
  `- 代码：\`${codeSha}\`（main）`,
);
protocol = protocol.replace(
  /- pools：phase-c\/pools\/\*\.json 聚合 sha256=`<回填>`/,
  `- pools：phase-c/pools/*.json 聚合 sha256=\`${poolsSha}\`（13 文件逐件短哈希链）；projects.json sha256=${projectsSha.slice(0, 16)}`,
);
await writeFile(protocolPath, protocol, "utf8");
const protocolSha = createHash("sha256").update(protocol).digest("hex");
await writeFile(join(ROOT, "phase-b", "PROTOCOL_FROZEN.sha256"), `${protocolSha}  PROTOCOL_FROZEN.md\n`, "utf8");

console.log(JSON.stringify({
  frozenAt: new Date().toISOString(),
  codeSha,
  poolsSha,
  protocolSha,
  poolStats: stats,
  totals: { candidates: totalCand, abstractLevel: totalAbstract },
}, null, 1));
