/**
 * M5.7 External Instructions workflow e2e（HTTP 全链路，scripted runtime）：
 * - API：POST 校验 / 幂等指纹 / GET / DELETE / sectionOptions
 * - 改进 run：外部意见 → revision.apply 派发（scripted Writer 输出 OUTCOMES 行）
 *   → 确定性状态回写（applied+真实变化 → handled）
 * - [conflict] 意见 → status=conflict + 依据保留（不篡改事实的报告路径）
 * - gate 失败轮：revision.plan 含 mandatory external 条目（handled → skipped 留档）
 * - Quick Review（existing_paper_review）只读：不派发、状态不变
 * - 无外部意见的 run 行为不变（stage result 无 externalInstructions 字段）
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { deflateRawSync } from "node:zlib";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { WorkflowState } from "../../src/workflow/types.js";
import { scriptedIdeaRuntime, startTestStack, type TestStack } from "../helpers/testStack.js";

vi.setConfig({ testTimeout: 30_000 });

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
  return Buffer.concat([...parts, ...central, end]);
}

const IMPORT_ARCHIVE = buildZip([
  { name: "main.tex", data: Buffer.from(IMPORTED_MAIN, "utf8") },
  { name: "sections/introduction.tex", data: Buffer.from("\\section{引言}\n准确率提升 12.4\\% \\cite{a}。", "utf8") },
  { name: "sections/experiments.tex", data: Buffer.from("\\section{实验}\n在两个数据集上验证。", "utf8") },
  { name: "references.bib", data: Buffer.from("@article{a, title={A Good Paper}, year={2020}}", "utf8") },
]);

async function newStack(
  reviewSequence: ("pass" | "fail")[] = ["pass"],
  options?: { maxRevisionRounds?: number },
): Promise<TestStack> {
  const scripted = scriptedIdeaRuntime({ reviewSequence });
  return startTestStack(scripted.runtime, {
    registerCleanup: (cleanup) => cleanups.push(cleanup),
    ...(options?.maxRevisionRounds !== undefined
      ? { review: { maxRevisionRounds: options.maxRevisionRounds } }
      : {}),
  });
}

async function pollRun(
  stack: TestStack,
  runId: string,
  statuses: string[],
  timeoutMs = 30_000,
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

/** 导入项目并跑完 improvement run（approve 计划确认），返回终态 */
async function runImprovement(
  stack: TestStack,
  projectId: string,
): Promise<WorkflowState> {
  const created = await stack.request("POST", `/api/projects/${projectId}/workflows`, {
    kind: "existing_paper_improvement",
  });
  expect(created.status).toBe(202);
  const runId = created.body["runId"] as string;
  const awaiting = await pollRun(stack, runId, ["awaiting_input"]);
  expect(awaiting.awaiting?.stageId).toBe("hitl.plan_confirm");
  await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
  return pollRun(stack, runId, ["completed", "failed"]);
}

async function importProject(stack: TestStack, title: string): Promise<string> {
  const project = await stack.store.create(title, { targetProfile: "core_journal" });
  const imported = await stack.request("POST", `/api/projects/${project.id}/import`, {
    archiveBase64: IMPORT_ARCHIVE.toString("base64"),
  });
  expect(imported.status).toBe(200);
  return project.id;
}

interface InstructionView {
  instructionId: string;
  source: string;
  status: string;
  text: string;
  conflictBasis?: string;
  statusNote?: string;
}

async function listInstructions(stack: TestStack, projectId: string): Promise<InstructionView[]> {
  const { body } = await stack.request("GET", `/api/projects/${projectId}/external-instructions`);
  return body["instructions"] as InstructionView[];
}

describe("外部修改意见 API（M5.7）", () => {
  it("POST 校验：非法 source / 空 text 超长 → 400；幂等指纹重复 → 400；GET 带章节候选；DELETE", async () => {
    const stack = await newStack();
    const projectId = await importProject(stack, "API 校验项目");
    expect(
      (await stack.request("POST", `/api/projects/${projectId}/external-instructions`, {
        source: "anonymous",
        text: "x",
      })).status,
    ).toBe(400);
    expect(
      (await stack.request("POST", `/api/projects/${projectId}/external-instructions`, {
        source: "user",
        text: "   ",
      })).status,
    ).toBe(400);
    expect(
      (await stack.request("POST", `/api/projects/${projectId}/external-instructions`, {
        source: "user",
        text: "x".repeat(8001),
      })).status,
    ).toBe(400);

    const added = await stack.request("POST", `/api/projects/${projectId}/external-instructions`, {
      source: "journal_reviewer",
      reviewerLabel: "Reviewer 2",
      text: "请补充对比实验。",
    });
    expect(added.status).toBe(200);
    const instruction = added.body["instruction"] as InstructionView;
    expect(instruction.status).toBe("pending");

    // 同内容重复 → 400（幂等指纹）
    expect(
      (
        await stack.request("POST", `/api/projects/${projectId}/external-instructions`, {
          source: "journal_reviewer",
          reviewerLabel: "Reviewer 2",
          text: "请补充对比实验。",
        })
      ).status,
    ).toBe(400);

    const list = await stack.request("GET", `/api/projects/${projectId}/external-instructions`);
    expect((list.body["instructions"] as InstructionView[]).length).toBe(1);
    expect(list.body["sectionOptions"]).toEqual(
      expect.arrayContaining(["sections/introduction.tex", "sections/experiments.tex"]),
    );

    const removed = await stack.request(
      "DELETE",
      `/api/projects/${projectId}/external-instructions/${instruction.instructionId}`,
    );
    expect(removed.status).toBe(200);
    expect((removed.body["instructions"] as InstructionView[]).length).toBe(0);
    expect(
      (
        await stack.request("DELETE", `/api/projects/${projectId}/external-instructions/x-nope`)
      ).status,
    ).toBe(404);
  });
});

describe("外部修改意见 × improvement workflow（M5.7）", () => {
  it("pending 意见 → revision.apply 派发 → applied+真实变化 → handled；稿件被修订", async () => {
    const stack = await newStack(["pass"]);
    const projectId = await importProject(stack, "意见已处理项目");
    const added = await stack.request("POST", `/api/projects/${projectId}/external-instructions`, {
      source: "journal_reviewer",
      reviewerLabel: "Reviewer 2",
      text: "1. 请补充与 ByteTrack 的对比。\n2. 第 3.7 节需要弱化显著性表述。",
      section: "sections/experiments.tex",
    });
    expect(added.status).toBe(200);

    const finished = await runImprovement(stack, projectId);
    expect(finished.status).toBe("completed");
    const applyResult = finished.stageResults["revision.apply"] ?? {};
    expect(applyResult["externalInstructions"]).toBe(1);

    const instructions = await listInstructions(stack, projectId);
    expect(instructions.length).toBe(1);
    const instruction = instructions[0]!;
    expect(instruction.status).toBe("handled");
    // 稿件真实被修订（目标章节）
    const intro = await readFile(
      join(stack.root, projectId, "manuscript", "sections", "experiments.tex"),
      "utf8",
    );
    expect(intro).toContain("修订后");
    // 原文逐字保存
    const raw = JSON.parse(
      await readFile(join(stack.root, projectId, "reviews", "external-instructions.json"), "utf8"),
    ) as { instructions: InstructionView[] };
    expect(raw.instructions[0]!.text).toContain("ByteTrack");
  });

  it("[conflict] 意见 → status=conflict + 依据保留（不伪造优势表述的报告路径）", async () => {
    const stack = await newStack(["pass"]);
    const projectId = await importProject(stack, "意见冲突项目");
    const added = await stack.request("POST", `/api/projects/${projectId}/external-instructions`, {
      source: "journal_reviewer",
      reviewerLabel: "Reviewer 2",
      text: "请把实验部分关于低照度场景的优势说明得更明显。[conflict]",
      section: "sections/experiments.tex",
    });
    expect(added.status).toBe(200);

    const finished = await runImprovement(stack, projectId);
    expect(finished.status).toBe("completed");
    const instructions = await listInstructions(stack, projectId);
    expect(instructions.length).toBe(1);
    const instruction = instructions[0]!;
    expect(instruction.status).toBe("conflict");
    expect(instruction.conflictBasis).toContain("IDS = 24");
    expect(instruction.statusNote).toContain("未篡改事实");
  });

  it("gate 失败轮：revision.plan 含 mandatory external 条目（handled → skipped 留档，不重复派发）", async () => {
    const stack = await newStack(["fail", "fail", "pass"], { maxRevisionRounds: 4 });
    const projectId = await importProject(stack, "计划含外部意见项目");
    const added = await stack.request("POST", `/api/projects/${projectId}/external-instructions`, {
      source: "advisor",
      text: "建议在引言中更清楚地陈述贡献。",
      section: "sections/introduction.tex",
    });
    expect(added.status).toBe(200);

    const finished = await runImprovement(stack, projectId);
    expect(finished.status).toBe("completed");
    // apply 轮已处理 → 意见 handled；后续 gate 失败轮的确定性计划把它留档为 skipped
    const instructions = await listInstructions(stack, projectId);
    expect(instructions.length).toBe(1);
    const instruction = instructions[0]!;
    expect(instruction.status).toBe("handled");
    const planRaw = JSON.parse(
      await readFile(join(stack.root, projectId, "reviews", "revision-plan-r2.json"), "utf8"),
    ) as {
      summary: { external?: number };
      items: Array<{
        kind: string;
        priority: string;
        status: string;
        source?: string;
        sourceText?: string;
        instructionId?: string;
        note?: string;
      }>;
    };
    const externalItem = planRaw.items.find((item) => item.kind === "external_instruction");
    expect(externalItem).toMatchObject({
      priority: "mandatory",
      status: "skipped",
      source: "external",
    });
    expect(externalItem!.sourceText).toContain("陈述贡献");
    expect(planRaw.summary.external).toBe(1);
  });

  it("Quick Review（existing_paper_review）只读：不派发外部意见、状态保持 pending、Writer 不被调用", async () => {
    // Quick Review 走 Final PDF 解析链路：fake parser + scripted runtime（分节审稿）
    const scripted = scriptedIdeaRuntime();
    const fakeParser = {
      id: "fake",
      async checkAvailability() {
        return { available: true as const, command: "fake", args: [], pythonVersion: "0", pymupdfVersion: "0" };
      },
      async parseFile() {
        return {
          ok: true,
          parser: { id: "fake", version: "1" },
          pageCount: 2,
          title: "Readonly Paper",
          abstract: "Abstract.",
          toc: [[1, "Introduction", 1], [1, "References", 2]] as Array<[number, string, number]>,
          blocks: [
            { page: 1, text: "Intro content. " + "x".repeat(700) },
            { page: 2, text: "[1] Someone et al. A Referenced Paper. 2026." },
          ],
          totalChars: 900,
          notes: [],
        };
      },
    } as import("../../src/paper/PdfParser.js").PdfParser;
    const stack = await startTestStack(scripted.runtime, {
      paperParser: fakeParser,
      registerCleanup: (cleanup) => cleanups.push(cleanup),
    });
    const created = await stack.request("POST", "/api/projects/import-pdf", {
      fileName: "readonly.pdf",
      contentBase64: Buffer.from("%PDF-1.5\nreadonly").toString("base64"),
      goal: "review_only",
    });
    expect(created.status).toBe(201);
    const projectId = (created.body["project"] as Record<string, unknown>)["id"] as string;

    const added = await stack.request("POST", `/api/projects/${projectId}/external-instructions`, {
      source: "user",
      text: "随便一条意见（Quick Review 不应派发）。",
    });
    expect(added.status).toBe(200);

    const started = await stack.request("POST", `/api/projects/${projectId}/workflows`, {
      kind: "existing_paper_review",
    });
    expect(started.status).toBe(202);
    const runId = started.body["runId"] as string;
    const finished = await pollRun(stack, runId, ["completed", "failed"]);
    expect(
      finished.status === "completed"
        ? "completed"
        : `${finished.status}: ${finished.error?.code} ${finished.error?.message} @ ${finished.error?.stageId}`,
    ).toBe("completed");
    expect(finished.completion?.label).toBe("review");

    const instructions = await listInstructions(stack, projectId);
    expect(instructions.length).toBe(1);
    expect(instructions[0]!.status).toBe("pending");
    // Quick Review 不含任何修订 stage；Writer（writing/* scope）从未被调用
    expect(finished.completedStages).not.toContain("revision.apply");
    expect(finished.completedStages).not.toContain("revision.revise");
    expect(scripted.calls.some((call) => call.contextScope?.startsWith("writing/"))).toBe(false);
  });

  it("无外部意见：improvement run 与既有行为一致（stage result 无 externalInstructions）", async () => {
    const stack = await newStack(["pass"]);
    const projectId = await importProject(stack, "无意见基线项目");
    const finished = await runImprovement(stack, projectId);
    expect(finished.status).toBe("completed");
    expect(finished.completion?.label).toBe("final");
    const applyResult = finished.stageResults["revision.apply"] ?? {};
    expect(applyResult["externalInstructions"]).toBeUndefined();
    expect((await listInstructions(stack, projectId)).length).toBe(0);
  });
});
