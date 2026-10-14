/**
 * M14.1b P1：Finding → targetQuote 可靠投影（确定性、纯函数）。
 *
 * 链路：ReviewIssue（quote / 描述中的引号片段 / 单元 file+logicalSection）→ 被审阅
 * 修订的文档快照 → 唯一原文锚点 → RevisionPlanItem.targetQuote（取**文档中的
 * 原文切片**，不是模型写的字串）→ 下游 logicalSpan 单元定位（M14.1a）。
 *
 * 纪律：
 *   - 只认逐字锚点（空白不敏感）；不做词法 / 语义相似度猜测；
 *   - 范围：已知 file → 只在该文件；已知 logicalSection → 只在该 span；否则全文档；
 *   - 范围内恰好一次命中才投影；0 次 = ANCHOR_NOT_FOUND；多次 = ANCHOR_AMBIGUOUS；
 *     无 ≥12 字锚点 = NO_ANCHOR；全部 unresolved 保持 targetQuote 缺省（M14.1a 的
 *     unresolved 口径不变，不猜位置）。
 */

import type { ReviewIssue } from "../agents/ReviewerService.js";
import { findAnchorMatches, locateFileSpans } from "./logicalSpan.js";
import type { RevisionSpan } from "./revisionScope.js";

export interface SnapshotFile {
  file: string;
  content: string;
}

export type FindingProjectionBasis = "issue_quote" | "description_fragment";

export type FindingProjection =
  | {
      status: "resolved";
      file: string;
      logicalSection: string;
      /** 文档中的原文切片（verbatim；Writer / 守卫按此唯一定位） */
      targetQuote: string;
      basis: FindingProjectionBasis;
      anchor: string;
      scope: "section" | "file" | "document";
    }
  | {
      status: "unresolved";
      reason: "NO_ANCHOR" | "ANCHOR_NOT_FOUND" | "ANCHOR_AMBIGUOUS" | "SCOPE_NOT_FOUND";
      anchors: string[];
      detail?: string;
    };

const QUOTE_FRAGMENT_RE = /[「“"『]([^」”"』]{12,})[」”"』]/g;
const MIN_ANCHOR_CHARS = 12;

/** 候选锚点：issue.quote 优先，其后描述 / 建议中的引号片段（去重、保序） */
export function findingAnchors(issue: Pick<ReviewIssue, "quote" | "description" | "suggestedAction">): Array<{ anchor: string; basis: FindingProjectionBasis }> {
  const anchors: Array<{ anchor: string; basis: FindingProjectionBasis }> = [];
  const seen = new Set<string>();
  const push = (anchor: string, basis: FindingProjectionBasis) => {
    const trimmed = anchor.trim();
    if (trimmed.replace(/\s+/g, "").length < MIN_ANCHOR_CHARS || seen.has(trimmed)) return;
    seen.add(trimmed);
    anchors.push({ anchor: trimmed, basis });
  };
  if (issue.quote !== undefined) push(issue.quote, "issue_quote");
  for (const text of [issue.description, issue.suggestedAction]) {
    if (text === undefined) continue;
    for (const match of text.matchAll(QUOTE_FRAGMENT_RE)) {
      push(match[1]!, "description_fragment");
    }
  }
  return anchors;
}

export function projectFindingTarget(issue: ReviewIssue, files: readonly SnapshotFile[]): FindingProjection {
  const anchors = findingAnchors(issue);
  if (anchors.length === 0) {
    return { status: "unresolved", reason: "NO_ANCHOR", anchors: [] };
  }
  // 范围收窄
  let scoped: Array<{ file: string; content: string; offset: number; spans: RevisionSpan[] }>;
  let scope: "section" | "file" | "document";
  const normalizedFile = issue.file?.replaceAll("\\", "/");
  const candidates = normalizedFile !== undefined ? files.filter((entry) => entry.file.replaceAll("\\", "/") === normalizedFile) : files;
  if (normalizedFile !== undefined && candidates.length === 0) {
    return { status: "unresolved", reason: "SCOPE_NOT_FOUND", anchors: anchors.map((entry) => entry.anchor), detail: `快照中无文件 ${issue.file}` };
  }
  if (issue.logicalSection !== undefined && candidates.length > 0) {
    const hits: typeof scoped = [];
    for (const entry of candidates) {
      const spans = locateFileSpans(entry.file, entry.content);
      const span = spans.find((candidate) => candidate.logicalSection === issue.logicalSection || candidate.label === issue.logicalSection);
      if (span !== undefined) hits.push({ file: entry.file, content: span.content, offset: span.start, spans });
    }
    if (hits.length === 0) {
      return { status: "unresolved", reason: "SCOPE_NOT_FOUND", anchors: anchors.map((entry) => entry.anchor), detail: `快照中无章节 ${issue.logicalSection}` };
    }
    scoped = hits;
    scope = "section";
  } else {
    scoped = candidates.map((entry) => ({ file: entry.file, content: entry.content, offset: 0, spans: locateFileSpans(entry.file, entry.content) }));
    scope = normalizedFile !== undefined ? "file" : "document";
  }
  let anyAmbiguous = false;
  for (const { anchor, basis } of anchors) {
    const matches: Array<{ file: string; start: number; end: number; spans: RevisionSpan[]; content: string; offset: number }> = [];
    for (const entry of scoped) {
      for (const match of findAnchorMatches(entry.content, anchor)) {
        matches.push({ file: entry.file, start: match.start, end: match.end, spans: entry.spans, content: entry.content, offset: entry.offset });
      }
    }
    if (matches.length === 1) {
      const hit = matches[0]!;
      const absoluteStart = hit.offset + hit.start;
      const span = hit.spans.find((candidate) => candidate.start <= absoluteStart && absoluteStart < candidate.end) ?? hit.spans[0];
      return {
        status: "resolved",
        file: hit.file,
        logicalSection: span?.logicalSection ?? `file:${hit.file}`,
        targetQuote: hit.content.slice(hit.start, hit.end),
        basis,
        anchor,
        scope,
      };
    }
    if (matches.length > 1) anyAmbiguous = true;
  }
  return {
    status: "unresolved",
    reason: anyAmbiguous ? "ANCHOR_AMBIGUOUS" : "ANCHOR_NOT_FOUND",
    anchors: anchors.map((entry) => entry.anchor),
    ...(anyAmbiguous ? { detail: "锚点在范围内出现多次（同名章节 / 重复文本）；不猜位置" } : {}),
  };
}
