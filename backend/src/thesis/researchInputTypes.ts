/**
 * M14.1b — Research Input & Scientific Fact Management：冻结数据契约。
 *
 * 五个概念必须严格区分（M14.0.1 实证裁决 H2/H5/H6）：
 *   Document Source（SourceStore 条目 / 文件）→ ResearchInput（登记的研究材料，
 *   带类型 / 版本 / 入选状态）→ ScientificFact（从材料抽取的事实，三态验证）
 *   → Evidence（既有 EvidenceStore 记录，供引用核验）→ Author Confirmation
 *   （只能来自作者操作或测试夹具的显式模拟）。
 *
 * 身份 / 来源 / 内容版本三种标识：
 *   - inputId      ResearchInput 身份（按 sourceId + contentHash 确定性派生；重放幂等）
 *   - sourceId     文献库来源条目（SourceStore，S001…）
 *   - contentHash  内容版本（文件字节 sha256；不同版本不互相覆盖）
 *
 * 落盘（research/ 目录，原子写，不引入数据库）：
 *   research/research-inputs.json      注册表（inputs / relations / workGroups / alignments）
 *   research/scientific-facts.json     事实 + 冲突
 *   research/author-decisions.jsonl    作者决定（append-only）
 */

// ---------------------------------------------------------------------------
// ResearchInput
// ---------------------------------------------------------------------------

export const RESEARCH_INPUT_TYPES = [
  "published_paper",
  "preprint",
  "submitted_manuscript",
  "unpublished_manuscript",
  "experiment_report",
] as const;
export type ResearchInputType = (typeof RESEARCH_INPUT_TYPES)[number];

/** 材料类型 ≠ 学术验证状态：只有 published_paper 代表已经过同行评审公开发表 */
export function isPublishedInputType(type: ResearchInputType): boolean {
  return type === "published_paper";
}

export const RESEARCH_INPUT_SCOPES = ["proposed", "included", "excluded", "superseded"] as const;
export type ResearchInputScope = (typeof RESEARCH_INPUT_SCOPES)[number];

export type ResearchInputParseStatus =
  | "pending" // 已登记，解析产物尚不存在
  | "full_text" // 结构化全文（status=ok）
  | "partial" // 解析产物存在但 parser 自报不完整 / 降级为纯文本层
  | "failed" // 解析失败（原始材料仍保留）
  | "metadata_only" // 无原始文件（仅元数据）
  | "unsupported"; // 文件类型不支持结构化解析

export interface ResearchInputVersion {
  sourceId: string;
  contentHash: string;
  fileName?: string;
  bytes: number;
  importedAt: string;
}

export interface ResearchInputIdentifiers {
  doi?: string;
  /** arXiv 基础 id（不含版本号，如 1901.09993） */
  arxivId?: string;
  /** arXiv 版本号（v3 → 3） */
  arxivVersion?: number;
}

export type PublicationStatusValue = "published" | "accepted" | "submitted" | "preprint" | "unpublished";

export interface ResearchInputParseSummary {
  status: ResearchInputParseStatus;
  parser?: string;
  parseMode?: "structured" | "text_only";
  pageCount?: number;
  blockCount?: number;
  tableCount?: number;
  notes: string[];
  checkedAt?: string;
}

export interface ResearchInput {
  schemaVersion: 1;
  inputId: string;
  projectId: string;
  inputType: ResearchInputType;
  title: string;
  authors: string[];
  /** 材料提供者（作者本人 / 导师 / 合作者；自由文本，不做身份认证） */
  providedBy?: string;
  /** 来源 URI（DOI / arXiv / URL / "local-upload"） */
  provenanceUri?: string;
  identifiers: ResearchInputIdentifiers;
  /** 人类可读版本标识（"arXiv v2" / "author copy 2016" / "camera-ready"） */
  versionLabel?: string;
  publicationStatus?: { value: PublicationStatusValue; asOf?: string };
  /** 研究成果分组（同一成果的多个版本共享 workId；未知时 = inputId） */
  workId: string;
  version: ResearchInputVersion;
  parse: ResearchInputParseSummary;
  scope: { status: ResearchInputScope; decisionId?: string; updatedAt: string };
  /** 未发表材料是否允许纳入（仅作者决定可写；缺省 = 未决定） */
  unpublishedMaterialPolicy?: { allowed: boolean; decisionId: string; note?: string };
  /** 与既有 EvidenceStore 的关联（同 sourceId 的 evidence 记录 id；只读派生，不复制内容） */
  evidenceLinks: { evidenceIds: string[] };
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 版本关系
// ---------------------------------------------------------------------------

export const VERSION_RELATION_KINDS = ["same_work", "supersedes", "supplements", "derived_from"] as const;
export type VersionRelationKind = (typeof VERSION_RELATION_KINDS)[number];

export type RelationBasis =
  | "arxiv_identifier" // 同 arXiv 基础 id（确定性元数据证据 → 可自动 confirmed）
  | "doi_identifier" // 同 DOI（确定性元数据证据 → 可自动 confirmed）
  | "content_match" // 内容对账（表格 / 数值重合；确定性但只到 candidate）
  | "title_similarity" // 标题相似（仅 candidate；禁止自动确认）
  | "model_candidate" // 模型建议（仅 candidate）
  | "author_decision"; // 作者确认

export type VersionRelationStatus = "candidate" | "confirmed" | "rejected";

export interface VersionRelation {
  relationId: string;
  fromInputId: string;
  toInputId: string;
  kind: VersionRelationKind;
  status: VersionRelationStatus;
  basis: RelationBasis;
  /** 人类可读的确定性证据描述 */
  evidence?: string;
  proposedBy: "system" | "model" | "author";
  decisionId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface WorkGroupState {
  workId: string;
  inputIds: string[];
  /** 作者选定的"跟随版本"（版本选择是作者决定，不以发布时间推断） */
  preferredInputId?: string;
  decisionId?: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 表格对齐（跨输入的同一表格候选）
// ---------------------------------------------------------------------------

export type TableAlignmentStatus = "comparable" | "candidate" | "not_comparable";
export type RowLabelCompatibility = "equal" | "contains" | "empty" | "mismatch";

export interface TableRef {
  researchInputId: string;
  contentHash: string;
  /** ParsedDocument 块 id（B0001…） */
  blockId: string;
  label?: string;
  labelBasis: "parser_caption" | "adjacent_text" | "none";
  page?: number;
}

export interface TableAlignment {
  alignmentId: string;
  projectId: string;
  left: TableRef;
  right: TableRef;
  status: TableAlignmentStatus;
  basis: "deterministic" | "author_decision";
  evidence: {
    columnLabelsMatch: boolean;
    rowCounts: [number, number];
    identicalCells: number;
    comparedCells: number;
    sharedIdentifiers: string[];
    rowPairs: Array<{ leftRow: number; rightRow: number; labelCompatibility: RowLabelCompatibility }>;
    reason?: string;
    /**
     * M14.1c：候选关系展示用的表头样本（两侧数据列的原始表头标签）。确定性
     * 对齐证据只给布尔 / 计数，作者确认候选对齐时需要肉眼比对列结构。
     */
    columnLabelsSample?: [string[], string[]];
    /**
     * M14.1c：作者拒绝候选对齐时的理由（basis=author_decision 且 status=
     * not_comparable 时填写；与 reason（确定性候选原因）区分）。
     */
    rejectionReason?: string;
  };
  decisionId?: string;
  algorithmVersion: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// ScientificFact
// ---------------------------------------------------------------------------

export const FACT_KINDS = [
  "table_cell",
  "numeric_result",
  "dataset",
  "metric",
  "method",
  "parameter",
  "protocol",
  "research_question",
  "conclusion",
] as const;
export type FactKind = (typeof FACT_KINDS)[number];

/** 验证三态（线性）；冲突状态独立于此（见 FactConflictState） */
export const FACT_VERIFICATION_STATUSES = ["extracted", "source_verified", "author_confirmed"] as const;
export type FactVerificationStatus = (typeof FACT_VERIFICATION_STATUSES)[number];

export type FactConflictStatus = "none" | "unresolved" | "resolved" | "not_comparable";

/** 可比性键：同 subject / dataset / metric / condition / protocol 才进入数值比较 */
export interface FactKey {
  subject?: string;
  dataset?: string;
  metric?: string;
  condition?: string;
  protocol?: string;
  parameter?: string;
}

export interface FactTableLocation {
  tableRef: string;
  label?: string;
  labelBasis: "parser_caption" | "adjacent_text" | "none";
  caption?: string;
  rowIndex: number;
  columnIndex: number;
  rowLabel: string;
  columnLabel: string;
  /** 表头行由首行数据推导（parser 给出的 headers 是占位符） */
  headerRowDerived?: boolean;
}

export interface FactProvenance {
  researchInputId: string;
  sourceId: string;
  contentHash: string;
  blockId?: string;
  page?: number;
  /** 页码来源：parser 报告 / 未知（不编造） */
  pageBasis: "parser" | "unknown";
  section?: string;
  table?: FactTableLocation;
  /** 非表格事实的原文引文（verbatim） */
  quote?: string;
  /** surface 的 sha256（防篡改校验） */
  surfaceHash: string;
}

export type FactExtractionMethod =
  | "deterministic_table"
  | "deterministic_dataset"
  | "deterministic_body_text" // M14.1c：正文数值/数据集/指标/参数确定性抽取（含图内文本层定位）
  | "model_candidate"
  | "manual";

export interface FactValue {
  raw: string;
  numeric?: number;
  unit?: string;
  /** 归一化比较形态（去千分位 / 全角 / 尾零；单位小写） */
  normalized?: string;
  /** 原文含私用区 / 不可映射字形（提取内容不可全信） */
  glyphIssues?: boolean;
}

export interface DecisionActor {
  kind: "user" | "test_fixture";
  id?: string;
  note?: string;
}

export interface FactVerificationState {
  status: FactVerificationStatus;
  /** 来源核验结果（与 status 解耦记录：author_confirmed 的事实也可能未通过文本层核验） */
  sourceCheck: "unchecked" | "verified" | "failed";
  sourceCheckMethod?: "text_layer_match" | "quote_match";
  sourceCheckNote?: string;
  verifiedAt?: string;
  confirmedAt?: string;
  confirmation?: { decisionId: string; actor: DecisionActor };
}

export interface ScientificFact {
  schemaVersion: 1;
  factId: string;
  projectId: string;
  researchInputId: string;
  kind: FactKind;
  key: FactKey;
  surface: string;
  value: FactValue;
  provenance: FactProvenance;
  extraction: {
    method: FactExtractionMethod;
    extractor: string;
    algorithmVersion: string;
    taskId?: string;
  };
  verification: FactVerificationState;
  conflict: { status: FactConflictStatus; conflictIds: string[] };
  supersededBy?: string;
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 冲突
// ---------------------------------------------------------------------------

export type ConflictClassification =
  | "value_mismatch" // 同键、单位可比、归一化后数值不同（blocking）
  | "rounding_difference" // 按较粗精度四舍五入后相等（advisory）
  | "unit_incomparable" // 单位无法可靠换算（advisory，需人工）
  | "equal_after_unit_normalization"; // 单位换算后相等（信息记录，不阻断）

export type ConflictResolutionDecision = "adopt_fact" | "keep_both" | "request_material" | "defer";

export interface ConflictParty {
  factId: string;
  researchInputId: string;
  contentHash: string;
  raw: string;
  normalized?: string;
  unit?: string;
  location: string;
}

export interface FactConflict {
  schemaVersion: 1;
  conflictId: string;
  projectId: string;
  classification: ConflictClassification;
  severity: "blocking" | "advisory";
  key: FactKey;
  parties: ConflictParty[];
  alignmentId?: string;
  detectedBy: "deterministic_table_alignment" | "deterministic_key_match";
  algorithmVersion: string;
  status: "unresolved" | "resolved" | "deferred";
  resolution?: {
    decision: ConflictResolutionDecision;
    adoptedFactId?: string;
    rationale?: string;
    decisionId: string;
    actor: DecisionActor;
    decidedAt: string;
    /** 裁决适用的内容版本：任一方 contentHash 变化 → 裁决失效需重裁 */
    appliesToContentHashes: string[];
  };
  createdAt: string;
  updatedAt: string;
}

// ---------------------------------------------------------------------------
// 作者决定（HITL）
// ---------------------------------------------------------------------------

export const AUTHOR_DECISION_TYPES = [
  "scope_decision",
  "version_selection",
  "relation_confirmation",
  "conflict_resolution",
  "fact_confirmation",
  "unpublished_material_policy",
  "writing_pause",
  /**
   * M14.1c：候选表格对齐的作者确认 / 拒绝。列重排 / 拆表 / 增删行等情况确定性
   * 对齐只能到 candidate——对应关系是否成立由作者裁决；确认后进入可比冲突检测，
   * 拒绝则标记 not_comparable。决定绑定双方 contentHash（版本变化产生新
   * alignmentId，旧决定自然失效）。
   */
  "table_alignment_confirmation",
  /**
   * M14.3：研究成果表格继承授权。候选资产（数值单元格已核验）→ 作者授权后成为
   * 学位论文合法表格，由系统在写作期确定性插入并受守卫保护；拒绝则不进入。
   * 授权可附带学位论文题注（captionZh 改写合法；数据语义不可变）。
   */
  "table_inheritance",
  /**
   * M14.6：研究材料缺口（MissingMaterialLedger）的作者决定。缺口条目只能由系统 / 模型提出
   * （proposed），作者决定后才改变状态；决定绑定 gapId（gapId 稳定、指纹变化时条目标 stale）。
   */
  "missing_material_decision",
] as const;
export type AuthorDecisionType = (typeof AUTHOR_DECISION_TYPES)[number];

/** M14.6：缺口决定（与 missingMaterialTypes.MissingMaterialDecision 同值；此处内联以避免循环类型依赖） */
export type MissingMaterialDecisionValue =
  | "confirm_missing"
  | "supply_experiment_data"
  | "supply_research_record"
  | "supply_manuscript"
  | "write_as_limitation"
  | "defer_chapter"
  | "reject";

export type AuthorDecisionPayload =
  | { type: "scope_decision"; inputId: string; scope: Exclude<ResearchInputScope, "proposed">; rationale?: string }
  | { type: "version_selection"; workId: string; preferredInputId: string; rationale?: string }
  | { type: "relation_confirmation"; relationId: string; outcome: "confirmed" | "rejected"; rationale?: string }
  | {
      type: "conflict_resolution";
      conflictId: string;
      decision: ConflictResolutionDecision;
      adoptedFactId?: string;
      rationale?: string;
    }
  | { type: "fact_confirmation"; factIds: string[]; outcome: "confirmed" | "revoked"; rationale?: string }
  | { type: "unpublished_material_policy"; inputId: string; allowed: boolean; note?: string }
  | {
      type: "writing_pause";
      subject: string;
      decision: "pause" | "write_as_limitation" | "defer" | "attach_experiment_package";
      rationale?: string;
    }
  | {
      type: "table_alignment_confirmation";
      alignmentId: string;
      outcome: "confirmed" | "rejected";
      /** 拒绝时建议填写（记录到 evidence.rejectionReason） */
      rationale?: string;
    }
  | {
      type: "table_inheritance";
      assetId: string;
      outcome: "authorized" | "rejected";
      /** 学位论文题注改写（合法排版差异；数据不可变） */
      captionZh?: string;
      rationale?: string;
    }
  | { type: "missing_material_decision"; gapId: string; decision: MissingMaterialDecisionValue; rationale?: string };

export interface AuthorDecision {
  schemaVersion: 1;
  decisionId: string;
  projectId: string;
  type: AuthorDecisionType;
  actor: DecisionActor;
  payload: AuthorDecisionPayload;
  createdAt: string;
  applied: { at: string; effects: string[] };
}

// ---------------------------------------------------------------------------
// 下游（Planner / Writer）可消费的结构化输入
// ---------------------------------------------------------------------------

export interface ResearchInputSummary {
  inputId: string;
  inputType: ResearchInputType;
  title: string;
  workId: string;
  contentHash: string;
  versionLabel?: string;
  scope: ResearchInputScope;
  parseStatus: ResearchInputParseStatus;
  publicationStatus?: PublicationStatusValue;
  unpublishedMaterialAllowed?: boolean;
}

export interface FactView {
  factId: string;
  researchInputId: string;
  kind: FactKind;
  key: FactKey;
  surface: string;
  value: FactValue;
  verification: FactVerificationStatus;
  sourceCheck: FactVerificationState["sourceCheck"];
  conflictStatus: FactConflictStatus;
  location: string;
}

export interface PendingDecision {
  type: AuthorDecisionType;
  subject: string;
  reason: string;
}

export interface ResearchFactContext {
  schemaVersion: 1;
  generatedAt: string;
  projectId: string;
  inputs: {
    included: ResearchInputSummary[];
    excluded: ResearchInputSummary[];
    proposed: ResearchInputSummary[];
    superseded: ResearchInputSummary[];
    preferredVersionByWork: Record<string, string>;
  };
  facts: {
    /** 作者确认且无未决冲突：Writer 可作为作者已有成果引用 */
    authorConfirmed: FactView[];
    /** 来源核验通过但未经作者确认：只能作为「待确认」呈现，不得写成作者结论 */
    sourceVerifiedUnconfirmed: FactView[];
    /** 仅抽取：不得进入写作 prompt 的事实行 */
    extractedOnly: FactView[];
    /** 处于未决冲突：禁止使用 */
    conflicted: FactView[];
  };
  conflicts: { unresolved: FactConflict[]; resolved: FactConflict[]; deferred: FactConflict[] };
  pendingDecisions: PendingDecision[];
  /** 阻断写作的原因（非空 → 后续 Writer 阶段不得静默继续） */
  writingBlockers: string[];
}

export const RESEARCH_INPUT_ALGORITHM_VERSION = "m14.1c-v1";
