/**
 * Writer Agent 最小实现（M2）。
 *
 * 职责：把用户的写作任务包装成 Writer Prompt，通过 AgentRuntime 执行，
 * 校验返回文本是可编译的 LaTeX，供上层落盘为 manuscript/main.tex。
 *
 * M2 不评估学术质量，只验证 Agent → 文件 → PDF 的真实链路。
 */

import { AgentRunFailedError, InvalidLatexOutputError } from "../errors.js";
import type { AgentRuntime, AgentTask } from "../runtime/types.js";

export interface WriterServiceOptions {
  runtime: AgentRuntime;
  /** Writer 对应的 OpenClaw agent id */
  agentId: string;
  /** 诊断日志 */
  log?: (message: string) => void;
}

export interface WriterResult {
  task: AgentTask;
  /** 校验后的 LaTeX 文档全文 */
  latex: string;
}

/** Markdown 代码围栏（模型偶尔会无视指令包裹输出，做防御性剥离） */
const FENCE_PATTERN = /^\s*```[a-zA-Z]*\s*\n([\s\S]*?)\n?```\s*$/;

export class WriterService {
  private readonly runtime: AgentRuntime;
  private readonly agentId: string;
  private readonly log: (message: string) => void;

  constructor(options: WriterServiceOptions) {
    this.runtime = options.runtime;
    this.agentId = options.agentId;
    this.log = options.log ?? (() => {});
  }

  /**
   * 执行一次写作任务。
   * 输入是用户的自然语言写作要求；输出是完整 LaTeX 文档。
   */
  async write(params: { projectId: string; prompt: string }): Promise<WriterResult> {
    const prompt = params.prompt.trim();
    if (prompt === "") {
      throw new AgentRunFailedError("写作任务（prompt）不能为空");
    }

    const task = await this.runtime.runAgent({
      agentId: this.agentId,
      task: buildWriterPrompt(prompt),
      projectId: params.projectId,
      metadata: { role: "writer", milestone: "M2" },
    });

    if (task.status !== "completed") {
      throw new AgentRunFailedError(task.error ?? `Writer 任务以 ${task.status} 状态结束`);
    }
    const output = task.output?.trim();
    if (!output) {
      throw new AgentRunFailedError("Writer 没有返回任何文本");
    }

    const latex = stripCodeFence(output);
    if (!latex.includes("\\documentclass")) {
      throw new InvalidLatexOutputError(
        "返回内容中没有 \\documentclass 命令（应为完整 LaTeX 文档）",
      );
    }
    if (!latex.includes("\\begin{document}")) {
      throw new InvalidLatexOutputError("返回内容中没有 \\begin{document}");
    }

    this.log(`[writer] projectId=${params.projectId} taskId=${task.taskId} 产出 LaTeX ${latex.length} 字符`);
    return { task, latex };
  }
}

/**
 * Writer Prompt（M2 有意保持简单）：
 * 要求完整 LaTeX、中文可用、无 Markdown 围栏、不虚构引用、优先保证可编译。
 */
export function buildWriterPrompt(userPrompt: string): string {
  return [
    "你是一名学术论文写手（Writer）。请根据下面的写作任务撰写一篇简短的学术论文，直接返回完整的 LaTeX 文档。",
    "",
    "要求：",
    "1. 只返回一个完整、可直接编译的 LaTeX 文档：从 \\documentclass 开始，到 \\end{document} 结束。",
    "2. 使用 \\documentclass[UTF8]{ctexart} 支持中文。",
    "3. 不要用 Markdown 代码块（```）包裹输出，不要输出任何解释、前言或结尾说明。",
    "4. 论文结构包含：标题、摘要、引言、结论。",
    "5. 不要虚构参考文献，不需要 \\cite 和参考文献列表。",
    "6. 优先保证能通过 XeLaTeX 编译：只使用基础宏包（amsmath、amssymb 等），不使用生僻宏包。",
    "",
    "写作任务：",
    userPrompt,
  ].join("\n");
}

/** 剥离模型可能误加的 Markdown 代码围栏 */
function stripCodeFence(text: string): string {
  const match = FENCE_PATTERN.exec(text);
  if (match?.[1]) {
    return match[1].trim();
  }
  return text.trim();
}
