/**
 * M15.14 — ContributionAuditService 单元测试：
 * 确定性守卫（锚校验/pool 身份解析/时间 cutoff/四态规则/同族去重指纹）、
 * 三步调用链（scope/prompt 结构/文档类型注入/coverage 台账/解析重试）、
 * gapPlan 实验缺口停 Author Decision、fingerprint 随 pool 变化（staleness）。
 */

import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { PaperStore } from "../../src/paper/PaperStore.js";
import {
  ContributionAuditService,
  buildPoolFingerprint,
  enforceStatusRules,
  isCutoffViolation,
  parseComparisonsOutput,
  parseInventoryOutput,
  parseSynthesisOutput,
  renderPoolMaterial,
  resolvePriorWorkRef,
  titleFingerprint,
  type ContributionComparison,
  type PriorWorkPool,
} from "../../src/target/ContributionAuditService.js";
import type { PaperDocument } from "../../src/paper/types.js";
import type { AgentRuntime, AgentTask, RuntimeHealth } from "../../src/runtime/types.js";

class FakeRuntime implements AgentRuntime {
  readonly provider = "pi" as const;
  readonly calls: Array<{ contextScope: string; task: string }> = [];
  outputs = new Map<string, string>();
  outputsSeq = new Map<string, string[]>();
  private counter = 0;

  async healthCheck(): Promise<RuntimeHealth> {
    return { ok: true, provider: "pi", status: "healthy", detail: "fake", latencyMs: 1, checkedAt: new Date().toISOString() };
  }

  async runAgent(input: { agentId: string; contextScope?: string; task: string }): Promise<AgentTask> {
    this.counter += 1;
    const scope = input.contextScope ?? "";
    this.calls.push({ contextScope: scope, task: input.task });
    const seq = this.outputsSeq.get(scope);
    const output = seq !== undefined && seq.length > 0 ? seq.shift()! : this.outputs.get(scope) ?? "";
    const now = new Date().toISOString();
    return { taskId: `fake-${this.counter}`, agentId: input.agentId, status: "completed", createdAt: now, updatedAt: now, output };
  }

  async startAgent(input: Parameters<AgentRuntime["startAgent"]>[0]) {
    const task = await this.runAgent(input);
    return { taskId: task.taskId, sessionKey: "fake", events: async function* () {}, cancel: async () => {}, result: async () => task };
  }

  async getTask(): Promise<AgentTask> {
    throw new Error("not implemented");
  }

  async close() {}
}

const MANUSCRIPT_SENTENCE = "We propose a novel recurrent memory module for lifelong visual tracking.";

function makeDocument(): PaperDocument {
  const section = (id: string, title: string, page: number) => ({
    sectionId: id,
    title,
    level: 1,
    pageStart: page,
    pageEnd: page,
    charCount: 400,
    source: "toc" as const,
  });
  const chunk = (id: string, sequence: number, sectionId: string, text: string) => ({
    chunkId: id,
    sequence,
    pageStart: 1,
    pageEnd: 2,
    sectionId,
    text,
    charCount: text.length,
  });
  const chunks = [
    chunk("C0001", 1, "SEC01", `${MANUSCRIPT_SENTENCE} ${"i".repeat(300)}`),
    chunk("C0002", 2, "SEC02", `Method: the memory module reuses temporal features. ${"m".repeat(300)}`),
    chunk("C0003", 3, "SEC03", `Experiments: comparison on two datasets. ${"e".repeat(300)}`),
    chunk("C0004", 4, "SEC04", `Conclusion: broad applicability claimed. ${"c".repeat(300)}`),
  ];
  return {
    schemaVersion: 1,
    projectId: "p-fixture",
    documentId: "paper-1",
    title: "Recurrent Memory for Tracking",
    abstract: "A lifelong visual tracker with a recurrent memory module.",
    originalFileName: "fixture.pdf",
    bytes: 999,
    sha256: "a".repeat(64),
    parse: { parserId: "test", parsedAt: "2026-10-30T00:00:00.000Z", durationMs: 1, pageCount: 4, extractionQuality: "good" },
    pages: [],
    sections: [section("SEC01", "Introduction", 1), section("SEC02", "Method", 2), section("SEC03", "Experiments", 3), section("SEC04", "Conclusion", 4)],
    chunks,
    abstractSectionId: "SEC01",
    ingestedAt: "2026-10-30T00:00:00.000Z",
  };
}

function makePool(overrides: Partial<PriorWorkPool> = {}): PriorWorkPool {
  return {
    cutoffDate: "2016-10-31",
    queriesUsed: ["title.search:Recurrent Memory for Tracking", "search:memory tracking recurrent"],
    candidates: [
      {
        candidateId: "P01",
        title: "Memory Networks for Tracking",
        year: 2016,
        venue: "CVPR",
        doi: "10.0000/mem-track",
        arxivId: "1601.00001",
        authors: "A, B",
        abstract: "A tracker with an external memory store that reuses temporal features across frames.",
        citedByManuscript: true,
        contentLevel: "abstract",
        source: "reference-list",
      },
      {
        candidateId: "P02",
        title: "Correlation Filters in Real-Time Tracking",
        year: 2015,
        venue: "TPAMI",
        abstract: "Correlation filter trackers and their variants.",
        citedByManuscript: false,
        contentLevel: "abstract",
        source: "openalex:W1",
      },
      {
        candidateId: "P03",
        title: "Some Metadata-Only Record",
        year: 2014,
        citedByManuscript: false,
        contentLevel: "metadata",
        source: "openalex:W2",
      },
    ],
    ...overrides,
  };
}

const INVENTORY_JSON = JSON.stringify({
  contributions: [
    {
      claimQuote: MANUSCRIPT_SENTENCE,
      claimParaphrase: "Novel recurrent memory module for tracking",
      claimType: "technical_idea",
      sectionId: "SEC01",
      supportLocations: [
        { sectionId: "SEC02", kind: "method", quote: "the memory module reuses temporal features" },
      ],
    },
    {
      claimQuote: "这句话在稿件里不存在",
      claimType: "other",
      sectionId: "SEC99",
    },
  ],
});

const COMPARISONS_JSON = JSON.stringify({
  comparisons: [
    {
      contributionId: "C1",
      nearestPriorWorks: [
        { candidateId: "P01", title: "Memory Networks for Tracking", year: 2016, sourceLevel: "pool_abstract", quote: "reuses temporal features" },
        { title: "An Invented Work That Is Not In The Pool", year: 2017, sourceLevel: "pool_abstract" },
      ],
      commonMechanism: "temporal feature reuse via memory",
      substantiveDifference: "manuscript adds gating; prior work does not gate",
      differenceBasis: "abstract",
      completedVerification: "comparison on two datasets",
      missingVerification: "no ablation of the gating",
      status: "SUPPORTED_DIFFERENCE",
    },
    {
      contributionId: "C2",
      nearestPriorWorks: [],
      commonMechanism: "",
      substantiveDifference: "none observed",
      differenceBasis: "none",
      completedVerification: "",
      missingVerification: "",
      status: "SUPPORTED_DIFFERENCE",
    },
  ],
});

const SYNTHESIS_JSON = JSON.stringify({
  findings: [
    {
      category: "academic",
      severity: "major",
      sectionId: "SEC01",
      contributionId: "C1",
      claimText: MANUSCRIPT_SENTENCE,
      message: "Gating 与 P01 的记忆复用只差一个组件，创新性定位偏强。",
      evidenceGap: "gating 未做消融",
      confidence: "medium",
      suggestion: "补充 gating 消融或收窄声称",
      priorWorkTitles: ["Memory Networks for Tracking"],
    },
    { category: "academic", severity: "minor", sectionId: "SEC77", message: "锚到不存在节" },
  ],
  gapPlan: [
    {
      contributionId: "C1",
      gap: "gating 消融缺失",
      actionType: "requires_real_experiment_or_author_input",
      experimentPlan: { purpose: "隔离 gating 的贡献", baselines: "P01 复现", datasets: "OTB/UAV", metrics: "AUC" },
    },
    { contributionId: "C1", gap: "声称措辞过强", actionType: "can_rewrite_from_existing_evidence" },
  ],
});

describe("确定性守卫（纯函数）", () => {
  it("titleFingerprint 归一（大小写/标点折叠）", () => {
    expect(titleFingerprint("Memory Networks: For Tracking!")).toBe(titleFingerprint("memory networks for tracking"));
  });

  it("resolvePriorWorkRef：candidateId > DOI > arXiv > 标题指纹；不存在的引用解析失败", () => {
    const pool = makePool();
    expect(resolvePriorWorkRef({ candidateId: "P02", title: "whatever" }, pool)?.candidateId).toBe("P02");
    expect(resolvePriorWorkRef({ title: "unknown title", doi: "10.0000/mem-track" }, pool)?.candidateId).toBe("P01");
    expect(resolvePriorWorkRef({ title: "unknown", arxivId: "1601.00001v2" }, pool)?.candidateId).toBe("P01");
    expect(resolvePriorWorkRef({ title: "correlation filters in real-time tracking" }, pool)?.candidateId).toBe("P02");
    expect(resolvePriorWorkRef({ title: "totally absent work" }, pool)).toBeNull();
  });

  it("isCutoffViolation：cutoff 年之后 = 违规；未知年份不算", () => {
    expect(isCutoffViolation(2017, "2016-10-31")).toBe(true);
    expect(isCutoffViolation(2016, "2016-10-31")).toBe(false);
    expect(isCutoffViolation(undefined, "2016-10-31")).toBe(false);
  });

  it("enforceStatusRules：无可解析先前工作的 SUPPORTED_DIFFERENCE 降级 INSUFFICIENT_EVIDENCE 并计数", () => {
    const comparisons: ContributionComparison[] = [
      {
        contributionId: "C1",
        nearestPriorWorks: [
          { candidateId: "P01", title: "Memory Networks for Tracking", resolvesToPool: true },
        ],
        commonMechanism: "m",
        substantiveDifference: "d",
        differenceBasis: "abstract",
        completedVerification: "",
        missingVerification: "",
        status: "SUPPORTED_DIFFERENCE",
      },
      {
        contributionId: "C2",
        nearestPriorWorks: [],
        commonMechanism: "",
        substantiveDifference: "",
        differenceBasis: "none",
        completedVerification: "",
        missingVerification: "",
        status: "SUPPORTED_DIFFERENCE",
      },
      {
        contributionId: "C3",
        nearestPriorWorks: [
          { candidateId: "P01", title: "X", resolvesToPool: true, timeCausalityViolation: true },
        ],
        commonMechanism: "",
        substantiveDifference: "",
        differenceBasis: "abstract",
        completedVerification: "",
        missingVerification: "",
        status: "POTENTIAL_OVERLAP",
      },
    ];
    const result = enforceStatusRules(comparisons);
    expect(result.comparisons[0]!.status).toBe("SUPPORTED_DIFFERENCE");
    expect(result.comparisons[1]!.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.comparisons[2]!.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.violations).toHaveLength(2);
  });

  it("buildPoolFingerprint：候选/摘要/cutoff 变化 → 指纹变化；同输入恒定", () => {
    const pool = makePool();
    expect(buildPoolFingerprint(pool)).toBe(buildPoolFingerprint(makePool()));
    const changed = makePool({
      candidates: [...pool.candidates, { candidateId: "P04", title: "New", year: 2016, citedByManuscript: false, contentLevel: "metadata", source: "openalex:W9" }],
    });
    expect(buildPoolFingerprint(changed)).not.toBe(buildPoolFingerprint(pool));
    const changedAbstract = makePool({
      candidates: pool.candidates.map((c, i) => (i === 0 ? { ...c, abstract: `${c.abstract} more` } : c)),
    });
    expect(buildPoolFingerprint(changedAbstract)).not.toBe(buildPoolFingerprint(pool));
    const changedCutoff = makePool({ cutoffDate: "2016-12-31" });
    expect(buildPoolFingerprint(changedCutoff)).not.toBe(buildPoolFingerprint(pool));
  });

  it("renderPoolMaterial：内容等级/自引/cutoff 呈现，A0/A2 共用同一段字节", () => {
    const text = renderPoolMaterial(makePool());
    expect(text).toContain("[abstract; cited-by-manuscript] Memory Networks for Tracking");
    expect(text).toContain("[metadata] Some Metadata-Only Record");
    expect(text).toContain("2016-10-31");
    expect(text).toContain("不得断言实现级异同");
  });
});

describe("解析器（纯函数）", () => {
  it("parseInventoryOutput：合法解析 + 截断 5 条上限", () => {
    const many = { contributions: Array.from({ length: 8 }, (_, i) => ({ claimQuote: `q${i}`, sectionId: "SEC01" })) };
    const result = parseInventoryOutput(JSON.stringify(many));
    expect(result.parseFailed).toBe(false);
    expect(result.contributions).toHaveLength(5);
  });

  it("parseComparisonsOutput：非法 status 枚举回退 INSUFFICIENT_EVIDENCE", () => {
    const result = parseComparisonsOutput(JSON.stringify({ comparisons: [{ contributionId: "C1", status: "DEFINITELY_NOVEL" }] }));
    expect(result.comparisons[0]!.status).toBe("INSUFFICIENT_EVIDENCE");
  });

  it("parseSynthesisOutput：requires_real_experiment → status author_decision", () => {
    const result = parseSynthesisOutput(SYNTHESIS_JSON);
    expect(result.gapPlan).toHaveLength(2);
    expect(result.gapPlan[0]!.status).toBe("author_decision");
    expect(result.gapPlan[0]!.experimentPlan?.purpose).toBe("隔离 gating 的贡献");
    expect(result.gapPlan[1]!.status).toBe("proposed");
  });

  it("非 JSON 输出 → parseFailed", () => {
    expect(parseInventoryOutput("no json").parseFailed).toBe(true);
    expect(parseComparisonsOutput("").parseFailed).toBe(true);
    expect(parseSynthesisOutput("```text\nnothing\n```").parseFailed).toBe(true);
  });
});

describe("ContributionAuditService（三步调用链）", () => {
  let root: string;
  let projects: ProjectStore;
  let store: PaperStore;
  let runtime: FakeRuntime;
  let service: ContributionAuditService;
  let projectId: string;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "paperteam-caudit-"));
    projects = new ProjectStore({ root });
    store = new PaperStore(projects);
    runtime = new FakeRuntime();
    service = new ContributionAuditService({
      store,
      runtime,
      reviewerAgentId: "reviewer",
      researchDir: (id) => projects.researchDir(id),
    });
    const project = await projects.create("贡献审计测试");
    projectId = project.id;
    await store.saveIngest(projectId, makeDocument());
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("三步调用 scope/prompt 结构；守卫与工件落盘", async () => {
    runtime.calls.length = 0;
    runtime.outputs.set("review/contribution/extract", INVENTORY_JSON);
    runtime.outputs.set("review/contribution/compare", COMPARISONS_JSON);
    runtime.outputs.set("review/contribution/synthesize", SYNTHESIS_JSON);
    const outcome = await service.audit({
      projectId,
      runId: "run1",
      pool: makePool(),
      documentType: "research_article",
      venueId: "cjig",
      toolPolicy: "read_only",
    });
    expect(runtime.calls).toHaveLength(3);
    expect(runtime.calls.map((c) => c.contextScope)).toEqual([
      "review/contribution/extract",
      "review/contribution/compare",
      "review/contribution/synthesize",
    ]);
    // extract prompt：文档类型注入 + 确定性导航索引（含节标题与字符数）
    expect(runtime.calls[0]!.task).toContain("documentType: research_article");
    expect(runtime.calls[0]!.task).toContain("SEC01 Introduction");
    expect(runtime.calls[0]!.task).toContain("deterministic, no model summaries");
    // survey 文档类型 → 综述口径指令注入（该轮 extract = 全局第 4 次调用）
    runtime.outputs.set("review/contribution/extract", INVENTORY_JSON);
    await service.audit({ projectId, runId: "run-survey", pool: makePool(), documentType: "survey" });
    const surveyExtract = runtime.calls.filter((c) => c.contextScope === "review/contribution/extract").at(-1)!;
    expect(surveyExtract.task).toContain("documentType: survey");
    expect(surveyExtract.task).toContain("survey/review");

    // compare prompt：pool 材料呈现（同 renderPoolMaterial 字节）+ 支撑节全文
    const compareTask = runtime.calls.find((c) => c.contextScope === "review/contribution/compare")!.task;
    expect(compareTask).toContain(renderPoolMaterial(makePool()));
    expect(compareTask).toContain("【SEC02 Method 全文】");

    // 守卫：第二条贡献引文不存在 → anchorFailure；C2 无有效先前工作 → 降级
    const artifact = outcome.artifact;
    expect(artifact.inventory).toHaveLength(1);
    expect(artifact.inventory[0]!.anchorVerified).toBe(true);
    expect(artifact.inventory[0]!.supportStatus).toBe("located");
    expect(artifact.guards.anchorFailures).toBe(1);
    const c2 = artifact.comparisons.find((c) => c.contributionId === "C2");
    expect(c2?.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(artifact.guards.statusRuleViolations).toBeGreaterThanOrEqual(1);
    // 模型引用 pool 外工作：未解析 + 2017 年时间违规
    const invented = artifact.comparisons[0]!.nearestPriorWorks.find((r) => r.title.includes("Invented"));
    expect(invented?.resolvesToPool).toBe(false);
    expect(invented?.timeCausalityViolation).toBe(true);
    expect(artifact.guards.cutoffViolations).toBe(1);
    expect(artifact.guards.unresolvedPriorWorkRefs).toBe(1);
    // findings：非法 sectionId 丢弃；扩展字段随行
    expect(artifact.findings).toHaveLength(1);
    expect(artifact.findings[0]!.contributionId).toBe("C1");
    expect(artifact.findings[0]!.source).toBe("contribution-audit");
    expect(artifact.guards.droppedFindings).toBe(1);
    // gapPlan：实验缺口停 author_decision
    const experimentGap = artifact.gapPlan.find((g) => g.actionType === "requires_real_experiment_or_author_input");
    expect(experimentGap?.status).toBe("author_decision");
    // coverage 台账 + 指纹
    expect(artifact.coverage.sectionsTotal).toBe(4);
    expect(artifact.inputFingerprint.poolFingerprint).toBe(buildPoolFingerprint(makePool()));
    expect(artifact.venueId).toBe("cjig");
    expect(artifact.provenance.basis).toBe("model_judgment_advisory");
    // 工件落盘
    const persisted = JSON.parse(await readFile(service.artifactPath(projectId), "utf8"));
    expect(persisted.promptVersion).toBe(artifact.promptVersion);
    expect(persisted.findings).toHaveLength(1);
  });

  it("解析失败 → 有界重试（物理第二次调用）；仍失败如实标记", async () => {
    runtime.calls.length = 0;
    runtime.outputsSeq.set("review/contribution/extract", ["garbage not json", INVENTORY_JSON]);
    runtime.outputs.set("review/contribution/compare", COMPARISONS_JSON);
    runtime.outputs.set("review/contribution/synthesize", SYNTHESIS_JSON);
    const outcome = await service.audit({ projectId, runId: "run2", pool: makePool(), documentType: "research_article" });
    expect(outcome.extractRetried).toBe(true);
    expect(outcome.extractParseFailed).toBe(false);
    expect(runtime.calls.filter((c) => c.contextScope === "review/contribution/extract")).toHaveLength(2);
    // 重试 prompt 带格式提醒
    const extractCalls = runtime.calls.filter((c) => c.contextScope === "review/contribution/extract");
    expect(extractCalls[1]!.task).toContain("格式提醒");
  });

  it("pool 变化 → inputFingerprint.poolFingerprint 变化（staleness 语义）", async () => {
    runtime.outputs.set("review/contribution/extract", INVENTORY_JSON);
    runtime.outputs.set("review/contribution/compare", COMPARISONS_JSON);
    runtime.outputs.set("review/contribution/synthesize", SYNTHESIS_JSON);
    const base = await service.audit({ projectId, runId: "run3a", pool: makePool(), documentType: "research_article" });
    const shrunk = await service.audit({
      projectId,
      runId: "run3b",
      pool: makePool({ candidates: makePool().candidates.slice(0, 1) }),
      documentType: "research_article",
    });
    expect(shrunk.artifact.inputFingerprint.poolFingerprint).not.toBe(base.artifact.inputFingerprint.poolFingerprint);
  });
});

describe("M15.15 verified_fulltext 材料级（纯函数）", () => {
  const fulltextPool = (): PriorWorkPool => ({
    cutoffDate: "2021-12-31",
    queriesUsed: [],
    candidates: [
      {
        candidateId: "P01",
        title: "Simple online and realtime tracking",
        year: 2016,
        arxivId: "1602.00763",
        abstract: "This paper presents a practical approach for multiple object tracking.",
        fullTextExcerpts: [
          "The tracking scenario is formulated as detection + Kalman filter + Hungarian assignment.",
        ],
        citedByManuscript: true,
        contentLevel: "verified_fulltext",
        source: "arxiv:1602.00763",
      },
    ],
  });

  it("renderPoolMaterial：verified_fulltext 渲染摘要 + 全文片段 + 分级说明", () => {
    const text = renderPoolMaterial(fulltextPool());
    expect(text).toContain("[verified_fulltext; cited-by-manuscript]");
    expect(text).toContain("Abstract:");
    expect(text).toContain("Full-text excerpts");
    expect(text).toContain("detection + Kalman filter + Hungarian assignment");
    expect(text).toContain("verified_fulltext");
  });

  it("buildPoolFingerprint：excerpts 变化 → 指纹变化（staleness 语义保持）", () => {
    const base = buildPoolFingerprint(fulltextPool());
    const changed = fulltextPool();
    changed.candidates[0]!.fullTextExcerpts = ["different excerpt text entirely"];
    expect(buildPoolFingerprint(changed)).not.toBe(base);
  });

  it("enforceStatusRules：differenceBasis=fulltext 不影响既有四态规则（basis 降级守卫在 compare 后处理内）", () => {
    const result = enforceStatusRules([
      {
        contributionId: "C1",
        nearestPriorWorks: [{ title: "Simple online and realtime tracking", year: 2016, resolvesToPool: false }],
        commonMechanism: "x",
        substantiveDifference: "y",
        differenceBasis: "fulltext",
        completedVerification: "",
        missingVerification: "",
        status: "SUPPORTED_DIFFERENCE",
      },
    ]);
    // 无 pool 支撑的先前工作 → 仍降级（fulltext basis 不豁免身份解析要求）
    expect(result.comparisons[0]!.status).toBe("INSUFFICIENT_EVIDENCE");
    expect(result.violations.length).toBeGreaterThan(0);
  });
});
