/**
 * M10.4.0 Agent Runtime Trace 测试：
 * - 单元：RunTraceSession（stage span / 上限丢弃 / finish）、TaskTraceRecorder
 *   （model.turn / tool.call 配对 / retry / 终态收敛）、buildPerformanceReport
 * - 集成：PiRuntimeAdapter（fake session + trace scope → span 归属）、
 *   WorkflowOrchestrator（scripted runtime 全流程 → run-trace.json +
 *   performance-report.md 落盘）
 */

import { readFile } from "node:fs/promises";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { AgentSession, AgentSessionEvent, CreateAgentSessionOptions } from "@earendil-works/pi-coding-agent";

import type { WorkflowState } from "../../src/workflow/types.js";

import { PiRuntimeAdapter } from "../../src/runtime/PiRuntimeAdapter.js";
import type { PiRuntimeOptions } from "../../src/runtime/PiRuntimeAdapter.js";
import {
  getOrCreateRunTraceSession,
  resetTraceSessionsForTest,
  runInTraceScope,
  TaskTraceRecorder,
  type TraceScope,
} from "../../src/observability/trace.js";
import { buildPerformanceReport as buildReport } from "../../src/observability/traceReport.js";
import { scriptedIdeaRuntime, startTestStack, pollRunUntilAwaiting, type TestStack } from "../helpers/testStack.js";

vi.setConfig({ testTimeout: 30_000 });

const cleanups: (() => Promise<void>)[] = [];
const tempDirs: string[] = [];

beforeEach(() => {
  resetTraceSessionsForTest();
});

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  for (const cleanup of cleanups.splice(0).reverse()) {
    await cleanup();
  }
});

async function makeTempDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function scopeOf(projectId = "p-trace", runId = "w-trace", stageId = "review.run", attempt = 1): TraceScope {
  return { projectId, runId, stageId, attempt, stageSpanId: "span-stage" };
}

// ---------------------------------------------------------------------------
// 单元：RunTraceSession
// ---------------------------------------------------------------------------

describe("RunTraceSession", () => {
  it("startStageSpan 记录 ok span；snapshot 携带 workflow 归属与属性", () => {
    const session = getOrCreateRunTraceSession({
      projectId: "p1",
      runId: "w1",
      workflowKind: "existing_paper_improvement",
      nowMs: 1_000,
    });
    const span = session.startStageSpan({ stageId: "import.parse", attempt: 1, phase: "execute", startMs: 1_050 });
    span.end({ status: "ok", endMs: 2_050 });
    const doc = session.snapshot();
    expect(doc.traceId).toBe("w1");
    expect(doc.workflowKind).toBe("existing_paper_improvement");
    expect(doc.spans).toHaveLength(1);
    expect(doc.spans[0]?.name).toBe("stage:import.parse");
    expect(doc.spans[0]?.durationMs).toBe(1_000);
    expect(doc.spans[0]?.attributes["stage.id"]).toBe("import.parse");
    expect(doc.spans[0]?.parentSpanId).toBeNull();
  });

  it("hitl-payload phase 的 span 命名区分；重复 end 幂等", () => {
    const session = getOrCreateRunTraceSession({
      projectId: "p1",
      runId: "w2",
      workflowKind: "existing_paper_improvement",
      nowMs: 0,
    });
    const span = session.startStageSpan({ stageId: "hitl.plan_confirm", attempt: 1, phase: "hitl-payload", startMs: 10 });
    span.end({ status: "ok", endMs: 30 });
    span.end({ status: "error", endMs: 999 }); // 幂等：不覆盖
    const doc = session.snapshot();
    expect(doc.spans[0]?.name).toBe("hitl-payload:hitl.plan_confirm");
    expect(doc.spans[0]?.durationMs).toBe(20);
    expect(doc.spans[0]?.status).toBe("ok");
  });

  it("span 超上限丢弃并如实计数（droppedSpans）", () => {
    const session = getOrCreateRunTraceSession({
      projectId: "p1",
      runId: "w3",
      workflowKind: "idea_to_paper",
      nowMs: 0,
    });
    const limit = 50_000;
    for (let index = 0; index < limit + 25; index += 1) {
      const span = session.startStageSpan({ stageId: `s${index}`, attempt: 1, phase: "execute", startMs: 0 });
      span.end({ status: "ok", endMs: 1 });
    }
    const doc = session.snapshot();
    expect(doc.spans).toHaveLength(limit);
    expect(doc.droppedSpans).toBe(25);
  });

  it("finish 标记 runStatus / finishedAtMs", () => {
    const session = getOrCreateRunTraceSession({
      projectId: "p1",
      runId: "w4",
      workflowKind: "idea_to_paper",
      nowMs: 100,
    });
    session.finish("completed", 90_000);
    const doc = session.snapshot();
    expect(doc.runStatus).toBe("completed");
    expect(doc.finishedAtMs).toBe(90_000);
  });
});

// ---------------------------------------------------------------------------
// 单元：TaskTraceRecorder
// ---------------------------------------------------------------------------

function makeRecorder(base?: Partial<{ modelLabel: string; role: string }>) {
  const session = getOrCreateRunTraceSession({
    projectId: "p-task",
    runId: "w-task",
    workflowKind: "existing_paper_improvement",
    nowMs: 0,
  });
  let clock = 1_000;
  const now = () => clock;
  const advance = (ms: number) => {
    clock += ms;
  };
  const recorder = new TaskTraceRecorder(
    scopeOf("p-task", "w-task", "revision.revise"),
    session,
    { taskId: "pi-t1", agentId: "writer", modelLabel: base?.modelLabel ?? "zai-coding-cn/glm-5.3", role: base?.role ?? "writer" },
    now,
  );
  return { session, recorder, advance, now };
}

describe("TaskTraceRecorder", () => {
  it("message_start/end → model.turn span（provider/model/stage/usage）", () => {
    const { session, recorder, advance } = makeRecorder();
    recorder.executionStarted();
    recorder.observeEvent({ type: "message_start", message: { role: "assistant" } });
    advance(1_500);
    recorder.observeEvent({
      type: "message_end",
      message: {
        role: "assistant",
        stopReason: "stop",
        usage: { input: 100, output: 200, cacheRead: 50, cacheWrite: 10, totalTokens: 360, cost: { total: 0.01 } },
      },
    });
    recorder.taskSettled({ status: "completed" });
    const doc = session.snapshot();
    const model = doc.spans.find((span) => span.name === "model.turn");
    expect(model).toBeDefined();
    expect(model?.kind).toBe("client");
    expect(model?.durationMs).toBe(1_500);
    expect(model?.attributes["model.provider"]).toBe("zai-coding-cn");
    expect(model?.attributes["model.id"]).toBe("glm-5.3");
    expect(model?.attributes["model.inputTokens"]).toBe(100);
    expect(model?.attributes["model.outputTokens"]).toBe(200);
    expect(model?.attributes["model.estimatedCost"]).toBeCloseTo(0.01);
    expect(model?.attributes["stage.id"]).toBe("revision.revise");
    expect(model?.parentSpanId).toBe(doc.spans.find((span) => span.name === "agent.task")?.spanId);
    const task = doc.spans.find((span) => span.name === "agent.task");
    expect(task?.status).toBe("ok");
  });

  it("message_end 无 message_start（脚本化会话）→ 零时长 fallback span，如实标注", () => {
    const { session, recorder } = makeRecorder();
    recorder.executionStarted();
    recorder.observeEvent({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
    recorder.taskSettled({ status: "completed" });
    const model = session.snapshot().spans.find((span) => span.name === "model.turn");
    expect(model).toBeDefined();
    expect(model?.durationMs).toBe(0);
    expect(model?.attributes["model.startObserved"]).toBe(false);
  });

  it("tool_execution_start/end 按 toolCallId 配对；isError → status error", () => {
    const { session, recorder, advance } = makeRecorder();
    recorder.executionStarted();
    recorder.observeEvent({ type: "tool_execution_start", toolCallId: "tc-1", toolName: "retrieve_library" });
    recorder.observeEvent({ type: "tool_execution_start", toolCallId: "tc-2", toolName: "get_chunk" });
    advance(120);
    recorder.observeEvent({ type: "tool_execution_end", toolCallId: "tc-1", toolName: "retrieve_library", isError: false });
    recorder.observeEvent({ type: "tool_execution_end", toolCallId: "tc-2", toolName: "get_chunk", isError: true });
    recorder.taskSettled({ status: "completed" });
    const tools = session.snapshot().spans.filter((span) => span.name === "tool.call");
    expect(tools).toHaveLength(2);
    expect(tools.find((span) => span.attributes["tool.callId"] === "tc-1")?.status).toBe("ok");
    expect(tools.find((span) => span.attributes["tool.callId"] === "tc-1")?.durationMs).toBe(120);
    expect(tools.find((span) => span.attributes["tool.callId"] === "tc-2")?.status).toBe("error");
  });

  it("auto_retry_start 关闭在途 model span（error）并计数；taskSettled 写入 retry 属性", () => {
    const { session, recorder, advance } = makeRecorder();
    recorder.executionStarted();
    recorder.observeEvent({ type: "message_start", message: { role: "assistant" } });
    advance(300);
    recorder.observeEvent({ type: "auto_retry_start", attempt: 1, errorMessage: "provider 529" });
    advance(50);
    recorder.observeEvent({ type: "message_start", message: { role: "assistant" } });
    advance(400);
    recorder.observeEvent({ type: "message_end", message: { role: "assistant", stopReason: "stop" } });
    recorder.observeEvent({ type: "agent_end", willRetry: false });
    recorder.taskSettled({ status: "completed" });
    const doc = session.snapshot();
    const modelSpans = doc.spans.filter((span) => span.name === "model.turn");
    expect(modelSpans).toHaveLength(2);
    expect(modelSpans[0]?.status).toBe("error");
    expect(modelSpans[1]?.status).toBe("ok");
    const task = doc.spans.find((span) => span.name === "agent.task");
    expect(task?.attributes["task.retriesAuto"]).toBe(1);
    expect(task?.events?.some((event) => event.name === "auto_retry")).toBe(true);
  });

  it("agent_end willRetry 计数；未闭合 tool span 在 settle 时收敛为 unset", () => {
    const { session, recorder } = makeRecorder();
    recorder.executionStarted();
    recorder.observeEvent({ type: "agent_end", willRetry: true });
    recorder.observeEvent({ type: "tool_execution_start", toolCallId: "tc-x", toolName: "bash" });
    recorder.taskSettled({ status: "cancelled" });
    const doc = session.snapshot();
    const task = doc.spans.find((span) => span.name === "agent.task");
    expect(task?.attributes["task.retriesAgent"]).toBe(1);
    expect(task?.status).toBe("unset"); // cancelled → unset（非错误）
    const dangling = doc.spans.find((span) => span.attributes["tool.callId"] === "tc-x");
    expect(dangling?.status).toBe("unset");
  });
});

// ---------------------------------------------------------------------------
// 单元：buildPerformanceReport
// ---------------------------------------------------------------------------

describe("buildPerformanceReport", () => {
  it("汇总 total duration / stage 表 / 模型调用 / token / retry（关键行存在）", () => {
    const session = getOrCreateRunTraceSession({
      projectId: "p-report",
      runId: "w-report",
      workflowKind: "existing_paper_improvement",
      nowMs: 0,
    });
    // stage：research.plan 10s → review.run 20s（并行重叠 5s）
    const s1 = session.startStageSpan({ stageId: "research.plan", attempt: 1, phase: "execute", startMs: 1_000 });
    s1.end({ status: "ok", endMs: 11_000 });
    const s2 = session.startStageSpan({ stageId: "review.run", attempt: 1, phase: "execute", startMs: 6_000 });
    s2.end({ status: "ok", endMs: 26_000 });
    // model：两次调用（各 5s / 8s，一次带 usage 一次不带）
    const recorder = new TaskTraceRecorder(
      scopeOf("p-report", "w-report", "review.run"),
      session,
      { taskId: "pi-m1", agentId: "reviewer", modelLabel: "zai-coding-cn/glm-5.3", role: "reviewer" },
      () => 0,
    );
    recorder.executionStarted();
    recorder.observeEvent({ type: "message_start", message: { role: "assistant" } });
    recorder.observeEvent({ type: "message_end", message: { role: "assistant", stopReason: "stop", usage: { input: 1_000, output: 500 } } });
    recorder.observeEvent({ type: "auto_retry_start", attempt: 1, errorMessage: "529" });
    recorder.taskSettled({ status: "completed", usage: { inputTokens: 1_000, outputTokens: 500, cacheReadTokens: 0, cacheWriteTokens: 0, assistantTurns: 1 } });
    session.finish("completed", 40_000);

    const report = buildReport(session.snapshot());
    expect(report).toContain("# Performance Report — w-report");
    expect(report).toContain("existing_paper_improvement");
    expect(report).toContain("`research.plan`");
    expect(report).toContain("`review.run`");
    expect(report).toContain("| 调用次数（assistant turn） | 1 |");
    expect(report).toContain("auto-retry 1 次");
    expect(report).toContain("1,000"); // input tokens
    expect(report).toContain("## 2. Stage 时间线");
    expect(report).toContain("## 4. 模型调用");
    expect(report).toContain("## 5. 工具调用");
    expect(report).toContain("## 6. Agent 任务");
  });

  it("空 trace 也能生成报告（不抛错、占位行）", () => {
    const session = getOrCreateRunTraceSession({
      projectId: "p-empty",
      runId: "w-empty",
      workflowKind: "idea_to_paper",
      nowMs: 0,
    });
    const report = buildReport(session.snapshot());
    expect(report).toContain("（无 stage span）");
  });
});

// ---------------------------------------------------------------------------
// 集成：PiRuntimeAdapter（Level 1 fake session + trace scope）
// ---------------------------------------------------------------------------

type PiModel = NonNullable<CreateAgentSessionOptions["model"]>;

/** 最小 fake AgentSession：message_start → tool 对 → message_end(usage) → agent_end */
class TracedFakeSession {
  private readonly listeners = new Set<(event: AgentSessionEvent) => void>();
  private readonly messages: { role: string; content: { type: string; text?: string }[]; stopReason?: string }[] = [];

  get agent(): { state: { messages: unknown[] } } {
    return { state: { messages: this.messages } };
  }

  subscribe(listener: (event: AgentSessionEvent) => void): () => void {
    this.listeners.add(listener);
    return () => {
      this.listeners.delete(listener);
    };
  }

  private emit(event: AgentSessionEvent): void {
    for (const listener of this.listeners) {
      listener(event);
    }
  }

  async prompt(text: string): Promise<void> {
    this.messages.push({ role: "user", content: [{ type: "text", text }] });
    this.emit({ type: "agent_start" } as AgentSessionEvent);
    this.emit({ type: "message_start", message: { role: "assistant" } } as unknown as AgentSessionEvent);
    this.emit({
      type: "tool_execution_start",
      toolCallId: "tc-1",
      toolName: "retrieve_library",
    } as unknown as AgentSessionEvent);
    await new Promise((resolve) => setImmediate(resolve));
    this.emit({
      type: "tool_execution_end",
      toolCallId: "tc-1",
      toolName: "retrieve_library",
      isError: false,
    } as unknown as AgentSessionEvent);
    const message = {
      role: "assistant",
      content: [{ type: "text", text: "ok traced" }],
      stopReason: "stop",
      usage: { input: 11, output: 7, cacheRead: 0, cacheWrite: 0, totalTokens: 18, cost: { total: 0.002 } },
    };
    this.emit({ type: "message_end", message } as unknown as AgentSessionEvent);
    this.messages.push(message);
    this.emit({ type: "agent_end", messages: [...this.messages], willRetry: false } as AgentSessionEvent);
    this.emit({ type: "agent_settled" } as AgentSessionEvent);
  }

  async abort(): Promise<void> {}
  async waitForIdle(): Promise<void> {}
  dispose(): void {}
  getLastAssistantText(): string | undefined {
    for (let index = this.messages.length - 1; index >= 0; index -= 1) {
      const message = this.messages[index];
      if (message?.role === "assistant") {
        return message.content.find((block) => block.type === "text")?.text;
      }
    }
    return undefined;
  }
}

describe("PiRuntimeAdapter trace 集成", () => {
  it("trace scope 内 runAgent → model/tool/task span 归属到 run trace 会话", async () => {
    const agentDir = await makeTempDir("pi-trace-agent-");
    const workspaceRoot = await makeTempDir("pi-trace-ws-");
    const adapter = new PiRuntimeAdapter({
      agentDir,
      workspaceRoot,
      modelRuntime: {
        getModel: () => ({ provider: "fake", id: "fake-1" }) as PiModel,
        hasConfiguredAuth: () => true,
        getError: () => undefined,
      } as unknown as PiRuntimeOptions["modelRuntime"],
      model: { provider: "fake", id: "fake-1" } as PiModel,
      createSession: async () => new TracedFakeSession() as unknown as AgentSession,
      log: () => {},
    });
    const session = getOrCreateRunTraceSession({
      projectId: "p-adapter",
      runId: "w-adapter",
      workflowKind: "existing_paper_improvement",
      nowMs: Date.now(),
    });
    const task = await runInTraceScope(scopeOf("p-adapter", "w-adapter", "revision.revise"), () =>
      adapter.runAgent({ agentId: "writer", task: "修订第 3 节", projectId: "p-adapter" }),
    );
    expect(task.status).toBe("completed");
    const doc = session.snapshot();
    const model = doc.spans.find((span) => span.name === "model.turn");
    const tool = doc.spans.find((span) => span.name === "tool.call");
    const agentTask = doc.spans.find((span) => span.name === "agent.task");
    expect(model).toBeDefined();
    expect(model?.attributes["model.label"]).toBe("fake/fake-1");
    expect(model?.attributes["stage.id"]).toBe("revision.revise");
    expect(model?.attributes["model.inputTokens"]).toBe(11);
    expect(tool?.attributes["tool.name"]).toBe("retrieve_library");
    expect(tool?.status).toBe("ok");
    expect(agentTask?.attributes["task.id"]).toBe(task.taskId);
    expect(agentTask?.attributes["task.inputTokens"]).toBe(11);
    const requestLifecycle = JSON.parse(String(agentTask?.attributes["request.lifecycle"])) as Record<string, unknown>;
    expect(requestLifecycle).toMatchObject({ agentRunId: task.taskId, stage: "revision.revise", stageAttempt: 1 });
    expect(requestLifecycle.requestId).toEqual(expect.any(String));
    expect(requestLifecycle.firstActivityAt).toEqual(expect.any(String));
    expect(requestLifecycle.firstTextTokenAt).toBeUndefined(); // fake stream emits message_end but no visible text_delta
    expect(JSON.stringify(requestLifecycle)).not.toContain("修订第 3 节");
    const retryTask = await runInTraceScope(scopeOf("p-adapter", "w-adapter", "revision.revise", 2), () =>
      adapter.runAgent({ agentId: "writer", task: "synthetic retry", projectId: "p-adapter" }),
    );
    const firstLifecycle = task.metadata?.["requestLifecycle"] as Record<string, unknown>;
    const retryLifecycle = retryTask.metadata?.["requestLifecycle"] as Record<string, unknown>;
    expect(retryLifecycle.stageAttempt).toBe(2);
    expect(retryLifecycle.requestId).not.toBe(firstLifecycle.requestId);
    expect(Date.parse(String(firstLifecycle.sessionSettledAt))).toBeLessThanOrEqual(
      Date.parse(String(retryLifecycle.requestStartedAt)),
    );
    await adapter.close();
  });

  it("无 trace scope（独立 API 调用）→ 不产生任何 span", async () => {
    const agentDir = await makeTempDir("pi-trace-agent2-");
    const workspaceRoot = await makeTempDir("pi-trace-ws2-");
    const adapter = new PiRuntimeAdapter({
      agentDir,
      workspaceRoot,
      modelRuntime: {
        getModel: () => ({ provider: "fake", id: "fake-1" }) as PiModel,
        hasConfiguredAuth: () => true,
        getError: () => undefined,
      } as unknown as PiRuntimeOptions["modelRuntime"],
      model: { provider: "fake", id: "fake-1" } as PiModel,
      createSession: async () => new TracedFakeSession() as unknown as AgentSession,
      log: () => {},
    });
    const session = getOrCreateRunTraceSession({
      projectId: "p-adapter",
      runId: "w-noscope",
      workflowKind: "existing_paper_improvement",
      nowMs: Date.now(),
    });
    const task = await adapter.runAgent({ agentId: "writer", task: "独立调用" });
    expect(task.status).toBe("completed");
    expect(session.snapshot().spans).toHaveLength(0);
    await adapter.close();
  });
});

// ---------------------------------------------------------------------------
// 集成：Workflow 全流程（scripted runtime，HTTP e2e）→ trace 文件落盘
// ---------------------------------------------------------------------------

const IMPORTED_MAIN = [
  "\\documentclass[UTF8]{ctexart}",
  "\\begin{document}",
  "\\input{sections/introduction}",
  "\\input{sections/experiments}",
  "\\bibliographystyle{unsrt}",
  "\\bibliography{references}",
  "\\end{document}",
].join("\n");

function buildZip(entries: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBytes, compressed);
    const centralEntry = Buffer.alloc(46);
    centralEntry.writeUInt32LE(0x02014b50, 0);
    centralEntry.writeUInt16LE(20, 4);
    centralEntry.writeUInt16LE(20, 6);
    centralEntry.writeUInt16LE(8, 10);
    centralEntry.writeUInt32LE(compressed.length, 20);
    centralEntry.writeUInt32LE(entry.data.length, 24);
    centralEntry.writeUInt16LE(nameBytes.length, 28);
    centralEntry.writeUInt32LE(offset, 42);
    central.push(centralEntry, nameBytes);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, centralBuf, end]);
}

describe("Workflow trace 集成（scripted runtime）", () => {
  it(
    "existing_paper_improvement 全流程 → run-trace.json + performance-report.md 落盘",
    { timeout: 90_000 },
    async () => {
    const scripted = scriptedIdeaRuntime({ reviewSequence: ["pass"] });
    const stack: TestStack = await startTestStack(scripted.runtime, {
      registerCleanup: (cleanup) => cleanups.push(cleanup),
    });
    const project = await stack.store.create("trace 集成项目", { targetProfile: "core_journal" });
    const archive = buildZip([
      { name: "main.tex", data: Buffer.from(IMPORTED_MAIN, "utf8") },
      { name: "sections/introduction.tex", data: Buffer.from("\\section{引言}\n准确率提升 12.4% \\cite{a}。", "utf8") },
      { name: "sections/experiments.tex", data: Buffer.from("\\section{实验}\n在两个数据集上验证。", "utf8") },
      { name: "references.bib", data: Buffer.from("@article{a, title={A Good Paper}, year={2020}}", "utf8") },
    ]);
    const imported = await stack.request("POST", `/api/projects/${project.id}/import`, {
      archiveBase64: archive.toString("base64"),
    });
    expect(imported.status).toBe(200);
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {
      kind: "existing_paper_improvement",
    });
    expect(created.status).toBe(202);
    const runId = created.body["runId"] as string;

    await pollRunUntilAwaiting(stack, runId, "hitl.plan_confirm");
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
    const deadline = Date.now() + 25_000;
    let finished = false;
    while (Date.now() < deadline) {
      const { body } = await stack.request("GET", `/api/runs/${runId}`);
      const run = body["run"] as WorkflowState | undefined;
      if (run?.status === "completed") {
        finished = true;
        break;
      }
      if (run?.status === "failed") {
        throw new Error(`run 失败：${JSON.stringify(run.error)}`);
      }
      await new Promise((resolve) => setTimeout(resolve, 30));
    }
    expect(finished).toBe(true);

    const runDir = join(stack.root, project.id, "workflow", "runs", runId);
    const tracePath = join(runDir, "run-trace.json");
    let traceDoc: {
      traceId: string;
      workflowKind: string;
      runStatus?: string;
      finishedAtMs?: number;
      spans: { name: string; status: string; attributes: Record<string, unknown> }[];
    } | undefined;
    const traceFlushDeadline = Date.now() + 5_000;
    while (Date.now() < traceFlushDeadline) {
      traceDoc = JSON.parse(await readFile(tracePath, "utf8")) as typeof traceDoc;
      if (traceDoc?.runStatus === "completed") {
        break;
      }
      await new Promise((resolve) => setTimeout(resolve, 20));
    }
    if (traceDoc?.runStatus !== "completed") {
      throw new Error("workflow 已 completed，但 run-trace.json 未在 5 秒内刷新为 completed");
    }
    expect(traceDoc.traceId).toBe(runId);
    expect(traceDoc.workflowKind).toBe("existing_paper_improvement");
    expect(traceDoc.runStatus).toBe("completed");
    expect(traceDoc.finishedAtMs).toBeGreaterThan(0);
    const stageNames = traceDoc.spans.filter((span) => span.name.startsWith("stage:")).map((span) => span.name);
    expect(stageNames).toEqual(expect.arrayContaining(["stage:import.parse", "stage:review.run", "stage:quality.gate", "stage:build.draft"]));
    expect(traceDoc.spans.filter((span) => span.name.startsWith("stage:")).every((span) => span.status === "ok")).toBe(true);

    const report = await readFile(join(runDir, "performance-report.md"), "utf8");
    expect(report).toContain(`# Performance Report — ${runId}`);
    expect(report).toContain("## 1. 总览");
    expect(report).toContain("## 3. 最慢 Stage");
    expect(report).toContain("## 4. 模型调用");
  });
});
