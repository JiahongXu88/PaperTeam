/**
 * Final PDF 持久化：项目 workspace 内的 paper/ 子树。
 *
 * 布局（原子写，遵循 ProjectStore 文件持久化约定，不引入数据库）：
 *   {project}/paper/
 *     source/paper.pdf            原始上传（重复上传按 sha256 判定）
 *     parsed/document.json        文档元数据（不含 pages/chunks 明细）
 *     parsed/pages/P00N.json      单页文本
 *     parsed/sections.json        章节区间
 *     parsed/chunks.jsonl         chunk（每行一个）
 *     paper-map.json              PaperMap
 *     stages.json                 粗粒度 stage 指纹/状态（可恢复执行）
 *     citation/                   引用核验产物
 *
 * 加载时各部分合并重建完整 PaperDocument；任一部分损坏 → null（重新 ingest）。
 */

import { mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";

import type { ProjectStore } from "../project/ProjectStore.js";
import {
  type PaperChunk,
  type PaperDocument,
  type PaperMap,
  type PaperPage,
  type PaperSection,
  isPaperChunk,
  isPaperSection,
  readPaperDocument,
  readPaperMap,
} from "./types.js";
import { writeJsonAtomic } from "../util/atomic.js";

export interface StageRecord {
  stage: string;
  status: "ok" | "failed" | "running";
  inputFingerprint: string;
  outputSummary?: Record<string, unknown>;
  error?: string;
  updatedAt: string;
}

export class PaperStore {
  private readonly projects: ProjectStore;

  constructor(projects: ProjectStore) {
    this.projects = projects;
  }

  private root(projectId: string): string {
    return join(this.projects.projectDir(projectId), "paper");
  }

  sourcePath(projectId: string): string {
    return join(this.root(projectId), "source", "paper.pdf");
  }

  private parsedDir(projectId: string): string {
    return join(this.root(projectId), "parsed");
  }

  private pagesDir(projectId: string): string {
    return join(this.parsedDir(projectId), "pages");
  }

  private mapPath(projectId: string): string {
    return join(this.root(projectId), "paper-map.json");
  }

  private stagesPath(projectId: string): string {
    return join(this.root(projectId), "stages.json");
  }

  citationDir(projectId: string): string {
    return join(this.root(projectId), "citation");
  }

  // ---- 引用核验产物（references / callouts / metadata / claims） ----

  async saveExtraction(
    projectId: string,
    data: { references: unknown[]; callouts: unknown[]; notes?: string[] },
  ): Promise<void> {
    const dir = this.citationDir(projectId);
    await mkdir(dir, { recursive: true });
    await writeJsonAtomic(join(dir, "references.json"), data.references);
    await writeJsonAtomic(join(dir, "callouts.json"), data.callouts);
    if (data.notes !== undefined && data.notes.length > 0) {
      await writeJsonAtomic(join(dir, "notes.json"), data.notes);
    }
  }

  async loadReferences<T>(projectId: string): Promise<T[]> {
    try {
      const raw = JSON.parse(
        await readFile(join(this.citationDir(projectId), "references.json"), "utf8"),
      ) as unknown[];
      return Array.isArray(raw) ? (raw as T[]) : [];
    } catch {
      return [];
    }
  }

  async loadCallouts<T>(projectId: string): Promise<T[]> {
    try {
      const raw = JSON.parse(
        await readFile(join(this.citationDir(projectId), "callouts.json"), "utf8"),
      ) as unknown[];
      return Array.isArray(raw) ? (raw as T[]) : [];
    } catch {
      return [];
    }
  }

  /** 单条核验记录 upsert（文件粒度：第 37 条失败不牵连其他条目） */
  async saveRecord(
    projectId: string,
    kind: "metadata" | "claims" | "decomposition",
    id: string,
    record: unknown,
  ): Promise<void> {
    const dir = join(this.citationDir(projectId), kind);
    await mkdir(dir, { recursive: true });
    await writeJsonAtomic(join(dir, `${id}.json`), record);
  }

  async loadRecord<T>(
    projectId: string,
    kind: "metadata" | "claims" | "decomposition",
    id: string,
  ): Promise<T | null> {
    try {
      return JSON.parse(
        await readFile(join(this.citationDir(projectId), kind, `${id}.json`), "utf8"),
      ) as T;
    } catch {
      return null;
    }
  }

  async listRecordIds(
    projectId: string,
    kind: "metadata" | "claims" | "decomposition",
  ): Promise<string[]> {
    try {
      const names = await readdir(join(this.citationDir(projectId), kind));
      return names
        .map((name) => /^([A-Za-z][A-Za-z0-9_-]*)\.json$/.exec(name)?.[1])
        .filter((id): id is string => id !== undefined)
        .sort();
    } catch {
      return [];
    }
  }

  // ---- section review journal（per-section 完成记录；run 级隔离） ----

  /**
   * 分章节审阅的完成记录：一节一文件（paper/review-sections/<runId>/<sectionId>.json）。
   *
   * 并发写入安全：每个 section 写自己的文件（原子写），没有跨 worker 的
   * read-modify-write——LLM 调用完全并发，磁盘 commit 天然无竞争，无需
   * 串行化队列。runId 维度隔离：stage 重试 / 进程崩溃恢复（同一 runId）
   * 可复用已完成章节；新的 workflow run（新 runId）从头审阅，不串台。
   */
  async saveSectionReviewRecord(
    projectId: string,
    runId: string,
    record: { sectionId: string } & Record<string, unknown>,
  ): Promise<void> {
    const dir = join(this.root(projectId), "review-sections", runId);
    await mkdir(dir, { recursive: true });
    await writeJsonAtomic(join(dir, `${sanitizeId(record.sectionId)}.json`), record);
  }

  /** 读取某个 run 的全部 section review 完成记录（损坏文件跳过；不存在的 run 返回空表） */
  async loadSectionReviewRecords(
    projectId: string,
    runId: string,
  ): Promise<Map<string, Record<string, unknown>>> {
    const out = new Map<string, Record<string, unknown>>();
    const dir = join(this.root(projectId), "review-sections", runId);
    let names: string[];
    try {
      names = await readdir(dir);
    } catch {
      return out;
    }
    for (const name of names) {
      const id = /^([A-Za-z0-9_-]+)\.json$/.exec(name)?.[1];
      if (id === undefined) {
        continue;
      }
      try {
        const parsed = JSON.parse(await readFile(join(dir, name), "utf8")) as Record<string, unknown>;
        // 以记录体内的 sectionId 为准（文件名只是寻址），保证恢复语义不受改名影响
        if (typeof parsed["sectionId"] === "string" && parsed["sectionId"] !== "") {
          out.set(parsed["sectionId"], parsed);
        }
      } catch {
        // 单条损坏不牵连其它章节记录
      }
    }
    return out;
  }

  // ---- ingest（写入全部产物） ----

  async saveIngest(projectId: string, document: PaperDocument): Promise<void> {
    const root = this.root(projectId);
    await mkdir(join(root, "source"), { recursive: true });
    await mkdir(this.pagesDir(projectId), { recursive: true });
    await writeJsonAtomic(
      join(this.parsedDir(projectId), "sections.json"),
      document.sections,
    );
    const chunkLines = document.chunks.map((chunk) => JSON.stringify(chunk));
    await writeFile(join(this.parsedDir(projectId), "chunks.jsonl"), chunkLines.join("\n") + "\n", "utf8");
    for (const page of document.pages) {
      await writeJsonAtomic(join(this.pagesDir(projectId), `${page.pageId}.json`), page);
    }
    // document.json（不含明细，作为索引与提交标记）最后写
    await writeJsonAtomic(join(this.parsedDir(projectId), "document.json"), {
      ...document,
      pages: [],
      chunks: [],
    });
  }

  /** 保存上传的原始 PDF bytes（在解析前落盘；解析失败也有原料可重试） */
  async saveSource(projectId: string, content: Buffer): Promise<void> {
    await mkdir(join(this.root(projectId), "source"), { recursive: true });
    await writeFile(this.sourcePath(projectId), content);
  }

  /** 加载完整文档（各部分合并；缺任一部分返回 null） */
  async loadDocument(projectId: string): Promise<PaperDocument | null> {
    try {
      const base = JSON.parse(
        await readFile(join(this.parsedDir(projectId), "document.json"), "utf8"),
      ) as Record<string, unknown>;
      const pages: PaperPage[] = [];
      const pageCount = typeof base["parse"] === "object" && base["parse"] !== null
        ? Number((base["parse"] as Record<string, unknown>)["pageCount"] ?? 0)
        : 0;
      for (let pageNumber = 1; pageNumber <= pageCount; pageNumber += 1) {
        const pageId = `P${String(pageNumber).padStart(3, "0")}`;
        try {
          pages.push(
            JSON.parse(
              await readFile(join(this.pagesDir(projectId), `${pageId}.json`), "utf8"),
            ) as PaperPage,
          );
        } catch {
          // 单页缺失：该页为空文本页（blocks 为空的页不写文件），补空页保持页序
          pages.push({ pageId, pageNumber, text: "", charCount: 0 });
        }
      }
      const sections = (
        JSON.parse(
          await readFile(join(this.parsedDir(projectId), "sections.json"), "utf8"),
        ) as unknown[]
      )
        .map(isPaperSection)
        .filter((section): section is PaperSection => section !== undefined);
      const chunkLines = (
        await readFile(join(this.parsedDir(projectId), "chunks.jsonl"), "utf8")
      )
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as unknown)
        .map(isPaperChunk)
        .filter((chunk): chunk is PaperChunk => chunk !== undefined);
      return readPaperDocument({ ...base, pages, sections, chunks: chunkLines });
    } catch {
      return null;
    }
  }

  /** 单独加载 chunks（review 任务的主要输入；无需组装完整文档） */
  async loadChunks(projectId: string): Promise<PaperChunk[]> {
    try {
      const raw = await readFile(join(this.parsedDir(projectId), "chunks.jsonl"), "utf8");
      return raw
        .split("\n")
        .filter((line) => line.trim() !== "")
        .map((line) => JSON.parse(line) as unknown)
        .map(isPaperChunk)
        .filter((chunk): chunk is PaperChunk => chunk !== undefined);
    } catch {
      return [];
    }
  }

  async loadSections(projectId: string): Promise<PaperSection[]> {
    try {
      const raw = JSON.parse(
        await readFile(join(this.parsedDir(projectId), "sections.json"), "utf8"),
      ) as unknown[];
      return raw
        .map(isPaperSection)
        .filter((section): section is PaperSection => section !== undefined);
    } catch {
      return [];
    }
  }

  // ---- PaperMap ----

  async saveMap(projectId: string, map: PaperMap): Promise<void> {
    await mkdir(this.root(projectId), { recursive: true });
    await writeJsonAtomic(this.mapPath(projectId), map);
  }

  async loadMap(projectId: string): Promise<PaperMap | null> {
    try {
      return readPaperMap(JSON.parse(await readFile(this.mapPath(projectId), "utf8")));
    } catch {
      return null;
    }
  }

  // ---- stages（粗粒度可恢复执行记录） ----

  async loadStages(projectId: string): Promise<Record<string, StageRecord>> {
    try {
      const raw = JSON.parse(await readFile(this.stagesPath(projectId), "utf8")) as Record<
        string,
        unknown
      >;
      const out: Record<string, StageRecord> = {};
      for (const [stage, value] of Object.entries(raw)) {
        if (
          typeof value === "object" &&
          value !== null &&
          typeof (value as Record<string, unknown>)["inputFingerprint"] === "string"
        ) {
          out[stage] = value as unknown as StageRecord;
        }
      }
      return out;
    } catch {
      return {};
    }
  }

  async saveStage(projectId: string, record: StageRecord): Promise<void> {
    const stages = await this.loadStages(projectId);
    stages[record.stage] = record;
    await mkdir(this.root(projectId), { recursive: true });
    await writeJsonAtomic(this.stagesPath(projectId), stages);
  }

  // ---- 清理（替换上传时移除派生产物，原料重新解析） ----

  async clearDerived(projectId: string): Promise<void> {
    await rm(this.parsedDir(projectId), { recursive: true, force: true });
    await rm(this.mapPath(projectId), { force: true });
    await rm(this.citationDir(projectId), { recursive: true, force: true });
    await rm(join(this.root(projectId), "review-sections"), { recursive: true, force: true });
    await rm(this.stagesPath(projectId), { force: true });
  }
}

/** 记录文件名安全化（sectionId 实际恒为 SEC01 形态；此处防御性兜底） */
function sanitizeId(id: string): string {
  return id.replaceAll(/[^A-Za-z0-9_-]/g, "_");
}
