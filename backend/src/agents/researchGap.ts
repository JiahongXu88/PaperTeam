/**
 * ResearchGap 领域模型 + HITL Service（M8.3.3：Controlled Research Loop
 * Foundation）。
 *
 * 把 M8.3.2 Coverage Analyzer 输出的缺口（gap）升级为**显式研究对象**：
 * 缺口带稳定标识（gapId）与严重度（severity），经用户确认（accept）后才
 * 可派生下一轮计划（derive）——受控研究循环是
 *
 *   Coverage → Research Gap（proposed）→ Human Approval（accepted）
 *   → Next Plan（draft，仍需批准才执行）→ Next Execution
 *
 * 的显式链，**不是无人值守循环**：M8.3.3 不自动执行任何一步。
 *
 * 冻结规则（M8 架构）全部遵守：
 * - 不新增 Agent（无 Planner / Coverage / Research Loop Agent）：纯 Service +
 *   纯函数，不调用 Runtime.runAgent、无 prompt（未来语义归因复用 Researcher
 *   通道，不增加角色）；
 * - 不修改 Runtime / Workflow Orchestrator：不进 workflowServices，缺口确认
 *   与派生是用户经 HTTP 显式触发的 research.json 数据操作；
 * - 不引入 RAG / Vector DB / MCP / 新 Provider / CLI；
 * - Evidence 链路原样：Gap 是**分析结果**，不是 Evidence——accept / reject /
 *   derive 只写 research.json（gaps 决策记录），不触碰 EvidenceStore /
 *   CandidateStore / SourceStore，Search Result ≠ Candidate ≠ Literature ≠
 *   Verified Evidence 分层不混写。
 *
 * 状态模型（HITL）：
 * - proposed：Coverage Analyzer 产出的唯一初始状态（结构上由 buildResearchGaps
 *   保证——分析器**只能**产生 proposed，永不自动 accepted）；
 * - accepted / rejected：用户显式决策落盘后的状态（决策快照存 research.json
 *   顶层可选 `gaps` 字段；proposed 是派生视图不落盘，与 M8.3.2「覆盖报告
 *   即时重算」同纪律，避免状态双写漂移）；
 * - 转换规则：proposed → accepted / rejected；已决策缺口重复同一决策幂等，
 *   反向决策 → 409 GAP_INVALID_STATE（决策不翻转，保持审计语义简单）；
 * - 派生门槛：只有 accepted 的缺口才能 derive 下一轮计划（Human Approval
 *   是循环的真实断点，不是记录性装饰）。
 *
 * gapId 稳定性：由 (planId + 关联问题 | 残差方向) 的 SHA-256 前 12 位十六进制
 * 确定性生成——同一计划同一问题/方向的缺口跨多次分析得到同一 id，用户决策
 * 才能可靠挂回；覆盖来源消失（问题转为 covered）时该缺口从派生视图自然
 * 消失，决策记录休眠（不删除，方向再次出现时自动恢复显示）。
 */

import { createHash } from "node:crypto";

import { BusinessError } from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { ResearchCoverageQuestion, ResearchCoverageService } from "./researchCoverage.js";
import type { ResearchPlanIterationService } from "./researchPlanIteration.js";
import {
  parseResearchPlanDeriveInput,
  type ResearchPlan,
} from "./researchPlan.js";
import { readResearchArtifact, writeResearchLoopState, type ResearchArtifact } from "./ResearcherService.js";

// ---- 领域模型 ----

export type ResearchGapSeverity = "low" | "medium" | "high";
export type ResearchGapStatus = "proposed" | "accepted" | "rejected";

export interface ResearchGap {
  gapId: string;
  /** 产生该缺口的计划（= 分析时的活动计划） */
  planId: string;
  /** 关联的研究问题（report.literaturePlan 残差方向无关联问题，省略） */
  question?: string;
  description: string;
  severity: ResearchGapSeverity;
  /** 建议下一轮执行的检索词（确定性生成：问题原文 / 残差方向原文） */
  suggestedQueries: string[];
  /** proposed = 分析派生（不落盘）；accepted / rejected = 用户决策快照（落盘） */
  status: ResearchGapStatus;
  createdAt: string;
  /** 用户决策时间（proposed 省略） */
  decidedAt?: string;
}

/** 缺口条数硬帽（沿用 M8.3.2 MAX_COVERAGE_GAPS 语义；防 literaturePlan 膨胀） */
export const MAX_RESEARCH_GAPS = 30;

/** research.json 顶层 gaps 决策记录的条数硬帽（防无限增长；超限丢最旧） */
export const MAX_STORED_GAP_DECISIONS = 100;

// ---- gapId（确定性） ----

/**
 * 缺口稳定标识：`gap-` + SHA-256(planId + 问题/残差方向) 前 12 位十六进制。
 * 问题缺口按问题文本、残差缺口按方向文本分别取键——同计划同来源同缺口。
 */
export function deterministicGapId(
  planId: string,
  question: string | undefined,
  fallbackText: string,
): string {
  const key =
    question !== undefined ? `${planId}\nquestion\n${question}` : `${planId}\nresidual\n${fallbackText}`;
  return `gap-${createHash("sha256").update(key).digest("hex").slice(0, 12)}`;
}

// ---- 缺口构造（纯函数：Coverage 判定 → ResearchGap[]，只产生 proposed） ----

/**
 * 由覆盖判定结果 + 报告残差方向生成缺口清单（M8.3.2 buildCoverageGaps 的
 * 升级面：每条缺口带 gapId / severity / status=proposed）：
 * - missing 且无关联检索 → high（计划完全没有该方向）；
 * - missing 但有相关检索未带回结果 → medium（有方向无产出）；
 * - partial → low（有结果，缺证据 / 入库文献支撑）；
 * - literaturePlan 残差方向 → medium（调研方声明的检索后残差）。
 * 同 gapId（同问题 / 同方向重复出现）只保留首条。
 */
export function buildResearchGaps(input: {
  planId: string;
  /** 报告时间戳（分析时刻），作为缺口 createdAt */
  createdAt: string;
  questions: ResearchCoverageQuestion[];
  literaturePlan: string[];
}): ResearchGap[] {
  const gaps: ResearchGap[] = [];
  const seen = new Set<string>();
  for (const entry of input.questions) {
    if (entry.coverage === "covered") {
      continue;
    }
    const gapId = deterministicGapId(input.planId, entry.question, entry.question);
    if (seen.has(gapId)) {
      continue;
    }
    seen.add(gapId);
    gaps.push({
      gapId,
      planId: input.planId,
      question: entry.question,
      description: entry.gap ?? "该研究问题未被覆盖",
      severity:
        entry.coverage === "partial"
          ? "low"
          : entry.relatedQueryCount === 0
            ? "high"
            : "medium",
      suggestedQueries: [entry.question],
      status: "proposed",
      createdAt: input.createdAt,
    });
  }
  for (const direction of input.literaturePlan) {
    const text = direction.trim();
    if (text === "") {
      continue;
    }
    const gapId = deterministicGapId(input.planId, undefined, text);
    if (seen.has(gapId)) {
      continue;
    }
    seen.add(gapId);
    gaps.push({
      gapId,
      planId: input.planId,
      description: `调研报告登记的残差文献方向：${text}`,
      severity: "medium",
      suggestedQueries: [text],
      status: "proposed",
      createdAt: input.createdAt,
    });
  }
  return gaps.slice(0, MAX_RESEARCH_GAPS);
}

/**
 * 读取 research.json 顶层 gaps 决策记录（宽容读取：形状非法的条目按不存在
 * 处理，不炸读取端；proposed 条目不允许出现在落盘侧——读取时过滤）。
 */
export function readGapDecisions(artifact: ResearchArtifact): ResearchGap[] {
  if (!Array.isArray(artifact.gaps)) {
    return [];
  }
  return artifact.gaps.filter(
    (gap): gap is ResearchGap =>
      typeof gap === "object" &&
      gap !== null &&
      typeof gap.gapId === "string" &&
      gap.gapId !== "" &&
      (gap.status === "accepted" || gap.status === "rejected"),
  );
}

/**
 * 决策覆盖（纯函数）：派生缺口（proposed）按 gapId 挂回用户决策。
 * 已决策缺口以**落盘快照**为准（决策记录语义：当时确认的内容），未决策
 * 缺口保持派生视图（proposed，随覆盖源数据即时重算）。
 */
export function mergeGapDecisions(derived: ResearchGap[], decisions: ResearchGap[]): ResearchGap[] {
  const byId = new Map(decisions.map((gap) => [gap.gapId, gap]));
  return derived.map((gap) => byId.get(gap.gapId) ?? gap);
}

// ---- Service（HITL 装配层：list / accept / reject / derive） ----

export interface ResearchGapServiceOptions {
  projects: ProjectStore;
  /** M8.3.2 覆盖分析（只读派生视图；缺口的唯一来源） */
  coverage: ResearchCoverageService;
  /** M8.3.1 计划迭代（derive 复用入口——不创建第二套 Plan 创建逻辑） */
  planIteration: ResearchPlanIterationService;
  log?: (message: string) => void;
}

/**
 * Research Gap Service：Coverage 缺口的 HITL 确认与派生入口。
 * 只写 research.json 的 gaps 决策记录（经 writeResearchLoopState 单一写入口）；
 * 派生下一轮计划委托 ResearchPlanIterationService.derive（旧计划永不被改写）。
 */
export class ResearchGapService {
  private readonly projects: ProjectStore;
  private readonly coverage: ResearchCoverageService;
  private readonly planIteration: ResearchPlanIterationService;
  private readonly log: (message: string) => void;

  constructor(options: ResearchGapServiceOptions) {
    this.projects = options.projects;
    this.coverage = options.coverage;
    this.planIteration = options.planIteration;
    this.log = options.log ?? (() => {});
  }

  /**
   * 当前活动计划的缺口清单（GET /research/gaps）：
   * 即时重算覆盖（确定性 gapId）+ 决策覆盖（accepted / rejected 快照）。
   * 无 artifact / 无计划 → 空态（planId:null + gaps:[]，不报错）。
   */
  async list(projectId: string): Promise<{ planId: string | null; gaps: ResearchGap[] }> {
    const artifact = await readResearchArtifact(this.projects, projectId);
    if (artifact === null) {
      return { planId: null, gaps: [] };
    }
    const coverage = await this.coverage.get(projectId);
    if (coverage === null) {
      return { planId: null, gaps: [] };
    }
    return {
      planId: coverage.planId,
      gaps: mergeGapDecisions(coverage.gaps, readGapDecisions(artifact)),
    };
  }

  /** 接受缺口（proposed → accepted；幂等；已拒绝 → 409 不翻转） */
  async accept(projectId: string, gapId: string): Promise<ResearchGap> {
    return this.decide(projectId, gapId, "accepted");
  }

  /** 拒绝缺口（proposed → rejected；幂等；已接受 → 409 不翻转） */
  async reject(projectId: string, gapId: string): Promise<ResearchGap> {
    return this.decide(projectId, gapId, "rejected");
  }

  /**
   * 从缺口派生下一轮计划（POST /research/gaps/:gapId/derive）：
   * - 缺口必须为 accepted（Human Approval 断点）→ 否则 409 GAP_INVALID_STATE；
   * - 请求体全部可选（query modifications）：缺省 questions = 缺口关联问题
   *   （残差缺口无问题 → 整拷来源计划问题），queries = suggestedQueries
   *   （kind=academic，rationale 登记缺口来源），提供则覆盖；
   * - 委托 ResearchPlanIterationService.derive（M8.3.1 单一派生逻辑）：
   *   新计划 draft、parentPlanId=来源、iterationNumber=链内最大+1、自动成为
   *   活动计划；来源计划保持原样不动；来源非 done → 409（同派生口径）。
   */
  async derive(
    projectId: string,
    gapId: string,
    body: Record<string, unknown>,
  ): Promise<ResearchPlan> {
    const { gap } = await this.loadDecidedGapOrThrow(projectId, gapId);
    if (gap.status !== "accepted") {
      throw new BusinessError(
        "GAP_INVALID_STATE",
        `只有已接受（accepted）的缺口才能派生下一轮计划（当前 ${gap.status}；请先接受该缺口）`,
      );
    }
    const input = parseResearchPlanDeriveInput(body);
    const defaultQueries = gap.suggestedQueries.map((query) => ({
      query,
      kind: "academic" as const,
      rationale: `来自研究缺口 ${gap.gapId}：${gap.description.slice(0, 120)}`,
    }));
    // 缺口默认值 + 用户改写合并（用户字段优先；两者都缺 → 整拷来源计划的
    // M8.3.1 derive 缺省语义），再经 planIteration.derive 的同一校验落盘
    const merged: Record<string, unknown> = {
      ...(input.questions !== undefined
        ? { questions: input.questions }
        : gap.question !== undefined
          ? { questions: [gap.question] }
          : {}),
      ...(input.queries !== undefined || defaultQueries.length > 0
        ? { queries: input.queries ?? defaultQueries }
        : {}),
    };
    const plan = await this.planIteration.derive(projectId, gap.planId, merged);
    this.log(
      `[research-gap] projectId=${projectId} 从缺口派生新计划：gapId=${gap.gapId} parent=${gap.planId} iteration=${plan.iterationNumber} planId=${plan.planId}`,
    );
    return plan;
  }

  /** 通用决策落盘（accept / reject 共用）：派生缺口存在性校验 + 幂等 + 409 */
  private async decide(
    projectId: string,
    gapId: string,
    decision: "accepted" | "rejected",
  ): Promise<ResearchGap> {
    const { artifact, gap } = await this.loadDecidedGapOrThrow(projectId, gapId);
    if (gap.status === decision) {
      return gap; // 幂等：重复同一决策不写盘
    }
    if (gap.status !== "proposed") {
      throw new BusinessError(
        "GAP_INVALID_STATE",
        `缺口 ${gapId} 已是 ${gap.status}，不能改为 ${decision}（决策不翻转；如需改向请重新分析覆盖）`,
      );
    }
    const decided: ResearchGap = {
      ...gap,
      status: decision,
      decidedAt: new Date().toISOString(),
    };
    const decisions = readGapDecisions(artifact).filter((entry) => entry.gapId !== gapId);
    const next = [...decisions, decided].slice(-MAX_STORED_GAP_DECISIONS);
    await writeResearchLoopState(this.projects, projectId, artifact, { gaps: next });
    this.log(
      `[research-gap] projectId=${projectId} 缺口${decision === "accepted" ? "已接受" : "已拒绝"}：gapId=${gapId} planId=${gap.planId}`,
    );
    return decided;
  }

  /**
   * 读 artifact + 决策覆盖后的缺口（accept / reject / derive 共用前置）：
   * 无 artifact / 无计划 → 404（与 coverage analyze 同口径）；gapId 不在当前
   * 派生缺口中（含已决策但覆盖来源已消失的休眠决策）→ 404。
   */
  private async loadDecidedGapOrThrow(
    projectId: string,
    gapId: string,
  ): Promise<{ artifact: ResearchArtifact; gap: ResearchGap }> {
    const artifact = await readResearchArtifact(this.projects, projectId);
    if (artifact === null) {
      throw new BusinessError(
        "NOT_FOUND",
        "项目还没有调研结果（research/research.json 不存在），请先运行调研",
      );
    }
    const coverage = await this.coverage.get(projectId);
    if (coverage === null) {
      throw new BusinessError(
        "NOT_FOUND",
        "项目还没有研究计划（research artifact 无 plan 字段），请先运行调研或编辑生成计划",
      );
    }
    const gap = mergeGapDecisions(coverage.gaps, readGapDecisions(artifact)).find(
      (entry) => entry.gapId === gapId,
    );
    if (gap === undefined) {
      throw new BusinessError(
        "NOT_FOUND",
        `研究缺口 ${gapId} 不存在（可能已随覆盖变化消失；可先 GET /research/gaps 查看当前缺口）`,
      );
    }
    return { artifact, gap };
  }
}
