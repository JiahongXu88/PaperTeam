/**
 * SourceChunk 确定性生成（M6.4 chunk 管线纯函数部分）。
 *
 * 策略（指令冻结：不做纯 N 字符硬切）：
 *   section（不跨章节）→ 段落/块 → 句子 → 词窗口兜底（超长单元）；
 *   target/max/overlap 三档 token 预算（estimateTextTokens 同口径——与
 *   Context Budget Packing 共用同一估算，不引入 tokenizer 依赖）。
 *
 * 稳定 ID（D-0036）："<sourceId>:<sectionId>:<节内序号>:<内容hash10>"。
 * - 内容不变 → 边界不变 → chunkId 逐字节不变（rebuild 幂等）；
 * - 某节内容变化 → 只有该节受影响边界之后的 chunk 变化，其他节 ID 不变
 *   （序号是节内序号，不受前置章节 chunk 数量漂移影响）；
 * - 全局 ordinal 只用于邻近判定与展示，不参与 ID。
 */

import { estimateTextTokens } from "../runtime/pi/contextBudget.js";
import { sha256Hex } from "../util/hash.js";
import type { SourceChunk } from "./types.js";

export interface ChunkBuildOptions {
  /** 目标 chunk 大小（token 估算；默认 400） */
  targetTokens: number;
  /** 单 chunk 硬上限（默认 600；超长单元按句/词窗口切） */
  maxTokens: number;
  /** 相邻 chunk 尾部重叠（默认 60；同节内携带；0 = 关闭） */
  overlapTokens: number;
}

export const DEFAULT_CHUNK_OPTIONS: ChunkBuildOptions = {
  targetTokens: 400,
  maxTokens: 600,
  overlapTokens: 60,
};

/**
 * 配置合法性（函数级下限比 env 配置面更宽：测试与程序化调用可用小预算；
 * PAPERTEAM_RETRIEVAL_* 的 env 面另守 100/200 下限，见 config.ts）。
 */
export function validateChunkOptions(options: ChunkBuildOptions): void {
  if (!Number.isInteger(options.targetTokens) || options.targetTokens < 40 || options.targetTokens > 2000) {
    throw new Error(`chunkTargetTokens 必须是 40-2000 的整数（当前 ${options.targetTokens}）`);
  }
  if (!Number.isInteger(options.maxTokens) || options.maxTokens < 80 || options.maxTokens > 4000) {
    throw new Error(`chunkMaxTokens 必须是 80-4000 的整数（当前 ${options.maxTokens}）`);
  }
  if (options.maxTokens < options.targetTokens) {
    throw new Error(`chunkMaxTokens（${options.maxTokens}）不得小于 chunkTargetTokens（${options.targetTokens}）`);
  }
  if (!Number.isInteger(options.overlapTokens) || options.overlapTokens < 0 || options.overlapTokens > 500) {
    throw new Error(`chunkOverlapTokens 必须是 0-500 的整数（当前 ${options.overlapTokens}）`);
  }
  if (options.overlapTokens >= options.targetTokens) {
    throw new Error(`chunkOverlapTokens（${options.overlapTokens}）必须小于 chunkTargetTokens（${options.targetTokens}）`);
  }
}

/** 已归属章节的文本单元（page 来自解析层；退化路径无页码——不伪造） */
export interface SectionUnit {
  text: string;
  page?: number;
}

/** 单个章节（含其全部单元，文档顺序） */
export interface ResolvedSection {
  sectionId: string;
  title: string;
  /** ≥2 表示小节（chunk.subsection 依据） */
  level: number;
  units: SectionUnit[];
}

export interface BuiltChunks {
  chunks: SourceChunk[];
  /** sectionId → title（stats / 诊断） */
  sectionTitles: Map<string, string>;
}

/**
 * sections → SourceChunk[]（确定性；同一输入恒同一输出）。
 * 输入需已按文档顺序排列；projectId/sourceId 由调用方（SourceChunker）绑定。
 */
export function buildSourceChunks(params: {
  projectId: string;
  sourceId: string;
  sections: ResolvedSection[];
  options: ChunkBuildOptions;
  now: () => Date;
}): BuiltChunks {
  const { projectId, sourceId, sections, options, now } = params;
  validateChunkOptions(options);
  const generatedAt = now().toISOString();
  const chunks: SourceChunk[] = [];
  const sectionTitles = new Map<string, string>();

  for (const section of sections) {
    sectionTitles.set(section.sectionId, section.title);
    const units = section.units.filter((unit) => unit.text.trim() !== "");
    if (units.length === 0) {
      continue;
    }
    // 超长单元先切成 ≤max 的句/词窗口（overlap 在窗口间同样生效）
    const normalized: SectionUnit[] = [];
    for (const unit of units) {
      normalized.push(...splitOversizedUnit(unit, options));
    }
    let current: { parts: string[]; tokens: number; pageStart?: number; pageEnd?: number } | null = null;
    let carry = "";
    let ordinalInSection = 0;

    const flush = () => {
      if (current === null) {
        return;
      }
      const text = current.parts.join("\n\n");
      ordinalInSection += 1;
      const contentHash = sha256Hex(text).slice(0, 10);
      chunks.push({
        chunkId: `${sourceId}:${section.sectionId}:${String(ordinalInSection).padStart(4, "0")}:${contentHash}`,
        projectId,
        sourceId,
        sectionId: section.sectionId,
        sectionTitle: section.title,
        ...(section.level >= 2 ? { subsection: section.title } : {}),
        ...(current.pageStart !== undefined ? { pageStart: current.pageStart, pageEnd: current.pageEnd } : {}),
        ordinal: chunks.length + 1,
        text,
        charCount: text.length,
        tokenCount: estimateTextTokens(text),
        contentHash,
        generatedAt,
      });
      carry =
        options.overlapTokens > 0 ? tailOverlap(text, options.overlapTokens) : "";
      current = null;
    };

    for (const unit of normalized) {
      const unitTokens = estimateTextTokens(unit.text);
      if (current === null) {
        // 同节内新 chunk：先带上一 chunk 的尾部重叠（上限放宽到 max + overlap
        // ——重叠是预算内的受控重复，不能因单元大而静默丢失）
        const carryTokens = carry === "" ? 0 : estimateTextTokens(carry);
        const parts =
          carry !== "" && carryTokens + unitTokens <= options.maxTokens + options.overlapTokens
            ? [carry, unit.text]
            : [unit.text];
        current = {
          parts,
          tokens: estimateTextTokens(parts.join("\n\n")),
          ...(unit.page !== undefined ? { pageStart: unit.page, pageEnd: unit.page } : {}),
        };
        continue;
      }
      const merged = current.tokens + unitTokens + 2;
      if (current.tokens < options.targetTokens && merged <= options.maxTokens) {
        current.parts.push(unit.text);
        current.tokens = merged;
        if (unit.page !== undefined) {
          current.pageEnd = unit.page;
          if (current.pageStart === undefined) {
            current.pageStart = unit.page;
          }
        }
        continue;
      }
      flush();
      // flush 已更新 carry（同上：max + overlap 放宽口径）
      const carryTokens = carry === "" ? 0 : estimateTextTokens(carry);
      const parts =
        carry !== "" && carryTokens + unitTokens <= options.maxTokens + options.overlapTokens
          ? [carry, unit.text]
          : [unit.text];
      current = {
        parts,
        tokens: estimateTextTokens(parts.join("\n\n")),
        ...(unit.page !== undefined ? { pageStart: unit.page, pageEnd: unit.page } : {}),
      };
    }
    flush();
  }
  return { chunks, sectionTitles };
}

/** 超长单元（> max）→ 句子窗口；超长句 → 词窗口。全部 ≤ max（不含 overlap）。 */
function splitOversizedUnit(unit: SectionUnit, options: ChunkBuildOptions): SectionUnit[] {
  const total = estimateTextTokens(unit.text);
  if (total <= options.maxTokens) {
    return [unit];
  }
  // 先切句；超长句再按词切（保持文档顺序的扁平片段序列）
  const pieces: string[] = [];
  for (const sentence of splitSentences(unit.text)) {
    if (estimateTextTokens(sentence) <= options.maxTokens) {
      pieces.push(sentence);
      continue;
    }
    let words: string[] = [];
    let wordTokens = 0;
    for (const word of sentence.split(/\s+/).filter(Boolean)) {
      const wordTokenCount = estimateTextTokens(word);
      if (wordTokens + wordTokenCount > options.maxTokens && words.length > 0) {
        pieces.push(words.join(" "));
        words = [];
        wordTokens = 0;
      }
      words.push(word);
      wordTokens += wordTokenCount;
    }
    if (words.length > 0) {
      pieces.push(words.join(" "));
    }
  }
  // 片段 → ≤max 窗口（窗口间 overlap 由外层 build 循环统一携带，避免双重重叠）
  const out: SectionUnit[] = [];
  let window: string[] = [];
  let windowTokens = 0;
  for (const piece of pieces) {
    const pieceTokens = estimateTextTokens(piece);
    if (windowTokens + pieceTokens > options.maxTokens && window.length > 0) {
      out.push(joinWindow(window, unit));
      window = [];
      windowTokens = 0;
    }
    window.push(piece);
    windowTokens += pieceTokens;
  }
  if (window.length > 0) {
    out.push(joinWindow(window, unit));
  }
  return out;
}

function joinWindow(parts: string[], unit: SectionUnit): SectionUnit {
  return { text: parts.join(" "), ...(unit.page !== undefined ? { page: unit.page } : {}) };
}

/** 句子切分（中英文终点标点；无终点标点的按行） */
export function splitSentences(text: string): string[] {
  const normalized = text.replace(/\s+/g, " ").trim();
  if (normalized === "") {
    return [];
  }
  const matches = normalized.match(/[^.!?。！？；;]+(?:[.!?。！？；;]+|$)/g);
  if (matches === null) {
    return [normalized];
  }
  return matches.map((entry) => entry.trim()).filter((entry) => entry !== "");
}

/**
 * 从文本尾部取 ≈overlapTokens 的重叠（句子对齐；单句超预算时句内按词截尾）。
 * 确定性：同文本恒同结果。
 */
export function tailOverlap(text: string, overlapTokens: number): string {
  if (overlapTokens <= 0 || text.trim() === "") {
    return "";
  }
  const sentences = splitSentences(text);
  const picked: string[] = [];
  let tokens = 0;
  for (let i = sentences.length - 1; i >= 0; i -= 1) {
    const sentence = sentences[i]!;
    const sentenceTokens = estimateTextTokens(sentence);
    if (tokens + sentenceTokens > overlapTokens && picked.length > 0) {
      break;
    }
    picked.unshift(sentence);
    tokens += sentenceTokens;
    if (tokens >= overlapTokens) {
      break;
    }
  }
  if (picked.length === 0) {
    return tailWords(text, overlapTokens);
  }
  if (tokens > overlapTokens) {
    // 单句就超预算：句内按词截尾，保证 overlap 不吞掉整个单元
    return tailWords(picked.join(" "), overlapTokens);
  }
  return picked.join(" ");
}

/** 从文本尾部按词取 ≈budget token 的截尾（无标点可依时的兜底） */
function tailWords(text: string, budget: number): string {
  const words = text.split(/\s+/).filter(Boolean);
  const tail: string[] = [];
  let wordTokens = 0;
  for (let i = words.length - 1; i >= 0; i -= 1) {
    const word = words[i]!;
    const wordTokenCount = estimateTextTokens(word);
    if (wordTokens + wordTokenCount > budget && tail.length > 0) {
      break;
    }
    tail.unshift(word);
    wordTokens += wordTokenCount;
    if (wordTokens >= budget) {
      break;
    }
  }
  return tail.join(" ");
}

/**
 * 段落切分：空行优先；结果只剩一个含换行的段（无空行分隔的输入）时退按
 * 单行切——builtin PDF 文本层 / 无空行 plain text 的真实形态。
 */
export function splitParagraphs(text: string): string[] {
  const paragraphs = text
    .split(/\n\s*\n/)
    .map((entry) => entry.replace(/[ \t]+/g, " ").trim())
    .filter((entry) => entry !== "");
  if (paragraphs.length === 1 && paragraphs[0]!.includes("\n")) {
    return paragraphs[0]!
      .split("\n")
      .map((entry) => entry.trim())
      .filter((entry) => entry !== "");
  }
  return paragraphs;
}

/** 短 hash（测试与诊断直接可用；与 chunkId 组成部同口径） */
export function shortContentHash(text: string): string {
  return sha256Hex(text).slice(0, 10);
}
