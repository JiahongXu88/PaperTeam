/**
 * M6.8 Evaluation Framework 共享类型。
 *
 * 本目录是评估基建（evaluation infrastructure），不是产品功能：
 * - 不新增 Agent / 不修改 Runtime / Workflow / Evidence Pipeline / Writer /
 *   Reviewer（M6.8 红线）；
 * - 全部实验在独立 PROJECTS_ROOT 命名空间内运行，靠真实服务
 *   （EvidenceGrounding / Retrieval / Revision Validation / Quality Gate /
 *   WorkflowOrchestrator）+ scripted fault injection 驱动；
 * - ground truth（故障类别 / 期望证据 / 期望产物）全部声明在 scenario 数据里，
 *   指标是纯函数：由「系统产出 vs ground truth」确定性计算。
 *
 * 如实边界：scripted（无真实模型）实验回答的是「确定性安全机制对注入故障
 * 的拦截率 / 管线保障」，不是「真实模型生成质量」——后者需要后续 live run
 * （人工校准接口已预留）。
 */

// ============================================================
// Experiment 1：Evidence Grounding Evaluation
// ============================================================

/** 注入故障类别（ground truth；指标据此判定） */
export type GroundingFaultClass =
  /** 引文捏造：quote 并非逐字存在于所指 chunk（或 chunk 之外任何语料） */
  | "fabricated_quote"
  /** 论断越界：quote 逐字真实，但 claim 超出原文支撑范围 */
  | "unsupported_claim"
  /** 元数据冲突：来源元数据（年份 / 标题 / 作者）与权威记录矛盾 */
  | "metadata_mismatch";

/** 语料来源（自造学术示例文本；确定性，不依赖网络） */
export interface GroundingCorpusSource {
  fileName: string;
  title: string;
  year: number;
  authors?: string[];
  content: string;
  /**
   * 权威记录元数据冲突（metadata_mismatch 故障的 ground truth）：
   * true = 本来源存储的元数据被故意写错（如年份错位），
   * GroundTruthResolverProvider 会返回 mismatch；此时 authoritativeYear
   * 必填（权威年份，与存储的 year 字段冲突才有可判定的 mismatch）。
   */
  metadataCorrupted?: boolean;
  authoritativeYear?: number;
}

/** 可支撑论断（正例）：claim 应能在 locator 指向的原文中被逐字锚定并核验通过 */
export interface SupportableClaim {
  claim: string;
  /** quote 必须逐字出现在该来源内容里（chunk 锚点由此解析） */
  locator: { fileName: string; needle: string };
  summary?: string;
}

/** 注入的故障提案（researcher 风格 evidence proposal，带 ground truth 标注） */
export interface GroundingFault {
  id: string;
  claim: string;
  /** fabricated_quote 时为捏造文本；unsupported_claim 时为真实逐字引文 */
  quote: string;
  faultClass: GroundingFaultClass;
  /**
   * quote 的真实出处（unsupported_claim / 部分 fabricated_quote 需要：
   * 前者 quote 逐字来自该处、claim 越界；后者 anchor 到该来源但 quote 捏造）。
   */
  locator?: { fileName: string; needle: string };
  /**
   * RAG 臂的行为建模（测量值，不是假设）：claim 关键词经真实 RetrievalService
   * 检索能命中语料时，RAG 生成器会把 quote 替换为检索 chunk 的逐字切片
   * （引文捏造被检索条件化消除，但论断支撑不变）。运行期由 harness 实测。
   */
  ragRetrievable?: boolean;
}

export interface GroundingScenario {
  kind: "grounding";
  id: string;
  title: string;
  description: string;
  corpus: GroundingCorpusSource[];
  supportable: SupportableClaim[];
  faults: GroundingFault[];
}

/** 单条提案在某一臂的处置结果（指标计算的原子输入） */
export interface GroundingProposalOutcome {
  /** scenario 内唯一标识（正例 = `ok:<claim>`，故障 = fault.id） */
  key: string;
  claim: string;
  /** ground truth */
  claimSupported: boolean;
  quoteVerbatim: boolean;
  metadataCorrect: boolean;
  faultClass: GroundingFaultClass | null;
  /** 该臂的处置：accepted（进入证据池）/ rejected-<原因> */
  disposition: "accepted" | "rejected_quote_mismatch" | "rejected_metadata_mismatch" | "rejected_judge" | "rejected_other";
}

export interface GroundingArmResult {
  arm: "plain-llm" | "rag" | "paperteam";
  scenarioId: string;
  outcomes: GroundingProposalOutcome[];
  metrics: GroundingMetrics;
}

export interface GroundingMetrics {
  /** 进入证据池的提案总数 */
  accepted: number;
  unsupportedClaimRate: number;
  fabricatedCitationRate: number;
  /** 命中的正例 / scenario 正例总数（召回） */
  evidenceCoverage: number;
  /** 各处置通道计数（paperteam 臂：三段核验各拦多少） */
  dispositions: Record<string, number>;
}

// ============================================================
// Experiment 2：Revision Safety Evaluation
// ============================================================

export type RevisionFaultMarker = "fact:mutate" | "cite:drop" | "strength:escalate";

export type RevisionViolationKind = "fact" | "citation" | "strength";

export interface RevisionScenario {
  kind: "revision";
  id: string;
  title: string;
  description: string;
  /** researchIdea 注入的故障标记（复用 scriptedRuntime 既有注入；null = 干净对照） */
  marker: RevisionFaultMarker | null;
  /** review 轮次序列（驱动修订环进入 revision.validate） */
  reviewSequence: ("pass" | "fail" | "fail2" | "fail3")[];
  /** ground truth：本场景注入的违规类别 */
  injectedViolations: RevisionViolationKind[];
  /** 终稿判定 needles：mutated 事实串（\beta、无依据数值等） */
  mutatedFactNeedles: string[];
  /** 终稿必须保留的引用 key（丢失即 citation violation 存活） */
  mustKeepCitationKeys: string[];
  /** 强度升级句 needles */
  escalationNeedles: string[];
  /** 干净对照：true 时任何 preservation/validation 拦截都计为误拦 */
  expectedClean: boolean;
}

/** 单场景 × 单臂的观测记录 */
export interface RevisionScenarioRunRecord {
  scenarioId: string;
  arm: "baseline" | "paperteam";
  /** 冗余自 scenario（指标计算免于回查数据集） */
  injectedViolations: RevisionViolationKind[];
  expectedClean: boolean;
  /** 注入的违规是否存活到「被接受的稿件」（baseline=Writer 原样接受；paperteam=终态产物） */
  factSurvived: boolean | null;
  citationSurvived: boolean | null;
  strengthSurvived: boolean | null;
  /** 系统是否给出任何拦截信号（validation finding / gate FAIL / HITL） */
  flagged: boolean;
  flagChannels: string[];
  /** run 终态（paperteam 臂；baseline 臂无 run） */
  runOutcome: { status: string; label: string | null } | null;
  /** 修订复核产物摘要（round → blocked/reasonCodes） */
  validationRounds: Array<{ round: number; blocked: boolean; reasonCodes: string[] }>;
  /** gate 产物摘要（round → 规则通过表） */
  gateRounds: Array<{ round: number; failedRules: string[] }>;
  /** 出现过的 HITL stage */
  hitlStages: string[];
}

export interface RevisionArmResult {
  arm: "baseline" | "paperteam";
  records: RevisionScenarioRunRecord[];
  metrics: RevisionSafetyMetrics;
}

export interface RevisionSafetyMetrics {
  scenarios: number;
  factInjected: number;
  citationInjected: number;
  strengthInjected: number;
  cleanScenarios: number;
  /** 违规存活率（按类别；分母为注入数） */
  factViolationRate: number | null;
  citationLossRate: number | null;
  claimEscalationRate: number | null;
  /** 注入违规零信号放行占比（越高越不可靠） */
  falseAcceptanceRate: number;
  /** 干净修订被误拦占比（over-blocking；越低越好） */
  falseRejectionRate: number | null;
}

// ============================================================
// Experiment 3：Agent Workflow Evaluation
// ============================================================

export interface WorkflowScenario {
  kind: "workflow";
  id: string;
  title: string;
  description: string;
  researchIdea: string;
  reviewSequence: ("pass" | "fail" | "fail2" | "fail3")[];
  /** 语料（可选）：正例候选在 run 前预置进候选队列，经 evidence.ground 转正 */
  corpus?: GroundingCorpusSource[];
  preseedClaims?: SupportableClaim[];
  expected: {
    /** 必须到达（completed）的 stage */
    stages: string[];
    /** 大纲章节文件（scripted outline 固定五节） */
    sectionFiles: string[];
    /** 终稿必须出现的引用 key */
    citationKeys: string[];
    /** 核心论断 needle（终稿必须包含） */
    claimNeedles: string[];
  };
  /** 单次生成基线的代表性输出（scripted 数据：裸 LLM 无管线的典型产物） */
  plainBaseline: {
    output: string;
    /** 输出中 \cite 的 key 里属于捏造（不存在于任何合法 bibliography）的部分 */
    fabricatedCitationKeys: string[];
    /** 无证据支撑的论断 needle（数字 / 强断言） */
    unsupportedClaimNeedles: string[];
  };
}

export interface WorkflowArmResult {
  arm: "plain-llm" | "paperteam";
  scenarioId: string;
  metrics: WorkflowMetrics;
  detail: {
    stagesCompleted: string[];
    stagesMissing: string[];
    sectionsWritten: string[];
    citationsInOutput: string[];
    verifiedEvidenceCount: number;
    evidenceBackedCitedKeys: string[];
    runOutcome: { status: string; label: string | null } | null;
  };
}

export interface WorkflowMetrics {
  /** 被引用论断中可追溯到 verified evidence 的占比（plain 臂结构上为 0） */
  claimCorrectness: number;
  /** 输出中引用 key 正确（存在于合法 bibliography 且经核验）占比 */
  citationCorrectness: number;
  /** 期望产物完整度：stage / 章节 / 论断 needle / 引用 四项平均 */
  completeness: number;
  /** 人工偏好：校准记录存在时为偏好 paperteam 臂的占比；无记录 = null */
  humanPreference: number | null;
}

// ============================================================
// 人工校准（Human Calibration）
// ============================================================

export interface CalibrationRecord {
  experiment: 1 | 2 | 3;
  scenarioId: string;
  arm: string;
  /** 被评判的对象（claim 文本 / 违规判定 / 产出对比描述） */
  claim: string;
  /** 自动指标的预测（unsupported / supported / violated / clean …） */
  prediction: string;
  /** 人工标注（与 prediction 同一取值空间） */
  humanLabel: string;
  reason: string;
  recordedAt?: string;
}

export interface CalibrationSummary {
  records: number;
  valid: number;
  malformed: number;
  /** prediction === humanLabel 占比（valid 记录上） */
  agreementRate: number | null;
  perPrediction: Array<{ prediction: string; total: number; agreed: number }>;
  parseErrors: string[];
}

// ============================================================
// 报告
// ============================================================

export interface EvaluationReport {
  schemaVersion: 1;
  milestone: "M6.8";
  generatedAt: string;
  runner: {
    mode: "offline-scripted";
    hitlPolicy: RevisionHitlPolicy;
    scenarios: { experiment1: string[]; experiment2: string[]; experiment3: string[] };
  };
  experiments: Array<
    | { experiment: 1; name: "evidence-grounding"; arms: GroundingArmResult[]; aggregate: Record<string, GroundingMetrics>; comparison: Record<string, unknown>; limitations: string[] }
    | { experiment: 2; name: "revision-safety"; arms: RevisionArmResult[]; aggregate: { baseline: RevisionSafetyMetrics; paperteam: RevisionSafetyMetrics }; comparison: Record<string, unknown>; limitations: string[] }
    | { experiment: 3; name: "agent-workflow"; arms: WorkflowArmResult[]; aggregate: Record<string, WorkflowMetrics>; comparison: Record<string, unknown>; limitations: string[] }
  >;
  calibration: CalibrationSummary;
}

/** hitl.revision_validation 的处置策略（Experiment 2 paperteam 臂） */
export type RevisionHitlPolicy = "reject" | "approve" | "needs_review";
