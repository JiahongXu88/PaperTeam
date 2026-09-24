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
 * 可靠性（M8.5 P0，M8 真实验收的 save_candidates 并发损坏修复）：
 * - 所有读-改-写（add / markAccepted / markRejected / remove）经**项目级
 *   promise 链互斥**串行执行（与 ProjectStore.mutate 同款），后到者基于前者
 *   的落盘结果计算——并发保存不再互相覆盖（丢更新）或交织写坏 JSON；
 * - 落盘仍走 writeJsonAtomic（tmp 名带单调序号，同毫秒并发不碰撞）；
 * - 读取损坏的 candidates.json 抛结构化 CANDIDATE_STORE_CORRUPTED（500），
 *   绝不静默返回空——「数据损坏」与「没有候选论文」是两种必须区分的事实；
 * - 每次写成功后清理崩溃残留的同名 tmp 文件（互斥保证此刻无在途写者）。
 *
 * 生命周期：pending_review → accepted（promote 成功）| rejected（用户否决）；
 * 删除 candidate 不影响已入库的正式 Source（引用方向只有 candidate → source）。
 */

import { readdir, readFile, rm } from "node:fs/promises";
import { basename, dirname, join } from "node:path";

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
  /**
   * 该候选供给的预写证据需求 id（M9.9 Phase 4 provenance：从需求供给检索的
   * 执行快照保存时由服务端记录——与 query 同为扁平 provenance 字段，不复制
   * 需求元数据；同身份合并时只填空缺。普通检索 / 手动添加无此字段）。
   */
  requirementId?: string;
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
  /** 供给的需求 id（M9.9 provenance；同身份合并时只填空缺） */
  requirementId?: string;
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
  /**
   * 项目级写互斥（promise 链，M8.5 P0）：同一项目的全部读-改-写排队执行，
   * 后到者基于前者的落盘结果计算（与 ProjectStore.writeQueues 同款）。
   * 单实例约束：CandidateStore 在 serviceStack 内单例装配，进程内所有写入方
   * （HTTP / save_candidates 工具 / 测试）共享同一互斥。
   */
  private readonly writeQueues = new Map<string, Promise<unknown>>();

  constructor(projects: ProjectStore, options: CandidateStoreOptions = {}) {
    this.projects = projects;
    this.now = options.now ?? (() => new Date());
  }

  private indexPath(projectId: string): string {
    return join(this.projects.sourcesDir(projectId), "candidates.json");
  }

  /**
   * 把操作排进项目写队列（串行化读-改-写）。前序任务失败不阻塞后继
   * （.catch(() => {}) 吞掉的是链上残留的 rejection，操作自身的错误原样
   * 返回给调用方）。
   */
  private enqueue<T>(projectId: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.writeQueues.get(projectId) ?? Promise.resolve();
    const task = previous.catch(() => {}).then(operation);
    this.writeQueues.set(projectId, task);
    const cleanup = () => {
      if (this.writeQueues.get(projectId) === task) {
        this.writeQueues.delete(projectId);
      }
    };
    task.then(cleanup, cleanup);
    return task;
  }

  /**
   * 添加候选。同项目内同身份的 **pending_review** 候选只保留一条：后来的
   * 发现补充其空缺字段（snippet / venue 等），返回该候选（created=false）。
   * accepted / rejected 的历史候选不参与判重——同一文献被拒绝后再次发现
   * 是合法场景（用户可改判）；已入库的判重在 promotion 时执行。
   * 整个读-改-写在项目互斥内执行：并发 add 不丢更新、不交织写坏 JSON。
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
    return this.enqueue(projectId, async () => {
      const candidates = await this.list(projectId);
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
            ...(input.requirementId !== undefined ? { requirementId: input.requirementId } : {}),
          }),
          updatedAt: this.now().toISOString(),
        };
        const next = candidates.map((candidate) =>
          candidate.candidateId === merged.candidateId ? merged : candidate,
        );
        await this.save(projectId, next);
        return { candidate: merged, created: false };
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
        ...(input.requirementId !== undefined && input.requirementId.trim() !== ""
          ? { requirementId: input.requirementId.trim() }
          : {}),
        status: "pending_review",
        createdAt: timestamp,
        updatedAt: timestamp,
      };
      await this.save(projectId, [...candidates, candidate]);
      return { candidate, created: true };
    });
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

  /**
   * 读取候选清单。文件不存在（还没保存过候选）= 空列表；文件存在但损坏
   * （非法 JSON / 缺 items）= 结构化 CANDIDATE_STORE_CORRUPTED——绝不静默
   * 返回空，「数据损坏」与「没有候选论文」必须可区分（M8.5）。
   */
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
      throw candidateStoreCorrupted(
        projectId,
        "不是合法 JSON（疑似并发写残留或外部改动）",
      );
    }
    const items = (parsed as { items?: unknown } | null)?.items;
    if (!Array.isArray(items)) {
      throw candidateStoreCorrupted(projectId, "缺少 items 数组（结构不完整）");
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

  /** promotion 成功后标记（幂等：重复标记同一 source 返回原样；整段在互斥内） */
  async markAccepted(
    projectId: string,
    candidateId: string,
    promotedSourceId: string,
  ): Promise<CandidateSource> {
    return this.enqueue(projectId, async () => {
      const candidate = await this.getRequired(projectId, candidateId);
      if (candidate.status === "accepted" && candidate.promotedSourceId === promotedSourceId) {
        return candidate;
      }
      return this.patch(projectId, candidate, {
        status: "accepted",
        promotedSourceId,
      });
    });
  }

  /** 用户否决（幂等；整段在互斥内） */
  async markRejected(projectId: string, candidateId: string): Promise<CandidateSource> {
    return this.enqueue(projectId, async () => {
      const candidate = await this.getRequired(projectId, candidateId);
      if (candidate.status === "rejected") {
        return candidate;
      }
      return this.patch(projectId, candidate, { status: "rejected" });
    });
  }

  /** 删除候选（只影响 candidates.json；已入库的正式 Source 不受影响；互斥内执行） */
  async remove(projectId: string, candidateId: string): Promise<void> {
    return this.enqueue(projectId, async () => {
      const candidates = await this.list(projectId);
      if (!candidates.some((candidate) => candidate.candidateId === candidateId)) {
        throw new NotFoundError("候选文献", candidateId);
      }
      await this.save(
        projectId,
        candidates.filter((candidate) => candidate.candidateId !== candidateId),
      );
    });
  }

  private async patch(
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
    const filePath = this.indexPath(projectId);
    await writeJsonAtomic(filePath, { items: candidates });
    // 崩溃残留的 tmp 清理（M8.5）：互斥保证此刻没有同文件在途写者，目录内
    // 剩下的 `.<name>.<pid>-<ts>-<seq>.tmp` 只能是历史进程异常退出的残留。
    // best-effort——清理失败不影响写成功的事实。
    await cleanupStaleTempFiles(filePath).catch(() => {});
  }
}

/** `.<basename>.<pid>-<ts>-<seq>.tmp` 形态的崩溃残留（writeFileAtomic 的命名约定） */
function tempFilePattern(sourceName: string): RegExp {
  const escaped = sourceName.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  return new RegExp(`^\\.${escaped}\\.[0-9]+-[0-9]+-[0-9]+\\.tmp$`);
}

async function cleanupStaleTempFiles(filePath: string): Promise<void> {
  const dir = dirname(filePath);
  const pattern = tempFilePattern(basename(filePath));
  const entries = await readdir(dir);
  await Promise.all(
    entries
      .filter((entry) => pattern.test(entry))
      .map((entry) => rm(join(dir, entry), { force: true }).catch(() => {})),
  );
}

/**
 * 损坏索引的结构化错误（CANDIDATE_STORE_CORRUPTED / 500）：用户看到的是
 * 「数据损坏 + 恢复指引」，而不是「没有候选论文」或笼统的内部错误。
 */
function candidateStoreCorrupted(projectId: string, reason: string): BusinessError {
  return new BusinessError(
    "CANDIDATE_STORE_CORRUPTED",
    `候选文献数据损坏（${projectId}/sources/candidates.json ${reason}）：这不是「没有候选论文」，` +
      `而是存储文件本身不可读。请检查同目录是否有历史备份（如 candidates.json.corrupted-backup），` +
      `或手工修复该 JSON 后重试；修复前的写入会被拒绝，不会覆盖现场。`,
    reason,
  );
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
      | "requirementId"
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
