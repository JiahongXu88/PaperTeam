import { describe, expect, it } from "vitest";

import { AgentRunFailedError, InvalidLatexOutputError } from "../src/errors.js";
import type { AgentRuntime, AgentTask } from "../src/runtime/types.js";
import { WriterService, buildWriterPrompt } from "../src/writer/WriterService.js";

/** 可编程的假 Runtime：记录调用并返回预设任务结果 */
class FakeRuntime implements AgentRuntime {
  readonly provider = "pi" as const;
  readonly calls: { agentId: string; task: string; projectId?: string }[] = [];
  private result: () => AgentTask;

  constructor(result: () => AgentTask) {
    this.result = result;
  }

  healthCheck(): Promise<import("../src/runtime/types.js").RuntimeHealth> {
    throw new Error("not needed in this test");
  }

  async startAgent(input: import("../src/runtime/types.js").RunAgentInput): Promise<import("../src/runtime/types.js").AgentRunHandle> {
    this.calls.push({ agentId: input.agentId, task: input.task, projectId: input.projectId });
    const task = this.result();
    return {
      taskId: task.taskId,
      sessionKey: `agent:${input.agentId}:paperteam-fake`,
      events: async function* () {},
      cancel: async () => {},
      result: async () => task,
    };
  }

  async runAgent(input: import("../src/runtime/types.js").RunAgentInput): Promise<AgentTask> {
    this.calls.push({ agentId: input.agentId, task: input.task, projectId: input.projectId });
    return this.result();
  }

  getTask(): Promise<AgentTask> {
    throw new Error("not implemented");
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function completedTask(output: string): AgentTask {
  const now = new Date().toISOString();
  return {
    taskId: "run-w1",
    agentId: "writer",
    status: "completed",
    createdAt: now,
    updatedAt: now,
    output,
  };
}

const VALID_LATEX = [
  "\\documentclass[UTF8]{ctexart}",
  "\\usepackage{amsmath}",
  "\\begin{document}",
  "\\section{引言}",
  "RAG 是检索增强生成。",
  "\\end{document}",
].join("\n");

describe("WriterService", () => {
  it("正确调用 AgentRuntime 并提取 LaTeX 输出", async () => {
    const runtime = new FakeRuntime(() => completedTask(VALID_LATEX));
    const writer = new WriterService({ runtime, agentId: "writer" });

    const result = await writer.write({ projectId: "p-abc", prompt: "写一篇关于 RAG 的短文" });

    // 调用参数
    expect(runtime.calls).toHaveLength(1);
    expect(runtime.calls[0]!.agentId).toBe("writer");
    expect(runtime.calls[0]!.projectId).toBe("p-abc");
    expect(runtime.calls[0]!.task).toContain("写一篇关于 RAG 的短文");
    expect(runtime.calls[0]!.task).toContain("\\documentclass");
    // 返回内容
    expect(result.latex).toBe(VALID_LATEX);
    expect(result.task.taskId).toBe("run-w1");
  });

  it("Prompt 包含关键约束（完整 LaTeX / 中文 / 无围栏 / 无虚构引用）", () => {
    const prompt = buildWriterPrompt("任务 X");
    expect(prompt).toContain("ctexart");
    expect(prompt).toContain("LaTeX");
    expect(prompt).toContain("```");
    expect(prompt).toContain("参考文献");
    expect(prompt).toContain("任务 X");
  });

  it("模型误加 Markdown 围栏时自动剥离", async () => {
    const wrapped = "```latex\n" + VALID_LATEX + "\n```";
    const runtime = new FakeRuntime(() => completedTask(wrapped));
    const writer = new WriterService({ runtime, agentId: "writer" });
    const result = await writer.write({ projectId: "p-abc", prompt: "写" });
    expect(result.latex).toBe(VALID_LATEX);
  });

  it("非 LaTeX 输出（缺少 documentclass）抛 InvalidLatexOutputError", async () => {
    const runtime = new FakeRuntime(() => completedTask("这只是一段普通文本，不是论文。"));
    const writer = new WriterService({ runtime, agentId: "writer" });
    await expect(writer.write({ projectId: "p-abc", prompt: "写" })).rejects.toBeInstanceOf(
      InvalidLatexOutputError,
    );
  });

  it("空输出抛 AgentRunFailedError，不允许空结果落盘", async () => {
    const runtime = new FakeRuntime(() => completedTask("   "));
    const writer = new WriterService({ runtime, agentId: "writer" });
    await expect(writer.write({ projectId: "p-abc", prompt: "写" })).rejects.toBeInstanceOf(
      AgentRunFailedError,
    );
  });

  it("任务失败（status=failed）抛 AgentRunFailedError", async () => {
    const runtime = new FakeRuntime(() => ({
      ...completedTask(""),
      status: "failed" as const,
      error: "模型服务不可用",
    }));
    const writer = new WriterService({ runtime, agentId: "writer" });
    await expect(writer.write({ projectId: "p-abc", prompt: "写" })).rejects.toMatchObject({
      code: "AGENT_RUN_FAILED",
      message: expect.stringContaining("模型服务不可用"),
    });
  });

  it("空 prompt 抛 AgentRunFailedError", async () => {
    const runtime = new FakeRuntime(() => completedTask(VALID_LATEX));
    const writer = new WriterService({ runtime, agentId: "writer" });
    await expect(writer.write({ projectId: "p-abc", prompt: "  " })).rejects.toBeInstanceOf(
      AgentRunFailedError,
    );
    expect(runtime.calls).toHaveLength(0);
  });
});
