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

// ---- Quality Gate（ruleId 集中注册；判定永远来自 Backend，这里只做展示映射） ----

/** gate 规则的展示与导航属性；target = 失败时可跳转的处理入口（按稳定 ruleId 派生，不解析 reason 文本） */
export interface GateRuleStyle {
  label: string;
  /** 该规则检查什么（一句话；FAIL 时帮助用户理解为什么这是 blocker） */
  description: string;
  /** blocker 的处理入口（缺省 = 留在门禁面板，看同轮审稿上下文 / 继续修订流程） */
  target?: { tab: "citations" | "evidence" | "overview"; evidenceAttention?: boolean };
}

export const GATE_RULE_STYLES: Record<string, GateRuleStyle> = {
  // 基础 9 条（quality/gates.ts；两条 workflow 与手动 API 都会产出）
  hallucinated_citations_zero: {
    label: "无虚构引用",
    description: "参考文献在公开学术库中不应被多源判定为查无此文。",
    target: { tab: "citations" },
  },
  citation_structure_valid: {
    label: "引用结构完整",
    description: "正文 \\cite 与参考文献一一对应，无缺失 / 重复 / 坏引用。",
    target: { tab: "citations" },
  },
  no_contradictory_evidence: {
    label: "无矛盾证据",
    description: "证据库中不存在与论文论断相矛盾的已核验证据。",
    target: { tab: "evidence", evidenceAttention: true },
  },
  unsupported_critical_claims_zero: {
    label: "关键论断有支撑",
    description: "事实审稿不应发现无支撑或被反驳的关键论断。",
  },
  blocking_issues_zero: {
    label: "无阻断性问题",
    description: "审稿意见中不应存在标记为阻断（blocking）的问题。",
  },
  open_critical_major_zero: {
    label: "严重与主要问题清零",
    description: "未解决的 critical / major 审稿问题应为 0。",
  },
  academic_score_threshold: {
    label: "学术评分达标",
    description: "学术审稿总分需达到当前目标的最低分（阈值见门禁设置）。",
  },
  style_risk_threshold: {
    label: "文风风险可控",
    description: "文风风险分不应超过当前目标的上限（阈值见门禁设置）。",
  },
  target_feasibility: {
    label: "目标可行性达标",
    description: "研究目标相对当前证据基础的可行性不应为低或证据不足。",
    target: { tab: "overview" },
  },
  // Citation Integrity 组（仅当 gate 输入包含引用完整性统计时出现；当前 workflow 不注入）
  citation_fabrication_zero: {
    label: "无疑似捏造引用",
    description: "多个学术库一致查无此文的引用应为 0（需人工确认后修复）。",
    target: { tab: "citations" },
  },
  citation_not_found_obligatory_zero: {
    label: "必需引用可查证",
    description: "支撑关键论断的引用不应处于「学术库未找到」状态。",
    target: { tab: "citations" },
  },
  citation_metadata_mismatch_critical_zero: {
    label: "关键元数据一致",
    description: "标题 / DOI 级别与学术库不符的引用应为 0。",
    target: { tab: "citations" },
  },
  citation_unsupported_critical_zero: {
    label: "关键论断引用有支撑",
    description: "语义核验判为不支持 / 矛盾的关键论断引用应为 0。",
    target: { tab: "citations" },
  },
  citation_semantic_verification_off: {
    label: "引用语义核验未开启",
    description: "本轮未开启引用语义核验，语义类规则不参与判定（不是失败）。",
    target: { tab: "citations" },
  },
  citation_insufficient_evidence_review: {
    label: "证据不足人工复核",
    description: "自动核验无法判断的引用需要人工复核，但不阻断进入 Final。",
    target: { tab: "citations" },
  },
};

/**
 * 语义为「不参与判定 / 人工复核」的规则（后端恒 passed:true）：展示为中性
 * 「未参与」而不是绿色「通过」，避免把「没检查」误读成「检查了且没问题」。
 * INSUFFICIENT_EVIDENCE ≠ 论文错误，刻意不用 danger 色。
 */
export const GATE_RULES_NEUTRAL: ReadonlySet<string> = new Set([
  "citation_semantic_verification_off",
  "citation_insufficient_evidence_review",
]);

/** gate 整体结论（PASS 只表示允许进入 Final，不是「论文完美」） */
export const GATE_OUTCOME_STYLES: Record<string, StatusStyle> = {
  passed: { label: "通过", tone: "ok" },
  failed: { label: "未通过", tone: "danger" },
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

/** Evidence 核验状态（EvidenceStore VerificationStatus；与 Citation 的核验状态是两套语义） */
export const EVIDENCE_VERIFICATION_STYLES: Record<string, StatusStyle> = {
  unverified: { label: "待核验", tone: "neutral" },
  verified: { label: "已核验", tone: "ok" },
  plausible: { label: "大体可信", tone: "info" },
  mismatch: { label: "与来源不符", tone: "danger" },
  unverifiable: { label: "无法核验", tone: "warn" },
  not_found: { label: "未找到来源", tone: "danger" },
};

/** 证据支撑强度（contradictory 是 Quality Gate 的 no_contradictory_evidence 依据） */
export const SUPPORT_STRENGTH_STYLES: Record<string, StatusStyle> = {
  direct: { label: "直接支撑", tone: "ok" },
  partial: { label: "部分支撑", tone: "info" },
  indirect: { label: "间接相关", tone: "neutral" },
  contradictory: { label: "与论断矛盾", tone: "danger" },
};

/** 证据核验深度 */
export const VERIFICATION_LEVEL_LABELS: Record<string, string> = {
  metadata: "书目信息",
  abstract: "摘要级",
  fulltext: "全文级",
  user_confirmed: "人工确认",
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
  "revision.plan": "生成修订计划",
  "revision.revise": "修订",
  "revision.apply": "应用改进计划",
  "revision.repair_latex": "修复编译错误",
  "hitl.revision_stalled": "等待修订决策",
  "hitl.revision_overflow": "等待修订决策",
  "build.draft": "构建论文",
  "build.final": "生成 Final",
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

/**
 * 修订迭代收敛结论（iteration-history outcome；确定性判定，无 LLM）。
 * PASS / IMPROVED = 继续推进；CONVERGED（连续无实质改善）/ REGRESSION（退化）
 * = 转 HITL；MAX 迭代由 overflow HITL 承载（不在 outcome 枚举中）。
 */
export const ITERATION_OUTCOME_STYLES: Record<string, StatusStyle> = {
  PASS: { label: "已通过", tone: "ok" },
  IMPROVED: { label: "有实质改善", tone: "info" },
  CONVERGED: { label: "不再收敛", tone: "warn" },
  REGRESSION: { label: "出现退化", tone: "danger" },
};

/** 修订来源（ManuscriptVersionDTO.source）的中文标签：用户看到的是业务动作，不是工程标识 */
export const REVISION_SOURCE_LABELS: Record<string, string> = {
  baseline: "初始基线",
  "outline.plan": "大纲定稿",
  "writing.sections": "初稿写作",
  "review.snapshot": "审稿快照",
  "revision.revise": "审稿修订",
  "revision.apply": "应用改进计划",
  "revision.repair_latex": "编译修复",
  "revision.restore": "版本恢复",
};

/** 版本比较的章节状态标签（确定性 diff 结果） */
export const COMPARE_STATUS_STYLES: Record<string, StatusStyle> = {
  unchanged: { label: "未变化", tone: "neutral" },
  modified: { label: "已修改", tone: "info" },
  added: { label: "新增", tone: "ok" },
  removed: { label: "已移除", tone: "warn" },
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
    { stageId: "revision.plan", conditional: true },
    { stageId: "revision.revise", conditional: true },
    { stageId: "hitl.revision_stalled", hitl: true, conditional: true },
    { stageId: "hitl.revision_overflow", hitl: true, conditional: true },
    { stageId: "build.draft", conditional: true },
    { stageId: "revision.repair_latex", conditional: true },
    { stageId: "build.final", conditional: true },
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
    { stageId: "revision.plan", conditional: true },
    { stageId: "revision.revise", conditional: true },
    { stageId: "hitl.revision_stalled", hitl: true, conditional: true },
    { stageId: "hitl.revision_overflow", hitl: true, conditional: true },
    { stageId: "build.draft", conditional: true },
    { stageId: "revision.repair_latex", conditional: true },
    { stageId: "build.final", conditional: true },
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
