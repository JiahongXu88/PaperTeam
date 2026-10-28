/**
 * CorpusUpgradeService（M15.8.5）：研究语料升级的产品级编排。
 *
 * 语义定位（Phase A root-cause 的修复面）：
 * - 普通 resume 的冻结不变量不动（CorpusSnapshotService 冻结合同原样保留）；
 * - 显式 / 受控升级 = 一个有界、可恢复、可观察的操作，串起既有服务：
 *     scoped refresh（补文件 + 失效可升级条目，confirmed 条目保留待裁决）
 *     → 增量 Matrix 重建（缺条目重建 / 既有 fulltext 条目 skip，带真实
 *       chunk anchors）→ Synthesis 全量重建（跨论文综合依赖全局视图，
 *       Matrix 指纹变化即重建——这是设计而非实现省事：局部综合无法保证
 *       引用完整性）→ Outline 重规划（指纹链 fail-closed；结构未变则
 *       确定性复用，0 模型）。
 * - 写作 / Review / Gate / Finalize 不在升级内改稿：升级只完成研究层；
 *   下一次 run 的 writing.sections 按大纲结构指纹变化如实重写，并重新
 *   走审稿 / 门禁（旧 READY 不能对齐新修订，FinalizeService 另有研究链
 *   新鲜度守卫）。
 *
 * 执行纪律：
 * - 同项目同时只允许一个升级 owner（进程内锁；跨进程由快照 / 矩阵的原子写
 *   + 幂等步骤兜底）；存在活跃 WorkflowRun（pending / running /
 *   awaiting_input，磁盘 checkpoint 判定，与 WorkflowOrchestrator.isActiveStatus
 *   同谓词）时拒绝启动——升级与 run 不得并发争抢同一模型账本（M15.8.2 实录）。
 * - 全部模型调用走既有 runtime / GlobalBudgetLedger（拒付即如实失败，
 *   不绕过）；每步幂等：中断后重跑 = 已完成部分 no-op。
 * - research/corpus-upgrades.jsonl 追加审计（revision / 指纹 / 逐源结果 /
 *   模型调用量），单一事实源仍是 snapshot / matrix / synthesis 产物本身。
 */

import { appendFile, mkdir } from "node:fs/promises";
import { join } from "node:path";

import { BusinessError, ProjectBusyError } from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { WorkflowRunStore } from "../workflow/runStore.js";
import type { ChunkStore } from "../retrieval/ChunkStore.js";
import type { SourceStore } from "../sources/SourceStore.js";
import type { ManuscriptService } from "../manuscript/ManuscriptService.js";
import { fingerprintJson } from "../util/hash.js";
import type { CorpusRefreshOutcome, CorpusSnapshotService } from "./CorpusSnapshotService.js";
import type { MatrixService } from "./MatrixService.js";
import type { SynthesisService } from "./SynthesisService.js";
import type { SurveyOutlineService } from "./OutlineService.js";

export interface CorpusUpgradeAvailabilitySourceRow {
  sourceId: string;
  status: string;
  /** 磁盘事实：全文文件在库 */
  hasFile: boolean;
  /** 检索事实：chunk 存在且含非平凡文本（≥40 字符）——下载成功 ≠ 可引用 */
  parsedUsable: boolean;
  nonTrivialChunks: number;
  chunkCount: number;
  /** 快照研究基线事实 */
  basisDepth: "fulltext" | "abstract_only" | null;
  /** 升级候选：有文件 + chunks 可用 + 基线非 fulltext（且未被 HITL 锁定） */
  upgradeEligible: boolean;
  /** 无合法 OA 全文（metadata_only）——走 Author Decision / 删除路径 */
  requiresAuthorDecision: boolean;
  /** matrix 条目被人工确认（HITL）——自动升级保留待裁决 */
  confirmedEntry: boolean;
  reason: string;
}

export interface CorpusUpgradeAvailability {
  snapshot: { revision: number; fingerprint: string; counts: { total: number; hasFulltext: number; fulltextBasis: number; abstractBasis: number } } | null;
  summary: {
    totalSources: number;
    /** X/25：全文文件在库 */
    downloadedFile: number;
    /** Y/25：parsed/chunks 可用于全文研究 */
    parsedUsable: number;
    /** Z/25：matrix 已按 fulltext 深度消费 */
    fulltextBasis: number;
    abstractBasis: number;
    upgradeEligible: number;
    requiresAuthorDecision: number;
    confirmedLocked: number;
  };
  /** 下游新鲜度（matrix 存在时） */
  downstream: {
    synthesisFresh: boolean | null;
    outlineReusable: boolean | null;
  } | null;
  sources: CorpusUpgradeAvailabilitySourceRow[];
}

export interface CorpusUpgradeOutcome {
  projectId: string;
  /** 升级目标集（null = 全部可升级源）；实际执行的失效/重建范围 = 目标集 ∩ 资格 */
  targetSourceIds: string[] | null;
  /** 显式点名但不具备升级资格的源（薄文本 / 无文件 / HITL 已确认 / 已 fulltext）与原因 */
  skippedIneligible: Array<{ sourceId: string; reason: string }>;
  steps: {
    refresh: CorpusRefreshOutcome;
    matrix: {
      built: string[];
      skippedExisting: number;
      failed: Array<{ sourceId: string; error: string }>;
      fingerprintBefore: string | null;
      fingerprintAfter: string;
    };
    synthesis:
      | {
          skipped: true;
          reason: string;
        }
      | {
          reused: boolean;
          items: number;
          batches: number;
          matrixFingerprint: string;
        };
    outline:
      | {
          skipped: true;
          reason: string;
        }
      | {
          reused: boolean;
          sections: number;
          planningAttempts: number | null;
        };
  };
  /** 可理解进度（B2.7）：升级后基线口径 */
  after: {
    fulltextBasis: number;
    abstractBasis: number;
    stillEligible: string[];
    requiresAuthorDecision: string[];
    failedRebuilds: string[];
    skippedConfirmed: string[];
    stillMissingFiles: string[];
  };
  /** 升级期间模型调用净增量（账本可注入时；null = 未装配） */
  modelCallsUsed: number | null;
  corpusRevision: number;
  corpusFingerprint: string;
}

export interface CorpusUpgradeDeps {
  projects: ProjectStore;
  sources: SourceStore;
  chunkStore: ChunkStore;
  /** 检索服务：availability 测量前确保 chunk 懒生成（零模型；刚挂载未检索的文件如实可测） */
  retrieval: { search(projectId: string, query: string, options?: { topK?: number }): Promise<unknown> };
  runStore: WorkflowRunStore;
  corpus: CorpusSnapshotService;
  survey: MatrixService;
  synthesis: SynthesisService;
  surveyOutline: SurveyOutlineService;
  manuscript: ManuscriptService;
  /** 全局模型预算账本（可选：用于调用量报告；拒付语义在 runtime 层，不在这里） */
  globalLedger?: { snapshot(): { calls: number } };
  now?: () => Date;
  log?: (message: string) => void;
}

/** 与 WorkflowOrchestrator.isActiveStatus 同谓词（本地实现避免 survey→workflow 环依赖） */
function isActiveRunStatus(status: string): boolean {
  return status === "pending" || status === "running" || status === "awaiting_input";
}

/** 非平凡 chunk 门槛：扫描 / 薄文本降级件通常只有零星短块 */
const NON_TRIVIAL_CHUNK_CHARS = 40;
const NON_TRIVIAL_CHUNK_MIN_COUNT = 5;

export class CorpusUpgradeService {
  private readonly deps: CorpusUpgradeDeps;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private readonly upgrading = new Set<string>();

  constructor(deps: CorpusUpgradeDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => {});
  }

  /** 是否有升级正在进行（供 run 创建侧做互斥检查） */
  isUpgrading(projectId: string): boolean {
    return this.upgrading.has(projectId);
  }

  private async requireNoActiveRun(projectId: string): Promise<void> {
    for (const runId of await this.deps.runStore.listRunIds(projectId)) {
      const state = await this.deps.runStore.loadCheckpoint(projectId, runId);
      if (state !== null && isActiveRunStatus(state.status)) {
        throw new ProjectBusyError(
          `项目 ${projectId} 存在进行中的 WorkflowRun（${runId} / ${state.status}）：语料升级与 run 不得并发争抢模型账本，请先完成或取消该 run`,
        );
      }
    }
  }

  /**
   * 零模型可用性报告（GET 语义）：升级候选 / 下游新鲜度 / 人工裁决项。
   * 口径与 Phase A ledger 一致：downloadedFile ≠ parsedUsable ≠ fulltextBasis。
   */
  async availability(projectId: string): Promise<CorpusUpgradeAvailability> {
    await this.deps.projects.getRequired(projectId);
    const snapshot = await this.deps.corpus.get(projectId);
    const matrix = await this.deps.survey.getMatrix(projectId);
    const synthesis = await this.deps.synthesis.getSynthesis(projectId).catch(() => null);
    const sources = await this.deps.sources.list(projectId);
    // chunk 懒生成：确保刚挂载未检索的文件如实可测（零模型，确定性本地工作）
    await this.deps.retrieval
      .search(projectId, sources.find((item) => item.metadata.title)?.metadata.title?.trim() ?? "corpus", { topK: 1 })
      .catch(() => {});
    const rowBySource = new Map((snapshot?.sources ?? []).map((row) => [row.sourceId, row]));
    const entryBySource = new Map((matrix?.entries ?? []).map((entry) => [entry.sourceId, entry]));

    const rows: CorpusUpgradeAvailabilitySourceRow[] = [];
    for (const source of sources) {
      if (source.sourceRole === "reference" || source.status === "rejected") {
        continue;
      }
      const hasFile = source.fileName !== undefined && source.fileName !== "" && source.status !== "metadata_only";
      let chunks: Awaited<ReturnType<ChunkStore["readChunks"]>> = null;
      try {
        chunks = await this.deps.chunkStore.readChunks(projectId, source.sourceId);
      } catch {
        chunks = null;
      }
      const chunkList = chunks ?? [];
      const nonTrivial = chunkList.filter((chunk) => (chunk.text ?? "").trim().length >= NON_TRIVIAL_CHUNK_CHARS).length;
      const parsedUsable = hasFile && nonTrivial >= NON_TRIVIAL_CHUNK_MIN_COUNT;
      const basisDepth = rowBySource.get(source.sourceId)?.basisDepth ?? null;
      const confirmedEntry = entryBySource.get(source.sourceId)?.status === "confirmed";
      const requiresAuthorDecision = source.status === "metadata_only";
      const upgradeEligible = parsedUsable && basisDepth !== "fulltext" && !confirmedEntry;
      let reason: string;
      if (requiresAuthorDecision) {
        reason = "无合法开放获取全文（metadata_only）——保留限制，走 Author Decision / 删除路径，不无限重试";
      } else if (basisDepth === "fulltext") {
        reason = "已按 fulltext 基线消费";
      } else if (!hasFile) {
        reason = "磁盘无全文文件（refresh 可再尝试）";
      } else if (!parsedUsable) {
        reason = `文件在库但可检索文本不足（non-trivial chunks ${nonTrivial}/${chunkList.length}）——扫描 / 薄文本，按实际降级，不强行判 fulltext`;
      } else if (confirmedEntry) {
        reason = "matrix 条目已被人工确认（HITL）——自动升级保留，待人工裁决";
      } else {
        reason = "升级候选：文件 + chunks 可用而基线仍摘要级";
      }
      rows.push({
        sourceId: source.sourceId,
        status: source.status,
        hasFile,
        parsedUsable,
        nonTrivialChunks: nonTrivial,
        chunkCount: chunkList.length,
        basisDepth,
        upgradeEligible,
        requiresAuthorDecision,
        confirmedEntry,
        reason,
      });
    }

    let downstream: CorpusUpgradeAvailability["downstream"] = null;
    if (matrix !== null) {
      const matrixFingerprint = fingerprintJson(matrix);
      const outline = await this.deps.manuscript.loadOutline(projectId).catch(() => null);
      const hasRefs = (outline?.sections ?? []).some(
        (section) => (section.synthesisRefs ?? []).length > 0 || (section.literatureRefs ?? []).length > 0,
      );
      const reusable = hasRefs
        ? await this.deps.surveyOutline.reuseFreshOutline(projectId).then((o) => o !== null).catch(() => false)
        : null;
      downstream = {
        synthesisFresh: synthesis !== null ? synthesis.matrixFingerprint === matrixFingerprint : null,
        outlineReusable: reusable,
      };
    }

    return {
      snapshot:
        snapshot === null
          ? null
          : { revision: snapshot.revision, fingerprint: snapshot.fingerprint, counts: snapshot.counts },
      summary: {
        totalSources: rows.length,
        downloadedFile: rows.filter((row) => row.hasFile).length,
        parsedUsable: rows.filter((row) => row.parsedUsable).length,
        fulltextBasis: rows.filter((row) => row.basisDepth === "fulltext").length,
        abstractBasis: rows.filter((row) => row.basisDepth === "abstract_only").length,
        upgradeEligible: rows.filter((row) => row.upgradeEligible).length,
        requiresAuthorDecision: rows.filter((row) => row.requiresAuthorDecision).length,
        confirmedLocked: rows.filter((row) => row.confirmedEntry).length,
      },
      downstream,
      sources: rows.sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    };
  }

  /**
   * 执行研究语料升级（显式 / 受控；模型调用走正规账本）。
   * options.sourceIds：有界升级目标集（须为升级候选或至少在冻结语料内）；
   * 缺省 = 全部可升级源（无界升级如实按 18/18 这类全量执行）。
   */
  async upgrade(
    projectId: string,
    options: { sourceIds?: string[]; signal?: AbortSignal } = {},
  ): Promise<CorpusUpgradeOutcome> {
    await this.deps.projects.getRequired(projectId);
    if (this.upgrading.has(projectId)) {
      throw new ProjectBusyError(`项目 ${projectId} 已有一个语料升级在进行中（同项目同时只能一个升级 owner）`);
    }
    this.upgrading.add(projectId);
    try {
      await this.requireNoActiveRun(projectId);
      const snapshot = await this.deps.corpus.get(projectId);
      if (snapshot === null) {
        throw new BusinessError(
          "INVALID_REQUEST",
          "研究语料尚未冻结（无 corpus-snapshot.json）；先完成一次 survey.fulltext 形成基线再升级",
        );
      }
      // 目标集校验：在冻结语料内（未知源直接点名拒绝，不静默忽略）
      let targetSourceIds: string[] | null = null;
      if (options.sourceIds !== undefined) {
        if (options.sourceIds.length === 0) {
          throw new BusinessError("INVALID_REQUEST", "sourceIds 必须是非空数组（不指定则升级全部可升级源）");
        }
        const known = new Set(snapshot.sources.map((row) => row.sourceId));
        const unknown = options.sourceIds.filter((id) => !known.has(id));
        if (unknown.length > 0) {
          throw new BusinessError("INVALID_REQUEST", `sourceIds 不在冻结语料内：${unknown.join("、")}`);
        }
        targetSourceIds = [...new Set(options.sourceIds)];
      }

      // ---- 目标资格解析（升级纪律：只对「文件在库 + chunks 可用 + 基线非
      // fulltext + 未被 HITL 锁定」的源执行重建；薄文本 / 无文件 / 已确认 /
      // 已 fulltext 的显式点名目标如实跳过并给原因，不静默强升）----
      const availabilityBefore = await this.availability(projectId);
      const eligibleIds = availabilityBefore.sources.filter((row) => row.upgradeEligible).map((row) => row.sourceId);
      const reasonBySource = new Map(availabilityBefore.sources.map((row) => [row.sourceId, row.reason]));
      let effectiveTargets: string[];
      const skippedIneligible: Array<{ sourceId: string; reason: string }> = [];
      if (targetSourceIds === null) {
        effectiveTargets = eligibleIds;
      } else {
        const eligible = new Set(eligibleIds);
        effectiveTargets = [];
        for (const sourceId of targetSourceIds) {
          if (eligible.has(sourceId)) {
            effectiveTargets.push(sourceId);
          } else {
            skippedIneligible.push({ sourceId, reason: reasonBySource.get(sourceId) ?? "不满足升级资格" });
          }
        }
      }
      if (effectiveTargets.length === 0) {
        await this.appendJournal(projectId, {
          at: this.now().toISOString(),
          event: "upgrade.noop",
          targetSourceIds,
          eligibleIds,
          skippedIneligible,
        });
        const afterNoop = await this.availability(projectId);
        return {
          projectId,
          targetSourceIds,
          skippedIneligible,
          steps: {
            refresh: {
              attempted: 0,
              resolved: 0,
              stillMissing: 0,
              invalidatedMatrixEntries: 0,
              skippedConfirmedEntries: [],
              revision: snapshot.revision,
              fingerprint: snapshot.fingerprint,
              fingerprintChanged: false,
            },
            matrix: {
              built: [],
              skippedExisting: 0,
              failed: [],
              fingerprintBefore: null,
              fingerprintAfter: "",
            },
            synthesis: { skipped: true, reason: "无合格升级目标（资格过滤后为空）——研究层不动" },
            outline: { skipped: true, reason: "无合格升级目标（资格过滤后为空）——研究层不动" },
          },
          after: {
            fulltextBasis: afterNoop.summary.fulltextBasis,
            abstractBasis: afterNoop.summary.abstractBasis,
            stillEligible: afterNoop.sources.filter((row) => row.upgradeEligible).map((row) => row.sourceId),
            requiresAuthorDecision: afterNoop.sources.filter((row) => row.requiresAuthorDecision).map((row) => row.sourceId),
            failedRebuilds: [],
            skippedConfirmed: [],
            stillMissingFiles: afterNoop.sources.filter((row) => !row.hasFile).map((row) => row.sourceId),
          },
          modelCallsUsed: 0,
          corpusRevision: snapshot.revision,
          corpusFingerprint: snapshot.fingerprint,
        };
      }

      const callsBefore = this.deps.globalLedger?.snapshot().calls ?? null;
      await this.appendJournal(projectId, {
        at: this.now().toISOString(),
        event: "upgrade.started",
        targetSourceIds,
        effectiveTargets,
        skippedIneligible,
        corpusRevision: snapshot.revision,
        corpusFingerprint: snapshot.fingerprint,
      });

      // ---- Step 1: scoped refresh（资格范围内补文件 + scoped 失效；confirmed 保留）----
      const refresh = await this.deps.corpus.refresh(projectId, {
        sourceIds: effectiveTargets,
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      await this.appendJournal(projectId, {
        at: this.now().toISOString(),
        event: "upgrade.refresh.done",
        refresh: {
          attempted: refresh.attempted,
          resolved: refresh.resolved,
          stillMissing: refresh.stillMissing,
          invalidatedMatrixEntries: refresh.invalidatedMatrixEntries,
          skippedConfirmedEntries: refresh.skippedConfirmedEntries,
          revision: refresh.revision,
          fingerprint: refresh.fingerprint,
          fingerprintChanged: refresh.fingerprintChanged,
        },
      });

      // ---- Step 2: 增量 Matrix 重建（失效条目缺位 → 重建；其余 skip-existing）----
      // 范围语义：严格按资格目标集重建（预算边界由调用方划定——历史中断遗留
      // 的其它缺位条目不悄悄消耗预算，保留在 stillEligible 如实呈现）。
      const matrixBefore = await this.deps.survey.getMatrix(projectId);
      const fingerprintBefore = matrixBefore === null ? null : fingerprintJson(matrixBefore);
      const build = await this.deps.survey.buildMatrix(projectId, { sourceIds: effectiveTargets });
      const matrixAfter = build.matrix;
      // 与 survey.matrix stage 同步快照基线深度（重建条目 → basisDepth 升级）
      await this.deps.corpus.syncBasisDepth(projectId, matrixAfter).catch(() => {});
      await this.appendJournal(projectId, {
        at: this.now().toISOString(),
        event: "upgrade.matrix.done",
        matrix: {
          built: build.results.filter((r) => r.outcome === "built").map((r) => r.sourceId),
          skippedExisting: build.summary.skippedExisting,
          failed: build.results.filter((r) => r.outcome === "failed").map((r) => ({ sourceId: r.sourceId, error: r.error ?? "" })),
          fingerprintAfter: fingerprintJson(matrixAfter),
        },
      });

      // ---- Step 3/4 熔断：目标重建全部失败 → 研究层下游不动（不把缺源状态
      // 烘进 synthesis；失败源保留在 stillEligible，修复后重跑升级幂等补齐）----
      const builtIds = build.results.filter((r) => r.outcome === "built").map((r) => r.sourceId);
      const totalFailure = builtIds.length === 0 && build.summary.failed > 0;
      let synthesisStep: CorpusUpgradeOutcome["steps"]["synthesis"];
      let outlineStep: CorpusUpgradeOutcome["steps"]["outline"];
      if (totalFailure) {
        synthesisStep = {
          skipped: true,
          reason: `matrix 重建全部失败（${build.summary.failed} 篇）——synthesis 不消费缺源矩阵；修复后重跑升级`,
        };
        outlineStep = { skipped: true, reason: "matrix 重建全部失败，下游不传播" };
        await this.appendJournal(projectId, {
          at: this.now().toISOString(),
          event: "upgrade.halted",
          reason: "matrix_rebuild_total_failure",
          failed: build.results.filter((r) => r.outcome === "failed").map((r) => r.sourceId),
        });
      } else {
        // ---- Step 3: Synthesis 全量重建（跨论文综合依赖全局视图；指纹未变则 0 模型复用）----
        const synthesisBuild = await this.deps.synthesis.buildSynthesis(projectId, {});
        synthesisStep = {
          reused: synthesisBuild.summary.reused,
          items: synthesisBuild.synthesis.items.length,
          batches: synthesisBuild.summary.batches,
          matrixFingerprint: synthesisBuild.synthesis.matrixFingerprint,
        };
        await this.appendJournal(projectId, {
          at: this.now().toISOString(),
          event: "upgrade.synthesis.done",
          synthesis: synthesisStep,
        });

        // ---- Step 4: Outline（新鲜复用优先；结构 / refs 变化 → 重规划 1-2 次）----
        let outlineReused = true;
        let outlineSections = 0;
        let planningAttempts: number | null = null;
        const fresh = await this.deps.surveyOutline.reuseFreshOutline(projectId).catch(() => null);
        if (fresh !== null) {
          outlineSections = fresh.sections.length;
        } else {
          const built = await this.deps.surveyOutline.buildSurveyOutline(projectId, {});
          outlineReused = false;
          outlineSections = built.outline.sections.length;
          planningAttempts = built.summary.planningAttempts;
        }
        outlineStep = { reused: outlineReused, sections: outlineSections, planningAttempts };
        await this.appendJournal(projectId, {
          at: this.now().toISOString(),
          event: "upgrade.outline.done",
          outline: outlineStep,
        });
      }

      // ---- 收尾：可理解进度 + 账本 ----
      const after = await this.availability(projectId);
      const callsAfter = this.deps.globalLedger?.snapshot().calls ?? null;
      const outcome: CorpusUpgradeOutcome = {
        projectId,
        targetSourceIds,
        skippedIneligible,
        steps: {
          refresh,
          matrix: {
            built: builtIds,
            skippedExisting: build.summary.skippedExisting,
            failed: build.results
              .filter((r) => r.outcome === "failed")
              .map((r) => ({ sourceId: r.sourceId, error: r.error ?? "" })),
            fingerprintBefore,
            fingerprintAfter: fingerprintJson(matrixAfter),
          },
          synthesis: synthesisStep,
          outline: outlineStep,
        },
        after: {
          fulltextBasis: after.summary.fulltextBasis,
          abstractBasis: after.summary.abstractBasis,
          stillEligible: after.sources.filter((row) => row.upgradeEligible).map((row) => row.sourceId),
          requiresAuthorDecision: after.sources.filter((row) => row.requiresAuthorDecision).map((row) => row.sourceId),
          failedRebuilds: build.results.filter((r) => r.outcome === "failed").map((r) => r.sourceId),
          skippedConfirmed: refresh.skippedConfirmedEntries,
          stillMissingFiles: after.sources.filter((row) => !row.hasFile).map((row) => row.sourceId),
        },
        modelCallsUsed: callsBefore !== null && callsAfter !== null ? callsAfter - callsBefore : null,
        corpusRevision: refresh.revision,
        corpusFingerprint: refresh.fingerprint,
      };
      await this.appendJournal(projectId, {
        at: this.now().toISOString(),
        event: "upgrade.completed",
        after: outcome.after,
        modelCallsUsed: outcome.modelCallsUsed,
      });
      const synthesisDesc =
        "reused" in synthesisStep ? (synthesisStep.reused ? "reused" : `rebuilt(${synthesisStep.batches} batches)`) : "skipped";
      const outlineDesc = "reused" in outlineStep ? (outlineStep.reused ? "reused" : "replanned") : "skipped";
      this.log(
        `[corpus-upgrade] projectId=${projectId} 完成：basis ${after.summary.fulltextBasis}/${after.summary.totalSources} fulltext（built ${builtIds.length} / failed ${build.summary.failed}）；synthesis ${synthesisDesc}；outline ${outlineDesc}；模型调用 ${outcome.modelCallsUsed ?? "?"}`,
      );
      return outcome;
    } finally {
      this.upgrading.delete(projectId);
    }
  }

  private async appendJournal(projectId: string, entry: Record<string, unknown>): Promise<void> {
    try {
      const dir = this.deps.projects.researchDir(projectId);
      await mkdir(dir, { recursive: true });
      await appendFile(join(dir, "corpus-upgrades.jsonl"), JSON.stringify(entry) + "\n", "utf8");
    } catch (error) {
      this.log(`[corpus-upgrade] projectId=${projectId} 审计日志写入失败（不阻断升级）：${error instanceof Error ? error.message : String(error)}`);
    }
  }
}
