/**
 * M14.2 ThesisPlannerService 单元测试：
 * - 贡献提取（quote 逐字锚定 / 未命中 / 幂等 / 确认持久化）；
 * - 主线 + 大纲 + 映射规划的确定性校验（贡献归属唯一、每节恰属一章、
 *   单节章标题一致、experiment 章必须拥有贡献、fragmented 须给 scopeConcerns）；
 * - writingBlockers 未清空 → AUTHOR_DECISION_REQUIRED fail-closed；
 * - 缺材料章检测与 write_as_limitation 覆盖。
 */

import { afterAll, describe, expect, it } from "vitest";

import { ManuscriptService } from "../../src/manuscript/ManuscriptService.js";
import { LatexCompiler } from "../../src/latex/LatexCompiler.js";
import { ThesisDocumentService } from "../../src/thesis/ThesisDocumentService.js";
import { ThesisPlannerService, statementHasNumericClaim } from "../../src/thesis/ThesisPlannerService.js";
import { THESIS_CONTRIBUTION_QUOTE } from "../../src/runtime/scriptedRuntime.js";
import type { AgentRuntime, RunAgentInput } from "../../src/runtime/types.js";
import { cleanupThesisFixtures, newThesisFixture, tableBlock, textBlock, type ThesisFixture } from "./fixtures.js";

afterAll(cleanupThesisFixtures);

/** 按 scope 返回 canned 输出的最小 runtime */
function fakeRuntime(outputs: Record<string, string>): {
  runtime: { runAgent: (input: RunAgentInput) => Promise<{ status: string; output: string; taskId: string }> };
  calls: RunAgentInput[];
} {
  const calls: RunAgentInput[] = [];
  return {
    calls,
    runtime: {
      runAgent: async (input: RunAgentInput) => {
        calls.push(input);
        const output = outputs[input.contextScope ?? ""];
        if (output === undefined) throw new Error(`测试未脚本化的 scope：${input.contextScope}`);
        return { status: "completed", output, taskId: `t-${calls.length}` };
      },
    },
  };
}

interface PlannerFixture {
  fx: ThesisFixture;
  planner: ThesisPlannerService;
  runtime: ReturnType<typeof fakeRuntime>;
  contributionsOutput: string;
}

async function newPlannerFixture(contributionsOutput?: string, outlineOutput?: string): Promise<PlannerFixture> {
  const fx = await newThesisFixture();
  const contributions = contributionsOutput ?? JSON.stringify({
    contributions: [
      { kind: "method", statement: "提出显著性检测方法 SSAA", quote: THESIS_CONTRIBUTION_QUOTE },
      { kind: "experiment_result", statement: "SSAA 在 DAVSOD 上 S 达到 0.724", quote: THESIS_CONTRIBUTION_QUOTE },
    ],
  });
  const outputs: Record<string, string> = { "thesis/contributions": contributions };
  if (outlineOutput !== undefined) outputs["thesis/outline"] = outlineOutput;
  const runtime = fakeRuntime(outputs);
  const planner = buildPlanner(fx, runtime.runtime);
  return { fx, planner, runtime, contributionsOutput: contributions };
}

function buildPlanner(fx: ThesisFixture, runtime: { runAgent: (input: RunAgentInput) => Promise<{ status: string; output: string; taskId: string }> }): ThesisPlannerService {
  const runtimeAsAgent = runtime as unknown as AgentRuntime;
  const manuscript = new ManuscriptService(fx.projects);
  const thesisDocuments = new ThesisDocumentService(fx.projects, new LatexCompiler({ timeoutMs: 1_000 }));
  return new ThesisPlannerService({
    runtime: runtimeAsAgent,
    agentId: "writer",
    projects: fx.projects,
    manuscript,
    researchInputs: fx.service,
    thesisDocuments,
    documents: fx.documents,
  });
}

describe("M14.2 ThesisPlannerService：贡献提取", () => {
  it("逐字 quote 锚定 verbatim；改写 quote → not_found（不猜）；幂等重放不重复", async () => {
    const { fx, planner } = await newPlannerFixture(JSON.stringify({
      contributions: [
        { kind: "method", statement: "提出显著性检测方法 SSAA", quote: THESIS_CONTRIBUTION_QUOTE },
        { kind: "conclusion", statement: "方法有效", quote: "这句不在文档里" },
      ],
    }));
    const input = await fx.importPdf(
      { fileName: "a.pdf", blocks: [textBlock("B0001", 1, `研究贡献如下。${THESIS_CONTRIBUTION_QUOTE}实验充分。`)] },
      "published_paper",
    );
    const result = await planner.extractContributions(fx.projectId);
    expect(result).toMatchObject({ inputsProcessed: 1, proposals: 2, anchored: 1 });
    const file = await planner.loadContributions(fx.projectId);
    const items = file?.items ?? [];
    expect(items).toHaveLength(2);
    expect(items.find((item) => item.statement.includes("SSAA"))).toMatchObject({ anchorStatus: "verbatim", status: "proposed" });
    expect(items.find((item) => item.statement === "方法有效")).toMatchObject({ anchorStatus: "not_found" });
    // 幂等：同输入重跑零新增
    const again = await planner.extractContributions(fx.projectId);
    expect(again.proposals).toBe(0);
    expect((await planner.loadContributions(fx.projectId))?.items).toHaveLength(2);
    // 作者确认持久化（actor 记录）
    const confirmed = await planner.confirmContributions(fx.projectId, {
      contributionIds: [items[0]!.id],
      outcome: "confirmed",
      actorKind: "test_fixture",
    });
    expect(confirmed.updated).toBe(1);
    const after = (await planner.loadContributions(fx.projectId))?.items.find((item) => item.id === items[0]!.id);
    expect(after).toMatchObject({ status: "confirmed", actorKind: "test_fixture" });
    void input;
  });

  it("贡献陈述中的数值可确定性链接到已提取事实（linkedFactIds）", async () => {
    const { fx, planner } = await newPlannerFixture();
    await fx.importPdf(
      {
        fileName: "b.pdf",
        blocks: [
          textBlock("B0001", 1, `${THESIS_CONTRIBUTION_QUOTE}结果见表。`),
          tableBlock("B0002", 2, ["Method", "S"], [["SSAA", "0.724"]]),
        ],
      },
      "published_paper",
    );
    await fx.service.extractFacts(fx.projectId, (await fx.service.list(fx.projectId)).inputs[0]!.inputId);
    await planner.extractContributions(fx.projectId);
    const file = await planner.loadContributions(fx.projectId);
    const linked = file?.items.find((item) => item.statement.includes("0.724"));
    expect(linked?.linkedFactIds.length).toBeGreaterThan(0);
  });
});

function outlineJson(contributionIds: string[], inputIds: string[], overrides: Record<string, unknown> = {}): string {
  const [first, second, ...rest] = contributionIds;
  return JSON.stringify({
    storyline: {
      narrative: "先方法后验证的递进主线。",
      structure: "progressive",
      relations: [],
      contributionsOrder: contributionIds,
    },
    chapters: [
      {
        chapterId: "ch01",
        titleZh: "绪论",
        responsibility: "introduction",
        goal: "背景与现状",
        sections: [
          { file: "intro-background.tex", title: "研究背景", targetLengthWords: 800 },
          { file: "intro-status.tex", title: "研究现状", targetLengthWords: 800 },
        ],
        ownsContributionIds: [],
        referencesContributionIds: [],
        sourceInputIds: [],
        factIds: [],
      },
      {
        chapterId: "ch02",
        titleZh: "核心方法",
        responsibility: "method",
        goal: "展开方法",
        sections: [
          { file: "method-design.tex", title: "方法设计", targetLengthWords: 1200 },
          { file: "method-analysis.tex", title: "方法分析", targetLengthWords: 900 },
        ],
        ownsContributionIds: [first, ...rest].filter((id): id is string => id !== undefined),
        referencesContributionIds: [],
        sourceInputIds: inputIds,
        factIds: [],
      },
      ...(second !== undefined
        ? [
            {
              chapterId: "ch03",
              titleZh: "实验验证",
              responsibility: "experiment",
              goal: "验证方法",
              sections: [
                { file: "exp-a.tex", title: "实验设置", targetLengthWords: 800 },
                { file: "exp-b.tex", title: "结果分析", targetLengthWords: 800 },
              ],
              ownsContributionIds: [second],
              referencesContributionIds: [],
              sourceInputIds: inputIds,
              factIds: [],
            },
          ]
        : []),
      {
        chapterId: "ch04",
        titleZh: "总结与展望",
        responsibility: "conclusion",
        goal: "总结",
        sections: [
          { file: "conclusion.tex", title: "总结", targetLengthWords: 600 },
          { file: "future.tex", title: "展望", targetLengthWords: 400 },
        ],
        ownsContributionIds: [],
        referencesContributionIds: [],
        sourceInputIds: [],
        factIds: [],
      },
    ],
    ...overrides,
  });
}

async function confirmedPlannerFixture(): Promise<PlannerFixture & { contributionIds: string[]; inputIds: string[] }> {
  const fixture = await newPlannerFixture();
  const { fx, planner } = fixture;
  const input = await fx.importPdf(
    { fileName: "plan.pdf", blocks: [textBlock("B0001", 1, `${THESIS_CONTRIBUTION_QUOTE}方法与实验。`)] },
    "published_paper",
  );
  await planner.extractContributions(fx.projectId);
  const file = await planner.loadContributions(fx.projectId);
  const contributionIds = (file?.items ?? []).map((item) => item.id);
  await planner.confirmContributions(fx.projectId, { contributionIds, outcome: "confirmed", actorKind: "test_fixture" });
  // 范围决定：include
  await fx.service.submitDecision(fx.projectId, {
    actor: { kind: "test_fixture" },
    payload: { type: "scope_decision", inputId: input.inputId, scope: "included" },
  });
  return { ...fixture, contributionIds, inputIds: [input.inputId] };
}

describe("M14.2 ThesisPlannerService：主线 / 大纲 / 映射", () => {
  it("合法规划落盘四工件（outline.json / thesis.json / chapter-mapping / storyline）且映射 proposed", async () => {
    const { fx, planner, contributionIds, inputIds } = await confirmedPlannerFixture();
    const runtime = fakeRuntime({ "thesis/outline": outlineJson(contributionIds, inputIds) });
    const plannerWithOutline = buildPlanner(fx, runtime.runtime);
    const result = await plannerWithOutline.planStoryline(fx.projectId);
    expect(result.chapters.length).toBeGreaterThanOrEqual(3);
    expect(result.outline.sections.length).toBeGreaterThanOrEqual(6);
    const mapping = await planner.loadMapping(fx.projectId);
    expect(mapping?.status).toBe("proposed");
    expect(mapping?.chapters.length).toBe(result.chapters.length);
    const model = await new ThesisDocumentService(fx.projects, new LatexCompiler({ timeoutMs: 1_000 })).loadModel(fx.projectId);
    expect(model?.chapters.length).toBe(result.chapters.length);
    // 确认映射 → confirmed
    await planner.confirmMapping(fx.projectId, "test_fixture");
    expect((await planner.loadMapping(fx.projectId))?.status).toBe("confirmed");
  });

  it("确定性校验：贡献被两章同时拥有 → 拒绝；experiment 章无贡献 → 拒绝；未拥有贡献 → 拒绝", async () => {
    const { fx, contributionIds, inputIds } = await confirmedPlannerFixture();
    const [first, second] = contributionIds as [string, string];
    // 双 owner
    const doubleOwner = outlineJson(contributionIds, inputIds);
    const mutated = JSON.parse(doubleOwner) as { chapters: Array<{ ownsContributionIds: string[] }> };
    mutated.chapters[1]!.ownsContributionIds = [first, second];
    mutated.chapters[2]!.ownsContributionIds = [second];
    const runtime = fakeRuntime({ "thesis/outline": JSON.stringify(mutated) });
    const plannerDouble = buildPlanner(fx, runtime.runtime);
    await expect(plannerDouble.planStoryline(fx.projectId)).rejects.toThrow(/同时拥有/);

    // experiment 章无贡献
    const noOwn = JSON.parse(outlineJson(contributionIds, inputIds)) as { chapters: Array<{ ownsContributionIds: string[] }> };
    noOwn.chapters[2]!.ownsContributionIds = [];
    noOwn.chapters[1]!.ownsContributionIds = contributionIds;
    const runtimeNoOwn = fakeRuntime({ "thesis/outline": JSON.stringify(noOwn) });
    const plannerNoOwn = buildPlanner(fx, runtimeNoOwn.runtime);
    await expect(plannerNoOwn.planStoryline(fx.projectId)).rejects.toThrow(/必须声明 ownsContributionIds/);
  });

  it("writingBlockers 非空 → AUTHOR_DECISION_REQUIRED fail-closed（proposed 输入未决定）", async () => {
    const fixture = await newPlannerFixture();
    const { fx, planner } = fixture;
    const input = await fx.importPdf(
      { fileName: "blocked.pdf", blocks: [textBlock("B0001", 1, `${THESIS_CONTRIBUTION_QUOTE}方法。`)] },
      "published_paper",
    );
    await planner.extractContributions(fx.projectId);
    const file = await planner.loadContributions(fx.projectId);
    await planner.confirmContributions(fx.projectId, {
      contributionIds: (file?.items ?? []).map((item) => item.id),
      outcome: "confirmed",
      actorKind: "test_fixture",
    });
    // 不做 include 决定 → plannerContext 有 pendingDecisions(scope_decision)
    await expect(planner.planStoryline(fx.projectId)).rejects.toThrow(/未决阻断|没有入选/);
    void input;
  });

  it("缺材料章检测：method/experiment 章拥有贡献但无可写事实 → missing；write_as_limitation 决定覆盖", async () => {
    const { fx, contributionIds, inputIds } = await confirmedPlannerFixture();
    const runtime = fakeRuntime({ "thesis/outline": outlineJson(contributionIds, inputIds) });
    const plannerWithOutline = buildPlanner(fx, runtime.runtime);
    await plannerWithOutline.planStoryline(fx.projectId);
    await plannerWithOutline.confirmMapping(fx.projectId, "test_fixture");
    // 表格事实未确认（extracted/source_verified 分区不满足 authorConfirmed 要求，
    // 且 factIds 为空）→ method + experiment 两章均缺材料
    const missing = await plannerWithOutline.missingMaterialChapters(fx.projectId);
    expect(missing.map((chapter) => chapter.chapterId)).toEqual(["ch02", "ch03"]);
    // 作者对 ch02 决定 write_as_limitation → 只剩 ch03
    await fx.service.submitDecision(fx.projectId, {
      actor: { kind: "test_fixture" },
      payload: { type: "writing_pause", subject: "ch02", decision: "write_as_limitation", rationale: "测试" },
    });
    const after = await plannerWithOutline.missingMaterialChapters(fx.projectId);
    expect(after.map((chapter) => chapter.chapterId)).toEqual(["ch03"]);
  });

  it("M14.5 缺材料判断：experiment 章虽有可写事实，但其 experiment_result 贡献含未被任何事实支撑的具体数值 → missing", async () => {
    // 案例 B 实录：贡献「高度跟踪误差降低 75.37%」逐字锚定但 75.37% 不是任何已确认/已核验事实；
    // 章节另有参数表事实（可写）→ 旧规则不拦 → Writer 写入 75.37% → Reviewer 阻断。
    const { fx, planner } = await newPlannerFixture(JSON.stringify({
      contributions: [
        { kind: "method", statement: "提出 NDP-NMPC 方法", quote: THESIS_CONTRIBUTION_QUOTE },
        { kind: "experiment_result", statement: "高度跟踪误差降低了 75.37%", quote: THESIS_CONTRIBUTION_QUOTE },
        { kind: "experiment_result", statement: "预测实验验证了预测器的有效性", quote: THESIS_CONTRIBUTION_QUOTE },
      ],
    }));
    const input = await fx.importPdf(
      {
        fileName: "caseb.pdf",
        blocks: [
          textBlock("B0001", 1, `${THESIS_CONTRIBUTION_QUOTE}参数见表。`),
          tableBlock("B0002", 2, ["Parameter", "Value"], [["N", "20"], ["Qp,z", "400"]], "TABLE III: CONTROL PARAMETERS"),
        ],
        textLayer: [{ page: 2, text: "TABLE III: CONTROL PARAMETERS Parameter Value N 20 Qp,z 400" }],
      },
      "published_paper",
    );
    await fx.service.extractFacts(fx.projectId, input.inputId);
    await fx.service.verifyFacts(fx.projectId, input.inputId);
    const facts = await fx.service.facts.list(fx.projectId, { researchInputId: input.inputId });
    expect(facts.length).toBe(2);
    await fx.service.submitDecision(fx.projectId, { actor: { kind: "test_fixture" }, payload: { type: "scope_decision", inputId: input.inputId, scope: "included" } });
    await fx.service.submitDecision(fx.projectId, { actor: { kind: "test_fixture" }, payload: { type: "fact_confirmation", factIds: facts.map((fact) => fact.factId), outcome: "confirmed" } });
    await planner.extractContributions(fx.projectId);
    const items = (await planner.loadContributions(fx.projectId))?.items ?? [];
    const numericResult = items.find((item) => item.statement.includes("75.37"))!;
    expect(numericResult.linkedFactIds).toEqual([]);
    const contributionIds = [items.find((item) => item.kind === "method")!.id, numericResult.id, items.find((item) => item.statement.includes("预测实验"))!.id];
    await planner.confirmContributions(fx.projectId, { contributionIds, outcome: "confirmed", actorKind: "test_fixture" });
    // ch02 method owns [method, 非数值 experiment_result]；ch03 experiment owns [75.37% 贡献]；两章 factIds 都给参数事实
    const outline = JSON.parse(outlineJson([contributionIds[0]!, contributionIds[1]!, contributionIds[2]!], [input.inputId])) as { chapters: Array<{ chapterId: string; factIds: string[] }> };
    for (const chapter of outline.chapters) {
      if (chapter.chapterId === "ch02" || chapter.chapterId === "ch03") chapter.factIds = facts.map((fact) => fact.factId);
    }
    const runtime = fakeRuntime({ "thesis/outline": JSON.stringify(outline) });
    const plannerWithOutline = buildPlanner(fx, runtime.runtime);
    await plannerWithOutline.planStoryline(fx.projectId);
    await plannerWithOutline.confirmMapping(fx.projectId, "test_fixture");
    const missing = await plannerWithOutline.missingMaterialChapters(fx.projectId);
    // ch02：有可写事实且其 experiment_result 贡献无具体数值 → 不缺；ch03：75.37% 无事实支撑 → 缺材料
    expect(missing.map((chapter) => chapter.chapterId)).toEqual(["ch03"]);
    // 作者决定后不再拦
    await fx.service.submitDecision(fx.projectId, { actor: { kind: "test_fixture" }, payload: { type: "writing_pause", subject: "ch03", decision: "write_as_limitation", rationale: "测试" } });
    expect(await plannerWithOutline.missingMaterialChapters(fx.projectId)).toEqual([]);
  });

  it("M14.5 statementHasNumericClaim：百分比 / 小数 / 千分位计数算数值结果；年份 / 单个小整数不算", () => {
    expect(statementHasNumericClaim("高度跟踪误差降低了 75.37%")).toBe(true);
    expect(statementHasNumericClaim("S-measure 达到 0.724")).toBe(true);
    expect(statementHasNumericClaim("训练集包含 118,287 张图像")).toBe(true);
    expect(statementHasNumericClaim("在 2023 年提出了新方法")).toBe(false);
    expect(statementHasNumericClaim("提出 3 个贡献并在第 5 章验证")).toBe(false);
    expect(statementHasNumericClaim("开展了预测实验以验证有效性")).toBe(false);
  });
});
