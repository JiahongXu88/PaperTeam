/**
 * M14.2 thesis_from_papers 确定性 E2E（真实 WorkflowOrchestrator + scripted runtime）。
 *
 * 五条路径（任务 §11.2）：
 *  A 正常路径：登记 2 输入 → include + 事实确认 + 贡献确认 → 大纲确认 →
 *    分章写作（事实注入）→ review/gate（四条 thesis 规则）→ 学位论文
 *    装配 + Draft/Final 产物注册；
 *  B 冲突路径：同实验异值（消融表 A/B）→ hitl.fact_conflicts 暂停 →
 *    adopt_fact → 正确恢复并完成；
 *  C 缺材料路径：核心章无可写事实 → hitl.author_decision → write_as_limitation
 *    （写作 prompt 注入研究限制口径，不编造数值）；
 *  D 恢复路径：写作中段单次失败 → stage 重试经 writing-plan journal 复用已
 *    完成节（零重复生成）；
 *  E 失败路径：大纲规划持续不可修复 → run failed，无 Draft 产物冒充成功。
 *
 * 作者确认全部显式 actor=test_fixture（测试栈 allowTestFixtureActor=on）。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createScriptedRuntime, THESIS_CONTRIBUTION_QUOTE } from "../../src/runtime/scriptedRuntime.js";
import type { AgentRuntime, RunAgentInput } from "../../src/runtime/types.js";
import type { FullTextResolver } from "../../src/search/fullText.js";
import type { ParsedDocument, ParsedBlock } from "../../src/ingestion/types.js";
import { startTestStack, type TestStack } from "../helpers/testStack.js";
import { tableBlock, textBlock } from "../thesis/fixtures.js";

const fakeOaResolver: FullTextResolver = {
  name: "unpaywall",
  async resolve(identity) {
    if (identity.doi !== undefined && identity.doi.startsWith("10.1234/")) {
      return { kind: "found", url: `https://oa.example.org/${identity.doi}.pdf`, source: "fake-oa" };
    }
    return { kind: "not_found" };
  },
};

const openalexResponse = {
  results: Array.from({ length: 4 }, (_, index) => ({
    id: `https://openalex.org/W${200 + index}`,
    title: `Saliency Detection Survey ${index + 1}`,
    doi: `https://doi.org/10.1234/sal-${index + 1}`,
    publication_year: 2020 + index,
    authorships: [{ author: { display_name: `Author ${index + 1}` } }],
    cited_by_count: 5 + index,
    open_access: { is_oa: true },
  })),
};

const fakeFetch = async (url: string | URL | Request): Promise<Response> => {
  const target = String(url);
  if (target.startsWith("https://api.openalex.org/works")) {
    return new Response(JSON.stringify(openalexResponse), { status: 200 });
  }
  if (target.startsWith("https://oa.example.org/")) {
    const body = "Saliency detection survey content about attention and motion cues for video object segmentation. ".repeat(8);
    const content = `BT /F1 12 Tf 72 720 Td (${body.replace(/[()\\]/g, " ").slice(0, 3000)}) Tj ET`;
    return new Response(Buffer.from(`%PDF-1.4\n1 0 obj\n<< /Length ${content.length} >>\nstream\n${content}\nendstream\nendobj\n`, "latin1"), {
      status: 200,
      headers: { "content-type": "application/pdf" },
    });
  }
  return new Response(JSON.stringify({ error: `unexpected url ${target}` }), { status: 500 });
};

/** 最小 AgentTask 桩（补齐必填字段形状） */
function fakeTask(taskId: string, output: string): import("../../src/runtime/types.js").AgentTask {
  const now = new Date().toISOString();
  return { agentId: "writer", taskId, status: "completed", output, createdAt: now, updatedAt: now } as import("../../src/runtime/types.js").AgentTask;
}

/** scope 级输出替换（E 路径：大纲持续非法） */
function scopeOverrideRuntime(base: AgentRuntime, scope: string, output: string): AgentRuntime {
  return {
    ...base,
    runAgent: async (input: RunAgentInput) => {
      if (input.contextScope === scope) {
        return fakeTask(`wrapped-${scope}`, output);
      }
      return base.runAgent(input);
    },
  };
}

/** writing/sections 第 failOn 次调用注入非法 latex（D 路径：中段失败→journal 恢复） */
function flakyWriterRuntime(base: AgentRuntime, failOn: number): { runtime: AgentRuntime; sectionCalls: () => number } {
  let calls = 0;
  return {
    sectionCalls: () => calls,
    runtime: {
      ...base,
      runAgent: async (input: RunAgentInput) => {
        if (input.contextScope === "writing/sections") {
          calls += 1;
          if (calls === failOn) {
            return fakeTask(`flaky-${calls}`, "\\documentclass{article}\n违规输出（触发节级失败）");
          }
        }
        return base.runAgent(input);
      },
    },
  };
}

interface SeedSpec {
  fileName: string;
  inputType: "published_paper" | "preprint" | "unpublished_manuscript" | "submitted_manuscript" | "experiment_report";
  title?: string;
  blocks: ParsedBlock[];
}

async function seedResearchInput(
  stack: TestStack,
  projectId: string,
  spec: SeedSpec,
): Promise<{ inputId: string; sourceId: string }> {
  const { source } = await stack.stack.sources.add(projectId, {
    fileName: spec.fileName,
    content: Buffer.from(`%PDF-1.5\n${spec.fileName}-content`, "utf8"),
  });
  const document: ParsedDocument = {
    schemaVersion: 1,
    sourceId: source.sourceId,
    fileName: spec.fileName,
    storedFileName: spec.fileName,
    kind: "pdf",
    mimeType: "application/pdf",
    parser: { id: "test-fixture", version: "1" },
    parseMode: "structured",
    status: "ok",
    pageCount: Math.max(1, ...spec.blocks.map((block) => block.provenance.page ?? 1)),
    blocks: spec.blocks,
    counts: { text: spec.blocks.filter((block) => block.type === "text").length } as ParsedDocument["counts"],
    notes: [],
    contentHash: source.contentHash!,
    parsedAt: new Date().toISOString(),
  };
  await stack.stack.parsedDocuments.save(projectId, document);
  const result = await stack.stack.researchInputs.register(
    projectId,
    {
      sourceId: source.sourceId,
      inputType: spec.inputType,
      ...(spec.title !== undefined ? { title: spec.title } : {}),
    },
    { ensureParsed: false },
  );
  await stack.stack.researchInputs.registry.refreshParse(projectId, result.input.inputId);
  return { inputId: result.input.inputId, sourceId: source.sourceId };
}

/** 无冲突正文（含 scripted 贡献锚点句 + 消融表） */
function paperBlocks(withTable: boolean): ParsedBlock[] {
  const blocks = [
    textBlock("B0001", 1, `研究背景与动机。${THESIS_CONTRIBUTION_QUOTE}`),
    textBlock("B0002", 2, "方法细节与实验设置。我们在 DAVSOD 与 UBFC 数据集上训练。"),
  ];
  if (withTable) {
    blocks.push(tableBlock("B0003", 3, ["Method", "S ↑", "MAE ↓"], [["Ours", "0.724", "0.092"], ["Base", "0.667", "0.132"]], "表1 消融实验"));
  }
  return blocks;
}

type RunView = {
  status: string;
  projectId?: string;
  awaiting?: { stageId: string; payload?: Record<string, unknown> };
  completion?: { label: string; summary?: Record<string, unknown> };
  error?: { message: string };
  completedStages?: string[];
  stageResults?: Record<string, Record<string, unknown>>;
};

async function waitForAwaiting(stack: TestStack, runId: string, stageId: string, timeoutMs: number): Promise<boolean> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await getRun(stack, runId);
    if (run.status === "awaiting_input" && run.awaiting?.stageId === stageId) return true;
    if (run.status !== "running") return false;
    if (Date.now() > deadline) return false;
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

async function getRun(stack: TestStack, runId: string): Promise<RunView> {
  const response = await stack.request("GET", `/api/runs/${runId}`);
  expect(response.status).toBe(200);
  return response.body["run"] as RunView;
}

type DecisionOutcome = { decision: string; payload?: Record<string, unknown> } | "stop";
type DecisionHandler = (
  payload: Record<string, unknown> | undefined,
  stack: TestStack,
  runId: string,
) => DecisionOutcome | Promise<DecisionOutcome>;

async function pollRun(
  stack: TestStack,
  runId: string,
  options: {
    decisions?: Record<string, DecisionHandler>;
    timeoutMs?: number;
  } = {},
): Promise<RunView> {
  const deadline = Date.now() + (options.timeoutMs ?? 180_000);
  for (;;) {
    const run = await getRun(stack, runId);
    if (run.status === "awaiting_input" && run.awaiting !== undefined) {
      const handler = options.decisions?.[run.awaiting.stageId];
      if (handler === undefined) {
        // 调试辅助：未脚本化 HITL 时带出最新 gate / review 产物摘要
        let diagnostics = "";
        try {
          const runView = (run as unknown as { projectId?: string }).projectId;
          if (runView !== undefined) {
            const projectDir = stack.store.projectDir(runView);
            const { readFile: read, readdir } = await import("node:fs/promises");
            const reviews = await readdir(`${projectDir}/reviews`).catch(() => [] as string[]);
            const gateName = [...reviews].reverse().find((name) => /^quality-gate-r\d+\.json$/.test(name));
            if (gateName !== undefined) {
              const gate = JSON.parse(await read(`${projectDir}/reviews/${gateName}`, "utf8"));
              diagnostics = `；最新 gate(${gateName}) passed=${gate.gate?.passed} 失败规则=${JSON.stringify((gate.gate?.rules ?? []).filter((rule: { passed: boolean }) => !rule.passed).map((rule: { rule: string; detail: string }) => `${rule.rule}: ${rule.detail}`), null, 2)}`;
            }
          }
        } catch {
          // 诊断失败不掩盖原错误
        }
        throw new Error(`测试未脚本化的 HITL：${run.awaiting.stageId}${diagnostics}`);
      }
      const outcome = await handler(run.awaiting.payload, stack, runId);
      if (outcome === "stop") {
        return run;
      }
      const resumeResponse = await stack.request("POST", `/api/runs/${runId}/resume`, {
        decision: outcome.decision,
        payload: outcome.payload,
      });
      if (resumeResponse.status >= 400) {
        // 非法决策由测试刻意触发时抛出详情
        const detail = JSON.stringify(resumeResponse.body);
        throw new Error(`resume 被拒（${run.awaiting.stageId}，${outcome.decision}）：${detail}`);
      }
      continue;
    }
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      return run;
    }
    if (Date.now() > deadline) {
      throw new Error(`pollRun 超时（status=${run.status}，awaiting=${run.awaiting?.stageId ?? "无"}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

async function createThesisProject(stack: TestStack, title: string): Promise<string> {
  const response = await stack.request("POST", "/api/projects", { title, documentType: "master_thesis" });
  expect(response.status).toBe(201);
  const project = response.body["project"] as { id: string; workflowKind?: string };
  expect(project.workflowKind).toBe("thesis_from_papers");
  return project.id;
}

async function startThesisRun(stack: TestStack, projectId: string): Promise<string> {
  const response = await stack.request("POST", `/api/projects/${projectId}/workflows`, {});
  expect(response.status).toBe(202);
  return response.body["runId"] as string;
}

/** 事实确认：把某输入的全部事实批量 confirm（经 HTTP 决策端点，actor=test_fixture） */
async function confirmAllFacts(stack: TestStack, projectId: string, inputId: string): Promise<number> {
  const factsResponse = await stack.request("GET", `/api/projects/${projectId}/research-inputs/facts?inputId=${inputId}`);
  expect(factsResponse.status).toBe(200);
  const facts = factsResponse.body["facts"] as Array<{ factId: string }>;
  if (facts.length === 0) return 0;
  const decisionResponse = await stack.request("POST", `/api/projects/${projectId}/research-inputs/decisions`, {
    actor: { kind: "test_fixture" },
    payload: { type: "fact_confirmation", factIds: facts.map((fact) => fact.factId), outcome: "confirmed" },
  });
  expect(decisionResponse.status).toBeLessThan(300);
  return facts.length;
}

/** scope_and_version 的标准决策序列：include 全部 → 未发表允许 → HTTP 侧确认事实 → 确认全部贡献 → approve */
function scopeDecisionSequence(options: { confirmFacts?: boolean } = {}): DecisionHandler {
  let factsConfirmedViaHttp = !options.confirmFacts;
  return async (payload, stk, rid) => {
    const run = await getRun(stk, rid);
    const projectId = (run as unknown as { projectId?: string }).projectId;
    if (projectId === undefined) {
      throw new Error("run 视图缺少 projectId");
    }
    const proposed = (payload?.["inputs"] as { proposed?: Array<{ inputId: string }> } | undefined)?.proposed ?? [];
    if (proposed.length > 0) {
      return { decision: "include", payload: { inputId: proposed[0]!.inputId, actorKind: "test_fixture" } };
    }
    const pending = (payload?.["pendingDecisions"] as Array<{ type: string; subject: string }> | undefined) ?? [];
    const unpublished = pending.find((item) => item.type === "unpublished_material_policy");
    if (unpublished !== undefined) {
      return { decision: "allow_unpublished", payload: { inputId: unpublished.subject, actorKind: "test_fixture" } };
    }
    if (!factsConfirmedViaHttp) {
      const included = (payload?.["inputs"] as { included?: Array<{ inputId: string }> } | undefined)?.included ?? [];
      for (const input of included) {
        await confirmAllFacts(stk, projectId, input.inputId);
      }
      factsConfirmedViaHttp = true;
    }
    const contributions = (payload?.["contributions"] as Array<{ id: string; status: string }> | undefined) ?? [];
    const unconfirmed = contributions.filter((item) => item.status === "proposed").map((item) => item.id);
    if (unconfirmed.length > 0) {
      return { decision: "confirm_contribution", payload: { contributionIds: unconfirmed, actorKind: "test_fixture" } };
    }
    return { decision: "approve", payload: { actorKind: "test_fixture" } };
  };
}

describe("M14.2 thesis_from_papers E2E", () => {
  let stack: TestStack;
  let scripted: ReturnType<typeof createScriptedRuntime>;

  beforeAll(async () => {
    scripted = createScriptedRuntime({ reviewSequence: ["pass"] });
    stack = await startTestStack(scripted.runtime, {
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

  it(
    "路径 A（正常）：2 输入 → 确认 → 大纲 → 分章写作 → review/gate → 学位论文 Draft/Final",
    async () => {
      const projectId = await createThesisProject(stack, "显著性目标检测学位论文A");
      await seedResearchInput(stack, projectId, {
        fileName: "paper-a.pdf",
        inputType: "published_paper",
        title: "论文A：显著性方法",
        blocks: paperBlocks(true),
      });
      await seedResearchInput(stack, projectId, {
        fileName: "paper-b.pdf",
        inputType: "preprint",
        title: "论文B：时序建模扩展",
        blocks: paperBlocks(false),
      });

      const runId = await startThesisRun(stack, projectId);
      const run = await pollRun(stack, runId, {
        decisions: {
          "hitl.scope_and_version": scopeDecisionSequence({ confirmFacts: true }),
          "hitl.outline_confirm": () => ({ decision: "approve", payload: { actorKind: "test_fixture" } }),
        },
      });

      expect(run.status).toBe("completed");
      expect(run.completion?.label).toBe("final");
      expect(run.completedStages).toContain("thesis.ingest");
      expect(run.completedStages).toContain("thesis.contributions");
      expect(run.completedStages).toContain("hitl.scope_and_version");
      expect(run.completedStages).toContain("thesis.storyline");
      expect(run.completedStages).toContain("hitl.outline_confirm");
      expect(run.completedStages).toContain("thesis.evidence_supply");
      expect(run.completedStages).toContain("writing.sections");
      expect(run.completedStages).toContain("build.draft");
      expect(run.completedStages).toContain("build.final");
      // 缺材料章为空（事实已确认）→ 不应出现 author_decision
      expect(run.completedStages).not.toContain("hitl.author_decision");
      expect(run.stageResults?.["build.draft"]?.["draftArtifactId"]).toMatch(/^art-draft-rev\d+$/);

      const projectDir = stack.store.projectDir(projectId);
      // 四个规划工件
      const mapping = JSON.parse(await readFile(join(projectDir, "research", "chapter-mapping.json"), "utf8")) as {
        status: string;
        chapters: Array<{ chapterId: string; responsibility: string; factIds: string[] }>;
      };
      expect(mapping.status).toBe("confirmed");
      expect(mapping.chapters.length).toBeGreaterThanOrEqual(4);
      expect(mapping.chapters.find((chapter) => chapter.responsibility === "method")?.factIds.length).toBeGreaterThan(0);
      const thesisModel = JSON.parse(await readFile(join(projectDir, "manuscript", "thesis.json"), "utf8")) as {
        chapters: Array<{ chapterId: string; sections: string[] }>;
      };
      expect(thesisModel.chapters.length).toBe(mapping.chapters.length);
      const outline = JSON.parse(await readFile(join(projectDir, "manuscript", "outline.json"), "utf8")) as {
        sections: Array<{ file: string }>;
      };
      const mappedFiles = thesisModel.chapters.flatMap((chapter) => chapter.sections).sort();
      expect(outline.sections.map((section) => section.file).sort()).toEqual(mappedFiles);
      // 装配产物（manuscript-thesis/main.tex 存在且为 ctexbook）
      const mainTex = await readFile(join(projectDir, "manuscript-thesis", "main.tex"), "utf8");
      expect(mainTex).toContain("ctexbook");
      // gate 报告：四条 thesis 规则
      const gateFiles = await readdirSafe(join(projectDir, "reviews"));
      const gateFile = gateFiles.find((name) => /^quality-gate-r\d+\.json$/.test(name));
      expect(gateFile).toBeTruthy();
      const gate = JSON.parse(await readFile(join(projectDir, "reviews", gateFile!), "utf8")) as {
        gate: { passed: boolean; rules: Array<{ rule: string; passed: boolean }> };
      };
      expect(gate.gate.passed).toBe(true);
      const ruleIds = gate.gate.rules.map((rule) => rule.rule);
      for (const rule of ["published_facts_zero_drift", "thesis_mapping_confirmed", "thesis_structure_complete", "thesis_conflicts_resolved"]) {
        expect(ruleIds).toContain(rule);
        expect(gate.gate.rules.find((entry) => entry.rule === rule)?.passed).toBe(true);
      }
      // Writer prompt 事实纪律（已确认事实表进入核心章 prompt；未确认数值禁令进入无事实章）
      const sectionPrompts = scripted.tasks
        .filter((task) => task.contextScope === "writing/sections")
        .map((task) => task.task);
      expect(sectionPrompts.length).toBeGreaterThanOrEqual(outline.sections.length);
      const methodPrompt = sectionPrompts.find((task) => task.includes("核心方法设计"));
      expect(methodPrompt).toBeTruthy();
      expect(methodPrompt).toContain("作者已确认的研究成果事实");
      expect(methodPrompt).toContain("0.724");
      // 学位论文章节定位纪律
      expect(sectionPrompts.some((task) => task.includes("【学位论文章节】"))).toBe(true);
    },
    300_000,
  );

  it(
    "路径 B（冲突）：同实验异值 → hitl.fact_conflicts 暂停 → adopt_fact → 恢复并完成",
    async () => {
      const projectId = await createThesisProject(stack, "消融冲突学位论文B");
      const a = await seedResearchInput(stack, projectId, {
        fileName: "conflict-a.pdf",
        inputType: "published_paper",
        title: "会议版论文",
        blocks: [
          textBlock("B0001", 1, `会议版。${THESIS_CONTRIBUTION_QUOTE}`),
          tableBlock("B0002", 8, ["Type", "Baseline", "S ↑", "max F ↑", "M↓"], [
            ["SSAA", "explicit", "0.724", "0.603", "0.092"],
            ["SSAA", "implicit", "0.684", "0.593", "0.103"],
            ["SSLSTM", "w/o SSLSTM", "0.667", "0.541", "0.132"],
          ], "Table 5"),
        ],
      });
      const b = await seedResearchInput(stack, projectId, {
        fileName: "conflict-b.pdf",
        inputType: "unpublished_manuscript",
        title: "学位论文稿",
        blocks: [
          textBlock("B0001", 1, `扩展稿。${THESIS_CONTRIBUTION_QUOTE}`),
          tableBlock("B0002", 63, ["Type", "Baseline", "S ↑", "max F ↑", "M↓"], [
            ["SSAA explicit implicit", "", "0.699", "0.630", "0.098"],
            ["SSAA", "", "0.684", "0.593", "0.103"],
            ["SSLSTM", "w/o SSLSTM", "0.667", "0.541", "0.132"],
          ], "表4.3"),
        ],
      });

      const runId = await startThesisRun(stack, projectId);
      // 阶段 1：停等 scope_and_version（include 两输入 + 未发表允许 + 贡献确认）
      const run1 = await pollRun(stack, runId, {
        decisions: {
          "hitl.scope_and_version": async (payload) => {
            const proposed = (payload?.["inputs"] as { proposed?: Array<{ inputId: string }> } | undefined)?.proposed ?? [];
            if (proposed.length > 0) {
              return { decision: "include", payload: { inputId: proposed[0]!.inputId, actorKind: "test_fixture" } };
            }
            const contributions = (payload?.["contributions"] as Array<{ id: string; status: string }> | undefined) ?? [];
            const unconfirmed = contributions.filter((item) => item.status === "proposed").map((item) => item.id);
            if (unconfirmed.length > 0) {
              return { decision: "confirm_contribution", payload: { contributionIds: unconfirmed, actorKind: "test_fixture" } };
            }
            // 未发表材料政策（conflict-b 是 unpublished_manuscript）
            const pending = (payload?.["pendingDecisions"] as Array<{ type: string; subject: string }> | undefined) ?? [];
            const unpublished = pending.find((item) => item.type === "unpublished_material_policy");
            if (unpublished !== undefined) {
              return { decision: "allow_unpublished", payload: { inputId: unpublished.subject, actorKind: "test_fixture" } };
            }
            return { decision: "approve", payload: { actorKind: "test_fixture" } };
          },
          "hitl.fact_conflicts": () => "stop",
        },
        timeoutMs: 120_000,
      });
      // scope 解决后应停在 hitl.fact_conflicts（3 条 blocking value_mismatch）
      expect(run1.status).toBe("awaiting_input");
      expect(run1.awaiting?.stageId).toBe("hitl.fact_conflicts");
      const conflicts = (run1.awaiting?.payload?.["unresolved"] as Array<{ conflictId: string; classification: string }[]> | undefined) ?? [];
      void conflicts;

      // 阶段 2：逐条 adopt_fact（采纳会议版第一方）→ 完成
      const conflictList = (await getRun(stack, runId)).awaiting?.payload?.["unresolved"] as Array<{
        conflictId: string;
        parties: Array<{ factId: string; raw: string }>;
      }>;
      expect(conflictList.length).toBeGreaterThanOrEqual(3);
      expect(conflictList[0]).toMatchObject({ classification: "value_mismatch" });

      // 先查双方 factId → adopt 第一方
      const factsResponse = await stack.request("GET", `/api/projects/${projectId}/research-inputs/facts?conflictStatus=unresolved`);
      const unresolvedFacts = factsResponse.body["facts"] as Array<{ factId: string; researchInputId: string }>;
      const conflictsResponse = await stack.request("GET", `/api/projects/${projectId}/research-inputs/conflicts?status=unresolved`);
      const allConflicts = conflictsResponse.body["conflicts"] as Array<{ conflictId: string; parties: Array<{ factId: string; researchInputId: string }> }>;
      expect(allConflicts.length).toBeGreaterThanOrEqual(3);
      let adopted = 0;
      for (const conflict of allConflicts) {
        // 等待 run 重新进入 awaiting（resume → 重规划 → 再次停等是异步的）
        const ready = await waitForAwaiting(stack, runId, "hitl.fact_conflicts", 30_000);
        if (!ready && adopted === allConflicts.length - 1) break; // 最后一条裁决后已推进
        const adoptedFact = conflict.parties.find((party) => party.researchInputId === a.inputId) ?? conflict.parties[0]!;
        const decision = await stack.request("POST", `/api/runs/${runId}/resume`, {
          decision: "adopt_fact",
          payload: { conflictId: conflict.conflictId, adoptedFactId: adoptedFact.factId, actorKind: "test_fixture" },
        });
        expect(decision.status).toBe(200);
        adopted += 1;
      }
      expect(adopted).toBeGreaterThanOrEqual(3);
      void unresolvedFacts;
      void b;

      // 阶段 3：恢复 → outline approve →（本路径未确认事实 → 缺材料章按限制口径）→ 完成
      const run2 = await pollRun(stack, runId, {
        decisions: {
          "hitl.outline_confirm": () => ({ decision: "approve", payload: { actorKind: "test_fixture" } }),
          "hitl.author_decision": (payload) => {
            const missing = (payload?.["missingChapters"] as Array<{ chapterId: string }> | undefined) ?? [];
            if (missing.length === 0) {
              return { decision: "approve", payload: { actorKind: "test_fixture" } };
            }
            return {
              decision: "write_as_limitation",
              payload: { subject: missing[0]!.chapterId, actorKind: "test_fixture" },
            };
          },
        },
      });
      expect(run2.status).toBe("completed");
      expect(run2.completedStages).toContain("hitl.fact_conflicts");
      expect(run2.completedStages).toContain("build.draft");
      // 冲突裁决后 unresolved=0
      const finalConflicts = await stack.request("GET", `/api/projects/${projectId}/research-inputs/conflicts?status=unresolved`);
      expect((finalConflicts.body["conflicts"] as unknown[]).length).toBe(0);
    },
    300_000,
  );

  it(
    "路径 C（缺材料）：核心章无可写事实 → hitl.author_decision → write_as_limitation（不编数值）",
    async () => {
      const projectId = await createThesisProject(stack, "缺材料学位论文C");
      await seedResearchInput(stack, projectId, {
        fileName: "sparse.pdf",
        inputType: "published_paper",
        title: "方法论文（无事实确认）",
        blocks: paperBlocks(true), // 表格事实存在但不做 fact_confirmation → 无 authorConfirmed
      });

      const runId = await startThesisRun(stack, projectId);
      const run = await pollRun(stack, runId, {
        decisions: {
          "hitl.scope_and_version": scopeDecisionSequence({ confirmFacts: false }),
          "hitl.outline_confirm": () => ({ decision: "approve", payload: { actorKind: "test_fixture" } }),
          "hitl.author_decision": (payload) => {
            const missing = (payload?.["missingChapters"] as Array<{ chapterId: string }> | undefined) ?? [];
            expect(missing.length).toBeGreaterThan(0);
            return {
              decision: "write_as_limitation",
              payload: { subject: missing[0]!.chapterId, actorKind: "test_fixture" },
            };
          },
        },
      });
      expect(run.status).toBe("completed");
      expect(run.completedStages).toContain("hitl.author_decision");
      // 写作完成且限制章 prompt 含研究限制口径
      const sectionPrompts = scripted.tasks.filter((task) => task.contextScope === "writing/sections").map((task) => task.task);
      const recentPrompts = sectionPrompts.slice(-12);
      expect(recentPrompts.some((task) => task.includes("【作者决定：研究限制口径】"))).toBe(true);
      expect(recentPrompts.some((task) => task.includes("不得出现任何具体数值") || task.includes("不得虚构进展"))).toBe(true);
      expect(run.stageResults?.["writing.sections"]?.["chaptersWithLimitationMode"]).toBeTruthy();
    },
    300_000,
  );

  it(
    "路径 D（恢复）：写作中段单次失败 → stage 重试 journal 复用已完成节（零重复生成）",
    async () => {
      // 独立栈：writing/sections 第 3 次调用返回非法输出（含 \documentclass → 节级拒绝）
      const scriptedLocal = createScriptedRuntime({ reviewSequence: ["pass"] });
      const flaky = flakyWriterRuntime(scriptedLocal.runtime, 3);
      const localStack = await startTestStack(flaky.runtime, {
        search: { disabledProviders: ["openalex", "semantic-scholar", "arxiv", "aminer", "searxng"], providerTimeoutMs: 2_000 },
      });
      try {
        const projectId = await createThesisProject(localStack, "恢复路径学位论文D");
        await seedResearchInput(localStack, projectId, {
          fileName: "recover.pdf",
          inputType: "published_paper",
          title: "恢复论文",
          blocks: paperBlocks(true),
        });
        const runId = await startThesisRun(localStack, projectId);
        const run = await pollRun(localStack, runId, {
          decisions: {
            "hitl.scope_and_version": scopeDecisionSequence({ confirmFacts: true }),
            "hitl.outline_confirm": () => ({ decision: "approve", payload: { actorKind: "test_fixture" } }),
          },
        });
        expect(run.status).toBe("completed");
        const writing = run.stageResults?.["writing.sections"];
        const total = writing?.["sectionsWritten"] as number;
        expect(total).toBeGreaterThan(0);
        // journal 复用：重试后前两节被跳过（零模型调用）
        expect(writing?.["sectionsReused"]).toBe(2);
        expect((writing?.["reusedSections"] as string[]).length).toBe(2);
        // 模型调用数 = 新写节 + 复用节 + 1 次失败调用（复用节零模型调用）
        expect(flaky.sectionCalls()).toBe(total + (writing?.["sectionsReused"] as number) + 1);
      } finally {
        await localStack.cleanup();
      }
    },
    300_000,
  );

  it(
    "路径 E（失败）：大纲规划持续不可修复 → run failed，无 Draft 产物冒充成功",
    async () => {
      const localStack = await startTestStack(
        scopeOverrideRuntime(createScriptedRuntime({ reviewSequence: ["pass"] }).runtime, "thesis/outline", "{这不是JSON"),
        {
          search: { disabledProviders: ["openalex", "semantic-scholar", "arxiv", "aminer", "searxng"], providerTimeoutMs: 2_000 },
        },
      );
      try {
        const projectId = await createThesisProject(localStack, "失败路径学位论文E");
        await seedResearchInput(localStack, projectId, {
          fileName: "doomed.pdf",
          inputType: "published_paper",
          title: "失败论文",
          blocks: paperBlocks(true),
        });
        const runId = await startThesisRun(localStack, projectId);
        const run = await pollRun(localStack, runId, {
          decisions: {
            "hitl.scope_and_version": scopeDecisionSequence({ confirmFacts: false }),
          },
        });
        expect(run.status).toBe("failed");
        expect(run.error?.message ?? "").toMatch(/大纲规划|确定性校验/);
        // 无任何 Draft 产物
        const artifacts = await localStack.request("GET", `/api/projects/${projectId}/artifacts`);
        const body = artifacts.body as { artifacts?: Array<{ artifactId: string }> };
        expect((body.artifacts ?? []).filter((artifact) => artifact.artifactId.startsWith("art-draft"))).toHaveLength(0);
      } finally {
        await localStack.cleanup();
      }
    },
    300_000,
  );
});

async function readdirSafe(path: string): Promise<string[]> {
  try {
    const { readdir } = await import("node:fs/promises");
    return await readdir(path);
  } catch {
    return [];
  }
}

