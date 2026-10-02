/**
 * M10.4.4 Finding Dispatch E2E（scripted Runtime；确定性）：
 *
 * 单文件 LaTeX 导入项目 + heading 式 review finding（「方法/2.1 轨迹稳定性
 * 自适应损失」——不含路径、不含 "main" 字样），验证修复后真实工作流链路：
 *   review finding → 修订计划（planned）→ revision.revise 派发命中
 *   → Writer 收到该条目 → 条目 applied（修复前：sectionMatches 永不命中，
 *   条目永久滞留 planned，M10.4.4 分析文档 §1 真实回放形态）。
 *
 * 同时断言派发覆盖诊断（findingDispatch）进入 stage 结果。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";
import { afterAll, describe, expect, it, vi } from "vitest";

import type { WorkflowState } from "../../src/workflow/types.js";
import { scriptedIdeaRuntime, startTestStack, pollRunUntilAwaiting } from "../helpers/testStack.js";

vi.setConfig({ testTimeout: 120_000 });

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
});

function buildZip(entries: { name: string; data: Buffer }[]): Buffer {
  const parts: Buffer[] = [];
  const central: Buffer[] = [];
  let offset = 0;
  for (const entry of entries) {
    const nameBytes = Buffer.from(entry.name, "utf8");
    const compressed = deflateRawSync(entry.data);
    const local = Buffer.alloc(30);
    local.writeUInt32LE(0x04034b50, 0);
    local.writeUInt16LE(20, 4);
    local.writeUInt16LE(0, 6);
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
    local.writeUInt16LE(0, 28);
    parts.push(local, nameBytes, compressed);
    const centralEntry = Buffer.alloc(46);
    centralEntry.writeUInt32LE(0x02014b50, 0);
    centralEntry.writeUInt16LE(20, 4);
    centralEntry.writeUInt16LE(20, 6);
    centralEntry.writeUInt16LE(8, 10);
    centralEntry.writeUInt32LE(compressed.length, 20);
    centralEntry.writeUInt32LE(entry.data.length, 24);
    centralEntry.writeUInt16LE(nameBytes.length, 28);
    centralEntry.writeUInt32LE(offset, 42);
    central.push(centralEntry, nameBytes, compressed);
    offset += local.length + nameBytes.length + compressed.length;
  }
  const centralBuf = Buffer.concat(central);
  const end = Buffer.alloc(22);
  end.writeUInt32LE(0x06054b50, 0);
  end.writeUInt16LE(entries.length, 8);
  end.writeUInt16LE(entries.length, 10);
  end.writeUInt32LE(centralBuf.length, 12);
  end.writeUInt32LE(offset, 16);
  return Buffer.concat([...parts, ...central, end]);
}

/** 含真实 heading 结构的单文件论文（方法节 + subsection + 摘要环境） */
const PAPER_TEX = [
  "\\documentclass[UTF8]{ctexart}",
  "\\usepackage{cite}",
  "\\begin{document}",
  "\\begin{abstract}",
  "本文研究多目标跟踪。",
  "\\end{abstract}",
  "",
  "\\section{引言}",
  "多目标跟踪是核心问题。\\cite{a}",
  "",
  "\\section{方法}",
  "\\subsection{轨迹稳定性自适应损失}",
  "平滑权重取 0.5。",
  "",
  "\\section{结论}",
  "本文方法有效。",
  "",
  "\\bibliographystyle{unsrt}",
  "\\bibliography{refs}",
  "\\end{document}",
].join("\n");

const SINGLE_FILE_ARCHIVE = buildZip([
  { name: "paper.tex", data: Buffer.from(PAPER_TEX, "utf8") },
  { name: "refs.bib", data: Buffer.from("@article{a, title={A Good Paper}, year={2020}}", "utf8") },
]);

describe("M10.4.4 派发覆盖：heading 式 finding 真正进入 Revision", () => {
  it("「方法/2.1 轨迹稳定性自适应损失」finding → 派发 → applied（修复前永久滞留 planned）", async () => {
    // existing-paper 流程 Quality Gate 只对 r2+ 轮裁决 → issue 需在 gate 失败轮出现
    const scripted = scriptedIdeaRuntime({
      reviewSequence: ["fail", "fail"],
      everyRoundFactIssue: {
        category: "academic",
        severity: "major",
        section: "方法/2.1 轨迹稳定性自适应损失",
        description: "损失权重选择缺乏论证",
        suggestedAction: "补充权重选择依据",
        blocking: false,
      },
    });
    const stack = await startTestStack(scripted.runtime, {
      registerCleanup: (cleanup) => cleanups.push(cleanup),
    });
    const project = await stack.store.create("M10.4.4 派发覆盖", { targetProfile: "core_journal" });
    const projectId = project.id;

    const imported = await stack.request("POST", `/api/projects/${projectId}/import`, {
      archiveBase64: SINGLE_FILE_ARCHIVE.toString("base64"),
    });
    expect(imported.status).toBe(200);

    const created = await stack.request("POST", `/api/projects/${projectId}/workflows`, {
      kind: "existing_paper_improvement",
      prompt: "M10.4.4 派发覆盖（scripted）：heading 式 finding 派发验证",
    });
    expect(created.status).toBe(202);
    const runId = created.body["runId"] as string;

    await pollRunUntilAwaiting(stack, runId, "hitl.research_plan", { autoDecisions: {} });
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
    await pollRunUntilAwaiting(stack, runId, "hitl.evidence_supply", { autoDecisions: {} });
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "continue" });
    await pollRunUntilAwaiting(stack, runId, "hitl.plan_confirm", { autoDecisions: {} });
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });

    // 驱动至终态（revision HITL 一律快速收敛：approve / accept_draft）
    const findingDispatchResults: { total: number; matched: number; unmatched: number; multiTarget: number }[] = [];
    const planRounds: string[] = [];
    for (;;) {
      const { body } = await stack.request("GET", `/api/runs/${runId}`);
      const run = body["run"] as WorkflowState;
      const dispatch = (run.stageResults?.["revision.revise"] as Record<string, unknown> | undefined)?.[
        "findingDispatch"
      ] as { total: number; matched: number; unmatched: number; multiTarget: number } | undefined;
      if (dispatch !== undefined && findingDispatchResults.at(-1) !== dispatch) {
        findingDispatchResults.push(dispatch);
      }
      const planResult = run.stageResults?.["revision.plan"] as Record<string, unknown> | undefined;
      if (planResult !== undefined && planRounds.at(-1) !== JSON.stringify(planResult)) {
        planRounds.push(JSON.stringify(planResult));
      }
      if (run.status === "completed" || run.status === "failed") {
        break;
      }
      if (run.status === "awaiting_input") {
        const stageId = run.awaiting?.stageId ?? "";
        const decision =
          stageId === "hitl.revision_stalled" || stageId === "hitl.revision_overflow"
            ? "accept_draft"
            : stageId === "hitl.style_polish"
              ? "skip"
              : "approve";
        const response = await stack.request("POST", `/api/runs/${runId}/resume`, { decision });
        expect(response.status).toBe(200);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // 1) gate 失败轮的修订计划包含该 heading 条目，且被派发应用（状态离开 planned）
    const plan = JSON.parse(
      await readFile(join(stack.root, projectId, "reviews", "revision-plan-r2.json"), "utf8"),
    ) as { items: { id: string; section: string; status: string }[] };
    const headingItem = plan.items.find((item) => item.section === "方法/2.1 轨迹稳定性自适应损失");
    expect(headingItem).toBeDefined();
    expect(headingItem?.status).not.toBe("planned");
    expect(["applied", "validated", "rejected", "needs_review"]).toContain(headingItem?.status);

    // 2) 派发覆盖诊断进入 stage 结果：该轮 matched ≥ 1（修复前该 heading 条目
    //    不可命中，matched 只来自路径式条目 = 0——单文件项目 fail 包引用全是
    //    sections/*.tex 路径）
    expect(findingDispatchResults.length).toBeGreaterThan(0);
    const dispatched = findingDispatchResults.find((entry) => entry.matched > 0);
    expect(dispatched).toBeDefined();
    expect(dispatched?.matched).toBeGreaterThanOrEqual(1);
  });
});
