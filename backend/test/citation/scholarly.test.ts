/**
 * M4.3.4 ScholarlyResolver / metadata verification 测试（全部 mock，无公网）：
 * VERIFIED / mismatch / ambiguous / NOT_FOUND（≠捏造）/ UNRESOLVED（≠NOT_FOUND）/
 * 重试 / 缓存 / 指纹跳过 / "不帮虚构文献凑近似结果"。
 */

import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import {
  CrossrefProvider,
  ScholarlyResolver,
  type LookupOutcome,
  type ScholarlyProvider,
  type ScholarlyQuery,
} from "../../src/citation/scholarly.js";
import type { CanonicalPaperRecord, CitationVerificationRecord } from "../../src/citation/integrity.js";
import { CitationIntegrityService } from "../../src/citation/CitationIntegrityService.js";
import { PaperStore } from "../../src/paper/PaperStore.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";
import type { PaperDocument } from "../../src/paper/types.js";

// ---- fake provider 工具 ----

class FakeProvider implements ScholarlyProvider {
  readonly name: ScholarlyProvider["name"];
  private readonly script: (query: ScholarlyQuery, call: number) => LookupOutcome;
  callCount = 0;

  constructor(
    name: ScholarlyProvider["name"],
    script: (query: ScholarlyQuery, call: number) => LookupOutcome,
  ) {
    this.name = name;
    this.script = script;
  }

  async lookup(query: ScholarlyQuery): Promise<LookupOutcome> {
    this.callCount += 1;
    return this.script(query, this.callCount);
  }
}

function canonicalRecord(overrides: Partial<CanonicalPaperRecord> = {}): CanonicalPaperRecord {
  return {
    provider: "crossref",
    recordId: "10.1000/fake",
    title: "Attention Is All You Need",
    authors: ["Ashish Vaswani", "Noam Shazeer"],
    year: 2017,
    doi: "10.1000/fake",
    retrievedAt: "2026-09-06T00:00:00.000Z",
    ...overrides,
  };
}

// ---- resolver 编排逻辑 ----

describe("M4.3.4 ScholarlyResolver（mock providers）", () => {
  it("首选来源 match → 立即定论，attempts=1", async () => {
    const crossref = new FakeProvider("crossref", () => ({ kind: "match", record: canonicalRecord() }));
    const resolver = new ScholarlyResolver({ providers: [crossref] });
    const verdict = await resolver.resolve({ title: "Attention Is All You Need", year: 2017 });
    expect(verdict.outcome).toBe("match");
    expect(verdict.canonical?.doi).toBe("10.1000/fake");
    expect(verdict.attempts).toHaveLength(1);
  });

  it("crossref error + openalex match → 继续核验并成功（失败不误判）", async () => {
    const crossref = new FakeProvider("crossref", () => ({ kind: "error", note: "crossref 查询失败：http-503" }));
    const openalex = new FakeProvider("openalex", () => ({ kind: "match", record: canonicalRecord({ provider: "openalex" }) }));
    const resolver = new ScholarlyResolver({ providers: [crossref, openalex] });
    const verdict = await resolver.resolve({ title: "Attention Is All You Need" });
    expect(verdict.outcome).toBe("match");
    expect(verdict.attempts.map((a) => a.outcome)).toEqual(["error", "match"]);
  });

  it("全部来源失败（含重试）→ UNRESOLVED（绝不 NOT_FOUND）", async () => {
    let calls = 0;
    const failing = new FakeProvider("crossref", () => {
      calls += 1;
      return { kind: "error", note: "timeout" };
    });
    const resolver = new ScholarlyResolver({ providers: [failing] });
    const verdict = await resolver.resolve({ title: "Some Paper" });
    expect(verdict.outcome).toBe("unresolved");
    expect(calls).toBe(2); // 1 次 + 1 次重试
    expect(resolver.telemetry.retries).toBe(1);
  });

  it("≥2 来源权威 not_found → NOT_FOUND；ambiguous 优先于 unresolved", async () => {
    const notFound = () => ({ kind: "not_found" }) as LookupOutcome;
    const crossref = new FakeProvider("crossref", notFound);
    const openalex = new FakeProvider("openalex", notFound);
    const resolver = new ScholarlyResolver({ providers: [crossref, openalex] });
    expect((await resolver.resolve({ title: "Ghost Paper" })).outcome).toBe("not_found");

    const ambiguous = new FakeProvider("crossref", () => ({
      kind: "ambiguous",
      candidates: [canonicalRecord({ recordId: "a", doi: undefined }), canonicalRecord({ recordId: "b", doi: undefined })],
    }));
    const nf = new FakeProvider("openalex", notFound);
    const resolver2 = new ScholarlyResolver({ providers: [ambiguous, nf] });
    const verdict2 = await resolver2.resolve({ title: "Two Versions Paper" });
    expect(verdict2.outcome).toBe("ambiguous");
  });

  it("年份错误 → mismatch（含字段差异）；±1 年容忍", async () => {
    // 真实 provider 在 pickFromSearch 内做字段比对——用真 CrossrefProvider + fake fetch 走完整路径
    const response = (record: Record<string, unknown>) =>
      ({
        ok: true,
        status: 200,
        json: async () => ({ status: "ok", message: { items: [record] } }),
      }) as unknown as Response;
    const realRecord = {
      DOI: "10.1000/fake",
      title: ["Attention Is All You Need"],
      author: [{ given: "Ashish", family: "Vaswani" }],
      issued: { "date-parts": [[2017, 6]] },
    };
    const resolver = new ScholarlyResolver({
      providers: [
        new CrossrefProvider(),
      ],
      fetchImpl: (async () => response(realRecord)) as unknown as typeof fetch,
    });
    const wrongYear = await resolver.resolve({ title: "Attention Is All You Need", year: 2020 });
    expect(wrongYear.outcome).toBe("mismatch");
    expect(wrongYear.mismatches?.[0]?.field).toBe("year");

    const tolerated = await resolver.resolve({ title: "Attention Is All You Need", year: 2018 });
    expect(tolerated.outcome).toBe("match"); // ±1 容忍（arXiv/正式发表年差）
  });

  it("【虚构文献防线】搜索返回“相近但不同”的论文 → not_found（不硬凑）", async () => {
    // 真实防线在 pickFromSearch：候选标题与查询不符时拒绝 match——用真 CrossrefProvider 走完整路径
    const fakeFetch = (async () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          status: "ok",
          message: {
            items: [
              {
                DOI: "10.1000/similar",
                title: ["Attention Is Almost All You Need Probably"],
                author: [{ given: "Some", family: "Author" }],
                issued: { "date-parts": [[2027, 1]] },
              },
            ],
          },
        }),
      }) as unknown as Response) as unknown as typeof fetch;
    const openalex = new FakeProvider("openalex", () => ({ kind: "not_found" }));
    const resolver = new ScholarlyResolver({
      providers: [new CrossrefProvider(), openalex],
      fetchImpl: fakeFetch,
    });
    const verdict = await resolver.resolve({
      title: "Quantum Frobnication Fluctuations in Imaginary Tensor Manifolds",
      year: 2027,
    });
    // crossref 候选标题与查询不符 → pickFromSearch 判 not_found（不硬凑相近结果）
    expect(verdict.attempts[0]?.outcome).toBe("not_found");
    expect(verdict.outcome).toBe("not_found");
  });

  it("查询缓存：同查询第二次零 provider 调用", async () => {
    const crossref = new FakeProvider("crossref", () => ({ kind: "match", record: canonicalRecord() }));
    const resolver = new ScholarlyResolver({ providers: [crossref] });
    await resolver.resolve({ title: "Attention Is All You Need" });
    const callsAfterFirst = crossref.callCount;
    await resolver.resolve({ title: "Attention Is All You Need" });
    expect(crossref.callCount).toBe(callsAfterFirst);
    expect(resolver.telemetry.cacheHits).toBe(1);
  });

  it("CrossrefProvider（fetch 层）：DOI 路径解析 canonical；404/5xx → error（DOI 404 ≠ 不存在）", async () => {
    const provider = new CrossrefProvider();
    const okResponse = () =>
      ({
        ok: true,
        status: 200,
        json: async () => ({
          status: "ok",
          message: {
            DOI: "10.1000/fake",
            title: ["Attention Is All You Need"],
            author: [{ given: "Ashish", family: "Vaswani" }],
            issued: { "date-parts": [[2017, 6]] },
            "container-title": "NeurIPS",
          },
        }),
      }) as unknown as Response;
    const outcome = await provider.lookup(
      { doi: "10.1000/fake", title: "Attention Is All You Need" },
      { fetchImpl: okResponse as unknown as typeof fetch, timeoutMs: 1000 },
    );
    expect(outcome.kind).toBe("match");
    if (outcome.kind === "match") {
      expect(outcome.record.authors?.[0]).toBe("Ashish Vaswani");
      expect(outcome.record.year).toBe(2017);
    }
    const notFound = await provider.lookup(
      { doi: "10.9999/none" },
      {
        fetchImpl: (async () => ({ ok: false, status: 404 }) as Response) as unknown as typeof fetch,
        timeoutMs: 1000,
      },
    );
    expect(notFound.kind).toBe("error"); // DOI 404 只说明 Crossref 没有，不是全局不存在
  });
});

// ---- service 层（真实持久化 + 指纹跳过） ----

function integrityDocument(): PaperDocument {
  const chunk = (id: string, sequence: number, sectionId: string, page: number, text: string) => ({
    chunkId: id,
    sequence,
    pageStart: page,
    pageEnd: page,
    sectionId,
    text,
    charCount: text.length,
  });
  return {
    schemaVersion: 1,
    projectId: "p-integrity",
    documentId: "paper-1",
    originalFileName: "x.pdf",
    bytes: 1,
    sha256: "b".repeat(64),
    parse: {
      parserId: "test",
      parsedAt: "2026-09-06T00:00:00.000Z",
      durationMs: 1,
      pageCount: 2,
      extractionQuality: "good",
    },
    pages: [
      { pageId: "P001", pageNumber: 1, text: "", charCount: 0 },
      { pageId: "P002", pageNumber: 2, text: "", charCount: 0 },
    ],
    sections: [
      { sectionId: "SEC01", title: "Introduction", level: 1, pageStart: 1, pageEnd: 1, charCount: 0, source: "toc" },
      { sectionId: "SEC02", title: "References", level: 1, pageStart: 2, pageEnd: 2, charCount: 0, source: "toc" },
    ],
    chunks: [
      chunk("C0001", 1, "SEC01", 1, "Attention was proposed [1]. A ghost citation [2]."),
      chunk(
        "C0002",
        2,
        "SEC02",
        2,
        [
          "[1] Vaswani Ashish, Shazeer Noam. Attention is all you need. In NeurIPS, 2017.",
          "[2] Zhang Q. Quantum frobnication fluctuations in imaginary tensor manifolds. Journal of Nothing, 2027.",
        ].join("\n\n"),
      ),
    ],
    referencesSectionId: "SEC02",
    ingestedAt: "2026-09-06T00:00:00.000Z",
  };
}

describe("M4.3.4 CitationIntegrityService.verifyMetadata（持久化/指纹跳过/捏造判定）", () => {
  let root: string;
  let projects: ProjectStore;
  let store: PaperStore;
  let projectId: string;
  let crossref: FakeProvider;
  let openalex: FakeProvider;
  let s2: FakeProvider;
  let arxiv: FakeProvider;
  let service: CitationIntegrityService;

  beforeAll(async () => {
    root = await mkdtemp(join(tmpdir(), "paperteam-scholarly-"));
    projects = new ProjectStore({ root });
    store = new PaperStore(projects);
    const project = await projects.create("metadata 核验");
    projectId = project.id;
    const document = integrityDocument();
    document.projectId = projectId;
    await store.saveIngest(projectId, document);

    crossref = new FakeProvider("crossref", (query) => {
      if (query.title?.toLowerCase().includes("attention")) {
        return { kind: "match", record: canonicalRecord() };
      }
      return { kind: "not_found" };
    });
    openalex = new FakeProvider("openalex", () => ({ kind: "not_found" }));
    s2 = new FakeProvider("semantic-scholar", () => ({ kind: "not_found" }));
    arxiv = new FakeProvider("arxiv", (query) => {
      if (query.title?.toLowerCase().includes("attention")) {
        return { kind: "match", record: canonicalRecord({ provider: "arxiv" }) };
      }
      return { kind: "not_found" };
    });
    service = new CitationIntegrityService({
      projects,
      store,
      scholarly: { providers: [crossref, openalex, s2, arxiv] },
    });
  });

  afterAll(async () => {
    await rm(root, { recursive: true, force: true });
  });

  it("真实文献 VERIFIED / 虚构文献 NOT_FOUND + probableFabrication（3 源一致无 error）", async () => {
    await service.extract(projectId);
    const result = await service.verifyMetadata(projectId);
    expect(result.byStatus.VERIFIED).toBe(1);
    expect(result.byStatus.NOT_FOUND).toBe(1);
    const verified = result.records.find((r) => r.status === "VERIFIED")!;
    expect(verified.canonical?.provider).toBe("crossref");
    expect(verified.probableFabrication).toBe(false);
    const ghost = result.records.find((r) => r.status === "NOT_FOUND")!;
    expect(ghost.probableFabrication).toBe(true); // 4 源一致 not_found（attention 走 match 提前返回）
    expect(ghost.attempts.every((a) => a.outcome === "not_found")).toBe(true);
    // 记录持久化
    const persisted = await service.listMetadataRecords(projectId);
    expect(persisted).toHaveLength(2);
  });

  it("指纹跳过：重跑零 provider 调用；records 从磁盘复用", async () => {
    const callsBefore = crossref.callCount;
    const again = await service.verifyMetadata(projectId);
    expect(again.reused).toBe(2);
    expect(crossref.callCount).toBe(callsBefore);
    expect(again.byStatus.VERIFIED).toBe(1);
  });
});
