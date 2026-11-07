/**
 * M10.1 IngestionService 域测试：
 * - PDF 结构化路径（fake docling：blocks 落盘、counts、freshness）
 * - docling 不可用 → 显式降级 legacy 文本层（parseMode=text_only + degradedFrom）
 * - 解析失败 → status=failed 落盘（不静默、可重试）
 * - CSV 内联解析（真实 CsvParser）
 * - 结构化记录 → user_confirmed Evidence（机械值校验 + provenance +
 *   不提升 grounded_verified）
 */

import { afterAll, describe, expect, it, vi } from "vitest";

import { isFormalEvidence, classifyEvidence } from "../../src/evidence/EvidenceSelectionService.js";
import { DocumentParseFailedError } from "../../src/errors.js";
import {
  cleanupIngestionFixtures,
  fakeStructuredExtraction,
  newIngestionFixture,
  stubParser,
} from "./fixtures.js";
import { isDocumentFresh } from "../../src/ingestion/types.js";
import type { DocumentParseOptions, DocumentParseProgress, DocumentParser } from "../../src/ingestion/types.js";

afterAll(async () => {
  await cleanupIngestionFixtures();
});

describe("M10.1B PDF 结构化 ingestion（fake docling）", () => {
  it("docling 输出 → ParsedDocument：blocks / counts / provenance 落盘且可读回", async () => {
    const f = await newIngestionFixture({
      structuredParser: stubParser("docling", () => fakeStructuredExtraction()),
    });
    const source = await f.addFileSource("paper.pdf", Buffer.from("%PDF-1.4 fake"));
    const document = await f.ingestion.ingest(f.projectId, source.sourceId);
    expect(document.status).toBe("ok");
    expect(document.parseMode).toBe("structured");
    expect(document.parser.id).toBe("docling");
    expect(document.pageCount).toBe(3);
    expect(document.counts).toEqual({
      text: 3,
      table: 1,
      figure: 1,
      formula: 1,
      structured_record: 0,
      code: 0,
      output: 0,
    });
    const table = document.blocks.find((block) => block.type === "table");
    expect(table).toBeDefined();
    if (table?.type === "table") {
      expect(table.provenance.page).toBe(2);
      expect(table.provenance.bbox).toEqual({ x0: 10, y0: 20, x1: 80, y1: 40 });
      expect(table.rows[0]).toEqual(["Ours", "82.4", "79.1"]);
    }
    const figure = document.blocks.find((block) => block.type === "figure");
    expect(figure?.type === "figure" && figure.assetName).toBe("fig-001.png");

    // 落盘可读回 + freshness 对当前内容成立
    const reloaded = await f.documents.load(f.projectId, source.sourceId);
    expect(reloaded?.blocks.length).toBe(6);
    expect(isDocumentFresh(reloaded!, source)).toBe(true);
    expect(await f.ingestion.getDocument(f.projectId, source.sourceId)).not.toBeNull();
  });

  it("docling 不可用 → 显式降级 legacy 文本层（text_only + degradedFrom 审计）", async () => {
    const legacyExtraction = fakeStructuredExtraction({
      parser: { id: "pymupdf", version: "1.28" },
      mode: "text_only",
      quality: "partial",
      blocks: [
        {
          blockId: "B0001",
          type: "text",
          provenance: { fileName: "paper.pdf", page: 1 },
          text: "text layer only",
          textKind: "paragraph",
        },
      ],
      notes: ["文本层降级解析（docling 不可用）"],
    });
    const f = await newIngestionFixture({
      structuredParser: stubParser("docling", "unavailable"),
      fallbackParser: stubParser("pymupdf", () => legacyExtraction),
    });
    const source = await f.addFileSource("paper.pdf", Buffer.from("%PDF-1.4 fake"));
    const document = await f.ingestion.ingest(f.projectId, source.sourceId);
    expect(document.status).toBe("partial");
    expect(document.parseMode).toBe("text_only");
    expect(document.parser.id).toBe("pymupdf");
    expect(document.degradedFrom).toMatchObject({ parser: "docling" });
    expect(document.degradedFrom?.reason).toContain("docling");
    expect(document.notes.join(" ")).toContain("降级");
  });

  it("docling 解析失败（损坏 PDF）→ status=failed 落盘；重试成功后覆盖", async () => {
    let fail = true;
    const f = await newIngestionFixture({
      structuredParser: stubParser("docling", () => {
        if (fail) {
          throw new DocumentParseFailedError("无法打开 PDF：损坏");
        }
        return fakeStructuredExtraction();
      }),
    });
    const source = await f.addFileSource("broken.pdf", Buffer.from("%PDF-1.4 broken"));
    const failed = await f.ingestion.ingest(f.projectId, source.sourceId);
    expect(failed.status).toBe("failed");
    expect(failed.notes[0]).toContain("解析失败");
    // failed 文档不进入 getDocument 消费面？——不：getDocument 返回（状态如实），
    // 但 chunker 的 loadStructuredDocument 会跳过 failed；这里验证读取一致性
    expect((await f.ingestion.getDocument(f.projectId, source.sourceId))?.status).toBe("failed");
    // 修复后重试成功覆盖
    fail = false;
    const recovered = await f.ingestion.ingest(f.projectId, source.sourceId);
    expect(recovered.status).toBe("ok");
  });

  it("内容变化（重新上传同 id 不同内容）→ 旧产物过期（freshness 破产）", async () => {
    const f = await newIngestionFixture({
      structuredParser: stubParser("docling", () => fakeStructuredExtraction()),
    });
    const first = await f.addFileSource("a.pdf", Buffer.from("%PDF-1.4 one"));
    await f.ingestion.ingest(f.projectId, first.sourceId);
    // 直接篡改 contentHash 模拟内容变化（SourceStore.add 同名会新建条目；
    // 构造过期产物场景）
    const doc = await f.documents.load(f.projectId, first.sourceId);
    expect(doc).not.toBeNull();
    const stale = { ...doc!, contentHash: "0".repeat(64) };
    await f.documents.save(f.projectId, stale);
    expect(await f.ingestion.getDocument(f.projectId, first.sourceId)).toBeNull();
  });
});

describe("M10.1C CSV ingestion + user_confirmed Evidence", () => {
  const CSV = "Method,MOTA,IDF1\nOurs,82.4,79.1\nBaseline,78.2,75.0\n";

  it("CSV → 结构化记录 → 用户确认 → user_confirmed Evidence（provenance 齐）", async () => {
    const f = await newIngestionFixture();
    const source = await f.addFileSource("experiment.csv", CSV);
    const document = await f.ingestion.ingest(f.projectId, source.sourceId);
    expect(document.kind).toBe("tabular");
    expect(document.counts.structured_record).toBe(2);

    const { evidence, cell } = await f.ingestion.confirmRecordEvidence(f.projectId, source.sourceId, {
      row: 2,
      column: "MOTA",
      claim: "Ours 在 MOT17 上 MOTA = 82.4",
    });
    expect(evidence.verificationLevel).toBe("user_confirmed");
    expect(evidence.verificationStatus).toBe("unverified");
    expect(evidence.verificationMethod).toBe("user-confirmed:experiment-data");
    expect(evidence.quote).toBe("82.4");
    expect(evidence.location).toMatchObject({ row: 2, column: "MOTA" });
    expect(evidence.location?.sheet).toBeUndefined();
    expect(evidence.source?.sourceId).toBe(source.sourceId);
    expect(evidence.createdBy).toBe("user");
    expect(cell.value).toBe("82.4");
  });

  it("claim 未提到记录值 → EVIDENCE_VALUE_MISMATCH（数值等价除外）", async () => {
    const f = await newIngestionFixture();
    const source = await f.addFileSource("experiment.csv", CSV);
    await f.ingestion.ingest(f.projectId, source.sourceId);
    // 字面不含且数值不等 → 拒绝
    await expect(
      f.ingestion.confirmRecordEvidence(f.projectId, source.sourceId, {
        row: 2,
        column: "MOTA",
        claim: "Ours 的 MOTA 达到 90.0",
      }),
    ).rejects.toMatchObject({ code: "EVIDENCE_VALUE_MISMATCH" });
    // 数值等价（82.40 ≡ 82.4）→ 允许
    const { evidence } = await f.ingestion.confirmRecordEvidence(f.projectId, source.sourceId, {
      row: 2,
      column: "MOTA",
      claim: "Ours 在 MOT17 上 MOTA = 82.40（四舍五入前）",
    });
    expect(evidence.quote).toBe("82.4");
  });

  it("行 / 列不存在、空单元格、未解析 → 结构化错误（不静默）", async () => {
    const f = await newIngestionFixture();
    const source = await f.addFileSource("experiment.csv", CSV);
    await f.ingestion.ingest(f.projectId, source.sourceId);
    await expect(
      f.ingestion.confirmRecordEvidence(f.projectId, source.sourceId, { row: 99, column: "MOTA", claim: "x 82.4" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    await expect(
      f.ingestion.confirmRecordEvidence(f.projectId, source.sourceId, { row: 2, column: "Nope", claim: "82.4" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // 空单元格：cells 不产出空值列 → 按列不存在处理（无可确认事实）
    const gappy = await f.addFileSource("gappy.csv", "a,b\n1,\n");
    await f.ingestion.ingest(f.projectId, gappy.sourceId);
    await expect(
      f.ingestion.confirmRecordEvidence(f.projectId, gappy.sourceId, { row: 2, column: "b", claim: "anything" }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
    // 未解析的 source → 400 提示先 ingest
    const fresh = await f.addFileSource("other.csv", "a,b\n1,2\n");
    await expect(
      f.ingestion.confirmRecordEvidence(f.projectId, fresh.sourceId, { row: 2, column: "a", claim: "1" }),
    ).rejects.toMatchObject({ code: "INVALID_REQUEST" });
  });

  it("user_confirmed 证据不被提升为 grounded_verified（formal 池排除）", async () => {
    const f = await newIngestionFixture();
    const source = await f.addFileSource("experiment.csv", CSV);
    await f.ingestion.ingest(f.projectId, source.sourceId);
    const { evidence } = await f.ingestion.confirmRecordEvidence(f.projectId, source.sourceId, {
      row: 2,
      column: "MOTA",
      claim: "Ours 在 MOT17 上 MOTA = 82.4",
    });
    expect(isFormalEvidence(evidence)).toBe(false);
    expect(classifyEvidence(evidence)).not.toBe("grounded_verified");
    // 与一条 grounded verified（三件套齐）对照：分级隔离成立
    const grounded = {
      ...evidence,
      verificationStatus: "verified" as const,
      location: { ...evidence.location, chunk: "S001:SEC01:1:abc" },
    };
    expect(isFormalEvidence(grounded)).toBe(true);
    expect(classifyEvidence(grounded)).toBe("grounded_verified");
  });

  it("factPreservation 授权链可消费 user_confirmed 证据值（quote 进 evidenceTexts）", async () => {
    const f = await newIngestionFixture();
    const source = await f.addFileSource("experiment.csv", CSV);
    await f.ingestion.ingest(f.projectId, source.sourceId);
    const { evidence } = await f.ingestion.confirmRecordEvidence(f.projectId, source.sourceId, {
      row: 2,
      column: "MOTA",
      claim: "Ours 在 MOT17 上 MOTA = 82.4",
    });
    const records = await f.evidence.list(f.projectId);
    const evidenceTexts = records.flatMap((record) => [record.claim, record.summary ?? "", record.quote ?? ""]);
    // factPreservation 的 mentionsValue 授权口径：值出现在证据文本中
    expect(evidenceTexts.join(" ")).toContain("82.4");
    expect(records).toHaveLength(1);
    void evidence;
  });

  it("listRecords：sheet 过滤 + 行窗口 + 上限", async () => {
    const f = await newIngestionFixture();
    const csv = Array.from({ length: 30 }, (_, i) => `r${i + 1},${i * 10}`).join("\n");
    const source = await f.addFileSource("big.csv", `name,value\n${csv}\n`);
    await f.ingestion.ingest(f.projectId, source.sourceId);
    const window = await f.ingestion.listRecords(f.projectId, source.sourceId, {
      rowFrom: 5,
      rowTo: 10,
      limit: 3,
    });
    expect(window.records).toHaveLength(3);
    expect(window.records[0]!.provenance.row).toBe(5);
  });
});

describe("M10.1C XLSX ingestion（sheet provenance）", () => {
  it("xlsx → 记录带 sheet；确认时 sheet 参与寻址", async () => {
    const ExcelJS = (await import("exceljs")).default;
    const workbook = new ExcelJS.Workbook();
    const sheet1 = workbook.addWorksheet("Sheet1");
    sheet1.addRow(["Method", "MOTA"]);
    sheet1.addRow(["Ours", 82.4]);
    const sheet2 = workbook.addWorksheet("Ablation");
    sheet2.addRow(["Variant", "MOTA"]);
    sheet2.addRow(["w/o motion", 80.1]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    const f = await newIngestionFixture();
    const source = await f.addFileSource("experiment.xlsx", buffer);
    const document = await f.ingestion.ingest(f.projectId, source.sourceId);
    expect(document.kind).toBe("tabular");
    expect(document.sheets?.map((sheet) => sheet.name)).toEqual(["Sheet1", "Ablation"]);

    const { evidence } = await f.ingestion.confirmRecordEvidence(f.projectId, source.sourceId, {
      sheet: "Ablation",
      row: 2,
      column: "MOTA",
      claim: "去掉运动模型后 MOTA 降到 80.1",
    });
    expect(evidence.location).toMatchObject({ sheet: "Ablation", row: 2, column: "MOTA" });
    expect(evidence.quote).toBe("80.1");

    // sheet 不匹配 → 找不到记录
    await expect(
      f.ingestion.confirmRecordEvidence(f.projectId, source.sourceId, {
        sheet: "NoSuchSheet",
        row: 2,
        column: "MOTA",
        claim: "80.1",
      }),
    ).rejects.toMatchObject({ code: "NOT_FOUND" });
  });

  it("损坏 xlsx → failed 文档落盘（上传不因此失败）", async () => {
    const f = await newIngestionFixture();
    const source = await f.addFileSource("broken.xlsx", Buffer.from("not an xlsx", "utf8"));
    const document = await f.ingestion.ingest(f.projectId, source.sourceId);
    expect(document.status).toBe("failed");
    expect(document.notes[0]).toContain("解析失败");
  });
});

/** 受控 parser：解析挂起直到 release()；progress() 经当前解析的 onProgress 上报；尊重 signal */
function gatedParser() {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let current: DocumentParseOptions = {};
  let calls = 0;
  let markStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    markStarted = resolve;
  });
  const parser: DocumentParser = {
    id: "docling",
    async parseFile(_path: string, options: DocumentParseOptions = {}) {
      calls += 1;
      current = options;
      markStarted();
      options.signal?.throwIfAborted();
      await new Promise<void>((resolve, reject) => {
        void gate.then(resolve);
        options.signal?.addEventListener("abort", () => reject(options.signal?.reason), { once: true });
      });
      return fakeStructuredExtraction();
    },
  };
  return {
    parser,
    release: () => release(),
    /** parseFile 已被调用（替代固定 sleep，避免高负载下时序抖动） */
    started,
    progress: (detail: string) => current.onProgress?.({ state: "parsing", detail }),
    calls: () => calls,
  };
}

describe("M17.2.2 ingest 取消与进度心跳", () => {
  it("发起方取消 → 拒绝且不落 failed 文档（取消 ≠ 解析失败）；之后重新 ingest 正常完成", async () => {
    const gated = gatedParser();
    const f = await newIngestionFixture({ structuredParser: gated.parser });
    const source = await f.addFileSource("paper.pdf", Buffer.from("%PDF-1.4 fake"));
    const controller = new AbortController();
    const pending = f.ingestion.ingest(f.projectId, source.sourceId, { signal: controller.signal });
    await gated.started;
    controller.abort(new Error("stage-timeout"));
    await expect(pending).rejects.toThrow("stage-timeout");
    expect(await f.documents.load(f.projectId, source.sourceId)).toBeNull();

    gated.release();
    const document = await f.ingestion.ingest(f.projectId, source.sourceId);
    expect(document.status).toBe("ok");
    expect(gated.calls()).toBe(2);
  });

  it("加入他人发起的在途解析：收到进度心跳；加入方取消只结束自己的等待，共享解析继续", async () => {
    const gated = gatedParser();
    const f = await newIngestionFixture({ structuredParser: gated.parser });
    const source = await f.addFileSource("paper.pdf", Buffer.from("%PDF-1.4 fake"));
    const owner = f.ingestion.ingest(f.projectId, source.sourceId);
    await gated.started;
    const heard: DocumentParseProgress[] = [];
    const controller = new AbortController();
    const joined = f.ingestion.ingest(f.projectId, source.sourceId, {
      signal: controller.signal,
      onProgress: (event) => heard.push(event),
    });
    // 加入方的订阅在 ingest 内部异步完成：重复发进度直到被听到（不依赖固定 sleep）
    await vi.waitFor(() => {
      gated.progress("pipeline layout p1");
      expect(heard.length).toBeGreaterThan(0);
    });
    expect(heard.every((event) => event.state === "parsing" && event.detail === "pipeline layout p1")).toBe(true);
    const heardBeforeCancel = heard.length;
    controller.abort(new Error("joiner-cancelled"));
    await expect(joined).rejects.toThrow("joiner-cancelled");
    gated.progress("pipeline table p1");
    expect(heard).toHaveLength(heardBeforeCancel);

    gated.release();
    await expect(owner).resolves.toMatchObject({ status: "ok" });
    expect(gated.calls()).toBe(1);
  });

  it("解析超时类失败（parser 报 INGESTION_PARSE_FAILED）仍如实落 failed 文档，消息不提模型下载", async () => {
    const f = await newIngestionFixture({
      structuredParser: {
        id: "docling",
        async parseFile() {
          throw new DocumentParseFailedError("解析无进展超时（300000ms 内没有新的解析进度；最后进度：pipeline table p3）");
        },
      },
    });
    const source = await f.addFileSource("paper.pdf", Buffer.from("%PDF-1.4 fake"));
    const document = await f.ingestion.ingest(f.projectId, source.sourceId);
    expect(document.status).toBe("failed");
    expect(document.blocks).toHaveLength(0);
    expect(document.notes[0]).toContain("无进展");
    expect(document.notes[0]).not.toContain("模型下载");
  });
});
