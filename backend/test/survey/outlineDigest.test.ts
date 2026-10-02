/**
 * M11.1.3 Survey Outline digest 与 planner prompt 测试：
 * 投影纯函数（确定性 / claim 截断 / speculative 截断 / 统计）、
 * WriterService survey 分支（prompt 契约 / refs 解析归一 / 普通路径不受影响）。
 */

import { describe, expect, it } from "vitest";

import {
  DIGEST_CLAIM_LIMIT,
  buildSurveyOutlineDigest,
  renderDigestItems,
  renderDigestLiterature,
  renderDigestStats,
} from "../../src/survey/outlineDigest.js";
import type { SurveyMatrixArtifact, SurveyMatrixEntry } from "../../src/survey/matrixTypes.js";
import type { SurveySynthesisArtifact, SurveySynthesisItem } from "../../src/survey/synthesisTypes.js";
import { WriterService, buildSurveyOutlinePrompt } from "../../src/writer/WriterService.js";
import type { AgentRuntime, AgentTask } from "../../src/runtime/types.js";

function matrixEntry(entryId: string, overrides: Partial<SurveyMatrixEntry> = {}): SurveyMatrixEntry {
  return {
    entryId,
    sourceId: entryId.replace(/^M-/, ""),
    interpretationDepth: "fulltext",
    anchors: [],
    status: "draft",
    updatedAt: "2026-10-03T00:00:00.000Z",
    methodFamily: "tracking_association",
    ...overrides,
  };
}

function matrixArtifact(entries: SurveyMatrixEntry[]): SurveyMatrixArtifact {
  return {
    schemaVersion: 1,
    updatedAt: "2026-10-03T00:00:00.000Z",
    taxonomy: {
      families: [
        {
          label: "tracking_association",
          description: "关联",
          subFamilies: ["motion_based", "appearance_based", "joint"],
        },
        { label: "re_identification", description: "重识别" },
      ],
    },
    entries,
  };
}

function synthesisItem(
  synthesisId: string,
  kind: SurveySynthesisItem["kind"],
  groundingLevel: SurveySynthesisItem["groundingLevel"],
  claim = "测试综合陈述",
): SurveySynthesisItem {
  return {
    synthesisId,
    kind,
    claim,
    groundingLevel,
    evidenceIds: [],
    sourceIds: ["S001", "S002"],
    derivedFrom: { entryIds: ["M-S001", "M-S002"] },
    updatedAt: "2026-10-03T00:00:00.000Z",
  };
}

function buildFixture(): { matrix: SurveyMatrixArtifact; synthesis: SurveySynthesisArtifact } {
  return {
    matrix: matrixArtifact([
      matrixEntry("M-S001", { subFamily: "motion_based" }),
      matrixEntry("M-S002", { subFamily: "appearance_based" }),
      matrixEntry("M-S003", { interpretationDepth: "abstract_only", methodFamily: undefined }),
    ]),
    synthesis: {
      schemaVersion: 1,
      updatedAt: "2026-10-03T00:00:00.000Z",
      matrixFingerprint: "f",
      items: [
        synthesisItem("SYN-aaaaaaaaaa", "taxonomy", "literature_cited"),
        synthesisItem("SYN-bbbbbbbbbb", "trend", "evidence_backed"),
        synthesisItem("SYN-cccccccccc", "future_direction", "speculative"),
      ],
    },
  };
}

describe("buildSurveyOutlineDigest", () => {
  it("投影 synthesis items（升序）与文献清单（升序）；claim 截断", () => {
    const { matrix, synthesis } = buildFixture();
    const longClaim = "很长的陈述".repeat(100);
    const withLong = synthesisArtifactOverride(synthesis, [
      synthesisItem("SYN-longclaim0", "trend", "evidence_backed", longClaim),
    ]);
    const digest = buildSurveyOutlineDigest(matrix, withLong, {
      topic: "MOT 综述",
      yearBySource: new Map([["S001", 2022]]),
      titleBySource: new Map([["S001", "ByteTrack"]]),
    });
    expect(digest.items.map((item) => item.synthesisId)).toEqual(["SYN-longclaim0"]);
    expect(digest.items[0]!.claim.length).toBeLessThanOrEqual(DIGEST_CLAIM_LIMIT);
    expect(digest.literature.map((item) => item.entryId)).toEqual(["M-S001", "M-S002", "M-S003"]);
    expect(digest.literature[0]).toMatchObject({ year: 2022, title: "ByteTrack" });
    expect(digest.stats).toMatchObject({
      totalEntries: 3,
      fulltext: 2,
      abstractOnly: 1,
      unclassified: 1,
    });
    expect(digest.stats.familyDistribution).toContainEqual({
      label: "tracking_association",
      count: 2,
      subFamilies: [
        { label: "motion_based", count: 1 },
        { label: "appearance_based", count: 1 },
        { label: "joint", count: 0 },
      ],
    });
    expect(digest.stats.groundingDistribution).toEqual({
      evidence_backed: 1,
      literature_cited: 0,
      speculative: 0,
    });
  });

  it("同输入恒同 digest（确定性；无时钟 / 随机）", () => {
    const { matrix, synthesis } = buildFixture();
    const meta = { topic: "MOT 综述" };
    const first = buildSurveyOutlineDigest(matrix, synthesis, meta);
    const second = buildSurveyOutlineDigest(matrix, synthesis, meta);
    expect(first).toEqual(second);
  });

  it("speculative 超上限截断并如实计数；evidence_backed / literature_cited 全保留", () => {
    const { matrix } = buildFixture();
    const items: SurveySynthesisItem[] = [
      synthesisItem("SYN-aaaaaaaaaa", "taxonomy", "literature_cited"),
      synthesisItem("SYN-bbbbbbbbbb", "trend", "evidence_backed"),
      ...Array.from({ length: 200 }, (_, index) =>
        synthesisItem(`SYN-spec${String(index).padStart(3, "0")}`.slice(0, 14), "future_direction", "speculative"),
      ),
    ];
    const digest = buildSurveyOutlineDigest(matrix, synthesisArtifactOverride(buildFixture().synthesis, items), {
      topic: "t",
    });
    expect(digest.items.length).toBeLessThanOrEqual(150);
    expect(digest.items.filter((item) => item.groundingLevel !== "speculative")).toHaveLength(2);
    expect(digest.truncatedSpeculative).toBe(200 - (150 - 2));
  });

  it("渲染：kind 分组 + 空 kind 显式「无」+ 文献清单 + 统计（含 abstract_only 提示）", () => {
    const { matrix, synthesis } = buildFixture();
    const digest = buildSurveyOutlineDigest(matrix, synthesis, { topic: "MOT 综述" });
    const itemsText = renderDigestItems(digest).join("\n");
    expect(itemsText).toContain("[SYN-aaaaaaaaaa] grounding=literature_cited");
    expect(itemsText).toContain("taxonomy（方法分类骨架）（1 条）");
    expect(itemsText).toContain("comparison（跨方法比较）：无");
    const literatureText = renderDigestLiterature(digest).join("\n");
    expect(literatureText).toContain("- M-S001｜深度=fulltext｜家族=tracking_association/motion_based");
    expect(literatureText).toContain("- M-S003｜深度=abstract_only｜家族=unclassified");
    const statsText = renderDigestStats(digest).join("\n");
    expect(statsText).toContain("fulltext 2 / abstract_only 1");
    expect(statsText).toContain("unclassified: 1 篇");

    // abstract_only 占比过半（≥4 篇）时给出弱信息提示
    const heavy = buildSurveyOutlineDigest(
      matrixArtifact([
        matrixEntry("M-S001"),
        matrixEntry("M-S002", { interpretationDepth: "abstract_only" }),
        matrixEntry("M-S003", { interpretationDepth: "abstract_only", methodFamily: undefined }),
        matrixEntry("M-S004", { interpretationDepth: "abstract_only" }),
      ]),
      synthesis,
      { topic: "MOT 综述" },
    );
    expect(renderDigestStats(heavy).join("\n")).toContain("abstract_only 占比过半");
  });
});

function synthesisArtifactOverride(
  base: SurveySynthesisArtifact,
  items: SurveySynthesisItem[],
): SurveySynthesisArtifact {
  return { ...base, items };
}

// ---- WriterService survey 分支 ----

class FakeRuntime implements AgentRuntime {
  readonly provider = "pi" as const;
  readonly calls: { task: string; contextScope?: string; metadata?: Record<string, unknown> }[] = [];
  private output: () => string;

  constructor(output: () => string) {
    this.output = output;
  }

  healthCheck: AgentRuntime["healthCheck"] = async () => ({
    ok: true,
    provider: "pi",
    status: "healthy",
    detail: "outline digest test",
    latencyMs: 1,
    checkedAt: new Date().toISOString(),
  });

  async startAgent(input: Parameters<AgentRuntime["startAgent"]>[0]) {
    const task = await this.runAgent(input);
    return {
      taskId: task.taskId,
      sessionKey: "k",
      events: async function* () {},
      cancel: async () => {},
      result: async () => task,
    };
  }

  async runAgent(input: Parameters<AgentRuntime["runAgent"]>[0]): Promise<AgentTask> {
    this.calls.push({ task: input.task, contextScope: input.contextScope, metadata: input.metadata });
    const now = new Date().toISOString();
    return {
      taskId: `digest-${this.calls.length}`,
      agentId: input.agentId,
      status: "completed",
      createdAt: now,
      updatedAt: now,
      output: this.output(),
    };
  }

  getTask: AgentRuntime["getTask"] = async () => {
    throw new Error("not implemented");
  };
  modelStatusSnapshot: AgentRuntime["modelStatusSnapshot"] = async () => ({
    phase: "unknown" as const,
    providers: [],
    detail: "fixture",
  });
  runtimeStats: AgentRuntime["runtimeStats"] = () => ({ activeRuns: 0, managedSessions: 0 });
  close: AgentRuntime["close"] = async () => {};
}

function digestForPrompt() {
  const { matrix, synthesis } = buildFixture();
  return buildSurveyOutlineDigest(matrix, synthesis, { topic: "多目标跟踪数据关联综述" });
}

describe("WriterService planOutline survey 分支", () => {
  it("buildSurveyOutlinePrompt：综述语义（不要求创新点/实验）、digest 三区块、refs 契约", () => {
    const prompt = buildSurveyOutlinePrompt({
      surveyDigest: digestForPrompt(),
      targetProfile: "ccf-b",
      language: "zh",
    });
    expect(prompt).toContain("综述（survey / review article）");
    expect(prompt).toContain("按方法体系 / 研究问题组织");
    expect(prompt).toContain("synthesisRefs");
    expect(prompt).toContain("literatureRefs");
    expect(prompt).toContain("综合产物 digest");
    expect(prompt).toContain("文献清单");
    expect(prompt).toContain("覆盖与分布统计");
    expect(prompt).toContain("[SYN-aaaaaaaaaa]");
    expect(prompt).toContain("- M-S001｜");
    expect(prompt).toContain("speculative");
    // 不出现普通论文大纲的 researchDigest 行（研究空白 / 潜在贡献字段）；
    // 禁令措辞（「不要求潜在贡献」）允许出现
    expect(prompt).not.toContain("潜在贡献：");
    expect(prompt).not.toContain("研究空白：");
  });

  it("survey 模式：解析 refs（去重 + 排序）；metadata 携带 outlineProfile=survey", async () => {
    const output = JSON.stringify({
      title: "测试综述",
      sections: [
        { id: "introduction", file: "introduction.tex", title: "引言" },
        {
          id: "taxonomy",
          file: "taxonomy.tex",
          title: "方法分类",
          synthesisRefs: ["SYN-bbbbbbbbbb", "SYN-aaaaaaaaaa", "SYN-aaaaaaaaaa"],
          literatureRefs: ["M-S002", "M-S001", "M-S002"],
        },
        { id: "conclusion", file: "conclusion.tex", title: "结论" },
      ],
    });
    const runtime = new FakeRuntime(() => output);
    const writer = new WriterService({ runtime: runtime as never, agentId: "writer" });
    const outline = await writer.planOutline({
      projectId: "p-1",
      evidence: [],
      bibliography: [],
      surveyDigest: digestForPrompt(),
    });
    expect(runtime.calls[0]!.metadata).toMatchObject({ outlineProfile: "survey" });
    const taxonomy = outline.sections.find((section) => section.id === "taxonomy")!;
    expect(taxonomy.synthesisRefs).toEqual(["SYN-aaaaaaaaaa", "SYN-bbbbbbbbbb"]);
    expect(taxonomy.literatureRefs).toEqual(["M-S001", "M-S002"]);
    // 无 refs 的 section 不携带空数组
    expect(outline.sections[0]!.synthesisRefs).toBeUndefined();
  });

  it("普通论文路径（无 surveyDigest）：refs 字段不解析（模型即使输出也被忽略）", async () => {
    const output = JSON.stringify({
      title: "原创论文",
      sections: [
        { id: "introduction", file: "introduction.tex", title: "引言", synthesisRefs: ["SYN-aaaaaaaaaa"] },
        { id: "method", file: "method.tex", title: "方法" },
        { id: "conclusion", file: "conclusion.tex", title: "结论" },
      ],
    });
    const runtime = new FakeRuntime(() => output);
    const writer = new WriterService({ runtime: runtime as never, agentId: "writer" });
    const outline = await writer.planOutline({
      projectId: "p-1",
      researchDigest: { domainOverview: "d", researchGaps: ["g"], potentialContributions: ["c"] },
      evidence: [],
      bibliography: [],
    });
    expect(runtime.calls[0]!.metadata).not.toHaveProperty("outlineProfile");
    expect(outline.sections[0]!.synthesisRefs).toBeUndefined();
  });

  it("两个 digest 都缺 → 明确报错（调用契约）", async () => {
    const runtime = new FakeRuntime(() => "{}");
    const writer = new WriterService({ runtime: runtime as never, agentId: "writer" });
    await expect(
      writer.planOutline({ projectId: "p-1", evidence: [], bibliography: [] }),
    ).rejects.toMatchObject({ code: "AGENT_RUN_FAILED" });
    expect(runtime.calls).toHaveLength(0);
  });
});
