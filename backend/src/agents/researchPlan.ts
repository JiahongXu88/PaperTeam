/**
 * ResearchPlan 领域模型（M8.1：Research Plan 一等产物；M8.3.1：Iteration）。
 *
 * ResearchPlan 是 Researcher Agent 的内部能力（不是新 Agent、不进 Workflow）：
 * 调研前制定「研究问题 + 检索词及其理由」，指导本次检索；ResearchReport
 * 仍是检索后的结果综合（两者在 Prompt 中明确区分，不混淆）。
 *
 * 存放：research/research.json 顶层的可选 `plan` 字段（Research Artifact
 * = { plan?, report, evidence, bibliography }）。旧 artifact 无 plan 仍可读
 * （plan 为可选字段，所有既有消费者不受影响）。
 *
 * M8.3.1 Iteration：计划完成后可派生下一轮（发现知识缺口 → 调整方向 →
 * 新计划）。iteration 字段（iterationId / parentPlanId? / iterationNumber）
 * 是纯数据模型能力——首轮 iterationNumber=1、无 parentPlanId；派生轮
 * +1 并指向来源。artifact 同步持有 `plans`（全部轮次）与 `activePlanId`；
 * 旧 artifact（单一 plan 字段、无 iteration 字段）读取时归一化为单轮链。
 *
 * 不变量：Plan 只是检索意图的声明，不改变 Retrieved ≠ Candidate ≠
 * Literature ≠ Verified Evidence 链路——plan.queries 不写任何持久化结果，
 * 执行回填（resultCount / status 流转）由 M8.2 执行层负责。
 */

import { randomUUID } from "node:crypto";

import { BusinessError } from "../errors.js";

export type ResearchPlanStatus = "draft" | "approved" | "executing" | "done";
export type ResearchQueryKind = "academic" | "web";
export type ResearchQueryStatus = "planned" | "executed" | "skipped";

// ---- Evidence Requirement（M9.8：预写证据需求）----

/**
 * 未来正文需要做出的论断类型（M9.8 Phase 1，最小枚举——claimType 描述
 * 「正文要说什么」，不是证据形态）：background 含 survey 式背景性陈述
 * （任务书 §Phase 1 的 survey/background 归并为一类）。
 */
export type EvidenceClaimType =
  | "definition"
  | "mechanism"
  | "comparison"
  | "benchmark"
  | "limitation"
  | "background";

/** 期望的证据形态（描述「需要什么材料来支撑」） */
export type ExpectedEvidenceType = "survey" | "original_paper" | "benchmark_paper" | "system_paper";

/**
 * open = 待供给（唯一默认态；Agent 产出一律归一为 open）；
 * waived = 用户显式弃权（明知无此证据仍继续——诚实失败记录，只有编辑面能设置）。
 * 需求的覆盖状态（covered/partial/missing）永不持久化：由 Coverage Analyzer
 * 随源数据即时派生（M9.8 §3 Q3：不造第二个状态机）。
 */
export type EvidenceRequirementStatus = "open" | "waived";

export type EvidenceRequirementPriority = "high" | "medium" | "low";

export interface EvidenceRequirement {
  /** plan 内唯一（er-<n>，与 queryId 同分配策略） */
  requirementId: string;
  /** 未来正文需要支撑的主题（如「MemGPT 的记忆管理机制」） */
  topic: string;
  claimType: EvidenceClaimType;
  expectedEvidenceType: ExpectedEvidenceType;
  /** 预计落点章节（提示性，不与 outline 强绑定） */
  relatedSection?: string;
  priority: EvidenceRequirementPriority;
  status: EvidenceRequirementStatus;
  /** 为什么需要 / 为什么弃权 */
  note?: string;
}

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
  /**
   * 该检索供给的预写证据需求（M9.9 Phase 3 provenance：requirementId +
   * generated query + rationale 全部落 plan 可审计）。可选字段——普通检索
   * 无此关联；编辑面同 queryId 继承（与 resultCount 同策略），不可伪造。
   */
  requirementId?: string;
}

export interface ResearchPlan {
  planId: string;
  /**
   * 迭代线索 id（M8.3.1）：同一条派生链上的所有 plan 共享（首轮生成、
   * 派生继承），用于标识「同一次研究迭代过程」。旧 artifact 无此字段——
   * 读取归一化时以 planId 充当（稳定且无需持久化迁移即可参与派生）。
   */
  iterationId: string;
  /** 派生来源 planId（M8.3.1；首轮计划无此字段） */
  parentPlanId?: string;
  /** 迭代号（M8.3.1）：首轮 = 1，派生轮 = 链内最大值 + 1 */
  iterationNumber: number;
  status: ResearchPlanStatus;
  questions: string[];
  queries: ResearchPlanQuery[];
  /**
   * 预写证据需求（M9.8 Phase 1）：站在未来正文立场、先于检索声明的证据需求。
   * 可选字段——旧 artifact 无此字段仍可读（与 plan 字段本身的兼容策略一致）；
   * 覆盖对齐状态由 Coverage Analyzer 派生（requirementCoverage），不在此存储。
   */
  requirements?: EvidenceRequirement[];
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
export const EVIDENCE_CLAIM_TYPES: readonly EvidenceClaimType[] = [
  "definition",
  "mechanism",
  "comparison",
  "benchmark",
  "limitation",
  "background",
];
export const EXPECTED_EVIDENCE_TYPES: readonly ExpectedEvidenceType[] = [
  "survey",
  "original_paper",
  "benchmark_paper",
  "system_paper",
];
export const EVIDENCE_REQUIREMENT_STATUSES: readonly EvidenceRequirementStatus[] = [
  "open",
  "waived",
];

/** 单个 plan 的条数硬帽（防 Agent / API 输出爆炸；与既有 slice 上限同量级） */
export const MAX_PLAN_QUESTIONS = 30;
export const MAX_PLAN_QUERIES = 30;
/** 预写证据需求上限（M9.8：稿件规模量级，宁缺毋滥） */
export const MAX_PLAN_REQUIREMENTS = 12;

/** 新建 draft plan（planId / iteration 字段 / 时间戳由后端生成，模型与客户端均不指定）；首轮 iterationNumber=1 */
export function createResearchPlan(
  questions: string[],
  queries: Array<Pick<ResearchPlanQuery, "query" | "kind"> & Partial<ResearchPlanQuery>>,
  requirements: Array<EvidenceRequirementInput> = [],
): ResearchPlan {
  const now = new Date().toISOString();
  return {
    planId: newPlanId(),
    iterationId: newIterationId(),
    iterationNumber: 1,
    status: "draft",
    questions: questions.slice(0, MAX_PLAN_QUESTIONS),
    queries: queries
      .slice(0, MAX_PLAN_QUERIES)
      .map((query, index) => normalizePlanQuery(query, index)),
    ...(requirements.length > 0
      ? { requirements: normalizeRequirements(requirements) }
      : {}),
    createdAt: now,
    updatedAt: now,
  };
}

/** 编辑 / 派生 / 解析共用的需求输入形态（requirementId / status 由后端归一） */
export type EvidenceRequirementInput = Pick<
  EvidenceRequirement,
  "topic" | "claimType" | "expectedEvidenceType"
> &
  Partial<Pick<EvidenceRequirement, "relatedSection" | "priority" | "status" | "note">> &
  Partial<Pick<EvidenceRequirement, "requirementId">>;

/**
 * 需求条目归一（纯函数）：er-<n> 分配（与 assignQueryIds 同策略——保留既有
 * 不冲突 id，新 id 从最大序号之后取）；priority 非法回退 medium；status 缺省
 * open（Agent 产出一律归一 open，waived 只来自用户编辑）。
 */
function normalizeRequirements(inputs: EvidenceRequirementInput[]): EvidenceRequirement[] {
  const capped = inputs.slice(0, MAX_PLAN_REQUIREMENTS);
  const used = new Set<string>();
  let next = 1;
  for (const input of capped) {
    if (input.requirementId !== undefined && input.requirementId !== "") {
      used.add(input.requirementId);
      const suffix = /^er-(\d+)$/.exec(input.requirementId);
      if (suffix !== null) {
        next = Math.max(next, Number(suffix[1]) + 1);
      }
    }
  }
  return capped.map((input) => {
    let requirementId = input.requirementId;
    if (requirementId === undefined || requirementId === "") {
      while (used.has(`er-${next}`)) {
        next += 1;
      }
      requirementId = `er-${next}`;
      used.add(requirementId);
      next += 1;
    }
    return {
      requirementId,
      topic: input.topic.trim(),
      claimType: input.claimType,
      expectedEvidenceType: input.expectedEvidenceType,
      ...(input.relatedSection !== undefined ? { relatedSection: input.relatedSection } : {}),
      priority: input.priority ?? "medium",
      status: input.status ?? "open",
      ...(input.note !== undefined ? { note: input.note } : {}),
    };
  });
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
  const requirements = parseEvidenceRequirements(record);
  if (questions.length === 0 && queries.length === 0) {
    return undefined; // 空 plan 视为未产出（不给 UI 留空壳）
  }
  const now = new Date().toISOString();
  return {
    planId: newPlanId(),
    iterationId: newIterationId(),
    iterationNumber: 1,
    status: "draft",
    questions,
    queries: assignQueryIds(queries),
    ...(requirements.length > 0 ? { requirements } : {}),
    createdAt: now,
    updatedAt: now,
  };
}

/**
 * 宽容解析 plan.requirements（M9.8 Phase 2）：单条非法（缺 topic / 枚举非法）
 * 丢弃该条不炸整体；status 一律重置 open（waived 是用户编辑面的显式动作，
 * Agent 输出不接受）；超上限截断。无 requirements 字段 = 空数组（旧契约兼容）。
 */
export function parseEvidenceRequirements(
  planRecord: Record<string, unknown>,
): EvidenceRequirement[] {
  const raw = planRecord["requirements"];
  if (!Array.isArray(raw)) {
    return [];
  }
  const inputs: EvidenceRequirementInput[] = [];
  for (const entry of raw.slice(0, MAX_PLAN_REQUIREMENTS)) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const topic = typeof record["topic"] === "string" ? record["topic"].trim() : "";
    const claimType = record["claimType"];
    const expectedEvidenceType = record["expectedEvidenceType"];
    if (
      topic === "" ||
      !EVIDENCE_CLAIM_TYPES.includes(claimType as EvidenceClaimType) ||
      !EXPECTED_EVIDENCE_TYPES.includes(expectedEvidenceType as ExpectedEvidenceType)
    ) {
      continue; // 缺主题 / 枚举非法的需求直接丢弃
    }
    const priority = record["priority"];
    const relatedSection = readOptionalTrimmed(record["relatedSection"]);
    const note = readOptionalTrimmed(record["note"]);
    inputs.push({
      topic,
      claimType: claimType as EvidenceClaimType,
      expectedEvidenceType: expectedEvidenceType as ExpectedEvidenceType,
      ...(relatedSection !== undefined ? { relatedSection } : {}),
      ...(priority === "high" || priority === "medium" || priority === "low" ? { priority } : {}),
      status: "open", // Agent 产出不可自带 waived（见函数注释）
      ...(note !== undefined ? { note } : {}),
    });
  }
  return normalizeRequirements(inputs);
}

/** PUT /research/plan 的合法请求体（questions / queries / requirements 至少其一，整体替换语义） */
export interface ResearchPlanUpdateInput {
  questions?: string[];
  queries?: ResearchPlanQueryUpdateInput[];
  /** M9.8：预写证据需求（整体替换；status=waived 只能经此路径设置） */
  requirements?: EvidenceRequirementUpdateInput[];
}

export interface ResearchPlanQueryUpdateInput {
  queryId?: string;
  query: string;
  kind: ResearchQueryKind;
  rationale?: string;
  expectedCoverage?: string;
  status?: ResearchQueryStatus;
}

export interface EvidenceRequirementUpdateInput {
  requirementId?: string;
  topic: string;
  claimType: EvidenceClaimType;
  expectedEvidenceType: ExpectedEvidenceType;
  relatedSection?: string;
  priority?: EvidenceRequirementPriority;
  status?: EvidenceRequirementStatus;
  note?: string;
}

/**
 * 校验 PUT 请求体（不符合契约 → INVALID_REQUEST 400）。
 * resultCount / plan status 不在接受范围内：执行状态由执行侧（M8.2）回填，
 * 编辑面只允许改 questions / query / rationale / query status。
 */
export function parseResearchPlanUpdateInput(body: Record<string, unknown>): ResearchPlanUpdateInput {
  const hasQuestions = body["questions"] !== undefined;
  const hasQueries = body["queries"] !== undefined;
  const hasRequirements = body["requirements"] !== undefined;
  if (!hasQuestions && !hasQueries && !hasRequirements) {
    throw new BusinessError("INVALID_REQUEST", "请求体必须包含 questions / queries / requirements 之一");
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
  let requirements: EvidenceRequirementUpdateInput[] | undefined;
  if (hasRequirements) {
    const value = body["requirements"];
    if (!Array.isArray(value)) {
      throw new BusinessError("INVALID_REQUEST", "字段 requirements 必须是数组");
    }
    if (value.length > MAX_PLAN_REQUIREMENTS) {
      throw new BusinessError(
        "INVALID_REQUEST",
        `证据需求最多 ${MAX_PLAN_REQUIREMENTS} 条（收到 ${value.length} 条）`,
      );
    }
    requirements = value.map((entry, index) => {
      if (typeof entry !== "object" || entry === null) {
        throw new BusinessError("INVALID_REQUEST", `requirements[${index}] 必须是 JSON 对象`);
      }
      const record = entry as Record<string, unknown>;
      const topic = typeof record["topic"] === "string" ? record["topic"].trim() : "";
      if (topic === "") {
        throw new BusinessError("INVALID_REQUEST", `requirements[${index}].topic 必须是非空字符串`);
      }
      const claimType = record["claimType"];
      if (!EVIDENCE_CLAIM_TYPES.includes(claimType as EvidenceClaimType)) {
        throw new BusinessError(
          "INVALID_REQUEST",
          `requirements[${index}].claimType 只能是 ${EVIDENCE_CLAIM_TYPES.join(" / ")}`,
        );
      }
      const expectedEvidenceType = record["expectedEvidenceType"];
      if (!EXPECTED_EVIDENCE_TYPES.includes(expectedEvidenceType as ExpectedEvidenceType)) {
        throw new BusinessError(
          "INVALID_REQUEST",
          `requirements[${index}].expectedEvidenceType 只能是 ${EXPECTED_EVIDENCE_TYPES.join(" / ")}`,
        );
      }
      const priority = record["priority"];
      if (
        priority !== undefined &&
        priority !== "high" &&
        priority !== "medium" &&
        priority !== "low"
      ) {
        throw new BusinessError(
          "INVALID_REQUEST",
          `requirements[${index}].priority 只能是 high / medium / low`,
        );
      }
      const status = record["status"];
      if (status !== undefined && status !== "open" && status !== "waived") {
        throw new BusinessError(
          "INVALID_REQUEST",
          `requirements[${index}].status 只能是 open / waived`,
        );
      }
      const requirementId = readOptionalTrimmed(record["requirementId"]);
      const relatedSection = readOptionalTrimmed(record["relatedSection"]);
      const note = readOptionalTrimmed(record["note"]);
      return {
        ...(requirementId !== undefined ? { requirementId } : {}),
        topic,
        claimType: claimType as EvidenceClaimType,
        expectedEvidenceType: expectedEvidenceType as ExpectedEvidenceType,
        ...(relatedSection !== undefined ? { relatedSection } : {}),
        ...(priority !== undefined ? { priority: priority as EvidenceRequirementPriority } : {}),
        ...(status !== undefined ? { status: status as EvidenceRequirementStatus } : {}),
        ...(note !== undefined ? { note } : {}),
      };
    });
  }
  return {
    ...(questions !== undefined ? { questions } : {}),
    ...(queries !== undefined ? { queries } : {}),
    ...(requirements !== undefined ? { requirements } : {}),
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
        // M9.9：需求供给关联同策略继承（系统记录的 linkage，编辑不冲掉）
        ...(existing?.requirementId !== undefined ? { requirementId: existing.requirementId } : {}),
      });
    }
    queries = assignQueryIds(merged);
  }
  // M9.8：需求整体替换（与 questions / queries 同语义）——无执行回填字段需要
  // 继承，同 requirementId 条目原样收编（id 稳定），新条目由 normalizeRequirements
  // 分配不冲突的 er-<n>；waived 只能经该路径写入（PUT 是用户动作）。
  const requirements =
    input.requirements !== undefined
      ? normalizeRequirements(input.requirements)
      : plan.requirements;
  return {
    ...plan,
    ...(input.questions !== undefined ? { questions: input.questions } : {}),
    queries,
    ...(requirements !== undefined ? { requirements } : {}),
    updatedAt: new Date().toISOString(),
  };
}

// ---- Iteration / Plan Chain（M8.3.1）----

/**
 * 落盘形态的 plan：iteration 字段在旧 artifact（M8.1 / M8.2）上可能缺失，
 * 读取后一律经 readPlanChain 归一化为完整 ResearchPlan 再参与业务逻辑。
 */
export type StoredResearchPlan = Omit<ResearchPlan, "iterationId" | "iterationNumber"> & {
  iterationId?: string;
  iterationNumber?: number;
};

/** 计划链（research.json 顶层 plans + activePlanId 的领域形态） */
export interface ResearchPlanChain {
  /** 全部迭代轮次（按 iterationNumber 升序；同号保持落盘顺序） */
  plans: ResearchPlan[];
  /** 当前活动计划 id（编辑 / 批准 / 执行都作用于它；空链时 undefined） */
  activePlanId: string | undefined;
}

/** 能挂计划链的 artifact 结构（ResearchArtifact 的结构子集，便于纯函数复用） */
export interface PlanChainHost {
  /** 兼容视图：始终等于活动计划（与 plans / activePlanId 由同一写入口保持一致） */
  plan?: StoredResearchPlan;
  plans?: StoredResearchPlan[];
  activePlanId?: string;
}

/**
 * 读取 artifact 的计划链（读写迁移的读侧，返回新对象不改入参）：
 * - M8.3.1 形态（plans + activePlanId）：activePlanId 缺失或指向不存在的 plan
 *   → 回落最新一轮（数据自愈，不抛错）；
 * - 旧形态（单一 plan 字段，M8.1 / M8.2 artifact）：归一化为单轮链——iteration
 *   字段缺失时 iterationNumber=1、iterationId 以 planId 充当（首次写回时固化）；
 * - 均无 → 空链。
 */
export function readPlanChain(host: PlanChainHost): ResearchPlanChain {
  if (Array.isArray(host.plans)) {
    const plans = host.plans
      .filter((plan): plan is StoredResearchPlan => typeof plan === "object" && plan !== null && typeof plan.planId === "string")
      .map(normalizePlanEntry)
      .sort((a, b) => a.iterationNumber - b.iterationNumber || a.createdAt.localeCompare(b.createdAt));
    if (plans.length > 0) {
      const activePlanId =
        host.activePlanId !== undefined && plans.some((plan) => plan.planId === host.activePlanId)
          ? host.activePlanId
          : plans[plans.length - 1]!.planId;
      return { plans, activePlanId };
    }
  }
  if (typeof host.plan === "object" && host.plan !== null && typeof host.plan.planId === "string") {
    const plan = normalizePlanEntry(host.plan);
    return { plans: [plan], activePlanId: plan.planId };
  }
  return { plans: [], activePlanId: undefined };
}

/**
 * 写侧：把链展开为 artifact 顶层字段。plan（active 兼容视图）、plans、
 * activePlanId 三者由本函数一次性产出——所有写入口共用，保证不漂移；
 * 空链返回空对象（artifact 上不出现 plan 相关字段，与 M8.1 旧契约一致）。
 */
export function planChainFields(
  chain: ResearchPlanChain,
): { plan: ResearchPlan; plans: ResearchPlan[]; activePlanId: string } | Record<string, never> {
  if (chain.plans.length === 0 || chain.activePlanId === undefined) {
    return {};
  }
  const active =
    chain.plans.find((plan) => plan.planId === chain.activePlanId) ??
    chain.plans[chain.plans.length - 1]!;
  return { plan: active, plans: chain.plans, activePlanId: active.planId };
}

/**
 * research() 重跑时的计划链合并策略（M8.3.1，纯函数）：
 * - 已有链（含旧 artifact 的单轮链）→ 原样保留。questions / queries 是用户
 *   可控字段（PUT 可改），status / resultCount 是执行回填字段，均不由重跑
 *   覆盖——「用户修改优先」；
 * - 无链且本轮 Agent 产出合法 plan → 以其初始化 iteration 1（M8.1 首跑语义）；
 * - 无链且无 plan → 空链（M8.1 旧输出契约兼容）。
 * Agent 在重跑时产出的新 plan 不落盘：重跑只刷新报告（report / evidence /
 * bibliography），计划演化走「编辑计划」或「派生新计划」的显式路径，
 * 防止隐式改写用户计划与执行历史。
 */
export function resolvePlanChainOnRerun(
  existing: ResearchPlanChain,
  generated: ResearchPlan | undefined,
): ResearchPlanChain {
  if (existing.plans.length > 0) {
    return existing;
  }
  if (generated !== undefined) {
    return { plans: [generated], activePlanId: generated.planId };
  }
  return { plans: [], activePlanId: undefined };
}

/** 链内最大迭代号（空链 = 0；派生轮的 iterationNumber = 它 + 1） */
export function maxIterationNumber(plans: ResearchPlan[]): number {
  return plans.reduce((max, plan) => Math.max(max, plan.iterationNumber), 0);
}

// ---- Derive（M8.3.1：从完成的计划派生下一轮）----

/** POST /research/plan/:planId/derive 的合法请求体（全部可选：缺省整拷来源计划） */
export interface ResearchPlanDeriveInput {
  questions?: string[];
  queries?: ResearchPlanDeriveQueryInput[];
}

export interface ResearchPlanDeriveQueryInput {
  query: string;
  kind: ResearchQueryKind;
  rationale?: string;
  expectedCoverage?: string;
}

/**
 * 校验 derive 请求体（不符合契约 → INVALID_REQUEST 400）。与 PUT 的区别：
 * - 全部字段可选（什么都不传 = 整拷来源计划作为下一轮起点）；
 * - queries 不接受 queryId / status——新计划的检索全部从 planned 起步、
 *   queryId 由后端重新分配（执行回填不跨轮继承）。
 */
export function parseResearchPlanDeriveInput(body: Record<string, unknown>): ResearchPlanDeriveInput {
  const hasQuestions = body["questions"] !== undefined;
  const hasQueries = body["queries"] !== undefined;
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
  let queries: ResearchPlanDeriveQueryInput[] | undefined;
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
      if (record["queryId"] !== undefined) {
        throw new BusinessError(
          "INVALID_REQUEST",
          `queries[${index}].queryId 不被接受（派生计划由后端重新分配检索 id）`,
        );
      }
      if (record["status"] !== undefined) {
        throw new BusinessError(
          "INVALID_REQUEST",
          `queries[${index}].status 不被接受（派生计划的检索全部从 planned 起步）`,
        );
      }
      const query = typeof record["query"] === "string" ? record["query"].trim() : "";
      if (query === "") {
        throw new BusinessError("INVALID_REQUEST", `queries[${index}].query 必须是非空字符串`);
      }
      const kind = record["kind"];
      if (kind !== "academic" && kind !== "web") {
        throw new BusinessError("INVALID_REQUEST", `queries[${index}].kind 只能是 academic / web`);
      }
      const rationale = readOptionalTrimmed(record["rationale"]);
      const expectedCoverage = readOptionalTrimmed(record["expectedCoverage"]);
      return {
        query,
        kind,
        ...(rationale !== undefined ? { rationale } : {}),
        ...(expectedCoverage !== undefined ? { expectedCoverage } : {}),
      };
    });
  }
  return {
    ...(questions !== undefined ? { questions } : {}),
    ...(queries !== undefined ? { queries } : {}),
  };
}

/**
 * 构造派生计划（纯函数，落盘由调用方负责）：
 * - questions / queries 缺省整拷来源（作为下一轮起点），提供则覆盖；
 * - 拷贝的检索条目重置为 planned、丢弃 resultCount、重新分配 queryId——
 *   执行状态不跨轮继承，下一轮是全新计划；
 * - iterationId 继承来源（同一迭代线索），parentPlanId 指向来源，
 *   iterationNumber 由调用方按链内最大值 + 1 传入，status=draft。
 */
export function buildDerivedPlan(
  source: ResearchPlan,
  nextIterationNumber: number,
  input: ResearchPlanDeriveInput,
): ResearchPlan {
  const now = new Date().toISOString();
  const sourceQueries: Array<Pick<ResearchPlanQuery, "query" | "kind"> & Partial<ResearchPlanQuery>> =
    input.queries ??
    source.queries.map((query) => ({
      query: query.query,
      kind: query.kind,
      ...(query.rationale !== undefined ? { rationale: query.rationale } : {}),
      ...(query.expectedCoverage !== undefined ? { expectedCoverage: query.expectedCoverage } : {}),
    }));
  return {
    planId: newPlanId(),
    iterationId: source.iterationId,
    parentPlanId: source.planId,
    iterationNumber: nextIterationNumber,
    status: "draft",
    questions: input.questions ?? source.questions,
    queries: sourceQueries
      .slice(0, MAX_PLAN_QUERIES)
      .map((query, index) => normalizePlanQuery(query, index)),
    // M9.8：需求整拷来源（作为下一轮供给起点；需求无执行态，不重置——
    // waived 语义是「该需求已显式弃权」，跨轮保留才诚实）
    ...(source.requirements !== undefined && source.requirements.length > 0
      ? { requirements: source.requirements.slice(0, MAX_PLAN_REQUIREMENTS) }
      : {}),
    createdAt: now,
    updatedAt: now,
  };
}

// ---- Requirement Supply Query（M9.9 Phase 3：缺口驱动的补充检索）----

/** 期望证据形态 → 检索词提示词（确定性；无提示的形态用主题原词） */
const EVIDENCE_TYPE_QUERY_HINTS: Record<ExpectedEvidenceType, string> = {
  survey: "survey",
  original_paper: "",
  benchmark_paper: "benchmark",
  system_paper: "",
};

/** POST /research/requirements/supply-query 的合法请求体 */
export interface RequirementSupplyQueryInput {
  requirementId: string;
  /** 覆盖确定性派生词（缺省 = topic + 证据形态提示）；用户可改写 */
  query?: string;
  /** 缺省 academic */
  kind?: ResearchQueryKind;
}

/**
 * 从预写需求确定性派生供给检索词（纯函数，M9.9 Phase 3）：
 * query = topic + 证据形态提示（survey / benchmark；其余形态用主题原词）。
 * 主题原文进检索词——不翻译不改写（宁可检索面朴素，不虚构语义）；
 * 用户可在计划编辑面改写检索词后执行。
 */
export function buildRequirementSupplyQuery(
  requirement: EvidenceRequirement,
  coverageStatus: string,
): { query: string; kind: ResearchQueryKind; rationale: string } {
  const hint = EVIDENCE_TYPE_QUERY_HINTS[requirement.expectedEvidenceType];
  const query =
    requirement.topic.trim() + (hint !== "" ? ` ${hint}` : "");
  return {
    query,
    kind: "academic",
    rationale: `需求 ${requirement.requirementId}（${requirement.topic}）供给检索——当前覆盖 ${coverageStatus}`,
  };
}

/**
 * 把供给检索追加进活动计划（纯函数，落盘由调用方负责；M9.9 Phase 3）：
 * - 需求必须存在且 status=open（waived = 用户已显式弃权，不再供给）；
 * - 幂等守卫：该需求已有一条 planned 供给检索（同 requirementId）→ 拒绝
 *   （防重复点击堆叠查询；「禁止自动无限搜索」纪律的确定性落地）；
 * - 计划状态守卫：executing / done 的计划不接受追加（executing 等本轮完成；
 *   done 走「派生下一轮」显式路径，不静默改写已完成计划）；
 * - 新条目 status=planned、requirementId 记录 linkage、queryId 由
 *   assignQueryIds 分配——后续执行 / 快照 / 候选保存全部走既有链路。
 */
export function appendRequirementSupplyQuery(
  plan: ResearchPlan,
  input: RequirementSupplyQueryInput,
  coverageStatus: string,
): { plan: ResearchPlan; query: ResearchPlanQuery } {
  const requirement = plan.requirements?.find(
    (entry) => entry.requirementId === input.requirementId,
  );
  if (requirement === undefined) {
    throw new BusinessError(
      "NOT_FOUND",
      `计划中不存在需求 ${input.requirementId}（活动计划 ${plan.requirements?.length ?? 0} 条需求）`,
    );
  }
  if (requirement.status === "waived") {
    throw new BusinessError(
      "INVALID_REQUEST",
      `需求 ${input.requirementId} 已被用户显式弃权（waived），不再触发供给检索`,
    );
  }
  if (plan.status === "executing" || plan.status === "done") {
    throw new BusinessError(
      "INVALID_REQUEST",
      plan.status === "executing"
        ? "计划正在执行中，等本轮完成后再次追加供给检索"
        : "计划已完成（done）——请先经「派生下一轮」创建新计划，再对新缺口追加供给检索",
    );
  }
  const existingSupply = plan.queries.find(
    (entry) => entry.requirementId === input.requirementId && entry.status === "planned",
  );
  if (existingSupply !== undefined) {
    throw new BusinessError(
      "INVALID_REQUEST",
      `需求 ${input.requirementId} 已有待执行的供给检索（${existingSupply.queryId}：${existingSupply.query}），请先执行或编辑该条`,
    );
  }
  const derived = buildRequirementSupplyQuery(requirement, coverageStatus);
  const queryText = (input.query ?? derived.query).trim();
  if (queryText === "") {
    throw new BusinessError("INVALID_REQUEST", "供给检索词必须是非空字符串");
  }
  const appended: ResearchPlanQuery = {
    queryId: "",
    query: queryText,
    kind: input.kind ?? derived.kind,
    rationale: derived.rationale,
    status: "planned",
    requirementId: input.requirementId,
  };
  const queries = assignQueryIds([...plan.queries, appended]);
  return {
    plan: { ...plan, queries, updatedAt: new Date().toISOString() },
    query: queries[queries.length - 1]!,
  };
}

// ---- 内部工具 ----

/** 迭代线索 id：与 planId 同风格（it- + 12 位随机十六进制） */
function newIterationId(): string {
  return `it-${randomUUID().replaceAll("-", "").slice(0, 12)}`;
}

/** 落盘 plan → 完整领域对象：补齐旧 artifact 缺失的 iteration 字段（不丢其余字段） */
function normalizePlanEntry(plan: StoredResearchPlan): ResearchPlan {
  return {
    ...plan,
    iterationId:
      typeof plan.iterationId === "string" && plan.iterationId !== ""
        ? plan.iterationId
        : plan.planId, // 旧 artifact：以 planId 充当线索 id（稳定，写回时固化）
    ...(plan.parentPlanId !== undefined ? { parentPlanId: plan.parentPlanId } : {}),
    iterationNumber:
      typeof plan.iterationNumber === "number" &&
      Number.isInteger(plan.iterationNumber) &&
      plan.iterationNumber >= 1
        ? plan.iterationNumber
        : 1,
  };
}

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
