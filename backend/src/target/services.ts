/**
 * buildTargetServices：Target Publication Intelligence 服务束工厂（M12 Batch 2 ·
 * A7–A9）。serviceStack.ts / 测试统一从这里装配——一处注入，四个服务
 * （benchmark 冻结 → discovery → profile → readiness gap）共享同一套 deps。
 *
 * 生产接线（serviceStack.ts 内，主代理执行）：
 * ```ts
 * const targets = buildTargetServices({
 *   projects,                       // ProjectStore
 *   academic,                       // AcademicSearchService（search stack 既有）
 *   venues: venueResolution,        // VenueResolutionService（A2 既有）
 *   candidates,                     // CandidateStore
 *   imports: sourceImport,          // SourceImportService
 *   sources,                        // SourceStore
 *   parsedDocuments,                // ParsedDocumentStore（M10.1 既有）
 *   revisions,                      // ManuscriptRevisionStore（只读 currentRevision）
 *   summaryModel: { caller: modelRuntime, catalogEntry, spec },  // 可选；缺省两维 UNAVAILABLE
 * });
 * // workflowServices 增：targets
 * ```
 * summaryModel 的 catalogEntry = Pi 模型目录条目（resolveVisionModel 同款来源；
 * text 模型即可——摘要不需要 vision）。缺省不装配 → method/writing 摘要维度
 * UNAVAILABLE（如实降级，不伪造）。
 */

import type { AcademicSearchService } from "../search/academicSearchService.js";
import type { VenueResolutionService } from "../search/venueResolution.js";
import type { BenchmarkDiscoveryService } from "../search/benchmarkDiscoveryService.js";
import { BenchmarkDiscoveryService as BenchmarkDiscoveryServiceImpl } from "../search/benchmarkDiscoveryService.js";
import type { CandidateStore } from "../sources/CandidateStore.js";
import type { SourceImportService } from "../sources/SourceImportService.js";
import type { SourceStore } from "../sources/SourceStore.js";
import { identityKey } from "../sources/identity.js";
import type { ParsedDocumentStore } from "../ingestion/ParsedDocumentStore.js";
import type { ManuscriptRevisionStore } from "../manuscript/RevisionStore.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { TargetBenchmarkService } from "./TargetBenchmarkService.js";
import { TargetGapService } from "./TargetGapService.js";
import { TargetProfileService, type TargetSummaryModel } from "./TargetProfileService.js";

export interface TargetServiceDeps {
  projects: ProjectStore;
  /** 学术检索（venue 过滤/融合/identity 去重复用；A1–A4 既有） */
  academic: AcademicSearchService;
  /** venue → OpenAlex source 解析（A2 既有） */
  venues: VenueResolutionService;
  candidates: CandidateStore;
  imports: SourceImportService;
  sources: SourceStore;
  /** corpus 论文的结构化解析产物（profile 确定性提取的数据源） */
  parsedDocuments: ParsedDocumentStore;
  /** 手稿修订号（readiness 的 manuscriptRevision 对齐；可选） */
  revisions?: Pick<ManuscriptRevisionStore, "currentRevision">;
  /** bounded LLM 摘要（method/writing；缺省 → 两维 UNAVAILABLE） */
  summaryModel?: TargetSummaryModel;
  now?: () => Date;
  log?: (message: string) => void;
}

/** workflow / HTTP 消费的服务束形状（definitions.ts 的 WorkflowServices.targets） */
export interface TargetServices {
  benchmark: TargetBenchmarkService;
  discovery: BenchmarkDiscoveryService;
  profile: TargetProfileService;
  gap: TargetGapService;
}

export function buildTargetServices(deps: TargetServiceDeps): TargetServices {
  const now = deps.now ?? (() => new Date());
  const log = deps.log ?? (() => {});
  const benchmark = new TargetBenchmarkService({
    projects: deps.projects,
    listSources: async (projectId) => {
      const items = await deps.sources.list(projectId);
      return items.map((item) => {
        const key = item.identity !== undefined ? identityKey(item.identity) : undefined;
        return {
          sourceId: item.sourceId,
          sourceRole: item.sourceRole,
          status: item.status,
          ...(item.fileName !== undefined ? { fileName: item.fileName } : {}),
          ...(key !== undefined ? { identityKey: key } : {}),
        };
      });
    },
    now,
    log,
  });
  const discovery = new BenchmarkDiscoveryServiceImpl({
    projects: deps.projects,
    academic: deps.academic,
    venues: deps.venues,
    candidates: deps.candidates,
    imports: deps.imports,
    sources: deps.sources,
    targets: benchmark,
    now,
    log,
  });
  const profile = new TargetProfileService({
    projects: deps.projects,
    benchmarks: benchmark,
    parsedDocuments: deps.parsedDocuments,
    getPaperYear: async (projectId, sourceId) => {
      const item = await deps.sources.get(projectId, sourceId);
      return item?.metadata.year;
    },
    ...(deps.summaryModel !== undefined ? { summaryModel: deps.summaryModel } : {}),
    now,
    log,
  });
  const gap = new TargetGapService({
    projects: deps.projects,
    benchmarks: benchmark,
    profiles: profile,
    ...(deps.revisions !== undefined
      ? { currentRevision: (projectId: string) => deps.revisions!.currentRevision(projectId) }
      : {}),
    now,
    log,
  });
  return { benchmark, discovery, profile, gap };
}
