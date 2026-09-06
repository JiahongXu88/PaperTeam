/**
 * Final PDF 持久化（M4.3.1）：项目 workspace 内的 paper/ 子树。
 *
 * 布局（原子写，遵循 ProjectStore 文件持久化约定，不引入数据库）：
 *   {project}/paper/
 *     source/paper.pdf            原始上传（重复上传按 sha256 判定）
 *     parsed/document.json        文档元数据（不含 pages/chunks 明细）
 *     parsed/pages/P00N.json      单页文本
 *     parsed/sections.json        章节区间
 *     parsed/chunks.jsonl         chunk（每行一个）
 *     paper-map.json              PaperMap（M4.3.2）
 *     stages.json                 粗粒度 stage 指纹/状态（可恢复执行）
 *     citation/                   引用核验产物（M4.3.3+）
 *
 * 加载时各部分合并重建完整 PaperDocument；任一部分损坏 → null（重新 ingest）。
 */

import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
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
    await rm(this.stagesPath(projectId), { force: true });
  }
}
