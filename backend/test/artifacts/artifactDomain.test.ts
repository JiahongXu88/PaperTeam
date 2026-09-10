/**
 * M4.7 产物域单元测试：ManuscriptRevisionStore / PaperArtifactStore /
 * FinalizeService / RevisionPlan 持久化。
 *
 * 覆盖规格要求：
 * - Draft 条件：只看 Build Gate（质量语义不参与）
 * - Final 条件：双 Gate 通过 + revision 对齐（exactness）
 * - stale gate 拒绝：Revision N 的 gate + Revision N+1 的编辑 → 拒绝
 * - 错误 revision 拒绝（build 记录 revision 不对齐）
 * - Final 不可变：后续修订产生新产物，旧条目永不改写
 * - 下载解析只接受 manifest 中的 artifactId（防 path traversal）
 * - 修订计划持久化 / 重载；迭代历史按 gateRound 幂等
 */

import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { ManuscriptRevisionStore } from "../../src/manuscript/RevisionStore.js";
import { PaperArtifactStore } from "../../src/artifacts/ArtifactStore.js";
import { FinalizeService } from "../../src/artifacts/FinalizeService.js";
import { ReviewArtifactStore } from "../../src/review/reviewArtifacts.js";
import { buildRevisionPlan } from "../../src/review/revisionPlan.js";
import { NotFoundError } from "../../src/errors.js";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
});

async function newDomain() {
  const root = await mkdtemp(join(tmpdir(), "paperteam-domain-"));
  roots.push(root);
  const projects = new ProjectStore({ root });
  const project = await projects.create("产物域测试", {});
  const id = project.id;
  const revisions = new ManuscriptRevisionStore({ projects });
  const artifacts = new PaperArtifactStore({ projects });
  const reviewArtifacts = new ReviewArtifactStore(projects);
  const finalize = new FinalizeService({ projects, reviewArtifacts, artifacts, revisions });
  return { root, id, projects, revisions, artifacts, reviewArtifacts, finalize };
}

/** 写 manuscript 工作树 + build/paper.pdf（freeze 的源） */
async function seed(root: string, id: string, content: string): Promise<void> {
  await mkdir(join(root, id, "manuscript", "sections"), { recursive: true });
  await writeFile(join(root, id, "manuscript", "sections", "a.tex"), content, "utf8");
  await mkdir(join(root, id, "build"), { recursive: true });
  await writeFile(join(root, id, "build", "paper.pdf"), "%PDF-1.5-domain", "utf8");
}

/** 手工落盘一轮 Quality Gate 产物（loadGate 防御性结构） */
async function writeGate(
  root: string,
  id: string,
  round: number,
  options: { passed: boolean; reviewedRevision?: number },
): Promise<void> {
  await mkdir(join(root, id, "reviews"), { recursive: true });
  await writeFile(
    join(root, id, "reviews", `quality-gate-r${round}.json`),
    JSON.stringify({
      gate: {
        passed: options.passed,
        reasons: options.passed ? [] : ["academic_score_threshold: academicScore=66（要求 ≥ 80）"],
        rules: [],
        checkedAt: new Date().toISOString(),
        thresholds: { academicPassScore: 80, styleRiskMax: 35, requireFeasibility: true },
      },
      reviewSummary: { round },
      ...(options.reviewedRevision !== undefined
        ? { revision: options.reviewedRevision, reviewedRevision: options.reviewedRevision }
        : {}),
    }),
    "utf8",
  );
}

/** 手工落盘 Build Gate 记录（loadBuildGateRecord 防御性结构） */
async function writeBuild(
  root: string,
  id: string,
  options: { passed: boolean; revision: number },
): Promise<void> {
  await mkdir(join(root, id, "build"), { recursive: true });
  await writeFile(
    join(root, id, "build", "build-gate.json"),
    JSON.stringify({
      passed: options.passed,
      reasons: options.passed ? [] : ["LaTeX 编译失败"],
      checkedAt: new Date().toISOString(),
      revision: options.revision,
      compile: {
        ok: options.passed,
        tool: "latexmk",
        durationMs: 10,
        exitCode: options.passed ? 0 : 1,
        pdfPath: options.passed ? "build/paper.pdf" : null,
        logPath: "build/compile.log",
      },
      diagnostics: [],
    }),
    "utf8",
  );
}

describe("ManuscriptRevisionStore", () => {
  it("commit 内容指纹幂等：未变化不产生新修订；变化产生新修订并快照", async () => {
    const { root, id, revisions } = await newDomain();
    expect(await revisions.currentRevision(id)).toBe(0); // 空 manuscript 无版本事实

    await seed(root, id, "v1");
    const first = await revisions.commit(id, "writing.sections", "w-1");
    expect(first).toEqual({ revision: 1, created: true });

    const again = await revisions.commit(id, "review.snapshot", "w-1");
    expect(again).toEqual({ revision: 1, created: false }); // 内容未变 → 幂等

    await writeFile(join(root, id, "manuscript", "sections", "a.tex"), "v2", "utf8");
    const second = await revisions.commit(id, "revision.revise", "w-1");
    expect(second).toEqual({ revision: 2, created: true });

    // 快照目录落盘（不可变历史）
    const snapshot = join(root, id, "manuscript", "revisions", "rev-1", "sections", "a.tex");
    const { readFile } = await import("node:fs/promises");
    expect(await readFile(snapshot, "utf8")).toBe("v1");
    // 登记表（revisionViews 视图在 HTTP 层测）
    const state = await revisions.load(id);
    expect(state.current).toBe(2);
    expect(state.revisions.map((record) => record.reason)).toEqual([
      "writing.sections",
      "revision.revise",
    ]);
  });
});

describe("FinalizeService（Final 的唯一合法入口；纯确定性）", () => {
  it("无修订 → INVALID_REQUEST；有修订但无 gate 产物 → QUALITY_GATE_FAILED", async () => {
    const { root, id, revisions, finalize } = await newDomain();
    await seed(root, id, "v1");

    // 尚无修订（currentRevision=0）：没有任何版本事实可 Final
    await expect(finalize.finalize(id)).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    await revisions.commit(id, "writing.sections");
    await expect(finalize.finalize(id)).rejects.toMatchObject({ code: "QUALITY_GATE_FAILED" });
  });

  it("gate 失败 → QUALITY_GATE_FAILED（reasons 透传）", async () => {
    const { root, id, revisions, finalize } = await newDomain();
    await seed(root, id, "v1");
    await revisions.commit(id, "writing.sections");
    await writeGate(root, id, 1, { passed: false, reviewedRevision: 1 });
    await expect(finalize.finalize(id)).rejects.toMatchObject({
      code: "QUALITY_GATE_FAILED",
      httpStatus: 422,
    });
  });

  it("stale gate：Revision 1 的 gate + Revision 2 的编辑 → QUALITY_GATE_STALE 拒绝", async () => {
    const { root, id, revisions, finalize } = await newDomain();
    await seed(root, id, "v1");
    await revisions.commit(id, "writing.sections"); // rev 1
    await writeGate(root, id, 1, { passed: true, reviewedRevision: 1 });

    await writeFile(join(root, id, "manuscript", "sections", "a.tex"), "v2（人工编辑）", "utf8");
    await revisions.commit(id, "manual-edit"); // rev 2：gate 结论已过期

    await expect(finalize.finalize(id)).rejects.toMatchObject({
      code: "QUALITY_GATE_STALE",
      httpStatus: 409,
    });
  });

  it("旧格式 gate 产物（缺 reviewedRevision）→ QUALITY_GATE_STALE（不可信）", async () => {
    const { root, id, revisions, finalize } = await newDomain();
    await seed(root, id, "v1");
    await revisions.commit(id, "writing.sections");
    await writeGate(root, id, 1, { passed: true }); // 无修订对齐信息
    await expect(finalize.finalize(id)).rejects.toMatchObject({ code: "QUALITY_GATE_STALE" });
  });

  it("gate 轮次落后于更新的 review 轮次 → QUALITY_GATE_STALE", async () => {
    const { root, id, revisions, reviewArtifacts, finalize } = await newDomain();
    await seed(root, id, "v1");
    await revisions.commit(id, "writing.sections");
    await writeGate(root, id, 1, { passed: true, reviewedRevision: 1 });
    // 新一轮 review 已落盘（gate 未跟评）
    await reviewArtifacts.saveSummary(id, 2, { round: 2 } as never);
    await expect(finalize.finalize(id)).rejects.toMatchObject({ code: "QUALITY_GATE_STALE" });
  });

  it("build 记录缺失 / 失败 / revision 不对齐 → BUILD_GATE 拒绝（错误 revision 拒绝）", async () => {
    const { root, id, revisions, finalize } = await newDomain();
    await seed(root, id, "v1");
    await revisions.commit(id, "writing.sections");
    await writeGate(root, id, 1, { passed: true, reviewedRevision: 1 });

    await expect(finalize.finalize(id)).rejects.toMatchObject({ code: "BUILD_GATE_FAILED" });

    await writeBuild(root, id, { passed: false, revision: 1 });
    await expect(finalize.finalize(id)).rejects.toMatchObject({ code: "BUILD_GATE_FAILED" });

    await writeBuild(root, id, { passed: true, revision: 0 }); // 错误 revision（旧构建）
    await expect(finalize.finalize(id)).rejects.toMatchObject({
      code: "BUILD_GATE_STALE",
      httpStatus: 409,
    });
  });

  it("双 Gate 对齐 → Final；revision 精确等于通过双 Gate 的修订；幂等；Final 不可变", async () => {
    const { root, id, revisions, artifacts, finalize } = await newDomain();
    await seed(root, id, "v1");
    await revisions.commit(id, "writing.sections"); // rev 1
    await writeFile(join(root, id, "manuscript", "sections", "a.tex"), "v2", "utf8");
    await revisions.commit(id, "revision.revise"); // rev 2（通过双 Gate 的修订）
    await writeGate(root, id, 1, { passed: true, reviewedRevision: 2 });
    await writeBuild(root, id, { passed: true, revision: 2 });

    const result = await finalize.finalize(id, "w-final");
    expect(result.revision).toBe(2);
    expect(result.gateRound).toBe(1);
    expect(result.final.artifactId).toBe("art-final-rev2");
    expect(result.final.revision).toBe(2); // Final revision 精确性
    expect(result.draft.artifactId).toBe("art-draft-rev2"); // Final 随附同修订 Draft

    // 幂等：再次 Finalize 返回同一产物
    const again = await finalize.finalize(id);
    expect(again.final.artifactId).toBe("art-final-rev2");
    expect((await artifacts.list(id)).filter((item) => item.kind === "final")).toHaveLength(1);

    // ---- 不可变：后续修订 → 新 Final 条目，旧条目与旧文件永不改写 ----
    const finalBefore = (await artifacts.get(id, "art-final-rev2")) as unknown as Record<string, unknown>;
    const { readFile } = await import("node:fs/promises");
    const bytesBefore = await readFile(join(root, id, "artifacts", "art-final-rev2.pdf"));

    await writeFile(join(root, id, "manuscript", "sections", "a.tex"), "v3", "utf8");
    await revisions.commit(id, "manual-edit"); // rev 3
    await writeGate(root, id, 2, { passed: true, reviewedRevision: 3 });
    await writeBuild(root, id, { passed: true, revision: 3 });
    await writeFile(join(root, id, "build", "paper.pdf"), "%PDF-1.5-domain-v3", "utf8");
    const reFinal = await finalize.finalize(id);
    expect(reFinal.final.artifactId).toBe("art-final-rev3");

    const entries = await artifacts.list(id);
    expect(entries.map((item) => item.artifactId).sort()).toEqual([
      "art-draft-rev2",
      "art-draft-rev3",
      "art-final-rev2",
      "art-final-rev3",
    ]);
    // 旧条目元数据未被改写
    expect(await artifacts.get(id, "art-final-rev2")).toEqual(finalBefore);
    // 旧文件字节未被改写
    const bytesAfter = await readFile(join(root, id, "artifacts", "art-final-rev2.pdf"));
    expect(bytesAfter.equals(bytesBefore)).toBe(true);
  });
});

describe("PaperArtifactStore（下载解析只经 manifest）", () => {
  it("非法 artifactId（含 traversal 形态）→ NotFoundError，不做任何路径解析", async () => {
    const { artifacts, id } = await newDomain();
    for (const bad of ["../../etc/passwd", "art-draft-rev1/../../../x", "art-final-revX", ""]) {
      if (bad === "") {
        continue;
      }
      await expect(artifacts.get(id, bad)).rejects.toBeInstanceOf(NotFoundError);
    }
    await expect(artifacts.get(id, "art-draft-rev1")).rejects.toBeInstanceOf(NotFoundError); // 未登记
  });

  it("ensureDraft：Build 失败 / revision 不对齐 → 拒绝（Draft 只看 Build Gate）", async () => {
    const { root, id, artifacts } = await newDomain();
    await seed(root, id, "v1");
    const record = (options: { passed: boolean; revision: number }) =>
      ({
        passed: options.passed,
        reasons: options.passed ? [] : ["编译失败"],
        checkedAt: new Date().toISOString(),
        revision: options.revision,
        compile: { ok: options.passed, tool: "t", durationMs: 0, exitCode: 0, pdfPath: null, logPath: null },
        diagnostics: [],
      }) as never;
    await expect(artifacts.ensureDraft(id, 1, record({ passed: false, revision: 1 }))).rejects.toMatchObject(
      { code: "BUILD_GATE_FAILED" },
    );
    await expect(artifacts.ensureDraft(id, 1, record({ passed: true, revision: 0 }))).rejects.toMatchObject(
      { code: "BUILD_GATE_STALE" },
    );
    const draft = await artifacts.ensureDraft(id, 1, record({ passed: true, revision: 1 }));
    expect(draft.artifactId).toBe("art-draft-rev1");
    expect(draft.qualityGate).toBeUndefined(); // Draft 不携带质量结论
    // 幂等
    expect((await artifacts.ensureDraft(id, 1, record({ passed: true, revision: 1 }))).artifactId).toBe(
      "art-draft-rev1",
    );
  });
});

describe("RevisionPlan 持久化 / 迭代历史", () => {
  it("buildRevisionPlan → savePlan → loadPlan 往返一致；minor 记录不派发；损坏文件 → null", async () => {
    const { id, reviewArtifacts } = await newDomain();
    const summary = {
      counts: { critical: 1, major: 4, minor: 2, blocking: 3 },
      issues: [
        {
          category: "academic",
          severity: "critical",
          section: "sections/experiments.tex",
          description: "缺少关键对比实验",
          suggestedAction: "补充对比",
          blocking: true,
        },
        {
          category: "academic",
          severity: "major",
          section: "sections/method.tex",
          description: "方法描述含糊",
          suggestedAction: "细化",
          blocking: false,
        },
        {
          category: "style",
          severity: "minor",
          section: "sections/intro.tex",
          description: "连接词滥用",
          suggestedAction: "改写",
          blocking: false,
        },
      ],
    } as never;
    const plan = buildRevisionPlan({
      projectId: id,
      sourceRevision: 2,
      reviewRound: 1,
      summary,
      citationMissing: [{ key: "ghost2020", files: ["sections/intro.tex"] }],
      gateBlockers: [{ rule: "academic_score_threshold", detail: "score=66" }],
    });
    expect(plan.planId).toBe("plan-r1-rev2");
    expect(plan.summary.planned).toBe(3); // critical + major + citation_missing（minor/gate 阻止项不派发）
    expect(plan.summary.skipped).toBe(2); // minor + gate_blocker
    const planned = plan.items.filter((item) => item.status === "planned");
    expect(planned.some((item) => item.kind === "citation_missing" && item.priority === "high")).toBe(true);

    await reviewArtifacts.savePlan(id, plan);
    const loaded = await reviewArtifacts.loadPlan(id, 1);
    expect(loaded).toEqual(plan); // 持久化往返一致（确定性派生可重放）
    expect(await reviewArtifacts.loadPlan(id, 2)).toBeNull();
  });

  it("损坏的 plan 文件（非法 JSON / 缺字段）→ loadPlan 防御性返回 null", async () => {
    const { root, id, reviewArtifacts } = await newDomain();
    const reviewsDir = join(root, id, "reviews");
    await mkdir(reviewsDir, { recursive: true });
    await writeFile(join(reviewsDir, "revision-plan-r3.json"), "{ not json", "utf8");
    expect(await reviewArtifacts.loadPlan(id, 3)).toBeNull();
    await writeFile(join(reviewsDir, "revision-plan-r4.json"), JSON.stringify({ planId: 1 }), "utf8");
    expect(await reviewArtifacts.loadPlan(id, 4)).toBeNull(); // items 缺失
  });

  it("appendIteration：同 gateRound 幂等（不重复追加），按轮排序", async () => {
    const { id, reviewArtifacts } = await newDomain();
    const base = {
      revision: 1,
      reviewRound: 1,
      outcome: null,
      completedAt: new Date().toISOString(),
      scorecard: {
        gatePassed: false,
        failedRuleIds: ["a"],
        critical: 0,
        major: 4,
        blocking: 3,
        academicScore: 66,
        styleRisk: 68,
      },
    };
    await reviewArtifacts.appendIteration(id, { ...base, gateRound: 1 });
    await reviewArtifacts.appendIteration(id, { ...base, gateRound: 1, planId: "plan-r1-rev1" }); // 重放
    await reviewArtifacts.appendIteration(id, { ...base, gateRound: 2, outcome: "IMPROVED" });
    const iterations = await reviewArtifacts.loadIterations(id);
    expect(iterations.map((record) => record.gateRound)).toEqual([1, 2]);
    expect(iterations[0]?.planId).toBe("plan-r1-rev1");
    expect(iterations[1]?.outcome).toBe("IMPROVED");
  });
});
