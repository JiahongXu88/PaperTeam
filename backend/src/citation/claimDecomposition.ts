/**
 * Atomic Claim 拆解 + Citation Group 绑定规划（v4 语义核验的前置步骤）。
 *
 * 旧模型把「整个句子」绑定到句中每一条引用（sentence × reference 笛卡尔积），
 * 复合句（如 "RNN、LSTM [13]、GRU [7] 已被确立为 sequence modeling 的 SOTA，
 * 广泛用于 machine translation [35, 2, 5]"）会被逐篇要求支撑全部命题——
 * 明显的错误验证模型。新模型：
 *
 *   Sentence → Atomic Claims（原子论断，可独立判断真假的单一命题）
 *            → 每条原子论断绑定其 citation groups（引用组，共同支撑）
 *            → (atomic claim × citation group) 一条核验记录
 *
 * 拆解分两条路径：
 *   model    结构化模型拆解（bounded：仅复合句触发、批量调用、有版本缓存）；
 *            每句独立容错——解析失败的句子单独走 fallback，不拖垮整批
 *   fallback 确定性兜底：整句作为单条论断（去掉引用标记），绑定句内全部
 *            citation group。任何模型故障 / 超预算都退到这里，永远可用
 *
 * 硬纪律：拆解只做「句子 → 命题」的重组，不得引入原文没有的信息；
 * 绑定按标记位置（紧跟子论断的标记支撑该子论断），不猜。
 */

import { sha256Hex } from "../util/hash.js";
import type { CitationCallout, ReferenceEntry } from "./integrity.js";

/** 拆解算法版本（进缓存指纹：规则变化后旧拆解自动失效） */
export const CLAIM_DECOMPOSITION_VERSION = 1;

/** 批量拆解：一次模型调用处理的句子数上限（prompt 体量控制） */
export const DECOMPOSITION_BATCH_SIZE = 8;

/** 单句长度上限（超长截断，防 PDF 解析事故撑爆 prompt） */
const SENTENCE_MAX_CHARS = 800;

/** 原子论断文本长度上限 */
const CLAIM_MAX_CHARS = 400;

/**
 * 一个句子（可能含多个 citation group）的 callout 集合。
 * 同一句子里每个方括号标记 = 一个 group（[13] / [7] / [35, 2, 5] 三个组）。
 */
export interface SentenceCalloutGroup {
  /** 稳定 key（chunk + 句子指纹；持久化缓存 id 用） */
  sentenceKey: string;
  sentence: string;
  chunkId: string;
  sectionId: string;
  page: number;
  /** 句内 citation group（callout 原样），保持出现顺序 */
  groups: CitationCallout[];
}

/** 一条原子论断（拆解产物） */
export interface AtomicClaimDraft {
  /** 句内序号（1 起） */
  claimIndex: number;
  /** 原子论断文本（无引用标记） */
  claimText: string;
  /** 绑定的 citation group（citationId 列表；空 = 兜底绑定句内全部组） */
  citationIds: string[];
}

/** 一个句子的拆解规划 */
export interface SentenceClaimPlan {
  sentenceKey: string;
  /** model = 结构化拆解；fallback = 确定性兜底（整句单论断） */
  method: "model" | "fallback";
  claims: AtomicClaimDraft[];
  /** 规划时的拆解版本（缓存复用判据） */
  decompositionVersion: number;
}

/** callout 的原始标记文本（v3 起提取器写入；旧记录按 relation labels 重建） */
export function calloutRawText(callout: CitationCallout): string {
  if (callout.rawText !== undefined && callout.rawText !== "") {
    return callout.rawText;
  }
  const labels = callout.references.map((relation) => relation.label).join(", ");
  return callout.style === "numeric" ? `[${labels}]` : `(${labels})`;
}

/**
 * callout 按句子归组：同一 chunk 中句子文本相同的 callout 属于同一句
 * （sentenceAround 对句内所有标记产生相同句子串）。
 */
export function groupCalloutsBySentence(callouts: CitationCallout[]): SentenceCalloutGroup[] {
  const byKey = new Map<string, SentenceCalloutGroup>();
  for (const callout of callouts) {
    const sentence = callout.sentence.replace(/\s+/g, " ").trim();
    if (sentence === "") {
      continue;
    }
    const key = `${callout.chunkId}::${sentence}`;
    let group = byKey.get(key);
    if (group === undefined) {
      group = {
        sentenceKey: `S${sha256Hex(key).slice(0, 24)}`,
        sentence,
        chunkId: callout.chunkId,
        sectionId: callout.sectionId,
        page: callout.page,
        groups: [],
      };
      byKey.set(key, group);
    }
    if (!group.groups.some((existing) => existing.citationId === callout.citationId)) {
      group.groups.push(callout);
    }
  }
  return [...byKey.values()];
}

/**
 * 是否需要结构化拆解（确定性触发条件，控制模型成本）：
 * 句内有多个 citation group、或句子是复合句（长 / 含从句连接词 / 分号）。
 * 单 group 的短简单句本身就是原子论断——直接 fallback，零模型调用。
 */
export function needsDecomposition(sentence: string, groupCount: number): boolean {
  if (groupCount >= 2) {
    return true;
  }
  const compact = sentence.replace(/\s+/g, " ").trim();
  if (compact.length >= 160) {
    return true;
  }
  // 复合句信号：分号 / 冒号 / 并列或转折连接词（中英）
  return /;\s|:\s|\b(?:and|while|whereas|but|however|moreover)\b\s|，并且|，而|，但|；|：/.test(
    compact,
  );
}

/** 引用标记替换为无歧义 token：⟦CT003⟧（模型绑定引用组用） */
export function tagMarkers(group: SentenceCalloutGroup): string {
  let text = group.sentence;
  for (const callout of group.groups) {
    const raw = calloutRawText(callout);
    const token = `⟦${callout.citationId}⟧`;
    const at = text.indexOf(raw);
    if (at >= 0) {
      text = text.slice(0, at) + token + text.slice(at + raw.length);
    } else {
      // 句子串与 rawText 有归一化差异：退化为整体替换不了时附加在句尾备注
      text = `${text} ${token}`;
    }
  }
  return text;
}

/** 清洗论断文本：去 marker token / 数字标记 / 行首 PDF 残留（arXiv 戳、章节号），压空白 */
export function cleanClaimText(text: string): string {
  let out = text
    .replace(/⟦[A-Za-z0-9_-]+⟧/g, "")
    .replace(/\[\d{1,3}(?:\s*[,–-]\s*\d{1,3})*\]/g, "")
    // 行首残留：arXiv 水印尾巴（如 "CL] 2 Aug 2023"）与章节编号（如 "1 Introduction"）
    .replace(/^\s*[A-Za-z]{1,4}\]\s*\d{1,2}\s+[A-Za-z]{3,9}\s+\d{4}\s+/, "")
    .replace(/^\s*\d{1,2}(?:\.\d{1,2})*\s+(?=[A-Z一-鿿])/, "")
    .replace(/\s+/g, " ")
    // 去标记后遗留的悬空标点间距（"strong ." → "strong."）
    .replace(/\s+([.,;:!?%)])/g, "$1")
    .replace(/\(\s+/g, "(")
    .trim();
  if (out.length > CLAIM_MAX_CHARS) {
    out = out.slice(0, CLAIM_MAX_CHARS).trim();
  }
  return out;
}

/** 确定性兜底规划：整句（去标记）= 单条论断，绑定句内全部 citation group */
export function fallbackPlan(group: SentenceCalloutGroup): SentenceClaimPlan {
  const citationIds = group.groups.map((callout) => callout.citationId);
  return {
    sentenceKey: group.sentenceKey,
    method: "fallback",
    decompositionVersion: CLAIM_DECOMPOSITION_VERSION,
    claims: [
      {
        claimIndex: 1,
        claimText: cleanClaimText(group.sentence),
        citationIds,
      },
    ],
  };
}

/** 批量拆解 prompt（一次调用处理 ≤ DECOMPOSITION_BATCH_SIZE 句） */
export function buildDecompositionPrompt(batch: SentenceCalloutGroup[]): string {
  const sentenceBlocks = batch
    .map((group) => {
      const groupList = group.groups.map((callout) => calloutRawText(callout)).join(" ");
      return `[${group.sentenceKey}]\n标记说明：${groupList}\n句子：${tagMarkers(group).slice(0, SENTENCE_MAX_CHARS)}`;
    })
    .join("\n\n");
  return [
    "你是论文论断拆解器。把下面带引用标记（形如 ⟦CT003⟧）的句子拆成原子论断（atomic claims），并标注每条论断由哪些引用标记支撑。",
    "",
    "规则：",
    "1. 每条原子论断 = 一个可独立判断真假的单一命题；复合句（多个主语/多个谓语/多个并列成分）必须拆开；",
    "2. 忠于原文：只重组句内已有信息，不得添加、推断或改写含义；",
    "3. 拆分共享成分时要补全主语/谓语（如 “LSTM 与 GRU 已被确立为 SOTA” 拆成 “LSTM 已被确立为 SOTA” 和 “GRU 已被确立为 SOTA”），使每条论断独立可读；",
    "4. 绑定：引用标记通常支撑它紧邻（其后或其前）的子论断；一条论断可绑定多个标记；一条论断确实没有可绑定的标记时绑定句内全部标记；",
    "5. 论断文本不包含 ⟦…⟧ 标记和 [数字] 引用编号；",
    `6. 每句最多拆 6 条论断；简单句保持 1 条即可，不要为拆而拆。`,
    "",
    "只输出一个 JSON 对象（无围栏）：",
    '{"sentences":[{"id":"S…","claims":[{"text":"原子论断","markers":["CT003"]}]}]}',
    "",
    sentenceBlocks,
  ].join("\n");
}

/** 拆解输出解析：单句解析失败返回 null（该句走 fallback，不拖垮整批） */
export function parseDecompositionSentence(
  raw: unknown,
  group: SentenceCalloutGroup,
): AtomicClaimDraft[] | null {
  if (typeof raw !== "object" || raw === null) {
    return null;
  }
  const claimsRaw = (raw as { claims?: unknown }).claims;
  if (!Array.isArray(claimsRaw) || claimsRaw.length === 0 || claimsRaw.length > 6) {
    return null;
  }
  const validIds = new Set(group.groups.map((callout) => callout.citationId));
  const allIds = group.groups.map((callout) => callout.citationId);
  const claims: AtomicClaimDraft[] = [];
  for (const item of claimsRaw) {
    if (typeof item !== "object" || item === null) {
      return null;
    }
    const text = cleanClaimText(String((item as { text?: unknown }).text ?? ""));
    if (text.length < 8) {
      return null; // 过短 = 拆解产物不可用（整句作废走 fallback，不用残片）
    }
    const markersRaw = (item as { markers?: unknown }).markers;
    const markers = Array.isArray(markersRaw)
      ? markersRaw.map(String).filter((id) => validIds.has(id))
      : [];
    claims.push({
      claimIndex: claims.length + 1,
      claimText: text,
      // 绑定为空 / 全部非法 → 兜底绑全部组（不猜丢失绑定）
      citationIds: markers.length > 0 ? [...new Set(markers)] : allIds,
    });
  }
  // 有效性检查：句内每个 citation group 至少被一条论断绑定（未被绑定的组
  // 补绑到最后一条论断——组不能凭空消失）
  const bound = new Set(claims.flatMap((claim) => claim.citationIds));
  const unbound = allIds.filter((id) => !bound.has(id));
  if (unbound.length > 0 && claims.length > 0) {
    const last = claims[claims.length - 1]!;
    last.citationIds = [...new Set([...last.citationIds, ...unbound])];
  }
  return claims;
}

/** 模型拆解结果按句子组装成 plan（id 不匹配 / 缺失的句子由调用方走 fallback） */
export function planFromModelOutput(
  group: SentenceCalloutGroup,
  claims: AtomicClaimDraft[],
): SentenceClaimPlan {
  return {
    sentenceKey: group.sentenceKey,
    method: "model",
    decompositionVersion: CLAIM_DECOMPOSITION_VERSION,
    claims,
  };
}

/** 供规划层判断：句内是否存在任何「可判证据」的引用组（决定是否值得拆解） */
export function sentenceHasJudgeableGroup(
  group: SentenceCalloutGroup,
  references: ReferenceEntry[],
  hasEvidence: (referenceId: string) => boolean,
): boolean {
  const referenceIds = new Set(references.map((reference) => reference.referenceId));
  return group.groups.some((callout) =>
    callout.references.some(
      (relation) =>
        relation.status === "resolved" &&
        relation.referenceId !== undefined &&
        referenceIds.has(relation.referenceId) &&
        hasEvidence(relation.referenceId),
    ),
  );
}
