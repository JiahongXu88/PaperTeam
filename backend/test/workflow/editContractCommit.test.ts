/**
 * M15.20 P0 —— 提交边界（SINGLE_GUARD 纵深防御）与竞态（E1-RACE）。
 *
 * - guardedRevisionCommit：stage 期间产生、未登记为「已通过编辑契约校验」的改动（Writer 工具直写其它文件、
 *   遗漏校验的路径、校验后被改写的内容、未校验的摘要改动）在提交前恢复为 stage 开始时的内容；stage 之前
 *   已存在的工作区内容不被回退。
 * - RevisionStore.commit(expectedFingerprint)：校验之后、提交之前工作树被改动 → 拒绝提交，不产生修订。
 */

import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { ManuscriptRevisionStore } from "../../src/manuscript/RevisionStore.js";
import { ManuscriptService } from "../../src/manuscript/ManuscriptService.js";
import { BusinessError } from "../../src/errors.js";
import { captureWorkspaceState, guardedRevisionCommit, ValidatedWriteRegistry } from "../../src/workflow/editContractEnforcement.js";
import { validateCandidateEdit, systemRevisionPolicyContract } from "../../src/quality/editContract.js";

let root: string;
let projects: ProjectStore;
let revisions: ManuscriptRevisionStore;
let manuscript: ManuscriptService;
let projectId: string;

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "paperteam-m1520-commit-"));
  projects = new ProjectStore({ root });
  revisions = new ManuscriptRevisionStore({ projects });
  manuscript = new ManuscriptService(projects);
  projectId = (await projects.create("m1520 commit guard", { language: "en" })).id;
  const dir = projects.manuscriptDir(projectId);
  await mkdir(join(dir, "sections"), { recursive: true });
  await writeFile(join(dir, "sections", "a.tex"), "\\section{A}\nAccuracy is 82.4\\%.\n", "utf8");
  await writeFile(join(dir, "sections", "b.tex"), "\\section{B}\nLatency is 12 ms.\n", "utf8");
  await writeFile(join(dir, "sections", "c.tex"), "\\section{C}\nConclusion.\n", "utf8");
  await writeFile(join(dir, "outline.json"), JSON.stringify({ title: "T", abstract: "We report 82.4% accuracy.", sections: [{ id: "a", file: "a.tex", title: "A" }, { id: "b", file: "b.tex", title: "B" }, { id: "c", file: "c.tex", title: "C" }] }), "utf8");
  await writeFile(join(dir, "main.tex"), "\\documentclass{article}\\begin{document}\\input{sections/a}\\input{sections/b}\\end{document}\n", "utf8");
  await revisions.commit(projectId, "baseline");
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

const services = () => ({ projects, revisions, manuscript });

describe("guardedRevisionCommit（提交边界）", () => {
  it("已校验写入照常提交；未登记的其它文件改动与摘要改动被恢复为 stage 开始时内容并记录事件", async () => {
    const dir = projects.manuscriptDir(projectId);
    const stageStart = await captureWorkspaceState(services(), projectId);
    const registry = new ValidatedWriteRegistry();
    // 已校验写入：a.tex 语法修正（数值不变）
    const baseA = await readFile(join(dir, "sections", "a.tex"), "utf8");
    const nextA = baseA.replace("Accuracy is", "The accuracy is");
    const verdict = validateCandidateEdit({
      target: "sections/a.tex", baseline: baseA, candidate: nextA,
      contracts: [systemRevisionPolicyContract({ projectId, file: "sections/a.tex", carrier: "file", baseContent: baseA, frozenContent: baseA, stageId: "revision.revise" })],
    });
    expect(verdict.ok).toBe(true);
    await writeFile(join(dir, "sections", "a.tex"), nextA, "utf8");
    registry.register("sections/a.tex", nextA, verdict);
    // 未校验：Writer 经工具直写 b.tex 改数字；摘要被改
    await writeFile(join(dir, "sections", "b.tex"), "\\section{B}\nLatency is 9 ms.\n", "utf8");
    const outline = JSON.parse(await readFile(join(dir, "outline.json"), "utf8")) as { abstract: string };
    outline.abstract = "We report 92.4% accuracy.";
    await writeFile(join(dir, "outline.json"), JSON.stringify(outline), "utf8");

    const result = await guardedRevisionCommit(services(), { projectId, runId: "r", stageId: "revision.revise", registry, withBibliography: false, stageStart });
    expect(result.created).toBe(true);
    expect(result.reverted.sort()).toEqual(["abstract", "sections/b.tex"]);
    expect(await readFile(join(dir, "sections", "a.tex"), "utf8")).toBe(nextA);
    expect(await readFile(join(dir, "sections", "b.tex"), "utf8")).toContain("12 ms");
    expect((JSON.parse(await readFile(join(dir, "outline.json"), "utf8")) as { abstract: string }).abstract).toBe("We report 82.4% accuracy.");
    // 提交的修订快照不含未校验内容
    const snapshotB = await readFile(join(revisions.snapshotDir(projectId, result.revision), "sections", "b.tex"), "utf8");
    expect(snapshotB).toContain("12 ms");
    const store = JSON.parse(await readFile(join(projects.researchDir(projectId), "edit-contracts.json"), "utf8")) as { events: Array<{ kind: string }> };
    expect(store.events.some((event) => event.kind === "unvalidated_write_reverted")).toBe(true);
  });

  it("登记后内容又被改写（校验与写入不一致）→ 视为未校验，恢复", async () => {
    const dir = projects.manuscriptDir(projectId);
    const stageStart = await captureWorkspaceState(services(), projectId);
    const registry = new ValidatedWriteRegistry();
    const baseA = await readFile(join(dir, "sections", "a.tex"), "utf8");
    registry.register("sections/a.tex", baseA.replace("Accuracy is", "The accuracy is"));
    await writeFile(join(dir, "sections", "a.tex"), baseA.replace("82.4", "92.4"), "utf8");
    const result = await guardedRevisionCommit(services(), { projectId, runId: "r", stageId: "revision.revise", registry, withBibliography: false, stageStart });
    expect(result.reverted).toEqual(["sections/a.tex"]);
    expect(await readFile(join(dir, "sections", "a.tex"), "utf8")).toBe(baseA);
  });

  it("stage 开始前已存在的工作区改动（run 外编辑）不归本 stage，不被回退", async () => {
    const dir = projects.manuscriptDir(projectId);
    await writeFile(join(dir, "sections", "b.tex"), "\\section{B}\nLatency is 12 ms on GPU.\n", "utf8");
    const stageStart = await captureWorkspaceState(services(), projectId);
    const result = await guardedRevisionCommit(services(), { projectId, runId: "r", stageId: "revision.revise", registry: new ValidatedWriteRegistry(), withBibliography: false, stageStart });
    expect(result.reverted).toEqual([]);
    expect(await readFile(join(dir, "sections", "b.tex"), "utf8")).toContain("on GPU");
  });
});

describe("E1-RACE：校验后、提交前工作树变化 → 拒绝提交", () => {
  it("expectedFingerprint 与提交时工作树不一致 → EDIT_CONTRACT_STALE，不产生修订", async () => {
    const dir = projects.manuscriptDir(projectId);
    const before = await revisions.currentRevision(projectId);
    await writeFile(join(dir, "sections", "a.tex"), "\\section{A}\nThe accuracy is 82.4\\%.\n", "utf8");
    const validatedFingerprint = await revisions.workTreeFingerprint(projectId);
    // 校验完成后，另一写入改动了工作树（竞态）
    await writeFile(join(dir, "sections", "a.tex"), "\\section{A}\nThe accuracy is 92.4\\%.\n", "utf8");
    await expect(revisions.commit(projectId, "revision.revise", "r", { expectedFingerprint: validatedFingerprint })).rejects.toSatisfy(
      (error: unknown) => error instanceof BusinessError && error.code === "EDIT_CONTRACT_STALE" && /EDIT_CONTRACT_RACE/.test(error.message),
    );
    expect(await revisions.currentRevision(projectId)).toBe(before);
    // 指纹一致时正常提交
    const ok = await revisions.commit(projectId, "revision.revise", "r", { expectedFingerprint: await revisions.workTreeFingerprint(projectId) });
    expect(ok.created).toBe(true);
  });
});
