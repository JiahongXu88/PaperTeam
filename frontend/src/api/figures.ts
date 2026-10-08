import { apiClient, apiUrl } from "./client.js";

/**
 * Figures API（M12 Batch 3 · C4/C5：学术图表生成 + 手稿插入）。
 *
 *   GET    /api/projects/:id/figures                       → { figures: FigureView[] }
 *   GET    /api/projects/:id/figures/datasets              → { datasets: DatasetCandidateView[] }
 *   GET    /api/projects/:id/figures/datasets/:sid/:block  → { dataset: DatasetPayloadView }
 *   POST   /api/projects/:id/figures/validate              → { result }
 *   POST   /api/projects/:id/figures/generate              → { figure: GenerateResultView }
 *   GET    /api/projects/:id/figures/:figId                → { figure }
 *   POST   /api/projects/:id/figures/insert                → { insertion: InsertResultView }
 *   GET    /api/projects/:id/figures/generated/:name       → 生成图 PDF 字节（application/pdf）
 *
 * 类型与后端 figures 域对齐（本文件自持，不进 types/api.ts 既有 DTO）。
 */

export type FigureKind = "plot" | "diagram";

export interface CaptionIssueView {
  level: "violation" | "unverified" | "info";
  claim: string;
  message: string;
}

export interface CaptionValidationView {
  verdict: "pass" | "unverified" | "violation";
  issues: CaptionIssueView[];
}

export interface FigureView {
  figId: string;
  kind: FigureKind;
  plotType?: string;
  semantic?: string;
  title?: string;
  caption: string;
  specHash: string;
  datasetHash?: string;
  dataOriginClass: "source_parsed" | "manual" | "diagram";
  sourceId?: string;
  blockId?: string;
  createdAt: string;
  compiler?: { durationMs: number; diagnostics: string } | undefined;
  assetPresent: boolean;
  insertedIn?: { file: string; label: string; revision: number };
  supersededBy?: string;
  stale?: { reason: "source_missing" | "source_changed" | "dataset_changed"; detail: string };
}

export interface DatasetCandidateView {
  sourceId: string;
  blockId: string;
  kind: "table" | "records";
  fileName: string;
  caption?: string;
  locationHint?: string;
  columns: string[];
  rowCount: number;
  datasetHash: string;
  sourceRole?: string;
}

export interface DatasetPayloadView extends DatasetCandidateView {
  inlineDataset: { columns: string[]; rows: (number | string | null)[][] };
}

export interface GenerateResultView {
  record: FigureView & { assets: { tex: string; pdf: string }; dataOrigin: unknown };
  cached: boolean;
  captionValidation?: CaptionValidationView;
}

export interface InsertResultView {
  record: FigureView;
  file: string;
  label: string;
  environment: string;
  graphicxInjected: boolean;
  previousPath?: string;
  authorConfirmedUnverified: boolean;
  captionValidation?: CaptionValidationView;
}

export interface PlotSpecInput {
  plotType: "line" | "bar" | "grouped_bar" | "scatter";
  semantic?: "benchmark_comparison" | "ablation";
  title?: string;
  caption?: string;
  data: {
    origin: { sourceId: string; blockId?: string } | { origin: "manual"; note: string };
    datasetHash: string;
    x: string[];
    series: Array<{ name: string; column: string }>;
    missingPolicy?: "reject" | "skip_row";
    inlineDataset: { columns: string[]; rows: (number | string | null)[][] };
  };
  axis: {
    xLabel?: string;
    yLabel?: string;
    legend?: boolean;
    renderOptions?: { widthCm?: number; heightCm?: number; markSizePt?: number };
  };
}

export interface DiagramSpecInput {
  layout: "vertical" | "horizontal";
  variant?: "pipeline" | "comparison";
  nodes: Array<{ id: string; label: string; group?: string; role?: "stage" | "annotation" | "left" | "right" }>;
  edges: Array<{ from: string; to: string; label?: string }>;
  groups?: Array<{ id: string; label?: string }>;
  title?: string;
}

export interface InsertParamsInput {
  figId: string;
  mode: "append" | "replace";
  sectionId?: string;
  file?: string;
  label?: string;
  caption?: string;
  widthExpression?: string;
  referenceSentence?: string;
  replaceLabel?: string;
  confirmUnverified?: boolean;
}

export async function listFigures(projectId: string, signal?: AbortSignal): Promise<FigureView[]> {
  const body = await apiClient.get<{ figures: FigureView[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/figures`,
    signal,
  );
  return body.figures ?? [];
}

export async function listFigureDatasets(
  projectId: string,
  signal?: AbortSignal,
): Promise<DatasetCandidateView[]> {
  const body = await apiClient.get<{ datasets: DatasetCandidateView[] }>(
    `/api/projects/${encodeURIComponent(projectId)}/figures/datasets`,
    signal,
  );
  return body.datasets ?? [];
}

export async function getFigureDataset(
  projectId: string,
  sourceId: string,
  blockId: string,
): Promise<DatasetPayloadView> {
  const body = await apiClient.get<{ dataset: DatasetPayloadView }>(
    `/api/projects/${encodeURIComponent(projectId)}/figures/datasets/${encodeURIComponent(sourceId)}/${encodeURIComponent(blockId)}`,
  );
  return body.dataset;
}

export async function validateFigureSpec(
  projectId: string,
  kind: FigureKind,
  spec: unknown,
): Promise<{ ok: true; captionValidation?: CaptionValidationView } | { ok: false; errors: string[] }> {
  const body = await apiClient.post<{ result: { ok: true; captionValidation?: CaptionValidationView } | { ok: false; errors: string[] } }>(
    `/api/projects/${encodeURIComponent(projectId)}/figures/validate`,
    { kind, spec },
  );
  return body.result;
}

export async function generateFigure(
  projectId: string,
  kind: FigureKind,
  spec: unknown,
): Promise<GenerateResultView> {
  const body = await apiClient.post<{ figure: GenerateResultView }>(
    `/api/projects/${encodeURIComponent(projectId)}/figures/generate`,
    { kind, spec },
  );
  return body.figure;
}

export async function insertFigure(
  projectId: string,
  params: InsertParamsInput,
): Promise<InsertResultView> {
  const body = await apiClient.post<{ insertion: InsertResultView }>(
    `/api/projects/${encodeURIComponent(projectId)}/figures/insert`,
    params,
  );
  return body.insertion;
}

/** 生成图 PDF 地址（浏览器原生 PDF 预览 / 新标签打开） */
export function generatedFigurePdfUrl(projectId: string, figId: string): string {
  return apiUrl(
    `/api/projects/${encodeURIComponent(projectId)}/figures/generated/${encodeURIComponent(`${figId}.pdf`)}`,
  );
}

/** 插入目标的章节选项（outline 投影；已有论文项目 outline 为 null → 空数组） */
export async function listManuscriptSections(
  projectId: string,
  signal?: AbortSignal,
): Promise<Array<{ id: string; title: string; file: string; exists: boolean }>> {
  const body = await apiClient.get<{
    outline: { sections?: Array<{ id: string; title: string; file: string }> } | null;
    sections: Array<{ id: string; file: string; exists: boolean }>;
  }>(`/api/projects/${encodeURIComponent(projectId)}/manuscript`, signal);
  const statuses = new Map((body.sections ?? []).map((section) => [section.id, section]));
  return (body.outline?.sections ?? []).map((section) => ({
    id: section.id,
    title: section.title,
    file: section.file,
    exists: statuses.get(section.id)?.exists ?? false,
  }));
}
