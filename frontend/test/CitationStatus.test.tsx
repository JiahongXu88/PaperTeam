import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";

import { CitationsPanel } from "../src/components/project/CitationsPanel.js";
import { METADATA_STATUS_STYLES, statusStyleOf } from "../src/components/common/status.js";
import type { IntegrityReportView, MetadataRecordView, MetadataStatus } from "../src/types/paper.js";
import { renderWithProviders } from "./helpers.js";

/**
 * 引用核验状态展示：前端只消费后端 status，不对任何文献做特判。
 * provider 网络失败（UNRESOLVED）不能显示成"未找到"；断词标记（U+00AD）不进展示文本。
 */

vi.mock("../src/api/paper.js", () => ({
  getPaper: vi.fn(),
  uploadPaperPdf: vi.fn(),
  listCitations: vi.fn(),
  extractCitations: vi.fn(),
  verifyMetadata: vi.fn(),
  verifyClaims: vi.fn(),
  getCitationIntegrity: vi.fn(),
  getMetadataRecords: vi.fn(),
}));

const { listCitations, getCitationIntegrity, getMetadataRecords } = await import("../src/api/paper.js");

const SOFT_HYPHEN = "\u00AD";

function report(byStatus: Partial<Record<MetadataStatus, number>>): IntegrityReportView {
  return {
    metadataByStatus: { VERIFIED: 0, METADATA_MISMATCH: 0, AMBIGUOUS: 0, NOT_FOUND: 0, UNRESOLVED: 0, ...byStatus },
    probableFabrications: [],
    semantic: {
      total: 0,
      byVerdict: { SUPPORTED: 0, PARTIALLY_SUPPORTED: 0, UNSUPPORTED: 0, CONTRADICTED: 0, INSUFFICIENT_EVIDENCE: 0, SKIPPED: 0 },
      gate: { probableFabricated: 0, notFoundObligatory: 0, unsupportedCritical: 0, mismatchCritical: 0, insufficientEvidence: 0 },
    },
  };
}

const REFERENCES = [
  {
    referenceId: "R005",
    number: 5,
    rawText: `[5] Y. Zhang et al., “Byte${SOFT_HYPHEN}track: Multi-object tracking by associating every detection box,” ECCV, 2022.`,
    title: `Byte${SOFT_HYPHEN}track: Multi-object tracking by associating every detection box`,
    authors: ["Y. Zhang", "P. Sun"],
    year: 2022,
    page: 24,
  },
  {
    referenceId: "R006",
    number: 6,
    rawText: "[6] J. Cao et al., “Observation-centric sort…”",
    title: "Observation-centric sort: Rethinking sort for robust multi-object tracking",
    authors: ["J. Cao"],
    year: 2019,
    page: 24,
  },
  {
    referenceId: "R020",
    number: 20,
    rawText: "[20] N. Wojke et al., “Simple online and realtime tracking with a deep association metric,” ICIP, 2017.",
    title: "Simple online and realtime tracking with a deep association metric",
    authors: ["N. Wojke"],
    year: 2017,
    page: 25,
  },
  {
    referenceId: "R099",
    number: 99,
    rawText: "[99] Ghost paper",
    title: "Quantum frobnication in imaginary manifolds",
    year: 2027,
    page: 25,
  },
];

const RECORDS: MetadataRecordView[] = [
  {
    referenceId: "R005",
    status: "VERIFIED",
    probableFabrication: false,
    canonical: {
      provider: "crossref",
      recordId: "10.1007/978-3-031-20047-2_1",
      title: "ByteTrack: Multi-object Tracking by Associating Every Detection Box",
      authors: ["Yifu Zhang", "Peize Sun", "Yi Jiang", "Dongdong Yu"],
      year: 2022,
      doi: "10.1007/978-3-031-20047-2_1",
    },
    attempts: [{ provider: "crossref", outcome: "match", note: "查询：title#1:Bytetrack…" }],
    checkedAt: "2026-09-07T10:00:00.000Z",
  },
  {
    referenceId: "R006",
    status: "METADATA_MISMATCH",
    probableFabrication: false,
    canonical: { provider: "openalex", recordId: "W1", title: "Observation-Centric SORT: Rethinking SORT for Robust Multi-Object Tracking", year: 2023, doi: "10.1109/cvpr52729.2023.00934" },
    mismatches: [{ field: "year", expected: "2019", actual: "2023" }],
    attempts: [
      { provider: "crossref", outcome: "error", note: "crossref 查询失败：timeout(8000ms)" },
      { provider: "openalex", outcome: "mismatch" },
    ],
    checkedAt: "2026-09-07T10:00:01.000Z",
  },
  {
    referenceId: "R020",
    status: "UNRESOLVED",
    probableFabrication: false,
    attempts: [
      { provider: "crossref", outcome: "error", note: "http-429" },
      { provider: "openalex", outcome: "error", note: "http-503" },
      { provider: "semantic-scholar", outcome: "error", note: "http-429" },
    ],
    checkedAt: "2026-09-07T10:00:02.000Z",
  },
  {
    referenceId: "R099",
    status: "NOT_FOUND",
    probableFabrication: true,
    attempts: [
      { provider: "crossref", outcome: "not_found" },
      { provider: "openalex", outcome: "not_found" },
      { provider: "semantic-scholar", outcome: "not_found" },
    ],
    checkedAt: "2026-09-07T10:00:03.000Z",
  },
];

function mockPanelData() {
  vi.mocked(listCitations).mockResolvedValue({
    summary: { extracted: true, references: 4, callouts: 6, resolvedRelations: 6, unresolvedRelations: 0, invalidRelations: 0, referencesWithDoi: 0 },
    references: REFERENCES,
  });
  vi.mocked(getCitationIntegrity).mockResolvedValue({ report: report({ VERIFIED: 1, METADATA_MISMATCH: 1, UNRESOLVED: 1, NOT_FOUND: 1 }) });
  vi.mocked(getMetadataRecords).mockResolvedValue(RECORDS);
}

describe("引用真实性状态文案（后端枚举 → 中文，无特判）", () => {
  it("五种 status 各有唯一文案；UNRESOLVED 是「待确认」而不是「未找到」", () => {
    expect(statusStyleOf(METADATA_STATUS_STYLES, "VERIFIED").label).toBe("已验证");
    expect(statusStyleOf(METADATA_STATUS_STYLES, "METADATA_MISMATCH").label).toBe("元数据不一致");
    expect(statusStyleOf(METADATA_STATUS_STYLES, "NOT_FOUND").label).toBe("未找到");
    expect(statusStyleOf(METADATA_STATUS_STYLES, "UNRESOLVED").label).toBe("待确认");
    expect(statusStyleOf(METADATA_STATUS_STYLES, "AMBIGUOUS").label).toBe("待定");
    expect(statusStyleOf(METADATA_STATUS_STYLES, "UNRESOLVED").tone).not.toBe("danger");
    expect(statusStyleOf(METADATA_STATUS_STYLES, "SOMETHING_NEW").label).toBe("SOMETHING_NEW"); // 未知值原样
  });
});

describe("CitationsPanel：状态行与核验详情", () => {
  it("每条文献按后端 status 显示；provider 失败的条目显示「待确认」，不显示「未找到」", async () => {
    mockPanelData();
    renderWithProviders(<CitationsPanel projectId="p-x1" />);

    const rowOf = async (label: string) => (await screen.findByTitle(label)).closest("article")!;
    expect(within(await rowOf("R005")).getByText("已验证")).toBeInTheDocument();
    expect(within(await rowOf("R006")).getByText("元数据不一致")).toBeInTheDocument();
    expect(within(await rowOf("R006")).getByText(/year：文中 2019，库中 2023/)).toBeInTheDocument();
    const unresolved = await rowOf("R020");
    expect(within(unresolved).getByText("待确认")).toBeInTheDocument();
    expect(within(unresolved).queryByText("未找到")).toBeNull();
    const ghost = await rowOf("R099");
    expect(within(ghost).getByText("未找到")).toBeInTheDocument();
    expect(within(ghost).getByText(/疑似捏造/)).toBeInTheDocument();
    // 账目：登记簿 chips
    expect(screen.getByText("已验证 1")).toBeInTheDocument();
    expect(screen.getByText("待确认 1")).toBeInTheDocument();
  });

  it("标题中的断词标记（U+00AD）不进入展示文本", async () => {
    mockPanelData();
    renderWithProviders(<CitationsPanel projectId="p-x1" />);
    const title = await screen.findByText("Bytetrack: Multi-object tracking by associating every detection box");
    expect(title.textContent).not.toContain(SOFT_HYPHEN);
  });

  it("核验详情默认折叠；展开后列出各库结果 / 匹配标题 / DOI / 检查时间，不显示内部诊断 note", async () => {
    mockPanelData();
    renderWithProviders(<CitationsPanel projectId="p-x1" />);
    const row = (await screen.findByTitle("R005")).closest("article")!;
    const details = within(row).getByText("核验详情").closest("details")!;
    expect(details.open).toBe(false);
    fireEvent.click(within(row).getByText("核验详情"));
    expect(within(details).getByText("Crossref：命中")).toBeInTheDocument();
    expect(within(details).getByText(/ByteTrack: Multi-object Tracking by Associating Every Detection Box（2022）/)).toBeInTheDocument();
    expect(within(details).getByText("10.1007/978-3-031-20047-2_1")).toBeInTheDocument();
    expect(within(details).getByText(/Yifu Zhang，Peize Sun，Yi Jiang 等/)).toBeInTheDocument();
    expect(within(details).getByText("检查时间")).toBeInTheDocument();
    expect(within(details).queryByText(/title#1/)).toBeNull(); // 诊断 note 只在日志 / 记录里

    const unresolvedRow = (await screen.findByTitle("R020")).closest("article")!;
    const unresolvedDetails = within(unresolvedRow).getByText("核验详情").closest("details")!;
    expect(within(unresolvedDetails).getByText("Crossref：查询失败")).toBeInTheDocument();
    expect(within(unresolvedDetails).getByText("Semantic Scholar：查询失败")).toBeInTheDocument();
  });
});
