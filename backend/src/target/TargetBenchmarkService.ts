/**
 * TargetBenchmarkService：benchmark 语料冻结 / refresh / 调整（M12.1 A5+A6）。
 *
 * revision 模式照抄 CorpusSnapshotService（M11.3 Phase C 的冻结纪律）：
 * - freeze 幂等：已存在 → 原样返回，不重写（resume ≠ refresh——普通流程
 *   不得改写已冻结参照系；profile/readiness 消费的稳定性前提）；
 * - refresh 显式：重算行集合 → revision+1、指纹重算（语料变指纹必变）；
 * - exclude：同 revision 内把条目标 excluded（M12.0 §4.3 schema 字段）。
 *   指纹把 excluded 纳入行序列（有效语料变了指纹必须变，否则下游
 *   profile 的 freshness 键失真）；revision 不动——这是「修订内的剔除标记」
 *   而非新语料修订（与任务书 M12.1 A5 的显式指令一致）；
 * - addPaper：追加新 sourceId 进冻结集合 → refresh 语义 revision+1；
 * - confirm：幂等 no-op 语义——首次写入 confirmedAt（HITL 确认是审计事实，
 *   值得落盘：后续 workflow 据此区分「自动冻结」与「作者已确认」；重复
 *   confirm 不改时间戳不 bump revision）。
 *
 * 读容错（fail-closed）：ENOENT → null（未冻结）；非法 JSON / 缺 papers /
 * 未来 schemaVersion → TARGET_BENCHMARK_CORRUPTED（拒绝降级解读——「损坏」
 * 与「未冻结」是两种事实）。
 *
 * 落盘 writeJsonAtomic；指纹确定性（sourceId 升序序列化后 sha256 截断）。
 */

import { readFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { join } from "node:path";

import { BusinessError, NotFoundError } from "../errors.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { writeJsonAtomic } from "../util/atomic.js";
import type {
  BenchmarkTargetSpec,
  TargetBenchmarkArtifact,
  TargetBenchmarkPaper,
  TargetBenchmarkSelection,
} from "./types.js";

const TARGET_BENCHMARK_SCHEMA_VERSION = 1 as const;

/** SourceStore 侧需要的最小投影（冻结/调整时读磁盘事实） */
export interface BenchmarkSourceLike {
  sourceId: string;
  sourceRole: string;
  status: string;
  fileName?: string;
  identityKey?: string;
}

export interface TargetBenchmarkServiceOptions {
  projects: ProjectStore;
  /** SourceStore.list 投影（hasFullText / 条目存在性；测试注入 fake） */
  listSources: (projectId: string) => Promise<BenchmarkSourceLike[]>;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface FreezeBenchmarkInput {
  target: BenchmarkTargetSpec;
  papers: TargetBenchmarkPaper[];
  selection?: TargetBenchmarkSelection;
}

/** 参与语料行的确定性指纹（含 excluded——有效语料变化指纹必变） */
export function benchmarkFingerprint(papers: readonly TargetBenchmarkPaper[]): string {
  const serialized = papers
    .map((paper) =>
      [
        paper.sourceId,
        paper.identityKey,
        paper.provenance.provider,
        paper.provenance.queryUsed,
        paper.citationCount ?? "-",
        paper.venueRaw,
        paper.hasFullText ? 1 : 0,
        paper.excluded !== undefined ? `excluded:${paper.excluded.reason}` : "-",
      ].join("|"),
    )
    .sort()
    .join("\n");
  return createHash("sha256").update(serialized).digest("hex").slice(0, 16);
}

export class TargetBenchmarkService {
  private readonly projects: ProjectStore;
  private readonly listSources: (projectId: string) => Promise<BenchmarkSourceLike[]>;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(options: TargetBenchmarkServiceOptions) {
    this.projects = options.projects;
    this.listSources = options.listSources;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  private artifactPath(projectId: string): string {
    return join(this.projects.researchDir(projectId), "target-benchmark.json");
  }

  /** 读 artifact；未冻结 → null；损坏 → TARGET_BENCHMARK_CORRUPTED（fail-closed） */
  async get(projectId: string): Promise<TargetBenchmarkArtifact | null> {
    let raw: string;
    try {
      raw = await readFile(this.artifactPath(projectId), "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    return parseTargetBenchmark(projectId, raw);
  }

  async getRequired(projectId: string): Promise<TargetBenchmarkArtifact> {
    const artifact = await this.get(projectId);
    if (artifact === null) {
      throw new NotFoundError(
        "target benchmark 语料",
        `${projectId}（尚未冻结；先执行 benchmark discovery 或显式 freeze）`,
      );
    }
    return artifact;
  }

  /**
   * 首次冻结（幂等：已存在 → 原样返回，不重写）。行按 sourceId 升序确定性
   * 排序；selection（A6 auto-select 快照）原样入 artifact。
   */
  async freeze(
    projectId: string,
    input: FreezeBenchmarkInput,
  ): Promise<TargetBenchmarkArtifact> {
    await this.projects.getRequired(projectId);
    const existing = await this.get(projectId);
    if (existing !== null) {
      return existing;
    }
    const papers = sortBySourceId(input.papers);
    const timestamp = this.now().toISOString();
    const artifact: TargetBenchmarkArtifact = {
      schemaVersion: TARGET_BENCHMARK_SCHEMA_VERSION,
      revision: 0,
      createdAt: timestamp,
      updatedAt: timestamp,
      fingerprint: benchmarkFingerprint(papers),
      target: input.target,
      papers,
      ...(input.selection !== undefined ? { selection: input.selection } : {}),
    };
    await writeJsonAtomic(this.artifactPath(projectId), artifact);
    this.log(
      `[target] projectId=${projectId} 冻结 benchmark 语料：revision=0 papers=${papers.length} fingerprint=${artifact.fingerprint}`,
    );
    return artifact;
  }

  /**
   * 显式 refresh（新语料修订）：以调用方给定的行集合整体替换 → revision+1、
   * 指纹重算。未冻结 → INVALID_REQUEST（不允许凭空 refresh——先形成基线）。
   * selection 一并替换（新选择事实）；缺省保留旧 selection 不静默丢失审计。
   */
  async refresh(
    projectId: string,
    input: FreezeBenchmarkInput,
  ): Promise<TargetBenchmarkArtifact> {
    await this.projects.getRequired(projectId);
    const existing = await this.get(projectId);
    if (existing === null) {
      throw new BusinessError(
        "INVALID_REQUEST",
        "benchmark 语料尚未冻结（无 target-benchmark.json）；先执行 discovery 冻结",
      );
    }
    const papers = sortBySourceId(input.papers);
    const artifact: TargetBenchmarkArtifact = {
      ...existing,
      revision: existing.revision + 1,
      updatedAt: this.now().toISOString(),
      fingerprint: benchmarkFingerprint(papers),
      target: input.target,
      papers,
      ...(input.selection !== undefined ? { selection: input.selection } : {}),
    };
    await writeJsonAtomic(this.artifactPath(projectId), artifact);
    this.log(
      `[target] projectId=${projectId} 显式 refresh：revision=${artifact.revision} papers=${papers.length} fingerprint=${artifact.fingerprint}`,
    );
    return artifact;
  }

  /**
   * 同 revision 内剔除条目（M12.0 §4.3 excluded 字段）：标 excluded（reason
   * 必填）→ 指纹重算（有效语料变化必须反映）、revision 不动、updatedAt 更新。
   * 幂等：已 excluded 且 reason 相同 → 原样返回；reason 不同 → 覆盖理由
   * （最后一次作者裁决生效）。
   */
  async exclude(
    projectId: string,
    sourceId: string,
    reason: string,
  ): Promise<TargetBenchmarkArtifact> {
    const existing = await this.getRequired(projectId);
    const trimmed = reason.trim();
    if (trimmed === "") {
      throw new BusinessError("INVALID_REQUEST", "exclude 需要非空 reason（审计事实）");
    }
    const index = existing.papers.findIndex((paper) => paper.sourceId === sourceId);
    if (index === -1) {
      throw new NotFoundError("benchmark 语料条目", sourceId);
    }
    const current = existing.papers[index]!;
    if (
      current.excluded !== undefined &&
      current.excluded.reason === trimmed.slice(0, 500)
    ) {
      return existing;
    }
    const papers = [...existing.papers];
    papers[index] = {
      ...current,
      excluded: { reason: trimmed.slice(0, 500), at: this.now().toISOString() },
    };
    const artifact: TargetBenchmarkArtifact = {
      ...existing,
      updatedAt: this.now().toISOString(),
      fingerprint: benchmarkFingerprint(papers),
      papers,
    };
    await writeJsonAtomic(this.artifactPath(projectId), artifact);
    this.log(`[target] projectId=${projectId} 剔除 ${sourceId}（${trimmed.slice(0, 120)}）`);
    return artifact;
  }

  /**
   * 追加单篇进冻结集合（A6 HITL 服务端能力）：sourceId 必须已在 SourceStore
   * 且 role=reference（隔离红线——非 reference 源不进 benchmark 语料）。
   * refresh 语义：revision+1。缺省字段从 SourceStore 现场补齐（identityKey /
   * venue / citationCount / hasFullText）。幂等：已在集合 → 原样返回。
   */
  async addPaper(
    projectId: string,
    input: {
      sourceId: string;
      provenance?: { provider: string; retrievedAt?: string; queryUsed?: string };
      inclusionReason?: string;
      citationCount?: number;
      venueRaw?: string;
    },
  ): Promise<TargetBenchmarkArtifact> {
    await this.projects.getRequired(projectId);
    const existing = await this.getRequired(projectId);
    if (existing.papers.some((paper) => paper.sourceId === input.sourceId && paper.excluded === undefined)) {
      return existing;
    }
    const sources = await this.listSources(projectId);
    const source = sources.find((entry) => entry.sourceId === input.sourceId);
    if (source === undefined) {
      throw new NotFoundError(
        "benchmark 追加源",
        `${input.sourceId}（不在项目文献库；先以 role=reference 入库）`,
      );
    }
    if (source.sourceRole === "evidence" || source.sourceRole === "both") {
      throw new BusinessError(
        "INVALID_REQUEST",
        `源 ${input.sourceId} 的 sourceRole=${source.sourceRole}——benchmark 语料条目必须 role=reference（M12.0 §5 隔离：evidence/both 源不进 benchmark）`,
      );
    }
    const paper: TargetBenchmarkPaper = {
      sourceId: input.sourceId,
      // SourceStore 投影的 identityKey（调用方未显式提供时以库内身份为准）
      identityKey: source.identityKey ?? "",
      provenance: {
        provider: input.provenance?.provider ?? "manual_add",
        retrievedAt: input.provenance?.retrievedAt ?? this.now().toISOString(),
        queryUsed: input.provenance?.queryUsed ?? "-",
      },
      inclusionReason:
        input.inclusionReason !== undefined && input.inclusionReason.trim() !== ""
          ? input.inclusionReason.trim().slice(0, 500)
          : "manual add（作者/用户显式追加）",
      ...(input.citationCount !== undefined ? { citationCount: input.citationCount } : {}),
      venueRaw: input.venueRaw ?? "",
      hasFullText: source.fileName !== undefined && source.fileName !== "" && source.status !== "metadata_only",
    };
    // 已存在但被 excluded 的条目：重纳入（覆盖 excluded，理由更新）
    const papers = existing.papers.filter((entry) => entry.sourceId !== input.sourceId);
    papers.push(paper);
    const artifact: TargetBenchmarkArtifact = {
      ...existing,
      revision: existing.revision + 1,
      updatedAt: this.now().toISOString(),
      fingerprint: benchmarkFingerprint(sortBySourceId(papers)),
      papers: sortBySourceId(papers),
    };
    await writeJsonAtomic(this.artifactPath(projectId), artifact);
    this.log(`[target] projectId=${projectId} 追加 ${input.sourceId} → revision=${artifact.revision}`);
    return artifact;
  }

  /**
   * HITL 确认（A6）：幂等——首次写入 confirmedAt（审计事实：自动冻结 vs
   * 作者确认可区分）；重复确认 no-op（不更新时间戳、不动 revision/指纹）。
   */
  async confirm(projectId: string): Promise<TargetBenchmarkArtifact> {
    const existing = await this.getRequired(projectId);
    if (existing.confirmedAt !== undefined) {
      return existing;
    }
    const artifact: TargetBenchmarkArtifact = {
      ...existing,
      confirmedAt: this.now().toISOString(),
      updatedAt: this.now().toISOString(),
    };
    await writeJsonAtomic(this.artifactPath(projectId), artifact);
    this.log(`[target] projectId=${projectId} benchmark 语料确认（revision=${artifact.revision}）`);
    return artifact;
  }
}

function sortBySourceId(papers: readonly TargetBenchmarkPaper[]): TargetBenchmarkPaper[] {
  return [...papers].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
}

/** 解析 + 结构校验（损坏 fail-closed；宽容读：selection/confirmedAt 可缺省） */
function parseTargetBenchmark(projectId: string, raw: string): TargetBenchmarkArtifact {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw targetBenchmarkCorrupted(projectId, "不是合法 JSON");
  }
  const record = typeof parsed === "object" && parsed !== null ? (parsed as Record<string, unknown>) : null;
  if (record === null || !Array.isArray(record["papers"])) {
    throw targetBenchmarkCorrupted(projectId, "缺少 papers 数组");
  }
  if (record["schemaVersion"] !== TARGET_BENCHMARK_SCHEMA_VERSION) {
    throw targetBenchmarkCorrupted(projectId, `不支持的 schemaVersion=${String(record["schemaVersion"])}`);
  }
  const papers: TargetBenchmarkPaper[] = [];
  for (const entry of record["papers"]) {
    if (
      typeof entry === "object" &&
      entry !== null &&
      typeof (entry as Record<string, unknown>)["sourceId"] === "string" &&
      typeof (entry as Record<string, unknown>)["identityKey"] === "string"
    ) {
      papers.push(entry as TargetBenchmarkPaper);
    } else {
      throw targetBenchmarkCorrupted(projectId, "papers 含结构不完整条目（sourceId/identityKey）");
    }
  }
  const target = record["target"];
  if (typeof target !== "object" || target === null || typeof (target as Record<string, unknown>)["documentType"] !== "string") {
    throw targetBenchmarkCorrupted(projectId, "target 结构不完整（documentType）");
  }
  return {
    schemaVersion: TARGET_BENCHMARK_SCHEMA_VERSION,
    revision: typeof record["revision"] === "number" ? record["revision"] : 0,
    createdAt: typeof record["createdAt"] === "string" ? record["createdAt"] : "",
    updatedAt: typeof record["updatedAt"] === "string" ? record["updatedAt"] : "",
    fingerprint: typeof record["fingerprint"] === "string" ? record["fingerprint"] : benchmarkFingerprint(papers),
    target: target as BenchmarkTargetSpec,
    papers: sortBySourceId(papers),
    ...(typeof record["selection"] === "object" && record["selection"] !== null
      ? { selection: record["selection"] as TargetBenchmarkSelection }
      : {}),
    ...(typeof record["confirmedAt"] === "string" ? { confirmedAt: record["confirmedAt"] } : {}),
  };
}

function targetBenchmarkCorrupted(projectId: string, detail: string): BusinessError {
  return new BusinessError(
    "TARGET_BENCHMARK_CORRUPTED",
    `项目 ${projectId} 的 target-benchmark.json 损坏（${detail}）——拒绝降级解读，请人工核查或删除后重新冻结`,
  );
}
