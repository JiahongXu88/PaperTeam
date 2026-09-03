/**
 * Citation 测试（M3.1）：
 * 静态核验（cite ↔ bib）、metadata providers（CrossRef/OpenAlex/arXiv 的
 * timeout / 网络故障 / not_found / verified 分支）、CitationService 端到端。
 */

import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { afterAll, describe, expect, it } from "vitest";

import {
  checkCitations,
  extractCitationKeys,
  parseBib,
} from "../../src/citation/StaticCitationChecker.js";
import {
  ArxivProvider,
  CrossRefProvider,
  OpenAlexProvider,
  titlesMatch,
  type MetadataProviderContext,
} from "../../src/citation/metadataProviders.js";
import { CitationService } from "../../src/citation/CitationService.js";
import { ProjectStore } from "../../src/project/ProjectStore.js";

const tempRoots: string[] = [];
afterAll(async () => {
  await Promise.all(tempRoots.map((root) => rm(root, { recursive: true, force: true })));
});

const BIB = [
  "@article{gao2023survey,",
  "  title = {Retrieval-Augmented Generation: A Survey},",
  "  author = {Gao, Yunfan and Xiong, Yun},",
  "  year = {2023},",
  "  doi = {10.48550/arXiv.2312.10997}",
  "}",
  "",
  "@inproceedings{lewis2020rag,",
  "  title = {Retrieval-Augmented Generation for Knowledge-Intensive NLP Tasks},",
  "  year = {2020}",
  "}",
  "",
  "@article{gao2023survey,",
  "  title = {Duplicate Entry},",
  "  year = {2024}",
  "}",
].join("\n");

describe("parseBib", () => {
  it("解析条目 / 字段 / 重复 key", () => {
    const result = parseBib(BIB);
    expect(result.entries.map((entry) => entry.key)).toEqual(["gao2023survey", "lewis2020rag"]);
    expect(result.duplicateKeys).toEqual(["gao2023survey"]);
    expect(result.entries[0]).toMatchObject({
      type: "article",
      title: "Retrieval-Augmented Generation: A Survey",
      year: 2023,
      doi: "10.48550/arXiv.2312.10997",
    });
  });
});

describe("extractCitationKeys", () => {
  it("提取 \\cite 族（含多 key、可选参数、natbib/biblatex 变体）", () => {
    const tex = [
      "\\cite{gao2023survey}",
      "\\citep[see][p.~3]{lewis2020rag,gao2023survey}",
      "\\textcite{lewis2020rag}",
      "\\nocite{*}",
    ].join("\n");
    const { keys, bad } = extractCitationKeys("main.tex", tex);
    expect(keys.sort()).toEqual(["*", "gao2023survey", "lewis2020rag"]);
    expect(bad).toHaveLength(0);
  });

  it("坏引用（空 key、可疑字符）被标记", () => {
    const { bad } = extractCitationKeys("s.tex", "前文\\cite{}后文\n\\cite{a;b|c}");
    expect(bad.length).toBeGreaterThanOrEqual(2);
  });
});

describe("checkCitations（静态层）", () => {
  it("missing / unused / duplicate / bad 分类正确", () => {
    const result = checkCitations(
      [
        {
          file: "sections/introduction.tex",
          content: "如 \\cite{gao2023survey} 所示，另一处 \\cite{missing2024key}。",
        },
        { file: "main.tex", content: "\\input{sections/introduction.tex}" },
      ],
      BIB,
    );
    expect(result.missingKeys).toEqual(["missing2024key"]);
    expect(result.unusedKeys).toEqual(["lewis2020rag"]); // 该测试正文未引用 lewis
    expect(result.duplicateKeys).toEqual(["gao2023survey"]);
    expect(result.citedKeys.sort()).toEqual(["gao2023survey", "missing2024key"]);
  });

  it("未被引用的 bib 条目进入 unusedKeys（警告级）", () => {
    const result = checkCitations([{ file: "main.tex", content: "无引用正文" }], BIB);
    expect(result.unusedKeys.sort()).toEqual(["gao2023survey", "lewis2020rag"]);
    expect(result.missingKeys).toEqual([]);
  });

  it("bib 为 null：全部引用 key 均为 missing", () => {
    const result = checkCitations([{ file: "main.tex", content: "\\cite{a2024x}" }], null);
    expect(result.missingKeys).toEqual(["a2024x"]);
  });
});

// ---- metadata providers（注入 fetch，不依赖真实网络） ----

function makeCtx(fetchImpl: typeof fetch, timeoutMs = 500): MetadataProviderContext {
  return { fetchImpl, timeoutMs };
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("CrossRefProvider", () => {
  const provider = new CrossRefProvider();
  const entry = {
    key: "gao2023survey",
    type: "article",
    title: "Retrieval-Augmented Generation: A Survey",
    year: 2023,
    doi: "10.48550/arXiv.2312.10997",
  };

  it("DOI 查询且标题匹配 → verified", async () => {
    const ctx = makeCtx(async (url) =>
      jsonResponse({
        status: "ok",
        message: { title: "Retrieval-Augmented Generation: A Survey" },
      }),
    );
    const result = await provider.verify(entry, ctx);
    expect(result.status).toBe("verified");
    expect(result.matched?.title).toContain("Retrieval-Augmented");
  });

  it("标题不匹配 → mismatch（可判定，不是网络错误）", async () => {
    const ctx = makeCtx(async () =>
      jsonResponse({ status: "ok", message: { title: "A Completely Different Paper" } }),
    );
    const result = await provider.verify(entry, ctx);
    expect(result.status).toBe("mismatch");
  });

  it("404 → not_found；网络故障 / 5xx / 超时 → unverifiable（绝不因网络判 not_found）", async () => {
    const notFound = await provider.verify(entry, makeCtx(async () => new Response("{}", { status: 404 })));
    expect(notFound.status).toBe("not_found");

    const serverError = await provider.verify(entry, makeCtx(async () => new Response("{}", { status: 503 })));
    expect(serverError.status).toBe("unverifiable");

    const networkError = await provider.verify(
      entry,
      makeCtx(async () => {
        throw new TypeError("fetch failed: ECONNREFUSED");
      }),
    );
    expect(networkError.status).toBe("unverifiable");

    const timeout = await provider.verify(
      entry,
      makeCtx(
        (_url, init) =>
          new Promise((_resolve, reject) => {
            init?.signal?.addEventListener("abort", () => reject(new Error("aborted")));
          }) as unknown as Promise<Response>,
        50,
      ),
    );
    expect(timeout.status).toBe("unverifiable");
  });

  it("标题检索（无 DOI）：候选列表第一条匹配 → verified；空结果 → not_found", async () => {
    const noDoi = { key: "k", type: "article", title: "Retrieval-Augmented Generation: A Survey" };
    const hit = await provider.verify(
      noDoi,
      makeCtx(async () =>
        jsonResponse({ message: { items: [{ title: "Retrieval-augmented generation: a survey" }] } }),
      ),
    );
    expect(hit.status).toBe("verified");
    const empty = await provider.verify(
      noDoi,
      makeCtx(async () => jsonResponse({ message: { items: [] } })),
    );
    expect(empty.status).toBe("not_found");
  });
});

describe("OpenAlexProvider", () => {
  const provider = new OpenAlexProvider();

  it("DOI 命中且标题匹配 → verified；无结果 → not_found；故障 → unverifiable", async () => {
    const entry = { key: "k", type: "article", title: "Some Paper", doi: "10.1/x" };
    const hit = await provider.verify(
      entry,
      makeCtx(async () => jsonResponse({ id: "https://openalex.org/W1", title: "Some Paper" })),
    );
    expect(hit.status).toBe("verified");

    const search = await provider.verify(
      { key: "k2", type: "article", title: "Query Paper" },
      makeCtx(async () => jsonResponse({ results: [{ title: "Query paper" }] })),
    );
    expect(search.status).toBe("verified");

    const empty = await provider.verify(
      { key: "k3", type: "article", title: "Nothing" },
      makeCtx(async () => jsonResponse({ results: [] })),
    );
    expect(empty.status).toBe("not_found");

    const fail = await provider.verify(
      entry,
      makeCtx(async () => {
        throw new TypeError("fetch failed");
      }),
    );
    expect(fail.status).toBe("unverifiable");
  });
});

describe("ArxivProvider", () => {
  const provider = new ArxivProvider();

  it("Atom XML 标题匹配 → verified；无 entry → not_found", async () => {
    const entry = { key: "k", type: "article", title: "Attention Is All You Need" };
    const hit = await provider.verify(
      entry,
      makeCtx(async () =>
        new Response(
          "<feed><entry><title>Attention Is All You Need</title></entry></feed>",
          { status: 200 },
        ),
      ),
    );
    expect(hit.status).toBe("verified");

    const miss = await provider.verify(
      entry,
      makeCtx(async () => new Response("<feed></feed>", { status: 200 })),
    );
    expect(miss.status).toBe("not_found");
  });
});

describe("titlesMatch", () => {
  it("大小写 / 标点 / 冠词归一化后匹配", () => {
    expect(titlesMatch("Attention Is All You Need", "attention is all you need")).toBe(true);
    expect(titlesMatch("A Survey of RAG", "Survey of RAG")).toBe(true);
    expect(titlesMatch("Paper A", "Paper B")).toBe(false);
  });
});

// ---- CitationService 端到端（真实临时项目 + 注入 fetch） ----

describe("CitationService", () => {
  async function prepareProject(): Promise<{ store: ProjectStore; projectId: string }> {
    const root = await mkdtemp(join(tmpdir(), "paperteam-cit-"));
    tempRoots.push(root);
    const store = new ProjectStore({ root });
    const project = await store.create("引用测试");
    const manuscriptDir = store.manuscriptDir(project.id);
    await mkdir(join(manuscriptDir, "sections"), { recursive: true });
    await writeFile(
      join(manuscriptDir, "main.tex"),
      [
        "\\documentclass{ctexart}",
        "\\begin{document}",
        "\\input{sections/introduction}",
        "\\bibliographystyle{unsrt}",
        "\\bibliography{references}",
        "\\end{document}",
      ].join("\n"),
      "utf8",
    );
    await writeFile(
      join(manuscriptDir, "sections", "introduction.tex"),
      "如 \\cite{good2020, fake2024x} 所示。",
      "utf8",
    );
    await writeFile(
      join(manuscriptDir, "references.bib"),
      [
        "@article{good2020,",
        "  title = {Good Paper Title},",
        "  year = {2020},",
        "  doi = {10.1/good}",
        "}",
        "@article{unused2019,",
        "  title = {Unused Paper},",
        "  year = {2019}",
        "}",
      ].join("\n"),
      "utf8",
    );
    return { store, projectId: project.id };
  }

  it("静态层 + metadata 层：报告落盘且汇总正确", async () => {
    const { store, projectId } = await prepareProject();
    const service = new CitationService({
      projects: store,
      metadataEnabled: true,
      maxMetadataLookups: 10,
      metadataTimeoutMs: 500,
      fetchImpl: async (url) => {
        const urlText = String(url);
        if (urlText.includes("10.1/good")) {
          return jsonResponse({ status: "ok", message: { title: "Good Paper Title" } });
        }
        return new Response("{}", { status: 404 });
      },
      log: () => {},
    });
    const report = await service.verify(projectId);

    expect(report.static.missingKeys).toEqual(["fake2024x"]);
    expect(report.static.unusedKeys).toEqual(["unused2019"]);
    expect(report.metadata.checked).toBe(1); // 只核验被引用且存在的 good2020
    expect(report.metadata.byStatus.verified).toBe(1);
    expect(report.summary.hallucinated).toBe(0);
    expect(report.summary.missingKeys).toBe(1);
    // 报告落盘
    expect(await service.latestReport(projectId)).not.toBeNull();
  });

  it("metadata 关闭 / 网络全部故障：静态层仍工作，全部 unverifiable（不误判 not_found）", async () => {
    const { store, projectId } = await prepareProject();
    const service = new CitationService({
      projects: store,
      metadataEnabled: true,
      maxMetadataLookups: 10,
      metadataTimeoutMs: 200,
      fetchImpl: async () => {
        throw new TypeError("fetch failed: offline");
      },
      log: () => {},
    });
    const report = await service.verify(projectId);
    expect(report.summary.hallucinated).toBe(0); // 网络故障 ≠ not_found
    expect(report.summary.unverifiable).toBe(1);

    const disabled = new CitationService({ projects: store, metadataEnabled: false, log: () => {} });
    const report2 = await disabled.verify(projectId);
    expect(report2.metadata.enabled).toBe(false);
    expect(report2.metadata.checked).toBe(0);
    expect(report2.static.missingKeys).toEqual(["fake2024x"]);
  });
});
