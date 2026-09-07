/**
 * existing_paper_review 工作流全链路测试（Fake Runtime）：
 * Final PDF → PaperMap → Citation Integrity（extract/metadata/claims）→
 * 分章节 Review（受控 contextScope）→ ReviewFinding → 聚合报告。
 * 验证：不经过旧 manuscript review 链路；产物落盘；completion label=review。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import type { PdfParser, RawPdfExtraction } from "../../src/paper/PdfParser.js";
import type { AgentRuntime, AgentTask, RunAgentInput } from "../../src/runtime/types.js";
import { AgentRunFailedError } from "../../src/errors.js";
import { startTestStack, type TestStack } from "../helpers/testStack.js";

/** 分章节 findings 脚本：SEC01(Introduction) 一条 critical，SEC02(Method) 两条（major/minor） */
const SECTION_FINDINGS: Record<string, string> = {
  sec01: JSON.stringify({
    findings: [
      {
        category: "citation",
        severity: "critical",
        page: 1,
        claimText: "注意力机制完全消除卷积",
        message: "关键论断缺少引用支撑",
        suggestion: "补充原始文献或弱化表述",
      },
    ],
  }),
  sec02: JSON.stringify({
    findings: [
      {
        category: "academic",
        severity: "major",
        message: "方法描述缺少消融设置",
      },
      { category: "style", severity: "minor", message: "术语大小写不一致" },
    ],
  }),
  sec03: JSON.stringify({ findings: [] }),
};

interface RecordedCall {
  agentId: string;
  contextScope: string | undefined;
  task: string;
}

function makeReviewRuntime(): { runtime: AgentRuntime; calls: RecordedCall[] } {
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
      let output = "摘要：本节介绍方法。";
      if (scope.startsWith("review/section/")) {
        const section = scope.replace("review/section/", "");
        output = SECTION_FINDINGS[section] ?? JSON.stringify({ findings: [] });
      } else if (scope.startsWith("citation/semantic/")) {
        output = JSON.stringify({ verdict: "SUPPORTED", confidence: "high", reason: "一致" });
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
        { page: 3, text: "[2] Devlin et al. BERT. 2019." },
      ],
      totalChars: 1800,
      notes: [],
    };
  },
};

let stack: TestStack;
let reviewRuntime: ReturnType<typeof makeReviewRuntime>;
let projectId: string;
const cleanups: Array<() => Promise<void>> = [];

beforeAll(async () => {
  reviewRuntime = makeReviewRuntime();
  stack = await startTestStack(reviewRuntime.runtime, {
    paperParser: fakeParser,
    registerCleanup: (cleanup) => cleanups.push(cleanup),
  });
  const created = await stack.request("POST", "/api/projects/import-pdf", {
    fileName: "attention.pdf",
    contentBase64: Buffer.from("%PDF-1.5\nreview-workflow-test").toString("base64"),
    goal: "review_only",
  });
  expect(created.status).toBe(201);
  projectId = (created.body["project"] as Record<string, unknown>)["id"] as string;
});

afterAll(async () => {
  for (const cleanup of cleanups) {
    await cleanup();
  }
});

describe("existing_paper_review 工作流（Fake Runtime 全链路）", () => {
  it("从导入的 PDF 跑到聚合报告：completion=review；产物 reviews/existing-review-r1.json", { timeout: 60_000 }, async () => {
    const started = await stack.request("POST", `/api/projects/${projectId}/workflows`, {
      kind: "existing_paper_review",
    });
    expect(started.status).toBe(202);
    const runId = started.body["runId"] as string;

    let run: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 200; attempt += 1) {
      run = (await stack.request("GET", `/api/runs/${runId}`)).body["run"] as Record<string, unknown>;
      if (["completed", "failed", "cancelled"].includes(String(run["status"]))) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(run["status"]).toBe("completed");
    expect((run["completion"] as Record<string, unknown>)["label"]).toBe("review");
    const stages = run["completedStages"] as string[];
    expect(stages).toEqual([
      "paper.ensure",
      "citation.extract",
      "citation.metadata",
      "citation.claims",
      "review.sections",
      "review.aggregate",
    ]);

    // 聚合报告落盘且统计正确
    const reportPath = join(stack.root, projectId, "reviews", "existing-review-r1.json");
    const report = JSON.parse(await readFile(reportPath, "utf8")) as Record<string, unknown>;
    expect(report["kind"]).toBe("existing_paper_review");
    const review = report["review"] as Record<string, unknown>;
    expect(review["sectionsReviewed"]).toBe(3);
    expect(review["findingsTotal"]).toBe(3);
    const bySeverity = review["bySeverity"] as Record<string, number>;
    expect(bySeverity["critical"]).toBe(1);
    expect(bySeverity["major"]).toBe(1);
    expect(bySeverity["minor"]).toBe(1);
    const findings = report["findings"] as Array<Record<string, unknown>>;
    expect(findings.every((f) => typeof f["findingId"] === "string" && f["status"] === "open")).toBe(true);
    expect(findings.every((f) => f["source"] === "section-review")).toBe(true);
    expect((report["paper"] as Record<string, unknown>)["title"]).toBe("Attention Is All You Need");

    // HTTP：GET paper-review 返回最新报告
    const viaHttp = await stack.request("GET", `/api/projects/${projectId}/paper-review`);
    expect(viaHttp.status).toBe(200);
    expect((viaHttp.body["report"] as Record<string, unknown>)["round"]).toBe(1);
  });

  it("走 M4.3 链路而非旧 manuscript review：受控 section scope + summary scope，无 review/fact 等旧 scope", () => {
    const scopes = reviewRuntime.calls.map((call) => call.contextScope ?? "");
    expect(scopes.some((scope) => scope.startsWith("review/section/"))).toBe(true);
    expect(scopes.some((scope) => scope.startsWith("review/summary/"))).toBe(true);
    // 旧三路审稿 scope 不应出现
    expect(scopes).not.toContain("review/fact");
    expect(scopes).not.toContain("review/academic");
    expect(scopes).not.toContain("review/style");
    // section review 的 prompt 含受控指令（来自 ReviewContextBuilder）
    const sectionCall = reviewRuntime.calls.find((call) => call.contextScope === "review/section/sec01");
    expect(sectionCall).toBeDefined();
    expect(sectionCall!.task).toContain("【当前章节：");
  });

  it("未导入 PDF 的项目启动 review → run 失败（stage 契约违规），不产生报告", { timeout: 30_000 }, async () => {
    const empty = await stack.request("POST", "/api/projects", { title: "空论文项目" });
    const emptyId = (empty.body["project"] as Record<string, unknown>)["id"] as string;
    const started = await stack.request("POST", `/api/projects/${emptyId}/workflows`, {
      kind: "existing_paper_review",
    });
    expect(started.status).toBe(202);
    const runId = started.body["runId"] as string;
    let run: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 200; attempt += 1) {
      run = (await stack.request("GET", `/api/runs/${runId}`)).body["run"] as Record<string, unknown>;
      if (["completed", "failed", "cancelled"].includes(String(run["status"]))) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(run["status"]).toBe("failed");
    const error = run["error"] as Record<string, unknown>;
    expect(String(error["message"])).toContain("Final PDF");
  });
});

describe("review.sections 节内容错（Provider 抖动不重跑整个 stage）", () => {
  const failures = new Map<string, number>();
  const localCleanups: Array<() => Promise<void>> = [];

  /** sec02 首次调用抛 503；sec03 永远失败；其余正常 */
  function flakyRuntime(): AgentRuntime {
    const base = makeReviewRuntime().runtime;
    return {
      ...base,
      async runAgent(input: RunAgentInput): Promise<AgentTask> {
        const scope = input.contextScope ?? "";
        const count = (failures.get(scope) ?? 0) + 1;
        failures.set(scope, count);
        if (scope === "review/section/sec02" && count === 1) {
          throw new AgentRunFailedError("503 No available channel for model");
        }
        if (scope === "review/section/sec03") {
          throw new AgentRunFailedError("503 No available channel for model");
        }
        return base.runAgent(input);
      },
    };
  }

  afterAll(async () => {
    for (const cleanup of localCleanups) {
      await cleanup();
    }
  });

  it("单节瞬时失败 → 节内重试成功；持续失败的章节记为 failedSections，run 仍完成", { timeout: 60_000 }, async () => {
    const local = await startTestStack(flakyRuntime(), {
      paperParser: fakeParser,
      registerCleanup: (cleanup) => localCleanups.push(cleanup),
    });
    const created = await local.request("POST", "/api/projects/import-pdf", {
      fileName: "attention.pdf",
      contentBase64: Buffer.from("%PDF-1.5\nflaky-review").toString("base64"),
      goal: "review_only",
    });
    const id = (created.body["project"] as Record<string, unknown>)["id"] as string;
    const started = await local.request("POST", `/api/projects/${id}/workflows`, { kind: "existing_paper_review" });
    const runId = started.body["runId"] as string;

    let run: Record<string, unknown> = {};
    for (let attempt = 0; attempt < 400; attempt += 1) {
      run = (await local.request("GET", `/api/runs/${runId}`)).body["run"] as Record<string, unknown>;
      if (["completed", "failed", "cancelled"].includes(String(run["status"]))) {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    expect(run["status"]).toBe("completed");
    const history = run["stageHistory"] as Array<Record<string, unknown>>;
    // stage 级只跑了一次：失败在节内消化，没有从第 1 节重跑
    expect(history.filter((record) => record["stageId"] === "review.sections")).toHaveLength(1);
    expect(failures.get("review/section/sec02")).toBe(2);
    expect(failures.get("review/section/sec03")).toBe(3);

    const report = (await local.request("GET", `/api/projects/${id}/paper-review`)).body["report"] as Record<string, unknown>;
    const review = report["review"] as Record<string, unknown>;
    expect(review["sectionsReviewed"]).toBe(2);
    expect(review["failedSections"]).toBe(1);
  });
});
