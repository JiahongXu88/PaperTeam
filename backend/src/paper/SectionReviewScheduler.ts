/**
 * SectionReviewScheduler：分章节审阅的有界并发调度器。
 *
 * 职责边界（与 reviewSectionsStage / SectionReviewService 的分工）：
 * - 本文件只管「编排」：并发度、排队、取消传播、节内重试、per-section
 *   持久化、结果按论文顺序重排、性能 telemetry；
 * - SectionReviewService 仍然只做「context → agent → findings」的单节事实；
 * - reviewSectionsStage（definitions.ts）负责章节筛选与引用上下文装配。
 *
 * 并发模型：同一 Reviewer 角色的 N 个 AgentRun 同时活跃，每个 section 一个
 * 独立 contextScope（review/section/<id> → 独立 Pi session），互不共享会话。
 * LLM 调用是网络 I/O：Promise + 事件循环即够，不引入 Worker Threads。
 *
 * 取消语义：signal 触发后（1）调度器停止派发 queued 节（mapWithConcurrency
 * 保证）；（2）在途节经 runtime 的 signal → AgentRunHandle.cancel() 协作式中断
 * （runAgent(input.signal) 内建）；（3）全部 settle 后统一以 WORKFLOW_CANCELLED
 * 上抛——绝不「只设标志然后让 N 条模型调用跑完」。
 *
 * 单节失败语义：节内退避重试耗尽 → 该节记 failed、其余节继续；全部节失败才
 * 上抛 transient（交给 stage 级重试，且已完成节经 journal 复用不会重跑）。
 */

import { AgentRunFailedError, BusinessError } from "../errors.js";
import { readFindings, type ReviewFinding } from "../review/finding.js";
import { fingerprintJson } from "../util/hash.js";
import { assertValidConcurrency, mapWithConcurrency } from "../util/concurrency.js";
import type { PaperStore } from "./PaperStore.js";
import type {
  CitationContextEntry,
  ReviewContextBuilder,
  SectionReviewContext,
} from "./ReviewContextBuilder.js";
import type { SectionReviewOutcome, SectionReviewService } from "./SectionReviewService.js";

/** 一个待审阅章节（contextScope 由 ReviewContextBuilder 的规则派生） */
export interface SectionReviewJob {
  sectionId: string;
  contextScope: string;
  citations: CitationContextEntry[];
}

export interface SectionReviewSchedulerOptions {
  store: PaperStore;
  reviewContext: ReviewContextBuilder;
  sectionReview: SectionReviewService;
  /** 活跃审阅（模型调用）上限 */
  concurrency: number;
  /** 单节内重试次数（含首次） */
  attempts: number;
  /** 节内重试退避（毫秒；下标 = 已失败次数 - 1） */
  backoffMs: readonly number[];
  /** 审阅指令（进 fingerprint：指令变化使 journal 记录失效） */
  instruction: string;
  log?: (message: string) => void;
}

/** 运行上下文（由 StageRunContext 提供的字段） */
export interface SchedulerRunContext {
  projectId: string;
  runId: string;
  /** Workflow 取消信号：停止派发 + 中断在途模型调用 */
  signal: AbortSignal;
  /** 进度上报（completed/total 口径；并发下「当前 index」不再代表进度） */
  emitProgress: (data: Record<string, unknown>) => Promise<void>;
}

export interface SectionReviewTelemetry {
  reviewConcurrency: number;
  maxObservedConcurrency: number;
  sectionsTotal: number;
  sectionsStarted: number;
  sectionsCompleted: number;
  sectionsFailed: number;
  /** 节内重试总次数（所有节累计） */
  sectionsRetried: number;
  /** journal 命中（stage 重试 / 崩溃恢复复用，零模型调用） */
  sectionsReused: number;
  queueWaitMs: { p50: number; p95: number; max: number };
  /** 本 stage 的墙钟耗时（并发执行的真实时长） */
  reviewSectionsWallMs: number;
  /** 各节审阅时长之和（> wall 是并发的正常表现，两者比值 ≈ 有效并发度） */
  sumSectionDurationMs: number;
  /** 节内重试命中的错误总数 */
  providerErrors: number;
  /** 其中疑似限流（429 / rate limit 文本启发式——Pi 层无结构化 HTTP 状态） */
  rateLimitedHint: number;
}

export interface SectionReviewRunResult {
  /** 按论文顺序（输入顺序）拼接的全部 findings——执行顺序不确定，输出顺序确定 */
  findings: ReviewFinding[];
  reviewed: string[];
  failedSections: string[];
  lastSectionError: string;
  parseFailures: number;
  dropped: number;
  telemetry: SectionReviewTelemetry;
}

/** 可被取消信号打断的退避等待（取消后立即返回，不再傻等后重试） */
function waitOrAbort(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) {
      resolve();
      return;
    }
    const timer = setTimeout(done, ms);
    function done() {
      clearTimeout(timer);
      signal.removeEventListener("abort", done);
      resolve();
    }
    signal.addEventListener("abort", done, { once: true });
  });
}

const RATE_LIMIT_PATTERN = /\b(429|rate[ _-]?limit|too many requests)\b/i;

function percentile(sortedValues: number[], ratio: number): number {
  if (sortedValues.length === 0) {
    return 0;
  }
  const index = Math.min(sortedValues.length - 1, Math.floor(ratio * (sortedValues.length - 1)));
  return sortedValues[index] ?? 0;
}

/** journal 记录体的最小校验（指纹一致 + findings 可读才可复用） */
function reusableRecordOutcome(
  record: Record<string, unknown> | undefined,
  fingerprint: string,
): { findings: ReviewFinding[]; parseFailed: boolean; dropped: number } | undefined {
  if (record === undefined || record["status"] !== "completed" || record["fingerprint"] !== fingerprint) {
    return undefined;
  }
  const outcome = record["outcome"];
  if (typeof outcome !== "object" || outcome === null) {
    return undefined;
  }
  const parsed = readFindings((outcome as Record<string, unknown>)["findings"]);
  return {
    findings: parsed.findings,
    parseFailed: (outcome as Record<string, unknown>)["parseFailed"] === true,
    dropped: parsed.dropped,
  };
}

export class SectionReviewScheduler {
  private readonly store: PaperStore;
  private readonly reviewContext: ReviewContextBuilder;
  private readonly sectionReview: SectionReviewService;
  private readonly concurrency: number;
  private readonly attempts: number;
  private readonly backoffMs: readonly number[];
  private readonly instruction: string;
  private readonly log: (message: string) => void;

  constructor(options: SectionReviewSchedulerOptions) {
    assertValidConcurrency(options.concurrency, "reviewConcurrency");
    this.store = options.store;
    this.reviewContext = options.reviewContext;
    this.sectionReview = options.sectionReview;
    this.concurrency = options.concurrency;
    this.attempts = options.attempts;
    this.backoffMs = options.backoffMs;
    this.instruction = options.instruction;
    this.log = options.log ?? (() => {});
  }

  /**
   * 并发审阅全部 jobs；返回值按 jobs 输入顺序组织（deterministic）。
   * 任何情况下都等待在途任务 settle 后才返回 / 抛出。
   */
  async run(jobs: readonly SectionReviewJob[], ctx: SchedulerRunContext): Promise<SectionReviewRunResult> {
    const wallStartedAt = Date.now();
    const journal = await this.store.loadSectionReviewRecords(ctx.projectId, ctx.runId);

    const telemetry: SectionReviewTelemetry = {
      reviewConcurrency: this.concurrency,
      maxObservedConcurrency: 0,
      sectionsTotal: jobs.length,
      sectionsStarted: 0,
      sectionsCompleted: 0,
      sectionsFailed: 0,
      sectionsRetried: 0,
      sectionsReused: 0,
      queueWaitMs: { p50: 0, p95: 0, max: 0 },
      reviewSectionsWallMs: 0,
      sumSectionDurationMs: 0,
      providerErrors: 0,
      rateLimitedHint: 0,
    };
    const queueWaits: number[] = [];
    const sectionDurations: number[] = [];
    const findingsBySection = new Map<string, ReviewFinding[]>();
    const parseFailedBySection = new Map<string, boolean>();
    const droppedBySection = new Map<string, number>();
    const reviewed: string[] = [];
    const failedSections: string[] = [];
    let lastSectionError = "";
    let completedCount = 0;
    let failedCount = 0;

    const worker = async (job: SectionReviewJob): Promise<"completed" | "failed"> => {
      const startAt = Date.now();
      telemetry.sectionsStarted += 1;
      queueWaits.push(startAt - wallStartedAt);
      const context = await this.reviewContext.buildSectionContext(ctx.projectId, job.sectionId, {
        instruction: this.instruction,
        ...(job.citations.length > 0 ? { citations: job.citations } : {}),
      });
      // 指纹 = 章节 chunk 内容 + 本节引用上下文 + 审阅指令（任一变化 → 旧记录不可复用）
      const fingerprint = fingerprintJson([
        context.chunks.map((chunk) => chunk.chunkId + ":" + chunk.text),
        job.citations.map((citation) => [citation.referenceId, citation.rawText, citation.status ?? ""]),
        this.instruction,
      ]);

      // journal 复用：同一 runId 下已完成且输入未变的章节直接采用（零模型调用）
      const reused = reusableRecordOutcome(journal.get(job.sectionId), fingerprint);
      let outcome: { findings: ReviewFinding[]; parseFailed: boolean; dropped: number } | null;
      if (reused !== undefined) {
        outcome = reused;
        telemetry.sectionsReused += 1;
        this.log(`章节 ${job.sectionId} 审阅复用 journal 记录（fingerprint 一致）`);
      } else {
        const sectionStartedAt = Date.now();
        const fresh = await this.reviewWithRetry(context, job.sectionId, ctx, telemetry, (message) => {
          lastSectionError = message;
        });
        sectionDurations.push(Date.now() - sectionStartedAt);
        if (fresh === null) {
          outcome = null;
        } else {
          // 每节完成立即持久化（不等全部完成）：第 25 节崩溃，前 24 节不重跑
          try {
            await this.store.saveSectionReviewRecord(ctx.projectId, ctx.runId, {
              sectionId: job.sectionId,
              runId: ctx.runId,
              status: "completed",
              fingerprint,
              outcome: {
                findings: fresh.findings,
                parseFailed: fresh.parseFailed,
                dropped: fresh.dropped,
              },
              completedAt: new Date().toISOString(),
            });
          } catch (error) {
            // journal 只是恢复增强：写失败不推翻本节的审阅结果（当前 run 的
            // findings 照常进入 stage 结果，仅崩溃恢复时会重跑这一节）
            this.log(
              `章节 ${job.sectionId} journal 写入失败（不影响本节结果）：${
                error instanceof Error ? error.message : String(error)
              }`,
            );
          }
          outcome = { findings: fresh.findings, parseFailed: fresh.parseFailed, dropped: fresh.dropped };
        }
      }

      if (outcome === null) {
        failedCount += 1;
        return "failed";
      }
      findingsBySection.set(job.sectionId, outcome.findings);
      parseFailedBySection.set(job.sectionId, outcome.parseFailed);
      droppedBySection.set(job.sectionId, outcome.dropped);
      completedCount += 1;
      await ctx.emitProgress({
        section: job.sectionId,
        completed: completedCount,
        total: jobs.length,
        findings: [...findingsBySection.values()].reduce((sum, list) => sum + list.length, 0),
        failed: failedCount,
        reused: telemetry.sectionsReused,
      });
      return "completed";
    };

    const outcomes = await mapWithConcurrency(jobs, this.concurrency, worker, {
      signal: ctx.signal,
      onEvent: (event) => {
        if (event.type === "start") {
          telemetry.maxObservedConcurrency = Math.max(telemetry.maxObservedConcurrency, event.active);
        }
      },
    });

    // 按 jobs 顺序（论文顺序）组装最终结果：并发完成顺序与输出顺序解耦
    let parseFailures = 0;
    let dropped = 0;
    for (let index = 0; index < jobs.length; index += 1) {
      const job = jobs[index]!;
      const outcome = outcomes[index];
      if (outcome !== undefined && outcome.ok && outcome.value === "completed") {
        reviewed.push(job.sectionId);
        parseFailures += parseFailedBySection.get(job.sectionId) === true ? 1 : 0;
        dropped += droppedBySection.get(job.sectionId) ?? 0;
      } else {
        failedSections.push(job.sectionId);
      }
    }

    const waits = [...queueWaits].sort((a, b) => a - b);
    telemetry.queueWaitMs = { p50: percentile(waits, 0.5), p95: percentile(waits, 0.95), max: waits.at(-1) ?? 0 };
    telemetry.sectionsCompleted = reviewed.length;
    telemetry.sectionsFailed = failedSections.length;
    telemetry.reviewSectionsWallMs = Date.now() - wallStartedAt;
    telemetry.sumSectionDurationMs = sectionDurations.reduce((sum, value) => sum + value, 0);

    // 取消优先于失败分类（与串行版口径一致：abort 后由 orchestrator 终结 run）
    if (ctx.signal.aborted) {
      throw new BusinessError("WORKFLOW_CANCELLED", "分章节审阅已被取消");
    }
    if (reviewed.length === 0) {
      // 一节都没审成：多半是模型 / Provider 整体不可用，按 transient 交给 stage 级重试
      throw new AgentRunFailedError(
        `分章节审阅全部失败（${failedSections.length} 节），最近错误：${lastSectionError}`,
      );
    }
    return {
      findings: jobs.flatMap((job) => findingsBySection.get(job.sectionId) ?? []),
      reviewed,
      failedSections,
      lastSectionError,
      parseFailures,
      dropped,
      telemetry,
    };
  }
  /**
   * 节内退避重试（从 reviewSectionsStage 原样迁入）：瞬时失败（Provider 503 /
   * 限流 / 网络抖动）在节内消化；取消信号立即穿透。耗尽返回 null（记失败节）。
   */
  private async reviewWithRetry(
    context: SectionReviewContext,
    sectionId: string,
    ctx: SchedulerRunContext,
    telemetry: SectionReviewTelemetry,
    recordError: (message: string) => void,
  ): Promise<SectionReviewOutcome | null> {
    for (let attempt = 1; attempt <= this.attempts; attempt += 1) {
      try {
        return await this.sectionReview.reviewSection({
          projectId: ctx.projectId,
          runId: ctx.runId,
          context,
          signal: ctx.signal,
        });
      } catch (error) {
        if (ctx.signal.aborted || (error instanceof BusinessError && error.code === "WORKFLOW_CANCELLED")) {
          throw error;
        }
        telemetry.providerErrors += 1;
        const message = error instanceof Error ? error.message : String(error);
        if (RATE_LIMIT_PATTERN.test(message)) {
          telemetry.rateLimitedHint += 1;
        }
        recordError(message);
        this.log(`章节 ${sectionId} 审阅第 ${attempt} 次失败：${message.slice(0, 200)}`);
        if (attempt < this.attempts) {
          telemetry.sectionsRetried += 1;
          const backoff = this.backoffMs[attempt - 1] ?? 5_000;
          await waitOrAbort(backoff, ctx.signal);
        }
      }
    }
    return null;
  }
}
