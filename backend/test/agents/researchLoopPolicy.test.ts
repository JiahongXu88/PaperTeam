/**
 * Research Loop Policy 测试（M8.3.3 任务八-5）：
 * - 模型校验：缺省值 / 越界（0 / 负数 / 非整数 / 超上限）→ 400 INVALID_REQUEST；
 * - stopConditions：已知枚举子集、去重保序、空数组 / 未知条目 → 400；
 * - 读取自愈：落盘值形状非法时回默认（读侧不抛错）；无 artifact → 默认值；
 * - 持久化：PUT 校验后写入 research.json 顶层 loopPolicy 字段，计划链 /
 *   gaps 决策 / 报告字段不受影响；无 artifact → 404。
 * - 边界声明：M8.3.3 不自动执行循环（本文件只测规则保存与校验，无执行路径）。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import {
  DEFAULT_RESEARCH_LOOP_POLICY,
  MAX_LOOP_ITERATIONS_LIMIT,
  MAX_LOOP_QUERIES_PER_ITERATION_LIMIT,
  getResearchLoopPolicy,
  parseResearchLoopPolicy,
  readResearchLoopPolicyFrom,
  updateResearchLoopPolicy,
} from "../../src/agents/researchLoopPolicy.js";
import type { ResearchLoopPolicy } from "../../src/agents/researchLoopPolicy.js";

const tempRoots: string[] = [];
afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function newProject(title: string): Promise<{ store: ProjectStore; projectId: string }> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-loop-"));
  tempRoots.push(root);
  const store = new ProjectStore({ root });
  const project = await store.create(title, { researchIdea: "Transformer MOT" });
  return { store, projectId: project.id };
}

async function seedArtifact(store: ProjectStore, projectId: string, artifact: Record<string, unknown>) {
  const researchDir = store.researchDir(projectId);
  await import("node:fs/promises").then((fs) => fs.mkdir(researchDir, { recursive: true }));
  await writeFile(join(researchDir, "research.json"), JSON.stringify(artifact, null, 2) + "\n", "utf8");
}

function seededArtifact(): Record<string, unknown> {
  return {
    generatedAt: "2026-09-20T08:00:00.000Z",
    taskId: "run-seed",
    plan: {
      planId: "rp-seed00000001",
      status: "done",
      questions: ["Transformer tracking 的发展脉络"],
      queries: [
        { queryId: "q-1", query: "transformer tracking survey", kind: "academic", status: "executed", resultCount: 5 },
      ],
      createdAt: "2026-09-20T08:00:00.000Z",
      updatedAt: "2026-09-20T08:00:00.000Z",
    },
    gaps: [{ gapId: "gap-aaaaaaaaaaaa", planId: "rp-seed00000001", description: "d", severity: "low", suggestedQueries: ["q"], status: "accepted", createdAt: "2026-09-20T08:00:00.000Z", decidedAt: "2026-09-20T09:00:00.000Z" }],
    report: {
      domainOverview: "调研概述",
      relatedWorkDirections: [],
      researchGaps: ["gap"],
      potentialContributions: ["贡献"],
      researchQuestions: [],
      literaturePlan: [],
    },
    evidence: [],
    bibliography: [],
  };
}

describe("parseResearchLoopPolicy（模型校验）", () => {
  it("缺省策略：maxIterations=5 / maxQueriesPerIteration=20 / 三个停止条件全开", () => {
    expect(DEFAULT_RESEARCH_LOOP_POLICY).toEqual({
      maxIterations: 5,
      maxQueriesPerIteration: 20,
      stopConditions: ["no_new_coverage", "budget_exceeded", "iteration_limit"],
    });
    expect(parseResearchLoopPolicy({})).toEqual(DEFAULT_RESEARCH_LOOP_POLICY);
  });

  it("合法覆盖：各字段可独立提供；stopConditions 子集 + 去重保序", () => {
    expect(parseResearchLoopPolicy({ maxIterations: 3 })).toEqual({
      ...DEFAULT_RESEARCH_LOOP_POLICY,
      maxIterations: 3,
    });
    expect(
      parseResearchLoopPolicy({
        maxQueriesPerIteration: MAX_LOOP_QUERIES_PER_ITERATION_LIMIT,
        stopConditions: ["iteration_limit", "iteration_limit", "no_new_coverage"],
      }),
    ).toEqual({
      ...DEFAULT_RESEARCH_LOOP_POLICY,
      maxQueriesPerIteration: 100,
      stopConditions: ["iteration_limit", "no_new_coverage"],
    });
  });

  it("越界 / 非整数 → 400 INVALID_REQUEST", () => {
    for (const bad of [0, -1, 1.5, "5", MAX_LOOP_ITERATIONS_LIMIT + 1]) {
      expect(() => parseResearchLoopPolicy({ maxIterations: bad })).toThrowError(
        expect.objectContaining({ code: "INVALID_REQUEST" }),
      );
    }
    expect(() =>
      parseResearchLoopPolicy({ maxQueriesPerIteration: MAX_LOOP_QUERIES_PER_ITERATION_LIMIT + 1 }),
    ).toThrowError(expect.objectContaining({ code: "INVALID_REQUEST" }));
  });

  it("stopConditions 非法：空数组 / 未知条目 → 400", () => {
    expect(() => parseResearchLoopPolicy({ stopConditions: [] })).toThrowError(
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(() => parseResearchLoopPolicy({ stopConditions: ["always_continue"] })).toThrowError(
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
    expect(() => parseResearchLoopPolicy({ stopConditions: "iteration_limit" })).toThrowError(
      expect.objectContaining({ code: "INVALID_REQUEST" }),
    );
  });
});

describe("ResearchLoopPolicy 读写（research.json loopPolicy 字段）", () => {
  it("readResearchLoopPolicyFrom：无字段 / 形状非法 → 自愈回默认（读侧不抛错）", () => {
    expect(readResearchLoopPolicyFrom({})).toEqual(DEFAULT_RESEARCH_LOOP_POLICY);
    expect(readResearchLoopPolicyFrom({ loopPolicy: "nonsense" })).toEqual(DEFAULT_RESEARCH_LOOP_POLICY);
    expect(readResearchLoopPolicyFrom({ loopPolicy: { maxIterations: 999 } })).toEqual(
      DEFAULT_RESEARCH_LOOP_POLICY,
    );
  });

  it("GET：无 artifact → 默认值（空态而非错误）；有落盘值 → 读取", async () => {
    const empty = await newProject("loop-get-empty");
    expect(await getResearchLoopPolicy(empty.store, empty.projectId)).toEqual(
      DEFAULT_RESEARCH_LOOP_POLICY,
    );

    const { store, projectId } = await newProject("loop-get-stored");
    await seedArtifact(store, projectId, seededArtifact());
    const stored: ResearchLoopPolicy = {
      maxIterations: 8,
      maxQueriesPerIteration: 15,
      stopConditions: ["iteration_limit"],
    };
    await seedArtifact(store, projectId, { ...seededArtifact(), loopPolicy: stored });
    expect(await getResearchLoopPolicy(store, projectId)).toEqual(stored);
  });

  it("PUT：校验后写入 loopPolicy 字段；计划链 / gaps 决策 / 报告原样保留", async () => {
    const { store, projectId } = await newProject("loop-put");
    await seedArtifact(store, projectId, seededArtifact());

    const policy = await updateResearchLoopPolicy(store, projectId, {
      maxIterations: 7,
      maxQueriesPerIteration: 25,
      stopConditions: ["no_new_coverage", "budget_exceeded"],
    });
    expect(policy).toEqual({
      maxIterations: 7,
      maxQueriesPerIteration: 25,
      stopConditions: ["no_new_coverage", "budget_exceeded"],
    });

    const saved = JSON.parse(
      await readFile(join(store.researchDir(projectId), "research.json"), "utf8"),
    ) as Record<string, unknown>;
    expect(saved["loopPolicy"]).toEqual(policy);
    expect(saved["plan"]).toMatchObject({ planId: "rp-seed00000001" });
    expect(saved["gaps"]).toHaveLength(1);
    expect(saved["report"]).toBeTruthy();
  });

  it("PUT 非法值 → 400 且不落盘；无 artifact → 404", async () => {
    const { store, projectId } = await newProject("loop-put-invalid");
    await seedArtifact(store, projectId, seededArtifact());
    const before = await readFile(join(store.researchDir(projectId), "research.json"), "utf8");
    await expect(
      updateResearchLoopPolicy(store, projectId, { maxIterations: 0 }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST", httpStatus: 400 });
    expect(
      await readFile(join(store.researchDir(projectId), "research.json"), "utf8"),
    ).toBe(before);

    const empty = await newProject("loop-put-404");
    await expect(
      updateResearchLoopPolicy(empty.store, empty.projectId, {}),
    ).rejects.toMatchObject({ code: "NOT_FOUND", httpStatus: 404 });
  });
});
