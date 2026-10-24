/**
 * M15.4.1 CandidateProposer（研究 POC，SHADOW_ONLY）：模型提出「正文科学论断数值 → 表格单元格」的
 * 结构化证据候选，本模块做全部确定性核验。零改动既有生产路径（claimCertificate / claimAudit / gates
 * 均不 import 本文件）；不签发 claim-certificate/v1，只在实验 harness 内输出独立的 ProposalVerification。
 *
 * 架构边界（M15.4.1 预登记 §2，对 M15.4.0 §8 的两处修正）：
 *  - 修正 A（不得制造假唯一）：模型只给候选排名 + 实体/指标/条件映射 + 逐字引文。核验侧独立枚举
 *    全文档所有满足同一 grounding 签名的单元格，>1 → PROPOSAL_NOT_UNIQUE 弃判——提案指向不删除
 *    任何竞争候选。UNIQUE / B2 跨表值守卫 / B3 限定词 / 双钥匙 / 显示精度比较全部在本模块确定性执行。
 *  - 修正 B（不预要求值 OVERLAP）：先独立验证「同一观察量」对应关系（grounding + 唯一性），
 *    再 compareAtoms——正确证据格值 ≠ 正文值可 CONTRADICTED；错误格值 = 正文值绝不能 SUPPORTED。
 *  - grounding 双通道（确定性）：term 的 canonical token 既出现在论断语境、又出现在所指单元格结构语境
 *    （rowKey / headerPath 各层 / caption / label / rowGroup）；或模型给出的 evidenceQuote 逐字
 *    （归一化空白）位于该单元格所在结构的原文（该列的表头格 / 该行的行键格 / 该表题注）——引文定位
 *    是「可独立检查的原文证据」（任务书 §1 修正 A 明列 表头/行名 为合法证据源），语义等价
 *    （macro-F1 ↔ MaF1）只能以此原文形式被采纳，绝不因值碰巧相等被证明。metric 为空（正文不点名
 *    指标）时禁用引文绑定列，只允许值佐证列选择（仿 A2 语义、更严：签名唯一行 + 该行恰一个值重叠格
 *    + 表有题注，只能出 SUPPORTED 路径；CONTRADICTED 必须有 metric 文字/引文识别）。
 *  - 值只由解析器从源文件读取（模型输出不含任何数值字段）；confidence 仅诊断。
 *
 * 复用（不重复造轮子）：latexTable 全套结构锚、claimCertificate 的 textScopes/contextTokens/
 * atomQualifiers/locateAtom/compareAtoms、内容寻址 tableId、claimAudit 的逐字定位纪律。
 *
 * M15.4.2（B4 去重）：STOP / OWN_ROW / OWN_ALIASES / QUALIFIER 词表 / 派生列正则 / rowIsOwn / B2 跨表 /
 * B3 限定词判别不再本地复制，统一 import claimGuards.ts（与生产证书器同一事实来源）。
 * M15.4.2 新增（预登记 BASELINE_AND_PRE_REGISTERED_GATES §5 白名单，全部 fail-closed 方向）：
 *  - M1 回指锚定：封闭词表的回指主语（this method / the model / the same two models …）只能通过程序在
 *    同段落确定性窗口内逐字定位的行键专名锚（或本文自指锚）解析；多前件 = ANTECEDENT_NOT_UNIQUE。
 *    模型自然语言解释不是 provenance；回指情形下模型 subject 字段被程序锚替换，不得注入任意名字。
 *  - M2 引文四分类：SOURCE_VERBATIM / PARSER_RENDERED_VERBATIM（含程序生成的行引用 = 行组+行矩阵
 *    拼接，解析器结构重组而非自由文本）可用；MODEL_PARAPHRASE / UNLOCATABLE 仅排除、不得作证据；
 *    全部引文不可用 → 维持整案拒绝（防伪造 tripwire 不撤）。
 *  - M4 claim 侧 context 词丢弃：不在论断句/锚文本的 context 词丢弃并记录（过滤只降不升 → 竞争更多
 *    → 唯一性更严）；subject/metric 仍必须锚定。
 *  - 映射见证（mapping-witness/v1）：claimAtom、canonical 格、程序生成引文（含源偏移）、回指锚
 *    [start,end) 原文与竞争前件、逐条引文判定、逐 term grounding、唯一性签名与关系、B2/B3 结论。
 */

import { contextTokens, locateAtom, textScopes, atomQualifiers, compareAtoms, type CertificateAtom, type CertificateDocument } from "./claimCertificate.js";
import { plainLatexText, type LatexTable, type LatexTableCell } from "./latexTable.js";
import {
  DERIVED_COLUMN_HEADER, OWN_ALIASES, OWN_ROW, STOP, crossTableValueCompetitors, qualifierRejections,
  rowIsOwn as rowIsOwnCell, type GuardContext,
} from "./claimGuards.js";

// v1→v2（M15.4.1 DEV smoke 后唯一一次 prompt 修订，逐条记录于 FREEZE_MANIFEST）：
//   metric 指引补「纯单位/泛词（ms/%/dB/score/result）不算指标」；conditions 要求短单词；
//   evidenceQuotes 禁 '...' 缩写；abstain 须非空 reason 且仅在无表格观察时使用。
export const PROPOSER_PROMPT_VERSION = "candidate-proposer/v2";
// M15.4.2：验证协议升级（M1/M2/M4 + 共享守卫 + 映射见证）；prompt 不变，已落盘提案可零成本重放。
export const PROPOSER_ADAPTER_VERSION = "candidate-proposer-adapter/v2";
export const MAPPING_WITNESS_VERSION = "mapping-witness/v1";

// ---- 词表/守卫单一来源：claimGuards.ts（M15.4.2 B4；此前为保 dist 字节不变的本地拷贝，已删除） ----

// ---- 类型 ----

export interface ProposerCandidateRaw {
  tableAlias: string;
  rowAlias: string;
  colAlias: string;
  interpretation: string;
  evidenceQuotes: string[];
}

export interface RawProposal {
  claimId: string;
  subject: string;
  metric: string;
  dataset: string;
  conditions: string[];
  comparison: "CONSISTENT" | "INCONSISTENT" | "";
  candidates: ProposerCandidateRaw[];
  abstain?: { reason: string };
  confidence?: number;
}

export interface ResolvedCell {
  file: string;
  tableId: string;
  tableIndex: number;
  row: number;
  col: number;
  rowKey: string[];
  headerPath: string[];
  caption: string | null;
  label: string | null;
}

export interface ResolvedCandidate {
  raw: ProposerCandidateRaw;
  status: "RESOLVED" | "ALIAS_INVALID" | "CELL_NOT_NUMERIC";
  cell?: ResolvedCell;
  value?: { raw: string; value: number; decimals: number; unit: string | null };
}

export interface ResolvedProposal {
  claimId: string;
  raw: RawProposal;
  candidates: ResolvedCandidate[];
  resolvedAt: string;
}

export type ProposalAbstainCategory =
  | "PROPOSAL_SCHEMA_INVALID" | "PROPOSAL_ALIAS_INVALID" | "PROPOSER_ABSTAIN" | "CLAIM_QUALIFIER_NOT_CERTIFIABLE" | "DERIVED_RECOMPUTE_OUT_OF_SCOPE"
  | "NO_VALID_CANDIDATE" | "PROPOSAL_QUOTE_NOT_FOUND" | "PROPOSAL_TERM_NOT_IN_CLAIM" | "GROUNDING_FAILED" | "PROPOSAL_NOT_UNIQUE"
  | "UNEXPLAINED_QUALIFIER" | "VALUE_APPEARS_IN_OTHER_TABLE" | "UNIT_MISMATCH" | "SCALE_AMBIGUOUS" | "TABLE_PARSE_ISSUES"
  | "MODEL_CHECK_MISSING" | "MODEL_CHECK_DISAGREES" | "CLAIM_ATOM_NOT_LOCATED"
  // M15.4.2（M1）：
  | "PROPOSAL_ANTECEDENT_NOT_UNIQUE" | "PROPOSAL_ANTECEDENT_NOT_FOUND";

/** M2 引文判定：只有前两类可作为确定性引用来源 */
export type QuoteVerdictKind = "SOURCE_VERBATIM" | "PARSER_RENDERED_VERBATIM" | "MODEL_PARAPHRASE" | "UNLOCATABLE";

export interface QuoteVerdict {
  quote: string;
  verdict: QuoteVerdictKind;
}

/** M1 回指锚见证：程序在同段落窗口内逐字定位的前文锚 */
export interface AnaphoraWitness {
  phrase: string;
  kind: "NAMED" | "COORDINATED" | "OWN";
  /** 锚原文 span（源文件内偏移）；OWN 路线记录自指词出现处 */
  anchors: Array<{ file: string; start: number; end: number; text: string }>;
  /** 解析出的有效主语（替代模型 subject 字段） */
  effectiveSubject: string;
  /** 窗口内全部候选前件（含被排除的），证明唯一性判断没有隐藏竞争者 */
  alternativesConsidered: string[];
}

/** M15.4.2 映射见证：proposal → canonical 格对应关系的全部可验证证据链 */
export interface MappingWitness {
  version: typeof MAPPING_WITNESS_VERSION;
  claimAtom: { file: string; start: number; end: number; raw: string; value: number; decimals: number; unit: string | null; qualifiers: string[] };
  proposalEcho: { subject: string; metric: string; dataset: string; conditions: string[]; comparison: string; topCandidate: { tableAlias: string; rowAlias: string; colAlias: string } };
  resolvedCell: ResolvedCell;
  /** 程序生成的引文（值/行/列/题注，均可回溯解析器结构与源文件偏移） */
  citations: {
    value: { raw: string; sourceFile: string; start: number | null; end: number | null };
    row: { text: string; sourceFile: string; tableId: string; row: number; rowGroup: string | null; rowKey: string[] };
    column: { headerPath: string[] };
    caption: string | null;
    label: string | null;
  };
  quotes: QuoteVerdict[];
  anaphora?: AnaphoraWitness;
  /** 逐 term grounding 落位记录 */
  termGroundings: Array<{ kind: "SUBJECT" | "METRIC" | "CONTEXT"; term: string; anchored: boolean; where: string }>;
  droppedContextTerms: string[];
  uniqueness: { signatureSubject: string; signatureMetric: string; signatureContext: string[]; hitCount: number; hitRelation: string; valueCorroborated: boolean; multiBinding: { count: number; unanimous: string } | null };
  guards: { unexplainedQualifiers: string[]; crossTableCompetitors: string[]; parseIssues: string[] };
  checks: string[];
}

export type ProposalVerification =
  | {
      status: "ACCEPTED";
      claimId: string;
      outcome: "SUPPORTED" | "CONTRADICTED";
      cell: ResolvedCell;
      value: NonNullable<ResolvedCandidate["value"]>;
      grounding: { subject: string; metric: string; context: string[]; valueCorroborated: boolean };
      relation: string;
      modelCheck: "CONSISTENT" | "INCONSISTENT";
      checks: string[];
      witness: MappingWitness;
    }
  | {
      status: "ABSTAIN";
      claimId: string;
      reason: string;
      detail: string;
      category: ProposalAbstainCategory;
      topCandidate?: ResolvedCell;
      competitorCount?: number;
      witness?: MappingWitness;
    };

// ---- 表格 allowlist（别名由 PaperTeam 生成；模型只能从中选择，不得自造 canonical id） ----

export interface TableAllowlist {
  tables: Array<{
    alias: string;
    file: string;
    tableIndex: number;
    tableId: string;
    caption: string | null;
    label: string | null;
    columns: Array<{ alias: string; col: number; headerPath: string[] }>;
    rows: Array<{ alias: string; row: number; rowKey: string[]; rowGroup: string | null }>;
    matrix: string[][];
    truncated: boolean;
    parseIssues: string[];
  }>;
  totalNumericCells: number;
  omittedCells: number;
}

const MAX_TABLE_CHARS = 20_000;
const MAX_TOTAL_CHARS = 60_000;

function cellDisplayValue(cell: LatexTableCell | undefined): string {
  if (cell === undefined) return "";
  if (cell.isHeader) return cell.text;
  return cell.value === null ? cell.text : cell.value.raw;
}

/** 稳定别名：文件按路径排序、表按 tableIndex → T1..Tn；行 R<row.index+1>；列 C<col+1>（确定性，重跑不变） */
export function buildTableAllowlist(document: CertificateDocument, limits: { maxTableChars?: number; maxTotalChars?: number } = {}): TableAllowlist {
  const maxTable = limits.maxTableChars ?? MAX_TABLE_CHARS;
  const maxTotal = limits.maxTotalChars ?? MAX_TOTAL_CHARS;
  const files = [...document.files].sort((a, b) => (a.file < b.file ? -1 : 1));
  const tables: TableAllowlist["tables"] = [];
  let totalNumericCells = 0;
  let omittedCells = 0;
  let n = 0;
  let budget = maxTotal;
  for (const file of files) {
    for (const table of file.tables) {
      n += 1;
      totalNumericCells += table.cells.filter((c) => c.value !== null && !c.isHeader).length;
      const columns = new Map<number, string[]>();
      for (const cell of table.cells) if (!cell.isHeader && cell.value !== null && !columns.has(cell.col)) columns.set(cell.col, cell.headerPath);
      const colList = [...columns.entries()].sort((a, b) => a[0] - b[0]).map(([col, headerPath]) => ({ alias: `C${col + 1}`, col, headerPath }));
      const rowList = table.rows
        .filter((row) => row.cells.some((c) => c.rowKey.length > 0))
        .map((row) => {
          const key = row.cells.find((c) => c.rowKey.length > 0);
          return { alias: `R${row.index + 1}`, row: row.index, rowKey: key?.rowKey ?? [], rowGroup: key?.rowGroup ?? null };
        });
      // 数值矩阵（含表头行）；超预算截去尾部数据行并如实标记（截断只影响模型可见性，不影响核验枚举）
      const matrix: string[][] = [];
      let used = 0;
      let truncated = false;
      for (const row of table.rows) {
        const line: string[] = [];
        for (let c = 0; c < table.columnCount; c += 1) {
          const cell = row.cells.find((entry) => entry.col === c || (entry.col < c && c < entry.col + entry.colSpan));
          const text = cellDisplayValue(cell);
          line.push(text);
          used += text.length + 1;
        }
        if (used > maxTable || budget - used < 0) {
          truncated = true;
          omittedCells += row.cells.filter((c) => c.value !== null).length;
          continue;
        }
        matrix.push(line);
        budget -= used;
      }
      tables.push({
        alias: `T${n}`, file: file.file, tableIndex: table.tableIndex, tableId: table.tableId, caption: table.caption, label: table.label,
        columns: colList, rows: rowList, matrix, truncated, parseIssues: table.parseIssues,
      });
    }
  }
  return { tables, totalNumericCells, omittedCells };
}

/** 模型可见的表格摘要（allowlist 文本形态；截断如实标注） */
export function renderAllowlist(allowlist: TableAllowlist): string {
  const parts: string[] = [];
  for (const table of allowlist.tables) {
    const header = `# ${table.alias} [file=${table.file} table#${table.tableIndex + 1} id=${table.tableId}] caption=${table.caption ?? "(none)"} label=${table.label ?? "(none)"}${table.parseIssues.length > 0 ? ` PARSE_ISSUES=${table.parseIssues.join(",")}` : ""}${table.truncated ? " [TRUNCATED: tail rows omitted]" : ""}`;
    const cols = `columns: ${table.columns.map((c) => `${c.alias}=${c.headerPath.join("/")}`).join(" | ") || "(none)"}`;
    const rows = `rows: ${table.rows.map((r) => `${r.alias}=${[r.rowGroup ?? "", ...r.rowKey].filter(Boolean).join("/")}`).join(" | ") || "(none)"}`;
    const matrix = table.matrix.map((line) => `  ${line.join(" & ")}`).join("\n");
    parts.push([header, cols, rows, "matrix:", matrix].join("\n"));
  }
  return parts.join("\n\n");
}

// ---- Prompt ----

export interface ProposerClaimInput {
  claimId: string;
  file: string;
  claimSentence: string;
  contextBefore: string;
  contextAfter: string;
  claimValue: string;
}

export function buildProposerPrompt(claim: ProposerClaimInput, allowlist: TableAllowlist, documentTitle: string): string {
  return [
    `You are auditing the internal numerical consistency of a research paper titled "${documentTitle}".`,
    `A single quantitative claim sentence from the paper is given. Identify which table cell (if any) the target number refers to, i.e. the experimental observation that the number is about.`,
    ``,
    `CLAIM ${claim.claimId}:`,
    `context-before: ${claim.contextBefore}`,
    `SENTENCE: ${claim.claimSentence}`,
    `context-after: ${claim.contextAfter}`,
    `target number: ${claim.claimValue}`,
    ``,
    `TABLES OF THE PAPER (allowlist; aliases are fixed):`,
    renderAllowlist(allowlist),
    ``,
    `Return STRICT JSON only (no prose, no markdown fences) with this schema:`,
    `{`,
    `  "claimId": "${claim.claimId}",`,
    `  "subject": "<who owns the number: short term COPYING THE SENTENCE'S WORDING, e.g. the method name or 'ours'>",`,
    `  "metric": "<the measured quantity as worded IN THE SENTENCE, e.g. 'Macro-F1'; use "" if the sentence names no metric or only a unit/generic word like ms/%/dB/score/result>",`,
    `  "dataset": "<dataset/benchmark/subset as worded IN THE SENTENCE; "" if none>",`,
    `  "conditions": ["<extra setting words from the sentence, each a SHORT single word, e.g. 'window-level', 'reproduced', 'Dimensity'>"],`,
    `  "comparison": "<compare the target number with the value of your top candidate cell: 'CONSISTENT' if equal within display precision, 'INCONSISTENT' if different>",`,
    `  "candidates": [ { "tableAlias": "T#", "rowAlias": "R#", "colAlias": "C#", "interpretation": "<one sentence: why this cell is the observation the claim number refers to>", "evidenceQuotes": ["<verbatim short quotes copied from the SENTENCE / table captions / column headers / row names above that ground this mapping>"] } ],`,
    `  "abstain": { "reason": "<use only when the sentence's number is not about any table cell>" },`,
    `  "confidence": 0.0`,
    `}`,
    `Rules: candidates must be ranked best-first (max 3). subject/metric/dataset/conditions MUST reuse words that appear in the SENTENCE (do not invent names not written there); leave metric empty if unnamed or only a unit/generic word. conditions entries must be short single words. evidenceQuotes must be EXACT verbatim substrings of the material above (never abbreviate with '...' and never rewrite LaTeX). Do NOT restate the target number's value in subject/metric/dataset. Set abstain (with a non-empty reason) ONLY if the number matches no table observation; otherwise list candidates.`,
  ].join("\n");
}

// ---- 响应解析（防御性 JSON，仿 paper-qa llm_parse_json 思路：剥代码栅栏 + 首尾花括号平衡截取） ----

export function parseProposerResponse(text: string): { proposal: RawProposal | null; error: string | null } {
  const cleaned = text.replace(/```(?:json)?/g, "").trim();
  const start = cleaned.indexOf("{");
  if (start < 0) return { proposal: null, error: "NO_JSON_OBJECT" };
  let depth = 0;
  let end = -1;
  let inString = false;
  let escape = false;
  for (let i = start; i < cleaned.length; i += 1) {
    const ch = cleaned[i]!;
    if (escape) { escape = false; continue; }
    if (ch === "\\") { escape = true; continue; }
    if (ch === '"') { inString = !inString; continue; }
    if (inString) continue;
    if (ch === "{") depth += 1;
    else if (ch === "}") {
      depth -= 1;
      if (depth === 0) { end = i; break; }
    }
  }
  if (end < 0) return { proposal: null, error: "UNBALANCED_JSON" };
  let parsed: unknown;
  try {
    parsed = JSON.parse(cleaned.slice(start, end + 1));
  } catch (error) {
    return { proposal: null, error: `JSON_PARSE_ERROR:${error instanceof Error ? error.message.slice(0, 80) : "unknown"}` };
  }
  const obj = parsed as Record<string, unknown>;
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const candidatesRaw = Array.isArray(obj["candidates"]) ? obj["candidates"] : [];
  const candidates: ProposerCandidateRaw[] = [];
  for (const entry of candidatesRaw.slice(0, 3)) {
    if (typeof entry !== "object" || entry === null) continue;
    const c = entry as Record<string, unknown>;
    candidates.push({
      tableAlias: str(c["tableAlias"]), rowAlias: str(c["rowAlias"]), colAlias: str(c["colAlias"]),
      interpretation: str(c["interpretation"]),
      evidenceQuotes: Array.isArray(c["evidenceQuotes"]) ? c["evidenceQuotes"].filter((q): q is string => typeof q === "string").slice(0, 6) : [],
    });
  }
  const comparison = str(obj["comparison"]).toUpperCase();
  const abstainReason = typeof obj["abstain"] === "object" && obj["abstain"] !== null ? str((obj["abstain"] as Record<string, unknown>)["reason"]) : "";
  const abstain = abstainReason.trim() !== "" ? { reason: abstainReason } : undefined;
  const proposal: RawProposal = {
    claimId: str(obj["claimId"]),
    subject: str(obj["subject"]), metric: str(obj["metric"]), dataset: str(obj["dataset"]),
    conditions: Array.isArray(obj["conditions"]) ? obj["conditions"].filter((t): t is string => typeof t === "string").slice(0, 5) : [],
    comparison: comparison === "CONSISTENT" || comparison === "INCONSISTENT" ? comparison : "",
    candidates,
    ...(abstain !== undefined ? { abstain } : {}),
    ...(typeof obj["confidence"] === "number" ? { confidence: obj["confidence"] } : {}),
  };
  if (proposal.candidates.length === 0 && proposal.abstain === undefined) return { proposal: null, error: "NO_CANDIDATES_NO_ABSTAIN" };
  return { proposal, error: null };
}

// ---- alias → canonical 解析（值只由解析器读，模型不得填值） ----

function normalizedCellValue(cell: LatexTableCell): { raw: string; value: number; decimals: number; unit: string | null } {
  const v = cell.value!;
  if (v.unit === "k") return { raw: v.raw, value: v.value * 1000, decimals: v.decimals - 3, unit: null };
  return { raw: v.raw, value: v.value, decimals: v.decimals, unit: v.unit };
}

export function resolveProposal(document: CertificateDocument, raw: RawProposal, allowlist: TableAllowlist): ResolvedProposal {
  const candidates: ResolvedCandidate[] = raw.candidates.map((entry) => {
    const table = allowlist.tables.find((t) => t.alias === entry.tableAlias);
    const rowMatch = /^R(\d+)$/.exec(entry.rowAlias);
    const colMatch = /^C(\d+)$/.exec(entry.colAlias);
    if (table === undefined || rowMatch === null || colMatch === null) return { raw: entry, status: "ALIAS_INVALID" as const };
    const row = Number(rowMatch[1]) - 1;
    const col = Number(colMatch[1]) - 1;
    const file = document.files.find((f) => f.file === table.file);
    const latexTable = file?.tables[table.tableIndex];
    if (latexTable === undefined) return { raw: entry, status: "ALIAS_INVALID" as const };
    const cell = latexTable.cells.find((c) => c.row === row && c.value !== null && !c.isHeader && (c.col === col || (c.col < col && col < c.col + c.colSpan)));
    if (cell === undefined) return { raw: entry, status: "CELL_NOT_NUMERIC" as const };
    return {
      raw: entry, status: "RESOLVED" as const,
      cell: { file: table.file, tableId: latexTable.tableId, tableIndex: latexTable.tableIndex, row, col, rowKey: cell.rowKey, headerPath: cell.headerPath, caption: latexTable.caption, label: latexTable.label },
      value: normalizedCellValue(cell),
    };
  });
  return { claimId: raw.claimId, raw, candidates, resolvedAt: new Date().toISOString() };
}

// ---- 确定性核验（SHADOW_ONLY：不签发 claim-certificate/v1） ----

const norm = (text: string): string => plainLatexText(text).replace(/\s+/g, " ").trim().toLowerCase();
const tokensOf = (text: string): Set<string> => new Set(contextTokens(text).filter((t) => !STOP.has(t) && t.length >= 2));
const hasCjk = (text: string): boolean => /[一-鿿]/.test(text);

interface GroundingTerms {
  subject: string[];
  metric: string[];
  context: string[];
}

/** 并列主语拆分：「Gemma-3 27B and Qwen3 32B」→ [[Gemma-3,27B],[Qwen3,32B]]（无并列 = 单 alternative） */
function subjectAlternatives(subject: string[]): string[][] {
  const joined = subject.join(" ");
  const parts = joined.split(/\s+(?:and|\+|\/|,|;)\s+/i).map((alt) => alt.trim().split(/[\s,;]+/).filter(Boolean)).filter((alt) => alt.length > 0);
  return parts.length > 1 ? parts : [subject];
}

function groundingTermsOf(proposal: RawProposal): GroundingTerms {
  const split = (s: string): string[] => (s.trim() === "" ? [] : s.trim().split(/\s*[,;]\s*|\s+/).filter(Boolean));
  return { subject: split(proposal.subject), metric: split(proposal.metric), context: [...split(proposal.dataset), ...proposal.conditions] };
}

interface StructureSpans {
  file: string;
  content: string;
  table: LatexTable;
  cell: LatexTableCell;
}

function structureOf(document: CertificateDocument, cell: ResolvedCell): StructureSpans | null {
  const file = document.files.find((f) => f.file === cell.file);
  const table = file?.tables[cell.tableIndex];
  if (file === undefined || table === undefined) return null;
  const target = table.cells.find((c) => c.row === cell.row && c.value !== null && !c.isHeader && (c.col === cell.col || (c.col < cell.col && cell.col < c.col + c.colSpan)));
  if (target === undefined) return null;
  return { file: file.file, content: file.content, table, cell: target };
}

/** term grounding：canonical token 全部出现在该语境，或 term 原文逐字（归一化空白）出现在结构原文中。
 *  复合 token（含 -_/.@）在其全部部件都在语境中出现时视为匹配（「Llama-3.3」↔ 行键「Llama 3.3」）。 */
function termGroundedIn(term: string, contextTokens: Set<string>, structureTexts: string[]): boolean {
  if (term.trim() === "") return true;
  if (structureTexts.some((text) => norm(text).includes(norm(term)))) return true;
  const tokens = [...tokensOf(term)];
  if (tokens.length === 0) return true; // 纯停用词（the/model/score…）不承载身份；主语须另有实词或本文别名
  return tokens.every((token) => tokenGroundedEvery(token, contextTokens, structureTexts));
}

/**
 * 单个 token 的落位判定：token 集 / CJK 包含 / 复合部件桥。
 * 复合部件桥：非数字部件须落在 token 集（「Llama-3.3」的 llama）；数字部件因 contextTokens 按惯例
 * 剔除纯数字而改为「结构原文含该数字子串」（「Llama-3.3」的 3.3 ∈ 行键原文「Llama 3.3 70B FP8」；
 * 「top-1」的 1 ∉ 「Top-3 Acc.」原文 → 不会借裸词 top 落到 Top-3 列）。
 */
function tokenGroundedEvery(token: string, contextTokens: Set<string>, structureTexts: string[]): boolean {
  if (contextTokens.has(token)) return true;
  if (hasCjk(token) && [...contextTokens].some((t) => t.includes(token) || token.includes(t))) return true;
  if (!/[-_/.@]/.test(token)) return false;
  const parts = token.split(/[-_/.@]/).filter(Boolean);
  const numeric = parts.filter((part) => /^\d+(?:[.,]\d+)?$/.test(part));
  const words = parts.filter((part) => !/^\d+(?:[.,]\d+)?$/.test(part));
  const wordsOk = words.every((part) => contextTokens.has(part));
  const numericOk = numeric.every((part) => structureTexts.some((text) => norm(text).includes(part)));
  return wordsOk && numericOk;
}

/** 条件词（dataset/conditions）grounding 三分法：
 *  - 复合 token（含 -_/.@，如 bench-r / window-level / held-out）是论断的特异书面形 → 必须全部落位
 *    （「Bench-R」的 bench-r 不得借裸词 bench 落到 Bench-W 表——复合形失位即排除该表）；
 *  - 简单 token 任一落位即可（「MediaTek Dimensity 9500 NPU」↔ 列头「Dimensity NPU (ms)」共享
 *    Dimensity/NPU 即证同指——过滤强度只降不升 → 竞争变多 → 唯一性更严，fail-closed 方向）；
 *  - 全域（所有表语境）无任何落位的条件词是纯修饰词（如 fastest），不承载判别信息 → 由调用方丢弃。 */
function termGroundedContext(term: string, contextTokens: Set<string>, structureTexts: string[]): boolean {
  if (term.trim() === "") return true;
  if (structureTexts.some((text) => norm(text).includes(norm(term)))) return true;
  const tokens = [...tokensOf(term)];
  if (tokens.length === 0) return true;
  const compounds = tokens.filter((token) => /[-_/.@]/.test(token));
  if (compounds.length > 0) return compounds.every((token) => tokenGroundedEvery(token, contextTokens, structureTexts));
  return tokens.some((token) => tokenGroundedEvery(token, contextTokens, structureTexts));
}

/** 该列的表头格原文（含 multicolumn 覆盖） */
function columnHeaderTexts(spans: StructureSpans): string[] {
  return spans.table.cells
    .filter((c) => c.isHeader && (c.col === spans.cell.col || (c.col < spans.cell.col && spans.cell.col < c.col + c.colSpan)))
    .map((c) => c.text);
}

/** 该行的行键格原文 */
function rowKeyTexts(spans: StructureSpans): string[] {
  return spans.table.rows.find((r) => r.index === spans.cell.row)?.cells.filter((c) => c.rowKey.length > 0).map((c) => c.text) ?? [];
}

/** 表语境原文（题注/label/行组/表头上层） */
function tableContextTexts(spans: StructureSpans): string[] {
  return [spans.table.caption ?? "", spans.table.label ?? "", spans.cell.rowGroup ?? "", ...spans.cell.headerPath.slice(0, -1)];
}

/** B3 限定词（M15.4.2 B4：与生产证书器同一判别 = claimGuards.qualifierRejections；语境组装保持本臂口径） */
function unexplainedQualifiers(segment: string, spans: StructureSpans): string[] {
  const contextText = [...tableContextTexts(spans), ...rowKeyTexts(spans), ...columnHeaderTexts(spans)].join(" \n ");
  return qualifierRejections(guardContextOf(segment), guardContextOf(contextText));
}

/** B2（M15.4.2 B4：与生产证书器同一判别 = claimGuards.crossTableValueCompetitors）；多命中/单命中统一入口 */
function valueAppearsInOtherTablesMulti(document: CertificateDocument, hits: Array<{ file: string; tableIndex: number }>, claimRaw: string): string[] {
  return crossTableValueCompetitors(document, hits, claimRaw);
}

function valueAppearsInOtherTable(document: CertificateDocument, spans: StructureSpans, claimRaw: string): string[] {
  return crossTableValueCompetitors(document, [{ file: spans.file, tableIndex: spans.table.tableIndex }], claimRaw);
}

/** 行是否本文方法行（claimGuards.rowIsOwn 同一判别） */
function rowIsOwn(document: CertificateDocument, spans: StructureSpans): boolean {
  return rowIsOwnCell(document, spans.cell);
}

/** GuardContext 构建（claimGuards.mentions 的输入形态；非守卫逻辑本身） */
function guardContextOf(text: string): GuardContext {
  return { tokens: new Set(contextTokens(text)), plain: plainLatexText(text).toLowerCase() };
}

/**
 * 签名枚举（修正 A 的核心）：对全文档所有数值格，用与提案完全相同的 grounding 规则统计满足
 * subject+metric+context 全部 grounded 的单元格。模型指向不参与枚举——它不能删除任何竞争候选。
 * metric 为空 → 列不约束（供值佐证规则用行签名）。subject 为空 → 无有效签名（恒空）。
 *
 * M15.4.2 枚举修正（全部 fail-closed：命中集只减不增；逐条记录于报告偏差表）：
 *  - FIX-2（引文列绑定不得绕过数值部件失配）：「Top-1」在「Top-3 Acc.」上的 term 判定本就拒绝
 *    （数字部件 1∉原文）；此前全局引文池的 quoteIn 旁路让其他候选的「Top-3 Acc.」引文反过来放行
 *    Top-3 列——数字翻转被拦截，缩写桥（macro-F1↔MaF1，纯字母部件）不受影响。
 *  - FIX-1b（行级 context 判别器）：context 词在同表内若对部分命中行的行键/行组落位、对另一部分
 *    不落位，则只保留落位行（表级 caption 同时提到多场景时不能充当行内判别——「on the ASM gasoline
 *    engine case」应由行键场景段裁决，而非 caption）。
 *  - D1（转置表方向 B）：subject 可落列表头叶子（方法名列、指标行），此时 metric 落行键——与生产
 *    绑定器 bindTextAtom 的 useA/useB 双方向一致（M15.2 起生产已有，POC 此前缺失）。
 *  - D2（单位判别器）：命中 >1 且 atom 带单位时，单位不同的命中行被剔除（「12.00 dB」的 AB 只能是
 *    PSNR (dB)/AB 而不是 SSIM/AB——无单位格与有单位格不竞逐）。
 */
export function enumerateSignature(document: CertificateDocument, termsIn: GroundingTerms, quotes: string[], metricUnconstrained: boolean, atomUnit?: string | null): { hits: Map<string, ResolvedCell>; notes: string[] } {
  const hits = new Map<string, ResolvedCell>();
  const notes: string[] = [];
  if (termsIn.subject.length === 0) return { hits, notes };
  // 条件词可用性：全域任何表语境都无落位的词不承载判别信息（纯修饰词），丢弃
  const allContextTexts = document.files.flatMap((file) =>
    file.tables.flatMap((table) => [table.caption ?? "", table.label ?? "", ...table.cells.flatMap((c) => [c.rowGroup ?? "", ...c.headerPath, ...c.rowKey])]),
  );
  const allContextTokens = tokensOf(allContextTexts.join(" ") || " ");
  const terms: GroundingTerms = { ...termsIn, context: termsIn.context.filter((t) => termGroundedContext(t, allContextTokens, allContextTexts)) };
  const subjectIsOwn = terms.subject.some((t) => OWN_ROW.test(t) || OWN_ALIASES.test(t)) || OWN_ALIASES.test(terms.subject.join(" "));
  const subjectAlts = subjectAlternatives(terms.subject);
  const quoteIn = (texts: string[]): boolean => quotes.some((q) => texts.some((text) => verbatimIncludes(text, q)));
  /** FIX-2：metric term 的纯数字部件必须落在列结构原文（数字不可被引文翻转；字母部件可由引文桥接） */
  const numericPartsGrounded = (term: string, texts: string[]): boolean => {
    for (const token of tokensOf(term)) {
      for (const part of token.split(/[-_/.@]/).filter((p) => /^\d+(?:[.,]\d+)?$/.test(p))) {
        if (!texts.some((text) => norm(text).includes(part))) return false;
      }
    }
    return true;
  };
  /**
   * FIX-2b：引文绑定列的窄化——引文必须落在该列叶子表头文本内，或与 metric 词共享至少一个 token。
   * 父级表头引文（「PSNR (dB)」是多列共享的上层维度）不得证明叶子指标身份（「AB」≠「A」/「F」）；
   * 缩写桥（「MaF1」引文 ⊆ 叶子「MaF1」）与单位形（「Acc. (%)」与 accuracy 共享 acc→accuracy）不受影响。
   */
  const metricQuoteBinds = (metricTerms: string[], leafText: string, columnTexts: string[]): boolean => {
    const metricTokenSet = new Set(metricTerms.flatMap((t) => [...tokensOf(t)]));
    return quotes.some((q) => {
      const inColumn = columnTexts.some((text) => verbatimIncludes(text, q));
      if (!inColumn) return false;
      const inLeaf = verbatimIncludes(leafText, q);
      if (inLeaf) return true;
      return [...tokensOf(q)].some((token) => metricTokenSet.has(token));
    });
  };
  for (const file of document.files) {
    for (const table of file.tables) {
      if (table.parseIssues.includes("NESTED_TABULAR")) continue;
      const tableHits: Array<{ key: string; cell: LatexTableCell; spans: StructureSpans; transposed: boolean }> = [];
      for (const cell of table.cells) {
        if (cell.value === null || cell.isHeader || cell.rowKey.length === 0) continue;
        const spans: StructureSpans = { file: file.file, content: file.content, table, cell };
        // subject grounding：本文别名 → 行须本文行；否则 term 逐 token/逐字落行键语境（A）或列表头叶子（B，转置表）
        const rowTokens = tokensOf([...rowKeyTexts(spans), ...(cell.rowGroup ? [cell.rowGroup] : "")].join(" ") || " ");
        const headerLeafTokens = tokensOf(cell.headerPath.slice(-1).join(" ") || " ");
        const subjectOkA = subjectIsOwn
          ? rowIsOwn(document, spans)
          : subjectAlts.some((alt) => alt.every((t) => termGroundedIn(t, rowTokens, rowKeyTexts(spans))));
        const subjectOkB = !subjectIsOwn && !subjectOkA
          && subjectAlts.some((alt) => alt.every((t) => termGroundedIn(t, headerLeafTokens, columnHeaderTexts(spans))));
        if (!subjectOkA && !subjectOkB) continue;
        const transposed = subjectOkB;
        // metric grounding（不约束时跳过）：方向 A → 列表头；方向 B（转置）→ 行键（指标在行）
        if (!metricUnconstrained && terms.metric.length > 0) {
          if (!transposed) {
            const headerTokens = tokensOf(cell.headerPath.join(" ") || " ");
            const metricOk = terms.metric.every((t) => termGroundedIn(t, headerTokens, columnHeaderTexts(spans)))
              || (terms.metric.every((t) => numericPartsGrounded(t, columnHeaderTexts(spans))) && metricQuoteBinds(terms.metric, cell.headerPath.slice(-1).join(" "), columnHeaderTexts(spans)));
            if (!metricOk) continue;
          } else {
            const rowKeyMetricTexts = [...rowKeyTexts(spans), ...(cell.rowGroup ? [cell.rowGroup] : "")];
            const metricOk = terms.metric.every((t) => termGroundedIn(t, rowTokens, rowKeyMetricTexts));
            if (!metricOk) continue;
          }
        }
        // dataset/conditions grounding：表语境（题注/label/行组/全列表头路径）+ 行键语境（场景列是行键的一部分）。
        // 条件词是过滤器：term 级 any-token（见 termGroundedAnyToken 注释）。
        if (terms.context.length > 0) {
          const contextTexts = [...tableContextTexts(spans), ...rowKeyTexts(spans), cell.headerPath.join(" ")];
          const contextTokens = tokensOf(contextTexts.join(" ") || " ");
          const contextOk = terms.context.every((t) => termGroundedContext(t, contextTokens, contextTexts)) || quoteIn([spans.table.caption ?? "", spans.table.label ?? ""]);
          if (!contextOk) continue;
        }
        tableHits.push({ key: `${file.file}|${table.tableId}|${cell.row}|${cell.col}`, cell, spans, transposed });
      }
      // FIX-1b：同表内行级 context 判别器——context 词对部分命中行行级落位、部分不落位 → 只保留落位行
      let survivors = tableHits;
      if (terms.context.length > 0 && tableHits.length > 1) {
        for (const term of terms.context) {
          const groundedFlags = tableHits.map((h) => {
            const texts = [...rowKeyTexts(h.spans), ...(h.cell.rowGroup ? [h.cell.rowGroup] : "")];
            return termGroundedContext(term, tokensOf(texts.join(" ") || " "), texts);
          });
          if (groundedFlags.some(Boolean) && !groundedFlags.every(Boolean)) {
            survivors = survivors.filter((_, i) => groundedFlags[i] === true);
            notes.push(`ROW_DISCRIMINATOR:${term} kept ${survivors.length}/${tableHits.length}`);
          }
        }
      }
      // D2：单位判别器——命中 >1 且 atom 带单位 → 剔除单位不匹配的命中（无单位格不与有单位格竞逐）
      if (atomUnit !== undefined && atomUnit !== null && survivors.length > 1) {
        const matching = survivors.filter((h) => (h.cell.unit ?? null) === atomUnit);
        if (matching.length >= 1 && matching.length < survivors.length) {
          notes.push(`UNIT_DISCRIMINATOR:${atomUnit} kept ${matching.length}/${survivors.length}`);
          survivors = matching;
        }
      }
      for (const h of survivors) {
        hits.set(h.key, {
          file: file.file, tableId: table.tableId, tableIndex: table.tableIndex, row: h.cell.row, col: h.cell.col,
          rowKey: h.cell.rowKey, headerPath: h.cell.headerPath, caption: table.caption, label: table.label,
        });
      }
    }
  }
  return { hits, notes };
}

export interface VerifyProposalInput {
  document: CertificateDocument;
  claim: { file: string; start: number; end: number; value: string };
  resolved: ResolvedProposal;
  /** 模型可见的确定性渲染文本（renderAllowlist 输出）；缺省时按文档自建（同一确定性函数） */
  renderedTables?: string;
}

// ---- M15.4.2 M1：回指锚定（封闭词表 + 程序定位的确定性前文锚） ----

/** 回指封闭词表：仅这些短语允许连接前文锚（预登记 §5 M1；词表外不触发回指解析） */
const ANAPHORA_SINGULAR_RE = /\b(?:this (?:method|approach|model|framework)|the (?:model|method|approach)|the proposed (?:method|approach|model)|the same model)\b/i;
const ANAPHORA_COORDINATED_RE = /\bthe same two models\b/i;
const ANAPHORA_OWNABLE_RE = /\b(?:this (?:method|approach|model|framework)|the (?:model|method|approach)|the proposed (?:method|approach|model))\b/i;

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** 行键专名在原文中的逐字定位（空白容差）：返回 [start,end) 与原文；找不到 = null */
function locatePhraseInContent(content: string, phrasePlain: string): { start: number; end: number; text: string } | null {
  const tokens = phrasePlain.split(/\s+/).filter(Boolean);
  if (tokens.length === 0) return null;
  const pattern = new RegExp(`(?<![\\w])${tokens.map(escapeRegExp).join("\\s+")}(?![\\w])`, "i");
  const match = pattern.exec(content);
  if (match === null) return null;
  return { start: match.index, end: match.index + match[0].length, text: content.slice(match.index, match.index + match[0].length) };
}

/**
 * 同段落确定性窗口：论断句起点向前，至多 1500 字符；遇段落边界（空行）或结构边界
 *（\section 系 / 表格环境）即止。窗口外的文本不是合法前文锚域。
 */
function anaphoraWindowOf(content: string, sentenceStart: number): string {
  let start = Math.max(0, sentenceStart - 1500);
  const slice = content.slice(start, sentenceStart);
  const boundaries = [...slice.matchAll(/\n\s*\n|\\(?:sub)*section\b|\\begin\{table/g)];
  if (boundaries.length > 0) {
    const last = boundaries[boundaries.length - 1]!;
    start = start + last.index! + last[0].length;
  }
  return content.slice(start, sentenceStart);
}

/** 全文档数据行的行键专名候选（去重；须含非停用词 token——"Method"/"Ours" 这类泛词不作锚） */
function rowKeyAnchorPhrases(document: CertificateDocument): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const file of document.files) {
    for (const table of file.tables) {
      for (const row of table.rows) {
        if (row.kind !== "data") continue;
        const keyCell = row.cells.find((c) => c.rowKey.length > 0);
        if (keyCell === undefined) continue;
        const phrase = plainLatexText(keyCell.rowKey.join(" "));
        if (phrase.length < 3 || tokensOf(phrase).size === 0) continue;
        const dedupe = norm(phrase);
        if (seen.has(dedupe)) continue;
        seen.add(dedupe);
        out.push(phrase);
      }
    }
  }
  return out;
}

/**
 * M1 回指锚解析：在窗口内逐字定位行键专名锚。
 *  - COORDINATED（"the same two models"）：窗口内恰有一个「A and B」并列（A/B 均为行键短语）→ 有效主语 "A and B"；
 *    ≥2 个并列 → ANTECEDENT_NOT_UNIQUE。
 *  - SINGULAR：窗口内恰一个行键短语（且不在论断句内）→ 有效主语 = 该短语；≥2 → ANTECEDENT_NOT_UNIQUE；
 *    0 个且窗口含本文自指词（our/ours/we…）→ OWN 路线（有效主语 "ours"，结构侧仍须 rowIsOwn）。
 * 论断句内已出现的名字不算前件（claim-internal，已在 claim 侧锚定）。
 */
function resolveAnaphoraAnchor(document: CertificateDocument, entry: { file: string; content: string }, sentenceStart: number, sentenceText: string):
  | { status: "RESOLVED"; witness: AnaphoraWitness }
  | { status: "NOT_UNIQUE" | "NOT_FOUND"; phrase: string; competitors: string[] } {
  const window = anaphoraWindowOf(entry.content, sentenceStart);
  const phraseMatch = ANAPHORA_COORDINATED_RE.exec(sentenceText) ?? ANAPHORA_SINGULAR_RE.exec(sentenceText);
  const phrase = phraseMatch === null ? "" : phraseMatch[0];
  if (phrase === "") return { status: "NOT_FOUND", phrase: "", competitors: [] };
  const inSentence = (text: string): boolean => locatePhraseInContent(sentenceText, plainLatexText(text)) !== null;
  // window = content.slice(windowStart, sentenceStart)，锚 span 换算回源文件偏移
  const windowStart = sentenceStart - window.length;
  const anchors = rowKeyAnchorPhrases(document)
    .filter((p) => !inSentence(p))
    .map((p) => ({ phrase: p, span: locatePhraseInContent(window, p) }))
    .filter((p): p is { phrase: string; span: { start: number; end: number; text: string } } => p.span !== null)
    .map((p) => ({ phrase: p.phrase, span: { start: windowStart + p.span.start, end: windowStart + p.span.end, text: p.span.text } }));
  if (ANAPHORA_COORDINATED_RE.test(phrase)) {
    const pairs: Array<{ a: string; b: string; start: number; end: number; text: string }> = [];
    for (let i = 0; i < anchors.length; i += 1) {
      for (let j = 0; j < anchors.length; j += 1) {
        if (i === j) continue;
        const a = anchors[i]!;
        const b = anchors[j]!;
        const pattern = new RegExp(`(?<![\\w])${escapeRegExp(a.span.text)}\\s+and\\s+${escapeRegExp(b.span.text)}(?![\\w])`, "i");
        const match = pattern.exec(window);
        if (match !== null) pairs.push({ a: a.phrase, b: b.phrase, start: windowStart + match.index, end: windowStart + match.index + match[0].length, text: match[0] });
      }
    }
    // 「A and B」与「B and A」是同一并列；按无序对去重
    const unique = pairs.filter((pair, k) => !pairs.slice(0, k).some((other) => (other.a === pair.b && other.b === pair.a)));
    if (unique.length === 1) {
      const pair = unique[0]!;
      return {
        status: "RESOLVED",
        witness: {
          phrase, kind: "COORDINATED", effectiveSubject: `${pair.a} and ${pair.b}`,
          anchors: [{ file: entry.file, start: pair.start, end: pair.end, text: pair.text }],
          alternativesConsidered: anchors.map((a) => a.phrase),
        },
      };
    }
    return { status: "NOT_UNIQUE", phrase, competitors: unique.slice(0, 4).map((p) => `${p.a} and ${p.b}`) };
  }
  // 单数回指
  if (anchors.length === 1) {
    const anchor = anchors[0]!;
    return {
      status: "RESOLVED",
      witness: {
        phrase, kind: "NAMED", effectiveSubject: anchor.phrase,
        anchors: [{ file: entry.file, start: anchor.span.start, end: anchor.span.end, text: anchor.span.text }],
        alternativesConsidered: anchors.map((a) => a.phrase),
      },
    };
  }
  if (anchors.length >= 2) return { status: "NOT_UNIQUE", phrase, competitors: anchors.slice(0, 4).map((a) => a.phrase) };
  // 无专名前件 → 本文自指路线（窗口内逐字 our/ours/we/proposed…；结构侧仍须 rowIsOwn + 唯一性）
  if (ANAPHORA_OWNABLE_RE.test(phrase) && OWN_ALIASES.test(plainLatexText(window))) {
    return {
      status: "RESOLVED",
      witness: { phrase, kind: "OWN", effectiveSubject: "ours", anchors: [], alternativesConsidered: [] },
    };
  }
  return { status: "NOT_FOUND", phrase, competitors: [] };
}

// ---- M15.4.2 M2：引文四分类 ----

/** 程序生成的行引用：行组 + 行矩阵拼接（解析器结构重组，非自由文本；模型引文与此逐字一致 = 可回溯） */
function rowCitationOf(document: CertificateDocument, cell: ResolvedCell): { text: string; rowGroup: string | null; rowKey: string[] } {
  const file = document.files.find((f) => f.file === cell.file);
  const table = file?.tables[cell.tableIndex];
  const row = table?.rows.find((r) => r.index === cell.row);
  if (table === undefined || row === undefined) return { text: cell.rowKey.join(" & "), rowGroup: null, rowKey: cell.rowKey };
  const line: string[] = [];
  for (let c = 0; c < table.columnCount; c += 1) {
    const tableCell = row.cells.find((entry) => entry.col === c || (entry.col < c && c < entry.col + entry.colSpan));
    line.push(cellDisplayValue(tableCell));
  }
  const rowCells = row.cells.filter((c) => c.rowKey.length > 0);
  const rowGroup = rowCells[0]?.rowGroup ?? null;
  const text = `${rowGroup !== null && rowGroup !== "" ? `${rowGroup} & ` : ""}${line.join(" & ")}`;
  return { text, rowGroup, rowKey: rowCells[0]?.rowKey ?? cell.rowKey };
}

function tokenSet(text: string): Set<string> {
  return new Set(norm(text).split(/\s+/).filter(Boolean));
}

/** M2 边界感知定位：数字端点不得落在更长数字中间（「1.00」不是「1.000」的逐字引文，「82.1」不是「82.19」的；
 *  非数字词端不受限——「Bench-R.」的句点不是数字截断） */
function verbatimIncludes(face: string, quote: string): boolean {
  const nf = norm(face);
  const nq = norm(quote);
  if (nq === "") return false;
  const leftNumeric = /[0-9.]/.test(nq[0]!);
  const rightNumeric = /[0-9.]/.test(nq[nq.length - 1]!);
  let at = nf.indexOf(nq);
  while (at >= 0) {
    const before = at > 0 ? nf[at - 1]! : "";
    const after = at + nq.length < nf.length ? nf[at + nq.length]! : "";
    if (!(leftNumeric && /[0-9.]/.test(before)) && !(rightNumeric && /[0-9.]/.test(after))) return true;
    at = nf.indexOf(nq, at + 1);
  }
  return false;
}

/**
 * M2 引文判定。可定位面（全部由解析器/源文件派生，模型可见）：
 *  - 源文件纯文本（plainLatexText）；
 *  - allowlist 渲染 + 程序生成的行引用（rowGroup + 行矩阵）+ 表头路径 "/" 拼接。
 * MODEL_PARAPHRASE / UNLOCATABLE 仅排除（token-Jaccard ≥0.5 视为改写，否则不可定位），不得作证据。
 */
function classifyQuotes(document: CertificateDocument, quotes: string[], renderedTables: string | undefined, topCell: ResolvedCell): QuoteVerdict[] {
  const renderedFace = `${visibleCorpusText(document, renderedTables)}\n${rowCitationOf(document, topCell).text}\n${topCell.headerPath.join("/")}`;
  const sourceFace = document.files.map((f) => plainLatexText(f.content)).join("\n");
  const structureTexts = [
    ...document.files.flatMap((f) => f.tables.flatMap((t) => [t.caption ?? "", ...t.cells.map((c) => c.text)])),
    renderedFace,
  ];
  return quotes.map((quote) => {
    if (verbatimIncludes(sourceFace, quote)) return { quote, verdict: "SOURCE_VERBATIM" as const };
    if (verbatimIncludes(renderedFace, quote)) return { quote, verdict: "PARSER_RENDERED_VERBATIM" as const };
    const qTokens = tokenSet(quote);
    const similar = structureTexts.some((text) => {
      const sTokens = tokenSet(text);
      if (sTokens.size === 0 || qTokens.size === 0) return false;
      let shared = 0;
      for (const token of qTokens) if (sTokens.has(token)) shared += 1;
      return shared / Math.max(qTokens.size, sTokens.size) >= 0.5 || shared / qTokens.size >= 0.8;
    });
    return { quote, verdict: similar ? ("MODEL_PARAPHRASE" as const) : ("UNLOCATABLE" as const) };
  });
}

/** 模型可见语料文本：各文件 plainLatexText + allowlist 渲染（确定性、与 prompt 同源） */
function visibleCorpusText(document: CertificateDocument, renderedTables: string | undefined): string {
  if (renderedTables !== undefined) return renderedTables;
  return renderAllowlist(buildTableAllowlist(document));
}

/** FIX-2b（top 候选侧同语义）：引文绑定列须落叶子表头或与 metric 词共享 token（父级表头引文不算） */
function metricQuoteBindsTop(metricTerms: string[], spans: StructureSpans, verifiedQuotes: readonly string[] = []): boolean {
  const metricTokenSet = new Set(metricTerms.flatMap((t) => [...tokensOf(t)]));
  const columnTexts = columnHeaderTexts(spans);
  const leafText = spans.cell.headerPath.slice(-1).join(" ");
  return verifiedQuotes.some((q) => {
    const inColumn = columnTexts.some((text) => verbatimIncludes(text, q));
    if (!inColumn) return false;
    if (verbatimIncludes(leafText, q)) return true;
    return [...tokensOf(q)].some((token) => metricTokenSet.has(token));
  });
}

export function verifyProposal(input: VerifyProposalInput): ProposalVerification {
  const { document, claim, resolved } = input;
  const abstain = (reason: string, detail: string, category: ProposalAbstainCategory, topCandidate?: ResolvedCell, competitorCount?: number, witness?: MappingWitness): ProposalVerification => ({
    status: "ABSTAIN", claimId: resolved.claimId, reason, detail, category,
    ...(topCandidate !== undefined ? { topCandidate } : {}), ...(competitorCount !== undefined ? { competitorCount } : {}), ...(witness !== undefined ? { witness } : {}),
  });

  // 0) 论断原子定位（与证书器同一 locateAtom；值+显示精度逐字定位失败 → 不可核验）
  const located = locateAtom(document, claim.file, claim.start, claim.end, claim.value);
  if (located.atom === null) return abstain("CLAIM_ATOM_NOT_LOCATED", `locateAtom: ${located.reason ?? "unknown"}`, "CLAIM_ATOM_NOT_LOCATED");
  const atom: CertificateAtom = located.atom;

  // 1) 模型弃权 / 候选可解析性
  if (resolved.raw.abstain !== undefined) return abstain("PROPOSER_ABSTAIN", resolved.raw.abstain.reason || "(no reason)", "PROPOSER_ABSTAIN");
  const valid = resolved.candidates.filter((c) => c.status === "RESOLVED" && c.cell !== undefined && c.value !== undefined);
  if (valid.length === 0) {
    const first = resolved.candidates[0];
    const aliasBad = resolved.candidates.some((c) => c.status === "ALIAS_INVALID");
    return abstain(
      aliasBad ? "PROPOSAL_ALIAS_INVALID" : "CELL_NOT_NUMERIC",
      `first=${first?.raw.tableAlias ?? "?"}/${first?.raw.rowAlias ?? "?"}/${first?.raw.colAlias ?? "?"} status=${first?.status ?? "none"}`,
      aliasBad ? "PROPOSAL_ALIAS_INVALID" : "NO_VALID_CANDIDATE",
    );
  }
  const top = valid[0]!;
  const entry = document.files.find((f) => f.file === atom.file)!;

  // 2) M2 引文四分类：只有 SOURCE_VERBATIM / PARSER_RENDERED_VERBATIM 可作证据；改写/不可定位仅排除。
  //    全部引文不可用 → 维持整案拒绝（防伪造 tripwire 不撤——比预登记 §5 的宽松读法更严，如实记录）。
  const rawQuotes = valid.flatMap((c) => c.raw.evidenceQuotes).map((q) => q.trim()).filter(Boolean);
  const quoteVerdicts = classifyQuotes(document, rawQuotes, input.renderedTables, top.cell!);
  const quotes = quoteVerdicts.filter((v) => v.verdict === "SOURCE_VERBATIM" || v.verdict === "PARSER_RENDERED_VERBATIM").map((v) => v.quote);
  if (rawQuotes.length > 0 && quotes.length === 0) {
    const bad = quoteVerdicts.find((v) => v.verdict !== "SOURCE_VERBATIM" && v.verdict !== "PARSER_RENDERED_VERBATIM")!;
    return abstain("PROPOSAL_QUOTE_NOT_FOUND", `${bad.verdict}: ${bad.quote.slice(0, 80)}`, "PROPOSAL_QUOTE_NOT_FOUND", top.cell);
  }

  // 3) 论断语境 / 限定词 / 派生边界
  const scopes = textScopes(entry.content, atom.start, atom.end);
  const claimTokens = new Set([...tokensOf(scopes.sentence), ...tokensOf(scopes.segment), ...tokensOf(scopes.window)]);
  const spans = structureOf(document, top.cell!);
  if (spans === null) return abstain("NO_VALID_CANDIDATE", "structure not found for top candidate", "NO_VALID_CANDIDATE", top.cell);
  const qualifiers = atomQualifiers(scopes, atom.raw);
  if (qualifiers.includes("APPROX") || qualifiers.includes("INEQUALITY")) {
    return abstain("CLAIM_QUALIFIER_NOT_CERTIFIABLE", `qualifiers=${qualifiers.join(",")}`, "CLAIM_QUALIFIER_NOT_CERTIFIABLE", top.cell);
  }
  const derivedQualified = qualifiers.includes("DERIVED") || qualifiers.includes("AGGREGATE") || qualifiers.includes("SIGNED");
  if (derivedQualified && !DERIVED_COLUMN_HEADER.test(top.cell!.headerPath.join(" "))) {
    return abstain("DERIVED_RECOMPUTE_OUT_OF_SCOPE", "claim is derived-worded; protocol verifies atomic proposals only (paper's own derived columns excepted)", "DERIVED_RECOMPUTE_OUT_OF_SCOPE", top.cell);
  }

  // 4) grounding。M1：回指主语（封闭词表命中）由程序在同段落窗口内解析确定性锚，锚替换模型 subject
  //    （模型不得借回指向提案注入任意名字）；锚不唯一 → 弃判。M4：context 词不在论断句/锚文本 → 丢弃并
  //    记录（过滤只降不升），不拒判；subject/metric 仍必须锚定。
  const modelTerms = groundingTermsOf(resolved.raw);
  const sentencePlain = norm(scopes.sentence);
  const sentenceHasAnaphora = ANAPHORA_SINGULAR_RE.test(scopes.sentence) || ANAPHORA_COORDINATED_RE.test(scopes.sentence);
  let anaphoraWitness: AnaphoraWitness | undefined;
  let effectiveSubject = resolved.raw.subject.trim();
  if (sentenceHasAnaphora) {
    const anchor = resolveAnaphoraAnchor(document, { file: entry.file, content: entry.content }, scopes.sentenceStart, scopes.sentence);
    if (anchor.status !== "RESOLVED") {
      const category = anchor.status === "NOT_UNIQUE" ? "PROPOSAL_ANTECEDENT_NOT_UNIQUE" : "PROPOSAL_ANTECEDENT_NOT_FOUND";
      return abstain(category, `phrase "${anchor.phrase}": ${anchor.status === "NOT_UNIQUE" ? `competing antecedents [${anchor.competitors.join(" | ")}]` : "no locatable row-key or own-alias antecedent in paragraph window"}`, category, top.cell);
    }
    anaphoraWitness = anchor.witness;
    effectiveSubject = anchor.witness.effectiveSubject;
  }
  const terms: GroundingTerms = { subject: effectiveSubject.trim() === "" ? [] : effectiveSubject.trim().split(/\s*[,;]\s*|\s+/).filter(Boolean), metric: modelTerms.metric, context: modelTerms.context };
  const subjectJoined = effectiveSubject;
  const subjectIsOwnAlias = OWN_ALIASES.test(subjectJoined);
  const anchorTexts = anaphoraWitness !== undefined && anaphoraWitness.anchors.length > 0 ? anaphoraWitness.anchors.map((a) => a.text) : [];
  const anchorTokens = anchorTexts.length > 0 ? tokensOf(anchorTexts.join(" ")) : null;
  const termGroundings: MappingWitness["termGroundings"] = [];
  // subject：回指 → 锚文本内逐字（按构造成立，仍显式验证并记录）；否则论断句内
  for (const term of terms.subject) {
    if (term.trim() === "") continue;
    const anchored = anchorTokens !== null
      ? termGroundedIn(term, anchorTokens, anchorTexts)
      : termGroundedIn(term, claimTokens, [scopes.sentence, scopes.segment, scopes.window]);
    termGroundings.push({ kind: "SUBJECT", term, anchored, where: anchorTokens !== null ? "ANAPHORA_ANCHOR" : "CLAIM" });
    if (!anchored) {
      return abstain("PROPOSAL_TERM_NOT_IN_CLAIM", `term "${term}" not found in ${anchorTokens !== null ? "antecedent anchor" : "claim context"}`, "PROPOSAL_TERM_NOT_IN_CLAIM", top.cell);
    }
  }
  // FIX-3：own 路线（M1 回指解析出的本文自指锚）下 claim 句本就不含 own 别名词——claim 侧检查
  // 以锚见证为准（anaphoraWitness.kind === "OWN"），不因句内无 our/we 而拒判；无锚的 own-alias 仍须句内出现。
  const ownViaAnaphora = anaphoraWitness?.kind === "OWN";
  if (subjectIsOwnAlias && !ownViaAnaphora && anchorTokens === null && !OWN_ALIASES.test(sentencePlain)) {
    return abstain("PROPOSAL_TERM_NOT_IN_CLAIM", "own-alias subject not found in claim sentence", "PROPOSAL_TERM_NOT_IN_CLAIM", top.cell);
  }
  if (terms.subject.length === 0) return abstain("GROUNDING_FAILED", "interpretation has no subject", "GROUNDING_FAILED", top.cell);
  for (const term of terms.metric) {
    if (term.trim() === "") continue;
    const anchored = termGroundedIn(term, claimTokens, [scopes.sentence, scopes.segment, scopes.window]);
    termGroundings.push({ kind: "METRIC", term, anchored, where: "CLAIM" });
    if (!anchored) {
      return abstain("PROPOSAL_TERM_NOT_IN_CLAIM", `term "${term}" not found in claim context`, "PROPOSAL_TERM_NOT_IN_CLAIM", top.cell);
    }
  }
  // M4：context 词 claim 侧锚定检查（锚不成立 → 丢弃，不拒判；过滤只降不升 → 唯一性更严）
  const anchoredContext = terms.context.filter((term) => {
    if (term.trim() === "") return false;
    const ok = termGroundedIn(term, claimTokens, [scopes.sentence, scopes.segment, scopes.window])
      || (anchorTokens !== null && termGroundedIn(term, anchorTokens, anchorTexts));
    termGroundings.push({ kind: "CONTEXT", term, anchored: ok, where: ok ? (anchorTokens !== null && termGroundedIn(term, anchorTokens, anchorTexts) ? "ANAPHORA_ANCHOR" : "CLAIM") : "DROPPED" });
    return ok;
  });
  const droppedClaimContext = terms.context.filter((t) => !anchoredContext.includes(t));

  const subjectIsOwn = subjectIsOwnAlias || terms.subject.some((t) => OWN_ROW.test(t) || OWN_ALIASES.test(t));
  const rowTokens = tokensOf([...rowKeyTexts(spans), ...(spans.cell.rowGroup ? [spans.cell.rowGroup] : "")].filter(Boolean).join(" ") || " ");
  const headerTokens = tokensOf(spans.cell.headerPath.join(" ") || " ");
  const headerLeafTokens = tokensOf(spans.cell.headerPath.slice(-1).join(" ") || " ");
  const contextTexts = [...tableContextTexts(spans), ...rowKeyTexts(spans), spans.cell.headerPath.join(" ")];
  const contextTokens = tokensOf(contextTexts.join(" ") || " ");
  const subjectAlts = subjectAlternatives(terms.subject);
  // D1（转置表方向 B，与生产绑定器一致）：subject 落列表头叶子 = 方法在列、指标在行；此时 metric 检行键
  const subjectGroundedA = subjectIsOwn ? rowIsOwn(document, spans) : subjectAlts.some((alt) => alt.every((t) => termGroundedIn(t, rowTokens, rowKeyTexts(spans))));
  const subjectGroundedB = !subjectIsOwn && !subjectGroundedA && subjectAlts.some((alt) => alt.every((t) => termGroundedIn(t, headerLeafTokens, columnHeaderTexts(spans))));
  const subjectGrounded = subjectGroundedA || subjectGroundedB;
  if (!subjectGrounded) return abstain("GROUNDING_FAILED", `subject "${subjectJoined}" not grounded in row "${spans.cell.rowKey.join("/")}" or column leaf "${spans.cell.headerPath.join("/")}"`, "GROUNDING_FAILED", top.cell);
  // 修正 A：空主语（全部停用词、非本文别名）不承载身份——只靠值碰巧相等不可证明对应
  const subjectHasContent = subjectIsOwnAlias || terms.subject.some((t) => tokensOf(t).size > 0);
  if (!subjectHasContent) return abstain("GROUNDING_FAILED", "vacuous subject (stopwords only, not own-alias): value coincidence cannot prove correspondence", "GROUNDING_FAILED", top.cell);
  const metricGrounded = terms.metric.length > 0
    && (!subjectGroundedB
      ? (terms.metric.every((t) => termGroundedIn(t, headerTokens, columnHeaderTexts(spans))) || metricQuoteBindsTop(terms.metric, spans, quotes))
      : terms.metric.every((t) => termGroundedIn(t, rowTokens, [...rowKeyTexts(spans), ...(spans.cell.rowGroup ? [spans.cell.rowGroup] : "")])));
  // 条件词佐证过滤（修正 A 语义下的安全方向）：逐条检查 top 候选的表格语境能否佐证该条件词；
  // 不能佐证的条件词（如修辞 fastest/interative 描述，论文表格语境无此词）视为解释性噪声丢弃并记录，
  // 不参与唯一性枚举——过滤器强度只降不升（竞争候选只会更多 → 唯一性更严，不会借丢弃制造假唯一）。
  const corroboratedContext = anchoredContext.filter((t) =>
    termGroundedContext(t, contextTokens, contextTexts)
    || quotes.some((q) => norm(spans.table.caption ?? "").includes(norm(q)) || norm(spans.table.label ?? "").includes(norm(q))));
  const droppedContext: string[] = anchoredContext.filter((t) => !corroboratedContext.includes(t));

  // 5) 唯一性（签名枚举；模型指向不删除竞争候选）+ 值佐证列选择（仅 metric 未文字识别时；仿 A2 更严）
  let valueCorroborated = false;
  let multiBinding: { count: number; unanimous: string } | null = null;
  let multiBindingOutcome: "SUPPORTED_CANDIDATE" | "CONTRADICTED_CANDIDATE" | null = null;
  if (!metricGrounded) {
    // metric 未被文字/引文 grounded（含 metric 为空——正文不点名指标）：不允许引文绑定列；
    // 唯一出路 = subject+context 行签名唯一 + 该行恰一个值重叠格 + 表有题注（只能出 SUPPORTED 路径）
    const signatureNoMetric = enumerateSignature(document, { subject: terms.subject, metric: [], context: corroboratedContext }, quotes, true, atom.unit).hits;
    const hits = [...signatureNoMetric.values()];
    if (hits.length === 0) {
      return abstain("PROPOSAL_NOT_UNIQUE", "metric not textually identified; subject/context signature grounds 0 rows", "PROPOSAL_NOT_UNIQUE", top.cell, 0);
    }
    // A2 化推广（M15.3.4 valueTieBreak 先例）：在签名命中的全部行的数值格中，恰一个与论断值 OVERLAP
    // 且其表有题注/label → 该格承载观察（值不参与跨签名行的搜索范围——只在语义签名已收窄的行集内裁决）
    const seen = new Set<string>();
    const rowCells: Array<{ cell: LatexTableCell; table: LatexTable }> = [];
    for (const h of hits) {
      const file = document.files.find((f) => f.file === h.file);
      const table = file?.tables[h.tableIndex];
      if (table === undefined) continue;
      for (const c of table.rows.find((r) => r.index === h.row)?.cells ?? []) {
        if (c.value === null || c.isHeader) continue;
        const key = `${table.tableId}|${c.row}|${c.col}`;
        if (seen.has(key)) continue; // 同一行的多个签名命中（列各异）不得重复计入该行单元格
        seen.add(key);
        rowCells.push({ cell: c, table });
      }
    }
    const overlapping = rowCells.filter((e) => e.table !== undefined && compareAtoms({ value: atom.value, decimals: atom.decimals, unit: atom.unit }, normalizedCellValue(e.cell)).relation === "OVERLAP");
    const withCaption = overlapping.filter((e) => (e.table!.caption ?? "") !== "" || e.table!.label !== null);
    if (overlapping.length !== 1 || withCaption.length !== 1) {
      return abstain("PROPOSAL_NOT_UNIQUE", `metric not textually identified: ${overlapping.length} value-overlapping cells across ${new Set(hits.map((h) => `${h.file}|${h.row}`)).size} signature rows (need exactly 1, with caption)`, "PROPOSAL_NOT_UNIQUE", top.cell, signatureNoMetric.size);
    }
    const winner = overlapping[0]!;
    const winnerTable = winner.table!;
    if (!(winnerTable.tableId === top.cell!.tableId && winner.cell.row === top.cell!.row && winner.cell.col === top.cell!.col)) {
      return abstain("GROUNDING_FAILED", "value-corroborated cell differs from top proposal", "GROUNDING_FAILED", top.cell);
    }
    valueCorroborated = true;
  } else {
    const enumeration = enumerateSignature(document, { ...terms, context: corroboratedContext }, quotes, false, atom.unit);
    const signature = enumeration.hits;
    if (signature.size === 0) {
      return abstain("PROPOSAL_NOT_UNIQUE", "signature grounded 0 cells", "PROPOSAL_NOT_UNIQUE", top.cell, 0);
    }
    if (signature.size === 1) {
      const only = [...signature.values()][0]!;
      if (!(only.file === top.cell!.file && only.tableIndex === top.cell!.tableIndex && only.row === top.cell!.row && only.col === top.cell!.col)) {
        return abstain("GROUNDING_FAILED", "unique signature cell differs from top proposal", "GROUNDING_FAILED", top.cell);
      }
    } else {
      // 并列主语的多绑定（claim 明说 A and B 各自取得该值）：不删除竞争候选（修正 A），但若全部命中格
      // 与论断值一致（或全部不一致且模型判断一致），任一格都独立佐证/反驳该论断 → 一致裁决出证；
      // 混合（部分一致部分不一致）= 真歧义 → 弃判。
      const hits = [...signature.values()];
      const hitRelations = hits.map((h) => {
        const file = document.files.find((f) => f.file === h.file);
        const cell = file?.tables[h.tableIndex]?.cells.find((c) => c.row === h.row && c.value !== null && !c.isHeader && (c.col === h.col || (c.col < h.col && h.col < c.col + c.colSpan)));
        return cell === undefined || cell.value === null ? null : compareAtoms({ value: atom.value, decimals: atom.decimals, unit: atom.unit }, normalizedCellValue(cell)).relation;
      });
      if (hitRelations.some((r) => r === null || r === "UNIT_MISMATCH" || r === "SCALE_AMBIGUOUS")) {
        return abstain("PROPOSAL_NOT_UNIQUE", `multi-binding hits contain non-comparable cells (${signature.size} cells)`, "PROPOSAL_NOT_UNIQUE", top.cell, signature.size);
      }
      const allOverlap = hitRelations.every((r) => r === "OVERLAP");
      const allDisjoint = hitRelations.every((r) => r === "DISJOINT");
      const topInSignature = hits.some((h) => h.file === top.cell!.file && h.tableIndex === top.cell!.tableIndex && h.row === top.cell!.row && h.col === top.cell!.col);
      if (!topInSignature) {
        return abstain("GROUNDING_FAILED", `signature grounded ${signature.size} cells not including the top proposal`, "GROUNDING_FAILED", top.cell, signature.size);
      }
      if (!allOverlap && !allDisjoint) {
        return abstain("PROPOSAL_NOT_UNIQUE", `multi-binding mixed relations over ${signature.size} cells (genuine ambiguity)`, "PROPOSAL_NOT_UNIQUE", top.cell, signature.size);
      }
      multiBinding = { count: signature.size, unanimous: allOverlap ? "OVERLAP" : "DISJOINT" };
      if (allDisjoint) {
        // 多格矛盾路径同样受 B2 约束：论断值出现在任何非命中表 → 跨表归属不可证
        const otherTables = valueAppearsInOtherTablesMulti(document, hits, atom.raw);
        if (otherTables.length > 0) return abstain("VALUE_APPEARS_IN_OTHER_TABLE", otherTables.join(","), "VALUE_APPEARS_IN_OTHER_TABLE", top.cell);
        multiBindingOutcome = "CONTRADICTED_CANDIDATE";
      } else {
        multiBindingOutcome = "SUPPORTED_CANDIDATE";
      }
    }
    // 全部条件词被丢弃 = 无表级过滤，仅 subject+metric 签名继续（候选集更宽、唯一性仍强制——安全方向）
  }

  // 6) B3 限定词 + 表格解析健康
  const unexplained = unexplainedQualifiers(scopes.segment, spans);
  if (unexplained.length > 0) return abstain("UNEXPLAINED_QUALIFIER", unexplained.join(","), "UNEXPLAINED_QUALIFIER", top.cell);
  if (spans.table.parseIssues.length > 0) return abstain("TABLE_PARSE_ISSUES", spans.table.parseIssues.join(","), "TABLE_PARSE_ISSUES", top.cell);

  // 7) 值比较（修正 B：先对应、后比较；值只来自解析器）+ 双钥匙
  const relation = compareAtoms({ value: atom.value, decimals: atom.decimals, unit: atom.unit }, top.value!);
  if (relation.relation === "UNIT_MISMATCH") return abstain("UNIT_MISMATCH", relation.note, "UNIT_MISMATCH", top.cell);
  if (relation.relation === "SCALE_AMBIGUOUS") return abstain("SCALE_AMBIGUOUS", relation.note, "SCALE_AMBIGUOUS", top.cell);
  if (relation.relation !== "OVERLAP") {
    const others = valueAppearsInOtherTable(document, spans, atom.raw);
    if (others.length > 0) return abstain("VALUE_APPEARS_IN_OTHER_TABLE", others.join(","), "VALUE_APPEARS_IN_OTHER_TABLE", top.cell);
  }
  if (resolved.raw.comparison !== "CONSISTENT" && resolved.raw.comparison !== "INCONSISTENT") {
    return abstain("MODEL_CHECK_MISSING", "proposal.comparison absent", "MODEL_CHECK_MISSING", top.cell);
  }
  const modelCheck = resolved.raw.comparison;
  let outcome: "SUPPORTED" | "CONTRADICTED" | null = null;
  if (multiBinding !== null && multiBindingOutcome !== null) {
    // 多绑定一致裁决已在唯一性阶段确定全部命中格的 relation（ unanimous OVERLAP / DISJOINT ）
    outcome = multiBindingOutcome === "SUPPORTED_CANDIDATE" ? (modelCheck === "CONSISTENT" ? "SUPPORTED" : null) : modelCheck === "INCONSISTENT" ? "CONTRADICTED" : null;
  } else {
    outcome = relation.relation === "OVERLAP" ? (modelCheck === "CONSISTENT" ? "SUPPORTED" : null) : modelCheck === "INCONSISTENT" ? "CONTRADICTED" : null;
  }
  if (outcome === null) return abstain("MODEL_CHECK_DISAGREES", `deterministic=${relation.relation}${multiBinding !== null ? `/multi-binding ${multiBinding.count}` : ""} model=${modelCheck}`, "MODEL_CHECK_DISAGREES", top.cell);

  // 8) 映射见证（mapping-witness/v1）：全部证据链可独立复核
  const rowCitation = rowCitationOf(document, top.cell!);
  const witness: MappingWitness = {
    version: MAPPING_WITNESS_VERSION,
    claimAtom: { file: atom.file, start: atom.start, end: atom.end, raw: atom.raw, value: atom.value, decimals: atom.decimals, unit: atom.unit, qualifiers: atom.qualifiers },
    proposalEcho: {
      subject: resolved.raw.subject, metric: resolved.raw.metric, dataset: resolved.raw.dataset, conditions: resolved.raw.conditions, comparison: resolved.raw.comparison,
      topCandidate: { tableAlias: top.raw.tableAlias, rowAlias: top.raw.rowAlias, colAlias: top.raw.colAlias },
    },
    resolvedCell: top.cell!,
    citations: {
      value: { raw: spans.cell.value?.raw ?? top.value!.raw, sourceFile: spans.file, start: spans.cell.valueStart, end: spans.cell.valueEnd },
      row: { text: rowCitation.text, sourceFile: spans.file, tableId: spans.table.tableId, row: spans.cell.row, rowGroup: rowCitation.rowGroup, rowKey: rowCitation.rowKey },
      column: { headerPath: spans.cell.headerPath },
      caption: spans.table.caption,
      label: spans.table.label,
    },
    quotes: quoteVerdicts,
    ...(anaphoraWitness !== undefined ? { anaphora: anaphoraWitness } : {}),
    termGroundings,
    droppedContextTerms: [...droppedClaimContext, ...droppedContext],
    uniqueness: {
      signatureSubject: subjectJoined, signatureMetric: resolved.raw.metric, signatureContext: corroboratedContext,
      hitCount: multiBinding !== null ? multiBinding.count : 1,
      hitRelation: multiBinding !== null ? multiBinding.unanimous : relation.relation,
      valueCorroborated, multiBinding,
    },
    guards: { unexplainedQualifiers: unexplained, crossTableCompetitors: [], parseIssues: spans.table.parseIssues },
    checks: [],
  };
  const checks = [
    "CLAIM_ATOM_LOCATED",
    rawQuotes.length === 0 ? "QUOTES_NONE" : quotes.length === rawQuotes.length ? "QUOTES_VERBATIM" : `QUOTES_PARTIALLY_VERBATIM(${quotes.length}/${rawQuotes.length})`,
    anaphoraWitness === undefined ? "TERMS_FROM_CLAIM" : `ANAPHORA_RESOLVED(${anaphoraWitness.kind})`,
    "SUBJECT_ROW_GROUNDED",
    metricGrounded ? "METRIC_COLUMN_GROUNDED" : "METRIC_VALUE_CORROBORATED",
    terms.context.length === 0 ? "CONTEXT_EMPTY" : corroboratedContext.length === terms.context.length ? "CONTEXT_TABLE_GROUNDED" : `CONTEXT_PARTIALLY_CORROBORATED(${corroboratedContext.length}/${terms.context.length})`,
    valueCorroborated ? "ROW_SIGNATURE_VALUE_CORROBORATED" : multiBinding !== null ? `MULTI_BINDING_UNANIMOUS(${multiBinding.count})` : "SIGNATURE_UNIQUE",
    "QUALIFIERS_EXPLAINED", "B2_CROSS_TABLE_CLEAR", "DOUBLE_KEY_AGREED",
  ];
  witness.checks = checks;
  return {
    status: "ACCEPTED", claimId: resolved.claimId, outcome, cell: top.cell!, value: top.value!,
    grounding: { subject: subjectJoined, metric: resolved.raw.metric, context: terms.context, valueCorroborated, ...(droppedContext.length > 0 ? { droppedContext } : {}), ...(multiBinding !== null ? { multiBinding } : {}) },
    relation: relation.relation, modelCheck,
    checks,
    witness,
  };
}

// ---- 编排（模型调用由外部注入；真实通道=evaluation/liveRuntime 同源构造，测试=stub；并发/预算由调用方控制） ----

export type CallModel = (prompt: string) => Promise<{ text: string; usage?: { inputTokens?: number; outputTokens?: number }; model: string }>;

export interface ProposerRunResult {
  claimId: string;
  promptVersion: typeof PROPOSER_PROMPT_VERSION;
  adapterVersion: typeof PROPOSER_ADAPTER_VERSION;
  model: string;
  promptChars: number;
  attempts: number;
  allowlistTruncation: { truncatedTables: number; omittedCells: number };
  raw: RawProposal | null;
  parseError: string | null;
  resolved: ResolvedProposal | null;
  verification: ProposalVerification | null;
  usage?: { inputTokens?: number; outputTokens?: number };
}

export async function runCandidateProposer(
  document: CertificateDocument,
  claim: ProposerClaimInput & { start: number; end: number },
  callModel: CallModel,
  options: { maxAttempts?: number } = {},
): Promise<ProposerRunResult> {
  const maxAttempts = options.maxAttempts ?? 2; // 1 次有效调用 + 仅解析失败时 1 次结构化重试
  const allowlist = buildTableAllowlist(document);
  const prompt = buildProposerPrompt(claim, allowlist, document.ownTerms.join(" ") || "(untitled)");
  let raw: RawProposal | null = null;
  let parseError: string | null = null;
  let attempts = 0;
  let model = "";
  let usage: { inputTokens?: number; outputTokens?: number } | undefined;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    attempts = attempt;
    const response = await callModel(`${prompt}${attempt > 1 ? "\n\nYour previous reply was not valid JSON for this schema. Reply again with STRICT JSON only." : ""}`);
    model = response.model;
    usage = response.usage;
    const parsed = parseProposerResponse(response.text);
    raw = parsed.proposal;
    parseError = parsed.error;
    if (raw !== null) break;
  }
  const resolved = raw === null ? null : resolveProposal(document, raw, allowlist);
  const verification = resolved === null
    ? null
    : verifyProposal({ document, claim: { file: claim.file, start: claim.start, end: claim.end, value: claim.claimValue }, resolved });
  return {
    claimId: claim.claimId, promptVersion: PROPOSER_PROMPT_VERSION, adapterVersion: PROPOSER_ADAPTER_VERSION,
    model, promptChars: prompt.length, attempts,
    allowlistTruncation: { truncatedTables: allowlist.tables.filter((t) => t.truncated).length, omittedCells: allowlist.omittedCells },
    raw, parseError, resolved, verification, ...(usage !== undefined ? { usage } : {}),
  };
}
