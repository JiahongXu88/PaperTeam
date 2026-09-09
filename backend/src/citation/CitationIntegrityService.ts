/**
 * Citation Integrity 编排服务。
 *
 * Stage 化流水线（每个 stage 有输入指纹 + 产物持久化 + 可独立重跑）：
 *   extract   引用条目 + 正文 callout（确定性，本文件）
 *   metadata  文献真实性核验（ScholarlyResolver）
 *   semantic  (claim, citation) 语义核验
 *
 * 第 37 篇引用检索失败不会要求重新 parse PDF——文件粒度记录 + 指纹跳过。
 */

import type { AgentRuntime } from "../runtime/types.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { BusinessError } from "../errors.js";
import { fingerprintJson } from "../util/hash.js";
import type { PaperStore, StageRecord } from "../paper/PaperStore.js";
import { ReferenceExtractor, type ExtractionResult } from "../paper/ReferenceExtractor.js";
import type {
  CitationCallout,
  CitationMetadataStatus,
  CitationVerificationRecord,
  ClaimCitationRecord,
  ReferenceEntry,
} from "./integrity.js";
import { deriveClaimSeverity } from "./integrity.js";
import { METADATA_VERIFICATION_VERSION, ScholarlyResolver, type ScholarlyResolverOptions } from "./scholarly.js";
import { SoftwareReferenceResolver, type SoftwareResolverOptions } from "./softwareResolver.js";
import { extractRepositoryRef, inferReferenceKind } from "./referenceKinds.js";
import type { CitationSemanticMode } from "./semanticMode.js";
import { REFERENCE_EXTRACTION_VERSION } from "../paper/ReferenceExtractor.js";
import { extractJsonObject } from "../agents/outputParsing.js";
import {
  CLAIM_DECOMPOSITION_VERSION,
  DECOMPOSITION_BATCH_SIZE,
  buildDecompositionPrompt,
  fallbackPlan,
  groupCalloutsBySentence,
  needsDecomposition,
  parseDecompositionSentence,
  planFromModelOutput,
  sentenceHasJudgeableGroup,
  type SentenceCalloutGroup,
  type SentenceClaimPlan,
} from "./claimDecomposition.js";
import {
  buildClaimRecords,
  buildGroupEvidence,
  buildJudgePrompt,
  parseJudgeOutput,
  SEMANTIC_VERIFICATION_VERSION,
  summarizeSemantic,
  type SemanticSummary,
} from "./semanticVerifier.js";

/** 拆解模型调用上限（批大小 8 → 覆盖 ~190 句；超限句子走确定性兜底） */
const MAX_DECOMPOSITION_CALLS = 24;

/** semantic stage telemetry（回答「这次语义核验烧了多少 token」） */
export interface SemanticTelemetry {
  modelCalls: number;
  skippedNoMetadata: number;
  skippedNoEvidence: number;
  failed: number;
  approxPromptChars: number;
  /** 模型调用总耗时（ms；短路为 0）——性能诊断用 */
  totalModelMs: number;
  /** 每次模型调用耗时样本（ms；p50/p95 统计用，不落盘） */
  modelCallMs: number[];
  /** claim 拆解（v4）：批量模型调用次数 / 缓存命中 / 确定性兜底句子数 / 规划句子总数 */
  decompositionCalls: number;
  decompositionCacheHits: number;
  fallbackSentencePlans: number;
  sentencesPlanned: number;
}

/** metadata stage 的外部检索画像（性能诊断：谁被查了几次、花了多久） */
export interface MetadataLookupProfile {
  providerCalls: number;
  cacheHits: number;
  retries: number;
  byProvider: Array<{
    provider: string;
    calls: number;
    notFound: number;
    errors: number;
    cacheHits: number;
    totalMs: number;
  }>;
  software: { apiCalls: number; htmlCalls: number; cacheHits: number; notFound: number; errors: number };
}

export interface CitationIntegrityOptions {
  projects: ProjectStore;
  store: PaperStore;
  /** semantic judge 用的 Runtime（citation 角色 scope） */
  runtime?: AgentRuntime;
  citationAgentId?: string;
  /** scholarly resolver 注入（测试用 fake providers / fetch） */
  scholarly?: ScholarlyResolverOptions;
  /** software resolver 注入（测试用 fake fetch） */
  software?: SoftwareResolverOptions;
  /** metadata 核验上限（rate-limit friendly，默认 40） */
  maxMetadataLookups?: number;
  /** semantic 核验上限（默认 30；token 控制） */
  maxSemanticVerifications?: number;
  now?: () => Date;
  log?: (message: string) => void;
}

export class CitationIntegrityService {
  private readonly projects: ProjectStore;
  private readonly store: PaperStore;
  private readonly resolver: ScholarlyResolver;
  private readonly softwareResolver: SoftwareReferenceResolver;
  private readonly runtime: AgentRuntime | undefined;
  private readonly citationAgentId: string | undefined;
  private readonly maxLookups: number;
  private readonly maxSemantic: number;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  /** 最近一次 verifyClaims 的 telemetry（模型调用数 / 上下文规模） */
  lastSemanticTelemetry: SemanticTelemetry | undefined;
  /** 最近一次 verifyMetadata 的外部检索画像（性能诊断） */
  lastMetadataProfile: MetadataLookupProfile | undefined;

  constructor(options: CitationIntegrityOptions) {
    this.projects = options.projects;
    this.store = options.store;
    this.resolver = new ScholarlyResolver(options.scholarly);
    this.softwareResolver = new SoftwareReferenceResolver(options.software);
    this.runtime = options.runtime;
    this.citationAgentId = options.citationAgentId;
    this.maxLookups = options.maxMetadataLookups ?? 40;
    this.maxSemantic = options.maxSemanticVerifications ?? 30;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  /** 共享 resolver（受控学术检索工具复用同一缓存与 telemetry） */
  get scholarlyResolver(): ScholarlyResolver {
    return this.resolver;
  }

  /** 提取 stage：references + callouts 提取并持久化（指纹一致则跳过） */
  async extract(
    projectId: string,
    options: { force?: boolean } = {},
  ): Promise<{ result: ExtractionResult; reused: boolean }> {
    await this.projects.getRequired(projectId);
    const document = await this.store.loadDocument(projectId);
    if (document === null) {
      throw new BusinessError("INVALID_REQUEST", "尚未上传/解析 Final PDF（先上传 PDF 再提取引用）");
    }
    // 提取算法版本纳入指纹：extractor 修复（如断词恢复）后旧条目自动重提，不必用户删 workspace
    const inputFingerprint = fingerprintJson({
      extractorVersion: REFERENCE_EXTRACTION_VERSION,
      referencesSectionId: document.referencesSectionId ?? null,
      chunks: document.chunks.map((chunk) => `${chunk.chunkId}:${chunk.text}`),
    });
    const stage = (await this.store.loadStages(projectId))["references"];
    const stageMatches =
      stage?.status === "ok" && stage.inputFingerprint === inputFingerprint && !options.force;
    if (stageMatches) {
      const references = await this.store.loadReferences<ReferenceEntry>(projectId);
      const callouts = await this.store.loadCallouts<CitationCallout>(projectId);
      if (references.length > 0 || callouts.length > 0) {
        return {
          result: { references, callouts, notes: [] },
          reused: true,
        };
      }
    }

    const result = new ReferenceExtractor().extract(document);
    await this.store.saveExtraction(projectId, {
      references: result.references,
      callouts: result.callouts,
      notes: result.notes,
    });
    await this.saveStage(projectId, {
      stage: "references",
      status: "ok",
      inputFingerprint,
      outputSummary: {
        referenceCount: result.references.length,
        calloutCount: result.callouts.length,
      },
      updatedAt: this.now().toISOString(),
    });
    this.log(
      `[citation-integrity] projectId=${projectId} 提取完成：references=${result.references.length} callouts=${result.callouts.length}`,
    );
    return { result, reused: false };
  }

  /** 当前提取摘要（供 API / Quality Gate） */
  async summary(projectId: string): Promise<{
    extracted: boolean;
    references: number;
    callouts: number;
    resolvedRelations: number;
    unresolvedRelations: number;
    invalidRelations: number;
    referencesWithDoi: number;
  }> {
    await this.projects.getRequired(projectId);
    const references = await this.store.loadReferences<{ doi?: string }>(projectId);
    const callouts = await this.store.loadCallouts<{
      references: Array<{ status: string }>;
    }>(projectId);
    let resolved = 0;
    let unresolved = 0;
    let invalid = 0;
    for (const callout of callouts) {
      for (const relation of callout.references ?? []) {
        if (relation.status === "resolved") {
          resolved += 1;
        } else if (relation.status === "unresolved") {
          unresolved += 1;
        } else {
          invalid += 1;
        }
      }
    }
    return {
      extracted: references.length > 0 || callouts.length > 0,
      references: references.length,
      callouts: callouts.length,
      resolvedRelations: resolved,
      unresolvedRelations: unresolved,
      invalidRelations: invalid,
      referencesWithDoi: references.filter((reference) => reference.doi !== undefined).length,
    };
  }

  protected async saveStage(projectId: string, record: StageRecord): Promise<void> {
    await this.store.saveStage(projectId, record);
  }

  // ---- metadata 核验 stage（确定性外部核验，无 LLM） ----

  /**
   * 逐条核验（文件粒度持久化 + 指纹跳过：第 37 条失败不影响前 36 条，
   * 重跑只补缺失/变化条目）。默认上限 maxLookups 条。
   */
  async verifyMetadata(
    projectId: string,
    options: { force?: boolean; signal?: AbortSignal } = {},
  ): Promise<{
    byStatus: Record<CitationMetadataStatus, number>;
    checked: number;
    reused: number;
    records: CitationVerificationRecord[];
    telemetry: { providerCalls: number; cacheHits: number; retries: number };
    /** 外部检索画像（性能诊断：按 provider 的调用 / 命中 / 耗时） */
    profile: MetadataLookupProfile;
  }> {
    await this.projects.getRequired(projectId);
    const references = await this.store.loadReferences<ReferenceEntry>(projectId);
    if (references.length === 0) {
      throw new BusinessError("INVALID_REQUEST", "尚未提取引用（先 POST /citations/extract）");
    }
    const targets = references.slice(0, this.maxLookups);
    const byStatus: Record<CitationMetadataStatus, number> = {
      VERIFIED: 0,
      METADATA_MISMATCH: 0,
      AMBIGUOUS: 0,
      NOT_FOUND: 0,
      PROVIDER_ERROR: 0,
      UNRESOLVED: 0,
    };
    const records: CitationVerificationRecord[] = [];
    let reused = 0;
    for (const reference of targets) {
      // 取消检查（逐条粒度，与 verifyClaims 一致）：已保存的记录保留，
      // 剩余条目下次核验自动补查（PROVIDER_ERROR / 未查不算结论）
      if (options.signal?.aborted === true) {
        throw new BusinessError("WORKFLOW_CANCELLED", "引用真实性核验已被取消");
      }
      const existing = await this.store.loadRecord<CitationVerificationRecord>(
        projectId,
        "metadata",
        reference.referenceId,
      );
      // 复用条件：条目原文未变 且 核验算法版本一致（旧算法的 NOT_FOUND 不能沿用）；
      // PROVIDER_ERROR / 旧 UNRESOLVED 是 provider 瞬时失败（限流/超时），不是结论——
      // 下次核验必须重试
      if (
        !options.force &&
        existing !== null &&
        existing.fingerprint === reference.fingerprint &&
        existing.algorithmVersion === METADATA_VERIFICATION_VERSION &&
        existing.status !== "UNRESOLVED" &&
        existing.status !== "PROVIDER_ERROR"
      ) {
        byStatus[existing.status] += 1;
        records.push(existing);
        reused += 1;
        continue;
      }
      const record = await this.verifyReference(projectId, reference);
      byStatus[record.status] += 1;
      records.push(record);
    }
    await this.saveStage(projectId, {
      stage: "metadata",
      status: "ok",
      inputFingerprint: fingerprintJson({
        algorithmVersion: METADATA_VERIFICATION_VERSION,
        references: targets.map((r) => `${r.referenceId}:${r.fingerprint}`),
      }),
      outputSummary: { ...byStatus, checked: targets.length },
      updatedAt: this.now().toISOString(),
    });
    this.log(
      `[citation-integrity] projectId=${projectId} metadata 核验：checked=${targets.length} reused=${reused} verified=${byStatus.VERIFIED} not_found=${byStatus.NOT_FOUND} provider_error=${byStatus.PROVIDER_ERROR}`,
    );
    const profile: MetadataLookupProfile = {
      providerCalls: this.resolver.telemetry.providerCalls,
      cacheHits: this.resolver.telemetry.cacheHits,
      retries: this.resolver.telemetry.retries,
      byProvider: [...this.resolver.byProvider.entries()].map(([provider, stat]) => ({ provider, ...stat })),
      software: { ...this.softwareResolver.telemetry },
    };
    this.lastMetadataProfile = profile;
    return {
      byStatus,
      checked: targets.length,
      reused,
      records,
      telemetry: {
        providerCalls: profile.providerCalls,
        cacheHits: profile.cacheHits,
        retries: profile.retries,
      },
      profile,
    };
  }

  /**
   * 单条核验（kind 分派）：
   *   software → SoftwareReferenceResolver（官方 repository / docs；学术库不收录软件）
   *   其它     → ScholarlyResolver（学术库）
   * 查询失败（timeout/429/5xx）→ PROVIDER_ERROR，绝不折叠成 NOT_FOUND。
   */
  private async verifyReference(
    projectId: string,
    reference: ReferenceEntry,
  ): Promise<CitationVerificationRecord> {
    const kind = inferReferenceKind(reference);
    const record =
      kind === "software"
        ? await this.verifySoftwareReference(reference)
        : await this.verifyScholarlyReference(reference);
    await this.store.saveRecord(projectId, "metadata", reference.referenceId, record);
    return record;
  }

  /** software 类：官方 repository / documentation 权威源核验 */
  private async verifySoftwareReference(
    reference: ReferenceEntry,
  ): Promise<CitationVerificationRecord> {
    const repository = extractRepositoryRef(reference);
    if (repository === undefined) {
      // inferReferenceKind 判 software 的依据就是 repository 链接——不可达分支（防御）
      return this.unresolvedRecord(reference, "software 条目缺少 repository 链接");
    }
    const outcome = await this.softwareResolver.resolve(
      { ...(reference.title !== undefined ? { title: reference.title } : {}), repository },
      this.now().toISOString(),
    );
    const attempts = [
      {
        provider: "github" as const,
        outcome:
          outcome.kind === "match"
            ? ("match" as const)
            : outcome.kind === "mismatch"
              ? ("mismatch" as const)
              : outcome.kind === "not_found"
                ? ("not_found" as const)
                : ("error" as const),
        ...(outcome.kind === "error" ? { note: outcome.note } : {}),
        ...(outcome.kind === "match" || outcome.kind === "mismatch"
          ? { note: `官方仓库：${outcome.canonical.software?.repositoryUrl ?? outcome.canonical.url}` }
          : {}),
      },
    ];
    if (outcome.kind === "error") {
      return {
        referenceId: reference.referenceId,
        kind: "software",
        status: "PROVIDER_ERROR",
        probableFabrication: false,
        attempts,
        checkedAt: this.now().toISOString(),
        fingerprint: reference.fingerprint,
        algorithmVersion: METADATA_VERIFICATION_VERSION,
        error: outcome.note,
      };
    }
    return {
      referenceId: reference.referenceId,
      kind: "software",
      status:
        outcome.kind === "match" ? "VERIFIED" : outcome.kind === "mismatch" ? "METADATA_MISMATCH" : "NOT_FOUND",
      probableFabrication: false, // software：404 也可能是改名/迁移，不判捏造
      ...(outcome.kind === "match" || outcome.kind === "mismatch"
        ? { canonical: outcome.canonical }
        : {}),
      ...(outcome.kind === "mismatch" ? { mismatches: outcome.mismatches } : {}),
      attempts,
      checkedAt: this.now().toISOString(),
      fingerprint: reference.fingerprint,
      algorithmVersion: METADATA_VERIFICATION_VERSION,
    };
  }

  /** scholarly 类：学术库多源核验（原有链路） */
  private async verifyScholarlyReference(
    reference: ReferenceEntry,
  ): Promise<CitationVerificationRecord> {
    const verdict = await this.resolver.resolve({
      ...(reference.title !== undefined ? { title: reference.title } : {}),
      ...(reference.authors !== undefined ? { authors: reference.authors } : {}),
      ...(reference.year !== undefined ? { year: reference.year } : {}),
      ...(reference.doi !== undefined ? { doi: reference.doi } : {}),
      ...(reference.arxivId !== undefined ? { arxivId: reference.arxivId } : {}),
    });
    const notFoundAttempts = verdict.attempts.filter((attempt) => attempt.outcome === "not_found").length;
    const status: CitationMetadataStatus =
      verdict.outcome === "match"
        ? "VERIFIED"
        : verdict.outcome === "mismatch"
          ? "METADATA_MISMATCH"
          : verdict.outcome === "ambiguous"
            ? "AMBIGUOUS"
            : verdict.outcome === "not_found"
              ? "NOT_FOUND"
              : "PROVIDER_ERROR";
    // probable fabrication = 强证据：全部书目库一致 not_found（≥3 且无 error）+ 有可查字段
    const probableFabrication =
      status === "NOT_FOUND" &&
      notFoundAttempts >= 3 &&
      verdict.attempts.every((attempt) => attempt.outcome === "not_found") &&
      (reference.title !== undefined || reference.doi !== undefined);
    return {
      referenceId: reference.referenceId,
      status,
      probableFabrication,
      ...(verdict.canonical !== undefined
        ? { canonical: verdict.canonical }
        : verdict.candidates !== undefined && verdict.candidates.length > 0
          ? { canonical: verdict.candidates[0] }
          : {}),
      ...(verdict.mismatches !== undefined ? { mismatches: verdict.mismatches } : {}),
      attempts: verdict.attempts.map((attempt) => ({
        provider: attempt.provider as CitationVerificationRecord["attempts"][number]["provider"],
        outcome:
          attempt.outcome === "match"
            ? "match"
            : attempt.outcome === "mismatch"
              ? "mismatch"
              : attempt.outcome === "not_found"
                ? "not_found"
                : attempt.outcome === "ambiguous"
                  ? "ambiguous"
                  : "error",
        ...(attempt.note !== undefined ? { note: attempt.note } : {}),
      })),
      checkedAt: this.now().toISOString(),
      fingerprint: reference.fingerprint,
      algorithmVersion: METADATA_VERIFICATION_VERSION,
      ...(verdict.outcome === "unresolved"
        ? { error: verdict.attempts.find((a) => a.outcome === "error")?.note ?? "多源检索未获结论" }
        : {}),
    };
  }

  /** 无可查字段 / provider 失败的兜底记录（PROVIDER_ERROR，下次重试） */
  private unresolvedRecord(reference: ReferenceEntry, note: string): CitationVerificationRecord {
    return {
      referenceId: reference.referenceId,
      kind: inferReferenceKind(reference),
      status: "PROVIDER_ERROR",
      probableFabrication: false,
      attempts: [],
      checkedAt: this.now().toISOString(),
      fingerprint: reference.fingerprint,
      algorithmVersion: METADATA_VERIFICATION_VERSION,
      error: note,
    };
  }

  /** 全部 metadata 记录（API 用） */
  async listMetadataRecords(projectId: string): Promise<CitationVerificationRecord[]> {
    await this.projects.getRequired(projectId);
    const ids = await this.store.listRecordIds(projectId, "metadata");
    const records: CitationVerificationRecord[] = [];
    for (const id of ids) {
      const record = await this.store.loadRecord<CitationVerificationRecord>(projectId, "metadata", id);
      if (record !== null) {
        records.push(record);
      }
    }
    return records;
  }

  // ---- semantic verification stage（(claim, citation) 单记录） ----

  /**
   * 逐条语义核验（v4：atomic claim × citation group）。
   *
   * 流程：callout 按句归组 → 句子拆解成原子论断（model 批量 / 确定性兜底，
   * 版本化缓存）→ (原子论断 × 引用组) 记录构建 → 确定性短路优先（组内可判
   * 成员为零 → SKIPPED；组证据为空 → INSUFFICIENT_EVIDENCE，均零模型调用）
   * → 组证据合并 judge。
   *
   * mode：full = 完整逐条核验；contradiction_only = 仅检查明显矛盾
   * （无证据 → SKIPPED，不产生 INSUFFICIENT_EVIDENCE 噪音；judge 只回答
   * CONTRADICTED / NO_CONTRADICTION_DETECTED / INSUFFICIENT_EVIDENCE）。
   * off 由调用方（workflow / API）负责——本方法不应该是 off 的入口。
   */
  async verifyClaims(
    projectId: string,
    options: { force?: boolean; limit?: number; signal?: AbortSignal; mode?: CitationSemanticMode } = {},
  ): Promise<{
    summary: SemanticSummary;
    verified: number;
    reused: number;
    records: ClaimCitationRecord[];
    telemetry: SemanticTelemetry;
    mode: CitationSemanticMode;
    /** 本次 verifyClaims 的墙钟耗时（ms；性能画像用） */
    durationMs: number;
  }> {
    if (this.runtime === undefined || this.citationAgentId === undefined) {
      throw new BusinessError("INVALID_REQUEST", "semantic 核验需要 Runtime（服务未配置 runtime）");
    }
    const mode: CitationSemanticMode = options.mode ?? "full";
    await this.projects.getRequired(projectId);
    const [references, callouts, document, metadataRaw] = await Promise.all([
      this.store.loadReferences<ReferenceEntry>(projectId),
      this.store.loadCallouts<CitationCallout>(projectId),
      this.store.loadDocument(projectId),
      this.listMetadataRecords(projectId),
    ]);
    if (references.length === 0) {
      throw new BusinessError("INVALID_REQUEST", "尚未提取引用（先 POST /citations/extract）");
    }
    if (metadataRaw.length === 0) {
      throw new BusinessError(
        "INVALID_REQUEST",
        "尚未执行 metadata 核验（先 POST /citations/verify-metadata——真实性 Gate 先于语义核验）",
      );
    }
    const metadataRecords = new Map(metadataRaw.map((record) => [record.referenceId, record]));
    const sectionTitles = new Map((document?.sections ?? []).map((s) => [s.sectionId, s.title]));

    const telemetry: SemanticTelemetry = {
      modelCalls: 0,
      skippedNoMetadata: 0,
      skippedNoEvidence: 0,
      failed: 0,
      approxPromptChars: 0,
      totalModelMs: 0,
      modelCallMs: [] as number[],
      decompositionCalls: 0,
      decompositionCacheHits: 0,
      fallbackSentencePlans: 0,
      sentencesPlanned: 0,
    };
    const startedAtMs = Date.now();
    const sentenceGroups = groupCalloutsBySentence(callouts);
    const plans = await this.planSentenceClaims(
      projectId,
      sentenceGroups,
      references,
      metadataRecords,
      options,
      telemetry,
    );
    telemetry.sentencesPlanned = sentenceGroups.length;
    const pending = buildClaimRecords(
      sentenceGroups,
      plans,
      references,
      metadataRecords,
      sectionTitles,
      mode,
    );

    const limit = options.limit ?? this.maxSemantic;
    let verifiedCount = 0;
    let reused = 0;
    const records: ClaimCitationRecord[] = [];
    for (const claim of pending) {
      const existing = await this.store.loadRecord<ClaimCitationRecord>(
        projectId,
        "claims",
        claim.claimCitationId,
      );
      if (
        !options.force &&
        existing !== null &&
        existing.fingerprint === claim.fingerprint &&
        (existing.status === "verified" || existing.status === "skipped")
      ) {
        // 只有终态成功记录才复用；failed/pending 必须重试（可恢复语义）
        records.push(existing);
        reused += 1;
        continue;
      }
      if (options.signal?.aborted === true) {
        throw new BusinessError("WORKFLOW_CANCELLED", "语义核验已被取消");
      }
      // 上限只约束模型调用：确定性短路（SKIPPED / 无证据 INSUFFICIENT）零成本，
      // 不占预算——否则 54 条免费短路与真实 judge 抢同一个 30 条额度
      const record = await this.verifyClaim(
        projectId,
        claim,
        references,
        metadataRecords,
        telemetry,
        options.signal,
        limit,
        mode,
      );
      if (record === null) {
        records.push(claim); // 模型预算耗尽：保持 pending（下一轮继续）
        continue;
      }
      records.push(record);
      if (record.status === "verified" || record.status === "skipped") {
        verifiedCount += 1;
      }
    }
    const durationMs = Date.now() - startedAtMs;

    const summary = summarizeSemantic(metadataRaw, records);
    await this.saveStage(projectId, {
      stage: "semantic",
      status: "ok",
      inputFingerprint: fingerprintJson(pending.map((claim) => `${claim.claimCitationId}:${claim.fingerprint}`)),
      outputSummary: { total: summary.total, ...summary.byVerdict },
      updatedAt: this.now().toISOString(),
    });
    this.lastSemanticTelemetry = telemetry;
    this.log(
      `[citation-integrity] projectId=${projectId} semantic 核验（mode=${mode}）：total=${summary.total} verified=${verifiedCount} skipped=${summary.skipped} modelCalls=${telemetry.modelCalls}`,
    );
    return { summary, verified: verifiedCount, reused, records, telemetry, mode, durationMs };
  }

  /**
   * 句子 → 原子论断规划（拆解层）。
   *
   * 确定性优先：句内没有任何可判证据的引用组 → 不拆（全组短路，零模型调用）；
   * 简单句（单组、短、无复合结构）→ 整句单论断兜底（零模型调用）。
   * 其余句子批量走模型结构化拆解（版本化缓存 + 批大小 + 总量上限），
   * 单句解析失败单独退回确定性兜底，不拖垮整批。
   */
  private async planSentenceClaims(
    projectId: string,
    sentenceGroups: SentenceCalloutGroup[],
    references: ReferenceEntry[],
    metadataRecords: Map<string, CitationVerificationRecord>,
    options: { force?: boolean; signal?: AbortSignal },
    telemetry: SemanticTelemetry,
  ): Promise<Map<string, SentenceClaimPlan>> {
    const plans = new Map<string, SentenceClaimPlan>();
    const hasEvidence = (referenceId: string): boolean => {
      const metadata = metadataRecords.get(referenceId);
      if (
        metadata === undefined ||
        metadata.status === "NOT_FOUND" ||
        metadata.status === "PROVIDER_ERROR" ||
        metadata.status === "UNRESOLVED" ||
        metadata.status === "AMBIGUOUS"
      ) {
        return false;
      }
      return (metadata.canonical?.abstract ?? "").trim() !== "";
    };
    const decomposeTargets: SentenceCalloutGroup[] = [];
    for (const group of sentenceGroups) {
      // 句内所有引用组都无 judgeable 证据 → 不拆解（下游全组确定性短路）
      if (!sentenceHasJudgeableGroup(group, references, hasEvidence)) {
        plans.set(group.sentenceKey, fallbackPlan(group));
        telemetry.fallbackSentencePlans += 1;
        continue;
      }
      if (!needsDecomposition(group.sentence, group.groups.length)) {
        plans.set(group.sentenceKey, fallbackPlan(group));
        telemetry.fallbackSentencePlans += 1;
        continue;
      }
      const planFingerprint = fingerprintJson({
        version: CLAIM_DECOMPOSITION_VERSION,
        sentence: group.sentence,
        groups: group.groups.map((callout) => callout.citationId),
      });
      const cached = await this.store.loadRecord<SentenceClaimPlan & { planFingerprint?: string }>(
        projectId,
        "decomposition",
        group.sentenceKey,
      );
      if (
        !options.force &&
        cached !== null &&
        cached.planFingerprint === planFingerprint &&
        cached.decompositionVersion === CLAIM_DECOMPOSITION_VERSION &&
        Array.isArray(cached.claims) &&
        cached.claims.length > 0 &&
        cached.claims.every((claim) => typeof claim.claimText === "string" && Array.isArray(claim.citationIds))
      ) {
        plans.set(group.sentenceKey, cached);
        telemetry.decompositionCacheHits += 1;
        continue;
      }
      decomposeTargets.push(group);
    }

    for (let index = 0; index < decomposeTargets.length; index += DECOMPOSITION_BATCH_SIZE) {
      if (telemetry.decompositionCalls >= MAX_DECOMPOSITION_CALLS) {
        // 预算耗尽：剩余句子走确定性兜底（整句单论断），核验仍然完整
        for (const group of decomposeTargets.slice(index)) {
          plans.set(group.sentenceKey, fallbackPlan(group));
          telemetry.fallbackSentencePlans += 1;
        }
        break;
      }
      if (options.signal?.aborted === true) {
        throw new BusinessError("WORKFLOW_CANCELLED", "论断拆解已被取消");
      }
      const batch = decomposeTargets.slice(index, index + DECOMPOSITION_BATCH_SIZE);
      const prompt = buildDecompositionPrompt(batch);
      telemetry.decompositionCalls += 1;
      let outputs = new Map<string, unknown>();
      try {
        const task = await this.runtime!.runAgent({
          ...(options.signal !== undefined ? { signal: options.signal } : {}),
          agentId: this.citationAgentId!,
          projectId,
          contextScope: `citation/decompose/${batch[0]!.sentenceKey.toLowerCase()}`,
          task: prompt,
          metadata: { role: "citation" },
        });
        if (task.status !== "completed") {
          throw new Error(task.error ?? "拆解任务未完成");
        }
        outputs = parseDecompositionBatch(task.output ?? "");
      } catch {
        // 拆解失败不致命：整批退确定性兜底
      }
      for (const group of batch) {
        const claims = parseDecompositionSentence(outputs.get(group.sentenceKey), group);
        if (claims === null) {
          plans.set(group.sentenceKey, fallbackPlan(group));
          telemetry.fallbackSentencePlans += 1;
          continue;
        }
        const plan = planFromModelOutput(group, claims);
        await this.store.saveRecord(projectId, "decomposition", group.sentenceKey, {
          ...plan,
          planFingerprint: fingerprintJson({
            version: CLAIM_DECOMPOSITION_VERSION,
            sentence: group.sentence,
            groups: group.groups.map((callout) => callout.citationId),
          }),
        });
        plans.set(group.sentenceKey, plan);
      }
    }
    return plans;
  }

  private async verifyClaim(
    projectId: string,
    claim: ClaimCitationRecord,
    references: ReferenceEntry[],
    metadataRecords: Map<string, CitationVerificationRecord>,
    telemetry: SemanticTelemetry,
    signal?: AbortSignal,
    modelBudget?: number,
    mode: CitationSemanticMode = "full",
  ): Promise<ClaimCitationRecord | null> {
    const base: ClaimCitationRecord = { ...claim, evidence: [] };

    // 组员分级（真实性 Gate）：不可判成员（NOT_FOUND/PROVIDER_ERROR/AMBIGUOUS/
    // 无记录）排除出证据——Layer 1 会单独报它们的问题，语义层不猜
    const excluded: string[] = [];
    const judgeable: string[] = [];
    for (const referenceId of claim.referenceIds) {
      const metadata = metadataRecords.get(referenceId);
      if (
        metadata === undefined ||
        metadata.status === "NOT_FOUND" ||
        metadata.status === "PROVIDER_ERROR" ||
        metadata.status === "UNRESOLVED" ||
        metadata.status === "AMBIGUOUS"
      ) {
        excluded.push(referenceId);
      } else {
        judgeable.push(referenceId);
      }
    }

    // 全组真实性未确立 → semantic SKIPPED（不允许验证不存在的文献）
    if (judgeable.length === 0) {
      const metadata = metadataRecords.get(claim.referenceIds[0]!);
      const reason =
        metadata === undefined
          ? "该引用组未经 metadata 核验，语义核验跳过"
          : metadata.status === "PROVIDER_ERROR" || metadata.status === "UNRESOLVED"
            ? "引用组内文献真实性核验暂未完成（provider 查询失败），语义核验跳过——完成核验后自动补跑"
            : `引用组内文献真实性未确立（${metadata.status}），语义核验跳过——不允许验证不存在的文献`;
      const skipped: ClaimCitationRecord = {
        ...base,
        verdict: "SKIPPED",
        reason,
        reasonCode: "REFERENCE_UNVERIFIED",
        status: "skipped",
        severity: deriveSeverityFor(claim, metadata),
        excludedReferenceIds: excluded,
        verifiedAt: this.now().toISOString(),
      };
      telemetry.skippedNoMetadata += 1;
      await this.store.saveRecord(projectId, "claims", claim.claimCitationId, skipped);
      return skipped;
    }

    const fabric = claim.referenceIds.some(
      (referenceId) => metadataRecords.get(referenceId)?.probableFabrication ?? false,
    );
    const evidence = buildGroupEvidence(judgeable, metadataRecords, this.now().toISOString());
    // 记录层面：未对核验做出证据贡献的组员（真实性未确立，或可判但无摘要/描述）
    const nonContributing = claim.referenceIds.filter(
      (referenceId) => (metadataRecords.get(referenceId)?.canonical?.abstract ?? "").trim() === "",
    );

    // 组内可判成员全部只有书目 metadata（无摘要/描述）：确定性短路，零模型调用。
    // full → INSUFFICIENT_EVIDENCE（自动核验无法判断，不是论文问题）；
    // contradiction_only → SKIPPED（矛盾检查没有素材，不构成「证据不足」问题）
    if (evidence.length === 0) {
      const softwareOnly = judgeable.every((id) => metadataRecords.get(id)?.kind === "software");
      const note = softwareOnly
        ? judgeable.length === 1
          ? "官方仓库可访问，但未获得可判证据（仓库无描述/文档）"
          : `引用组内 ${judgeable.length} 个官方仓库均可访问，但均未获得可判证据（无描述/文档）`
        : judgeable.length === 1
          ? "只获取到书目 metadata（学术库记录无摘要），没有正文/摘要等可判证据"
          : `引用组内 ${judgeable.length} 篇可判文献均只获取到书目 metadata（无摘要/描述），没有可判证据`;
      const record: ClaimCitationRecord =
        mode === "contradiction_only"
          ? {
              ...base,
              verdict: "SKIPPED",
              reason: `${note}，矛盾检查跳过`,
              reasonCode: "NO_EVIDENCE",
              evidence: [],
              status: "skipped",
              severity: deriveSeverityFor(claim, metadataRecords.get(claim.referenceIds[0]!)),
              ...(nonContributing.length > 0 ? { excludedReferenceIds: nonContributing } : {}),
              verifiedAt: this.now().toISOString(),
            }
          : {
              ...base,
              verdict: "INSUFFICIENT_EVIDENCE",
              reason: `${note}，自动核验无法判断（不代表引用存在问题）`,
              reasonCode: "NO_EVIDENCE",
              evidence: [],
              status: "verified",
              severity: deriveSeverityFor(claim, metadataRecords.get(claim.referenceIds[0]!)),
              ...(nonContributing.length > 0 ? { excludedReferenceIds: nonContributing } : {}),
              verifiedAt: this.now().toISOString(),
            };
      telemetry.skippedNoEvidence += 1;
      await this.store.saveRecord(projectId, "claims", claim.claimCitationId, record);
      return record;
    }

    const prompt = buildJudgePrompt(
      {
        claimText: claim.claimText,
        referenceIds: claim.referenceIds,
        references,
        metadataRecords,
        groupRawText: claim.groupRawText ?? `[${claim.referenceId}]`,
        evidence,
      },
      mode,
    );
    // 模型预算耗尽（上限只约束 LLM judge 调用；短路已免费完成）
    if (modelBudget !== undefined && telemetry.modelCalls >= modelBudget) {
      return null;
    }
    telemetry.approxPromptChars += prompt.length;
    telemetry.modelCalls += 1;
    const modelCallStartedAt = Date.now();
    try {
      const task = await this.runtime!.runAgent({
        ...(signal !== undefined ? { signal } : {}),
        agentId: this.citationAgentId!,
        projectId,
        contextScope: `citation/semantic/${claim.claimCitationId.toLowerCase()}`,
        task: prompt,
        metadata: { role: "citation" },
      });
      if (task.status !== "completed") {
        throw new Error(task.error ?? "judge 任务未完成");
      }
      const callMs = Date.now() - modelCallStartedAt;
      telemetry.modelCallMs.push(callMs);
      telemetry.totalModelMs += callMs;
      const judged = parseJudgeOutput(task.output ?? "", evidence, mode);
      // CONTRADICTED 必须能引用具体 evidence span：judge 引不出逐字 keyQuote
      // （伪造引文已被剥离）→ 矛盾结论不可采信，确定性降级 INSUFFICIENT_EVIDENCE
      let verdict = judged.verdict;
      let reason = judged.reason;
      let reasonCode: ClaimCitationRecord["reasonCode"] = undefined;
      if (verdict === "CONTRADICTED" && judged.keyQuote === undefined) {
        verdict = "INSUFFICIENT_EVIDENCE";
        reason = `${reason}（judge 未提供逐字反向引文，矛盾结论不可采信，降级为无法自动判断）`.slice(0, 1000);
        reasonCode = "UNQUOTED_CONTRADICTION";
      } else if (verdict === "INSUFFICIENT_EVIDENCE") {
        // judge 依据现有证据无法判定：证据范围限于 abstract / 仓库描述
        reasonCode = "ABSTRACT_ONLY";
      }
      const evidenceWithQuote =
        judged.keyQuote !== undefined
          ? [
              {
                ...evidence[0]!,
                text: `${evidence[0]!.text}\n[judge 关键引文] ${judged.keyQuote}`,
              },
            ]
          : evidence;
      const record: ClaimCitationRecord = {
        ...base,
        verdict,
        reason,
        ...(reasonCode !== undefined ? { reasonCode } : {}),
        evidence: evidenceWithQuote,
        status: "verified",
        severity: deriveClaimSeverity({
          probableFabrication: fabric,
          verdict,
          priority: claim.priority,
        }),
        ...(nonContributing.length > 0 ? { excludedReferenceIds: nonContributing } : {}),
        model: task.metadata?.["model"] as string | undefined,
        verifiedAt: this.now().toISOString(),
      };
      await this.store.saveRecord(projectId, "claims", claim.claimCitationId, record);
      return record;
    } catch (error) {
      telemetry.failed += 1;
      const record: ClaimCitationRecord = {
        ...base,
        status: "failed",
        verdict: "INSUFFICIENT_EVIDENCE",
        reasonCode: "PROVIDER_ERROR",
        severity: "info",
        error: error instanceof Error ? error.message : String(error),
      };
      await this.store.saveRecord(projectId, "claims", claim.claimCitationId, record);
      return record;
    }
  }

  /**
   * 全部 claim 记录（API 用）。只返回当前算法版本（semanticVersion 一致）的
   * 记录——旧版本的过期缓存不删除用户数据，但不再读出（不污染新结论）。
   */
  async listClaimRecords(projectId: string): Promise<ClaimCitationRecord[]> {
    await this.projects.getRequired(projectId);
    const ids = await this.store.listRecordIds(projectId, "claims");
    const records: ClaimCitationRecord[] = [];
    for (const id of ids) {
      const record = await this.store.loadRecord<ClaimCitationRecord>(projectId, "claims", id);
      if (record !== null && record.semanticVersion === SEMANTIC_VERIFICATION_VERSION) {
        records.push(record);
      }
    }
    return records;
  }

  /** Citation Integrity 总报告（metadata + semantic + Quality Gate 输入） */
  async integrityReport(projectId: string): Promise<{
    metadataByStatus: Record<CitationMetadataStatus, number>;
    semantic: SemanticSummary;
    probableFabrications: string[];
  }> {
    const metadataRecords = await this.listMetadataRecords(projectId);
    const claims = await this.listClaimRecords(projectId);
    const byStatus: Record<CitationMetadataStatus, number> = {
      VERIFIED: 0,
      METADATA_MISMATCH: 0,
      AMBIGUOUS: 0,
      NOT_FOUND: 0,
      PROVIDER_ERROR: 0,
      UNRESOLVED: 0,
    };
    for (const record of metadataRecords) {
      byStatus[record.status] += 1;
    }
    return {
      metadataByStatus: byStatus,
      semantic: summarizeSemantic(metadataRecords, claims),
      probableFabrications: metadataRecords
        .filter((record) => record.probableFabrication)
        .map((record) => record.referenceId),
    };
  }
}

function deriveSeverityFor(
  claim: ClaimCitationRecord,
  metadata: CitationVerificationRecord | undefined,
): ClaimCitationRecord["severity"] {
  return deriveClaimSeverity({
    probableFabrication: metadata?.probableFabrication ?? false,
    verdict: "SKIPPED",
    priority: claim.priority,
  });
}

/**
 * 拆解批量输出解析：{"sentences":[{"id":"S…","claims":[…]}]} → id → claims 映射。
 * 顶层非法 / 部分句子缺失都容忍（缺失句走 fallback），只有完全解析不动才全兜底。
 */
function parseDecompositionBatch(raw: string): Map<string, unknown> {
  const outputs = new Map<string, unknown>();
  const parsed = extractJsonObject(raw, "论断拆解结果") as unknown as { sentences?: unknown };
  if (!Array.isArray(parsed.sentences)) {
    return outputs;
  }
  for (const item of parsed.sentences) {
    if (typeof item !== "object" || item === null) {
      continue;
    }
    const id = (item as { id?: unknown }).id;
    if (typeof id === "string" && id !== "") {
      outputs.set(id, item);
    }
  }
  return outputs;
}
