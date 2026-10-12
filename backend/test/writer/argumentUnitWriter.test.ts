/**
 * M13.7.10 Writer 侧契约测试：
 * - buildSectionPrompt / buildSurveySectionPrompt 未传 argument 时与旧版逐字节一致（旧调用兼容）；
 * - 传 argument 时注入 B2 任务块与上限长度行，LaTeX / 引用 / 图形规则行保持不变；
 * - framing 节 evidence 为空时 A 组空、B 组仍列出全部 key（背景引用能力保留）；
 * - compare 节 partial 命题进入「还不能判断」；
 * - Survey：白名单行、综合产物块、synthesis 投影不变，只多任务块；
 * - planOutline：Planner 输出的合法 argument 进入 Outline；非法部分丢弃不阻断；Survey 大纲忽略 evidenceIds；
 * - writeSection 透传 argument，并把 usage 带回。
 */
import { describe, expect, it } from "vitest";

import { WriterService, buildSectionPrompt, buildSurveySectionPrompt } from "../../src/writer/WriterService.js";
import { ARGUMENT_UNIT_BLOCK_HEADER, resolveArgumentUnits } from "../../src/writer/argumentUnit.js";
import { buildSurveySectionContext } from "../../src/survey/sectionContext.js";
import type { AgentRuntime, AgentTask, RunAgentInput } from "../../src/runtime/types.js";
import type { EvidenceRecord } from "../../src/evidence/EvidenceStore.js";
import type { Outline } from "../../src/manuscript/ManuscriptService.js";
import type { SurveyMatrixArtifact } from "../../src/survey/matrixTypes.js";
import type { SurveySynthesisArtifact } from "../../src/survey/synthesisTypes.js";

const NOW = "2026-10-12T00:00:00.000Z";

class FakeRuntime implements AgentRuntime {
  readonly provider = "pi" as const;
  readonly calls: RunAgentInput[] = [];
  constructor(private readonly output: () => string) {}
  healthCheck(): Promise<import("../../src/runtime/types.js").RuntimeHealth> {
    throw new Error("not needed");
  }
  async startAgent(input: RunAgentInput) {
    const task = await this.runAgent(input);
    return { taskId: task.taskId, sessionKey: "agent:writer:fake", events: async function* () {}, cancel: async () => {}, result: async () => task };
  }
  async runAgent(input: RunAgentInput): Promise<AgentTask> {
    this.calls.push(input);
    return {
      taskId: `run-${this.calls.length}`,
      agentId: input.agentId,
      status: "completed",
      createdAt: NOW,
      updatedAt: NOW,
      output: this.output(),
      usage: { input: 10, output: 5, cacheRead: 0, cacheWrite: 0, totalTokens: 15, assistantTurns: 1 } as unknown as AgentTask["usage"],
    };
  }
  getTask(): Promise<AgentTask> {
    throw new Error("not implemented");
  }
  async close(): Promise<void> {}
}

const OUTLINE: Outline = {
  title: "超导量子纠错实验综述",
  sections: [
    { id: "introduction", file: "introduction.tex", title: "引言", targetLengthWords: 350, keyPoints: ["界定范围"] },
    { id: "surface", file: "surface.tex", title: "表面码逻辑量子比特的规模扩展", targetLengthWords: 350, keyPoints: ["距离 5 码略优于距离 3 码"] },
    { id: "breakeven", file: "breakeven.tex", title: "突破盈亏平衡的逻辑量子比特实验", targetLengthWords: 350 },
    { id: "comparison", file: "comparison.tex", title: "综合比较与局限性", targetLengthWords: 350 },
    { id: "conclusion", file: "conclusion.tex", title: "结论与展望", targetLengthWords: 350 },
  ],
};

function record(id: string, claim: string, overrides: Partial<EvidenceRecord> = {}): EvidenceRecord {
  return {
    id,
    claim,
    quote: claim,
    source: { sourceId: "S001", title: "Suppressing quantum errors by scaling a surface code logical qubit", year: 2022 },
    location: { chunk: `S001:abstract:${id}` },
    verificationStatus: "verified",
    supportStrength: "direct",
    verificationLevel: "abstract",
    createdBy: "test",
    createdAt: NOW,
    ...overrides,
  };
}
const EVIDENCE = [
  record("E001", "距离 5 码略优于距离 3 码集合"),
  record("E002", "表面码已达到大规模容错所需错误率", { supportStrength: "partial" }),
];
const BIB = [
  { key: "acharya2022surface", sourceId: "S001", title: "Suppressing quantum errors by scaling a surface code logical qubit", year: 2022 },
  { key: "sivak2022breakeven", sourceId: "S002", title: "Real-time quantum error correction beyond break-even", year: 2022 },
];

describe("buildSectionPrompt × 论证单元", () => {
  it("未传 argument：与旧版 prompt 逐字节一致（含「约 N 字」）", () => {
    const prompt = buildSectionPrompt({ section: OUTLINE.sections[1]!, outline: OUTLINE, evidence: EVIDENCE, bibliography: BIB });
    expect(prompt).toContain("目标长度：约 350 字");
    expect(prompt).not.toContain(ARGUMENT_UNIT_BLOCK_HEADER);
    expect(prompt).not.toContain("跨章节约定");
  });

  it("传 argument：任务块 + 上限长度行；输出 / 引用 / 图形规则不变；partial 命题进入 compare 任务", () => {
    const units = resolveArgumentUnits({ outline: OUTLINE });
    const base = buildSectionPrompt({ section: OUTLINE.sections[1]!, outline: OUTLINE, evidence: EVIDENCE, bibliography: BIB });
    const prompt = buildSectionPrompt({ section: OUTLINE.sections[1]!, outline: OUTLINE, evidence: EVIDENCE, bibliography: BIB, argument: units[1]! });
    expect(prompt).toContain("目标长度：不超过 350 字（上限参考，不是配额）");
    expect(prompt).toContain(ARGUMENT_UNIT_BLOCK_HEADER);
    expect(prompt).toContain("角色：develop（");
    expect(prompt).toContain("这是全文唯一完整解释「表面码逻辑量子比特的规模扩展」");
    expect(prompt).toContain("- 「突破盈亏平衡的逻辑量子比特实验」所负责的机制、结果与数值细节");
    expect(prompt).toContain("跨章节约定：");
    expect(prompt).toContain("长度口径：");
    expect(prompt).not.toMatch(/见「[^」]+」一节/);
    // 规则行逐条保留
    for (const line of base.split("\n")) {
      if (line.startsWith("目标长度：")) continue;
      expect(prompt).toContain(line);
    }
    // Evidence 块与 A/B 分组仍在
    expect(prompt).toContain("Verified Evidence Context（已核验 verified 证据，引用第一优先来源）");
    expect(prompt).toContain("A 组（有 verified evidence 支撑");
    const compare = buildSectionPrompt({
      section: OUTLINE.sections[3]!,
      outline: OUTLINE,
      evidence: EVIDENCE,
      bibliography: BIB,
      argument: units[3]!,
      argumentPartialClaims: EVIDENCE.filter((r) => r.supportStrength === "partial").map((r) => r.claim),
    });
    expect(compare).toContain("目前证据还不能判断（partial 证据的待核验命题，不得写成事实）：");
    expect(compare).toContain("- 表面码已达到大规模容错所需错误率");
  });

  it("framing 节 evidence 为空：A 组空提示、B 组仍列出全部 key（背景引用能力保留）；任务块说明不是证据缺失", () => {
    const units = resolveArgumentUnits({ outline: OUTLINE });
    const prompt = buildSectionPrompt({ section: OUTLINE.sections[0]!, outline: OUTLINE, evidence: [], bibliography: BIB, argument: units[0]! });
    expect(prompt).toContain("A 组（有 verified evidence 支撑）：（空");
    expect(prompt).toContain("acharya2022surface, sivak2022breakeven");
    expect(prompt).toContain("目标长度：不超过 260 字");
    expect(prompt).toContain("本节不注入正式 Evidence 是分工安排，不是证据缺失");
    expect(prompt).not.toContain("本节可用正式证据只有");
    // 文献身份表：framing 有，develop 无
    expect(prompt).toContain("===== 文献身份（只用于按标题点名代表工作");
    expect(prompt).toContain("- sivak2022breakeven：Real-time quantum error correction beyond break-even（2022）");
    const develop = buildSectionPrompt({ section: OUTLINE.sections[1]!, outline: OUTLINE, evidence: EVIDENCE, bibliography: BIB, argument: units[1]! });
    expect(develop).not.toContain("===== 文献身份");
  });
});

const MATRIX: SurveyMatrixArtifact = {
  schemaVersion: 1,
  updatedAt: NOW,
  taxonomy: { families: [{ label: "surface_code", description: "表面码" }] },
  entries: [
    { entryId: "M-S001", sourceId: "S001", interpretationDepth: "abstract_only", methodFamily: "surface_code", anchors: [], status: "confirmed", updatedAt: NOW },
    { entryId: "M-S002", sourceId: "S002", interpretationDepth: "abstract_only", methodFamily: "surface_code", anchors: [], status: "confirmed", updatedAt: NOW },
  ],
};
const SYNTHESIS: SurveySynthesisArtifact = {
  schemaVersion: 1,
  updatedAt: NOW,
  matrixFingerprint: "fp",
  items: [
    {
      synthesisId: "SYN-cmp0000001",
      kind: "comparison",
      claim: "两条路线在指标口径上不可直接比较",
      groundingLevel: "evidence_backed",
      evidenceIds: ["E001"],
      sourceIds: ["S001", "S002"],
      derivedFrom: { entryIds: ["M-S001", "M-S002"] },
      detail: { kind: "comparison", dimension: "metric convention", sides: [] },
      updatedAt: NOW,
    },
  ],
};

describe("buildSurveySectionPrompt × 论证单元", () => {
  const outline: Outline = {
    ...OUTLINE,
    sections: OUTLINE.sections.map((section) =>
      section.id === "comparison" ? { ...section, synthesisRefs: ["SYN-cmp0000001"], literatureRefs: ["M-S001", "M-S002"] } : section,
    ),
  };
  const section = outline.sections[3]!;
  const context = buildSurveySectionContext({ section, matrix: MATRIX, synthesis: SYNTHESIS, bibliography: BIB, evidence: EVIDENCE });

  it("未传 argument：旧 prompt 逐字节不变；传 argument：只多任务块 + 上限行，白名单 / 综合产物 / 投影不变", () => {
    const base = buildSurveySectionPrompt({ section, outline, bibliography: BIB, survey: context });
    expect(base).toContain("目标长度：约 350 字");
    expect(base).not.toContain(ARGUMENT_UNIT_BLOCK_HEADER);
    const units = resolveArgumentUnits({ outline, synthesis: SYNTHESIS });
    const unit = units[3]!;
    expect(unit.role).toBe("compare");
    const prompt = buildSurveySectionPrompt({ section, outline, bibliography: BIB, survey: context, argument: unit });
    expect(prompt).toContain("目标长度：不超过 350 字（上限参考，不是配额）");
    expect(prompt).toContain("角色：compare（");
    expect(prompt).toContain("「metric convention」");
    expect(prompt).toContain("全部允许（\\cite 只能用这些 key）：acharya2022surface, sivak2022breakeven");
    expect(prompt).toContain("[SYN-cmp0000001]（comparison｜grounding=evidence_backed");
    for (const line of base.split("\n")) {
      if (line.startsWith("目标长度：")) continue;
      expect(prompt).toContain(line);
    }
    // Survey 的证据来自 refs 投影：不渲染 develop 短写提示
    expect(prompt).not.toContain("本节可用正式证据只有");
    // framing（无 refs → 白名单 = 整个 bibliography）：文献身份表只列白名单内 key
    const intro = outline.sections[0]!;
    const introContext = buildSurveySectionContext({ section: intro, matrix: MATRIX, synthesis: SYNTHESIS, bibliography: BIB, evidence: EVIDENCE });
    const introPrompt = buildSurveySectionPrompt({ section: intro, outline, bibliography: BIB, survey: introContext, argument: units[0]! });
    expect(introPrompt).toContain("===== 文献身份（只用于按标题点名代表工作");
    expect(introPrompt).toContain("- acharya2022surface：Suppressing quantum errors by scaling a surface code logical qubit（2022）");
    expect(prompt).not.toContain("===== 文献身份");
  });
});

describe("WriterService × 论证单元", () => {
  it("writeSection 透传 argument 并返回 usage；Survey 引用白名单后检不受任务块影响", async () => {
    const runtime = new FakeRuntime(() => "\\section{综合比较与局限性}\n两条路线不可直接比较 \\cite{acharya2022surface}。");
    const writer = new WriterService({ runtime, agentId: "writer" });
    const units = resolveArgumentUnits({ outline: OUTLINE });
    const result = await writer.writeSection({ projectId: "p", section: OUTLINE.sections[3]!, outline: OUTLINE, evidence: EVIDENCE, bibliography: BIB, argument: units[3]! });
    expect(runtime.calls[0]!.task).toContain(ARGUMENT_UNIT_BLOCK_HEADER);
    expect(result.usage).toBeDefined();
    const outline: Outline = {
      ...OUTLINE,
      sections: OUTLINE.sections.map((section) => (section.id === "comparison" ? { ...section, synthesisRefs: ["SYN-cmp0000001"] } : section)),
    };
    const context = buildSurveySectionContext({ section: outline.sections[3]!, matrix: MATRIX, synthesis: SYNTHESIS, bibliography: BIB, evidence: EVIDENCE });
    const ghost = new FakeRuntime(() => "\\section{综合比较}\n越界 \\cite{ghost2099}。");
    const surveyWriter = new WriterService({ runtime: ghost, agentId: "writer" });
    await expect(
      surveyWriter.writeSection({ projectId: "p", section: outline.sections[3]!, outline, evidence: context.evidence, bibliography: BIB, survey: context, argument: resolveArgumentUnits({ outline, synthesis: SYNTHESIS })[3]! }),
    ).rejects.toThrow(/ghost2099/);
  });

  it("planOutline：合法 argument 进入 Outline；非法 role / 非 canonical evidenceIds 丢弃不阻断", async () => {
    const planned = {
      title: "T",
      abstract: "A",
      sections: [
        { id: "introduction", file: "introduction.tex", title: "引言", targetLengthWords: 300, keyPoints: ["动机"], argument: { role: "framing" } },
        { id: "method", file: "method.tex", title: "方法", targetLengthWords: 400, argument: { role: "develop", evidenceIds: ["E001", "the surface code paper"] } },
        { id: "exp", file: "exp.tex", title: "实验", argument: { role: "owner", task: 12 } },
        { id: "conclusion", file: "conclusion.tex", title: "结论" },
      ],
    };
    const runtime = new FakeRuntime(() => JSON.stringify(planned));
    const logs: string[] = [];
    const writer = new WriterService({ runtime, agentId: "writer", log: (line) => logs.push(line) });
    const outline = await writer.planOutline({
      projectId: "p",
      researchDigest: { domainOverview: "x", researchGaps: [], potentialContributions: [] },
      evidence: EVIDENCE,
      bibliography: BIB,
    });
    expect(outline.sections[0]!.argument).toEqual({ role: "framing" });
    expect(outline.sections[1]!.argument).toEqual({ role: "develop", evidenceIds: ["E001"] });
    expect(outline.sections[2]!.argument).toBeUndefined();
    expect(outline.sections[3]!.argument).toBeUndefined();
    expect(logs.some((line) => line.includes("argument 可选字段部分无效"))).toBe(true);
    expect(runtime.calls[0]!.task).toContain('"argument": {"role": "framing", "evidenceIds": ["E001"]}');
    expect(runtime.calls[0]!.task).toContain("2a. argument 为可选字段");
  });

  it("planOutline（Survey）：忽略 evidenceIds，保留 role；prompt 说明不要输出 evidenceIds", async () => {
    const planned = {
      title: "综述",
      sections: [
        { id: "introduction", file: "introduction.tex", title: "引言" },
        { id: "core", file: "core.tex", title: "方法体系", synthesisRefs: ["SYN-cmp0000001"], literatureRefs: ["M-S001"], argument: { role: "compare", evidenceIds: ["E001"] } },
        { id: "gap", file: "gap.tex", title: "研究空缺", synthesisRefs: ["SYN-cmp0000001"] },
        { id: "conclusion", file: "conclusion.tex", title: "结论" },
      ],
    };
    const runtime = new FakeRuntime(() => JSON.stringify(planned));
    const writer = new WriterService({ runtime, agentId: "writer" });
    const outline = await writer.planOutline({
      projectId: "p",
      evidence: [],
      bibliography: [],
      surveyDigest: {
        topic: "t",
        items: [],
        literature: [],
        truncatedSpeculative: 0,
        stats: {
          totalEntries: 1,
          fulltext: 0,
          abstractOnly: 1,
          unclassified: 0,
          familyDistribution: [{ label: "surface_code", count: 1 }],
          yearDistribution: [],
          groundingDistribution: { evidence_backed: 0, literature_cited: 0, speculative: 0 },
        },
      },
    });
    expect(outline.sections[1]!.argument).toEqual({ role: "compare" });
    expect(runtime.calls[0]!.task).toContain("不要输出 evidenceIds");
  });
});
