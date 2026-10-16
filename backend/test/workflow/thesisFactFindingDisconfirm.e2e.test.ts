/**
 * M14.6（F5）— Review Finding ↔ 作者已确认研究输入事实的确定性反证 E2E。
 *
 *   正例：fact reviewer 以「本项目没有已导入的实验数据 / 不在授权范围内」为由要求删除 /
 *   弱化作者已确认事实 0.724 → review.run 把该 finding 移出 issues（不计 blocking / critical）、
 *   保留在 disconfirmedIssues（deterministicDisconfirmed=true）并写明匹配 Fact；修订计划不派发
 *   「删 0.724」；fact-authorizations 不铸弱化授权；Writer 修订从未被要求删 0.724；原稿保留。
 *
 *   反例：同样措辞但针对不在事实表中的数值 0.913 → 不反证：issue 留在 issues，修订计划有 planned 条目。
 *
 * 两个场景分别用独立栈（scripted everyRoundFactIssue 不同）。
 */
import { readFile, readdir, mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { createScriptedRuntime } from "../../src/runtime/scriptedRuntime.js";
import type { AgentRuntime, RunAgentInput, AgentTask } from "../../src/runtime/types.js";
import { startTestStack, type TestStack } from "../helpers/testStack.js";

const CURRENT_MARKER = "===== 本章节当前内容 =====";
const SEARCH_OPTIONS: Parameters<typeof startTestStack>[1] = {
  search: { disabledProviders: ["openalex", "semantic-scholar", "arxiv", "aminer", "searxng"], providerTimeoutMs: 2_000 },
};

/** 修订脚本：返回当前内容原样（不改任何字节；Writer 不违纪） */
function unchangedRevision(task: string): string {
  const start = task.indexOf(CURRENT_MARKER);
  if (start === -1) return "\\subsection{修订}\n本节内容保持不变。";
  const rest = task.slice(start + CURRENT_MARKER.length);
  const end = rest.indexOf("\n=====");
  const current = end === -1 ? rest : rest.slice(0, end);
  return current.trim() === "" ? "\\subsection{修订}\n本节内容保持不变。" : current;
}

interface RevisionCallRecorder {
  /** writing/revision 或 writing/revision-proposal 的任务文本 */
  revisionTasks: string[];
}

/**
 * 包装 Writer：学位论文方法章只在「方法总体设计」节写入 0.724；修订请求返回当前内容不变。
 */
function wrapThesisWriter(base: AgentRuntime, recorder: RevisionCallRecorder): AgentRuntime {
  return {
    ...base,
    runAgent: async (input: RunAgentInput): Promise<AgentTask> => {
      if (input.contextScope === "writing/sections" && input.task.includes("【学位论文章节】") && input.task.includes("0.724")) {
        const titleMatch = /本节「([^」]+)」/.exec(input.task);
        const title = titleMatch?.[1] ?? "方法设计";
        const withValue = title === "方法总体设计";
        return {
          taskId: `scripted-thesis-${Math.random().toString(36).slice(2, 8)}`,
          status: "completed",
          output: `\\subsection{${title}}\n\n${withValue ? "本方法在 DUTS 数据集上的 S 指标为 0.724，相比基线方法有明显提升。" : "本节阐述方法的设计考量与有效性来源。"}下面给出方法设计与分析。\n`,
        } as AgentTask;
      }
      if (input.contextScope === "writing/revision" || input.contextScope === "writing/revision-proposal") {
        recorder.revisionTasks.push(input.task);
        return {
          taskId: `scripted-revision-${Math.random().toString(36).slice(2, 8)}`,
          status: "completed",
          output: unchangedRevision(input.task),
        } as AgentTask;
      }
      return base.runAgent(input);
    },
  };
}

/** 服务级种子：研究输入（含 0.724 / 0.667 表事实）→ 抽取 → 核验 → 作者确认全部 verified 事实 */
async function seedConfirmedResearchInput(stack: TestStack, projectId: string): Promise<{ inputId: string; confirmedFactIds: string[] }> {
  const pdfText = "我们提出显著性检测方法 LSM。该方法在 DUTS 数据集上的 S 指标达到 0.724，超过基线的 0.667。消融实验见表1。";
  const { source } = await stack.stack.sources.add(projectId, {
    fileName: "disconfirm-paper.pdf",
    content: Buffer.from(`%PDF-1.5\n${pdfText}`, "utf8"),
  });
  const sourceId = source.sourceId;
  const document = {
    schemaVersion: 1 as const,
    sourceId,
    fileName: "disconfirm-paper.pdf",
    storedFileName: "disconfirm-paper.pdf",
    kind: "pdf" as const,
    mimeType: "application/pdf",
    parser: { id: "test-fixture", version: "1" },
    parseMode: "structured" as const,
    status: "ok" as const,
    pageCount: 2,
    blocks: [
      { blockId: "B0001", type: "text" as never, text: pdfText, provenance: { page: 1 } },
      {
        blockId: "B0002",
        type: "table" as never,
        headers: ["Method", "S ↑"],
        rows: [["Ours", "0.724"], ["Base", "0.667"]],
        rowCount: 2,
        columnCount: 2,
        caption: "表1 消融结果",
        provenance: { page: 2 },
      },
    ],
    counts: { text: 1, table: 1 } as never,
    notes: [],
    contentHash: source.contentHash!,
    parsedAt: new Date().toISOString(),
  };
  await stack.stack.parsedDocuments.save(projectId, document as never);
  const textLayerDir = join(stack.store.projectDir(projectId), "research", "text-layers");
  await mkdir(textLayerDir, { recursive: true });
  await writeFile(
    join(textLayerDir, `${sourceId}-${source.contentHash!.slice(0, 12)}.json`),
    JSON.stringify({
      sourceId,
      contentHash: source.contentHash,
      parser: { id: "seed" },
      pages: [
        { page: 1, text: pdfText },
        { page: 2, text: "Method S ↑ Ours 0.724 Base 0.667 表1 消融结果" },
      ],
    }),
    "utf8",
  );
  const registered = await stack.request("POST", `/api/projects/${projectId}/research-inputs`, {
    sourceId,
    inputType: "published_paper",
    title: "LSM 显著性方法",
    provenanceUri: "https://example.org/lsm",
  });
  expect(registered.status).toBeLessThan(300);
  const inputId = (registered.body["input"] as { inputId: string })["inputId"];
  await stack.stack.researchInputs.registry.refreshParse(projectId, inputId);
  await stack.stack.researchInputs.extractFacts(projectId, inputId);
  await stack.stack.researchInputs.verifyFacts(projectId, inputId);
  const factsResponse = await stack.request("GET", `/api/projects/${projectId}/research-inputs/facts?inputId=${inputId}`);
  const facts = (factsResponse.body["facts"] as Array<{ factId: string; surface?: string; verification?: { sourceCheck?: string } }>) ?? [];
  const verified = facts.filter((fact) => fact.verification?.["sourceCheck"] === "verified").map((fact) => fact.factId);
  expect(verified.length).toBeGreaterThan(0);
  expect(facts.some((fact) => (fact.surface ?? "").includes("0.724"))).toBe(true);
  const confirm = await stack.request("POST", `/api/projects/${projectId}/research-inputs/decisions`, {
    actor: { kind: "test_fixture" },
    payload: { type: "fact_confirmation", factIds: verified, outcome: "confirmed" },
  });
  expect(confirm.status).toBeLessThan(300);
  return { inputId, confirmedFactIds: verified };
}

/** 驱动 run 到终态（include → 确认贡献 → approve → 大纲 approve → 缺材料限制口径 → 溢出 accept_draft → 润色 skip） */
async function driveRunToTerminal(stack: TestStack, runId: string, timeoutMs: number): Promise<string> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = ((await stack.request("GET", `/api/runs/${runId}`)).body["run"] ?? {}) as {
      status: string;
      awaiting?: { stageId: string; payload?: Record<string, unknown> };
    };
    if (run.status === "awaiting_input" && run.awaiting !== undefined) {
      const { stageId, payload } = run.awaiting;
      let decision = "approve";
      let body: Record<string, unknown> = { actorKind: "test_fixture" };
      if (stageId === "hitl.scope_and_version") {
        const proposed = (payload?.["inputs"] as { proposed?: Array<{ inputId: string }> } | undefined)?.proposed ?? [];
        const contributions = (payload?.["contributions"] as Array<{ id: string; status: string }> | undefined) ?? [];
        const unconfirmed = contributions.filter((item) => item.status === "proposed").map((item) => item.id);
        if (proposed.length > 0) {
          decision = "include";
          body = { inputId: proposed[0]!.inputId, actorKind: "test_fixture" };
        } else if (unconfirmed.length > 0) {
          decision = "confirm_contribution";
          body = { contributionIds: unconfirmed, actorKind: "test_fixture" };
        }
      } else if (stageId === "hitl.revision_overflow" || stageId === "hitl.revision_stalled") {
        decision = "accept_draft";
      } else if (stageId === "hitl.author_decision") {
        const missing = (payload?.["missingChapters"] as Array<{ chapterId: string }> | undefined) ?? [];
        decision = missing.length > 0 ? "write_as_limitation" : "approve";
        body = { ...(missing.length > 0 ? { subject: missing[0]!.chapterId } : {}), actorKind: "test_fixture" };
      } else if (stageId === "hitl.style_polish") {
        decision = "skip";
      }
      const resume = await stack.request("POST", `/api/runs/${runId}/resume`, { decision, payload: body });
      if (resume.status >= 300) {
        throw new Error(`resume 失败（${stageId}/${decision}）：${JSON.stringify(resume.body).slice(0, 300)}`);
      }
      continue;
    }
    if (run.status === "completed" || run.status === "failed" || run.status === "cancelled") {
      return run.status;
    }
    if (Date.now() > deadline) throw new Error(`F5 E2E 超时（${run.status}）`);
    await new Promise((resolve) => setTimeout(resolve, 200));
  }
}

interface ReviewSummaryView {
  issues: Array<{ description: string; severity: string; blocking: boolean; section: string }>;
  counts: { critical: number; major: number; minor: number; blocking: number };
  disconfirmedIssues?: Array<{ description: string; deterministicDisconfirmed?: boolean; disconfirmReason?: string }>;
  researchFactDisconfirmed?: Array<{ section: string; description: string; matchedFacts: Array<{ factId: string; surface: string }>; reason: string }>;
}

interface RevisionPlanView {
  items: Array<{ kind: string; status: string; problem: string; instruction: string; mustPreserve?: { values?: string[] } }>;
}

async function readJsonIfExists<T>(path: string): Promise<T | null> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as T;
  } catch (error) {
    if ((error as { code?: string }).code === "ENOENT") return null;
    throw error;
  }
}

async function listRevisionPlans(reviewsDir: string): Promise<RevisionPlanView[]> {
  const names = (await readdir(reviewsDir).catch(() => [] as string[])).filter((name) => /^revision-plan-r\d+\.json$/.test(name)).sort();
  return Promise.all(names.map(async (name) => JSON.parse(await readFile(join(reviewsDir, name), "utf8")) as RevisionPlanView));
}

async function createProjectAndStart(stack: TestStack, title: string): Promise<{ projectId: string; runId: string }> {
  const created = await stack.request("POST", "/api/projects", { title, language: "zh", documentType: "master_thesis" });
  expect(created.status).toBe(201);
  const projectId = (created.body["project"] as { id: string })["id"];
  await seedConfirmedResearchInput(stack, projectId);
  const start = await stack.request("POST", `/api/projects/${projectId}/workflows`, { kind: "thesis_from_papers" });
  expect(start.status).toBe(202);
  return { projectId, runId: start.body["runId"] as string };
}

describe("M14.6（F5）事实 finding 确定性反证 E2E — 正例（已确认事实 0.724）", () => {
  let stack: TestStack;
  const recorder: RevisionCallRecorder = { revisionTasks: [] };

  beforeAll(async () => {
    const scripted = createScriptedRuntime({
      reviewSequence: ["pass"],
      everyRoundFactIssue: {
        category: "fact",
        severity: "critical",
        blocking: true,
        section: "sections/method-design.tex",
        description: "正文给出 S 指标 0.724 的具体实验数值，但本项目当前没有已导入的实验数据，该数值不在授权范围内。",
        suggestedAction: "删除或弱化该数值表述（改为定性描述）。",
      },
    });
    stack = await startTestStack(wrapThesisWriter(scripted.runtime, recorder), SEARCH_OPTIONS);
  });

  afterAll(async () => {
    await stack.cleanup();
  });

  it("reviewer 以「无实验数据」要求删 0.724 → 反证成立：不计阻断、不进计划、不铸授权、原稿保留", { timeout: 240_000 }, async () => {
    const { projectId, runId } = await createProjectAndStart(stack, "F5 反证学位论文（正例）");
    const terminal = await driveRunToTerminal(stack, runId, 200_000);

    const projectDir = stack.store.projectDir(projectId);
    const reviewsDir = join(projectDir, "reviews");

    // 1. review-summary-r1：finding 移出 issues，进入 disconfirmedIssues（deterministicDisconfirmed）+ researchFactDisconfirmed
    const summary = await readJsonIfExists<ReviewSummaryView>(join(reviewsDir, "review-summary-r1.json"));
    expect(summary, "reviews/review-summary-r1.json 必须存在").not.toBeNull();
    const disconfirmedEntries = summary!.researchFactDisconfirmed ?? [];
    expect(disconfirmedEntries, "researchFactDisconfirmed 应恰有 1 条").toHaveLength(1);
    expect(disconfirmedEntries[0]!.matchedFacts.some((fact) => fact.surface.replace(/\s+/g, "") === "0.724")).toBe(true);
    expect(disconfirmedEntries[0]!.description).toContain("0.724");
    expect(disconfirmedEntries[0]!.reason).toContain("作者已确认");
    expect(summary!.issues.some((issue) => issue.description.includes("0.724")), "被反证的 finding 不得留在 issues").toBe(false);
    const disconfirmedIssue = (summary!.disconfirmedIssues ?? []).find((issue) => issue.description.includes("0.724"));
    expect(disconfirmedIssue, "被反证的 finding 必须出现在 disconfirmedIssues").toBeDefined();
    expect(disconfirmedIssue!.deterministicDisconfirmed).toBe(true);
    expect(disconfirmedIssue!.disconfirmReason ?? "").toContain("0.724");
    // 注入的 critical blocking finding 是本轮唯一 finding → 反证后口径为零
    expect(summary!.counts.blocking).toBe(0);
    expect(summary!.counts.critical).toBe(0);

    // 2. revision-plan：无 planned review_finding 提及 0.724（计划文件可不存在——反证后无阻断不必派发）
    const plans = await listRevisionPlans(reviewsDir);
    for (const plan of plans) {
      const offending = plan.items.filter((item) => item.kind === "review_finding" && item.status === "planned" && item.problem.includes("0.724"));
      expect(offending, "修订计划不得派发删 0.724 的 finding").toHaveLength(0);
    }

    // 3. fact-authorizations：没有任何授权条目文本提到 0.724（不铸弱化授权）
    const authorizations = await readJsonIfExists<{ entries?: Array<{ text?: string; section?: string }> }>(join(projectDir, "research", "fact-authorizations.json"));
    if (authorizations !== null) {
      const mentioning = (authorizations.entries ?? []).filter((entry) => JSON.stringify(entry).includes("0.724"));
      expect(mentioning, "fact-authorizations 不得出现针对 0.724 的授权").toHaveLength(0);
    }

    // 4. Writer 修订从未被要求删除 0.724
    const deleteRequests = recorder.revisionTasks.filter((task) => task.includes("0.724") && task.includes("删除"));
    expect(deleteRequests, "writing/revision 任务不得包含「删除 0.724」").toHaveLength(0);

    // 5. 原稿保留 0.724
    const methodDesign = await readFile(join(projectDir, "manuscript", "sections", "method-design.tex"), "utf8");
    expect(methodDesign).toContain("0.724");

    // 终态如实：completed（Draft / Final 均可）；若非 completed 则必须与事实 / 修订链相关
    if (terminal !== "completed") {
      const finalRun = ((await stack.request("GET", `/api/runs/${runId}`)).body["run"] ?? {}) as { error?: { message?: string } };
      expect(finalRun.error?.message ?? "").toMatch(/事实|drift|fact|Draft|修订/i);
    }
  });
});

describe("M14.6（F5）事实 finding 确定性反证 E2E — 反例（无来源数值 0.913）", () => {
  let stack: TestStack;
  const recorder: RevisionCallRecorder = { revisionTasks: [] };

  beforeAll(async () => {
    const scripted = createScriptedRuntime({
      reviewSequence: ["pass"],
      everyRoundFactIssue: {
        category: "fact",
        severity: "critical",
        blocking: true,
        section: "sections/method-design.tex",
        description: "正文给出横向指标 0.913 的具体实验数值，但本项目当前没有已导入的实验数据支撑该值。",
        suggestedAction: "删除该数值（0.913），改为定性描述。",
      },
    });
    stack = await startTestStack(wrapThesisWriter(scripted.runtime, recorder), SEARCH_OPTIONS);
  });

  afterAll(async () => {
    await stack.cleanup();
  });

  it("要求删除的数值不在已确认事实表 → 不反证：issue 留在 issues、修订计划派发 planned 条目", { timeout: 240_000 }, async () => {
    const { projectId, runId } = await createProjectAndStart(stack, "F5 反证学位论文（反例）");
    await driveRunToTerminal(stack, runId, 200_000);

    const projectDir = stack.store.projectDir(projectId);
    const reviewsDir = join(projectDir, "reviews");

    const summary = await readJsonIfExists<ReviewSummaryView>(join(reviewsDir, "review-summary-r1.json"));
    expect(summary, "reviews/review-summary-r1.json 必须存在").not.toBeNull();
    expect((summary!.researchFactDisconfirmed ?? []).length, "0.913 不在事实表中：不得反证").toBe(0);
    const remaining = summary!.issues.filter((issue) => issue.description.includes("0.913"));
    expect(remaining, "未反证的 finding 必须留在 issues").toHaveLength(1);
    expect(remaining[0]!.blocking).toBe(true);
    expect(summary!.counts.blocking).toBeGreaterThanOrEqual(1);
    expect(summary!.counts.critical).toBeGreaterThanOrEqual(1);
    expect((summary!.disconfirmedIssues ?? []).some((issue) => issue.description.includes("0.913"))).toBe(false);

    // 修订计划：存在 planned 的 review_finding 条目针对 0.913
    const plans = await listRevisionPlans(reviewsDir);
    expect(plans.length, "未反证的阻断 finding 必须派发修订计划").toBeGreaterThan(0);
    // 修订计划：存在针对 0.913 的 review_finding 条目且确实被派发（status 生命周期
    // planned → applied → validated；run 完成后通常停在 validated——只要不是 skipped 即为派发）
    const related = plans.flatMap((plan) => plan.items).filter((item) => item.problem.includes("0.913"));
    const dispatched = related.filter((item) => item.kind === "review_finding" && item.status !== "skipped");
    expect(dispatched.length, `0.913 相关条目：${JSON.stringify(related)}`).toBeGreaterThan(0);
    expect(["planned", "applied", "validated"]).toContain(dispatched[0]!.status);
    // 已确认事实 0.724 作为 mustPreserve 进入该条目（修订不得顺手删掉合法数值）
    expect(dispatched.some((item) => (item.mustPreserve?.values ?? []).includes("0.724"))).toBe(true);

    // 对照：已确认事实 0.724 不受影响——原稿保留
    const methodDesign = await readFile(join(projectDir, "manuscript", "sections", "method-design.tex"), "utf8");
    expect(methodDesign).toContain("0.724");
  });
});
