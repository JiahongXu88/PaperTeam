/**
 * M14.5 跨实验统一总预算账本（测试编排器层；任务 §8.2）。
 *
 * 背景：M14.4 的 RunBudgetLedgerRuntime 只约束**单个 run** 的模型调用 / token；一次
 * 真实验收包含主 run、重新附着恢复、修复后复验、定向 smoke 等多次实验，M14.3 曾因此
 * 累计 452 次调用。本账本在真实模型驱动器中包裹 adapter（位于 RunBudgetLedgerRuntime
 * 之内、真实 runtime 之外），所有实验共用一个文件账本：
 *   - 启动前检查 + 计数（并发调用全部计数；超限抛 MODEL_BUDGET_EXCEEDED——与
 *     RunBudgetLedgerRuntime 同码，引擎按 permanent 处理，不重试）；
 *   - 同步 IO + 原子 rename：进程重启不重置；失败重试不获新额度；
 *   - 上限只能收紧不能放宽（同一账本被多次声明时取最严格值）；
 *   - 账本记录每个实验的调用 / token 与每次拦截（stops）。
 *
 * 不替代 RunBudgetLedgerRuntime（run 级 planner 优雅降级仍由它负责）；本账本是跨实验
 * 的最终硬上限（BUDGET_EXHAUSTED）。
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { BusinessError } from "../../src/errors.js";

export type GlobalLedgerUsage = Partial<Record<"inputTokens" | "outputTokens" | "cacheReadTokens" | "cacheWriteTokens" | "estimatedCost", number>>;

export interface GlobalLedgerFile {
  schemaVersion: 1;
  label: string;
  limits: { maxCalls: number; maxTokens: number };
  totals: { calls: number; callsWithUsage: number; inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; estimatedCost: number };
  experiments: Array<{ id: string; startedAt: string; calls: number; tokens: number; updatedAt: string }>;
  stops: Array<{ at: string; experimentId: string; reason: string }>;
  updatedAt: string;
}

export class GlobalBudgetLedger {
  constructor(
    private readonly path: string,
    private readonly experimentId: string,
    private readonly limits: { maxCalls: number; maxTokens: number },
  ) {
    const ledger = this.load();
    if (!ledger.experiments.some((item) => item.id === experimentId)) {
      ledger.experiments.push({ id: experimentId, startedAt: new Date().toISOString(), calls: 0, tokens: 0, updatedAt: new Date().toISOString() });
    }
    ledger.limits = {
      maxCalls: tighten(ledger.limits.maxCalls, limits.maxCalls),
      maxTokens: tighten(ledger.limits.maxTokens, limits.maxTokens),
    };
    this.save(ledger);
  }

  private load(): GlobalLedgerFile {
    if (existsSync(this.path)) {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as GlobalLedgerFile;
      if (parsed.schemaVersion === 1) return parsed;
    }
    return {
      schemaVersion: 1,
      label: "M14.5 cross-experiment model budget",
      limits: { maxCalls: this.limits.maxCalls, maxTokens: this.limits.maxTokens },
      totals: { calls: 0, callsWithUsage: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCost: 0 },
      experiments: [],
      stops: [],
      updatedAt: new Date().toISOString(),
    };
  }

  private save(ledger: GlobalLedgerFile): void {
    ledger.updatedAt = new Date().toISOString();
    mkdirSync(dirname(this.path), { recursive: true });
    const tmp = `${this.path}.${process.pid}.tmp`;
    writeFileSync(tmp, JSON.stringify(ledger, null, 2), "utf8");
    renameSync(tmp, this.path);
  }

  private tokens(ledger: GlobalLedgerFile): number {
    return ledger.totals.inputTokens + ledger.totals.outputTokens + ledger.totals.cacheWriteTokens;
  }

  /** 启动前检查 + 计数（并发调用全部计数；超限抛 MODEL_BUDGET_EXCEEDED 并记录 stop） */
  chargeCall(): void {
    const ledger = this.load();
    const nextCalls = ledger.totals.calls + 1;
    let reason: string | undefined;
    if (ledger.limits.maxCalls > 0 && nextCalls > ledger.limits.maxCalls) {
      reason = `全局调用数 ${nextCalls} > 上限 ${ledger.limits.maxCalls}`;
    } else if (ledger.limits.maxTokens > 0 && this.tokens(ledger) >= ledger.limits.maxTokens) {
      reason = `全局 token ${this.tokens(ledger)} ≥ 上限 ${ledger.limits.maxTokens}`;
    }
    if (reason !== undefined) {
      ledger.stops.push({ at: new Date().toISOString(), experimentId: this.experimentId, reason });
      this.save(ledger);
      throw new BusinessError(
        "MODEL_BUDGET_EXCEEDED",
        `M14.5 跨实验总预算已耗尽（${reason}；已完成 ${ledger.totals.calls} 次调用）——不再启动新的模型任务（BUDGET_EXHAUSTED）`,
      );
    }
    ledger.totals.calls = nextCalls;
    const experiment = ledger.experiments.find((item) => item.id === this.experimentId)!;
    experiment.calls += 1;
    experiment.updatedAt = new Date().toISOString();
    this.save(ledger);
  }

  chargeUsage(usage: GlobalLedgerUsage | undefined): void {
    if (usage === undefined) return;
    const ledger = this.load();
    ledger.totals.callsWithUsage += 1;
    ledger.totals.inputTokens += usage.inputTokens ?? 0;
    ledger.totals.outputTokens += usage.outputTokens ?? 0;
    ledger.totals.cacheReadTokens += usage.cacheReadTokens ?? 0;
    ledger.totals.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    ledger.totals.estimatedCost += usage.estimatedCost ?? 0;
    const experiment = ledger.experiments.find((item) => item.id === this.experimentId)!;
    experiment.tokens += (usage.inputTokens ?? 0) + (usage.outputTokens ?? 0) + (usage.cacheWriteTokens ?? 0);
    experiment.updatedAt = new Date().toISOString();
    this.save(ledger);
  }

  snapshot(): GlobalLedgerFile {
    return this.load();
  }
}

/** 0 = 不限制；两侧都有上限时取更严格者 */
function tighten(existing: number, requested: number): number {
  if (existing > 0 && requested > 0) return Math.min(existing, requested);
  return Math.max(existing, requested);
}
