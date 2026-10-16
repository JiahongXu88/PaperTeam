/**
 * M14.6：MissingMaterialLedger —— 缺失材料账本（research/missing-material-ledger.json）。
 *
 * 职责：
 *   1. 存储：项目级队列串行 + 原子写；损坏文件停止读写（不自动覆盖）；
 *   2. upsertProposals：扫描 / 模型提案以稳定 gapId 幂等并入；上游指纹变化时，
 *      proposed 直接刷新，已决定的只标 stale（决定不被机器覆盖）；
 *   3. applyDecision：作者决定推进状态（账本不校验 actor——actor 校验与
 *      决定落账由 AuthorDecisionStore 负责，这里只记录 decisionId）；
 *   4. reevaluate：章节事实状况变化后的确定性收口（facts_available）；
 *   5. blockingGaps：仍应阻断该章写作的差距。
 *
 * 另导出两组纯函数：deriveChapterMaterialGaps（消费 Planner 的
 * missingMaterialChapters 结果，不重算规则）与 deriveScopeGapProposals
 * （storyline.scopeConcerns 逐条 → 建议；不发明章节或实验）。
 */

import { mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

import { BusinessError } from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { writeJsonAtomic } from "../util/atomic.js";
import { fingerprintJson, sha256Hex } from "../util/hash.js";
import {
  MISSING_MATERIAL_DECISIONS,
  type MissingMaterialDecision,
  type MissingMaterialGap,
  type MissingMaterialGapProposal,
  type MissingMaterialGapType,
  type MissingMaterialLedgerFile,
  type ReevaluateResult,
  type RequiredMaterial,
  type UpsertProposalsResult,
} from "./missingMaterialTypes.js";
import type { FactView, ResearchFactContext } from "./researchInputTypes.js";
import { statementHasNumericClaim } from "./ThesisPlannerService.js";
import type { ChapterMappingFile, ThesisChapterPlan, ThesisContribution, ThesisStoryline } from "./thesisWorkflowTypes.js";

export const MISSING_MATERIAL_LEDGER_FILE = "missing-material-ledger.json";

// ---------------------------------------------------------------------------
// 标识 / 指纹
// ---------------------------------------------------------------------------

/** 稳定 gapId：同类型 + 同章 + 同标题（空白不敏感、小写）→ 同 id；重复扫描幂等 */
export function missingMaterialGapId(gapType: MissingMaterialGapType, chapterId: string | undefined, title: string): string {
  const normalizedTitle = title.replace(/\s+/g, "").toLowerCase();
  return `g-${sha256Hex(`${gapType}|${chapterId ?? ""}|${normalizedTitle}`).slice(0, 10)}`;
}

export interface MissingMaterialFingerprintInput {
  gapType: MissingMaterialGapType;
  chapterId?: string;
  contributionIds: readonly string[];
  sourceInputs: ReadonlyArray<{ inputId: string; contentHash: string }>;
  outlineFingerprint: string;
  /** 额外参与指纹的文本（如 scopeConcern 原文）；缺省不参与 */
  content?: string;
}

/** 上游指纹：用于 stale 判定，与 gapId 分离 */
export function missingMaterialFingerprint(input: MissingMaterialFingerprintInput): string {
  return fingerprintJson({
    gapType: input.gapType,
    chapterId: input.chapterId ?? "",
    contributionIds: [...input.contributionIds].sort(),
    sourceInputs: [...input.sourceInputs]
      .map((item) => ({ inputId: item.inputId, contentHash: item.contentHash }))
      .sort((a, b) => (a.inputId < b.inputId ? -1 : a.inputId > b.inputId ? 1 : 0)),
    outlineFingerprint: input.outlineFingerprint,
    ...(input.content !== undefined ? { content: input.content } : {}),
  });
}

// ---------------------------------------------------------------------------
// 账本
// ---------------------------------------------------------------------------

export class MissingMaterialLedger {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly now: () => Date;

  constructor(private readonly projects: ProjectStore, options: { now?: () => Date } = {}) {
    this.now = options.now ?? (() => new Date());
  }

  filePath(projectId: string): string {
    return join(this.projects.researchDir(projectId), MISSING_MATERIAL_LEDGER_FILE);
  }

  private enqueue<T>(projectId: string, run: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(projectId) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(run);
    this.queues.set(projectId, task);
    task.finally(() => {
      if (this.queues.get(projectId) === task) this.queues.delete(projectId);
    }).catch(() => {});
    return task;
  }

  async load(projectId: string): Promise<MissingMaterialLedgerFile> {
    await this.projects.getRequired(projectId);
    let raw: string;
    try {
      raw = await readFile(this.filePath(projectId), "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return { schemaVersion: 1, projectId, gaps: [], updatedAt: this.now().toISOString() };
      }
      throw error;
    }
    let parsed: MissingMaterialLedgerFile;
    try {
      parsed = JSON.parse(raw) as MissingMaterialLedgerFile;
    } catch {
      throw new BusinessError("STAGE_CONTRACT_VIOLATION", `${MISSING_MATERIAL_LEDGER_FILE} 损坏，已停止读写（不自动覆盖）`);
    }
    if (parsed === null || typeof parsed !== "object" || parsed.schemaVersion !== 1 || !Array.isArray(parsed.gaps)) {
      throw new BusinessError("STAGE_CONTRACT_VIOLATION", `${MISSING_MATERIAL_LEDGER_FILE} 结构不合法`);
    }
    return parsed;
  }

  async list(projectId: string): Promise<MissingMaterialGap[]> {
    return (await this.load(projectId)).gaps;
  }

  async get(projectId: string, gapId: string): Promise<MissingMaterialGap | undefined> {
    return (await this.list(projectId)).find((gap) => gap.gapId === gapId);
  }

  private async save(projectId: string, file: MissingMaterialLedgerFile): Promise<void> {
    const path = this.filePath(projectId);
    await mkdir(dirname(path), { recursive: true });
    await writeJsonAtomic(path, { ...file, updatedAt: this.now().toISOString() });
  }

  /** 读-改-写（队列内） */
  private async update<T>(projectId: string, mutate: (file: MissingMaterialLedgerFile) => T): Promise<T> {
    return this.enqueue(projectId, async () => {
      const file = await this.load(projectId);
      const result = mutate(file);
      await this.save(projectId, file);
      return result;
    });
  }

  /**
   * 并入提案（扫描 / 模型）。只能产生 proposed：
   *   - 新 gapId → 插入 proposed；
   *   - 同 gapId 同指纹 → unchanged（描述 / 证据 / 需求有变则同步文本；stale 不在此清除）；
   *   - 同 gapId 不同指纹：proposed → 刷新指纹与内容；已决定 → 标 stale（保留状态与决定），
   *     指纹更新为当前值，stale 直到新决定 / reevaluate 收口才清除。
   */
  async upsertProposals(projectId: string, proposals: readonly MissingMaterialGapProposal[]): Promise<UpsertProposalsResult> {
    return this.update(projectId, (file) => {
      const now = this.now().toISOString();
      const result: UpsertProposalsResult = { created: 0, unchanged: 0, refreshed: 0, staleMarked: 0 };
      const byId = new Map(file.gaps.map((gap) => [gap.gapId, gap]));
      for (const proposal of proposals) {
        const content = proposalContent(proposal);
        const existing = byId.get(proposal.gapId);
        if (existing === undefined) {
          const gap: MissingMaterialGap = {
            schemaVersion: 1,
            projectId,
            ...content,
            status: "proposed",
            createdAt: now,
            updatedAt: now,
          };
          file.gaps.push(gap);
          byId.set(gap.gapId, gap);
          result.created += 1;
          continue;
        }
        if (existing.sourceFingerprint === proposal.sourceFingerprint) {
          // stale 只由新决定 / reevaluate 清除：同指纹重扫不代表作者已重评
          if (syncText(existing, content)) existing.updatedAt = now;
          result.unchanged += 1;
          continue;
        }
        if (existing.status === "proposed") {
          Object.assign(existing, content);
          delete existing.stale;
          existing.updatedAt = now;
          result.refreshed += 1;
          continue;
        }
        // 已有作者决定：不覆盖，标 stale 等待重评（首次标记保留 since）
        if (existing.stale === undefined) {
          existing.stale = { since: now, reason: "上游材料 / 章节结构在作者决定之后发生变化，需重新评估" };
          result.staleMarked += 1;
        }
        syncText(existing, content);
        existing.sourceFingerprint = proposal.sourceFingerprint;
        existing.updatedAt = now;
      }
      file.lastEvaluatedAt = now;
      return result;
    });
  }

  /**
   * 作者决定推进状态。同 decisionId 重复提交幂等（返回既有）；新 decisionId 覆盖旧决定。
   * 不校验 actor：决定应先经 AuthorDecisionStore 落账再调用本方法。
   */
  async applyDecision(
    projectId: string,
    input: { gapId: string; decision: MissingMaterialDecision; decisionId: string; rationale?: string },
  ): Promise<MissingMaterialGap> {
    if (!MISSING_MATERIAL_DECISIONS.includes(input.decision)) {
      throw new BusinessError("INVALID_REQUEST", `缺失材料决定只能是 ${MISSING_MATERIAL_DECISIONS.join(" / ")}`);
    }
    if (typeof input.decisionId !== "string" || input.decisionId.trim() === "") {
      throw new BusinessError("INVALID_REQUEST", "decisionId 不能为空");
    }
    return this.update(projectId, (file) => {
      const gap = file.gaps.find((item) => item.gapId === input.gapId);
      if (gap === undefined) {
        throw new BusinessError("INVALID_REQUEST", `缺失材料条目不存在：${input.gapId}`);
      }
      if (gap.decisionId === input.decisionId) return gap;
      const now = this.now().toISOString();
      gap.decisionId = input.decisionId;
      gap.decision = input.decision;
      if (input.rationale !== undefined) gap.decisionRationale = input.rationale;
      else delete gap.decisionRationale;
      delete gap.resolution;
      delete gap.stale;
      switch (input.decision) {
        case "confirm_missing":
          gap.status = "confirmed_missing";
          break;
        case "supply_experiment_data":
        case "supply_research_record":
        case "supply_manuscript":
          // 材料已补但事实尚未确认：requiredMaterials 不变，由 reevaluate 以事实状况收口
          gap.status = "supplied";
          break;
        case "write_as_limitation":
          gap.status = "confirmed_missing";
          gap.resolution = "limitation";
          break;
        case "defer_chapter":
          gap.status = "deferred";
          gap.resolution = "chapter_deferred";
          break;
        case "reject":
          gap.status = "rejected";
          gap.resolution = "scope_rejected";
          break;
      }
      gap.updatedAt = now;
      return gap;
    });
  }

  /**
   * 章节事实状况变化后的确定性收口：A 类差距所属章现已有可用事实且不再被 Planner
   * 判为缺材料 → resolved / facts_available（stale 一并清除）。supplied 但章仍缺
   * 材料的保持 supplied（材料已补但事实尚未确认）。rejected / resolved 不动。
   */
  async reevaluate(
    projectId: string,
    input: { chaptersWithUsableFacts: ReadonlySet<string>; currentMissingChapterIds: ReadonlySet<string> },
  ): Promise<ReevaluateResult> {
    return this.update(projectId, (file) => {
      const now = this.now().toISOString();
      const result: ReevaluateResult = { resolved: 0, unchanged: 0 };
      for (const gap of file.gaps) {
        if (
          gap.gapType === "planned_chapter_material" &&
          gap.chapterId !== undefined &&
          gap.status !== "resolved" &&
          gap.status !== "rejected" &&
          input.chaptersWithUsableFacts.has(gap.chapterId) &&
          !input.currentMissingChapterIds.has(gap.chapterId)
        ) {
          gap.status = "resolved";
          gap.resolution = "facts_available";
          delete gap.stale;
          gap.updatedAt = now;
          result.resolved += 1;
          continue;
        }
        result.unchanged += 1;
      }
      file.lastEvaluatedAt = now;
      return result;
    });
  }

  /**
   * 仍应阻断章节写作的差距：A 类、status ∈ {proposed, confirmed_missing}、无 resolution、
   * 且不能在无材料情况下写作。
   */
  async blockingGaps(projectId: string): Promise<MissingMaterialGap[]> {
    return (await this.list(projectId)).filter(isBlockingGap);
  }
}

export function isBlockingGap(gap: MissingMaterialGap): boolean {
  return (
    gap.gapType === "planned_chapter_material" &&
    (gap.status === "proposed" || gap.status === "confirmed_missing") &&
    gap.resolution === undefined &&
    !gap.canWriteWithoutMaterial
  );
}

/** 提案 → 账本可控字段（显式白名单：提案方无法夹带 status / decision） */
function proposalContent(proposal: MissingMaterialGapProposal): MissingMaterialGapProposal {
  return {
    gapId: proposal.gapId,
    gapType: proposal.gapType,
    origin: proposal.origin,
    ...(proposal.chapterId !== undefined ? { chapterId: proposal.chapterId } : {}),
    ...(proposal.chapterTitleZh !== undefined ? { chapterTitleZh: proposal.chapterTitleZh } : {}),
    contributionIds: [...proposal.contributionIds],
    sourceInputIds: [...proposal.sourceInputIds],
    title: proposal.title,
    description: proposal.description,
    whyInsufficient: proposal.whyInsufficient,
    supportingEvidence: [...proposal.supportingEvidence],
    requiredMaterials: proposal.requiredMaterials.map((item) => ({ kind: item.kind, description: item.description })),
    canWriteWithoutMaterial: proposal.canWriteWithoutMaterial,
    requiresExperiment: proposal.requiresExperiment,
    sourceFingerprint: proposal.sourceFingerprint,
  };
}

/** 同步文本类字段（描述 / 证据 / 需求 / 标题）；返回是否有变化 */
function syncText(target: MissingMaterialGap, content: MissingMaterialGapProposal): boolean {
  const before = fingerprintJson({
    title: target.title,
    description: target.description,
    whyInsufficient: target.whyInsufficient,
    supportingEvidence: target.supportingEvidence,
    requiredMaterials: target.requiredMaterials,
    chapterTitleZh: target.chapterTitleZh ?? null,
  });
  const after = fingerprintJson({
    title: content.title,
    description: content.description,
    whyInsufficient: content.whyInsufficient,
    supportingEvidence: content.supportingEvidence,
    requiredMaterials: content.requiredMaterials,
    chapterTitleZh: content.chapterTitleZh ?? null,
  });
  if (before === after) return false;
  target.title = content.title;
  target.description = content.description;
  target.whyInsufficient = content.whyInsufficient;
  target.supportingEvidence = [...content.supportingEvidence];
  target.requiredMaterials = content.requiredMaterials.map((item) => ({ ...item }));
  if (content.chapterTitleZh !== undefined) target.chapterTitleZh = content.chapterTitleZh;
  return true;
}

// ---------------------------------------------------------------------------
// 确定性派生（纯函数）
// ---------------------------------------------------------------------------

const STATEMENT_PREVIEW_CHARS = 120;

export interface DeriveChapterMaterialGapsInput {
  projectId: string;
  mapping: ChapterMappingFile;
  /** Planner.missingMaterialChapters 的结果（本层不重算规则） */
  missingChapters: readonly ThesisChapterPlan[];
  contributions: readonly ThesisContribution[];
  factContext: Pick<ResearchFactContext, "facts" | "inputs">;
}

/**
 * A 类差距：每个缺材料章一条。描述列出本章拥有的贡献；whyInsufficient 陈述作者确认
 * 事实计数与无事实支撑的数值陈述；requiredMaterials 由贡献类型推断。
 */
export function deriveChapterMaterialGaps(input: DeriveChapterMaterialGapsInput): MissingMaterialGapProposal[] {
  const contributionById = new Map(input.contributions.map((item) => [item.id, item]));
  const includedByInputId = new Map(input.factContext.inputs.included.map((item) => [item.inputId, item]));
  const authorConfirmedIds = new Set(input.factContext.facts.authorConfirmed.map((fact) => fact.factId));
  const sourceVerifiedIds = new Set(input.factContext.facts.sourceVerifiedUnconfirmed.map((fact) => fact.factId));
  const gaps: MissingMaterialGapProposal[] = [];

  for (const chapter of input.missingChapters) {
    const owned = chapter.ownsContributionIds
      .map((id) => contributionById.get(id))
      .filter((item): item is ThesisContribution => item !== undefined);
    const linkedFactIds = new Set<string>(chapter.factIds);
    for (const contribution of owned) for (const factId of contribution.linkedFactIds) linkedFactIds.add(factId);
    const confirmedCount = [...linkedFactIds].filter((id) => authorConfirmedIds.has(id)).length;
    const verifiedUnconfirmedCount = [...linkedFactIds].filter((id) => sourceVerifiedIds.has(id)).length;
    const usable = (factId: string): boolean => authorConfirmedIds.has(factId) || sourceVerifiedIds.has(factId);
    const unbackedNumeric = owned.filter(
      (item) => item.kind === "experiment_result" && statementHasNumericClaim(item.statement) && !item.linkedFactIds.some(usable),
    );

    const descriptionLines = [
      `本章（${chapter.responsibility}）拥有 ${chapter.ownsContributionIds.length} 项研究贡献：`,
      ...owned.map((item) => `- ${item.id} [${item.kind}] ${truncate(item.statement, STATEMENT_PREVIEW_CHARS)}`),
    ];
    const unknownIds = chapter.ownsContributionIds.filter((id) => !contributionById.has(id));
    if (unknownIds.length > 0) descriptionLines.push(`- 贡献台账中未找到：${unknownIds.join("、")}`);

    const whyLines = [`本章关联的作者确认事实：${confirmedCount} 条（来源核验待确认：${verifiedUnconfirmedCount} 条）。`];
    for (const item of unbackedNumeric) {
      whyLines.push(`贡献 ${item.id} 的陈述含具体数值（${truncate(item.statement, STATEMENT_PREVIEW_CHARS)}），但没有任何作者确认事实对应该数值。`);
    }
    if (confirmedCount === 0 && unbackedNumeric.length === 0) {
      whyLines.push("Writer 无权在没有作者确认事实的情况下写入本章的结果性内容。");
    }

    const requiredMaterials: RequiredMaterial[] = [];
    const addMaterial = (material: RequiredMaterial): void => {
      if (!requiredMaterials.some((item) => item.kind === material.kind && item.description === material.description)) {
        requiredMaterials.push(material);
      }
    };
    for (const item of owned) addMaterial(materialForContribution(item));
    if (owned.length === 0) {
      addMaterial(
        chapter.responsibility === "experiment"
          ? { kind: "experiment_data", description: "该章实验的原始实验记录 / 评测数据（含指标定义、数据集、重复次数）" }
          : { kind: "research_record", description: "方法实现 / 设计记录" },
      );
    }
    if (verifiedUnconfirmedCount > 0) {
      addMaterial({ kind: "author_confirmation", description: "已有来源核验事实待作者确认" });
    }

    const requiresExperiment = chapter.responsibility === "experiment" || owned.some((item) => item.kind === "experiment_result");
    const title = `「${chapter.titleZh}」缺少可支撑写作的研究材料`;
    const sourceInputs = chapter.sourceInputIds
      .map((inputId) => includedByInputId.get(inputId))
      .filter((item): item is NonNullable<typeof item> => item !== undefined)
      .map((item) => ({ inputId: item.inputId, contentHash: item.contentHash }));

    gaps.push({
      gapId: missingMaterialGapId("planned_chapter_material", chapter.chapterId, title),
      gapType: "planned_chapter_material",
      origin: "deterministic",
      chapterId: chapter.chapterId,
      chapterTitleZh: chapter.titleZh,
      contributionIds: [...chapter.ownsContributionIds],
      sourceInputIds: [...chapter.sourceInputIds],
      title,
      description: descriptionLines.join("\n"),
      whyInsufficient: whyLines.join(" "),
      supportingEvidence: [`chapter:${chapter.chapterId}`, ...chapter.ownsContributionIds.map((id) => `contribution:${id}`)],
      requiredMaterials,
      canWriteWithoutMaterial: chapter.responsibility !== "experiment",
      requiresExperiment,
      sourceFingerprint: missingMaterialFingerprint({
        gapType: "planned_chapter_material",
        chapterId: chapter.chapterId,
        contributionIds: chapter.ownsContributionIds,
        sourceInputs,
        outlineFingerprint: input.mapping.outlineFingerprint,
      }),
    });
  }
  return gaps;
}

function materialForContribution(contribution: ThesisContribution): RequiredMaterial {
  switch (contribution.kind) {
    case "experiment_result":
      return { kind: "experiment_data", description: "该结果的原始实验记录 / 评测数据（含指标定义、数据集、重复次数）" };
    case "dataset":
      return { kind: "dataset_description", description: "数据集描述（来源、规模、划分、预处理与获取方式）" };
    default:
      return { kind: "research_record", description: "方法实现 / 设计记录" };
  }
}

export interface DeriveScopeGapProposalsInput {
  projectId: string;
  storyline: ThesisStoryline | null;
  mapping: ChapterMappingFile | null;
  factContext: Pick<ResearchFactContext, "facts" | "inputs">;
}

const SCOPE_TITLE_PREVIEW_CHARS = 40;

/**
 * B 类建议：storyline.scopeConcerns 逐条 → proposed_scope_gap。只转述 Planner 的范围自述，
 * 不发明章节或实验；requiredMaterials 只有 author_confirmation。
 */
export function deriveScopeGapProposals(input: DeriveScopeGapProposalsInput): MissingMaterialGapProposal[] {
  const concerns = (input.storyline?.scopeConcerns ?? []).map((item) => item.trim()).filter((item) => item !== "");
  if (concerns.length === 0) return [];
  const sourceInputs = input.factContext.inputs.included.map((item) => ({ inputId: item.inputId, contentHash: item.contentHash }));
  const outlineFingerprint = input.mapping?.outlineFingerprint ?? "";
  return concerns.map((concern, index) => {
    const title = `研究范围建议 ${index + 1}：${truncate(concern, SCOPE_TITLE_PREVIEW_CHARS)}`;
    return {
      gapId: missingMaterialGapId("proposed_scope_gap", undefined, title),
      gapType: "proposed_scope_gap",
      origin: "storyline_scope_concern",
      contributionIds: [],
      sourceInputIds: sourceInputs.map((item) => item.inputId),
      title,
      description: concern,
      whyInsufficient: "Planner 在主线规划时自述研究范围偏窄；这是建议，不是已确认缺失。",
      supportingEvidence: [`storyline.scopeConcerns[${index}]`],
      requiredMaterials: [{ kind: "author_confirmation", description: "作者确认是否扩展研究范围；确认后再生成具体材料需求" }],
      canWriteWithoutMaterial: true,
      requiresExperiment: false,
      sourceFingerprint: missingMaterialFingerprint({
        gapType: "proposed_scope_gap",
        contributionIds: [],
        sourceInputs,
        outlineFingerprint,
        content: concern,
      }),
    };
  });
}

/** 章节有可用事实（authorConfirmed ∪ sourceVerifiedUnconfirmed 命中映射 factIds ∪ owner 贡献 linkedFactIds）的集合——供 reevaluate 使用 */
export function chaptersWithUsableFacts(input: {
  mapping: Pick<ChapterMappingFile, "chapters">;
  contributions: readonly ThesisContribution[];
  facts: Pick<ResearchFactContext["facts"], "authorConfirmed" | "sourceVerifiedUnconfirmed">;
}): Set<string> {
  const byId = new Map(input.contributions.map((item) => [item.id, item]));
  const usable = new Set<string>([...input.facts.authorConfirmed, ...input.facts.sourceVerifiedUnconfirmed].map((fact: FactView) => fact.factId));
  const result = new Set<string>();
  for (const chapter of input.mapping.chapters) {
    const linked = new Set<string>(chapter.factIds);
    for (const id of chapter.ownsContributionIds) for (const factId of byId.get(id)?.linkedFactIds ?? []) linked.add(factId);
    if ([...linked].some((factId) => usable.has(factId))) result.add(chapter.chapterId);
  }
  return result;
}

function truncate(text: string, max: number): string {
  const normalized = text.replace(/\s+/g, " ").trim();
  return normalized.length <= max ? normalized : `${normalized.slice(0, max - 1)}…`;
}
