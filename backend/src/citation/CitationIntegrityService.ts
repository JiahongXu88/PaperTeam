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
import type {
  CitationCallout,
  CitationMetadataStatus,
  CitationVerificationRecord,
  ReferenceEntry,
} from "./integrity.js";
import { ScholarlyResolver, type ScholarlyResolverOptions } from "./scholarly.js";

export interface CitationIntegrityOptions {
  projects: ProjectStore;
  store: PaperStore;
  /** scholarly resolver 注入（测试用 fake providers / fetch） */
  scholarly?: ScholarlyResolverOptions;
  /** metadata 核验上限（rate-limit friendly，默认 40） */
  maxMetadataLookups?: number;
  now?: () => Date;
  log?: (message: string) => void;
}

export class CitationIntegrityService {
  private readonly projects: ProjectStore;
  private readonly store: PaperStore;
  private readonly resolver: ScholarlyResolver;
  private readonly maxLookups: number;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  constructor(options: CitationIntegrityOptions) {
    this.projects = options.projects;
    this.store = options.store;
    this.resolver = new ScholarlyResolver(options.scholarly);
    this.maxLookups = options.maxMetadataLookups ?? 40;
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

  // ---- metadata 核验 stage（M4.3.4：确定性外部核验，无 LLM） ----

  /**
   * 逐条核验（文件粒度持久化 + 指纹跳过：第 37 条失败不影响前 36 条，
   * 重跑只补缺失/变化条目）。默认上限 maxLookups 条。
   */
  async verifyMetadata(
    projectId: string,
    options: { force?: boolean } = {},
  ): Promise<{
    byStatus: Record<CitationMetadataStatus, number>;
    checked: number;
    reused: number;
    records: CitationVerificationRecord[];
    telemetry: { providerCalls: number; cacheHits: number; retries: number };
  }> {
    await this.projects.getRequired(projectId);
    const references = await this.store.loadReferences<ReferenceEntry>(projectId);
    if (references.length === 0) {
      throw new BusinessError("INVALID_REQUEST", "尚未提取引用（先 POST /citations/extract）");
    }
    const targets = references.slice(0, this.maxLookups);
    const byStatus: Record<CitationMetadataStatus, number> = {
      VERIFIED: 0,
      METADATA_MISMATCH: 0,
      AMBIGUOUS: 0,
      NOT_FOUND: 0,
      UNRESOLVED: 0,
    };
    const records: CitationVerificationRecord[] = [];
    let reused = 0;
    for (const reference of targets) {
      const existing = await this.store.loadRecord<CitationVerificationRecord>(
        projectId,
        "metadata",
        reference.referenceId,
      );
      if (!options.force && existing !== null && existing.fingerprint === reference.fingerprint) {
        byStatus[existing.status] += 1;
        records.push(existing);
        reused += 1;
        continue;
      }
      const record = await this.verifyReference(projectId, reference);
      byStatus[record.status] += 1;
      records.push(record);
    }
    await this.saveStage(projectId, {
      stage: "metadata",
      status: "ok",
      inputFingerprint: fingerprintJson(targets.map((r) => `${r.referenceId}:${r.fingerprint}`)),
      outputSummary: { ...byStatus, checked: targets.length },
      updatedAt: this.now().toISOString(),
    });
    this.log(
      `[citation-integrity] projectId=${projectId} metadata 核验：checked=${targets.length} reused=${reused} verified=${byStatus.VERIFIED} not_found=${byStatus.NOT_FOUND}`,
    );
    return {
      byStatus,
      checked: targets.length,
      reused,
      records,
      telemetry: {
        providerCalls: this.resolver.telemetry.providerCalls,
        cacheHits: this.resolver.telemetry.cacheHits,
        retries: this.resolver.telemetry.retries,
      },
    };
  }

  private async verifyReference(
    projectId: string,
    reference: ReferenceEntry,
  ): Promise<CitationVerificationRecord> {
    const verdict = await this.resolver.resolve({
      ...(reference.title !== undefined ? { title: reference.title } : {}),
      ...(reference.authors !== undefined ? { authors: reference.authors } : {}),
      ...(reference.year !== undefined ? { year: reference.year } : {}),
      ...(reference.doi !== undefined ? { doi: reference.doi } : {}),
      ...(reference.arxivId !== undefined ? { arxivId: reference.arxivId } : {}),
    });
    const notFoundAttempts = verdict.attempts.filter((attempt) => attempt.outcome === "not_found").length;
    const status: CitationMetadataStatus =
      verdict.outcome === "match"
        ? "VERIFIED"
        : verdict.outcome === "mismatch"
          ? "METADATA_MISMATCH"
          : verdict.outcome === "ambiguous"
            ? "AMBIGUOUS"
            : verdict.outcome === "not_found"
              ? "NOT_FOUND"
              : "UNRESOLVED";
    // probable fabrication = 强证据：全部书目库一致 not_found（≥3 且无 error）+ 有可查字段
    const probableFabrication =
      status === "NOT_FOUND" &&
      notFoundAttempts >= 3 &&
      verdict.attempts.every((attempt) => attempt.outcome === "not_found") &&
      (reference.title !== undefined || reference.doi !== undefined);
    const record: CitationVerificationRecord = {
      referenceId: reference.referenceId,
      status,
      probableFabrication,
      ...(verdict.canonical !== undefined
        ? { canonical: verdict.canonical }
        : verdict.candidates !== undefined && verdict.candidates.length > 0
          ? { canonical: verdict.candidates[0] }
          : {}),
      ...(verdict.mismatches !== undefined ? { mismatches: verdict.mismatches } : {}),
      attempts: verdict.attempts.map((attempt) => ({
        provider: attempt.provider as CitationVerificationRecord["attempts"][number]["provider"],
        outcome:
          attempt.outcome === "match"
            ? "match"
            : attempt.outcome === "mismatch"
              ? "mismatch"
              : attempt.outcome === "not_found"
                ? "not_found"
                : attempt.outcome === "ambiguous"
                  ? "ambiguous"
                  : "error",
        ...(attempt.note !== undefined ? { note: attempt.note } : {}),
      })),
      checkedAt: this.now().toISOString(),
      fingerprint: reference.fingerprint,
      ...(verdict.outcome === "unresolved"
        ? { error: verdict.attempts.find((a) => a.outcome === "error")?.note ?? "多源检索未获结论" }
        : {}),
    };
    await this.store.saveRecord(projectId, "metadata", reference.referenceId, record);
    return record;
  }

  /** 全部 metadata 记录（API 用） */
  async listMetadataRecords(projectId: string): Promise<CitationVerificationRecord[]> {
    await this.projects.getRequired(projectId);
    const ids = await this.store.listRecordIds(projectId, "metadata");
    const records: CitationVerificationRecord[] = [];
    for (const id of ids) {
      const record = await this.store.loadRecord<CitationVerificationRecord>(projectId, "metadata", id);
      if (record !== null) {
        records.push(record);
      }
    }
    return records;
  }
}
