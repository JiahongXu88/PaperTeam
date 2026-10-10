/**
 * M13.6 限流自动恢复 + 元数据字段修复回归（受控 fake，不依赖真实公网）。
 *
 * A. CitationIntegrityService × ScholarlyResolver 真实集成（重点：不是只测
 *    通用 HTTP helper）：
 *   - 429 限流条目 → PROVIDER_ERROR（≠ NOT_FOUND）+ providerError.kind +
 *     retryNotBefore（重试资格与下一次可重试时间）；
 *   - 恢复 pass：冷却结束落入预算内 → 等待后只补查限流条目（成功验证过的
 *     条目不重查、NOT_FOUND 结论不被覆盖）；
 *   - 超预算 → 如实返回 PROVIDER_ERROR；下次 verifyMetadata 自动补查
 *     （PROVIDER_ERROR 不复用；瞬时错误不进查询缓存）。
 * B. metadataProviders 字段修复（真实 Run 26/31 未核验的主因）：
 *   - OpenAlex 标题 = display_name（title 已弃用为 null）；
 *   - DOI 精确命中但响应缺标题 → verified（DOI 存在性 + 如实标注未比对）；
 *   - 标题检索候选全部缺标题 → unverifiable（不能声称 not_found）；
 *   - 429 → unverifiable + errorKind=rate_limited（区别于 not_found）。
 * C. CitationService（bib 层）恢复 pass：限流条目等待后补查成功。
 */

import { mkdir, rm, writeFile } from "node:fs/promises";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { PaperStore } from "../../src/paper/PaperStore.js";
import { CitationIntegrityService } from "../../src/citation/CitationIntegrityService.js";
import { CitationService } from "../../src/citation/CitationService.js";
import { ScholarlyResolver, type LookupOutcome, type ScholarlyProvider, type ScholarlyQuery } from "../../src/citation/scholarly.js";
import { ScholarlyHttpClient } from "../../src/citation/scholarlyHttp.js";
import { CrossRefProvider, OpenAlexProvider, type MetadataProviderContext } from "../../src/citation/metadataProviders.js";
import type { CanonicalPaperRecord } from "../../src/citation/integrity.js";
import type { PaperDocument } from "../../src/paper/types.js";

const tempRoots: string[] = [];
afterAll(async () => {
  for (const root of tempRoots.reverse()) await rm(root, { recursive: true, force: true });
});

function canonicalRecord(overrides: Partial<CanonicalPaperRecord> = {}): CanonicalPaperRecord {
  return {
    provider: "crossref",
    recordId: "10.1000/fake",
    title: "Attention Is All You Need",
    authors: ["Ashish Vaswani"],
    year: 2017,
    doi: "10.1000/fake",
    retrievedAt: "2026-10-10T00:00:00.000Z",
    ...overrides,
  };
}

/** 可脚本化 fake provider（按调用次数切换返回；统计调用） */
class ScriptedProvider implements ScholarlyProvider {
  readonly name: ScholarlyProvider["name"];
  callCount = 0;
  constructor(
    name: ScholarlyProvider["name"],
    private readonly script: (query: ScholarlyQuery, call: number) => LookupOutcome,
  ) {
    this.name = name;
  }
  async lookup(query: ScholarlyQuery): Promise<LookupOutcome> {
    this.callCount += 1;
    return this.script(query, this.callCount);
  }
}

function documentWithReferences(projectId: string, referenceLines: string[]): PaperDocument {
  const chunk = (chunkId: string, sequence: number, sectionId: string, page: number, text: string) => ({
    chunkId, sequence, pageStart: page, pageEnd: page, sectionId, text, charCount: text.length,
  });
  return {
    schemaVersion: 1,
    projectId,
    documentId: "paper-1",
    originalFileName: "x.pdf",
    bytes: 1,
    sha256: "b".repeat(64),
    parse: { parserId: "test", parsedAt: "2026-10-10T00:00:00.000Z", durationMs: 1, pageCount: 2, extractionQuality: "good" },
    pages: [
      { pageId: "P001", pageNumber: 1, text: "", charCount: 0 },
      { pageId: "P002", pageNumber: 2, text: "", charCount: 0 },
    ],
    sections: [
      { sectionId: "SEC01", title: "Introduction", level: 1, pageStart: 1, pageEnd: 1, charCount: 0, source: "toc" },
      { sectionId: "SEC02", title: "References", level: 1, pageStart: 2, pageEnd: 2, charCount: 0, source: "toc" },
    ],
    chunks: [
      chunk("C0001", 1, "SEC01", 1, "Body text with citations."),
      chunk("C0002", 2, "SEC02", 2, referenceLines.join("\n\n")),
    ],
    referencesSectionId: "SEC02",
    ingestedAt: "2026-10-10T00:00:00.000Z",
  } as PaperDocument;
}

async function makeIntegrityStack(referenceLines: string[]): Promise<{
  projectId: string;
  service: (options: { providers: ScholarlyProvider[]; rateLimitRecoveryMs?: number }) => CitationIntegrityService;
}> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-rl-"));
  tempRoots.push(root);
  const projects = new ProjectStore({ root });
  const store = new PaperStore(projects);
  const project = await projects.create("限流恢复");
  const document = documentWithReferences(project.id, referenceLines);
  await store.saveIngest(project.id, document);
  return {
    projectId: project.id,
    service: (options) =>
      new CitationIntegrityService({
        projects,
        store,
        scholarly: { providers: options.providers },
        ...(options.rateLimitRecoveryMs !== undefined ? { rateLimitRecoveryMs: options.rateLimitRecoveryMs } : {}),
      }),
  };
}

describe("A. CitationIntegrityService 限流恢复（真实集成）", () => {
  const REFERENCES = [
    "[1] Vaswani Ashish. Attention is all you need. In NeurIPS, 2017.",
    "[2] Du R. Rate limited but real. Journal of Recovery, 2026.",
  ];

  it("429 → PROVIDER_ERROR（≠ NOT_FOUND）+ providerError/retryNotBefore；预算内等待后只补查限流条目", async () => {
    const { projectId, service } = await makeIntegrityStack(REFERENCES);
    // 确定性调用序列：ref[1]=attention（crossref 第 1 次调用即 match）；
    // ref[2]=目标条目首轮限流（crossref 第 2 次调用）→ 恢复 pass 补查
    // （crossref 第 3 次调用）match。marker 词 "recovery" 取自提取器实际解析
    // 的 title（"Journal of Recovery, 2026."），在任意 title variant 下都出现
    const locked = (): LookupOutcome => ({ kind: "error", note: "429 限流", errorKind: "rate_limited", retryAfterMs: 100 });
    const targetRecord = (query: ScholarlyQuery): CanonicalPaperRecord =>
      canonicalRecord({ doi: "10.1/real", title: query.title, authors: query.authors, year: query.year });
    const crossrefQueries: ScholarlyQuery[] = [];
    const crossref: ScriptedProvider = new ScriptedProvider("crossref", (query) => {
        crossrefQueries.push(query);
        if (query.title?.toLowerCase().includes("attention")) return { kind: "match", record: canonicalRecord() };
        // 第 2 次调用 = 目标条目首轮；第 3 次 = 恢复补查
        return crossref.callCount === 2 ? locked() : { kind: "match", record: targetRecord(query) };
    });
    const openalex: ScriptedProvider = new ScriptedProvider("openalex", (query) => {
        if (!query.title?.toLowerCase().includes("recovery")) return { kind: "not_found" };
        // 目标条目只在首轮被调用一次（crossref 恢复轮即命中）→ 首次 = 限流
        return openalex.callCount === 1 ? locked() : { kind: "match", record: targetRecord(query) };
    });
    const s2 = new ScriptedProvider("semantic-scholar", (query) =>
        query.title?.toLowerCase().includes("recovery") ? locked() : { kind: "not_found" },
    );
    const arxiv = new ScriptedProvider("arxiv", (query) =>
        query.title?.toLowerCase().includes("recovery") ? locked() : { kind: "not_found" },
    );
    const instance = service({ providers: [crossref, openalex, s2, arxiv], rateLimitRecoveryMs: 5_000 });
    await instance.extract(projectId);
    const result = await instance.verifyMetadata(projectId);

    // 恢复后：两条都终态（VERIFIED），限流没有折叠成 NOT_FOUND
    expect(result.byStatus.VERIFIED).toBe(2);
    expect(result.byStatus.NOT_FOUND).toBe(0);
    expect(result.byStatus.PROVIDER_ERROR).toBe(0);
    expect(result.recovery.retried).toBe(1);
    expect(result.recovery.recovered).toBe(1);
    expect(result.recovery.waitedMs).toBeGreaterThan(0);
    // 已验证条目不被补查重跑：attention 相关查询只出现一次（首轮 crossref 命中）
    expect(crossrefQueries.filter((query) => query.title?.toLowerCase().includes("attention"))).toHaveLength(1);
    expect(crossref.callCount).toBe(3); // attention 1 + 目标条目首轮 1 + 恢复补查 1
    // 目标条目首轮：四个 provider 依次被调用一次（全部限流）；恢复轮 crossref
    // 即命中，openalex / s2 / arxiv 不再被加压
    expect(openalex.callCount).toBe(1);
    expect(s2.callCount).toBe(1);
    expect(arxiv.callCount).toBe(1);
    // 记录落盘为终态（补查成功后无 providerError）
    const records = await instance.listMetadataRecords(projectId);
    expect(records.every((record) => record.status === "VERIFIED")).toBe(true);
  });

  it("超预算 → 如实 PROVIDER_ERROR + retryNotBefore；下次 verifyMetadata 自动补查成功（PROVIDER_ERROR 不复用）", async () => {
    const { projectId, service } = await makeIntegrityStack([
      "[1] Vaswani Ashish. Attention is all you need. In NeurIPS, 2017.",
      "[2] Du R. Long cooldown paper. Journal of Patience, 2026.",
    ]);
    let limited = true;
    const crossref = new ScriptedProvider("crossref", (query) =>
      query.title?.toLowerCase().includes("attention")
        ? { kind: "match", record: canonicalRecord() }
        : { kind: "not_found" },
    );
    const openalex = new ScriptedProvider("openalex", (query) => {
      if (!query.title?.toLowerCase().includes("patience")) return { kind: "not_found" };
      return limited
        ? { kind: "error", note: "openalex 查询失败：429 限流", errorKind: "rate_limited", retryAfterMs: 300_000 }
        : { kind: "match", record: canonicalRecord({ provider: "openalex", doi: "10.1/patient", title: query.title, authors: query.authors, year: query.year }) };
    });
    // 只留 crossref 一个 not_found（< 2 quorum）：限流错误主导结论
    const s2 = new ScriptedProvider("semantic-scholar", (query) =>
      query.title?.toLowerCase().includes("patience")
        ? { kind: "error", note: "429 限流", errorKind: "rate_limited", retryAfterMs: 300_000 }
        : { kind: "not_found" },
    );
    const arxiv = new ScriptedProvider("arxiv", (query) =>
      query.title?.toLowerCase().includes("patience")
        ? { kind: "error", note: "429 限流", errorKind: "rate_limited", retryAfterMs: 300_000 }
        : { kind: "not_found" },
    );
    const instance = service({ providers: [crossref, openalex, s2, arxiv], rateLimitRecoveryMs: 500 });
    await instance.extract(projectId);
    const first = await instance.verifyMetadata(projectId);
    // 冷却 300s 超过 500ms 预算：如实返回 PROVIDER_ERROR（不阻塞、不误判 not_found）
    expect(first.byStatus.VERIFIED).toBe(1);
    expect(first.byStatus.PROVIDER_ERROR).toBe(1);
    expect(first.recovery.retried).toBe(0);
    const failed = first.records.find((record) => record.status === "PROVIDER_ERROR")!;
    expect(failed.providerError?.kind).toBe("rate_limited");
    expect(failed.retryNotBefore).toBeDefined();
    // 下一次核验：PROVIDER_ERROR 不复用 → 自动补查；provider 恢复后成功
    limited = false;
    const second = await instance.verifyMetadata(projectId);
    expect(second.reused).toBe(1); // 首条 VERIFIED 复用
    expect(second.byStatus.VERIFIED).toBe(2);
    expect(second.byStatus.PROVIDER_ERROR).toBe(0);
  });

  it("瞬时错误不进查询缓存：同 resolver 内限流条目在下一次 resolve 重新调用 provider", async () => {
    const limited: LookupOutcome = { kind: "error", note: "429", errorKind: "rate_limited", retryAfterMs: 1 };
    let calls = 0;
    const provider = new ScriptedProvider("crossref", () => {
      calls += 1;
      return limited;
    });
    const resolver = new ScholarlyResolver({ providers: [provider] });
    await resolver.resolve({ title: "Retry Me" });
    expect(calls).toBe(1);
    // 同一查询再次 resolve：错误没有被缓存，provider 被重新调用
    await resolver.resolve({ title: "Retry Me" });
    expect(calls).toBe(2);
    expect(resolver.telemetry.cacheHits).toBe(0);
  });
});

// ---- B. metadataProviders 字段修复 ----

const instantSleep = (() => Promise.resolve()) as unknown as (ms: number, signal?: AbortSignal) => Promise<void>;

function ctxWith(fetchImpl: typeof fetch): MetadataProviderContext {
  return { http: new ScholarlyHttpClient({ fetchImpl, sleep: instantSleep, maxRetries: 0 }) };
}

function jsonResponse(body: unknown, status = 200, headers: Record<string, string> = {}): Response {
  return new Response(JSON.stringify(body), { status, headers });
}

describe("B. metadataProviders 字段修复", () => {
  it("OpenAlex：标题字段 display_name（title 已弃用为 null）→ verified", async () => {
    const entry = { key: "k", type: "article" as const, title: "Observation-Centric SORT", doi: "10.1109/x" };
    const ctx = ctxWith(async () =>
      jsonResponse({
        id: "https://openalex.org/W1",
        display_name: "Observation-Centric SORT: Rethinking SORT for Robust Multi-Object Tracking",
        title: null,
        publication_year: 2023,
        authorships: [{ author: { display_name: "Jinkun Cao" } }],
      }),
    );
    const result = await new OpenAlexProvider().verify(entry, ctx);
    expect(result.status).toBe("verified");
    expect(result.matched?.title).toContain("Observation-Centric SORT");
  });

  it("CrossRef：DOI 精确命中但响应缺标题 → verified（DOI 存在性 + 如实标注未做标题比对）", async () => {
    const entry = { key: "k", type: "article" as const, title: "Some Real Paper", doi: "10.1/real" };
    const ctx = ctxWith(async () => jsonResponse({ status: "ok", message: { DOI: "10.1/real", title: [] } }));
    const result = await new CrossRefProvider().verify(entry, ctx);
    expect(result.status).toBe("verified");
    expect(result.matched?.doi).toBe("10.1/real");
    expect(result.note).toContain("未做标题比对");
  });

  it("CrossRef：标题检索候选全部缺标题 → unverifiable（不能声称 not_found）", async () => {
    const entry = { key: "k", type: "article" as const, title: "Some Paper" };
    const ctx = ctxWith(async () => jsonResponse({ message: { items: [{ DOI: "10.1/a" }, { DOI: "10.1/b" }] } }));
    const result = await new CrossRefProvider().verify(entry, ctx);
    expect(result.status).toBe("unverifiable");
    expect(result.note).toContain("缺少标题字段");
  });

  it("429 → unverifiable + errorKind=rate_limited + retryAfterMs（限流 ≠ not_found）", async () => {
    const entry = { key: "k", type: "article" as const, title: "Some Paper", doi: "10.1/x" };
    const ctx = ctxWith(async () => new Response("{}", { status: 429, headers: { "Retry-After": "2" } }));
    const result = await new CrossRefProvider().verify(entry, ctx);
    expect(result.status).toBe("unverifiable");
    expect(result.errorKind).toBe("rate_limited");
    expect(result.retryAfterMs).toBeGreaterThan(0);
    expect(result.note).toContain("429");
  });

  it("404（DOI 不存在）→ not_found（权威否定，不重试不误判限流）", async () => {
    const entry = { key: "k", type: "article" as const, title: "Ghost", doi: "10.1/ghost" };
    const ctx = ctxWith(async () => new Response("{}", { status: 404 }));
    const result = await new CrossRefProvider().verify(entry, ctx);
    expect(result.status).toBe("not_found");
    expect(result.errorKind).toBeUndefined();
  });
});

// ---- C. CitationService（bib 层）恢复 pass ----

describe("C. CitationService 限流恢复", () => {
  async function prepareBibProject(): Promise<{ store: ProjectStore; projectId: string }> {
    const root = await mkdtemp(join(tmpdir(), "paperteam-cit-rl-"));
    tempRoots.push(root);
    const store = new ProjectStore({ root });
    const project = await store.create("bib 限流");
    const manuscriptDir = store.manuscriptDir(project.id);
    await mkdir(join(manuscriptDir, "sections"), { recursive: true });
    await writeFile(
      join(manuscriptDir, "main.tex"),
      ["\\documentclass{ctexart}", "\\begin{document}", "\\input{sections/introduction}", "\\bibliographystyle{unsrt}", "\\bibliography{references}", "\\end{document}"].join("\n"),
      "utf8",
    );
    await writeFile(join(manuscriptDir, "sections", "introduction.tex"), "如 \\cite{good2020, slow2026} 所示。", "utf8");
    await writeFile(
      join(manuscriptDir, "references.bib"),
      ["@article{good2020,", "  title = {Good Paper Title},", "  year = {2020},", "  doi = {10.1/good}", "}", "@article{slow2026,", "  title = {Slow Recovery Paper},", "  year = {2026},", "  doi = {10.1/slow}", "}"].join("\n"),
      "utf8",
    );
    return { store, projectId: project.id };
  }

  it("限流条目在预算内等待后补查成功；已验证条目不被重查", async () => {
    const { store, projectId } = await prepareBibProject();
    let slowCalls = 0;
    let goodCalls = 0;
    const service = new CitationService({
      projects: store,
      fetchImpl: (async (url: string | URL | Request) => {
        const urlText = decodeURIComponent(String(url));
        if (urlText.includes("10.1/good")) {
          goodCalls += 1;
          return jsonResponse({ status: "ok", message: { title: "Good Paper Title" } });
        }
        if (urlText.includes("10.1/slow")) {
          slowCalls += 1;
          // 限流期间 crossref / openalex 的 DOI 查询都 429；恢复轮 crossref 成功
          return slowCalls <= 2
            ? new Response("{}", { status: 429, headers: { "Retry-After": "1" } })
            : jsonResponse({ status: "ok", message: { title: "Slow Recovery Paper" } });
        }
        return new Response("{}", { status: 404 });
      }) as unknown as typeof fetch,
      httpOptions: { maxRetries: 0 },
      rateLimitRecoveryMs: 5_000,
      log: () => {},
    });
    const report = await service.verify(projectId);
    expect(report.metadata.byStatus.verified).toBe(2);
    expect(report.metadata.byStatus.unverifiable).toBe(0);
    expect(slowCalls).toBe(3); // 首轮 crossref + openalex 各 1 次（限流）+ 恢复补查 1 次
    expect(goodCalls).toBe(1); // 已验证条目不被重查
  });
});
