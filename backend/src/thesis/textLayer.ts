/**
 * M14.1b：PyMuPDF 文本层提供者（来源核验的独立通道）。
 *
 * docling TableFormer 给出单元格结构；PyMuPDF 文本层是另一条独立的字符通道。
 * 同一内容版本两者一致 → source_verified。结果按 contentHash 缓存在
 * research/text-layers/，版本变化自动失效（文件名含 hash）。
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import type { PdfParser } from "../paper/PdfParser.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import type { SourceStore } from "../sources/SourceStore.js";
import { writeJsonAtomic } from "../util/atomic.js";
import type { TextLayerPage } from "./sourceVerification.js";

export interface TextLayerProvider {
  pages(projectId: string, sourceId: string, contentHash: string): Promise<TextLayerPage[] | null>;
}

export class PdfTextLayerProvider implements TextLayerProvider {
  constructor(
    private readonly projects: ProjectStore,
    private readonly sources: SourceStore,
    private readonly parser: PdfParser,
    private readonly log: (message: string) => void = () => {},
  ) {}

  private cachePath(projectId: string, sourceId: string, contentHash: string): string {
    return join(this.projects.researchDir(projectId), "text-layers", `${sourceId}-${contentHash.slice(0, 12)}.json`);
  }

  async pages(projectId: string, sourceId: string, contentHash: string): Promise<TextLayerPage[] | null> {
    const item = await this.sources.getRequired(projectId, sourceId);
    if (item.fileName === undefined || !item.fileName.toLowerCase().endsWith(".pdf")) {
      return null;
    }
    const path = this.cachePath(projectId, sourceId, contentHash);
    try {
      const cached = JSON.parse(await readFile(path, "utf8")) as { pages: TextLayerPage[] };
      if (Array.isArray(cached.pages)) return cached.pages;
    } catch {
      // 无缓存 / 损坏 → 重算
    }
    try {
      const extraction = await this.parser.parseFile(await this.sources.filePath(projectId, sourceId));
      const byPage = new Map<number, string[]>();
      for (const block of extraction.blocks) {
        const list = byPage.get(block.page) ?? [];
        list.push(block.text);
        byPage.set(block.page, list);
      }
      const pages = [...byPage.entries()].sort((a, b) => a[0] - b[0]).map(([page, texts]) => ({ page, text: texts.join("\n") }));
      await mkdir(join(this.projects.researchDir(projectId), "text-layers"), { recursive: true });
      await writeJsonAtomic(path, { sourceId, contentHash, parser: extraction.parser, pages });
      return pages;
    } catch (error) {
      this.log(`[research-inputs] ${projectId}/${sourceId} 文本层不可用：${error instanceof Error ? error.message : String(error)}`);
      return null;
    }
  }
}

/** 测试 / 离线：固定页文本 */
export class StaticTextLayerProvider implements TextLayerProvider {
  constructor(private readonly bySource: Map<string, TextLayerPage[]>) {}
  async pages(_projectId: string, sourceId: string): Promise<TextLayerPage[] | null> {
    return this.bySource.get(sourceId) ?? null;
  }
}
