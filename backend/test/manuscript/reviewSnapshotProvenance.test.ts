/**
 * M15 长程 A1 / A2：Agent 写边界 + review.snapshot 提交边界。
 *
 * 负例：Agent 工具改了作者冻结数值、未经编辑契约校验提交 → review.snapshot 不吸收（恢复 + 隔离），
 *       Agent 工具不能写修订快照 / 修订登记 / 恢复意图（lineage 证据源）。
 * 正例：作者在磁盘上的编辑照常吸收并逐文件登记来源；干净工作区不产生修订。
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import { ManuscriptRevisionStore } from "../../src/manuscript/RevisionStore.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";
import { createWorkspaceGuardPolicy, createWorkspaceGuardTools } from "../../src/runtime/pi/workspaceGuard.js";

let root: string;
let projects: ProjectStore;
let revisions: ManuscriptRevisionStore;
let projectId: string;
let tools: Map<string, ToolDefinition>;
let clock = Date.parse("2026-11-01T00:00:00.000Z");

function tick(): Date {
  clock += 1000;
  return new Date(clock);
}

async function agent(name: "write" | "edit", params: Record<string, unknown>): Promise<string> {
  const tool = tools.get(name)!;
  try {
    const result = await tool.execute("call", params as never, undefined, undefined, { cwd: projects.projectDir(projectId) } as never);
    return result.content.map((part) => (part.type === "text" ? part.text : "")).join("");
  } catch (error) {
    return `ERROR:${error instanceof Error ? error.message : String(error)}`;
  }
}

const intro = () => join(projects.manuscriptDir(projectId), "sections", "intro.tex");
const results = () => join(projects.manuscriptDir(projectId), "sections", "results.tex");

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "pt-snapshot-"));
  projects = new ProjectStore({ root });
  projectId = (await projects.create("快照来源", {})).id;
  revisions = new ManuscriptRevisionStore({ projects, now: tick });
  await mkdir(join(projects.manuscriptDir(projectId), "sections"), { recursive: true });
  await writeFile(intro(), "HOTA improves by 5.402 over the baseline.\n", "utf-8");
  await writeFile(results(), "IDF1 reaches 11.549.\n", "utf-8");
  await revisions.commit(projectId, "baseline");
  const cwd = projects.projectDir(projectId);
  tools = new Map(
    createWorkspaceGuardTools(createWorkspaceGuardPolicy({ projectDir: cwd, protectedSourceIds: [] }), {
      cwd,
      toolNames: ["write", "edit"],
      onWrite: (absPath, content) => revisions.agentWriteJournal.record(projectId, absPath, content),
    }).map((tool) => [tool.name, tool]),
  );
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("A1：Agent 不能写 lineage 证据源", () => {
  it("修订快照 / revisions.json / restore-intent.json 拒写；普通稿件可写", async () => {
    expect(await agent("write", { path: "manuscript/revisions/rev-1/sections/intro.tex", content: "forged 3.312" })).toMatch(/^ERROR:.*修订快照/);
    expect(await agent("write", { path: "manuscript/revisions.json", content: "{}" })).toMatch(/^ERROR:/);
    expect(await agent("write", { path: "manuscript/restore-intent.json", content: "{}" })).toMatch(/^ERROR:/);
    expect(await agent("write", { path: "manuscript/REVISIONS/rev-1/x.tex", content: "x" })).toMatch(process.platform === "win32" ? /^ERROR:/ : /.*/);
    expect(await readFile(join(projects.manuscriptDir(projectId), "revisions", "rev-1", "sections", "intro.tex"), "utf-8")).toContain("5.402");
    expect(await agent("write", { path: "manuscript/sections/new.tex", content: "ok" })).not.toMatch(/^ERROR:/);
  });
});

describe("A2：review.snapshot 不吸收未经契约校验的 Agent 写入", () => {
  it("Agent 改数字后直接审稿 → 不产生修订、正文恢复、原内容隔离、登记 reverted", async () => {
    expect(await agent("edit", { path: "manuscript/sections/intro.tex", edits: [{ oldText: "5.402", newText: "3.312" }] })).not.toMatch(/^ERROR:/);
    expect(await readFile(intro(), "utf-8")).toContain("3.312");
    const result = await revisions.commitReviewSnapshot(projectId, "w-1");
    expect(result).toMatchObject({ revision: 1, created: false });
    expect(result.provenance?.revertedAgentWrites.map((entry) => entry.path)).toEqual(["sections/intro.tex"]);
    expect(result.provenance?.absorbedNonAgentChanges).toEqual([]);
    expect(await readFile(intro(), "utf-8")).toContain("5.402");
    const quarantined = join(projects.projectDir(projectId), result.provenance!.revertedAgentWrites[0]!.quarantinedAs);
    expect(await readFile(quarantined, "utf-8")).toContain("3.312");
  });

  it("Agent 新建的文件同样不吸收（删除并隔离）", async () => {
    await agent("write", { path: "manuscript/sections/injected.tex", content: "We report 99.9 accuracy.\n" });
    const result = await revisions.commitReviewSnapshot(projectId);
    expect(result.created).toBe(false);
    await expect(readFile(join(projects.manuscriptDir(projectId), "sections", "injected.tex"), "utf-8")).rejects.toMatchObject({ code: "ENOENT" });
  });

  it("作者磁盘编辑照常吸收，逐文件登记 provenance；与 Agent 写入混合时只吸收作者改动", async () => {
    await agent("edit", { path: "manuscript/sections/intro.tex", edits: [{ oldText: "5.402", newText: "3.312" }] });
    await writeFile(results(), "IDF1 reaches 11.549 on MOT17 (author clarification).\n", "utf-8");
    const result = await revisions.commitReviewSnapshot(projectId, "w-2");
    expect(result).toMatchObject({ revision: 2, created: true });
    expect(result.provenance?.absorbedNonAgentChanges).toEqual([
      expect.objectContaining({ path: "sections/results.tex", change: "modified" }),
    ]);
    const snapshot = join(revisions.snapshotDir(projectId, 2), "sections");
    expect(await readFile(join(snapshot, "intro.tex"), "utf-8")).toContain("5.402");
    expect(await readFile(join(snapshot, "results.tex"), "utf-8")).toContain("author clarification");
    const state = await revisions.load(projectId);
    expect(state.revisions[1]?.provenance?.absorbedNonAgentChanges[0]?.path).toBe("sections/results.tex");
  });

  it("作者在 Agent 写入之后再编辑同一文件 → 以作者内容为准吸收", async () => {
    await agent("edit", { path: "manuscript/sections/intro.tex", edits: [{ oldText: "5.402", newText: "3.312" }] });
    await writeFile(intro(), "HOTA improves by 5.402 over the baseline (author rewrite).\n", "utf-8");
    const result = await revisions.commitReviewSnapshot(projectId);
    expect(result.created).toBe(true);
    expect(result.provenance?.revertedAgentWrites).toEqual([]);
  });

  it("已提交修订之前的 Agent 写入不影响之后的作者编辑；干净工作区不产生修订", async () => {
    await agent("edit", { path: "manuscript/sections/intro.tex", edits: [{ oldText: "5.402", newText: "5.40" }] });
    await revisions.commit(projectId, "revision.apply");
    expect(await revisions.commitReviewSnapshot(projectId)).toMatchObject({ revision: 2, created: false, provenance: null });
  });

  it("写入日志损坏 → fail closed（不猜测来源）", async () => {
    await writeFile(results(), "changed\n", "utf-8");
    await mkdir(projects.workflowDir(projectId), { recursive: true });
    await writeFile(join(projects.workflowDir(projectId), "agent-writes.jsonl"), "{not json\n", "utf-8");
    await expect(revisions.commitReviewSnapshot(projectId)).rejects.toMatchObject({ code: "REVIEW_SNAPSHOT_PROVENANCE_UNAVAILABLE" });
  });
});
