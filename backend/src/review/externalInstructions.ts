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
 */
export type ExternalInstructionStatus =
  | "pending"
  | "handled"
  | "partially_handled"
  | "unresolved"
  | "conflict";

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
  createdAt: string;
  updatedAt: string;
}

/** 意见全文长度上限（超出拒绝；防误贴整篇稿件撑爆 prompt） */
export const EXTERNAL_TEXT_MAX_CHARS = 8_000;

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
    ["pending", "handled", "partially_handled", "unresolved", "conflict"].includes(value)
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
      createdAt,
      updatedAt: typeof record["updatedAt"] === "string" ? record["updatedAt"] : createdAt,
    });
  }
  return instructions;
}

export class ExternalInstructionStore {
  constructor(private readonly projects: ProjectStore) {}

  private filePath(projectId: string): string {
    return join(this.projects.reviewsDir(projectId), INSTRUCTIONS_FILE);
  }

  async load(projectId: string): Promise<ExternalInstruction[]> {
    let text: string;
    try {
      text = await readFile(this.filePath(projectId), "utf8");
    } catch {
      return [];
    }
    try {
      return readExternalInstructions(JSON.parse(text));
    } catch {
      return [];
    }
  }

  async save(projectId: string, instructions: ExternalInstruction[]): Promise<void> {
    // reviews/ 目录可能尚未创建（项目刚建 / 首条意见先于任何 review 落盘）
    await mkdir(this.projects.reviewsDir(projectId), { recursive: true }).catch(() => {});
    await writeJsonAtomic(this.filePath(projectId), {
      schemaVersion: 1,
      instructions,
    });
  }

  /** 新增一条（幂等：同内容 id 已存在 → 返回 null） */
  async add(projectId: string, input: {
    source: ExternalInstructionSource;
    text: string;
    reviewerLabel?: string;
    section?: string;
    now?: string;
  }): Promise<ExternalInstruction | null> {
    const now = input.now ?? new Date().toISOString();
    const instructionId = externalInstructionId(input.source, input.reviewerLabel, input.text);
    const existing = await this.load(projectId);
    if (existing.some((instruction) => instruction.instructionId === instructionId)) {
      return null;
    }
    const instruction: ExternalInstruction = {
      instructionId,
      source: input.source,
      ...(input.reviewerLabel !== undefined ? { reviewerLabel: input.reviewerLabel } : {}),
      text: input.text,
      ...(input.section !== undefined ? { section: input.section } : {}),
      status: "pending",
      createdAt: now,
      updatedAt: now,
    };
    await this.save(projectId, [...existing, instruction]);
    return instruction;
  }

  /** 删除一条（返回删除后的列表；不存在 → null） */
  async remove(projectId: string, instructionId: string): Promise<ExternalInstruction[] | null> {
    const existing = await this.load(projectId);
    if (!existing.some((instruction) => instruction.instructionId === instructionId)) {
      return null;
    }
    const next = existing.filter((instruction) => instruction.instructionId !== instructionId);
    await this.save(projectId, next);
    return next;
  }
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
 */
export function applyDispatchOutcome(
  instructions: ExternalInstruction[],
  dispatch: ExternalDispatchResult,
  now: string,
): { instructions: ExternalInstruction[]; changed: boolean } {
  let changed = false;
  const next = instructions.map((instruction): ExternalInstruction => {
    if (instruction.status === "handled" || instruction.status === "conflict") {
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
        statusNote: `指定章节未匹配到稿件文件：${instruction.section ?? "(global)"}（请修正章节或改为不限定）`,
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
        statusNote: "Writer 报告已执行，但目标文件没有实际变化（不采信自称已处理）",
        updatedAt: now,
      };
    }
    changed = true;
    return {
      ...instruction,
      status: "unresolved",
      statusNote: "派发的章节均报告不适用或未报告执行结果",
      updatedAt: now,
    };
  });
  return { instructions: next, changed };
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
): { instructions: ExternalInstruction[]; changed: boolean } {
  if (factPreservation === null || factPreservation === undefined || factPreservation.ok) {
    return { instructions, changed: false };
  }
  let changed = false;
  const next = instructions.map((instruction): ExternalInstruction => {
    if (instruction.status !== "handled") {
      return instruction;
    }
    changed = true;
    return {
      ...instruction,
      status: "unresolved",
      statusNote: "执行该意见的修订未通过事实保持检查，已回到待处理（恢复轮将重新执行）",
      updatedAt: now,
    };
  });
  return { instructions: next, changed };
}
