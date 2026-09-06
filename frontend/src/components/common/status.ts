/**
 * 状态语义注册表（Visual Redesign 2026-09）。
 *
 * 全应用唯一的状态 → tone 映射：项目 / Run / 引用真实性 / 语义 verdict /
 * Skill 状态都从这里取语义色，任何页面不再自定状态颜色。
 * tone 对应 components.css 的 .status-tone-*（dot + 文字色）。
 */

export type StatusTone = "neutral" | "ok" | "info" | "warn" | "danger" | "accent";

export interface StatusStyle {
  label: string;
  tone: StatusTone;
}

/** 项目状态（ProjectStatus） */
export const PROJECT_STATUS_STYLES: Record<string, StatusStyle> = {
  created: { label: "已创建", tone: "neutral" },
  generated: { label: "已生成", tone: "ok" },
  failed: { label: "失败", tone: "danger" },
};

/** WorkflowRun 状态 */
export const RUN_STATUS_STYLES: Record<string, StatusStyle> = {
  pending: { label: "排队中", tone: "neutral" },
  running: { label: "运行中", tone: "info" },
  awaiting_input: { label: "等待确认", tone: "warn" },
  completed: { label: "已完成", tone: "ok" },
  failed: { label: "失败", tone: "danger" },
  cancelled: { label: "已取消", tone: "neutral" },
};

/** 引用真实性（MetadataStatus）——中文标签，与全站状态语言一致 */
export const METADATA_STATUS_STYLES: Record<string, StatusStyle> = {
  VERIFIED: { label: "已验证", tone: "ok" },
  METADATA_MISMATCH: { label: "元数据不一致", tone: "warn" },
  AMBIGUOUS: { label: "待定", tone: "neutral" },
  NOT_FOUND: { label: "未找到", tone: "danger" },
  UNRESOLVED: { label: "待确认", tone: "neutral" },
};

/** (claim, citation) 语义核验 verdict */
export const SEMANTIC_VERDICT_STYLES: Record<string, StatusStyle> = {
  SUPPORTED: { label: "支持", tone: "ok" },
  PARTIALLY_SUPPORTED: { label: "部分支持", tone: "warn" },
  UNSUPPORTED: { label: "不支持", tone: "danger" },
  CONTRADICTED: { label: "存在矛盾", tone: "danger" },
  INSUFFICIENT_EVIDENCE: { label: "证据不足", tone: "neutral" },
  SKIPPED: { label: "跳过", tone: "neutral" },
};

/** PDF 解析质量 */
export const EXTRACTION_QUALITY_STYLES: Record<string, StatusStyle> = {
  good: { label: "良好", tone: "ok" },
  partial: { label: "部分", tone: "warn" },
  poor: { label: "较差", tone: "danger" },
};

/** 未知状态兜底：原样展示、中性色 */
export function statusStyleOf(
  registry: Record<string, StatusStyle>,
  key: string | undefined,
  fallbackLabel?: string,
): StatusStyle {
  if (key === undefined) {
    return { label: fallbackLabel ?? "—", tone: "neutral" };
  }
  return registry[key] ?? { label: key, tone: "neutral" };
}
