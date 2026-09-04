import type { ProjectStatus, WorkflowKind, WorkflowRunStatus } from "../types/api.js";

/**
 * 前端展示用的建议值集合与文案映射（M4.2）。
 *
 * documentType / targetProfile 的取值集合与 Backend ProjectStore 导出的
 * DOCUMENT_TYPES / TARGET_PROFILES 保持同步（Backend 侧注释明确其为
 * 「前端与 Prompt 使用的建议值集合，不在存储层冻结 enum」——存储仍接受
 * 任意合法字符串；如 Backend 增加建议值，需要同步这里）。
 */

export const WORKFLOW_KIND_LABELS: Record<WorkflowKind, string> = {
  idea_to_paper: "Idea → Paper",
  existing_paper_improvement: "已有论文改进",
};

export const PROJECT_STATUS_LABELS: Record<ProjectStatus, string> = {
  created: "已创建",
  generated: "已生成",
  failed: "失败",
};

export const RUN_STATUS_LABELS: Record<WorkflowRunStatus, string> = {
  pending: "排队中",
  running: "运行中",
  awaiting_input: "等待输入",
  completed: "已完成",
  failed: "失败",
  cancelled: "已取消",
};

/** documentType 建议值（Backend DOCUMENT_TYPES） */
export const DOCUMENT_TYPE_OPTIONS: ReadonlyArray<{ value: string; label: string }> = [
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
