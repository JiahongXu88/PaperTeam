#!/usr/bin/env node
/**
 * M15.12 Phase C — 样本清单构建 + 预测哈希冻结。
 *
 * build-sample-manifest: cand-21..32（确定性规则：未跑 HELD-OUT 优先 + RESERVE 升序）
 *   + cand-33/34 备用；登记 PDF SHA256、来源（M15_11 manuscripts/sequester 原位引用，
 *   不复制）、版本对齐证据（invSuffixes）。
 * freeze-predictions: 四臂输出（c0/c0plus/c1opt/c2）全族 SHA256 冻结 →
 *   phase-e/predictions-frozen.json（开封评审前的盲态证据）。
 */
import { createHash } from "node:crypto";
import { readFile, writeFile, mkdir, readdir } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve, dirname } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const REPO = resolve(here, "..", "..");
const ROOT = process.env.M1512_ROOT ? resolve(process.env.M1512_ROOT) : resolve("D:\\PaperTeamData\\M15\\M15_12");
const M1511_ROOT = process.env.M1511_ROOT ?? "D:\\PaperTeamData\\M15\\M15_11";

const sha256 = async (path) => {
  const buffer = await readFile(path);
  return createHash("sha256").update(buffer).digest("hex");
};

const mode = process.argv[2] ?? "";

if (mode === "build-sample-manifest") {
  const m1511Manifest = JSON.parse(await readFile(join(M1511_ROOT, "phase-b", "SAMPLE_MANIFEST.json"), "utf8"));
  const candidateList = JSON.parse(await readFile(join(M1511_ROOT, "phase-b", "candidate-list.json"), "utf8"));
  const byId = new Map(m1511Manifest.families.map((f) => [f.familyId, f]));
  const candById = new Map(candidateList.candidates.map((c) => [c.candidateId, c]));
  // 确定性规则：4 个未跑 HELD-OUT（cand-21..24）+ RESERVE 升序补足至 12（cand-25..32）；
  // cand-33/34 = SPARE。cand-02..08（M15.11 未跑 DEV）不入正式样本（保守角色隔离）。
  const formal = [];
  for (let n = 21; n <= 32; n += 1) formal.push(`fam-cand-${String(n).padStart(2, "0")}`);
  const spare = ["fam-cand-33", "fam-cand-34"];
  const families = [];
  for (const familyId of [...formal, ...spare]) {
    const fam = byId.get(familyId);
    const cand = candById.get(familyId.replace("fam-", ""));
    if (fam === undefined || cand === undefined) throw new Error(`${familyId} 不在 M15.11 候选清单`);
    const pdfPath = join(M1511_ROOT, "manuscripts", `${familyId}.pdf`);
    if (!existsSync(pdfPath)) throw new Error(`${familyId} PDF 缺失`);
    families.push({
      familyId,
      role: formal.includes(familyId) ? "HELD-OUT-NEW" : "SPARE",
      m1511Role: fam.role,
      title: fam.title,
      primaryArea: fam.primaryArea,
      pdfPath,
      manuscriptPdfSha256: await sha256(pdfPath),
      sequesterRepliesPath: join(M1511_ROOT, "sequester", familyId, "replies.json"),
      repliesJsonSha256: fam.repliesJsonSha256,
      officialReviewCount: fam.officialReviewCount,
      substantiveReviewCount: fam.substantiveReviewCount,
      versionAlignment: { invSuffixes: cand.invSuffixes, rule: "no Revision/Camera_Ready invitations => current PDF = reviewed version" },
    });
  }
  const manifest = {
    generatedAt: new Date().toISOString(),
    selectionRule: "M15.11 unrun HELD-OUT (cand-21..24) first, then RESERVE ascending (cand-25..32) to 12 formal families; cand-33/34 spare; cand-02..08 (unrun M15.11 DEV) excluded from formal sample by conservative role isolation",
    dataRoot: ROOT,
    families,
  };
  await mkdir(join(ROOT, "phase-c"), { recursive: true });
  const out = join(ROOT, "phase-c", "sample-manifest.json");
  await writeFile(out, JSON.stringify(manifest, null, 1), "utf8");
  console.log(`sample manifest: ${families.filter((f) => f.role === "HELD-OUT-NEW").length} formal + ${families.filter((f) => f.role === "SPARE").length} spare -> ${out}`);
  process.exit(0);
}

if (mode === "freeze-predictions") {
  const manifest = JSON.parse(await readFile(join(ROOT, "phase-c", "sample-manifest.json"), "utf8"));
  const outDir = join(ROOT, "phase-d", "out");
  const families = [];
  const missing = [];
  for (const fam of manifest.families.filter((f) => f.role === "HELD-OUT-NEW")) {
    const entry = { familyId: fam.familyId };
    for (const arm of ["c0", "c0plus", "c1opt", "c2"]) {
      const p = join(outDir, fam.familyId, `${arm}.json`);
      if (!existsSync(p)) {
        missing.push(`${fam.familyId}/${arm}`);
      } else {
        entry[arm] = await sha256(p);
      }
    }
    families.push(entry);
  }
  const frozen = { frozenAt: new Date().toISOString(), families, missing };
  await mkdir(join(ROOT, "phase-e"), { recursive: true });
  await writeFile(join(ROOT, "phase-e", "predictions-frozen.json"), JSON.stringify(frozen, null, 1), "utf8");
  console.log(`frozen ${families.length} families; missing=${JSON.stringify(missing)}`);
  process.exit(missing.length > 0 ? 2 : 0);
}

throw new Error(`未知模式 ${mode}（build-sample-manifest | freeze-predictions）`);
