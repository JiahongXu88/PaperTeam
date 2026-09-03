/**
 * Existing-LaTeX 导入（M3.2 MVP，D-0010）。
 *
 * 只支持 LaTeX 项目（main.tex / sections/ / references.bib / figures/），
 * 不做 DOCX 转换。两种入口：
 *   - importFromArchive：ZIP 归档（防 Zip Slip，见 zipReader）
 *   - importFromFiles：  JSON 内联文件列表（测试 / API 直传）
 *
 * 行为：校验条目 → 识别结构（入口 / 章节 / bib / 图表）→ 原始快照落
 * workflow/imports/<timestamp>/（baseline 快照，可回溯）→ 写入 manuscript/
 * → 生成结构报告 → best-effort Baseline Compile（只记录状态，不作为导入
 * 失败条件：原项目不能编译是事实，不是导入错误）。
 */

import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

import { ImportValidationError } from "../errors.js";
import type { LatexCompiler } from "../latex/LatexCompiler.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { writeJsonAtomic } from "../util/atomic.js";
import { readZipEntries, type ZipLimits } from "./zipReader.js";

export interface ImportFileInput {
  path: string;
  contentBase64: string;
}

export interface LatexImportReport {
  importedAt: string;
  entryCount: number;
  structure: {
    entryFile: string;
    texFiles: string[];
    bibFile: string | null;
    figures: string[];
    otherFiles: string[];
  };
  baselineCompile: {
    attempted: boolean;
    ok: boolean;
    tool: string;
    error?: string;
    logPath?: string;
  };
  warnings: string[];
  snapshotDir: string;
}

export interface LatexImporterOptions {
  projects: ProjectStore;
  latex?: LatexCompiler;
  zipLimits?: ZipLimits;
  now?: () => Date;
  log?: (message: string) => void;
}

/** 允许导入的扩展名（LaTeX 项目相关） */
const ALLOWED_EXTENSIONS: readonly string[] = [
  ".tex",
  ".bib",
  ".cls",
  ".sty",
  ".bst",
  ".png",
  ".jpg",
  ".jpeg",
  ".pdf",
  ".eps",
  ".csv",
  ".txt",
  ".md",
];

export class LatexImporter {
  private readonly projects: ProjectStore;
  private readonly latex?: LatexCompiler;
  private readonly zipLimits?: ZipLimits;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(options: LatexImporterOptions) {
    this.projects = options.projects;
    this.latex = options.latex;
    this.zipLimits = options.zipLimits;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  /** 从 ZIP 归档导入 */
  async importFromArchive(projectId: string, archive: Buffer): Promise<LatexImportReport> {
    let entries: { name: string; data: Buffer }[];
    try {
      entries = readZipEntries(archive, this.zipLimits);
    } catch (error) {
      throw new ImportValidationError(error instanceof Error ? error.message : String(error));
    }
    return this.importEntries(projectId, entries);
  }

  /** 从内联文件列表导入（API JSON / 测试） */
  async importFromFiles(projectId: string, files: ImportFileInput[]): Promise<LatexImportReport> {
    if (!Array.isArray(files) || files.length === 0) {
      throw new ImportValidationError("文件列表为空");
    }
    if (files.length > (this.zipLimits?.maxEntries ?? 500)) {
      throw new ImportValidationError(`文件数超过上限（${this.zipLimits?.maxEntries ?? 500}）`);
    }
    const entries: { name: string; data: Buffer }[] = [];
    for (const file of files) {
      if (typeof file?.path !== "string" || typeof file?.contentBase64 !== "string") {
        throw new ImportValidationError("每个文件需要 path 与 contentBase64");
      }
      if (file.path.includes("\\") || file.path.startsWith("/") || file.path.split("/").includes("..")) {
        throw new ImportValidationError(`非法路径："${file.path}"`);
      }
      let data: Buffer;
      try {
        data = Buffer.from(file.contentBase64, "base64");
      } catch {
        throw new ImportValidationError(`contentBase64 不是合法 base64："${file.path}"`);
      }
      if (data.byteLength === 0) {
        throw new ImportValidationError(`文件内容为空："${file.path}"`);
      }
      entries.push({ name: file.path, data });
    }
    return this.importEntries(projectId, entries);
  }

  // ---- 内部 ----

  private async importEntries(
    projectId: string,
    entries: { name: string; data: Buffer }[],
  ): Promise<LatexImportReport> {
    await this.projects.getRequired(projectId);
    const warnings: string[] = [];

    // 1. 扩展名白名单
    for (const entry of entries) {
      const lower = entry.name.toLowerCase();
      const extension = lower.slice(lower.lastIndexOf("."));
      if (!ALLOWED_EXTENSIONS.includes(extension)) {
        throw new ImportValidationError(
          `不允许的文件类型："${entry.name}"（允许：${ALLOWED_EXTENSIONS.join(" ")}）`,
        );
      }
    }

    // 2. 结构识别
    const texEntries = entries.filter((entry) => entry.name.toLowerCase().endsWith(".tex"));
    if (texEntries.length === 0) {
      throw new ImportValidationError("归档中没有任何 .tex 文件（MVP 仅支持 LaTeX 项目）");
    }
    const mainCandidates = texEntries.filter((entry) =>
      entry.data.toString("utf8").includes("\\documentclass"),
    );
    if (mainCandidates.length === 0) {
      throw new ImportValidationError("找不到入口文件（没有任何 .tex 包含 \\documentclass）");
    }
    const entryFile =
      mainCandidates.find((entry) => entry.name.toLowerCase().endsWith("main.tex"))?.name ??
      mainCandidates.sort((a, b) => b.data.length - a.data.length)[0]!.name;
    if (mainCandidates.length > 1) {
      warnings.push(`发现 ${mainCandidates.length} 个含 \\documentclass 的文件，选用 ${entryFile} 作为入口`);
    }
    const texFiles = texEntries.map((entry) => entry.name);
    const bibEntries = entries.filter((entry) => entry.name.toLowerCase().endsWith(".bib"));
    const bibFile =
      bibEntries.find((entry) => entry.name.toLowerCase().endsWith("references.bib"))?.name ??
      bibEntries[0]?.name ??
      null;
    if (bibEntries.length > 1) {
      warnings.push(`发现 ${bibEntries.length} 个 .bib 文件，选用 ${bibFile}`);
    }
    const figures = entries
      .filter((entry) => /\.(png|jpe?g|pdf|eps)$/i.test(entry.name))
      .map((entry) => entry.name);
    const texAndBib = new Set([...texFiles, ...(bibFile ? [bibFile] : [])]);
    const otherFiles = entries.filter((entry) => !texAndBib.has(entry.name)).map((entry) => entry.name);

    // 3. 原始快照（baseline，可回溯）→ workflow/imports/<ts>/
    const stamp = this.now().toISOString().replaceAll(/[:.]/g, "-");
    const snapshotDirRel = join("workflow", "imports", stamp);
    const snapshotDirAbs = join(this.projects.projectDir(projectId), snapshotDirRel);
    await mkdir(snapshotDirAbs, { recursive: true });
    for (const entry of entries) {
      const target = join(snapshotDirAbs, entry.name);
      await mkdir(dirnameOf(target), { recursive: true });
      await writeFile(target, entry.data);
    }

    // 4. 写入 manuscript/（保留相对路径）
    const manuscriptDir = this.projects.manuscriptDir(projectId);
    for (const entry of entries) {
      const target = join(manuscriptDir, entry.name);
      await mkdir(dirnameOf(target), { recursive: true });
      await writeFile(target, entry.data);
    }

    // 5. Baseline Compile（best-effort：只记录，不作为导入失败条件）
    const baseline = await this.baselineCompile(projectId, entryFile);

    // 6. 标记项目为 existing_paper_improvement
    await this.projects.updateMeta(projectId, { workflowKind: "existing_paper_improvement" });

    const report: LatexImportReport = {
      importedAt: this.now().toISOString(),
      entryCount: entries.length,
      structure: { entryFile, texFiles, bibFile, figures, otherFiles },
      baselineCompile: baseline,
      warnings,
      snapshotDir: snapshotDirRel.replaceAll("\\", "/"),
    };
    await writeJsonAtomic(
      join(this.projects.projectDir(projectId), "workflow", "import-report.json"),
      report,
    );
    this.log(
      `[import] projectId=${projectId} 导入完成：${entries.length} 文件，入口 ${entryFile}，baseline ${baseline.ok ? "ok" : "failed"}`,
    );
    return report;
  }

  private async baselineCompile(
    projectId: string,
    entryFile: string,
  ): Promise<LatexImportReport["baselineCompile"]> {
    if (this.latex === undefined) {
      return { attempted: false, ok: false, tool: "unknown", error: "未配置 LaTeX 编译器" };
    }
    if (entryFile !== "main.tex") {
      // 入口不是 main.tex：复制为 main.tex 再编译（保持编译入口约定）
      const { copyFile } = await import("node:fs/promises");
      await copyFile(
        join(this.projects.manuscriptDir(projectId), entryFile),
        join(this.projects.manuscriptDir(projectId), "main.tex"),
      ).catch(() => undefined);
    }
    try {
      const compile = await this.latex.compile({
        manuscriptDir: this.projects.manuscriptDir(projectId),
        buildDir: this.projects.buildDir(projectId),
      });
      return {
        attempted: true,
        ok: true,
        tool: compile.tool,
        ...(compile.logPath !== null ? { logPath: "build/compile.log" } : {}),
      };
    } catch (error) {
      const message =
        error instanceof Error
          ? `${error.message}${
              "detail" in error && typeof (error as { detail?: unknown }).detail === "string"
                ? `：${(error as { detail: string }).detail}`
                : ""
            }`
          : String(error);
      return { attempted: true, ok: false, tool: "unknown", error: message, logPath: "build/compile.log" };
    }
  }
}

function dirnameOf(path: string): string {
  const parts = path.split(/[\\/]/);
  parts.pop();
  return parts.join("/") || ".";
}
