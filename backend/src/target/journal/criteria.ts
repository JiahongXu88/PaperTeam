/**
 * Journal profile 规则 × 稿件观测 → 逐条 criterion（零模型、纯函数）。
 *
 * 状态口径（A 块）：SATISFIED / VIOLATED / NOT_EVALUATED / NOT_APPLICABLE。
 * - advisory 规则从不给 SATISFIED / VIOLATED（主观要求不伪装成确定性条件）→ NOT_EVALUATED，
 *   evidenceLevel=unassessed，交给 B 块模型意见；
 * - evidence_based 规则只在「稿件内观测足以证明不符」时 VIOLATED（例如检测到人类受试者措辞但
 *   无任何伦理审批措辞仍只给 author-check，不判 VIOLATED——措辞缺失不等于未审批）；
 * - 来源原句已不在官方页面（SOURCE_CHANGED）的规则 → NOT_EVALUATED（不按旧规则判）。
 */
import { evaluateCompliance } from "../TargetGuidelineService.js";
import type { GuidelineField, VenueGuidelineArtifact } from "../guidelineTypes.js";
import type { JournalFacts } from "./journalFacts.js";
import type { JournalArticleType, JournalProfile, JournalProfileVerification, JournalRule } from "./profileTypes.js";

export type CriterionStatus = "SATISFIED" | "VIOLATED" | "NOT_EVALUATED" | "NOT_APPLICABLE";
export type EvidenceLevel = "verified" | "author-check" | "model-opinion" | "unassessed";

export interface JournalCriterion {
  criterionId: string;
  ruleId: string;
  category: "submission_requirement" | "article_type" | "scope";
  kind: JournalRule["kind"] | "article_type";
  title: string;
  status: CriterionStatus;
  /** VIOLATED 时是否阻断（官方措辞强度；advisory / 建议级 = false） */
  blocking: boolean;
  evidenceLevel: EvidenceLevel;
  observed: string;
  expected: string;
  why: string;
  /** 稿件定位（LaTeX 文件 / 环境；PDF 无法定位时如实说明） */
  location: string;
  officialQuote: string;
  sourceUrl: string;
  sourceStatus: "QUOTE_VERIFIED_LIVE" | "SNAPSHOT" | "QUOTE_NOT_FOUND" | "UNVERIFIED";
  reliability: "high" | "medium";
  suggestion: string;
  actionability: JournalRule["actionability"];
  /** 可转入受控修订（rewrite + VIOLATED） */
  convertible: boolean;
  requiresAuthorDecision: boolean;
  /** NOT_EVALUATED 的具体缺口（缺什么输入、怎么补） */
  gap?: string;
}

const LEGACY_FIELD: Partial<Record<NonNullable<JournalRule["checker"]>, GuidelineField>> = {
  "references.count": "references.count",
  "references.recent10yRatio": "references.recent10yRatio",
  "references.doiCoverage": "references.doiCoverage",
};

export function evaluateProfileRules(
  profile: JournalProfile,
  facts: JournalFacts,
  articleType: JournalArticleType,
  verification: JournalProfileVerification | null,
  now: Date,
): JournalCriterion[] {
  const quoteFound = new Map((verification?.rulesVersion === profile.rulesVersion ? verification.quotes : []).map((quote) => [quote.ref, quote.found]));
  const sourceStatusOf = (ref: string): JournalCriterion["sourceStatus"] => {
    if (profile.source.origin === "user_provided" && !quoteFound.has(ref)) return "UNVERIFIED";
    const found = quoteFound.get(ref);
    return found === true ? "QUOTE_VERIFIED_LIVE" : found === false ? "QUOTE_NOT_FOUND" : "SNAPSHOT";
  };

  const criteria: JournalCriterion[] = [];
  // C 块的确定性部分：稿型是否被该刊接受（官方明文）
  const support = profile.articleTypes.find((item) => item.type === articleType);
  const typeSource = sourceStatusOf(`articleType:${articleType}`);
  criteria.push({
    criterionId: `article-type:${articleType}`,
    ruleId: `article-type:${articleType}`,
    category: "article_type",
    kind: "article_type",
    title: "稿型是否在期刊受理范围",
    status: support === undefined || support.accepted === null || typeSource === "QUOTE_NOT_FOUND" ? "NOT_EVALUATED" : support.accepted ? "SATISFIED" : "VIOLATED",
    blocking: true,
    evidenceLevel: support === undefined || support.accepted === null ? "unassessed" : "verified",
    observed: `声明稿型：${articleType}`,
    expected: support !== undefined ? `官方稿型：${support.labelOfficial}` : "官方页面未列出该稿型",
    why: support?.note ?? (support?.accepted === false ? "官方明文不受理该稿型" : "稿型与期刊栏目对应关系"),
    location: "项目设置（稿型由用户声明）",
    officialQuote: support?.officialQuote ?? "",
    sourceUrl: support?.sourceUrl ?? profile.scope.sourceUrl,
    sourceStatus: typeSource,
    reliability: "high",
    suggestion: support?.accepted === false ? "该稿型不在期刊受理范围：改投其他期刊，或确认是否属于期刊接受的其他稿型（如系统综述）。" : support?.accepted === null || support === undefined ? "官方页面未写明是否受理该稿型——请向编辑部确认。" : "无",
    actionability: "none",
    convertible: false,
    requiresAuthorDecision: support?.accepted !== true,
    ...(support === undefined || support.accepted === null ? { gap: "官方页面未写明该稿型；需编辑部确认（系统不推断）" } : {}),
  });

  for (const rule of profile.rules) {
    const sourceStatus = sourceStatusOf(`rule:${rule.id}`);
    const base = {
      criterionId: `rule:${rule.id}`,
      ruleId: rule.id,
      category: "submission_requirement" as const,
      kind: rule.kind,
      title: rule.title,
      blocking: rule.blocking,
      officialQuote: rule.officialQuote,
      sourceUrl: rule.sourceUrl,
      sourceStatus,
      reliability: rule.reliability,
      suggestion: rule.suggestion,
      actionability: rule.actionability,
      expected: describeExpected(rule),
    };
    if (rule.appliesToArticleTypes !== undefined && !rule.appliesToArticleTypes.includes(articleType)) {
      criteria.push({ ...base, status: "NOT_APPLICABLE", evidenceLevel: "verified", observed: "—", why: `仅适用于：${rule.appliesToArticleTypes.join(" / ")}`, location: "—", convertible: false, requiresAuthorDecision: false });
      continue;
    }
    if (sourceStatus === "QUOTE_NOT_FOUND") {
      criteria.push({ ...base, status: "NOT_EVALUATED", evidenceLevel: "unassessed", observed: "—", why: "官方页面已不含该规则原句：不再按旧规则判定", location: "—", convertible: false, requiresAuthorDecision: false, gap: "规则来源已变化，需维护者按新页面重新提取" });
      continue;
    }
    if (rule.kind === "advisory" || rule.kind === "unknown" || rule.checker === undefined) {
      criteria.push({
        ...base,
        status: "NOT_EVALUATED",
        evidenceLevel: rule.kind === "evidence_based" ? "author-check" : "unassessed",
        observed: rule.kind === "advisory" ? "（主观要求：不做确定性判定）" : "（系统无该要求的检查器）",
        why: rule.kind === "advisory" ? "主观学术质量要求，只能由模型意见 / 专家判断辅助（见 B 块）" : rule.kind === "evidence_based" ? "需要系统未读取的材料（编译版式 / 图像 / 投稿系统字段），由作者对照官方要求确认" : "系统暂无该要求的检查器",
        location: "全文",
        convertible: false,
        requiresAuthorDecision: rule.kind !== "advisory",
        gap: rule.kind === "advisory" ? "可在 B 块运行模型意见（未校准，不构成判定）" : `需要：${rule.requiredInputs.join("、")}；${rule.suggestion}`,
      });
      continue;
    }
    criteria.push({ ...base, ...checkRule(rule, facts, now) });
  }
  return criteria;
}

type CheckOutcome = Pick<JournalCriterion, "status" | "evidenceLevel" | "observed" | "why" | "location" | "convertible" | "requiresAuthorDecision"> & { gap?: string };

function notEvaluated(observed: string, gap: string, location = "—"): CheckOutcome {
  return { status: "NOT_EVALUATED", evidenceLevel: "unassessed", observed, why: "缺少可确定性观测的稿件输入", location, convertible: false, requiresAuthorDecision: false, gap };
}

function decided(rule: JournalRule, ok: boolean, observed: string, location: string, why = ""): CheckOutcome {
  return {
    status: ok ? "SATISFIED" : "VIOLATED",
    evidenceLevel: rule.kind === "hard_deterministic" ? "verified" : "author-check",
    observed,
    why: why || (ok ? "稿件观测满足官方明文要求" : rule.blocking ? "稿件观测违反官方明文要求" : "稿件观测不符合官方建议级要求"),
    location,
    convertible: !ok && rule.actionability === "rewrite",
    requiresAuthorDecision: !ok && rule.actionability !== "rewrite",
  };
}

function checkRule(rule: JournalRule, facts: JournalFacts, now: Date): CheckOutcome {
  const g = facts.guideline;
  const legacy = LEGACY_FIELD[rule.checker!];
  if (legacy !== undefined) {
    const artifact: VenueGuidelineArtifact = {
      schemaVersion: 1,
      venueId: "journal-assessment",
      displayName: "journal-assessment",
      identity: {},
      scope: {},
      requirements: [
        {
          id: rule.id,
          field: legacy,
          operator: legacy === "references.count" ? "min" : legacy === "references.recent10yRatio" ? "ratio_min" : "presence_all",
          ...(rule.params?.value !== undefined ? { value: rule.params.value } : {}),
          hard: rule.blocking,
          officialQuote: rule.officialQuote,
          sourceUrl: rule.sourceUrl,
          confidence: rule.reliability,
        },
      ],
      provenance: { sourceUrls: [rule.sourceUrl], accessDate: now.toISOString().slice(0, 10), confidence: "high" },
      frozenAt: now.toISOString(),
    };
    const check = evaluateCompliance(artifact, g, { evaluatedAt: now.toISOString(), manuscriptRevision: null }).checks[0]!;
    const location = g.source === "pdf" ? "PDF 参考文献解析（条目级）" : g.bibSource === "thebibliography" ? "thebibliography 环境" : "references.bib";
    if (check.status === "NOT_EVALUATED") return notEvaluated(check.observed, `${check.reason ?? "无观测"}：需要 ${rule.requiredInputs.join("、")}`, location);
    return decided(rule, check.status === "PASS", check.observed, location);
  }
  if (facts.fidelity !== "latex") {
    return notEvaluated(
      facts.fidelity === "pdf" ? "（PDF-only 稿件：该字段无确定性观测点）" : "（无可观测稿件）",
      facts.fidelity === "pdf" ? "导入 LaTeX 源码后可检查；PDF 上「未观测到」与「不存在」不可区分" : "先导入稿件（LaTeX 优先）",
    );
  }
  const p = rule.params ?? {};
  switch (rule.checker) {
    case "title.maxCjkChars":
      if (g.titleCjkChars === null) return notEvaluated("未识别 \\title", "在主文件中使用 \\title{…}", "\\title");
      if (g.titleCjkChars === 0) return { ...notEvaluated(`题目「${g.titleRaw}」不含汉字`, "中文题目条款对英文题目不适用", "\\title"), status: "NOT_APPLICABLE", evidenceLevel: "verified", why: "非中文题目" };
      return decided(rule, g.titleCjkChars <= (p.max ?? Infinity), `题目「${g.titleRaw}」汉字 ${g.titleCjkChars} 个`, "\\title");
    case "title.maxEnWords":
      if (g.titleEnWords === null) return notEvaluated("未识别英文题目", "提供英文题目", "\\title");
      return decided(rule, g.titleEnWords <= (p.max ?? Infinity), `英文题目实词 ${g.titleEnWords} 个`, "\\title");
    case "title.maxChars":
      if (facts.titleChars === null) return notEvaluated("未识别 \\title", "在主文件中使用 \\title{…}", "\\title");
      return decided(rule, facts.titleChars <= (p.max ?? Infinity), `题目 ${facts.titleChars} 字符`, "\\title");
    case "title.avoidTerms": {
      if (g.titleRaw === null) return notEvaluated("未识别 \\title", "在主文件中使用 \\title{…}", "\\title");
      const hits = (p.terms ?? []).filter((term) => g.titleRaw!.includes(term));
      return decided(rule, hits.length === 0, hits.length === 0 ? `题目「${g.titleRaw}」未含所列词` : `题目「${g.titleRaw}」含：${hits.join("、")}`, "\\title");
    }
    case "keywords.present":
      return decided(rule, g.keywordCount !== null && g.keywordCount > 0, g.keywordCount === null ? "未识别关键词块（\\keywords{} 或「关键词：」行）" : `关键词 ${g.keywordCount} 个`, "关键词块");
    case "keywords.countRange":
      if (g.keywordCount === null) return notEvaluated("未识别关键词块", "先补充关键词块（见「提供关键词」条）", "关键词块");
      return decided(rule, g.keywordCount >= (p.min ?? 0) && g.keywordCount <= (p.max ?? Infinity), `关键词 ${g.keywordCount} 个（${(g.keywords ?? []).join("；")}）`, "关键词块");
    case "abstract.structuredZh4": {
      if (g.abstractStructured === null) return notEvaluated("未识别 abstract 环境", "使用 \\begin{abstract}…\\end{abstract}", "abstract 环境");
      const names: Record<string, string> = { purpose: "目的", method: "方法", result: "结果", conclusion: "结论" };
      const missing = Object.entries(g.abstractStructured).filter(([, present]) => !present).map(([key]) => names[key] ?? key);
      return decided(rule, missing.length === 0, missing.length === 0 ? "目的 / 方法 / 结果 / 结论 四个小标题齐备" : `缺少小标题：${missing.join("、")}`, "abstract 环境");
    }
    case "abstract.approxCjkChars": {
      if (g.abstractCjkChars === null) return notEvaluated("未识别 abstract 环境", "使用 abstract 环境", "abstract 环境");
      const target = p.value ?? 500;
      const lower = Math.round(target * 0.4);
      const upper = Math.round(target * 1.6);
      return decided(rule, g.abstractCjkChars >= lower && g.abstractCjkChars <= upper, `摘要 ${g.abstractCjkChars} 汉字（建议带 ${lower}–${upper}）`, "abstract 环境");
    }
    case "abstract.maxEnWords":
      if (facts.abstractEnWords === null) return notEvaluated("未识别 abstract 环境", "使用 abstract 环境", "abstract 环境");
      return decided(rule, facts.abstractEnWords <= (p.max ?? Infinity), `摘要约 ${facts.abstractEnWords} 词`, "abstract 环境");
    case "abstract.noCitations":
      if (facts.abstractCitations === null) return notEvaluated("未识别 abstract 环境", "使用 abstract 环境", "abstract 环境");
      return decided(rule, facts.abstractCitations.length === 0, facts.abstractCitations.length === 0 ? "摘要未检出引用" : `摘要含引用：${facts.abstractCitations.slice(0, 5).join(" ")}`, "abstract 环境");
    case "abstract.noCitationsOrCrossRefs": {
      if (facts.abstractCitations === null || facts.abstractCrossRefs === null) return notEvaluated("未识别 abstract 环境", "使用 abstract 环境", "abstract 环境");
      const hits = [...facts.abstractCitations, ...facts.abstractCrossRefs];
      return decided(rule, hits.length === 0, hits.length === 0 ? "摘要未检出文献号 / 图表号 / 公式号" : `摘要含：${hits.slice(0, 6).join(" ")}`, "abstract 环境");
    }
    case "abstract.resultQuantitative":
      if (facts.abstractResultHasNumber === null) return notEvaluated("未识别摘要「结果」小标题", "先按四段式写摘要（见摘要四段式条）", "abstract 环境");
      return decided(rule, facts.abstractResultHasNumber, facts.abstractResultHasNumber ? "「结果」段含定量数字" : "「结果」段未检出任何数字", "abstract 环境 · 结果段", facts.abstractResultHasNumber ? "" : "仅凭「无数字」给出建议级不符；是否应补充定量结果需作者结合正文判断");
    case "manuscript.language": {
      if (facts.language === null) return notEvaluated("正文为空", "导入完整正文");
      const want = p.language ?? "en";
      const observed = `正文语言判定：${facts.language.value}（CJK 字符 ${facts.language.cjkChars} / 拉丁词元 ${facts.language.latinWords}）`;
      if (facts.language.value === "mixed") return { ...notEvaluated(observed, "中英混排比例无法确定语言——请作者确认稿件语言", "全文"), evidenceLevel: "author-check", requiresAuthorDecision: true };
      return decided(rule, facts.language.value === want, observed, "全文");
    }
    case "manuscript.noFootnotes":
      return decided(rule, facts.footnoteCount === 0, `\\footnote 出现 ${facts.footnoteCount} 次`, "正文 \\footnote");
    case "sections.required": {
      const titles = (facts.sectionTitles ?? []).map((title) => title.toLowerCase().replace(/^[\d.\s]+/, "").trim());
      const plain = (facts.plainHeadingLines ?? []).map((line) => line.toLowerCase());
      const matches = (section: { patterns: string[] }, list: string[]) => list.some((title) => section.patterns.some((pattern) => new RegExp(pattern, "i").test(title)));
      const implicit = (section: { label: string }) => (section.label === "Abstract" && facts.hasAbstractEnv === true) || (section.label === "References" && facts.hasBibliography === true);
      const sections = p.sections ?? [];
      const missing = sections.filter((section) => !implicit(section) && !matches(section, titles) && !matches(section, plain));
      // 只以独立文本行出现的标题（PDF 重建稿常见）：要素存在 → 满足，但如实注明未用章节命令
      const plainOnly = sections.filter((section) => !implicit(section) && !matches(section, titles) && matches(section, plain));
      const note = plainOnly.length > 0 ? `；${plainOnly.map((section) => section.label).join("、")} 以独立文本行出现（未使用 \\section，排版前建议改为章节标题）` : "";
      return decided(rule, missing.length === 0, missing.length === 0 ? `必需章节齐备${note}` : `缺少：${missing.map((section) => section.label).join("、")}（已识别章节：${(facts.sectionTitles ?? []).slice(0, 10).join(" / ") || "无"}）${note}`, "\\section 结构");
    }
    case "frontmatter.clcNumber":
      return decided(rule, facts.clcNumberPresent === true, facts.clcNumberPresent ? "检出中图分类号字段" : "未检出「中图分类号」", "首页信息");
    case "statement.dataAvailability":
      return {
        status: "NOT_EVALUATED",
        evidenceLevel: "author-check",
        observed: facts.dataAvailabilityMentioned ? "稿件内检出 Data Availability 相关段落（不等于投稿系统已填写）" : "稿件内未检出 Data Availability 相关段落",
        why: "该声明在投稿系统字段中提交，稿件文件无法证明合规",
        location: "投稿系统 · Additional Information",
        convertible: false,
        requiresAuthorDecision: true,
        gap: "作者需在投稿系统填写 DAS（仓储名 + DOI / 登录号）；系统无法核查投稿系统字段",
      };
    case "statement.ethicsHumanSubjects": {
      const human = facts.humanSubjectSignals ?? [];
      const ethics = facts.ethicsStatementSignals ?? [];
      if (human.length === 0) {
        return { ...notEvaluated("未检出人类受试者相关措辞", "是否涉及人类受试者 / 样本需作者确认（措辞缺失不证明不涉及）", "Methods"), evidenceLevel: "author-check", requiresAuthorDecision: true };
      }
      return {
        status: "NOT_EVALUATED",
        evidenceLevel: "author-check",
        observed: `检出受试者措辞：${human.join("、")}；伦理声明措辞：${ethics.length > 0 ? ethics.join("、") : "未检出"}`,
        why: ethics.length > 0 ? "检出伦理措辞，但审批机构 / 编号是否完整需作者确认" : "疑似涉及人类受试者但未检出伦理审批措辞",
        location: "Methods",
        convertible: false,
        requiresAuthorDecision: true,
        gap: "作者确认伦理审批信息（委员会名称、编号、知情同意形式）",
      };
    }
    default:
      return notEvaluated("（未知检查器）", "系统暂无该检查器");
  }
}

function describeExpected(rule: JournalRule): string {
  const p = rule.params ?? {};
  switch (rule.checker) {
    case "title.maxCjkChars": return `中文题目 ≤ ${p.max} 汉字`;
    case "title.maxEnWords": return `英文题目 ≤ ${p.max} 实词`;
    case "title.maxChars": return `题目 ≤ ${p.max} 字符`;
    case "title.avoidTerms": return `题目不含：${(p.terms ?? []).join("、")}`;
    case "keywords.countRange": return `关键词 ${p.min}～${p.max} 个`;
    case "abstract.maxEnWords": return `摘要 ≤ ${p.max} 词`;
    case "abstract.approxCjkChars": return `摘要约 ${p.value} 字`;
    case "references.count": return `参考文献 ≥ ${p.value} 条`;
    case "references.recent10yRatio": return `近 10 年文献 ≥ ${Math.round((p.value ?? 0) * 100)}%`;
    case "manuscript.language": return `稿件语言：${p.language}`;
    default: return rule.title;
  }
}
