/**
 * ReviewFinding：结构化审稿结论的统一载体。
 *
 * 与既有 ReviewIssue（三路审稿的 workflow 内部结构）的区别：
 * ReviewFinding 是跨 review pass 持久化的领域事实——每条 finding 都带
 * section / page / chunk provenance 与状态机（open → resolved / dismissed），
 * 是 Citation Integrity Gate 与后续聚合层的输入。
 * 禁止让模型输出一坨 Markdown 作为唯一事实源。
 */

export const FINDING_CATEGORIES = [
  "fact",
  "academic",
  "style",
  "citation",
  "consistency",
  // M12.2 B3：视觉类目（figure/table 环境与图表一致性检查的产出）。
  // additive 追加在末尾——旧 JSON 不含该值仍可读，序列化路径零迁移。
  "visual",
] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export const FINDING_SEVERITIES = ["critical", "major", "minor", "info"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const FINDING_STATUSES = ["open", "resolved", "dismissed"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

/**
 * M12.2 B3 视觉 finding 的核验状态（Figure ≠ Evidence 纪律的落地形态）：
 * - verified_deterministic：确定性检查产出（label/ref/数字一致性等，机器可复核）；
 * - model_observation：vision 模型的结构化观察——**永远不是自动核验的证据**，
 *   只作为待作者复核的审稿事实呈现；
 * - needs_author_review：无法自动判定（启发式 caption 匹配 / 模型不确定 /
 *   检查执行失败后的显式待办），绝不静默丢弃。
 */
export const FINDING_VERIFICATION_STATUSES = [
  "verified_deterministic",
  "model_observation",
  "needs_author_review",
] as const;
export type FindingVerificationStatus = (typeof FINDING_VERIFICATION_STATUSES)[number];

/** 视觉检查自评置信度（与 vision/types.ts 的 VisionConfidence 值域对齐；本模块自持防反向依赖） */
export const FINDING_VISUAL_CONFIDENCES = ["high", "medium", "low"] as const;
export type FindingVisualConfidence = (typeof FINDING_VISUAL_CONFIDENCES)[number];

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

export interface ReviewFinding {
  findingId: string;
  category: FindingCategory;
  severity: FindingSeverity;
  /** provenance：至少 page / sectionId / chunkId / figureEnvRef（visual）之一必填（构造函数保证） */
  sectionId?: string;
  page?: number;
  chunkId?: string;
  /**
   * M12.2 B3 视觉锚（仅 visual 类目使用；additive 可选）：
   * VisualArtifactView id（如 "tex:main.tex:figure-2" / "pdf:S0001:B0005"）
   * 或 LaTeX 环境 ref。作为 provenance 的第四种形态（与 EvidenceLocation 的
   * figureBlockId 先例一致）。
   */
  figureEnvRef?: string;
  /** 资产预览路径（pdf: figures/<sid>/<name>；latex: includegraphics 相对路径；gen: figs/generated/…） */
  assetRef?: string;
  /** 视觉检查自评置信度（visual 类目；缺省 = 未给出） */
  visualConfidence?: FindingVisualConfidence;
  /** 核验状态（visual 类目；确定性检查恒 verified_deterministic，模型观察恒非 verified） */
  verificationStatus?: FindingVerificationStatus;
  /** 关联正文论断（citation / fact 类 finding 常有） */
  claimText?: string;
  message: string;
  suggestion?: string;
  evidenceIds?: string[];
  citationIds?: string[];
  referenceId?: string;
  status: FindingStatus;
  /** 产生该 finding 的 review pass（如 "citation-integrity" / "section-review"） */
  source: string;
  createdAt: string;
  updatedAt: string;
}

/** severity 排序权重（聚合与展示排序用） */
const SEVERITY_ORDER: Record<FindingSeverity, number> = {
  critical: 3,
  major: 2,
  minor: 1,
  info: 0,
};

export function severityRank(severity: FindingSeverity): number {
  return SEVERITY_ORDER[severity];
}

/** 构造 finding（强制 provenance 与时间戳，禁止拼裸对象散落各处） */
export function createFinding(input: {
  findingId: string;
  category: FindingCategory;
  severity: FindingSeverity;
  message: string;
  source: string;
  now: string;
  sectionId?: string;
  page?: number;
  chunkId?: string;
  figureEnvRef?: string;
  assetRef?: string;
  visualConfidence?: FindingVisualConfidence;
  verificationStatus?: FindingVerificationStatus;
  claimText?: string;
  suggestion?: string;
  evidenceIds?: string[];
  citationIds?: string[];
  referenceId?: string;
}): ReviewFinding {
  if (
    input.sectionId === undefined &&
    input.page === undefined &&
    input.chunkId === undefined &&
    // M12.2 B3：visual 类目允许以 figureEnvRef 作为唯一 provenance
    //（图表锚本身即可定位；见 ReviewFinding.figureEnvRef 注释）
    input.figureEnvRef === undefined
  ) {
    throw new Error(
      `createFinding(${input.findingId}) 缺少 provenance：需要 sectionId / page / chunkId / figureEnvRef 至少其一`,
    );
  }
  if (input.message.trim() === "") {
    throw new Error(`createFinding(${input.findingId}) message 不能为空`);
  }
  return {
    findingId: input.findingId,
    category: input.category,
    severity: input.severity,
    ...(input.sectionId !== undefined ? { sectionId: input.sectionId } : {}),
    ...(input.page !== undefined ? { page: input.page } : {}),
    ...(input.chunkId !== undefined ? { chunkId: input.chunkId } : {}),
    ...(input.figureEnvRef !== undefined ? { figureEnvRef: input.figureEnvRef } : {}),
    ...(input.assetRef !== undefined ? { assetRef: input.assetRef } : {}),
    ...(input.visualConfidence !== undefined ? { visualConfidence: input.visualConfidence } : {}),
    ...(input.verificationStatus !== undefined
      ? { verificationStatus: input.verificationStatus }
      : {}),
    ...(input.claimText !== undefined ? { claimText: input.claimText } : {}),
    message: input.message,
    ...(input.suggestion !== undefined ? { suggestion: input.suggestion } : {}),
    ...(input.evidenceIds !== undefined && input.evidenceIds.length > 0
      ? { evidenceIds: input.evidenceIds }
      : {}),
    ...(input.citationIds !== undefined && input.citationIds.length > 0
      ? { citationIds: input.citationIds }
      : {}),
    ...(input.referenceId !== undefined ? { referenceId: input.referenceId } : {}),
    status: "open",
    source: input.source,
    createdAt: input.now,
    updatedAt: input.now,
  };
}

/**
 * 防御性读取（磁盘 JSON → ReviewFinding；结构损坏返回 undefined）。
 *
 * M12.2 B3 additive 语义：
 * - 旧 JSON（无 figureEnvRef/assetRef/visualConfidence/verificationStatus、
 *   category 不含 visual）必须原样可读——新字段全部 optional，缺省即通过；
 * - 新字段「存在但类型/枚举非法」视为结构损坏（整条丢弃并计入 readFindings
 *   的 dropped，绝不带病进聚合层）；
 * - provenance 判定同步扩展：visual 类目允许仅 figureEnvRef。
 */
export function readFinding(value: unknown): ReviewFinding | undefined {
  if (typeof value !== "object" || value === null) {
    return undefined;
  }
  const record = value as Record<string, unknown>;
  const findingId = typeof record["findingId"] === "string" ? record["findingId"] : undefined;
  const message = typeof record["message"] === "string" ? record["message"] : undefined;
  const category = record["category"];
  const severity = record["severity"];
  const status = record["status"];
  const source = typeof record["source"] === "string" ? record["source"] : undefined;
  const createdAt = typeof record["createdAt"] === "string" ? record["createdAt"] : undefined;
  const figureEnvRef = record["figureEnvRef"];
  const assetRef = record["assetRef"];
  const visualConfidence = record["visualConfidence"];
  const verificationStatus = record["verificationStatus"];
  if (
    findingId === undefined ||
    message === undefined ||
    source === undefined ||
    createdAt === undefined ||
    !isOneOf(FINDING_CATEGORIES, category) ||
    !isOneOf(FINDING_SEVERITIES, severity) ||
    !isOneOf(FINDING_STATUSES, status) ||
    (record["sectionId"] === undefined &&
      record["page"] === undefined &&
      record["chunkId"] === undefined &&
      figureEnvRef === undefined) ||
    (figureEnvRef !== undefined && typeof figureEnvRef !== "string") ||
    (assetRef !== undefined && typeof assetRef !== "string") ||
    (visualConfidence !== undefined && !isOneOf(FINDING_VISUAL_CONFIDENCES, visualConfidence)) ||
    (verificationStatus !== undefined && !isOneOf(FINDING_VERIFICATION_STATUSES, verificationStatus))
  ) {
    return undefined;
  }
  return value as ReviewFinding;
}

/** 读取一组 finding（checkpoint / 报告 JSON），损坏条目丢弃并计数 */
export function readFindings(value: unknown): { findings: ReviewFinding[]; dropped: number } {
  if (!Array.isArray(value)) {
    return { findings: [], dropped: 0 };
  }
  const findings: ReviewFinding[] = [];
  let dropped = 0;
  for (const entry of value) {
    const finding = readFinding(entry);
    if (finding === undefined) {
      dropped += 1;
    } else {
      findings.push(finding);
    }
  }
  return { findings, dropped };
}
