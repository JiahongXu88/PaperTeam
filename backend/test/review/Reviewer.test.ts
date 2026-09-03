/**
 * Reviewer / ReviewAggregator 测试（M3.2）：
 * 三 mode 结构化校验、contextScope 隔离、并行 fan-out、确定性聚合。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import {
  ReviewerService,
  parseModeReview,
  type ModeReviewResult,
} from "../../src/agents/ReviewerService.js";
import { aggregateReviews } from "../../src/review/ReviewAggregator.js";
import { AgentRunFailedError } from "../../src/errors.js";
import type { AgentRuntime, AgentTask } from "../../src/runtime/types.js";
import { makeAgentTask } from "../helpers/fakeRuntime.js";

const tempRoots: string[] = [];
afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

const FACT_OK = {
  summary: "可以。",
  claims: [
    { section: "sections/introduction.tex", claim: "c1", verdict: "SUPPORTED", evidenceId: "E001" },
    { section: "sections/method.tex", claim: "c2", verdict: "UNSUPPORTED" },
  ],
  issues: [
    {
      category: "fact",
      severity: "critical",
      section: "sections/method.tex",
      description: "无证据支撑",
      blocking: true,
    },
  ],
};

const ACADEMIC_OK = {
  summary: "尚可。",
  scores: { 问题定义: 82, 方法合理性: 80, 实验充分性: 75, 论证逻辑: 81, 写作质量: 84 },
  overallScore: 80,
  issues: [
    { category: "academic", severity: "major", section: "sections/experiments.tex", description: "缺少消融" },
  ],
};

const STYLE_OK = {
  summary: "文风一般。",
  riskScore: 40,
  issues: [
    { category: "style", severity: "minor", section: "sections/introduction.tex", description: "连接词滥用" },
  ],
};

describe("parseModeReview（结构化校验）", () => {
  it("fact：claims verdict 枚举校验、issues 结构校验", () => {
    const result = parseModeReview("fact", FACT_OK as never);
    expect(result.claims).toHaveLength(2);
    expect(result.claims?.[1]?.verdict).toBe("UNSUPPORTED");
    expect(result.issues[0]?.blocking).toBe(true);
  });

  it("academic：缺 scores 拒绝；overallScore 可从维度平均补全", () => {
    expect(() => parseModeReview("academic", { summary: "x", issues: [] })).toThrow(AgentRunFailedError);
    const noOverall = parseModeReview("academic", {
      summary: "x",
      scores: { a: 80, b: 90 },
      issues: [],
    });
    expect(noOverall.overallScore).toBe(85);
  });

  it("style：riskScore 越界拒绝", () => {
    expect(() => parseModeReview("style", { summary: "x", riskScore: 120, issues: [] })).toThrow(
      AgentRunFailedError,
    );
  });

  it("非法 severity / category 拒绝", () => {
    expect(() =>
      parseModeReview("fact", {
        summary: "x",
        issues: [{ category: "fact", severity: "fatal", section: "s", description: "d" }],
      }),
    ).toThrow(AgentRunFailedError);
  });
});

describe("ReviewerService（fake runtime）", () => {
  async function newService(
    script: (input: { agentId: string; contextScope?: string }) => string,
  ): Promise<{ service: ReviewerService; calls: { agentId: string; contextScope?: string }[]; projectId: string }> {
    const root = await mkdtemp(join(tmpdir(), "paperteam-rev-"));
    tempRoots.push(root);
    const store = new ProjectStore({ root });
    const project = await store.create("审稿测试");
    const calls: { agentId: string; contextScope?: string }[] = [];
    const runtime: AgentRuntime = {
      provider: "openclaw",
      healthCheck: async () => ({
        ok: true,
        provider: "openclaw",
        status: "healthy",
        detail: "ok",
        latencyMs: 1,
        checkedAt: new Date().toISOString(),
      }),
      runAgent: async (input) => {
        calls.push({ agentId: input.agentId, contextScope: input.contextScope });
        return makeAgentTask(script(input));
      },
      getTask: () => {
        throw new Error("not implemented");
      },
      cancelTask: () => {
        throw new Error("not implemented");
      },
      sendMessage: () => {
        throw new Error("not implemented");
      },
      streamEvents: () => {
        throw new Error("not implemented");
      },
    };
    return {
      service: new ReviewerService({ runtime, agentId: "reviewer", projects: store, log: () => {} }),
      calls,
      projectId: project.id,
    };
  }

  it("reviewAll 并行三路；三个 mode 使用独立 contextScope（会话隔离）", async () => {
    const { service, calls, projectId } = await newService((input) => {
      if (input.contextScope === "review/fact") return JSON.stringify(FACT_OK);
      if (input.contextScope === "review/academic") return JSON.stringify(ACADEMIC_OK);
      return JSON.stringify(STYLE_OK);
    });
    const results = await service.reviewAll({
      projectId,
      manuscriptDigest: "[main.tex]\n正文",
      evidence: [],
    });

    expect(results.map((result) => result.mode).sort()).toEqual(["academic", "fact", "style"]);
    const scopes = calls.map((call) => call.contextScope).sort();
    expect(scopes).toEqual(["review/academic", "review/fact", "review/style"]);
    // 不同 scope 派生不同 sessionKey 的行为在 contextScope.test.ts 已验证
    expect(new Set(scopes).size).toBe(3);
  });

  it("非 JSON 输出 → AgentRunFailedError", async () => {
    const { service, projectId } = await newService(() => "我认为这篇论文还不错");
    await expect(
      service.reviewMode({
        projectId,
        mode: "academic",
        manuscriptDigest: "x",
        evidence: [],
      }),
    ).rejects.toBeInstanceOf(AgentRunFailedError);
  });
});

describe("aggregateReviews（确定性聚合）", () => {
  const fact: ModeReviewResult = {
    mode: "fact",
    taskId: "t1",
    claims: [
      { section: "s", claim: "c", verdict: "UNSUPPORTED" },
      { section: "s", claim: "c2", verdict: "SUPPORTED" },
    ],
    issues: [
      {
        category: "fact",
        severity: "critical",
        section: "sections/method.tex",
        description: "无证据",
        blocking: true,
      },
    ],
    summary: "x",
  };
  const academic: ModeReviewResult = {
    mode: "academic",
    taskId: "t2",
    scores: { a: 70 },
    overallScore: 70,
    issues: [
      {
        category: "academic",
        severity: "major",
        section: "sections/experiments.tex",
        description: "缺少消融",
        blocking: false,
      },
      // 与 fact 完全相同的问题 → 去重
      {
        category: "fact",
        severity: "critical",
        section: "sections/method.tex",
        description: "无证据",
        blocking: true,
      },
    ],
    summary: "y",
  };
  const style: ModeReviewResult = {
    mode: "style",
    taskId: "t3",
    riskScore: 42,
    issues: [
      {
        category: "style",
        severity: "minor",
        section: "sections/introduction.tex",
        description: "模板化",
        blocking: false,
      },
    ],
    summary: "z",
  };

  it("计数 / 去重 / 评分汇总 / verdict 统计", () => {
    const summary = aggregateReviews([fact, academic, style], 1);
    expect(summary.issues).toHaveLength(3); // 4 条 - 1 条重复
    expect(summary.counts.critical).toBe(1);
    expect(summary.counts.major).toBe(1);
    expect(summary.counts.minor).toBe(1);
    expect(summary.counts.blocking).toBe(1);
    expect(summary.scores.academicScore).toBe(70);
    expect(summary.scores.styleRisk).toBe(42);
    expect(summary.scores.factVerdicts).toEqual({
      SUPPORTED: 1,
      PARTIALLY_SUPPORTED: 0,
      UNSUPPORTED: 1,
      CONTRADICTED: 0,
    });
    expect(summary.unsupportedCriticalClaims).toBe(1);
    expect(summary.openCritical).toBe(1);
    expect(summary.openMajor).toBe(1);
  });

  it("缺失 mode 时对应评分为 null（Gate 会如实判失败）", () => {
    const summary = aggregateReviews([fact], 1);
    expect(summary.scores.academicScore).toBeNull();
    expect(summary.scores.styleRisk).toBeNull();
  });
});
