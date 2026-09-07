/**
 * ReviewFinding（M4.3.0）：结构化审稿结论的统一载体。
 *
 * 与既有 ReviewIssue（M3.2 三路审稿的 workflow 内部结构）的区别：
 * ReviewFinding 是跨 review pass 持久化的领域事实——每条 finding 都带
 * section / page / chunk provenance 与状态机（open → resolved / dismissed），
 * 是 Citation Integrity Gate 与后续聚合层的输入。
 * 禁止让模型输出一坨 Markdown 作为唯一事实源（M4.3 原则）。
 */

export const FINDING_CATEGORIES = ["fact", "academic", "style", "citation", "consistency"] as const;
export type FindingCategory = (typeof FINDING_CATEGORIES)[number];

export const FINDING_SEVERITIES = ["critical", "major", "minor", "info"] as const;
export type FindingSeverity = (typeof FINDING_SEVERITIES)[number];

export const FINDING_STATUSES = ["open", "resolved", "dismissed"] as const;
export type FindingStatus = (typeof FINDING_STATUSES)[number];

function isOneOf<T extends string>(values: readonly T[], value: unknown): value is T {
  return typeof value === "string" && (values as readonly string[]).includes(value);
}

export interface ReviewFinding {
  findingId: string;
  category: FindingCategory;
  severity: FindingSeverity;
  /** provenance：至少 page / sectionId / chunkId 之一必填（构造函数保证） */
  sectionId?: string;
  page?: number;
  chunkId?: string;
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
  claimText?: string;
  suggestion?: string;
  evidenceIds?: string[];
  citationIds?: string[];
  referenceId?: string;
}): ReviewFinding {
  if (
    input.sectionId === undefined &&
    input.page === undefined &&
    input.chunkId === undefined
  ) {
    throw new Error(
      `createFinding(${input.findingId}) 缺少 provenance：需要 sectionId / page / chunkId 至少其一`,
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

/** 防御性读取（磁盘 JSON → ReviewFinding；结构损坏返回 undefined） */
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
  if (
    findingId === undefined ||
    message === undefined ||
    source === undefined ||
    createdAt === undefined ||
    !isOneOf(FINDING_CATEGORIES, category) ||
    !isOneOf(FINDING_SEVERITIES, severity) ||
    !isOneOf(FINDING_STATUSES, status) ||
    (record["sectionId"] === undefined && record["page"] === undefined && record["chunkId"] === undefined)
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
