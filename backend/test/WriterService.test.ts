import { describe, expect, it } from "vitest";

import { AgentRunFailedError, InvalidLatexOutputError } from "../src/errors.js";
import type { AgentRuntime, AgentTask } from "../src/runtime/types.js";
import { WriterService, buildWriterPrompt, partitionEvidenceBackedKeys } from "../src/writer/WriterService.js";
import type { EvidenceRecord } from "../src/evidence/EvidenceStore.js";

/** 可编程的假 Runtime：记录调用并返回预设任务结果 */
class FakeRuntime implements AgentRuntime {
  readonly provider = "pi" as const;
  readonly calls: { agentId: string; task: string; projectId?: string }[] = [];
  private result: () => AgentTask;

  constructor(result: () => AgentTask) {
    this.result = result;
  }

  healthCheck(): Promise<import("../src/runtime/types.js").RuntimeHealth> {
    throw new Error("not needed in this test");
  }

  async startAgent(input: import("../src/runtime/types.js").RunAgentInput): Promise<import("../src/runtime/types.js").AgentRunHandle> {
    this.calls.push({ agentId: input.agentId, task: input.task, projectId: input.projectId });
    const task = this.result();
    return {
      taskId: task.taskId,
      sessionKey: `agent:${input.agentId}:paperteam-fake`,
      events: async function* () {},
      cancel: async () => {},
      result: async () => task,
    };
  }

  async runAgent(input: import("../src/runtime/types.js").RunAgentInput): Promise<AgentTask> {
    this.calls.push({ agentId: input.agentId, task: input.task, projectId: input.projectId });
    return this.result();
  }

  getTask(): Promise<AgentTask> {
    throw new Error("not implemented");
  }

  close(): Promise<void> {
    return Promise.resolve();
  }
}

function completedTask(output: string): AgentTask {
  const now = new Date().toISOString();
  return {
    taskId: "run-w1",
    agentId: "writer",
    status: "completed",
    createdAt: now,
    updatedAt: now,
    output,
  };
}

const VALID_LATEX = [
  "\\documentclass[UTF8]{ctexart}",
  "\\usepackage{amsmath}",
  "\\begin{document}",
  "\\section{引言}",
  "RAG 是检索增强生成。",
  "\\end{document}",
].join("\n");

describe("WriterService", () => {
  it("正确调用 AgentRuntime 并提取 LaTeX 输出", async () => {
    const runtime = new FakeRuntime(() => completedTask(VALID_LATEX));
    const writer = new WriterService({ runtime, agentId: "writer" });

    const result = await writer.write({ projectId: "p-abc", prompt: "写一篇关于 RAG 的短文" });

    // 调用参数
    expect(runtime.calls).toHaveLength(1);
    expect(runtime.calls[0]!.agentId).toBe("writer");
    expect(runtime.calls[0]!.projectId).toBe("p-abc");
    expect(runtime.calls[0]!.task).toContain("写一篇关于 RAG 的短文");
    expect(runtime.calls[0]!.task).toContain("\\documentclass");
    // 返回内容
    expect(result.latex).toBe(VALID_LATEX);
    expect(result.task.taskId).toBe("run-w1");
  });

  it("Prompt 包含关键约束（完整 LaTeX / 中文 / 无围栏 / 无虚构引用）", () => {
    const prompt = buildWriterPrompt("任务 X");
    expect(prompt).toContain("ctexart");
    expect(prompt).toContain("LaTeX");
    expect(prompt).toContain("```");
    expect(prompt).toContain("参考文献");
    expect(prompt).toContain("任务 X");
  });

  it("模型误加 Markdown 围栏时自动剥离", async () => {
    const wrapped = "```latex\n" + VALID_LATEX + "\n```";
    const runtime = new FakeRuntime(() => completedTask(wrapped));
    const writer = new WriterService({ runtime, agentId: "writer" });
    const result = await writer.write({ projectId: "p-abc", prompt: "写" });
    expect(result.latex).toBe(VALID_LATEX);
  });

  it("非 LaTeX 输出（缺少 documentclass）抛 InvalidLatexOutputError", async () => {
    const runtime = new FakeRuntime(() => completedTask("这只是一段普通文本，不是论文。"));
    const writer = new WriterService({ runtime, agentId: "writer" });
    await expect(writer.write({ projectId: "p-abc", prompt: "写" })).rejects.toBeInstanceOf(
      InvalidLatexOutputError,
    );
  });

  it("空输出抛 AgentRunFailedError，不允许空结果落盘", async () => {
    const runtime = new FakeRuntime(() => completedTask("   "));
    const writer = new WriterService({ runtime, agentId: "writer" });
    await expect(writer.write({ projectId: "p-abc", prompt: "写" })).rejects.toBeInstanceOf(
      AgentRunFailedError,
    );
  });

  it("任务失败（status=failed）抛 AgentRunFailedError", async () => {
    const runtime = new FakeRuntime(() => ({
      ...completedTask(""),
      status: "failed" as const,
      error: "模型服务不可用",
    }));
    const writer = new WriterService({ runtime, agentId: "writer" });
    await expect(writer.write({ projectId: "p-abc", prompt: "写" })).rejects.toMatchObject({
      code: "AGENT_RUN_FAILED",
      message: expect.stringContaining("模型服务不可用"),
    });
  });

  it("空 prompt 抛 AgentRunFailedError", async () => {
    const runtime = new FakeRuntime(() => completedTask(VALID_LATEX));
    const writer = new WriterService({ runtime, agentId: "writer" });
    await expect(writer.write({ projectId: "p-abc", prompt: "  " })).rejects.toBeInstanceOf(
      AgentRunFailedError,
    );
    expect(runtime.calls).toHaveLength(0);
  });
});

describe("WriterService M6.6：Evidence-aware 写作上下文", () => {
  const SECTION = { id: "introduction", file: "introduction.tex", title: "引言" };
  const OUTLINE = {
    title: "RAG 综述",
    sections: [SECTION],
  };
  const FORMAL_EVIDENCE = [
    {
      id: "E001",
      claim: "RAG 降低幻觉率",
      quote: "error rate drops by 42 percent",
      verificationStatus: "verified",
      supportStrength: "direct",
      source: { sourceId: "S001", title: "A Survey of Retrieval-Augmented Generation", year: 2023, doi: "10.1000/survey" },
      location: { chunk: "S001:SEC01:0001:a1b2c3d4e5", section: "Introduction" },
      createdBy: "researcher",
      createdAt: "2026-09-17T00:00:00Z",
    },
  ] as const;
  const BIBLIOGRAPHY = [
    {
      key: "gao2023survey",
      title: "A Survey of Retrieval-Augmented Generation",
      year: 2023,
      doi: "10.1000/survey",
    },
  ];

  it("writeSection digest：verified Evidence 行关联 bib key（cite:）+ evidence_query 工具指引", async () => {
    const runtime = new FakeRuntime(() =>
      completedTask("\\section{引言}\nRAG 是检索增强生成。"),
    );
    const writer = new WriterService({ runtime, agentId: "writer" });
    await writer.writeSection({
      projectId: "p-abc",
      section: SECTION,
      outline: OUTLINE,
      evidence: [...FORMAL_EVIDENCE],
      bibliography: BIBLIOGRAPHY,
    });
    const prompt = runtime.calls[0]!.task;
    expect(prompt).toContain("[E001]（cite: gao2023survey；src: A Survey of Retrieval-Augmented Generation (2023)）");
    expect(prompt).toContain("已核验 verified");
    expect(prompt).toContain("evidence_query");
    // 要求 Writer 引用优先使用有已核验证据支撑的 key
    expect(prompt).toContain("cite key");
  });

  it("writeSection 无 verified Evidence：显式提示弱化论断（不虚构、不注入占位）", async () => {
    const runtime = new FakeRuntime(() =>
      completedTask("\\section{引言}\nRAG 是检索增强生成。"),
    );
    const writer = new WriterService({ runtime, agentId: "writer" });
    await writer.writeSection({
      projectId: "p-abc",
      section: SECTION,
      outline: OUTLINE,
      evidence: [],
      bibliography: BIBLIOGRAPHY,
    });
    const prompt = runtime.calls[0]!.task;
    expect(prompt).toContain("无已核验（verified）Evidence");
    expect(prompt).toContain("evidence_query");
    expect(prompt).not.toContain("[E00");
  });

  it("reviseSection digest 同样走 verified 快照 + key 关联", async () => {
    const runtime = new FakeRuntime(() =>
      completedTask("\\section{引言}\nRAG 是检索增强生成。"),
    );
    const writer = new WriterService({ runtime, agentId: "writer" });
    await writer.reviseSection({
      projectId: "p-abc",
      section: SECTION,
      outline: OUTLINE,
      currentLatex: "\\section{引言}\n旧内容。",
      issues: [
        {
          category: "fact",
          severity: "major",
          section: "introduction",
          description: "论断缺证据",
          blocking: false,
        },
      ],
      evidence: [...FORMAL_EVIDENCE],
      bibliography: BIBLIOGRAPHY,
    });
    const prompt = runtime.calls[0]!.task;
    expect(prompt).toContain("[E001]（cite: gao2023survey；src: A Survey of Retrieval-Augmented Generation (2023)）");
    expect(prompt).toContain("evidence_query");
  });
});

describe("WriterService M9.7.2：Verified Evidence Context + 引用分组", () => {
  const SECTION = { id: "introduction", file: "introduction.tex", title: "引言" };
  const OUTLINE = {
    title: "RAG 综述",
    sections: [SECTION],
  };
  const EVIDENCE_S1 = [
    {
      id: "E001",
      claim: "ReAct 交替推理与行动",
      quote: "interleaving reasoning and acting",
      verificationStatus: "verified",
      supportStrength: "direct",
      source: { sourceId: "S001", title: "ReAct", year: 2023, doi: "10.1/react" },
      location: { chunk: "S001:SEC01:0001:a1b2c3d4e5", section: "1" },
      createdBy: "researcher",
      createdAt: "2026-09-23T00:00:00Z",
    },
  ] as unknown as EvidenceRecord[];
  const BIB = [
    { key: "yao2023react", title: "ReAct", year: 2023, doi: "10.1/react" },
    { key: "wei2022cot", title: "Chain-of-Thought", year: 2022 },
    { key: "bommasani2021foundation", title: "Foundation Models", year: 2021 },
  ];

  it("partitionEvidenceBackedKeys：sourceId/DOI 命中的 key 进 A 组，其余进 B 组", () => {
    const { backedKeys, unbackedKeys } = partitionEvidenceBackedKeys(EVIDENCE_S1, BIB);
    expect(backedKeys).toEqual(["yao2023react"]);
    expect(unbackedKeys).toEqual(["wei2022cot", "bommasani2021foundation"]);
  });

  it("writeSection：白名单分组渲染（A 组 = 证据命中 key，B 组 = 回忆 key）+ Verified Evidence Context 块头", async () => {
    const runtime = new FakeRuntime(() =>
      completedTask("\\section{引言}\n如 \\cite{yao2023react} 所示。"),
    );
    const writer = new WriterService({ runtime, agentId: "writer" });
    await writer.writeSection({
      projectId: "p-abc",
      section: SECTION,
      outline: OUTLINE,
      evidence: EVIDENCE_S1,
      bibliography: BIB,
    });
    const prompt = runtime.calls[0]!.task;
    expect(prompt).toContain("Verified Evidence Context（已核验 verified 证据，引用第一优先来源）");
    expect(prompt).toContain("按 verified evidence 支撑分组");
    expect(prompt).toContain("引用必须取自本组）：yao2023react");
    expect(prompt).toContain("不得改引本组 key 充数）：wei2022cot, bommasani2021foundation");
  });

  it("writeSection：全部 key 无证据 → A 组空提示（事实论断弱化，不引 B 组支撑）", async () => {
    const runtime = new FakeRuntime(() =>
      completedTask("\\section{引言}\nRAG 是检索增强生成。"),
    );
    const writer = new WriterService({ runtime, agentId: "writer" });
    await writer.writeSection({
      projectId: "p-abc",
      section: SECTION,
      outline: OUTLINE,
      evidence: [],
      bibliography: BIB,
    });
    const prompt = runtime.calls[0]!.task;
    expect(prompt).toContain("（空——当前没有任何可用 key 具备 verified evidence 支撑");
    expect(prompt).toContain("事实性论断只能弱化或删除");
    expect(prompt).toContain("）：yao2023react, wei2022cot, bommasani2021foundation");
  });

  it("writeSection：全部 key 有证据（M9.6 形态）→ B 组空提示，行为等价旧白名单", async () => {
    const runtime = new FakeRuntime(() =>
      completedTask("\\section{引言}\n如 \\cite{yao2023react} 所示。"),
    );
    const writer = new WriterService({ runtime, agentId: "writer" });
    await writer.writeSection({
      projectId: "p-abc",
      section: SECTION,
      outline: OUTLINE,
      evidence: EVIDENCE_S1,
      bibliography: [BIB[0]!],
    });
    const prompt = runtime.calls[0]!.task;
    expect(prompt).toContain("引用必须取自本组）：yao2023react");
    expect(prompt).toContain("（无——全部可用 key 均有证据支撑，按 A 组规则引用）");
  });

  it("reviseSection：分组白名单 + 修订特则（B 组存量保留、不得新增）", async () => {
    const runtime = new FakeRuntime(() =>
      completedTask("\\section{引言}\n修订后的内容。"),
    );
    const writer = new WriterService({ runtime, agentId: "writer" });
    await writer.reviseSection({
      projectId: "p-abc",
      section: SECTION,
      outline: OUTLINE,
      currentLatex: "\\section{引言}\n旧内容 \\cite{wei2022cot}。",
      issues: [
        {
          category: "fact",
          severity: "major",
          section: "introduction",
          description: "论断缺证据",
          blocking: false,
        },
      ],
      evidence: EVIDENCE_S1,
      bibliography: BIB,
    });
    const prompt = runtime.calls[0]!.task;
    expect(prompt).toContain("按 verified evidence 支撑分组");
    expect(prompt).toContain("修订特则：本章节现有的 B 组引用按第 10/11 条保留");
    expect(prompt).toContain("不得新增 B 组引用");
    // M9.10 Phase 2：引用冻结清单（现有 key 显式列出 + 禁删规则）
    expect(prompt).toContain("引用冻结清单");
    expect(prompt).toContain("wei2022cot");
    expect(prompt).toContain("禁止删除清单内任何 key");
  });

  it("reviseSection：无外部意见派发时也剥离自发的 PT-OUTCOMES 协议行（M9.10 Phase 1）", async () => {
    const leakyOutput = [
      "\\section{实验}",
      "修订后的正文，包含数值 901.5 ms。",
      "%%%PT-OUTCOMES%%% [{\"instructionId\":\"f-0f185517c97b\",\"outcome\":\"applied\",\"basis\":\"证据库 verified 记录为 0\"}]",
      "",
    ].join("\n");
    const runtime = new FakeRuntime(() => completedTask(leakyOutput));
    const writer = new WriterService({ runtime, agentId: "writer" });
    const result = await writer.reviseSection({
      projectId: "p-abc",
      section: SECTION,
      outline: OUTLINE,
      currentLatex: "\\section{实验}\n旧内容。",
      issues: [
        { category: "fact", severity: "major", section: "experiments", description: "论断缺证据", blocking: false },
      ],
      evidence: EVIDENCE_S1,
      bibliography: BIB,
    });
    expect(result.latex).not.toContain("PT-OUTCOMES");
    expect(result.latex).not.toContain("instructionId");
    expect(result.latex).toContain("901.5");
    // 无外部意见派发 → 不产出 outcomes
    expect(result.externalOutcomes).toBeUndefined();
    // 派发过外部意见时：合法报告行仍走 splitExternalOutcomes（协议分离 + unreported 兜底）
    const dispatchedRuntime = new FakeRuntime(() =>
      completedTask("\\section{实验}\n改写。\n%%%PT-OUTCOMES%%% [{\"instructionId\":\"x-1\",\"outcome\":\"applied\"}]"),
    );
    const dispatched = await new WriterService({ runtime: dispatchedRuntime, agentId: "writer" }).reviseSection({
      projectId: "p-abc",
      section: SECTION,
      outline: OUTLINE,
      currentLatex: "\\section{实验}\n旧内容。",
      issues: [],
      evidence: EVIDENCE_S1,
      bibliography: BIB,
      externalDirectives: [
        { instructionId: "x-1", source: "journal_reviewer", reviewerLabel: "Reviewer 2", text: "补充引用" },
      ],
    });
    expect(dispatched.latex).not.toContain("PT-OUTCOMES");
    expect(dispatched.externalOutcomes).toEqual([
      { instructionId: "x-1", outcome: "applied" },
    ]);
  });

  it("planOutline：大纲 prompt 同步分组（规划阶段向证据倾斜）", async () => {
    const runtime = new FakeRuntime(() =>
      completedTask(
        '{"title":"T","abstract":"A","sections":[' +
          '{"id":"introduction","file":"introduction.tex","title":"引言"},' +
          '{"id":"method","file":"method.tex","title":"方法"},' +
          '{"id":"conclusion","file":"conclusion.tex","title":"结论"}],"references":[]}',
      ),
    );
    const writer = new WriterService({ runtime, agentId: "writer" });
    await writer.planOutline({
      projectId: "p-abc",
      researchDigest: {
        domainOverview: "领域",
        researchGaps: ["gap1"],
        potentialContributions: ["c1"],
      },
      evidence: EVIDENCE_S1,
      bibliography: BIB,
    });
    const prompt = runtime.calls[0]!.task;
    expect(prompt).toContain("正文写作时事实性论断必须取 A 组");
    expect(prompt).toContain("引用必须取自本组）：yao2023react");
    expect(prompt).toContain("Verified Evidence Context");
  });
});

describe("WriterService M9.7.6：大纲结构化输出修复（outline repair）", () => {
  const OUTLINE_ARGS = {
    projectId: "p-abc",
    researchDigest: { domainOverview: "o", researchGaps: ["g"], potentialContributions: ["c"] },
    evidence: [],
    bibliography: [],
  };
  const GOOD_OUTLINE = JSON.stringify({
    title: "T",
    sections: [
      { id: "introduction", file: "introduction.tex", title: "引言" },
      { id: "method", file: "method.tex", title: "方法" },
      { id: "conclusion", file: "conclusion.tex", title: "结论" },
    ],
  });

  it("首输出未过校验 → error-feedback 修复成功（保留内容，repair 诊断携带）", async () => {
    // 真实漂移形态（2026-09-24 GLM smoke）：字符串值内未转义 ASCII 引号 →
    // extractJsonObject 回退命中内层对象（title=结论、无 sections）→ 校验失败
    const drifted = JSON.stringify({
      id: "conclusion",
      file: "conclusion.tex",
      title: "结论",
      keyPoints: ["要点"],
    });
    let call = 0;
    const runtime = new FakeRuntime(() => completedTask(call++ === 0 ? drifted : GOOD_OUTLINE));
    const writer = new WriterService({ runtime, agentId: "writer" });
    const outline = await writer.planOutline(OUTLINE_ARGS);
    expect(outline.sections).toHaveLength(3);
    expect(outline.repair).toMatchObject({ attempts: 1 });
    expect(outline.repair?.errors[0]).toContain("sections 必须是至少 3 项的数组");
    // 修复 prompt：上一轮输出 + 校验错误 + 转义规则
    const repairPrompt = runtime.calls[1]!.task;
    expect(repairPrompt).toContain("你上一轮的大纲输出未通过结构化校验");
    expect(repairPrompt).toContain("未转义的 ASCII 双引号");
    expect(repairPrompt).toContain(drifted);
  });

  it("修复有界耗尽（≤2 次）→ 如实失败，不伪造默认结构", async () => {
    const bad = JSON.stringify({ title: "T", sections: [] });
    const runtime = new FakeRuntime(() => completedTask(bad));
    const writer = new WriterService({ runtime, agentId: "writer" });
    await expect(writer.planOutline(OUTLINE_ARGS)).rejects.toMatchObject({ code: "AGENT_RUN_FAILED" });
    expect(runtime.calls).toHaveLength(3); // original + 2 次修复
  });

  it("模型层失败（status=failed）不进修复循环（Stage transient 兜底）", async () => {
    const runtime = new FakeRuntime(() => ({ ...completedTask(""), status: "failed" as const, error: "provider down" }));
    const writer = new WriterService({ runtime, agentId: "writer" });
    await expect(writer.planOutline(OUTLINE_ARGS)).rejects.toMatchObject({ code: "AGENT_RUN_FAILED" });
    expect(runtime.calls).toHaveLength(1);
  });
});

describe("WriterService M9.7.6：Claim Discipline + Unsupported Claim Repair", () => {
  const SECTION = { id: "introduction", file: "introduction.tex", title: "引言" };
  const OUTLINE = { title: "RAG 综述", sections: [SECTION] };
  const EVIDENCE_S1 = [
    {
      id: "E001",
      claim: "ReAct 在 HotpotQA 上超越标准提示基线",
      quote: "ReAct outperforms standard prompting on HotpotQA",
      verificationStatus: "verified",
      supportStrength: "direct",
      source: { sourceId: "S001", title: "ReAct", year: 2023, doi: "10.1/react" },
      location: { chunk: "S001:SEC01:0001:a1b2c3d4e5", section: "3" },
      createdBy: "researcher",
      createdAt: "2026-09-23T00:00:00Z",
    },
  ] as unknown as EvidenceRecord[];
  const BIB = [
    { key: "yao2023react", title: "ReAct", year: 2023, doi: "10.1/react" },
    { key: "wei2022cot", title: "Chain-of-Thought", year: 2022 },
  ];
  const REPAIRS = [
    {
      claimId: "c-abc123def456",
      section: "sections/introduction.tex",
      claim: "ReAct 在所有 Agent benchmark 上都优于 Reflexion",
      verdict: "UNSUPPORTED" as const,
      candidates: [
        {
          evidenceId: "E001",
          claim: "ReAct 在 HotpotQA 上超越标准提示基线",
          quote: "ReAct outperforms standard prompting on HotpotQA",
          citationKey: "yao2023react",
        },
      ],
    },
  ];

  it("writeSection / reviseSection：事实性论断强度纪律注入（证据说什么写什么；无证据弱化/标注/删除）", async () => {
    const runtime = new FakeRuntime(() => completedTask("\\section{引言}\n内容。"));
    const writer = new WriterService({ runtime, agentId: "writer" });
    await writer.writeSection({
      projectId: "p-abc",
      section: SECTION,
      outline: OUTLINE,
      evidence: EVIDENCE_S1,
      bibliography: BIB,
    });
    const sectionPrompt = runtime.calls[0]!.task;
    expect(sectionPrompt).toContain("事实性论断强度纪律");
    expect(sectionPrompt).toContain("证据说什么写什么");
    expect(sectionPrompt).toContain("禁止凭模型记忆");

    await writer.reviseSection({
      projectId: "p-abc",
      section: SECTION,
      outline: OUTLINE,
      currentLatex: "\\section{引言}\n旧内容。",
      issues: [{ category: "fact", severity: "major", section: "introduction", description: "论断缺证据", blocking: false }],
      evidence: EVIDENCE_S1,
      bibliography: BIB,
    });
    const revisePrompt = runtime.calls[1]!.task;
    expect(revisePrompt).toContain("事实性论断强度纪律");
  });

  it("reviseSection：Claim Repair 块携带论断原文 / 候选证据 / 三动作规则；claimRepairs 单独即可触发调用", async () => {
    const runtime = new FakeRuntime(() => completedTask("\\section{引言}\n修订内容。"));
    const writer = new WriterService({ runtime, agentId: "writer" });
    await writer.reviseSection({
      projectId: "p-abc",
      section: SECTION,
      outline: OUTLINE,
      currentLatex: "\\section{引言}\nReAct 在所有 Agent benchmark 上都优于 Reflexion。",
      issues: [], // 无 issue / buildError / 外部意见：仅 claimRepairs 也要派发
      evidence: EVIDENCE_S1,
      bibliography: BIB,
      claimRepairs: REPAIRS,
    });
    expect(runtime.calls).toHaveLength(1); // 没有被 no-op 早退吞掉
    const prompt = runtime.calls[0]!.task;
    expect(prompt).toContain("Unsupported Claim Repair（证据感知修订；逐条处置）");
    expect(prompt).toContain("ReAct 在所有 Agent benchmark 上都优于 Reflexion");
    expect(prompt).toContain("[E001]（cite: yao2023react）");
    expect(prompt).toContain("ReAct outperforms standard prompting on HotpotQA");
    expect(prompt).toContain("1. SUPPORT");
    expect(prompt).toContain("2. WEAKEN");
    expect(prompt).toContain("3. REMOVE");
    // 修订红线（§8）：不得新增数字 / 年份 / 实验结果 / key / 未核验事实
    expect(prompt).toContain("不得为此新增数字、年份、实验结果、bibliography key 或任何未经核验的具体事实");
    // §5：Evidence ID 是内部 grounding contract，正文不得出现 [E###] 标记
    expect(prompt).toContain("正文不得出现 [E###] / [c-###] 之类证据标记");
    // M9.7.2 A/B 分组保持（不因 Repair 块移除）
    expect(prompt).toContain("按 verified evidence 支撑分组");
  });

  it("reviseSection：无候选证据的 claim → 明示只能 WEAKEN / REMOVE", async () => {
    const runtime = new FakeRuntime(() => completedTask("\\section{引言}\n弱化后的表述。"));
    const writer = new WriterService({ runtime, agentId: "writer" });
    await writer.reviseSection({
      projectId: "p-abc",
      section: SECTION,
      outline: OUTLINE,
      currentLatex: "\\section{引言}\n无证据论断。",
      issues: [{ category: "fact", severity: "critical", section: "introduction", description: "论断无证据", blocking: true }],
      evidence: [],
      bibliography: BIB,
      claimRepairs: [
        { claimId: "c-000000000000", section: "sections/introduction.tex", claim: "无证据论断", verdict: "UNSUPPORTED", candidates: [] },
      ],
    });
    const prompt = runtime.calls[0]!.task;
    expect(prompt).toContain("无足够相关的已核验证据：本条只能 WEAKEN 或 REMOVE");
  });

  it("reviseSection（摘要）：Repair 块同样注入", async () => {
    const runtime = new FakeRuntime(() => completedTask("修订后的摘要。"));
    const writer = new WriterService({ runtime, agentId: "writer" });
    await writer.reviseSection({
      projectId: "p-abc",
      section: { id: "abstract", file: "abstract", title: "摘要" },
      outline: OUTLINE,
      currentLatex: "旧摘要。",
      issues: [{ category: "fact", severity: "major", section: "abstract", description: "摘要论断无证据", blocking: false }],
      evidence: EVIDENCE_S1,
      bibliography: BIB,
      claimRepairs: [
        { ...REPAIRS[0]!, section: "abstract", candidates: [] },
      ],
    });
    const prompt = runtime.calls[0]!.task;
    expect(prompt).toContain("Unsupported Claim Repair");
    expect(prompt).toContain("只能 WEAKEN 或 REMOVE");
  });
});
