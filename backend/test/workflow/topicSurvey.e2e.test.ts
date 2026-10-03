/**
 * topic_survey Workflow Mock/Fixture E2E（M11.1.4 第二~四层）。
 *
 * 真实服务栈 + 组合脚本 runtime（workflow scopes → scriptedRuntime；survey
 * scopes → buildSurveyRuntime）+ fake openalex 检索 + fake OA 全文下载（带文本
 * 层的 PDF，走真实 resolve / attach / chunk / ingest 链路）。
 *
 * 覆盖：
 * 1. E2E 主链：Topic（只带 title）→ 计划 HITL → 检索 → 文献遴选 HITL →
 *    全文准备 → Matrix → 矩阵 HITL → Synthesis → Outline → 大纲 HITL →
 *    completed（label=survey）；四件 artifact 落盘 + refs 全部可回溯；
 * 2. HITL：计划 revise 重规划 / 矩阵 revise entryPatches（taxonomy 修正 →
 *    synthesis 消费修正后的 Matrix）/ 大纲 revise 后 refs 仍在 / 非法
 *    decision 结构化拒绝；
 * 3. Resume：matrix_confirm / outline_confirm 处重启（新 Orchestrator 实例从
 *    checkpoint 恢复）→ 前序 stage 不重复执行（stageHistory 完成计数恒 1）；
 *    awaiting 处 cancel → cancelled。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  createScriptedRuntime,
  startTestStack,
  type TestStack,
} from "../helpers/testStack.js";
import { buildSurveyRuntime } from "../survey/fixtures.js";
import { WorkflowOrchestrator } from "../../src/workflow/WorkflowOrchestrator.js";
import { WorkflowRunStore } from "../../src/workflow/runStore.js";
import { createTopicSurveyDefinition } from "../../src/workflow/definitions.js";
import type { AgentRuntime, AgentTask } from "../../src/runtime/types.js";
import type { FullTextResolver } from "../../src/search/fullText.js";
import type { WorkflowState } from "../../src/workflow/types.js";
import { BusinessError } from "../../src/errors.js";

/** 带文本层的最小 PDF（与 fullTextBatch 测试同构；≥200 字符保证可分析可索引） */
function buildTextPdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, " ").slice(0, 6000)}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  const parts: string[] = ["%PDF-1.4"];
  let offset = parts[0]!.length + 1;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(offset);
    const object = `${index + 1} 0 obj\n${body}\nendobj\n`;
    parts.push(object);
    offset += object.length;
  });
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  parts.push(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`);
  return Buffer.from(parts.join("\n"), "latin1");
}

/** fake 语料：8 篇（openalex 检索返回 + OA 下载正文） */
const FAKE_PAPERS = Array.from({ length: 8 }, (_, index) => ({
  doi: `10.1234/mot-paper-${index + 1}`,
  title: `Multi-Object Tracking Association Method ${index + 1}`,
  year: 2018 + index,
  body:
    `Multi-object tracking data association paper ${index + 1}. `.repeat(6) +
    "We associate every detection box including low-score ones and keep identity stable through occlusion. " +
    "Experiments on MOT17 show identity switches drop; the association approach improves identity preservation. ",
}));

const openalexResponse = {
  results: FAKE_PAPERS.map((paper, index) => ({
    id: `https://openalex.org/W${100 + index}`,
    title: paper.title,
    doi: `https://doi.org/${paper.doi}`,
    publication_year: paper.year,
    authorships: [{ author: { display_name: `Author ${index + 1}` } }],
    cited_by_count: 10 + index,
    open_access: { is_oa: true },
  })),
};

const fakeFetch = async (url: string | URL | Request): Promise<Response> => {
  const target = String(url);
  if (target.startsWith("https://api.openalex.org/works")) {
    return new Response(JSON.stringify(openalexResponse), { status: 200 });
  }
  if (target.startsWith("https://oa.example.org/")) {
    const doi = decodeURIComponent(target.replace("https://oa.example.org/", "").replace(/\.pdf$/, ""));
    const paper = FAKE_PAPERS.find((candidate) => candidate.doi === doi) ?? FAKE_PAPERS[0]!;
    return new Response(buildTextPdf(paper.body), {
      status: 200,
      headers: { "content-type": "application/pdf" },
    });
  }
  return new Response(JSON.stringify({ error: `unexpected url ${target}` }), { status: 500 });
};

/**
 * fake OA resolver：name 必须是 "unpaywall"（resolver 链按 name 路由——DOI
 * 身份查 unpaywall / oa-url；与 fullTextBatch 测试同纪律）
 */
const fakeOaResolver: FullTextResolver = {
  name: "unpaywall",
  async resolve(identity) {
    if (identity.doi !== undefined && identity.doi.startsWith("10.1234/")) {
      return { kind: "found", url: `https://oa.example.org/${identity.doi}.pdf`, source: "fake-oa" };
    }
    return { kind: "not_found" };
  },
};

/**
 * 组合 runtime：survey scopes（matrix / synthesis / survey outline digest /
 * evidence judge）走 buildSurveyRuntime，其余走 scriptedRuntime（含
 * research/survey-plan 计划脚本）。共享 survey 侧调用记录用于断言。
 */
function buildCombinedRuntime() {
  const survey = buildSurveyRuntime({}, {});
  const scripted = createScriptedRuntime();
  const isSurveyScope = (scope: string, task: string): boolean =>
    scope === "research/survey-matrix" ||
    scope === "research/survey-synthesis" ||
    scope.startsWith("citation/evidence/") ||
    (scope === "writing/outline" && task.includes("[SYN-"));
  const runtime: AgentRuntime = {
    provider: "pi",
    healthCheck: () => survey.healthCheck(),
    runAgent: async (input): Promise<AgentTask> =>
      isSurveyScope(input.contextScope ?? "", input.task)
        ? survey.runAgent(input)
        : scripted.runtime.runAgent(input),
    startAgent: async (input) => {
      const task = await runtime.runAgent(input);
      return {
        taskId: task.taskId,
        sessionKey: `agent:${input.agentId}:combined`,
        events: async function* () {},
        cancel: async () => {},
        result: async () => task,
      };
    },
    getTask: () => {
      throw new Error("not implemented");
    },
    close: async () => {},
  };
  return { runtime, survey, scripted };
}

let stack: TestStack;
let surveyCalls: Array<{ agentId: string; contextScope?: string; sourceId: string }>;

beforeAll(async () => {
  const combined = buildCombinedRuntime();
  surveyCalls = combined.survey.calls;
  stack = await startTestStack(combined.runtime, {
    search: {
      disabledProviders: ["semantic-scholar", "arxiv", "aminer", "searxng"],
      providerTimeoutMs: 2_000,
      fetchImpl: fakeFetch as unknown as typeof fetch,
    },
    fullText: { enabled: true, resolvers: [fakeOaResolver] },
  });
});

afterAll(async () => {
  await stack.cleanup();
});

async function createSurveyProject(title: string): Promise<string> {
  const response = await stack.request("POST", "/api/projects", {
    title,
    workflowKind: "topic_survey",
  });
  expect(response.status).toBe(201);
  return (response.body["project"] as { id: string }).id;
}

async function startSurveyRun(projectId: string): Promise<string> {
  const response = await stack.request("POST", `/api/projects/${projectId}/workflows`, {
    kind: "topic_survey",
  });
  expect(response.status).toBe(202);
  return response.body["runId"] as string;
}

/** 轮询 run 直到目标状态；途经的 awaiting 用给定 decision 自动回复 */
async function pollRun(
  runId: string,
  until: (run: WorkflowState) => boolean,
  decisions: Record<string, unknown> = {},
  timeoutMs = 120_000,
): Promise<WorkflowState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await stack.request("GET", `/api/runs/${runId}`);
    const run = body["run"] as WorkflowState;
    if (until(run)) {
      return run;
    }
    if (run.status === "failed") {
      throw new Error(`run 失败：${run.error?.code} ${run.error?.message}（stage ${run.error?.stageId ?? "?"}）`);
    }
    if (run.status === "awaiting_input") {
      const stageId = run.awaiting?.stageId ?? "";
      if (!(stageId in decisions)) {
        throw new Error(`遇到未预期的待办节点 ${stageId}`);
      }
      await stack.request("POST", `/api/runs/${runId}/resume`, decisions[stageId]);
      continue;
    }
    if (run.status === "completed" || run.status === "cancelled") {
      throw new Error(`run 已 ${run.status}（未满足目标条件）`);
    }
    if (Date.now() > deadline) {
      throw new Error(`轮询超时（当前 ${run.status}，stage ${run.currentStage}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

function completions(run: WorkflowState, stageId: string): number {
  return run.stageHistory.filter((record) => record.stageId === stageId && record.status === "completed")
    .length;
}

async function readProjectJson(projectId: string, relative: string): Promise<any> {
  return JSON.parse(
    await readFile(join(stack.store.projectDir(projectId), relative), "utf8"),
  );
}

// ============================================================
// 1. Mock/Fixture E2E 主链
// ============================================================

describe("topic_survey fixture E2E：主链", () => {
  it("Topic → 计划 → 检索 → 遴选 → 全文 → Matrix → Synthesis → Outline → completed（label=survey）", async () => {
    const projectId = await createSurveyProject("多目标跟踪中的数据关联方法");
    const runId = await startSurveyRun(projectId);

    // 计划 HITL：survey 语义 payload（queries + taxonomyIntent）
    const atPlan = await pollRun(runId, (run) => run.status === "awaiting_input" && run.awaiting?.stageId === "hitl.research_plan");
    const planPayload = atPlan.awaiting?.payload ?? {};
    expect((planPayload["queries"] as unknown[]).length).toBeGreaterThan(0);
    const planProfile = planPayload["surveyProfile"] as Record<string, unknown> | undefined;
    expect(Array.isArray(planProfile?.["taxonomyIntent"])).toBe(true);
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });

    // 文献遴选 HITL：8 篇候选全部入推荐集
    const atSelection = await pollRun(runId, (run) => run.status === "awaiting_input" && run.awaiting?.stageId === "hitl.literature_selection");
    const selectionPayload = atSelection.awaiting?.payload ?? {};
    expect(selectionPayload["pendingCount"]).toBe(FAKE_PAPERS.length);
    expect((selectionPayload["recommendedCandidateIds"] as string[]).length).toBe(FAKE_PAPERS.length);
    // 自定义子集（增删语义）：只选前 5 篇
    const candidateIds = (selectionPayload["candidates"] as Array<{ candidateId: string }>).map(
      (candidate) => candidate.candidateId,
    );
    await stack.request("POST", `/api/runs/${runId}/resume`, {
      decision: "approve",
      payload: { candidateIds: candidateIds.slice(0, 5) },
    });

    // 矩阵 HITL：5 篇全部 fulltext（fake OA 全文下载成功）
    const atMatrix = await pollRun(runId, (run) => run.status === "awaiting_input" && run.awaiting?.stageId === "hitl.matrix_confirm", undefined, 240_000);
    const matrixPayload = atMatrix.awaiting?.payload ?? {};
    expect(matrixPayload["entries"]).toBe(5);
    expect(matrixPayload["fulltext"]).toBe(5);
    expect(matrixPayload["abstractOnly"]).toBe(0);

    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });

    // 大纲 HITL：outline payload 携带 refs
    const atOutline = await pollRun(runId, (run) => run.status === "awaiting_input" && run.awaiting?.stageId === "hitl.outline_confirm", undefined, 240_000);
    const outlinePayload = atOutline.awaiting?.payload ?? {};
    const sections = outlinePayload["sections"] as Array<Record<string, unknown>>;
    expect(sections.length).toBeGreaterThan(0);
    const withRefs = sections.filter((section) => Array.isArray(section["synthesisRefs"]));
    expect(withRefs.length).toBeGreaterThan(0);

    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });

    // completed：label=survey + 四件 artifact + refs 可回溯
    const done = await pollRun(runId, (run) => run.status === "completed", undefined, 120_000);
    expect(done.completion?.label).toBe("survey");
    expect(done.completion?.summary).toMatchObject({
      sections: expect.any(Number),
      matrixEntries: 5,
      selectedLiterature: 5,
    });

    const research = await readProjectJson(projectId, join("research", "research.json"));
    expect(research.plans.length).toBe(1);
    expect(research.plans[0].status).toBe("done");
    expect(research.surveyProfile.taxonomy.families.length).toBeGreaterThan(0);

    const matrix = await readProjectJson(projectId, join("research", "survey.json"));
    expect(matrix.entries).toHaveLength(5);
    const fulltextEntries = matrix.entries.filter((entry: any) => entry.interpretationDepth === "fulltext");
    expect(fulltextEntries.length).toBe(5);

    const synthesis = await readProjectJson(projectId, join("research", "survey-synthesis.json"));
    expect(synthesis.items.length).toBeGreaterThan(0);
    expect(synthesis.items.some((item: any) => item.kind === "taxonomy")).toBe(true);

    const outline = await readProjectJson(projectId, join("manuscript", "outline.json"));
    const synthesisIds = new Set(synthesis.items.map((item: any) => item.synthesisId));
    const entryIds = new Set(matrix.entries.map((entry: any) => entry.entryId));
    const badSynthesisRefs = outline.sections.flatMap((section: any) =>
      (section.synthesisRefs ?? []).filter((ref: string) => !synthesisIds.has(ref)),
    );
    const badLiteratureRefs = outline.sections.flatMap((section: any) =>
      (section.literatureRefs ?? []).filter((ref: string) => !entryIds.has(ref)),
    );
    expect(badSynthesisRefs).toEqual([]);
    expect(badLiteratureRefs).toEqual([]);
  }, 600_000);
});

// ============================================================
// 2. HITL 行为
// ============================================================

describe("topic_survey HITL", () => {
  it("计划 revise：带 feedback 重新规划（research.plan 完成 2 次）后再批准", async () => {
    const projectId = await createSurveyProject("计划修订路径测试");
    const runId = await startSurveyRun(projectId);
    await pollRun(runId, (run) => run.status === "awaiting_input" && run.awaiting?.stageId === "hitl.research_plan");
    const revise = await stack.request("POST", `/api/runs/${runId}/resume`, {
      decision: "revise",
      payload: { feedback: "请补充基准与评测类检索词" },
    });
    expect(revise.status).toBe(200);
    await pollRun(
      runId,
      (run) => run.status === "awaiting_input" && run.awaiting?.stageId === "hitl.research_plan",
    );
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
    // 走到遴选即视为计划链闭环（不继续跑完全链）
    const atSelection = await pollRun(runId, (run) => run.status === "awaiting_input" && run.awaiting?.stageId === "hitl.literature_selection");
    expect(atSelection.stageHistory.filter((record) => record.stageId === "research.plan" && record.status === "completed")).toHaveLength(2);
    await stack.request("POST", `/api/runs/${runId}/cancel`);
  }, 240_000);

  it("矩阵 revise：entryPatches 修正 taxonomy → synthesis 消费修正后的 Matrix（family 计数变化）", async () => {
    const projectId = await createSurveyProject("矩阵修正路径测试");
    const runId = await startSurveyRun(projectId);
    await pollRun(
      runId,
      (run) => run.status === "awaiting_input" && run.awaiting?.stageId === "hitl.matrix_confirm",
      {
        "hitl.research_plan": { decision: "approve" },
        "hitl.literature_selection": { decision: "approve" },
      },
      240_000,
    );
    const matrixBefore = await readProjectJson(projectId, join("research", "survey.json"));
    const target = matrixBefore.entries.find(
      (entry: any) => entry.methodFamily === "tracking_association",
    );
    expect(target).toBeDefined();
    // taxonomy 意图词表里有 survey family——把一篇改归 survey（合法表内标签）
    const patch = await stack.request("POST", `/api/runs/${runId}/resume`, {
      decision: "revise",
      payload: {
        entryPatches: [{ entryId: target.entryId, methodFamily: "survey" }],
      },
    });
    expect(patch.status).toBe(200);
    const matrixAfter = await readProjectJson(projectId, join("research", "survey.json"));
    expect(
      matrixAfter.entries.find((entry: any) => entry.entryId === target.entryId).methodFamily,
    ).toBe("survey");

    // 批准后 synthesis 消费修正后的 Matrix（survey family 计数进入 taxonomy items）
    await pollRun(
      runId,
      (run) => run.status === "awaiting_input" && run.awaiting?.stageId === "hitl.outline_confirm",
      { "hitl.matrix_confirm": { decision: "approve" } },
      240_000,
    );
    const synthesis = await readProjectJson(projectId, join("research", "survey-synthesis.json"));
    const surveyFamily = synthesis.items.find(
      (item: any) => item.kind === "taxonomy" && item.detail.family === "survey",
    );
    expect(surveyFamily).toBeDefined();
    expect(surveyFamily.derivedFrom.entryIds).toContain(target.entryId);
    await stack.request("POST", `/api/runs/${runId}/cancel`);
  }, 480_000);

  it("矩阵 revise 非法标签：结构化拒绝（run 保持 awaiting，不落盘坏 patch）", async () => {
    const projectId = await createSurveyProject("矩阵非法修正测试");
    const runId = await startSurveyRun(projectId);
    await pollRun(
      runId,
      (run) => run.status === "awaiting_input" && run.awaiting?.stageId === "hitl.matrix_confirm",
      {
        "hitl.research_plan": { decision: "approve" },
        "hitl.literature_selection": { decision: "approve" },
      },
      240_000,
    );
    const matrix = await readProjectJson(projectId, join("research", "survey.json"));
    const rejected = await stack.request("POST", `/api/runs/${runId}/resume`, {
      decision: "revise",
      payload: {
        entryPatches: [{ entryId: matrix.entries[0].entryId, methodFamily: "not_a_real_family" }],
      },
    });
    expect(rejected.status).toBe(400);
    const still = await stack.request("GET", `/api/runs/${runId}`);
    expect((still.body["run"] as WorkflowState).status).toBe("awaiting_input");
    await stack.request("POST", `/api/runs/${runId}/cancel`);
  }, 240_000);

  it("大纲 revise：feedback 重规划后 refs 仍完整（再批准 → completed）", async () => {
    const projectId = await createSurveyProject("大纲修订路径测试");
    const runId = await startSurveyRun(projectId);
    await pollRun(
      runId,
      (run) => run.status === "awaiting_input" && run.awaiting?.stageId === "hitl.outline_confirm",
      {
        "hitl.research_plan": { decision: "approve" },
        "hitl.literature_selection": { decision: "approve" },
        "hitl.matrix_confirm": { decision: "approve" },
      },
      360_000,
    );
    const revise = await stack.request("POST", `/api/runs/${runId}/resume`, {
      decision: "revise",
      payload: { feedback: "请把展望章节与结论合并" },
    });
    expect(revise.status).toBe(200);
    await pollRun(
      runId,
      (run) => run.status === "awaiting_input" && run.awaiting?.stageId === "hitl.outline_confirm",
      {},
      240_000,
    );
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
    const done = await pollRun(runId, (run) => run.status === "completed", undefined, 120_000);
    expect(completions(done, "survey.outline")).toBe(2);
    const outline = await readProjectJson(projectId, join("manuscript", "outline.json"));
    expect(
      outline.sections.filter((section: any) => Array.isArray(section.synthesisRefs)).length,
    ).toBeGreaterThan(0);
    expect(
      outline.sections.filter((section: any) => Array.isArray(section.literatureRefs)).length,
    ).toBeGreaterThan(0);
  }, 600_000);

  it("非法 decision（遴选节点传 revise）→ 409 结构化拒绝", async () => {
    const projectId = await createSurveyProject("非法决策测试");
    const runId = await startSurveyRun(projectId);
    await pollRun(
      runId,
      (run) => run.status === "awaiting_input" && run.awaiting?.stageId === "hitl.literature_selection",
      {
        "hitl.research_plan": { decision: "approve" },
        "hitl.literature_selection": { decision: "approve" },
      },
    );
    const rejected = await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "revise" });
    expect(rejected.status).toBe(409);
    await stack.request("POST", `/api/runs/${runId}/cancel`);
  }, 120_000);
});

// ============================================================
// 3. Resume / 取消
// ============================================================

describe("topic_survey resume", () => {
  /** 在目标 HITL 暂停后用「新 Orchestrator 实例」恢复（进程重启语义） */
  async function restartOrchestrator(): Promise<WorkflowOrchestrator> {
    return new WorkflowOrchestrator({
      projects: stack.store,
      runStore: new WorkflowRunStore(stack.store),
      definitionFactory: (kind) => {
        if (kind !== "topic_survey") {
          throw new BusinessError("INVALID_REQUEST", `测试只装配 topic_survey（收到 ${kind}）`);
        }
        return createTopicSurveyDefinition(stack.stack.workflowServices);
      },
      retryDelayMs: 0,
      log: () => {},
    });
  }

  async function pollOrchestrator(
    orchestrator: WorkflowOrchestrator,
    runId: string,
    until: (run: WorkflowState) => boolean,
    timeoutMs = 240_000,
  ): Promise<WorkflowState> {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const run = await orchestrator.getRun(runId);
      if (until(run)) {
        return run;
      }
      if (run.status === "failed" || run.status === "completed" || run.status === "cancelled") {
        throw new Error(`run 已 ${run.status}：${run.error?.message ?? ""}`);
      }
      if (Date.now() > deadline) {
        throw new Error(`轮询超时（${run.status} / ${run.currentStage}）`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  it("matrix_confirm 处重启恢复：survey.matrix / survey.search / research.plan 不重复执行", async () => {
    const projectId = await createSurveyProject("矩阵恢复测试");
    const runId = await startSurveyRun(projectId);
    await pollRun(
      runId,
      (run) => run.status === "awaiting_input" && run.awaiting?.stageId === "hitl.matrix_confirm",
      {
        "hitl.research_plan": { decision: "approve" },
        "hitl.literature_selection": { decision: "approve" },
      },
      240_000,
    );
    const matrixCallsBefore = surveyCalls.filter((call) => call.contextScope === "research/survey-matrix").length;
    const restartCountBefore = (await stack.request("GET", `/api/runs/${runId}`))
      .body["run"] as WorkflowState;

    const orchestrator = await restartOrchestrator();
    await orchestrator.resume(runId, { decision: "approve" });
    // 大纲确认是最后一个 HITL：重启后仍需一次用户输入才 completed
    await pollOrchestrator(
      orchestrator,
      runId,
      (run) => run.status === "awaiting_input" && run.awaiting?.stageId === "hitl.outline_confirm",
      360_000,
    );
    await orchestrator.resume(runId, { decision: "approve" });
    const done = await pollOrchestrator(orchestrator, runId, (run) => run.status === "completed", 120_000);

    for (const stageId of ["research.plan", "hitl.research_plan", "survey.search", "survey.fulltext", "survey.matrix", "hitl.matrix_confirm"]) {
      expect(completions(done, stageId), stageId).toBe(completions(restartCountBefore, stageId));
    }
    // matrix 脚本调用次数不增长（重启后没有重新构建任何条目）
    const matrixCallsAfter = surveyCalls.filter((call) => call.contextScope === "research/survey-matrix").length;
    expect(matrixCallsAfter).toBe(matrixCallsBefore);
    expect(done.completion?.label).toBe("survey");
    await orchestrator.close();
  }, 480_000);

  it("outline_confirm 处重启恢复：不重复跑 Search / Matrix / Synthesis", async () => {
    const projectId = await createSurveyProject("大纲恢复测试");
    const runId = await startSurveyRun(projectId);
    await pollRun(
      runId,
      (run) => run.status === "awaiting_input" && run.awaiting?.stageId === "hitl.outline_confirm",
      {
        "hitl.research_plan": { decision: "approve" },
        "hitl.literature_selection": { decision: "approve" },
        "hitl.matrix_confirm": { decision: "approve" },
      },
      360_000,
    );
    const before = (await stack.request("GET", `/api/runs/${runId}`)).body["run"] as WorkflowState;
    const synthesisCallsBefore = surveyCalls.filter((call) => call.contextScope === "research/survey-synthesis").length;

    const orchestrator = await restartOrchestrator();
    await orchestrator.resume(runId, { decision: "approve" });
    const done = await pollOrchestrator(orchestrator, runId, (run) => run.status === "completed", 120_000);

    for (const stageId of ["research.plan", "survey.search", "survey.fulltext", "survey.matrix", "survey.synthesis"]) {
      expect(completions(done, stageId), stageId).toBe(completions(before, stageId));
    }
    const synthesisCallsAfter = surveyCalls.filter((call) => call.contextScope === "research/survey-synthesis").length;
    expect(synthesisCallsAfter).toBe(synthesisCallsBefore);
    await orchestrator.close();
  }, 480_000);

  it("awaiting 处 cancel：run 终结为 cancelled，已完成 stage 保留", async () => {
    const projectId = await createSurveyProject("取消测试");
    const runId = await startSurveyRun(projectId);
    await pollRun(
      runId,
      (run) => run.status === "awaiting_input" && run.awaiting?.stageId === "hitl.literature_selection",
      {
        "hitl.research_plan": { decision: "approve" },
        "hitl.literature_selection": { decision: "approve" },
      },
    );
    const cancelled = await stack.request("POST", `/api/runs/${runId}/cancel`);
    expect((cancelled.body["run"] as WorkflowState).status).toBe("cancelled");
    const run = (await stack.request("GET", `/api/runs/${runId}`)).body["run"] as WorkflowState;
    expect(run.completedStages).toContain("research.plan");
    expect(run.completedStages).toContain("survey.search");
  }, 120_000);
});
