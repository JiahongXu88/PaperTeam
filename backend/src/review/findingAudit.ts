/**
 * M15.1 Finding provenance audit（确定性、只读、shadow）：单条审稿 finding 能否只凭被审原文确立。
 *
 * 针对 M15 校准实验的两类已知误报（Claude 模型辅助核对，不是人类金标准）：
 *  - 跨单元假缺失（K4C3F05B：摘要单元称「只列出 4 个数据集」，引言列全了 7 个；KEADC367：「TH、TL 在本节没有给出」，
 *    3.3 节给出了）——finding 断言「没有 / 未说明 / 只列出」，而断言涉及的区分性术语在其他单元出现 → CONTEXT_INCOMPLETE；
 *  - PDF 转写伪影（KEADC367：「式(2) LaTeX 源码损坏」来自 PDF 转写，原件正常）——来源未核验的转写稿上，
 *    显示公式丢失全部 LaTeX 结构 / 含替换字形 / 表格行，而 finding 指称损坏 → PARSE_ARTIFACT_SUSPECTED；
 *    项目没有页面级 provenance 时如实给出「无法回看原件」。
 *
 * 诚实边界：这是诊断，不删除、不改写 finding 的 severity / blocking，也不进生产 Gate 计数；
 * 「其他单元出现相关术语」不证明 finding 错，只证明单元视角的「全文没有」不可确立。
 */

import type { ReviewIssue } from "../agents/ReviewerService.js";
import type { SourceVerification } from "./reviewContextSnapshot.js";
import { compactText, containsTerm, distinctiveTerms, locateQuote, sha256Text } from "./claimAuditText.js";
import { transcriptionRiskSignals } from "./claimAudit.js";

export const FINDING_AUDIT_VERSION = "finding-audit/v1";

export type FindingAuditStatus = "TEXT_LOCATED" | "CONTEXT_INCOMPLETE" | "PARSE_ARTIFACT_SUSPECTED" | "QUOTE_NOT_LOCATED" | "NO_QUOTE";

export interface FindingAuditRecord {
  findingId: string;
  issueIndex: number;
  unitId: string | null;
  file: string | null;
  section: string;
  category: string;
  severityObserved: string;
  blockingObserved: boolean;
  verificationDeclared: string | null;
  quoteLocation: "IN_UNIT" | "IN_DOCUMENT" | "NOT_LOCATED" | "NO_QUOTE";
  locatedUnitId?: string;
  absenceAssertion: boolean;
  selfDeclaredContextGap: boolean;
  documentLookup: {
    status: "NOT_APPLICABLE" | "ENTITIES_FOUND_ELSEWHERE" | "NO_EVIDENCE_ELSEWHERE" | "NO_DISTINCTIVE_TERMS";
    terms: string[];
    hits: Array<{ unitId: string; heading: string; matched: string[]; excerpt: string }>;
  };
  parseRisk: {
    status: "NOT_APPLICABLE" | "PARSE_ARTIFACT_SUSPECTED" | "NO_SIGNAL";
    signals: string[];
    originalCheck: "NOT_NEEDED" | "NOT_AVAILABLE" | "FIDELITY_REPORT_FLAGGED";
  };
  auditStatus: FindingAuditStatus;
  /** shadow：该 finding 是否可能只凭被审原文确立（不改生产计数） */
  eligibleForTextVerification: boolean;
  note: string;
}

export interface FindingAuditSummary {
  version: typeof FINDING_AUDIT_VERSION;
  total: number;
  byStatus: Record<FindingAuditStatus, number>;
  criticalMajor: { total: number; byStatus: Record<FindingAuditStatus, number> };
  absenceAssertions: number;
  sourceVerification: SourceVerification;
  note: string;
}

/** 缺失型断言（「没有 / 未说明 / 只列出 / does not mention …」）——单元视角无法确立全文缺失 */
const ABSENCE = /(没有(?:说明|给出|报告|提及|列出|介绍|定义|交代|说清|写明|指明)|未(?:说明|给出|报告|提及|列出|介绍|定义|交代|指明|明确|写明|提供)|只列出|仅列出|只给出了?部分|其余.{0,8}(?:没有|未)|无从得知|缺少(?:对|关于)?.{0,12}(?:说明|定义|描述|取值)|does not (?:mention|specify|report|define|describe|list|state|provide)|do not (?:mention|specify|report|define|list|provide)|not (?:specified|mentioned|reported|defined|described|listed|stated|provided)|unspecified|never (?:defined|mentioned|introduced|specified)|no (?:definition|description|mention) of|only (?:lists?|names?|mentions?))/i;
/** 单元审稿 prompt 的自声明缺口标记（M14.9.5.4） */
const SELF_DECLARED_GAP = /【需结合其他章节核对】|需结合其他章节核对|需与.{0,40}(?:核对|对照)|may be (?:defined|given|reported) in (?:another|other) section/;
/** 摘要 / 引言 / 结论等复述型单元（不作为「别处已给出」的证据来源；与 implicitContext 同口径） */
const SUMMARY_UNIT = /^(?:frontmatter|前置内容|摘要与前置部分|摘\s*要|Abstract|\d*\s*引言|绪论|\d*\s*Introduction|\d*\s*结论|总结|\d*\s*Conclusions?)$/i;
/** finding 指称排版 / 公式 / 字符损坏 */
const CORRUPTION_CLAIM = /(损坏|乱码|错乱|残留|转换|转写|排版|无法(?:读出|解析|辨认)|不可读|缺失(?:下标|上标|括号)|garbled|corrupt|malformed|broken|unreadable|mangled|rendering)/i;

/** 显示公式失去全部 LaTeX 结构（转写拍平：无任何命令、下标被拍成普通字母、编号写进公式） */
export function flattenedDisplayMath(text: string): boolean {
  for (const match of text.matchAll(/\\\[([\s\S]*?)\\\]|\$\$([\s\S]*?)\$\$/g)) {
    const body = (match[1] ?? match[2] ?? "").trim();
    if (body.length < 6) continue;
    const hasCommand = /\\[A-Za-z]+/.test(body) || /[_^]/.test(body);
    const plainSymbols = /[∗≥≤×∑∏∫√≠≈∈αβγδθλμσω]/.test(body) || /\(\d{1,3}\)\s*$/.test(body) || /\s\(\d{1,3}\)\s/.test(body);
    if (!hasCommand && plainSymbols) return true;
  }
  return false;
}

export interface FindingAuditUnit {
  unitId: string;
  file: string;
  heading: string;
  text: string;
}

export function findingIdOf(issue: Pick<ReviewIssue, "category" | "description"> & Partial<Pick<ReviewIssue, "quote" | "logicalSection" | "file">>): string {
  return `f1-${sha256Text(`${issue.file ?? ""}|${issue.logicalSection ?? ""}|${issue.category}|${compactText(issue.quote ?? "")}|${compactText(issue.description).slice(0, 200)}`).slice(0, 16)}`;
}

export function auditFindings(input: {
  issues: readonly ReviewIssue[];
  units: readonly FindingAuditUnit[];
  sourceVerification: SourceVerification;
  /** 输入保真报告记录的转写疑点摘录 */
  conversionExcerpts?: readonly string[];
  /** 项目是否有页面级原件 provenance（当前只读评估路径没有；为 true 时诊断改为可回看） */
  pageProvenanceAvailable?: boolean;
}): { records: FindingAuditRecord[]; summary: FindingAuditSummary } {
  const transcription = input.sourceVerification !== "AUTHOR_SOURCE" && input.sourceVerification !== "SOURCE_ATTESTED";
  const unitIdOf = (issue: ReviewIssue): string | null => {
    if (issue.file === undefined || issue.logicalSection === undefined) return null;
    const exact = input.units.find((unit) => unit.file === issue.file && unit.unitId.startsWith(`${issue.file}::${issue.logicalSection}`));
    return exact?.unitId ?? null;
  };
  const conversion = (input.conversionExcerpts ?? []).map((excerpt) => compactText(excerpt)).filter((excerpt) => excerpt.length >= 8);
  const termUnitFrequency = (term: string): number => input.units.filter((unit) => containsTerm(unit.text, term)).length;
  const records = input.issues.map((issue, issueIndex): FindingAuditRecord => {
    const ownUnitIds = new Set<string>();
    const mapped = unitIdOf(issue);
    if (mapped !== null) {
      // logicalSection 可能对应多个 #uN 单元：整个 span 视为本单元
      for (const unit of input.units) if (issue.file !== undefined && issue.logicalSection !== undefined && unit.unitId.startsWith(`${issue.file}::${issue.logicalSection}`)) ownUnitIds.add(unit.unitId);
    }
    const ownText = input.units.filter((unit) => ownUnitIds.has(unit.unitId)).map((unit) => unit.text).join("\n");
    let quoteLocation: FindingAuditRecord["quoteLocation"] = "NO_QUOTE";
    let locatedUnitId: string | undefined;
    if (issue.quote !== undefined && compactText(issue.quote).length >= 8) {
      if (ownText !== "" && locateQuote(ownText, issue.quote) !== null) {
        quoteLocation = "IN_UNIT";
      } else {
        const hit = input.units.find((unit) => locateQuote(unit.text, issue.quote!) !== null);
        quoteLocation = hit !== undefined ? (ownUnitIds.size === 0 ? "IN_UNIT" : "IN_DOCUMENT") : "NOT_LOCATED";
        locatedUnitId = hit?.unitId;
      }
    }
    const homeIds = ownUnitIds.size > 0 ? ownUnitIds : new Set(locatedUnitId !== undefined ? [locatedUnitId] : []);
    const absenceAssertion = ABSENCE.test(issue.description);
    const selfDeclaredContextGap = SELF_DECLARED_GAP.test(issue.description);
    // 缺失型断言的全文查找：描述 + 引文中的区分性术语在其他单元出现（只计在 ≤60% 单元中出现的术语）
    let documentLookup: FindingAuditRecord["documentLookup"] = { status: "NOT_APPLICABLE", terms: [], hits: [] };
    if (absenceAssertion) {
      const limit = Math.max(1, Math.ceil(input.units.length * 0.6));
      const terms = distinctiveTerms(`${issue.description} ${issue.quote ?? ""}`).filter((term) => termUnitFrequency(term) <= limit).slice(0, 12);
      if (terms.length === 0) {
        documentLookup = { status: "NO_DISTINCTIVE_TERMS", terms, hits: [] };
      } else {
        // 同一句共现（≥2 个术语；只有 1 个术语时该句含它即可）；摘要 / 引言 / 结论只复述全文、不作为「别处给出」的来源
        const need = Math.min(2, terms.length);
        const hits = input.units
          .filter((unit) => !homeIds.has(unit.unitId) && !SUMMARY_UNIT.test(unit.heading) && !/::frontmatter/.test(unit.unitId))
          .map((unit) => {
            const sentences = unit.text.normalize("NFKC").split(/(?<=[。；！？])|(?<=[.;!?])\s+|\n{2,}/);
            let best: { matched: string[]; sentence: string } = { matched: [], sentence: "" };
            for (const sentence of sentences) {
              const matched = terms.filter((term) => containsTerm(sentence, term));
              if (matched.length > best.matched.length) best = { matched, sentence };
            }
            return { unit, ...best };
          })
          .filter((entry) => entry.matched.length >= need)
          .sort((a, b) => b.matched.length - a.matched.length)
          .slice(0, 3)
          .map((entry) => ({ unitId: entry.unit.unitId, heading: entry.unit.heading, matched: entry.matched, excerpt: entry.sentence.replace(/\s+/g, " ").trim().slice(0, 320) }));
        documentLookup = { status: hits.length > 0 ? "ENTITIES_FOUND_ELSEWHERE" : "NO_EVIDENCE_ELSEWHERE", terms, hits };
      }
    }
    // 转写伪影
    const quoteText = issue.quote ?? "";
    const signals: string[] = [];
    if (transcription) {
      if (flattenedDisplayMath(quoteText)) signals.push("FORMULA_FLATTENED");
      for (const signal of transcriptionRiskSignals(quoteText)) signals.push(signal);
      if (conversion.some((excerpt) => compactText(quoteText).includes(excerpt.slice(0, 16)))) signals.push("FIDELITY_REPORT_EXCERPT");
    }
    const corruptionClaim = CORRUPTION_CLAIM.test(issue.description) || issue.category === "build";
    const parseSuspected = transcription && corruptionClaim && (signals.includes("FORMULA_FLATTENED") || signals.includes("REPLACEMENT_GLYPH") || signals.includes("FIDELITY_REPORT_EXCERPT") || (signals.includes("TABLE_CELLS") && issue.category !== "fact") || issue.category === "build");
    const parseRisk: FindingAuditRecord["parseRisk"] = !transcription
      ? { status: "NOT_APPLICABLE", signals: [], originalCheck: "NOT_NEEDED" }
      : parseSuspected
        ? { status: "PARSE_ARTIFACT_SUSPECTED", signals, originalCheck: signals.includes("FIDELITY_REPORT_EXCERPT") ? "FIDELITY_REPORT_FLAGGED" : input.pageProvenanceAvailable === true ? "FIDELITY_REPORT_FLAGGED" : "NOT_AVAILABLE" }
        : { status: "NO_SIGNAL", signals, originalCheck: "NOT_NEEDED" };
    const contextIncomplete = selfDeclaredContextGap || documentLookup.status === "ENTITIES_FOUND_ELSEWHERE";
    const auditStatus: FindingAuditStatus = parseRisk.status === "PARSE_ARTIFACT_SUSPECTED"
      ? "PARSE_ARTIFACT_SUSPECTED"
      : contextIncomplete
        ? "CONTEXT_INCOMPLETE"
        : quoteLocation === "NO_QUOTE"
          ? "NO_QUOTE"
          : quoteLocation === "NOT_LOCATED"
            ? "QUOTE_NOT_LOCATED"
            : "TEXT_LOCATED";
    const note = auditStatus === "PARSE_ARTIFACT_SUSPECTED"
      ? `来源 ${input.sourceVerification}：${signals.length > 0 ? `引文是转写稿上的${signals.join(" / ")}` : "build / 排版类 finding 的被审对象是转写投影（不是作者原稿）"}，finding 指称的损坏可能来自 PDF 转写；${parseRisk.originalCheck === "NOT_AVAILABLE" ? "项目没有页面级原件 provenance，无法回看原件——在回看原件前不得确认为作者错误" : "保真报告记录了该处转写疑点"}`
      : auditStatus === "CONTEXT_INCOMPLETE"
        ? selfDeclaredContextGap
          ? "审稿模型自声明需结合其他章节核对：单元视角的判断不构成全文结论"
          : `缺失型断言，但术语 ${documentLookup.hits[0]?.matched.join("、") ?? ""} 在其他单元（${documentLookup.hits.map((hit) => hit.heading).join("、")}）出现：「全文没有」不可由单元视角确立`
        : auditStatus === "QUOTE_NOT_LOCATED"
          ? "引文不能在被审修订中逐字定位"
          : auditStatus === "NO_QUOTE"
            ? "finding 没有可定位引文"
            : quoteLocation === "IN_DOCUMENT"
              ? "引文定位在其他单元（单元边界外）"
              : "引文在被审原文中逐字定位";
    return {
      findingId: findingIdOf(issue),
      issueIndex,
      unitId: mapped,
      file: issue.file ?? null,
      section: issue.section,
      category: issue.category,
      severityObserved: issue.severity,
      blockingObserved: issue.blocking,
      verificationDeclared: issue.verification ?? null,
      quoteLocation,
      ...(locatedUnitId !== undefined ? { locatedUnitId } : {}),
      absenceAssertion,
      selfDeclaredContextGap,
      documentLookup,
      parseRisk,
      auditStatus,
      eligibleForTextVerification: auditStatus === "TEXT_LOCATED",
      note,
    };
  });
  const empty = (): Record<FindingAuditStatus, number> => ({ TEXT_LOCATED: 0, CONTEXT_INCOMPLETE: 0, PARSE_ARTIFACT_SUSPECTED: 0, QUOTE_NOT_LOCATED: 0, NO_QUOTE: 0 });
  const byStatus = empty();
  const cmByStatus = empty();
  for (const record of records) {
    byStatus[record.auditStatus] += 1;
    if (record.severityObserved === "critical" || record.severityObserved === "major") cmByStatus[record.auditStatus] += 1;
  }
  return {
    records,
    summary: {
      version: FINDING_AUDIT_VERSION,
      total: records.length,
      byStatus,
      criticalMajor: { total: records.filter((record) => record.severityObserved === "critical" || record.severityObserved === "major").length, byStatus: cmByStatus },
      absenceAssertions: records.filter((record) => record.absenceAssertion).length,
      sourceVerification: input.sourceVerification,
      note: "shadow 诊断：不删除 finding、不改 severity / blocking、不进生产 Gate；CONTEXT_INCOMPLETE / PARSE_ARTIFACT_SUSPECTED 表示该 finding 不能只凭单元视角或转写稿确立",
    },
  };
}
