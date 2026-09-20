/**
 * ResearchPlan Iteration Service（M8.3.1：Research Iteration Foundation）。
 *
 * 真实科研是「计划 → 检索 → 发现知识缺口 → 调整方向 → 新计划」的多轮过程。
 * 本服务把该过程建模为计划链（plans + activePlanId，挂 research artifact
 * 顶层）：从完成的计划派生下一轮（derive）、切换当前活动计划（activate）、
 * 列出全部迭代（list）。
 *
 * 冻结规则（M8 架构）全部遵守：
 * - 不新增 Agent：纯 Service（与 ResearchPlanExecutionService 同风格），
 *   不调用 Runtime.runAgent、无 prompt；
 * - 不修改 Runtime / Workflow Orchestrator：不进 workflowServices，
 *   迭代是 research.json 数据模型能力，与 Workflow 生命周期正交；
 * - 不引入 RAG / Vector DB / MCP / 新 Provider / CLI：只做 research.json
 *   读改写（经 ResearcherService 的单一写入口 writeResearchPlanChain）；
 * - Evidence 不变量：派生 / 切换只搬移计划数据，不触碰 CandidateStore /
 *   SourceStore / EvidenceStore——Search Result ≠ Candidate ≠ Literature ≠
 *   Verified Evidence 链路原样。
 *
 * 语义要点：
 * - derive 只允许从 done 计划派生（生命周期保持线性：旧计划永不被改写）；
 *   派生计划自动成为活动计划（批准 / 执行 / 编辑始终作用于活动计划）；
 * - iterationNumber = 链内最大值 + 1（与来源无关，杜绝同号）；
 * - activate 幂等：切到已是活动的计划不写盘。
 */

import { BusinessError } from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import {
  buildDerivedPlan,
  maxIterationNumber,
  parseResearchPlanDeriveInput,
  readPlanChain,
  type ResearchPlan,
  type ResearchPlanChain,
} from "./researchPlan.js";
import {
  readResearchArtifact,
  writeResearchPlanChain,
  type ResearchArtifact,
} from "./ResearcherService.js";

export interface ResearchPlanIterationServiceOptions {
  projects: ProjectStore;
  log?: (message: string) => void;
}

export class ResearchPlanIterationService {
  private readonly projects: ProjectStore;
  private readonly log: (message: string) => void;

  constructor(options: ResearchPlanIterationServiceOptions) {
    this.projects = options.projects;
    this.log = options.log ?? (() => {});
  }

  /**
   * 列出全部迭代轮次（GET /research/plans）。无 artifact / 无计划 → 空链
   * （空态而非 404，与 GET /research/plan 的 plan:null 语义一致）。
   */
  async list(projectId: string): Promise<ResearchPlanChain> {
    const artifact = await readResearchArtifact(this.projects, projectId);
    return artifact === null ? { plans: [], activePlanId: undefined } : readPlanChain(artifact);
  }

  /**
   * 从完成的计划派生下一轮（POST /research/plan/:planId/derive）：
   * - 无 artifact / 无计划链 / planId 不存在 → 404；来源非 done → 409；
   *   请求体非法（空 query / 非法 kind / 携带 queryId / status）→ 400；
   * - 新计划 status=draft、parentPlanId=来源、iterationNumber=链内最大+1、
   *   iterationId 继承来源；questions / queries 缺省整拷来源（检索条目重置
   *   planned、丢弃 resultCount、重新分配 queryId），提供则覆盖；
   * - 来源计划保持 done 原样不动；新计划自动成为活动计划。
   */
  async derive(
    projectId: string,
    planId: string,
    body: Record<string, unknown>,
  ): Promise<ResearchPlan> {
    const { artifact, chain } = await this.loadChainOrThrow(projectId);
    const input = parseResearchPlanDeriveInput(body);
    const source = chain.plans.find((plan) => plan.planId === planId);
    if (source === undefined) {
      throw new BusinessError(
        "NOT_FOUND",
        `计划 ${planId} 不存在（可先 GET /research/plans 查看全部迭代）`,
      );
    }
    if (source.status !== "done") {
      throw new BusinessError(
        "PLAN_INVALID_STATE",
        `只有已完成（done）的计划才能派生下一轮（当前 ${source.status}）`,
      );
    }
    const derived = buildDerivedPlan(source, maxIterationNumber(chain.plans) + 1, input);
    const nextChain: ResearchPlanChain = {
      plans: [...chain.plans, derived],
      activePlanId: derived.planId,
    };
    await writeResearchPlanChain(this.projects, projectId, artifact, nextChain, artifact.executionHistory);
    this.log(
      `[plan-iteration] projectId=${projectId} 派生新计划：parent=${source.planId} iteration=${derived.iterationNumber} planId=${derived.planId}（已设为活动计划）`,
    );
    return derived;
  }

  /**
   * 切换当前活动计划（POST /research/plan/:planId/activate）：编辑 / 批准 /
   * 执行始终作用于活动计划，activate 是查看与继续历史迭代的入口。
   * planId 不存在 → 404；已是活动计划 → 幂等返回不写盘。
   */
  async activate(projectId: string, planId: string): Promise<ResearchPlan> {
    const { artifact, chain } = await this.loadChainOrThrow(projectId);
    const target = chain.plans.find((plan) => plan.planId === planId);
    if (target === undefined) {
      throw new BusinessError(
        "NOT_FOUND",
        `计划 ${planId} 不存在（可先 GET /research/plans 查看全部迭代）`,
      );
    }
    if (chain.activePlanId === planId) {
      return target;
    }
    await writeResearchPlanChain(
      this.projects,
      projectId,
      artifact,
      { plans: chain.plans, activePlanId: planId },
      artifact.executionHistory,
    );
    this.log(
      `[plan-iteration] projectId=${projectId} 切换活动计划：${chain.activePlanId} → ${planId}`,
    );
    return target;
  }

  /** 读 artifact + 计划链；缺 artifact（未调研）/ 缺计划（旧 artifact）→ 404 */
  private async loadChainOrThrow(
    projectId: string,
  ): Promise<{ artifact: ResearchArtifact; chain: ResearchPlanChain }> {
    const artifact = await readResearchArtifact(this.projects, projectId);
    if (artifact === null) {
      throw new BusinessError(
        "NOT_FOUND",
        "项目还没有调研结果（research/research.json 不存在），请先运行调研",
      );
    }
    const chain = readPlanChain(artifact);
    if (chain.plans.length === 0) {
      throw new BusinessError(
        "NOT_FOUND",
        "项目还没有研究计划（research artifact 无 plan 字段），请先运行调研或编辑生成计划",
      );
    }
    return { artifact, chain };
  }
}
