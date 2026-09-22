/**
 * M9.3 批量全文解析 + 手动 PDF 补挂（域测试，全部离线）：
 *
 * - resolveFullTextBatch：mixed 五桶汇总 / partial success（失败不回滚成功）/
 *   mapWithConcurrency 有界并发（maxActive ≤ limit）/ 幂等（已有全文 skipped）/
 *   去重保序 / 不存在条目整体 400；
 * - attachManualFullText：成功挂载 + manual-upload provenance + 分析 + 重建钩子 /
 *   已有文件幂等跳过 / 非 PDF 魔数拒绝 / 非 .pdf 文件名拒绝 / 超限拒绝 /
 *   手动挂载后 chunk 可检索（RetrievalService 真实链路）；
 * - 边界：Web（url-only）身份不进 resolver / 不触发下载；全文操作零 Evidence 写入；
 *   老数据（无 fullText 字段）条目照常工作。
 */

import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { EvidenceStore } from "../../src/evidence/EvidenceStore.js";
import { CandidateStore } from "../../src/sources/CandidateStore.js";
import {
  SourceImportService,
  type FullTextSupport,
} from "../../src/sources/SourceImportService.js";
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
  "PaperTeam manual fulltext marker. Batch resolve integration sentence. ".repeat(4);
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

async function newFixture(batchConcurrency?: number): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-ftb-"));
  tempRoots.push(root);
  const projects = new ProjectStore({ root });
  const project = await projects.create("批量全文测试");
  const sources = new SourceStore(projects);
  const candidates = new CandidateStore(projects);
  const evidence = new EvidenceStore(projects);
  const importer = new SourceImportService({
    projects,
    sources,
    candidates,
    evidence,
    ...(batchConcurrency !== undefined ? { batchConcurrency } : {}),
  });
  return { projects, sources, candidates, evidence, importer, projectId: project.id, root };
}

/** 按 DOI 前缀路由的 fake resolver（行为表驱动） */
function routingResolver(
  table: Record<string, () => FullTextResolution>,
): FullTextResolver {
  return {
    name: "unpaywall",
    async resolve(identity) {
      if (identity.doi === undefined) {
        return { kind: "not_found" };
      }
      const behavior = table[identity.doi];
      return behavior !== undefined ? behavior() : { kind: "not_found" };
    },
  };
}

const deadHttp = new ProviderHttpClient({
  fetchImpl: async () => {
    throw new Error("test: 不应发生真实网络调用");
  },
});

/** 记录 URL 的 fake 下载（并发观测 + Web 边界断言用） */
function trackingDownload(delayMs = 0) {
  const urls: string[] = [];
  let active = 0;
  let maxActive = 0;
  const download = async (url: string): Promise<{ bytes: Buffer; fileName: string; finalUrl: string }> => {
    active += 1;
    maxActive = Math.max(maxActive, active);
    try {
      if (delayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, delayMs));
      }
      urls.push(url);
      return { bytes: PDF_BYTES, fileName: "downloaded.pdf", finalUrl: url };
    } finally {
      active -= 1;
    }
  };
  return { download, urls, maxActive: () => maxActive };
}

// ---- resolveFullTextBatch ----

describe("resolveFullTextBatch", () => {
  it("mixed 五桶：resolved / not_found / failed / not_resolvable / skipped 汇总与逐条结果", async () => {
    const f = await newFixture();
    // 预置：一条已有全文（skipped）+ 一条 url-only（not_resolvable）
    const withFile = await f.importer.importArxiv(f.projectId, { arxivId: "2401.00011", enrich: false });
    await f.sources.attachFile(f.projectId, withFile.source.sourceId, { content: PDF_BYTES });
    const webSource = await f.importer.importUrl(f.projectId, { url: "https://blog.example.org/searxng-hit" });

    const download = trackingDownload();
    f.importer.attachFullTextSupport({
      resolvers: [
        routingResolver({
          "10.1234/batch-ok": () => ({ kind: "found", url: "https://publisher.org/oa/batch-ok.pdf", source: "unpaywall" }),
          "10.1234/batch-closed": () => ({ kind: "not_found" }),
          "10.1234/batch-flaky": () => ({ kind: "error", note: "api 不可达" }),
        }),
      ],
      http: deadHttp,
      download: download.download,
    });
    const ok = await f.importer.importDoi(f.projectId, { doi: "10.1234/batch-ok", enrich: false });
    const closed = await f.importer.importDoi(f.projectId, { doi: "10.1234/batch-closed", enrich: false });
    const flaky = await f.importer.importDoi(f.projectId, { doi: "10.1234/batch-flaky", enrich: false });

    const result = await f.importer.resolveFullTextBatch(f.projectId, [
      ok.source.sourceId,
      closed.source.sourceId,
      flaky.source.sourceId,
      webSource.source.sourceId,
      withFile.source.sourceId,
    ]);

    expect(result.summary).toEqual({
      total: 5,
      resolved: 1,
      notFound: 1,
      failed: 1,
      notResolvable: 1,
      skipped: 1,
    });
    // 逐条结果按输入顺序（去重后）
    expect(result.results.map((entry) => entry.sourceId)).toEqual([
      ok.source.sourceId,
      closed.source.sourceId,
      flaky.source.sourceId,
      webSource.source.sourceId,
      withFile.source.sourceId,
    ]);
    expect(result.results[0]).toMatchObject({ outcome: "resolved" });
    expect(result.results[1]).toMatchObject({ outcome: "not_found" });
    expect(result.results[2]).toMatchObject({ outcome: "failed" });
    expect(result.results[3]).toMatchObject({ outcome: "not_resolvable" });
    expect(result.results[4]).toMatchObject({ outcome: "skipped_has_file" });

    // partial success：成功项保留（文件 + provenance 落盘），失败项不影响
    const okItem = await f.sources.getRequired(f.projectId, ok.source.sourceId);
    expect(okItem.fileName).toBe(`${ok.source.sourceId}-downloaded.pdf`);
    expect(okItem.fullText).toMatchObject({ status: "resolved", resolver: "unpaywall" });
    const closedItem = await f.sources.getRequired(f.projectId, closed.source.sourceId);
    expect(closedItem.status).toBe("metadata_only");
    expect(closedItem.fileName).toBeUndefined();
    // Web 候选定位的条目不被误下载（唯一一次下载是 DOI 命中项）
    expect(download.urls).toEqual(["https://publisher.org/oa/batch-ok.pdf"]);
  });

  it("有界并发：maxActive ≤ batchConcurrency，且结果顺序与输入一致", async () => {
    const f = await newFixture(2);
    const ids: string[] = [];
    for (let i = 0; i < 6; i += 1) {
      const { source } = await f.importer.importDoi(f.projectId, { doi: `10.1234/par-${i}`, enrich: false });
      ids.push(source.sourceId);
    }
    const download = trackingDownload(15);
    f.importer.attachFullTextSupport({
      resolvers: [
        routingResolver(Object.fromEntries(
          ids.map((_, index) => [`10.1234/par-${index}`, () => ({ kind: "found" as const, url: `https://publisher.org/oa/par-${index}.pdf`, source: "unpaywall" })]),
        )),
      ],
      http: deadHttp,
      download: download.download,
    });
    const shuffled = [...ids].reverse();
    const result = await f.importer.resolveFullTextBatch(f.projectId, shuffled);
    expect(result.summary).toEqual({ total: 6, resolved: 6, notFound: 0, failed: 0, notResolvable: 0, skipped: 0 });
    expect(result.results.map((entry) => entry.sourceId)).toEqual(shuffled);
    expect(download.maxActive()).toBeLessThanOrEqual(2);
    expect(download.maxActive()).toBeGreaterThanOrEqual(2); // 并行真实发生（不是串行退化）
  });

  it("幂等：第二批全部 skipped，不重复下载", async () => {
    const f = await newFixture();
    const { source } = await f.importer.importDoi(f.projectId, { doi: "10.1234/idem", enrich: false });
    const download = trackingDownload();
    f.importer.attachFullTextSupport({
      resolvers: [
        routingResolver({
          "10.1234/idem": () => ({ kind: "found", url: "https://publisher.org/oa/idem.pdf", source: "unpaywall" }),
        }),
      ],
      http: deadHttp,
      download: download.download,
    });
    const first = await f.importer.resolveFullTextBatch(f.projectId, [source.sourceId]);
    expect(first.summary.resolved).toBe(1);
    const second = await f.importer.resolveFullTextBatch(f.projectId, [source.sourceId]);
    expect(second.summary).toEqual({ total: 1, resolved: 0, notFound: 0, failed: 0, notResolvable: 0, skipped: 1 });
    expect(download.urls).toHaveLength(1);
  });

  it("重复 id 去重（保序）；不存在的条目整体 INVALID_REQUEST", async () => {
    const f = await newFixture();
    const { source } = await f.importer.importDoi(f.projectId, { doi: "10.1234/dup", enrich: false });
    f.importer.attachFullTextSupport({
      resolvers: [routingResolver({})],
      http: deadHttp,
    });
    const result = await f.importer.resolveFullTextBatch(f.projectId, [
      source.sourceId,
      source.sourceId,
    ]);
    expect(result.summary.total).toBe(1);
    await expect(
      f.importer.resolveFullTextBatch(f.projectId, [source.sourceId, "S999"]),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("未装配 FullTextSupport：全部 not_resolvable（干净降级，不抛错）", async () => {
    const f = await newFixture();
    const { source } = await f.importer.importDoi(f.projectId, { doi: "10.1234/noop", enrich: false });
    const result = await f.importer.resolveFullTextBatch(f.projectId, [source.sourceId]);
    expect(result.summary).toEqual({ total: 1, resolved: 0, notFound: 0, failed: 0, notResolvable: 1, skipped: 0 });
  });

  it("SourceStore 并发写不丢更新（项目写队列回归锚：attachFile 不被并发 provenance 写覆盖）", async () => {
    const f = await newFixture();
    const a = await f.importer.importDoi(f.projectId, { doi: "10.1234/race-a", enrich: false });
    const b = await f.importer.importDoi(f.projectId, { doi: "10.1234/race-b", enrich: false });
    // 五路并发混合全部读-改-写原语（batch 场景的最小化重现）
    await Promise.all([
      f.sources.attachFile(f.projectId, a.source.sourceId, { fileName: "race.pdf", content: PDF_BYTES }),
      f.sources.setFullTextProvenance(f.projectId, b.source.sourceId, {
        status: "not_found",
        attempts: 1,
        attemptedAt: new Date().toISOString(),
      }),
      f.sources.applyMetadataMerge(f.projectId, b.source.sourceId, {
        metadata: { title: "Race B" },
        provenance: "inferred",
      }),
      f.sources.update(f.projectId, a.source.sourceId, { preferred: true }),
      f.sources.setFullTextProvenance(f.projectId, a.source.sourceId, {
        status: "failed",
        attempts: 1,
        attemptedAt: new Date().toISOString(),
      }),
    ]);
    const itemA = await f.sources.getRequired(f.projectId, a.source.sourceId);
    const itemB = await f.sources.getRequired(f.projectId, b.source.sourceId);
    // A：文件 + preferred + provenance 三者共存（任一被快照覆盖即丢）
    expect(itemA.fileName).toBe(`${a.source.sourceId}-race.pdf`);
    expect(itemA.preferred).toBe(true);
    expect(itemA.fullText).toMatchObject({ status: "failed", attempts: 1 });
    // B：provenance 与元数据合并共存
    expect(itemB.fullText).toMatchObject({ status: "not_found", attempts: 1 });
    expect(itemB.metadata.title).toBe("Race B");
    expect(itemB.fileName).toBeUndefined();
  });
});

// ---- attachManualFullText ----

describe("attachManualFullText", () => {
  it("成功：挂载 + 分析 available + provenance resolver=manual-upload + 重建钩子", async () => {
    const f = await newFixture();
    const { source } = await f.importer.importDoi(f.projectId, { doi: "10.1234/manual", enrich: false });
    const hookCalls: Array<{ projectId: string; sourceId: string }> = [];
    const support: FullTextSupport = {
      resolvers: [routingResolver({})],
      http: deadHttp,
      onFullTextAttached: async (projectId, sourceId) => {
        hookCalls.push({ projectId, sourceId });
      },
    };
    f.importer.attachFullTextSupport(support);
    const result = await f.importer.attachManualFullText(f.projectId, source.sourceId, {
      fileName: "local-copy.pdf",
      content: PDF_BYTES,
    });
    expect(result.outcome).toBe("resolved");
    expect(result.source.fileName).toBe(`${source.sourceId}-local-copy.pdf`);
    expect(result.source.status).toBe("available"); // 文本层 ≥200 字符 → 分析 ok
    expect(result.source.fullText).toMatchObject({
      status: "resolved",
      resolver: "manual-upload",
      bytes: PDF_BYTES.byteLength,
    });
    expect(result.source.fullText?.resolvedAt).toBeDefined();
    expect(hookCalls).toEqual([{ projectId: f.projectId, sourceId: source.sourceId }]);
    expect(
      existsSync(join(f.projects.sourcesDir(f.projectId), "parsed", `${source.sourceId}.json`)),
    ).toBe(true);
  });

  it("未装配 FullTextSupport 也可用（分析走 BuiltinPdfAnalyzer，无检索钩子但 lazy 自愈）", async () => {
    const f = await newFixture();
    const { source } = await f.importer.importDoi(f.projectId, { doi: "10.1234/manual-noop", enrich: false });
    const result = await f.importer.attachManualFullText(f.projectId, source.sourceId, {
      fileName: "copy.pdf",
      content: PDF_BYTES,
    });
    expect(result.outcome).toBe("resolved");
    expect(result.source.status).toBe("available");
  });

  it("已有文件 → skipped_has_file（不覆盖既有内容）", async () => {
    const f = await newFixture();
    const { source } = await f.importer.importArxiv(f.projectId, { arxivId: "2401.00012", enrich: false });
    await f.sources.attachFile(f.projectId, source.sourceId, {
      fileName: "first.pdf",
      content: PDF_BYTES,
    });
    const result = await f.importer.attachManualFullText(f.projectId, source.sourceId, {
      fileName: "second.pdf",
      content: buildTextPdf("different content entirely"),
    });
    expect(result.outcome).toBe("skipped_has_file");
    const item = await f.sources.getRequired(f.projectId, source.sourceId);
    expect(item.fileName).toBe(`${source.sourceId}-first.pdf`);
    expect(item.fullText).toBeUndefined(); // 幂等跳过不伪造 provenance
  });

  it("非 PDF 魔数拒绝（扩展名合法但内容不是 PDF）", async () => {
    const f = await newFixture();
    const { source } = await f.importer.importDoi(f.projectId, { doi: "10.1234/magic", enrich: false });
    await expect(
      f.importer.attachManualFullText(f.projectId, source.sourceId, {
        fileName: "fake.pdf",
        content: Buffer.from("<html>not a pdf</html>"),
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const item = await f.sources.getRequired(f.projectId, source.sourceId);
    expect(item.fileName).toBeUndefined(); // 拒绝时不落任何文件
  });

  it("非 .pdf 文件名 / 空内容 / 超限拒绝（attachFile 原语纪律）", async () => {
    const f = await newFixture();
    const { source } = await f.importer.importDoi(f.projectId, { doi: "10.1234/bad2", enrich: false });
    await expect(
      f.importer.attachManualFullText(f.projectId, source.sourceId, {
        fileName: "paper.txt",
        content: PDF_BYTES,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      f.importer.attachManualFullText(f.projectId, source.sourceId, {
        fileName: "paper.pdf",
        content: Buffer.alloc(0),
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    const oversized = Buffer.concat([Buffer.from("%PDF-1.4"), Buffer.alloc(20 * 1024 * 1024 + 1, 0x61)]);
    await expect(
      f.importer.attachManualFullText(f.projectId, source.sourceId, {
        fileName: "huge.pdf",
        content: oversized,
      }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("条目不存在 → NotFoundError；跨项目隔离（B 项目条目在 A 项目不可见）", async () => {
    const f = await newFixture();
    const projectB = (await f.projects.create("项目 B")).id;
    const { source: sourceB } = await f.importer.importDoi(projectB, { doi: "10.1234/b-side", enrich: false });
    await expect(
      f.importer.attachManualFullText(f.projectId, sourceB.sourceId, {
        fileName: "x.pdf",
        content: PDF_BYTES,
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      f.importer.attachManualFullText(f.projectId, "S999", { fileName: "x.pdf", content: PDF_BYTES }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("手动挂载 → chunk 落盘 → retrieve 可检索 → chunk 锚点可回取（人工 fallback 全链）", async () => {
    const f = await newFixture();
    const chunkStore = new ChunkStore(f.projects);
    const retrieval = new RetrievalService({
      projects: f.projects,
      sources: f.sources,
      chunker: new SourceChunker({}), // 无 pymupdf → builtin 文本层回退
      chunkStore,
    });
    const chunkAccess = new ChunkAccess({ projects: f.projects, chunkStore, sources: f.sources });
    f.importer.attachFullTextSupport({
      resolvers: [routingResolver({})],
      http: deadHttp,
      onFullTextAttached: async (projectId, sourceId) => {
        await retrieval.rebuildSource(projectId, sourceId);
      },
    });
    // 先经历一次自动解析失败（not_found），再人工 fallback —— 真实使用顺序
    const { source } = await f.importer.importDoi(f.projectId, { doi: "10.1234/manual-chain", enrich: false });
    const auto = await f.importer.tryResolveFullText(f.projectId, source.sourceId);
    expect(auto.outcome).toBe("not_found");
    expect(auto.source.fullText).toMatchObject({ status: "not_found", attempts: 1 });

    const manual = await f.importer.attachManualFullText(f.projectId, source.sourceId, {
      fileName: "author-copy.pdf",
      content: PDF_BYTES,
    });
    expect(manual.outcome).toBe("resolved");
    // 手动挂载覆盖失败 provenance（attempts 保留审计轨迹）
    expect(manual.source.fullText).toMatchObject({
      status: "resolved",
      resolver: "manual-upload",
      attempts: 1,
    });

    const chunkFile = join(f.projects.sourcesDir(f.projectId), "chunks", `${source.sourceId}.jsonl`);
    expect(existsSync(chunkFile)).toBe(true);
    const raw = await readFile(chunkFile, "utf8");
    const firstChunk = JSON.parse(raw.split("\n")[0]!) as { chunkId: string; text: string };
    expect(firstChunk.chunkId.startsWith(`${source.sourceId}:`)).toBe(true);

    const search = await retrieval.search(f.projectId, "manual fulltext marker", { topK: 5 });
    expect(search.results.some((hit) => hit.chunk.sourceId === source.sourceId)).toBe(true);

    const resolved = await chunkAccess.resolve(f.projectId, firstChunk.chunkId);
    expect(resolved.chunk.text).toContain("PaperTeam manual fulltext marker");
    expect(resolved.source.fullText).toMatchObject({ status: "resolved", resolver: "manual-upload" });
  });
});

// ---- 边界：Evidence 零写入 / 老数据兼容 ----

describe("M9.3 边界", () => {
  it("批量解析 + 手动挂载全程零 Evidence 写入（Verified Evidence = 0 是合法状态）", async () => {
    const f = await newFixture();
    const download = trackingDownload();
    f.importer.attachFullTextSupport({
      resolvers: [
        routingResolver({
          "10.1234/ev-boundary": () => ({ kind: "found", url: "https://publisher.org/oa/ev.pdf", source: "unpaywall" }),
        }),
      ],
      http: deadHttp,
      download: download.download,
    });
    const auto = await f.importer.importDoi(f.projectId, { doi: "10.1234/ev-boundary", enrich: false });
    const manual = await f.importer.importUrl(f.projectId, { url: "https://blog.example.org/post" });
    await f.importer.resolveFullTextBatch(f.projectId, [auto.source.sourceId, manual.source.sourceId]);
    await f.importer.attachManualFullText(f.projectId, manual.source.sourceId, {
      fileName: "m.pdf",
      content: PDF_BYTES,
    });
    expect(await f.evidence.list(f.projectId)).toEqual([]);
  });

  it("老数据条目（无 fullText 字段、metadata_only）照常进入批量与手动路径", async () => {
    const f = await newFixture();
    const { source } = await f.importer.importDoi(f.projectId, { doi: "10.1234/legacy", enrich: false });
    expect(source.fullText).toBeUndefined();
    const result = await f.importer.resolveFullTextBatch(f.projectId, [source.sourceId]);
    expect(result.summary.notResolvable).toBe(1); // 未装配 → 干净降级
    const attached = await f.importer.attachManualFullText(f.projectId, source.sourceId, {
      fileName: "legacy.pdf",
      content: PDF_BYTES,
    });
    expect(attached.outcome).toBe("resolved");
    expect(attached.source.fullText?.attempts).toBe(0); // 手动挂载不伪造 resolver 尝试计数
  });
});
