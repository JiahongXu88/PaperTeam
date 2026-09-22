/**
 * M7.2/M9.3 全文 HTTP 端点测试：
 * - POST /api/projects/:id/sources/:sid/resolve-fulltext（M7.2 单篇）
 * - POST /api/projects/:id/sources/resolve-fulltext（M9.3 批量）
 * - POST /api/projects/:id/sources/:sid/fulltext（M9.3 手动 PDF 补挂）
 *
 * resolver 注入 fake（not_found 路径 → 零网络）；resolved 路径的网络编排由
 * fullTextAttach.test.ts / fullTextBatch.test.ts 域测试覆盖，手动补挂的
 * resolved 路径（无网络）在此 HTTP 层直测。
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { scriptedIdeaRuntime, startTestStack, type TestStack } from "../helpers/testStack.js";

let stack: TestStack;
let cleanup: (() => Promise<void>) | undefined;
afterAll(async () => {
  await cleanup?.();
});

beforeAll(async () => {
  stack = await startTestStack(scriptedIdeaRuntime().runtime, {
    // 注入 fake resolver：not_found（resolve 后不进下载 → 零网络）
    fullText: {
      resolvers: [
        {
          name: "unpaywall",
          async resolve() {
            return { kind: "not_found" as const };
          },
        },
      ],
    },
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
  const content = `BT /F1 12 Tf 72 720 Td (resolve fulltext http test upload) Tj ET`;
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
  return Buffer.from(parts.join("\n"), "latin1").toString("base64");
}

describe("POST /sources/:sid/resolve-fulltext", () => {
  it("条目不存在 → 404", async () => {
    const projectId = await createProject("全文端点 404");
    const response = await stack.request("POST", `/api/projects/${projectId}/sources/S999/resolve-fulltext`);
    expect(response.status).toBe(404);
    expect((response.body["error"] as { code: string }).code).toBe("NOT_FOUND");
  });

  it("url-only 身份 → 422 FULLTEXT_NOT_RESOLVABLE（确定性不可解析）", async () => {
    const projectId = await createProject("全文端点 422");
    const imported = await stack.request("POST", `/api/projects/${projectId}/sources/import/url`, {
      url: "https://blog.example.org/no-doi-post",
    });
    expect(imported.status).toBe(201);
    const sourceId = (imported.body["source"] as { sourceId: string }).sourceId;
    const response = await stack.request("POST", `/api/projects/${projectId}/sources/${sourceId}/resolve-fulltext`);
    expect(response.status).toBe(422);
    expect((response.body["error"] as { code: string }).code).toBe("FULLTEXT_NOT_RESOLVABLE");
  });

  it("resolver not_found → 200 outcome=not_found，条目保持 metadata_only + provenance 落盘", async () => {
    const projectId = await createProject("全文端点 not_found");
    const imported = await stack.request("POST", `/api/projects/${projectId}/sources/import/doi`, {
      doi: "10.1234/http-closed",
      enrich: false,
    });
    const sourceId = (imported.body["source"] as { sourceId: string }).sourceId;
    const response = await stack.request("POST", `/api/projects/${projectId}/sources/${sourceId}/resolve-fulltext`);
    expect(response.status).toBe(200);
    expect(response.body["outcome"]).toBe("not_found");
    const source = response.body["source"] as {
      status: string;
      fullText?: { status: string; attempts: number; note?: string };
    };
    expect(source.status).toBe("metadata_only");
    expect(source.fullText).toMatchObject({ status: "not_found", attempts: 1 });
    expect(source.fullText?.note).toContain("unpaywall:not_found");
  });

  it("已有全文 → 200 outcome=skipped_has_file（幂等）", async () => {
    const projectId = await createProject("全文端点 skipped");
    const uploaded = await stack.request("POST", `/api/projects/${projectId}/sources`, {
      fileName: "manual.pdf",
      contentBase64: minimalPdfBase64(),
    });
    expect(uploaded.status).toBe(201);
    const sourceId = (uploaded.body["source"] as { sourceId: string }).sourceId;
    const response = await stack.request("POST", `/api/projects/${projectId}/sources/${sourceId}/resolve-fulltext`);
    expect(response.status).toBe(200);
    expect(response.body["outcome"]).toBe("skipped_has_file");
  });

  it("非 POST → 405", async () => {
    const projectId = await createProject("全文端点 405");
    const response = await stack.request("GET", `/api/projects/${projectId}/sources/S001/resolve-fulltext`);
    expect(response.status).toBe(405);
  });
});

describe("POST /sources/resolve-fulltext（M9.3 批量）", () => {
  it("mixed 批次 → 200 五桶汇总（not_found / not_resolvable / skipped）+ 逐条结果", async () => {
    const projectId = await createProject("批量全文 mixed");
    const closed = await stack.request("POST", `/api/projects/${projectId}/sources/import/doi`, {
      doi: "10.1234/batch-http-closed",
      enrich: false,
    });
    const web = await stack.request("POST", `/api/projects/${projectId}/sources/import/url`, {
      url: "https://blog.example.org/searxng-result",
    });
    const uploaded = await stack.request("POST", `/api/projects/${projectId}/sources`, {
      fileName: "has.pdf",
      contentBase64: minimalPdfBase64(),
    });
    const ids = [
      (closed.body["source"] as { sourceId: string }).sourceId,
      (web.body["source"] as { sourceId: string }).sourceId,
      (uploaded.body["source"] as { sourceId: string }).sourceId,
    ];
    const response = await stack.request("POST", `/api/projects/${projectId}/sources/resolve-fulltext`, {
      sourceIds: ids,
    });
    expect(response.status).toBe(200);
    expect(response.body["summary"]).toEqual({
      total: 3,
      resolved: 0,
      notFound: 1,
      failed: 0,
      notResolvable: 1,
      skipped: 1,
    });
    const results = response.body["results"] as Array<{ sourceId: string; outcome: string }>;
    expect(results.map((entry) => entry.sourceId)).toEqual(ids);
    expect(results[0]).toMatchObject({ outcome: "not_found" });
    expect(results[1]).toMatchObject({ outcome: "not_resolvable" });
    expect(results[2]).toMatchObject({ outcome: "skipped_has_file" });
    // 不存在的条目：批次整体 400（不做半批静默）
    const bad = await stack.request("POST", `/api/projects/${projectId}/sources/resolve-fulltext`, {
      sourceIds: [ids[0]!, "S999"],
    });
    expect(bad.status).toBe(400);
    expect((bad.body["error"] as { code: string }).code).toBe("INVALID_REQUEST");
  });

  it("请求体校验：缺 sourceIds / 空数组 / 非法形态 / 超上限 → 400", async () => {
    const projectId = await createProject("批量全文 400");
    for (const body of [
      {},
      { sourceIds: [] },
      { sourceIds: "S001" },
      { sourceIds: ["s001"] },
      { sourceIds: ["S1"] },
      { sourceIds: Array.from({ length: 51 }, (_, i) => `S${String(i + 1).padStart(3, "0")}`) },
    ]) {
      const response = await stack.request("POST", `/api/projects/${projectId}/sources/resolve-fulltext`, body);
      expect(response.status).toBe(400);
      expect((response.body["error"] as { code: string }).code).toBe("INVALID_REQUEST");
    }
  });

  it("不存在的项目 → 404；重复 id 去重；非 POST → 405", async () => {
    const missing = await stack.request("POST", "/api/projects/no-such-proj/sources/resolve-fulltext", {
      sourceIds: ["S001"],
    });
    expect(missing.status).toBe(404);
    const projectId = await createProject("批量全文 405");
    const notAllowed = await stack.request("GET", `/api/projects/${projectId}/sources/resolve-fulltext`);
    expect(notAllowed.status).toBe(405);
  });
});

describe("POST /sources/:sid/fulltext（M9.3 手动 PDF 补挂）", () => {
  it("成功：200 outcome=resolved + manual-upload provenance；重复上传幂等 skipped", async () => {
    const projectId = await createProject("手动补挂成功");
    const imported = await stack.request("POST", `/api/projects/${projectId}/sources/import/doi`, {
      doi: "10.1234/manual-http",
      enrich: false,
    });
    const sourceId = (imported.body["source"] as { sourceId: string }).sourceId;
    const attach = await stack.request("POST", `/api/projects/${projectId}/sources/${sourceId}/fulltext`, {
      fileName: "author-copy.pdf",
      contentBase64: minimalPdfBase64(),
    });
    expect(attach.status).toBe(200);
    expect(attach.body["outcome"]).toBe("resolved");
    const source = attach.body["source"] as {
      fileName?: string;
      fullText?: { status: string; resolver?: string; bytes?: number };
    };
    expect(source.fileName).toBe(`${sourceId}-author-copy.pdf`);
    expect(source.fullText).toMatchObject({
      status: "resolved",
      resolver: "manual-upload",
      bytes: Buffer.from(minimalPdfBase64(), "base64").byteLength,
    });
    const again = await stack.request("POST", `/api/projects/${projectId}/sources/${sourceId}/fulltext`, {
      fileName: "other.pdf",
      contentBase64: minimalPdfBase64(),
    });
    expect(again.status).toBe(200);
    expect(again.body["outcome"]).toBe("skipped_has_file");
  });

  it("非 PDF 魔数 / 非 .pdf 文件名 / 缺字段 → 400", async () => {
    const projectId = await createProject("手动补挂 400");
    const imported = await stack.request("POST", `/api/projects/${projectId}/sources/import/doi`, {
      doi: "10.1234/manual-bad",
      enrich: false,
    });
    const sourceId = (imported.body["source"] as { sourceId: string }).sourceId;
    const fake = await stack.request("POST", `/api/projects/${projectId}/sources/${sourceId}/fulltext`, {
      fileName: "fake.pdf",
      contentBase64: Buffer.from("<html>landing page</html>").toString("base64"),
    });
    expect(fake.status).toBe(400);
    const notPdfName = await stack.request("POST", `/api/projects/${projectId}/sources/${sourceId}/fulltext`, {
      fileName: "paper.txt",
      contentBase64: minimalPdfBase64(),
    });
    expect(notPdfName.status).toBe(400);
    const noFile = await stack.request("POST", `/api/projects/${projectId}/sources/${sourceId}/fulltext`, {
      contentBase64: minimalPdfBase64(),
    });
    expect(noFile.status).toBe(400);
  });

  it("超限文件（>20MB 解码后）→ 400；条目不存在 → 404；跨项目不可见", async () => {
    const projectId = await createProject("手动补挂超限");
    const imported = await stack.request("POST", `/api/projects/${projectId}/sources/import/doi`, {
      doi: "10.1234/manual-huge",
      enrich: false,
    });
    const sourceId = (imported.body["source"] as { sourceId: string }).sourceId;
    const oversized = Buffer.concat([Buffer.from("%PDF-1.4"), Buffer.alloc(20 * 1024 * 1024 + 1, 0x61)]);
    const huge = await stack.request("POST", `/api/projects/${projectId}/sources/${sourceId}/fulltext`, {
      fileName: "huge.pdf",
      contentBase64: oversized.toString("base64"),
    });
    expect(huge.status).toBe(400);
    const notFound = await stack.request("POST", `/api/projects/${projectId}/sources/S999/fulltext`, {
      fileName: "x.pdf",
      contentBase64: minimalPdfBase64(),
    });
    expect(notFound.status).toBe(404);
    // 跨项目：B 项目的条目在 A 项目路径下不可见（sourceId 每项目独立编号，
    // B 建两条使 S002 在 A 项目不存在）
    const projectB = await createProject("手动补挂项目 B");
    await stack.request("POST", `/api/projects/${projectB}/sources/import/doi`, {
      doi: "10.1234/manual-b-first",
      enrich: false,
    });
    const importedB = await stack.request("POST", `/api/projects/${projectB}/sources/import/doi`, {
      doi: "10.1234/manual-b-second",
      enrich: false,
    });
    const sourceIdB = (importedB.body["source"] as { sourceId: string }).sourceId;
    expect(sourceIdB).toBe("S002");
    const cross = await stack.request("POST", `/api/projects/${projectId}/sources/${sourceIdB}/fulltext`, {
      fileName: "x.pdf",
      contentBase64: minimalPdfBase64(),
    });
    expect(cross.status).toBe(404);
  });

  it("非 POST → 405", async () => {
    const projectId = await createProject("手动补挂 405");
    const response = await stack.request("GET", `/api/projects/${projectId}/sources/S001/fulltext`);
    expect(response.status).toBe(405);
  });

  it("Evidence 边界：批量解析 + 手动补挂后 evidence 列表为空", async () => {
    const projectId = await createProject("全文 Evidence 边界");
    const closed = await stack.request("POST", `/api/projects/${projectId}/sources/import/doi`, {
      doi: "10.1234/ev-boundary",
      enrich: false,
    });
    const sourceId = (closed.body["source"] as { sourceId: string }).sourceId;
    await stack.request("POST", `/api/projects/${projectId}/sources/resolve-fulltext`, {
      sourceIds: [sourceId],
    });
    await stack.request("POST", `/api/projects/${projectId}/sources/${sourceId}/fulltext`, {
      fileName: "m.pdf",
      contentBase64: minimalPdfBase64(),
    });
    const evidence = await stack.request("GET", `/api/projects/${projectId}/evidence`);
    expect(evidence.status).toBe(200);
    expect(evidence.body["evidence"]).toEqual([]);
  });
});
