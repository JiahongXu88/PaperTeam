/**
 * MatrixService：Literature → Survey Matrix 的构建与修正编排（M11.1.1）。
 *
 * 链路（复用既有组件，零新 Runtime 角色）：
 *   Source（SourceStore）→ interpretationDepth 判定（available/partial=fulltext，
 *   其余=abstract_only）→ fulltext 走 RetrievalService 单篇检索（sourceIds 过滤）
 *   + contextPacker 打包（CHUNK 标记进 prompt）→ Pi runtime 按
 *   contextScope="research/survey-matrix" 映射 researcher 角色（roleConfig 的
 *   research/* 前缀规则，无新增角色 / Agent）→ 结构化 JSON 解析与确定性校验
 *   （matrixTypes）→ chunk anchor 经 ChunkAccess fail-closed 核验 → dedup
 *   （sourceId 唯一键；entryId=M-<sourceId> 纯函数）→ research/survey.json
 *   单一写入口（SurveyMatrixArtifactStore）。
 *
 * 批量纪律：按 paper 独立执行——单篇失败是数据不是异常（failed 落账，不回滚、
 * 不污染其他条目；force 重算失败时旧条目保留）；已有 entry 不重复构建
 * （skipped_existing）；下次 build 自动重试失败篇目。构建串行执行（逐篇
 * LLM 调用本身昂贵，Runtime 侧另有序列化；不引入第二套并发编排）。
 *
 * 语义边界：本服务不写 EvidenceStore、不产生 verified evidence、不判定
 * groundingLevel（M11.1.2）；citationKey 不落盘（使用点经 bibliography
 * 确定性管道解析）。
 */

import { AgentRunFailedError, BusinessError, NotFoundError } from "../errors.js";
import type { EvidenceStore } from "../evidence/EvidenceStore.js";
import type { ChunkAccess } from "../evidence/chunkAccess.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { normalizeManuscriptLanguage } from "../project/language.js";
import { packRetrievalContext, DEFAULT_PACK_BUDGET_TOKENS } from "../retrieval/contextPacker.js";
import type { RetrievalService } from "../retrieval/RetrievalService.js";
import type { AgentRuntime } from "../runtime/types.js";
import type { SourceItem, SourceStore } from "../sources/SourceStore.js";
import { extractJsonObject } from "../agents/outputParsing.js";
import {
  DEFAULT_SURVEY_TAXONOMY,
  KEY_FINDINGS_MAX,
  SURVEY_ANCHORABLE_FIELDS,
  SURVEY_FIELD_LIMITS,
  UNCLASSIFIED_FAMILY,
  matrixEntryId,
  normalizeComparedMethods,
  normalizeTaxonomy,
  parseMatrixEntryOutput,
  taxonomyFamilyOf,
  type InterpretationDepth,
  type SurveyFieldAnchor,
  type SurveyMatrixArtifact,
  type SurveyMatrixEntry,
  type SurveyMatrixIssue,
  type SurveyTaxonomy,
} from "./matrixTypes.js";
import { SurveyMatrixArtifactStore } from "./surveyArtifacts.js";

/** 单篇检索注入 prompt 的段落预算（token 估算；sourceScoped 打包） */
const MATRIX_PASSAGE_BUDGET_TOKENS = DEFAULT_PACK_BUDGET_TOKENS;
/** 单篇检索 topK（打包预算内再筛选） */
const MATRIX_PASSAGE_TOP_K = 8;

export interface SurveyMatrixBuildItemResult {
  sourceId: string;
  outcome: "built" | "skipped_existing" | "failed";
  entry?: SurveyMatrixEntry;
  /** failed 时的短摘要（不含模型原始输出） */
  error?: string;
}

export interface SurveyMatrixBuildResult {
  summary: {
    total: number;
    built: number;
    skippedExisting: number;
    failed: number;
    /** 本次构建清理的孤儿条目（对应 Source 已从文献库删除） */
    removedOrphans: number;
  };
  results: SurveyMatrixBuildItemResult[];
  matrix: SurveyMatrixArtifact;
}

export interface SurveyMatrixBuildInput {
  /** 只构建指定文献（须存在于文献库且非 reference / rejected） */
  sourceIds?: string[];
  /** 提供则覆盖 artifact taxonomy（既有条目标签失效 → unclassified + issue） */
  taxonomy?: SurveyTaxonomy;
  /** 重算已有条目（默认跳过已有 entry 的 source） */
  force?: boolean;
  /**
   * 逐篇进度回调（M11.1.4：workflow stage 空闲超时看门狗需要「还在动」的
   * 信号——逐篇 LLM 调用可能远超 stage 整体超时预算；纯观测，异常不回传）
   */
  onProgress?: (info: { done: number; total: number; sourceId: string }) => void;
}

/** PUT /survey/matrix/:entryId 的可修改字段（全部可选；未提供字段原样保留） */
export interface SurveyEntryPatch {
  researchProblem?: string;
  methodFamily?: string;
  subFamily?: string;
  mainIdea?: string;
  keyTechnique?: string;
  assumption?: string;
  datasetContext?: string;
  strength?: string;
  limitation?: string;
  comparedMethods?: string[];
  keyFindings?: string[];
  /** anchors 整体替换（严格校验：非法即 400，不静默剔除） */
  anchors?: SurveyFieldAnchor[];
  status?: "draft" | "confirmed";
}

export interface MatrixServiceOptions {
  projects: ProjectStore;
  sources: SourceStore;
  retrieval: RetrievalService;
  chunkAccess: ChunkAccess;
  runtime: AgentRuntime;
  researcherAgentId: string;
  /** HITL anchors.evidenceIds 存在性核验用（缺省跳过该核验） */
  evidence?: EvidenceStore;
  /** 逐 run 执行超时覆盖（毫秒）；缺省沿用 Runtime 默认 */
  runTimeoutMs?: number;
  now?: () => Date;
  log?: (message: string) => void;
}

export class MatrixService {
  private readonly projects: ProjectStore;
  private readonly sources: SourceStore;
  private readonly retrieval: RetrievalService;
  private readonly chunkAccess: ChunkAccess;
  private readonly runtime: AgentRuntime;
  private readonly researcherAgentId: string;
  private readonly evidence: EvidenceStore | undefined;
  private readonly store: SurveyMatrixArtifactStore;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;
  private readonly timeoutOverride: { timeoutMs: number } | Record<string, never>;

  constructor(options: MatrixServiceOptions) {
    this.projects = options.projects;
    this.sources = options.sources;
    this.retrieval = options.retrieval;
    this.chunkAccess = options.chunkAccess;
    this.runtime = options.runtime;
    this.researcherAgentId = options.researcherAgentId;
    this.evidence = options.evidence;
    this.store = new SurveyMatrixArtifactStore(options.projects);
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
    this.timeoutOverride = options.runTimeoutMs !== undefined ? { timeoutMs: options.runTimeoutMs } : {};
  }

  /** 读矩阵（未构建 → null；损坏 → SURVEY_MATRIX_CORRUPTED fail-closed） */
  async getMatrix(projectId: string): Promise<SurveyMatrixArtifact | null> {
    await this.projects.getRequired(projectId);
    return this.store.read(projectId);
  }

  /**
   * 构建 / 增量构建 Survey Matrix。
   * 单篇失败不污染其他条目；已有 entry 默认跳过；孤儿条目（source 已删除）
   * 清理；taxonomy 覆盖时既有条目按新表重校验（失效标签 → unclassified）。
   */
  async buildMatrix(
    projectId: string,
    input: SurveyMatrixBuildInput = {},
  ): Promise<SurveyMatrixBuildResult> {
    const project = await this.projects.getRequired(projectId);
    const language = normalizeManuscriptLanguage(project.language);
    const existing = await this.store.read(projectId);
    const taxonomy =
      input.taxonomy !== undefined
        ? normalizeTaxonomy(input.taxonomy)
        : (existing?.taxonomy ?? DEFAULT_SURVEY_TAXONOMY);

    const items = await this.sources.list(projectId);
    const eligible = items.filter(
      (item) => item.sourceRole !== "reference" && item.status !== "rejected",
    );

    // 目标集：显式 sourceIds（逐条校验存在与资格）或缺省全部 eligible
    let targets: SourceItem[];
    if (input.sourceIds !== undefined) {
      if (input.sourceIds.length === 0) {
        throw new BusinessError("INVALID_REQUEST", "sourceIds 必须是非空数组（不指定则构建全部文献）");
      }
      const byId = new Map(items.map((item) => [item.sourceId, item]));
      const missing: string[] = [];
      const ineligible: string[] = [];
      const unique = [...new Set(input.sourceIds)];
      for (const sourceId of unique) {
        const item = byId.get(sourceId);
        if (item === undefined) {
          missing.push(sourceId);
        } else if (item.sourceRole === "reference" || item.status === "rejected") {
          ineligible.push(sourceId);
        }
      }
      const problems = [
        ...(missing.length > 0 ? [`文献不存在：${missing.join("、")}`] : []),
        ...(ineligible.length > 0
          ? [`文献不参与矩阵构建（reference 范文 / 已否决）：${ineligible.join("、")}`]
          : []),
      ];
      if (problems.length > 0) {
        throw new BusinessError("INVALID_REQUEST", problems.join("；"));
      }
      targets = unique.map((sourceId) => byId.get(sourceId)!);
    } else {
      targets = eligible;
    }

    const entries = new Map<string, SurveyMatrixEntry>(
      (existing?.entries ?? []).map((entry) => [entry.sourceId, entry]),
    );

    // taxonomy 覆盖：既有条目按新表重校验（不静默丢弃，落 issue 供 HITL）
    const taxonomyChanged =
      existing !== null && canonicalTaxonomy(existing.taxonomy) !== canonicalTaxonomy(taxonomy);
    if (taxonomyChanged) {
      for (const entry of entries.values()) {
        reclassifyEntry(entry, taxonomy, this.now().toISOString());
      }
    }

    // 孤儿清理：对应 Source 已不在文献库（含被删除）的条目移除
    const knownIds = new Set(items.map((item) => item.sourceId));
    let removedOrphans = 0;
    for (const sourceId of [...entries.keys()]) {
      if (!knownIds.has(sourceId)) {
        entries.delete(sourceId);
        removedOrphans += 1;
      }
    }

    const results: SurveyMatrixBuildItemResult[] = [];
    let built = 0;
    let failed = 0;
    let skippedExisting = 0;
    for (const [index, item] of targets.entries()) {
      input.onProgress?.({ done: index, total: targets.length, sourceId: item.sourceId });
      const prior = entries.get(item.sourceId);
      if (prior !== undefined && input.force !== true) {
        skippedExisting += 1;
        results.push({ sourceId: item.sourceId, outcome: "skipped_existing", entry: prior });
        continue;
      }
      try {
        const entry = await this.extractEntry(projectId, item, taxonomy, language);
        entries.set(item.sourceId, entry);
        built += 1;
        results.push({ sourceId: item.sourceId, outcome: "built", entry });
      } catch (error) {
        // 单篇失败：数据不是异常——已有条目保留（force 重算失败不清旧值），其余篇目继续
        failed += 1;
        results.push({
          sourceId: item.sourceId,
          outcome: "failed",
          error: errorText(error),
        });
        this.log(
          `[survey] projectId=${projectId} ${item.sourceId} 矩阵条目构建失败：${errorText(error)}`,
        );
      }
    }

    const changed = existing === null || taxonomyChanged || built > 0 || removedOrphans > 0;
    let matrix: SurveyMatrixArtifact;
    if (changed || existing === null) {
      matrix = {
        schemaVersion: 1,
        updatedAt: this.now().toISOString(),
        taxonomy,
        entries: [...entries.values()].sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
      };
      await this.store.write(projectId, matrix);
    } else {
      matrix = existing;
    }

    this.log(
      `[survey] projectId=${projectId} 矩阵构建：built=${built} skipped=${skippedExisting} failed=${failed} orphans=${removedOrphans} entries=${matrix.entries.length}`,
    );
    return {
      summary: {
        total: results.length,
        built,
        skippedExisting,
        failed,
        removedOrphans,
      },
      results,
      matrix,
    };
  }

  /**
   * HITL 修正单个条目（PUT /survey/matrix/:entryId）。
   * 校验严格 fail-closed（非法 taxonomy 标签 / 超长字段 / 无效 anchor → 400，
   * 不静默截断或剔除——与构建路径对模型输出的宽容归一不同，人的输入应得到
   * 明确反馈）。已确认条目被修改内容字段时回退 draft（重新走确认）。
   */
  async updateEntry(
    projectId: string,
    entryId: string,
    patch: SurveyEntryPatch,
  ): Promise<SurveyMatrixEntry> {
    await this.projects.getRequired(projectId);
    const artifact = await this.store.read(projectId);
    if (artifact === null) {
      throw new BusinessError(
        "NOT_FOUND",
        "项目还没有 Survey Matrix（research/survey.json 不存在），请先执行构建",
      );
    }
    const index = artifact.entries.findIndex((entry) => entry.entryId === entryId);
    if (index === -1) {
      throw new NotFoundError("Survey Matrix 条目", entryId);
    }
    const current = artifact.entries[index]!;
    if (entryId !== matrixEntryId(current.sourceId)) {
      throw new BusinessError("INVALID_REQUEST", `entryId 与条目 sourceId 不一致：${entryId}`);
    }
    const updated = this.applyEntryPatch(artifact.taxonomy, current, patch);
    if (patch.anchors !== undefined) {
      // anchors 严格核验（异步读盘部分）：field 合法 + chunk 存在且属于本
      // source + evidenceIds 存在且指向本 source——任一非法直接 400
      updated.anchors = await this.validatePatchAnchors(projectId, current.sourceId, patch.anchors);
    }
    updated.updatedAt = this.now().toISOString();
    const entries = [...artifact.entries];
    entries[index] = updated;
    await this.store.write(projectId, {
      ...artifact,
      updatedAt: updated.updatedAt,
      entries,
    });
    return updated;
  }

  // ---- 内部 ----

  private applyEntryPatch(
    taxonomy: SurveyTaxonomy,
    current: SurveyMatrixEntry,
    patch: SurveyEntryPatch,
  ): SurveyMatrixEntry {
    const textFields = [
      "researchProblem",
      "mainIdea",
      "keyTechnique",
      "assumption",
      "datasetContext",
      "strength",
      "limitation",
    ] as const;
    const next: SurveyMatrixEntry = { ...current };
    let contentPatched = false;

    for (const field of textFields) {
      const value = patch[field];
      if (value === undefined) {
        continue;
      }
      const trimmed = value.trim();
      if (trimmed === "") {
        delete next[field];
        contentPatched = true;
        continue;
      }
      if (trimmed.length > SURVEY_FIELD_LIMITS[field]) {
        throw new BusinessError(
          "INVALID_REQUEST",
          `字段 ${field} 长度不能超过 ${SURVEY_FIELD_LIMITS[field]} 字符（当前 ${trimmed.length}）`,
        );
      }
      next[field] = trimmed;
      contentPatched = true;
    }

    if (patch.methodFamily !== undefined) {
      const label = patch.methodFamily.trim();
      if (label !== UNCLASSIFIED_FAMILY && taxonomyFamilyOf(taxonomy, label) === undefined) {
        throw new BusinessError(
          "INVALID_REQUEST",
          `methodFamily「${label}」不在 taxonomy 内（合法标签：${taxonomy.families.map((family) => family.label).join("、")}、${UNCLASSIFIED_FAMILY}）；扩展词表请在构建时提供 taxonomy`,
        );
      }
      next.methodFamily = label === "" ? undefined : label;
      contentPatched = true;
    }

    if (patch.subFamily !== undefined) {
      const label = patch.subFamily.trim();
      if (label === "") {
        delete next.subFamily;
      } else {
        const family = taxonomyFamilyOf(taxonomy, next.methodFamily);
        const allowed = family?.subFamilies;
        if (
          next.methodFamily === undefined ||
          next.methodFamily === UNCLASSIFIED_FAMILY ||
          allowed === undefined
        ) {
          throw new BusinessError(
            "INVALID_REQUEST",
            "subFamily 只能在 methodFamily 所属 family 声明 subFamilies 时设置",
          );
        }
        if (!allowed.includes(label)) {
          throw new BusinessError(
            "INVALID_REQUEST",
            `subFamily「${label}」不在 ${next.methodFamily} 的 subFamilies 列表（${allowed.join("、")}）`,
          );
        }
        next.subFamily = label;
      }
      contentPatched = true;
    }

    if (patch.comparedMethods !== undefined) {
      const normalized = normalizeComparedMethods(patch.comparedMethods);
      if (normalized.length > 0) {
        next.comparedMethods = normalized;
      } else {
        delete next.comparedMethods;
      }
      contentPatched = true;
    }

    if (patch.keyFindings !== undefined) {
      const items = patch.keyFindings.map((item) => item.trim()).filter((item) => item !== "");
      if (items.length > KEY_FINDINGS_MAX) {
        throw new BusinessError(
          "INVALID_REQUEST",
          `keyFindings 不能超过 ${KEY_FINDINGS_MAX} 条（当前 ${items.length}）`,
        );
      }
      if (items.length > 0) {
        next.keyFindings = items;
      } else {
        delete next.keyFindings;
      }
      contentPatched = true;
    }

    if (patch.anchors !== undefined) {
      // 同步形状校验；chunk / evidence 存在性在 updateEntry 主流程异步核验
      for (const anchor of patch.anchors) {
        if (
          typeof anchor.field !== "string" ||
          !(SURVEY_ANCHORABLE_FIELDS as readonly string[]).includes(anchor.field)
        ) {
          throw new BusinessError(
            "INVALID_REQUEST",
            `anchors[].field 只能是 ${SURVEY_ANCHORABLE_FIELDS.join(" / ")}（收到 ${String(anchor.field).slice(0, 40)}）`,
          );
        }
        if (!Array.isArray(anchor.chunkIds) || anchor.chunkIds.length === 0) {
          throw new BusinessError("INVALID_REQUEST", "anchors[].chunkIds 必须是非空字符串数组");
        }
      }
      next.anchors = patch.anchors;
      contentPatched = true;
    }

    if (patch.status !== undefined) {
      if (patch.status !== "draft" && patch.status !== "confirmed") {
        throw new BusinessError("INVALID_REQUEST", "status 只能是 draft / confirmed");
      }
      next.status = patch.status;
    } else if (contentPatched && current.status === "confirmed") {
      // 内容被修改的已确认条目回退 draft（重新走 HITL 确认）
      next.status = "draft";
    }
    return next;
  }

  /** 单篇抽取：检索 → 模型 → 解析 → 校验 → entry（失败抛错，由批处理落账） */
  private async extractEntry(
    projectId: string,
    item: SourceItem,
    taxonomy: SurveyTaxonomy,
    language: "zh" | "en" | undefined,
  ): Promise<SurveyMatrixEntry> {
    const depth: InterpretationDepth =
      item.status === "available" || item.status === "partial" ? "fulltext" : "abstract_only";
    let passages = "";
    if (depth === "fulltext") {
      const query = item.metadata.title?.trim() || `文献 ${item.sourceId}`;
      const result = await this.retrieval.search(projectId, query, {
        topK: MATRIX_PASSAGE_TOP_K,
        filter: { sourceIds: [item.sourceId] },
      });
      const packed = packRetrievalContext(result.results, {
        budgetTokens: MATRIX_PASSAGE_BUDGET_TOKENS,
        sourceScoped: true,
      });
      passages = packed.text;
    }
    const task = await this.runtime.runAgent({
      agentId: this.researcherAgentId,
      ...this.timeoutOverride,
      task: buildMatrixPrompt(item, depth, taxonomy, passages),
      projectId,
      contextScope: "research/survey-matrix",
      ...(language !== undefined ? { language } : {}),
      metadata: { role: "researcher", skill: "survey-matrix" },
    });
    if (task.status !== "completed") {
      throw new AgentRunFailedError(task.error ?? `矩阵抽取任务以 ${task.status} 状态结束`);
    }
    const parsed = extractJsonObject(task.output ?? "", "Survey Matrix 抽取结果");
    const updatedAt = this.now().toISOString();
    const { entry, issues } = parseMatrixEntryOutput({
      sourceId: item.sourceId,
      interpretationDepth: depth,
      parsed,
      taxonomy,
      updatedAt,
    });

    // chunk anchor 核验（fail-closed：无效锚点剔除 + issue，不静默保留）
    entry.anchors = await this.validateAnchors(
      projectId,
      item.sourceId,
      depth,
      entry.anchors,
      issues,
    );
    if (depth === "fulltext") {
      if (passages === "") {
        issues.push({
          code: "no_retrievable_chunks",
          message: "fulltext 条目未检索到任何全文段落（chunk 可能尚未生成），本次理解未锚定",
        });
      }
      if (entry.anchors.length === 0) {
        issues.push({
          code: "no_valid_anchors",
          message: "fulltext 条目没有任何有效 chunk anchor（弱溯源信号，综合时需谨慎）",
        });
      }
    }
    if (issues.length > 0) {
      entry.issues = issues;
    }
    entry.taskId = task.taskId;
    return entry;
  }

  /** anchors 核验：chunk 存在、属于本 source；abstract_only 强制清空 */
  private async validateAnchors(
    projectId: string,
    sourceId: string,
    depth: InterpretationDepth,
    anchors: SurveyFieldAnchor[],
    issues: SurveyMatrixIssue[],
  ): Promise<SurveyFieldAnchor[]> {
    if (depth === "abstract_only") {
      if (anchors.length > 0) {
        issues.push({
          code: "abstract_only_anchors_forced_empty",
          message: `abstract_only 条目禁止 chunk anchor（模型给出 ${anchors.length} 条），已强制清空`,
        });
      }
      return [];
    }
    const out: SurveyFieldAnchor[] = [];
    for (const anchor of anchors) {
      const validIds: string[] = [];
      for (const chunkId of anchor.chunkIds) {
        try {
          const resolved = await this.chunkAccess.resolve(projectId, chunkId);
          if (resolved.chunk.sourceId !== sourceId) {
            issues.push({
              code: "anchor_chunk_invalid",
              message: `chunk ${chunkId} 属于文献 ${resolved.chunk.sourceId}，跨文献锚定禁止，已剔除`,
              proposed: chunkId,
            });
            continue;
          }
          validIds.push(chunkId);
        } catch (error) {
          issues.push({
            code: "anchor_chunk_invalid",
            message: `chunkId 无效或不存在（${chunkId.slice(0, 100)}）：${errorText(error)}`,
            proposed: chunkId,
          });
        }
      }
      if (validIds.length === 0) {
        issues.push({
          code: "anchor_dropped",
          message: `字段 ${anchor.field} 的 anchor 无有效 chunkId，已丢弃`,
        });
        continue;
      }
      out.push({ ...anchor, chunkIds: validIds });
    }
    return out;
  }

  /** PUT anchors 的严格核验：任一非法直接抛 INVALID_REQUEST（不静默剔除） */
  private async validatePatchAnchors(
    projectId: string,
    sourceId: string,
    anchors: SurveyFieldAnchor[],
  ): Promise<SurveyFieldAnchor[]> {
    const evidenceRecords =
      this.evidence !== undefined ? await this.evidence.list(projectId) : null;
    const out: SurveyFieldAnchor[] = [];
    for (const anchor of anchors) {
      const chunkIds: string[] = [];
      for (const chunkId of anchor.chunkIds) {
        let resolvedChunk: { sourceId: string };
        try {
          resolvedChunk = (await this.chunkAccess.resolve(projectId, chunkId)).chunk;
        } catch (error) {
          throw new BusinessError(
            "INVALID_REQUEST",
            `anchors 中引用的 chunkId 无效或不存在（${chunkId.slice(0, 100)}）：${errorText(error)}`,
          );
        }
        if (resolvedChunk.sourceId !== sourceId) {
          throw new BusinessError(
            "INVALID_REQUEST",
            `anchors 中的 chunk ${chunkId} 属于文献 ${resolvedChunk.sourceId}，跨文献锚定禁止`,
          );
        }
        chunkIds.push(chunkId);
      }
      let evidenceRef: string[] | undefined;
      if (anchor.evidenceIds !== undefined && anchor.evidenceIds.length > 0) {
        if (evidenceRecords === null) {
          throw new BusinessError(
            "INVALID_REQUEST",
            "anchors.evidenceIds 需要 EvidenceStore 装配（当前服务未注入，无法核验存在性）",
          );
        }
        evidenceRef = [];
        for (const evidenceId of anchor.evidenceIds) {
          const record = evidenceRecords.find((candidate) => candidate.id === evidenceId);
          if (record === undefined) {
            throw new BusinessError("INVALID_REQUEST", `evidenceId 不存在：${evidenceId}`);
          }
          if (record.source?.sourceId !== undefined && record.source.sourceId !== sourceId) {
            throw new BusinessError(
              "INVALID_REQUEST",
              `Evidence ${evidenceId} 指向文献 ${record.source.sourceId}，与条目 ${sourceId} 不一致`,
            );
          }
          evidenceRef.push(evidenceId);
        }
      }
      out.push({
        field: anchor.field,
        chunkIds: [...new Set(chunkIds)],
        ...(evidenceRef !== undefined && evidenceRef.length > 0 ? { evidenceIds: evidenceRef } : {}),
      });
    }
    return out;
  }
}

// ---- 纯函数辅助 ----

/**
 * taxonomy 覆盖后的既有条目重校验（原地）：标签失效 → unclassified +
 * entry_reclassified issue；subFamily 失效 → 丢弃 + issue。
 */
function reclassifyEntry(entry: SurveyMatrixEntry, taxonomy: SurveyTaxonomy, updatedAt: string): void {
  const issues: SurveyMatrixIssue[] = [...(entry.issues ?? [])];
  if (entry.methodFamily !== undefined && entry.methodFamily !== UNCLASSIFIED_FAMILY) {
    const family = taxonomyFamilyOf(taxonomy, entry.methodFamily);
    if (family === undefined) {
      issues.push({
        code: "entry_reclassified",
        message: `taxonomy 更替后标签「${entry.methodFamily}」失效，已改为 unclassified`,
        proposed: entry.methodFamily,
      });
      entry.methodFamily = UNCLASSIFIED_FAMILY;
      delete entry.subFamily;
    } else if (
      entry.subFamily !== undefined &&
      (family.subFamilies === undefined || !family.subFamilies.includes(entry.subFamily))
    ) {
      issues.push({
        code: "subfamily_not_in_taxonomy",
        message: `taxonomy 更替后 subFamily「${entry.subFamily}」失效，已丢弃`,
        proposed: entry.subFamily,
      });
      delete entry.subFamily;
    }
  } else if (entry.subFamily !== undefined) {
    delete entry.subFamily;
  }
  if (issues.length > 0) {
    entry.issues = issues;
  }
  entry.updatedAt = updatedAt;
}

function canonicalTaxonomy(taxonomy: SurveyTaxonomy): string {
  return JSON.stringify(normalizeTaxonomy(taxonomy));
}

function errorText(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error);
  return message.slice(0, 200);
}

// ---- Prompt ----

/** 单篇抽取 prompt（独立可测；passages 为空串表示无全文段落） */
export function buildMatrixPrompt(
  item: SourceItem,
  depth: InterpretationDepth,
  taxonomy: SurveyTaxonomy,
  passages: string,
): string {
  const meta = item.metadata;
  const lines: string[] = [
    "你是一名学术研究员（Researcher）。请对下面这一篇文献做结构化理解，产出 Survey Matrix 的单行条目（综述矩阵：后续综合分析的输入，不是论文正文）。",
    "",
    "只输出一个 JSON 对象（不要 Markdown 围栏、不要解释文字），字段：",
    "{",
    '  "researchProblem": "该文献要解决的研究问题（≤300 字符）",',
    '  "methodFamily": "方法家族标签（必须从下方 taxonomy 标签列表中选择；没有合适标签时输出 "unclassified"）",',
    '  "subFamily": "子家族（可选；仅当所属 family 列出 subFamilies 时从中选择）",',
    '  "mainIdea": "核心思想（≤300 字符）",',
    '  "keyTechnique": "关键技术（≤300 字符；材料未体现则省略）",',
    '  "assumption": "主要假设（≤300 字符；未体现则省略）",',
    '  "datasetContext": "数据集 / 评测场景（≤300 字符；未体现则省略）",',
    ...(depth === "fulltext"
      ? [
          '  "strength": "主要优点（≤300 字符；必须以全文段落为依据）",',
          '  "limitation": "主要局限（≤300 字符；必须以全文段落为依据）",',
        ]
      : [
          '  "strength": "（abstract_only 不填写：评价性字段需要全文依据）",',
          '  "limitation": "（abstract_only 不填写：评价性字段需要全文依据）",',
        ]),
    '  "comparedMethods": ["被对比的方法名（≤20 个，去重）"],',
    '  "keyFindings": ["关键发现 / 实验结论（≤3 条；abstract_only 不填写）"],',
    ...(depth === "fulltext"
      ? [
          '  "anchors": [',
          '    {"field": "mainIdea|keyTechnique|strength|limitation|keyFindings|datasetContext 之一",',
          '     "chunkIds": ["检索段落标记中 CHUNK: 后的完整 id（可多个）"]}',
          "  ]",
        ]
      : ['  "anchors": []（abstract_only 必须为空数组）']),
    "}",
    "",
    "要求：",
    "1. methodFamily 必须从 taxonomy 标签列表选择，绝不发明新标签；没有合适标签就输出 unclassified。",
    ...(depth === "fulltext"
      ? [
          "2. anchors：对 strength / limitation / keyFindings / mainIdea / keyTechnique / datasetContext 中你能从检索段落找到依据的字段给出 anchors；chunkId 必须逐字复制段落标记中 CHUNK: 后的完整标识，不得改写、不得凭记忆生成。",
          "3. strength / limitation / keyFindings 没有全文依据时省略该字段（绝不编造）；锚定不到任何字段的 anchors 不要输出。",
          "4. 如实填写：材料未体现的信息一律省略字段，宁可留空也不推测。",
        ]
      : [
          "2. 本文献只有元数据与摘要（abstract_only）：只做有限的初步归类——填写 researchProblem / methodFamily / subFamily / mainIdea / keyTechnique / assumption / datasetContext / comparedMethods 中摘要确有依据的部分。",
          "3. 禁止输出 anchors（摘要不进入 chunk 检索链路）；禁止输出 strength / limitation / keyFindings（评价性与实证结论需要全文依据）。",
          "4. 如实填写：摘要未体现的信息一律省略字段，绝不推测。",
        ]),
    "",
    "===== 文献 =====",
    `- sourceId: ${item.sourceId}`,
    `- 标题: ${meta.title ?? "（未知）"}`,
    ...(meta.authors !== undefined && meta.authors.length > 0
      ? [`- 作者: ${meta.authors.slice(0, 6).join(", ")}`]
      : []),
    ...(meta.year !== undefined ? [`- 年份: ${meta.year}`] : []),
    ...(meta.venue !== undefined && meta.venue !== "" ? [`- Venue: ${meta.venue}`] : []),
    ...(meta.doi !== undefined && meta.doi !== "" ? [`- DOI: ${meta.doi}`] : []),
    `- 解释深度: ${depth === "fulltext" ? "fulltext（已入库全文，可锚定）" : "abstract_only（仅元数据 / 摘要）"}`,
    "",
    ...(depth === "fulltext"
      ? [
          "===== 全文检索段落（anchor 依据；CHUNK: 后是 chunkId）=====",
          passages !== ""
            ? passages
            : "（未检索到任何全文段落——本次只能基于上方元数据理解，anchors 留空）",
        ]
      : [
          "===== 摘要 / 元数据线索 =====",
          meta.abstract !== undefined && meta.abstract !== ""
            ? meta.abstract
            : item.analysis?.textPreview !== undefined && item.analysis.textPreview !== ""
              ? item.analysis.textPreview.slice(0, 1500)
              : "（无摘要可用；仅凭上方元数据做最保守的归类，信息不足的字段省略）",
        ]),
    "",
    "===== taxonomy 标签列表 =====",
    ...taxonomy.families.map((family) =>
      `- ${family.label}：${family.description}${
        family.subFamilies !== undefined ? `（subFamilies: ${family.subFamilies.join(" / ")}）` : ""
      }`,
    ),
  ];
  return lines.join("\n");
}
