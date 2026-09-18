/**
 * Revision Plan（M4.7，D-0026：确定性产物，不新增 RevisionPlanner Agent）。
 *
 * 从「最新 ReviewSummary + Citation 报告 + Build 错误」确定性派生修订计划并落盘
 * （reviews/revision-plan-r{round}.json）。Writer 的修订以本计划为准（section-scoped），
 * 不再在执行期临时拼指令；计划与该轮 scorecard / gate 结果通过 round 关联。
 *
 * M6.7 Revision Safety 升级：计划条目从「派发清单」升级为「带生命周期的 Revision
 * Item」——字段映射：problem ≡ finding、instruction ≡ requestedChange、planned ≡
 * pending；新增 riskLevel / relatedEvidenceIds 与 applied → validated / rejected /
 * needs_review / approved 状态机（见 revisionItemStatus.ts / revisionValidation.ts）。
 * Writer 执行后由 Revision Validation 复核（Evidence 再核验 / Fact / Citation /
 * Claim Strength），复核结果回写条目终态；Quality Gate 的 revision_items_resolved
 * 据此阻断未解决条目进入 Final。
 *
 * 派生规则（确定性，无 LLM）：
 * - critical / blocking finding → priority high（必改）
 * - major finding              → priority medium（必改）
 * - minor finding              → 记录但不自动修（status=skipped，避免非收敛）
 * - 引用 missing key           → kind=citation_missing，critical（只允许删除/弱化，
 *                                永远不允许凭空新造文献条目）
 * - 引用被无计划删除            → kind=citation_removed，critical（M5.6 Citation Preservation
 *                                Gate 失败项：恢复上一修订中的既有引用）
 * - 编译错误                    → kind=build_error（修复循环消费）
 * - 无章节归属的 gate 阻止项     → kind=gate_blocker，记录不派发（Writer 无从下手）
 */

import { createHash } from "node:crypto";

import type { ReviewIssue } from "../agents/ReviewerService.js";
import type { ReviewSummary } from "./ReviewAggregator.js";
import { EXTERNAL_SOURCE_LABELS, type ExternalInstruction } from "./externalInstructions.js";

export type RevisionPlanItemKind =
  | "external_instruction"
  | "review_finding"
  | "citation_missing"
  | "citation_removed"
  | "fact_preserve"
  | "build_error"
  | "gate_blocker";

/**
 * 条目状态（M6.7 升级为完整生命周期）：
 * - planned  待执行（≡ 任务的 pending；M4.7 既有名称，保持产物兼容）
 * - skipped  记录不派发（minor / gate 阻止项 / conflict 外部意见；终态）
 * - applied  Writer 已执行（M6.7：修订 stage 派发并写回后标记；等待验证）
 * - validated  Revision Validation 复核通过（Evidence / Fact / Citation / Claim Strength；终态）
 * - rejected  复核失败（事实漂移 / 引用无依据丢失 / 强 claim 弱证据升级；可回到 planned 重派发）
 * - needs_review  证据弱化 / 线索级问题（不自动接受也不拒绝，交人工复核；阻断 Final）
 * - approved  用户在 hitl.revision_validation 明示接受（终态；覆盖自动判定，记录在案）
 *
 * 合法流转见 review/revisionItemStatus.ts（非法流转确定性拒绝）。
 */
export type RevisionPlanItemStatus =
  | "planned"
  | "skipped"
  | "applied"
  | "validated"
  | "rejected"
  | "needs_review"
  | "approved";

/**
 * 派发理由（M5.4）：quality = 质量修订（critical / major / citation / build，
 * D-0026 既有语义）；style_polish = 用户显式选择（stylePolicy=apply_once）的
 * 语言润色——不是通过抬高 severity 进入计划，而是由本字段显式携带。
 */
export type RevisionReason = "quality" | "style_polish";

/**
 * 条目优先级。mandatory（M5.7）只用于外部 / 用户修改意见：最高**业务**
 * 修改优先级（排序与派发都先于内部审稿意见），但不提升任何安全 Gate
 * 的授权——Fact / Citation Preservation 与 Style Invariant 的判定口径不变。
 */
export type RevisionPlanItemPriority = "mandatory" | "high" | "medium" | "low";

export interface RevisionPlanItem {
  /** 稳定 id（finding 指纹 / external:{instructionId} / citation-missing:{key} / citation-removed:{key} / build-error / gate:{rule}） */
  id: string;
  kind: RevisionPlanItemKind;
  priority: RevisionPlanItemPriority;
  /** 匹配修订目标的章节引用（路径 / id / 文件名；(global) 表示无章节归属） */
  section: string;
  problem: string;
  instruction: string;
  expectedOutcome: string;
  status: RevisionPlanItemStatus;
  /** 证据不足类问题：修订时只能弱化 / 删除，不允许编造 */
  needsEvidence?: boolean;
  /**
   * 修订风险档位（M6.7，确定性派生）：high = 事实 / 引用 / 外部意见类
   * （改错即漂移），medium = major finding，low = 表达 / 语法类。
   * 驱动 Revision Validation 的复核强度与 HITL 呈现排序。
   */
  riskLevel?: "high" | "medium" | "low";
  /**
   * 关联证据（M6.7 §5/§6）：finding 的 evidenceRef + 引用条目经 bib key
   * 关联的 verified evidence。修改前后对这些证据做再核验（§9）。
   */
  relatedEvidenceIds?: string[];
  /** applied 时刻（ISO；M6.7） */
  appliedAt?: string;
  /** applied 时写入的 manuscript 修订号（M6.7；验证对齐用） */
  appliedRevision?: number;
  /** 派发目标是否产生实际文本变更（M6.7；确定性 diff，不采信 Writer 自称） */
  targetChanged?: boolean;
  /** 终态判定时刻（validated / rejected / needs_review / approved；ISO） */
  resolvedAt?: string;
  /** 终态判定依据（机器可读 reason 短语 + 人读说明；M6.7） */
  resolution?: string;
  /** skipped 的原因（记录但不派发） */
  note?: string;
  /** 派发理由（缺省 quality；style_polish 条目只允许 style-only 修改） */
  revisionReason?: RevisionReason;
  /** 条目来源（M5.7；缺省 = PaperTeam 内部审稿 / 确定性规则） */
  source?: "external" | "internal";
  /** 外部意见的来源标识（如 "Reviewer 2"；source=external 时携带） */
  reviewerLabel?: string;
  /** 外部意见原文（逐字保存；模型改写只发生在 instruction 派发文案） */
  sourceText?: string;
  /** 外部意见 id（跨轮跟踪，见 review/externalInstructions.ts） */
  instructionId?: string;
}

export interface RevisionPlan {
  schemaVersion: 1;
  planId: string;
  projectId: string;
  /** 计划针对的 manuscript 修订（该轮 review 审阅的版本） */
  sourceRevision: number;
  /** 计划依据的 review 轮次 */
  reviewRound: number;
  createdAt: string;
  /** 计划类型（缺省 quality；style_polish 计划由 buildStylePolishPlan 派生） */
  revisionReason?: RevisionReason;
  /** style_polish 计划携带触发它的策略（审计） */
  stylePolicy?: "apply_once";
  summary: {
    critical: number;
    major: number;
    blocking: number;
    /** 记录但不自动修的 minor 条数 */
    minorRecorded: number;
    planned: number;
    skipped: number;
    /** 外部修改意见条数（M5.7；无外部意见的计划缺省） */
    external?: number;
  };
  items: RevisionPlanItem[];
}

/** ReviewIssue 的确定性指纹（跨轮跟踪同一问题的稳定 id） */
export function findingFingerprint(issue: Pick<ReviewIssue, "category" | "section" | "description">): string {
  const hash = createHash("sha256")
    .update(`${issue.category}|${issue.section}|${issue.description}`)
    .digest("hex")
    .slice(0, 12);
  return `f-${hash}`;
}

export interface BuildRevisionPlanInput {
  projectId: string;
  sourceRevision: number;
  reviewRound: number;
  summary: ReviewSummary;
  /** 引用核验发现的 missing key → 出现该引用的文件（确定性扫描结果） */
  citationMissing?: { key: string; files: string[] }[];
  /** Citation Preservation Gate 判定为无依据删除的 key → 上一修订中出现的文件（M5.6） */
  citationRemoved?: { key: string; files: string[] }[];
  /**
   * Fact Preservation Gate 判定为无依据改写 / 删除 / 占位化的实验事实 → 发生文件（M5.6）。
   * detail 为该文件违规明细的摘要（数值 / 公式 / 方向，含 before → after 短片段）。
   */
  factRegressions?: { file: string; detail: string }[];
  /** 编译错误（修复循环 / 带 buildError 的修订消费） */
  buildError?: { message: string; file?: string };
  /** gate 阻止项（ruleId + detail；无章节归属的记录为 gate_blocker） */
  gateBlockers?: { rule: string; detail: string }[];
  /**
   * 外部修改意见（M5.7）：pending / partially_handled / unresolved → mandatory 派发；
   * conflict → 保留条目但 skipped（不自动改事实）；handled → skipped（留档）。
   */
  externalInstructions?: ExternalInstruction[];
  /**
   * bib key → verified evidence 关联（M6.7 §5/§6）：由调用方用
   * EvidenceSelectionService.matchBibliographyKey 确定性计算；citation 类条目
   * 据此携带 relatedEvidenceIds（§9 Evidence Re-validation 的对象）。
   */
  evidenceLinks?: { key: string; evidenceIds: string[] }[];
  createdAt?: string;
}

/** 确定性派生修订计划（纯函数：同输入同输出，可测试） */
export function buildRevisionPlan(input: BuildRevisionPlanInput): RevisionPlan {
  const items: RevisionPlanItem[] = [];

  // M5.7 外部修改意见：最高业务优先级（mandatory），先于内部审稿意见入列
  for (const instruction of input.externalInstructions ?? []) {
    const label = instructionLabel(instruction);
    const firstLine = firstTextLine(instruction.text);
    items.push({
      id: `external:${instruction.instructionId}`,
      kind: "external_instruction",
      priority: "mandatory",
      section: instruction.section ?? "(global)",
      problem: `外部修改意见${label}：${firstLine}`,
      instruction: externalDispatchText(instruction),
      expectedOutcome:
        "该意见在事实 / 引用 / 证据约束内落实；与实验事实冲突时如实报告 CONFLICT，不篡改数据",
      status:
        instruction.status === "handled" || instruction.status === "conflict" ? "skipped" : "planned",
      source: "external",
      riskLevel: "high",
      ...(instruction.reviewerLabel !== undefined ? { reviewerLabel: instruction.reviewerLabel } : {}),
      sourceText: instruction.text,
      instructionId: instruction.instructionId,
      ...(instruction.status === "handled"
        ? { note: "该意见已处理（执行证据见指令状态）" }
        : {}),
      ...(instruction.status === "conflict"
        ? {
            note: `与稿件实验事实 / Evidence 冲突，不自动执行：${instruction.conflictBasis ?? instruction.statusNote ?? "见外部意见列表"}`,
          }
        : {}),
      ...(instruction.status === "unresolved"
        ? { note: "上一轮派发未落实，本轮重新派发" }
        : {}),
    });
  }

  for (const issue of input.summary.issues) {
    const blocking = issue.blocking;
    const severity = issue.severity;
    if (severity === "critical" || blocking) {
      items.push(findingItem(issue, "high", "planned"));
    } else if (severity === "major") {
      items.push(findingItem(issue, "medium", "planned"));
    } else {
      // minor：记录但不自动修（D-0026：避免小问题来回改导致不收敛）
      items.push(
        withNote(findingItem(issue, "low", "skipped"), "minor：已记录，不进入自动修订"),
      );
    }
  }

  for (const missing of input.citationMissing ?? []) {
    for (const file of missing.files.length > 0 ? missing.files : ["(unknown)"]) {
      items.push({
        id: `citation-missing:${missing.key}:${file}`,
        kind: "citation_missing",
        priority: "high",
        section: file,
        problem: `引用 \\cite{${missing.key}} 在 references.bib 中不存在`,
        instruction: "删除该引用，或改为只基于现有文献的表述；禁止新造参考文献条目",
        expectedOutcome: `章节 ${file} 不再引用缺失 key ${missing.key}`,
        status: "planned",
        riskLevel: "high",
        ...evidenceIdsForKey(missing.key, input.evidenceLinks),
      });
    }
  }

  for (const removed of input.citationRemoved ?? []) {
    for (const file of removed.files.length > 0 ? removed.files : ["(unknown)"]) {
      items.push({
        id: `citation-removed:${removed.key}:${file}`,
        kind: "citation_removed",
        priority: "high",
        section: file,
        problem: `引用 \cite{${removed.key}} 在上一修订的本章节中存在，本次修订被无计划删除`,
        instruction: `恢复该引用：在原论述处保留 \cite{${removed.key}}（key 必须仍存在于 references.bib）；只有审稿 finding 明确要求删除该论述或该引用时才允许移除`,
        expectedOutcome: `章节 ${file} 重新引用 ${removed.key}，引用保持规则转为通过`,
        status: "planned",
        riskLevel: "high",
        ...evidenceIdsForKey(removed.key, input.evidenceLinks),
      });
    }
  }

  for (const regression of input.factRegressions ?? []) {
    items.push({
      id: `fact-preserve:${regression.file}:${findingCount(items, regression.file) + 1}`,
      kind: "fact_preserve",
      priority: "high",
      section: regression.file,
      problem: `实验事实被无依据修改：${regression.detail.slice(0, 260)}`,
      instruction:
        "恢复上一修订中的实验事实原值（表格数值 / 正文数字与单位 / 公式 / 方向性结论 / 协议表述）。修订不是重写：只有计划明确授权（依据 Evidence 修正数值）时才允许改值，且新值必须逐字来自 Evidence",
      expectedOutcome: "实验事实保持规则（fact_preservation）转为通过",
      status: "planned",
      riskLevel: "high",
    });
  }

  if (input.buildError !== undefined) {
    items.push({
      id: "build-error:latest",
      kind: "build_error",
      priority: "high",
      section: input.buildError.file ?? "(global)",
      problem: `LaTeX 编译失败：${input.buildError.message.slice(0, 300)}`,
      instruction: "修复编译错误（语法 / 未定义命令 / 环境配对），不改变论述内容",
      expectedOutcome: "main.tex 可通过 latexmk/xelatex 编译并产出 PDF",
      status: "planned",
      riskLevel: "low",
      ...(input.buildError.file !== undefined ? {} : { note: "错误未定位到具体文件，按全局处理" }),
    });
  }

  for (const blocker of input.gateBlockers ?? []) {
    items.push({
      id: `gate:${blocker.rule}`,
      kind: "gate_blocker",
      priority: "high",
      section: "(global)",
      problem: `${blocker.rule}: ${blocker.detail}`.slice(0, 300),
      instruction: "（无直接章节修改路径；由对应 finding 条目或人工处理）",
      expectedOutcome: "该 gate 规则转为通过",
      status: "skipped",
      riskLevel: "medium",
      note: "gate 阻止项无章节归属，不派发给 Writer",
    });
  }

  // 确定性排序：priority（mandatory → high → medium → low）→ id（稳定 tie-break）
  const priorityRank: Record<RevisionPlanItemPriority, number> = {
    mandatory: 0,
    high: 1,
    medium: 2,
    low: 3,
  };
  items.sort((a, b) => priorityRank[a.priority] - priorityRank[b.priority] || a.id.localeCompare(b.id));

  const planned = items.filter((item) => item.status === "planned").length;
  const externalCount = (input.externalInstructions ?? []).length;
  return {
    schemaVersion: 1,
    planId: `plan-r${input.reviewRound}-rev${input.sourceRevision}`,
    projectId: input.projectId,
    sourceRevision: input.sourceRevision,
    reviewRound: input.reviewRound,
    createdAt: input.createdAt ?? new Date().toISOString(),
    summary: {
      critical: input.summary.counts.critical,
      major: input.summary.counts.major,
      blocking: input.summary.counts.blocking,
      minorRecorded: input.summary.counts.minor,
      planned,
      skipped: items.length - planned,
      ...(externalCount > 0 ? { external: externalCount } : {}),
    },
    items,
  };
}

/** 外部意见的展示标签（来源 + Reviewer 标识） */
function instructionLabel(instruction: ExternalInstruction): string {
  const source = EXTERNAL_SOURCE_LABELS[instruction.source];
  return `（${source}${instruction.reviewerLabel !== undefined ? ` · ${instruction.reviewerLabel}` : ""}）`;
}

/** bib key → verified evidence 关联（evidenceLinks 输入；无匹配 → 不携带字段） */
function evidenceIdsForKey(
  key: string,
  links: { key: string; evidenceIds: string[] }[] | undefined,
): { relatedEvidenceIds?: string[] } {
  const hit = links?.find((link) => link.key === key && link.evidenceIds.length > 0);
  return hit !== undefined ? { relatedEvidenceIds: [...hit.evidenceIds] } : {};
}

/** 意见原文的第一个非空行（problem 展示用；全文在 sourceText） */
function firstTextLine(text: string): string {
  const line = text
    .split(/\r?\n/)
    .map((entry) => entry.trim())
    .find((entry) => entry !== "");
  return (line ?? text).slice(0, 200);
}

/** 派发给 Writer 的指令文案：保留意见全文（可多行），附执行约束 */
function externalDispatchText(instruction: ExternalInstruction): string {
  const target =
    instruction.section !== undefined
      ? `（指定章节：${instruction.section}）`
      : "（未指定章节：只在与本节内容直接相关时在本节落实，其余章节保持原样）";
  return [
    `${instructionLabel(instruction)} ${target}`,
    "意见原文（最高业务优先级，必须优先尝试执行）：",
    instruction.text,
    "执行约束：不得突破实验事实 / 引用 / 证据约束——与稿件数字或结论冲突时保留事实并如实报告 CONFLICT（引用具体数值作依据），不得伪造、篡改或美化。",
  ].join("\n");
}

function findingItem(
  issue: ReviewIssue,
  priority: "high" | "medium" | "low",
  status: RevisionPlanItemStatus,
): RevisionPlanItem {
  const needsEvidenceFlag = needsEvidence(issue);
  return {
    id: findingFingerprint(issue),
    kind: "review_finding",
    priority,
    section: issue.section || "(unknown)",
    problem: issue.description,
    instruction: issue.suggestedAction ?? defaultInstruction(issue),
    expectedOutcome:
      issue.severity === "critical" || issue.blocking
        ? "该 critical/blocking 问题在复审中不再出现"
        : "该 major 问题在复审中不再出现",
    status,
    ...(needsEvidenceFlag ? { needsEvidence: true } : {}),
    riskLevel: riskLevelOf("review_finding", priority) ?? "medium",
    ...relatedEvidenceOf(issue),
  };
}

/** 条目风险档位（确定性）：事实 / 引用 / 外部意见 = high，major = medium，其余 low */
function riskLevelOf(
  kind: RevisionPlanItemKind,
  priority: RevisionPlanItemPriority,
): "high" | "medium" | "low" | undefined {
  if (
    kind === "fact_preserve" ||
    kind === "citation_missing" ||
    kind === "citation_removed" ||
    kind === "external_instruction"
  ) {
    return "high";
  }
  if (priority === "high" || priority === "mandatory") {
    return "high";
  }
  if (priority === "medium") {
    return "medium";
  }
  if (priority === "low") {
    return "low";
  }
  return undefined;
}

/**
 * finding 条目的关联证据（M6.7 §5）：evidenceRef（Reviewer 引用的证据 id）。
 * 引用类条目按 bib key 关联（evidenceLinks）；此处只处理 finding 通道。
 */
function relatedEvidenceOf(issue: ReviewIssue): { relatedEvidenceIds?: string[] } {
  const ref = (issue.evidenceRef ?? "").trim();
  return ref !== "" ? { relatedEvidenceIds: [ref] } : {};
}

function withNote(item: RevisionPlanItem, note: string): RevisionPlanItem {
  return { ...item, note };
}

/** 同一文件的 fact_preserve 条目计数（稳定 id 用） */
function findingCount(items: readonly RevisionPlanItem[], file: string): number {
  return items.filter((item) => item.kind === "fact_preserve" && item.section === file).length;
}

function needsEvidence(issue: ReviewIssue): boolean {
  // M6.7 §13：Reviewer 显式声明优先；缺省按 category 推断（既有口径）
  if (issue.evidenceRequirement !== undefined) {
    return issue.evidenceRequirement !== "none";
  }
  return issue.category.toLowerCase().includes("evidence") || issue.category.toLowerCase().includes("fact");
}

function defaultInstruction(issue: ReviewIssue): string {
  if (needsEvidence(issue)) {
    return "基于现有 Evidence 修正论述；证据不足的论断弱化或删除（不允许编造）";
  }
  if (issue.category === "citation") {
    return "修正引用问题；只允许引用 references.bib 中的现有 key";
  }
  return "针对问题修改本章节论述，保持与其余章节一致";
}
