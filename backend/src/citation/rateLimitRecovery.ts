/**
 * 限流恢复 pass（Round 2 真实 run 修订；M13.6 §2 的补丁）。
 *
 * 真实 run（w-d678566b94c1，citation.verify 31 条）暴露的缺陷：原恢复 pass 用
 * 「失败时刻快照」的 retryAfterMs 取 min 推算等待——条目越晚失败快照越小
 * （最后一条 12ms）→ 等待 ≈ 0s；随后一次性补查全部条目，而 provider 仍在冷却
 * （或补查首个请求再次 429 重新进入冷却），其余条目全部被冷却闸门静默短路。
 * 结果：25/25 条限流条目零恢复，日志只有一行「等待 0s 后补查」。
 *
 * 修订后的纪律（bib 层 CitationService 与 PDF 层 CitationIntegrityService 共用；
 * 纯有界循环，不依赖具体服务）：
 * - 等待时长取「实时冷却剩余」（ProviderCooldownRegistry 优先；拿不到冷却提示
 *   时才退回条目自带的重试时间）——至少等到一个仍在冷却的 provider 恢复再补查；
 * - 多轮有界：每轮只补查仍限流的条目；补查中再次 429 → 该 provider 重新冷却，
 *   下一轮继续等待；直到无限流条目 / 预算（deadline）耗尽 / 轮数上限 /
 *   一轮零进展且无冷却提示（防空转）；
 * - 每轮等待、补查、恢复数记入 telemetry；每轮日志必打（含 0s），超预算如实说明。
 */

export interface RateLimitRecoveryOptions {
  /** 恢复预算（毫秒，自调用起算；≤0 关闭恢复） */
  budgetMs: number;
  now: () => number;
  /** 可中断 sleep（abort 时抛错即可，由调用方决定语义） */
  sleep: (ms: number) => Promise<void>;
  /** 当前仍需补查的条目索引（每轮重新计算） */
  pending: () => number[];
  /** 补查一条；返回 true = 该条不再处于限流状态（有进展） */
  retry: (index: number) => Promise<boolean>;
  /** 等待提示（毫秒）：实时冷却剩余；无冷却提示 → 0 */
  waitHintMs: () => number;
  isAborted?: () => boolean;
  /** 轮数上限（默认 6） */
  maxPasses?: number;
  log: (message: string) => void;
  /** 日志前缀（如 "[citation] projectId=…"） */
  label: string;
}

export interface RateLimitRecoveryTelemetry {
  /** 实际执行的补查轮数 */
  passes: number;
  /** 等待冷却累计（毫秒） */
  waitedMs: number;
  /** 补查请求条目次数（跨轮累计） */
  retried: number;
  /** 由限流转为非限流结论的条目数 */
  recovered: number;
  /** 冷却剩余超出预算而放弃（如实返回不可判定，下次核验自动补查） */
  overBudget: boolean;
}

const DEFAULT_MAX_PASSES = 6;

export async function runRateLimitRecovery(options: RateLimitRecoveryOptions): Promise<RateLimitRecoveryTelemetry> {
  const telemetry: RateLimitRecoveryTelemetry = { passes: 0, waitedMs: 0, retried: 0, recovered: 0, overBudget: false };
  if (options.budgetMs <= 0) {
    return telemetry;
  }
  const maxPasses = options.maxPasses ?? DEFAULT_MAX_PASSES;
  const deadline = options.now() + options.budgetMs;
  const seconds = (ms: number): number => Math.round(ms / 1000);
  for (let pass = 1; pass <= maxPasses; pass += 1) {
    if (options.isAborted?.() === true) {
      break;
    }
    const pending = options.pending();
    if (pending.length === 0) {
      break;
    }
    const waitMs = Math.max(0, options.waitHintMs());
    const nowMs = options.now();
    if (nowMs + waitMs > deadline) {
      telemetry.overBudget = true;
      options.log(
        `${options.label} ${pending.length} 条限流条目冷却 ${seconds(waitMs)}s 超过恢复预算（剩余 ${seconds(Math.max(0, deadline - nowMs))}s）：如实返回不可判定（下次核验自动补查）`,
      );
      break;
    }
    options.log(
      `${options.label} 限流恢复第 ${pass} 轮：${pending.length} 条限流条目等待 ${seconds(waitMs)}s 后补查（预算剩余 ${seconds(deadline - nowMs)}s）`,
    );
    if (waitMs > 0) {
      await options.sleep(waitMs);
      telemetry.waitedMs += waitMs;
    }
    telemetry.passes += 1;
    let progressed = 0;
    for (const index of pending) {
      if (options.isAborted?.() === true) {
        break;
      }
      telemetry.retried += 1;
      if (await options.retry(index)) {
        progressed += 1;
        telemetry.recovered += 1;
      }
    }
    options.log(`${options.label} 限流恢复第 ${pass} 轮完成：补查 ${pending.length} 条，恢复 ${progressed} 条`);
    if (progressed === 0 && options.waitHintMs() <= 0) {
      options.log(`${options.label} 限流恢复零进展且无冷却提示：停止补查`);
      break;
    }
  }
  return telemetry;
}
