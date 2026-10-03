/**
 * Writer Survey 模式测试（M11.2 §二十二-2）。
 *
 * 覆盖：survey prompt 分支（纪律条款 / 有界上下文 / 白名单）、多源引用候选、
 * fake citation key 后检 fail-closed、普通论文路径 backward compatibility、
 * reviseSection 的综述结构红线块。
 */

import { describe, expect, it } from "vitest";

import { InvalidLatexOutputError } from "../../src/errors.js";
import type { AgentRuntime, AgentTask } from "../../src/runtime/types.js";
import {
  WriterService,
  buildSurveySectionPrompt,
} from "../../src/writer/WriterService.js";
import { buildSurveySectionContext } from "../../src/survey/sectionContext.js";
import type { SurveyMatrixArtifact } from "../../src/survey/matrixTypes.js";
import type { SurveySynthesisArtifact, SurveySynthesisItem } from "../../src/survey/synthesisTypes.js";
import type { EvidenceRecord } from "../../src/evidence/EvidenceStore.js";

class FakeRuntime implements AgentRuntime {
  readonly provider = "pi" as const;
  readonly tasks: string[] = [];
  constructor(private readonly result: () => AgentTask) {}
  healthCheck(): Promise<import("../../src/runtime/types.js").RuntimeHealth> {
    throw new Error("not needed");
  }
  async startAgent(input: import("../../src/runtime/types.js").RunAgentInput) {
    const task = await this.runAgent(input);
    return {
      taskId: task.taskId,
      sessionKey: `agent:${input.agentId}:fake`,
      events: async function* () {},
      cancel: async () => {},
      result: async () => task,
    };
  }
  async runAgent(input: import("../../src/runtime/types.js").RunAgentInput): Promise<AgentTask> {
    this.tasks.push(input.task);
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
  return { taskId: "run-w1", agentId: "writer", status: "completed", createdAt: now, updatedAt: now, output };
}

const NOW = "2026-10-03T00:00:00.000Z";

const MATRIX: SurveyMatrixArtifact = {
  schemaVersion: 1,
  updatedAt: NOW,
  taxonomy: { families: [{ label: "tracking_association", description: "跟踪关联" }] },
  entries: ["S-a", "S-b"].map((sourceId) => ({
    entryId: `M-${sourceId}`,
    sourceId,
    interpretationDepth: "fulltext" as const,
    methodFamily: "tracking_association",
    anchors: [],
    status: "confirmed" as const,
    updatedAt: NOW,
  })),
};

function synItem(
  id: string,
  kind: SurveySynthesisItem["kind"],
  grounding: SurveySynthesisItem["groundingLevel"],
  sourceIds: string[],
  evidenceIds: string[] = [],
): SurveySynthesisItem {
  return {
    synthesisId: id,
    kind,
    claim: `综合结论 ${id}`,
    groundingLevel: grounding,
    evidenceIds,
    sourceIds,
    derivedFrom: { entryIds: sourceIds.map((sourceId) => `M-${sourceId}`) },
    updatedAt: NOW,
  };
}

const SYNTHESIS: SurveySynthesisArtifact = {
  schemaVersion: 1,
  updatedAt: NOW,
  matrixFingerprint: "fp",
  items: [
    synItem("SYN-aaaaaaaaaa", "consensus", "evidence_backed", ["S-a", "S-b"], ["E1"]),
    synItem("SYN-bbbbbbbbbb", "future_direction", "speculative", ["S-b"]),
  ],
};

const EVIDENCE: EvidenceRecord[] = [
  {
    id: "E1",
    claim: "E1 的核验断言",
    source: { sourceId: "S-a", title: "Method A" },
    location: { chunk: "c1" },
    verificationStatus: "verified",
    supportStrength: "direct",
    createdBy: "test",
    createdAt: NOW,
  },
];

const BIB = [
  { key: "a2021method", sourceId: "S-a", title: "Method A" },
  { key: "b2022method", sourceId: "S-b", title: "Method B" },
];

function coreContext() {
  return buildSurveySectionContext({
    section: {
      id: "association",
      file: "association.tex",
      title: "数据关联方法",
      synthesisRefs: ["SYN-aaaaaaaaaa"],
      literatureRefs: ["M-S-a", "M-S-b"],
    },
    matrix: MATRIX,
    synthesis: SYNTHESIS,
    bibliography: BIB,
    evidence: EVIDENCE,
  });
}

describe("buildSurveySectionPrompt", () => {
  it("包含综述纪律 / 有界综合产物 / 引用白名单（A/B 组 + 全部允许行）", () => {
    const prompt = buildSurveySectionPrompt({
      section: {
        id: "association",
        file: "association.tex",
        title: "数据关联方法",
        synthesisRefs: ["SYN-aaaaaaaaaa"],
      },
      outline: { title: "测试综述", sections: [] },
      bibliography: BIB,
      survey: coreContext(),
    });
    expect(prompt).toContain("综述写作纪律");
    expect(prompt).toContain("按 synthesis 组织段落");
    expect(prompt).toContain("research gap 只能来自");
    expect(prompt).toContain("不发明 taxonomy / 共识 / 分歧 / 研究空缺 / 未来方向");
    expect(prompt).toContain("[SYN-aaaaaaaaaa]");
    expect(prompt).toContain("grounding=evidence_backed");
    expect(prompt).toContain("A 组（有 verified evidence 支撑");
    expect(prompt).toContain("全部允许（\\cite 只能用这些 key）：a2021method, b2022method");
    expect(prompt).toContain("多 key 并列");
  });

  it("speculative synthesis 的措辞纪律进入 prompt", () => {
    const context = buildSurveySectionContext({
      section: {
        id: "future",
        file: "future-directions.tex",
        title: "未来方向与展望",
        synthesisRefs: ["SYN-bbbbbbbbbb"],
      },
      matrix: MATRIX,
      synthesis: SYNTHESIS,
      bibliography: BIB,
      evidence: EVIDENCE,
    });
    const prompt = buildSurveySectionPrompt({
      section: { id: "future", file: "future-directions.tex", title: "未来方向与展望" },
      outline: { title: "t", sections: [] },
      bibliography: BIB,
      survey: context,
    });
    expect(prompt).toContain("grounding=speculative");
    expect(prompt).toContain("展望章节（唯一允许消费 speculative synthesis 的章节）");
  });
});

describe("WriterService.writeSection survey 模式", () => {
  const outline = {
    title: "测试综述",
    sections: [{ id: "association", file: "association.tex", title: "数据关联方法" }],
  };

  it("白名单内引用通过；fake key 越界 fail-closed（InvalidLatexOutputError）", async () => {
    const ok = new FakeRuntime(() =>
      completedTask("\\section{数据关联方法}\n\n综合结论 \\cite{a2021method,b2022method}。"),
    );
    const writer = new WriterService({ runtime: ok, agentId: "writer" });
    const result = await writer.writeSection({
      projectId: "p1",
      section: outline.sections[0]!,
      outline,
      evidence: EVIDENCE,
      bibliography: BIB,
      survey: coreContext(),
    });
    expect(result.latex).toContain("\\cite{a2021method,b2022method}");
    expect(ok.tasks[0]).toContain("综述写作纪律");

    const bad = new FakeRuntime(() =>
      completedTask("\\section{数据关联方法}\n\n编造引用 \\cite{ghost2099paper}。"),
    );
    const writer2 = new WriterService({ runtime: bad, agentId: "writer" });
    await expect(
      writer2.writeSection({
        projectId: "p1",
        section: outline.sections[0]!,
        outline,
        evidence: EVIDENCE,
        bibliography: BIB,
        survey: coreContext(),
      }),
    ).rejects.toThrow(InvalidLatexOutputError);
    await expect(
      writer2.writeSection({
        projectId: "p1",
        section: outline.sections[0]!,
        outline,
        evidence: EVIDENCE,
        bibliography: BIB,
        survey: coreContext(),
      }),
    ).rejects.toThrow("契约之外的 citation key");
  });

  it("普通论文路径 backward compatibility：无 survey 参数走旧 prompt（无综述纪律）", async () => {
    const runtime = new FakeRuntime(() => completedTask("\\section{引言}\n\n普通论文。"));
    const writer = new WriterService({ runtime, agentId: "writer" });
    await writer.writeSection({
      projectId: "p1",
      section: outline.sections[0]!,
      outline,
      evidence: [],
      bibliography: [],
    });
    expect(runtime.tasks[0]).not.toContain("综述写作纪律");
    expect(runtime.tasks[0]).toContain("论文章节");
  });
});

describe("WriterService.reviseSection survey 约束", () => {
  it("综述结构红线块进入修订 prompt（taxonomy / gap / speculative / 白名单）", async () => {
    const runtime = new FakeRuntime(() =>
      completedTask("\\section{数据关联方法（修订）}\n\n修订后 \\cite{a2021method}。"),
    );
    const writer = new WriterService({ runtime, agentId: "writer" });
    await writer.reviseSection({
      projectId: "p1",
      section: { id: "association", file: "association.tex", title: "数据关联方法" },
      outline: { title: "t", sections: [] },
      currentLatex: "\\section{数据关联方法}\n\n原稿 \\cite{a2021method}。",
      issues: [
        {
          category: "academic",
          severity: "major",
          section: "sections/association.tex",
          description: "比较维度缺失",
          blocking: false,
        },
      ],
      evidence: EVIDENCE,
      bibliography: BIB,
      survey: coreContext(),
    });
    const prompt = runtime.tasks[0]!;
    expect(prompt).toContain("综述结构红线");
    expect(prompt).toContain("不得提出新的 research gap");
    expect(prompt).toContain("不得更换或新增 taxonomy");
    expect(prompt).toContain("推测语气");
    expect(prompt).toContain("新增引用只能使用以下 key：a2021method, b2022method");
    expect(prompt).toContain("[SYN-aaaaaaaaaa]");
  });

  it("无 survey 参数的修订不注入红线块（普通论文兼容）", async () => {
    const runtime = new FakeRuntime(() =>
      completedTask("\\section{章节标题（修订后）}\n\n修订后的论述。"),
    );
    const writer = new WriterService({ runtime, agentId: "writer" });
    await writer.reviseSection({
      projectId: "p1",
      section: { id: "association", file: "association.tex", title: "数据关联方法" },
      outline: { title: "t", sections: [] },
      currentLatex: "\\section{章节标题}\n\n原稿。",
      issues: [
        { category: "academic", severity: "minor", section: "sections/association.tex", description: "表达", blocking: false },
      ],
      evidence: [],
      bibliography: [],
    });
    expect(runtime.tasks[0]).not.toContain("综述结构红线");
  });
});
