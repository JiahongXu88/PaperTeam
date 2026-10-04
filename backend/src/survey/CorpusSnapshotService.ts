/**
 * Research Corpus Snapshot（M11.3 Phase C）。
 *
 * 产品语义（§13–§19）：
 * - 第一次 survey.fulltext 完成后形成 Research Corpus Snapshot——研究语料
 *   的冻结基线（selected 源集合 + 全文状态 + matrix 消费的解释深度）；
 * - 后续普通 resume 消费冻结快照：不再重试全文解析（昨天 not_found 的源
 *   今天网络好了也不自动补齐——resume ≠ refresh corpus，跨网络条件的
 *   resume 不得改变已冻结 Research Basis）；
 * - 显式 refresh_missing_fulltext 才允许补齐：形成新的 corpus revision /
 *   fingerprint，并失效 matrix 中可升级条目（abstract_only 源已有全文 →
 *   重建），Matrix → Synthesis → Outline 的既有 staleness 链（matrix
 *   fingerprint）随之传播——语料变而 matrix 指纹不变是被禁止的（§18）。
 *
 * 快照逐源记录两个独立事实：
 * - hasFulltext：磁盘事实（sources/papers 文件在库）；
 * - basisDepth：研究基线事实（matrix 条目的 interpretationDepth）——两者
 *   可以不同（老项目在快照特性上线前磁盘已漂移、matrix 仍按原基线）。
 *   冻结语义作用于研究基线：普通 resume 不改变 basisDepth 消费的条目。
 *
 * 持久化纪律与 SurveyMatrixArtifactStore 同源：原子写、确定性序列化
 * （sources 按 sourceId 升序）、读容错区分「没有快照」与「快照损坏」
 * （CORPUS_SNAPSHOT_CORRUPTED，fail-closed）。
 */

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { BusinessError } from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { writeJsonAtomic } from "../util/atomic.js";
import type { InterpretationDepth, SurveyMatrixArtifact } from "./matrixTypes.js";

const CORPUS_SNAPSHOT_SCHEMA_VERSION = 1 as const;

/** 与 survey.fulltext / buildMatrix 同源的语料资格口径 */
export interface CorpusSourceLike {
  sourceId: string;
  sourceRole: string;
  status: string;
  fileName?: string;
}

export interface CorpusSnapshotSourceRow {
  sourceId: string;
  /** SourceStore status（快照时刻） */
  status: string;
  /** 磁盘事实：全文文件在库（fileName 存在且非 metadata_only） */
  hasFulltext: boolean;
  /** 研究基线事实：matrix 条目的 interpretationDepth；null = matrix 未构建 */
  basisDepth: InterpretationDepth | null;
}

export interface CorpusSnapshotArtifact {
  schemaVersion: typeof CORPUS_SNAPSHOT_SCHEMA_VERSION;
  /** 0 = 首次冻结；每次显式 refresh +1 */
  revision: number;
  createdAt: string;
  updatedAt: string;
  /** sha256(sourceId|hasFulltext|basisDepth 行序列)——基线内容的确定性指纹 */
  fingerprint: string;
  counts: {
    total: number;
    hasFulltext: number;
    fulltextBasis: number;
    abstractBasis: number;
  };
  sources: CorpusSnapshotSourceRow[];
}

export interface CorpusRefreshOutcome {
  /** 本次尝试补齐的源数（快照中无全文的） */
  attempted: number;
  /** 补齐成功（现在有全文文件） */
  resolved: number;
  /** 仍不可得（not_found / failed 维持冻结语义，可再次 refresh） */
  stillMissing: number;
  /** 被失效的 matrix 条目（basisDepth 可升级 → 下次构建重建） */
  invalidatedMatrixEntries: number;
  /** 新语料修订号 */
  revision: number;
  /** 新指纹（与旧指纹相同 = 语料实质未变） */
  fingerprint: string;
  fingerprintChanged: boolean;
}

export interface CorpusSnapshotDeps {
  projects: ProjectStore;
  /** SourceStore.list（快照行 / refresh 目标集） */
  listSources: (projectId: string) => Promise<CorpusSourceLike[]>;
  /** 全文补解析（refresh 专用；resume 路径不调用） */
  resolveFullTextBatch: (
    projectId: string,
    sourceIds: string[],
    options?: { signal?: AbortSignal },
  ) => Promise<{ summary: { resolved: number; notFound: number; failed: number; notResolvable: number; skipped: number } }>;
  /** 新解析全文的结构化解析（matrix fulltext 锚定前提） */
  ingest: (projectId: string, sourceId: string) => Promise<unknown>;
  /** matrix 可升级条目失效（refresh 专用） */
  invalidateUpgradableMatrixEntries: (projectId: string) => Promise<number>;
  now?: () => Date;
  log?: (message: string) => void;
}

export function isCorpusEligible(source: CorpusSourceLike): boolean {
  return source.sourceRole !== "reference" && source.status !== "rejected";
}

/** 快照内容指纹（不含时间戳 / revision——同基线恒同指纹） */
export function corpusFingerprint(rows: readonly CorpusSnapshotSourceRow[]): string {
  const serialized = rows
    .map((row) => `${row.sourceId}|${row.hasFulltext ? 1 : 0}|${row.basisDepth ?? "-"}`)
    .sort()
    .join("\n");
  return createHash("sha256").update(serialized).digest("hex").slice(0, 16);
}

/** 从源清单 + 既有 matrix 派生快照行（确定性；matrix 缺席 = basisDepth null） */
export function buildCorpusRows(
  sources: readonly CorpusSourceLike[],
  matrix: SurveyMatrixArtifact | null,
): CorpusSnapshotSourceRow[] {
  const depthBySource = new Map(matrix?.entries.map((entry) => [entry.sourceId, entry.interpretationDepth]) ?? []);
  return sources
    .filter(isCorpusEligible)
    .map((source) => ({
      sourceId: source.sourceId,
      status: source.status,
      hasFulltext: source.fileName !== undefined && source.fileName !== "" && source.status !== "metadata_only",
      basisDepth: depthBySource.get(source.sourceId) ?? null,
    }))
    .sort((a, b) => a.sourceId.localeCompare(b.sourceId));
}

function corpusCounts(rows: readonly CorpusSnapshotSourceRow[]): CorpusSnapshotArtifact["counts"] {
  return {
    total: rows.length,
    hasFulltext: rows.filter((row) => row.hasFulltext).length,
    fulltextBasis: rows.filter((row) => row.basisDepth === "fulltext").length,
    abstractBasis: rows.filter((row) => row.basisDepth === "abstract_only").length,
  };
}

export class CorpusSnapshotService {
  private readonly deps: CorpusSnapshotDeps;

  constructor(deps: CorpusSnapshotDeps) {
    this.deps = deps;
    this.now = deps.now ?? (() => new Date());
    this.log = deps.log ?? (() => {});
  }

  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  private artifactPath(projectId: string): string {
    return join(this.deps.projects.researchDir(projectId), "corpus-snapshot.json");
  }

  /** 读快照；未冻结 → null；损坏 / 未来版本 → CORPUS_SNAPSHOT_CORRUPTED */
  async get(projectId: string): Promise<CorpusSnapshotArtifact | null> {
    let raw: string;
    try {
      raw = await readFile(this.artifactPath(projectId), "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw corpusSnapshotCorrupted(projectId, "不是合法 JSON");
    }
    const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
    if (record === null || !Array.isArray(record["sources"])) {
      throw corpusSnapshotCorrupted(projectId, "缺少 sources 数组");
    }
    if (record["schemaVersion"] !== CORPUS_SNAPSHOT_SCHEMA_VERSION) {
      throw corpusSnapshotCorrupted(projectId, `不支持的 schemaVersion=${String(record["schemaVersion"])}`);
    }
    const rows: CorpusSnapshotSourceRow[] = [];
    for (const entry of record["sources"]) {
      if (
        typeof entry === "object" &&
        entry !== null &&
        typeof (entry as Record<string, unknown>)["sourceId"] === "string" &&
        typeof (entry as Record<string, unknown>)["hasFulltext"] === "boolean"
      ) {
        const row = entry as Record<string, unknown>;
        rows.push({
          sourceId: row["sourceId"] as string,
          status: typeof row["status"] === "string" ? row["status"] : "",
          hasFulltext: row["hasFulltext"] as boolean,
          basisDepth:
            row["basisDepth"] === "fulltext" || row["basisDepth"] === "abstract_only"
              ? (row["basisDepth"] as InterpretationDepth)
              : null,
        });
      }
    }
    return {
      schemaVersion: CORPUS_SNAPSHOT_SCHEMA_VERSION,
      revision: typeof record["revision"] === "number" ? record["revision"] : 0,
      createdAt: typeof record["createdAt"] === "string" ? record["createdAt"] : "",
      updatedAt: typeof record["updatedAt"] === "string" ? record["updatedAt"] : "",
      fingerprint: typeof record["fingerprint"] === "string" ? record["fingerprint"] : corpusFingerprint(rows),
      counts: corpusCounts(rows),
      sources: rows.sort((a, b) => a.sourceId.localeCompare(b.sourceId)),
    };
  }

  /**
   * 首次冻结（幂等：已存在 → 原样返回，不重写）。调用时机 = survey.fulltext
   * 完成后（matrix 可能尚未构建——basisDepth=null，matrix 阶段会 sync）。
   */
  async freeze(
    projectId: string,
    input: { matrix: SurveyMatrixArtifact | null },
  ): Promise<CorpusSnapshotArtifact> {
    const existing = await this.get(projectId);
    if (existing !== null) {
      return existing;
    }
    const sources = await this.deps.listSources(projectId);
    const rows = buildCorpusRows(sources, input.matrix);
    const artifact: CorpusSnapshotArtifact = {
      schemaVersion: CORPUS_SNAPSHOT_SCHEMA_VERSION,
      revision: 0,
      createdAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
      fingerprint: corpusFingerprint(rows),
      counts: corpusCounts(rows),
      sources: rows,
    };
    await writeJsonAtomic(this.artifactPath(projectId), artifact);
    this.log(
      `[corpus] projectId=${projectId} 冻结研究语料：revision=0 sources=${rows.length} fulltextDisk=${artifact.counts.hasFulltext} fulltextBasis=${artifact.counts.fulltextBasis} fingerprint=${artifact.fingerprint}`,
    );
    return artifact;
  }

  /**
   * matrix 构建后的基线同步：basisDepth 跟随 matrix 条目（普通 resume 的
   * skip-existing 不会改变它；refresh 后的重建会——指纹随之变化，revision
   * 不动：这不是新的语料修订，是既有修订的下游对齐）。
   */
  async syncBasisDepth(
    projectId: string,
    matrix: SurveyMatrixArtifact,
  ): Promise<CorpusSnapshotArtifact | null> {
    const existing = await this.get(projectId);
    if (existing === null) {
      return null;
    }
    const sources = await this.deps.listSources(projectId);
    const rows = buildCorpusRows(sources, matrix);
    const fingerprint = corpusFingerprint(rows);
    if (fingerprint === existing.fingerprint) {
      return existing;
    }
    const artifact: CorpusSnapshotArtifact = {
      ...existing,
      updatedAt: this.now().toISOString(),
      fingerprint,
      counts: corpusCounts(rows),
      sources: rows,
    };
    await writeJsonAtomic(this.artifactPath(projectId), artifact);
    this.log(`[corpus] projectId=${projectId} 基线深度同步：fingerprint=${fingerprint}`);
    return artifact;
  }

  /**
   * 显式补齐缺失全文（resume 的对立面；§17 refresh_missing_fulltext）：
   * 1. 只处理快照中无全文文件的源（resolveFullTextBatch）；
   * 2. 新解析的源做结构化解析（matrix fulltext 锚定前提）；
   * 3. 失效 matrix 可升级条目（下次构建重建 → 指纹变化 → Synthesis /
   *    Outline 按既有 staleness 链重算）；
   * 4. 快照 revision+1、指纹重算——语料变了指纹必须变（§18）。
   * 未冻结语料 → INVALID_REQUEST（先跑一次 survey.fulltext 形成基线）。
   */
  async refresh(projectId: string, options: { signal?: AbortSignal } = {}): Promise<CorpusRefreshOutcome> {
    const existing = await this.get(projectId);
    if (existing === null) {
      throw new BusinessError(
        "INVALID_REQUEST",
        "研究语料尚未冻结（无 corpus-snapshot.json）；先完成一次 survey.fulltext 形成基线",
      );
    }
    const missing = existing.sources.filter((row) => !row.hasFulltext).map((row) => row.sourceId);
    let resolved = 0;
    let stillMissing = 0;
    if (missing.length > 0) {
      const batch = await this.deps.resolveFullTextBatch(projectId, missing, {
        ...(options.signal !== undefined ? { signal: options.signal } : {}),
      });
      resolved = batch.summary.resolved;
      stillMissing = missing.length - resolved;
      // 新解析的源：结构化解析（失败是数据不是异常，计入 stillMissing 之外如实呈现）
      const after = new Map((await this.deps.listSources(projectId)).map((source) => [source.sourceId, source]));
      for (const sourceId of missing) {
        const source = after.get(sourceId);
        if (source !== undefined && source.fileName !== undefined && source.fileName !== "") {
          try {
            await this.deps.ingest(projectId, sourceId);
          } catch {
            this.log(`[corpus] projectId=${projectId} ${sourceId} 结构化解析失败（保留磁盘全文，下次构建按可解析深度降级）`);
          }
        }
      }
    }
    const invalidatedMatrixEntries = await this.deps.invalidateUpgradableMatrixEntries(projectId);
    const sources = await this.deps.listSources(projectId);
    const byId = new Map(existing.sources.map((row) => [row.sourceId, row]));
    const rows: CorpusSnapshotSourceRow[] = buildCorpusRows(sources, null).map((row) => ({
      ...row,
      basisDepth: byId.get(row.sourceId)?.basisDepth ?? null,
    }));
    const fingerprint = corpusFingerprint(rows);
    const artifact: CorpusSnapshotArtifact = {
      ...existing,
      revision: existing.revision + 1,
      updatedAt: this.now().toISOString(),
      fingerprint,
      counts: corpusCounts(rows),
      sources: rows,
    };
    await writeJsonAtomic(this.artifactPath(projectId), artifact);
    this.log(
      `[corpus] projectId=${projectId} 显式补齐：attempted=${missing.length} resolved=${resolved} stillMissing=${stillMissing} invalidatedMatrix=${invalidatedMatrixEntries} revision=${artifact.revision} fingerprint=${fingerprint}${fingerprint === existing.fingerprint ? "（未变）" : ""}`,
    );
    return {
      attempted: missing.length,
      resolved,
      stillMissing,
      invalidatedMatrixEntries,
      revision: artifact.revision,
      fingerprint,
      fingerprintChanged: fingerprint !== existing.fingerprint,
    };
  }
}

function corpusSnapshotCorrupted(projectId: string, detail: string): BusinessError {
  return new BusinessError(
    "CORPUS_SNAPSHOT_CORRUPTED",
    `项目 ${projectId} 的 corpus-snapshot.json 损坏（${detail}）——拒绝降级解读，请人工核查或删除后重新冻结`,
  );
}
