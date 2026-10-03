/**
 * SynthesisService：Survey Matrix → Structured Synthesis 的构建编排（M11.1.2）。
 *
 * 链路（零新 Runtime 角色；contextScope="research/survey-synthesis" 经
 * roleConfig research/* 前缀映射 researcher，与 M11.1.1 同纪律）：
 *   Matrix（含 interpretationDepth / issues / anchors）
 *   → trust 投影（reliableAnchor = fulltext ∧ 有锚 ∧ 无弱锚 issue）
 *   → taxonomy 确定性聚合（零 LLM：family → subFamily → entryIds）
 *   → 其余六类按 kind 分组 bounded batch（不把全部论文塞一个 prompt）
 *   → researcher 生成 candidate synthesis（LLM 只产出候选）
 *   → parse（模型自报 grounding 字段被结构性丢弃）
 *   → 引用 fail-closed 核验（entryId ∈ Matrix；sourceIds 从 entryIds 派生，
 *     模型无权声明；sides 剔空后必须仍有双侧）
 *   → evidence proposals（chunkId 必须 ∈ 该 entry 的 anchor 集；quote 由
 *     chunk 原文生成）走 EvidenceGroundingService 真实核验
 *     （quote 逐字 → metadata → semantic judge；verified 才有 evidenceId）
 *   → deriveGroundingLevel（groundingRules 纯函数，代码唯一判定权）
 *   → 确定性 dedup（fingerprint = kind + normalized claim + sorted sources）
 *   → research/survey-synthesis.json（全量替换；单一写入口）
 *
 * 构建语义：基于 Matrix 快照全量重建（跨论文综合依赖全局视图；Matrix 变化
 * 后旧 synthesis 的引用会失效，全量重建天然规避陈旧引用）。matrixFingerprint
 * 未变且非 force 时直接复用既有 artifact（零 LLM 调用）；同输入重复 build 恒
 * 产生同一批 synthesisId。LLM 调用串行执行（与 MatrixService 同纪律）。
 *
 * 语义边界：本服务不创建 multi-source EvidenceRecord——跨论文 synthesis 经
 * evidenceIds[] 引用多个独立 verified EvidenceRecord；ground 失败只降级
 * groundingLevel（literature_cited），不阻塞构建。
 */

import { AgentRunFailedError, BusinessError } from "../errors.js";
import { extractJsonObject } from "../agents/outputParsing.js";
import type { EvidenceGroundingService } from "../evidence/EvidenceGroundingService.js";
import type { ChunkAccess } from "../evidence/chunkAccess.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { AgentRuntime } from "../runtime/types.js";
import type { SourceStore } from "../sources/SourceStore.js";
import { fingerprintJson } from "../util/hash.js";
import { SurveyMatrixArtifactStore, SurveySynthesisArtifactStore } from "./surveyArtifacts.js";
import { deriveGroundingLevel, type SynthesisEvidenceRef } from "./groundingRules.js";
import {
  EVIDENCE_PROPOSALS_MAX,
  MIN_SOURCES_BY_KIND,
  SURVEY_SYNTHESIS_KINDS,
  dedupSynthesisItems,
  parseSynthesisCandidates,
  synthesisId,
  type SynthesisCandidate,
  type SynthesisDetail,
  type SynthesisEntryTrust,
  type SynthesisEvidenceProposal,
  type SurveySynthesisArtifact,
  type SurveySynthesisItem,
  type SurveySynthesisKind,
} from "./synthesisTypes.js";
import type { SurveyMatrixArtifact, SurveyMatrixEntry } from "./matrixTypes.js";
import { taxonomyFamilyOf, UNCLASSIFIED_FAMILY } from "./matrixTypes.js";

/** 单 batch 条目上限（bounded batching；超出按 entryId 排序切块） */
const SYNTHESIS_BATCH_MAX_ENTRIES = 12;
/** 每 entry 注入 prompt 的 chunkId 上限（anchors 展平后截断） */
const SYNTHESIS_CHUNK_IDS_PER_ENTRY = 8;
/** evidence proposal 的 quote 上限（chunk 原文截断；与 EvidenceStore.quote 同限） */
const PROPOSAL_QUOTE_LIMIT = 2000;

export interface SurveySynthesisBuildInput {
  /** 只构建指定类（默认全部七类；taxonomy 是确定性聚合） */
  kinds?: SurveySynthesisKind[];
  /** Matrix 指纹未变时仍强制重建（默认复用既有 artifact） */
  force?: boolean;
  /**
   * 逐 batch 进度回调（M11.1.4：workflow stage 空闲超时看门狗喂食；纯观测，
   * 异常不回传）
   */
  onProgress?: (info: { done: number; total: number; kind: string }) => void;
}

export interface SurveySynthesisBuildResult {
  summary: {
    matrixEntries: number;
    matrixFingerprint: string;
    /** true = Matrix 未变化，直接复用既有 artifact（零 LLM 调用） */
    reused: boolean;
    batches: number;
    /** LLM 产出且 parse 通过的候选数 */
    candidates: number;
    accepted: number;
    rejected: number;
    byKind: Record<SurveySynthesisKind, number>;
    evidenceProposed: number;
    evidenceVerified: number;
  };
  rejections: Array<{ kind: string; claim: string; reason: string }>;
  synthesis: SurveySynthesisArtifact;
}

export interface SynthesisServiceOptions {
  projects: ProjectStore;
  sources: SourceStore;
  chunkAccess: ChunkAccess;
  runtime: AgentRuntime;
  researcherAgentId: string;
  /** evidence 核验管道（缺省 → 不做 evidence ground，全部封顶 literature_cited） */
  evidenceGrounding?: EvidenceGroundingService;
  runTimeoutMs?: number;
  now?: () => Date;
  log?: (message: string) => void;
}

export class SynthesisService {
  private readonly projects: ProjectStore;
  private readonly sources: SourceStore;
  private readonly chunkAccess: ChunkAccess;
  private readonly runtime: AgentRuntime;
  private readonly researcherAgentId: string;
  private readonly evidenceGrounding: EvidenceGroundingService | undefined;
  private readonly matrixStore: SurveyMatrixArtifactStore;
  private readonly store: SurveySynthesisArtifactStore;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private readonly timeoutOverride: { timeoutMs: number } | Record<string, never>;

  constructor(options: SynthesisServiceOptions) {
    this.projects = options.projects;
    this.sources = options.sources;
    this.chunkAccess = options.chunkAccess;
    this.runtime = options.runtime;
    this.researcherAgentId = options.researcherAgentId;
    this.evidenceGrounding = options.evidenceGrounding;
    this.matrixStore = new SurveyMatrixArtifactStore(options.projects);
    this.store = new SurveySynthesisArtifactStore(options.projects);
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
    this.timeoutOverride = options.runTimeoutMs !== undefined ? { timeoutMs: options.runTimeoutMs } : {};
  }

  /** 读综合产物（未构建 → null；损坏 → SURVEY_SYNTHESIS_CORRUPTED fail-closed） */
  async getSynthesis(projectId: string): Promise<SurveySynthesisArtifact | null> {
    await this.projects.getRequired(projectId);
    return this.store.read(projectId);
  }

  async buildSynthesis(
    projectId: string,
    input: SurveySynthesisBuildInput = {},
  ): Promise<SurveySynthesisBuildResult> {
    const project = await this.projects.getRequired(projectId);
    const language = project.language === "zh" || project.language === "en" ? project.language : undefined;
    const kinds = resolveRequestedKinds(input.kinds);

    const matrix = await this.matrixStore.read(projectId);
    if (matrix === null) {
      throw new BusinessError(
        "INVALID_REQUEST",
        "项目还没有 Survey Matrix（research/survey.json 不存在），请先执行 POST /survey/matrix/build",
      );
    }
    const matrixFingerprint = fingerprintJson(matrix);
    const existing = await this.store.read(projectId);
    if (existing !== null && input.force !== true && existing.matrixFingerprint === matrixFingerprint) {
      this.log(
        `[survey] projectId=${projectId} synthesis 复用既有 artifact（matrix 指纹未变，${existing.items.length} 条）`,
      );
      return {
        summary: {
          matrixEntries: matrix.entries.length,
          matrixFingerprint,
          reused: true,
          batches: 0,
          candidates: 0,
          accepted: existing.items.length,
          rejected: 0,
          byKind: countByKind(existing.items),
          evidenceProposed: 0,
          evidenceVerified: 0,
        },
        rejections: [],
        synthesis: existing,
      };
    }

    const sourceItems = await this.sources.list(projectId);
    const yearBySource = new Map(
      sourceItems
        .filter((item) => item.metadata.year !== undefined)
        .map((item) => [item.sourceId, item.metadata.year as number]),
    );
    const entryById = new Map(matrix.entries.map((entry) => [entry.entryId, entry]));
    const updatedAt = this.now().toISOString();

    const items: SurveySynthesisItem[] = [];
    const rejections: SurveySynthesisBuildResult["rejections"] = [];
    const counters = { batches: 0, candidates: 0, evidenceProposed: 0, evidenceVerified: 0 };

    // 1. taxonomy：确定性聚合（零 LLM；组织骨架，供 M11.1.3 Outline 消费）
    if (kinds.includes("taxonomy")) {
      items.push(...buildTaxonomyItems(matrix, updatedAt));
    }

    // 2. 其余六类：bounded batch → researcher → 代码守卫
    const llmKinds = kinds.filter((kind) => kind !== "taxonomy") as Array<
      Exclude<SurveySynthesisKind, "taxonomy">
    >;
    if (llmKinds.length > 0 && matrix.entries.length > 0) {
      const taxonomyStats = renderTaxonomyStats(matrix);
      // 先跑 research_gap：future_direction 只消费已验证的 gap 与文献线索
      const orderedKinds = [
        ...llmKinds.filter((kind) => kind !== "future_direction"),
        ...llmKinds.filter((kind) => kind === "future_direction"),
      ];
      const acceptedGapClaims: string[] = [];
      // 预展开 batch 队列（执行顺序不变；进度分母先知）
      const plannedBatches = orderedKinds.flatMap((kind) =>
        splitBatches(matrix.entries, kind).map((batch) => ({ kind, batch })),
      );
      for (const [batchIndex, { kind, batch }] of plannedBatches.entries()) {
        input.onProgress?.({ done: batchIndex, total: plannedBatches.length, kind });
        counters.batches += 1;
        let parsed: Awaited<ReturnType<SynthesisService["requestCandidates"]>>;
        try {
          parsed = await this.requestCandidates(projectId, {
            kind,
            language,
            batch,
            matrix,
            taxonomyStats,
            yearBySource,
            ...(kind === "future_direction" ? { gapClaims: acceptedGapClaims } : {}),
          });
        } catch (error) {
          // 单 batch 失败是数据不是异常：记拒绝账目，继续其余 batch
          const reason = error instanceof Error ? error.message : String(error);
          rejections.push({
            kind,
            claim: "",
            reason: `batch 失败（${batch.map((entry) => entry.entryId).join("、").slice(0, 80)}）：${reason.slice(0, 160)}`,
          });
          this.log(`[survey] projectId=${projectId} ${kind} batch 失败：${reason.slice(0, 200)}`);
          continue;
        }
        // parse 期结构拒绝（非法 gap trigger / detail 形状错等）先入账目
        rejections.push(...parsed.rejections);
        counters.candidates += parsed.candidates.length;
        for (const candidate of parsed.candidates) {
          const outcome = await this.processCandidate(projectId, {
            candidate,
            kind,
            entryById,
            updatedAt,
            counters,
          });
          if (outcome.type === "accepted") {
            items.push(outcome.item);
            if (kind === "research_gap") {
              acceptedGapClaims.push(outcome.item.claim);
            }
          } else {
            rejections.push(outcome.rejection);
          }
        }
      }
    }

    const deduped = dedupSynthesisItems(items);
    const artifact: SurveySynthesisArtifact = {
      schemaVersion: 1,
      updatedAt,
      matrixFingerprint,
      items: deduped,
    };
    await this.store.write(projectId, artifact);
    this.log(
      `[survey] projectId=${projectId} synthesis 构建：batches=${counters.batches} candidates=${counters.candidates} accepted=${deduped.length} rejected=${rejections.length} evidence=${counters.evidenceVerified}/${counters.evidenceProposed}`,
    );
    return {
      summary: {
        matrixEntries: matrix.entries.length,
        matrixFingerprint,
        reused: false,
        batches: counters.batches,
        candidates: counters.candidates,
        accepted: deduped.length,
        rejected: rejections.length,
        byKind: countByKind(deduped),
        evidenceProposed: counters.evidenceProposed,
        evidenceVerified: counters.evidenceVerified,
      },
      rejections,
      synthesis: artifact,
    };
  }

  // ---- 内部 ----

  /** 单 batch：prompt → researcher → parse（失败抛错由调用方落 batch 账目） */
  private async requestCandidates(
    projectId: string,
    input: {
      kind: Exclude<SurveySynthesisKind, "taxonomy">;
      language: "zh" | "en" | undefined;
      batch: SurveyMatrixEntry[];
      matrix: SurveyMatrixArtifact;
      taxonomyStats: string;
      yearBySource: Map<string, number>;
      gapClaims?: string[];
    },
  ): Promise<{
    candidates: SynthesisCandidate[];
    rejections: SurveySynthesisBuildResult["rejections"];
  }> {
    const prompt = buildSynthesisPrompt({
      kind: input.kind,
      entries: input.batch,
      taxonomy: input.matrix.taxonomy.families.map((family) => family.label),
      yearBySource: input.yearBySource,
      taxonomyStats: input.taxonomyStats,
      ...(input.gapClaims !== undefined ? { gapClaims: input.gapClaims } : {}),
    });
    const task = await this.runtime.runAgent({
      agentId: this.researcherAgentId,
      ...this.timeoutOverride,
      task: prompt,
      projectId,
      contextScope: "research/survey-synthesis",
      ...(input.language !== undefined ? { language: input.language } : {}),
      metadata: { role: "researcher", skill: "survey-synthesis" },
    });
    if (task.status !== "completed") {
      throw new AgentRunFailedError(task.error ?? `synthesis 任务以 ${task.status} 状态结束`);
    }
    const parsed = extractJsonObject(task.output ?? "", "Survey Synthesis 输出");
    const { candidates, rejections } = parseSynthesisCandidates(parsed);
    return {
      candidates: candidates.map((candidate) => ({ ...candidate, taskId: task.taskId })),
      rejections,
    };
  }

  /** 单 candidate 守卫链：引用核验 → evidence ground → grounding 判定 */
  private async processCandidate(
    projectId: string,
    input: {
      candidate: SynthesisCandidate;
      kind: Exclude<SurveySynthesisKind, "taxonomy">;
      entryById: Map<string, SurveyMatrixEntry>;
      updatedAt: string;
      counters: { evidenceProposed: number; evidenceVerified: number };
    },
  ): Promise<
    | { type: "accepted"; item: SurveySynthesisItem }
    | { type: "rejected"; rejection: SurveySynthesisBuildResult["rejections"][number] }
  > {
    const { candidate, entryById } = input;
    const brief = candidate.claim.slice(0, 80);
    const reject = (reason: string) => ({
      type: "rejected" as const,
      rejection: { kind: candidate.kind, claim: brief, reason },
    });

    // 引用核验（fail-closed）：不存在的 entryId 剔除；sides 内引用同步过滤
    const validEntryIds = candidate.entryIds.filter((id) => entryById.has(id));
    const detail = filterDetailEntryIds(candidate.detail, validEntryIds);
    if (detail.type === "reject") {
      return reject(detail.reason);
    }
    if (validEntryIds.length === 0) {
      return reject("没有任何 entryId 存在于当前 Matrix（引用全部无效）");
    }
    const sourceIds = [
      ...new Set(validEntryIds.map((entryId) => entryById.get(entryId)!.sourceId)),
    ].sort();
    const distinctSources = sourceIds.length;
    if (distinctSources < MIN_SOURCES_BY_KIND[input.kind]) {
      return reject(
        `${input.kind} 至少需要 ${MIN_SOURCES_BY_KIND[input.kind]} 个不同来源（当前 ${distinctSources}）`,
      );
    }

    // trust 投影 + proposal 过滤（chunkId 必须 ∈ 该 entry 的 anchor 集）
    const trusts: SynthesisEntryTrust[] = validEntryIds.map((entryId) => {
      const entry = entryById.get(entryId)!;
      return {
        entryId,
        sourceId: entry.sourceId,
        interpretationDepth: entry.interpretationDepth,
        reliableAnchor: isReliablyAnchored(entry),
      };
    });
    const proposals = candidate.proposals.filter((proposal) => {
      const entry = entryById.get(proposal.entryId);
      return (
        entry !== undefined &&
        validEntryIds.includes(proposal.entryId) &&
        anchorChunkIdsOf(entry).includes(proposal.chunkId)
      );
    });

    // evidence ground：inferred future direction 不进核验管道（结果不改变 speculative）
    const evidenceRefs: SynthesisEvidenceRef[] = [];
    const skipGrounding =
      this.evidenceGrounding === undefined ||
      (detail.detail?.kind === "future_direction" && detail.detail.origin === "inferred");
    if (!skipGrounding) {
      for (const proposal of proposals) {
        input.counters.evidenceProposed += 1;
        const outcome = await this.groundProposal(projectId, proposal, entryById.get(proposal.entryId)!);
        if (outcome !== null) {
          evidenceRefs.push(outcome);
          if (outcome.verified) {
            input.counters.evidenceVerified += 1;
          }
        }
      }
    }

    const decision = deriveGroundingLevel({
      kind: candidate.kind,
      detail: detail.detail,
      entryIds: validEntryIds,
      entries: trusts,
      evidence: evidenceRefs,
      sourceIds,
    });
    const item: SurveySynthesisItem = {
      synthesisId: synthesisId(candidate.kind, candidate.claim, sourceIds),
      kind: candidate.kind,
      claim: candidate.claim,
      groundingLevel: decision.level,
      evidenceIds: evidenceRefs.filter((ref) => ref.verified).map((ref) => ref.id).sort(),
      sourceIds,
      derivedFrom: { entryIds: validEntryIds.sort() },
      ...(detail.detail !== undefined ? { detail: detail.detail } : {}),
      groundingReason: decision.reason,
      ...(candidate.taskId !== undefined ? { taskId: candidate.taskId } : {}),
      updatedAt: input.updatedAt,
    };
    return { type: "accepted", item };
  }

  /**
   * 单 proposal 核验：quote 取 chunk 原文（逐字必然成立；语义支撑由 judge
   * 裁决）→ propose 入队 → ground 三段核验。任何失败只意味着该 proposal
   * 无 evidence（null），不阻塞 candidate。
   */
  private async groundProposal(
    projectId: string,
    proposal: SynthesisEvidenceProposal,
    entry: SurveyMatrixEntry,
  ): Promise<SynthesisEvidenceRef | null> {
    if (this.evidenceGrounding === undefined) {
      return null;
    }
    try {
      const resolved = await this.chunkAccess.resolve(projectId, proposal.chunkId);
      const quote = resolved.chunk.text.slice(0, PROPOSAL_QUOTE_LIMIT);
      const proposed = await this.evidenceGrounding.propose(projectId, {
        sourceId: entry.sourceId,
        chunkId: proposal.chunkId,
        claim: proposal.evidenceClaim,
        quote,
        proposedBy: "researcher:survey-synthesis",
      });
      const grounded = await this.evidenceGrounding.ground(projectId, proposed.candidate.candidateId);
      return {
        id: grounded.evidenceId ?? `pending:${proposed.candidate.candidateId}`,
        verified: grounded.status === "verified",
        sourceId: entry.sourceId,
      };
    } catch (error) {
      this.log(
        `[survey] projectId=${projectId} evidence proposal 核验失败（${proposal.chunkId.slice(0, 60)}）：${error instanceof Error ? error.message : String(error)}`,
      );
      return null;
    }
  }
}

// ---- 纯函数辅助（独立可测） ----

function resolveRequestedKinds(kinds: SurveySynthesisKind[] | undefined): SurveySynthesisKind[] {
  if (kinds === undefined) {
    return [...SURVEY_SYNTHESIS_KINDS];
  }
  if (kinds.length === 0) {
    throw new BusinessError("INVALID_REQUEST", "kinds 必须是非空数组（不指定则构建全部七类）");
  }
  for (const kind of kinds) {
    if (!(SURVEY_SYNTHESIS_KINDS as readonly string[]).includes(kind)) {
      throw new BusinessError(
        "INVALID_REQUEST",
        `未知的 synthesis kind「${String(kind)}」（合法值：${SURVEY_SYNTHESIS_KINDS.join(" / ")}）`,
      );
    }
  }
  return [...new Set(kinds)];
}

function countByKind(items: SurveySynthesisItem[]): Record<SurveySynthesisKind, number> {
  const byKind = Object.fromEntries(SURVEY_SYNTHESIS_KINDS.map((kind) => [kind, 0])) as Record<
    SurveySynthesisKind,
    number
  >;
  for (const item of items) {
    byKind[item.kind] += 1;
  }
  return byKind;
}

/** fulltext ∧ 有锚 ∧ 无弱锚 issue（no_valid_anchors / no_retrievable_chunks） */
function isReliablyAnchored(entry: SurveyMatrixEntry): boolean {
  if (entry.interpretationDepth !== "fulltext" || entry.anchors.length === 0) {
    return false;
  }
  const weakCodes = new Set(["no_valid_anchors", "no_retrievable_chunks"]);
  return !(entry.issues ?? []).some((issue) => weakCodes.has(issue.code));
}

function anchorChunkIdsOf(entry: SurveyMatrixEntry): string[] {
  return entry.anchors.flatMap((anchor) => anchor.chunkIds);
}

/** sides / side 内引用过滤（comparison 双侧 / disagreement 双侧必须仍有支撑） */
function filterDetailEntryIds(
  detail: SynthesisDetail | undefined,
  validEntryIds: string[],
): { type: "ok"; detail?: SynthesisDetail } | { type: "reject"; reason: string } {
  if (detail === undefined) {
    return { type: "ok" };
  }
  const keep = (ids: string[]) => ids.filter((id) => validEntryIds.includes(id));
  if (detail.kind === "comparison") {
    const sides = detail.sides.map((side) => ({ ...side, entryIds: keep(side.entryIds) }));
    if (sides.some((side) => side.entryIds.length === 0)) {
      return { type: "reject", reason: "comparison 某一侧没有有效 Matrix 引用（双侧都必须存在）" };
    }
    return { type: "ok", detail: { ...detail, sides } };
  }
  if (detail.kind === "disagreement") {
    const sideA = { ...detail.sideA, entryIds: keep(detail.sideA.entryIds) };
    const sideB = { ...detail.sideB, entryIds: keep(detail.sideB.entryIds) };
    if (sideA.entryIds.length === 0 || sideB.entryIds.length === 0) {
      return { type: "reject", reason: "disagreement 某一侧没有有效 Matrix 引用（双侧都必须存在）" };
    }
    return { type: "ok", detail: { ...detail, sideA, sideB } };
  }
  return { type: "ok", detail };
}

/** batch 切分：trend/comparison/consensus/disagreement 按 family 分组，gap/future 全局单批（紧凑聚合） */
export function splitBatches(
  entries: SurveyMatrixEntry[],
  kind: Exclude<SurveySynthesisKind, "taxonomy">,
): SurveyMatrixEntry[][] {
  const sorted = [...entries].sort((a, b) => a.entryId.localeCompare(b.entryId));
  if (kind === "research_gap" || kind === "future_direction") {
    return chunkBy(sorted, SYNTHESIS_BATCH_MAX_ENTRIES);
  }
  const byFamily = new Map<string, SurveyMatrixEntry[]>();
  for (const entry of sorted) {
    const family = entry.methodFamily ?? UNCLASSIFIED_FAMILY;
    const group = byFamily.get(family) ?? [];
    group.push(entry);
    byFamily.set(family, group);
  }
  // 只有 ≥2 条的 family 才可能产出跨论文综合；单条 family 不浪费调用
  const batches: SurveyMatrixEntry[][] = [];
  for (const group of [...byFamily.values()].sort((a, b) => a[0]!.entryId.localeCompare(b[0]!.entryId))) {
    if (group.length < 2) {
      continue;
    }
    batches.push(...chunkBy(group, SYNTHESIS_BATCH_MAX_ENTRIES));
  }
  return batches;
}

function chunkBy(entries: SurveyMatrixEntry[], max: number): SurveyMatrixEntry[][] {
  const out: SurveyMatrixEntry[][] = [];
  for (let index = 0; index < entries.length; index += max) {
    out.push(entries.slice(index, index + max));
  }
  return out;
}

/** taxonomy 确定性聚合：family → subFamily leaf；空家族不生成；unclassified 单独保留 */
export function buildTaxonomyItems(
  matrix: SurveyMatrixArtifact,
  updatedAt: string,
): SurveySynthesisItem[] {
  const items: SurveySynthesisItem[] = [];
  const emit = (
    family: string,
    subFamily: string | undefined,
    entries: SurveyMatrixEntry[],
  ): void => {
    if (entries.length === 0) {
      return; // 空 family / 空 leaf 不生成正式 node
    }
    const entryIds = entries.map((entry) => entry.entryId).sort();
    const sourceIds = [...new Set(entries.map((entry) => entry.sourceId))].sort();
    const idList =
      entryIds.length <= 10 ? entryIds.join("、") : `${entryIds.slice(0, 10).join("、")} 等 ${entryIds.length} 条`;
    const claim =
      family === UNCLASSIFIED_FAMILY
        ? `未归类（unclassified）文献 ${entries.length} 篇，等待人工修正 taxonomy 标签（${idList}）`
        : subFamily === undefined
          ? `方法家族 ${family} 收录 ${entries.length} 篇文献（${idList}）`
          : `方法家族 ${family} / ${subFamily} 收录 ${entries.length} 篇文献（${idList}）`;
    const decision = deriveGroundingLevel({
      kind: "taxonomy",
      detail: { kind: "taxonomy", family, ...(subFamily !== undefined ? { subFamily } : {}) },
      entryIds,
      entries: [],
      evidence: [],
      sourceIds,
    });
    items.push({
      synthesisId: synthesisId("taxonomy", claim, sourceIds),
      kind: "taxonomy",
      claim,
      groundingLevel: decision.level,
      evidenceIds: [],
      sourceIds,
      derivedFrom: { entryIds },
      detail: { kind: "taxonomy", family, ...(subFamily !== undefined ? { subFamily } : {}) },
      groundingReason: decision.reason,
      updatedAt,
    });
  };

  for (const family of matrix.taxonomy.families) {
    const inFamily = matrix.entries.filter((entry) => entry.methodFamily === family.label);
    if (inFamily.length === 0) {
      continue;
    }
    if (family.subFamilies !== undefined && family.subFamilies.length > 0) {
      for (const subFamily of family.subFamilies) {
        emit(family.label, subFamily, inFamily.filter((entry) => entry.subFamily === subFamily));
      }
      // family 直属：有 subFamily 词表但未归入任何 sub 的条目
      emit(
        family.label,
        undefined,
        inFamily.filter(
          (entry) => entry.subFamily === undefined || !family.subFamilies!.includes(entry.subFamily),
        ),
      );
    } else {
      emit(family.label, undefined, inFamily);
    }
  }
  // unclassified（含未填 methodFamily 的条目）：单独保留，绝不猜回某个 family
  emit(
    UNCLASSIFIED_FAMILY,
    undefined,
    matrix.entries.filter(
      (entry) =>
        entry.methodFamily === undefined ||
        entry.methodFamily === UNCLASSIFIED_FAMILY ||
        taxonomyFamilyOf(matrix.taxonomy, entry.methodFamily) === undefined,
    ),
  );
  return items;
}

/** taxonomy 聚合统计（gap / future prompt 的全局视野；确定性文本） */
export function renderTaxonomyStats(matrix: SurveyMatrixArtifact): string {
  const lines: string[] = [];
  for (const family of matrix.taxonomy.families) {
    const inFamily = matrix.entries.filter((entry) => entry.methodFamily === family.label);
    const subs =
      family.subFamilies !== undefined && family.subFamilies.length > 0
        ? family.subFamilies
            .map(
              (sub) =>
                `${sub}=${inFamily.filter((entry) => entry.subFamily === sub).length}`,
            )
            .join(" / ")
        : undefined;
    lines.push(
      `- ${family.label}: ${inFamily.length} 篇${subs !== undefined ? `（${subs}）` : ""}`,
    );
  }
  const unclassified = matrix.entries.filter(
    (entry) => entry.methodFamily === undefined || entry.methodFamily === UNCLASSIFIED_FAMILY,
  ).length;
  lines.push(`- unclassified: ${unclassified} 篇`);
  const depths = matrix.entries.filter((entry) => entry.interpretationDepth === "abstract_only").length;
  lines.push(`- 解释深度：fulltext ${matrix.entries.length - depths} 篇 / abstract_only ${depths} 篇`);
  const withLimitation = matrix.entries.filter((entry) => entry.limitation !== undefined).length;
  lines.push(`- 有明确 limitation 记录的条目：${withLimitation} 篇`);
  return lines.join("\n");
}

// ---- Prompt ----

/** 综合候选 prompt（独立可测；entries 为本 batch 的 Matrix 条目投影） */
export function buildSynthesisPrompt(input: {
  kind: Exclude<SurveySynthesisKind, "taxonomy">;
  entries: SurveyMatrixEntry[];
  taxonomy: string[];
  yearBySource?: Map<string, number>;
  taxonomyStats: string;
  gapClaims?: string[];
}): string {
  const { kind, entries } = input;
  const kindBlocks: Record<Exclude<SurveySynthesisKind, "taxonomy">, string> = {
    trend: [
      '本批次 kind = "trend"（研究方法随时间的发展变化）。detail 结构：',
      '{"period": "时间窗（如 2017-2020 或 early/近年）", "direction": "变化方向一句话"}',
      "硬性要求：至少引用 2 篇不同文献；不能仅因两篇年份不同就制造趋势——只在方法演进有实质变化时输出；abstract_only 条目只能参与宽口径统计，不能作为趋势的主要依据。",
    ].join("\n"),
    comparison: [
      '本批次 kind = "comparison"（方法族 / 方法横向比较）。detail 结构：',
      '{"dimension": "比较维度（优先使用：assumption / data dependency / appearance dependency / motion modeling / computational complexity / occlusion handling / applicable scenario；确需其它维度必须有条目字段支撑）", "sides": [{"label": "一侧名称", "entryIds": ["M-S…"], "basis": "该侧依据（只来自所引条目的字段，不新造事实）"}]}',
      "硬性要求：每一侧至少 1 篇不同文献；不得拿 A 的优点对比 B 的无关缺点伪造公平比较。",
    ].join("\n"),
    consensus: [
      '本批次 kind = "consensus"（多篇论文共同支持的结论）。detail 结构：{}（留空对象，系统按事实回填统计）',
      "硬性要求：至少 2 篇不同文献支持同一结论才可输出；3 篇及以上才构成真正 consensus，2 篇会被系统降级为 observed agreement。",
    ].join("\n"),
    disagreement: [
      '本批次 kind = "disagreement"（论文之间真实存在的结论差异 / 方法取舍）。detail 结构：',
      '{"issue": "分歧问题（一句话）", "sideA": {"label": "一侧名称", "entryIds": ["M-S…"]}, "sideB": {"label": "另一侧名称", "entryIds": ["M-S…"]}}',
      "硬性要求：每侧至少 1 篇不同文献；两侧观点必须针对同一问题维度真实对立；不能完全依赖 abstract_only 条目立论。",
    ].join("\n"),
    research_gap: [
      '本批次 kind = "research_gap"（研究空缺）。只允许三种触发来源，detail 结构：',
      '{"trigger": "literature_limitation | taxonomy_empty | coverage_missing", "basis": "空缺依据（limitation 归纳 / taxonomy 结构证据 / coverage 缺口说明）"}',
      "- literature_limitation：多篇文献明确 limitation 的聚合（引用这些条目）",
      "- taxonomy_empty：taxonomy 聚合结构上的真实覆盖空缺（依据下方统计，如某 subFamily 为 0 而相邻方向多篇）",
      "- coverage_missing：当前 Survey coverage 明确缺少的维度（如所有文献都未涉及某数据集 / 场景）",
      "禁止自由推测「目前还没有人研究 X，因此未来应该 Y」——无法归入三类的不要输出。",
    ].join("\n"),
    future_direction: [
      '本批次 kind = "future_direction"（未来方向）。detail 结构：',
      '{"origin": "cited_future_work | inferred"}',
      "- cited_future_work：文献锚点 chunk 中明确提出的 future work / remaining limitation（必须配 evidenceProposal 指向该 chunk）",
      "- inferred：由趋势 / 局限 / 空缺推导的方向（系统会如实标记 speculative，这不是惩罚）",
      "只消费下方已确认的研究空缺与各条目的 future work 线索，不发明新方向。",
    ].join("\n"),
  };
  const lines: string[] = [
    "你是一名学术研究员（Researcher）。下面是同一课题多篇文献的 Survey Matrix 摘要（每篇的结构化理解）。请产出「跨论文综合候选」（candidate synthesis）——说明这批论文整体反映了什么，而不是逐篇复述。",
    "",
    "只输出一个 JSON 对象（不要 Markdown 围栏、不要解释文字）：",
    '{"candidates": [',
    "  {",
    '    "kind": "' + kind + '",',
    '    "claim": "综合陈述（≤500 字符；必须由所引条目支撑，不得引入 Matrix 之外的事实）",',
    '    "detail": { … 按下方本批次结构 … },',
    '    "entryIds": ["M-S…（必须从下方条目列表逐字复制）"],',
    '    "evidenceProposals": [',
    '      {"entryId": "M-S…", "chunkId": "（必须从该条目的锚点 chunk 列表逐字复制）", "evidenceClaim": "该 chunk 支撑的单源子断言（一句话）"}',
    "    ]",
    "  }",
    "]}",
    "",
    "通用要求：",
    "1. 引用纪律：entryIds / chunkId 只能逐字复制下方出现的标识，绝不凭记忆生成、绝不改写。",
    `2. evidenceProposals 可选（≤${EVIDENCE_PROPOSALS_MAX} 条）：只对 claim 的关键支撑提出；abstract_only 条目没有锚点，不能出现在 proposals 中；本条目列表之外的 chunkId 一律无效。`,
    "3. 你的输出不包含 groundingLevel / evidenceIds 等自报字段——是否 grounded 由系统核验决定。",
    "4. 宁缺毋滥：依据不足就不要输出该 candidate；空 candidates 数组是合法输出。",
    "",
    "===== 本批次 kind 指令 =====",
    kindBlocks[kind],
    "",
    "===== Matrix 条目（本批次） =====",
    ...entries.map((entry) => renderEntryForPrompt(entry, input.yearBySource)).flat(),
    "",
    "===== taxonomy 聚合统计（全局视野） =====",
    input.taxonomyStats,
  ];
  if (input.gapClaims !== undefined && input.gapClaims.length > 0) {
    lines.push("", "===== 已确认的研究空缺（只消费这些与文献线索，不发明新空缺） =====");
    for (const claim of input.gapClaims) {
      lines.push(`- ${claim}`);
    }
  }
  lines.push(
    "",
    "===== taxonomy 家族标签（供参考） =====",
    input.taxonomy.join("、"),
  );
  return lines.join("\n");
}

function renderEntryForPrompt(
  entry: SurveyMatrixEntry,
  yearBySource: Map<string, number> | undefined,
): string[] {
  const year = yearBySource?.get(entry.sourceId);
  const family =
    entry.methodFamily === undefined
      ? UNCLASSIFIED_FAMILY
      : `${entry.methodFamily}${entry.subFamily !== undefined ? `/${entry.subFamily}` : ""}`;
  const lines = [
    `- ${entry.entryId}｜${entry.interpretationDepth}${year !== undefined ? `｜${year}` : ""}｜${family}`,
    optionalLine("问题", entry.researchProblem),
    optionalLine("思想", entry.mainIdea),
    optionalLine("技术", entry.keyTechnique),
    optionalLine("假设", entry.assumption),
    optionalLine("优点", entry.strength),
    optionalLine("局限", entry.limitation),
    entry.keyFindings !== undefined ? `  发现: ${entry.keyFindings.join("；")}` : undefined,
    optionalLine("数据", entry.datasetContext),
    entry.comparedMethods !== undefined ? `  对比: ${entry.comparedMethods.join("、")}` : undefined,
  ].filter((line): line is string => line !== undefined);
  const chunkIds = anchorChunkIdsOf(entry).slice(0, SYNTHESIS_CHUNK_IDS_PER_ENTRY);
  if (entry.interpretationDepth === "fulltext") {
    lines.push(
      chunkIds.length > 0
        ? `  锚点chunk: ${chunkIds.join(" ")}`
        : "  锚点chunk: （无——本条目弱锚定，不能用于 evidenceProposals）",
    );
  }
  return lines;
}

function optionalLine(label: string, value: string | undefined): string | undefined {
  return value === undefined ? undefined : `  ${label}: ${value}`;
}
