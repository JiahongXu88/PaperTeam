/**
 * 研究材料缺口的共享中文标签（MissingMaterialPanel 与 HitlPanel hitl.author_decision 共用）。
 *
 * 只放纯标签映射，不含任何业务逻辑；两处面板的动作集合各自维护
 * （账本 API 的 decision 与 workflow resume 的 option 命名不完全一致）。
 */

import type {
  MissingMaterialGapStatus,
  MissingMaterialGapType,
  MissingMaterialOrigin,
  RequiredMaterialKind,
} from "../../api/thesisMissingMaterials.js";

export const GAP_TYPE_LABELS: Record<MissingMaterialGapType, string> = {
  planned_chapter_material: "已规划章节缺材料",
  proposed_scope_gap: "研究范围建议（待作者确认）",
};

export const ORIGIN_LABELS: Record<MissingMaterialOrigin, string> = {
  deterministic: "系统检测",
  storyline_scope_concern: "Planner 建议",
  model_proposal: "模型建议",
};

export const STATUS_LABELS: Record<MissingMaterialGapStatus, string> = {
  proposed: "建议中",
  confirmed_missing: "已确认缺失",
  supplied: "材料已补充（待复核）",
  resolved: "已解决",
  deferred: "已暂缓",
  rejected: "已排除",
};

export const STATUS_BADGE_CLASS: Partial<Record<MissingMaterialGapStatus, string>> = {
  confirmed_missing: "badge-danger",
  resolved: "badge-ok",
};

export const MATERIAL_KIND_LABELS: Record<RequiredMaterialKind, string> = {
  experiment_data: "实验数据",
  research_record: "研究记录",
  manuscript: "研究手稿",
  dataset_description: "数据集说明",
  author_confirmation: "作者确认",
};

export const STALE_LABEL = "上游材料已变化，需重新评估";

export const MISSING_MATERIAL_BOUNDARY_NOTE = "缺口只有作者决定后才会影响写作；系统不会为缺失材料生成任何实验数值。";
