/**
 * M15.2 Finding 定向复核（有界问证，shadow）：取代 M15.1 的「词面诊断 → 降级」思路。
 *
 * M15.1 的 findingAudit 只做词面诊断（缺失型措辞 + 区分性术语出现在别处 → CONTEXT_INCOMPLETE）：样本内 precision ≈ 25%，
 * 76 条模型辅助标为真的 finding 里有 15 条也被标上——不能据此降级。M15.2 把诊断变成「待复核队列」：
 *
 *  1. 选队列（确定性）：critical / major 优先；CONTEXT_INCOMPLETE（缺失型断言的术语在其他单元出现 / 自声明需跨章核对）进入复核；
 *     PARSE_ARTIFACT_SUSPECTED 在没有页面级原件 provenance 时不调用模型（模型同样看不到原页），直接记 UNRESOLVABLE_NO_PAGE_PROVENANCE；
 *  2. 候选片段（确定性）：从被审修订中按 finding 的区分性术语取出其他单元的句子（含前后一句）与表格，整段附上，预算有界；
 *  3. 有界模型复核：一批 ≤ 6 条、调用上限可配、独立 sealed 会话、每批 1 次重试；
 *  4. 确定性校验：模型给出的 evidenceQuote 必须逐字落在本条的候选片段中；「反驳缺失型断言」时引文必须包含该断言所指的术语之一；
 *     校验不过 / 模型说不能判定 / 调用失败 / 超预算 → UNRESOLVED（保持原 finding，不降级、不删除）。
 *     M15.2.1（P1）：复合意见（≥2 个独立子断言）的 REFUTED 须逐子断言给出逐字覆盖（point 取自意见原文、依据落在候选片段），
 *     覆盖不全 → 降级 PARTIALLY_REFUTED（fail-closed；N1648BF8 r2 #47 曾凭部分反证整体撤回）。
 *
 * 产物只进入 shadow 四轴裁决（findingAdjudication）；生产 issues、计数、Gate 不读它。
 */

import type { ReviewIssue } from "../agents/ReviewerService.js";
import type { FindingAuditRecord } from "./findingAudit.js";
import { compactText, containsTerm, distinctiveTerms, locateQuote, sha256Text } from "./claimAuditText.js";
import { parseLatexTables } from "./latexTable.js";

export const FINDING_RECHECK_CONTRACT = "finding-recheck/v2";
export const FINDING_RECHECK_BATCH = 6;
const SNIPPET_BUDGET = 3_200;
const MAX_SNIPPETS = 4;

export type FindingRecheckReason = "CONTEXT_INCOMPLETE" | "PARSE_ARTIFACT_SUSPECTED";

export interface FindingSnippet {
  snippetId: string;
  sourceUnitId: string;
  sourceHeading: string;
  via: "absence_term_sentence" | "term_table" | "term_sentence";
  matchedTerms: string[];
  text: string;
  sha256: string;
}

export interface FindingRecheckItem {
  findingId: string;
  issueIndex: number;
  reason: FindingRecheckReason;
  severity: string;
  category: string;
  section: string;
  description: string;
  quote: string | null;
  /** 缺失型断言所指的术语（反驳引文须包含其一） */
  assertedTerms: string[];
  absenceAssertion: boolean;
  snippets: FindingSnippet[];
}

export type FindingRecheckOutcome =
  /** 候选片段给出了 finding 断言缺失 / 矛盾的内容（引文逐字在片段中、包含被断言缺失的术语）：finding 在全文视角下不成立的候选 */
  | "REFUTED_BY_DOCUMENT_CONTEXT"
  /** 片段只回答了意见中的一部分（例如给出了取值但没有给出选取依据）：意见其余部分仍成立——不作撤回候选 */
  | "PARTIALLY_REFUTED_BY_DOCUMENT_CONTEXT"
  /** 跨单元材料支持 finding（引文逐字在片段中） */
  | "CONFIRMED_WITH_DOCUMENT_CONTEXT"
  | "UNRESOLVED"
  | "UNRESOLVABLE_NO_PAGE_PROVENANCE"
  | "NO_CANDIDATES"
  | "SKIPPED_BUDGET"
  | "FAILED";

export interface FindingRecheckRecord {
  findingId: string;
  issueIndex: number;
  reason: FindingRecheckReason;
  outcome: FindingRecheckOutcome;
  /** 模型原始结论（校验前） */
  modelVerdict?: "SUPPORTED" | "REFUTED" | "PARTIALLY_REFUTED" | "NOT_DETERMINABLE";
  evidence?: { quote: string; snippetId: string; containsAssertedTerm: boolean };
  /** M15.2.1（P1）：复合意见（≥2 独立子断言）REFUTED 的逐子断言覆盖情况 */
  coverage?: { subAssertions: number; refutedPoints: number; complete: boolean };
  validation: string;
  batchId?: string;
  snippets: Array<Pick<FindingSnippet, "snippetId" | "sourceUnitId" | "sourceHeading" | "via" | "matchedTerms" | "sha256">>;
  note?: string;
}

export interface FindingRecheckArtifactSection {
  contract: typeof FINDING_RECHECK_CONTRACT;
  maxCalls: number;
  records: FindingRecheckRecord[];
  batches: Array<{ batchId: string; items: number; status: "COMPLETED" | "FAILED"; attempts: number; taskId?: string; promptSha256?: string; model?: string; usage?: Record<string, unknown>; error?: string }>;
  summary: Record<FindingRecheckOutcome, number>;
}

interface UnitText {
  unitId: string;
  heading: string;
  text: string;
}

const SUMMARY_HEADING = /^(?:frontmatter|前置内容|摘要与前置部分|摘\s*要|Abstract|\d*\s*引言|绪论|\d*\s*Introduction|\d*\s*结论|总结|\d*\s*Conclusions?)$/i;
const SEVERITY_RANK: Record<string, number> = { critical: 3, major: 2, minor: 1 };

function sentenceWindow(text: string, offset: number, maxChars: number): string {
  const boundaries: number[] = [0];
  for (const match of text.matchAll(/[。！？]|[.!?](?=\s)|\n{2,}/g)) boundaries.push(match.index! + match[0].length);
  boundaries.push(text.length);
  let k = 0;
  while (k + 1 < boundaries.length && boundaries[k + 1]! <= offset) k += 1;
  const start = boundaries[Math.max(0, k - 1)]!;
  const end = boundaries[Math.min(boundaries.length - 1, k + 2)]!;
  return text.slice(start, end).trim().slice(0, maxChars);
}

/** 候选片段：其他单元中含 ≥need 个术语的句子（带前后一句）与表格；摘要 / 引言 / 结论只复述，不作来源 */
export function findingSnippets(units: readonly UnitText[], homeUnitIds: ReadonlySet<string>, terms: readonly string[]): FindingSnippet[] {
  if (terms.length === 0) return [];
  const need = Math.min(2, terms.length);
  const snippets: FindingSnippet[] = [];
  let used = 0;
  const push = (snippet: Omit<FindingSnippet, "snippetId" | "sha256">) => {
    if (snippets.length >= MAX_SNIPPETS || used + snippet.text.length > SNIPPET_BUDGET) return;
    if (snippets.some((existing) => existing.text === snippet.text || existing.text.includes(snippet.text))) return;
    used += snippet.text.length;
    snippets.push({ ...snippet, snippetId: `F${snippets.length + 1}`, sha256: sha256Text(snippet.text) });
  };
  const sources = units.filter((unit) => !homeUnitIds.has(unit.unitId) && !SUMMARY_HEADING.test(unit.heading) && !/::frontmatter/.test(unit.unitId));
  const sentenceHits: Array<{ unit: UnitText; offset: number; matched: string[] }> = [];
  for (const unit of sources) {
    const normalized = unit.text.normalize("NFKC");
    let offset = 0;
    for (const piece of normalized.split(/(?<=[。；！？])|(?<=[.;!?])\s+|\n{2,}/)) {
      const matched = terms.filter((term) => containsTerm(piece, term));
      if (matched.length >= need && piece.trim().length >= 12) sentenceHits.push({ unit, offset: Math.max(0, normalized.indexOf(piece, offset)), matched });
      offset += piece.length;
    }
  }
  sentenceHits.sort((a, b) => b.matched.length - a.matched.length);
  for (const hit of sentenceHits.slice(0, 3)) {
    push({ sourceUnitId: hit.unit.unitId, sourceHeading: hit.unit.heading, via: "absence_term_sentence", matchedTerms: hit.matched, text: sentenceWindow(hit.unit.text.normalize("NFKC"), hit.offset, 1_200) });
  }
  for (const unit of sources) {
    for (const table of parseLatexTables(unit.text)) {
      const body = unit.text.slice(table.floatStart ?? table.start, table.floatEnd ?? table.end);
      const matched = terms.filter((term) => containsTerm(body, term));
      if (matched.length >= need) push({ sourceUnitId: unit.unitId, sourceHeading: unit.heading, via: "term_table", matchedTerms: matched, text: body.slice(0, 1_800) });
    }
  }
  return snippets;
}

/**
 * 待复核队列（确定性）：critical → major → minor；同级按 issueIndex。maxItems 之外的条目记 SKIPPED_BUDGET。
 * PARSE_ARTIFACT_SUSPECTED 且无页面级原件 → 不排模型调用（UNRESOLVABLE_NO_PAGE_PROVENANCE）。
 */
export function selectFindingRecheckItems(input: {
  issues: readonly ReviewIssue[];
  records: readonly FindingAuditRecord[];
  units: readonly UnitText[];
  maxItems: number;
  pageProvenanceAvailable?: boolean;
  minSeverity?: "major" | "minor";
}): { items: FindingRecheckItem[]; records: FindingRecheckRecord[] } {
  const floor = SEVERITY_RANK[input.minSeverity ?? "major"]!;
  const candidates = input.records
    .filter((record) => (record.auditStatus === "CONTEXT_INCOMPLETE" || record.auditStatus === "PARSE_ARTIFACT_SUSPECTED") && (SEVERITY_RANK[record.severityObserved] ?? 0) >= floor)
    .sort((a, b) => (SEVERITY_RANK[b.severityObserved] ?? 0) - (SEVERITY_RANK[a.severityObserved] ?? 0) || a.issueIndex - b.issueIndex);
  const items: FindingRecheckItem[] = [];
  const records: FindingRecheckRecord[] = [];
  for (const record of candidates) {
    const issue = input.issues[record.issueIndex];
    if (issue === undefined) continue;
    const reason: FindingRecheckReason = record.auditStatus === "PARSE_ARTIFACT_SUSPECTED" ? "PARSE_ARTIFACT_SUSPECTED" : "CONTEXT_INCOMPLETE";
    if (reason === "PARSE_ARTIFACT_SUSPECTED" && input.pageProvenanceAvailable !== true) {
      records.push({ findingId: record.findingId, issueIndex: record.issueIndex, reason, outcome: "UNRESOLVABLE_NO_PAGE_PROVENANCE", validation: "转写稿上的公式 / 字符损坏类 finding：项目没有页面级原件，复核模型同样无法回看原页——不调用模型，保持原 finding、verification 记为输入解析不可靠", snippets: [] });
      continue;
    }
    const home = new Set<string>(record.unitId === null ? [] : input.units.filter((unit) => unit.unitId.startsWith(record.unitId!.split("#")[0]!)).map((unit) => unit.unitId));
    if (record.locatedUnitId !== undefined) home.add(record.locatedUnitId);
    const assertedTerms = record.documentLookup.terms.length > 0 ? record.documentLookup.terms : distinctiveTerms(`${issue.description} ${issue.quote ?? ""}`).slice(0, 10);
    const snippets = findingSnippets(input.units, home, assertedTerms);
    const base = { findingId: record.findingId, issueIndex: record.issueIndex, reason };
    if (snippets.length === 0) {
      records.push({ ...base, outcome: "NO_CANDIDATES", validation: "按术语没有在其他单元找到候选片段：无法复核，保持原 finding", snippets: [] });
      continue;
    }
    if (items.length >= input.maxItems) {
      records.push({ ...base, outcome: "SKIPPED_BUDGET", validation: "超出复核预算：保持原 finding（未复核 ≠ 已确认）", snippets: snippets.map(({ text: _text, ...rest }) => rest) });
      continue;
    }
    items.push({
      ...base, severity: issue.severity, category: issue.category, section: issue.section, description: issue.description.slice(0, 900), quote: issue.quote ?? null,
      assertedTerms, absenceAssertion: record.absenceAssertion, snippets,
    });
  }
  return { items, records };
}

export function renderFindingRecheckPrompt(items: readonly FindingRecheckItem[]): string {
  return [
    "你是学术审稿复核员。下面每条审稿意见（finding）来自对论文某一章节的单独审查；审查时看不到其他章节，意见可能断言了「论文没有说明 / 没有给出 / 前后不一致」。",
    "系统已按确定性规则（意见中的区分性术语）从同一篇论文的其他章节中取出候选原文片段。请只依据给出的片段逐条判断：",
    "- verdict：REFUTED（片段中明确给出了该意见断言缺失的全部内容，或明确解释了其所称的矛盾——意见在全文视角下整体不成立）| PARTIALLY_REFUTED（片段只回答了意见的一部分，例如给出了取值但没有给出选取依据——意见其余部分仍成立）| SUPPORTED（片段进一步证实该意见）| NOT_DETERMINABLE（片段不足以判断；这是正常结果，不要猜）；",
    "- 意见可能含多个独立子断言（分号 / 并列子句，如「未给出参数取值，也没有说明选取依据」）：REFUTED 只适用于全部子断言都被逐字依据反驳；只覆盖部分时必须给 PARTIALLY_REFUTED，并在 refutedPoints 中列出已覆盖的子断言——REFUTED 时复合意见也须逐子断言给出 refutedPoints（point 逐字取自意见原文、evidenceQuote 逐字取自候选片段、snippetId 标明出处；未覆盖的子断言不得声称已反驳）；",
    "- evidenceQuote：从候选片段中逐字摘出的依据（≥12 字，不改写、不拼接；NOT_DETERMINABLE 时省略）；snippetId：依据所在片段编号；",
    "- note：一句话说明。只判断意见本身是否成立，不要评价写作好坏，也不要提出新问题；片段没有覆盖的内容不能当作「论文没有」。",
    "只输出一个 JSON 对象（不要 Markdown 围栏）：{\"results\":[{\"findingId\":\"...\",\"verdict\":\"REFUTED|PARTIALLY_REFUTED|SUPPORTED|NOT_DETERMINABLE\",\"evidenceQuote\":\"...\",\"snippetId\":\"F1\",\"refutedPoints\":[{\"point\":\"意见原文中的子断言子句\",\"evidenceQuote\":\"候选片段中的逐字依据\",\"snippetId\":\"F1\"}],\"note\":\"...\"}]}",
    "",
    ...items.flatMap((item, position) => [
      `===== 意见 ${position + 1}（findingId=${item.findingId}；所在章节「${item.section}」；severity=${item.severity}；category=${item.category}）=====`,
      item.description,
      ...(item.quote !== null ? [`意见引用的原文：${item.quote.slice(0, 400)}`] : []),
      ...item.snippets.flatMap((snippet) => [
        `--- 候选片段 [${snippet.snippetId}] 来源章节「${snippet.sourceHeading}」（定位：${snippet.via} ${snippet.matchedTerms.join("、")}；sha256:${snippet.sha256.slice(0, 12)}）---`,
        snippet.text,
      ]),
      "",
    ]),
  ].join("\n");
}

export interface FindingRecheckResult {
  findingId: string;
  verdict: "SUPPORTED" | "REFUTED" | "PARTIALLY_REFUTED" | "NOT_DETERMINABLE";
  evidenceQuote?: string;
  snippetId?: string;
  /** M15.2.1（P1）：复合意见（≥2 独立子断言）REFUTED 时的逐子断言覆盖（point 逐字取自意见原文；evidenceQuote 逐字取自候选片段） */
  refutedPoints?: Array<{ point: string; evidenceQuote: string; snippetId?: string }>;
  note?: string;
}

/** M15.2.1（P1）：复合意见的确定性子断言拆分：句界 / 分号 / 独立子句的并列连接词。
 * 不设上限——解析侧 refutedPoints ≤8 条，因此 >8 个子断言的整条覆盖在数学上不可能达成（天然 fail-closed）。 */
export function findingSubAssertions(description: string): string[] {
  const normalized = description.replace(/\s+/g, " ").trim();
  if (normalized === "") return [];
  const parts = normalized
    .split(/(?<=[.!?。！？])\s+|[；;]/)
    .flatMap((sentence) => sentence.split(/,\s+(?:and|but)\s+(?=[A-Za-z])/i))
    .map((part) => part.trim())
    .filter((part) => part.length >= 8);
  // 只拆出一个（或零个）像样子断言 → 不是复合意见：按整条处理
  return parts.length <= 1 ? [normalized] : parts;
}

export function parseFindingRecheckOutput(parsed: Record<string, unknown>, allowed: ReadonlySet<string>): FindingRecheckResult[] {
  const raw = parsed["results"];
  if (!Array.isArray(raw)) return [];
  const out: FindingRecheckResult[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const findingId = typeof record["findingId"] === "string" ? record["findingId"].trim() : "";
    if (!allowed.has(findingId) || out.some((entry) => entry.findingId === findingId)) continue;
    const verdict = typeof record["verdict"] === "string" ? record["verdict"].trim().toUpperCase().replace(/[\s-]+/g, "_") : "";
    if (verdict !== "SUPPORTED" && verdict !== "REFUTED" && verdict !== "PARTIALLY_REFUTED" && verdict !== "NOT_DETERMINABLE") continue;
    const str = (key: string, max: number) => (typeof record[key] === "string" && (record[key] as string).trim() !== "" ? (record[key] as string).trim().slice(0, max) : undefined);
    // M15.2.1（P1）：复合意见 REFUTED 的逐子断言覆盖（有界解析；point / 依据的逐字校验在 applyFindingRecheck）
    const rawPoints = Array.isArray(record["refutedPoints"]) ? record["refutedPoints"] : [];
    const refutedPoints = rawPoints
      .filter((entry): entry is Record<string, unknown> => typeof entry === "object" && entry !== null)
      .slice(0, 8)
      .flatMap((entry) => {
        const point = typeof entry["point"] === "string" ? entry["point"].trim().slice(0, 200) : "";
        const quote = typeof entry["evidenceQuote"] === "string" ? entry["evidenceQuote"].trim().slice(0, 600) : "";
        const snippetId = typeof entry["snippetId"] === "string" && entry["snippetId"].trim() !== "" ? entry["snippetId"].trim().slice(0, 12) : undefined;
        return point !== "" && quote !== "" ? [{ point, evidenceQuote: quote, ...(snippetId !== undefined ? { snippetId } : {}) }] : [];
      });
    out.push({
      findingId, verdict,
      ...(str("evidenceQuote", 600) !== undefined ? { evidenceQuote: str("evidenceQuote", 600)! } : {}),
      ...(str("snippetId", 12) !== undefined ? { snippetId: str("snippetId", 12)! } : {}),
      ...(refutedPoints.length > 0 ? { refutedPoints } : {}),
      ...(str("note", 400) !== undefined ? { note: str("note", 400)! } : {}),
    });
  }
  return out;
}

/** 复核结果的确定性校验 → 记录（不改 finding 本身） */
export function applyFindingRecheck(
  items: readonly FindingRecheckItem[],
  batches: ReadonlyArray<{ batchId: string; items: readonly FindingRecheckItem[]; status: "COMPLETED" | "FAILED"; results: readonly FindingRecheckResult[] }>,
): FindingRecheckRecord[] {
  const out: FindingRecheckRecord[] = [];
  for (const item of items) {
    const batch = batches.find((entry) => entry.items.some((candidate) => candidate.findingId === item.findingId));
    const base = {
      findingId: item.findingId, issueIndex: item.issueIndex, reason: item.reason,
      snippets: item.snippets.map(({ text: _text, ...rest }) => rest),
      ...(batch !== undefined ? { batchId: batch.batchId } : {}),
    };
    if (batch === undefined || batch.status === "FAILED") {
      out.push({ ...base, outcome: batch === undefined ? "SKIPPED_BUDGET" : "FAILED", validation: batch === undefined ? "未进入复核批次" : "复核调用失败：保持原 finding" });
      continue;
    }
    const result = batch.results.find((entry) => entry.findingId === item.findingId);
    if (result === undefined || result.verdict === "NOT_DETERMINABLE") {
      out.push({ ...base, outcome: "UNRESOLVED", ...(result !== undefined ? { modelVerdict: result.verdict } : {}), validation: result === undefined ? "复核输出没有本条结论" : "复核模型认为片段不足以判断", ...(result?.note !== undefined ? { note: result.note } : {}) });
      continue;
    }
    if (result.evidenceQuote === undefined || compactText(result.evidenceQuote).length < 12) {
      out.push({ ...base, outcome: "UNRESOLVED", modelVerdict: result.verdict, validation: "结论没有给出 ≥12 字的逐字依据", ...(result.note !== undefined ? { note: result.note } : {}) });
      continue;
    }
    const snippet = item.snippets.find((entry) => locateQuote(entry.text, result.evidenceQuote!, 12) !== null);
    if (snippet === undefined) {
      out.push({ ...base, outcome: "UNRESOLVED", modelVerdict: result.verdict, validation: "依据引文不在本条的任何候选片段中（不能作为依据）", ...(result.note !== undefined ? { note: result.note } : {}) });
      continue;
    }
    const span = locateQuote(snippet.text, result.evidenceQuote, 12)!;
    const located = snippet.text.slice(span.start, span.end);
    const containsAssertedTerm = item.assertedTerms.some((term) => containsTerm(located, term));
    if ((result.verdict === "REFUTED" || result.verdict === "PARTIALLY_REFUTED") && item.absenceAssertion && !containsAssertedTerm) {
      out.push({ ...base, outcome: "UNRESOLVED", modelVerdict: result.verdict, evidence: { quote: located, snippetId: snippet.snippetId, containsAssertedTerm }, validation: "反驳缺失型断言的引文不含该断言所指的任何术语：不能确立「别处已给出」", ...(result.note !== undefined ? { note: result.note } : {}) });
      continue;
    }
    // M15.2.1（P1，N1648BF8 r2 #47）：复合意见（≥2 个独立子断言）不得凭单条部分反证整体 REFUTED。
    // 整体 REFUTED 须逐子断言给出 refutedPoints：point 逐字取自意见原文、evidenceQuote 逐字落在候选片段中，
    // 且每个子断言都被某条 point 覆盖；覆盖不全 → 降级 PARTIALLY_REFUTED（fail-closed，不作撤回候选）。
    if (result.verdict === "REFUTED") {
      const parts = findingSubAssertions(item.description);
      if (parts.length > 1) {
        const descriptionNormalized = item.description.replace(/\s+/g, " ").trim();
        const verifiedPoints = (result.refutedPoints ?? []).filter((entry) => {
          const point = entry.point.trim();
          return point.length >= 8 && descriptionNormalized.includes(point)
            && item.snippets.some((candidate) => locateQuote(candidate.text, entry.evidenceQuote, 12) !== null);
        });
        const covered = parts.filter((part) => verifiedPoints.some((entry) => part.includes(entry.point.trim()) || entry.point.trim().includes(part)));
        const complete = covered.length === parts.length;
        out.push({
          ...base,
          outcome: complete ? "REFUTED_BY_DOCUMENT_CONTEXT" : "PARTIALLY_REFUTED_BY_DOCUMENT_CONTEXT",
          modelVerdict: "REFUTED",
          coverage: { subAssertions: parts.length, refutedPoints: verifiedPoints.length, complete },
          evidence: { quote: located, snippetId: snippet.snippetId, containsAssertedTerm },
          validation: complete
            ? `复合意见（${parts.length} 个子断言）：每个子断言都有逐字取自意见原文的 point 与逐字落在候选片段中的依据——整体不成立的候选（模型提出、确定性校验；不自动删除）`
            : `复合意见（${parts.length} 个子断言）的逐子断言覆盖不全（${covered.length}/${parts.length}）：凭部分反证不得整体撤回，降级为部分反驳（fail-closed）`,
          ...(result.note !== undefined ? { note: result.note } : {}),
        });
        continue;
      }
    }
    out.push({
      ...base,
      outcome: result.verdict === "REFUTED" ? "REFUTED_BY_DOCUMENT_CONTEXT" : result.verdict === "PARTIALLY_REFUTED" ? "PARTIALLY_REFUTED_BY_DOCUMENT_CONTEXT" : "CONFIRMED_WITH_DOCUMENT_CONTEXT",
      modelVerdict: result.verdict,
      evidence: { quote: located, snippetId: snippet.snippetId, containsAssertedTerm },
      validation: result.verdict === "REFUTED"
        ? "依据逐字落在候选片段中且包含被断言缺失的术语：该 finding 在全文视角下不成立的候选（模型提出、引文确定性校验；不自动删除）"
        : result.verdict === "PARTIALLY_REFUTED"
          ? "依据逐字落在候选片段中：finding 的一部分已在别处给出，其余部分仍成立（不作撤回候选、不改严重度）"
          : "依据逐字落在候选片段中：跨单元材料支持该 finding（模型判断，非确定性证明）",
      ...(result.note !== undefined ? { note: result.note } : {}),
    });
  }
  return out;
}

export function summarizeFindingRecheck(records: readonly FindingRecheckRecord[]): Record<FindingRecheckOutcome, number> {
  const summary: Record<FindingRecheckOutcome, number> = {
    REFUTED_BY_DOCUMENT_CONTEXT: 0, PARTIALLY_REFUTED_BY_DOCUMENT_CONTEXT: 0, CONFIRMED_WITH_DOCUMENT_CONTEXT: 0, UNRESOLVED: 0, UNRESOLVABLE_NO_PAGE_PROVENANCE: 0, NO_CANDIDATES: 0, SKIPPED_BUDGET: 0, FAILED: 0,
  };
  for (const record of records) summary[record.outcome] += 1;
  return summary;
}
