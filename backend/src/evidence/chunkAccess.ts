/**
 * ChunkAccess：按 chunkId 精确回取 SourceChunk（M6.5）。
 *
 * M6.4 的引用标记（[SRC:… CHUNK:…]）是 Agent 输出回溯的稳定锚点；本模块
 * 是该锚点的直接消费方——get_chunk 工具与 EvidenceGroundingService 的
 * quote 逐字校验共用同一条读取路径。
 *
 * 实现只读 ChunkStore 落盘产物（Derived State；不触碰 RetrievalService 的
 * 进程内索引——不修改 M6.4 检索层任何行为）。chunkId 内嵌内容 hash：
 * chunk 文本变化会生成新 chunkId，因此按 id 回取天然自校验——旧 id 找不到
 * 即「原文已变化」，绝不静默返回近似内容。
 */

import { BusinessError } from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { ChunkStore } from "../retrieval/ChunkStore.js";
import type { SourceChunk } from "../retrieval/types.js";
import type { SourceStore, SourceItem } from "../sources/SourceStore.js";

/** chunkId 形状：<sourceId>:<sectionId>:<节内序号4位>:<内容hash10>（D-0036） */
export const CHUNK_ID_PATTERN = /^[A-Z]\d{2,}:[A-Za-z0-9_-]+:\d{1,6}:[0-9a-f]{10}$/;

/** 回取结果：chunk 原文 + 来源条目（投影） */
export interface ResolvedChunk {
  chunk: SourceChunk;
  source: SourceItem;
}

export interface ChunkAccessOptions {
  projects: ProjectStore;
  chunkStore: ChunkStore;
  sources: SourceStore;
}

export class ChunkAccessError extends BusinessError {
  constructor(
    code: "INVALID_CHUNK_ID" | "CHUNK_NOT_FOUND" | "SOURCE_NOT_FOUND",
    message: string,
  ) {
    super(code, message);
  }
}

export class ChunkAccess {
  private readonly projects: ProjectStore;
  private readonly chunkStore: ChunkStore;
  private readonly sources: SourceStore;

  constructor(options: ChunkAccessOptions) {
    this.projects = options.projects;
    this.chunkStore = options.chunkStore;
    this.sources = options.sources;
  }

  /** chunkId 前缀（sourceId）提取；格式非法 → INVALID_CHUNK_ID */
  static sourceIdFromChunkId(chunkId: string): string {
    const sourceId = chunkId.split(":")[0] ?? "";
    if (!/^[A-Z]\d{2,}$/.test(sourceId)) {
      throw new ChunkAccessError(
        "INVALID_CHUNK_ID",
        `chunkId 格式非法（应为 <sourceId>:<sectionId>:<序号>:<hash10>）：${chunkId.slice(0, 80)}`,
      );
    }
    return sourceId;
  }

  /**
   * 按 chunkId 回取 chunk 原文与来源条目。
   * - 格式非法 → INVALID_CHUNK_ID（422）；
   * - chunk 落盘文件缺失 / 文件中无此 id（含 chunk 已因内容变化重生成的
   *   情形）→ CHUNK_NOT_FOUND（404 语义）；文件损坏（null）→ CHUNK_NOT_FOUND
   *   （derived state 自愈口径由检索层负责，这里如实报告）；
   * - chunk 存在但来源已从文献库删除 → SOURCE_NOT_FOUND。
   */
  async resolve(projectId: string, chunkId: string): Promise<ResolvedChunk> {
    await this.projects.getRequired(projectId);
    if (typeof chunkId !== "string" || chunkId.trim() === "" || !CHUNK_ID_PATTERN.test(chunkId)) {
      throw new ChunkAccessError(
        "INVALID_CHUNK_ID",
        `chunkId 格式非法（应为 <sourceId>:<sectionId>:<序号>:<hash10>）：${chunkId.slice(0, 80)}`,
      );
    }
    const sourceId = ChunkAccess.sourceIdFromChunkId(chunkId);
    const chunks = await this.chunkStore.readChunks(projectId, sourceId);
    const chunk =
      chunks === null ? undefined : chunks.find((item) => item.chunkId === chunkId);
    if (chunk === undefined) {
      throw new ChunkAccessError(
        "CHUNK_NOT_FOUND",
        `chunk 不存在或已失效（内容变化会生成新 chunkId）：${chunkId.slice(0, 120)}`,
      );
    }
    const source = await this.sources.get(projectId, sourceId);
    if (source === null) {
      throw new ChunkAccessError("SOURCE_NOT_FOUND", `来源 ${sourceId} 已不在项目文献库中`);
    }
    return { chunk, source };
  }
}
