/**
 * ResearchPlan Execution Layer（M8.2：可执行研究计划）。
 *
 * 把 M8.1 的静态 ResearchPlan 升级为可执行：批准（draft → approved）后，
 * 遍历 plan.queries 中 status=planned 的条目，复用 ResearchDiscoveryService
 * 执行检索（academic / web 按 kind 分派），回填 query 状态与 resultCount，
 * 并把最小执行记录（executionHistory）挂在 research artifact 顶层的可选字段。
 *
 * M8.5 search audit：成功条目额外回填 providers（谁参与了这条 query、各自
 * 带回多少条 / 是否降级）与 resultIdentifiers（结果标识符投影——「这次到底
 * 搜到了什么」可追溯，M8 真实验收的 P2 观测断层修复）。两者都是可选字段，
 * 旧 artifact 兼容；只是审计痕迹，不自动成为 Candidate（边界不变）。
 *
 * 冻结规则（M8 架构）全部遵守：
 * - 不新增 Agent：本服务不调用 Runtime.runAgent，检索走既有 Discovery 编排层；
 * - 不修改 Runtime / Workflow Orchestrator：纯 Service，不进 workflowServices；
 * - 不引入 RAG / Vector DB / MCP / 新 Provider / CLI：搜索逻辑 100% 复用
 *   ResearchDiscoveryService（provider 装配零变化）；
 * - Evidence 不变量：执行只产生「Search Result 计数」，不写 CandidateStore /
 *   SourceStore / EvidenceStore，不 prime 检索缓存（不传 projectId）——
 *   Search Result ≠ Candidate ≠ Literature ≠ Verified Evidence 链路原样，
 *   保存候选 → promote → Evidence 仍由用户显式驱动（M7 设计不变）。
 *
 * 状态机：draft → approved → executing → done。
 * - draft 只能编辑（执行 → 409）；approved 允许执行；executing 禁止重复执行；
 * - done 表示本轮计划执行完成（再执行 → 409；M8.3.1 起可经 derive 派生下一轮）；
 * - 不自动把 draft 改 approved（批准是显式 HITL 动作）。
 *
 * M8.3.1：批准 / 执行始终作用于**活动计划**（计划链 plans + activePlanId 中
 * activePlanId 指向的条目；活动计划的切换入口是 ResearchPlanIterationService
 * 的 derive / activate）。执行记录带 planId 归属（旧记录无该字段，兼容读取）。
 */

import { randomUUID } from "node:crypto";

import { BusinessError } from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { ResearchDiscoveryService } from "../search/researchDiscoveryService.js";
import type { AcademicSearchResponse } from "../search/academicSearchService.js";
import type { FusedAcademicResult } from "../search/fusion.js";
import type { WebSearchResponse } from "../search/webSearchService.js";
import {
  readResearchArtifact,
  writeResearchPlanChain,
  type ResearchArtifact,
} from "./ResearcherService.js";
import {
  readPlanChain,
  type ResearchPlan,
  type ResearchPlanChain,
  type ResearchPlanQuery,
  type ResearchQueryKind,
} from "./researchPlan.js";

/** 单条 query 的执行记录状态（成功 executed / 失败 failed，均如实入 history） */
export type PlanExecutionEntryStatus = "executed" | "failed";

/**
 * 参与该次检索的 provider 摘要（M8.5 search audit；diagnostics 的最小投影，
 * 不含 header / API key / 原始错误对象）。outcome 语义同 ProviderAttempt。
 */
export interface PlanExecutionProviderAttempt {
  provider: string;
  outcome: string;
  resultCount: number;
  latencyMs?: number;
  /** degraded / skipped 的简短原因（如 SearXNG unresponsive_engines） */
  note?: string;
}

/**
 * 最小执行记录（挂在 research.json 顶层可选字段 executionHistory）。
 * timestamp 即该 query 的 executedAt；失败条目带 error（排障摘要）。
 */
export interface PlanExecutionEntry {
  executionId: string;
  queryId: string;
  query: string;
  kind: ResearchQueryKind;
  timestamp: string;
  status: PlanExecutionEntryStatus;
  /** 执行该条目的计划（M8.3.1；多轮迭代下定位归属，旧记录无此字段） */
  planId?: string;
  /** 成功时的检索结果数（Search Result 计数，非候选数） */
  resultCount?: number;
  /** 失败原因（BusinessError message；不含堆栈） */
  error?: string;
  /**
   * 参与检索的 provider 尝试摘要（M8.5；成功条目回填——谁在何时用哪些源
   * 跑了这条 query、各自带回多少条。失败条目整体 error 已含失败原因，不重复）。
   * 可选字段：旧 artifact 无此字段仍可读。
   */
  providers?: PlanExecutionProviderAttempt[];
  /**
   * 结果标识符投影（M8.5；学术 = doi:… / arxiv:… / url / title:…，Web = url）。
   * 只是审计痕迹（「这次到底搜到了什么」），不是候选、不进任何 Store——
   * Search Result ≠ Candidate 边界不变。可选字段：旧 artifact 兼容。
   */
  resultIdentifiers?: string[];
}

/** 单条 query 最多留存的 result identifiers 数（防 artifact 无限膨胀；与检索硬帽同量级） */
const MAX_RESULT_IDENTIFIERS_PER_ENTRY = 50;

/** POST /research/plan/execute 的响应 */
export interface PlanExecutionResult {
  executionId: string;
  /** plan 内 query 总数（含既有 executed / skipped） */
  totalQueries: number;
  /** 本次执行成功的 planned query 数 */
  executedQueries: number;
  /** 本次执行失败的 planned query 数（逐条记录，不中断整轮） */
  failedQueries: number;
  /** 执行完成后的 plan（状态已流转） */
  plan: ResearchPlan;
}

/** executionHistory 条数硬帽（防无限增长；超限丢最旧） */
export const MAX_EXECUTION_HISTORY = 200;

export interface ResearchPlanExecutionServiceOptions {
  projects: ProjectStore;
  discovery: ResearchDiscoveryService;
  log?: (message: string) => void;
}

export class ResearchPlanExecutionService {
  private readonly projects: ProjectStore;
  private readonly discovery: ResearchDiscoveryService;
  private readonly log: (message: string) => void;
  /**
   * 进程内执行中守卫（projectId 集合）：execute 入口同步 check-and-add，
   * 在事件循环上原子 → 并发重复执行第二个请求必得 409；finally 释放。
   * 磁盘上的 executing 状态是可见性记录（崩溃残留见 execute 内提示）。
   */
  private readonly executing = new Set<string>();

  constructor(options: ResearchPlanExecutionServiceOptions) {
    this.projects = options.projects;
    this.discovery = options.discovery;
    this.log = options.log ?? (() => {});
  }

  /**
   * 批准计划（draft → approved）。不自动发生——唯一的 status 流转入口之一。
   * 作用于活动计划（M8.3.1：activate / derive 决定谁是活动计划）。
   * 非 draft（含 executing / done）→ 409 PLAN_INVALID_STATE。
   */
  async approve(projectId: string): Promise<ResearchPlan> {
    const { artifact, chain, plan } = await this.loadPlanOrThrow(projectId);
    if (plan.status !== "draft") {
      throw new BusinessError(
        "PLAN_INVALID_STATE",
        `只有 draft 状态的计划才能批准（当前 ${plan.status}）`,
      );
    }
    const approved = { ...plan, status: "approved" as const, updatedAt: new Date().toISOString() };
    await writeResearchPlanChain(
      this.projects,
      projectId,
      artifact,
      replaceInChain(chain, approved),
      artifact.executionHistory,
    );
    this.log(`[plan-execution] projectId=${projectId} 计划已批准：planId=${approved.planId}`);
    return approved;
  }

  /**
   * 执行当前 approved 的 ResearchPlan（活动计划）：
   * 遍历 status=planned 的 query → ResearchDiscoveryService 检索 → 回填
   * executed + resultCount（失败记 history 不中断）→ 全部处理完 plan.status=done。
   *
   * - plan / artifact 不存在 → 404；状态不允许（draft / executing / done）→ 409；
   * - 单条 query 检索失败（如 provider 全失败 / 未配置）→ 记 failed 条目，
   *   继续执行其余 query；failedQueries 如实返回，不伪造成功；
   * - 零 planned query（全部 executed / skipped）：直接流转 done，计数为 0。
   */
  async execute(projectId: string): Promise<PlanExecutionResult> {
    if (this.executing.has(projectId)) {
      throw new BusinessError(
        "PLAN_INVALID_STATE",
        "该计划正在执行中，禁止重复执行（请等待本轮完成）",
      );
    }
    this.executing.add(projectId);
    try {
      const { artifact, chain, plan } = await this.loadPlanOrThrow(projectId);
      if (plan.status !== "approved") {
        throw new BusinessError(
          "PLAN_INVALID_STATE",
          plan.status === "executing"
            ? "该计划正在执行中，禁止重复执行；若服务曾在执行期间重启导致状态残留，请将 research.json 中该计划的 status 改回 approved 后重试"
            : plan.status === "draft"
              ? "计划还是 draft，只能编辑；请先批准（approve）后再执行"
              : "该轮计划已执行完成（done）；可派生新计划（derive）继续下一轮研究，或编辑补充新的 planned 检索后重新走批准流",
        );
      }

      const executionId = newExecutionId();
      const plannedQueries = plan.queries.filter((query) => query.status === "planned");
      let working: ResearchPlan = { ...plan, status: "executing", updatedAt: new Date().toISOString() };
      // 先落 executing 态（可见性：磁盘上能看出有执行在途），再逐条执行
      await writeResearchPlanChain(
        this.projects,
        projectId,
        artifact,
        replaceInChain(chain, working),
        artifact.executionHistory,
      );

      const entries: PlanExecutionEntry[] = [];
      let executedQueries = 0;
      let failedQueries = 0;
      for (const query of plannedQueries) {
        const entry = await this.executeQuery(projectId, executionId, working.planId, query);
        entries.push(entry);
        if (entry.status === "executed") {
          executedQueries += 1;
          working = {
            ...working,
            queries: working.queries.map((candidate) =>
              candidate.queryId === query.queryId
                ? { ...candidate, status: "executed", resultCount: entry.resultCount }
                : candidate,
            ),
          };
        } else {
          failedQueries += 1; // 失败条目保持 planned（可重试）
        }
      }

      const done: ResearchPlan = { ...working, status: "done", updatedAt: new Date().toISOString() };
      const history = [...(artifact.executionHistory ?? []), ...entries].slice(-MAX_EXECUTION_HISTORY);
      await writeResearchPlanChain(
        this.projects,
        projectId,
        artifact,
        replaceInChain(chain, done),
        history,
      );
      this.log(
        `[plan-execution] projectId=${projectId} 执行完成：executionId=${executionId} planned=${plannedQueries.length} executed=${executedQueries} failed=${failedQueries}`,
      );
      return {
        executionId,
        totalQueries: done.queries.length,
        executedQueries,
        failedQueries,
        plan: done,
      };
    } finally {
      this.executing.delete(projectId);
    }
  }

  /** 执行单条 planned query：成功 → executed + resultCount + 审计投影；任何失败 → failed + error */
  private async executeQuery(
    projectId: string,
    executionId: string,
    planId: string,
    query: ResearchPlanQuery,
  ): Promise<PlanExecutionEntry> {
    const base = {
      executionId,
      queryId: query.queryId,
      query: query.query,
      kind: query.kind,
      timestamp: new Date().toISOString(),
      planId,
    };
    try {
      // 复用既有 Discovery 编排（provider fan-out / 融合 / 诊断一体）；
      // 不传 projectId → 不写检索缓存：执行对 Discovery 侧零副作用
      // M8.5 search audit：provider 参与摘要 + 结果标识符投影只进 executionHistory，
      // 不写任何 Store——Search Result ≠ Candidate 不变量不变
      if (query.kind === "academic") {
        const response = await this.discovery.academicSearch(query.query);
        return executedEntry(base, response.results.length, providerAttempts(response), response.results.map(academicIdentifier));
      }
      const response = await this.discovery.webSearch(query.query);
      return executedEntry(
        base,
        response.results.length,
        providerAttempts(response),
        response.results.map((result) => result.url),
      );
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.log(
        `[plan-execution] projectId=${projectId} 检索失败（${query.queryId} ${query.kind}）：${message.slice(0, 200)}`,
      );
      return { ...base, status: "failed", error: message.slice(0, 500) };
    }
  }

  /**
   * 读 artifact + 活动计划（M8.3.1：plan = 计划链中 activePlanId 指向的条目；
   * 旧 artifact 单一 plan 字段经 readPlanChain 归一化为单轮链）。
   * 缺 artifact（未调研）/ 缺计划 → 404。
   */
  private async loadPlanOrThrow(projectId: string): Promise<{
    artifact: ResearchArtifact;
    chain: ResearchPlanChain;
    plan: ResearchPlan;
  }> {
    const artifact = await readResearchArtifact(this.projects, projectId);
    if (artifact === null) {
      throw new BusinessError(
        "NOT_FOUND",
        "项目还没有调研结果（research/research.json 不存在），请先运行调研再执行研究计划",
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
    return { artifact, chain, plan };
  }
}

/** 链中原位替换活动条目（其余迭代不动；活动条目按 planId 定位） */
function replaceInChain(chain: ResearchPlanChain, plan: ResearchPlan): ResearchPlanChain {
  return {
    plans: chain.plans.map((entry) => (entry.planId === plan.planId ? plan : entry)),
    activePlanId: chain.activePlanId,
  };
}

/** execution id：与 planId 同风格（exec- + 12 位随机十六进制） */
function newExecutionId(): string {
  return `exec-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

/** diagnostics.providers 的最小审计投影（截短 note；不携带 error 对象） */
function providerAttempts(
  response: AcademicSearchResponse | WebSearchResponse,
): PlanExecutionProviderAttempt[] {
  return response.diagnostics.providers.map((attempt) => ({
    provider: attempt.provider,
    outcome: attempt.outcome,
    resultCount: attempt.resultCount,
    latencyMs: attempt.latencyMs,
    ...(attempt.note !== undefined ? { note: attempt.note.slice(0, 200) } : {}),
  }));
}

/** 成功条目：providers 恒记录；identifiers 去重封顶后非空才写（保持 artifact 紧凑） */
function executedEntry(
  base: {
    executionId: string;
    queryId: string;
    query: string;
    kind: ResearchQueryKind;
    timestamp: string;
    planId: string;
  },
  resultCount: number,
  providers: PlanExecutionProviderAttempt[],
  identifiers: string[],
): PlanExecutionEntry {
  const resultIdentifiers = dedupeIdentifiers(identifiers).slice(0, MAX_RESULT_IDENTIFIERS_PER_ENTRY);
  return {
    ...base,
    status: "executed",
    resultCount,
    providers,
    ...(resultIdentifiers.length > 0 ? { resultIdentifiers } : {}),
  };
}

/** 学术结果的稳定标识符投影：DOI > arXiv > URL > 标题（前缀区分形态） */
function academicIdentifier(result: FusedAcademicResult): string {
  const record = result.record;
  if (record.doi !== undefined && record.doi !== "") {
    return `doi:${record.doi}`;
  }
  if (record.arxivId !== undefined && record.arxivId !== "") {
    return `arxiv:${record.arxivId}`;
  }
  if (record.url !== undefined && record.url !== "") {
    return record.url;
  }
  return `title:${(record.title ?? "").slice(0, 120)}`;
}

/** 保序去重 + 去空（同标识符跨 provider 命中只留一次） */
function dedupeIdentifiers(identifiers: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const identifier of identifiers) {
    const trimmed = identifier.trim();
    if (trimmed === "" || seen.has(trimmed)) {
      continue;
    }
    seen.add(trimmed);
    out.push(trimmed);
  }
  return out;
}
