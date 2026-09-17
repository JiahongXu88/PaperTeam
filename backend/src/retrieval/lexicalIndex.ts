/**
 * 进程内 BM25 lexical 索引（M6.4；D-0033——零 Elasticsearch / 零外部索引引擎）。
 *
 * 设计边界：
 * - 单项目规模（几十 source × 数千 chunk）：全内存 posting 统计 + 逐 doc 打分
 *   足够（performance 测试钉住量级，防 O(N²) / 每 query 重建）；
 * - tokenization 用中英兼容 tokenizer（tokenize.ts）——查询与文档同口径；
 * - 排序确定性：score 降序，并列按 chunkId 字典序（无随机 / 无时间因素）；
 * - 增删以 source 为单位（df 计数同步维护），rebuild = 全量重建。
 */

import type { SourceChunk } from "./types.js";
import { tokenizeText } from "./tokenize.js";

const BM25_K1 = 1.2;
const BM25_B = 0.75;

interface IndexedDoc {
  chunk: SourceChunk;
  tf: Map<string, number>;
  length: number;
}

export interface LexicalHit {
  chunkId: string;
  score: number;
}

export class LexicalIndex {
  private readonly docs = new Map<string, IndexedDoc>();
  private readonly sourceDocs = new Map<string, Set<string>>();
  private readonly df = new Map<string, number>();
  private totalLength = 0;

  get size(): number {
    return this.docs.size;
  }

  /** 批量加入一个 source 的 chunks（重复 chunkId 幂等跳过） */
  addSource(sourceId: string, chunks: SourceChunk[]): void {
    for (const chunk of chunks) {
      if (this.docs.has(chunk.chunkId)) {
        continue;
      }
      // 章节标题一并进 token 流（标题常是查询词——"method"/"results"；
      // 只影响索引打分，chunk.text 本身保持纯正文）
      const tokens = tokenizeText(`${chunk.sectionTitle}
${chunk.subsection ?? ""}
${chunk.text}`);
      const tf = new Map<string, number>();
      for (const token of tokens) {
        tf.set(token, (tf.get(token) ?? 0) + 1);
      }
      this.docs.set(chunk.chunkId, { chunk, tf, length: tokens.length });
      const ids = this.sourceDocs.get(sourceId) ?? new Set<string>();
      ids.add(chunk.chunkId);
      this.sourceDocs.set(sourceId, ids);
      this.totalLength += tokens.length;
      for (const term of tf.keys()) {
        this.df.set(term, (this.df.get(term) ?? 0) + 1);
      }
    }
  }

  /** 移除一个 source 的全部 docs（df 同步递减） */
  removeSource(sourceId: string): void {
    const ids = this.sourceDocs.get(sourceId);
    if (ids === undefined) {
      return;
    }
    for (const chunkId of ids) {
      const doc = this.docs.get(chunkId);
      if (doc === undefined) {
        continue;
      }
      for (const term of doc.tf.keys()) {
        const count = this.df.get(term);
        if (count !== undefined) {
          if (count <= 1) {
            this.df.delete(term);
          } else {
            this.df.set(term, count - 1);
          }
        }
      }
      this.totalLength -= doc.length;
      this.docs.delete(chunkId);
    }
    this.sourceDocs.delete(sourceId);
  }

  getChunk(chunkId: string): SourceChunk | undefined {
    return this.docs.get(chunkId)?.chunk;
  }

  chunksOfSource(sourceId: string): SourceChunk[] {
    const ids = this.sourceDocs.get(sourceId);
    if (ids === undefined) {
      return [];
    }
    const out: SourceChunk[] = [];
    for (const chunkId of ids) {
      const doc = this.docs.get(chunkId);
      if (doc !== undefined) {
        out.push(doc.chunk);
      }
    }
    return out.sort((a, b) => a.ordinal - b.ordinal);
  }

  sourceIds(): string[] {
    return [...this.sourceDocs.keys()];
  }

  /**
   * BM25 检索。predicate = metadata filter（filter 在打分前生效——过滤集外
   * 的 doc 不参与名次）。返回确定性排序的 topN。
   */
  search(
    query: string,
    options: {
      predicate?: (chunk: SourceChunk) => boolean;
      topN: number;
    },
  ): LexicalHit[] {
    const queryTokens = tokenizeText(query);
    if (queryTokens.length === 0 || this.docs.size === 0) {
      return [];
    }
    const queryTerms = [...new Set(queryTokens)];
    const avgLength = this.totalLength / this.docs.size;
    const hits: LexicalHit[] = [];
    for (const doc of this.docs.values()) {
      if (options.predicate !== undefined && !options.predicate(doc.chunk)) {
        continue;
      }
      let score = 0;
      let matched = 0;
      for (const term of queryTerms) {
        const frequency = doc.tf.get(term);
        if (frequency === undefined) {
          continue;
        }
        matched += 1;
        const docFrequency = this.df.get(term) ?? 0;
        const idf = Math.log(1 + (this.docs.size - docFrequency + 0.5) / (docFrequency + 0.5));
        const denominator = frequency + BM25_K1 * (1 - BM25_B + (BM25_B * doc.length) / (avgLength || 1));
        score += idf * (frequency * (BM25_K1 + 1)) / denominator;
      }
      if (matched > 0) {
        hits.push({ chunkId: doc.chunk.chunkId, score });
      }
    }
    hits.sort((a, b) => b.score - a.score || (a.chunkId < b.chunkId ? -1 : 1));
    return hits.slice(0, options.topN);
  }
}

/** 余弦相似度（dense 通道；向量已 L2 归一化时即点积，此处保持通用实现） */
export function cosineSimilarity(a: Float32Array, b: Float32Array): number {
  const length = Math.min(a.length, b.length);
  let dot = 0;
  let normA = 0;
  let normB = 0;
  for (let i = 0; i < length; i += 1) {
    dot += a[i]! * b[i]!;
    normA += a[i]! * a[i]!;
    normB += b[i]! * b[i]!;
  }
  if (normA === 0 || normB === 0) {
    return 0;
  }
  return dot / (Math.sqrt(normA) * Math.sqrt(normB));
}
