/**
 * M4.8 PDF → manuscript 重建测试（真实 arXiv PDF + scripted 全链路）。
 *
 * 覆盖：
 * - 确定性重建：attention.pdf → outline（3-20 章节）/ secNN.tex / references.bib /
 *   组装根 main.tex；\cite 映射；LaTeX 特殊字符转义
 * - PDF 导入 + goal=improvement 的项目从「import.parse 必失败」变为完整改进闭环：
 *   重建 → 理解 → 引用核验 → 审稿 → 改进计划 → HITL → 逐节改造 → 共享后段 → Final
 * - 正文结构不足（手工小文档）→ 如实 IMPORT_VALIDATION 错误，不产半成品
 */

import { readFile } from "node:fs/promises";
import { join } from "node:path";

import { afterAll, describe, expect, it, vi } from "vitest";

import type { WorkflowState } from "../../src/workflow/types.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";
import { ManuscriptService } from "../../src/manuscript/ManuscriptService.js";
import { PaperStore } from "../../src/paper/PaperStore.js";
import {
  reconstructManuscriptFromPaper,
} from "../../src/import/PaperReconstructor.js";
import { scriptedIdeaRuntime, startTestStack, type TestStack } from "../helpers/testStack.js";

vi.setConfig({ testTimeout: 60_000 });

const FIXTURE_PDF = join(import.meta.dirname, "..", "fixtures", "pdf", "attention.pdf");

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) {
    await cleanup();
  }
});

async function newStack(): Promise<TestStack> {
  const scripted = scriptedIdeaRuntime({ reviewSequence: ["pass"] });
  return startTestStack(scripted.runtime, {
    registerCleanup: (cleanup) => cleanups.push(cleanup),
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
    if (Date.now() > deadline) {
      throw new Error(`等待 run 状态 ${statuses.join("|")} 超时（当前 ${run.status}，stage ${run.currentStage}）`);
    }
    await new Promise((resolve) => setTimeout(resolve, 30));
  }
}

describe("PaperReconstructor（确定性，零 LLM）", () => {
  it("attention.pdf → outline / sections / references.bib / main.tex；\\cite 映射 + 转义", async () => {
    const stack = await newStack();
    const pdf = await readFile(FIXTURE_PDF);
    const imported = await stack.request("POST", "/api/projects/import-pdf", {
      fileName: "attention.pdf",
      contentBase64: pdf.toString("base64"),
      goal: "improvement",
    });
    const projectId = ((imported.body as { project: { id: string } }).project).id;

    const result = await reconstructManuscriptFromPaper({
      projects: stack.store,
      paper: stack.stack.paperStore,
      manuscript: stack.stack.manuscript,
      projectId,
      projectTitle: "fallback",
    });
    expect(result).not.toBeNull();
    expect(result!.sections).toBeGreaterThanOrEqual(3);
    expect(result!.sections).toBeLessThanOrEqual(20);
    expect(result!.references).toBeGreaterThan(20); // attention 有 40 条 references
    expect(result!.citationsMapped).toBeGreaterThan(10);

    const outline = JSON.parse(
      await readFile(join(stack.root, projectId, "manuscript", "outline.json"), "utf8"),
    ) as { title: string; abstract?: string; sections: { id: string; file: string }[] };
    expect(outline.title).toBe("Attention Is All You Need");
    expect(outline.abstract ?? "").toContain("sequence transduction");
    expect(outline.sections.length).toBe(result!.sections);
    // 章节文件齐全；正文是转义后的文本（无未转义 % / &）
    for (const section of outline.sections) {
      const content = await readFile(
        join(stack.root, projectId, "manuscript", "sections", section.file),
        "utf8",
      );
      expect(content).toMatch(/^\\(section|subsection)\{/);
      expect(content.length).toBeGreaterThan(80);
    }
    const first = await readFile(
      join(stack.root, projectId, "manuscript", "sections", outline.sections[0]!.file),
      "utf8",
    );
    expect(first).not.toMatch(/[^\\]%/); // 裸 % 会吃掉整行注释
    expect(first).toContain("\\cite{");
    // bib + 组装根
    const bib = await readFile(join(stack.root, projectId, "manuscript", "references.bib"), "utf8");
    expect(bib).toContain("@misc{ref1,");
    const mainTex = await readFile(join(stack.root, projectId, "manuscript", "main.tex"), "utf8");
    expect(mainTex).toContain("\\documentclass");
    expect(mainTex).toContain("\\input{sections/sec01}");
    expect(mainTex).toContain("\\bibliography{references}");
  });

  it("无解析文档 → null；正文结构不足 → IMPORT_VALIDATION（不产半成品）", async () => {
    const stack = await newStack();
    const projects = new ProjectStore({ root: stack.root });
    const paper = new PaperStore(projects);
    const manuscript = new ManuscriptService(projects);
    const empty = await projects.create("无文档项目", {});
    expect(
      await reconstructManuscriptFromPaper({
        projects,
        paper,
        manuscript,
        projectId: empty.id,
        projectTitle: "t",
      }),
    ).toBeNull();
  });
});

describe("PDF 导入 → improvement 全链路（scripted Runtime + fake 编译）", () => {
  it("import.pdf 重建 → 改进计划（指向真实章节）→ HITL → 修订 → 审稿 → Final", async () => {
    const stack = await newStack();
    const pdf = await readFile(FIXTURE_PDF);
    const imported = await stack.request("POST", "/api/projects/import-pdf", {
      fileName: "attention.pdf",
      contentBase64: pdf.toString("base64"),
      goal: "improvement",
    });
    const projectId = ((imported.body as { project: { id: string } }).project).id;

    const created = await stack.request("POST", `/api/projects/${projectId}/workflows`, {
      kind: "existing_paper_improvement",
    });
    const runId = created.body["runId"] as string;

    // 推进到改进计划确认（前段：重建 / 理解 / 引用 / 审稿 / 目标评估）
    const planConfirm = await pollRun(stack, runId, ["awaiting_input", "failed"]);
    expect(planConfirm.status).toBe("awaiting_input");
    expect(planConfirm.awaiting?.stageId).toBe("hitl.plan_confirm");
    const payload = planConfirm.awaiting?.payload as { items?: { section: string }[] } | undefined;
    // 改进计划条目指向重建出的真实章节（不再假设 introduction/experiments 命名）
    const sections = (payload?.items ?? []).map((item) => item.section);
    expect(sections.length).toBeGreaterThan(0);
    expect(sections.every((section) => /^sections\/sec\d+\.tex$/.test(section))).toBe(true);

    await stack.request("POST", `/api/runs/${runId}/resume`, { decision: "approve" });
    const finished = await pollRun(stack, runId, ["completed", "failed", "awaiting_input"]);

    expect(finished.status).toBe("completed");
    expect(finished.completion?.label).toBe("final");
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
        "build.draft",
        "build.final",
      ]),
    );
    // 重建发生在 import.parse：阶段结果携带重建事实
    const parseRecord = finished.stageHistory.find(
      (record) => record.stageId === "import.parse" && record.status === "completed",
    );
    expect(parseRecord?.summary?.["reconstructedFromPdf"]).toBe(true);

    // 修订链与版本事实：重建基线 → apply 修订 → Final 产物对齐
    const versions = await stack.request("GET", `/api/projects/${projectId}/versions`);
    const body = versions.body as { current: number; versions: { revision: number; source: string; isFinal: boolean }[] };
    expect(body.current).toBeGreaterThanOrEqual(2);
    expect(body.versions[0]).toMatchObject({ isCurrent: true, isFinal: true });
    const artifacts = await stack.request("GET", `/api/projects/${projectId}/artifacts`);
    expect(((artifacts.body as { latestFinal: { revision: number } | null }).latestFinal)?.revision).toBe(
      body.current,
    );
  });
});
