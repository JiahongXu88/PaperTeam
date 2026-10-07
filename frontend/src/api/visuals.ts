import { apiClient, apiUrl } from "./client.js";

/**
 * Visual Review API（M12 Batch 2 · B5：多模态视觉检查）。
 *
 *   GET    /api/projects/:id/visual-reviews/latest   → { report: VisualReviewReportView | null }
 *                                                        （null = 尚未运行——与错误可区分）
 *   POST   /api/projects/:id/visual-reviews/run      → { report }（同步运行并落盘；
 *                                                        vision 不可用时确定性-only 降级运行）
 *   GET    /api/projects/:id/sources/:sid/figures/:name  → 图片字节（image/png|image/jpeg）
 *   GET    /api/projects/:id/figures/generated/:name → 生成图 PDF（application/pdf）
 *
 * 路由由后端按 docs/research/M12_BATCH2_TRACK_B_HANDOFF.md 契约接线；
 * 本模块只消费。类型与后端 VisualReviewReport 对齐（本文件自持——visual
 * 视图不进 types/api.ts 的既有 review DTO）。
 */

export type VisualFindingSeverity = "critical" | "major" | "minor" | "info";
export type VisualVerificationStatus = "verified_deterministic" | "model_observation" | "needs_author_review";
export type VisualConfidence = "high" | "medium" | "low";

/** 视觉类 finding（category 恒 "visual"；source 区分确定性 / 模型观察） */
export interface VisualReviewFindingView {
  findingId: string;
  category: "visual";
  severity: VisualFindingSeverity;
  message: string;
  claimText?: string;
  suggestion?: string;
  status: string;
  /** "deterministic-visual"（确定性检查）| "vision-assisted"（模型观察） */
  source: string;
  /** 图表锚：VisualArtifactView id（tex:… / pdf:… / gen:…） */
  figureEnvRef?: string;
  /** 资产路径（pdf: figures/<sid>/<name>；latex: includegraphics；gen: figs/generated/…） */
  assetRef?: string;
  page?: number;
  chunkId?: string;
  visualConfidence?: VisualConfidence;
  verificationStatus?: VisualVerificationStatus;
  createdAt: string;
}

export interface VisualCheckOutcomeView {
  checkId: string;
  kind: "deterministic" | "vision";
  status: "passed" | "finding" | "skipped" | "failed";
  detail?: string;
  findingIds?: string[];
  visualArtifactIds?: string[];
}

export interface VisualCapabilityView {
  visionAvailable: boolean;
  modelSpec?: string;
  source?: string;
  reason?: string;
  detail: string;
  skippedChecks: string[];
  skippedFigures: Array<{ visualArtifactId: string; reason: string }>;
  visionFiguresCompleted: number;
  visionFiguresFailed: number;
}

export interface VisualReviewReportView {
  schemaVersion: 1;
  projectId: string;
  runAt: string;
  round?: number;
  inputs: { texFiles: string[]; pdfSourceIds: string[]; generatedFigureIds: string[] };
  artifacts: { total: number; figures: number; tables: number; bySourceKind: Record<string, number> };
  findings: VisualReviewFindingView[];
  checks: VisualCheckOutcomeView[];
  capability: VisualCapabilityView;
  notes: string[];
}

/** 最新视觉检查报告（null = 尚未运行过） */
export async function getVisualReviewReport(
  projectId: string,
  signal?: AbortSignal,
): Promise<VisualReviewReportView | null> {
  const body = await apiClient.get<{ report: VisualReviewReportView | null }>(
    `/api/projects/${encodeURIComponent(projectId)}/visual-reviews/latest`,
    signal,
  );
  return body.report ?? null;
}

/** 同步运行视觉检查（确定性恒运行；vision 按 capability 降级）并落盘 */
export async function runVisualReview(projectId: string): Promise<VisualReviewReportView> {
  const body = await apiClient.post<{ report: VisualReviewReportView }>(
    `/api/projects/${encodeURIComponent(projectId)}/visual-reviews/run`,
    {},
  );
  return body.report;
}

/** source 抽图字节地址（png/jpg/jpeg；后端做扁平名白名单 + 登记校验） */
export function sourceFigureUrl(projectId: string, sourceId: string, assetName: string): string {
  return apiUrl(
    `/api/projects/${encodeURIComponent(projectId)}/sources/${encodeURIComponent(sourceId)}/figures/${encodeURIComponent(assetName)}`,
  );
}

/** 生成图 PDF 地址（fig-<hex>.pdf；后端做形态白名单 + manifest 登记校验） */
export function generatedFigureUrl(projectId: string, fileName: string): string {
  return apiUrl(
    `/api/projects/${encodeURIComponent(projectId)}/figures/generated/${encodeURIComponent(fileName)}`,
  );
}

/** 资产可预览性判定（finding.assetRef → 预览 URL 或不可预览原因） */
export type AssetPreview =
  | { kind: "image"; url: string }
  | { kind: "pdf"; url: string }
  | { kind: "unavailable"; reason: string };

export function assetPreviewOf(projectId: string, finding: VisualReviewFindingView): AssetPreview {
  if (finding.assetRef === undefined) {
    return { kind: "unavailable", reason: "该图表无图片资产" };
  }
  const ref = finding.assetRef;
  if (ref.startsWith("figures/")) {
    // "figures/<sourceId>/<assetName>"
    const [, sourceId, assetName] = ref.split("/");
    if (sourceId !== undefined && assetName !== undefined) {
      return { kind: "image", url: sourceFigureUrl(projectId, sourceId, assetName) };
    }
    return { kind: "unavailable", reason: "资产路径不可解析" };
  }
  if (ref.startsWith("figs/generated/")) {
    const fileName = ref.slice("figs/generated/".length);
    if (fileName !== "") {
      return { kind: "pdf", url: generatedFigureUrl(projectId, fileName) };
    }
    return { kind: "unavailable", reason: "资产路径不可解析" };
  }
  return { kind: "unavailable", reason: `手稿本地资产（${ref}）无 HTTP 预览通道` };
}
