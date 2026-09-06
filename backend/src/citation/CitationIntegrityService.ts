/**
 * Citation Integrity 编排服务（M4.3.3 起）。
 *
 * Stage 化流水线（每个 stage 有输入指纹 + 产物持久化 + 可独立重跑）：
 *   extract   引用条目 + 正文 callout（确定性，本文件）
 *   metadata  文献真实性核验（M4.3.4，ScholarlyResolver）
 *   semantic  (claim, citation) 语义核验（M4.3.5）
 *
 * 第 37 篇引用检索失败不会要求重新 parse PDF——文件粒度记录 + 指纹跳过。
 */

import type { ProjectStore } from "../project/ProjectStore.js";
import { BusinessError } from "../errors.js";
import { fingerprintJson } from "../util/hash.js";
import type { PaperStore, StageRecord } from "../paper/PaperStore.js";
import { ReferenceExtractor, type ExtractionResult } from "../paper/ReferenceExtractor.js";
import type { CitationCallout, ReferenceEntry } from "./integrity.js";

export interface CitationIntegrityOptions {
  projects: ProjectStore;
  store: PaperStore;
  now?: () => Date;
  log?: (message: string) => void;
}

export class CitationIntegrityService {
  private readonly projects: ProjectStore;
  private readonly store: PaperStore;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(options: CitationIntegrityOptions) {
    this.projects = options.projects;
    this.store = options.store;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  /** 提取 stage：references + callouts 提取并持久化（指纹一致则跳过） */
  async extract(
    projectId: string,
    options: { force?: boolean } = {},
  ): Promise<{ result: ExtractionResult; reused: boolean }> {
    await this.projects.getRequired(projectId);
    const document = await this.store.loadDocument(projectId);
    if (document === null) {
      throw new BusinessError("INVALID_REQUEST", "尚未上传/解析 Final PDF（先上传 PDF 再提取引用）");
    }
    const inputFingerprint = fingerprintJson({
      referencesSectionId: document.referencesSectionId ?? null,
      chunks: document.chunks.map((chunk) => `${chunk.chunkId}:${chunk.text}`),
    });
    const stage = (await this.store.loadStages(projectId))["references"];
    const stageMatches =
      stage?.status === "ok" && stage.inputFingerprint === inputFingerprint && !options.force;
    if (stageMatches) {
      const references = await this.store.loadReferences<ReferenceEntry>(projectId);
      const callouts = await this.store.loadCallouts<CitationCallout>(projectId);
      if (references.length > 0 || callouts.length > 0) {
        return {
          result: { references, callouts, notes: [] },
          reused: true,
        };
      }
    }

    const result = new ReferenceExtractor().extract(document);
    await this.store.saveExtraction(projectId, {
      references: result.references,
      callouts: result.callouts,
      notes: result.notes,
    });
    await this.saveStage(projectId, {
      stage: "references",
      status: "ok",
      inputFingerprint,
      outputSummary: {
        referenceCount: result.references.length,
        calloutCount: result.callouts.length,
      },
      updatedAt: this.now().toISOString(),
    });
    this.log(
      `[citation-integrity] projectId=${projectId} 提取完成：references=${result.references.length} callouts=${result.callouts.length}`,
    );
    return { result, reused: false };
  }

  /** 当前提取摘要（供 API / Quality Gate） */
  async summary(projectId: string): Promise<{
    extracted: boolean;
    references: number;
    callouts: number;
    resolvedRelations: number;
    unresolvedRelations: number;
    invalidRelations: number;
    referencesWithDoi: number;
  }> {
    await this.projects.getRequired(projectId);
    const references = await this.store.loadReferences<{ doi?: string }>(projectId);
    const callouts = await this.store.loadCallouts<{
      references: Array<{ status: string }>;
    }>(projectId);
    let resolved = 0;
    let unresolved = 0;
    let invalid = 0;
    for (const callout of callouts) {
      for (const relation of callout.references ?? []) {
        if (relation.status === "resolved") {
          resolved += 1;
        } else if (relation.status === "unresolved") {
          unresolved += 1;
        } else {
          invalid += 1;
        }
      }
    }
    return {
      extracted: references.length > 0 || callouts.length > 0,
      references: references.length,
      callouts: callouts.length,
      resolvedRelations: resolved,
      unresolvedRelations: unresolved,
      invalidRelations: invalid,
      referencesWithDoi: references.filter((reference) => reference.doi !== undefined).length,
    };
  }

  protected async saveStage(projectId: string, record: StageRecord): Promise<void> {
    await this.store.saveStage(projectId, record);
  }
}
