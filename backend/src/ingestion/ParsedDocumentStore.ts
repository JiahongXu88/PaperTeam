/**
 * ParsedDocument 持久化（M10.1A）。
 *
 * 存储布局（与 sources/parsed/<id>.json 的 PdfAnalysis 摘要并列、互不干扰）：
 *   sources/parsed/<sourceId>.document.json   ParsedDocument（结构化解析产物）
 *   sources/figures/<sourceId>/               抽取的图片资产（fig-001.png…）
 *
 * derived artifact 口径与 chunk 产物一致：可删除可重建；freshness 以
 * contentHash 判据（isDocumentFresh）。写入原子（writeJsonAtomic）。
 */

import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import type { ProjectStore } from "../project/ProjectStore.js";
import { writeJsonAtomic } from "../util/atomic.js";
import { normalizeCounts, type ParsedDocument } from "./types.js";

export class ParsedDocumentStore {
  private readonly projects: ProjectStore;

  constructor(projects: ProjectStore) {
    this.projects = projects;
  }

  private documentPath(projectId: string, sourceId: string): string {
    return join(this.projects.sourcesDir(projectId), "parsed", `${sourceId}.document.json`);
  }

  /** 图片资产目录（DoclingParser 输出目标；按 source 隔离，随条目删除清理） */
  figuresDir(projectId: string, sourceId: string): string {
    return join(this.projects.sourcesDir(projectId), "figures", sourceId);
  }

  async save(projectId: string, document: ParsedDocument): Promise<void> {
    const dir = join(this.projects.sourcesDir(projectId), "parsed");
    await mkdir(dir, { recursive: true });
    await writeJsonAtomic(this.documentPath(projectId, document.sourceId), document);
  }

  async load(projectId: string, sourceId: string): Promise<ParsedDocument | null> {
    let raw: string;
    try {
      raw = await readFile(this.documentPath(projectId, sourceId), "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as ParsedDocument;
      if (typeof parsed === "object" && parsed !== null && parsed.schemaVersion === 1) {
        // counts 归一：M10.1.1 前的老产物缺 code/output 键——补 0（不覆盖已有值）
        parsed.counts = normalizeCounts(parsed.counts);
        return parsed;
      }
      return null;
    } catch {
      // 损坏产物是 derived artifact：返回 null（下次 ingest 重建），不炸主链路
      return null;
    }
  }

  /** 删除解析产物与图片资产（随 SourceStore.remove 调用；幂等） */
  async remove(projectId: string, sourceId: string): Promise<void> {
    await rm(this.documentPath(projectId, sourceId), { force: true });
    await rm(this.figuresDir(projectId, sourceId), { force: true, recursive: true });
  }
}
