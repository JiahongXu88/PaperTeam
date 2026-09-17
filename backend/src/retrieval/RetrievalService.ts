/**
 * RetrievalService：项目级 Hybrid Retrieval 编排（M6.4；D-0033 第 6 层）。
 *
 * 职责与边界：
 * - Index = Derived State：进程内状态可整体丢弃重建；落盘产物（chunks jsonl /
 *   manifest / 向量旁车）由 ChunkStore 管理，全部可删除后经 rebuild 恢复；
 * - Lexical 恒可用（无任何外部依赖）；Dense 依赖可选 EmbeddingProvider——
 *   未注册 / 失败时 lexical-only 健康降级（红线：dense 不可用 ≠ 服务失败）；
 * - Hybrid = RRF（k=60，与 M6.3 Search Fusion 同思想；不同量纲分数不相加）；
 * - Project isolation：全部状态按 projectId 分桶，跨项目零共享；
 * - 并发：每项目操作（load / rebuild / invalidate）串行化（promise 链），
 *   search 读取不可变快照——rebuild 期间旧快照可继续服务，交换原子生效；
 * - 本服务无任何 EvidenceStore 写路径（Retrieved ≠ Verified；M6.5 边界）。
 */

import { join } from "node:path";

import {
  BusinessError,
  EmbeddingUnavailableError,
  NotFoundError,
  RetrievalInvalidFilterError,
  SourceNotIndexableError,
} from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { effectiveSourceType, type SourceItem, type SourceRole, type SourceType } from "../sources/SourceStore.js";
import type { ChunkStore, ChunkManifest } from "./ChunkStore.js";
import { SourceChunker } from "./SourceChunker.js";
import { cosineSimilarity, LexicalIndex } from "./lexicalIndex.js";
import type {
  ChunkFilter,
  EmbeddingProvider,
  RetrievalMode,
  RetrievalResult,
  RetrievalStats,
  RetrievedChunk,
  SearchOptions,
  SourceChunk,
  SourceChunkOutcome,
} from "./types.js";

const RRF_K = 60;
/** 邻近去重：同 source 同 section 连续（|Δordinal| ≤ 1）chunk 最多保留数 */
const MAX_ADJACENT_RUN = 2;

export interface RetrievalServiceOptions {
  projects: ProjectStore;
  /** 由调用方持有（与 httpServer / SourceImportService 同一实例） */
  sources: import("../sources/SourceStore.js").SourceStore;
  chunker: SourceChunker;
  chunkStore: ChunkStore;
  /** 可选 dense 通道（未注册 = lexical-only；D-0033 optional 红线） */
  embedding?: EmbeddingProvider;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface RebuildReport {
  projectId: string;
  sources: SourceChunkOutcome[];
  chunks: number;
  durationMs: number;
}

interface ProjectRetrievalState {
  chunks: Map<string, SourceChunk>;
  sourceChunks: Map<string, string[]>;
  sourceItems: Map<string, SourceItem>;
  lexical: LexicalIndex;
  /** sourceId → chunkId → 向量（provider identity 匹配且加载成功的部分） */
  vectors: Map<string, Map<string, Float32Array>>;
  manifest: ChunkManifest;
  denseNote?: string;
  builtAt: string;
  /** 构建时文献库签名（sourceId:contentHash:updatedAt）；变化 = 需要增量刷新 */
  signature: string;
}

export class RetrievalService {
  private readonly projects: ProjectStore;
  private readonly sources: import("../sources/SourceStore.js").SourceStore;
  private readonly chunker: SourceChunker;
  private readonly chunkStore: ChunkStore;
  private readonly embedding?: EmbeddingProvider;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private readonly states = new Map<string, ProjectRetrievalState>();
  /** 每项目操作串行化链（load / rebuild / invalidate 互斥；search 只读快照） */
  private readonly ops = new Map<string, Promise<unknown>>();

  constructor(options: RetrievalServiceOptions) {
    this.projects = options.projects;
    this.sources = options.sources;
    this.chunker = options.chunker;
    this.chunkStore = options.chunkStore;
    this.embedding = options.embedding;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  // ---- 检索 ----

  async search(projectId: string, query: string, options: SearchOptions = {}): Promise<RetrievalResult> {
    if (typeof query !== "string" || query.trim() === "") {
      throw new BusinessError("INVALID_REQUEST", "检索 query 不能为空");
    }
    const topK = clampTopK(options.topK);
    const filter = options.filter !== undefined ? validateFilter(options.filter) : undefined;
    const state = await this.ensureState(projectId);
    const denseConfigured = this.embedding !== undefined;
    const denseAvailable = denseConfigured && state.vectors.size > 0;
    const requested = options.mode ?? "auto";
    if (requested === "hybrid" && !denseConfigured) {
      throw new EmbeddingUnavailableError("未配置 EmbeddingProvider（dense 通道不存在）");
    }
    const mode: RetrievalMode = denseAvailable && requested !== "lexical" ? "hybrid" : "lexical";
    let denseNote: string | undefined;
    if (requested === "hybrid" && !denseAvailable && denseConfigured) {
      denseNote = state.denseNote ?? "dense 向量不可用，本轮降级 lexical-only";
    } else if (mode === "lexical" && state.denseNote !== undefined) {
      denseNote = state.denseNote;
    }

    const predicate = filter !== undefined ? buildPredicate(filter, state) : undefined;
    const candidateN = Math.max(topK * 3, 30);

    // lexical 通道
    const lexicalHits = state.lexical.search(query, { predicate, topN: candidateN });

    // dense 通道（失败降级：不 fail 整个 search）
    let denseHits: Array<{ chunkId: string; score: number }> = [];
    if (mode === "hybrid" && this.embedding !== undefined) {
      try {
        const queryVector = await this.embedding.embedQuery(query);
        const scored: Array<{ chunkId: string; score: number }> = [];
        for (const byChunk of state.vectors.values()) {
          for (const [chunkId, vector] of byChunk) {
            const chunk = state.chunks.get(chunkId);
            if (chunk === undefined) {
              continue;
            }
            if (predicate !== undefined && !predicate(chunk)) {
              continue;
            }
            scored.push({ chunkId, score: cosineSimilarity(queryVector, vector) });
          }
        }
        scored.sort((a, b) => b.score - a.score || (a.chunkId < b.chunkId ? -1 : 1));
        denseHits = scored.slice(0, candidateN);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`[retrieval] dense 查询失败，降级 lexical：${message.slice(0, 200)}`);
        return this.assembleLexicalResult(state, query, lexicalHits, topK, `dense 查询失败：${message.slice(0, 120)}`);
      }
    }

    if (mode === "lexical") {
      return this.assembleLexicalResult(state, query, lexicalHits, topK, denseNote);
    }

    // RRF 融合（k=60；两通道等权——量纲无关，不做裸分数相加）
    const fused = new Map<string, { score: number; lexicalRank?: number; lexicalScore?: number; denseRank?: number; denseScore?: number; channels: Array<"lexical" | "dense"> }>();
    lexicalHits.forEach((hit, index) => {
      const entry = fused.get(hit.chunkId) ?? { score: 0, channels: [] };
      entry.score += 1 / (RRF_K + index + 1);
      entry.lexicalRank = index + 1;
      entry.lexicalScore = hit.score;
      if (!entry.channels.includes("lexical")) {
        entry.channels.push("lexical");
      }
      fused.set(hit.chunkId, entry);
    });
    denseHits.forEach((hit, index) => {
      const entry = fused.get(hit.chunkId) ?? { score: 0, channels: [] };
      entry.score += 1 / (RRF_K + index + 1);
      entry.denseRank = index + 1;
      entry.denseScore = hit.score;
      if (!entry.channels.includes("dense")) {
        entry.channels.push("dense");
      }
      fused.set(hit.chunkId, entry);
    });
    const ordered = [...fused.entries()].sort(
      (a, b) => b[1].score - a[1].score || (a[0] < b[0] ? -1 : 1),
    );

    // 邻近 chunk 去重（overlap 导致相邻 chunk 大量重复；上限 MAX_ADJACENT_RUN）
    const keptOrdinals = new Map<string, number[]>();
    const results: RetrievedChunk[] = [];
    let suppressed = 0;
    for (const [chunkId, entry] of ordered) {
      if (results.length >= topK) {
        break;
      }
      const chunk = state.chunks.get(chunkId);
      if (chunk === undefined) {
        continue;
      }
      const key = `${chunk.sourceId}:${chunk.sectionId}`;
      const neighbors = keptOrdinals.get(key) ?? [];
      if (neighbors.filter((ordinal) => Math.abs(ordinal - chunk.ordinal) <= 1).length >= MAX_ADJACENT_RUN) {
        suppressed += 1;
        continue;
      }
      keptOrdinals.set(key, [...neighbors, chunk.ordinal]);
      results.push(this.toRetrievedChunk(state, chunk, entry));
    }
    return {
      mode,
      query,
      results,
      diagnostics: {
        lexical: true,
        dense: true,
        suppressedAdjacent: suppressed,
        indexChunks: state.lexical.size,
      },
    };
  }

  private assembleLexicalResult(
    state: ProjectRetrievalState,
    query: string,
    hits: Array<{ chunkId: string; score: number }>,
    topK: number,
    denseNote?: string,
  ): RetrievalResult {
    const keptOrdinals = new Map<string, number[]>();
    const results: RetrievedChunk[] = [];
    let suppressed = 0;
    for (const hit of hits) {
      if (results.length >= topK) {
        break;
      }
      const chunk = state.chunks.get(hit.chunkId);
      if (chunk === undefined) {
        continue;
      }
      const key = `${chunk.sourceId}:${chunk.sectionId}`;
      const neighbors = keptOrdinals.get(key) ?? [];
      if (neighbors.filter((ordinal) => Math.abs(ordinal - chunk.ordinal) <= 1).length >= MAX_ADJACENT_RUN) {
        suppressed += 1;
        continue;
      }
      keptOrdinals.set(key, [...neighbors, chunk.ordinal]);
      results.push(
        this.toRetrievedChunk(state, chunk, {
          score: 0,
          lexicalRank: results.length + 1,
          lexicalScore: hit.score,
          channels: ["lexical"],
        }),
      );
    }
    return {
      mode: "lexical",
      query,
      results,
      diagnostics: {
        lexical: true,
        dense: false,
        ...(denseNote !== undefined ? { denseNote } : {}),
        suppressedAdjacent: suppressed,
        indexChunks: state.lexical.size,
      },
    };
  }

  private toRetrievedChunk(
    state: ProjectRetrievalState,
    chunk: SourceChunk,
    entry: {
      score: number;
      lexicalRank?: number;
      lexicalScore?: number;
      denseRank?: number;
      denseScore?: number;
      channels: Array<"lexical" | "dense">;
    },
  ): RetrievedChunk {
    const item = state.sourceItems.get(chunk.sourceId);
    return {
      chunk,
      source: {
        sourceId: chunk.sourceId,
        ...(item?.metadata.title !== undefined ? { title: item.metadata.title } : {}),
        ...(item?.metadata.year !== undefined ? { year: item.metadata.year } : {}),
        sourceRole: item?.sourceRole ?? "both",
        ...(item !== undefined ? { sourceType: effectiveSourceType(item) } : {}),
        ...(item?.metadata.doi !== undefined ? { doi: item.metadata.doi } : {}),
        ...(item?.metadata.arxivId !== undefined ? { arxivId: item.metadata.arxivId } : {}),
      },
      score: {
        fused: entry.score,
        ...(entry.lexicalRank !== undefined ? { lexicalRank: entry.lexicalRank, lexicalScore: entry.lexicalScore } : {}),
        ...(entry.denseRank !== undefined ? { denseRank: entry.denseRank, denseScore: entry.denseScore } : {}),
      },
      channels: entry.channels,
    };
  }

  // ---- 生命周期 ----

  async rebuild(projectId: string): Promise<RebuildReport> {
    const startedAt = Date.now();
    await this.projects.getRequired(projectId);
    const report = await this.enqueue(projectId, async () => {
      const items = await this.sources.list(projectId);
      const manifest: ChunkManifest = { entries: {} };
      const state = emptyState();
      const outcomes: SourceChunkOutcome[] = [];
      for (const item of items) {
        outcomes.push(await this.generateSourceInto(state, projectId, item, manifest));
      }
      // 孤儿文件对账：库中已不存在的 source 的 derived 产物直接清理
      for (const fileSourceId of await this.chunkStore.listSourceFiles(projectId)) {
        if (!items.some((item) => item.sourceId === fileSourceId)) {
          await this.chunkStore.removeSourceArtifacts(projectId, fileSourceId);
        }
      }
      await this.chunkStore.writeManifest(projectId, manifest);
      state.manifest = manifest;
      if (this.embedding !== undefined) {
        await this.loadVectors(state, projectId);
      }
      state.builtAt = this.now().toISOString();
      state.signature = librarySignature(items);
      this.states.set(projectId, state);
      return { outcomes, chunks: state.lexical.size };
    });
    return {
      projectId,
      sources: report.outcomes,
      chunks: report.chunks,
      durationMs: Date.now() - startedAt,
    };
  }

  /** 单 source 重建（增量失效路径）；无法生成全文 → SOURCE_NOT_INDEXABLE（422） */
  async rebuildSource(projectId: string, sourceId: string): Promise<SourceChunkOutcome> {
    await this.projects.getRequired(projectId);
    return this.enqueue(projectId, async () => {
      const item = await this.sources.get(projectId, sourceId);
      if (item === null) {
        throw new NotFoundError("文献", sourceId);
      }
      const manifest = await this.chunkStore.readManifest(projectId);
      const state = this.states.get(projectId) ?? null;
      removeSourceFromState(state, sourceId);
      const outcome = await this.generateSourceInto(state ?? emptyState(), projectId, item, manifest);
      await this.chunkStore.writeManifest(projectId, manifest);
      if (state !== null) {
        state.manifest = manifest;
        const refreshed = await this.sources.get(projectId, sourceId);
        if (refreshed !== null) {
          state.sourceItems.set(sourceId, refreshed);
        }
        state.signature = librarySignature(await this.sources.list(projectId));
        if (this.embedding !== undefined) {
          await this.loadVectorsForSource(state, projectId, sourceId);
        }
      }
      if (outcome.status === "skipped") {
        throw new SourceNotIndexableError(sourceId, outcome.reason ?? "not_indexable", outcome.note);
      }
      return outcome;
    });
  }

  /** 删除 source 后失效（磁盘产物 + 内存状态 + manifest；幂等） */
  async invalidateSource(projectId: string, sourceId: string): Promise<void> {
    await this.enqueue(projectId, async () => {
      const manifest = await this.chunkStore.readManifest(projectId);
      if (manifest.entries[sourceId] !== undefined) {
        delete manifest.entries[sourceId];
        await this.chunkStore.writeManifest(projectId, manifest);
      }
      await this.chunkStore.removeSourceArtifacts(projectId, sourceId);
      const state = this.states.get(projectId);
      if (state !== undefined) {
        removeSourceFromState(state, sourceId);
      }
    });
  }

  async stats(projectId: string): Promise<RetrievalStats> {
    const state = await this.ensureState(projectId);
    const items = await this.sources.list(projectId);
    let stale = 0;
    for (const item of items) {
      const entry = state.manifest.entries[item.sourceId];
      if (
        entry !== undefined &&
        entry.sourceContentHash !== undefined &&
        item.contentHash !== undefined &&
        entry.sourceContentHash !== item.contentHash
      ) {
        stale += 1;
      }
    }
    const indexed = Object.values(state.manifest.entries).filter((entry) => entry.status === "indexed").length;
    const skipped = Object.values(state.manifest.entries).filter((entry) => entry.status === "skipped").length;
    let vectorChunks = 0;
    for (const byChunk of state.vectors.values()) {
      vectorChunks += byChunk.size;
    }
    return {
      mode: this.embedding !== undefined && state.vectors.size > 0 ? "hybrid" : "lexical",
      sources: { total: items.length, indexed, skipped, stale },
      chunks: state.lexical.size,
      ...(this.embedding !== undefined
        ? {
            vectors: {
              provider: this.embedding.name,
              identity: this.embedding.identity,
              dimensions: this.embedding.dimensions,
              chunks: vectorChunks,
            },
          }
        : {}),
      builtAt: state.builtAt,
    };
  }

  // ---- 内部：状态装载与生成 ----

  /**
   * 确保项目索引可用且与当前文献库一致（lazy + 自动增量刷新）：
   * 每次调用对比文献库签名（sources/index.json 很小，读取成本可忽略）；
   * 签名一致直接复用内存态，变化（新增 / 删除 / 内容或元数据更新）则串行
   * 增量刷新——新 source 补建、stale source 重生成、孤儿清理。
   */
  private async ensureState(projectId: string): Promise<ProjectRetrievalState> {
    const existing = this.states.get(projectId);
    const signature = librarySignature(await this.sources.list(projectId));
    if (existing !== undefined && existing.signature === signature) {
      return existing;
    }
    return this.enqueue(projectId, async () => {
      const current = this.states.get(projectId);
      if (current !== undefined && current.signature === signature) {
        return current;
      }
      const state = await this.loadProject(projectId);
      this.states.set(projectId, state);
      return state;
    });
  }

  /** 每项目互斥（先等前序操作，再执行；异常不阻塞后续操作） */
  private async enqueue<T>(projectId: string, work: () => Promise<T>): Promise<T> {
    const previous = this.ops.get(projectId) ?? Promise.resolve();
    const next = previous.then(work, work);
    this.ops.set(
      projectId,
      next.catch(() => {}),
    );
    return next;
  }

  private async loadProject(projectId: string): Promise<ProjectRetrievalState> {
    await this.projects.getRequired(projectId);
    const items = await this.sources.list(projectId);
    let manifest: ChunkManifest;
    try {
      manifest = await this.chunkStore.readManifest(projectId);
    } catch (error) {
      // manifest 损坏 → derived state 自愈口径：从空 manifest 全量重建
      if (error instanceof BusinessError && error.code === "RETRIEVAL_NOT_READY") {
        this.log(`[retrieval] manifest 损坏（${projectId}），执行全量自愈重建`);
        manifest = { entries: {} };
      } else {
        throw error;
      }
    }
    const state = emptyState();
    for (const item of items) {
      state.sourceItems.set(item.sourceId, item);
      const entry = manifest.entries[item.sourceId];
      if (entry === undefined || isEntryStale(entry, item)) {
        await this.generateSourceInto(state, projectId, item, manifest);
        continue;
      }
      if (entry.status === "skipped") {
        continue;
      }
      const chunks = await this.chunkStore.readChunks(projectId, item.sourceId);
      if (chunks === null) {
        // chunk 文件缺失 / 损坏 → 重新生成（Derived State 自愈）
        await this.generateSourceInto(state, projectId, item, manifest);
        continue;
      }
      addSourceToState(state, item, chunks);
    }
    // 孤儿对账：库中已删除的 source——残留文件清理 + manifest entry 清除
    for (const fileSourceId of await this.chunkStore.listSourceFiles(projectId)) {
      if (!items.some((item) => item.sourceId === fileSourceId)) {
        await this.chunkStore.removeSourceArtifacts(projectId, fileSourceId);
        delete manifest.entries[fileSourceId];
      }
    }
    for (const sourceId of Object.keys(manifest.entries)) {
      if (!items.some((item) => item.sourceId === sourceId)) {
        delete manifest.entries[sourceId];
      }
    }
    await this.chunkStore.writeManifest(projectId, manifest);
    state.manifest = manifest;
    if (this.embedding !== undefined) {
      await this.loadVectors(state, projectId);
    }
    state.builtAt = this.now().toISOString();
    state.signature = librarySignature(items);
    return state;
  }

  /** 生成（或跳过）单个 source 的 chunks 并写入 state + manifest + 落盘 */
  private async generateSourceInto(
    state: ProjectRetrievalState,
    projectId: string,
    item: SourceItem,
    manifest: ChunkManifest,
  ): Promise<SourceChunkOutcome> {
    state.sourceItems.set(item.sourceId, item);
    removeSourceFromState(state, item.sourceId);
    let result: import("./SourceChunker.js").SourceChunkResult;
    if (item.fileName === undefined) {
      result = {
        outcome: {
          sourceId: item.sourceId,
          status: "skipped",
          chunkCount: 0,
          reason: "full_text_unavailable",
          note: "metadata-only 条目（无原始文件）",
        },
        chunks: [],
        sectionTitles: new Map(),
      };
    } else {
      let filePath: string;
      try {
        filePath = await this.sources.filePath(projectId, item.sourceId);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        this.log(`[retrieval] 读取文献 ${item.sourceId} 路径失败：${message.slice(0, 200)}`);
        filePath = join(this.projects.sourcesDir(projectId), "papers", item.fileName);
      }
      result = await this.chunker.chunkSource(projectId, item, filePath);
    }
    if (result.outcome.status === "indexed" && result.chunks.length > 0) {
      await this.chunkStore.writeChunks(projectId, item.sourceId, result.chunks);
      addSourceToState(state, item, result.chunks);
      manifest.entries[item.sourceId] = {
        status: "indexed",
        ...(item.contentHash !== undefined ? { sourceContentHash: item.contentHash } : {}),
        chunkCount: result.chunks.length,
        ...(result.outcome.parser !== undefined ? { parser: result.outcome.parser } : {}),
        generatedAt: this.now().toISOString(),
      };
    } else {
      await this.chunkStore.removeSourceArtifacts(projectId, item.sourceId);
      manifest.entries[item.sourceId] = {
        status: "skipped",
        ...(item.contentHash !== undefined ? { sourceContentHash: item.contentHash } : {}),
        chunkCount: 0,
        ...(result.outcome.reason !== undefined ? { reason: result.outcome.reason } : {}),
        ...(result.outcome.note !== undefined ? { note: result.outcome.note } : {}),
        generatedAt: this.now().toISOString(),
      };
    }
    return result.outcome;
  }

  /** dense 向量装载：旁车缓存（chunkId+contentHash+identity）命中即复用，缺失才嵌入 */
  private async loadVectors(state: ProjectRetrievalState, projectId: string): Promise<void> {
    for (const sourceId of state.sourceChunks.keys()) {
      await this.loadVectorsForSource(state, projectId, sourceId);
    }
  }

  private async loadVectorsForSource(
    state: ProjectRetrievalState,
    projectId: string,
    sourceId: string,
  ): Promise<void> {
    const provider = this.embedding;
    if (provider === undefined) {
      return;
    }
    const chunkIds = state.sourceChunks.get(sourceId) ?? [];
    if (chunkIds.length === 0) {
      return;
    }
    const vectorsByChunk = new Map<string, Float32Array>();
    const needEmbed: string[] = [];
    const file = await this.chunkStore.readVectors(projectId, sourceId);
    if (
      file !== null &&
      file.provider === provider.name &&
      file.identity === provider.identity &&
      file.dimensions === provider.dimensions
    ) {
      const entryById = new Map(file.entries.map((entry) => [entry.chunkId, entry]));
      for (const chunkId of chunkIds) {
        const chunk = state.chunks.get(chunkId);
        const entry = chunk !== undefined ? entryById.get(chunkId) : undefined;
        if (chunk !== undefined && entry !== undefined && entry.contentHash === chunk.contentHash) {
          vectorsByChunk.set(chunkId, Float32Array.from(entry.vector));
        } else {
          needEmbed.push(chunkId);
        }
      }
    } else {
      needEmbed.push(...chunkIds);
    }
    if (needEmbed.length > 0) {
      try {
        const texts = needEmbed
          .map((chunkId) => state.chunks.get(chunkId)?.text)
          .filter((text): text is string => typeof text === "string");
        const vectors = await provider.embedDocuments(texts);
        needEmbed.forEach((chunkId, index) => {
          const vector = vectors[index];
          if (vector !== undefined) {
            vectorsByChunk.set(chunkId, vector);
          }
        });
        // 回写旁车（全量条目；Derived 缓存）
        const entries = [...vectorsByChunk.entries()].map(([chunkId, vector]) => ({
          chunkId,
          contentHash: state.chunks.get(chunkId)?.contentHash ?? "",
          vector: Array.from(vector),
        }));
        await this.chunkStore.writeVectors(projectId, sourceId, {
          provider: provider.name,
          identity: provider.identity,
          dimensions: provider.dimensions,
          entries,
        });
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        state.denseNote = `embedding 失败（${message.slice(0, 120)}），lexical-only`;
        this.log(`[retrieval] ${projectId}/${sourceId} embedding 失败，降级：${message.slice(0, 200)}`);
        return; // 该 source 本轮无向量；其余 source 继续
      }
    }
    if (vectorsByChunk.size > 0) {
      state.vectors.set(sourceId, vectorsByChunk);
    }
  }
}

/** 文献库签名：sourceId + contentHash + updatedAt（角色/元数据 PATCH 会更新 updatedAt） */
function librarySignature(items: SourceItem[]): string {
  return items.map((item) => `${item.sourceId}:${item.contentHash ?? ""}:${item.updatedAt}`).join("|");
}

function emptyState(): ProjectRetrievalState {
  return {
    chunks: new Map(),
    sourceChunks: new Map(),
    sourceItems: new Map(),
    lexical: new LexicalIndex(),
    vectors: new Map(),
    manifest: { entries: {} },
    builtAt: "",
    signature: "",
  };
}

function addSourceToState(state: ProjectRetrievalState, item: SourceItem, chunks: SourceChunk[]): void {
  state.sourceItems.set(item.sourceId, item);
  const sorted = [...chunks].sort((a, b) => a.ordinal - b.ordinal);
  state.sourceChunks.set(
    item.sourceId,
    sorted.map((chunk) => chunk.chunkId),
  );
  for (const chunk of sorted) {
    state.chunks.set(chunk.chunkId, chunk);
  }
  state.lexical.addSource(item.sourceId, sorted);
}

/** 从内存态移除一个 source 的全部痕迹（lexical / vectors / chunk 映射；幂等） */
function removeSourceFromState(state: ProjectRetrievalState | null, sourceId: string): void {
  if (state === null) {
    return;
  }
  state.lexical.removeSource(sourceId);
  state.vectors.delete(sourceId);
  for (const chunkId of state.sourceChunks.get(sourceId) ?? []) {
    state.chunks.delete(chunkId);
  }
  state.sourceChunks.delete(sourceId);
}

/** manifest entry 是否过期（source 内容已变化 → 需要重新生成） */
function isEntryStale(entry: { sourceContentHash?: string; status: string }, item: SourceItem): boolean {
  if (item.contentHash === undefined) {
    return false; // 老条目无 hash：无法判定，接受现状（lazy 兼容）
  }
  if (entry.sourceContentHash === undefined) {
    return true; // entry 无 hash 但当前有 → 视为过期（保守重建）
  }
  return entry.sourceContentHash !== item.contentHash;
}

function clampTopK(topK: number | undefined): number {
  if (topK === undefined) {
    return 8;
  }
  if (!Number.isInteger(topK) || topK < 1 || topK > 50) {
    throw new BusinessError("INVALID_REQUEST", "topK 必须是 1-50 的整数");
  }
  return topK;
}

const SOURCE_ROLES: readonly SourceRole[] = ["evidence", "reference", "both"];
const SOURCE_TYPES: readonly SourceType[] = [
  "pdf",
  "bibtex",
  "text",
  "markdown",
  "image",
  "doi",
  "arxiv",
  "url",
  "metadata",
];

function validateFilter(filter: ChunkFilter): ChunkFilter {
  if (filter.sourceIds !== undefined) {
    if (
      !Array.isArray(filter.sourceIds) ||
      filter.sourceIds.length === 0 ||
      !filter.sourceIds.every((id) => typeof id === "string" && /^[A-Z]\d{2,}$/.test(id))
    ) {
      throw new RetrievalInvalidFilterError("sourceIds 必须是非空字符串数组（形如 S001）");
    }
  }
  if (filter.sourceRole !== undefined && !SOURCE_ROLES.includes(filter.sourceRole)) {
    throw new RetrievalInvalidFilterError(`sourceRole 只能是 ${SOURCE_ROLES.join(" / ")}`);
  }
  if (filter.sourceType !== undefined && !SOURCE_TYPES.includes(filter.sourceType)) {
    throw new RetrievalInvalidFilterError(`sourceType 只能是 ${SOURCE_TYPES.join(" / ")}`);
  }
  if (filter.section !== undefined && (typeof filter.section !== "string" || filter.section.trim() === "")) {
    throw new RetrievalInvalidFilterError("section 必须是非空字符串");
  }
  for (const bound of [filter.yearFrom, filter.yearTo]) {
    if (bound !== undefined && (!Number.isInteger(bound) || bound < 1000 || bound > 3000)) {
      throw new RetrievalInvalidFilterError("yearFrom / yearTo 必须是 1000-3000 的整数");
    }
  }
  if (
    filter.yearFrom !== undefined &&
    filter.yearTo !== undefined &&
    filter.yearFrom > filter.yearTo
  ) {
    throw new RetrievalInvalidFilterError("yearFrom 不能大于 yearTo");
  }
  return filter;
}

function buildPredicate(filter: ChunkFilter, state: ProjectRetrievalState): (chunk: SourceChunk) => boolean {
  const sourceIds = filter.sourceIds !== undefined ? new Set(filter.sourceIds) : undefined;
  return (chunk) => {
    if (sourceIds !== undefined && !sourceIds.has(chunk.sourceId)) {
      return false;
    }
    if (filter.section !== undefined) {
      const prefix = filter.section.toLowerCase();
      const title = chunk.sectionTitle.toLowerCase();
      const subsection = chunk.subsection?.toLowerCase() ?? "";
      if (!title.startsWith(prefix) && !subsection.startsWith(prefix)) {
        return false;
      }
    }
    const item = state.sourceItems.get(chunk.sourceId);
    if (
      filter.sourceRole !== undefined &&
      !(item?.sourceRole === filter.sourceRole || item?.sourceRole === "both")
    ) {
      return false;
    }
    if (filter.sourceType !== undefined && item !== undefined) {
      if (effectiveSourceType(item) !== filter.sourceType) {
        return false;
      }
    }
    if (filter.yearFrom !== undefined || filter.yearTo !== undefined) {
      const year = item?.metadata.year;
      if (year === undefined) {
        return false;
      }
      if (filter.yearFrom !== undefined && year < filter.yearFrom) {
        return false;
      }
      if (filter.yearTo !== undefined && year > filter.yearTo) {
        return false;
      }
    }
    return true;
  };
}
