/**
 * 已有论文 PDF 导入服务（Project Entry & Lifecycle UX，2026-09）。
 *
 * File First：用户不再先创建空项目再进工作区上传——一次调用完成
 *   验证 PDF → 创建 project → ingest/parse → 提取标题 → 更新 metadata
 * 并在任一步失败时回滚（删除刚建的 project 目录），不留下列表可见的半成品。
 *
 * 标题规则（不调用 LLM、不要求用户手填）：
 *   第一优先：PDF parser 提取的真实论文标题（明显不可用时放弃）
 *   兜底：    上传文件名去扩展名（MRG-DTM-final.pdf → MRG-DTM-final）
 * 导入后用户可在项目页「编辑标题」修正（PDF metadata 可能识别错误）。
 */

import { basename } from "node:path";

import { BusinessError } from "../errors.js";
import type { PaperIngestService } from "../paper/PaperIngestService.js";
import type { PaperDocument } from "../paper/types.js";
import type { ProjectMetadata, ProjectResearchMetaInput, ProjectStore } from "./ProjectStore.js";

/** 导入目标（UI 两个入口的内部映射，不进 prompt 字符串） */
export type ExistingPaperGoal = "review_only" | "improvement";

export function goalToWorkflowKind(goal: ExistingPaperGoal): "existing_paper_review" | "existing_paper_improvement" {
  return goal === "review_only" ? "existing_paper_review" : "existing_paper_improvement";
}

export interface ImportPdfInput {
  fileName: string;
  content: Buffer;
  goal: ExistingPaperGoal;
  /** 可选研究定位元数据（高级选项；全部可缺省） */
  meta?: ProjectResearchMetaInput;
}

export interface ImportPdfResult {
  project: ProjectMetadata;
  document: PaperDocument;
  /** 项目标题来源：PDF 内标题 / 文件名兜底 */
  titleSource: "pdf" | "filename";
}

export interface ProjectImportServiceOptions {
  projects: ProjectStore;
  paperIngest: PaperIngestService;
  log?: (message: string) => void;
}

export class ProjectImportService {
  private readonly projects: ProjectStore;
  private readonly paperIngest: PaperIngestService;
  private readonly log: (message: string) => void;

  constructor(options: ProjectImportServiceOptions) {
    this.projects = options.projects;
    this.paperIngest = options.paperIngest;
    this.log = options.log ?? (() => {});
  }

  /**
   * 导入已有论文 PDF 并创建项目（事务式：ingest/parse 失败 → 删除 project 回滚）。
   */
  async importPdf(input: ImportPdfInput): Promise<ImportPdfResult> {
    const workflowKind = goalToWorkflowKind(input.goal);
    // 占位标题 = 文件名兜底（parse 成功后多数会被 PDF 内标题替换）
    const placeholder = filenameFallbackTitle(input.fileName);
    const project = await this.projects.create(placeholder, {
      workflowKind,
      ...(input.meta ?? {}),
    });

    let document: PaperDocument;
    try {
      const ingested = await this.paperIngest.ingest(project.id, {
        fileName: input.fileName,
        content: input.content,
      });
      document = ingested.document;
    } catch (error) {
      // 回滚：不留半成品项目（目录整体删除）
      await this.projects.delete(project.id).catch(() => {});
      this.log(
        `[import] projectId=${project.id} PDF ingest 失败，已回滚删除：${error instanceof Error ? error.message : String(error)}`,
      );
      throw error;
    }

    const derived = deriveProjectTitle(document, input.fileName);
    const finalProject =
      derived.title !== project.title
        ? await this.projects.updateMeta(project.id, { title: derived.title })
        : project;
    this.log(
      `[import] projectId=${project.id} 导入完成：titleSource=${derived.source} title="${derived.title}" goal=${input.goal}`,
    );
    return { project: finalProject, document, titleSource: derived.source };
  }
}

/** PDF 提取标题是否「明显可用」 */
export function isUsablePaperTitle(raw: string | undefined): raw is string {
  const title = raw?.trim();
  if (title === undefined || title.length < 2 || title.length > 200) {
    return false;
  }
  if (/\.pdf$/i.test(title)) {
    return false; // 提取到的是文件名而非论文标题
  }
  if (/^(untitled|unknown|untitled document)$/i.test(title)) {
    return false;
  }
  if (/^\d+$/.test(title)) {
    return false; // 纯数字（页码 / 编号误识别）
  }
  return !/[\x00-\x1f\x7f]/.test(title);
}

/** 文件名兜底标题：去扩展名、去控制字符、限长 */
export function filenameFallbackTitle(fileName: string): string {
  const stem = basename(fileName.trim()).replace(/\.[^.]+$/, "");
  const cleaned = stem.replace(/[\x00-\x1f\x7f]/g, "").trim();
  return (cleaned === "" ? "未命名论文" : cleaned).slice(0, 200);
}

/** 标题推导：PDF 内标题优先，不可用则文件名兜底 */
export function deriveProjectTitle(
  document: PaperDocument,
  fileName: string,
): { title: string; source: "pdf" | "filename" } {
  if (isUsablePaperTitle(document.title)) {
    return { title: document.title.trim().slice(0, 200), source: "pdf" };
  }
  return { title: filenameFallbackTitle(fileName), source: "filename" };
}

/** HTTP 层 goal 字段校验 */
export function readExistingPaperGoal(value: unknown): ExistingPaperGoal {
  if (value === undefined || value === "review_only") {
    return "review_only";
  }
  if (value === "improvement") {
    return "improvement";
  }
  throw new BusinessError("INVALID_REQUEST", '字段 goal 只能是 review_only 或 improvement（缺省 review_only）');
}
