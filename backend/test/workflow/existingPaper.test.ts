/**
 * Existing-Paper Improvement workflow e2e（M3.2）：
 * 导入 → 解析 → 基线编译 → 论文理解 → 引用审计 → 审稿 → 目标评估
 * → 改进计划 → HITL → 逐节改造 →（共享后段）→ Final / Draft。
 * 同时覆盖 M3.2 HTTP 路由：review / quality-gate / build / import。
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { WorkflowState } from "../../src/workflow/types.js";
import { scriptedIdeaRuntime, startTestStack, type TestStack } from "../helpers/testStack.js";

// 全流程 e2e 超过默认 5s
vi.setConfig({ testTimeout: 20_000 });

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
});

const IMPORTED_MAIN = [
  "\\documentclass[UTF8]{ctexart}",
  "\\begin{document}",
  "\\input{sections/introduction}",
  "\\input{sections/experiments}",
  "\\bibliographystyle{unsrt}",
  "\\bibliography{references}",
  "\\end{document}",
].join("\n");

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
  return Buffer.concat([...parts, centralBuf, end]);
}

const IMPORT_ARCHIVE = buildZip([
  { name: "main.tex", data: Buffer.from(IMPORTED_MAIN, "utf8") },
  { name: "sections/introduction.tex", data: Buffer.from("\\section{引言}\n准确率提升 12.4% \\cite{a}。", "utf8") },
  { name: "sections/experiments.tex", data: Buffer.from("\\section{实验}\n在两个数据集上验证。", "utf8") },
  { name: "references.bib", data: Buffer.from("@article{a, title={A Good Paper}, year={2020}}", "utf8") },
]);

async function newStack(reviewSequence: ("pass" | "fail")[] = ["pass"]): Promise<TestStack> {
  const scripted = scriptedIdeaRuntime({ reviewSequence });
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
    if (run.status === "failed" && !statuses.includes("failed")) {
      throw new Error(
        `run 意外失败：${run.error?.code} ${run.error?.message}（stage ${run.error?.stageId ?? "?"}）`,
      );
    }
    if (Date.now() > deadline) {
      throw new Error(`等待 ${statuses.join("|")} 超时（当前 ${run.status}，stage ${run.currentStage}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
}

describe("existing_paper_improvement workflow（HTTP e2e）", () => {
  it("导入 → 全流程 → Final：产物齐全、计划与改造生效", async () => {
    const stack = await newStack(["pass"]);
    const project = await stack.store.create("已有论文改造", { targetProfile: "core_journal" });

    // 导入（HTTP）
    const imported = await stack.request("POST", `/api/projects/${project.id}/import`, {
      archiveBase64: IMPORT_ARCHIVE.toString("base64"),
    });
    expect(imported.status).toBe(200);
    const report = imported.body["report"] as { structure: { entryFile: string }; baselineCompile: { ok: boolean } };
    expect(report.structure.entryFile).toBe("main.tex");
    expect(report.baselineCompile.ok).toBe(true);

    // 创建 workflow
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {
      kind: "existing_paper_improvement",
    });
    expect(created.status).toBe(202);
    const runId = created.body["runId"] as string;

    // 前段推进到改进计划确认
    const planConfirm = await pollRun(stack, runId, ["awaiting_input"]);
    expect(planConfirm.awaiting?.stageId).toBe("hitl.plan_confirm");
    const payload = planConfirm.awaiting?.payload as { items?: { section: string }[] } | undefined;
    expect((payload?.items ?? []).length).toBeGreaterThan(0);

    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
    const finished = await pollRun(stack, runId, ["completed"]);

    expect(finished.status).toBe("completed");
    expect(finished.completion?.label).toBe("final");
    // 前段 + 共享后段全部完成
    expect(finished.completedStages).toEqual(
      expect.arrayContaining([
        "import.parse",
        "import.baseline_build",
        "import.understand",
        "citation.verify",
        "review.run",
        "assessment.target",
        "plan.improvement",
        "hitl.plan_confirm",
        "revision.apply",
        "quality.gate",
        "build.draft",
      ]),
    );

    // 改造真实发生：计划针对的章节被改写
    const intro = await readFile(
      join(stack.root, project.id, "manuscript", "sections", "introduction.tex"),
      "utf8",
    );
    expect(intro).toContain("修订后");
    // 论文理解与可行性产物
    const research = JSON.parse(
      await readFile(join(stack.root, project.id, "research", "research.json"), "utf8"),
    ) as { kind?: string };
    expect(research.kind).toBe("existing_paper_analysis");
    const gate = JSON.parse(
      await readFile(join(stack.root, project.id, "reviews", "quality-gate-r2.json"), "utf8"),
    ) as { gate?: { passed?: boolean } };
    expect(gate.gate?.passed).toBe(true);
    const pdf = await readFile(join(stack.root, project.id, "build", "paper.pdf"), "utf8");
    expect(pdf).toContain("%PDF-1.5");
  });

  it("未导入直接启动 → run 失败并给出明确指引（fail fast）", async () => {
    const stack = await newStack();
    const project = await stack.store.create("未导入项目");
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {
      kind: "existing_paper_improvement",
    });
    const runId = created.body["runId"] as string;
    const failed = await pollRun(stack, runId, ["failed"]);
    expect(failed.error?.code).toBe("IMPORT_VALIDATION");
    expect(failed.error?.message).toContain("import");
  });

  it("改进计划 revise：带反馈重新规划（bounded）", async () => {
    const stack = await newStack();
    const project = await stack.store.create("计划修订测试");
    await stack.request("POST", `/api/projects/${project.id}/import`, {
      archiveBase64: IMPORT_ARCHIVE.toString("base64"),
    });
    const created = await stack.request("POST", `/api/projects/${project.id}/workflows`, {
      kind: "existing_paper_improvement",
    });
    const runId = created.body["runId"] as string;
    await pollRun(stack, runId, ["awaiting_input"]);

    const missing = await stack.request("POST", `/api/runs/${runId}/resume`, {
      decision: "revise",
      payload: {},
    });
    expect(missing.status).toBe(409);

    await stack.request("POST", `/api/runs/${runId}/resume`, {
      decision: "revise",
      payload: { feedback: "优先补显著性检验" },
    });
    await pollRun(stack, runId, ["awaiting_input"]);
    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
    const finished = await pollRun(stack, runId, ["completed"]);
    const plans = finished.stageHistory.filter(
      (record) => record.stageId === "plan.improvement" && record.status === "completed",
    );
    expect(plans).toHaveLength(2);
  });
});

describe("M3.2 独立 HTTP 路由", () => {
  it("POST /review：三路审稿 + 聚合落盘；GET /reviews 列表", async () => {
    const stack = await newStack();
    const project = await stack.store.create("独立审稿测试");
    await stack.request("POST", `/api/projects/${project.id}/import`, {
      archiveBase64: IMPORT_ARCHIVE.toString("base64"),
    });

    const review = await stack.request("POST", `/api/projects/${project.id}/review`, {});
    expect(review.status).toBe(200);
    const summary = review.body["summary"] as {
      counts: { critical: number };
      scores: { academicScore: number; styleRisk: number };
    };
    expect(summary.scores.academicScore).toBeGreaterThanOrEqual(80);

    const list = await stack.request("GET", `/api/projects/${project.id}/reviews`);
    expect((list.body["reviews"] as unknown[]).length).toBeGreaterThanOrEqual(1);
  });

  it("POST /quality-gate：未 review 时 400；有 review 时返回判定", async () => {
    const stack = await newStack();
    const project = await stack.store.create("Gate API 测试");
    await stack.request("POST", `/api/projects/${project.id}/import`, {
      archiveBase64: IMPORT_ARCHIVE.toString("base64"),
    });

    const missing = await stack.request("POST", `/api/projects/${project.id}/quality-gate`, {});
    expect(missing.status).toBe(400);

    await stack.request("POST", `/api/projects/${project.id}/review`, {});
    const gate = await stack.request("POST", `/api/projects/${project.id}/quality-gate`, {});
    expect(gate.status).toBe(200);
    const result = gate.body["gate"] as { passed: boolean; rules: { rule: string; passed: boolean }[] };
    expect(result.rules.length).toBeGreaterThanOrEqual(8);
    expect(result.passed).toBe(true);
  });

  it("POST /build：Build Gate + Draft PDF（Quality 语义无关）", async () => {
    const stack = await newStack();
    const project = await stack.store.create("Build API 测试");
    await stack.request("POST", `/api/projects/${project.id}/import`, {
      archiveBase64: IMPORT_ARCHIVE.toString("base64"),
    });
    const build = await stack.request("POST", `/api/projects/${project.id}/build`, {});
    expect(build.status).toBe(200);
    const body = build.body as {
      build: { passed: boolean };
      compile: { ok: boolean; pdfPath?: string };
    };
    expect(body.build.passed).toBe(true);
    expect(body.compile.pdfPath).toBe("build/paper.pdf");
  });

  it("GET /import：读取最近导入报告", async () => {
    const stack = await newStack();
    const project = await stack.store.create("Import 报告测试");
    const empty = await stack.request("GET", `/api/projects/${project.id}/import`);
    expect(empty.status).toBe(200);
    expect(empty.body["report"]).toBeNull();

    await stack.request("POST", `/api/projects/${project.id}/import`, {
      archiveBase64: IMPORT_ARCHIVE.toString("base64"),
    });
    const report = await stack.request("GET", `/api/projects/${project.id}/import`);
    expect((report.body["report"] as { entryCount: number }).entryCount).toBe(4);
  });

  it("非法归档（路径穿越）→ 422 IMPORT_VALIDATION", async () => {
    const stack = await newStack();
    const project = await stack.store.create("非法导入测试");
    const evil = buildZip([
      { name: "main.tex", data: Buffer.from(IMPORTED_MAIN, "utf8") },
      { name: "../evil.tex", data: Buffer.from("evil", "utf8") },
    ]);
    const response = await stack.request("POST", `/api/projects/${project.id}/import`, {
      archiveBase64: evil.toString("base64"),
    });
    expect(response.status).toBe(422);
    expect((response.body["error"] as { code?: string }).code).toBe("IMPORT_VALIDATION");
  });
});
