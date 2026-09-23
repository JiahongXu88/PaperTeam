/**
 * M9.7.4 P0-2 Reviewer Structured Output Repair 测试。
 *
 * 覆盖（任务书 §8-4~9）：
 * 4. style reviewer 输出缺 riskScore → 触发 error-feedback repair
 * 5. repair 后成功（内容保留 + repair 诊断）
 * 6. academic reviewer 输出缺 scores → repair 后成功
 * 7. repair 连续失败 → 有界失败（original + 2 次修复，共 3 次调用）
 * 8. 失败时不伪造默认分数（riskScore / scores 无默认值，如实抛错）
 * 另：任务本身失败（status != completed）不进入 repair（Runtime transient 语义）
 */

import { describe, expect, it } from "vitest";

import { AgentRunFailedError } from "../../src/errors.js";
import type { AgentRuntime, AgentTask, RunAgentInput } from "../../src/runtime/types.js";
import { ReviewerService, REVIEW_REPAIR_MAX_ATTEMPTS } from "../../src/agents/ReviewerService.js";
import type { ProjectStore } from "../../src/project/ProjectStore.js";

/** 可脚本化输出序列的 fake Runtime（记录每次调用的 task prompt） */
class ScriptedRuntime implements AgentRuntime {
  readonly provider = "pi" as const;
  private calls = 0;
  readonly prompts: string[] = [];

  constructor(private readonly outputs: Array<{ status: AgentTask["status"]; output?: string; error?: string }>) {}

  async runAgent(input: RunAgentInput): Promise<AgentTask> {
    const script = this.outputs[Math.min(this.calls, this.outputs.length - 1)]!;
    this.calls += 1;
    this.prompts.push(input.task);
    return {
      taskId: `t${this.calls}`,
      agentId: input.agentId,
      status: script.status,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      ...(script.output !== undefined ? { output: script.output } : {}),
      ...(script.error !== undefined ? { error: script.error } : {}),
    };
  }

  get callCount(): number {
    return this.calls;
  }

  async startAgent(): Promise<never> {
    throw new Error("not used");
  }
  async getTask(): Promise<never> {
    throw new Error("not used");
  }
  async healthCheck(): Promise<never> {
    throw new Error("not used");
  }
  async close(): Promise<void> {}
}

function serviceOf(runtime: AgentRuntime): ReviewerService {
  return new ReviewerService({
    runtime,
    agentId: "reviewer",
    projects: {} as unknown as ProjectStore,
  });
}

const MANUSCRIPT = "===== 论文稿件 =====\n\\section{Introduction}\nsome content";

/** 合法 style 输出（M9.7.3 真实失败形态：issues 齐全但缺 riskScore） */
const STYLE_MISSING_RISK = JSON.stringify({
  summary: "整体表达模板化。",
  issues: [
    {
      category: "style",
      severity: "minor",
      section: "sections/intro.tex",
      description: "连续三句以「此外」开头",
      suggestedAction: "合并前两句",
      blocking: false,
    },
  ],
});

const STYLE_COMPLETE = JSON.stringify({
  summary: "整体表达模板化。",
  riskScore: 42,
  issues: [
    {
      category: "style",
      severity: "minor",
      section: "sections/intro.tex",
      description: "连续三句以「此外」开头",
      suggestedAction: "合并前两句",
      blocking: false,
    },
  ],
});

const ACADEMIC_MISSING_SCORES = JSON.stringify({
  summary: "论证结构完整。",
  issues: [],
});
const ACADEMIC_COMPLETE = JSON.stringify({
  summary: "论证结构完整。",
  scores: { 问题定义: 82, 方法合理性: 75, 实验充分性: 68, 论证逻辑: 80, 写作质量: 85 },
  overallScore: 78,
  issues: [],
});

describe("Reviewer structured output repair（M9.7.4）", () => {
  it("style 缺 riskScore → repair 携带具体校验错误与上一轮输出，成功后保留内容并记录诊断", async () => {
    const runtime = new ScriptedRuntime([
      { status: "completed", output: STYLE_MISSING_RISK },
      { status: "completed", output: STYLE_COMPLETE },
    ]);
    const result = await serviceOf(runtime).reviewMode({
      projectId: "p1",
      mode: "style",
      manuscriptDigest: MANUSCRIPT,
      evidence: [],
    });

    expect(result.riskScore).toBe(42);
    expect(result.issues).toHaveLength(1); // 原审稿内容保留，不重做
    expect(result.repair).toEqual({
      attempts: 1,
      errors: [expect.stringContaining("riskScore")],
    });
    // repair prompt 注入了上一轮输出 + 分类错误标记
    expect(runtime.callCount).toBe(2);
    const repairPrompt = runtime.prompts[1]!;
    expect(repairPrompt).toContain("未通过结构化校验");
    expect(repairPrompt).toContain("riskScore");
    expect(repairPrompt).toContain("missing_field");
    expect(repairPrompt).toContain("连续三句"); // 上一轮输出原样注入
    expect(repairPrompt).toContain("保留上一轮输出中已有的审稿内容");
  });

  it("academic 缺 scores → repair 后成功", async () => {
    const runtime = new ScriptedRuntime([
      { status: "completed", output: ACADEMIC_MISSING_SCORES },
      { status: "completed", output: ACADEMIC_COMPLETE },
    ]);
    const result = await serviceOf(runtime).reviewMode({
      projectId: "p1",
      mode: "academic",
      manuscriptDigest: MANUSCRIPT,
      evidence: [],
    });
    expect(result.overallScore).toBe(78);
    expect(Object.keys(result.scores!)).toHaveLength(5);
    expect(result.repair?.attempts).toBe(1);
    expect(result.repair?.errors[0]).toContain("scores");
  });

  it("repair 连续失败 → 有界失败（original + 2 次 = 3 次调用），且不伪造默认分数", async () => {
    const runtime = new ScriptedRuntime([
      { status: "completed", output: STYLE_MISSING_RISK },
      { status: "completed", output: STYLE_MISSING_RISK },
      { status: "completed", output: STYLE_MISSING_RISK },
    ]);
    const service = serviceOf(runtime);
    await expect(
      service.reviewMode({
        projectId: "p1",
        mode: "style",
        manuscriptDigest: MANUSCRIPT,
        evidence: [],
      }),
    ).rejects.toBeInstanceOf(AgentRunFailedError);

    // 有界：original + REVIEW_REPAIR_MAX_ATTEMPTS 次，绝不无限重试
    expect(REVIEW_REPAIR_MAX_ATTEMPTS).toBe(2);
    expect(runtime.callCount).toBe(3);
    // 拒绝伪造默认值：最后一次失败如实抛错（错误信息含修复历史），没有 0 值兜底路径
    const caught = await service
      .reviewMode({ projectId: "p1", mode: "style", manuscriptDigest: MANUSCRIPT, evidence: [] })
      .catch((e: unknown) => e);
    expect(caught).toBeInstanceOf(AgentRunFailedError);
    const error = caught as AgentRunFailedError;
    expect(error.message).toContain("3 次尝试");
    expect(error.message).toContain("riskScore");
  });

  it("任务失败（status=failed）不进入 repair——直接抛出（Runtime transient 语义）", async () => {
    const runtime = new ScriptedRuntime([
      { status: "failed", error: "model overloaded" },
    ]);
    await expect(
      serviceOf(runtime).reviewMode({
        projectId: "p1",
        mode: "style",
        manuscriptDigest: MANUSCRIPT,
        evidence: [],
      }),
    ).rejects.toMatchObject({ message: expect.stringContaining("model overloaded") });
    expect(runtime.callCount).toBe(1); // 无 repair 调用
  });

  it("JSON 解析失败（输出非 JSON）同样走 repair 通道（json_parse 分类）", async () => {
    const runtime = new ScriptedRuntime([
      { status: "completed", output: "抱歉，我认为这篇稿件整体不错，无需修改。" },
      { status: "completed", output: STYLE_COMPLETE },
    ]);
    const result = await serviceOf(runtime).reviewMode({
      projectId: "p1",
      mode: "style",
      manuscriptDigest: MANUSCRIPT,
      evidence: [],
    });
    expect(result.riskScore).toBe(42);
    expect(result.repair?.errors[0]).toContain("json_parse");
  });

  it("首次输出合法 → 零 repair 调用、无 repair 字段（回归保护）", async () => {
    const runtime = new ScriptedRuntime([{ status: "completed", output: STYLE_COMPLETE }]);
    const result = await serviceOf(runtime).reviewMode({
      projectId: "p1",
      mode: "style",
      manuscriptDigest: MANUSCRIPT,
      evidence: [],
    });
    expect(runtime.callCount).toBe(1);
    expect(result.repair).toBeUndefined();
  });
});
