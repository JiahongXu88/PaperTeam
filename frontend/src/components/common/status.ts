/**
 * 状态 / 标签注册表：全应用唯一的"后端枚举 → 中文标签 + 语义色"映射。
 * 项目 / Run / 引用真实性 / 语义 verdict / 解析质量 / Stage / Finding 都从这里取，
 * 页面不再各自维护映射；未知值原样展示、中性色，不虚构。
 */

export type StatusTone = "neutral" | "ok" | "info" | "warn" | "danger" | "accent";

export interface StatusStyle {
  label: string;
  tone: StatusTone;
}

export const PROJECT_STATUS_STYLES: Record<string, StatusStyle> = {
  created: { label: "已创建", tone: "neutral" },
  generated: { label: "已生成", tone: "ok" },
  failed: { label: "失败", tone: "danger" },
};

export const RUN_STATUS_STYLES: Record<string, StatusStyle> = {
  pending: { label: "排队中", tone: "neutral" },
  running: { label: "运行中", tone: "info" },
  awaiting_input: { label: "等待确认", tone: "warn" },
  completed: { label: "已完成", tone: "ok" },
  failed: { label: "失败", tone: "danger" },
  cancelled: { label: "已取消", tone: "neutral" },
};

/** 引用真实性（外部权威源确定性核验：学术库 + 软件官方仓库） */
export const METADATA_STATUS_STYLES: Record<string, StatusStyle> = {
  VERIFIED: { label: "已验证", tone: "ok" },
  METADATA_MISMATCH: { label: "元数据不一致", tone: "warn" },
  AMBIGUOUS: { label: "待确认", tone: "neutral" },
  NOT_FOUND: { label: "未找到", tone: "danger" },
  PROVIDER_ERROR: { label: "核验暂未完成", tone: "warn" },
  UNRESOLVED: { label: "核验暂未完成", tone: "warn" },
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

/** 证据不足 / 跳过的结构化原因（与后端 InsufficientReasonCode 对应） */
export const REASON_CODE_LABELS: Record<string, string> = {
  NO_EVIDENCE: "只获取到书目 metadata，没有摘要/正文等可判证据",
  ABSTRACT_ONLY: "仅有摘要（或仓库描述）级证据，论断超出其支持范围",
  FULLTEXT_UNAVAILABLE: "全文无法获取",
  PROVIDER_ERROR: "模型/检索 provider 查询失败",
  REFERENCE_UNVERIFIED: "文献真实性未确立，语义核验跳过",
  LOW_RELEVANCE: "现有证据与论断相关性不足",
};

/** 引用条目类型 */
export const REFERENCE_KIND_LABELS: Record<string, string> = {
  scholarly_paper: "学术论文",
  software: "软件",
  dataset: "数据集",
  documentation: "文档",
  web_resource: "网络资源",
  unknown: "未知类型",
};

/** 证据等级 */
export const EVIDENCE_LEVEL_LABELS: Record<string, string> = {
  abstract: "摘要",
  metadata: "书目元数据",
  snippet: "检索片段",
  web: "网页",
  fulltext: "全文",
  repository: "官方仓库",
  official_docs: "官方文档",
};

export const EXTRACTION_QUALITY_STYLES: Record<string, StatusStyle> = {
  good: { label: "良好", tone: "ok" },
  partial: { label: "部分", tone: "warn" },
  poor: { label: "较差", tone: "danger" },
};

export const SKILL_STATUS_STYLES: Record<string, StatusStyle> = {
  installed: { label: "已安装", tone: "ok" },
  disabled: { label: "已停用", tone: "warn" },
};

/** Review finding 严重度 */
export const SEVERITY_STYLES: Record<string, StatusStyle> = {
  critical: { label: "严重", tone: "danger" },
  major: { label: "主要", tone: "warn" },
  minor: { label: "次要", tone: "neutral" },
  info: { label: "提示", tone: "neutral" },
};

export const SEVERITY_ORDER = ["critical", "major", "minor", "info"] as const;

export const FINDING_CATEGORY_LABELS: Record<string, string> = {
  fact: "事实",
  academic: "学术",
  style: "表达",
  citation: "引用",
  consistency: "一致性",
};

/** Workflow stage → 用户可读名称（未知 stage 原样显示） */
export const STAGE_LABELS: Record<string, string> = {
  "paper.ensure": "解析论文结构",
  "citation.extract": "提取引用",
  "citation.metadata": "核验引用真实性",
  "citation.claims": "核验论断与引用一致性",
  "review.sections": "分章节审阅",
  "review.aggregate": "生成 Review 报告",
  "research.idea": "调研",
  "research.feasibility": "可行性评估",
  "hitl.feasibility_confirm": "等待确认可行性",
  "outline.plan": "规划大纲",
  "hitl.outline_confirm": "等待确认大纲",
  "write.sections": "分节写作",
  "citation.verify": "引用核验",
  "review.run": "三路审阅",
  "quality.gate": "Quality Gate",
  "build.gate": "Build Gate",
};

export const COMPLETION_LABELS: Record<string, string> = {
  final: "最终稿",
  draft: "草稿",
  review: "Review 报告",
};

export function stageLabel(stageId: string | undefined): string | undefined {
  return stageId === undefined ? undefined : (STAGE_LABELS[stageId] ?? stageId);
}

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
