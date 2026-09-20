/**
 * ResearchPlan 领域模型测试（M8.1 第六部分-1）：
 * - 类型 / 默认状态 / 序列化：draft 默认、query 默认 planned、id 与时间戳后端生成、
 *   JSON 往返稳定；
 * - 宽容解析：无 plan / 非法 plan → undefined（旧输出契约兼容）；非法条目丢弃；
 * - PUT 输入校验与合并语义：替换 / 同 id 保留 status+resultCount / 新条目分配不冲突 id；
 * - backward compatibility：旧 research.json（无 plan 字段）读取与「编辑即初始化」。
 */

import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { BusinessError } from "../../src/errors.js";
import {
  applyResearchPlanUpdate,
  createResearchPlan,
  parseResearchPlan,
  parseResearchPlanUpdateInput,
  type ResearchPlan,
} from "../../src/agents/researchPlan.js";
import {
  readResearchArtifact,
  updateResearchPlan,
} from "../../src/agents/ResearcherService.js";

const tempRoots: string[] = [];
afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

async function newProject(): Promise<{ store: ProjectStore; projectId: string }> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-plan-"));
  tempRoots.push(root);
  const store = new ProjectStore({ root });
  const project = await store.create("计划测试项目", { researchIdea: "Transformer MOT" });
  return { store, projectId: project.id };
}

const VALID_AGENT_PLAN = {
  questions: ["Transformer MOT 的发展脉络是什么？", "当前 SOTA 方法与局限？"],
  queries: [
    {
      query: "transformer multi-object tracking survey",
      kind: "academic",
      rationale: "理解方法演进",
      expectedCoverage: "近三年综述 3-5 篇",
    },
    { query: "real-time transformer tracking", kind: "web", rationale: "找效率优化线索" },
  ],
};

describe("parseResearchPlan（Agent 输出 → 领域对象）", () => {
  it("合法 plan：默认状态 draft / planned，planId、queryId 与时间戳由后端生成", () => {
    const plan = parseResearchPlan({ plan: VALID_AGENT_PLAN });

    expect(plan).toBeDefined();
    expect(plan!.planId).toMatch(/^rp-[a-z0-9]{12}$/);
    expect(plan!.status).toBe("draft");
    expect(plan!.questions).toEqual(VALID_AGENT_PLAN.questions);
    expect(plan!.queries).toHaveLength(2);
    expect(plan!.queries[0]).toMatchObject({
      queryId: "q-1",
      query: "transformer multi-object tracking survey",
      kind: "academic",
      rationale: "理解方法演进",
      expectedCoverage: "近三年综述 3-5 篇",
      status: "planned",
    });
    expect(plan!.queries[1]).toMatchObject({ queryId: "q-2", kind: "web", status: "planned" });
    expect(plan!.queries[1]!.rationale).toBe("找效率优化线索");
    expect(new Date(plan!.createdAt).toString()).not.toBe("Invalid Date");
    expect(plan!.updatedAt).toBe(plan!.createdAt);
    // 执行回填字段在解析阶段不存在
    expect(plan!.queries[0]!.resultCount).toBeUndefined();
  });

  it("缺省字段补默认：无 rationale / expectedCoverage 的条目仍合法", () => {
    const plan = parseResearchPlan({
      plan: { questions: ["q1"], queries: [{ query: "mot", kind: "academic" }] },
    });
    expect(plan!.queries[0]!.rationale).toBeUndefined();
    expect(plan!.queries[0]!.expectedCoverage).toBeUndefined();
  });

  it("序列化稳定：JSON 往返后字段与值完全一致", () => {
    const plan = parseResearchPlan({ plan: VALID_AGENT_PLAN })!;
    const roundTripped = JSON.parse(JSON.stringify(plan)) as ResearchPlan;
    expect(roundTripped).toEqual(plan);
  });

  it("宽容解析：无 plan / plan 非对象 / 空内容 → undefined（旧输出契约兼容）", () => {
    expect(parseResearchPlan({})).toBeUndefined();
    expect(parseResearchPlan({ plan: "查一下就行" })).toBeUndefined();
    expect(parseResearchPlan({ plan: [] })).toBeUndefined();
    expect(parseResearchPlan({ plan: { questions: [], queries: [] } })).toBeUndefined();
    expect(parseResearchPlan({ plan: { queries: [{ query: "  ", kind: "academic" }] } }))
      .toBeUndefined();
  });

  it("非法条目丢弃不炸整次解析：缺 query / kind 非法 / 非对象条目", () => {
    const plan = parseResearchPlan({
      plan: {
        questions: ["保留的问题"],
        queries: [
          { kind: "academic" }, // 缺 query
          { query: "合法检索词", kind: "illegal-kind" }, // kind 非法
          "不是对象",
          { query: "ocr mot", kind: "web" }, // 合法
        ],
      },
    });
    expect(plan!.queries).toHaveLength(1);
    expect(plan!.queries[0]).toMatchObject({ query: "ocr mot", kind: "web", queryId: "q-1" });
    expect(plan!.questions).toEqual(["保留的问题"]);
  });
});

describe("parseResearchPlanUpdateInput（PUT 请求体校验）", () => {
  it("合法输入：questions / queries 至少其一，均可独立提供", () => {
    expect(parseResearchPlanUpdateInput({ questions: ["a"] })).toEqual({ questions: ["a"] });
    expect(
      parseResearchPlanUpdateInput({
        queries: [{ query: "mot", kind: "web", status: "executed" }],
      }),
    ).toEqual({
      queries: [expect.objectContaining({ query: "mot", kind: "web", status: "executed" })],
    });
  });

  it("非法输入 → INVALID_REQUEST：空请求体 / 非数组 / 空 query / 非法 kind / 非法 status", () => {
    const cases: Array<[string, Record<string, unknown>]> = [
      ["空请求体", {}],
      ["questions 非数组", { questions: "not-array" }],
      ["queries 非数组", { queries: "not-array" }],
      ["空问题字符串", { questions: [""] }],
      ["缺 query", { queries: [{ kind: "academic" }] }],
      ["非法 kind", { queries: [{ query: "mot", kind: "library" }] }],
      ["非法 status", { queries: [{ query: "mot", kind: "web", status: "done" }] }],
      ["queries 条目非对象", { queries: ["x"] }],
    ];
    for (const [name, body] of cases) {
      expect(() => parseResearchPlanUpdateInput(body), name).toThrow(BusinessError);
      try {
        parseResearchPlanUpdateInput(body);
      } catch (error) {
        expect((error as BusinessError).code).toBe("INVALID_REQUEST");
      }
    }
  });
});

describe("applyResearchPlanUpdate（合并语义）", () => {
  const base = createResearchPlan(
    ["问题一", "问题二"],
    [
      { query: "mot survey", kind: "academic", rationale: "原始理由" },
      { query: "mot benchmark", kind: "web" },
    ],
  );

  it("替换 questions / 未提供的字段保持不变", () => {
    const updated = applyResearchPlanUpdate(base, { questions: ["新问题"] });
    expect(updated.questions).toEqual(["新问题"]);
    expect(updated.queries).toEqual(base.queries);
    expect(updated.planId).toBe(base.planId);
    expect(updated.status).toBe("draft");
    expect(updated.createdAt).toBe(base.createdAt);
    expect(new Date(updated.updatedAt).getTime()).toBeGreaterThanOrEqual(
      new Date(base.updatedAt).getTime(),
    );
  });

  it("同 queryId 条目：保留执行回填的 resultCount 与缺省时的既有 status", () => {
    const executed = {
      ...base,
      queries: base.queries.map((query) => ({
        ...query,
        status: "executed" as const,
        resultCount: 7,
      })),
    };
    const updated = applyResearchPlanUpdate(executed, {
      queries: [
        {
          queryId: executed.queries[0]!.queryId,
          query: "改写后的检索词",
          kind: "academic",
        },
      ],
    });
    expect(updated.queries[0]).toMatchObject({
      queryId: executed.queries[0]!.queryId,
      query: "改写后的检索词",
      status: "executed", // 缺省保留
      resultCount: 7, // 执行状态不被编辑面冲掉
    });
  });

  it("新条目分配不冲突的 queryId；显式 status 生效；旧条目可删除（整体替换）", () => {
    const updated = applyResearchPlanUpdate(base, {
      queries: [
        { queryId: "q-2", query: base.queries[1]!.query, kind: "web", status: "skipped" },
        { query: "新检索词", kind: "academic", status: "executed" },
      ],
    });
    expect(updated.queries).toHaveLength(2);
    expect(updated.queries[0]).toMatchObject({ queryId: "q-2", status: "skipped" });
    expect(updated.queries[1]).toMatchObject({ queryId: "q-3", status: "executed" });
  });
});

describe("backward compatibility（旧 research.json 无 plan 字段）", () => {
  it("旧 artifact 读取：plan 为 undefined，report 等字段不受影响", async () => {
    const { store, projectId } = await newProject();
    const researchDir = store.researchDir(projectId);
    await writeFile(
      join(researchDir, "research.json"),
      JSON.stringify({
        generatedAt: "2026-09-01T00:00:00.000Z",
        taskId: "run-old",
        report: {
          domainOverview: "旧调研",
          relatedWorkDirections: [],
          researchGaps: ["旧 gap"],
          potentialContributions: ["旧贡献"],
          researchQuestions: ["旧研究问题"],
          literaturePlan: ["旧文献方向"],
        },
        evidence: [],
        bibliography: [],
      }),
      "utf8",
    );

    const artifact = await readResearchArtifact(store, projectId);
    expect(artifact).not.toBeNull();
    expect(artifact!.plan).toBeUndefined();
    expect(artifact!.report.researchGaps).toEqual(["旧 gap"]);
    expect(artifact!.report.researchQuestions).toEqual(["旧研究问题"]);
  });

  it("旧 artifact 上编辑计划：编辑即初始化（draft 空计划起步），既有字段原样保留", async () => {
    const { store, projectId } = await newProject();
    const researchDir = store.researchDir(projectId);
    await writeFile(
      join(researchDir, "research.json"),
      JSON.stringify({
        generatedAt: "2026-09-01T00:00:00.000Z",
        taskId: "run-old",
        kind: "existing_paper_analysis",
        report: {
          domainOverview: "旧调研",
          relatedWorkDirections: [],
          researchGaps: ["旧 gap"],
          potentialContributions: ["旧贡献"],
          researchQuestions: ["旧研究问题"],
          literaturePlan: [],
        },
        evidence: [],
        bibliography: [],
        weaknesses: ["旧弱点"],
      }),
      "utf8",
    );

    const plan = await updateResearchPlan(store, projectId, {
      questions: ["编辑出的新问题"],
      queries: [{ query: "人工补充检索", kind: "academic", rationale: "用户手动补充" }],
    });
    expect(plan.status).toBe("draft");
    expect(plan.questions).toEqual(["编辑出的新问题"]);

    const raw = JSON.parse(await readFile(join(researchDir, "research.json"), "utf8")) as Record<
      string,
      unknown
    >;
    // plan 已写入，既有字段（含 existing-paper 附加字段）原样保留
    expect(raw["kind"]).toBe("existing_paper_analysis");
    expect(raw["weaknesses"]).toEqual(["旧弱点"]);
    expect((raw["report"] as Record<string, unknown>)["researchGaps"]).toEqual(["旧 gap"]);
    expect((raw["plan"] as Record<string, unknown>)["questions"]).toEqual(["编辑出的新问题"]);
  });

  it("无 artifact → NOT_FOUND（先运行调研才有 plan 可编辑）", async () => {
    const { store, projectId } = await newProject();
    await expect(
      updateResearchPlan(store, projectId, { questions: ["x"] }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});
