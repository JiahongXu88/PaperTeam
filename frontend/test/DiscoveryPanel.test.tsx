import { afterEach, describe, expect, it, vi } from "vitest";
import { screen, waitFor } from "@testing-library/react";
import userEvent from "@testing-library/user-event";

import { DiscoveryPanel } from "../src/components/project/DiscoveryPanel.js";
import { ApiError } from "../src/api/client.js";
import type {
  AcademicSearchResponseView,
  WebSearchResponseView,
} from "../src/types/discovery.js";
import type {
  CandidatePromoteResult,
  CandidateSourceView,
} from "../src/types/sources.js";
import type {
  PlanExecutionEntryView,
  PlanExecutionResultView,
  ResearchCoverageView,
  ResearchGapListView,
  ResearchPlanListView,
  ResearchPlanView,
} from "../src/types/researchPlan.js";
import { renderWithProviders } from "./helpers.js";

/**
 * M7.1c Discovery UI（既有后端能力的前端消费）：
 * - 检索 payload（学术含年份范围 / Web 精简）与显式保存（saveAsCandidates 下标）
 * - 候选列表渲染（发现方式 / provider / 状态徽标 / provenance）
 * - Promote / Reject 调用既有幂等端点；loading / empty / error 状态
 *
 * M8.1：Research Plan 展示与受限编辑（GET/PUT /research/plan）。
 */

vi.mock("../src/api/discovery.js", () => ({
  academicSearch: vi.fn(),
  webSearch: vi.fn(),
  listCandidates: vi.fn(),
  promoteCandidate: vi.fn(),
  rejectCandidate: vi.fn(),
  // M9.2 默认「未配置」——需要可用态的用例自行覆盖
  getResearchProviders: vi.fn(async () => ({ academic: [], web: [] })),
}));

vi.mock("../src/api/researchPlan.js", () => ({
  getResearchPlan: vi.fn(async () => null),
  updateResearchPlan: vi.fn(),
  approveResearchPlan: vi.fn(),
  executeResearchPlan: vi.fn(),
  listResearchPlans: vi.fn(async () => ({ plans: [], activePlanId: null })),
  listExecutionHistory: vi.fn(async () => []),
  saveExecutionResultsAsCandidates: vi.fn(),
  deriveResearchPlan: vi.fn(),
  activateResearchPlan: vi.fn(),
  getResearchCoverage: vi.fn(async () => null),
  analyzeResearchCoverage: vi.fn(),
  listResearchGaps: vi.fn(async () => ({ planId: null, gaps: [] })),
  acceptResearchGap: vi.fn(),
  rejectResearchGap: vi.fn(),
  deriveResearchGap: vi.fn(),
}));

const api = vi.mocked(await import("../src/api/discovery.js"));
const planApi = vi.mocked(await import("../src/api/researchPlan.js"));

const NOW = "2026-09-19T08:00:00.000Z";

/** 学术 provider 健康快照（M9.2 可用性提示的 mock 数据） */
const openalexHealth = {
  provider: "openalex",
  state: "healthy" as const,
  circuit: "closed" as const,
  consecutiveFailures: 0,
};

function academicResponse(
  overrides: Partial<AcademicSearchResponseView> = {},
): AcademicSearchResponseView {
  return {
    status: "success",
    results: [
      {
        record: {
          provider: "openalex",
          recordId: "W1",
          title: "Transformers in Multi-Object Tracking",
          authors: ["Chen, Li"],
          year: 2023,
          venue: "CVPR",
          doi: "10.1000/mot",
          arxivId: "2301.00001",
        },
        citationCount: 42,
        openAccess: true,
        score: 0.0321,
        sources: [{ provider: "openalex", rank: 1 }],
      },
      {
        record: {
          provider: "semantic-scholar",
          recordId: "S2",
          title: "Track-by-Attention Survey",
          authors: ["Wang, Wei", "Zhao, Ming"],
          year: 2022,
        },
        score: 0.0156,
        sources: [{ provider: "semantic-scholar", rank: 2 }],
      },
    ],
    diagnostics: {
      providers: [
        { provider: "openalex", outcome: "ok", resultCount: 1 },
        { provider: "semantic-scholar", outcome: "ok", resultCount: 1 },
      ],
      rawResultCount: 2,
      fusedResultCount: 2,
    },
    ...overrides,
  };
}

function webResponse(): WebSearchResponseView {
  return {
    status: "success",
    results: [
      {
        url: "https://arxiv.org/abs/2301.00001",
        title: "MOT Benchmark Page",
        snippet: "Official benchmark of multi-object tracking.",
        engines: ["google", "bing"],
        score: 1.5,
        rank: 1,
        provider: "searxng",
      },
    ],
    diagnostics: {
      providers: [{ provider: "searxng", outcome: "ok", resultCount: 1 }],
      rawResultCount: 1,
      fusedResultCount: 1,
    },
  };
}

function candidateView(overrides: Partial<CandidateSourceView> = {}): CandidateSourceView {
  return {
    candidateId: "C001",
    origin: "academic_search",
    provider: "openalex",
    title: "Transformers in Multi-Object Tracking",
    authors: ["Chen, Li"],
    year: 2023,
    venue: "CVPR",
    doi: "10.1000/mot",
    query: "transformer multi-object tracking",
    status: "pending_review",
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

function promoteResult(candidate: CandidateSourceView): CandidatePromoteResult {
  return {
    source: {
      sourceId: "S001",
      sourceRole: "both",
      origin: "AGENT_RETRIEVED",
      status: "metadata_only",
      preferred: false,
      metadata: { title: candidate.title, doi: candidate.doi },
      bytes: 0,
      createdAt: NOW,
      updatedAt: NOW,
    },
    created: true,
    candidate: { ...candidate, status: "accepted", promotedSourceId: "S001" },
  };
}

afterEach(() => {
  vi.clearAllMocks();
});

async function renderPanel(candidates: CandidateSourceView[] = [], topic?: string) {
  api.listCandidates.mockResolvedValue(candidates);
  renderWithProviders(
    <DiscoveryPanel projectId="p-1" {...(topic !== undefined ? { topic } : {})} />,
    { route: "/projects/p-1?tab=discovery" },
  );
  await screen.findByText("候选文献");
  // 等 query 真正 settle（loading 态下 section 标题与「0 条」也会渲染）
  if (candidates.length === 0) {
    await screen.findByText(/还没有候选/);
  } else {
    await screen.findByText(`${candidates.length} 条`);
  }
}

function planView(overrides: Partial<ResearchPlanView> = {}): ResearchPlanView {
  return {
    planId: "rp-plan00000001",
    status: "draft",
    questions: ["Transformer MOT 的发展历史", "当前 SOTA 方法", "效率局限"],
    queries: [
      {
        queryId: "q-1",
        query: "Transformer MOT survey",
        kind: "academic",
        rationale: "Understand evolution",
        expectedCoverage: "近三年综述",
        status: "planned",
      },
      {
        queryId: "q-2",
        query: "real-time transformer tracking",
        kind: "web",
        rationale: "Find efficiency optimization",
        status: "executed",
        resultCount: 5,
      },
    ],
    createdAt: NOW,
    updatedAt: NOW,
    ...overrides,
  };
}

async function renderPanelWithPlan(
  plan: ResearchPlanView | null,
  candidates: CandidateSourceView[] = [],
) {
  planApi.getResearchPlan.mockResolvedValue(plan);
  await renderPanel(candidates, "Transformer MOT");
  if (plan !== null) {
    await screen.findByTestId("plan-queries");
  } else {
    await screen.findByTestId("research-plan-empty");
  }
}

async function runSearch(user: ReturnType<typeof userEvent.setup>) {
  api.academicSearch.mockResolvedValue(academicResponse());
  await user.type(screen.getByLabelText("研究问题"), "transformer multi-object tracking");
  await user.type(screen.getByLabelText(/年份范围/), "2020");
  await user.type(screen.getByLabelText("结束年份"), "2024");
  await user.click(screen.getByRole("button", { name: "检索" }));
}

describe("DiscoveryPanel（M7.1c Discovery 候选 UI）", () => {
  it("空候选 → 检索表单与引导文案齐全；候选列表为空态", async () => {
    await renderPanel([]);

    expect(screen.getByText("研究检索")).toBeTruthy();
    expect(screen.getByRole("button", { name: "学术检索" })).toBeTruthy();
    expect(screen.getByRole("button", { name: "Web 检索" })).toBeTruthy();
    expect(await screen.findByText(/还没有候选/)).toBeTruthy();
    for (const label of ["全部", "待审", "已接受", "已拒绝"]) {
      expect(screen.getByRole("button", { name: label })).toBeTruthy();
    }
  });

  it("学术检索：payload 携带 query 与年份范围（默认不持久化）", async () => {
    await renderPanel([]);
    const user = userEvent.setup();
    await runSearch(user);

    await waitFor(() => expect(api.academicSearch).toHaveBeenCalledTimes(1));
    expect(api.academicSearch).toHaveBeenCalledWith("p-1", {
      query: "transformer multi-object tracking",
      yearFrom: 2020,
      yearTo: 2024,
    });
    expect(await screen.findByText("Transformers in Multi-Object Tracking")).toBeTruthy();
    expect(screen.getByText("Track-by-Attention Survey")).toBeTruthy();
  });

  it("勾选检索结果 → 保存选中：同参数二次调用并携带 saveAsCandidates 下标", async () => {
    await renderPanel([]);
    const user = userEvent.setup();
    await runSearch(user);
    expect(await screen.findByText("Transformers in Multi-Object Tracking")).toBeTruthy();

    await user.click(screen.getByLabelText("选择结果 1"));
    const savedResponse = academicResponse({
      saved: { saved: [candidateView()], mergedExisting: [1] },
    });
    api.academicSearch.mockResolvedValue(savedResponse);
    await user.click(screen.getByTestId("save-candidates"));

    await waitFor(() => expect(api.academicSearch).toHaveBeenCalledTimes(2));
    expect(api.academicSearch).toHaveBeenLastCalledWith("p-1", {
      query: "transformer multi-object tracking",
      yearFrom: 2020,
      yearTo: 2024,
      saveAsCandidates: [0],
    });
    expect(await screen.findByText(/已保存 1 条候选/)).toBeTruthy();
  });

  it("本地校验：年份区间颠倒 → 提示且不发起请求", async () => {
    await renderPanel([]);
    const user = userEvent.setup();
    api.academicSearch.mockResolvedValue(academicResponse());
    await user.type(screen.getByLabelText("研究问题"), "tracking");
    await user.type(screen.getByLabelText(/年份范围/), "2024");
    await user.type(screen.getByLabelText("结束年份"), "2020");
    await user.click(screen.getByRole("button", { name: "检索" }));

    expect(await screen.findByText(/起始年份不能晚于结束年份/)).toBeTruthy();
    expect(api.academicSearch).not.toHaveBeenCalled();
  });

  it("Web 模式：payload 只含 query", async () => {
    await renderPanel([]);
    const user = userEvent.setup();
    api.webSearch.mockResolvedValue(webResponse());
    await user.click(screen.getByRole("button", { name: "Web 检索" }));
    await user.type(screen.getByLabelText("研究问题"), "mot benchmark");
    await user.click(screen.getByRole("button", { name: "检索" }));

    await waitFor(() => expect(api.webSearch).toHaveBeenCalledTimes(1));
    expect(api.webSearch).toHaveBeenCalledWith("p-1", { query: "mot benchmark" });
    expect(await screen.findByText("MOT Benchmark Page")).toBeTruthy();
  });

  it("M9.2 SearXNG 未配置：Web 页签显示明确提示（学术页签不显示）", async () => {
    api.getResearchProviders.mockResolvedValue({ academic: [openalexHealth], web: [] });
    await renderPanel([]);
    const user = userEvent.setup();

    // 默认学术页签：不显示 Web 可用性提示
    expect(screen.queryByTestId("web-search-unavailable")).toBeNull();

    await user.click(screen.getByRole("button", { name: "Web 检索" }));
    const notice = await screen.findByTestId("web-search-unavailable");
    expect(notice.textContent).toContain("未配置 SearXNG");
    expect(notice.textContent).toContain("学术检索不受影响");
    expect(screen.queryByTestId("web-search-status")).toBeNull();
  });

  it("M9.2 SearXNG 已配置：显示可用状态（含 provider 名与状态），不显示警告", async () => {
    api.getResearchProviders.mockResolvedValue({
      academic: [openalexHealth],
      web: [
        {
          provider: "searxng",
          state: "healthy",
          circuit: "closed",
          consecutiveFailures: 0,
        },
      ],
    });
    await renderPanel([]);
    await userEvent.setup().click(screen.getByRole("button", { name: "Web 检索" }));

    const status = await screen.findByTestId("web-search-status");
    expect(status.textContent).toContain("searxng");
    expect(status.textContent).toContain("可用");
    expect(screen.queryByTestId("web-search-unavailable")).toBeNull();
  });

  it("M9.2 provider 健康查询失败：可用性提示静默（不误报不可用、不阻塞检索）", async () => {
    api.getResearchProviders.mockRejectedValue(new Error("network down"));
    await renderPanel([]);
    await userEvent.setup().click(screen.getByRole("button", { name: "Web 检索" }));

    await waitFor(() => expect(api.getResearchProviders).toHaveBeenCalled());
    expect(screen.queryByTestId("web-search-unavailable")).toBeNull();
    expect(screen.queryByTestId("web-search-status")).toBeNull();
    expect(screen.getByLabelText("研究问题")).toBeTruthy();
  });

  it("候选列表渲染：标题 / 元数据 / 发现方式 / provider / 状态徽标 / 检索词", async () => {
    await renderPanel([
      candidateView(),
      candidateView({
        candidateId: "C002",
        origin: "web_search",
        provider: "searxng",
        title: "MOT Benchmark Page",
        authors: undefined,
        year: undefined,
        venue: undefined,
        doi: undefined,
        url: "https://arxiv.org/abs/2301.00001",
        status: "rejected",
      }),
      candidateView({
        candidateId: "C003",
        title: "Accepted Paper",
        status: "accepted",
        promotedSourceId: "S009",
      }),
    ]);

    expect(await screen.findByText("Transformers in Multi-Object Tracking")).toBeTruthy();
    expect(screen.getByText("MOT Benchmark Page")).toBeTruthy();
    // 「学术检索 / Web 检索 / 状态标签」与检索模式按钮、筛选按钮同名 → 按钮 + 徽标同时在场
    expect(screen.getAllByText("学术检索").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("Web 检索").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("待审").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("已拒绝").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("已接受").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText("→ S009")).toBeTruthy();
    expect(screen.getAllByText(/检索词：transformer multi-object tracking/).length).toBe(3);
    expect(screen.getAllByText("openalex").length).toBe(2);
    expect(screen.getByText("searxng")).toBeTruthy();
    expect(await screen.findByText("3 条")).toBeTruthy();
  });

  it("状态筛选：点击「待审」→ listCandidates 带 status=pending_review", async () => {
    await renderPanel([]);

    await userEvent.setup().click(screen.getByRole("button", { name: "待审" }));
    await waitFor(() => {
      const call = api.listCandidates.mock.calls.at(-1);
      expect(call?.[0]).toBe("p-1");
      expect(call?.[1]).toBe("pending_review");
    });
  });

  it("Promote：勾选候选 → 逐个调用既有 promote 端点并携带入库角色", async () => {
    const first = candidateView();
    const second = candidateView({ candidateId: "C002", title: "Second Paper" });
    await renderPanel([first, second]);
    api.promoteCandidate.mockImplementation(async (_projectId, candidateId) =>
      promoteResult(candidateId === "C001" ? first : second),
    );
    const user = userEvent.setup();

    await user.click(screen.getByLabelText("选择候选 C001"));
    await user.click(screen.getByLabelText("选择候选 C002"));
    await user.selectOptions(screen.getByLabelText("入库角色"), "evidence");
    await user.click(screen.getByTestId("promote-candidates"));

    await waitFor(() => expect(api.promoteCandidate).toHaveBeenCalledTimes(2));
    expect(api.promoteCandidate).toHaveBeenCalledWith("p-1", "C001", { sourceRole: "evidence" });
    expect(api.promoteCandidate).toHaveBeenCalledWith("p-1", "C002", { sourceRole: "evidence" });
    expect(await screen.findByText(/已接受 2 条候选并导入文献库/)).toBeTruthy();
  });

  it("Reject：勾选候选 → 调用既有 reject 端点", async () => {
    const candidate = candidateView();
    await renderPanel([candidate]);
    api.rejectCandidate.mockResolvedValue({ ...candidate, status: "rejected" });
    const user = userEvent.setup();

    await user.click(screen.getByLabelText("选择候选 C001"));
    await user.click(screen.getByTestId("reject-candidates"));

    await waitFor(() => expect(api.rejectCandidate).toHaveBeenCalledTimes(1));
    expect(api.rejectCandidate).toHaveBeenCalledWith("p-1", "C001");
    expect(await screen.findByText(/已拒绝 1 条候选/)).toBeTruthy();
  });

  it("错误状态：检索失败与候选加载失败如实呈现（含重试）", async () => {
    api.listCandidates.mockRejectedValue(new Error("boom"));
    renderWithProviders(<DiscoveryPanel projectId="p-1" />, { route: "/projects/p-1?tab=discovery" });
    expect(await screen.findByText("候选加载失败")).toBeTruthy();
    expect(screen.getByText("boom")).toBeTruthy();

    api.listCandidates.mockResolvedValue([]);
    await userEvent.setup().click(screen.getByRole("button", { name: "重试" }));
    await screen.findByText(/还没有候选/);

    api.academicSearch.mockRejectedValue(new Error("SEARCH_PROVIDER_NOT_CONFIGURED"));
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("研究问题"), "tracking");
    await user.click(screen.getByRole("button", { name: "检索" }));
    expect(await screen.findByText("学术检索失败")).toBeTruthy();
  });

  it("M8.5 候选数据损坏：标题与文案明确「损坏 ≠ 没有候选」（CANDIDATE_STORE_CORRUPTED）", async () => {
    api.listCandidates.mockRejectedValue(
      new ApiError(
        500,
        "CANDIDATE_STORE_CORRUPTED",
        "候选文献数据损坏（p-1/sources/candidates.json 不是合法 JSON）：这不是「没有候选论文」",
      ),
    );
    renderWithProviders(<DiscoveryPanel projectId="p-1" />, { route: "/projects/p-1?tab=discovery" });

    expect(await screen.findByText("候选数据损坏（不是没有候选论文）")).toBeTruthy();
    expect(screen.getByText(/不是「没有候选论文」/)).toBeTruthy();
    expect(screen.queryByText(/还没有候选/)).toBeNull();
  });

  it("partial 检索：如实提示部分源失败", async () => {
    await renderPanel([]);
    api.academicSearch.mockResolvedValue(academicResponse({ status: "partial" }));
    const user = userEvent.setup();
    await user.type(screen.getByLabelText("研究问题"), "tracking");
    await user.click(screen.getByRole("button", { name: "检索" }));

    expect(await screen.findByText(/部分检索源失败/)).toBeTruthy();
  });
});

describe("DiscoveryPanel（M9.1 Execution Snapshot → Candidate HITL）", () => {
  /** 带 resultSnapshot 的成功条目（学术 Top-2 投影） */
  function snapshotEntry(): PlanExecutionEntryView {
    return {
      executionId: "exec-snap000001",
      queryId: "q-1",
      query: "multi-agent scientific research",
      kind: "academic",
      timestamp: NOW,
      status: "executed",
      planId: "rp-1",
      resultCount: 2,
      providers: [{ provider: "openalex", outcome: "ok", resultCount: 2 }],
      resultIdentifiers: ["doi:10.1000/mot"],
      resultSnapshot: [
        {
          kind: "academic",
          provider: "openalex",
          title: "Multi-Agent Systems Survey",
          authors: ["Alice Chen"],
          year: 2023,
          doi: "10.1000/mot",
          snippetPreview: "A survey of multi-agent architectures.",
          citationCount: 42,
          score: 0.016,
        },
        {
          kind: "academic",
          provider: "openalex",
          title: "LLM Agents Retrospective",
          year: 2024,
          doi: "10.1000/retro",
          snippetPreview: "Retrospective on LLM agents.",
        },
      ],
    };
  }

  it("执行结果快照展示：provider / 年份 / DOI / 预览可见；无快照的旧条目不渲染勾选列表", async () => {
    planApi.listExecutionHistory.mockResolvedValue([
      snapshotEntry(),
      {
        // M8.5 及更早形态：executed 但只有 identifiers、无 resultSnapshot
        executionId: "exec-m85old0001",
        queryId: "q-old",
        query: "old query",
        kind: "academic",
        timestamp: NOW,
        status: "executed",
        resultCount: 3,
        resultIdentifiers: ["doi:10.1/old"],
      },
    ]);
    await renderPanelWithPlan(planView());

    const results = await screen.findByTestId("execution-snapshot-results");
    expect(results.textContent).toContain("Multi-Agent Systems Survey");
    expect(results.textContent).toContain("openalex");
    expect(results.textContent).toContain("10.1000/mot");
    expect(results.textContent).toContain("A survey of multi-agent architectures.");
    // 快照区内两条结果；旧条目无快照 → 整个面板只有一个快照列表
    expect(screen.getAllByTestId("execution-snapshot")).toHaveLength(1);
    expect(screen.getAllByTestId(/snapshot-check-\d+/)).toHaveLength(2);
  });

  it("勾选两条快照 → 保存为候选：payload（executionId / queryId / 下标）正确，成功反馈后清空选择", async () => {
    planApi.listExecutionHistory.mockResolvedValue([snapshotEntry()]);
    await renderPanelWithPlan(planView());
    const user = userEvent.setup();

    const saveButton = await screen.findByTestId("save-snapshot-candidates");
    expect(saveButton.hasAttribute("disabled")).toBe(true); // 未勾选时禁用
    await user.click(screen.getByTestId("snapshot-check-0"));
    await user.click(screen.getByTestId("snapshot-check-1"));

    planApi.saveExecutionResultsAsCandidates.mockResolvedValue({
      saved: [{ candidateId: "C001" }, { candidateId: "C002" }],
      mergedExisting: [],
    });
    await user.click(screen.getByTestId("save-snapshot-candidates"));

    await waitFor(() =>
      expect(planApi.saveExecutionResultsAsCandidates).toHaveBeenCalledWith("p-1", {
        executionId: "exec-snap000001",
        queryId: "q-1",
        saveAsCandidates: [0, 1],
      }),
    );
    expect((await screen.findByTestId("save-snapshot-note")).textContent).toContain("已保存 2 条候选");
    expect((screen.getByTestId("snapshot-check-0") as HTMLInputElement).checked).toBe(false); // 成功后清空选择
  });

  it("合并反馈：同身份待审候选合并补充而非重复创建（mergedExisting 呈现）", async () => {
    planApi.listExecutionHistory.mockResolvedValue([snapshotEntry()]);
    await renderPanelWithPlan(planView());
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("snapshot-check-0"));
    planApi.saveExecutionResultsAsCandidates.mockResolvedValue({
      saved: [],
      mergedExisting: [0],
    });
    await user.click(screen.getByTestId("save-snapshot-candidates"));

    const note = await screen.findByTestId("save-snapshot-note");
    expect(note.textContent).toContain("已保存 0 条候选");
    expect(note.textContent).toContain("1 条与既有待审候选同身份，已合并补充");
  });

  it("保存失败：结构化错误呈现，不崩溃", async () => {
    planApi.listExecutionHistory.mockResolvedValue([snapshotEntry()]);
    await renderPanelWithPlan(planView());
    const user = userEvent.setup();

    await user.click(await screen.findByTestId("snapshot-check-0"));
    planApi.saveExecutionResultsAsCandidates.mockRejectedValue(
      new ApiError(409, "EXECUTION_RESULTS_UNAVAILABLE", "该执行记录没有可保存的结果快照"),
    );
    await user.click(screen.getByTestId("save-snapshot-candidates"));

    expect(await screen.findByText(/保存失败：/)).toBeTruthy();
  });

  it("M9.2 Web 快照展示：engines / publishedDate audit 字段可见（与学术快照同行渲染）", async () => {
    planApi.listExecutionHistory.mockResolvedValue([
      {
        executionId: "exec-web00000001",
        queryId: "q-web",
        query: "deep research agent products",
        kind: "web" as const,
        timestamp: NOW,
        status: "executed" as const,
        planId: "rp-1",
        resultCount: 1,
        providers: [{ provider: "searxng", outcome: "ok", resultCount: 1 }],
        resultSnapshot: [
          {
            kind: "web" as const,
            provider: "searxng",
            url: "https://openai.com/deep-research",
            title: "OpenAI Deep Research",
            snippetPreview: "Official product page.",
            score: 4.5,
            engines: ["bing", "baidu"],
            publishedDate: "2025-02-24T00:00:00Z",
          },
        ],
      },
    ]);
    await renderPanelWithPlan(planView());

    const results = await screen.findByTestId("execution-snapshot-results");
    expect(results.textContent).toContain("OpenAI Deep Research");
    expect(results.textContent).toContain("searxng");
    expect(results.textContent).toContain("2 引擎");
    expect(results.textContent).toContain("2025-02-24");
  });
});

describe("DiscoveryPanel（M8.1 Research Plan 展示与编辑）", () => {
  it("无计划：空态引导（先运行调研），不渲染编辑按钮", async () => {
    await renderPanelWithPlan(null);

    expect(screen.getByText("Research Plan")).toBeTruthy();
    expect(screen.getByTestId("research-plan-empty")).toBeTruthy();
    expect(screen.queryByRole("button", { name: "编辑" })).toBeNull();
  });

  it("有计划：Topic / Questions / Queries（理由 / 期望覆盖 / 执行结果数）齐全", async () => {
    await renderPanelWithPlan(planView());

    expect(screen.getByText("Transformer MOT")).toBeTruthy(); // topic prop
    expect(screen.getAllByText(/发展历史/).length).toBeGreaterThanOrEqual(1);
    expect(screen.getByText("Transformer MOT survey")).toBeTruthy();
    expect(screen.getByText("real-time transformer tracking")).toBeTruthy();
    expect(screen.getByText("理由：Understand evolution")).toBeTruthy();
    expect(screen.getByText("理由：Find efficiency optimization")).toBeTruthy();
    expect(screen.getByText("期望覆盖：近三年综述")).toBeTruthy();
    expect(screen.getByText("5 条结果")).toBeTruthy();
    expect(screen.getByText("草稿")).toBeTruthy();
  });

  it("M8.5 执行审计：executionHistory 展开（provider 参与 / 结果数 / 失败原因 / 标识留存）", async () => {
    planApi.listExecutionHistory.mockResolvedValue([
      {
        executionId: "exec-abc123",
        queryId: "q-1",
        query: "Transformer MOT survey",
        kind: "academic",
        timestamp: NOW,
        status: "executed",
        planId: "rp-1",
        resultCount: 2,
        providers: [{ provider: "openalex", outcome: "ok", resultCount: 2, latencyMs: 120 }],
        resultIdentifiers: ["doi:10.1000/mot", "arxiv:2301.00001"],
      },
      {
        executionId: "exec-abc123",
        queryId: "q-2",
        query: "real-time tracking",
        kind: "web",
        timestamp: NOW,
        status: "failed",
        planId: "rp-1",
        error: "Web Search 未配置",
      },
    ]);
    await renderPanelWithPlan(planView());

    const audit = await screen.findByTestId("execution-audit");
    expect(audit.textContent).toContain("执行审计（2 条记录");
    // 成功条目：结果数 + provider 参与摘要 + 标识留存提示（title 悬停含标识符）
    expect(audit.textContent).toContain("2 条结果");
    expect(audit.textContent).toContain("检索源：openalex 2 条");
    const identifiers = screen.getByTestId("execution-audit-identifiers");
    expect(identifiers.getAttribute("title")).toContain("doi:10.1000/mot");
    // 失败条目：失败原因如实展示
    expect(audit.textContent).toContain("失败 —— Web Search 未配置");
  });

  it("M8.5 执行审计：无历史时收起（不渲染空块）", async () => {
    planApi.listExecutionHistory.mockResolvedValue([]);
    await renderPanelWithPlan(planView());
    await screen.findByTestId("plan-queries");
    expect(screen.queryByTestId("execution-audit")).toBeNull();
  });
  it("编辑保存：改问题 + 改检索词与状态 + 增删条目 → PUT 受限字段 payload", async () => {
    await renderPanelWithPlan(planView());
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "编辑" }));
    const questions = screen.getByLabelText("研究问题（每行一个）");
    await user.clear(questions);
    await user.type(questions, "改后的问题一\n改后的问题二");
    await user.clear(screen.getByLabelText("检索词 1"));
    await user.type(screen.getByLabelText("检索词 1"), "end-to-end MOT survey");
    await user.selectOptions(screen.getByLabelText("状态 1"), "skipped");
    await user.click(screen.getAllByRole("button", { name: "删除" })[1]!); // 删除第 2 条
    await user.click(screen.getByRole("button", { name: "添加检索" }));
    // 删除后新行占第 2 个位置（行内 aria-label 按位置编号）
    await user.type(screen.getByLabelText("检索词 2"), "mot occlusion");
    await user.type(screen.getByLabelText("理由 2"), "补遮挡线索");
    await user.selectOptions(screen.getByLabelText("检索方式 2"), "web");

    planApi.updateResearchPlan.mockResolvedValue(planView());
    await user.click(screen.getByRole("button", { name: "保存计划" }));

    await waitFor(() => expect(planApi.updateResearchPlan).toHaveBeenCalledTimes(1));
    expect(planApi.updateResearchPlan).toHaveBeenCalledWith("p-1", {
      questions: ["改后的问题一", "改后的问题二"],
      queries: [
        {
          queryId: "q-1",
          query: "end-to-end MOT survey",
          kind: "academic",
          rationale: "Understand evolution",
          status: "skipped",
        },
        { query: "mot occlusion", kind: "web", rationale: "补遮挡线索", status: "planned" },
      ],
    });
  });

  it("本地校验：检索词为空 → 提示且不发请求", async () => {
    await renderPanelWithPlan(planView());
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "编辑" }));
    await user.clear(screen.getByLabelText("检索词 1"));
    await user.click(screen.getByRole("button", { name: "保存计划" }));

    expect(await screen.findByText(/第 1 条检索词为空/)).toBeTruthy();
    expect(planApi.updateResearchPlan).not.toHaveBeenCalled();
  });
});

describe("DiscoveryPanel（M8.2 Research Plan Execution）", () => {
  function executionResult(
    overrides: Partial<PlanExecutionResultView> = {},
  ): PlanExecutionResultView {
    return {
      executionId: "exec-000000000001",
      totalQueries: 2,
      executedQueries: 2,
      failedQueries: 0,
      plan: planView({ status: "done" }),
      ...overrides,
    };
  }

  it("draft：展示「批准计划」（无执行按钮）；点击 → approve API 调用", async () => {
    await renderPanelWithPlan(planView()); // 默认 draft
    const user = userEvent.setup();

    expect(screen.getByTestId("plan-status").textContent).toBe("草稿");
    expect(screen.getByRole("button", { name: "批准计划" })).toBeTruthy();
    expect(screen.queryByTestId("execute-plan")).toBeNull();

    planApi.approveResearchPlan.mockResolvedValue(planView({ status: "approved" }));
    await user.click(screen.getByRole("button", { name: "批准计划" }));

    await waitFor(() => expect(planApi.approveResearchPlan).toHaveBeenCalledTimes(1));
    expect(planApi.approveResearchPlan).toHaveBeenCalledWith("p-1");
    expect(planApi.executeResearchPlan).not.toHaveBeenCalled();
  });

  it("approved：执行按钮 → 点击调用 execute API，成功后展示执行结果摘要", async () => {
    await renderPanelWithPlan(
      planView({ status: "approved", queries: [
        { queryId: "q-1", query: "Transformer MOT survey", kind: "academic", status: "planned" },
        { queryId: "q-2", query: "real-time transformer tracking", kind: "web", status: "planned" },
      ] }),
    );
    const user = userEvent.setup();

    expect(screen.getByTestId("plan-status").textContent).toBe("已批准");
    expect(screen.queryByRole("button", { name: "批准计划" })).toBeNull();

    planApi.executeResearchPlan.mockResolvedValue(
      executionResult({
        executedQueries: 1,
        failedQueries: 1,
        plan: planView({
          status: "done",
          queries: [
            { queryId: "q-1", query: "Transformer MOT survey", kind: "academic", status: "executed", resultCount: 25 },
            { queryId: "q-2", query: "real-time transformer tracking", kind: "web", status: "planned" },
          ],
        }),
      }),
    );
    await user.click(screen.getByTestId("execute-plan"));

    await waitFor(() => expect(planApi.executeResearchPlan).toHaveBeenCalledTimes(1));
    expect(planApi.executeResearchPlan).toHaveBeenCalledWith("p-1");
    expect(
      await screen.findByText(/计划执行完成：1 条检索成功、1 条失败/),
    ).toBeTruthy();
    expect(screen.getByText(/计划共 2 条/)).toBeTruthy();
  });

  it("执行后回填展示：executed 状态与结果数（Query / Status / Results）", async () => {
    await renderPanelWithPlan(
      planView({ status: "approved", queries: [
        { queryId: "q-1", query: "Transformer MOT survey", kind: "academic", status: "planned" },
      ] }),
    );
    const user = userEvent.setup();

    planApi.executeResearchPlan.mockResolvedValue(
      executionResult({
        totalQueries: 1,
        executedQueries: 1,
        plan: planView({
          status: "done",
          queries: [
            { queryId: "q-1", query: "Transformer MOT survey", kind: "academic", status: "executed", resultCount: 25 },
          ],
        }),
      }),
    );
    // execute 成功后 invalidate 触发重取：getResearchPlan 返回回填后的 plan
    planApi.getResearchPlan.mockResolvedValue(
      planView({
        status: "done",
        queries: [
          { queryId: "q-1", query: "Transformer MOT survey", kind: "academic", status: "executed", resultCount: 25 },
        ],
      }),
    );
    await user.click(screen.getByTestId("execute-plan"));

    expect(await screen.findByText("25 条结果")).toBeTruthy();
    expect(await screen.findByText("已执行")).toBeTruthy();
    expect(screen.getByTestId("plan-status").textContent).toBe("已完成");
  });

  it("done：不渲染批准 / 执行按钮，显示完成提示", async () => {
    await renderPanelWithPlan(planView({ status: "done" }));

    expect(screen.getByTestId("plan-status").textContent).toBe("已完成");
    expect(screen.queryByRole("button", { name: "批准计划" })).toBeNull();
    expect(screen.queryByTestId("execute-plan")).toBeNull();
    expect(screen.getByText(/本轮计划已执行完成/)).toBeTruthy();
  });

  it("执行失败：错误如实呈现（不吞 409）", async () => {
    await renderPanelWithPlan(
      planView({ status: "approved", queries: [
        { queryId: "q-1", query: "Transformer MOT survey", kind: "academic", status: "planned" },
      ] }),
    );
    const user = userEvent.setup();

    planApi.executeResearchPlan.mockRejectedValue(
      new Error("该计划正在执行中，禁止重复执行"),
    );
    await user.click(screen.getByTestId("execute-plan"));

    expect(await screen.findByText("计划执行失败")).toBeTruthy();
    expect(screen.getByText(/禁止重复执行/)).toBeTruthy();
  });
});

describe("DiscoveryPanel（M8.3.1 Research Plan Iteration）", () => {
  /** 两轮迭代链：v1 done（历史）+ v2 done（当前活动） */
  function iterationListView(): ResearchPlanListView {
    return {
      plans: [
        planView({
          planId: "rp-plan00000001",
          status: "done",
          iterationNumber: 1,
          iterationId: "it-iter00000001",
          questions: ["第一轮：Transformer MOT 的发展历史"],
          queries: [
            { queryId: "q-1", query: "Transformer MOT survey", kind: "academic", status: "executed", resultCount: 12 },
          ],
        }),
        planView({
          planId: "rp-plan00000002",
          status: "done",
          iterationNumber: 2,
          iterationId: "it-iter00000001",
          parentPlanId: "rp-plan00000001",
          questions: ["第二轮：遮挡场景身份保持"],
          queries: [
            { queryId: "q-1", query: "mot occlusion identity", kind: "academic", status: "planned" },
          ],
        }),
      ],
      activePlanId: "rp-plan00000002",
    };
  }

  async function renderPanelWithIterations() {
    planApi.listResearchPlans.mockResolvedValue(iterationListView());
    planApi.getResearchPlan.mockResolvedValue(
      planView({
        planId: "rp-plan00000002",
        status: "done",
        iterationNumber: 2,
        parentPlanId: "rp-plan00000001",
        questions: ["第二轮：遮挡场景身份保持"],
        queries: [
          { queryId: "q-1", query: "mot occlusion identity", kind: "academic", status: "planned" },
        ],
      }),
    );
    await renderPanel([], "Transformer MOT");
    await screen.findByTestId("plan-iterations");
  }

  it("迭代展示：v1 / v2 条目与当前标记；活动计划内容为主显示", async () => {
    await renderPanelWithIterations();

    expect(screen.getByText("v1 · 已完成")).toBeTruthy();
    expect(screen.getByText("v2 · 已完成（当前）")).toBeTruthy();
    // 主显示 = 当前活动计划（v2）的问题与检索
    expect(screen.getByText("第二轮：遮挡场景身份保持")).toBeTruthy();
    expect(screen.getByText("mot occlusion identity")).toBeTruthy();
    expect(screen.queryByText("第一轮：Transformer MOT 的发展历史")).toBeNull();
  });

  it("查看历史计划：点击 v1 → 历史提示 + 内容切换；编辑按钮禁用（只作用于当前）", async () => {
    await renderPanelWithIterations();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "v1 · 已完成" }));

    const note = await screen.findByTestId("plan-history-note");
    expect(note.textContent).toContain("正在查看历史计划 v1");
    expect(screen.getByText("第一轮：Transformer MOT 的发展历史")).toBeTruthy();
    expect(screen.getByText("Transformer MOT survey")).toBeTruthy(); // v1 的检索词
    expect(screen.queryByText("mot occlusion identity")).toBeNull();
    const editButton = screen.getByRole("button", { name: "编辑" }) as HTMLButtonElement;
    expect(editButton.disabled).toBe(true);
  });

  it("设为当前：查看历史时点击 → activate API 调用", async () => {
    await renderPanelWithIterations();
    const user = userEvent.setup();

    await user.click(screen.getByRole("button", { name: "v1 · 已完成" }));
    planApi.activateResearchPlan.mockResolvedValue(planView({ planId: "rp-plan00000001" }));
    await user.click(screen.getByTestId("activate-plan"));

    await waitFor(() => expect(planApi.activateResearchPlan).toHaveBeenCalledTimes(1));
    expect(planApi.activateResearchPlan).toHaveBeenCalledWith("p-1", "rp-plan00000001");
  });

  it("派生新计划：done 活动计划 → 点击调用 derive API；成功后失效重取", async () => {
    planApi.listResearchPlans.mockResolvedValue({ plans: [], activePlanId: null });
    planApi.getResearchPlan.mockResolvedValue(planView({ status: "done" }));
    await renderPanel([], "Transformer MOT");
    await screen.findByTestId("plan-queries");
    const user = userEvent.setup();

    const deriveButton = await screen.findByTestId("derive-plan");
    planApi.deriveResearchPlan.mockResolvedValue(planView({ status: "draft" }));
    // derive 成功后 invalidate 触发重取：getResearchPlan 返回新 draft
    planApi.getResearchPlan.mockResolvedValue(planView({ status: "draft", questions: ["派生后的新问题"] }));
    await user.click(deriveButton);

    await waitFor(() => expect(planApi.deriveResearchPlan).toHaveBeenCalledTimes(1));
    expect(planApi.deriveResearchPlan).toHaveBeenCalledWith("p-1", "rp-plan00000001", {});
    expect(await screen.findByText("派生后的新问题")).toBeTruthy();
  });

  it("派生失败：错误如实呈现（不吞 409）", async () => {
    planApi.listResearchPlans.mockResolvedValue({ plans: [], activePlanId: null });
    planApi.getResearchPlan.mockResolvedValue(planView({ status: "done" }));
    await renderPanel([], "Transformer MOT");
    await screen.findByTestId("plan-queries");
    const user = userEvent.setup();

    planApi.deriveResearchPlan.mockRejectedValue(
      new Error("只有已完成（done）的计划才能派生下一轮"),
    );
    await user.click(screen.getByTestId("derive-plan"));

    expect(await screen.findByText("派生计划失败")).toBeTruthy();
    expect(screen.getByText(/只有已完成/)).toBeTruthy();
  });
});

describe("DiscoveryPanel（M8.3.2 Research Coverage）", () => {
  function coverageView(overrides: Partial<ResearchCoverageView> = {}): ResearchCoverageView {
    return {
      planId: "rp-plan00000002",
      planStatus: "done",
      iterationNumber: 2,
      analyzedAt: NOW,
      questions: [
        {
          question: "Transformer tracking 的发展脉络",
          origin: "plan",
          coverage: "covered",
          relatedQueryCount: 1,
          executedQueryCount: 1,
          resultCount: 5,
          evidenceCount: 1,
          promotedCount: 0,
        },
        {
          question: "edge device 部署优化",
          origin: "plan",
          coverage: "partial",
          relatedQueryCount: 1,
          executedQueryCount: 1,
          resultCount: 3,
          evidenceCount: 0,
          promotedCount: 0,
          gap: "有 1 条检索带回 3 条结果，但尚无相关证据或已入库文献支撑（Candidate / Evidence 层未覆盖）",
        },
        {
          question: "遮挡场景身份保持",
          origin: "report",
          coverage: "missing",
          relatedQueryCount: 0,
          executedQueryCount: 0,
          resultCount: 0,
          evidenceCount: 0,
          promotedCount: 0,
          gap: "计划中没有任何与该问题相关的检索（建议围绕问题原文制定检索词）",
        },
      ],
      overall: {
        questionCount: 3,
        covered: 1,
        partial: 1,
        missing: 1,
        summary: "研究问题 3 个：covered 1 · partial 1 · missing 1；缺口 3 项",
      },
      // M8.3.3：coverage.gaps 升级为 ResearchGap[]（gapId / severity / proposed）
      gaps: [
        {
          gapId: "gap-aaaaaaaaaaaa",
          planId: "rp-plan00000002",
          question: "edge device 部署优化",
          description: "有 1 条检索带回 3 条结果，但尚无相关证据或已入库文献支撑（Candidate / Evidence 层未覆盖）",
          severity: "low",
          suggestedQueries: ["edge device 部署优化"],
          status: "proposed",
          createdAt: NOW,
        },
        {
          gapId: "gap-bbbbbbbbbbbb",
          planId: "rp-plan00000002",
          question: "遮挡场景身份保持",
          description: "计划中没有任何与该问题相关的检索（建议围绕问题原文制定检索词）",
          severity: "high",
          suggestedQueries: ["遮挡场景身份保持"],
          status: "proposed",
          createdAt: NOW,
        },
        {
          gapId: "gap-cccccccccccc",
          planId: "rp-plan00000002",
          description: "调研报告登记的残差文献方向：低照度场景数据集",
          severity: "medium",
          suggestedQueries: ["低照度场景数据集"],
          status: "proposed",
          createdAt: NOW,
        },
      ],
      ...overrides,
    };
  }

  it("无报告：空态引导；分析按钮存在（未点击不请求 analyze）", async () => {
    await renderPanel([]);

    expect(screen.getByTestId("coverage-section")).toBeTruthy();
    expect(screen.getByTestId("coverage-empty")).toBeTruthy();
    expect(screen.getByTestId("analyze-coverage")).toBeTruthy();
    expect(planApi.analyzeResearchCoverage).not.toHaveBeenCalled();
  });

  it("点击「分析覆盖」→ analyze API 调用；问题状态 / 计数如实渲染 + 缺口入口指引", async () => {
    await renderPanel([]);
    const user = userEvent.setup();

    planApi.analyzeResearchCoverage.mockResolvedValue(coverageView());
    await user.click(screen.getByTestId("analyze-coverage"));

    await waitFor(() => expect(planApi.analyzeResearchCoverage).toHaveBeenCalledTimes(1));
    expect(planApi.analyzeResearchCoverage).toHaveBeenCalledWith("p-1");
    expect(await screen.findByTestId("coverage-questions")).toBeTruthy();
    // 三态徽标 + 来源标注 + 覆盖计数
    expect(screen.getByText("已覆盖")).toBeTruthy();
    expect(screen.getByText("部分覆盖")).toBeTruthy();
    expect(screen.getByText("未覆盖")).toBeTruthy();
    expect(screen.getAllByText("计划问题").length).toBe(2);
    expect(screen.getByText("报告问题")).toBeTruthy();
    expect(screen.getAllByText(/关联检索 1/).length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/证据 1/)).toBeTruthy();
    expect(screen.getByText(/缺口：计划中没有任何与该问题相关的检索/)).toBeTruthy();
    // 汇总 + M8.3.3 缺口入口指引（确认与派生在 Research Gaps 区域）
    expect(screen.getByTestId("coverage-summary").textContent).toContain(
      "covered 1 · partial 1 · missing 1；缺口 3 项",
    );
    expect(screen.getByText(/检出 3 项研究缺口/)).toBeTruthy();
  });

  it("GET 派生视图自动加载：getResearchCoverage 返回报告 → 不点击也展示", async () => {
    planApi.getResearchCoverage.mockResolvedValue(coverageView());
    await renderPanel([]);

    expect(await screen.findByTestId("coverage-questions")).toBeTruthy();
    expect(planApi.analyzeResearchCoverage).not.toHaveBeenCalled();
  });

  it("分析失败：错误如实呈现（不吞 404）", async () => {
    await renderPanel([]);
    const user = userEvent.setup();

    planApi.analyzeResearchCoverage.mockRejectedValue(
      new Error("项目还没有调研结果（research/research.json 不存在），请先运行调研再分析覆盖"),
    );
    await user.click(screen.getByTestId("analyze-coverage"));

    expect(await screen.findByText("覆盖分析失败")).toBeTruthy();
    expect(screen.getByText(/请先运行调研再分析覆盖/)).toBeTruthy();
  });
});

describe("DiscoveryPanel（M8.3.3 Research Gaps HITL）", () => {
  function gapListView(overrides: Partial<ResearchGapListView> = {}): ResearchGapListView {
    return {
      planId: "rp-plan00000002",
      gaps: [
        {
          gapId: "gap-aaaaaaaaaaaa",
          planId: "rp-plan00000002",
          question: "遮挡场景身份保持",
          description: "计划中没有任何与该问题相关的检索（建议围绕问题原文制定检索词）",
          severity: "high",
          suggestedQueries: ["遮挡场景身份保持"],
          status: "proposed",
          createdAt: NOW,
        },
        {
          gapId: "gap-bbbbbbbbbbbb",
          planId: "rp-plan00000002",
          question: "edge device 部署优化",
          description: "有 1 条检索带回 3 条结果，但尚无相关证据或已入库文献支撑（Candidate / Evidence 层未覆盖）",
          severity: "low",
          suggestedQueries: ["edge device 部署优化"],
          status: "accepted",
          createdAt: NOW,
          decidedAt: NOW,
        },
        {
          gapId: "gap-cccccccccccc",
          planId: "rp-plan00000002",
          description: "调研报告登记的残差文献方向：低照度场景数据集",
          severity: "medium",
          suggestedQueries: ["低照度场景数据集"],
          status: "rejected",
          createdAt: NOW,
          decidedAt: NOW,
        },
      ],
      ...overrides,
    };
  }

  async function renderPanelWithGaps(
    list: ResearchGapListView,
    activeStatus: "done" | "draft" = "done",
  ) {
    planApi.listResearchGaps.mockResolvedValue(list);
    planApi.listResearchPlans.mockResolvedValue({
      plans: [planView({ planId: "rp-plan00000002", status: activeStatus, iterationNumber: 2 })],
      activePlanId: "rp-plan00000002",
    });
    planApi.getResearchPlan.mockResolvedValue(
      planView({ planId: "rp-plan00000002", status: activeStatus }),
    );
    await renderPanel([], "Transformer MOT");
    await screen.findByTestId("research-gap-list");
  }

  it("无缺口：空态引导（先分析覆盖）", async () => {
    await renderPanel([]);

    expect(screen.getByTestId("research-gaps-section")).toBeTruthy();
    expect(screen.getByTestId("research-gaps-empty")).toBeTruthy();
  });

  it("缺口渲染：严重度 / 状态徽标 + 建议检索 + gapId；rejected 无操作", async () => {
    await renderPanelWithGaps(gapListView());

    const rows = screen.getAllByTestId("research-gap-row");
    expect(rows).toHaveLength(3);
    expect(screen.getByText("严重度 高")).toBeTruthy();
    expect(screen.getByText("严重度 中")).toBeTruthy();
    expect(screen.getByText("严重度 低")).toBeTruthy();
    expect(screen.getByText("待确认")).toBeTruthy();
    // 「已接受 / 已拒绝」与候选筛选按钮同名 → 徽标与按钮同时在场
    expect(screen.getAllByText("已接受").length).toBeGreaterThanOrEqual(2);
    expect(screen.getAllByText("已拒绝").length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText(/建议检索：遮挡场景身份保持/)).toBeTruthy();
    expect(screen.getByText(/建议检索：低照度场景数据集/)).toBeTruthy();
    expect(screen.getByText("gap-aaaaaaaaaaaa")).toBeTruthy();
    expect(screen.getByText(/已拒绝（不参与下一轮派生）/)).toBeTruthy();
    // proposed 缺口有 Accept/Reject；accepted 有派生；rejected 无任何操作按钮
    expect(screen.getAllByTestId("accept-gap")).toHaveLength(1);
    expect(screen.getAllByTestId("reject-gap")).toHaveLength(1);
    expect(screen.getAllByTestId("derive-from-gap")).toHaveLength(1);
  });

  it("接受缺口：proposed → acceptResearchGap 调用（p-1, gapId）", async () => {
    await renderPanelWithGaps(gapListView());
    const user = userEvent.setup();

    planApi.acceptResearchGap.mockResolvedValue({
      ...gapListView().gaps[0]!,
      status: "accepted",
      decidedAt: NOW,
    });
    await user.click(screen.getByTestId("accept-gap"));

    await waitFor(() => expect(planApi.acceptResearchGap).toHaveBeenCalledTimes(1));
    expect(planApi.acceptResearchGap).toHaveBeenCalledWith("p-1", "gap-aaaaaaaaaaaa");
  });

  it("拒绝缺口：proposed → rejectResearchGap 调用（p-1, gapId）", async () => {
    await renderPanelWithGaps(gapListView());
    const user = userEvent.setup();

    planApi.rejectResearchGap.mockResolvedValue({
      ...gapListView().gaps[0]!,
      status: "rejected",
      decidedAt: NOW,
    });
    await user.click(screen.getByTestId("reject-gap"));

    await waitFor(() => expect(planApi.rejectResearchGap).toHaveBeenCalledTimes(1));
    expect(planApi.rejectResearchGap).toHaveBeenCalledWith("p-1", "gap-aaaaaaaaaaaa");
  });

  it("由此派生下一轮：accepted 缺口 + done 活动计划 → deriveResearchGap 调用", async () => {
    await renderPanelWithGaps(gapListView());
    const user = userEvent.setup();

    planApi.deriveResearchGap.mockResolvedValue(planView({ status: "draft" }));
    await user.click(screen.getByTestId("derive-from-gap"));

    await waitFor(() => expect(planApi.deriveResearchGap).toHaveBeenCalledTimes(1));
    expect(planApi.deriveResearchGap).toHaveBeenCalledWith("p-1", "gap-bbbbbbbbbbbb", {});
  });

  it("派生禁用：活动计划非 done（draft）→ 按钮禁用不调用", async () => {
    await renderPanelWithGaps(gapListView(), "draft");

    const button = screen.getByTestId("derive-from-gap") as HTMLButtonElement;
    expect(button.disabled).toBe(true);
    expect(planApi.deriveResearchGap).not.toHaveBeenCalled();
  });

  it("接受失败：错误如实呈现（不吞 409 决策不翻转）", async () => {
    await renderPanelWithGaps(gapListView());
    const user = userEvent.setup();

    planApi.acceptResearchGap.mockRejectedValue(
      new Error("缺口 gap-aaaaaaaaaaaa 已是 rejected，不能改为 accepted（决策不翻转；如需改向请重新分析覆盖）"),
    );
    await user.click(screen.getByTestId("accept-gap"));

    expect(await screen.findByText("接受缺口失败")).toBeTruthy();
    expect(screen.getByText(/决策不翻转/)).toBeTruthy();
  });
});
