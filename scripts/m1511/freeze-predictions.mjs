#!/usr/bin/env node
/**
 * M15.11 — freeze HELD-OUT predictions (must run BEFORE any sequester opening /
 * reference-issue extraction / judge work).
 * Output: phase-c/predictions-frozen.json with per-family SHA256 of c0.json/c1.json.
 */
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.M1511_ROOT ? resolve(process.env.M1511_ROOT) : resolve(here, ".."); // data root (env-overridable)
const manifest = JSON.parse(await readFile(join(ROOT, "phase-b", "SAMPLE_MANIFEST.json"), "utf8"));
const heldOut = manifest.families.filter((f) => f.role === "HELD-OUT" && f.familyId).slice(0, 12);

const sha = async (p) => createHash("sha256").update(await readFile(p)).digest("hex");
const record = { frozenAt: new Date().toISOString(), families: [] };
for (const fam of heldOut) {
  const entry = { familyId: fam.familyId };
  for (const arm of ["c0", "c1"]) {
    const p = join(ROOT, "phase-c", "out", fam.familyId, `${arm}.json`);
    try { entry[arm] = await sha(p); } catch { entry[arm] = null; }
  }
  record.families.push(entry);
}
await writeFile(join(ROOT, "phase-c", "predictions-frozen.json"), JSON.stringify(record, null, 1), "utf8");
console.log(JSON.stringify({ frozenAt: record.frozenAt, families: record.families.length, missing: record.families.filter((f) => !f.c0 || !f.c1).map((f) => f.familyId) }, null, 1));
