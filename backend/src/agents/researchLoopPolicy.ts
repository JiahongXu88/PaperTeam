/**
 * Research Loop Policy（M8.3.3：受控研究循环的最小边界模型）。
 *
 * 目的：为**未来**的自动循环（M8.4 受控多轮检索）预注册边界——最大迭代
 * 数、单轮检索预算、停止条件。M8.3.3 **不自动执行循环**（没有 while loop、
 * 没有调度器、没有自动 derive / execute）；本文件只做三件事：
 *
 * 1. 定义策略模型（ResearchLoopPolicy）与缺省值（DEFAULT_RESEARCH_LOOP_POLICY）；
 * 2. 校验（parseResearchLoopPolicy：非法值 → 400 INVALID_REQUEST）；
 * 3. 经 research.json 顶层可选 `loopPolicy` 字段读写（GET 默认值不落盘 /
 *    PUT 校验后经 writeResearchLoopState 单一写入口保存）。
 *
 * 策略是 research state 的一部分（跟随项目），不是全局配置——不同项目
 * 可以有不同的循环预算。停止条件是**声明式**的枚举集合，供未来的循环
 * 编排层评估；M8.3.3 的任何代码路径都不读取它做控制流。
 */

import { BusinessError } from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { readResearchArtifact, writeResearchLoopState } from "./ResearcherService.js";

export type ResearchLoopStopCondition = "no_new_coverage" | "budget_exceeded" | "iteration_limit";

export const RESEARCH_LOOP_STOP_CONDITIONS: readonly ResearchLoopStopCondition[] = [
  "no_new_coverage",
  "budget_exceeded",
  "iteration_limit",
];

export interface ResearchLoopPolicy {
  /** 单条迭代线索内的最大计划轮数 */
  maxIterations: number;
  /** 单轮计划允许执行的检索条数上限 */
  maxQueriesPerIteration: number;
  /**
   * 整个循环生命周期的检索预算（M8.4 最小扩展）：按轮次执行记录的
   * executed + failed 真实计数消耗（每条都是真实发生过的 provider 调用，
   * 不估算、不伪造 token 成本）。达到预算 → budget_exceeded 停止。
   */
  maxTotalQueries: number;
  /** 声明式停止条件（M8.4 循环编排层的评估输入） */
  stopConditions: ResearchLoopStopCondition[];
}

export const DEFAULT_RESEARCH_LOOP_POLICY: ResearchLoopPolicy = {
  maxIterations: 5,
  maxQueriesPerIteration: 20,
  maxTotalQueries: 100,
  stopConditions: [...RESEARCH_LOOP_STOP_CONDITIONS],
};

/** 校验边界（M8.3 冻结：不追求无限弹性，给出可审计的硬边界） */
export const MAX_LOOP_ITERATIONS_LIMIT = 20;
export const MAX_LOOP_QUERIES_PER_ITERATION_LIMIT = 100;
export const MAX_LOOP_TOTAL_QUERIES_LIMIT = 500;

/**
 * 校验并归一 PUT /research/loop-policy 请求体（不符合契约 → 400）：
 * 全部字段可选（缺省取当前字段默认值），提供则必须合法——
 * maxIterations / maxQueriesPerIteration 为闭区间内的整数；
 * stopConditions 是已知枚举的非空子集（去重、保持声明顺序）。
 */
export function parseResearchLoopPolicy(body: Record<string, unknown>): ResearchLoopPolicy {
  const maxIterations = readBoundedInteger(body["maxIterations"], "maxIterations", 1, MAX_LOOP_ITERATIONS_LIMIT, DEFAULT_RESEARCH_LOOP_POLICY.maxIterations);
  const maxQueriesPerIteration = readBoundedInteger(
    body["maxQueriesPerIteration"],
    "maxQueriesPerIteration",
    1,
    MAX_LOOP_QUERIES_PER_ITERATION_LIMIT,
    DEFAULT_RESEARCH_LOOP_POLICY.maxQueriesPerIteration,
  );
  const maxTotalQueries = readBoundedInteger(
    body["maxTotalQueries"],
    "maxTotalQueries",
    1,
    MAX_LOOP_TOTAL_QUERIES_LIMIT,
    DEFAULT_RESEARCH_LOOP_POLICY.maxTotalQueries,
  );
  let stopConditions = DEFAULT_RESEARCH_LOOP_POLICY.stopConditions;
  if (body["stopConditions"] !== undefined) {
    const value = body["stopConditions"];
    if (!Array.isArray(value) || value.length === 0) {
      throw new BusinessError(
        "INVALID_REQUEST",
        `字段 stopConditions 必须是非空数组（可选值：${RESEARCH_LOOP_STOP_CONDITIONS.join(" / ")}）`,
      );
    }
    const known = new Set<string>(RESEARCH_LOOP_STOP_CONDITIONS);
    const seen = new Set<string>();
    const parsed: string[] = [];
    for (const entry of value) {
      if (typeof entry !== "string" || !known.has(entry)) {
        throw new BusinessError(
          "INVALID_REQUEST",
          `stopConditions 含未知条目（可选值：${RESEARCH_LOOP_STOP_CONDITIONS.join(" / ")}）`,
        );
      }
      if (!seen.has(entry)) {
        seen.add(entry);
        parsed.push(entry);
      }
    }
    stopConditions = parsed as ResearchLoopStopCondition[];
  }
  return { maxIterations, maxQueriesPerIteration, maxTotalQueries, stopConditions };
}

/** 读取项目策略（落盘值优先；形状非法时自愈回默认值——读侧不抛错） */
export function readResearchLoopPolicyFrom(
  host: { loopPolicy?: unknown },
): ResearchLoopPolicy {
  const value = host.loopPolicy;
  if (typeof value !== "object" || value === null) {
    return { ...DEFAULT_RESEARCH_LOOP_POLICY, stopConditions: [...DEFAULT_RESEARCH_LOOP_POLICY.stopConditions] };
  }
  try {
    const record = value as Record<string, unknown>;
    return parseResearchLoopPolicy(record);
  } catch {
    return { ...DEFAULT_RESEARCH_LOOP_POLICY, stopConditions: [...DEFAULT_RESEARCH_LOOP_POLICY.stopConditions] };
  }
}

/**
 * GET /research/loop-policy 的后端：无 research.json → 返回默认值（空态而非
 * 错误——策略尚未保存不构成异常）。
 */
export async function getResearchLoopPolicy(
  projects: ProjectStore,
  projectId: string,
): Promise<ResearchLoopPolicy> {
  const artifact = await readResearchArtifact(projects, projectId);
  return artifact === null
    ? { ...DEFAULT_RESEARCH_LOOP_POLICY, stopConditions: [...DEFAULT_RESEARCH_LOOP_POLICY.stopConditions] }
    : readResearchLoopPolicyFrom(artifact);
}

/**
 * PUT /research/loop-policy 的后端：校验 → 保存到 research.json 顶层
 * loopPolicy 字段。无 research.json → 404（与 updateResearchPlan 同口径：
 * 策略挂在调研产物上，先运行调研）。
 */
export async function updateResearchLoopPolicy(
  projects: ProjectStore,
  projectId: string,
  body: Record<string, unknown>,
): Promise<ResearchLoopPolicy> {
  const artifact = await readResearchArtifact(projects, projectId);
  if (artifact === null) {
    throw new BusinessError(
      "NOT_FOUND",
      "项目还没有调研结果（research/research.json 不存在），请先运行调研再配置研究循环策略",
    );
  }
  const policy = parseResearchLoopPolicy(body);
  await writeResearchLoopState(projects, projectId, artifact, { loopPolicy: policy });
  return policy;
}

function readBoundedInteger(
  value: unknown,
  field: string,
  min: number,
  max: number,
  fallback: number,
): number {
  if (value === undefined) {
    return fallback;
  }
  if (typeof value !== "number" || !Number.isInteger(value) || value < min || value > max) {
    throw new BusinessError(
      "INVALID_REQUEST",
      `字段 ${field} 必须是 ${min}-${max} 之间的整数（缺省 ${fallback}）`,
    );
  }
  return value;
}
