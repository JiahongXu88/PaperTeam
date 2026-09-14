/**
 * M5.6 观测面：进程内累计 usage（runtimeStats.usageTotals）——A/B 验收记录 token / cost 的数据源。
 * provider 未返回 usage 的 run 只计 runs，不伪造 0 成本。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";

import { PiRuntimeAdapter } from "../../src/runtime/PiRuntimeAdapter.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

describe("runtimeStats.usageTotals（M5.6）", () => {
  it("settle 时累加 input / output / cache / cost / turns；无 usage 的 run 只计 runs", async () => {
    const agentDir = await mkdtemp(join(tmpdir(), "pi-usage-agent-"));
    const workspaceRoot = await mkdtemp(join(tmpdir(), "pi-usage-ws-"));
    dirs.push(agentDir, workspaceRoot);
    let withUsage = true;
    const adapter = new PiRuntimeAdapter({
      agentDir,
      workspaceRoot,
      modelRuntime: {
        getModel: () => ({ provider: "fake", id: "fake-1" }),
        hasConfiguredAuth: () => true,
        getError: () => undefined,
      } as never,
      model: { provider: "fake", id: "fake-1" } as never,
      createSession: async () => {
        let listener: ((event: unknown) => void) | undefined;
        return {
          prompt: async () => {
            if (withUsage) {
              listener?.({
                type: "message_end",
                message: {
                  role: "assistant",
                  usage: { input: 1000, output: 200, cacheRead: 300, cacheWrite: 50, totalTokens: 1550, cost: { total: 0.012 } },
                },
              });
            }
          },
          abort: async () => {},
          waitForIdle: async () => {},
          dispose: () => {},
          subscribe: (fn: (event: unknown) => void) => {
            listener = fn;
            return () => {
              listener = undefined;
            };
          },
          getLastAssistantText: () => "ok",
          agent: { state: { messages: [{ role: "assistant", content: [{ type: "text", text: "ok" }], stopReason: "end_turn" }] } },
        } as never;
      },
      log: () => {},
    });
    try {
      await adapter.runAgent({ agentId: "writer", task: "a", contextScope: "writing/sections" });
      await adapter.runAgent({ agentId: "writer", task: "b", contextScope: "writing/sections" });
      withUsage = false;
      await adapter.runAgent({ agentId: "reviewer", task: "c", contextScope: "review/academic" });
      const totals = adapter.runtimeStats().usageTotals!;
      expect(totals).toEqual({
        runs: 3,
        runsWithUsage: 2,
        inputTokens: 2000,
        outputTokens: 400,
        cacheReadTokens: 600,
        cacheWriteTokens: 100,
        estimatedCost: 0.024,
        costRuns: 2,
        assistantTurns: 2,
      });
      // 快照是拷贝：外部改写不影响内部计数
      totals.runs = 999;
      expect(adapter.runtimeStats().usageTotals!.runs).toBe(3);
    } finally {
      await adapter.close();
    }
  });
});
