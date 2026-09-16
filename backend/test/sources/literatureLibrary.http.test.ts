/**
 * M6.2 Literature Library HTTP API 测试：
 * 导入端点（DOI/arXiv/URL/BibTeX）、候选 CRUD + promote/reject、
 * enrich / link / PATCH 扩展、Evidence 引用保护删除、
 * 越权访问（非法 projectId / 跨项目 sourceId）与非法输入。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { scriptedIdeaRuntime, startTestStack, type TestStack } from "../helpers/testStack.js";
import type { ScholarlyProvider } from "../../src/citation/scholarly.js";
import type { CanonicalPaperRecord } from "../../src/citation/integrity.js";
import type { SourceItem } from "../../src/sources/SourceStore.js";

let stack: TestStack;
let cleanup: (() => Promise<void>) | undefined;
afterAll(async () => {
  await cleanup?.();
});

/** crossref 形 fake provider：doi:10.1234/known → 命中；其余 not_found */
const fakeProvider: ScholarlyProvider = {
  name: "crossref",
  async lookup(query) {
    if (query.doi === "10.1234/known") {
      const record: CanonicalPaperRecord = {
        provider: "crossref",
        recordId: "10.1234/known",
        title: "Known Paper",
        authors: ["Known Author"],
        year: 2024,
        venue: "Known Venue",
        doi: "10.1234/known",
        abstract: "Known abstract.",
        retrievedAt: new Date().toISOString(),
      };
      return { kind: "match", record };
    }
    return { kind: "not_found" };
  },
};

beforeAll(async () => {
  stack = await startTestStack(scriptedIdeaRuntime().runtime, {
    citation: { scholarly: { providers: [fakeProvider] } },
    registerCleanup: (c) => {
      cleanup = c;
    },
  });
});

async function createProject(title: string): Promise<string> {
  const response = await stack.request("POST", "/api/projects", { title });
  expect(response.status).toBe(201);
  return (response.body["project"] as { id: string }).id;
}

function minimalPdfBase64(): string {
  const content = `BT /F1 12 Tf 72 720 Td (http upload pdf) Tj ET`;
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
  return Buffer.from(parts.join("\n"), "latin1").toString("base64");
}

describe("POST /sources（PDF 上传判重）", () => {
  it("相同内容二次上传 → 200 created=false，不新建条目", async () => {
    const projectId = await createProject("上传判重");
    const first = await stack.request("POST", `/api/projects/${projectId}/sources`, {
      fileName: "a.pdf",
      contentBase64: minimalPdfBase64(),
    });
    expect(first.status).toBe(201);
    expect(first.body["created"]).toBe(true);
    const second = await stack.request("POST", `/api/projects/${projectId}/sources`, {
      fileName: "other-name.pdf",
      contentBase64: minimalPdfBase64(),
    });
    expect(second.status).toBe(200);
    expect(second.body["created"]).toBe(false);
    const list = await stack.request("GET", `/api/projects/${projectId}/sources`);
    expect((list.body["sources"] as SourceItem[]).length).toBe(1);
  });
});

describe("导入端点", () => {
  it("POST /sources/import/doi：resolver 命中 → resolved 元数据；重复导入去重", async () => {
    const projectId = await createProject("DOI 导入");
    const first = await stack.request("POST", `/api/projects/${projectId}/sources/import/doi`, {
      doi: "https://doi.org/10.1234/known",
    });
    expect(first.status).toBe(201);
    const source = first.body["source"] as SourceItem;
    expect(source.metadata.title).toBe("Known Paper");
    expect(source.metadata.venue).toBe("Known Venue");
    expect(source.identity?.doi).toBe("10.1234/known");
    expect(source.status).toBe("metadata_only");

    const second = await stack.request("POST", `/api/projects/${projectId}/sources/import/doi`, {
      doi: "doi:10.1234/KNOWN",
    });
    expect(second.status).toBe(200);
    expect(second.body["created"]).toBe(false);
    expect((second.body["source"] as SourceItem).sourceId).toBe(source.sourceId);
  });

  it("POST /sources/import/doi：malformed DOI → 400；enrich=false 跳过解析", async () => {
    const projectId = await createProject("DOI 非法");
    const bad = await stack.request("POST", `/api/projects/${projectId}/sources/import/doi`, {
      doi: "10.99/bad",
    });
    expect(bad.status).toBe(400);
    const offline = await stack.request("POST", `/api/projects/${projectId}/sources/import/doi`, {
      doi: "10.1234/known",
      enrich: false,
    });
    expect(offline.status).toBe(201);
    expect((offline.body["source"] as SourceItem).metadata.title).toBeUndefined();
  });

  it("POST /sources/import/arxiv + /import/url：归一去重", async () => {
    const projectId = await createProject("arXiv URL 导入");
    const first = await stack.request("POST", `/api/projects/${projectId}/sources/import/arxiv`, {
      arxivId: "arXiv:2401.12345v2",
    });
    expect(first.status).toBe(201);
    const dup = await stack.request("POST", `/api/projects/${projectId}/sources/import/arxiv`, {
      arxivId: "https://arxiv.org/abs/2401.12345",
    });
    expect(dup.status).toBe(200);
    expect(dup.body["created"]).toBe(false);

    const url1 = await stack.request("POST", `/api/projects/${projectId}/sources/import/url`, {
      url: "https://example.com/page/?utm_source=rss",
      title: "A Page",
    });
    expect(url1.status).toBe(201);
    const url2 = await stack.request("POST", `/api/projects/${projectId}/sources/import/url`, {
      url: "https://example.com/page",
    });
    expect(url2.body["created"]).toBe(false);
    const badUrl = await stack.request("POST", `/api/projects/${projectId}/sources/import/url`, {
      url: "javascript:alert(1)",
    });
    expect(badUrl.status).toBe(400);
  });

  it("POST /sources/import/bibtex：条目导入 + 重复导入 merge", async () => {
    const projectId = await createProject("BibTeX 导入");
    const bib = [
      "@article{k1,",
      "  title = {Bib Entry One},",
      "  author = {Doe, Jane},",
      "  year = {2021},",
      "  doi = {10.1234/bib1},",
      "}",
    ].join("\n");
    const first = await stack.request("POST", `/api/projects/${projectId}/sources/import/bibtex`, {
      content: bib,
    });
    expect(first.status).toBe(200);
    expect((first.body["results"] as unknown[]).length).toBe(1);
    const again = await stack.request("POST", `/api/projects/${projectId}/sources/import/bibtex`, {
      content: bib,
    });
    const results = again.body["results"] as Array<{ created: boolean }>;
    expect(results[0]!.created).toBe(false);
    const list = await stack.request("GET", `/api/projects/${projectId}/sources`);
    expect((list.body["sources"] as SourceItem[]).length).toBe(1);
  });
});

describe("候选端点", () => {
  it("完整生命周期：添加 → 列表 → promote → 状态过滤 → reject → 删除", async () => {
    const projectId = await createProject("候选生命周期");
    const added = await stack.request("POST", `/api/projects/${projectId}/sources/candidates`, {
      doi: "10.1234/cand-http",
      title: "HTTP Candidate",
      origin: "academic_search",
      provider: "openalex",
    });
    expect(added.status).toBe(201);
    expect(added.body["created"]).toBe(true);
    const candidateId = (added.body["candidate"] as { candidateId: string }).candidateId;

    const list = await stack.request("GET", `/api/projects/${projectId}/sources/candidates`);
    expect((list.body["candidates"] as unknown[]).length).toBe(1);
    const pending = await stack.request("GET", `/api/projects/${projectId}/sources/candidates?status=pending_review`);
    expect((pending.body["candidates"] as unknown[]).length).toBe(1);
    const none = await stack.request("GET", `/api/projects/${projectId}/sources/candidates?status=accepted`);
    expect((none.body["candidates"] as unknown[]).length).toBe(0);
    const badStatus = await stack.request("GET", `/api/projects/${projectId}/sources/candidates?status=bogus`);
    expect(badStatus.status).toBe(400);

    const promoted = await stack.request("POST", `/api/projects/${projectId}/sources/candidates/${candidateId}/promote`, {});
    expect(promoted.status).toBe(200);
    const source = promoted.body["source"] as SourceItem;
    expect(source.sourceType).toBe("doi");
    expect(source.origin).toBe("AGENT_RETRIEVED"); // 检索来源候选
    // 幂等
    const again = await stack.request("POST", `/api/projects/${projectId}/sources/candidates/${candidateId}/promote`, {});
    expect(again.status).toBe(200);
    expect((again.body["source"] as SourceItem).sourceId).toBe(source.sourceId);

    const rejected = await stack.request("POST", `/api/projects/${projectId}/sources/candidates/${candidateId}/reject`, {});
    // 已 accepted 的候选可以再被拒（用户改判；不影响已入库 source）
    expect(rejected.status).toBe(200);
    expect((rejected.body["candidate"] as { status: string }).status).toBe("rejected");

    const del = await stack.request("DELETE", `/api/projects/${projectId}/sources/candidates/${candidateId}`);
    expect(del.status).toBe(200);
    const after = await stack.request("GET", `/api/projects/${projectId}/sources/candidates`);
    expect((after.body["candidates"] as unknown[]).length).toBe(0);
    // 正式 source 不受候选删除影响
    const sources = await stack.request("GET", `/api/projects/${projectId}/sources`);
    expect((sources.body["sources"] as unknown[]).length).toBe(1);
  });

  it("无身份候选 → 400；不存在候选 → 404", async () => {
    const projectId = await createProject("候选非法");
    const bad = await stack.request("POST", `/api/projects/${projectId}/sources/candidates`, {
      title: "只有标题",
    });
    expect(bad.status).toBe(400);
    const missing = await stack.request("POST", `/api/projects/${projectId}/sources/candidates/C999/promote`, {});
    expect(missing.status).toBe(404);
  });
});

describe("条目操作：enrich / link / PATCH versionType / 受保护删除", () => {
  it("PATCH versionType + POST /link 建立版本关系", async () => {
    const projectId = await createProject("版本关系");
    const preprint = await stack.request("POST", `/api/projects/${projectId}/sources/import/arxiv`, {
      arxivId: "2401.00001",
      enrich: false,
    });
    const published = await stack.request("POST", `/api/projects/${projectId}/sources/import/doi`, {
      doi: "10.1234/known",
    });
    const preprintId = (preprint.body["source"] as SourceItem).sourceId;
    const publishedId = (published.body["source"] as SourceItem).sourceId;

    const patched = await stack.request("PATCH", `/api/projects/${projectId}/sources/${preprintId}`, {
      versionType: "preprint",
    });
    expect((patched.body["source"] as SourceItem).versionType).toBe("preprint");
    const badPatch = await stack.request("PATCH", `/api/projects/${projectId}/sources/${preprintId}`, {
      versionType: "galley",
    });
    expect(badPatch.status).toBe(400);

    const linked = await stack.request("POST", `/api/projects/${projectId}/sources/${preprintId}/link`, {
      targetSourceId: publishedId,
      versionType: "preprint",
      targetVersionType: "journal",
    });
    expect(linked.status).toBe(200);
    const [a, b] = linked.body["sources"] as [SourceItem, SourceItem];
    expect(a.workKey).toBe(b.workKey);
    expect(a.relatedSourceIds).toContain(publishedId);
  });

  it("POST /:sid/enrich：resolver 补全元数据", async () => {
    const projectId = await createProject("enrich");
    // enrich=false 导入（无元数据），再显式 enrich
    const created = await stack.request("POST", `/api/projects/${projectId}/sources/import/doi`, {
      doi: "10.1234/known",
      enrich: false,
    });
    const sourceId = (created.body["source"] as SourceItem).sourceId;
    const enriched = await stack.request("POST", `/api/projects/${projectId}/sources/${sourceId}/enrich`, {});
    expect(enriched.status).toBe(200);
    const source = enriched.body["source"] as SourceItem;
    expect(source.metadata.title).toBe("Known Paper");
    expect((enriched.body["resolve"] as { outcome: string }).outcome).toBe("match");
  });

  it("DELETE /:sid：Evidence 引用 → 409 SOURCE_IN_USE；无引用 → 200", async () => {
    const projectId = await createProject("受保护删除");
    const created = await stack.request("POST", `/api/projects/${projectId}/sources/import/doi`, {
      doi: "10.1234/known",
    });
    const sourceId = (created.body["source"] as SourceItem).sourceId;
    await stack.request("POST", `/api/projects/${projectId}/evidence`, {
      claim: "引用该文献的论断",
      source: { sourceId, title: "Known Paper" },
    });
    const blocked = await stack.request("DELETE", `/api/projects/${projectId}/sources/${sourceId}`);
    expect(blocked.status).toBe(409);
    expect((blocked.body["error"] as { code: string }).code).toBe("SOURCE_IN_USE");

    // 无引用的条目可删
    const other = await stack.request("POST", `/api/projects/${projectId}/sources/import/doi`, {
      doi: "10.1234/free",
      enrich: false,
    });
    const otherId = (other.body["source"] as SourceItem).sourceId;
    const del = await stack.request("DELETE", `/api/projects/${projectId}/sources/${otherId}`);
    expect(del.status).toBe(200);
  });
});

describe("越权与非法访问", () => {
  it("非法 projectId → 400/404（路径正则不匹配 → 404）", async () => {
    const invalid = await stack.request("GET", "/api/projects/UPPER_case/sources");
    expect([400, 404]).toContain(invalid.status);
    const pathTraversal = await stack.request("GET", "/api/projects/../etc/sources");
    expect([400, 404]).toContain(pathTraversal.status);
  });

  it("跨项目 sourceId 访问 → 404（项目隔离）", async () => {
    const projectA = await createProject("隔离 A");
    const projectB = await createProject("隔离 B");
    const created = await stack.request("POST", `/api/projects/${projectA}/sources/import/doi`, {
      doi: "10.1234/known",
    });
    const sourceIdA = (created.body["source"] as SourceItem).sourceId;
    // B 项目同 ID 不存在（各项目独立编号）
    const cross = await stack.request("GET", `/api/projects/${projectB}/sources/${sourceIdA}`);
    expect(cross.status).toBe(404);
    const crossDelete = await stack.request("DELETE", `/api/projects/${projectB}/sources/${sourceIdA}`);
    expect(crossDelete.status).toBe(404);
    // 跨项目候选同理
    const crossCandidate = await stack.request("POST", `/api/projects/${projectB}/sources/candidates/C001/promote`, {});
    expect(crossCandidate.status).toBe(404);
  });

  it("不存在的项目 → 404", async () => {
    const missing = await stack.request("GET", "/api/projects/p-nonexistent/sources");
    expect(missing.status).toBe(404);
  });
});
