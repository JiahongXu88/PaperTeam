/**
 * ChunkStore：SourceChunk 落盘（Derived State；M6.4）。
 *
 * 布局（D-0033 §2-7「chunk 落盘 sources/chunks/<sourceId>.jsonl」+ 旁车向量）：
 *   sources/chunks/<sourceId>.jsonl        每行一个 SourceChunk（原子重写）
 *   sources/chunks/<sourceId>.vectors.json dense 向量旁车（EmbeddingProvider 存在时）
 *   sources/chunks/index.json              manifest（status / sourceContentHash /
 *                                          chunkCount / reason / generatedAt）
 *
 * 全部可删除可重建（Index = Derived State 验收口径）；manifest 不是事实来源——
 * 读取方对 chunk 文件与 SourceStore 做 lazy 对账（孤儿清理 / stale 判定）。
 */

import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";

import { BusinessError } from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { writeJsonAtomic, writeFileAtomic } from "../util/atomic.js";
import type { SourceChunk, SourceChunkOutcome } from "./types.js";

export interface ChunkManifestEntry {
  status: "indexed" | "skipped";
  /** 生成时的 source.contentHash（stale 判定；metadata-only 条目缺省） */
  sourceContentHash?: string;
  chunkCount: number;
  parser?: string;
  reason?: SourceChunkOutcome["reason"];
  note?: string;
  generatedAt: string;
}

export interface ChunkManifest {
  entries: Record<string, ChunkManifestEntry>;
}

export interface VectorFileEntry {
  chunkId: string;
  /** 生成时 chunk 的 contentHash（chunk 文本变化 → 重嵌） */
  contentHash: string;
  vector: number[];
}

export interface VectorFile {
  provider: string;
  identity: string;
  dimensions: number;
  entries: VectorFileEntry[];
}

export class ChunkStore {
  private readonly projects: ProjectStore;

  constructor(projects: ProjectStore) {
    this.projects = projects;
  }

  private chunksDir(projectId: string): string {
    return join(this.projects.sourcesDir(projectId), "chunks");
  }

  private chunkFilePath(projectId: string, sourceId: string): string {
    return join(this.chunksDir(projectId), `${sourceId}.jsonl`);
  }

  private vectorFilePath(projectId: string, sourceId: string): string {
    return join(this.chunksDir(projectId), `${sourceId}.vectors.json`);
  }

  private manifestPath(projectId: string): string {
    return join(this.chunksDir(projectId), "index.json");
  }

  /** 读 manifest（不存在 = 空清单；损坏 → 结构化错误，不静默当空库） */
  async readManifest(projectId: string): Promise<ChunkManifest> {
    let raw: string;
    try {
      raw = await readFile(this.manifestPath(projectId), "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return { entries: {} };
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BusinessError(
        "RETRIEVAL_NOT_READY",
        `chunk manifest 损坏（${projectId}/sources/chunks/index.json 不是合法 JSON）；可执行 rebuild 重建`,
      );
    }
    const entries = (parsed as { entries?: unknown } | null)?.entries;
    if (!isRecord(entries)) {
      throw new BusinessError(
        "RETRIEVAL_NOT_READY",
        `chunk manifest 损坏（${projectId}/sources/chunks/index.json 缺少 entries）；可执行 rebuild 重建`,
      );
    }
    const out: Record<string, ChunkManifestEntry> = {};
    for (const [sourceId, entry] of Object.entries(entries)) {
      if (isRecord(entry)) {
        out[sourceId] = entry as unknown as ChunkManifestEntry;
      }
    }
    return { entries: out };
  }

  async writeManifest(projectId: string, manifest: ChunkManifest): Promise<void> {
    await mkdir(this.chunksDir(projectId), { recursive: true });
    await writeJsonAtomic(this.manifestPath(projectId), manifest);
  }

  /** 增量更新单条 manifest entry（读-改-写；调用方负责并发串行化） */
  async updateManifestEntry(projectId: string, sourceId: string, entry: ChunkManifestEntry): Promise<void> {
    const manifest = await this.readManifest(projectId);
    manifest.entries[sourceId] = entry;
    await this.writeManifest(projectId, manifest);
  }

  /**
   * 读某 source 的 chunks；文件损坏（非法行）→ 返回 null（调用方按
   * derived-state 自愈口径重新生成，而不是把损坏当空库）。
   */
  async readChunks(projectId: string, sourceId: string): Promise<SourceChunk[] | null> {
    let raw: string;
    try {
      raw = await readFile(this.chunkFilePath(projectId, sourceId), "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    const chunks: SourceChunk[] = [];
    for (const line of raw.split("\n")) {
      const trimmed = line.trim();
      if (trimmed === "") {
        continue;
      }
      try {
        const parsed = JSON.parse(trimmed) as SourceChunk;
        if (typeof parsed.chunkId === "string" && typeof parsed.text === "string") {
          chunks.push(parsed);
        }
      } catch {
        return null; // 损坏 → 自愈重建信号
      }
    }
    return chunks;
  }

  async writeChunks(projectId: string, sourceId: string, chunks: SourceChunk[]): Promise<void> {
    await mkdir(this.chunksDir(projectId), { recursive: true });
    const body = chunks.map((chunk) => JSON.stringify(chunk)).join("\n") + (chunks.length > 0 ? "\n" : "");
    await writeFileAtomic(this.chunkFilePath(projectId, sourceId), body);
  }

  async removeChunks(projectId: string, sourceId: string): Promise<void> {
    await rm(this.chunkFilePath(projectId, sourceId), { force: true });
  }

  // ---- dense 向量旁车（Derived State；provider/identity 变化即失效）----

  async readVectors(projectId: string, sourceId: string): Promise<VectorFile | null> {
    let raw: string;
    try {
      raw = await readFile(this.vectorFilePath(projectId, sourceId), "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as VectorFile;
      if (
        typeof parsed.provider === "string" &&
        typeof parsed.identity === "string" &&
        Array.isArray(parsed.entries)
      ) {
        return parsed;
      }
    } catch {
      // 损坏的旁车文件 = 缓存失效（重新嵌入），不是错误
    }
    return null;
  }

  async writeVectors(projectId: string, sourceId: string, file: VectorFile): Promise<void> {
    await mkdir(this.chunksDir(projectId), { recursive: true });
    await writeJsonAtomic(this.vectorFilePath(projectId, sourceId), file);
  }

  async removeVectors(projectId: string, sourceId: string): Promise<void> {
    await rm(this.vectorFilePath(projectId, sourceId), { force: true });
  }

  /** 删除某 source 的全部 derived 产物（chunk 文件 + 向量旁车；幂等） */
  async removeSourceArtifacts(projectId: string, sourceId: string): Promise<void> {
    await this.removeChunks(projectId, sourceId);
    await this.removeVectors(projectId, sourceId);
  }

  /** 清空项目全部 derived 产物（rebuild-from-scratch 验收 / 测试用） */
  async removeAll(projectId: string): Promise<void> {
    await rm(this.chunksDir(projectId), { recursive: true, force: true });
  }

  /** 列出 chunks 目录中的 source id（孤儿文件对账用） */
  async listSourceFiles(projectId: string): Promise<string[]> {
    let names: string[];
    try {
      names = await readdir(this.chunksDir(projectId));
    } catch {
      return [];
    }
    const ids = new Set<string>();
    for (const name of names) {
      const match = /^(S\d{3,})\.(jsonl|vectors\.json)$/.exec(name);
      if (match !== null) {
        ids.add(match[1]!);
      }
    }
    return [...ids];
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
