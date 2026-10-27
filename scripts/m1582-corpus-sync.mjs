#!/usr/bin/env node
/**
 * M15.8.2 零模型收尾：corpus 快照 basisDepth 与当前 matrix 状态对齐（补跑
 * syncBasisDepth——M15.8.2 P run 期间增量 matrix 重建 [S003, S017] 完成于该 run
 * 最后一次 sync 之后，快照行停留在 abstract_only；S022/S025 条目已被 refresh
 * 失效移除、重建因预算拒付未执行，按 buildCorpusRows 语义应为 null + hasFulltext
 * （= 可采证）。本脚本只调用产品自身的 buildCorpusRows 语义，0 模型调用、不改
 * matrix/synthesis 内容、不触碰 evidence。
 *
 * 用法：node scripts/m1582-corpus-sync.mjs
 */

import { readFile, rename, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

const PROJ = "p-6f05e6980fda";
const P_ROOT = "D:\\PaperTeamData\\M15\\M15_8\\projects-root";
const projDir = join(P_ROOT, PROJ);
const snapshotPath = join(projDir, "research", "corpus-snapshot.json");
const OUT = join("D:\\PaperTeamData\\M15\\M15_8\\M15_8_2\\phase-a", "corpus-sync-report.json");

const index = JSON.parse(await readFile(join(projDir, "sources", "index.json"), "utf8"));
const matrix = JSON.parse(await readFile(join(projDir, "research", "survey.json"), "utf8"));
const snapshot = JSON.parse(await readFile(snapshotPath, "utf8"));

// buildCorpusRows 语义（backend/src/survey/CorpusSnapshotService.ts:120）：
// isCorpusEligible = sourceRole !== "reference" && status !== "rejected"；hasFulltext
// = fileName 非空且 status !== "metadata_only"；basisDepth = matrix 条目深度 ?? null。
const depthBySource = new Map((matrix.entries ?? []).map((e) => [e.sourceId, e.interpretationDepth]));
const rows = index.items
  .filter((s) => s.sourceRole !== "reference" && s.status !== "rejected")
  .map((s) => ({
    sourceId: s.sourceId,
    status: s.status,
    hasFulltext: s.fileName !== undefined && s.fileName !== "" && s.status !== "metadata_only",
    basisDepth: depthBySource.get(s.sourceId) ?? null,
  }))
  .sort((a, b) => a.sourceId.localeCompare(b.sourceId));

const sha = async (s) => {
  const { createHash } = await import("node:crypto");
  return createHash("sha256").update(s).digest("hex").slice(0, 16);
};
// corpusFingerprint 语义：行序列化（sourceId/status/hasFulltext/basisDepth）
const serialized = rows
  .map((r) => [r.sourceId, r.status, r.hasFulltext ? "1" : "0", r.basisDepth ?? "-"].join("\t"))
  .join("\n");
const fingerprint = await sha(serialized);

const before = Object.fromEntries(snapshot.sources.map((r) => [r.sourceId, `${r.basisDepth ?? "null"}/${r.hasFulltext}`]));
const after = { rows, fingerprint };
const changes = rows
  .filter((r) => before[r.sourceId] !== `${r.basisDepth ?? "null"}/${r.hasFulltext}`)
  .map((r) => ({ sourceId: r.sourceId, before: before[r.sourceId], after: `${r.basisDepth ?? "null"}/${r.hasFulltext}` }));

const artifact = {
  ...snapshot,
  updatedAt: new Date().toISOString(),
  fingerprint,
  counts: {
    total: rows.length,
    hasFulltext: rows.filter((r) => r.hasFulltext).length,
    fulltextBasis: rows.filter((r) => r.basisDepth === "fulltext").length,
    abstractBasis: rows.filter((r) => r.basisDepth === "abstract_only").length,
  },
  sources: rows,
};
await mkdir(join(projDir, "research"), { recursive: true });
const tmp = `${snapshotPath}.m1582sync.tmp`;
await writeFile(tmp, JSON.stringify(artifact, null, 2) + "\n", "utf8");
await rename(tmp, snapshotPath);

// 可采证口径对照（buildClaimResolutionContext.groundableInBasis）：
// basisDepth === "fulltext" || (basisDepth === null && hasFulltext)
const groundable = rows.filter((r) => r.basisDepth === "fulltext" || (r.basisDepth === null && r.hasFulltext)).map((r) => r.sourceId);
const report = {
  schema: "m1582-corpus-sync/v1",
  at: new Date().toISOString(),
  projectId: PROJ,
  rowChanges: changes,
  fingerprintBefore: snapshot.fingerprint,
  fingerprintAfter: fingerprint,
  groundableSourceIdsAfter: groundable,
  zeroModel: true,
};
await writeFile(OUT, JSON.stringify(report, null, 2), "utf8");
console.log(`corpus sync done: ${changes.length} row changes; groundable after = [${groundable.join(", ")}]`);
