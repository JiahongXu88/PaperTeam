/**
 * Structured Synthesis 类型与确定性校验（M11.1.2）。
 *
 * 数据边界（延续 M11.1.1 的纪律）：
 * - Synthesis 是 Matrix 的跨论文综合层：LLM 只产出 candidate（claim /
 *   classification / comparison wording / 引用），最终 artifact 必须过代码
 *   守卫——groundingLevel 由 groundingRules 的确定性函数判定，模型自报的
 *   任何 grounding 字段在 parse 阶段直接忽略（结构上就不进入类型）；
 * - sourceIds 不接受模型输出：一律从 entryIds（= M-<sourceId>）派生，
 *   entryId 不存在于 Matrix → 剔除，剔除后不满足该 kind 最低支撑 → 整条
 *   拒绝（fail-closed，不落盘）；
 * - abstract_only 条目只能有限参与（归类 / 计数 / 宽口径统计）：它们没有
 *   chunk anchor，不可能成为 evidence proposal 的来源；是否拖累
 *   groundingLevel 由 groundingRules 按可靠锚点计数决定；
 * - synthesisId 是确定性纯函数（kind + normalized claim + sorted
 *   sourceIds 的 sha256 前 10 位）：无随机数 / 时钟，同输入重复 build 恒
 *   产生同一批 ID，跨 batch 完全重复按 fingerprint 合并；
 * - Matrix Interpretation ≠ Verified Evidence：evidence_backed 的唯一
 *   通道是 EvidenceGroundingService 的真实核验（verified EvidenceRecord），
 *   chunkId 存在 ≠ verified——该判定在服务层完成，本文件只定义形状。
 */

import { AgentRunFailedError } from "../errors.js";
import { sha256Hex } from "../util/hash.js";
import type { InterpretationDepth } from "./matrixTypes.js";

/** 七类 synthesis（M11.0 冻结方案） */
export type SurveySynthesisKind =
  | "taxonomy"
  | "trend"
  | "comparison"
  | "consensus"
  | "disagreement"
  | "research_gap"
  | "future_direction";

export const SURVEY_SYNTHESIS_KINDS: readonly SurveySynthesisKind[] = [
  "taxonomy",
  "trend",
  "comparison",
  "consensus",
  "disagreement",
  "research_gap",
  "future_direction",
];

/** grounding 三级（只有代码可以判定；LLM 无权自报） */
export type SynthesisGroundingLevel = "evidence_backed" | "literature_cited" | "speculative";

/** Research Gap 允许的触发来源（白名单之外 fail-closed 拒绝） */
export type ResearchGapTrigger =
  | "literature_limitation" // 来自多篇论文明确 limitation
  | "taxonomy_empty" // taxonomy 聚合结构上的真实覆盖空缺
  | "coverage_missing"; // 当前 Survey coverage 明确缺少的维度

export const RESEARCH_GAP_TRIGGERS: readonly ResearchGapTrigger[] = [
  "literature_limitation",
  "taxonomy_empty",
  "coverage_missing",
];

/** Future Direction 的来源（inferred → speculative 是硬规则） */
export type FutureDirectionOrigin = "cited_future_work" | "inferred";

/** Comparison 允许的维度（第一版受限集合；LLM 可提议表外值但需 entry 支撑） */
export const COMPARISON_DIMENSIONS: readonly string[] = [
  "assumption",
  "data dependency",
  "appearance dependency",
  "motion modeling",
  "computational complexity",
  "occlusion handling",
  "applicable scenario",
];

// ---- kind 判别 detail ----

export interface TaxonomyDetail {
  family: string;
  subFamily?: string;
}

export interface TrendDetail {
  /** 时间窗（如 "2017-2020"）；宽口径统计可无精确年份 */
  period: string;
  /** 变化方向 / 转移（一句话） */
  direction: string;
}

export interface ComparisonSide {
  label: string;
  entryIds: string[];
  /** 该侧的依据摘要（来自 Matrix 字段，不新造事实） */
  basis: string;
}

export interface ComparisonDetail {
  dimension: string;
  sides: ComparisonSide[];
}

export interface ConsensusDetail {
  /**
   * true = 只有 2 个不同 source 观点一致（不构成 consensus，如实标记为
   * observed agreement；groundingLevel 封顶 literature_cited）
   */
  observedAgreement: boolean;
  distinctSources: number;
}

export interface DisagreementSide {
  label?: string;
  entryIds: string[];
}

export interface DisagreementDetail {
  issue: string;
  sideA: DisagreementSide;
  sideB: DisagreementSide;
}

export interface ResearchGapDetail {
  trigger: ResearchGapTrigger;
  /** 空缺依据（limitation 原文归纳 / taxonomy 结构证据 / coverage 缺口说明） */
  basis: string;
}

export interface FutureDirectionDetail {
  origin: FutureDirectionOrigin;
}

export type SynthesisDetail =
  | ({ kind: "taxonomy" } & TaxonomyDetail)
  | ({ kind: "trend" } & TrendDetail)
  | ({ kind: "comparison" } & ComparisonDetail)
  | ({ kind: "consensus" } & ConsensusDetail)
  | ({ kind: "disagreement" } & DisagreementDetail)
  | ({ kind: "research_gap" } & ResearchGapDetail)
  | ({ kind: "future_direction" } & FutureDirectionDetail);

/** 文本上限（claim 是综合陈述；detail 各字段短句） */
export const SYNTHESIS_FIELD_LIMITS = {
  claim: 500,
  detailText: 200,
  sideLabel: 80,
} as const;

/** 每 candidate 的 evidence proposal 上限（防御输出风暴；也是 judge 成本闸门） */
export const EVIDENCE_PROPOSALS_MAX = 4;

/** LLM candidate 阶段的 evidence 提案（chunkId 必须 ∈ 该 entry 的 anchor 集） */
export interface SynthesisEvidenceProposal {
  entryId: string;
  /** Matrix anchor 中出现过的 chunkId（服务端核验归属；quote 由 chunk 原文生成） */
  chunkId: string;
  /** 单源子断言（成为 EvidenceRecord.claim；与 synthesis.claim 不同层） */
  evidenceClaim: string;
}

/** 落盘形态（groundingLevel / evidenceIds 由代码守卫填充，非模型产物） */
export interface SurveySynthesisItem {
  synthesisId: string;
  kind: SurveySynthesisKind;
  claim: string;
  groundingLevel: SynthesisGroundingLevel;
  evidenceIds: string[];
  /** 从 derivedFrom.entryIds 派生（升序去重；不重复存 Source metadata） */
  sourceIds: string[];
  derivedFrom: { entryIds: string[] };
  detail?: SynthesisDetail;
  /** grounding 判定的确定性依据（人读；审计与 HITL 用） */
  groundingReason?: string;
  /** 产生该条的 researcher 任务（taxonomy 确定性聚合无 LLM，无 taskId） */
  taskId?: string;
  updatedAt: string;
}

/** artifact 形状（research/survey-synthesis.json 的全部事实） */
export interface SurveySynthesisArtifact {
  schemaVersion: 1;
  updatedAt: string;
  /** 构建所基于 Matrix 的内容指纹（staleness 检测；不阻塞读取） */
  matrixFingerprint: string;
  /** 按 synthesisId 升序（确定性序列化） */
  items: SurveySynthesisItem[];
}

// ---- 确定性 ID / dedup ----

/** claim 归一（dedup 与 ID 指纹共用口径）：去首尾空白 + 压缩连续空白 + 小写 */
export function normalizeSynthesisClaim(claim: string): string {
  return claim.trim().replace(/\s+/g, " ").toLowerCase();
}

/** 内容指纹：kind + normalized claim + sorted sourceIds 的纯函数 */
export function synthesisFingerprint(
  kind: SurveySynthesisKind,
  claim: string,
  sourceIds: string[],
): string {
  return sha256Hex(
    JSON.stringify([kind, normalizeSynthesisClaim(claim), [...sourceIds].sort()]),
  ).slice(0, 10);
}

/** 确定性 synthesisId（同输入恒同值；跨 batch / 跨 build 稳定） */
export function synthesisId(kind: SurveySynthesisKind, claim: string, sourceIds: string[]): string {
  return `SYN-${synthesisFingerprint(kind, claim, sourceIds)}`;
}

/** 跨 batch dedup：完全重复（同 fingerprint）合并 entryIds / evidenceIds，claim 取首条 */
export function dedupSynthesisItems(items: SurveySynthesisItem[]): SurveySynthesisItem[] {
  const byFingerprint = new Map<string, SurveySynthesisItem>();
  for (const item of items) {
    const key = synthesisFingerprint(item.kind, item.claim, item.sourceIds);
    const prior = byFingerprint.get(key);
    if (prior === undefined) {
      byFingerprint.set(key, item);
      continue;
    }
    prior.derivedFrom.entryIds = [...new Set([...prior.derivedFrom.entryIds, ...item.derivedFrom.entryIds])].sort();
    prior.evidenceIds = [...new Set([...prior.evidenceIds, ...item.evidenceIds])].sort();
  }
  return [...byFingerprint.values()].sort((a, b) => a.synthesisId.localeCompare(b.synthesisId));
}

// ---- candidate parse（模型 JSON → 中间形态；grounding 未定） ----

/** parse 通过、尚未 grounding 的候选（evidenceIds 空；groundingLevel 未定） */
export interface SynthesisCandidate {
  kind: SurveySynthesisKind;
  claim: string;
  sourceIds: string[];
  entryIds: string[];
  detail?: SynthesisDetail;
  proposals: SynthesisEvidenceProposal[];
  /** 模型原始 kind 值审计（非法 kind 拒绝时记录） */
  taskId?: string;
}

/** 单条 candidate 的拒绝原因（fail-closed 账目） */
export interface SynthesisRejection {
  kind: string;
  claim: string;
  reason: string;
}

function boundedText(value: unknown, field: string, limit: number): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new AgentRunFailedError(`synthesis candidate 的 ${field} 必须是非空字符串`);
  }
  return value.trim().slice(0, limit);
}

function optionalBoundedText(value: unknown, limit: number): string | undefined {
  if (typeof value !== "string") {
    return undefined;
  }
  const trimmed = value.trim();
  return trimmed === "" ? undefined : trimmed.slice(0, limit);
}

function parseEntryIds(value: unknown): string[] {
  if (!Array.isArray(value)) {
    return [];
  }
  return [...new Set(value.filter((id): id is string => typeof id === "string" && id.trim() !== "").map((id) => id.trim()))];
}

/** detail 解析（按 kind 判别；结构非法抛 AgentRunFailedError → 该条拒绝） */
function parseDetail(kind: SurveySynthesisKind, raw: unknown): SynthesisDetail | undefined {
  if (typeof raw !== "object" || raw === null) {
    throw new AgentRunFailedError(`synthesis candidate（${kind}）缺少 detail 对象`);
  }
  const record = raw as Record<string, unknown>;
  switch (kind) {
    case "taxonomy": {
      const subFamily = optionalBoundedText(record["subFamily"], SYNTHESIS_FIELD_LIMITS.detailText);
      return {
        kind,
        family: boundedText(record["family"], "detail.family", SYNTHESIS_FIELD_LIMITS.detailText),
        ...(subFamily !== undefined ? { subFamily } : {}),
      };
    }
    case "trend":
      return {
        kind,
        period: boundedText(record["period"], "detail.period", SYNTHESIS_FIELD_LIMITS.detailText),
        direction: boundedText(record["direction"], "detail.direction", SYNTHESIS_FIELD_LIMITS.detailText),
      };
    case "comparison": {
      const sidesRaw = record["sides"];
      if (!Array.isArray(sidesRaw)) {
        throw new AgentRunFailedError("comparison candidate 的 detail.sides 必须是数组");
      }
      const sides: ComparisonSide[] = [];
      for (const sideRaw of sidesRaw) {
        if (typeof sideRaw !== "object" || sideRaw === null) {
          continue;
        }
        const side = sideRaw as Record<string, unknown>;
        sides.push({
          label: boundedText(side["label"], "detail.sides[].label", SYNTHESIS_FIELD_LIMITS.sideLabel),
          entryIds: parseEntryIds(side["entryIds"]),
          basis: boundedText(side["basis"], "detail.sides[].basis", SYNTHESIS_FIELD_LIMITS.detailText),
        });
      }
      return {
        kind,
        dimension: boundedText(record["dimension"], "detail.dimension", SYNTHESIS_FIELD_LIMITS.detailText),
        sides,
      };
    }
    case "consensus":
      return {
        kind,
        observedAgreement: record["observedAgreement"] === true,
        distinctSources: 0, // 由代码按 distinct source 数回填（模型值不可信）
      };
    case "disagreement": {
      const parseSide = (value: unknown, field: string): DisagreementSide => {
        if (typeof value !== "object" || value === null) {
          throw new AgentRunFailedError(`disagreement candidate 的 ${field} 必须是对象`);
        }
        const label = optionalBoundedText(
          (value as Record<string, unknown>)["label"],
          SYNTHESIS_FIELD_LIMITS.sideLabel,
        );
        return {
          ...(label !== undefined ? { label } : {}),
          entryIds: parseEntryIds((value as Record<string, unknown>)["entryIds"]),
        };
      };
      return {
        kind,
        issue: boundedText(record["issue"], "detail.issue", SYNTHESIS_FIELD_LIMITS.detailText),
        sideA: parseSide(record["sideA"], "detail.sideA"),
        sideB: parseSide(record["sideB"], "detail.sideB"),
      };
    }
    case "research_gap": {
      const trigger = record["trigger"];
      if (typeof trigger !== "string" || !(RESEARCH_GAP_TRIGGERS as readonly string[]).includes(trigger)) {
        // fail-closed：白名单外的 trigger 拒绝整条（不降级、不猜测归类）
        throw new AgentRunFailedError(
          `research_gap 的 trigger 必须是 ${RESEARCH_GAP_TRIGGERS.join(" / ")} 之一（收到 ${String(trigger).slice(0, 40)}）`,
        );
      }
      return {
        kind,
        trigger: trigger as ResearchGapTrigger,
        basis: boundedText(record["basis"], "detail.basis", SYNTHESIS_FIELD_LIMITS.detailText),
      };
    }
    case "future_direction": {
      const origin = record["origin"];
      if (origin !== "cited_future_work" && origin !== "inferred") {
        throw new AgentRunFailedError(
          `future_direction 的 origin 必须是 cited_future_work / inferred（收到 ${String(origin).slice(0, 40)}）`,
        );
      }
      return { kind, origin };
    }
  }
}

/**
 * 模型 JSON 输出 → 候选列表（同步形状校验）。引用存在性（entryId ∈ Matrix、
 * chunkId ∈ entry anchors）在服务层核验——这里只保证结构合法。单条候选结构
 * 非法（缺 claim / detail 形状错 / gap trigger 白名单外 / future origin 非法）
 * 记入 rejections（fail-closed 账目），不中断其余候选。模型输出中的
 * groundingLevel / evidenceIds 等自报字段直接被本函数丢弃（不解析、不透传）。
 */
export function parseSynthesisCandidates(
  parsed: Record<string, unknown>,
): { candidates: SynthesisCandidate[]; rejections: SynthesisRejection[] } {
  const rawCandidates = parsed["candidates"];
  if (!Array.isArray(rawCandidates)) {
    throw new AgentRunFailedError("synthesis 输出缺少 candidates 数组");
  }
  const out: SynthesisCandidate[] = [];
  const rejections: SynthesisRejection[] = [];
  for (const raw of rawCandidates) {
    if (typeof raw !== "object" || raw === null) {
      continue;
    }
    const record = raw as Record<string, unknown>;
    const kind = record["kind"];
    if (typeof kind !== "string" || !(SURVEY_SYNTHESIS_KINDS as readonly string[]).includes(kind)) {
      continue; // 未知 kind：丢弃（taxonomy 由代码聚合，模型不应产出）
    }
    if (kind === "taxonomy") {
      continue; // taxonomy 只由确定性聚合产生，模型候选一律不收
    }
    const claimPreview =
      typeof record["claim"] === "string" ? record["claim"].slice(0, 80) : "";
    try {
      const claim = boundedText(record["claim"], "claim", SYNTHESIS_FIELD_LIMITS.claim);
      const detail = parseDetail(kind as SurveySynthesisKind, record["detail"]);
      const proposals: SynthesisEvidenceProposal[] = [];
      const rawProposals = record["evidenceProposals"];
      if (Array.isArray(rawProposals)) {
        for (const proposalRaw of rawProposals.slice(0, EVIDENCE_PROPOSALS_MAX)) {
          if (typeof proposalRaw !== "object" || proposalRaw === null) {
            continue;
          }
          const proposal = proposalRaw as Record<string, unknown>;
          const entryId = proposal["entryId"];
          const chunkId = proposal["chunkId"];
          const evidenceClaim = proposal["evidenceClaim"];
          if (
            typeof entryId !== "string" ||
            typeof chunkId !== "string" ||
            typeof evidenceClaim !== "string" ||
            entryId.trim() === "" ||
            chunkId.trim() === "" ||
            evidenceClaim.trim() === ""
          ) {
            continue;
          }
          proposals.push({
            entryId: entryId.trim(),
            chunkId: chunkId.trim(),
            evidenceClaim: evidenceClaim.trim().slice(0, 500),
          });
        }
      }
      // detail 内的 entryIds（comparison sides / disagreement sides）并入总集
      const entryIds = new Set(parseEntryIds(record["entryIds"]));
      if (detail?.kind === "comparison") {
        for (const side of detail.sides) {
          for (const id of side.entryIds) {
            entryIds.add(id);
          }
        }
      } else if (detail?.kind === "disagreement") {
        for (const id of [...detail.sideA.entryIds, ...detail.sideB.entryIds]) {
          entryIds.add(id);
        }
      }
      out.push({
        kind: kind as SurveySynthesisKind,
        claim,
        sourceIds: [], // 服务层从 entryIds 派生（模型无权直接声明）
        entryIds: [...entryIds].sort(),
        detail,
        proposals,
      });
    } catch (error) {
      rejections.push({
        kind,
        claim: claimPreview,
        reason: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return { candidates: out, rejections };
}

// ---- kind 最低支撑规则（fail-closed 拒绝线；与 grounding 分级互补） ----

/** 各 kind 的最低 distinct source 数（低于即整条拒绝，不降级） */
export const MIN_SOURCES_BY_KIND: Record<Exclude<SurveySynthesisKind, "taxonomy">, number> = {
  trend: 2, // 两篇不同年份不足以构成趋势的年代学断言更不行——单 source 一律拒绝
  comparison: 2, // 每侧至少一个真实 source → 总数 ≥2
  consensus: 2, // 2 = observed agreement（保留但封顶）；1 = 拒绝
  disagreement: 2, // 每侧 ≥1 source
  research_gap: 1, // 单篇明确 limitation 即可成 gap 候选（literature_cited）
  future_direction: 1, // 单篇明确 future work 即可（cited 路径）
};

/** Matrix 条目的溯源信任投影（groundingRules 消费；由服务层从 entry 派生） */
export interface SynthesisEntryTrust {
  entryId: string;
  sourceId: string;
  interpretationDepth: InterpretationDepth;
  /** fulltext 且 anchors 非空且无弱锚 issue（no_valid_anchors / no_retrievable_chunks） */
  reliableAnchor: boolean;
}
