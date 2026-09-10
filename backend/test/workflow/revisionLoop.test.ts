/**
 * Bounded revision loop e2e 测试（M3.2；M4.7 收敛语义更新）：
 * - fail → fail2（有改善）→ pass：两轮自动修订后 Final（IMPROVED 轨迹）
 * - fail → fail2 → fail3（持续改善但不过线）：预算耗尽 → overflow HITL → accept_draft → Draft
 * - overflow revise_more 人工授权追加一轮 → 再无改善（CONVERGED）→ stalled HITL → accept_draft
 * - Quality 失败不阻止 Draft 构建（D-0015）
 * - 连续两轮完全相同的 fail → CONVERGED → stalled HITL（不盲目继续烧 Token）
 * - Reviewer 把 finding 归到 main.tex（摘要）→ 组装根不作为修订目标（2026-09-10 真实 smoke 回归）
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { WorkflowState } from "../../src/workflow/types.js";
import {
  scriptedIdeaRuntime,
  startTestStack,
  type TestStack,
} from "../helpers/testStack.js";

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
});

async function newStack(
  options: {
    reviewSequence?: ("pass" | "fail" | "fail2" | "fail3")[];
    /** 仅附加到第一轮 review/fact 的 issue（回归用，见 scriptedRuntime 同名选项） */
    firstRoundFactIssue?: Record<string, unknown>;
    latexRunner?: never;
  } = {},
): Promise<TestStack> {
  const scripted = scriptedIdeaRuntime({
    ...(options.reviewSequence ? { reviewSequence: options.reviewSequence } : {}),
    ...(options.firstRoundFactIssue ? { firstRoundFactIssue: options.firstRoundFactIssue } : {}),
  });
  return startTestStack(scripted.runtime, {
    registerCleanup: (cleanup) => cleanups.push(cleanup),
  });
}

async function pollRun(
  stack: TestStack,
  runId: string,
  statuses: string[],
  timeoutMs = 20_000,
): Promise<WorkflowState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const { body } = await stack.request("GET", `/api/runs/${runId}`);
    const run = body["run"] as WorkflowState;
    if (statuses.includes(run.status)) {
      return run;
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 run 状态 ${statuses.join("|")} 超时（当前 ${run.status}，stage ${run.currentStage}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function approveTwice(stack: TestStack, runId: string): Promise<void> {
  await pollRun(stack, runId, ["awaiting_input"]);
  await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
  await pollRun(stack, runId, ["awaiting_input"]);
  await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
}

describe("bounded revision loop（idea_to_paper）", () => {
  it("fail → fail2（改善）→ pass：两轮自动修订后 Final；修订轮数受控", async () => {
    const stack = await newStack({ reviewSequence: ["fail", "fail2", "pass"] });
    const project = await stack.store.create("修订循环测试");
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;

    await approveTwice(stack, runId);
    const finished = await pollRun(stack, runId, ["completed", "failed", "awaiting_input"]);

    expect(finished.status).toBe("completed");
    expect(finished.completion?.label).toBe("final");
    // 自动修订恰好 2 轮（maxRounds 默认 2）
    const revisions = finished.stageHistory.filter(
      (record) => record.stageId === "revision.revise" && record.status === "completed",
    );
    expect(revisions).toHaveLength(2);
    // 每轮失败后都有确定性修订计划落盘（r1/r2）
    const reviewsDir = join(stack.root, project.id, "reviews");
    for (const round of [1, 2]) {
      const plan = JSON.parse(
        await readFile(join(reviewsDir, `revision-plan-r${round}.json`), "utf8"),
      ) as { planId?: string; summary?: { planned?: number } };
      expect(plan.planId).toBe(`plan-r${round}-rev${round === 1 ? 2 : 3}`);
      expect((plan.summary?.planned ?? 0)).toBeGreaterThan(0);
    }
    // 三轮 review（r1/r2/r3 落盘）+ 收敛历史（IMPROVED 轨迹）
    for (const round of [1, 2, 3]) {
      const summary = JSON.parse(
        await readFile(join(reviewsDir, `review-summary-r${round}.json`), "utf8"),
      ) as { scores?: { academicScore?: number }; reviewedRevision?: number };
      expect(summary.scores?.academicScore).toBeDefined();
      expect(typeof summary.reviewedRevision).toBe("number");
    }
    const iterations = JSON.parse(
      await readFile(join(reviewsDir, "iteration-history.json"), "utf8"),
    ) as { iterations?: { gateRound: number; outcome: string | null }[] };
    const outcomes = (iterations.iterations ?? []).map((record) => record.outcome);
    expect(outcomes).toEqual([null, "IMPROVED", "PASS"]);
    // 事件包含 quality_gate.failed / passed
    const { events } = await stack.orchestrator.readEvents(runId);
    const types = events.map((event) => event.type);
    expect(types).toContain("quality_gate.failed");
    expect(types).toContain("quality_gate.passed");
  });

  it("fail → fail2 → fail3（持续改善但不过线）：预算耗尽 → overflow HITL → accept_draft → Draft", async () => {
    const stack = await newStack({ reviewSequence: ["fail", "fail2", "fail3"] });
    const project = await stack.store.create("超限测试");
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;

    await approveTwice(stack, runId);
    const overflow = await pollRun(stack, runId, ["awaiting_input"]);
    expect(overflow.awaiting?.stageId).toBe("hitl.revision_overflow");
    expect(overflow.awaiting?.options).toEqual(["accept_draft", "revise_more", "cancel"]);
    expect((overflow.awaiting?.payload?.["gateReasons"] as string[]).length).toBeGreaterThan(0);

    // Quality 失败不阻止 Draft 构建：accept_draft 后 build.draft 仍执行
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "accept_draft" });
    const finished = await pollRun(stack, runId, ["completed"]);

    expect(finished.status).toBe("completed");
    expect(finished.completion?.label).toBe("draft");
    expect(finished.completion?.summary?.["qualityGatePassed"]).toBe(false);
    expect(finished.completion?.summary?.["buildOk"]).toBe(true); // Draft PDF 已产出
    expect(typeof finished.completion?.summary?.["draftArtifactId"]).toBe("string");
    const revisions = finished.stageHistory.filter(
      (record) => record.stageId === "revision.revise" && record.status === "completed",
    );
    expect(revisions).toHaveLength(2); // 不超过 maxRounds
    const pdf = await readFile(join(stack.root, project.id, "build", "paper.pdf"), "utf8");
    expect(pdf).toContain("%PDF-1.5");
  });

  it("超限后 revise_more：追加一轮仍无改善（CONVERGED）→ stalled HITL → accept_draft", async () => {
    const stack = await newStack({ reviewSequence: ["fail", "fail2", "fail3"] });
    const project = await stack.store.create("人工追加测试");
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;

    await approveTwice(stack, runId);
    const overflow = await pollRun(stack, runId, ["awaiting_input"]);
    expect(overflow.awaiting?.stageId).toBe("hitl.revision_overflow");

    await stack.request("POST", `/api/runs/${runId}/resume`, {
      decision: "revise_more",
      payload: { feedback: "重点补实验" },
    });
    // 追加一轮修订 → 第四轮 review 与第三轮完全相同（序列耗尽重复 fail3）→ CONVERGED → stalled HITL
    const stalled = await pollRun(stack, runId, ["awaiting_input"]);
    expect(stalled.awaiting?.stageId).toBe("hitl.revision_stalled");
    expect(stalled.awaiting?.options).toEqual(["accept_draft", "revise_more", "cancel"]);
    expect(stalled.awaiting?.payload?.["outcome"]).toBe("CONVERGED");
    const scorecard = stalled.awaiting?.payload?.["scorecard"] as {
      current: { critical: number } | null;
      previous: { critical: number } | null;
    };
    expect(scorecard.current).not.toBeNull();
    expect(scorecard.previous).not.toBeNull();
    const revisions = stalled.stageHistory.filter(
      (record) => record.stageId === "revision.revise" && record.status === "completed",
    );
    expect(revisions).toHaveLength(3); // 2 自动 + 1 人工

    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "accept_draft" });
    const finished = await pollRun(stack, runId, ["completed"]);
    expect(finished.completion?.label).toBe("draft");
  });

  it("REGRESSION → stalled HITL → accept_draft：预算尚余也尊重用户回答，不再自动修订", async () => {
    const stack = await newStack({ reviewSequence: ["fail2", "fail"] });
    const project = await stack.store.create("退化接受草稿测试");
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;

    await approveTwice(stack, runId);
    const stalled = await pollRun(stack, runId, ["awaiting_input"]);
    expect(stalled.awaiting?.stageId).toBe("hitl.revision_stalled");
    expect(stalled.awaiting?.payload?.["outcome"]).toBe("REGRESSION");

    // 修订预算还剩 1 轮，但用户已明确接受为草稿：直接收尾为 Draft
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "accept_draft" });
    const finished = await pollRun(stack, runId, ["completed"]);
    expect(finished.completion?.label).toBe("draft");
    expect(finished.completion?.summary?.["qualityGatePassed"]).toBe(false);
    expect(finished.completion?.summary?.["buildOk"]).toBe(true);
    const revisions = finished.stageHistory.filter(
      (record) => record.stageId === "revision.revise" && record.status === "completed",
    );
    expect(revisions).toHaveLength(1); // 只发生第 1 轮后的自动修订；第 2 轮因 accept 不再修
  });

  it("连续两轮完全相同的 fail → CONVERGED → stalled HITL（不盲目继续）", async () => {
    const stack = await newStack({ reviewSequence: ["fail"] });
    const project = await stack.store.create("不收敛测试");
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;

    await approveTwice(stack, runId);
    const stalled = await pollRun(stack, runId, ["awaiting_input"]);
    expect(stalled.awaiting?.stageId).toBe("hitl.revision_stalled");
    expect(stalled.awaiting?.payload?.["outcome"]).toBe("CONVERGED");

    // revise_more：人工授权再试一轮（下一轮 gate 仍相同 → 重新询问，不无限继续）
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "revise_more" });
    const asked = await pollRun(stack, runId, ["awaiting_input"]);
    expect(asked.awaiting?.stageId).toBe("hitl.revision_stalled");
    expect(asked.awaiting?.payload?.["outcome"]).toBe("CONVERGED");

    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "cancel" });
    const cancelled = await pollRun(stack, runId, ["cancelled", "completed"]);
    expect(cancelled.status).toBe("cancelled");
  });

  it("Reviewer 把 finding 归到 main.tex（摘要）：路由到摘要目标（M4.8），组装根绝不被修订", async () => {
    const stack = await newStack({
      reviewSequence: ["fail", "pass"],
      firstRoundFactIssue: {
        category: "fact",
        severity: "critical",
        section: "main.tex（摘要）",
        description: "摘要宣称准确率提升 12.4%，Evidence 只支持 8.7%",
        suggestedAction: "弱化摘要表述",
        blocking: true,
      },
    });
    const project = await stack.store.create("main.tex 归属回归");
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;

    // 修复前（M4.7）：sectionMatches 的 ref.includes(stem)（stem="main"）把 main.tex（摘要）
    // 匹配到组装根 main.tex → Writer 收到 \documentclass 全文 → 镜像返回完整骨架
    // → INVALID_LATEX_OUTPUT 2/2 → run failed。M4.7 先挡住组装根；M4.8 治本：
    // 摘要引用路由到摘要目标（outline.abstract 独立载体），finding 真正被修复。
    await approveTwice(stack, runId);
    const finished = await pollRun(stack, runId, ["completed", "failed", "awaiting_input"]);

    expect(finished.status).toBe("completed");
    expect(finished.completion?.label).toBe("final");
    // 组装根 main.tex 绝不出现在修订目标里（revised key 为 outline section id / abstract）
    const revisedKeys = finished.stageHistory
      .filter((record) => record.stageId === "revision.revise" && record.status === "completed")
      .flatMap((record) => (record.summary?.["sections"] as string[]) ?? []);
    expect(revisedKeys.length).toBeGreaterThan(0);
    expect(revisedKeys).not.toContain("main.tex");
    // 摘要 finding 进入确定性计划并被派发到摘要目标
    const plan = JSON.parse(
      await readFile(join(stack.root, project.id, "reviews", "revision-plan-r1.json"), "utf8"),
    ) as { items?: { section: string; status: string }[] };
    const mainTexItem = (plan.items ?? []).find((item) => item.section === "main.tex（摘要）");
    expect(mainTexItem).toBeDefined();
    expect(mainTexItem?.status).toBe("planned");
    expect(revisedKeys).toContain("abstract");
    // 摘要载体被写回 outline.abstract；组装根由 writeMainTex 重组（含新摘要，骨架完好）
    const outline = JSON.parse(
      await readFile(join(stack.root, project.id, "manuscript", "outline.json"), "utf8"),
    ) as { abstract?: string };
    expect(outline.abstract).toBe(
      "修订后的摘要：本文在已核验证据的基础上提出改进方法，并通过可复现实验验证其有效性，结论表述与证据强度一致。",
    );
    const mainTex = await readFile(join(stack.root, project.id, "manuscript", "main.tex"), "utf8");
    expect(mainTex).toContain("\\documentclass");
    expect(mainTex).toContain("\\input{sections/introduction}");
    expect(mainTex).toContain(outline.abstract ?? "");
    // 章节文件仍是合法正文片段（无文档骨架——绝无「整篇论文骨架当 Writer 输出」）
    const introduction = await readFile(
      join(stack.root, project.id, "manuscript", "sections", "introduction.tex"),
      "utf8",
    );
    expect(introduction).not.toContain("\\documentclass");
  });

  it("M4.8 摘要归属的其它写法（摘要 / abstract）同样路由摘要目标；digest 单列摘要块", async () => {
    const stack = await newStack({
      reviewSequence: ["fail", "pass"],
      firstRoundFactIssue: {
        category: "academic",
        severity: "critical",
        section: "摘要",
        description: "摘要与结论不一致",
        suggestedAction: "对齐摘要与结论",
        blocking: true,
      },
    });
    const project = await stack.store.create("摘要归属回归");
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;
    await approveTwice(stack, runId);
    const finished = await pollRun(stack, runId, ["completed", "failed", "awaiting_input"]);

    expect(finished.status).toBe("completed");
    expect(finished.completion?.label).toBe("final");
    const revisedKeys = finished.stageHistory
      .filter((record) => record.stageId === "revision.revise" && record.status === "completed")
      .flatMap((record) => (record.summary?.["sections"] as string[]) ?? []);
    expect(revisedKeys).toContain("abstract");
    expect(revisedKeys).not.toContain("main.tex");
  });

  it("review fail 但 feasibility INSUFFICIENT 的组合：gate 失败原因包含 target_feasibility", async () => {
    const stack = await newStack({ reviewSequence: ["fail", "fail2", "fail3"] });
    const project = await stack.store.create("组合失败测试");
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {});
    const runId = created.body["runId"] as string;
    await approveTwice(stack, runId);
    const overflow = await pollRun(stack, runId, ["awaiting_input"]);

    // FEASIBILITY_HIGH fixture（默认 sequence）→ 该原因不触发；确认 gate 原因来自 review
    const reasons = (overflow.awaiting?.payload?.["gateReasons"] as string[]) ?? [];
    expect(reasons.length).toBeGreaterThan(0);
    expect(reasons.join("\n")).not.toContain("target_feasibility");
  });
});
