#!/usr/bin/env node
/**
 * M15.14 — HELD-OUT 顺序驱动：按 familyId 升序跑 10 族三臂（前 4 族 +a2np 消融）。
 * 每族独立进程（run-arms.mjs），失败续跑（已存在输出自动 skip）。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { readFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..", "..");
const ROOT = process.env.M1514_ROOT ?? "D:\\PaperTeamData\\M15\\M15_14";
const run = promisify(execFile);

const projectsInfo = JSON.parse(await readFile(join(ROOT, "phase-c", "projects.json"), "utf8"));
const primaries = projectsInfo.families
  .filter((f) => f.role === "PRIMARY")
  .map((f) => f.familyId)
  .sort();
console.log(`held-out order: ${primaries.join(" ")}`);

for (const [index, famId] of primaries.entries()) {
  const arms = index < 4 ? "a0,a1,a2,a2np" : "a0,a1,a2";
  console.log(`\n===== [${index + 1}/${primaries.length}] ${famId} arms=${arms} =====`);
  try {
    const { stdout, stderr } = await run("node", [join("scripts", "m1514", "run-arms.mjs"), "--fam", famId, "--arms", arms], {
      cwd: REPO,
      timeout: 30 * 60_000,
      maxBuffer: 16 * 1024 * 1024,
    });
    console.log(stdout.trim().split("\n").slice(-6).join("\n"));
    if (stderr.trim() !== "") console.log(`[stderr] ${stderr.trim().slice(0, 500)}`);
  } catch (error) {
    console.log(`[FAILED] ${famId}: ${String(error.message).slice(0, 500)}`);
    console.log(String(error.stdout ?? "").trim().split("\n").slice(-4).join("\n"));
  }
}
console.log("\nALL HELD-OUT ARMS DONE");
