/**
 * 确定性 EmbeddingProvider（测试 / 基准用；M6.4 无真实 vendor 接入）。
 *
 * 事实源：pi-ai / Pi model catalog 无 embedding API（M6.4 盘点结论）——按
 * 指令十九，M6.4 只交付 EmbeddingProvider 抽象 + 确定性实现 + optional 装配，
 * 不新增外部账号体系。生产默认不注册 → lexical-only 健康运行（红线）。
 *
 * DeterministicEmbeddingProvider：token 哈希袋向量（tokenizeText 同口径）。
 * 语义能力 ≈ 词重叠相似度——**它验证的是 dense 通道 / 混合 / 缓存的机制
 * 正确性，不代表真实 embedding 的语义召回**（benchmark 如实记录该边界）。
 * 同文本恒同向量（fnv1a 确定性，无随机）。
 */

import type { EmbeddingProvider } from "./types.js";
import { tokenizeText } from "./tokenize.js";

/** 32-bit FNV-1a（无依赖确定性哈希） */
function fnv1a(text: string): number {
  let hash = 0x811c9dc5;
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return hash >>> 0;
}

export interface DeterministicEmbeddingOptions {
  /** 向量维度（默认 256） */
  dimensions?: number;
  /** identity 覆盖（缓存失效测试用：改 identity = 旧向量全部失效） */
  identity?: string;
  /** 注入失败（degradation 测试用） */
  failMode?: () => boolean;
}

export class DeterministicEmbeddingProvider implements EmbeddingProvider {
  readonly name: string;
  readonly dimensions: number;
  readonly identity: string;
  private readonly failMode?: () => boolean;

  constructor(options: DeterministicEmbeddingOptions = {}) {
    this.name = "deterministic-hash";
    this.dimensions = options.dimensions ?? 256;
    this.identity = options.identity ?? `deterministic-hash:fnv1a:${this.dimensions}`;
    this.failMode = options.failMode;
  }

  private embedOne(text: string): Float32Array {
    const vector = new Float32Array(this.dimensions);
    for (const token of tokenizeText(text)) {
      const index = fnv1a(token) % this.dimensions;
      vector[index] = (vector[index] ?? 0) + 1;
    }
    let norm = 0;
    for (let i = 0; i < this.dimensions; i += 1) {
      norm += vector[i]! * vector[i]!;
    }
    if (norm > 0) {
      const scale = 1 / Math.sqrt(norm);
      for (let i = 0; i < this.dimensions; i += 1) {
        vector[i] = vector[i]! * scale;
      }
    }
    return vector;
  }

  async embedDocuments(texts: string[], _signal?: AbortSignal): Promise<Float32Array[]> {
    void _signal;
    if (this.failMode?.()) {
      throw new Error("deterministic embedding: injected failure");
    }
    return texts.map((text) => this.embedOne(text));
  }

  async embedQuery(text: string, _signal?: AbortSignal): Promise<Float32Array> {
    void _signal;
    if (this.failMode?.()) {
      throw new Error("deterministic embedding: injected failure");
    }
    return this.embedOne(text);
  }
}
