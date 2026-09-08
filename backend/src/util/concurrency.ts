/**
 * 通用有界并发原语（backpressure 的唯一实现，Review 调度与 PaperMap 摘要共用）。
 *
 * 模型：固定数量的 runner 从共享队列按序取任务——「任务开始」本身就受
 * limit 约束（不是先创建 N 个 Promise 再靠 await 压住），因此活跃模型调用
 * 永远 <= limit，未开始的任务不占用 session / permit 等任何资源。
 *
 * 语义保证（测试逐一覆盖）：
 * - limit 必须是 >= 1 的整数（程序员错误：立即抛 RangeError，不静默纠正）；
 * - permit 不泄漏：worker 抛错 / AbortSignal 触发都走 finally 释放；
 * - 单个 worker 失败只影响它自己那一项（结果标记 ok:false），其余任务
 *   照常执行——绝不用裸 Promise.all 让一次失败推翻整个池；
 * - AbortSignal：触发后停止调度新任务（未开始的项标记 ok:false），
 *   已在跑的任务自然 settle（协作式取消由 worker 内部经自己的 signal 传导），
 *   mapWithConcurrency 本身总是等全部 runner 退出后才 resolve；
 * - 返回结果按输入顺序排列（执行顺序不确定，输出顺序确定）。
 *
 * 本原语面向 I/O 并发（LLM HTTP 调用）：只用 Promise / 事件循环，
 * 不引入 Worker Threads（那是 CPU-bound 工具，见任务纪律）。
 */

export interface ConcurrencyEvent {
  type: "start" | "end";
  /** 任务在输入中的下标 */
  index: number;
  /** 本事件后的活跃任务数（start 时已 +1 / end 时已 -1） */
  active: number;
  /** end 事件：worker 是否成功 */
  ok?: boolean;
}

export interface MapWithConcurrencyOptions {
  /** 触发后停止调度新任务；运行中的任务由 worker 自行响应（如透传 signal 给模型调用） */
  signal?: AbortSignal;
  /** 任务开始/结束观察（telemetry：maxActive、队列等待等） */
  onEvent?: (event: ConcurrencyEvent) => void;
}

export type ConcurrencyOutcome<R> = { ok: true; value: R } | { ok: false; error: unknown };

/** 校验并发度（各业务入口的 env 解析负责「无效回退默认」，这里只防程序员错误） */
export function assertValidConcurrency(limit: number, label = "limit"): void {
  if (!Number.isInteger(limit) || limit < 1) {
    throw new RangeError(`${label} 必须是 >= 1 的整数，当前为 ${limit}`);
  }
}

/**
 * 按输入顺序返回每项的结果；单测关注点：
 * max(active) <= limit、abort 后未开始项不再执行、结果顺序与输入一致。
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T, index: number) => Promise<R>,
  options: MapWithConcurrencyOptions = {},
): Promise<ConcurrencyOutcome<R>[]> {
  assertValidConcurrency(limit);
  const results = new Array<ConcurrencyOutcome<R>>(items.length);
  const abortedError = () =>
    options.signal?.reason instanceof Error
      ? options.signal.reason
      : new Error(`任务在开始前已被取消（index 队列中止）`);

  let nextIndex = 0;
  let active = 0;

  // 固定 runner 池：runner 数量 = min(limit, items.length)，空闲即取下一项
  const runnerCount = Math.min(limit, items.length);
  const runners = Array.from({ length: runnerCount }, async () => {
    for (;;) {
      // 停止调度：abort 后不再取新任务（running 的自然 settle）
      if (options.signal?.aborted) {
        return;
      }
      const index = nextIndex;
      if (index >= items.length) {
        return;
      }
      nextIndex += 1;
      active += 1;
      options.onEvent?.({ type: "start", index, active });
      try {
        const value = await worker(items[index]!, index);
        results[index] = { ok: true, value };
      } catch (error) {
        results[index] = { ok: false, error };
      } finally {
        active -= 1;
        options.onEvent?.({ type: "end", index, active, ok: results[index]?.ok === true });
      }
    }
  });
  // runner 永不 reject（异常都收进 results），await 即「等 running settle」
  await Promise.all(runners);

  // 未被调度（abort）的任务：如实标记为取消，而不是留 undefined
  for (let index = 0; index < results.length; index += 1) {
    if (results[index] === undefined) {
      results[index] = { ok: false, error: abortedError() };
    }
  }
  return results;
}
