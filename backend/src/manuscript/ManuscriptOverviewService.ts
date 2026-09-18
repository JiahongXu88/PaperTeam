/**
 * Manuscript 聚合视图（M7.0.3，只读）。
 *
 * 把分散的既有事实组装为一个面向 UI 的「当前稿件」摘要（不新增实体、不写任何文件）：
 *   ProjectStore               项目标题（outline 缺失时兜底）
 *   manuscript/outline.json    稿件标题 / 章节数（生成式稿件；ManuscriptService）
 *   workflow/import-report.json LaTeX 导入事实（入口 / tex 文件 / bib；LatexImporter）
 *   PaperStore                 PDF 导入事实（parsed document / 已提取参考文献）
 *   ManuscriptRevisionStore    当前修订编号
 *   build/build-gate.json      最新构建记录（loadBuildGateRecord）
 *
 * 纪律：与 VersionService 同级的组装层——sourceType 等判定只在这里做，
 * 前端拿到即展示、绝不自行拼装猜测；任何字段缺失都如实缺省（不造假数）。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import type { PaperStore } from "../paper/PaperStore.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { LatexImportReport } from "../import/LatexImporter.js";
import { loadBuildGateRecord } from "../quality/gates.js";
import type { ManuscriptRevisionStore } from "./RevisionStore.js";
import type { ManuscriptService } from "./ManuscriptService.js";

/** 稿件进入系统的方式（由落盘事实推导，不新增存储） */
export type ManuscriptSourceType = "latex" | "pdf" | "generated" | "none";

export interface ManuscriptBuildFact {
  passed: boolean;
  checkedAt: string;
  /** 构建时的修订编号 */
  revision: number;
  /** 构建后稿件又前进了（结论已过期，与 Finalize 的 stale 口径一致） */
  stale: boolean;
}

export interface ManuscriptOverview {
  projectId: string;
  title: string;
  /** 标题事实来源：outline（生成式稿件大纲）/ project（项目元数据） */
  titleSource: "outline" | "project";
  sourceType: ManuscriptSourceType;
  /** 0 = 尚无版本事实（刚创建 / 只导入未提交修订） */
  currentRevision: number;
  sectionCount: number;
  referenceCount: number;
  build: ManuscriptBuildFact | null;
}

export interface ManuscriptOverviewServiceOptions {
  projects: ProjectStore;
  revisions: ManuscriptRevisionStore;
  manuscript: ManuscriptService;
  paperStore: PaperStore;
}

export class ManuscriptOverviewService {
  private readonly projects: ProjectStore;
  private readonly revisions: ManuscriptRevisionStore;
  private readonly manuscript: ManuscriptService;
  private readonly paperStore: PaperStore;

  constructor(options: ManuscriptOverviewServiceOptions) {
    this.projects = options.projects;
    this.revisions = options.revisions;
    this.manuscript = options.manuscript;
    this.paperStore = options.paperStore;
  }

  /** 当前稿件聚合（项目不存在 → getRequired 抛 PROJECT_NOT_FOUND） */
  async read(projectId: string): Promise<ManuscriptOverview> {
    const project = await this.projects.getRequired(projectId);
    const latexReport = await this.readLatexImportReport(projectId);
    const outline = await this.manuscript.loadOutline(projectId);
    const hasPaperDoc = await this.paperStore.hasDocument(projectId);

    const sourceType: ManuscriptSourceType =
      latexReport !== null
        ? "latex"
        : hasPaperDoc
          ? "pdf"
          : outline !== null
            ? "generated"
            : "none";

    const sectionCount =
      outline !== null
        ? outline.sections.length
        : (latexReport?.structure.texFiles.length ?? 0);

    const referenceCount = await this.countReferences(projectId, latexReport, hasPaperDoc);

    const revisionState = await this.revisions.load(projectId);
    const buildRecord = await loadBuildGateRecord(this.projects, projectId);

    return {
      projectId,
      title: outline?.title ?? project.title,
      titleSource: outline !== null ? "outline" : "project",
      sourceType,
      currentRevision: revisionState.current,
      sectionCount,
      referenceCount,
      build:
        buildRecord === null
          ? null
          : {
              passed: buildRecord.passed,
              checkedAt: buildRecord.checkedAt,
              revision: buildRecord.revision,
              stale: buildRecord.revision !== revisionState.current,
            },
    };
  }

  /** workflow/import-report.json → 结构事实（损坏 / 缺失 → null，防御性读取） */
  private async readLatexImportReport(
    projectId: string,
  ): Promise<Pick<LatexImportReport, "structure"> | null> {
    try {
      const parsed = JSON.parse(
        await readFile(join(this.projects.workflowDir(projectId), "import-report.json"), "utf8"),
      ) as Partial<LatexImportReport>;
      const structure = parsed.structure;
      if (
        typeof structure?.entryFile !== "string" ||
        !Array.isArray(structure.texFiles) ||
        !structure.texFiles.every((file) => typeof file === "string") ||
        !(
          structure.bibFile === null ||
          structure.bibFile === undefined ||
          typeof structure.bibFile === "string"
        )
      ) {
        return null;
      }
      return {
        structure: {
          entryFile: structure.entryFile,
          texFiles: structure.texFiles,
          bibFile: structure.bibFile ?? null,
          figures: Array.isArray(structure.figures) ? structure.figures : [],
          otherFiles: Array.isArray(structure.otherFiles) ? structure.otherFiles : [],
        },
      };
    } catch {
      return null;
    }
  }

  /**
   * 参考文献条数：优先数 manuscript 里的 bib（生成式 references.bib /
   * LaTeX 工程自带 bib）；无 bib 的 PDF 导入项目用已提取的参考文献数。
   */
  private async countReferences(
    projectId: string,
    latexReport: Pick<LatexImportReport, "structure"> | null,
    hasPaperDoc: boolean,
  ): Promise<number> {
    const bibFile = latexReport?.structure.bibFile ?? "references.bib";
    try {
      const bib = await readFile(
        join(this.projects.manuscriptDir(projectId), bibFile),
        "utf8",
      );
      return countBibEntries(bib);
    } catch {
      // 无 bib 文件 → 继续看 PDF 提取结果
    }
    if (hasPaperDoc) {
      return (await this.paperStore.loadReferences<unknown>(projectId)).length;
    }
    return 0;
  }
}

/** BibTeX 条目计数（排除 @string / @comment / @preamble 伪条目） */
function countBibEntries(bib: string): number {
  const matches = bib.match(/^@[a-zA-Z]+\s*[{(]/gm) ?? [];
  return matches.filter((entry) => !/^@(string|comment|preamble)\b/i.test(entry)).length;
}
