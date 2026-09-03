/**
 * 测试辅助：完整服务栈 + 按 contextScope 脚本化的 Agent Runtime（M3.1）。
 *
 * scriptedIdeaRuntime 让 idea_to_paper 全流程在无 Gateway 的测试里真实跑通：
 * 按 AgentRuntime 的 contextScope 返回对应的结构化输出。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Server } from "node:http";

import { createBackendHttpServer } from "../../src/httpServer.js";
import { LatexCompiler, type CommandRunner } from "../../src/latex/LatexCompiler.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";
import type { AgentRuntime, AgentTask, RuntimeHealth } from "../../src/runtime/types.js";
import { buildServiceStack, type ServiceStack } from "../../src/serviceStack.js";
import { WorkflowOrchestrator } from "../../src/workflow/WorkflowOrchestrator.js";
import { WorkflowRunStore } from "../../src/workflow/runStore.js";
import { createIdeaToPaperDefinition } from "../../src/workflow/definitions.js";

export const AGENT_IDS = {
  writer: "writer",
  researcher: "researcher",
  reviewer: "reviewer",
  citation: "citation",
} as const;

/** legacy generate 路径的完整 LaTeX 文档（M2 行为） */
export const LATEX_DOC = [
  "\\documentclass[UTF8]{ctexart}",
  "\\begin{document}",
  "RAG 简介正文。",
  "\\end{document}",
].join("\n");

/** Researcher 调研输出（合法结构化 JSON） */
export const RESEARCH_JSON = JSON.stringify({
  domainOverview:
    "检索增强生成（RAG）通过在推理时检索外部知识缓解大模型幻觉。近年研究集中在检索质量、重排与生成端融合，但在小规模领域语料下的鲁棒性仍缺乏系统评估。",
  relatedWorkDirections: ["RAG 检索器优化", "重排与融合策略", "领域适配评估"],
  researchGaps: ["缺少小语料场景的系统性对比", "缺少可复现的评估协议"],
  potentialContributions: ["提出小语料 RAG 评估协议", "给出检索质量与幻觉率的量化关系"],
  researchQuestions: ["小语料下检索质量如何影响幻觉率？", "何种重排策略最稳健？"],
  literaturePlan: ["检索 RAG 综述", "检索器对比实验论文", "幻觉评估基准论文"],
  evidence: [
    {
      claim: "RAG 能显著降低开放域问答的幻觉率",
      summary: "综述汇总了多项实验：引入检索后事实错误率平均下降。",
      source: { title: "A Survey of Retrieval-Augmented Generation", authors: ["Gao, Y."], year: 2023 },
      location: { section: "5" },
    },
  ],
  bibliography: [
    {
      key: "gao2023survey",
      title: "Retrieval-Augmented Generation for Large Language Models: A Survey",
      authors: ["Gao, Yunfan", "Xiong, Yun"],
      year: 2023,
    },
  ],
});

export const FEASIBILITY_HIGH_JSON = JSON.stringify({
  level: "HIGH",
  reasons: ["研究空白明确", "评估协议贡献清晰", "已有可复用公开数据集"],
  missingRequirements: [],
  researchGaps: [],
  requiredExperiments: ["补充两组对比实验"],
  evidenceGaps: ["需要至少 3 篇基线论文的精确数字"],
  recommendations: ["先固定评估协议，再做消融"],
});

export const FEASIBILITY_INSUFFICIENT_JSON = JSON.stringify({
  level: "INSUFFICIENT",
  reasons: ["目标为顶会水平，但缺少 Novelty 与 Benchmark 实验", "当前只有综述级证据"],
  missingRequirements: ["缺少 Baseline 对比实验", "缺少公开 Benchmark 上的结果"],
  researchGaps: ["与已有 RAG 评估工作的差异未量化"],
  requiredExperiments: ["在公开 QA 基准上与 3 个基线对比", "消融实验"],
  evidenceGaps: ["缺少实验数据支撑核心主张"],
  recommendations: ["下调目标至核心期刊，或先补齐实验"],
  suggestedTargetAdjustment: ["下调为核心期刊"],
});

export const OUTLINE_JSON = JSON.stringify({
  title: "小语料场景下检索增强生成的系统评估",
  abstract: "本文提出一套小语料 RAG 评估协议并量化检索质量与幻觉率的关系。",
  sections: [
    { id: "introduction", file: "introduction.tex", title: "引言", targetLengthWords: 300, keyPoints: ["动机", "贡献"] },
    { id: "related-work", file: "related-work.tex", title: "相关工作", targetLengthWords: 300, keyPoints: ["RAG 检索器", "评估协议"] },
    { id: "method", file: "method.tex", title: "评估方法", targetLengthWords: 400, keyPoints: ["协议设计", "指标"] },
    { id: "experiments", file: "experiments.tex", title: "实验", targetLengthWords: 400, keyPoints: ["数据集", "对比设置"] },
    { id: "conclusion", file: "conclusion.tex", title: "结论", targetLengthWords: 200, keyPoints: ["总结"] },
  ],
});

/** 章节正文片段（合法：无文档骨架、花括号配对） */
export const SECTION_TEX = [
  "\\section{章节标题}",
  "",
  "本章节论述基于证据的核心观点 \\cite{gao2023survey}。",
  "检索质量与幻觉率的关系如式 \\eqref{eq:1} 所示。",
  "",
  "\\begin{equation}",
  "  q = \\alpha r + (1-\\alpha) g",
  "\\end{equation}",
].join("\n");

export interface ScriptedRuntimeOptions {
  /** feasibility 输出序列（依次消费；耗尽后用最后一个） */
  feasibilitySequence?: string[];
  /** 是否挂起第一次 runAgent（cancel / 并发测试） */
  hangFirstCall?: boolean;
}

export interface ScriptedRuntime {
  runtime: AgentRuntime;
  calls: { agentId: string; contextScope?: string }[];
  release: () => void;
  /** 第一次调用已解除挂起 */
  released: () => boolean;
}

/** 按 contextScope 脚本化的 fake Runtime */
export function scriptedIdeaRuntime(options: ScriptedRuntimeOptions = {}): ScriptedRuntime {
  const calls: { agentId: string; contextScope?: string }[] = [];
  const feasibilitySequence = options.feasibilitySequence ?? [FEASIBILITY_HIGH_JSON];
  let feasibilityIndex = 0;
  let hangResolve: (() => void) | undefined;
  let hangConsumed = options.hangFirstCall !== true;

  const runtime: AgentRuntime = {
    provider: "openclaw",
    healthCheck: async () => makeHealth(true),
    runAgent: async (input) => {
      calls.push({ agentId: input.agentId, contextScope: input.contextScope });
      if (!hangConsumed) {
        await new Promise<void>((resolve) => {
          hangResolve = resolve;
        });
        hangConsumed = true;
      }
      const scope = input.contextScope ?? "";
      let output = LATEX_DOC;
      if (scope === "research") {
        output = RESEARCH_JSON;
      } else if (scope === "research/feasibility") {
        output =
          feasibilitySequence[Math.min(feasibilityIndex, feasibilitySequence.length - 1)] ??
          FEASIBILITY_HIGH_JSON;
        feasibilityIndex += 1;
      } else if (scope === "writing/outline") {
        output = OUTLINE_JSON;
      } else if (scope === "writing/sections") {
        output = SECTION_TEX;
      }
      const now = new Date().toISOString();
      const task: AgentTask = {
        taskId: `run-scripted-${calls.length}`,
        agentId: input.agentId,
        status: "completed",
        createdAt: now,
        updatedAt: now,
        output,
      };
      return task;
    },
    getTask: () => {
      throw new Error("not implemented");
    },
    cancelTask: () => {
      throw new Error("not implemented");
    },
    sendMessage: () => {
      throw new Error("not implemented");
    },
    streamEvents: () => {
      throw new Error("not implemented");
    },
  };
  return {
    runtime,
    calls,
    release: () => {
      hangResolve?.();
    },
    released: () => hangConsumed,
  };
}

function makeHealth(ok: boolean): RuntimeHealth {
  return {
    ok,
    provider: "openclaw",
    status: ok ? "healthy" : "unreachable",
    detail: ok ? "ok" : "down",
    latencyMs: ok ? 5 : null,
    checkedAt: new Date().toISOString(),
  };
}

/** 编译成功且生成 main.pdf 的假 runner */
export const fakeSuccessfulRunner: CommandRunner = async (command, args) => {
  if (args.includes("--version")) {
    return { code: 0, stdout: `${command} 1.0`, stderr: "" };
  }
  const outputDir = args.find((arg) => arg.startsWith("-output-directory="));
  if (outputDir) {
    const { writeFile } = await import("node:fs/promises");
    await writeFile(join(outputDir.slice("-output-directory=".length), "main.pdf"), "%PDF-1.5");
  }
  return { code: 0, stdout: "compiled", stderr: "" };
};

/** 编译失败的假 runner */
export const fakeFailingRunner: CommandRunner = async (command, args) => {
  if (args.includes("--version")) {
    return { code: 0, stdout: `${command} 1.0`, stderr: "" };
  }
  return { code: 1, stdout: "! Undefined control sequence.", stderr: "" };
};

export type ServiceStackOptionsCitation = Parameters<typeof buildServiceStack>[0]["citation"];

export interface TestStack {
  stack: ServiceStack;
  store: ProjectStore;
  root: string;
  orchestrator: WorkflowOrchestrator;
  server: Server;
  cleanup: () => Promise<void>;
  /** HTTP 请求辅助 */
  request: (
    method: string,
    path: string,
    body?: unknown,
  ) => Promise<{ status: number; body: Record<string, unknown> }>;
  port: () => number;
}

export async function startTestStack(
  runtime: AgentRuntime,
  options: {
    latexRunner?: CommandRunner;
    citation?: ServiceStackOptionsCitation;
    registerCleanup?: (cleanup: () => Promise<void>) => void;
  } = {},
): Promise<TestStack> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-stack-"));
  const store = new ProjectStore({ root });
  const latex = new LatexCompiler({ timeoutMs: 10_000, runner: options.latexRunner ?? fakeSuccessfulRunner });
  const stack = buildServiceStack({
    runtime,
    projects: store,
    latex,
    agentIds: { ...AGENT_IDS },
    stageTimeoutMs: 10_000,
    stageMaxAttempts: 2,
    ...(options.citation ? { citation: options.citation } : {}),
    log: () => {},
  });
  const orchestrator = new WorkflowOrchestrator({
    projects: store,
    runStore: new WorkflowRunStore(store),
    definitionFactory: (kind) => {
      if (kind !== "idea_to_paper") {
        throw new Error(`unexpected kind: ${kind}`);
      }
      return createIdeaToPaperDefinition(stack.workflowServices);
    },
    retryDelayMs: 0,
    log: () => {},
  });
  const server = createBackendHttpServer({
    runtime,
    projects: store,
    generation: stack.generation,
    orchestrator,
    stack,
  });
  await new Promise<void>((resolve) => {
    server.listen(0, "127.0.0.1", resolve);
  });
  const port = (server.address() as { port: number }).port;
  const cleanup = async () => {
    await orchestrator.close();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await rm(root, { recursive: true, force: true });
  };
  options.registerCleanup?.(cleanup);
  return {
    stack,
    store,
    root,
    orchestrator,
    server,
    cleanup,
    port: () => port,
    request: async (method, path, body) => {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        ...(body !== undefined
          ? { body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }
          : {}),
      });
      return { status: response.status, body: (await response.json()) as Record<string, unknown> };
    },
  };
}
