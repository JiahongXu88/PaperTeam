/**
 * M17.1（#13）：默认路径必检——不设置任何选项、不输入 Prompt：
 *   - 「修改已有论文」（existing_paper_improvement）：导入 → review.run 默认风格审查 → Gate（建议性覆盖规则）
 *     → revision.style_audit_apply 受控定点修订（锚定原句删除样板自谦，必要限定 / 引用 / 数值不变）→ 复审 → Final；
 *   - 「创建新论文」（idea_to_paper）：review.run 同样默认触发风格审查并落盘覆盖账本。
 * scripted runtime：单元原文含「粗浅的尝试」样板句时报一条可删除的自谦；语义复核恒 EQUIVALENT（人工构造夹具）。
 */

import { readFile, readdir } from "node:fs/promises";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { WorkflowState } from "../../src/workflow/types.js";
import type { StyleAuditReport, StyleRevisionRecord } from "../../src/review/academicStyleAudit.js";
import { scriptedIdeaRuntime, startTestStack, pollRunUntilAwaiting, type TestStack } from "../helpers/testStack.js";

vi.setConfig({ testTimeout: 30_000 });

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
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
    local.writeUInt16LE(8, 8);
    local.writeUInt32LE(compressed.length, 18);
    local.writeUInt32LE(entry.data.length, 22);
    local.writeUInt16LE(nameBytes.length, 26);
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
  return Buffer.concat([...parts, centralBuf, end]);
}

const APOLOGY = "本文仅是一次粗浅的尝试，敬请批评指正。";
const LIMIT = "由于未在夜间场景数据上验证，结论能否推广到低照度条件尚不确定。";
// 讨论节不在 scripted 改进计划的修改范围内（计划只改 experiments / introduction）——风格审查到的句子留到质量回路收敛后
const DISCUSSION = `\\section{讨论}\n在两个数据集上验证，MOTA 为 71.3 \\cite{a}。${APOLOGY}${LIMIT}`;

const ARCHIVE = buildZip([
  { name: "main.tex", data: Buffer.from(["\\documentclass[UTF8]{ctexart}", "\\begin{document}", "\\input{sections/introduction}", "\\input{sections/experiments}", "\\input{sections/discussion}", "\\bibliographystyle{unsrt}", "\\bibliography{references}", "\\end{document}"].join("\n"), "utf8") },
  { name: "sections/introduction.tex", data: Buffer.from("\\section{引言}\n准确率提升 12.4% \\cite{a}。", "utf8") },
  { name: "sections/experiments.tex", data: Buffer.from("\\section{实验}\n在两个数据集上验证。", "utf8") },
  { name: "sections/discussion.tex", data: Buffer.from(DISCUSSION, "utf8") },
  { name: "references.bib", data: Buffer.from("@article{a, title={A Good Paper}, year={2020}}", "utf8") },
]);

async function pollRun(stack: TestStack, runId: string, statuses: string[], timeoutMs = 30_000): Promise<WorkflowState> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const run = (await stack.request("GET", `/api/runs/${runId}`)).body["run"] as WorkflowState;
    if (statuses.includes(run.status)) return run;
    if (run.status === "failed") throw new Error(`run 失败：${run.error?.code} ${run.error?.message}（${run.error?.stageId ?? "?"}）`);
    if (Date.now() > deadline) throw new Error(`等待 ${statuses.join("|")} 超时（${run.status} / ${run.currentStage}）`);
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

async function readJson<T>(path: string): Promise<T> {
  return JSON.parse(await readFile(path, "utf8")) as T;
}

describe("M17.1 默认风格审查：正常产品入口无需任何设置", () => {
  it("修改已有论文：默认审查 → 受控定点删除样板自谦 → 复审覆盖完整 → Final；必要限定 / 引用 / 数值逐字保留", async () => {
    const scripted = scriptedIdeaRuntime({ reviewSequence: ["pass"] });
    const stack = await startTestStack(scripted.runtime, { registerCleanup: (cleanup) => cleanups.push(cleanup) });
    const project = await stack.store.create("风格默认必检");
    expect((await stack.request("POST", `/api/projects/${project.id}/import`, { archiveBase64: ARCHIVE.toString("base64") })).status).toBe(200);
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, { kind: "existing_paper_improvement" });
    const runId = created.body["runId"] as string;
    await pollRunUntilAwaiting(stack, runId, "hitl.plan_confirm");
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
    const finished = await pollRun(stack, runId, ["completed"]);
    expect(finished.completion?.label).toBe("final");

    // 风格修订阶段默认执行，且恰好一次
    const applies = finished.stageHistory.filter((record) => record.stageId === "revision.style_audit_apply" && record.status === "completed");
    expect(applies).toHaveLength(1);
    expect(finished.stageResults["revision.style_audit_apply"]).toMatchObject({ status: "applied", changed: true, applied: 1 });

    const reviewsDir = join(stack.root, project.id, "reviews");
    const names = await readdir(reviewsDir);
    const auditRounds = names.map((name) => /^style-audit-r(\d+)\.json$/.exec(name)?.[1]).filter((round): round is string => round !== undefined).map(Number).sort((a, b) => a - b);
    expect(auditRounds.length).toBeGreaterThanOrEqual(2);
    const firstWithFinding = (await Promise.all(auditRounds.map((round) => readJson<StyleAuditReport>(join(reviewsDir, `style-audit-r${round}.json`))))).find((report) => report.findings.length > 0)!;
    expect(firstWithFinding.coverage.state).toBe("COMPLETE");
    expect(firstWithFinding.findings[0]).toMatchObject({ styleCategory: "repeated_modesty_apology", disposition: "AUTO_REWRITE_ELIGIBLE", file: "sections/discussion.tex" });

    // 修订作用于质量回路收敛后的最新一轮审查（该轮复用了未改动单元的风格发现）
    const revisionFiles = names.filter((name) => /^style-revision-r\d+\.json$/.test(name));
    expect(revisionFiles).toHaveLength(1);
    const revision = await readJson<StyleRevisionRecord>(join(reviewsDir, revisionFiles[0]!));
    expect(revision.items[0]).toMatchObject({ status: "AUTO_FIXED", before: APOLOGY, after: "" });

    const experiments = await readFile(join(stack.root, project.id, "manuscript", "sections", "discussion.tex"), "utf8");
    expect(experiments).not.toContain("粗浅的尝试");
    expect(experiments).toContain(LIMIT);
    expect(experiments).toContain("71.3");
    expect(experiments).toContain("\\cite{a}");

    // 复审：最终轮风格审查覆盖完整、原 finding 已关闭（确定性：原句不在）
    const last = await readJson<StyleAuditReport>(join(reviewsDir, `style-audit-r${auditRounds[auditRounds.length - 1]}.json`));
    expect(last.coverage.state).toBe("COMPLETE");
    expect(last.findings.filter((finding) => finding.originalQuote.includes("粗浅"))).toHaveLength(0);
    expect(last.previousRevisionClosure?.items[0]).toMatchObject({ status: "CLOSED", reflagged: false });

    // Gate：建议性覆盖规则存在（INFO），风格不进入科学硬门
    const gate = (await stack.request("GET", `/api/projects/${project.id}/quality-gate`)).body as { gate?: { rules?: Array<{ rule: string; status?: string; required?: boolean }> } };
    expect(gate.gate?.rules?.find((rule) => rule.rule === "academic_style_audit_reported")).toMatchObject({ status: "INFO", required: false });

    // 用户可见 API：风格报告 + 修订对比
    const view = await stack.request("GET", `/api/projects/${project.id}/style-audit`);
    expect(view.status).toBe(200);
    expect(view.body).toMatchObject({ report: { coverage: { state: "COMPLETE" } }, revision: { status: "applied" } });
  });

  it("创建新论文：review.run 默认触发风格审查并落盘覆盖账本（无需显式设置）", async () => {
    const scripted = scriptedIdeaRuntime({ reviewSequence: ["pass"] });
    const stack = await startTestStack(scripted.runtime, { registerCleanup: (cleanup) => cleanups.push(cleanup) });
    const project = await stack.store.create("新论文风格必检");
    const runId = (await stack.request("POST", `/api/projects/${project.id}/workflows`, {})).body["runId"] as string;
    for (let index = 0; index < 2; index += 1) {
      await pollRun(stack, runId, ["awaiting_input"]);
      await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
    }
    const finished = await pollRun(stack, runId, ["completed", "awaiting_input"]);
    expect(finished.completedStages).toContain("review.run");
    const review = finished.stageResults["review.run"] ?? {};
    expect(typeof review["styleAuditState"]).toBe("string");
    expect(review["styleAuditState"]).not.toBe("DISABLED");
    const report = await readJson<StyleAuditReport>(join(stack.root, project.id, "reviews", "style-audit-r1.json"));
    expect(report.units.length).toBeGreaterThan(0);
    expect(report.units.every((unit) => ["COMPLETE", "NOT_APPLICABLE"].includes(unit.status))).toBe(true);
  });
});
