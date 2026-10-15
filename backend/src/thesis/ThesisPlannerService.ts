/**
 * M14.2：thesis_from_papers 的规划层服务。
 *
 * 职责（模型只产生提案，确定性代码校验与落盘）：
 *   1. extractContributions —— 逐输入提取研究贡献提案（quote 逐字锚定）；
 *   2. planStoryline —— 研究主线 + 两级大纲 + 章节—来源映射（一次提案，
 *      确定性校验：贡献/输入/事实引用全合法、每节恰好归属一章、单节章
 *      标题一致性等；≤2 次 error-feedback repair）；
 *   3. confirmContributions / confirmMapping —— 作者确认落盘；
 *   4. missingMaterialChapters —— 缺实验材料章的确定性检测（写作前 HITL 依据）。
 *
 * 复用：ResearchInputService（注册表 / 事实 / 决策）、ThesisDocumentService
 * （文档模型落盘）、ManuscriptService（outline 落盘）、sourceVerification 的
 * quote 逐字核验口径。不引入第二套事实或冲突系统。
 */

import { AgentRunFailedError, BusinessError } from "../errors.js";
import type { AgentRuntime } from "../runtime/types.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { ParsedDocumentStore } from "../ingestion/ParsedDocumentStore.js";
import { extractJsonObject } from "../agents/outputParsing.js";
import { writeJsonAtomic } from "../util/atomic.js";
import { join } from "node:path";
import { readFile } from "node:fs/promises";
import type { ManuscriptService, Outline, OutlineSection } from "../manuscript/ManuscriptService.js";
import { SECTION_FILE_PATTERN } from "../manuscript/ManuscriptService.js";
import type { ResearchInputService } from "./ResearchInputService.js";
import type { ThesisDocumentService } from "./ThesisDocumentService.js";
import { documentPlainText } from "./sourceVerification.js";
import type { AuthorDecision } from "./researchInputTypes.js";
import {
  CHAPTER_RESPONSIBILITIES,
  CONTRIBUTION_KINDS,
  CONTRIBUTION_RELATION_TYPES,
  outlineFingerprintFromChapters,
  thesisContributionId,
  thesisPlanFingerprint,
  type ChapterMappingFile,
  type ThesisChapterPlan,
  type ThesisChapterResponsibility,
  type ThesisContribution,
  type ThesisContributionFile,
  type ThesisContributionKind,
  type ThesisStoryline,
  type ThesisStorylineFile,
} from "./thesisWorkflowTypes.js";

export interface ThesisPlannerServiceOptions {
  runtime: AgentRuntime;
  agentId: string;
  projects: ProjectStore;
  manuscript: ManuscriptService;
  researchInputs: ResearchInputService;
  thesisDocuments: ThesisDocumentService;
  documents: ParsedDocumentStore;
  now?: () => Date;
  log?: (message: string) => void;
}

const STORYLINE_REPAIR_MAX_ATTEMPTS = 2;
/** 单输入贡献提取的文档投影预算（字符） */
const CONTRIBUTION_DOC_BUDGET = 12_000;
/** 单输入贡献条数上限 */
const MAX_CONTRIBUTIONS_PER_INPUT = 20;
/** thesis 大纲的节数上限（ManuscriptService 默认 20；学位论文放宽） */
export const THESIS_OUTLINE_MAX_SECTIONS = 60;
export const THESIS_OUTLINE_MIN_SECTIONS = 3;
/** 章数上下限（硕士学位论文 MVP：3–12 章） */
const MIN_CHAPTERS = 3;
const MAX_CHAPTERS = 12;

export interface ContributionsExtractionResult {
  inputsProcessed: number;
  proposals: number;
  anchored: number;
  skippedInputs: Array<{ inputId: string; reason: string }>;
  perInput: Record<string, { status: "ok" | "failed" | "skipped"; proposals: number; anchored: number; taskId?: string }>;
}

export interface StorylinePlanResult {
  storyline: ThesisStoryline;
  chapters: ThesisChapterPlan[];
  outline: Outline;
  mappingStatus: "proposed";
  repairAttempts: number;
  taskId?: string;
}

export class ThesisPlannerService {
  private readonly runtime: AgentRuntime;
  private readonly agentId: string;
  private readonly projects: ProjectStore;
  private readonly manuscript: ManuscriptService;
  private readonly researchInputs: ResearchInputService;
  private readonly thesisDocuments: ThesisDocumentService;
  private readonly documents: ParsedDocumentStore;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(options: ThesisPlannerServiceOptions) {
    this.runtime = options.runtime;
    this.agentId = options.agentId;
    this.projects = options.projects;
    this.manuscript = options.manuscript;
    this.researchInputs = options.researchInputs;
    this.thesisDocuments = options.thesisDocuments;
    this.documents = options.documents;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  // ---------- 文件路径 ----------

  private contributionsPath(projectId: string): string {
    return join(this.projects.researchDir(projectId), "thesis-contributions.json");
  }

  private storylinePath(projectId: string): string {
    return join(this.projects.researchDir(projectId), "thesis-storyline.json");
  }

  private mappingPath(projectId: string): string {
    return join(this.projects.researchDir(projectId), "chapter-mapping.json");
  }

  async loadContributions(projectId: string): Promise<ThesisContributionFile | null> {
    return readJsonOrNull<ThesisContributionFile>(this.contributionsPath(projectId));
  }

  async loadStoryline(projectId: string): Promise<ThesisStorylineFile | null> {
    return readJsonOrNull<ThesisStorylineFile>(this.storylinePath(projectId));
  }

  async loadMapping(projectId: string): Promise<ChapterMappingFile | null> {
    return readJsonOrNull<ChapterMappingFile>(this.mappingPath(projectId));
  }

  // ---------- 贡献提取 ----------

  /**
   * 逐输入提取研究贡献提案。quote 逐字命中文档全文 → anchorStatus=verbatim；
   * 未命中 → not_found（保留提案，作者可见，但 planner 上下文会如实标注）。
   * 幂等：同 id（输入+类型+归一陈述）不重复；已确认条目状态保持。
   */
  async extractContributions(
    projectId: string,
    options: { signal?: AbortSignal; language?: "zh" | "en" } = {},
  ): Promise<ContributionsExtractionResult> {
    const registry = await this.researchInputs.list(projectId);
    const parseable = registry.inputs.filter(
      (input) => input.parse.status === "full_text" || input.parse.status === "partial",
    );
    const result: ContributionsExtractionResult = {
      inputsProcessed: 0,
      proposals: 0,
      anchored: 0,
      skippedInputs: [],
      perInput: {},
    };
    const file = (await this.loadContributions(projectId)) ?? emptyContributions(projectId, this.now().toISOString());
    const existingIds = new Set(file.items.map((item) => item.id));

    for (const input of parseable) {
      const document = await this.documents.load(projectId, input.version.sourceId);
      if (document === null || document.contentHash !== input.version.contentHash) {
        result.skippedInputs.push({ inputId: input.inputId, reason: "ParsedDocument 缺失或内容版本不匹配" });
        result.perInput[input.inputId] = { status: "skipped", proposals: 0, anchored: 0 };
        continue;
      }
      const fullText = documentPlainText(document.blocks);
      if (fullText.trim() === "") {
        result.skippedInputs.push({ inputId: input.inputId, reason: "文档无可用文本" });
        result.perInput[input.inputId] = { status: "skipped", proposals: 0, anchored: 0 };
        continue;
      }
      result.inputsProcessed += 1;
      let outcome: { items: ThesisContribution[]; anchored: number; taskId?: string };
      try {
        outcome = await this.extractContributionsForInput(projectId, input, fullText, existingIds, options);
      } catch (error) {
        // 单输入失败隔离（不吞：记录 failed，继续其余输入；stage 层决定整体语义）
        this.log(`thesis contributions 提取失败 ${input.inputId}: ${(error as Error).message}`);
        result.perInput[input.inputId] = { status: "failed", proposals: 0, anchored: 0 };
        result.skippedInputs.push({ inputId: input.inputId, reason: `提取失败：${(error as Error).message}` });
        continue;
      }
      file.items.push(...outcome.items);
      for (const item of outcome.items) existingIds.add(item.id);
      file.extraction.perInput[input.inputId] = {
        ...(outcome.taskId !== undefined ? { taskId: outcome.taskId } : {}),
        status: "ok",
        proposals: outcome.items.length,
        anchored: outcome.anchored,
      };
      result.perInput[input.inputId] = { status: "ok", proposals: outcome.items.length, anchored: outcome.anchored };
      result.proposals += outcome.items.length;
      result.anchored += outcome.anchored;
    }

    if (result.inputsProcessed > 0) {
      await writeJsonAtomic(this.contributionsPath(projectId), {
        ...file,
        projectId,
        updatedAt: this.now().toISOString(),
      });
    }
    return result;
  }

  /** 作者确认 / 拒绝贡献（幂等；确认未锚定贡献时如实保留 anchorStatus） */
  async confirmContributions(
    projectId: string,
    input: { contributionIds: readonly string[]; outcome: "confirmed" | "rejected"; actorKind: "user" | "test_fixture" },
  ): Promise<{ updated: number; unknown: string[] }> {
    const file = await this.loadContributions(projectId);
    if (file === null) throw new BusinessError("INVALID_REQUEST", "贡献台账不存在（先运行 thesis.contributions）");
    const ids = new Set(input.contributionIds);
    const unknown: string[] = [];
    let updated = 0;
    const items = file.items.map((item) => {
      if (!ids.has(item.id)) return item;
      updated += 1;
      return {
        ...item,
        status: input.outcome,
        ...(input.outcome === "confirmed" ? { confirmedAt: this.now().toISOString(), actorKind: input.actorKind } : {}),
      };
    });
    for (const id of ids) if (!file.items.some((item) => item.id === id)) unknown.push(id);
    await writeJsonAtomic(this.contributionsPath(projectId), {
      ...file,
      items,
      updatedAt: this.now().toISOString(),
    });
    return { updated, unknown };
  }

  // ---------- 主线 + 大纲 + 映射规划 ----------

  /**
   * 一次模型提案产出 storyline + 两级大纲 + 章节映射，确定性校验后落盘
   * outline.json / thesis.json / chapter-mapping.json / thesis-storyline.json。
   * 前置：plannerContext.writingBlockers 为空（范围/版本/未发表/冲突全部解决）。
   */
  async planStoryline(
    projectId: string,
    options: { feedback?: string; language?: "zh" | "en"; signal?: AbortSignal } = {},
  ): Promise<StorylinePlanResult> {
    const context = await this.researchInputs.plannerContext(projectId);
    if (context.writingBlockers.length > 0) {
      throw new BusinessError(
        "AUTHOR_DECISION_REQUIRED",
        `研究输入仍有未决阻断项，不能规划大纲：${context.writingBlockers.join("；")}`,
      );
    }
    if (context.inputs.included.length === 0) {
      throw new BusinessError("AUTHOR_DECISION_REQUIRED", "没有入选的研究输入，不能规划学位论文大纲");
    }
    const contributions = await this.loadContributions(projectId);
    const confirmed = (contributions?.items ?? []).filter((item) => item.status === "confirmed");
    if (confirmed.length === 0) {
      throw new BusinessError("AUTHOR_DECISION_REQUIRED", "没有任何已确认的研究贡献，不能规划学位论文大纲（先在 HITL 中确认贡献）");
    }

    const prompt = buildStorylinePrompt({ context, contributions: confirmed, feedback: options.feedback });
    const project = await this.projects.getRequired(projectId);
    let lastOutput = "";
    const validationErrors: string[] = [];
    let lastError: Error | undefined;
    for (let attempt = 0; attempt <= STORYLINE_REPAIR_MAX_ATTEMPTS; attempt += 1) {
      const task = await this.runtime.runAgent({
        agentId: this.agentId,
        task: attempt === 0 ? prompt : buildStorylineRepairPrompt(lastOutput, validationErrors),
        projectId,
        contextScope: "thesis/outline",
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
        metadata: { role: "writer", skill: "thesis-outline", ...(attempt > 0 ? { structuredRepairAttempt: attempt } : {}) },
      });
      if (task.status !== "completed") {
        throw new AgentRunFailedError(task.error ?? `大纲规划任务以 ${task.status} 状态结束`);
      }
      lastOutput = task.output ?? "";
      let parsed: Record<string, unknown>;
      try {
        parsed = extractJsonObject(lastOutput, "学位论文大纲规划");
      } catch (error) {
        validationErrors.push((error as Error).message);
        lastError = error as Error;
        continue;
      }
      const validated = validateAndBuildPlan({ raw: parsed, context, contributions: confirmed, projectTitle: project.title });
      if (validated.errors.length > 0) {
        validationErrors.push(...validated.errors);
        lastError = new BusinessError("STAGE_CONTRACT_VIOLATION", validated.errors.join("；"));
        continue;
      }
      // 落盘四个工件（mapping 重置为 proposed）
      await this.manuscript.saveOutline(projectId, validated.outline, { maxSections: THESIS_OUTLINE_MAX_SECTIONS });
      await this.thesisDocuments.saveModel(projectId, validated.thesisModel, validated.outline);
      const fingerprint = outlineFingerprintFromChapters(validated.chapters);
      await writeJsonAtomic(this.mappingPath(projectId), {
        schemaVersion: 1,
        projectId,
        chapters: validated.chapters,
        outlineFingerprint: fingerprint,
        status: "proposed",
        updatedAt: this.now().toISOString(),
      } satisfies ChapterMappingFile);
      await writeJsonAtomic(this.storylinePath(projectId), {
        schemaVersion: 1,
        projectId,
        storyline: validated.storyline,
        planFingerprint: thesisPlanFingerprint({
          contributionIds: confirmed.map((item) => item.id),
          includedInputIds: context.inputs.included.map((input) => input.inputId),
          preferredVersions: context.inputs.preferredVersionByWork,
        }),
        taskId: task.taskId,
        updatedAt: this.now().toISOString(),
      } satisfies ThesisStorylineFile);
      return {
        storyline: validated.storyline,
        chapters: validated.chapters,
        outline: validated.outline,
        mappingStatus: "proposed",
        repairAttempts: attempt,
        taskId: task.taskId,
      };
    }
    throw new AgentRunFailedError(
      `学位论文大纲规划未通过确定性校验（${STORYLINE_REPAIR_MAX_ATTEMPTS + 1} 次尝试）：${lastError?.message ?? validationErrors.join("；")}`,
    );
  }

  /** 大纲确认（HITL approve）：映射状态 → confirmed */
  async confirmMapping(projectId: string, actorKind: "user" | "test_fixture"): Promise<void> {
    const mapping = await this.loadMapping(projectId);
    if (mapping === null) throw new BusinessError("INVALID_REQUEST", "章节映射不存在（先运行 thesis.storyline）");
    await writeJsonAtomic(this.mappingPath(projectId), {
      ...mapping,
      status: "confirmed",
      confirmedAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
    });
    void actorKind;
  }

  /**
   * 缺材料章检测（确定性）：
   *   - method/experiment 章且拥有 owner 贡献，但映射 factIds ∪ owner 贡献的
   *     linkedFactIds 中没有任何可用事实（authorConfirmed 或 sourceVerified），
   *     且没有任何覆盖该章的 writing_pause 决定 → 缺材料。
   */
  async missingMaterialChapters(projectId: string): Promise<ThesisChapterPlan[]> {
    const mapping = await this.loadMapping(projectId);
    if (mapping === null || mapping.status !== "confirmed") return [];
    const context = await this.researchInputs.plannerContext(projectId);
    const contributions = await this.loadContributions(projectId);
    const byId = new Map((contributions?.items ?? []).map((item) => [item.id, item]));
    const usableFacts = [...context.facts.authorConfirmed, ...context.facts.sourceVerifiedUnconfirmed];
    const covered = await this.chaptersWithWritingDecisions(projectId);
    const missing: ThesisChapterPlan[] = [];
    for (const chapter of mapping.chapters) {
      if (chapter.responsibility !== "method" && chapter.responsibility !== "experiment") continue;
      if (chapter.ownsContributionIds.length === 0) continue;
      const linked = new Set<string>();
      for (const factId of chapter.factIds) linked.add(factId);
      for (const contributionId of chapter.ownsContributionIds) {
        for (const factId of byId.get(contributionId)?.linkedFactIds ?? []) linked.add(factId);
      }
      const hasUsableFact = usableFacts.some((fact) => linked.has(fact.factId));
      if (!hasUsableFact && !covered.has(chapter.chapterId)) {
        missing.push(chapter);
      }
    }
    return missing;
  }

  /** 已有 writing_pause 决定覆盖的章（subject=chapterId；决策任意——一旦作者已表态即不再拦） */
  async chaptersWithWritingDecisions(projectId: string): Promise<Set<string>> {
    const decisions: readonly AuthorDecision[] = await this.researchInputs.decisions.list(projectId);
    const subjects = new Set<string>();
    for (const decision of decisions) {
      if (decision.payload.type === "writing_pause" && typeof decision.payload.subject === "string") {
        subjects.add(decision.payload.subject);
      }
    }
    return subjects;
  }

  // ---------- 内部 ----------

  private async extractContributionsForInput(
    projectId: string,
    input: { inputId: string; title: string; inputType: string; version: { sourceId: string; contentHash: string }; publicationStatus?: { value: string } },
    fullText: string,
    existingIds: ReadonlySet<string>,
    options: { signal?: AbortSignal },
  ): Promise<{ items: ThesisContribution[]; anchored: number; taskId?: string }> {
    const projection = fullText.slice(0, CONTRIBUTION_DOC_BUDGET);
    const task = await this.runtime.runAgent({
      agentId: this.agentId,
      task: buildContributionsPrompt({ input, projection, truncated: fullText.length > CONTRIBUTION_DOC_BUDGET }),
      projectId,
      contextScope: "thesis/contributions",
      ...(options.signal !== undefined ? { signal: options.signal } : {}),
      metadata: { role: "researcher", skill: "thesis-contributions" },
    });
    if (task.status !== "completed") {
      throw new AgentRunFailedError(task.error ?? `贡献提取任务以 ${task.status} 状态结束`);
    }
    const raw = extractJsonObject(task.output ?? "", "研究贡献提取");
    const proposals = readContributionProposals(raw);
    const facts = await this.researchInputs.facts.list(projectId, { researchInputId: input.inputId });
    const items: ThesisContribution[] = [];
    let anchored = 0;
    for (const proposal of proposals) {
      const id = thesisContributionId(input.inputId, proposal.kind, proposal.statement);
      if (existingIds.has(id)) continue; // 幂等重放：保留既有状态（含作者确认）
      const anchorStatus = quoteMatches(proposal.quote, fullText)
        ? "verbatim"
        : proposal.quote !== undefined
          ? "not_found"
          : "not_provided";
      if (anchorStatus === "verbatim") anchored += 1;
      const linkedFactIds = linkFacts(proposal, facts).slice(0, 10);
      items.push({
        id,
        researchInputId: input.inputId,
        contentHash: input.version.contentHash,
        kind: proposal.kind,
        statement: proposal.statement,
        ...(proposal.quote !== undefined ? { quote: proposal.quote } : {}),
        anchorStatus,
        linkedFactIds,
        status: "proposed",
        extraction: { method: "model_proposal", taskId: task.taskId, extractedAt: this.now().toISOString() },
      });
    }
    return { items, anchored, taskId: task.taskId };
  }
}

// ---------- 纯函数：prompt / 解析 / 校验 ----------

function buildContributionsPrompt(input: {
  input: { inputId: string; title: string; inputType: string; publicationStatus?: { value: string } };
  projection: string;
  truncated: boolean;
}): string {
  return [
    "你是科研助理。请从下面这份研究材料的文本中提取「研究贡献」提案，供作者确认后用于学位论文规划。",
    "",
    `材料标题：${input.input.title}`,
    `材料类型：${input.input.inputType}`,
    input.input.publicationStatus !== undefined ? `发表状态：${input.input.publicationStatus.value}` : "",
    input.truncated ? "（注意：文本为前 12000 字符投影，提取以可见内容为准）" : "",
    "",
    "提取要求（每条贡献）：",
    `- kind ∈ [${CONTRIBUTION_KINDS.join(", ")}]；`,
    "- statement：一句话中文陈述该贡献（研究问题 / 方法 / 实验结果 / 数据集 / 结论 / 局限）；",
    "- quote：从材料原文**逐字**摘引 ≤400 字符的支撑片段（必须与原文完全一致，空白不敏感）——锚定核验是确定性的，改写会导致 not_found；",
    "- 每类 1–4 条，总数不超过 20 条；只提取材料真实陈述的内容，不得推断或补充。",
    "",
    "输出严格 JSON（无多余文字）：",
    '{"contributions": [{"kind": "method", "statement": "…", "quote": "…"}]}',
    "",
    "材料文本：",
    input.projection,
  ]
    .filter((line) => line !== "")
    .join("\n");
}

interface ContributionProposal {
  kind: ThesisContributionKind;
  statement: string;
  quote?: string;
}

function readContributionProposals(raw: Record<string, unknown>): ContributionProposal[] {
  const list = raw["contributions"];
  if (!Array.isArray(list)) throw new BusinessError("STAGE_CONTRACT_VIOLATION", "贡献提取输出缺少 contributions 数组");
  const proposals: ContributionProposal[] = [];
  for (const entry of list.slice(0, MAX_CONTRIBUTIONS_PER_INPUT)) {
    if (typeof entry !== "object" || entry === null) continue;
    const record = entry as Record<string, unknown>;
    const kind = typeof record["kind"] === "string" ? record["kind"] : "";
    const statement = typeof record["statement"] === "string" ? record["statement"].trim() : "";
    const quote = typeof record["quote"] === "string" ? record["quote"] : undefined;
    if (!CONTRIBUTION_KINDS.includes(kind as ThesisContributionKind)) continue;
    if (statement === "" || statement.length > 500) continue;
    proposals.push({ kind: kind as ThesisContributionKind, statement, ...(quote !== undefined ? { quote } : {}) });
  }
  return proposals;
}

/** quote 逐字命中（空白不敏感；与 M14.1b checkQuoteAgainstDocumentText 同口径） */
function quoteMatches(quote: string | undefined, documentText: string): boolean {
  if (quote === undefined || quote === "") return false;
  return normalizeWs(documentText).includes(normalizeWs(quote));
}

function normalizeWs(text: string): string {
  return text.replace(/\s+/g, "");
}

function linkFacts(
  proposal: ContributionProposal,
  facts: ReadonlyArray<{ factId: string; surface: string; value: { raw: string } }>,
): string[] {
  const hay = normalizeWs(`${proposal.statement}${proposal.quote ?? ""}`);
  return facts.filter((fact) => {
    const raw = fact.value.raw.trim();
    if (raw === "") return false;
    return hay.includes(normalizeWs(raw)) || hay.includes(normalizeWs(fact.surface));
  }).map((fact) => fact.factId);
}

function buildStorylinePrompt(input: {
  context: {
    inputs: { included: Array<{ inputId: string; title: string; inputType: string; workId: string; contentHash: string }> };
    facts: {
      authorConfirmed: Array<{ factId: string; kind: string; surface: string }>;
      sourceVerifiedUnconfirmed: Array<{ factId: string; kind: string; surface: string }>;
    };
  };
  contributions: readonly ThesisContribution[];
  feedback?: string;
}): string {
  const inputLines = input.context.inputs.included.map(
    (item) => `- ${item.inputId}「${item.title}」（${item.inputType}）`,
  );
  const contributionLines = input.contributions.map(
    (item) => `- ${item.id} [${item.kind}] ${item.statement}${item.anchorStatus === "verbatim" ? "" : "（锚定：未逐字命中）"}`,
  );
  const factLines = input.context.facts.authorConfirmed
    .slice(0, 40)
    .map((fact) => `- ${fact.factId} [${fact.kind}] ${fact.surface}`);
  return [
    "你是学位论文规划师。基于作者已确认的研究贡献，规划硕士学位论文的研究主线、两级大纲与章节—来源映射。",
    "",
    "入选研究输入：",
    ...inputLines,
    "",
    "已确认研究贡献（id 用于引用）：",
    ...contributionLines,
    "",
    "已确认事实（数值可直接写入正文；未列出的数值不得写入）：",
    ...(factLines.length > 0 ? factLines : ["- （暂无已确认事实）"]),
    "",
    "规划要求：",
    "- 先判定研究主线结构 structure ∈ [progressive(递进), parallel(并列), framework(统一框架), fragmented(缺乏共同主线)]；缺乏合理共同主线时必须选 fragmented 并在 scopeConcerns 说明，不得硬编统一创新点；",
    "- 章数 3–12；每章 1–6 节；总节数 3–60；必须包含绪论（introduction）与总结（conclusion）；",
    "- 每章声明 responsibility ∈ [introduction, background, literature_review, method, experiment, discussion, conclusion]；",
    "- 章节文件名 file 只能是小写字母/数字/连字符的扁平文件名（如 intro-background.tex），全论文唯一，不带目录；",
    "- method/experiment 章必须通过 ownsContributionIds 声明拥有的贡献；sourceInputIds 声明改写来源输入（只能是上方入选输入的 inputId）；factIds 引用该章可用的已确认事实所属输入的任意已提取事实（不得含未决冲突事实）；",
    "- 单节章的章标题必须与该节标题完全一致（装配约束）；建议核心章用多节；",
    "- contributionsOrder 必须覆盖全部已确认贡献 id（决定叙事顺序）；relations 描述贡献之间关系（type ∈ extends/supersedes/same_as/complements/unrelated）；",
    "- factIds 引用上方「已确认事实」的 F 开头 id（method/experiment 章应引用其展开贡献对应的数值事实；无可用事实时留空，由作者决定后续处理）；",
    "- 文献综述/绪论章节用 literatureRefs 声明需要外部文献支撑的主题（后续定向补证）。",
    ...(input.feedback !== undefined ? ["", `作者修改意见（必须落实）：${input.feedback}`] : []),
    "",
    "输出严格 JSON：",
    `{"storyline": {"narrative": "…", "structure": "progressive", "scopeConcerns": ["…"], "relations": [{"type": "extends", "fromContributionId": "c-…", "toContributionId": "c-…"}], "contributionsOrder": ["c-…"]}, "chapters": [{"chapterId": "ch01", "titleZh": "绪论", "responsibility": "introduction", "goal": "…", "sections": [{"file": "intro-overview.tex", "title": "研究背景与意义", "keyPoints": ["…"], "targetLengthWords": 1200, "literatureRefs": ["…"]}], "ownsContributionIds": [], "referencesContributionIds": [], "sourceInputIds": [], "factIds": []}]}`,
  ].join("\n");
}

function buildStorylineRepairPrompt(lastOutput: string, errors: readonly string[]): string {
  return [
    "你上一轮的学位论文大纲规划未通过确定性校验。请修正后重新输出完整 JSON。",
    "",
    "校验错误（全部修复）：",
    ...errors.map((error, index) => `${index + 1}. ${error}`),
    "",
    "上一轮输出：",
    lastOutput,
    "",
    "重新输出严格 JSON（结构同前）。不要解释。",
  ].join("\n");
}

interface ValidatedPlan {
  storyline: ThesisStoryline;
  chapters: ThesisChapterPlan[];
  outline: Outline;
  thesisModel: { schemaVersion: 1; templateId: "generic-ctexbook"; titleZh: string; chapters: Array<{ chapterId: string; titleZh: string; sections: string[] }> };
  errors: string[];
}

function validateAndBuildPlan(input: {
  raw: Record<string, unknown>;
  context: {
    inputs: { included: Array<{ inputId: string }>; preferredVersionByWork: Record<string, string> };
    facts: {
      authorConfirmed: Array<{ factId: string }>;
      sourceVerifiedUnconfirmed: Array<{ factId: string }>;
      extractedOnly: Array<{ factId: string }>;
      conflicted: Array<{ factId: string }>;
    };
  };
  contributions: readonly ThesisContribution[];
  projectTitle: string;
}): ValidatedPlan {
  const errors: string[] = [];
  const confirmedIds = new Set(input.contributions.map((item) => item.id));
  const includedIds = new Set(input.context.inputs.included.map((item) => item.inputId));
  const nonConflictedFactIds = new Set(
    [
      ...input.context.facts.authorConfirmed,
      ...input.context.facts.sourceVerifiedUnconfirmed,
      ...input.context.facts.extractedOnly,
    ].map((fact) => fact.factId),
  );

  // storyline
  const rawStoryline = input.raw["storyline"];
  const storyline: ThesisStoryline | null =
    typeof rawStoryline === "object" && rawStoryline !== null
      ? readStoryline(rawStoryline as Record<string, unknown>, confirmedIds, errors)
      : null;
  if (storyline === null) errors.push("缺少 storyline 对象");

  // chapters
  const rawChapters = input.raw["chapters"];
  if (!Array.isArray(rawChapters)) {
    errors.push("缺少 chapters 数组");
  } else if (rawChapters.length < MIN_CHAPTERS || rawChapters.length > MAX_CHAPTERS) {
    errors.push(`章数须在 ${MIN_CHAPTERS}–${MAX_CHAPTERS} 之间（当前 ${rawChapters.length}）`);
  }

  const chapters: ThesisChapterPlan[] = [];
  const seenChapterIds = new Set<string>();
  const seenFiles = new Map<string, string>();
  const sections: OutlineSection[] = [];
  const sectionTitleByFile = new Map<string, string>();
  let hasIntroduction = false;
  let hasConclusion = false;

  if (Array.isArray(rawChapters)) {
    for (const entry of rawChapters) {
      if (typeof entry !== "object" || entry === null) {
        errors.push("chapters 含非对象条目");
        continue;
      }
      const record = entry as Record<string, unknown>;
      const chapterId = typeof record["chapterId"] === "string" ? record["chapterId"].trim() : "";
      const titleZh = typeof record["titleZh"] === "string" ? record["titleZh"].trim() : "";
      const responsibility = typeof record["responsibility"] === "string" ? record["responsibility"] : "";
      const goal = typeof record["goal"] === "string" ? record["goal"].trim() : "";
      if (chapterId === "" || !/^[a-z0-9][a-z0-9-]{0,40}$/.test(chapterId)) {
        errors.push(`chapterId 非法：${chapterId || "(空)"}`);
        continue;
      }
      if (seenChapterIds.has(chapterId)) {
        errors.push(`chapterId 重复：${chapterId}`);
        continue;
      }
      seenChapterIds.add(chapterId);
      if (titleZh === "") errors.push(`章 ${chapterId} 标题为空`);
      if (!CHAPTER_RESPONSIBILITIES.includes(responsibility as ThesisChapterResponsibility)) {
        errors.push(`章 ${chapterId} responsibility 非法：${responsibility}`);
      } else {
        if (responsibility === "introduction") hasIntroduction = true;
        if (responsibility === "conclusion") hasConclusion = true;
      }
      if (goal === "") errors.push(`章 ${chapterId} goal 为空`);

      const rawSections = record["sections"];
      const chapterSectionFiles: string[] = [];
      if (!Array.isArray(rawSections) || rawSections.length === 0) {
        errors.push(`章 ${chapterId} 没有节`);
      } else {
        for (const sectionEntry of rawSections) {
          if (typeof sectionEntry !== "object" || sectionEntry === null) {
            errors.push(`章 ${chapterId} 的 sections 含非对象条目`);
            continue;
          }
          const sectionRecord = sectionEntry as Record<string, unknown>;
          const file = typeof sectionRecord["file"] === "string" ? sectionRecord["file"].trim() : "";
          const title = typeof sectionRecord["title"] === "string" ? sectionRecord["title"].trim() : "";
          if (file === "" || !SECTION_FILE_PATTERN.test(file)) {
            errors.push(`章 ${chapterId} 的节文件名非法（须扁平小写）：${file || "(空)"}`);
            continue;
          }
          if (seenFiles.has(file)) {
            errors.push(`节文件跨章重复：${file}（${seenFiles.get(file)} 与 ${chapterId}）`);
            continue;
          }
          seenFiles.set(file, chapterId);
          if (title === "") {
            errors.push(`节 ${file} 标题为空`);
            continue;
          }
          const keyPoints = Array.isArray(sectionRecord["keyPoints"])
            ? sectionRecord["keyPoints"].filter((item): item is string => typeof item === "string").slice(0, 10)
            : undefined;
          const literatureRefs = Array.isArray(sectionRecord["literatureRefs"])
            ? sectionRecord["literatureRefs"].filter((item): item is string => typeof item === "string").slice(0, 10)
            : undefined;
          const rawTarget = typeof sectionRecord["targetLengthWords"] === "number" ? sectionRecord["targetLengthWords"] : undefined;
          const targetLengthWords = rawTarget === undefined ? undefined : Math.min(5000, Math.max(200, Math.round(rawTarget)));
          const id = file.replace(/\.tex$/, "");
          sections.push({
            id,
            file,
            title,
            ...(targetLengthWords !== undefined ? { targetLengthWords } : {}),
            ...(keyPoints !== undefined && keyPoints.length > 0 ? { keyPoints } : {}),
            ...(literatureRefs !== undefined && literatureRefs.length > 0 ? { literatureRefs } : {}),
          });
          sectionTitleByFile.set(file, title);
          chapterSectionFiles.push(file);
        }
      }

      // 单节章标题一致性（promoted 装配约束）
      if (chapterSectionFiles.length === 1) {
        const file = chapterSectionFiles[0]!;
        const sectionTitle = sectionTitleByFile.get(file);
        if (sectionTitle !== undefined && normalizeTitle(sectionTitle) !== normalizeTitle(titleZh)) {
          errors.push(`单节章 ${chapterId}（${titleZh}）的章标题须与节 ${file} 的标题（${sectionTitle}）一致`);
        }
      }

      const owns = readIdArray(record["ownsContributionIds"]);
      const references = readIdArray(record["referencesContributionIds"]);
      const sources = readIdArray(record["sourceInputIds"]);
      const factIds = readIdArray(record["factIds"]);
      for (const id of owns) {
        if (!confirmedIds.has(id)) errors.push(`章 ${chapterId} ownsContributionIds 引用了未确认贡献：${id}`);
      }
      for (const id of sources) {
        if (!includedIds.has(id)) errors.push(`章 ${chapterId} sourceInputIds 引用了非入选输入：${id}`);
      }
      for (const id of factIds) {
        if (!nonConflictedFactIds.has(id)) errors.push(`章 ${chapterId} factIds 引用了不存在或未决冲突的事实：${id}`);
      }
      chapters.push({
        chapterId,
        titleZh,
        responsibility: responsibility as ThesisChapterResponsibility,
        goal,
        sectionFiles: chapterSectionFiles,
        ownsContributionIds: owns,
        referencesContributionIds: references,
        sourceInputIds: sources,
        factIds,
      });
    }
  }

  if (storyline !== null && chapters.length > 0) {
    if (!hasIntroduction) errors.push("大纲必须包含 introduction 章绪论");
    if (!hasConclusion) errors.push("大纲必须包含 conclusion 章总结");
  }
  if (sections.length < THESIS_OUTLINE_MIN_SECTIONS || sections.length > THESIS_OUTLINE_MAX_SECTIONS) {
    errors.push(`总节数须在 ${THESIS_OUTLINE_MIN_SECTIONS}–${THESIS_OUTLINE_MAX_SECTIONS} 之间（当前 ${sections.length}）`);
  }
  // method/experiment 章必须拥有贡献（否则核心章无来源）；每个已确认贡献恰被一章拥有
  const ownershipCounts = new Map<string, number>();
  for (const chapter of chapters) {
    if ((chapter.responsibility === "method" || chapter.responsibility === "experiment") && chapter.ownsContributionIds.length === 0) {
      errors.push(`章 ${chapter.chapterId}（${chapter.responsibility}）必须声明 ownsContributionIds`);
    }
    for (const id of chapter.ownsContributionIds) {
      ownershipCounts.set(id, (ownershipCounts.get(id) ?? 0) + 1);
    }
  }
  for (const [id, count] of ownershipCounts) {
    if (count > 1) errors.push(`贡献 ${id} 被 ${count} 个章同时拥有（成果级归属必须唯一）`);
  }
  for (const id of confirmedIds) {
    if (!ownershipCounts.has(id)) errors.push(`已确认贡献 ${id} 未被任何章拥有（完整主线映射要求每个成果恰有一个 owner 章）`);
  }

  const outline: Outline = { title: input.projectTitle, sections };
  const thesisModel = {
    schemaVersion: 1 as const,
    templateId: "generic-ctexbook" as const,
    titleZh: input.projectTitle,
    chapters: chapters.map((chapter) => ({ chapterId: chapter.chapterId, titleZh: chapter.titleZh, sections: chapter.sectionFiles })),
  };
  return { storyline: storyline ?? ({} as ThesisStoryline), chapters, outline, thesisModel, errors };
}

function readStoryline(raw: Record<string, unknown>, confirmedIds: ReadonlySet<string>, errors: string[]): ThesisStoryline | null {
  const narrative = typeof raw["narrative"] === "string" ? raw["narrative"].trim() : "";
  const structure = typeof raw["structure"] === "string" ? raw["structure"] : "";
  if (narrative === "") errors.push("storyline.narrative 为空");
  if (!["progressive", "parallel", "framework", "fragmented"].includes(structure)) {
    errors.push(`storyline.structure 非法：${structure}`);
    return null;
  }
  const scopeConcerns = Array.isArray(raw["scopeConcerns"])
    ? raw["scopeConcerns"].filter((item): item is string => typeof item === "string")
    : undefined;
  if (structure === "fragmented" && (scopeConcerns === undefined || scopeConcerns.length === 0)) {
    errors.push("structure=fragmented 时必须给出 scopeConcerns（不硬编统一创新点）");
  }
  const relations: StorylineRelationLite[] = [];
  if (Array.isArray(raw["relations"])) {
    for (const entry of raw["relations"]) {
      if (typeof entry !== "object" || entry === null) continue;
      const record = entry as Record<string, unknown>;
      const type = typeof record["type"] === "string" ? record["type"] : "";
      const from = typeof record["fromContributionId"] === "string" ? record["fromContributionId"] : "";
      const to = typeof record["toContributionId"] === "string" ? record["toContributionId"] : "";
      if (!CONTRIBUTION_RELATION_TYPES.includes(type as never)) {
        errors.push(`relation.type 非法：${type}`);
        continue;
      }
      if (!confirmedIds.has(from) || !confirmedIds.has(to)) {
        errors.push(`relation 引用了未确认贡献：${from} → ${to}`);
        continue;
      }
      relations.push({ type: type as never, fromContributionId: from, toContributionId: to });
    }
  }
  const contributionsOrder = Array.isArray(raw["contributionsOrder"])
    ? raw["contributionsOrder"].filter((item): item is string => typeof item === "string")
    : [];
  for (const id of contributionsOrder) {
    if (!confirmedIds.has(id)) errors.push(`contributionsOrder 引用了未确认贡献：${id}`);
  }
  for (const id of confirmedIds) {
    if (!contributionsOrder.includes(id)) errors.push(`contributionsOrder 缺少已确认贡献：${id}`);
  }
  return {
    narrative,
    structure: structure as ThesisStoryline["structure"],
    ...(scopeConcerns !== undefined && scopeConcerns.length > 0 ? { scopeConcerns } : {}),
    relations,
    contributionsOrder,
  };
}

interface StorylineRelationLite {
  type: ThesisStoryline["relations"][number]["type"];
  fromContributionId: string;
  toContributionId: string;
}

function readIdArray(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value.filter((item): item is string => typeof item === "string");
}

function normalizeTitle(title: string): string {
  return title.replace(/\s+/g, "");
}

function emptyContributions(projectId: string, now: string): ThesisContributionFile {
  return { schemaVersion: 1, projectId, items: [], extraction: { perInput: {} }, updatedAt: now };
}

async function readJsonOrNull<T>(path: string): Promise<T | null> {
  try {
    const raw = await readFile(path, "utf8");
    return JSON.parse(raw) as T;
  } catch {
    return null;
  }
}
