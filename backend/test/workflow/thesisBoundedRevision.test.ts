/**
 * M14.4 P0-1 集成：thesis 修订 bounded 模式（真实 revision.revise stage）。
 *
 * 场景基线（M14.3 R3 真实故障，本文件即其确定性回归）：
 *  - thesis 节文件普遍 2–5KB（< 9000 字符阈值）→ expandLongFileTargets 不展开
 *    → 文件级整文件覆写（无候选守卫环）→ Writer 重写全节，质量逐轮劣化
 *    （issues 186→544 / academicScore 63→54）；
 *  - 修复：workflowKind=thesis_from_papers 时全部章节文件 span 化——
 *    quote 锚点 → 段落窗口（候选按引文区间逐字校验）；无锚点 → 整 span
 *    合并单元（同一候选守卫环）。
 *
 * 验证口径：修改目标外的原文**逐字节不变**（直接字符串比较）。
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { startTestStack, scriptedIdeaRuntime } from "../helpers/testStack.js";
import { createThesisFromPapersDefinition } from "../../src/workflow/definitions.js";
import type { StageRunContext } from "../../src/workflow/types.js";
import { partitionSpanIntoBlockUnits } from "../../src/review/logicalSpan.js";
import type { RevisionPlanItem, RevisionPlan } from "../../src/review/revisionPlan.js";
import type { ReviewSummary } from "../../src/review/ReviewAggregator.js";

/** 三段式 thesis 节文件（无标题命令——headless，fileBodySpan 路径）*/
const P1 = "本章提出面向非二值前景图的结构化评价指标。真实场景中的显著图往往" +
  "呈现不同程度的平滑过渡，传统二值化评价无法刻画这种结构差异，因此需要在" +
  "像素级误差之外引入结构感知的度量维度。该动机贯穿本章方法的全部设计决策" +
  "，并与后续章节的基准数据集构建相互印证，共同构成完整的评价体系论述。";
const P2 = "具体而言，该指标首先将前景图按连通域划分为若干结构对象，" +
  "再分别计算局部与全局的感知差异并加权融合，权重由目标的空间分布决定。" +
  "该设计使评价对边界模糊区域更加敏感，同时保持对整体布局差异的分辨能力" +
  "，避免了传统指标在平滑区域系统性低估模型质量的问题。";
const P3 = "实验部分在五个公开数据集上与七种基线方法对比，结果均显示该指标" +
  "与人工标注的一致性更高。消融实验进一步验证了结构划分与加权融合两个组件" +
  "各自的贡献，统计显著性检验采用双边配对 t 检验（$p<0.05$）。";
const THESIS_TEX = `${P1}\n\n${P2}\n\n${P3}\n`;
/** P2 中部的唯一锚点（≥12 字） */
const QUOTE = "再分别计算局部与全局的感知差异并加权融合";
const OTHER_TEX = "相关工作的综述内容。\n\n本章小结与过渡。\n";

/** 20k 章节（boundedAll 大文件路径：贪心装箱单元；全部子句带唯一编号保证唯一锚点）*/
function bigChapter(paragraphs: number): string {
  const parts: string[] = [];
  for (let index = 0; index < paragraphs; index += 1) {
    const clauses: string[] = [`第${index + 1}段落：本段阐述方法细节与实验观察的综合分析结论，`];
    for (let sub = 1; sub <= 4; sub += 1) {
      clauses.push(`（${index + 1}.${sub}）该子句论述数据集划分、训练协议与评测口径的一致性要求${sub}，并讨论超参数稳定性与统计显著性边界；`);
    }
    parts.push(clauses.join(""));
  }
  return parts.join("\n\n") + "\n";
}
const BIG_TEX = bigChapter(120); // ≈ 25k chars > 9000

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const cleanup of cleanups.reverse()) await cleanup();
});

interface Setup {
  project: { id: string };
  services: Awaited<ReturnType<typeof startTestStack>>["stack"]["workflowServices"];
  tasks: string[];
  calls: () => number;
  source: (file?: string) => Promise<string>;
  artifact: () => Promise<{ records: Array<{ logicalTarget: string; overall: string; finalStatus?: string; apply?: { status: string }; scope: { violations: string[] } }> } | null>;
  execute: () => Promise<Record<string, unknown>>;
  events: Array<{ type: string; data: unknown; message: string }>;
  runId: string;
}

async function setup(proposals: string[], items: RevisionPlanItem[], options: { big?: boolean } = {}): Promise<Setup> {
  const scripted = scriptedIdeaRuntime();
  let calls = 0;
  const tasks: string[] = [];
  const events: Setup["events"] = [];
  const runtime = {
    ...scripted.runtime,
    runAgent: async (input: Parameters<typeof scripted.runtime.runAgent>[0]) => {
      tasks.push(input.task);
      const now = new Date().toISOString();
      calls += 1;
      return {
        taskId: `thesis-b-${calls}`, agentId: "writer", status: "completed" as const, createdAt: now, updatedAt: now,
        output: proposals[Math.min(calls - 1, proposals.length - 1)] ?? "", events: [],
      };
    },
  };
  const stack = await startTestStack(runtime, { registerCleanup: (cleanup) => cleanups.push(cleanup) });
  const project = await stack.store.create("Thesis bounded revision fixture", { language: "zh", documentType: "doctoral_thesis" });
  const services = stack.stack.workflowServices;
  const manuscriptDir = stack.store.manuscriptDir(project.id);
  await mkdir(join(manuscriptDir, "sections"), { recursive: true });
  await writeFile(join(manuscriptDir, "main.tex"), "\\documentclass{ctexbook}\n\\begin{document}\n\\input{sections/ch3-method}\n\\input{sections/ch2-related}\n\\end{document}\n");
  await writeFile(join(manuscriptDir, "sections", "ch3-method.tex"), options.big === true ? BIG_TEX : THESIS_TEX);
  await writeFile(join(manuscriptDir, "sections", "ch2-related.tex"), OTHER_TEX);
  await writeFile(join(manuscriptDir, "references.bib"), "@article{ref1,title={R1},year={2020}}\n@article{ref2,title={R2},year={2021}}\n");
  const baseline = await services.revisions.commit(project.id, "baseline");
  const summary: ReviewSummary = {
    generatedAt: new Date().toISOString(),
    round: 1,
    reviewedRevision: baseline.revision,
    issues: [],
    counts: { critical: items.length, major: 0, minor: 0, byCategory: {}, blocking: items.length },
    scores: { academicScore: 60, styleRisk: 10, factVerdicts: null },
    openCritical: items.length,
    openMajor: 0,
    unsupportedCriticalClaims: 0,
  } as unknown as ReviewSummary;
  await services.reviewArtifacts.saveSummary(project.id, 1, summary);
  const plan: RevisionPlan = {
    schemaVersion: 1,
    planId: "plan-thesis-bounded-test",
    projectId: project.id,
    sourceRevision: baseline.revision,
    reviewRound: 1,
    createdAt: new Date().toISOString(),
    summary: { critical: items.length, major: 0, blocking: items.length, minorRecorded: 0, planned: items.length, skipped: 0 },
    items,
  };
  await services.reviewArtifacts.savePlan(project.id, plan);
  const definition = createThesisFromPapersDefinition(services);
  const stage = definition.stages.find((s) => s.id === "revision.revise")!;
  const runId = "thesis-bounded-test";
  const ctx = {
    projectId: project.id, runId, attempt: 1, signal: new AbortController().signal,
    state: { workflowKind: "thesis_from_papers", stageResults: {}, stageHistory: [], completedStages: [], inputs: {}, request: {} },
    emitProgress: async () => {},
    emitDomain: async (type: string, data: unknown, message: string) => { events.push({ type, data, message }); },
    log: () => {},
  } as unknown as StageRunContext;
  return {
    project, services, tasks,
    calls: () => calls,
    source: (file = "sections/ch3-method.tex") => readFile(join(manuscriptDir, file), "utf8"),
    artifact: async () => services.reviewArtifacts.loadPatchValidation(project.id, await services.revisions.currentRevision(project.id)),
    execute: async () => {
      if (!("execute" in stage)) throw new Error("Wrong stage");
      return stage.execute(ctx) as Promise<Record<string, unknown>>;
    },
    events,
    runId,
  };
}

function planItem(id: string, targetQuote: string | undefined, section = "sections/ch3-method.tex"): RevisionPlanItem {
  return {
    id,
    kind: "review_finding",
    priority: "high",
    section,
    problem: `章节表述需要修订（${id}）`,
    instruction: "按审稿意见修订该段落",
    expectedOutcome: "目标段落表述改善，其余内容不变",
    status: "planned",
    actionType: "modify",
    ...(targetQuote !== undefined ? { targetQuote } : {}),
  } as RevisionPlanItem;
}

describe("M14.4 thesis bounded revision（revision.revise，workflowKind=thesis_from_papers）", () => {
  it("场景 A：quote 锚点 → 段落窗口目标；合规局部修改只动引文区间，其余逐字节不变", async () => {
    // 期望单元 = P2 所在段落块（#u2）；Writer 输出 = 该单元全文，仅引文区间加前缀
    const unit = partitionSpanIntoBlockUnits({
      file: "sections/ch3-method.tex",
      logicalSection: "file:sections/ch3-method.tex",
      heading: "sections/ch3-method.tex",
      start: 0,
      end: THESIS_TEX.length,
      originalHash: "",
      content: THESIS_TEX,
    }).units.find((candidate) => candidate.content.includes(QUOTE))!;
    const proposal = unit.content.replace(QUOTE, `（修订后）${QUOTE}`);
    const run = await setup([proposal], [planItem("f-aaa", QUOTE)]);
    const result = await run.execute();
    const after = await run.source();
    // 修改严格限于引文区间：文件 = 原文 + 前缀插入
    expect(after).toBe(THESIS_TEX.replace(QUOTE, `（修订后）${QUOTE}`));
    // 相邻文件逐字节不变
    expect(await run.source("sections/ch2-related.tex")).toBe(OTHER_TEX);
    // patch lineage 指向段落窗口单元
    const artifact = await run.artifact();
    const applied = artifact?.records.find((entry) => entry.apply?.status === "applied");
    expect(applied?.logicalTarget).toBe("file:sections/ch3-method.tex#u2");
    expect(applied?.overall).toBe("pass");
    expect(result).toMatchObject({ changed: true, revisedSections: 1 });
  });

  it("场景 A：Writer 试图重写整节（改引文外正文）→ quote 范围守卫拒绝，原稿逐字节保留", async () => {
    // Writer 输出 = 整个章节文件的改写（P1/P3 也被改动）——旧文件级路径会整文件覆写
    const rewrite = THESIS_TEX
      .replace(P1, "（整节重写的第一段。）")
      .replace(QUOTE, `（修订后）${QUOTE}`)
      .replace(P3, "（整节重写的第三段。）");
    const run = await setup([rewrite, rewrite, rewrite], [planItem("f-bbb", QUOTE)]);
    const result = await run.execute();
    const after = await run.source();
    expect(after).toBe(THESIS_TEX); // 原稿未被污染
    const artifact = await run.artifact();
    const rejected = artifact?.records.filter((entry) => entry.apply?.status !== "applied");
    expect(rejected?.length).toBeGreaterThan(0);
    expect(rejected?.every((entry) => entry.overall === "fail")).toBe(true);
    expect(rejected?.some((entry) => entry.scope.violations.some((violation) => violation.includes("QUOTE")))).toBe(true);
    expect(result).toMatchObject({ changed: false });
  });

  it("场景 B（候选层）：内容塌缩候选（摘要式重写）被拒绝，原稿保留", async () => {
    // 无锚点条目（整 span 合并单元）；Writer 把整个 span 压缩成一句话
    //（THESIS_TEX ≈ 550 字 → 20 字：缩减 > 300 且保留率 < 50%）
    const collapse = "该指标划分结构对象并加权融合感知差异。\n";
    const run = await setup([collapse, collapse, collapse], [planItem("f-ccc", undefined)]);
    await run.execute();
    expect(await run.source()).toBe(THESIS_TEX);
    const artifact = await run.artifact();
    const rejected = artifact?.records.filter((entry) => entry.apply?.status !== "applied");
    expect(rejected?.some((entry) => entry.scope.violations.some((violation) => violation.includes("CONTENT_COLLAPSE")))).toBe(true);
  });

  it("无锚点条目回退整 span 合并单元（#u1-N）——仍走候选守卫环，不再整文件裸覆写", async () => {
    const full = THESIS_TEX.replace(QUOTE, `（修订后）${QUOTE}`);
    const run = await setup([full], [planItem("f-ddd", undefined)]);
    const result = await run.execute();
    expect(await run.source()).toBe(full);
    const artifact = await run.artifact();
    const applied = artifact?.records.find((entry) => entry.apply?.status === "applied");
    expect(applied?.logicalTarget).toBe("file:sections/ch3-method.tex#u1-3");
    expect(result).toMatchObject({ changed: true });
  });

  it("找不到唯一锚点 → unresolved 不派发（不猜位置、不回退整节重写）", async () => {
    const run = await setup(["should-not-be-called"], [planItem("f-eee", "这句原文根本不存在于章节之中")]);
    const result = await run.execute();
    expect(run.calls()).toBe(0);
    expect(await run.source()).toBe(THESIS_TEX);
    expect(result).toMatchObject({ changed: false });
    expect(run.events.some((event) => event.type === "revision.dispatch_unresolved")).toBe(true);
  });

  it("多个 Finding 分别定位不同段落 → 各自段落窗口目标，互不吞并", async () => {
    const units = partitionSpanIntoBlockUnits({
      file: "sections/ch3-method.tex",
      logicalSection: "file:sections/ch3-method.tex",
      heading: "sections/ch3-method.tex",
      start: 0,
      end: THESIS_TEX.length,
      originalHash: "",
      content: THESIS_TEX,
    }).units;
    const p1Quote = "传统二值化评价无法刻画这种结构差异";
    const p3Quote = "统计显著性检验采用双边配对 t 检验";
    // 两个目标分别返回各自单元的修订版（按 prompt 中出现顺序不可靠——用内容探测）
    const proposalFor = (unitContent: string, quote: string): string => unitContent.replace(quote, `（修订）${quote}`);
    const run = await setup(
      [
        proposalFor(units.find((candidate) => candidate.content.includes(p1Quote))!.content, p1Quote),
        proposalFor(units.find((candidate) => candidate.content.includes(p3Quote))!.content, p3Quote),
        proposalFor(units.find((candidate) => candidate.content.includes(QUOTE))!.content, QUOTE),
      ],
      [planItem("f-fff1", p1Quote), planItem("f-fff2", p3Quote)],
    );
    const result = await run.execute();
    const after = await run.source();
    expect(after).toBe(
      THESIS_TEX
        .replace(p1Quote, `（修订）${p1Quote}`)
        .replace(p3Quote, `（修订）${p3Quote}`),
    );
    expect(result).toMatchObject({ changed: true, revisedSections: 2 });
    const artifact = await run.artifact();
    const targets = artifact?.records.filter((entry) => entry.apply?.status === "applied").map((entry) => entry.logicalTarget);
    expect(new Set(targets)).toEqual(new Set(["file:sections/ch3-method.tex#u1", "file:sections/ch3-method.tex#u3"]));
  });

  it("20k 章节尾部锚点（贪心装箱路径）：单元外逐字节保持", async () => {
    // 尾部 60 字锚点
    const tail = BIG_TEX.slice(Math.floor(BIG_TEX.length * 0.9), Math.floor(BIG_TEX.length * 0.9) + 60);
    const { partitionSpanIntoUnits } = await import("../../src/review/logicalSpan.js");
    const units = partitionSpanIntoUnits({
      file: "sections/ch3-method.tex", logicalSection: "file:sections/ch3-method.tex", heading: "s",
      start: 0, end: BIG_TEX.length, originalHash: "", content: BIG_TEX,
    }, 9_000).units;
    const unit = units.find((candidate) => candidate.content.includes(tail))!;
    const proposal = unit.content.replace(tail, `[修订]${tail}`);
    const run = await setup([proposal], [planItem("f-ggg", tail)], { big: true });
    await run.execute();
    const after = await run.source();
    expect(after).toBe(BIG_TEX.replace(unit.content, proposal));
    expect(after.length).toBe(BIG_TEX.length + "[修订]".length);
  });

  it("场景 G：已应用修订的重放不重复应用（计划条目已 applied / 内容等价）", async () => {
    const units = partitionSpanIntoBlockUnits({
      file: "sections/ch3-method.tex", logicalSection: "file:sections/ch3-method.tex", heading: "s",
      start: 0, end: THESIS_TEX.length, originalHash: "", content: THESIS_TEX,
    }).units;
    const unit = units.find((candidate) => candidate.content.includes(QUOTE))!;
    const proposal = unit.content.replace(QUOTE, `（修订后）${QUOTE}`);
    const run = await setup([proposal, proposal], [planItem("f-hhh", QUOTE)]);
    const first = await run.execute();
    expect(first).toMatchObject({ changed: true });
    const afterFirst = await run.source();
    const revisionAfterFirst = await run.services.revisions.currentRevision(run.project.id);
    // 中断重放：同计划再次执行（内容已更新 → relocation stale / 计划已 applied → 不再派发）
    await run.execute();
    const afterSecond = await run.source();
    expect(afterSecond).toBe(afterFirst);
    expect(await run.services.revisions.currentRevision(run.project.id)).toBe(revisionAfterFirst);
  });
});
