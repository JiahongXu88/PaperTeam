/**
 * VisionAnalysisService（M10.2 编排）：已登记 figure 块 → Vision Analyzer →
 * FigureAnalysis 落盘 → 检索重建 → 候选事实确认通道。
 *
 * 职责边界：
 * - 只处理 ParsedFigureBlock（PDF 抽图 / 上传图片 / Notebook 图片输出同一条
 *   链——零套重复逻辑）；表格 / OCR / 扫描件增强不做（Docling TableFormer
 *   与 CSV/XLSX 通道已覆盖）；
 * - capability 前置判定（§7）：模型不可用 → 全部 figure 落 skipped（原因
 *   码 + 说明），绝不调用、绝不伪装成 completed；
 * - freshness（§18）：imageHash + modelSpec + outputSchemaVersion 三键全同
 *   的 completed 分析直接复用（不重复调用）；图片 / 模型 / schema 任一变化
 *   即失效重建；换模型不污染 ParsedDocument（分析独立落盘）；
 * - 异步（§17）：复用 M10.1 ingestInBackground 的串行后台链模式（并发 1，
 *   失败只记日志）；逐图增量落盘，轮询可见进度；
 * - Evidence 纪律（§10/§11）：candidateFact → EvidenceStore 必须用户显式
 *   确认（user_confirmed + unverified）；Vision 输出永不直接成为
 *   grounded_verified Evidence——无 chunk 锚点，isFormalEvidence 天然不成立。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { BusinessError, EvidenceValidationError, EvidenceValueMismatchError, NotFoundError } from "../errors.js";
import { claimMentionsValue, summarizeDocument, type ParsedDocumentSummary } from "../ingestion/IngestionService.js";
import type { IngestionService } from "../ingestion/IngestionService.js";
import type { ParsedDocumentStore } from "../ingestion/ParsedDocumentStore.js";
import type { ParsedFigureBlock } from "../ingestion/types.js";
import { VISION_LIMITS, VISION_OUTPUT_SCHEMA_VERSION } from "./types.js";
import type {
  FigureAnalysis,
  FigureCandidateFact,
  VisionModelCandidates,
  VisionModelRuntime,
  VisionModelSelection,
} from "./types.js";
import { resolveVisionModel } from "./capabilities.js";
import { FigureAnalysisStore } from "./FigureAnalysisStore.js";
import { VisionAnalyzer, analysisIdOf, buildSurroundingContext, hashOf } from "./VisionAnalyzer.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { SourceItem, SourceStore } from "../sources/SourceStore.js";
import type { EvidenceStore } from "../evidence/EvidenceStore.js";

export interface VisionAnalysisServiceOptions {
  projects: ProjectStore;
  sources: SourceStore;
  documents: ParsedDocumentStore;
  analyses: FigureAnalysisStore;
  ingestion: IngestionService;
  evidence?: EvidenceStore;
  /**
   * Vision 模型接入（Pi ModelRuntime 结构满足；测试注入 fake）。
   * 缺省 = 无模型接入：analyze 全部 skipped（capability unavailable）。
   */
  modelRuntime?: VisionModelRuntime;
  /** 模型偏好候选（visionModel 设置 + 生效默认模型；每次运行时读取） */
  modelCandidates?: () => VisionModelCandidates | Promise<VisionModelCandidates>;
  /** 单次调用超时覆盖（测试用） */
  requestTimeoutMs?: number;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface AnalyzeOptions {
  /** 忽略 freshness 缓存强制重跑（换模型 / schema 排查用） */
  force?: boolean;
}

/** 单图执行动作（analyze 返回；供「是否真的调用了模型」断言） */
export type FigureRunAction = "analyzed" | "reused" | "skipped" | "failed";

export interface VisionFigureView {
  figureBlockId: string;
  analysisId?: string;
  status: "pending" | "completed" | "failed" | "skipped";
  assetName?: string;
  caption?: string;
  page?: number;
  cellIndex?: number;
  outputIndex?: number;
  figureType?: FigureAnalysis["figureType"];
  /** 截断预览（完整产物走落盘文件 / 后续详情入口） */
  description?: string;
  candidateFactCount?: number;
  /** includeFacts 时附带候选事实全量（确认通道入口用） */
  facts?: FigureCandidateFact[];
  model?: string;
  confidence?: FigureAnalysis["confidence"];
  error?: FigureAnalysis["error"];
  skipReason?: string;
  skipNote?: string;
  analyzedAt?: string;
}

export interface VisionModelView {
  available: boolean;
  modelSpec?: string;
  source?: "vision_setting" | "default_model";
  reason?: string;
  detail: string;
}

export interface VisionStatusView {
  sourceId: string;
  fileName: string;
  document: ParsedDocumentSummary | { status: "unparsed" };
  model: VisionModelView;
  figures: VisionFigureView[];
  counts: Record<"total" | "pending" | "completed" | "failed" | "skipped", number>;
  updatedAt?: string;
}

export interface AnalyzeResult {
  status: VisionStatusView;
  /** 本次运行各图动作（analyzed = 真实调用；reused = freshness 命中） */
  actions: Array<{ figureBlockId: string; action: FigureRunAction }>;
}

export class VisionAnalysisService {
  private readonly projects: ProjectStore;
  private readonly sources: SourceStore;
  private readonly documents: ParsedDocumentStore;
  private readonly analyses: FigureAnalysisStore;
  private readonly ingestion: IngestionService;
  private readonly evidence?: EvidenceStore;
  private readonly modelRuntime?: VisionModelRuntime;
  private readonly modelCandidates?: () => VisionModelCandidates | Promise<VisionModelCandidates>;
  private readonly requestTimeoutMs?: number;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  /** 后台串行链（同 M10.1 ingestInBackground：并发 1，失败不阻塞后继） */
  private backgroundChain: Promise<void> = Promise.resolve();
  /** 分析产物落盘后的钩子（serviceStack 接检索重建；缺省 no-op） */
  private analyzedHook?: (projectId: string, sourceId: string) => Promise<void>;

  constructor(options: VisionAnalysisServiceOptions) {
    this.projects = options.projects;
    this.sources = options.sources;
    this.documents = options.documents;
    this.analyses = options.analyses;
    this.ingestion = options.ingestion;
    this.evidence = options.evidence;
    this.modelRuntime = options.modelRuntime;
    this.modelCandidates = options.modelCandidates;
    this.requestTimeoutMs = options.requestTimeoutMs;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  attachAnalyzedHook(hook: (projectId: string, sourceId: string) => Promise<void>): void {
    this.analyzedHook = hook;
  }

  // ---- 分析 ----

  /** 后台触发（fire-and-forget；串行执行，失败只记日志） */
  analyzeInBackground(projectId: string, sourceId: string, options: AnalyzeOptions = {}): void {
    this.backgroundChain = this.backgroundChain
      .then(async () => {
        await this.analyze(projectId, sourceId, options);
      })
      .catch((error) => {
        this.log(
          `[vision] ${projectId}/${sourceId} 后台分析异常：${error instanceof Error ? error.message : String(error)}`,
        );
      });
  }

  /** 同步执行整个 source 的 figure 分析（逐图增量落盘；失败图不阻塞其余图） */
  async analyze(projectId: string, sourceId: string, options: AnalyzeOptions = {}): Promise<AnalyzeResult> {
    await this.projects.getRequired(projectId);
    const item = await this.sources.getRequired(projectId, sourceId);
    const document = await this.ingestion.getDocument(projectId, sourceId);
    if (document === null) {
      throw new BusinessError(
        "INVALID_REQUEST",
        `文献 ${sourceId} 尚无有效的结构化解析产物（Vision 分析需要；请先 POST /sources/${sourceId}/ingest）`,
      );
    }

    const selection = await this.resolveModel();
    const analyzer =
      this.modelRuntime !== undefined
        ? new VisionAnalyzer({
            modelRuntime: this.modelRuntime,
            ...(this.requestTimeoutMs !== undefined ? { requestTimeoutMs: this.requestTimeoutMs } : {}),
            now: this.now,
            log: this.log,
          })
        : undefined;

    const existing = await this.analyses.load(projectId, sourceId);
    const figureBlocks = document.blocks.filter(
      (block): block is ParsedFigureBlock => block.type === "figure",
    );
    const keptBlockIds = new Set(figureBlocks.map((block) => block.blockId));
    const actions: AnalyzeResult["actions"] = [];

    // 清掉文档中已不存在的块的分析（source 重解析后块集合变化的正常收敛）
    if (existing !== null && existing.analyses.some((entry) => !keptBlockIds.has(entry.figureBlockId))) {
      await this.analyses.save(projectId, {
        schemaVersion: 1,
        sourceId,
        analyses: existing.analyses.filter((entry) => keptBlockIds.has(entry.figureBlockId)),
        updatedAt: this.now().toISOString(),
      });
    }

    const limited = figureBlocks.slice(0, VISION_LIMITS.maxFiguresPerSource);
    for (const block of limited) {
      const prior = (await this.analyses.load(projectId, sourceId))?.analyses.find(
        (entry) => entry.figureBlockId === block.blockId,
      );
      const assetBytes = await this.readAssetBytes(projectId, sourceId, block);
      const imageHash = assetBytes !== null ? hashOf(assetBytes) : null;

      // freshness（§18）：三键全同的 completed 直接复用
      if (
        !options.force &&
        prior !== undefined &&
        prior.status === "completed" &&
        isFresh(prior, imageHash, selection)
      ) {
        actions.push({ figureBlockId: block.blockId, action: "reused" });
        continue;
      }

      // capability unavailable（§7）：全部 skipped，原因明确，不调用
      const unavailableDetail =
        selection.available === false
          ? selection.detail
          : "Vision 模型接入未装配（无 ModelRuntime / 模型偏好）";
      if (analyzer === undefined || selection.available === false) {
        await this.analyses.upsert(
          projectId,
          sourceId,
          skippedAnalysis(item, document.contentHash ?? "", block, imageHash, "model_unavailable", unavailableDetail, this.now),
          this.now().toISOString(),
        );
        actions.push({ figureBlockId: block.blockId, action: "skipped" });
        continue;
      }

      const index = document.blocks.indexOf(block);
      const analysis = await analyzer.analyze({
        sourceId,
        figureBlock: block,
        imageBytes: assetBytes,
        ...(block.caption !== undefined ? { caption: block.caption } : {}),
        surroundingContext: buildSurroundingContext(document.blocks, index),
        provenanceSummary: provenanceSummaryOf(block),
        ...(document.contentHash !== "" ? { sourceContentHash: document.contentHash } : {}),
        model: selection,
      });
      // 分析产物统一携带 sourceContentHash（检索新鲜度门）+ 当前 schema 版本
      const stamped: FigureAnalysis = {
        ...analysis,
        sourceContentHash: document.contentHash,
      };
      await this.analyses.upsert(projectId, sourceId, stamped, this.now().toISOString());
      actions.push({ figureBlockId: block.blockId, action: stamped.status === "completed" ? "analyzed" : "failed" });
      this.log(
        `[vision] ${projectId}/${sourceId} ${block.blockId} 分析${stamped.status === "completed" ? "完成" : "失败"}（${stamped.status === "completed" ? `${stamped.candidateFacts.length} 条候选事实` : stamped.error?.code ?? ""}）`,
      );
    }

    // 全部终态后：检索层按新分析重建（图片条目因此获得唯一可检索通道）
    const hook = this.analyzedHook;
    if (hook !== undefined && actions.length > 0) {
      try {
        await hook(projectId, sourceId);
      } catch (error) {
        this.log(
          `[vision] ${projectId}/${sourceId} 分析后检索重建失败（下次 rebuild 自愈）：${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }

    return { status: await this.status(projectId, sourceId), actions };
  }

  // ---- 状态 ----

  /** 分析状态 + 各 figure 摘要（GET /sources/:id/vision；includeFacts 附带候选事实） */
  async status(projectId: string, sourceId: string, options: { includeFacts?: boolean } = {}): Promise<VisionStatusView> {
    await this.projects.getRequired(projectId);
    const item = await this.sources.getRequired(projectId, sourceId);
    const document = await this.ingestion.getDocument(projectId, sourceId);
    const stored = await this.analyses.load(projectId, sourceId);
    const selection = await this.resolveModel();

    const byBlock = new Map((stored?.analyses ?? []).map((entry) => [entry.figureBlockId, entry]));
    const figureBlocks =
      document?.blocks.filter((block): block is ParsedFigureBlock => block.type === "figure") ?? [];

    const figures: VisionFigureView[] = figureBlocks.map((block) => {
      const analysis = byBlock.get(block.blockId);
      if (analysis === undefined) {
        return {
          figureBlockId: block.blockId,
          status: "pending",
          ...(block.assetName !== undefined ? { assetName: block.assetName } : {}),
          ...(block.caption !== undefined ? { caption: block.caption } : {}),
          ...(block.provenance.page !== undefined ? { page: block.provenance.page } : {}),
          ...(block.provenance.cellIndex !== undefined ? { cellIndex: block.provenance.cellIndex } : {}),
          ...(block.provenance.outputIndex !== undefined ? { outputIndex: block.provenance.outputIndex } : {}),
        };
      }
      return {
        figureBlockId: analysis.figureBlockId,
        analysisId: analysis.analysisId,
        status: analysis.status,
        ...(analysis.provenance.assetName !== undefined ? { assetName: analysis.provenance.assetName } : {}),
        ...(analysis.provenance.caption !== undefined ? { caption: analysis.provenance.caption } : {}),
        ...(analysis.provenance.page !== undefined ? { page: analysis.provenance.page } : {}),
        ...(analysis.provenance.cellIndex !== undefined ? { cellIndex: analysis.provenance.cellIndex } : {}),
        ...(analysis.provenance.outputIndex !== undefined ? { outputIndex: analysis.provenance.outputIndex } : {}),
        ...(analysis.figureType !== undefined ? { figureType: analysis.figureType } : {}),
        ...(analysis.description !== undefined ? { description: analysis.description.slice(0, 280) } : {}),
        ...(analysis.candidateFacts.length > 0 ? { candidateFactCount: analysis.candidateFacts.length } : {}),
        ...(options.includeFacts === true ? { facts: analysis.candidateFacts } : {}),
        ...(analysis.model !== undefined ? { model: analysis.model } : {}),
        ...(analysis.confidence !== undefined ? { confidence: analysis.confidence } : {}),
        ...(analysis.error !== undefined ? { error: analysis.error } : {}),
        ...(analysis.skipReason !== undefined ? { skipReason: analysis.skipReason } : {}),
        ...(analysis.skipNote !== undefined ? { skipNote: analysis.skipNote } : {}),
        analyzedAt: analysis.analyzedAt,
      };
    });

    const counts = { total: figures.length, pending: 0, completed: 0, failed: 0, skipped: 0 };
    for (const figure of figures) {
      counts[figure.status] += 1;
    }
    return {
      sourceId,
      fileName: item.originalName ?? item.fileName ?? sourceId,
      document: document !== null ? summarizeDocument(document) : { status: "unparsed" },
      model: modelViewOf(selection),
      figures,
      counts,
      ...(stored?.updatedAt !== undefined ? { updatedAt: stored.updatedAt } : {}),
    };
  }

  // ---- 候选事实 → user_confirmed Evidence（§11）----

  /**
   * 用户确认一条 Vision candidate fact 为事实：
   * - 事实必须来自**新鲜且 completed**的分析（source 内容变化后旧分析拒绝确认）；
   * - 机械校验：fact 带 value 时 claim 必须提到该值（数值等价归一，同
   *   records 通道纪律）；
   * - verificationLevel=user_confirmed、verificationStatus=unverified——模型
   *   说「82.4」不是机械验证，grounded_verified 分级不受影响（无 chunk
   *   锚点，isFormalEvidence 不成立）；
   * - provenance：figureBlockId / assetName / page / bbox / visionFactRef。
   */
  async confirmFactEvidence(
    projectId: string,
    sourceId: string,
    factId: string,
    input: { claim: string },
    createdBy = "user",
  ) {
    if (this.evidence === undefined) {
      throw new BusinessError("INVALID_REQUEST", "EvidenceStore 未装配（无法确认图片候选事实）");
    }
    await this.projects.getRequired(projectId);
    const item = await this.sources.getRequired(projectId, sourceId);
    // M12.1（M12.0 §5 第 3 道隔离）：reference 源（benchmark 范文）的图片
    // 候选事实禁止确认进 Evidence——UI 不提供该动作，服务端在此校验
    // （前端缺席不是防线，服务端才是）。reference 源的 Vision 分析本身
    // 不受限（视觉规范参照是合法用途），只有 confirm → Evidence 被禁。
    if (item.sourceRole === "reference") {
      throw new EvidenceValidationError(
        `文献 ${sourceId} 是 reference 角色（benchmark 范文）——其图片候选事实不允许确认为 Evidence（M12.0 §5 Benchmark/Evidence 隔离；视觉规范参照 ≠ 证据来源）`,
      );
    }
    const claim = input.claim.trim();
    if (claim === "") {
      throw new BusinessError("INVALID_REQUEST", "claim 不能为空");
    }
    const stored = await this.analyses.load(projectId, sourceId);
    if (stored === null) {
      throw new NotFoundError("图片分析产物", `${sourceId}（请先 POST /sources/${sourceId}/vision/analyze）`);
    }
    // source 新鲜度：分析时与现在的 contentHash 必须一致（旧分析拒绝确认）
    const contentHash = item.contentHash ?? "";
    const located = locateFact(stored.analyses, factId, contentHash);
    if (located === null) {
      throw new NotFoundError(
        "图片候选事实",
        `${sourceId} ${factId}（不存在 / 分析未完成 / 分析已过期——source 内容变化后请重新分析）`,
      );
    }
    const { analysis, fact } = located;
    if (fact.value !== undefined && !claimMentionsValue(claim, fact.value)) {
      throw new EvidenceValueMismatchError(
        `claim 未包含候选事实值（${fact.factId} value=${fact.value}；claim 应提到该值）`,
      );
    }
    const where =
      analysis.provenance.page !== undefined
        ? `page ${analysis.provenance.page}`
        : analysis.provenance.cellIndex !== undefined
          ? `Cell ${analysis.provenance.cellIndex}${analysis.provenance.outputIndex !== undefined ? ` · output ${analysis.provenance.outputIndex}` : ""}`
          : analysis.provenance.fileName;
    const created = await this.evidence.append(
      projectId,
      {
        claim,
        quote: `[图 ${analysis.provenance.assetName ?? analysis.figureBlockId}${where !== "" ? ` · ${where}` : ""} 视觉分析] ${fact.claim}${fact.value !== undefined ? `（value: ${fact.value}）` : ""}`.slice(0, 2000),
        source: {
          sourceId,
          title: item.originalName ?? item.fileName,
        },
        location: {
          ...(analysis.provenance.page !== undefined ? { page: analysis.provenance.page } : {}),
          ...(analysis.provenance.cellIndex !== undefined
            ? { section: `Cell ${analysis.provenance.cellIndex}${analysis.provenance.outputIndex !== undefined ? ` · output ${analysis.provenance.outputIndex}` : ""}` }
            : {}),
          figureBlockId: analysis.figureBlockId,
          ...(analysis.provenance.assetName !== undefined ? { assetName: analysis.provenance.assetName } : {}),
          ...(analysis.provenance.bbox !== undefined ? { bbox: analysis.provenance.bbox } : {}),
          visionFactRef: `${analysis.analysisId}/${fact.factId}`,
        },
        verificationStatus: "unverified",
        verificationMethod: "user-confirmed:figure-analysis",
        verificationLevel: "user_confirmed",
      },
      createdBy,
    );
    this.log(
      `[vision] ${projectId}/${sourceId} 图片事实确认（${fact.factId}）→ Evidence ${created.id}`,
    );
    return { evidence: created, analysis, fact };
  }

  // ---- 内部 ----

  private async resolveModel(): Promise<VisionModelSelection> {
    if (this.modelRuntime === undefined || this.modelCandidates === undefined) {
      return {
        available: false,
        reason: "not_configured",
        detail: "Vision 模型接入未装配（无 ModelRuntime / 模型偏好）",
      };
    }
    const candidates = await this.modelCandidates();
    return resolveVisionModel(this.modelRuntime, candidates);
  }

  /** 读取图片资产字节（assetName 缺失 / 文件缺失 → null） */
  private async readAssetBytes(
    projectId: string,
    sourceId: string,
    block: ParsedFigureBlock,
  ): Promise<Buffer | null> {
    if (block.assetName === undefined) {
      return null;
    }
    try {
      return await readFile(join(this.documents.figuresDir(projectId, sourceId), block.assetName));
    } catch {
      return null; // ASSET_MISSING 由 analyzer 分类（imageBytes null）
    }
  }
}

// ---- 辅助 ----

/** freshness 三键判定（§18）：imageHash + modelSpec + schema 版本全同 */
function isFresh(
  prior: FigureAnalysis,
  imageHash: string | null,
  selection: VisionModelSelection,
): boolean {
  return (
    prior.imageHash === imageHash &&
    prior.imageHash !== null &&
    selection.available &&
    prior.analyzedModelSpec === selection.modelSpec
  );
}

/** capability unavailable 时的 skipped 分析（不调用模型） */
function skippedAnalysis(
  item: SourceItem,
  sourceContentHash: string,
  block: ParsedFigureBlock,
  imageHash: string | null,
  reason: string,
  note: string,
  now: () => Date,
): FigureAnalysis {
  return {
    schemaVersion: 1,
    analysisId: analysisIdOf(block.blockId),
    sourceId: item.sourceId,
    figureBlockId: block.blockId,
    status: "skipped",
    observations: [],
    candidateFacts: [],
    warnings: [],
    imageHash,
    outputSchemaVersion: VISION_OUTPUT_SCHEMA_VERSION,
    sourceContentHash,
    analyzedAt: now().toISOString(),
    skipReason: reason,
    skipNote: note.slice(0, 400),
    provenance: {
      fileName: block.provenance.fileName,
      ...(block.assetName !== undefined ? { assetName: block.assetName } : {}),
      ...(block.caption !== undefined ? { caption: block.caption } : {}),
      ...(block.width !== undefined ? { width: block.width } : {}),
      ...(block.height !== undefined ? { height: block.height } : {}),
      ...(block.provenance.page !== undefined ? { page: block.provenance.page } : {}),
      ...(block.provenance.bbox !== undefined ? { bbox: block.provenance.bbox } : {}),
      ...(block.provenance.cellIndex !== undefined ? { cellIndex: block.provenance.cellIndex } : {}),
      ...(block.provenance.cellId !== undefined ? { cellId: block.provenance.cellId } : {}),
      ...(block.provenance.outputIndex !== undefined ? { outputIndex: block.provenance.outputIndex } : {}),
    },
  };
}

/** 定位候选事实（completed + 新鲜分析内） */
function locateFact(
  analyses: readonly FigureAnalysis[],
  factId: string,
  currentContentHash: string,
): { analysis: FigureAnalysis; fact: FigureCandidateFact } | null {
  for (const analysis of analyses) {
    if (analysis.status !== "completed") {
      continue;
    }
    // source 内容变化后的旧分析拒绝确认（freshness 纪律）
    if (currentContentHash !== "" && analysis.sourceContentHash !== undefined && analysis.sourceContentHash !== currentContentHash) {
      continue;
    }
    const fact = analysis.candidateFacts.find((entry) => entry.factId === factId);
    if (fact !== undefined) {
      return { analysis, fact };
    }
  }
  return null;
}

/** provenance 人读摘要（分析输入 §8） */
function provenanceSummaryOf(block: ParsedFigureBlock): string {
  if (block.provenance.page !== undefined) {
    return `page ${block.provenance.page}`;
  }
  if (block.provenance.cellIndex !== undefined) {
    return `Cell ${block.provenance.cellIndex}${block.provenance.outputIndex !== undefined ? ` · output ${block.provenance.outputIndex}` : ""}`;
  }
  return block.provenance.fileName;
}

function modelViewOf(selection: VisionModelSelection): VisionModelView {
  if (selection.available) {
    return {
      available: true,
      modelSpec: selection.modelSpec,
      source: selection.source,
      detail: `Vision 模型：${selection.modelSpec}（${selection.source === "vision_setting" ? "显式配置" : "复用默认模型"}）`,
    };
  }
  return {
    available: false,
    reason: selection.reason,
    detail: `Vision 不可用：${selection.detail}`,
  };
}
