/**
 * M4.3.6 Skill Registry 测试：seed 安装（pin revision/LICENSE/PROVENANCE）、
 * Pi 兼容性（loadSkillsFromDir 可发现）、角色绑定、中文简介（Fake Runtime）、
 * stale 检测、HTTP API、PiRuntimeAdapter 注入 wiring。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { loadSkillsFromDir } from "@earendil-works/pi-coding-agent";

import { SkillRegistry } from "../../src/skills/SkillRegistry.js";
import { SkillSummaryService } from "../../src/skills/SkillSummaryService.js";
import type { AgentRuntime, AgentTask, RuntimeHealth } from "../../src/runtime/types.js";
import { PiRuntimeAdapter } from "../../src/runtime/PiRuntimeAdapter.js";
import { startTestStack, scriptedIdeaRuntime } from "../helpers/testStack.js";
import { sha256Hex } from "../../src/util/hash.js";

class FakeSummaryRuntime implements AgentRuntime {
  readonly provider = "pi" as const;
  calls = 0;
  fail = false;

  async healthCheck(): Promise<RuntimeHealth> {
    return {
      ok: true,
      provider: "pi",
      status: "healthy",
      detail: "fake",
      latencyMs: 1,
      checkedAt: new Date().toISOString(),
    };
  }

  async runAgent(input: { agentId: string; contextScope?: string; task: string }): Promise<AgentTask> {
    this.calls += 1;
    if (this.fail) {
      throw new Error("model unavailable");
    }
    const now = new Date().toISOString();
    return {
      taskId: `sum-${this.calls}`,
      agentId: input.agentId,
      status: "completed",
      createdAt: now,
      updatedAt: now,
      output: `这是用于测试的中文简介：说明 ${input.contextScope} 的用途与适用场景。`,
    };
  }

  async startAgent(input: Parameters<AgentRuntime["startAgent"]>[0]) {
    const task = await this.runAgent(input);
    return {
      taskId: task.taskId,
      sessionKey: "fake",
      events: async function* () {},
      cancel: async () => {},
      result: async () => task,
    };
  }

  async getTask(): Promise<AgentTask> {
    throw new Error("not implemented");
  }

  async close() {}
}

describe("M4.3.6 SkillRegistry（seed 安装 / provenance / 绑定 / Pi 兼容）", () => {
  let root: string;
  let registry: SkillRegistry;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "paperteam-skills-"));
    registry = new SkillRegistry({ storeRoot: root });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("ensureInstalled：两项 Academic Skill 入库，provenance/license 文件齐全", async () => {
    const installed = await registry.ensureInstalled();
    expect(installed.map((s) => s.id).sort()).toEqual(["paper-search", "verify-citations"]);
    for (const skill of installed) {
      expect(skill.sourceType).toBe("external");
      expect(skill.license).toBe("MIT");
      expect(skill.sourceRevision).toMatch(/^[0-9a-f]{40}$/);
      expect(skill.status).toBe("installed");
      expect(skill.summaryStatus).toBe("summary_pending");
    }
    const byId = new Map(installed.map((s) => [s.id, s]));
    expect(byId.get("verify-citations")!.sourceRepo).toBe(
      "Agents4Academia-AI/citation_verification",
    );
    expect(byId.get("paper-search")!.sourceRepo).toBe("openags/paper-search-mcp");
    expect(byId.get("paper-search")!.wrapperNote).toBeDefined();

    // provenance / license 文件随目录复制
    for (const id of ["paper-search", "verify-citations"]) {
      const dir = join(root, "installed", id);
      const license = await readFile(join(dir, "LICENSE"), "utf8");
      expect(license).toContain("MIT");
      const provenance = await readFile(join(dir, "PROVENANCE.md"), "utf8");
      expect(provenance).toContain("Pin revision");
    }
    // wrapper 保留上游原件
    const upstream = await readFile(join(root, "installed", "paper-search", "UPSTREAM_SKILL.md"), "utf8");
    expect(upstream).toContain("paper-search <command>");
  });

  it("contentHash 与 SKILL.md 一致；frontmatter 名称/描述解析正确", async () => {
    const skills = await registry.list();
    for (const skill of skills) {
      const skillMd = await readFile(join(root, skill.installedPath, "SKILL.md"), "utf8");
      expect(skill.contentHash).toBe(sha256Hex(skillMd));
    }
    const paperSearch = skills.find((s) => s.id === "paper-search")!;
    expect(paperSearch.name).toBe("paper-search");
    expect(paperSearch.originalDescription).toContain("20+ sources");
    const verify = skills.find((s) => s.id === "verify-citations")!;
    expect(verify.originalDescription).toContain("citations");
  });

  it("幂等：重复 ensureInstalled 不改 installedAt；绑定的 skill 目录正确", async () => {
    const before = await registry.list();
    await registry.ensureInstalled();
    const after = await registry.list();
    expect(after.map((s) => s.installedAt)).toEqual(before.map((s) => s.installedAt));

    // 角色绑定（progressive disclosure 的注入面）
    expect(registry.skillDirsForAgent("citation").sort()).toEqual([
      join(root, "installed", "paper-search"),
      join(root, "installed", "verify-citations"),
    ]);
    expect(registry.skillDirsForAgent("researcher")).toEqual([join(root, "installed", "paper-search")]);
    expect(registry.skillDirsForAgent("reviewer")).toEqual([join(root, "installed", "verify-citations")]);
    expect(registry.skillDirsForAgent("writer")).toEqual([]);
    expect(registry.bindings()).toContainEqual({ agentRole: "citation", skillIds: ["paper-search", "verify-citations"] });
  });

  it("Pi 兼容性：loadSkillsFromDir 能从 Skill Store 发现两个 skill（真实 SDK 发现）", () => {
    const { skills, diagnostics } = loadSkillsFromDir({
      dir: join(root, "installed"),
      source: "paperteam-store",
    });
    expect(skills.map((s) => s.name).sort()).toEqual(["paper-search", "verify-citations"]);
    expect(diagnostics.filter((d) => d.type === "error")).toHaveLength(0);
    expect(skills.every((s) => s.description.length > 20)).toBe(true);
  });

  it("SKILL.md 内容变化 → summary stale（已有 ok 简介时）", async () => {
    const { writeFile } = await import("node:fs/promises");
    await registry.saveSummary("verify-citations", "已生成的简介");
    expect((await registry.get("verify-citations"))!.summaryStatus).toBe("ok");
    const dir = join(root, "installed", "verify-citations");
    const original = await readFile(join(dir, "SKILL.md"), "utf8");
    await writeFile(join(dir, "SKILL.md"), original + "\n<!-- edited -->", "utf8");
    const skill = await registry.get("verify-citations");
    // 记录的 contentHash 与现场不符 → ok 简介变 stale
    expect(skill!.summaryStatus).toBe("stale");
    await registry.ensureInstalled(); // seed hash 不同 → 重装回 seed 内容
    const restored = await registry.get("verify-citations");
    expect(restored!.contentHash).toBe(sha256Hex(original));
  });
});

describe("M4.3.6 中文简介（SkillSummaryService + HTTP）", () => {
  let root: string;
  let registry: SkillRegistry;
  let runtime: FakeSummaryRuntime;
  let summaries: SkillSummaryService;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "paperteam-skills2-"));
    registry = new SkillRegistry({ storeRoot: root });
    await registry.ensureInstalled();
    runtime = new FakeSummaryRuntime();
    summaries = new SkillSummaryService({ registry, runtime, agentId: "researcher" });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("生成一次并持久化；再次调用零模型调用", async () => {
    const first = await summaries.generateMissing();
    expect(first.generated).toHaveLength(2);
    expect(first.failed).toHaveLength(0);
    expect(runtime.calls).toBe(2);

    const persisted = await registry.get("paper-search");
    expect(persisted!.chineseSummary).toContain("中文简介");
    expect(persisted!.summaryStatus).toBe("ok");

    const callsBefore = runtime.calls;
    await summaries.generateMissing();
    expect(runtime.calls).toBe(callsBefore); // 不重复烧 token
  });

  it("模型不可用 → summary_pending 保留，discovery 不失败", async () => {
    const failRoot = await mkdtemp(join(tmpdir(), "paperteam-skills3-"));
    try {
      const failRegistry = new SkillRegistry({ storeRoot: failRoot });
      await failRegistry.ensureInstalled();
      const failRuntime = new FakeSummaryRuntime();
      failRuntime.fail = true;
      const service = new SkillSummaryService({ registry: failRegistry, runtime: failRuntime, agentId: "r" });
      const result = await service.generateMissing();
      expect(result.failed).toHaveLength(2);
      const skills = await failRegistry.list();
      expect(skills.every((s) => s.summaryStatus === "summary_pending")).toBe(true);
      expect(skills.every((s) => s.chineseSummary === undefined)).toBe(true);
    } finally {
      await rm(failRoot, { recursive: true, force: true });
    }
  });

  it("HTTP：GET /api/skills、GET /api/skills/:id、POST /api/skills/:id/summary", async () => {
    const stack = await startTestStack(scriptedIdeaRuntime().runtime, {
      skills: { registry, summaries },
    });
    try {
      const list = await stack.request("GET", "/api/skills");
      expect(list.status).toBe(200);
      const skills = list.body["skills"] as Array<Record<string, unknown>>;
      expect(skills).toHaveLength(2);
      const verify = skills.find((s) => s["id"] === "verify-citations")!;
      expect(verify["license"]).toBe("MIT");
      expect(verify["chineseSummary"]).toContain("中文简介");

      const detail = await stack.request("GET", "/api/skills/verify-citations");
      expect(detail.status).toBe(200);
      expect((detail.body["skill"] as Record<string, unknown>)["sourceRevision"]).toMatch(/^[0-9a-f]{40}$/);

      const missing = await stack.request("GET", "/api/skills/no-such");
      expect(missing.status).toBe(404);

      const regenerate = await stack.request("POST", "/api/skills/paper-search/summary");
      expect(regenerate.status).toBe(200);
      expect((regenerate.body["skill"] as Record<string, unknown>)["summaryStatus"]).toBe("ok");
    } finally {
      await stack.cleanup();
    }
  });
});

describe("M4.3.6 PiRuntimeAdapter 注入 wiring（roleSkillDirs 按角色生效）", () => {
  it("会话创建时按 resolved role 查询 skill 目录（researcher/reviewer 得到各自绑定）", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-skill-agent-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pi-skill-ws-"));
    const queriedRoles: string[] = [];
    const createdRoles: string[] = [];
    const skillRoot = await mkdtemp(join(tmpdir(), "pi-skill-store-"));
    const registry = new SkillRegistry({ storeRoot: skillRoot });
    await registry.ensureInstalled();

    const adapter = new PiRuntimeAdapter({
      agentDir,
      workspaceRoot,
      modelRuntime: {
        getModel: () => ({ provider: "fake", id: "fake-1" }),
        hasConfiguredAuth: () => true,
        getError: () => undefined,
      } as never,
      model: { provider: "fake", id: "fake-1" } as never,
      roleSkillDirs: (role) => {
        queriedRoles.push(role);
        return registry.skillDirsForAgent(role);
      },
      createSession: async (params) => {
        createdRoles.push(params.role.role);
        return {
          prompt: async () => {},
          abort: async () => {},
          waitForIdle: async () => {},
          dispose: () => {},
          subscribe: () => () => {},
          getLastAssistantText: () => "ok",
          agent: { state: { messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }] } },
        } as never;
      },
      log: () => {},
    });
    try {
      await adapter.runAgent({ agentId: "researcher", task: "x", contextScope: "research/test" });
      await adapter.runAgent({ agentId: "reviewer", task: "y", contextScope: "review/section/sec01" });
      await adapter.runAgent({ agentId: "writer", task: "z", contextScope: "writing/draft" });
      expect(queriedRoles).toContain("researcher");
      expect(queriedRoles).toContain("reviewer");
      expect(queriedRoles).toContain("writer");
      expect(createdRoles).toEqual(["researcher", "reviewer", "writer"]);
    } finally {
      await adapter.close();
      await Promise.all([rm(agentDir, { recursive: true, force: true }), rm(workspaceRoot, { recursive: true, force: true }), rm(skillRoot, { recursive: true, force: true })]);
    }
  });
});
