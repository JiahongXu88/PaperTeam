/**
 * M15.1 只读论文引用 / 参考文献审计（确定性，readOnlyCitationAudit 适配层；shadow）。
 *
 * 背景：已发表论文只读评估（published_paper_assessment）不执行 citation.verify——M15 校准 110 次 run 中
 * hallucinated_citations_zero / citation_structure_valid 恒为 NOT_EVALUATED。原因有两层，必须分开：
 *   1. 机制未执行：只读路径没有调用任何引用核验；
 *   2. 输入不支持：作者 LaTeX 的 thebibliography / PDF 转写稿的作者-年份引文都没有 .bib，StaticCitationChecker
 *      只认 \cite ↔ .bib——直接跑会把每条引用报成 missing（假 FAIL）。
 * 本模块不伪造 bib key、不改生产 citation.verify / Evidence 绑定硬门，单独产出 citation-audit 产物，四层分开报告：
 *   audit attempted → input adequate → reference matched → external metadata verified。
 * 「正文有引用标记」≠「来源已核验」；没有发现虚构 ≠ 引用真实性 PASS（authenticity 只在外部元数据核验后才有结论）。
 */

import { CITE_COMMAND_PATTERN, parseBib } from "./StaticCitationChecker.js";
import { parseReferenceFields, expandNumericList } from "../paper/ReferenceExtractor.js";
import type { MetadataVerificationResult } from "./metadataProviders.js";
import { lineOf, sha256Text } from "../review/claimAuditText.js";

export const READONLY_CITATION_AUDIT_SCHEMA = "paperteam.readonly-citation-audit/v1";

export type ReferenceListSource = "bib" | "thebibliography" | "plain_list" | "none";
export type CitationMentionStyle = "latex_key" | "numeric" | "author_year";

export interface AuditReferenceEntry {
  entryId: string;
  source: Exclude<ReferenceListSource, "none">;
  key?: string;
  number?: number;
  rawText: string;
  title?: string;
  firstAuthorSurname?: string;
  year?: number;
  yearLabel?: string;
  doi?: string;
  arxivId?: string;
  parseConfidence: "HIGH" | "MEDIUM" | "LOW";
  file: string | null;
  line: number | null;
}

export interface AuditCitationMention {
  mentionId: string;
  style: CitationMentionStyle;
  raw: string;
  file: string;
  line: number;
  labels: Array<{ label: string; status: "MATCHED" | "UNMATCHED" | "AMBIGUOUS" | "INVALID"; entryId?: string; candidates?: string[] }>;
}

export interface CitationAuditFinding {
  code:
    | "CITE_KEY_WITHOUT_ENTRY" | "NUMERIC_OUT_OF_RANGE" | "NUMERIC_WITHOUT_ENTRY" | "AUTHOR_YEAR_UNMATCHED" | "AUTHOR_YEAR_AMBIGUOUS"
    | "DUPLICATE_KEY" | "DUPLICATE_TITLE" | "DUPLICATE_DOI" | "NUMBERING_GAP" | "NUMBERING_DUPLICATE" | "UNCITED_ENTRY" | "EMPTY_CITE";
  /** structural = 可确定性确立的结构问题；needs_review = 解析局限下的疑点（作者-年份解析失败也会落这里）；warning = 不是错误 */
  severity: "structural" | "needs_review" | "warning";
  detail: string;
  file?: string;
  line?: number;
  entryId?: string;
}

export interface ReadOnlyCitationAudit {
  schema: typeof READONLY_CITATION_AUDIT_SCHEMA;
  generatedAt: string;
  round: number;
  sourceRevision: number | null;
  documentFingerprint: string;
  files: Array<{ file: string; sha256: string }>;
  evaluationPolicy: { reviewPurpose: string; productionGateImpact: "NONE_SHADOW"; productionCitationVerify: "UNCHANGED" };
  referenceList: { source: ReferenceListSource; entries: number; bibPath: string | null };
  mentionStyles: Record<CitationMentionStyle, number>;
  layers: {
    auditAttempted: { status: "ATTEMPTED"; detail: string };
    inputAdequacy: {
      status: "ADEQUATE" | "INSUFFICIENT_EVIDENCE";
      structureCheckable: boolean;
      metadataCheckable: boolean;
      parseConfidence: { high: number; medium: number; low: number };
      reasons: string[];
    };
    referenceMatching: {
      status: "EVALUATED" | "NOT_EVALUATED";
      mentions: number;
      labels: number;
      matched: number;
      unmatched: number;
      ambiguous: number;
      invalid: number;
      matchRate: number | null;
      entriesCited: number;
      entriesUncited: number;
      reason?: string;
    };
    externalMetadata: {
      status: "EVALUATED" | "PARTIAL" | "NOT_EVALUATED";
      reason: string;
      eligibleEntries: number;
      checked: number;
      verified: number;
      mismatch: number;
      notFound: number;
      unverifiable: number;
      providers: string[];
    };
  };
  verdict: {
    structure: "NO_STRUCTURAL_PROBLEM_FOUND" | "STRUCTURAL_PROBLEMS_FOUND" | "NOT_EVALUATED";
    authenticity: "NOT_EVALUATED" | "NO_FABRICATION_FOUND_IN_CHECKED_SUBSET" | "METADATA_PROBLEMS_FOUND";
    note: string;
  };
  findings: CitationAuditFinding[];
  entries: AuditReferenceEntry[];
  mentions: AuditCitationMention[];
  metadataResults: MetadataVerificationResult[];
}

export interface ReadOnlyCitationAuditInput {
  round: number;
  sourceRevision: number | null;
  documentFingerprint: string;
  reviewPurpose: string;
  files: ReadonlyArray<{ file: string; content: string }>;
  bibContent: string | null;
  bibPath: string | null;
  /** 已执行的外部元数据核验（undefined = 未执行；reason 说明原因） */
  metadata?: { results: MetadataVerificationResult[]; providers: string[]; eligible: number } | { notEvaluatedReason: string };
  now?: () => Date;
}

const THEBIBLIOGRAPHY = /\\begin\{thebibliography\}(?:\{[^{}]*\})?([\s\S]*?)\\end\{thebibliography\}/g;
const PLAIN_HEADING = /^[ \t]*(?:\\(?:sub)*section\*?\{\s*)?(?:\d+\s*)?(?:References|REFERENCES|Bibliography|参考文献)\s*\}?[ \t]*$/m;

/** LaTeX 条目文本 → 可读文本（去命令外壳、花括号、转义） */
function plainify(text: string): string {
  return text
    .replace(/\\(?:it|bf|em|sc|rm|tt)\b\s*/g, "")
    .replace(/\\(?:textit|textbf|emph|textsc|textrm|url|href)\*?\{([^{}]*)\}/g, "$1")
    .replace(/\\newblock\s*/g, " ")
    .replace(/\\[&%_#$]/g, (match) => match.slice(1))
    .replace(/[{}]/g, "")
    .replace(/~/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function surnameOf(authorSegment: string | undefined): string | undefined {
  if (authorSegment === undefined) return undefined;
  const first = authorSegment.split(/,|\band\b|&|，|、/)[0]?.trim() ?? "";
  if (first === "") return undefined;
  if (/^[一-龥]{2,4}$/.test(first)) return first;
  const tokens = first.split(/\s+/).filter((token) => token !== "");
  if (tokens.length === 0) return undefined;
  const initials = (token: string) => /^(?:[A-Z]\.?-?){1,3}$/.test(token);
  // 「Brazil G」「Liu X M」：姓在前、缩写在后；「Dzmitry Bahdanau」「A Cowey」：姓在最后
  if (tokens.length >= 2 && tokens.slice(1).every(initials) && !initials(tokens[0]!)) return tokens[0]!.replace(/[.,]/g, "");
  return tokens[tokens.length - 1]!.replace(/[.,]/g, "");
}

function makeEntry(source: AuditReferenceEntry["source"], index: number, raw: string, extra: Partial<AuditReferenceEntry>): AuditReferenceEntry {
  // 转写稿的 DOI 常被空格打散（「10.1109 / CVPR. 2019. 00662」）：先拼回再解析，否则只剩前缀 10.1109 → 假重复
  const text = plainify(raw)
    .replace(/(10\.\d{4,9})\s*\/\s*/g, "$1/")
    .replace(/[\[［]\s*DOI\s*[:：]\s*([^\]］]+)[\]］]/gi, (_match, doi: string) => `[DOI: ${doi.replace(/\s+/g, "")}]`)
    .slice(0, 800);
  const fields = parseReferenceFields(text);
  // 作者段 = 首个「. 年份」之前（GB/T / 本刊作者-年份体例「Badrinarayanan V， Kendall A and Cipolla R. 2017. 标题」）；否则首个句点之前
  const lead = /^(.*?)[.．]\s*((?:19|20)\d{2}[a-z]?)\s*[.．]/.exec(text);
  const authorSegment = lead?.[1] ?? /^(.*?[a-zÀ-ɏ]{2})[.．]\s/.exec(text)?.[1] ?? text.split(/[.．]/)[0];
  const yearLabel = lead?.[2] ?? /\b((?:19|20)\d{2}[a-z]?)\b/.exec(text)?.[1];
  const year = lead !== null ? Number(lead[2]!.slice(0, 4)) : fields.year;
  const parseConfidence: AuditReferenceEntry["parseConfidence"] = extra.title !== undefined || (fields.title !== undefined && year !== undefined)
    ? (fields.doi !== undefined || source === "bib" ? "HIGH" : "MEDIUM")
    : year !== undefined && authorSegment !== undefined ? "MEDIUM" : "LOW";
  const surname = surnameOf(authorSegment);
  return {
    entryId: `R${String(index + 1).padStart(3, "0")}`,
    source,
    rawText: text.slice(0, 600),
    ...(fields.title !== undefined ? { title: fields.title } : {}),
    ...(surname !== undefined ? { firstAuthorSurname: surname } : {}),
    ...(year !== undefined ? { year } : {}),
    ...(yearLabel !== undefined ? { yearLabel } : {}),
    ...(fields.doi !== undefined && /^10\.\d{4,9}\/\S{3,}/.test(fields.doi) ? { doi: fields.doi.replace(/[\]］]+$/, "") } : {}),
    ...(fields.arxivId !== undefined ? { arxivId: fields.arxivId } : {}),
    parseConfidence,
    file: null,
    line: null,
    ...extra,
  };
}

function extractReferenceList(input: ReadOnlyCitationAuditInput): { source: ReferenceListSource; entries: AuditReferenceEntry[]; regions: Array<{ file: string; start: number; end: number }> } {
  if (input.bibContent !== null && input.bibContent.trim() !== "") {
    const bib = parseBib(input.bibContent);
    const entries = bib.entries.map((entry, index) => makeEntry("bib", index, `${entry.title ?? ""}. ${entry.year ?? ""}`, {
      key: entry.key,
      ...(entry.title !== undefined ? { title: entry.title } : {}),
      ...(entry.year !== undefined ? { year: entry.year } : {}),
      ...(entry.doi !== undefined ? { doi: entry.doi.toLowerCase() } : {}),
      parseConfidence: entry.title !== undefined ? "HIGH" : "LOW",
      file: input.bibPath,
    }));
    for (const key of bib.duplicateKeys) entries.push(makeEntry("bib", entries.length, "", { key, parseConfidence: "LOW", file: input.bibPath }));
    return { source: "bib", entries, regions: [] };
  }
  const entries: AuditReferenceEntry[] = [];
  const regions: Array<{ file: string; start: number; end: number }> = [];
  for (const file of input.files) {
    for (const env of file.content.matchAll(THEBIBLIOGRAPHY)) {
      regions.push({ file: file.file, start: env.index!, end: env.index! + env[0].length });
      const body = env[1] ?? "";
      const bodyStart = env.index! + env[0].indexOf(body);
      const items = [...body.matchAll(/\\bibitem(?:\[[^\]]*\])?\{([^{}]+)\}/g)];
      items.forEach((item, position) => {
        const start = item.index! + item[0].length;
        const end = position + 1 < items.length ? items[position + 1]!.index! : body.length;
        entries.push(makeEntry("thebibliography", entries.length, body.slice(start, end), {
          key: item[1]!.trim(),
          number: position + 1,
          file: file.file,
          line: lineOf(file.content, bodyStart + item.index!),
        }));
      });
    }
  }
  if (entries.length > 0) return { source: "thebibliography", entries, regions };
  for (const file of input.files) {
    const heading = PLAIN_HEADING.exec(file.content);
    if (heading === null) continue;
    const start = heading.index;
    regions.push({ file: file.file, start, end: file.content.length });
    const tail = file.content.slice(start + heading[0].length);
    const tailStart = start + heading[0].length;
    const heads = [...tail.matchAll(/^[ \t]*(?:\[(\d{1,3})\]|(\d{1,3})\.)\s+(?=\S)/gm)];
    heads.forEach((head, position) => {
      const from = head.index! + head[0].length;
      const to = position + 1 < heads.length ? heads[position + 1]!.index! : Math.min(tail.length, from + 1200);
      entries.push(makeEntry("plain_list", entries.length, tail.slice(from, to), {
        number: Number(head[1] ?? head[2]),
        file: file.file,
        line: lineOf(file.content, tailStart + head.index!),
      }));
    });
  }
  return { source: entries.length > 0 ? "plain_list" : "none", entries, regions };
}

/** 正文（去注释、去参考文献区）；数学环境替换为等长空白，避免 [0,1] 之类区间被当成引文 */
function bodyOf(file: { file: string; content: string }, regions: ReadonlyArray<{ file: string; start: number; end: number }>, maskMath: boolean): string {
  let text = file.content;
  for (const region of regions.filter((entry) => entry.file === file.file)) {
    text = text.slice(0, region.start) + " ".repeat(region.end - region.start) + text.slice(region.end);
  }
  text = text.replace(/(?<!\\)%.*$/gm, (match) => " ".repeat(match.length));
  if (maskMath) {
    text = text.replace(/\\\[[\s\S]*?\\\]|\$\$[\s\S]*?\$\$|(?<!\\)\$[^$\n]*\$|\\\([\s\S]*?\\\)|\\begin\{(equation|align|gather|multline)\*?\}[\s\S]*?\\end\{\1\*?\}/g, (match) => match.replace(/[^\n]/g, " "));
  }
  return text;
}

const AUTHOR_YEAR_PART = /^\s*(?:see\s+|e\.g\.,?\s+|如\s*)?([A-Z][A-Za-z'’\-]+|[一-龥]{1,4}?)(?:\s*(?:等人?|et\s+al\.?|和\s*[A-Z一-龥][A-Za-z'’\-一-龥]*|and\s+[A-Z][A-Za-z'’\-]+|&\s*[A-Z][A-Za-z'’\-]+))?\s*[,，]\s*((?:19|20)\d{2}[a-z]?)\s*$/;
const NARRATIVE = /([A-Z][A-Za-z'’\-]+)(?:\s+(?:and|&)\s+[A-Z][A-Za-z'’\-]+)?(?:\s*(?:等人?|et\s+al\.?))?\s*[（(]\s*((?:19|20)\d{2}[a-z]?)\s*[)）]/g;

export function buildReadOnlyCitationAudit(input: ReadOnlyCitationAuditInput): ReadOnlyCitationAudit {
  const list = extractReferenceList(input);
  const entries = list.entries;
  const mentions: AuditCitationMention[] = [];
  const findings: CitationAuditFinding[] = [];
  const byKey = new Map<string, AuditReferenceEntry[]>();
  for (const entry of entries) if (entry.key !== undefined) byKey.set(entry.key, [...(byKey.get(entry.key) ?? []), entry]);
  const byNumber = new Map<number, AuditReferenceEntry[]>();
  for (const entry of entries) if (entry.number !== undefined) byNumber.set(entry.number, [...(byNumber.get(entry.number) ?? []), entry]);
  const maxNumber = Math.max(0, ...entries.map((entry) => entry.number ?? 0));
  const cited = new Set<string>();
  const push = (style: CitationMentionStyle, raw: string, file: string, content: string, offset: number, labels: AuditCitationMention["labels"]): void => {
    for (const label of labels) if (label.entryId !== undefined) cited.add(label.entryId);
    mentions.push({ mentionId: `M${String(mentions.length + 1).padStart(4, "0")}`, style, raw: raw.slice(0, 160), file, line: lineOf(content, offset), labels });
  };
  let latexMentions = 0;
  for (const file of input.files) {
    const body = bodyOf(file, list.regions, false);
    for (const match of body.matchAll(new RegExp(CITE_COMMAND_PATTERN.source, "g"))) {
      latexMentions += 1;
      const keys = (match[1] ?? "").split(",").map((key) => key.trim());
      if (keys.every((key) => key === "")) {
        findings.push({ code: "EMPTY_CITE", severity: "structural", detail: `空引用 ${match[0].slice(0, 40)}`, file: file.file, line: lineOf(file.content, match.index!) });
        continue;
      }
      push("latex_key", match[0], file.file, file.content, match.index!, keys.filter((key) => key !== "").map((key) => {
        const hit = byKey.get(key);
        return hit === undefined || hit.length === 0 ? { label: key, status: "UNMATCHED" as const } : { label: key, status: "MATCHED" as const, entryId: hit[0]!.entryId };
      }));
    }
  }
  if (latexMentions === 0 && entries.length > 0) {
    for (const file of input.files) {
      const body = bodyOf(file, list.regions, true);
      if (list.source !== "bib" && entries.some((entry) => entry.number !== undefined)) {
        for (const match of body.matchAll(/\[(\d{1,3}(?:\s*[,，–-]\s*\d{1,3})*)\]/g)) {
          const numbers = expandNumericList((match[1] ?? "").replace(/，/g, ","));
          if (numbers.length === 0) continue;
          push("numeric", match[0], file.file, file.content, match.index!, numbers.map((number) => {
            const hit = byNumber.get(number);
            if (hit !== undefined && hit.length > 0) return { label: String(number), status: "MATCHED" as const, entryId: hit[0]!.entryId };
            return { label: String(number), status: maxNumber > 0 && number > maxNumber ? "INVALID" as const : "UNMATCHED" as const };
          }));
        }
      }
      const resolveAuthorYear = (surname: string, yearLabel: string): AuditCitationMention["labels"][number] => {
        const year = Number(yearLabel.slice(0, 4));
        const suffix = yearLabel.slice(4);
        const candidates = entries.filter((entry) => {
          const own = entry.firstAuthorSurname?.toLowerCase();
          if (own === undefined || entry.year === undefined) return false;
          const yearOk = entry.year === year || entry.yearLabel?.slice(0, 4) === String(year);
          return yearOk && (own === surname.toLowerCase() || own.startsWith(surname.toLowerCase()) || surname.toLowerCase().startsWith(own));
        });
        const narrowed = suffix === "" ? candidates : candidates.filter((entry) => entry.yearLabel === yearLabel);
        const label = `${surname}, ${yearLabel}`;
        if (narrowed.length === 1) return { label, status: "MATCHED", entryId: narrowed[0]!.entryId };
        if (narrowed.length > 1) return { label, status: "AMBIGUOUS", candidates: narrowed.map((entry) => entry.entryId) };
        return { label, status: "UNMATCHED" };
      };
      for (const group of body.matchAll(/[（(]([^()（）]{3,240})[)）]/g)) {
        const parts = (group[1] ?? "").split(/[;；]/);
        const labels = parts.map((part) => AUTHOR_YEAR_PART.exec(part)).filter((match): match is RegExpExecArray => match !== null)
          .map((match) => resolveAuthorYear(match[1]!, match[2]!));
        if (labels.length > 0) push("author_year", group[0], file.file, file.content, group.index!, labels);
      }
      for (const match of body.matchAll(NARRATIVE)) {
        push("author_year", match[0], file.file, file.content, match.index!, [resolveAuthorYear(match[1]!, match[2]!)]);
      }
    }
  }
  // 结构问题（没有参考文献列表时不逐条报「无对应条目」：那是输入不足，不是引用错误）
  for (const mention of list.source === "none" ? [] : mentions) {
    for (const label of mention.labels) {
      if (label.status === "UNMATCHED") {
        findings.push({
          code: mention.style === "latex_key" ? "CITE_KEY_WITHOUT_ENTRY" : mention.style === "numeric" ? "NUMERIC_WITHOUT_ENTRY" : "AUTHOR_YEAR_UNMATCHED",
          // 只有 \cite key 对照是确定性的；[n] / 作者-年份只在没有 \cite 的转写稿上扫描，可能是解析局限
          severity: mention.style === "latex_key" ? "structural" : "needs_review",
          detail: `${mention.raw} → ${label.label} 无对应参考文献条目${mention.style === "author_year" ? "（作者-年份解析可能失败，需人工核对）" : ""}`,
          file: mention.file, line: mention.line,
        });
      } else if (label.status === "INVALID") {
        findings.push({ code: "NUMERIC_OUT_OF_RANGE", severity: "needs_review", detail: `${mention.raw} → ${label.label} 超出参考文献编号上限 ${maxNumber}`, file: mention.file, line: mention.line });
      } else if (label.status === "AMBIGUOUS") {
        findings.push({ code: "AUTHOR_YEAR_AMBIGUOUS", severity: "needs_review", detail: `${mention.raw} → ${label.label} 对应多个条目（${(label.candidates ?? []).join("、")}）`, file: mention.file, line: mention.line });
      }
    }
  }
  const seenKeys = new Set<string>();
  for (const entry of entries) {
    if (entry.key === undefined) continue;
    if (seenKeys.has(entry.key)) findings.push({ code: "DUPLICATE_KEY", severity: "structural", detail: `条目 key ${entry.key} 重复定义`, entryId: entry.entryId });
    seenKeys.add(entry.key);
  }
  const titleKey = (title: string) => title.toLowerCase().replace(/[^a-z0-9一-龥]/g, "");
  const titles = new Map<string, string>();
  const dois = new Map<string, string>();
  for (const entry of entries) {
    if (entry.title !== undefined && titleKey(entry.title).length >= 15) {
      const key = titleKey(entry.title);
      if (titles.has(key)) findings.push({ code: "DUPLICATE_TITLE", severity: "needs_review", detail: `条目 ${titles.get(key)} 与 ${entry.entryId} 标题相同（「${entry.title.slice(0, 80)}」）`, entryId: entry.entryId });
      else titles.set(key, entry.entryId);
    }
    if (entry.doi !== undefined) {
      const key = entry.doi.replace(/\s+/g, "").toLowerCase();
      if (dois.has(key)) findings.push({ code: "DUPLICATE_DOI", severity: "structural", detail: `条目 ${dois.get(key)} 与 ${entry.entryId} DOI 相同（${key}）`, entryId: entry.entryId });
      else dois.set(key, entry.entryId);
    }
  }
  if (list.source === "plain_list") {
    const numbers = entries.map((entry) => entry.number ?? 0);
    const seen = new Set<number>();
    for (const number of numbers) {
      if (seen.has(number)) findings.push({ code: "NUMBERING_DUPLICATE", severity: "structural", detail: `参考文献编号 [${number}] 重复` });
      seen.add(number);
    }
    for (let number = 1; number <= maxNumber; number += 1) {
      if (!seen.has(number)) findings.push({ code: "NUMBERING_GAP", severity: "needs_review", detail: `参考文献编号缺 [${number}]（可能是转写丢失）` });
    }
  }
  const labelsAll = mentions.flatMap((mention) => mention.labels);
  const uncited = mentions.length === 0 ? [] : entries.filter((entry) => !cited.has(entry.entryId));
  for (const entry of uncited.slice(0, 40)) findings.push({ code: "UNCITED_ENTRY", severity: "warning", detail: `条目 ${entry.entryId}${entry.key !== undefined ? `（${entry.key}）` : ""} 正文未识别到引用（引用解析局限也会造成）`, entryId: entry.entryId });
  const confidence = { high: entries.filter((entry) => entry.parseConfidence === "HIGH").length, medium: entries.filter((entry) => entry.parseConfidence === "MEDIUM").length, low: entries.filter((entry) => entry.parseConfidence === "LOW").length };
  const reasons: string[] = [];
  if (list.source === "none") reasons.push("未识别到参考文献列表（无 .bib / thebibliography / References 章节；PDF 缺失参考文献或解析失败）");
  if (mentions.length === 0) reasons.push("未识别到正文引用标记（\\cite / [n] / 作者-年份）");
  const structureCheckable = list.source !== "none" && mentions.length > 0;
  const metadataCheckable = entries.length > 0 && entries.filter((entry) => entry.doi !== undefined || entry.title !== undefined).length / entries.length >= 0.5;
  if (entries.length > 0 && !metadataCheckable) reasons.push("过半条目解析不出标题 / DOI：外部元数据核验不可行");
  const metadata = input.metadata;
  let externalMetadata: ReadOnlyCitationAudit["layers"]["externalMetadata"];
  let metadataResults: MetadataVerificationResult[] = [];
  if (metadata === undefined || "notEvaluatedReason" in metadata) {
    externalMetadata = {
      status: "NOT_EVALUATED",
      reason: metadata === undefined ? "未执行外部元数据核验" : metadata.notEvaluatedReason,
      eligibleEntries: entries.filter((entry) => entry.doi !== undefined || entry.title !== undefined).length,
      checked: 0, verified: 0, mismatch: 0, notFound: 0, unverifiable: 0, providers: [],
    };
  } else {
    metadataResults = metadata.results;
    const count = (status: MetadataVerificationResult["status"]) => metadata.results.filter((result) => result.status === status).length;
    externalMetadata = {
      status: metadata.results.length === 0 ? "NOT_EVALUATED" : metadata.results.length < metadata.eligible ? "PARTIAL" : "EVALUATED",
      reason: metadata.results.length === 0 ? "没有可查询的条目" : `核验 ${metadata.results.length}/${metadata.eligible} 条（有界上限）`,
      eligibleEntries: metadata.eligible,
      checked: metadata.results.length,
      verified: count("verified"),
      mismatch: count("mismatch"),
      notFound: count("not_found"),
      unverifiable: count("unverifiable"),
      providers: metadata.providers,
    };
  }
  const structural = findings.filter((finding) => finding.severity === "structural");
  return {
    schema: READONLY_CITATION_AUDIT_SCHEMA,
    generatedAt: (input.now ?? (() => new Date()))().toISOString(),
    round: input.round,
    sourceRevision: input.sourceRevision,
    documentFingerprint: input.documentFingerprint,
    files: input.files.map((file) => ({ file: file.file, sha256: sha256Text(file.content) })),
    evaluationPolicy: { reviewPurpose: input.reviewPurpose, productionGateImpact: "NONE_SHADOW", productionCitationVerify: "UNCHANGED" },
    referenceList: { source: list.source, entries: entries.length, bibPath: input.bibPath },
    mentionStyles: {
      latex_key: mentions.filter((mention) => mention.style === "latex_key").length,
      numeric: mentions.filter((mention) => mention.style === "numeric").length,
      author_year: mentions.filter((mention) => mention.style === "author_year").length,
    },
    layers: {
      auditAttempted: { status: "ATTEMPTED", detail: `扫描 ${input.files.length} 个文件；参考文献来源 ${list.source}` },
      inputAdequacy: { status: structureCheckable ? "ADEQUATE" : "INSUFFICIENT_EVIDENCE", structureCheckable, metadataCheckable, parseConfidence: confidence, reasons },
      referenceMatching: structureCheckable
        ? {
            status: "EVALUATED",
            mentions: mentions.length,
            labels: labelsAll.length,
            matched: labelsAll.filter((label) => label.status === "MATCHED").length,
            unmatched: labelsAll.filter((label) => label.status === "UNMATCHED").length,
            ambiguous: labelsAll.filter((label) => label.status === "AMBIGUOUS").length,
            invalid: labelsAll.filter((label) => label.status === "INVALID").length,
            matchRate: labelsAll.length === 0 ? null : labelsAll.filter((label) => label.status === "MATCHED").length / labelsAll.length,
            entriesCited: cited.size,
            entriesUncited: uncited.length,
          }
        : { status: "NOT_EVALUATED", mentions: mentions.length, labels: labelsAll.length, matched: 0, unmatched: 0, ambiguous: 0, invalid: 0, matchRate: null, entriesCited: 0, entriesUncited: 0, reason: reasons.join("；") },
      externalMetadata,
    },
    verdict: {
      structure: !structureCheckable ? "NOT_EVALUATED" : structural.length > 0 ? "STRUCTURAL_PROBLEMS_FOUND" : "NO_STRUCTURAL_PROBLEM_FOUND",
      authenticity: externalMetadata.status === "NOT_EVALUATED"
        ? "NOT_EVALUATED"
        : externalMetadata.mismatch + externalMetadata.notFound > 0 ? "METADATA_PROBLEMS_FOUND" : "NO_FABRICATION_FOUND_IN_CHECKED_SUBSET",
      note: "结构核对只说明正文引用与文后条目能否对应；没有外部权威元数据核验时引用真实性一律 NOT_EVALUATED——「没有发现虚构」不推导引用真实",
    },
    findings,
    entries,
    mentions: mentions.slice(0, 400),
    metadataResults,
  };
}

/** 紧凑摘要（只读视图 / 影子决策 / stage result） */
export function summarizeCitationAudit(audit: ReadOnlyCitationAudit) {
  return {
    schema: audit.schema,
    referenceList: audit.referenceList,
    mentionStyles: audit.mentionStyles,
    attempted: audit.layers.auditAttempted.status,
    inputAdequacy: audit.layers.inputAdequacy.status,
    referenceMatching: { status: audit.layers.referenceMatching.status, matchRate: audit.layers.referenceMatching.matchRate, matched: audit.layers.referenceMatching.matched, labels: audit.layers.referenceMatching.labels },
    externalMetadata: { status: audit.layers.externalMetadata.status, checked: audit.layers.externalMetadata.checked, verified: audit.layers.externalMetadata.verified, reason: audit.layers.externalMetadata.reason },
    verdict: audit.verdict,
    structuralFindings: audit.findings.filter((finding) => finding.severity === "structural").length,
    needsReviewFindings: audit.findings.filter((finding) => finding.severity === "needs_review").length,
  };
}


/**
 * M15.1：PDF Quick Review（existing_paper_review）的引用核验四层摘要——同一套层级口径，数据来自 PDF 路径既有的
 * references / callouts / metadata 记录（不重跑、不改其判定）。metadata 只有 VERIFIED / MISMATCH / NOT_FOUND 是结论；
 * PROVIDER_ERROR / UNRESOLVED / AMBIGUOUS 是「未能核验」。
 */
export function summarizePdfCitationLayers(input: {
  references: ReadonlyArray<{ referenceId: string; title?: string; doi?: string }>;
  callouts: ReadonlyArray<{ references: ReadonlyArray<{ status: "resolved" | "unresolved" | "invalid" }> }>;
  metadataByStatus: Partial<Record<"VERIFIED" | "METADATA_MISMATCH" | "AMBIGUOUS" | "NOT_FOUND" | "PROVIDER_ERROR" | "UNRESOLVED", number>>;
}) {
  const relations = input.callouts.flatMap((callout) => callout.references);
  const count = (key: keyof typeof input.metadataByStatus) => input.metadataByStatus[key] ?? 0;
  const checked = Object.values(input.metadataByStatus).reduce((sum, value) => sum + (value ?? 0), 0);
  const decisive = count("VERIFIED") + count("METADATA_MISMATCH") + count("NOT_FOUND");
  const structureCheckable = input.references.length > 0 && input.callouts.length > 0;
  return {
    schema: "paperteam.citation-audit-layers/v1",
    auditAttempted: "ATTEMPTED" as const,
    inputAdequacy: structureCheckable ? "ADEQUATE" as const : "INSUFFICIENT_EVIDENCE" as const,
    referenceMatching: {
      status: structureCheckable ? "EVALUATED" as const : "NOT_EVALUATED" as const,
      labels: relations.length,
      matched: relations.filter((relation) => relation.status === "resolved").length,
      unmatched: relations.filter((relation) => relation.status === "unresolved").length,
      invalid: relations.filter((relation) => relation.status === "invalid").length,
    },
    externalMetadata: {
      status: checked === 0 ? "NOT_EVALUATED" as const : decisive < input.references.length ? "PARTIAL" as const : "EVALUATED" as const,
      checked,
      verified: count("VERIFIED"),
      mismatch: count("METADATA_MISMATCH"),
      notFound: count("NOT_FOUND"),
      undetermined: count("PROVIDER_ERROR") + count("UNRESOLVED") + count("AMBIGUOUS"),
    },
    note: "引用标记存在 ≠ 来源已核验；未取得权威元数据结论的条目不计入真实性结论",
  };
}
