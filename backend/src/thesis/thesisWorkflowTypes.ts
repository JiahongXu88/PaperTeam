/**
 * M14.2：thesis_from_papers 工作流的规划层契约。
 *
 * 三个工件严格分层（全部确定性校验，模型只产生提案）：
 *   thesis-contributions.json  研究贡献台账（模型提案 + 作者确认）
 *   thesis-storyline.json      研究主线（关系结构 + 叙事，模型提案）
 *   chapter-mapping.json       章节—来源映射（模型提案 + 作者确认）
 *
 * 与 M14.1b 契约的关系：ResearchInput / ScientificFact / AuthorDecision 不变；
 * 本文件只新增规划层实体。贡献确认（contribution confirm/reject）记录在
 * contributions 台账自身（status + confirmedAt + actor），不扩展 M14.1b 的
 * AUTHOR_DECISION_TYPES 枚举。
 */

import { sha256Hex } from "../util/hash.js";

/** 贡献类型（模型提取的提案粒度） */
export const CONTRIBUTION_KINDS = [
  "research_question",
  "method",
  "experiment_result",
  "dataset",
  "conclusion",
  "limitation",
] as const;
export type ThesisContributionKind = (typeof CONTRIBUTION_KINDS)[number];

/** 贡献间关系（storyline 结构；same_as/supersedes 需作者确认语义，M14.0.1 §2） */
export const CONTRIBUTION_RELATION_TYPES = [
  "extends",
  "supersedes",
  "same_as",
  "complements",
  "unrelated",
] as const;
export type ThesisContributionRelationType = (typeof CONTRIBUTION_RELATION_TYPES)[number];

export interface ThesisContribution {
  /** 确定性 id：c-<sha256(inputId|kind|normalizedStatement)[0:10]> */
  id: string;
  researchInputId: string;
  /** 提取时的内容版本（版本变化不自动失效提案，但 planner 会标注 stale） */
  contentHash: string;
  kind: ThesisContributionKind;
  /** 一句话陈述（中文） */
  statement: string;
  /** 原文逐字锚点（≤400 字符；模型必须逐字摘引，确定性核验） */
  quote?: string;
  anchorStatus: "verbatim" | "not_found" | "not_provided";
  /** 关联的已提取事实（factId → ScientificFact；确定性链接） */
  linkedFactIds: string[];
  status: "proposed" | "confirmed" | "rejected";
  confirmedAt?: string;
  /** 确认来源（user=作者在 HITL 中确认；test_fixture=测试预设，生产禁用） */
  actorKind?: "user" | "test_fixture";
  extraction: {
    method: "model_proposal";
    taskId?: string;
    extractedAt: string;
  };
}

export interface ThesisContributionFile {
  schemaVersion: 1;
  projectId: string;
  items: ThesisContribution[];
  /** 提取过程的逐输入审计 */
  extraction: {
    perInput: Record<
      string,
      { taskId?: string; status: "ok" | "failed" | "skipped"; proposals: number; anchored: number }
    >;
  };
  updatedAt: string;
}

/** 章节角色（决定写作策略与缺口处理） */
export const CHAPTER_RESPONSIBILITIES = [
  "introduction",
  "background",
  "literature_review",
  "method",
  "experiment",
  "discussion",
  "conclusion",
] as const;
export type ThesisChapterResponsibility = (typeof CHAPTER_RESPONSIBILITIES)[number];

export interface StorylineRelation {
  type: ThesisContributionRelationType;
  fromContributionId: string;
  toContributionId: string;
  note?: string;
}

export interface ThesisStoryline {
  /** 主线叙事（1–3 句：这些成果构成怎样的研究主线） */
  narrative: string;
  /** 主线结构判定：progressive（递进）/ parallel（并列）/ framework（统一框架）/ fragmented（缺乏共同主线） */
  structure: "progressive" | "parallel" | "framework" | "fragmented";
  relations: StorylineRelation[];
  /** fragmented 时必须给出的范围问题说明（不硬编统一创新点） */
  scopeConcerns?: string[];
  contributionsOrder: string[];
}

export interface ThesisStorylineFile {
  schemaVersion: 1;
  projectId: string;
  storyline: ThesisStoryline;
  /** 规划输入指纹（贡献集合 + included 输入版本）；变化 → 大纲需重规划 */
  planFingerprint: string;
  taskId?: string;
  updatedAt: string;
}

/** 章节规划（storyline → 大纲的中间层；file 引用 outline section） */
export interface ThesisChapterPlan {
  chapterId: string;
  titleZh: string;
  responsibility: ThesisChapterResponsibility;
  /** 本章目标（一句话） */
  goal: string;
  /** 引用的 outline section 文件名（顺序即章内顺序） */
  sectionFiles: string[];
  /** 本章完整展开（owner）的研究贡献 */
  ownsContributionIds: string[];
  /** 本章仅引用提及的贡献 */
  referencesContributionIds: string[];
  /** 本章可用的来源研究输入（改写源文本） */
  sourceInputIds: string[];
  /** 本章依赖的已确认事实（写作数值白名单） */
  factIds: string[];
  /** 缺失材料声明（确定性检测：owner 贡献无可用事实/输入不可用） */
  missingMaterials?: string[];
}

export interface ChapterMappingFile {
  schemaVersion: 1;
  projectId: string;
  chapters: ThesisChapterPlan[];
  /** 与 outline 结构字段的指纹绑定（outline 变化 → 映射失效需重新确认） */
  outlineFingerprint: string;
  status: "proposed" | "confirmed";
  confirmedAt?: string;
  updatedAt: string;
}

/** Planner 上下文指纹：贡献集合 + included 输入 + 选定版本（变化 → storyline/outline 失效） */
export function thesisPlanFingerprint(input: {
  contributionIds: readonly string[];
  includedInputIds: readonly string[];
  preferredVersions: Readonly<Record<string, string>>;
}): string {
  const parts = [
    [...input.contributionIds].sort().join(","),
    [...input.includedInputIds].sort().join(","),
    Object.entries(input.preferredVersions)
      .sort(([a], [b]) => (a < b ? -1 : 1))
      .map(([k, v]) => `${k}:${v}`)
      .join(","),
  ];
  return fingerprintText(parts.join("|"));
}

/** outline 结构指纹：章文件集合 + 章节标题（轻量，用于映射失效判定） */
export function outlineFingerprintFromChapters(chapters: readonly ThesisChapterPlan[]): string {
  return fingerprintText(
    chapters
      .map((chapter) => `${chapter.chapterId}|${chapter.titleZh}|${chapter.responsibility}|${chapter.sectionFiles.join(",")}`)
      .join("\n"),
  );
}

function fingerprintText(text: string): string {
  return sha256Hex(text);
}

/** 确定性贡献 id */
export function thesisContributionId(inputId: string, kind: string, statement: string): string {
  const normalized = statement.replace(/\s+/g, "").toLowerCase();
  return `c-${sha256Hex(`${inputId}|${kind}|${normalized}`).slice(0, 10)}`;
}
