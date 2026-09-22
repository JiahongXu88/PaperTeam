import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SourcesPanel } from "../src/components/project/SourcesPanel.js";
import type {
  BatchFullTextResultView,
  BibTexImportResultView,
  FullTextResolveResultView,
  SourceImportResult,
  SourceItemView,
} from "../src/types/sources.js";
import { renderWithProviders } from "./helpers.js";

/**
 * M7.0 文献库 UI（M6.2 能力的前端消费）：
 * - 五种入库方式的模式切换与提交 payload（PDF 上传 / DOI / arXiv / URL / BibTeX）
 * - 列表渲染（标题 / 入库方式 / 状态 / 角色徽标）
 * - 幂等（created=false）与 resolver 解析结果的如实呈现
 *
 * M9.3 全文激活：
 * - 全文状态列（已获取 / 未获取 / 无开放全文 / 获取失败 / 不可自动获取）
 * - 单篇获取 / 勾选批量获取（summary 如实）/ 手动上传 PDF / 失败与幂等呈现
 */

vi.mock("../src/api/sources.js", () => ({
  listSources: vi.fn(),
  uploadSourceFile: vi.fn(),
  importSourceByDoi: vi.fn(),
  importSourceByArxiv: vi.fn(),
  importSourceByUrl: vi.fn(),
  importSourceBibtex: vi.fn(),
  resolveSourceFullText: vi.fn(),
  batchResolveSourceFullText: vi.fn(),
  attachSourceFullTextPdf: vi.fn(),
}));

const api = vi.mocked(await import("../src/api/sources.js"));

const NOW = "2026-09-18T08:00:00.000Z";

function sourceView(overrides: Partial<SourceItemView> = {}): SourceItemView {
  return {
    sourceId: "S001",
    fileName: "S001-survey.pdf",
    sourceRole: "both",
    origin: "USER_ADDED",
    status: "available",
    preferred: false,
    metadata: {
      title: "A Survey of Retrieval-Augmented Generation",
      authors: ["Gao, Yunfan"],
      year: 2023,
    },
    bytes: 1024,
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

async function renderPanel(sources: SourceItemView[] = []) {
  api.listSources.mockResolvedValue(sources);
  renderWithProviders(<SourcesPanel projectId="p-1" />, { route: "/projects/p-1?tab=sources" });
  await screen.findByText("文献列表");
  // 等列表查询 flush（加载态退出；空库走引导文案分支）
  await waitFor(() => expect(screen.queryByText("加载文献库…")).toBeNull());
}

describe("SourcesPanel（M7.0 文献库）", () => {
  it("空库 → 引导文案；五种添加方式入口齐全", async () => {
    await renderPanel([]);
    expect(await screen.findByText(/还没有文献/)).toBeTruthy();
    for (const label of ["PDF / 文件", "DOI", "arXiv", "URL", "BibTeX"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
  });

  it("列表渲染：标题 / 入库方式 / 状态 / 角色徽标", async () => {
    await renderPanel([
      sourceView(),
      sourceView({
        sourceId: "S002",
        origin: "DOI_IMPORT",
        status: "metadata_only",
        sourceRole: "evidence",
        metadata: { title: "Grounding via DOIs", doi: "10.1000/x" },
        bytes: 0,
      }),
    ]);
    expect(await screen.findByText("A Survey of Retrieval-Augmented Generation")).toBeTruthy();
    expect(screen.getByText("Grounding via DOIs")).toBeTruthy();
    expect(screen.getByText("手动上传")).toBeTruthy();
    expect(screen.getByText("DOI 导入")).toBeTruthy();
    expect(screen.getByText("已就绪")).toBeTruthy();
    expect(screen.getByText("仅元数据")).toBeTruthy();
    expect(screen.getAllByText("证据 + 参考")).toHaveLength(1);
    expect(screen.getByText("证据来源")).toBeTruthy();
    expect(await screen.findByText("2 条")).toBeTruthy();
  });

  it("DOI 导入：提交 payload 携带归一输入与默认角色（enrich 缺省开）", async () => {
    await renderPanel([]);
    const result: SourceImportResult = { source: sourceView({ origin: "DOI_IMPORT" }), created: true };
    api.importSourceByDoi.mockResolvedValue(result);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "DOI" }));
    await user.type(screen.getByLabelText("DOI"), " 10.1000/xyz.2024.001 ");
    await user.click(screen.getByRole("button", { name: "导入文献" }));

    await waitFor(() => expect(api.importSourceByDoi).toHaveBeenCalledTimes(1));
    expect(api.importSourceByDoi).toHaveBeenCalledWith("p-1", {
      doi: "10.1000/xyz.2024.001",
      sourceRole: "both",
    });
    expect(await screen.findByText("已导入文献库。")).toBeTruthy();
  });

  it("DOI 导入幂等：created=false → 已在库提示；resolver 未命中如实展示", async () => {
    await renderPanel([]);
    const result: SourceImportResult = {
      source: sourceView({ origin: "DOI_IMPORT", status: "metadata_only" }),
      created: false,
      resolve: { outcome: "not_found" },
    };
    api.importSourceByDoi.mockResolvedValue(result);
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "DOI" }));
    await user.type(screen.getByLabelText("DOI"), "10.1000/none");
    await user.click(screen.getByRole("button", { name: "导入文献" }));

    expect(await screen.findByText("文献库中已有同一文献（未重复创建）。")).toBeTruthy();
    expect(screen.getByText(/学术源未收录，仅按给定标识入库/)).toBeTruthy();
  });

  it("URL 导入：可选标题进入 payload；BibTeX 批量结果与逐条错误如实展示", async () => {
    await renderPanel([]);
    const urlResult: SourceImportResult = { source: sourceView({ origin: "URL_IMPORT" }), created: true };
    api.importSourceByUrl.mockResolvedValue(urlResult);
    const bibtexResult: BibTexImportResultView = {
      results: [
        { source: sourceView({ sourceId: "S010", origin: "BIBTEX_IMPORT" }), created: true, entryKey: "gao2023" },
        { source: sourceView({ sourceId: "S011" }), created: false, entryKey: "dup2020" },
      ],
      errors: [{ line: 12, message: "entry 缺少必需字段" }],
    };
    api.importSourceBibtex.mockResolvedValue(bibtexResult);
    const user = userEvent.setup();

    // URL：带可选标题
    await user.click(screen.getByRole("button", { name: "URL" }));
    await user.type(screen.getByLabelText("URL"), "https://example.org/paper");
    await user.type(screen.getByLabelText(/帮助同名页面识别/), "Example Paper Page");
    await user.click(screen.getByRole("button", { name: "导入文献" }));
    await waitFor(() => expect(api.importSourceByUrl).toHaveBeenCalledTimes(1));
    expect(api.importSourceByUrl).toHaveBeenCalledWith("p-1", {
      url: "https://example.org/paper",
      title: "Example Paper Page",
      sourceRole: "both",
    });

    // BibTeX：批量导入结果
    await user.click(screen.getByRole("button", { name: "BibTeX" }));
    const textarea = screen.getByLabelText("BibTeX 原文");
    fireEvent.change(textarea, { target: { value: "@article{gao2023, title={RAG}}" } });
    await user.click(screen.getByRole("button", { name: "导入 BibTeX" }));
    expect(await screen.findByText(/导入完成：2 条/)).toBeTruthy();
    expect(screen.getByText(/1 条已在库中，未重复创建/)).toBeTruthy();
    expect(screen.getByText(/1 条解析失败/)).toBeTruthy();
  });

  it("arXiv 导入：ID 提交到对应端点；空输入时提交按钮禁用不发请求", async () => {
    await renderPanel([]);
    api.importSourceByArxiv.mockResolvedValue({ source: sourceView({ origin: "ARXIV_IMPORT" }), created: true });
    const user = userEvent.setup();

    // 空输入：提交按钮禁用（拦截在按钮层）
    await user.click(screen.getByRole("button", { name: "arXiv" }));
    const submit = screen.getByRole("button", { name: "导入文献" });
    expect(submit.hasAttribute("disabled")).toBe(true);
    expect(api.importSourceByArxiv).not.toHaveBeenCalled();

    // 合法输入
    await user.type(screen.getByLabelText("arXiv ID"), "arXiv:2401.12345");
    await user.click(submit);
    await waitFor(() => expect(api.importSourceByArxiv).toHaveBeenCalledTimes(1));
    expect(api.importSourceByArxiv).toHaveBeenCalledWith("p-1", {
      arxivId: "arXiv:2401.12345",
      sourceRole: "both",
    });
  });
});

// ---- M9.3 全文激活 ----

function metaOnlyView(overrides: Partial<SourceItemView> = {}): SourceItemView {
  return sourceView({
    fileName: undefined,
    origin: "DOI_IMPORT",
    status: "metadata_only",
    bytes: 0,
    metadata: { title: "Metadata Only Paper", doi: "10.1000/mo" },
    ...overrides,
  });
}

describe("SourcesPanel 全文状态列（M9.3）", () => {
  it("有文件 → 全文已获取；resolved provenance 展示来源；无 fullText 字段的老数据 → 未获取", async () => {
    await renderPanel([
      sourceView(),
      metaOnlyView({
        sourceId: "S002",
        fileName: "S002-paper.pdf",
        fullText: {
          status: "resolved",
          resolver: "oa-url",
          url: "https://repo.example.org/paper.pdf",
          license: "cc-by",
          attempts: 1,
          attemptedAt: NOW,
          resolvedAt: NOW,
          bytes: 2048,
        },
      }),
      metaOnlyView({ sourceId: "S003" }),
    ]);
    expect(screen.getAllByText("全文已获取")).toHaveLength(2);
    expect(screen.getByText("全文未获取")).toBeTruthy();
    // provenance tooltip（title）如实带来源
    expect(screen.getByTitle(/全文来源：oa-url/).getAttribute("title")).toContain("cc-by");
  });

  it("not_found / failed / 不可自动获取（url-only Web 候选）如实映射", async () => {
    await renderPanel([
      metaOnlyView({
        sourceId: "S002",
        fullText: { status: "not_found", attempts: 1, attemptedAt: NOW },
      }),
      metaOnlyView({
        sourceId: "S003",
        fullText: { status: "failed", attempts: 2, attemptedAt: NOW, note: "unpaywall:error:timeout" },
      }),
      metaOnlyView({
        sourceId: "S004",
        origin: "URL_IMPORT",
        metadata: { title: "Web Result", url: "https://blog.example.org/post" },
      }),
    ]);
    expect(screen.getByText("无开放全文")).toBeTruthy();
    expect(screen.getByText("获取失败")).toBeTruthy();
    expect(screen.getByText("不可自动获取")).toBeTruthy();
  });

  it("metadata-only 行有获取/上传动作与勾选；已有全文的行没有", async () => {
    await renderPanel([sourceView(), metaOnlyView({ sourceId: "S002" })]);
    expect(screen.getByTestId("resolve-fulltext-S002")).toBeTruthy();
    expect(screen.getByLabelText("为 Metadata Only Paper 上传 PDF 全文")).toBeTruthy();
    expect(screen.getByLabelText("选择 Metadata Only Paper")).toBeTruthy();
    expect(screen.queryByTestId("resolve-fulltext-S001")).toBeNull();
  });
});

describe("SourcesPanel 单篇获取全文（M9.3）", () => {
  it("点击获取全文 → 调用单篇端点；成功结局如实呈现", async () => {
    await renderPanel([metaOnlyView({ sourceId: "S002" })]);
    const result: FullTextResolveResultView = {
      source: metaOnlyView({ sourceId: "S002", fileName: "S002-paper.pdf" }),
      outcome: "resolved",
    };
    api.resolveSourceFullText.mockResolvedValue(result);
    const user = userEvent.setup();
    await user.click(screen.getByTestId("resolve-fulltext-S002"));
    await waitFor(() => expect(api.resolveSourceFullText).toHaveBeenCalledWith("p-1", "S002"));
    expect(await screen.findByText(/S002：已获取全文/)).toBeTruthy();
  });

  it("幂等结局（skipped_has_file）与失败（422）如实呈现，不粉饰", async () => {
    await renderPanel([metaOnlyView({ sourceId: "S002" })]);
    api.resolveSourceFullText.mockResolvedValue({
      source: metaOnlyView({ sourceId: "S002" }),
      outcome: "skipped_has_file",
    });
    const user = userEvent.setup();
    await user.click(screen.getByTestId("resolve-fulltext-S002"));
    expect(await screen.findByText(/S002：已有全文（跳过）/)).toBeTruthy();

    api.resolveSourceFullText.mockRejectedValue(new Error("不可自动解析（无 DOI / arXiv）"));
    await user.click(screen.getByTestId("resolve-fulltext-S002"));
    expect(await screen.findByText(/全文获取失败（S002）/)).toBeTruthy();
  });

  it("url-only 条目的获取按钮禁用（提示手动上传）", async () => {
    await renderPanel([
      metaOnlyView({
        sourceId: "S002",
        origin: "URL_IMPORT",
        metadata: { title: "Web Result", url: "https://blog.example.org/post" },
      }),
    ]);
    const button = screen.getByTestId("resolve-fulltext-S002");
    expect(button.hasAttribute("disabled")).toBe(true);
    expect(button.getAttribute("title")).toContain("无法自动获取");
  });
});

describe("SourcesPanel 批量获取全文（M9.3）", () => {
  it("勾选多条 → 批量端点携带 id；混合 summary 如实呈现（失败明细折叠）", async () => {
    await renderPanel([
      sourceView(),
      metaOnlyView({ sourceId: "S002" }),
      metaOnlyView({ sourceId: "S003", origin: "ARXIV_IMPORT", metadata: { title: "Preprint", arxivId: "2401.00001" } }),
    ]);
    const user = userEvent.setup();
    // 未勾选时禁用
    const batchButton = screen.getByTestId("batch-resolve-fulltext");
    expect(batchButton.hasAttribute("disabled")).toBe(true);
    await user.click(screen.getByLabelText("选择 Metadata Only Paper"));
    await user.click(screen.getByLabelText("选择 Preprint"));
    await user.click(batchButton);
    await waitFor(() =>
      expect(api.batchResolveSourceFullText).toHaveBeenCalledWith("p-1", ["S002", "S003"]),
    );
    const mixed: BatchFullTextResultView = {
      summary: { total: 2, resolved: 1, notFound: 1, failed: 0, notResolvable: 0, skipped: 0 },
      results: [
        { sourceId: "S002", outcome: "resolved" },
        { sourceId: "S003", outcome: "not_found", note: "unpaywall:not_found" },
      ],
    };
    api.batchResolveSourceFullText.mockResolvedValue(mixed);
    // 重新走一次带 mock 结果的批次
    await user.click(screen.getByLabelText("选择 Metadata Only Paper"));
    await user.click(screen.getByLabelText("选择 Preprint"));
    await user.click(screen.getByTestId("batch-resolve-fulltext"));
    expect(await screen.findByText(/批量获取完成：共 2 ｜ 已获取 1 ｜ 无开放全文 1/)).toBeTruthy();
  });

  it("批量失败 → 错误如实呈现", async () => {
    await renderPanel([metaOnlyView({ sourceId: "S002" })]);
    api.batchResolveSourceFullText.mockRejectedValue(new Error("sourceIds 含非法条目"));
    const user = userEvent.setup();
    await user.click(screen.getByLabelText("选择 Metadata Only Paper"));
    await user.click(screen.getByTestId("batch-resolve-fulltext"));
    expect(await screen.findByText("批量获取失败")).toBeTruthy();
    expect(screen.getByText(/sourceIds 含非法条目/)).toBeTruthy();
  });
});

describe("SourcesPanel 手动上传 PDF（M9.3）", () => {
  it("选择 PDF → 补挂端点携带文件；成功后提示挂载", async () => {
    await renderPanel([metaOnlyView({ sourceId: "S002" })]);
    api.attachSourceFullTextPdf.mockResolvedValue({
      source: metaOnlyView({ sourceId: "S002", fileName: "S002-paper.pdf" }),
      outcome: "resolved",
    });
    const file = new File(["%PDF-1.4 fake bytes"], "author-copy.pdf", { type: "application/pdf" });
    fireEvent.change(screen.getByLabelText("为 Metadata Only Paper 上传 PDF 全文"), {
      target: { files: [file] },
    });
    await waitFor(() => expect(api.attachSourceFullTextPdf).toHaveBeenCalledTimes(1));
    const [projectId, sourceId, payload] = api.attachSourceFullTextPdf.mock.calls[0]!;
    expect(projectId).toBe("p-1");
    expect(sourceId).toBe("S002");
    expect(payload.fileName).toBe("author-copy.pdf");
    expect(typeof payload.contentBase64).toBe("string");
    expect(payload.contentBase64.length).toBeGreaterThan(0);
    expect(await screen.findByText(/S002：已挂载手动上传的 PDF 全文/)).toBeTruthy();
  });

  it("非 PDF / 超限 / 后端拒绝（非 PDF 魔数）→ 错误呈现不发请求或如实透传", async () => {
    await renderPanel([metaOnlyView({ sourceId: "S002" })]);
    // 本地拦截：非 .pdf
    fireEvent.change(screen.getByLabelText("为 Metadata Only Paper 上传 PDF 全文"), {
      target: { files: [new File(["x"], "paper.txt", { type: "text/plain" })] },
    });
    expect(await screen.findByText("手动补挂只接受 .pdf 文件")).toBeTruthy();
    expect(api.attachSourceFullTextPdf).not.toHaveBeenCalled();
    // 后端拒绝（魔数不符）：错误如实透传
    api.attachSourceFullTextPdf.mockRejectedValue(new Error("上传内容不是 PDF（缺少 %PDF- 头）"));
    fireEvent.change(screen.getByLabelText("为 Metadata Only Paper 上传 PDF 全文"), {
      target: { files: [new File(["%PDF-not-really"], "fake.pdf", { type: "application/pdf" })] },
    });
    expect(await screen.findByText(/上传失败（S002）/)).toBeTruthy();
  });
});
