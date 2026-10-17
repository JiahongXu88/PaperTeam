/**
 * M14.4 P0-3：run 级模型资源账本（RunBudgetLedgerRuntime）。
 *
 * 背景（真实 R3）：任务建议预算 60 次调用，实际单 run 349 次（1.30M input
 * tokens / 85 分钟）——系统没有任何 run 级模型调用 / Token 预算：Runtime 只
 * 累计 usage（观测），Workflow 只数修订轮数（一轮 = 数十次单元 review + 整文件
 * Writer + 每候选 ≤3 次 repair）。
 *
 * 机制（装饰 AgentRuntime，业务层零改动）：
 * - 归因：stage 执行的 ALS trace scope（projectId × runId，WorkflowOrchestrator
 *   在 runInTraceScope 内执行 stage → services → runtime 的整条调用链继承）；
 *   scope 缺失（API 直连 / 诊断）只计数不设预算；
 * - 硬约束：startAgent / runAgent **启动前**检查本 run 累计（调用数 / token），
 *   超限抛 MODEL_BUDGET_EXCEEDED（permanent 类别，stage 不重试）；已在途调用
 *   不取消，按 Runtime 契约自然 settle 并入账（并发不突破「不启动新任务」）；
 * - 持久化：research/model-ledger.json（原子写、每项目串行）——进程重启 /
 *   checkpoint 恢复不重置计数器；新 run = 新桶（历史留在同一文件里可审计）；
 * - 观测：snapshot() 供 planSharedTail 的优雅降级（预算耗尽 → overflow HITL /
 *   Draft 完成，而不是烧完才失败）与 stalled payload / API 透出。
 *
 * Token 口径：inputTokens + outputTokens + cacheWriteTokens（cacheRead 是重复
 * 消费提示而非新成本；仍单独记录）。estimatedCost 为 provider list-price 估算，
 * 订阅渠道 per-call=0——预算主键是调用数与 token，不依赖不可靠的估算费用。
 */

import { mkdir, readFile } from "node:fs/promises";
import { join } from "node:path";

import { BusinessError } from "../errors.js";
import { currentTraceScope } from "../observability/trace.js";
import { writeJsonAtomic } from "../util/atomic.js";
import type { AgentRuntime, AgentRunHandle, AgentTask, RunAgentInput, RuntimeHealth, RuntimeModelStatus, RuntimeSessionStats, SessionDiagnosticEntry } from "./types.js";

export interface RunBudgetLimits {
  /** 每 run 最大模型调用（启动前检查；0 = 不限制） */
  maxModelCallsPerRun: number;
  /** 每 run 最大 token（input+output+cacheWrite；0 = 不限制） */
  maxRunTokensPerRun: number;
}

export interface RunLedgerEntry {
  runId: string;
  /** 已启动的模型任务数（启动即计，不等 settle） */
  calls: number;
  /** 已 settle 且携带 usage 的任务数 */
  callsWithUsage: number;
  inputTokens: number;
  outputTokens: number;
  cacheReadTokens: number;
  cacheWriteTokens: number;
  estimatedCost: number;
  updatedAt: string;
}

export interface RunLedgerFile {
  schemaVersion: 1;
  entries: Record<string, RunLedgerEntry>;
}

export interface RunBudgetSnapshot {
  runId: string;
  calls: number;
  tokens: number;
  limits: RunBudgetLimits;
  exceeded: boolean;
  exceededReason?: string;
}

export interface RunBudgetLedgerOptions {
  runtime: AgentRuntime;
  limits: RunBudgetLimits;
  /** 项目的账本目录（research/；serviceStack 传 ProjectStore.researchDir） */
  resolveLedgerDir: (projectId: string) => string;
}

const LEDGER_FILE = "model-ledger.json";
const MAX_RUN_IDS_KEPT = 64;

function emptyEntry(runId: string): RunLedgerEntry {
  return {
    runId,
    calls: 0,
    callsWithUsage: 0,
    inputTokens: 0,
    outputTokens: 0,
    cacheReadTokens: 0,
    cacheWriteTokens: 0,
    estimatedCost: 0,
    updatedAt: new Date().toISOString(),
  };
}

function entryTokens(entry: RunLedgerEntry): number {
  return entry.inputTokens + entry.outputTokens + entry.cacheWriteTokens;
}

/**
 * AgentRuntime 装饰器：所有业务服务的模型调用都经过这里（buildServiceStack
 * 组装时包裹；scripted / 真实 runtime 同样适用——测试可以设小预算验证硬约束）。
 */
export class RunBudgetLedgerRuntime implements AgentRuntime {
  readonly provider;
  readonly resolvedModel;

  private readonly inner: AgentRuntime;
  private readonly limits: RunBudgetLimits;
  private readonly resolveLedgerDir: (projectId: string) => string;
  /** 每项目写串行（读多写少；并发 settle 的计数合并安全） */
  private readonly writeQueues = new Map<string, Promise<void>>();
  /** 进程内账本缓存（写透；同步快照供同步 planner 消费，IO 兜底在 chargeCall） */
  private readonly cache = new Map<string, RunLedgerFile>();

  constructor(options: RunBudgetLedgerOptions) {
    this.inner = options.runtime;
    this.limits = options.limits;
    this.resolveLedgerDir = options.resolveLedgerDir;
    this.provider = options.runtime.provider;
    this.resolvedModel = options.runtime.resolvedModel;
    this.releaseProjectSessions = options.runtime.releaseProjectSessions?.bind(options.runtime);
    this.rotateProjectIdleSessions = options.runtime.rotateProjectIdleSessions?.bind(options.runtime);
    this.runtimeStats = options.runtime.runtimeStats?.bind(options.runtime);
    this.sessionDiagnostics = options.runtime.sessionDiagnostics?.bind(options.runtime);
    this.describeAgentContext = options.runtime.describeAgentContext?.bind(options.runtime);
  }

  async startAgent(input: RunAgentInput): Promise<AgentRunHandle> {
    const scope = currentTraceScope();
    const projectId = input.projectId ?? scope?.projectId;
    const runId = scope?.runId;
    if (projectId !== undefined && runId !== undefined) {
      await this.chargeCall(projectId, runId);
    }
    const handle = await this.inner.startAgent(input);
    if (projectId === undefined || runId === undefined) {
      return handle;
    }
    // settle 后入账 usage（不阻塞调用方：后台链；失败只丢观测不丢预算计数）
    void handle.result().then(
      (task) => void this.chargeUsage(projectId, runId, task),
      () => undefined,
    );
    return handle;
  }

  async runAgent(input: RunAgentInput): Promise<AgentTask> {
    const scope = currentTraceScope();
    const projectId = input.projectId ?? scope?.projectId;
    const runId = scope?.runId;
    if (projectId !== undefined && runId !== undefined) {
      await this.chargeCall(projectId, runId);
    }
    const task = await this.inner.runAgent(input);
    if (projectId !== undefined && runId !== undefined) {
      await this.chargeUsage(projectId, runId, task);
    }
    return task;
  }

  async getTask(taskId: string): Promise<AgentTask> {
    return this.inner.getTask(taskId);
  }

  async healthCheck(): Promise<RuntimeHealth> {
    return this.inner.healthCheck();
  }

  async close(): Promise<void> {
    return this.inner.close();
  }

  async modelStatusSnapshot(): Promise<RuntimeModelStatus> {
    return (
      this.inner.modelStatusSnapshot?.() ?? {
        phase: "unknown",
        providers: [],
        detail: "runtime 未暴露模型状态",
      }
    );
  }

  // 可选诊断方法：被装饰 runtime 实现了才透传（签名与基接口完全一致；
  // 绑定在构造器中完成）
  readonly releaseProjectSessions?: (projectId: string) => Promise<number>;
  readonly rotateProjectIdleSessions?: (projectId: string) => Promise<number>;
  readonly runtimeStats?: () => RuntimeSessionStats;
  readonly sessionDiagnostics?: () => SessionDiagnosticEntry[];
  readonly describeAgentContext?: AgentRuntime["describeAgentContext"];

  // ---- 账本 ----

  /** 预算检查 + 调用计数（启动前；并发调用全部计数，不因 settle 时序漏计） */
  private async chargeCall(projectId: string, runId: string): Promise<void> {
    const ledger = await this.loadLedger(projectId);
    const entry = ledger.entries[runId] ?? emptyEntry(runId);
    const nextCalls = entry.calls + 1;
    const reason = this.exceedReason({ ...entry, calls: nextCalls });
    if (reason !== undefined) {
      throw new BusinessError(
        "MODEL_BUDGET_EXCEEDED",
        `本 run 模型预算已耗尽（${reason}；已完成 ${entry.calls} 次调用 / ${entryTokens(entry)} tokens）——不再启动新的模型任务。已落盘产物保留；可提高预算后从 checkpoint 恢复，或接受当前版本为 Draft`,
      );
    }
    entry.calls = nextCalls;
    entry.updatedAt = new Date().toISOString();
    await this.saveLedger(projectId, withEntry(ledger, entry));
  }

  private async chargeUsage(projectId: string, runId: string, task: AgentTask): Promise<void> {
    const usage = task.usage;
    if (usage === undefined) return;
    const ledger = await this.loadLedger(projectId);
    const entry = ledger.entries[runId] ?? emptyEntry(runId);
    entry.callsWithUsage += 1;
    entry.inputTokens += usage.inputTokens ?? 0;
    entry.outputTokens += usage.outputTokens ?? 0;
    entry.cacheReadTokens += usage.cacheReadTokens ?? 0;
    entry.cacheWriteTokens += usage.cacheWriteTokens ?? 0;
    entry.estimatedCost += usage.estimatedCost ?? 0;
    entry.updatedAt = new Date().toISOString();
    await this.saveLedger(projectId, withEntry(ledger, entry));
  }

  private exceedReason(entry: RunLedgerEntry): string | undefined {
    if (this.limits.maxModelCallsPerRun > 0 && entry.calls > this.limits.maxModelCallsPerRun) {
      return `调用数 ${entry.calls} > 上限 ${this.limits.maxModelCallsPerRun}`;
    }
    if (this.limits.maxRunTokensPerRun > 0 && entryTokens(entry) > this.limits.maxRunTokensPerRun) {
      return `token ${entryTokens(entry)} > 上限 ${this.limits.maxRunTokensPerRun}`;
    }
    return undefined;
  }

  private ledgerPath(projectId: string): string {
    return join(this.resolveLedgerDir(projectId), LEDGER_FILE);
  }

  private async loadLedger(projectId: string): Promise<RunLedgerFile> {
    const cached = this.cache.get(projectId);
    if (cached !== undefined) return cached;
    let ledger: RunLedgerFile;
    try {
      const parsed = JSON.parse(await readFile(this.ledgerPath(projectId), "utf8")) as RunLedgerFile;
      if (parsed.schemaVersion === 1 && typeof parsed.entries === "object" && parsed.entries !== null) {
        ledger = parsed;
      } else {
        ledger = { schemaVersion: 1, entries: {} };
      }
    } catch {
      // 缺失 / 损坏 → 空账本重记（预算计数从当前进程重新开始；如实口径）
      ledger = { schemaVersion: 1, entries: {} };
    }
    this.cache.set(projectId, ledger);
    return ledger;
  }

  private async saveLedger(projectId: string, ledger: RunLedgerFile): Promise<void> {
    this.cache.set(projectId, ledger);
    const previous = this.writeQueues.get(projectId) ?? Promise.resolve();
    const task = previous.then(async () => {
      await mkdir(this.resolveLedgerDir(projectId), { recursive: true });
      await writeJsonAtomic(this.ledgerPath(projectId), ledger);
    });
    this.writeQueues.set(projectId, task.catch(() => undefined));
    await task;
  }

  /**
   * 同步快照（planSharedTail 的 plan() 是纯同步函数，不能 await IO）。读进程内
   * 缓存：本进程内计数实时；进程刚启动且尚无调用时返回 null（planner 视为无
   * 预算信号照常派发——首个真实调用会在 chargeCall 里读盘并执行硬约束，兜底
   * 语义不依赖本方法）。
   */
  snapshotSync(projectId: string, runId: string): RunBudgetSnapshot | null {
    const ledger = this.cache.get(projectId);
    if (ledger === undefined) return null;
    const entry = ledger.entries[runId] ?? emptyEntry(runId);
    const reason = this.exceedReason(entry);
    return {
      runId,
      calls: entry.calls,
      tokens: entryTokens(entry),
      limits: this.limits,
      exceeded: reason !== undefined,
      ...(reason !== undefined ? { exceededReason: reason } : {}),
    };
  }

  /** 观测面：本 run 预算状态（planSharedTail 优雅降级 / stalled payload / API） */
  async snapshot(projectId: string, runId: string): Promise<RunBudgetSnapshot> {
    const ledger = await this.loadLedger(projectId);
    const entry = ledger.entries[runId] ?? emptyEntry(runId);
    const reason = this.exceedReason(entry);
    return {
      runId,
      calls: entry.calls,
      tokens: entryTokens(entry),
      limits: this.limits,
      exceeded: reason !== undefined,
      ...(reason !== undefined ? { exceededReason: reason } : {}),
    };
  }

  /** 观测面：整个项目的账本（诊断 / 报告；只读） */
  async projectLedger(projectId: string): Promise<RunLedgerFile> {
    return this.loadLedger(projectId);
  }
}

function withEntry(ledger: RunLedgerFile, entry: RunLedgerEntry): RunLedgerFile {
  const entries = { ...ledger.entries, [entry.runId]: entry };
  // 有界：只保留最近 MAX_RUN_IDS_KEPT 个 run（按更新时间；更早的让位于
  // iteration-history / trace 等完整审计产物，账本只承担预算语义）
  const runIds = Object.values(entries)
    .sort((a, b) => Date.parse(b.updatedAt) - Date.parse(a.updatedAt))
    .slice(0, MAX_RUN_IDS_KEPT)
    .map((record) => record.runId);
  return { schemaVersion: 1, entries: Object.fromEntries(runIds.map((id) => [id, entries[id]!])) };
}

/**
 * planner 语义的「预算耗尽」：已用满（calls/tokens ≥ 上限）即视为不能再启动
 * 新模型任务（每次新 stage 至少 1 次调用，等真正超限再停就晚了）。
 * limits 为 0（不限制）时恒 false。
 */
export function budgetExhausted(snapshot: RunBudgetSnapshot): boolean {
  if (snapshot.exceeded) return true;
  if (snapshot.limits.maxModelCallsPerRun > 0 && snapshot.calls >= snapshot.limits.maxModelCallsPerRun) {
    return true;
  }
  if (snapshot.limits.maxRunTokensPerRun > 0 && snapshot.tokens >= snapshot.limits.maxRunTokensPerRun) {
    return true;
  }
  return false;
}
