/**
 * M7.2 全文解析 HTTP 端点测试：POST /api/projects/:id/sources/:sid/resolve-fulltext。
 *
 * 只覆盖零网络路径（404 条目 / 422 不可解析身份 / 200 not_found / 200
 * skipped_has_file）；resolved 路径的完整编排由 fullTextAttach.test.ts 域测试
 * 覆盖（HTTP 层只是薄转发）。
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
