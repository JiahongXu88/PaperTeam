/**
 * M13.5.4 工作区隔离（Workspace Guard）行为测试。
 *
 * 直接执行 Pi 官方工厂生成的受控工具（read / ls / find / grep / write / edit）：
 * 断言的是真实工具执行结果（不是 policy 纯函数的自说自话）——保证 Pi 的
 * operations 注入确实被遵守。
 */
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { ToolDefinition } from "@earendil-works/pi-coding-agent";

import {
  createWorkspaceGuardPolicy,
  createWorkspaceGuardTools,
  globToRegExp,
} from "../../src/runtime/pi/workspaceGuard.js";

let root: string;
let projectDir: string;
let skillDir: string;
let outsideFile: string;
let tools: Map<string, ToolDefinition>;

async function run(name: string, params: Record<string, unknown>): Promise<string> {
  const tool = tools.get(name);
  if (tool === undefined) throw new Error(`tool ${name} missing`);
  const result = await tool.execute("call-1", params as never, undefined, undefined, { cwd: projectDir } as never);
  return result.content
    .map((part) => (part.type === "text" ? part.text : "<image>"))
    .join("\n");
}

async function runError(name: string, params: Record<string, unknown>): Promise<string> {
  try {
    const text = await run(name, params);
    return `NO_ERROR:${text}`;
  } catch (error) {
    return error instanceof Error ? error.message : String(error);
  }
}

beforeAll(async () => {
  root = await mkdtemp(join(tmpdir(), "pt-guard-"));
  projectDir = join(root, "projects", "p-guard");
  skillDir = join(root, "skills", "academic-writing-zh");
  await mkdir(join(projectDir, "manuscript", "sections"), { recursive: true });
  await mkdir(join(projectDir, "experiments", "ep-1"), { recursive: true });
  await mkdir(join(projectDir, "workflow", "runs"), { recursive: true });
  await mkdir(join(projectDir, "sources", "papers"), { recursive: true });
  await mkdir(join(projectDir, "sources", "parsed"), { recursive: true });
  await mkdir(join(projectDir, "research"), { recursive: true });
  await mkdir(skillDir, { recursive: true });
  await writeFile(join(projectDir, "manuscript", "sections", "intro.tex"), "\\section{引言}\nIDSW baseline text 0.6117\n", "utf-8");
  await writeFile(join(projectDir, "manuscript", "main.tex"), "\\documentclass{article}\n", "utf-8");
  await writeFile(join(projectDir, "experiments", "ep-1", "manifest.json"), JSON.stringify({ secret: "0.6117 Confirmation13" }), "utf-8");
  await writeFile(join(projectDir, "workflow", "runs", "state.json"), JSON.stringify({ status: "running" }), "utf-8");
  await writeFile(join(projectDir, "sources", "papers", "S001-overall_metrics_abc.csv"), "split,IDSW\nConfirmation13,0.6117\n", "utf-8");
  await writeFile(join(projectDir, "sources", "parsed", "S001.document.json"), JSON.stringify({ value: 0.6117 }), "utf-8");
  await writeFile(join(projectDir, "sources", "papers", "S002-bytetrack.md"), "ByteTrack associates every detection box 0.6117\n", "utf-8");
  await writeFile(join(projectDir, "sources", "index.json"), JSON.stringify({ items: [] }), "utf-8");
  await writeFile(join(projectDir, "research", "research.json"), JSON.stringify({ report: {} }), "utf-8");
  await writeFile(join(skillDir, "SKILL.md"), "# skill\nreference text 0.6117\n", "utf-8");
  outsideFile = join(root, "secret-outside.txt");
  await writeFile(outsideFile, "api-key 0.6117", "utf-8");

  const policy = createWorkspaceGuardPolicy({ projectDir, readOnlyRoots: [skillDir], protectedSourceIds: ["S001"] });
  tools = new Map(
    createWorkspaceGuardTools(policy, { cwd: projectDir, toolNames: ["read", "ls", "find", "grep", "write", "edit"] }).map((tool) => [tool.name, tool]),
  );
});

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("M13.5.4 工作区隔离：policy", () => {
  it("项目内普通文件可读；experiments/ workflow/ 与实验包来源不可读；项目外不可读；skill 根只读", () => {
    const policy = createWorkspaceGuardPolicy({ projectDir, readOnlyRoots: [skillDir], protectedSourceIds: ["S001"] });
    expect(policy.canRead(join(projectDir, "manuscript", "sections", "intro.tex"))).toBe(true);
    expect(policy.canRead(join(projectDir, "research", "research.json"))).toBe(true);
    expect(policy.canRead(join(projectDir, "sources", "papers", "S002-bytetrack.md"))).toBe(true);
    expect(policy.canRead(join(projectDir, "experiments", "ep-1", "manifest.json"))).toBe(false);
    expect(policy.canRead(join(projectDir, "experiments"))).toBe(false);
    expect(policy.canRead(join(projectDir, "workflow", "runs", "state.json"))).toBe(false);
    expect(policy.canRead(join(projectDir, "sources", "papers", "S001-overall_metrics_abc.csv"))).toBe(false);
    expect(policy.canRead(join(projectDir, "sources", "parsed", "S001.document.json"))).toBe(false);
    expect(policy.canRead(join(projectDir, "sources", "papers", "S0010-other.md"))).toBe(true); // S0010 ≠ S001
    expect(policy.canRead(outsideFile)).toBe(false);
    expect(policy.canRead(join(skillDir, "SKILL.md"))).toBe(true);
    expect(policy.canWrite(join(skillDir, "SKILL.md"))).toBe(false);
    // 相对路径穿越同样被归一化后判定
    expect(policy.canRead(join(projectDir, "manuscript", "..", "experiments", "ep-1", "manifest.json"))).toBe(false);
    expect(policy.canRead(join(projectDir, "..", "..", "secret-outside.txt"))).toBe(false);
  });

  it("写边界：只允许 manuscript/ 下；protectAllSources 让整个 sources/ 不可见（fail closed）", () => {
    const policy = createWorkspaceGuardPolicy({ projectDir, protectedSourceIds: [] });
    expect(policy.canWrite(join(projectDir, "manuscript", "sections", "x.tex"))).toBe(true);
    expect(policy.canWrite(join(projectDir, "research", "notes.md"))).toBe(false);
    expect(policy.canWrite(join(projectDir, "experiments", "ep-1", "manifest.json"))).toBe(false);
    expect(policy.canWrite(outsideFile)).toBe(false);
    const closed = createWorkspaceGuardPolicy({ projectDir, protectedSourceIds: [], protectAllSources: true });
    expect(closed.canRead(join(projectDir, "sources", "papers", "S002-bytetrack.md"))).toBe(false);
    expect(closed.canRead(join(projectDir, "sources", "index.json"))).toBe(false);
    expect(closed.canRead(join(projectDir, "manuscript", "main.tex"))).toBe(true);
  });

  it("globToRegExp：** / * / ? / {a,b}", () => {
    expect(globToRegExp("**/*.tex").test("manuscript/sections/intro.tex")).toBe(true);
    expect(globToRegExp("*.tex").test("intro.tex")).toBe(true);
    expect(globToRegExp("*.tex").test("sections/intro.tex")).toBe(false);
    expect(globToRegExp("sections/*.{tex,bib}").test("sections/a.bib")).toBe(true);
    expect(globToRegExp("S00?.document.json").test("S001.document.json")).toBe(true);
    expect(globToRegExp("**/node_modules/**").test("a/node_modules/b.js")).toBe(true);
  });
});

describe("M13.5.4 工作区隔离：受控工具真实执行", () => {
  it("read：稿件可读；实验包 manifest / 实验包来源 / 运行状态 / 项目外 / 穿越 均被拒并说明原因；skill 文件可读", async () => {
    expect(await run("read", { path: "manuscript/sections/intro.tex" })).toContain("IDSW baseline text");
    expect(await run("read", { path: join(skillDir, "SKILL.md") })).toContain("reference text");
    for (const path of [
      "experiments/ep-1/manifest.json",
      "sources/papers/S001-overall_metrics_abc.csv",
      "sources/parsed/S001.document.json",
      "workflow/runs/state.json",
      outsideFile,
      "manuscript/../experiments/ep-1/manifest.json",
      "../../secret-outside.txt",
    ]) {
      const message = await runError("read", { path });
      expect(message, path).toContain("工作区隔离");
      expect(message, path).not.toContain("Confirmation13");
      expect(message, path).not.toContain("api-key");
    }
    // 非实验包来源照常可读
    expect(await run("read", { path: "sources/papers/S002-bytetrack.md" })).toContain("ByteTrack");
  });

  it("ls：根目录隐藏 experiments/ 与 workflow/；sources/papers 隐藏 S001-*；受保护目录本身不可列", async () => {
    const rootListing = await run("ls", { path: "." });
    expect(rootListing).toContain("manuscript");
    expect(rootListing).toContain("sources");
    expect(rootListing).not.toContain("experiments");
    expect(rootListing).not.toContain("workflow");
    const papers = await run("ls", { path: "sources/papers" });
    expect(papers).toContain("S002-bytetrack.md");
    expect(papers).not.toContain("S001-overall_metrics_abc.csv");
    const denied = await runError("ls", { path: "experiments" });
    expect(denied).not.toContain("ep-1");
  });

  it("find：结果不含受保护路径；受保护根直接 not found", async () => {
    const all = await run("find", { pattern: "**/*" });
    expect(all).toContain("manuscript/sections/intro.tex");
    expect(all).toContain("sources/papers/S002-bytetrack.md");
    expect(all).not.toContain("manifest.json");
    expect(all).not.toContain("S001-overall_metrics_abc.csv");
    expect(all).not.toContain("S001.document.json");
    expect(all).not.toContain("state.json");
    const csv = await run("find", { pattern: "**/*.csv" });
    expect(csv).toContain("No files found");
    const denied = await runError("find", { pattern: "*", path: "experiments" });
    expect(denied).toMatch(/Path not found|工作区隔离/);
  });

  it("grep：命中稿件与普通来源，绝不命中实验包来源 / manifest / 运行状态 / 项目外；glob 与 literal 生效", async () => {
    const hits = await run("grep", { pattern: "0\\.6117" });
    expect(hits).toContain("manuscript/sections/intro.tex:2:");
    expect(hits).toContain("sources/papers/S002-bytetrack.md:1:");
    expect(hits).not.toContain("manifest.json");
    expect(hits).not.toContain("S001-overall_metrics_abc.csv");
    expect(hits).not.toContain("S001.document.json");
    expect(hits).not.toContain("state.json");
    expect(hits).not.toContain("secret-outside");
    const onlyTex = await run("grep", { pattern: "0.6117", literal: true, glob: "*.tex" });
    expect(onlyTex).toContain("intro.tex");
    expect(onlyTex).not.toContain("bytetrack");
    const nothing = await run("grep", { pattern: "Confirmation13" });
    expect(nothing).toBe("No matches found");
    const denied = await runError("grep", { pattern: "0.6117", path: "experiments" });
    expect(denied).toContain("Path not found");
    const outside = await runError("grep", { pattern: "api-key", path: resolve(root) });
    expect(outside).toContain("Path not found");
  });

  it("write / edit：manuscript/ 下可写；research/、experiments/、项目外被拒", async () => {
    const target = "manuscript/sections/new.tex";
    await run("write", { path: target, content: "\\section{新章节}\n" });
    expect(await readFile(join(projectDir, target), "utf-8")).toContain("新章节");
    await run("edit", { path: target, edits: [{ oldText: "新章节", newText: "修订章节" }] });
    expect(await readFile(join(projectDir, target), "utf-8")).toContain("修订章节");
    for (const path of ["research/notes.md", "experiments/ep-1/manifest.json", "sources/papers/S002-bytetrack.md", outsideFile]) {
      const message = await runError("write", { path, content: "x" });
      expect(message, path).toContain("manuscript/");
    }
    const editDenied = await runError("edit", { path: "experiments/ep-1/manifest.json", edits: [{ oldText: "secret", newText: "x" }] });
    expect(editDenied).toContain("manuscript/");
    expect(await readFile(join(projectDir, "experiments", "ep-1", "manifest.json"), "utf-8")).toContain("secret");
  });

  it("只生成角色白名单内的工具", () => {
    const policy = createWorkspaceGuardPolicy({ projectDir, protectedSourceIds: [] });
    const names = createWorkspaceGuardTools(policy, { cwd: projectDir, toolNames: ["read", "grep", "find", "ls", "search_papers"] }).map((tool) => tool.name);
    expect(names.sort()).toEqual(["find", "grep", "ls", "read"]);
  });
});
