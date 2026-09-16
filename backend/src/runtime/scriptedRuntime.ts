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
import { extractNumericTokens } from "../review/styleInvariants.js";

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

/**
 * 修订后的章节片段基底（不引入新引用）。scriptedRevision 会把修订 prompt 里「本章节当前内容」
 * 中既有的 \\cite 命令原样追加回来——脚本化 Writer 镜象真实 Writer 的纪律：修订只基于现有
 * Evidence 收敛表述，不删除既有引用（M5.6 Citation Preservation Gate）。
 */
export const REVISED_SECTION_TEX = [
  "\\section{章节标题（修订后）}",
  "",
  "修订后的论述：基于已核验证据的稳健表述，避免无证据的强论断。",
].join("\n");

/**
 * [cite:drop] 项目的调研输出：bibliography 多一条真实可引用的 key（lewis2020rag），让实验
 * 章节能携带一条「只在该章节出现」的引用——修订删掉它就是无依据丢失（按 key 语义可判定）。
 * 放在实验章节而不是引言：fail 审稿包对引言的 finding 是 fact（证据不足，计划允许弱化 /
 * 删除论述，连带引用可删），对实验的 finding 是 academic（无删除依据）。
 */
export const RESEARCH_JSON_TWO_REFS = JSON.stringify({
  ...(JSON.parse(RESEARCH_JSON) as Record<string, unknown>),
  bibliography: [
    ...(JSON.parse(RESEARCH_JSON) as { bibliography: unknown[] }).bibliography,
    {
      key: "lewis2020rag",
      title: "Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks",
      authors: ["Lewis, Patrick", "Perez, Ethan"],
      year: 2020,
    },
  ],
});

/** [cite:drop] 项目的实验章节：在 SECTION_TEX 之上多引用一条 lewis2020rag（只在实验章节出现） */
export const SECTION_TEX_TWO_CITES = `${SECTION_TEX}\n\n开创性工作亦见 \\cite{lewis2020rag}。`;

/** \\cite 族命令（脚本化 Writer 只做「原样保留」，不解析 key） */
const SCRIPTED_CITE_PATTERN = /\\(?:cite|citep|citet|citealp|citealt|parencite|textcite|autocite)\*?(?:\[[^\]\n]*\])*\{[^{}]*\}/g;
/** 数学环境（equation / align 等；修订输出原样保留——M5.6 Fact Preservation） */
const SCRIPTED_MATH_ENV_PATTERN =
  /\\begin\{(equation\*?|align\*?|gather\*?|multline\*?|eqnarray\*?)}[\s\S]*?\\end\{\1\}/g;

/**
 * 脚本化修订：基底 + 当前章节内容里的既有事实（镜像真实 Writer 的 M5.6 纪律：
 * 引用命令、数学环境、数字 / 单位 token 原样保留——修订不是重写）。
 * dropCitations=true（[cite:drop] 标记）时不保留任何引用——复现 Writer 无计划删光
 * 引用的回归（公式与数字仍保留：该标记只测试引用维度）。
 * mutateFacts=true（[fact:mutate] 标记）时替换公式常量并新增无依据数值——复现
 * Writer 篡改实验事实的回归（Fact Preservation Gate 的用例输入）。
 * prompt 里没有「本章节当前内容」块（单元测试直接调用）时只返回基底。
 */
export function scriptedRevision(task: string, dropCitations: boolean, mutateFacts = false): string {
  const marker = "===== 本章节当前内容 =====";
  const start = task.indexOf(marker);
  if (start === -1) {
    return REVISED_SECTION_TEX;
  }
  const rest = task.slice(start + marker.length);
  const end = rest.indexOf("\n=====");
  const current = end === -1 ? rest : rest.slice(0, end);
  if (mutateFacts) {
    const mutatedMath = (current.match(SCRIPTED_MATH_ENV_PATTERN) ?? [])
      .join("\n")
      .replace(/\\alpha/g, "\\beta"); // 公式常量被替换（无计划依据）
    return [
      REVISED_SECTION_TEX,
      "",
      mutatedMath,
      "",
      "修订补充：准确率由 8.7\\% 提升至 12.4\\%，部署协议改为单次窗口验证。", // 无依据数值新增
    ].join("\n");
  }
  const cites = [...new Set(current.match(SCRIPTED_CITE_PATTERN) ?? [])];
  const mathEnvs = current.match(SCRIPTED_MATH_ENV_PATTERN) ?? [];
  // 数字保持与 Gate 的 prose 口径一致：排除表格区（表格单元格由表格比对覆盖；
  // 把表格数字复制进 prose 会造成「无依据新增」误报）。数学环境由 extractNumericTokens
  // 内部的 proseOf 剥离。
  const proseForNumbers = current
    .replace(/\\begin\{table\*?\}[\s\S]*?\\end\{table\*?\}/g, " ")
    .replace(/\\begin\{tabular[xX*]*\}{[^}]*}[\s\S]*?\\end\{tabular[xX*]*\}/g, " ");
  const numbers = [...extractNumericTokens(proseForNumbers)];
  const parts = [REVISED_SECTION_TEX];
  if (mathEnvs.length > 0) {
    parts.push("", ...mathEnvs);
  }
  if (numbers.length > 0) {
    parts.push("", `既有数值保持：${numbers.join("、")}。`);
  }
  if (!dropCitations && cites.length > 0) {
    parts.push("", `沿用既有引用：${cites.join(" ")}。`);
  }
  return parts.join("\n");
}

/** 摘要修订输出（M4.8：纯文本，无任何 LaTeX 命令——载体是 outline.abstract） */
export const REVISED_ABSTRACT_TEXT =
  "修订后的摘要：本文在已核验证据的基础上提出改进方法，并通过可复现实验验证其有效性，结论表述与证据强度一致。";

/**
 * M5.7 脚本化 Writer 的外部意见执行报告：修订 prompt 携带「外部修改意见」块时，
 * 输出末尾追加 %%%PT-OUTCOMES%%% 行（镜像真实 Writer 的报告协议）。
 * 意见正文包含测试标记 [conflict] 时该条报告 conflict（含依据，不改事实）；
 * 其余报告 applied。无外部意见块 → null（输出与旧版一致）。
 */
export function scriptedExternalOutcomes(task: string): string | null {
  if (!task.includes("===== 外部修改意见（最高业务优先级）=====")) {
    return null;
  }
  const ids = [...task.matchAll(/^--- 意见 (x-[a-z0-9]+)（/gm)].map((match) => match[1]!);
  if (ids.length === 0) {
    return null;
  }
  const reports = ids.map((id) => {
    const start = task.indexOf(`--- 意见 ${id}（`);
    const next = task.indexOf("\n--- 意见 ", start + 1);
    const body = task.slice(start, next === -1 ? task.length : next);
    if (body.includes("[conflict]")) {
      return {
        instructionId: id,
        outcome: "conflict",
        basis: "Table 10：baseline IDS = 24，本文 IDS = 35——当前数据不支持「优势」表述（脚本化冲突依据）",
      };
    }
    return { instructionId: id, outcome: "applied", basis: "已按意见在本节落实（脚本化报告）" };
  });
  return `%%%PT-OUTCOMES%%% ${JSON.stringify(reports)}`;
}

/** 报告行存在时追加为输出最后一行（无报告 → 原输出） */
function withExternalOutcomes(output: string, outcomes: string | null): string {
  return outcomes !== null ? `${output}\n${outcomes}` : output;
}

/**
 * 编译错误修复输出（合法：无文档骨架、花括号配对；只修语法不改内容 / 引用 / 公式——
 * M5.6 Fact Preservation：修复前的 \eqref 与 equation 环境必须原样保留，否则
 * 「语法修复」就成了公式丢失的回归通道）
 */
export const REPAIRED_SECTION_TEX = [
  "\\section{章节标题}",
  "",
  "本章节论述基于证据的核心观点 \\cite{gao2023survey}。",
  "检索质量与幻觉率的关系如式 \\eqref{eq:1} 所示。",
  "",
  "\\begin{equation}",
  "  q = \\alpha r + (1-\\alpha) g",
  "\\end{equation}",
  "",
  "修复后的表述：已按结构化诊断修正语法，内容、引用与公式保持不变。",
].join("\n");

/** Existing-Paper 分章节 Review 输出（SectionReviewService 的 findings 契约） */
export const SECTION_FINDINGS_JSON = JSON.stringify({
  findings: [
    {
      category: "academic",
      severity: "minor",
      page: 1,
      message: "脚本化审阅发现：论断表述偏强，建议补充限定条件。",
      suggestion: "弱化表述或补充实验支撑",
    },
  ],
});

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

const REVIEW_FAIL2 = {
  fact: JSON.stringify({
    summary: "关键论断有证据支撑。",
    claims: [
      { section: "sections/introduction.tex", claim: "RAG 降低幻觉率", verdict: "SUPPORTED", evidenceId: "E001" },
    ],
    issues: [],
  }),
  academic: JSON.stringify({
    summary: "实验充分性仍不足（有改善）。",
    scores: { 问题定义: 75, 方法合理性: 72, 实验充分性: 68, 论证逻辑: 74, 写作质量: 78 },
    overallScore: 73,
    issues: [
      {
        category: "academic",
        severity: "major",
        section: "sections/experiments.tex",
        description: "缺少消融实验",
        suggestedAction: "补充消融",
        blocking: false,
      },
      {
        category: "academic",
        severity: "major",
        section: "sections/experiments.tex",
        description: "缺少与基线方法的对比实验",
        suggestedAction: "补充对比实验",
        blocking: false,
      },
    ],
  }),
  style: JSON.stringify({
    summary: "表达仍有模板化痕迹（有改善）。",
    riskScore: 50,
    issues: [
      {
        category: "style",
        severity: "minor",
        section: "sections/related-work.tex",
        description: "连接词较多",
        suggestedAction: "改写过渡句",
        blocking: false,
      },
    ],
  }),
};

const REVIEW_FAIL3 = {
  fact: JSON.stringify({
    summary: "关键论断均有证据支撑。",
    claims: [
      { section: "sections/introduction.tex", claim: "RAG 降低幻觉率", verdict: "SUPPORTED", evidenceId: "E001" },
    ],
    issues: [],
  }),
  academic: JSON.stringify({
    summary: "结构与论证已改善，但总分未过线。",
    scores: { 问题定义: 80, 方法合理性: 78, 实验充分性: 74, 论证逻辑: 79, 写作质量: 82 },
    overallScore: 78,
    issues: [
      {
        category: "academic",
        severity: "major",
        section: "sections/experiments.tex",
        description: "缺少与基线方法的对比实验",
        suggestedAction: "补充对比实验",
        blocking: false,
      },
    ],
  }),
  style: JSON.stringify({
    summary: "表达已较自然，风险分仍偏高。",
    riskScore: 40,
    issues: [],
  }),
};

export interface ScriptedRuntimeOptions {
  /** feasibility 输出序列（依次消费；耗尽后用最后一个） */
  feasibilitySequence?: string[];
  /**
   * review 轮次结果序列（每轮 = fact+academic+style 三路；耗尽后用最后一个），默认全 pass。
   * fail（重问题）/ fail2（中等问题，较 fail 有改善）/ fail3（轻问题，较 fail2 有改善，
   * 仍因阈值不过线）：用于构造 IMPROVED 收敛轨迹，避免连续相同 fail 直接 CONVERGED。
   */
  reviewSequence?: ("pass" | "fail" | "fail2" | "fail3")[];
  /** 是否挂起第一次 runAgent（cancel / 并发测试） */
  hangFirstCall?: boolean;
  /**
   * 仅附加到第一轮 review/fact 载荷的 issue（回归用）：模拟真实 Reviewer 的
   * 非常规 section 归属（如「main.tex（摘要）」——2026-09-10 真实 smoke 暴露）；
   * 后续轮次不再出现，便于构造 fail → pass 轨迹。
   */
  firstRoundFactIssue?: Record<string, unknown>;
}

/**
 * 浏览器级 E2E 的按项目转向（单栈跑多场景用）：标记随 researchIdea 进入
 * research prompt，由 runAgent 在 scope==="research" 时解析并按 projectId 记忆。
 *
 *   [review:fail,fail2,pass]  本项目 review 轮次序列（语法同 PAPERTEAM_TEST_RUNTIME_REVIEW）
 *   [latex:broken]            introduction.tex 写入未定义命令 → 真实编译失败；
 *                             修复（writing/repair）输出正常内容 → 修复后编译通过
 *   [latex:unfixable]         修复 / 修订输出也带未定义命令 → repair loop 耗尽 → Build FAIL
 *
 * 未携带标记的项目保持既有行为（env 序列 / 全 pass），后端 vitest 不受影响。
 */
const REVIEW_MARKER = /\[review:([a-z0-9,\s]+)\]/;
const LATEX_MARKER = /\[latex:(broken|unfixable)\]/;
/** M4.8 摘要修订回归标记：首轮 review/fact 附加一条「main.tex（摘要）」critical finding，
 *  复现真实 Reviewer 的非常规归属，验证它被路由到摘要目标而不是组装根。 */
const ABSTRACT_MARKER = /\[abstract:finding\]/;
/**
 * M5.4 Style Polish 标记（随 researchIdea 进入 research prompt，按项目记忆）：
 *   [style:findings]  每轮 review/style 附加一条 minor style finding（含 reason / suggestedAction，
 *                     定位 sections/introduction.tex）→ apply_once 时进入 HITL / 润色
 *   [style:violate]   同上，但 writing/style-polish 输出会删掉一处 \cite → invariant 失败，原稿保留
 */
const STYLE_MARKER = /\[style:(findings|violate)\]/;
type StyleMode = "findings" | "violate";
/**
 * M5.6 Citation Preservation 标记（随 researchIdea 进入 research prompt，按项目记忆）：
 *   [cite:drop]  writing/revision 输出删光全部 \\cite → quality.gate 的 citation_keys_preserved
 *                catastrophic FAIL（Final 被阻止），revision.plan 派发 citation_removed 恢复条目
 */
const CITE_MARKER = /\[cite:drop\]/;
/**
 * M5.6 Fact Preservation 标记（同上按项目记忆）：
 *   [fact:mutate]  writing/revision 输出替换公式常量（\\alpha→\\beta）并新增无依据数值
 *                  （8.7%→12.4%）→ quality.gate 的 fact_preservation FAIL（Final 被阻止），
 *                  revision.plan 派发 fact_preserve 恢复条目；accept_draft 也会被 Draft 拦截
 */
const FACT_MARKER = /\[fact:mutate\]/;

/** 脚本化 style-only 润色：只改表达（「本章节论述」→「本节论述」），不动引用 / 数字 / 公式 */
function scriptedStylePolish(task: string, mode: StyleMode | undefined): string {
  const marker = task.includes("===== 当前摘要 =====") ? "===== 当前摘要 =====" : "===== 本章节当前内容 =====";
  const index = task.indexOf(marker);
  const current = index === -1 ? "" : task.slice(index + marker.length).trim();
  if (current === "") {
    return REVISED_SECTION_TEX;
  }
  let polished = current
    .replace("本章节论述基于证据的核心观点", "本节围绕已核验证据阐述核心观点")
    .replace("修订后的论述：", "修订后的表述：");
  if (mode === "violate") {
    polished = polished.replace(/\\cite\{[^}]*\}/, ""); // 故意破坏 citation key 集合
  }
  return polished;
}
/** 未定义命令：真实 xelatex 报 "! Undefined control sequence." 并按 l.N 定位行号 */
export const UNDEFINED_MACRO_TEX = "\\paperTeamUndefinedMacro";

type ReviewOutcomeName = "pass" | "fail" | "fail2" | "fail3";
type LatexMode = "broken" | "unfixable";

function parseReviewSequence(raw: string): ReviewOutcomeName[] | undefined {
  const parsed = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry): entry is ReviewOutcomeName =>
      entry === "pass" || entry === "fail" || entry === "fail2" || entry === "fail3",
    );
  return parsed.length > 0 ? parsed : undefined;
}

/** 当前写作调用是否作用于 introduction（脚本只破坏引言：halt-on-error 一次定位一个文件） */
function targetsIntroduction(task: string): boolean {
  // writing/sections 与 writing/repair 的 prompt 携带 introduction.tex；writing/revision 携带「引言」
  return task.includes("introduction.tex") || task.includes("「引言」");
}

/** 当前写作调用是否作用于 experiments（[cite:drop]：只让实验章节多带一条独有引用） */
function targetsExperiments(task: string): boolean {
  return task.includes("experiments.tex") || task.includes("「实验」");
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
  const reviewSequence = options.reviewSequence ?? reviewSequenceFromEnv() ?? ["pass"];
  let feasibilityIndex = 0;
  let reviewCallIndex = 0; // 每 3 次为一轮
  // 按项目转向（E2E 标记；见 ScriptedRuntimeOptions 上方说明）
  const projectReviewSequences = new Map<string, ReviewOutcomeName[]>();
  const projectReviewCalls = new Map<string, number>();
  const projectLatexModes = new Map<string, LatexMode>();
  const projectAbstractFindings = new Set<string>();
  const projectStyleModes = new Map<string, StyleMode>();
  const projectCiteDrop = new Set<string>();
  const projectFactMutate = new Set<string>();
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
      const projectId = input.projectId ?? "";
      let output = LATEX_DOC;
      if (scope === "research") {
        // research prompt 内嵌 researchIdea：解析 E2E 转向标记并按项目记忆
        if (projectId !== "") {
          const reviewMarker = REVIEW_MARKER.exec(input.task);
          if (reviewMarker !== null) {
            const sequence = parseReviewSequence(reviewMarker[1] ?? "");
            if (sequence !== undefined) {
              projectReviewSequences.set(projectId, sequence);
            }
          }
          const latexMarker = LATEX_MARKER.exec(input.task);
          if (latexMarker !== null) {
            projectLatexModes.set(projectId, latexMarker[1] as LatexMode);
          }
          if (ABSTRACT_MARKER.test(input.task)) {
            projectAbstractFindings.add(projectId);
          }
          const styleMarker = STYLE_MARKER.exec(input.task);
          if (styleMarker !== null) {
            projectStyleModes.set(projectId, styleMarker[1] as StyleMode);
          }
          if (CITE_MARKER.test(input.task)) {
            projectCiteDrop.add(projectId);
          }
          if (FACT_MARKER.test(input.task)) {
            projectFactMutate.add(projectId);
          }
        }
        output = projectCiteDrop.has(projectId) ? RESEARCH_JSON_TWO_REFS : RESEARCH_JSON;
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
        output =
          projectLatexModes.get(projectId) !== undefined && targetsIntroduction(input.task)
            ? `${SECTION_TEX}\n${UNDEFINED_MACRO_TEX}`
            : projectCiteDrop.has(projectId) && targetsExperiments(input.task)
              ? SECTION_TEX_TWO_CITES
              : SECTION_TEX;
      } else if (scope === "writing/revision") {
        // 真实模型回归（2026-09-10 真实 smoke）：修订 prompt 携带 \documentclass
        // 说明目标被误当成了完整文档（组装根 main.tex）——真实 Writer 此时返回
        // 完整骨架并被 DoD 拒绝。脚本化 Writer 镜象该行为，防止此类回归静默通过。
        const externalOutcomes = scriptedExternalOutcomes(input.task);
        output = input.task.includes("修订论文摘要")
          ? withExternalOutcomes(REVISED_ABSTRACT_TEXT, externalOutcomes)
          : input.task.includes("\\documentclass")
            ? LATEX_DOC
            : projectLatexModes.get(projectId) === "unfixable" && targetsIntroduction(input.task)
              ? withExternalOutcomes(
                  `${scriptedRevision(input.task, projectCiteDrop.has(projectId), projectFactMutate.has(projectId))}\n${UNDEFINED_MACRO_TEX}`,
                  externalOutcomes,
                )
              : withExternalOutcomes(
                  scriptedRevision(input.task, projectCiteDrop.has(projectId), projectFactMutate.has(projectId)),
                  externalOutcomes,
                );
      } else if (scope === "writing/style-polish") {
        output = scriptedStylePolish(input.task, projectStyleModes.get(projectId));
      } else if (scope === "writing/repair") {
        output =
          projectLatexModes.get(projectId) === "unfixable" && targetsIntroduction(input.task)
            ? `${REPAIRED_SECTION_TEX}\n${UNDEFINED_MACRO_TEX}`
            : REPAIRED_SECTION_TEX;
      } else if (scope === "writing/improvement-plan") {
        // 改进计划条目必须指向真实章节文件：prompt 现在携带「现有章节文件」清单
        // （M4.8；PDF 重建项目为 sections/secNN.tex）——脚本从中取前两个，
        // 提取不到时保持静态 fixture（兼容旧 prompt 形态的用例）
        const sectionFiles = [...input.task.matchAll(/^\s*- (sections\/[a-z0-9-]+\.tex)$/gm)].map(
          (match) => match[1] ?? "",
        );
        output =
          sectionFiles.length >= 2
            ? JSON.stringify({
                plan: sectionFiles.slice(0, 2).map((section, index) => ({
                  section,
                  action: index === 0 ? "补充关键论证并收敛过强表述" : "补全与相关工作的对比讨论",
                  rationale: "基于审稿发现与目标差距",
                  priority: index === 0 ? "high" : "medium",
                })),
              })
            : IMPROVEMENT_PLAN_JSON;
      } else if (scope.startsWith("review/section/")) {
        // 快速 Review 的分章节审阅（M4.7 只读红线 E2E：合法 findings，产出零 PDF）
        output = SECTION_FINDINGS_JSON;
      } else if (scope.startsWith("review/")) {
        // 轮次计数按项目隔离（E2E 单栈多项目互不串台；无 projectId 时退回全局计数）
        if (projectId !== "") {
          reviewCallIndex = projectReviewCalls.get(projectId) ?? 0;
        }
        const round = Math.floor(reviewCallIndex / 3);
        reviewCallIndex += 1;
        if (projectId !== "") {
          projectReviewCalls.set(projectId, reviewCallIndex);
        }
        const sequence = projectReviewSequences.get(projectId) ?? reviewSequence;
        const outcome = sequence[Math.min(round, sequence.length - 1)] ?? "pass";
        const pack =
          outcome === "pass"
            ? REVIEW_PASS
            : outcome === "fail2"
              ? REVIEW_FAIL2
              : outcome === "fail3"
                ? REVIEW_FAIL3
                : REVIEW_FAIL;
        output = scope === "review/fact" ? pack.fact : scope === "review/academic" ? pack.academic : pack.style;
        if (scope === "review/fact" && round === 0 && options.firstRoundFactIssue !== undefined) {
          output = appendReviewIssue(output, options.firstRoundFactIssue);
        }
        if (scope === "review/style" && projectStyleModes.has(projectId)) {
          // M5.4：可执行的 style minor finding（位置 / 问题 / 原因 / 改法 / 严重度）
          output = appendReviewIssue(output, {
            category: "style",
            severity: "minor",
            section: "sections/introduction.tex",
            description: "「本章节论述基于证据的核心观点」是空泛总结，未说明观点内容",
            reason: "段首句只宣告有观点而不陈述观点，读者无法获得信息",
            suggestedAction: "改为直接陈述核心观点，如「本节围绕已核验证据阐述核心观点」",
            blocking: false,
          });
        }
        if (scope === "review/fact" && round === 0 && projectAbstractFindings.has(projectId)) {
          // M4.8 摘要回归：真实 Reviewer 曾把摘要 critical finding 归到「main.tex（摘要）」
          output = appendReviewIssue(output, {
            category: "academic",
            severity: "critical",
            section: "main.tex（摘要）",
            description: "摘要承诺了正文未充分支撑的贡献，表述过强。",
            suggestedAction: "弱化摘要表述，与证据强度一致。",
            blocking: true,
          });
        }
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

/**
 * 向 review/fact 载荷追加一条 issue（firstRoundFactIssue 用）。载荷是
 * JSON 字符串：解析失败时原样返回（不破坏既有脚本行为）。
 */
function appendReviewIssue(payload: string, issue: Record<string, unknown>): string {
  try {
    const parsed = JSON.parse(payload) as { issues?: unknown[] };
    parsed.issues = [...(Array.isArray(parsed.issues) ? parsed.issues : []), issue];
    return JSON.stringify(parsed);
  } catch {
    return payload;
  }
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

/**
 * PAPERTEAM_TEST_RUNTIME_REVIEW="fail,fail2,pass" → 依次产出对应审稿轮
 * （浏览器级 E2E 驱动真实 Quality Gate FAIL→修订→PASS 链路用；fail2/fail3 为
 * 「有改善但未过线」的失败档，用于构造 IMPROVED 收敛轨迹；显式传入
 * reviewSequence 选项时以选项为准）。非法值忽略，保持全 pass 缺省。
 */
function reviewSequenceFromEnv(): ("pass" | "fail" | "fail2" | "fail3")[] | undefined {
  const raw = process.env["PAPERTEAM_TEST_RUNTIME_REVIEW"]?.trim();
  if (raw === undefined || raw === "") {
    return undefined;
  }
  const parsed = raw
    .split(",")
    .map((entry) => entry.trim())
    .filter((entry): entry is "pass" | "fail" | "fail2" | "fail3" =>
      entry === "pass" || entry === "fail" || entry === "fail2" || entry === "fail3",
    );
  return parsed.length > 0 ? parsed : undefined;
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
