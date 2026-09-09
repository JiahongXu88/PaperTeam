/**
 * 脚本化 AgentRuntime（测试专用 seam；src 侧唯一事实源）。
 *
 * 用途：
 *   - backend/test/helpers/testStack.ts（vitest 集成测试直接注入）
 *   - PAPERTEAM_TEST_RUNTIME=scripted 时的启动入口（backend/src/index.ts），
 *     供浏览器级 E2E 在无模型凭据的环境驱动完整真实链路：
 *     真实 WorkflowOrchestrator / checkpoint / SSE / HTTP / React —— 只有
 *     「模型输出」是确定性的脚本，绝不 mock HITL / resume / cancel 语义。
 *
 * 正式环境（未设置该环境变量）永远不会实例化本类。
 */

import type {
  AgentRuntime,
  AgentRunHandle,
  AgentTask,
  RuntimeHealth,
  RuntimeModelStatus,
} from "./types.js";

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

/** 修订后的章节片段（不引入新引用：修订只应基于现有 Evidence 收敛表述） */
export const REVISED_SECTION_TEX = [
  "\\section{章节标题（修订后）}",
  "",
  "修订后的论述：基于已核验证据的稳健表述，避免无证据的强论断。",
].join("\n");

/** Existing-Paper 论文理解输出 */
export const EXISTING_ANALYSIS_JSON = JSON.stringify({
  domainOverview:
    "该论文提出一种检索增强生成方法，在两个数据集上与基线对比；实验包含消融，但缺少统计显著性检验与最新基线。",
  relatedWorkDirections: ["RAG 基线方法", "评估协议"],
  researchGaps: ["缺少统计显著性检验", "基线较旧", "写作模板化明显"],
  potentialContributions: ["提出了一个融合重排的 RAG 变体", "在两个数据集上验证"],
  researchQuestions: ["重排对幻觉率的影响？"],
  literaturePlan: ["补充 2024-2026 的 RAG 基线论文"],
  evidence: [],
  bibliography: [],
  weaknesses: ["缺少显著性检验", "相关工作覆盖不足", "结论表述过强"],
});

/** 改进计划输出 */
export const IMPROVEMENT_PLAN_JSON = JSON.stringify({
  plan: [
    {
      section: "sections/experiments.tex",
      action: "补充统计显著性检验并弱化过强结论",
      rationale: "审稿指出缺少显著性检验",
      priority: "high",
    },
    {
      section: "sections/introduction.tex",
      action: "增加最新基线的相关工作讨论",
      rationale: "相关工作覆盖不足",
      priority: "medium",
    },
  ],
});

// ---- Review 输出（pass / fail 两套） ----

const REVIEW_PASS = {
  fact: JSON.stringify({
    summary: "关键论断均有证据支撑。",
    claims: [
      { section: "sections/introduction.tex", claim: "RAG 降低幻觉率", verdict: "SUPPORTED", evidenceId: "E001" },
    ],
    issues: [],
  }),
  academic: JSON.stringify({
    summary: "结构完整、论证清晰。",
    scores: { 问题定义: 88, 方法合理性: 85, 实验充分性: 82, 论证逻辑: 86, 写作质量: 90 },
    overallScore: 86,
    issues: [],
  }),
  style: JSON.stringify({
    summary: "文风自然。",
    riskScore: 18,
    issues: [],
  }),
};

const REVIEW_FAIL = {
  fact: JSON.stringify({
    summary: "存在无证据支撑的关键论断。",
    claims: [
      { section: "sections/introduction.tex", claim: "准确率提升 12.4%", verdict: "UNSUPPORTED", note: "Evidence 只支持 8.7%" },
    ],
    issues: [
      {
        category: "fact",
        severity: "critical",
        section: "sections/introduction.tex",
        description: "准确率提升 12.4% 无证据支撑（证据只支持 8.7%）",
        suggestedAction: "改为 8.7% 或补充实验",
        blocking: true,
      },
    ],
  }),
  academic: JSON.stringify({
    summary: "实验充分性不足。",
    scores: { 问题定义: 70, 方法合理性: 65, 实验充分性: 55, 论证逻辑: 68, 写作质量: 72 },
    overallScore: 66,
    issues: [
      {
        category: "academic",
        severity: "major",
        section: "sections/experiments.tex",
        description: "缺少消融实验",
        suggestedAction: "补充消融",
        blocking: false,
      },
    ],
  }),
  style: JSON.stringify({
    summary: "模板化表达较多。",
    riskScore: 68,
    issues: [
      {
        category: "style",
        severity: "minor",
        section: "sections/related-work.tex",
        description: "连接词滥用",
        suggestedAction: "改写过渡句",
        blocking: false,
      },
    ],
  }),
};

export interface ScriptedRuntimeOptions {
  /** feasibility 输出序列（依次消费；耗尽后用最后一个） */
  feasibilitySequence?: string[];
  /** review 轮次结果序列（每轮 = fact+academic+style 三路；耗尽后用最后一个），默认全 pass */
  reviewSequence?: ("pass" | "fail")[];
  /** 是否挂起第一次 runAgent（cancel / 并发测试） */
  hangFirstCall?: boolean;
}

export interface ScriptedRuntime {
  runtime: ScriptedAgentRuntime;
  calls: { agentId: string; contextScope?: string }[];
  release: () => void;
}

/**
 * 脚本化 Runtime 的诊断面：modelStatusSnapshot 返回 unknown（依赖模型配置的
 * E2E 门控用例据此自动跳过）；reconfigure 是 Settings 契约的 no-op。
 */
export interface ScriptedAgentRuntime extends AgentRuntime {
  modelStatusSnapshot(): Promise<RuntimeModelStatus>;
  reconfigure(modelSpec: string | undefined): Promise<void>;
  runtimeStats(): { activeRuns: number; managedSessions: number };
}

/** 按 contextScope 脚本化的 fake Runtime（不访问任何模型 / 网络） */
export function createScriptedRuntime(options: ScriptedRuntimeOptions = {}): ScriptedRuntime {
  const calls: { agentId: string; contextScope?: string }[] = [];
  const feasibilitySequence = options.feasibilitySequence ?? [FEASIBILITY_HIGH_JSON];
  const reviewSequence = options.reviewSequence ?? ["pass"];
  let feasibilityIndex = 0;
  let reviewCallIndex = 0; // 每 3 次为一轮
  let hangResolve: (() => void) | undefined;
  let hangConsumed = options.hangFirstCall !== true;

  const runtime: ScriptedAgentRuntime = {
    provider: "pi",
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
      } else if (scope === "research/existing-analysis") {
        output = EXISTING_ANALYSIS_JSON;
      } else if (scope === "research/feasibility") {
        output =
          feasibilitySequence[Math.min(feasibilityIndex, feasibilitySequence.length - 1)] ??
          FEASIBILITY_HIGH_JSON;
        feasibilityIndex += 1;
      } else if (scope === "writing/outline") {
        output = OUTLINE_JSON;
      } else if (scope === "writing/sections") {
        output = SECTION_TEX;
      } else if (scope === "writing/revision") {
        output = REVISED_SECTION_TEX;
      } else if (scope === "writing/improvement-plan") {
        output = IMPROVEMENT_PLAN_JSON;
      } else if (scope.startsWith("review/")) {
        const round = Math.floor(reviewCallIndex / 3);
        reviewCallIndex += 1;
        const outcome = reviewSequence[Math.min(round, reviewSequence.length - 1)] ?? "pass";
        const pack = outcome === "pass" ? REVIEW_PASS : REVIEW_FAIL;
        output = scope === "review/fact" ? pack.fact : scope === "review/academic" ? pack.academic : pack.style;
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
    startAgent: async (input) => {
      const task = await runtime.runAgent(input);
      return {
        taskId: task.taskId,
        sessionKey: `agent:${input.agentId}:paperteam-scripted`,
        events: async function* () {},
        cancel: async () => {},
        result: async () => task,
      };
    },
    getTask: () => {
      throw new Error("not implemented");
    },
    modelStatusSnapshot: async () => ({
      phase: "unknown" as const,
      providers: [],
      detail: "scripted（测试专用 Runtime，不访问任何模型）",
    }),
    reconfigure: async () => {},
    runtimeStats: () => ({ activeRuns: 0, managedSessions: 0 }),
    close: async () => {},
  };
  return {
    runtime,
    calls,
    release: () => hangResolve?.(),
  };
}

function makeHealth(ok: boolean): RuntimeHealth {
  return {
    ok,
    provider: "pi",
    status: ok ? "healthy" : "unreachable",
    detail: ok ? "scripted（测试专用，无模型调用）" : "down",
    latencyMs: ok ? 5 : null,
    checkedAt: new Date().toISOString(),
  };
}

/** v2 handle（终态任务；events 为空流；cancel 幂等 no-op）——测试辅助用 */
export function scriptedHandleFromTask(
  task: AgentTask,
  sessionKey = `agent:${task.agentId}:paperteam-scripted`,
): AgentRunHandle {
  return {
    taskId: task.taskId,
    sessionKey,
    events: async function* () {},
    cancel: async () => {},
    result: async () => task,
  };
}
