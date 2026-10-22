/**
 * M15.1 Review Claim Ledger（版本化 claim audit artifact；确定性整理 + 有界跨单元核对，零自报覆盖率）。
 *
 * 解决的缺口（M15 校准实验 110/110 只读 run）：长文档单元审稿只产出 issues / 分数，fact 路的 claims 在单元模式里
 * 不存在——unsupported_critical_claims_zero 因「没有核验输入」恒为 NOT_EVALUATED。本模块不靠空数组或强行置
 * 「已评估」消除它，而是建立可追溯的论断账本：
 *
 *  - claimId 由确定性规则从「文件 + 规范化原文片段 + 文件内出现序号」派生（CLAIM_ID_RULE），不用模型自由生成的 id；
 *  - 每条论断必须能在其所属单元原文中逐字定位（空白折叠 + NFKC），记录文件内 span / 行号与原文 sha256；
 *    定位失败的模型条目进入 rejected，不进入账本；
 *  - verificationStatus 与 basis / verifier 分开：模型判断只能给 REVIEWER_*；VERIFIED_* 只来自 verified Evidence、
 *    作者实验包复算、或「原文内跨处核对」（双引文逐字定位 + 写出的数值确定性比较 + 来源可核验）；
 *    「没有找到证据」永远不等于已证伪；
 *  - 依赖其他单元 / 表 / 图 / 公式而材料不可得 → contextCompleteness=INCOMPLETE，不得给出已核实矛盾；
 *    PDF 转写投影（来源未核验）上的表格 / 公式片段 → PARSE_ARTIFACT_SUSPECTED 降级；
 *  - 覆盖率由单元账本 + 抽取状态 + 核对任务账本确定性计算；正文覆盖与科学论断覆盖分开报告（后者不可测，不画等号）。
 *
 * 本产物是 shadow：生产 Quality Gate 的规则、阈值与 NOT_EVALUATED 语义不读它（M15.4 之前不切换决策）。
 */

import type { FactClaimCheck } from "../agents/ReviewerService.js";
import type { ClaimCheckResult } from "../experiments/claimChecks.js";
import type { FindingAuditRecord, FindingAuditSummary } from "./findingAudit.js";
import {
  indexDependencyTargets,
  resolveUnitDependencies,
  type DependencyIndex,
  type SourceVerification,
} from "./reviewContextSnapshot.js";
import { claimFingerprint } from "./claimGrounding.js";
import {
  compactText,
  compareValues,
  containsTerm,
  descriptorsComparable,
  distinctiveTerms,
  sameQuantityPremise,
  isDerivedValue,
  lineOf,
  locateQuote,
  parseValue,
  sha256Text,
  textContainsNumber,
  type ValueComparison,
} from "./claimAuditText.js";

export const CLAIM_AUDIT_SCHEMA = "paperteam.review-claim-audit/v1";
export const CLAIM_ID_RULE = "claim-id/v1: sha256(file | NFKC-whitespace-stripped quote | occurrence-in-file)[0:16]";
export const CLAIM_AUDIT_VERIFIER = "claim-audit-verifier/v1";
/** 单元审稿 prompt 的论断账本契约版本（进入 prompt → 请求指纹；变更即旧单元记录不可复用） */
export const UNIT_CLAIM_CONTRACT = "unit-claims/v1";

export { CLAIM_AUDIT_MODES, parseClaimAuditMode, resolveClaimAuditMode, type ClaimAuditMode, type ResolvedClaimAuditMode } from "./claimAuditMode.js";
import type { ResolvedClaimAuditMode } from "./claimAuditMode.js";

export type ClaimType =
  | "own_result" | "method" | "dataset" | "literature_attribution" | "comparison" | "statistic" | "conclusion" | "definition" | "UNKNOWN";
export const CLAIM_TYPES: readonly ClaimType[] = ["own_result", "method", "dataset", "literature_attribution", "comparison", "statistic", "conclusion", "definition", "UNKNOWN"];

/** 审稿模型对单条论断自报的核对情况（extended 契约） */
export type ReviewerClaimCheck = "CONSISTENT" | "INCONSISTENT" | "NEEDS_OTHER_SECTION" | "NEEDS_AUTHOR_DATA" | "NEEDS_EXTERNAL_SOURCE" | "NOT_CHECKED";
export const REVIEWER_CLAIM_CHECKS: readonly ReviewerClaimCheck[] = ["CONSISTENT", "INCONSISTENT", "NEEDS_OTHER_SECTION", "NEEDS_AUTHOR_DATA", "NEEDS_EXTERNAL_SOURCE", "NOT_CHECKED"];

export type ClaimVerificationStatus =
  /** 有正式依据的支撑：verified Evidence / 作者实验包复算一致 / 原文内跨处确定性核对一致 */
  | "VERIFIED_SUPPORTED"
  /** 有正式依据的矛盾：复算矛盾 / 原文内跨处确定性核对不一致（来源可核验、上下文完整、无转写风险） */
  | "VERIFIED_CONTRADICTED"
  /** 审稿模型认为有问题，但没有确定性依据（或因上下文 / 来源 / 转写风险被降级） */
  | "REVIEWER_SUSPECTED"
  /** 审稿模型认为一致，但没有确定性依据（不是 VERIFIED_SUPPORTED） */
  | "REVIEWER_CONSISTENT"
  | "AUTHOR_CHECK_REQUIRED"
  | "EXTERNAL_DATA_REQUIRED"
  | "NOT_EVALUATED"
  | "NOT_APPLICABLE";

export type ClaimBasis =
  | "MODEL_JUDGEMENT" | "IN_TEXT_CROSS_CHECK" | "EVIDENCE_STORE" | "CITATION_METADATA" | "DETERMINISTIC_RECOMPUTE" | "AUTHOR_EXPERIMENT_PACKAGE" | "NONE";

export type ClaimDowngrade =
  | "CONTEXT_INCOMPLETE"
  | "PARSE_ARTIFACT_SUSPECTED"
  | "SOURCE_NOT_VERIFIED"
  | "COUNTERPART_NOT_LOCATED"
  | "VALUE_CHECK_DISAGREES"
  | "VALUE_NOT_COMPARABLE"
  | "VALUE_NOT_IN_QUOTE";

/** 来源核验等级 + 依据（文档级） */
export interface ClaimAuditSourceVerification {
  level: SourceVerification;
  basis: "AUTHOR_WORKFLOW" | "DECLARED_INPUT_PROVENANCE" | "INPUT_FIDELITY_REPORT" | "NONE";
  note: string;
}

export interface RawUnitClaim {
  index: number;
  quote?: string;
  claimType?: string;
  linkedRefs?: string[];
  check?: string;
  counterpartQuote?: string;
  claimValue?: string;
  counterpartValue?: string;
  note?: string;
  issueIndex?: number;
}

export interface UnitClaimExtraction {
  /** EXTRACTED = 输出含合法 claims 数组（可为空）；ABSENT = 未给 claims 字段；INVALID = 字段存在但不是数组 */
  status: "EXTRACTED" | "ABSENT" | "INVALID";
  contract: typeof UNIT_CLAIM_CONTRACT;
  claims: RawUnitClaim[];
  errors: string[];
  /** 有界结构化修复调用次数（仅 ABSENT / INVALID 触发，≤ UNIT_CLAIM_REPAIR_MAX） */
  repairAttempts: number;
}

export const UNIT_CLAIM_MAX = 12;
export const UNIT_CLAIM_REPAIR_MAX = 1;

/** 单元输出中 claims 字段的结构解析（逐条容错：非法条目跳过并记错；字段非数组 = INVALID） */
export function parseUnitClaims(parsed: Record<string, unknown>): Omit<UnitClaimExtraction, "repairAttempts"> {
  const raw = parsed["claims"];
  if (raw === undefined || raw === null) return { status: "ABSENT", contract: UNIT_CLAIM_CONTRACT, claims: [], errors: ["claims 字段缺失"] };
  if (!Array.isArray(raw)) return { status: "INVALID", contract: UNIT_CLAIM_CONTRACT, claims: [], errors: ["claims 不是数组"] };
  const claims: RawUnitClaim[] = [];
  const errors: string[] = [];
  const str = (value: unknown, max = 600): string | undefined =>
    typeof value === "string" && value.trim() !== "" ? value.trim().slice(0, max) : typeof value === "number" && Number.isFinite(value) ? String(value) : undefined;
  raw.slice(0, UNIT_CLAIM_MAX * 2).forEach((item, index) => {
    if (typeof item !== "object" || item === null) {
      errors.push(`claims[${index}] 不是对象`);
      return;
    }
    const record = item as Record<string, unknown>;
    const quote = str(record["quote"]);
    if (quote === undefined) {
      errors.push(`claims[${index}] 缺少 quote`);
      return;
    }
    const linked = Array.isArray(record["linkedRefs"])
      ? (record["linkedRefs"] as unknown[]).filter((entry): entry is string => typeof entry === "string" && entry.trim() !== "").map((entry) => entry.trim().slice(0, 120)).slice(0, 8)
      : [];
    claims.push({
      index,
      quote,
      ...(str(record["claimType"], 40) !== undefined ? { claimType: str(record["claimType"], 40)! } : {}),
      linkedRefs: linked,
      ...(str(record["check"], 40) !== undefined ? { check: str(record["check"], 40)! } : {}),
      ...(str(record["counterpartQuote"]) !== undefined ? { counterpartQuote: str(record["counterpartQuote"])! } : {}),
      ...(str(record["claimValue"], 80) !== undefined ? { claimValue: str(record["claimValue"], 80)! } : {}),
      ...(str(record["counterpartValue"], 80) !== undefined ? { counterpartValue: str(record["counterpartValue"], 80)! } : {}),
      ...(str(record["note"], 400) !== undefined ? { note: str(record["note"], 400)! } : {}),
      ...(typeof record["issueIndex"] === "number" && Number.isInteger(record["issueIndex"]) && record["issueIndex"] >= 0 ? { issueIndex: record["issueIndex"] as number } : {}),
    });
  });
  return { status: "EXTRACTED", contract: UNIT_CLAIM_CONTRACT, claims, errors };
}

function normalizeCheck(value: string | undefined): ReviewerClaimCheck | null {
  if (value === undefined) return null;
  const canonical = value.trim().toUpperCase().replace(/[\s-]+/g, "_");
  if ((REVIEWER_CLAIM_CHECKS as readonly string[]).includes(canonical)) return canonical as ReviewerClaimCheck;
  if (canonical === "NEEDS_OTHER_SECTIONS" || canonical === "NEEDS_OTHER_UNIT" || canonical === "NEEDS_CROSS_SECTION") return "NEEDS_OTHER_SECTION";
  if (canonical === "UNCHECKED") return "NOT_CHECKED";
  return null;
}

function normalizeClaimType(value: string | undefined): ClaimType {
  const canonical = (value ?? "").trim().toLowerCase().replace(/[\s-]+/g, "_");
  return (CLAIM_TYPES as readonly string[]).includes(canonical) ? (canonical as ClaimType) : "UNKNOWN";
}

// ---- 账本结构 ----

export interface ClaimLinkedRef {
  mention: string;
  resolution: "IN_UNIT" | "OTHER_UNIT" | "UNRESOLVED" | "AMBIGUOUS" | "NAVIGATIONAL" | "NOT_RESOLVABLE";
  kind?: string;
  targetId?: string;
  targetUnitId?: string;
  targetSha256?: string;
  reason?: string;
}

export interface ClaimLocation {
  unitId: string;
  file: string;
  /** 文件内偏移（end 不含）；单元偏移未知时为 null */
  start: number | null;
  end: number | null;
  line: number | null;
}

export interface ReviewClaimRecord {
  claimId: string;
  idRule: typeof CLAIM_ID_RULE;
  sourceRevision: number | null;
  documentFingerprint: string;
  unitId: string;
  unitContentHash: string;
  file: string;
  spanId: string;
  heading: string;
  location: ClaimLocation;
  /** 原文切片（逐字，来自被审修订；不是模型的复述） */
  quote: string;
  quoteSha256: string;
  quoteOccurrences: number;
  claimType: ClaimType;
  linkedRefs: ClaimLinkedRef[];
  reviewer: {
    origin: "unit_claims" | "digest_fact_claims" | "cross_unit_recheck";
    check: ReviewerClaimCheck | null;
    /** digest fact 路 verdict（旧契约） */
    verdict?: string;
    claimValue?: string;
    counterpartValue?: string;
    counterpartQuote?: string;
    note?: string;
    issueIndex?: number;
    evidenceId?: string;
  };
  counterpart?: { quote: string; located: "IN_UNIT" | "OTHER_UNIT" | "IN_SNIPPET" | "NOT_LOCATED"; location?: ClaimLocation };
  valueCheck?: { claimValue: string; counterpartValue: string; comparison: ValueComparison | "UNPARSEABLE"; claimValueInQuote: boolean; counterpartValueInCounterpart: boolean; descriptorsComparable: boolean; sameQuantityPremise: boolean; derived: boolean };
  verificationStatus: ClaimVerificationStatus;
  basis: ClaimBasis;
  verifier: { kind: "model" | "deterministic" | "model+deterministic"; id: string };
  /** 只有命中正式 verified Evidence 才填写（citation key 不冒充 Evidence） */
  evidenceIds: string[];
  downgrades: ClaimDowngrade[];
  statusReason: string;
  contextCompleteness: "COMPLETE" | "INCOMPLETE" | "UNKNOWN";
  crossUnitTaskIds: string[];
  /** M15.2 预留：严重度 / 阻断 / 影响范围的独立裁决（本轮只记录关联 finding 的旧版观察值） */
  assessment: { severityObserved: string | null; blockingObserved: boolean | null; scope: null; impact: null; decision: "RESERVED_M15_2" };
  reportedBy: string[];
  provenance: { taskId?: string; promptSha256?: string; model?: string; reused: boolean; legacyClaimFingerprint?: string };
}

export interface ClaimRejection {
  unitId: string;
  origin: "unit_claims" | "digest_fact_claims" | "cross_unit_recheck";
  index: number;
  reason: "MISSING_QUOTE" | "QUOTE_TOO_SHORT" | "QUOTE_NOT_IN_UNIT" | "QUOTE_IN_OTHER_UNIT" | "QUOTE_NOT_LOCATED" | "OVER_LIMIT" | "UNKNOWN_CLAIM_ID";
  excerpt: string;
}

export interface CrossUnitSnippet {
  snippetId: string;
  via: "label" | "caption_number" | "latex_counter" | "tag" | "term_overlap_table" | "term_overlap_sentence";
  sourceUnitId: string;
  sourceHeading: string;
  sourceFile: string;
  text: string;
  sha256: string;
  matchedTerms?: string[];
}

export interface CrossUnitTask {
  taskId: string;
  claimId: string;
  kind: "dependency_lookup";
  status: "CANDIDATES_FOUND" | "NO_CANDIDATES" | "REFERENCE_UNRESOLVED";
  snippets: CrossUnitSnippet[];
  gaps: Array<{ mention: string; status: string; reason: string }>;
  verifier: "deterministic";
  /** 有界模型复核（缺省不执行；执行记录见 recheck） */
  recheck?: { status: "COMPLETED" | "FAILED" | "SKIPPED_BUDGET" | "NOT_REQUESTED"; batchId?: string; attempts: number; error?: string; resultCheck?: string };
}

export interface UnitAuditEntry {
  unitId: string;
  file: string;
  spanId: string;
  heading: string;
  contentHash: string;
  chars: number;
  reviewStatus: "completed" | "failed" | "heading_only";
  reused: boolean;
  extraction: {
    status: "EXTRACTED" | "ABSENT" | "INVALID" | "NOT_REQUESTED" | "NOT_APPLICABLE" | "UNIT_FAILED";
    raw: number;
    accepted: number;
    rejected: number;
    repairAttempts: number;
    errors: string[];
  };
}

export interface ClaimAuditCoverage {
  body: { targetChars: number; reviewedChars: number; ratio: number; complete: boolean };
  units: { target: number; completed: number; failed: number; headingOnly: number; extractionRequested: number; extractionCompleted: number; extractionMissing: number };
  claims: {
    total: number;
    byStatus: Record<ClaimVerificationStatus, number>;
    byBasis: Partial<Record<ClaimBasis, number>>;
    verified: number;
    reviewerOnly: number;
    pending: number;
    notEvaluated: number;
    downgraded: number;
    rejected: number;
  };
  documentObjects: { tables: number; figures: number; equations: number; sourceVerification: SourceVerification };
  crossUnitTasks: { total: number; candidatesFound: number; noCandidates: number; referenceUnresolved: number; recheckCompleted: number; recheckFailed: number; recheckSkipped: number };
  /** 全文科学论断总数不可确定性得知：正文覆盖 ≠ 论断覆盖 */
  scientificClaimCoverage: "NOT_MEASURABLE";
  note: string;
}

export interface ClaimAuditArtifact {
  schema: typeof CLAIM_AUDIT_SCHEMA;
  idRule: typeof CLAIM_ID_RULE;
  verifier: typeof CLAIM_AUDIT_VERIFIER;
  generatedAt: string;
  projectId: string;
  round: number;
  sourceRevision: number | null;
  documentFingerprint: string;
  files: Array<{ file: string; sha256: string; chars: number }>;
  evaluationPolicy: {
    reviewPurpose: "author_manuscript" | "published_paper_assessment";
    claimAuditMode: ResolvedClaimAuditMode;
    coverageMode: "digest" | "units";
    unitContextPolicy: string | null;
    promptContract: typeof UNIT_CLAIM_CONTRACT | "digest-fact-claims/v1" | "legacy-unit-no-claims";
    productionGateImpact: "NONE_SHADOW";
  };
  sourceVerification: ClaimAuditSourceVerification;
  models: string[];
  units: UnitAuditEntry[];
  claims: ReviewClaimRecord[];
  rejected: ClaimRejection[];
  crossUnitTasks: CrossUnitTask[];
  coverage: ClaimAuditCoverage;
  limits: { maxClaimsPerUnit: number; maxCrossUnitTasks: number; snippetBudgetChars: number };
  notes: string[];
  /** finding provenance audit（同轮 summary.issues 的确定性诊断；review.run 附加） */
  findingAudit?: { summary: FindingAuditSummary; records: FindingAuditRecord[] };
  /** 有界跨单元复核的调用账本（review.run 附加；未执行 = 缺省） */
  recheck?: { maxCalls: number; batches: Array<{ batchId: string; items: number; status: "COMPLETED" | "FAILED"; attempts: number; taskId?: string; promptSha256?: string; model?: string; usage?: Record<string, unknown>; error?: string }> };
}

// ---- 构建输入 ----

export interface ClaimAuditUnitInput {
  unitId: string;
  file: string;
  spanId: string;
  heading: string;
  contentHash: string;
  chars: number;
  text: string;
  /** 单元在文件中的起始偏移（未知 = null） */
  fileOffset: number | null;
  reviewStatus: "completed" | "failed" | "heading_only";
  reused: boolean;
  /** extended 契约下的抽取结果；undefined = 未请求（shadow / 旧记录） */
  extraction?: UnitClaimExtraction;
  /** 该单元审稿 issues（issueIndex 关联用） */
  issues?: ReadonlyArray<{ severity?: string; blocking?: boolean }>;
  provenance?: { taskId?: string; promptSha256?: string; model?: string };
}

export interface ClaimAuditInput {
  projectId: string;
  round: number;
  sourceRevision: number | null;
  documentFingerprint: string;
  files: ReadonlyArray<{ file: string; content: string }>;
  coverageMode: "digest" | "units";
  claimAuditMode: ResolvedClaimAuditMode;
  reviewPurpose: "author_manuscript" | "published_paper_assessment";
  unitContextPolicy: string | null;
  units: ClaimAuditUnitInput[];
  /** digest 模式 fact 路 claims（旧契约；扩展字段可选） */
  digestClaims?: ReadonlyArray<FactClaimCheck>;
  formalEvidenceIds?: ReadonlySet<string>;
  claimChecks?: ReadonlyArray<ClaimCheckResult>;
  sourceVerification: ClaimAuditSourceVerification;
  /** 输入保真报告记录的转写疑点摘录（命中即 PARSE_ARTIFACT_SUSPECTED） */
  conversionExcerpts?: readonly string[];
  body: { targetChars: number; reviewedChars: number; ratio: number; complete: boolean };
  models?: string[];
  maxCrossUnitTasks?: number;
  snippetBudgetChars?: number;
  now?: () => Date;
}

const DEFAULT_MAX_TASKS = 60;
const DEFAULT_SNIPPET_BUDGET = 6_000;

/** 转写风险区：表格行 / 显示公式 / 替换字形（只在来源未核验时生效） */
export function transcriptionRiskSignals(text: string): string[] {
  const signals: string[] = [];
  if (/(?<!\\)&/.test(text)) signals.push("TABLE_CELLS");
  if (/\\\[|\\\]|\$\$|\\begin\{(?:equation|align|gather|multline|eqnarray)/.test(text)) signals.push("DISPLAY_MATH");
  if (/[\u25A1\uFFFD\uE000-\uF8FF]/.test(text)) signals.push("REPLACEMENT_GLYPH");
  return signals;
}

function sourceVerifiable(level: SourceVerification): boolean {
  return level === "AUTHOR_SOURCE" || level === "SOURCE_ATTESTED";
}

interface Locator {
  units: ClaimAuditUnitInput[];
  fileContent: Map<string, string>;
}

function locateInDocument(locator: Locator, quote: string, preferUnitId?: string): { unit: ClaimAuditUnitInput; start: number; end: number; occurrences: number } | null {
  const ordered = preferUnitId === undefined ? locator.units : [...locator.units.filter((unit) => unit.unitId === preferUnitId), ...locator.units.filter((unit) => unit.unitId !== preferUnitId)];
  for (const unit of ordered) {
    const span = locateQuote(unit.text, quote);
    if (span !== null) return { unit, start: span.start, end: span.end, occurrences: span.occurrences };
  }
  return null;
}

function toLocation(locator: Locator, unit: ClaimAuditUnitInput, start: number, end: number): ClaimLocation {
  if (unit.fileOffset === null) return { unitId: unit.unitId, file: unit.file, start: null, end: null, line: null };
  const content = locator.fileContent.get(unit.file);
  const fileStart = unit.fileOffset + start;
  return { unitId: unit.unitId, file: unit.file, start: fileStart, end: unit.fileOffset + end, line: content === undefined ? null : lineOf(content, fileStart) };
}

/** 文件内出现序号（id 稳定性：同一句在文件中第 k 次出现） */
function occurrenceInFile(locator: Locator, unit: ClaimAuditUnitInput, start: number, compactQuote: string): string {
  const content = locator.fileContent.get(unit.file);
  if (content === undefined || unit.fileOffset === null) return `${unit.unitId}@${start}`;
  const prefix = compactText(content.slice(0, unit.fileOffset + start));
  const whole = compactText(content);
  let count = 0;
  for (let at = whole.indexOf(compactQuote); at >= 0 && at < prefix.length; at = whole.indexOf(compactQuote, at + 1)) count += 1;
  return String(count);
}

export function claimIdOf(file: string, quote: string, occurrence: string): string {
  return `cl1-${sha256Text(`${file}|${compactText(quote)}|${occurrence}`).slice(0, 16)}`;
}

function emptyStatusCounts(): Record<ClaimVerificationStatus, number> {
  return {
    VERIFIED_SUPPORTED: 0, VERIFIED_CONTRADICTED: 0, REVIEWER_SUSPECTED: 0, REVIEWER_CONSISTENT: 0,
    AUTHOR_CHECK_REQUIRED: 0, EXTERNAL_DATA_REQUIRED: 0, NOT_EVALUATED: 0, NOT_APPLICABLE: 0,
  };
}

/** linkedRefs + 论断原文 → 依赖解析（复用生产 reviewContextSnapshot 解析器；唯一候选才算定位） */
function resolveLinkedRefs(index: DependencyIndex, unit: ClaimAuditUnitInput, quote: string, linked: readonly string[]): { refs: ClaimLinkedRef[]; resolution: ReturnType<typeof resolveUnitDependencies> } {
  const probe = [...linked, quote].join("\n");
  const resolution = resolveUnitDependencies({ unitId: unit.unitId, text: probe, index, budgetChars: 1_000_000, attach: true });
  const refs: ClaimLinkedRef[] = [];
  for (const dep of resolution.attached) {
    for (const mention of dep.mentions) refs.push({ mention, resolution: "OTHER_UNIT", kind: dep.kind, targetId: dep.targetId, targetUnitId: dep.sourceUnitId, targetSha256: dep.sha256 });
  }
  for (const mention of resolution.inUnit) refs.push({ mention, resolution: "IN_UNIT" });
  for (const mention of resolution.navigational) refs.push({ mention, resolution: "NAVIGATIONAL" });
  for (const gap of resolution.gaps) refs.push({ mention: gap.mention, resolution: gap.status === "DEPENDENCY_AMBIGUOUS" ? "AMBIGUOUS" : "UNRESOLVED", kind: gap.kind, reason: gap.reason });
  const resolvedMentions = new Set(refs.map((ref) => ref.mention.replace(/\s+/g, " ").toLowerCase()));
  for (const mention of linked) {
    const key = mention.replace(/\s+/g, " ").toLowerCase();
    if ([...resolvedMentions].some((entry) => entry === key || key.includes(entry) || entry.includes(key))) continue;
    refs.push({ mention, resolution: "NOT_RESOLVABLE", reason: "非表 / 图 / 公式 / \\ref 引用（引文 / 章节名等，由引用审计或人工核对）" });
  }
  return { refs, resolution };
}

/** 有界跨单元查找：显式依赖（label / 编号）优先；没有时按区分性术语找其他单元的表格与句子 */
function lookupSnippets(
  index: DependencyIndex,
  locator: Locator,
  unit: ClaimAuditUnitInput,
  quote: string,
  resolution: ReturnType<typeof resolveUnitDependencies>,
  budget: number,
): CrossUnitSnippet[] {
  const snippets: CrossUnitSnippet[] = [];
  let used = 0;
  const push = (snippet: Omit<CrossUnitSnippet, "snippetId" | "sha256">): void => {
    if (used + snippet.text.length > budget) return;
    if (snippets.some((existing) => existing.text === snippet.text)) return;
    used += snippet.text.length;
    snippets.push({ ...snippet, snippetId: `S${snippets.length + 1}`, sha256: sha256Text(snippet.text) });
  };
  for (const dep of resolution.attached) {
    if (dep.kind === "abstract" || dep.kind === "context") continue;
    const via = dep.via === "label" || dep.via === "caption_number" || dep.via === "latex_counter" || dep.via === "tag" ? dep.via : "label";
    push({ via, sourceUnitId: dep.sourceUnitId, sourceHeading: dep.sourceHeading, sourceFile: dep.sourceFile, text: dep.text });
  }
  if (snippets.length > 0) return snippets;
  const terms = distinctiveTerms(quote);
  const numbers = (quote.normalize("NFKC").match(/\d+\.\d+/g) ?? []);
  if (terms.length === 0) return snippets;
  const need = Math.min(2, terms.length);
  // 表格：其他单元中含 ≥need 个术语的表（按命中数降序）
  const tables = index.targets
    .filter((target) => target.kind === "table" && target.unitId !== unit.unitId)
    .map((target) => ({ target, matched: terms.filter((term) => containsTerm(target.text, term)) }))
    .filter((entry) => entry.matched.length >= need)
    .sort((a, b) => b.matched.length - a.matched.length)
    .slice(0, 2);
  for (const entry of tables) {
    push({ via: "term_overlap_table", sourceUnitId: entry.target.unitId, sourceHeading: entry.target.heading, sourceFile: entry.target.file, text: entry.target.text, matchedTerms: entry.matched });
  }
  // 句子：其他单元中含 ≥need 个术语（或共享一个带小数的数值）的句子
  const sentences: Array<{ unit: ClaimAuditUnitInput; text: string; matched: string[] }> = [];
  for (const other of locator.units) {
    if (other.unitId === unit.unitId || other.reviewStatus === "heading_only") continue;
    for (const piece of other.text.split(/(?<=[。！？])|(?<=[.!?])\s+|\n{2,}/)) {
      const sentence = piece.trim();
      if (sentence.length < 20 || sentence.length > 900) continue;
      const matched = terms.filter((term) => containsTerm(sentence, term));
      const sharedNumber = numbers.some((number) => sentence.includes(number));
      if (matched.length >= need || (sharedNumber && matched.length >= 1)) sentences.push({ unit: other, text: sentence, matched });
    }
  }
  sentences.sort((a, b) => b.matched.length - a.matched.length);
  for (const entry of sentences.slice(0, 3)) {
    push({ via: "term_overlap_sentence", sourceUnitId: entry.unit.unitId, sourceHeading: entry.unit.heading, sourceFile: entry.unit.file, text: entry.text, matchedTerms: entry.matched });
  }
  return snippets;
}

interface DecisionInput {
  check: ReviewerClaimCheck | null;
  verdict?: string;
  claimType: ClaimType;
  evidenceVerified: boolean;
  claimCheck?: ClaimCheckResult;
  valueCheck?: ReviewClaimRecord["valueCheck"];
  counterpartLocated: boolean;
  counterpartRisk: string[];
  quoteRisk: string[];
  sourceLevel: SourceVerification;
  contextCompleteness: ReviewClaimRecord["contextCompleteness"];
  conversionHit: boolean;
  origin: ReviewClaimRecord["reviewer"]["origin"];
}

/**
 * 单条论断的确定性状态判定（与汇总无关：同一输入恒得同一状态，聚合层不得改写）。
 */
export function decideClaimStatus(input: DecisionInput): Pick<ReviewClaimRecord, "verificationStatus" | "basis" | "verifier" | "downgrades" | "statusReason"> {
  const downgrades: ClaimDowngrade[] = [];
  const reviewerId = input.origin === "digest_fact_claims" ? "reviewer-fact-digest" : input.origin === "cross_unit_recheck" ? "reviewer-cross-unit-recheck" : "reviewer-unit";
  // 1. 作者实验包复算（作者稿件口径）
  if (input.claimCheck !== undefined && input.claimCheck.verdict !== "NOT_EVALUATED") {
    return {
      verificationStatus: input.claimCheck.verdict === "CONSISTENT" ? "VERIFIED_SUPPORTED" : "VERIFIED_CONTRADICTED",
      basis: "DETERMINISTIC_RECOMPUTE",
      verifier: { kind: "deterministic", id: `claim-checks:${input.claimCheck.id}` },
      downgrades,
      statusReason: `预登记论断复算 ${input.claimCheck.verdict}（作者提供的数据，哈希绑定；未经外部独立核验）`,
    };
  }
  // 2. verified Evidence（digest fact 路 SUPPORTED + evidenceId 解析到正式证据）
  if (input.evidenceVerified && (input.verdict === "SUPPORTED" || input.check === "CONSISTENT")) {
    return { verificationStatus: "VERIFIED_SUPPORTED", basis: "EVIDENCE_STORE", verifier: { kind: "model+deterministic", id: `${reviewerId}+evidence-store` }, downgrades, statusReason: "审稿模型据正式 verified Evidence 判定支撑（evidenceId 已解析为正式证据）" };
  }
  const check = input.check ?? verdictToCheck(input.verdict);
  const risky = !sourceVerifiable(input.sourceLevel) && (input.quoteRisk.length > 0 || input.counterpartRisk.length > 0 || input.conversionHit);
  // 3. 原文内跨处核对（双引文定位 + 写出的数值比较）
  if ((check === "CONSISTENT" || check === "INCONSISTENT") && input.valueCheck !== undefined) {
    const value = input.valueCheck;
    if (!value.claimValueInQuote || !value.counterpartValueInCounterpart) downgrades.push("VALUE_NOT_IN_QUOTE");
    if (!input.counterpartLocated) downgrades.push("COUNTERPART_NOT_LOCATED");
    if (value.comparison === "SCALE_AMBIGUOUS" || value.comparison === "UNPARSEABLE" || value.descriptorsComparable === false || value.sameQuantityPremise === false || value.derived === true) downgrades.push("VALUE_NOT_COMPARABLE");
    const agrees = (check === "CONSISTENT" && value.comparison === "EQUAL") || (check === "INCONSISTENT" && value.comparison === "DIFFERENT");
    if ((check === "CONSISTENT" && value.comparison === "DIFFERENT") || (check === "INCONSISTENT" && value.comparison === "EQUAL")) downgrades.push("VALUE_CHECK_DISAGREES");
    if (input.contextCompleteness === "INCOMPLETE") downgrades.push("CONTEXT_INCOMPLETE");
    if (risky) downgrades.push("PARSE_ARTIFACT_SUSPECTED");
    else if (!sourceVerifiable(input.sourceLevel)) downgrades.push("SOURCE_NOT_VERIFIED");
    if (agrees && downgrades.length === 0) {
      return {
        verificationStatus: check === "CONSISTENT" ? "VERIFIED_SUPPORTED" : "VERIFIED_CONTRADICTED",
        basis: "IN_TEXT_CROSS_CHECK",
        verifier: { kind: "model+deterministic", id: `${reviewerId}+${CLAIM_AUDIT_VERIFIER}:value-check` },
        downgrades,
        statusReason: `原文内跨处核对：论断值「${value.claimValue}」与对照处「${value.counterpartValue}」${check === "CONSISTENT" ? "一致" : "不一致"}（两处引文均在被审修订中逐字定位；对应关系由审稿模型提出，数值比较为确定性）`,
      };
    }
    return {
      verificationStatus: check === "CONSISTENT" ? "REVIEWER_CONSISTENT" : "REVIEWER_SUSPECTED",
      basis: "MODEL_JUDGEMENT",
      verifier: { kind: "model", id: reviewerId },
      downgrades: [...new Set(downgrades)],
      statusReason: `审稿模型判定${check === "CONSISTENT" ? "一致" : "不一致"}；确定性核对未能确认（${[...new Set(downgrades)].join(" / ")}）`,
    };
  }
  if (risky && (check === "CONSISTENT" || check === "INCONSISTENT")) downgrades.push("PARSE_ARTIFACT_SUSPECTED");
  if (input.contextCompleteness === "INCOMPLETE" && check !== "NEEDS_OTHER_SECTION") downgrades.push("CONTEXT_INCOMPLETE");
  switch (check) {
    case "CONSISTENT":
      return { verificationStatus: "REVIEWER_CONSISTENT", basis: "MODEL_JUDGEMENT", verifier: { kind: "model", id: reviewerId }, downgrades, statusReason: "审稿模型判定一致，无可确定性复核的数值 / 证据" };
    case "INCONSISTENT":
      return { verificationStatus: "REVIEWER_SUSPECTED", basis: "MODEL_JUDGEMENT", verifier: { kind: "model", id: reviewerId }, downgrades, statusReason: "审稿模型判定不一致，无可确定性复核的数值 / 证据（未证实）" };
    case "NEEDS_OTHER_SECTION":
      return { verificationStatus: "NOT_EVALUATED", basis: "NONE", verifier: { kind: "deterministic", id: CLAIM_AUDIT_VERIFIER }, downgrades: [...downgrades, "CONTEXT_INCOMPLETE"], statusReason: "核对需要本单元之外的章节 / 表格：单元视角未核对（跨单元查找见任务账本）" };
    case "NEEDS_AUTHOR_DATA":
      return { verificationStatus: "AUTHOR_CHECK_REQUIRED", basis: "MODEL_JUDGEMENT", verifier: { kind: "model", id: reviewerId }, downgrades, statusReason: input.verdict === "UNSUPPORTED" || input.verdict === "PARTIALLY_SUPPORTED" ? `fact 路 ${input.verdict}：未找到已核验证据（不等于已证伪），需作者补充依据` : "需作者数据 / 说明才能核对" };
    case "NEEDS_EXTERNAL_SOURCE":
      return { verificationStatus: "EXTERNAL_DATA_REQUIRED", basis: "MODEL_JUDGEMENT", verifier: { kind: "model", id: reviewerId }, downgrades, statusReason: "需外部原始数据 / 文献原文才能核对" };
    default:
      return { verificationStatus: "NOT_EVALUATED", basis: "NONE", verifier: { kind: "deterministic", id: CLAIM_AUDIT_VERIFIER }, downgrades, statusReason: "审稿模型未核对该论断" };
  }
}

/** digest fact 路旧 verdict → 核对口径（UNSUPPORTED = 没有已核验证据，不是已证伪） */
function verdictToCheck(verdict: string | undefined): ReviewerClaimCheck | null {
  switch (verdict) {
    case "SUPPORTED": return "CONSISTENT";
    case "CONTRADICTED": return "INCONSISTENT";
    case "UNSUPPORTED":
    case "PARTIALLY_SUPPORTED": return "NEEDS_AUTHOR_DATA";
    default: return null;
  }
}

function buildValueCheck(claimValue: string | undefined, counterpartValue: string | undefined, quote: string, counterpartText: string | null): ReviewClaimRecord["valueCheck"] | undefined {
  if (claimValue === undefined || counterpartValue === undefined) return undefined;
  const a = parseValue(claimValue);
  const b = parseValue(counterpartValue);
  if (a === null || b === null) {
    return { claimValue, counterpartValue, comparison: "UNPARSEABLE", claimValueInQuote: false, counterpartValueInCounterpart: false, descriptorsComparable: false, sameQuantityPremise: false, derived: isDerivedValue(claimValue) || isDerivedValue(counterpartValue) };
  }
  return {
    claimValue,
    counterpartValue,
    comparison: compareValues(a, b),
    claimValueInQuote: textContainsNumber(quote, a),
    counterpartValueInCounterpart: counterpartText !== null && textContainsNumber(counterpartText, b),
    descriptorsComparable: descriptorsComparable(claimValue, counterpartValue),
    sameQuantityPremise: counterpartText === null || sameQuantityPremise(quote, counterpartText),
    derived: isDerivedValue(claimValue) || isDerivedValue(counterpartValue),
  };
}

/**
 * 构建 Review Claim Ledger（纯函数；同一输入 → 同一账本，除 generatedAt）。
 * 单元模式：只接受 extended 契约下各单元自报的 claims（必须逐字定位在本单元原文）；shadow 模式下抽取状态 = NOT_REQUESTED。
 * digest 模式：fact 路 claims（旧契约）——模型 claim 文本能逐字定位才入账，否则 QUOTE_NOT_LOCATED（不丢弃 verdict 信息，记入 rejected）。
 */
export function buildClaimAudit(input: ClaimAuditInput): ClaimAuditArtifact {
  const maxTasks = input.maxCrossUnitTasks ?? DEFAULT_MAX_TASKS;
  const snippetBudget = input.snippetBudgetChars ?? DEFAULT_SNIPPET_BUDGET;
  const locator: Locator = { units: input.units, fileContent: new Map(input.files.map((file) => [file.file, file.content])) };
  const index = indexDependencyTargets(
    input.units.map((unit) => ({ unitId: unit.unitId, file: unit.file, heading: unit.heading, text: unit.text })),
    { documentOrderProven: input.files.length === 1 },
  );
  const claims = new Map<string, ReviewClaimRecord>();
  const rejected: ClaimRejection[] = [];
  const tasks: CrossUnitTask[] = [];
  const unitEntries: UnitAuditEntry[] = [];
  const conversion = (input.conversionExcerpts ?? []).map((excerpt) => compactText(excerpt)).filter((excerpt) => excerpt.length >= 8);
  const conversionHit = (text: string): boolean => {
    const own = compactText(text);
    return own.length >= 8 && conversion.some((excerpt) => own.includes(excerpt.slice(0, 16)) || excerpt.includes(own.slice(0, 16)));
  };

  const addClaim = (
    unit: ClaimAuditUnitInput,
    raw: { quote: string; claimType?: string; linkedRefs?: string[]; check?: string; counterpartQuote?: string; claimValue?: string; counterpartValue?: string; note?: string; issueIndex?: number; verdict?: string; evidenceId?: string },
    origin: ReviewClaimRecord["reviewer"]["origin"],
    rawIndex: number,
    legacyFingerprint?: string,
  ): "accepted" | "rejected" => {
    const span = locateQuote(unit.text, raw.quote, 12);
    if (span === null) {
      const elsewhere = compactText(raw.quote).length < 12 ? null : locateInDocument(locator, raw.quote);
      rejected.push({
        unitId: unit.unitId, origin, index: rawIndex,
        reason: compactText(raw.quote).length < 12 ? "QUOTE_TOO_SHORT" : elsewhere !== null ? "QUOTE_IN_OTHER_UNIT" : "QUOTE_NOT_IN_UNIT",
        excerpt: raw.quote.slice(0, 160),
      });
      return "rejected";
    }
    const quote = unit.text.slice(span.start, span.end);
    const compactQuote = compactText(quote);
    const claimId = claimIdOf(unit.file, quote, occurrenceInFile(locator, unit, span.start, compactQuote));
    const existing = claims.get(claimId);
    if (existing !== undefined) {
      if (!existing.reportedBy.includes(unit.unitId)) existing.reportedBy.push(unit.unitId);
      return "accepted";
    }
    const linked = resolveLinkedRefs(index, unit, quote, raw.linkedRefs ?? []);
    const check = normalizeCheck(raw.check);
    // 对照引文：本单元 → 其他单元（被审修订中逐字定位；定位不到不作为依据）
    let counterpart: ReviewClaimRecord["counterpart"];
    let counterpartText: string | null = null;
    if (raw.counterpartQuote !== undefined) {
      const inUnit = locateQuote(unit.text, raw.counterpartQuote);
      if (inUnit !== null) {
        counterpartText = unit.text.slice(inUnit.start, inUnit.end);
        counterpart = { quote: counterpartText, located: "IN_UNIT", location: toLocation(locator, unit, inUnit.start, inUnit.end) };
      } else {
        const other = locateInDocument(locator, raw.counterpartQuote);
        if (other !== null) {
          counterpartText = other.unit.text.slice(other.start, other.end);
          counterpart = { quote: counterpartText, located: "OTHER_UNIT", location: toLocation(locator, other.unit, other.start, other.end) };
        } else {
          counterpart = { quote: raw.counterpartQuote.slice(0, 400), located: "NOT_LOCATED" };
        }
      }
    }
    const gaps = linked.refs.filter((ref) => ref.resolution === "UNRESOLVED" || ref.resolution === "AMBIGUOUS");
    const contextCompleteness: ReviewClaimRecord["contextCompleteness"] =
      gaps.length > 0 || check === "NEEDS_OTHER_SECTION"
        ? "INCOMPLETE"
        : (check === "CONSISTENT" || check === "INCONSISTENT") && (counterpart === undefined || counterpart.located !== "NOT_LOCATED")
          ? "COMPLETE"
          : "UNKNOWN";
    const valueCheck = buildValueCheck(raw.claimValue, raw.counterpartValue, quote, counterpartText);
    const claimCheck = (input.claimChecks ?? []).find((result) => {
      const anchor = compactText(result.claimAnchor.quote);
      return anchor.length >= 8 && (anchor.includes(compactQuote) || compactQuote.includes(anchor));
    });
    const decision = decideClaimStatus({
      check,
      ...(raw.verdict !== undefined ? { verdict: raw.verdict } : {}),
      claimType: normalizeClaimType(raw.claimType),
      evidenceVerified: raw.evidenceId !== undefined && (input.formalEvidenceIds?.has(raw.evidenceId) ?? false),
      ...(claimCheck !== undefined ? { claimCheck } : {}),
      ...(valueCheck !== undefined ? { valueCheck } : {}),
      counterpartLocated: counterpart !== undefined && counterpart.located !== "NOT_LOCATED",
      counterpartRisk: counterpartText === null ? [] : transcriptionRiskSignals(counterpartText),
      quoteRisk: transcriptionRiskSignals(quote),
      sourceLevel: input.sourceVerification.level,
      contextCompleteness,
      conversionHit: conversionHit(quote) || (counterpartText !== null && conversionHit(counterpartText)),
      origin,
    });
    const linkedIssue = raw.issueIndex !== undefined ? unit.issues?.[raw.issueIndex] : undefined;
    const record: ReviewClaimRecord = {
      claimId,
      idRule: CLAIM_ID_RULE,
      sourceRevision: input.sourceRevision,
      documentFingerprint: input.documentFingerprint,
      unitId: unit.unitId,
      unitContentHash: unit.contentHash,
      file: unit.file,
      spanId: unit.spanId,
      heading: unit.heading,
      location: toLocation(locator, unit, span.start, span.end),
      quote,
      quoteSha256: sha256Text(quote),
      quoteOccurrences: span.occurrences,
      claimType: normalizeClaimType(raw.claimType),
      linkedRefs: linked.refs,
      reviewer: {
        origin,
        check,
        ...(raw.verdict !== undefined ? { verdict: raw.verdict } : {}),
        ...(raw.claimValue !== undefined ? { claimValue: raw.claimValue } : {}),
        ...(raw.counterpartValue !== undefined ? { counterpartValue: raw.counterpartValue } : {}),
        ...(raw.counterpartQuote !== undefined ? { counterpartQuote: raw.counterpartQuote.slice(0, 400) } : {}),
        ...(raw.note !== undefined ? { note: raw.note } : {}),
        ...(raw.issueIndex !== undefined ? { issueIndex: raw.issueIndex } : {}),
        ...(raw.evidenceId !== undefined ? { evidenceId: raw.evidenceId } : {}),
      },
      ...(counterpart !== undefined ? { counterpart } : {}),
      ...(valueCheck !== undefined ? { valueCheck } : {}),
      ...decision,
      evidenceIds: decision.basis === "EVIDENCE_STORE" && raw.evidenceId !== undefined ? [raw.evidenceId] : [],
      contextCompleteness,
      crossUnitTaskIds: [],
      assessment: {
        severityObserved: typeof linkedIssue?.severity === "string" ? linkedIssue.severity : null,
        blockingObserved: typeof linkedIssue?.blocking === "boolean" ? linkedIssue.blocking : null,
        scope: null, impact: null, decision: "RESERVED_M15_2",
      },
      reportedBy: [unit.unitId],
      provenance: {
        ...(unit.provenance?.taskId !== undefined ? { taskId: unit.provenance.taskId } : {}),
        ...(unit.provenance?.promptSha256 !== undefined ? { promptSha256: unit.provenance.promptSha256 } : {}),
        ...(unit.provenance?.model !== undefined ? { model: unit.provenance.model } : {}),
        reused: unit.reused,
        ...(legacyFingerprint !== undefined ? { legacyClaimFingerprint: legacyFingerprint } : {}),
      },
    };
    // 跨单元查找任务：依赖其他章节 / 表 / 图 / 公式而本单元未核对（或依赖缺口）
    const needsLookup = record.verificationStatus === "NOT_EVALUATED" && (check === "NEEDS_OTHER_SECTION" || gaps.length > 0 || linked.refs.some((ref) => ref.resolution === "OTHER_UNIT"));
    if (needsLookup && tasks.length < maxTasks) {
      const snippets = lookupSnippets(index, locator, unit, quote, linked.resolution, snippetBudget);
      const task: CrossUnitTask = {
        taskId: `T${String(tasks.length + 1).padStart(3, "0")}-${claimId.slice(4, 12)}`,
        claimId,
        kind: "dependency_lookup",
        status: snippets.length > 0 ? "CANDIDATES_FOUND" : gaps.length > 0 ? "REFERENCE_UNRESOLVED" : "NO_CANDIDATES",
        snippets,
        gaps: gaps.map((gap) => ({ mention: gap.mention, status: gap.resolution, reason: gap.reason ?? "" })),
        verifier: "deterministic",
        recheck: { status: "NOT_REQUESTED", attempts: 0 },
      };
      tasks.push(task);
      record.crossUnitTaskIds.push(task.taskId);
    }
    claims.set(claimId, record);
    return "accepted";
  };

  for (const unit of input.units) {
    const entry: UnitAuditEntry = {
      unitId: unit.unitId, file: unit.file, spanId: unit.spanId, heading: unit.heading, contentHash: unit.contentHash, chars: unit.chars,
      reviewStatus: unit.reviewStatus, reused: unit.reused,
      extraction: { status: "NOT_REQUESTED", raw: 0, accepted: 0, rejected: 0, repairAttempts: 0, errors: [] },
    };
    if (unit.reviewStatus === "heading_only") entry.extraction.status = "NOT_APPLICABLE";
    else if (unit.reviewStatus === "failed") entry.extraction.status = "UNIT_FAILED";
    else if (input.coverageMode === "digest") entry.extraction.status = input.digestClaims !== undefined ? "EXTRACTED" : "ABSENT";
    else if (input.coverageMode === "units" && unit.extraction !== undefined) {
      entry.extraction.status = unit.extraction.status;
      entry.extraction.raw = unit.extraction.claims.length;
      entry.extraction.repairAttempts = unit.extraction.repairAttempts;
      entry.extraction.errors = unit.extraction.errors.slice(0, 8);
      unit.extraction.claims.forEach((claim, position) => {
        if (position >= UNIT_CLAIM_MAX) {
          rejected.push({ unitId: unit.unitId, origin: "unit_claims", index: claim.index, reason: "OVER_LIMIT", excerpt: (claim.quote ?? "").slice(0, 160) });
          entry.extraction.rejected += 1;
          return;
        }
        if (claim.quote === undefined) {
          rejected.push({ unitId: unit.unitId, origin: "unit_claims", index: claim.index, reason: "MISSING_QUOTE", excerpt: "" });
          entry.extraction.rejected += 1;
          return;
        }
        const outcome = addClaim(unit, { ...claim, quote: claim.quote }, "unit_claims", claim.index);
        entry.extraction[outcome] += 1;
      });
    }
    unitEntries.push(entry);
  }

  if (input.coverageMode === "digest") {
    (input.digestClaims ?? []).forEach((claim, position) => {
      const extended = claim as FactClaimCheck & Partial<RawUnitClaim>;
      const quote = extended.quote ?? claim.claim;
      const located = locateInDocument(locator, quote);
      if (located === null) {
        rejected.push({ unitId: "(digest)", origin: "digest_fact_claims", index: position, reason: "QUOTE_NOT_LOCATED", excerpt: quote.slice(0, 160) });
        return;
      }
      const unitEntry = unitEntries.find((entry) => entry.unitId === located.unit.unitId);
      const outcome = addClaim(located.unit, {
        quote,
        ...(extended.claimType !== undefined ? { claimType: extended.claimType } : {}),
        ...(extended.linkedRefs !== undefined ? { linkedRefs: extended.linkedRefs } : {}),
        ...(extended.check !== undefined ? { check: extended.check } : {}),
        ...(extended.counterpartQuote !== undefined ? { counterpartQuote: extended.counterpartQuote } : {}),
        ...(extended.claimValue !== undefined ? { claimValue: extended.claimValue } : {}),
        ...(extended.counterpartValue !== undefined ? { counterpartValue: extended.counterpartValue } : {}),
        ...(claim.note !== undefined ? { note: claim.note } : {}),
        verdict: claim.verdict,
        ...(claim.evidenceId !== undefined ? { evidenceId: claim.evidenceId } : {}),
      }, "digest_fact_claims", position, claimFingerprint(claim.section, claim.claim));
      if (unitEntry !== undefined) {
        unitEntry.extraction.raw += 1;
        unitEntry.extraction[outcome] += 1;
      }
    });
  }

  const artifact: ClaimAuditArtifact = {
    schema: CLAIM_AUDIT_SCHEMA,
    idRule: CLAIM_ID_RULE,
    verifier: CLAIM_AUDIT_VERIFIER,
    generatedAt: (input.now ?? (() => new Date()))().toISOString(),
    projectId: input.projectId,
    round: input.round,
    sourceRevision: input.sourceRevision,
    documentFingerprint: input.documentFingerprint,
    files: input.files.map((file) => ({ file: file.file, sha256: sha256Text(file.content), chars: file.content.length })),
    evaluationPolicy: {
      reviewPurpose: input.reviewPurpose,
      claimAuditMode: input.claimAuditMode,
      coverageMode: input.coverageMode,
      unitContextPolicy: input.unitContextPolicy,
      promptContract: input.coverageMode === "digest" ? "digest-fact-claims/v1" : input.claimAuditMode === "extended" ? UNIT_CLAIM_CONTRACT : "legacy-unit-no-claims",
      productionGateImpact: "NONE_SHADOW",
    },
    sourceVerification: input.sourceVerification,
    models: [...new Set(input.models ?? [])],
    units: unitEntries,
    claims: [...claims.values()],
    rejected,
    crossUnitTasks: tasks,
    coverage: {} as ClaimAuditCoverage,
    limits: { maxClaimsPerUnit: UNIT_CLAIM_MAX, maxCrossUnitTasks: maxTasks, snippetBudgetChars: snippetBudget },
    notes: [],
  };
  artifact.coverage = computeClaimAuditCoverage(artifact, input.body, index);
  if (input.coverageMode === "units" && input.claimAuditMode !== "extended") {
    artifact.notes.push("shadow 模式：单元审稿 prompt 未请求论断账本（与生产 prompt 逐字节一致），单元模式没有可入账的论断——claim 级核验 NOT_EVALUATED，不是「论断都有支撑」");
  }
  if (!sourceVerifiable(input.sourceVerification.level)) {
    artifact.notes.push(`来源核验 ${input.sourceVerification.level}：原文内跨处核对最高只给 REVIEWER_*（转写稿上的数值 / 表格 / 公式不足以确立已核实错误）`);
  }
  return artifact;
}

export function computeClaimAuditCoverage(
  artifact: Pick<ClaimAuditArtifact, "units" | "claims" | "rejected" | "crossUnitTasks" | "sourceVerification">,
  body: ClaimAuditCoverage["body"],
  index?: DependencyIndex,
): ClaimAuditCoverage {
  const byStatus = emptyStatusCounts();
  const byBasis: Partial<Record<ClaimBasis, number>> = {};
  for (const claim of artifact.claims) {
    byStatus[claim.verificationStatus] += 1;
    byBasis[claim.basis] = (byBasis[claim.basis] ?? 0) + 1;
  }
  const requested = artifact.units.filter((unit) => unit.extraction.status !== "NOT_REQUESTED" && unit.extraction.status !== "NOT_APPLICABLE" && unit.extraction.status !== "UNIT_FAILED");
  const objects = { tables: 0, figures: 0, equations: 0 };
  for (const target of index?.targets ?? []) {
    if (target.kind === "table") objects.tables += 1;
    else if (target.kind === "figure") objects.figures += 1;
    else objects.equations += 1;
  }
  const tasks = artifact.crossUnitTasks;
  return {
    body,
    units: {
      target: artifact.units.length,
      completed: artifact.units.filter((unit) => unit.reviewStatus === "completed").length,
      failed: artifact.units.filter((unit) => unit.reviewStatus === "failed").length,
      headingOnly: artifact.units.filter((unit) => unit.reviewStatus === "heading_only").length,
      extractionRequested: requested.length,
      extractionCompleted: requested.filter((unit) => unit.extraction.status === "EXTRACTED").length,
      extractionMissing: requested.filter((unit) => unit.extraction.status !== "EXTRACTED").length,
    },
    claims: {
      total: artifact.claims.length,
      byStatus,
      byBasis,
      verified: byStatus.VERIFIED_SUPPORTED + byStatus.VERIFIED_CONTRADICTED,
      reviewerOnly: byStatus.REVIEWER_CONSISTENT + byStatus.REVIEWER_SUSPECTED,
      pending: byStatus.AUTHOR_CHECK_REQUIRED + byStatus.EXTERNAL_DATA_REQUIRED,
      notEvaluated: byStatus.NOT_EVALUATED,
      downgraded: artifact.claims.filter((claim) => claim.downgrades.length > 0).length,
      rejected: artifact.rejected.length,
    },
    documentObjects: { ...objects, sourceVerification: artifact.sourceVerification.level },
    crossUnitTasks: {
      total: tasks.length,
      candidatesFound: tasks.filter((task) => task.status === "CANDIDATES_FOUND").length,
      noCandidates: tasks.filter((task) => task.status === "NO_CANDIDATES").length,
      referenceUnresolved: tasks.filter((task) => task.status === "REFERENCE_UNRESOLVED").length,
      recheckCompleted: tasks.filter((task) => task.recheck?.status === "COMPLETED").length,
      recheckFailed: tasks.filter((task) => task.recheck?.status === "FAILED").length,
      recheckSkipped: tasks.filter((task) => task.recheck?.status === "SKIPPED_BUDGET").length,
    },
    scientificClaimCoverage: "NOT_MEASURABLE",
    note: "正文覆盖 = 完成审查的单元字符 / 目标字符；论断账本只含审稿模型列出且逐字定位成功的论断——全文科学论断总数不可确定性得知，二者不能画等号；账本为空不代表论断都已核验",
  };
}

// ---- 有界跨单元复核（模型；可选） ----

export interface CrossUnitRecheckItem {
  claimId: string;
  taskId: string;
  heading: string;
  quote: string;
  snippets: CrossUnitSnippet[];
}

export interface CrossUnitRecheckResult {
  claimId: string;
  check: "CONSISTENT" | "INCONSISTENT" | "NOT_DETERMINABLE";
  counterpartQuote?: string;
  claimValue?: string;
  counterpartValue?: string;
  note?: string;
}

export const CROSS_UNIT_RECHECK_CONTRACT = "cross-unit-recheck/v1";

/** 待复核条目（确定性排序：任务顺序；只取有候选片段的任务；上限 maxItems） */
export function selectRecheckItems(artifact: ClaimAuditArtifact, maxItems: number): CrossUnitRecheckItem[] {
  const out: CrossUnitRecheckItem[] = [];
  for (const task of artifact.crossUnitTasks) {
    if (task.status !== "CANDIDATES_FOUND") continue;
    const claim = artifact.claims.find((entry) => entry.claimId === task.claimId);
    if (claim === undefined || claim.verificationStatus !== "NOT_EVALUATED") continue;
    if (out.length >= maxItems) {
      task.recheck = { status: "SKIPPED_BUDGET", attempts: 0 };
      continue;
    }
    out.push({ claimId: claim.claimId, taskId: task.taskId, heading: claim.heading, quote: claim.quote, snippets: task.snippets });
  }
  return out;
}

export function renderCrossUnitRecheckPrompt(items: readonly CrossUnitRecheckItem[]): string {
  return [
    "你是学术审稿复核员。下面每条论断来自论文的某一章节，核对它需要其他章节的材料；系统已按确定性规则（\\ref 标签 / 表图编号 / 共有术语）从同一篇论文中取出候选原文片段。",
    "请只依据给出的片段逐条核对：",
    "- check：CONSISTENT（片段中有直接依据且一致）| INCONSISTENT（片段中有直接依据且不一致）| NOT_DETERMINABLE（片段不足以判断；这是正常结果，不要猜）；",
    "- counterpartQuote：从候选片段中逐字摘出的依据（≥8 字，不改写；NOT_DETERMINABLE 时省略）；",
    "- claimValue / counterpartValue：若是数值核对，分别照原文写论断中的数值与片段中的对应数值（含单位）；派生量（倍数、相对提升）只写原文数值，不要自行换算后填写；",
    "- note：一句话说明。不要报告与这条论断无关的问题，也不要因为片段里没有就断言论文没有。",
    "只输出一个 JSON 对象（不要 Markdown 围栏）：{\"results\":[{\"claimId\":\"...\",\"check\":\"CONSISTENT|INCONSISTENT|NOT_DETERMINABLE\",\"counterpartQuote\":\"...\",\"claimValue\":\"...\",\"counterpartValue\":\"...\",\"note\":\"...\"}]}",
    "",
    ...items.flatMap((item, position) => [
      `===== 论断 ${position + 1}（claimId=${item.claimId}；章节「${item.heading}」）=====`,
      item.quote,
      ...item.snippets.flatMap((snippet) => [
        `--- 候选片段 [${snippet.snippetId}] 来源章节「${snippet.sourceHeading}」（${snippet.sourceFile}；定位：${snippet.via}${snippet.matchedTerms !== undefined && snippet.matchedTerms.length > 0 ? ` ${snippet.matchedTerms.join("、")}` : ""}；sha256:${snippet.sha256.slice(0, 12)}）---`,
        snippet.text,
      ]),
      "",
    ]),
  ].join("\n");
}

export function parseCrossUnitRecheckOutput(parsed: Record<string, unknown>, allowed: ReadonlySet<string>): CrossUnitRecheckResult[] {
  const raw = parsed["results"];
  if (!Array.isArray(raw)) return [];
  const out: CrossUnitRecheckResult[] = [];
  for (const item of raw) {
    if (typeof item !== "object" || item === null) continue;
    const record = item as Record<string, unknown>;
    const claimId = typeof record["claimId"] === "string" ? record["claimId"].trim() : "";
    if (!allowed.has(claimId) || out.some((entry) => entry.claimId === claimId)) continue;
    const check = typeof record["check"] === "string" ? record["check"].trim().toUpperCase().replace(/[\s-]+/g, "_") : "";
    if (check !== "CONSISTENT" && check !== "INCONSISTENT" && check !== "NOT_DETERMINABLE") continue;
    const str = (key: string, max: number): string | undefined =>
      typeof record[key] === "string" && (record[key] as string).trim() !== "" ? (record[key] as string).trim().slice(0, max) : typeof record[key] === "number" ? String(record[key]) : undefined;
    out.push({
      claimId,
      check,
      ...(str("counterpartQuote", 600) !== undefined ? { counterpartQuote: str("counterpartQuote", 600)! } : {}),
      ...(str("claimValue", 80) !== undefined ? { claimValue: str("claimValue", 80)! } : {}),
      ...(str("counterpartValue", 80) !== undefined ? { counterpartValue: str("counterpartValue", 80)! } : {}),
      ...(str("note", 400) !== undefined ? { note: str("note", 400)! } : {}),
    });
  }
  return out;
}

/**
 * 复核结果并入账本（确定性）：counterpartQuote 必须逐字落在本任务的候选片段中（片段本身切自被审修订）才作为依据；
 * 之后与单元论断同一判定函数（decideClaimStatus）——复核的模型判断同样不能自封 VERIFIED。
 */
export function applyCrossUnitRecheck(
  artifact: ClaimAuditArtifact,
  batches: ReadonlyArray<{ batchId: string; items: readonly CrossUnitRecheckItem[]; status: "COMPLETED" | "FAILED"; attempts: number; error?: string; results: readonly CrossUnitRecheckResult[] }>,
  options: { conversionExcerpts?: readonly string[] } = {},
): ClaimAuditArtifact {
  const conversion = (options.conversionExcerpts ?? []).map((excerpt) => compactText(excerpt)).filter((excerpt) => excerpt.length >= 8);
  for (const batch of batches) {
    for (const item of batch.items) {
      const task = artifact.crossUnitTasks.find((entry) => entry.taskId === item.taskId);
      const claim = artifact.claims.find((entry) => entry.claimId === item.claimId);
      if (task === undefined || claim === undefined) continue;
      const result = batch.results.find((entry) => entry.claimId === item.claimId);
      task.recheck = {
        status: batch.status,
        batchId: batch.batchId,
        attempts: batch.attempts,
        ...(batch.error !== undefined ? { error: batch.error.slice(0, 300) } : {}),
        ...(result !== undefined ? { resultCheck: result.check } : {}),
      };
      if (batch.status !== "COMPLETED" || result === undefined || result.check === "NOT_DETERMINABLE") continue;
      let counterpartText: string | null = null;
      let located: NonNullable<ReviewClaimRecord["counterpart"]>["located"] = "NOT_LOCATED";
      if (result.counterpartQuote !== undefined) {
        for (const snippet of item.snippets) {
          const span = locateQuote(snippet.text, result.counterpartQuote);
          if (span !== null) {
            counterpartText = snippet.text.slice(span.start, span.end);
            located = "IN_SNIPPET";
            break;
          }
        }
      }
      const check: ReviewerClaimCheck = result.check;
      const valueCheck = buildValueCheck(result.claimValue, result.counterpartValue, claim.quote, counterpartText);
      const hit = (text: string): boolean => {
        const own = compactText(text);
        return own.length >= 8 && conversion.some((excerpt) => own.includes(excerpt.slice(0, 16)) || excerpt.includes(own.slice(0, 16)));
      };
      const decision = decideClaimStatus({
        check,
        claimType: claim.claimType,
        evidenceVerified: false,
        ...(valueCheck !== undefined ? { valueCheck } : {}),
        counterpartLocated: counterpartText !== null,
        counterpartRisk: counterpartText === null ? [] : transcriptionRiskSignals(counterpartText),
        quoteRisk: transcriptionRiskSignals(claim.quote),
        sourceLevel: artifact.sourceVerification.level,
        contextCompleteness: counterpartText !== null ? "COMPLETE" : "INCOMPLETE",
        conversionHit: hit(claim.quote) || (counterpartText !== null && hit(counterpartText)),
        origin: "cross_unit_recheck",
      });
      claim.reviewer = {
        ...claim.reviewer,
        origin: "cross_unit_recheck",
        check,
        ...(result.claimValue !== undefined ? { claimValue: result.claimValue } : {}),
        ...(result.counterpartValue !== undefined ? { counterpartValue: result.counterpartValue } : {}),
        ...(result.counterpartQuote !== undefined ? { counterpartQuote: result.counterpartQuote.slice(0, 400) } : {}),
        ...(result.note !== undefined ? { note: result.note } : {}),
      };
      if (result.counterpartQuote !== undefined) claim.counterpart = { quote: counterpartText ?? result.counterpartQuote.slice(0, 400), located };
      if (valueCheck !== undefined) claim.valueCheck = valueCheck;
      claim.contextCompleteness = counterpartText !== null ? "COMPLETE" : "INCOMPLETE";
      Object.assign(claim, decision);
    }
  }
  const objects = artifact.coverage.documentObjects;
  artifact.coverage = computeClaimAuditCoverage(artifact, artifact.coverage.body);
  artifact.coverage.documentObjects = objects;
  return artifact;
}

// ---- 读取校验（防旧数据复用） ----

export interface ClaimAuditValidation {
  status: "VALID" | "STALE" | "MALFORMED";
  reasons: string[];
  /** 原文切片不再逐字成立的论断（被审修订 / 单元内容已变化） */
  invalidClaimIds: string[];
}

/**
 * 读取方校验：账本必须与被审修订 + 覆盖快照一致，且每条论断的原文切片仍在记录的位置逐字成立。
 * 失败 = STALE（整份按 NOT_EVALUATED 处理，不得沿用旧原文上的结论）；单条位置失效 → invalidClaimIds。
 */
export function validateClaimAudit(
  artifact: unknown,
  expected: { sourceRevision: number | null; documentFingerprint: string; files: ReadonlyArray<{ file: string; content: string }> },
): ClaimAuditValidation {
  const reasons: string[] = [];
  if (typeof artifact !== "object" || artifact === null) return { status: "MALFORMED", reasons: ["账本不是对象"], invalidClaimIds: [] };
  const record = artifact as Partial<ClaimAuditArtifact>;
  if (record.schema !== CLAIM_AUDIT_SCHEMA || !Array.isArray(record.claims) || !Array.isArray(record.units)) {
    return { status: "MALFORMED", reasons: [`schema=${String(record.schema)} 或结构缺失`], invalidClaimIds: [] };
  }
  if (record.sourceRevision !== expected.sourceRevision) reasons.push(`账本修订 ${String(record.sourceRevision)} ≠ 被审修订 ${String(expected.sourceRevision)}`);
  if (record.documentFingerprint !== expected.documentFingerprint) reasons.push("账本文档指纹与本轮覆盖快照不一致");
  const contents = new Map(expected.files.map((file) => [file.file, file.content]));
  const invalidClaimIds: string[] = [];
  for (const claim of record.claims) {
    const content = contents.get(claim.file);
    const located = claim.location;
    if (content === undefined) {
      invalidClaimIds.push(claim.claimId);
      continue;
    }
    if (located.start !== null && located.end !== null) {
      if (content.slice(located.start, located.end) !== claim.quote) invalidClaimIds.push(claim.claimId);
    } else if (locateQuote(content, claim.quote, 12) === null) {
      invalidClaimIds.push(claim.claimId);
    }
  }
  if (invalidClaimIds.length > 0) reasons.push(`${invalidClaimIds.length} 条论断的原文切片在被审修订中不再成立`);
  return { status: reasons.length === 0 ? "VALID" : "STALE", reasons, invalidClaimIds };
}

/** 账本的紧凑摘要（gate 影子决策 / 只读视图 / stage result 消费） */
export function summarizeClaimAudit(artifact: ClaimAuditArtifact, validation?: ClaimAuditValidation) {
  const valid = validation === undefined || validation.status === "VALID";
  return {
    schema: artifact.schema,
    round: artifact.round,
    validation: validation?.status ?? "NOT_CHECKED",
    claimAuditMode: artifact.evaluationPolicy.claimAuditMode,
    promptContract: artifact.evaluationPolicy.promptContract,
    sourceVerification: artifact.sourceVerification.level,
    claims: valid ? artifact.coverage.claims : { ...artifact.coverage.claims, note: "STALE：账本与被审修订不一致，全部按 NOT_EVALUATED 处理" },
    units: artifact.coverage.units,
    crossUnitTasks: artifact.coverage.crossUnitTasks,
    verifiedContradicted: valid
      ? artifact.claims.filter((claim) => claim.verificationStatus === "VERIFIED_CONTRADICTED").map((claim) => ({ claimId: claim.claimId, heading: claim.heading, quote: claim.quote.slice(0, 160), basis: claim.basis, reason: claim.statusReason.slice(0, 240) }))
      : [],
    scientificClaimCoverage: artifact.coverage.scientificClaimCoverage,
  };
}
