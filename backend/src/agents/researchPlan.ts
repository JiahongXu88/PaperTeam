/**
 * ResearchPlan 领域模型（M8.1：Research Plan 一等产物）。
 *
 * ResearchPlan 是 Researcher Agent 的内部能力（不是新 Agent、不进 Workflow）：
 * 调研前制定「研究问题 + 检索词及其理由」，指导本次检索；ResearchReport
 * 仍是检索后的结果综合（两者在 Prompt 中明确区分，不混淆）。
 *
 * 存放：research/research.json 顶层的可选 `plan` 字段（Research Artifact
 * = { plan?, report, evidence, bibliography }）。旧 artifact 无 plan 仍可读
 * （plan 为可选字段，所有既有消费者不受影响）。
 *
 * 不变量：Plan 只是检索意图的声明，不改变 Retrieved ≠ Candidate ≠
 * Literature ≠ Verified Evidence 链路——plan.queries 不写任何持久化结果，
 * 执行回填（resultCount / status 流转）留给 M8.2。
 */

import { randomUUID } from "node:crypto";

import { BusinessError } from "../errors.js";

export type ResearchPlanStatus = "draft" | "approved" | "executing" | "done";
export type ResearchQueryKind = "academic" | "web";
export type ResearchQueryStatus = "planned" | "executed" | "skipped";

export interface ResearchPlanQuery {
  queryId: string;
  query: string;
  kind: ResearchQueryKind;
  /** 为什么需要这条检索（计划理由） */
  rationale?: string;
  /** 期望覆盖的文献 / 信息面 */
  expectedCoverage?: string;
  status: ResearchQueryStatus;
  /** 执行后的结果数（执行侧回填；编辑 API 不接受该字段） */
  resultCount?: number;
}

export interface ResearchPlan {
  planId: string;
  status: ResearchPlanStatus;
  questions: string[];
  queries: ResearchPlanQuery[];
  createdAt: string;
  updatedAt: string;
}

export const RESEARCH_PLAN_STATUSES: readonly ResearchPlanStatus[] = [
  "draft",
  "approved",
  "executing",
  "done",
];
export const RESEARCH_QUERY_KINDS: readonly ResearchQueryKind[] = ["academic", "web"];
export const RESEARCH_QUERY_STATUSES: readonly ResearchQueryStatus[] = [
  "planned",
  "executed",
  "skipped",
];

/** 单个 plan 的条数硬帽（防 Agent / API 输出爆炸；与既有 slice 上限同量级） */
export const MAX_PLAN_QUESTIONS = 30;
export const MAX_PLAN_QUERIES = 30;

/** 新建 draft plan（planId / 时间戳由后端生成，模型与客户端均不指定） */
export function createResearchPlan(
  questions: string[],
  queries: Array<Pick<ResearchPlanQuery, "query" | "kind"> & Partial<ResearchPlanQuery>>,
): ResearchPlan {
  const now = new Date().toISOString();
  return {
    planId: newPlanId(),
    status: "draft",
    questions: questions.slice(0, MAX_PLAN_QUESTIONS),
    queries: queries
      .slice(0, MAX_PLAN_QUERIES)
      .map((query, index) => normalizePlanQuery(query, index)),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 从 Researcher Agent 输出解析 plan（宽容解析，与 readBibliography 同风格）：
 * - 无 plan 字段 / 非对象 → undefined（旧输出契约完全兼容）；
 * - 单条 query 非法（缺 query / kind 非法）→ 丢弃该条，不炸整次调研；
 * - 缺省补默认：query status=planned、plan status=draft，id 与时间戳后端生成。
 */
export function parseResearchPlan(parsed: Record<string, unknown>): ResearchPlan | undefined {
  const value = parsed["plan"];
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const questions = readTrimmedStrings(record["questions"]).slice(0, MAX_PLAN_QUESTIONS);
  const rawQueries = Array.isArray(record["queries"]) ? record["queries"] : [];
  const queries: ResearchPlanQuery[] = [];
  for (const raw of rawQueries.slice(0, MAX_PLAN_QUERIES)) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const queryRecord = raw as Record<string, unknown>;
    const queryText = typeof queryRecord["query"] === "string" ? queryRecord["query"].trim() : "";
    const kind = queryRecord["kind"];
    if (queryText === "" || kind !== "academic" && kind !== "web") {
      continue; // 缺检索词 / kind 非法的条目直接丢弃
    }
    queries.push({
      queryId: "",
      query: queryText,
      kind,
      ...(readOptionalTrimmed(queryRecord["rationale"]) !== undefined
        ? { rationale: readOptionalTrimmed(queryRecord["rationale"]) }
        : {}),
      ...(readOptionalTrimmed(queryRecord["expectedCoverage"]) !== undefined
        ? { expectedCoverage: readOptionalTrimmed(queryRecord["expectedCoverage"]) }
        : {}),
      status: "planned",
    });
  }
  if (questions.length === 0 && queries.length === 0) {
    return undefined; // 空 plan 视为未产出（不给 UI 留空壳）
  }
  const now = new Date().toISOString();
  return {
    planId: newPlanId(),
    status: "draft",
    questions,
    queries: assignQueryIds(queries),
    createdAt: now,
    updatedAt: now,
  };
}

/** PUT /research/plan 的合法请求体（questions / queries 至少其一，整体替换语义） */
export interface ResearchPlanUpdateInput {
  questions?: string[];
  queries?: ResearchPlanQueryUpdateInput[];
}

export interface ResearchPlanQueryUpdateInput {
  queryId?: string;
  query: string;
  kind: ResearchQueryKind;
  rationale?: string;
  expectedCoverage?: string;
  status?: ResearchQueryStatus;
}

/**
 * 校验 PUT 请求体（不符合契约 → INVALID_REQUEST 400）。
 * resultCount / plan status 不在接受范围内：执行状态由执行侧（M8.2）回填，
 * 编辑面只允许改 questions / query / rationale / query status。
 */
export function parseResearchPlanUpdateInput(body: Record<string, unknown>): ResearchPlanUpdateInput {
  const hasQuestions = body["questions"] !== undefined;
  const hasQueries = body["queries"] !== undefined;
  if (!hasQuestions && !hasQueries) {
    throw new BusinessError("INVALID_REQUEST", "请求体必须包含 questions 或 queries 之一");
  }
  let questions: string[] | undefined;
  if (hasQuestions) {
    const value = body["questions"];
    if (!Array.isArray(value)) {
      throw new BusinessError("INVALID_REQUEST", "字段 questions 必须是字符串数组");
    }
    if (value.length > MAX_PLAN_QUESTIONS) {
      throw new BusinessError(
        "INVALID_REQUEST",
        `研究问题最多 ${MAX_PLAN_QUESTIONS} 条（收到 ${value.length} 条）`,
      );
    }
    questions = value.map((entry, index) => {
      if (typeof entry !== "string" || entry.trim() === "") {
        throw new BusinessError("INVALID_REQUEST", `questions[${index}] 必须是非空字符串`);
      }
      return entry.trim();
    });
  }
  let queries: ResearchPlanQueryUpdateInput[] | undefined;
  if (hasQueries) {
    const value = body["queries"];
    if (!Array.isArray(value)) {
      throw new BusinessError("INVALID_REQUEST", "字段 queries 必须是数组");
    }
    if (value.length > MAX_PLAN_QUERIES) {
      throw new BusinessError(
        "INVALID_REQUEST",
        `检索计划最多 ${MAX_PLAN_QUERIES} 条（收到 ${value.length} 条）`,
      );
    }
    queries = value.map((entry, index) => {
      if (typeof entry !== "object" || entry === null) {
        throw new BusinessError("INVALID_REQUEST", `queries[${index}] 必须是 JSON 对象`);
      }
      const record = entry as Record<string, unknown>;
      const query = typeof record["query"] === "string" ? record["query"].trim() : "";
      if (query === "") {
        throw new BusinessError("INVALID_REQUEST", `queries[${index}].query 必须是非空字符串`);
      }
      const kind = record["kind"];
      if (kind !== "academic" && kind !== "web") {
        throw new BusinessError(
          "INVALID_REQUEST",
          `queries[${index}].kind 只能是 academic / web`,
        );
      }
      const status = record["status"];
      if (
        status !== undefined &&
        status !== "planned" &&
        status !== "executed" &&
        status !== "skipped"
      ) {
        throw new BusinessError(
          "INVALID_REQUEST",
          `queries[${index}].status 只能是 planned / executed / skipped`,
        );
      }
      const queryId = readOptionalTrimmed(record["queryId"]);
      const rationale = readOptionalTrimmed(record["rationale"]);
      const expectedCoverage = readOptionalTrimmed(record["expectedCoverage"]);
      return {
        ...(queryId !== undefined ? { queryId } : {}),
        query,
        kind,
        ...(rationale !== undefined ? { rationale } : {}),
        ...(expectedCoverage !== undefined ? { expectedCoverage } : {}),
        ...(status !== undefined ? { status } : {}),
      };
    });
  }
  return {
    ...(questions !== undefined ? { questions } : {}),
    ...(queries !== undefined ? { queries } : {}),
  };
}

/**
 * 把 PUT 输入合并进既有 plan（返回新对象，不改入参）：
 * - 提供的字段整体替换（questions / queries）；未提供的字段保持不变；
 * - 同 queryId 的既有条目：保留其 resultCount（执行状态不被编辑面冲掉），
 *   status 缺省时也保留既有值；新条目分配不冲突的 queryId（status 缺省 planned）；
 * - updatedAt 刷新；planId / status / createdAt 不变（状态流转留给 M8.2）。
 */
export function applyResearchPlanUpdate(
  plan: ResearchPlan,
  input: ResearchPlanUpdateInput,
): ResearchPlan {
  const existingById = new Map(plan.queries.map((query) => [query.queryId, query]));
  let queries = plan.queries;
  if (input.queries !== undefined) {
    const merged: ResearchPlanQuery[] = [];
    for (const entry of input.queries) {
      const existing =
        entry.queryId !== undefined ? existingById.get(entry.queryId) : undefined;
      const queryId =
        entry.queryId !== undefined && entry.queryId !== ""
          ? entry.queryId
          : existing?.queryId ?? "";
      const status = entry.status ?? existing?.status ?? "planned";
      merged.push({
        queryId,
        query: entry.query,
        kind: entry.kind,
        ...(entry.rationale !== undefined ? { rationale: entry.rationale } : {}),
        ...(entry.expectedCoverage !== undefined
          ? { expectedCoverage: entry.expectedCoverage }
          : {}),
        status,
        // 执行回填的结果数只在同 queryId 条目上继承，编辑面无法伪造
        ...(existing?.resultCount !== undefined ? { resultCount: existing.resultCount } : {}),
      });
    }
    queries = assignQueryIds(merged);
  }
  return {
    ...plan,
    ...(input.questions !== undefined ? { questions: input.questions } : {}),
    queries,
    updatedAt: new Date().toISOString(),
  };
}

// ---- 内部工具 ----

/** plan id：与项目 id 同风格（rp- + 12 位随机十六进制） */
function newPlanId(): string {
  return `rp-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

/**
 * 为缺 id 的 query 条目分配 q-<n>（1 起）：新 id 从既有 id 的最大序号之后取，
 * 保证一个 plan 内 queryId 唯一、且编辑往返（同 id 保留 + 增删条目）不漂移。
 */
function assignQueryIds(queries: ResearchPlanQuery[]): ResearchPlanQuery[] {
  const used = new Set<string>();
  let next = 1;
  for (const query of queries) {
    if (query.queryId !== "") {
      used.add(query.queryId);
      const suffix = /^q-(\d+)$/.exec(query.queryId);
      if (suffix !== null) {
        next = Math.max(next, Number(suffix[1]) + 1);
      }
    }
  }
  return queries.map((query) => {
    if (query.queryId !== "") {
      return query;
    }
    while (used.has(`q-${next}`)) {
      next += 1;
    }
    const queryId = `q-${next}`;
    used.add(queryId);
    next += 1;
    return { ...query, queryId };
  });
}

function normalizePlanQuery(
  query: Pick<ResearchPlanQuery, "query" | "kind"> & Partial<ResearchPlanQuery>,
  index: number,
): ResearchPlanQuery {
  return {
    queryId: `q-${index + 1}`,
    query: query.query.trim(),
    kind: query.kind,
    ...(query.rationale !== undefined ? { rationale: query.rationale } : {}),
    ...(query.expectedCoverage !== undefined
      ? { expectedCoverage: query.expectedCoverage }
      : {}),
    status: query.status ?? "planned",
  };
}

function readTrimmedStrings(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return value
    .filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "")
    .map((entry) => entry.trim());
}

function readOptionalTrimmed(value: unknown): string | undefined {
  return typeof value === "string" && value.trim() !== "" ? value.trim() : undefined;
}
