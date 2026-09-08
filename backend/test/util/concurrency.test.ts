/**
 * mapWithConcurrency 原语测试（Review 并发调度与 PaperMap 摘要共用的地基）：
 * - backpressure：maxActive <= limit（20 任务 / limit 3）
 * - permit 不泄漏：worker 抛错后后续任务照常执行
 * - abort：未开始的任务不再执行、已运行的 settle、无未处理 rejection
 * - 顺序：结果按输入顺序（完成顺序故意打乱）
 * - limit 非法值：立即抛 RangeError
 */

import { describe, expect, it } from "vitest";

import { mapWithConcurrency } from "../../src/util/concurrency.js";

const sleep = (ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms));

describe("mapWithConcurrency", () => {
  it("maxActive <= limit（20 任务、limit 3）", async () => {
    let active = 0;
    let maxActive = 0;
    const outcomes = await mapWithConcurrency(
      Array.from({ length: 20 }, (_, index) => index),
      3,
      async (item) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await sleep(5);
        active -= 1;
        return item * 2;
      },
    );
    expect(maxActive).toBeLessThanOrEqual(3);
    // limit 3 且任务足够多：并发度确实被用到（不是退化成串行）
    expect(maxActive).toBe(3);
    expect(outcomes).toHaveLength(20);
    expect(outcomes.every((outcome) => outcome.ok)).toBe(true);
    expect(outcomes[19]).toEqual({ ok: true, value: 38 });
  });

  it("结果按输入顺序（完成顺序故意打乱：1→50ms、2→30ms、3→10ms）", async () => {
    const delays = [50, 30, 10];
    const completionOrder: number[] = [];
    const outcomes = await mapWithConcurrency(
      [1, 2, 3],
      3,
      async (item) => {
        await sleep(delays[item - 1] ?? 5);
        completionOrder.push(item);
        return `s${item}`;
      },
    );
    // 完成顺序 3,2,1（乱序）；输出顺序仍是 1,2,3
    expect(completionOrder).toEqual([3, 2, 1]);
    expect(outcomes.map((outcome) => (outcome.ok ? outcome.value : "ERR"))).toEqual(["s1", "s2", "s3"]);
  });

  it("单个 worker 抛错：只标记该项 ok:false，permit 释放、其余任务照常执行", async () => {
    let active = 0;
    let maxActive = 0;
    const outcomes = await mapWithConcurrency(
      [1, 2, 3, 4, 5, 6],
      2,
      async (item) => {
        active += 1;
        maxActive = Math.max(maxActive, active);
        await sleep(5);
        active -= 1;
        if (item === 2 || item === 5) {
          throw new Error(`boom-${item}`);
        }
        return item;
      },
    );
    expect(maxActive).toBeLessThanOrEqual(2);
    expect(outcomes[1]).toMatchObject({ ok: false });
    expect(outcomes[4]).toMatchObject({ ok: false });
    expect((outcomes[1] as { error: Error }).error).toBeInstanceOf(Error);
    // 失败项之后的任务没有被失败卡死（队列没有死锁）
    expect(outcomes[5]).toEqual({ ok: true, value: 6 });
  });

  it("abort：停止调度新任务；已运行任务 settle；未开始项 ok:false；无未处理 rejection", async () => {
    const controller = new AbortController();
    const started: number[] = [];
    const outcomesPromise = mapWithConcurrency(
      Array.from({ length: 10 }, (_, index) => index),
      2,
      async (item) => {
        started.push(item);
        await sleep(20);
        return item;
      },
      { signal: controller.signal },
    );
    await sleep(35); // 前两批（约 4 个任务）已开始
    controller.abort();
    const outcomes = await outcomesPromise; // 必须能正常 resolve（等待 running settle）
    const startedCount = started.length;
    expect(startedCount).toBeLessThanOrEqual(6);
    expect(outcomes).toHaveLength(10);
    const okCount = outcomes.filter((outcome) => outcome.ok).length;
    expect(okCount).toBe(startedCount); // 开始了的都成功完成（settle 后返回）
    expect(outcomes.filter((outcome) => !outcome.ok)).toHaveLength(10 - startedCount);
    // abort 之后不再有新任务启动
    await sleep(30);
    expect(started).toHaveLength(startedCount);
  });

  it("预先已 abort：一个任务都不执行", async () => {
    const controller = new AbortController();
    controller.abort();
    let ran = 0;
    const outcomes = await mapWithConcurrency(
      [1, 2, 3],
      3,
      async () => {
        ran += 1;
        return ran;
      },
      { signal: controller.signal },
    );
    expect(ran).toBe(0);
    expect(outcomes.every((outcome) => !outcome.ok)).toBe(true);
  });

  it("worker 在 abort 后 throw（取消路径异常）：permit 仍释放，池正常收尾", async () => {
    const controller = new AbortController();
    const outcomesPromise = mapWithConcurrency(
      [1, 2, 3, 4],
      2,
      async (item) => {
        await sleep(15);
        if (controller.signal.aborted) {
          throw new Error("WORKFLOW_CANCELLED");
        }
        return item;
      },
      { signal: controller.signal },
    );
    await sleep(20);
    controller.abort();
    const outcomes = await outcomesPromise;
    expect(outcomes).toHaveLength(4);
    // abort 前完成的前两项成功；abort 后收尾的两项按取消异常 ok:false
    expect(outcomes[0]).toEqual({ ok: true, value: 1 });
    expect(outcomes[1]).toEqual({ ok: true, value: 2 });
    expect(outcomes[2]).toMatchObject({ ok: false });
    expect(outcomes[3]).toMatchObject({ ok: false });
  });

  it("limit 非法：RangeError（0 / 负数 / 非整数）", async () => {
    for (const bad of [0, -1, 1.5, Number.NaN]) {
      await expect(mapWithConcurrency([1, 2], bad, async (x) => x)).rejects.toThrow(RangeError);
    }
  });

  it("空输入 / limit 超过任务数：正常返回", async () => {
    expect(await mapWithConcurrency([], 3, async (x) => x)).toEqual([]);
    const outcomes = await mapWithConcurrency([1], 8, async (x) => x);
    expect(outcomes).toEqual([{ ok: true, value: 1 }]);
  });

  it("onEvent：start/end 事件的 active 计数一致且 <= limit", async () => {
    const events: Array<{ type: string; active: number }> = [];
    await mapWithConcurrency(
      [1, 2, 3, 4, 5],
      2,
      async (item) => {
        await sleep(3);
        return item;
      },
      { onEvent: (event) => events.push({ type: event.type, active: event.active }) },
    );
    const starts = events.filter((event) => event.type === "start");
    const ends = events.filter((event) => event.type === "end");
    expect(starts).toHaveLength(5);
    expect(ends).toHaveLength(5);
    expect(Math.max(...starts.map((event) => event.active))).toBeLessThanOrEqual(2);
    expect(ends.at(-1)?.active).toBe(0); // 全部结束后活跃数归零（无泄漏）
  });
});
