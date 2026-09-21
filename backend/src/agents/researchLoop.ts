/**
 * Controlled Research Loop Service（M8.4：Controlled Multi-round Research
 * Executor）。
 *
 * 把 M8.1（Research Plan）/ M8.2（Plan Execution）/ M8.3.1（Iteration）/
 * M8.3.2（Coverage）/ M8.3.3（Research Gap + HITL）编排成真正可运行的
 * 受控研究循环：
 *
 *   Research Plan → Plan Approval HITL → Execute → Coverage
 *   → Loop Policy Evaluation → Research Gap → Human Decision
 *   → Derive Next Plan → 等待下一次 Approval → …
 *
 * 冻结规则（M8 架构）全部遵守：
 * - 不新增 Agent：纯 Service + 纯函数，不调用 Runtime.runAgent、无 prompt；
 * - 不修改 Runtime / Workflow Orchestrator：不进 workflowServices，循环是
 *   用户经 HTTP 显式驱动的 research.json 数据操作，与 Workflow 生命周期正交；
 * - 不引入 RAG / Vector DB / MCP / 新 Provider / CLI；
 * - Evidence 链路原样：Loop 只做状态编排——检索（planExecution→Discovery）、
 *   覆盖（coverage）、缺口（gaps）、派生（planIteration）全部**委托**既有
 *   服务，不在本文件复制任何一条业务逻辑；Search Result ≠ Candidate ≠
 *   Literature ≠ Verified Evidence 分层不混写。
 *
 * HITL 边界（循环的真实断点，全部等待用户、绝不自动推进）：
 * - draft → approve 不自动发生（approvePlan 是用户显式入口，委托 M8.2 单一
 *   流转；Loop 永不自行调用 approve）；
 * - accept / reject gap 不自动发生（Loop 只**读取**缺口决策视图，缺口确认
 *   走既有 M8.3.3 API）；
 * - derive 后不自动执行（deriveNextPlan 委托 M8.3.3 派生后即停在
 *   awaiting_plan_approval，下一轮批准仍是用户动作）。
 *
 * 状态机（status）：
 * - awaiting_plan_approval：start 之后 / derive 之后——等待用户批准计划；
 * - running：轮次执行中（execute → coverage；磁盘可见性标记，进程崩溃后由
 *   resume 按 research.json 事实重算续跑点）；
 * - awaiting_gap_decision：轮次完成且策略允许继续——等待用户对缺口做
 *   accept / reject 并经 derive-next 派生下一轮；
 * - awaiting_retry：轮次被可恢复错误打断（BusinessError，如执行残留
 *   executing）——用户排除后 resume 重试；
 * - failed：轮次被非业务异常打断——resume 可重试或 cancel 终止；
 * - completed：策略停止条件命中或无缺口可决策（终态，带 stopReason）；
 * - cancelled：用户显式终止（终态）。
 *
 * Loop Policy 真实消费（ResearchLoopPolicy，M8.3.3 预注册的边界）：
 * - maxQueriesPerIteration：批准检查点硬校验——draft 计划的 planned 检索数
 *   超限 → 409 LOOP_POLICY_VIOLATION（编辑计划后再批，不静默截断）；
 * - maxTotalQueries（M8.4 最小扩展）：整个循环的检索预算——按轮次执行记录
 *   的 executed + failed **真实计数**（不伪造 token 成本）；批准前校验剩余
 *   预算，轮后校验消耗即停（budget_exceeded）；
 * - maxIterations：以计划链（iterationId 线索）的真实最大迭代号判定——
 *   链内已有轮数达到上限 → completed（iteration_limit）；
 * - no_new_coverage：本轮 covered 不多于上一轮（首轮豁免——首轮建立基线）
 *   → completed（no_new_coverage）；
 * - stopConditions 是声明式开关：未列出的条件不参与判定。
 *
 * 持久化：research.json 顶层可选 `loop` 字段（经 writeResearchLoopState 单一
 * 写入口；与 gaps / loopPolicy 同纪律——research() 重跑与 existing-paper 重跑
 * 原样保留）。轮次历史（rounds）随状态落盘，崩溃恢复（resume）只依据磁盘
 * 事实（计划链状态 + executionHistory + loop 快照）重算，不依赖进程内存。
 */

import { randomUUID } from "node:crypto";

import { BusinessError } from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { ResearchCoverageService } from "./researchCoverage.js";
import type { ResearchGapService } from "./researchGap.js";
import {
  readResearchLoopPolicyFrom,
  type ResearchLoopPolicy,
} from "./researchLoopPolicy.js";
import {
  maxIterationNumber,
  readPlanChain,
  type ResearchPlan,
} from "./researchPlan.js";
import type { PlanExecutionEntry, ResearchPlanExecutionService } from "./researchPlanExecution.js";
import {
  readResearchArtifact,
  writeResearchLoopState,
  type ResearchArtifact,
} from "./ResearcherService.js";

// ---- 领域模型 ----

export type ResearchLoopStatus =
  | "running"
  | "awaiting_plan_approval"
  | "awaiting_gap_decision"
  | "awaiting_retry"
  | "completed"
  | "cancelled"
  | "failed";

export const RESEARCH_LOOP_STATUSES: readonly ResearchLoopStatus[] = [
  "running",
  "awaiting_plan_approval",
  "awaiting_gap_decision",
  "awaiting_retry",
  "completed",
  "cancelled",
  "failed",
];

/**
 * 完成原因（completed 的落盘快照）：
 * - no_open_gaps：结构完成——覆盖分析无缺口可决策（不依赖策略开关）；
 * - iteration_limit / budget_exceeded / no_new_coverage：策略停止条件命中
 *   （仅在 policy.stopConditions 声明后参与判定）。
 */
export type ResearchLoopStopReason =
  | "no_open_gaps"
  | "iteration_limit"
  | "budget_exceeded"
  | "no_new_coverage";

/** 轮内执行步骤（running 态的磁盘可见性标记；resume 的重算输入） */
export type ResearchLoopStep = "execute" | "coverage";

/** 轮次执行结果快照（来自 M8.2 PlanExecutionResult 的真实计数） */
export interface ResearchLoopExecutionRecord {
  executionId: string;
  totalQueries: number;
  executedQueries: number;
  failedQueries: number;
  completedAt: string;
}

/** 轮次覆盖快照（来自 M8.3.2 Coverage Report 的真实计数） */
export interface ResearchLoopCoverageRecord {
  covered: number;
  partial: number;
  missing: number;
  gaps: number;
  analyzedAt: string;
}

/** 单轮历史（Round History：批准 → 执行 → 覆盖 → 决策 → 派生，逐步回填） */
export interface ResearchLoopRound {
  roundNumber: number;
  planId: string;
  iterationNumber: number;
  approvedAt: string;
  execution?: ResearchLoopExecutionRecord;
  coverage?: ResearchLoopCoverageRecord;
  /** 派生时点的缺口决策快照（accepted / rejected 计数，来自决策视图） */
  decided?: { accepted: number; rejected: number; snapshotAt: string };
  /** 本轮派生出的下一轮计划 id（派生后回填） */
  derivedPlanId?: string;
}

export interface ResearchLoopState {
  loopId: string;
  status: ResearchLoopStatus;
  rounds: ResearchLoopRound[];
  /** running 态的当前步骤；非 running 省略 */
  currentStep?: ResearchLoopStep;
  /** awaiting_retry / failed 的错误摘要（排障用，不含堆栈） */
  error?: string;
  /** completed 的完成原因 */
  stopReason?: ResearchLoopStopReason;
  createdAt: string;
  updatedAt: string;
  completedAt?: string;
  cancelledAt?: string;
}

/** loop id：与 planId / gapId 同风格（loop- + 12 位随机十六进制） */
function newLoopId(): string {
  return `loop-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

function isTerminal(status: ResearchLoopStatus): boolean {
  return status === "completed" || status === "cancelled" || status === "failed";
}

function touchLoop(state: ResearchLoopState): ResearchLoopState {
  return { ...state, updatedAt: new Date().toISOString() };
}

/**
 * 从 artifact 读取循环状态（宽容读取：形状非法 → null，读取端不抛错——与
 * readResearchLoopPolicyFrom 同纪律；落盘只经本服务单一入口，正常数据不会
 * 非法）。
 */
export function readLoopStateFrom(host: { loop?: unknown }): ResearchLoopState | null {
  const value = host.loop;
  if (typeof value !== "object" || value === null) {
    return null;
  }
  const record = value as Record<string, unknown>;
  if (typeof record["loopId"] !== "string" || record["loopId"] === "") {
    return null;
  }
  if (!RESEARCH_LOOP_STATUSES.includes(record["status"] as ResearchLoopStatus)) {
    return null;
  }
  if (!Array.isArray(record["rounds"])) {
    return null;
  }
  return value as ResearchLoopState;
}

// ---- 纯函数：策略判定（可单测的规则骨架） ----

/**
 * 已消耗检索数：Σ 各轮 execution.executedQueries + failedQueries——每条都是
 * 真实发生过的 provider 调用（M8.2 执行记录），不估算不伪造。
 */
export function consumedQueryCount(rounds: ResearchLoopRound[]): number {
  return rounds.reduce(
    (sum, round) =>
      sum + (round.execution?.executedQueries ?? 0) + (round.execution?.failedQueries ?? 0),
    0,
  );
}

/**
 * 批准检查点的策略硬校验（不通过 → 409 LOOP_POLICY_VIOLATION，计划保持
 * draft、循环留在 awaiting_plan_approval——用户编辑计划或调整策略后再批）：
 * - planned 检索数 ≤ maxQueriesPerIteration（单轮上限）；
 * - 已消耗 + planned ≤ maxTotalQueries（整个循环的检索预算）。
 * 不做静默截断——截断等于改写用户计划，编排层没有这个权限。
 */
export function checkPlanWithinPolicy(input: {
  policy: ResearchLoopPolicy;
  plan: ResearchPlan;
  consumedQueries: number;
}): void {
  const planned = input.plan.queries.filter((query) => query.status === "planned").length;
  if (planned > input.policy.maxQueriesPerIteration) {
    throw new BusinessError(
      "LOOP_POLICY_VIOLATION",
      `计划含 ${planned} 条 planned 检索，超过单轮上限 maxQueriesPerIteration=${input.policy.maxQueriesPerIteration}（请编辑计划或调整策略后再批准）`,
    );
  }
  const budget = input.policy.maxTotalQueries;
  if (input.consumedQueries + planned > budget) {
    throw new BusinessError(
      "LOOP_POLICY_VIOLATION",
      `计划将消耗 ${planned} 条检索，加上已消耗 ${input.consumedQueries} 条将超过循环预算 maxTotalQueries=${budget}（请精简计划或调整策略）`,
    );
  }
}

/**
 * 轮后停止判定（Loop Policy Evaluation 的规则骨架，全序判定）：
 * 1. no_open_gaps：覆盖分析无缺口——没有可决策对象，结构完成（不受
 *    stopConditions 开关约束）；
 * 2. iteration_limit（启用时）：计划链最大迭代号已达 maxIterations——下一轮
 *    派生会越界；
 * 3. budget_exceeded（启用时）：已消耗检索数达 maxTotalQueries；
 * 4. no_new_coverage（启用时）：本轮 covered 未多于上一轮（首轮豁免——首轮
 *    建立覆盖基线）。
 * 返回 null = 继续循环（进入缺口决策检查点）。
 */
export function evaluateLoopStop(input: {
  policy: ResearchLoopPolicy;
  chainMaxIteration: number;
  consumedQueries: number;
  round: ResearchLoopRound;
  previousRound?: ResearchLoopRound;
  openGapCount: number;
}): ResearchLoopStopReason | null {
  const { policy } = input;
  if (input.openGapCount === 0) {
    return "no_open_gaps";
  }
  if (policy.stopConditions.includes("iteration_limit") && input.chainMaxIteration >= policy.maxIterations) {
    return "iteration_limit";
  }
  if (policy.stopConditions.includes("budget_exceeded") && input.consumedQueries >= policy.maxTotalQueries) {
    return "budget_exceeded";
  }
  if (
    policy.stopConditions.includes("no_new_coverage") &&
    input.previousRound?.coverage !== undefined &&
    input.round.coverage !== undefined &&
    input.round.coverage.covered <= input.previousRound.coverage.covered
  ) {
    return "no_new_coverage";
  }
  return null;
}

/**
 * 崩溃窗口回填：计划已 done 但轮次执行快照缺失时，从 executionHistory 按
 * planId 重建（真实记录：executionId / executed / failed / 完成时间）。
 * 历史无该计划条目（旧记录无 planId 等）→ undefined——轮次如实缺执行快照，
 * 覆盖分析仍可继续（coverage 自身会合并历史）。
 */
export function reconstructExecution(
  plan: ResearchPlan,
  history: PlanExecutionEntry[],
): ResearchLoopExecutionRecord | undefined {
  const entries = history.filter((entry) => entry.planId === plan.planId);
  if (entries.length === 0) {
    return undefined;
  }
  return {
    executionId: entries[0]!.executionId,
    totalQueries: plan.queries.length,
    executedQueries: entries.filter((entry) => entry.status === "executed").length,
    failedQueries: entries.filter((entry) => entry.status === "failed").length,
    completedAt: entries[entries.length - 1]!.timestamp,
  };
}

// ---- Service（状态编排层） ----

export interface ResearchLoopServiceOptions {
  projects: ProjectStore;
  /** M8.2 计划执行（approve / execute 委托入口） */
  planExecution: ResearchPlanExecutionService;
  /** M8.3.2 覆盖分析（analyze 委托入口；只读） */
  coverage: ResearchCoverageService;
  /** M8.3.3 缺口 HITL（list / derive 委托入口；accept / reject 永不经 Loop） */
  gaps: ResearchGapService;
  log?: (message: string) => void;
}

/** 进行中轮次的取消控制器（cancel 标记；轮任务在每个落盘点检查） */
interface RoundController {
  cancelled: boolean;
}

export class ResearchLoopService {
  private readonly projects: ProjectStore;
  private readonly planExecution: ResearchPlanExecutionService;
  private readonly coverage: ResearchCoverageService;
  private readonly gaps: ResearchGapService;
  private readonly log: (message: string) => void;
  /**
   * 项目级状态写互斥（promise 链）：所有 loop 字段的读-改-写串行化，
   * 与 cancel 的即时落盘互不交错（非重入——持锁期间禁再入）。
   */
  private readonly locks = new Map<string, Promise<unknown>>();
  /** 进行中轮次守卫（同步 check-and-add：事件循环上原子，并发第二轮必 409） */
  private readonly inFlight = new Map<string, RoundController>();

  constructor(options: ResearchLoopServiceOptions) {
    this.projects = options.projects;
    this.planExecution = options.planExecution;
    this.coverage = options.coverage;
    this.gaps = options.gaps;
    this.log = options.log ?? (() => {});
  }

  /** GET /research/loop：当前循环状态（未创建 → null 空态，不报错） */
  async get(projectId: string): Promise<ResearchLoopState | null> {
    return this.readState(projectId);
  }

  /**
   * 启动循环（POST /research/loop/start）：
   * - 无 research.json / 无活动计划 → 404（先运行调研 / 编辑生成计划）；
   * - 活动计划非 draft → 409（循环从 draft 计划的批准检查点起步；已有链可
   *   先派生下一轮 draft）；
   * - 已有非终态循环 → 409（先 cancel）；终态循环允许重启（新 loopId，全新
   *   轮次历史——历史迭代仍完整保留在计划链 plans 中）。
   * 启动后停在 awaiting_plan_approval——**不自动批准**（HITL 断点一）。
   */
  async start(projectId: string): Promise<ResearchLoopState> {
    return this.withLock(projectId, async () => {
      const existing = await this.readState(projectId);
      if (existing !== null && !isTerminal(existing.status)) {
        throw new BusinessError(
          "LOOP_INVALID_STATE",
          `项目已有进行中的研究循环（loopId=${existing.loopId} status=${existing.status}）：请先经既有检查点推进或 cancel`,
        );
      }
      const artifact = await readResearchArtifact(this.projects, projectId);
      if (artifact === null) {
        throw new BusinessError(
          "NOT_FOUND",
          "项目还没有调研结果（research/research.json 不存在），请先运行调研再启动研究循环",
        );
      }
      const chain = readPlanChain(artifact);
      const plan = chain.plans.find((entry) => entry.planId === chain.activePlanId);
      if (plan === undefined) {
        throw new BusinessError(
          "NOT_FOUND",
          "项目还没有研究计划（research artifact 无 plan 字段），请先运行调研或编辑生成计划",
        );
      }
      if (plan.status !== "draft") {
        throw new BusinessError(
          "LOOP_INVALID_STATE",
          `研究循环从 draft 计划起步（当前活动计划 ${plan.planId} 是 ${plan.status}）：done 计划可先经 /research/plan/:planId/derive 派生下一轮 draft`,
        );
      }
      const now = new Date().toISOString();
      const state: ResearchLoopState = {
        loopId: newLoopId(),
        status: "awaiting_plan_approval",
        rounds: [],
        createdAt: now,
        updatedAt: now,
      };
      await this.writeState(projectId, state);
      this.log(
        `[research-loop] projectId=${projectId} 循环已启动：loopId=${state.loopId} planId=${plan.planId}（等待计划批准）`,
      );
      return state;
    });
  }

  /**
   * 计划批准检查点（POST /research/loop/plan/approve；HITL 断点一的显式用户
   * 动作）：策略硬校验（maxQueriesPerIteration / 剩余预算）→ 委托 M8.2
   * approve（draft → approved 的单一流转）→ 登记轮次 → 同步执行本轮
   * （execute → coverage → policy evaluation）。
   * 轮次被可恢复错误打断 → awaiting_retry；非业务异常 → failed（响应 200 携带
   * 终态化状态与 error 摘要——循环是状态机，错误即状态）；执行成功 →
   * awaiting_gap_decision 或 completed（策略停止）。
   */
  async approvePlan(projectId: string): Promise<ResearchLoopState> {
    const controller = this.beginRound(projectId);
    try {
      await this.withLock(projectId, async () => {
        const state = await this.readStateOrThrow(projectId);
        if (state.status !== "awaiting_plan_approval") {
          throw new BusinessError(
            "LOOP_INVALID_STATE",
            `计划批准检查点只在 awaiting_plan_approval 状态开放（当前 ${state.status}）`,
          );
        }
        const { artifact, plan } = await this.loadActivePlanOrThrow(projectId);
        if (plan.status !== "draft") {
          throw new BusinessError(
            "LOOP_INVALID_STATE",
            `活动计划 ${plan.planId} 是 ${plan.status}（批准检查点要求 draft）`,
          );
        }
        checkPlanWithinPolicy({
          policy: readResearchLoopPolicyFrom(artifact),
          plan,
          consumedQueries: consumedQueryCount(state.rounds),
        });
        await this.planExecution.approve(projectId);
        const now = new Date().toISOString();
        const next = touchLoop({
          ...state,
          status: "running",
          currentStep: "execute",
          rounds: [
            ...state.rounds,
            {
              roundNumber: state.rounds.length + 1,
              planId: plan.planId,
              iterationNumber: plan.iterationNumber,
              approvedAt: now,
            },
          ],
        });
        await this.writeState(projectId, next);
        this.log(
          `[research-loop] projectId=${projectId} 第 ${next.rounds.length} 轮已批准：planId=${plan.planId} iteration=${plan.iterationNumber}`,
        );
      });
      await this.runRound(projectId, controller, "full");
      return await this.readStateOrThrow(projectId);
    } finally {
      this.inFlight.delete(projectId);
    }
  }

  /**
   * 恢复 / 重试循环（POST /research/loop/resume）：
   * - running（进程重启后的磁盘残留）→ 按事实重算续跑点（见 reconcile）；
   * - awaiting_retry / failed → 排除障碍后重试本轮剩余步骤；
   * - awaiting_plan_approval → 仅当活动计划已是 approved（「批准已落盘、轮次
   *   未登记」的崩溃窗口，或用户经既有 API 直接批准）时采纳并续跑，否则 409
   *   （批准是 HITL 动作，请经批准检查点推进）；
   * - awaiting_gap_decision / completed / cancelled → 409（无可恢复断点）。
   * 并发 resume / 轮次执行中 → 409（进行中守卫）。
   */
  async resume(projectId: string): Promise<ResearchLoopState> {
    const controller = this.beginRound(projectId);
    const next = { mode: null as "full" | "coverage_only" | null };
    try {
      await this.withLock(projectId, async () => {
        const state = await this.readStateOrThrow(projectId);
        if (state.status === "running" || state.status === "awaiting_retry" || state.status === "failed") {
          next.mode = await this.reconcile(projectId, state);
          return;
        }
        if (state.status !== "awaiting_plan_approval") {
          throw new BusinessError(
            "LOOP_INVALID_STATE",
            `状态 ${state.status} 没有可恢复的执行断点（缺口决策请走 derive-next，终态循环请重新 start）`,
          );
        }
        // 崩溃窗口恢复：计划已 approved 但轮次未登记（approve 落盘后、轮次写盘前）
        const { artifact, plan } = await this.loadActivePlanOrThrow(projectId);
        const lastRound = state.rounds[state.rounds.length - 1];
        const isPendingPlan =
          state.rounds.length === 0 ||
          (lastRound?.derivedPlanId !== undefined && lastRound.derivedPlanId === plan.planId);
        if (plan.status !== "approved" || !isPendingPlan) {
          throw new BusinessError(
            "LOOP_INVALID_STATE",
            `循环在等待计划批准（活动计划 ${plan.planId} 是 ${plan.status}）：请经 POST /research/loop/plan/approve 推进（HITL 断点不自动跨过）`,
          );
        }
        checkPlanWithinPolicy({
          policy: readResearchLoopPolicyFrom(artifact),
          plan,
          consumedQueries: consumedQueryCount(state.rounds),
        });
        const now = new Date().toISOString();
        const adopted = touchLoop({
          ...state,
          status: "running",
          currentStep: "execute",
          rounds: [
            ...state.rounds,
            {
              roundNumber: state.rounds.length + 1,
              planId: plan.planId,
              iterationNumber: plan.iterationNumber,
              approvedAt: now,
            },
          ],
        });
        await this.writeState(projectId, adopted);
        this.log(
          `[research-loop] projectId=${projectId} resume 采纳已批准计划为第 ${adopted.rounds.length} 轮：planId=${plan.planId}`,
        );
        next.mode = "full";
      });
      if (next.mode !== null) {
        await this.runRound(projectId, controller, next.mode);
      }
      return await this.readStateOrThrow(projectId);
    } finally {
      this.inFlight.delete(projectId);
    }
  }

  /**
   * 取消循环（POST /research/loop/cancel）：任何非终态 → cancelled。
   * 轮次执行中：标记取消控制器（执行中的检索不中断——已发生的检索是真实
   * 结果；轮任务在下一个落盘点停止推进与写盘）。
   */
  async cancel(projectId: string): Promise<ResearchLoopState> {
    return this.withLock(projectId, async () => {
      const state = await this.readStateOrThrow(projectId);
      if (isTerminal(state.status)) {
        throw new BusinessError(
          "LOOP_INVALID_STATE",
          `循环已是终态（${state.status}），无需取消`,
        );
      }
      const controller = this.inFlight.get(projectId);
      if (controller !== undefined) {
        controller.cancelled = true;
      }
      const now = new Date().toISOString();
      const next = touchLoop({
        ...state,
        status: "cancelled",
        cancelledAt: now,
        currentStep: undefined,
      });
      await this.writeState(projectId, next);
      this.log(`[research-loop] projectId=${projectId} 循环已取消：loopId=${state.loopId}`);
      return next;
    });
  }

  /**
   * 从缺口派生下一轮（POST /research/loop/derive-next；HITL 断点三）：
   * - 只在 awaiting_gap_decision 开放；至少一个 accepted 缺口（用户已决策）
   *   否则 409——没有用户决策就没有下一轮；
   * - 多个 accepted 缺口时请求体须指定 gapId（缺省取唯一 accepted）；
   * - questions / queries 透传（M8.3.3 gaps.derive 的改写入口，全部可选）；
   * - 策略复检（检查点期间策略可能被 PUT 修改：iteration 上限）；
   * - 委托 gaps.derive（单一派生逻辑：新计划 draft、成为活动计划、旧计划
   *   不动）→ 登记决策快照与 derivedPlanId → 停在 awaiting_plan_approval
   *   （**不自动批准、不自动执行**——等待下一次用户批准）。
   */
  async deriveNextPlan(
    projectId: string,
    body: Record<string, unknown>,
  ): Promise<{ loop: ResearchLoopState; plan: ResearchPlan }> {
    return this.withLock(projectId, async () => {
      const state = await this.readStateOrThrow(projectId);
      if (state.status !== "awaiting_gap_decision") {
        throw new BusinessError(
          "LOOP_INVALID_STATE",
          `下一轮派生只在 awaiting_gap_decision 状态开放（当前 ${state.status}）`,
        );
      }
      const gapView = await this.gaps.list(projectId);
      const accepted = gapView.gaps.filter((gap) => gap.status === "accepted");
      const rejected = gapView.gaps.filter((gap) => gap.status === "rejected");
      if (accepted.length === 0) {
        throw new BusinessError(
          "LOOP_INVALID_STATE",
          "没有已接受（accepted）的研究缺口：请先经 POST /research/gaps/:gapId/accept 确认至少一个缺口，或 cancel 结束循环",
        );
      }
      const requestedGapId = body["gapId"];
      const gapId =
        typeof requestedGapId === "string" && requestedGapId !== ""
          ? requestedGapId
          : accepted.length === 1
            ? accepted[0]!.gapId
            : undefined;
      if (gapId === undefined) {
        throw new BusinessError(
          "INVALID_REQUEST",
          `存在 ${accepted.length} 个已接受缺口，请求体必须指定 gapId（可选：${accepted.map((gap) => gap.gapId).join(" / ")}）`,
        );
      }
      // 策略复检：派生会创建 iteration+1 的新计划——策略在检查点期间收紧时
      // 如实拒绝（不静默越界）
      const artifact = await readResearchArtifact(this.projects, projectId);
      if (artifact === null) {
        throw new BusinessError("NOT_FOUND", "项目还没有调研结果（research/research.json 不存在）");
      }
      const policy = readResearchLoopPolicyFrom(artifact);
      const chainMax = maxIterationNumber(readPlanChain(artifact).plans);
      if (policy.stopConditions.includes("iteration_limit") && chainMax >= policy.maxIterations) {
        throw new BusinessError(
          "LOOP_POLICY_VIOLATION",
          `计划链已有 ${chainMax} 轮迭代，达到 maxIterations=${policy.maxIterations} 上限：不能再派生下一轮（可调整策略或结束循环）`,
        );
      }
      const deriveBody: Record<string, unknown> = { ...body };
      delete deriveBody["gapId"];
      const plan = await this.gaps.derive(projectId, gapId, deriveBody);
      const now = new Date().toISOString();
      const next = touchLoop(patchLastRound(state, (round) => ({
        ...round,
        decided: { accepted: accepted.length, rejected: rejected.length, snapshotAt: now },
        derivedPlanId: plan.planId,
      }), { status: "awaiting_plan_approval", currentStep: undefined }));
      await this.writeState(projectId, next);
      this.log(
        `[research-loop] projectId=${projectId} 第 ${next.rounds.length} 轮缺口决策完成（accepted=${accepted.length} rejected=${rejected.length}），派生下一轮：planId=${plan.planId}（等待批准）`,
      );
      return { loop: next, plan };
    });
  }

  // ---- 轮次执行（execute → coverage → policy evaluation） ----

  /** 执行一轮：mode=full 先执行检索；失败按错误类别落 awaiting_retry / failed */
  private async runRound(
    projectId: string,
    controller: RoundController,
    mode: "full" | "coverage_only",
  ): Promise<void> {
    try {
      if (mode === "full") {
        await this.executeStep(projectId, controller);
      }
      await this.coverageStep(projectId, controller);
    } catch (error) {
      if (controller.cancelled) {
        return; // 已取消：状态已由 cancel 落盘，不覆盖
      }
      const recoverable = error instanceof BusinessError;
      const message = (error instanceof Error ? error.message : String(error)).slice(0, 500);
      await this.persist(projectId, controller, (state) =>
        touchLoop({
          ...state,
          status: recoverable ? "awaiting_retry" : "failed",
          error: message,
          currentStep: undefined,
        }),
      );
      this.log(
        `[research-loop] projectId=${projectId} 轮次中断（${recoverable ? "awaiting_retry" : "failed"}）：${message.slice(0, 200)}`,
      );
    }
  }

  /** execute 步骤：委托 M8.2（真实检索 + 状态回填），完成后登记执行快照 */
  private async executeStep(projectId: string, controller: RoundController): Promise<void> {
    const result = await this.planExecution.execute(projectId);
    if (controller.cancelled) {
      return;
    }
    await this.persist(projectId, controller, (state) =>
      touchLoop(patchLastRound(state, (round) => ({
        ...round,
        execution: {
          executionId: result.executionId,
          totalQueries: result.totalQueries,
          executedQueries: result.executedQueries,
          failedQueries: result.failedQueries,
          completedAt: new Date().toISOString(),
        },
      }), { status: "running", currentStep: "coverage" })),
    );
  }

  /** coverage 步骤：委托 M8.3.2 分析 → 策略判定 → 落终态或缺口决策检查点 */
  private async coverageStep(projectId: string, controller: RoundController): Promise<void> {
    if (controller.cancelled) {
      return;
    }
    const report = await this.coverage.analyze(projectId);
    if (controller.cancelled) {
      return;
    }
    await this.withLock(projectId, async () => {
      if (controller.cancelled) {
        return;
      }
      const artifact = await readResearchArtifact(this.projects, projectId);
      if (artifact === null) {
        throw new BusinessError("NOT_FOUND", "项目还没有调研结果（research/research.json 不存在）");
      }
      const state = readLoopStateFrom(artifact);
      if (state === null) {
        throw new BusinessError("NOT_FOUND", "研究循环状态丢失（research.json 无合法 loop 字段）");
      }
      const patched = patchLastRound(state, (round) => ({
        ...round,
        coverage: {
          covered: report.overall.covered,
          partial: report.overall.partial,
          missing: report.overall.missing,
          gaps: report.gaps.length,
          analyzedAt: report.analyzedAt,
        },
      }));
      const stop = evaluateLoopStop({
        policy: readResearchLoopPolicyFrom(artifact),
        chainMaxIteration: maxIterationNumber(readPlanChain(artifact).plans),
        consumedQueries: consumedQueryCount(patched.rounds),
        round: patched.rounds[patched.rounds.length - 1]!,
        previousRound:
          patched.rounds.length >= 2 ? patched.rounds[patched.rounds.length - 2] : undefined,
        openGapCount: report.gaps.length,
      });
      const now = new Date().toISOString();
      const next =
        stop === null
          ? touchLoop({ ...patched, status: "awaiting_gap_decision", currentStep: undefined })
          : touchLoop({
              ...patched,
              status: "completed",
              stopReason: stop,
              completedAt: now,
              currentStep: undefined,
            });
      await writeResearchLoopState(this.projects, projectId, artifact, { loop: next });
      this.log(
        `[research-loop] projectId=${projectId} 第 ${next.rounds.length} 轮完成：covered=${report.overall.covered} partial=${report.overall.partial} missing=${report.overall.missing} gaps=${report.gaps.length}` +
          (stop !== null ? `（循环停止：${stop}）` : "（等待缺口决策）"),
      );
    });
  }

  // ---- 崩溃恢复（只依据磁盘事实重算，不依赖内存） ----

  /**
   * 把 running / awaiting_retry / failed 的循环对齐到 research.json 的当前
   * 事实，返回续跑模式（null = 已落到检查点 / 需人工介入，无需续跑）：
   * - 活动计划已被更高迭代号计划替换（用户在检查点外手动派生）→ 采纳为
   *   待批计划，回 awaiting_plan_approval；
   * - 本轮计划 done（崩溃前执行已完成）→ 从 executionHistory 回填执行快照
   *   （真实计数）→ 继续 coverage；
   * - 本轮计划 approved → 重试 execute；
   * - 本轮计划 executing（进程重启残留）→ awaiting_retry + 修复提示（与
   *   M8.2 的 409 提示同口径）；
   * - 本轮计划被外部改回 draft → 409（请 cancel 重走批准检查点）。
   */
  private async reconcile(
    projectId: string,
    state: ResearchLoopState,
  ): Promise<"full" | "coverage_only" | null> {
    const { artifact, plan } = await this.loadActivePlanOrThrow(projectId);
    const lastRound = state.rounds[state.rounds.length - 1];
    if (lastRound === undefined) {
      throw new BusinessError(
        "LOOP_INVALID_STATE",
        "循环状态缺轮次记录（数据不一致）：请 cancel 后重新 start",
      );
    }
    if (plan.planId !== lastRound.planId) {
      if (plan.iterationNumber > lastRound.iterationNumber) {
        await this.writeState(
          projectId,
          touchLoop(patchLastRound(state, (round) => ({ ...round, derivedPlanId: plan.planId }), {
            status: "awaiting_plan_approval",
            currentStep: undefined,
          })),
        );
        this.log(
          `[research-loop] projectId=${projectId} resume 采纳手动派生的新计划：planId=${plan.planId}（等待批准）`,
        );
        return null;
      }
      throw new BusinessError(
        "LOOP_INVALID_STATE",
        `活动计划已被切走（${plan.planId} ≠ 本轮 ${lastRound.planId}）：请先激活本轮计划再 resume，或 cancel 结束循环`,
      );
    }
    switch (plan.status) {
      case "done": {
        const execution =
          lastRound.execution ?? reconstructExecution(plan, artifact.executionHistory ?? []);
        await this.writeState(
          projectId,
          touchLoop(patchLastRound(state, (round) => ({ ...round, ...(execution !== undefined ? { execution } : {}) }), {
            status: "running",
            currentStep: "coverage",
          })),
        );
        this.log(
          `[research-loop] projectId=${projectId} resume：本轮计划已 done，${execution !== undefined ? "已从执行历史回填快照" : "执行历史无该计划记录（快照如实缺失）"}，继续覆盖分析`,
        );
        return "coverage_only";
      }
      case "approved": {
        await this.writeState(
          projectId,
          touchLoop({ ...state, status: "running", currentStep: "execute" }),
        );
        this.log(`[research-loop] projectId=${projectId} resume：重试本轮执行`);
        return "full";
      }
      case "executing": {
        await this.writeState(
          projectId,
          touchLoop({
            ...state,
            status: "awaiting_retry",
            currentStep: undefined,
            error:
              "计划状态残留 executing（服务曾在执行期间重启）：请将 research.json 中该计划的 status 改回 approved 后重新 resume",
          }),
        );
        return null;
      }
      case "draft":
        throw new BusinessError(
          "LOOP_INVALID_STATE",
          `本轮计划 ${plan.planId} 回到 draft（被外部编辑重置）：请 cancel 后重新走批准检查点`,
        );
    }
  }

  // ---- 基础设施：状态读写 / 互斥 / 守卫 ----

  private async readState(projectId: string): Promise<ResearchLoopState | null> {
    const artifact = await readResearchArtifact(this.projects, projectId);
    return artifact === null ? null : readLoopStateFrom(artifact);
  }

  private async readStateOrThrow(projectId: string): Promise<ResearchLoopState> {
    const state = await this.readState(projectId);
    if (state === null) {
      throw new BusinessError(
        "NOT_FOUND",
        "项目还没有受控研究循环（POST /research/loop/start 创建）",
      );
    }
    return state;
  }

  /** 写 loop 字段（重读 artifact 后只覆盖 loop——其余字段原样保留；调用方持锁或接受串行上下文） */
  private async writeState(projectId: string, next: ResearchLoopState): Promise<void> {
    const artifact = await readResearchArtifact(this.projects, projectId);
    if (artifact === null) {
      throw new BusinessError(
        "NOT_FOUND",
        "项目还没有调研结果（research/research.json 不存在），请先运行调研",
      );
    }
    await writeResearchLoopState(this.projects, projectId, artifact, { loop: next });
  }

  /** 锁内落盘（取消检查在锁内做——与 cancel 的标记+落盘严格串行，不丢更新） */
  private async persist(
    projectId: string,
    controller: RoundController,
    mutate: (state: ResearchLoopState) => ResearchLoopState,
  ): Promise<void> {
    await this.withLock(projectId, async () => {
      if (controller.cancelled) {
        return;
      }
      const state = await this.readState(projectId);
      if (state === null) {
        return;
      }
      await this.writeState(projectId, mutate(state));
    });
  }

  private async loadActivePlanOrThrow(
    projectId: string,
  ): Promise<{ artifact: ResearchArtifact; plan: ResearchPlan }> {
    const artifact = await readResearchArtifact(this.projects, projectId);
    if (artifact === null) {
      throw new BusinessError(
        "NOT_FOUND",
        "项目还没有调研结果（research/research.json 不存在），请先运行调研",
      );
    }
    const chain = readPlanChain(artifact);
    const plan = chain.plans.find((entry) => entry.planId === chain.activePlanId);
    if (plan === undefined) {
      throw new BusinessError(
        "NOT_FOUND",
        "项目还没有研究计划（research artifact 无 plan 字段），请先运行调研或编辑生成计划",
      );
    }
    return { artifact, plan };
  }

  /** 进行中轮次守卫：同步 check-and-add（事件循环上原子） */
  private beginRound(projectId: string): RoundController {
    if (this.inFlight.has(projectId)) {
      throw new BusinessError(
        "LOOP_INVALID_STATE",
        "该项目的循环轮次正在执行中，禁止并发恢复 / 重复推进（请等待本轮完成或先 cancel）",
      );
    }
    const controller: RoundController = { cancelled: false };
    this.inFlight.set(projectId, controller);
    return controller;
  }

  /** 项目级互斥（promise 链，非重入：持锁回调内禁再调 withLock / persist） */
  private async withLock<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.locks.get(projectId) ?? Promise.resolve();
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const entry = previous.then(() => gate);
    this.locks.set(projectId, entry);
    await previous;
    try {
      return await operation();
    } finally {
      release();
      void entry.then(() => {
        if (this.locks.get(projectId) === entry) {
          this.locks.delete(projectId);
        }
      });
    }
  }
}

/** 原位修补最后一轮 + 附加状态字段（返回新对象；无轮次时抛错——防御性） */
function patchLastRound(
  state: ResearchLoopState,
  patch: (round: ResearchLoopRound) => ResearchLoopRound,
  extra?: Partial<Pick<ResearchLoopState, "status" | "currentStep">>,
): ResearchLoopState {
  if (state.rounds.length === 0) {
    throw new Error("patchLastRound: 循环没有任何轮次（数据不一致）");
  }
  const rounds = state.rounds.map((round, index) =>
    index === state.rounds.length - 1 ? patch(round) : round,
  );
  return { ...state, rounds, ...(extra ?? {}) };
}
