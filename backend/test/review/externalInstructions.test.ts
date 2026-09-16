/**
 * M5.7 External Instructions（外部修改意见）：
 * - 存储往返 / 幂等指纹 / 损坏容错
 * - applyDispatchOutcome 状态机（applied+真实变化 / 自称无实据 / conflict / unmatched）
 * - reverifyHandledInstructions（gate 复核自愈）
 * - buildRevisionPlan 的 external 条目（mandatory 最先、conflict skipped、原文保留）
 * - WriterService：外部意见 prompt 契约 + %%%PT-OUTCOMES%%% 解析
 */

import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import type { AgentRuntime, AgentTask } from "../../src/runtime/types.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";
import { WriterService } from "../../src/writer/WriterService.js";
import { buildRevisionPlan } from "../../src/review/revisionPlan.js";
import {
  applyDispatchOutcome,
  externalInstructionId,
  ExternalInstructionStore,
  reverifyHandledInstructions,
} from "../../src/review/externalInstructions.js";
import type {
  ExternalDispatchResult,
  ExternalInstruction,
  ExternalOutcomeReport,
} from "../../src/review/externalInstructions.js";
import type { ReviewSummary } from "../../src/review/ReviewAggregator.js";

const tempDirs: string[] = [];
afterAll(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })));
});

const NOW = "2026-09-16T12:00:00.000Z";

function instruction(overrides: Partial<ExternalInstruction> = {}): ExternalInstruction {
  const text = overrides.text ?? "请补充高密度场景的失效原因分析。";
  return {
    instructionId: overrides.instructionId ?? externalInstructionId("journal_reviewer", "Reviewer 2", text),
    source: overrides.source ?? "journal_reviewer",
    ...(overrides.reviewerLabel !== undefined ? { reviewerLabel: overrides.reviewerLabel } : {}),
    text,
    ...(overrides.section !== undefined ? { section: overrides.section } : {}),
    status: overrides.status ?? "pending",
    createdAt: overrides.createdAt ?? NOW,
    updatedAt: overrides.updatedAt ?? NOW,
    ...(overrides.statusNote !== undefined ? { statusNote: overrides.statusNote } : {}),
    ...(overrides.conflictBasis !== undefined ? { conflictBasis: overrides.conflictBasis } : {}),
  };
}

describe("ExternalInstructionStore", () => {
  async function makeStore() {
    const root = await mkdtemp(join(tmpdir(), "ext-store-"));
    tempDirs.push(root);
    return { root, store: new ExternalInstructionStore(new ProjectStore({ root })) };
  }

  it("add / load / remove 往返；同内容幂等（指纹 id 去重）", async () => {
    const { store } = await makeStore();
    const added = await store.add("p-1", {
      source: "journal_reviewer",
      text: "意见 A：补充对比实验。",
      reviewerLabel: "Reviewer 2",
      now: NOW,
    });
    expect(added).toMatchObject({ source: "journal_reviewer", status: "pending" });
    const duplicate = await store.add("p-1", {
      source: "journal_reviewer",
      text: "意见 A：补充对比实验。",
      reviewerLabel: "Reviewer 2",
      now: NOW,
    });
    expect(duplicate).toBeNull();
    expect((await store.load("p-1")).length).toBe(1);
    expect(await store.remove("p-1", added!.instructionId)).toEqual([]);
    expect(await store.remove("p-1", "x-nonexistent")).toBeNull();
  });

  it("损坏的 external-instructions.json → 空列表（不阻塞）", async () => {
    const root = await mkdtemp(join(tmpdir(), "ext-corrupt-"));
    tempDirs.push(root);
    const projects = new ProjectStore({ root });
    const { mkdir } = await import("node:fs/promises");
    await mkdir(join(root, "p-1", "reviews"), { recursive: true });
    await writeFile(join(root, "p-1", "reviews", "external-instructions.json"), "{broken", "utf8");
    expect(await new ExternalInstructionStore(projects).load("p-1")).toEqual([]);
  });
});

describe("applyDispatchOutcome（确定性状态机）", () => {
  const dispatchOf = (outcomes: ExternalOutcomeReport[], unmatched: string[] = []): ExternalDispatchResult => ({
    round: 2,
    revision: 3,
    outcomes,
    unmatched,
  });

  it("applied 且目标文件真实变化 → handled", () => {
    const { instructions } = applyDispatchOutcome(
      [instruction()],
      dispatchOf([{ instructionId: instruction().instructionId, outcome: "applied", targetChanged: true }]),
      NOW,
    );
    expect(instructions[0]!.status).toBe("handled");
  });

  it("applied 但无文件变化 → unresolved（不采信自称已处理）", () => {
    const { instructions } = applyDispatchOutcome(
      [instruction()],
      dispatchOf([{ instructionId: instruction().instructionId, outcome: "applied", targetChanged: false }]),
      NOW,
    );
    expect(instructions[0]!.status).toBe("unresolved");
    expect(instructions[0]!.statusNote).toContain("没有实际变化");
  });

  it("conflict → status=conflict + 保留依据（即使其他章节 applied）", () => {
    const target = instruction();
    const { instructions } = applyDispatchOutcome(
      [target],
      dispatchOf([
        { instructionId: target.instructionId, outcome: "conflict", basis: "Table 10：baseline IDS = 24，本文 IDS = 35" },
        { instructionId: target.instructionId, outcome: "applied", targetChanged: true },
      ]),
      NOW,
    );
    expect(instructions[0]!.status).toBe("conflict");
    expect(instructions[0]!.conflictBasis).toContain("IDS = 24");
  });

  it("applied（有实据）但部分章节未报告 → partially_handled", () => {
    const target = instruction();
    const { instructions } = applyDispatchOutcome(
      [target],
      dispatchOf([
        { instructionId: target.instructionId, outcome: "applied", targetChanged: true },
        { instructionId: target.instructionId, outcome: "unreported" },
      ]),
      NOW,
    );
    expect(instructions[0]!.status).toBe("partially_handled");
  });

  it("全部 not_applicable → unresolved", () => {
    const target = instruction();
    const { instructions } = applyDispatchOutcome(
      [target],
      dispatchOf([{ instructionId: target.instructionId, outcome: "not_applicable" }]),
      NOW,
    );
    expect(instructions[0]!.status).toBe("unresolved");
  });

  it("章节指错（unmatched）→ unresolved + 说明", () => {
    const target = instruction({ section: "sections/missing.tex" });
    const { instructions } = applyDispatchOutcome([target], dispatchOf([], [target.instructionId]), NOW);
    expect(instructions[0]!.status).toBe("unresolved");
    expect(instructions[0]!.statusNote).toContain("指定章节未匹配");
  });

  it("handled / conflict 是终态：新轮次派发不自动翻转", () => {
    const handled = instruction({ status: "handled" });
    const conflict = instruction({ status: "conflict" });
    const { instructions } = applyDispatchOutcome(
      [handled, conflict],
      dispatchOf([
        { instructionId: handled.instructionId, outcome: "not_applicable" },
        { instructionId: conflict.instructionId, outcome: "applied", targetChanged: true },
      ]),
      NOW,
    );
    expect(instructions[0]!.status).toBe("handled");
    expect(instructions[1]!.status).toBe("conflict");
  });
});

describe("reverifyHandledInstructions（gate 复核自愈）", () => {
  it("fact preservation FAIL → handled 降级 unresolved 重新派发；gate ok 不变", () => {
    const handled = instruction({ status: "handled" });
    const failed = applyOrKeep(handled, { ok: false });
    expect(failed.status).toBe("unresolved");
    const kept = applyOrKeep(handled, { ok: true });
    expect(kept.status).toBe("handled");
    const untouched = applyOrKeep(instruction({ status: "pending" }), { ok: false });
    expect(untouched.status).toBe("pending");
  });

  function applyOrKeep(target: ExternalInstruction, fact: { ok: boolean } | null): ExternalInstruction {
    return reverifyHandledInstructions([target], fact, NOW).instructions[0]!;
  }
});

describe("buildRevisionPlan 的 external 条目", () => {
  const summary = {
    round: 2,
    reviewedRevision: 2,
    counts: { critical: 0, major: 0, minor: 0, blocking: 0 },
    issues: [],
    scores: { academicScore: null, styleRisk: null },
  } as unknown as ReviewSummary;

  it("pending → mandatory planned 排最前；原文 sourceText 逐字保留", () => {
    const text = "Reviewer 2:\n1. 请补充与 ByteTrack 的对比。\n2. 第 3.7 节需要弱化显著性表述。";
    const plan = buildRevisionPlan({
      projectId: "p-1",
      sourceRevision: 2,
      reviewRound: 2,
      summary,
      externalInstructions: [instruction({ text })],
    });
    const item = plan.items.find((entry) => entry.kind === "external_instruction");
    expect(item).toMatchObject({
      priority: "mandatory",
      status: "planned",
      source: "external",
      section: "(global)",
    });
    expect(item!.sourceText).toBe(text);
    expect(plan.items[0]!.priority).toBe("mandatory");
    expect(plan.summary.external).toBe(1);
  });

  it("conflict → skipped + 冲突说明（保留 mandatory 标记与原文）", () => {
    const conflicting = instruction({
      status: "conflict",
      conflictBasis: "Table 10：baseline IDS = 24，本文 IDS = 35",
    });
    const plan = buildRevisionPlan({
      projectId: "p-1",
      sourceRevision: 2,
      reviewRound: 2,
      summary,
      externalInstructions: [conflicting],
    });
    const item = plan.items.find((entry) => entry.kind === "external_instruction");
    expect(item!.status).toBe("skipped");
    expect(item!.priority).toBe("mandatory");
    expect(item!.note).toContain("IDS = 24");
    expect(plan.summary.planned).toBe(0);
  });

  it("指定章节 → item.section 透传；handled → skipped 留档", () => {
    const scoped = instruction({ section: "sections/experiments.tex" });
    const done = instruction({ status: "handled", text: "已处理的意见。" });
    const plan = buildRevisionPlan({
      projectId: "p-1",
      sourceRevision: 2,
      reviewRound: 2,
      summary,
      externalInstructions: [scoped, done],
    });
    const scopedItem = plan.items.find((entry) => entry.instructionId === scoped.instructionId);
    expect(scopedItem!.section).toBe("sections/experiments.tex");
    const doneItem = plan.items.find((entry) => entry.instructionId === done.instructionId);
    expect(doneItem!.status).toBe("skipped");
    expect(doneItem!.note).toContain("已处理");
  });
});

// ---- WriterService：外部意见 prompt 契约与 OUTCOMES 解析 ----

class FakeRuntime implements AgentRuntime {
  readonly provider = "pi" as const;
  readonly tasks: string[] = [];
  private output: () => string;

  constructor(output: () => string) {
    this.output = output;
  }

  async runAgent(input: import("../../src/runtime/types.js").RunAgentInput): Promise<AgentTask> {
    this.tasks.push(input.task);
    const now = new Date().toISOString();
    return {
      taskId: "run-x1",
      agentId: input.agentId,
      status: "completed",
      createdAt: now,
      updatedAt: now,
      output: this.output(),
    };
  }

  async startAgent(input: import("../../src/runtime/types.js").RunAgentInput) {
    const task = await this.runAgent(input);
    return {
      taskId: task.taskId,
      sessionKey: "k",
      events: async function* () {},
      cancel: async () => {},
      result: async () => task,
    };
  }

  healthCheck(): Promise<import("../../src/runtime/types.js").RuntimeHealth> {
    throw new Error("not needed");
  }

  getTask(): Promise<AgentTask> {
    throw new Error("not implemented");
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

const SECTION_LATEX = "\\section{实验}\n本文方法 IDS = 47，baseline = 45。";
const DIRECTIVE = {
  instructionId: externalInstructionId("journal_reviewer", "Reviewer 2", "请把低照度优势说明得更明显。"),
  source: "journal_reviewer" as const,
  reviewerLabel: "Reviewer 2",
  text: "请把低照度优势说明得更明显。",
};

describe("WriterService 外部意见契约（M5.7）", () => {
  it("无外部意见时 prompt 与输出行为不变（不含外部区块 / 无报告行）", async () => {
    const runtime = new FakeRuntime(() => SECTION_LATEX + "\n修订补充。");
    const writer = new WriterService({ runtime, agentId: "writer" });
    const result = await writer.reviseSection({
      projectId: "p-1",
      section: { id: "experiments", file: "experiments.tex", title: "实验" },
      outline: { title: "T", sections: [] },
      currentLatex: SECTION_LATEX,
      issues: [
        {
          category: "academic",
          severity: "major",
          section: "experiments",
          description: "表述偏强",
          blocking: false,
        },
      ],
      evidence: [],
      bibliography: [],
    });
    expect(runtime.tasks[0]).not.toContain("外部修改意见");
    expect(result.externalOutcomes).toBeUndefined();
    expect(result.latex).toContain("修订补充");
  });

  it("外部意见进入 prompt（最高优先级区块 + 事实红线 + 报告行格式）", async () => {
    const runtime = new FakeRuntime(() => SECTION_LATEX);
    const writer = new WriterService({ runtime, agentId: "writer" });
    await writer.reviseSection({
      projectId: "p-1",
      section: { id: "experiments", file: "experiments.tex", title: "实验" },
      outline: { title: "T", sections: [] },
      currentLatex: SECTION_LATEX,
      issues: [],
      evidence: [],
      bibliography: [],
      externalDirectives: [DIRECTIVE],
    });
    const prompt = runtime.tasks[0]!;
    expect(prompt).toContain("外部修改意见（最高业务优先级）");
    expect(prompt).toContain("不伪造数字、不篡改表格、不美化负结果");
    expect(prompt).toContain("%%%PT-OUTCOMES%%%");
    expect(prompt).toContain(DIRECTIVE.text);
    expect(prompt).toContain(DIRECTIVE.instructionId);
  });

  it("输出携带报告行：正文剥离标记；conflict 依据透传", async () => {
    const runtime = new FakeRuntime(
      () =>
        SECTION_LATEX +
        "\n" +
        `%%%PT-OUTCOMES%%% [{"instructionId":"${DIRECTIVE.instructionId}","outcome":"conflict","basis":"Table 10：IDS 24 vs 35，不支持优势"}]`,
    );
    const writer = new WriterService({ runtime, agentId: "writer" });
    const result = await writer.reviseSection({
      projectId: "p-1",
      section: { id: "experiments", file: "experiments.tex", title: "实验" },
      outline: { title: "T", sections: [] },
      currentLatex: SECTION_LATEX,
      issues: [],
      evidence: [],
      bibliography: [],
      externalDirectives: [DIRECTIVE],
    });
    expect(result.latex).not.toContain("%%%PT-OUTCOMES%%%");
    expect(result.latex).toContain("IDS = 47");
    expect(result.externalOutcomes).toEqual([
      {
        instructionId: DIRECTIVE.instructionId,
        outcome: "conflict",
        basis: "Table 10：IDS 24 vs 35，不支持优势",
      },
    ]);
  });

  it("报告行缺失 / 非法 JSON 条目 → unreported 如实补齐（不采信也不丢弃）", async () => {
    const runtime = new FakeRuntime(() => SECTION_LATEX + "\n修订。");
    const writer = new WriterService({ runtime, agentId: "writer" });
    const result = await writer.reviseSection({
      projectId: "p-1",
      section: { id: "experiments", file: "experiments.tex", title: "实验" },
      outline: { title: "T", sections: [] },
      currentLatex: SECTION_LATEX,
      issues: [],
      evidence: [],
      bibliography: [],
      externalDirectives: [DIRECTIVE],
    });
    expect(result.externalOutcomes).toEqual([
      { instructionId: DIRECTIVE.instructionId, outcome: "unreported" },
    ]);

    const badJson = new FakeRuntime(
      () => SECTION_LATEX + "\n%%%PT-OUTCOMES%%% not-json",
    );
    const writer2 = new WriterService({ runtime: badJson, agentId: "writer" });
    const result2 = await writer2.reviseSection({
      projectId: "p-1",
      section: { id: "experiments", file: "experiments.tex", title: "实验" },
      outline: { title: "T", sections: [] },
      currentLatex: SECTION_LATEX,
      issues: [],
      evidence: [],
      bibliography: [],
      externalDirectives: [DIRECTIVE],
    });
    expect(result2.externalOutcomes).toEqual([
      { instructionId: DIRECTIVE.instructionId, outcome: "unreported" },
    ]);
    expect(result2.latex).not.toContain("%%%PT-OUTCOMES%%%");
  });

  it("报告行包含未知 instructionId → 丢弃（不影响已知条目）", async () => {
    const runtime = new FakeRuntime(
      () =>
        SECTION_LATEX +
        "\n" +
        `%%%PT-OUTCOMES%%% [{"instructionId":"x-unknown","outcome":"applied"},{"instructionId":"${DIRECTIVE.instructionId}","outcome":"applied"}]`,
    );
    const writer = new WriterService({ runtime, agentId: "writer" });
    const result = await writer.reviseSection({
      projectId: "p-1",
      section: { id: "experiments", file: "experiments.tex", title: "实验" },
      outline: { title: "T", sections: [] },
      currentLatex: SECTION_LATEX,
      issues: [],
      evidence: [],
      bibliography: [],
      externalDirectives: [DIRECTIVE],
    });
    expect(result.externalOutcomes).toEqual([
      { instructionId: DIRECTIVE.instructionId, outcome: "applied" },
    ]);
  });
});
