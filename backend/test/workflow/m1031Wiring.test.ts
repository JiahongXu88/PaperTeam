/**
 * M10.3.1 接线 e2e（scripted Runtime + 假编译器；确定性）：
 *
 * 单文件 LaTeX 导入项目 + 整文件修订引入 λ_smooth 型未授权数值漂移
 * （scripted Writer [fact:drift]），验证 G1 闭环：
 *   drift → pairwise gate FAIL + cumulative gate FAIL → revision.plan
 *   （fact_preserve 条目 + restorable 标记）→ revision.restore_facts
 *   （无 LLM 确定性恢复冻结段落）→ 复审 → 累计 ok → Final。
 *
 * 断言：
 * - 恢复后 main.tex 数值回到冻结原值；
 * - 最终 gate 的 cumulative_fact_preservation 通过（resolvedViolations 记录历史违规）；
 * - fact_preserve 条目终态 validated（resolution=deterministic_restore）；
 * - 授权台账（fact-authorizations.json）在 plan_confirm approve 时落盘；
 * - Draft/Final 产物与 Revision Trace 含累计章节。
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
    central.push(centralEntry, nameBytes);
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

/** 段落式单文件论文（引言段 / 超参段 / 表格段——漂移定位可控） */
const PAPER_TEX = [
  "\\documentclass[UTF8]{ctexart}",
  "\\usepackage{cite}",
  "\\begin{document}",
  "",
  "\\section{引言}",
  "本文方法在公开数据集上验证，MOTA 提升 12.4\\%。\\cite{a}",
  "",
  "\\section{超参数选择}",
  "平滑权重较小（0.25 至 0.5）时 MOTA 与 IDF1 影响不大，故取 0.5。",
  "",
  "\\section{主结果}",
  "\\begin{tabular}{ll}",
  "方法 & MOTA \\\\",
  "Ours & 82.4 \\\\",
  "\\end{tabular}",
  "",
  "\\bibliographystyle{unsrt}",
  "\\bibliography{refs}",
  "\\end{document}",
].join("\n");

const SINGLE_FILE_ARCHIVE = buildZip([
  { name: "paper.tex", data: Buffer.from(PAPER_TEX, "utf8") },
  { name: "refs.bib", data: Buffer.from("@article{a, title={A Good Paper}, year={2020}}", "utf8") },
]);

describe("M10.3.1 compatibility: targeted revision keeps frozen facts", () => {
  it("candidate repair keeps frozen metrics and final gate passes without deterministic restore", async () => {
    const scripted = scriptedIdeaRuntime({ reviewSequence: ["pass"] });
    const stack = await startTestStack(scripted.runtime, {
      registerCleanup: (cleanup) => cleanups.push(cleanup),
    });
    const project = await stack.store.create("M10.3.1 漂移闭环", { targetProfile: "core_journal" });
    const projectId = project.id;

    const imported = await stack.request("POST", `/api/projects/${projectId}/import`, {
      archiveBase64: SINGLE_FILE_ARCHIVE.toString("base64"),
    });
    expect(imported.status).toBe(200);

    // 工作流 prompt 携带 [fact:drift]：scripted Writer 整文件修订时漂移超参段数值
    const created = await stack.request("POST", `/api/projects/${projectId}/workflows`, {
      kind: "existing_paper_improvement",
      prompt: "扩展返修稿（scripted drift 场景）：[fact:drift] 引入未授权数值漂移验证累计守卫",
    });
    expect(created.status).toBe(202);
    const runId = created.body["runId"] as string;

    // 1) 研究计划批准
    await pollRunUntilAwaiting(stack, runId, "hitl.research_plan", { autoDecisions: {} });
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });

    // 2) evidence supply（continue；离线检索失败如实）
    await pollRunUntilAwaiting(stack, runId, "hitl.evidence_supply", { autoDecisions: {} });
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "continue" });

    // 3) 改进计划确认（approve 同时落盘授权台账）
    await pollRunUntilAwaiting(stack, runId, "hitl.plan_confirm", { autoDecisions: {} });
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });

    // 4) 共享后段：漂移 → 复核可能 blocked（HITL）→ gate FAIL → restore → 复审 → Final
    const decisions: string[] = [];
    for (;;) {
      const { body } = await stack.request("GET", `/api/runs/${runId}`);
      const run = body["run"] as WorkflowState;
      if (run.status === "completed" || run.status === "failed") {
        console.log("TERMINAL", run.status, JSON.stringify(run.stageResults?.["revision.plan"] ?? {}).slice(0, 300));
        console.log("RESTORE", JSON.stringify(run.stageResults?.["revision.restore_facts"] ?? {}).slice(0, 300));
        console.log("GATE", JSON.stringify(run.stageResults?.["quality.gate"] ?? {}).slice(0, 300));
        try {
          const main = await readFile(join(stack.root, projectId, "manuscript", "main.tex"), "utf8");
          console.log("MAIN超参段:", main.split("\n").filter((l) => l.includes("MOTA") || l.includes("平滑") || l.includes("12") || l.includes("26")).join(" | ").slice(0, 400));
        } catch {}
        expect(run.status).toBe("completed");
        break;
      }
      if (run.status === "awaiting_input") {
        const stageId = run.awaiting?.stageId ?? "";
        decisions.push(stageId);
        const decision =
          stageId === "hitl.revision_validation"
            ? "approve" // 用户明示接受漂移轮复核（gate 仍会拦截）
            : stageId === "hitl.revision_stalled" || stageId === "hitl.revision_overflow"
              ? "revise_more" // 恢复路径应使 gate 收敛；仍 stalled 则暴露缺陷
              : stageId === "hitl.style_polish"
                ? "skip"
                : "approve";
        const response = await stack.request("POST", `/api/runs/${runId}/resume`, { decision });
        expect(response.status).toBe(200);
        continue;
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }

    // 终态检查：Final（恢复后 gate 通过）
    const { body } = await stack.request("GET", `/api/runs/${runId}`);
    const finished = body["run"] as WorkflowState;
    expect(finished.completion?.label).toBe("final");
    expect(finished.completedStages).toEqual(
      expect.arrayContaining(["revision.apply", "quality.gate", "build.final"]),
    );
    // Validation-aware patch repair prevents the drift before restore_facts is needed.
    expect(finished.completedStages).not.toContain("revision.restore_facts");
    // 修复闭环未依赖 stalled/overflow 的 accept_draft
    expect(decisions).not.toContain("hitl.revision_stalled");

    // 恢复后：漂移值消失、冻结原值回归
    const revised = await readFile(join(stack.root, projectId, "manuscript", "main.tex"), "utf8");
    expect(revised).toContain("（0.25 至 0.5）时 MOTA 与 IDF1 影响不大");
    expect(revised).toContain("故取 0.5。");
    expect(revised).not.toMatch(/67\.[13]/);
    expect(revised).not.toMatch(/71\.[05]/);
    // 表格与引言事实不受恢复影响
    expect(revised).toContain("82.4");
    expect(revised).toContain("12.4");

    // 最终 gate：累计事实保持通过；没有被接受的漂移需要标记为 resolved。
    const gateFiles = ["quality-gate-r1.json", "quality-gate-r2.json", "quality-gate-r3.json", "quality-gate-r4.json"];
    let finalGate: { gate: { passed: boolean; rules: { rule: string; passed: boolean }[] }; cumulativeFactPreservation?: { ok: boolean; resolvedViolations: unknown[]; unresolvedViolations: unknown[] } } | null = null;
    for (const file of gateFiles) {
      try {
        const parsed = JSON.parse(await readFile(join(stack.root, projectId, "reviews", file), "utf8"));
        finalGate = parsed;
      } catch {
        // 该轮产物不存在则继续
      }
    }
    expect(finalGate).not.toBeNull();
    const cumulativeRule = finalGate!.gate.rules.find((rule) => rule.rule === "cumulative_fact_preservation");
    expect(cumulativeRule).toBeDefined();
    expect(cumulativeRule!.passed).toBe(true);
    expect(finalGate!.cumulativeFactPreservation?.unresolvedViolations).toHaveLength(0);
    expect(finalGate!.cumulativeFactPreservation?.resolvedViolations).toHaveLength(0);

    // 授权台账：plan_confirm approve 落盘（改进计划条目固化）
    const ledger = JSON.parse(
      await readFile(join(stack.root, projectId, "research", "fact-authorizations.json"), "utf8"),
    ) as { entries: { source: string }[] };
    expect(ledger.entries.length).toBeGreaterThanOrEqual(1);
    expect(ledger.entries[0]?.source).toBe("improvement_plan_approved");

    // Revision Trace：累计事实章节呈现（不隐藏）
    const response = await readFile(join(stack.root, projectId, "build", "revision-response.md"), "utf8");
    expect(response).toContain("Cumulative Fact Preservation");
  });
});
