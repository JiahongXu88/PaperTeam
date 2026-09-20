/**
 * M7.2 FullText 挂载域测试：SourceStore.attachFile / setFullTextProvenance、
 * SourceImportService.tryResolveFullText 五结局、promote 后台自动解析、
 * 离线验收链（promote → 全文挂载 → chunk 落盘 → retrieve 可检索 → chunk 回取）。
 *
 * 全部离线：resolver / download 均为注入 fake；PDF 为手工构造的最小文本层文档。
 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { EvidenceStore } from "../../src/evidence/EvidenceStore.js";
import { CandidateStore } from "../../src/sources/CandidateStore.js";
import { SourceImportService, type FullTextSupport } from "../../src/sources/SourceImportService.js";
import { SourceStore } from "../../src/sources/SourceStore.js";
import { ChunkStore } from "../../src/retrieval/ChunkStore.js";
import { RetrievalService } from "../../src/retrieval/RetrievalService.js";
import { SourceChunker } from "../../src/retrieval/SourceChunker.js";
import { ChunkAccess } from "../../src/evidence/chunkAccess.js";
import type { FullTextResolution, FullTextResolver } from "../../src/search/fullText.js";
import { ProviderHttpClient } from "../../src/search/providerHttp.js";

const tempRoots: string[] = [];
afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

/** 带文本层的最小 PDF（≥200 字符 → builtin 分析 ok + chunker 可索引） */
function buildTextPdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td (${text.replace(/[()\\]/g, " ")}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
  ];
  const parts: string[] = ["%PDF-1.4"];
  let offset = parts[0]!.length + 1;
  const offsets: number[] = [];
  objects.forEach((body, index) => {
    offsets.push(offset);
    const object = `${index + 1} 0 obj\n${body}\nendobj\n`;
    parts.push(object);
    offset += object.length;
  });
  let xref = `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`;
  for (const off of offsets) {
    xref += `${String(off).padStart(10, "0")} 00000 n \n`;
  }
  parts.push(`${xref}trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${offset}\n%%EOF\n`);
  return Buffer.from(parts.join("\n"), "latin1");
}

const PDF_TEXT =
  "PaperTeam fulltext integration marker. Lexical retrieval quality validation sentence. ".repeat(4);
const PDF_BYTES = buildTextPdf(PDF_TEXT);

interface Fixture {
  projects: ProjectStore;
  sources: SourceStore;
  candidates: CandidateStore;
  evidence: EvidenceStore;
  importer: SourceImportService;
  projectId: string;
  root: string;
}

async function newFixture(): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-ft-"));
  tempRoots.push(root);
  const projects = new ProjectStore({ root });
  const project = await projects.create("全文解析测试");
  const sources = new SourceStore(projects);
  const candidates = new CandidateStore(projects);
  const evidence = new EvidenceStore(projects);
  const importer = new SourceImportService({ projects, sources, candidates, evidence });
  return { projects, sources, candidates, evidence, importer, projectId: project.id, root };
}

/** 可编程 fake resolver（按 name 报告预设 resolution） */
function fakeResolver(name: string, behavior: () => FullTextResolution | Promise<FullTextResolution>): FullTextResolver {
  return {
    name,
    async resolve(_identity) {
      return behavior();
    },
  };
}

/** 记录调用 URL 的 fake 下载（绕过真实网络） */
function fakeDownload(results: Array<{ bytes?: Buffer; error?: Error }>) {
  const urls: string[] = [];
  const download = async (url: string): Promise<{ bytes: Buffer; fileName: string; finalUrl: string }> => {
    urls.push(url);
    const result = results[Math.min(urls.length - 1, results.length - 1)]!;
    if (result.error !== undefined) {
      throw result.error;
    }
    return { bytes: result.bytes ?? PDF_BYTES, fileName: "downloaded.pdf", finalUrl: url };
  };
  return { download, urls };
}

/** 不应被触达的 http（download 注入后 http 仅作类型占位） */
const deadHttp = new ProviderHttpClient({
  fetchImpl: async () => {
    throw new Error("test: 不应发生真实网络调用");
  },
});

function supportOf(overrides: Partial<FullTextSupport> & { resolvers: FullTextResolver[] }): FullTextSupport & {
  hookCalls: Array<{ projectId: string; sourceId: string }>;
} {
  const hookCalls: Array<{ projectId: string; sourceId: string }> = [];
  return {
    resolvers: overrides.resolvers,
    http: deadHttp,
    ...(overrides.download !== undefined ? { download: overrides.download } : {}),
    ...(overrides.onFullTextAttached !== undefined
      ? { onFullTextAttached: overrides.onFullTextAttached }
      : {
          onFullTextAttached: async (projectId, sourceId) => {
            hookCalls.push({ projectId, sourceId });
          },
        }),
    hookCalls,
  };
}

async function until(
  condition: () => boolean | Promise<boolean>,
  timeoutMs = 5_000,
  what = "条件",
): Promise<void> {
  const start = Date.now();
  for (;;) {
    if (await condition()) {
      return;
    }
    if (Date.now() - start > timeoutMs) {
      throw new Error(`等待超时：${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 10));
  }
}

// ---- SourceStore.attachFile / setFullTextProvenance ----

describe("SourceStore.attachFile", () => {
  it("metadata_only → 原地挂载：fileName/contentHash/bytes/sourceType=pdf/status=pending", async () => {
    const f = await newFixture();
    const { source } = await f.importer.importDoi(f.projectId, { doi: "10.1234/attach", enrich: false });
    expect(source.status).toBe("metadata_only");
    const result = await f.sources.attachFile(f.projectId, source.sourceId, {
      fileName: "paper.pdf",
      content: PDF_BYTES,
      originalName: "https://publisher.org/paper.pdf",
    });
    expect(result.attached).toBe(true);
    expect(result.source.fileName).toBe(`${source.sourceId}-paper.pdf`);
    expect(result.source.status).toBe("pending");
    expect(result.source.sourceType).toBe("pdf"); // F-1：chunker 类型开关
    expect(result.source.contentHash).toHaveLength(64);
    expect(result.source.bytes).toBe(PDF_BYTES.byteLength);
    expect(result.source.originalName).toBe("https://publisher.org/paper.pdf");
    expect(
      existsSync(join(f.projects.sourcesDir(f.projectId), "papers", result.source.fileName!)),
    ).toBe(true);
  });

  it("重复 attach 幂等（attached=false，条目不变）", async () => {
    const f = await newFixture();
    const { source } = await f.importer.importArxiv(f.projectId, { arxivId: "2401.00003", enrich: false });
    const first = await f.sources.attachFile(f.projectId, source.sourceId, {
      content: PDF_BYTES,
    });
    expect(first.attached).toBe(true);
    const second = await f.sources.attachFile(f.projectId, source.sourceId, {
      fileName: "other.pdf",
      content: Buffer.from("%PDF-1.4 other"),
    });
    expect(second.attached).toBe(false);
    expect(second.source.fileName).toBe(first.source.fileName);
  });

  it("非 PDF 文件名拒绝；空内容拒绝", async () => {
    const f = await newFixture();
    const { source } = await f.importer.importDoi(f.projectId, { doi: "10.1234/bad", enrich: false });
    await expect(
      f.sources.attachFile(f.projectId, source.sourceId, { fileName: "paper.txt", content: Buffer.from("x") }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      f.sources.attachFile(f.projectId, source.sourceId, { fileName: "paper.pdf", content: Buffer.alloc(0) }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("provenance 落盘可审计（restart 语义：新 store 实例读同一 workspace）", async () => {
    const f = await newFixture();
    const { source } = await f.importer.importDoi(f.projectId, { doi: "10.1234/prov", enrich: false });
    await f.sources.setFullTextProvenance(f.projectId, source.sourceId, {
      status: "resolved",
      resolver: "unpaywall",
      url: "https://publisher.org/oa/x.pdf",
      license: "cc-by",
      attempts: 1,
      attemptedAt: "2026-09-20T00:00:00.000Z",
      resolvedAt: "2026-09-20T00:00:05.000Z",
      bytes: 1234,
    });
    const reopened = new SourceStore(new ProjectStore({ root: f.root }));
    const item = await reopened.getRequired(f.projectId, source.sourceId);
    expect(item.fullText).toMatchObject({
      status: "resolved",
      resolver: "unpaywall",
      license: "cc-by",
      attempts: 1,
      bytes: 1234,
    });
  });
});

// ---- SourceImportService.tryResolveFullText ----

describe("tryResolveFullText", () => {
  it("未装配 FullTextSupport → 干净 no-op（M7.1 行为不变）", async () => {
    const f = await newFixture();
    const { source } = await f.importer.importDoi(f.projectId, { doi: "10.1234/noop", enrich: false });
    const result = await f.importer.tryResolveFullText(f.projectId, source.sourceId);
    expect(result.outcome).toBe("not_resolvable");
    expect(result.note).toContain("未装配");
    expect(result.source.status).toBe("metadata_only");
  });

  it("成功路径：found + 下载 → attach + 分析 ok（available）+ provenance + 重建钩子", async () => {
    const f = await newFixture();
    const { source } = await f.importer.importDoi(f.projectId, { doi: "10.1234/oa-ok", enrich: false });
    const support = supportOf({
      resolvers: [
        fakeResolver("unpaywall", () => ({
          kind: "found",
          url: "https://publisher.org/oa/ok.pdf",
          source: "unpaywall",
          license: "cc-by",
        })),
      ],
      download: fakeDownload([{}]).download,
    });
    f.importer.attachFullTextSupport(support);
    const result = await f.importer.tryResolveFullText(f.projectId, source.sourceId);
    expect(result.outcome).toBe("resolved");
    expect(result.source.status).toBe("available"); // 文本层 ≥200 字符 → 分析 ok
    expect(result.source.fileName).toBe(`${source.sourceId}-downloaded.pdf`);
    expect(result.source.sourceType).toBe("pdf");
    expect(result.source.fullText).toMatchObject({
      status: "resolved",
      resolver: "unpaywall",
      url: "https://publisher.org/oa/ok.pdf",
      license: "cc-by",
      attempts: 1,
    });
    expect(result.source.fullText?.resolvedAt).toBeDefined();
    expect(result.source.fullText?.bytes).toBe(PDF_BYTES.byteLength);
    expect(support.hookCalls).toEqual([{ projectId: f.projectId, sourceId: source.sourceId }]);
    expect(existsSync(join(f.projects.sourcesDir(f.projectId), "parsed", `${source.sourceId}.json`))).toBe(true);
  });

  it("not_found：resolver 明确无 OA → 保持 metadata_only + provenance 如实", async () => {
    const f = await newFixture();
    const { source } = await f.importer.importDoi(f.projectId, { doi: "10.1234/closed", enrich: false });
    f.importer.attachFullTextSupport(
      supportOf({ resolvers: [fakeResolver("unpaywall", () => ({ kind: "not_found" }))] }),
    );
    const result = await f.importer.tryResolveFullText(f.projectId, source.sourceId);
    expect(result.outcome).toBe("not_found");
    expect(result.source.status).toBe("metadata_only");
    expect(result.source.fileName).toBeUndefined();
    expect(result.source.fullText).toMatchObject({ status: "not_found", attempts: 1 });
    expect(result.source.fullText?.note).toContain("not_found");
  });

  it("failed：resolver error → outcome=failed；重试 attempts 递增", async () => {
    const f = await newFixture();
    const { source } = await f.importer.importDoi(f.projectId, { doi: "10.1234/flaky", enrich: false });
    f.importer.attachFullTextSupport(
      supportOf({
        resolvers: [fakeResolver("unpaywall", () => ({ kind: "error", note: "api 不可达" }))],
      }),
    );
    const first = await f.importer.tryResolveFullText(f.projectId, source.sourceId);
    expect(first.outcome).toBe("failed");
    expect(first.source.fullText).toMatchObject({ status: "failed", attempts: 1 });
    const second = await f.importer.tryResolveFullText(f.projectId, source.sourceId);
    expect(second.source.fullText?.attempts).toBe(2);
    expect(second.source.status).toBe("metadata_only");
  });

  it("下载失败降级到链上下一个 resolver（有界尝试不重试风暴）", async () => {
    const f = await newFixture();
    const { source } = await f.importer.importDoi(f.projectId, { doi: "10.1234/fallthrough", enrich: false });
    const { download, urls } = fakeDownload([
      { error: new Error("403 Forbidden") },
      {},
    ]);
    f.importer.attachFullTextSupport(
      supportOf({
        resolvers: [
          fakeResolver("unpaywall", () => ({
            kind: "found",
            url: "https://publisher.org/paywalled.pdf",
            source: "unpaywall",
          })),
          fakeResolver("oa-url", () => ({
            kind: "found",
            url: "https://repo.example.org/open.pdf",
            source: "oa-url",
            license: "cc-by-4.0",
          })),
        ],
        download,
      }),
    );
    const result = await f.importer.tryResolveFullText(f.projectId, source.sourceId);
    expect(result.outcome).toBe("resolved");
    expect(result.source.fullText?.resolver).toBe("oa-url");
    expect(urls).toEqual(["https://publisher.org/paywalled.pdf", "https://repo.example.org/open.pdf"]);
  });

  it("已有文件 → skipped_has_file（幂等）", async () => {
    const f = await newFixture();
    const { source } = await f.importer.importArxiv(f.projectId, { arxivId: "2401.00004", enrich: false });
    await f.sources.attachFile(f.projectId, source.sourceId, { content: PDF_BYTES });
    f.importer.attachFullTextSupport(
      supportOf({ resolvers: [fakeResolver("arxiv", () => ({ kind: "found", url: "https://arxiv.org/pdf/2401.00004", source: "arxiv" }))] }),
    );
    const result = await f.importer.tryResolveFullText(f.projectId, source.sourceId);
    expect(result.outcome).toBe("skipped_has_file");
  });

  it("url-only 身份（Web 候选）→ not_resolvable，如实记录不报错", async () => {
    const f = await newFixture();
    const { source } = await f.importer.importUrl(f.projectId, { url: "https://blog.example.org/post" });
    f.importer.attachFullTextSupport(supportOf({ resolvers: [fakeResolver("unpaywall", () => ({ kind: "not_found" }))] }));
    const result = await f.importer.tryResolveFullText(f.projectId, source.sourceId);
    expect(result.outcome).toBe("not_resolvable");
    expect(result.note).toContain("Web 候选");
    expect(result.source.fullText).toMatchObject({ status: "not_found" });
    expect(result.source.status).toBe("metadata_only");
  });
});

// ---- promote 后台自动解析 ----

describe("promoteCandidate → 后台全文尝试", () => {
  it("promote 不阻塞响应；后台单次尝试最终到达 available + resolved provenance", async () => {
    const f = await newFixture();
    f.importer.attachFullTextSupport(
      supportOf({
        resolvers: [
          fakeResolver("unpaywall", () => ({
            kind: "found",
            url: "https://publisher.org/oa/promoted.pdf",
            source: "unpaywall",
            license: "cc-by",
          })),
        ],
        download: fakeDownload([{}]).download,
      }),
    );
    const added = await f.importer.addCandidate(f.projectId, {
      doi: "10.1234/promoted",
      title: "Promoted Paper",
      origin: "academic_search",
      provider: "openalex",
    });
    const promoted = await f.importer.promoteCandidate(f.projectId, added.candidate.candidateId);
    // 响应即刻返回（此时可能仍是 metadata_only——后台尝试异步进行）
    expect(["metadata_only", "available"]).toContain(promoted.source.status);
    const sourceId = promoted.source.sourceId;
    // 终态判定等 fullText provenance（resolved 路径的最后一次索引写入），非仅 status
    await until(async () => {
      const item = await f.sources.get(f.projectId, sourceId);
      return item?.fullText?.status === "resolved";
    }, 5_000, "后台全文解析完成");
    const item = await f.sources.getRequired(f.projectId, sourceId);
    expect(item.status).toBe("available");
    expect(item.fullText).toMatchObject({ status: "resolved", resolver: "unpaywall", license: "cc-by" });
    expect(item.origin).toBe("AGENT_RETRIEVED");
  });

  it("未装配全文能力：promote 行为与 M7.1 一致（无后台副作用）", async () => {
    const f = await newFixture();
    const added = await f.importer.addCandidate(f.projectId, { doi: "10.1234/plain", title: "Plain" });
    const promoted = await f.importer.promoteCandidate(f.projectId, added.candidate.candidateId);
    expect(promoted.source.status).toBe("metadata_only");
    expect(promoted.source.fullText).toBeUndefined();
  });
});

// ---- 离线验收链（对应 SCOPE_FREEZE §M7.2 验收 ① 的离线形态） ----

describe("验收链：promote → 全文 → chunk → 检索 → chunk 回取", () => {
  it("同一 sourceId 单线闭合（N-1 根除），retrieve_library 可检索，chunk 锚点可回取", async () => {
    const f = await newFixture();
    const chunkStore = new ChunkStore(f.projects);
    const retrieval = new RetrievalService({
      projects: f.projects,
      sources: f.sources,
      chunker: new SourceChunker({}), // 无 pymupdf → builtin 文本层回退（≥200 字符可索引）
      chunkStore,
    });
    const chunkAccess = new ChunkAccess({ projects: f.projects, chunkStore, sources: f.sources });
    f.importer.attachFullTextSupport({
      resolvers: [
        fakeResolver("unpaywall", () => ({
          kind: "found",
          url: "https://publisher.org/oa/chain.pdf",
          source: "unpaywall",
          license: "cc-by",
        })),
      ],
      http: deadHttp,
      download: fakeDownload([{}]).download,
      onFullTextAttached: async (projectId, sourceId) => {
        await retrieval.rebuildSource(projectId, sourceId);
      },
    });

    const added = await f.importer.addCandidate(f.projectId, {
      doi: "10.1234/chain",
      title: "Chain Paper",
      snippetOrAbstract: "A paper for the offline acceptance chain.",
    });
    const promoted = await f.importer.promoteCandidate(f.projectId, added.candidate.candidateId);
    const sourceId = promoted.source.sourceId;
    // 终态 = provenance resolved 且 chunk 落盘（重建钩子在 provenance 写之后执行）
    const chunkFile = join(f.projects.sourcesDir(f.projectId), "chunks", `${sourceId}.jsonl`);
    await until(async () => {
      const item = await f.sources.get(f.projectId, sourceId);
      return item?.fullText?.status === "resolved" && existsSync(chunkFile);
    }, 5_000, "全文挂载 + chunk 重建");

    // chunk 落盘 + 同 sourceId（追溯链闭合：verified ← chunk ← library ← promote ← candidate）
    expect(existsSync(chunkFile)).toBe(true);
    const raw = await readFile(chunkFile, "utf8");
    const firstChunk = JSON.parse(raw.split("\n")[0]!) as { chunkId: string; text: string };
    expect(firstChunk.chunkId.startsWith(`${sourceId}:`)).toBe(true);

    // retrieve_library 语义（HTTP / 检索工具共用同一 search）
    const search = await retrieval.search(f.projectId, "fulltext integration marker", { topK: 5 });
    expect(search.results.length).toBeGreaterThan(0);
    expect(search.results.some((hit) => hit.chunk.sourceId === sourceId)).toBe(true);

    // chunk 锚点可回取（propose_evidence 的前置校验路径）
    const resolved = await chunkAccess.resolve(f.projectId, firstChunk.chunkId);
    expect(resolved.chunk.text).toContain("PaperTeam fulltext integration marker");
    expect(resolved.source.sourceId).toBe(sourceId);
    expect(resolved.source.fullText?.status).toBe("resolved");
  });
});
