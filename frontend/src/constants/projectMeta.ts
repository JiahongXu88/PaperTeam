import type { WorkflowKind } from "../types/api.js";

/**
 * 项目定位字段的建议值与文案。
 *
 * documentType / targetProfile 与 Backend ProjectStore 的 DOCUMENT_TYPES /
 * TARGET_PROFILES 保持同步：存储层接受任意合法字符串，这里只是建议值，
 * 未知值原样展示（不虚构）。状态类标签统一在 components/common/status.ts。
 */

export const WORKFLOW_KIND_LABELS: Record<WorkflowKind, string> = {
  idea_to_paper: "想法成文",
  existing_paper_improvement: "论文改进",
  existing_paper_review: "论文 Review",
  topic_survey: "综述调研",
};

/**
 * 任务 / 活动记录语境的 workflowKind 文案（动作描述，比徽章缩略语更口语）。
 * 与 WORKFLOW_KIND_LABELS 一一对应，避免同一 kind 在不同页面出现第三种叫法。
 */
export const WORKFLOW_KIND_RUN_LABELS: Record<WorkflowKind, string> = {
  idea_to_paper: "从想法到论文",
  existing_paper_improvement: "系统性改进",
  existing_paper_review: "快速 Review",
  topic_survey: "综述论文生成",
};

/** documentType 建议值（Backend DOCUMENT_TYPES；research_article / survey 为创建页两档默认值，必须可显示） */
export const DOCUMENT_TYPE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "research_article", label: "研究论文" },
  { value: "survey", label: "综述论文" },
  { value: "undergraduate_thesis", label: "本科毕业论文" },
  { value: "master_thesis", label: "硕士学位论文" },
  { value: "doctoral_thesis", label: "博士学位论文" },
  { value: "journal_article", label: "期刊论文" },
  { value: "conference_paper", label: "会议论文" },
];

/** targetProfile 建议值（Backend TARGET_PROFILES） */
export const TARGET_PROFILE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
  { value: "course_paper", label: "课程论文" },
  { value: "undergraduate_thesis", label: "本科论文" },
  { value: "excellent_undergraduate_thesis", label: "优秀本科论文" },
  { value: "master_thesis", label: "硕士论文" },
  { value: "doctoral_thesis", label: "博士论文" },
  { value: "general_journal", label: "普通期刊" },
  { value: "core_journal", label: "核心期刊" },
  { value: "high_level_journal", label: "高水平期刊" },
  { value: "general_conference", label: "普通会议" },
  { value: "high_level_conference", label: "高水平会议" },
  { value: "top_conference", label: "顶会" },
  { value: "top_journal", label: "顶刊" },
];

/** 下拉建议值显示（未知值原样展示，不虚构） */
export function optionLabel(
  options: ReadonlyArray<{ value: string; label: string }>,
  value: string | undefined,
): string | undefined {
  return value === undefined || value === "" ? undefined : (options.find((o) => o.value === value)?.label ?? value);
}
