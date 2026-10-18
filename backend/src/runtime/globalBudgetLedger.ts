/**
 * M14.9.1 C1：任务级（跨 run / 跨项目 / 跨进程）模型预算账本。
 *
 * 背景（M14.9 真实返修）：任务建议 110 次调用，实际 154 次——3 个 improvement run
 * 各自受 RunBudgetLedgerRuntime 的 per-run 上限约束，独立审稿脚本不受任何约束，
 * 系统层面没有「整个外层任务合计」的硬限制，「建议预算」只能事后对账。
 *
 * 机制：
 * - 一个文件账本被同一任务的所有参与者共享（后端进程经 PAPERTEAM_GLOBAL_BUDGET_LEDGER
 *   启用、实验 Harness 直接构造本类）；同步 IO + 锁文件 + 原子 rename，进程重启不重置，
 *   多进程并发不丢计数。
 * - **调用前预留**：reserve() 在模型任务启动前检查「已用 + 在途预留 + 本次预估」
 *   是否超过上限，超限即拒绝启动（MODEL_BUDGET_EXCEEDED，permanent，不重试），
 *   并把账本状态持久化为 BUDGET_EXHAUSTED。达到任一上限（≥）后不再启动新请求。
 * - settle() 用真实 usage 结算并释放预留；没有 usage 的失败调用仍计 1 次调用。
 * - 上限只能收紧不能放宽：同一账本被多次声明时取最严格值（防止「重启时调大预算」）。
 *
 * Token 口径与 RunBudgetLedgerRuntime 一致：input + output + cacheWrite（cacheRead
 * 单独记录、不计入）。预估只用于预留；预留的保守程度由调用方的 outputReserveTokens
 * 决定（Harness 用模型 maxTokens 作为输出上界）。
 */

import { closeSync, existsSync, mkdirSync, openSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";

import { BusinessError } from "../errors.js";

export interface GlobalBudgetLimits {
  /** 任务内最大模型请求数（0 = 不限制） */
  maxCalls: number;
  /** 任务内最大 token（input + output + cacheWrite；0 = 不限制） */
  maxTokens: number;
}

export interface GlobalBudgetUsage {
  inputTokens?: number;
  outputTokens?: number;
  cacheReadTokens?: number;
  cacheWriteTokens?: number;
  estimatedCost?: number;
}

export type GlobalBudgetStatus = "ACTIVE" | "BUDGET_EXHAUSTED";

export interface GlobalBudgetCallRecord {
  id: string;
  experimentId: string;
  label: string;
  startedAt: string;
  reservedTokens: number;
  status: "running" | "settled" | "failed_no_usage";
  settledAt?: string;
  usage?: Required<Omit<GlobalBudgetUsage, "estimatedCost">> & { estimatedCost: number };
}

export interface GlobalBudgetLedgerFile {
  schemaVersion: 2;
  label: string;
  status: GlobalBudgetStatus;
  limits: GlobalBudgetLimits;
  totals: {
    calls: number;
    settledCalls: number;
    inputTokens: number;
    outputTokens: number;
    cacheReadTokens: number;
    cacheWriteTokens: number;
    estimatedCost: number;
  };
  calls: GlobalBudgetCallRecord[];
  stops: Array<{ at: string; experimentId: string; label: string; reason: string }>;
  exhaustedAt?: string;
  exhaustedReason?: string;
  updatedAt: string;
}

export interface GlobalBudgetSnapshot {
  status: GlobalBudgetStatus;
  limits: GlobalBudgetLimits;
  calls: number;
  tokens: number;
  reservedTokens: number;
  runningCalls: number;
  /** 达到任一上限（≥）的原因；undefined = 仍可启动新请求 */
  exhaustedReason?: string;
}

const LOCK_STALE_MS = 30_000;
const LOCK_WAIT_MS = 10_000;

/** 保守的 token 预估（只用于预留，不入账）：CJK 每字 ≈1 token、其余每 2.5 字符 ≈1 token，再放大 1.25 倍 */
export function estimatePromptTokens(text: string): number {
  let cjk = 0;
  for (const char of text) {
    const code = char.codePointAt(0)!;
    if ((code >= 0x3000 && code <= 0x9fff) || (code >= 0xf900 && code <= 0xfaff) || (code >= 0xff00 && code <= 0xffef)) cjk += 1;
  }
  const other = text.length - cjk;
  return Math.ceil((cjk + other / 2.5) * 1.25);
}

function tighten(current: number, requested: number): number {
  if (current <= 0) return requested;
  if (requested <= 0) return current;
  return Math.min(current, requested);
}

function usedTokens(ledger: GlobalBudgetLedgerFile): number {
  return ledger.totals.inputTokens + ledger.totals.outputTokens + ledger.totals.cacheWriteTokens;
}

function sleepSync(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

export class GlobalBudgetLedger {
  readonly path: string;
  private readonly lockPath: string;
  private sequence = 0;

  constructor(options: { path: string; limits: GlobalBudgetLimits; label?: string }) {
    this.path = options.path;
    this.lockPath = `${options.path}.lock`;
    this.mutate((ledger) => {
      ledger.limits = {
        maxCalls: tighten(ledger.limits.maxCalls, options.limits.maxCalls),
        maxTokens: tighten(ledger.limits.maxTokens, options.limits.maxTokens),
      };
      if (options.label !== undefined && ledger.label === "") ledger.label = options.label;
    });
  }

  /**
   * 启动前预留：已用 + 在途预留 + 本次预估超过任一上限 → 拒绝（不启动请求），
   * 账本落 BUDGET_EXHAUSTED。返回调用 id，调用方必须在请求结束后 settle。
   */
  reserve(params: { experimentId?: string; label: string; estimatedTokens: number }): string {
    const experimentId = params.experimentId ?? "(default)";
    let refusal: string | undefined;
    let id = "";
    this.mutate((ledger) => {
      const reason = this.refusalReason(ledger, Math.max(0, Math.ceil(params.estimatedTokens)));
      if (reason !== undefined) {
        refusal = reason;
        ledger.status = "BUDGET_EXHAUSTED";
        ledger.exhaustedAt ??= new Date().toISOString();
        ledger.exhaustedReason = reason;
        ledger.stops.push({ at: new Date().toISOString(), experimentId, label: params.label, reason });
        return;
      }
      this.sequence += 1;
      id = `g-${process.pid}-${Date.now().toString(36)}-${this.sequence}`;
      ledger.totals.calls += 1;
      ledger.calls.push({
        id, experimentId, label: params.label, startedAt: new Date().toISOString(),
        reservedTokens: Math.max(0, Math.ceil(params.estimatedTokens)), status: "running",
      });
      // 达到上限（≥）即进入 BUDGET_EXHAUSTED：后续请求一律拒绝，在途请求照常结算
      const reached = this.reachedReason(ledger);
      if (reached !== undefined) {
        ledger.status = "BUDGET_EXHAUSTED";
        ledger.exhaustedAt ??= new Date().toISOString();
        ledger.exhaustedReason = reached;
      }
    });
    if (refusal !== undefined) {
      throw new BusinessError(
        "MODEL_BUDGET_EXCEEDED",
        `任务级模型预算拒绝启动新请求（${refusal}）——账本 ${this.path} 已标记 BUDGET_EXHAUSTED；已落盘产物保留，不会自动开启新的恢复 run`,
      );
    }
    return id;
  }

  /** 结算：真实 usage 入账并释放预留；usage 缺失 = 失败调用（仍计 1 次请求、0 token） */
  settle(id: string, usage: GlobalBudgetUsage | undefined): void {
    this.mutate((ledger) => {
      const call = ledger.calls.find((entry) => entry.id === id);
      if (call === undefined || call.status !== "running") return;
      call.settledAt = new Date().toISOString();
      if (usage === undefined) {
        call.status = "failed_no_usage";
      } else {
        call.status = "settled";
        call.usage = {
          inputTokens: usage.inputTokens ?? 0,
          outputTokens: usage.outputTokens ?? 0,
          cacheReadTokens: usage.cacheReadTokens ?? 0,
          cacheWriteTokens: usage.cacheWriteTokens ?? 0,
          estimatedCost: usage.estimatedCost ?? 0,
        };
        ledger.totals.settledCalls += 1;
        ledger.totals.inputTokens += call.usage.inputTokens;
        ledger.totals.outputTokens += call.usage.outputTokens;
        ledger.totals.cacheReadTokens += call.usage.cacheReadTokens;
        ledger.totals.cacheWriteTokens += call.usage.cacheWriteTokens;
        ledger.totals.estimatedCost += call.usage.estimatedCost;
      }
      const reached = this.reachedReason(ledger);
      if (reached !== undefined && ledger.status !== "BUDGET_EXHAUSTED") {
        ledger.status = "BUDGET_EXHAUSTED";
        ledger.exhaustedAt = new Date().toISOString();
        ledger.exhaustedReason = reached;
      }
    });
  }

  snapshot(): GlobalBudgetSnapshot {
    const ledger = this.load();
    const running = ledger.calls.filter((call) => call.status === "running");
    const reached = this.reachedReason(ledger);
    return {
      status: ledger.status,
      limits: ledger.limits,
      calls: ledger.totals.calls,
      tokens: usedTokens(ledger),
      reservedTokens: running.reduce((sum, call) => sum + call.reservedTokens, 0),
      runningCalls: running.length,
      ...(ledger.status === "BUDGET_EXHAUSTED" || reached !== undefined
        ? { exhaustedReason: ledger.exhaustedReason ?? reached ?? "BUDGET_EXHAUSTED" }
        : {}),
    };
  }

  read(): GlobalBudgetLedgerFile {
    return this.load();
  }

  private refusalReason(ledger: GlobalBudgetLedgerFile, estimate: number): string | undefined {
    if (ledger.status === "BUDGET_EXHAUSTED") {
      return `账本已处于 BUDGET_EXHAUSTED（${ledger.exhaustedReason ?? "已达上限"}）`;
    }
    const { maxCalls, maxTokens } = ledger.limits;
    if (maxCalls > 0 && ledger.totals.calls + 1 > maxCalls) {
      return `请求数 ${ledger.totals.calls + 1} > 上限 ${maxCalls}`;
    }
    if (maxTokens > 0) {
      const reserved = ledger.calls.filter((call) => call.status === "running").reduce((sum, call) => sum + call.reservedTokens, 0);
      const projected = usedTokens(ledger) + reserved + estimate;
      if (projected > maxTokens) {
        return `token 已用 ${usedTokens(ledger)} + 在途预留 ${reserved} + 本次预留 ${estimate} = ${projected} > 上限 ${maxTokens}`;
      }
    }
    return undefined;
  }

  private reachedReason(ledger: GlobalBudgetLedgerFile): string | undefined {
    const { maxCalls, maxTokens } = ledger.limits;
    if (maxCalls > 0 && ledger.totals.calls >= maxCalls) return `请求数已达上限 ${maxCalls}`;
    if (maxTokens > 0 && usedTokens(ledger) >= maxTokens) return `token 已达上限 ${maxTokens}`;
    return undefined;
  }

  private load(): GlobalBudgetLedgerFile {
    if (existsSync(this.path)) {
      const parsed = JSON.parse(readFileSync(this.path, "utf8")) as GlobalBudgetLedgerFile;
      if (parsed.schemaVersion === 2) return parsed;
      throw new BusinessError("MODEL_BUDGET_EXCEEDED", `任务级预算账本格式无法识别：${this.path}（拒绝在未知账本上继续计费）`);
    }
    return {
      schemaVersion: 2,
      label: "",
      status: "ACTIVE",
      limits: { maxCalls: 0, maxTokens: 0 },
      totals: { calls: 0, settledCalls: 0, inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, estimatedCost: 0 },
      calls: [],
      stops: [],
      updatedAt: new Date().toISOString(),
    };
  }

  /** 加锁读-改-写（锁文件 + 原子 rename；跨进程安全） */
  private mutate(change: (ledger: GlobalBudgetLedgerFile) => void): void {
    mkdirSync(dirname(this.path), { recursive: true });
    this.acquireLock();
    try {
      const ledger = this.load();
      change(ledger);
      ledger.updatedAt = new Date().toISOString();
      const tmp = `${this.path}.${process.pid}.${Date.now()}.tmp`;
      writeFileSync(tmp, JSON.stringify(ledger, null, 2) + "\n", "utf8");
      renameSync(tmp, this.path);
    } finally {
      rmSync(this.lockPath, { force: true });
    }
  }

  private acquireLock(): void {
    const deadline = Date.now() + LOCK_WAIT_MS;
    for (;;) {
      try {
        closeSync(openSync(this.lockPath, "wx"));
        return;
      } catch (error) {
        if ((error as { code?: string }).code !== "EEXIST") throw error;
        try {
          if (Date.now() - statSync(this.lockPath).mtimeMs > LOCK_STALE_MS) {
            rmSync(this.lockPath, { force: true });
            continue;
          }
        } catch {
          continue;
        }
        if (Date.now() > deadline) {
          throw new BusinessError("MODEL_BUDGET_EXCEEDED", `任务级预算账本锁等待超时：${this.lockPath}（拒绝在无法记账时启动请求）`);
        }
        sleepSync(25);
      }
    }
  }
}
