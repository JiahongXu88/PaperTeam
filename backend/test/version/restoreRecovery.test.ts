import { spawnSync } from "node:child_process";
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { ProjectStore } from "../../src/project/ProjectStore.js";
import { ManuscriptRevisionStore } from "../../src/manuscript/RevisionStore.js";

const roots: string[] = [];
afterAll(async () => { for (const root of roots) await rm(root, { recursive: true, force: true }); });

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), "paperteam-restore-"));
  roots.push(root);
  const projects = new ProjectStore({ root });
  const project = await projects.create("restore recovery", {});
  const dir = projects.manuscriptDir(project.id);
  const store = new ManuscriptRevisionStore({ projects });
  await mkdir(join(dir, "sections"), { recursive: true });
  await writeFile(join(dir, "sections", "body.tex"), "old manuscript");
  await store.commit(project.id, "baseline");
  await writeFile(join(dir, "sections", "body.tex"), "new manuscript");
  await writeFile(join(dir, "extra.tex"), "unsaved extra");
  await store.commit(project.id, "writing.sections");
  return { root, projects, id: project.id, dir, store };
}

function restarted(projects: ProjectStore) { return new ManuscriptRevisionStore({ projects }); }

describe("RevisionStore restore durability", () => {
  it("restores, increments once, excludes intent from fingerprint and keeps historical bytes", async () => {
    const f = await fixture();
    const result = await f.store.restore(f.id, 1);
    expect(result).toEqual({ revision: 3, created: true, restoredFrom: 1 });
    expect(await readFile(join(f.dir, "sections", "body.tex"), "utf8")).toBe("old manuscript");
    await expect(readFile(join(f.dir, "extra.tex"))).rejects.toMatchObject({ code: "ENOENT" });
    expect(await readFile(join(f.dir, "revisions", "rev-1", "sections", "body.tex"), "utf8")).toBe("old manuscript");
    expect((await f.store.load(f.id)).revisions[2]).toMatchObject({ restoredFrom: 1, reason: "revision.restore" });
    expect(await restarted(f.projects).restore(f.id, 1)).toEqual({ revision: 3, created: false, restoredFrom: 1 });
    expect(await restarted(f.projects).commit(f.id, "review.snapshot")).toEqual({ revision: 3, created: false });
  });

  it("rejects missing, empty and corrupt snapshots before touching the worktree", async () => {
    for (const damage of ["missing", "empty", "corrupt"]) {
      const f = await fixture();
      const snapshot = join(f.dir, "revisions", "rev-1", "sections", "body.tex");
      if (damage === "missing") await rm(snapshot);
      if (damage === "empty") await writeFile(snapshot, "");
      if (damage === "corrupt") await writeFile(snapshot, "tampered");
      await expect(f.store.restore(f.id, 1)).rejects.toMatchObject({ code: damage === "missing" ? "STAGE_CONTRACT_VIOLATION" : "REVISION_STORE_CORRUPTED" });
      expect(await readFile(join(f.dir, "sections", "body.tex"), "utf8")).toBe("new manuscript");
      expect((await f.store.load(f.id)).current).toBe(2);
    }
  });

  it.each(["intent", "workspace", "snapshot", "before-commit", "commit"])("recovers after simulated interruption at %s", async (boundary) => {
    const f = await fixture();
    process.env["PAPERTEAM_RESTORE_TEST_FAILURE"] = boundary;
    try { await expect(f.store.restore(f.id, 1)).rejects.toThrow(`RESTORE_TEST_INTERRUPTED:${boundary}`); }
    finally { delete process.env["PAPERTEAM_RESTORE_TEST_FAILURE"]; }
    const fresh = restarted(f.projects);
    if (boundary !== "commit") await expect(fresh.currentRevision(f.id)).rejects.toMatchObject({ code: "REVISION_RECOVERY_REQUIRED" });
    expect(await fresh.restore(f.id, 1)).toEqual({ revision: 3, created: true, restoredFrom: 1 });
    expect((await fresh.load(f.id)).current).toBe(3);
    expect(await readFile(join(f.dir, "revisions", "rev-1", "sections", "body.tex"), "utf8")).toBe("old manuscript");
  });

  it("preserves external edits after interruption and blocks another commit", async () => {
    const f = await fixture();
    process.env["PAPERTEAM_RESTORE_TEST_FAILURE"] = "workspace";
    try { await expect(f.store.restore(f.id, 1)).rejects.toThrow(); }
    finally { delete process.env["PAPERTEAM_RESTORE_TEST_FAILURE"]; }
    await writeFile(join(f.dir, "sections", "body.tex"), "human edit after interruption");
    const fresh = restarted(f.projects);
    await expect(fresh.restore(f.id, 1)).rejects.toMatchObject({ code: "REVISION_RECOVERY_REQUIRED" });
    await expect(fresh.commit(f.id, "review.snapshot")).rejects.toMatchObject({ code: "REVISION_RECOVERY_REQUIRED" });
    expect(await readFile(join(f.dir, "sections", "body.tex"), "utf8")).toBe("human edit after interruption");
    expect((await readFile(join(f.dir, "restore-intent.json"), "utf8"))).toContain('"pending"');
  });

  it("ignores an orphan atomic temp inside revisions and fails closed on corrupt registry", async () => {
    const f = await fixture();
    process.env["PAPERTEAM_RESTORE_TEST_FAILURE"] = "intent";
    try { await expect(f.store.restore(f.id, 1)).rejects.toThrow(); }
    finally { delete process.env["PAPERTEAM_RESTORE_TEST_FAILURE"]; }
    await writeFile(join(f.dir, "revisions", ".body.tex.interrupted.tmp"), "partial write");
    expect(await restarted(f.projects).restore(f.id, 1)).toEqual({ revision: 3, created: true, restoredFrom: 1 });
    await writeFile(join(f.dir, "revisions.json"), "{broken");
    await expect(restarted(f.projects).commit(f.id, "new revision")).rejects.toMatchObject({ code: "REVISION_STORE_CORRUPTED" });
    expect(await readFile(join(f.dir, "revisions.json"), "utf8")).toBe("{broken");
  });

  it("does not silently reuse a partial unregistered snapshot during commit", async () => {
    const f = await fixture();
    await writeFile(join(f.dir, "sections", "body.tex"), "third manuscript");
    const orphan = join(f.dir, "revisions", "rev-3", "sections", "body.tex");
    await mkdir(join(orphan, ".."), { recursive: true });
    await writeFile(orphan, "partial old write");
    await expect(f.store.commit(f.id, "writing.sections")).rejects.toMatchObject({ code: "REVISION_RECOVERY_REQUIRED" });
    expect((await f.store.load(f.id)).current).toBe(2);
    expect(await readFile(orphan, "utf8")).toBe("partial old write");
  });

  it.each([
    ["workspace", "1"], // after deletion of extra.tex
    ["workspace", "2"], // after atomic replacement of body.tex
    ["snapshot", "1"],
    ["commit", "1"],
  ])("recovers a real SIGKILL at %s hit %s in a restarted service", async (boundary, hit) => {
    const f = await fixture();
    const child = spawnSync(process.execPath, [
      join(process.cwd(), "node_modules", "vite-node", "vite-node.mjs"),
      join(process.cwd(), "test", "version", "restoreCrashChild.ts"),
      f.root, f.id, "1",
    ], { cwd: process.cwd(), env: { ...process.env, NODE_ENV: "test", PAPERTEAM_RESTORE_TEST_FAILURE: boundary, PAPERTEAM_RESTORE_TEST_HIT: hit, PAPERTEAM_RESTORE_TEST_EXIT: "1" }, timeout: 20_000 });
    expect(child.error).toBeUndefined();
    expect(child.status === 0).toBe(false);
    expect(await restarted(f.projects).restore(f.id, 1)).toEqual({ revision: 3, created: true, restoredFrom: 1 });
    expect((await restarted(f.projects).load(f.id)).revisions).toHaveLength(3);
  });
});
