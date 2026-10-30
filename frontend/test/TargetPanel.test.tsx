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
  getTargetEvidenceAudit: vi.fn(),
  evaluateTargetEvidenceAudit: vi.fn(),
}));

const projectsApi = await import("../src/api/projects.js");
const targetApi = await import("../src/api/target.js");

beforeEach(() => {
  vi.clearAllMocks();
  // M15.16：证据审计缺省 flag off（既有用例不涉及该区块时也返回合法信封）
  vi.mocked(targetApi.getTargetEvidenceAudit).mockResolvedValue({ enabled: false, audit: null });
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
  // ---- M15.16 P0-A：证据审计（实验性）区块 ----

  const auditArtifact = {
    schemaVersion: 1,
    documentType: "research_article",
    promptVersion: "m1514-caudit-v1",
    evaluatedAt: "2026-10-31T00:00:00Z",
    manuscriptRevision: 1,
    priorWork: {
      cutoffDate: "2026-10-31",
      poolFingerprint: "abcd1234",
      poolSize: 3,
      queriesUsed: ["resolve:x"],
      candidates: [
        { candidateId: "P01", title: "Prior Work One", year: 2020, doi: "10.1/a", contentLevel: "verified_fulltext" as const, citedByManuscript: true, source: "crossref:10.1/a", librarySourceId: "src-0001" },
        { candidateId: "P02", title: "Prior Work Two", year: 2016, contentLevel: "abstract" as const, citedByManuscript: false, source: "openalex:W1" },
        { candidateId: "P03", title: "Prior Work Three", year: 2014, contentLevel: "metadata" as const, citedByManuscript: false, source: "openalex:W2" },
      ],
    },
    inventory: [
      {
        contributionId: "C1",
        claimQuote: "We propose a hierarchical fusion module.",
        claimType: "technical_idea",
        sectionId: "SEC01",
        supportStatus: "located",
        anchorVerified: true,
        supportLocations: [{ sectionId: "SEC02", kind: "method", verified: true }],
      },
    ],
    comparisons: [
      {
        contributionId: "C1",
        nearestPriorWorks: [
          { candidateId: "P01", title: "Prior Work One", year: 2020, doi: "10.1/a", sourceLevel: "pool_fulltext", quote: "binarization", priorQuoteVerified: true, resolvesToPool: true },
        ],
        commonMechanism: "learnable post-processing",
        substantiveDifference: "hierarchical fusion across stages",
        differenceBasis: "fulltext",
        completedVerification: "two datasets",
        missingVerification: "no ablation",
        status: "SUPPORTED_DIFFERENCE" as const,
      },
    ],
    gapPlan: [
      {
        contributionId: "C1",
        gap: "无消融验证",
        actionType: "requires_real_experiment_or_author_input" as const,
        experimentPlan: { purpose: "验证融合贡献", baselines: "去融合变体", metrics: "F1" },
        status: "author_decision" as const,
      },
      { contributionId: "C1", gap: "措辞过强", actionType: "can_rewrite_from_existing_evidence" as const, status: "proposed" as const },
    ],
    findings: [],
    coverage: { sectionsTotal: 8, sectionsIndexed: 8, sectionsIncludedFullText: 4, manuscriptCharsTotal: 40000, manuscriptCharsIncluded: 20000, truncations: [] },
    guards: { anchorFailures: 0, unresolvedPriorWorkRefs: 0, cutoffViolations: 0, statusRuleViolations: 0, droppedFindings: 0, priorQuoteReplayFailures: 0, fulltextBasisDowngrades: 0 },
    inputFingerprint: { manuscriptSha256: "aa", poolFingerprint: "abcd1234", promptVersion: "m1514-caudit-v1", documentType: "research_article" },
    provenance: { basis: "model_judgment_advisory", disclaimer: "advisory，不构成录用判断" },
  };
  const auditMeta = {
    schemaVersion: 1 as const,
    evaluatedAt: "2026-10-31T00:00:00Z",
    documentType: "research_article",
    manuscriptRevision: 1,
    poolBuild: {
      cutoffDate: "2026-10-31",
      referenceEntriesTotal: 41,
      referenceEntriesEligible: 20,
      refResolved: 12,
      refUnresolved: 8,
      refLookupErrors: 0,
      externalQuery: "fusion text detection",
      externalRetrieved: 10,
      libraryCandidates: 1,
      libraryUpgraded: 1,
      dedupedCandidates: 22,
      selfExcluded: 1,
      poolCap: 12,
      contentLevels: { abstract: 1, metadata: 1, verified_fulltext: 1 },
      buildNotes: [],
      extractorNotes: [],
    },
    telemetry: { calls: 3, failed: 0, totalMs: 45000, approxPromptChars: 90000, outputChars: 6000 },
    extractParseFailed: false,
    compareParseFailed: false,
    synthesizeParseFailed: false,
  };

  it("证据审计 flag off（enabled:false）→ 区块不渲染（无误导性空按钮）", async () => {
    vi.mocked(projectsApi.getProject).mockResolvedValue(projectConfigured as never);
    vi.mocked(targetApi.getTargetBenchmark).mockResolvedValue(null);
    vi.mocked(targetApi.getTargetProfile).mockResolvedValue({ profile: null, fresh: null });
    vi.mocked(targetApi.getTargetReadiness).mockResolvedValue(null);
    vi.mocked(targetApi.getTargetEvidenceAudit).mockResolvedValue({ enabled: false, audit: null });

    renderWithProviders(<TargetPanel projectId="p-target00001" />);
    await screen.findByTestId("target-benchmark-empty");
    expect(screen.queryByTestId("target-evidence-audit-section")).toBeNull();
  });

  it("flag on + 无结果 → 空态与执行按钮；点击触发真实 evaluate API", async () => {
    vi.mocked(projectsApi.getProject).mockResolvedValue(projectConfigured as never);
    vi.mocked(targetApi.getTargetBenchmark).mockResolvedValue(null);
    vi.mocked(targetApi.getTargetProfile).mockResolvedValue({ profile: null, fresh: null });
    vi.mocked(targetApi.getTargetReadiness).mockResolvedValue(null);
    vi.mocked(targetApi.getTargetEvidenceAudit).mockResolvedValue({ enabled: true, audit: null });
    vi.mocked(targetApi.evaluateTargetEvidenceAudit).mockResolvedValue({
      enabled: true,
      audit: { artifact: auditArtifact, meta: auditMeta, stale: false, currentManuscriptRevision: 1 },
    });

    renderWithProviders(<TargetPanel projectId="p-target00001" />);
    const runButton = await screen.findByTestId("target-evidence-audit-run");
    await userEvent.click(runButton);
    expect(await vi.waitFor(() => targetApi.evaluateTargetEvidenceAudit)).toHaveBeenCalledWith("p-target00001");
  });

  it("flag on + 有结果 → 逐贡献比较/先前工作身份/quote 回放标记/行动清单渲染；陈旧时警示", async () => {
    vi.mocked(projectsApi.getProject).mockResolvedValue(projectConfigured as never);
    vi.mocked(targetApi.getTargetBenchmark).mockResolvedValue(null);
    vi.mocked(targetApi.getTargetProfile).mockResolvedValue({ profile: null, fresh: null });
    vi.mocked(targetApi.getTargetReadiness).mockResolvedValue(null);
    vi.mocked(targetApi.getTargetEvidenceAudit).mockResolvedValue({
      enabled: true,
      audit: { artifact: auditArtifact, meta: auditMeta, stale: true, staleReason: "稿件内容已变更", currentManuscriptRevision: 2 },
    });

    renderWithProviders(<TargetPanel projectId="p-target00001" />);
    expect(await screen.findByTestId("target-evidence-audit-stale")).toBeTruthy();
    expect(screen.getByTestId("target-evidence-audit-contribution")).toBeTruthy();
    expect(screen.getByTestId("target-evidence-audit-contribution").textContent).toContain("We propose a hierarchical fusion module.");
    expect(screen.getByTestId("target-evidence-audit-contribution").textContent).toContain("Prior Work One");
    expect(screen.getByTestId("target-evidence-audit-contribution").textContent).toContain("quote 已回放");
    expect(screen.getByTestId("target-evidence-audit-contribution").textContent).toContain("差异可支持");
    const gapItems = screen.getAllByTestId("target-evidence-audit-gapitem");
    expect(gapItems.length).toBe(2);
    expect(gapItems[0]!.textContent).toContain("需真实实验/作者输入");
    expect(gapItems[0]!.textContent).toContain("Author Decision");
    expect(gapItems[1]!.textContent).toContain("可基于现有证据改写");
    expect(screen.getByTestId("target-evidence-audit-guards").textContent).toContain("priorQuoteReplayFailures=0");
  });
});
