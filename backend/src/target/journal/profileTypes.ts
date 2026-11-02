/**
 * TargetJournalProfile（target-journal-profile/v1）：带来源、时间与适用域的目标期刊规则。
 *
 * 信任边界（M15 Target Journal Assessment）：
 * - 每条规则只来自期刊官方页面明文（officialQuote 逐字摘录 + sourceUrl）；官方没写的
 *   要求不进 profile，系统不编造（例如「创新性须达到 X 分」）；
 * - 规则分四类：hard_deterministic（稿件内可程序检查）/ evidence_based（需内容证据或
 *   作者提供的材料，程序只能给观测信号）/ advisory（主观评判，只交给模型意见层）/ unknown；
 * - blocking 由官方措辞强度决定（「须 / 不得 / must / do not」= true；「一般 / 建议 /
 *   左右」= false），不由系统自行升级；
 * - 来源验真靠「官方原句回放」：重新抓取 sourceUrl，逐条检查 officialQuote 仍在页面文本中
 *   （页面其他部分变化不影响已验证规则；原句消失 → 该条规则来源已变化，不再按旧规则判）。
 *   内置 profile 的 snapshot 时间不是「即时官方规则」——超过 ttlDays 未复核即视为未验证。
 */

/** 稿件可检查的观测字段（hard_deterministic / evidence_based 规则的检查器） */
export type JournalRuleChecker =
  // 复用 M15.9 guideline 检查器（参考文献类含 PDF 区间判定）
  | "references.count"
  | "references.recent10yRatio"
  | "references.doiCoverage"
  // 本模块新增（LaTeX 源码观测；PDF-only 稿件如实 NOT_EVALUATED）
  | "title.maxCjkChars"
  | "title.maxEnWords"
  | "title.maxChars"
  | "title.avoidTerms"
  | "keywords.present"
  | "keywords.countRange"
  | "abstract.structuredZh4"
  | "abstract.approxCjkChars"
  | "abstract.maxEnWords"
  | "abstract.noCitations"
  | "abstract.noCitationsOrCrossRefs"
  | "abstract.resultQuantitative"
  | "manuscript.language"
  | "manuscript.noFootnotes"
  | "sections.required"
  | "frontmatter.clcNumber"
  | "statement.dataAvailability"
  | "statement.ethicsHumanSubjects";

export type JournalRuleKind = "hard_deterministic" | "evidence_based" | "advisory" | "unknown";

/** 稿型（PaperTeam 侧的统一口径；profile.articleTypes 声明期刊接受哪些） */
export type JournalArticleType = "research" | "survey" | "systematic_review" | "dataset" | "code" | "protocol";

export const JOURNAL_ARTICLE_TYPES: readonly JournalArticleType[] = [
  "research",
  "survey",
  "systematic_review",
  "dataset",
  "code",
  "protocol",
];

export const ARTICLE_TYPE_LABELS: Record<JournalArticleType, string> = {
  research: "研究论文",
  survey: "综述（叙述性）",
  systematic_review: "系统综述 / Meta 分析",
  dataset: "数据集论文",
  code: "代码论文",
  protocol: "研究方案 / 实验规程",
};

export interface JournalRule {
  id: string;
  kind: JournalRuleKind;
  /** 期刊侧条目名（展示用） */
  title: string;
  /** hard_deterministic / evidence_based 必填；advisory 缺省 */
  checker?: JournalRuleChecker;
  /** 检查参数（数值阈值 / 区间 / 词表 / 必需章节） */
  params?: {
    value?: number;
    min?: number;
    max?: number;
    terms?: string[];
    language?: "zh" | "en";
    sections?: Array<{ label: string; patterns: string[] }>;
  };
  /** 官方措辞强度：true = 不满足即阻断（须 / 不得 / must） */
  blocking: boolean;
  /** 适用稿型（缺省 = 全部被接受的稿型） */
  appliesToArticleTypes?: JournalArticleType[];
  /** 检查需要的稿件输入（披露 PDF-only / 投稿系统字段等缺口） */
  requiredInputs: string[];
  officialQuote: string;
  sourceUrl: string;
  /** 规则提取可靠性：high = 明文数值 / 明文禁止；medium = 需解释的措辞 */
  reliability: "high" | "medium";
  /** 可执行修改建议（不含任何实验数值修改） */
  suggestion: string;
  /** 修订可执行性：rewrite = 不改事实的文字 / 结构修改，可转入受控修订 */
  actionability: "rewrite" | "author_input" | "needs_experiment" | "external_asset" | "none";
}

export interface JournalArticleTypeSupport {
  type: JournalArticleType;
  /** null = 官方页面未写明（如实未知，不推断为接受或拒绝） */
  accepted: boolean | null;
  labelOfficial: string;
  officialQuote: string;
  sourceUrl: string;
  note?: string;
}

export interface JournalProfile {
  schemaVersion: "target-journal-profile/v1";
  journalId: string;
  /** 规则版本：任何规则 / 原句变化必须递增 */
  rulesVersion: string;
  identity: {
    nameZh?: string;
    nameEn?: string;
    aliases: string[];
    issnPrint?: string;
    issnOnline?: string;
    cn?: string;
    publisher?: string;
    officialDomain: string;
    openalexSourceId?: string;
  };
  language: "zh" | "en";
  scope: {
    statement: string;
    topics: string[];
    officialQuote: string;
    sourceUrl: string;
  };
  articleTypes: JournalArticleTypeSupport[];
  rules: JournalRule[];
  /** 收录 / 分级信息：只记录官方页面自述，不推断（「中文核心」未见官方明文 → UNVERIFIED） */
  indexing: Array<{
    label: string;
    status: "SELF_DECLARED" | "UNVERIFIED";
    officialQuote?: string;
    sourceUrl?: string;
    year?: string;
  }>;
  source: {
    origin: "builtin_official_snapshot" | "user_provided";
    /** 本 profile 规则提取时的抓取时间 */
    retrievedAt: string;
    /** 抓取快照（仓库外数据目录；页面原文不入库）的逐页 SHA-256 */
    pages: Array<{ url: string; sha256: string; role: string }>;
    /** 超过该天数未复核 → 视为未验证（不把旧快照称作即时官方规则） */
    ttlDays: number;
    extractedBy: string;
  };
}

/** 来源验真状态（profile 级） */
export type JournalProfileVerificationStatus =
  | "VERIFIED_SNAPSHOT" // 内置快照仍在 TTL 内（未在线复核）
  | "VERIFIED_LIVE" // 在线复核：全部原句仍在官方页面
  | "STALE" // 超过 TTL 未复核
  | "SOURCE_CHANGED" // 在线复核：部分原句已不在官方页面
  | "UNREACHABLE" // 在线复核失败且无 TTL 内的有效验证
  | "UNVERIFIED"; // 用户提供 / 无来源，未经机器复核

export interface JournalProfileVerification {
  schemaVersion: "journal-profile-verification/v1";
  journalId: string;
  rulesVersion: string;
  checkedAt: string;
  pages: Array<{
    url: string;
    httpStatus: number | null;
    sha256: string | null;
    error?: string;
    /** 与 profile 记录的快照哈希是否逐字节一致（页面其他部分变化不代表规则变化） */
    identicalToSnapshot: boolean | null;
  }>;
  /** 逐规则原句回放结果（含 scope / articleTypes 引文） */
  quotes: Array<{ ref: string; sourceUrl: string; found: boolean | null }>;
  status: "VERIFIED_LIVE" | "SOURCE_CHANGED" | "UNREACHABLE";
}
