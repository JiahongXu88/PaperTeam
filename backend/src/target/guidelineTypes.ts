/**
 * Target Guideline（M15.9 · Phase E G1）：目标期刊官方投稿要求的结构化工件与符合度报告类型。
 *
 * 语义红线（任务书 §5/§6）：
 * - 官方要求层与 benchmark 观测统计**严格分离**：本工件只收录期刊官方页面明文
 *   规定（原句摘录 + 来源 URL + 快照 SHA），绝不从已发表论文的典型形态反推
 *   "官方要求"；官方未写明的字段 NOT_SPECIFIED，不入 requirements；
 * - 符合度报告是 **advisory**：不进任何 Quality Gate 规则、不参与 pass/fail
 *   （gates.ts 零改动红线）；不可观测的要求 → NOT_EVALUATED，不冒充通过；
 * - 量化创新性量表等官方不存在的要求，系统不得编造数值门槛。
 */

/** 工件落盘：research/target-guideline.json */
export interface VenueGuidelineArtifact {
  schemaVersion: 1;
  /** 期刊稳定标识（如 "cjig" / "cea"） */
  venueId: string;
  displayName: string;
  identity: {
    issnPrint?: string;
    issnOnline?: string;
    cn?: string;
    officialSite?: string;
    openalexSourceId?: string;
  };
  /** 官方范围陈述（栏目/范围声明；rubric 的 scope 判据来源） */
  scope: {
    scopeStatement?: string;
    columnsZh?: string[];
    quote?: string;
    sourceUrl?: string;
  };
  articleTypes?: Array<{
    id: string;
    labelZh: string;
    requirementQuote?: string;
  }>;
  requirements: VenueGuidelineRequirement[];
  provenance: {
    sourceUrls: string[];
    accessDate: string;
    /** 快照可复核标识（仓库外数据目录路径 + 文件级 SHA256） */
    snapshotDir?: string;
    snapshotSha256?: Record<string, string>;
    /** 编辑部自述类信息（收录状态等）降级 medium */
    confidence: "high" | "medium";
  };
  frozenAt: string;
}

/** 官方要求单条（只收官方明文；operator 决定确定性检查形态） */
export interface VenueGuidelineRequirement {
  id: string;
  field: GuidelineField;
  operator: GuidelineOperator;
  value?: number;
  unit?: string;
  /** 适用文章类型（缺省 = 全部） */
  appliesToArticleTypes?: string[];
  /** 硬性（VIOLATION 红显）vs 建议（ADVISORY 提示）——按官方措辞强度划分 */
  hard: boolean;
  officialQuote: string;
  sourceUrl: string;
  confidence: "high" | "medium";
  effectiveDate?: string;
}

export type GuidelineField =
  | "title.maxLengthZh"
  | "title.maxLengthEnWords"
  | "keywords.count"
  | "abstract.structuredZh4"
  | "abstract.lengthZh"
  | "references.count"
  | "references.recent10yRatio"
  | "references.doiCoverage"
  | "references.styleAuthorYear"
  | "figures.tableThreeLine"
  | "figures.resolutionDpi"
  | "manuscript.lengthWords"
  | "section.numberingFromZero";

export type GuidelineOperator =
  | "max"
  | "min"
  | "ratio_min"
  | "presence_all"
  | "approx_range"
  | "presence";

/** 符合度报告（advisory；research/target-guideline-compliance.json） */
export interface GuidelineComplianceReport {
  schemaVersion: 1;
  venueId: string;
  guidelineFrozenAt: string;
  evaluatedAt: string;
  manuscriptRevision: number | null;
  checks: Array<{
    requirementId: string;
    field: GuidelineField;
    status: "PASS" | "VIOLATION" | "NOT_EVALUATED" | "ADVISORY";
    hard: boolean;
    observed: string;
    expected: string;
    officialQuote: string;
    sourceUrl: string;
    /** NOT_EVALUATED 的原因（观测缺失/无确定性检查器） */
    reason?: string;
  }>;
  summary: {
    hardViolations: number;
    passCount: number;
    notEvaluatedCount: number;
    advisoryCount: number;
    topStatus: "COMPLIANT" | "HARD_VIOLATION" | "NOT_EVALUATED_ONLY";
  };
  provenance: {
    basis: "official_guideline_evidence";
    disclaimer: string;
    /** 官方指南工件自身的快照/URL 溯源在 guideline 工件内（此处引用） */
    guidelineConfidence: "high" | "medium";
  };
}
