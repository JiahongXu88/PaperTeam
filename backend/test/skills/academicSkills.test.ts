/**
 * M5.3 Controlled Academic Skill Integration 测试：
 * - seed 校验：immutable revision / LICENSE / PROVENANCE / 上游快照 hash；
 * - role + contextScope 路由：fact / academic / style Reviewer 不拿相同 Skill 集，
 *   Writer 普通写作 vs style-polish，researcher / citation 既有路由不退化，role-only 兼容；
 * - 会话级版本固定：generation 1 保持 hash A，更新后新 session / 新 generation 才拿到 B；
 * - assigned ≠ accessed：只有 read 工具真实命中 Skill 文件才记 accessed，无事件 → unknown；
 * - 受控 install / update：catalog、update available、diff preview、apply、任意 URL 不可用；
 * - Reviewer 仍只读；配置禁用不注入；HTTP API。
 */

import { cp, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PiRuntimeAdapter } from "../../src/runtime/PiRuntimeAdapter.js";
import { allRoleConfigs } from "../../src/runtime/pi/roleConfig.js";
import type { AgentTask } from "../../src/runtime/types.js";
import { SkillRegistry, defaultSeedsRoot } from "../../src/skills/SkillRegistry.js";
import { diffLines } from "../../src/skills/diff.js";
import {
  ALLOWED_CONTEXT_SCOPES,
  APPROVED_SKILL_IDS,
  DEFAULT_SKILL_ROUTES,
  resolveSkillIds,
} from "../../src/skills/routing.js";
import { skillContentHash } from "../../src/skills/types.js";
import { scriptedIdeaRuntime, startTestStack } from "../helpers/testStack.js";

const ACADEMIC_IDS = ["academic-review", "academic-style-zh", "academic-writing-zh"] as const;

const tempDirs: string[] = [];
async function tmp(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}
afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

/** 可变的 seed 副本（更新 / 篡改 / 非法 seed 场景） */
async function copySeeds(): Promise<string> {
  const seeds = await tmp("pt-seeds-");
  await cp(defaultSeedsRoot(), seeds, { recursive: true });
  return seeds;
}

type PiEvent = Record<string, unknown> & { type: string };

/** 假 Pi 会话：prompt 时按脚本发事件（订阅者 = adapter 的 wireSessionEvents） */
function fakeSession(script: () => PiEvent[]) {
  let listener: ((event: PiEvent) => void) | undefined;
  return {
    prompt: async () => {
      for (const event of script()) {
        listener?.(event);
      }
    },
    abort: async () => {},
    waitForIdle: async () => {},
    dispose: () => {},
    subscribe: (fn: (event: PiEvent) => void) => {
      listener = fn;
      return () => {
        listener = undefined;
      };
    },
    getLastAssistantText: () => "ok",
    agent: {
      state: {
        messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }],
      },
    },
  };
}

async function makeAdapter(
  registry: SkillRegistry,
  options: {
    script?: () => PiEvent[];
    maxRunsPerSession?: number;
    onCreate?: (skillPaths: string[]) => void;
  } = {},
): Promise<PiRuntimeAdapter> {
  const agentDir = await tmp("pi-m53-agent-");
  const workspaceRoot = await tmp("pi-m53-ws-");
  return new PiRuntimeAdapter({
    agentDir,
    workspaceRoot,
    modelRuntime: {
      getModel: () => ({ provider: "fake", id: "fake-1" }),
      hasConfiguredAuth: () => true,
      getError: () => undefined,
    } as never,
    model: { provider: "fake", id: "fake-1" } as never,
    ...(options.maxRunsPerSession !== undefined ? { maxRunsPerSession: options.maxRunsPerSession } : {}),
    roleSkills: (role, scope) => registry.skillAssignmentsFor(role, scope),
    createSession: async (params) => {
      const loader = params.resourceLoader as unknown as { additionalSkillPaths?: string[] };
      options.onCreate?.(loader.additionalSkillPaths ?? []);
      return fakeSession(options.script ?? (() => [])) as never;
    },
    log: () => {},
  });
}

describe("M5.3 路由：role + contextScope", () => {
  it("三个 Reviewer lens 不拿相同 Skill 集；分章节审阅拿 academic-review", () => {
    const fact = resolveSkillIds("reviewer", "review/fact");
    const academic = resolveSkillIds("reviewer", "review/academic");
    const style = resolveSkillIds("reviewer", "review/style");
    expect(fact).toEqual(["verify-citations"]);
    expect(academic).toEqual(["academic-review"]);
    expect(style).toEqual(["academic-style-zh"]);
    expect(new Set([fact.join(), academic.join(), style.join()]).size).toBe(3);
    expect(resolveSkillIds("reviewer", "review/section/sec01")).toEqual(["academic-review"]);
    // 三个 lens 都不会无脑加载三个学术 Skill
    for (const ids of [fact, academic, style]) {
      expect(ids.filter((id) => (ACADEMIC_IDS as readonly string[]).includes(id)).length).toBeLessThanOrEqual(1);
    }
  });

  it("Writer：普通写作 / revision 拿 academic-writing-zh；style-polish 追加 academic-style-zh；repair 无 Skill", () => {
    expect(resolveSkillIds("writer", "writing/sections")).toEqual(["academic-writing-zh"]);
    expect(resolveSkillIds("writer", "writing/outline")).toEqual(["academic-writing-zh"]);
    expect(resolveSkillIds("writer", "writing/revision")).toEqual(["academic-writing-zh"]);
    expect(resolveSkillIds("writer", "writing/style-polish")).toEqual(["academic-writing-zh", "academic-style-zh"]);
    expect(resolveSkillIds("writer", "writing/repair")).toEqual([]);
    expect(resolveSkillIds("writer")).toEqual(["academic-writing-zh"]); // legacy write()
  });

  it("researcher / citation 既有路由不退化；旧 role-only 调用继续有效；未知角色为空", () => {
    expect(resolveSkillIds("researcher", "research")).toEqual(["paper-search"]);
    expect(resolveSkillIds("researcher", "research/existing-analysis")).toEqual(["paper-search"]);
    expect(resolveSkillIds("researcher")).toEqual(["paper-search"]);
    expect(resolveSkillIds("citation", "citation/verify")).toEqual(["paper-search", "verify-citations"]);
    expect(resolveSkillIds("citation")).toEqual(["paper-search", "verify-citations"]);
    expect(resolveSkillIds("reviewer")).toEqual(["verify-citations"]); // M4.3 行为
    expect(resolveSkillIds("default")).toEqual([]);
    expect(resolveSkillIds("nobody", "review/style")).toEqual([]);
  });

  it("路由表只引用 approved catalog id；允许的 contextScope 集合稳定", () => {
    expect(APPROVED_SKILL_IDS).toEqual([...ACADEMIC_IDS, "paper-search", "verify-citations"]);
    expect(ALLOWED_CONTEXT_SCOPES).toContain("review/style");
    expect(ALLOWED_CONTEXT_SCOPES).toContain("writing/style-polish");
    for (const route of DEFAULT_SKILL_ROUTES) {
      expect(route.scopePrefix === undefined || ALLOWED_CONTEXT_SCOPES.includes(route.scopePrefix)).toBe(true);
    }
  });

  it("Reviewer 角色仍然没有 write / edit / shell 工具（Skill 接入不放宽权限）", () => {
    const configs = allRoleConfigs();
    for (const role of ["reviewer", "citation", "researcher"] as const) {
      expect(configs[role].tools).not.toContain("write");
      expect(configs[role].tools).not.toContain("edit");
      expect(configs[role].tools).not.toContain("bash");
      expect(configs[role].tools).not.toContain("powershell");
    }
    expect(configs.writer.tools).not.toContain("bash");
  });
});

describe("M5.3 seed 校验（immutable revision / LICENSE / PROVENANCE / 上游快照）", () => {
  async function registryWithBrokenSeed(mutate: (seedDir: string) => Promise<void>): Promise<SkillRegistry> {
    const seeds = await copySeeds();
    await mutate(join(seeds, "academic-review"));
    return new SkillRegistry({ storeRoot: await tmp("pt-store-"), seedsRoot: seeds });
  }

  it("sourceRevision 不是完整 SHA（main / latest / v2）→ 拒绝安装，其余 skill 不受影响", async () => {
    for (const bad of ["main", "latest", "v2", "0b2afe6"]) {
      const registry = await registryWithBrokenSeed(async (dir) => {
        const json = JSON.parse(await readFile(join(dir, "skill.json"), "utf8")) as Record<string, unknown>;
        json["sourceRevision"] = bad;
        await writeFile(join(dir, "skill.json"), JSON.stringify(json), "utf8");
      });
      const installed = await registry.ensureInstalled();
      expect(installed.map((s) => s.id)).not.toContain("academic-review");
      expect(installed).toHaveLength(4);
      expect((await registry.catalog()).map((entry) => entry.id)).not.toContain("academic-review");
      await expect(registry.install("academic-review")).rejects.toThrow(/immutable commit SHA/);
    }
  });

  it("缺少 LICENSE → 拒绝；缺少 PROVENANCE.md → 拒绝", async () => {
    const noLicense = await registryWithBrokenSeed((dir) => rm(join(dir, "LICENSE")));
    expect((await noLicense.ensureInstalled()).map((s) => s.id)).not.toContain("academic-review");
    await expect(noLicense.install("academic-review")).rejects.toThrow(/LICENSE/);

    const noProvenance = await registryWithBrokenSeed((dir) => rm(join(dir, "PROVENANCE.md")));
    expect((await noProvenance.ensureInstalled()).map((s) => s.id)).not.toContain("academic-review");
    await expect(noProvenance.install("academic-review")).rejects.toThrow(/PROVENANCE/);
  });

  it("上游快照 UPSTREAM_SKILL.md 与记录 hash 不一致 → 拒绝（审计材料被改写）", async () => {
    const registry = await registryWithBrokenSeed((dir) =>
      writeFile(join(dir, "UPSTREAM_SKILL.md"), "# tampered upstream\n", "utf8"),
    );
    await expect(registry.install("academic-review")).rejects.toThrow(/UPSTREAM_SKILL\.md hash/);
  });

  it("仓库内三个学术 seed 的 provenance 记录完整：40 位 SHA、上游路径、LICENSE 版权、快照 hash 一致", async () => {
    const registry = new SkillRegistry({ storeRoot: await tmp("pt-store-") });
    await registry.ensureInstalled();
    const expected: Record<string, { repo: string; sha: string; path: string }> = {
      "academic-writing-zh": {
        repo: "K-Dense-AI/scientific-agent-skills",
        sha: "0b2afe68a5f9379097ad815e028af664f1e222b7",
        path: "skills/scientific-writing/SKILL.md",
      },
      "academic-review": {
        repo: "K-Dense-AI/scientific-agent-skills",
        sha: "0b2afe68a5f9379097ad815e028af664f1e222b7",
        path: "skills/peer-review/SKILL.md",
      },
      "academic-style-zh": { repo: "op7418/Humanizer-zh", sha: "91f3d394db8419c20d67ebe22a96cf8fee0a404b", path: "SKILL.md" },
    };
    for (const id of ACADEMIC_IDS) {
      const skill = (await registry.get(id))!;
      expect(skill.sourceRepo).toBe(expected[id]!.repo);
      expect(skill.sourceRevision).toBe(expected[id]!.sha);
      expect(skill.upstreamPath).toBe(expected[id]!.path);
      expect(skill.purpose).toBeTruthy();
      expect(skill.wrapperNote).toContain("PaperTeam");
      const provenance = await registry.provenance(id);
      expect(provenance.provenance).toContain(expected[id]!.sha);
      expect(provenance.license).toContain("MIT License");
      expect(provenance.license).toMatch(/Copyright \(c\) 20\d\d/);
      expect(provenance.upstreamSnapshot?.matchesRecorded).toBe(true);
      // Skill 正文不把上游论文引用塞进用户论文
      const skillMd = await readFile(join(registry.versionDir(id, skill.contentHash), "SKILL.md"), "utf8");
      expect(skillMd).toMatch(/不(要|会|得)[\s\S]{0,40}(参考文献|bibliography)/);
    }
  });
});

describe("M5.3 受控 install / update / 版本固定", () => {
  it("已安装 skill 的 seed 变化：不自动应用，只标 update available；预览含 hash / revision / 文件 diff；应用后新快照、旧快照保留", async () => {
    const seeds = await copySeeds();
    const store = await tmp("pt-store-");
    const registry = new SkillRegistry({ storeRoot: store, seedsRoot: seeds });
    await registry.ensureInstalled();
    const before = (await registry.get("academic-style-zh"))!;
    expect(before.update?.available).toBe(false);

    const seedDir = join(seeds, "academic-style-zh");
    const skillMd = await readFile(join(seedDir, "SKILL.md"), "utf8");
    await writeFile(join(seedDir, "SKILL.md"), skillMd + "\n## 8. 新增章节\n\n新规则。\n", "utf8");
    await writeFile(join(seedDir, "NOTES.md"), "extra audit note\n", "utf8");

    await registry.ensureInstalled(); // 受控：不自动应用
    const pending = (await registry.get("academic-style-zh"))!;
    expect(pending.contentHash).toBe(before.contentHash);
    expect(pending.update?.available).toBe(true);
    expect(pending.update?.candidateHash).not.toBe(before.contentHash);
    expect(registry.skillDirsForAgent("reviewer", "review/style")).toEqual([
      registry.versionDir("academic-style-zh", before.contentHash),
    ]);

    const preview = await registry.previewUpdate("academic-style-zh");
    expect(preview.currentHash).toBe(before.contentHash);
    expect(preview.candidateHash).toBe(pending.update!.candidateHash);
    expect(preview.currentRevision).toBe("91f3d394db8419c20d67ebe22a96cf8fee0a404b");
    expect(preview.candidateRevision).toBe("91f3d394db8419c20d67ebe22a96cf8fee0a404b");
    expect(preview.files.find((f) => f.path === "SKILL.md")?.status).toBe("modified");
    expect(preview.files.find((f) => f.path === "NOTES.md")?.status).toBe("added");
    expect(preview.files.find((f) => f.path === "LICENSE")?.status).toBe("unchanged");
    expect(preview.skillMdDiff.added).toBeGreaterThanOrEqual(3);
    expect(preview.skillMdDiff.removed).toBe(0);
    expect(preview.skillMdDiff.hunks.some((line) => line.includes("新增章节"))).toBe(true);

    const applied = await registry.applyUpdate("academic-style-zh");
    expect(applied.contentHash).toBe(preview.candidateHash);
    expect(applied.update?.available).toBe(false);
    expect(applied.integrity).toBe("ok");
    expect(applied.installedAt).toBe(before.installedAt);
    // 新旧快照并存（运行中的会话仍指向旧快照）
    expect(await readFile(join(registry.versionDir("academic-style-zh", before.contentHash), "SKILL.md"), "utf8")).toBe(
      skillMd,
    );
    expect(
      skillContentHash(await readFile(join(registry.versionDir("academic-style-zh", applied.contentHash), "SKILL.md"), "utf8")),
    ).toBe(applied.contentHash);
    expect(registry.skillDirsForAgent("reviewer", "review/style")).toEqual([
      registry.versionDir("academic-style-zh", applied.contentHash),
    ]);
    // 幂等
    expect((await registry.applyUpdate("academic-style-zh")).contentHash).toBe(applied.contentHash);
  });

  it("install：只接受 approved catalog 的 id；未安装项可安装；未知 id 404 语义", async () => {
    const seeds = await copySeeds();
    await rm(join(seeds, "academic-writing-zh"), { recursive: true });
    const registry = new SkillRegistry({ storeRoot: await tmp("pt-store-"), seedsRoot: seeds });
    await registry.ensureInstalled();
    expect((await registry.list()).map((s) => s.id)).not.toContain("academic-writing-zh");
    await expect(registry.install("academic-writing-zh")).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(registry.install("https://github.com/x/y")).rejects.toMatchObject({ code: "NOT_FOUND" });
    // 把 seed 放回 catalog 后可安装
    await cp(join(defaultSeedsRoot(), "academic-writing-zh"), join(seeds, "academic-writing-zh"), { recursive: true });
    const catalog = await registry.catalog();
    expect(catalog.find((entry) => entry.id === "academic-writing-zh")?.installed).toBe(false);
    const installed = await registry.install("academic-writing-zh");
    expect(installed.status).toBe("installed");
    expect(registry.skillDirsForAgent("writer", "writing/sections")).toEqual([
      registry.versionDir("academic-writing-zh", installed.contentHash),
    ]);
  });

  it("配置禁用（PAPERTEAM_DISABLED_SKILLS）：仍可见但不注入", async () => {
    const registry = new SkillRegistry({
      storeRoot: await tmp("pt-store-"),
      disabledSkillIds: ["academic-writing-zh", "academic-style-zh"],
    });
    await registry.ensureInstalled();
    expect((await registry.get("academic-writing-zh"))!.disabledByConfig).toBe(true);
    expect(registry.skillDirsForAgent("writer", "writing/sections")).toEqual([]);
    expect(registry.skillDirsForAgent("writer", "writing/style-polish")).toEqual([]);
    expect(registry.skillDirsForAgent("reviewer", "review/academic")).toHaveLength(1);
  });

  it("diffLines：有界行级 diff 计数正确", () => {
    const diff = diffLines("a\nb\nc\n", "a\nx\nc\nd\n");
    expect(diff.added).toBe(2);
    expect(diff.removed).toBe(1);
    expect(diff.hunks).toEqual(["- b", "+ x", "+ d"]);
    expect(diff.truncated).toBe(false);
  });
});

describe("M5.3 会话级 Skill 版本固定 + assigned ≠ accessed（PiRuntimeAdapter）", () => {
  it("generation 1 保持 hash A；更新后同会话仍 A，新 session 得 B，rotation 后新 generation 得 B", async () => {
    const seeds = await copySeeds();
    const registry = new SkillRegistry({ storeRoot: await tmp("pt-store-"), seedsRoot: seeds });
    await registry.ensureInstalled();
    const hashA = (await registry.get("academic-writing-zh"))!.contentHash;
    const injected: string[][] = [];
    const adapter = await makeAdapter(registry, { maxRunsPerSession: 2, onCreate: (paths) => injected.push(paths) });
    try {
      const run = (scope: string): Promise<AgentTask> =>
        adapter.runAgent({ agentId: "writer", projectId: "p-pin", task: "写", contextScope: scope });

      const first = await run("writing/sections");
      expect(first.skills?.assigned).toEqual([
        { id: "academic-writing-zh", sourceRevision: "0b2afe68a5f9379097ad815e028af664f1e222b7", contentHash: hashA },
      ]);
      expect(injected[0]).toEqual([registry.versionDir("academic-writing-zh", hashA)]);

      // 更新 seed 并应用：产生 hash B
      const seedDir = join(seeds, "academic-writing-zh");
      await writeFile(join(seedDir, "SKILL.md"), (await readFile(join(seedDir, "SKILL.md"), "utf8")) + "\n更新 B\n", "utf8");
      const updated = await registry.applyUpdate("academic-writing-zh");
      const hashB = updated.contentHash;
      expect(hashB).not.toBe(hashA);

      // 同会话 generation 1：仍固定 A（第 2 个 run，runCount 达上限但 rotation 在下一边界）
      const second = await run("writing/sections");
      expect(second.skills?.assigned[0]?.contentHash).toBe(hashA);
      const diagAfterSecond = adapter.sessionDiagnostics().find((s) => s.contextScope === "writing/sections")!;
      expect(diagAfterSecond.generation).toBe(1);
      expect(diagAfterSecond.assignedSkills?.[0]?.contentHash).toBe(hashA);

      // 新 session（不同 scope）：直接拿 B
      const other = await run("writing/revision");
      expect(other.skills?.assigned[0]?.contentHash).toBe(hashB);

      // 同会话第 3 个 run：安全边界 rotation → generation 2 → B
      const third = await run("writing/sections");
      expect(third.skills?.assigned[0]?.contentHash).toBe(hashB);
      const diagAfterThird = adapter.sessionDiagnostics().find((s) => s.contextScope === "writing/sections")!;
      expect(diagAfterThird.generation).toBe(2);
      expect(diagAfterThird.assignedSkills?.[0]?.contentHash).toBe(hashB);
      // 旧快照仍在磁盘（generation 1 若还在运行不会读到空目录）
      await expect(readFile(join(registry.versionDir("academic-writing-zh", hashA), "SKILL.md"), "utf8")).resolves.toContain(
        "academic-writing-zh",
      );
    } finally {
      await adapter.close();
    }
  });

  it("三个 Reviewer 会话注入不同 Skill；style-polish Writer 注入两个", async () => {
    const registry = new SkillRegistry({ storeRoot: await tmp("pt-store-") });
    await registry.ensureInstalled();
    const adapter = await makeAdapter(registry);
    try {
      const results = await Promise.all(
        ["review/fact", "review/academic", "review/style"].map((scope) =>
          adapter.runAgent({ agentId: "reviewer", projectId: "p-r", task: "审", contextScope: scope }),
        ),
      );
      expect(results.map((task) => task.skills!.assigned.map((s) => s.id))).toEqual([
        ["verify-citations"],
        ["academic-review"],
        ["academic-style-zh"],
      ]);
      const polish = await adapter.runAgent({
        agentId: "writer",
        projectId: "p-r",
        task: "润色",
        contextScope: "writing/style-polish",
      });
      expect(polish.skills!.assigned.map((s) => s.id)).toEqual(["academic-writing-zh", "academic-style-zh"]);
      for (const task of [...results, polish]) {
        expect(task.metadata?.["role"]).toBeDefined();
        for (const skill of task.skills!.assigned) {
          expect(skill.contentHash).toMatch(/^[0-9a-f]{64}$/);
          expect(skill.sourceRevision).toMatch(/^[0-9a-f]{40}$/);
        }
      }
    } finally {
      await adapter.close();
    }
  });

  it("accessed 只在 read 工具真实命中 Skill 文件时记录；无任何事件 → accessBasis=unknown、accessed=null", async () => {
    const registry = new SkillRegistry({ storeRoot: await tmp("pt-store-") });
    await registry.ensureInstalled();
    const skillDir = registry.skillDirsForAgent("writer", "writing/sections")[0]!;
    let mode: "read-skill" | "read-other" | "silent" = "silent";
    const adapter = await makeAdapter(registry, {
      script: () => {
        if (mode === "silent") {
          return [];
        }
        const path = mode === "read-skill" ? join(skillDir, "SKILL.md") : "manuscript/main.tex";
        return [
          { type: "tool_execution_start", toolCallId: "t1", toolName: "read", args: { path } },
          { type: "tool_execution_end", toolCallId: "t1", toolName: "read", isError: false },
          { type: "tool_execution_start", toolCallId: "t2", toolName: "grep", args: { pattern: "x", path: skillDir } },
          { type: "tool_execution_end", toolCallId: "t2", toolName: "grep", isError: false },
        ];
      },
    });
    try {
      const run = (): Promise<AgentTask> =>
        adapter.runAgent({ agentId: "writer", projectId: "p-acc", task: "写", contextScope: "writing/sections" });

      mode = "silent";
      const silent = await run();
      expect(silent.skills?.assigned.map((s) => s.id)).toEqual(["academic-writing-zh"]);
      expect(silent.skills?.accessBasis).toBe("unknown");
      expect(silent.skills?.accessed).toBeNull();

      mode = "read-other";
      const other = await run();
      expect(other.skills?.accessBasis).toBe("tool_events");
      expect(other.skills?.accessed).toEqual([]); // grep 命中 skill 目录不算读取

      mode = "read-skill";
      const hit = await run();
      expect(hit.skills?.accessBasis).toBe("tool_events");
      expect(hit.skills?.accessed).toEqual(["academic-writing-zh"]);
    } finally {
      await adapter.close();
    }
  });
});

describe("M5.3 HTTP API（approved catalog / install / update / provenance；无任意 URL 安装）", () => {
  it("GET /api/skills 含 catalog + role/contextScope bindings；POST /api/skills 不存在；install 拒绝 url", async () => {
    const seeds = await copySeeds();
    await rm(join(seeds, "academic-review"), { recursive: true }); // 先不在 catalog
    const registry = new SkillRegistry({ storeRoot: await tmp("pt-store-"), seedsRoot: seeds });
    await registry.ensureInstalled();
    const stack = await startTestStack(scriptedIdeaRuntime().runtime, { skills: { registry } });
    try {
      const list = await stack.request("GET", "/api/skills");
      expect(list.status).toBe(200);
      const skills = list.body["skills"] as Array<Record<string, unknown>>;
      expect(skills.map((s) => s["id"])).toEqual(["academic-style-zh", "academic-writing-zh", "paper-search", "verify-citations"]);
      const styleSkill = skills.find((s) => s["id"] === "academic-style-zh")!;
      expect(styleSkill["integrity"]).toBe("ok");
      expect((styleSkill["update"] as Record<string, unknown>)["available"]).toBe(false);
      const bindings = list.body["bindings"] as Array<Record<string, unknown>>;
      expect(bindings).toContainEqual({ agentRole: "reviewer", contextScope: "review/style", skillIds: ["academic-style-zh"] });
      expect(bindings).toContainEqual({
        agentRole: "writer",
        contextScope: "writing/style-polish",
        skillIds: ["academic-writing-zh", "academic-style-zh"],
      });
      expect(list.body["allowedContextScopes"]).toEqual(ALLOWED_CONTEXT_SCOPES);
      const catalog = list.body["catalog"] as Array<Record<string, unknown>>;
      expect(catalog.map((entry) => entry["id"])).not.toContain("academic-review");

      // 开放安装面不存在
      const arbitrary = await stack.request("POST", "/api/skills", { url: "https://github.com/evil/skill" });
      expect(arbitrary.status).toBe(405);
      const notApproved = await stack.request("POST", "/api/skills/academic-review/install");
      expect(notApproved.status).toBe(404);
      const withUrl = await stack.request("POST", "/api/skills/academic-style-zh/install", { url: "https://x" });
      expect(withUrl.status).toBe(400);

      // seed 回到 catalog → 可安装
      await cp(join(defaultSeedsRoot(), "academic-review"), join(seeds, "academic-review"), { recursive: true });
      const afterCatalog = await stack.request("GET", "/api/skills");
      const entry = (afterCatalog.body["catalog"] as Array<Record<string, unknown>>).find((e) => e["id"] === "academic-review")!;
      expect(entry["installed"]).toBe(false);
      const install = await stack.request("POST", "/api/skills/academic-review/install");
      expect(install.status).toBe(201);
      expect((install.body["skill"] as Record<string, unknown>)["status"]).toBe("installed");

      // provenance
      const provenance = await stack.request("GET", "/api/skills/academic-review/provenance");
      expect(provenance.status).toBe(200);
      const prov = provenance.body["provenance"] as Record<string, unknown>;
      expect(prov["provenance"]).toContain("0b2afe68a5f9379097ad815e028af664f1e222b7");
      expect(prov["license"]).toContain("K-Dense");
    } finally {
      await stack.cleanup();
    }
  });

  it("update-preview / update：候选 hash 不一致 400；应用后 hash 切换", async () => {
    const seeds = await copySeeds();
    const registry = new SkillRegistry({ storeRoot: await tmp("pt-store-"), seedsRoot: seeds });
    await registry.ensureInstalled();
    const stack = await startTestStack(scriptedIdeaRuntime().runtime, { skills: { registry } });
    try {
      const noUpdate = await stack.request("GET", "/api/skills/academic-review/update-preview");
      expect(noUpdate.status).toBe(200);
      const p0 = noUpdate.body["preview"] as Record<string, unknown>;
      expect(p0["currentHash"]).toBe(p0["candidateHash"]);

      const seedDir = join(seeds, "academic-review");
      await writeFile(join(seedDir, "SKILL.md"), (await readFile(join(seedDir, "SKILL.md"), "utf8")) + "\n新规则\n", "utf8");
      const detail = await stack.request("GET", "/api/skills/academic-review");
      const update = (detail.body["skill"] as Record<string, unknown>)["update"] as Record<string, unknown>;
      expect(update["available"]).toBe(true);

      const preview = await stack.request("GET", "/api/skills/academic-review/update-preview");
      const p1 = preview.body["preview"] as Record<string, unknown>;
      expect(p1["currentHash"]).not.toBe(p1["candidateHash"]);
      expect((p1["skillMdDiff"] as Record<string, unknown>)["added"]).toBeGreaterThan(0);

      const stale = await stack.request("POST", "/api/skills/academic-review/update", { candidateHash: "deadbeef".repeat(8) });
      expect(stale.status).toBe(400);
      const apply = await stack.request("POST", "/api/skills/academic-review/update", { candidateHash: p1["candidateHash"] });
      expect(apply.status).toBe(200);
      const skill = apply.body["skill"] as Record<string, unknown>;
      expect(skill["contentHash"]).toBe(p1["candidateHash"]);
      expect((skill["update"] as Record<string, unknown>)["available"]).toBe(false);

      const unknown = await stack.request("GET", "/api/skills/nope/update-preview");
      expect(unknown.status).toBe(404);
    } finally {
      await stack.cleanup();
    }
  });
});
