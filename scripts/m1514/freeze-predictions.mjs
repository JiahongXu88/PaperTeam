#!/usr/bin/env node
/**
 * M15.14 Phase E0 — 预测冻结（HELD-OUT 族三臂 a0/a1/a2 全部存在后 SHA256 冻结）。
 * 冻结之后才允许解封 sequester 评审（extract-issues 的硬前置）。
 * 用法：node scripts/m1514/freeze-predictions.mjs
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.M1514_ROOT ? resolve(process.env.M1514_ROOT) : resolve("D:\\PaperTeamData\\M15\\M15_14");

const projectsInfo = JSON.parse(await readFile(join(ROOT, "phase-c", "projects.json"), "utf8"));
const heldOut = projectsInfo.families.filter((f) => f.role === "PRIMARY");
const ARMS = ["a0", "a1", "a2"];

const records = [];
const missing = [];
for (const fam of heldOut) {
  for (const arm of ARMS) {
    const p = join(ROOT, "phase-d", "out", fam.familyId, `${arm}.json`);
    if (!existsSync(p)) {
      missing.push(`${fam.familyId}/${arm}`);
      continue;
    }
    const content = await readFile(p, "utf8");
    records.push({
      familyId: fam.familyId,
      arm,
      sha256: createHash("sha256").update(content).digest("hex"),
      bytes: Buffer.byteLength(content),
    });
  }
}
const frozen = {
  frozenAt: new Date().toISOString(),
  arms: ARMS,
  families: heldOut.map((f) => f.familyId),
  records,
  missing,
};
await writeFile(join(ROOT, "phase-e", "predictions-frozen.json"), JSON.stringify(frozen, null, 1), "utf8");
console.log(JSON.stringify({ frozenAt: frozen.frozenAt, families: frozen.families.length, records: records.length, missing }, null, 1));
if (missing.length > 0) process.exit(2);
