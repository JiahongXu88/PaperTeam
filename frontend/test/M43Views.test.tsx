import { describe, expect, it, vi } from "vitest";
import { fireEvent, screen } from "@testing-library/react";

import { SkillsPage } from "../src/pages/SkillsPage.js";
import { PdfPanel } from "../src/components/project/PdfPanel.js";
import { CitationsPanel } from "../src/components/project/CitationsPanel.js";
import { ApiError } from "../src/api/client.js";
import type { SkillView } from "../src/types/paper.js";
import { renderWithProviders } from "./helpers.js";

/** M4.3.7：PDF / Citations / Skills 最小 UI（server state 全部经 TanStack Query） */

vi.mock("../src/api/skills.js", () => ({
  listSkills: vi.fn(),
  getSkill: vi.fn(),
  regenerateSkillSummary: vi.fn(),
}));

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

const { listSkills } = await import("../src/api/skills.js");
const { getPaper, uploadPaperPdf, listCitations, getCitationIntegrity, getMetadataRecords } =
  await import("../src/api/paper.js");

const skills: SkillView[] = [
  {
    id: "verify-citations",
    name: "verify-citations",
    originalDescription: "Use when asked to verify, check, or audit the citations…",
    chineseSummary: "引用真实性与语义一致性核验。用于核验论文引用是否真实存在并支持正文论断。",
    sourceType: "external",
    sourceRepo: "Agents4Academia-AI/citation_verification",
    sourceRevision: "ae85ae3d51a275a57f7aa80db22870995e3d0275",
    license: "MIT",
    installedPath: "installed/verify-citations",
    contentHash: "b".repeat(64),
    status: "installed",
    installedAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
    assignedAgents: ["citation", "reviewer"],
    allowedTools: [],
    summaryStatus: "ok",
  },
  {
    id: "paper-search",
    name: "paper-search",
    originalDescription: "Search, download, and read academic papers from 20+ sources…",
    sourceType: "external",
    sourceRepo: "openags/paper-search-mcp",
    sourceRevision: "234678ab231074a7977320978ee0496dcdaddd1f",
    license: "MIT",
    installedPath: "installed/paper-search",
    contentHash: "c".repeat(64),
    status: "installed",
    installedAt: "2026-09-06T00:00:00.000Z",
    updatedAt: "2026-09-06T00:00:00.000Z",
    assignedAgents: ["researcher", "citation"],
    allowedTools: ["search_papers", "lookup_paper"],
    summaryStatus: "summary_pending",
    wrapperNote: "PaperTeam 兼容版",
  },
];

describe("SkillsPage（M4.3.7）", () => {
  it("渲染 skill 卡片：中文简介为主、来源/revision/license/assigned agents", async () => {
    vi.mocked(listSkills).mockResolvedValue({
      skills,
      bindings: [
        { agentRole: "citation", skillIds: ["paper-search", "verify-citations"] },
        { agentRole: "writer", skillIds: [] },
      ],
    });
    renderWithProviders(<SkillsPage />, { route: "/skills" });

    // 卡片标题与 Agent 绑定表锚点都会出现 skill 名
    expect((await screen.findAllByText("verify-citations")).length).toBeGreaterThan(0);
    expect(screen.getByText(/引用真实性与语义一致性核验/)).toBeInTheDocument();
    expect(screen.getByText(/citation_verification/)).toBeInTheDocument();
    expect(screen.getAllByText(/ae85ae3/).length).toBeGreaterThan(0);
    expect(screen.getAllByText("MIT").length).toBeGreaterThan(0);
    expect(screen.getAllByText(/citation/).length).toBeGreaterThan(0);
    // summary_pending 的 skill 显示引导文案
    expect(screen.getByText(/中文简介待生成/)).toBeInTheDocument();
  });

  it("不显示未实现的 Install / Uninstall 按钮", async () => {
    vi.mocked(listSkills).mockResolvedValue({ skills, bindings: [] });
    renderWithProviders(<SkillsPage />, { route: "/skills" });
    await screen.findByText("verify-citations");
    expect(screen.queryByRole("button", { name: /install/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /uninstall/i })).not.toBeInTheDocument();
    expect(screen.queryByRole("button", { name: /update/i })).not.toBeInTheDocument();
  });

  it("错误态：显示错误与重试", async () => {
    vi.mocked(listSkills).mockRejectedValueOnce(
      new ApiError(0, "NETWORK_ERROR", "无法连接 PaperTeam Backend（请确认后端已启动）"),
    );
    renderWithProviders(<SkillsPage />, { route: "/skills" });
    expect(await screen.findByRole("alert")).toHaveTextContent("无法连接");
  });
});

describe("PdfPanel（M4.3.7）", () => {
  it("空态：未上传时显示上传入口", async () => {
    vi.mocked(getPaper).mockResolvedValue({ document: null, note: "尚未上传最终 PDF" });
    renderWithProviders(<PdfPanel projectId="p-x1" />);
    expect(await screen.findByText("上传最终 PDF")).toBeInTheDocument();
    expect(screen.getByLabelText(/\.pdf/i)).toBeInTheDocument();
  });

  it("已上传：显示文件名/页数/章节块数/解析状态与 Paper Structure 表", async () => {
    vi.mocked(getPaper).mockResolvedValue({
      document: {
        projectId: "p-x1",
        documentId: "paper-1",
        title: "Attention Is All You Need",
        originalFileName: "attention.pdf",
        bytes: 2215244,
        sha256: "abc123",
        parse: {
          parserId: "pymupdf",
          parserVersion: "1.28.2",
          parsedAt: "2026-09-06T00:00:00.000Z",
          durationMs: 850,
          pageCount: 15,
          extractionQuality: "good",
        },
        pageCount: 15,
        sectionCount: 23,
        chunkCount: 27,
        ingestedAt: "2026-09-06T00:00:00.000Z",
      },
      sections: [
        {
          sectionId: "SEC01",
          title: "Introduction",
          level: 1,
          pageStart: 1,
          pageEnd: 2,
          charCount: 4300,
          source: "toc",
        },
      ],
      stages: { parse: { status: "ok" } },
    });
    renderWithProviders(<PdfPanel projectId="p-x1" />);

    expect(await screen.findByText("Attention Is All You Need")).toBeInTheDocument();
    expect(screen.getByText(/attention\.pdf/)).toBeInTheDocument();
    expect(screen.getByText("15")).toBeInTheDocument();
    expect(screen.getByText(/23 \/ 27/)).toBeInTheDocument();
    expect(screen.getByText("Introduction")).toBeInTheDocument();
    expect(screen.getByText("p1-2")).toBeInTheDocument();
  });

  it("错误态：加载失败显示重试", async () => {
    vi.mocked(getPaper).mockRejectedValueOnce(
      new ApiError(0, "NETWORK_ERROR", "无法连接 PaperTeam Backend"),
    );
    renderWithProviders(<PdfPanel projectId="p-x1" />);
    expect(await screen.findByRole("alert")).toHaveTextContent("PDF 状态加载失败");
  });
});

describe("CitationsPanel（M4.3.7）", () => {
  it("未提取：显示引导与提取按钮", async () => {
    vi.mocked(listCitations).mockResolvedValue({
      summary: {
        extracted: false,
        references: 0,
        callouts: 0,
        resolvedRelations: 0,
        unresolvedRelations: 0,
        invalidRelations: 0,
        referencesWithDoi: 0,
      },
      references: [],
    });
    renderWithProviders(<CitationsPanel projectId="p-x1" />);
    expect(await screen.findByText(/尚未提取引用/)).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /提取引用/ })).toBeInTheDocument();
  });

  it("已提取：摘要 chips + reference 表（status / canonical）", async () => {
    vi.mocked(listCitations).mockResolvedValue({
      summary: {
        extracted: true,
        references: 2,
        callouts: 5,
        resolvedRelations: 5,
        unresolvedRelations: 0,
        invalidRelations: 0,
        referencesWithDoi: 1,
      },
      references: [
        {
          referenceId: "R001",
          number: 1,
          rawText: "[1] Jimmy Lei Ba…",
          title: "Layer Normalization",
          authors: ["Jimmy Lei Ba"],
          year: 2016,
          page: 10,
        },
        {
          referenceId: "R002",
          number: 2,
          rawText: "[2] Ghost paper…",
          title: "Ghost Paper",
          year: 2027,
          page: 10,
        },
      ],
    });
    vi.mocked(getCitationIntegrity).mockResolvedValue({
      report: {
        metadataByStatus: {
          VERIFIED: 1,
          METADATA_MISMATCH: 0,
          AMBIGUOUS: 0,
          NOT_FOUND: 1,
          UNRESOLVED: 0,
        },
        probableFabrications: ["R002"],
        semantic: {
          total: 0,
          byVerdict: {
            SUPPORTED: 0,
            PARTIALLY_SUPPORTED: 0,
            UNSUPPORTED: 0,
            CONTRADICTED: 0,
            INSUFFICIENT_EVIDENCE: 0,
            SKIPPED: 0,
          },
          gate: {
            probableFabricated: 1,
            notFoundObligatory: 0,
            unsupportedCritical: 0,
            mismatchCritical: 0,
            insufficientEvidence: 0,
          },
        },
      },
    });
    vi.mocked(getMetadataRecords).mockResolvedValue([
      {
        referenceId: "R001",
        status: "VERIFIED",
        probableFabrication: false,
        canonical: { provider: "arxiv", recordId: "1607.06450", title: "Layer Normalization" },
      },
      {
        referenceId: "R002",
        status: "NOT_FOUND",
        probableFabrication: true,
      },
    ]);
    renderWithProviders(<CitationsPanel projectId="p-x1" />);

    // 标题行 + 折叠的「核验详情」里的匹配标题都会出现
    expect((await screen.findAllByText("Layer Normalization")).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("已验证 1")).toBeInTheDocument();
    expect(screen.getByText("未找到 1")).toBeInTheDocument();
    expect(screen.getByText(/疑似捏造/)).toBeInTheDocument();
    expect(screen.getByText("来源 arxiv")).toBeInTheDocument();
    // 操作按钮存在
    expect(screen.getByRole("button", { name: /核验文献真实性/ })).toBeInTheDocument();
    expect(screen.getByRole("button", { name: /语义核验/ })).toBeInTheDocument();
  });
});

describe("PDF 上传交互（M4.3.7）", () => {
  it("file input 触发 uploadPaperPdf（fileName + base64 payload）", async () => {
    vi.mocked(getPaper).mockResolvedValue({ document: null });
    vi.mocked(uploadPaperPdf).mockResolvedValue({ document: null, unchanged: false });
    renderWithProviders(<PdfPanel projectId="p-x1" />);

    const input = await screen.findByLabelText(/\.pdf/i);
    const file = new File(["%PDF-1.5 fake"], "paper.pdf", { type: "application/pdf" });
    fireEvent.change(input, { target: { files: [file] } });
    const { waitFor } = await import("@testing-library/react");
    await waitFor(() => {
      expect(uploadPaperPdf).toHaveBeenCalled();
    });
    expect(uploadPaperPdf).toHaveBeenCalledWith(
      "p-x1",
      expect.objectContaining({ fileName: "paper.pdf", contentBase64: expect.any(String) }),
    );
  });

  it("非 PDF 文件被前端拒绝（不发起请求）", async () => {
    vi.mocked(getPaper).mockResolvedValue({ document: null });
    renderWithProviders(<PdfPanel projectId="p-x1" />);
    vi.mocked(uploadPaperPdf).mockClear();
    const input = await screen.findByLabelText(/\.pdf/i);
    fireEvent.change(input, {
      target: { files: [new File(["x"], "paper.txt", { type: "text/plain" })] },
    });
    expect(await screen.findByText("只接受 .pdf 文件")).toBeInTheDocument();
    expect(uploadPaperPdf).not.toHaveBeenCalled();
  });
});
