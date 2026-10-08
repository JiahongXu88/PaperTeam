/**
 * External Instructions（M5.7）：用户手工输入的外部修改意见
 * （期刊外审专家 / 编辑 / 导师 / 用户自己的要求）。
 *
 * 定位与红线：
 * - 外部意见是最高「业务修改优先级」（RevisionPlan 中 priority=mandatory，
 *   排在内部审稿意见之前）；内部 Reviewer 建议（如 Style 删除某段）与
 *   外部意见冲突时，计划保留外部意见的诉求。
 * - 但业务优先级 ≠ 安全优先级：Fact Preservation / Citation Preservation /
 *   Style Invariant 等 deterministic Gate 永远不被外部意见绕过。Writer 被要求
 *   优先执行 mandatory 条目，同时在意见与稿件实验事实冲突时如实报告
 *   CONFLICT（不伪造数字、不篡改表格、不美化负结果、不静默忽略）。
 * - 原文逐字保存（sourceText）：模型拆分 / 改写只发生在派发 prompt，
 *   追溯链「原始专家意见 → 修订计划条目 → 执行结果」完整保留
 *   （instructionId 跨轮稳定）。
 * - 状态是确定性判定（不采信模型自称"已处理"）：
 *   handled 需要「Writer 报告 applied 且目标文件真实变化」；随后一轮
 *   revision.plan 会用该轮 Quality Gate 的 fact/citation preservation 复核，
 *   失败则降级回 unresolved 重新派发（恢复闭环自愈）。
 */

import { createHash } from "node:crypto";
import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { BusinessError } from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { writeJsonAtomic } from "../util/atomic.js";

export const EXTERNAL_INSTRUCTION_SOURCES = [
  "user",
  "journal_reviewer",
  "editor",
  "advisor",
  "other",
] as const;
export type ExternalInstructionSource = (typeof EXTERNAL_INSTRUCTION_SOURCES)[number];

/** 意见来源的展示名（API / UI 共用口径） */
export const EXTERNAL_SOURCE_LABELS: Record<ExternalInstructionSource, string> = {
  user: "用户要求",
  journal_reviewer: "期刊外审专家",
  editor: "编辑",
  advisor: "导师",
  other: "其他",
};

/**
 * 处理状态（确定性口径）：
 * - pending：尚未派发（或派发轮尚未产出结果）
 * - handled：已执行（Writer 报告 applied 且目标文件真实变化；后续轮 gate 复核通过）
 * - partially_handled：部分执行（多目标派发中部分 applied、部分未报告）
 * - unresolved：已派发但未执行（not_applicable / 无文件变化 / 未报告）
 * - conflict：与稿件实验事实 / Evidence 冲突（Writer 报告 + 依据；不重复自动派发）
 * - already_satisfied：导入时即在当前稿已落实的历史意见（M10.3：如投稿轮
 *   Reviewer 意见在提交版已回复落实）。登记性终态：不派发、不参与 gate 复核
 *   降级（reverifyHandledInstructions 只处理 handled）——本轮修订不因历史
 *   意见强行再改，只作为审计上下文保留。
 */
export type ExternalInstructionStatus =
  | "pending"
  | "handled"
  | "partially_handled"
  | "unresolved"
  | "conflict"
  | "already_satisfied";

export interface ExternalInstruction {
  instructionId: string;
  source: ExternalInstructionSource;
  /** Reviewer 标识（可选，如 "Reviewer 2"） */
  reviewerLabel?: string;
  /** 原始意见全文（逐字保存） */
  text: string;
  /** 用户指定的涉及章节（manuscript 内相对路径；缺省 = 不限定章节，全篇派发） */
  section?: string;
  status: ExternalInstructionStatus;
  /** 状态说明（conflict 依据 / unresolved 原因；展示用） */
  statusNote?: string;
  /** 冲突依据（Writer 报告中引用的稿件数字 / Evidence 摘录） */
  conflictBasis?: string;
  resolutionTrace?: CommentResolutionTrace;
  createdAt: string;
  updatedAt: string;
}

/** 意见全文长度上限（超出拒绝；防误贴整篇稿件撑爆 prompt） */
export const EXTERNAL_TEXT_MAX_CHARS = 8_000;
export const EXTERNAL_BATCH_MAX_CHARS = 200_000;
export const EXTERNAL_BATCH_MAX_COMMENTS = 100;

export interface ParsedExternalComment {
  source: ExternalInstructionSource;
  reviewerLabel?: string;
  text: string;
}

export interface CommentResolutionTrace {
  commentId: string;
  planItemIds: string[];
  actionType: "modify" | "noop" | "author_decision_required" | "evidence_only";
  target?: string;
  evidenceIds: string[];
  patchIds: string[];
  verification: { scope?: boolean; fact?: boolean; citation?: boolean; evidence?: boolean };
  status: ExternalInstructionStatus;
  resolutionSummary: string;
  remainingIssue?: string;
}

/**
 * Conservative Markdown importer. It only splits on explicit reviewer/editor
 * headings and extracts an explicitly labelled "意见要点" when present. If no
 * recognized structure exists, the full input remains one comment block.
 */
export function parseExternalCommentBatch(markdown: string): {
  comments: ParsedExternalComment[];
  sourceBlocks: number;
  duplicateBlocks: number;
} {
  if (markdown.length > EXTERNAL_BATCH_MAX_CHARS) {
    throw new Error(`批量意见文本超过 ${EXTERNAL_BATCH_MAX_CHARS} 字符上限`);
  }
  const lines = markdown.replace(/\r\n?/g, "\n").split("\n");
  const headings: Array<{ index: number; label: string; source: ExternalInstructionSource; reviewerLabel?: string }> = [];
  for (let index = 0; index < lines.length; index += 1) {
    const match = /^#{1,6}\s+(.+?)\s*$/.exec(lines[index] ?? "");
    if (match === null) continue;
    const title = (match[1] ?? "").trim();
    const reviewer = /^(?:外审意见|reviewer(?:\s*#?\s*\d+)?\s*:?)\s*(\d+)?/i.exec(title);
    const editor = /^(?:编辑意见|editor(?:\s+comments?)?)(?:\s*[:：].*)?$/i.test(title);
    if (reviewer !== null) {
      const number = /(?:外审意见\s*|reviewer\s*#?\s*)(\d+)/i.exec(title)?.[1];
      headings.push({ index, label: title, source: "journal_reviewer", ...(number ? { reviewerLabel: `Reviewer ${number}` } : {}) });
    } else if (editor) {
      headings.push({ index, label: title, source: "editor", reviewerLabel: "Editor" });
    }
  }

  const rawBlocks: ParsedExternalComment[] = [];
  if (headings.length === 0) {
    const text = markdown.trim();
    if (text !== "") rawBlocks.push({ source: "journal_reviewer", text });
  } else {
    for (let i = 0; i < headings.length; i += 1) {
      const heading = headings[i]!;
      const nextHeading = headings[i + 1]?.index ?? lines.length;
      const section = lines.slice(heading.index + 1, nextHeading).join("\n");
      const issue = /(?:\*\*意见要点\*\*|\*\*Comment\s*(?:summary)?\*\*)\s*[：:]?\s*([\s\S]*?)(?=\n\s*\*\*(?:回应|Response|具体修改|修改位置)\*\*|$)/i.exec(section);
      const text = (issue?.[1] ?? section).trim();
      if (text !== "") rawBlocks.push({
        source: heading.source,
        ...(heading.reviewerLabel ? { reviewerLabel: heading.reviewerLabel } : {}),
        text,
      });
    }
  }
  if (rawBlocks.length > EXTERNAL_BATCH_MAX_COMMENTS) {
    throw new Error(`解析出 ${rawBlocks.length} 条意见，超过 ${EXTERNAL_BATCH_MAX_COMMENTS} 条上限`);
  }
  const seen = new Set<string>();
  const comments: ParsedExternalComment[] = [];
  for (const block of rawBlocks) {
    if (block.text.length > EXTERNAL_TEXT_MAX_CHARS) {
      throw new Error(`单条意见超过 ${EXTERNAL_TEXT_MAX_CHARS} 字符上限，未导入任何意见`);
    }
    const key = `${block.source}|${block.reviewerLabel ?? ""}|${block.text.trim().replace(/\s+/g, " ")}`;
    if (seen.has(key)) continue;
    seen.add(key);
    comments.push(block);
  }
  return { comments, sourceBlocks: rawBlocks.length, duplicateBlocks: rawBlocks.length - comments.length };
}

/** Writer 对单条意见在单个章节的执行报告（%%%PT-OUTCOMES%%% 行解析结果） */
export type ExternalOutcomeKind = "applied" | "conflict" | "not_applicable" | "unreported";

export interface ExternalOutcomeReport {
  instructionId: string;
  outcome: ExternalOutcomeKind;
  /** conflict 依据（引用稿件具体数字）；applied 的说明也可携带 */
  basis?: string;
  /**
   * 该报告所在目标文件是否真实变化（派发 stage 的确定性 diff 补记；
   * applied 的"已处理"判定需要它——不采信 Writer 自称执行）。
   */
  targetChanged?: boolean;
  target?: string;
  planItemIds?: string[];
  evidenceIds?: string[];
  patchIds?: string[];
  verification?: { scope?: boolean; fact?: boolean; citation?: boolean; evidence?: boolean };
}

/**
 * 派发给 Writer 单次 reviseSection 的外部意见（M5.7）。
 * section 缺省 = 不限定章节（全篇派发，由 Writer 判断与本节的相关性）。
 */
export interface ExternalDirectiveDispatch {
  instructionId: string;
  source: ExternalInstructionSource;
  reviewerLabel?: string;
  text: string;
  section?: string;
}

/** 一轮派发的结果汇总（revision.apply / revision.revise stage 计算） */
export interface ExternalDispatchResult {
  /** 派发轮的 review round */
  round: number;
  /** 派发产生的 manuscript revision */
  revision: number;
  /** 逐章节执行报告（仅在 Writer 真实运行过的目标上记录；含确定性 targetChanged） */
  outcomes: ExternalOutcomeReport[];
  /** 派发了但没有任何目标匹配到的 instructionId（章节指错） */
  unmatched: string[];
}

/**
 * Writer 执行报告标记行（M5.7）：输出最后一行单独一行
 * `%%%PT-OUTCOMES%%% [{"instructionId":"…","outcome":"…","basis":"…"}]`。
 * 标记是刻意的罕见字面量（LaTeX 注释风格 % 前缀），不会与正文冲突；
 * 无外部意见派发时 Writer 输出不含该行（行为与旧版完全一致）。
 */
export const EXTERNAL_OUTCOMES_MARKER = "%%%PT-OUTCOMES%%%";

const INSTRUCTIONS_FILE = "external-instructions.json";

function isSource(value: unknown): value is ExternalInstructionSource {
  return (
    typeof value === "string" &&
    (EXTERNAL_INSTRUCTION_SOURCES as readonly string[]).includes(value)
  );
}

function isStatus(value: unknown): value is ExternalInstructionStatus {
  return (
    typeof value === "string" &&
    ["pending", "handled", "partially_handled", "unresolved", "conflict", "already_satisfied"].includes(value)
  );
}

/** 内容指纹 id：同一（来源+标识+正文）的意见幂等去重 */
export function externalInstructionId(
  source: ExternalInstructionSource,
  reviewerLabel: string | undefined,
  text: string,
): string {
  const hash = createHash("sha256")
    .update(`${source}|${reviewerLabel ?? ""}|${text.trim()}`)
    .digest("hex")
    .slice(0, 10);
  return `x-${hash}`;
}

function readResolutionTrace(value: unknown): CommentResolutionTrace | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return undefined;
  const record = value as Record<string, unknown>;
  const verification = record["verification"];
  const validAction = ["modify", "noop", "author_decision_required", "evidence_only"].includes(String(record["actionType"]));
  const validVerification = typeof verification === "object" && verification !== null && !Array.isArray(verification);
  if (
    typeof record["commentId"] !== "string" || !Array.isArray(record["planItemIds"]) ||
    !record["planItemIds"].every((item) => typeof item === "string") || !validAction ||
    !Array.isArray(record["evidenceIds"]) || !record["evidenceIds"].every((item) => typeof item === "string") ||
    !Array.isArray(record["patchIds"]) || !record["patchIds"].every((item) => typeof item === "string") ||
    !validVerification || !isStatus(record["status"]) || typeof record["resolutionSummary"] !== "string"
  ) return undefined;
  const flags: CommentResolutionTrace["verification"] = {};
  for (const key of ["scope", "fact", "citation", "evidence"] as const) {
    const candidate = (verification as Record<string, unknown>)[key];
    if (typeof candidate === "boolean") flags[key] = candidate;
  }
  return {
    commentId: record["commentId"],
    planItemIds: record["planItemIds"] as string[],
    actionType: record["actionType"] as CommentResolutionTrace["actionType"],
    ...(typeof record["target"] === "string" ? { target: record["target"] } : {}),
    evidenceIds: record["evidenceIds"] as string[],
    patchIds: record["patchIds"] as string[],
    verification: flags,
    status: record["status"],
    resolutionSummary: record["resolutionSummary"],
    ...(typeof record["remainingIssue"] === "string" ? { remainingIssue: record["remainingIssue"] } : {}),
  };
}

/** 磁盘 JSON → 指令列表（防御性：损坏条目丢弃；结构损坏 → 空列表） */
export function readExternalInstructions(value: unknown): ExternalInstruction[] {
  if (typeof value !== "object" || value === null) {
    return [];
  }
  const raw = (value as Record<string, unknown>)["instructions"];
  if (!Array.isArray(raw)) {
    return [];
  }
  const instructions: ExternalInstruction[] = [];
  for (const entry of raw) {
    if (typeof entry !== "object" || entry === null) {
      continue;
    }
    const record = entry as Record<string, unknown>;
    const instructionId = typeof record["instructionId"] === "string" ? record["instructionId"] : undefined;
    const text = typeof record["text"] === "string" ? record["text"] : undefined;
    const source = record["source"];
    const status = record["status"];
    const createdAt = typeof record["createdAt"] === "string" ? record["createdAt"] : undefined;
    if (
      instructionId === undefined ||
      text === undefined ||
      text.trim() === "" ||
      !isSource(source) ||
      !isStatus(status) ||
      createdAt === undefined
    ) {
      continue;
    }
    instructions.push({
      instructionId,
      source,
      ...(typeof record["reviewerLabel"] === "string" && record["reviewerLabel"].trim() !== ""
        ? { reviewerLabel: record["reviewerLabel"].trim() }
        : {}),
      text,
      ...(typeof record["section"] === "string" && record["section"].trim() !== ""
        ? { section: record["section"].trim() }
        : {}),
      status,
      ...(typeof record["statusNote"] === "string" ? { statusNote: record["statusNote"] } : {}),
      ...(typeof record["conflictBasis"] === "string"
        ? { conflictBasis: record["conflictBasis"] }
        : {}),
      ...(readResolutionTrace(record["resolutionTrace"]) !== undefined
        ? { resolutionTrace: readResolutionTrace(record["resolutionTrace"]) }
        : {}),
      createdAt,
      updatedAt: typeof record["updatedAt"] === "string" ? record["updatedAt"] : createdAt,
    });
  }
  return instructions;
}

export class ExternalInstructionStore {
  private readonly queues = new Map<string, Promise<unknown>>();
  constructor(private readonly projects: ProjectStore) {}

  private enqueue<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(projectId) ?? Promise.resolve();
    const task = previous.then(operation);
    this.queues.set(projectId, task.catch(() => undefined));
    return task;
  }

  private filePath(projectId: string): string {
    return join(this.projects.reviewsDir(projectId), INSTRUCTIONS_FILE);
  }

  async load(projectId: string): Promise<ExternalInstruction[]> {
    let text: string;
    try {
      text = await readFile(this.filePath(projectId), "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") return [];
      throw error;
    }
    try {
      const parsed: unknown = JSON.parse(text);
      if (typeof parsed !== "object" || parsed === null ||
          (parsed as { schemaVersion?: unknown }).schemaVersion !== 1 ||
          !Array.isArray((parsed as { instructions?: unknown }).instructions)) {
        throw new Error("invalid external instruction store");
      }
      const records = (parsed as { instructions: unknown[] }).instructions;
      const instructions = readExternalInstructions(parsed);
      if (instructions.length !== records.length) throw new Error("unreadable external instruction record");
      if (records.some((entry) => typeof entry === "object" && entry !== null &&
          Object.hasOwn(entry, "resolutionTrace") &&
          readResolutionTrace((entry as Record<string, unknown>)["resolutionTrace"]) === undefined)) {
        throw new Error("unreadable resolution trace");
      }
      return instructions;
    } catch {
      throw new BusinessError("EXTERNAL_INSTRUCTION_CONFLICT", "external-instructions.json 损坏；禁止按空意见覆盖");
    }
  }

  async save(projectId: string, instructions: ExternalInstruction[]): Promise<void> {
    return this.enqueue(projectId, () => this.saveUnqueued(projectId, instructions));
  }

  private async saveUnqueued(projectId: string, instructions: ExternalInstruction[]): Promise<void> {
    // reviews/ 目录可能尚未创建（项目刚建 / 首条意见先于任何 review 落盘）
    await mkdir(this.projects.reviewsDir(projectId), { recursive: true });
    await writeJsonAtomic(this.filePath(projectId), {
      schemaVersion: 1,
      instructions,
    });
  }

  /** Recompute a status transition on the latest record set under the project queue. */
  async update(projectId: string, transform: (current: ExternalInstruction[]) => ExternalInstruction[]): Promise<ExternalInstruction[]> {
    return this.enqueue(projectId, async () => {
      const current = await this.load(projectId);
      const next = transform(current);
      if (JSON.stringify(next) !== JSON.stringify(current)) await this.saveUnqueued(projectId, next);
      return next;
    });
  }

  /** Apply an already computed, potentially in-place transition without erasing newer additions. */
  async saveChanges(projectId: string, before: ExternalInstruction[], after: ExternalInstruction[]): Promise<ExternalInstruction[]> {
    return this.enqueue(projectId, async () => {
      const latest = await this.load(projectId);
      const oldById = new Map(before.map((item) => [item.instructionId, item]));
      const changed = after.filter((item) => JSON.stringify(item) !== JSON.stringify(oldById.get(item.instructionId)));
      const changes = new Map(changed.map((item) => [item.instructionId, item]));
      if (changed.some((item) => !oldById.has(item.instructionId)))
        throw new BusinessError("EXTERNAL_INSTRUCTION_CONFLICT", "状态更新含未知意见");
      if (changed.some((item) => !latest.some((current) => current.instructionId === item.instructionId)))
        throw new BusinessError("EXTERNAL_INSTRUCTION_CONFLICT", "意见在状态计算期间被删除");
      for (const item of latest) {
        if (changes.has(item.instructionId) && JSON.stringify(item) !== JSON.stringify(oldById.get(item.instructionId))) {
          throw new BusinessError("EXTERNAL_INSTRUCTION_CONFLICT", `意见 ${item.instructionId} 在状态计算期间变化`);
        }
      }
      const next = latest.map((item) => changes.get(item.instructionId) ?? item);
      if (changed.length > 0) await this.saveUnqueued(projectId, next);
      return next;
    });
  }

  /**
   * 新增一条（幂等：同内容 id 已存在 → 返回 null）。
   * initialStatus 仅允许 already_satisfied（M10.3：登记导入前已在当前稿落实的
   * 历史意见，需携带 statusNote 说明依据）；其余状态一律从 pending 起步，
   * 由派发/复核状态机确定性流转。
   */
  async add(projectId: string, input: {
    source: ExternalInstructionSource;
    text: string;
    reviewerLabel?: string;
    section?: string;
    initialStatus?: "already_satisfied";
    statusNote?: string;
    now?: string;
  }): Promise<ExternalInstruction | null> {
    return this.enqueue(projectId, () => this.addInner(projectId, input));
  }

  private async addInner(projectId: string, input: {
    source: ExternalInstructionSource; text: string; reviewerLabel?: string; section?: string;
    initialStatus?: "already_satisfied"; statusNote?: string; now?: string;
  }): Promise<ExternalInstruction | null> {
    const now = input.now ?? new Date().toISOString();
    const instructionId = externalInstructionId(input.source, input.reviewerLabel, input.text);
    const existing = await this.load(projectId);
    if (existing.some((instruction) => instruction.instructionId === instructionId)) {
      return null;
    }
    const satisfied =
      input.initialStatus === "already_satisfied" && (input.statusNote ?? "").trim() !== "";
    const instruction: ExternalInstruction = {
      instructionId,
      source: input.source,
      ...(input.reviewerLabel !== undefined ? { reviewerLabel: input.reviewerLabel } : {}),
      text: input.text,
      ...(input.section !== undefined ? { section: input.section } : {}),
      status: satisfied ? "already_satisfied" : "pending",
      ...(satisfied ? { statusNote: input.statusNote } : {}),
      ...(satisfied ? {
        resolutionTrace: {
          commentId: instructionId,
          planItemIds: [],
          actionType: "noop" as const,
          evidenceIds: [],
          patchIds: [],
          verification: {},
          status: "already_satisfied" as const,
          resolutionSummary: input.statusNote!.trim(),
        },
      } : {}),
      createdAt: now,
      updatedAt: now,
    };
    await this.saveUnqueued(projectId, [...existing, instruction]);
    return instruction;
  }

  /** Atomic ordered batch import; existing and in-batch duplicates are reported, never reordered. */
  async addBatch(projectId: string, inputs: ParsedExternalComment[]): Promise<{
    created: ExternalInstruction[];
    duplicateIds: string[];
    instructions: ExternalInstruction[];
  }> {
    return this.enqueue(projectId, () => this.addBatchInner(projectId, inputs));
  }

  private async addBatchInner(projectId: string, inputs: ParsedExternalComment[]): Promise<{
    created: ExternalInstruction[]; duplicateIds: string[]; instructions: ExternalInstruction[];
  }> {
    const existing = await this.load(projectId);
    const known = new Set(existing.map((item) => item.instructionId));
    const created: ExternalInstruction[] = [];
    const duplicateIds: string[] = [];
    const now = new Date().toISOString();
    for (const input of inputs) {
      const instructionId = externalInstructionId(input.source, input.reviewerLabel, input.text);
      if (known.has(instructionId)) {
        duplicateIds.push(instructionId);
        continue;
      }
      known.add(instructionId);
      created.push({
        instructionId,
        source: input.source,
        ...(input.reviewerLabel ? { reviewerLabel: input.reviewerLabel } : {}),
        text: input.text,
        status: "pending",
        createdAt: now,
        updatedAt: now,
      });
    }
    const instructions = [...existing, ...created];
    if (created.length > 0) await this.saveUnqueued(projectId, instructions);
    return { created, duplicateIds, instructions };
  }

  /** 删除一条（返回删除后的列表；不存在 → null） */
  async remove(projectId: string, instructionId: string): Promise<ExternalInstruction[] | null> {
    return this.enqueue(projectId, () => this.removeInner(projectId, instructionId));
  }

  private async removeInner(projectId: string, instructionId: string): Promise<ExternalInstruction[] | null> {
    const existing = await this.load(projectId);
    if (!existing.some((instruction) => instruction.instructionId === instructionId)) {
      return null;
    }
    const next = existing.filter((instruction) => instruction.instructionId !== instructionId);
    await this.saveUnqueued(projectId, next);
    return next;
  }
}

/**
 * 已记录的合法「待作者裁决」终态标记（statusNote 前缀）。M11.4 Reliability
 * Closure（8c 实证 p-85d7749054b9 R2）：同一意见的 plan item 已判
 * AUTHOR_DECISION_REQUIRED 后，后续派发目标回报 not_applicable / unreported /
 * applied-无实据时，旧的 last-write-wins 聚合会把标记覆盖成 plain unresolved
 * ——合法的 author_decision 闭环被降级，翻转任务层 verdict。未验证为解决的
 * 派发回报不得抹除已记录的作者裁决标记（conflict / verified applied 仍是
 * 更强终态，可正常覆盖）。
 */
const PRESERVED_AUTHOR_DECISION_PREFIXES = ["AUTHOR_DECISION_REQUIRED", "EVIDENCE_ONLY_RECORDED"] as const;

function preservedAuthorDecisionNote(statusNote: string | undefined): string | undefined {
  if (statusNote === undefined) return undefined;
  return PRESERVED_AUTHOR_DECISION_PREFIXES.some((prefix) => statusNote.startsWith(prefix)) ? statusNote : undefined;
}

/**
 * 把一轮派发结果应用到指令状态（纯函数；确定性）。
 * 同一 instructionId 多章节报告聚合：
 * - 任一 conflict → conflict（保留依据）
 * - 任一「applied 且该目标文件真实变化」→ handled（gate 复核由 reverifyHandled 做）；
 *   部分章节未报告 → partially_handled
 * - 有 applied 但所有 applied 目标都无文件变化 → unresolved（自称执行无实据，不采信）
 * - 其余（全部 not_applicable / unreported）→ unresolved
 * unmatched（章节指错，没有任何目标命中）→ unresolved + 说明。
 * 已记录的 AUTHOR_DECISION_REQUIRED / EVIDENCE_ONLY_RECORDED 标记在
 * unresolved 写入分支中保留（见 preservedAuthorDecisionNote）。
 */
export function applyDispatchOutcome(
  instructions: ExternalInstruction[],
  dispatch: ExternalDispatchResult,
  now: string,
): { instructions: ExternalInstruction[]; changed: boolean } {
  let changed = false;
  const next = instructions.map((instruction): ExternalInstruction => {
    if (
      instruction.status === "handled" ||
      instruction.status === "conflict" ||
      instruction.status === "already_satisfied"
    ) {
      return instruction; // 终态：不因新轮次自动翻转（handled 的降级只经 gate 复核）
    }
    if (dispatch.unmatched.includes(instruction.instructionId)) {
      if (instruction.status === "unresolved" && instruction.statusNote?.startsWith("指定章节未匹配")) {
        return instruction;
      }
      changed = true;
      return {
        ...instruction,
        status: "unresolved",
        resolutionTrace: {
          commentId: instruction.instructionId, planItemIds: [], actionType: "modify", evidenceIds: [], patchIds: [],
          verification: {}, status: "unresolved", resolutionSummary: "No revision target matched the comment.",
          remainingIssue: `指定章节未匹配：${instruction.section ?? "(global)"}`,
        },
        statusNote: preservedAuthorDecisionNote(instruction.statusNote)
          ?? `指定章节未匹配到稿件文件：${instruction.section ?? "(global)"}（请修正章节或改为不限定）`,
        updatedAt: now,
      };
    }
    const reports = dispatch.outcomes.filter((report) => report.instructionId === instruction.instructionId);
    if (reports.length === 0) {
      return instruction; // 本轮未派发到该意见
    }
    const conflict = reports.find((report) => report.outcome === "conflict");
    if (conflict !== undefined) {
      changed = true;
      return {
        ...instruction,
        status: "conflict",
        resolutionTrace: {
          commentId: instruction.instructionId,
          planItemIds: conflict.planItemIds ?? [], actionType: "modify", target: conflict.target,
          evidenceIds: conflict.evidenceIds ?? [], patchIds: conflict.patchIds ?? [],
          verification: conflict.verification ?? {}, status: "conflict",
          resolutionSummary: conflict.basis ?? "Writer reported a conflict; manuscript facts were preserved.",
          remainingIssue: conflict.basis ?? "Author decision required.",
        },
        ...(conflict.basis !== undefined ? { conflictBasis: conflict.basis } : {}),
        statusNote: "该意见与稿件实验事实 / Evidence 冲突：系统未篡改事实，保留原结果并报告冲突",
        updatedAt: now,
      };
    }
    const appliedReports = reports.filter((report) => report.outcome === "applied");
    const realChange = appliedReports.some((report) => report.targetChanged === true);
    if (appliedReports.length > 0 && realChange) {
      const allReported = reports.every((report) => report.outcome !== "unreported");
      changed = true;
      return {
        ...instruction,
        status: allReported ? "handled" : "partially_handled",
        resolutionTrace: {
          commentId: instruction.instructionId,
          planItemIds: appliedReports.flatMap((report) => report.planItemIds ?? []),
          actionType: "modify",
          target: appliedReports.map((report) => report.target).filter((value): value is string => value !== undefined).join(", ") || undefined,
          evidenceIds: [...new Set(appliedReports.flatMap((report) => report.evidenceIds ?? []))],
          patchIds: appliedReports.flatMap((report) => report.patchIds ?? []),
          verification: appliedReports.reduce((acc, report) => ({ ...acc, ...(report.verification ?? {}) }), {}),
          status: allReported ? "handled" : "partially_handled",
          resolutionSummary: appliedReports.map((report) => report.basis ?? "Scoped revision applied.").join("; "),
          ...(!allReported ? { remainingIssue: "Some dispatched targets did not report an outcome." } : {}),
        },
        ...(allReported
          ? { statusNote: undefined, conflictBasis: undefined }
          : { statusNote: "部分章节已执行，其余未返回报告" }),
        updatedAt: now,
      };
    }
    if (appliedReports.length > 0 && !realChange) {
      changed = true;
      return {
        ...instruction,
        status: "unresolved",
        resolutionTrace: {
          commentId: instruction.instructionId,
          planItemIds: reports.flatMap((report) => report.planItemIds ?? []), actionType: "modify",
          evidenceIds: reports.flatMap((report) => report.evidenceIds ?? []), patchIds: reports.flatMap((report) => report.patchIds ?? []),
          verification: {}, status: "unresolved",
          resolutionSummary: "Writer reported no applicable change or no verifiable patch.",
          remainingIssue: "Coverage or patch verification did not pass.",
        },
        statusNote: preservedAuthorDecisionNote(instruction.statusNote)
          ?? "Writer 报告已执行，但目标文件没有实际变化（不采信自称已处理）",
        updatedAt: now,
      };
    }
    changed = true;
    return {
      ...instruction,
      status: "unresolved",
      resolutionTrace: {
        commentId: instruction.instructionId, planItemIds: reports.flatMap((report) => report.planItemIds ?? []),
        actionType: "modify", evidenceIds: reports.flatMap((report) => report.evidenceIds ?? []),
        patchIds: reports.flatMap((report) => report.patchIds ?? []), verification: {}, status: "unresolved",
        resolutionSummary: "All reported targets were not applicable or omitted execution results.",
        remainingIssue: "No verified resolution.",
      },
      statusNote: preservedAuthorDecisionNote(instruction.statusNote)
        ?? "派发的章节均报告不适用或未报告执行结果",
      updatedAt: now,
    };
  });
  return { instructions: next, changed };
}

/**
 * M11.4 Reliability Closure：patch-backed outcome 覆盖（确定性，§14 的
 * 「comment closure 由 accepted patches 推导，不依赖 LLM 自报」）。
 *
 * Run 1 实证（p-c923662f9c48，Reviewer 2）：意见的计划条目正确命中目标、
 * 候选 patch 通过全部守卫并被接受、目标真实变化——机器 lineage 已构成执行
 * 证据；但 Writer 的自报行写 not_applicable，聚合把意见记 unresolved →
 * 任务层假 FAIL。本函数在存在 patch 证据时把该意见的 not_applicable /
 * unreported 自报覆盖为 applied（自报留档在 basis）；conflict 是更强的
 * 诚实信号，不覆盖；已自报 applied 的不重复覆盖。
 */
export function applyPatchBackedOutcomeOverrides(
  reports: readonly ExternalOutcomeReport[],
  patchEvidence: {
    instructionIds: readonly string[];
    target: string;
    planItemIds: readonly string[];
    patchIds: readonly string[];
    evidenceIds?: readonly string[];
  },
): ExternalOutcomeReport[] {
  const backedIds = new Set(patchEvidence.instructionIds);
  if (backedIds.size === 0) {
    return reports as ExternalOutcomeReport[];
  }
  let changed = false;
  const next = reports.map((report): ExternalOutcomeReport => {
    if (!backedIds.has(report.instructionId)) {
      return report;
    }
    if (report.outcome === "applied" || report.outcome === "conflict") {
      return report;
    }
    changed = true;
    return {
      ...report,
      outcome: "applied",
      targetChanged: true,
      target: patchEvidence.target,
      planItemIds: [...patchEvidence.planItemIds],
      patchIds: [...patchEvidence.patchIds],
      ...(patchEvidence.evidenceIds !== undefined ? { evidenceIds: [...patchEvidence.evidenceIds] } : {}),
      verification: { ...(report.verification ?? {}), scope: true },
      basis: `deterministic patch attribution: accepted patch ${patchEvidence.patchIds.join(", ")} at ${patchEvidence.target}（Writer 自报 ${report.outcome}，以机器 patch lineage 为准）`,
    };
  });
  return changed ? next : (reports as ExternalOutcomeReport[]);
}

/**
 * revision.plan 构建时的 gate 复核（确定性自愈）：handled 意见对应的修订
 * 若在最新 gate 产物中触发 Fact Preservation FAIL（Writer 为满足意见而改了
 * 事实，被 gate 拦截），降级回 unresolved 重新进入派发（恢复闭环由
 * fact_preserve 条目驱动）。
 */
export function reverifyHandledInstructions(
  instructions: ExternalInstruction[],
  factPreservation: { ok: boolean } | null | undefined,
  now: string,
  citationPreservation?: { ok: boolean } | null,
  patchFailures?: ReadonlyMap<string, { fact?: boolean; citation?: boolean }>,
): { instructions: ExternalInstruction[]; changed: boolean } {
  if (factPreservation === null || factPreservation === undefined || citationPreservation === null || citationPreservation === undefined) {
    return { instructions, changed: false };
  }
  let changed = false;
  const next = instructions.map((instruction): ExternalInstruction => {
    if (instruction.status !== "handled") {
      return instruction;
    }
    // A gate failure is candidate-wide. Only a failure attributed to this
    // instruction's own patch may change its outcome.
    const ownFailure = patchFailures === undefined
      ? { fact: factPreservation.ok, citation: citationPreservation.ok }
      : patchFailures.get(instruction.instructionId);
    if (ownFailure === undefined) return instruction;
    const verification = {
      ...(instruction.resolutionTrace?.verification ?? {}),
      ...(ownFailure.fact !== undefined ? { fact: ownFailure.fact } : {}),
      ...(ownFailure.citation !== undefined ? { citation: ownFailure.citation } : {}),
    };
    if (instruction.resolutionTrace !== undefined &&
      instruction.resolutionTrace.verification.fact === verification.fact &&
      instruction.resolutionTrace.verification.citation === verification.citation) return instruction;
    changed = true;
    if (ownFailure.fact !== false && ownFailure.citation !== false) {
      return {
        ...instruction,
        resolutionTrace: {
          ...(instruction.resolutionTrace ?? {
            commentId: instruction.instructionId, planItemIds: [], actionType: "modify" as const,
            evidenceIds: [], patchIds: [], status: "handled" as const, resolutionSummary: "Revision passed preservation checks.",
          }),
          verification,
          status: "handled",
          remainingIssue: undefined,
        },
        updatedAt: now,
      };
    }
    return {
      ...instruction,
      status: "unresolved",
      ...(instruction.resolutionTrace !== undefined ? { resolutionTrace: {
        ...instruction.resolutionTrace,
        verification,
        status: "unresolved",
        remainingIssue: ownFailure.fact === false ? "Fact preservation failed for this patch." : "Citation preservation failed for this patch.",
      } } : {}),
      statusNote: ownFailure.fact === false
        ? "执行该意见的修订未通过事实保持检查，已回到待处理（恢复轮将重新执行）"
        : "执行该意见的修订未通过引用保持检查，已回到待处理（恢复轮将重新执行）",
      updatedAt: now,
    };
  });
  return { instructions: next, changed };
}
