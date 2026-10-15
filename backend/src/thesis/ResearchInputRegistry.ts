/**
 * M14.1b：ResearchInput 注册表（research/research-inputs.json）。
 *
 * 复用：SourceStore（原始文件 + contentHash 去重）、ParsedDocumentStore（解析产物）、
 * EvidenceStore（evidenceLinks 只读派生）。本层只持有研究材料的类型 / 版本 /
 * 关系 / 入选状态，不复制任何正文。写入经项目级队列串行 + 原子写。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { BusinessError, NotFoundError } from "../errors.js";
import type { EvidenceStore } from "../evidence/EvidenceStore.js";
import type { ParsedDocumentStore } from "../ingestion/ParsedDocumentStore.js";
import type { ParsedDocument } from "../ingestion/types.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { SourceItem, SourceStore } from "../sources/SourceStore.js";
import { writeJsonAtomic } from "../util/atomic.js";
import { sha256Hex } from "../util/hash.js";
import {
  RESEARCH_INPUT_SCOPES,
  RESEARCH_INPUT_TYPES,
  VERSION_RELATION_KINDS,
  type PublicationStatusValue,
  type RelationBasis,
  type ResearchInput,
  type ResearchInputIdentifiers,
  type ResearchInputParseSummary,
  type ResearchInputScope,
  type ResearchInputType,
  type TableAlignment,
  type VersionRelation,
  type VersionRelationKind,
  type WorkGroupState,
} from "./researchInputTypes.js";

export interface ResearchInputRegistryFile {
  schemaVersion: 1;
  inputs: ResearchInput[];
  relations: VersionRelation[];
  workGroups: WorkGroupState[];
  alignments: TableAlignment[];
  updatedAt: string;
}

export interface RegisterResearchInputRequest {
  sourceId: string;
  inputType: ResearchInputType;
  title?: string;
  authors?: string[];
  providedBy?: string;
  provenanceUri?: string;
  doi?: string;
  arxivId?: string;
  versionLabel?: string;
  publicationStatus?: { value: PublicationStatusValue; asOf?: string };
  /** 显式归入某个成果分组（缺省 = 自成一组） */
  workId?: string;
}

export interface RegisterResearchInputResult {
  input: ResearchInput;
  created: boolean;
  /** 本次自动提出的（确定性元数据）版本关系 */
  relations: VersionRelation[];
}

const PUBLICATION_STATUS_VALUES: readonly PublicationStatusValue[] = ["published", "accepted", "submitted", "preprint", "unpublished"];

export class ResearchInputRegistry {
  private readonly queues = new Map<string, Promise<unknown>>();
  private readonly now: () => Date;

  constructor(
    private readonly projects: ProjectStore,
    private readonly sources: SourceStore,
    private readonly documents: ParsedDocumentStore,
    private readonly evidence: EvidenceStore,
    options: { now?: () => Date } = {},
  ) {
    this.now = options.now ?? (() => new Date());
  }

  filePath(projectId: string): string {
    return join(this.projects.researchDir(projectId), "research-inputs.json");
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

  async load(projectId: string): Promise<ResearchInputRegistryFile> {
    await this.projects.getRequired(projectId);
    let raw: string;
    try {
      raw = await readFile(this.filePath(projectId), "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return emptyRegistry(this.now().toISOString());
      }
      throw error;
    }
    let parsed: ResearchInputRegistryFile;
    try {
      parsed = JSON.parse(raw) as ResearchInputRegistryFile;
    } catch {
      throw new BusinessError("STAGE_CONTRACT_VIOLATION", "research-inputs.json 损坏，已停止读写（不自动覆盖）");
    }
    if (parsed.schemaVersion !== 1 || !Array.isArray(parsed.inputs)) {
      throw new BusinessError("STAGE_CONTRACT_VIOLATION", "research-inputs.json 结构不合法");
    }
    return {
      ...parsed,
      relations: parsed.relations ?? [],
      workGroups: parsed.workGroups ?? [],
      alignments: parsed.alignments ?? [],
    };
  }

  private async save(projectId: string, file: ResearchInputRegistryFile): Promise<void> {
    await writeJsonAtomic(this.filePath(projectId), { ...file, updatedAt: this.now().toISOString() });
  }

  /** 读-改-写（队列内） */
  async update<T>(projectId: string, mutate: (file: ResearchInputRegistryFile) => Promise<T> | T): Promise<T> {
    return this.enqueue(projectId, async () => {
      const file = await this.load(projectId);
      const result = await mutate(file);
      await this.save(projectId, file);
      return result;
    });
  }

  async list(projectId: string): Promise<ResearchInput[]> {
    return (await this.load(projectId)).inputs;
  }

  async get(projectId: string, inputId: string): Promise<ResearchInput> {
    const input = (await this.load(projectId)).inputs.find((entry) => entry.inputId === inputId);
    if (input === undefined) {
      throw new NotFoundError("研究输入", inputId);
    }
    return input;
  }

  /**
   * 注册：按 sourceId + contentHash 派生 inputId → 同一文件重复注册返回既有条目
   * （created=false）；内容不同的新文件 = 新条目（不覆盖旧版本）。
   */
  async register(projectId: string, request: RegisterResearchInputRequest): Promise<RegisterResearchInputResult> {
    if (!RESEARCH_INPUT_TYPES.includes(request.inputType)) {
      throw new BusinessError("INVALID_REQUEST", `inputType 只能是 ${RESEARCH_INPUT_TYPES.join(" / ")}`);
    }
    if (request.publicationStatus !== undefined && !PUBLICATION_STATUS_VALUES.includes(request.publicationStatus.value)) {
      throw new BusinessError("INVALID_REQUEST", `publicationStatus 只能是 ${PUBLICATION_STATUS_VALUES.join(" / ")}`);
    }
    const source = await this.sources.getRequired(projectId, request.sourceId);
    if (source.contentHash === undefined) {
      throw new BusinessError("INVALID_REQUEST", `文献 ${request.sourceId} 没有原始文件（metadata-only），不能登记为研究输入`);
    }
    const contentHash = source.contentHash;
    const inputId = researchInputId(request.sourceId, contentHash);
    const document = await this.documents.load(projectId, request.sourceId);
    const evidenceIds = (await this.evidence.query(projectId, { sourceId: request.sourceId })).map((record) => record.id);
    return this.update(projectId, (file) => {
      const existing = file.inputs.find((entry) => entry.inputId === inputId);
      if (existing !== undefined) {
        existing.parse = summarizeParse(source, document, this.now().toISOString());
        existing.evidenceLinks = { evidenceIds };
        existing.updatedAt = this.now().toISOString();
        return { input: existing, created: false, relations: [] };
      }
      const now = this.now().toISOString();
      const identifiers = buildIdentifiers(request, source);
      const input: ResearchInput = {
        schemaVersion: 1,
        inputId,
        projectId,
        inputType: request.inputType,
        title: (request.title ?? source.metadata.title ?? source.originalName ?? source.fileName ?? inputId).trim(),
        authors: request.authors ?? source.metadata.authors ?? [],
        ...(request.providedBy !== undefined ? { providedBy: request.providedBy } : {}),
        ...(request.provenanceUri !== undefined
          ? { provenanceUri: request.provenanceUri }
          : source.metadata.url !== undefined
            ? { provenanceUri: source.metadata.url }
            : { provenanceUri: "local-upload" }),
        identifiers,
        ...(request.versionLabel !== undefined ? { versionLabel: request.versionLabel } : {}),
        ...(request.publicationStatus !== undefined ? { publicationStatus: request.publicationStatus } : {}),
        workId: request.workId ?? inputId,
        version: {
          sourceId: request.sourceId,
          contentHash,
          ...(source.fileName !== undefined ? { fileName: source.originalName ?? source.fileName } : {}),
          bytes: source.bytes,
          importedAt: source.createdAt,
        },
        parse: summarizeParse(source, document, now),
        scope: { status: "proposed", updatedAt: now },
        evidenceLinks: { evidenceIds },
        createdAt: now,
        updatedAt: now,
      };
      file.inputs.push(input);
      upsertWorkGroup(file, input.workId, input.inputId, now);
      const relations = proposeIdentifierRelations(file, input, now);
      return { input, created: true, relations };
    });
  }

  /** 重新读取解析产物，刷新 parse 摘要（解析完成 / 失败后调用） */
  async refreshParse(projectId: string, inputId: string): Promise<ResearchInput> {
    const current = await this.get(projectId, inputId);
    const source = await this.sources.getRequired(projectId, current.version.sourceId);
    const document = await this.documents.load(projectId, current.version.sourceId);
    return this.update(projectId, (file) => {
      const input = requireInput(file, inputId);
      input.parse = summarizeParse(source, document, this.now().toISOString());
      input.updatedAt = this.now().toISOString();
      return input;
    });
  }

  /** 候选关系（模型 / 内容证据 / 标题相似）：永远 candidate，确认须作者决定 */
  async proposeRelation(
    projectId: string,
    request: { fromInputId: string; toInputId: string; kind: VersionRelationKind; basis: Exclude<RelationBasis, "author_decision" | "arxiv_identifier" | "doi_identifier">; evidence?: string; proposedBy: "system" | "model" },
  ): Promise<VersionRelation> {
    if (!VERSION_RELATION_KINDS.includes(request.kind)) {
      throw new BusinessError("INVALID_REQUEST", `relation kind 只能是 ${VERSION_RELATION_KINDS.join(" / ")}`);
    }
    if (request.fromInputId === request.toInputId) {
      throw new BusinessError("INVALID_REQUEST", "关系两端不能是同一研究输入");
    }
    return this.update(projectId, (file) => {
      requireInput(file, request.fromInputId);
      requireInput(file, request.toInputId);
      const now = this.now().toISOString();
      const relationId = relationIdOf(request.fromInputId, request.toInputId, request.kind);
      const existing = file.relations.find((relation) => relation.relationId === relationId);
      if (existing !== undefined) {
        return existing;
      }
      const relation: VersionRelation = {
        relationId,
        fromInputId: request.fromInputId,
        toInputId: request.toInputId,
        kind: request.kind,
        status: "candidate",
        basis: request.basis,
        ...(request.evidence !== undefined ? { evidence: request.evidence } : {}),
        proposedBy: request.proposedBy,
        createdAt: now,
        updatedAt: now,
      };
      file.relations.push(relation);
      return relation;
    });
  }

  /** 作者确认 / 拒绝关系（只由 AuthorDecision 应用层调用） */
  async applyRelationDecision(projectId: string, relationId: string, outcome: "confirmed" | "rejected", decisionId: string): Promise<VersionRelation> {
    return this.update(projectId, (file) => {
      const relation = file.relations.find((entry) => entry.relationId === relationId);
      if (relation === undefined) {
        throw new NotFoundError("版本关系", relationId);
      }
      const now = this.now().toISOString();
      relation.status = outcome;
      relation.basis = "author_decision";
      relation.decisionId = decisionId;
      relation.updatedAt = now;
      if (outcome === "confirmed" && relation.kind === "same_work") {
        mergeWorkGroups(file, relation.fromInputId, relation.toInputId, now);
      }
      return relation;
    });
  }

  async applyScopeDecision(projectId: string, inputId: string, scope: ResearchInputScope, decisionId: string): Promise<ResearchInput> {
    if (!RESEARCH_INPUT_SCOPES.includes(scope)) {
      throw new BusinessError("INVALID_REQUEST", `scope 只能是 ${RESEARCH_INPUT_SCOPES.join(" / ")}`);
    }
    return this.update(projectId, (file) => {
      const input = requireInput(file, inputId);
      const now = this.now().toISOString();
      input.scope = { status: scope, decisionId, updatedAt: now };
      input.updatedAt = now;
      return input;
    });
  }

  async applyVersionSelection(projectId: string, workId: string, preferredInputId: string, decisionId: string): Promise<WorkGroupState> {
    return this.update(projectId, (file) => {
      const group = file.workGroups.find((entry) => entry.workId === workId);
      if (group === undefined) {
        throw new NotFoundError("成果分组", workId);
      }
      if (!group.inputIds.includes(preferredInputId)) {
        throw new BusinessError("INVALID_REQUEST", `研究输入 ${preferredInputId} 不属于成果分组 ${workId}`);
      }
      group.preferredInputId = preferredInputId;
      group.decisionId = decisionId;
      group.updatedAt = this.now().toISOString();
      return group;
    });
  }

  async applyUnpublishedPolicy(projectId: string, inputId: string, allowed: boolean, decisionId: string, note?: string): Promise<ResearchInput> {
    return this.update(projectId, (file) => {
      const input = requireInput(file, inputId);
      input.unpublishedMaterialPolicy = { allowed, decisionId, ...(note !== undefined ? { note } : {}) };
      input.updatedAt = this.now().toISOString();
      return input;
    });
  }

  /** 对齐记录幂等合并（保留作者决定过的 basis / status） */
  async upsertAlignments(projectId: string, alignments: TableAlignment[]): Promise<TableAlignment[]> {
    return this.update(projectId, (file) => {
      for (const alignment of alignments) {
        const index = file.alignments.findIndex((entry) => entry.alignmentId === alignment.alignmentId);
        if (index < 0) {
          file.alignments.push(alignment);
          continue;
        }
        const existing = file.alignments[index]!;
        if (existing.basis === "author_decision") {
          continue;
        }
        file.alignments[index] = { ...alignment, createdAt: existing.createdAt };
      }
      return file.alignments;
    });
  }

  /**
   * M14.1c：候选表格对齐的作者裁决。确认 → comparable（进入冲突检测）；
   * 拒绝 → not_comparable（附拒绝理由）。决定绑定双方 contentHash：版本变化
   * 产生新 alignmentId，本决定不自动适用于新版本（作者须重新确认）。
   */
  async applyAlignmentDecision(
    projectId: string,
    alignmentId: string,
    outcome: "confirmed" | "rejected",
    decisionId: string,
    rationale?: string,
  ): Promise<TableAlignment> {
    return this.update(projectId, (file) => {
      const alignment = file.alignments.find((entry) => entry.alignmentId === alignmentId);
      if (alignment === undefined) {
        throw new NotFoundError("表格对齐", alignmentId);
      }
      const now = this.now().toISOString();
      alignment.basis = "author_decision";
      alignment.decisionId = decisionId;
      alignment.status = outcome === "confirmed" ? "comparable" : "not_comparable";
      if (outcome === "rejected") {
        alignment.evidence.rejectionReason = rationale ?? "作者拒绝候选对齐";
      } else {
        delete alignment.evidence.rejectionReason;
      }
      alignment.updatedAt = now;
      return alignment;
    });
  }
}

// ---- helpers ----

export function researchInputId(sourceId: string, contentHash: string): string {
  return `ri-${sha256Hex(`${sourceId}|${contentHash}`).slice(0, 12)}`;
}

export function relationIdOf(fromInputId: string, toInputId: string, kind: VersionRelationKind): string {
  const [a, b] = kind === "same_work" ? [fromInputId, toInputId].sort() : [fromInputId, toInputId];
  return `R${sha256Hex(`${a}|${b}|${kind}`).slice(0, 12)}`;
}

function emptyRegistry(now: string): ResearchInputRegistryFile {
  return { schemaVersion: 1, inputs: [], relations: [], workGroups: [], alignments: [], updatedAt: now };
}

function requireInput(file: ResearchInputRegistryFile, inputId: string): ResearchInput {
  const input = file.inputs.find((entry) => entry.inputId === inputId);
  if (input === undefined) {
    throw new NotFoundError("研究输入", inputId);
  }
  return input;
}

function upsertWorkGroup(file: ResearchInputRegistryFile, workId: string, inputId: string, now: string): void {
  const group = file.workGroups.find((entry) => entry.workId === workId);
  if (group === undefined) {
    file.workGroups.push({ workId, inputIds: [inputId], updatedAt: now });
  } else if (!group.inputIds.includes(inputId)) {
    group.inputIds.push(inputId);
    group.updatedAt = now;
  }
}

function mergeWorkGroups(file: ResearchInputRegistryFile, a: string, b: string, now: string): void {
  const inputA = requireInput(file, a);
  const inputB = requireInput(file, b);
  if (inputA.workId === inputB.workId) return;
  const target = inputA.workId;
  const sourceGroup = file.workGroups.find((entry) => entry.workId === inputB.workId);
  for (const input of file.inputs) {
    if (input.workId === inputB.workId) {
      input.workId = target;
      input.updatedAt = now;
      upsertWorkGroup(file, target, input.inputId, now);
    }
  }
  if (sourceGroup !== undefined) {
    file.workGroups = file.workGroups.filter((entry) => entry !== sourceGroup);
  }
}

function buildIdentifiers(request: RegisterResearchInputRequest, source: SourceItem): ResearchInputIdentifiers {
  const doi = (request.doi ?? source.metadata.doi)?.trim().toLowerCase().replace(/^https?:\/\/(dx\.)?doi\.org\//, "");
  const arxivRaw = request.arxivId ?? source.metadata.arxivId;
  const arxiv = arxivRaw !== undefined ? parseArxivId(arxivRaw) : undefined;
  return {
    ...(doi !== undefined && doi !== "" ? { doi } : {}),
    ...(arxiv !== undefined ? { arxivId: arxiv.id, ...(arxiv.version !== undefined ? { arxivVersion: arxiv.version } : {}) } : {}),
  };
}

export function parseArxivId(raw: string): { id: string; version?: number } | undefined {
  const match = /(?:arxiv:|abs\/|pdf\/)?(\d{4}\.\d{4,5}|[a-z-]+(?:\.[A-Z]{2})?\/\d{7})(?:v(\d+))?/i.exec(raw.trim());
  if (match === null) return undefined;
  return { id: match[1]!.toLowerCase(), ...(match[2] !== undefined ? { version: Number(match[2]) } : {}) };
}

/**
 * 确定性元数据关系：同 arXiv 基础 id / 同 DOI 且内容不同 → same_work 直接 confirmed
 * （这是来源记录的事实，不是模型推断）；只做这两条，标题相似不在此处。
 */
function proposeIdentifierRelations(file: ResearchInputRegistryFile, input: ResearchInput, now: string): VersionRelation[] {
  const created: VersionRelation[] = [];
  for (const other of file.inputs) {
    if (other.inputId === input.inputId) continue;
    let basis: RelationBasis | undefined;
    let evidence: string | undefined;
    if (input.identifiers.arxivId !== undefined && input.identifiers.arxivId === other.identifiers.arxivId) {
      basis = "arxiv_identifier";
      evidence = `同一 arXiv 记录 ${input.identifiers.arxivId}（v${other.identifiers.arxivVersion ?? "?"} / v${input.identifiers.arxivVersion ?? "?"}）`;
    } else if (input.identifiers.doi !== undefined && input.identifiers.doi === other.identifiers.doi) {
      basis = "doi_identifier";
      evidence = `同一 DOI ${input.identifiers.doi}`;
    }
    if (basis === undefined) continue;
    const relationId = relationIdOf(other.inputId, input.inputId, "same_work");
    if (file.relations.some((relation) => relation.relationId === relationId)) continue;
    const relation: VersionRelation = {
      relationId,
      fromInputId: other.inputId,
      toInputId: input.inputId,
      kind: "same_work",
      status: "confirmed",
      basis,
      evidence,
      proposedBy: "system",
      createdAt: now,
      updatedAt: now,
    };
    file.relations.push(relation);
    mergeWorkGroups(file, other.inputId, input.inputId, now);
    created.push(relation);
  }
  return created;
}

export function summarizeParse(source: SourceItem, document: ParsedDocument | null, now: string): ResearchInputParseSummary {
  if (source.fileName === undefined) {
    return { status: "metadata_only", notes: ["无原始文件"], checkedAt: now };
  }
  if (document === null) {
    return { status: "pending", notes: ["解析产物尚不存在（上传后后台解析 / 可手动触发）"], checkedAt: now };
  }
  if (document.contentHash !== "" && source.contentHash !== undefined && document.contentHash !== source.contentHash) {
    return { status: "pending", parser: document.parser.id, notes: ["解析产物对应旧内容版本，需重新解析"], checkedAt: now };
  }
  const tableCount = document.blocks.filter((block) => block.type === "table").length;
  const base = {
    parser: document.parser.id,
    parseMode: document.parseMode,
    ...(document.pageCount !== undefined ? { pageCount: document.pageCount } : {}),
    blockCount: document.blocks.length,
    tableCount,
    notes: [...document.notes],
    checkedAt: now,
  };
  if (document.status === "failed") {
    return { status: "failed", ...base };
  }
  if (document.status === "partial" || document.parseMode === "text_only") {
    return { status: "partial", ...base, notes: [...base.notes, document.parseMode === "text_only" ? "仅文本层（无表格结构）" : "parser 自报不完整"] };
  }
  return { status: "full_text", ...base };
}
