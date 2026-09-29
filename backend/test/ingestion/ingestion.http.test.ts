/**
 * M10.1 HTTP 端点测试（CSV/XLSX 内联 ingestion + records → user_confirmed
 * evidence；PDF 上传后台 ingestion 不阻塞响应）：
 * - POST /sources（csv/xlsx 上传 → 响应含 ingestion 汇总，失败也如实呈现）
 * - GET /sources/:id/document（未解析 → null + 提示；blocks 截断）
 * - GET /sources/:id/records（窗口读取）
 * - POST /sources/:id/records/evidence（确认 → 201 user_confirmed；值不符 → 422）
 * - 分级隔离：user_confirmed 证据不进 formal 池（grounded_verified 不受污染）
 */

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import ExcelJS from "exceljs";

import { scriptedIdeaRuntime, startTestStack, type TestStack } from "../helpers/testStack.js";
import { isFormalEvidence } from "../../src/evidence/EvidenceSelectionService.js";

let stack: TestStack;
let cleanup: (() => Promise<void>) | undefined;
afterAll(async () => {
  await cleanup?.();
});

beforeAll(async () => {
  stack = await startTestStack(scriptedIdeaRuntime().runtime, {
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

async function upload(projectId: string, fileName: string, content: Buffer) {
  return stack.request("POST", `/api/projects/${projectId}/sources`, {
    fileName,
    contentBase64: content.toString("base64"),
  });
}

const CSV = "Method,MOTA,IDF1\nOurs,82.4,79.1\nBaseline,78.2,75.0\n";

async function xlsxBuffer(): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Results");
  sheet.addRow(["Method", "MOTA"]);
  sheet.addRow(["Ours", 82.4]);
  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("M10.1 sources × ingestion HTTP", () => {
  it("CSV 上传 → 201 + ingestion 汇总（structured / records）", async () => {
    const projectId = await createProject("csv ingestion");
    const response = await upload(projectId, "experiment.csv", Buffer.from(CSV, "utf8"));
    expect(response.status).toBe(201);
    const ingestion = response.body["ingestion"] as Record<string, unknown>;
    expect(ingestion).toBeDefined();
    expect(ingestion["status"]).toBe("ok");
    expect(ingestion["parseMode"]).toBe("structured");
    expect(ingestion["kind"]).toBe("tabular");
    expect((ingestion["counts"] as Record<string, number>)["structured_record"]).toBe(2);
  });

  it("损坏 XLSX 上传 → 上传成功但 ingestion.status=failed 如实呈现", async () => {
    const projectId = await createProject("broken xlsx");
    const response = await upload(projectId, "broken.xlsx", Buffer.from("not an xlsx", "utf8"));
    expect(response.status).toBe(201);
    const ingestion = response.body["ingestion"] as Record<string, unknown>;
    expect(ingestion["status"]).toBe("failed");
    expect(JSON.stringify(ingestion["notes"])).toContain("解析失败");
  });

  it("PDF 上传 → 201 且响应不被慢解析阻塞（ingestion=pending）", async () => {
    const projectId = await createProject("pdf pending");
    const pdf = Buffer.from("%PDF-1.4\n1 0 obj\n<< /Type /Catalog >>\nendobj\n", "latin1");
    const response = await upload(projectId, "paper.pdf", pdf);
    expect(response.status).toBe(201);
    expect((response.body["ingestion"] as Record<string, unknown>)["status"]).toBe("pending");
  });

  it("GET document：未解析 → null + 提示；已解析 → 汇总 + blocks（显式请求）", async () => {
    const projectId = await createProject("document view");
    await upload(projectId, "experiment.csv", Buffer.from(CSV, "utf8"));
    const sources = await stack.request("GET", `/api/projects/${projectId}/sources`);
    const sourceId = ((sources.body["sources"] as Array<{ sourceId: string }>)[0]!).sourceId;

    const withBlocks = await stack.request(
      "GET",
      `/api/projects/${projectId}/sources/${sourceId}/document?blocks=true`,
    );
    expect(withBlocks.status).toBe(200);
    const document = withBlocks.body["document"] as Record<string, unknown>;
    expect(document["status"]).toBe("ok");
    expect(Array.isArray(document["blocks"])).toBe(true);

    // 未解析条目（txt）→ null + 提示
    await upload(projectId, "notes.txt", Buffer.from("just text", "utf8"));
    const sources2 = await stack.request("GET", `/api/projects/${projectId}/sources`);
    const txtId = (sources2.body["sources"] as Array<{ sourceId: string; fileName?: string }>).find(
      (item) => item.fileName?.endsWith(".txt"),
    )!.sourceId;
    const empty = await stack.request("GET", `/api/projects/${projectId}/sources/${txtId}/document`);
    expect(empty.status).toBe(200);
    expect(empty.body["document"]).toBeNull();
    expect(typeof empty.body["note"]).toBe("string");
  });

  it("GET records：行窗口 + sheet 过滤", async () => {
    const projectId = await createProject("records window");
    await upload(projectId, "experiment.csv", Buffer.from(CSV, "utf8"));
    const list = await stack.request("GET", `/api/projects/${projectId}/sources`);
    const sourceId = (list.body["sources"] as Array<{ sourceId: string }>)[0]!.sourceId;
    const records = await stack.request(
      "GET",
      `/api/projects/${projectId}/sources/${sourceId}/records?rowFrom=2&rowTo=2`,
    );
    expect(records.status).toBe(200);
    const rows = records.body["records"] as Array<{ provenance: { row: number } }>;
    expect(rows).toHaveLength(1);
    expect(rows[0]!.provenance.row).toBe(2);
  });

  it("POST records/evidence：CSV 确认 → 201 user_confirmed；值不符 → 422", async () => {
    const projectId = await createProject("csv evidence");
    await upload(projectId, "experiment.csv", Buffer.from(CSV, "utf8"));
    const list = await stack.request("GET", `/api/projects/${projectId}/sources`);
    const sourceId = (list.body["sources"] as Array<{ sourceId: string }>)[0]!.sourceId;

    const confirmed = await stack.request(
      "POST",
      `/api/projects/${projectId}/sources/${sourceId}/records/evidence`,
      { row: 2, column: "MOTA", claim: "Ours 在 MOT17 上 MOTA = 82.4" },
    );
    expect(confirmed.status).toBe(201);
    const evidence = confirmed.body["evidence"] as Record<string, unknown>;
    expect(evidence["verificationLevel"]).toBe("user_confirmed");
    expect(evidence["verificationStatus"]).toBe("unverified");
    expect(evidence["quote"]).toBe("82.4");
    expect(evidence["location"]).toMatchObject({ row: 2, column: "MOTA" });

    const mismatch = await stack.request(
      "POST",
      `/api/projects/${projectId}/sources/${sourceId}/records/evidence`,
      { row: 3, column: "MOTA", claim: "Baseline MOTA 是 99.9" },
    );
    expect(mismatch.status).toBe(422);
    expect((mismatch.body["error"] as { code: string }).code).toBe("EVIDENCE_VALUE_MISMATCH");
  });

  it("POST records/evidence：XLSX 带 sheet 寻址", async () => {
    const projectId = await createProject("xlsx evidence");
    await upload(projectId, "experiment.xlsx", await xlsxBuffer());
    const list = await stack.request("GET", `/api/projects/${projectId}/sources`);
    const sourceId = (list.body["sources"] as Array<{ sourceId: string }>)[0]!.sourceId;

    const confirmed = await stack.request(
      "POST",
      `/api/projects/${projectId}/sources/${sourceId}/records/evidence`,
      { sheet: "Results", row: 2, column: "MOTA", claim: "我们的方法 MOTA 82.4" },
    );
    expect(confirmed.status).toBe(201);
    expect(confirmed.body["evidence"]).toMatchObject({
      quote: "82.4",
      location: { sheet: "Results", row: 2, column: "MOTA" },
    });
  });

  it("user_confirmed 证据不进 formal 池（分级隔离，端到端）", async () => {
    const projectId = await createProject("formal isolation");
    await upload(projectId, "experiment.csv", Buffer.from(CSV, "utf8"));
    const list = await stack.request("GET", `/api/projects/${projectId}/sources`);
    const sourceId = (list.body["sources"] as Array<{ sourceId: string }>)[0]!.sourceId;
    await stack.request("POST", `/api/projects/${projectId}/sources/${sourceId}/records/evidence`, {
      row: 2,
      column: "MOTA",
      claim: "Ours 在 MOT17 上 MOTA = 82.4",
    });

    const evidenceList = await stack.request("GET", `/api/projects/${projectId}/evidence`);
    const records = evidenceList.body["evidence"] as Array<Record<string, unknown>>;
    expect(records).toHaveLength(1);
    expect(isFormalEvidence(records[0] as never)).toBe(false);

    const selection = await stack.stack.evidenceSelection.selectForWriting(projectId);
    expect(selection.formal).toHaveLength(0);
    expect(selection.excluded.legacyUnverified).toBe(1);
  });
});
