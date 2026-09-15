/**
 * M5.6 长论文阶段执行超时（PAPERTEAM_PI_LONG_RUN_TIMEOUT_MS）：
 * Writer / 三路 Reviewer / 分章节 Reviewer / Researcher 以 RunAgentInput.timeoutMs 逐 run 覆盖；
 * 未配置时不传（沿用 Runtime 通用默认 300s），Runtime 全局超时契约不变。
 * 用 fake Runtime 捕获输入即可：不依赖各服务的输出解析（任务以 failed 收尾，服务抛错也无妨）。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ResearcherService } from "../../src/agents/ResearcherService.js";
import { ReviewerService } from "../../src/agents/ReviewerService.js";
import { EvidenceStore } from "../../src/evidence/EvidenceStore.js";
import { SectionReviewService } from "../../src/paper/SectionReviewService.js";
import type { SectionReviewContext } from "../../src/paper/ReviewContextBuilder.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";
import type { AgentRuntime, AgentTask, RunAgentInput } from "../../src/runtime/types.js";
import { SourceStore } from "../../src/sources/SourceStore.js";
import { WriterService } from "../../src/writer/WriterService.js";
import { buildServiceStack } from "../../src/serviceStack.js";
import { FeasibilityService } from "../../src/agents/FeasibilityService.js";
import type { ResearchReport } from "../../src/agents/ResearcherService.js";
import { RESEARCH_JSON } from "../helpers/testStack.js";

const tempRoots: string[] = [];
afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

function capturingRuntime(): { runtime: AgentRuntime; inputs: RunAgentInput[] } {
  const inputs: RunAgentInput[] = [];
  const failed = (agentId: string): AgentTask => {
    const now = new Date().toISOString();
    return { taskId: "t", agentId, status: "failed", createdAt: now, updatedAt: now, error: "fake" };
  };
  const runtime: AgentRuntime = {
    provider: "pi",
    healthCheck: async () => ({ ok: true, provider: "pi", status: "healthy", detail: "ok", latencyMs: 1, checkedAt: new Date().toISOString() }),
    startAgent: async (input) => {
      inputs.push(input);
      const task = failed(input.agentId);
      return { taskId: task.taskId, sessionKey: "s", events: async function* () {}, cancel: async () => {}, result: async () => task };
    },
    runAgent: async (input) => {
      inputs.push(input);
      return failed(input.agentId);
    },
    getTask: async (taskId) => failed(taskId),
    close: async () => {},
  };
  return { runtime, inputs };
}

async function stores(): Promise<{ projects: ProjectStore; evidence: EvidenceStore; sources: SourceStore; projectId: string }> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-longrun-"));
  tempRoots.push(root);
  const projects = new ProjectStore({ root });
  const project = await projects.create("长论文超时");
  return { projects, evidence: new EvidenceStore(projects), sources: new SourceStore(projects), projectId: project.id };
}

const swallow = async (task: Promise<unknown>) => {
  try {
    await task;
  } catch {
    // 服务对 failed 任务抛错是预期行为；本测试只看 Runtime 收到的输入
  }
};

describe("长论文阶段执行超时覆盖（RunAgentInput.timeoutMs）", () => {
  it("配置 runTimeoutMs 时：Writer / Reviewer / SectionReview / Researcher 逐 run 传 timeoutMs", async () => {
    const { runtime, inputs } = capturingRuntime();
    const { projects, evidence, sources, projectId } = await stores();
    const writer = new WriterService({ runtime, agentId: "main", runTimeoutMs: 900_000 });
    await swallow(writer.write({ projectId, prompt: "写一篇论文" }));
    await swallow(
      writer.reviseSection({
        projectId,
        section: { id: "intro", file: "intro.tex", title: "引言" },
        outline: { title: "t", sections: [] },
        currentLatex: "\\section{引言}",
        issues: [{ category: "academic", severity: "major", section: "intro", description: "x", blocking: false }],
        evidence: [],
        bibliography: [],
      }),
    );
    const reviewer = new ReviewerService({ runtime, agentId: "main", projects, runTimeoutMs: 900_000 });
    await swallow(reviewer.reviewMode({ projectId, mode: "fact", manuscriptDigest: "digest", evidence: [] }));
    const sectionReview = new SectionReviewService({ runtime, reviewerAgentId: "main", runTimeoutMs: 900_000 });
    await swallow(
      sectionReview.reviewSection({
        projectId,
        runId: "w-1",
        context: { sectionId: "sec01", contextScope: "review/section/sec01", prompt: "审阅" } as unknown as SectionReviewContext,
      }),
    );
    const researcher = new ResearcherService({ runtime, agentId: "main", projects, evidence, sources, runTimeoutMs: 900_000 });
    await swallow(researcher.research({ projectId }));

    expect(inputs.length).toBeGreaterThanOrEqual(5);
    for (const input of inputs) {
      expect(input.timeoutMs).toBe(900_000);
    }
  });

  it("未配置时不传 timeoutMs（沿用 Runtime 通用默认，不改全局契约）", async () => {
    const { runtime, inputs } = capturingRuntime();
    const { projects, projectId } = await stores();
    const writer = new WriterService({ runtime, agentId: "main" });
    await swallow(writer.write({ projectId, prompt: "写一篇论文" }));
    const reviewer = new ReviewerService({ runtime, agentId: "main", projects });
    await swallow(reviewer.reviewMode({ projectId, mode: "academic", manuscriptDigest: "digest", evidence: [] }));
    expect(inputs).toHaveLength(2);
    for (const input of inputs) {
      expect("timeoutMs" in input).toBe(false);
    }
  });

  it("buildServiceStack(longRunTimeoutMs) 只覆盖长论文服务；FeasibilityService 等短任务不受影响", async () => {
    const { runtime, inputs } = capturingRuntime();
    const { projects, projectId } = await stores();
    const stack = buildServiceStack({
      runtime,
      projects,
      agentIds: { writer: "main", researcher: "main", reviewer: "main", citation: "main" },
      longRunTimeoutMs: 1_200_000,
      citation: { metadataEnabled: false, scholarly: { providers: [] } },
      log: () => {},
    });
    await swallow(stack.writer.write({ projectId, prompt: "写一篇论文" }));
    await swallow(stack.reviewer.reviewMode({ projectId, mode: "style", manuscriptDigest: "digest", evidence: [] }));
    await swallow(stack.researcher.research({ projectId }));
    const feasibility = new FeasibilityService({ runtime, agentId: "main", projects });
    await swallow(
      feasibility.assess({
        projectId,
        research: JSON.parse(RESEARCH_JSON) as ResearchReport,
        evidenceStats: {
          total: 0,
          byStatus: { unverified: 0, verified: 0, plausible: 0, mismatch: 0, unverifiable: 0, not_found: 0 },
          contradictory: 0,
          skippedLines: 0,
        },
      }),
    );
    const longRun = inputs.slice(0, 3);
    expect(longRun.every((input) => input.timeoutMs === 1_200_000)).toBe(true);
    const short = inputs.slice(3);
    expect(short.length).toBeGreaterThanOrEqual(1);
    expect(short.every((input) => input.timeoutMs === undefined)).toBe(true);
  });
});
