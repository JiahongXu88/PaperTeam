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
  created: { label: "已创建", tone: "ok" },
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

/** 目标可行性等级（research.feasibility / assessment.target / HITL payload 携带） */
export const FEASIBILITY_LEVEL_STYLES: Record<string, StatusStyle> = {
  HIGH: { label: "高", tone: "ok" },
  MEDIUM: { label: "中", tone: "info" },
  LOW: { label: "低", tone: "warn" },
  INSUFFICIENT: { label: "证据不足", tone: "danger" },
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

/**
 * (atomic claim, citation group) 语义核验 verdict（v4）。
 * INSUFFICIENT_EVIDENCE 视觉等级刻意弱于 UNSUPPORTED/CONTRADICTED（中性色）：
 * 它只表示自动核验无法判断，不是论文问题。
 */
export const SEMANTIC_VERDICT_STYLES: Record<string, StatusStyle> = {
  SUPPORTED: { label: "支持", tone: "ok" },
  PARTIALLY_SUPPORTED: { label: "部分支持", tone: "warn" },
  UNSUPPORTED: { label: "不支持", tone: "danger" },
  CONTRADICTED: { label: "存在矛盾", tone: "danger" },
  INSUFFICIENT_EVIDENCE: { label: "无法自动判断", tone: "neutral" },
  SKIPPED: { label: "跳过", tone: "neutral" },
  NO_CONTRADICTION_DETECTED: { label: "未发现明显矛盾", tone: "ok" },
};

/** 引用语义核验模式（off = 不执行；真实性核验不受影响，始终执行） */
export const CITATION_SEMANTIC_MODE_OPTIONS: ReadonlyArray<{
  value: "off" | "contradiction_only" | "full";
  label: string;
  help: string;
}> = [
  {
    value: "off",
    label: "关闭（推荐）",
    help: "仅核验参考文献真实性和元数据，不判断引用内容是否支持正文。",
  },
  {
    value: "contradiction_only",
    label: "仅检查明显冲突",
    help: "仅检查引用来源是否与正文论断存在明显矛盾。",
  },
  {
    value: "full",
    label: "完整核验",
    help: "逐条判断引用是否支持正文论断，耗时更长。",
  },
];

/** 语义核验模式 → 简短状态文案（Review 报告 / 运行中的克制展示） */
export const CITATION_SEMANTIC_MODE_LABELS: Record<string, string> = {
  off: "引用语义核验未开启",
  contradiction_only: "引用语义核验：仅检查明显冲突",
  full: "引用语义核验：完整核验",
};

/** 证据不足 / 跳过的结构化原因（与后端 InsufficientReasonCode 对应） */
export const REASON_CODE_LABELS: Record<string, string> = {
  NO_EVIDENCE: "只获取到书目 metadata，没有摘要/正文等可判证据",
  ABSTRACT_ONLY: "仅有摘要（或仓库描述）级证据，论断超出其支持范围",
  FULLTEXT_UNAVAILABLE: "全文无法获取",
  PROVIDER_ERROR: "模型/检索 provider 查询失败",
  REFERENCE_UNVERIFIED: "文献真实性未确立，语义核验跳过",
  LOW_RELEVANCE: "现有证据与论断相关性不足",
  UNQUOTED_CONTRADICTION: "判矛盾但引不出逐字反向引文，矛盾结论不可采信",
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

/** Review finding 严重度（tone 用于旧式 status 药丸；卡片 / 统计块用 severity 自己的语义色类） */
export const SEVERITY_STYLES: Record<string, StatusStyle> = {
  critical: { label: "严重", tone: "danger" },
  major: { label: "主要", tone: "warn" },
  minor: { label: "次要", tone: "info" },
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

/** Workflow stage → 用户可读名称（未知 stage 原样显示；与 backend definitions.ts 的 stage id 对齐） */
export const STAGE_LABELS: Record<string, string> = {
  // existing_paper_review
  "paper.ensure": "解析论文结构",
  "citation.extract": "提取引用",
  "citation.metadata": "核验引用真实性",
  "citation.claims": "核验论断与引用一致性",
  "review.sections": "分章节审阅",
  "review.aggregate": "生成 Review 报告",
  // idea_to_paper
  "research.idea": "调研",
  "research.feasibility": "可行性评估",
  "hitl.feasibility_confirm": "等待确认可行性",
  "outline.plan": "规划大纲",
  "hitl.outline_confirm": "等待确认大纲",
  "writing.sections": "分节写作",
  // 共享后段（idea_to_paper / existing_paper_improvement）
  "citation.verify": "引用核验",
  "review.run": "三路审阅",
  "quality.gate": "Quality Gate",
  "revision.revise": "修订",
  "revision.apply": "应用改进计划",
  "hitl.revision_overflow": "等待修订决策",
  "build.draft": "构建论文",
  // existing_paper_improvement
  "import.parse": "校验项目结构",
  "import.baseline_build": "基线编译",
  "import.understand": "论文理解",
  "assessment.target": "目标评估",
  "plan.improvement": "制定改进计划",
  "hitl.plan_confirm": "等待确认改进计划",
};

export const COMPLETION_LABELS: Record<string, string> = {
  final: "最终稿",
  draft: "草稿",
  review: "Review 报告",
};

export function stageLabel(stageId: string | undefined): string | undefined {
  return stageId === undefined ? undefined : (STAGE_LABELS[stageId] ?? stageId);
}

/**
 * 各 WorkflowKind 的 stage 顺序模板（时间线展示用）。
 * 与 backend definitions.ts 的 plan() 顺序一致；hitl = 等待用户输入的节点；
 * conditional = 按运行条件可能跳过 / 重复（展示为「按需」）。
 * 集中在这里维护，组件不得各自散落 switch。
 */
export interface StageSequenceEntry {
  stageId: string;
  hitl?: boolean;
  conditional?: boolean;
}

export const WORKFLOW_STAGE_SEQUENCES: Record<string, readonly StageSequenceEntry[]> = {
  existing_paper_review: [
    { stageId: "paper.ensure" },
    { stageId: "citation.extract" },
    { stageId: "citation.metadata" },
    { stageId: "citation.claims", conditional: true },
    { stageId: "review.sections" },
    { stageId: "review.aggregate" },
  ],
  idea_to_paper: [
    { stageId: "research.idea" },
    { stageId: "research.feasibility" },
    { stageId: "hitl.feasibility_confirm", hitl: true },
    { stageId: "outline.plan" },
    { stageId: "hitl.outline_confirm", hitl: true },
    { stageId: "writing.sections" },
    { stageId: "citation.verify" },
    { stageId: "review.run" },
    { stageId: "quality.gate" },
    { stageId: "revision.revise", conditional: true },
    { stageId: "hitl.revision_overflow", hitl: true, conditional: true },
    { stageId: "build.draft", conditional: true },
  ],
  existing_paper_improvement: [
    { stageId: "import.parse" },
    { stageId: "import.baseline_build" },
    { stageId: "import.understand" },
    { stageId: "citation.verify" },
    { stageId: "review.run" },
    { stageId: "assessment.target" },
    { stageId: "plan.improvement" },
    { stageId: "hitl.plan_confirm", hitl: true },
    { stageId: "revision.apply" },
    { stageId: "quality.gate" },
    { stageId: "revision.revise", conditional: true },
    { stageId: "hitl.revision_overflow", hitl: true, conditional: true },
    { stageId: "build.draft", conditional: true },
  ],
};

/** existing_paper_review：citationSemanticMode=off 时真实跳过 citation.claims（与后端 plan 一致） */
export function stageSequenceFor(kind: string | undefined, citationSemanticMode?: string): readonly StageSequenceEntry[] {
  const sequence = WORKFLOW_STAGE_SEQUENCES[kind ?? "idea_to_paper"] ?? [];
  if (kind === "existing_paper_review" && citationSemanticMode === "off") {
    return sequence.filter((entry) => entry.stageId !== "citation.claims");
  }
  return sequence;
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
