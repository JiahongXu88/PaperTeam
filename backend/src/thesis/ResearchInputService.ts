/**
 * M14.1b：Research Input & Scientific Fact Management 门面服务（HTTP / 测试 / 未来
 * thesis stage 共用）。本层不调用模型；模型候选事实只能经 addStatementFacts 以
 * extracted 身份进入，并立刻走来源核验。
 */

import { BusinessError, NotFoundError } from "../errors.js";
import type { IngestionService } from "../ingestion/IngestionService.js";
import type { ParsedDocumentStore } from "../ingestion/ParsedDocumentStore.js";
import type { ParsedDocument } from "../ingestion/types.js";
import { sha256Hex } from "../util/hash.js";
import type { AuthorDecisionStore } from "./AuthorDecisionStore.js";
import { extractBodyTextFacts } from "./bodyTextFacts.js";
import { extractTableFacts, extractTables, statementFactId, type ExtractedTable } from "./factExtraction.js";
import {
  buildInheritedTableCandidates,
  InheritedTableAssetStore,
  type InheritedTableAsset,
  type InheritedTableAssetFile,
} from "./inheritedAssets.js";
import { normalizeSurfaceText, parseFactValue } from "./factValues.js";
import { buildResearchFactContext } from "./plannerContext.js";
import type { RegisterResearchInputRequest, RegisterResearchInputResult, ResearchInputRegistry } from "./ResearchInputRegistry.js";
import {
  FACT_KINDS,
  RESEARCH_INPUT_ALGORITHM_VERSION,
  type AuthorDecision,
  type AuthorDecisionPayload,
  type DecisionActor,
  type FactConflict,
  type FactKind,
  type ResearchFactContext,
  type ResearchInput,
  type ScientificFact,
  type TableAlignment,
  type VersionRelation,
} from "./researchInputTypes.js";
import type { ScientificFactStore } from "./ScientificFactStore.js";
import { checkQuoteAgainstDocumentText, checkTableCellAgainstTextLayer, documentPlainText, type SourceCheckOutcome } from "./sourceVerification.js";
import { alignTables, detectTableConflicts } from "./tableAlignment.js";
import type { TextLayerProvider } from "./textLayer.js";

export interface ResearchInputServiceOptions {
  registry: ResearchInputRegistry;
  facts: ScientificFactStore;
  decisions: AuthorDecisionStore;
  documents: ParsedDocumentStore;
  ingestion: IngestionService;
  textLayer: TextLayerProvider;
  /** M14.3：继承表格资产 store（缺省不启用该能力——查询返回空台账） */
  tables?: InheritedTableAssetStore;
  now?: () => Date;
}

export interface ResearchInputView {
  input: ResearchInput;
  relations: VersionRelation[];
  factCounts: Record<ScientificFact["verification"]["status"], number> & { conflicted: number; total: number };
}

export interface StatementFactCandidate {
  kind: FactKind;
  statement: string;
  quote: string;
  key?: ScientificFact["key"];
  value?: string;
}

export class ResearchInputService {
  private readonly now: () => Date;
  constructor(private readonly deps: ResearchInputServiceOptions) {
    this.now = deps.now ?? (() => new Date());
  }

  get registry(): ResearchInputRegistry {
    return this.deps.registry;
  }
  get facts(): ScientificFactStore {
    return this.deps.facts;
  }
  get decisions(): AuthorDecisionStore {
    return this.deps.decisions;
  }
  get tables(): InheritedTableAssetStore | undefined {
    return this.deps.tables;
  }

  /** 注册；ensureParsed=true 时同步等待解析（PDF 可能很慢——只在显式请求 / 验证脚本使用） */
  async register(projectId: string, request: RegisterResearchInputRequest, options: { ensureParsed?: boolean } = {}): Promise<RegisterResearchInputResult> {
    const result = await this.deps.registry.register(projectId, request);
    if (options.ensureParsed === true && result.input.parse.status === "pending") {
      await this.deps.ingestion.ingest(projectId, request.sourceId);
      result.input = await this.deps.registry.refreshParse(projectId, result.input.inputId);
    }
    return result;
  }

  async list(projectId: string) {
    return this.deps.registry.load(projectId);
  }

  async view(projectId: string, inputId: string): Promise<ResearchInputView> {
    const file = await this.deps.registry.load(projectId);
    const input = file.inputs.find((entry) => entry.inputId === inputId);
    if (input === undefined) throw new NotFoundError("研究输入", inputId);
    const facts = await this.deps.facts.list(projectId, { researchInputId: inputId });
    const factCounts = { extracted: 0, source_verified: 0, author_confirmed: 0, conflicted: 0, total: facts.length };
    for (const fact of facts) {
      factCounts[fact.verification.status] += 1;
      if (fact.conflict.status === "unresolved") factCounts.conflicted += 1;
    }
    return {
      input,
      relations: file.relations.filter((relation) => relation.fromInputId === inputId || relation.toInputId === inputId),
      factCounts,
    };
  }

  private async loadFreshDocument(projectId: string, input: ResearchInput): Promise<ParsedDocument> {
    const document = await this.deps.documents.load(projectId, input.version.sourceId);
    if (document === null) {
      throw new BusinessError("INVALID_REQUEST", `研究输入 ${input.inputId} 尚无解析产物（parse=${input.parse.status}）`);
    }
    if (document.contentHash !== "" && document.contentHash !== input.version.contentHash) {
      throw new BusinessError("INVALID_REQUEST", `研究输入 ${input.inputId} 的解析产物对应旧内容版本，需重新解析`);
    }
    if (document.status === "failed") {
      throw new BusinessError("INVALID_REQUEST", `研究输入 ${input.inputId} 解析失败，无法抽取事实`);
    }
    return document;
  }

  /**
   * 确定性抽取（表格单元格 + M14.1c 正文数值）→ extracted；幂等。
   * 噪声表格（封面 / 目录误判）跳过并在返回中透明计数。
   */
  async extractFacts(projectId: string, inputId: string): Promise<{
    created: number;
    unchanged: number;
    tables: ExtractedTable[];
    skippedCells: number;
    skippedNoiseTables: number;
    bodyText: { created: number; candidates: number; figureEmbedded: number };
    parseStatus: ResearchInput["parse"]["status"];
  }> {
    const input = await this.deps.registry.refreshParse(projectId, inputId);
    const document = await this.loadFreshDocument(projectId, input);
    const now = this.now().toISOString();
    const result = extractTableFacts(input, document, now);
    const body = extractBodyTextFacts(input, document, now);
    const upsert = await this.deps.facts.upsertFacts(projectId, [...result.facts, ...body.facts]);
    return {
      ...upsert,
      tables: result.tables,
      skippedCells: result.skippedCells,
      skippedNoiseTables: result.skippedNoiseTables,
      bodyText: { created: body.facts.length, candidates: body.skippedCandidates, figureEmbedded: body.figureEmbeddedCount },
      parseStatus: input.parse.status,
    };
  }

  /** 来源核验：表格事实对 PyMuPDF 文本层；语句事实对文档全文引文 */
  async verifyFacts(projectId: string, inputId: string): Promise<{ checked: number; verified: number; failed: number; textLayerAvailable: boolean }> {
    const input = await this.deps.registry.get(projectId, inputId);
    const facts = await this.deps.facts.list(projectId, { researchInputId: inputId });
    const document = await this.deps.documents.load(projectId, input.version.sourceId);
    const pages = facts.some((fact) => fact.kind === "table_cell")
      ? await this.deps.textLayer.pages(projectId, input.version.sourceId, input.version.contentHash)
      : null;
    const fullText = document !== null ? documentPlainText(document.blocks) : "";
    const outcomes: Array<{ factId: string; outcome: SourceCheckOutcome }> = [];
    for (const fact of facts) {
      if (fact.provenance.contentHash !== input.version.contentHash) continue;
      const outcome = fact.kind === "table_cell" ? checkTableCellAgainstTextLayer(fact, pages) : checkQuoteAgainstDocumentText(fact, fullText);
      outcomes.push({ factId: fact.factId, outcome });
    }
    await this.deps.facts.applySourceChecks(projectId, outcomes);
    return {
      checked: outcomes.length,
      verified: outcomes.filter((entry) => entry.outcome.verified).length,
      failed: outcomes.filter((entry) => !entry.outcome.verified).length,
      textLayerAvailable: pages !== null,
    };
  }

  /**
   * 语句类事实候选（模型 / 人工）：以 extracted 入库并立即核验引文。模型输出
   * 永远不能直接 source_verified / author_confirmed。
   */
  async addStatementFacts(
    projectId: string,
    inputId: string,
    candidates: StatementFactCandidate[],
    extraction: { method: "model_candidate" | "manual"; extractor: string; taskId?: string },
  ): Promise<{ facts: ScientificFact[]; verified: number }> {
    const input = await this.deps.registry.get(projectId, inputId);
    const document = await this.loadFreshDocument(projectId, input);
    const now = this.now().toISOString();
    const facts: ScientificFact[] = [];
    for (const candidate of candidates) {
      if (!FACT_KINDS.includes(candidate.kind)) {
        throw new BusinessError("INVALID_REQUEST", `事实类型只能是 ${FACT_KINDS.join(" / ")}`);
      }
      const statement = normalizeSurfaceText(candidate.statement);
      const quote = normalizeSurfaceText(candidate.quote);
      if (statement === "" || quote === "") continue;
      facts.push({
        schemaVersion: 1,
        factId: statementFactId(input, candidate.kind, statement),
        projectId,
        researchInputId: inputId,
        kind: candidate.kind,
        key: candidate.key ?? {},
        surface: statement,
        value: candidate.value !== undefined ? parseFactValue(candidate.value) : { raw: statement },
        provenance: {
          researchInputId: inputId,
          sourceId: input.version.sourceId,
          contentHash: input.version.contentHash,
          pageBasis: "unknown",
          quote,
          surfaceHash: sha256Hex(statement),
        },
        extraction: { ...extraction, algorithmVersion: RESEARCH_INPUT_ALGORITHM_VERSION },
        verification: { status: "extracted", sourceCheck: "unchecked" },
        conflict: { status: "none", conflictIds: [] },
        createdAt: now,
        updatedAt: now,
      });
    }
    await this.deps.facts.upsertFacts(projectId, facts);
    const fullText = documentPlainText(document.blocks);
    const outcomes = facts.map((fact) => ({ factId: fact.factId, outcome: checkQuoteAgainstDocumentText(fact, fullText) }));
    await this.deps.facts.applySourceChecks(projectId, outcomes);
    const stored = await this.deps.facts.list(projectId, { researchInputId: inputId });
    const ids = new Set(facts.map((fact) => fact.factId));
    return { facts: stored.filter((fact) => ids.has(fact.factId)), verified: outcomes.filter((entry) => entry.outcome.verified).length };
  }

  /**
   * 跨输入表格对齐 + 冲突检测（确定性、幂等）。缺省对全部有解析产物的输入两两
   * 对齐；inputIds 限定范围。
   */
  async detectConflicts(projectId: string, options: { inputIds?: string[] } = {}): Promise<{
    alignments: TableAlignment[];
    conflicts: { created: number; existing: number; reopened: number; detected: FactConflict[] };
    skippedInputs: Array<{ inputId: string; reason: string }>;
  }> {
    const file = await this.deps.registry.load(projectId);
    const selected = file.inputs.filter((input) => options.inputIds === undefined || options.inputIds.includes(input.inputId));
    const tablesByInput = new Map<string, ExtractedTable[]>();
    const skipped: Array<{ inputId: string; reason: string }> = [];
    const inputs: ResearchInput[] = [];
    for (const input of selected) {
      const document = await this.deps.documents.load(projectId, input.version.sourceId);
      if (document === null || document.status === "failed" || document.contentHash !== input.version.contentHash) {
        skipped.push({ inputId: input.inputId, reason: document === null ? "无解析产物" : document.status === "failed" ? "解析失败" : "解析产物版本不匹配" });
        continue;
      }
      tablesByInput.set(
        input.inputId,
        // M14.1c：噪声表格（封面 / 目录误判）不进入对齐候选
        extractTables(document).filter((table) => table.noise?.likely !== true),
      );
      inputs.push(input);
    }
    const now = this.now().toISOString();
    const alignments: TableAlignment[] = [];
    for (let i = 0; i < inputs.length; i += 1) {
      for (let j = i + 1; j < inputs.length; j += 1) {
        const left = inputs[i]!;
        const right = inputs[j]!;
        if (left.version.contentHash === right.version.contentHash) continue;
        alignments.push(...alignTables({ input: left, tables: tablesByInput.get(left.inputId) ?? [] }, { input: right, tables: tablesByInput.get(right.inputId) ?? [] }, projectId, now));
      }
    }
    const stored = await this.deps.registry.upsertAlignments(projectId, alignments);
    const relevant = stored.filter((alignment) => alignments.some((entry) => entry.alignmentId === alignment.alignmentId));
    const facts = (await this.deps.facts.load(projectId)).facts;
    const detected = detectTableConflicts({ projectId, alignments: relevant, tablesByInput, facts, now });
    const merge = await this.deps.facts.upsertConflicts(projectId, detected);
    return { alignments: relevant, conflicts: { ...merge, detected }, skippedInputs: skipped };
  }

  /** 作者决定：记录 + 应用（幂等；apply 失败不落账） */
  async submitDecision(projectId: string, input: { decisionId?: string; actor: DecisionActor; payload: AuthorDecisionPayload }): Promise<{ decision: AuthorDecision; duplicate: boolean }> {
    return this.deps.decisions.record(projectId, input, async (decision) => this.applyDecision(projectId, decision));
  }

  private async applyDecision(projectId: string, decision: AuthorDecision): Promise<string[]> {
    const payload = decision.payload;
    const effects: string[] = [];
    switch (payload.type) {
      case "scope_decision": {
        const input = await this.deps.registry.applyScopeDecision(projectId, payload.inputId, payload.scope, decision.decisionId);
        effects.push(`scope:${input.inputId}=${payload.scope}`);
        break;
      }
      case "version_selection": {
        const group = await this.deps.registry.applyVersionSelection(projectId, payload.workId, payload.preferredInputId, decision.decisionId);
        effects.push(`preferred:${group.workId}=${payload.preferredInputId}`);
        break;
      }
      case "relation_confirmation": {
        const relation = await this.deps.registry.applyRelationDecision(projectId, payload.relationId, payload.outcome, decision.decisionId);
        effects.push(`relation:${relation.relationId}=${payload.outcome}`);
        break;
      }
      case "conflict_resolution": {
        const conflict = await this.deps.facts.applyConflictResolution(projectId, payload.conflictId, payload.decision, decision.decisionId, decision.actor, {
          ...(payload.adoptedFactId !== undefined ? { adoptedFactId: payload.adoptedFactId } : {}),
          ...(payload.rationale !== undefined ? { rationale: payload.rationale } : {}),
        });
        effects.push(`conflict:${conflict.conflictId}=${conflict.status}`);
        break;
      }
      case "fact_confirmation": {
        const facts = await this.deps.facts.applyFactConfirmation(projectId, payload.factIds, payload.outcome, decision.decisionId, decision.actor);
        effects.push(...facts.map((fact) => `fact:${fact.factId}=${fact.verification.status}`));
        break;
      }
      case "unpublished_material_policy": {
        const input = await this.deps.registry.applyUnpublishedPolicy(projectId, payload.inputId, payload.allowed, decision.decisionId, payload.note);
        effects.push(`unpublished:${input.inputId}=${payload.allowed ? "allowed" : "denied"}`);
        break;
      }
      case "writing_pause": {
        // 写作暂停只记账（thesis workflow 在 M14.2 消费）；无状态可改
        effects.push(`writing:${payload.subject}=${payload.decision}`);
        break;
      }
      case "table_alignment_confirmation": {
        // M14.1c：候选表格对齐的作者裁决（确认 → comparable；拒绝 → not_comparable）
        const alignment = await this.deps.registry.applyAlignmentDecision(
          projectId,
          payload.alignmentId,
          payload.outcome,
          decision.decisionId,
          payload.rationale,
        );
        effects.push(`alignment:${alignment.alignmentId}=${alignment.status}`);
        break;
      }
      case "table_inheritance": {
        // M14.3：继承表格授权（authorized → 写作期确定性插入；rejected → 不进入）
        if (this.deps.tables === undefined) {
          throw new BusinessError("INVALID_REQUEST", "继承表格资产能力未启用（tables store 缺失）");
        }
        const file = await this.deps.tables.load(projectId);
        const asset = file?.assets.find((entry) => entry.assetId === payload.assetId);
        if (asset === undefined) {
          throw new NotFoundError("继承表格资产", payload.assetId);
        }
        if (asset.status === "inserted") {
          throw new BusinessError("INVALID_REQUEST", `资产 ${payload.assetId} 已插入学位论文，不可再变更（数据修改须走新的作者决定）`);
        }
        asset.status = payload.outcome === "authorized" ? "authorized" : "rejected";
        if (payload.captionZh !== undefined && payload.captionZh.trim() !== "") {
          asset.captionZh = payload.captionZh.trim();
        }
        asset.authorization = {
          decisionId: decision.decisionId,
          actorKind: decision.actor.kind,
          authorizedAt: this.now().toISOString(),
        };
        asset.updatedAt = this.now().toISOString();
        await this.deps.tables.save(projectId, { ...file!, updatedAt: asset.updatedAt });
        effects.push(`table_asset:${asset.assetId}=${asset.status}`);
        break;
      }
    }
    return effects;
  }

  /**
   * M14.3：刷新继承表格候选（确定性、幂等）。对全部已入选且有解析产物的输入
   * 重建候选并合并进台账；已授权 / 已插入 / 已拒绝的资产不受候选重建影响。
   */
  async refreshTableCandidates(projectId: string): Promise<{ file: InheritedTableAssetFile; candidatesBuilt: number; skippedInputs: string[] }> {
    if (this.deps.tables === undefined) {
      return {
        file: { schemaVersion: 1, projectId, assets: [], updatedAt: this.now().toISOString() },
        candidatesBuilt: 0,
        skippedInputs: [],
      };
    }
    const registry = await this.deps.registry.load(projectId);
    const facts = (await this.deps.facts.load(projectId)).facts;
    const now = this.now().toISOString();
    const candidates: InheritedTableAsset[] = [];
    const skipped: string[] = [];
    for (const input of registry.inputs) {
      if (input.scope.status !== "included") continue;
      const document = await this.deps.documents.load(projectId, input.version.sourceId);
      if (document === null || document.status === "failed" || document.contentHash !== input.version.contentHash) {
        skipped.push(input.inputId);
        continue;
      }
      candidates.push(...buildInheritedTableCandidates({ projectId, researchInput: input, tables: extractTables(document), facts, now }));
    }
    const file = await this.deps.tables.upsert(projectId, candidates, now);
    return { file, candidatesBuilt: candidates.length, skippedInputs: skipped };
  }

  /** M14.3：台账视图（候选 + 状态） */
  async listTableAssets(projectId: string): Promise<InheritedTableAssetFile> {
    if (this.deps.tables === undefined) {
      return { schemaVersion: 1, projectId, assets: [], updatedAt: this.now().toISOString() };
    }
    return (await this.deps.tables.load(projectId)) ?? { schemaVersion: 1, projectId, assets: [], updatedAt: this.now().toISOString() };
  }

  async plannerContext(projectId: string): Promise<ResearchFactContext> {
    const registry = await this.deps.registry.load(projectId);
    const facts = await this.deps.facts.load(projectId);
    return buildResearchFactContext({
      projectId,
      inputs: registry.inputs,
      workGroups: registry.workGroups,
      facts: facts.facts,
      conflicts: facts.conflicts,
      now: this.now().toISOString(),
    });
  }
}

/**
 * HITL 适配：把 workflow ResumeInput（decision + payload）映射为 AuthorDecisionPayload，
 * 供未来 hitl.author_decision / hitl.scope_and_version / hitl.fact_conflicts 的 onInput
 * 复用同一应用层。非法载荷抛 INVALID_REQUEST（不猜）。
 */
export function authorDecisionFromResumeInput(input: { decision: string; payload?: Record<string, unknown> }): AuthorDecisionPayload {
  const payload = input.payload ?? {};
  const str = (field: string): string => {
    const value = payload[field];
    if (typeof value !== "string" || value.trim() === "") throw new BusinessError("INVALID_REQUEST", `作者决定缺少字段 ${field}`);
    return value.trim();
  };
  const optional = (field: string): string | undefined => (typeof payload[field] === "string" ? (payload[field] as string) : undefined);
  switch (input.decision) {
    case "include":
    case "exclude":
    case "supersede":
      return { type: "scope_decision", inputId: str("inputId"), scope: input.decision === "include" ? "included" : input.decision === "exclude" ? "excluded" : "superseded", ...(optional("rationale") !== undefined ? { rationale: optional("rationale")! } : {}) };
    case "select_version":
      return { type: "version_selection", workId: str("workId"), preferredInputId: str("preferredInputId") };
    case "confirm_relation":
    case "reject_relation":
      return { type: "relation_confirmation", relationId: str("relationId"), outcome: input.decision === "confirm_relation" ? "confirmed" : "rejected" };
    case "adopt_fact":
    case "keep_both":
    case "request_material":
    case "defer": {
      const adopted = optional("adoptedFactId");
      return { type: "conflict_resolution", conflictId: str("conflictId"), decision: input.decision, ...(adopted !== undefined ? { adoptedFactId: adopted } : {}), ...(optional("rationale") !== undefined ? { rationale: optional("rationale")! } : {}) };
    }
    case "confirm_facts":
    case "revoke_facts": {
      const ids = payload["factIds"];
      if (!Array.isArray(ids) || ids.length === 0 || !ids.every((id) => typeof id === "string")) throw new BusinessError("INVALID_REQUEST", "作者决定缺少 factIds");
      return { type: "fact_confirmation", factIds: ids as string[], outcome: input.decision === "confirm_facts" ? "confirmed" : "revoked" };
    }
    case "allow_unpublished":
    case "deny_unpublished":
      return { type: "unpublished_material_policy", inputId: str("inputId"), allowed: input.decision === "allow_unpublished" };
    case "pause":
    case "write_as_limitation":
    case "defer_chapter":
    case "attach_experiment_package":
      return { type: "writing_pause", subject: str("subject"), decision: input.decision === "defer_chapter" ? "defer" : input.decision };
    case "confirm_table_alignment":
    case "reject_table_alignment":
      return {
        type: "table_alignment_confirmation",
        alignmentId: str("alignmentId"),
        outcome: input.decision === "confirm_table_alignment" ? "confirmed" : "rejected",
        ...(optional("rationale") !== undefined ? { rationale: optional("rationale")! } : {}),
      };
    case "authorize_table":
    case "reject_table":
      return {
        type: "table_inheritance",
        assetId: str("assetId"),
        outcome: input.decision === "authorize_table" ? "authorized" : "rejected",
        ...(optional("captionZh") !== undefined ? { captionZh: optional("captionZh")! } : {}),
        ...(optional("rationale") !== undefined ? { rationale: optional("rationale")! } : {}),
      };
    default:
      throw new BusinessError("INVALID_REQUEST", `未知作者决定：${input.decision}`);
  }
}
