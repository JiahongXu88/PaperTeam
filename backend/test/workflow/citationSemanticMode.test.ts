/**
 * CitationSemanticMode（引用语义核验可配置）测试：
 *   - 新 Review 缺省 off：citation.claims stage 不进入（真跳过，非跑完隐藏）、
 *     semantic 模型调用 0、报告按轮记录 mode=off 且不携带语义统计
 *   - 显式 off 同上；contradiction_only：claims stage 运行 contradiction 路径
 *     （judge 只回答 CONTRADICTED / NO_CONTRADICTION_DETECTED）
 *   - 非法值 → 400
 *   - 旧持久化 run（request 无该字段）→ 按 full 解释（planner 纯函数单测）
 *   - off 轮 Markdown 导出：写明「本轮未开启」，不输出空统计、不混入历史 records
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PdfParser, RawPdfExtraction } from "../../src/paper/PdfParser.js";
import type { AgentRuntime, AgentTask, RunAgentInput } from "../../src/runtime/types.js";
import type { ScholarlyProvider, ScholarlyQuery, LookupOutcome } from "../../src/citation/scholarly.js";
import { startTestStack, type TestStack } from "../helpers/testStack.js";
import { createExistingPaperReviewDefinition } from "../../src/workflow/definitions.js";
import { readSemanticMode } from "../../src/citation/semanticMode.js";
import type { WorkflowState } from "../../src/workflow/types.js";

const ABSTRACT =
  "The dominant sequence transduction models are based on recurrent networks. We propose the Transformer, relying entirely on attention. Our model achieves 28.4 BLEU on WMT 2014 English-to-German translation.";

/** scholarly fake provider：echo 查询字段 → 一致 match（带摘要），让语义 judge 走真实证据路径 */
class AlwaysMatchProvider implements ScholarlyProvider {
  readonly name = "crossref" as const;
  callCount = 0;

  async lookup(query: ScholarlyQuery): Promise<LookupOutcome> {
    this.callCount += 1;
    return {
      kind: "match",
      record: {
        provider: "crossref",
        recordId: `10.1000/${(query.title ?? "fake").toLowerCase().replace(/\s+/g, "-").slice(0, 24)}`,
        ...(query.title !== undefined ? { title: query.title } : {}),
        ...(query.authors !== undefined ? { authors: query.authors } : {}),
        ...(query.year !== undefined ? { year: query.year } : {}),
        ...(query.doi !== undefined ? { doi: query.doi } : {}),
        abstract: ABSTRACT,
        retrievedAt: "2026-09-07T00:00:00.000Z",
      },
    };
  }
}

interface RecordedCall {
  agentId: string;
  contextScope: string | undefined;
  task: string;
}

/**
 * Review Runtime：分章节 findings 空；citation/semantic scope 按 claim 文本脚本化——
 * 「attention eliminates recurrence」论断判 CONTRADICTED（矛盾路径），其余 NO_CONTRADICTION_DETECTED。
 */
function makeModeRuntime(): { runtime: AgentRuntime; calls: RecordedCall[] } {
  const calls: RecordedCall[] = [];
  const runtime: AgentRuntime = {
    provider: "pi",
    healthCheck: async () => ({
      ok: true,
      provider: "pi",
      status: "healthy",
      detail: "ok",
      latencyMs: 1,
      checkedAt: new Date().toISOString(),
    }),
    async runAgent(input: RunAgentInput): Promise<AgentTask> {
      calls.push({ agentId: input.agentId, contextScope: input.contextScope, task: input.task });
      const scope = input.contextScope ?? "";
      let output = JSON.stringify({ findings: [] });
      if (scope.startsWith("review/section/")) {
        output = JSON.stringify({ findings: [] });
      } else if (scope.startsWith("citation/semantic/")) {
        output = input.task.includes("attention eliminates recurrence")
          ? JSON.stringify({
              verdict: "CONTRADICTED",
              reason: "证据提出完全基于 attention 的 Transformer，与「消除注意力」的论断相反",
              keyQuote: "We propose the Transformer, relying entirely on attention.",
            })
          : JSON.stringify({
              verdict: "NO_CONTRADICTION_DETECTED",
              reason: "证据未发现与论断相反的结论",
            });
      }
      const now = new Date().toISOString();
      return {
        taskId: `task-${calls.length}`,
        agentId: input.agentId,
        status: "completed",
        createdAt: now,
        updatedAt: now,
        output,
      };
    },
    async startAgent(input) {
      const task = await runtime.runAgent(input);
      return {
        taskId: task.taskId,
        sessionKey: "agent:test:test",
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
  return { runtime, calls };
}

const fakeParser: PdfParser = {
  id: "fake",
  async checkAvailability() {
    return { available: true as const, command: "fake", args: [], pythonVersion: "0", pymupdfVersion: "0" };
  },
  async parseFile(): Promise<RawPdfExtraction> {
    return {
      ok: true,
      parser: { id: "fake", version: "1" },
      pageCount: 4,
      title: "Attention Is All You Need",
      abstract: "We propose the Transformer.",
      toc: [
        [1, "Introduction", 1],
        [1, "Method", 2],
        [1, "References", 3],
      ] as Array<[number, string, number]>,
      blocks: [
        { page: 1, text: "Intro: attention eliminates recurrence [1]. " + "x".repeat(700) },
        { page: 2, text: "Method: multi-head attention blocks [2]. " + "y".repeat(700) },
        { page: 3, text: "[1] Vaswani et al. Attention Is All You Need. 2017." },
        { page: 3, text: "[2] Devlin et al. BERT Pre-training of Deep Bidirectional Transformers. 2019." },
      ],
      totalChars: 1800,
      notes: [],
    };
  },
};

async function waitForRun(stack: TestStack, runId: string): Promise<Record<string, unknown>> {
  let run: Record<string, unknown> = {};
  for (let attempt = 0; attempt < 400; attempt += 1) {
    run = (await stack.request("GET", `/api/runs/${runId}`)).body["run"] as Record<string, unknown>;
    if (["completed", "failed", "cancelled"].includes(String(run["status"]))) {
      return run;
    }
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
  return run;
}

async function importPaper(stack: TestStack, marker: string): Promise<string> {
  const created = await stack.request("POST", "/api/projects/import-pdf", {
    fileName: "attention.pdf",
    contentBase64: Buffer.from(`%PDF-1.5\n${marker}`).toString("base64"),
    goal: "review_only",
  });
  expect(created.status).toBe(201);
  return (created.body["project"] as Record<string, unknown>)["id"] as string;
}

const cleanups: Array<() => Promise<void>> = [];

afterAll(async () => {
  for (const cleanup of cleanups) {
    await cleanup();
  }
});

describe("citationSemanticMode：缺省 off（真跳过 semantic stage）", () => {
  let stack: TestStack;
  let modeRuntime: ReturnType<typeof makeModeRuntime>;
  let projectId: string;

  beforeAll(async () => {
    modeRuntime = makeModeRuntime();
    stack = await startTestStack(modeRuntime.runtime, {
      paperParser: fakeParser,
      registerCleanup: (cleanup) => cleanups.push(cleanup),
    });
    projectId = await importPaper(stack, "mode-off-default");
  });

  it("不传 citationSemanticMode → run 完成，completedStages 不含 citation.claims，semantic 模型调用 0", { timeout: 60_000 }, async () => {
    const started = await stack.request("POST", `/api/projects/${projectId}/workflows`, {
      kind: "existing_paper_review",
    });
    expect(started.status).toBe(202);
    const run = await waitForRun(stack, started.body["runId"] as string);
    expect(run["status"]).toBe("completed");
    expect(run["completedStages"]).toEqual([
      "paper.ensure",
      "citation.extract",
      "citation.metadata",
      "review.sections",
      "review.aggregate",
    ]);
    // 语义核验零模型调用（分章节审阅的 review/section 调用仍在）
    const semanticCalls = modeRuntime.calls.filter((call) => (call.contextScope ?? "").startsWith("citation/semantic/"));
    expect(semanticCalls).toHaveLength(0);
    expect(modeRuntime.calls.some((call) => (call.contextScope ?? "").startsWith("review/section/"))).toBe(true);
  });

  it("报告按轮记录 mode=off，且不携带语义统计（历史 records 不污染本轮）", async () => {
    const reportPath = join(stack.root, projectId, "reviews", "existing-review-r1.json");
    const report = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>;
    expect(report["citationSemanticMode"]).toBe("off");
    const integrity = report["citationIntegrity"] as Record<string, unknown>;
    expect(integrity).toBeDefined();
    expect(integrity["metadataByStatus"]).toBeDefined(); // Layer 1 始终在场
    expect("semantic" in integrity).toBe(false); // off：绝不输出「支持 0 / 证据不足 0」
    const viaHttp = await stack.request("GET", `/api/projects/${projectId}/paper-review`);
    expect((viaHttp.body["report"] as Record<string, unknown>)["citationSemanticMode"]).toBe("off");
  });

  it("run completion summary 记录 citationSemanticMode=off；run request 持久化该字段", async () => {
    const runs = (await stack.request("GET", `/api/runs?projectId=${projectId}`)).body["runs"] as Array<Record<string, unknown>>;
    const reviewRun = runs.find((run) => run["workflowKind"] === "existing_paper_review");
    expect(reviewRun).toBeDefined();
    expect((reviewRun!["request"] as Record<string, unknown>)["citationSemanticMode"]).toBe("off");
    expect((reviewRun!["completion"] as Record<string, unknown>)["summary"]).toMatchObject({
      citationSemanticMode: "off",
    });
  });

  it("off 轮 Markdown 导出：写明未开启，不输出语义统计", async () => {
    const response = await fetch(`http://127.0.0.1:${stack.port()}/api/projects/${projectId}/paper-review/export.md`);
    expect(response.status).toBe(200);
    const markdown = await response.text();
    expect(markdown).toContain("本轮未开启引用语义核验");
    expect(markdown).toContain("引用语义核验：未开启（语义模型调用 0 次）");
    expect(markdown).not.toContain("## 语义核验（Layer 2");
    expect(markdown).not.toContain("| ✅ 支持 |");
  });

  it("上一轮遗留 full 语义 records 不会显示进 off 轮报告（第二轮 off 干净）", { timeout: 60_000 }, async () => {
    // 手动补一份语义记录（模拟上一轮 full 的历史遗留——如手动「语义核验」）
    const claim = {
      claimCitationId: "legacy-claim",
      citationId: "legacy",
      referenceId: "R001",
      claimText: "legacy claim",
      sectionId: "sec01",
      page: 1,
      chunkId: "C0001",
      priority: "helpful",
      metadataStatus: "VERIFIED",
      verdict: "UNSUPPORTED",
      evidence: [],
      severity: "minor",
      status: "verified",
      fingerprint: "fp-legacy",
      verifiedAt: "2026-09-07T00:00:00.000Z",
    };
    await stack.stack.paperStore.saveRecord(projectId, "claims", "legacy-claim", claim);
    const before = await stack.request("GET", `/api/projects/${projectId}/citations/integrity`);
    expect(((before.body["report"] as Record<string, unknown>)["semantic"] as Record<string, unknown>)["total"]).toBe(1);

    // 第二轮显式 off（run 内 round 重新从 1 计：报告文件被本轮覆盖，最新报告即本轮）
    const started = await stack.request("POST", `/api/projects/${projectId}/workflows`, {
      kind: "existing_paper_review",
      citationSemanticMode: "off",
    });
    const run = await waitForRun(stack, started.body["runId"] as string);
    expect(run["status"]).toBe("completed");
    const latest = (await stack.request("GET", `/api/projects/${projectId}/paper-review`)).body["report"] as Record<string, unknown>;
    expect(latest["citationSemanticMode"]).toBe("off");
    expect("semantic" in (latest["citationIntegrity"] as Record<string, unknown>)).toBe(false);
    // 导出同样不受历史遗留影响
    const response = await fetch(`http://127.0.0.1:${stack.port()}/api/projects/${projectId}/paper-review/export.md`);
    const markdown = await response.text();
    expect(markdown).toContain("本轮未开启引用语义核验");
    expect(markdown).not.toContain("legacy claim");
  });
});

describe("citationSemanticMode：contradiction_only（仅检查明显冲突）", () => {
  let stack: TestStack;
  let modeRuntime: ReturnType<typeof makeModeRuntime>;
  let projectId: string;

  beforeAll(async () => {
    modeRuntime = makeModeRuntime();
    stack = await startTestStack(modeRuntime.runtime, {
      paperParser: fakeParser,
      citation: {
        metadataEnabled: false,
        scholarly: { providers: [new AlwaysMatchProvider()] },
      },
      registerCleanup: (cleanup) => cleanups.push(cleanup),
    });
    projectId = await importPaper(stack, "mode-contradiction");
  });

  it("claims stage 运行 contradiction 路径：prompt 要求矛盾口径，verdict 只有两种", { timeout: 60_000 }, async () => {
    const started = await stack.request("POST", `/api/projects/${projectId}/workflows`, {
      kind: "existing_paper_review",
      citationSemanticMode: "contradiction_only",
    });
    expect(started.status).toBe(202);
    const run = await waitForRun(stack, started.body["runId"] as string);
    expect(run["status"]).toBe("completed");
    expect(run["completedStages"]).toContain("citation.claims");

    const semanticCalls = modeRuntime.calls.filter((call) => (call.contextScope ?? "").startsWith("citation/semantic/"));
    expect(semanticCalls.length).toBeGreaterThanOrEqual(2);
    // contradiction prompt：明确「只判断明显矛盾」的口径
    expect(semanticCalls.every((call) => call.task.includes("是否与论文正文论断存在明显矛盾"))).toBe(true);
    expect(semanticCalls.every((call) => call.task.includes("CONTRADICTED / NO_CONTRADICTION_DETECTED"))).toBe(true);

    // 记录与报告：1 条 CONTRADICTED + 1 条 NO_CONTRADICTION_DETECTED
    const claims = (await stack.request("GET", `/api/projects/${projectId}/citations/claims`)).body["records"] as Array<Record<string, unknown>>;
    expect(claims.filter((claim) => claim["verdict"] === "CONTRADICTED")).toHaveLength(1);
    expect(claims.filter((claim) => claim["verdict"] === "NO_CONTRADICTION_DETECTED")).toHaveLength(1);
    expect(claims.every((claim) => claim["verdict"] !== "INSUFFICIENT_EVIDENCE")).toBe(true);

    const reportPath = join(stack.root, projectId, "reviews", "existing-review-r1.json");
    const report = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>;
    expect(report["citationSemanticMode"]).toBe("contradiction_only");
    const semantic = (report["citationIntegrity"] as Record<string, unknown>)["semantic"] as Record<string, unknown>;
    expect((semantic["byVerdict"] as Record<string, number>)["CONTRADICTED"]).toBe(1);
    expect((semantic["byVerdict"] as Record<string, number>)["NO_CONTRADICTION_DETECTED"]).toBe(1);

    // 导出：模式标注 + 明确矛盾明细
    const response = await fetch(`http://127.0.0.1:${stack.port()}/api/projects/${projectId}/paper-review/export.md`);
    const markdown = await response.text();
    expect(markdown).toContain("仅检查明显冲突");
    expect(markdown).toContain("### 存在矛盾（1 条）");
    expect(markdown).not.toContain("证据不足（");
  });
});

describe("citationSemanticMode：API 校验与历史兼容", () => {
  let stack: TestStack;

  beforeAll(async () => {
    const modeRuntime = makeModeRuntime();
    stack = await startTestStack(modeRuntime.runtime, {
      paperParser: fakeParser,
      registerCleanup: (cleanup) => cleanups.push(cleanup),
    });
  });

  it("非法 mode → 400", async () => {
    const projectId = await importPaper(stack, "mode-invalid");
    const started = await stack.request("POST", `/api/projects/${projectId}/workflows`, {
      kind: "existing_paper_review",
      citationSemanticMode: "sometimes",
    });
    expect(started.status).toBe(400);
    expect(String((started.body["error"] as Record<string, unknown>)["message"])).toContain("citationSemanticMode");
  });

  it("旧持久化 run（request 无该字段）→ planner 按 full 解释（citation.claims 仍在序列中）", () => {
    const definition = createExistingPaperReviewDefinition(stack.stack.workflowServices);
    const baseState: WorkflowState = {
      schemaVersion: 1,
      runId: "r-legacy",
      projectId: "p-legacy",
      workflowKind: "existing_paper_review",
      status: "running",
      createdAt: "2026-09-01T00:00:00.000Z",
      updatedAt: "2026-09-01T00:00:00.000Z",
      completedStages: ["paper.ensure", "citation.extract", "citation.metadata"],
      stageResults: {
        "paper.ensure": {},
        "citation.extract": {},
        "citation.metadata": {},
      },
      stageHistory: [],
      inputs: {},
      eventsSeq: 0,
    };
    // 无 request（旧版本创建）→ 下一 stage 是 citation.claims（full 语义）
    expect(definition.plan(baseState)).toEqual({ kind: "stage", stageId: "citation.claims" });
    // 显式 off → 跳过 claims，直接进入分章节审阅
    const offState: WorkflowState = {
      ...baseState,
      request: { citationSemanticMode: "off" },
    };
    expect(definition.plan(offState)).toEqual({ kind: "stage", stageId: "review.sections" });
    // contradiction_only / full → claims 在序列中
    expect(definition.plan({ ...baseState, request: { citationSemanticMode: "contradiction_only" } })).toEqual({
      kind: "stage",
      stageId: "citation.claims",
    });
    expect(definition.plan({ ...baseState, request: { citationSemanticMode: "full" } })).toEqual({
      kind: "stage",
      stageId: "citation.claims",
    });
  });

  it("readSemanticMode：字段缺失 → full；合法值透传；非法持久化值兜底 full", () => {
    expect(readSemanticMode(undefined)).toBe("full");
    expect(readSemanticMode({})).toBe("full");
    expect(readSemanticMode({ prompt: "x" })).toBe("full");
    expect(readSemanticMode({ citationSemanticMode: "off" })).toBe("off");
    expect(readSemanticMode({ citationSemanticMode: "contradiction_only" })).toBe("contradiction_only");
    expect(readSemanticMode({ citationSemanticMode: "full" })).toBe("full");
    expect(readSemanticMode({ citationSemanticMode: "sometimes" })).toBe("full");
  });
});
