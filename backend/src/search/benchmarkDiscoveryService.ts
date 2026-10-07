/**
 * BenchmarkDiscoveryService：Target benchmark 论文发现（M12.1 A4）。
 *
 * 复用既有 search stack（M12.0 §4.5 冻结：不建第二套——4-provider fan-out /
 * RRF 融合 / identity 去重 / OA 全文链 / candidate→promote→SourceStore 全部
 * 原样复用），只做三件编排：
 * 1. targetVenue → venueResolution（种子表 + OpenAlex /sources 一次查询）；
 *    resolved → **双发**：venueSourceIds 给 OpenAlex 服务端过滤 +
 *    venueNames（matchNames）给其它 provider 客户端过滤；ambiguous /
 *    not_found → **如实降级**为纯关键词 + 引用数排序（venueDegraded=true，
 *    不静默——降级事实进结果，供 A6 标记 requiresAttention）；
 * 2. 检索词确定性拼装（researchField + documentType 语义词，无 LLM：
 *    survey 类 → "<field> survey"，其余 → "<field>"；降级模式把 venue 原文
 *    拼进关键词——这是唯一的补偿通道，如实标注）；
 * 3. 排序（citationCount 降序为主、relevance 兜底）+ identity 去重 → 候选列表。
 *
 * 入库纪律（M12.0 §5 隔离）：benchmark 论文**恒** sourceRole="reference"，经
 * CandidateStore → promoteCandidate 既有链路入库（引用数/venue/inclusionReason
 * 随行）；同身份既有条目若是 evidence → 升级为 both（D-0012：both 语义正是
 * 「既是用户证据又是参照范文」），绝不把 evidence 降级成 reference。
 *
 * discoverAndFreeze（A6 默认流程，一键、不强制暂停）：discover → A6
 * auto-select（8–15，默认 12）→ role=reference 入库 → A5 freeze（幂等；重复
 * 调用不重写已冻结语料——要更新走显式 refresh）。sufficiency /
 * requiresAttention 恒在返回值里，不静默。
 */

import { BusinessError } from "../errors.js";
import { identityKey, type SourceIdentity } from "../sources/identity.js";
import type { CandidateStore } from "../sources/CandidateStore.js";
import type { SourceStore } from "../sources/SourceStore.js";
import type { SourceImportService } from "../sources/SourceImportService.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { TargetBenchmarkService } from "../target/TargetBenchmarkService.js";
import type { BenchmarkTargetSpec, TargetBenchmarkPaper } from "../target/types.js";
import { benchmarkFingerprint } from "../target/TargetBenchmarkService.js";
import { selectRecommended, type BenchmarkSelectionResult } from "../target/selection.js";
import type { AcademicSearchService } from "./academicSearchService.js";
import type { SearchDiagnostics, SearchOptions } from "./types.js";
import type { VenueResolution, VenueResolutionService } from "./venueResolution.js";

/** discovery 默认检索条数（4 provider fan-out 后 fusion 上限 50 的实用档） */
export const DEFAULT_BENCHMARK_LIMIT = 25;

/** survey 类 documentType → 检索名词（与 ProjectStore.workflowKindForDocumentType 同口径） */
const SURVEY_DOCUMENT_TYPES: ReadonlySet<string> = new Set([
  "survey",
  "survey_article",
  "review",
  "review_article",
  "综述",
  "综述论文",
]);

export interface BenchmarkCandidate {
  identity: SourceIdentity;
  title: string;
  authors?: string[];
  year?: number;
  /** 未归一化 venue 原文（诚实投影） */
  venueRaw?: string;
  doi?: string;
  arxivId?: string;
  url?: string;
  citationCount?: number;
  /** RRF 融合分（relevance 兜底排序用） */
  fusedScore: number;
  /** 命中该结果的 provider 名次集（provenance） */
  sources: Array<{ provider: string; rank: number }>;
  provenance: { provider: string; queryUsed: string };
}

export type BenchmarkVenueResolutionOutcome =
  | VenueResolution
  | { status: "skipped_no_target_venue"; note: string };

export interface BenchmarkDiscoveryResult {
  projectId: string;
  query: string;
  venueResolution: BenchmarkVenueResolutionOutcome;
  /** true = venue 未解析成功 → 已降级为纯关键词+引用数排序（不静默） */
  venueDegraded: boolean;
  /** citationCount 降序（缺数排尾）→ 融合分兜底；已按 identityKey 去重 */
  candidates: BenchmarkCandidate[];
  diagnostics: SearchDiagnostics;
}

export interface BenchmarkDiscoveryInput {
  target: BenchmarkTargetSpec;
  /** 检索条数上限（缺省 25） */
  limit?: number;
}

export interface BenchmarkDiscoveryServiceOptions {
  projects: ProjectStore;
  academic: AcademicSearchService;
  venues: VenueResolutionService;
  candidates: CandidateStore;
  imports: SourceImportService;
  sources: SourceStore;
  targets: TargetBenchmarkService;
  now?: () => Date;
  log?: (message: string) => void;
}

export interface DiscoverAndFreezeInput extends BenchmarkDiscoveryInput {
  /** 选中目标数（A6；缺省 12，带内 8–15） */
  targetCount?: number;
}

export interface DiscoverAndFreezeResult {
  discovery: BenchmarkDiscoveryResult;
  selection: BenchmarkSelectionResult<BenchmarkCandidate>;
  /** 成功以 role=reference（或既有 evidence → both）入库的 sourceId */
  savedSourceIds: string[];
  /** 入库时角色被升级为 both 的条目（既有 evidence 源；审计） */
  upgradedToBoth: Array<{ sourceId: string; reason: string }>;
  artifact: import("../target/types.js").TargetBenchmarkArtifact;
  /** true = 语料此前已冻结，本次 freeze 为幂等 no-op（未改写冻结集合） */
  alreadyFrozen: boolean;
}

export class BenchmarkDiscoveryService {
  private readonly projects: ProjectStore;
  private readonly academic: AcademicSearchService;
  private readonly venues: VenueResolutionService;
  private readonly candidates: CandidateStore;
  private readonly imports: SourceImportService;
  private readonly sources: SourceStore;
  private readonly targets: TargetBenchmarkService;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(options: BenchmarkDiscoveryServiceOptions) {
    this.projects = options.projects;
    this.academic = options.academic;
    this.venues = options.venues;
    this.candidates = options.candidates;
    this.imports = options.imports;
    this.sources = options.sources;
    this.targets = options.targets;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  // ---- 发现（M12.0 §4.1 冻结流程 1–4）----

  async discover(
    projectId: string,
    input: BenchmarkDiscoveryInput,
  ): Promise<BenchmarkDiscoveryResult> {
    await this.projects.getRequired(projectId);
    const field = input.target.researchField?.trim() ?? "";
    if (field === "") {
      throw new BusinessError(
        "INVALID_REQUEST",
        "benchmark discovery 需要 researchField（项目研究领域的确定性检索词来源；无字段的 benchmark 参照系无从谈起）",
      );
    }

    // 1) venue 解析（无 targetVenue → skipped，不算降级）
    let venueResolution: BenchmarkVenueResolutionOutcome;
    let venueDegraded = false;
    const venueSourceIds: string[] = [];
    let venueNames: string[] = [];
    const targetVenue = input.target.targetVenue?.trim();
    if (targetVenue === undefined || targetVenue === "") {
      venueResolution = {
        status: "skipped_no_target_venue",
        note: "未配置 targetVenue——按 targetProfile + researchField 检索（无 venue 过滤）",
      };
    } else {
      venueResolution = await this.venues.resolve(targetVenue);
      if (venueResolution.status === "resolved") {
        if (venueResolution.openalexSourceId !== undefined) {
          venueSourceIds.push(venueResolution.openalexSourceId);
        }
        venueNames = venueResolution.matchNames;
      } else {
        venueDegraded = true; // ambiguous / not_found：降级，不静默
      }
    }

    // 2) 检索词确定性拼装（无 LLM）
    const query = buildBenchmarkQuery({
      researchField: field,
      documentType: input.target.documentType,
      degradedVenueKeyword: venueDegraded ? targetVenue : undefined,
    });

    // 3) 复用 academicSearchService（venue 双发 + 年份窗）
    const searchOptions: SearchOptions = {
      limit: input.limit ?? DEFAULT_BENCHMARK_LIMIT,
      ...(input.target.timeWindow?.from !== undefined ? { yearFrom: input.target.timeWindow.from } : {}),
      ...(input.target.timeWindow?.to !== undefined ? { yearTo: input.target.timeWindow.to } : {}),
      ...(venueSourceIds.length > 0 ? { venueSourceIds } : {}),
      ...(venueNames.length > 0 ? { venueNames } : {}),
    };
    const response = await this.academic.search(query, searchOptions);

    // 4) 排序（citationCount 降序为主、relevance 兜底）+ identity 去重（belt）
    const seen = new Set<string>();
    const candidates: BenchmarkCandidate[] = [];
    for (const fused of response.results) {
      const key = identityKey(fused.identity);
      if (key === undefined || seen.has(key)) {
        continue;
      }
      seen.add(key);
      candidates.push({
        identity: fused.identity,
        title: fused.record.title ?? "",
        ...(fused.record.authors !== undefined && fused.record.authors.length > 0
          ? { authors: fused.record.authors }
          : {}),
        ...(fused.record.year !== undefined ? { year: fused.record.year } : {}),
        ...(fused.record.venue !== undefined ? { venueRaw: fused.record.venue } : {}),
        ...(fused.record.doi !== undefined ? { doi: fused.record.doi } : {}),
        ...(fused.record.arxivId !== undefined ? { arxivId: fused.record.arxivId } : {}),
        ...(fused.record.url !== undefined ? { url: fused.record.url } : {}),
        ...(fused.citationCount !== undefined ? { citationCount: fused.citationCount } : {}),
        fusedScore: fused.score,
        sources: fused.sources,
        provenance: {
          provider: fused.sources[0]?.provider ?? "academic_search",
          queryUsed: query,
        },
      });
    }
    candidates.sort(
      (a, b) =>
        (b.citationCount ?? -1) - (a.citationCount ?? -1) ||
        b.fusedScore - a.fusedScore ||
        a.title.localeCompare(b.title),
    );
    this.log(
      `[target] projectId=${projectId} benchmark discovery：query="${query}" venue=${venueSourceIds.length > 0 ? venueSourceIds.join("|") : venueDegraded ? "degraded" : "skipped"} candidates=${candidates.length}（venueDegraded=${venueDegraded}）`,
    );
    return {
      projectId,
      query,
      venueResolution,
      venueDegraded,
      candidates,
      diagnostics: response.diagnostics,
    };
  }

  // ---- 入库（role=reference；复用 candidate → promote 既有链）----

  /**
   * 把选中的候选入库为 benchmark 参照源：saveAcademic 候选（citationCount
   * 快照随行）→ promoteCandidate(sourceRole="reference", selectionReason=
   * inclusionReason)。同身份既有 evidence/both 条目 → 角色升级为 both（D-0012
   * both 语义；不降级用户证据角色）。幂等（promote 自身幂等）。
   */
  async saveBenchmarkSources(
    projectId: string,
    discovery: BenchmarkDiscoveryResult,
    selected: ReadonlyArray<BenchmarkCandidate & { inclusionReason: string }>,
  ): Promise<{ savedSourceIds: string[]; upgradedToBoth: Array<{ sourceId: string; reason: string }> }> {
    await this.projects.getRequired(projectId);
    const savedSourceIds: string[] = [];
    const upgradedToBoth: Array<{ sourceId: string; reason: string }> = [];
    for (const candidate of selected) {
      const added = await this.candidates.add(projectId, {
        identity: candidate.identity,
        ...(candidate.doi !== undefined ? { doi: candidate.doi } : {}),
        ...(candidate.arxivId !== undefined ? { arxivId: candidate.arxivId } : {}),
        ...(candidate.url !== undefined ? { url: candidate.url } : {}),
        ...(candidate.title !== "" ? { title: candidate.title } : {}),
        ...(candidate.authors !== undefined ? { authors: candidate.authors } : {}),
        ...(candidate.year !== undefined ? { year: candidate.year } : {}),
        ...(candidate.venueRaw !== undefined ? { venue: candidate.venueRaw } : {}),
        ...(candidate.citationCount !== undefined ? { citationCount: candidate.citationCount } : {}),
        query: discovery.query,
        origin: "academic_search",
        provider: candidate.provenance.provider,
      });
      const promoted = await this.imports.promoteCandidate(projectId, added.candidate.candidateId, {
        sourceRole: "reference",
        selectionReason: candidate.inclusionReason,
      });
      if (promoted.source.sourceRole === "evidence") {
        // 既有 evidence 条目：升级为 both（保留证据可用性 + 获得参照语义）
        const updated = await this.sources.update(projectId, promoted.source.sourceId, {
          sourceRole: "both",
        });
        upgradedToBoth.push({
          sourceId: updated.sourceId,
          reason: "同身份条目已是 evidence——升级为 both（不降级用户证据角色）",
        });
      }
      savedSourceIds.push(promoted.source.sourceId);
    }
    return { savedSourceIds, upgradedToBoth };
  }

  // ---- 默认流程（A6：一键 discover → auto-select → 入库 → freeze）----

  /** discover → auto-select → role=reference 入库 → papers 行装配（freeze/refresh 共用内核） */
  private async discoverSelectPersist(
    projectId: string,
    input: DiscoverAndFreezeInput,
  ): Promise<{
    discovery: BenchmarkDiscoveryResult;
    selection: BenchmarkSelectionResult<BenchmarkCandidate>;
    savedSourceIds: string[];
    upgradedToBoth: Array<{ sourceId: string; reason: string }>;
    papers: TargetBenchmarkPaper[];
  }> {
    const discovery = await this.discover(projectId, input);
    const venueStatus =
      discovery.venueResolution.status === "skipped_no_target_venue"
        ? "skipped"
        : discovery.venueResolution.status;
    const selection = selectRecommended(discovery.candidates, {
      ...(input.targetCount !== undefined ? { target: input.targetCount } : {}),
      context: {
        venueStatus,
        totalResults: discovery.candidates.length,
      },
      now: this.now,
    });
    const { savedSourceIds, upgradedToBoth } =
      selection.selected.length > 0
        ? await this.saveBenchmarkSources(projectId, discovery, selection.selected)
        : { savedSourceIds: [], upgradedToBoth: [] };

    // papers 行：以入库后的 SourceStore 事实为准（hasFullText 磁盘快照）；
    // savedSourceIds 与 selection.selected 按保存顺序一一对应
    const papers: TargetBenchmarkPaper[] = [];
    for (const [index, candidate] of selection.selected.entries()) {
      const key = identityKey(candidate.identity);
      const sourceId = savedSourceIds[index];
      if (key === undefined || sourceId === undefined) {
        continue;
      }
      const source = await this.sources.get(projectId, sourceId);
      papers.push({
        sourceId,
        identityKey: key,
        provenance: {
          provider: candidate.provenance.provider,
          retrievedAt: this.now().toISOString(),
          queryUsed: discovery.query,
        },
        inclusionReason: candidate.inclusionReason,
        ...(candidate.citationCount !== undefined ? { citationCount: candidate.citationCount } : {}),
        venueRaw: candidate.venueRaw ?? "",
        hasFullText:
          source !== null &&
          source.fileName !== undefined &&
          source.fileName !== "" &&
          source.status !== "metadata_only",
      });
    }
    return { discovery, selection, savedSourceIds, upgradedToBoth, papers };
  }

  async discoverAndFreeze(
    projectId: string,
    input: DiscoverAndFreezeInput,
  ): Promise<DiscoverAndFreezeResult> {
    const { discovery, selection, savedSourceIds, upgradedToBoth, papers } =
      await this.discoverSelectPersist(projectId, input);
    const existing = await this.targets.get(projectId);
    const artifact = await this.targets.freeze(projectId, {
      target: input.target,
      papers,
      selection: selection.selection,
    });
    if (existing !== null) {
      this.log(
        `[target] projectId=${projectId} 语料已冻结（revision=${existing.revision}）——discoverAndFreeze 幂等返回既有集合，未改写；更新请走显式 refresh`,
      );
    }
    return {
      discovery,
      selection,
      savedSourceIds,
      upgradedToBoth,
      artifact,
      alreadyFrozen: existing !== null,
    };
  }

  /**
   * 显式 refresh（M12 Batch 2 HTTP / HITL）：重新发现 + 重选 → 有效集合与当前
   * 冻结指纹不同才 revision+1 重写（TargetBenchmarkService.refresh）；相同 →
   * 幂等返回既有 artifact（changed=false，不空转 revision）。未冻结 →
   * INVALID_REQUEST（refresh 语义只对既有冻结集合成立，先 discover 冻结）。
   */
  async rediscoverAndRefresh(
    projectId: string,
    input: DiscoverAndFreezeInput,
  ): Promise<{
    artifact: import("../target/types.js").TargetBenchmarkArtifact;
    changed: boolean;
    discovery: BenchmarkDiscoveryResult;
    selection: BenchmarkSelectionResult<BenchmarkCandidate>;
  }> {
    const existing = await this.targets.get(projectId);
    if (existing === null) {
      throw new BusinessError(
        "INVALID_REQUEST",
        "benchmark 语料尚未冻结（无 target-benchmark.json）；先执行 discovery 冻结",
      );
    }
    const { discovery, selection, papers } = await this.discoverSelectPersist(projectId, input);
    const newFingerprint = benchmarkFingerprint(papers);
    if (newFingerprint === existing.fingerprint) {
      this.log(
        `[target] projectId=${projectId} 显式 refresh：重发现集合与当前冻结一致（fingerprint=${existing.fingerprint}）——幂等返回，revision 不变`,
      );
      return { artifact: existing, changed: false, discovery, selection };
    }
    const artifact = await this.targets.refresh(projectId, {
      target: input.target,
      papers,
      selection: selection.selection,
    });
    this.log(
      `[target] projectId=${projectId} 显式 refresh：${existing.fingerprint} → ${artifact.fingerprint}（revision=${artifact.revision}）`,
    );
    return { artifact, changed: true, discovery, selection };
  }
}

/** 检索词确定性拼装：survey 类 + researchField；降级模式拼 venue 原文关键词 */
export function buildBenchmarkQuery(input: {
  researchField: string;
  documentType: string;
  degradedVenueKeyword?: string;
}): string {
  const parts = [input.researchField.trim()];
  if (SURVEY_DOCUMENT_TYPES.has(input.documentType.trim())) {
    parts.push("survey");
  }
  if (input.degradedVenueKeyword !== undefined && input.degradedVenueKeyword !== "") {
    parts.push(input.degradedVenueKeyword.trim());
  }
  return parts.filter((part) => part !== "").join(" ");
}
