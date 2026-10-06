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

/** Lightweight structural locator for single-file LaTeX manuscripts. */
export function locateLatexSections(file: string, source: string): RevisionSpan[] {
  const headings: Array<{ start: number; command: string; title: string; label?: string }> = [];
  const pattern = /^\s*\\(part|chapter|section|subsection|subsubsection|paragraph|subparagraph)\*?\s*\{([^}]*)\}/gm;
  for (const match of source.matchAll(pattern)) {
    const start = match.index ?? 0;
    const rest = source.slice(start + match[0].length, start + match[0].length + 400);
    const label = /^\s*\\label\{([^}]+)\}/.exec(rest)?.[1];
    headings.push({ start, command: match[1] ?? "section", title: (match[2] ?? "").trim(), ...(label ? { label } : {}) });
  }
  return headings.map((heading, index) => {
    const end = headings[index + 1]?.start ?? source.length;
    const content = source.slice(heading.start, end);
    const logicalSection = heading.label ?? `${heading.command}:${heading.title}`;
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

export function applyRevisionSpan(source: string, span: RevisionSpan, replacement: string): string {
  const current = source.slice(span.start, span.end);
  if (hash(current) !== span.originalHash) {
    throw new Error(`REVISION_TARGET_STALE: ${span.logicalSection}`);
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
  let prefix = 0;
  while (prefix < baseline.length && prefix < candidate.length && baseline[prefix] === candidate[prefix]) prefix += 1;
  let suffix = 0;
  while (
    suffix < baseline.length - prefix &&
    suffix < candidate.length - prefix &&
    baseline[baseline.length - 1 - suffix] === candidate[candidate.length - 1 - suffix]
  ) suffix += 1;
  const oldEnd = baseline.length - suffix;
  const within = prefix >= allowed.start && oldEnd <= allowed.end;
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
