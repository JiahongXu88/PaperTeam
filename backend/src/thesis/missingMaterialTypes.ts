/**
 * M14.6：MissingMaterialLedger 数据契约（research/missing-material-ledger.json）。
 *
 * 管理的对象是「学位论文生成目标所需 vs 真实研究输入所能支撑」之间的差距，
 * 不是第二套事实库，也不是"硕士论文应有的全部实验"清单。两类差距：
 *
 *   planned_chapter_material（A 类）  已确认章节映射中的某章拥有贡献，却没有可用
 *     的作者确认事实（或 experiment_result 贡献的数值陈述无事实支撑）。由 Planner
 *     的 missingMaterialChapters 确定性结果派生，本层只消费不重算。
 *   proposed_scope_gap（B 类）        研究范围可能偏窄（如单篇论文仅支撑一个贡献）。
 *     只能是建议：来自 storyline.scopeConcerns（确定性逐条）或有界模型提案；
 *     不断言作者"缺某个具体实验"，作者确认前不会生成具体材料需求。
 *
 * 状态由作者决定推进（模型 / 扫描只能产生 proposed）；上游指纹变化后不覆盖已有
 * 决定，而是标记 stale 等待重评。
 */

export type MissingMaterialGapType = "planned_chapter_material" | "proposed_scope_gap";

export const MISSING_MATERIAL_GAP_STATUSES = [
  "proposed",
  "confirmed_missing",
  "supplied",
  "resolved",
  "deferred",
  "rejected",
] as const;
export type MissingMaterialGapStatus = (typeof MISSING_MATERIAL_GAP_STATUSES)[number];

export type MissingMaterialGapOrigin = "deterministic" | "storyline_scope_concern" | "model_proposal";

export const MISSING_MATERIAL_DECISIONS = [
  "confirm_missing",
  "supply_experiment_data",
  "supply_research_record",
  "supply_manuscript",
  "write_as_limitation",
  "defer_chapter",
  "reject",
] as const;
export type MissingMaterialDecision = (typeof MISSING_MATERIAL_DECISIONS)[number];

export const REQUIRED_MATERIAL_KINDS = [
  "experiment_data",
  "research_record",
  "manuscript",
  "dataset_description",
  "author_confirmation",
] as const;
export type RequiredMaterialKind = (typeof REQUIRED_MATERIAL_KINDS)[number];

export interface RequiredMaterial {
  kind: RequiredMaterialKind;
  description: string;
}

export type MissingMaterialResolution =
  | "limitation"
  | "material_supplied"
  | "scope_rejected"
  | "chapter_deferred"
  | "facts_available";

export interface MissingMaterialGap {
  schemaVersion: 1;
  /** 稳定 id：g-<sha256(gapType|chapterId|normalizedTitle)[0:10]>；重复扫描幂等 */
  gapId: string;
  projectId: string;
  gapType: MissingMaterialGapType;
  origin: MissingMaterialGapOrigin;
  chapterId?: string;
  chapterTitleZh?: string;
  contributionIds: string[];
  sourceInputIds: string[];
  title: string;
  description: string;
  /** 为什么现有材料不足（陈述事实计数，不臆测） */
  whyInsufficient: string;
  /** 支撑该差距判定的证据坐标（"chapter:ch05" / "contribution:c-…" / "storyline.scopeConcerns[0]"） */
  supportingEvidence: string[];
  requiredMaterials: RequiredMaterial[];
  /** 不补材料也能写（以设计 / 理论 + 限制口径）；实验章为 false */
  canWriteWithoutMaterial: boolean;
  requiresExperiment: boolean;
  status: MissingMaterialGapStatus;
  decisionId?: string;
  decision?: MissingMaterialDecision;
  decisionRationale?: string;
  resolution?: MissingMaterialResolution;
  /** 上游指纹：fingerprintJson({gapType, chapterId, contributionIds(sorted), sourceInputs(sorted), outlineFingerprint}) */
  sourceFingerprint: string;
  /** 决定之后上游指纹变化：决定仍记录，但需重评 */
  stale?: { since: string; reason: string };
  createdAt: string;
  updatedAt: string;
}

export interface MissingMaterialLedgerFile {
  schemaVersion: 1;
  projectId: string;
  gaps: MissingMaterialGap[];
  lastEvaluatedAt?: string;
  updatedAt: string;
}

/** 扫描 / 模型提案能提交给账本的字段：状态、决定、时间戳由账本掌握 */
export type MissingMaterialGapProposal = Omit<
  MissingMaterialGap,
  "schemaVersion" | "projectId" | "status" | "createdAt" | "updatedAt" | "decisionId" | "decision" | "decisionRationale" | "resolution" | "stale"
>;

export interface UpsertProposalsResult {
  created: number;
  unchanged: number;
  refreshed: number;
  staleMarked: number;
}

export interface ReevaluateResult {
  resolved: number;
  unchanged: number;
}
