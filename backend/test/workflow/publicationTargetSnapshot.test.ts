/**
 * 发表目标快照（T7）与持久化（T0 / T1 / T8 后端部分）：
 * - createRun 冻结 review-policy/v1；运行中修改项目设置不影响本 run，新 run 使用新设置；
 * - ProjectStore：旧 project.json 无该字段可读；PATCH 设置 / 清除 / 非法输入拒绝且不落盘；损坏字段读路径丢弃不崩。
 */
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { BusinessError, WorkflowInvalidStateError } from "../../src/errors.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";
import { publicationTargetOptions } from "../../src/review/publicationTargetOptions.js";
import { WorkflowOrchestrator } from "../../src/workflow/WorkflowOrchestrator.js";
import { WorkflowRunStore } from "../../src/workflow/runStore.js";
import type { StageSpec, WorkflowDefinition, WorkflowState } from "../../src/workflow/types.js";

const roots: string[] = [];
const orchestrators: WorkflowOrchestrator[] = [];
afterAll(async () => {
  // 先关闭编排器（停止后台 run 写入），再删临时目录
  await Promise.all(orchestrators.map((o) => o.close()));
  await Promise.all(roots.map((root) => rm(root, { recursive: true, force: true, maxRetries: 5 })));
});

async function newStore(): Promise<ProjectStore> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-pubtarget-"));
  roots.push(root);
  return new ProjectStore({ root });
}

async function waitFor(orchestrator: WorkflowOrchestrator, runId: string, statuses: string[]): Promise<WorkflowState> {
  const deadline = Date.now() + 5_000;
  for (;;) {
    const run = await orchestrator.getRun(runId);
    if (statuses.includes(run.status)) return run;
    if (Date.now() > deadline) throw new Error(`timeout waiting ${statuses.join("|")} (now ${run.status})`);
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

describe("ProjectStore：publicationTarget 持久化", () => {
  it("旧项目（无字段）可读、行为不变；create 带目标；PATCH 修改 / null 清除", async () => {
    const store = await newStore();
    const legacy = await store.create("旧项目", { documentType: "research_article", targetProfile: "core_journal" });
    expect(legacy.publicationTarget).toBeUndefined();
    expect((await store.getRequired(legacy.id)).targetProfile).toBe("core_journal");

    const created = await store.create("新项目", { documentType: "survey", publicationTarget: { scheme: "chinese_index", tier: "CSSCI", schemeYear: 2025 } });
    expect(created.publicationTarget).toMatchObject({ schemaVersion: "publication-target/v1", scheme: "chinese_index", tier: "CSSCI", schemeYear: 2025 });
    expect(created.workflowKind).toBe("topic_survey");

    const patched = await store.updateMeta(created.id, { publicationTarget: { scheme: "jcr", tier: "Q3" } });
    expect(patched.publicationTarget).toMatchObject({ scheme: "jcr", tier: "Q3" });
    expect(patched.publicationTarget?.schemeYear).toBeUndefined();
    const untouched = await store.updateMeta(created.id, { researchField: "CV" });
    expect(untouched.publicationTarget).toMatchObject({ scheme: "jcr", tier: "Q3" });
    const cleared = await store.updateMeta(created.id, { publicationTarget: null });
    expect(cleared.publicationTarget).toBeUndefined();
    const none = await store.updateMeta(created.id, { publicationTarget: { scheme: "none" } });
    expect(none.publicationTarget).toBeUndefined();
  });

  it("非法输入 → INVALID_REQUEST，且不改写已有设置", async () => {
    const store = await newStore();
    const project = await store.create("p", { publicationTarget: { scheme: "cas", tier: "2" } });
    await expect(store.updateMeta(project.id, { publicationTarget: { scheme: "cas", tier: "Q1" } })).rejects.toBeInstanceOf(BusinessError);
    await expect(store.updateMeta(project.id, { publicationTarget: { scheme: "sci", tier: "1" } })).rejects.toThrow(/cas.*jcr/);
    await expect(store.create("q", { publicationTarget: "Q1" })).rejects.toThrow(/必须是对象/);
    expect((await store.getRequired(project.id)).publicationTarget).toMatchObject({ scheme: "cas", tier: "2" });
  });

  it("磁盘上损坏的 publicationTarget：读路径丢弃该字段，项目仍可读", async () => {
    const store = await newStore();
    const project = await store.create("p");
    const file = join(store.rootDir, project.id, "project.json");
    const raw = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
    raw["publicationTarget"] = { schemaVersion: "publication-target/v1", scheme: "jcr", tier: "一区", updatedAt: "2026-01-01T00:00:00Z" };
    await writeFile(file, JSON.stringify(raw), "utf8");
    const read = await store.getRequired(project.id);
    expect(read.title).toBe("p");
    expect(read.publicationTarget).toBeUndefined();
  });

  it("options：体系 / 层级来自同一 registry；期刊只列已核验 profile；不含录用 / 达标措辞", () => {
    const options = publicationTargetOptions(new Date("2026-11-03T00:00:00Z")) as { schemes: Array<{ scheme: string; tiers: Array<{ tier: string }> }>; journals: Array<{ journalId: string }>; statement: string };
    expect(options.schemes.map((s) => s.scheme)).toEqual(["none", "chinese_index", "cas", "jcr"]);
    expect(options.schemes.find((s) => s.scheme === "cas")!.tiers.map((t) => t.tier)).toEqual(["1", "2", "3", "4"]);
    expect(options.journals.length).toBeGreaterThan(0);
    expect(options.statement).toContain("不预测录用");
  });
});

describe("T7 Snapshot：运行中修改设置不影响本 run", () => {
  function definition(observed: Array<{ stage: string; policy: unknown }>): WorkflowDefinition {
    const observe = (id: string): StageSpec => ({
      id, description: id, requiredInputs: [], producedOutputs: [], maxAttempts: 1, timeoutMs: 5_000, retryable: [],
      async execute(ctx) {
        observed.push({ stage: id, policy: structuredClone(ctx.state.reviewPolicy) });
        return {};
      },
    });
    const stages: StageSpec[] = [
      observe("review.first"),
      { id: "hitl.pause", description: "pause", requiredInputs: [], producedOutputs: [], hitl: { prompt: "继续？", options: ["approve"] } },
      observe("review.second"),
    ];
    return {
      kind: "existing_paper_improvement",
      description: "snapshot probe",
      stages,
      plan(state) {
        if ("review.second" in state.stageResults) return { kind: "complete", label: "draft", summary: {} };
        if ("hitl.pause" in state.stageResults) return { kind: "stage", stageId: "review.second" };
        if ("review.first" in state.stageResults) return { kind: "stage", stageId: "hitl.pause" };
        return { kind: "stage", stageId: "review.first" };
      },
      async onInput(state, stageId, input) {
        if (stageId !== "hitl.pause") throw new WorkflowInvalidStateError(state.runId, state.status, "no");
        state.stageResults[stageId] = { decision: input.decision };
      },
    };
  }

  it("run 期间把目标从 CAS 二区改为 JCR Q4：本 run 两轮审稿都看到 CAS 二区；下一次新 run 看到 JCR Q4；checkpoint 持久化", async () => {
    const store = await newStore();
    const project = await store.create("快照", { documentType: "research_article", publicationTarget: { scheme: "cas", tier: "2" } });
    const observed: Array<{ stage: string; policy: unknown }> = [];
    const runStore = new WorkflowRunStore(store);
    const orchestrator = new WorkflowOrchestrator({ projects: store, runStore, definitionFactory: () => definition(observed), retryDelayMs: 0, log: () => {} });
    orchestrators.push(orchestrator);

    const run = await orchestrator.createRun(project.id, "existing_paper_improvement");
    expect(run.reviewPolicy).toMatchObject({ articleType: "research", emphasis: "elevated", target: { scheme: "cas", tier: "2" } });
    await waitFor(orchestrator, run.runId, ["awaiting_input"]);
    await store.updateMeta(project.id, { publicationTarget: { scheme: "jcr", tier: "Q4" } });
    await orchestrator.resume(run.runId, { decision: "approve" });
    const done = await waitFor(orchestrator, run.runId, ["completed"]);
    expect(observed.map((entry) => (entry.policy as { target: { tier: string } }).target.tier)).toEqual(["2", "2"]);
    expect(done.reviewPolicy?.policyHash).toBe(run.reviewPolicy?.policyHash);
    const persisted = JSON.parse(await readFile(runStore.checkpointPath(project.id, run.runId), "utf8")) as WorkflowState;
    expect(persisted.reviewPolicy?.target?.tier).toBe("2");

    const next = await orchestrator.createRun(project.id, "existing_paper_improvement");
    expect(next.reviewPolicy).toMatchObject({ emphasis: "standard", target: { scheme: "jcr", tier: "Q4" } });
    expect(next.reviewPolicy?.policyHash).not.toBe(run.reviewPolicy?.policyHash);
    await waitFor(orchestrator, next.runId, ["awaiting_input"]);
  });
});
