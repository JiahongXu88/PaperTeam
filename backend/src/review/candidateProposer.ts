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
 * atomQualifiers/locateAtom/compareAtoms、内容寻址 tableId、claimAudit 的逐字定位纪律。本文件内少量
 * 词表/守卫（STOP/OWN_ROW/QUALIFIER/B2）自 claimCertificate@03c48fc 复制并注明来源——刻意不 export
 * 原件，保证既有 dist 逐字节不变（M15.4.1 预登记 §6 不变性证明）。
 */

import { contextTokens, locateAtom, textScopes, atomQualifiers, compareAtoms, type CertificateAtom, type CertificateDocument } from "./claimCertificate.js";
import { plainLatexText, type LatexTable, type LatexTableCell } from "./latexTable.js";

// v1→v2（M15.4.1 DEV smoke 后唯一一次 prompt 修订，逐条记录于 FREEZE_MANIFEST）：
//   metric 指引补「纯单位/泛词（ms/%/dB/score/result）不算指标」；conditions 要求短单词；
//   evidenceQuotes 禁 '...' 缩写；abstain 须非空 reason 且仅在无表格观察时使用。
export const PROPOSER_PROMPT_VERSION = "candidate-proposer/v2";
export const PROPOSER_ADAPTER_VERSION = "candidate-proposer-adapter/v1";

// ---- 自 claimCertificate.ts@03c48fc 复制的词表/正则（保持 dist 字节不变性；语义与原件一致） ----

/** claimCertificate.STOP 的拷贝：proposal 验证器停用词，与绑定器同源语义 */
const STOP = new Set([
  "the", "a", "an", "of", "on", "in", "for", "and", "or", "to", "by", "at", "from", "as", "is", "are", "was", "were", "be", "with", "its", "their", "this", "that", "these", "those",
  "method", "methods", "model", "models", "approach", "approaches", "results", "result", "table", "tab", "score", "scores", "performance", "metric", "metrics", "value", "values",
  "achieves", "achieve", "achieved", "obtains", "obtain", "obtained", "reaches", "reach", "reached", "reports", "reported", "shows", "show", "yields", "yield", "gets", "attains",
  "which", "while", "whereas", "also", "both", "all", "each", "respectively", "using", "used", "use", "our", "ours", "we", "proposed", "work", "paper", "new",
  "et", "al", "fig", "figure", "sec", "section", "see", "eq", "i", "e", "g", "vs", "via",
]);
/** claimCertificate.OWN_ROW 的拷贝：本文方法行判别 */
const OWN_ROW = /\b(?:ours|proposed|this work|our method|our approach|our model)\b|本文|我们|所提/i;
/** claimCertificate.OWN_ALIASES 的拷贝：论断侧本文别名（ours/our/we/proposed… 家族互通） */
const OWN_ALIASES = /\b(?:ours|our|we|proposed|this work|this paper|the present work)\b|本文|我们|所提|提出的方法/i;
/** claimCertificate.QUALIFIER_LEXICON 的拷贝：B3 论断限定词须由表格语境解释 */
const QUALIFIER_LEXICON = [
  "validation", "val", "dev", "train", "training", "test-dev", "held-out", "zero-shot", "few-shot", "one-shot", "fine-tuned", "finetuned", "pretrained", "pre-trained",
  "post-processing", "postprocessing", "offline", "ensemble", "oracle", "upper", "tta", "test-time", "w/o", "without", "ablation", "ablated", "variant", "single-scale", "multi-scale",
  "small", "large", "base", "tiny", "lite", "ablations", "cross-domain", "occluded", "subset", "split",
  "验证集", "训练集", "消融", "后处理", "零样本",
];
/** claimCertificate.QUALIFIER_FAMILIES 的拷贝：reproduce/fair/original 家族内互通 */
const QUALIFIER_FAMILIES: string[][] = [
  ["reproduce", "reproduces", "reproduced", "reproducing", "reproduction", "reproductions", "replicate", "replicates", "replicated", "replication", "复现"],
  ["fair"],
  ["original"],
];
/** claimCertificate.derivedColumn 同语义：论文自制派生列表头（Improv./Gain/Δ …），tabulatedDerived 路径 */
const DERIVED_COLUMN = /\b(?:improv\w*|imp\.?|gains?|increases?|delta|rel\.?|relative|changes?)\b|Δ|\\Delta|提升|增益/i;

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
  | "MODEL_CHECK_MISSING" | "MODEL_CHECK_DISAGREES" | "CLAIM_ATOM_NOT_LOCATED";

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
    }
  | {
      status: "ABSTAIN";
      claimId: string;
      reason: string;
      detail: string;
      category: ProposalAbstainCategory;
      topCandidate?: ResolvedCell;
      competitorCount?: number;
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

/** B3：论断限定词须由该表语境解释（与 claimCertificate 同语义的本地复现） */
function unexplainedQualifiers(segment: string, spans: StructureSpans): string[] {
  const segmentTokens = tokensOf(segment);
  const plain = norm(segment);
  const contextText = [...tableContextTexts(spans), ...rowKeyTexts(spans), ...columnHeaderTexts(spans)].join(" \n ");
  const contextTokens = tokensOf(contextText);
  const explains = (qualifier: string): boolean => norm(contextText).includes(norm(qualifier)) || contextTokens.has(qualifier);
  const out: string[] = [];
  for (const qualifier of QUALIFIER_LEXICON) {
    const used = plain.includes(norm(qualifier)) || segmentTokens.has(qualifier);
    if (used && !explains(qualifier)) out.push(qualifier);
  }
  for (const family of QUALIFIER_FAMILIES) {
    const used = family.filter((q) => plain.includes(norm(q)) || segmentTokens.has(q));
    if (used.length > 0 && !family.some((q) => explains(q))) out.push(used[0]!);
  }
  return [...new Set(out)];
}

/** B2 多命中变体：论断值逐字出现在任何命中表之外的表格体 → 跨表归属不可证 */
function valueAppearsInOtherTablesMulti(document: CertificateDocument, hits: Array<{ file: string; tableIndex: number }>, claimRaw: string): string[] {
  const needle = claimRaw.replace(/,/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(needle)) return [];
  const pattern = new RegExp(`(?<![\\d.])${needle.replace(/\./g, "\\.")}(?![\\d.])`, "g");
  const hitTableIds = new Set(hits.map((h) => document.files.find((f) => f.file === h.file)?.tables[h.tableIndex]?.tableId).filter(Boolean));
  const otherTableIds = new Set<string>();
  for (const file of document.files) {
    for (const match of file.content.matchAll(pattern)) {
      for (const table of file.tables) {
        if (!hitTableIds.has(table.tableId) && match.index! >= table.start && match.index! < table.end) otherTableIds.add(table.tableId);
      }
    }
  }
  return [...otherTableIds].slice(0, 3);
}

/** B2：论断值与提案格值不一致且该值逐字出现在他表表格体 → 跨表归属不可证（与 claimCertificate 同语义的本地复现） */
function valueAppearsInOtherTable(document: CertificateDocument, spans: StructureSpans, claimRaw: string): string[] {
  const needle = claimRaw.replace(/,/g, "");
  if (!/^\d+(?:\.\d+)?$/.test(needle)) return [];
  const pattern = new RegExp(`(?<![\\d.])${needle.replace(/\./g, "\\.")}(?![\\d.])`, "g");
  const otherTableIds = new Set<string>();
  for (const file of document.files) {
    for (const match of file.content.matchAll(pattern)) {
      for (const table of file.tables) {
        if (table.tableId !== spans.table.tableId && match.index! >= table.start && match.index! < table.end) otherTableIds.add(table.tableId);
      }
    }
  }
  return [...otherTableIds].slice(0, 3);
}

/** 行是否本文方法行（rowIsOwn 同语义） */
function rowIsOwn(document: CertificateDocument, spans: StructureSpans): boolean {
  const key = spans.cell.rowKey.join(" ");
  if (OWN_ROW.test(key)) return true;
  const tokens = new Set(contextTokens(key));
  return document.ownTerms.some((term) => tokens.has(term));
}

/**
 * 签名枚举（修正 A 的核心）：对全文档所有数值格，用与提案完全相同的 grounding 规则统计满足
 * subject+metric+context 全部 grounded 的单元格。模型指向不参与枚举——它不能删除任何竞争候选。
 * metric 为空 → 列不约束（供值佐证规则用行签名）。subject 为空 → 无有效签名（恒空）。
 */
export function enumerateSignature(document: CertificateDocument, termsIn: GroundingTerms, quotes: string[], metricUnconstrained: boolean): Map<string, ResolvedCell> {
  const hits = new Map<string, ResolvedCell>();
  if (termsIn.subject.length === 0) return hits;
  // 条件词可用性：全域任何表语境都无落位的词不承载判别信息（纯修饰词），丢弃
  const allContextTexts = document.files.flatMap((file) =>
    file.tables.flatMap((table) => [table.caption ?? "", table.label ?? "", ...table.cells.flatMap((c) => [c.rowGroup ?? "", ...c.headerPath, ...c.rowKey])]),
  );
  const allContextTokens = tokensOf(allContextTexts.join(" ") || " ");
  const terms: GroundingTerms = { ...termsIn, context: termsIn.context.filter((t) => termGroundedContext(t, allContextTokens, allContextTexts)) };
  const subjectIsOwn = terms.subject.some((t) => OWN_ROW.test(t) || OWN_ALIASES.test(t)) || OWN_ALIASES.test(terms.subject.join(" "));
  const subjectAlts = subjectAlternatives(terms.subject);
  const quoteIn = (texts: string[]): boolean => quotes.some((q) => texts.some((text) => norm(text).includes(norm(q))));
  for (const file of document.files) {
    for (const table of file.tables) {
      if (table.parseIssues.includes("NESTED_TABULAR")) continue;
      for (const cell of table.cells) {
        if (cell.value === null || cell.isHeader || cell.rowKey.length === 0) continue;
        const spans: StructureSpans = { file: file.file, content: file.content, table, cell };
        // subject grounding：本文别名 → 行须本文行；否则 term 逐 token/逐字落行键语境
        const rowTokens = tokensOf([...rowKeyTexts(spans), ...(cell.rowGroup ? [cell.rowGroup] : [])].join(" ") || " ");
        const subjectOk = subjectIsOwn
          ? rowIsOwn(document, spans)
          : subjectAlts.some((alt) => alt.every((t) => termGroundedIn(t, rowTokens, rowKeyTexts(spans))));
        if (!subjectOk) continue;
        // metric grounding（不约束时跳过）
        if (!metricUnconstrained && terms.metric.length > 0) {
          const headerTokens = tokensOf(cell.headerPath.join(" ") || " ");
          const metricOk = terms.metric.every((t) => termGroundedIn(t, headerTokens, columnHeaderTexts(spans))) || quoteIn(columnHeaderTexts(spans));
          if (!metricOk) continue;
        }
        // dataset/conditions grounding：表语境（题注/label/行组/全列表头路径）+ 行键语境（场景列是行键的一部分）。
        // 条件词是过滤器：term 级 any-token（见 termGroundedAnyToken 注释）。
        if (terms.context.length > 0) {
          const contextTexts = [...tableContextTexts(spans), ...rowKeyTexts(spans), cell.headerPath.join(" ")];
          const contextTokens = tokensOf(contextTexts.join(" ") || " ");
          const contextOk = terms.context.every((t) => termGroundedContext(t, contextTokens, contextTexts)) || quoteIn([spans.table.caption ?? "", spans.table.label ?? ""]);
          if (!contextOk) continue;
        }
        hits.set(`${file.file}|${table.tableId}|${cell.row}|${cell.col}`, {
          file: file.file, tableId: table.tableId, tableIndex: table.tableIndex, row: cell.row, col: cell.col,
          rowKey: cell.rowKey, headerPath: cell.headerPath, caption: table.caption, label: table.label,
        });
      }
    }
  }
  return hits;
}

export interface VerifyProposalInput {
  document: CertificateDocument;
  claim: { file: string; start: number; end: number; value: string };
  resolved: ResolvedProposal;
  /** 模型可见的确定性渲染文本（renderAllowlist 输出）；缺省时按文档自建（同一确定性函数） */
  renderedTables?: string;
}

/** 模型可见语料文本：各文件 plainLatexText + allowlist 渲染（确定性、与 prompt 同源） */
function visibleCorpusText(document: CertificateDocument, renderedTables: string | undefined): string {
  if (renderedTables !== undefined) return renderedTables;
  return renderAllowlist(buildTableAllowlist(document));
}

export function verifyProposal(input: VerifyProposalInput): ProposalVerification {
  const { document, claim, resolved } = input;
  const abstain = (reason: string, detail: string, category: ProposalAbstainCategory, topCandidate?: ResolvedCell, competitorCount?: number): ProposalVerification => ({
    status: "ABSTAIN", claimId: resolved.claimId, reason, detail, category,
    ...(topCandidate !== undefined ? { topCandidate } : {}), ...(competitorCount !== undefined ? { competitorCount } : {}),
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

  // 2) 引文逐字定位（fail-closed：杜撰引文 → 整个提案不可用）。可定位面 = 源文件 ∪ 模型可见的
  //    确定性渲染文本（allowlist 渲染是解析器从源生成的，模型未见过任何别的文本——引用它看到过的
  //    文本不算伪造；结构侧 grounding 仍只认真实结构 span，不受此影响）。
  const quotes = valid.flatMap((c) => c.raw.evidenceQuotes).map((q) => q.trim()).filter(Boolean);
  const visibleText = `${visibleCorpusText(document, input.renderedTables)}\n${document.files.map((f) => plainLatexText(f.content)).join("\n")}`;
  for (const quote of quotes) {
    if (!norm(visibleText).includes(norm(quote))) return abstain("PROPOSAL_QUOTE_NOT_FOUND", quote.slice(0, 80), "PROPOSAL_QUOTE_NOT_FOUND", top.cell);
  }

  // 3) 论断语境 / 限定词 / 派生边界
  const entry = document.files.find((f) => f.file === atom.file)!;
  const scopes = textScopes(entry.content, atom.start, atom.end);
  const claimTokens = new Set([...tokensOf(scopes.sentence), ...tokensOf(scopes.segment), ...tokensOf(scopes.window)]);
  const spans = structureOf(document, top.cell!);
  if (spans === null) return abstain("NO_VALID_CANDIDATE", "structure not found for top candidate", "NO_VALID_CANDIDATE", top.cell);
  const qualifiers = atomQualifiers(scopes, atom.raw);
  if (qualifiers.includes("APPROX") || qualifiers.includes("INEQUALITY")) {
    return abstain("CLAIM_QUALIFIER_NOT_CERTIFIABLE", `qualifiers=${qualifiers.join(",")}`, "CLAIM_QUALIFIER_NOT_CERTIFIABLE", top.cell);
  }
  const derivedQualified = qualifiers.includes("DERIVED") || qualifiers.includes("AGGREGATE") || qualifiers.includes("SIGNED");
  if (derivedQualified && !DERIVED_COLUMN.test(top.cell!.headerPath.join(" "))) {
    return abstain("DERIVED_RECOMPUTE_OUT_OF_SCOPE", "claim is derived-worded; POC verifies atomic proposals only (paper's own derived columns excepted)", "DERIVED_RECOMPUTE_OUT_OF_SCOPE", top.cell);
  }

  // 4) grounding：term 必须来自论断（claim 侧，模型不得发明论断里没有的概念；本文别名家族互通）
  const terms = groundingTermsOf(resolved.raw);
  const subjectJoined = resolved.raw.subject.trim();
  const subjectIsOwnAlias = OWN_ALIASES.test(subjectJoined);
  const sentencePlain = norm(scopes.sentence);
  const claimSideTerms = subjectIsOwnAlias ? [...terms.metric, ...terms.context] : [...terms.subject, ...terms.metric, ...terms.context];
  for (const term of claimSideTerms) {
    if (term.trim() === "") continue;
    if (!termGroundedIn(term, claimTokens, [scopes.sentence, scopes.segment, scopes.window])) {
      return abstain("PROPOSAL_TERM_NOT_IN_CLAIM", `term "${term}" not found in claim context`, "PROPOSAL_TERM_NOT_IN_CLAIM", top.cell);
    }
  }
  if (subjectIsOwnAlias && !OWN_ALIASES.test(sentencePlain)) {
    return abstain("PROPOSAL_TERM_NOT_IN_CLAIM", "own-alias subject not found in claim sentence", "PROPOSAL_TERM_NOT_IN_CLAIM", top.cell);
  }
  if (terms.subject.length === 0) return abstain("GROUNDING_FAILED", "interpretation has no subject", "GROUNDING_FAILED", top.cell);

  const subjectIsOwn = subjectIsOwnAlias || terms.subject.some((t) => OWN_ROW.test(t) || OWN_ALIASES.test(t));
  const rowTokens = tokensOf([...rowKeyTexts(spans), ...(spans.cell.rowGroup ? [spans.cell.rowGroup] : "")].filter(Boolean).join(" ") || " ");
  const headerTokens = tokensOf(spans.cell.headerPath.join(" ") || " ");
  const contextTexts = [...tableContextTexts(spans), ...rowKeyTexts(spans), spans.cell.headerPath.join(" ")];
  const contextTokens = tokensOf(contextTexts.join(" ") || " ");
  const subjectAlts = subjectAlternatives(terms.subject);
  const subjectGrounded = subjectIsOwn ? rowIsOwn(document, spans) : subjectAlts.some((alt) => alt.every((t) => termGroundedIn(t, rowTokens, rowKeyTexts(spans))));
  if (!subjectGrounded) return abstain("GROUNDING_FAILED", `subject "${resolved.raw.subject}" not grounded in row "${spans.cell.rowKey.join("/")}"`, "GROUNDING_FAILED", top.cell);
  // 修正 A：空主语（全部停用词、非本文别名）不承载身份——只靠值碰巧相等不可证明对应
  const subjectHasContent = subjectIsOwnAlias || terms.subject.some((t) => tokensOf(t).size > 0);
  if (!subjectHasContent) return abstain("GROUNDING_FAILED", "vacuous subject (stopwords only, not own-alias): value coincidence cannot prove correspondence", "GROUNDING_FAILED", top.cell);
  const metricGrounded = terms.metric.length > 0
    && (terms.metric.every((t) => termGroundedIn(t, headerTokens, columnHeaderTexts(spans))) || quotes.some((q) => columnHeaderTexts(spans).some((text) => norm(text).includes(norm(q)))));
  // 条件词佐证过滤（修正 A 语义下的安全方向）：逐条检查 top 候选的表格语境能否佐证该条件词；
  // 不能佐证的条件词（如修辞 fastest/interative 描述，论文表格语境无此词）视为解释性噪声丢弃并记录，
  // 不参与唯一性枚举——过滤器强度只降不升（竞争候选只会更多 → 唯一性更严，不会借丢弃制造假唯一）。
  const corroboratedContext = terms.context.filter((t) =>
    termGroundedContext(t, contextTokens, contextTexts)
    || quotes.some((q) => norm(spans.table.caption ?? "").includes(norm(q)) || norm(spans.table.label ?? "").includes(norm(q))));
  const droppedContext: string[] = terms.context.filter((t) => !corroboratedContext.includes(t));


  // 5) 唯一性（签名枚举；模型指向不删除竞争候选）+ 值佐证列选择（仅 metric 未文字识别时；仿 A2 更严）
  let valueCorroborated = false;
  let multiBinding: { count: number; unanimous: string } | null = null;
  let multiBindingOutcome: "SUPPORTED_CANDIDATE" | "CONTRADICTED_CANDIDATE" | null = null;
  if (!metricGrounded) {
    // metric 未被文字/引文 grounded（含 metric 为空——正文不点名指标）：不允许引文绑定列；
    // 唯一出路 = subject+context 行签名唯一 + 该行恰一个值重叠格 + 表有题注（只能出 SUPPORTED 路径）
    const signatureNoMetric = enumerateSignature(document, { subject: terms.subject, metric: [], context: corroboratedContext }, quotes, true);
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
    const signature = enumerateSignature(document, { ...terms, context: corroboratedContext }, quotes, false);
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
  return {
    status: "ACCEPTED", claimId: resolved.claimId, outcome, cell: top.cell!, value: top.value!,
    grounding: { subject: resolved.raw.subject, metric: resolved.raw.metric, context: terms.context, valueCorroborated, ...(droppedContext.length > 0 ? { droppedContext } : {}), ...(multiBinding !== null ? { multiBinding } : {}) },
    relation: relation.relation, modelCheck,
    checks: [
      "CLAIM_ATOM_LOCATED", "QUOTES_VERBATIM", "TERMS_FROM_CLAIM", "SUBJECT_ROW_GROUNDED",
      metricGrounded ? "METRIC_COLUMN_GROUNDED" : "METRIC_VALUE_CORROBORATED",
      terms.context.length === 0 ? "CONTEXT_EMPTY" : corroboratedContext.length === terms.context.length ? "CONTEXT_TABLE_GROUNDED" : `CONTEXT_PARTIALLY_CORROBORATED(${corroboratedContext.length}/${terms.context.length})`,
      valueCorroborated ? "ROW_SIGNATURE_VALUE_CORROBORATED" : multiBinding !== null ? `MULTI_BINDING_UNANIMOUS(${multiBinding.count})` : "SIGNATURE_UNIQUE",
      "QUALIFIERS_EXPLAINED", "B2_CROSS_TABLE_CLEAR", "DOUBLE_KEY_AGREED",
    ],
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
