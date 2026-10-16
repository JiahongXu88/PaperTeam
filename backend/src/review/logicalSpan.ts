/**
 * Logical-span edit units for long chapters (M14.1a P0-1).
 *
 * Background: the revision pipeline already edits single-file manuscripts through
 * `RevisionSpan` targets (one heading → one span, immutable prefix/suffix guard,
 * patch lineage). Two structural gaps made long chapters unrevisable:
 *   - section files of multi-file / outline projects were whole-file targets with
 *     a 12,000-char prompt truncation, so everything after 12k was never shown to
 *     the Writer yet replaced by its output (the guards then rejected the loss and
 *     the loop could not converge);
 *   - a heading span longer than the Writer's working size had no smaller unit.
 *
 * This module provides the deterministic half of the contract:
 *   - `fileBodySpan`: a whole file as one span (headless chapter files);
 *   - `partitionSpanIntoUnits`: cut an oversize span into contiguous paragraph
 *     windows that never split a LaTeX environment / display-math block; units
 *     concatenate back to the exact span text (nothing is dropped);
 *   - `resolveUnitByQuotes`: locate which unit a finding talks about through a
 *     verbatim anchor (targetQuote / quoted source text) that occurs exactly once;
 *     anything missing or ambiguous is reported as unresolved (never guessed —
 *     no lexical-similarity fallback by design);
 *   - `relocateRevisionSpan`: re-find a span / unit on the current disk content by
 *     id and exact content, so sibling patches in the same file shift offsets
 *     without invalidating untouched units, while a changed unit is stale.
 *
 * The model only ever produces the replacement text of one unit; position,
 * original-content hash, scope and application stay in deterministic code
 * (`applyRevisionSpan` / `checkGlobalRevisionScope` in revisionScope.ts).
 */

import { locateLatexSections, revisionSourceHash, type RevisionSpan } from "./revisionScope.js";

/** Default Writer working size per edit unit (chars). Units are bounded by construction; nothing is truncated. */
export const DEFAULT_REVISION_UNIT_MAX_CHARS = 9_000;

/** Prefix of whole-file spans (headless chapter files / multi-file section files addressed by path) */
const FILE_SPAN_PREFIX = "file:";

/** Unit suffix on logicalSection ids: `<sectionId>#u3` or merged `<sectionId>#u3-4` */
const UNIT_SUFFIX_PATTERN = /#u(\d+)(?:-(\d+))?$/;

export function isFileBodySpanId(logicalSection: string): boolean {
  return logicalSection.startsWith(FILE_SPAN_PREFIX);
}

export function isUnitSpanId(logicalSection: string): boolean {
  return UNIT_SUFFIX_PATTERN.test(logicalSection);
}

/** Base (section-level) id of a unit id; identity for non-unit ids. */
export function baseSpanId(logicalSection: string): string {
  return logicalSection.replace(UNIT_SUFFIX_PATTERN, "");
}

/** Whole file as a single span. */
export function fileBodySpan(file: string, source: string): RevisionSpan {
  return {
    file,
    logicalSection: `${FILE_SPAN_PREFIX}${file}`,
    heading: file,
    start: 0,
    end: source.length,
    originalHash: revisionSourceHash(source),
    content: source,
  };
}

/** Heading spans of a file, or the whole file as one span when it has no heading. */
export function locateFileSpans(file: string, source: string): RevisionSpan[] {
  const spans = locateLatexSections(file, source);
  return spans.length > 0 ? spans : [fileBodySpan(file, source)];
}

interface Block {
  start: number; // offset relative to span content
  end: number;
}

const BEGIN_ENV = /\\begin\{([^}]+)\}/g;
const END_ENV = /\\end\{([^}]+)\}/g;

/**
 * Split span content into contiguous blocks at blank lines that lie outside any
 * LaTeX environment and outside display math. Blocks concatenate to the content.
 */
function splitBlocks(content: string): Block[] {
  const blocks: Block[] = [];
  let depth = 0;
  let displayMath = false;
  let blockStart = 0;
  let offset = 0;
  const lines = content.split(/(?<=\n)/); // keep line terminators
  for (const line of lines) {
    const lineStart = offset;
    offset += line.length;
    const code = line.replace(/(^|[^\\])%.*$/, "$1"); // ignore comments (keep escaped \%)
    BEGIN_ENV.lastIndex = 0;
    END_ENV.lastIndex = 0;
    const begins = code.match(BEGIN_ENV)?.length ?? 0;
    const ends = code.match(END_ENV)?.length ?? 0;
    depth = Math.max(0, depth + begins - ends);
    const dollarPairs = (code.match(/(?<!\\)\$\$/g) ?? []).length;
    const opens = (code.match(/(?<!\\)\\\[/g) ?? []).length;
    const closes = (code.match(/(?<!\\)\\\]/g) ?? []).length;
    if (dollarPairs % 2 === 1 || opens !== closes) {
      displayMath = !displayMath;
    }
    const blank = line.trim() === "";
    if (blank && depth === 0 && !displayMath && lineStart > blockStart) {
      blocks.push({ start: blockStart, end: offset });
      blockStart = offset;
    }
  }
  if (blockStart < content.length) {
    blocks.push({ start: blockStart, end: content.length });
  }
  return blocks;
}

export interface UnitPartition {
  units: RevisionSpan[];
  /** Blocks that alone exceed maxChars (one environment / paragraph); kept whole, never split. */
  oversizeUnits: number;
}

/**
 * Bounded, contiguous edit units of a span. A span within `maxChars` is its own
 * single unit (id unchanged). Otherwise paragraph blocks are packed greedily into
 * units ≤ maxChars; a single block larger than maxChars stays whole.
 */
export function partitionSpanIntoUnits(span: RevisionSpan, maxChars: number = DEFAULT_REVISION_UNIT_MAX_CHARS): UnitPartition {
  if (span.content.length <= maxChars) {
    return { units: [span], oversizeUnits: 0 };
  }
  const blocks = splitBlocks(span.content);
  const groups: Block[] = [];
  let current: Block | null = null;
  for (const block of blocks) {
    if (current === null) {
      current = { ...block };
      continue;
    }
    if (block.end - current.start <= maxChars) {
      current.end = block.end;
    } else {
      groups.push(current);
      current = { ...block };
    }
  }
  if (current !== null) groups.push(current);
  let oversizeUnits = 0;
  const units = groups.map((group, index) => {
    const content = span.content.slice(group.start, group.end);
    if (content.length > maxChars) oversizeUnits += 1;
    return {
      file: span.file,
      logicalSection: `${span.logicalSection}#u${index + 1}`,
      heading: span.heading,
      ...(span.label !== undefined ? { label: span.label } : {}),
      start: span.start + group.start,
      end: span.start + group.end,
      originalHash: revisionSourceHash(content),
      content,
    } satisfies RevisionSpan;
  });
  return { units, oversizeUnits };
}

/**
 * M14.4：段落块粒度的编辑单元（thesis bounded revision）。
 *
 * 与 partitionSpanIntoUnits 的区别：不做贪心装箱——每个段落块自成单元（#uN 编号
 * 稳定，relocation / merge 语义不变；单元拼接仍精确还原 span 全文）。用途：
 * 小于编辑单元上限的章节文件在 thesis 修订模式下也按 quote 锚点绑定到
 * **段落窗口**（目标 = 引文所在块，跨块引文合并相邻块），Writer 只改引文
 * 所在段落而不是整个章节文件；无锚点指令回退到合并整 span（仍走同一
 * 候选守卫链）。块本身超过 maxChars 时保持整块不切（与既有纪律一致）。
 */
export function partitionSpanIntoBlockUnits(span: RevisionSpan): UnitPartition {
  const blocks = splitBlocks(span.content);
  let oversizeUnits = 0;
  const units = blocks.map((block, index) => {
    const content = span.content.slice(block.start, block.end);
    if (content.length > DEFAULT_REVISION_UNIT_MAX_CHARS) oversizeUnits += 1;
    return {
      file: span.file,
      logicalSection: `${span.logicalSection}#u${index + 1}`,
      heading: span.heading,
      ...(span.label !== undefined ? { label: span.label } : {}),
      start: span.start + block.start,
      end: span.start + block.end,
      originalHash: revisionSourceHash(content),
      content,
    } satisfies RevisionSpan;
  });
  return { units, oversizeUnits };
}

/** Merge contiguous units [from..to] (inclusive indexes in the partition) into one target span. */
export function mergeAdjacentUnits(units: readonly RevisionSpan[], from: number, to: number): RevisionSpan {
  const first = units[from];
  const last = units[to];
  if (first === undefined || last === undefined || from > to) {
    throw new Error("mergeAdjacentUnits: invalid range");
  }
  if (from === to) return first;
  const content = units.slice(from, to + 1).map((unit) => unit.content).join("");
  const base = baseSpanId(first.logicalSection);
  return {
    file: first.file,
    logicalSection: `${base}#u${from + 1}-${to + 1}`,
    heading: first.heading,
    ...(first.label !== undefined ? { label: first.label } : {}),
    start: first.start,
    end: last.end,
    originalHash: revisionSourceHash(content),
    content,
  };
}

export type UnitResolutionReason =
  | "NO_ANCHOR"
  | "ANCHOR_NOT_FOUND"
  | "ANCHOR_AMBIGUOUS";

export interface UnitResolution {
  unit?: RevisionSpan;
  matchedBy?: "quote";
  reason?: UnitResolutionReason;
  /** The anchor text that produced the match (quote / model). */
  anchor?: string;
}

const MIN_ANCHOR_CHARS = 12;

/** Whitespace-insensitive literal regex for a quote (LaTeX line wrapping must not defeat anchors). */
function anchorPattern(quote: string): RegExp | null {
  const parts = quote.trim().split(/\s+/).filter((part) => part !== "");
  if (parts.join("").length < MIN_ANCHOR_CHARS) return null;
  const escaped = parts.map((part) => part.replace(/[.*+?^${}()|[\]\\]/g, "\\$&"));
  return new RegExp(escaped.join("\\s*"), "g");
}

/** Normalize an elided quote (…/...) into verbatim segments. */
function anchorSegments(quote: string): string[] {
  return quote
    .split(/……|…|\.\.\./)
    .map((segment) => segment.trim())
    .filter((segment) => segment.replace(/\s+/g, "").length >= MIN_ANCHOR_CHARS);
}

/** Find every (start,end) match of an anchor inside text; whitespace-insensitive. */
export function findAnchorMatches(text: string, quote: string): Array<{ start: number; end: number }> {
  const segments = anchorSegments(quote);
  const probe = segments.length > 0 ? segments[0]! : quote;
  const pattern = anchorPattern(probe);
  if (pattern === null) return [];
  const matches: Array<{ start: number; end: number }> = [];
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(text)) !== null) {
    matches.push({ start: match.index, end: match.index + match[0].length });
    if (match[0].length === 0) pattern.lastIndex += 1;
  }
  return matches;
}

/**
 * Resolve the unit(s) a verbatim anchor lives in. Searches the whole span content
 * so an anchor straddling a unit boundary merges the two adjacent units instead
 * of failing. Multiple occurrences in the span → ambiguous (never pick one).
 */
export function resolveUnitByQuotes(
  span: RevisionSpan,
  units: readonly RevisionSpan[],
  quotes: readonly string[],
): UnitResolution {
  const usable = quotes.map((quote) => quote.trim()).filter((quote) => quote.replace(/\s+/g, "").length >= MIN_ANCHOR_CHARS);
  if (usable.length === 0) return { reason: "NO_ANCHOR" };
  let anyFound = false;
  for (const quote of usable) {
    const matches = findAnchorMatches(span.content, quote);
    if (matches.length === 0) continue;
    anyFound = true;
    if (matches.length > 1) continue;
    const match = matches[0]!;
    const absStart = span.start + match.start;
    const absEnd = span.start + match.end;
    const from = units.findIndex((unit) => unit.start <= absStart && absStart < unit.end);
    let to = units.findIndex((unit) => unit.start < absEnd && absEnd <= unit.end);
    if (from < 0) continue;
    if (to < 0) to = from;
    return { unit: mergeAdjacentUnits(units, from, Math.max(from, to)), matchedBy: "quote", anchor: quote };
  }
  return { reason: anyFound ? "ANCHOR_AMBIGUOUS" : "ANCHOR_NOT_FOUND" };
}

/**
 * Re-find a span (or unit) on the current content of its file.
 *  - section / file span: located by id (hash may differ → downstream stale check);
 *  - unit span: its base section is located by id, then the unit's exact original
 *    content must occur exactly once inside it (sibling edits elsewhere in the
 *    section move it; an edit inside it makes it unresolvable = stale).
 */
export function relocateRevisionSpan(file: string, source: string, span: Pick<RevisionSpan, "logicalSection" | "content">): RevisionSpan | undefined {
  const base = baseSpanId(span.logicalSection);
  const baseSpan = isFileBodySpanId(base)
    ? fileBodySpan(file, source)
    : locateLatexSections(file, source).find((candidate) => candidate.logicalSection === base);
  if (baseSpan === undefined) return undefined;
  if (!isUnitSpanId(span.logicalSection)) return baseSpan;
  const first = baseSpan.content.indexOf(span.content);
  if (first < 0 || baseSpan.content.indexOf(span.content, first + 1) >= 0) return undefined;
  return {
    ...baseSpan,
    logicalSection: span.logicalSection,
    start: baseSpan.start + first,
    end: baseSpan.start + first + span.content.length,
    originalHash: revisionSourceHash(span.content),
    content: span.content,
  };
}

/** Read-only context handed to the Writer around a unit (never part of the editable text). */
export interface UnitEditContext {
  heading: string;
  unitIndex: number;
  unitCount: number;
  before: string;
  after: string;
}

export const UNIT_CONTEXT_CHARS = 800;

export function buildUnitEditContext(span: RevisionSpan, unit: RevisionSpan, units: readonly RevisionSpan[]): UnitEditContext {
  const relStart = unit.start - span.start;
  const relEnd = unit.end - span.start;
  const index = units.findIndex((candidate) => candidate.start === unit.start);
  return {
    heading: span.heading,
    unitIndex: index >= 0 ? index + 1 : 1,
    unitCount: units.length,
    before: span.content.slice(Math.max(0, relStart - UNIT_CONTEXT_CHARS), relStart),
    after: span.content.slice(relEnd, relEnd + UNIT_CONTEXT_CHARS),
  };
}
