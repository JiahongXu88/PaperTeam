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
import type { AgentRuntime } from "../runtime/types.js";
import type { PaperStore } from "../paper/PaperStore.js";
import type { ScholarlyResolver } from "../citation/scholarly.js";
import type { SourceChunk } from "../retrieval/types.js";
import { TargetBenchmarkService } from "./TargetBenchmarkService.js";
import { TargetGapService } from "./TargetGapService.js";
import { TargetProfileService, type TargetSummaryModel } from "./TargetProfileService.js";
import { TargetGuidelineService } from "./TargetGuidelineService.js";
import { TargetRubricService } from "./TargetRubricService.js";
import { TargetEvidenceAuditService } from "./TargetEvidenceAuditService.js";
import { TargetAuditRevisionService } from "./TargetAuditRevisionService.js";
import type { ExternalInstructionStore } from "../review/externalInstructions.js";
import type { ReviewArtifactStore } from "../review/reviewArtifacts.js";

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
  /**
   * M15.9：rubric 模型（目标期刊级 advisory rubric）。缺省复用 summaryModel
   * 同一注入（同为 text completeSimple）；两者都缺省 → rubric 整体
   * INSUFFICIENT_EVIDENCE（不伪造）。
   */
  rubricModel?: TargetSummaryModel;
  /**
   * M15.16 P0-B：手稿解析产物（PaperStore）。注入后 guideline 符合度在无
   * .tex 时从 PDF 解析产物观测参考文献类官方条款（TeX 存在时 TeX 优先）。
   */
  papers?: PaperStore;
  /**
   * M15.16 P0-A：证据审计（实验性）装配。evidenceAuditEnabled=false（缺省）
   * 或任一依赖缺失 → targets.evidenceAudit = null（HTTP 层 enabled:false /
   * 403 fail-closed），不影响既有服务。
   */
  evidenceAuditEnabled?: boolean;
  runtime?: AgentRuntime;
  reviewerAgentId?: string;
  scholarly?: Pick<ScholarlyResolver, "resolve">;
  readSourceChunks?: (projectId: string, sourceId: string) => Promise<readonly SourceChunk[] | null>;
  /**
   * M15.17：审计差距 → 修订计划闭环。随 evidenceAudit flag 一起装配（审计
   * 关闭则计划入口整体不存在）；externalInstructions / reviewArtifacts 由
   * serviceStack 注入（指令队列与 patch lineage 的确定性数据源）。
   */
  externalInstructions?: ExternalInstructionStore;
  reviewArtifacts?: ReviewArtifactStore;
  now?: () => Date;
  log?: (message: string) => void;
}

/** workflow / HTTP 消费的服务束形状（definitions.ts 的 WorkflowServices.targets） */
export interface TargetServices {
  benchmark: TargetBenchmarkService;
  discovery: BenchmarkDiscoveryService;
  profile: TargetProfileService;
  gap: TargetGapService;
  /** M15.9 · G1：官方投稿要求工件 + 确定性符合度（advisory，零 gate 接线） */
  guideline: TargetGuidelineService;
  /** M15.9 · G2：期刊级 evidence-grounded rubric（模型 advisory，零 gate 接线） */
  rubric: TargetRubricService;
  /**
   * M15.16 · P0-A：贡献证据审计（实验性；advisory 只读）。null = feature
   * flag 关闭或依赖缺失——HTTP 层据此返回 enabled:false / 403。
   */
  evidenceAudit: TargetEvidenceAuditService | null;
  /**
   * M15.17：审计差距 → 修订计划（确定性分类 / 作者决策 / 转入意见队列 /
   * 闭环复评）。null = 证据审计 flag 关闭或依赖缺失（HTTP 层同 evidenceAudit
   * fail-closed）；零模型调用。
   */
  auditRevision: TargetAuditRevisionService | null;
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
  const currentRevision =
    deps.revisions !== undefined
      ? (projectId: string) => deps.revisions!.currentRevision(projectId)
      : undefined;
  const guideline = new TargetGuidelineService({
    projects: deps.projects,
    ...(deps.papers !== undefined ? { papers: deps.papers } : {}),
    ...(currentRevision !== undefined ? { currentRevision } : {}),
    now,
    log,
  });
  const rubricModel = deps.rubricModel ?? deps.summaryModel;
  const rubric = new TargetRubricService({
    projects: deps.projects,
    ...(rubricModel !== undefined ? { rubricModel } : {}),
    ...(currentRevision !== undefined ? { currentRevision } : {}),
    now,
    log,
  });
  const evidenceAuditDeps =
    deps.evidenceAuditEnabled === true &&
    deps.runtime !== undefined &&
    deps.reviewerAgentId !== undefined &&
    deps.scholarly !== undefined &&
    deps.readSourceChunks !== undefined &&
    deps.papers !== undefined
      ? {
          projects: deps.projects,
          store: deps.papers,
          runtime: deps.runtime,
          reviewerAgentId: deps.reviewerAgentId,
          scholarly: deps.scholarly,
          academic: deps.academic,
          listLibrarySources: (projectId: string) => deps.sources.list(projectId),
          readSourceChunks: deps.readSourceChunks,
          ...(currentRevision !== undefined ? { currentRevision } : {}),
          now,
          log,
        }
      : null;
  const evidenceAudit = evidenceAuditDeps !== null ? new TargetEvidenceAuditService(evidenceAuditDeps) : null;
  // M15.17：审计修订闭环——只在证据审计开启且指令 / patch 工件 / 修订号存储注入时装配
  const auditRevision =
    evidenceAuditDeps !== null &&
    deps.revisions !== undefined &&
    deps.externalInstructions !== undefined &&
    deps.reviewArtifacts !== undefined
      ? new TargetAuditRevisionService({
          projects: deps.projects,
          papers: deps.papers!,
          revisions: deps.revisions,
          externalInstructions: deps.externalInstructions,
          reviewArtifacts: deps.reviewArtifacts,
          now,
          log,
        })
      : null;
  return { benchmark, discovery, profile, gap, guideline, rubric, evidenceAudit, auditRevision };
}
