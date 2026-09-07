import { describe, expect, it, vi, beforeEach } from "vitest";
import { fireEvent, screen, within } from "@testing-library/react";

import { CitationsPanel } from "../src/components/project/CitationsPanel.js";
import { ReviewPanel } from "../src/components/project/ReviewPanel.js";
import type {
  ClaimRecordView,
  IntegrityReportView,
  MetadataRecordView,
  ReferenceView,
} from "../src/types/paper.js";
import type { ExistingReviewReportView } from "../src/types/api.js";
import { renderWithProviders } from "./helpers.js";

/**
 * 语义核验可用性（2026-09 Review Usability）：
 * - 明细列表逐条可定位（页码 / 章节 / 论断 / 引用 / 理由 / 证据或明示无证据）；
 * - 顶部统计数字可点击 → 直接过滤明细（证据不足 N → 只看证据不足）；
 * - Review 页「导出报告」触发 Markdown 下载。
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
  getClaimRecords: vi.fn(),
  exportReviewReport: vi.fn(),
  getPaperReviewReport: vi.fn(),
  reparsePaperPdf: vi.fn(),
}));

vi.mock("../src/api/runs.js", () => ({
  createWorkflowRun: vi.fn(),
  listProjectRuns: vi.fn(async () => []),
}));

vi.mock("../src/api/runtime.js", () => ({
  getRuntimeStatus: vi.fn(async () => ({ model: { phase: "ready" }, pdf: { phase: "ready" } })),
}));

const paperApi = await import("../src/api/paper.js");
const { listCitations, getCitationIntegrity, getMetadataRecords, getClaimRecords, getPaper, exportReviewReport } =
  vi.mocked(paperApi);

// jsdom 无 blob 下载与 scrollIntoView 基础设施
beforeEach(() => {
  Object.defineProperty(URL, "createObjectURL", { value: vi.fn(() => "blob:mock"), writable: true });
  Object.defineProperty(URL, "revokeObjectURL", { value: vi.fn(), writable: true });
  Object.defineProperty(window.HTMLElement.prototype, "scrollIntoView", { value: vi.fn(), writable: true });
});

const REFERENCES: ReferenceView[] = [
  {
    referenceId: "R001",
    number: 1,
    rawText: "[1] Y. Zhang et al., “ByteTrack…” ECCV, 2022.",
    title: "ByteTrack: Multi-object tracking",
    authors: ["Y. Zhang"],
    year: 2022,
    page: 24,
  },
  {
    referenceId: "R002",
    number: 2,
    rawText: "[2] G. Jocher and J. Qiu, “Ultralytics yolo11,” 2024.",
    title: "Ultralytics yolo11",
    authors: ["G. Jocher", "J. Qiu"],
    year: 2024,
    page: 25,
  },
];

const RECORDS: MetadataRecordView[] = [
  {
    referenceId: "R001",
    status: "VERIFIED",
    probableFabrication: false,
    canonical: {
      provider: "crossref",
      recordId: "10.1000/x",
      title: "ByteTrack: Multi-object tracking",
      doi: "10.1000/x",
    },
    attempts: [],
  },
  {
    referenceId: "R002",
    status: "VERIFIED",
    kind: "software",
    probableFabrication: false,
    canonical: {
      provider: "github",
      recordId: "ultralytics/ultralytics",
      url: "https://github.com/ultralytics/ultralytics",
      software: {
        repositoryUrl: "https://github.com/ultralytics/ultralytics",
        homepage: "https://docs.ultralytics.com",
        description: "Ultralytics YOLO11 toolkit",
      },
    },
    attempts: [{ provider: "github", outcome: "match" }],
  },
];

function claim(overrides: Partial<ClaimRecordView>): ClaimRecordView {
  return {
    claimCitationId: "CT001-R001",
    citationId: "CT001",
    referenceId: "R001",
    claimText: "遮挡恢复率显著提升。",
    sectionId: "SEC04",
    page: 6,
    priority: "helpful",
    metadataStatus: "VERIFIED",
    verdict: "INSUFFICIENT_EVIDENCE",
    reason: "只获取到书目 metadata",
    reasonCode: "NO_EVIDENCE",
    evidence: [],
    severity: "minor",
    status: "verified",
    ...overrides,
  };
}

const CLAIMS: ClaimRecordView[] = [
  claim({}),
  claim({
    claimCitationId: "CT002-R001",
    citationId: "CT002",
    claimText: "ByteTrack 关联了每个检测框。",
    page: 7,
    verdict: "SUPPORTED",
    reason: "摘要明确说明关联每个检测框",
    reasonCode: undefined,
    evidence: [
      {
        source: "crossref:10.1000/x",
        text: "We associate every detection box.",
        evidenceLevel: "abstract",
        doi: "10.1000/x",
      },
    ],
  }),
  claim({
    claimCitationId: "CT003-R001",
    citationId: "CT003",
    claimText: "该方法完全解决了遮挡问题。",
    page: 8,
    verdict: "UNSUPPORTED",
    reason: "证据没有提及完全解决",
    evidence: [
      { source: "crossref:10.1000/x", text: "We associate every detection box.", evidenceLevel: "abstract" },
    ],
  }),
  claim({
    claimCitationId: "CT004-R002",
    citationId: "CT004",
    referenceId: "R002",
    claimText: "YOLO11 是实时检测器。",
    page: 4,
    verdict: "INSUFFICIENT_EVIDENCE",
    reason: "仓库描述超出支持范围",
    reasonCode: "ABSTRACT_ONLY",
    evidence: [{ source: "github:ultralytics/ultralytics", text: "Ultralytics YOLO11 toolkit", evidenceLevel: "repository" }],
  }),
];

const REPORT: IntegrityReportView = {
  metadataByStatus: { VERIFIED: 2, METADATA_MISMATCH: 0, AMBIGUOUS: 0, NOT_FOUND: 0, PROVIDER_ERROR: 0, UNRESOLVED: 0 },
  probableFabrications: [],
  semantic: {
    total: 4,
    byVerdict: { SUPPORTED: 1, PARTIALLY_SUPPORTED: 0, UNSUPPORTED: 1, CONTRADICTED: 0, INSUFFICIENT_EVIDENCE: 2, SKIPPED: 0 },
    gate: { probableFabricated: 0, notFoundObligatory: 0, unsupportedCritical: 0, mismatchCritical: 0, insufficientEvidence: 2 },
  },
};

function mockPanelData(claims: ClaimRecordView[] = CLAIMS) {
  vi.mocked(listCitations).mockResolvedValue({
    summary: { extracted: true, references: 2, callouts: 4, resolvedRelations: 4, unresolvedRelations: 0, invalidRelations: 0, referencesWithDoi: 1 },
    references: REFERENCES,
  });
  vi.mocked(getCitationIntegrity).mockResolvedValue({ report: REPORT });
  vi.mocked(getMetadataRecords).mockResolvedValue(RECORDS);
  vi.mocked(getClaimRecords).mockResolvedValue(claims);
  vi.mocked(getPaper).mockResolvedValue({
    document: {
      projectId: "p-s1",
      documentId: "d1",
      originalFileName: "paper.pdf",
      bytes: 1,
      sha256: "x",
      parse: { parserId: "pymupdf", parsedAt: "2026-09-07T00:00:00.000Z", durationMs: 1, pageCount: 25, extractionQuality: "good" },
      pageCount: 25,
      sectionCount: 8,
      chunkCount: 100,
      ingestedAt: "2026-09-07T00:00:00.000Z",
    },
    sections: [
      { sectionId: "SEC04", title: "实验与分析", level: 1, pageStart: 5, pageEnd: 9, charCount: 100, source: "toc" },
    ],
  });
}

describe("语义核验明细（CitationsPanel）", () => {
  it("每条记录显示位置 / 论断 / 引用 / 理由（含结构化原因）/ 证据或明示无证据", async () => {
    mockPanelData();
    renderWithProviders(<CitationsPanel projectId="p-s1" />);

    const section = await screen.findByTestId("semantic-claims");
    const rows = await within(section).findAllByTestId("claim-row");
    expect(rows).toHaveLength(4);

    // 无证据记录：明示「当前未获得…」，且给出结构化原因（chip + 理由后缀都可能出现）
    const noEvidence = rows.find((row) => within(row).queryAllByText(/只获取到书目 metadata/).length > 0)!;
    expect(noEvidence).toBeDefined();
    expect(within(noEvidence).getByText("当前未获得足够可核验的原文证据。")).toBeInTheDocument();
    expect(within(noEvidence).getByText(/正文位置：第 6 页 · 实验与分析/)).toBeInTheDocument();
    expect(within(noEvidence).getByText("[1]")).toBeInTheDocument();
    expect(within(noEvidence).getByText(/ByteTrack: Multi-object tracking/)).toBeInTheDocument();
    expect(within(noEvidence).getByText("证据不足")).toBeInTheDocument();

    // 有证据记录：证据折叠区含来源 / 等级 / 片段
    const withEvidence = rows.find((row) => within(row).queryByText("支持") !== null)!;
    const details = within(withEvidence).getByText(/证据（1 条）/).closest("details")!;
    fireEvent.click(within(withEvidence).getByText(/证据（1 条）/));
    expect(within(details).getByText(/来源 crossref:10.1000\/x · 等级 摘要/)).toBeInTheDocument();
    expect(within(details).getByText(/We associate every detection box/)).toBeInTheDocument();

    // repository 级证据（software）
    const repoEvidence = rows.find((row) => within(row).queryByText(/仓库描述超出支持范围/) !== null)!;
    expect(repoEvidence).toBeDefined();
    expect(within(repoEvidence).getAllByText(/仅有摘要（或仓库描述）级证据/).length).toBeGreaterThan(0);

    // 不支持：红色语义
    const unsupported = rows.find((row) => within(row).queryByText("不支持") !== null)!;
    expect(within(unsupported).getByText(/证据没有提及完全解决/)).toBeInTheDocument();
  });

  it("点击统计「证据不足 2」→ 只显示证据不足记录；再点回全部", async () => {
    mockPanelData();
    renderWithProviders(<CitationsPanel projectId="p-s1" />);

    await screen.findByTestId("semantic-claims");
    const ledgerButton = screen.getByTestId("ledger-filter-证据不足");
    expect(ledgerButton.textContent).toBe("证据不足 2");
    fireEvent.click(ledgerButton);

    const section = screen.getByTestId("semantic-claims");
    const rows = await within(section).findAllByTestId("claim-row");
    expect(rows).toHaveLength(2);
    expect(within(section).queryByText("支持")).toBeNull();

    // 过滤器单选联动
    const checked = within(section).getByLabelText(/证据不足 2/) as HTMLInputElement;
    expect(checked.checked).toBe(true);

    // 点击已选中的统计 → 回到全部
    fireEvent.click(screen.getByTestId("ledger-filter-证据不足"));
    expect(await within(screen.getByTestId("semantic-claims")).findAllByTestId("claim-row")).toHaveLength(4);
  });

  it("明细筛选器直接切换：不支持 → 只剩 UNSUPPORTED", async () => {
    mockPanelData();
    renderWithProviders(<CitationsPanel projectId="p-s1" />);
    const section = await screen.findByTestId("semantic-claims");
    fireEvent.click(within(section).getByLabelText(/不支持 1/));
    const rows = await within(section).findAllByTestId("claim-row");
    expect(rows).toHaveLength(1);
    expect(within(rows[0]!).getByText("不支持")).toBeInTheDocument();
  });

  it("software 引用行：类型 chip + 官方仓库/文档链接 + 官方来源 GitHub", async () => {
    mockPanelData();
    renderWithProviders(<CitationsPanel projectId="p-s1" />);
    const row = (await screen.findByTitle("R002")).closest("article")!;
    expect(within(row).getByText("软件")).toBeInTheDocument();
    expect(within(row).getByText("已验证")).toBeInTheDocument();
    const repoLink = within(row).getByText("github.com/ultralytics/ultralytics");
    expect(repoLink.closest("a")?.getAttribute("href")).toBe("https://github.com/ultralytics/ultralytics");
    expect(within(row).getByText("官方文档").closest("a")?.getAttribute("href")).toBe("https://docs.ultralytics.com");
    expect(within(row).getByText("官方来源 GitHub")).toBeInTheDocument();
  });
});

describe("ReviewPanel 导出报告", () => {
  it("有报告时显示「导出报告」；点击触发 Markdown 下载（blob + 文件名）", async () => {
    mockPanelData([]);
    const report: ExistingReviewReportView = {
      schemaVersion: 1,
      kind: "existing_paper_review",
      round: 1,
      generatedAt: "2026-09-07T00:00:00.000Z",
      paper: { title: "测试论文", pageCount: 10, sections: 5 },
      review: {
        sectionsReviewed: 5,
        sectionsTotal: 5,
        findingsTotal: 0,
        bySeverity: {},
        byCategory: {},
      },
      citationIntegrity: {},
      findings: [],
    };
    const { getPaperReviewReport } = vi.mocked(paperApi);
    getPaperReviewReport.mockResolvedValue(report);
    vi.mocked(exportReviewReport).mockResolvedValue({
      blob: new Blob(["# PaperTeam Review Report"], { type: "text/markdown" }),
      fileName: "测试论文-r1.md",
    });

    renderWithProviders(<ReviewPanel projectId="p-s1" onOpenTab={() => {}} />);
    const button = await screen.findByTestId("export-report");
    expect(button.textContent).toContain("导出报告");
    fireEvent.click(button);
    await vi.waitFor(() => {
      expect(exportReviewReport).toHaveBeenCalledWith("p-s1");
      expect(URL.createObjectURL).toHaveBeenCalled();
    });
  });

  it("无报告时不显示导出按钮", async () => {
    mockPanelData([]);
    vi.mocked(paperApi.getPaperReviewReport).mockResolvedValue(null);
    renderWithProviders(<ReviewPanel projectId="p-s1" onOpenTab={() => {}} />);
    await screen.findByTestId("review-panel");
    expect(screen.queryByTestId("export-report")).toBeNull();
  });
});
