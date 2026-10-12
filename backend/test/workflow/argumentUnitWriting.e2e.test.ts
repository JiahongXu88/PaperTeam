/**
 * M13.7.10 Argument-Unit Writing × 真实 Workflow（scripted runtime，无模型）：
 * - idea_to_paper 真正经过 writing.sections：逐节 prompt 携带 B2 任务块与上限长度行；
 *   不同章节收到不同的正式 Evidence（引言 / 结论为空，develop 按相关性，无 compare 节时覆盖兜底）；
 * - reviews/writing-plan.json 记录 role / 分配与消费的 Evidence / 引用 key / usage；
 * - reviews/academic-redundancy-rev{N}.json 只读报告落盘，stage 结果携带摘要；
 * - review.run 的 style 模式注入只读 digest，fact / academic 不注入；Gate 规则集不变；
 * - HITL resume 两次后写作发生；同项目再次 run：指纹相同 → 计划一致；正式证据变化 → 记录 previousFingerprint；
 * - 关闭开关（writing.argumentUnits=false）→ 旧行为（同一证据快照、「约 N 字」、无计划产物）；
 * - M13.7.11：部分章节已写后的 stage 重试（transient）→ 同一 run attempt 递增、指纹不变、逐节分配一致、全部章节写完。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { scriptedIdeaRuntime, startTestStack, type TestStack } from "../helpers/testStack.js";
import type { WorkflowState } from "../../src/workflow/types.js";
import type { WritingPlanArtifact } from "../../src/review/reviewArtifacts.js";
import { ARGUMENT_UNIT_BLOCK_HEADER } from "../../src/writer/argumentUnit.js";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
});

async function pollRun(stack: TestStack, runId: string, statuses: string[], timeoutMs = 30_000): Promise<WorkflowState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await stack.request("GET", `/api/runs/${runId}`);
    const run = body["run"] as WorkflowState;
    if (statuses.includes(run.status)) {
      return run;
    }
    if (run.status === "failed") {
      throw new Error(`run 失败：${run.error?.code} ${run.error?.message}`);
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 ${statuses.join("|")} 超时（当前 ${run.status} / ${run.currentStage}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

/** approve 直到 run 终态（feasibility / outline 两个 HITL；evidence_supply 无候选不出现） */
async function runToCompletion(stack: TestStack, projectId: string): Promise<{ runId: string; run: WorkflowState }> {
  const created = await stack.request("POST", `/api/projects/${projectId}/workflows`, {});
  expect(created.status).toBe(202);
  const runId = created.body["runId"] as string;
  for (;;) {
    const run = await pollRun(stack, runId, ["awaiting_input", "completed"]);
    if (run.status === "completed") {
      return { runId, run };
    }
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
  }
}

const SURVEY_TITLE = "Retrieval-Augmented Generation for Large Language Models: A Survey";

async function seedFormalEvidence(stack: TestStack, projectId: string): Promise<void> {
  const records = [
    { id: "method", claim: "评估协议设计：固定检索器与生成器配置，指标采用幻觉率与事实一致性" },
    { id: "method2", claim: "评估指标定义：事实错误率随检索质量变化的量化关系" },
    { id: "experiments", claim: "数据集与对比设置：小规模领域语料下三种重排策略的对比" },
    { id: "related", claim: "RAG 检索器优化与评估协议的既有工作综述" },
    { id: "partial", claim: "所有重排策略在小语料下都优于无检索基线", support: "partial" as const },
  ];
  for (const record of records) {
    await stack.stack.evidence.append(
      projectId,
      {
        claim: record.claim,
        quote: record.claim,
        source: { sourceId: `S-${record.id}`, title: SURVEY_TITLE, year: 2023 },
        location: { chunk: `S-${record.id}:SEC01:0001:abcdef0123`, section: "Body" },
        verificationStatus: "verified",
        supportStrength: record.support ?? "direct",
        verificationLevel: "fulltext",
      },
      "test",
    );
  }
}

async function readPlan(stack: TestStack, projectId: string): Promise<WritingPlanArtifact> {
  return JSON.parse(await readFile(join(stack.root, projectId, "reviews", "writing-plan.json"), "utf8")) as WritingPlanArtifact;
}

describe("M13.7.10 argument-unit writing（idea_to_paper，scripted）", () => {
  it("writing.sections：逐节 B2 任务块 + 不同证据 + 计划 / 重复报告产物 + style digest；再次 run 的指纹语义", async () => {
    const scripted = scriptedIdeaRuntime({ reviewSequence: ["pass"] });
    const stack = await startTestStack(scripted.runtime, { registerCleanup: (cleanup) => cleanups.push(cleanup) });
    const project = await stack.store.create("论证单元写作", { researchIdea: "小语料 RAG 评估" });
    await seedFormalEvidence(stack, project.id);

    const { runId, run } = await runToCompletion(stack, project.id);
    expect(run.status).toBe("completed");
    const writing = run.stageResults["writing.sections"] as Record<string, unknown>;
    expect(writing["sectionsWritten"]).toBe(5);
    const units = writing["argumentUnits"] as { enabled: boolean; sections: Array<{ id: string; role: string; evidence: number }> };
    expect(units.enabled).toBe(true);
    expect(units.sections.map((section) => [section.id, section.role])).toEqual([
      ["introduction", "framing"],
      ["related-work", "develop"],
      ["method", "develop"],
      ["experiments", "develop"],
      ["conclusion", "conclude"],
    ]);
    expect((writing["redundancy"] as { revision: number }).revision).toBe(writing["revision"]);

    // 逐节 prompt：任务块 + 上限长度；证据按节不同
    const sectionTasks = scripted.tasks.filter((task) => task.contextScope === "writing/sections" && task.projectId === project.id);
    expect(sectionTasks).toHaveLength(5);
    const evidenceIdsIn = (task: string): string[] => [...task.matchAll(/^- \[(E\d{3})\]/gm)].map((match) => match[1]!);
    const byFile = (file: string) => sectionTasks.find((task) => task.task.includes(`（${file}）`))!;
    for (const task of sectionTasks) {
      expect(task.task).toContain(ARGUMENT_UNIT_BLOCK_HEADER);
      expect(task.task).toMatch(/目标长度：不超过 \d+ 字（上限参考，不是配额）/);
      expect(task.task).not.toMatch(/见「[^」]+」一节/);
    }
    expect(evidenceIdsIn(byFile("introduction.tex").task)).toEqual([]);
    expect(evidenceIdsIn(byFile("conclusion.tex").task)).toEqual([]);
    const methodIds = evidenceIdsIn(byFile("method.tex").task);
    const experimentIds = evidenceIdsIn(byFile("experiments.tex").task);
    const relatedIds = evidenceIdsIn(byFile("related-work.tex").task);
    expect(methodIds.length).toBeGreaterThan(0);
    expect(experimentIds.length).toBeGreaterThan(0);
    expect(methodIds).not.toEqual(experimentIds);
    expect(byFile("introduction.tex").task).toContain("目标长度：不超过 260 字");
    expect(byFile("introduction.tex").task).toContain("本节不注入正式 Evidence 是分工安排");
    expect(byFile("method.tex").task).toContain("角色：develop（");

    // 计划产物：role / 分配 = 消费 / 引用 key / usage 可追溯；每条正式证据至少落到一个 develop 节
    const plan = await readPlan(stack, project.id);
    expect(plan.mode).toBe("idea_to_paper");
    expect(plan.runId).toBe(runId);
    expect(plan.attempt).toBe(1);
    expect(plan.revision).toBe(writing["revision"]);
    expect(plan.previousFingerprint).toBeUndefined();
    expect(plan.unassignedEvidence).toEqual([]);
    const bySection = Object.fromEntries(plan.sections.map((section) => [section.sectionId, section]));
    expect(bySection["method"]!.evidence.allocated).toEqual(methodIds);
    expect(bySection["method"]!.evidence.consumed).toEqual(methodIds);
    expect(bySection["experiments"]!.evidence.allocated).toEqual(experimentIds);
    expect(bySection["related-work"]!.evidence.allocated).toEqual(relatedIds);
    expect(plan.sections.every((section) => section.status === "written")).toBe(true);
    expect(plan.sections.every((section) => typeof section.latencyMs === "number" && section.taskId !== undefined)).toBe(true);
    expect(bySection["introduction"]!.citationKeys.cited).toEqual(["gao2023retrieval"]);
    const formalIds = new Set(plan.sections.flatMap((section) => section.evidence.allocated));
    expect([...formalIds].sort()).toEqual(["E001", "E002", "E003", "E004", "E005"]);
    // partial 只在 develop（无 compare 节）
    expect(bySection["introduction"]!.evidence.partial).toEqual([]);

    // 只读重复报告按修订号落盘
    const redundancy = JSON.parse(
      await readFile(join(stack.root, project.id, "reviews", `academic-redundancy-rev${String(writing["revision"])}.json`), "utf8"),
    ) as { revision: number; roles: Record<string, string>; summary: { harmful: { share: number } }; knownLimitations: string[] };
    expect(redundancy.roles["introduction"]).toBe("framing");
    expect(redundancy.knownLimitations.length).toBeGreaterThan(0);

    // Reviewer：style 注入 digest，fact / academic 不注入；gate 规则集不含重复率规则
    const reviewTasks = scripted.tasks.filter((task) => task.projectId === project.id && (task.contextScope ?? "").startsWith("review/"));
    expect(reviewTasks.find((task) => task.contextScope === "review/style")!.task).toContain("跨章节学术重复观察");
    expect(reviewTasks.find((task) => task.contextScope === "review/fact")!.task).not.toContain("跨章节学术重复观察");
    expect(reviewTasks.find((task) => task.contextScope === "review/academic")!.task).not.toContain("跨章节学术重复观察");
    const gate = JSON.parse(await readFile(join(stack.root, project.id, "reviews", "quality-gate-r1.json"), "utf8")) as { gate: { rules: Array<{ rule: string }> } };
    expect(gate.gate.rules.some((rule) => /redundan|重复/.test(rule.rule))).toBe(false);

    // 同项目再次 run：正式证据集合不变 → 指纹相同；新增正式证据 → previousFingerprint 与警告
    const second = await runToCompletion(stack, project.id);
    const plan2 = await readPlan(stack, project.id);
    expect(plan2.runId).toBe(second.runId);
    expect(plan2.fingerprint).toBe(plan.fingerprint);
    expect(plan2.previousFingerprint).toBeUndefined();
    expect(plan2.sections.map((section) => section.evidence.allocated)).toEqual(plan.sections.map((section) => section.evidence.allocated));
    const added = await stack.stack.evidence.append(
      project.id,
      {
        claim: "新增：数据集划分与对比设置的补充说明",
        quote: "新增：数据集划分与对比设置的补充说明",
        source: { sourceId: "S-new", title: SURVEY_TITLE, year: 2023 },
        location: { chunk: "S-new:SEC01:0001:abcdef0123" },
        verificationStatus: "verified",
        supportStrength: "direct",
      },
      "test",
    );
    await runToCompletion(stack, project.id);
    const plan3 = await readPlan(stack, project.id);
    expect(plan3.fingerprint).not.toBe(plan.fingerprint);
    expect(plan3.previousFingerprint).toBe(plan.fingerprint);
    expect(plan3.warnings.some((warning) => warning.includes("正式证据集合已变化"))).toBe(true);
    expect(plan3.sections.find((section) => section.sectionId === "experiments")!.evidence.allocated).toContain(added.id);
  }, 120_000);

  it("部分章节已写后的 stage 重试（M13.7.11 Resume）：同一 run 内 attempt 递增、指纹不变、分配逐节一致、全部章节最终写完", async () => {
    const scripted = scriptedIdeaRuntime({ reviewSequence: ["pass"] });
    let sectionCalls = 0;
    let failed = false;
    // 第 3 节写作时抛一次瞬时错误（非 BusinessError → transient）；testStack 的 stageMaxAttempts=2 → 整个 stage 重试
    const runtime = new Proxy(scripted.runtime, {
      get(target, property, receiver) {
        if (property !== "runAgent") {
          const value = Reflect.get(target, property, receiver);
          return typeof value === "function" ? value.bind(target) : value;
        }
        return async (input: Parameters<typeof target.runAgent>[0]) => {
          if (input.contextScope === "writing/sections") {
            sectionCalls += 1;
            if (sectionCalls === 3 && !failed) {
              failed = true;
              throw new Error("simulated transient provider failure while writing section 3");
            }
          }
          return target.runAgent(input);
        };
      },
    });
    const stack = await startTestStack(runtime, { registerCleanup: (cleanup) => cleanups.push(cleanup) });
    const project = await stack.store.create("论证单元写作重试", { researchIdea: "小语料 RAG 评估" });
    await seedFormalEvidence(stack, project.id);
    const { runId, run } = await runToCompletion(stack, project.id);
    expect(run.status).toBe("completed");
    const writingRecords = run.stageHistory.filter((record) => record.stageId === "writing.sections");
    expect(writingRecords.map((record) => record.status)).toEqual(["failed", "completed"]);
    // 第一次尝试写了 2 节后失败；第二次从头写全部 5 节（Writer 调用 2 + 5；抛错的那次未到达 runtime）
    const sectionTasks = scripted.tasks.filter((task) => task.contextScope === "writing/sections" && task.projectId === project.id);
    expect(sectionTasks).toHaveLength(7);
    const evidenceIdsIn = (task: string): string[] => [...task.matchAll(/^- \[(E\d{3})\]/gm)].map((match) => match[1]!);
    const fileOf = (task: string): string => /（([a-z-]+\.tex)）/.exec(task)?.[1] ?? "";
    const attempt1 = sectionTasks.slice(0, 2);
    for (const first of attempt1) {
      const again = sectionTasks.slice(2).find((task) => fileOf(task.task) === fileOf(first.task))!;
      expect(again).toBeDefined();
      expect(evidenceIdsIn(again.task)).toEqual(evidenceIdsIn(first.task));
      expect(again.task).toContain(ARGUMENT_UNIT_BLOCK_HEADER);
    }
    const plan = await readPlan(stack, project.id);
    expect(plan.runId).toBe(runId);
    expect(plan.attempt).toBe(2);
    expect(plan.previousFingerprint).toBeUndefined();
    expect(plan.warnings).toEqual([]);
    expect(plan.sections.every((section) => section.status === "written")).toBe(true);
    expect(plan.sections.every((section) => section.evidence.consumed.length === section.evidence.allocated.length)).toBe(true);
    const writing = run.stageResults["writing.sections"] as Record<string, unknown>;
    expect(writing["sectionsWritten"]).toBe(5);
    expect((writing["argumentUnits"] as { attempt: number }).attempt).toBe(2);
  }, 60_000);

  it("关闭开关：旧行为（同一证据快照、「约 N 字」、无任务块、无计划产物）", async () => {
    const scripted = scriptedIdeaRuntime({ reviewSequence: ["pass"] });
    const stack = await startTestStack(scripted.runtime, { registerCleanup: (cleanup) => cleanups.push(cleanup) });
    stack.stack.workflowServices.writing = { argumentUnits: false };
    const project = await stack.store.create("论证单元关闭", { researchIdea: "小语料 RAG 评估" });
    await seedFormalEvidence(stack, project.id);
    const { run } = await runToCompletion(stack, project.id);
    const writing = run.stageResults["writing.sections"] as Record<string, unknown>;
    expect(writing["argumentUnits"]).toEqual({ enabled: false });
    expect(writing["redundancy"]).toBeUndefined();
    const sectionTasks = scripted.tasks.filter((task) => task.contextScope === "writing/sections" && task.projectId === project.id);
    expect(sectionTasks).toHaveLength(5);
    const idsOf = (task: string) => [...task.matchAll(/^- \[(E\d{3})\]/gm)].map((match) => match[1]!).join(",");
    expect(new Set(sectionTasks.map((task) => idsOf(task.task))).size).toBe(1);
    for (const task of sectionTasks) {
      expect(task.task).toMatch(/目标长度：约 \d+ 字/);
      expect(task.task).not.toContain(ARGUMENT_UNIT_BLOCK_HEADER);
    }
    await expect(readFile(join(stack.root, project.id, "reviews", "writing-plan.json"), "utf8")).rejects.toThrow();
  }, 60_000);
});
