/**
 * PaperMapService：PaperMap 的构建与章节摘要。
 *
 * 长文档 Review 反模式（本轮要解决的核心问题）：
 *   整篇 PDF + 全部历史 + 全部 Evidence 塞进一个不断增长的 Agent Session
 *   → context 膨胀 → compaction → 重新上传 → 超时 → 中途失败。
 *
 * PaperTeam 模式：
 *   PDF → 确定性解析 → PaperMap（导航图）→ 每个 section 一个短生命周期
 *   Review Task（只带：论文概览 + 目标 section chunks + 其他 section 摘要）。
 * Workspace 持久化是事实源；Pi Session 只是可丢弃执行上下文。
 *
 * 摘要纪律：
 * - 单 section 输入（截断），一次调用，失败不阻塞 Map（status=failed 可重跑）；
 * - 模型不可用 → 摘要 pending，Map 骨架照常落盘（确定性部分不依赖模型）；
 * - chunk 指纹变化 → 摘要 stale，下次刷新。
 */

import type { AgentRuntime } from "../runtime/types.js";
import type { ProjectStore } from "../project/ProjectStore.js";
import { BusinessError } from "../errors.js";
import { fingerprintJson } from "../util/hash.js";
import { assertValidConcurrency, mapWithConcurrency } from "../util/concurrency.js";
import type { PaperMap } from "./types.js";
import { summaryNeedsRefresh, type PaperSectionSummary } from "./sectionSummary.js";
import type { PaperStore } from "./PaperStore.js";
import type { PaperMapSummaryMode } from "./reviewRunModes.js";

/** 单 section 摘要输入截断（字符） */
const SUMMARY_INPUT_MAX_CHARS = 6000;

/** batched 模式：单批最多章节数（防止响应过长导致后段章节摘要质量塌陷） */
const BATCH_MAX_SECTIONS = 8;
/** batched 模式：单批输入字符上限（各节输入仍按 SUMMARY_INPUT_MAX_CHARS 截断） */
const BATCH_INPUT_MAX_CHARS = 40_000;

export interface PaperMapServiceOptions {
  projects: ProjectStore;
  store: PaperStore;
  runtime: AgentRuntime;
  /** Reviewer agent id（摘要生成走 reviewer 角色 scope） */
  reviewerAgentId: string;
  /** 章节摘要有界并发度（活跃模型调用上限；PAPERTEAM_SUMMARY_CONCURRENCY） */
  concurrency?: number;
  now?: () => Date;
  log?: (message: string) => void;
}

/** ensureMap 的刷新选项 */
export interface EnsureMapOptions {
  refreshSummaries?: boolean;
  signal?: AbortSignal;
  /**
   * 摘要生成模式（M15.12 B1）：
   * - per-section（缺省，旧行为）：每章节一次调用；
   * - batched：多章节合并为一次调用（每批 ≤BATCH_MAX_SECTIONS 节、≤BATCH_INPUT_MAX_CHARS 字符），
   *   摘要存储格式/指纹语义/失败语义与 per-section 完全一致（批内单节缺失=该节 failed 可重跑）。
   */
  summaryMode?: PaperMapSummaryMode;
}

export class PaperMapService {
  private readonly store: PaperStore;
  private readonly runtime: AgentRuntime;
  private readonly reviewerAgentId: string;
  private readonly concurrency: number;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  /** batched 模式的批次序号（contextScope 编号用；实例生命周期内递增） */
  private batchCounter = 0;

  /** 最近一次 ensureMap 的 telemetry（模型调用数等；诊断用） */
  lastTelemetry:
    | {
        modelCalls: number;
        summariesRefreshed: number;
        failures: number;
        /** 本轮摘要并发度（1 = 串行） */
        concurrency: number;
        wallMs: number;
        /** 各节摘要时长之和（与 wallMs 的比值 ≈ 有效并发度） */
        sumSectionDurationMs: number;
        /** batched 模式：实际执行的批数（modelCalls 应相等） */
        batches?: number;
      }
    | undefined;

  constructor(options: PaperMapServiceOptions) {
    this.store = options.store;
    this.runtime = options.runtime;
    this.reviewerAgentId = options.reviewerAgentId;
    this.concurrency = options.concurrency ?? 3;
    assertValidConcurrency(this.concurrency, "summaryConcurrency");
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  /**
   * 构建/刷新 PaperMap：
   * 1. 确定性骨架（sections/counts/指纹）——总是重算落盘；
   * 2. 章节摘要——仅刷新缺失/失败/stale 的（已有摘要按指纹复用，不重复烧 token），
   *    有界并发执行；失败不阻塞其它节，Map 照常落盘。
   *    模式（M15.12 B1）：per-section（每节一调用）/ batched（多节合并一调用）。
   */
  async ensureMap(projectId: string, options: EnsureMapOptions = {}): Promise<PaperMap> {
    const document = await this.store.loadDocument(projectId);
    if (document === null) {
      throw new BusinessError(
        "INVALID_REQUEST",
        "尚未上传/解析 Final PDF（先 POST /api/projects/:id/paper/pdf）",
      );
    }
    const previous = await this.store.loadMap(projectId);
    const previousSummaries = new Map(
      (previous?.sections ?? [])
        .filter((section) => section.summary !== undefined)
        .map((section) => [section.sectionId, section.summary!]),
    );

    const startedAt = Date.now();
    const telemetry: {
      modelCalls: number;
      summariesRefreshed: number;
      failures: number;
      batches?: number;
    } = {
      modelCalls: 0,
      summariesRefreshed: 0,
      failures: 0,
    };
    if (options.summaryMode === "batched") {
      telemetry.batches = 0;
    }
    const sectionDurations: number[] = [];
    const summaryMode: PaperMapSummaryMode = options.summaryMode ?? "per-section";

    // 每节确定性事实（两种模式共用）：chunks/指纹/复用判定/摘要输入
    interface SectionWork {
      sectionId: string;
      title: string;
      level: number;
      pageStart: number;
      pageEnd: number;
      chunkCount: number;
      charCount: number;
      fingerprint: string;
      summary: PaperSectionSummary; // 复用命中 = prior；否则待生成
      needsGeneration: boolean;
      input: string; // 摘要输入（截断后；空 = 无文本，直接 failed 不调模型）
    }
    const works: SectionWork[] = document.sections.map((section) => {
      const chunks = document.chunks.filter((chunk) => chunk.sectionId === section.sectionId);
      const fingerprint = fingerprintJson(chunks.map((chunk) => chunk.chunkId + ":" + chunk.text));
      const prior = previousSummaries.get(section.sectionId);
      const input = chunks
        .map((chunk) => chunk.text)
        .join("\n\n")
        .slice(0, SUMMARY_INPUT_MAX_CHARS);
      const empty = input.trim() === "";
      const reusable = prior !== undefined && !summaryNeedsRefresh(prior, fingerprint);
      const needsGeneration =
        !reusable && options.refreshSummaries !== false && !empty;
      return {
        sectionId: section.sectionId,
        title: section.title,
        level: section.level,
        pageStart: section.pageStart,
        pageEnd: section.pageEnd,
        chunkCount: chunks.length,
        charCount: section.charCount,
        fingerprint,
        summary: reusable
          ? prior!
          : options.refreshSummaries === false
            ? { sectionId: section.sectionId, status: "pending", sourceFingerprint: fingerprint }
            : empty
              ? { sectionId: section.sectionId, status: "failed", error: "章节无文本", sourceFingerprint: fingerprint }
              : { sectionId: section.sectionId, status: "pending", sourceFingerprint: fingerprint },
        needsGeneration,
        input,
      };
    });

    // 待生成集合（文档顺序保持稳定）
    const pending = works.filter((work) => work.needsGeneration);
    if (pending.length > 0 && options.refreshSummaries !== false) {
      if (summaryMode === "batched") {
        // 批次间有界并发（单批内部一次调用）；批失败/缺节 → 逐节 failed 可重跑，
        // 不阻塞 Map 落盘（与 per-section 的失败语义一致）
        await mapWithConcurrency(
          partitionBatches(pending),
          this.concurrency,
          async (batch) => {
            const batchStartedAt = Date.now();
            telemetry.modelCalls += 1;
            telemetry.batches = (telemetry.batches ?? 0) + 1;
            const outcomes = await this.summarizeBatch(projectId, batch, options.signal);
            for (const work of batch) {
              const outcome = outcomes.get(work.sectionId);
              if (outcome !== undefined && outcome.status === "ok") {
                telemetry.summariesRefreshed += 1;
                work.summary = outcome;
              } else {
                telemetry.failures += 1;
                work.summary =
                  outcome ?? {
                    sectionId: work.sectionId,
                    status: "failed",
                    error: "批量摘要结果缺失",
                    sourceFingerprint: work.fingerprint,
                  };
              }
            }
            sectionDurations.push(Date.now() - batchStartedAt);
          },
          { signal: options.signal },
        );
      } else {
        await mapWithConcurrency(
          pending,
          this.concurrency,
          async (work) => {
            const sectionStartedAt = Date.now();
            work.summary = await this.summarizeSection(
              projectId,
              work.sectionId,
              work.title,
              work.input,
              work.fingerprint,
              options.signal,
            );
            sectionDurations.push(Date.now() - sectionStartedAt);
            telemetry.modelCalls += 1;
            if (work.summary.status === "ok") {
              telemetry.summariesRefreshed += 1;
            } else {
              telemetry.failures += 1;
            }
          },
          { signal: options.signal },
        );
      }
    }

    if (options.signal?.aborted === true) {
      // 与串行版口径一致：取消时不再落盘半成品 Map
      throw new BusinessError("WORKFLOW_CANCELLED", "PaperMap 摘要生成已被取消");
    }

    // 结果按文档顺序组装（与解析顺序一致，确定性输出）
    const sections = works.map((work) => ({
      sectionId: work.sectionId,
      title: work.title,
      level: work.level,
      pageStart: work.pageStart,
      pageEnd: work.pageEnd,
      chunkCount: work.chunkCount,
      charCount: work.charCount,
      summary: work.summary,
    }));

    const map: PaperMap = {
      schemaVersion: 1,
      ...(document.title !== undefined ? { documentTitle: document.title } : {}),
      ...(document.abstractSectionId !== undefined || document.title !== undefined
        ? {
            abstract: (
              await this.readAbstract(projectId, document.abstractSectionId)
            ),
          }
        : {}),
      pageCount: document.parse.pageCount,
      sections,
      generatedAt: this.now().toISOString(),
      sourceFingerprint: document.sha256,
    };
    await this.store.saveMap(projectId, map);
    this.lastTelemetry = {
      ...telemetry,
      concurrency: this.concurrency,
      wallMs: Date.now() - startedAt,
      sumSectionDurationMs: sectionDurations.reduce((sum, value) => sum + value, 0),
    };
    this.log(
      `[paper-map] projectId=${projectId} sections=${sections.length} summaries刷新=${telemetry.summariesRefreshed} 失败=${telemetry.failures}`,
    );
    return map;
  }

  private async readAbstract(projectId: string, abstractSectionId: string | undefined): Promise<string | undefined> {
    if (abstractSectionId === undefined) {
      return undefined;
    }
    const document = await this.store.loadDocument(projectId);
    if (document === null) {
      return undefined;
    }
    const chunks = document.chunks.filter((chunk) => chunk.sectionId === abstractSectionId);
    return chunks.map((chunk) => chunk.text).join("\n\n").slice(0, 2000) || undefined;
  }

  /** 单 section 摘要（短生命周期任务：独立 contextScope，输入只有该 section chunks） */
  private async summarizeSection(
    projectId: string,
    sectionId: string,
    title: string,
    input: string,
    fingerprint: string,
    signal?: AbortSignal,
  ): Promise<PaperSectionSummary> {
    if (input.trim() === "") {
      return { sectionId, status: "failed", error: "章节无文本", sourceFingerprint: fingerprint };
    }
    const scope = `review/summary/${sectionId.toLowerCase()}`;
    try {
      const task = await this.runtime.runAgent({
        agentId: this.reviewerAgentId,
        projectId,
        contextScope: scope,
        ...(signal !== undefined ? { signal } : {}),
        task: [
          "你是论文审稿助手。对下面这一章节的内容写 2-4 句中文摘要（客观概述：主题、方法/论点、关键内容），",
          "不要评价、不要建议、不要输出任何标题或 Markdown 格式，直接输出摘要正文。",
          "",
          `章节标题：${title}`,
          "章节内容：",
          input,
        ].join("\n"),
        metadata: { role: "reviewer" },
      });
      if (task.status !== "completed" || (task.output ?? "").trim() === "") {
        return {
          sectionId,
          status: "failed",
          error: task.error ?? "模型未返回摘要",
          sourceFingerprint: fingerprint,
        };
      }
      return {
        sectionId,
        status: "ok",
        summary: task.output!.trim().slice(0, 1200),
        model: task.metadata?.["model"] as string | undefined,
        generatedAt: this.now().toISOString(),
        sourceFingerprint: fingerprint,
      };
    } catch (error) {
      return {
        sectionId,
        status: "failed",
        error: error instanceof Error ? error.message : String(error),
        sourceFingerprint: fingerprint,
      };
    }
  }

  /**
   * 批量摘要（M15.12 B1，summaryMode=batched）：一次调用生成多节摘要。
   * 语义与 per-session 版一致：输出仍是逐节 PaperSectionSummary（同指纹、同状态机）；
   * 响应缺某节 / 整体解析失败 → 该节（或整批）status=failed，可重跑，不阻塞 Map 落盘。
   */
  private async summarizeBatch(
    projectId: string,
    batch: Array<{ sectionId: string; title: string; input: string; fingerprint: string }>,
    signal?: AbortSignal,
  ): Promise<Map<string, PaperSectionSummary>> {
    const failed = (error: string) =>
      new Map<string, PaperSectionSummary>(
        batch.map((work) => [
          work.sectionId,
          { sectionId: work.sectionId, status: "failed", error, sourceFingerprint: work.fingerprint },
        ]),
      );
    const sectionsBlock = batch
      .map(
        (work) =>
          [`【章节 ${work.sectionId}】标题：${work.title}`, "内容：", work.input].join("\n"),
      )
      .join("\n\n");
    const scope = `review/summary-batch/batch${String(this.batchCounter + 1).padStart(2, "0")}`;
    this.batchCounter += 1;
    try {
      const task = await this.runtime.runAgent({
        agentId: this.reviewerAgentId,
        projectId,
        contextScope: scope,
        ...(signal !== undefined ? { signal } : {}),
        task: [
          "你是论文审稿助手。对下面给出的每一个章节分别写 2-4 句中文摘要（客观概述：主题、方法/论点、关键内容）。",
          "各章节摘要相互独立；不要评价、不要建议、不要输出标题或 Markdown 格式。",
          "输出一个 JSON 对象（不要代码围栏、不要多余文字），格式：",
          '{"summaries": [{"sectionId": "SEC01", "summary": "……"}, {"sectionId": "SEC02", "summary": "……"}]}',
          "sectionId 必须与输入一致、覆盖输入中的每一个章节。",
          "",
          sectionsBlock,
        ].join("\n"),
        metadata: { role: "reviewer", pass: "summary-batch" },
      });
      if (task.status !== "completed" || (task.output ?? "").trim() === "") {
        return failed(task.error ?? "模型未返回批量摘要");
      }
      const raw = task.output ?? "";
      let parsed: unknown;
      try {
        parsed = JSON.parse(stripCodeFence(raw.trim()));
      } catch {
        const start = raw.indexOf("{");
        const end = raw.lastIndexOf("}");
        if (start === -1 || end <= start) {
          return failed("批量摘要输出不可解析");
        }
        try {
          parsed = JSON.parse(raw.slice(start, end + 1));
        } catch {
          return failed("批量摘要输出不可解析");
        }
      }
      const container = parsed as { summaries?: unknown };
      const list = Array.isArray(container?.summaries) ? container.summaries : undefined;
      if (list === undefined) {
        return failed("批量摘要输出缺少 summaries 数组");
      }
      const timestamp = this.now().toISOString();
      const byId = new Map<string, PaperSectionSummary>();
      for (const entry of list) {
        if (typeof entry !== "object" || entry === null) {
          continue;
        }
        const record = entry as Record<string, unknown>;
        const sectionId = typeof record["sectionId"] === "string" ? record["sectionId"] : undefined;
        const summary = typeof record["summary"] === "string" ? record["summary"].trim() : "";
        if (sectionId === undefined || summary === "") {
          continue;
        }
        byId.set(sectionId, {
          sectionId,
          status: "ok",
          summary: summary.slice(0, 1200),
          model: task.metadata?.["model"] as string | undefined,
          generatedAt: timestamp,
          sourceFingerprint:
            batch.find((work) => work.sectionId === sectionId)?.fingerprint ?? "",
        });
      }
      const outcomes = new Map<string, PaperSectionSummary>();
      for (const work of batch) {
        const ok = byId.get(work.sectionId);
        outcomes.set(
          work.sectionId,
          ok !== undefined
            ? ok
            : {
                sectionId: work.sectionId,
                status: "failed",
                error: "批量摘要响应缺失该章节",
                sourceFingerprint: work.fingerprint,
              },
        );
      }
      return outcomes;
    } catch (error) {
      return failed(error instanceof Error ? error.message : String(error));
    }
  }
}

function stripCodeFence(text: string): string {
  const fenced = /^```[a-zA-Z]*\s*([\s\S]*?)\s*```$/.exec(text);
  return fenced !== null ? fenced[1] ?? text : text;
}

/**
 * 批次切分（纯函数）：按文档顺序累积，触到任一上限即开新批。
 * 单节超过 BATCH_INPUT_MAX_CHARS 时独占一批（输入已在节级截断，恒可放下）。
 */
export function partitionBatches<T extends { input: string }>(
  works: readonly T[],
): T[][] {
  const batches: T[][] = [];
  let current: T[] = [];
  let currentChars = 0;
  for (const work of works) {
    if (
      current.length >= BATCH_MAX_SECTIONS ||
      (current.length > 0 && currentChars + work.input.length > BATCH_INPUT_MAX_CHARS)
    ) {
      batches.push(current);
      current = [];
      currentChars = 0;
    }
    current.push(work);
    currentChars += work.input.length;
  }
  if (current.length > 0) {
    batches.push(current);
  }
  return batches;
}
