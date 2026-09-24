/**
 * Deterministic Bibliography（M9.5）。
 *
 * 分工纪律（本文件是唯一事实源）：
 * - LLM 只负责论文内容与引用意图（Researcher 的 bibliography 字段是「引用
 *   意图 + 元数据回忆」，不是最终引用表）；
 * - 代码负责 metadata normalization、citation key、BibTeX rendering——
 *   同输入永远同输出，零随机、零时钟、零 LLM。
 *
 * 数据边界（不复制第二套 metadata）：
 *   SourceItem（identity + metadata + versionType）
 *     → BibliographySeed（判等键 + 展示字段的最小投影）
 *     → assignCitationKeys（确定性 key + 冲突消解）
 *     → CanonicalBibliographyEntry
 *     → renderBibTeX（references.bib 字节）
 * Evidence → key 追溯不落存储：EvidenceRecord.source.sourceId 在使用点
 * 经 resolveEvidenceCitationKey 解析（sourceId 精确 → DOI/标题 降级），
 * 不在 EvidenceRecord 上复制 citationKey。
 */

import type { EvidenceRecord } from "../evidence/EvidenceStore.js";
import { EvidenceSelectionService } from "../evidence/EvidenceSelectionService.js";
import type { SourceItem } from "../sources/SourceStore.js";
import { firstAuthorFamily, identityFromMetadata, identityKey } from "../sources/identity.js";
import type { BibliographyEntryInput } from "../agents/ResearcherService.js";
import { canonicalTitleTokens, compactTitle, titleSimilarity } from "./referenceText.js";

/** M9.5 覆盖的 BibTeX 条目类型（刻意最小：不设计全类型系统） */
export type DeterministicBibType = "article" | "inproceedings" | "misc";

/** 渲染输入（ManuscriptService.writeBibliography 的条目形状） */
export interface BibRenderEntry {
  key: string;
  title: string;
  authors?: string[];
  year?: number;
  venue?: string;
  doi?: string;
  url?: string;
  arxivId?: string;
  type?: DeterministicBibType;
  /** 追溯：SourceStore 条目 id（渲染为 sourceId 字段；BST 忽略未知字段） */
  sourceId?: string;
}

/** 正式 bibliography 条目（key 由 assignCitationKeys 填充） */
export interface CanonicalBibliographyEntry extends BibRenderEntry {
  type: DeterministicBibType;
  /** 判等键（identity.ts identityKey；artifact 条目用归一标题代替） */
  identityKey: string;
  origin: "source-library" | "artifact";
}

/** assignCitationKeys 的输入（无 key——key 是派生值，调用方不得自带） */
export type BibliographySeed = Omit<CanonicalBibliographyEntry, "key">;

// ---- Citation key 确定性策略 ----

/** key 各段长度上限（防超长 key 撑爆 \cite 行） */
const KEY_FAMILY_MAX = 24;
const KEY_TITLE_WORD_MAX = 14;
const KEY_TOTAL_MAX = 48;

/** 选 title 词时跳过的功能词（canonicalTitleTokens 已去首冠词） */
const KEY_TITLE_STOPWORDS = new Set([
  "a", "an", "the", "on", "of", "for", "and", "or", "to", "in", "with",
  "toward", "towards", "via", "is", "are", "as", "at", "by", "from", "using",
]);

/** ASCII 化段（cite key 字符集 = [a-z0-9]；非 ASCII 作者/标题词降级丢弃） */
function asciiSegment(value: string): string {
  return value.normalize("NFKD").replace(/[^a-zA-Z0-9]/g, "").toLowerCase();
}

/** title 的第一个可用 key 词：跳过功能词，取首个 ≥2 字符的 ASCII token */
function keyTitleWord(title: string | undefined): string {
  const tokens = canonicalTitleTokens(title ?? "");
  for (const token of tokens) {
    const ascii = asciiSegment(token);
    if (ascii.length < 2 || KEY_TITLE_STOPWORDS.has(ascii)) {
      continue;
    }
    return ascii.slice(0, KEY_TITLE_WORD_MAX);
  }
  // 全部 token 都不可用（纯中文标题等）：退到任一 ASCII 字符；再不行交空
  for (const token of tokens) {
    const ascii = asciiSegment(token);
    if (ascii !== "") {
      return ascii.slice(0, KEY_TITLE_WORD_MAX);
    }
  }
  return "";
}

/**
 * 基础 citation key（不含冲突后缀）：`familyYEARtitleWord`。
 * - family 缺失 / 非 ASCII → titleWord 顶替 author 段；
 * - year 缺失 → "nd"（no date）；
 * - 全部缺失 → "source" 兜底（graceful fallback，不抛错）。
 */
export function baseCitationKey(input: {
  authors?: string[];
  year?: number;
  title?: string;
}): string {
  const titleWord = keyTitleWord(input.title);
  const familyRaw = firstAuthorFamily(input.authors);
  const family = familyRaw !== undefined ? asciiSegment(familyRaw) : "";
  const yearSegment =
    typeof input.year === "number" && Number.isInteger(input.year) ? String(input.year) : "nd";
  // 家族段缺失（无作者 / 非 ASCII 姓名）→ 标题词顶替且不再重复拼接标题词
  const raw =
    family !== ""
      ? `${family.slice(0, KEY_FAMILY_MAX)}${yearSegment}${titleWord}`
      : titleWord !== ""
        ? `${titleWord}${yearSegment}`
        : `source${yearSegment}`;
  const key = raw.replace(/[^a-z0-9]/g, "").slice(0, KEY_TOTAL_MAX);
  return key.length >= 2 ? key : `${key}x`.slice(0, 2);
}

/** 冲突后缀字母序列：0→a、1→b、…、25→z、26→aa、27→ab（确定性 base26） */
function suffixFor(index: number): string {
  let value = index;
  let suffix = "";
  do {
    suffix = String.fromCharCode(97 + (value % 26)) + suffix;
    value = Math.floor(value / 26);
  } while (value > 0);
  return suffix;
}

/**
 * 为 seed 集合分配确定性 citation key：
 * - 同 identityKey 去重（source-library 优先于 artifact；同 origin 按 sourceId 稳定序）；
 * - 基础 key 相同的多条目（同作者同年）：按 identityKey 排序追加 a/b/c… 后缀，
 *   单条目无后缀——wang2024a / wang2024b 的确定性行为；
 * - 输出按 key 排序（文件渲染顺序由此唯一确定）。
 */
export function assignCitationKeys(seeds: readonly BibliographySeed[]): CanonicalBibliographyEntry[] {
  const deduped: BibliographySeed[] = [];
  const seen = new Map<string, BibliographySeed>();
  const orderKey = (seed: BibliographySeed): string =>
    `${seed.sourceId ?? ""}|${seed.identityKey}|${compactTitle(seed.title)}`;
  for (const seed of sortSeeds(seeds, orderKey)) {
    const existing = seed.identityKey !== "" ? seen.get(seed.identityKey) : undefined;
    if (existing === undefined) {
      deduped.push(seed);
      if (seed.identityKey !== "") {
        seen.set(seed.identityKey, seed);
      }
      continue;
    }
    // 同身份双来源：source-library 条目胜出（authoritative metadata）
    if (existing.origin === "artifact" && seed.origin === "source-library") {
      deduped[deduped.indexOf(existing)] = seed;
      seen.set(seed.identityKey, seed);
    }
  }

  const groups = new Map<string, BibliographySeed[]>();
  for (const seed of deduped) {
    const base = baseCitationKey(seed);
    const group = groups.get(base);
    if (group === undefined) {
      groups.set(base, [seed]);
    } else {
      group.push(seed);
    }
  }

  const entries: CanonicalBibliographyEntry[] = [];
  for (const [base, group] of groups) {
    const ordered = sortSeeds(group, (seed) => seed.identityKey);
    ordered.forEach((seed, index) => {
      entries.push({ ...seed, key: index === 0 ? base : `${base}${suffixFor(index - 1)}` });
    });
  }
  return entries.sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
}

/** 稳定排序（同一 seed 集合任何重算都得到相同顺序；字符串序确定性） */
function sortSeeds<T>(items: readonly T[], keyOf: (item: T) => string): T[] {
  return [...items].sort((a, b) => {
    const ka = keyOf(a);
    const kb = keyOf(b);
    return ka < kb ? -1 : ka > kb ? 1 : 0;
  });
}

// ---- SourceStore / Researcher artifact → bibliography ----

/**
 * 文献库条目 → bibliography seed（只取渲染所需最小投影，不复制 abstract 等）。
 * 无 title 的条目跳过（渲染不出可辨识条目）；type 由 versionType + venue 推导：
 * conference → inproceedings；journal / 有 venue → article；preprint / 其余 → misc。
 */
export function buildBibliographyFromSources(items: readonly SourceItem[]): BibliographySeed[] {
  const seeds: BibliographySeed[] = [];
  for (const item of items) {
    const title = item.metadata.title?.trim();
    if (title === undefined || title === "") {
      continue;
    }
    const identity = item.identity ?? identityFromMetadata(item.metadata);
    const key =
      (identity !== null ? identityKey(identity) : undefined) ?? `tf:${compactTitle(title)}`;
    const doi = identity?.doi ?? item.metadata.doi;
    const arxivId = identity?.arxivId ?? item.metadata.arxivId;
    const venue = item.metadata.venue?.trim();
    const type: DeterministicBibType =
      item.versionType === "conference"
        ? "inproceedings"
        : item.versionType === "journal"
          ? "article"
          : item.versionType === "preprint"
            ? "misc"
            : venue !== undefined && venue !== ""
              ? "article"
              : "misc";
    seeds.push({
      title,
      ...(item.metadata.authors !== undefined && item.metadata.authors.length > 0
        ? { authors: item.metadata.authors }
        : {}),
      ...(item.metadata.year !== undefined ? { year: item.metadata.year } : {}),
      ...(venue !== undefined && venue !== "" ? { venue } : {}),
      ...(doi !== undefined && doi !== "" ? { doi } : {}),
      ...(item.metadata.url !== undefined && item.metadata.url !== ""
        ? { url: item.metadata.url }
        : {}),
      ...(arxivId !== undefined && arxivId !== "" ? { arxivId } : {}),
      type,
      sourceId: item.sourceId,
      identityKey: key,
      origin: "source-library",
    });
  }
  return seeds;
}

/**
 * LLM-recalled（artifact）bibliography 条目的并入上限（M9.7.4）。
 * source-library 条目（用户 promote / 导入的事实）**永不**因上限被裁；
 * 只有 LLM 回忆的背景条目 bounded——超出按 LLM 输出序裁尾（输出序≈相关性序）。
 * 40 = research prompt 纪律上限（30）之上的失控兜底，正常项目不会触碰。
 */
export const MAX_ARTIFACT_BIBLIOGRAPHY_ENTRIES = 40;

/** 与文献库条目的年份兼容（相等，或一方缺失——缺失不构成冲突） */
function yearCompatible(a: number | undefined, b: number | undefined): boolean {
  return a === undefined || b === undefined || a === b;
}

/**
 * Researcher artifact bibliography（LLM 引用意图）并入 canonical 集：
 * 与文献库条目同身份（DOI 精确 / 归一标题+年份一致 / 标题相似度 ≥0.92 且
 * 年份兼容——M9.7.4 增强，title variant 不再与库内条目成对存活）的 LLM
 * 条目**丢弃**（authoritative metadata 在库内）；其余作为 origin=artifact
 * 条目保留并改用确定性 key——LLM 自造 key 从此不再进入任何下游。
 * artifact 条目总量有界（maxArtifactEntries，缺省 40）。
 */
export function mergeArtifactBibliography(
  canonical: readonly BibliographySeed[],
  artifact: readonly BibliographyEntryInput[],
  maxArtifactEntries: number = MAX_ARTIFACT_BIBLIOGRAPHY_ENTRIES,
): CanonicalBibliographyEntry[] {
  const byDoi = new Map<string, BibliographySeed>();
  const byTitleYear = new Map<string, BibliographySeed>();
  for (const seed of canonical) {
    if (seed.doi !== undefined) {
      byDoi.set(seed.doi.toLowerCase(), seed);
    }
    byTitleYear.set(titleYearKey(seed.title, seed.year), seed);
  }
  const seeds = [...canonical];
  let artifactCount = 0;
  for (const entry of artifact) {
    if (artifactCount >= maxArtifactEntries) {
      break; // M9.7.4 bounded：LLM-recalled 条目上限，超出裁尾（LLM 输出序尾部）
    }
    const title = entry.title.trim();
    if (title === "") {
      continue;
    }
    const doi = entry.doi?.trim().toLowerCase();
    if (doi !== undefined && doi !== "" && byDoi.has(doi)) {
      continue; // 文献库已有同 DOI 条目
    }
    const titleKey = titleYearKey(title, entry.year);
    if (byTitleYear.has(titleKey)) {
      continue; // 文献库已有同标题（+年份）条目
    }
    // M9.7.4：标题 variant（副标题 / 大小写 / 标点差异逃过 compactTitle 全等）
    // + 年份兼容 → 同一文献，库内 authoritative 条目胜出（recall 形态丢弃）
    const similarInLibrary = canonical.some(
      (seed) => titleSimilarity(title, seed.title) >= 0.92 && yearCompatible(entry.year, seed.year),
    );
    if (similarInLibrary) {
      continue;
    }
    seeds.push({
      title,
      ...(entry.authors !== undefined && entry.authors.length > 0 ? { authors: entry.authors } : {}),
      ...(entry.year !== undefined ? { year: entry.year } : {}),
      ...(entry.venue !== undefined && entry.venue.trim() !== ""
        ? { venue: entry.venue.trim() }
        : {}),
      ...(doi !== undefined && doi !== "" ? { doi } : {}),
      ...(entry.url !== undefined && entry.url.trim() !== "" ? { url: entry.url.trim() } : {}),
      type: entry.venue !== undefined && entry.venue.trim() !== "" ? "article" : "misc",
      identityKey: `artifact:${compactTitle(title)}`,
      origin: "artifact",
    });
    artifactCount += 1;
  }
  return assignCitationKeys(seeds);
}

/** 归一标题（+年份）判等键（与 matchBibliographyKey 的 title 口径一致：紧凑形式） */
function titleYearKey(title: string, year: number | undefined): string {
  return `${compactTitle(title)}|${year ?? "?"}`;
}

// ---- BibTeX 渲染（确定性） ----

/** BibTeX 值转义（花括号值内）：& % $ # _ { } ~ ^ \ 七类字符 */
function escapeBibValue(value: string): string {
  return value
    .replace(/\\/g, "\\textbackslash{}")
    .replace(/([&%$#_{}])/g, "\\$1")
    .replace(/~/g, "\\textasciitilde{}")
    .replace(/\^/g, "\\textasciicircum{}");
}

/**
 * 作者名 → BibTeX "Family, Given and Family, Given"：
 * - 已是 "Family, Given" 形态（含逗号）原样保留；
 * - 自然序 "Given Family"（含中间名）→ 最后一个 token 作 family；
 * - 单 token（中文姓名等）整体保留。
 */
function formatBibAuthors(authors: readonly string[]): string {
  return authors
    .map((author) => {
      const trimmed = author.trim();
      if (trimmed === "" || trimmed.includes(",")) {
        return trimmed;
      }
      const parts = trimmed.split(/\s+/).filter((part) => part !== "");
      if (parts.length < 2) {
        return trimmed;
      }
      return `${parts[parts.length - 1]}, ${parts.slice(0, -1).join(" ")}`;
    })
    .filter((author) => author !== "")
    .join(" and ");
}

/**
 * 单条 BibTeX 渲染。字段顺序固定（author → title → venue 字段 → year →
 * arXiv → doi → url → sourceId 追溯）；同输入字节级一致。
 * venue 字段名按类型：article→journal、inproceedings→booktitle、misc→howpublished。
 */
export function renderBibEntry(entry: BibRenderEntry): string {
  const type = entry.type ?? (entry.venue !== undefined && entry.venue !== "" ? "article" : "misc");
  const fields: string[] = [];
  if (entry.authors !== undefined && entry.authors.length > 0) {
    fields.push(`  author = {${escapeBibValue(formatBibAuthors(entry.authors))}}`);
  }
  fields.push(`  title = {${escapeBibValue(entry.title)}}`);
  const venue = entry.venue?.trim();
  if (venue !== undefined && venue !== "") {
    const venueField = type === "article" ? "journal" : type === "inproceedings" ? "booktitle" : "howpublished";
    fields.push(`  ${venueField} = {${escapeBibValue(venue)}}`);
  }
  if (entry.year !== undefined) {
    fields.push(`  year = {${entry.year}}`);
  }
  const arxivId = entry.arxivId?.trim();
  if (arxivId !== undefined && arxivId !== "") {
    fields.push(`  eprint = {${escapeBibValue(arxivId)}}`);
    fields.push("  archivePrefix = {arXiv}");
  }
  const doi = entry.doi?.trim();
  if (doi !== undefined && doi !== "") {
    fields.push(`  doi = {${escapeBibValue(doi)}}`);
  }
  const url = entry.url?.trim();
  if (url !== undefined && url !== "") {
    fields.push(`  url = {${escapeBibValue(url)}}`);
  }
  if (entry.sourceId !== undefined && entry.sourceId !== "") {
    fields.push(`  sourceId = {${escapeBibValue(entry.sourceId)}}`);
  }
  return `@${type}{${entry.key},\n${fields.join(",\n")}\n}`;
}

/**
 * references.bib 全文渲染：按 key 排序、"\n\n" 连接、末尾单个换行。
 * 空集 → 空文件（可编译：无 \cite 即无引用）。重复生成字节一致。
 */
export function renderBibliographyFile(entries: readonly BibRenderEntry[]): string {
  const sorted = [...entries].sort((a, b) => (a.key < b.key ? -1 : a.key > b.key ? 1 : 0));
  return sorted.map(renderBibEntry).join("\n\n") + (sorted.length > 0 ? "\n" : "");
}

/** references.bib 只保留实际被引用的条目（M9.5 §10：不含未使用 source） */
export function filterByCitedKeys(
  entries: readonly BibRenderEntry[],
  citedKeys: Iterable<string>,
): BibRenderEntry[] {
  const cited = new Set(citedKeys);
  return entries.filter((entry) => cited.has(entry.key));
}

// ---- Evidence → Citation 追溯（使用点解析，不落存储） ----

/**
 * EvidenceRecord → citation key：sourceId 精确命中 → DOI / 归一标题（+年份）
 * 降级（复用 EvidenceSelectionService.matchBibliographyKey，单一匹配口径）。
 * 无匹配返回 null（调用方不标注 cite，不猜测）。
 */
export function resolveEvidenceCitationKey(
  record: EvidenceRecord,
  entries: readonly (Pick<BibRenderEntry, "key"> & Partial<Pick<BibRenderEntry, "sourceId" | "title" | "doi" | "year">>)[],
): string | null {
  const sourceId = record.source?.sourceId?.trim();
  if (sourceId !== undefined && sourceId !== "") {
    const hit = entries.find((entry) => (entry.sourceId ?? "").trim() === sourceId);
    if (hit !== undefined) {
      return hit.key;
    }
  }
  return EvidenceSelectionService.matchBibliographyKey(record, entries);
}
