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
import type { AgentRuntime } from "../runtime/types.js";
import type { EvidenceAppendInput, EvidenceStore } from "../evidence/EvidenceStore.js";
import type { EvidenceGroundingService } from "../evidence/EvidenceGroundingService.js";
import type { SourceStore, SourceItem } from "../sources/SourceStore.js";
import {
  applyResearchPlanUpdate,
  createResearchPlan,
  parseResearchPlan,
  parseResearchPlanUpdateInput,
  planChainFields,
  readPlanChain,
  resolvePlanChainOnRerun,
  type ResearchPlan,
  type ResearchPlanChain,
  type StoredResearchPlan,
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
    const sourceDigest = await this.buildSourceDigest(params.projectId);

    const task = await this.runtime.runAgent({
      agentId: this.agentId,
      ...this.timeoutOverride,
      task: buildResearchPrompt(project, sourceDigest, params.extraInstructions),
      projectId: params.projectId,
      contextScope: "research",
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
    const existing = await readResearchArtifact(this.projects, params.projectId);
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
      `[researcher] projectId=${params.projectId} 调研完成：gaps=${report.researchGaps.length} plan=${plan !== undefined ? `${plan.queries.length} queries` : "none"} evidence=appended:${evidenceAppended}/proposed:${evidenceProposed} bibliography=${artifact.bibliography.length}`,
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

  /** 汇总项目文献库（供 Prompt 注入；只提供已解析摘要，不塞原始全文） */
  private async buildSourceDigest(projectId: string): Promise<string> {
    const items = await this.sources.list(projectId);
    const usable = items.filter(
      (item) => item.sourceRole !== "reference" && item.status !== "failed" && item.status !== "pending",
    );
    if (usable.length === 0) {
      return "（项目文献库当前为空：请先用 search_papers 检索相关文献，基于检索结果给出调研方向，并用 save_candidates 保存重要候选）";
    }
    const lines = usable.slice(0, 20).map((item) => describeSource(item));
    return [`项目文献库（${usable.length} 项）：`, ...lines].join("\n");
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

// ---- Prompt ----

export function buildResearchPrompt(
  project: ProjectMetadata,
  sourceDigest: string,
  extraInstructions?: string,
): string {
  return [
    "你是一名学术研究员（Researcher）。请对下面的研究 Idea 做领域调研与可行性预研。",
    "只输出一个 JSON 对象（不要 Markdown 围栏、不要解释文字），字段如下：",
    "{",
    '  "plan": {',
    '    "questions": ["本次调研要回答的研究问题 1", "..."],',
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
    "0. 先计划后调研：plan 是检索计划（ResearchPlan）——在检索前制定，列出研究问题与你打算执行的检索词及理由，用于指导本次检索；其余字段（domainOverview 到 bibliography）是调研报告（ResearchReport）——在检索完成后综合研究结果得出。两者不要混淆：plan.queries 写的是你实际打算（或已经）执行的检索及其理由，不是调研结论；plan.questions 与 report.researchQuestions 可以呼应但职责不同（前者指导检索，后者是调研后的结论问题）。",
    "1. 检索优先：研究型问题（领域现状、相关工作、研究空白、方法对比等）先用 search_papers 检索外部文献（可用 yearFrom/yearTo 聚焦近年，如最近三年），需要 Web 线索时用 search_web，对单篇论文存疑时用 lookup_paper 核验；简单问题（常识、定义、项目内信息）可直接回答，不必检索。禁止凭记忆断言论文的存在性、年份或 venue——文献类事实必须以检索结果为准，检索结果要原样引用，不得凭记忆补充。外部检索单次耗时约 1-10 秒；diagnostics 出现 partial（部分检索源失败）属常态，结果仍可用，不要因 partial 重试。",
    "2. 调研中发现的重要文献，用 save_candidates 保存为项目候选文献（kind 与 query 必须和检索时完全一致，按结果 index 选择；本次调研合计保存不超过 20 条，按与课题的相关性遴选）。保存的候选只是线索（pending_review），需用户审核转正后才进入文献库；已检索覆盖的方向不要写进 literaturePlan（它只记录检索后仍缺失的残差）。",
    "3. evidence 只包含你能给出明确来源（文献库条目或确凿的公开文献）的事实；来源不充分的不要写入 evidence。",
    "4. 优先用 retrieve_library 检索项目文献库、get_chunk 核对原文；来自文献库的证据请在 evidence 条目中附上 sourceId、chunkId 与从原文逐字复制的 quote（不要改写）——这类证据会进入核验管道成为已核验证据。已通过 propose_evidence 工具提交过的证据不要在 evidence 字段里重复。无法锚定到文献库 chunk 的证据保持原格式（只记为未核验线索）。",
    "5. bibliography 的 key 使用「第一作者年份主题」格式（如 zhang2024survey），全小写字母数字。",
    "6. 你不负责写论文正文。",
    "",
    "===== 项目信息 =====",
    `标题：${project.title}`,
    `研究 Idea：${project.researchIdea ?? "（未填写，请依据标题理解）"}`,
    `研究领域：${project.researchField ?? "（未填写）"}`,
    `目标类型：${project.documentType ?? "（未填写）"}`,
    `目标档次：${project.targetProfile ?? "（未填写）"}`,
    `目标 Venue：${project.targetVenue ?? "（未填写）"}`,
    "",
    "===== 项目文献库摘要 =====",
    sourceDigest,
    ...(extraInstructions
      ? ["", "===== 用户补充说明 =====", extraInstructions]
      : []),
  ].join("\n");
}

function describeSource(item: SourceItem): string {
  const meta = item.metadata;
  const parts = [
    `- [${item.sourceId}] ${meta.title ?? item.fileName}`,
    meta.authors?.length ? `作者：${meta.authors.slice(0, 4).join(", ")}` : undefined,
    meta.year !== undefined ? `年份：${meta.year}` : undefined,
    meta.doi ? `DOI：${meta.doi}` : undefined,
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

function readBibliography(parsed: Record<string, unknown>): BibliographyEntryInput[] {
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
  // key 去重
  const seen = new Set<string>();
  return entries.filter((entry) => {
    if (seen.has(entry.key)) {
      return false;
    }
    seen.add(entry.key);
    return true;
  });
}
