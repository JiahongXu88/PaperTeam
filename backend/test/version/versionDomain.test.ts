/**
 * M4.8 版本域单元测试：VersionService（ManuscriptVersionDTO / 确定性 Compare /
 * Restore 不可变语义）。
 *
 * 覆盖规格要求：
 * - listVersions：revision / review / gate / build / artifact / iteration / plan
 *   的关联只由后端完成（对齐口径与 FinalizeService 一致）
 * - compare：确定性 diff（modified / unchanged / added / removed + 行级规模 +
 *   scorecard 对照）；同修订 400；缺修订 404
 * - restore：创建新修订（source=revision.restore + restoredFrom），历史修订
 *   永不改动；恢复后旧 Gate 自然 stale（Finalize 拒绝）
 * - restore 缺失修订 404；恢复到与当前内容一致 → created=false（幂等事实）
 * - 历史 Final 保留：Final 之后的修订不覆盖旧 Final 条目
 */

import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { ManuscriptRevisionStore } from "../../src/manuscript/RevisionStore.js";
import { PaperArtifactStore } from "../../src/artifacts/ArtifactStore.js";
import { FinalizeService } from "../../src/artifacts/FinalizeService.js";
import { ReviewArtifactStore } from "../../src/review/reviewArtifacts.js";
import { VersionService } from "../../src/version/VersionService.js";

const roots: string[] = [];
afterAll(async () => {
  for (const root of roots) {
    await rm(root, { recursive: true, force: true });
  }
});

async function newDomain() {
  const root = await mkdtemp(join(tmpdir(), "paperteam-version-"));
  roots.push(root);
  const projects = new ProjectStore({ root });
  const project = await projects.create("版本域测试", {});
  const id = project.id;
  const revisions = new ManuscriptRevisionStore({ projects });
  const artifacts = new PaperArtifactStore({ projects });
  const reviewArtifacts = new ReviewArtifactStore(projects);
  const finalize = new FinalizeService({ projects, reviewArtifacts, artifacts, revisions });
  const versions = new VersionService({ projects, revisions, artifacts, reviewArtifacts });
  return { root, id, projects, revisions, artifacts, reviewArtifacts, finalize, versions };
}

async function writeSection(root: string, id: string, file: string, content: string): Promise<void> {
  await mkdir(join(root, id, "manuscript", "sections"), { recursive: true });
  await writeFile(join(root, id, "manuscript", "sections", file), content, "utf8");
}

async function writeOutline(root: string, id: string, sections: string[]): Promise<void> {
  await mkdir(join(root, id, "manuscript"), { recursive: true });
  await writeFile(
    join(root, id, "manuscript", "outline.json"),
    JSON.stringify({
      title: "版本域论文",
      abstract: "版本域摘要。",
      sections: sections.map((file, index) => ({ id: `sec${index + 1}`, file, title: `第${index + 1}章` })),
    }),
    "utf8",
  );
}

async function seedPdf(root: string, id: string): Promise<void> {
  await mkdir(join(root, id, "build"), { recursive: true });
  await writeFile(join(root, id, "build", "paper.pdf"), `%PDF-1.5-${Date.now()}`, "utf8");
}

async function writeBuildRecord(root: string, id: string, revision: number): Promise<void> {
  await mkdir(join(root, id, "build"), { recursive: true });
  await writeFile(
    join(root, id, "build", "build-gate.json"),
    JSON.stringify({
      passed: true,
      reasons: [],
      checkedAt: new Date().toISOString(),
      revision,
      compile: {
        ok: true,
        tool: "latexmk",
        durationMs: 10,
        exitCode: 0,
        pdfPath: "build/paper.pdf",
        logPath: "build/compile.log",
      },
      diagnostics: [],
    }),
    "utf8",
  );
}

/** 造三轮版本事实：v1（写作）→ v2（修订 a.tex）→ v3（再修订 a.tex + 加 b.tex） */
async function seedThreeRevisions(domain: Awaited<ReturnType<typeof newDomain>>): Promise<void> {
  const { root, id, revisions } = domain;
  await writeOutline(root, id, ["a.tex", "b.tex"]);
  await writeSection(root, id, "a.tex", "line1\nline2\nline3");
  await revisions.commit(id, "writing.sections", "w-1");
  await writeSection(root, id, "a.tex", "line1\nchanged\nline3\nline4");
  await revisions.commit(id, "revision.revise", "w-1");
  await writeSection(root, id, "a.tex", "line1\nchanged-again\nline3\nline4");
  await writeSection(root, id, "b.tex", "b-content");
  await revisions.commit(id, "revision.revise", "w-1");
}

describe("VersionService.listVersions", () => {
  it("关联只由后端完成：revision / review / gate / artifact / iteration / plan 对齐到 DTO", async () => {
    const domain = await newDomain();
    await seedThreeRevisions(domain);
    const { root, id, versions, revisions, artifacts } = domain;

    // rev2 有通过 gate（reviewedRevision=2）+ Draft 产物 + 最新 build 记录对齐 rev3
    await domain.reviewArtifacts.saveSummary(id, 1, {
      generatedAt: new Date().toISOString(),
      round: 1,
      reviewedRevision: 2,
      issues: [],
      counts: { critical: 1, major: 2, minor: 0, byCategory: {}, blocking: 1 },
      scores: { academicScore: 85, styleRisk: 10, factVerdicts: null },
      openCritical: 0,
      openMajor: 0,
      unsupportedCriticalClaims: 0,
      reportPaths: [],
    });
    // 直接手写 gate 产物（round 1 / reviewedRevision 2）
    await mkdir(join(root, id, "reviews"), { recursive: true });
    await writeFile(
      join(root, id, "reviews", "quality-gate-r1.json"),
      JSON.stringify({
        gate: {
          passed: true,
          reasons: [],
          rules: [
            { rule: "academic_score_threshold", passed: true, detail: "" },
            { rule: "style_risk_threshold", passed: false, detail: "" },
          ],
          checkedAt: new Date().toISOString(),
          thresholds: { academicPassScore: 80, styleRiskMax: 35, requireFeasibility: true },
        },
        reviewSummary: { round: 1 },
        revision: 2,
        reviewedRevision: 2,
      }),
      "utf8",
    );
    await writeBuildRecord(root, id, 3);
    await seedPdf(root, id);
    await artifacts.ensureDraft(id, 3, {
      passed: true,
      reasons: [],
      checkedAt: new Date().toISOString(),
      revision: 3,
      compile: { ok: true, tool: "latexmk", durationMs: 10, exitCode: 0, pdfPath: "build/paper.pdf", logPath: "build/compile.log" },
      diagnostics: [],
    });

    const list = await versions.listVersions(id);
    expect(list.current).toBe(3);
    expect(list.versions).toHaveLength(3);
    // 最新在前
    expect(list.versions[0]?.revision).toBe(3);
    expect(list.versions[0]?.isCurrent).toBe(true);
    expect(list.versions[2]?.isCurrent).toBe(false);
    // rev2：review round 1 对齐 + gate 通过 + 计划计数缺失（无 plan）→ null
    const rev2 = list.versions.find((version) => version.revision === 2);
    expect(rev2?.review).toMatchObject({ round: 1, critical: 1, major: 2, academicScore: 85 });
    expect(rev2?.qualityGate).toMatchObject({ round: 1, passed: true, failedRuleIds: ["style_risk_threshold"] });
    expect(rev2?.revisionPlan).toBeNull();
    // rev3：Draft 产物 + build 对齐
    const rev3 = list.versions[0];
    expect(rev3?.hasDraft).toBe(true);
    expect(rev3?.isFinal).toBe(false);
    expect(rev3?.build).toMatchObject({ passed: true, revision: 3 });
    expect(rev3?.review).toBeNull(); // 没有对齐 rev3 的 review
    // 修订链事实完整透出（reason / createdAt）
    expect(rev3?.source).toBe("revision.revise");
    expect(typeof rev3?.createdAt).toBe("string");
    expect(await revisions.currentRevision(id)).toBe(3);
  });

  it("无版本事实（current=0）→ 空列表", async () => {
    const domain = await newDomain();
    const list = await domain.versions.listVersions(domain.id);
    expect(list).toEqual({ current: 0, versions: [] });
  });
});

describe("VersionService.compare（确定性，零 LLM）", () => {
  it("逐节 modified / unchanged / added / removed + 行级规模 + scorecard 对照", async () => {
    const domain = await newDomain();
    await seedThreeRevisions(domain);
    const { versions } = domain;

    const result = await versions.compare(domain.id, 1, 3);
    expect(result.from.revision).toBe(1);
    expect(result.to.revision).toBe(3);
    const byPath = new Map(result.sections.map((section) => [section.path, section]));
    // outline.json（快照内三次相同）→ unchanged
    expect(byPath.get("outline.json")?.status).toBe("unchanged");
    // a.tex：v1 3 行 → v3 4 行（2 行变化）
    const a = byPath.get("sections/a.tex");
    expect(a?.status).toBe("modified");
    expect(a?.title).toBe("第1章"); // 快照 outline 的章节标题
    expect(a?.fromLines).toBe(3);
    expect(a?.toLines).toBe(4);
    expect(a?.added).toBe(2);
    expect(a?.removed).toBe(1);
    // b.tex：rev3 新增
    expect(byPath.get("sections/b.tex")?.status).toBe("added");
    expect(result.summary).toEqual({ unchanged: 1, modified: 1, added: 1, removed: 0 });
    // 两端无 review → 对照字段如实为 null
    expect(result.reviewDelta).toEqual({ from: null, to: null, fromGate: null, toGate: null });
  });

  it("removed 路径与校验错误（同修订 400 / 缺失 404）", async () => {
    const domain = await newDomain();
    const { root, id, revisions } = domain;
    await writeSection(root, id, "a.tex", "only-a");
    await writeSection(root, id, "b.tex", "b");
    await revisions.commit(id, "writing.sections");
    await writeFile(join(root, id, "manuscript", "sections", "b.tex"), "", "utf8");
    // 删除 b.tex 后再提交（模拟文件移除）
    const { rm } = await import("node:fs/promises");
    await rm(join(root, id, "manuscript", "sections", "b.tex"));
    await writeSection(root, id, "a.tex", "only-a-v2");
    await revisions.commit(id, "revision.revise");

    const result = await domain.versions.compare(id, 1, 2);
    const byPath = new Map(result.sections.map((section) => [section.path, section]));
    expect(byPath.get("sections/b.tex")?.status).toBe("removed");
    expect(result.summary.removed).toBe(1);

    await expect(domain.versions.compare(id, 1, 1)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(domain.versions.compare(id, 1, 99)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("VersionService.restore（不可变恢复）", () => {
  it("恢复 = 新修订；历史修订与快照不动；Finalize 因 stale 拒绝；历史 Final 保留", async () => {
    const domain = await newDomain();
    const { root, id, revisions, versions, finalize, artifacts, reviewArtifacts } = domain;

    // rev1（写作）→ rev2（修订）；rev2 双 Gate 通过 → Final
    await writeOutline(root, id, ["a.tex"]);
    await writeSection(root, id, "a.tex", "line1\nline2\nline3");
    await revisions.commit(id, "writing.sections", "w-1");
    await writeSection(root, id, "a.tex", "line1\nchanged\nline3\nline4");
    await revisions.commit(id, "revision.revise", "w-1");

    // 造「rev2 曾 Final」的事实：gate round1 对齐 rev2 + build 对齐 rev2 + Final
    await mkdir(join(root, id, "reviews"), { recursive: true });
    await writeFile(
      join(root, id, "reviews", "quality-gate-r1.json"),
      JSON.stringify({
        gate: {
          passed: true,
          reasons: [],
          rules: [{ rule: "academic_score_threshold", passed: true, detail: "" }],
          checkedAt: new Date().toISOString(),
          thresholds: { academicPassScore: 80, styleRiskMax: 35, requireFeasibility: true },
        },
        reviewSummary: { round: 1 },
        revision: 2,
        reviewedRevision: 2,
      }),
      "utf8",
    );
    await reviewArtifacts.saveSummary(id, 1, {
      generatedAt: new Date().toISOString(),
      round: 1,
      reviewedRevision: 2,
      issues: [],
      counts: { critical: 0, major: 0, minor: 0, byCategory: {}, blocking: 0 },
      scores: { academicScore: 90, styleRisk: 5, factVerdicts: null },
      openCritical: 0,
      openMajor: 0,
      unsupportedCriticalClaims: 0,
      reportPaths: [],
    });
    await writeBuildRecord(root, id, 2);
    await seedPdf(root, id);
    const finalized = await finalize.finalize(id);
    expect(finalized.final.revision).toBe(2);

    // Final 后继续编辑 → rev3（新增 b.tex；改 a.tex）
    await writeSection(root, id, "a.tex", "line1\nchanged-again\nline3\nline4");
    await writeSection(root, id, "b.tex", "b-content");
    await revisions.commit(id, "revision.revise", "w-2");

    // 记录恢复前事实
    const registryBefore = JSON.parse(
      await readFile(join(root, id, "manuscript", "revisions.json"), "utf8"),
    ) as { current: number; revisions: unknown[] };
    const rev3SnapshotBefore = await readFile(
      join(root, id, "manuscript", "revisions", "rev-3", "sections", "a.tex"),
      "utf8",
    );
    const finalListBefore = await artifacts.list(id);

    // 恢复到修订 1 → 新修订 4（内容 = rev1 快照）
    const restored = await versions.restore(id, 1);
    expect(restored).toEqual({ revision: 4, created: true, restoredFrom: 1, current: 4 });

    // 历史登记表只追加；rev1-3 记录逐字节不变
    const registryAfter = JSON.parse(
      await readFile(join(root, id, "manuscript", "revisions.json"), "utf8"),
    ) as { current: number; revisions: { revision: number; reason: string; restoredFrom?: number }[] };
    expect(registryAfter.current).toBe(4);
    expect(registryAfter.revisions).toHaveLength(registryBefore.revisions.length + 1);
    expect(registryAfter.revisions.slice(0, 3)).toEqual(registryBefore.revisions);
    expect(registryAfter.revisions[3]).toMatchObject({ revision: 4, reason: "revision.restore", restoredFrom: 1 });
    // rev3 快照不受影响
    expect(await readFile(join(root, id, "manuscript", "revisions", "rev-3", "sections", "a.tex"), "utf8")).toBe(
      rev3SnapshotBefore,
    );
    // 工作树回到 rev1 内容
    expect(await readFile(join(root, id, "manuscript", "sections", "a.tex"), "utf8")).toBe("line1\nline2\nline3");
    // b.tex 已随恢复消失（rev1 快照里没有）
    await expect(readFile(join(root, id, "manuscript", "sections", "b.tex"), "utf8")).rejects.toThrow();

    // 旧 Final 保留（不可变清单未动）
    expect(await artifacts.list(id)).toEqual(finalListBefore);
    const list = await versions.listVersions(id);
    const rev4 = list.versions[0];
    expect(rev4).toMatchObject({ revision: 4, source: "revision.restore", restoredFrom: 1, isCurrent: true });
    expect(rev4?.isFinal).toBe(false);
    // rev2 的 Final 历史事实仍在
    expect(list.versions.find((version) => version.revision === 2)?.isFinal).toBe(true);

    // 恢复后 finalize：gate 评的是 rev2 ≠ 当前 rev4 → QUALITY_GATE_STALE 拒绝
    // （不允许偷用旧 Gate / 旧 Final 资格；FinalizeService 先查 gate 对齐再查 build）
    await expect(finalize.finalize(id)).rejects.toMatchObject({ code: "QUALITY_GATE_STALE" });

    // 重新 build（对齐 rev4）→ finalize 仍被拒（review/gate 只到 rev2，必须重新审稿）
    await seedPdf(root, id);
    await writeBuildRecord(root, id, 4);
    await expect(finalize.finalize(id)).rejects.toMatchObject({ code: "QUALITY_GATE_STALE" });
  });

  it("恢复到与当前内容一致的修订 → created=false（幂等事实，不虚增修订）", async () => {
    const domain = await newDomain();
    const { root, id, revisions, versions } = domain;
    await writeSection(root, id, "a.tex", "stable");
    await revisions.commit(id, "writing.sections");
    await writeSection(root, id, "a.tex", "drifted");
    await revisions.commit(id, "revision.revise");
    await writeSection(root, id, "a.tex", "stable");
    await revisions.commit(id, "revision.revise");

    const restored = await versions.restore(id, 1);
    expect(restored.created).toBe(false);
    expect(restored.revision).toBe(3);
  });

  it("缺失修订 → NOT_FOUND", async () => {
    const domain = await newDomain();
    const { root, id, revisions } = domain;
    await writeSection(root, id, "a.tex", "a");
    await revisions.commit(id, "writing.sections");
    await expect(domain.versions.restore(id, 9)).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
