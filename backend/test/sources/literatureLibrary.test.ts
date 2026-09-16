/**
 * M6.2 Project Literature Library 域层测试。
 *
 * 覆盖：项目隔离 / PDF 判重 / DOI·arXiv·URL 归一去重 / Candidate 与正式
 * Source 分离 / promotion 幂等 / metadata merge / contentHash 失效 /
 * 持久化（restart 语义：新 store 实例读同一 workspace）/ 删除行为 /
 * Evidence 引用保护 / 老项目（M5 形状）兼容 / 非法输入。
 */

import { existsSync } from "node:fs";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import { ProjectStore } from "../../src/project/ProjectStore.js";
import { EvidenceStore } from "../../src/evidence/EvidenceStore.js";
import { CandidateStore } from "../../src/sources/CandidateStore.js";
import { SourceImportService } from "../../src/sources/SourceImportService.js";
import { SourceStore, type SourceItem } from "../../src/sources/SourceStore.js";
import { ScholarlyResolver, type ScholarlyProvider } from "../../src/citation/scholarly.js";
import type { CanonicalPaperRecord } from "../../src/citation/integrity.js";
import { buildIdentity } from "../../src/sources/identity.js";

const tempRoots: string[] = [];
afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

interface Fixture {
  projects: ProjectStore;
  sources: SourceStore;
  candidates: CandidateStore;
  evidence: EvidenceStore;
  importer: SourceImportService;
  projectId: string;
  root: string;
}

/** 可注入 fake scholarly 记录（key = doi:<doi> 或 arxiv:<id>） */
function fakeResolver(records: Record<string, Partial<CanonicalPaperRecord>> = {}): ScholarlyResolver {
  const provider: ScholarlyProvider = {
    name: "crossref",
    async lookup(query) {
      const key =
        query.doi !== undefined ? `doi:${query.doi}` : query.arxivId !== undefined ? `arxiv:${query.arxivId}` : null;
      const record = key !== null ? records[key] : undefined;
      if (record !== undefined) {
        return {
          kind: "match",
          record: {
            provider: "crossref",
            recordId: key ?? "",
            retrievedAt: new Date().toISOString(),
            ...record,
          } as CanonicalPaperRecord,
        };
      }
      return { kind: "not_found" };
    },
  };
  return new ScholarlyResolver({ providers: [provider] });
}

async function newFixture(options: { resolverRecords?: Record<string, Partial<CanonicalPaperRecord>> } = {}): Promise<Fixture> {
  const root = await mkdtemp(join(tmpdir(), "paperteam-lib-"));
  tempRoots.push(root);
  const projects = new ProjectStore({ root });
  const project = await projects.create("文献库测试");
  const sources = new SourceStore(projects);
  const candidates = new CandidateStore(projects);
  const evidence = new EvidenceStore(projects);
  const importer = new SourceImportService({
    projects,
    sources,
    candidates,
    evidence,
    scholarly: fakeResolver(options.resolverRecords),
  });
  return { projects, sources, candidates, evidence, importer, projectId: project.id, root };
}

/** 手工构造的最小可解析 PDF（同 SourceStore.test，保证内容可复现） */
function minimalPdf(text: string): Buffer {
  const content = `BT /F1 12 Tf 72 720 Td (${text}) Tj ET`;
  const objects = [
    "<< /Type /Catalog /Pages 2 0 R >>",
    "<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
    "<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Contents 4 0 R /Resources << /Font << /F1 5 0 R >> >> >>",
    `<< /Length ${content.length} >>\nstream\n${content}\nendstream`,
    "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
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

describe("项目隔离", () => {
  it("Project A 的 source / candidate 在 Project B 不可见（find 隔离 + 目录隔离）", async () => {
    const f = await newFixture();
    const b = await f.projects.create("B 项目");
    await f.importer.importDoi(f.projectId, { doi: "10.1234/iso-a" });
    await f.importer.importDoi(b.id, { doi: "10.1234/iso-b" });

    expect((await f.sources.list(f.projectId)).map((s) => s.sourceId)).toEqual(["S001"]);
    expect((await f.sources.list(b.id)).map((s) => s.sourceId)).toEqual(["S001"]);
    // 身份互不可见
    const identityA = buildIdentity({ doi: "10.1234/iso-b" })!;
    expect(await f.sources.findByIdentity(f.projectId, identityA)).toBeNull();
    // 文件系统隔离：candidates/index 落在各自项目目录
    expect(existsSync(join(f.root, f.projectId, "sources", "index.json"))).toBe(true);
    expect(existsSync(join(f.root, b.id, "sources", "index.json"))).toBe(true);
  });

  it("删除 Project A 的 source 不影响 Project B", async () => {
    const f = await newFixture();
    const b = await f.projects.create("B 项目");
    const a1 = await f.importer.importDoi(f.projectId, { doi: "10.1234/del-a" });
    const b1 = await f.importer.importDoi(b.id, { doi: "10.1234/del-b" });
    await f.importer.removeSource(f.projectId, a1.source.sourceId);
    expect((await f.sources.list(f.projectId))).toHaveLength(0);
    expect((await f.sources.list(b.id)).map((s) => s.sourceId)).toEqual([b1.source.sourceId]);
  });
});

describe("PDF 上传（contentHash 判重）", () => {
  it("相同内容 PDF 重复上传不新建条目", async () => {
    const f = await newFixture();
    const first = await f.importer.importPdf(f.projectId, {
      fileName: "paper.pdf",
      content: minimalPdf("same content"),
    });
    const second = await f.importer.importPdf(f.projectId, {
      fileName: "renamed.pdf", // 文件名不同、内容相同
      content: minimalPdf("same content"),
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.source.sourceId).toBe(first.source.sourceId);
    expect(await f.sources.list(f.projectId)).toHaveLength(1);
  });

  it("内容变化（hash 不同）→ 新条目；不同项目同内容互不判重", async () => {
    const f = await newFixture();
    const b = await f.projects.create("B 项目");
    await f.importer.importPdf(f.projectId, { fileName: "a.pdf", content: minimalPdf("v1") });
    const changed = await f.importer.importPdf(f.projectId, { fileName: "b.pdf", content: minimalPdf("v2") });
    expect(changed.created).toBe(true);
    expect((await f.sources.list(f.projectId)).map((s) => s.sourceId)).toEqual(["S001", "S002"]);
    // 跨项目判重（共享 contentHash 是错误的——A 的 PDF 在 B 仍是新资料）
    const other = await f.importer.importPdf(b.id, { fileName: "a.pdf", content: minimalPdf("v1") });
    expect(other.created).toBe(true);
  });

  it("解析产物绑定 contentHash：内容变化后旧 analysis 拒绝写入", async () => {
    const f = await newFixture();
    const { source } = await f.importer.importPdf(f.projectId, {
      fileName: "a.pdf",
      content: minimalPdf("analyzable text about method"),
    });
    const analysis = {
      analyzer: "test",
      status: "ok" as const,
      pageCount: 1,
      imageCount: 0,
      extractedChars: 100,
      extractionQuality: "good" as const,
      headings: [],
      citationMarkers: 0,
      textPreview: "analyzable",
      analyzedAt: new Date().toISOString(),
    };
    const updated = await f.sources.setAnalysis(f.projectId, source.sourceId, analysis, {
      contentHash: source.contentHash,
    });
    expect(updated.status).toBe("available");
    expect(updated.analysisHash).toBe(source.contentHash);
    expect(f.sources.isAnalysisFresh(updated)).toBe(true);

    // 内容变化的 source（hash 不一致）→ 拒绝写入旧产物
    await expect(
      f.sources.setAnalysis(f.projectId, source.sourceId, analysis, { contentHash: "deadbeef" }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    // 无 hash 校验（老数据路径）→ 允许写入
    const legacy = await f.sources.setAnalysis(f.projectId, source.sourceId, analysis);
    expect(legacy.status).toBe("available");
  });
});

describe("DOI 导入", () => {
  it("resolver 命中 → resolved 级元数据落库（含 abstract），状态 metadata_only", async () => {
    const f = await newFixture({
      resolverRecords: {
        "doi:10.1234/great": {
          title: "A Great Paper",
          authors: ["Alice Smith", "Bob Jones"],
          year: 2024,
          venue: "Nature",
          doi: "10.1234/great",
          abstract: "An abstract.",
        },
      },
    });
    const { source, created, resolve } = await f.importer.importDoi(f.projectId, { doi: "10.1234/great" });
    expect(created).toBe(true);
    expect(source.status).toBe("metadata_only");
    expect(source.sourceType).toBe("doi");
    expect(source.origin).toBe("DOI_IMPORT");
    expect(source.metadata.title).toBe("A Great Paper");
    expect(source.metadata.authors).toEqual(["Alice Smith", "Bob Jones"]);
    expect(source.metadata.venue).toBe("Nature");
    expect(source.metadata.abstract).toBe("An abstract.");
    expect(source.identity?.doi).toBe("10.1234/great");
    expect(resolve?.outcome).toBe("match");
    // metadata-only：无原始文件
    expect(source.fileName).toBeUndefined();
    await expect(f.sources.filePath(f.projectId, source.sourceId)).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("resolver 未命中 → 条目仍入库（只有 DOI），结论如实记录", async () => {
    const f = await newFixture();
    const { source, resolve } = await f.importer.importDoi(f.projectId, { doi: "10.1234/unknown" });
    expect(source.metadata.doi).toBe("10.1234/unknown");
    expect(source.metadata.title).toBeUndefined(); // 不伪造
    expect(resolve?.outcome).not.toBe("match");
  });

  it("DOI 归一化去重：URL 形态 / doi: 前缀 / 大小写 → 同一条目", async () => {
    const f = await newFixture();
    const first = await f.importer.importDoi(f.projectId, { doi: "https://doi.org/10.1234/ABC.def" });
    const second = await f.importer.importDoi(f.projectId, { doi: "doi:10.1234/abc.DEF" });
    const third = await f.importer.importDoi(f.projectId, { doi: "10.1234/abc.def." });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.source.sourceId).toBe(first.source.sourceId);
    expect(third.created).toBe(false);
    expect(await f.sources.list(f.projectId)).toHaveLength(1);
  });

  it("malformed DOI 拒绝", async () => {
    const f = await newFixture();
    await expect(f.importer.importDoi(f.projectId, { doi: "10.12/short" })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await expect(f.importer.importDoi(f.projectId, { doi: "not a doi" })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });
});

describe("arXiv 导入", () => {
  it("resolver 命中 arXiv 记录 → 元数据落库；arxiv.org URL 自动生成", async () => {
    const f = await newFixture({
      resolverRecords: {
        "arxiv:2401.12345": {
          title: "Preprint Title",
          arxivId: "2401.12345",
          abstract: "Preprint abstract.",
        },
      },
    });
    const { source, created } = await f.importer.importArxiv(f.projectId, { arxivId: "arXiv:2401.12345v2" });
    expect(created).toBe(true);
    expect(source.sourceType).toBe("arxiv");
    expect(source.origin).toBe("ARXIV_IMPORT");
    expect(source.metadata.title).toBe("Preprint Title");
    expect(source.metadata.arxivId).toBe("2401.12345");
    expect(source.metadata.url).toBe("https://arxiv.org/abs/2401.12345");
  });

  it("arXiv ID 归一化去重（版本号 / URL 形态）", async () => {
    const f = await newFixture();
    const first = await f.importer.importArxiv(f.projectId, { arxivId: "2401.12345v3" });
    const second = await f.importer.importArxiv(f.projectId, { arxivId: "https://arxiv.org/abs/2401.12345" });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.source.sourceId).toBe(first.source.sourceId);
    // 同一工作的 arXiv 版与 DOI 正式版是两条独立条目（不互相覆盖）
    const published = await f.importer.importDoi(f.projectId, { doi: "10.9999/great-method" });
    expect(published.created).toBe(true);
    expect((await f.sources.list(f.projectId)).map((s) => s.sourceId)).toEqual(["S001", "S002"]);
  });

  it("非法 arXiv ID 拒绝", async () => {
    const f = await newFixture();
    await expect(f.importer.importArxiv(f.projectId, { arxivId: "abc" })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });
});

describe("URL 导入", () => {
  it("canonical URL + metadata placeholder；追踪参数与斜杠差异去重", async () => {
    const f = await newFixture();
    const first = await f.importer.importUrl(f.projectId, {
      url: "https://Blog.Example.com/post/?utm_source=x#frag",
      title: "A Blog Post",
    });
    const second = await f.importer.importUrl(f.projectId, { url: "https://blog.example.com/post" });
    expect(first.created).toBe(true);
    expect(first.source.sourceType).toBe("url");
    expect(first.source.origin).toBe("URL_IMPORT");
    expect(first.source.metadata.url).toBe("https://blog.example.com/post");
    expect(first.source.metadata.title).toBe("A Blog Post");
    expect(second.created).toBe(false);
    expect(second.source.sourceId).toBe(first.source.sourceId);
  });

  it("非法 URL 拒绝", async () => {
    const f = await newFixture();
    await expect(f.importer.importUrl(f.projectId, { url: "javascript:alert(1)" })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await expect(f.importer.importUrl(f.projectId, { url: "not a url" })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });
});

describe("BibTeX 导入", () => {
  const bib = [
    "@article{smith2024great,",
    "  title = {A Great {Method} for Tracking},",
    '  author = "Smith, Alice and Jones, Bob",',
    "  year = {2024},",
    "  doi = {10.1234/great},",
    "  journal = {IEEE TPAMI},",
    "}",
    "@inproceedings{deep2016sort,",
    "  title = {Deep SORT},",
    "  author = {Wenhardt, Nico},",
    "  year = {2016},",
    "  url = {https://arxiv.org/abs/1602.00763},",
    "}",
  ].join("\n");

  it("条目映射为 SourceItem（title/author/year/doi/venue + versionType）", async () => {
    const f = await newFixture();
    const { results, errors } = await f.importer.importBibtex(f.projectId, { content: bib });
    expect(errors).toEqual([]);
    expect(results).toHaveLength(2);
    const [first, second] = results.map((r) => r.source) as [SourceItem, SourceItem];
    expect(first.metadata.title).toBe("A Great Method for Tracking"); // {Method} 花括号去壳
    expect(first.metadata.authors).toEqual(["Smith, Alice", "Jones, Bob"]);
    expect(first.metadata.year).toBe(2024);
    expect(first.metadata.doi).toBe("10.1234/great");
    expect(first.metadata.venue).toBe("IEEE TPAMI");
    expect(first.sourceType).toBe("bibtex");
    expect(first.origin).toBe("BIBTEX_IMPORT");
    expect(first.versionType).toBe("journal");
    expect(second.versionType).toBe("conference");
    expect(second.metadata.arxivId).toBe("1602.00763");
  });

  it("重复导入：identity 命中 → merge 不新建", async () => {
    const f = await newFixture();
    await f.importer.importBibtex(f.projectId, { content: bib });
    const again = await f.importer.importBibtex(f.projectId, { content: bib });
    expect(again.results.every((r) => !r.created)).toBe(true);
    expect(await f.sources.list(f.projectId)).toHaveLength(2);
  });

  it("与 DOI 导入互通去重（BibTeX 的 doi 字段 → DOI 身份）", async () => {
    const f = await newFixture();
    await f.importer.importDoi(f.projectId, { doi: "10.1234/great", enrich: false });
    const { results } = await f.importer.importBibtex(f.projectId, { content: bib });
    const great = results.find((r) => r.entryKey === "smith2024great")!;
    expect(great.created).toBe(false);
    expect(great.source.sourceId).toBe("S001");
    // inferred 级 merge 只填空缺：DOI 导入条目缺 title → BibTeX 补上
    expect(great.source.metadata.title).toBe("A Great Method for Tracking");
    expect(await f.sources.list(f.projectId)).toHaveLength(2);
  });

  it("解析错误按条目收集，不中断其余条目", async () => {
    const f = await newFixture();
    const broken = [
      "@article{ok-entry, title = {Fine}, year = {2020} }",
      "@article{bad-entry, title = {Missing brace, year = {2021},",
      "@article{empty-entry}",
    ].join("\n\n");
    const { results, errors } = await f.importer.importBibtex(f.projectId, { content: broken });
    expect(results.map((r) => r.entryKey)).toEqual(["ok-entry"]);
    expect(errors.length).toBeGreaterThan(0);
  });
});

describe("Candidate 生命周期", () => {
  it("候选与正式 Source 严格分离（不同文件、互不可见）", async () => {
    const f = await newFixture();
    const { candidate } = await f.importer.addCandidate(f.projectId, {
      doi: "10.1234/cand",
      title: "Candidate Paper",
    });
    expect(candidate.status).toBe("pending_review");
    expect(candidate.candidateId).toBe("C001");
    // 候选不在正式库；正式库为空
    expect(await f.sources.list(f.projectId)).toHaveLength(0);
    expect(await f.importer.listCandidates(f.projectId)).toHaveLength(1);
    expect(existsSync(join(f.root, f.projectId, "sources", "candidates.json"))).toBe(true);
    expect(existsSync(join(f.root, f.projectId, "sources", "index.json"))).toBe(false);
  });

  it("同身份 pending 候选只保留一条（后到的补充空缺字段）", async () => {
    const f = await newFixture();
    const first = await f.importer.addCandidate(f.projectId, {
      doi: "https://doi.org/10.1234/dup",
      title: "First Discovery",
    });
    const second = await f.importer.addCandidate(f.projectId, {
      doi: "doi:10.1234/DUP",
      snippetOrAbstract: "Snippet from another provider.",
      provider: "openalex",
    });
    expect(first.created).toBe(true);
    expect(second.created).toBe(false);
    expect(second.candidate.candidateId).toBe("C001");
    expect(second.candidate.title).toBe("First Discovery");
    expect(second.candidate.snippetOrAbstract).toBe("Snippet from another provider.");
    expect(await f.importer.listCandidates(f.projectId)).toHaveLength(1);
  });

  it("无身份候选拒绝", async () => {
    const f = await newFixture();
    await expect(f.importer.addCandidate(f.projectId, { title: "仅标题不构成身份" })).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
    await expect(f.importer.addCandidate(f.projectId, {})).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("promotion：候选 → 正式库；重复 promotion 幂等", async () => {
    const f = await newFixture();
    await f.importer.addCandidate(f.projectId, {
      doi: "10.1234/promote",
      title: "Promoted Paper",
      authors: ["Carol Wu"],
      year: 2023,
    });
    const first = await f.importer.promoteCandidate(f.projectId, "C001");
    expect(first.created).toBe(true);
    expect(first.source.sourceType).toBe("doi");
    expect(first.source.origin).toBe("USER_ADDED"); // manual 候选
    expect(first.source.metadata.title).toBe("Promoted Paper");
    expect(first.candidate.status).toBe("accepted");
    expect(first.candidate.promotedSourceId).toBe(first.source.sourceId);

    // 幂等：第二次 promote 返回同一条目，不复制
    const second = await f.importer.promoteCandidate(f.projectId, "C001");
    expect(second.created).toBe(false);
    expect(second.source.sourceId).toBe(first.source.sourceId);
    expect(await f.sources.list(f.projectId)).toHaveLength(1);
    expect(await f.importer.listCandidates(f.projectId, "accepted")).toHaveLength(1);

    // promotion 后再手动 import 同一 DOI → 也去重
    const dup = await f.importer.importDoi(f.projectId, { doi: "10.1234/promote", enrich: false });
    expect(dup.created).toBe(false);
    expect(dup.source.sourceId).toBe(first.source.sourceId);
  });

  it("promotion 去重：library 已有同身份条目 → merge 返回既有（不复制）", async () => {
    const f = await newFixture();
    await f.importer.importDoi(f.projectId, { doi: "10.1234/exists", enrich: false });
    await f.importer.addCandidate(f.projectId, {
      doi: "doi:10.1234/exists",
      title: "Found Again",
      origin: "academic_search",
      provider: "openalex",
    });
    const result = await f.importer.promoteCandidate(f.projectId, "C001");
    expect(result.created).toBe(false);
    expect(result.source.sourceId).toBe("S001");
    expect(result.source.metadata.title).toBe("Found Again"); // inferred 填空缺
    expect(result.source.origin).toBe("DOI_IMPORT"); // 既有条目 origin 不被覆盖
    expect(await f.sources.list(f.projectId)).toHaveLength(1);
  });

  it("删除候选不影响正式 Source；reject 幂等", async () => {
    const f = await newFixture();
    await f.importer.addCandidate(f.projectId, { doi: "10.1234/del-cand", title: "T" });
    await f.importer.promoteCandidate(f.projectId, "C001");
    await f.importer.deleteCandidate(f.projectId, "C001");
    expect(await f.importer.listCandidates(f.projectId)).toHaveLength(0);
    expect(await f.sources.list(f.projectId)).toHaveLength(1); // source 保留

    const { candidate: added } = await f.importer.addCandidate(f.projectId, { doi: "10.1234/reject-me", title: "R" });
    const rejected = await f.importer.rejectCandidate(f.projectId, added.candidateId);
    expect(rejected.status).toBe("rejected");
    const again = await f.importer.rejectCandidate(f.projectId, added.candidateId);
    expect(again.status).toBe("rejected");
    // 被拒候选仍可显式 promote（用户改判）
    const revived = await f.importer.promoteCandidate(f.projectId, added.candidateId);
    expect(revived.created).toBe(true);
    expect(revived.candidate.status).toBe("accepted");
  });

  it("promotion 后删除正式 Source → 再次 promote 重新入库（幂等快路径失效处理）", async () => {
    const f = await newFixture();
    await f.importer.addCandidate(f.projectId, { doi: "10.1234/readd", title: "Again" });
    const first = await f.importer.promoteCandidate(f.projectId, "C001");
    await f.importer.removeSource(f.projectId, first.source.sourceId);
    const rePromoted = await f.importer.promoteCandidate(f.projectId, "C001");
    expect(rePromoted.created).toBe(true);
    // 清空后的库从头编号是既有语义（S001 已无占用者、parsed 产物随删除清理）
    expect(rePromoted.candidate.promotedSourceId).toBe(rePromoted.source.sourceId);
    expect(await f.sources.list(f.projectId)).toHaveLength(1);
  });
});

describe("Metadata merge", () => {
  it("user 级标题不被 resolved 覆盖；空缺字段被补全", async () => {
    const f = await newFixture({
      resolverRecords: {
        "doi:10.1234/merge": {
          title: "Wrong Title From Resolver",
          authors: ["Resolve Author"],
          year: 2024,
        },
      },
    });
    // 用户上传 PDF 并 PATCH 标题（user 级）
    const { source } = await f.importer.importPdf(f.projectId, {
      fileName: "m.pdf",
      content: minimalPdf("user uploaded"),
      metadata: { title: "User Title", doi: "10.1234/merge" },
    });
    expect(source.metadataProvenance).toBe("inferred"); // add 默认 inferred
    // 用户 PATCH → user 级
    const patched = await f.sources.update(f.projectId, source.sourceId, {
      metadata: { title: "User Title" },
    });
    expect(patched.metadataProvenance).toBe("user");
    // enrich（resolved）不覆盖 user 标题，但补 authors/year
    const { source: enriched } = await f.importer.enrichMetadata(f.projectId, source.sourceId);
    expect(enriched.metadata.title).toBe("User Title");
    expect(enriched.metadata.authors).toEqual(["Resolve Author"]);
    expect(enriched.metadata.year).toBe(2024);
    // 条目级 provenance 是水位线（取字段最高级）：user 标题仍在 → 保持 user，
    // 后续 resolved 数据只填空缺（M6.2 条目级单值模型的已知保守边界）
    expect(enriched.metadataProvenance).toBe("user");
    expect(enriched.identity?.doi).toBe("10.1234/merge");
  });

  it("resolved 覆盖 inferred（PDF 抽取的错标题被学术库正式记录纠正）", async () => {
    const f = await newFixture({
      resolverRecords: {
        "doi:10.1234/fix": {
          title: "Corrected Title",
          year: 2022,
        },
      },
    });
    const { source } = await f.importer.importPdf(f.projectId, {
      fileName: "f.pdf",
      content: minimalPdf("garbled"),
      metadata: { title: "Ocr Broken Title", doi: "10.1234/fix" },
    });
    const { source: enriched } = await f.importer.enrichMetadata(f.projectId, source.sourceId);
    expect(enriched.metadata.title).toBe("Corrected Title");
    expect(enriched.metadata.year).toBe(2022);
  });

  it("无 DOI/arXiv/标题的条目 enrich 拒绝（无解析依据）", async () => {
    const f = await newFixture();
    const { source } = await f.importer.importPdf(f.projectId, {
      fileName: "x.pdf",
      content: minimalPdf("nothing"),
    });
    await expect(f.importer.enrichMetadata(f.projectId, source.sourceId)).rejects.toMatchObject({
      code: "INVALID_REQUEST",
    });
  });
});

describe("版本关系（work identity）", () => {
  it("link 统一 workKey、互记 relatedSourceIds、标注 versionType；preprint 与正式版保持独立", async () => {
    const f = await newFixture();
    const preprint = await f.importer.importArxiv(f.projectId, { arxivId: "2401.12345", enrich: false });
    const published = await f.importer.importDoi(f.projectId, { doi: "10.9999/great-method", enrich: false });
    const { sources: [a, b] } = await f.importer.linkSources(f.projectId, preprint.source.sourceId, published.source.sourceId, {
      versionType: "preprint",
      targetVersionType: "journal",
    });
    expect(a.workKey).toBeDefined();
    expect(a.workKey).toBe(b.workKey);
    expect(a.versionType).toBe("preprint");
    expect(b.versionType).toBe("journal");
    expect(a.relatedSourceIds).toContain(published.source.sourceId);
    expect(b.relatedSourceIds).toContain(preprint.source.sourceId);
    // 仍是两条独立 Source
    expect(await f.sources.list(f.projectId)).toHaveLength(2);
    // 重复 link 幂等（relatedSourceIds 去重、workKey 不变）
    const again = await f.importer.linkSources(f.projectId, preprint.source.sourceId, published.source.sourceId);
    expect(again.sources[0]!.relatedSourceIds).toEqual([published.source.sourceId]);
    expect(again.sources[0]!.workKey).toBe(a.workKey);
  });

  it("link 自己 / 不存在的条目拒绝", async () => {
    const f = await newFixture();
    const { source } = await f.importer.importDoi(f.projectId, { doi: "10.1234/solo", enrich: false });
    await expect(
      f.importer.linkSources(f.projectId, source.sourceId, source.sourceId),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
    await expect(
      f.importer.linkSources(f.projectId, source.sourceId, "S999"),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });
});

describe("删除行为与 Evidence 保护", () => {
  it("被 Evidence 引用的正式 Source 拒绝删除（SOURCE_IN_USE）", async () => {
    const f = await newFixture();
    const { source } = await f.importer.importDoi(f.projectId, { doi: "10.1234/guarded", enrich: false });
    await f.evidence.append(
      f.projectId,
      { claim: "某论断", source: { sourceId: source.sourceId, title: "Guarded" } },
      "test",
    );
    await expect(f.importer.removeSource(f.projectId, source.sourceId)).rejects.toMatchObject({
      code: "SOURCE_IN_USE",
    });
    expect(await f.sources.get(f.projectId, source.sourceId)).not.toBeNull();
  });

  it("引用清理后可删除；删除同时清理 parsed 产物", async () => {
    const f = await newFixture();
    const { source } = await f.importer.importPdf(f.projectId, {
      fileName: "d.pdf",
      content: minimalPdf("delete me"),
    });
    await f.sources.setAnalysis(
      f.projectId,
      source.sourceId,
      {
        analyzer: "t",
        status: "failed",
        pageCount: null,
        imageCount: null,
        extractedChars: 0,
        extractionQuality: "poor",
        headings: [],
        citationMarkers: 0,
        textPreview: "",
        analyzedAt: new Date().toISOString(),
      },
    );
    await f.evidence.append(
      f.projectId,
      { claim: "待处理", source: { sourceId: source.sourceId } },
      "test",
    );
    await expect(f.importer.removeSource(f.projectId, source.sourceId)).rejects.toMatchObject({
      code: "SOURCE_IN_USE",
    });
    // 删除引用（通过重写 evidence 文件）后再删
    await writeFile(join(f.root, f.projectId, "evidence", "evidence.jsonl"), "", "utf8");
    await f.importer.removeSource(f.projectId, source.sourceId);
    expect(await f.sources.get(f.projectId, source.sourceId)).toBeNull();
    expect(existsSync(join(f.root, f.projectId, "sources", "parsed", `${source.sourceId}.json`))).toBe(false);
    expect(existsSync(join(f.root, f.projectId, "sources", "papers", source.fileName!))).toBe(false);
  });
});

describe("持久化（restart 语义：全新 store 实例读同一 workspace）", () => {
  it("Source Library / Candidate / 解析状态在重建实例后完整保留", async () => {
    const f = await newFixture({
      resolverRecords: { "doi:10.1234/persist": { title: "Persisted", year: 2021 } },
    });
    await f.importer.importDoi(f.projectId, { doi: "10.1234/persist" });
    const { source: pdfSource } = await f.importer.importPdf(f.projectId, {
      fileName: "p.pdf",
      content: minimalPdf("persist parse status"),
    });
    await f.sources.setAnalysis(
      f.projectId,
      pdfSource.sourceId,
      {
        analyzer: "t",
        status: "ok",
        pageCount: 1,
        imageCount: 0,
        extractedChars: 24,
        extractionQuality: "good",
        headings: [],
        citationMarkers: 0,
        textPreview: "persist parse status",
        analyzedAt: new Date().toISOString(),
      },
      { contentHash: pdfSource.contentHash },
    );
    await f.importer.addCandidate(f.projectId, { doi: "10.1234/persist-cand", title: "C" });

    // 重建（模拟进程重启）：同一 ProjectStore / 新 SourceStore / CandidateStore / ImportService
    const projects2 = new ProjectStore({ root: f.root });
    const sources2 = new SourceStore(projects2);
    const candidates2 = new CandidateStore(projects2);
    const importer2 = new SourceImportService({ projects: projects2, sources: sources2, candidates: candidates2 });

    const sources = await sources2.list(f.projectId);
    expect(sources).toHaveLength(2);
    expect(sources.map((s) => s.sourceType)).toEqual(["doi", "pdf"]);
    const persistedDoi = sources.find((s) => s.sourceId === "S001")!;
    expect(persistedDoi.metadata.title).toBe("Persisted");
    expect(persistedDoi.identity?.doi).toBe("10.1234/persist");
    const persistedPdf = sources.find((s) => s.sourceId === "S002")!;
    expect(persistedPdf.status).toBe("available"); // parse status persisted
    expect(sources2.isAnalysisFresh(persistedPdf)).toBe(true);
    // 候选仍在
    expect(await importer2.listCandidates(f.projectId)).toHaveLength(1);
    // 判重仍在（重启后重复导入不新建）
    const dup = await importer2.importDoi(f.projectId, { doi: "10.1234/persist", enrich: false });
    expect(dup.created).toBe(false);
  });
});

describe("老项目（M5 形状）兼容", () => {
  it("无新字段的老 index.json：可读 / 身份可推导 / 新增条目并存 / 不破坏老条目", async () => {
    const f = await newFixture();
    // 手工写入 M5 形状的 sources/index.json + papers 文件
    const sourcesDir = join(f.root, f.projectId, "sources");
    await writeFile(
      join(sourcesDir, "index.json"),
      JSON.stringify({
        items: [
          {
            sourceId: "S001",
            fileName: "S001-old-paper.pdf",
            originalName: "old-paper.pdf",
            sourceRole: "evidence",
            origin: "USER_ADDED",
            status: "available",
            preferred: false,
            metadata: { title: "Old Paper", doi: "https://doi.org/10.9999/old", year: 2020 },
            analysis: { analyzer: "builtin-text", status: "ok" },
            bytes: 100,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    // 读取不报错
    const items = await f.sources.list(f.projectId);
    expect(items).toHaveLength(1);
    // 身份从 metadata lazy 推导：老 DOI 归一后可判重
    const found = await f.sources.findByIdentity(f.projectId, buildIdentity({ doi: "10.9999/old" })!);
    expect(found?.sourceId).toBe("S001");
    const dup = await f.importer.importDoi(f.projectId, { doi: "doi:10.9999/OLD", enrich: false });
    expect(dup.created).toBe(false);
    expect(dup.source.sourceId).toBe("S001");
    // 新条目编号接续，老条目原样保留
    const added = await f.importer.importDoi(f.projectId, { doi: "10.9999/new", enrich: false });
    expect(added.source.sourceId).toBe("S002");
    const after = await f.sources.list(f.projectId);
    expect(after).toHaveLength(2);
    expect(after[0]!.sourceId).toBe("S001");
    expect(after[0]!.sourceType).toBeUndefined(); // 老条目不被重写
    expect(after[0]!.metadata.title).toBe("Old Paper");
    // 老 PDF 条目路径可取
    expect(await f.sources.filePath(f.projectId, "S001")).toContain("S001-old-paper.pdf");
  });

  it("老条目无 contentHash：setAnalysis 不做 hash 校验（lazy 兼容）", async () => {
    const f = await newFixture();
    const sourcesDir = join(f.root, f.projectId, "sources");
    await writeFile(
      join(sourcesDir, "index.json"),
      JSON.stringify({
        items: [
          {
            sourceId: "S001",
            fileName: "S001-legacy.pdf",
            sourceRole: "both",
            origin: "USER_ADDED",
            status: "pending",
            preferred: false,
            metadata: {},
            bytes: 10,
            createdAt: "2026-01-01T00:00:00.000Z",
            updatedAt: "2026-01-01T00:00:00.000Z",
          },
        ],
      }),
      "utf8",
    );
    const analysis = {
      analyzer: "t",
      status: "ok" as const,
      pageCount: 1,
      imageCount: 0,
      extractedChars: 5,
      extractionQuality: "good" as const,
      headings: [],
      citationMarkers: 0,
      textPreview: "ok",
      analyzedAt: new Date().toISOString(),
    };
    const updated = await f.sources.setAnalysis(f.projectId, "S001", analysis, {
      contentHash: "anything",
    });
    expect(updated.status).toBe("available");
  });
});
