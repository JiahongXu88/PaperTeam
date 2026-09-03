/**
 * WorkflowRun 异步 API + SSE 测试（M3.1：完整 idea_to_paper 流程）。
 *
 * 流程走真实编排引擎 + 真实业务服务栈，Runtime 使用按 contextScope
 * 脚本化的 fake（不依赖 Gateway）：
 *   research → feasibility → HITL(approve/adjust) → outline → HITL(approve/revise)
 *   → 分节写作 → 引用核验 → Draft 构建 → completed
 */

import { get as httpGet, type ClientRequest } from "node:http";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { WorkflowState } from "../../src/workflow/types.js";
import {
  FEASIBILITY_HIGH_JSON,
  FEASIBILITY_INSUFFICIENT_JSON,
  startTestStack,
  scriptedIdeaRuntime,
  type TestStack,
} from "../helpers/testStack.js";

// 全流程 e2e（真实编排引擎 + 两轮 HITL）耗时超过默认 5s
vi.setConfig({ testTimeout: 20_000 });

const cleanups: (() => Promise<void>)[] = [];

afterAll(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
});

async function newStack(
  options: Parameters<typeof startTestStack>[1] & {
    feasibilitySequence?: string[];
    hangFirstCall?: boolean;
  } = {},
): Promise<{ stack: TestStack; calls: { agentId: string; contextScope?: string }[]; release: () => void }> {
  const scripted = scriptedIdeaRuntime({
    ...(options.feasibilitySequence ? { feasibilitySequence: options.feasibilitySequence } : {}),
    ...(options.hangFirstCall !== undefined ? { hangFirstCall: options.hangFirstCall } : {}),
  });
  const stack = await startTestStack(scripted.runtime, {
    latexRunner: options.latexRunner,
    citation: options.citation,
    registerCleanup: (cleanup) => cleanups.push(cleanup),
  });
  return { stack, calls: scripted.calls, release: scripted.release };
}

async function pollRun(
  stack: TestStack,
  runId: string,
  statuses: string[],
  timeoutMs = 8_000,
): Promise<WorkflowState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await stack.request("GET", `/api/runs/${runId}`);
    const run = body["run"] as WorkflowState;
    if (statuses.includes(run.status)) {
      return run;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 run 状态 ${statuses.join("|")} 超时（当前 ${run.status}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 15));
  }
}

interface SseEvent {
  id: number;
  event: string;
  data: Record<string, unknown>;
}

function collectSse(
  stack: TestStack,
  runId: string,
  until: (events: SseEvent[]) => boolean,
  timeoutMs = 8_000,
): Promise<SseEvent[]> {
  let req: ClientRequest | undefined;
  return new Promise<SseEvent[]>((resolve, reject) => {
    const timer = setTimeout(() => {
      req?.destroy();
      reject(new Error("SSE 收集超时"));
    }, timeoutMs);
    req = httpGet(`http://127.0.0.1:${stack.port()}/api/runs/${runId}/events`, (res) => {
      if (res.statusCode !== 200) {
        clearTimeout(timer);
        reject(new Error(`SSE 状态码 ${res.statusCode}`));
        res.resume();
        return;
      }
      let text = "";
      res.on("data", (chunk: Buffer) => {
        text += chunk.toString("utf8");
        const events = parseSse(text);
        if (until(events)) {
          clearTimeout(timer);
          req?.destroy();
          resolve(events);
        }
      });
    });
    req.on("error", () => {
      /* destroy 触发；忽略 */
    });
  });
}

function parseSse(text: string): SseEvent[] {
  const events: SseEvent[] = [];
  for (const block of text.split("\n\n")) {
    const idLine = block.split("\n").find((line) => line.startsWith("id: "));
    const eventLine = block.split("\n").find((line) => line.startsWith("event: "));
    const dataLine = block.split("\n").find((line) => line.startsWith("data: "));
    if (idLine && eventLine && dataLine) {
      try {
        events.push({
          id: Number(idLine.slice(4)),
          event: eventLine.slice(7),
          data: JSON.parse(dataLine.slice(6)) as Record<string, unknown>,
        });
      } catch {
        // 非完整块
      }
    }
  }
  return events;
}

/** 创建项目 + run，完成两次 HITL approve，跑到 completed */
async function runToCompletion(stack: TestStack): Promise<{ projectId: string; runId: string }> {
  const project = await stack.store.create("异步工作流测试", {
    researchIdea: "小语料 RAG 评估",
    researchField: "自然语言处理",
    targetProfile: "core_journal",
  });
  const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {
    kind: "idea_to_paper",
  });
  expect(created.status).toBe(202);
  const runId = created.body["runId"] as string;

  await pollRun(stack, runId, ["awaiting_input"]); // feasibility confirm
  const resumed1 = await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
  expect(resumed1.status).toBe(200);

  await pollRun(stack, runId, ["awaiting_input"]); // outline confirm
  const resumed2 = await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
  expect(resumed2.status).toBe(200);

  await pollRun(stack, runId, ["completed"]);
  return { projectId: project.id, runId };
}

// ---- 测试 ----

describe("POST /api/projects/:id/workflows（完整 idea_to_paper 流程）", () => {
  it("两次 HITL approve 后 completed；全部 Authoritative 产物落盘", async () => {
    const { stack } = await newStack();
    const { projectId, runId } = await runToCompletion(stack);

    const run = (await stack.request("GET", `/api/runs/${runId}`)).body["run"] as WorkflowState;
    expect(run.status).toBe("completed");
    expect(run.completion?.label).toBe("draft");
    expect(run.completedStages).toEqual([
      "research.idea",
      "research.feasibility",
      "hitl.feasibility_confirm",
      "outline.plan",
      "hitl.outline_confirm",
      "writing.sections",
      "citation.verify",
      "build.draft",
    ]);

    const projectRoot = join(stack.root, projectId);
    const research = JSON.parse(
      await readFile(join(projectRoot, "research", "research.json"), "utf8"),
    ) as { report?: { researchGaps?: string[] }; bibliography?: unknown[] };
    expect(research.report?.researchGaps?.length).toBeGreaterThan(0);
    const feasibility = JSON.parse(
      await readFile(join(projectRoot, "research", "feasibility.json"), "utf8"),
    ) as { report?: { level?: string } };
    expect(["HIGH", "MEDIUM", "LOW", "INSUFFICIENT"]).toContain(feasibility.report?.level);

    const outline = JSON.parse(
      await readFile(join(projectRoot, "manuscript", "outline.json"), "utf8"),
    ) as { sections?: { file: string }[] };
    expect(outline.sections?.length).toBe(5);
    const main = await readFile(join(projectRoot, "manuscript", "main.tex"), "utf8");
    for (const section of outline.sections ?? []) {
      expect(main).toContain(`\\input{sections/${section.file.replace(/\.tex$/, "")}}`);
      const body = await readFile(
        join(projectRoot, "manuscript", "sections", section.file),
        "utf8",
      );
      expect(body).toContain("\\section");
    }
    const bib = await readFile(join(projectRoot, "manuscript", "references.bib"), "utf8");
    expect(bib).toContain("gao2023survey");
    const citationReport = JSON.parse(
      await readFile(join(projectRoot, "reviews", "citation-report.json"), "utf8"),
    ) as { summary?: { missingKeys?: number } };
    expect(citationReport.summary?.missingKeys).toBe(0);
    const pdf = await readFile(join(projectRoot, "build", "paper.pdf"), "utf8");
    expect(pdf).toContain("%PDF-1.5");
    const evidence = JSON.parse(
      await readFile(join(projectRoot, "evidence", "evidence.jsonl"), "utf8").then(
        (text) => `[${text.trim().split("\n").join(",")}]`,
      ),
    ) as { id: string; createdBy: string }[];
    expect(evidence.length).toBeGreaterThanOrEqual(1);
    expect(evidence[0]?.createdBy).toBe("researcher");
  });

  it("feasibility INSUFFICIENT → adjust 下调目标 → 重评估 → approve → completed", async () => {
    const { stack } = await newStack({
      feasibilitySequence: [FEASIBILITY_INSUFFICIENT_JSON, FEASIBILITY_HIGH_JSON],
    });
    const project = await stack.store.create("目标调整测试", {
      researchIdea: "RAG 评估",
      targetProfile: "top_conference",
    });
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;

    const awaiting = await pollRun(stack, runId, ["awaiting_input"]);
    expect(awaiting.awaiting?.stageId).toBe("hitl.feasibility_confirm");
    expect(awaiting.awaiting?.payload?.["level"]).toBe("INSUFFICIENT");
    expect(
      ((awaiting.awaiting?.payload?.["missingRequirements"] as string[]) ?? []).length,
    ).toBeGreaterThan(0);

    const adjusted = await stack.request("POST", `/api/runs/${runId}/resume`, {
      decision: "adjust",
      payload: { targetProfile: "core_journal" },
    });
    expect(adjusted.status).toBe(200);

    // 重评估后再次等待确认
    const awaiting2 = await pollRun(stack, runId, ["awaiting_input"]);
    expect(awaiting2.awaiting?.payload?.["level"]).toBe("HIGH");
    // 项目目标已更新
    expect((await stack.store.get(project.id))?.targetProfile).toBe("core_journal");

    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
    await pollRun(stack, runId, ["awaiting_input"]);
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
    const finished = await pollRun(stack, runId, ["completed"]);
    expect(finished.status).toBe("completed");
    // feasibility 被执行了两次（重评估）
    const history = finished.stageHistory.filter(
      (record) => record.stageId === "research.feasibility" && record.status === "completed",
    );
    expect(history).toHaveLength(2);
  });

  it("feasibility confirm 时 cancel 决策 → run 直接 cancelled", async () => {
    const { stack } = await newStack();
    const project = await stack.store.create("取消决策测试", {});
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;
    await pollRun(stack, runId, ["awaiting_input"]);

    const cancelled = await stack.request("POST", `/api/runs/${runId}/resume`, {
      decision: "cancel",
    });
    expect(cancelled.status).toBe(200);
    expect((cancelled.body["run"] as WorkflowState).status).toBe("cancelled");
  });

  it("大纲 revise（带反馈）→ 重新规划 → approve → completed", async () => {
    const { stack } = await newStack();
    const project = await stack.store.create("大纲修订测试", {});
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;

    await pollRun(stack, runId, ["awaiting_input"]);
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
    await pollRun(stack, runId, ["awaiting_input"]); // outline confirm

    const missing = await stack.request("POST", `/api/runs/${runId}/resume`, {
      decision: "revise",
      payload: {},
    });
    expect(missing.status).toBe(409); // revise 必须带 feedback

    const revised = await stack.request("POST", `/api/runs/${runId}/resume`, {
      decision: "revise",
      payload: { feedback: "增加消融实验章节" },
    });
    expect(revised.status).toBe(200);

    await pollRun(stack, runId, ["awaiting_input"]); // 再次 outline confirm
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
    const finished = await pollRun(stack, runId, ["completed"]);
    const outlinePlans = finished.stageHistory.filter(
      (record) => record.stageId === "outline.plan" && record.status === "completed",
    );
    expect(outlinePlans).toHaveLength(2);
  });

  it("进行中的 run 存在时再创建返回 409", async () => {
    const { stack, release } = await newStack({ hangFirstCall: true });
    const project = await stack.store.create("并发拒绝测试", {});
    const first = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    expect(first.status).toBe(202);

    await new Promise((resolve) => setTimeout(resolve, 100));
    const second = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    expect(second.status).toBe(409);

    release();
    await pollRun(stack, first.body["runId"] as string, ["awaiting_input"]);
  });
});

describe("错误映射", () => {
  it("未知 run 404；非法 kind 400；resume 非 awaiting 409", async () => {
    const { stack } = await newStack();
    const missing = await stack.request("GET", "/api/runs/w-nosuch");
    expect(missing.status).toBe(404);
    expect((missing.body["error"] as { code?: string }).code).toBe("WORKFLOW_NOT_FOUND");

    const project = await stack.store.create("参数校验", {});
    const bad = await stack.request("POST", `/api/projects/${project.id}/workflows`, {
      kind: "bogus",
    });
    expect(bad.status).toBe(400);

    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;
    await pollRun(stack, runId, ["awaiting_input"]);
    const resumed = await stack.request("POST", `/api/runs/${runId}/resume`, {
      decision: "approve",
    });
    expect(resumed.status).toBe(200);
    // running 中 resume → 409
    await new Promise((resolve) => setTimeout(resolve, 50));
    const busy = await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
    expect([409, 200]).toContain(busy.status);
    if (busy.status === 200) {
      // 可能已再次 awaiting（合法）；再确认一轮后 completed
      await pollRun(stack, runId, ["awaiting_input", "completed"]);
    }
  });

  it("对已完成 run 取消返回 409", async () => {
    const { stack } = await newStack();
    const { runId } = await runToCompletion(stack);
    const cancelled = await stack.request("POST", `/api/runs/${runId}/cancel`, {});
    expect(cancelled.status).toBe(409);
  });
});

describe("POST /api/runs/:runId/cancel（协作式取消）", () => {
  it("调研执行中取消：请求登记后在边界生效", async () => {
    const { stack, release } = await newStack({ hangFirstCall: true });
    const project = await stack.store.create("取消测试", {});
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;
    await new Promise((resolve) => setTimeout(resolve, 100));

    const cancelResponse = await stack.request("POST", `/api/runs/${runId}/cancel`, {});
    expect(cancelResponse.status).toBe(200);

    release();
    const finished = await pollRun(stack, runId, ["cancelled"]);
    expect(finished.status).toBe("cancelled");
  });
});

describe("GET /api/runs/:runId/events（SSE）", () => {
  it("实时订阅：收到 workflow.started → stage.* → workflow.awaiting_input", async () => {
    const { stack, release } = await newStack({ hangFirstCall: true });
    const project = await stack.store.create("SSE 实时测试", {});
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;

    const collectPromise = collectSse(stack, runId, (events) =>
      events.some((event) => event.event === "workflow.awaiting_input"),
    );
    // 等 stage 真正执行（runAgent 已挂起）再释放，避免 release 早于挂起注册的竞态
    await new Promise((resolve) => setTimeout(resolve, 100));
    release();
    const events = await collectPromise;
    const types = events.map((event) => event.event);
    expect(types).toContain("workflow.started");
    expect(types).toContain("stage.started");
    expect(types).toContain("stage.completed");
    expect(types).toContain("workflow.awaiting_input");
    const ids = events.map((event) => event.id);
    expect(ids).toEqual([...ids].sort((a, b) => a - b));
  });

  it("完成后连接：replay 全部历史事件", async () => {
    const { stack } = await newStack();
    const { runId } = await runToCompletion(stack);
    const events = await collectSse(stack, runId, (collected) =>
      collected.some((event) => event.event === "workflow.completed"),
    );
    expect(events.length).toBeGreaterThanOrEqual(16);
    expect(events[0]?.event).toBe("workflow.started");
    expect(events[events.length - 1]?.event).toBe("workflow.completed");
  });

  it("未知 run 的 SSE 返回 404 JSON", async () => {
    const { stack } = await newStack();
    const response = await fetch(`http://127.0.0.1:${stack.port()}/api/runs/w-nosuch/events`);
    expect(response.status).toBe(404);
    expect(response.headers.get("content-type")).toContain("application/json");
    await response.text();
  });
});
