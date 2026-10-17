/**
 * M14.8.1-MOT：同一修订号下补丁校验产物的覆盖保护。
 *
 * 真实继续返修实录：M14.8 run 的 patch-validation-rev-2.json 记录了 rev-2 如何产生（3 个已接受补丁 +
 * 被拒候选）；新 run 从 rev-2 出发，被拒候选的 fail-closed 记录同样写在 rev-2 下，把上一 run 的
 * 产生记录整体覆盖。同一 stage 内的累积写入（新记录 ⊇ 旧记录）不应产生 superseded 副本。
 */
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { ReviewArtifactStore } from "../../src/review/reviewArtifacts.js";
import { summarizePatchValidation, type PatchValidationRecord } from "../../src/review/patchValidation.js";

const roots: string[] = [];
afterEach(async () => { for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true }); });

function record(patchId: string, overall: "pass" | "fail", beforeFileHash: string): PatchValidationRecord {
  return {
    patchId, revisionId: "rev-3", file: "main.tex", logicalTarget: "sec:a", planItemIds: [], commentIds: [], evidenceIds: [],
    beforeFileHash, beforeTargetHash: "t", proposedReplacementHash: "p", afterFileHash: "a",
    scope: { ok: overall === "pass", violations: [] }, workspaceIntegrity: { ok: true, directMutationDetected: false, recoverySucceeded: true },
    fact: { ok: true, findingIds: [], violations: [] }, citation: { ok: true, findingIds: [], addedKeys: [], removedKeys: [], violations: [] },
    evidence: { ok: true, violations: [] }, apply: { ok: overall === "pass", status: overall === "pass" ? "applied" : "rejected" }, overall,
  };
}

describe("ReviewArtifactStore.savePatchValidation（M14.8.1-MOT 覆盖保护）", () => {
  it("同一 stage 的累积写入不产生 superseded；另一 run 的覆盖把既有产物原样保留", async () => {
    const root = await mkdtemp(join(tmpdir(), "pv-artifact-"));
    roots.push(root);
    const projects = new ProjectStore({ root });
    const project = await projects.create("artifact", { language: "zh" });
    const store = new ReviewArtifactStore(projects);
    const runA = [record("patch:a", "pass", "h-run-a")];
    await store.savePatchValidation(project.id, { revisionId: "rev-2", revision: 2, records: runA, summary: summarizePatchValidation(runA) });
    const runA2 = [...runA, record("patch:b", "fail", "h-run-a")];
    await store.savePatchValidation(project.id, { revisionId: "rev-2", revision: 2, records: runA2, summary: summarizePatchValidation(runA2) });
    expect((await store.loadPatchValidation(project.id, 2))?.supersededArtifacts).toBeUndefined();
    const runB = [record("patch:a", "fail", "h-run-b")];
    await store.savePatchValidation(project.id, { revisionId: "rev-3", revision: 2, records: runB, summary: summarizePatchValidation(runB) });
    const loaded = await store.loadPatchValidation(project.id, 2);
    expect(loaded?.records).toEqual(runB);
    expect(loaded?.supersededArtifacts).toHaveLength(1);
    expect(loaded?.supersededArtifacts?.[0]?.records).toEqual(runA2);
    // 后续同 stage 累积写入保留已有的 superseded 链
    const runB2 = [...runB, record("patch:c", "pass", "h-run-b")];
    await store.savePatchValidation(project.id, { revisionId: "rev-3", revision: 2, records: runB2, summary: summarizePatchValidation(runB2) });
    expect((await store.loadPatchValidation(project.id, 2))?.supersededArtifacts?.[0]?.records).toEqual(runA2);
    // revision.validate 把非终态记录移入 attemptHistory 的重组不产生冗余副本
    await store.savePatchValidation(project.id, { revisionId: "rev-3", revision: 2, records: [runB2[1]!], attemptHistory: [runB2[0]!], summary: summarizePatchValidation([runB2[1]!]) });
    expect((await store.loadPatchValidation(project.id, 2))?.supersededArtifacts).toHaveLength(1);
  });
});
