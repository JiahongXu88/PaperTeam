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
  // M14.8-MOT：单文件稿件的最后一节以内联参考文献（thebibliography）结束——参考文献不是
  // 可审 / 可改的正文，不并入最后一节（否则「结论」单元 7.5k 字符里 6k 是参考文献）
  const bibliographyStart = headings.length > 0 ? source.indexOf("\\begin{thebibliography}", headings[headings.length - 1]!.start) : -1;
  const spans: RevisionSpan[] = headings.map((heading, index) => {
    const end = headings[index + 1]?.start ?? (bibliographyStart >= 0 ? bibliographyStart : source.length);
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
  const front = frontMatterSpan(file, source, headings[0]?.start);
  return front !== null ? [front, ...spans] : spans;
}

/**
 * M14.8-MOT：`\begin{document}`（与可选的 `\maketitle`）之后、第一个章节命令之前的
 * 前置正文（单文件期刊稿件的中英文摘要 / 关键词）。此前它不属于任何 span——
 * 摘要既不被审阅也不可修订，覆盖率却仍报 100%。只在文件含 `\begin{document}` 且
 * 前置区去掉命令后仍有实质文字时生成；题名 / 作者在 `\maketitle` 之前（含导言区）
 * 不进入 span。
 */
export const FRONT_MATTER_SECTION = "frontmatter";

function frontMatterSpan(file: string, source: string, firstHeading: number | undefined): RevisionSpan | null {
  if (firstHeading === undefined) return null;
  const documentBegin = /\\begin\{document\}[^\n]*\n?/.exec(source);
  if (documentBegin === null || documentBegin.index >= firstHeading) return null;
  let start = documentBegin.index + documentBegin[0].length;
  const maketitle = /\\maketitle[^\n]*\n?/.exec(source.slice(start, firstHeading));
  if (maketitle !== null) start += maketitle.index + maketitle[0].length;
  const content = source.slice(start, firstHeading);
  const prose = content
    .replace(/(^|[^\\])%.*$/gm, "$1")
    .replace(/\\[a-zA-Z@]+\*?(\[[^\]]*\])?/g, "")
    .replace(/[{}\s]/g, "");
  if (prose.length < 40) return null;
  return {
    file,
    logicalSection: FRONT_MATTER_SECTION,
    heading: "摘要与前置部分",
    start,
    end: firstHeading,
    originalHash: hash(content),
    content,
  };
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
  // M14.8.1-MOT：补齐的边界换行沿用原 span 的换行风格（CRLF 稿件不混入裸 LF）
  const normalized = replacement.endsWith("\n") || !current.endsWith("\n")
    ? replacement
    : `${replacement}${current.endsWith("\r\n") ? "\r\n" : "\n"}`;
  return source.slice(0, span.start) + normalized + source.slice(span.end);
}

/**
 * M14.8.1-MOT：把 Writer 提案的换行风格对齐到目标 span。真实返修稿是 CRLF 文件，
 * 而 Writer 输出经 stripStrayOutcomeLines 一律归一为 LF——引文外原文逐字节校验因此
 * 对「只改引文」的理想候选也必然失败（M14.8 的 11/11 REVISION_TARGET_QUOTE_SCOPE_VIOLATION
 * 由确定性回放复现）。只在 span 一致使用 CRLF 时把提案的裸 LF 还原为 CRLF；
 * LF / 混合换行的 span 原样不动。
 */
export function adaptLineEndingsToSpan(spanContent: string, text: string): string {
  if (!spanContent.includes("\r\n") || /(^|[^\r])\n/.test(spanContent)) return text;
  return text.replace(/\r\n/g, "\n").replace(/\n/g, "\r\n");
}

const isScopeWhitespace = (char: string | undefined): boolean =>
  char === " " || char === "\t" || char === "\r" || char === "\n";

/**
 * M14.9-MOT：整段删除被引文本的判定。删除一个段落时，它与相邻段落之间的段落分隔必然随之消失，
 * 逐字节的引文外守卫会把这判为「引文前第 N 字符处改动」（真实返修：删除误入正文的说明段落
 * 两次被拒）。只放行这一种形态：候选 = 引文前原文去尾部空白 + 仅空白 + 引文后原文去首部空白，
 * 引文外的所有非空白字节逐字保留；引文旁的任何新增内容仍按越界处理。
 */
export function isWholeQuoteDeletion(spanContent: string, candidateSection: string, range: Pick<RevisionSpan, "start" | "end">): boolean {
  const before = spanContent.slice(0, range.start).replace(/[ \t\r\n]+$/, "");
  const after = spanContent.slice(range.end).replace(/^[ \t\r\n]+/, "");
  if (!candidateSection.startsWith(before) || !candidateSection.endsWith(after)) return false;
  if (candidateSection.length < before.length + after.length) return false;
  return /^[ \t\r\n]*$/.test(candidateSection.slice(before.length, candidateSection.length - after.length));
}

/** 空白段等价类：含 ≥2 个换行（LaTeX 段落分隔）与普通空白不可互换 */
const isParagraphBreak = (run: string): boolean => (run.match(/\n/g)?.length ?? 0) >= 2;

/**
 * M14.8.1-MOT：引文外「仅空白差异」的确定性回填。Writer 必须逐字复制最长 9000 字的
 * 引文外原文，模型常把双空格折叠、调整缩进——这些差异在 LaTeX 中不改变任何内容，
 * 却让逐字节守卫拒绝合法局部修订。本函数只在引文外文本与原文**除空白段长度外完全
 * 相同**（字符逐一相同；空白段一一对应，段落分隔与普通空白不互换）时，用原文字节
 * 回填引文外区域、保留候选的引文区改写；任何非空白差异 → null（照常判越界）。
 * 回填后的候选在引文外与原文逐字节一致，守卫强度不变。
 */
export function respliceOutOfQuoteWhitespace(
  baseline: string,
  candidate: string,
  allowed: Pick<RevisionSpan, "start" | "end">,
): string | null {
  const walk = (
    base: string, cand: string, from: { b: number; c: number }, until: number, step: 1 | -1,
  ): number | null => {
    let b = from.b;
    let c = from.c;
    const inBase = (index: number): boolean => (step === 1 ? index < until : index >= until);
    while (inBase(b)) {
      if (isScopeWhitespace(base[b])) {
        let runB = "";
        while (inBase(b) && isScopeWhitespace(base[b])) { runB = step === 1 ? runB + base[b] : base[b] + runB; b += step; }
        if (!isScopeWhitespace(cand[c])) return null;
        let runC = "";
        while (c >= 0 && c < cand.length && isScopeWhitespace(cand[c])) { runC = step === 1 ? runC + cand[c] : cand[c] + runC; c += step; }
        if (isParagraphBreak(runB) !== isParagraphBreak(runC)) return null;
        continue;
      }
      if (c < 0 || c >= cand.length || base[b] !== cand[c]) return null;
      b += step;
      c += step;
    }
    return c;
  };
  const prefixEnd = walk(baseline, candidate, { b: 0, c: 0 }, allowed.start, 1);
  if (prefixEnd === null) return null;
  const suffixStartExclusive = walk(baseline, candidate, { b: baseline.length - 1, c: candidate.length - 1 }, allowed.end, -1);
  if (suffixStartExclusive === null) return null;
  const middleEnd = suffixStartExclusive + 1;
  if (middleEnd < prefixEnd) return null;
  return baseline.slice(0, allowed.start) + candidate.slice(prefixEnd, middleEnd) + baseline.slice(allowed.end);
}

/**
 * M14.8.1-MOT：span 提案的格式对齐（换行风格 + 引文外空白回填）。输入是 Writer 的
 * trim 后提案、原 span 与（可选）引文授权区间（span 内偏移）；输出提案在引文外与
 * 原 span 逐字节一致时才做空白回填，判定口径仍由 checkRevisionScope 逐字节执行。
 */
export function alignProposalToSpan(
  spanContent: string,
  proposal: string,
  allowed?: Pick<RevisionSpan, "start" | "end">,
): { proposal: string; adjustments: Array<"eol_crlf" | "whitespace_resplice"> } {
  const adjustments: Array<"eol_crlf" | "whitespace_resplice"> = [];
  let next = adaptLineEndingsToSpan(spanContent, proposal.trim());
  if (next !== proposal.trim()) adjustments.push("eol_crlf");
  if (allowed !== undefined) {
    const lead = spanContent.length - spanContent.trimStart().length;
    const trimmed = spanContent.trim();
    const start = allowed.start - lead;
    const end = allowed.end - lead;
    if (start >= 0 && end <= trimmed.length && start <= end) {
      const prefix = trimmed.slice(0, start);
      const suffix = trimmed.slice(end);
      const strict = next.length >= prefix.length + suffix.length && next.startsWith(prefix) && next.endsWith(suffix);
      if (!strict) {
        const resplice = respliceOutOfQuoteWhitespace(trimmed, next, { start, end });
        if (resplice !== null) {
          next = resplice;
          adjustments.push("whitespace_resplice");
        }
      }
    }
  }
  return { proposal: next, adjustments };
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

/**
 * M14.8-MOT：引文授权区间外改动的可诊断描述（只读；不改变判定）。真实返修 11/11 个
 * targetQuote 补丁被判 REVISION_TARGET_QUOTE_SCOPE_VIOLATION，而候选文本不落盘——
 * 无从区分「Writer 实质改写了引文外内容」与「格式归一化（千分位、转义、空白）」。
 * 返回首个偏离点相对授权区间的位置与前后各 ≤60 字符的原文 / 候选摘录。
 */
export function describeScopeViolation(
  baseline: string,
  candidate: string,
  allowed: Pick<RevisionSpan, "start" | "end">,
): string {
  const excerpt = (value: string, at: number): string =>
    JSON.stringify(value.slice(Math.max(0, at - 20), at + 60).replace(/\s+/g, " "));
  const prefix = baseline.slice(0, allowed.start);
  let p = 0;
  while (p < prefix.length && p < candidate.length && prefix[p] === candidate[p]) p += 1;
  if (p < prefix.length) {
    return `引文前第 ${prefix.length - p} 字符处改动：原 ${excerpt(baseline, p)} → 候选 ${excerpt(candidate, p)}`;
  }
  const suffix = baseline.slice(allowed.end);
  let s = 0;
  while (s < suffix.length && s < candidate.length && suffix[suffix.length - 1 - s] === candidate[candidate.length - 1 - s]) s += 1;
  if (s < suffix.length) {
    const baseAt = baseline.length - 1 - s;
    const candAt = candidate.length - 1 - s;
    return `引文后第 ${suffix.length - 1 - s} 字符处改动：原 ${excerpt(baseline, baseAt)} → 候选 ${excerpt(candidate, candAt)}`;
  }
  return "候选长度不足以容纳引文外原文";
}

/**
 * M14.8.1-MOT：多个互不重叠引文的授权（逐字节）。候选必须由原文的引文外片段按原顺序、逐字节
 * 拼接而成，引文位置可被任意替换：P0 X1 P1 X2 … Xk Pk（Pi 为原文引文外片段）。每个引文只授权它
 * 自己的区间——不并集、不扩大授权（M14.1a「不相交引文不得静默合并为更宽授权」的纪律不变）。
 * 真实返修第 2 轮：审稿 finding 投影的计划条目在同一章节常有多处互不相交的引文，旧口径一律
 * 判 REVISION_TARGET_QUOTE_UNRESOLVED（33 个候选中 28 个因此直接作废）。
 */
export function checkMultiRangeScope(
  baseline: string,
  candidate: string,
  ranges: ReadonlyArray<Pick<RevisionSpan, "start" | "end">>,
): { allowed: boolean; failedSegment?: number } {
  const sorted = [...ranges].sort((a, b) => a.start - b.start);
  for (let index = 1; index < sorted.length; index += 1) {
    if (sorted[index]!.start < sorted[index - 1]!.end) return { allowed: false, failedSegment: index };
  }
  const segments: string[] = [];
  let cursor = 0;
  for (const range of sorted) {
    segments.push(baseline.slice(cursor, range.start));
    cursor = range.end;
  }
  segments.push(baseline.slice(cursor));
  const first = segments[0]!;
  const last = segments[segments.length - 1]!;
  if (!candidate.startsWith(first)) return { allowed: false, failedSegment: 0 };
  const suffixStart = candidate.length - last.length;
  if (!candidate.endsWith(last) || suffixStart < first.length) return { allowed: false, failedSegment: segments.length - 1 };
  let at = first.length;
  for (let index = 1; index < segments.length - 1; index += 1) {
    const segment = segments[index]!;
    const found = candidate.indexOf(segment, at);
    if (found < 0 || found + segment.length > suffixStart) return { allowed: false, failedSegment: index };
    at = found + segment.length;
  }
  return { allowed: true };
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
