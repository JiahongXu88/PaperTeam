import { createHash } from "node:crypto";
import type { EvidenceRecord } from "../evidence/EvidenceStore.js";

export interface RevisionSpan {
  file: string;
  logicalSection: string;
  heading: string;
  label?: string;
  start: number;
  end: number;
  originalHash: string;
  content: string;
}

export interface RevisionScopeDiff {
  allowed: boolean;
  outsideScopeChanges: number;
  reason?: string;
}

export interface AuthorizedRevisionScope { start: number; end: number; originalHash: string; }

/** Validate the complete immutable-before → candidate diff against every authorized span. */
export function checkGlobalRevisionScope(
  baseline: string,
  candidate: string,
  scopes: readonly AuthorizedRevisionScope[],
): RevisionScopeDiff {
  const ordered = [...scopes].sort((a, b) => a.start - b.start);
  if (ordered.some((scope, index) => hash(baseline.slice(scope.start, scope.end)) !== scope.originalHash ||
    (index > 0 && ordered[index - 1]!.end > scope.start))) {
    return { allowed: false, outsideScopeChanges: 1, reason: "REVISION_TARGET_STALE" };
  }
  let oldCursor = 0;
  let newCursor = 0;
  for (let index = 0; index < ordered.length; index += 1) {
    const scope = ordered[index]!;
    const unchangedPrefix = baseline.slice(oldCursor, scope.start);
    if (candidate.slice(newCursor, newCursor + unchangedPrefix.length) !== unchangedPrefix) {
      return { allowed: false, outsideScopeChanges: 1, reason: "REVISION_SCOPE_VIOLATION" };
    }
    newCursor += unchangedPrefix.length;
    const next = ordered[index + 1];
    if (next !== undefined) {
      const unchangedGap = baseline.slice(scope.end, next.start);
      if (unchangedGap !== "") {
        const anchor = candidate.indexOf(unchangedGap, newCursor);
        if (anchor < 0) return { allowed: false, outsideScopeChanges: 1, reason: "REVISION_SCOPE_VIOLATION" };
        newCursor = anchor;
      }
    } else {
      const unchangedSuffix = baseline.slice(scope.end);
      if (unchangedSuffix !== "" && !candidate.endsWith(unchangedSuffix)) {
        return { allowed: false, outsideScopeChanges: 1, reason: "REVISION_SCOPE_VIOLATION" };
      }
      return { allowed: true, outsideScopeChanges: 0 };
    }
    oldCursor = scope.end;
  }
  return ordered.length === 0 && baseline === candidate
    ? { allowed: true, outsideScopeChanges: 0 }
    : ordered.length === 0
      ? { allowed: false, outsideScopeChanges: 1, reason: "REVISION_SCOPE_VIOLATION" }
      : { allowed: true, outsideScopeChanges: 0 };
}

export interface NoopCoverageCheck {
  logicalSection?: string;
  coverageQuote?: string;
  evidenceIds: string[];
  protocolId?: string;
}

const hash = (value: string): string => createHash("sha256").update(value).digest("hex");

export function revisionSourceHash(value: string): string { return hash(value); }

export function hasRevisionWorkspaceMutation(snapshotHash: string, currentContent: string): boolean {
  return hash(currentContent) !== snapshotHash;
}

/** 分节命令（含 starred 变体与可选短标题参数）；只认行首命令，与 M11.4.1 口径一致 */
const SECTION_COMMAND_PATTERN = /^[ \t]*\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?[ \t]*(?:\[[^\]\n]*\][ \t]*)?\{/gm;

/**
 * 平衡花括号读取标题（M14.1a）：旧实现 `\{([^}]*)\}` 读不出含嵌套命令的标题
 * （真实论文 `\subsection{MRG\mbox{-}DTM}`），这类章节在 span 定位里"不存在"，
 * 其正文被并入前一节。返回标题正文与右花括号后的下标；不闭合返回 null。
 */
function readBalancedTitle(source: string, openIndex: number): { title: string; endIndex: number } | null {
  let depth = 1;
  let index = openIndex + 1;
  while (index < source.length && depth > 0) {
    const char = source[index] as string;
    if (char === "\\") {
      index += 2;
      continue;
    }
    if (char === "{") depth += 1;
    else if (char === "}") depth -= 1;
    index += 1;
  }
  if (depth !== 0) return null;
  return { title: source.slice(openIndex + 1, index - 1).trim(), endIndex: index };
}

/**
 * Structural locator for LaTeX manuscripts (single-file main.tex and per-chapter
 * files alike). Every heading opens a span that runs to the next heading (or end
 * of file). M14.1a: titles are read with balanced braces, and logicalSection ids
 * are unique within a file — the first occurrence keeps the historical
 * `command:title` / label form, later duplicates get `#2`, `#3`, … in document
 * order, so two same-titled subsections can never resolve to the same patch target.
 */
export function locateLatexSections(file: string, source: string): RevisionSpan[] {
  const headings: Array<{ start: number; command: string; title: string; label?: string }> = [];
  SECTION_COMMAND_PATTERN.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = SECTION_COMMAND_PATTERN.exec(source)) !== null) {
    const start = match.index;
    const openIndex = start + match[0].length - 1;
    const parsed = readBalancedTitle(source, openIndex);
    if (parsed === null) continue;
    const rest = source.slice(parsed.endIndex, parsed.endIndex + 400);
    const label = /^\s*\\label\{([^}]+)\}/.exec(rest)?.[1];
    headings.push({ start, command: match[1] ?? "section", title: parsed.title, ...(label ? { label } : {}) });
    SECTION_COMMAND_PATTERN.lastIndex = parsed.endIndex;
  }
  const seen = new Map<string, number>();
  return headings.map((heading, index) => {
    const end = headings[index + 1]?.start ?? source.length;
    const content = source.slice(heading.start, end);
    const baseId = heading.label ?? `${heading.command}:${heading.title}`;
    const occurrence = (seen.get(baseId) ?? 0) + 1;
    seen.set(baseId, occurrence);
    const logicalSection = occurrence === 1 ? baseId : `${baseId}#${occurrence}`;
    return {
      file,
      logicalSection,
      heading: heading.title,
      ...(heading.label ? { label: heading.label } : {}),
      start: heading.start,
      end,
      originalHash: hash(content),
      content,
    };
  });
}

export function applyRevisionSpan(source: string, span: RevisionSpan, replacement: string, options: { preserveBoundaryWhitespace?: boolean } = {}): string {
  const current = source.slice(span.start, span.end);
  if (hash(current) !== span.originalHash) {
    throw new Error(`REVISION_TARGET_STALE: ${span.logicalSection}`);
  }
  if (options.preserveBoundaryWhitespace) {
    // A sentence-scoped replacement cannot authorize incidental whitespace loss
    // at the containing section's boundaries (Writer responses are trimmed).
    replacement = (current.match(/^\s*/)?.[0] ?? "") + replacement.trim() + (current.match(/\s*$/)?.[0] ?? "");
  }
  // M11.4（Attempt 7 实录）：span 原内容以换行结尾而 replacement 不带尾换行时，
  // 后续文本（通常是下一个 \section/\subsection 命令）会被粘连到行中，
  // locateLatexSections 随之解析不出该章节，修订链以
  // "Revision target no longer resolves" fatal 终结。补齐边界换行，
  // 保持行结构在 span 边界处不变。
  const normalized = replacement.endsWith("\n") || !current.endsWith("\n")
    ? replacement
    : `${replacement}\n`;
  return source.slice(0, span.start) + normalized + source.slice(span.end);
}

/** Exact prefix/suffix boundary check: all changed text must fit the authorized span. */
export function checkRevisionScope(
  baseline: string,
  candidate: string,
  allowed: Pick<RevisionSpan, "start" | "end" | "originalHash">,
): RevisionScopeDiff {
  if (hash(baseline.slice(allowed.start, allowed.end)) !== allowed.originalHash) {
    return { allowed: false, outsideScopeChanges: 1, reason: "REVISION_TARGET_STALE" };
  }
  // Compare the authorized immutable boundaries directly. A longest-common
  // prefix can absorb a repeated trailing newline into an insertion and falsely
  // place that edit outside targetQuote. Fixed prefix/suffix equality preserves
  // every byte outside the grant without that ambiguous diff alignment.
  const prefix = baseline.slice(0, allowed.start);
  const suffix = baseline.slice(allowed.end);
  const within = candidate.length >= prefix.length + suffix.length &&
    candidate.startsWith(prefix) && candidate.endsWith(suffix);
  return within
    ? { allowed: true, outsideScopeChanges: 0 }
    : { allowed: false, outsideScopeChanges: 1, reason: "REVISION_SCOPE_VIOLATION" };
}

export function revisionSpansOverlap(a: RevisionSpan, b: RevisionSpan): boolean {
  return a.file === b.file && a.start < b.end && b.start < a.end;
}

export function hasNewContentAfterDocumentEnd(baseline: string, candidate: string): boolean {
  const tail = (value: string): string => {
    const end = value.lastIndexOf("\\end{document}");
    return end < 0 ? "" : value.slice(end + "\\end{document}".length);
  };
  const oldTail = tail(baseline);
  const newTail = tail(candidate);
  return newTail !== oldTail && newTail.trim() !== "";
}

/**
 * M11.4 Reliability Closure（Run F 实证：R2 的 noop 引文用「……」拼接两段
 * 真实原文——节略引文是规范引用形态，逐字 includes 会误拒）。节略引文核验：
 * 按 ……/…/... 切段，每段（≥4 字符）逐字存在于 span，多段时要求出现顺序
 * 递增；单段退化回纯 includes。总引文字符过短（<12）仍拒绝（防碎片匹配）。
 */
function quoteCoveredInSpan(quote: string, spanContent: string): boolean {
  if (spanContent.includes(quote)) return true;
  const segments = quote
    .split(/……|…|\.\.\./)
    .map((segment) => segment.trim())
    .filter((segment) => segment.length > 0);
  if (segments.length < 2) return false;
  const meaningful = segments.filter((segment) => segment.length >= 4);
  if (meaningful.length < 2 || meaningful.join("").length < 12) return false;
  let searchFrom = 0;
  for (const segment of segments) {
    if (segment.length < 4) continue;
    const at = spanContent.indexOf(segment, searchFrom);
    if (at < 0) return false;
    searchFrom = at + segment.length;
  }
  return true;
}

export function verifyNoopCoverage(
  item: NoopCoverageCheck,
  spans: readonly RevisionSpan[],
  evidenceById: ReadonlyMap<string, EvidenceRecord>,
): { verified: boolean; reason?: string; span?: RevisionSpan } {
  const span = spans.find((candidate) => candidate.logicalSection === item.logicalSection);
  if (span === undefined) return { verified: false, reason: "NOOP_TARGET_UNRESOLVED" };
  const quote = item.coverageQuote?.trim();
  if (!quote || !quoteCoveredInSpan(quote, span.content)) return { verified: false, reason: "NOOP_COVERAGE_QUOTE_MISSING" };
  /**
   * M11.4 Reliability Closure（Run E 实证：w-b5e989fe6426，Planner 对三条
   * 意见给出基线覆盖 noop 但无 Evidence 可绑——「参考文献 ≥20 篇」「已有部署
   * 章节」的覆盖证明就是稿件本身，不是 Evidence 记录；旧的 NOOP_EVIDENCE_
   * REQUIRED 使这类合法 noop 结构性无解，structured repair 两轮耗尽 → 阶段
   * 失败）。已满足的证明 = coverageQuote 逐字存在于目标 span（上方确定性
   * 核验）；Evidence 绑定降为增强项（绑了才校验其状态/协议）。
   */
  for (const id of item.evidenceIds) {
    const record = evidenceById.get(id);
    if (record === undefined || (record.verificationStatus !== "verified" && record.verificationLevel !== "user_confirmed")) {
      return { verified: false, reason: "NOOP_EVIDENCE_UNVERIFIED" };
    }
    if (item.protocolId !== undefined && (record.protocolScope?.protocolId !== item.protocolId || record.protocolScope.status !== "current")) {
      return { verified: false, reason: "NOOP_PROTOCOL_MISMATCH" };
    }
    if (item.protocolId === undefined && record.protocolScope !== undefined && record.protocolScope.status !== "current") {
      return { verified: false, reason: "NOOP_PROTOCOL_HISTORICAL" };
    }
  }
  return { verified: true, span };
}
