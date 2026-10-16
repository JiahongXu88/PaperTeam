/**
 * M14.4 P0-3/P0-4 集成：修订循环收敛 + 最佳合法版本保留/恢复（真实
 * WorkflowOrchestrator + scripted runtime，thesis_from_papers 全流程）。
 *
 * 确定性回放（M14.3 R3 真实故障形态）：
 *  - 场景 B/H：修订后质量劣化（fail3 → fail）→ REGRESSION 自动停止（stalled
 *    HITL，不再「还有轮数就继续」）→ accept_draft → build.draft 从最佳合法
 *    版本（round-1 写作完成态）恢复 → Draft PDF——不再需要人工恢复 rev-3；
 *  - 场景 C：连续同型失败（fail → fail）→ CONVERGED 停止；当前稿不劣于最佳
 *    → 不恢复（不追噪声）；
 *  - 场景 F：run 级模型预算耗尽 → planner 优雅降级（overflow HITL → Draft），
 *    不再启动第二轮 review。
 *
 * 修订 Writer 行为（确定性 wrapper）：bounded 提案 = 当前 span 内容 + 无害补充句
 * （无数字 / 无引用 / 无结构变化——通过全部候选守卫，产生真实新修订号）。
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";

import { scriptedIdeaRuntime, startTestStack, type TestStack } from "../helpers/testStack.js";
import type { RunAgentInput } from "../../src/runtime/types.js";
import type { ParsedDocument, ParsedBlock } from "../../src/ingestion/types.js";
import { tableBlock, textBlock, THESIS_CONTRIBUTION_QUOTE } from "../thesis/fixtures.js";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

/** bounded 修订提案：span 当前内容 + 无害补充句（通过全部候选守卫） */
const REVISION_APPENDIX = "\n\n本节补充说明：评测口径在不同划分下保持一致，结论方向不变。";
const THESIS_SECTION = "sections/method-design.tex";

/** 按轮次的 review 输出（digest 三路；section 指向真实 thesis 节文件） */
export const ROUND1_ACADEMIC = JSON.stringify({
  summary: "结构与论证尚可，总分未过线。",
  scores: { 问题定义: 80, 方法合理性: 78, 实验充分性: 74, 论证逻辑: 79, 写作质量: 82 },
  overallScore: 78,
  issues: [
    { category: "academic", severity: "major", section: THESIS_SECTION, description: "缺少与基线方法的对比实验", suggestedAction: "补充对比实验", blocking: false },
  ],
});
const ROUND2_ACADEMIC = JSON.stringify({
  summary: "结构与论证明显退化。",
  scores: { 问题定义: 70, 方法合理性: 65, 实验充分性: 55, 论证逻辑: 68, 写作质量: 72 },
  overallScore: 66,
  issues: [
    { category: "academic", severity: "major", section: THESIS_SECTION, description: "缺少与基线方法的对比实验", suggestedAction: "补充对比实验", blocking: false },
    { category: "academic", severity: "major", section: THESIS_SECTION, description: "方法动机论述不完整，需补齐设计依据", suggestedAction: "补全动机论述", blocking: false },
  ],
});
const ROUND2_FACT = JSON.stringify({
  summary: "存在无证据支撑的关键论断。",
  claims: [
    { section: THESIS_SECTION, claim: "评测口径一致", verdict: "UNSUPPORTED", note: "Evidence 未覆盖" },
  ],
  issues: [
    { category: "fact", severity: "critical", section: THESIS_SECTION, description: "评测口径一致无证据支撑", suggestedAction: "弱化或补证", blocking: true },
  ],
});
const PASS_ACADEMIC = JSON.stringify({
  summary: "结构完整、论证清晰。",
  scores: { 问题定义: 88, 方法合理性: 85, 实验充分性: 82, 论证逻辑: 86, 写作质量: 90 },
  overallScore: 86,
  issues: [],
});
export const PASS_FACT = JSON.stringify({
  summary: "关键论断均有证据支撑。",
  claims: [
    { section: THESIS_SECTION, claim: "方法有效", verdict: "SUPPORTED", evidenceId: "E001" },
  ],
  issues: [],
});
export const PASS_STYLE = JSON.stringify({ summary: "文风自然。", riskScore: 18, issues: [] });
const ROUND2_STYLE = JSON.stringify({ summary: "模板化表达增多。", riskScore: 68, issues: [
  { category: "style", severity: "minor", section: THESIS_SECTION, description: "连接词滥用", suggestedAction: "改写过渡句", blocking: false },
] });

interface ConvSpec {
  /** 每轮三路 review 输出（academic / fact / style）；缺省 pass */
  rounds: Array<{ academic: string; fact: string; style: string }>;
}

function convergenceRuntime(base: ReturnType<typeof scriptedIdeaRuntime>["runtime"], spec: ConvSpec, counter?: { calls: number }) {
  let reviewRound = 0;
  return {
    ...base,
    runAgent: async (input: RunAgentInput) => {
      if (input.contextScope === "writing/revision-proposal") {
        const marker = "===== 本章节当前内容 =====";
        const start = input.task.indexOf(marker);
        if (start !== -1) {
          const rest = input.task.slice(start + marker.length);
          const end = rest.indexOf("\n=====");
          const current = end === -1 ? rest : rest.slice(0, end);
          const now = new Date().toISOString();
          return {
            agentId: "writer", taskId: `conv-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
            status: "completed" as const, createdAt: now, updatedAt: now,
            output: current.trimEnd() + REVISION_APPENDIX, events: [],
          } as never;
        }
      }
      const scope = input.contextScope ?? "";
      if (scope === "review/academic" || scope === "review/fact" || scope === "review/style") {
        // 每轮以 review/academic 开始（digest 三路顺序固定）——按该 scope 计轮
        if (scope === "review/academic") reviewRound += 1;
        const round = spec.rounds[Math.min(reviewRound - 1, spec.rounds.length - 1)] ?? { academic: PASS_ACADEMIC, fact: PASS_FACT, style: PASS_STYLE };
        const output = scope === "review/academic" ? round.academic : scope === "review/fact" ? round.fact : round.style;
        const now = new Date().toISOString();
        return {
          agentId: "reviewer", taskId: `rev-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
          status: "completed" as const, createdAt: now, updatedAt: now, output, events: [],
        } as never;
      }
      if (counter !== undefined) counter.calls += 1;
      return base.runAgent(input);
    },
  };
}

async function seedInput(stack: TestStack, projectId: string, fileName: string, withTable: boolean): Promise<void> {
  const { source } = await stack.stack.sources.add(projectId, {
    fileName,
    content: Buffer.from(`%PDF-1.5\n${fileName}-content`, "utf8"),
  });
  const blocks: ParsedBlock[] = [
    textBlock("B0001", 1, `研究背景与动机。${THESIS_CONTRIBUTION_QUOTE}`),
    textBlock("B0002", 2, "方法细节与实验设置。"),
    ...(withTable
      ? [tableBlock("B0003", 3, ["Method", "S ↑"], [["Ours", "0.724"], ["Base", "0.667"]], "表1 消融实验")]
      : []),
  ];
  const document: ParsedDocument = {
    schemaVersion: 1, sourceId: source.sourceId, fileName, storedFileName: fileName,
    kind: "pdf", mimeType: "application/pdf", parser: { id: "test-fixture", version: "1" },
    parseMode: "structured", status: "ok",
    pageCount: 3, blocks, counts: { text: 2 } as ParsedDocument["counts"], notes: [],
    contentHash: source.contentHash!, parsedAt: new Date().toISOString(),
  };
  await stack.stack.parsedDocuments.save(projectId, document);
  const result = await stack.stack.researchInputs.register(projectId, { sourceId: source.sourceId, inputType: "published_paper", title: `Input ${fileName}` }, { ensureParsed: false });
  await stack.stack.researchInputs.registry.refreshParse(projectId, result.input.inputId);
}

interface RunView {
  status: string;
  projectId?: string;
  awaiting?: { stageId: string; payload?: Record<string, unknown> };
  completion?: { label: string; summary?: Record<string, unknown> };
  error?: { code?: string; message?: string; stageId?: string };
  stageHistory?: Array<{ stageId: string; status: string }>;
  stageResults?: Record<string, Record<string, unknown>>;
}

async function getRun(stack: TestStack, runId: string): Promise<RunView> {
  const response = await stack.request("GET", `/api/runs/${runId}`);
  expect(response.status).toBe(200);
  return response.body["run"] as RunView;
}

export async function poll(
  stack: TestStack,
  runId: string,
  stalledDecision: "accept_draft",
  timeoutMs = 120_000,
): Promise<RunView> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = await getRun(stack, runId);
    if (run.status === "awaiting_input" && run.awaiting !== undefined) {
      const { stageId, payload } = run.awaiting;
      let decision = "approve";
      let body: Record<string, unknown> = { actorKind: "test_fixture" };
      if (stageId === "hitl.scope_and_version") {
        const proposed = (payload?.["inputs"] as { proposed?: Array<{ inputId: string }> } | undefined)?.proposed ?? [];
        const pending = (payload?.["pendingDecisions"] as Array<{ type: string; subject: string }> | undefined) ?? [];
        if (proposed.length > 0) {
          decision = "include";
          body = { inputId: proposed[0]!.inputId, actorKind: "test_fixture" };
        } else if (pending.some((item) => item.type === "unpublished_material_policy")) {
          decision = "allow_unpublished";
          body = { inputId: pending.find((item) => item.type === "unpublished_material_policy")!.subject, actorKind: "test_fixture" };
        } else if (run.projectId !== undefined) {
          // 事实确认（HTTP 端点）+ 贡献确认 → approve
          const inputs = (payload?.["inputs"] as { included?: Array<{ inputId: string }> } | undefined)?.included ?? [];
          for (const input of inputs) {
            const factsResponse = await stack.request("GET", `/api/projects/${run.projectId}/research-inputs/facts?inputId=${input.inputId}`);
            const facts = (factsResponse.body["facts"] as Array<{ factId: string }>) ?? [];
            if (facts.length > 0) {
              await stack.request("POST", `/api/projects/${run.projectId}/research-inputs/decisions`, {
                actor: { kind: "test_fixture" },
                payload: { type: "fact_confirmation", factIds: facts.map((fact) => fact.factId), outcome: "confirmed" },
              });
            }
          }
          const contributions = (payload?.["contributions"] as Array<{ id: string; status: string }> | undefined) ?? [];
          const unconfirmed = contributions.filter((item) => item.status === "proposed").map((item) => item.id);
          if (unconfirmed.length > 0) {
            decision = "confirm_contribution";
            body = { contributionIds: unconfirmed, actorKind: "test_fixture" };
          } else {
            decision = "approve";
          }
        }
      } else if (stageId === "hitl.outline_confirm") {
        decision = "approve";
      } else if (stageId === "hitl.revision_stalled" || stageId === "hitl.revision_overflow") {
        decision = stalledDecision;
      } else if (stageId === "hitl.revision_validation") {
        decision = "approve";
      } else if (stageId === "hitl.author_decision") {
        decision = "approve";
      } else if (stageId === "hitl.style_polish") {
        decision = "skip";
      }
      const resume = await stack.request("POST", `/api/runs/${runId}/resume`, { decision, payload: body });
      if (resume.status >= 400) {
        throw new Error(`resume 被拒（${stageId}/${decision}）：${JSON.stringify(resume.body).slice(0, 300)}`);
      }
      continue;
    }
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") return run;
    if (Date.now() > deadline) throw new Error(`poll 超时（status=${run.status}，awaiting=${run.awaiting?.stageId ?? "无"}）`);
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

export async function setupConvergenceRun(
  spec: ConvSpec,
  options: { runBudget?: { maxModelCallsPerRun: number; maxRunTokensPerRun: number }; counter?: { calls: number } } = {},
): Promise<{ stack: TestStack; runId: string; projectId: string }> {
  const scripted = scriptedIdeaRuntime({ reviewSequence: ["pass"] });
  const stack = await startTestStack(convergenceRuntime(scripted.runtime, spec, options.counter), {
    registerCleanup: (cleanup) => cleanups.push(cleanup),
    stageBudget: { timeoutMs: 60_000, maxAttempts: 2 },
    ...(options.runBudget !== undefined ? { runBudget: options.runBudget } : {}),
  });
  const createResponse = await stack.request("POST", "/api/projects", { title: `M14.4 收敛 ${spec.rounds.length} 轮`, documentType: "master_thesis" });
  const projectId = (createResponse.body["project"] as { id: string }).id;
  await seedInput(stack, projectId, "conv-a.pdf", true);
  await seedInput(stack, projectId, "conv-b.pdf", false);
  const start = await stack.request("POST", `/api/projects/${projectId}/workflows`, {});
  expect(start.status).toBe(202);
  return { stack, runId: start.body["runId"] as string, projectId };
}

export const reviewCompletions = (run: RunView): number =>
  (run.stageHistory ?? []).filter((record) => record.stageId === "review.run" && record.status === "completed").length;
export const reviseCompletions = (run: RunView): number =>
  (run.stageHistory ?? []).filter((record) => record.stageId === "revision.revise" && record.status === "completed").length;

describe("M14.4 修订循环收敛与最佳版本恢复（thesis_from_papers 全流程）", () => {
  it("场景 B/H：修订劣化 → REGRESSION 自动停止 → accept_draft → 从最佳版本恢复构建 Draft", { timeout: 240_000 }, async () => {
    const { stack, runId, projectId } = await setupConvergenceRun({
      rounds: [
        { academic: ROUND1_ACADEMIC, fact: PASS_FACT, style: PASS_STYLE },
        { academic: ROUND2_ACADEMIC, fact: ROUND2_FACT, style: ROUND2_STYLE },
      ],
    });
    const run = await poll(stack, runId, "accept_draft");
    expect(run.status).toBe("completed");
    expect(run.completion?.label).toBe("draft");
    // 循环在第 2 轮 review 后停止（劣化判定优先于剩余轮数；无第 3 轮）
    expect(reviewCompletions(run)).toBe(2);
    expect(reviseCompletions(run)).toBe(1);
    // 最佳合法版本 = round-1 写作完成态；build 从恢复版本构建
    const best = JSON.parse(await readFile(join(stack.store.reviewsDir(projectId), "best-revision.json"), "utf8")) as { revision: number; runId: string };
    expect(best.revision).toBe(1);
    expect(best.runId).toBe(runId);
    const buildResult = run.stageResults?.["build.draft"] ?? {};
    expect(buildResult["restoredBestFrom"]).toBe(1);
    expect(run.completion?.summary?.["restoredBestFrom"]).toBe(1);
    expect(run.completion?.summary?.["draftArtifactId"]).toMatch(/^art-draft/);
    // 恢复产生新的不可变修订（rev-3，restoredFrom rev-1；历史不动）
    expect(buildResult["revision"]).toBe(3);
    // 恶化轮未污染终态语义：Draft 不冒充 Publication Ready
    expect(run.completion?.summary?.["qualityGatePassed"]).toBe(false);
    expect(run.completion?.summary?.["qualityStatus"]).toBeTruthy();
  });

  it("场景 C：连续同型失败 → CONVERGED 停止；不劣于最佳 → 不恢复（不追噪声）", { timeout: 240_000 }, async () => {
    const sameRound = { academic: ROUND1_ACADEMIC, fact: PASS_FACT, style: PASS_STYLE };
    const { stack, runId, projectId } = await setupConvergenceRun({ rounds: [sameRound, sameRound] });
    const run = await poll(stack, runId, "accept_draft");
    expect(run.status).toBe("completed");
    expect(run.completion?.label).toBe("draft");
    expect(reviewCompletions(run)).toBe(2);
    expect(reviseCompletions(run)).toBe(1);
    const best = JSON.parse(await readFile(join(stack.store.reviewsDir(projectId), "best-revision.json"), "utf8")) as { revision: number };
    expect(best.revision).toBe(1);
    const buildResult = run.stageResults?.["build.draft"] ?? {};
    expect(buildResult["restoredBestFrom"]).toBeUndefined();
    expect(run.completion?.summary?.["restoredBestFrom"]).toBeUndefined();
    // 交付 = 当前修订（round-2 后的 rev-2），未被回滚
    expect(buildResult["revision"]).toBe(2);
  });

  it("场景 F：run 级模型预算耗尽 → 第二轮 review 不再启动（overflow HITL → Draft，优雅降级）", { timeout: 240_000 }, async () => {
    // 基线计数：writing/规划等调用 + 每轮 3 路 review + 每轮 1 次 bounded 修订
    const counter = { calls: 0 };
    const spec: ConvSpec = {
      rounds: [
        { academic: ROUND1_ACADEMIC, fact: PASS_FACT, style: PASS_STYLE },
        { academic: ROUND2_ACADEMIC, fact: ROUND2_FACT, style: ROUND2_STYLE },
      ],
    };
    const baseline = await setupConvergenceRun(spec, { counter });
    const baselineRun = await poll(baseline.stack, baseline.runId, "accept_draft");
    expect(baselineRun.status).toBe("completed");
    const totalBaseline = counter.calls + 3 * reviewCompletions(baselineRun) + reviseCompletions(baselineRun);
    // 预算恰好覆盖 writing + 第一轮 review（3）+ 第一次修订（1）——第二轮 review 不再启动
    const budget = Math.max(1, totalBaseline - 3);

    const budgetRun = await setupConvergenceRun(spec, {
      runBudget: { maxModelCallsPerRun: budget, maxRunTokensPerRun: 0 },
    });
    const run = await poll(budgetRun.stack, budgetRun.runId, "accept_draft");
    expect(run.status).toBe("completed");
    expect(run.completion?.label).toBe("draft");
    // 第二轮 review 从未启动（预算优先于「再审一轮」）
    expect(reviewCompletions(run)).toBe(1);
    expect(reviseCompletions(run)).toBe(1);
    expect(run.completion?.summary?.["modelBudgetExhausted"]).toBe(true);
    // 账本落盘且调用数不超预算
    const ledger = JSON.parse(await readFile(join(budgetRun.stack.store.researchDir(budgetRun.projectId), "model-ledger.json"), "utf8")) as { entries: Record<string, { calls: number }> };
    const entry = Object.values(ledger.entries)[0]!;
    expect(entry.calls).toBeLessThanOrEqual(budget);
    // 无恢复：终局（round-1）即最佳
    expect(run.stageResults?.["build.draft"]?.["restoredBestFrom"]).toBeUndefined();
  });
});
