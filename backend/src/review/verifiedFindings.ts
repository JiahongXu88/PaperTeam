/**
 * M16 后续：审稿 finding 的确定性证书核验（生产路径，零模型）——把「可在原文复算的科学缺陷」从 L2 模型意见升级为 L1 已核验发现。
 *
 * 此前的确定性设施（claim-certificate/v1、跨节一致性、四轴裁决）只作用于单独抽取的论断账本或摘要 / 结论扫描；审稿人提出的
 * finding 本身从未被证书核对，独立复算成立的缺陷在产品里仍显示为「AI 待核验」（M16 续期收口 G6 PARTIAL）。本模块对每条
 * 可定位的实质性 finding，在其逐字引文内的数值上执行两类确定性检查（只这两类——其他类型一律不判）：
 *
 *  1. TEXT_TABLE_VALUE：引文中的测量值（≥1 位小数）经 bindTextAtom 唯一绑定到表格单元格，按显示精度区间判别
 *     （完全复用 certifyClaim 的原子比较：限定词 / 单位 / 量纲歧义 / 约数一律 fail-closed）。双钥匙：finding 文字须点出
 *     绑定单元格的数值（模型提出对应关系，绑定唯一性与数值关系由确定性检验给出）。
 *  2. TABLE_MULTIPLIER：引文中的倍数论断（「N×」「up to N×」「N times」），所在句（或全文中同值重述且显式引用表格的句子）
 *     唯一引用一张表；枚举候选：单元格本值（含括号内次要值）、同行 / 同列两数之比（只比同序数值：主值比主值、次要值比次要值；
 *     排除实验因子列）、列对跨行比的算术均值。全部候选区间都与论断显示精度区间不相交 → 「论断倍数无法由所引表格按上述运算复现」。
 *     这不证明数字本身是错的（作者可能另有测量口径），只证明所引表格不支持它。
 *     候选集不是全部可能运算的超集：因子列排除与同序限制是在 DYSPEC 开发样例上为消除巧合匹配（5.34781 / 温度 0.6 ≈ 8.9~9.4 区间）
 *     而加入的事后规则，缩小候选会让矛盾更容易成立——其假阳性率尚无独立样本证据。
 *     约数（about / ~）、下界（over / at least）、表格解析受损、表号无法唯一解析 → 不判。
 *
 * 状态（每条 finding）：
 *   VERIFIED_CONTRADICTED   证书成立 + 来源可核验（作者源稿 / 有效人工 QA 证明）→ L1 已核验缺陷；
 *   CERTIFIED_ON_TRANSCRIPT 证书在被审文本上成立，但被审文本是转写投影 / 来源未知（表格可能是转写损坏）→ 需对照原件（作者核对）；
 *   NOT_CERTIFIED           尝试了检查但证书未出具（原因码逐条记录）；
 *   NOT_APPLICABLE          无可检查数值 / 非实质性类别 / 引文无法定位。
 * 「锚定」（引文逐字在原文中）与「已核验」严格区分；另检查 finding 文字点名的表 / 图 / 公式 / 节 / 引文编号是否在原文中存在
 * （DANGLING_REFERENCE 只作定位质量提示，不删除、不降级 finding）。
 * M16 工程收口 C：定位引用三态（VALID / INVALID / UNVERIFIABLE，见 findingLocators.ts）——danglingReferences 只列确定性可判
 * 不存在的引用；转写稿丢失编号等无法判定的情形记 UNVERIFIABLE，不再断言「原文不存在」。INVALID 的 finding 不算可靠定位
 * （anchor.reliable=false），但意见文本与证书判定照旧（证书只依赖被引表格的唯一解析，不可能借无效编号成立）。
 *
 * 证书只说明「被审文本内部的数值关系」；它不授权任何修改（修订仍走 EditContract），也不构成期刊级学术判断。
 */

import { createHash } from "node:crypto";

import type { ReviewIssue } from "../agents/ReviewerService.js";
import type { SourceVerification } from "./reviewContextSnapshot.js";
import { locateQuote } from "./claimAuditText.js";
import {
  CLAIM_CERTIFICATE_VERSION,
  bindTextAtom,
  buildCertificateDocument,
  certifyClaim,
  locateAtom,
  textScopes,
  type CertificateDocument,
} from "./claimCertificate.js";
import type { LatexTable } from "./latexTable.js";
import { assessFindingLocators, buildLocatorIndex, type FindingLocatorAssessment, type LocatorIndex } from "./findingLocators.js";

export const VERIFIED_FINDINGS_SCHEMA = "paperteam.verified-findings/v1";
export const VERIFIED_FINDINGS_RULES = "verified-findings-rules/v1";

export type FindingCheckKind = "TEXT_TABLE_VALUE" | "TABLE_MULTIPLIER";
export type FindingCheckOutcome = "CONTRADICTED" | "CONSISTENT" | "NOT_CERTIFIED";
export type FindingVerificationStatus = "VERIFIED_CONTRADICTED" | "CERTIFIED_ON_TRANSCRIPT" | "NOT_CERTIFIED" | "NOT_APPLICABLE";
export type AnchorStatus = "LOCATED" | "QUOTE_NOT_LOCATED" | "NO_QUOTE";

export interface FindingCheckRecord {
  kind: FindingCheckKind;
  outcome: FindingCheckOutcome;
  /** 论断原子：原文数字、所在行号、所在句（截断） */
  claim: { raw: string; value: number; decimals: number; unit: string | null; file: string; start: number; end: number; line: number; sentence: string };
  /** TEXT_TABLE_VALUE：唯一绑定的单元格 */
  counterpart?: { file: string; tableLabel: string | null; tableCaption: string | null; rowKey: string[]; headerPath: string[]; raw: string; line: number };
  /** TABLE_MULTIPLIER：所引表格与复算 */
  recompute?: {
    table: { file: string; label: string | null; caption: string | null; number: number | null; line: number; resolvedVia: string };
    qualifier: "UP_TO" | "EXACT";
    claimInterval: [number, number];
    candidates: number;
    nearest: { value: number; formula: string } | null;
  };
  /** 判定依据（显示精度区间 / 关系说明） */
  tolerance: string;
  reasons: string[];
  /** 复算输入摘要：同一输入 → 同一哈希 */
  inputsSha256: string;
}

export interface FindingVerificationRecord {
  findingId: string;
  issueIndex: number;
  category: string;
  severityObserved: string;
  anchor: {
    status: AnchorStatus;
    file: string | null;
    line: number | null;
    /** 确定性可判「原文不存在」的引用（= locator 中 INVALID 项） */
    danglingReferences: string[];
    /** M16 工程收口 C：定位引用三态评估（缺省 = 旧产物） */
    locator?: FindingLocatorAssessment;
    /** 引文逐字定位且没有确定性无效的引用（缺省 = 旧产物，按 status === LOCATED 理解） */
    reliable?: boolean;
  };
  status: FindingVerificationStatus;
  /** 确定性陈述（由证书生成，不含模型文字） */
  statement: string | null;
  checks: FindingCheckRecord[];
}

export interface VerifiedFindingsArtifact {
  schema: typeof VERIFIED_FINDINGS_SCHEMA;
  rules: typeof VERIFIED_FINDINGS_RULES;
  certificateVersion: typeof CLAIM_CERTIFICATE_VERSION;
  generatedAt: string;
  round: number;
  sourceRevision: number | null;
  /** sha256(file\0content…)：证书绑定的被审文本 */
  documentFingerprint: string;
  files: Array<{ file: string; sha256: string }>;
  sourceVerification: SourceVerification;
  records: FindingVerificationRecord[];
  summary: VerifiedFindingsSummary;
}

export interface VerifiedFindingsSummary {
  findings: number;
  located: number;
  checked: number;
  verifiedContradicted: number;
  certifiedOnTranscript: number;
  notCertified: number;
  danglingReferences: number;
  /** M16 工程收口 C：含无法在本输入判定的定位引用的 finding 数（缺省 = 旧产物） */
  unverifiableLocators?: number;
  /** 可靠定位（引文逐字定位且无确定性无效引用）的 finding 数（缺省 = 旧产物） */
  reliablyLocated?: number;
  sourceVerification: SourceVerification;
}

export interface VerifyFindingsInput {
  round: number;
  sourceRevision: number | null;
  files: ReadonlyArray<{ file: string; content: string }>;
  issues: readonly ReviewIssue[];
  sourceVerification: SourceVerification;
  findingFingerprint: (issue: ReviewIssue) => string;
  now?: () => Date;
}

const SUBSTANTIVE = new Set(["fact", "academic", "evidence_gap"]);
const MAX_CHECKS_PER_FINDING = 8;

function sha(text: string): string {
  return createHash("sha256").update(text, "utf8").digest("hex");
}

function lineOf(content: string, offset: number): number {
  let line = 1;
  for (let i = 0; i < offset && i < content.length; i += 1) if (content.charCodeAt(i) === 10) line += 1;
  return line;
}

export function sourceIsVerifiable(level: SourceVerification): boolean {
  return level === "AUTHOR_SOURCE" || level === "SOURCE_ATTESTED";
}

function halfUlp(decimals: number): number {
  return 0.5 * 10 ** -Math.max(0, decimals);
}

function overlaps(a: [number, number], b: [number, number]): boolean {
  return a[0] <= b[1] && b[0] <= a[1];
}

// ---- 表号解析 ----

/** 表格编号：按文档顺序数浮动体中带 caption 的表；任一浮动体表缺 caption → 编号不可证（null） */
function numberedTables(document: CertificateDocument): Array<{ file: string; table: LatexTable; number: number }> | null {
  const out: Array<{ file: string; table: LatexTable; number: number }> = [];
  const seenFloats = new Set<string>();
  let n = 0;
  for (const file of document.files) {
    for (const table of file.tables) {
      if (table.floatStart === null) continue;
      const floatKey = `${file.file}@${table.floatStart}`;
      if (seenFloats.has(floatKey)) continue; // 同一浮动体中的多个 tabular 共用一个编号
      seenFloats.add(floatKey);
      if (table.caption === null) return null;
      n += 1;
      out.push({ file: file.file, table, number: n });
    }
  }
  return out;
}

interface TableRef { kind: "label" | "number"; key: string }

function tableRefs(sentence: string): TableRef[] {
  const refs: TableRef[] = [];
  for (const match of sentence.matchAll(/\\(?:auto|c|C|v|name)?ref\*?\s*\{([^}]+)\}/g)) {
    for (const key of match[1]!.split(",")) refs.push({ kind: "label", key: key.trim() });
  }
  for (const match of sentence.matchAll(/\b(?:Table|Tab\.)\s*~?\s*(\d+)\b|表\s*(\d+)/g)) refs.push({ kind: "number", key: match[1] ?? match[2]! });
  return refs;
}

function resolveTable(document: CertificateDocument, refs: TableRef[]): { file: string; table: LatexTable; number: number | null; via: string } | { error: string } {
  const resolved = new Map<string, { file: string; table: LatexTable; number: number | null; via: string }>();
  let numbered: ReturnType<typeof numberedTables> | undefined;
  for (const ref of refs) {
    if (ref.kind === "label") {
      for (const file of document.files) {
        for (const table of file.tables) {
          if (table.label === ref.key) resolved.set(`${file.file}#${table.tableIndex}`, { file: file.file, table, number: null, via: `\\ref{${ref.key}}` });
        }
      }
      // 非表格标签（图 / 公式 / 节）不计
    } else {
      numbered ??= numberedTables(document);
      if (numbered === null) return { error: "TABLE_NUMBERING_UNRESOLVABLE" };
      const hit = numbered.find((entry) => entry.number === Number(ref.key));
      if (hit === undefined) return { error: `TABLE_${ref.key}_NOT_FOUND` };
      resolved.set(`${hit.file}#${hit.table.tableIndex}`, { file: hit.file, table: hit.table, number: hit.number, via: `Table ${ref.key}` });
    }
  }
  if (resolved.size === 0) return { error: "NO_TABLE_REFERENCE" };
  if (resolved.size > 1) return { error: "MULTIPLE_TABLE_REFERENCES" };
  return [...resolved.values()][0]!;
}

// ---- 倍数论断 ----

const MULTIPLIER_AFTER = /^\s*\$?\s*(?:\\times|×|x(?![a-z0-9])|-?\s*fold\b|\s*times\b|倍)/i;
const APPROX_BEFORE = /(?:about|around|approximately|approx\.?|roughly|nearly|almost|close to|~|\\sim|\\approx|≈|约|大约|近)\s*\$?\s*$/i;
const LOWER_BOUND_BEFORE = /(?:over|more than|at least|exceed\w*|above|beyond|greater than|>|\\geq?|\\ge|超过|至少|以上)\s*\$?\s*$/i;
const UP_TO_BEFORE = /(?:up to|as (?:much|high|large|fast) as|at most|maximum of|最高|最多|高达)\s*\$?\s*$/i;
const AGGREGATE_WORDS = /\b(?:average|averaged|mean|on average|overall|geometric mean|median)\b|平均/i;

interface NumberHit { raw: string; value: number; decimals: number; start: number; end: number }

function numbersIn(content: string, start: number, end: number): NumberHit[] {
  const out: NumberHit[] = [];
  const slice = content.slice(start, end);
  // 数字后紧跟字母不算独立数字（「v2」「3D」），唯一例外是倍数记号「9.4x」
  for (const match of slice.matchAll(/(?<![\w.])(\d+(?:\.\d+)?)(?![\d_])(?!(?!x\b)[A-Za-z])/g)) {
    const raw = match[1]!;
    out.push({ raw, value: Number(raw), decimals: raw.includes(".") ? raw.split(".")[1]!.length : 0, start: start + match.index!, end: start + match.index! + raw.length });
  }
  return out;
}

function cellNumbers(raw: string): Array<{ value: number; decimals: number }> {
  return [...raw.replace(/\\[a-zA-Z]+/g, " ").matchAll(/(?<![\w.])(\d+(?:\.\d+)?|\.\d+)(?![\w])/g)].map((match) => {
    const text = match[1]!;
    return { value: Number(text), decimals: text.includes(".") ? text.split(".")[1]!.length : 0 };
  }).filter((entry) => Number.isFinite(entry.value) && entry.value > 0);
}

interface Candidate { lo: number; hi: number; formula: string }

function ratio(a: { value: number; decimals: number }, b: { value: number; decimals: number }): [number, number] | null {
  const ha = halfUlp(a.decimals);
  const hb = halfUlp(b.decimals);
  if (b.value - hb <= 0 || a.value - ha <= 0) return null;
  return [(a.value - ha) / (b.value + hb), (a.value + ha) / (b.value - hb)];
}

/** 表格完整性：数据行全部同宽、无解析问题、至少 2 列数值 */
function tableIntegrity(table: LatexTable): string[] {
  const issues = table.parseIssues.map((issue) => `TABLE_PARSE_${issue}`);
  const data = table.rows.filter((row) => row.kind === "data");
  if (data.length === 0) issues.push("TABLE_NO_DATA_ROWS");
  const widths = new Set(data.map((row) => row.cells.reduce((sum, cell) => sum + cell.colSpan, 0)));
  if (widths.size > 1 || (widths.size === 1 && [...widths][0] !== table.columnCount)) issues.push("TABLE_ROW_WIDTH_INCONSISTENT");
  const numericCols = new Set(table.cells.filter((cell) => !cell.isHeader && cell.value !== null).map((cell) => cell.col));
  if (numericCols.size < 2) issues.push("TABLE_TOO_FEW_NUMERIC_COLUMNS");
  return issues;
}

function multiplierCandidates(table: LatexTable): Candidate[] {
  const out: Candidate[] = [];
  const data = table.rows.filter((row) => row.kind === "data");
  const label = (row: number, col: number) => {
    const cell = table.cells.find((entry) => entry.row === row && entry.col === col);
    return `${cell?.rowKey.join("/") ?? `r${row}`}·${cell?.headerPath.slice(-1)[0] ?? `c${col}`}`;
  };
  // 每个单元格的全部数值（slot 0 = 主值，slot ≥1 = 括号内 / ± 次要值），按（行, 列）
  const values = new Map<string, Array<{ value: number; decimals: number; row: number; col: number; slot: number }>>();
  for (const row of data) {
    for (const cell of row.cells) {
      if (cell.isHeader || cell.rowKey.length === 0 && cell.value === null) continue;
      const nums = cellNumbers(cell.raw);
      if (nums.length === 0) continue;
      values.set(`${row.index}:${cell.col}`, nums.map((num, slot) => ({ ...num, row: row.index, col: cell.col, slot })));
    }
  }
  // 实验因子列（温度 / 批大小 / k 等设置值）：≥4 个数据行、主值大量重复（不同值 ≤ 行数一半）——不是测量量，不作比值操作数
  const factorCols = new Set<number>();
  const columns = [...new Set([...values.values()].flat().map((entry) => entry.col))];
  for (const col of columns) {
    // 用单元格主值（含 0；比值候选才排除非正数）
    const primaries = table.cells.filter((cell) => cell.col === col && !cell.isHeader && cell.value !== null).map((cell) => cell.value!.value);
    if (primaries.length >= 4 && new Set(primaries).size <= Math.floor(primaries.length / 2)) factorCols.add(col);
  }
  const all = [...values.values()].flat();
  for (const entry of all) {
    const h = halfUlp(entry.decimals);
    out.push({ lo: entry.value - h, hi: entry.value + h, formula: `${label(entry.row, entry.col)}=${entry.value}` });
  }
  const operands = all.filter((entry) => !factorCols.has(entry.col));
  for (const a of operands) {
    for (const b of operands) {
      // 同一单元格内主 / 次值互除无意义；主值只与主值、同序次要值只与同序次要值相比
      if (a === b || a.slot !== b.slot || (a.row === b.row && a.col === b.col)) continue;
      if (a.row !== b.row && a.col !== b.col) continue;
      const r = ratio(a, b);
      if (r !== null) out.push({ lo: r[0], hi: r[1], formula: `${label(a.row, a.col)} ${a.value} / ${label(b.row, b.col)} ${b.value}` });
    }
  }
  // 同两列跨行的平均比（「平均 N×」可能的口径）：每对列取各行主值比的算术均值
  const cols = columns.filter((col) => !factorCols.has(col));
  for (const ca of cols) {
    for (const cb of cols) {
      if (ca === cb) continue;
      const ratios: Array<[number, number]> = [];
      for (const row of data) {
        const a = values.get(`${row.index}:${ca}`)?.[0];
        const b = values.get(`${row.index}:${cb}`)?.[0];
        if (a === undefined || b === undefined) continue;
        const r = ratio(a, b);
        if (r !== null) ratios.push(r);
      }
      if (ratios.length >= 2) {
        out.push({ lo: ratios.reduce((s, r) => s + r[0], 0) / ratios.length, hi: ratios.reduce((s, r) => s + r[1], 0) / ratios.length, formula: `mean over rows of col${ca}/col${cb}` });
      }
    }
  }
  return out;
}

/** finding 文字点名的表号（Table N / 表 N） */
function citedTableNumbers(text: string): number[] {
  return [...new Set([...text.matchAll(/\b(?:Table|Tab\.)\s*~?\s*(\d+)\b|表\s*(\d+)/g)].map((match) => Number(match[1] ?? match[2])))];
}

function checkMultiplier(document: CertificateDocument, file: string, hit: NumberHit, findingText: string): FindingCheckRecord {
  const entry = document.files.find((candidate) => candidate.file === file)!;
  const scopes = textScopes(entry.content, hit.start, hit.end);
  const before = entry.content.slice(Math.max(0, hit.start - 48), hit.start).replace(/\s+/g, " ");
  const reasons: string[] = [];
  const claimInterval: [number, number] = [hit.value - halfUlp(hit.decimals), hit.value + halfUlp(hit.decimals)];
  const base = (outcome: FindingCheckOutcome, extra: Partial<FindingCheckRecord> = {}): FindingCheckRecord => ({
    kind: "TABLE_MULTIPLIER",
    outcome,
    claim: { raw: hit.raw, value: hit.value, decimals: hit.decimals, unit: "×", file, start: hit.start, end: hit.end, line: lineOf(entry.content, hit.start), sentence: scopes.sentence.slice(0, 400) },
    tolerance: `论断显示精度区间 [${claimInterval[0]}, ${claimInterval[1]}]；候选按单元格显示精度做区间算术`,
    reasons,
    inputsSha256: "",
    ...extra,
  });
  if (APPROX_BEFORE.test(before)) {
    reasons.push("APPROX_QUALIFIER");
    return base("NOT_CERTIFIED");
  }
  if (LOWER_BOUND_BEFORE.test(before)) {
    reasons.push("LOWER_BOUND_QUALIFIER");
    return base("NOT_CERTIFIED");
  }
  const qualifier: "UP_TO" | "EXACT" = UP_TO_BEFORE.test(before) ? "UP_TO" : "EXACT";
  // 表格引用：本句；本句没有 → 全文中同值倍数且显式引用表格的句子（同一论断的重述），必须指向同一张表
  let refs = tableRefs(scopes.sentence);
  let via = "same sentence";
  if (refs.length === 0) {
    const restated: TableRef[][] = [];
    for (const doc of document.files) {
      for (const other of numbersIn(doc.content, 0, doc.content.length)) {
        if (other.raw !== hit.raw || (doc.file === file && other.start === hit.start)) continue;
        if (!MULTIPLIER_AFTER.test(doc.content.slice(other.end, other.end + 12))) continue;
        if (document.files.some((f) => f.tables.some((t) => f.file === doc.file && other.start >= t.start && other.start < t.end))) continue;
        const sentence = textScopes(doc.content, other.start, other.end).sentence;
        const found = tableRefs(sentence);
        if (found.length > 0) restated.push(found);
      }
    }
    if (restated.length > 0) {
      refs = restated.flat();
      via = `restatement of ${hit.raw}× elsewhere in the paper`;
    }
  }
  const resolved = resolveTable(document, refs);
  if ("error" in resolved) {
    reasons.push(resolved.error);
    return base("NOT_CERTIFIED");
  }
  const tableEntry = document.files.find((candidate) => candidate.file === resolved.file)!;
  const tableInfo = { file: resolved.file, label: resolved.table.label, caption: resolved.table.caption, number: resolved.number, line: lineOf(tableEntry.content, resolved.table.start), resolvedVia: `${resolved.via} (${via})` };
  const integrity = tableIntegrity(resolved.table);
  if (integrity.length > 0) {
    reasons.push(...integrity);
    return base("NOT_CERTIFIED", { recompute: { table: tableInfo, qualifier, claimInterval, candidates: 0, nearest: null } });
  }
  if (qualifier === "EXACT" && AGGREGATE_WORDS.test(scopes.sentence)) {
    // 均值口径已纳入候选（列对均值比），但几何均值 / 加权均值无法穷举 → 只在非聚合措辞下出证书
    reasons.push("AGGREGATE_WORDING");
    return base("NOT_CERTIFIED", { recompute: { table: tableInfo, qualifier, claimInterval, candidates: 0, nearest: null } });
  }
  const candidates = multiplierCandidates(resolved.table);
  const mid = (c: Candidate) => (c.lo + c.hi) / 2;
  const nearest = candidates.reduce<Candidate | null>((best, c) => (best === null || Math.abs(mid(c) - hit.value) < Math.abs(mid(best) - hit.value) ? c : best), null);
  const matched = candidates.filter((c) => overlaps([c.lo, c.hi], claimInterval));
  const recompute = { table: tableInfo, qualifier, claimInterval, candidates: candidates.length, nearest: nearest === null ? null : { value: Number(mid(nearest).toFixed(4)), formula: nearest.formula } };
  const inputsSha256 = sha([VERIFIED_FINDINGS_RULES, hit.raw, qualifier, tableEntry.content.slice(resolved.table.start, resolved.table.end)].join("\u0000"));
  if (matched.length > 0) {
    reasons.push(`REPRODUCIBLE_CANDIDATE:${matched[0]!.formula}`);
    return base("CONSISTENT", { recompute, inputsSha256 });
  }
  if (candidates.length === 0) {
    reasons.push("NO_CANDIDATES");
    return base("NOT_CERTIFIED", { recompute, inputsSha256 });
  }
  // 双钥匙：finding 须点名该表（否则它说的可能是同句里的别的事，如「缺 up to 限定」）；表号不可证 → 无法确认关联 → 不判
  const printed = resolved.number ?? numberedTables(document)?.find((entry) => entry.file === resolved.file && entry.table.tableIndex === resolved.table.tableIndex)?.number ?? null;
  if (printed === null || !citedTableNumbers(findingText).includes(printed)) {
    reasons.push("FINDING_DOES_NOT_CITE_TABLE");
    return base("NOT_CERTIFIED", { recompute, inputsSha256 });
  }
  return base("CONTRADICTED", { recompute, inputsSha256 });
}

// ---- 文表数值 ----

function checkTextTable(document: CertificateDocument, file: string, hit: NumberHit, findingText: string): FindingCheckRecord | null {
  const entry = document.files.find((candidate) => candidate.file === file)!;
  const located = locateAtom(document, file, hit.start, hit.end, hit.raw);
  if (located.atom === null || located.atom.kind !== "TEXT") return null;
  const atom = located.atom;
  const scopes = textScopes(entry.content, hit.start, hit.end);
  const reasons: string[] = [];
  const claim = { raw: atom.raw, value: atom.value, decimals: atom.decimals, unit: atom.unit, file, start: atom.start, end: atom.end, line: lineOf(entry.content, atom.start), sentence: scopes.sentence.slice(0, 400) };
  const base = (outcome: FindingCheckOutcome, extra: Partial<FindingCheckRecord> = {}): FindingCheckRecord => ({
    kind: "TEXT_TABLE_VALUE", outcome, claim, tolerance: "显示精度区间判别（claim-certificate/v1 compareAtoms）", reasons, inputsSha256: "", ...extra,
  });
  // 整数（计数 / 配置值）不进矛盾判定（与跨节一致性同口径）
  if (atom.decimals === 0) return null;
  if (atom.qualifiers.length > 0) {
    reasons.push(...atom.qualifiers.map((q) => `QUALIFIER_${q}`));
    return base("NOT_CERTIFIED");
  }
  // 绑定范围：finding 恰好点名一张可解析的表时，只在该表内要求唯一绑定（对应关系由审稿人提出，唯一性与数值关系仍是确定性检验）；
  // 全文绑定若不靠「格值与论断值重叠」的平局裁决就唯一落在另一张表 → 两个依据冲突，不判。
  // finding 没有点名唯一的表 → 只接受全文唯一绑定。
  let scope = document;
  const global = bindTextAtom(document, atom);
  const cited = citedTableNumbers(findingText);
  const target = cited.length === 1 ? numberedTables(document)?.find((entry) => entry.number === cited[0]) : undefined;
  let binding = global;
  if (target !== undefined) {
    const globalElsewhere = global.status === "UNIQUE" && global.bound !== undefined && global.valueTieBreak !== true &&
      !(global.bound.file === target.file && global.bound.tableId === target.table.tableId);
    if (globalElsewhere) {
      reasons.push("CITED_TABLE_CONFLICTS_WITH_GLOBAL_BINDING");
      return base("NOT_CERTIFIED");
    }
    scope = { ...document, files: document.files.map((candidate) => ({ ...candidate, tables: candidate.tables.map((table) => (candidate.file === target.file && table.tableIndex === target.table.tableIndex ? table : { ...table, cells: [] })) })) };
    binding = bindTextAtom(scope, atom);
    if (binding.status !== "UNIQUE" || binding.bound === undefined) {
      reasons.push(`CITED_TABLE_BINDING_${binding.status}:${binding.rule}`);
      return base("NOT_CERTIFIED");
    }
  } else if (global.status !== "UNIQUE" || global.bound === undefined) {
    reasons.push(`BINDING_${global.status}:${global.rule}`);
    return base("NOT_CERTIFIED");
  }
  const bound = binding.bound!;
  const boundFile = scope.files.find((candidate) => candidate.file === bound.file)!;
  const table = boundFile.tables.find((candidate) => candidate.tableId === bound.tableId);
  const cell = table?.cells.find((candidate) => candidate.row === bound.row && candidate.col === bound.col);
  if (table === undefined || cell === undefined || cell.valueStart === null || cell.valueEnd === null) {
    reasons.push("BOUND_CELL_NOT_FOUND");
    return base("NOT_CERTIFIED");
  }
  const counterpart = { file: bound.file, tableLabel: table.label, tableCaption: table.caption, rowKey: bound.rowKey, headerPath: bound.headerPath, raw: bound.value, line: lineOf(boundFile.content, cell.valueStart) };
  const certificate = certifyClaim(scope, {
    claim: { file, start: atom.start, end: atom.end, value: atom.raw },
    counterpart: { file: bound.file, start: cell.valueStart, end: cell.valueEnd, value: bound.value },
    check: "INCONSISTENT",
  });
  reasons.push(...certificate.reasons);
  const relation = certificate.valueRelation?.relation;
  if (certificate.comparisonType === "SAME_OBSERVABLE" && relation === "OVERLAP") {
    return base("CONSISTENT", { counterpart, tolerance: certificate.valueRelation?.note ?? "", inputsSha256: certificate.inputsSha256 });
  }
  if (certificate.outcome !== "CONTRADICTED") return base("NOT_CERTIFIED", { counterpart, inputsSha256: certificate.inputsSha256 });
  // 双钥匙：finding 必须点出绑定单元格的数值（对应关系由审稿人提出；否则这条 finding 说的可能是同句里的别的事）
  const mentioned = new RegExp(`(?<![0-9.])${bound.value.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}(?![0-9])`).test(findingText);
  if (!mentioned) {
    reasons.push("FINDING_DOES_NOT_CITE_BOUND_CELL");
    return base("NOT_CERTIFIED", { counterpart, inputsSha256: certificate.inputsSha256 });
  }
  return base("CONTRADICTED", { counterpart, tolerance: certificate.valueRelation?.note ?? "", inputsSha256: certificate.inputsSha256 });
}

// ---- 定位质量 ----

/**
 * finding 文字点名、且在确定性可判范围内证明原文中不存在的表 / 图 / 公式 / 数字引文 / 标签 / 引文键
 * （M16 工程收口 C：无法判定的引用不在此列，见 assessFindingLocators）
 */
export function danglingReferences(text: string, document: CertificateDocument, sourceVerification: SourceVerification = "SOURCE_UNKNOWN"): string[] {
  return invalidRefs(assessFindingLocators(text, locatorIndexOf(document, sourceVerification)));
}

function locatorIndexOf(document: CertificateDocument, sourceVerification: SourceVerification): LocatorIndex {
  return buildLocatorIndex({ files: document.files, sourceVerification });
}

function invalidRefs(assessment: FindingLocatorAssessment): string[] {
  return assessment.refs.filter((entry) => entry.status === "INVALID").map((entry) => entry.ref);
}

// ---- 主入口 ----

export function verifyFindings(input: VerifyFindingsInput): VerifiedFindingsArtifact {
  const document = buildCertificateDocument(input.files);
  const verifiable = sourceIsVerifiable(input.sourceVerification);
  const locatorIndex = locatorIndexOf(document, input.sourceVerification);
  const records: FindingVerificationRecord[] = input.issues.map((issue, issueIndex) => {
    const findingId = input.findingFingerprint(issue);
    const findingText = [issue.description, issue.reason ?? ""].join("\n");
    const locator = assessFindingLocators(findingText, locatorIndex);
    const dangling = invalidRefs(locator);
    const quote = typeof issue.quote === "string" ? issue.quote : "";
    let span: { file: string; start: number; end: number } | null = null;
    if (quote.trim() !== "") {
      const preferred = issue.file === undefined ? input.files : [...input.files.filter((file) => file.file === issue.file), ...input.files.filter((file) => file.file !== issue.file)];
      for (const file of preferred) {
        const hit = locateQuote(file.content, quote);
        if (hit !== null) {
          span = { file: file.file, start: hit.start, end: hit.end };
          break;
        }
      }
    }
    const anchorContent = span === null ? null : input.files.find((file) => file.file === span!.file)!.content;
    const anchor = {
      status: (quote.trim() === "" ? "NO_QUOTE" : span === null ? "QUOTE_NOT_LOCATED" : "LOCATED") as AnchorStatus,
      file: span?.file ?? null,
      line: span === null || anchorContent === null ? null : lineOf(anchorContent, span.start),
      danglingReferences: dangling,
      locator,
      reliable: span !== null && locator.status !== "INVALID_LOCATOR",
    };
    const record: FindingVerificationRecord = { findingId, issueIndex, category: issue.category, severityObserved: issue.severity, anchor, status: "NOT_APPLICABLE", statement: null, checks: [] };
    if (span === null || !SUBSTANTIVE.has(issue.category) || issue.deterministicDisconfirmed === true) return record;
    const content = anchorContent!;
    const checks: FindingCheckRecord[] = [];
    for (const hit of numbersIn(content, span.start, span.end)) {
      if (checks.length >= MAX_CHECKS_PER_FINDING) break;
      // finding 文字须提到该数值（引文里的其他数字不是这条意见的对象）
      if (!new RegExp(`(?<![0-9.])${hit.raw.replace(/\./g, "\\.")}(?![0-9])`).test(findingText)) continue;
      if (MULTIPLIER_AFTER.test(content.slice(hit.end, hit.end + 12))) {
        checks.push(checkMultiplier(document, span.file, hit, findingText));
        continue;
      }
      const textCheck = checkTextTable(document, span.file, hit, findingText);
      if (textCheck !== null) checks.push(textCheck);
    }
    record.checks = checks;
    if (checks.length === 0) return record;
    const contradicted = checks.filter((check) => check.outcome === "CONTRADICTED");
    if (contradicted.length === 0) {
      record.status = "NOT_CERTIFIED";
      return record;
    }
    record.status = verifiable ? "VERIFIED_CONTRADICTED" : "CERTIFIED_ON_TRANSCRIPT";
    record.statement = contradicted.map(describeCheck).join("；");
    return record;
  });
  const summary: VerifiedFindingsSummary = {
    findings: records.length,
    located: records.filter((record) => record.anchor.status === "LOCATED").length,
    checked: records.filter((record) => record.checks.length > 0).length,
    verifiedContradicted: records.filter((record) => record.status === "VERIFIED_CONTRADICTED").length,
    certifiedOnTranscript: records.filter((record) => record.status === "CERTIFIED_ON_TRANSCRIPT").length,
    notCertified: records.filter((record) => record.status === "NOT_CERTIFIED").length,
    danglingReferences: records.filter((record) => record.anchor.danglingReferences.length > 0).length,
    unverifiableLocators: records.filter((record) => record.anchor.locator?.status === "UNVERIFIABLE_LOCATOR").length,
    reliablyLocated: records.filter((record) => record.anchor.reliable === true).length,
    sourceVerification: input.sourceVerification,
  };
  return {
    schema: VERIFIED_FINDINGS_SCHEMA,
    rules: VERIFIED_FINDINGS_RULES,
    certificateVersion: CLAIM_CERTIFICATE_VERSION,
    generatedAt: (input.now ?? (() => new Date()))().toISOString(),
    round: input.round,
    sourceRevision: input.sourceRevision,
    documentFingerprint: sha(input.files.map((file) => `${file.file}\u0000${file.content}`).join("\u0001")),
    files: input.files.map((file) => ({ file: file.file, sha256: sha(file.content) })),
    sourceVerification: input.sourceVerification,
    records,
    summary,
  };
}

export function describeCheck(check: FindingCheckRecord): string {
  if (check.kind === "TABLE_MULTIPLIER" && check.recompute !== undefined) {
    const table = check.recompute.table;
    const name = table.number !== null ? `Table ${table.number}` : table.label !== null ? `表 ${table.label}` : "所引表格";
    return `「${check.recompute.qualifier === "UP_TO" ? "up to " : ""}${check.claim.raw}×」（${check.claim.file}:${check.claim.line}）无法由 ${name}（${table.file}:${table.line}）复现：` +
      `单元格值、同行 / 同列同序两数之比（不含实验因子列）与列对均值比共 ${check.recompute.candidates} 个候选，均不落在 [${check.recompute.claimInterval[0].toFixed(4)}, ${check.recompute.claimInterval[1].toFixed(4)}]（所引表格不支持该数字；不排除作者另有测量口径）` +
      (check.recompute.nearest === null ? "" : `；最接近 ${check.recompute.nearest.value}（${check.recompute.nearest.formula}）`);
  }
  if (check.kind === "TEXT_TABLE_VALUE" && check.counterpart !== undefined) {
    return `正文 ${check.claim.raw}${check.claim.unit ?? ""}（${check.claim.file}:${check.claim.line}）与唯一绑定的表格单元格 ${check.counterpart.rowKey.join("/")} · ${check.counterpart.headerPath.join(" › ")} = ${check.counterpart.raw}（${check.counterpart.file}:${check.counterpart.line}）不一致（${check.tolerance}）`;
  }
  return `${check.kind} ${check.outcome}`;
}

/** 历史产物 / 外部 JSON 的最小结构校验（旧报告没有本产物 → null，读取方显示 NOT_EVALUATED，绝不补 VERIFIED） */
export function readVerifiedFindings(value: unknown): VerifiedFindingsArtifact | null {
  if (typeof value !== "object" || value === null) return null;
  const record = value as Partial<VerifiedFindingsArtifact>;
  if (record.schema !== VERIFIED_FINDINGS_SCHEMA || !Array.isArray(record.records) || typeof record.summary !== "object" || record.summary === null) return null;
  return record as VerifiedFindingsArtifact;
}

/** gate / QualityReport / UI 消费的紧凑摘要（含逐条记录的有界投影：确定性陈述 + 证书要素，不含模型全文） */
export interface VerifiedFindingsGateSummary {
  schema: typeof VERIFIED_FINDINGS_SCHEMA;
  status: "EVALUATED" | "UNAVAILABLE";
  unavailableReason: string | null;
  path: string | null;
  documentFingerprint: string | null;
  summary: VerifiedFindingsSummary;
  statements: string[];
  records: Array<Pick<FindingVerificationRecord, "findingId" | "issueIndex" | "category" | "severityObserved" | "anchor" | "status" | "statement"> & { checks: FindingCheckRecord[] }>;
}

export function verifiedFindingsGateSummary(artifact: VerifiedFindingsArtifact | null, unavailableReason: string | null, path: string | null = null): VerifiedFindingsGateSummary {
  if (artifact === null) {
    return {
      schema: VERIFIED_FINDINGS_SCHEMA, status: "UNAVAILABLE", unavailableReason: unavailableReason ?? "UNKNOWN", path: null, documentFingerprint: null,
      summary: { findings: 0, located: 0, checked: 0, verifiedContradicted: 0, certifiedOnTranscript: 0, notCertified: 0, danglingReferences: 0, sourceVerification: "SOURCE_UNKNOWN" },
      statements: [], records: [],
    };
  }
  const shown = artifact.records.filter((record) => record.status !== "NOT_APPLICABLE" || record.anchor.danglingReferences.length > 0);
  return {
    schema: VERIFIED_FINDINGS_SCHEMA,
    status: "EVALUATED",
    unavailableReason: null,
    path,
    documentFingerprint: artifact.documentFingerprint,
    summary: artifact.summary,
    statements: artifact.records.filter((record) => record.statement !== null && (record.status === "VERIFIED_CONTRADICTED" || record.status === "CERTIFIED_ON_TRANSCRIPT")).map((record) => record.statement!),
    records: shown.slice(0, 40).map((record) => ({
      findingId: record.findingId, issueIndex: record.issueIndex, category: record.category, severityObserved: record.severityObserved,
      anchor: record.anchor, status: record.status, statement: record.statement, checks: record.checks,
    })),
  };
}
