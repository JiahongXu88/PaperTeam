/**
 * M15.6 阶段 B：跨节数值一致性（摘要 / 结论 ↔ 结果表格），确定性、零模型。
 *
 * 解决的盲区（M15.5 CE1 0/2 检出）：fact reviewer 的同节核对能力强（正文 ↔ 邻近表），
 * 但摘要 / 结论中的「方法 X 在数据集 D 的指标 M 上达到 V」与实验表的对应关系
 * 没有任何核验腿覆盖——注入矛盾（CE1：摘要 HOTA 65.9/65.2 vs 表 63.2/62.1）两轮 0 检出。
 *
 * 本模块完全复用 claim-certificate/v1 的绑定与数值判别机制（不新建证书器）：
 *  - 数值定位：核心节（abstract 环境 / 结论 section）内逐个数值原子（值 + 显示精度 + 单位 + 限定词）；
 *  - 唯一绑定：bindTextAtom（列维 / 行维 / 语境维；B2 跨表 / B3 限定词 / 多指标并列守卫全部生效）；
 *  - 数值关系：compareAtoms（显示精度区间 + 单位换算 + 量纲歧义 fail-closed）；
 *  - 派生量：recomputeDerived（受控 AST + 区间算术；解释不唯一 → 弃判）。
 *
 * 与 certifyClaim 双钥匙路径的差异（预登记决策，PRE_REGISTERED_PROTOCOL.md §1）：
 * 本检查由系统主动扫描而非模型提议，无模型核对结论可双钥匙；矛盾判定的依据
 * 是「唯一绑定 + 数值区间判别 + 跨表疑义消解」三重确定性条件，provenance =
 * deterministic。跨表疑义（bindTextAtom 的 N09 VALUE_APPEARS_IN_OTHER_TABLE 拒绝）
 * 只有在「值在其他表的全部出现都不构成可信参照（行未被论断点名，或列与绑定列
 * 不同指标）」时才消解——消解不了就只给 SUSPECTED_ISSUE，绝不硬判。
 *
 * 诚实边界（fail-closed）：
 *  - 整数（计数 / 年份 / 步数 / 配置值）不进矛盾判定——显示精度 ≥1 位小数才是
 *    测量值形态；整数与表格碰撞的假阳性不可控（700+ FPS / h_p=8 之类）。
 *  - 约数 / 不等式限定 → NOT_EVALUATED；派生量解释不唯一 → NOT_EVALUATED
 *    （allInterpretationsDisagree 只给 SUSPECTED，不出证书）。
 *  - 集合量词结论（「全部提升」）不做数值证伪——记录为观察缺口，不出判定。
 *  - 绑定不唯一 / 表格解析受损 / 语境解释不了限定词 → NOT_EVALUATED（绝不签发「已核验一致」）。
 */

import { createHash } from "node:crypto";
import { parseNumbers } from "./claimAuditText.js";
import {
  atomQualifiers,
  bindTextAtom,
  buildCertificateDocument,
  compareAtoms,
  contextTokens,
  recomputeDerived,
  textScopes,
  type CertificateAtom,
  type CertificateDocument,
} from "./claimCertificate.js";
import { plainLatexText } from "./latexTable.js";
import { STOP, mentions, type GuardContext } from "./claimGuards.js";

export const CROSS_SECTION_CONSISTENCY_SCHEMA = "paperteam.cross-section-consistency/v1";

/** 核心节标题（结论 / 总结；与 findingAdjudication.CORE_HEADING 同族语义，本模块独立维护） */
const CONCLUSION_HEADING =
  /^(?:\d*\s*\.?\s*)?(?:结\s*论|总结|结语|结论与展望|工作总结|结\s*论与展\s*望|Conclusions?(?:\s+and\s+(?:Future\s+(?:Work|Directions?|Research|Outlook)|Outlook|Prospects?))?|Summary(?:\s+and\s+(?:Future\s+)?Work)?|Closing\s+Remarks)$/i;
/** abstract 环境名（常见变体；中文论文常见 abstract / cnabstract 环境） */
const ABSTRACT_ENV = /^(?:abstract|cnabstract|enabstract|chineseabstract|englishabstract)$/i;

export type CrossSectionOutcome = "VERIFIED_CONTRADICTION" | "SUSPECTED_ISSUE" | "CONSISTENT" | "NOT_EVALUATED";

export interface CrossSectionWitness {
  file: string;
  sectionKind: "abstract" | "conclusion";
  heading: string;
  /** 文件内偏移（end 不含） */
  start: number;
  end: number;
  raw: string;
  value: number;
  decimals: number;
  unit: string | null;
  qualifiers: string[];
  /** 数值所在句（≤240 字，脱敏呈现用） */
  quote: string;
  outcome: CrossSectionOutcome;
  reasonCodes: string[];
  binding?: {
    status: string;
    rule: string;
    bound: { file: string; tableId: string; row: number; col: number; value: string; rowKey: string[]; headerPath: string[] } | null;
    rejections: string[];
  };
  valueRelation?: { relation: string; note: string };
  doubtResolution?: { competitors: number; plausible: number; resolved: boolean; note: string };
  derived?: { family: string; certifiable: boolean; allInterpretationsDisagree: boolean | null; subjectStatus: string; referenceStatus: string };
  provenance: "deterministic";
}

export interface CrossSectionConsistencySummary {
  schema: typeof CROSS_SECTION_CONSISTENCY_SCHEMA;
  status: "EVALUATED" | "UNAVAILABLE";
  unavailableReason?: string;
  sectionsScanned: Array<{ file: string; kind: "abstract" | "conclusion"; heading: string; chars: number }>;
  atomsTotal: number;
  counts: {
    verifiedContradictions: number;
    suspected: number;
    consistent: number;
    notEvaluated: number;
    skippedInteger: number;
    setQuantifierClaims: number;
  };
  /** NOT_EVALUATED 原因码直方图（诚实呈现「没能核验什么」） */
  notEvaluatedReasons: Record<string, number>;
  witnesses: CrossSectionWitness[];
  inputsSha256: string;
}

/** 单核心节内最多扫描的数值原子数（有界；摘要 / 结论远小于此） */
const MAX_ATOMS_PER_SECTION = 60;
/** 全文档 witness 明细上限（矛盾 / 疑义全部保留，CONSISTENT / NOT_EVALUATED 截断） */
const MAX_WITNESSES = 80;

interface CoreSection {
  file: string;
  kind: "abstract" | "conclusion";
  heading: string;
  start: number;
  end: number;
}

/** \section / \section* / \chapter 的标题与偏移（核心节定位用） */
function sectionHeadings(content: string): Array<{ heading: string; start: number; end: number }> {
  const out: Array<{ heading: string; start: number; end: number }> = [];
  for (const match of content.matchAll(/\\(?:sub)*section\*?\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}|\\chapter\*?\s*(?:\[[^\]]*\])?\s*\{([^{}]*)\}/g)) {
    const heading = (match[1] ?? match[2] ?? "").trim();
    out.push({ heading, start: match.index!, end: match.index! + match[0].length });
  }
  return out;
}

/** 定位核心节：abstract 环境全部 + 结论类 section（到下一个 section / 章节命令或文件尾） */
export function locateCoreSections(files: ReadonlyArray<{ file: string; content: string }>): CoreSection[] {
  const out: CoreSection[] = [];
  for (const entry of files) {
    const content = entry.content;
    for (const match of content.matchAll(/\\begin\{([A-Za-z]*)\}/g)) {
      if (!ABSTRACT_ENV.test(match[1]!)) continue;
      const endMatch = new RegExp(`\\\\end\\{${match[1]!}\\}`).exec(content.slice(match.index!));
      const end = endMatch === null ? Math.min(content.length, match.index! + 4000) : match.index! + endMatch.index + endMatch[0].length;
      out.push({ file: entry.file, kind: "abstract", heading: "abstract", start: match.index!, end });
    }
    const headings = sectionHeadings(content);
    headings.forEach((section, index) => {
      if (!CONCLUSION_HEADING.test(section.heading)) return;
      const next = headings[index + 1];
      const end = Math.min(content.length, next?.start ?? content.length);
      if (end <= section.end) return;
      out.push({ file: entry.file, kind: "conclusion", heading: section.heading, start: section.end, end });
    });
  }
  return out;
}

/** 数值原子不可出现的区域：引用 / 交叉引用 / 标签 / url / 脚注 与 注释行 */
function excludedRegions(content: string): Array<{ start: number; end: number }> {
  const out: Array<{ start: number; end: number }> = [];
  for (const match of content.matchAll(/\\(?:cite[a-zA-Z]*|ref|eqref|autoref|cref|Cref|label|url|href|footnote)\*?(?:\[[^\]]*\])*\{[^{}]*\}/g)) {
    out.push({ start: match.index!, end: match.index! + match[0].length });
  }
  for (const match of content.matchAll(/(?<!\\)%[^\n]*/g)) {
    out.push({ start: match.index!, end: match.index! + match[0].length });
  }
  return out;
}

/** 核心节内数值原子（带文件内偏移；跳过表格体 / 引用 / 注释） */
function scanNumbersInSection(
  content: string,
  section: CoreSection,
  tableSpans: Array<{ start: number; end: number }>,
  excluded: Array<{ start: number; end: number }>,
): Array<{ start: number; end: number; parsed: ReturnType<typeof parseNumbers>[number] }> {
  const inRegion = (offset: number, regions: Array<{ start: number; end: number }>) =>
    regions.some((region) => offset >= region.start && offset < region.end);
  const out: Array<{ start: number; end: number; parsed: ReturnType<typeof parseNumbers>[number] }> = [];
  const span = content.slice(section.start, section.end);
  // 词元边界：前侧不得紧邻字母/数字/反斜杠（MOT17 / \d 里的数字不是数值）；后侧不得是词字符或「.数字」
  // （65.98 不能截成 65.9）——句末句点（65.9. 结尾）允许。
  for (const match of span.matchAll(/(?<![\w.\\])(\d{1,3}(?:,\d{3})+(?:\.\d+)?|\d+(?:\.\d+)?|\.\d+)(?!\w)(?!\.\d)/g)) {
    const start = section.start + match.index!;
    const end = start + match[0]!.length;
    if (inRegion(start, tableSpans) || inRegion(start, excluded)) continue;
    // 数值后 24 字符窗口解析单位（\% / ms / × 等；parseNumbers 与证书器同源）
    const parsed = parseNumbers(content.slice(start, Math.min(content.length, start + 24)))[0];
    if (parsed === undefined || parsed.raw.replace(/,/g, "") !== match[0]!.replace(/,/g, "")) continue;
    out.push({ start, end, parsed });
    if (out.length >= MAX_ATOMS_PER_SECTION) break;
  }
  return out;
}

function contextOf(text: string): GuardContext {
  return { tokens: new Set(contextTokens(text)), plain: plainLatexText(text).toLowerCase() };
}

function significantTokens(text: string): string[] {
  return [...new Set(contextTokens(text))].filter((token) => !STOP.has(token) && token.length >= 2);
}

/**
 * 跨表疑义消解（bindTextAtom N09 的本模块细化，fail-closed）：
 * 值在其他表的出现若存在「可信参照」格——列叶子表头与绑定列同指标族 且 行键区分词被
 * 论断语境点名——则该数值可能指向那张表，矛盾不可证（SUSPECTED）；全部出现都不可信
 * 参照时疑义消解（VERIFIED）。「行被点名」用与 rowMentionScore 同族的词面判别
 * （区分词 ∩ 论断语境 ≠ ∅），只用于降级（消解不了就不出强判），不用于升级。
 */
function resolveCrossTableDoubt(
  document: CertificateDocument,
  atom: CertificateAtom,
  bound: { file: string; tableId: string },
  claimContext: GuardContext,
): { competitors: number; plausible: number; resolved: boolean; note: string } {
  const boundFile = document.files.find((entry) => entry.file === bound.file);
  const boundTable = boundFile?.tables.find((table) => table.tableId === bound.tableId) ?? null;
  const boundLeaf = boundTable === null ? "" : (boundTable.cells.find((cell) => !cell.isHeader && cell.value !== null)?.headerPath.slice(-1).join(" ") ?? "");
  let competitors = 0;
  let plausible = 0;
  for (const file of document.files) {
    for (const table of file.tables) {
      if (table.tableId === bound.tableId && file.file === bound.file) continue;
      if (table.parseIssues.includes("NESTED_TABULAR")) continue;
      for (const cell of table.cells) {
        if (cell.isHeader || cell.value === null || cell.rowKey.length === 0) continue;
        if (compareAtoms(atom, { value: cell.value.value, decimals: cell.value.decimals, unit: cell.value.unit ?? cell.unit }).relation !== "OVERLAP") continue;
        competitors += 1;
        const leafTokens = new Set(significantTokens(cell.headerPath.slice(-1).join(" ")));
        const sameMetricFamily =
          leafTokens.size > 0 &&
          [...leafTokens].some((token) => significantTokens(boundLeaf).includes(token));
        const rowMentioned = significantTokens(cell.rowKey.join(" ")).some((token) => mentions(claimContext, token));
        if (sameMetricFamily && rowMentioned) plausible += 1;
      }
    }
  }
  return {
    competitors,
    plausible,
    resolved: plausible === 0,
    note:
      plausible === 0
        ? competitors === 0
          ? "值未出现在其他表格（无跨表疑义）"
          : `值在其他表出现 ${competitors} 处，但均不在「行被点名且与绑定列同指标」的可信参照格——疑义消解`
        : `值在其他表存在 ${plausible}/${competitors} 处可信参照格（行被点名且同指标列）——跨表归属不可证，降为 SUSPECTED`,
  };
}

/** 集合量词结论的观察（只计数与留样，不出判定——集合量词的对应关系无法确定性枚举） */
const SET_QUANTIFIER = /\b(?:all|across all|consistently|uniformly|in all cases|every)\b[^.]{0,120}\b(?:improv\w*|outperform\w*|better|exceed\w*|surpass\w*|beat\w*|superior)\b|\b(?:improv\w*|outperform\w*|surpass\w*)\b[^.]{0,80}\b(?:in all|on all|across all|consistently)\b|(?:全部|所有|均|一致地|在各种)[^。]{0,60}(?:提升|优于|超过|改善|胜过|更优)|(?:提升|优于|超过|改善)[^。]{0,40}(?:全部|所有|均|一致)/i;

/**
 * 聚合措辞守卫（本模块的保守降级，只作用于矛盾判定路径、不修改共享证书器）：
 * 分句出现 average / mean / overall / across / 平均 时，数值可能是跨配置 / 跨数据集的聚合值，
 * 与任何单个表格单元格的可比性不可证（「average HOTA of 63.0」不是任一数据集的 HOTA）→ NOT_EVALUATED。
 * 只降级不升级（fail-closed）；已带共享 AGGREGATE 限定的原子走派生复算路径，不受本守卫影响。
 */
const AGGREGATE_WORDING = /\b(?:average|averaged|mean|overall|across)\b|平均/;

export interface CrossSectionInput {
  files: ReadonlyArray<{ file: string; content: string }>;
  /** 论文题目（本文方法名识别；缺省从 \title 读） */
  title?: string | null;
  now?: () => Date;
}

/**
 * 计算跨节数值一致性摘要（纯函数、确定性、零模型）。
 * 输入 = 全部 LaTeX 文件；同一输入恒得同一结果（inputsSha256 绑定）。
 */
export function computeCrossSectionConsistency(input: CrossSectionInput): CrossSectionConsistencySummary {
  const files = input.files;
  if (files.length === 0) {
    return unavailable("NO_FILES", files);
  }
  // 证书文档（表格解析一次；与 claimAudit 证书器同一实现）
  const document = buildCertificateDocument(files, input.title ?? null);
  const coreSections = locateCoreSections(files);
  if (coreSections.length === 0) {
    return unavailable("NO_CORE_SECTIONS", files);
  }
  const hasAnyTable = document.files.some((entry) => entry.tables.length > 0);
  if (!hasAnyTable) {
    return unavailable("NO_TABLES", files);
  }

  const counts = { verifiedContradictions: 0, suspected: 0, consistent: 0, notEvaluated: 0, skippedInteger: 0, setQuantifierClaims: 0 };
  const notEvaluatedReasons: Record<string, number> = {};
  const witnesses: CrossSectionWitness[] = [];
  let atomsTotal = 0;
  const noteReason = (code: string): void => {
    notEvaluatedReasons[code] = (notEvaluatedReasons[code] ?? 0) + 1;
  };
  const sectionsScanned: CrossSectionConsistencySummary["sectionsScanned"] = [];

  for (const section of coreSections) {
    const entry = document.files.find((candidate) => candidate.file === section.file);
    if (entry === undefined) continue;
    const content = entry.content;
    const tableSpans = entry.tables.map((table) => ({ start: table.start, end: table.end }));
    const excluded = excludedRegions(content);
    const atoms = scanNumbersInSection(content, section, tableSpans, excluded);
    sectionsScanned.push({ file: section.file, kind: section.kind, heading: section.heading, chars: section.end - section.start });
    // 集合量词观察（不出判定）
    const sectionText = content.slice(section.start, section.end);
    for (const _match of sectionText.matchAll(new RegExp(SET_QUANTIFIER.source, "gi"))) {
      counts.setQuantifierClaims += 1;
    }
    for (const atomHit of atoms) {
      atomsTotal += 1;
      const scopes = textScopes(content, atomHit.start, atomHit.end);
      const qualifiers = atomQualifiers(scopes, atomHit.parsed.raw);
      const quote = plainLatexText(scopes.sentence).slice(0, 240);
      const baseWitness = {
        file: section.file,
        sectionKind: section.kind,
        heading: section.heading,
        start: atomHit.start,
        end: atomHit.end,
        raw: atomHit.parsed.raw,
        value: atomHit.parsed.value,
        decimals: atomHit.parsed.decimals,
        unit: atomHit.parsed.unit,
        qualifiers,
        quote,
        provenance: "deterministic" as const,
      };
      const pushWitness = (outcome: CrossSectionOutcome, reasonCodes: string[], extras: Partial<CrossSectionWitness> = {}): void => {
        if (outcome === "VERIFIED_CONTRADICTION" || outcome === "SUSPECTED_ISSUE" || witnesses.length < MAX_WITNESSES) {
          witnesses.push({ ...baseWitness, outcome, reasonCodes, ...extras });
        }
      };
      // 1. 约数 / 不等式 → 不可核验（证书器同语义）
      if (qualifiers.includes("APPROX") || qualifiers.includes("INEQUALITY")) {
        counts.notEvaluated += 1;
        noteReason(qualifiers.includes("APPROX") ? "QUALIFIER_APPROX" : "QUALIFIER_INEQUALITY");
        pushWitness("NOT_EVALUATED", [qualifiers.includes("APPROX") ? "QUALIFIER_APPROX" : "QUALIFIER_INEQUALITY"]);
        continue;
      }
      // 2. 派生量（提升 / 百分点 / 倍数 / 平均）→ 受控 AST 复算
      if (qualifiers.includes("DERIVED") || qualifiers.includes("AGGREGATE") || qualifiers.includes("SIGNED")) {
        const derived = recomputeDerived(document, {
          kind: "TEXT",
          file: section.file,
          start: atomHit.start,
          end: atomHit.end,
          raw: atomHit.parsed.raw,
          value: atomHit.parsed.value,
          decimals: atomHit.parsed.decimals,
          unit: atomHit.parsed.unit,
          qualifiers,
        });
        const derivedInfo = {
          family: derived.recompute.family,
          certifiable: derived.certifiable,
          allInterpretationsDisagree: derived.recompute.allInterpretationsDisagree,
          subjectStatus: derived.recompute.subject.status,
          referenceStatus: derived.recompute.reference.status,
        };
        if (derived.certifiable && derived.outcome === "CONTRADICTED") {
          counts.verifiedContradictions += 1;
          pushWitness("VERIFIED_CONTRADICTION", ["DERIVED_RECOMPUTE_CONTRADICTED"], { derived: derivedInfo });
          continue;
        }
        if (derived.certifiable && derived.outcome === "SUPPORTED") {
          counts.consistent += 1;
          pushWitness("CONSISTENT", ["DERIVED_RECOMPUTE_SUPPORTED"], { derived: derivedInfo });
          continue;
        }
        counts.notEvaluated += 1;
        const code = derived.recompute.allInterpretationsDisagree === true ? "DERIVED_ALL_INTERPRETATIONS_DISAGREE" : "DERIVED_NOT_CERTIFIABLE";
        noteReason(code);
        pushWitness(code === "DERIVED_ALL_INTERPRETATIONS_DISAGREE" ? "SUSPECTED_ISSUE" : "NOT_EVALUATED", [code, ...derived.reasons.slice(0, 3)], { derived: derivedInfo });
        if (code === "DERIVED_ALL_INTERPRETATIONS_DISAGREE") counts.suspected += 1;
        continue;
      }
      // 3. 原子值：整数不进矛盾判定（计数 / 年份 / 配置值的表格碰撞假阳性不可控）
      if (atomHit.parsed.decimals === 0) {
        counts.skippedInteger += 1;
        noteReason("INTEGER_NOT_MEASUREMENT_LIKE");
        pushWitness("NOT_EVALUATED", ["INTEGER_NOT_MEASUREMENT_LIKE"]);
        continue;
      }
      // 3b. 聚合措辞守卫：分句含 average/mean/overall/across/平均 → 聚合口径不可证可比 → NOT_EVALUATED
      if (AGGREGATE_WORDING.test(plainLatexText(scopes.segment))) {
        counts.notEvaluated += 1;
        noteReason("AGGREGATE_WORDING");
        pushWitness("NOT_EVALUATED", ["AGGREGATE_WORDING"]);
        continue;
      }
      // 4. 原子值唯一绑定 + 数值关系
      const atom: CertificateAtom = {
        kind: "TEXT",
        file: section.file,
        start: atomHit.start,
        end: atomHit.end,
        raw: atomHit.parsed.raw,
        value: atomHit.parsed.value,
        decimals: atomHit.parsed.decimals,
        unit: atomHit.parsed.unit,
        qualifiers,
        scopes: { segment: scopes.segment.slice(0, 600), window: scopes.window.slice(0, 300) },
      };
      const binding = bindTextAtom(document, atom);
      const bindingInfo = {
        status: binding.status,
        rule: binding.rule,
        bound: binding.bound ?? null,
        rejections: binding.rejections.slice(0, 6),
      };
      if (binding.status !== "UNIQUE" && binding.bound === undefined) {
        counts.notEvaluated += 1;
        noteReason(`BINDING_${binding.status}`);
        pushWitness("NOT_EVALUATED", [`BINDING_${binding.status}`, ...binding.rejections.slice(0, 3)], { binding: bindingInfo });
        continue;
      }
      const target = binding.bound!;
      const targetEntry = document.files.find((candidate) => candidate.file === target.file);
      const targetTable = targetEntry?.tables.find((table) => table.tableId === target.tableId) ?? null;
      const targetCell = targetTable?.cells.find((cell) => cell.row === target.row && cell.col === target.col && !cell.isHeader) ?? null;
      if (targetCell?.value == null || targetTable === null || targetTable.parseIssues.length > 0) {
        counts.notEvaluated += 1;
        noteReason(targetCell?.value == null ? "BOUND_CELL_NOT_NUMERIC" : "TABLE_PARSE_ISSUES");
        pushWitness("NOT_EVALUATED", [targetCell?.value == null ? "BOUND_CELL_NOT_NUMERIC" : "TABLE_PARSE_ISSUES"], { binding: bindingInfo });
        continue;
      }
      const relation = compareAtoms(atom, {
        value: targetCell.value.value,
        decimals: targetCell.value.decimals,
        unit: targetCell.value.unit ?? targetCell.unit,
      });
      const relationInfo = { relation: relation.relation, note: relation.note };
      if (relation.relation === "OVERLAP" && binding.status === "UNIQUE") {
        counts.consistent += 1;
        pushWitness("CONSISTENT", ["UNIQUE_BINDING_OVERLAP"], { binding: bindingInfo, valueRelation: relationInfo });
        continue;
      }
      if (relation.relation === "OVERLAP" && binding.status === "AMBIGUOUS") {
        // 值一致但绑定存疑（UNEXPLAINED_CONTEXT 等）→ 记一致但不据此签发任何强判定
        counts.consistent += 1;
        noteReason("CONSISTENT_BUT_BINDING_AMBIGUOUS");
        pushWitness("CONSISTENT", ["CONSISTENT_BUT_BINDING_AMBIGUOUS", ...binding.rejections.slice(0, 2)], { binding: bindingInfo, valueRelation: relationInfo });
        continue;
      }
      if (relation.relation === "SCALE_AMBIGUOUS" || relation.relation === "UNIT_MISMATCH") {
        counts.notEvaluated += 1;
        noteReason(`VALUE_${relation.relation}`);
        pushWitness("NOT_EVALUATED", [`VALUE_${relation.relation}`], { binding: bindingInfo, valueRelation: relationInfo });
        continue;
      }
      // DISJOINT：跨表疑义消解（N09 只允许 VALUE_APPEARS_IN_OTHER_TABLE 一种拒绝时才进入）
      const onlyValueAppears = binding.status === "UNIQUE" || binding.rejections.every((rejection) => rejection.startsWith("VALUE_APPEARS_IN_OTHER_TABLE"));
      if (!onlyValueAppears) {
        counts.notEvaluated += 1;
        noteReason("BINDING_AMBIGUOUS_OTHER_REJECTIONS");
        pushWitness("NOT_EVALUATED", ["BINDING_AMBIGUOUS_OTHER_REJECTIONS", ...binding.rejections.slice(0, 3)], { binding: bindingInfo, valueRelation: relationInfo });
        continue;
      }
      const claimContext = contextOf(`${scopes.segment} ${scopes.subjectSentence}`);
      const doubt = resolveCrossTableDoubt(document, atom, { file: target.file, tableId: target.tableId }, claimContext);
      if (doubt.resolved) {
        counts.verifiedContradictions += 1;
        pushWitness("VERIFIED_CONTRADICTION", ["UNIQUE_BINDING_DISJOINT", "CROSS_TABLE_DOUBT_RESOLVED"], {
          binding: bindingInfo,
          valueRelation: relationInfo,
          doubtResolution: doubt,
        });
      } else {
        counts.suspected += 1;
        noteReason("CROSS_TABLE_DOUBT_UNRESOLVED");
        pushWitness("SUSPECTED_ISSUE", ["UNIQUE_BINDING_DISJOINT", "CROSS_TABLE_DOUBT_UNRESOLVED"], {
          binding: bindingInfo,
          valueRelation: relationInfo,
          doubtResolution: doubt,
        });
      }
    }
  }

  return {
    schema: CROSS_SECTION_CONSISTENCY_SCHEMA,
    status: "EVALUATED",
    sectionsScanned,
    atomsTotal,
    counts,
    notEvaluatedReasons,
    witnesses,
    inputsSha256: sha256OfFiles(files),
  };
}

function unavailable(reason: string, files: ReadonlyArray<{ file: string; content: string }>): CrossSectionConsistencySummary {
  return {
    schema: CROSS_SECTION_CONSISTENCY_SCHEMA,
    status: "UNAVAILABLE",
    unavailableReason: reason,
    sectionsScanned: [],
    atomsTotal: 0,
    counts: { verifiedContradictions: 0, suspected: 0, consistent: 0, notEvaluated: 0, skippedInteger: 0, setQuantifierClaims: 0 },
    notEvaluatedReasons: {},
    witnesses: [],
    inputsSha256: sha256OfFiles(files),
  };
}

function sha256OfFiles(files: ReadonlyArray<{ file: string; content: string }>): string {
  return createHash("sha256")
    .update(files.map((file) => `${file.file}:${createHash("sha256").update(file.content, "utf8").digest("hex")}`).join("\n"), "utf8")
    .digest("hex");
}
