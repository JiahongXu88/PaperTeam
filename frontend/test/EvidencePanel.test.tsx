import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { EvidencePanel } from "../src/components/project/EvidencePanel.js";
import type { EvidenceRecordView } from "../src/types/api.js";
import { renderWithProviders } from "./helpers.js";

/**
 * 证据工作台（M4.6）：
 * - 空态（真实业务入口，不伪造 0/0 统计）
 * - 列表 + 概况统计（来自同一份列表数据派生）
 * - 筛选（状态 / 章节 / 来源）与搜索（论断 / 摘要 / 引文 / 标题 / DOI）
 * - 详情展开：provenance（来源文献 / 页码章节 / 核验方式 / 使用记录）
 * - 人工确认核验（user_confirmed）→ 列表失效重取
 */

vi.mock("../src/api/evidence.js", () => ({
  listEvidence: vi.fn(),
  getEvidence: vi.fn(),
  confirmEvidenceVerified: vi.fn(),
  getQualityGate: vi.fn(),
  reevaluateQualityGate: vi.fn(),
}));

import { confirmEvidenceVerified, listEvidence } from "../src/api/evidence.js";

const evidenceApi = { listEvidence: vi.mocked(listEvidence), confirm: vi.mocked(confirmEvidenceVerified) };

function record(overrides: Partial<EvidenceRecordView> = {}): EvidenceRecordView {
  return {
    id: "E001",
    claim: "RAG 能显著降低开放域问答的幻觉率",
    summary: "综述汇总了多项实验：引入检索后事实错误率平均下降。",
    quote: "RAG reduces factual error rates by an average of 43% across benchmarks.",
    source: {
      sourceId: "S001",
      title: "A Survey of Retrieval-Augmented Generation",
      authors: ["Gao, Y."],
      year: 2023,
      doi: "10.48550/arXiv.2312.10997",
    },
    location: { page: 7, section: "5" },
    verificationStatus: "verified",
    verificationLevel: "abstract",
    verificationMethod: "crossref",
    supportStrength: "direct",
    relatedSections: ["introduction"],
    usedBy: ["run:w-run00001"],
    createdBy: "researcher",
    createdAt: "2026-09-08T10:00:00.000Z",
    ...overrides,
  };
}

const RECORDS: EvidenceRecordView[] = [
  record(),
  record({
    id: "E002",
    claim: "重排策略在小语料场景下最稳健",
    verificationStatus: "unverified",
    source: { sourceId: "S002", title: "Rerankers for Small Corpora", authors: ["Lee, K."], year: 2025 },
    location: { page: 3, section: "4.1" },
    relatedSections: ["method"],
    usedBy: [],
    supportStrength: undefined,
    verificationLevel: undefined,
    verificationMethod: undefined,
  }),
  record({
    id: "E003",
    claim: "准确率提升 12.4%",
    verificationStatus: "mismatch",
    supportStrength: "contradictory",
    source: { sourceId: "S001", title: "A Survey of Retrieval-Augmented Generation" },
    location: undefined,
    relatedSections: ["experiments"],
    usedBy: [],
  }),
  record({
    id: "E004",
    claim: "全文无法获取的证据只做元数据级判断",
    verificationStatus: "unverifiable",
    source: undefined,
    location: { page: 12 },
    relatedSections: [],
    usedBy: [],
  }),
];

const openWorkflow = vi.fn();

function renderPanel(initialAttention = false) {
  return renderWithProviders(
    <EvidencePanel projectId="p-evidence01" workflowKind="idea_to_paper" onOpenTab={openWorkflow} initialAttention={initialAttention} />,
  );
}

beforeEach(() => {
  vi.mocked(evidenceApi.listEvidence).mockReset();
  evidenceApi.confirm.mockReset();
  openWorkflow.mockClear();
});

describe("证据工作台", () => {
  it("空态：真实业务说明 + 前往工作流入口，不显示 0/0 统计", async () => {
    evidenceApi.listEvidence.mockResolvedValue([]);
    renderPanel();

    expect(await screen.findByTestId("evidence-empty")).toBeVisible();
    expect(screen.getByText(/证据在「从想法到论文」的调研阶段自动收集/)).toBeVisible();
    expect(screen.queryByText("证据总数 0")).not.toBeInTheDocument();

    await userEvent.click(screen.getByTestId("evidence-goto-workflow"));
    expect(openWorkflow).toHaveBeenCalledWith("workflow");
  });

  it("列表 + 概况统计（一次列表数据派生，含已核验 / 待核验 / 需注意 / 被使用 / 来源数）", async () => {
    evidenceApi.listEvidence.mockResolvedValue(RECORDS);
    renderPanel();

    expect(await screen.findByTestId("evidence-list")).toBeVisible();
    expect(screen.getByText("证据总数 4")).toBeVisible();
    expect(screen.getAllByText("已核验 1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("待核验 1").length).toBeGreaterThan(0);
    expect(screen.getAllByText("需注意 2").length).toBeGreaterThan(0);
    expect(screen.getByText("被正文使用 1")).toBeVisible();
    expect(screen.getByText("来源 3")).toBeVisible();
    // 中文状态标签（Domain 枚举不外露）
    expect(screen.getAllByText("已核验").length).toBeGreaterThan(0);
    expect(screen.getByText("待核验")).toBeVisible();
    expect(screen.getByText("与来源不符")).toBeVisible();
    expect(screen.getByText("无法核验")).toBeVisible();
    // 支撑强度 chip
    expect(screen.getAllByText("直接支撑").length).toBeGreaterThan(0);
    expect(screen.getByText("与论断矛盾")).toBeVisible();
  });

  it("搜索：命中 claim / DOI；无结果时给出筛选提示", async () => {
    evidenceApi.listEvidence.mockResolvedValue(RECORDS);
    renderPanel();
    await screen.findByTestId("evidence-list");

    const user = userEvent.setup();
    await user.type(screen.getByTestId("evidence-search"), "幻觉率");
    expect(screen.getByTestId("evidence-list").querySelectorAll(".evidence-row")).toHaveLength(1);
    expect(screen.getByText("E001")).toBeVisible();

    await user.clear(screen.getByTestId("evidence-search"));
    await user.type(screen.getByTestId("evidence-search"), "10.9999/nonexistent");
    expect(await screen.findByTestId("evidence-no-match")).toBeVisible();
  });

  it("状态筛选：需注意（mismatch / not_found / unverifiable / 矛盾）与 initialAttention 深链", async () => {
    evidenceApi.listEvidence.mockResolvedValue(RECORDS);
    const { unmount } = renderPanel(true);
    // 门禁 blocker 深链（?attention=1）：初始即筛「需注意」
    expect(await screen.findByTestId("evidence-list")).toBeVisible();
    expect(screen.getByTestId("evidence-list").querySelectorAll(".evidence-row")).toHaveLength(2);
    expect(screen.getByText("E003")).toBeVisible();
    expect(screen.getByText("E004")).toBeVisible();
    unmount();

    evidenceApi.listEvidence.mockResolvedValue(RECORDS);
    renderPanel();
    await screen.findByTestId("evidence-list");
    const user = userEvent.setup();
    await user.click(screen.getByTestId("evidence-filter-unverified"));
    expect(screen.getByTestId("evidence-list").querySelectorAll(".evidence-row")).toHaveLength(1);
    expect(screen.getByText("E002")).toBeVisible();
  });

  it("章节与来源筛选", async () => {
    evidenceApi.listEvidence.mockResolvedValue(RECORDS);
    renderPanel();
    await screen.findByTestId("evidence-list");

    const user = userEvent.setup();
    await user.selectOptions(screen.getByLabelText("按章节筛选"), "method");
    expect(screen.getByTestId("evidence-list").querySelectorAll(".evidence-row")).toHaveLength(1);
    expect(screen.getByText("E002")).toBeVisible();

    await user.selectOptions(screen.getByLabelText("按章节筛选"), "all");
    await user.selectOptions(screen.getByLabelText("按来源筛选"), "S002");
    expect(screen.getByTestId("evidence-list").querySelectorAll(".evidence-row")).toHaveLength(1);
  });

  it("详情展开：provenance（文献 / DOI / 页码章节 / 核验方式 / 使用记录）与完整引文", async () => {
    evidenceApi.listEvidence.mockResolvedValue(RECORDS);
    renderPanel();
    await screen.findByTestId("evidence-list");

    const user = userEvent.setup();
    await user.click(screen.getAllByTestId("evidence-toggle-detail")[0]!);

    const detail = screen.getByTestId("evidence-detail");
    expect(detail).toHaveTextContent("A Survey of Retrieval-Augmented Generation");
    expect(detail).toHaveTextContent("10.48550/arXiv.2312.10997");
    expect(detail).toHaveTextContent("第 7 页");
    expect(detail).toHaveTextContent("章节5");
    expect(detail).toHaveTextContent("摘要级（crossref）");
    expect(detail).toHaveTextContent("run:w-run00001");
    expect(detail).toHaveTextContent("调研（Researcher）");
  });

  it("人工确认核验：调用 verify → 列表失效重取，状态变为已核验", async () => {
    let current = RECORDS;
    evidenceApi.listEvidence.mockImplementation(async () => current);
    evidenceApi.confirm.mockImplementation(async (_projectId, id) => {
      current = current.map((entry) =>
        entry.id === id
          ? { ...entry, verificationStatus: "verified" as const, verificationLevel: "user_confirmed" as const, updatedAt: "2026-09-10T10:00:00.000Z" }
          : entry,
      );
      return current.find((entry) => entry.id === id)!;
    });
    renderPanel();
    await screen.findByText("E002");

    const user = userEvent.setup();
    await user.click(screen.getByTestId("evidence-confirm-E002"));

    await waitFor(() => expect(evidenceApi.confirm).toHaveBeenCalledWith("p-evidence01", "E002"));
    // 重取后 E002 已核验（待核验计数归零）
    await waitFor(() => expect(screen.getAllByText("待核验 0").length).toBeGreaterThan(0));
  });
});
