import { describe, expect, it, vi, beforeEach } from "vitest";
import { screen } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { TargetPanel } from "../src/components/project/TargetPanel.js";
import { renderWithProviders } from "./helpers.js";
import type { TargetBenchmarkView, TargetProfileView, TargetReadinessView } from "../src/api/target.js";

/**
 * M12.1 A10 TargetPanel：目标参照系 UI。
 * - 未配置目标 → 专属空态（区别于「已配置未发现」）
 * - 已配置未发现 → 空态 + 发现按钮（真实操作链路：discover → API 调用）
 * - 语料 / profile / readiness 数据齐全 → 表格 + 分位带 + 四档判决徽章
 */

vi.mock("../src/api/projects.js", () => ({
  getProject: vi.fn(),
}));

vi.mock("../src/api/target.js", () => ({
  getTargetBenchmark: vi.fn(),
  getTargetProfile: vi.fn(),
  getTargetReadiness: vi.fn(),
  discoverTargetBenchmark: vi.fn(),
  refreshTargetBenchmark: vi.fn(),
  addTargetBenchmarkPaper: vi.fn(),
  excludeTargetBenchmarkPaper: vi.fn(),
  confirmTargetBenchmark: vi.fn(),
  regenerateTargetProfile: vi.fn(),
  evaluateTargetReadiness: vi.fn(),
}));

const projectsApi = await import("../src/api/projects.js");
const targetApi = await import("../src/api/target.js");

beforeEach(() => {
  vi.clearAllMocks();
});

const projectConfigured = {
  id: "p-target00001",
  title: "MOT 目标测试",
  researchField: "multi-object tracking",
  documentType: "conference_paper",
  targetProfile: "high_level_conference",
  targetVenue: "CVPR",
};

describe("TargetPanel", () => {
  it("未配置目标（无 researchField / venue）→ 专属空态", async () => {
    vi.mocked(projectsApi.getProject).mockResolvedValue({
      ...projectConfigured,
      researchField: undefined,
      targetVenue: undefined,
    } as never);
    vi.mocked(targetApi.getTargetBenchmark).mockResolvedValue(null);
    vi.mocked(targetApi.getTargetProfile).mockResolvedValue({ profile: null, fresh: null });
    vi.mocked(targetApi.getTargetReadiness).mockResolvedValue(null);

    renderWithProviders(<TargetPanel projectId="p-target00001" />);
    expect(await screen.findByTestId("target-empty-not-configured")).toBeTruthy();
  });

  it("已配置未发现 → 空态 + 发现按钮；点击触发真实 discover API", async () => {
    vi.mocked(projectsApi.getProject).mockResolvedValue(projectConfigured as never);
    vi.mocked(targetApi.getTargetBenchmark).mockResolvedValue(null);
    vi.mocked(targetApi.getTargetProfile).mockResolvedValue({ profile: null, fresh: null });
    vi.mocked(targetApi.getTargetReadiness).mockResolvedValue(null);
    vi.mocked(targetApi.discoverTargetBenchmark).mockResolvedValue({
      revision: 0,
      papers: 8,
      savedSourceIds: 8,
      venueDegraded: false,
      sufficiency: "sufficient",
      requiresAttention: [],
      alreadyFrozen: false,
    });

    renderWithProviders(<TargetPanel projectId="p-target00001" />);
    const discoverButton = await screen.findByTestId("target-benchmark-discover");
    await userEvent.click(discoverButton);
    expect(await vi.waitFor(() => targetApi.discoverTargetBenchmark)).toHaveBeenCalledWith("p-target00001");
  });

  it("语料 + profile + readiness 齐全 → 表格行、分位带、判决徽章、insufficient 警告", async () => {
    const benchmark: TargetBenchmarkView = {
      schemaVersion: 1,
      revision: 0,
      createdAt: "2026-10-07T00:00:00Z",
      updatedAt: "2026-10-07T00:00:00Z",
      fingerprint: "abc123",
      target: {
        documentType: "conference_paper",
        targetProfile: "high_level_conference",
        targetVenue: "CVPR",
        researchField: "multi-object tracking",
      },
      papers: [
        {
          sourceId: "S01",
          identityKey: "doi:10.0000/a",
          provenance: { provider: "openalex", retrievedAt: "2026-10-07T00:00:00Z", queryUsed: "multi-object tracking" },
          inclusionReason: "venue 命中 + 引用数带内",
          citationCount: 420,
          venueRaw: "CVPR",
          hasFullText: false,
        },
      ],
      selection: {
        selectedAt: "2026-10-07T00:00:00Z",
        targetCount: 8,
        sufficiency: "sufficient",
        requiresAttention: [],
      },
    };
    const profile: TargetProfileView = {
      schemaVersion: 1,
      benchmarkRevision: 0,
      corpusFingerprint: "abc123",
      extractorSchemaVersion: 1,
      n: 8,
      dimensions: {
        structure: {
          availability: "available",
          coverage: 8,
          sectionPattern: { "introduction": { present: 8, medianLengthWords: 600 } },
          totalLengthWords: { n: 8, min: 5000, p25: 6500, median: 7500, p75: 8500, max: 9500 },
        },
        literature: { availability: "available", coverage: 8 },
        experiments: { availability: "available", coverage: 8 },
        visuals: { availability: "insufficient", coverage: 0, reason: "语料论文无全文解析产物" },
        method: { availability: "unavailable", coverage: 0, reason: "摘要模型未装配" },
        writing: { availability: "unavailable", coverage: 0, reason: "摘要模型未装配" },
      },
      provenance: { deterministicFields: ["structure"], modelSummarizedFields: [] },
      generatedAt: "2026-10-07T00:00:00Z",
      notes: [],
    };
    const readiness: TargetReadinessView = {
      schemaVersion: 1,
      evaluatedAt: "2026-10-07T00:00:00Z",
      benchmarkRevision: 0,
      manuscriptRevision: null,
      dimensions: [
        {
          dimension: "structure",
          verdict: "PARTIALLY_MEETS_TARGET",
          observed: "正文 4200 词",
          targetRange: "6500–8500 词（p25–p75）",
          gaps: ["篇幅低于目标带（不构成稿件事实错误；目标带非官方投稿要求）"],
          confidence: "high",
          evidenceBasis: "manuscriptStats 确定性词数",
        },
        {
          dimension: "experiments",
          verdict: "INSUFFICIENT_EVIDENCE",
          observed: "当前稿无实验章节",
          targetRange: "—",
          gaps: [],
          confidence: "low",
          evidenceBasis: "无观测点",
        },
      ],
      overall: { verdict: "BELOW_TARGET", summary: "篇幅与实验覆盖与目标带有差距" },
      provenance: {
        basis: "benchmark_observation",
        disclaimer: "benchmark 观测非官方投稿要求",
        profileGeneratedAt: "2026-10-07T00:00:00Z",
      },
    };

    vi.mocked(projectsApi.getProject).mockResolvedValue(projectConfigured as never);
    vi.mocked(targetApi.getTargetBenchmark).mockResolvedValue(benchmark);
    vi.mocked(targetApi.getTargetProfile).mockResolvedValue({ profile, fresh: true });
    vi.mocked(targetApi.getTargetReadiness).mockResolvedValue(readiness);

    renderWithProviders(<TargetPanel projectId="p-target00001" />);

    // 语料表：论文行 + venue + 引用数
    expect(await screen.findByTestId("target-benchmark-paper")).toBeTruthy();
    expect(screen.getByText("CVPR")).toBeTruthy();
    expect(screen.getByText("420")).toBeTruthy();
    // profile 分位带区块
    expect(await screen.findByTestId("target-profile-section")).toBeTruthy();
    // readiness：overall + 维度判决
    expect(await screen.findByTestId("target-readiness-section")).toBeTruthy();
    expect(screen.getByTestId("target-readiness-overall").textContent).toContain("低于目标带");
    const dimensions = screen.getAllByTestId("target-readiness-dimension");
    expect(dimensions.length).toBe(2);
    expect(screen.getByTestId("target-readiness-insufficient")).toBeTruthy();
  });
});
