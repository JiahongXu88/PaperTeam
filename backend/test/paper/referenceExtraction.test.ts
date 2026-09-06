/**
 * M4.3.3 Reference / Citation Extraction 测试：
 * 单引用/多引用/range 展开/同文献多处被引/无效编号/无 DOI/Unicode/
 * author-year best-effort + 真实 arXiv PDF e2e。
 */

import { join } from "node:path";
import { readFile } from "node:fs/promises";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

import { ReferenceExtractor, expandNumericList } from "../../src/paper/ReferenceExtractor.js";
import type { PaperDocument } from "../../src/paper/types.js";
import type { CitationCallout, ReferenceEntry } from "../../src/citation/integrity.js";
import { startTestStack, scriptedIdeaRuntime, type TestStack } from "../helpers/testStack.js";

// ---- 合成文档构造 ----

function syntheticDocument(options: {
  referencesText: string;
  bodyText: string;
  pageCount?: number;
}): PaperDocument {
  const pageCount = options.pageCount ?? 4;
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
    projectId: "p-synthetic",
    documentId: "paper-1",
    originalFileName: "synthetic.pdf",
    bytes: 100,
    sha256: "a".repeat(64),
    parse: {
      parserId: "test",
      parsedAt: "2026-09-06T00:00:00.000Z",
      durationMs: 1,
      pageCount,
      extractionQuality: "good",
    },
    pages: Array.from({ length: pageCount }, (_, i) => ({
      pageId: `P${String(i + 1).padStart(3, "0")}`,
      pageNumber: i + 1,
      text: "",
      charCount: 0,
    })),
    sections: [
      { sectionId: "SEC01", title: "Introduction", level: 1, pageStart: 1, pageEnd: 1, charCount: 0, source: "toc" },
      { sectionId: "SEC02", title: "References", level: 1, pageStart: 2, pageEnd: pageCount, charCount: 0, source: "toc" },
    ],
    chunks: [
      chunk("C0001", 1, "SEC01", 1, options.bodyText),
      chunk("C0002", 2, "SEC02", 2, options.referencesText),
    ],
    referencesSectionId: "SEC02",
    ingestedAt: "2026-09-06T00:00:00.000Z",
  };
}

const REFS_TEXT = [
  "[1] Jimmy Lei Ba, Jamie Ryan Kiros, and Geoffrey E Hinton. Layer normalization. arXiv preprint arXiv:1607.06450, 2016.",
  "[2] Dzmitry Bahdanau, Kyunghyun Cho, and Yoshua Bengio. Neural machine translation by jointly learning to align and translate. CoRR, abs/1409.0473, 2014.",
  "[3] Vitaly Kurin and Peter Bender. No DOI in this entry at all, just a plain citation. 2020.",
  "[4] Zhang Wei and Müller Hans-Jöachim. Über die Aufmerksamkeitsmechanismen in neuronalen Netzen. In Proceedings of Beispielkonferenz, 2019.",
  "[5] Vaswani Ashish, Shazeer Noam, and Parmar Niki. Attention is all you need. In Advances in Neural Information Processing Systems, 2017. doi:10.5555/3294771.3295065",
  "[6] Luong Minh-Thang and Manning Christopher. Stanford neural machine translation. 2015.",
].join("\n\n");

describe("M4.3.3 ReferenceExtractor（合成 fixture）", () => {
  it("单引用 / 多引用 / range 展开 / 无效编号 / 同文献多处被引", () => {
    const document = syntheticDocument({
      referencesText: REFS_TEXT,
      bodyText:
        "Layer normalization stabilizes training [1]. Prior attention was content-based [2, 3]. " +
        "Several improvements were proposed [4-6]. A bogus marker [99] appears here. " +
        "Layer normalization is used again [1]. A missing gap [8] too. Vaswani introduced it (Vaswani et al., 2017).",
    });
    const { references, callouts } = new ReferenceExtractor().extract(document);

    // references：6 条，编号连续，含 Unicode 条目
    expect(references).toHaveLength(6);
    expect(references.map((r) => r.number)).toEqual([1, 2, 3, 4, 5, 6]);
    expect(references.every((r) => r.referenceId.startsWith("R") && r.fingerprint.length === 64)).toBe(true);
    const unicode = references.find((r) => r.number === 4)!;
    expect(unicode.rawText).toContain("Über die Aufmerksamkeitsmechanismen");
    expect(unicode.authors?.some((a) => a.includes("Müller"))).toBe(true);

    // DOI / arXiv / 无 DOI
    const withDoi = references.find((r) => r.number === 5)!;
    expect(withDoi.doi).toBe("10.5555/3294771.3295065");
    const withArxiv = references.find((r) => r.number === 1)!;
    expect(withArxiv.arxivId).toBe("1607.06450");
    expect(withArxiv.year).toBe(2016);
    const noDoi = references.find((r) => r.number === 3)!;
    expect(noDoi.doi).toBeUndefined();

    // callouts：单/多/range/invalid/重复/author-year
    const numeric = callouts.filter((c) => c.style === "numeric");
    const single = numeric.find((c) => c.references[0]?.label === "1" && c.references.length === 1)!;
    expect(single.references[0]).toMatchObject({ referenceId: "R001", status: "resolved" });
    expect(single.sentence).toContain("[1]");

    const multi = numeric.find((c) => c.references.length === 2 && c.references.some((r) => r.label === "2"))!;
    expect(multi.references.map((r) => r.referenceId)).toEqual(["R002", "R003"]);

    const range = numeric.find((c) => c.references.length === 3)!;
    expect(range.references.map((r) => r.label)).toEqual(["4", "5", "6"]);
    expect(range.references.every((r) => r.status === "resolved")).toBe(true);

    const invalid = numeric.find((c) => c.references[0]?.label === "99")!;
    expect(invalid.references[0]?.status).toBe("invalid"); // 99 > 最大编号 6
    expect(invalid.references[0]?.referenceId).toBeUndefined();

    const gap = numeric.find((c) => c.references[0]?.label === "8")!;
    // 8 > 6 → invalid（超出范围）；范围内空缺见下一条用例
    expect(gap.references[0]?.status).toBe("invalid");

    // 同一文献多处被引：[1] 出现两次 → 两条 callout 均指向 R001
    const firstRefs = numeric.filter((c) =>
      c.references.some((r) => r.referenceId === "R001"),
    );
    expect(firstRefs.length).toBe(2);

    // author-year：Vaswani et al., 2017 → 唯一匹配 R005
    const authorYear = callouts.find((c) => c.style === "author-year")!;
    expect(authorYear.references[0]).toMatchObject({ referenceId: "R005", status: "resolved" });

    // provenance 完整
    for (const callout of callouts) {
      expect(callout.page).toBe(1);
      expect(callout.sectionId).toBe("SEC01");
      expect(callout.chunkId).toBe("C0001");
      expect(callout.sentence.length).toBeGreaterThan(0);
    }
  });

  it("编号范围内空缺 → unresolved（不猜）；author-year 未命中 → unresolved", () => {
    const document = syntheticDocument({
      referencesText: "[1] Alpha Author. First paper. 2019.\n\n[3] Gamma Author. Third paper. 2021.",
      bodyText: "The gap marker [2] cannot be resolved. An unknown citation (Nobodyfamous, 2020) exists.",
    });
    const { references, callouts } = new ReferenceExtractor().extract(document);
    expect(references).toHaveLength(2);
    const gap = callouts.find((c) => c.references[0]?.label === "2")!;
    expect(gap.references[0]?.status).toBe("unresolved");
    expect(gap.references[0]?.referenceId).toBeUndefined();
    const unknown = callouts.find((c) => c.style === "author-year")!;
    expect(unknown.references[0]?.status).toBe("unresolved");
  });

  it("expandNumericList：越界 range / 0 / 非数字 → 空（防御）", () => {
    expect(expandNumericList("2,3,5-7")).toEqual([2, 3, 5, 6, 7]);
    expect(expandNumericList("4-7")).toEqual([4, 5, 6, 7]);
    expect(expandNumericList("1-200")).toEqual([]);
    expect(expandNumericList("0")).toEqual([]);
    expect(expandNumericList("abc")).toEqual([]);
  });
});

// ---- 真实 arXiv PDF e2e ----

describe("M4.3.3 真实 PDF 提取（attention.pdf → service + HTTP）", () => {
  let stack: TestStack;
  let projectId: string;
  const FIXTURE_PDF = join(import.meta.dirname, "..", "fixtures", "pdf", "attention.pdf");

  beforeAll(async () => {
    stack = await startTestStack(scriptedIdeaRuntime().runtime);
    const created = await stack.request("POST", "/api/projects", { title: "引用提取 e2e" });
    projectId = (created.body["project"] as { id: string }).id;
    const pdfBuffer = await readFile(FIXTURE_PDF);
    const upload = await stack.request("POST", `/api/projects/${projectId}/paper/pdf`, {
      fileName: "attention.pdf",
      contentBase64: pdfBuffer.toString("base64"),
    });
    expect(upload.status).toBe(201);
  }, 120_000);

  afterAll(async () => {
    await stack.cleanup();
  });

  it("POST /citations/extract：references ≥13、callouts ≥35、关联可追踪、持久化可复用", { timeout: 120_000 }, async () => {
    const extract = await stack.request("POST", `/api/projects/${projectId}/citations/extract`, {});
    expect(extract.status).toBe(200);
    const references = extract.body["references"] as ReferenceEntry[];
    const callouts = extract.body["callouts"] as CitationCallout[];
    expect(references.length).toBeGreaterThanOrEqual(13);
    expect(callouts.length).toBeGreaterThanOrEqual(35);
    expect(extract.body["reused"]).toBe(false);

    // 关联可追踪：正文引用 → ReferenceEntry
    const referenceIds = new Set(references.map((r) => r.referenceId));
    expect(referenceIds.size).toBe(references.length);
    const resolved = callouts.flatMap((c) => c.references).filter((r) => r.status === "resolved");
    expect(resolved.length).toBeGreaterThan(30);
    expect(resolved.every((r) => referenceIds.has(r.referenceId!))).toBe(true);
    // 条目字段 best-effort：至少一半提取到 title 或 year
    const withFields = references.filter((r) => r.title !== undefined || r.year !== undefined);
    expect(withFields.length).toBeGreaterThanOrEqual(Math.floor(references.length / 2));

    // 摘要 + 指纹跳过（第二次 extract 不重算）
    const again = await stack.request("POST", `/api/projects/${projectId}/citations/extract`, {});
    expect(again.body["reused"]).toBe(true);

    // GET /citations 摘要
    const summaryResponse = await stack.request("GET", `/api/projects/${projectId}/citations`);
    expect(summaryResponse.status).toBe(200);
    const summary = summaryResponse.body["summary"] as Record<string, number>;
    expect(summary["references"]).toBe(references.length);
    expect(summary["callouts"]).toBe(callouts.length);
    expect(summary["resolvedRelations"]).toBe(resolved.length);
  });
});
