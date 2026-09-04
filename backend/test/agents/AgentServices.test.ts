/**
 * ResearcherService / FeasibilityService 结构化校验测试（M3.1）。
 *
 * 用 fake Runtime 驱动真实服务：合法 JSON → 落盘 artifact + Evidence 追加；
 * 非法输出（非 JSON / 缺字段 / 非法 level）→ AgentRunFailedError。
 */

import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { AgentRunFailedError } from "../../src/errors.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";
import { EvidenceStore } from "../../src/evidence/EvidenceStore.js";
import { SourceStore } from "../../src/sources/SourceStore.js";
import { ResearcherService } from "../../src/agents/ResearcherService.js";
import { FeasibilityService, readFeasibilityReport } from "../../src/agents/FeasibilityService.js";
import type { AgentRuntime, AgentTask } from "../../src/runtime/types.js";
import { RESEARCH_JSON } from "../helpers/testStack.js";

const tempRoots: string[] = [];
afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

function runtimeReturning(output: () => string): AgentRuntime {
  const makeTask = (agentId: string): AgentTask => {
    const now = new Date().toISOString();
    return {
      taskId: "run-agent-test",
      agentId,
      status: "completed",
      createdAt: now,
      updatedAt: now,
      output: output(),
    };
  };
  return {
    provider: "pi",
    healthCheck: async () => ({
      ok: true,
      provider: "pi",
      status: "healthy",
      detail: "ok",
      latencyMs: 1,
      checkedAt: new Date().toISOString(),
    }),
    startAgent: async (input) => {
      const task = makeTask(input.agentId);
      return {
        taskId: task.taskId,
        sessionKey: `agent:${input.agentId}:paperteam-fake`,
        events: async function* () {},
        cancel: async () => {},
        result: async () => task,
      };
    },
    runAgent: async (input) => makeTask(input.agentId),
    getTask: () => {
      throw new Error("not implemented");
    },
    close: async () => {},
  };
}

async function newProject(meta: { researchIdea?: string; targetProfile?: string } = {}) {
  const root = await mkdtemp(join(tmpdir(), "paperteam-ag-"));
  tempRoots.push(root);
  const store = new ProjectStore({ root });
  const project = await store.create("Agent 服务测试", meta);
  return {
    store,
    projectId: project.id,
    root,
    evidence: new EvidenceStore(store),
    sources: new SourceStore(store),
  };
}

describe("ResearcherService", () => {
  it("合法调研输出：artifact 落盘、Evidence 以 unverified 追加、bibliography 去重", async () => {
    const ctx = await newProject({ researchIdea: "RAG 评估", targetProfile: "core_journal" });
    const researcher = new ResearcherService({
      runtime: runtimeReturning(() => RESEARCH_JSON),
      agentId: "researcher",
      projects: ctx.store,
      evidence: ctx.evidence,
      sources: ctx.sources,
      log: () => {},
    });
    const result = await researcher.research({ projectId: ctx.projectId });

    expect(result.report.researchGaps.length).toBeGreaterThan(0);
    expect(result.evidenceAppended).toBe(1);
    expect(result.bibliographyCount).toBe(1);

    const artifact = JSON.parse(
      await readFile(join(ctx.root, ctx.projectId, "research", "research.json"), "utf8"),
    ) as { report: { domainOverview: string }; bibliography: { key: string }[] };
    expect(artifact.report.domainOverview).toContain("检索增强生成");
    expect(artifact.bibliography[0]?.key).toBe("gao2023survey");

    const evidence = await ctx.evidence.list(ctx.projectId);
    expect(evidence).toHaveLength(1);
    expect(evidence[0]).toMatchObject({
      verificationStatus: "unverified",
      createdBy: "researcher",
    });
  });

  it("输出带说明文字 + 围栏包裹 JSON：仍可解析", async () => {
    const ctx = await newProject();
    const researcher = new ResearcherService({
      runtime: runtimeReturning(() => `调研结果如下：\n\`\`\`json\n${RESEARCH_JSON}\n\`\`\``),
      agentId: "researcher",
      projects: ctx.store,
      evidence: ctx.evidence,
      sources: ctx.sources,
      log: () => {},
    });
    const result = await researcher.research({ projectId: ctx.projectId });
    expect(result.report.researchQuestions.length).toBeGreaterThan(0);
  });

  it("非 JSON / 缺必需字段：抛 AgentRunFailedError，不落盘 artifact", async () => {
    const ctx = await newProject();
    const make = (output: string) =>
      new ResearcherService({
        runtime: runtimeReturning(() => output),
        agentId: "researcher",
        projects: ctx.store,
        evidence: ctx.evidence,
        sources: ctx.sources,
        log: () => {},
      });

    await expect(make("这不是 JSON").research({ projectId: ctx.projectId })).rejects.toBeInstanceOf(
      AgentRunFailedError,
    );
    const partial = JSON.stringify({ domainOverview: "只有概述" });
    await expect(make(partial).research({ projectId: ctx.projectId })).rejects.toBeInstanceOf(
      AgentRunFailedError,
    );
    // 失败路径不产生 artifact
    const artifact = await readFile(
      join(ctx.root, ctx.projectId, "research", "research.json"),
      "utf8",
    ).catch(() => null);
    expect(artifact).toBeNull();
  });

  it("非法 bibliography key（含非法字符）被丢弃，不影响其余产出", async () => {
    const ctx = await newProject();
    const withBadKey = JSON.parse(RESEARCH_JSON) as Record<string, unknown>;
    withBadKey["bibliography"] = [
      { key: "ok-key2024", title: "OK" },
      { key: "bad key!", title: "Bad" },
    ];
    const researcher = new ResearcherService({
      runtime: runtimeReturning(() => JSON.stringify(withBadKey)),
      agentId: "researcher",
      projects: ctx.store,
      evidence: ctx.evidence,
      sources: ctx.sources,
      log: () => {},
    });
    const result = await researcher.research({ projectId: ctx.projectId });
    expect(result.bibliographyCount).toBe(1);
  });
});

describe("FeasibilityService", () => {
  const research = {
    domainOverview: "RAG 领域概述",
    relatedWorkDirections: ["方向"],
    researchGaps: ["gap"],
    potentialContributions: ["贡献"],
    researchQuestions: ["问题"],
    literaturePlan: ["计划"],
  };

  async function assessWith(levelJson: string, meta: { targetProfile?: string } = {}) {
    const ctx = await newProject(meta);
    const service = new FeasibilityService({
      runtime: runtimeReturning(() => levelJson),
      agentId: "researcher",
      projects: ctx.store,
      log: () => {},
    });
    const result = await service.assess({
      projectId: ctx.projectId,
      research,
      evidenceStats: {
        total: 2,
        byStatus: { unverified: 1, verified: 1, plausible: 0, mismatch: 0, unverifiable: 0, not_found: 0 },
        contradictory: 0,
        skippedLines: 0,
      },
    });
    return { ctx, result };
  }

  const valid = (level: string, extra: Record<string, unknown> = {}) =>
    JSON.stringify({
      level,
      reasons: ["理由"],
      missingRequirements: [],
      researchGaps: [],
      requiredExperiments: [],
      evidenceGaps: [],
      recommendations: ["建议"],
      ...extra,
    });

  it("HIGH / MEDIUM 校验与落盘", async () => {
    const { ctx, result } = await assessWith(valid("HIGH"), { targetProfile: "core_journal" });
    expect(result.level).toBe("HIGH");
    const persisted = await readFeasibilityReport(ctx.store, ctx.projectId);
    expect(persisted?.report.level).toBe("HIGH");
    expect(persisted?.target.targetProfile).toBe("core_journal");
  });

  it("LOW / INSUFFICIENT：缺差距说明（missingRequirements 与 requiredExperiments 全空）被拒", async () => {
    await expect(assessWith(valid("INSUFFICIENT"))).rejects.toBeInstanceOf(AgentRunFailedError);
    const withGaps = valid("LOW", { missingRequirements: ["缺 Baseline"] });
    const { result } = await assessWith(withGaps);
    expect(result.level).toBe("LOW");
  });

  it("非法 level / 非 JSON 被拒", async () => {
    await expect(assessWith(valid("PROBABLY_83_PERCENT"))).rejects.toBeInstanceOf(AgentRunFailedError);
    await expect(assessWith("结论：大概可以")).rejects.toBeInstanceOf(AgentRunFailedError);
  });
});

describe("ProjectStore 研究定位字段", () => {
  it("创建时携带 / PATCH 更新 / 旧版 project.json 向后兼容", async () => {
    const ctx = await newProject({ researchIdea: "想法", targetProfile: "top_conference" });
    const created = await ctx.store.getRequired(ctx.projectId);
    expect(created.researchIdea).toBe("想法");
    expect(created.targetProfile).toBe("top_conference");

    const updated = await ctx.store.updateMeta(ctx.projectId, {
      targetProfile: "core_journal",
      targetVenue: "计算机学报",
    });
    expect(updated.targetProfile).toBe("core_journal");
    expect(updated.targetVenue).toBe("计算机学报");

    // 超长 / 非法值拒绝
    await expect(
      ctx.store.updateMeta(ctx.projectId, { researchField: "x".repeat(201) }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });

    // 旧版（无 M3 字段）project.json 可正常读取
    await expect(ctx.store.get(ctx.projectId)).resolves.toMatchObject({ id: ctx.projectId });
  });
});
