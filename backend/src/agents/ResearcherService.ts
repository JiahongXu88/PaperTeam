/**
 * Researcher 业务角色。
 *
 * 职责（PRD §7.2）：Idea Research —— 领域现状、Related Work 方向、Research Gap、
 * 潜在贡献、研究问题、文献检索计划；并从项目文献库提取候选 Evidence 与
 * 候选参考文献（bibliography）。Researcher 不写论文正文。
 *
 * 链路：读 Project → 组装 Prompt（含文献摘要）→ AgentRuntime.runAgent
 * → 结构化校验 → 落盘 research/research.json + Evidence 追加 → 返回摘要。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { AgentRunFailedError, BusinessError } from "../errors.js";
import type { ProjectMetadata, ProjectStore } from "../project/ProjectStore.js";
import { normalizeManuscriptLanguage, targetLanguageLines } from "../project/language.js";
import type { AgentRuntime } from "../runtime/types.js";
import type { EvidenceAppendInput, EvidenceStore } from "../evidence/EvidenceStore.js";
import type { EvidenceGroundingService } from "../evidence/EvidenceGroundingService.js";
import type { SourceStore, SourceItem } from "../sources/SourceStore.js";
import { compactTitle } from "../citation/referenceText.js";
import {
  appendRequirementSupplyQuery,
  applyResearchPlanUpdate,
  createResearchPlan,
  parseResearchPlan,
  parseResearchPlanUpdateInput,
  parseSurveyProfile,
  planChainFields,
  readPlanChain,
  resolvePlanChainOnRerun,
  type RequirementSupplyQueryInput,
  type ResearchPlan,
  type ResearchPlanChain,
  type ResearchPlanQuery,
  type StoredResearchPlan,
  type SurveyResearchProfile,
} from "./researchPlan.js";
import type { PlanExecutionEntry } from "./researchPlanExecution.js";
import type { ResearchGap } from "./researchGap.js";
import type { ResearchLoopPolicy } from "./researchLoopPolicy.js";
import type { ResearchLoopState } from "./researchLoop.js";
import {
  extractJsonObject,
  readOptionalStringArray,
  readRequiredString,
  readRequiredStringArray,
} from "./outputParsing.js";

export interface ResearchReport {
  domainOverview: string;
  relatedWorkDirections: string[];
  researchGaps: string[];
  potentialContributions: string[];
  researchQuestions: string[];
  literaturePlan: string[];
}

export interface ResearcherResult {
  report: ResearchReport;
  /** 落盘路径（相对项目根） */
  reportPath: string;
  /** 本次产出的检索计划（M8.1；Agent 未产出合法 plan 时为 undefined） */
  plan: ResearchPlan | undefined;
  /** 本次追加的 Evidence 条数（legacy 路径：无 chunk 锚定的候选，unverified 直存） */
  evidenceAppended: number;
  /** 本次提交进核验队列的 Evidence 候选条数（M6.5 chunk 锚定路径） */
  evidenceProposed: number;
  /** 候选参考文献条数 */
  bibliographyCount: number;
  /** 本次 Researcher 任务的 Runtime 任务 id（诊断） */
  taskId: string;
}

export interface ResearcherServiceOptions {
  runtime: AgentRuntime;
  agentId: string;
  projects: ProjectStore;
  evidence: EvidenceStore;
  sources: SourceStore;
  /**
   * Evidence Grounding 管道（M6.5）：research JSON 中带 chunk 锚定
   * （sourceId+chunkId+quote）的 evidence 走候选管道（propose → 核验 →
   * 转正）；未注入时锚定候选退回 legacy unverified 追加（旧装配兼容）。
   */
  evidenceGrounding?: EvidenceGroundingService;
  /** 逐 run 执行超时覆盖（毫秒；长论文阶段口径，见 config.pi.longRunTimeoutMs）；缺省沿用 Runtime 默认 */
  runTimeoutMs?: number;
  log?: (message: string) => void;
}

export class ResearcherService {
  private readonly runtime: AgentRuntime;
  private readonly agentId: string;
  private readonly projects: ProjectStore;
  private readonly evidence: EvidenceStore;
  private readonly sources: SourceStore;
  private readonly evidenceGrounding: EvidenceGroundingService | undefined;
  private readonly log: (message: string) => void;
  private readonly timeoutOverride: { timeoutMs: number } | Record<string, never>;

  constructor(options: ResearcherServiceOptions) {
    this.runtime = options.runtime;
    this.agentId = options.agentId;
    this.projects = options.projects;
    this.evidence = options.evidence;
    this.sources = options.sources;
    this.evidenceGrounding = options.evidenceGrounding;
    this.log = options.log ?? (() => {});
    this.timeoutOverride = options.runTimeoutMs !== undefined ? { timeoutMs: options.runTimeoutMs } : {};
  }

  /**
   * 执行一次 Idea Research。
   * 结构化产出必须通过校验才落盘（Agent 返回文本 ≠ 成功）；
   * Researcher 提出的 Evidence 以 unverified 状态进入 EvidenceStore（待核验）。
   */
  async research(params: {
    projectId: string;
    /** 用户补充说明（如 HITL 反馈） */
    extraInstructions?: string;
  }): Promise<ResearcherResult> {
    const project = await this.projects.getRequired(params.projectId);
    const language = normalizeManuscriptLanguage(project.language);
    const sourceDigest = await this.buildSourceDigest(params.projectId);
    // M9.7.4：重跑时把上一轮 bibliography 注入 prompt（bounded 复述纪律），
    // 抑制「会话记忆复述 + 每轮扩充」导致的 20→30→36 单调膨胀
    const existing = await readResearchArtifact(this.projects, params.projectId);
    const existingBibliography = existing?.bibliography;

    const task = await this.runtime.runAgent({
      agentId: this.agentId,
      ...this.timeoutOverride,
      task: buildResearchPrompt(project, sourceDigest, params.extraInstructions, existingBibliography),
      projectId: params.projectId,
      contextScope: "research",
      ...(language !== undefined ? { language } : {}),
      metadata: { role: "researcher" },
    });
    if (task.status !== "completed") {
      throw new AgentRunFailedError(task.error ?? `Researcher 任务以 ${task.status} 状态结束`);
    }
    const output = task.output ?? "";
    const parsed = extractJsonObject(output, "Researcher 调研结果");

    const report: ResearchReport = {
      domainOverview: readRequiredString(parsed, "domainOverview", "Researcher 调研结果"),
      relatedWorkDirections: readRequiredStringArray(
        parsed,
        "relatedWorkDirections",
        "Researcher 调研结果",
      ),
      researchGaps: readRequiredStringArray(parsed, "researchGaps", "Researcher 调研结果"),
      potentialContributions: readRequiredStringArray(
        parsed,
        "potentialContributions",
        "Researcher 调研结果",
        { minItems: 1 },
      ),
      researchQuestions: readRequiredStringArray(
        parsed,
        "researchQuestions",
        "Researcher 调研结果",
      ),
      literaturePlan: readRequiredStringArray(parsed, "literaturePlan", "Researcher 调研结果"),
    };

    // 落盘 research/research.json（Authoritative State）
    const researchDir = this.projects.researchDir(params.projectId);
    await mkdir(researchDir, { recursive: true });
    const parsedCandidates = readEvidenceCandidates(parsed);
    // M8.1：宽容解析检索计划——旧输出契约（无 plan 字段）完全兼容，plan 为空则省略
    const plan = parseResearchPlan(parsed);
    // M8.3.1 merge strategy：重跑只刷新报告侧字段（report / evidence /
    // bibliography / generatedAt / taskId）；计划链（plans / activePlanId）与
    // executionHistory 是用户可控 + 执行回填状态，原样保留——已有链时本轮
    // Agent 产出的 plan 不落盘（用户修改优先），计划演化走编辑 / 派生显式路径。
    // M8.3.3：gaps 决策记录与 loopPolicy 同属用户可控状态，同样不被重跑覆盖
    // （existing 已在 runAgent 前读取——M9.7.4 上一轮 bibliography 注入复用）
    const chain = resolvePlanChainOnRerun(
      existing !== null ? readPlanChain(existing) : { plans: [], activePlanId: undefined },
      plan,
    );
    const artifact = {
      generatedAt: new Date().toISOString(),
      taskId: task.taskId,
      ...planChainFields(chain),
      ...(existing?.executionHistory !== undefined && existing.executionHistory.length > 0
        ? { executionHistory: existing.executionHistory }
        : {}),
      ...(existing?.gaps !== undefined && existing.gaps.length > 0 ? { gaps: existing.gaps } : {}),
      ...(existing?.loopPolicy !== undefined ? { loopPolicy: existing.loopPolicy } : {}),
      ...(existing?.loop !== undefined ? { loop: existing.loop } : {}),
      report,
      evidence: parsedCandidates,
      bibliography: readBibliography(parsed),
    };
    const reportPath = join("research", "research.json");
    await writeFile(join(researchDir, "research.json"), JSON.stringify(artifact, null, 2) + "\n", "utf8");

    // M6.5 双路径：chunk 锚定（sourceId+chunkId+quote 齐）的 evidence 走候选
    // 管道（propose → grounding 核验 → verified 才转正进 EvidenceStore）；
    // 无锚定的候选保持 legacy 行为（unverified 追加——兼容既有输出契约，
    // 待 Researcher 全面迁移到工具化提案后收口）。
    let evidenceAppended = 0;
    let evidenceProposed = 0;
    for (const candidate of parsedCandidates) {
      const anchored =
        this.evidenceGrounding !== undefined &&
        candidate.chunkId !== undefined &&
        candidate.quote !== undefined &&
        candidate.quote.trim() !== "";
      if (anchored) {
        try {
          const { deduplicated } = await this.evidenceGrounding!.propose(params.projectId, {
            sourceId: candidate.sourceId ?? candidate.chunkId!.split(":")[0]!,
            chunkId: candidate.chunkId!,
            claim: candidate.claim,
            quote: candidate.quote!,
            ...(candidate.summary !== undefined ? { summary: candidate.summary } : {}),
            proposedBy: "researcher",
          });
          if (!deduplicated) {
            evidenceProposed += 1;
          }
        } catch (error) {
          // 锚定非法（chunk 不存在 / 格式问题）：结构化记录并降级 legacy 追加，
          // 不让单条坏候选炸掉整个 research 阶段
          this.log(
            `[researcher] projectId=${params.projectId} 候选提案失败，降级 unverified 追加：${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
          );
          await this.evidence.append(
            params.projectId,
            toLegacyAppendInput(candidate),
            "researcher",
          );
          evidenceAppended += 1;
        }
      } else {
        await this.evidence.append(params.projectId, toLegacyAppendInput(candidate), "researcher");
        evidenceAppended += 1;
      }
    }

    this.log(
      `[researcher] projectId=${params.projectId} 调研完成：gaps=${report.researchGaps.length} plan=${plan !== undefined ? `${plan.queries.length} queries` : "none"}${plan !== undefined && plan.requirements !== undefined ? ` requirements=${plan.requirements.length}` : ""} evidence=appended:${evidenceAppended}/proposed:${evidenceProposed} bibliography=${artifact.bibliography.length}`,
    );
    return {
      report,
      reportPath,
      plan,
      evidenceAppended,
      evidenceProposed,
      bibliographyCount: artifact.bibliography.length,
      taskId: task.taskId,
    };
  }

  /**
   * 汇总项目文献库（供 Prompt 注入；只提供已解析摘要，不塞原始全文）。
   * M9.4：每条标注全文可检索性（有全文 → retrieve_library 可锚定；仅元数据
   * → 只能作为线索引用），并在存在可检索全文时附锚定路径提示——让模型
   * 知道「锚定值得做」，而不是默认走摘要捷径。
   */
  private async buildSourceDigest(projectId: string): Promise<string> {
    const items = await this.sources.list(projectId);
    const usable = items.filter(
      (item) => item.sourceRole !== "reference" && item.status !== "failed" && item.status !== "pending",
    );
    if (usable.length === 0) {
      return "（项目文献库当前为空：请先用 search_papers 检索相关文献，基于检索结果给出调研方向，并用 save_candidates 保存重要候选）";
    }
    const lines = usable.slice(0, 20).map((item) => describeSource(item));
    const fulltextCount = usable.filter(hasRetrievableFullText).length;
    const header = [
      `项目文献库（${usable.length} 项，其中 ${fulltextCount} 项已入库全文可检索锚定）：`,
      ...lines,
    ];
    if (fulltextCount > 0) {
      header.push(
        "",
        "已入库全文的条目可用 retrieve_library 按主题检索原文段落（结果带 CHUNK 标识），",
        "再用 get_chunk 回取逐字原文——从这些段落逐字摘录的 quote 可以锚定为待核验证据候选（见要求 4）。",
      );
    }
    return header.join("\n");
  }

  /**
   * Existing-Paper：论文理解。
   * 读取导入的 LaTeX 项目，产出结构化理解（贡献 / 论证 / 实验组织 / 弱点），
   * 映射为 ResearchReport 形状供后续 Feasibility 与改进计划复用。
   */
  async analyzeExistingPaper(params: {
    projectId: string;
    manuscriptDigest: string;
  }): Promise<ResearcherResult & { weaknesses: string[]; contributions: string[] }> {
    const project = await this.projects.getRequired(params.projectId);
    const task = await this.runtime.runAgent({
      agentId: this.agentId,
      ...this.timeoutOverride,
      task: [
        "你是一名学术研究员（Researcher）。请阅读并理解下面这篇已有论文（LaTeX 结构化摘要），做论文理解分析。",
        "",
        "只输出一个 JSON 对象（不要 Markdown 围栏），字段：",
        "{",
        '  "domainOverview": "论文内容与论证结构概述（200-400 字）",',
        '  "relatedWorkDirections": ["论文涉及的相关工作方向"],',
        '  "researchGaps": ["论文当前的弱点与不足（对照目标档次）"],',
        '  "potentialContributions": ["论文现有贡献"],',
        '  "researchQuestions": ["论文试图回答的问题"],',
        '  "literaturePlan": ["建议补充的文献方向"],',
        '  "evidence": [],',
        '  "bibliography": [],',
        '  "weaknesses": ["具体弱点清单（供改进计划使用）"]',
        "}",
        "",
        "要求：如实评估，不夸大贡献；实验组织方式（Benchmark/Baseline/Ablation）缺失要点名。",
        "涉及外部文献对比或定位时，可用 search_papers 检索、lookup_paper 核验；禁止凭记忆断言论文的存在性、年份或 venue。",
        "",
        `标题：${project.title}`,
        `目标档次：${project.targetProfile ?? "未指定"}`,
        "",
        "===== 论文（LaTeX 结构化摘要）=====",
        params.manuscriptDigest,
      ].join("\n"),
      projectId: params.projectId,
      contextScope: "research/existing-analysis",
      metadata: { role: "researcher", skill: "paper-understanding" },
    });
    if (task.status !== "completed") {
      throw new AgentRunFailedError(task.error ?? `论文理解任务以 ${task.status} 状态结束`);
    }
    const parsed = extractJsonObject(task.output ?? "", "论文理解结果");
    const report: ResearchReport = {
      domainOverview: readRequiredString(parsed, "domainOverview", "论文理解结果"),
      relatedWorkDirections: readRequiredStringArray(
        parsed,
        "relatedWorkDirections",
        "论文理解结果",
        { minItems: 0 },
      ),
      researchGaps: readRequiredStringArray(parsed, "researchGaps", "论文理解结果", { minItems: 0 }),
      potentialContributions: readRequiredStringArray(
        parsed,
        "potentialContributions",
        "论文理解结果",
      ),
      researchQuestions: readRequiredStringArray(parsed, "researchQuestions", "论文理解结果", {
        minItems: 0,
      }),
      literaturePlan: readRequiredStringArray(parsed, "literaturePlan", "论文理解结果", {
        minItems: 0,
      }),
    };
    const weaknesses = readRequiredStringArray(parsed, "weaknesses", "论文理解结果", {
      minItems: 0,
    });

    // 落盘（覆盖 research.json：existing-paper 流程的“调研”即论文理解）。
    // M8.3.1：计划链与执行历史同样不受覆盖（与 research() 重跑同一 merge 策略）；
    // M8.3.3：gaps 决策记录与 loopPolicy 同样保留（用户可控状态）
    const researchDir = this.projects.researchDir(params.projectId);
    await mkdir(researchDir, { recursive: true });
    const existing = await readResearchArtifact(this.projects, params.projectId);
    const chain = existing !== null ? readPlanChain(existing) : { plans: [], activePlanId: undefined };
    const artifact: ResearchArtifact = {
      generatedAt: new Date().toISOString(),
      taskId: task.taskId,
      ...planChainFields(chain),
      ...(existing?.executionHistory !== undefined && existing.executionHistory.length > 0
        ? { executionHistory: existing.executionHistory }
        : {}),
      ...(existing?.gaps !== undefined && existing.gaps.length > 0 ? { gaps: existing.gaps } : {}),
      ...(existing?.loopPolicy !== undefined ? { loopPolicy: existing.loopPolicy } : {}),
      ...(existing?.loop !== undefined ? { loop: existing.loop } : {}),
      report,
      evidence: [],
      bibliography: [],
    };
    await writeFile(
      join(researchDir, "research.json"),
      JSON.stringify({ ...artifact, weaknesses, kind: "existing_paper_analysis" }, null, 2) + "\n",
      "utf8",
    );
    this.log(`[researcher] projectId=${params.projectId} 论文理解完成：weaknesses=${weaknesses.length}`);
    return {
      report,
      reportPath: "research/research.json",
      plan: undefined,
      evidenceAppended: 0,
      evidenceProposed: 0,
      bibliographyCount: 0,
      taskId: task.taskId,
      weaknesses,
      contributions: report.potentialContributions,
    };
  }

  /**
   * M10.3：Existing-Paper 修订研究规划（requirement-driven，只规划不检索）。
   *
   * 把「需要新增/补强文献的位置」（论文理解弱点 + 外部意见 + 作者修订目标中
   * 涉及外部科学论断的部分）转化为 M8 ResearchPlan（questions / queries /
   * requirements）。检索本身由后续 research.execute（用户批准计划后）执行——
   * Writer / 本方法都不做即时检索（Search 是 Evidence Gap 的下游工具）。
   *
   * 纪律：
   * - requirements 只覆盖 external literature 需要（related work / 外部方法
   *   事实描述 / 对比定位）；作者自身实验数据不进 requirements（那是
   *   user_confirmed Evidence 的领地，不归文献管道管）；
   * - 计划落盘走 writeResearchPlanChain（draft 状态，等待 HITL 批准）；
   * - 已存在计划链时（重跑 / 用户已编辑）：initial 模式尊重既有链（幂等返回），
   *   revise 模式仅在活动计划仍为 draft 时替换（approved/executing 是用户
   *   已提交状态，不允许静默覆盖）。
   */
  async planRevisionResearch(params: {
    projectId: string;
    analysisDigest: string;
    externalInstructionDigest?: string;
    authorGoal?: string;
    /** HITL revise 回路携带的反馈（触发 draft 计划替换） */
    feedback?: string;
  }): Promise<{ plan: StoredResearchPlan; taskId: string; regenerated: boolean }> {
    const project = await this.projects.getRequired(params.projectId);
    const language = normalizeManuscriptLanguage(project.language);
    const task = await this.runtime.runAgent({
      agentId: this.agentId,
      ...this.timeoutOverride,
      task: buildRevisionResearchPrompt({
        title: project.title,
        targetProfile: project.targetProfile,
        analysisDigest: params.analysisDigest,
        ...(params.externalInstructionDigest !== undefined
          ? { externalInstructionDigest: params.externalInstructionDigest }
          : {}),
        ...(params.authorGoal !== undefined ? { authorGoal: params.authorGoal } : {}),
        ...(params.feedback !== undefined ? { feedback: params.feedback } : {}),
      }),
      projectId: params.projectId,
      contextScope: "research/revision-plan",
      ...(language !== undefined ? { language } : {}),
      metadata: { role: "researcher", skill: "revision-research-plan" },
    });
    if (task.status !== "completed") {
      throw new AgentRunFailedError(task.error ?? `修订研究规划任务以 ${task.status} 状态结束`);
    }
    const parsed = extractJsonObject(task.output ?? "", "修订研究计划");
    const plan = parseResearchPlan(parsed);
    if (plan === undefined || (plan.queries.length === 0 && plan.questions.length === 0)) {
      throw new AgentRunFailedError("修订研究计划：缺少非空 plan（questions / queries 至少一项）");
    }

    const researchDir = this.projects.researchDir(params.projectId);
    await mkdir(researchDir, { recursive: true });
    const existing = await readResearchArtifact(this.projects, params.projectId);
    if (existing === null) {
      throw new AgentRunFailedError("修订研究计划：缺少 research/research.json（先执行论文理解 import.understand）");
    }
    const chain = readPlanChain(existing);
    if (params.feedback === undefined && chain.plans.length > 0) {
      // initial 幂等：已有计划链（用户编辑过 / 前一 run 已建）→ 尊重既有状态
      const active = chain.plans.find((candidate) => candidate.planId === chain.activePlanId);
      if (active !== undefined) {
        return { plan: active, taskId: task.taskId, regenerated: false };
      }
    }
    if (params.feedback !== undefined) {
      const active = chain.plans.find((candidate) => candidate.planId === chain.activePlanId);
      if (active !== undefined && active.status !== "draft") {
        throw new AgentRunFailedError(
          `修订研究计划：活动计划已${active.status === "approved" ? "批准" : "执行"}，不允许静默替换（应走计划编辑路径）`,
        );
      }
    }
    // 建立 / 替换 draft 计划链（revision 场景无父计划：首轮即 iteration 1）
    const nextChain = replaceDraftChain(plan);
    await writeResearchPlanChain(
      this.projects,
      params.projectId,
      existing,
      nextChain,
      existing?.executionHistory,
    );
    const active = nextChain.plans.find((candidate) => candidate.planId === nextChain.activePlanId)!;
    this.log(
      `[researcher] projectId=${params.projectId} 修订研究计划完成：queries=${plan.queries.length} requirements=${plan.requirements?.length ?? 0}`,
    );
    return { plan: active, taskId: task.taskId, regenerated: params.feedback !== undefined };
  }

  /**
   * M11.1.4 topic_survey：Survey 语义的研究规划（只规划不检索）。
   *
   * 与 idea / revision 规划的区别：目标不是「提出原创研究 idea / 实验可行性」，
   * 而是为「系统性梳理一个主题的已有文献」制定计划——
   * - plan.questions：综述要回答的研究问题（survey questions）；
   * - plan.queries：学术 / Web 检索词（temporal / seminal / representative /
   *   recent 覆盖意图直接写进检索词与 rationale，不建第二套字段）；
   * - surveyProfile：范围界定 + 初始 taxonomy 意图 + 覆盖意图（research.json
   *   顶层可选字段；Matrix 构建消费 taxonomy 意图，非法回退缺省词表）。
   *
   * 落盘：无 research.json 时初始化（survey 口径的最小 report——topic_survey
   * 链路只有计划执行 / coverage 消费 research.json，Matrix / Synthesis /
   * Outline 均不读 report）；已有计划链时与 planRevisionResearch 同纪律
   * （initial 幂等尊重既有链，feedback 仅替换 draft）。
   */
  async planSurveyResearch(params: {
    projectId: string;
    /** 综述主题（= project.title）与用户可选参数的范围摘要（调用方拼装） */
    scopeDigest: string;
    /** HITL revise 回路携带的反馈（触发 draft 计划替换） */
    feedback?: string;
  }): Promise<{
    plan: StoredResearchPlan;
    profile: SurveyResearchProfile | undefined;
    taskId: string;
    regenerated: boolean;
  }> {
    const project = await this.projects.getRequired(params.projectId);
    const language = normalizeManuscriptLanguage(project.language);
    const task = await this.runtime.runAgent({
      agentId: this.agentId,
      ...this.timeoutOverride,
      task: buildSurveyPlanPrompt({
        title: project.title,
        scopeDigest: params.scopeDigest,
        ...(params.feedback !== undefined ? { feedback: params.feedback } : {}),
      }),
      projectId: params.projectId,
      contextScope: "research/survey-plan",
      ...(language !== undefined ? { language } : {}),
      metadata: { role: "researcher", skill: "survey-research-plan" },
    });
    if (task.status !== "completed") {
      throw new AgentRunFailedError(task.error ?? `综述研究规划任务以 ${task.status} 状态结束`);
    }
    const parsed = extractJsonObject(task.output ?? "", "综述研究计划");
    const plan = parseResearchPlan(parsed);
    if (plan === undefined || plan.queries.length === 0) {
      throw new AgentRunFailedError("综述研究计划：缺少非空 plan.queries（综述必须有检索词）");
    }
    const profile = parseSurveyProfile(parsed);

    const researchDir = this.projects.researchDir(params.projectId);
    await mkdir(researchDir, { recursive: true });
    const existing = await readResearchArtifact(this.projects, params.projectId);
    if (params.feedback === undefined && existing !== null) {
      const chain = readPlanChain(existing);
      const active = chain.plans.find((candidate) => candidate.planId === chain.activePlanId);
      if (active !== undefined) {
        // initial 幂等：已有计划链（用户编辑过 / 前一 run 已建）→ 尊重既有状态
        return {
          plan: active,
          profile: existing.surveyProfile,
          taskId: task.taskId,
          regenerated: false,
        };
      }
    }
    if (params.feedback !== undefined && existing !== null) {
      const chain = readPlanChain(existing);
      const active = chain.plans.find((candidate) => candidate.planId === chain.activePlanId);
      if (active !== undefined && active.status !== "draft") {
        throw new AgentRunFailedError(
          `综述研究计划：活动计划已${active.status === "approved" ? "批准" : active.status === "executing" ? "在执行" : "执行完成"}，不允许静默替换（应走计划编辑 / 派生路径）`,
        );
      }
    }
    const nextChain = replaceDraftChain(plan);
    const base: ResearchArtifact =
      existing ?? {
        generatedAt: new Date().toISOString(),
        taskId: task.taskId,
        // survey 口径最小 report：不为 idea 流程伪造「贡献 / 缺口」，只承载计划链
        report: {
          domainOverview:
            profile?.scope !== undefined && profile.scope !== ""
              ? profile.scope
              : `围绕「${project.title}」的文献综述研究`,
          relatedWorkDirections: [],
          researchGaps: [],
          potentialContributions: [
            `以综述形式系统性梳理「${project.title}」的方法体系与研究现状（不产出新实验）`,
          ],
          researchQuestions: plan.questions,
          literaturePlan: plan.queries.map((query) => query.query),
        },
        evidence: [],
        bibliography: [],
      };
    await writeResearchPlanChain(
      this.projects,
      params.projectId,
      { ...base, ...(profile !== undefined ? { surveyProfile: profile } : {}) },
      nextChain,
      existing?.executionHistory,
    );
    const active = nextChain.plans.find((candidate) => candidate.planId === nextChain.activePlanId)!;
    this.log(
      `[researcher] projectId=${params.projectId} 综述研究计划完成：queries=${plan.queries.length} questions=${plan.questions.length}${profile?.taxonomy !== undefined ? ` taxonomyIntent=${profile.taxonomy.families.length}` : ""}`,
    );
    return { plan: active, profile, taskId: task.taskId, regenerated: params.feedback !== undefined };
  }

  /**
   * M10.3：从文献库全文提出锚定证据候选（requirements 驱动；不检索）。
   *
   * 用户在 evidence-supply HITL 期间 promote 候选文献并获取全文后，本方法让
   * Researcher 用 retrieve_library / get_chunk 对 requirements 提出逐字锚定
   * 的证据候选（propose_evidence 工具或 JSON evidence 字段），进入三段核验
   * 管道（verified 才转正）。无全文可锚定 → 零候选（如实；覆盖缺口保留在
   * coverage 视图中，由 supply-query 链继续补）。
   */
  async proposeRevisionEvidence(params: {
    projectId: string;
    requirementDigest: string;
  }): Promise<{ evidenceProposed: number; evidenceAppended: number; taskId: string }> {
    const project = await this.projects.getRequired(params.projectId);
    const language = normalizeManuscriptLanguage(project.language);
    const sourceDigest = await this.buildSourceDigest(params.projectId);
    const task = await this.runtime.runAgent({
      agentId: this.agentId,
      ...this.timeoutOverride,
      task: [
        "你是一名学术研究员（Researcher）。论文修订需要外部文献证据：请只针对下面的证据需求，从项目文献库的全文中提出锚定证据候选（不检索新文献）。",
        "",
        "只输出一个 JSON 对象（不要 Markdown 围栏）：",
        "{",
        '  "evidence": [{"claim": "该证据支撑的论断", "summary": "摘要", "quote": "原文逐字引文",',
        '    "sourceId": "文献库条目 id（如 S001）", "chunkId": "retrieve_library 结果中的 CHUNK 标识",',
        '    "source": {"title": "标题", "authors": ["作者"], "year": 2024, "doi": "可选"},',
        '    "location": {"page": 1, "section": "4.2"}}]',
        "}",
        "",
        "要求：",
        "1. 用 retrieve_library 按需求主题检索文献库全文（结果带 CHUNK 标识），get_chunk 回取逐字原文，quote 必须从 chunk 原文逐字复制（不改写、不凭记忆生成）。",
        "2. 每条证据只支撑一个明确论断；与需求无关的证据不要提。宁缺毋滥：找不到足够支撑的需求如实留空，绝不编造 quote 或锚定不相关段落。",
        "3. 不调用任何搜索工具（不检索新文献）；只用已入库全文。无全文可检索的条目无法锚定——这是事实，不是错误。",
        "",
        "===== 证据需求（requirements）=====",
        params.requirementDigest,
        "",
        "===== 项目文献库摘要 =====",
        sourceDigest,
      ].join("\n"),
      projectId: params.projectId,
      contextScope: "research/revision-evidence",
      ...(language !== undefined ? { language } : {}),
      metadata: { role: "researcher", skill: "revision-evidence" },
    });
    if (task.status !== "completed") {
      throw new AgentRunFailedError(task.error ?? `锚定证据提案任务以 ${task.status} 状态结束`);
    }
    const parsed = extractJsonObject(task.output ?? "", "锚定证据提案");
    const candidates = readEvidenceCandidates(parsed);
    let evidenceAppended = 0;
    let evidenceProposed = 0;
    for (const candidate of candidates) {
      const anchored =
        this.evidenceGrounding !== undefined &&
        candidate.chunkId !== undefined &&
        candidate.quote !== undefined &&
        candidate.quote.trim() !== "";
      if (anchored) {
        try {
          const { deduplicated } = await this.evidenceGrounding!.propose(params.projectId, {
            sourceId: candidate.sourceId ?? candidate.chunkId!.split(":")[0]!,
            chunkId: candidate.chunkId!,
            claim: candidate.claim,
            quote: candidate.quote!,
            ...(candidate.summary !== undefined ? { summary: candidate.summary } : {}),
            proposedBy: "researcher",
          });
          if (!deduplicated) {
            evidenceProposed += 1;
          }
        } catch (error) {
          this.log(
            `[researcher] projectId=${params.projectId} 修订证据提案失败，降级 unverified 追加：${error instanceof Error ? error.message.slice(0, 200) : String(error)}`,
          );
          await this.evidence.append(params.projectId, toLegacyAppendInput(candidate), "researcher");
          evidenceAppended += 1;
        }
      } else {
        await this.evidence.append(params.projectId, toLegacyAppendInput(candidate), "researcher");
        evidenceAppended += 1;
      }
    }
    this.log(
      `[researcher] projectId=${params.projectId} 修订证据提案完成：proposed=${evidenceProposed} appended=${evidenceAppended}`,
    );
    return { evidenceProposed, evidenceAppended, taskId: task.taskId };
  }
}

/** research JSON 的 evidence 条目（M6.5：可携带 chunk 锚定字段） */
export interface ParsedEvidenceEntry extends EvidenceAppendInput {
  /** chunk 锚定（来自 retrieve_library 的 SRC/CHUNK 标记；两字段同时出现才走候选管道） */
  sourceId?: string;
  chunkId?: string;
}

export type ResearchArtifact = {
  generatedAt: string;
  taskId: string;
  /**
   * 活动计划（M8.1 一等产物；M8.3.1 起为 active 兼容视图——始终等于
   * plans 中 activePlanId 指向的条目，三者由同一写入口保持一致）。
   * 旧 artifact 无此字段——可选，读取端一律兼容（iteration 字段缺失时
   * 经 readPlanChain 归一化）。
   */
  plan?: StoredResearchPlan;
  /** 全部迭代轮次（M8.3.1；旧 artifact 无此字段，读取经 readPlanChain 兼容） */
  plans?: StoredResearchPlan[];
  /** 当前活动计划 id（M8.3.1；编辑 / 批准 / 执行都作用于它） */
  activePlanId?: string;
  /**
   * 计划执行记录（M8.2；ResearchPlanExecutionService 回填的最小历史）。
   * 可选字段：旧 artifact（M8.1 及更早）无此字段仍可读。M8.3.1 起
   * research() 重跑 / 论文理解重跑不再覆盖执行历史（merge strategy：
   * 用户可控与执行回填字段一律保留，只刷新报告侧字段）。
   */
  executionHistory?: PlanExecutionEntry[];
  /**
   * 研究缺口决策记录（M8.3.3；ResearchGapService 落盘的 accepted /
   * rejected 快照）。可选字段：旧 artifact 无此字段仍可读；proposed 是
   * 覆盖派生视图不落盘。重跑与计划链写盘均原样保留（用户决策优先）。
   */
  gaps?: ResearchGap[];
  /** 受控研究循环策略（M8.3.3；保存边界规则，不自动执行循环） */
  loopPolicy?: ResearchLoopPolicy;
  /**
   * 受控研究循环状态（M8.4；ResearchLoopService 落盘的状态机 + 轮次历史）。
   * 可选字段：旧 artifact 无此字段仍可读；重跑与计划链写盘均原样保留
   * （用户可控状态，与 gaps / loopPolicy 同纪律）。
   */
  loop?: ResearchLoopState;
  /**
   * Survey 研究画像（M11.1.4 topic_survey）：范围界定 + 初始 taxonomy 意图 +
   * 覆盖意图。可选字段：普通论文项目无此字段；计划链写盘经 ...artifact 展开
   * 原样保留（与 executionHistory 同纪律）。
   */
  surveyProfile?: SurveyResearchProfile;
  report: ResearchReport;
  evidence: ParsedEvidenceEntry[];
  bibliography: BibliographyEntryInput[];
};

export interface BibliographyEntryInput {
  key: string;
  title: string;
  authors?: string[];
  year?: number;
  doi?: string;
  url?: string;
  venue?: string;
}

/** 读取 research/research.json */
export async function readResearchArtifact(
  projects: ProjectStore,
  projectId: string,
): Promise<ResearchArtifact | null> {
  const { readFile } = await import("node:fs/promises");
  try {
    const raw = await readFile(join(projects.researchDir(projectId), "research.json"), "utf8");
    return JSON.parse(raw) as ResearchArtifact;
  } catch {
    return null;
  }
}

/**
 * 把计划链写回 research.json（M8.3.1 单一写入口）：plan 兼容视图 / plans /
 * activePlanId 三字段经 planChainFields 一次性产出，保证不漂移；artifact
 * 其余字段（report / evidence / bibliography / existing-paper 附加字段）原样
 * 保留。executionHistory 为空数组 / undefined 时不写字段（既有 artifact 上
 * 的历史经 ...artifact 展开天然保留，不会被意外清空）。
 */
export async function writeResearchPlanChain(
  projects: ProjectStore,
  projectId: string,
  artifact: ResearchArtifact,
  chain: ResearchPlanChain,
  executionHistory: PlanExecutionEntry[] | undefined,
): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    join(projects.researchDir(projectId), "research.json"),
    JSON.stringify(
      {
        ...artifact,
        ...planChainFields(chain),
        ...(executionHistory !== undefined && executionHistory.length > 0
          ? { executionHistory }
          : {}),
      },
      null,
      2,
    ) + "\n",
    "utf8",
  );
}

/**
 * 把研究循环状态写回 research.json（M8.3.3 单一写入口：gaps 决策记录 /
 * loopPolicy；M8.4 增补 loop 循环状态）。只覆盖传入的字段；artifact 其余
 * 字段（计划链 / 执行历史 / 报告侧）原样保留——调用方传入的 artifact 即
 * 磁盘现状，不做内存态改写，与 writeResearchPlanChain 的「其余字段
 * ...artifact 展开」同纪律。
 */
export async function writeResearchLoopState(
  projects: ProjectStore,
  projectId: string,
  artifact: ResearchArtifact,
  fields: { gaps?: ResearchGap[]; loopPolicy?: ResearchLoopPolicy; loop?: ResearchLoopState },
): Promise<void> {
  const { writeFile } = await import("node:fs/promises");
  await writeFile(
    join(projects.researchDir(projectId), "research.json"),
    JSON.stringify({ ...artifact, ...fields }, null, 2) + "\n",
    "utf8",
  );
}

/**
 * 编辑检索计划（M8.1 PUT /api/projects/:id/research/plan 的后端；M8.3.1 起
 * 作用于**活动计划**）：读 artifact → 校验输入 → 合并（同 queryId 保留执行
 * 回填的 resultCount）→ 链中原位替换活动条目 → 写回。
 * artifact 不存在 → NOT_FOUND（先跑调研才有 plan 可编辑）；旧 artifact 无
 * plan 字段时按「编辑即初始化」处理（draft 空计划起步 = 首轮 iteration 1，
 * 接受 questions / queries）。历史（非活动）计划不被编辑触碰。
 */
export async function updateResearchPlan(
  projects: ProjectStore,
  projectId: string,
  body: Record<string, unknown>,
): Promise<ResearchPlan> {
  const artifact = await readResearchArtifact(projects, projectId);
  if (artifact === null) {
    throw new BusinessError(
      "NOT_FOUND",
      "项目还没有调研结果（research/research.json 不存在），请先运行调研再编辑研究计划",
    );
  }
  const input = parseResearchPlanUpdateInput(body);
  const chain = readPlanChain(artifact);
  const active = chain.plans.find((plan) => plan.planId === chain.activePlanId);
  const base = active ?? createResearchPlan([], []);
  const updated = applyResearchPlanUpdate(base, input);
  const nextChain: ResearchPlanChain =
    active !== undefined
      ? {
          plans: chain.plans.map((plan) => (plan.planId === active.planId ? updated : plan)),
          activePlanId: chain.activePlanId,
        }
      : { plans: [updated], activePlanId: updated.planId };
  await writeResearchPlanChain(projects, projectId, artifact, nextChain, artifact.executionHistory);
  return updated;
}

/**
 * 需求驱动的供给检索（M9.9 Phase 3，POST /api/projects/:id/research/
 * requirements/supply-query 的后端）：读 artifact → 追加供给查询进活动计划
 * （requirementId linkage + rationale 可审计）→ 链中原位替换 → 写回。
 *
 * 只追加检索意图，**不执行**——执行走既有「批准 → POST /research/plan/
 * execute」显式链路（隐藏搜索禁令）；覆盖守卫（covered 需求拒绝）由
 * HTTP 层基于 Coverage Analyzer 派生结果执行，coverageStatus 仅进 rationale。
 */
export async function supplyRequirementQuery(
  projects: ProjectStore,
  projectId: string,
  body: Record<string, unknown>,
  coverageStatus: string,
): Promise<{ plan: ResearchPlan; query: ResearchPlanQuery }> {
  const artifact = await readResearchArtifact(projects, projectId);
  if (artifact === null) {
    throw new BusinessError(
      "NOT_FOUND",
      "项目还没有调研结果（research/research.json 不存在），请先运行调研再触发供给检索",
    );
  }
  const requirementId =
    typeof body["requirementId"] === "string" && body["requirementId"].trim() !== ""
      ? body["requirementId"].trim()
      : "";
  if (requirementId === "") {
    throw new BusinessError("INVALID_REQUEST", "请求体必须包含非空字符串字段 requirementId");
  }
  const query =
    typeof body["query"] === "string" && body["query"].trim() !== ""
      ? body["query"].trim()
      : undefined;
  const kind = body["kind"];
  if (kind !== undefined && kind !== "academic" && kind !== "web") {
    throw new BusinessError("INVALID_REQUEST", "字段 kind 只能是 academic / web");
  }
  const input: RequirementSupplyQueryInput = {
    requirementId,
    ...(query !== undefined ? { query } : {}),
    ...(kind !== undefined ? { kind } : {}),
  };
  const chain = readPlanChain(artifact);
  const active = chain.plans.find((plan) => plan.planId === chain.activePlanId);
  if (active === undefined) {
    throw new BusinessError(
      "NOT_FOUND",
      "项目还没有研究计划（research artifact 无 plan 字段），请先运行调研或编辑生成计划",
    );
  }
  const { plan, query: appended } = appendRequirementSupplyQuery(active, input, coverageStatus);
  const nextChain: ResearchPlanChain = {
    plans: chain.plans.map((entry) => (entry.planId === active.planId ? plan : entry)),
    activePlanId: chain.activePlanId,
  };
  await writeResearchPlanChain(projects, projectId, artifact, nextChain, artifact.executionHistory);
  return { plan, query: appended };
}

// ---- Prompt ----

export function buildResearchPrompt(
  project: ProjectMetadata,
  sourceDigest: string,
  extraInstructions?: string,
  /** 上一轮已落盘的 bibliography（M9.7.4：重跑时注入，抑制会话记忆驱动的单调膨胀） */
  previousBibliography?: BibliographyEntryInput[],
): string {
  return [
    "你是一名学术研究员（Researcher）。请对下面的研究 Idea 做领域调研与可行性预研。",
    "只输出一个 JSON 对象（不要 Markdown 围栏、不要解释文字），字段如下：",
    "{",
    '  "plan": {',
    '    "questions": ["本次调研要回答的研究问题 1", "..."],',
    '    "requirements": [{"topic": "未来正文需要证据支撑的主题（如某系统的机制刻画、某方向的对比）",',
    '      "claimType": "definition|mechanism|comparison|benchmark|limitation|background（正文论断类型）",',
    '      "expectedEvidenceType": "survey|original_paper|benchmark_paper|system_paper（需要的证据形态）",',
    '      "relatedSection": "预计落点章节（可选）", "priority": "high|medium|low", "note": "为什么需要（可选）"}],',
    '    "queries": [{"query": "检索词", "kind": "academic 或 web", "rationale": "为什么要做这条检索", "expectedCoverage": "期望覆盖的文献或信息面"}]',
    "  },",
    '  "domainOverview": "领域现状综述（200-500 字）",',
    '  "relatedWorkDirections": ["相关工作方向 1", "..."],',
    '  "researchGaps": ["研究空白 1", "..."],',
    '  "potentialContributions": ["潜在贡献 1", "..."],',
    '  "researchQuestions": ["研究问题 1", "..."],',
    '  "literaturePlan": ["本次检索仍未覆盖、建议后续人工补充的文献方向（残差）1", "..."],',
    '  "evidence": [{"claim": "该证据支撑的观点", "summary": "证据摘要", "quote": "原文逐字引文",',
    '    "sourceId": "文献库条目 id（如 S001）", "chunkId": "retrieve_library 结果中的 CHUNK 标识",',
    '    "source": {"title": "来源文献标题", "authors": ["作者"], "year": 2024, "doi": "可选", "url": "可选"},',
    '    "location": {"page": 1, "section": "4.2"}}],',
    '  "bibliography": [{"key": "zhang2024survey", "title": "标题", "authors": ["作者"], "year": 2024, "doi": "可选", "venue": "可选"}]',
    "}",
    "",
    "要求：",
    "0. 先计划后调研：plan 是检索计划（ResearchPlan）——在检索前制定，列出研究问题、预写证据需求与你打算执行的检索词及理由，用于指导本次检索；其余字段（domainOverview 到 bibliography）是调研报告（ResearchReport）——在检索完成后综合研究结果得出。两者不要混淆：plan.queries 写的是你实际打算（或已经）执行的检索及其理由，不是调研结论；plan.questions 与 report.researchQuestions 可以呼应但职责不同（前者指导检索，后者是调研后的结论问题）。",
    "0a. 需求先行（requirements）：plan.requirements 是「预写证据需求」——站在未来正文的立场，先于检索列出成稿必须能做出的论断及其主题（claimType：定义 / 机制 / 对比 / 基准 / 局限 / 背景），并注明需要的证据形态（expectedEvidenceType）。制定后必须驱动检索词生成：每条 high / medium 需求至少对应一条主题相关的 query（如需求「智能体记忆机制机制刻画」应产生 memory / 记忆管理相关检索词）。只列真实需要的需求（≤12 条，宁缺毋滥）；检索无法满足某条需求时不凑数、不自行降级——如实把该缺口写入 researchGaps / literaturePlan，绝不为了填需求编造证据或锚定到不相关段落。",
    "1. 检索优先：研究型问题（领域现状、相关工作、研究空白、方法对比等）先用 search_papers 检索外部文献（可用 yearFrom/yearTo 聚焦近年，如最近三年），需要 Web 线索时用 search_web，对单篇论文存疑时用 lookup_paper 核验；简单问题（常识、定义、项目内信息）可直接回答，不必检索。禁止凭记忆断言论文的存在性、年份或 venue——文献类事实必须以检索结果为准，检索结果要原样引用，不得凭记忆补充。外部检索单次耗时约 1-10 秒；diagnostics 出现 partial（部分检索源失败）属常态，结果仍可用，不要因 partial 重试。",
    "2. 调研中发现的重要文献，用 save_candidates 保存为项目候选文献（kind 与 query 必须和检索时完全一致，按结果 index 选择；本次调研合计保存不超过 20 条，按与课题的相关性遴选）。保存的候选只是线索（pending_review），需用户审核转正后才进入文献库；已检索覆盖的方向不要写进 literaturePlan（它只记录检索后仍缺失的残差）。",
    "3. evidence 只包含你能给出明确来源（文献库条目或确凿的公开文献）的事实；来源不充分的不要写入 evidence。",
    "4. 锚定证据路径：文献库摘要中标注「全文：已入库」的条目，用 retrieve_library 按主题检索原文段落（结果带 CHUNK 标识），用 get_chunk 回取逐字原文。对调研结论中需要文献支撑的关键论断，当文献库有可检索全文时，优先提出锚定证据：调用 propose_evidence（claim + sourceId + chunkId + 从 chunk 原文逐字复制的 quote），或在最终 evidence 条目中附上 sourceId、chunkId 与逐字 quote（quote 不要改写、不要凭记忆生成）——这类证据会进入核验管道成为已核验证据。已通过 propose_evidence 工具提交过的证据不要在 evidence 字段里重复。是否提出证据由你的研究判断决定，不设数量指标；但项目已有可检索全文时，关键论断应优先尝试锚定，而不是只依赖摘要或检索元数据。检索后仍找不到足够支撑材料时，如实记为证据不足（写入 researchGaps / literaturePlan），绝不编造 quote 或锚定到不相关的段落。无法锚定到文献库 chunk 的证据保持原格式（只记为未核验线索）。",
    "5. bibliography 的 key 使用「第一作者年份主题」格式（如 zhang2024survey），全小写字母数字（key 仅作占位：最终 citation key 由系统按文献身份确定性生成并统一重排，你的 key 不会直接进入论文）。bibliography 只列与本课题最相关的文献，总量控制在 30 条以内——它不是领域全目录，宁缺毋滥。",
    ...(previousBibliography !== undefined && previousBibliography.length > 0
      ? [
          `上一轮调研已列出 ${previousBibliography.length} 条参考文献（title | year）：`,
          ...previousBibliography
            .slice(0, 30)
            .map((entry) => `- ${entry.title}${entry.year !== undefined ? ` | ${entry.year}` : ""}`),
          "本轮 bibliography 以上一轮清单为基础：确属课题核心的可保留（元数据可修正），仅补充本轮真实新发现的重要文献；同一文献不要以不同 key / 不同年份形态重复出现，总量不得超出上一轮明显增长。",
        ]
      : []),
    "6. 你不负责写论文正文。",
    "",
    "===== 项目信息 =====",
    `标题：${project.title}`,
    `研究 Idea：${project.researchIdea ?? "（未填写，请依据标题理解）"}`,
    `研究领域：${project.researchField ?? "（未填写）"}`,
    `目标类型：${project.documentType ?? "（未填写）"}`,
    `目标档次：${project.targetProfile ?? "（未填写）"}`,
    `目标 Venue：${project.targetVenue ?? "（未填写）"}`,
    ...targetLanguageLines(normalizeManuscriptLanguage(project.language)),
    "",
    "===== 项目文献库摘要 =====",
    sourceDigest,
    ...(extraInstructions
      ? ["", "===== 用户补充说明 =====", extraInstructions]
      : []),
  ].join("\n");
}

/** 全文可检索（M9.4）：解析成功（available/partial）意味着 chunk 已入库，retrieve_library 可锚定 */
function hasRetrievableFullText(item: SourceItem): boolean {
  return item.status === "available" || item.status === "partial";
}

function describeSource(item: SourceItem): string {
  const meta = item.metadata;
  const parts = [
    `- [${item.sourceId}] ${meta.title ?? item.fileName}`,
    meta.authors?.length ? `作者：${meta.authors.slice(0, 4).join(", ")}` : undefined,
    meta.year !== undefined ? `年份：${meta.year}` : undefined,
    meta.doi ? `DOI：${meta.doi}` : undefined,
    hasRetrievableFullText(item) ? "全文：已入库（可检索锚定）" : "全文：未入库（仅元数据）",
    item.analysis?.status === "ok" || item.analysis?.status === "partial"
      ? `摘要：${(item.analysis.textPreview ?? "").slice(0, 400)}`
      : undefined,
  ].filter((part): part is string => part !== undefined);
  return parts.join("；");
}

function readEvidenceCandidates(parsed: Record<string, unknown>): ParsedEvidenceEntry[] {
  const value = parsed["evidence"];
  if (!Array.isArray(value)) {
    return [];
  }
  const candidates: ParsedEvidenceEntry[] = [];
  for (const raw of value.slice(0, 50)) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const record = raw as Record<string, unknown>;
    const claim = typeof record["claim"] === "string" ? record["claim"].trim() : "";
    if (claim === "") {
      continue; // 无 claim 的候选直接丢弃（校验层也会拒绝）
    }
    const source = record["source"];
    const sourceRef =
      typeof source === "object" && source !== null ? (source as Record<string, unknown>) : undefined;
    const location = record["location"];
    const locationRef =
      typeof location === "object" && location !== null ? (location as Record<string, unknown>) : undefined;
    // M6.5 chunk 锚定字段（可选）：来自 retrieve_library 返回的引用标记
    const anchorSourceId =
      typeof record["sourceId"] === "string" && record["sourceId"].trim() !== ""
        ? record["sourceId"].trim()
        : undefined;
    const anchorChunkId =
      typeof record["chunkId"] === "string" && record["chunkId"].trim() !== ""
        ? record["chunkId"].trim()
        : undefined;
    candidates.push({
      claim,
      ...(typeof record["summary"] === "string" ? { summary: record["summary"] } : {}),
      ...(typeof record["quote"] === "string" ? { quote: record["quote"] } : {}),
      ...(anchorSourceId !== undefined ? { sourceId: anchorSourceId } : {}),
      ...(anchorChunkId !== undefined ? { chunkId: anchorChunkId } : {}),
      ...(sourceRef !== undefined
        ? {
            source: {
              ...(typeof sourceRef["title"] === "string" ? { title: sourceRef["title"] } : {}),
              ...(readOptionalStringArray(sourceRef, "authors") !== undefined
                ? { authors: readOptionalStringArray(sourceRef, "authors") }
                : {}),
              ...(typeof sourceRef["year"] === "number" ? { year: sourceRef["year"] } : {}),
              ...(typeof sourceRef["doi"] === "string" ? { doi: sourceRef["doi"] } : {}),
              ...(typeof sourceRef["url"] === "string" ? { url: sourceRef["url"] } : {}),
            },
          }
        : {}),
      ...(locationRef !== undefined
        ? {
            location: {
              ...(typeof locationRef["page"] === "number" ? { page: locationRef["page"] } : {}),
              ...(typeof locationRef["section"] === "string" ? { section: locationRef["section"] } : {}),
            },
          }
        : {}),
    });
  }
  return candidates;
}

/** 候选条目 → legacy EvidenceAppendInput（剔除锚定字段） */
function toLegacyAppendInput(candidate: ParsedEvidenceEntry): EvidenceAppendInput {
  const { sourceId: _sourceId, chunkId: _chunkId, ...legacy } = candidate;
  return legacy;
}

export function readBibliography(parsed: Record<string, unknown>): BibliographyEntryInput[] {
  const value = parsed["bibliography"];
  if (!Array.isArray(value)) {
    return [];
  }
  const entries: BibliographyEntryInput[] = [];
  for (const raw of value.slice(0, 50)) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const record = raw as Record<string, unknown>;
    const key = typeof record["key"] === "string" ? record["key"].trim() : "";
    const title = typeof record["title"] === "string" ? record["title"].trim() : "";
    if (key === "" || title === "" || !/^[a-zA-Z0-9_-]{2,64}$/.test(key)) {
      continue; // 非法 key 直接丢弃
    }
    entries.push({
      key,
      title,
      ...(readOptionalStringArray(record, "authors") !== undefined
        ? { authors: readOptionalStringArray(record, "authors") }
        : {}),
      ...(typeof record["year"] === "number" ? { year: record["year"] } : {}),
      ...(typeof record["doi"] === "string" ? { doi: record["doi"] } : {}),
      ...(typeof record["url"] === "string" ? { url: record["url"] } : {}),
      ...(typeof record["venue"] === "string" ? { venue: record["venue"] } : {}),
    });
  }
  // key 去重 + 同文献跨形态去重（M9.7.4：同一论文以不同 key / 不同 title 写法
  // 重复出现时折叠——归一标题+年份精确判等，先出现者保留（LLM 输出序=相关性序））
  const seen = new Set<string>();
  const seenTitleYear = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.key)) {
      return false;
    }
    seen.add(entry.key);
    const titleYearKey = `${compactTitle(entry.title)}|${entry.year ?? "?"}`;
    if (seenTitleYear.has(titleYearKey)) {
      return false;
    }
    seenTitleYear.add(titleYearKey);
    return true;
  });
}

// ---- M10.3：Existing-Paper 修订研究规划 ----

/**
 * 修订研究计划 prompt（只规划不检索：requirements 驱动 queries；
 * 检索在用户批准计划后由 research.execute 执行）。
 */
export function buildRevisionResearchPrompt(input: {
  title: string;
  targetProfile?: string;
  analysisDigest: string;
  externalInstructionDigest?: string;
  authorGoal?: string;
  feedback?: string;
}): string {
  return [
    "你是一名学术研究员（Researcher）。这篇论文即将做 evidence-grounded 修订：请为「需要新增或补强外部文献支撑的位置」制定一份修订研究计划（只规划，不检索）。",
    "",
    "只输出一个 JSON 对象（不要 Markdown 围栏、不要解释文字）：",
    "{",
    '  "plan": {',
    '    "questions": ["修订需要回答的研究问题（如：近年 MOT 关联方法中与本方法最相关的对比基线是什么）"],',
    '    "requirements": [{"topic": "正文修订需要外部文献支撑的主题",',
    '      "claimType": "definition|mechanism|comparison|benchmark|limitation|background",',
    '      "expectedEvidenceType": "survey|original_paper|benchmark_paper|system_paper",',
    '      "relatedSection": "预计落点章节（可选）", "priority": "high|medium|low", "note": "为什么需要（可选）"}],',
    '    "queries": [{"query": "检索词", "kind": "academic 或 web", "rationale": "对应的修订需要", "expectedCoverage": "期望覆盖面"}]',
    "  }",
    "}",
    "",
    "要求：",
    "1. requirement-driven：requirements 是「预写证据需求」——只覆盖需要外部文献/公开科学事实支撑的修订（related work 补强、对其他方法的事实描述、对比定位、领域背景）。作者自身实验数据、板端测量、负面结果不是文献需求，绝不写入 requirements。",
    "2. 每条 high/medium requirement 至少对应一条主题相关的 query；没有文献缺口时宁少勿滥（可以只有 1-2 条需求）。",
    "3. 不要在规划阶段执行检索（不调用任何搜索工具）；检索词留给后续批准后的执行阶段。",
    "4. queries 总量 ≤ 8 条（修订补强不是重新调研整个领域）。",
    ...(input.feedback !== undefined ? ["", "用户对上一版计划的反馈（据此重订）：", input.feedback] : []),
    "",
    `论文标题：${input.title}`,
    `目标档次：${input.targetProfile ?? "未指定"}`,
    ...(input.authorGoal !== undefined ? ["", "===== 作者修订目标 =====", input.authorGoal] : []),
    ...(input.externalInstructionDigest !== undefined
      ? ["", "===== 外部修改意见（涉及文献需求的部分）=====", input.externalInstructionDigest]
      : []),
    "",
    "===== 论文理解摘要 =====",
    input.analysisDigest,
  ].join("\n");
}

/** 建立 / 替换单计划链（revision 场景首轮即 iteration 1；draft 状态等待批准） */
function replaceDraftChain(plan: ResearchPlan): ResearchPlanChain {
  return { plans: [plan], activePlanId: plan.planId };
}

// ---- M11.1.4：topic_survey 综述研究规划 ----

/**
 * 综述研究计划 prompt（survey 语义，只规划不检索）。
 * 与 idea / revision 规划的关键差异写在指令里：目标是系统性梳理已有文献，
 * 不提出原创研究 idea、不写 potential contribution / 实验可行性；
 * seminal / representative / recent / temporal 覆盖意图直接体现在检索词。
 */
export function buildSurveyPlanPrompt(input: {
  title: string;
  scopeDigest: string;
  feedback?: string;
}): string {
  return [
    "你是一名学术研究员（Researcher）。用户要对下面这个主题做一篇学术综述（survey / review article）。请制定综述研究计划（只规划，不检索）。",
    "",
    "只输出一个 JSON 对象（不要 Markdown 围栏、不要解释文字）：",
    "{",
    '  "plan": {',
    '    "questions": ["综述要回答的研究问题（如：该主题的方法体系如何划分、各路线的取舍与演进、公认结论与争议、研究空缺）"],',
    '    "queries": [{"query": "检索词（英文为主，覆盖面互相补充）", "kind": "academic 或 web",',
    '      "rationale": "对应哪个研究问题 / 覆盖意图", "expectedCoverage": "期望覆盖面"}]',
    "  },",
    '  "surveyProfile": {',
    '    "scope": "综述范围界定（一句话：覆盖什么、不覆盖什么）",',
    '    "taxonomy": {"families": [{"label": "方法家族标签（英文 snake_case，如 motion_based）",',
    '      "description": "该家族的界定（一句话）", "subFamilies": ["可选：子家族标签"]}]},',
    '    "coverageIntent": {"seminal": ["应覆盖的奠基 / 代表性工作（标题或主题线索）"],',
    '      "dimensions": ["比较维度（如 assumption / computational cost / 适用场景）"],',
    '      "yearsNote": "时间覆盖说明（如以近十年为主，兼顾奠基工作）"}',
    "  }",
    "}",
    "",
    "要求：",
    "1. 这是综述，不是新研究：不要提出原创研究 idea、不要写 potential contribution / 实验设计 / 可行性——计划只服务于「把该主题的已有文献系统性地找全、看清」。",
    "2. 检索词设计要覆盖三类意图：奠基工作（seminal）、各方法路线的代表性工作（representative）、近期进展（recent）；时间意图写进 rationale。",
    "3. queries 总量 6-10 条、彼此覆盖面互补（按方法家族 / 综述线索 / 基准与评测 / 近期进展分摊）；kind=web 只用于找综述线索页 / 资源页（≤2 条）。",
    "4. taxonomy.families 是「这个主题下预期能把文献分成几类」的初始词表（5-10 个 family）；检索后由 Matrix 构建实际归类，词表不合适会由人工修正。",
    "5. 不调用任何搜索工具（检索在计划批准后执行）。",
    ...(input.feedback !== undefined ? ["", "用户对上一版计划的反馈（据此重订）：", input.feedback] : []),
    "",
    `综述主题：${input.title}`,
    "",
    "===== 主题与用户要求摘要 =====",
    input.scopeDigest,
  ].join("\n");
}
