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
import type { PaperMap } from "./types.js";
import { summaryNeedsRefresh, type PaperSectionSummary } from "./sectionSummary.js";
import type { PaperStore } from "./PaperStore.js";

/** 单 section 摘要输入截断（字符） */
const SUMMARY_INPUT_MAX_CHARS = 6000;

export interface PaperMapServiceOptions {
  projects: ProjectStore;
  store: PaperStore;
  runtime: AgentRuntime;
  /** Reviewer agent id（摘要生成走 reviewer 角色 scope） */
  reviewerAgentId: string;
  now?: () => Date;
  log?: (message: string) => void;
}

export class PaperMapService {
  private readonly store: PaperStore;
  private readonly runtime: AgentRuntime;
  private readonly reviewerAgentId: string;
  private readonly now: () => Date;
  private readonly log: (message: string) => void;

  /** 最近一次 ensureMap 的 telemetry（模型调用数等；诊断用） */
  lastTelemetry: { modelCalls: number; summariesRefreshed: number; failures: number } | undefined;

  constructor(options: PaperMapServiceOptions) {
    this.store = options.store;
    this.runtime = options.runtime;
    this.reviewerAgentId = options.reviewerAgentId;
    this.now = options.now ?? (() => new Date());
    this.log = options.log ?? (() => {});
  }

  /**
   * 构建/刷新 PaperMap：
   * 1. 确定性骨架（sections/counts/指纹）——总是重算落盘；
   * 2. 章节摘要——仅刷新缺失/失败/stale 的（已有摘要按指纹复用，不重复烧 token）。
   */
  async ensureMap(
    projectId: string,
    options: { refreshSummaries?: boolean } = {},
  ): Promise<PaperMap> {
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

    const telemetry = { modelCalls: 0, summariesRefreshed: 0, failures: 0 };
    const sections: PaperMap["sections"] = [];
    for (const section of document.sections) {
      const chunks = document.chunks.filter((chunk) => chunk.sectionId === section.sectionId);
      const fingerprint = fingerprintJson(
        chunks.map((chunk) => chunk.chunkId + ":" + chunk.text),
      );
      const prior = previousSummaries.get(section.sectionId);
      let summary: PaperSectionSummary | undefined;
      if (prior !== undefined && !summaryNeedsRefresh(prior, fingerprint)) {
        summary = prior; // 指纹一致：复用，不重跑
      } else if (options.refreshSummaries !== false) {
        summary = await this.summarizeSection(projectId, section.sectionId, section.title, chunks, fingerprint);
        telemetry.modelCalls += 1;
        if (summary.status === "ok") {
          telemetry.summariesRefreshed += 1;
        } else {
          telemetry.failures += 1;
        }
      } else {
        summary = { sectionId: section.sectionId, status: "pending", sourceFingerprint: fingerprint };
      }
      sections.push({
        sectionId: section.sectionId,
        title: section.title,
        level: section.level,
        pageStart: section.pageStart,
        pageEnd: section.pageEnd,
        chunkCount: chunks.length,
        charCount: section.charCount,
        ...(summary !== undefined ? { summary } : {}),
      });
    }

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
    this.lastTelemetry = telemetry;
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
    chunks: Array<{ text: string }>,
    fingerprint: string,
  ): Promise<PaperSectionSummary> {
    const input = chunks
      .map((chunk) => chunk.text)
      .join("\n\n")
      .slice(0, SUMMARY_INPUT_MAX_CHARS);
    if (input.trim() === "") {
      return { sectionId, status: "failed", error: "章节无文本", sourceFingerprint: fingerprint };
    }
    const scope = `review/summary/${sectionId.toLowerCase()}`;
    try {
      const task = await this.runtime.runAgent({
        agentId: this.reviewerAgentId,
        projectId,
        contextScope: scope,
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
}
