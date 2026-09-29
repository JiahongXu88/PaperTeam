/**
 * FigureAnalysis 持久化（M10.2）。
 *
 * 存储布局（与 parsed / figures / chunks 平行的 derived artifact 层）：
 *   sources/analysis/<sourceId>.vision.json   单 source 全部 figure 分析
 *
 * 纪律（§4）：
 * - ParsedDocument（sources/parsed/<id>.document.json）保持原始 parser 资产，
 *   Vision 结果单独落盘——原始解析可独立重现，Vision 可重新生成，换模型
 *   不污染 ParsedDocument；
 * - derived artifact 口径与 chunk 产物一致：可删除可重建；损坏 / 缺失返回
 *   null（下次 analyze 重建）；写入原子（writeJsonAtomic）；随条目删除清理。
 */

import { mkdir, readFile, rm } from "node:fs/promises";
import { join } from "node:path";

import type { ProjectStore } from "../project/ProjectStore.js";
import { writeJsonAtomic } from "../util/atomic.js";
import type { FigureAnalysis, VisionAnalysisDocument } from "./types.js";

export class FigureAnalysisStore {
  private readonly projects: ProjectStore;

  constructor(projects: ProjectStore) {
    this.projects = projects;
  }

  private analysisDir(projectId: string): string {
    return join(this.projects.sourcesDir(projectId), "analysis");
  }

  private analysisPath(projectId: string, sourceId: string): string {
    return join(this.analysisDir(projectId), `${sourceId}.vision.json`);
  }

  /** 整体落盘（原子写；analyses 为该 source 当前全量终态集合） */
  async save(projectId: string, document: VisionAnalysisDocument): Promise<void> {
    await mkdir(this.analysisDir(projectId), { recursive: true });
    await writeJsonAtomic(this.analysisPath(projectId, document.sourceId), document);
  }

  /** 读取分析产物（缺失 / 损坏 / schema 不符 → null，不炸主链路） */
  async load(projectId: string, sourceId: string): Promise<VisionAnalysisDocument | null> {
    let raw: string;
    try {
      raw = await readFile(this.analysisPath(projectId, sourceId), "utf8");
    } catch (error) {
      if ((error as { code?: string }).code === "ENOENT") {
        return null;
      }
      throw error;
    }
    try {
      const parsed = JSON.parse(raw) as VisionAnalysisDocument;
      if (typeof parsed === "object" && parsed !== null && parsed.schemaVersion === 1 && Array.isArray(parsed.analyses)) {
        return parsed;
      }
      return null;
    } catch {
      // 损坏产物是 derived artifact：返回 null（下次 analyze 重建）
      return null;
    }
  }

  /** 单图分析 upsert（按 figureBlockId 幂等覆盖；增量持久化供轮询观察进度） */
  async upsert(projectId: string, sourceId: string, analysis: FigureAnalysis, now: string): Promise<void> {
    const existing = await this.load(projectId, sourceId);
    const analyses = (existing?.analyses ?? []).filter((entry) => entry.figureBlockId !== analysis.figureBlockId);
    analyses.push(analysis);
    analyses.sort((a, b) => a.figureBlockId.localeCompare(b.figureBlockId));
    await this.save(projectId, {
      schemaVersion: 1,
      sourceId,
      analyses,
      updatedAt: now,
    });
  }

  /** 删除分析产物（随 SourceStore.remove 调用；幂等） */
  async remove(projectId: string, sourceId: string): Promise<void> {
    await rm(this.analysisPath(projectId, sourceId), { force: true });
  }
}
