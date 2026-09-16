/**
 * CandidateStore：Discovery 候选文献（D-0033 / M6.1 ADR §3 §5）。
 *
 * 语义边界（与 SourceStore 严格分离）：
 * - CandidateSource 是「发现到了一个可能有价值的资料」的 **Discovery State**
 *   ——候选清单本身是事实（谁在何时发现了什么），但候选 ≠ 正式文献 ≠
 *   Evidence ≠ verified source；
 * - 持久化于 sources/candidates.json（与 authoritative 的 sources/index.json
 *   分文件存放）；正式入库（promotion）后写入 SourceStore，candidate 只保留
 *   状态标记与指向（promotedSourceId），不承载文献事实；
 * - M6.3 起 ResearchDiscoveryService 将批量写入候选（origin=academic_search /
 *   web_search）；M6.2 的写入方是用户手动添加（origin=manual）与测试。
 *
 * 生命周期：pending_review → accepted（promote 成功）| rejected（用户否决）；
 * 删除 candidate 不影响已入库的正式 Source（引用方向只有 candidate → source）。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { BusinessError, NotFoundError } from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { writeJsonAtomic } from "../util/atomic.js";
import { buildIdentity, identityKey, type SourceIdentity } from "./identity.js";

export type CandidateStatus = "pending_review" | "accepted" | "rejected";
export type CandidateOrigin = "academic_search" | "web_search" | "manual";

export interface CandidateSource {
  candidateId: string;
  /** 归一化身份（与 SourceItem.identity 同构；判等键见 identity.ts） */
  identity: SourceIdentity;
  origin: CandidateOrigin;
  /** 发现方（openalex / searxng / manual / …） */
  provider: string;
  /** 展示与 promotion 用的原始元数据（未归一；入库时经 metadata merge） */
  title?: string;
  authors?: string[];
  year?: number;
  venue?: string;
  doi?: string;
  arxivId?: string;
  url?: string;
  snippetOrAbstract?: string;
  /** 发现该候选的检索词（M6.3 discovery provenance；manual 添加无此字段） */
  query?: string;
  status: CandidateStatus;
  /** promotion 后指向正式 Source（幂等重入依据；source 被删后可重新 promote） */
  promotedSourceId?: string;
  createdAt: string;
  updatedAt: string;
}

export interface AddCandidateInput {
  /** 已归一化身份（推荐：调用方经 buildIdentity 构建）或原始字段（内部归一） */
  identity?: SourceIdentity | null;
  doi?: string;
  arxivId?: string;
  url?: string;
  title?: string;
  authors?: string[];
  year?: number;
  venue?: string;
  snippetOrAbstract?: string;
  /** 发现时的检索词（provenance；同身份合并时只填空缺） */
  query?: string;
  origin?: CandidateOrigin;
  provider?: string;
}

export interface CandidateAddResult {
  candidate: CandidateSource;
  /** false = 已存在同身份 pending 候选，已合并补充其空缺字段并返回该候选 */
  created: boolean;
}

export interface CandidateStoreOptions {
  now?: () => Date;
}

const CANDIDATE_STATUSES: readonly CandidateStatus[] = [
  "pending_review",
  "accepted",
  "rejected",
];

export class CandidateStore {
  private readonly projects: ProjectStore;
  private readonly now: () => Date;

  constructor(projects: ProjectStore, options: CandidateStoreOptions = {}) {
    this.projects = projects;
    this.now = options.now ?? (() => new Date());
  }

  private indexPath(projectId: string): string {
    return join(this.projects.sourcesDir(projectId), "candidates.json");
  }

  /**
   * 添加候选。同项目内同身份的 **pending_review** 候选只保留一条：后来的
   * 发现补充其空缺字段（snippet / venue 等），返回该候选（created=false）。
   * accepted / rejected 的历史候选不参与判重——同一文献被拒绝后再次发现
   * 是合法场景（用户可改判）；已入库的判重在 promotion 时执行。
   */
  async add(projectId: string, input: AddCandidateInput): Promise<CandidateAddResult> {
    const identity =
      input.identity !== undefined && input.identity !== null
        ? input.identity
        : buildIdentity({
            ...(input.doi !== undefined ? { doi: input.doi } : {}),
            ...(input.arxivId !== undefined ? { arxivId: input.arxivId } : {}),
            ...(input.url !== undefined ? { url: input.url } : {}),
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.authors !== undefined ? { authors: input.authors } : {}),
            ...(input.year !== undefined ? { year: input.year } : {}),
          });
    if (identity === null) {
      throw new BusinessError(
        "INVALID_REQUEST",
        "候选文献缺少可判等身份（DOI / arXiv ID / URL / 标题+年份+一作 至少其一）",
      );
    }
    const key = identityKey(identity);
    if (key === undefined) {
      throw new BusinessError(
        "INVALID_REQUEST",
        "候选文献身份缺少可判等键（仅标题不构成身份：需要 DOI / arXiv ID / URL / 标题+年份+一作）",
      );
    }
    const candidates = await this.list(projectId);
    if (key !== undefined) {
      const existing = candidates.find(
        (candidate) =>
          candidate.status === "pending_review" &&
          identityKey(candidate.identity) === key,
      );
      if (existing !== undefined) {
        const merged: CandidateSource = {
          ...existing,
          ...fillEmpty(existing, {
            ...(input.title !== undefined ? { title: input.title } : {}),
            ...(input.authors !== undefined ? { authors: input.authors } : {}),
            ...(input.year !== undefined ? { year: input.year } : {}),
            ...(input.venue !== undefined ? { venue: input.venue } : {}),
            ...(input.doi !== undefined ? { doi: input.doi } : {}),
            ...(input.arxivId !== undefined ? { arxivId: input.arxivId } : {}),
            ...(input.url !== undefined ? { url: input.url } : {}),
            ...(input.snippetOrAbstract !== undefined
              ? { snippetOrAbstract: input.snippetOrAbstract }
              : {}),
            ...(input.query !== undefined ? { query: input.query } : {}),
          }),
          updatedAt: this.now().toISOString(),
        };
        const next = candidates.map((candidate) =>
          candidate.candidateId === merged.candidateId ? merged : candidate,
        );
        await this.save(projectId, next);
        return { candidate: merged, created: false };
      }
    }
    const candidateId = this.nextId(candidates);
    const timestamp = this.now().toISOString();
    const candidate: CandidateSource = {
      candidateId,
      identity,
      origin: input.origin ?? "manual",
      provider: input.provider ?? "manual",
      ...(input.title !== undefined && input.title.trim() !== "" ? { title: input.title.trim() } : {}),
      ...(input.authors !== undefined && input.authors.length > 0
        ? { authors: input.authors.slice(0, 20) }
        : {}),
      ...(typeof input.year === "number" && Number.isInteger(input.year) ? { year: input.year } : {}),
      ...(input.venue !== undefined && input.venue.trim() !== ""
        ? { venue: input.venue.trim().slice(0, 200) }
        : {}),
      ...(input.doi !== undefined && input.doi.trim() !== "" ? { doi: input.doi.trim() } : {}),
      ...(input.arxivId !== undefined && input.arxivId.trim() !== ""
        ? { arxivId: input.arxivId.trim() }
        : {}),
      ...(input.url !== undefined && input.url.trim() !== ""
        ? { url: input.url.trim().slice(0, 1000) }
        : {}),
      ...(input.snippetOrAbstract !== undefined && input.snippetOrAbstract.trim() !== ""
        ? { snippetOrAbstract: input.snippetOrAbstract.trim().slice(0, 3000) }
        : {}),
      ...(input.query !== undefined && input.query.trim() !== "" ? { query: input.query.trim() } : {}),
      status: "pending_review",
      createdAt: timestamp,
      updatedAt: timestamp,
    };
    await this.save(projectId, [...candidates, candidate]);
    return { candidate, created: true };
  }

  async get(projectId: string, candidateId: string): Promise<CandidateSource | null> {
    const candidates = await this.list(projectId);
    return candidates.find((candidate) => candidate.candidateId === candidateId) ?? null;
  }

  async getRequired(projectId: string, candidateId: string): Promise<CandidateSource> {
    const candidate = await this.get(projectId, candidateId);
    if (candidate === null) {
      throw new NotFoundError("候选文献", candidateId);
    }
    return candidate;
  }

  async list(projectId: string, status?: CandidateStatus): Promise<CandidateSource[]> {
    let raw: string;
    try {
      raw = await readFile(this.indexPath(projectId), "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return [];
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BusinessError(
        "INTERNAL_ERROR",
        `候选文献索引损坏（${projectId}/sources/candidates.json 不是合法 JSON）`,
      );
    }
    const items = (parsed as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) {
      throw new BusinessError(
        "INTERNAL_ERROR",
        `候选文献索引损坏（${projectId}/sources/candidates.json 缺少 items）`,
      );
    }
    const candidates = items.filter(
      (item): item is CandidateSource =>
        typeof item === "object" &&
        item !== null &&
        typeof (item as CandidateSource).candidateId === "string" &&
        typeof (item as CandidateSource).identity === "object" &&
        CANDIDATE_STATUSES.includes((item as CandidateSource).status),
    );
    return status === undefined ? candidates : candidates.filter((c) => c.status === status);
  }

  /** promotion 成功后标记（幂等：重复标记同一 source 返回原样） */
  async markAccepted(
    projectId: string,
    candidateId: string,
    promotedSourceId: string,
  ): Promise<CandidateSource> {
    const candidate = await this.getRequired(projectId, candidateId);
    if (candidate.status === "accepted" && candidate.promotedSourceId === promotedSourceId) {
      return candidate;
    }
    return this.patch(projectId, candidate, {
      status: "accepted",
      promotedSourceId,
    });
  }

  /** 用户否决（幂等） */
  async markRejected(projectId: string, candidateId: string): Promise<CandidateSource> {
    const candidate = await this.getRequired(projectId, candidateId);
    if (candidate.status === "rejected") {
      return candidate;
    }
    return this.patch(projectId, candidate, { status: "rejected" });
  }

  /** 删除候选（只影响 candidates.json；已入库的正式 Source 不受影响） */
  async remove(projectId: string, candidateId: string): Promise<void> {
    const candidates = await this.list(projectId);
    if (!candidates.some((candidate) => candidate.candidateId === candidateId)) {
      throw new NotFoundError("候选文献", candidateId);
    }
    await this.save(
      projectId,
      candidates.filter((candidate) => candidate.candidateId !== candidateId),
    );
  }

  private patch(
    projectId: string,
    candidate: CandidateSource,
    patch: Partial<Pick<CandidateSource, "status" | "promotedSourceId">>,
  ): Promise<CandidateSource> {
    const updated: CandidateSource = {
      ...candidate,
      ...patch,
      updatedAt: this.now().toISOString(),
    };
    return this.saveUpdated(projectId, updated);
  }

  private async saveUpdated(
    projectId: string,
    updated: CandidateSource,
  ): Promise<CandidateSource> {
    const candidates = await this.list(projectId);
    await this.save(
      projectId,
      candidates.map((candidate) =>
        candidate.candidateId === updated.candidateId ? updated : candidate,
      ),
    );
    return updated;
  }

  private nextId(candidates: CandidateSource[]): string {
    const maxId = candidates.reduce((max, candidate) => {
      const match = /^C(\d+)$/.exec(candidate.candidateId);
      return match !== null ? Math.max(max, Number(match[1])) : max;
    }, 0);
    return `C${String(maxId + 1).padStart(3, "0")}`;
  }

  private async save(projectId: string, candidates: CandidateSource[]): Promise<void> {
    await this.projects.sourcesDir(projectId); // projectId 合法性校验
    await writeJsonAtomic(this.indexPath(projectId), { items: candidates });
  }
}

/** 只填充 existing 缺省的顶层字段（候选发现方多次上报时信息只增不减） */
function fillEmpty(
  existing: CandidateSource,
  incoming: Partial<
    Pick<
      CandidateSource,
      | "title"
      | "authors"
      | "year"
      | "venue"
      | "doi"
      | "arxivId"
      | "url"
      | "snippetOrAbstract"
      | "query"
    >
  >,
): CandidateSource {
  const out = { ...existing };
  for (const [key, value] of Object.entries(incoming)) {
    if (value === undefined || value === "") {
      continue;
    }
    const current = (out as Record<string, unknown>)[key];
    if (current === undefined || current === "" || (Array.isArray(current) && current.length === 0)) {
      (out as Record<string, unknown>)[key] = value;
    }
  }
  return out;
}
