/**
 * M14.5 跨实验统一总预算账本（测试编排器层）的确定性验证：
 * 持久化 / 重启不重置 / 失败重试不获新额度 / 多实验共享 / 上限只能收紧 / token 上限 / 拦截留痕。
 */
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { GlobalBudgetLedger } from "../helpers/globalBudgetLedger.js";

describe("M14.5 GlobalBudgetLedger（跨实验统一总预算）", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true });
  });

  async function freshPath(): Promise<string> {
    const dir = await mkdtemp(join(tmpdir(), "m145-global-ledger-"));
    dirs.push(dir);
    return join(dir, "nested", "ledger.json");
  }

  it("调用数上限：第 N+1 次启动前拦截（MODEL_BUDGET_EXCEEDED），且重启 / 新实验 / 重试不重置", async () => {
    const path = await freshPath();
    const a = new GlobalBudgetLedger(path, "exp-A", { maxCalls: 3, maxTokens: 0 });
    a.chargeCall();
    a.chargeCall();
    a.chargeUsage({ inputTokens: 100, outputTokens: 20, cacheWriteTokens: 5, cacheReadTokens: 50, estimatedCost: 0 });
    // 「进程重启」= 同一路径新建实例（另一实验 id）：计数从账本续接，不从 0 开始
    const b = new GlobalBudgetLedger(path, "exp-B", { maxCalls: 3, maxTokens: 0 });
    b.chargeCall(); // 第 3 次：允许
    expect(() => b.chargeCall()).toThrow(/MODEL_BUDGET_EXCEEDED|跨实验总预算已耗尽/);
    // 失败后再试（模拟 stage 重试）仍然拒绝——不获新额度
    expect(() => b.chargeCall()).toThrow(/跨实验总预算已耗尽/);
    expect(() => a.chargeCall()).toThrow(/跨实验总预算已耗尽/);
    const file = JSON.parse(await readFile(path, "utf8")) as ReturnType<GlobalBudgetLedger["snapshot"]>;
    expect(file.totals.calls).toBe(3);
    expect(file.totals.inputTokens).toBe(100);
    expect(file.totals.cacheReadTokens).toBe(50);
    expect(file.experiments.map((item) => [item.id, item.calls])).toEqual([["exp-A", 2], ["exp-B", 1]]);
    expect(file.experiments[0]!.tokens).toBe(125); // input+output+cacheWrite（cacheRead 单列不计）
    expect(file.stops).toHaveLength(3);
    expect(file.stops.map((stop) => stop.experimentId)).toEqual(["exp-B", "exp-B", "exp-A"]);
  });

  it("上限只能收紧不能放宽；token 上限达到即拦截；0 = 不限制", async () => {
    const path = await freshPath();
    const strict = new GlobalBudgetLedger(path, "exp-1", { maxCalls: 10, maxTokens: 1_000 });
    strict.chargeCall();
    strict.chargeUsage({ inputTokens: 900, outputTokens: 100 });
    // 第二次声明更宽松的上限：账本保持严格值
    const loose = new GlobalBudgetLedger(path, "exp-2", { maxCalls: 100, maxTokens: 50_000 });
    expect(loose.snapshot().limits).toEqual({ maxCalls: 10, maxTokens: 1_000 });
    // token 已达 1000 ≥ 上限 → 即便调用数未满也拦截
    expect(() => loose.chargeCall()).toThrow(/全局 token 1000 ≥ 上限 1000/);
    // 不限制 token 的账本（maxTokens=0）只受调用数约束
    const unlimited = new GlobalBudgetLedger(await freshPath(), "exp-3", { maxCalls: 0, maxTokens: 0 });
    for (let index = 0; index < 20; index += 1) unlimited.chargeCall();
    expect(unlimited.snapshot().totals.calls).toBe(20);
    expect(unlimited.snapshot().stops).toHaveLength(0);
  });
});
