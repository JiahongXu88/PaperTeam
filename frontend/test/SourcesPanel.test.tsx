import { afterEach, describe, expect, it, vi } from "vitest";
import { fireEvent, screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { SourcesPanel } from "../src/components/project/SourcesPanel.js";
import type { BibTexImportResultView, SourceImportResult, SourceItemView } from "../src/types/sources.js";
import { renderWithProviders } from "./helpers.js";

/**
 * M7.0 文献库 UI（M6.2 能力的前端消费）：
 * - 五种入库方式的模式切换与提交 payload（PDF 上传 / DOI / arXiv / URL / BibTeX）
 * - 列表渲染（标题 / 入库方式 / 状态 / 角色徽标）
 * - 幂等（created=false）与 resolver 解析结果的如实呈现
 */

vi.mock("../src/api/sources.js", () => ({
  listSources: vi.fn(),
  uploadSourceFile: vi.fn(),
  importSourceByDoi: vi.fn(),
  importSourceByArxiv: vi.fn(),
  importSourceByUrl: vi.fn(),
  importSourceBibtex: vi.fn(),
}));

const api = vi.mocked(await import("../src/api/sources.js"));

const NOW = "2026-09-18T08:00:00.000Z";

function sourceView(overrides: Partial<SourceItemView> = {}): SourceItemView {
  return {
    sourceId: "S001",
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
    await user.click(screen.getByRole("button", { name: "导入文献" }));
    await waitFor(() => expect(api.importSourceByArxiv).toHaveBeenCalledTimes(1));
    expect(api.importSourceByArxiv).toHaveBeenCalledWith("p-1", {
      arxivId: "arXiv:2401.12345",
      sourceRole: "both",
    });
  });
});
