/**
 * Experiment 3 数据集：Agent Workflow Evaluation（5 个场景）。
 *
 * 比较两臂：
 * - plain-llm：单次生成（无 Research / Evidence / Review / Revision 管线）——
 *   scenario 携带代表性单次输出（含典型缺陷：捏造引用 key、无证据数值论断、
 *   章节缺失），作为 scripted 数据如实标注；
 * - paperteam：完整 idea_to_paper workflow（Research → Evidence Grounding →
 *   Feasibility → Outline → Writing → Citation Verify → Review → Revision →
 *   Gate → Build），带语料的场景在 run 前预置 anchored 正例候选（经
 *   evidence.ground stage 真实三段核验转正）。
 *
 * 期望 stages / 章节 / 引用 / 论断 needle 全部来自 scripted outline 与
 * SECTION_TEX 的确定性输出契约；plain 输出按场景自造。
 */

import type { WorkflowScenario } from "../types.js";

/** 与 scripted RESEARCH_JSON bibliography 的 gao2023survey 对应的语料来源（title+year 精确对齐 bib key 关联） */
const SURVEY_SOURCE = {
  fileName: "gao2023survey.md",
  title: "Retrieval-Augmented Generation for Large Language Models: A Survey",
  year: 2023,
  authors: ["Gao, Yunfan"],
  content: [
    "# Introduction",
    "Retrieval-augmented generation mitigates hallucination by grounding generation in retrieved passages.",
    "Fact error rates drop measurably when external knowledge is injected at inference time.",
    "# Experiments",
    "On open-domain QA benchmarks the average factual error rate decreases by 38 percent with retrieval enabled.",
  ].join("\n"),
};

const CORE_STAGES = [
  "research.idea",
  "evidence.ground",
  "research.feasibility",
  "outline.plan",
  "writing.sections",
  "citation.verify",
  "review.run",
  "quality.gate",
] as const;

const REVISION_STAGES = ["revision.plan", "revision.revise", "revision.validate"] as const;

const SECTION_FILES = [
  "sections/introduction.tex",
  "sections/related-work.tex",
  "sections/method.tex",
  "sections/experiments.tex",
  "sections/conclusion.tex",
] as const;

export const WORKFLOW_SCENARIOS: readonly WorkflowScenario[] = [
  {
    kind: "workflow",
    id: "w1-corpus-clean-final",
    title: "带语料的干净全流程（一轮过）",
    description: "真实语料 + 预置 anchored 候选 → evidence.ground 转正 → 单轮 review pass → Final；引用经核验且 evidence-backed",
    researchIdea: "小语料场景下检索增强生成的系统评估",
    reviewSequence: ["pass"],
    corpus: [SURVEY_SOURCE],
    preseedClaims: [
      {
        claim: "检索增强生成通过把生成锚定在检索段落上缓解幻觉",
        locator: { fileName: "gao2023survey.md", needle: "Retrieval-augmented generation mitigates hallucination by grounding generation in retrieved passages." },
      },
    ],
    expected: {
      stages: [...CORE_STAGES, "build.final"],
      sectionFiles: [...SECTION_FILES],
      citationKeys: ["gao2023survey"],
      claimNeedles: ["基于证据的核心观点"],
    },
    plainBaseline: {
      output: [
        "\\section{引言}",
        "小语料场景下的检索增强生成评估十分重要。",
        "已有综述指出检索能降低幻觉率 \\cite{gao2023survey}。",
        "我们的方法将准确率提升了 23.7%。",
        "\\section{结论}",
        "本文提出了完整的评估协议。",
      ].join("\n"),
      fabricatedCitationKeys: [],
      unsupportedClaimNeedles: ["23.7"],
    },
  },
  {
    kind: "workflow",
    id: "w2-corpus-revision-loop",
    title: "带语料的修订环（fail → pass）",
    description: "首轮 review fail → 修订计划 → 修订 → revision.validate → 复审 pass → Final；证据链全程保持",
    researchIdea: "检索质量与幻觉率的量化关系研究",
    reviewSequence: ["fail", "pass"],
    corpus: [SURVEY_SOURCE],
    preseedClaims: [
      {
        claim: "开放域问答基准上启用检索后平均事实错误率下降 38%",
        locator: { fileName: "gao2023survey.md", needle: "On open-domain QA benchmarks the average factual error rate decreases by 38 percent with retrieval enabled." },
      },
    ],
    expected: {
      stages: [...CORE_STAGES, ...REVISION_STAGES, "build.final"],
      sectionFiles: [...SECTION_FILES],
      citationKeys: ["gao2023survey"],
      claimNeedles: ["基于证据的核心观点"],
    },
    plainBaseline: {
      output: [
        "\\section{引言}",
        "检索质量与幻觉率存在量化关系 \\cite{zhao2024nonexistent}。",
        "实验表明检索质量提升可将幻觉率降低 61.3% \\cite{gao2023survey}。",
        "\\section{结论}",
        "本文给出了确定性结论。",
      ].join("\n"),
      fabricatedCitationKeys: ["zhao2024nonexistent"],
      unsupportedClaimNeedles: ["61.3"],
    },
  },
  {
    kind: "workflow",
    id: "w3-nocorpus-clean-final",
    title: "无外部语料的干净全流程（legacy evidence 路径）",
    description: "scripted research 走 legacy unverified evidence → evidence.ground 零候选 no-op → 单轮 pass → Final；诚实记录 citation 覆盖为 0",
    researchIdea: "领域自适应的重排策略研究",
    reviewSequence: ["pass"],
    expected: {
      stages: [...CORE_STAGES, "build.final"],
      sectionFiles: [...SECTION_FILES],
      citationKeys: ["gao2023survey"],
      claimNeedles: ["基于证据的核心观点"],
    },
    plainBaseline: {
      output: [
        "\\section{引言}",
        "重排策略对领域自适应至关重要 \\cite{liu2025madeup}。",
        "\\section{相关工作}",
        "相关工作覆盖不足。",
      ].join("\n"),
      fabricatedCitationKeys: ["liu2025madeup"],
      unsupportedClaimNeedles: [],
    },
  },
  {
    kind: "workflow",
    id: "w4-zh-corpus-clean-final",
    title: "中文语料干净全流程",
    description: "中文研究主题 + 语料 + 预置候选 → 全流程 Final",
    researchIdea: "中文商品评论情感分类的示例选择策略",
    reviewSequence: ["pass"],
    corpus: [SURVEY_SOURCE],
    preseedClaims: [
      {
        claim: "推理时注入外部知识后事实错误率显著下降",
        locator: { fileName: "gao2023survey.md", needle: "Fact error rates drop measurably when external knowledge is injected at inference time." },
      },
    ],
    expected: {
      stages: [...CORE_STAGES, "build.final"],
      sectionFiles: [...SECTION_FILES],
      citationKeys: ["gao2023survey"],
      claimNeedles: ["基于证据的核心观点"],
    },
    plainBaseline: {
      output: [
        "\\section{引言}",
        "示例选择策略对中文情感分类影响显著 \\cite{wang2031phantom}。",
        "我们的策略在所有数据集上达到 95.4% 准确率。",
      ].join("\n"),
      fabricatedCitationKeys: ["wang2031phantom"],
      unsupportedClaimNeedles: ["95.4"],
    },
  },
  {
    kind: "workflow",
    id: "w5-multiround-convergence",
    title: "多轮修订收敛（fail → fail2 → pass）",
    description: "IMPROVED 轨迹：两轮修订后过线 Final；修订环与 revision.validate 各跑两轮",
    researchIdea: "小语料 RAG 评估协议的可复现性研究",
    reviewSequence: ["fail", "fail2", "pass"],
    expected: {
      stages: [...CORE_STAGES, ...REVISION_STAGES, "build.final"],
      sectionFiles: [...SECTION_FILES],
      citationKeys: ["gao2023survey"],
      claimNeedles: ["基于证据的核心观点"],
    },
    plainBaseline: {
      output: [
        "\\section{引言}",
        "可复现性是评估协议的核心 \\cite{gao2023survey} \\cite{chen2026ghost}。",
        "据报告该协议可将复现成本降低 47.8%。",
      ].join("\n"),
      fabricatedCitationKeys: ["chen2026ghost"],
      unsupportedClaimNeedles: ["47.8"],
    },
  },
];
