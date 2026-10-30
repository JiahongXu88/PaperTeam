#!/usr/bin/env node
/**
 * M15.14 — typing 冻结助手：raw judge 判定 + investigator 纠错 → frozen 文件。
 * 纠错以 phase-e/typing-corrections.json 为输入（数组：{familyId, a, taxonomy?,
 * serious?, meta?, reason}）；无纠错文件则原样冻结。零模型。
 * 用法：node scripts/m1514/freeze-typing.mjs
 */
import { readFile, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { createHash } from "node:crypto";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const ROOT = process.env.M1514_ROOT ? resolve(process.env.M1514_ROOT) : resolve("D:\\PaperTeamData\\M15\\M15_14");

const rawPath = join(ROOT, "phase-e", "issue-typing-raw.jsonl");
if (!existsSync(rawPath)) throw new Error("issue-typing-raw.jsonl 不存在");
const byFam = new Map();
for (const line of (await readFile(rawPath, "utf8")).split("\n")) {
  if (line.trim() === "") continue;
  const r = JSON.parse(line);
  byFam.set(r.familyId, r);
}
const correctionsPath = join(ROOT, "phase-e", "typing-corrections.json");
const corrections = existsSync(correctionsPath) ? JSON.parse(await readFile(correctionsPath, "utf8")) : [];
const projectsInfo = JSON.parse(await readFile(join(ROOT, "phase-c", "projects.json"), "utf8"));
const formalFams = new Set(projectsInfo.families.filter((f) => f.role === "PRIMARY").map((f) => f.familyId));

const issueFamilies = JSON.parse(await readFile(join(ROOT, "phase-e", "issue-families.json"), "utf8"));
const issueFamiliesByFam = new Map();
for (const g of issueFamilies) {
  if (!issueFamiliesByFam.has(g.familyId)) issueFamiliesByFam.set(g.familyId, []);
  issueFamiliesByFam.get(g.familyId).push(g);
}

let correctionsApplied = 0;
const outRows = [];
for (const [famId, raw] of byFam) {
  const issues = issueFamiliesByFam.get(famId) ?? [];
  const types = [];
  for (let i = 0; i < issues.length; i += 1) {
    const judged = raw.types?.find((t) => t.a === i + 1) ?? null;
    const row = {
      issueFamily: issues[i].issueFamily,
      familyId: famId,
      taxonomy: judged?.taxonomy ?? "untyped",
      serious: judged?.serious ?? false,
      meta: judged?.meta ?? false,
      rationale: judged?.rationale ?? null,
    };
    // investigator 纠错（覆盖 judge 判定）
    const fix = corrections.find((c) => c.familyId === famId && c.a === i + 1);
    if (fix !== undefined) {
      if (fix.taxonomy !== undefined) row.taxonomy = fix.taxonomy;
      if (fix.serious !== undefined) row.serious = fix.serious;
      if (fix.meta !== undefined) row.meta = fix.meta;
      row.investigatorCorrected = true;
      row.correctionReason = fix.reason ?? null;
      correctionsApplied += 1;
    }
    types.push(row);
  }
  outRows.push({ familyId: famId, formal: formalFams.has(famId), issueCount: issues.length, types });
}
const frozen = {
  frozenAt: new Date().toISOString(),
  correctionsApplied,
  issueFamilies: outRows.filter((r) => r.formal).flatMap((r) => r.types),
  allFamilies: outRows,
};
const outPath = join(ROOT, "phase-e", "issue-typing-frozen.json");
await writeFile(outPath, JSON.stringify(frozen, null, 1), "utf8");
const sha = createHash("sha256").update(JSON.stringify(frozen)).digest("hex");
console.log(JSON.stringify({ frozenAt: frozen.frozenAt, correctionsApplied, formalIssueFamilies: frozen.issueFamilies.length, sha256: sha }, null, 1));
