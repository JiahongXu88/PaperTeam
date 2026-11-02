/**
 * 内置目标期刊 profile 注册表（target-journal-profile/v1）。
 *
 * 每条 officialQuote 均逐字取自 source.pages 所列官方页面（2026-11-02 抓取；页面原文
 * 存于仓库外 D:\PaperTeamData\M15\TargetJournalAssessment\profiles\raw-20261102，只入库
 * 哈希与短摘录）。新增 / 修改规则必须同步递增 rulesVersion，并重新跑原句回放
 * （scripts/m15-tja/replay-profile-quotes.mjs）。
 */
import { createHash } from "node:crypto";

import type { JournalArticleType, JournalProfile } from "./profileTypes.js";

const CJIG_WRITING = "http://www.cjig.cn/zh/info/13448/";
const CJIG_BASIC = "http://www.cjig.cn/zh/info/24920/";
const PLOS_SUBMISSION = "https://journals.plos.org/plosone/s/submission-guidelines";
const PLOS_DATA = "https://journals.plos.org/plosone/s/data-availability";
const PLOS_SCOPE = "https://journals.plos.org/plosone/s/journal-information";
const PLOS_CRITERIA = "https://journals.plos.org/plosone/s/criteria-for-publication";
const PLOS_TYPES = "https://journals.plos.org/plosone/s/what-we-publish";

const CJIG: JournalProfile = {
  schemaVersion: "target-journal-profile/v1",
  journalId: "cjig",
  rulesVersion: "cjig-2026.11.02-r1",
  identity: {
    nameZh: "中国图象图形学报",
    nameEn: "Journal of Image and Graphics",
    aliases: ["中国图象图形学报", "Journal of Image and Graphics", "CJIG", "Zhongguo Tuxiang Tuxing Xuebao"],
    issnPrint: "1006-8961",
    officialDomain: "www.cjig.cn",
    openalexSourceId: "S2764372918",
  },
  language: "zh",
  scope: {
    statement: "计算机图像图形学相关研究成果（图像处理与编码、图像分析与识别、图像理解与计算机视觉、计算机图形学、医学图像处理、遥感图像处理、虚拟现实和增强现实、地理信息系统）",
    topics: ["图像处理与编码", "图像分析与识别", "图像理解与计算机视觉", "计算机图形学", "医学图像处理", "遥感图像处理", "虚拟现实和增强现实", "地理信息系统"],
    officialQuote: "常设栏目：图像处理与编码、图像分析与识别、图像理解与计算机视觉、计算机图形学、医学图像处理、遥感图像处理、虚拟现实和增强现实、地理信息系统",
    sourceUrl: CJIG_BASIC,
  },
  articleTypes: [
    { type: "research", accepted: true, labelOfficial: "常设栏目研究论文", officialQuote: "是国内唯一一本全面报道与计算机图像图形学相关研究成果的专业学术期刊。", sourceUrl: CJIG_BASIC },
    { type: "survey", accepted: true, labelOfficial: "学者观点（小综述）、前沿进展（小综述）", officialQuote: "创新栏目：学者观点（小综述）、前沿进展（小综述）、数据集论文、代码论文", sourceUrl: CJIG_BASIC, note: "官方栏目名为「小综述」；篇幅与体例另见编辑部通知" },
    { type: "dataset", accepted: true, labelOfficial: "数据集论文", officialQuote: "创新栏目：学者观点（小综述）、前沿进展（小综述）、数据集论文、代码论文", sourceUrl: CJIG_BASIC },
    { type: "code", accepted: true, labelOfficial: "代码论文", officialQuote: "创新栏目：学者观点（小综述）、前沿进展（小综述）、数据集论文、代码论文", sourceUrl: CJIG_BASIC },
    { type: "systematic_review", accepted: null, labelOfficial: "（官方页面未写明）", officialQuote: "创新栏目：学者观点（小综述）、前沿进展（小综述）、数据集论文、代码论文", sourceUrl: CJIG_BASIC, note: "未单列系统综述；是否按小综述受理需向编辑部确认" },
    { type: "protocol", accepted: null, labelOfficial: "（官方页面未写明）", officialQuote: "创新栏目：学者观点（小综述）、前沿进展（小综述）、数据集论文、代码论文", sourceUrl: CJIG_BASIC },
  ],
  rules: [
    {
      id: "cjig-title-zh-20", kind: "hard_deterministic", title: "中文题目字数", checker: "title.maxCjkChars", params: { max: 20 },
      blocking: false, requiredInputs: ["LaTeX \\title"], reliability: "high", actionability: "rewrite",
      officialQuote: "中文题目的字数一般不多于20个汉字", sourceUrl: CJIG_WRITING,
      suggestion: "压缩题目至 20 个汉字以内（官方措辞为「一般」，超出属建议级不符）；保留方法与主题词，不改变研究内容。",
    },
    {
      id: "cjig-title-avoid", kind: "hard_deterministic", title: "题目避免无实义词", checker: "title.avoidTerms", params: { terms: ["基于", "一种", "利用", "方法"] },
      blocking: false, requiredInputs: ["LaTeX \\title"], reliability: "high", actionability: "rewrite",
      officialQuote: "避免使用“基于”“一种”“利用”“方法”等无实际意义的词组", sourceUrl: CJIG_WRITING,
      suggestion: "改写题目，去掉「基于 / 一种 / 利用 / 方法」等无实义词，直接点明方法与主题。",
    },
    {
      id: "cjig-frontmatter-clc", kind: "hard_deterministic", title: "中图法分类号", checker: "frontmatter.clcNumber",
      blocking: true, requiredInputs: ["LaTeX 首页信息"], reliability: "high", actionability: "author_input",
      officialQuote: "首页页眉处请提供中图法分类号", sourceUrl: CJIG_WRITING,
      suggestion: "按《中国图书馆分类法》为本文选定中图分类号并写入首页（需作者确定，系统不代选）。",
    },
    {
      id: "cjig-abstract-structured", kind: "hard_deterministic", title: "摘要四段式小标题", checker: "abstract.structuredZh4",
      blocking: true, requiredInputs: ["LaTeX abstract 环境"], reliability: "high", actionability: "rewrite",
      officialQuote: "中文摘要请按照“目的”、“方法”、“结果”、“结论”为小标题逐项撰写", sourceUrl: CJIG_WRITING,
      suggestion: "将中文摘要重组为「目的 / 方法 / 结果 / 结论」四个小标题段落，只调整结构，不新增或修改结果数值。",
    },
    {
      id: "cjig-abstract-500", kind: "hard_deterministic", title: "摘要字数约 500 字", checker: "abstract.approxCjkChars", params: { value: 500 },
      blocking: false, requiredInputs: ["LaTeX abstract 环境"], reliability: "medium", actionability: "rewrite",
      officialQuote: "字数在500字左右（中英文摘要无需对应）", sourceUrl: CJIG_WRITING,
      suggestion: "调整中文摘要篇幅至约 500 字（官方「左右」为建议级）。",
    },
    {
      id: "cjig-abstract-quant", kind: "evidence_based", title: "摘要结果段给出定量结果", checker: "abstract.resultQuantitative",
      blocking: false, appliesToArticleTypes: ["research", "dataset", "code"], requiredInputs: ["LaTeX abstract 环境（结果小标题）"], reliability: "medium", actionability: "rewrite",
      officialQuote: "该部分请提供定量的实验结果。", sourceUrl: CJIG_WRITING,
      suggestion: "在摘要「结果」段引用正文已有的定量结果（只能引用正文已报告的数值，不得新增或改动数值）。",
    },
    {
      id: "cjig-abstract-no-refs", kind: "hard_deterministic", title: "摘要不得含文献号 / 图表号 / 公式号", checker: "abstract.noCitationsOrCrossRefs",
      blocking: true, requiredInputs: ["LaTeX abstract 环境"], reliability: "high", actionability: "rewrite",
      officialQuote: "不得使用一次文献中列出的章节号、图号、表号、公式号以及参考文献号等。", sourceUrl: CJIG_WRITING,
      suggestion: "删除摘要中的 \\cite / \\ref / 图号 / 表号 / 公式号，改为文字表述。",
    },
    {
      id: "cjig-keywords-present", kind: "hard_deterministic", title: "提供关键词", checker: "keywords.present",
      blocking: true, requiredInputs: ["LaTeX 关键词块"], reliability: "high", actionability: "rewrite",
      officialQuote: "关键词选用能反映文章特征内容的术语，要按重要性先后依序排列", sourceUrl: CJIG_WRITING,
      suggestion: "补充关键词块（从题名、摘要、层次标题中抽取主题词，分号分隔）。",
    },
    {
      id: "cjig-keywords-5-8", kind: "hard_deterministic", title: "关键词 5～8 个", checker: "keywords.countRange", params: { min: 5, max: 8 },
      blocking: false, requiredInputs: ["LaTeX 关键词块"], reliability: "high", actionability: "rewrite",
      officialQuote: "一般可选5～8个关键词", sourceUrl: CJIG_WRITING,
      suggestion: "将关键词调整为 5～8 个（官方措辞「一般」为建议级）。",
    },
    {
      id: "cjig-refs-15", kind: "hard_deterministic", title: "参考文献 15 篇以上", checker: "references.count", params: { value: 15 },
      blocking: true, requiredInputs: ["references.bib / thebibliography 或 PDF 参考文献解析"], reliability: "high", actionability: "author_input",
      officialQuote: "数量要求15篇以上", sourceUrl: CJIG_WRITING,
      suggestion: "补充作者亲自阅读过的正式发表文献至 15 篇以上（需作者核实文献，系统不代为编造引用）。",
    },
    {
      id: "cjig-refs-recent-60", kind: "hard_deterministic", title: "近 10 年文献占 60% 以上", checker: "references.recent10yRatio", params: { value: 0.6 },
      blocking: true, requiredInputs: ["参考文献年份"], reliability: "high", actionability: "author_input",
      officialQuote: "近10年的参考文献应占60%以上。", sourceUrl: CJIG_WRITING,
      suggestion: "补充近 10 年的相关正式文献，使占比 ≥ 60%（需作者检索并核实）。",
    },
    {
      id: "cjig-refs-doi", kind: "hard_deterministic", title: "所有参考文献提供 DOI", checker: "references.doiCoverage",
      blocking: true, requiredInputs: ["参考文献 DOI 字段"], reliability: "high", actionability: "author_input",
      officialQuote: "所有参考文献请提供DOI（数字对象唯一标识符）。", sourceUrl: CJIG_WRITING,
      suggestion: "为缺 DOI 的条目补充 DOI（可用引用核验结果逐条确认；无 DOI 的文献需与编辑部确认处理方式）。",
    },
    {
      id: "cjig-refs-author-year", kind: "evidence_based", title: "参考文献作者（年）格式并按字母排序",
      blocking: true, requiredInputs: ["编译后参考文献列表"], reliability: "high", actionability: "rewrite",
      officialQuote: "参考文献按照作者（年）格式撰写，文献列表中全部文献按照英文字母顺序排序。", sourceUrl: CJIG_WRITING,
      suggestion: "改用作者-年份著录样式（如 natbib 作者年制）并按字母序排列；系统暂无编译后版式检查器，请对照学报体例自检。",
    },
    {
      id: "cjig-figures-dpi-3line", kind: "evidence_based", title: "图片 300dpi 以上、三线表",
      blocking: true, requiredInputs: ["原始图像文件", "编译后表格版式"], reliability: "high", actionability: "external_asset",
      officialQuote: "分辨率在300dpi以上。表格均采用三线表。", sourceUrl: CJIG_WRITING,
      suggestion: "逐图核对导出分辨率 ≥ 300dpi，表格改为三线表（booktabs）；系统未读取图像像素，不能代为判定。",
    },
    {
      id: "cjig-captions-bilingual", kind: "evidence_based", title: "图名表名中英文对照",
      blocking: true, requiredInputs: ["图表标题"], reliability: "high", actionability: "rewrite",
      officialQuote: "图名和表名需中英文对照。", sourceUrl: CJIG_WRITING,
      suggestion: "为每个图题、表题补充对应英文标题。",
    },
    {
      id: "cjig-content-quality", kind: "advisory", title: "内容要点突出、论据充分、数据准确",
      blocking: false, requiredInputs: ["全文"], reliability: "medium", actionability: "none",
      officialQuote: "内容应要点突出，论点明确，论据充分，层次分明，数据准确，结构严谨，文字精炼", sourceUrl: CJIG_WRITING,
      suggestion: "主观质量要求：只能由模型意见 / 作者自评辅助，不构成确定性判定。",
    },
  ],
  indexing: [
    { label: "中国科协高质量科技期刊分级目录（2025）T1 类", status: "SELF_DECLARED", officialQuote: "是中国科协图像图形领域、图学领域等多个领域高质量科技期刊分级目录（2025）T1类期刊。", sourceUrl: CJIG_BASIC, year: "2025" },
    { label: "CSCD / Scopus / JST / EBSCO 收录", status: "SELF_DECLARED", officialQuote: "覆盖CSCD等国内各大数据库，国际上被Scopus，JST，EBSCO数据库收录", sourceUrl: CJIG_BASIC },
    { label: "北大《中文核心期刊要目总览》", status: "UNVERIFIED" },
  ],
  source: {
    origin: "builtin_official_snapshot",
    retrievedAt: "2026-11-02T00:00:00.000Z",
    pages: [
      { url: CJIG_WRITING, sha256: "3c188a0219fc768f621e33e6e23281d81ae73c900395ddae976c601715e6f32d", role: "撰稿要求" },
      { url: CJIG_BASIC, sha256: "9f8fd1e46fbbb435af525d860b74898f3012d0daef64ca7f6b888999f9c61c23", role: "期刊简介 / 栏目" },
    ],
    ttlDays: 90,
    extractedBy: "M15 Target Journal Assessment（人工逐句摘录 + 原句回放）",
  },
};

const PLOS_ONE: JournalProfile = {
  schemaVersion: "target-journal-profile/v1",
  journalId: "plos-one",
  rulesVersion: "plos-one-2026.11.02-r1",
  identity: {
    nameEn: "PLOS ONE",
    aliases: ["PLOS ONE", "PLOS One", "PLoS ONE", "PLOS 1"],
    issnOnline: "1932-6203",
    publisher: "Public Library of Science",
    officialDomain: "journals.plos.org",
    openalexSourceId: "S202381698",
  },
  language: "en",
  scope: {
    statement: "Research in over two hundred subject areas across science, engineering, medicine, and the related social sciences and humanities; evaluated on scientific validity, methodology and ethics — not perceived significance.",
    topics: ["natural sciences", "medicine", "engineering", "social sciences", "humanities"],
    officialQuote: "PLOS ONE accepts research in over two hundred subject areas across science, engineering, medicine, and the related social sciences and humanities.",
    sourceUrl: PLOS_SCOPE,
  },
  articleTypes: [
    { type: "research", accepted: true, labelOfficial: "Research Articles", officialQuote: "Research Articles present the results of original research that address a clearly defined research question and contribute to the body of academic knowledge.", sourceUrl: PLOS_TYPES },
    { type: "systematic_review", accepted: true, labelOfficial: "Research Article（systematic reviews and meta-analyses）", officialQuote: "PLOS One considers Research Article submissions which report systematic reviews and meta-analyses", sourceUrl: PLOS_TYPES },
    { type: "dataset", accepted: true, labelOfficial: "Research Article（new methods, software, databases and tools）", officialQuote: "PLOS One considers Research Article submissions which report new methods, software, databases and tools as the primary focus of the article.", sourceUrl: PLOS_TYPES },
    { type: "code", accepted: true, labelOfficial: "Research Article（new methods, software, databases and tools）", officialQuote: "PLOS One considers Research Article submissions which report new methods, software, databases and tools as the primary focus of the article.", sourceUrl: PLOS_TYPES },
    { type: "protocol", accepted: true, labelOfficial: "Lab Protocols / Study Protocols", officialQuote: "PLOS One accepts submissions of Study Protocols for any study type within the journal’s scope.", sourceUrl: PLOS_TYPES },
    { type: "survey", accepted: false, labelOfficial: "Collection Reviews（仅限邀约）", officialQuote: "PLOS One does not consider unsolicited submissions of the article types below", sourceUrl: PLOS_TYPES, note: "叙述性综述（Collection Reviews）须由编辑邀约；系统综述 / Meta 分析请选「系统综述」稿型" },
  ],
  rules: [
    {
      id: "plos-language-en", kind: "hard_deterministic", title: "稿件须为英文", checker: "manuscript.language", params: { language: "en" },
      blocking: true, requiredInputs: ["LaTeX 正文"], reliability: "high", actionability: "none",
      officialQuote: "Manuscripts must be submitted in English.", sourceUrl: PLOS_SUBMISSION,
      suggestion: "PLOS ONE 只受理英文稿件：需整体翻译（属重写级工作，不在自动修订范围内），或改投中文期刊。",
    },
    {
      id: "plos-title-250", kind: "hard_deterministic", title: "完整题目 ≤ 250 字符", checker: "title.maxChars", params: { max: 250 },
      blocking: true, requiredInputs: ["LaTeX \\title"], reliability: "high", actionability: "rewrite",
      officialQuote: "Full title 250 characters", sourceUrl: PLOS_SUBMISSION,
      suggestion: "将完整题目压缩到 250 字符以内。",
    },
    {
      id: "plos-abstract-300", kind: "hard_deterministic", title: "摘要 ≤ 300 词", checker: "abstract.maxEnWords", params: { max: 300 },
      blocking: true, requiredInputs: ["LaTeX abstract 环境"], reliability: "high", actionability: "rewrite",
      officialQuote: "Not exceed 300 words", sourceUrl: PLOS_SUBMISSION,
      suggestion: "将摘要压缩到 300 词以内（不改动结果数值）。",
    },
    {
      id: "plos-abstract-no-cite", kind: "hard_deterministic", title: "摘要不含引用", checker: "abstract.noCitations",
      blocking: true, requiredInputs: ["LaTeX abstract 环境"], reliability: "high", actionability: "rewrite",
      officialQuote: "Do not include citations in abstracts.", sourceUrl: PLOS_SUBMISSION,
      suggestion: "删除摘要中的引用标记，必要信息改为正文引用。",
    },
    {
      id: "plos-no-footnotes", kind: "hard_deterministic", title: "不允许脚注", checker: "manuscript.noFootnotes",
      blocking: true, requiredInputs: ["LaTeX 正文"], reliability: "high", actionability: "rewrite",
      officialQuote: "Footnotes are not permitted.", sourceUrl: PLOS_SUBMISSION,
      suggestion: "把脚注内容移入正文或参考文献列表。",
    },
    {
      id: "plos-required-sections", kind: "hard_deterministic", title: "必需章节（Abstract / Introduction / Acknowledgments / References）", checker: "sections.required",
      params: {
        sections: [
          { label: "Abstract", patterns: ["^abstract$"] },
          { label: "Introduction", patterns: ["^introduction$", "^background$"] },
          { label: "Acknowledgments", patterns: ["^acknowledge?ments?$"] },
          { label: "References", patterns: ["^references$", "^bibliography$"] },
        ],
      },
      blocking: true, appliesToArticleTypes: ["research", "systematic_review", "dataset", "code"], requiredInputs: ["LaTeX 章节结构"], reliability: "high", actionability: "rewrite",
      officialQuote: "The following elements are required, in order:", sourceUrl: PLOS_SUBMISSION,
      suggestion: "补齐缺失的必需章节标题（Acknowledgments 内容需作者提供，系统不代写致谢对象）。",
    },
    {
      id: "plos-data-availability", kind: "evidence_based", title: "数据可用性声明（投稿系统字段）", checker: "statement.dataAvailability",
      blocking: true, requiredInputs: ["投稿系统 Data Availability 字段", "数据仓储 DOI / 登录号"], reliability: "high", actionability: "author_input",
      officialQuote: "When submitting a manuscript, authors must provide a Data Availability Statement describing compliance with PLOS' data policy.", sourceUrl: PLOS_DATA,
      suggestion: "准备 Data Availability Statement（仓储名 + DOI / 登录号 + 许可）并在投稿系统填写；稿件文件内出现该段不等于投稿系统已填写。",
    },
    {
      id: "plos-ethics-human", kind: "evidence_based", title: "人类受试者研究的伦理声明", checker: "statement.ethicsHumanSubjects",
      blocking: true, requiredInputs: ["Methods 段伦理审批信息（如适用）"], reliability: "high", actionability: "author_input",
      officialQuote: "Methods sections of papers on research using human subjects or samples must include ethics statements that specify:", sourceUrl: PLOS_SUBMISSION,
      suggestion: "如研究涉及人类受试者或样本：在 Methods 写明伦理委员会名称、审批编号与知情同意形式（只能由作者提供真实信息）。",
    },
    {
      id: "plos-criteria-rigor", kind: "advisory", title: "发表标准 3：实验 / 统计达到高技术标准且描述充分",
      blocking: false, appliesToArticleTypes: ["research", "systematic_review", "dataset", "code"], requiredInputs: ["全文"], reliability: "medium", actionability: "none",
      officialQuote: "3. Experiments, statistics, and other analyses are performed to a high technical standard and are described in sufficient detail.", sourceUrl: PLOS_CRITERIA,
      suggestion: "主观质量标准：由模型意见层辅助评估，不构成确定性判定。",
    },
    {
      id: "plos-criteria-conclusions", kind: "advisory", title: "发表标准 4：结论得到数据支持",
      blocking: false, requiredInputs: ["全文"], reliability: "medium", actionability: "none",
      officialQuote: "4. Conclusions are presented in an appropriate fashion and are supported by the data.", sourceUrl: PLOS_CRITERIA,
      suggestion: "主观质量标准：由模型意见层辅助评估；与已证实的跨节数值 / 作者数据复算缺陷（L1）冲突时以 L1 为准。",
    },
  ],
  indexing: [],
  source: {
    origin: "builtin_official_snapshot",
    retrievedAt: "2026-11-02T00:00:00.000Z",
    pages: [
      { url: PLOS_SUBMISSION, sha256: "77194bf877dce6fc4a792c497a4e07d0b71dac1f040ae1708097b5a74fd75804", role: "Submission Guidelines" },
      { url: PLOS_DATA, sha256: "53f67bbdb4d9dd8c628643e02e4243a5d2e2b1319cf6547feced5643207139f2", role: "Data Availability" },
      { url: PLOS_SCOPE, sha256: "83a9b17bafc0f7db903d3b7ed5bd1877fdcf467c4804431a22eb1a72c2b7da3a", role: "Journal Information" },
      { url: PLOS_CRITERIA, sha256: "2bd0c63d37bc1840a9c0d8690cca0d9eb4820a2150c55977174d6e57e9afdb3a", role: "Criteria for Publication" },
      { url: PLOS_TYPES, sha256: "515173b8b44fadf99b4a3e7bdb899c8fb941a3d6485ccce0eccb10e4728fd9de", role: "What We Publish" },
    ],
    ttlDays: 90,
    extractedBy: "M15 Target Journal Assessment（人工逐句摘录 + 原句回放）",
  },
};

export const BUILTIN_JOURNAL_PROFILES: readonly JournalProfile[] = [CJIG, PLOS_ONE];

export function listBuiltinJournalProfiles(): readonly JournalProfile[] {
  return BUILTIN_JOURNAL_PROFILES;
}

function normalizeName(value: string): string {
  return value.normalize("NFKC").toLowerCase().replace(/[\s《》"'“”·\-_]/g, "");
}

/** 按 journalId / 名称（中英文 / 别名）/ ISSN 查找；同名多匹配 → ambiguous（不擅自挑选） */
export function resolveJournalProfile(
  query: { journalId?: string; name?: string; issn?: string },
  profiles: readonly JournalProfile[] = BUILTIN_JOURNAL_PROFILES,
): { profile: JournalProfile | null; ambiguous: string[] } {
  if (query.journalId !== undefined && query.journalId.trim() !== "") {
    const hit = profiles.find((profile) => profile.journalId === query.journalId);
    return { profile: hit ?? null, ambiguous: [] };
  }
  if (query.issn !== undefined && query.issn.trim() !== "") {
    const issn = query.issn.replace(/[^0-9xX]/g, "").toUpperCase();
    const hits = profiles.filter((profile) =>
      [profile.identity.issnPrint, profile.identity.issnOnline].some((value) => value !== undefined && value.replace(/[^0-9xX]/g, "").toUpperCase() === issn),
    );
    return hits.length === 1 ? { profile: hits[0]!, ambiguous: [] } : { profile: null, ambiguous: hits.map((p) => p.journalId) };
  }
  if (query.name !== undefined && query.name.trim() !== "") {
    const needle = normalizeName(query.name);
    const hits = profiles.filter((profile) =>
      [profile.identity.nameZh, profile.identity.nameEn, ...profile.identity.aliases].some((value) => value !== undefined && normalizeName(value) === needle),
    );
    return hits.length === 1 ? { profile: hits[0]!, ambiguous: [] } : { profile: null, ambiguous: hits.map((p) => p.journalId) };
  }
  return { profile: null, ambiguous: [] };
}

/** profile 内容指纹（规则 / 原句 / 来源任一变化 → 指纹变化 → 旧评估失效） */
export function journalProfileHash(profile: JournalProfile): string {
  return createHash("sha256").update(stableStringify(profile)).digest("hex");
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`;
  if (value !== null && typeof value === "object") {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .filter((key) => record[key] !== undefined)
      .map((key) => `${JSON.stringify(key)}:${stableStringify(record[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

export function isArticleType(value: unknown): value is JournalArticleType {
  return typeof value === "string" && ["research", "survey", "systematic_review", "dataset", "code", "protocol"].includes(value);
}
