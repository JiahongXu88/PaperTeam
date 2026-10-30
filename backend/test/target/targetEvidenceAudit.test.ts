/**
 * M15.16 — TargetEvidenceAuditService / buildPriorWorkPool / P0-B PDF guideline facts 测试：
 * - pool 三通道（自引解析 / 外部检索空查询纪律 / 在库全文升级 verified_fulltext）；
 * - 服务编排（无稿 fail-closed / 工件+meta 落盘 / 陈旧判定 / 幂等覆盖）；
 * - buildTargetServices 装配（flag off 或依赖缺失 → evidenceAudit=null）；
 * - guideline PDF-only 参考文献观测（数量 / 年份区间分析 / DOI 不可辨不误判）。
 */

import { mkdtemp, rm, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { PaperStore } from "../../src/paper/PaperStore.js";
import type { PaperDocument } from "../../src/paper/types.js";
import {
  TargetEvidenceAuditService,
  buildPriorWorkPool,
  latinQueryTerms,
  librarySourceMatches,
  pickMethodExcerpts,
  type PoolBuildDeps,
} from "../../src/target/TargetEvidenceAuditService.js";
import { buildTargetServices } from "../../src/target/services.js";
import { pdfReferenceStatsOf, observeGuidelineFacts } from "../../src/target/guidelineFacts.js";
import type { AgentRuntime, AgentTask, RuntimeHealth } from "../../src/runtime/types.js";
import type { SourceItem } from "../../src/sources/SourceStore.js";
import type { SourceChunk } from "../../src/retrieval/types.js";
import type { ResolverVerdict, ScholarlyQuery } from "../../src/citation/scholarly.js";

// ---- Fake runtime / scholarly / academic ----

class FakeRuntime implements AgentRuntime {
  readonly provider = "pi" as const;
  readonly calls: Array<{ contextScope: string; task: string }> = [];
  outputs = new Map<string, string>();
  private counter = 0;

  async healthCheck(): Promise<RuntimeHealth> {
    return { ok: true, provider: "pi", status: "healthy", detail: "fake", latencyMs: 1, checkedAt: new Date().toISOString() };
  }

  async runAgent(input: { agentId: string; contextScope?: string; task: string }): Promise<AgentTask> {
    this.counter += 1;
    this.calls.push({ contextScope: input.contextScope ?? "", task: input.task });
    const output = this.outputs.get(input.contextScope ?? "") ?? "";
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

function fakeScholarly(
  resolver: (query: ScholarlyQuery) => ResolverVerdict | null,
): { resolve: (query: ScholarlyQuery) => Promise<ResolverVerdict>; calls: ScholarlyQuery[] } {
  const calls: ScholarlyQuery[] = [];
  return {
    calls,
    resolve: async (query: ScholarlyQuery) => {
      calls.push(query);
      return resolver(query) ?? { outcome: "not_found", attempts: [], cacheHits: 0 };
    },
  };
}

function fakeAcademic(
  responder: (query: string) => Array<{ title: string; year?: number; doi?: string; arxivId?: string; abstract?: string; venue?: string }>,
): {
  search: (query: string, opts?: { limit?: number; yearTo?: number }) => Promise<{
    status: "success" | "partial";
    results: Array<{
      identity: { normalizedTitleFingerprint: string; doi?: string; year?: number };
      record: { provider: string; recordId: string; title?: string; year?: number; doi?: string; arxivId?: string; abstract?: string; venue?: string };
      score: number;
      sources: Array<{ provider: string; rank: number }>;
    }>;
    diagnostics: unknown;
  }>;
  queries: string[];
} {
  const queries: string[] = [];
  return {
    queries,
    search: async (query: string) => {
      queries.push(query);
      const works = responder(query);
      return {
        status: "success",
        results: works.map((work, index) => ({
          identity: {
            normalizedTitleFingerprint: work.title.toLowerCase().replace(/[^a-z0-9]+/g, ""),
            ...(work.doi !== undefined ? { doi: work.doi } : {}),
            ...(work.year !== undefined ? { year: work.year } : {}),
          },
          record: { provider: "openalex", recordId: `W${index}`, ...work },
          score: 1,
          sources: [{ provider: "openalex", rank: index + 1 }],
        })),
        diagnostics: { providers: [], rawResultCount: works.length, fusedResultCount: works.length },
      };
    },
  };
}

// ---- 手稿 fixture（含 References 节，numeric 条目带 DOI/年份） ----

const CLAIM_SENTENCE = "We propose a hierarchical semantic fusion network for scene text detection.";

function makeDocument(withReferences = true): PaperDocument {
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
  const referencesText = withReferences
    ? [
        "[1] Liao M, Wan Z, Yao C. Real-time scene text detection with differentiable binarization//AAAI. 2020: 11474-11481. 10.1609/aaai.v34i07.6812",
        "[2] Bochkovskiy A. YOLOv4: optimal speed and accuracy of object detection. 2020. arxiv.org/abs/2004.10934",
        "[3] Xu J. Some older unrelated survey of tracking methods. 2015.",
      ].join("\n\n")
    : "no references here";
  return {
    schemaVersion: 1,
    projectId: "p-fixture",
    documentId: "paper-1",
    title: "Hierarchical Semantic Fusion for Scene Text Detection",
    abstract: "A scene text detector with hierarchical semantic fusion and adaptive binarization.",
    originalFileName: "fixture.pdf",
    bytes: 999,
    sha256: "a".repeat(64),
    parse: { parserId: "test", parsedAt: "2026-10-31T00:00:00.000Z", durationMs: 1, pageCount: 5, extractionQuality: "good" },
    pages: [],
    sections: [
      section("SEC01", "Introduction", 1),
      section("SEC02", "Method", 2),
      section("SEC03", "Experiments", 3),
      section("SEC05", "References", 5),
    ],
    chunks: [
      chunk("C0001", 1, "SEC01", `${CLAIM_SENTENCE} ${"i".repeat(200)}`),
      chunk("C0002", 2, "SEC02", `Method: the fusion module combines semantic features. ${"m".repeat(200)}`),
      chunk("C0003", 3, "SEC03", `Experiments: comparison on benchmark datasets. ${"e".repeat(200)}`),
      chunk("C0005", 5, "SEC05", referencesText),
    ],
    abstractSectionId: "SEC01",
    referencesSectionId: withReferences ? "SEC05" : undefined,
    ingestedAt: "2026-10-31T00:00:00.000Z",
  };
}

const INVENTORY_JSON = JSON.stringify({
  contributions: [
    {
      claimQuote: CLAIM_SENTENCE,
      claimType: "technical_idea",
      sectionId: "SEC01",
      supportLocations: [{ sectionId: "SEC02", kind: "method", quote: "the fusion module combines semantic features" }],
    },
  ],
});

const COMPARISONS_JSON = JSON.stringify({
  comparisons: [
    {
      contributionId: "C1",
      nearestPriorWorks: [
        { candidateId: "P01", title: "Real-time scene text detection with differentiable binarization", year: 2020, sourceLevel: "pool_fulltext", quote: "Differentiable Binarization (DB)" },
      ],
      commonMechanism: "learnable post-processing for text segmentation",
      substantiveDifference: "manuscript adds hierarchical semantic fusion across stages",
      differenceBasis: "fulltext",
      completedVerification: "comparison on benchmark datasets",
      missingVerification: "no ablation of the hierarchical fusion",
      status: "SUPPORTED_DIFFERENCE",
    },
  ],
});

const SYNTHESIS_JSON = JSON.stringify({
  findings: [
    {
      category: "academic",
      severity: "minor",
      sectionId: "SEC01",
      contributionId: "C1",
      message: "缺少层级融合的消融实验",
      suggestion: "补消融或收敛措辞",
    },
  ],
  gapPlan: [
    {
      contributionId: "C1",
      gap: "层级融合无消融验证",
      actionType: "requires_real_experiment_or_author_input",
      experimentPlan: { purpose: "验证层级融合的贡献", baselines: "去融合变体", metrics: "F1" },
    },
  ],
});

const methodChunks: SourceChunk[] = [
  {
    chunkId: "s1c1",
    projectId: "p-fixture",
    sourceId: "src-0001",
    sectionId: "S1",
    sectionTitle: "3 Method",
    ordinal: 1,
    text: "The architecture combines a segmentation network with Differentiable Binarization (DB). The binarization threshold is learned end to end.",
  },
  {
    chunkId: "s1c2",
    projectId: "p-fixture",
    sourceId: "src-0001",
    sectionId: "S2",
    sectionTitle: "References",
    ordinal: 2,
    text: "References listing with many unrelated titles and citations that must not enter excerpts.",
  },
];

const librarySource: SourceItem = {
  sourceId: "src-0001",
  sourceRole: "reference",
  origin: "upload",
  status: "ready",
  preferred: false,
  metadata: { title: "Real-time scene text detection with differentiable binarization", year: 2020, doi: "10.1609/aaai.v34i07.6812" },
  identity: {
    doi: "10.1609/aaai.v34i07.6812",
    normalizedTitleFingerprint: "realtimescenetextdetectionwithdifferentiablebinarization",
    year: 2020,
  },
  bytes: 1000,
  createdAt: "2026-10-31T00:00:00.000Z",
  updatedAt: "2026-10-31T00:00:00.000Z",
};

function poolDeps(options: {
  scholarly: ReturnType<typeof fakeScholarly>;
  academic: ReturnType<typeof fakeAcademic>;
  library?: SourceItem[];
  chunks?: SourceChunk[];
}): PoolBuildDeps {
  return {
    scholarly: options.scholarly,
    academic: options.academic,
    librarySources: options.library ?? [],
    readSourceChunks: async (_projectId, sourceId) =>
      (options.chunks ?? []).filter((chunk) => chunk.sourceId === sourceId),
  };
}

// ---- 纯函数 ----

describe("latinQueryTerms / pickMethodExcerpts / librarySourceMatches", () => {
  it("中文稿题名+摘要无拉丁词 → 空查询（外部检索如实跳过，不造空查询）", () => {
    expect(latinQueryTerms("层级语义融合的场景文本检测", "提出一种融合语义特征的方法。")).toEqual([]);
  });

  it("英文题名 → 去停用词后的 top 词", () => {
    const terms = latinQueryTerms("Hierarchical Semantic Fusion for Scene Text Detection", "");
    expect(terms).toContain("hierarchical");
    expect(terms).not.toContain("binarization"); // 摘要为空时不引入
    expect(terms.every((term) => !["for", "the", "with"].includes(term))).toBe(true);
  });

  it("pickMethodExcerpts：方法节优先、References 节排除、预算封顶", () => {
    const excerpts = pickMethodExcerpts(methodChunks);
    expect(excerpts).toHaveLength(1);
    expect(excerpts[0]).toContain("3 Method");
    expect(excerpts[0]).toContain("Differentiable Binarization");
    expect(excerpts[0]).not.toContain("References listing");
  });

  it("librarySourceMatches：DOI 命中 / 标题指纹+年份命中 / 年份冲突拒绝", () => {
    expect(
      librarySourceMatches(
        { title: "Different Title Altogether", year: 2020, doi: "10.1609/aaai.v34i07.6812" },
        librarySource,
      ),
    ).toBe(true);
    expect(
      librarySourceMatches(
        { title: "Real-Time Scene Text Detection With Differentiable Binarization!", year: 2020 },
        librarySource,
      ),
    ).toBe(true);
    expect(
      librarySourceMatches(
        { title: "Real-time scene text detection with differentiable binarization", year: 2019 },
        librarySource,
      ),
    ).toBe(false);
    expect(librarySourceMatches({ title: "Unrelated work", year: 2020 }, librarySource)).toBe(false);
  });
});

// ---- pool 构建 ----

describe("buildPriorWorkPool（三通道 + 预算 + 去重）", () => {
  const document = makeDocument();

  it("通道 A 解析 + 通道 C 在库升级（verified_fulltext）+ 未解析条目 metadata 降级", async () => {
    const scholarly = fakeScholarly((query) => {
      if (query.doi === "10.1609/aaai.v34i07.6812" || /differentiable binarization/i.test(query.title ?? "")) {
        return {
          outcome: "match",
          canonical: {
            provider: "crossref",
            recordId: "10.1609/aaai.v34i07.6812",
            title: "Real-time scene text detection with differentiable binarization",
            year: 2020,
            doi: "10.1609/aaai.v34i07.6812",
            venue: "AAAI",
            abstract: "Proposes Differentiable Binarization for scene text detection.",
            retrievedAt: "2026-10-31T00:00:00.000Z",
          },
          attempts: [],
          cacheHits: 0,
        };
      }
      return null;
    });
    const academic = fakeAcademic(() => []);
    const { pool, stats } = await buildPriorWorkPool(
      document,
      "2026-10-31",
      poolDeps({ scholarly, academic, library: [librarySource], chunks: methodChunks }),
    );
    expect(stats.referenceEntriesTotal).toBe(3);
    expect(stats.referenceEntriesEligible).toBe(3);
    expect(stats.refResolved).toBe(1);
    const upgraded = pool.candidates.find((c) => c.contentLevel === "verified_fulltext");
    expect(upgraded).toBeDefined();
    expect(upgraded?.librarySourceId).toBe("src-0001");
    expect(upgraded?.fullTextExcerpts?.[0]).toContain("Differentiable Binarization");
    // 未解析条目仍有题名 → metadata 级（不猜字段）
    const metadata = pool.candidates.filter((c) => c.contentLevel === "metadata");
    expect(metadata.length).toBeGreaterThan(0);
    expect(metadata.every((c) => c.source === "reference-list(unresolved)")).toBe(true);
    // 解析摘要的条目为 abstract 级 + 自引标记
    expect(pool.candidates.find((c) => c.abstract !== undefined)?.citedByManuscript).toBe(true);
    expect(stats.libraryUpgraded).toBe(1);
  });

  it("中文稿无拉丁词 → 外部检索跳过并记录 buildNote（不发起空查询）", async () => {
    const zhDocument = makeDocument();
    zhDocument.title = "层级语义融合的场景文本检测";
    zhDocument.abstract = "提出一种端到端的方法。";
    const scholarly = fakeScholarly(() => null);
    const academic = fakeAcademic(() => []);
    const { stats } = await buildPriorWorkPool(zhDocument, "2026-10-31", poolDeps({ scholarly, academic }));
    expect(academic.queries).toHaveLength(0);
    expect(stats.externalQuery).toBeNull();
    expect(stats.buildNotes.some((note) => note.includes("external-search-skipped(no-latin-terms)"))).toBe(true);
  });

  it("外部检索年份晚于 cutoff → 排除；稿件自引 → self-excluded；重复 DOI → 去重", async () => {
    const scholarly = fakeScholarly(() => null);
    const academic = fakeAcademic(() => [
      { title: "Future Work Published Tomorrow", year: 2027, abstract: "future" },
      { title: "Hierarchical Semantic Fusion for Scene Text Detection", year: 2025, abstract: "self citation" },
      { title: "DB Kernel Revisited", year: 2019, doi: "10.1609/aaai.v34i07.6812", abstract: "same doi as ref" },
    ]);
    const { pool, stats } = await buildPriorWorkPool(document, "2026-10-31", poolDeps({ scholarly, academic }));
    expect(pool.candidates.some((c) => c.title === "Future Work Published Tomorrow")).toBe(false);
    expect(stats.selfExcluded).toBe(1);
    const doiCount = pool.candidates.filter((c) => c.doi === "10.1609/aaai.v34i07.6812").length;
    expect(doiCount).toBeLessThanOrEqual(1);
    expect(stats.poolCap).toBe(12);
    expect(pool.queriesUsed.length).toBeGreaterThan(0);
  });

  it("resolver 限流/错误如实计数（不静默、不伪造解析成功）", async () => {
    const scholarly = fakeScholarly(() => ({ outcome: "unresolved", attempts: [], cacheHits: 0 }));
    const academic = fakeAcademic(() => []);
    const { stats } = await buildPriorWorkPool(document, "2026-10-31", poolDeps({ scholarly, academic }));
    expect(stats.refResolved).toBe(0);
    expect(stats.refLookupErrors).toBe(3);
  });
});

// ---- 服务编排 ----

describe("TargetEvidenceAuditService（evaluate / get / staleness / 装配）", () => {
  let root: string;
  let projects: ProjectStore;
  let store: PaperStore;
  let runtime: FakeRuntime;
  let service: TargetEvidenceAuditService;
  let projectId: string;
  const scholarly = fakeScholarly(() => null);
  const academic = fakeAcademic(() => []);

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "paperteam-eaudit-"));
    projects = new ProjectStore({ root });
    store = new PaperStore(projects);
    runtime = new FakeRuntime();
    service = new TargetEvidenceAuditService({
      projects,
      store,
      runtime,
      reviewerAgentId: "reviewer",
      scholarly,
      academic,
      listLibrarySources: async () => [],
      readSourceChunks: async () => null,
    });
    const project = await projects.create("证据审计测试", { documentType: "research_article" });
    projectId = project.id;
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("无解析稿 → fail-closed（INVALID_REQUEST，不静默成功）", async () => {
    await expect(service.evaluate(projectId)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    expect(await service.get(projectId)).toBeNull();
  });

  it("evaluate：3 次模型调用、工件+meta 落盘、venueId/documentType 注入", async () => {
    await store.saveIngest(projectId, makeDocument());
    runtime.outputs.set("review/contribution/extract", INVENTORY_JSON);
    runtime.outputs.set("review/contribution/compare", COMPARISONS_JSON);
    runtime.outputs.set("review/contribution/synthesize", SYNTHESIS_JSON);
    runtime.calls.length = 0;
    const view = await service.evaluate(projectId, { venueId: "cjig" });
    expect(runtime.calls).toHaveLength(3);
    expect(view.artifact.venueId).toBe("cjig");
    expect(view.artifact.documentType).toBe("research_article");
    expect(view.stale).toBe(false);
    expect(view.artifact.gapPlan[0]?.status).toBe("author_decision");
    const artifactRaw = await readFile(join(projects.researchDir(projectId), "target-contribution-audit.json"), "utf8");
    expect(JSON.parse(artifactRaw).priorWork.candidates.length).toBeGreaterThan(0);
    const metaRaw = await readFile(join(projects.researchDir(projectId), "target-evidence-audit-meta.json"), "utf8");
    const meta = JSON.parse(metaRaw) as { telemetry: { calls: number }; poolBuild: { referenceEntriesTotal: number } };
    expect(meta.telemetry.calls).toBe(3);
    expect(meta.poolBuild.referenceEntriesTotal).toBe(3);
  });

  it("get：稿件变更 → stale 标记（fingerprint 不一致）", async () => {
    const changed = makeDocument();
    changed.chunks = [
      ...changed.chunks.filter((chunk) => chunk.sectionId !== "SEC02"),
      {
        chunkId: "C0002b",
        sequence: 2,
        pageStart: 2,
        pageEnd: 2,
        sectionId: "SEC02",
        text: "Method: a materially different method section after revision. ",
        charCount: 58,
      },
    ];
    await store.saveIngest(projectId, changed);
    const view = await service.get(projectId);
    expect(view?.stale).toBe(true);
    expect(view?.staleReason).toContain("稿件内容已变更");
  });

  it("buildTargetServices：flag off 或依赖缺失 → evidenceAudit=null（缺省关闭）", () => {
    const minimal = {
      projects,
      academic: academic as never,
      venues: {} as never,
      candidates: {} as never,
      imports: {} as never,
      sources: {} as never,
      parsedDocuments: {} as never,
    };
    expect(buildTargetServices(minimal).evidenceAudit).toBeNull();
    expect(
      buildTargetServices({
        ...minimal,
        papers: store,
        evidenceAuditEnabled: true,
        runtime,
        reviewerAgentId: "reviewer",
        scholarly,
        readSourceChunks: async () => null,
      }).evidenceAudit,
    ).not.toBeNull();
    // flag on 但缺 scholarly → 不装配（fail-closed，不造半套服务）
    expect(
      buildTargetServices({
        ...minimal,
        evidenceAuditEnabled: true,
        runtime,
        reviewerAgentId: "reviewer",
        readSourceChunks: async () => null,
      }).evidenceAudit,
    ).toBeNull();
  });
});

// ---- P0-B：PDF-only guideline facts ----

describe("guideline PDF-only 参考文献观测", () => {
  it("pdfReferenceStatsOf：numeric 条目计数 / 年份 / DOI 口径披露", () => {
    const { references } = pdfReferenceStatsOf(makeDocument(), 2026);
    expect(references).not.toBeNull();
    expect(references?.basis).toBe("pdf");
    expect(references?.style).toBe("numeric");
    expect(references?.entryCount).toBe(3);
    expect(references?.withDoiCount).toBe(1);
    expect(references?.doiUnidentifiableCount).toBe(2);
    expect(references?.yearUnparsedCount).toBe(0);
    expect(references?.recent10yRatio).toBeGreaterThanOrEqual(2 / 3 - 0.01);
  });

  it("年份区间分析输入：缺年份条目不进 ratio 分母但单独披露", () => {
    const document = makeDocument();
    document.chunks = document.chunks.map((chunk) =>
      chunk.sectionId === "SEC05"
        ? { ...chunk, text: "[1] Author A. Title one here. 2024.\n\n[2] Author B. Title two here without any year at all." }
        : chunk,
    );
    const { references } = pdfReferenceStatsOf(document, 2026);
    expect(references?.entryCount).toBe(2);
    expect(references?.withYearCount).toBe(1);
    expect(references?.yearUnparsedCount).toBe(1);
    expect(references?.recent10yRatio).toBe(1);
  });

  it("observeGuidelineFacts：无 .tex 且无解析产物 → source=null；有解析产物 → source=pdf 且 TeX 字段保持 null", async () => {
    const factsRoot = await mkdtemp(join(tmpdir(), "paperteam-gfacts-"));
    try {
      const factsProjects = new ProjectStore({ root: factsRoot });
      const project = await factsProjects.create("PDF facts 测试");
      const factsStore = new PaperStore(factsProjects);
      // 无 .tex、无解析产物
      const empty = await observeGuidelineFacts(factsProjects, project.id, {
        evalYear: 2026,
        loadPaperDocument: (pid) => factsStore.loadDocument(pid),
      });
      expect(empty.exists).toBe(false);
      expect(empty.source).toBeNull();
      // 有解析产物 → pdf 源（仅 references 观测）
      await factsStore.saveIngest(project.id, makeDocument());
      const facts = await observeGuidelineFacts(factsProjects, project.id, {
        evalYear: 2026,
        loadPaperDocument: (pid) => factsStore.loadDocument(pid),
      });
      expect(facts.source).toBe("pdf");
      expect(facts.references?.entryCount).toBe(3);
      expect(facts.titleCjkChars).toBeNull();
      expect(facts.keywordCount).toBeNull();
      expect(facts.abstractStructured).toBeNull();
      // 未注入 loadPaperDocument → 保持既有 NOT_EVALUATED 行为（向后兼容）
      const legacy = await observeGuidelineFacts(factsProjects, project.id, { evalYear: 2026 });
      expect(legacy.exists).toBe(false);
      expect(legacy.references).toBeNull();
    } finally {
      await rm(factsRoot, { recursive: true, force: true });
    }
  });
});
